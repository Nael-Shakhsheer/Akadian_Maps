// Talks to the routing worker. Falls back to routing on the main thread if workers aren't available.
import { Router } from './router.js';
import { decodeRle } from './building.js';

export class IndoorRouting {
  constructor(url, building) {
    this.pending = new Map();
    this.nextId = 1;
    this.building = building;
    try {
      this.worker = new Worker(new URL('./route-worker.js', import.meta.url), { type: 'module' });
      this.ready = new Promise((resolve, reject) => {
        this.worker.onmessage = ({ data }) => {
          if (data.type === 'ready') return resolve();
          const p = this.pending.get(data.id);
          if (!p) return;
          this.pending.delete(data.id);
          data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
        };
        this.worker.onerror = (e) => reject(e);
      });
      this.worker.postMessage({ type: 'init', url: new URL(url, location.href).href });
      this.ready.catch(() => this.fallback());
    } catch {
      this.fallback();
    }
  }

  fallback() {
    this.worker?.terminate();
    this.worker = null;
    const b = this.building, n = b.grid.w * b.grid.h;
    for (const f of b.floors) if (!f.cells && f.rle) f.cells = decodeRle(f.rle, n);
    this.router = new Router(b);
    this.ready = Promise.resolve();
  }

  async ask(msg) {
    await this.ready;
    if (!this.worker) return this.local(msg);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  local(msg) {
    const r = this.router, b = this.building;
    const goal = r.snap(msg.floor, msg.label), opts = { stepFree: msg.stepFree };
    if (msg.type === 'entrances') return b.entrances.map((e) => r.route(r.snap(e.floor, e.start), goal, opts));
    return r.route(r.snap(msg.from.floor, msg.from.start), goal, opts);
  }

  /** Indoor legs from every entrance to a room (array, in b.entrances order). */
  fromEntrances(room, stepFree) {
    return this.ask({ type: 'entrances', floor: room.floor, label: room.label, stepFree });
  }

  /** Indoor legs from one entrance to a room. */
  fromEntrance(entrance, room, stepFree) {
    return this.ask({ type: 'one', from: { floor: entrance.floor, start: entrance.start }, floor: room.floor, label: room.label, stepFree });
  }
}
