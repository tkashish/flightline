import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, PARAMS_VERSION, spanFrames, scanStride, mergeParams } from '../dist/hf/params.js';
import {
  RESULT_ENGINE, REASON_CODES, STATUSES, SCHEMAS, HFError, throwIfAborted, check, make, makeObservation,
  makeLaunchCandidate, makeLaunchDecision, makeDecision, makeImpact, makeSourceMeta, makeProgress, makeConfidence,
  makeAbstention, reasonErrors, timingFromTimes, frameAt, curveStatus, IDENTITY_SIM, applySim, invertSim, composeSim, simAt,
  stabToRaw, rawToStab, identityTrack, makeFlightFit, makeCoarseLog, makeFlightCandidate, toNormalized, fromNormalized, sigmaToNormalized, coarsePool, cameraSamples, cameraToRaw,
  poolLuma, cropLuma, createMemorySource, isDowngradeOrSame, exampleResult, validateResult, assertResult
} from '../dist/hf/types.js';
import { ENGINE_ID, runHF } from '../dist/hf/engine.js';
import { normalizeTrackReport } from '../dist/track-status.js';

const DIMS = { width: 1080, height: 1920, fps: 30 };
const clone = v => structuredClone(v);
const errorsOf = (r, opts) => validateResult(r, opts).errors.join('\n');
function invalid(r, re, opts = DIMS) {
  const { ok, errors } = validateResult(r, opts);
  assert.equal(ok, false, `expected invalid (${re})`);
  assert.match(errors.join('\n'), re);
}
function valid(r, opts = DIMS) {
  const { ok, errors } = validateResult(r, opts);
  assert.ok(ok, errors.join('\n'));
}
const plane = (w, h, f) => Uint8Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
const sampleAt = (r, t) => r.points.findIndex(p => Math.abs(p.t - t) <= 1e-6);

/* ---------------------------------------------------------------- params */

test('PARAMS is deeply frozen and versioned', () => {
  assert.match(PARAMS_VERSION, /^hf-params-\d+$/);
  assert.throws(() => { PARAMS.launch.nulls.factor = 2; }, TypeError);
  assert.throws(() => { PARAMS.launch.nulls.fakeImpactFrames.push(30); }, TypeError);
  assert.throws(() => { PARAMS.scan.candidates.dogRadii[0][0] = 9; }, TypeError);
  assert.equal(PARAMS.launch.nulls.factor, 1.15);
});

test('every PARAMS leaf is a finite number, boolean or non-empty string', () => {
  const walk = (v, path) => {
    if (Array.isArray(v) || (v && typeof v === 'object')) { for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`); return; }
    assert.ok(Number.isFinite(v) || typeof v === 'boolean' || (typeof v === 'string' && v.length), `${path} = ${v}`);
  };
  walk(PARAMS, 'PARAMS');
});

test('PARAMS pins the binding FINAL.md values', () => {
  const pins = [
    ['scan.longEdge', 960], ['scan.maxRateHz', 60], ['launch.window.preSec', 0.25], ['launch.window.postSec', 0.5],
    ['launch.nulls.factor', 1.15], ['launch.nulls.offset', 1], ['launch.nulls.anchorOffsetW', 0.22],
    ['launch.singleSample.enabled', false], ['launch.singleSample.minZ', 7], ['launch.singleSample.maxHoldoutClubAccept', 0.01],
    ['launch.club.leadRatio', [1.1, 2.2]], ['roi.bgLagRadii', 2.5], ['roi.tbd.J', 3], ['track.reacquire', [3, 5]],
    ['decide.r2MinObs', 8], ['decide.r2MinRealSec', 0.15], ['decide.bulkMinConfidence', 0.9],
    ['display.hz', 120], ['display.withinSigma', 1.5], ['display.observedHalfFrame', 0.5], ['result.maxPointGapSec', 1 / 60],
    ['confidence.calibratedOn', 'synthetic-tune-v1'],
    ['confidence.maxParams', 6], ['pipeline.flightPreSec', 0.25], ['acceptance.safety.maxWrongGivenTraced', 0.01],
    ['acceptance.safety.maxClubFalseTrack', 0.005], ['acceptance.safety.maxNoBallFalseTrace', 0.01],
    ['acceptance.safety.minInvisibleAbstain', 0.98], ['launch.gates.llrClampNats', 3], ['fit.focalComponents', [1, 0.5, 2]]
  ];
  for (const [path, want] of pins) assert.deepEqual(path.split('.').reduce((o, k) => o[k], PARAMS), want, path);
});

test('spanFrames takes max(frames, seconds), converts real seconds with tau, and caps', () => {
  assert.equal(spanFrames({ frames: 8, sec: 0.25 }, 30), 8);           // 7.5 -> 8, ties with frames
  assert.equal(spanFrames({ frames: 8, sec: 0.25 }, 60), 15);          // seconds win
  assert.equal(spanFrames({ frames: 8, sec: 0.3 }, 30), 9);            // exact 9.0 stays 9
  assert.equal(spanFrames({ sec: 1.1 }, 50), 55);                      // 1.1·50 = 55.00000000000001 is still 55 frames
  assert.equal(spanFrames({ frames: 8, realSec: 0.25 }, 30, 8), 60);   // 0.25 s real = 2 s video at tau 8
  assert.equal(spanFrames({ frames: 8, realSec: 0.25 }, 30), 8);
  assert.equal(spanFrames({ frames: 6, sec: 0.2, maxFrames: 16 }, 240), 16);
  assert.equal(spanFrames({ frames: 6, sec: 0.2, maxFrames: 16 }, 25), 6);
});

test('scanStride decimates only above 60 fps', () => {
  assert.deepEqual([24, 30, 59.94, 60, 120, 240].map(f => scanStride(f)), [1, 1, 1, 1, 2, 4]);
});

test('mergeParams overrides, freezes, and rejects typos and type changes', () => {
  const p = mergeParams({ launch: { nulls: { factor: 1.3 } }, decide: { r2MinObs: 6 } });
  assert.equal(p.launch.nulls.factor, 1.3);
  assert.equal(p.launch.nulls.offset, 1);
  assert.equal(p.decide.r2MinObs, 6);
  assert.equal(PARAMS.launch.nulls.factor, 1.15);
  assert.ok(Object.isFrozen(p.launch.nulls));
  assert.throws(() => mergeParams({ launch: { nulls: { factr: 1.3 } } }), /unknown/);
  assert.throws(() => mergeParams({ decide: { r2MinObs: '8' } }), /expected number/);
  assert.throws(() => mergeParams({ launch: { singleSample: { enabled: 1 } } }), /expected boolean/);
});

/* ---------------------------------------------------------------- time and coordinates */

test('timingFromTimes finds nominal fps, VFR and duration', () => {
  const cfr = Float64Array.from({ length: 31 }, (_, i) => i / 30);
  const t = timingFromTimes(cfr);
  assert.ok(Math.abs(t.fps - 30) < 1e-9);
  assert.equal(t.vfr, false);
  assert.ok(Math.abs(t.duration - 31 / 30) < 1e-9);
  const jitter = Float64Array.from({ length: 41 }, (_, i) => i / 30 + (i % 2 ? 0.006 : 0));
  assert.equal(timingFromTimes(jitter).vfr, true);
  assert.deepEqual(timingFromTimes(new Float64Array(0)), { fps: 30, vfr: false, duration: 0 });
});

test('frameAt returns the frame shown at a time', () => {
  const times = [0, 0.1, 0.2, 0.3];
  assert.equal(frameAt(times, -0.01), -1);
  assert.equal(frameAt(times, 0), 0);
  assert.equal(frameAt(times, 0.15), 1);
  assert.equal(frameAt(times, 0.2), 2);
  assert.equal(frameAt(times, 9), 3);
});

test('curveStatus: predicted after the last observation, observed within half a frame, else interpolated', () => {
  const obs = [1, 1 + 1 / 30, 1 + 4 / 30], half = 0.5 / 30;
  assert.equal(curveStatus(1 + 1 / 60, obs, half), 'observed');               // exactly half a frame away
  assert.equal(curveStatus(1 + 1 / 30 + 1 / 60 + 0.001, obs, half), 'interpolated');
  assert.equal(curveStatus(1 + 4 / 30, obs, half), 'observed');
  assert.equal(curveStatus(1 + 4 / 30 + 0.001, obs, half), 'predicted');      // after the last one, even if near it
  assert.equal(curveStatus(1 - 0.02, obs, half), 'interpolated');
  assert.equal(curveStatus(1 - 0.01, obs, half), 'observed');
});

test('similarities apply, invert, compose and interpolate along a camera track', () => {
  const s = { a: 0.99 * Math.cos(0.02), b: 0.99 * Math.sin(0.02), tx: 12.5, ty: -7 };
  const p = applySim(s, 300, 900), back = applySim(invertSim(s), p.x, p.y);
  assert.ok(Math.abs(back.x - 300) < 1e-9 && Math.abs(back.y - 900) < 1e-9);
  const q = { a: 1.01, b: -0.01, tx: -3, ty: 4 }, pq = composeSim(s, q), viaQ = applySim(q, 10, 20), viaS = applySim(s, viaQ.x, viaQ.y);
  const direct = applySim(pq, 10, 20);
  assert.ok(Math.abs(direct.x - viaS.x) < 1e-9 && Math.abs(direct.y - viaS.y) < 1e-9);
  assert.deepEqual(applySim(IDENTITY_SIM, 5, 6), { x: 5, y: 6 });
  const track = { index: Int32Array.from([0, 2, 6]), t: Float64Array.from([0, 2 / 30, 6 / 30]), sim: Float64Array.from([1, 0, 0, 0, 1, 0, 4, 0, 1, 0, 4, 8]), inlier: Float32Array.from([1, 1, 1]) };
  assert.deepEqual(simAt(track, 2), { a: 1, b: 0, tx: 4, ty: 0 });
  assert.deepEqual(simAt(track, 1), { a: 1, b: 0, tx: 2, ty: 0 });
  assert.deepEqual(simAt(track, 4), { a: 1, b: 0, tx: 4, ty: 4 });
  assert.deepEqual(simAt(track, 99), { a: 1, b: 0, tx: 4, ty: 8 });
  assert.deepEqual(simAt(track, -5), { a: 1, b: 0, tx: 0, ty: 0 });
  const raw = stabToRaw(track, 4, 100, 100), stab = rawToStab(track, 4, raw.x, raw.y);
  assert.deepEqual(raw, { x: 104, y: 104 });
  assert.deepEqual(stab, { x: 100, y: 100 });
  assert.equal(check('CameraTrack', track).length, 0);
  assert.match(check('CameraTrack', { ...track, sim: new Float64Array(8) }).join(), /lengths disagree/);
});

test('identityTrack is a valid static CameraTrack and named constructors validate their types', () => {
  const src = memSource(5), track = identityTrack(src.meta);
  assert.deepEqual(check('CameraTrack', track), []);
  assert.deepEqual(simAt(track, 3), { a: 1, b: 0, tx: 0, ty: 0 });
  assert.deepEqual([...identityTrack(src.meta, [0, 2, 4]).t], [0, 2 / 30, 4 / 30]);
  assert.deepEqual(cameraSamples(track, src.meta)[4], { t: 4 / 30, x: 0, y: 0, s: 1, r: 0 });
  const fit = { kind: 'm3d', params: [1, 2], names: ['a', 'b'], cov: [1, 0, 0, 1], tau: 1, view: 'dtl', rmsNorm: 0.8, inlier: new Uint8Array(3), inlierFrac: 1,
    priorZMax: 0.4, converged: true, ill: false, landingT: null, predict: t => ({ t, x: 0, y: 0, cov: [1, 0, 1], d: 2, h: null }), sample: () => [] };
  assert.equal(makeFlightFit(fit).tau, 1);
  assert.deepEqual(check('FitPrediction', fit.predict(1)), []);
  assert.throws(() => makeFlightFit({ ...fit, cov: [1, 0, 0] }), /expected 2×2/);
  assert.throws(() => makeFlightFit({ ...fit, names: ['a'] }), /names: length != params/);
  const energy = { cellPx: 8, disk: () => ({ index: new Int32Array(0), e: new Float32Array(0) }), active: () => 0 };
  const log = makeCoarseLog({ pool: 2, w: 24, h: 16, stride: 1, frames: { index: track.index, t: track.t }, camera: track, spots: [], vacates: [], energy, horizon: null, movers: [], specks: [] });
  assert.equal(log.pool, 2);
  assert.throws(() => makeCoarseLog({ ...log, camera: { ...track, sim: new Float64Array(3) } }), /lengths disagree/);
  assert.throws(() => makeFlightCandidate({}), /impact/);
});

test('cameraSamples keep the v2 translation convention and round-trip a full similarity', () => {
  const meta = { width: 1080, height: 1920 };
  const shift = { index: Int32Array.from([0, 1]), t: Float64Array.from([0, 1 / 30]), sim: Float64Array.from([1, 0, 0, 0, 1, 0, 54, -96]), inlier: Float32Array.from([1, 1]) };
  const [c0, c1] = cameraSamples(shift, meta);
  assert.deepEqual(c0, { t: 0, x: 0, y: 0, s: 1, r: 0 });
  assert.ok(Math.abs(c1.x - 0.05) < 1e-12 && Math.abs(c1.y + 0.05) < 1e-12 && c1.s === 1 && c1.r === 0);
  const a = 1.02 * Math.cos(0.03), b = 1.02 * Math.sin(0.03);
  const track = { index: Int32Array.from([0, 5]), t: Float64Array.from([0, 5 / 30]), sim: Float64Array.from([1, 0, 0, 0, a, b, 31, -17]), inlier: Float32Array.from([1, 0.8]) };
  const cs = cameraSamples(track, meta)[1];
  for (const [x, y] of [[100, 200], [540, 960], [1000, 1800], [-50, 30]]) {
    const raw = stabToRaw(track, 5, x, y), n = toNormalized(x, y, meta), viaSample = cameraToRaw(cs, n.x, n.y, meta.width, meta.height);
    assert.ok(Math.abs(viaSample.x * meta.width - raw.x) < 1e-6 && Math.abs(viaSample.y * meta.height - raw.y) < 1e-6);
  }
  assert.deepEqual(cameraToRaw({ t: 0, x: 0.1, y: -0.2 }, 0.3, 0.4, 100, 50), { x: 0.4, y: 0.2 });
});

test('normalized conversions and coarse pooling factors', () => {
  const meta = { width: 1080, height: 1920 };
  assert.deepEqual(toNormalized(540, 480, meta), { x: 0.5, y: 0.25 });
  assert.deepEqual(fromNormalized(0.5, 0.25, meta), { x: 540, y: 480 });
  assert.ok(Math.abs(sigmaToNormalized(Math.hypot(1080, 1920), meta) - 1) < 1e-12);
  assert.deepEqual([[1080, 1920], [2160, 3840], [1920, 1080], [1280, 720], [1440, 2560], [720, 1280]].map(([w, h]) => coarsePool(w, h, 960)), [2, 4, 2, 1, 3, 1]);
});

/* ---------------------------------------------------------------- reference luma */

test('poolLuma takes rounded block means and drops partial blocks', () => {
  const src = Uint8Array.from([
    0, 1, 2, 3, 9,
    4, 5, 6, 8, 9,
    10, 20, 30, 40, 9,
    9, 9, 9, 9, 9
  ]);
  const p = poolLuma(src, 5, 4, 2);
  assert.deepEqual([p.w, p.h, p.pool], [2, 2, 2]);
  assert.deepEqual([...p.data], [3, 5, 12, 22]);            // (0+1+4+5+2)/4=3, (2+3+6+8+2)/4=4.75->5 floor(21/4)=5
  const q = poolLuma(src, 5, 4, 3);
  assert.deepEqual([q.w, q.h, [...q.data]], [1, 1, [Math.floor((0 + 1 + 2 + 4 + 5 + 6 + 10 + 20 + 30 + 4) / 9)]]);
  const out = new Uint8Array(10), r = poolLuma(src, 5, 4, 2, out);
  assert.equal(r.data.buffer, out.buffer);
  assert.equal(r.data.length, 4);
  assert.deepEqual([...poolLuma(src, 5, 4, 1).data], [...src]);
  assert.throws(() => poolLuma(src, 5, 4, 0), HFError);
  assert.throws(() => poolLuma(src, 5, 4, 2, new Uint8Array(3)), /out buffer/);
});

test('poolLuma fast paths equal the naive block mean (pools 2-5, aligned and unaligned rows)', () => {
  const naive = (src, W, H, k) => {
    const w = Math.floor(W / k), h = Math.floor(H / k), out = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) s += src[(j * k + y) * W + i * k + x];
      out[j * w + i] = Math.floor((s + Math.floor(k * k / 2)) / (k * k));
    }
    return out;
  };
  for (const [W, H] of [[64, 40], [66, 42], [37, 23]]) {
    const backing = Uint8Array.from({ length: W * H + 4 }, (_, i) => (i * 2654435761) >>> 24);
    for (const offset of [0, 1, 4]) {
      const src = backing.subarray(offset, offset + W * H);
      for (const k of [2, 3, 4, 5]) assert.deepEqual([...poolLuma(src, W, H, k).data], [...naive(src, W, H, k)], `${W}x${H} offset ${offset} pool ${k}`);
    }
  }
});

test('cropLuma matches direct slices, pools like poolLuma, clamps outside pixels and reports valid pixels', () => {
  const W = 40, H = 30, src = plane(W, H, (x, y) => (x * 7 + y * 13) % 251);
  const c = cropLuma(src, W, H, { x: 5, y: 6, w: 8, h: 4 });
  for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) assert.equal(c.data[j * 8 + i], src[(6 + j) * W + 5 + i]);
  assert.deepEqual(c.valid, { x0: 0, y0: 0, x1: 8, y1: 4 });
  const pooled = cropLuma(src, W, H, { x: 0, y: 0, w: W, h: H }, 2);
  assert.deepEqual([...pooled.data], [...poolLuma(src, W, H, 2).data]);
  const out = cropLuma(src, W, H, { x: -5, y: -3, w: 10, h: 6 }, 2);
  assert.deepEqual([out.w, out.h], [5, 3]);
  assert.deepEqual(out.valid, { x0: 3, y0: 2, x1: 5, y1: 3 });
  assert.equal(out.data[0], src[0]);                         // all-outside block clamps to the corner pixel
  const right = cropLuma(src, W, H, { x: 35, y: 25, w: 10, h: 10 }, 1);
  assert.deepEqual(right.valid, { x0: 0, y0: 0, x1: 5, y1: 5 });
  assert.equal(right.data[9 * 10 + 9], src[(H - 1) * W + W - 1]);
  const away = cropLuma(src, W, H, { x: 100, y: 100, w: 4, h: 4 });
  assert.equal(away.valid.x1 - away.valid.x0, 0);
  assert.throws(() => cropLuma(src, W, H, { x: 0.5, y: 0, w: 4, h: 4 }), /expected int/);
  assert.throws(() => cropLuma(src, W, H, { x: 0, y: 0, w: 3, h: 3 }, 4), HFError);
});

test('crop coordinates map to native px as x0 + pool·u', () => {
  const W = 64, H = 48, X = 37, Y = 21, src = plane(W, H, (x, y) => x === X && y === Y ? 255 : 0);
  for (const pool of [1, 2, 3, 4]) {
    const rect = { x: 9, y: 2, w: 48, h: 36 }, c = cropLuma(src, W, H, rect, pool);
    const k = c.data.findIndex(v => v > 0), u = k % c.w, v = Math.floor(k / c.w);
    assert.equal(u, Math.floor((X - rect.x) / pool), `pool ${pool}`);
    assert.equal(v, Math.floor((Y - rect.y) / pool), `pool ${pool}`);
    assert.ok(X >= c.x0 + pool * u && X < c.x0 + pool * (u + 1));
  }
});

/* ---------------------------------------------------------------- in-memory FrameSource */

function memSource(n = 6, opts = {}) {
  const W = 48, H = 32;
  return createMemorySource({ width: W, height: H, frames: Array.from({ length: n }, (_, k) => plane(W, H, (x, y) => (x + y + 10 * k) % 256)), ...opts });
}

test('memory source meta satisfies SourceMeta and frames honour from, to and stride', async () => {
  const src = memSource(7, { fps: 60 });
  assert.deepEqual(check('SourceMeta', src.meta), []);
  assert.deepEqual(check('FrameSource', src), []);
  assert.equal(src.meta.frameCount, 7);
  assert.ok(Math.abs(src.meta.fps - 60) < 1e-9);
  const seen = [];
  for await (const ref of src.frames({ from: 1, to: 6, stride: 2 })) {
    assert.deepEqual(check('FrameRef', ref), []);
    seen.push([ref.index, ref.t]);
  }
  assert.deepEqual(seen, [[1, 1 / 60], [3, 3 / 60], [5, 5 / 60]]);
  const all = [];
  for await (const ref of src.frames({ to: 99 })) all.push(ref.index);
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6]);
  const rot = createMemorySource({ width: 4, height: 8, rotation: 90, frames: [new Uint8Array(32)] });
  assert.deepEqual([rot.meta.codedWidth, rot.meta.codedHeight], [8, 4]);
});

test('advancing the iterator closes the previous FrameRef', async () => {
  const src = memSource(3), refs = [];
  for await (const ref of src.frames()) {
    refs.push(ref);
    const img = await ref.lumaCoarse(24);
    assert.deepEqual(check('LumaImage', img), []);
    assert.equal(img.pool, 2);
  }
  for (const ref of refs) await assert.rejects(ref.lumaCoarse(24), e => e.code === 'closed');
  const first = refs[0];
  await assert.rejects(first.lumaRect({ x: 0, y: 0, w: 4, h: 4 }), e => e.code === 'closed');
});

test('one live iteration at a time; sources are re-iterable and closable', async () => {
  const src = memSource(4), it = src.frames()[Symbol.asyncIterator]();
  await it.next();
  await assert.rejects(src.frames()[Symbol.asyncIterator]().next(), e => e.code === 'busy');
  await it.return();
  const again = [];
  for await (const ref of src.frames()) again.push(ref.index);
  assert.deepEqual(again, [0, 1, 2, 3]);
  for await (const ref of src.frames()) { if (ref.index === 1) break; }
  for await (const ref of src.frames({ from: 3 })) assert.equal(ref.index, 3);   // break released the source
  await src.close();
  await assert.rejects(src.frames()[Symbol.asyncIterator]().next(), e => e.code === 'closed');
  await assert.rejects(memSource().frames({ stride: 0 })[Symbol.asyncIterator]().next(), e => e.code === 'bad-arg');
});

test('aborting stops the iteration with an AbortError', async () => {
  const src = memSource(10), ac = new AbortController(), seen = [];
  await assert.rejects((async () => {
    for await (const ref of src.frames({ signal: ac.signal })) { seen.push(ref.index); if (ref.index === 2) ac.abort(); }
  })(), e => e.name === 'AbortError');
  assert.deepEqual(seen, [0, 1, 2]);
  assert.throws(() => throwIfAborted(ac.signal), e => e.name === 'AbortError');
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
});

test('FrameRef luma methods equal the reference functions', async () => {
  const W = 50, H = 30, data = plane(W, H, (x, y) => (x * 31 + y * 17) % 256);
  const src = createMemorySource({ width: W, height: H, frames: [data] });
  for await (const ref of src.frames()) {
    const coarse = await ref.lumaCoarse(20);
    assert.deepEqual([...coarse.data], [...poolLuma(data, W, H, coarsePool(W, H, 20)).data]);
    const crop = await ref.lumaRect({ x: -3, y: 4, w: 12, h: 9 }, { pool: 3 });
    assert.deepEqual(crop, cropLuma(data, W, H, { x: -3, y: 4, w: 12, h: 9 }, 3));
    assert.deepEqual(check('LumaCrop', crop), []);
  }
  assert.throws(() => createMemorySource({ width: 4, height: 4, frames: () => new Uint8Array(16) }), /needs frameCount/);
  const gen = createMemorySource({ width: 4, height: 4, frames: k => new Uint8Array(16).fill(k), frameCount: 3 });
  assert.equal(gen.meta.frameCount, 3);
  const broken = createMemorySource({ width: 4, height: 4, frames: [new Uint8Array(3)] });
  await assert.rejects(broken.frames()[Symbol.asyncIterator]().next(), e => e.code === 'bad-arg');
});

/* ---------------------------------------------------------------- schemas and constructors */

test('constructors apply defaults and report every bad field with its path', () => {
  const o = makeObservation({ index: 31, t: 31 / 30, x: 540, y: 1500, sigma: 0.5, z: 6.2, polarity: 1 });
  assert.equal(o.flag, 'inlier');
  assert.equal(o.src, 'tbd');
  assert.equal(o.z1, null);
  assert.throws(() => makeObservation({ index: 31, t: 1, x: 5, y: NaN, sigma: 0, z: 1, polarity: 2 }), e => {
    assert.match(e.message, /Observation\.y: expected num/);
    assert.match(e.message, /Observation\.sigma: expected pos/);
    assert.match(e.message, /Observation\.polarity: 2 not in POLARITIES/);
    return e instanceof HFError && e.code === 'bad-arg';
  });
  assert.throws(() => makeObservation({ index: 1, t: 1, x: 1, y: 1, sigma: 1, z: 1, polarity: 1, cov: [1, 0] }), /expected \[sxx, sxy, syy\]/);
  assert.throws(() => make('Nope', {}), /unknown type/);
  assert.deepEqual(makeProgress('scan', 3, 10), { phase: 'scan', done: 3, total: 10 });
  assert.throws(() => makeProgress('scan', 11, 10), /done > total/);
  assert.throws(() => makeProgress('warmup', 1, 1), /not in PROGRESS_PHASES/);
  assert.equal(makeConfidence(0.5).calibratedOn, 'uncalibrated');
  assert.throws(() => makeConfidence(1.5), /expected frac/);
  assert.throws(() => makeConfidence(0.5, {}, 'synthetic-v9'), /not in CALIBRATIONS/);
  assert.throws(() => makeConfidence(0.5, { margin: 'big' }), /not a finite number/);
});

const sample = (k, extra = {}) => makeObservation({ index: k, t: k / 30, x: 500 + k, y: 1500 - 9 * k, sigma: 0.6, z: 7, polarity: 1, src: 'launch', ...extra });
const candidate = (extra = {}) => makeLaunchCandidate({
  id: 'L1', hypId: 'I1', t0: 30.4 / 30, address: { x: 500, y: 1500 }, d0: 22, dir: { x: 0.1, y: -Math.sqrt(0.99) },
  v: 30, c: 0.05, polarity: 1, samples: [sample(31), sample(32)], S: 9, margin: 2, ...extra
});

test('launch candidates: unit direction, t0 before the first sample, enough samples', () => {
  assert.equal(candidate().view, 'unknown');
  assert.throws(() => candidate({ dir: { x: 1, y: 1 } }), /not a unit vector/);
  assert.throws(() => candidate({ t0: 31.5 / 30 }), /must precede the first sample/);
  assert.throws(() => candidate({ samples: [sample(31)] }), /too few/);
  assert.equal(candidate({ samples: [sample(31)], single: true }).single, true);
  assert.throws(() => candidate({ samples: [sample(32), sample(31)] }), /not sorted/);
});

test('launch decisions: a candidate exactly when accepted, null margin >= 0, abstain reason when rejected', () => {
  assert.equal(makeLaunchDecision({ hypId: 'I1', accepted: true, candidate: candidate(), S: 9, Snull: [5], margin: 2.25 }).accepted, true);
  assert.throws(() => makeLaunchDecision({ hypId: 'I1', accepted: true, S: 9, Snull: [5], margin: 2 }), /exactly when accepted/);
  assert.throws(() => makeLaunchDecision({ hypId: 'I1', accepted: true, candidate: candidate(), S: 6, Snull: [5], margin: -0.75 }), /1\.15/);
  assert.throws(() => makeLaunchDecision({ hypId: 'I1', accepted: false, S: 2, margin: -4, reason: 'multiple_shots' }), /abstain code/);
  assert.throws(() => makeLaunchDecision({ hypId: 'I1', accepted: false, S: 2, margin: -4 }), /abstain code/);
  assert.equal(makeLaunchDecision({ hypId: 'I1', accepted: false, S: 2, margin: -4, reason: 'launch_not_confirmed' }).candidate, null);
});

test('impacts keep t0Est inside the interval; source meta needs increasing times', () => {
  const hyp = { id: 'I1', spotId: 'S1', address: { x: 500, y: 1500 }, d0: 22, polarity: 1, kLast: 30, tLast: 1, kFirstAbsent: 31, tFirstAbsent: 31 / 30, interval: { t0: 0.99, t1: 1.04 }, t0Est: 1.01 };
  assert.equal(makeImpact(hyp).tauPrior.weights.reduce((a, b) => a + b), 1);
  assert.throws(() => makeImpact({ ...hyp, t0Est: 1.2 }), /outside the impact interval/);
  assert.throws(() => makeImpact({ ...hyp, kFirstAbsent: 30 }), /must follow kLast/);
  assert.throws(() => makeImpact({ ...hyp, tauPrior: { modes: [1, 8], weights: [0.5, 0.4] } }), /sum to 1/);
  const meta = { width: 8, height: 8, fps: 30, frameCount: 3, times: Float64Array.from([0, 0.1, 0.1]), duration: 0.2 };
  assert.throws(() => makeSourceMeta(meta), /not strictly increasing/);
  assert.throws(() => makeSourceMeta({ ...meta, times: Float64Array.from([0, 0.1]) }), /length 2 != frameCount 3/);
  assert.equal(makeSourceMeta({ ...meta, times: Float64Array.from([0, 0.1, 0.2]) }).codedWidth, 8);
});

test('decisions allow completion only with R1 and R2, and tracked needs R1-R5', () => {
  const impact = makeImpact({ id: 'I1', spotId: 'S1', address: { x: 500, y: 1500 }, d0: 22, polarity: 1, kLast: 30, tLast: 1, kFirstAbsent: 31, tFirstAbsent: 31 / 30, interval: { t0: 0.99, t1: 1.04 }, t0Est: 1.01 });
  const decision = makeLaunchDecision({ hypId: 'I1', accepted: true, candidate: candidate(), S: 9, Snull: [5], margin: 2.25 });
  const selected = make('FlightCandidate', { impact, decision, launch: candidate() });
  const rules = { R1: true, R2: true, R3: true, R4: true, R5: true };
  const base = { status: 'tracked', reasonCodes: [], selected, allowCompletion: true, rules, confidence: makeConfidence(0.9) };
  assert.equal(makeDecision(base).status, 'tracked');
  assert.throws(() => makeDecision({ ...base, status: 'partial', rules: { ...rules, R2: false } }), /needs R1 \(launch\) and R2/);
  assert.throws(() => makeDecision({ ...base, status: 'partial', rules: { ...rules, R1: false } }), /needs R1 \(launch\) and R2/);
  assert.throws(() => makeDecision({ ...base, rules: { ...rules, R5: false }, allowCompletion: false }), /tracked needs R1-R5/);
  assert.throws(() => makeDecision({ ...base, status: 'no_reliable_track', reasonCodes: ['no_launch'], selected: null }), /cannot allow completion/);
  assert.throws(() => makeDecision({ ...base, reasonCodes: ['made_up'] }), /unknown/);
  assert.throws(() => makeDecision({ ...base, reasonCodes: ['no_launch'] }), /tracked cannot carry abstain reasons/);
  assert.throws(() => makeDecision({ ...base, status: 'partial', allowCompletion: false, reasonCodes: ['multiple_shots'] }), /partial needs a partial reason/);
  assert.equal(makeDecision({ ...base, status: 'partial', allowCompletion: false, reasonCodes: ['tracking_ended_early'] }).status, 'partial');
  assert.deepEqual(reasonErrors('tracked', ['multiple_shots']), []);
  assert.throws(() => make('FlightCandidate', { impact, decision: makeLaunchDecision({ hypId: 'I1', accepted: false, S: 1, margin: -5, reason: 'launch_not_confirmed' }), launch: candidate() }), /accepted decision/);
});

test('every schema field spec is well formed', () => {
  const prims = /^(num|int|nat|posint|pos|frac|bool|str|fn|obj|arr|nums|xy|f64|f32|i32|u8|i8)$/;
  for (const [name, fields] of Object.entries(SCHEMAS)) {
    for (const [k, spec] of Object.entries(fields)) {
      const s = spec.replace(/\?$/, '').replace(/\|null$/, '');
      const ok = prims.test(s) || (s[0] === '#') || (s[0] === '@' && SCHEMAS[s.slice(1).replace(/\[\]$/, '')]);
      assert.ok(ok, `${name}.${k}: ${spec}`);
    }
  }
});

/* ---------------------------------------------------------------- the result contract */

test('example results and a runHF result (real collaborators, tiny clip) satisfy the contract', async () => {
  for (const kind of ['tracked', 'partial-a', 'partial-b', 'abstain']) { valid(exampleResult(kind)); valid(exampleResult(kind), {}); }
  valid(await runHF(memSource()), { width: 48, height: 32, fps: 30 });
  const ex = exampleResult('tracked');
  assert.deepEqual(new Set(ex.points.map(p => p.status)), new Set(['anchor', 'observed', 'interpolated', 'predicted']));
  assert.deepEqual(structuredClone(ex), ex);
  assert.throws(() => makeAbstention(['multiple_shots']), /abstain reason/);
  assert.throws(() => makeAbstention(['nope']), /unknown reason/);
  assert.deepEqual(makeAbstention(['no_launch', 'no_launch', 'slow_decode_path']).reasonCodes, ['no_launch', 'slow_decode_path']);
});

test('example results stay valid at any frame rate and frame size', () => {
  for (const kind of ['tracked', 'partial-a', 'partial-b']) {
    for (const fps of [24, 29.97, 60, 120, 240]) {
      for (const [width, height] of [[1920, 1080], [2160, 3840]]) valid(exampleResult(kind, { width, height, fps }), { width, height, fps });
    }
  }
  assert.throws(() => exampleResult('nope'), /unknown example/);
});

test('no_reliable_track has no points, no observations and no completion', () => {
  const r = exampleResult('tracked');
  r.status = 'no_reliable_track'; r.reasonCodes = ['identity_conflict'];
  invalid(r, /no_reliable_track must have points = \[\]/);
  invalid(r, /no_reliable_track must have observations = \[\]/);
  invalid(r, /no_reliable_track must have completion = null/);
  const a = makeAbstention(['no_launch']);
  a.observations = [{ t: 1, x: 0.5, y: 0.5, sigma: 0.001 }]; a.observedFrames = 1;
  invalid(a, /no_reliable_track must have observations = \[\]/);
  invalid(a, /observations without a curve/);
  const c = makeAbstention(['flight_inconsistent']);
  c.completion = clone(exampleResult('tracked').completion);
  invalid(c, /no_reliable_track must have completion = null/);
});

test('arc completion needs a confirmed launch', () => {
  const r = exampleResult('tracked');
  r.launch = null;
  invalid(r, /completion needs a confirmed launch/);
  invalid(r, /a curve needs a confirmed launch/);
});

test('arc completion needs flight-confirmed identity: >= 8 observations over >= 0.15 s real, or a frame exit', () => {
  const keep = n => {
    const r = exampleResult('tracked');
    r.observations = r.observations.slice(-n); r.observedFrames = n;
    return r;
  };
  valid(keep(8), { width: 1080, height: 1920 });
  invalid(keep(7), /flight-confirmed identity: 7 observations/, { width: 1080, height: 1920 });
  const exit = keep(7);
  exit.completion.observedEnd = 'frame_exit';
  valid(exit, { width: 1080, height: 1920 });
  const slow = tau => {
    const r = keep(8), lastT = r.observations.at(-1).t;                // 9 frames = 0.3 s of video
    Object.assign(r.completion, { slowMoFactor: tau, observedSec: (lastT - r.launch.t) / tau, predictedSec: (r.completion.end.t - lastT) / tau });
    return r;
  };
  valid(slow(1.9), { width: 1080, height: 1920 });                    // 0.158 s real
  invalid(slow(2.1), /flight-confirmed identity/, { width: 1080, height: 1920 });   // 0.143 s real
});

test('predicted points need a completion and form the tail of the curve', () => {
  const r = exampleResult('partial-b'), last = r.points.at(-1);
  r.points.push({ t: last.t + 0.005, x: last.x, y: last.y - 0.001, status: 'predicted' });
  invalid(r, /predicted points need a completion/);
  invalid(r, /without a completion the curve ends at the last observation/);
  const m = exampleResult('tracked'), i = m.points.findIndex(p => p.status === 'interpolated');
  m.points[i].status = 'predicted';
  invalid(m, /predicted points must form the tail/, {});
  invalid(m, /'predicted' but not after the last observation/, {});
  const late = exampleResult('tracked'), j = late.points.findIndex(p => p.status === 'predicted');
  late.points[j + 3].status = 'interpolated';
  invalid(late, /'interpolated' but after the last observation/, {});
});

test('the curve starts with exactly one anchor at the launch', () => {
  const two = exampleResult('tracked');
  two.points[2].status = 'anchor';
  invalid(two, /only it, must be the anchor/, {});
  const off = exampleResult('tracked');
  off.points[0].x += 0.01;
  invalid(off, /anchor must sit at launch/, {});
  const late = exampleResult('tracked');
  late.points[0].t = late.launch.t + 0.001;
  invalid(late, /anchor must sit at launch/, {});
});

test('status rules: tracked needs a launch and completion; partial and abstention need matching reasons', () => {
  const t = exampleResult('tracked');
  t.completion = null;
  invalid(t, /tracked needs a launch and a completion/, {});
  const abst = exampleResult('tracked'); abst.reasonCodes = ['no_launch'];
  invalid(abst, /tracked cannot carry abstain reasons/);
  const part = exampleResult('tracked'); part.reasonCodes = ['completion_uncertain'];
  invalid(part, /tracked cannot carry partial reasons/);
  const info = exampleResult('tracked'); info.reasonCodes = ['multiple_shots', 'slow_decode_path'];
  valid(info);
  const p = exampleResult('partial-a'); p.reasonCodes = ['multiple_shots'];
  invalid(p, /partial needs a partial reason/);
  const pa = exampleResult('partial-a'); pa.reasonCodes.push('low_confidence');
  invalid(pa, /partial cannot carry abstain reasons/);
  const a = makeAbstention(['no_launch']); a.reasonCodes = ['slow_decode_path'];
  invalid(a, /no_reliable_track needs an abstain reason/);
  const ap = makeAbstention(['no_launch']); ap.reasonCodes.push('tracking_ended_early');
  invalid(ap, /no_reliable_track cannot carry partial reasons/);
  const unknown = exampleResult('tracked'); unknown.reasonCodes = ['ambiguous_launch'];
  invalid(unknown, /unknown 'ambiguous_launch'/);
  const dup = exampleResult('partial-a'); dup.reasonCodes.push('completion_uncertain');
  invalid(dup, /duplicates/);
  const empty = makeAbstention(['no_launch']); empty.status = 'partial'; empty.reasonCodes = ['tracking_ended_early'];
  invalid(empty, /partial needs a curve of at least 2 points/);
  const bogus = exampleResult('tracked'); bogus.status = 'manual';
  invalid(bogus, /status: 'manual' unknown/);
  for (const [code, info] of Object.entries(REASON_CODES)) {
    assert.ok(['abstain', 'partial', 'info'].includes(info.kind) && info.text.endsWith('.'), code);
  }
});

test('points are strictly increasing and dense (<= 1/60 s apart)', () => {
  const swap = exampleResult('tracked');
  [swap.points[5], swap.points[6]] = [swap.points[6], swap.points[5]];
  invalid(swap, /not after the previous point/, {});
  const gap = exampleResult('tracked'), k = gap.points.findIndex(p => p.status === 'predicted');
  gap.points.splice(k + 2, 2);
  invalid(gap, /gap 0\.025\d s > 0\.0167 s/, {});
  const ok = exampleResult('tracked');
  ok.points.splice(k + 2, 1);                                            // 1/60 s exactly is still dense
  valid(ok, {});
});

test('alpha stays in [0, 1] and only fades out at the end', () => {
  const r = exampleResult('tracked'), k = r.points.findIndex(p => p.alpha !== undefined);
  r.points[k + 3].alpha = Math.min(1, r.points[k + 2].alpha + 0.05);
  invalid(r, /end fade must not increase/, {});
  const back = exampleResult('tracked');
  delete back.points[k + 3].alpha;
  invalid(back, /end fade must not increase/, {});
  const over = exampleResult('tracked'); over.points[3].alpha = 1.2;
  invalid(over, /alpha: not in \[0, 1\]/, {});
  const fade = exampleResult('partial-a'); delete fade.points.at(-1).alpha;
  invalid(fade, /'fade' end must fade the last point/, {});
});

test('every observation has an observed curve sample at its time', () => {
  const r = exampleResult('tracked');
  r.observations[4].t += 0.003;
  invalid(r, /observation 4: no curve sample/, {});
  const s = exampleResult('tracked'), i = sampleAt(s, s.observations[2].t);
  s.points[i].status = 'interpolated';
  invalid(s, /observation 2: its curve sample is 'interpolated'/, {});
  const early = exampleResult('tracked');
  early.observations[0].t = early.launch.t;
  invalid(early, /first observation must come after launch\.t/, {});
});

test('every inlier lies within 1.5 sigma of the curve (checked when the frame size is given)', () => {
  const at = f => {
    const r = exampleResult('tracked'), o = r.observations[3], p = r.points[sampleAt(r, o.t)];
    const sigmaPx = o.sigma * Math.hypot(1080, 1920);
    o.x = p.x + f * sigmaPx / 1080; o.y = p.y;
    return r;
  };
  valid(at(1.45));
  invalid(at(1.55), /observation 3: curve 0\.9\d+ px away, limit 0\.90\d px \(1\.5σ\)/);
  valid(at(3), { fps: 30 });                                             // without width/height the px check is off
});

test('point statuses follow the half-frame rule when fps is given', () => {
  const r = exampleResult('tracked'), i = r.points.findIndex(p => p.status === 'interpolated');
  r.points[i].status = 'observed';
  invalid(r, /rule says 'interpolated'/, DIMS);
  valid(r, { width: 1080, height: 1920 });
  const o = exampleResult('tracked'), j = o.points.findIndex((p, n) => n > 0 && p.status === 'observed');
  o.points[j].status = 'interpolated';
  invalid(o, /rule says 'observed'/, DIMS);
});

test('field-level checks: counts, keys, units, confidence, camera, launch, completion identities, cloneability', () => {
  const n = exampleResult('tracked'); n.observedFrames = 11;
  invalid(n, /observedFrames: 11 != observations\.length 12/);
  const extra = exampleResult('tracked'); extra.selectedLaunchId = 'L1';
  invalid(extra, /result\.selectedLaunchId: unknown key/);
  const pk = exampleResult('tracked'); pk.points[4].sigma = 0.001;
  invalid(pk, /points\[4\]\.sigma: unknown key/);
  const px = exampleResult('tracked'); px.points[7].x = 540;
  invalid(px, /points\[7\]\.x: 540 outside -1,2/);
  const conf = exampleResult('tracked'); conf.confidence.value = 1.2;
  invalid(conf, /confidence\.value: expected frac/);
  const cal = exampleResult('tracked'); cal.confidence.calibratedOn = 'synthetic-v1';
  invalid(cal, /not in CALIBRATIONS/);
  const noCam = exampleResult('tracked'); noCam.camera = [];
  invalid(noCam, /a curve needs camera samples/);
  const cs = exampleResult('tracked'); cs.camera[3].s = 0;
  invalid(cs, /camera\[3\]\.s: not a plausible scale/);
  const dir = exampleResult('tracked'); dir.launch.dir = { x: 1, y: 1 };
  invalid(dir, /launch\.dir: not a unit vector/);
  const view = exampleResult('tracked'); view.launch.view = 'faceon';
  invalid(view, /launch\.view: 'faceon' unknown/);
  const os = exampleResult('tracked'); os.completion.observedSec += 0.01;
  invalid(os, /observedSec != /);
  const ps = exampleResult('tracked'); ps.completion.predictedSec -= 0.01;
  invalid(ps, /predictedSec != /);
  const end = exampleResult('tracked'); end.completion.end.t -= 0.01;
  invalid(end, /completion\.end must be the last curve point/);
  const et = exampleResult('tracked'); et.completion.end.type = 'frame_exit';
  invalid(et, /end\.type: 'frame_exit' unknown/);
  const eng = exampleResult('tracked'); eng.engine = 'v2';
  invalid(eng, /engine: expected 'hf'/);
  const fn = exampleResult('tracked'); fn.diagnostics = { fit: { predict: () => 0 } };
  invalid(fn, /diagnostics\.fit\.predict: function is not structured-cloneable/);
  const cyc = exampleResult('tracked'); cyc.diagnostics = { a: {} }; cyc.diagnostics.a.self = cyc.diagnostics;
  invalid(cyc, /circular reference/);
  const shared = exampleResult('tracked'), part = { k: 1 }; shared.diagnostics = { a: part, b: part };
  valid(shared);
  assert.equal(validateResult(null).ok, false);
  assert.throws(() => assertResult(eng), e => e instanceof HFError && e.code === 'internal' && /engine/.test(e.message));
  assert.equal(assertResult(exampleResult('partial-b')).status, 'partial');
});

test('normalizeTrackReport never upgrades an hf status', () => {
  const cases = ['tracked', 'partial-a', 'partial-b', 'abstain'].map(k => exampleResult(k));
  const short = exampleResult('partial-b'); short.points = short.points.slice(0, 5); short.status = 'tracked'; short.reasonCodes = [];
  cases.push(short);
  for (const r of cases) {
    const report = normalizeTrackReport(r);
    assert.ok(isDowngradeOrSame(r.status, report.status), `${r.status} -> ${report.status}`);
  }
  assert.equal(normalizeTrackReport(short).status, 'partial');
  assert.equal(normalizeTrackReport(exampleResult('abstain')).exportable, false);
  const order = STATUSES.slice().reverse();                             // no_reliable_track < partial < tracked
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(isDowngradeOrSame(order[i], order[j]), j <= i);
  assert.equal(isDowngradeOrSame('tracked', 'manual'), false);
  assert.equal(isDowngradeOrSame('legacy', 'tracked'), false);
});

/* ---------------------------------------------------------------- engine entry (runHF -> pipeline analyzeClip) */

/** Minimal collaborators (no other unit's file): a scanner that records what it is fed, and no impacts. */
function scanOnlyModules(seen) {
  const unavailable = name => { const f = function () { const e = new HFError('unsupported', `${name} unavailable`); e.unavailable = name; throw e; }; f.unavailable = 'test'; return f; };
  class CoarseScanner {
    constructor(meta) { this.meta = meta; this.idx = []; this.t = []; }
    push(index, t, img) { this.idx.push(index); this.t.push(t); seen.push({ index, t, w: img.w, h: img.h, pool: img.pool }); this.img = img; }
    finish() {
      const n = this.idx.length, index = Int32Array.from(this.idx), t = Float64Array.from(this.t);
      return makeCoarseLog({
        pool: this.img.pool, w: this.img.w, h: this.img.h, stride: 1, frames: { index, t },
        camera: { index, t, sim: new Float64Array(4 * n).map((_, j) => (j % 4 ? 0 : 1)), inlier: new Float32Array(n).fill(1) },
        spots: [], vacates: [], energy: { cellPx: 4, disk: () => ({ index: new Int32Array(0), e: new Float32Array(0) }), active: () => 0 },
        horizon: null, movers: [], specks: []
      });
    }
  }
  const m = Object.fromEntries(['LaunchConfirmer', 'RoiTube', 'FlightTracker', 'reassociate', 'fitFlight', 'completeFlight', 'displayCurve', 'decide'].map(k => [k, unavailable(k)]));
  return { ...m, CoarseScanner, findImpacts: () => [] };
}

test('runHF runs the pipeline (analyzeClip): options and progress pass through, abort rejects', async () => {
  assert.equal(ENGINE_ID, 'hf');
  assert.equal(ENGINE_ID, RESULT_ENGINE);
  // the real pipeline with injected collaborators: every frame reaches the scanner, no impact -> no_launch
  const seen = [], events = [], src = memSource(6);
  const r = await runHF(src, { modules: scanOnlyModules(seen), params: mergeParams({ pipeline: { progressMs: 1e9 } }) }, p => events.push(p));
  valid(r, { width: 48, height: 32, fps: 30 });
  assert.equal(r.status, 'no_reliable_track');
  assert.deepEqual(r.reasonCodes, ['no_launch']);
  assert.deepEqual(seen.map(s => s.index), [0, 1, 2, 3, 4, 5], 'the coarse scan saw every frame');
  assert.deepEqual(seen.map(s => s.t), [...src.meta.times]);
  assert.equal(r.camera.length, 6, 'the camera track of the scan is kept in the abstention');
  assert.equal(r.diagnostics.paramsVersion, PARAMS_VERSION);
  assert.equal(r.diagnostics.counts.scan.frames, 6);
  assert.deepEqual(events.map(e => e.phase), ['probe', 'scan', 'impact', 'done'], 'one event per phase (throttled), done last');
  for (const e of events) assert.deepEqual(check('Progress', e), []);
  assert.deepEqual(structuredClone(r), r);
  // a collaborator that is not available gives engine_not_ready only once it is needed
  const missing = await runHF(memSource(), { modules: { ...scanOnlyModules([]), CoarseScanner: scanOnlyModules([]).decide } });
  assert.deepEqual(missing.reasonCodes, ['engine_not_ready']);
  // diagnostics: true reaches the pipeline (per-impact detail appears)
  assert.deepEqual((await runHF(memSource(), { modules: scanOnlyModules([]), diagnostics: true })).diagnostics.impacts, []);
  const empty = createMemorySource({ width: 4, height: 4, frames: [] });
  assert.deepEqual((await runHF(empty)).reasonCodes, ['no_frames']);
  assert.deepEqual((await runHF(null)).reasonCodes, ['no_frames']);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(runHF(memSource(), { signal: ac.signal, modules: scanOnlyModules([]) }), e => e.name === 'AbortError');
  const late = new AbortController(), during = [];
  await assert.rejects(runHF(memSource(), { signal: late.signal, modules: scanOnlyModules(during) }, p => { if (p.phase === 'scan') late.abort(); }), e => e.name === 'AbortError');
  assert.ok(during.length < 6, 'aborting during the scan stops it');
});

/* ---------------------------------------------------------------- performance (phone budget: these are per frame) */

test('hot paths stay cheap: pooling, cropping, validation', () => {
  const time = (f, n) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t) / n; };
  const hd = new Uint8Array(1080 * 1920).map((_, i) => i * 7), uhd = new Uint8Array(2160 * 3840).map((_, i) => i * 7);
  const outHd = new Uint8Array(540 * 960), outUhd = new Uint8Array(540 * 960);
  const ms = {
    pool1080p: time(() => poolLuma(hd, 1080, 1920, 2, outHd), 10),
    pool4k: time(() => poolLuma(uhd, 2160, 3840, 4, outUhd), 5),
    crop384: time(() => cropLuma(uhd, 2160, 3840, { x: 1000, y: 1000, w: 384, h: 384 }), 50),
    crop384edge: time(() => cropLuma(uhd, 2160, 3840, { x: -100, y: 3600, w: 384, h: 384 }, 2), 50),
    validate: time(() => validateResult(exampleResult('tracked'), DIMS), 20)
  };
  console.log('hf-types ms/call', JSON.stringify(Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, +v.toFixed(3)]))));
  assert.ok(ms.pool1080p < 40 && ms.pool4k < 80 && ms.crop384 < 5 && ms.crop384edge < 5 && ms.validate < 50, JSON.stringify(ms));
});
