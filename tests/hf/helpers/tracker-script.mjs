/**
 * Scripted (no pixel work) RoiTube for MHT and finish-time unit tests: objects per frame [{x, y, S}] in stabilized px,
 * a TBD-like search over 3σ of the given prediction, and a cached z-map holding every object's peak.
 */
import { PARAMS } from '../../../dist/hf/params.js';
import { makeSourceMeta, identityTrack } from '../../../dist/hf/types.js';
import { FlightTracker, chi2 } from '../../../dist/hf/flight-tracker.js';
import { ballPath } from './tracker-scene.mjs';
import { makeLaunch, makeLog } from './tracker-drive.mjs';
import { stubFitFlight } from './tracker-stub-fit.mjs';

const T = PARAMS.track;

/**
 * Scripted tube: objects per frame [{x, y, S}] in stabilized px; a z-map with every object's peak; no pixel work.
 * record (optional array) receives every call as {call: 'plan'|'detect', i, sigma (1σ major axis, px), pred}.
 */
export function scriptTube(objectsAt, record = null) {
  const sig = c => Math.sqrt((c[0] + c[2]) / 2 + Math.hypot((c[0] - c[2]) / 2, c[1]));
  return class ScriptTube {
    constructor() { this.max = -1; }
    plan(i, p) { record?.push({ call: 'plan', i, sigma: sig(p.cov), pred: p }); return [{ rect: { x: Math.round(p.x) - 8, y: Math.round(p.y) - 8, w: 16, h: 16 }, pool: 1, purpose: 'main' }]; }
    push(i) { this.max = Math.max(this.max, i); }
    ready(i) { return this.max >= i + 1; }
    detect(i, p) {
      record?.push({ call: 'detect', i, sigma: sig(p.cov), pred: p });
      const objs = objectsAt(i), w = 41, data = new Int8Array(w * w), x0 = p.x - 20.5, y0 = p.y - 20.5;
      for (const q of objs) { const u = Math.floor(q.x - x0), v = Math.floor(q.y - y0); if (u > 0 && v > 0 && u < w - 1 && v < w - 1) data[v * w + u] = Math.min(127, Math.round(8 * q.S * 0.6)); }
      // Like a TBD search box: 3σ of the given prediction; the best score wins, the nearer one on ties.
      const S = [p.cov[0] + 0.25, p.cov[1], p.cov[2] + 0.25], c2 = q => chi2(q.x - p.x, q.y - p.y, S), inGate = objs.filter(q => c2(q) <= 9 + 4);
      const best = inGate.sort((a, b) => b.S - a.S || c2(a) - c2(b))[0];
      const observation = best ? { index: i, t: i / 30, x: best.x, y: best.y, sigma: 0.5, z: best.S, z1: best.S * 0.6, d: null, polarity: 1, src: 'tbd', flag: 'inlier' } : null;
      return { index: i, t: i / 30, observation, zmap: { index: i, t: i / 30, x0, y0, pool: 1, w, h: w, data, zScale: 8 }, score: best?.S ?? 0, threshold: 5, nullScores: [] };
    }
  };
}

/**
 * Run a FlightTracker over a scripted tube. Options: n, N (frames), d0, finish, Tracker (class, default FlightTracker),
 * ball (ballPath options), m (launch chain samples), width/height, record (array, see scriptTube), fit (fitFlight).
 */
export async function scripted(objectsAt, { n = 70, N = 110, d0 = 6, finish = true, Tracker = FlightTracker, ball = {}, m = 4, width = 720, height = 1280, record = null, fit = stubFitFlight } = {}) {
  const impact = 30, b = { impact, x0: 360, y0: 1000, vx: 2, vy: -14, g: 0.3, drag: 0.005, n, size0: 30, ...ball }, path = ballPath(b);
  const meta = makeSourceMeta({ width, height, fps: 30, frameCount: N, times: Float64Array.from({ length: N }, (_, i) => i / 30), duration: N / 30 });
  const camera = identityTrack(meta), log = makeLog(meta, camera), truth = new Map(path.map(p => [p.i, p]));
  const launch = makeLaunch({ path, impact, d0, m, address: { x: b.x0, y: b.y0 } });
  const tr = new Tracker(launch, { meta, log, impact: null, params: PARAMS }, { RoiTube: scriptTube(i => objectsAt(i, truth.get(i)), record), fitFlight: fit });
  const crop = { data: new Uint8Array(1), w: 1, h: 1, x0: 0, y0: 0, pool: 1, valid: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  let lastFrame = -1;
  for (let i = tr.window().from; i < N && !tr.done; i++) { const reqs = tr.roiRequests(i); tr.consume(i, i / 30, reqs.map(() => crop), { a: 1, b: 0, tx: 0, ty: 0 }); lastFrame = i; }
  return { tr, hyps: finish ? tr.finish() : null, truth, path, launch, meta, lastFrame };
}
