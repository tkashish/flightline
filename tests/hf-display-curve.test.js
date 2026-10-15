import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, curveStatus, validateResult, cameraSamples, identityTrack, makeConfidence, makeObservation } from '../dist/hf/types.js';
import { fitFlight } from '../dist/hf/flight-model.js';
import { completeFlight, honoredObservations } from '../dist/hf/complete.js';
import { displayCurve, smoothingSpline } from '../dist/hf/display-curve.js';
import * as G from './hf/helpers/gt-sim.mjs';

const cpuMs = () => (typeof process !== 'undefined' && process.cpuUsage ? process.cpuUsage().user / 1000 : performance.now());

/** Fit, complete and draw one simulated clip (obsMap perturbs the observations before fitting). */
function scene(clipOpts, obsOpts, { obsMap = o => o, allow = true, ctxOpts = {}, params, observedEnd = 'lost' } = {}) {
  const clip = G.makeClip(clipOpts), obs = G.observe(clip, obsOpts).map(obsMap), ctx = G.fitCtx(clip, obs, { ...ctxOpts, ...(params ? { params } : {}) });
  const fit = fitFlight(obs, ctx), comp = completeFlight(fit, obs, G.completeCtx(clip, ctx, { observedEnd }));
  const curve = displayCurve(fit, obs, allow ? comp : null, G.curveCtx(clip, ctx));
  return { clip, obs, ctx, fit, comp: allow ? comp : null, curve, hon: honoredObservations(fit, obs, ctx.launch.t0) };
}
/** The pipeline's result assembly (U9), enough to run validateResult on the curve. */
function assemble({ clip, fit, comp, curve, hon, ctx }, status, reasonCodes) {
  const W = clip.W, H = clip.H, diag = Math.hypot(W, H), n = p => ({ x: p.x / W, y: p.y / H });
  return {
    points: curve.map(p => ({ t: p.t, ...n(p), status: p.status, ...(p.alpha < 1 ? { alpha: p.alpha } : {}) })),
    observations: hon.map(o => ({ t: o.t, ...n(o), sigma: o.sigma / diag })), camera: cameraSamples(identityTrack(clip.meta, [0, clip.meta.frameCount - 1]), clip.meta),
    engine: 'hf', observedFrames: hon.length, status, reasonCodes, confidence: makeConfidence(status === 'tracked' ? 0.9 : 0.7),
    launch: { t: ctx.launch.t0, ...n(ctx.launch.address), dir: ctx.launch.dir, view: fit.view },
    completion: comp ? { end: { type: comp.end.type, t: comp.end.t, ...n(comp.end) }, observedEnd: comp.observedEnd, observedSec: comp.observedSec, predictedSec: comp.predictedSec, slowMoFactor: comp.slowMoFactor } : null
  };
}
function curveInvariants(s, label) {
  const { curve, hon, ctx, clip, comp } = s, half = PARAMS.display.observedHalfFrame / clip.fps, ts = hon.map(o => o.t);
  assert.equal(curve[0].status, 'anchor', label);
  assert.deepEqual([curve[0].t, curve[0].x, curve[0].y], [ctx.launch.t0, ctx.launch.address.x, ctx.launch.address.y], `${label}: anchor at the launch`);
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i];
    assert.deepEqual(check('DisplayPoint', p), [], label);
    assert.ok(p.t > curve[i - 1].t && p.t - curve[i - 1].t <= PARAMS.result.maxPointGapSec + 1e-9, `${label}: gap at ${i}`);
    assert.equal(p.status, curveStatus(p.t, ts, half), `${label}: status at ${p.t}`);
    assert.ok(p.alpha <= curve[i - 1].alpha || curve[i - 1].alpha === 1 && p.alpha <= 1, `${label}: alpha never increases`);
  }
  for (const o of hon) {
    const p = curve.find(q => Math.abs(q.t - o.t) <= PARAMS.result.sampleTolSec);
    assert.ok(p, `${label}: a sample at every inlier observation (t=${o.t})`);
    assert.equal(p.status, 'observed');
    assert.ok(Math.hypot(p.x - o.x, p.y - o.y) <= PARAMS.display.withinSigma * o.sigma, `${label}: ${Math.hypot(p.x - o.x, p.y - o.y).toFixed(3)} px > 1.5σ (${o.sigma.toFixed(3)})`);
  }
  const last = curve[curve.length - 1];
  if (comp) assert.deepEqual([last.t, last.x, last.y], [comp.end.t, comp.end.x, comp.end.y], `${label}: the curve ends at completion.end`);
  else { assert.equal(last.t, hon.at(-1).t, `${label}: observed-only curves end at the last observation`); assert.ok(curve.every(p => p.status !== 'predicted')); }
}

/* ---------------------------------------------------------------- the smoothing spline */

test('smoothingSpline equals the dense penalized least-squares solution, with an exact hat-matrix trace', () => {
  const n = 11, t = Float64Array.from({ length: n }, (_, i) => i + 0.4 * Math.sin(i)), y = Float64Array.from(t, v => Math.sin(v) + 0.2 * Math.cos(5 * v)), w = Float64Array.from({ length: n }, (_, i) => 1 + (i % 4));
  const h = Array.from({ length: n - 1 }, (_, i) => t[i + 1] - t[i]), m = n - 2;
  const Q = Array.from({ length: n }, () => new Array(m).fill(0)), R = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let c = 0; c < m; c++) { Q[c][c] = 1 / h[c]; Q[c + 1][c] = -1 / h[c] - 1 / h[c + 1]; Q[c + 2][c] = 1 / h[c + 1]; R[c][c] = (h[c] + h[c + 1]) / 3; if (c + 1 < m) R[c][c + 1] = R[c + 1][c] = h[c + 1] / 6; }
  const inv = A => { const k = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => +(i === j))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c]; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= f * M[c][j]; } } return M.map(r => r.slice(k)); };
  const mul = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0))), T = A => A[0].map((_, j) => A.map(r => r[j]));
  const K = mul(mul(Q, inv(R)), T(Q));
  for (const alpha of [0.01, 0.7, 40]) {
    const S = inv(K.map((r, i) => r.map((v, j) => alpha * v + (i === j ? w[i] : 0))));
    const dense = S.map(r => r.reduce((s, v, k) => s + v * w[k] * y[k], 0)), trace = S.reduce((s, r, i) => s + r[i] * w[i], 0);
    const { g, trA } = smoothingSpline(t, y, w, alpha, true);
    g.forEach((v, i) => assert.ok(Math.abs(v - dense[i]) < 1e-10));
    assert.ok(Math.abs(trA - trace) < 1e-9, `trace ${trA} vs ${trace}`);
  }
  const interp = smoothingSpline(t, y, w, 0);
  interp.g.forEach((v, i) => assert.ok(Math.abs(v - y[i]) < 1e-12, 'α = 0 interpolates'));
});

/* ---------------------------------------------------------------- invariants on real fits */

test('curves pass every result invariant: landing (tracked), early fade (partial-a), observed-only (partial-b), face-on exit', () => {
  const cases = [
    ['landing', scene({ seed: 2, view: 'dtl', fps: 30 }, { realSec: 1.2 }), 'tracked', []],
    ['slow motion', scene({ seed: 3, view: 'dtl', fps: 30, tau: 8 }, { realSec: 1.0 }, { ctxOpts: { tauPrior: 'flat' } }), 'tracked', []],
    ['early fade', scene({ seed: 4, view: 'dtl', fps: 60 }, { realSec: 0.3 }), 'partial', ['completion_uncertain']],
    ['observed only', scene({ seed: 5, view: 'dtl', fps: 30 }, { realSec: 0.8 }, { allow: false }), 'partial', ['tracking_ended_early']],
    ['face-on exit', scene({ seed: 1, view: 'fo', fps: 240, W: 1920, H: 1080 }, { frac: 0.5 }, { observedEnd: 'frame_exit' }), 'tracked', []],
    ['outliers', scene({ seed: 6, view: 'dtl', fps: 30 }, { realSec: 1.2, outlierFrac: 0.08 }), 'tracked', []]
  ];
  for (const [label, s, status, codes] of cases) {
    curveInvariants(s, label);
    if (label === 'early fade') assert.equal(s.comp.end.type, 'fade');
    if (label === 'face-on exit') assert.equal(s.comp.end.type, 'exit');
    const r = assemble(s, status, codes), v = validateResult(r, { width: s.clip.W, height: s.clip.H, fps: s.clip.fps });
    assert.ok(v.ok, `${label}: ${v.errors.slice(0, 3).join('; ')}`);
  }
});

test('every inlier stays within 1.5σ under model mismatch, and no inlier is dropped', () => {
  // A smooth 2.5 px residual wobble the physics cannot follow (lens wobble, rolling shutter): the residual spline must.
  const wob = clip => o => ({ ...o, x: o.x + 2.5 * Math.sin(9 * (o.t - clip.t0)), y: o.y + 2.5 * Math.cos(7 * (o.t - clip.t0)) });
  for (const seed of [1, 7, 9]) {
    const base = G.makeClip({ seed, view: 'dtl', fps: 60 });
    const s = scene({ seed, view: 'dtl', fps: 60 }, { realSec: 1.0, sigma: 0.5 }, { obsMap: wob(base) });
    assert.equal(s.hon.length, s.obs.filter((o, i) => s.fit.inlier[i]).length, 'the curve honors exactly the fit inliers');
    curveInvariants(s, `wobble ${seed}`);
  }
});

test('the curve smooths measurement noise instead of chasing it (GCV), even with a residual wobble', () => {
  for (const wob of [0, 2.5]) for (const seed of [1, 2, 3]) {
    const clip = G.makeClip({ seed, view: 'dtl', fps: 60 }), w = t => wob * Math.sin(9 * (t - clip.t0));
    const obs = G.observe(clip, { realSec: 0.8, sigma: 0.8 }).map(o => ({ ...o, x: o.x + w(o.t) }));
    const ctx = G.fitCtx(clip, obs), fit = fitFlight(obs, ctx), curve = displayCurve(fit, obs, null, G.curveCtx(clip, ctx));
    let eC = 0, eO = 0, n = 0;
    for (const o of honoredObservations(fit, obs, ctx.launch.t0)) {
      const p = curve.find(q => Math.abs(q.t - o.t) < 1e-9), tr = clip.truthAt(o.t), tx = tr.x + w(o.t);
      eC += (p.x - tx) ** 2 + (p.y - tr.y) ** 2; eO += (o.x - tx) ** 2 + (o.y - tr.y) ** 2; n++;
    }
    assert.ok(Math.sqrt(eC / n) <= 0.7 * Math.sqrt(eO / n), `wobble ${wob} seed ${seed}: curve ${Math.sqrt(eC / n).toFixed(2)} px vs noise ${Math.sqrt(eO / n).toFixed(2)} px from the truth`);
  }
});

test('observations the robust fit rejects are skipped; everything else is honored', () => {
  const s = scene({ seed: 8, view: 'dtl', fps: 30 }, { realSec: 1.2, outlierFrac: 0.1, outlierPx: [30, 60], tagOutliers: true });
  const rejected = s.obs.filter((o, i) => !s.fit.inlier[i]);
  assert.ok(rejected.length >= 2 && rejected.every(o => o._outlier));
  for (const o of rejected) {
    const p = s.curve.find(q => Math.abs(q.t - o.t) <= PARAMS.result.sampleTolSec);
    assert.ok(!p || Math.hypot(p.x - o.x, p.y - o.y) > 10, 'the curve does not bend to a rejected point');
  }
  assert.equal(s.hon.length, s.obs.length - rejected.length);
});

test('the observed/predicted junction is C¹, and the residual correction decays to the model', () => {
  // A 4 Hz, 3 px wobble the physics cannot follow, phased for its steepest slope at the last observation: ρ carries
  // about 75 px/s into the junction, and the decay must continue it without a kink.
  const params = mergeParams({ display: { hz: 2400 } });
  const clip = G.makeClip({ seed: 3, view: 'dtl', fps: 60 }), raw = G.observe(clip, { realSec: 1.0, sigma: 0.3 }), tL = raw.at(-1).t;
  const obs = raw.map(o => ({ ...o, y: o.y + 3 * Math.sin(2 * Math.PI * 4 * (o.t - tL)) }));
  const ctx = G.fitCtx(clip, obs, { params }), fit = fitFlight(obs, ctx), comp = completeFlight(fit, obs, G.completeCtx(clip, ctx));
  const c = displayCurve(fit, obs, comp, G.curveCtx(clip, ctx)), k = c.findIndex(p => Math.abs(p.t - tL) <= 1e-9);
  assert.ok(k > 2 && k < c.length - 3);
  const v = (i, j) => ({ x: (c[j].x - c[i].x) / (c[j].t - c[i].t), y: (c[j].y - c[i].y) / (c[j].t - c[i].t) });
  const vm = v(k - 1, k), vp = v(k, k + 1), vmm = v(k - 2, k - 1), vpp = v(k + 1, k + 2), mv = fit.velocity(tL);
  const jump = Math.hypot(vp.x - vm.x, vp.y - vm.y), local = Math.hypot(vmm.x - vm.x, vmm.y - vm.y) + Math.hypot(vpp.x - vp.x, vpp.y - vp.y);
  const rhoSlope = Math.hypot(vm.x - mv.x, vm.y - mv.y);
  assert.ok(rhoSlope > 30, `the residual has a slope at the junction (${rhoSlope.toFixed(1)} px/s)`);
  assert.ok(jump <= 2 * local + 0.02 * rhoSlope, `velocity jump ${jump.toFixed(2)} px/s at the junction vs local change ${local.toFixed(2)}`);
  const Tb = Math.max(PARAMS.display.decay.frames / 60, PARAMS.display.decay.realSec * fit.tau);
  const after = c.filter(p => p.t > tL + Tb + 1e-6 && p.t < comp.end.t);
  assert.ok(after.length > 10);
  for (const p of after) { const m = fit.at(p.t); assert.ok(Math.hypot(p.x - m.x, p.y - m.y) < 1e-6, 'after the decay the curve is the model'); }
});

test('alpha is 1 except in the end fade, where it falls monotonically; a fade end fades the last point', () => {
  const f = scene({ seed: 4, view: 'dtl', fps: 30 }, { realSec: 0.3 });
  assert.equal(f.comp.end.type, 'fade');
  assert.equal(f.curve.at(-1).alpha, 0);
  const land = scene({ seed: 2, view: 'dtl', fps: 30 }, { realSec: 1.2 });
  assert.equal(land.comp.end.type, 'landing');
  for (const p of land.curve) {
    if (p.t <= land.comp.fade.from) assert.equal(p.alpha, 1);
    else assert.ok(Math.abs(p.alpha - Math.max(0, (land.comp.fade.to - p.t) / (land.comp.fade.to - land.comp.fade.from))) < 1e-12);
  }
  assert.ok(land.curve.filter(p => p.status !== 'predicted').every(p => p.alpha === 1), 'observed points never fade');
});

/* ---------------------------------------------------------------- other fits */

test('without a fit the curve is a smoothing spline through the anchor and the observations', () => {
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 }), obs = G.observe(clip, { realSec: 0.6 }), ctx = G.fitCtx(clip, obs);
  const curve = displayCurve(null, obs, null, G.curveCtx(clip, ctx));
  curveInvariants({ curve, hon: honoredObservations(null, obs, ctx.launch.t0), ctx, clip, comp: null }, 'no fit');
  const mid = curve.filter(p => p.status === 'interpolated' && p.t > obs[0].t);
  for (const p of mid) { const q = clip.truthAt(p.t); assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 3, 'interpolated samples follow the ball'); }
});

test('the image-model completion continues the observed spline without a kink', () => {
  const clip = G.makeClip({ seed: 1, view: 'dtl', fps: 60 });
  const line = t => ({ x: clip.address.x + 300 * (t - clip.t0), y: clip.address.y - 700 * (t - clip.t0) });
  const obs = Array.from({ length: 50 }, (_, i) => { const t = clip.t0 + (i + 1) / 60, q = line(t); return makeObservation({ index: i + 1, t, x: q.x + 0.3 * Math.sin(7 * i), y: q.y + 0.3 * Math.cos(3 * i), sigma: 0.6, z: 8, z1: 6, d: null, polarity: 1 }); });
  const ctx = G.fitCtx(clip, obs), fit = fitFlight(obs, ctx), comp = completeFlight(fit, obs, G.completeCtx(clip, ctx));
  assert.equal(fit.kind, 'image');
  const curve = displayCurve(fit, obs, comp, G.curveCtx(clip, ctx));
  curveInvariants({ curve, hon: honoredObservations(fit, obs, ctx.launch.t0), ctx, clip, comp }, 'image');
  const tL = obs.at(-1).t, k = curve.findIndex(p => Math.abs(p.t - tL) < 1e-9), a = curve[k - 1], b = curve[k], c = curve[k + 1];
  const v1 = Math.hypot((b.x - a.x) / (b.t - a.t), (b.y - a.y) / (b.t - a.t)), v2 = Math.hypot((c.x - b.x) / (c.t - b.t), (c.y - b.y) / (c.t - b.t));
  assert.ok(Math.abs(v1 - v2) < 0.05 * v1, `speed ${v1.toFixed(0)} -> ${v2.toFixed(0)} px/s across the junction`);
  assert.ok(curve.filter(p => p.status === 'predicted').every(p => Math.hypot(p.x - line(p.t).x, p.y - line(p.t).y) < 3));
});

test('a physics fit that is non-finite at an observation falls back to the position spline (no NaN in the curve)', () => {
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 }), obs = G.observe(clip, { realSec: 0.6 }), ctx = G.fitCtx(clip, obs);
  const fit = fitFlight(obs, ctx), broken = { ...fit, at: t => (Math.abs(t - obs[5].t) < 1e-9 ? { x: NaN, y: NaN } : fit.at(t)) };
  const curve = displayCurve(broken, obs, null, G.curveCtx(clip, ctx));
  assert.ok(curve.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  curveInvariants({ curve, hon: honoredObservations(broken, obs, ctx.launch.t0), ctx, clip, comp: null }, 'non-finite model');
});

test('duplicate observation times are merged and a pinned end on the last observation is honored', () => {
  const clip = G.makeClip({ seed: 2, view: 'dtl', fps: 30 }), obs = G.observe(clip, { realSec: 1.0 }), ctx = G.fitCtx(clip, obs);
  const dup = [...obs, { ...obs[5], x: obs[5].x + 0.2, sigma: obs[5].sigma * 2 }];
  assert.equal(honoredObservations(null, dup, ctx.launch.t0).length, obs.length);
  const fit = fitFlight(obs, ctx), comp = { ...completeFlight(fit, obs, G.completeCtx(clip, ctx)) };
  comp.end = { type: 'landing', t: obs.at(-1).t, x: obs.at(-1).x, y: obs.at(-1).y }; comp.fade = null;
  const curve = displayCurve(fit, obs, comp, G.curveCtx(clip, ctx));
  assert.deepEqual([curve.at(-1).t, curve.at(-1).x, curve.at(-1).y], [obs.at(-1).t, obs.at(-1).x, obs.at(-1).y]);
  assert.ok(curve.every(p => p.status !== 'predicted'));
});

test('ctx.hz sets the dense rate, never below the 1/60 s gap rule', () => {
  const s = scene({ seed: 2, view: 'dtl', fps: 30 }, { realSec: 1.2 });
  const at = hz => displayCurve(s.fit, s.obs, s.comp, { ...G.curveCtx(s.clip, s.ctx), hz });
  const n240 = at(240).length, n120 = s.curve.length, slow = at(10);
  assert.ok(n240 > 1.8 * n120 && n240 < 2.2 * n120, `${n240} vs ${n120} points`);
  for (let i = 1; i < slow.length; i++) assert.ok(slow[i].t - slow[i - 1].t <= PARAMS.result.maxPointGapSec + 1e-9);
});

test('display curve cost on a long slow-motion arc', () => {
  const s = scene({ seed: 3, view: 'dtl', fps: 30, tau: 8 }, { realSec: 1.5 }, { ctxOpts: { tauPrior: 'flat' } });
  const t = cpuMs();
  const curve = displayCurve(s.fit, s.obs, s.comp, G.curveCtx(s.clip, s.ctx));
  const ms = cpuMs() - t;
  assert.ok(curve.length > 3000, `${curve.length} points`);
  assert.ok(ms < 250, `displayCurve took ${ms.toFixed(1)} ms for ${curve.length} points`);
});
