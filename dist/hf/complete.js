/**
 * hf arc completion (U5, D3 §5.4): continue a fitted flight past the last observation to the first of
 *   landing  model height back at the address plane after the apex (FlightFit.landingT),
 *   exit     the prediction leaves the raw frame (ctx.camera) by exitMarginD·d and never comes back,
 *   fade     the predictive 1σ major axis reaches fadeEndDiag of the diagonal (alpha starts at fadeStartDiag),
 *   cap      t0 + capRealSec real seconds.
 * σ(t) is the fit's Laplace covariance pushed through the projection, inflated by κ·(t − t_last)·|v_last| (D2 §5.4).
 * The short-horizon image model (fit.kind 'image') fades early over imageHorizonRealSec. observedEnd (why
 * observation stopped) is reported separately from end.type (why the drawn arc stops).
 */
import { HFError, frameAt, simAt, applySim } from './types.js';
import { PARAMS } from './params.js';

/** Alias of completeFlight (the U5 task brief calls it completeTrack; the frozen contract name is completeFlight). */
export const completeTrack = (fit, obs, ctx) => completeFlight(fit, obs, ctx);

/** 1σ major axis (px) of a 2×2 covariance [sxx, sxy, syy]; Infinity when it is not finite. */
export function sigmaMajor(cov) {
  if (!cov) return Infinity;
  const a = cov[0], b = cov[1], c = cov[2];
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c))) return Infinity;
  const m = 0.5 * (a + c), d = Math.sqrt(0.25 * (a - c) * (a - c) + b * b);
  return Math.sqrt(Math.max(0, m + d));
}

/**
 * Observations a curve or completion must honor: flag 'inlier', after t0, finite, not rejected by the fit
 * (fit.isInlier(o) === false), sorted by t, one per time (the smaller sigma wins).
 */
export function honoredObservations(fit, obs, t0, tol = PARAMS.result.sampleTolSec) {
  const ok = (obs ?? []).filter(o => o && (o.flag ?? 'inlier') === 'inlier' && o.t > t0 && Number.isFinite(o.t) && Number.isFinite(o.x) && Number.isFinite(o.y) && o.sigma > 0 && fit?.isInlier?.(o) !== false);
  ok.sort((a, b) => a.t - b.t);
  const out = [];
  for (const o of ok) {
    const prev = out[out.length - 1];
    if (prev && o.t - prev.t <= tol) { if (o.sigma < prev.sigma) out[out.length - 1] = o; } else out.push(o);
  }
  return out;
}

/** Real seconds after t0 at video time t, and its inverse, for a fit with an optional speed ramp. */
export function realTime(fit, t0, t) {
  const r = fit.ramp;
  if (!r) return (t - t0) / fit.tau;
  const [a, b] = r.tau;
  return t <= r.tSplit ? (t - t0) / a : (r.tSplit - t0) / a + (t - r.tSplit) / b;
}
export function videoTime(fit, t0, tr) {
  const r = fit.ramp;
  if (!r) return t0 + fit.tau * tr;
  const [a, b] = r.tau, trS = (r.tSplit - t0) / a;
  return tr <= trS ? t0 + a * tr : r.tSplit + b * (tr - trS);
}

/**
 * End of the arc (contract). obs: the track's observations (only honored ones count); ctx: CompleteContext.
 * @param {import('./types.js').FlightFit} fit
 * @param {import('./types.js').Observation[]} obs
 * @param {import('./types.js').CompleteContext} ctx
 * @returns {import('./types.js').Completion}
 */
export function completeFlight(fit, obs, ctx) {
  if (!fit) throw new HFError('bad-arg', 'completeFlight needs a fit');
  const P = ctx.params ?? PARAMS, C = P.complete, meta = ctx.meta, L = ctx.launch;
  const W = meta.width, H = meta.height, diag = Math.hypot(W, H), t0 = L.t0;
  const hon = honoredObservations(fit, obs, t0);
  if (!hon.length) throw new HFError('bad-arg', 'completeFlight needs an inlier observation');
  const last = hon[hon.length - 1], tLast = last.t;
  const tau = fit.ramp ? Math.max(1e-6, (tLast - t0) / Math.max(1e-9, realTime(fit, t0, tLast))) : fit.tau;
  const tauEnd = fit.ramp ? fit.ramp.tau[1] : fit.tau;
  const tol = P.result.sampleTolSec;
  const tCap = videoTime(fit, t0, C.capRealSec);
  const image = fit.kind === 'image';
  const tLand = image || fit.landingT == null ? null : Math.max(tLast, fit.landingT);
  // The image model extrapolates at most imageHorizonRealSec, and never further than the span it was fitted on.
  const tImg = image ? tLast + Math.min(P.fit.imageHorizonRealSec * tauEnd, tLast - t0) : null;
  const tStop = Math.max(tLast, Math.min(tLand ?? Infinity, tCap, tImg ?? Infinity));
  const dt = Math.max(1 / P.display.hz, (tStop - tLast) / 20000);   // display rate, at most 20k steps (huge τ)

  const cam = ctx.camera, times = meta.times, nF = meta.frameCount ?? times?.length ?? 0;
  const toRaw = (x, y, t) => {
    if (!cam || !cam.index?.length || !nF) return { x, y };
    const k = Math.min(nF - 1, Math.max(0, frameAt(times, t)));
    return applySim(simAt(cam, k), x, y);
  };
  const [lo, hi] = P.result.coordRange, inRange = (x, y) => x >= lo * W && x <= hi * W && y >= lo * H && y <= hi * H;
  const outside = q => {
    if (!(Number.isFinite(q.x) && Number.isFinite(q.y))) return true;
    const r = toRaw(q.x, q.y, q.t), m = C.exitMarginD * q.d;
    return r.x < -m || r.x > W + m || r.y < -m || r.y > H + m;
  };
  const v = fit.velocity ? fit.velocity(tLast) : { x: 0, y: 0 }, vLast = Math.hypot(v.x, v.y) || 0;
  // Near a landing the end itself is uncertain along the track: blend in the landing-point σ (which includes
  // dt_L/dp) quadratically from the last observation to t_L, so an uncertain landing fades instead of committing.
  let landExtra = 0;
  if (tLand !== null && tLand > tLast && fit.landingCov) {
    const lc = fit.landingCov(), sl = lc ? sigmaMajor(lc) : 0, s0 = sigmaMajor(fit.predict(tLand).cov);
    if (Number.isFinite(sl) && sl > s0) landExtra = sl - s0;
  }
  const sigmaAt = q => {
    const u = landExtra && q.t > tLast ? Math.min(1, (q.t - tLast) / (tLand - tLast)) : 0;
    return Math.hypot(sigmaMajor(q.cov), C.kappa * (q.t - tLast) * vLast) + landExtra * u * u;
  };

  // One forward scan: permanent exit (last inside -> first outside), σ crossings, and runaway coordinates.
  let lastIn = tLast, firstOut = null, fadeFrom = null, fadeTo = null, runaway = false;
  for (let i = 0; ; i++) {
    const t = Math.min(tStop, tLast + i * dt), q = fit.predict(t);
    if (outside(q)) { if (firstOut === null) firstOut = t; } else { lastIn = t; firstOut = null; }
    const s = sigmaAt(q);
    if (fadeFrom === null && s >= C.fadeStartDiag * diag) fadeFrom = t;
    if (fadeTo === null && s >= C.fadeEndDiag * diag) fadeTo = t;
    if (!inRange(q.x, q.y)) { runaway = true; break; }
    if (t >= tStop) break;
  }
  let tExit = null;
  if (firstOut !== null) {
    // Outside from firstOut on (already at the last observation when firstOut === tLast): refine the crossing; a
    // model that leaves through non-finite space (behind the camera) ends at its last finite point instead.
    let a = lastIn, b = firstOut;
    for (let it = 0; it < 12 && b > a; it++) { const m = 0.5 * (a + b); if (outside(fit.predict(m))) b = m; else a = m; }
    const q = fit.at ? fit.at(b) : fit.predict(b);
    tExit = Number.isFinite(q.x) && Number.isFinite(q.y) ? b : a;
  } else if (runaway) tExit = lastIn;

  let type, tNat;
  if (tExit !== null && tExit < tStop + tol) { type = 'exit'; tNat = tExit; }
  else if (image) { type = 'fade'; tNat = tStop; }
  else if (tLand !== null && tLand <= tCap) { type = 'landing'; tNat = tLand; }
  else { type = 'cap'; tNat = tCap; }

  let end = tNat, fade = null;
  if (image) {
    // Short-horizon image model: always an early fade from the last observation (D1 §6.1, FINAL).
    const to = Math.min(tImg, fadeTo ?? Infinity);
    if (type !== 'exit' || to < tNat) { type = 'fade'; end = to; }
    fade = { from: tLast, to: Math.max(to, tLast) };
  } else if (fadeTo !== null && fadeTo < tNat) {
    type = 'fade'; end = fadeTo; fade = { from: fadeFrom ?? tLast, to: fadeTo };
  } else if (type === 'landing') {
    fade = { from: Math.min(fadeFrom ?? Infinity, Math.max(tLast, tLand - C.landingFadeRealSec * tauEnd)), to: tLand };
  } else if (type === 'cap') {
    fade = { from: Math.min(fadeFrom ?? Infinity, Math.max(tLast, tCap - C.landingFadeRealSec * tauEnd)), to: tCap };
  } else if (fadeFrom !== null && fadeFrom < tNat) fade = { from: fadeFrom, to: fadeTo ?? tNat };
  if (fade) { fade.from = Math.max(tLast, fade.from); if (!(fade.to - fade.from > tol)) fade = null; }
  const uncertain = image || (fadeFrom !== null && fadeFrom < tLast + C.uncertainBeforeFrac * (tNat - tLast));

  let ex, ey;
  if (end <= tLast + tol) { end = tLast; ex = last.x; ey = last.y; }
  else { const q = fit.at ? fit.at(end) : fit.predict(end); ex = q.x; ey = q.y; }
  return {
    end: { type, t: end, x: ex, y: ey }, observedEnd: ctx.observedEnd ?? 'lost', tLastObs: tLast,
    observedSec: (tLast - t0) / tau, predictedSec: (end - tLast) / tau, slowMoFactor: tau,
    fade, uncertain, ramp: !!fit.ramp
  };
}
