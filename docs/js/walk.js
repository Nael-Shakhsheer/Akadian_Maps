// Outdoor walking routes on the campus network published by the engine (OSM sidewalks, paths, crossings).
// Coordinates are [lon, lat] like GeoJSON; public helpers take/return [lat, lon] like the rest of the app.

const KX = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
const KY = 110540;

export class WalkGraph {
  constructor(walk) {
    this.nodes = walk.nodes;
    this.edges = walk.edges.map(([a, b, m, cost, flags, mid, nameIdx = -1, kind = 'p']) => {
      const pts = [walk.nodes[a]];
      for (let i = 0; i < mid.length; i += 2) pts.push([mid[i], mid[i + 1]]);
      pts.push(walk.nodes[b]);
      return { a, b, m, cost: cost / 10, steps: !!(flags & 1), pts, name: nameIdx >= 0 ? walk.names[nameIdx] : null, kind };
    });
    this.adj = walk.nodes.map(() => []);
    this.edges.forEach((e, i) => { this.adj[e.a].push(i); this.adj[e.b].push(i); });
    this.lat0 = walk.nodes.length ? walk.nodes[0][1] : 0;
  }

  // Closest point on the network to [lat, lon]: which edge, where along it, and how far away.
  // Remembered for the last few points: one GPS update snaps you once instead of once per entrance.
  snap(ll, { stepFree = false } = {}) {
    const key = `${ll[0].toFixed(7)},${ll[1].toFixed(7)},${stepFree}`;
    this.snaps ||= new Map();
    if (this.snaps.has(key)) return this.snaps.get(key);
    const s = this.snapNow(ll, stepFree);
    this.snaps.set(key, s);
    if (this.snaps.size > 40) this.snaps.delete(this.snaps.keys().next().value);
    return s;
  }

  snapNow([lat, lon], stepFree) {
    const kx = KX(this.lat0);
    let best = null;
    this.edges.forEach((e, ei) => {
      if (stepFree && e.steps) return;
      let along = 0;
      for (let i = 1; i < e.pts.length; i++) {
        const [x1, y1] = e.pts[i - 1], [x2, y2] = e.pts[i];
        const ax = (x1 - lon) * kx, ay = (y1 - lat) * KY, bx = (x2 - lon) * kx, by = (y2 - lat) * KY;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(px, py), segLen = Math.sqrt(L2);
        if (!best || d < best.d) best = { d, ei, i, t, along: along + t * segLen, point: [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] };
        along += segLen;
      }
    });
    if (best) {
      const e = this.edges[best.ei];
      best.total = e.pts.slice(1).reduce((s, p, k) => s + dist(e.pts[k], p), 0) || 1;
    }
    return best;
  }

  /**
   * Walking route between two [lat, lon] points.
   * Returns { coords: [[lat, lon], ...], meters, pieces } or null.
   * pieces: the route as consecutive stretches, each { edge (or null for the short hop on/off the network), lonlat: [...] }
   */
  route(from, to, { stepFree = false } = {}) {
    const s = this.snap(from, { stepFree }), g = this.snap(to, { stepFree });
    if (!s || !g) return null;
    const A = [from[1], from[0]], B = [to[1], to[0]];
    if (s.ei === g.ei) { // same street segment: walk straight along it
      const e = this.edges[s.ei];
      return finish([
        { edge: null, lonlat: [A, s.point] },
        { edge: e, lonlat: [s.point, ...partial(e.pts, s, g), g.point] },
        { edge: null, lonlat: [g.point, B] },
      ]);
    }
    // Dijkstra from the start edge's two ends (seeded with the partial distance) to the goal edge's two ends
    const N = this.nodes.length;
    const distArr = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const prevEdge = new Int32Array(N).fill(-1);
    const se = this.edges[s.ei], ge = this.edges[g.ei];
    const frac = (snap) => snap.along / snap.total;
    const heap = new MinHeap();
    const seed = (n, d) => { if (d < distArr[n]) { distArr[n] = d; heap.push(n, d); } };
    seed(se.a, se.m * frac(s) * se.cost);
    seed(se.b, se.m * (1 - frac(s)) * se.cost);
    const goalCost = { [ge.a]: ge.m * frac(g) * ge.cost, [ge.b]: ge.m * (1 - frac(g)) * ge.cost };
    let bestEnd = -1, bestTotal = Infinity;
    while (heap.size) {
      const [n, d] = heap.pop();
      if (d > distArr[n]) continue;
      if (d >= bestTotal) break;
      if (n in goalCost && d + goalCost[n] < bestTotal) { bestTotal = d + goalCost[n]; bestEnd = n; }
      for (const ei of this.adj[n]) {
        const e = this.edges[ei];
        if (stepFree && e.steps) continue;
        const o = e.a === n ? e.b : e.a;
        const nd = d + e.m * e.cost;
        if (nd < distArr[o]) { distArr[o] = nd; prev[o] = n; prevEdge[o] = ei; heap.push(o, nd); }
      }
    }
    if (bestEnd < 0) return null;
    // walk back from the goal end to whichever start end we left from
    const chain = [];
    let n = bestEnd;
    while (prev[n] !== -1) { chain.push([prevEdge[n], n]); n = prev[n]; }
    chain.reverse();
    const startNode = n;
    const pieces = [
      { edge: null, lonlat: [A, s.point] },
      { edge: se, lonlat: [s.point, ...partialToNode(se, s, startNode)] },
    ];
    for (const [ei, to_] of chain) {
      const e = this.edges[ei];
      pieces.push({ edge: e, lonlat: e.b === to_ ? e.pts : [...e.pts].reverse() });
    }
    pieces.push({ edge: ge, lonlat: [...partialToNode(ge, g, bestEnd).reverse(), g.point] });
    pieces.push({ edge: null, lonlat: [g.point, B] });
    return finish(pieces);
  }
}

export function dist([x1, y1], [x2, y2]) {
  return Math.hypot((x2 - x1) * KX((y1 + y2) / 2), (y2 - y1) * KY);
}

// points of edge e between the snap and one of its end nodes (exclusive of the snap point)
function partialToNode(e, snap, node) {
  return node === e.b ? e.pts.slice(snap.i) : e.pts.slice(0, snap.i).reverse();
}

function partial(pts, s, g) {
  if (s.i === g.i) return [];
  return s.i < g.i ? pts.slice(s.i, g.i) : pts.slice(g.i, s.i).reverse();
}

function finish(pieces) {
  const out = [];
  for (const pc of pieces) {
    const clean = [];
    for (const p of pc.lonlat) if (!clean.length || dist(clean.at(-1), p) > 0.3) clean.push(p);
    pc.lonlat = clean;
    for (const p of clean) if (!out.length || dist(out.at(-1), p) > 0.3) out.push(p);
  }
  let meters = 0;
  for (let i = 1; i < out.length; i++) meters += dist(out[i - 1], out[i]);
  return { coords: out.map(([lon, lat]) => [lat, lon]), meters, pieces: pieces.filter((pc) => pc.lonlat.length > 1) };
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(id, k) {
    const a = this.a; a.push([id, k]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][1] <= k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && a[c + 1][1] < a[c][1]) c++;
        if (a[c][1] >= a[i][1]) break;
        [a[c], a[i]] = [a[i], a[c]]; i = c;
      }
    }
    return top;
  }
}
