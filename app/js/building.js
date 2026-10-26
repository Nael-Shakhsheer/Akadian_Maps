// Loads a building's indoor data and converts between plan pixels, metres and lat/lon.
// Plan coordinates are pixels on the first-floor plan ("common frame"); every floor shares them.

// grid: false skips decoding the walkable grid (~1 MB of cells) when only the routing worker needs it.
export async function loadBuilding(url, { grid = true } = {}) {
  const data = await (await fetch(url)).json();
  // metres per plan pixel, from the engine's georeference fit
  data.mPerPx = data.mPerPx || Math.hypot(data.building.transform[0], data.building.transform[3]);
  const { w, h } = data.grid;
  for (const f of data.floors) {
    if (grid) f.cells = decodeRle(f.grid, w * h);
    else f.rle = f.grid; // kept so a main-thread fallback can still decode it
    delete f.grid;
  }
  data.floorIndex = Object.fromEntries(data.floors.map((f, i) => [f.id, i]));
  data.roomByKey = new Map(data.rooms.map((r) => [`${r.floor}:${r.id}`, r]));
  return data;
}

export function decodeRle(runs, n) {
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < runs.length; i += 2) {
    out.fill(runs[i], p, p + runs[i + 1]);
    p += runs[i + 1];
  }
  return out;
}

// Plan pixel -> local metres (east, north) relative to the building origin.
export function planToEN(b, x, y) {
  const [a, bb, c, d, e, f] = b.building.transform;
  return [a * x + bb * -y + c, d * x + e * -y + f];
}

// lat/lon -> plan pixel (inverse of planToEN)
export function latLngToPlan(b, lat, lon) {
  const [a, bb, c, d, e, f] = b.building.transform;
  const { origin, mPerDegLat, mPerDegLon } = b.building;
  const east = (lon - origin.lon) * mPerDegLon - c, north = (lat - origin.lat) * mPerDegLat - f;
  const det = a * e - bb * d;
  const x = (east * e - bb * north) / det, negY = (a * north - d * east) / det;
  return [x, -negY];
}

export function planToLatLng(b, x, y) {
  const [east, north] = planToEN(b, x, y);
  const { origin, mPerDegLat, mPerDegLon } = b.building;
  return [origin.lat + north / mPerDegLat, origin.lon + east / mPerDegLon];
}

// Great-circle-ish distance in metres for short campus distances.
export function metersBetween([lat1, lon1], [lat2, lon2]) {
  const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540);
}

const KIND_LABEL = { restroom: 'Restroom', stair: 'Stairs', elevator: 'Elevator', entrance: 'Entrance' };

export function roomTitle(r) {
  if (r.kind === 'restroom') {
    const who = r.id.startsWith('WOMENS') ? "Women's" : r.id.startsWith('MENS') ? "Men's" : 'All-gender';
    return `${who} restroom`;
  }
  if (r.kind !== 'room') return KIND_LABEL[r.kind] || r.id;
  return r.name ? r.name : `Room ${r.id}`;
}

export function floorName(b, fid) {
  return b.floors[b.floorIndex[fid]].name;
}

// Short floor tag for the 3D view: G, LL (lower level), L1, L2…
export function floorShort(f) {
  return f.id === 'ground' ? 'G' : /^lower/i.test(f.name) ? 'LL' : `L${f.level}`;
}
