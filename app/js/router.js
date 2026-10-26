// A* over the stacked floor grids. Cells: 0 blocked, 1 corridor, 2 inside a room (allowed, but costs more).
// Floors are joined only at stairs and elevators (data.links).


const ROOM_COST = 4;          // walking through rooms instead of corridors is discouraged
const STAIR_COST = 45;        // per floor, in cell units (~10 m of walking)
const ELEVATOR_COST = 70;     // waiting + riding
// 8 neighbours: straight moves first (k < 4), then diagonals
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export class Router {
  constructor(b) {
    this.b = b;
    const { w, h } = b.grid;
    this.w = w; this.h = h; this.per = w * h;
    this.n = this.per * b.floors.length;
    this.cells = new Uint8Array(this.n);
    b.floors.forEach((f, i) => this.cells.set(f.cells, i * this.per));
    this.g = new Float64Array(this.n);
    this.from = new Int32Array(this.n);
    this.seen = new Uint32Array(this.n); // generation stamps so we don't clear arrays per search
    this.closed = new Uint32Array(this.n);
    this.gen = 0;
    this.links = [];
    for (const l of b.links) {
      const ra = b.roomByKey.get(`${l.a[0]}:${l.a[1]}`);
      const rb = b.roomByKey.get(`${l.b[0]}:${l.b[1]}`);
      if (!ra || !rb) continue;
      this.links.push({ kind: l.kind, a: this.snap(ra.floor, ra.label), b: this.snap(rb.floor, rb.label), ra, rb });
    }
    this.linkAt = new Map();
    this.hasLink = new Uint8Array(this.n);
    for (const l of this.links) {
      push(this.linkAt, l.a, [l.b, l]);
      push(this.linkAt, l.b, [l.a, l]);
      this.hasLink[l.a] = this.hasLink[l.b] = 1;
    }
  }

  // Nearest open cell to a plan point on a floor.
  snap(fid, [x, y]) {
    const fi = this.b.floorIndex[fid];
    const cx = Math.round((x - this.b.grid.x0) / this.b.grid.cell - 0.5);
    const cy = Math.round((y - this.b.grid.y0) / this.b.grid.cell - 0.5);
    for (let r = 0; r < 40; r++) {
      let best = -1, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
        const i = fi * this.per + Y * this.w + X;
        if (this.cells[i] && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = i; }
      }
      if (best >= 0) return best;
    }
    return fi * this.per + cy * this.w + cx;
  }

  cellToPlan(i) {
    const f = Math.floor(i / this.per), r = i % this.per;
    const { x0, y0, cell } = this.b.grid;
    return { floor: this.b.floors[f].id, x: x0 + ((r % this.w) + 0.5) * cell, y: y0 + (Math.floor(r / this.w) + 0.5) * cell };
  }

  route(start, goal, { stepFree = false } = {}) {
    const { w, per } = this;
    const gx = goal % per % w, gy = Math.floor(goal % per / w), gf = Math.floor(goal / per);
    const heur = (i) => {
      const r = i % per, dx = r % w - gx, dy = ((r / w) | 0) - gy; // (Math.hypot is slow in hot loops)
      return Math.sqrt(dx * dx + dy * dy) + Math.abs(((i / per) | 0) - gf) * STAIR_COST * 0.9;
    };
    const gen = this.search(start, heur, (cur) => cur === goal, stepFree);
    if (this.seen[goal] !== gen) return null;
    const cellsPath = [];
    for (let i = goal; i !== -1; i = this.from[i]) cellsPath.push(i);
    cellsPath.reverse();
    return this.toLegs(cellsPath);
  }

  /**
   * Routes from every start to one goal in a single search: it grows outward from the goal until every
   * start is reached. (Path costs are symmetric apart from the first/last cell, which doesn't matter here.)
   * Returns an array of legs (or null) per start.
   */
  routeMany(starts, goal, { stepFree = false } = {}) {
    const want = new Set(starts);
    const gen = this.search(goal, () => 0, (cur) => want.delete(cur) && want.size === 0, stepFree);
    return starts.map((s) => {
      if (this.seen[s] !== gen) return null;
      const cellsPath = [];
      for (let i = s; i !== -1; i = this.from[i]) cellsPath.push(i); // from[] already points toward the goal
      return this.toLegs(cellsPath);
    });
  }

  // Best-first search over the stacked grids (A* with a heuristic, Dijkstra with heur = 0).
  search(source, heur, done, stepFree) {
    const { w, h, per, cells, g, from, seen, closed, hasLink } = this;
    const gen = ++this.gen;
    const heap = new Heap();
    g[source] = 0; from[source] = -1; seen[source] = gen;
    heap.push(source, heur(source));
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue; // a stale queue entry: this cell was already finished
      closed[cur] = gen;
      if (done(cur)) break;
      const gc = g[cur];
      const r = cur % per, x = r % w, y = (r - x) / w, base = cur - r;
      for (let k = 0; k < 8; k++) {
        const X = x + DX[k], Y = y + DY[k];
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const ni = base + Y * w + X;
        const c = cells[ni];
        if (!c || closed[ni] === gen) continue;
        if (k >= 4 && (!cells[base + y * w + X] || !cells[base + Y * w + x])) continue; // no corner cutting
        const ng = gc + DL[k] * (c === 2 ? ROOM_COST : 1);
        if (seen[ni] !== gen || ng < g[ni]) {
          seen[ni] = gen; g[ni] = ng; from[ni] = cur;
          heap.push(ni, ng + heur(ni));
        }
      }
      const ls = hasLink[cur] ? this.linkAt.get(cur) : null; // only ~70 cells are stairs/elevators
      if (ls) for (const [ni, l] of ls) {
        if (stepFree && l.kind === 'stair') continue;
        const floors = Math.abs(Math.floor(ni / per) - Math.floor(cur / per));
        const ng = gc + floors * (l.kind === 'stair' ? STAIR_COST : ELEVATOR_COST);
        if (seen[ni] !== gen || ng < g[ni]) {
          seen[ni] = gen; g[ni] = ng; from[ni] = cur;
          heap.push(ni, ng + heur(ni));
        }
      }
    }
    return gen;
  }

  // Split a cell path into per-floor polylines joined by vertical transitions.
  toLegs(path) {
    const legs = [];
    let cur = null;
    for (let k = 0; k < path.length; k++) {
      const p = this.cellToPlan(path[k]);
      if (!cur || cur.floor !== p.floor) {
        if (cur) {
          const link = (this.linkAt.get(path[k - 1]) || []).find(([ni]) => ni === path[k])?.[1];
          legs.push({ transition: true, kind: link?.kind || 'stair', from: cur.floor, to: p.floor, at: cur.pts.at(-1) });
        }
        cur = { floor: p.floor, pts: [] };
        legs.push(cur);
      }
      cur.pts.push([p.x, p.y]);
    }
    for (const l of legs) if (l.pts) {
      l.pts = simplify(l.pts, 4);
      l.meters = polyLen(l.pts) * this.b.mPerPx;
    }
    return legs;
  }
}

function push(map, k, v) { (map.get(k) || map.set(k, []).get(k)).push(v); }

export function polyLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

// Douglas–Peucker
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

class Heap {
  constructor() { this.ids = []; this.ks = []; }
  get size() { return this.ids.length; }
  push(id, k) {
    const { ids, ks } = this;
    let i = ids.length; ids.push(id); ks.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ids[i] = ids[p]; ks[i] = ks[p]; i = p;
    }
    ids[i] = id; ks[i] = k;
  }
  pop() {
    const { ids, ks } = this;
    const top = ids[0], lid = ids.pop(), lk = ks.pop();
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && ks[c + 1] < ks[c]) c++;
        if (ks[c] >= lk) break;
        ids[i] = ids[c]; ks[i] = ks[c]; i = c;
      }
      ids[i] = lid; ks[i] = lk;
    }
    return top;
  }
}
