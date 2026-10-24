// Akadian Engine studio: import schematics, fix labels, place entrances, build and publish. Runs against the local engine only.
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body, form, raw } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'x-akadian': '1' } };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(path, opts);
  if (r.status === 401 || r.status === 423) { showLock(); throw new Error('Locked'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? r : r.json();
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Locked') toast(e.message, true); } };

// Long operations run as jobs on the server; poll until done and stream the log into `logEl`.
async function waitJob(jobId, logEl) {
  for (;;) {
    const j = await api(`/api/jobs/${jobId}`);
    if (logEl) logEl.textContent = j.log.join('\n');
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function planImage(pid, fid) {
  const r = await api(`/api/projects/${pid}/floors/${fid}/plan.png`, { raw: true });
  return createImageBitmap(await r.blob());
}

// ---------------- lock / unlock ----------------
async function boot() {
  const s = await fetch('/api/auth/status', { credentials: 'same-origin' }).then((r) => r.json());
  if (s.signedIn) return showStudio();
  showLock(s);
}

async function showLock(s) {
  s = s || await fetch('/api/auth/status').then((r) => r.json());
  $('#studio').classList.add('hidden');
  $('#lock').classList.remove('hidden');
  const setup = !s.configured;
  $('#lockStep').textContent = setup ? 'First run · 1 of 1' : 'Private studio';
  $('#lockTitle').textContent = setup ? 'Protect your schematics' : 'Unlock the engine';
  $('#lockText').textContent = setup
    ? 'Everything you import (floor plans, renders, labels) is encrypted on this machine with a key made from this passphrase. Nothing is sent to any AI service.'
    : 'Your schematics are encrypted on this machine. Enter your passphrase to work on them.';
  $('#pass2Row').classList.toggle('hidden', !setup);
  $('#lockHint').hidden = !setup;
  $('#lockBtn').textContent = setup ? 'Create passphrase' : 'Unlock';
  $('#pass1').autocomplete = setup ? 'new-password' : 'current-password';
  $('#lockForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#lockError').textContent = '';
    const p1 = $('#pass1').value;
    if (setup && p1 !== $('#pass2').value) { $('#lockError').textContent = 'Passphrases don’t match.'; return; }
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/unlock', { method: 'POST', body: { passphrase: p1 } });
      $('#pass1').value = $('#pass2').value = '';
      showStudio();
    } catch (err) { $('#lockError').textContent = err.message; }
  };
  $('#pass1').focus();
}

function showStudio() {
  $('#lock').classList.add('hidden');
  $('#studio').classList.remove('hidden');
  route();
}
$('#lockNow').onclick = guard(async () => { await api('/api/auth/lock', { method: 'POST' }); showLock(); });
document.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => { location.hash = b.dataset.nav; }));
window.addEventListener('hashchange', () => route());

function route() {
  const [page, id, tab] = (location.hash.slice(1) || 'buildings').split('/');
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === page || (page === 'building' && b.dataset.nav === 'buildings') || (page === 'campus' && b.dataset.nav === 'campuses')));
  if (page === 'building' && id) return guard(buildingPage)(id, tab || 'floors');
  if (page === 'campuses') return guard(campusesPage)();
  if (page === 'campus' && id) return guard(campusPage)(id);
  guard(buildingsPage)();
}

// ---------------- buildings list ----------------
async function buildingsPage() {
  const list = await api('/api/projects');
  main.innerHTML = `
    <div class="page-head"><div class="grow"><p class="eyebrow">Indoor maps</p><h1>Buildings</h1></div></div>
    <div class="grid">${list.map((p) => `
      <div class="tile" data-id="${esc(p.id)}">
        <div class="row"><b class="grow">${esc(p.name)}</b>${p.published ? '<span class="pill live">Live</span>' : '<span class="pill">Draft</span>'}</div>
        <div class="meta">${esc(p.id)} · ${p.floors} floor${p.floors === 1 ? '' : 's'}${p.campus ? ` · campus ${esc(p.campus)}` : ''}</div>
        <div class="meta">${p.built ? `Built ${esc(p.built)}` : 'Not built yet'}</div>
      </div>`).join('') || '<p class="muted">No buildings yet. Create one below.</p>'}
    </div>
    <div class="card" style="margin-top:18px;max-width:640px">
      <h2>New building</h2>
      <form id="newB">
        <div class="row">
          <label class="grow">Name<input name="name" placeholder="Johnson Center" required></label>
          <label class="grow">ID<input name="id" placeholder="gmu-jc" pattern="[a-z0-9][a-z0-9-]{1,40}" required></label>
        </div>
        <div class="row">
          <label class="grow">Campus ID<input name="campus" placeholder="gmu"></label>
          <label class="grow">OpenStreetMap way ID (optional)<input name="osm_way" inputmode="numeric" placeholder="45334823"></label>
        </div>
        <div class="row end" style="margin-top:12px"><button class="btn primary">Create building</button></div>
      </form>
    </div>`;
  main.querySelectorAll('.tile').forEach((t) => (t.onclick = () => (location.hash = `building/${t.dataset.id}`)));
  $('#newB').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.osm_way = f.osm_way ? Number(f.osm_way) : null;
    const p = await api('/api/projects', { method: 'POST', body: f });
    location.hash = `building/${p.id}`;
  });
}

// ---------------- building editor ----------------
let P = null; // current project settings

async function buildingPage(pid, tab) {
  P = await api(`/api/projects/${pid}`);
  main.innerHTML = `
    <div class="page-head">
      <div class="grow"><p class="eyebrow"><a href="#buildings">Buildings</a> / ${esc(P.id)}</p><h1>${esc(P.name)}</h1></div>
    </div>
    <div class="tabs">${['floors', 'labels', 'entrances', 'build'].map((t) =>
      `<button class="tab ${t === tab ? 'on' : ''}" data-tab="${t}">${{ floors: 'Floors', labels: 'Plan editor', entrances: 'Entrances', build: 'Build & publish' }[t]}</button>`).join('')}</div>
    <div id="tabBody"></div>`;
  main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `building/${pid}/${b.dataset.tab}`)));
  await ({ floors: floorsTab, labels: editorTab, entrances: entrancesTab, build: buildTab }[tab] || floorsTab)();
}

const save = (patch) => api(`/api/projects/${P.id}`, { method: 'PUT', body: patch }).then((p) => (P = p));

// ----- floors -----
async function floorsTab() {
  const body = $('#tabBody');
  body.innerHTML = `
    <div class="card">
      <h2>Floors</h2>
      <table><thead><tr><th>Floor</th><th>ID</th><th>Level</th><th>Room prefix</th><th>Labels</th><th>Alignment</th><th></th></tr></thead>
      <tbody>${P.floors.map((f) => `
        <tr data-fid="${esc(f.id)}">
          <td><b>${esc(f.name)}</b> ${f.reference ? '<span class="pill ref">Reference</span>' : ''} ${f.processed ? '' : '<span class="pill">Processing…</span>'}</td>
          <td>${esc(f.id)}</td><td>${f.level}</td><td>${esc(f.prefix || '–')}</td>
          <td>${(P.labels[f.id] || []).length}</td>
          <td>${f.reference ? '—' : `${f.offset[0]}, ${f.offset[1]} px`}</td>
          <td class="row end">
            ${f.reference ? '' : '<button class="btn sm" data-act="align">Align</button><button class="btn sm ghost" data-act="ref">Make reference</button>'}
            <button class="btn sm ghost" data-act="ocr">Re-read labels</button>
            <button class="btn sm danger" data-act="del">Remove</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No floors yet.</td></tr>'}</tbody></table>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Import a floor schematic</h2>
      <p class="muted small">PDF, PNG or JPEG. It's encrypted as soon as it arrives and processed on this machine only (local OCR, no AI services).</p>
      <form id="up">
        <div class="row">
          <label class="grow">File<input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required></label>
          <label>Floor name<input name="name" placeholder="Floor 2" required></label>
          <label>ID<input name="id" placeholder="second" pattern="[a-z0-9][a-z0-9-]{1,40}" required></label>
          <label style="width:90px">Level<input name="level" type="number" value="${P.floors.length}" required></label>
          <label style="width:120px">Room prefix<input name="prefix" placeholder="2 or G"></label>
        </div>
        <div class="row end" style="margin-top:12px"><button class="btn primary">Import & process</button></div>
      </form>
      <div class="log hidden" id="upLog"></div>
    </div>
    <div id="alignBox"></div>`;

  $('#up').onsubmit = guard(async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const { job } = await api(`/api/projects/${P.id}/floors`, { method: 'POST', form: new FormData(e.target) });
      $('#upLog').classList.remove('hidden');
      await waitJob(job, $('#upLog'));
      toast('Floor imported');
      buildingPage(P.id, 'floors');
    } finally { btn.disabled = false; }
  });
  body.querySelectorAll('tr[data-fid] button').forEach((b) => (b.onclick = guard(async () => {
    const fid = b.closest('tr').dataset.fid;
    const act = b.dataset.act;
    if (act === 'del') {
      if (!confirm(`Remove floor "${fid}" and its encrypted schematic?`)) return;
      P = await api(`/api/projects/${P.id}/floors/${fid}`, { method: 'DELETE' });
      return floorsTab();
    }
    if (act === 'ocr') {
      if (!confirm('Re-read labels with OCR? This replaces the labels you edited on this floor.')) return;
      const { job } = await api(`/api/projects/${P.id}/floors/${fid}/process`, { method: 'POST' });
      toast('Reading labels…');
      await waitJob(job);
      return buildingPage(P.id, 'floors');
    }
    if (act === 'ref') {
      await save({ floors: P.floors.map((f) => ({ ...f, reference: f.id === fid, offset: f.id === fid ? [0, 0] : f.offset })) });
      toast('Offsets are relative to the reference floor; re-align the others.');
      return floorsTab();
    }
    if (act === 'align') alignPanel(fid);
  })));
}

function alignPanel(fid) {
  const f = P.floors.find((x) => x.id === fid);
  let [dx, dy] = f.offset;
  const box = $('#alignBox');
  box.innerHTML = `
    <div class="card" style="margin-top:14px">
      <h2>Align ${esc(f.name)} to the reference floor</h2>
      <div class="align">
        <img id="ov" alt="Overlay of this floor on the reference floor">
        <div>
          <p class="muted small">Orange = reference floor, white = this floor. Shift until stairwells and outer walls overlap.</p>
          <div class="row"><label class="grow">X<input id="dx" type="number" step="0.5" value="${dx}"></label><label class="grow">Y<input id="dy" type="number" step="0.5" value="${dy}"></label></div>
          <div class="nudge">
            <span></span><button class="btn sm" data-n="0,-1">↑</button><span></span>
            <button class="btn sm" data-n="-1,0">←</button><button class="btn sm" data-n="0,0" title="Refresh">⟳</button><button class="btn sm" data-n="1,0">→</button>
            <span></span><button class="btn sm" data-n="0,1">↓</button><span></span>
          </div>
          <p class="muted small">Shift-click arrows to move 10 px.</p>
          <div class="row"><button class="btn" id="auto">Auto-align</button><button class="btn primary grow" id="saveAlign">Save alignment</button></div>
        </div>
      </div>
    </div>`;
  const refresh = guard(async () => {
    dx = Number($('#dx').value); dy = Number($('#dy').value);
    const r = await api(`/api/projects/${P.id}/floors/${fid}/overlay.png?dx=${dx}&dy=${dy}`, { raw: true });
    const url = URL.createObjectURL(await r.blob());
    const img = $('#ov'); URL.revokeObjectURL(img.src); img.src = url;
  });
  box.querySelectorAll('[data-n]').forEach((b) => (b.onclick = (e) => {
    const [x, y] = b.dataset.n.split(',').map(Number);
    const k = e.shiftKey ? 10 : 1;
    $('#dx').value = Number($('#dx').value) + x * k;
    $('#dy').value = Number($('#dy').value) + y * k;
    refresh();
  }));
  $('#dx').onchange = $('#dy').onchange = refresh;
  $('#auto').onclick = guard(async () => {
    const r = await api(`/api/projects/${P.id}/floors/${fid}/auto-align`, { method: 'POST' });
    $('#dx').value = r.offset[0]; $('#dy').value = r.offset[1];
    toast(`Auto-align confidence ${r.confidence}. Check the overlay.`);
    refresh();
  });
  $('#saveAlign').onclick = guard(async () => {
    await save({ floors: P.floors.map((x) => (x.id === fid ? { ...x, offset: [Number($('#dx').value), Number($('#dy').value)] } : x)) });
    toast('Alignment saved');
    floorsTab();
  });
  refresh();
  box.scrollIntoView({ behavior: 'smooth' });
}

// ----- plan editor -----
const KIND_COLORS = { room: '#f0a04a', stair: '#3fcf7f', elevator: '#c77dff', restroom: '#4da3ff', entrance: '#ff5f6d', circulation: '#6b7280', service: '#4b5160' };

async function editorTab() {
  const body = $('#tabBody');
  const floors = P.floors.filter((f) => f.processed);
  if (!floors.length) { body.innerHTML = '<p class="muted">Import and process a floor first.</p>'; return; }
  const state = {
    fid: sessionStorage.getItem(`floor:${P.id}`) || floors[0].id, mode: 'select', sel: null, dirty: false,
    labels: structuredClone(P.labels), voids: structuredClone(P.voids), floors: structuredClone(P.floors),
    entrances: structuredClone(P.entrances), view: null, img: null, drag: null,
  };
  if (!floors.find((f) => f.id === state.fid)) state.fid = floors[0].id;

  body.innerHTML = `
    <div class="editor">
      <div class="canvas-wrap">
        <div class="toolbar">
          <select id="floorSel" style="padding:5px 8px">${floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select>
          ${[['select', 'Select / move'], ['add', '+ Label'], ['void', 'Open to below'], ['exclude', 'Exclude area'], ['entrance', 'Entrance']].map(([m, t]) => `<button data-mode="${m}">${t}</button>`).join('')}
        </div>
        <canvas id="cv"></canvas>
      </div>
      <div class="panel">
        <div class="row"><b class="grow">Labels</b><button class="btn primary sm" id="saveLbl">Save</button></div>
        <div id="selBox" class="muted small" style="margin-top:10px">Select a label to edit it. Scroll to zoom, drag to pan.</div>
        <input id="filter" placeholder="Find label…" style="width:100%;margin-top:12px">
        <div class="list" id="lblList"></div>
        <div class="legend">${Object.entries(KIND_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')}</div>
        <p class="muted small">Open to below: click inside each atrium piece (blue). Exclude area: drag over title blocks or legends (red). Restricted rooms are published as unlabeled shapes.</p>
      </div>
    </div>`;
  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  $('#floorSel').value = state.fid;

  const floor = () => state.floors.find((f) => f.id === state.fid);
  const labels = () => (state.labels[state.fid] ||= []);
  const off = () => floor().offset || [0, 0];
  // voids are stored in the common frame; show them on this floor's plan
  const voidsHere = () => (state.voids[state.fid] ||= []);

  async function loadFloor() {
    sessionStorage.setItem(`floor:${P.id}`, state.fid);
    state.img = await planImage(P.id, state.fid);
    const r = cv.getBoundingClientRect();
    const s = Math.min(r.width / state.img.width, r.height / state.img.height);
    state.view = { s, x: (r.width - state.img.width * s) / 2, y: (r.height - state.img.height * s) / 2 };
    state.sel = null;
    renderList(); renderSel(); draw();
  }
  const toPlan = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - state.view.x) / state.view.s, (e.clientY - r.top - state.view.y) / state.view.s]; };

  function draw() {
    const r = cv.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, r.width, r.height);
    if (!state.img) return;
    const { s, x, y } = state.view;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.globalAlpha = 0.9; ctx.drawImage(state.img, 0, 0); ctx.globalAlpha = 1;
    for (const [x0, y0, x1, y1] of floor().exclude || []) {
      ctx.fillStyle = '#ff5f6d33'; ctx.strokeStyle = '#ff5f6d'; ctx.lineWidth = 2 / s;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (state.drag?.rect) { const [a, b, c, d] = state.drag.rect; ctx.strokeStyle = '#ff5f6d'; ctx.strokeRect(a, b, c - a, d - b); }
    const [dx, dy] = off();
    for (const [vx, vy] of voidsHere()) {
      const px = vx + dx, py = vy + dy;
      ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 2.5 / s;
      ctx.beginPath(); ctx.arc(px, py, 9 / s, 0, 7); ctx.moveTo(px - 6 / s, py - 6 / s); ctx.lineTo(px + 6 / s, py + 6 / s); ctx.moveTo(px + 6 / s, py - 6 / s); ctx.lineTo(px - 6 / s, py + 6 / s); ctx.stroke();
    }
    for (const e of state.entrances.filter((e) => e.floor === state.fid)) {
      ctx.fillStyle = '#ff5f6d'; ctx.beginPath(); ctx.arc(e.x, e.y, 7 / s, 0, 7); ctx.fill();
      ctx.font = `${12 / s}px Segoe UI`; ctx.fillStyle = '#fff'; ctx.fillText(e.name, e.x + 10 / s, e.y + 4 / s);
    }
    ctx.restore();
    // labels drawn in screen space so they stay readable at any zoom
    ctx.font = '600 11px Segoe UI';
    for (const l of labels()) {
      const sx = x + l.x * s, sy = y + l.y * s;
      const w = ctx.measureText(l.id).width + 10;
      const col = KIND_COLORS[l.kind] || '#999';
      ctx.fillStyle = l === state.sel ? '#ffffff' : '#16181dd9';
      ctx.strokeStyle = l.restricted ? '#888' : col; ctx.lineWidth = l === state.sel ? 2 : 1.2;
      roundRect(ctx, sx - w / 2, sy - 9, w, 18, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = l === state.sel ? '#16181d' : l.restricted ? '#888' : col;
      ctx.fillText(l.id, sx - w / 2 + 5, sy + 4);
    }
  }
  function hit(e) {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    ctx.font = '600 11px Segoe UI';
    return [...labels()].reverse().find((l) => {
      const sx = state.view.x + l.x * state.view.s, sy = state.view.y + l.y * state.view.s;
      const w = ctx.measureText(l.id).width + 10;
      return Math.abs(mx - sx) <= w / 2 && Math.abs(my - sy) <= 9;
    });
  }

  function renderList() {
    const q = $('#filter').value.trim().toLowerCase();
    const items = labels().filter((l) => !q || l.id.toLowerCase().includes(q) || (l.name || '').toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    $('#lblList').innerHTML = items.map((l, i) => `<div data-i="${labels().indexOf(l)}" class="${l === state.sel ? 'on' : ''}"><b style="color:${KIND_COLORS[l.kind]}">${esc(l.id)}</b><span class="muted">${esc(l.name || l.kind)}${l.restricted ? ' · restricted' : ''}</span></div>`).join('');
    $('#lblList').querySelectorAll('[data-i]').forEach((d) => (d.onclick = () => {
      state.sel = labels()[d.dataset.i];
      const r = cv.getBoundingClientRect();
      state.view.x = r.width / 2 - state.sel.x * state.view.s; state.view.y = r.height / 2 - state.sel.y * state.view.s;
      renderSel(); renderList(); draw();
    }));
  }
  function renderSel() {
    const l = state.sel;
    if (!l) { $('#selBox').innerHTML = 'Select a label to edit it. Scroll to zoom, drag to pan.'; return; }
    $('#selBox').innerHTML = `
      <label>Label<input id="sId" value="${esc(l.id)}"></label>
      <label>Kind<select id="sKind">${Object.keys(KIND_COLORS).map((k) => `<option ${k === l.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>Public name (optional)<input id="sName" value="${esc(l.name || '')}" placeholder="e.g. Math Tutoring Center"></label>
      <label class="row" style="gap:8px"><input type="checkbox" id="sRes" ${l.restricted ? 'checked' : ''}> Restricted (don't publish its number or name)</label>
      <div class="row" style="margin-top:8px"><button class="btn sm danger" id="sDel">Delete label</button></div>`;
    const upd = () => { l.id = $('#sId').value.trim().toUpperCase() || l.id; l.kind = $('#sKind').value; l.name = $('#sName').value.trim() || undefined; l.restricted = $('#sRes').checked || undefined; state.dirty = true; renderList(); draw(); };
    ['sId', 'sKind', 'sName', 'sRes'].forEach((id) => ($('#' + id).onchange = upd));
    $('#sDel').onclick = () => { labels().splice(labels().indexOf(l), 1); state.sel = null; state.dirty = true; renderSel(); renderList(); draw(); };
  }

  cv.onwheel = (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    state.view.x = mx - (mx - state.view.x) * k; state.view.y = my - (my - state.view.y) * k; state.view.s *= k;
    draw();
  };
  cv.onpointerdown = (e) => {
    cv.setPointerCapture(e.pointerId);
    const [px, py] = toPlan(e);
    const m = state.mode;
    if (m === 'select') {
      const l = hit(e);
      state.sel = l || null; renderSel(); renderList();
      state.drag = l ? { label: l } : { pan: [e.clientX - state.view.x, e.clientY - state.view.y] };
    } else if (m === 'add') {
      const l = { id: 'NEW', kind: 'room', x: Math.round(px), y: Math.round(py) };
      labels().push(l); state.sel = l; state.dirty = true; renderSel(); renderList();
      $('#sId')?.select();
    } else if (m === 'void') {
      const [dx, dy] = off();
      const v = voidsHere();
      const near = v.findIndex(([vx, vy]) => Math.hypot(vx + dx - px, vy + dy - py) * state.view.s < 12);
      if (near >= 0) v.splice(near, 1); else v.push([Math.round(px - dx), Math.round(py - dy)]);
      state.dirty = true;
    } else if (m === 'exclude') {
      const ex = (floor().exclude ||= []);
      const inside = ex.findIndex(([a, b, c, d]) => px >= a && px <= c && py >= b && py <= d);
      if (inside >= 0) { ex.splice(inside, 1); state.dirty = true; } else state.drag = { rect: [px, py, px, py] };
    } else if (m === 'entrance') {
      const name = prompt('Entrance name (e.g. "East entrance (main)")');
      if (name) { state.entrances.push({ name, floor: state.fid, x: Math.round(px), y: Math.round(py), lat: null, lon: null }); state.dirty = true; toast('Set its latitude/longitude on the Entrances tab.'); }
    }
    draw();
  };
  cv.onpointermove = (e) => {
    const d = state.drag;
    if (!d) return;
    const [px, py] = toPlan(e);
    if (d.label) { d.label.x = Math.round(px); d.label.y = Math.round(py); state.dirty = true; }
    else if (d.pan) { state.view.x = e.clientX - d.pan[0]; state.view.y = e.clientY - d.pan[1]; }
    else if (d.rect) { d.rect[2] = px; d.rect[3] = py; }
    draw();
  };
  cv.onpointerup = () => {
    const d = state.drag;
    if (d?.rect) {
      const [a, b, c, e] = d.rect;
      if (Math.abs(c - a) > 5 && Math.abs(e - b) > 5) { floor().exclude.push([Math.round(Math.min(a, c)), Math.round(Math.min(b, e)), Math.round(Math.max(a, c)), Math.round(Math.max(b, e))]); state.dirty = true; }
    }
    state.drag = null; draw();
  };
  window.onkeydown = (e) => {
    if (e.key === 'Delete' && state.sel && document.activeElement === document.body) { labels().splice(labels().indexOf(state.sel), 1); state.sel = null; state.dirty = true; renderSel(); renderList(); draw(); }
  };
  body.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    state.mode = b.dataset.mode;
    body.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  body.querySelector('[data-mode=select]').classList.add('on');
  $('#floorSel').onchange = guard(async () => { state.fid = $('#floorSel').value; await loadFloor(); });
  $('#filter').oninput = renderList;
  $('#saveLbl').onclick = guard(async () => {
    await save({ labels: state.labels, voids: state.voids, floors: state.floors, entrances: state.entrances });
    state.dirty = false;
    toast('Saved (encrypted)');
  });
  window.onbeforeunload = () => (state.dirty ? true : undefined);
  new ResizeObserver(draw).observe(cv);
  await loadFloor();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ----- entrances -----
async function entrancesTab() {
  const body = $('#tabBody');
  const ents = structuredClone(P.entrances);
  const floorOpts = (sel) => P.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const labelOpts = (fid, sel) => `<option value="">(door point)</option>` + (P.labels[fid] || []).filter((l) => l.kind === 'entrance').map((l) => `<option ${l.id === sel ? 'selected' : ''}>${esc(l.id)}</option>`).join('');
  body.innerHTML = `
    <div class="card">
      <h2>Entrances</h2>
      <p class="muted small">Entrances connect the outdoor map to the building: at least two need real coordinates so the floors are placed correctly on campus. Place door points in the Plan editor (Entrance tool); "start at" picks the vestibule label where routes begin.</p>
      <table><thead><tr><th>Name</th><th>Floor</th><th>Door x, y (plan px)</th><th>Start at</th><th>Latitude</th><th>Longitude</th><th></th></tr></thead>
      <tbody id="entRows"></tbody></table>
      <div class="row end" style="margin-top:12px"><button class="btn primary" id="saveEnt">Save entrances</button></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Coordinates from OpenStreetMap</h2>
      <p class="muted small">Looks up the building's public outline and tagged entrances. Only the OSM ID is sent; no schematic data leaves this machine.</p>
      <div class="row"><input id="osmWay" placeholder="OSM way id" value="${esc(P.osm_way || '')}"><button class="btn" id="osmGo">Look up</button></div>
      <div id="osmOut" style="margin-top:12px"></div>
    </div>`;
  function rows() {
    $('#entRows').innerHTML = ents.map((e, i) => `
      <tr data-i="${i}">
        <td><input data-k="name" value="${esc(e.name)}"></td>
        <td><select data-k="floor">${floorOpts(e.floor)}</select></td>
        <td class="row" style="flex-wrap:nowrap"><input data-k="x" type="number" value="${e.x}" style="width:80px"><input data-k="y" type="number" value="${e.y}" style="width:80px"></td>
        <td><select data-k="label">${labelOpts(e.floor, e.label)}</select></td>
        <td><input data-k="lat" type="number" step="any" value="${e.lat ?? ''}"></td>
        <td><input data-k="lon" type="number" step="any" value="${e.lon ?? ''}"></td>
        <td><button class="btn sm danger" data-del>✕</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">No entrances yet. Add them with the Entrance tool in the Plan editor.</td></tr>';
    $('#entRows').querySelectorAll('[data-k]').forEach((el) => (el.onchange = () => {
      const e = ents[el.closest('tr').dataset.i];
      const k = el.dataset.k;
      e[k] = ['x', 'y'].includes(k) ? Number(el.value) : ['lat', 'lon'].includes(k) ? (el.value === '' ? null : Number(el.value)) : el.value || undefined;
      if (k === 'floor') rows();
    }));
    $('#entRows').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { ents.splice(b.closest('tr').dataset.i, 1); rows(); }));
  }
  rows();
  $('#saveEnt').onclick = guard(async () => { await save({ entrances: ents }); toast('Entrances saved'); });
  $('#osmGo').onclick = guard(async () => {
    const way = Number($('#osmWay').value);
    const r = await api(`/api/osm/building/${way}`);
    $('#osmOut').innerHTML = `
      <p><b>${esc(r.name || 'Unnamed building')}</b> · outline with ${r.footprint.length} points · ${r.entrances.length} tagged entrances</p>
      <table><thead><tr><th>OSM node</th><th>Latitude</th><th>Longitude</th><th>Copy to</th></tr></thead><tbody>
      ${r.entrances.map((o, i) => `<tr><td>${o.osm}</td><td>${o.lat}</td><td>${o.lon}</td>
        <td><select data-o="${i}"><option value="">—</option>${ents.map((e, j) => `<option value="${j}">${esc(e.name)}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>
      <div class="row end" style="margin-top:10px"><button class="btn" id="useFp">Use OSM outline for the outdoor map</button></div>`;
    $('#osmOut').querySelectorAll('[data-o]').forEach((s) => (s.onchange = () => {
      if (s.value === '') return;
      const o = r.entrances[s.dataset.o];
      Object.assign(ents[s.value], { lat: o.lat, lon: o.lon });
      rows();
      toast('Copied. Save entrances to keep it.');
    }));
    $('#useFp').onclick = guard(async () => { await save({ footprint: r.footprint, osm_way: way }); toast('Outline saved'); });
  });
}

// ----- build & publish -----
async function buildTab() {
  const body = $('#tabBody');
  const links = structuredClone(P.extra_links || []);
  body.innerHTML = `
    <div class="card">
      <div class="row"><h2 class="grow" style="margin:0">Build</h2><button class="btn primary" id="buildBtn">Build map</button></div>
      <p class="muted small">Compiles the floors into clean room shapes, a walkable grid, stair/elevator links and the georeference. The result stays private until you publish it.</p>
      <div class="log hidden" id="buildLog"></div>
      <div id="report"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Extra stair / elevator links</h2>
      <p class="muted small">Links between floors are found automatically when stairs line up. Add pairs here when they're labeled differently.</p>
      <table><thead><tr><th>From floor</th><th>Label</th><th>To floor</th><th>Label</th><th></th></tr></thead><tbody id="linkRows"></tbody></table>
      <div class="row end" style="margin-top:10px"><button class="btn sm" id="addLink">+ Add link</button><button class="btn sm primary" id="saveLinks">Save links</button></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Publish</h2>
      <p class="muted small">Publishing makes the compiled map public: room outlines, room numbers and names (except restricted rooms) and the routing grid. Schematics, plan images and OCR text are never published.</p>
      <div class="row"><button class="btn primary" id="pubBtn">Publish latest build</button><button class="btn danger" id="unpubBtn">Unpublish</button></div>
    </div>`;
  const fo = (sel) => P.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  function linkRows() {
    $('#linkRows').innerHTML = links.map(([[fa, ia], [fb, ib]], i) => `<tr data-i="${i}"><td><select data-k="0,0">${fo(fa)}</select></td><td><input data-k="0,1" value="${esc(ia)}"></td><td><select data-k="1,0">${fo(fb)}</select></td><td><input data-k="1,1" value="${esc(ib)}"></td><td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>';
    $('#linkRows').querySelectorAll('[data-k]').forEach((el) => (el.onchange = () => { const [a, b] = el.dataset.k.split(',').map(Number); links[el.closest('tr').dataset.i][a][b] = el.value; }));
    $('#linkRows').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { links.splice(b.closest('tr').dataset.i, 1); linkRows(); }));
  }
  linkRows();
  $('#addLink').onclick = () => { links.push([[P.floors[0]?.id, ''], [P.floors[1]?.id || P.floors[0]?.id, '']]); linkRows(); };
  $('#saveLinks').onclick = guard(async () => { await save({ extra_links: links }); toast('Links saved'); });
  $('#buildBtn').onclick = guard(async () => {
    $('#buildBtn').disabled = true;
    try {
      const { job } = await api(`/api/projects/${P.id}/build`, { method: 'POST' });
      $('#buildLog').classList.remove('hidden');
      const rep = await waitJob(job, $('#buildLog'));
      showReport(rep);
      toast('Build finished');
    } finally { $('#buildBtn').disabled = false; }
  });
  $('#pubBtn').onclick = guard(async () => { const r = await api(`/api/projects/${P.id}/publish`, { method: 'POST' }); toast(`Published · ${r.url}`); });
  $('#unpubBtn').onclick = guard(async () => { if (confirm('Take this map offline?')) { await api(`/api/projects/${P.id}/unpublish`, { method: 'POST' }); toast('Unpublished'); } });

  function showReport(rep) {
    const fl = Object.entries(rep.floors);
    $('#report').innerHTML = `
      <h3>Result</h3>
      <table><thead><tr><th>Floor</th><th>Labeled rooms</th><th>Room shapes</th><th>Walkable areas (cells)</th></tr></thead><tbody>
      ${fl.map(([fid, f]) => `<tr><td>${esc(fid)}</td><td>${f.rooms}</td><td>${f.spaces}</td><td>${f.walk_components.join(', ')}</td></tr>`).join('')}</tbody></table>
      <p class="small">${rep.links} links between floors · ${rep.georef.m_per_px} m per pixel · entrance fit errors ${rep.georef.residuals_m.join(', ')} m</p>
      <h3>Check the walkable grid</h3>
      <p class="muted small">Blue = corridors, green = rooms (walkable, discouraged), red = blocked. One big connected blue area per floor is what you want.</p>
      <div class="row">${fl.map(([fid]) => `<button class="btn sm" data-dbg="${esc(fid)}">${esc(fid)}</button>`).join('')}</div>
      <div class="debug" style="margin-top:10px"><img id="dbgImg" alt="Build preview"></div>`;
    $('#report').querySelectorAll('[data-dbg]').forEach((b) => (b.onclick = guard(async () => {
      const r = await api(`/api/projects/${P.id}/debug/${b.dataset.dbg}.png`, { raw: true });
      $('#dbgImg').src = URL.createObjectURL(await r.blob());
    })));
    $('#report').querySelector('[data-dbg]')?.click();
  }
}

// ---------------- campuses ----------------
async function campusesPage() {
  const list = await api('/api/campuses');
  main.innerHTML = `
    <div class="page-head"><div class="grow"><p class="eyebrow">Outdoor 3D layer</p><h1>Campuses</h1></div></div>
    <div class="grid">${list.map((c) => `
      <div class="tile" data-id="${esc(c.id)}">
        <div class="row"><b class="grow">${esc(c.name)}</b>${c.published ? '<span class="pill live">Live</span>' : '<span class="pill">Draft</span>'}</div>
        <div class="meta">${esc(c.id)} · OSM boundary ${c.boundary_way}${c.fetched ? '' : ' · not fetched'}</div>
      </div>`).join('') || '<p class="muted">No campuses yet.</p>'}</div>
    <div class="card" style="margin-top:18px;max-width:640px">
      <h2>New campus</h2>
      <p class="muted small">The campus layer comes from public OpenStreetMap data inside the campus boundary (an OSM way tagged amenity=university).</p>
      <form id="newC">
        <div class="row"><label class="grow">Name<input name="name" placeholder="George Mason University – Fairfax" required></label><label>ID<input name="id" placeholder="gmu" required></label></div>
        <label>Boundary OSM way ID<input name="boundary_way" inputmode="numeric" placeholder="337509448" required></label>
        <div class="row end" style="margin-top:12px"><button class="btn primary">Create campus</button></div>
      </form>
    </div>`;
  main.querySelectorAll('.tile').forEach((t) => (t.onclick = () => (location.hash = `campus/${t.dataset.id}`)));
  $('#newC').onsubmit = guard(async (e) => {
    e.preventDefault();
    const c = await api('/api/campuses', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    location.hash = `campus/${c.id}`;
  });
}

async function campusPage(cid) {
  const c = await api(`/api/campuses/${cid}`);
  const projects = await api('/api/projects');
  const hints = c.hints || { dorms: [], athletics: [], levels: {} };
  const indoor = Object.entries(c.indoor || {});
  main.innerHTML = `
    <div class="page-head"><div class="grow"><p class="eyebrow"><a href="#campuses">Campuses</a> / ${esc(c.id)}</p><h1>${esc(c.name)}</h1></div>
      <button class="btn" id="fetchBtn">Fetch from OpenStreetMap</button><button class="btn" id="baseBtn">Download basemap</button><button class="btn primary" id="pubC">Publish campus</button></div>
    <div class="log hidden" id="cLog"></div>
    <div class="card"><h2>Status</h2><p class="small">${c.stats ? `Buildings ${esc(JSON.stringify(c.stats.buildings))} · areas ${esc(JSON.stringify(c.stats.areas))}` : 'Not published yet.'}</p></div>
    <div class="card" style="margin-top:14px">
      <h2>Indoor maps</h2>
      <p class="muted small">Link a campus building (OSM way ID) to one of your buildings. Only published buildings get linked when you publish the campus.</p>
      <table><thead><tr><th>OSM way ID</th><th>Building</th><th></th></tr></thead><tbody id="inRows"></tbody></table>
      <div class="row end" style="margin-top:10px"><button class="btn sm" id="addIn">+ Add</button></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Categories & heights</h2>
      <p class="muted small">OSM rarely says which buildings are dorms. List them by exact name; same for athletics. Floor counts (name: floors) make the 3D shells taller or shorter.</p>
      <label>Residence halls (one per line)<textarea id="hDorms" rows="6">${esc((hints.dorms || []).join('\n'))}</textarea></label>
      <label>Arena & athletics buildings (one per line)<textarea id="hAth" rows="4">${esc((hints.athletics || []).join('\n'))}</textarea></label>
      <label>Floor counts (one per line, "Name: 5")<textarea id="hLv" rows="5">${esc(Object.entries(hints.levels || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea></label>
      <label>Food spot floors (one per line, "Starbucks@Johnson Center: 0")<textarea id="hFood" rows="3">${esc(Object.entries(hints.food_levels || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea></label>
      <div class="row end" style="margin-top:10px"><button class="btn primary" id="saveC">Save</button></div>
    </div>`;
  function inRows() {
    $('#inRows').innerHTML = indoor.map(([way, bid], i) => `<tr data-i="${i}"><td><input data-k="0" value="${esc(way)}"></td><td><select data-k="1">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === bid ? 'selected' : ''}>${esc(p.name)}${p.published ? '' : ' (not published)'}</option>`).join('')}</select></td><td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">None.</td></tr>';
    $('#inRows').querySelectorAll('[data-k]').forEach((el) => (el.onchange = () => (indoor[el.closest('tr').dataset.i][el.dataset.k] = el.value)));
    $('#inRows').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { indoor.splice(b.closest('tr').dataset.i, 1); inRows(); }));
  }
  inRows();
  $('#addIn').onclick = () => { indoor.push(['', projects[0]?.id || '']); inRows(); };
  const saveC = () => api(`/api/campuses/${cid}`, { method: 'PUT', body: {
    indoor: Object.fromEntries(indoor.filter(([w]) => w)),
    hints: {
      ...hints,
      dorms: $('#hDorms').value.split('\n').map((s) => s.trim()).filter(Boolean),
      athletics: $('#hAth').value.split('\n').map((s) => s.trim()).filter(Boolean),
      levels: pairs($('#hLv').value),
      food_levels: pairs($('#hFood').value),
    } } });
  // "Name: 5" lines -> {Name: 5} (splits on the last colon, so names may contain colons)
  function pairs(text) {
    return Object.fromEntries(text.split('\n').map((s) => [s.slice(0, s.lastIndexOf(':')).trim(), Number(s.slice(s.lastIndexOf(':') + 1))])
      .filter(([k, v]) => k && Number.isFinite(v)));
  }
  $('#saveC').onclick = guard(async () => { await saveC(); toast('Saved'); });
  $('#fetchBtn').onclick = guard(async () => {
    $('#cLog').classList.remove('hidden');
    const { job } = await api(`/api/campuses/${cid}/fetch`, { method: 'POST' });
    await waitJob(job, $('#cLog'));
    toast('Campus data downloaded');
  });
  $('#baseBtn').onclick = guard(async () => {
    $('#cLog').classList.remove('hidden');
    const { job } = await api(`/api/campuses/${cid}/basemap`, { method: 'POST' });
    const r = await waitJob(job, $('#cLog'));
    toast(`Basemap saved: ${r.tiles} tiles, ${r.mb} MB. The public map now draws from your server.`);
  });
  $('#pubC').onclick = guard(async () => {
    await saveC();
    const r = await api(`/api/campuses/${cid}/publish`, { method: 'POST' });
    toast(`Published (${Object.keys(r.indoor).length} indoor map${Object.keys(r.indoor).length === 1 ? '' : 's'})`);
    campusPage(cid);
  });
}

boot();
