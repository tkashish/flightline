import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import { PARAMS, PARAMS_VERSION, mergeParams, scanStride } from '../dist/hf/params.js';
import {
  HFError, PROGRESS_PHASES, check, cropLuma, frameAt, simAt, validateResult, createMemorySource, makeImpact, makeFlightFit,
  makeLaunchCandidate, makeLaunchDecision, makeObservation, makeTrackHypothesis, makeCompletion, make
} from '../dist/hf/types.js';
import { analyzeClip, defaultModules, unavailableModule, MODULE_FILES } from '../dist/hf/pipeline.js';
import { instrumentedSource, ballScene, mockModules, sceneImpact, decision, defaultDecide, curveFor } from './hf/helpers/pipeline-fixtures.mjs';

v8.setFlagsFromString('--expose_gc');
const gc = (() => { try { return vm.runInNewContext('gc'); } catch { return null; } })();
const tick = () => new Promise(r => setImmediate(r));

function setup(scene, mock = {}, so = {}) {
  const m = mockModules(scene, mock);
  const source = instrumentedSource({ width: scene.width, height: scene.height, plane: scene.plane, times: scene.times, fps: scene.fps, log: m.calls, ...so });
  return { ...m, source };
}
async function run(scene, mock = {}, { source: so = {}, ...opts } = {}) {
  const s = setup(scene, mock, so), events = [];
  const result = await analyzeClip(s.source, { modules: s.modules, onProgress: p => events.push({ ...p, at: performance.now() }), ...opts });
  return { ...s, result, events };
}
function valid(r, scene) {
  const { ok, errors } = validateResult(r, { width: scene.width, height: scene.height, fps: scene.fps });
  assert.ok(ok, errors.join('\n'));
  assert.deepEqual(structuredClone(r), r);
}
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
const consumed = (list, prefix) => list.filter(c => c.startsWith(prefix)).map(c => +c.split(' ').at(-1));
const abortError = e => e?.name === 'AbortError';
const emptyAbstention = r => {
  assert.equal(r.status, 'no_reliable_track');
  assert.deepEqual(r.points, []);
  assert.deepEqual(r.observations, []);
  assert.equal(r.completion, null);
  assert.equal(r.observedFrames, 0);
  assert.equal(r.launch, null);
};
const twoBalls = (gapFrames, o = {}) => ballScene({
  n: o.n ?? 60, ...o, balls: [
    { address: { x: 135, y: 400 }, impactFrame: 30.4, vel: { x: 60, y: -600 }, acc: { x: 0, y: 800 } },
    { address: { x: 50, y: 430 }, impactFrame: 30.4 + gapFrames, vel: { x: -30, y: -500 }, acc: { x: 0, y: 700 } }
  ]
});
const bothImpacts = scene => () => [sceneImpact(scene, 0), sceneImpact(scene, 1)];

/* ---------------------------------------------------------------- end to end */

test('a clean flight is tracked end to end: normalized, valid, with the launch anchor and a completed arc', async () => {
  const scene = ballScene(), W = scene.width, H = scene.height;
  const { result: r, state } = await run(scene, { miss: [40, 41] });
  valid(r, scene);
  assert.equal(r.status, 'tracked');
  assert.equal(r.engine, 'hf');
  assert.deepEqual(r.reasonCodes, []);
  const obsFrames = range(31, 60).filter(k => k !== 40 && k !== 41);
  assert.deepEqual(r.observations.map(o => o.t), obsFrames.map(k => scene.times[k]));
  assert.equal(r.observedFrames, obsFrames.length);
  for (const o of r.observations) {
    const p = scene.posAt(o.t);                                       // the mock measured the rendered ball
    assert.ok(Math.abs(o.x * W - p.x) < 0.3 && Math.abs(o.y * H - p.y) < 0.3, `observation at ${o.t}`);
    assert.equal(o.sigma, 0.5 / Math.hypot(W, H));                    // sigma px / diagonal
  }
  const L = state.confirmers[0].h;
  assert.deepEqual(r.launch, { t: L.t0Est, x: 135 / W, y: 400 / H, dir: r.launch.dir, view: 'dtl' });
  assert.ok(Math.abs(Math.hypot(r.launch.dir.x, r.launch.dir.y) - 1) < 1e-9 && r.launch.dir.y < 0);
  assert.deepEqual(r.points[0], { t: L.t0Est, x: 135 / W, y: 400 / H, status: 'anchor' });
  assert.ok(r.points.every(p => !('alpha' in p) || p.alpha < 1), 'alpha only inside the end fade');
  assert.ok(r.points.some(p => 'alpha' in p));
  assert.equal(r.points.at(-1).status, 'predicted');
  const end = state.completes[0].fit.predict(r.completion.end.t);
  assert.deepEqual(r.completion, {
    end: { type: 'landing', t: r.completion.end.t, x: end.x / W, y: end.y / H }, observedEnd: 'lost',
    observedSec: scene.times[59] - L.t0Est, predictedSec: r.completion.predictedSec, slowMoFactor: 1
  });
  assert.equal(r.camera.length, 60);
  assert.ok(r.camera.every((c, k) => c.t === scene.times[k] && c.x === 0 && c.y === 0 && c.s === 1 && c.r === 0));
  assert.equal(r.confidence.value, 0.92);
  assert.equal(r.diagnostics.paramsVersion, PARAMS_VERSION);
  assert.ok(r.diagnostics.ms.total > 0 && r.diagnostics.counts.track.crops > 0);
});

test('camera motion: observations come out stabilized and the camera track carries the shake', async () => {
  const shift = k => ({ x: Math.round(4 * Math.sin(k / 3)), y: Math.round(3 * Math.cos(k / 2)) - 3 });
  const scene = ballScene({ shift }), W = scene.width, H = scene.height;
  const { result: r } = await run(scene);
  valid(r, scene);
  assert.equal(r.status, 'tracked');
  let moved = 0;
  for (const o of r.observations) {
    const p = scene.posAt(o.t), k = Math.round(o.t * scene.fps), s = shift(k);
    assert.ok(Math.hypot(o.x * W - p.x, o.y * H - p.y) < 0.35, `stabilized at ${o.t}`);
    if (s.x || s.y) moved++;
  }
  assert.ok(moved > 10, 'the scene really shook');
  for (const c of r.camera) {
    const s = shift(Math.round(c.t * scene.fps));
    assert.ok(Math.abs(c.x - s.x / W) < 1e-12 && Math.abs(c.y - s.y / H) < 1e-12);
  }
});

/* ---------------------------------------------------------------- pass ordering and windows */

test('passes run in order: scan, impacts, launch windows, flight pass, fit loop, decide, curve', async () => {
  const scene = ballScene(), T = scene.times;
  const { calls, source, state } = await run(scene, { trackUntil: 50 });
  const first = p => calls.findIndex(c => c.startsWith(p)), last = p => calls.findLastIndex(c => c.startsWith(p));
  const stages = ['frames 0 ', 'scan.push', 'scan.finish', 'findImpacts', 'launch.new', 'launch.consume', 'launch.finish', 'track.new', 'track.consume', 'track.finish', 'fit', 'complete', 'decide', 'curve'];
  for (let i = 1; i < stages.length; i++) assert.ok(last(stages[i - 1]) < first(stages[i]), `${stages[i - 1]} before ${stages[i]}`);
  // P1 every frame (30 fps), P2a the confirmer window t0 − 0.25 s .. t0 + 0.5 s, P2b from t0 − 0.25 s until the tracker is done
  const h = state.confirmers[0].h, P = PARAMS.launch.window;
  const lw = [frameAt(T, h.t0Est - P.preSec), frameAt(T, h.t0Est + P.postSec) + 1], tw = frameAt(T, h.t0Est - PARAMS.pipeline.flightPreSec);
  assert.deepEqual(source.stats.iterations.map(i => [i.from, i.to, i.stride]), [[0, 60, 1], [...lw, 1], [tw, 60, 1]]);
  assert.deepEqual(state.scanner.idx, range(0, 60));
  assert.deepEqual(consumed(calls, 'launch.consume I0'), range(...lw));
  assert.deepEqual(consumed(calls, 'track.consume'), range(tw, 51));
  assert.deepEqual(source.stats.iterations[2].yielded, range(tw, 51), 'the flight pass stops once every tracker is done');
  // fit, then reassociate (+ warm refit while it changes the track, at most track.reassocIters rounds), then completion
  const fitLoop = calls.filter(c => /^(fit|reassociate|complete)/.test(c));
  assert.deepEqual(fitLoop, ['fit 20 cold', 'reassociate LI0/0', 'complete 20'], 'a re-association that changes nothing ends the loop');
  assert.equal(PARAMS.track.reassocIters, 2);
  assert.equal(calls.filter(c => c.startsWith('decide')).length, 1);
});

test('the coarse scan decimates only above 60 fps; the native passes never decimate', async () => {
  for (const fps of [30, 59.94, 60, 120, 240]) {
    const n = Math.round(fps * 1.1), impactFrame = Math.floor(fps * 0.5) + 0.4;
    const scene = ballScene({ fps, n, balls: [{ address: { x: 135, y: 400 }, impactFrame, vel: { x: 60, y: -600 }, acc: { x: 0, y: 800 } }] });
    const { state, source, calls, result } = await run(scene, { impacts: () => [sceneImpact(scene)] });
    const stride = fps > 60 ? Math.round(fps / 60) : 1;
    assert.equal(scanStride(fps), stride);
    assert.deepEqual(source.stats.iterations[0].stride, stride, `${fps} fps`);
    assert.deepEqual(state.scanner.idx, range(0, Math.ceil(n / stride)).map(k => k * stride), `${fps} fps scanned`);
    assert.ok(source.stats.iterations.slice(1).every(i => i.stride === 1), `${fps} fps native passes`);
    const c = state.confirmers[0], w = c.window();
    assert.deepEqual(consumed(calls, 'launch.consume'), range(w.from, Math.min(w.to, n)), `${fps} fps launch window`);
    assert.equal(result.camera.length, state.scanner.idx.length);
    valid(result, scene);
  }
});

test('each consumer gets the crops it asked for, cut from that frame, in request order, with simAt(camera, i)', async () => {
  const shift = k => ({ x: Math.round(3 * Math.sin(k)), y: Math.round(2 * Math.cos(k)) - 2 });
  const scene = twoBalls(3, { shift });
  const { state, result } = await run(scene, { impacts: bothImpacts(scene), trackUntil: 45 });
  valid(result, scene);
  const W = scene.width, H = scene.height, camera = state.impactsArgs.log.camera;
  assert.equal(state.confirmers.length, 2);
  assert.equal(state.trackers.length, 2);
  let checked = 0;
  for (const c of [...state.confirmers, ...state.trackers]) {
    for (const s of c.seen) {
      const reqs = c.roiRequests(s.i), plane = scene.plane(s.i);
      assert.equal(s.crops.length, reqs.length);
      s.crops.forEach((k, j) => { assert.deepEqual(k, cropLuma(plane, W, H, reqs[j].rect, reqs[j].pool)); checked++; });
      assert.deepEqual(s.sim, simAt(camera, s.i));
      assert.equal(s.t, scene.times[s.i]);
    }
  }
  assert.ok(checked > 100);
  assert.ok(state.trackers[0].obs.length > 5 && state.trackers[1].obs.length > 5, 'each tracker saw its own ball');
});

/* ---------------------------------------------------------------- cancel */

test('abort rejects with the AbortError at every phase, frees the source, and never reports done', async () => {
  const scene = ballScene();
  const cases = [
    ['before start', null],
    ['coarse scan', (ev, i) => ev === 'scan.push' && i === 10],
    ['launch pass', (ev, c, i) => ev === 'launch.consume' && i === 30],
    ['flight pass', (ev, t, i) => ev === 'track.consume' && i === 40],
    ['fit', ev => ev === 'fit'],
    ['decide', ev => ev === 'decide'],
    ['display curve', ev => ev === 'curve']
  ];
  for (const [name, when] of cases) {
    const ac = new AbortController(), s = setup(scene, { hook: (...a) => { if (when?.(...a)) ac.abort(); } }), events = [];
    if (!when) ac.abort();
    await assert.rejects(analyzeClip(s.source, { modules: s.modules, signal: ac.signal, onProgress: p => events.push(p.phase) }), abortError, name);
    assert.equal(s.source.busy, false, `${name}: source freed`);
    assert.equal(s.source.stats.live, 0, `${name}: every FrameRef closed`);
    assert.equal(s.source.stats.afterClose, 0);
    assert.ok(!events.includes('done'), `${name}: no done event`);
    const after = { 'before start': 'scan.new', 'coarse scan': 'findImpacts', 'launch pass': 'track.new', 'flight pass': 'fit', fit: 'decide', decide: 'curve' }[name];
    if (after) assert.ok(!s.calls.some(c => c.startsWith(after)), `${name}: nothing after the abort (${after})`);
  }
  // an abort that lands while the source's next() is pending still rejects with the AbortError, not a decode error
  const late = new AbortController(), sl = setup(scene, { hook: (ev, i) => { if (ev === 'scan.push' && i === 10) setImmediate(() => late.abort()); } }, { macrotask: true });
  await assert.rejects(analyzeClip(sl.source, { modules: sl.modules, signal: late.signal }), abortError);
  assert.equal(sl.source.stats.iterations[0].yielded.at(-1), 10, 'the source saw the abort itself');
  // a lax source that ignores the signal: the pipeline still stops at the next frame
  const lax = new AbortController(), sx = setup(scene, { hook: (ev, i) => { if (ev === 'scan.push' && i === 10) lax.abort(); } }, { ignoreSignal: true });
  await assert.rejects(analyzeClip(sx.source, { modules: sx.modules, signal: lax.signal }), abortError);
  assert.equal(sx.calls.filter(c => c.startsWith('scan.push')).length, 11, 'no frame processed after the abort');
  assert.equal(sx.source.busy, false);
  // a custom reason is what rejects; the pipeline passes the signal to fitFlight
  const ac = new AbortController(), reason = new Error('user cancelled'), s = setup(scene, { hook: ev => { if (ev === 'fit') ac.abort(reason); } });
  await assert.rejects(analyzeClip(s.source, { modules: s.modules, signal: ac.signal }), e => e === reason);
  assert.equal(s.state.fits[0].opts.signal, ac.signal);
});

/* ---------------------------------------------------------------- progress */

test('progress: every phase in order, done last and once, valid events', async () => {
  const scene = ballScene();
  const { events, result } = await run(scene, {}, { params: mergeParams({ pipeline: { progressMs: 1e9 } }) });
  assert.equal(result.status, 'tracked');
  assert.deepEqual(events.map(e => e.phase), ['probe', 'scan', 'impact', 'launch', 'track', 'fit', 'decide', 'done'], 'one event per phase when throttled hard');
  for (const e of events) { const { at, ...p } = e; assert.deepEqual(check('Progress', p), []); }
  assert.deepEqual(events.at(-1), { phase: 'done', done: 1, total: 1, message: 'tracked', at: events.at(-1).at });
  const all = (await run(scene, {}, { params: mergeParams({ pipeline: { progressMs: 0 } }) })).events;
  assert.equal(all.filter(e => e.phase === 'scan').length, 61, 'unthrottled: 0/60 then one per scanned frame');
  assert.deepEqual(all.filter(e => e.phase === 'scan').map(e => e.done), range(0, 61));
  const idx = all.map(e => PROGRESS_PHASES.indexOf(e.phase));
  assert.ok(idx.every((v, i) => !i || v >= idx[i - 1]), 'phases never go back');
  assert.equal(all.filter(e => e.phase === 'done').length, 1);
  assert.ok(all.every(e => e.done <= e.total));
  const h = sceneImpact(scene), T = scene.times, lw = frameAt(T, h.t0Est + PARAMS.launch.window.postSec) + 1 - frameAt(T, h.t0Est - PARAMS.launch.window.preSec);
  assert.equal(all.find(e => e.phase === 'launch').total, lw, 'launch total: the frames in the launch windows');
  assert.equal(all.find(e => e.phase === 'track').total, 60 - frameAt(T, h.t0Est - PARAMS.pipeline.flightPreSec));
  assert.equal(all.filter(e => e.phase === 'launch').at(-1).done, lw);
  // early exit: probe, scan, impact, done
  const none = await run(scene, { impacts: () => [] }, { params: mergeParams({ pipeline: { progressMs: 1e9 } }) });
  assert.deepEqual(none.events.map(e => e.phase), ['probe', 'scan', 'impact', 'done']);
});

test('progress is throttled to at most one event per pipeline.progressMs within a phase', async () => {
  // a fake clock (the pipeline reads performance.now at call time): 5 ms per scanned frame, frozen otherwise
  const scene = ballScene(), every = 20;
  let clock = 0;
  performance.now = () => clock;
  try {
    const { events } = await run(scene, { hook: ev => { if (ev === 'scan.push') clock += 5; } }, { params: mergeParams({ pipeline: { progressMs: every } }) });
    assert.deepEqual(events.filter(e => e.phase === 'scan').map(e => e.done), range(0, 16).map(k => 4 * k), 'one event per 20 ms = every 4th frame');
    assert.deepEqual(events.map(e => e.phase).filter((p, i, a) => p !== a[i - 1]), ['probe', 'scan', 'impact', 'launch', 'track', 'fit', 'decide', 'done']);
  } finally { delete performance.now; }
  assert.equal(typeof performance.now(), 'number');
});

/* ---------------------------------------------------------------- memory */

test('memory: at most one live FrameRef, none used after close, every one closed', async () => {
  const scene = twoBalls(40, { n: 120 });
  const { source, result } = await run(scene, { impacts: bothImpacts(scene), trackUntil: t => t.b ? 100 : 60 });
  valid(result, scene);
  assert.equal(source.stats.maxLive, 1);
  assert.equal(source.stats.live, 0);
  assert.equal(source.stats.closed, source.stats.opened);
  assert.equal(source.stats.afterClose, 0);
  assert.deepEqual(source.stats.iterations.map(i => i.from), [0, 23, 23], 'scan, launch and flight passes each re-decode');
  assert.equal(source.busy, false);
});

test('memory: no frame is retained after close, during the passes or after the result (GC)', { skip: !gc && 'needs gc' }, async () => {
  const scene = ballScene({ n: 90, balls: [{ address: { x: 135, y: 400 }, impactFrame: 30.4, vel: { x: 40, y: -500 }, acc: { x: 0, y: 500 } }] });
  let mid = null;
  const s = setup(scene, { hook: (ev, t, i) => { if (ev === 'track.consume' && i === 80) { gc(); mid = s.source.stats.refs.filter(w => w.deref()).length; } } }, { macrotask: true });
  const result = await analyzeClip(s.source, { modules: s.modules });
  valid(result, scene);
  assert.equal(result.status, 'tracked');
  assert.ok(s.source.stats.opened > 170, `${s.source.stats.opened} frames decoded`);
  assert.ok(mid !== null && mid <= 2, `${mid} FrameRefs alive mid-flight-pass`);
  await tick(); gc(); await tick(); gc();
  const refs = s.source.stats.refs.filter(w => w.deref()).length, planes = s.source.stats.planes.filter(w => w.deref()).length;
  assert.ok(refs <= 1 && planes <= 1, `${refs} FrameRefs / ${planes} planes still reachable`);
});

/* ---------------------------------------------------------------- frame scheduling */

test('consumers see exactly their windows; long gaps restart the pass, element sources restart on any gap', async () => {
  // two shots 170 frames apart: separate launch and flight passes, and nothing decoded in between
  const far = twoBalls(170, { n: 240 });
  const a = await run(far, { impacts: bothImpacts(far), trackUntil: t => t.b ? 230 : 60 });
  valid(a.result, far);
  const it = a.source.stats.iterations.map(i => [i.from, i.to, i.yielded.length]);
  const [w0, w1] = a.state.confirmers.map(c => c.window());
  assert.deepEqual(it.slice(1, 3), [[w0.from, w1.to, w0.to - w0.from], [w1.from, w1.to, w1.to - w1.from]], 'launch: two passes');
  assert.deepEqual(consumed(a.calls, 'launch.consume I0'), range(w0.from, w0.to));
  assert.deepEqual(consumed(a.calls, 'launch.consume I1'), range(w1.from, w1.to));
  const [t0, t1] = a.state.trackers;
  assert.deepEqual(consumed(a.calls, `track.consume ${t0.L.id}`), range(t0.window().from, 61));
  assert.deepEqual(consumed(a.calls, `track.consume ${t1.L.id}`), range(t1.window().from, 231));
  assert.deepEqual(it.slice(3).map(x => x[2]), [61 - t0.window().from, 231 - t1.window().from], 'flight: restarted at the second shot');
  // windows 7 frames apart: one pass from a memory source, two from an element source, same consumer calls
  const near = twoBalls(30, { n: 100 });
  const mem = await run(near, { impacts: bothImpacts(near), trackUntil: 90 });
  const el = await run(near, { impacts: bothImpacts(near), trackUntil: 90 }, { source: { path: 'element' } });
  const launchIters = s => s.calls.slice(s.calls.indexOf('findImpacts'), s.calls.indexOf('launch.finish I0')).filter(c => c.startsWith('frames ')).length;
  const [n0, n1] = mem.state.confirmers.map(c => c.window());
  assert.ok(n1.from - n0.to > 0 && n1.from - n0.to < near.fps, `a ${n1.from - n0.to}-frame gap`);
  assert.equal(launchIters(mem), 1);
  assert.equal(launchIters(el), 2);
  assert.equal(mem.source.stats.iterations[1].yielded.length, n1.to - n0.from, 'memory: decoded through the gap');
  assert.equal(el.source.stats.iterations[1].yielded.length + el.source.stats.iterations[2].yielded.length, n1.to - n1.from + n0.to - n0.from);
  assert.deepEqual(mem.calls.filter(c => c.includes('consume')), el.calls.filter(c => c.includes('consume')));
  assert.ok(el.result.reasonCodes.includes('slow_decode_path') && !mem.result.reasonCodes.includes('slow_decode_path'));
  valid(el.result, near);
});

test('consumer windows are clamped to the clip', async () => {
  const scene = ballScene(), s = setup(scene);
  const FlightTracker = class extends s.modules.FlightTracker { window() { return { from: -5, to: 70 }; } };
  const r = await analyzeClip(s.source, { modules: { ...s.modules, FlightTracker } });
  valid(r, scene);
  assert.deepEqual(consumed(s.calls, 'track.consume'), range(0, 60));
  assert.deepEqual(s.source.stats.iterations[2], { from: 0, to: 60, stride: 1, yielded: range(0, 60) });
});

/* ---------------------------------------------------------------- decode policy: unverified element frames */

const noDiag = ({ diagnostics, ...r }) => r;

test('an unverified frame (element path) is re-read before anyone sees it; a retry that verifies changes nothing', { timeout: 30000 }, async () => {
  const scene = ballScene(), el = { path: 'element' };
  const clean = await run(scene, {}, { source: el });
  assert.equal(clean.result.status, 'tracked');
  const reads = new Map(), flaky = k => { const n = (reads.get(k) ?? 0) + 1; reads.set(k, n); return !(k === 40 && n === 1); };
  const a = await run(scene, {}, { source: { ...el, verified: flaky } });
  valid(a.result, scene);
  assert.deepEqual(noDiag(a.result), noDiag(clean.result), 'same result as a clean element run');
  assert.deepEqual(a.result.reasonCodes, ['slow_decode_path']);
  assert.equal(a.result.diagnostics.counts.scan.retries, 1);
  assert.equal(a.result.diagnostics.unverified, undefined);
  assert.deepEqual(a.state.scanner.idx, range(0, 60), 'every frame scanned once, in order');
  assert.deepEqual(a.source.stats.iterations.slice(0, 2).map(i => [i.from, i.yielded[0], i.yielded.at(-1)]), [[0, 0, 40], [40, 40, 59]], 'the scan restarted at the unverified frame');
  assert.deepEqual(a.calls.filter(c => c.startsWith('track.consume')), clean.calls.filter(c => c.startsWith('track.consume')));
  // verified null (no rVFC): nothing to retry, nothing recorded
  const n = await run(scene, {}, { source: { ...el, verified: () => null } });
  assert.deepEqual(noDiag(n.result), noDiag(clean.result));
  assert.equal(n.result.diagnostics.counts.scan.retries, undefined);
  assert.equal(n.source.stats.iterations.length, 3);
});

test('a frame still unverified after pipeline.unverifiedRetries: slow_decode_path outside the windows, decoder_limited inside', { timeout: 30000 }, async () => {
  const scene = ballScene(), el = { path: 'element' }, R = PARAMS.pipeline.unverifiedRetries;
  assert.equal(R, 2);
  // frame 5 is far before the launch window (frames 23-45) and the flight window (23-59): the trace stands
  const far = await run(scene, {}, { source: { ...el, verified: k => k !== 5 } });
  valid(far.result, scene);
  assert.equal(far.result.status, 'tracked');
  assert.deepEqual(far.result.reasonCodes, ['slow_decode_path']);
  assert.equal(far.source.stats.reads[5], 1 + R, 'read once plus the retries, then used');
  assert.deepEqual(far.result.diagnostics.unverified, [{ index: 5, t: scene.times[5], phase: 'scan' }]);
  assert.equal(far.result.diagnostics.counts.scan.retries, R);
  // frame 40 (in flight) is never verified: nothing is drawn
  const mid = await run(scene, {}, { source: { ...el, verified: k => k !== 40 } });
  valid(mid.result, scene);
  emptyAbstention(mid.result);
  assert.deepEqual(mid.result.reasonCodes, ['decoder_limited', 'slow_decode_path']);
  assert.equal(mid.result.camera.length, 60, 'the camera track is kept');
  assert.deepEqual(mid.result.diagnostics.decoderLimited, { status: 'tracked', reasonCodes: ['slow_decode_path'], observedFrames: 29 });
  assert.equal(mid.source.stats.reads[40], 3 * (1 + R), 'bounded: 1 + retries reads in each of the three passes');
  assert.equal(mid.result.confidence.value, 0.92, "decide's confidence is kept for diagnostics");
  // the flight window starts at t0 - flightPreSec: frame 23 abstains, frame 22 does not
  assert.deepEqual((await run(scene, {}, { source: { ...el, verified: k => k !== 23 } })).result.reasonCodes, ['decoder_limited', 'slow_decode_path']);
  assert.deepEqual((await run(scene, {}, { source: { ...el, verified: k => k !== 22 } })).result.reasonCodes, ['slow_decode_path']);
  // ... and ends at the last drawn observation: a frame after it (tracker done at 50) does not matter
  const late = await run(scene, { trackUntil: 50 }, { source: { ...el, verified: k => k !== 57 } });
  assert.equal(late.result.status, 'tracked');
  assert.deepEqual(late.result.reasonCodes, ['slow_decode_path']);
  // an abstention whose launch window holds the frame says so (both codes are abstain codes)
  const rej = await run(scene, { verdict: () => 'launch_not_confirmed' }, { source: { ...el, verified: k => k !== 30 } });
  valid(rej.result, scene);
  assert.deepEqual(rej.result.reasonCodes, ['launch_not_confirmed', 'decoder_limited', 'slow_decode_path']);
  const none = await run(scene, { impacts: () => [] }, { source: { ...el, verified: k => k !== 30 } });
  assert.deepEqual(none.result.reasonCodes, ['no_launch', 'slow_decode_path'], 'no launch window: nothing affected');
  // the launch window is the drawn launch's confirmer window (with its null windows), the flight window starts at
  // t0 - flightPreSec: a confirmer window starting after t0 leaves frame 25 to the flight window alone, one
  // starting 25 frames early puts frame 8 in the launch window alone
  const lateWin = m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { window() { return { from: 31, to: 46 }; } } });
  const earlyWin = m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { window() { return { from: 5, to: 46 }; } } });
  for (const [win, k, want] of [[lateWin, 25, ['decoder_limited', 'slow_decode_path']], [lateWin, 8, ['slow_decode_path']], [earlyWin, 8, ['decoder_limited', 'slow_decode_path']], [earlyWin, 3, ['slow_decode_path']]]) {
    const s = setup(scene, {}, { ...el, verified: i => i !== k });
    const r = await analyzeClip(s.source, { modules: { ...s.modules, ...win(s.modules) } });
    valid(r, scene);
    assert.deepEqual(r.reasonCodes, want, `${win === lateWin ? 'late' : 'early'} confirmer window, frame ${k}`);
  }
  // any source: an unverified frame marks slow_decode_path even off the element path
  const mem = await run(scene, {}, { source: { verified: k => k !== 5 } });
  assert.equal(mem.result.status, 'tracked');
  assert.deepEqual(mem.result.reasonCodes, ['slow_decode_path']);
  // retries are a parameter: with none the frame is used at once
  const zero = await run(scene, {}, { source: { ...el, verified: k => k !== 5 } , params: mergeParams({ pipeline: { unverifiedRetries: 0 } }) });
  assert.equal(zero.source.stats.reads[5], 1);
  assert.equal(zero.result.diagnostics.counts.scan.retries, undefined);
});

test('one frame\'s crop requests are bounded (pipeline.maxRequestFrames per rect, maxFrameCropFrames in total): a runaway consumer fails closed', { timeout: 30000 }, async () => {
  const scene = ballScene(), W = scene.width, H = scene.height, P = PARAMS.pipeline;
  assert.deepEqual([P.maxRequestFrames, P.maxFrameCropFrames], [4, 16]);
  const huge = { rect: { x: -W, y: -H, w: 3 * W, h: 2 * H }, pool: 4, purpose: 'decoy' };   // 6 frame areas
  const big = m => ({ FlightTracker: class extends m.FlightTracker { roiRequests(i) { const r = super.roiRequests(i); return i === 40 ? [...r, huge] : r; } } });
  const s = setup(scene);
  const r = await analyzeClip(s.source, { modules: { ...s.modules, ...big(s.modules) } });
  valid(r, scene);
  emptyAbstention(r);
  assert.deepEqual(r.reasonCodes, ['internal_error']);
  assert.match(r.diagnostics.errors[0], /FlightTracker\(LI0\)\.roiRequests\(40\): contract: request\[3\]: .* larger than pipeline\.maxRequestFrames/);
  assert.equal(s.source.stats.live, 0);
  // many rects each within the bound, together above maxFrameCropFrames
  const many = m => ({ FlightTracker: class extends m.FlightTracker { roiRequests(i) { const r = super.roiRequests(i); return i === 40 ? [...r, ...Array.from({ length: 5 }, () => ({ rect: { x: 0, y: 0, w: 2 * W, h: 2 * H }, pool: 4, purpose: 'decoy' }))] : r; } } });
  const s2 = setup(scene);
  const r2 = await analyzeClip(s2.source, { modules: { ...s2.modules, ...many(s2.modules) } });
  assert.deepEqual(r2.reasonCodes, ['internal_error']);
  assert.match(r2.diagnostics.errors[0], /frame 40 roiRequests: contract: .* more than pipeline\.maxFrameCropFrames \(16\) frame areas/);
  // the bound is a parameter; within it the same requests are served
  const ok = await analyzeClip(setup(scene).source, { modules: { ...setup(scene).modules, ...big(setup(scene).modules) }, params: mergeParams({ pipeline: { maxRequestFrames: 6 } }) });
  assert.equal(ok.status, 'tracked');
});

test('a confirmer that is done early is not fed again; the launch pass ends when all are done', async () => {
  const scene = ballScene();
  const { calls, source, state } = await run(scene, { launchDoneAfter: 2 });
  const fed = consumed(calls, 'launch.consume I0');
  assert.equal(fed.at(-1), 32, 'the second sighting (frame 32) was the last frame fed');
  assert.equal(source.stats.iterations[1].yielded.at(-1), 32);
  assert.ok(state.confirmers[0].window().to > 33);
});

/* ---------------------------------------------------------------- multiple hypotheses */

test('two confirmed launches are tracked in one pass and decide sees both; the best wins (multiple_shots)', async () => {
  const scene = twoBalls(3);
  const { result, state, source } = await run(scene, { impacts: bothImpacts(scene) });
  valid(result, scene);
  assert.equal(state.trackers.length, 2);
  assert.equal(source.stats.iterations.length, 3, 'one scan, one launch pass, one flight pass');
  assert.equal(state.decide.cands.length, 2);
  assert.deepEqual(state.decide.cands.map(c => c.launch.id), ['LI0', 'LI1']);
  assert.deepEqual(state.decide.ctx.impacts.map(h => h.id), ['I0', 'I1']);
  assert.equal(state.decide.ctx.decisions.length, 2);
  assert.equal(result.status, 'tracked');
  assert.ok(result.reasonCodes.includes('multiple_shots'));
});

test('the drawn trace is the candidate decide selects, not the first one', async () => {
  const scene = twoBalls(3), W = scene.width, H = scene.height;
  const pick = (cands) => decision('tracked', [], cands[1], { allowCompletion: true, value: 0.95 });
  const { result } = await run(scene, { impacts: bothImpacts(scene), decide: pick });
  valid(result, scene);
  assert.equal(result.launch.x, 50 / W);
  assert.equal(result.launch.y, 430 / H);
  for (const o of result.observations) { const p = scene.posAt(o.t, 1); assert.ok(Math.hypot(o.x * W - p.x, o.y * H - p.y) < 0.35); }
  assert.equal(result.confidence.value, 0.95);
});

test('rejected launches are not tracked; only confirmed ones reach decide', async () => {
  const scene = twoBalls(3);
  const { result, state } = await run(scene, { impacts: bothImpacts(scene), verdict: h => h.id === 'I0' ? 'club_only_motion' : 'accept' });
  valid(result, scene);
  assert.deepEqual(state.trackers.map(t => t.L.id), ['LI1']);
  assert.deepEqual(state.decide.cands.map(c => c.launch.id), ['LI1']);
  assert.deepEqual(state.decide.ctx.decisions.map(d => [d.hypId, d.accepted]), [['I0', false], ['I1', true]]);
  assert.equal(result.launch.x, 50 / scene.width);
});

test('more confirmed launches than pipeline.maxLaunches: the largest null margins are tracked, in impact order', async () => {
  const scene = twoBalls(3);
  const impacts = () => [sceneImpact(scene, 0, { id: 'I0' }), sceneImpact(scene, 1, { id: 'I1' }), sceneImpact(scene, 0, { id: 'I2' })];
  const margin = h => ({ I0: 6, I1: 3, I2: 9 })[h.id];
  const { state, result } = await run(scene, { impacts, margin }, { params: mergeParams({ pipeline: { maxLaunches: 2 } }) });
  valid(result, scene);
  assert.deepEqual(state.trackers.map(t => t.L.id), ['LI0', 'LI2'], 'the smallest margin (I1) is dropped; impact order kept');
  assert.deepEqual(state.decide.cands.map(c => c.launch.id), ['LI0', 'LI2']);
  assert.equal(state.decide.ctx.decisions.length, 3, 'decide still sees every launch decision');
  const five = () => range(0, PARAMS.impact.maxHypotheses + 1).map(i => sceneImpact(scene, 0, { id: `I${i}` }));
  const s5 = await run(scene, { impacts: five });
  assert.equal(s5.state.confirmers.length, PARAMS.impact.maxHypotheses, 'impacts beyond impact.maxHypotheses are dropped');
});

/* ---------------------------------------------------------------- fit, re-association, completion */

test('re-association: reassocIters rounds, warm refits chained, contexts and deps passed through', async () => {
  const scene = ballScene(), ac = new AbortController();
  const { result, calls, state, modules } = await run(scene, { miss: [40, 41], recover: r => [[40], [41]][r] ?? [] }, { signal: ac.signal });
  valid(result, scene);
  assert.deepEqual(calls.filter(c => /^(fit|reassociate)/.test(c)), ['fit 27 cold', 'reassociate LI0/0', 'fit 28 warm', 'reassociate LI0/0', 'fit 29 warm'], 'one point recovered per round: track.reassocIters rounds');
  assert.equal(state.fits[0].opts.warm, undefined);
  assert.equal(state.fits[1].opts.warm, state.fits[0].fit);
  assert.equal(state.fits[2].opts.warm, state.fits[1].fit);
  assert.ok(state.fits.every(f => f.opts.signal === ac.signal));
  assert.equal(state.reassoc[0].fit, state.fits[0].fit);
  assert.equal(state.reassoc[1].fit, state.fits[1].fit);
  assert.equal(state.decide.cands[0].features.reassocRounds, 2);
  // both points back in one round: the second round changes nothing, so it is the last (no refit of the same data)
  const once = await run(scene, { miss: [40, 41], recover: [40, 41] });
  assert.deepEqual(once.calls.filter(c => /^(fit|reassociate)/.test(c)), ['fit 27 cold', 'reassociate LI0/0', 'fit 29 warm', 'reassociate LI0/0']);
  assert.equal(once.state.decide.cands[0].features.reassocRounds, 2);
  assert.equal(once.state.completes[0].fit, once.state.fits[1].fit, 'completion uses the last fit');
  assert.deepEqual(once.result.observations.map(o => o.t), result.observations.map(o => o.t));
  const tr = state.trackers[0], impact = state.confirmers[0].h, log = state.impactsArgs.log;
  assert.equal(state.reassoc[0].ctx, tr.ctx, 'reassociate gets the tracker context');
  assert.deepEqual(Object.keys(tr.ctx).sort(), ['impact', 'log', 'meta', 'params']);
  assert.equal(tr.ctx.impact, impact);
  assert.equal(state.reassoc[0].deps, tr.deps);
  assert.deepEqual(Object.keys(tr.deps).sort(), ['RoiTube', 'fitFlight']);
  assert.ok(tr.deps.RoiTube === modules.RoiTube && tr.deps.fitFlight === modules.fitFlight, 'FlightTracker deps are the injected U4/U5 modules');
  const fctx = state.fits[0].ctx;
  assert.deepEqual(Object.keys(fctx).sort(), ['horizon', 'launch', 'meta', 'params', 'tauPrior']);
  assert.equal(fctx.launch, tr.L);
  assert.equal(fctx.tauPrior, impact.tauPrior);
  assert.equal(fctx.horizon, log.horizon);
  const cctx = state.completes[0].ctx;
  assert.deepEqual(Object.keys(cctx).sort(), ['camera', 'horizon', 'launch', 'meta', 'observedEnd', 'params']);
  assert.equal(cctx.camera, log.camera);
  assert.equal(cctx.observedEnd, 'lost');
  assert.deepEqual(result.observations.map(o => Math.round(o.t * 30)), range(31, 60), 'recovered frames are drawn');
  const none = await run(scene, {}, { params: mergeParams({ track: { reassocIters: 0 } }) });
  assert.deepEqual(none.calls.filter(c => /^(fit|reassociate)/.test(c)), ['fit 29 cold']);
  const stable = await run(scene);
  assert.deepEqual(stable.calls.filter(c => /^(fit|reassociate)/.test(c)), ['fit 29 cold', 'reassociate LI0/0'], 'converged at once: one round, no refit');
  assert.equal(stable.state.decide.cands[0].features.reassocRounds, 1);
  // a round that only relabels or moves a point (same frames) still changes what the fit sees: refit
  const edit = (what) => (r, obs) => r ? obs : obs.map(o => (o.index === 45 ? { ...o, ...what } : o));
  for (const what of [{ flag: 'ambiguous' }, { x: 120.5 }, { sigma: 0.9 }, { d: 5.5 }, { cov: [0.3, 0.01, 0.4] }]) {
    const e = await run(scene, { reassocEdit: edit(what) });
    assert.deepEqual(e.calls.filter(c => /^(fit|reassociate)/.test(c)), ['fit 29 cold', 'reassociate LI0/0', 'fit 29 warm', 'reassociate LI0/0'], JSON.stringify(what));
  }
});

test('the final fit\'s outliers are flagged rejected: not drawn, not completed from, listed in diagnostics', async () => {
  const scene = ballScene(), T = scene.times;
  const { result, state } = await run(scene, { outliers: [45, 52] });
  valid(result, scene);
  const drawn = result.observations.map(o => o.t);
  assert.ok(!drawn.includes(T[45]) && !drawn.includes(T[52]));
  assert.equal(result.observations.length, 27);
  assert.deepEqual(result.diagnostics.rejected.map(o => o.t), [T[45], T[52]]);
  assert.ok(!state.completes[0].obs.some(o => o.index === 45 || o.index === 52), 'completion only from inliers');
  assert.ok(state.curve.obs.every(o => o.flag === 'inlier') && state.curve.obs.length === 27);
  const track = state.decide.cands[0].track;
  assert.deepEqual(track.observations.filter(o => o.flag === 'rejected').map(o => o.index), [45, 52], 'decide sees the flags');
  assert.equal(state.decide.cands[0].features.rejected, 2);
  // tracker labels other than inlier reach the fitter (it skips them) but are never drawn or rejected
  const amb = await run(scene, { flagAs: { 35: 'ambiguous', 36: 'mover' } });
  valid(amb.result, scene);
  assert.equal(amb.state.fits[0].obs.length, 29, 'the fitter gets every observation');
  assert.ok(amb.state.fits[0].obs.some(o => o.flag === 'ambiguous'));
  assert.ok(!amb.result.observations.some(o => o.t === T[35] || o.t === T[36]));
  assert.equal(amb.result.observations.length, 27);
  assert.deepEqual(amb.result.diagnostics.rejected, []);
});

test('launch.view comes from the fit when it classifies the view, else from the launch', async () => {
  const scene = ballScene();
  assert.equal((await run(scene, { fitView: 'fo' })).result.launch.view, 'fo');
  assert.equal((await run(scene, { fitView: 'unknown' })).result.launch.view, 'dtl');
});

test('arc completion only when decide allows it: no completion, no predicted points otherwise', async () => {
  const scene = ballScene();
  const noArc = cands => decision('partial', ['tracking_ended_early'], cands[0], { allowCompletion: false, value: 0.7 });
  const a = await run(scene, { decide: noArc });
  valid(a.result, scene);
  assert.ok(a.state.decide.cands[0].completion, 'a completion existed');
  assert.equal(a.state.curve.completion, null, 'displayCurve got no completion');
  assert.equal(a.result.completion, null);
  assert.ok(!a.result.points.some(p => p.status === 'predicted'));
  assert.equal(a.result.points.at(-1).t, a.result.observations.at(-1).t);
  assert.equal(a.result.status, 'partial');
  const faded = cands => decision('partial', ['completion_uncertain'], cands[0], { allowCompletion: true, value: 0.7 });
  const b = await run(scene, { decide: faded, endType: 'fade' });
  valid(b.result, scene);
  assert.equal(b.result.completion.end.type, 'fade');
  assert.ok(b.result.points.at(-1).alpha < 1 && b.result.points.at(-1).status === 'predicted');
});

/* ---------------------------------------------------------------- abstentions */

test('abstentions draw nothing: points = [], observations = [], completion = null', async () => {
  const scene = ballScene();
  const empty = await analyzeClip(createMemorySource({ width: 8, height: 8, frames: [] }), { modules: mockModules(scene).modules });
  emptyAbstention(empty);
  assert.deepEqual(empty.reasonCodes, ['no_frames']);
  assert.deepEqual((await analyzeClip(null)).reasonCodes, ['no_frames']);
  const mute = setup(scene), dry = { meta: mute.source.meta, frames: async function* () {}, close: async () => {} };
  const r0 = await analyzeClip(dry, { modules: mute.modules });
  emptyAbstention(r0);
  assert.deepEqual(r0.reasonCodes, ['no_frames'], 'a source that yields no frame');
  assert.ok(!mute.calls.includes('scan.finish'));
  const cases = [
    [{ impacts: () => [] }, ['no_launch']],
    [{ verdict: () => 'launch_not_confirmed' }, ['launch_not_confirmed']],
    [{ decide: () => decision('no_reliable_track', ['low_confidence'], null, { value: 0.3 }) }, ['low_confidence']],
    [{ miss: range(0, 60) }, ['insufficient_visible_frames']]
  ];
  for (const [mock, codes] of cases) {
    const { result: r, calls } = await run(scene, mock);
    valid(r, scene);
    emptyAbstention(r);
    assert.deepEqual(r.reasonCodes, codes);
    assert.equal(r.camera.length, 60, 'the camera track survives an abstention');
    if (codes[0] === 'insufficient_visible_frames') assert.ok(!calls.some(c => c.startsWith('fit')), 'no fit without observations');
  }
  const low = await run(scene, { decide: () => decision('no_reliable_track', ['low_confidence'], null, { value: 0.3 }) });
  assert.equal(low.result.confidence.value, 0.3, "decide's confidence is kept");
});

test('a practice swing (the ball never leaves) gives no_launch; an invisible ball gives no trace', async () => {
  const still = ballScene({ balls: [{ address: { x: 135, y: 400 }, impactFrame: 1e9, vel: { x: 0, y: 0 }, acc: { x: 0, y: 0 } }] });
  const a = await run(still);
  valid(a.result, still);
  emptyAbstention(a.result);
  assert.deepEqual(a.result.reasonCodes, ['no_launch']);
  assert.ok(!a.calls.some(c => c.startsWith('launch.new')));
  const gone = ballScene({ hideFrom: 31 });
  const b = await run(gone);
  valid(b.result, gone);
  emptyAbstention(b.result);
  assert.deepEqual(b.result.reasonCodes, ['ball_not_found_after_impact']);
  assert.ok(!b.calls.some(c => c.startsWith('track.new')), 'nothing is tracked without a confirmed launch');
  const brief = ballScene({ hideFrom: 34 });                        // seen at launch, then lost: observed-only partial
  const c = await run(brief);
  valid(c.result, brief);
  assert.equal(c.result.status, 'partial');
  assert.deepEqual(c.result.reasonCodes, ['tracking_ended_early']);
  assert.equal(c.result.completion, null);
});

test('all launches rejected: the abstention carries their reasons, unique, in impact order', async () => {
  const scene = twoBalls(3);
  const v = { I0: 'club_only_motion', I1: 'launch_not_confirmed' };
  const { result, calls } = await run(scene, { impacts: bothImpacts(scene), verdict: h => v[h.id] });
  valid(result, scene);
  emptyAbstention(result);
  assert.deepEqual(result.reasonCodes, ['club_only_motion', 'launch_not_confirmed']);
  assert.ok(!calls.some(c => c.startsWith('track.new') || c.startsWith('decide')));
  const same = await run(scene, { impacts: bothImpacts(scene), verdict: () => 'club_only_motion' });
  assert.deepEqual(same.result.reasonCodes, ['club_only_motion']);
  const el = await run(scene, { impacts: bothImpacts(scene), verdict: () => 'club_only_motion' }, { source: { path: 'element' } });
  assert.deepEqual(el.result.reasonCodes, ['club_only_motion', 'slow_decode_path']);
  valid(el.result, scene);
});

/* ---------------------------------------------------------------- error policy */

test('a collaborator that throws or breaks its contract gives an internal_error abstention (fail closed)', async () => {
  const scene = ballScene();
  const bad = [
    ['findImpacts throws', { impacts: () => { throw new Error('boom'); } }, /findImpacts: boom/],
    ['findImpacts output', { impacts: () => [{ id: 'I0' }] }, /findImpacts: contract/],
    ['roiRequests output', { hook: (ev, c) => { if (ev === 'launch.consume') c.roiRequests = () => [{ rect: { x: 0, y: 0, w: 0, h: 4 }, pool: 1, purpose: 'x' }]; } }, /roiRequests\(\d+\): contract/],
    ['tracker finish', { branches: t => [{ id: 'nope', launchId: t.L.id }] }, /FlightTracker\(LI0\)\.finish: contract: hyps\[1\]/],
    ['done is not a boolean', { hook: (ev, c) => { if (ev === 'launch.consume') Object.defineProperty(c, 'done', { value: () => false }); } }, /LaunchConfirmer\(I0\)\.done: contract: expected a boolean/],
    ['decide output', { decide: () => ({ status: 'tracked' }) }, /decide: contract/],
    ['decide selects nothing usable', { decide: c => decision('partial', ['tracking_ended_early'], { ...c[0], track: null }) }, /decide: contract.*needs the selected launch's track/],
    ['completion without R2 data', { decide: c => decision('tracked', [], { ...c[0], completion: null }, { allowCompletion: true }) }, /allowCompletion needs a fit and a completion/],
    ['curve breaks the result contract', { curve: (f, o, c, ctx) => curveFor(f, o, c, ctx).map((p, i) => (i ? p : { ...p, x: p.x + 5 })) }, /validateResult: the anchor must sit at launch/]
  ];
  const custom = [
    ['decision for another hypothesis', m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { finish() { return { ...super.finish(), hypId: 'I9' }; } } }), /LaunchConfirmer\(I0\)\.finish: contract: decided 'I9'/],
    ['duplicate launch ids', m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { finish() { const d = super.finish(); return d.accepted ? { ...d, candidate: { ...d.candidate, id: 'X' } } : d; } } }), /duplicate launch ids/],
    ['track of another launch', m => ({ FlightTracker: class extends m.FlightTracker { finish() { return super.finish().map(h => ({ ...h, launchId: 'LI9' })); } } }), /FlightTracker\(LI0\)\.finish: contract: LI0\/0: launchId 'LI9'/],
    ['reassociated into another launch', m => ({ reassociate: (h, ...a) => ({ ...m.reassociate(h, ...a), launchId: 'LI9' }) }), /reassociate\(LI0\/0\): contract: launchId 'LI9'/],
    ['coarse log', m => ({ CoarseScanner: class extends m.CoarseScanner { finish() { return { ...super.finish(), camera: null }; } } }), /CoarseScanner\.finish: contract: log\.camera/],
    ['launch decision', m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { finish() { return { ...super.finish(), accepted: 'yes' }; } } }), /LaunchConfirmer\(I0\)\.finish: contract: decision\.accepted/],
    ['consumer window', m => ({ LaunchConfirmer: class extends m.LaunchConfirmer { window() { return { from: 1.5, to: 30 }; } } }), /LaunchConfirmer\(I0\)\.window: contract: expected integer/],
    ['reassociated track', m => ({ reassociate: (h, ...a) => ({ ...m.reassociate(h, ...a), observations: 'none' }) }), /reassociate\(LI0\/0\): contract: track\.observations/],
    ['completion', m => ({ completeFlight: (...a) => ({ ...m.completeFlight(...a), slowMoFactor: 0 }) }), /completeFlight: contract: completion\.slowMoFactor/],
    ['display curve', m => ({ displayCurve: () => null }), /displayCurve: contract: curve: expected an array/]
  ];
  for (const [name, patch, re] of custom) {
    const sc = twoBalls(3), s = setup(sc, { impacts: bothImpacts(sc) });
    const r = await analyzeClip(s.source, { modules: { ...s.modules, ...patch(s.modules) }, onProgress: () => {} });
    assert.deepEqual(r.reasonCodes, ['internal_error'], name);
    assert.match(r.diagnostics.errors.join('\n'), re, name);
  }
  for (const [name, mock, re] of bad) {
    const { result: r, source, events } = await run(scene, mock);
    valid(r, scene);
    emptyAbstention(r);
    assert.deepEqual(r.reasonCodes, ['internal_error'], name);
    assert.match(r.diagnostics.errors.join('\n'), re, name);
    assert.equal(source.busy, false);
    assert.equal(source.stats.live, 0);
    assert.equal(events.at(-1).phase, 'done');
  }
  // a fit that diverged (NaN parameters) or masks the wrong observations is a contract violation, not a trace
  const fitOf = obs => ({ kind: 'm3d', params: [1], names: ['a'], cov: null, tau: 1, view: 'dtl', rmsNorm: 1, inlier: new Uint8Array(obs.length).fill(1), inlierFrac: 1,
    priorZMax: 0, converged: true, ill: false, landingT: null, predict: t => ({ t, x: 1, y: 1, cov: [1, 0, 1], d: 6, h: 1 }), sample: () => [] });
  for (const [name, fit, re] of [['NaN params', obs => ({ ...fitOf(obs), params: [NaN] }), /fitFlight\(LI0\/0\): contract: fit.params/],
    ['short inlier mask', obs => ({ ...fitOf(obs), inlier: new Uint8Array(obs.length - 1).fill(1) }), /fitFlight\(LI0\/0\): contract: inlier mask of 28 for 29/]]) {
    const s = setup(scene);
    const r = await analyzeClip(s.source, { modules: { ...s.modules, fitFlight: fit } });
    assert.deepEqual(r.reasonCodes, ['internal_error'], name);
    assert.match(r.diagnostics.errors[0], re, name);
    assert.ok(!s.calls.some(c => c.startsWith('decide')), `${name}: never decided on`);
  }
});

test('a missing collaborator gives engine_not_ready, only when it is needed', async () => {
  const scene = ballScene();
  const s = setup(scene);
  const r = await analyzeClip(s.source, { modules: { ...s.modules, decide: unavailableModule('decide', 'decide.js failed to load') } });
  valid(r, scene);
  assert.deepEqual(r.reasonCodes, ['engine_not_ready']);
  assert.match(r.diagnostics.errors[0], /decide.*unavailable/);
  assert.ok(s.calls.includes('complete 29'), 'everything before decide ran');
  const s2 = setup(scene, { impacts: () => [] });
  const r2 = await analyzeClip(s2.source, { modules: { ...s2.modules, LaunchConfirmer: unavailableModule('LaunchConfirmer', 'gone') } });
  assert.deepEqual(r2.reasonCodes, ['no_launch'], 'an unused missing module does not matter');
  const { decide, ...partial } = setup(scene).modules;
  const r3 = await analyzeClip(setup(scene).source, { modules: partial });
  assert.deepEqual(r3.reasonCodes, ['engine_not_ready'], 'a key missing from modules counts as unavailable');
});

test('source failures reject with an HFError (decode), never a result; a broken source contract too', async () => {
  const scene = ballScene();
  const cases = [
    ['decoder error mid-scan', { fail: k => k === 20 }, 'decode', /frame 20/],
    ['decoder error in the flight pass', { fail: (k, it) => it === 2 && k === 40 }, 'decode', /frame 40/],
    ['skipped frame', { skipAt: 7 }, 'decode', /yielded frame 8, expected 7/],
    ['wrong timestamp', { tOffsetAt: 5 }, 'decode', /t .* != meta.times/],
    ['a crop for another rect', { badCropAt: 35 }, 'decode', /frame 35 lumaRect: crop\[0\] does not match its request/],
    ['a coarse image at the wrong pool', { badCoarseAt: 3 }, 'decode', /frame 3 lumaCoarse: image 135×240 pool 2, expected pool 1/]
  ];
  for (const [name, so, code, re] of cases) {
    const s = setup(scene, {}, so), events = [];
    await assert.rejects(analyzeClip(s.source, { modules: s.modules, onProgress: p => events.push(p.phase) }), e => e instanceof HFError && e.code === code && re.test(e.message), name);
    assert.equal(s.source.busy, false, name);
    assert.equal(s.source.stats.live, 0, name);
    assert.ok(!events.includes('done'), name);
  }
  const closed = setup(scene);
  await closed.source.close();
  await assert.rejects(analyzeClip(closed.source, { modules: closed.modules }), e => e instanceof HFError && e.code === 'closed');
  const badMeta = { meta: { ...setup(scene).source.meta, times: new Float64Array(3) }, frames: () => {}, close: async () => {} };
  await assert.rejects(analyzeClip(badMeta, { modules: setup(scene).modules }), e => e instanceof HFError && e.code === 'decode' && /source.meta/.test(e.message));
  const s = setup(scene);
  await assert.rejects(analyzeClip(s.source, { modules: s.modules, onProgress: p => { if (p.phase === 'launch') throw new RangeError('ui'); } }), RangeError);
  assert.equal(s.source.busy, false);
});

/* ---------------------------------------------------------------- default modules */

test('defaultModules loads every unit file once and stubs what fails, so it fails only when used', async () => {
  const files = [...new Set(Object.values(MODULE_FILES))], seen = [];
  const fake = Object.fromEntries(Object.keys(MODULE_FILES).map(k => [k, function () { return k; }]));
  const all = await defaultModules({ load: async f => { seen.push(f); return fake; } });
  assert.deepEqual(seen.sort(), [...files].sort());
  assert.equal(files.length, 9);
  for (const k of Object.keys(MODULE_FILES)) assert.equal(all[k], fake[k], k);
  const some = await defaultModules({ load: f => f === 'decide.js' ? Promise.reject(new Error('404')) : f === 'complete.js' ? {} : fake });
  for (const k of ['decide', 'completeFlight']) {
    assert.equal(typeof some[k], 'function');
    assert.match(some[k].unavailable, k === 'decide' ? /decide\.js failed to load \(404\)/ : /complete\.js has no export completeFlight/);
    assert.throws(() => some[k](), e => e instanceof HFError && e.code === 'unsupported' && e.unavailable === k);
    assert.throws(() => new some[k](), e => e.unavailable === k);
  }
  assert.equal(some.fitFlight, fake.fitFlight);
  const sync = await defaultModules({ load: () => { throw new Error('sync'); } });
  assert.match(sync.CoarseScanner.unavailable, /sync/);
  // the real loader: whatever exists in dist/hf now; analyzeClip still returns a valid result
  const real = await defaultModules();
  assert.deepEqual(Object.keys(real).sort(), Object.keys(MODULE_FILES).sort());
  const present = files.filter(f => existsSync(new URL(`../dist/hf/${f}`, import.meta.url)));
  for (const [k, f] of Object.entries(MODULE_FILES)) if (!present.includes(f)) assert.ok(real[k].unavailable, `${k} unavailable while ${f} is missing`);
  const scene = ballScene({ n: 40 });
  const r = await analyzeClip(instrumentedSource({ width: scene.width, height: scene.height, plane: scene.plane, times: scene.times }));
  valid(r, scene);
  if (!present.includes('coarse-scan.js')) assert.deepEqual(r.reasonCodes, ['engine_not_ready'], 'the scanner is the first collaborator used');
});

/* ---------------------------------------------------------------- diagnostics */

test('diagnostics: detail on request, structured-cloneable, never a function', async () => {
  const scene = twoBalls(3);
  const { result } = await run(scene, { impacts: bothImpacts(scene), outliers: [45] }, { diagnostics: true });
  valid(result, scene);
  const d = result.diagnostics;
  assert.equal(d.paramsVersion, PARAMS_VERSION);
  assert.deepEqual(d.impacts.map(h => h.id), ['I0', 'I1']);
  assert.deepEqual(d.launches.map(l => [l.hypId, l.accepted, l.id]), [['I0', true, 'LI0'], ['I1', true, 'LI1']]);
  assert.equal(d.candidates.length, 2);
  assert.equal(d.candidates[0].fit.kind, 'm3d');
  assert.ok(d.candidates[0].track.observations.some(o => o.flag === 'rejected'));
  assert.equal(d.decision.status, 'tracked');
  assert.ok(['LI0', 'LI1'].includes(d.decision.selected));
  assert.deepEqual(Object.keys(d.counts).sort(), ['launch', 'scan', 'track']);
  const plain = (await run(scene, { impacts: bothImpacts(scene) })).result.diagnostics;
  assert.equal(plain.impacts, undefined, 'detail only on request');
  assert.ok(plain.ms.total > 0 && plain.counts.scan.frames === 60);
});

/* ---------------------------------------------------------------- performance (phone budget: x2.5-4 on phones) */

test('pipeline overhead per frame stays small at 1080×1920 and 2160×3840', async () => {
  const out = {};
  for (const [W, H] of [[1080, 1920], [2160, 3840]]) {
    const n = 90, plane = new Uint8Array(W * H).fill(60), fps = 30, T = Float64Array.from({ length: n }, (_, k) => k / fps);
    const hyp = makeImpact({ id: 'I0', spotId: 'S0', address: { x: W / 2, y: 0.8 * H }, d0: 20, polarity: 1, kLast: 30, tLast: T[30], kFirstAbsent: 31, tFirstAbsent: T[31], interval: { t0: T[30], t1: T[31] }, t0Est: (T[30] + T[31]) / 2 });
    const at = k => ({ x: W / 2 + 3 * (k - 30), y: 0.8 * H - 20 * (k - 30) + 0.2 * (k - 30) ** 2 });
    const ob = k => makeObservation({ index: k, t: T[k], ...at(k), sigma: 0.6, z: 8, polarity: 1, src: k < 34 ? 'launch' : 'tbd' });
    const rect = (k, s) => ({ x: Math.round(at(k).x) - s / 2, y: Math.round(at(k).y) - s / 2, w: s, h: s });
    const log = { make: null };
    const M = {
      CoarseScanner: class { constructor() { this.i = []; } push(i) { this.i.push(i); }
        finish() { const index = Int32Array.from(this.i), t = Float64Array.from(this.i, k => T[k]), sim = new Float64Array(4 * index.length).map((_, j) => (j % 4 ? 0 : 1));
          return make('CoarseLog', { pool: 2, w: 540, h: 960, stride: 1, frames: { index, t }, camera: { index, t, sim, inlier: new Float32Array(index.length).fill(1) }, spots: [], vacates: [], energy: { cellPx: 4, disk: () => ({}), active: () => 0 }, horizon: null, movers: [], specks: [] }); } },
      findImpacts: () => [hyp],
      LaunchConfirmer: class { constructor() { this.done = false; } window() { return { from: 23, to: 46 }; } roiRequests(k) { return [{ rect: { x: W / 2 - 192, y: 0.8 * H - 192, w: 384, h: 384 }, pool: 2, purpose: 'address' }]; } consume() {}
        finish() { const samples = [31, 32, 33].map(ob), d = { x: 3, y: -20 }, l = Math.hypot(d.x, d.y);
          return makeLaunchDecision({ hypId: 'I0', accepted: true, S: 12, Snull: [4], margin: 6.4, candidate: makeLaunchCandidate({ id: 'L0', hypId: 'I0', t0: hyp.t0Est, address: hyp.address, d0: 20, dir: { x: d.x / l, y: d.y / l }, v: l, c: 0, polarity: 1, samples, S: 12, margin: 6.4, view: 'dtl' }) }); } },
      RoiTube: class {},
      FlightTracker: class { constructor(L) { this.L = L; this.obs = []; this.done = false; } window() { return { from: 23, to: n }; }
        roiRequests(k) { return k > 30 ? [rect(k, 192), { ...rect(k, 192), x: rect(k, 192).x - 768 }, { ...rect(k, 192), x: rect(k, 192).x + 768 }].map((r, j) => ({ rect: r, pool: 1, purpose: j ? 'decoy' : 'main' })) : []; }
        consume(k) { if (k > 30) this.obs.push(ob(k)); }
        finish() { return [makeTrackHypothesis({ id: 'L0/0', launchId: 'L0', observations: this.obs, state: 'ended', observedEnd: 'clip_end' })]; } },
      reassociate: h => h,
      fitFlight: obs => makeFlightFit({ kind: 'm3d', params: [0], names: ['a'], cov: null, tau: 1, view: 'dtl', rmsNorm: 1, inlier: new Uint8Array(obs.length).fill(1), inlierFrac: 1, priorZMax: 0, converged: true, ill: false, landingT: null,
        predict: t => { const k = t * fps; return { t, ...at(k), cov: [1, 0, 1], d: 10, h: 1 }; }, sample: () => [] }),
      completeFlight: (fit, obs, ctx) => { const last = obs.at(-1).t, end = last + 0.6, p = fit.predict(end);
        return makeCompletion({ end: { type: 'landing', t: end, ...p }, observedEnd: ctx.observedEnd, tLastObs: last, observedSec: last - ctx.launch.t0, predictedSec: 0.6, slowMoFactor: 1, fade: { from: end - 0.25, to: end } }); },
      displayCurve: curveFor,
      decide: defaultDecide
    };
    const src = createMemorySource({ width: W, height: H, frames: () => plane, frameCount: n, fps });
    await analyzeClip(src, { modules: M });                                    // warm up
    const t = performance.now(), r = await analyzeClip(src, { modules: M });
    const wall = performance.now() - t, ms = r.diagnostics.ms, c = r.diagnostics.counts;
    assert.equal(r.status, 'tracked', JSON.stringify(r.diagnostics.errors));
    let pool = performance.now();                                             // the source alone, for the scan
    for await (const ref of src.frames()) await ref.lumaCoarse(960);
    pool = (performance.now() - pool) / n;
    out[`${W}x${H}`] = {
      scanMsPerFrame: +(ms.scan / c.scan.frames).toFixed(3), poolOnlyMsPerFrame: +pool.toFixed(3),
      launchMsPerFrame: +(ms.launch / c.launch.frames).toFixed(3), trackMsPerFrame: +(ms.track / c.track.frames).toFixed(3),
      fitMs: +ms.fit.toFixed(2), decideCurveAssembleMs: +(ms.decide).toFixed(2), points: r.points.length, wallMs: +wall.toFixed(1)
    };
    // loose bounds (like U0's): only pathological regressions fail on a loaded machine; the numbers are logged
    assert.ok(ms.track / c.track.frames < 20 && ms.launch / c.launch.frames < 20 && ms.scan / c.scan.frames < 60 && ms.decide < 200, JSON.stringify(out[`${W}x${H}`]));
  }
  console.log('hf-pipeline ms', JSON.stringify(out));
});
