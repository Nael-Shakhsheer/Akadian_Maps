// 3D model of any campus building from its outline: stacked glowing floors at true scale.
// Buildings with a full indoor map use IndoorView instead; this is for everything else (and parking decks).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { THEME } from './indoor3d.js';

const LEVEL_H = 3.8;  // metres per floor (true scale)
const SLAB = 0.3;

export class ShellView {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.style.position = 'relative';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEME.bg);
    this.scene.fog = new THREE.Fog(THEME.bg, 260, 600);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.calm = matchMedia('(prefers-reduced-motion: reduce)').matches; // respect the OS "reduce motion" setting
    Object.assign(this.controls, { enableDamping: true, maxPolarAngle: Math.PI * 0.49, minDistance: 8, maxDistance: 600,
      autoRotate: !this.calm, autoRotateSpeed: 0.6 });
    r.domElement.addEventListener('pointerdown', () => (this.controls.autoRotate = false));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.3));
    const sun = new THREE.DirectionalLight(0xfff1e0, 1.1);
    sun.position.set(-80, 160, 60);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(800, 80, ...THEME.grid);
    grid.position.y = -0.05;
    this.scene.add(grid);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.6));
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    this.time = 0;
    new ResizeObserver(() => this.resize()).observe(container);
    r.setAnimationLoop(() => this.tick());
  }

  /**
   * building: { ring: [[lon, lat]...], holes, h, name }
   * opts: { color, deck, levels, pins: [{ lat, lon, level, label, kind }] }
   */
  show(building, { color = THEME.accent, deck = false, levels = null, pins = [] } = {}) {
    this.clear();
    const ring = (this.ring = building.ring);
    const n = ring.length - 1;
    this.lon0 = ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n;
    this.lat0 = ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n;
    this.kx = 111320 * Math.cos(this.lat0 * Math.PI / 180);
    this.levels = levels || Math.max(1, Math.round(building.h / LEVEL_H));
    this.color = new THREE.Color(color);
    const glow = (k) => this.color.clone().multiplyScalar(k);

    // OSM rings repeat their first point at the end; the triangulator wants it once
    const open = (r) => (r.length > 3 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r);
    const shape = new THREE.Shape(open(ring).map(([lon, lat]) => new THREE.Vector2(...this.xy(lon, lat))));
    for (const h of building.holes || []) shape.holes.push(new THREE.Path(open(h).map(([lon, lat]) => new THREE.Vector2(...this.xy(lon, lat)))));
    const outline = (y) => {
      const pts = ring.map(([lon, lat]) => { const [x, z] = this.xz(lon, lat); return new THREE.Vector3(x, y, z); });
      return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: glow(1), transparent: true, toneMapped: false }));
    };

    this.floors = [];
    for (let i = 0; i < this.levels; i++) {
      const g = new THREE.Group();
      g.position.y = i * LEVEL_H;
      // translucent tinted glass floors, so every level's glowing rim shows through the ones above
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(THEME.walk).lerp(this.color, 0.18), roughness: 0.5, metalness: 0.2,
          transparent: true, opacity: 0.55, depthWrite: false }));
      slab.geometry.rotateX(-Math.PI / 2);
      g.add(slab);
      const rim = outline(SLAB + 0.02);
      rim.material.color = glow(i === 0 ? 2.4 : 1.4);
      g.add(rim);
      // floor tag on the side
      const el = document.createElement('div');
      el.className = 'tag floor-tag';
      el.textContent = i === 0 ? (deck ? 'L1' : 'G') : `L${i + 1}`;
      const tag = new CSS2DObject(el);
      const [tx, tz] = this.extremeWest();
      tag.position.set(tx - 4, SLAB, tz);
      g.add(tag);
      this.group.add(g);
      this.floors.push({ group: g, mats: [slab.material, rim.material], tag: el, fade: 1, target: 1 });
    }

    const H = this.levels * LEVEL_H;
    if (deck) {
      // open parking deck: pillars at the corners instead of walls, plus a roof rim
      const pillarMat = new THREE.MeshStandardMaterial({ color: 0x3a3f49, roughness: 0.8 });
      for (const [lon, lat] of ring.slice(0, n)) {
        const [x, z] = this.xz(lon, lat);
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, H, 0.6), pillarMat);
        p.position.set(x, H / 2, z);
        this.group.add(p);
      }
    } else {
      // glass curtain wall + glowing roof edge
      const wall = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({ color: this.color, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
      wall.geometry.rotateX(-Math.PI / 2);
      this.group.add(wall);
      this.wallMat = wall.material;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry, 30),
        new THREE.LineBasicMaterial({ color: glow(0.9), transparent: true, opacity: 0.6, toneMapped: false }));
      this.group.add(edges);
    }
    this.group.add(outline(H + 0.05));

    // pins: food inside (labelled dots); your car (a glowing model, no label)
    for (const p of pins) {
      const lvl = Math.min(this.levels - 1, Math.max(0, (p.level ?? 1) - 1));
      const [x, z] = this.xz(p.lon, p.lat);
      if (p.kind === 'car') {
        const car = makeCar();
        car.position.set(x, SLAB, z);
        car.rotation.y = ((p.heading || 0) * Math.PI) / 180;
        this.floors[lvl].group.add(car);
        this.carGlow = car.userData.glow;
        this.car = { obj: car, level: lvl };
        continue;
      }
      const y = lvl * LEVEL_H + SLAB + 0.6;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(p.kind === 'car' ? 0.9 : 0.6, 20, 14),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color || '#ffffff').multiplyScalar(2.5), toneMapped: false }));
      dot.position.set(x, y, z);
      this.floors[lvl].group.add(dot);
      dot.position.y -= lvl * LEVEL_H;
      const el = document.createElement('div');
      el.className = `tag ${p.kind === 'car' ? 'dest' : 'pin'}`;
      el.innerHTML = p.label;
      const tag = new CSS2DObject(el);
      tag.position.set(x, y - lvl * LEVEL_H + 2.2, z);
      this.floors[lvl].group.add(tag);
      this.floors[lvl].pins = (this.floors[lvl].pins || []).concat(el);
    }

    // frame the whole building
    const box = new THREE.Box3().setFromObject(this.group);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const r = (Math.max(size.x, size.z, 30) * 0.9 + size.y) * 1.2;
    this.controls.target.copy(c);
    // three-quarter view, low enough to see the floors stack
    this.camera.position.set(c.x - r * 0.6, c.y + r * 0.42, c.z + r * 0.8);
    this.controls.autoRotate = !this.calm;
    this.controls.update();
    this.setLevel('all');
  }

  // 'all' or a level index (0-based): other floors fade so one level stands out
  setLevel(mode) {
    this.floors.forEach((f, i) => {
      f.target = mode === 'all' ? 1 : i === mode ? 1 : i > mode ? 0.04 : 0.25;
    });
    if (this.wallMat) this.wallMat.opacity = mode === 'all' ? 0.1 : 0.03;
  }

  clear() {
    for (const o of [...this.group.children]) {
      o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose?.(); if (c.isCSS2DObject) c.element.remove(); });
      this.group.remove(o);
    }
    this.floors = [];
    this.wallMat = null;
    this.carGlow = null;
    this.car = null;
  }

  // isolate the car's level and glide in close to it
  focusCar() {
    if (!this.car) return;
    this.setLevel(this.car.level);
    this.group.updateMatrixWorld(true);
    const p = this.car.obj.getWorldPosition(new THREE.Vector3());
    const d = 42;
    this.controls.autoRotate = false;
    this.fly = { t: 0, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toPos: p.clone().add(new THREE.Vector3(-0.6, 0.55, 0.75).normalize().multiplyScalar(d)), toTarget: p };
  }

  xz(lon, lat) { return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * 110540]; }
  xy(lon, lat) { const [x, z] = this.xz(lon, lat); return [x, -z]; } // shape plane, rotated flat later
  // where to hang the floor tags: just off the building's west-most corner
  extremeWest() {
    let best = null;
    for (const [lon, lat] of this.ring) {
      const p = this.xz(lon, lat);
      if (!best || p[0] < best[0]) best = p;
    }
    return best;
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
    if (!this.container.offsetParent) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    for (const f of this.floors) {
      f.fade += (f.target - f.fade) * Math.min(1, dt * 6);
      for (const m of f.mats) m.opacity = (m === f.mats[0] ? 0.55 : 1) * f.fade;
      f.group.visible = f.fade > 0.03;
      f.tag.style.opacity = f.fade;
      for (const p of f.pins || []) p.style.display = f.fade > 0.5 ? '' : 'none';
    }
    this.time += dt;
    if (this.carGlow) this.carGlow.opacity = 0.55 + 0.3 * Math.sin(this.time * 3);
    if (this.fly) {
      this.fly.t = this.calm ? 1 : Math.min(1, this.fly.t + dt / 1.4);
      const e = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.fromPos, this.fly.toPos, e);
      this.controls.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, e);
      if (this.fly.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}

// ---------- the car ----------
const CAR_ORANGE = 0xf0a04a;
const CAR_SCALE = 1.3; // a touch larger than life so it reads from across a deck

/** A low-poly car, nose along +x, sitting on y = 0, glowing orange (blooms with the scene). */
export function makeCar() {
  const car = new THREE.Group();
  const glowLine = new THREE.LineBasicMaterial({ color: new THREE.Color(CAR_ORANGE).multiplyScalar(3), toneMapped: false });
  const add = (geo, mat, edges = true) => {
    const m = new THREE.Mesh(geo, mat);
    car.add(m);
    if (edges) car.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), glowLine));
    return m;
  };
  const paint = new THREE.MeshStandardMaterial({ color: CAR_ORANGE, emissive: CAR_ORANGE, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x3a2410, emissive: CAR_ORANGE, emissiveIntensity: 0.25, roughness: 0.1, metalness: 0.6 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.9 });
  const light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9c8).multiplyScalar(3), toneMapped: false });

  // body
  add(new THREE.BoxGeometry(4.4, 0.72, 1.8).translate(0, 0.7, 0), paint);
  // cabin: a trapezoid side profile pushed out across the width
  const prof = new THREE.Shape([new THREE.Vector2(-1.35, 0), new THREE.Vector2(1.05, 0), new THREE.Vector2(0.55, 0.62), new THREE.Vector2(-0.95, 0.62)]);
  add(new THREE.ExtrudeGeometry(prof, { depth: 1.56, bevelEnabled: false }).translate(-0.15, 1.06, -0.78), glass);
  // wheels
  for (const [x, z] of [[1.35, 0.86], [1.35, -0.86], [-1.35, 0.86], [-1.35, -0.86]]) {
    const w = add(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18).rotateX(Math.PI / 2), tyre, false);
    w.position.set(x, 0.36, z);
  }
  // headlights and tail lights
  for (const z of [0.6, -0.6]) {
    add(new THREE.BoxGeometry(0.06, 0.16, 0.36).translate(2.21, 0.82, z), light, false);
    add(new THREE.BoxGeometry(0.06, 0.14, 0.36).translate(-2.21, 0.82, z),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3b30).multiplyScalar(2.5), toneMapped: false }), false);
  }
  // soft pulsing glow on the ground underneath
  const glowMat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: CAR_ORANGE, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(9, 6), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.04;
  car.add(glow);
  car.userData.glow = glowMat;
  car.scale.setScalar(CAR_SCALE);
  return car;
}

let _radial = null;
function radialTexture() {
  if (_radial) return _radial;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _radial = new THREE.CanvasTexture(c);
  return _radial;
}
