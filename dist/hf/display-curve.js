/**
 * hf display curve (U5, protocol doc §8): ONE continuous arc, dense at display.hz, in stabilized native px.
 *   C(t) = model(t) + ρ(t) over the observed span, where ρ is a weighted cubic smoothing spline of the inlier
 *   residuals (λ by GCV), pinned to 0 at the anchor, plus an interpolating spline of whatever part of a residual
 *   exceeds 0.9·display.withinSigma·σ, so every inlier lies within 1.5σ of its sample exactly (still C²).
 *   Past the last observation ρ decays as [ρ(t_L) + ρ'(t_L)·(t − t_L)]·b(u),
 *   b(u) = 1 − 3u² + 2u³ over max(decay.frames, decay.realSec·τ) (or until the end), so the junction is C¹.
 * Without a physical model (kind 'image', or no fit) the observed span is a smoothing spline of the positions and
 * the image model continues it with the same decay. Statuses follow curveStatus; alpha is 1 except in the end fade.
 * Observations are never dropped: only the robust fit rejects outliers (fit.isInlier).
 */
import { curveStatus } from './types.js';
import { PARAMS } from './params.js';
import { honoredObservations } from './complete.js';

/* ------------------------------------------------------------------ smoothing spline (Reinsch, Green & Silverman §2.3) */

/**
 * Weighted natural cubic smoothing spline: minimizes Σ w_i (y_i − g_i)² + α ∫ g''² over knots t (strictly increasing).
 * With wantTrace it also returns tr(A), the trace of the hat matrix, from the band of B⁻¹ (Hutchinson-de Hoog).
 * @returns {{g:Float64Array, c2:Float64Array, trA:number}}  knot values and second derivatives (c2[0] = c2[n−1] = 0)
 */
export function smoothingSpline(t, y, w, alpha, wantTrace = false) {
  const n = t.length, g = Float64Array.from(y), c2 = new Float64Array(n);
  if (n < 3) return { g, c2, trA: n };
  const m = n - 2, h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = t[i + 1] - t[i];
  // Q columns c (knots c, c+1, c+2): q0 = 1/h_c, q1 = −1/h_c − 1/h_{c+1}, q2 = 1/h_{c+1}.
  const q0 = c => 1 / h[c], q1 = c => -1 / h[c] - 1 / h[c + 1], q2 = c => 1 / h[c + 1];
  const b0 = new Float64Array(m), b1 = new Float64Array(m), b2 = new Float64Array(m), rhs = new Float64Array(m);
  for (let c = 0; c < m; c++) {
    b0[c] = (h[c] + h[c + 1]) / 3 + alpha * (q0(c) ** 2 / w[c] + q1(c) ** 2 / w[c + 1] + q2(c) ** 2 / w[c + 2]);
    if (c + 1 < m) b1[c] = h[c + 1] / 6 + alpha * (q1(c) * q0(c + 1) / w[c + 1] + q2(c) * q1(c + 1) / w[c + 2]);
    if (c + 2 < m) b2[c] = alpha * q2(c) * q0(c + 2) / w[c + 2];
    rhs[c] = q0(c) * y[c] + q1(c) * y[c + 1] + q2(c) * y[c + 2];
  }
  // Banded LDLᵀ: B = L·D·Lᵀ with l1[i] = L(i+1, i), l2[i] = L(i+2, i).
  const D = new Float64Array(m), l1 = new Float64Array(m), l2 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let d = b0[i];
    if (i >= 1) d -= l1[i - 1] * l1[i - 1] * D[i - 1];
    if (i >= 2) d -= l2[i - 2] * l2[i - 2] * D[i - 2];
    D[i] = d > 1e-300 ? d : 1e-300;
    let e = b1[i];
    if (i >= 1) e -= l2[i - 1] * l1[i - 1] * D[i - 1];
    l1[i] = i + 1 < m ? e / D[i] : 0;
    l2[i] = i + 2 < m ? b2[i] / D[i] : 0;
  }
  const z = Float64Array.from(rhs);
  for (let i = 0; i < m; i++) { if (i >= 1) z[i] -= l1[i - 1] * z[i - 1]; if (i >= 2) z[i] -= l2[i - 2] * z[i - 2]; }
  for (let i = 0; i < m; i++) z[i] /= D[i];
  for (let i = m - 1; i >= 0; i--) { if (i + 1 < m) z[i] -= l1[i] * z[i + 1]; if (i + 2 < m) z[i] -= l2[i] * z[i + 2]; }
  for (let c = 0; c < m; c++) c2[c + 1] = z[c];
  // g = y − α W⁻¹ Q γ
  for (let i = 0; i < n; i++) {
    let qg = 0;
    if (i <= m - 1) qg += q0(i) * z[i];
    if (i - 1 >= 0 && i - 1 <= m - 1) qg += q1(i - 1) * z[i - 1];
    if (i - 2 >= 0 && i - 2 <= m - 1) qg += q2(i - 2) * z[i - 2];
    g[i] = y[i] - alpha * qg / w[i];
  }
  let trA = n;
  if (wantTrace) {
    // Band of S = B⁻¹: S(i, i), S(i, i+1), S(i, i+2).
    const s0 = new Float64Array(m + 2), s1 = new Float64Array(m + 2), s2 = new Float64Array(m + 2);
    for (let i = m - 1; i >= 0; i--) {
      s2[i] = i + 2 < m ? -l1[i] * s1[i + 1] - l2[i] * s0[i + 2] : 0;
      s1[i] = i + 1 < m ? -l1[i] * s0[i + 1] - l2[i] * s1[i + 1] : 0;
      s0[i] = 1 / D[i] - l1[i] * s1[i] - l2[i] * s2[i];
    }
    const S = (a, b) => { if (a > b) [a, b] = [b, a]; return b - a === 0 ? s0[a] : b - a === 1 ? s1[a] : b - a === 2 ? s2[a] : 0; };
    trA = 0;
    for (let i = 0; i < n; i++) {
      const cols = [], qs = [];
      if (i <= m - 1) { cols.push(i); qs.push(q0(i)); }
      if (i - 1 >= 0 && i - 1 <= m - 1) { cols.push(i - 1); qs.push(q1(i - 1)); }
      if (i - 2 >= 0 && i - 2 <= m - 1) { cols.push(i - 2); qs.push(q2(i - 2)); }
      let v = 0;
      for (let a = 0; a < cols.length; a++) for (let b = 0; b < cols.length; b++) v += qs[a] * S(cols[a], cols[b]) * qs[b];
      trA += 1 - alpha * v / w[i];
    }
  }
  return { g, c2, trA };
}

/** Value and derivative of the natural spline (knots t, values g, second derivatives c2) at s. */
function splineAt(t, g, c2, s, i) {
  const h = t[i + 1] - t[i], A = (t[i + 1] - s) / h, B = 1 - A;
  return {
    v: A * g[i] + B * g[i + 1] + ((A * A * A - A) * c2[i] + (B * B * B - B) * c2[i + 1]) * h * h / 6,
    d: (g[i + 1] - g[i]) / h + ((1 - 3 * A * A) * c2[i] + (3 * B * B - 1) * c2[i + 1]) * h / 6
  };
}

/** GCV-chosen α for one axis (log grid, then golden refinement). */
function gcvAlpha(t, y, w, wm) {
  const n = t.length;
  if (n < 4) return 0;
  const score = e => {
    const a = wm * 10 ** e, { g, trA } = smoothingSpline(t, y, w, a, true);
    let rss = 0;
    for (let i = 0; i < n; i++) rss += w[i] * (y[i] - g[i]) ** 2;
    const den = 1 - trA / n;
    return den > 1e-9 ? (rss / n) / (den * den) : Infinity;
  };
  let bestE = 0, best = Infinity;
  for (let e = -2; e <= 10; e += 0.5) { const s = score(e); if (s < best) { best = s; bestE = e; } }
  let lo = bestE - 0.5, hi = bestE + 0.5;
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo), f1 = score(x1), f2 = score(x2);
  for (let it = 0; it < 12; it++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = score(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = score(x2); }
  }
  return wm * 10 ** (f1 < f2 ? x1 : x2);
}

/* ------------------------------------------------------------------ the curve */

/**
 * Dense display curve (contract). completion null -> the curve ends at the last observation (no predicted points).
 * @param {import('./types.js').FlightFit|null} fit
 * @param {import('./types.js').Observation[]} obs  inlier observations to honor (fit-rejected ones are skipped)
 * @param {import('./types.js').Completion|null} completion
 * @param {import('./types.js').CurveContext & {hz?:number}} ctx  hz overrides params.display.hz (samples per video s)
 * @returns {import('./types.js').DisplayPoint[]}
 */
export function displayCurve(fit, obs, completion, ctx) {
  const P = ctx.params ?? PARAMS, Dp = P.display, meta = ctx.meta, L = ctx.launch, fps = meta.fps;
  const t0 = L.t0, ax = L.address.x, ay = L.address.y, tol = P.result.sampleTolSec;
  const hon = honoredObservations(fit, obs, t0);
  const anchor = { t: t0, x: ax, y: ay, status: 'anchor', alpha: 1 };
  if (!hon.length) return [anchor];
  const n = hon.length, tL = hon[n - 1].t;
  const comp = fit && completion && completion.end && completion.end.t >= tL - 1e-9 ? completion : null;
  const tEnd = comp ? Math.max(tL, comp.end.t) : tL, pinLast = !!comp && comp.end.t <= tL + tol;
  const model = fit ? (fit.at ? t => fit.at(t) : t => fit.predict(t)) : null;
  // A physics model that is non-finite at an observation (behind the camera) cannot carry the residual spline.
  const physics = !!fit && fit.kind === 'm3d' && hon.every(o => { const m = model(o.t); return Number.isFinite(m.x) && Number.isFinite(m.y); });

  // Knots in frames since t0 (well-conditioned α); anchor first with a pinning weight.
  const K = n + 1, kt = new Float64Array(K), kx = new Float64Array(K), ky = new Float64Array(K), w = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const o = hon[i], m = physics ? model(o.t) : { x: 0, y: 0 };
    kt[i + 1] = (o.t - t0) * fps; kx[i + 1] = o.x - m.x; ky[i + 1] = o.y - m.y; w[i + 1] = 1 / (o.sigma * o.sigma);
  }
  const wMax = Math.max(...w.subarray(1));
  w[0] = 1e8 * wMax; kx[0] = physics ? 0 : ax; ky[0] = physics ? 0 : ay;
  // S1: GCV smoothing spline per axis. S2: interpolating spline of the excess beyond 0.9·withinSigma·σ, so every
  // honored observation ends inside its limit exactly (the anchor, and a pinned last point, end exactly on it).
  const wRef = 1 / median(hon.map(o => o.sigma * o.sigma));
  const s1x = smoothingSpline(kt, kx, w, gcvAlpha(kt, kx, w, wRef)), s1y = smoothingSpline(kt, ky, w, gcvAlpha(kt, ky, w, wRef));
  const ex = new Float64Array(K), ey = new Float64Array(K);
  for (let i = 0; i < K; i++) {
    const lim = i === 0 || (pinLast && i === K - 1) ? 0 : 0.9 * Dp.withinSigma * hon[i - 1].sigma;
    const rx = kx[i] - s1x.g[i], ry = ky[i] - s1y.g[i], r = Math.hypot(rx, ry), f = r > lim ? 1 - lim / r : 0;
    ex[i] = rx * f; ey[i] = ry * f;
  }
  const s2x = smoothingSpline(kt, ex, w, 0), s2y = smoothingSpline(kt, ey, w, 0);
  const sx = { g: s1x.g.map((v, i) => v + s2x.g[i]), c2: s1x.c2.map((v, i) => v + s2x.c2[i]) };
  const sy = { g: s1y.g.map((v, i) => v + s2y.g[i]), c2: s1y.c2.map((v, i) => v + s2y.c2[i]) };

  // Residual spline evaluation, its value/slope at the last knot, decay window and the soft clamp.
  const tauEnd = fit ? (fit.ramp ? fit.ramp.tau[1] : fit.tau) : 1;
  const Tb = Math.min(Math.max(Dp.decay.frames / fps, Dp.decay.realSec * tauEnd), Math.max(tEnd - tL, 1e-9));
  const endX = splineAt(kt, sx.g, sx.c2, kt[K - 1], K - 2), endY = splineAt(kt, sy.g, sy.c2, kt[K - 1], K - 2);
  let jx = endX.v, jy = endY.v, jdx = endX.d * fps, jdy = endY.d * fps;   // per video second
  if (!physics && fit) {
    const m1 = model(tL), e = 1e-4 * Math.max(1, tauEnd), m0 = model(tL - e);
    jx -= m1.x; jy -= m1.y; jdx -= (m1.x - m0.x) / e; jdy -= (m1.y - m0.y) / e;
  }
  let clampR = Infinity;
  if (physics && fit.predict) {
    let sd = 0, cnt = 0;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 8))) { const d = fit.predict(hon[i].t).d; if (Number.isFinite(d)) { sd += d; cnt++; } }
    clampR = Dp.maxResidualD * (cnt ? sd / cnt : L.d0);
  }

  // Sample times: anchor, every 1/hz, every honored observation, the end.
  // Dense rate display.hz, lowered (never below the 1/maxPointGapSec gap rule) to stay within result.maxPoints.
  const R = P.result, hz = Math.max(1 / R.maxPointGapSec + 1e-6, Math.min(ctx.hz ?? Dp.hz, (R.maxPoints - 2 * n - 10) / Math.max(tEnd - t0, 1e-9)));
  const obsT = hon.map(o => o.t), fixed = comp && !pinLast ? [...obsT, tEnd] : obsT, sep = 0.05 / hz;
  const times = [];
  for (let j = 1; ; j++) {
    const t = t0 + j / hz;
    if (t >= tEnd - sep) break;
    times.push(t);
  }
  const all = [...times.filter(t => !nearAny(fixed, t, sep)), ...fixed].sort((a, b) => a - b);
  const half = Dp.observedHalfFrame / fps, fade = comp?.fade ?? null;
  const out = [anchor];
  let seg = 0;
  for (const t of all) {
    if (!(t > out[out.length - 1].t)) continue;
    const status = curveStatus(t, obsT, half);
    let x, y;
    if (t <= tL + tol) {
      const s = (t - t0) * fps;
      while (seg < K - 2 && kt[seg + 1] < s) seg++;
      let rx = splineAt(kt, sx.g, sx.c2, s, seg).v, ry = splineAt(kt, sy.g, sy.c2, s, seg).v;
      if (physics) {
        if (status === 'interpolated') { const r = Math.hypot(rx, ry); if (r > clampR) { rx *= clampR / r; ry *= clampR / r; } }
        const m = model(t); x = m.x + rx; y = m.y + ry;
      } else { x = rx; y = ry; }
    } else {
      const u = Math.min(1, (t - tL) / Tb), b = 1 - 3 * u * u + 2 * u * u * u, m = model(t);
      x = m.x + (jx + jdx * (t - tL)) * b; y = m.y + (jy + jdy * (t - tL)) * b;
    }
    let alpha = 1;
    if (fade && t > fade.from) alpha = Math.max(0, Math.min(1, (fade.to - t) / Math.max(fade.to - fade.from, 1e-12)));
    out.push({ t, x, y, status, alpha });
  }
  if (comp) {
    const lastP = out[out.length - 1];
    if (Math.abs(lastP.t - comp.end.t) <= tol) { lastP.x = comp.end.x; lastP.y = comp.end.y; }
    if (comp.end.type === 'fade' && !(lastP.alpha < 1)) lastP.alpha = 0;
  }
  return out;
}

function median(a) { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); }

function nearAny(sorted, t, sep) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Math.abs(sorted[m] - t) < sep) return true; if (sorted[m] < t) lo = m + 1; else hi = m - 1; }
  return false;
}
