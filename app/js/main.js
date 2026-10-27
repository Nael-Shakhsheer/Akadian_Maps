// App flow: pick a room or place -> GPS walks you there on the 3D campus -> 3D indoor route from the entrance.
// GPS is only used outdoors; indoors the route starts from the entrance, so no indoor positioning is needed.
import { loadBuilding, latLngToPlan, metersBetween, roomTitle, floorName } from './building.js';
import { simplify } from './router.js';
import { IndoorRouting } from './routing.js';
import { OutdoorMap, nearestOnRing, CATEGORIES } from './outdoor.js';
import { WalkGraph } from './walk.js';
import { walkingSteps } from './directions.js';
import { ParkingSpot, ParkDetector, describe, ago, carHeading, CAR_SVG } from './parking.js';
import { fmtDist, fmtHeight, walkMins } from './units.js';

const $ = (s) => document.querySelector(s);
const ARRIVE_RADIUS = 20;     // m from the entrance counts as "arrived"
const FAR_FROM_CAMPUS = 3000; // m; beyond this we assume a demo and let you tap the map
const DATA = window.AKADIAN_DATA || '/api/public'; // published maps, served read-only by the engine
const params = new URLSearchParams(location.search);
const CAMPUS = params.get('campus') || 'gmu';
const BROWSE = [['🍴', 'Food & coffee', 'food'], ['🚌', 'Bus & shuttle', 'bus'], ['🚻', 'Restrooms', 'restroom'],
  ['📚', 'Study rooms', 'study'], ['💻', 'Computer labs', 'computer lab'], ['🏛', 'Buildings', 'building']];

// ---------- loading ----------
function bootError(msg) {
  $('#bootMsg').textContent = msg;
  $('#bootRetry').classList.remove('hidden');
  $('#bootRetry').onclick = () => location.reload();
}
// Every building with an indoor map: { bld: its campus outline, b: indoor data, name, routing + view (made on first use) }
let campus, indoors;
try {
  campus = await fetch(`${DATA}/campus/${CAMPUS}.json`).then((r) => {
    if (r.status === 404) throw new Error('This campus map hasn’t been published yet.');
    if (!r.ok) throw new Error('The map server isn’t responding. Check your connection and try again.');
    return r.json();
  });
  const shells = campus.buildings.filter((x) => x.indoor);
  // the routing worker keeps the grid; a building that fails to load just isn't offered indoors
  const loaded = await Promise.allSettled(shells.map((x) => loadBuilding(`${DATA}/${x.indoor}`, { grid: false })));
  indoors = shells.map((bld, i) => loaded[i].value && { bld, b: loaded[i].value, name: loaded[i].value.building.name || bld.name })
    .filter(Boolean).sort((x, y) => y.b.rooms.length - x.b.rooms.length); // biggest first: it answers ?to= links without a building
  if (shells.length && !indoors.length) throw new Error('The indoor maps couldn’t be loaded. Check your connection and try again.');
} catch (e) {
  bootError(e.message.includes('fetch') ? 'Can’t reach the map server. Check your connection and try again.' : e.message);
  throw e;
}
const main = indoors[0]; // the main indoor building: links without a building, demo start point
const ibByBld = new Map(indoors.map((ib) => [ib.bld.id, ib]));
const ibOf = new Map(indoors.flatMap((ib) => ib.b.rooms.map((r) => [r, ib]))); // room -> its building
const routingFor = (ib) => (ib.routing ||= new IndoorRouting(`${DATA}/${ib.bld.indoor}`, ib.b));
const roomSub = (room, ib) => `${room.kind === 'room' ? `Room ${room.id} · ` : ''}${floorName(ib.b, room.floor)} · ${ib.name}`;
const CAMPUS_SHORT = campus.name.split(' – ')[0];
$('#campusName').textContent = CAMPUS_SHORT;
$('#homeEyebrow').textContent = campus.name;
$('#exploreTitle').firstChild.textContent = CAMPUS_SHORT;

const walk = campus.walk ? new WalkGraph(campus.walk) : null;
let indoor = null; // the IndoorView on screen (one per building, made on first visit)

// The 3D views (and the 1.2 MB 3D library) load only when first needed, then stay warm.
const views = {};
const loadIndoorView = () => (views.indoor ||= import('./indoor3d.js'));
const loadShellView = () => (views.shell ||= import('./shell3d.js'));

// Outdoor walking route on the campus network; straight line if there's no network data.
function walkRoute(from, to) {
  const r = walk?.route(from, to, { stepFree: $('#stepFree').checked });
  return r || { coords: [from, to], meters: metersBetween(from, to) * 1.3, straight: true };
}

// dest: room | building | point (bus stop, food outside mapped buildings, your car)
const state = { dest: null, ib: null, place: null, user: null, demo: false, choice: null, perEntrance: [], arrivedOnce: false, mode: 'nav', url: '' };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------- screens + browser history (so the phone's back gesture works) ----------
let screen = 'search';
let depth = 0;
function show(id, { push = true, url } = {}) {
  const target = url ?? state.url ?? location.search;
  if (push && id !== screen) { history.pushState({ screen: id, depth: ++depth }, '', target || location.pathname); }
  else if (push && url !== undefined) history.replaceState({ screen: id, depth }, '', target || location.pathname);
  screen = id;
  for (const s of ['search', 'outdoor', 'indoor', 'building']) $('#' + s).classList.toggle('hidden', s !== id);
  if (id === 'outdoor') setTimeout(() => outdoor.resize(), 0);
  if (id === 'search') { renderHome(); }
}
history.replaceState({ screen: 'search', depth: 0 }, '', location.search || location.pathname);
window.addEventListener('popstate', (e) => {
  depth = e.state?.depth || 0;
  show(e.state?.screen || 'search', { push: false });
});
function back(target) {
  if (depth > 0) history.back();
  else show(target, { url: target === 'search' ? location.pathname : undefined });
}
document.querySelectorAll('[data-back]').forEach((el) => (el.onclick = () => back(el.dataset.back)));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || screen === 'search') return;
  const btn = $(`#${screen} .sheet > .back, #${screen} .sheet :not(.hidden) > .back`);
  btn?.click();
});

// The outdoor screen navigates somewhere, browses the map, or saves where you parked.
function sheetMode(mode) {
  state.mode = mode;
  $('#navSheet').classList.toggle('hidden', mode !== 'nav');
  $('#exploreSheet').classList.toggle('hidden', mode !== 'explore');
  $('#parkSheet').classList.toggle('hidden', mode !== 'park');
  carFab.classList.toggle('hidden', mode === 'park');
}

// Step-free is an accessibility need, not a one-off: remember it on this device.
try { $('#stepFree').checked = localStorage.getItem('akadian:step-free') === '1'; } catch {}
$('#stepFree').onchange = async () => {
  try { localStorage.setItem('akadian:step-free', $('#stepFree').checked ? '1' : '0'); } catch {}
  toast($('#stepFree').checked ? 'Step-free: routes avoid stairs' : 'Step-free off');
  if (!state.dest) return;
  if (state.dest.type === 'room') await computeIndoor();
  pickTarget(true);
  if (state.dest.type === 'room' && screen === 'indoor') goIndoor();
};

// ---------- search ----------
const lineNames = (s) => s.lines.map((r) => campus.transit.lines[r]?.name || r).join(' · ');
const searchable = [
  ...indoors.flatMap((ib) => ib.b.rooms
    .filter((r) => (r.kind === 'room' || r.kind === 'restroom') && !r.restricted)
    .map((r) => ({ type: 'room', r, ib, title: roomTitle(r), hay: `${r.id} ${roomTitle(r)} ${r.kind === 'restroom' ? 'bathroom restroom toilet wc' : ''} ${ib.name}`.toLowerCase() })))
    .sort((a, c) => (!!c.r.name - !!a.r.name) || (indoors.indexOf(a.ib) - indoors.indexOf(c.ib)) || a.r.id.localeCompare(c.r.id, undefined, { numeric: true })),
  ...campus.buildings
    .filter((x) => x.name)
    .sort((a, c) => a.name.localeCompare(c.name))
    .map((x) => ({ type: 'building', bld: x, title: x.name, hay: `${x.name} building ${x.cat === 'dorm' ? 'residence hall dorm housing' : x.cat}`.toLowerCase() })),
  ...(campus.transit?.stops || [])
    .map((s) => ({ type: 'stop', stop: s, title: s.name,
      hay: `${s.name} ${s.lines.join(' ')} ${lineNames(s)} ${s.networks.join(' ')} bus stop ${s.shuttle ? 'shuttle mason shuttles' : ''}`.toLowerCase() }))
    .sort((a, c) => (c.stop.shuttle - a.stop.shuttle) || (c.stop.lines.length - a.stop.lines.length)),
  ...(campus.food || []).map((f) => ({ type: 'food', food: f, title: f.name,
    hay: `${f.name} ${f.kind} ${f.cuisine} ${f.building || ''} food eat dining lunch dinner ${/café|coffee/i.test(f.kind + f.cuisine) ? 'coffee cafe' : ''}`.toLowerCase() })),
];

// Best matches first: exact room number, then names that start with what you typed, then anything that contains it.
function score(s, q, words) {
  const t = s.title.toLowerCase();
  const id = s.type === 'room' ? s.r.id.toLowerCase() : null;
  if (id === q || t === q) return 0;
  if (id?.startsWith(q)) return 1;
  if (t.startsWith(q)) return 2;
  if (t.split(/[^a-z0-9']+/).some((w) => w.startsWith(q))) return 3;
  if (words.every((w) => s.hay.includes(w))) return 4;
  return -1;
}

// Typos: "chipolte", "fenwik", "dewbery". Each query word may be 1 edit off (2 for long words).
function typoScore(s, words) {
  const hayWords = s.hay.split(/[^a-z0-9']+/);
  return words.every((w) => w.length < 4 ? s.hay.includes(w)
    : hayWords.some((h) => Math.abs(h.length - w.length) <= 2 && editDistance(w, h, w.length >= 7 ? 2 : 1) <= (w.length >= 7 ? 2 : 1))) ? 5 : -1;
}

function editDistance(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1; // already too different
    prev = cur;
  }
  return prev[b.length];
}

let topResult = null;
function renderResults(q) {
  q = q.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let list = q
    ? searchable.map((s) => ({ s, k: score(s, q, words) })).filter((x) => x.k >= 0).sort((a, c) => a.k - c.k).map((x) => x.s)
    : []; // nothing typed: home shows your saved places instead
  let fuzzy = false;
  if (q && !list.length && q.length >= 4) { list = searchable.filter((s) => typoScore(s, words) >= 0); fuzzy = true; } // "did you mean"
  $('#listTitle').textContent = q ? (list.length ? `${fuzzy ? 'Closest matches for' : 'Results for'} “${q}”` : '') : '';
  $('#saved').classList.toggle('hidden', !!q);
  $('#recent').classList.toggle('hidden', !!q);
  $('#results').innerHTML = '';
  topResult = null;
  for (const s of list.slice(0, 40)) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    let go;
    if (s.type === 'room') {
      li.innerHTML = `<span class="badge">${s.r.kind === 'restroom' ? 'WC' : s.r.id}</span>
        <div><div>${s.title}</div><div class="meta">${s.ib.name} · ${floorName(s.ib.b, s.r.floor)}</div></div>`;
      go = () => chooseRoom(s.r);
    } else if (s.type === 'food') {
      li.innerHTML = `<span class="badge food">FOOD</span>
        <div><div>${s.title}</div><div class="meta">${[s.food.kind, s.food.building].filter(Boolean).join(' · ')}</div></div>`;
      go = () => chooseFood(s.food);
    } else if (s.type === 'stop') {
      li.innerHTML = `<span class="badge stop">${s.stop.shuttle ? 'SHUTTLE' : 'BUS'}</span>
        <div><div>${s.title}</div><div class="meta">${lineNames(s.stop) || s.stop.networks.join(' · ')}</div></div>`;
      go = () => chooseStop(s.stop);
    } else {
      li.innerHTML = `<span class="badge bld">${s.bld.indoor ? '3D' : 'BLDG'}</span>
        <div><div>${s.title}</div><div class="meta">${s.bld.indoor ? 'Building · indoor map available' : 'Building'}</div></div>`;
      go = () => chooseBuilding(s.bld);
    }
    li.onclick = go;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    topResult ||= go;
    $('#results').append(li);
  }
  if (q && !list.length) {
    $('#results').innerHTML = `<li class="empty">Nothing matches “${q}”. Try a room number like <b>344</b>, a building, or a category below.</li>`;
  }
}
$('#q').addEventListener('input', (e) => renderResults(e.target.value));
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && topResult) { e.preventDefault(); topResult(); } });

for (const [icon, label, q] of BROWSE) {
  const c = document.createElement('button');
  c.className = 'chip browse';
  c.innerHTML = `<span aria-hidden="true">${icon}</span> ${label}`;
  c.onclick = () => { $('#q').value = q; renderResults(q); $('#q').focus(); };
  $('#browse').append(c);
}
function searchFor(q) {
  $('#q').value = q;
  show('search', { url: location.pathname });
  renderResults(q);
}
document.querySelectorAll('#exploreSheet [data-q]').forEach((el) => (el.onclick = () => searchFor(el.dataset.q)));
$('#openExplore').onclick = () => openExplore();

// ---------- recent places (this device only) ----------
const RECENT_KEY = `akadian:recent:${CAMPUS}`;
function recents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function remember(kind, key, title, sub) {
  setPlace({ kind, key, title, sub });
  const list = recents().filter((r) => !(r.kind === kind && r.key === key));
  list.unshift({ kind, key, title, sub });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch {}
}
function openRecent(r) {
  if (r.kind === 'room') { const x = findRoom(...r.key.split('|').reverse()); if (x) return chooseRoom(x); }
  if (r.kind === 'building') { const x = campus.buildings.find((y) => y.id === r.key); if (x) return chooseBuilding(x); }
  if (r.kind === 'stop') { const x = campus.transit?.stops.find((y) => y.name === r.key); if (x) return chooseStop(x); }
  if (r.kind === 'food') { const x = campus.food?.find((y) => `${y.name}@${y.lat}` === r.key); if (x) return chooseFood(x); }
  toast('That place isn’t on the map anymore.');
}
// A room by id, in one building (its id, e.g. gmu-research) or the first building that has it.
function findRoom(id, inBld) {
  for (const ib of indoors) {
    if (inBld && ib.b.building.id !== inBld) continue;
    const r = ib.b.rooms.find((x) => x.id.toLowerCase() === id.toLowerCase() && x.kind === 'room' && !x.restricted);
    if (r) return r;
  }
  return null;
}
const roomKey = (room, ib) => (ib === main ? room.id : `${ib.b.building.id}|${room.id}`);
const roomUrl = (room, ib) => `?to=${encodeURIComponent(room.id)}${ib === main ? '' : `&in=${ib.b.building.id}`}`;

// ---------- saved places: up to 5 favourites for one-tap directions (this device only) ----------
const SAVED_KEY = `akadian:saved:${CAMPUS}`;
const SAVED_MAX = 5;
const KIND_ICON = { room: '📍', building: '🏛', stop: '🚌', food: '🍴' };
function savedPlaces() { try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; } }
function storeSaved(list) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); return true; } catch { return false; } }
const sameP = (a, c) => a && c && a.kind === c.kind && a.key === c.key;

// The place on screen (what "Save place" saves); null for things you can't save, like your car.
function setPlace(p) {
  state.place = p;
  for (const id of ['#saveOut', '#saveIn']) {
    const btn = $(id), on = savedPlaces().some((s) => sameP(s, p));
    btn.classList.toggle('hidden', !p);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★ Saved' : '☆ Save place';
    btn.setAttribute('aria-pressed', on);
  }
}
function toggleSaved() {
  const p = state.place;
  if (!p) return;
  let list = savedPlaces();
  if (list.some((s) => sameP(s, p))) {
    list = list.filter((s) => !sameP(s, p));
    toast('Removed from saved places');
  } else if (list.length >= SAVED_MAX) {
    return toast(`You can save ${SAVED_MAX} places. Remove one on the home screen first.`);
  } else {
    list.push(p);
    toast(`Saved: ${p.title}`);
  }
  if (!storeSaved(list)) toast('Couldn’t save on this device (private browsing?)');
  setPlace(p);
}
$('#saveOut').onclick = toggleSaved;
$('#saveIn').onclick = toggleSaved;

function renderSaved() {
  const list = savedPlaces();
  const slots = Array.from({ length: SAVED_MAX }, (_, i) => list[i]);
  const firstEmpty = list.length;
  $('#saved').innerHTML = `<h2 class="list-title">Saved places <span class="count">${list.length}/${SAVED_MAX}</span></h2>
    <ol class="saved-list">${slots.map((p, i) => p
    ? `<li class="saved"><button class="go" data-i="${i}"><span class="ico" aria-hidden="true">${KIND_ICON[p.kind] || '📍'}</span>
        <span class="txt">${p.title}<small>${p.sub || ''}</small></span><span class="arrow" aria-hidden="true">→</span></button>
        <button class="rm" data-rm="${i}" aria-label="Remove ${p.title} from saved places" title="Remove">✕</button></li>`
    : `<li class="saved empty"><span class="ico" aria-hidden="true">☆</span><span class="txt">Empty slot${i === firstEmpty
      ? '<small>Pick a place, then tap ☆ Save place</small>' : ''}</span></li>`).join('')}</ol>`;
  $('#saved').querySelectorAll('[data-i]').forEach((el) => (el.onclick = () => openRecent(list[el.dataset.i])));
  $('#saved').querySelectorAll('[data-rm]').forEach((el) => (el.onclick = () => {
    storeSaved(list.filter((_, i) => i !== Number(el.dataset.rm)));
    renderSaved();
  }));
}

function renderHome() {
  renderCarCard();
  renderSaved();
  const list = recents();
  $('#recent').innerHTML = list.length ? `<h2 class="list-title">Recent</h2><div class="recent-row">${list.map((r, i) =>
    `<button class="recent" data-i="${i}"><span>${r.title}</span><small>${r.sub || ''}</small></button>`).join('')}</div>` : '';
  $('#recent').querySelectorAll('[data-i]').forEach((el) => (el.onclick = () => openRecent(list[el.dataset.i])));
  renderResults($('#q').value);
}

// ---------- choosing a destination ----------
function setHeader(html) { $('#destOut').innerHTML = html; $('#destIn').innerHTML = html; }

function chooseRoom(room, { record = true } = {}) {
  const ib = ibOf.get(room);
  state.dest = { type: 'room', room, title: roomTitle(room) };
  state.ib = ib;
  state.arrivedOnce = false;
  state.url = roomUrl(room, ib);
  setHeader(`${state.dest.title}<small>${roomSub(room, ib)}</small>`);
  if (record) remember('room', roomKey(room, ib), state.dest.title, roomSub(room, ib));
  state.perEntrance = [];
  goOutdoor(ib.bld);
  loadIndoorView(); // you'll likely go inside: start fetching the 3D view now
  computeIndoor().then(() => pickTarget());
}

function chooseBuilding(bld) {
  state.dest = { type: 'building', bld, title: bld.name || 'Building' };
  state.ib = ibByBld.get(bld.id) || null;
  state.arrivedOnce = false;
  state.perEntrance = [];
  state.url = `?b=${bld.id}`;
  setHeader(`${state.dest.title}<small>${bld.indoor ? 'Indoor 3D map available' : CAMPUS_SHORT}</small>`);
  remember('building', bld.id, state.dest.title, 'Building');
  goOutdoor(bld);
}

// Somewhere you just walk to (a bus stop, a food spot outside mapped buildings, your car).
function choosePoint({ title, sub, lat, lon, info, url, arrive, beforeArrive, share = true }) {
  state.dest = { type: 'point', title, lat, lon, info, arrive, beforeArrive, share };
  state.arrivedOnce = false;
  state.perEntrance = [];
  state.url = url;
  setHeader(`${title}<small>${sub}</small>`);
  goOutdoor(null);
}

function chooseStop(stop) {
  remember('stop', stop.name, stop.name, lineNames(stop) || 'Bus stop');
  choosePoint({ title: stop.name, sub: lineNames(stop) || stop.networks.join(' · '), lat: stop.lat, lon: stop.lon,
    info: [stop.shuttle && 'Mason Shuttles', lineNames(stop), stop.shelter && 'sheltered'].filter(Boolean).join(' · '),
    url: `?stop=${campus.transit.stops.indexOf(stop)}` });
}

function chooseFood(f) {
  remember('food', `${f.name}@${f.lat}`, f.name, [f.kind, f.building].filter(Boolean).join(' · '));
  const url = `?food=${campus.food.indexOf(f)}`;
  const ib = ibByBld.get(f.building_id);
  // Its floor: as recorded, or (unknown) the main floor, but only guessed when every floor of the building is mapped.
  const floor = ib && (f.level != null ? ib.b.floors.find((x) => x.level === f.level)
    : ib.b.floors.length >= Math.round(ib.bld.h / 3.8) ? ib.b.floors.find((x) => x.level === 1) || ib.b.floors[0] : null);
  if (floor) {
    // inside a building we have an indoor map for: route all the way to the counter
    const b = ib.b;
    const [x, y] = latLngToPlan(b, f.lat, f.lon);
    const room = { id: f.name, kind: 'food', name: f.name, floor: floor.id, label: [x, y],
      poly: [[x - 14, y - 14], [x + 14, y - 14], [x + 14, y + 14], [x - 14, y + 14]] };
    ibOf.set(room, ib);
    state.url = url;
    chooseRoom(room, { record: false });
    state.url = url;
    history.replaceState(history.state, '', url);
    setHeader(`${f.name}<small>${[f.kind, `${floorName(b, floor.id)} · ${ib.name}`].filter(Boolean).join(' · ')}</small>`);
    return;
  }
  choosePoint({ title: f.name, sub: [f.kind, f.cuisine, f.building && `in ${f.building}`].filter(Boolean).join(' · '),
    lat: f.lat, lon: f.lon, info: f.hours ? `Hours: ${f.hours}` : '', url });
}

function goOutdoor(bld) {
  sheetMode('nav');
  show('outdoor', { url: state.url });
  $('#shareBtn').classList.toggle('hidden', state.dest?.share === false);
  outdoor.ready.then(() => { outdoor.select(bld); startGps(); pickTarget(); });
}

function openExplore() {
  state.dest = null;
  setPlace(null);
  state.url = '?explore=1';
  outdoor.setRoute(null); outdoor.setPoints([]); outdoor.focus(null); outdoor.select(null);
  sheetMode('explore');
  show('outdoor', { url: state.url });
  // start on the central campus (everything within ~350 m of the main building), not the whole boundary
  const mid = (main?.bld || campus.buildings[0]).ring[0];
  const core = campus.buildings.filter((x) => metersBetween([x.ring[0][1], x.ring[0][0]], [mid[1], mid[0]]) < 350)
    .flatMap((x) => x.ring.map(([lon, lat]) => [lat, lon]));
  outdoor.ready.then(() => { startGps(); outdoor.fit(core); });
}

// Indoor route from every entrance to the destination room (so we can pick the best overall).
// Runs in the routing worker; if you pick somewhere else meanwhile, the stale answer is dropped.
async function computeIndoor() {
  const dest = state.dest;
  state.perEntrance = [];
  const ib = state.ib;
  const all = await routingFor(ib).fromEntrances(dest.room, $('#stepFree').checked);
  if (state.dest !== dest) return;
  state.perEntrance = ib.b.entrances.map((e, i) => {
    const legs = all[i];
    const meters = legs ? legs.reduce((s, l) => s + (l.meters || 0) + (l.transition ? 8 : 0), 0) : Infinity;
    return { e, legs, meters };
  });
}

// ---------- outdoor map (3D campus) ----------
const outdoor = new OutdoorMap($('#map'), campus, {
  campusId: CAMPUS,
  data: DATA,
  onBuildingClick: (bld) => {
    if (state.mode === 'park') return false; // saving a spot: taps set your position instead
    openBuilding(bld);
  },
  onMapClick: (ll, bld) => {
    if (!state.demo) return;
    if (bld) { // tapped a 3D building: stand at its middle
      const n = bld.ring.length - 1;
      ll = [bld.ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n, bld.ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n];
    }
    setUser(ll);
  },
  onStopClick: (stop) => chooseStop(stop),
  onFoodClick: (f) => chooseFood(f),
});

// ---------- location ----------
function setGps(text, { retry = false } = {}) {
  $('#gpsStatus').textContent = text;
  $('#gpsStatus2').textContent = text;
  $('#gpsRetry').classList.toggle('hidden', !retry);
}
$('#gpsRetry').onclick = () => { state.demo = false; startGps(); };

let watchId = null;
let offCampus = false; // GPS works but you're far away: tap the map for a start, and keep watching for when you arrive
function startGps() {
  if (watchId !== null || state.demo) return;
  if (!('geolocation' in navigator)) return demoMode('Location isn’t available on this device.');
  setGps('Finding your location…');
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      const o = main ? [main.b.building.origin.lat, main.b.building.origin.lon] : [campus.buildings[0].ring[0][1], campus.buildings[0].ring[0][0]];
      const away = metersBetween(ll, o);
      if (away > FAR_FROM_CAMPUS) {
        if (!offCampus && state.user) setUser(null); // just left campus: drop the last on-campus fix too
        offCampus = state.demo = true; // the map doesn't reach that far, so never draw you there (or anywhere)
        setGps(`You’re ${fmtDist(away)} from campus. Tap the map to choose your start.`);
        if (state.mode === 'park') updateParkSheet();
        return;
      }
      if (offCampus) offCampus = state.demo = false; // you've arrived: real GPS takes over from any tapped start
      setGps(`Using your location (±${fmtDist(p.coords.accuracy)})`);
      parkDetector.add({ lat: ll[0], lon: ll[1], speed: p.coords.speed, t: p.timestamp });
      setUser(ll);
    },
    (err) => demoMode(err.code === 1 ? 'Location is off.' : 'Couldn’t find your location.'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function demoMode(reason) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  state.demo = true;
  setGps(`${reason} Tap the map to choose your start.`, { retry: true });
  if (state.mode === 'park') updateParkSheet();
}

function setUser(ll) {
  const moved = !state.user || !ll || metersBetween(state.user, ll) > 8;
  state.user = ll;
  outdoor.setUser(ll);
  meBtn.classList.toggle('hidden', !ll);
  if (state.mode === 'park') return updateParkSheet();
  if (moved) pickTarget(); // don't recompute (or refit the map) for GPS jitter
}

let fitOnce = null; // fit the map to a new route only once, so it doesn't jump while you walk
const walkLine = (m) => `${fmtDist(m)} · ${walkMins(m)} min`;

// Choose where to walk: the best entrance for a room (outdoor walk + indoor route), or the nearest side of a building.
function pickTarget(refit = false) {
  if (!state.dest || state.mode !== 'nav') return;
  if (state.dest.type === 'building') return pickBuilding(refit);
  if (state.dest.type === 'point') return pickPoint(refit);
  if (!state.perEntrance.length) { // indoor routes still being worked out
    $('#outLeg').innerHTML = '<span class="muted"><span class="spinner" aria-hidden="true"></span> Finding the best entrance…</span>';
    $('#arrived').classList.add('hidden');
    $('#walkSteps').innerHTML = '';
    return;
  }
  let best = null;
  for (const p of state.perEntrance) {
    const out = state.user ? walkRoute(state.user, [p.e.lat, p.e.lon]) : null;
    const total = (out?.meters || 0) + p.meters;
    if (!best || total < best.total) best = { ...p, out, total };
  }
  state.choice = best;
  const e = best.e;
  outdoor.setPoints(state.ib.b.entrances.map((x) => ({ lat: x.lat, lon: x.lon, kind: x === e ? 'best' : 'entrance' })));
  showWalk(best.out, `${state.ib.bld.id}:${state.dest.room.id}:${e.name}`, refit, state.ib.bld.ring, `${e.name} of ${state.ib.name}`);
  $('#outLeg').innerHTML = best.out
    ? `<b class="total">About ${walkMins(best.out.meters) + walkMins(best.meters)} min</b>
       Walk to the <b>${e.name}</b>: ${walkLine(best.out.meters)}<br>
       <span class="muted">Then ${walkLine(best.meters)} inside.</span>`
    : `Best entrance: <b>${e.name}</b>`;
  $('#arrived').classList.remove('hidden');
  $('#arrived').textContent = `I'm at the ${e.name.split(' (')[0]} →`;
  const toDoor = state.user ? metersBetween(state.user, [e.lat, e.lon]) : Infinity;
  if (toDoor < ARRIVE_RADIUS && !state.arrivedOnce && !state.demo) {
    state.arrivedOnce = true; // GPS says you're at the door: hand over to the indoor view
    goIndoor();
  }
}

function pickBuilding(refit) {
  const bld = state.dest.bld;
  const target = state.user ? nearestOnRing(bld.ring, state.user) : [bld.ring[0][1], bld.ring[0][0]];
  const out = state.user ? walkRoute(state.user, target) : null;
  outdoor.setPoints(state.ib ? state.ib.b.entrances.map((x) => ({ lat: x.lat, lon: x.lon, kind: 'entrance' })) : [{ lat: target[0], lon: target[1], kind: 'best' }]);
  showWalk(out, `b:${bld.id}`, refit, bld.ring, bld.name || 'building');
  $('#outLeg').innerHTML = (out ? `<b class="total">About ${walkMins(out.meters)} min</b> ${fmtDist(out.meters)} walk<br>` : '')
    + `<span class="muted">${state.ib ? 'Search a room to get a route inside.' : 'Indoor map coming soon for this building.'}</span>`;
  $('#arrived').classList.toggle('hidden', !state.ib);
  $('#arrived').textContent = 'Explore inside in 3D →';
}

function pickPoint(refit) {
  const d = state.dest;
  const target = [d.lat, d.lon];
  const out = state.user ? walkRoute(state.user, target) : null;
  outdoor.setPoints([]);
  showWalk(out, `p:${d.title}:${d.lat}`, refit, [[d.lon, d.lat]], d.arrive || d.title, d.beforeArrive);
  $('#outLeg').innerHTML = (out ? `<b class="total">About ${walkMins(out.meters)} min</b> ${fmtDist(out.meters)} walk<br>` : '')
    + (d.info ? `<span class="muted">${d.info}</span>` : '');
  $('#arrived').classList.add('hidden');
}

function showWalk(out, key, refit, ring, arriveAt, beforeArrive = []) {
  outdoor.setRoute(out?.coords || null);
  outdoor.focus(null);
  state.walkCoords = out?.coords || null;
  const box = [...(out?.coords || []), ...ring.map(([lon, lat]) => [lat, lon])];
  if (refit || fitOnce !== key) { fitOnce = key; outdoor.fit(box); }
  renderWalkSteps(out?.pieces ? walkingSteps(out, { landmarks: campus.buildings, arriveAt, beforeArrive }) : []);
}

// Turn-by-turn list under the route summary. Tap a step to fly there. It re-renders as GPS moves you,
// so the first step is always the one you're on.
function renderWalkSteps(steps) {
  const ol = $('#walkSteps');
  ol.innerHTML = steps.map((s, i) => `
    <li data-i="${i}" tabindex="0" class="${s.kind === 'c' ? 'cross' : s.kind === 'arrive' ? 'arrive' : ''}">${s.html}${s.meters ? `<br><small>${fmtDist(s.meters)}</small>` : ''}</li>`).join('');
  ol.querySelectorAll('li').forEach((li) => {
    li.onclick = () => {
      ol.querySelectorAll('li').forEach((x) => x.classList.toggle('on', x === li));
      outdoor.focus(steps[li.dataset.i].at);
    };
    li.onkeydown = (e) => { if (e.key === 'Enter') li.onclick(); };
  });
}
$('#fitRoute').onclick = () => {
  const d = state.dest;
  const ring = d?.type === 'building' ? d.bld.ring : d?.type === 'point' ? [[d.lon, d.lat]] : state.ib?.bld.ring || [];
  outdoor.fit([...(state.walkCoords || []), ...ring.map(([lon, lat]) => [lat, lon])]);
};
$('#arrived').onclick = () => goIndoor();

// Share a place (great for "meet me here"); falls back to copying the link.
$('#shareBtn').onclick = async () => {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: state.dest?.title || 'Campus map', text: `${state.dest?.title} · ${CAMPUS_SHORT}`, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch (e) {
    if (e.name !== 'AbortError') toast('Couldn’t share. Copy the address bar instead.');
  }
};

// ---------- 3D model of a building (tap it on the map) ----------
let shell = null;
const CAT_LABEL = { other: 'Campus services', ...Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) };

function openBuilding(bld) {
  if (ibByBld.has(bld.id)) { // full indoor map: open it straight away
    state.dest = { type: 'building', bld, title: bld.name || 'Building' };
    state.ib = ibByBld.get(bld.id);
    state.url = `?view=${bld.id}`;
    setPlace({ kind: 'building', key: bld.id, title: state.dest.title, sub: 'Building' });
    setHeader(`${state.dest.title}<small>Indoor 3D map · tap a room for directions</small>`);
    return goIndoor();
  }
  show('building', { url: `?view=${bld.id}` });
  showBuilding(bld);
}

async function showBuilding(bld) {
  if (!shell) {
    $('#bldTitle').innerHTML = `${bld.name || 'Building'}<small>Loading 3D model…</small>`;
    const { ShellView } = await loadShellView();
    shell ||= new ShellView($('#shell'));
  }
  shell.resize();

  const cat = CATEGORIES.find((c) => c.id === bld.cat);
  const color = cat?.color || '#9aa0aa';
  const deck = bld.cat === 'parking';
  const levels = Math.max(1, Math.round(bld.h / 3.8));
  const food = (campus.food || []).filter((f) => f.building_id === bld.id);
  const pins = food.map((f) => ({ lat: f.lat, lon: f.lon, level: (f.level ?? 0) + 1, label: f.name, kind: 'food', color: '#ff7ab6' }));
  const spot = parking.current();
  const carHere = spot && deck && parking.lotAt(spot.lat, spot.lon)?.name === bld.name;
  if (carHere) pins.push({ lat: spot.lat, lon: spot.lon, level: Number(spot.level) || 1, kind: 'car', heading: carHeading(bld.ring) });
  shell.show(bld, { color, deck, levels, pins });

  $('#bldTitle').innerHTML = `${bld.name || 'Building'}<small>${CAT_LABEL[bld.cat] || 'Building'} · ${CAMPUS_SHORT}</small>`;
  $('#bldFacts').innerHTML = `<span class="cat" style="--c:${color}">${CAT_LABEL[bld.cat] || 'Building'}</span>
    <span>${levels} ${deck ? 'level' : 'floor'}${levels === 1 ? '' : 's'}</span><span>${fmtHeight(bld.h)} tall</span>
    <span>${deck ? 'Open-air deck' : 'Indoor map coming soon'}</span>`;
  $('#bldWalk').onclick = () => chooseBuilding(bld);

  // what's here and nearby
  const n = bld.ring.length - 1;
  const mid = [bld.ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n, bld.ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n];
  const stops = (campus.transit?.stops || []).map((s) => ({ s, d: metersBetween(mid, [s.lat, s.lon]) }))
    .filter((x) => x.d < 250).sort((a, c) => a.d - c.d).slice(0, 3);
  let html = '';
  if (carHere) html += `<div class="bld-list"><h3>Your car</h3><button data-car>${CAR_SVG}<span>${describe(spot)}<small>Saved ${ago(spot.savedAt)} · get directions</small></span></button></div>`;
  if (deck && !carHere) html += `<div class="bld-list"><h3>Parking</h3><button data-park><span>Parked here? Save your spot<small>Stays on this device</small></span></button></div>`;
  if (food.length) html += `<div class="bld-list"><h3>Food & coffee here</h3>${food.map((f) =>
    `<button data-food="${campus.food.indexOf(f)}"><span>${f.name}<small>${[f.kind, f.cuisine].filter(Boolean).join(' · ')}</small></span></button>`).join('')}</div>`;
  if (stops.length) html += `<div class="bld-list"><h3>Bus stops nearby</h3>${stops.map(({ s, d }) =>
    `<button data-stop="${campus.transit.stops.indexOf(s)}"><span>${s.name}<small>${fmtDist(d)} · ${lineNames(s) || s.networks.join(' · ')}</small></span></button>`).join('')}</div>`;
  $('#bldLists').innerHTML = html;
  $('#bldLists').querySelectorAll('[data-food]').forEach((el) => (el.onclick = () => chooseFood(campus.food[el.dataset.food])));
  $('#bldLists').querySelectorAll('[data-stop]').forEach((el) => (el.onclick = () => chooseStop(campus.transit.stops[el.dataset.stop])));
  $('#bldLists').querySelector('[data-car]')?.addEventListener('click', walkToCar);
  $('#bldLists').querySelector('[data-park]')?.addEventListener('click', () => openParkSheet());

  // floor buttons: isolate one level
  const bar = $('#shellFloors');
  bar.innerHTML = '';
  const mk = (label, mode, title) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('aria-label', title);
    if (pins.some((p) => mode !== 'all' && p.level - 1 === mode)) btn.classList.add('route');
    btn.onclick = () => { shell.setLevel(mode); [...bar.children].forEach((x) => x.classList.toggle('on', x === btn)); };
    bar.append(btn);
    return btn;
  };
  const all = mk('All', 'all', 'Show all floors');
  const lvlBtns = [];
  for (let i = levels - 1; i >= 0; i--) lvlBtns[i] = mk(deck ? `L${i + 1}` : i === 0 ? 'G' : String(i + 1), i, deck ? `Level ${i + 1}` : i === 0 ? 'Ground floor' : `Floor ${i + 1}`);
  if (carHere) { // your car is in here: go straight to it
    const lvl = Math.min(levels, Number(spot.level) || 1) - 1;
    lvlBtns[lvl].classList.add('on');
    setTimeout(() => shell.focusCar(), 900);
  } else all.classList.add('on');
}

// ---------- parking spot (kept only on this device) ----------
const parking = new ParkingSpot(CAMPUS, campus);
const parkDetector = new ParkDetector(parking, ({ lot }) => {
  $('#parkPromptWhere').textContent = `${lot.name}. Save where you left your car?`;
  $('#parkPrompt').classList.remove('hidden');
});
$('#parkPromptYes').onclick = () => { $('#parkPrompt').classList.add('hidden'); openParkSheet(); };
$('#parkPromptNo').onclick = () => $('#parkPrompt').classList.add('hidden');

// floating button on the map: save a spot, or head back to the car
const carFab = document.createElement('button');
carFab.className = 'map-fab';
$('#map').append(carFab);
// recenter on your location (appears once we know where you are)
const meBtn = document.createElement('button');
meBtn.className = 'map-me hidden';
meBtn.innerHTML = '<span aria-hidden="true">◎</span>';
meBtn.setAttribute('aria-label', 'Center the map on my location');
meBtn.title = 'Center on me';
meBtn.onclick = () => state.user && outdoor.center(state.user);
$('#map').append(meBtn);

function renderCarFab() {
  const spot = parking.current();
  carFab.innerHTML = `${CAR_SVG}<span>${spot ? 'My car' : 'Save my spot'}</span>`;
  carFab.onclick = () => (spot ? walkToCar() : openParkSheet());
}

function renderCarCard() {
  const spot = parking.current();
  renderCarFab();
  outdoor.ready.then(() => outdoor.setCar(spot, { heading: spot ? carHeading(parking.lotAt(spot.lat, spot.lon)?.ring) : 0, onClick: walkToCar }));
  if (!spot) {
    $('#carCard').innerHTML = `<button class="card save" id="carSave"><span class="icon" style="color:var(--accent)">${CAR_SVG}</span>
      <span class="txt">Save where I parked<small>Find your car later. Stays on this device.</small></span></button>`;
    $('#carSave').onclick = () => openParkSheet();
    return;
  }
  $('#carCard').innerHTML = `<div class="card"><span class="icon" style="color:var(--accent)">${CAR_SVG}</span>
    <span class="txt"><b>Your car</b><small>${describe(spot)} · ${ago(spot.savedAt)}</small></span>
    <button class="btn primary" id="carGo">Walk to car</button>
    <button class="btn secondary" id="carUpd" aria-label="Save a new parking spot">Update</button>
    <button class="btn secondary" id="carClr" aria-label="Forget this parking spot">Clear</button></div>`;
  $('#carGo').onclick = walkToCar;
  $('#carUpd').onclick = () => openParkSheet();
  $('#carClr').onclick = () => { parking.clear(); renderCarCard(); toast('Parking spot cleared'); };
}

let parkLevel = null;
function openParkSheet() {
  state.dest = null;
  setPlace(null);
  parkLevel = null;
  $('#parkNote').value = '';
  outdoor.setRoute(null); outdoor.setPoints([]); outdoor.focus(null); outdoor.select(null);
  sheetMode('park');
  show('outdoor', { url: '?park=1' });
  outdoor.ready.then(() => { startGps(); updateParkSheet(true); });
}

function updateParkSheet(first = false) {
  if (!state.user) {
    $('#parkWhere').textContent = state.demo ? 'Tap the map where you parked.' : 'Finding your location…';
    $('#parkSave').disabled = true;
    return;
  }
  const [lat, lon] = state.user;
  const lot = parking.lotAt(lat, lon);
  $('#parkWhere').textContent = (lot ? `You're in ${lot.name}.` : 'Not inside a campus lot; the spot will be saved where you are.')
    + (state.demo ? ' (Demo: tap the map to move.)' : '');
  const row = $('#parkLevels');
  row.classList.toggle('hidden', !lot?.deck);
  if (lot?.deck && row.dataset.lot !== lot.name) {
    row.dataset.lot = lot.name;
    parkLevel = null;
    row.innerHTML = '<span class="label">Which level?</span>' + Array.from({ length: lot.levels }, (_, i) =>
      `<button data-l="${i + 1}" aria-pressed="false">${i === lot.levels - 1 ? `${i + 1} (top)` : i + 1}</button>`).join('');
    row.querySelectorAll('button').forEach((btn) => (btn.onclick = () => {
      parkLevel = btn.dataset.l;
      row.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === btn); x.setAttribute('aria-pressed', x === btn); });
    }));
  }
  if (!lot?.deck) row.dataset.lot = '';
  $('#parkSave').disabled = false;
  if (first) outdoor.focus([lat, lon]);
}

$('#parkSave').onclick = () => {
  if (!state.user) return;
  const [lat, lon] = state.user;
  const spot = parking.save({ lat, lon, level: parkLevel, note: $('#parkNote').value });
  outdoor.focus(null);
  toast(`Saved: ${describe(spot)}`);
  back('search');
};

function walkToCar() {
  const spot = parking.current();
  if (!spot) return;
  const deck = spot.deck && spot.level && Number(spot.level) > 1;
  choosePoint({
    title: 'Your car', sub: `${describe(spot)} · saved ${ago(spot.savedAt)}`, lat: spot.lat, lon: spot.lon,
    info: [spot.lot, spot.level && `Level ${spot.level}`, spot.note].filter(Boolean).join(' · '),
    url: '?car=1', arrive: 'your car', share: false,
    beforeArrive: deck ? [`Go up to <b>Level ${spot.level}</b> of ${spot.lot} (stairs or elevator)`] : [],
  });
  setPlace(null);
}

// ---------- indoor ----------
async function ensureIndoor() {
  show('indoor', { url: state.url });
  const ib = state.ib;
  if (!ib.view) {
    $('#steps').innerHTML = '<li class="muted"><span class="spinner" aria-hidden="true"></span> Loading the 3D map…</li>';
    const { IndoorView } = await loadIndoorView();
    ib.view ||= new IndoorView($('#scene'), ib.b, { onSelect: rerouteIndoor });
  }
  for (const x of indoors) x.view?.setActive(x === ib); // one building on screen; the others stop rendering
  indoor = ib.view;
  indoor.resize();
}

async function goIndoor() {
  if (state.dest?.type === 'building') {
    await ensureIndoor();
    indoor.clearRoute();
    indoor.setFloorMode('all');
    renderFloorbar([]);
    $('#steps').innerHTML = '<li>Tap any room to get a route to it from the nearest entrance.</li>';
    return;
  }
  const c = state.choice;
  if (state.dest?.type === 'room' && !state.perEntrance.length) { toast('Still finding the best route…'); return; }
  if (!c?.legs) { toast(state.dest?.room ? 'No route to this room yet. Try turning off Step-free.' : 'Pick a room first.'); return; }
  await ensureIndoor();
  indoor.showRoute(c.legs, { ...state.dest.room, title: state.dest.title }, c.e.name.split(' (')[0]);
  renderFloorbar(c.legs);
  renderSteps(c);
}

// Tapped a room in the 3D view: route there from the entrance you came in (or the main one).
async function rerouteIndoor(room) {
  const ib = state.ib;
  const e = (state.choice?.e && ib.b.entrances.includes(state.choice.e) && state.choice.e) || ib.b.entrances[0];
  const legs = await routingFor(ib).fromEntrance(e, room, $('#stepFree').checked);
  if (!legs) { toast('No route to that room.'); return; }
  state.dest = { type: 'room', room, title: roomTitle(room) };
  state.choice = { e, legs };
  state.url = roomUrl(room, ib);
  history.replaceState(history.state, '', state.url);
  remember('room', roomKey(room, ib), state.dest.title, roomSub(room, ib));
  setHeader(`${state.dest.title}<small>${roomSub(room, ib)}</small>`);
  indoor.showRoute(legs, { ...room, title: state.dest.title }, e.name.split(' (')[0]);
  renderFloorbar(legs);
  renderSteps(state.choice);
}

function renderFloorbar(legs) {
  const b = state.ib.b;
  const used = new Set(legs.filter((l) => l.pts).map((l) => l.floor));
  const bar = $('#floorbar');
  bar.innerHTML = '';
  const mk = (label, mode) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = mode === 'route' ? 'Floors on your route' : mode === 'all' ? 'All floors' : floorName(b, mode);
    btn.setAttribute('aria-label', btn.title);
    if (used.has(mode)) btn.classList.add('route');
    btn.onclick = () => { indoor.setFloorMode(mode); [...bar.children].forEach((x) => x.classList.toggle('on', x === btn)); };
    bar.append(btn);
    return btn;
  };
  if (legs.length) mk('Route', 'route').classList.add('on');
  for (const f of [...b.floors].reverse()) mk(f.id === 'ground' ? 'G' : /^lower/i.test(f.name) ? 'LL' : String(f.level), f.id);
  const all = mk('All', 'all');
  if (!legs.length) all.classList.add('on');
}

function renderSteps(c) {
  const b = state.ib.b;
  const steps = [];
  const dest = state.dest.room;
  steps.push([`Enter through the <b>${c.e.name}</b>.`, floorName(b, c.e.floor)]);
  // Ride through floors where you don't walk: stairs 1->2, 2->3 becomes one "up to Floor 3" step.
  const legs = [];
  for (const l of c.legs) {
    const prev = legs.at(-1), prev2 = legs.at(-2);
    if (l.transition && prev?.pts && prev.meters < 3 && prev2?.transition && prev2.kind === l.kind) {
      legs.pop();
      prev2.to = l.to;
    } else legs.push({ ...l });
  }
  legs.forEach((leg, li) => {
    if (leg.transition) {
      const up = b.floorIndex[leg.to] > b.floorIndex[leg.from];
      steps.push([`Take the <b>${leg.kind === 'elevator' ? 'elevator' : 'stairs'}</b> ${up ? 'up' : 'down'} to <b>${floorName(b, leg.to)}</b>.`, '', true]);
      return;
    }
    const next = legs[li + 1];
    const last = li === legs.length - 1;
    // walk + turns along this floor's path; smoothed (~1.5 m) so grid wiggles don't become "turn left, turn right"
    let acc = 0;
    const p = simplify(leg.pts, 1.5 / b.mPerPx);
    for (let i = 1; i < p.length; i++) {
      acc += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) * b.mPerPx;
      if (i < p.length - 1) {
        const v1 = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]], v2 = [p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]];
        const cross = v1[0] * v2[1] - v1[1] * v2[0], dot = v1[0] * v2[0] + v1[1] * v2[1];
        const ang = Math.atan2(Math.abs(cross), dot) * 180 / Math.PI;
        const segNext = Math.hypot(...v2) * b.mPerPx;
        if (ang > 40 && acc > 4 && segNext > 4) {
          steps.push([`Walk ${fmtDist(acc)}, then turn <b>${ang > 120 ? 'around' : cross > 0 ? 'right' : 'left'}</b>.`]);
          acc = 0;
        }
      }
    }
    if (last) steps.push([`Walk ${fmtDist(acc)} to <b>${state.dest.title}</b>. You’ve arrived!`, dest.kind === 'room' ? `Room ${dest.id}` : '']);
    else if (next?.transition) steps.push([`Walk ${fmtDist(acc)} to the <b>${next.kind === 'elevator' ? 'elevator' : 'stairs'}</b>.`]);
  });
  $('#steps').innerHTML = steps.map(([t, s, fc]) => `<li class="${fc ? 'floorchange' : ''}">${t}${s ? `<br><small>${s}</small>` : ''}</li>`).join('');
}

// ---------- start ----------
// Deep links (QR codes on signs, shared links): ?to=344 (&in=gmu-research for rooms outside the main building), ?b=<osm id>, ?view=<osm id>, ?stop=, ?food=, ?car=1, ?park=1, ?explore=1
if (params.get('to')) {
  const r = findRoom(params.get('to'), params.get('in'));
  if (r) chooseRoom(r);
} else if (params.get('b')) {
  const x = campus.buildings.find((y) => String(y.id) === params.get('b'));
  if (x) chooseBuilding(x);
} else if (params.get('stop')) {
  const s = campus.transit?.stops[Number(params.get('stop'))];
  if (s) chooseStop(s);
} else if (params.get('food')) {
  const f = campus.food?.[Number(params.get('food'))];
  if (f) chooseFood(f);
} else if (params.get('view')) {
  const x = campus.buildings.find((y) => String(y.id) === params.get('view'));
  if (x) outdoor.ready.then(() => openBuilding(x));
} else if (params.get('car')) {
  walkToCar();
} else if (params.get('park')) {
  openParkSheet();
} else if (params.get('explore')) {
  openExplore();
}
renderHome();
$('#boot').classList.add('hidden');

// installable + works offline once visited (app shell, libraries, tiles); relative, so it also works from a subfolder
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
