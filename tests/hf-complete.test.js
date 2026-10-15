import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, make, makeObservation, identityTrack } from '../dist/hf/types.js';
import { fitFlight } from '../dist/hf/flight-model.js';
import { completeFlight, sigmaMajor, honoredObservations, realTime, videoTime } from '../dist/hf/complete.js';
import * as G from './hf/helpers/gt-sim.mjs';

const DIAG = Math.hypot(1080, 1920);
const run = (clipOpts, obsOpts, ctxOpts = {}) => {
  const clip = G.makeClip(clipOpts), obs = G.observe(clip, obsOpts), ctx = G.fitCtx(clip, obs, ctxOpts), fit = fitFlight(obs, ctx);
  const exited = obsOpts.frac != null && clip.exit;
  const comp = completeFlight(fit, obs, G.completeCtx(clip, ctx, { observedEnd: exited ? 'frame_exit' : 'lost' }));
  return { clip, obs, ctx, fit, comp, err: Math.hypot(comp.end.x - clip.end.x, comp.end.y - clip.end.y) / clip.H };
};
const med = a => G.median(a);

/* ---------------------------------------------------------------- sigmaMajor and helpers */

test('sigmaMajor is the 1σ major axis of a 2×2 covariance', () => {
  assert.equal(sigmaMajor([4, 0, 4]), 2);
  assert.equal(sigmaMajor([9, 0, 1]), 3);
  assert.ok(Math.abs(sigmaMajor([5, 4, 5]) - 3) < 1e-12);
  assert.equal(sigmaMajor([NaN, 0, 1]), Infinity);
  assert.equal(sigmaMajor(null), Infinity);
});

test('realTime and videoTime invert each other, with and without a speed ramp', () => {
  const plain = { tau: 4, ramp: null }, ramped = { tau: 8, ramp: { tSplit: 3, tau: [8, 1] } };
  for (const f of [plain, ramped]) for (const t of [1.2, 2.9, 3, 3.4, 7]) assert.ok(Math.abs(videoTime(f, 1, realTime(f, 1, t)) - t) < 1e-12);
  assert.ok(Math.abs(realTime(ramped, 1, 5) - (2 / 8 + 2)) < 1e-12);
});

/* ---------------------------------------------------------------- E4-style suites on the independent simulator */

test('completion end error: median <= 1% of H with >= 1 s observed (down-the-line, horizon known)', () => {
  const errs = [];
  for (const fps of [30, 60]) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const r = run({ seed, view: 'dtl', fps }, { realSec: 1.0 });
    assert.deepEqual(check('Completion', r.comp), []);
    const tau = r.comp.slowMoFactor, tl = r.comp.tLastObs;
    assert.ok(Math.abs(r.comp.observedSec - (tl - r.ctx.launch.t0) / tau) < 1e-9 && Math.abs(r.comp.predictedSec - (r.comp.end.t - tl) / tau) < 1e-9);
    errs.push(r.err);
  }
  errs.sort((a, b) => a - b);
  assert.ok(med(errs) <= 0.01, `median end error ${(100 * med(errs)).toFixed(2)}% of H`);
  assert.ok(G.quantile(errs, 0.9) <= 0.03, `p90 ${(100 * G.quantile(errs, 0.9)).toFixed(2)}% of H`);
});

test('without a horizon an uncertain landing fades instead of committing to a wrong end', () => {
  let confidentWrong = 0, n = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const r = run({ seed, view: 'dtl', fps: 30 }, { realSec: 1.5 }, { horizon: false });
    n++;
    if (r.comp.end.type !== 'fade' && r.err > 0.03) confidentWrong++;
  }
  assert.ok(confidentWrong <= 1, `${confidentWrong}/${n} arcs landed more than 3% of H from the truth without fading`);
});

test('fade when less than 0.4 s is observed (and not when >= 1 s is)', () => {
  let fades = 0, total = 0;
  for (const real of [0.25, 0.35]) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = run({ seed, view: 'dtl', fps: 30 }, { realSec: real });
    total++;
    if (r.comp.end.type === 'fade' && r.comp.uncertain) fades++;
    if (r.comp.end.type === 'fade') { assert.equal(r.comp.fade.to, r.comp.end.t); assert.ok(r.comp.fade.from >= r.comp.tLastObs); }
  }
  assert.equal(fades, total, `${fades}/${total} short tracks faded early`);
  let long = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) if (run({ seed, view: 'dtl', fps: 30 }, { realSec: 1.2 }).comp.end.type !== 'fade') long++;
  assert.ok(long >= 5, `only ${long}/6 well-observed tracks reached a landing`);
});

test('face-on: the arc runs to the frame exit, just outside the frame', () => {
  for (const [fps, tau] of [[240, 1], [30, 8]]) for (const seed of [1, 2, 3, 4]) {
    const r = run({ seed, view: 'fo', fps, tau, W: 1920, H: 1080 }, { frac: 0.5 }, { tauPrior: tau > 1 ? 'flat' : 'true' });
    assert.ok(r.clip.exit, 'the simulated ball leaves the frame');
    assert.equal(r.comp.end.type, 'exit', `fps ${fps} seed ${seed}: ${r.comp.end.type}`);
    assert.equal(r.comp.observedEnd, 'frame_exit');
    assert.ok(r.err < 0.01, `exit point ${(100 * r.err).toFixed(2)}% of H from the truth`);
    const d = r.fit.predict(r.comp.end.t).d, { x, y } = r.comp.end;
    const out = Math.max(-x, x - 1920, -y, y - 1080);
    assert.ok(out >= PARAMS.complete.exitMarginD * d - 1 && out <= PARAMS.complete.exitMarginD * d + 3, `exit ${out.toFixed(1)} px outside, d ${d.toFixed(1)}`);
  }
});

/* ---------------------------------------------------------------- end rules on controlled fits */

const META = G.makeClip({ seed: 1 }).meta, W = META.width, H = META.height;
const LAUNCH = { t0: 1, address: { x: 540, y: 1500 }, d0: 16, dir: { x: 0, y: -1 }, v: 30, c: 0.1 };
const obsAt = ts => ts.map((t, i) => makeObservation({ index: i, t, x: 540, y: 1500 - 300 * (t - 1), sigma: 0.6, z: 8, z1: 6, d: null, polarity: 1 }));
/** A controlled FlightFit: straight path(t), isotropic σ(t), optional landing. */
function mockFit({ path, sigma = () => 1, landingT = null, tau = 1, kind = 'm3d', d = 8, ramp = null }) {
  const at = t => path(t);
  return {
    kind, tau, ramp, landingT, at, isInlier: () => undefined,
    predict: t => ({ t, ...path(t), cov: [sigma(t) ** 2, 0, sigma(t) ** 2], d, h: kind === 'image' ? null : 0 }),
    velocity: t => { const a = path(t - 1e-4), b = path(t + 1e-4); return { x: (b.x - a.x) / 2e-4, y: (b.y - a.y) / 2e-4 }; }
  };
}
const ctxC = (extra = {}) => ({ meta: META, camera: identityTrack(META), horizon: null, launch: LAUNCH, observedEnd: 'lost', params: PARAMS, ...extra });
const up = t => ({ x: 540, y: 1500 - 300 * (t - 1) + 40 * (t - 1) ** 2 });
const obs = obsAt([1.1, 1.2, 1.3, 1.4, 1.5]);

test('landing: the arc ends at the model landing with a landingFadeRealSec fade', () => {
  const c = completeFlight(mockFit({ path: up, landingT: 4, tau: 2 }), obs, ctxC({ observedEnd: 'clip_end' }));
  assert.equal(c.end.type, 'landing');
  assert.ok(Math.abs(c.end.t - 4) < 1e-12);
  assert.deepEqual([c.end.x, c.end.y], [up(4).x, up(4).y]);
  assert.ok(Math.abs(c.fade.from - (4 - PARAMS.complete.landingFadeRealSec * 2)) < 1e-9 && c.fade.to === 4);
  assert.equal(c.uncertain, false);
  assert.equal(c.observedEnd, 'clip_end');
  assert.equal(c.slowMoFactor, 2);
  assert.ok(Math.abs(c.observedSec - 0.25) < 1e-12 && Math.abs(c.predictedSec - 1.25) < 1e-12);
  // Landing before the last observation: the arc ends on the last observation.
  const early = completeFlight(mockFit({ path: up, landingT: 1.45 }), obs, ctxC());
  assert.equal(early.end.type, 'landing'); assert.equal(early.end.t, 1.5); assert.deepEqual([early.end.x, early.end.y], [obs[4].x, obs[4].y]);
});

test('fade: the arc fades from the σ = 3% crossing and ends at σ = 6% of the diagonal; early fades are uncertain', () => {
  const C = PARAMS.complete, s = t => 2 + (C.fadeEndDiag * DIAG) * Math.max(0, t - 1.5) / 2;   // Laplace part reaches 6% near t = 3.5
  const f = mockFit({ path: up, sigma: s, landingT: 9 }), v = f.velocity(1.5), vl = Math.hypot(v.x, v.y);
  const eff = t => Math.hypot(s(t), C.kappa * (t - 1.5) * vl), cross = lvl => { let t = 1.5; while (eff(t) < lvl * DIAG) t += 1e-4; return t; };
  const c = completeFlight(f, obs, ctxC());
  assert.equal(c.end.type, 'fade');
  assert.ok(Math.abs(c.end.t - cross(C.fadeEndDiag)) < 1.5 / PARAMS.display.hz, `fade end ${c.end.t} vs ${cross(C.fadeEndDiag)}`);
  assert.ok(Math.abs(c.fade.from - cross(C.fadeStartDiag)) < 1.5 / PARAMS.display.hz, `fade start ${c.fade.from} vs ${cross(C.fadeStartDiag)}`);
  assert.equal(c.fade.to, c.end.t);
  assert.equal(c.uncertain, true, 'faded before half of the predicted remainder');
  // The same σ growth against a nearer landing leaves a landing (σ never reaches 6% before it).
  const near = completeFlight(mockFit({ path: up, sigma: s, landingT: 3 }), obs, ctxC());
  assert.equal(near.end.type, 'landing');
  assert.equal(near.uncertain, false);
  assert.ok(Math.abs(near.fade.from - cross(C.fadeStartDiag)) < 1.5 / PARAMS.display.hz, 'the σ fade started before the landing fade');
});

test('cap: a flight that never lands ends at t0 + capRealSec·τ', () => {
  const flat = t => ({ x: 540 + 10 * (t - 1), y: 1200 });
  const c = completeFlight(mockFit({ path: flat, tau: 1.5 }), obs, ctxC());
  assert.equal(c.end.type, 'cap');
  assert.ok(Math.abs(c.end.t - (1 + PARAMS.complete.capRealSec * 1.5)) < 1e-9);
});

test('exit: the arc stops exitMarginD·d outside the RAW frame (camera track), and only when it never comes back', () => {
  const noK = mergeParams({ complete: { kappa: 0 } }), ctxC = (extra = {}) => ({ meta: META, camera: identityTrack(META), horizon: null, launch: LAUNCH, observedEnd: 'lost', params: noK, ...extra });
  const right = t => ({ x: 540 + 400 * (t - 1.5), y: 1200 });   // leaves the right edge at t = 2.85
  const c = completeFlight(mockFit({ path: right, landingT: 6, d: 10 }), obs, ctxC());
  assert.equal(c.end.type, 'exit');
  assert.ok(Math.abs(c.end.x - (W + PARAMS.complete.exitMarginD * 10)) < 1, `exit at x=${c.end.x}`);
  // A camera that panned 300 px left: the same stabilized path leaves the raw frame 300 px earlier.
  const cam = identityTrack(META);
  for (let k = 0; k < cam.index.length; k++) cam.sim[4 * k + 2] = 300;   // raw = stab + 300
  const c2 = completeFlight(mockFit({ path: right, landingT: 6, d: 10 }), obs, ctxC({ camera: cam }));
  assert.equal(c2.end.type, 'exit');
  assert.ok(Math.abs(c2.end.x - (W + 10 - 300)) < 1, `exit in stabilized px ${c2.end.x}`);
  // Already outside at the last observation (a ball seen at the very edge): the arc ends there, on the observation.
  const edge = t => ({ x: W + 30 + 20 * (t - 1.5), y: 1200 });
  const c4 = completeFlight(mockFit({ path: edge, landingT: 6, d: 10 }), obs, ctxC());
  assert.equal(c4.end.type, 'exit');
  assert.deepEqual([c4.end.t, c4.end.x, c4.end.y], [1.5, obs[4].x, obs[4].y]);
  // Out through the top and back down into the frame: not an exit.
  const lob = t => ({ x: 540, y: 1500 - 1400 * (t - 1) + 300 * (t - 1) ** 2 });
  const c3 = completeFlight(mockFit({ path: lob, landingT: 5.6 }), obs.map(o => ({ ...o, y: lob(o.t).y })), ctxC());
  assert.equal(c3.end.type, 'landing');
});

test('a model that runs behind the camera (non-finite predictions) still yields a finite end', () => {
  const behind = t => (t > 2.5 ? { x: NaN, y: NaN } : { x: 540, y: 1500 - 300 * (t - 1) });
  const c = completeFlight(mockFit({ path: behind, landingT: 6 }), obs, ctxC());
  assert.equal(c.end.type, 'exit');
  assert.ok(Number.isFinite(c.end.x) && Number.isFinite(c.end.y) && c.end.t <= 2.5 + 1e-9, `end ${JSON.stringify(c.end)}`);
});

test('image model: early fade over imageHorizonRealSec (never past the observed span), always uncertain', () => {
  const c = completeFlight(mockFit({ path: up, kind: 'image', tau: 1 }), obs, ctxC());
  assert.equal(c.end.type, 'fade');
  assert.ok(Math.abs(c.end.t - (1.5 + PARAMS.fit.imageHorizonRealSec)) < 1e-9);
  assert.deepEqual(c.fade, { from: 1.5, to: c.end.t });
  assert.equal(c.uncertain, true);
  const slow = completeFlight(mockFit({ path: up, kind: 'image', tau: 8 }), obs, ctxC());
  assert.ok(Math.abs(slow.end.t - 2) < 1e-9, 'capped at the observed span (0.5 s video)');
});

test('κ inflation: with an exact model σ still grows as κ·(t − t_last)·|v_last|', () => {
  const osc = t => ({ x: 540, y: 1000 + 500 * Math.sin(4 * (t - 1)) });   // stays in frame, |v(1.5)| = 2000·|cos 2| px/s
  const f = mockFit({ path: osc, sigma: () => 0, landingT: 20 }), v = Math.hypot(f.velocity(1.5).x, f.velocity(1.5).y);
  const c = completeFlight(f, obs, ctxC());
  const tFade = 1.5 + PARAMS.complete.fadeEndDiag * DIAG / (PARAMS.complete.kappa * v);
  assert.equal(c.end.type, 'fade');
  assert.ok(Math.abs(c.end.t - tFade) < 1.5 / PARAMS.display.hz, `fade at ${c.end.t} vs ${tFade}`);
  const exact = completeFlight(f, obs, ctxC({ params: mergeParams({ complete: { kappa: 0 } }) }));
  assert.equal(exact.end.type, 'cap', 'without κ an exact model never fades');
});

test('only honored observations count: fit-rejected or non-inlier ones never extend the observed span', () => {
  const extra = [...obs, makeObservation({ index: 9, t: 1.9, x: 540, y: 900, sigma: 0.6, z: 8, z1: 6, d: null, polarity: 1, flag: 'rejected' })];
  const f = mockFit({ path: up, landingT: 4 });
  assert.equal(completeFlight(f, extra, ctxC()).tLastObs, 1.5);
  const rejecting = { ...f, isInlier: o => o !== obs[4] };
  assert.equal(completeFlight(rejecting, obs, ctxC()).tLastObs, 1.4);
  assert.equal(honoredObservations(rejecting, obs, 1).length, 4);
  assert.throws(() => completeFlight(f, [], ctxC()), /inlier observation/);
});

test('a speed ramp carries into the completion with consistent real-time identities', () => {
  const f = mockFit({ path: up, landingT: 6, tau: 4 });
  f.ramp = { tSplit: 1.3, tau: [4, 1] };
  const c = completeFlight(f, obs, ctxC());
  assert.equal(c.ramp, true);
  const tau = c.slowMoFactor, tr = realTime(f, 1, 1.5);
  assert.ok(Math.abs(c.observedSec - tr) < 1e-9, 'observedSec is the true real span');
  assert.ok(Math.abs(c.predictedSec - (c.end.t - 1.5) / tau) < 1e-12);
  assert.ok(Math.abs(c.end.t - videoTime(f, 1, PARAMS.complete.capRealSec)) > 0, 'cap uses the ramped clock');
});
