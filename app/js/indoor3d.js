// Three.js view of the stacked floors: clean extruded rooms, glowing outlines, animated route.
// Horizontal geometry is true to scale (plan pixels × metres-per-pixel); floors are spread apart vertically for clarity.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { floorShort } from './building.js';

// Memex palette: charcoal surfaces, warm orange light.
export const THEME = {
  bg: 0x16181d,
  grid: [0x2a2d34, 0x1e2026],
  slab: 0x1f2228,
  walk: 0x2a2e36,
  room: 0x262a32,
  shaft: 0x15171b,
  accent: 0xf0a04a,
  hover: 0xffd29a,
};
const GLOW = (k) => new THREE.Color(THEME.accent).multiplyScalar(k); // >1 = blooms

// Render resolution: full sharpness on desktops, capped on phones where 3x screens make the glow pass costly.
export function renderScale() {
  return Math.min(devicePixelRatio, Math.min(innerWidth, innerHeight) < 700 ? 1.5 : 2);
}

const FLOOR_GAP = 12;   // metres between floors in the exploded view (real floor-to-floor is ~4.5 m)
const SLAB_T = 0.35;
const ROOM_H = 1.1;     // cut-away wall height so you can see into the floor
const ROUTE_Y = 0.5;

export class IndoorView {
  constructor(container, b, { onSelect } = {}) {
    this.b = b;
    this.onSelect = onSelect;
    this.container = container;
    this.cx = b.texture.x0 + b.texture.w / 2;
    this.cy = b.texture.y0 + b.texture.h / 2;
    this.span = Math.max(b.texture.w, b.texture.h) * b.mPerPx; // metres: camera distances scale with the building
    const lv = b.floors.map((f) => f.level);
    this.midY = (Math.min(...lv) + Math.max(...lv)) / 2 * FLOOR_GAP;
    this.roomBySpace = new Map(b.rooms.filter((r) => r.space !== undefined).map((r) => [`${r.floor}:${r.space}`, r]));

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(renderScale());
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.style.position = 'relative';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEME.bg);
    this.scene.fog = new THREE.Fog(THEME.bg, 220, 520);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
    this.camera.position.set(-90, 120, 140);
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, { enableDamping: true, maxPolarAngle: Math.PI * 0.48, minDistance: 12, maxDistance: 420 });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xfff1e0, 1.2);
    sun.position.set(-80, 160, 60);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(700, 70, ...THEME.grid);
    grid.position.y = -SLAB_T - 0.4;
    this.scene.add(grid);

    this.floors = b.floors.map((f) => this.buildFloor(f));
    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);
    this.hoverGroup = new THREE.Group();
    this.scene.add(this.hoverGroup);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.pointer = null;
    r.domElement.addEventListener('pointermove', (e) => { this.pointer = this.ndc(e); this.pointerMoved = true; });
    r.domElement.addEventListener('pointerleave', () => { this.pointer = null; this.setHover(null); });
    r.domElement.addEventListener('pointerdown', (e) => (this.downAt = [e.clientX, e.clientY]));
    r.domElement.addEventListener('pointerup', (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 6) return;
      const hit = this.pick(this.ndc(e));
      if (hit?.room) this.onSelect?.(hit.room);
    });

    this.clock = new THREE.Clock();
    this.time = 0;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setFloorMode('all', true);
    r.setAnimationLoop(() => this.tick());
  }

  // plan pixel -> world x/z (y is up)
  w(x, y) { return [(x - this.cx) * this.b.mPerPx, (y - this.cy) * this.b.mPerPx]; }
  floorY(fid) { return this.b.floors[this.b.floorIndex[fid]].level * FLOOR_GAP; }
  vecs(flatArr) {
    const v = [];
    for (let i = 0; i < flatArr.length; i += 2) { const [X, Z] = this.w(flatArr[i], flatArr[i + 1]); v.push(new THREE.Vector2(X, -Z)); }
    return v;
  }
  shapes(polys) {
    return polys.map((p) => {
      const s = new THREE.Shape(this.vecs(p.o));
      for (const h of p.h || []) s.holes.push(new THREE.Path(this.vecs(h)));
      return s;
    });
  }
  // closed outlines as one LineSegments geometry at height y
  outline(loops, y) {
    const pos = [];
    for (const flatArr of loops) {
      const n = flatArr.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [x1, z1] = this.w(flatArr[2 * i], flatArr[2 * i + 1]);
        const [x2, z2] = this.w(flatArr[2 * j], flatArr[2 * j + 1]);
        pos.push(x1, y, z1, x2, y, z2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }
  lineMat(k, opacity = 1) {
    return new THREE.LineBasicMaterial({ color: GLOW(k), transparent: true, opacity, toneMapped: false });
  }

  buildFloor(f) {
    const g = new THREE.Group();
    g.position.y = f.level * FLOOR_GAP;
    const mats = [];
    const add = (obj, baseOpacity) => { obj.material.userData.base = baseOpacity; mats.push(obj.material); g.add(obj); return obj; };
    const flatUp = (geo) => { geo.rotateX(-Math.PI / 2); return geo; };

    // glass slab with the atrium voids cut out, rim glowing
    const slab = new THREE.ExtrudeGeometry(this.shapes(f.slab), { depth: SLAB_T, bevelEnabled: false });
    add(new THREE.Mesh(flatUp(slab).translate(0, -SLAB_T, 0),
      new THREE.MeshStandardMaterial({ color: THEME.slab, roughness: 0.6, metalness: 0.2, transparent: true })), 0.92);
    add(new THREE.LineSegments(this.outline(f.slab.flatMap((p) => [p.o, ...p.h]), 0.02), this.lineMat(2.6)), 1);

    // corridors and lobbies: a slightly lighter floor surface
    const walk = new THREE.ShapeGeometry(this.shapes(f.walk));
    add(new THREE.Mesh(flatUp(walk).translate(0, 0.02, 0),
      new THREE.MeshStandardMaterial({ color: THEME.walk, roughness: 0.9, transparent: true })), 1);

    // rooms: one merged mesh; each vertex remembers its space index for picking
    const roomGeos = [], shaftGeos = [], roomLoops = [];
    f.spaces.forEach((s, i) => {
      const geo = flatUp(new THREE.ExtrudeGeometry(new THREE.Shape(this.vecs(s.o)), { depth: ROOM_H, bevelEnabled: false }));
      if (s.k === 'shaft') { shaftGeos.push(geo); return; }
      geo.setAttribute('sid', new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count).fill(i), 1));
      roomGeos.push(geo);
      roomLoops.push(s.o);
    });
    const rooms = add(new THREE.Mesh(mergeGeometries(roomGeos),
      new THREE.MeshStandardMaterial({ color: THEME.room, roughness: 0.75, metalness: 0.1, transparent: true })), 0.96);
    rooms.userData.floor = f.id;
    if (shaftGeos.length) {
      add(new THREE.Mesh(mergeGeometries(shaftGeos), new THREE.MeshStandardMaterial({ color: THEME.shaft, transparent: true })), 1);
    }
    add(new THREE.LineSegments(this.outline(roomLoops, ROOM_H + 0.01), this.lineMat(0.75)), 0.7);

    const tag = document.createElement('div');
    tag.className = 'tag floor-tag';
    tag.textContent = floorShort(f);
    const tagObj = new CSS2DObject(tag);
    const t = this.b.texture;
    const [lx, lz] = this.w(t.x0, t.y0 + t.h * 0.42);
    tagObj.position.set(lx - 8, 0, lz);
    g.add(tagObj);

    this.scene.add(g);
    return { id: f.id, f, group: g, mats, rooms, tag, y: g.position.y, fade: 1, targetFade: 1 };
  }

  // 'route' focuses floors on the route, a floor id isolates one floor, 'all' shows everything
  setFloorMode(mode, instant = false) {
    this.mode = mode;
    const walked = new Set((this.legs || []).filter((l) => l.pts && (l.meters > 3 || l === this.legs.at(-1))).map((l) => l.floor));
    const top = walked.size ? Math.max(...[...walked].map((f) => this.b.floorIndex[f])) : this.floors.length - 1;
    this.floors.forEach((fl, i) => {
      let fade = 1;
      if (mode === 'route') fade = i > top ? 0 : walked.has(fl.id) ? (i === top && walked.size > 1 ? 0.75 : 1) : 0.18;
      else if (mode !== 'all') fade = fl.id === mode ? 1 : 0;
      fl.targetFade = fade;
      if (instant) fl.fade = fade;
    });
    for (const o of this.routeGroup.children) {
      const f = o.userData.floor;
      o.userData.hidden = !(mode === 'route' || mode === 'all' || !f || f === mode);
    }
    if (mode !== 'route' && mode !== 'all') {
      const fl = this.floors[this.b.floorIndex[mode]];
      this.flyTo(new THREE.Vector3(0, fl.y, 0), Math.max(55, this.span * 1.08));
    } else if (mode === 'all' && !this.legs) {
      this.flyTo(new THREE.Vector3(0, this.midY, 0), Math.max(70, this.span * 1.5));
    } else if (this.pathPts) this.frame(this.pathPts);
  }

  showRoute(legs, dest, entranceName) {
    this.clearRoute();
    this.legs = legs;
    const pts = [];
    for (const leg of legs) if (leg.pts) {
      const y = this.floorY(leg.floor) + ROUTE_Y;
      for (const [x, z] of leg.pts) { const [X, Z] = this.w(x, z); pts.push(new THREE.Vector3(X, y, Z)); }
    }
    this.pathPts = pts;

    // the route: one tube through every floor, with light flowing along it
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 0.01) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    const len = path.getLength();
    this.routeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLen: { value: len }, uColor: { value: new THREE.Color(THEME.accent) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime, uLen; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float d = vUv.x * uLen;
          float wave = pow(0.5 + 0.5 * sin(d * 0.35 - uTime * 5.0), 8.0);
          gl_FragColor = vec4(uColor * (1.6 + 3.5 * wave), 1.0);
        }`,
      toneMapped: false,
    });
    this.routeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(64, Math.round(len * 3)), 0.32, 10, false), this.routeMat));

    // destination: the room itself lights up
    const space = dest.space !== undefined ? this.b.floors[this.b.floorIndex[dest.floor]].spaces[dest.space].o : dest.poly.flat();
    const dy = this.floorY(dest.floor);
    const destGeo = new THREE.ExtrudeGeometry(new THREE.Shape(this.vecs(space)), { depth: ROOM_H + 0.25, bevelEnabled: false });
    destGeo.rotateX(-Math.PI / 2);
    this.destMat = new THREE.MeshStandardMaterial({ color: THEME.accent, emissive: THEME.accent, emissiveIntensity: 0.3, transparent: true, opacity: 0.6 });
    const destMesh = new THREE.Mesh(destGeo, this.destMat);
    destMesh.position.y = dy + 0.02;
    destMesh.userData.floor = dest.floor;
    this.routeGroup.add(destMesh);
    const destLine = new THREE.LineSegments(this.outline([space], dy + ROOM_H + 0.3), this.lineMat(4));
    destLine.userData.floor = dest.floor;
    this.routeGroup.add(destLine);
    const [lx, lz] = this.w(...dest.label);
    this.addTag(`<b>${dest.kind === 'room' ? dest.id : ''}</b> ${dest.title}`, lx, dy + ROOM_H + 2.5, lz, dest.floor, 'dest');

    // start: pulsing ring at the entrance
    const s = pts[0];
    this.startRing = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.5, 48), new THREE.MeshBasicMaterial({ color: GLOW(2.5), toneMapped: false, transparent: true, side: THREE.DoubleSide }));
    this.startRing.rotation.x = -Math.PI / 2;
    this.startRing.position.set(s.x, s.y - ROUTE_Y + 0.08, s.z);
    this.startRing.userData.floor = legs.find((l) => l.pts).floor;
    this.routeGroup.add(this.startRing);
    this.addTag(entranceName, s.x, s.y + 2.2, s.z, this.startRing.userData.floor, 'start');

    // small floor-change hints where the route goes up or down
    let lastAt = null;
    for (const leg of legs) if (leg.transition) {
      if (lastAt && Math.hypot(leg.at[0] - lastAt[0], leg.at[1] - lastAt[1]) < 30) { lastAt = leg.at; continue; }
      lastAt = leg.at;
      const [X, Z] = this.w(...leg.at);
      const end = legs.slice(legs.indexOf(leg)).filter((l) => l.transition).reduce((a, l) => (Math.hypot(l.at[0] - leg.at[0], l.at[1] - leg.at[1]) < 30 ? l : a), leg);
      const up = this.b.floorIndex[end.to] > this.b.floorIndex[leg.from];
      const name = floorShort(this.b.floors[this.b.floorIndex[end.to]]);
      // sits where the route arrives, so it never collides with the start label
      this.addTag(`${leg.kind === 'elevator' ? 'Elevator' : 'Stairs'} ${up ? '↑' : '↓'} ${name}`, X, this.floorY(end.to) + 2.2, Z, end.to, 'hint');
    }

    // a bright comet that walks the route
    this.walker = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(3), toneMapped: false }));
    this.routeGroup.add(this.walker);
    this.segLens = [];
    this.walkLen = 0;
    for (let i = 1; i < pts.length; i++) { const d = pts[i].distanceTo(pts[i - 1]); this.segLens.push(d); this.walkLen += d; }
    this.walkT = 0;

    this.setFloorMode('route');
  }

  addTag(html, x, y, z, floor, cls) {
    const el = document.createElement('div');
    el.className = `tag ${cls}`;
    el.innerHTML = html;
    const o = new CSS2DObject(el);
    o.position.set(x, y, z);
    o.userData = { floor };
    this.routeGroup.add(o);
  }

  clearRoute() {
    for (const o of [...this.routeGroup.children]) {
      o.geometry?.dispose();
      o.material?.dispose?.();
      if (o.isCSS2DObject) o.element.remove();
      this.routeGroup.remove(o);
    }
    this.walker = this.startRing = this.pathPts = this.legs = null;
  }

  // ---------- picking ----------
  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  pick(p) {
    if (!p) return null;
    this.raycaster.setFromCamera(p, this.camera);
    const meshes = this.floors.filter((fl) => fl.fade > 0.5).map((fl) => fl.rooms);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const floor = hit.object.userData.floor;
    const sid = hit.object.geometry.attributes.sid.getX(hit.face.a);
    return { floor, sid, room: this.roomBySpace.get(`${floor}:${sid}`) };
  }
  setHover(hit) {
    const key = hit ? `${hit.floor}:${hit.sid}` : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    for (const o of [...this.hoverGroup.children]) { o.geometry?.dispose(); if (o.isCSS2DObject) o.element.remove(); this.hoverGroup.remove(o); }
    this.renderer.domElement.style.cursor = hit?.room ? 'pointer' : '';
    if (!hit) return;
    const fl = this.floors[this.b.floorIndex[hit.floor]];
    const o = fl.f.spaces[hit.sid].o;
    const y = fl.group.position.y + ROOM_H + 0.05;
    this.hoverGroup.add(new THREE.LineSegments(this.outline([o], y), new THREE.LineBasicMaterial({ color: new THREE.Color(THEME.hover).multiplyScalar(3), toneMapped: false })));
    const el = document.createElement('div');
    el.className = 'tag hover';
    const r = hit.room;
    el.innerHTML = r ? `<b>${r.id}</b> ${r.name || ''}<small>Select to get directions</small>` : '<small>Unlabeled space</small>';
    const lbl = new CSS2DObject(el);
    let sx = 0, sz = 0;
    for (let i = 0; i < o.length; i += 2) { sx += o[i]; sz += o[i + 1]; }
    const [X, Z] = this.w(sx / (o.length / 2), sz / (o.length / 2));
    lbl.position.set(X, y + 2, Z);
    this.hoverGroup.add(lbl);
  }

  // ---------- camera ----------
  frame(pts) {
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.flyTo(c, Math.max(size.x, size.z, 40) * 1.1 + size.y * 1.3);
  }
  flyTo(target, dist) {
    const dir = new THREE.Vector3(-0.42, 0.68, 0.6).normalize();
    this.fly = {
      t: 0, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toPos: target.clone().addScaledVector(dir, dist), toTarget: target.clone(),
    };
  }

  // Several buildings can share one container: only the active one is shown and rendered.
  setActive(on) {
    this.active = on;
    this.renderer.domElement.style.display = on ? '' : 'none';
    this.labels.domElement.style.display = on ? '' : 'none';
    if (!on) this.setHover(null);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    if (this.active === false || !this.container.offsetParent) return; // hidden
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;

    for (const fl of this.floors) {
      fl.fade += (fl.targetFade - fl.fade) * Math.min(1, dt * 6);
      fl.group.visible = fl.fade > 0.02;
      fl.tag.style.display = fl.fade > 0.5 ? '' : 'none';
      for (const m of fl.mats) m.opacity = m.userData.base * fl.fade;
    }
    for (const o of this.routeGroup.children) {
      const fl = o.userData.floor && this.floors[this.b.floorIndex[o.userData.floor]];
      o.visible = !o.userData.hidden && (!fl || fl.fade > 0.3);
      if (o.isCSS2DObject) o.element.style.display = o.visible ? '' : 'none';
    }
    if (this.fly) {
      this.fly.t = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, this.fly.t + dt / 1.3);
      const e = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.fromPos, this.fly.toPos, e);
      this.controls.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, e);
      if (this.fly.t >= 1) this.fly = null;
    }
    if (this.routeMat) this.routeMat.uniforms.uTime.value = this.time;
    if (this.destMat) this.destMat.emissiveIntensity = 0.3 + 0.2 * Math.sin(this.time * 3);
    if (this.startRing) { const s = 1 + 0.25 * Math.sin(this.time * 4); this.startRing.scale.set(s, s, s); }
    if (this.walker && this.walkLen > 0) {
      this.walkT = (this.walkT + dt * 10) % (this.walkLen + 15);
      let d = Math.min(this.walkT, this.walkLen), i = 0;
      while (i < this.segLens.length - 1 && d > this.segLens[i]) d -= this.segLens[i++];
      const a = this.pathPts[i], b = this.pathPts[i + 1] || a;
      this.walker.position.lerpVectors(a, b, this.segLens[i] ? d / this.segLens[i] : 0);
    }
    // hover check only when the pointer moved (not on every frame)
    if (this.pointer && !this.fly && this.pointerMoved) {
      this.pointerMoved = false;
      this.setHover(this.pick(this.pointer));
    }

    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
