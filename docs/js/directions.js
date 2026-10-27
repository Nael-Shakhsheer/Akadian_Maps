// Turn-by-turn steps for an outdoor walking route (pieces from WalkGraph.route).
// Most campus footpaths have no name, so turns are anchored to nearby buildings ("Turn left by Fenwick Library").
import { dist } from './walk.js';

const TURN_BREAK = 50;   // degrees: a bend this sharp starts a new step
const WINDOW = 8;        // metres used to measure the heading before/after a bend
const MIN_LEG = 7;       // metres: shorter wiggles fold into their neighbor
const LANDMARK_M = 45;   // how close a building must be to name it at a turn

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function walkingSteps(route, { landmarks = [], arriveAt = 'your destination', beforeArrive = [] } = {}) {
  const segs = flatten(route.pieces);
  if (!segs.length) return [];
  const legs = foldContinues(mergeJogs(mergeShort(splitLegs(segs))));
  const steps = [];
  legs.forEach((leg, i) => {
    const start = leg.segs[0].a;
    const inBearing = headingFrom(leg.segs, 0);
    let text;
    if (i === 0) {
      text = `Head <b>${COMPASS[Math.round(inBearing / 45) % 8]}</b>${leg.kind === 'c' ? `, then ${cross(leg)}` : ` ${along(leg)}`}`;
    } else {
      const prev = legs[i - 1];
      const d = signed(headingTo(prev.segs, prev.segs.length), inBearing);
      const turn = turnWord(d);
      const near = turn !== 'Continue' && leg.kind !== 'c' ? landmark(start, landmarks) : null;
      if (leg.kind === 'c') text = Math.abs(d) >= 60 ? `${turn} and ${cross(leg)}` : capital(cross(leg));
      else if (leg.kind === 't') text = turn === 'Continue' ? 'Take the <b>stairs</b>' : `${turn}, then take the <b>stairs</b>`;
      else if (turn === 'Continue') text = `Continue ${along(leg)}`;
      else if (prev.key === leg.key) text = `${turn} to stay on ${label(leg)}`;
      else text = `${turn} ${onto(leg)}${near ? ` by <b>${near}</b>` : ''}`;
    }
    // long stretches: mention what you walk past, so you know you're on track
    if (leg.meters > 120 && leg.kind !== 'c') {
      const mid = pointAlong(leg, leg.meters / 2);
      const past = landmark(mid, landmarks, 35);
      if (past && !text.includes(past)) text += `, passing <b>${past}</b>`;
    }
    steps.push({ html: text + '.', meters: leg.meters, at: [start[1], start[0]], kind: leg.kind });
  });
  const end = segs.at(-1).b;
  for (const html of beforeArrive) steps.push({ html, meters: 0, at: [end[1], end[0]], kind: 't' });
  const the = /^your /i.test(arriveAt) ? '' : 'the ';
  steps.push({ html: `Arrive at ${the}<b>${arriveAt}</b>.`, meters: 0, at: [end[1], end[0]], kind: 'arrive' });
  return steps;
}

export { fmtDist as fmtMeters } from './units.js';

// ---------- building the legs ----------
function flatten(pieces) {
  const out = [];
  for (const pc of pieces) {
    const kind = pc.edge ? pc.edge.kind : 'x'; // x = hop on/off the network
    const name = pc.edge?.name || null;
    for (let i = 1; i < pc.lonlat.length; i++) {
      const a = pc.lonlat[i - 1], b = pc.lonlat[i];
      const len = dist(a, b);
      if (len > 0.2) out.push({ a, b, len, kind, name, bearing: bearing(a, b) });
    }
  }
  return out;
}

// What a stretch "is", for deciding where one step ends: crosswalks and stairs always stand alone.
function wayKey(s) {
  if (s.kind === 'x') return null; // joins whatever it touches
  if (s.kind === 'c') return `c:${s.name || ''}`;
  if (s.kind === 't') return 't';
  return s.name ? `n:${s.name}:${s.kind === 's' ? 's' : 'r'}` : `u:${s.kind}`;
}

function splitLegs(segs) {
  const legs = [];
  let cur = null;
  segs.forEach((s, i) => {
    const key = wayKey(s);
    let fresh = !cur;
    if (cur && key && cur.key && key !== cur.key) fresh = true;
    if (cur && !fresh && cur.meters > MIN_LEG && Math.abs(signed(headingTo(segs, i), headingFrom(segs, i))) > TURN_BREAK) fresh = true;
    if (fresh) {
      cur = { key, kind: s.kind, name: s.name, segs: [], meters: 0 };
      legs.push(cur);
    }
    if (!cur.key && key) Object.assign(cur, { key, kind: s.kind, name: s.name });
    cur.segs.push(s);
    cur.meters += s.len;
  });
  return legs;
}

function mergeShort(legs) {
  const out = [];
  for (const leg of legs) {
    const prev = out.at(-1);
    const keep = leg.kind === 'c' || leg.kind === 't';
    if (prev && !keep && leg.meters < MIN_LEG) { prev.segs.push(...leg.segs); prev.meters += leg.meters; continue; }
    if (prev && !keep && prev.key === leg.key && Math.abs(signed(headingTo(prev.segs, prev.segs.length), headingFrom(leg.segs, 0))) < 25) {
      prev.segs.push(...leg.segs); prev.meters += leg.meters; continue;
    }
    out.push(leg);
  }
  // a short first leg (stepping onto the path) folds forward
  if (out.length > 1 && out[0].meters < 15 && out[0].kind !== 'c' && out[0].kind !== 't') {
    out[1].segs.unshift(...out[0].segs); out[1].meters += out[0].meters; out.shift();
  }
  return out;
}

const absorb = (into, leg, front = false) => {
  if (front) into.segs.unshift(...leg.segs); else into.segs.push(...leg.segs);
  into.meters += leg.meters;
};
const plain = (leg) => leg.kind !== 'c' && leg.kind !== 't';
const turnAt = (a, b) => signed(headingTo(a.segs, a.segs.length), headingFrom(b.segs, 0));

// Zig-zags (right 10 m, left 10 m on a stepped path) are one straight-ish walk, not two turns.
function mergeJogs(legs) {
  const out = [...legs];
  for (let i = 1; i < out.length - 1; i++) {
    const [prev, leg, next] = [out[i - 1], out[i], out[i + 1]];
    if (!plain(prev) || !plain(leg) || !plain(next) || leg.meters > 18) continue;
    const tin = turnAt(prev, leg), tout = turnAt(leg, next), net = signed(headingTo(prev.segs, prev.segs.length), headingFrom(next.segs, 0));
    if (Math.sign(tin) !== Math.sign(tout) && Math.abs(net) < 40) {
      absorb(prev, leg); absorb(prev, next);
      out.splice(i, 2);
      i--;
    }
  }
  return out;
}

// Short "keep going" bits (e.g. the few metres between two crosswalks) don't need their own step.
function foldContinues(legs) {
  const out = [];
  for (const leg of legs) {
    const prev = out.at(-1);
    if (prev && plain(leg) && leg.meters < 15 && Math.abs(turnAt(prev, leg)) < 25) { absorb(prev, leg); continue; }
    out.push(leg);
  }
  return out;
}

function pointAlong(leg, m) {
  for (const s of leg.segs) {
    if (m <= s.len) { const t = m / s.len; return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]; }
    m -= s.len;
  }
  return leg.segs.at(-1).b;
}

// ---------- wording ----------
function label(leg) {
  if (leg.kind === 's') return leg.name ? `the sidewalk along <b>${leg.name}</b>` : 'the sidewalk';
  if (leg.name) return `<b>${leg.name}</b>`;
  return { r: 'the road', v: 'the service road', p: 'the path', x: 'the path' }[leg.kind] || 'the path';
}
const along = (leg) => (leg.kind === 's' && leg.name ? `along <b>${leg.name}</b>` : `${leg.name || leg.kind === 's' ? 'along' : 'on'} ${label(leg)}`);
const onto = (leg) => `onto ${label(leg)}`;
const cross = (leg) => `cross ${leg.name ? `<b>${leg.name}</b>` : 'the street'} at the crosswalk`;
const capital = (s) => s[0].toUpperCase() + s.slice(1);

function turnWord(d) {
  const a = Math.abs(d), side = d > 0 ? 'right' : 'left';
  if (a < 25) return 'Continue';
  if (a < 60) return `Bear ${side}`;
  if (a < 150) return `Turn ${side}`;
  return 'Turn around';
}

function landmark([lon, lat], buildings, radius = LANDMARK_M) {
  let best = null;
  for (const b of buildings) {
    if (!b.name) continue;
    for (const p of b.ring) {
      const d = dist([lon, lat], p);
      if (d < radius && (!best || d < best.d)) best = { d, name: b.name };
    }
  }
  return best?.name || null;
}

// ---------- geometry ----------
function bearing([x1, y1], [x2, y2]) {
  const kx = Math.cos((y1 + y2) / 2 * Math.PI / 180);
  return (Math.atan2((x2 - x1) * kx, y2 - y1) * 180 / Math.PI + 360) % 360;
}
const signed = (b1, b2) => ((b2 - b1 + 540) % 360) - 180; // + = turning right

// heading leaving index i (over the next WINDOW metres) / arriving at index i (over the last WINDOW metres)
function headingFrom(segs, i) {
  let len = 0, j = i;
  while (j < segs.length - 1 && len + segs[j].len < WINDOW) len += segs[j++].len;
  return bearing(segs[i].a, segs[j].b);
}
function headingTo(segs, i) {
  let len = 0, j = i - 1;
  while (j > 0 && len + segs[j].len < WINDOW) len += segs[j--].len;
  return bearing(segs[Math.max(0, j)].a, segs[i - 1].b);
}
