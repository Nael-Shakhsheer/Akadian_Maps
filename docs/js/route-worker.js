// Indoor routing off the main thread, so picking a room never freezes the screen.
// Messages in:  { type: 'init', url }   { id, type: 'entrances', floor, label, stepFree }
//               { id, type: 'one', from: {floor, start}, floor, label, stepFree }
// Messages out: { type: 'ready' } | { id, result } | { id, error }
import { loadBuilding } from './building.js';
import { Router } from './router.js';

let b = null, router = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      b = await loadBuilding(data.url);
      router = new Router(b);
      self.postMessage({ type: 'ready' });
      return;
    }
    const goal = router.snap(data.floor, data.label);
    const opts = { stepFree: data.stepFree };
    if (data.type === 'entrances') {
      // one route per entrance; the app adds the outdoor walk and picks the best
      const result = b.entrances.map((e) => router.route(router.snap(e.floor, e.start), goal, opts));
      self.postMessage({ id: data.id, result });
    } else if (data.type === 'one') {
      self.postMessage({ id: data.id, result: router.route(router.snap(data.from.floor, data.from.start), goal, opts) });
    }
  } catch (e) {
    self.postMessage({ id: data.id, error: String(e) });
  }
};
