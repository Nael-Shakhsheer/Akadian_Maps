// Parking auto-prompt: fires once after driving into a lot, never for walking in.  Run: node tests/test_parking.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; }, removeItem(k) { delete this.s[k]; } };
const root = new URL('..', import.meta.url);
const { ParkingSpot, ParkDetector, describe } = await import(new URL('app/js/parking.js', root));
const campus = JSON.parse(readFileSync(new URL('engine_data/published/campus/gmu.json', root), 'utf8'));

const deck = campus.buildings.find((b) => b.cat === 'parking');
const n = deck.ring.length - 1;
const c = [deck.ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n, deck.ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n];
const parking = new ParkingSpot('test', campus);
assert.equal(parking.lotAt(...c).deck, true);

// drive in (speed not reported, as on many phones), then walk around inside
const prompts = [];
const det = new ParkDetector(parking, (e) => prompts.push(e.lot.name));
let t = 0;
for (let i = 0; i < 12; i++) det.add({ lat: c[0] - 0.006 + i * 0.0005, lon: c[1], speed: null, t: (t += 5000) });
for (let i = 0; i < 8; i++) det.add({ lat: c[0] + i * 0.00002, lon: c[1], speed: null, t: (t += 5000) });
assert.deepEqual(prompts, [deck.name]);
for (let i = 0; i < 20; i++) det.add({ lat: c[0] + 0.001 + i * 0.00003, lon: c[1], speed: 1.3, t: (t += 5000) });
assert.equal(prompts.length, 1, 'no second prompt while walking away');

// walking into a lot never prompts
const quiet = new ParkDetector(parking, () => assert.fail('prompted without driving'));
let t2 = 0;
for (let i = 0; i < 20; i++) quiet.add({ lat: c[0] - 0.0005 + i * 0.00004, lon: c[1], speed: 1.4, t: (t2 += 5000) });

// save / read back / clear stays on the device
const spot = parking.save({ lat: c[0], lon: c[1], level: '3', note: 'Row C' });
assert.equal(describe(spot), `${deck.name} · Level 3 · Row C`);
assert.equal(parking.current().level, '3');
parking.clear();
assert.equal(parking.current(), null);
console.log('parking: OK');
