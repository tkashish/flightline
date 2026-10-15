import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, makeObservation } from '../dist/hf/types.js';
import { fitFlight, predictWithSigma, detectSpeedRamp, simulate, M3D_PARAM_NAMES, horizonKind } from '../dist/hf/flight-model.js';
import { levenbergMarquardt, solveSPD, invertSPD, huber } from '../dist/hf/lm.js';
import { completeFlight, sigmaMajor } from '../dist/hf/complete.js';
import * as G from './hf/helpers/gt-sim.mjs';

const DEG = Math.PI / 180;
const cpuMs = () => (typeof process !== 'undefined' && process.cpuUsage ? process.cpuUsage().user / 1000 : performance.now());
const fitClip = (clip, obsOpts, ctxOpts = {}, fitOpts = {}) => {
  const obs = G.observe(clip, obsOpts), ctx = G.fitCtx(clip, obs, ctxOpts);
  return { obs, ctx, fit: fitFlight(obs, ctx, fitOpts) };
};

/* ---------------------------------------------------------------- lm.js */

test('solveSPD and invertSPD agree with the matrix; non-SPD input returns null', () => {
  const r = G.rng(5), n = 7, B = Float64Array.from({ length: n * n }, () => r.gauss()), A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = i === j ? 0.5 : 0; for (let k = 0; k < n; k++) s += B[i * n + k] * B[j * n + k]; A[i * n + j] = s; }
  const b = Float64Array.from({ length: n }, () => r.gauss()), x = solveSPD(A, b, n), Ai = invertSPD(A, n);
  for (let i = 0; i < n; i++) {
    let s = 0; for (let k = 0; k < n; k++) s += A[i * n + k] * x[k];
    assert.ok(Math.abs(s - b[i]) < 1e-9);
    for (let j = 0; j < n; j++) { let e = 0; for (let k = 0; k < n; k++) e += A[i * n + k] * Ai[k * n + j]; assert.ok(Math.abs(e - (i === j ? 1 : 0)) < 1e-9); }
  }
  assert.equal(solveSPD(Float64Array.from([1, 2, 2, 1]), Float64Array.from([1, 1]), 2), null);
  assert.equal(invertSPD(Float64Array.from([0, 0, 0, 0]), 2), null);
});

test('levenbergMarquardt: converges from a poor start, Huber resists a gross outlier, priors and bounds hold', () => {
  const ts = Array.from({ length: 30 }, (_, i) => i / 10), truth = [3, 0.8, 0.5];
  const data = ts.map(t => truth[0] * Math.exp(-truth[1] * t) + truth[2] + 0.002 * Math.sin(37 * t));
  data[12] += 4;                                                    // one gross outlier
  const res = d => x => Float64Array.from(ts, (t, i) => (x[0] * Math.exp(-x[1] * t) + x[2] - d[i]) / 0.01);
  const robust = levenbergMarquardt(res(data), [1, 0.1, 0], { huberDelta: 2.5, maxIter: 200 });
  const plain = levenbergMarquardt(res(data), [1, 0.1, 0], { maxIter: 200 });
  assert.ok(Math.abs(robust.x[1] - 0.8) < 0.02, `robust decay ${robust.x[1]}`);
  assert.ok(Math.abs(plain.x[1] - 0.8) > 3 * Math.abs(robust.x[1] - 0.8), 'least squares is pulled by the outlier, Huber is not');
  assert.ok(robust.JtJ && robust.JtJ.length === 9);
  const pri = levenbergMarquardt(res(data), [1, 0.1, 0], { huberDelta: 2.5, maxIter: 200, priors: [{ index: 2, mu: 2, sigma: 1e-4 }] });
  assert.ok(Math.abs(pri.x[2] - 2) < 1e-3, 'a tight prior pins its parameter');
  const box = levenbergMarquardt(res(data), [1, 0.1, 0], { huberDelta: 2.5, maxIter: 200, upper: [10, 0.5, 10] });
  assert.ok(box.x[1] <= 0.5 + 1e-12, 'upper bound respected');
  assert.equal(huber(1, 2.5), 1); assert.equal(huber(5, 2.5), 2 * 2.5 * 5 - 2.5 * 2.5);
});

/* ---------------------------------------------------------------- contract and helpers */

test('the ground-truth simulator is independent of the fitter', () => {
  const src = readFileSync(new URL('./hf/helpers/gt-sim.mjs', import.meta.url), 'utf8');
  const imports = src.split('\n').filter(l => /^\s*import\b|\bimport\(/.test(l));
  assert.ok(imports.length >= 1);
  for (const l of imports) assert.doesNotMatch(l, /flight-model|\/lm\.js|complete\.js|display-curve/, l);
});

test('fitFlight returns a valid FlightFit with a per-observation inlier mask and a symmetric Laplace covariance', () => {
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 });
  const { obs, fit } = fitClip(clip, { realSec: 1.2 });
  assert.deepEqual(check('FlightFit', fit), []);
  assert.equal(fit.kind, 'm3d');
  assert.deepEqual([...fit.names], [...M3D_PARAM_NAMES]);
  assert.equal(fit.inlier.length, obs.length);
  assert.equal(fit.view, 'dtl');
  const n = fit.params.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) assert.ok(Math.abs(fit.cov[i * n + j] - fit.cov[j * n + i]) <= 1e-9 * (1 + Math.abs(fit.cov[i * n + j])));
  for (let i = 0; i < n; i++) assert.ok(fit.cov[i * n + i] >= 0);
  assert.ok(fit.rmsNorm > 0.5 && fit.rmsNorm < 1.5, `rmsNorm ${fit.rmsNorm}`);
  assert.ok(fit.landingT > obs.at(-1).t);
  const q = predictWithSigma(fit, obs.at(-1).t + 1);
  assert.deepEqual(check('FitPrediction', q), []);
  assert.equal(q.sigma, sigmaMajor(q.cov));
  assert.ok(predictWithSigma(fit, obs.at(-1).t + 2).sigma > predictWithSigma(fit, obs.at(-1).t).sigma, 'σ grows past the last observation');
  // simulate() reproduces the fit's own predictions
  const ts = [obs[3].t, obs.at(-1).t, obs.at(-1).t + 1.5];
  const st = simulate(fit.params, { ...G.fitCtx(clip, obs) }, ts);
  ts.forEach((t, i) => { const p = fit.predict(t); assert.ok(Math.hypot(st[i].x - p.x, st[i].y - p.y) < 1e-6); });
});

test('predictions far past the arc stay cheap and finite (the predictor stops growing and holds its last state)', () => {
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 }), { obs, fit } = fitClip(clip, { realSec: 1 });
  const t = cpuMs();
  for (let i = 0; i < 1000; i++) { const q = fit.predict(obs.at(-1).t + 20 + i * 0.05); assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y)); }
  assert.ok(cpuMs() - t < 100, `1000 far predictions took ${(cpuMs() - t).toFixed(0)} ms`);
});

test('fitFlight ignores observations that are not flagged inlier and honors an abort signal', () => {
  const clip = G.makeClip({ seed: 4, view: 'dtl', fps: 30 });
  const obs = G.observe(clip, { realSec: 1 }), bad = obs.map((o, i) => (i === 10 ? { ...o, x: o.x + 400, flag: 'mover' } : o));
  const fit = fitFlight(bad, G.fitCtx(clip, bad));
  assert.equal(fit.inlier[10], 0);
  assert.equal(fit.isInlier(bad[10]), false);
  assert.equal(fit.isInlier(bad[11]), true);
  assert.equal(fit.isInlier({}), undefined);
  const ac = new AbortController(); ac.abort();
  assert.throws(() => fitFlight(obs, G.fitCtx(clip, obs), { signal: ac.signal }), e => e.name === 'AbortError');
  assert.throws(() => fitFlight([], G.fitCtx(clip, obs)), /inlier observation/);
});

/* ---------------------------------------------------------------- τ, symmetry, outliers, warm refits */

test('the slow-motion factor τ is fitted within ±30% with >= 1 s real observed, even when the τ prior is wrong', () => {
  let starts = 0, survivors = 0;
  for (const [tau, prior] of [[8, 'one'], [4, 'one'], [8, 'flat'], [6, 'flat'], [1, 'flat']]) {
    for (const seed of [1, 3, 5]) {
      const clip = G.makeClip({ seed, view: 'dtl', fps: 30, tau });
      const { fit } = fitClip(clip, { realSec: 1.0 }, { tauPrior: prior });
      assert.ok(Math.abs(fit.tau / tau - 1) <= 0.3, `τ ${tau} prior ${prior} seed ${seed}: fitted ${fit.tau.toFixed(2)}`);
      // Multi-start over τ modes: the true mode is started and survives the early abandon even when the prior gives it
      // no weight (every mode keeps a floor weight), and with a flat prior the winner starts from a slow-motion mode.
      if (tau === 4 || tau === 8) assert.ok(fit.diagnostics.survivorModes.includes(tau), `τ ${tau} prior ${prior} seed ${seed}: surviving modes ${fit.diagnostics.survivorModes}`);
      if (prior === 'flat' && tau >= 4) assert.ok(fit.tauMode >= 4, `τ ${tau} seed ${seed}: winning start mode ${fit.tauMode}`);
      starts += fit.diagnostics.starts; survivors += fit.diagnostics.survivors;
    }
  }
  // Multi-start over the τ modes with early abandon: hopeless starts stop after the first LM phase.
  assert.ok(survivors < starts, `${survivors} of ${starts} starts survived the early-abandon check`);
});

test('draw/fade symmetry: a mirrored track gives a mirrored fit (spin tilt flips sign, the arc mirrors)', () => {
  const W = 1080, H = 1920, spec = { W, H, fovLongDeg: 69, k1: 0, roll: 0, C: [0, 1.2, -3.5] };
  const camera = G.makeCamera({ ...spec, ...G.aim(spec, [0, 0, 0], W / 2, 0.75 * H) });
  const clip = G.makeClip({ seed: 11, view: 'dtl', fps: 60, camera, shot: { club: 'iron7', speed: 50, launchDeg: 17, azimuthDeg: 0, spinRpm: 6500, curveDeg: 14 }, env: G.CALM });
  const obs = G.observe(clip, { realSec: 1.2 });
  const ctxA = G.fitCtx(clip, obs);
  const mirrorObs = obs.map(o => ({ ...o, x: W - o.x }));
  const L = ctxA.launch, h = ctxA.horizon;
  const ctxB = { ...ctxA, launch: { ...L, address: { x: W - L.address.x, y: L.address.y }, dir: { x: -L.dir.x, y: L.dir.y } }, horizon: { ...h, slope: -h.slope, y0: h.y0 + h.slope * W } };
  const A = fitFlight(obs, ctxA), B = fitFlight(mirrorObs, ctxB);
  const tilt = M3D_PARAM_NAMES.indexOf('tilt');
  assert.ok(Math.abs(A.params[tilt]) > 3 * DEG, `the curve is fitted as tilt (${(A.params[tilt] / DEG).toFixed(1)}°)`);
  assert.ok(Math.abs(A.params[tilt] + B.params[tilt]) < 0.3 * DEG, `tilts ${(A.params[tilt] / DEG).toFixed(2)} vs ${(B.params[tilt] / DEG).toFixed(2)}`);
  for (let t = obs[0].t; t < Math.min(A.landingT, B.landingT); t += 0.25) {
    const a = A.predict(t), b = B.predict(t);
    assert.ok(Math.abs(W - a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5, `t=${t.toFixed(2)}: (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) vs mirrored (${(W - b.x).toFixed(1)}, ${b.y.toFixed(1)})`);
  }
  assert.ok(Math.abs(A.landingT - B.landingT) < 0.02);
});

test('5% gross outliers are rejected by the robust fit, clean observations are kept', () => {
  let hit = 0, outl = 0, falseRej = 0, clean = 0;
  for (const seed of [1, 3, 5, 7, 9, 11]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30 });
    const obs = G.observe(clip, { realSec: 1.5, outlierFrac: 0.05, outlierPx: [12, 60], tagOutliers: true, seed: seed + 100 });
    const fit = fitFlight(obs, G.fitCtx(clip, obs));
    obs.forEach((o, i) => { if (o._outlier) { outl++; if (!fit.inlier[i]) hit++; } else { clean++; if (!fit.inlier[i]) falseRej++; } });
    const c = completeFlight(fit, obs, G.completeCtx(clip, G.fitCtx(clip, obs)));
    assert.ok(Math.hypot(c.end.x - clip.end.x, c.end.y - clip.end.y) / clip.H < 0.03, `seed ${seed}: the outliers do not bend the completion`);
  }
  assert.ok(outl >= 6, 'enough outliers were injected');
  assert.ok(hit / outl >= 0.95, `outlier recall ${hit}/${outl}`);
  assert.ok(falseRej / clean <= 0.01, `false rejections ${falseRej}/${clean}`);
});

test('RANSAC re-initialization recovers the ball from a coherent block of wrong detections (a steal)', () => {
  let ok = 0, blockHit = 0, block = 0;
  for (const seed of [1, 2, 3, 5]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30 }), clean = G.observe(clip, { realSec: 1.5 });
    const k0 = 4, k1 = k0 + Math.round(0.35 * clean.length);
    const obs = clean.map((o, i) => (i >= k0 && i < k1 ? { ...o, x: o.x + 40 + 3 * i, y: o.y - 30 - 2 * i } : o));
    const ctx = G.fitCtx(clip, obs), fit = fitFlight(obs, ctx), c = completeFlight(fit, obs, G.completeCtx(clip, ctx));
    if (Math.hypot(c.end.x - clip.end.x, c.end.y - clip.end.y) / clip.H < 0.03) ok++;
    for (let i = k0; i < k1; i++) { block++; if (!fit.inlier[i]) blockHit++; }
    assert.equal(fit.ramp, null, 'a steal is not a speed ramp');
  }
  assert.ok(ok >= 3, `completion recovered in ${ok}/4`);
  assert.ok(blockHit / block >= 0.9, `steal block rejected ${blockHit}/${block}`);
});

test('warm refit costs <= 40 ms (CPU) and agrees with a cold fit', () => {
  const clip = G.makeClip({ seed: 3, view: 'dtl', fps: 240 });
  const all = G.observe(clip, { realSec: 2 });
  const ctx = obs => G.fitCtx(clip, obs);
  let fit = fitFlight(all.slice(0, all.length - 40), ctx(all.slice(0, all.length - 40)));
  const ms = [];
  for (let k = all.length - 30; k <= all.length; k += 10) {
    const obs = all.slice(0, k), t = cpuMs();
    fit = fitFlight(obs, ctx(obs), { warm: fit });
    ms.push(cpuMs() - t);
    assert.ok(fit.diagnostics.path.startsWith('warm'));
  }
  ms.sort((a, b) => a - b);
  assert.ok(ms[ms.length >> 1] <= PARAMS.fit.warmRefitMs, `warm refit median ${ms[ms.length >> 1].toFixed(1)} ms`);
  const cold = fitFlight(all, ctx(all));
  for (const t of [all.at(-1).t, all.at(-1).t + 2]) { const a = fit.predict(t), b = cold.predict(t); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.02 * clip.H); }
});

/* ---------------------------------------------------------------- speed ramps, forward validation, sizes, focal mixture */

test('an iPhone-style speed ramp is detected and modelled as piecewise τ; clean clips show no ramp', () => {
  for (const seed of [1, 8]) {
    const base = G.makeClip({ seed, view: 'dtl', fps: 30, tau: 8 }), tS = base.t0 + 2;
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30, tau: 8, ramp: { tSplit: tS, tau2: 1, width: 0.2 } });
    const { obs, ctx, fit } = fitClip(clip, { realSec: 1.2 }, { tauPrior: 'flat' });
    assert.ok(fit.ramp, `seed ${seed}: ramp found (${fit.diagnostics.path})`);
    assert.ok(Math.abs(fit.ramp.tSplit - tS) < 0.2, `split ${fit.ramp.tSplit.toFixed(2)} vs ${tS.toFixed(2)}`);
    const ratio = fit.ramp.tau[0] / fit.ramp.tau[1];
    assert.ok(ratio > 8 * 0.6 && ratio < 8 * 1.4, `τ ratio ${ratio.toFixed(2)}`);
    assert.ok(fit.inlierFrac >= 0.9, 'the split model explains the track');
    assert.equal(completeFlight(fit, obs, G.completeCtx(clip, ctx)).ramp, true);
    if (seed === 1) assert.equal(detectSpeedRamp(obs, ctx).ramp, true);
  }
  // Normal speed ramping into slow motion: the single-τ fit rejects the whole fast segment (a long rejected run).
  {
    const base = G.makeClip({ seed: 2, view: 'dtl', fps: 30, tau: 1 }), tS = base.t0 + 0.5;
    const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30, tau: 1, ramp: { tSplit: tS, tau2: 8, width: 0.2 } });
    const { fit } = fitClip(clip, { realSec: 1.2 }, { tauPrior: 'flat' });
    assert.ok(fit.ramp && Math.abs(fit.ramp.tSplit - tS) < 0.2 && fit.ramp.tau[1] / fit.ramp.tau[0] > 4, `1 -> 8 ramp ${JSON.stringify(fit.ramp)}`);
  }
  // A wobbly non-ballistic track is not "explained" by a ramp: no ramp is reported.
  {
    const clip = G.makeClip({ seed: 1, view: 'dtl', fps: 60 });
    const obs = G.observe(clip, { realSec: 1.0 }).map(o => ({ ...o, x: o.x + 8 * Math.sin(4 * Math.PI * (o.t - clip.t0)), y: o.y + 8 * Math.cos(5.2 * Math.PI * (o.t - clip.t0)) }));
    const fit = fitFlight(obs, G.fitCtx(clip, obs));
    assert.equal(fit.ramp, null, 'no ramp on a track a split cannot explain');
    assert.equal(fit.ill, true);
  }
  for (const [view, tau, fps] of [['dtl', 8, 30], ['dtl', 1, 60], ['fo', 1, 240]]) {
    const clip = G.makeClip({ seed: 2, view, fps, tau, W: view === 'fo' ? 1920 : 1080, H: view === 'fo' ? 1080 : 1920 });
    const { obs, ctx, fit } = fitClip(clip, view === 'fo' ? { frac: 0.6 } : { realSec: 1.2 }, { tauPrior: 'flat' });
    assert.equal(fit.ramp, null, `${view} τ ${tau}: no ramp`);
    assert.equal(fit.view, view, 'view from the fitted azimuth');
    assert.equal(detectSpeedRamp(obs, ctx, { fit }).ramp, false);
  }
});

test('a non-ballistic track (ill-conditioned M3D) goes through forward validation to the short-horizon image model', () => {
  const clip = G.makeClip({ seed: 1, view: 'dtl', fps: 60 });
  const line = t => ({ x: clip.address.x + 300 * (t - clip.t0), y: clip.address.y - 700 * (t - clip.t0) });
  const obs = Array.from({ length: 50 }, (_, i) => { const t = clip.t0 + (i + 1) / 60, q = line(t); return makeObservation({ index: i + 1, t, x: q.x + 0.3 * Math.sin(7 * i), y: q.y + 0.3 * Math.cos(3 * i), sigma: 0.6, z: 8, z1: 6, d: null, polarity: 1 }); });
  const ctx = G.fitCtx(clip, obs), fit = fitFlight(obs, ctx);
  assert.equal(fit.kind, 'image', `forward validation picked ${fit.kind}`);
  assert.equal(fit.ill, true);
  assert.equal(fit.diagnostics.forward.pick, 'image');
  assert.deepEqual(check('FlightFit', fit), []);
  const t = obs.at(-1).t + 0.25, q = fit.predict(t), tr = line(t);
  assert.ok(Math.hypot(q.x - tr.x, q.y - tr.y) < 2, 'the image model extrapolates the short horizon');
  assert.equal(q.h, null);
  // A clean golf flight is not ill-conditioned and keeps M3D.
  const good = G.makeClip({ seed: 1, view: 'dtl', fps: 60 }), g = fitClip(good, { realSec: 1 });
  assert.equal(g.fit.kind, 'm3d'); assert.equal(g.fit.ill, false);
});

test('early sizes enter as log-radius observations and pull the depth (predicted diameter)', () => {
  // Imprecise positions (heavy blur, 5 px): the sizes carry the depth rate.
  const clip = G.makeClip({ seed: 6, view: 'dtl', fps: 240 });
  const obs = G.observe(clip, { realSec: 0.3, sizeNoise: 0.02, sigma: 5 });
  const withSizes = obs.filter(o => o.d != null);
  assert.ok(withSizes.length >= 30, 'the early ball is big enough to measure');
  const none = obs.map(o => ({ ...o, d: null })), ctx = G.fitCtx(clip, obs);
  const A = fitFlight(none, ctx);
  // Sizes 30% smaller than the position-only fit implies: the fit must move toward them.
  const shrunk = obs.map(o => (o.d != null ? { ...o, d: A.predict(o.t).d * 0.7 } : o));
  const B = fitFlight(shrunk, ctx);
  const mlog = f => { let s = 0; for (const o of withSizes) s += Math.log(f.predict(o.t).d / A.predict(o.t).d); return s / withSizes.length; };
  assert.ok(mlog(B) < -0.05, `diameters moved by ${mlog(B).toFixed(3)} nats toward the sizes`);
  // Consistent sizes leave the fit where positions put it.
  const C = fitFlight(obs, ctx);
  assert.ok(Math.abs(mlog(C)) < 0.06, `consistent sizes: ${mlog(C).toFixed(3)} nats`);
});

test('the focal mixture recovers an ultra-wide lens (0.5x with k1) and keeps the main lens otherwise', () => {
  let ultraOk = 0, mainOk = 0;
  const seeds = [2, 5, 6, 7, 9, 10, 11, 12];
  for (const seed of seeds) {
    const u = G.makeClip({ seed, view: 'dtl', fps: 60, lens: 'ultra' }), fu = fitClip(u, { realSec: 1.0 }).fit;
    if (Math.abs(Math.exp(fu.params[0]) / u.cam.f - 1) < 0.25 && fu.params[10] < -0.02) ultraOk++;
    const m = G.makeClip({ seed, view: 'dtl', fps: 60 }), fm = fitClip(m, { realSec: 1.0 }).fit;
    if (Math.exp(fm.params[0]) / m.cam.f > 0.75 && fm.params[10] === 0) mainOk++;
  }
  assert.ok(ultraOk >= 5, `ultra-wide recovered in ${ultraOk}/${seeds.length}`);
  assert.ok(mainOk >= 7, `main lens kept in ${mainOk}/${seeds.length}`);
});

test('the tele component and focal35 metadata are honored', () => {
  const clip = G.makeClip({ seed: 3, view: 'dtl', fps: 60 });
  const obs = G.observe(clip, { realSec: 1.0 });
  const f35 = clip.cam.f * 36 / Math.max(clip.W, clip.H);
  const meta = { ...clip.meta, focal35: f35 };
  const fit = fitFlight(obs, { ...G.fitCtx(clip, obs), meta });
  assert.ok(Math.abs(Math.exp(fit.params[0]) / clip.cam.f - 1) < 0.2, 'metadata focal sets the prior');
  assert.equal(fit.diagnostics.focalRatio > 0, true);
  const noComp = mergeParams({ fit: { focalComponents: [1], focalWeights: [1] } });
  assert.equal(fitFlight(obs, G.fitCtx(clip, obs, { params: noComp })).component, 0);
});

/* ---------------------------------------------------------------- check gap 4 / R2 / τ (E3 fix round) */

test('a sky line only bounds pitch from below (legacy shape and kind skyline); a geometric horizon (kind horizon) tightens it', () => {
  assert.equal(horizonKind(null), null);
  assert.equal(horizonKind({ slope: NaN, y0: 3, conf: 1 }), null);
  assert.equal(horizonKind({ slope: 0, y0: 900, conf: 1 }), 'skyline', 'the legacy U2 shape is a sky line');
  assert.equal(horizonKind({ kind: 'skyline', slope: 0, y0: 900, conf: 1 }), 'skyline');
  assert.equal(horizonKind({ kind: 'horizon', slope: 0, y0: 900, conf: 1 }), 'horizon');
  const iP = M3D_PARAM_NAMES.indexOf('pitch');
  let bound = 0;
  for (const seed of [1, 4, 5, 6]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30 }), obs = G.observe(clip, { realSec: 1.2 }), ctx = G.fitCtx(clip, obs);
    const truth = clip.cam.pitch / DEG, err = h => fitFlight(obs, { ...ctx, horizon: h }).params[iP] / DEG - truth;
    // A tree line 5° above the true horizon: as a tight horizon it drags pitch down toward itself (the checker's
    // 4.75-5.7° bias); as a sky line it does not pull at all (same fit as no line, because it does not bind here).
    const sky = G.skylineOf(clip.cam, { elevDeg: 5, tiltDeg: 2.5 });
    const legacy = err(sky), kinded = err({ ...sky, kind: 'skyline' }), tight = err({ ...sky, kind: 'horizon' }), none = err(null);
    assert.equal(legacy, kinded, `seed ${seed}: legacy and kind 'skyline' are the same constraint`);
    assert.ok(Math.abs(legacy - none) < 0.05, `seed ${seed}: an inactive sky line changes nothing (${legacy.toFixed(2)} vs ${none.toFixed(2)})`);
    assert.ok(tight < legacy - 2, `seed ${seed}: the tight treatment pulls pitch toward the sky line (${tight.toFixed(2)} vs ${legacy.toFixed(2)})`);
    assert.ok(Math.abs(err(clip.horizon)) < 2.5, `seed ${seed}: a geometric horizon pins pitch (${err(clip.horizon).toFixed(2)}°)`);
    // The bound is one-sided: a line 6° BELOW the true horizon forces pitch to at least its own pitch (less σ_sky).
    const below = err(G.skylineOf(clip.cam, { elevDeg: -6, tiltDeg: 0 }));
    assert.ok(below >= 6 - 2 * PARAMS.fit.skylineSigmaDeg, `seed ${seed}: pitch error ${below.toFixed(2)}° below a sky line 6° up`);
    if (below > none + 1) bound++;
  }
  assert.ok(bound >= 1, 'in at least one clip the bound is what lifts pitch');
});

test('every observation σ gets fit.sigmaFloorPx: correlated 1-2 px detection errors do not move τ (checker easy-09)', () => {
  const errs = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30, tau: 4, club: 'driver' });
    // Detector-like: σ claims 0.15 px, real errors are 0.3 px plus two correlated blocks (club or golfer in the crop).
    const obs = G.observe(clip, { realSec: 0.6, sigma: 0.3, seed: seed + 50 }).map((o, i) => ({ ...o, sigma: 0.15, y: o.y + (i >= 6 && i < 12 ? 1.8 : 0), x: o.x + (i < 6 ? -0.8 : 0) }));
    const fit = fitFlight(obs, G.fitCtx(clip, obs, { tauPrior: 'flat' }));
    errs.push(Math.abs(fit.tau / 4 - 1));
    assert.equal(fit.component, 0, `seed ${seed}: main lens kept`);
  }
  assert.ok(G.median(errs) <= 0.08, `median τ error ${(100 * G.median(errs)).toFixed(1)}% (no floor: about 13%)`);
  assert.ok(Math.max(...errs) <= 0.15, `max τ error ${(100 * Math.max(...errs)).toFixed(1)}%`);
});

test('τ stays near its capture/playback mode under aerodynamic mismatch (fit.tauLogSigma; checker easy-21 τ 3.3 vs 4)', () => {
  const errs = [];
  for (const view of ['oblique', 'dtl']) for (const seed of [1, 2, 3, 4, 5, 6]) {
    // gt-sim's richer aerodynamics (spin-dependent C_D/C_L, spin decay, wind) with a strong curve, 0.35 s real seen.
    const clip = G.makeClip({ seed, view, fps: 30, tau: 4, club: 'iron7', shot: { curveDeg: seed % 2 ? 20 : -20 }, windMax: 3 });
    const obs = G.observe(clip, { realSec: 0.35 });
    errs.push(Math.abs(fitFlight(obs, G.fitCtx(clip, obs, { tauPrior: 'flat' })).tau / 4 - 1));
  }
  assert.ok(G.median(errs) <= 0.1, `median τ error ${(100 * G.median(errs)).toFixed(1)}% (σ 0.5 nats: about 19%)`);
  assert.ok(Math.max(...errs) <= 0.15, `max τ error ${(100 * Math.max(...errs)).toFixed(1)}% (σ 0.5 nats: about 38%)`);
});

test('τ mode bookkeeping: a run that drifted toward another τ mode is charged and refit under that mode (EM-style)', () => {
  for (const seed of [1, 3]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30, tau: 4 }), obs = G.observe(clip, { realSec: 0.8 });
    const ctx = G.fitCtx(clip, obs, { tauPrior: 'flat' }), cold = fitFlight(obs, ctx);
    assert.equal(cold.tauMode, 4);
    // The state a start from τ = 2 leaves when its τ drifted to 4: labelled with the τ = 2 mode's prior.
    const st = cold._state, drifted = { ...cold, _state: { M: st.M, run: { ...st.run, PC: { ...st.run.PC, mode: { ...st.run.PC.mode, tau: 2 } } } } };
    const warm = fitFlight(obs, ctx, { warm: drifted });
    assert.equal(warm.tauMode, 4, `seed ${seed}: charged the τ = 4 mode`);
    assert.ok(Math.abs(warm.tau / cold.tau - 1) < 0.03, `seed ${seed}: τ ${warm.tau.toFixed(2)} vs ${cold.tau.toFixed(2)} (kept under τ = 2 it falls to about 3.5)`);
  }
});

test('R2 inputs: chi2Dof is the robust data χ²/dof (priors excluded); a stopping club-like track is implausible, a ball is not', () => {
  for (const seed of [1, 2, 3]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30 }), ball = G.observe(clip, { realSec: 0.5 });
    const fb = fitFlight(ball, G.fitCtx(clip, ball));
    assert.equal(fb.plausible, true, `seed ${seed}: ${fb.implausible}`);
    assert.deepEqual(fb.implausible, []);
    // σ_eff² = σ² + floor²: the data χ²/dof of a clean fit sits near σ²/σ_eff², whatever the priors say.
    const s = ball.map(o => o.sigma ** 2 / (o.sigma ** 2 + PARAMS.fit.sigmaFloorPx ** 2)), expect = s.reduce((a, b) => a + b, 0) / s.length;
    assert.ok(fb.chi2Dof > 0.5 * expect && fb.chi2Dof < 2 * expect, `seed ${seed}: chi2Dof ${fb.chi2Dof.toFixed(2)} vs ${expect.toFixed(2)}`);
    // A club head after impact: fast, then an exponential stop. M3D can only call that a ball launched into the turf.
    const v0 = { x: -900, y: -1400 }, T = 0.08, pos = t => { const k = T * (1 - Math.exp(-(t - clip.t0) / T)); return { x: clip.address.x + v0.x * k, y: clip.address.y + v0.y * k }; };
    const club = Array.from({ length: 15 }, (_, i) => { const t = clip.t0 + (i + 1) / 30, q = pos(t); return makeObservation({ index: i + 1, t, x: q.x + 0.2 * Math.sin(5 * i), y: q.y + 0.2 * Math.cos(3 * i), sigma: 0.4, z: 8, z1: 6, d: null, polarity: 1 }); });
    const fc = fitFlight(club, G.fitCtx(clip, club));
    assert.equal(fc.plausible, false, `seed ${seed}: elevation ${(fc.params[M3D_PARAM_NAMES.indexOf('elev')] / DEG).toFixed(1)}°`);
    assert.ok(fc.implausible.includes('elevation'));
  }
  // The definition, recomputed from predict(): Huber cost of the inlier data rows (x, y whitened by σ ⊕ floor, and the
  // log-radius rows) over rows − free parameters. No prior row enters it.
  {
    const clip = G.makeClip({ seed: 4, view: 'dtl', fps: 60 }), obs = G.observe(clip, { realSec: 0.6 }), F = PARAMS.fit;
    const fit = fitFlight(obs, G.fitCtx(clip, obs));
    let c = 0, rows = 0;
    obs.forEach((o, i) => {
      if (!fit.inlier[i]) return;
      const q = fit.predict(o.t), s = Math.sqrt(o.sigma ** 2 + F.sigmaFloorPx ** 2);
      for (const r of [(q.x - o.x) / s, (q.y - o.y) / s]) { c += huber(r, F.huberSigmas); rows++; }
      if (o.d != null && o.d / 2 >= F.minRadiusPx) { c += huber((Math.log(q.d) - Math.log(o.d)) / F.logRadiusSigma, F.huberSigmas); rows++; }
    });
    const free = fit.names.filter((_, k) => fit.cov[k * fit.names.length + k] > 0).length;
    assert.ok(Math.abs(fit.chi2Dof * fit.dof - c) < 1e-6 * (1 + c), `Huber data cost ${fit.chi2Dof * fit.dof} vs ${c}`);
    // dof = rows − effective parameters (trace of the hat matrix): between rows − free and rows.
    assert.ok(fit.dof > rows - free + 1 && fit.dof < rows, `dof ${fit.dof} for ${rows} rows, ${free} free: priors pin some parameters`);
    const k = fit.dof, q = k * Math.pow(1 - 2 / (9 * k) + F.r2Chi2Z * Math.sqrt(2 / (9 * k)), 3);
    assert.ok(Math.abs(fit.chi2Limit - Math.max(F.r2MaxRmsNorm ** 2, q / k)) < 1e-12);
  }
  // A face-on exit seen on 3 frames (sizes measured): its priors pin most of the 10 parameters, so the data have few
  // dof. Charged rows − free, a clean track would 'fail'; with the effective dof and the significance limit it passes.
  let naiveFails = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    // Detector-like: 0.6 px real error behind a claimed σ of 0.15 px (checker easy-15: a 4x slow-motion face-on ball,
    // 3 launch samples, then the edge).
    const clip = G.makeClip({ seed, view: 'fo', fps: 30, tau: 4, W: 1920, H: 1080 }), obs = G.observe(clip, { sigma: 0.6, seed: seed + 7 }).slice(0, 3).map(o => ({ ...o, sigma: 0.15 }));
    assert.equal(obs.length, 3);
    const fit = fitFlight(obs, G.fitCtx(clip, obs, { tauPrior: 'true' })), rows = 6 + obs.filter(o => o.d != null && o.d / 2 >= PARAMS.fit.minRadiusPx).length;
    assert.ok(fit.dof >= 3 && fit.dof <= rows - 1, `seed ${seed}: dof ${fit.dof.toFixed(2)} of ${rows} rows (rows − free would give 1)`);
    assert.ok(fit.chi2Dof <= fit.chi2Limit, `seed ${seed}: chi2Dof ${fit.chi2Dof.toFixed(2)} > limit ${fit.chi2Limit.toFixed(2)}`);
    assert.ok(fit.chi2Limit > PARAMS.fit.r2MaxRmsNorm ** 2, `seed ${seed}: few dof widen the limit (${fit.chi2Limit.toFixed(2)})`);
    if (rows <= 10 && fit.chi2Dof * fit.dof > PARAMS.fit.r2MaxRmsNorm ** 2) naiveFails++;   // max(1, rows − 10 free) = 1
  }
  assert.ok(naiveFails >= 3, `the naive dof would have rejected ${naiveFails}/6 clean exits`);
  // Forward validation may hand a non-ballistic track to the image model, whose local quadratics absorb a 5 px wobble
  // (s² about 1, it would pass): R2 still judges the physics, the M3D fit the image model replaced.
  for (const seed of [1, 2, 3]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 30 });
    const wob = G.observe(clip, { realSec: 1.0, sigma: 0.3 }).map((o, i) => ({ ...o, x: o.x + 5 * Math.sin(i / 3), y: o.y + 5 * Math.cos(i / 4) }));
    const f = fitFlight(wob, G.fitCtx(clip, wob));
    assert.equal(f.kind, 'image', `seed ${seed}`);
    assert.ok(f.rmsNorm ** 2 <= PARAMS.fit.r2MaxRmsNorm ** 2, `seed ${seed}: the image model alone would pass`);
    assert.equal(f.chi2Dof, f.m3d.chi2Dof);
    assert.ok(f.chi2Dof > PARAMS.fit.r2MaxRmsNorm ** 2, `seed ${seed}: M3D chi2Dof ${f.chi2Dof.toFixed(2)}`);
  }
  // The ranges are PARAMS: a wider elevation range accepts the same fit.
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 }), wide = mergeParams({ fit: { physical: { elevationDeg: [-40, 80] } } });
  const v0 = { x: -900, y: -1400 }, T = 0.08, pos = t => { const k = T * (1 - Math.exp(-(t - clip.t0) / T)); return { x: clip.address.x + v0.x * k, y: clip.address.y + v0.y * k }; };
  const club = Array.from({ length: 15 }, (_, i) => { const t = clip.t0 + (i + 1) / 30, q = pos(t); return makeObservation({ index: i + 1, t, x: q.x, y: q.y, sigma: 0.4, z: 8, z1: 6, d: null, polarity: 1 }); });
  assert.equal(fitFlight(club, G.fitCtx(clip, club, { params: wide })).plausible, true);
});
