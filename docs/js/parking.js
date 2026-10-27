// "Where did I park?" — kept only on this device (localStorage). Nothing is sent to the server.
import { metersBetween } from './building.js';

const LEVEL_M = 3.8;

export const CAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M5 17h14v-5l-2-5H7l-2 5v5z"/><path d="M3 12h18"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/></svg>`;

export class ParkingSpot {
  constructor(campusId, campus) {
    this.key = `akadian:parked:${campusId}`;
    this.campus = campus;
  }

  get() {
    try { return JSON.parse(localStorage.getItem(this.key)) || null; } catch { return null; }
  }

  save({ lat, lon, level = null, note = '' }) {
    const where = this.lotAt(lat, lon);
    const spot = { lat, lon, level, note: note.trim(), savedAt: Date.now(), lot: where?.name || null, deck: !!where?.deck };
    try { localStorage.setItem(this.key, JSON.stringify(spot)); } catch { /* private mode: still works for this visit */ }
    this.mem = spot;
    return spot;
  }

  clear() {
    try { localStorage.removeItem(this.key); } catch {}
    this.mem = null;
  }

  current() { return this.get() || this.mem || null; }

  /** The campus lot or deck containing [lat, lon]: { name, deck, levels } or null. */
  lotAt(lat, lon) {
    const p = [lon, lat];
    for (const b of this.campus.buildings) {
      if (b.cat === 'parking' && inside(p, b.ring)) {
        return { name: b.name || 'Parking deck', deck: true, levels: Math.max(2, Math.round(b.h / LEVEL_M)), ring: b.ring };
      }
    }
    for (const a of this.campus.areas || []) {
      if (a.cat === 'parking' && inside(p, a.ring)) return { name: a.name === 'Parking' ? 'Parking lot' : a.name, deck: false, ring: a.ring };
    }
    return null;
  }
}

/**
 * Which way to draw the car: parking rows usually run along a lot's longest side.
 * Returns degrees counter-clockwise from east (0 when we don't know).
 */
export function carHeading(ring) {
  if (!ring) return 0;
  const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
  let best = 0, len = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = (ring[i][0] - ring[i - 1][0]) * kx, dy = (ring[i][1] - ring[i - 1][1]) * 110540;
    const l = Math.hypot(dx, dy);
    if (l > len) { len = l; best = (Math.atan2(dy, dx) * 180) / Math.PI; }
  }
  return best;
}

/** Short description of a saved spot: "Lot K · Level 3 · Row C". */
export function describe(spot) {
  return [spot.lot || 'Saved spot', spot.level && `Level ${spot.level}`, spot.note].filter(Boolean).join(' · ');
}

export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60 ? `${m % 60} min ` : ''}ago`;
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * Notices when you go from driving to walking inside a lot, so the app can offer to save the spot.
 * Feed it GPS fixes; it calls onParked(fix) at most once per stop.
 */
export class ParkDetector {
  constructor(parking, onParked) {
    this.parking = parking;
    this.onParked = onParked;
    this.fixes = [];
    this.prompted = -Infinity;
  }

  add({ lat, lon, speed, t = Date.now() }) {
    const prev = this.fixes.at(-1);
    // browsers often report speed as null; derive it from the last fix
    if ((speed === null || speed === undefined) && prev && t > prev.t) speed = metersBetween([prev.lat, prev.lon], [lat, lon]) / ((t - prev.t) / 1000);
    this.fixes.push({ lat, lon, speed: speed || 0, t });
    this.fixes = this.fixes.filter((f) => t - f.t < 3 * 60 * 1000);

    const drove = this.fixes.some((f) => t - f.t > 20000 && f.speed > 6);          // > ~13 mph in the last few minutes
    const recent = this.fixes.filter((f) => t - f.t <= 20000);
    const walking = recent.length >= 2 && recent.every((f) => f.speed < 2.2);     // slow for the last 20 s
    if (!drove || !walking || t - this.prompted < 10 * 60 * 1000) return;
    const lot = this.parking.lotAt(lat, lon);
    const saved = this.parking.current();
    if (!lot || (saved && metersBetween([saved.lat, saved.lon], [lat, lon]) < 40)) return;
    this.prompted = t;
    this.onParked({ lat, lon, lot });
  }
}

function inside([x, y], ring) {
  let hit = false;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) hit = !hit;
  }
  return hit;
}
