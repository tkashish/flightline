/**
 * hf U4 ROI detection: native-resolution ball evidence along a physics-predicted tube (FINAL "Flight
 * tracking", D3 §4.1-4.2, D2 §4.3). Each pushed frame holds three crops planned around the prediction: the
 * main ROI and two decoys offset ⟂ to the path by roi.decoyOffsetH·h. Per crop:
 *   residual  two-sided, lag-scaled background I_k − g·¼(I_{k−2L} + I_{k−L} + I_{k+L} + I_{k+2L}),
 *             L = ceil(bgLagRadii·r/|v|) pushed steps, so the ball moves ≥ 2.5 radii per lag and never
 *             self-subtracts; frames are registered by the camera similarity plus a local Lucas-Kanade shift
 *             (±registerPx, ball discs and lens specks masked); g matches exposure. When L > bgLagMax (slow
 *             apex, slow motion) a spatial background, Gaussian σ = 4r + 2 px, is used instead.
 *   z map     Gaussian matched filter σ = max(0.7 px, 0.35·d), divided by a tiled, outlier-robust RMS outside
 *             the ball disc: tiles whose mean square exceeds roi.noise.outlierRatio × the median of the live
 *             tiles (a golfer or club in the crop) keep their own RMS, interpolated between tile centres; the
 *             rest share one RMS over every kept pixel, codec skip blocks included (the MAD collapses on them),
 *             floored at the 8-bit rounding noise.
 *   TBD       centred window of 2J+1 pushed frames: S = Σ_j z_{k+j}(x + v·Δi_j + ½·a·Δi_j²)/√n over the 3σ position
 *             ellipse × the velocity grid around v_pred (a: optional predicted acceleration; sub-pixel and
 *             sub-grid refined); both polarities when the polarity is unknown.
 * Bounded work: the search σ is capped to what the largest crop holds, every rect is clipped to the frame and to
 * roi.halfSize.maxPx (decoys: maxPx plus one search radius), every search box to its map, and one detect call
 * shrinks its search until the TBD samples fit roi.maxDetectWork.
 * Decoys are 2×2 tiles of the main search region; their best scores are the empirical null and
 * T = nullThreshold(history, nTests), one history per pred.nullKey (an MHT branch). The best main peak with S ≥ T is accepted when the centre frame and
 * the window carry evidence evenly (an object crossing the path lights up a few frames), no velocity outside
 * the predicted grid explains it better (an airplane), it is no wider across the path than maxSizeD·max(d,
 * minSizePx), it is not a background ghost of an opposite-sign ball, and its polarity is consistent.
 * Units: native px, frames. r is the image radius max(d/2, √2·σ_mf): balls under 2 px are PSF-sized.
 */
import { PARAMS } from './params.js';
import { HFError, simAt, makeObservation } from './types.js';

const SQRT2 = Math.SQRT2, FWHM = 2 * Math.sqrt(2 * Math.LN2), EPS = 1e-9;
// Algorithm constants that have no params key (candidates for params.roi; adding keys is an integrator change).
const SIGMA_FLOOR_PX = 0.15;    // observation position σ floor (px); D2 §4.4
const CANDIDATES = 3;           // TBD peaks tried in score order (count)
const LK_ITERS = 2;             // local registration iterations (count)
const LK_FULL_PX = 4096;        // larger maps estimate the registration on every other row and column (px)
const DECOY_TURN = Math.PI / 6; // decoy direction is re-chosen after the path turns this much (rad)
const DECOY_HEADROOM = 1.25;    // decoy offset is set to this × decoyOffsetH·h and kept while h fits (ratio)
const VEL_STEPS = 6;            // wide velocity scan: (2·VEL_STEPS + 1)² velocities (count)
const RING = 2;                 // size check: 2·RING + 1 samples per side ... (count)
const RING_DEG = 20;            // ... spread over ±20° around the perpendicular (deg)
const SIZE_RATIO = 0.35;        // too wide when the response at (gate + FWHM_mf)/2 exceeds this × the peak: half
                                // maximum, discounted for the search's upward bias on the peak (ratio)
const GHOST_RATIO = 2;          // a candidate is a background ghost when the other-sign ball behind it is this much stronger (ratio; a pure ghost: 4)
const BOX_SIGMA = 4;            // an outrun frame's spatial background blurs with three box passes from this σ up (map px)
const DIAMETER_MAX_GATE = 0.75; // a size estimate above this × the gate is cut off by it: it measures the gate, not the ball (ratio; a ball fills gate/3)
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* ------------------------------------------------------------------ statistics */

const A_ = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B_ = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C_ = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D_ = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
/** z with P(Z > z) = q for a standard normal Z (Acklam, relative error below 1.2e-9). */
export function normalUpper(q) {
  if (!(q > 0)) return Infinity;
  if (q >= 1) return -Infinity;
  const p = Math.min(q, 1 - q);
  let x;
  if (p < 0.02425) {
    const s = Math.sqrt(-2 * Math.log(p));
    x = (((((C_[0] * s + C_[1]) * s + C_[2]) * s + C_[3]) * s + C_[4]) * s + C_[5]) / ((((D_[0] * s + D_[1]) * s + D_[2]) * s + D_[3]) * s + 1);
  } else {
    const s = p - 0.5, r = s * s;
    x = (((((A_[0] * r + A_[1]) * r + A_[2]) * r + A_[3]) * r + A_[4]) * r + A_[5]) * s / (((((B_[0] * r + B_[1]) * r + B_[2]) * r + B_[3]) * r + B_[4]) * r + 1);
  }
  return q < 0.5 ? -x : x;   // x is the lower-tail quantile of p
}

/**
 * Empirical-null threshold (D3 §4.2(4)): max(T_min, Q). T_min is the Gaussian tail at the per-frame family-wise
 * rate roi.nullAlpha over nTests tests. Q estimates the roi.nullQuantile q of the decoy scores, so a new null
 * score exceeds it with probability about 1 − q. A decoy score is the best of nTests correlated, roughly normal
 * TBD sums, so it is modelled as the maximum of nTests normals, F(x) = Φ((x − a)/b)^nTests, with a and b from
 * the median and quartiles of the history; Q is its q-quantile. Heavy codec tails raise Q to the order statistic
 * of rank ceil(q·(m+1)) once m plausible samples exist, and to their maximum while fewer than
 * roi.nullHistory[0] samples exist; a sample above F's 1 − (1 − q)/n quantile (a bird or a plane in a decoy) is
 * not plausible and cannot blind the tube.
 * @param {ArrayLike<number>} history  decoy scores
 * @param {number} nTests  positions × velocities × polarities of the search the threshold is for
 */
export function nullThreshold(history, nTests, params = PARAMS) {
  const R = params.roi, q = R.nullQuantile, N = Math.max(1, nTests), n = history.length;
  const tMin = normalUpper(R.nullAlpha / N);
  if (!n) return tMin;
  const s = Float64Array.from(history).sort();
  if (n < 4) return Math.max(tMin, s[n - 1]);
  const at = p => { const f = p * (n - 1), i = Math.floor(f); return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * (f - i) : s[n - 1]; };
  const u = p => normalUpper(-Math.expm1(Math.log(p) / N));   // standard-normal quantile of p^(1/N)
  const b = (at(0.75) - at(0.25)) / (u(0.75) - u(0.25)), a = at(0.5) - b * u(0.5), lim = a + b * u(1 - (1 - q) / n);
  let m = n, Q = a + b * u(q);
  while (m > 0 && s[m - 1] > lim) m--;   // plausible samples s[0..m)
  if (m && n < R.nullHistory[0]) Q = Math.max(Q, s[m - 1]);
  const rank = Math.ceil(q * (m + 1));
  if (rank <= m) Q = Math.max(Q, s[rank - 1]);
  return Math.max(tMin, Q);
}

/* ------------------------------------------------------------------ geometry */

/** Largest eigenvalue of [sxx, sxy, syy]. */
const lamMax = c => (c[0] + c[2]) / 2 + Math.hypot((c[0] - c[2]) / 2, c[1]);

/** cov scaled down so that its 1σ major axis is at most sMax (px); unchanged when already inside. */
function capCov(cov, sMax) {
  const l = lamMax(cov);
  if (!(l > sMax * sMax)) return cov;
  const k = sMax * sMax / l;
  return [cov[0] * k, cov[1] * k, cov[2] * k];
}

/**
 * Tube geometry for one frame (D3 §4.1-4.2, D2 §4.3); m = frames per pushed step (stride). searchCap is the
 * largest search σ the largest main crop holds (3σ + 1.5·d + pad ≤ halfSize.maxPx); searchSigma the prediction's
 * 1σ major axis capped to it.
 * @returns {{J:number, L:number, spatial:boolean, h:number, pool:number, sigmaMf:number, r:number, gate:number,
 *   spatialSigma:number, searchSigma:number, searchCap:number, speed:number, m:number}}  px, px/frame, steps
 */
export function tubeGeometry(pred, m = 1, params = PARAMS) {
  const R = params.roi, d = pred.d, speed = Math.hypot(pred.vx, pred.vy), step = speed * m;
  const J = speed > R.tbd.fastPx ? R.tbd.fastJ : R.tbd.J;
  const sigmaMf = Math.max(R.mfMinSigmaPx, R.mfSigmaD * d);
  const r = Math.max(d / 2, SQRT2 * sigmaMf);
  const lag = step > 0 ? Math.ceil(R.bgLagRadii * r / step - EPS) : Infinity;
  const spatial = !(lag <= R.bgLagMax);
  const hs = R.halfSize, sp = Math.sqrt(Math.max(0, lamMax(pred.cov)));
  const searchCap = Math.max(1, (hs.maxPx - hs.d * d - hs.padPx) / hs.sigmas);
  return {
    J, L: spatial ? 0 : Math.max(1, lag), spatial, sigmaMf, r, speed, m,
    h: clamp(hs.sigmas * sp + hs.d * d + J * speed * m + hs.padPx, hs.minPx, hs.maxPx),
    pool: Math.max(1, Math.round(d / R.poolD)),
    gate: R.maxSizeD * Math.max(d, R.minSizePx),
    spatialSigma: R.spatialSigmaR * r + R.spatialSigmaPx,
    searchSigma: Math.min(sp, searchCap), searchCap
  };
}

/** Spacing of the decoy search tiles: the search region's radius (3σ ellipse, floored as in searchBox). */
function tileRadius(cov, params, pool) {
  const sg = params.roi.halfSize.sigmas, f = (pool * SQRT2 / sg) ** 2;
  return sg * Math.sqrt(lamMax([cov[0] + f, cov[1], cov[2] + f])) + pool;
}

/**
 * rect clipped to the frame [0, W) × [0, H) on its pool grid (cropLuma marks only whole cells inside the frame
 * valid, so nothing valid is lost). A rect wholly outside keeps one cell at the nearest edge, which no search covers.
 */
function clipRect(rect, W, H, pool) {
  const x0 = Math.max(rect.x, 0), y0 = Math.max(rect.y, 0);
  const w = Math.floor((Math.min(rect.x + rect.w, W) - x0) / pool) * pool, h = Math.floor((Math.min(rect.y + rect.h, H) - y0) / pool) * pool;
  if (w >= pool && h >= pool) return { x: x0, y: y0, w, h };
  const lastX = Math.max(0, Math.floor(W / pool) - 1) * pool, lastY = Math.max(0, Math.floor(H / pool) - 1) * pool;
  return { x: clamp(Math.floor(rect.x / pool) * pool, 0, lastX), y: clamp(Math.floor(rect.y / pool) * pool, 0, lastY), w: pool, h: pool };
}

/* ------------------------------------------------------------------ image kernels */

const kernels = new Map();
function gaussKernel(sigma) {
  const key = Math.round(sigma * 1000);
  let k = kernels.get(key);
  if (!k) {
    const rad = Math.max(1, Math.ceil(3 * sigma)), w = new Float32Array(2 * rad + 1);
    let s = 0, s2 = 0;
    for (let i = -rad; i <= rad; i++) s += w[i + rad] = Math.exp(-i * i / (2 * sigma * sigma));
    for (let i = 0; i < w.length; i++) { w[i] /= s; s2 += w[i] * w[i]; }
    kernels.set(key, k = { w, rad, gain2: s2 * s2 });   // gain2: white-noise power gain of the 2-D kernel
  }
  return k;
}
let tmpA = new Float32Array(4096);
const scratch = n => { if (tmpA.length < n) tmpA = new Float32Array(2 * n); };

/** Separable Gaussian, zero outside the image. */
function blur(src, w, h, sigma, out) {
  const { w: k, rad } = gaussKernel(sigma);
  scratch(w * h);
  const t = tmpA;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= rad && x < w - rad) for (let i = 0, q = o + x - rad; i <= 2 * rad; i++, q++) s += src[q] * k[i];
      else for (let i = Math.max(-rad, -x), b = Math.min(rad, w - 1 - x); i <= b; i++) s += src[o + x + i] * k[i + rad];
      t[o + x] = s;
    }
  }
  // vertical pass by whole rows: contiguous inner loops
  out.fill(0, 0, w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let i = Math.max(-rad, -y), b = Math.min(rad, h - 1 - y); i <= b; i++) {
      const kk = k[i + rad], r = o + i * w;
      for (let x = 0; x < w; x++) out[o + x] += kk * t[r + x];
    }
  }
  return out;
}

/**
 * Three box passes approximating a Gaussian of σ (map px), zero outside the image, O(1) per pixel whatever σ: the
 * spatial background's σ = 4r + 2 px reaches 15+ map px in early flight, where the 6σ-wide exact kernel cost
 * 100+ ms per detect. Box widths after Kutskir: n = 3 passes of widths wl or wl + 2 matching the variance.
 */
function boxBlur3(src, w, h, sigma, out) {
  const wIdeal = Math.sqrt(12 * sigma * sigma / 3 + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  scratch(w * h);
  let a = Float32Array.from(src.subarray ? src.subarray(0, w * h) : src), b = out;
  for (let pass = 0; pass < 3; pass++) {
    const r = ((pass < m ? wl : wl + 2) - 1) >> 1, inv = 1 / (2 * r + 1), t = tmpA;
    for (let y = 0; y < h; y++) {   // horizontal running sum: a -> t
      const o = y * w;
      let acc = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) acc += a[o + x];
      for (let x = 0; x < w; x++) {
        t[o + x] = acc * inv;
        const add = x + r + 1, sub = x - r;
        if (add < w) acc += a[o + add];
        if (sub >= 0) acc -= a[o + sub];
      }
    }
    for (let x = 0; x < w; x++) {   // vertical running sum: t -> b
      let acc = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) acc += t[y * w + x];
      for (let y = 0; y < h; y++) {
        b[y * w + x] = acc * inv;
        const add = y + r + 1, sub = y - r;
        if (add < h) acc += t[add * w + x];
        if (sub >= 0) acc -= t[sub * w + x];
      }
    }
    if (pass < 2) { const c = a; a = b; b = pass === 0 ? new Float32Array(w * h) : c; }
  }
  if (b !== out) out.set(b.subarray(0, w * h));
  return out;
}

/** Gaussian mean of src over the pixels with valid[i] = 1 (normalized convolution); box-approximated when fast. */
function blurNormalized(src, valid, w, h, sigma, out, fast = false) {
  const n = w * h, num = new Float32Array(n), den = new Float32Array(n), f = fast && sigma >= BOX_SIGMA ? boxBlur3 : blur;
  for (let i = 0; i < n; i++) if (valid[i]) { num[i] = src[i]; den[i] = 1; }
  const bn = f(num, w, h, sigma, new Float32Array(n)), bd = f(den, w, h, sigma, new Float32Array(n));
  for (let i = 0; i < n; i++) out[i] = bd[i] > 1e-6 ? bn[i] / bd[i] : 0;
  return out;
}

/** k-th smallest of a[0..n) (in place, quickselect). */
function select(a, n, k) {
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const p = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
/** Median and 1.4826·MAD of vals[0..n) (vals is scrambled). */
function robustStats(vals, n) {
  if (!n) return { med: 0, sigma: 0 };
  const med = select(vals, n, n >> 1);
  for (let i = 0; i < n; i++) vals[i] = Math.abs(vals[i] - med);
  return { med, sigma: 1.4826 * select(vals, n, n >> 1) };
}

/** Bilinear sample at index coordinates (u, v), pixel centres at integers; 0 outside the map. */
function bilinear(d, w, h, u, v, scale = 1) {
  const iu = Math.floor(u), iv = Math.floor(v);
  if (iu < 0 || iv < 0 || iu >= w - 1 || iv >= h - 1) {
    const ru = Math.round(u), rv = Math.round(v);
    return Math.abs(u - ru) < EPS && Math.abs(v - rv) < EPS && ru >= 0 && rv >= 0 && ru < w && rv < h ? d[rv * w + ru] * scale : 0;
  }
  const fu = u - iu, fv = v - iv, i = iv * w + iu;
  return ((d[i] * (1 - fu) + d[i + 1] * fu) * (1 - fv) + (d[i + w] * (1 - fu) + d[i + w + 1] * fu) * fv) * scale;
}

/* ------------------------------------------------------------------ affine index maps */

// An affine map p -> (ax·x + bx·y + cx, ay·x + by·y + cy).
const affApply = (A, x, y) => [A.ax * x + A.bx * y + A.cx, A.ay * x + A.by * y + A.cy];
function affInv(A) {
  const det = A.ax * A.by - A.bx * A.ay, ax = A.by / det, bx = -A.bx / det, ay = -A.ay / det, by = A.ax / det;
  return { ax, bx, ay, by, cx: -(ax * A.cx + bx * A.cy), cy: -(ay * A.cx + by * A.cy) };
}
/** P ∘ Q (Q first). */
const affCompose = (P, Q) => ({
  ax: P.ax * Q.ax + P.bx * Q.ay, bx: P.ax * Q.bx + P.bx * Q.by, cx: P.ax * Q.cx + P.bx * Q.cy + P.cx,
  ay: P.ay * Q.ax + P.by * Q.ay, by: P.ay * Q.bx + P.by * Q.by, cy: P.ay * Q.cx + P.by * Q.cy + P.cy
});
const affShift = (A, dx, dy) => ({ ...A, cx: A.cx + A.ax * dx + A.bx * dy, cy: A.cy + A.ay * dx + A.by * dy });
const isShift = A => Math.abs(A.ax - 1) < 1e-9 && Math.abs(A.by - 1) < 1e-9 && Math.abs(A.bx) < 1e-9 && Math.abs(A.ay) < 1e-9;
/** Stabilized px -> index coordinates of a crop (pixel centres at integers) through its frame similarity. */
const stabToIndex = (sim, x0, y0, pool) => ({
  ax: sim.a / pool, bx: -sim.b / pool, cx: (sim.tx - x0) / pool - 0.5,
  ay: sim.b / pool, by: sim.a / pool, cy: (sim.ty - y0) / pool - 0.5
});

/** Warp src (A: dst index -> src index) onto a w×h grid; outValid marks samples inside srcValid. */
function warp(src, sw, sh, sv, A, w, h, out, outValid) {
  if (isShift(A)) return warpShift(src, sw, sh, sv, A.cx, A.cy, w, h, out, outValid);
  for (let y = 0; y < h; y++) {
    let u = A.bx * y + A.cx, v = A.by * y + A.cy;
    for (let x = 0; x < w; x++, u += A.ax, v += A.ay) {
      const o = y * w + x, iu = Math.floor(u), iv = Math.floor(v);
      if (iu < 0 || iv < 0 || iu >= sw - 1 || iv >= sh - 1) {
        const ru = Math.round(u), rv = Math.round(v), q = rv * sw + ru;
        const hit = Math.abs(u - ru) < 1e-6 && Math.abs(v - rv) < 1e-6 && ru >= 0 && rv >= 0 && ru < sw && rv < sh && sv[q];
        out[o] = hit ? src[q] : 0; outValid[o] = hit ? 1 : 0;
        continue;
      }
      const i = iv * sw + iu, fu = u - iu, fv = v - iv;
      if (!(sv[i] & sv[i + 1] & sv[i + sw] & sv[i + sw + 1])) { out[o] = 0; outValid[o] = 0; continue; }
      out[o] = (src[i] * (1 - fu) + src[i + 1] * fu) * (1 - fv) + (src[i + sw] * (1 - fu) + src[i + sw + 1] * fu) * fv;
      outValid[o] = 1;
    }
  }
}

/** warp() for a pure translation (u + du, v + dv): one set of bilinear weights for the whole grid. */
function warpShift(src, sw, sh, sv, du, dv, w, h, out, outValid) {
  const iu = Math.floor(du + 1e-9), iv = Math.floor(dv + 1e-9), fu = du - iu < 1e-9 ? 0 : du - iu, fv = dv - iv < 1e-9 ? 0 : dv - iv;
  const k00 = (1 - fu) * (1 - fv), k10 = fu * (1 - fv), k01 = (1 - fu) * fv, k11 = fu * fv, ex = fu > 0 ? 1 : 0, ey = fv > 0 ? 1 : 0;
  out.fill(0, 0, w * h); outValid.fill(0, 0, w * h);
  const x0 = Math.max(0, -iu), x1 = Math.min(w, sw - ex - iu), y0 = Math.max(0, -iv), y1 = Math.min(h, sh - ey - iv);
  for (let y = y0; y < y1; y++) {
    let i = (y + iv) * sw + x0 + iu, o = y * w + x0;
    for (let x = x0; x < x1; x++, i++, o++) {
      if (!(sv[i] & sv[i + ex] & sv[i + ey * sw] & sv[i + ex + ey * sw])) continue;
      out[o] = k00 * src[i] + k10 * src[i + ex] + k01 * src[i + ey * sw] + k11 * src[i + ex + ey * sw];
      outValid[o] = 1;
    }
  }
}

/* ------------------------------------------------------------------ TBD over z maps */

/**
 * A z map seen through stabilized coordinates: data (Float32Array, or Int8Array × scale), w×h, and A mapping
 * stabilized px to its index coordinates. A window is the centred run of views with frame offsets dIdx.
 * @typedef {{data:ArrayLike<number>, w:number, h:number, scale:number, A:object}} MapView
 */
function makeWindow(views, c, dIdx, acc = null) {
  const inv = affInv(views[c].A), ax = acc ? acc[0] : 0, ay = acc ? acc[1] : 0;
  // path offset of frame j beyond the velocity term: ½·a·Δi² (predicted acceleration, px/frame²)
  return { views, c, dIdx, acc: [ax, ay], T: views.map(V => affCompose(V.A, inv)), qx: dIdx.map(t => 0.5 * ax * t * t), qy: dIdx.map(t => 0.5 * ay * t * t) };
}

/** Σ_j z_j(path) for a box of centre-map positions and each velocity, into out (nv × nu·nw). */
function tbdBox(win, box, vels, out) {
  const { views, dIdx } = win, { u0, w0, nu, nw } = box, nPos = nu * nw, nv = vels.length >> 1;
  out.fill(0, 0, nv * nPos);
  for (let j = 0; j < views.length; j++) {
    const V = views[j], T = win.T[j], shift = isShift(T), d = V.data, W = V.w, H = V.h, sc = V.scale;
    for (let vi = 0; vi < nv; vi++) {
      const dx = vels[2 * vi] * dIdx[j] + win.qx[j], dy = vels[2 * vi + 1] * dIdx[j] + win.qy[j], base = vi * nPos;
      const ou = T.cx + V.A.ax * dx + V.A.bx * dy, ow = T.cy + V.A.ay * dx + V.A.by * dy;
      if (shift) {
        // constant fractional offset: fixed bilinear weights
        const su = u0 + ou, sw = w0 + ow, iu = Math.floor(su), iw = Math.floor(sw), fu = su - iu, fw = sw - iw;
        const k00 = (1 - fu) * (1 - fw) * sc, k10 = fu * (1 - fw) * sc, k01 = (1 - fu) * fw * sc, k11 = fu * fw * sc;
        const x0 = Math.max(0, -iu), x1 = Math.min(nu, W - 1 - iu), y0 = Math.max(0, -iw), y1 = Math.min(nw, H - 1 - iw);
        for (let y = y0; y < y1; y++) {
          let i = (iw + y) * W + iu + x0, o = base + y * nu + x0;
          for (let x = x0; x < x1; x++, i++, o++) out[o] += k00 * d[i] + k10 * d[i + 1] + k01 * d[i + W] + k11 * d[i + W + 1];
        }
      } else {
        for (let y = 0; y < nw; y++) for (let x = 0; x < nu; x++) {
          const u = u0 + x, w = w0 + y;
          out[base + y * nu + x] += bilinear(d, W, H, T.ax * u + T.bx * w + ou, T.ay * u + T.by * w + ow, sc);
        }
      }
    }
  }
}

/** Per-frame samples z_j(x + v·Δi_j) of the path through centre-map position (u, w) at velocity (vx, vy). */
function pathSamples(win, u, w, vx, vy, out) {
  const { views, dIdx, T } = win;
  for (let j = 0; j < views.length; j++) {
    const V = views[j], t = T[j], dx = vx * dIdx[j] + win.qx[j], dy = vy * dIdx[j] + win.qy[j];
    out[j] = bilinear(V.data, V.w, V.h, t.ax * u + t.bx * w + t.cx + V.A.ax * dx + V.A.bx * dy, t.ay * u + t.by * w + t.cy + V.A.ay * dx + V.A.by * dy, V.scale);
  }
  return out;
}
function pathScore(win, u, w, vx, vy, buf) {
  pathSamples(win, u, w, vx, vy, buf);
  let s = 0;
  for (let j = 0; j < win.views.length; j++) s += buf[j];
  return s / Math.sqrt(win.views.length);
}

/** Quadratic peak of a 3×3 neighbourhood (row-major): offset, value, Hessian. */
function quadPeak(f) {
  const fx = (f[5] - f[3]) / 2, fy = (f[7] - f[1]) / 2;
  const fxx = f[5] - 2 * f[4] + f[3], fyy = f[7] - 2 * f[4] + f[1], fxy = (f[8] - f[6] - f[2] + f[0]) / 4;
  const det = fxx * fyy - fxy * fxy;
  if (!(fxx < 0 && fyy < 0 && det > 0)) return { dx: 0, dy: 0, value: f[4], hxx: fxx, hxy: fxy, hyy: fyy, ok: false };
  const dx = clamp(-(fyy * fx - fxy * fy) / det, -1, 1), dy = clamp(-(fxx * fy - fxy * fx) / det, -1, 1);
  return { dx, dy, value: f[4] + fx * dx + fy * dy + 0.5 * (fxx * dx * dx + 2 * fxy * dx * dy + fyy * dy * dy), hxx: fxx, hxy: fxy, hyy: fyy, ok: true };
}

/** g×g velocity grid (px/frame) around (vx, vy), spaced `spacing`; index k = row·g + column. */
function velocityGrid(vx, vy, g, spacing) {
  const out = new Float64Array(2 * g * g), c = (g - 1) / 2;
  for (let i = 0, k = 0; i < g; i++) for (let j = 0; j < g; j++, k++) { out[2 * k] = vx + (j - c) * spacing; out[2 * k + 1] = vy + (i - c) * spacing; }
  return out;
}

/**
 * Search positions: centre-map pixels inside the 3σ ellipse around (x, y) (stabilized px), plus a one-pixel
 * margin for the sub-pixel fit. cov is floored so the nearest map pixels are always searched. The box is clipped
 * to the map (plus the margin), so its size never exceeds the map whatever the covariance; whole is false when
 * the ellipse reached beyond the map (a decoy tile then gives no null sample of the full search's size).
 */
function searchBox(view, x, y, cov, sigmas, pixelPx) {
  const f = (pixelPx * SQRT2 / sigmas) ** 2, sxx = cov[0] + f, sxy = cov[1], syy = cov[2] + f;
  const det = sxx * syy - sxy * sxy, ixx = syy / det, ixy = -sxy / det, iyy = sxx / det;
  const [cu, cw] = affApply(view.A, x, y), rad = sigmas * Math.sqrt(lamMax([sxx, sxy, syy])) / pixelPx + 1;
  const bu0 = Math.floor(cu - rad), bw0 = Math.floor(cw - rad), bu1 = Math.ceil(cu + rad), bw1 = Math.ceil(cw + rad);
  const u0 = Math.max(bu0, -1), w0 = Math.max(bw0, -1), nu = Math.max(0, Math.min(bu1, view.w) - u0 + 1), nw = Math.max(0, Math.min(bw1, view.h) - w0 + 1);
  const whole = bu0 + 1 >= 0 && bw0 + 1 >= 0 && bu1 - 1 < view.w && bw1 - 1 < view.h;
  if (nu < 3 || nw < 3) return { u0, w0, nu: 0, nw: 0, inside: new Uint8Array(0), count: 0, whole };
  const inside = new Uint8Array(nu * nw), inv = affInv(view.A), s2 = sigmas * sigmas;
  let count = 0;
  for (let j = 1; j < nw - 1; j++) for (let i = 1; i < nu - 1; i++) {
    const u = u0 + i, w = w0 + j;
    if (u < 0 || w < 0 || u >= view.w || w >= view.h) continue;
    const [px, py] = affApply(inv, u, w), dx = px - x, dy = py - y;
    if (dx * dx * ixx + 2 * dx * dy * ixy + dy * dy * iyy <= s2) { inside[j * nu + i] = 1; count++; }
  }
  return { u0, w0, nu, nw, inside, count, whole };
}

/**
 * TBD peaks over a search box: per position the best velocity and polarity (the second polarity pays
 * `penalty`); local maxima in score order, NMS radius nmsPx (map px), each refined to sub-pixel position and
 * sub-grid velocity.
 */
function searchPeaks(win, box, vels, pols, penalty, maxPeaks, nmsPx) {
  const nv = vels.length >> 1, nPos = box.nu * box.nw, S = new Float32Array(nv * nPos);
  tbdBox(win, box, vels, S);
  const norm = 1 / Math.sqrt(win.views.length);
  const best = new Float32Array(nPos).fill(-Infinity), bestV = new Int32Array(nPos), bestP = new Int8Array(nPos);
  for (let p = 0; p < nPos; p++) {
    if (!box.inside[p]) continue;
    for (let vi = 0; vi < nv; vi++) {
      const s = S[vi * nPos + p] * norm;
      for (let k = 0; k < pols.length; k++) {
        const e = pols[k] * s - (k ? penalty : 0);
        if (e > best[p]) { best[p] = e; bestV[p] = vi; bestP[p] = pols[k]; }
      }
    }
  }
  const peaks = [];
  for (let j = 1; j < box.nw - 1; j++) for (let i = 1; i < box.nu - 1; i++) {
    const p = j * box.nu + i, v = best[p];
    if (!box.inside[p]) continue;
    let isMax = true;
    for (let dj = -1; dj <= 1 && isMax; dj++) for (let di = -1; di <= 1; di++) {
      const q = p + dj * box.nu + di;
      if ((di || dj) && box.inside[q] && best[q] > v) { isMax = false; break; }
    }
    if (isMax) peaks.push({ i, j, score: v, vi: bestV[p], pol: bestP[p] });
  }
  peaks.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const pk of peaks) {
    if (kept.length >= maxPeaks) break;
    if (!kept.some(q => Math.hypot(q.i - pk.i, q.j - pk.j) < nmsPx)) kept.push(pk);
  }
  const buf = new Float64Array(win.views.length);
  for (const pk of kept) refinePeak(win, box, vels, S, norm, pk, pols, penalty, buf);
  return kept.sort((a, b) => b.score - a.score);
}

/**
 * Sub-pixel position (quadratic on the S map at the peak velocity), then velocity (quadratic on the grid at that
 * position). The position stays refined; the score is the best of the grid score and the refined re-evaluations.
 */
function refinePeak(win, box, vels, S, norm, pk, pols, penalty, buf) {
  const nPos = box.nu * box.nw, f = new Float64Array(9), sgn = pk.pol, pen = sgn === pols[0] ? 0 : penalty;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) f[(dj + 1) * 3 + di + 1] = sgn * S[pk.vi * nPos + (pk.j + dj) * box.nu + pk.i + di] * norm;
  const q = quadPeak(f), u = box.u0 + pk.i + q.dx, w = box.w0 + pk.j + q.dy, g = Math.round(Math.sqrt(vels.length >> 1));
  let vx = vels[2 * pk.vi], vy = vels[2 * pk.vi + 1], best = sgn * pathScore(win, u, w, vx, vy, buf);
  if (g >= 3) {
    const fv = new Float64Array(9), ci = clamp(pk.vi % g, 1, g - 2), cj = clamp((pk.vi / g) | 0, 1, g - 2), sp = vels[2] - vels[0];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const k = (cj + dj) * g + ci + di;
      fv[(dj + 1) * 3 + di + 1] = sgn * pathScore(win, u, w, vels[2 * k], vels[2 * k + 1], buf);
    }
    const qv = quadPeak(fv), k0 = cj * g + ci;
    let bi = 4;
    for (let t = 0; t < 9; t++) if (fv[t] > fv[bi]) bi = t;
    if (fv[bi] > best) { const k = (cj + ((bi / 3) | 0) - 1) * g + ci + (bi % 3) - 1; best = fv[bi]; vx = vels[2 * k]; vy = vels[2 * k + 1]; }
    if (qv.ok) {
      const rx = vels[2 * k0] + qv.dx * sp, ry = vels[2 * k0 + 1] + qv.dy * sp, sr = sgn * pathScore(win, u, w, rx, ry, buf);
      if (sr > best) { best = sr; vx = rx; vy = ry; }
    }
  }
  return Object.assign(pk, { u, w, vx, vy, score: Math.max(pk.score, best - pen), hess: q });
}

/**
 * Track-before-detect over cached z maps (stabilized ZMaps; shared with U6 reassociate). The window is the J
 * maps on each side of the one whose index is pred.index; positions are its pixels in the 3σ ellipse of
 * pred.cov; velocities a grid×grid grid around (pred.vx, pred.vy) spaced `spacing` px per window step, with the
 * optional acceleration (pred.ax, pred.ay); pred.polarity 0 tests both signs.
 * @param {import('./types.js').ZMap[]} zmaps  sorted by index
 * @param {import('./types.js').Prediction} pred
 * @returns {{S:number, x:number, y:number, vx:number, vy:number, polarity:1|-1, z1:number}|null}
 */
export function tbdSearch(zmaps, pred, { J = PARAMS.roi.tbd.J, grid = PARAMS.roi.tbd.grid, spacing = PARAMS.roi.tbd.spacing, sigmas = PARAMS.roi.halfSize.sigmas } = {}) {
  const ci = zmaps.findIndex(z => z.index === pred.index);
  if (ci < 0) return null;
  const lo = Math.max(0, ci - J), win = zmaps.slice(lo, ci + J + 1), c = ci - lo;
  const views = win.map(z => ({ data: z.data, w: z.w, h: z.h, scale: 1 / z.zScale, A: { ax: 1 / z.pool, bx: 0, cx: -z.x0 / z.pool - 0.5, ay: 0, by: 1 / z.pool, cy: -z.y0 / z.pool - 0.5 } }));
  const m = win.length > 1 ? (win[win.length - 1].index - win[0].index) / (win.length - 1) : 1;
  const box = searchBox(views[c], pred.x, pred.y, pred.cov, sigmas, win[c].pool);
  if (!box.count) return null;
  const vels = velocityGrid(pred.vx, pred.vy, grid, spacing / m), pols = pred.polarity ? [pred.polarity] : [1, -1];
  const peaks = searchPeaks(makeWindow(views, c, win.map(z => z.index - pred.index), [pred.ax || 0, pred.ay || 0]), box, vels, pols, 0, 1, 0);
  if (!peaks.length) return null;
  const pk = peaks[0], V = views[c], [x, y] = affApply(affInv(V.A), pk.u, pk.w);
  return { S: pk.score, x, y, vx: pk.vx, vy: pk.vy, polarity: pk.pol, z1: pk.pol * bilinear(V.data, V.w, V.h, pk.u, pk.w, V.scale) };
}

/* ------------------------------------------------------------------ the tube */

const PURPOSES = ['main', 'decoy', 'decoy'];
const TILES = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const DEFAULT_KEY = '';   // null history of predictions without a nullKey
const NULL_KEYS = 16;     // null histories kept per tube (count; MHT branches are ≤ 2·track.maxBranches)

/**
 * One prediction-guided ROI tube (contract RoiTubeLike, protocol doc §7 U4). Drive it per frame with
 * plan(index, pred) -> crops -> push(index, t, crops, sim); call detect(index, pred) once ready(index).
 */
export class RoiTube {
  /** @param {import('./types.js').RoiTubeOptions} o */
  constructor({ meta, camera, params = PARAMS, polarity = 0, specks = [] } = {}) {
    if (!meta || !camera) throw new HFError('bad-arg', 'RoiTube needs meta and camera');
    this.meta = meta; this.camera = camera; this.params = params; this.polarity = polarity; this.specks = specks;
    // Decoy null scores per pred.nullKey (one history per MHT branch: branches search regions of different sizes,
    // and the null must not depend on which branch probed a frame first), newest last, at most roi.nullHistory[1].
    this._nulls = new Map();
    this._plans = new Map(); this._recs = new Map(); this._order = [];
    this._bgRef = { 1: null, '-1': null };
    this._miss = false;
    this._decoys = null;
  }

  /** The default (unkeyed) null history: decoy scores, newest last. */
  get history() { return this._hist(DEFAULT_KEY).h; }

  /** The null history of a key; a new key starts as a copy of `from`'s (an MHT child inherits its parent's null). */
  _hist(key, from = null, index = -1) {
    let e = this._nulls.get(key);
    if (!e) {
      const src = from != null ? this._nulls.get(from) : null;
      e = { h: src ? [...src.h] : [], last: index };
      this._nulls.set(key, e);
      if (this._nulls.size > NULL_KEYS) {   // forget the history unused longest (an ended branch)
        let old = null;
        for (const [k, v] of this._nulls) if (k !== key && k !== DEFAULT_KEY && (!old || v.last < old[1].last)) old = [k, v];
        if (old) this._nulls.delete(old[0]);
      }
    }
    if (index > e.last) e.last = index;
    return e;
  }

  /** Crops for frame index: [main, decoy, decoy] in raw native px, pooled; pred in stabilized px. */
  plan(index, pred) {
    const last = this._order.length ? this._order[this._order.length - 1] : null;
    if (last !== null && index <= last) throw new HFError('bad-arg', `plan(${index}) after push(${last})`);
    const R = this.params.roi, g = tubeGeometry(pred, last === null ? 1 : index - last, this.params);
    const sim = simAt(this.camera, index), W = this.meta.width, H = this.meta.height;
    const raw = (x, y) => [sim.a * x - sim.b * y + sim.tx, sim.b * x + sim.a * y + sim.ty];
    // A decoy centre must be inside the frame by a search radius; tiles that leave it give no null sample. The
    // search (and so the tiles) never exceeds what the largest main crop holds, however wide the prediction.
    const tile = tileRadius(capCov(pred.cov, g.searchSigma), this.params, g.pool), margin = R.halfSize.sigmas * (g.searchSigma + g.sigmaMf) + g.pool;
    const inside = (x, y) => { const [X, Y] = raw(x, y); return X >= margin && Y >= margin && X <= W - margin && Y <= H - margin; };
    // Decoys at ±decoyOffsetH·h ⟂ to the path; one leaving the frame moves to the far side, beyond the other.
    // The offsets are sticky (re-chosen only when h outgrows them, the path turned by DECOY_TURN or a decoy
    // left the frame): a decoy that wobbles with a jittery prediction decorrelates codec noise and under-reads
    // the null.
    const sp = Math.hypot(pred.vx, pred.vy), px = sp > EPS ? -pred.vy / sp : 1, py = sp > EPS ? pred.vx / sp : 0;
    const off = R.decoyOffsetH * g.h, D = this._decoys;
    if (!D || D.off < off || D.off > DECOY_HEADROOM * DECOY_HEADROOM * off || Math.abs(D.dir[0] * px + D.dir[1] * py) < Math.cos(DECOY_TURN) ||
      D.o.some(([ox, oy]) => !inside(pred.x + ox, pred.y + oy))) {
      const o = off * DECOY_HEADROOM;
      this._decoys = {
        off: o, dir: [px, py],
        o: [1, -1].map(k => {
          const a = [k * o * px, k * o * py], b = [-2 * k * o * px, -2 * k * o * py];
          return !inside(pred.x + a[0], pred.y + a[1]) && inside(pred.x + b[0], pred.y + b[1]) ? b : a;
        })
      };
    }
    const centres = [[pred.x, pred.y], ...this._decoys.o.map(([ox, oy]) => [pred.x + ox, pred.y + oy])];
    // Decoy crops hold 2×2 search regions the size of the main one (8 null samples per frame). Half-sizes: main ≤
    // halfSize.maxPx, decoys ≤ maxPx + tile (both capped through searchSigma); every rect is clipped to the frame.
    const rects = centres.map(([x, y], i) => {
      const half = Math.min(g.h + (i ? tile : 0), (i ? 2 : 1) * R.halfSize.maxPx), [X, Y] = raw(x, y), n = Math.max(2, Math.ceil(2 * half / g.pool));
      const r = { x: Math.floor((X - n * g.pool / 2) / g.pool) * g.pool, y: Math.floor((Y - n * g.pool / 2) / g.pool) * g.pool, w: n * g.pool, h: n * g.pool };
      return clipRect(r, W, H, g.pool);
    });
    this._plans.set(index, { index, g, pred: { ...pred, cov: [...pred.cov] }, centres, rects, background: pred.background === true });
    return rects.map((rect, i) => ({ rect, pool: g.pool, purpose: PURPOSES[i] }));
  }

  /** Crops of a planned frame, in plan order; sim maps stabilized -> raw px of this frame. */
  push(index, t, crops, sim) {
    const plan = this._plans.get(index);
    if (!plan) throw new HFError('bad-arg', `push(${index}) without plan()`);
    const last = this._order.length ? this._order[this._order.length - 1] : null;
    if (last !== null && index <= last) throw new HFError('bad-arg', `push(${index}) after push(${last})`);
    if (!Array.isArray(crops) || crops.length !== plan.rects.length) throw new HFError('bad-arg', `push(${index}): expected ${plan.rects.length} crops`);
    const S = sim ?? simAt(this.camera, index);
    const rec = { index, t, step: this._order.length, sim: S, plan, slots: crops.map(c => this._slot(c, S)), z: [null, null, null], reg: new Map() };
    this._recs.set(index, rec);
    this._order.push(index);
    // Keep what a detection can still need: a centred window (J) whose frames reach 2L, one-sided ends 4L.
    let Lmax = 1, Jmax = 1;
    for (const r of this._recs.values()) { Lmax = Math.max(Lmax, r.plan.g.L); Jmax = Math.max(Jmax, r.plan.g.J); }
    const keep = 2 * Jmax + 4 * Lmax + 2;
    for (const [k, r] of this._recs) if (r.step < rec.step - keep) this._recs.delete(k);
    for (const k of this._plans.keys()) if (k < index && !this._recs.has(k)) this._plans.delete(k);
  }

  /** True once every crop the centred window at index needs is in (crops up to index + J + 2L). */
  ready(index) {
    const rec = this._recs.get(index);
    if (!rec) return false;
    for (let j = 0; j <= rec.plan.g.J; j++) {
      const r = this._atStep(rec.step + j);
      if (!r || !this._backgrounds(r).final) return false;
    }
    return true;
  }

  /**
   * Detection at a pushed frame: call it once ready(index), or at the end of the frames with whatever is in.
   * Beside the contract fields the result has mode ('temporal'|'spatial'), L, reason (null when accepted, else why
   * the best peak was not: 'threshold'|'peak_z'|'window'|'velocity'|'size'|'ghost'), and the search it ran: grid
   * (velocity grid side), searchSigma (px, after the crop and work caps) and nTests.
   * @param {number} index
   * @param {import('./types.js').Prediction & {ax?:number, ay?:number, covV?:number[], sv?:number, coasting?:boolean,
   *   nullKey?:string, nullFrom?:string|null, probe?:boolean}} pred
   *   Prediction extras, all optional (the contract agreed with U6):
   *   - ax, ay (px/frame²): predicted acceleration; the TBD path is x + v·Δi + ½·a·Δi² (early flight decelerates
   *     hard in perspective, a straight path loses it);
   *   - sv (px/frame) or covV ((px/frame)²): the predicted VELOCITY uncertainty; the 5×5 velocity grid is used only
   *     when it exceeds one grid spacing per step (default without either: the position σ spread over J steps);
   *   - coasting: cache the wide z map (after a gap, for re-association);
   *   - nullKey: the null history to use (one per MHT branch); a new key starts from nullFrom's history;
   *   - probe: a confirmation at a known peak: no decoy search, no history update; T comes from the key's history
   *     and this frame's decoy burst for that key;
   *   - background (plan only): the frame only serves later frames as a background (before impact); it never joins
   *     a TBD window.
   *   A frame may be probed again with other predictions; its decoy scores enter each key's history once.
   * @returns {import('./types.js').RoiDetection|null}  null when the frame is unknown or unusable
   */
  detect(index, pred) {
    const rec = this._recs.get(index);
    if (!rec) return null;
    const P = this.params, R = P.roi, g = rec.plan.g, J = g.J, force = !this.ready(index), acc = [pred.ax || 0, pred.ay || 0];
    const main = this._window(rec, 0, J, force, acc);
    if (!main) return null;
    const key = pred.nullKey ?? DEFAULT_KEY, probe = pred.probe === true, hist = this._hist(key, pred.nullFrom ?? null, index);
    // Polarity: unknown -> both signs; known -> the other sign only after a large background change (D3 §4.2(5)).
    const pol0 = pred.polarity || this.polarity, bg = rec.slots[0].mean;
    if (pol0 && this._bgRef[pol0] === null) this._bgRef[pol0] = bg;
    const flip = pol0 !== 0 && Math.abs(bg - this._bgRef[pol0]) > R.polarityFlipLevels;
    const pols = pol0 ? (flip ? [pol0, -pol0] : [pol0]) : [1, -1], penalty = flip ? R.oppositePolarityZ : 0;
    // Velocity grid around v_pred spaced roi.tbd.spacing px per step; 5×5 when the velocity is uncertain.
    const sv = pred.covV ? Math.sqrt(lamMax(pred.covV)) * g.m : Number.isFinite(pred.sv) ? pred.sv * g.m : g.searchSigma / J;
    let gridN = sv > R.tbd.spacing ? R.tbd.wideGrid : R.tbd.grid;
    // Search covariance: the prediction's, capped to what the crop holds, then to the per-call work cap
    // roi.maxDetectWork on the TBD samples (positions × velocities × window frames, decoy tiles included): the
    // wide grid goes first, then the search shrinks around the prediction.
    const pool = rec.slots[0].pool, sg = R.halfSize.sigmas, parts = probe ? 1 : 1 + 2 * TILES.length, nV = main.views.length;
    const work = (c, gn) => { const r = sg * Math.sqrt(lamMax(c)) / pool + 1; return Math.PI * r * r * gn * gn * nV * parts; };
    let cov = capCov(pred.cov, g.searchCap);
    if (work(cov, gridN) > R.maxDetectWork) gridN = R.tbd.grid;
    if (work(cov, gridN) > R.maxDetectWork) {
      const rMax = Math.sqrt(R.maxDetectWork / (Math.PI * gridN * gridN * nV * parts));
      cov = capCov(cov, Math.max(pool, (rMax - 1) * pool / sg));
    }
    const spacing = R.tbd.spacing / g.m, vels = velocityGrid(pred.vx, pred.vy, gridN, spacing), nms = Math.max(1, g.gate / 2 / pool);
    const box = searchBox(main.views[main.c], pred.x, pred.y, cov, sg, pool);
    if (!box.count) return null;   // the prediction is off the map
    // Empirical null: the best score of every decoy tile whose search region is all valid image (not for probes).
    const nullScores = [];
    if (!probe) {
      const tile = tileRadius(cov, P, pool);
      for (let s = 1; s < 3; s++) {
        const win = this._window(rec, s, J, force, acc);
        if (!win) continue;
        const [cx, cy] = rec.plan.centres[s];
        for (const [tx, ty] of TILES) {
          const tb = searchBox(win.views[win.c], cx + tx * tile, cy + ty * tile, cov, sg, rec.slots[s].pool);
          if (!tb.count || !tb.whole || !this._covered(win.z, tb)) continue;
          const peaks = searchPeaks(win, tb, vels, pols, penalty, CANDIDATES, nms);
          if (peaks.length) nullScores.push(peaks[0].score);
        }
      }
    }
    // One frame adds its decoy scores once per key, however often it is probed (MHT probes call detect again).
    rec.nulls ??= new Map();
    if (!probe && !rec.nulls.has(key)) {
      rec.nulls.set(key, nullScores.length ? Math.max(...nullScores) : -Infinity);
      for (const v of nullScores) hist.h.push(v);
      if (hist.h.length > R.nullHistory[1]) hist.h.splice(0, hist.h.length - R.nullHistory[1]);
    }
    // A decoy burst in this very frame (codec refresh, exposure step) raises this frame's threshold too.
    const burst = probe ? (rec.nulls.get(key) ?? -Infinity) : nullScores.length ? Math.max(...nullScores) : -Infinity;
    const T = Math.max(nullThreshold(hist.h, box.count * (vels.length >> 1) * pols.length, P), burst);
    const peaks = searchPeaks(main, box, vels, pols, penalty, CANDIDATES, nms);
    if (!peaks.length) return null;
    const out = {
      index, t: rec.t, observation: null, zmap: this._zmap(rec, main.z, pred, pred.coasting ?? this._miss), score: peaks[0].score,
      threshold: T, nullScores, mode: main.z.mode, L: main.z.L, reason: 'threshold',
      grid: gridN, searchSigma: Math.sqrt(lamMax(cov)), nTests: box.count * (vels.length >> 1) * pols.length
    };
    const buf = new Float64Array(main.views.length), gone = [], gateIdx = g.gate / rec.slots[0].pool;
    for (const pk of peaks) {
      if (pk.score < T) break;
      // A peak on an object already found too wide or moving otherwise is that object again.
      if (gone.some(q => Math.hypot(q.u - pk.u, q.w - pk.w) < gateIdx)) continue;
      const why = this._check(rec, pred, main, pk, gridN, spacing, buf);
      if (why) {
        if (pk === peaks[0]) out.reason = why;
        if (why === 'size' || why === 'velocity') gone.push(pk);
        continue;
      }
      out.reason = null;
      return this._finish(out, this._observation(rec, main, pk, bg), probe);
    }
    return this._finish(out, null, probe);
  }

  /** Test/diagnostic view of a slot's residual at index: {data, w, h, x0, y0, pool, mode, L, sigma (shared noise), outlierTiles}. */
  residual(index, slot = 0) {
    const rec = this._recs.get(index);
    if (!rec) return null;
    const z = this._z(rec, slot, !this._backgrounds(rec).final), sl = rec.slots[slot];
    return z && { data: z.res, w: sl.w, h: sl.h, x0: sl.x0, y0: sl.y0, pool: sl.pool, mode: z.mode, L: z.L, sigma: z.sigma, outlierTiles: z.outlierTiles };
  }

  /* -------------------------------------------------------------- internals */

  _finish(out, obs, probe = false) {
    out.observation = obs;
    if (!probe) this._miss = !obs;   // a confirmation probe does not change the tube's coasting state
    return out;
  }

  _atStep(step) { return step >= 0 && step < this._order.length ? this._recs.get(this._order[step]) : undefined; }

  /**
   * Background frames of rec: ±L and ±2L when all exist ('two', final); at the start of the tube ±L only, or L and 2L
   * ahead when nothing precedes ('fwd'); at the end L and 2L behind ('back', never final: only a forced detection
   * uses it); none in spatial mode. When a chosen background frame's crop does not hold rec's position (fast or
   * decelerating early flight: the ball outruns crops capped at halfSize.maxPx, and a temporal residual needing
   * every background would be empty there), a spatial residual marked outrun; outrun frames form TBD windows of
   * their own (_window), so the temporal windows stay as they were.
   */
  _backgrounds(rec) {
    const g = rec.plan.g;
    if (g.spatial) return { kind: 'spatial', bgs: [], final: true };
    const L = g.L, at = k => this._atStep(rec.step + k), prev = at(-L), next = at(L), holds = b => this._holds(b, rec);
    const outrun = { kind: 'spatial', bgs: [], final: true, outrun: true };
    if (prev && next) {
      if (!holds(prev) || !holds(next)) return outrun;
      const p2 = at(-2 * L), n2 = at(2 * L);
      if (p2 && n2) return holds(p2) && holds(n2) ? { kind: 'two', bgs: [p2, prev, next, n2], final: true } : outrun;
      return { kind: 'two', bgs: [prev, next], final: rec.step - 2 * L < 0 };
    }
    if (rec.step - L < 0) {
      const n2 = at(2 * L);
      if ((next && !holds(next)) || (n2 && !holds(n2))) return outrun;
      return { kind: 'fwd', bgs: [next, n2].filter(Boolean), final: !!n2 };
    }
    const bgs = [prev, at(-2 * L)].filter(Boolean);
    return bgs.every(holds) ? { kind: 'back', bgs, final: false } : { ...outrun, final: false };
  }

  /**
   * Background frame b's main crop holds rec's predicted position: otherwise a temporal residual of rec needing b is
   * empty where the ball is. Partial cover of the search box is fine (pixels without every background are left out,
   * as always).
   */
  _holds(b, rec) {
    const sl = b.slots[0], vb = sl.vb, p = rec.plan.pred, [u, w] = affApply(sl.A, p.x, p.y);
    return u >= vb.x0 && w >= vb.y0 && u <= vb.x1 - 1 && w <= vb.y1 - 1;
  }

  _slot(c, sim) {
    const n = c.w * c.h, data = Float32Array.from(c.data), valid = new Uint8Array(n), b = c.valid;
    let sum = 0, cnt = 0;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) { const i = y * c.w + x; valid[i] = 1; sum += data[i]; cnt++; }
    // Lens-fixed specks stay put in raw px while the camera moves: mask them in every crop (D3 §4.3).
    for (const sp of this.specks) {
      const rr = sp.r + c.pool * Math.SQRT1_2;
      const i0 = Math.max(0, Math.floor((sp.x - rr - c.x0) / c.pool)), i1 = Math.min(c.w - 1, Math.floor((sp.x + rr - c.x0) / c.pool));
      const j0 = Math.max(0, Math.floor((sp.y - rr - c.y0) / c.pool)), j1 = Math.min(c.h - 1, Math.floor((sp.y + rr - c.y0) / c.pool));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (Math.hypot(c.x0 + c.pool * (i + 0.5) - sp.x, c.y0 + c.pool * (j + 0.5) - sp.y) <= rr) valid[j * c.w + i] = 0;
      }
    }
    return { x0: c.x0, y0: c.y0, pool: c.pool, w: c.w, h: c.h, data, valid, vb: b, mean: cnt ? sum / cnt : 0, A: stabToIndex(sim, c.x0, c.y0, c.pool) };
  }

  /**
   * Centred window of z maps for slot s (frames that cannot be computed are left out), or null without the
   * centre map. A decoy path keeps the main path's place in its crops: its frames shift by the change of the
   * decoy offset, so the null statistic sees the main statistic's crop geometry.
   */
  _window(rec, s, J, force, acc = null) {
    const views = [], dIdx = [], o0 = this._offset(rec, s), z0 = this._z(rec, s, force);
    if (!z0) return null;
    let c = -1, zc = null;
    for (let j = -J; j <= J; j++) {
      // A frame planned as a background only (pred.background: before impact, the ball sits at the address) never
      // joins a TBD window, and so its own z map is never computed.
      const r = this._atStep(rec.step + j), z = r && (j ? (r.plan.background ? null : this._z(r, s, force)) : z0);
      if (!z) continue;
      // A frame whose ball outran its neighbours' crops has a spatial residual: its z is not on the temporal
      // frames' scale, so a window keeps to one kind (the outrun frames of fast early flight form their own).
      if (!!z.outrun !== !!z0.outrun) continue;
      if (!j) { c = views.length; zc = z; }
      const o = this._offset(r, s);
      views.push({ data: z.z, w: z.w, h: z.h, scale: 1, A: s ? affShift(r.slots[s].A, o[0] - o0[0], o[1] - o0[1]) : r.slots[s].A });
      dIdx.push(r.index - rec.index);
    }
    return { ...makeWindow(views, c, dIdx, acc), z: zc };
  }

  /** Decoy offset of slot s at rec (decoy centre − main prediction, stabilized px); [0, 0] for the main. */
  _offset(rec, s) { const c = rec.plan.centres[s], p = rec.plan.pred; return s ? [c[0] - p.x, c[1] - p.y] : [0, 0]; }

  /** Every search position of the box is valid image in the centre map. */
  _covered(z, box) {
    for (let p = 0; p < box.inside.length; p++) {
      if (box.inside[p] && !z.valid[(box.w0 + ((p / box.nu) | 0)) * z.w + box.u0 + (p % box.nu)]) return false;
    }
    return true;
  }

  /** Predicted ball centre for slot s at rec, stabilized px. */
  _centre(rec, s) { return rec.plan.centres[s]; }

  /** Residual, matched filter and z map for slot s of rec; cached once its backgrounds are final. */
  _z(rec, s, force = false) {
    if (rec.z[s]) return rec.z[s];
    const { kind, bgs, final, outrun } = this._backgrounds(rec);
    if (!final && !force) return null;
    const g = rec.plan.g, sl = rec.slots[s], n = sl.w * sl.h, res = new Float32Array(n), ok = new Uint8Array(n);
    const [cx, cy] = this._centre(rec, s), [cu, cw] = affApply(sl.A, cx, cy), core = g.gate / 2 / sl.pool + 0.5;
    const temporal = kind !== 'spatial' && bgs.length > 0;
    let coreMask = null;
    if (temporal) {
      // Background crops are warped onto this crop's grid by the camera and the local refinement.
      const acc = new Float32Array(n), cnt = new Uint8Array(n), tmp = new Float32Array(n), tv = new Uint8Array(n);
      coreMask = this._coreMask(rec, s, bgs, core);
      for (const b of bgs) {
        const bs = b.slots[s];
        warp(bs.data, bs.w, bs.h, bs.valid, this._registered(rec, b, s, coreMask), sl.w, sl.h, tmp, tv);
        for (let i = 0; i < n; i++) if (tv[i]) { acc[i] += tmp[i]; cnt[i]++; }
      }
      let si = 0, sb = 0;
      for (let i = 0; i < n; i++) {
        if (!sl.valid[i] || cnt[i] !== bgs.length) continue;
        acc[i] /= bgs.length; ok[i] = 1;
        if (!coreMask[i]) { si += sl.data[i]; sb += acc[i]; }
      }
      const gain = sb > 0 ? clamp(si / sb, 0.5, 2) : 1;   // per-ROI exposure match
      for (let i = 0; i < n; i++) if (ok[i]) res[i] = sl.data[i] - gain * acc[i];
    } else {
      // Slow ball (L > bgLagMax), a lone frame, or a ball that outran its background crops: spatial background,
      // Gaussian σ = 4r + 2 px (box-approximated for an outrun frame, whose wide early-flight σ was the hot spot).
      const bgImg = blurNormalized(sl.data, sl.valid, sl.w, sl.h, g.spatialSigma / sl.pool, new Float32Array(n), !!outrun);
      for (let i = 0; i < n; i++) if (sl.valid[i]) { ok[i] = 1; res[i] = sl.data[i] - bgImg[i]; }
    }
    // Matched filter; z by the tiled, outlier-robust RMS outside the predicted ball disc (_noise). RMS rather than
    // MAD: codec skip blocks repeat pixels exactly, the MAD then measures the repeats, not the noise of coded blocks.
    const mf = blur(res, sl.w, sl.h, g.sigmaMf / sl.pool, new Float32Array(n));
    // Floor: 8-bit rounding noise of the residual through the filter.
    const qv = temporal ? (1 + 1 / bgs.length) / 12 : 1 / 12, floor = Math.sqrt(qv * gaussKernel(g.sigmaMf / sl.pool).gain2);
    const nz = this._noise(mf, ok, sl.w, sl.h, cu, cw, core, floor, coreMask);
    if (!nz) return null;
    const { mean, sigma } = nz;
    if (!nz.st) for (let p = 0; p < n; p++) mf[p] = ok[p] ? (mf[p] - mean) / sigma : 0;
    else {
      // Local noise where a tile was an outlier: σ interpolated bilinearly between tile centres, so a golfer's
      // residual reads as noise there while the sky keeps the shared scale.
      const { st, nx, ny, T } = nz, w = sl.w, cx0 = new Int32Array(w), cx1 = new Int32Array(w), fx = new Float32Array(w);
      for (let i = 0; i < w; i++) { const u = clamp((i + 0.5) / T - 0.5, 0, nx - 1), a = Math.floor(u); cx0[i] = a; cx1[i] = Math.min(nx - 1, a + 1); fx[i] = u - a; }
      for (let j = 0; j < sl.h; j++) {
        const v = clamp((j + 0.5) / T - 0.5, 0, ny - 1), b0 = Math.floor(v), b1 = Math.min(ny - 1, b0 + 1), fy = v - b0, r0 = b0 * nx, r1 = b1 * nx;
        for (let i = 0, p = j * w; i < w; i++, p++) {
          if (!ok[p]) { mf[p] = 0; continue; }
          const s0 = st[r0 + cx0[i]] + (st[r0 + cx1[i]] - st[r0 + cx0[i]]) * fx[i], s1 = st[r1 + cx0[i]] + (st[r1 + cx1[i]] - st[r1 + cx0[i]]) * fx[i];
          mf[p] = (mf[p] - mean) / (s0 + (s1 - s0) * fy);
        }
      }
    }
    const z = { z: mf, valid: ok, w: sl.w, h: sl.h, sigma, outlierTiles: nz.outliers, outrun: !!outrun, mode: temporal ? 'temporal' : 'spatial', L: temporal ? g.L : 0, res };
    if (final) rec.z[s] = z;
    return z;
  }

  /**
   * Robust noise scale of a matched-filter map (gap 3: the golfer or club inside an early-flight crop inflated a
   * whole-crop RMS 15-25×). Over the valid pixels outside the ball core, per tile of roi.noise.tilePx map px:
   * count, Σ, Σ². A tile is an outlier when its mean square exceeds roi.noise.outlierRatio × the median mean
   * square of the live tiles (enough samples, above the 8-bit floor); the median ignores codec skip tiles, which
   * read 0, and the test ignores the ball's discs in the background frames (ghost: their ¼-amplitude copies are not
   * clutter); a very bright ball well off the predicted centre can flag its own tile (z −10-20%, still detected).
   * The shared RMS uses every pixel of the other tiles, skip tiles and ghosts included, as the plain RMS
   * did (dropping pixels near the search region from it raises false alarms); outlier tiles get their own RMS (st,
   * a tile σ field; null without outliers). Returns {mean, sigma, st, nx, ny, T, outliers} or null.
   */
  _noise(mf, ok, w, h, cu, cw, core, floor, ghost = null) {
    const N = this.params.roi.noise, T = Math.max(4, N.tilePx), nx = Math.ceil(w / T), ny = Math.ceil(h / T), nt = nx * ny;
    const cnt = new Float64Array(nt), s1 = new Float64Array(nt), s2 = new Float64Array(nt), c2 = core * core;
    const cg = ghost ? new Float64Array(nt) : cnt, s2g = ghost ? new Float64Array(nt) : s2;
    let k = 0;
    for (let j = 0; j < h; j++) {
      const tr = Math.floor(j / T) * nx, dj = (j - cw) * (j - cw);
      for (let i = 0, p = j * w; i < w; i++, p++) {
        if (!ok[p] || (i - cu) * (i - cu) + dj <= c2) continue;
        const t = tr + Math.floor(i / T), v = mf[p];
        cnt[t]++; s1[t] += v; s2[t] += v * v; k++;
        if (ghost && !ghost[p]) { cg[t]++; s2g[t] += v * v; }
      }
    }
    if (k < 8) {   // the core covers the map: every valid pixel, one scale
      let K = 0, S1 = 0, S2 = 0;
      for (let p = 0; p < w * h; p++) if (ok[p]) { K++; S1 += mf[p]; S2 += mf[p] * mf[p]; }
      if (!K) return null;
      const mean = S1 / K;
      return { mean, sigma: Math.max(Math.sqrt(Math.max(0, S2 / K - mean * mean)), floor), st: null, outliers: 0 };
    }
    const minN = Math.max(8, T * T / 4), live = [];
    for (let t = 0; t < nt; t++) if (cg[t] >= minN && s2g[t] / cg[t] > floor * floor) live.push(s2g[t] / cg[t]);
    let out = null, nOut = 0;
    if (live.length >= N.minLiveTiles) {
      live.sort((a, b) => a - b);
      const lim = N.outlierRatio * live[live.length >> 1];
      for (let t = 0; t < nt; t++) if (cg[t] >= minN && s2g[t] / cg[t] > lim) { (out ??= new Uint8Array(nt))[t] = 1; nOut++; }
    }
    let K = 0, S1 = 0, S2 = 0;
    for (let t = 0; t < nt; t++) if (!out || !out[t]) { K += cnt[t]; S1 += s1[t]; S2 += s2[t]; }
    if (K < 8) { out = null; nOut = 0; K = k; S1 = 0; S2 = 0; for (let t = 0; t < nt; t++) { S1 += s1[t]; S2 += s2[t]; } }
    const mean = S1 / K, sigma = Math.max(Math.sqrt(Math.max(0, S2 / K - mean * mean)), floor);
    if (!out) return { mean, sigma, st: null, outliers: 0 };
    const st = new Float32Array(nt).fill(sigma);
    for (let t = 0; t < nt; t++) if (out[t]) st[t] = Math.max(sigma, Math.sqrt(Math.max(0, s2[t] / cnt[t] - mean * mean)));
    return { mean, sigma, st, nx, ny, T, outliers: nOut };
  }

  /** Mask on slot s of rec: the predicted ball disc at rec and at its background frames, and invalid pixels. */
  _coreMask(rec, s, bgs, core) {
    const sl = rec.slots[s], mask = new Uint8Array(sl.w * sl.h);
    for (const [x, y] of [this._centre(rec, s), ...bgs.map(b => this._centre(b, s))]) {
      const [u, w] = affApply(sl.A, x, y);
      for (let j = Math.max(0, Math.floor(w - core)); j <= Math.min(sl.h - 1, Math.ceil(w + core)); j++) {
        for (let i = Math.max(0, Math.floor(u - core)); i <= Math.min(sl.w - 1, Math.ceil(u + core)); i++) {
          if ((i - u) ** 2 + (j - w) ** 2 <= core * core) mask[j * sl.w + i] = 1;
        }
      }
    }
    for (let i = 0; i < mask.length; i++) if (!sl.valid[i]) mask[i] = 1;
    return mask;
  }

  /**
   * Mapping of background frame b onto slot s of rec: the camera similarity plus a local refinement estimated
   * on the main ROI once per frame pair (camera error is smooth over decoyOffsetH·h) and applied to every slot
   * as a stabilized-px shift.
   */
  _registered(rec, b, s, coreMask) {
    const A0 = affCompose(b.slots[s].A, affInv(rec.slots[s].A));
    let d = rec.reg.get(b.index);
    if (!d) {
      const sl = rec.slots[0], bs = b.slots[0], M0 = affCompose(bs.A, affInv(sl.A));
      const mask = s === 0 ? coreMask : this._coreMask(rec, 0, [b], rec.plan.g.gate / 2 / sl.pool + 0.5);
      const M = this._register(sl, bs, M0, mask);
      const du = M.cx - M0.cx, dw = M.cy - M0.cy, Bi = affInv(bs.A);   // background index shift -> stabilized px
      d = [Bi.ax * du + Bi.bx * dw, Bi.ay * du + Bi.by * dw];
      rec.reg.set(b.index, d);
    }
    const A = b.slots[s].A;
    return { ...A0, cx: A0.cx + A.ax * d[0] + A.bx * d[1], cy: A0.cy + A.ay * d[0] + A.by * d[1] };
  }

  /**
   * Lucas-Kanade translation of the background (A0: this crop's index -> background index), ball discs and
   * invalid pixels masked, with a Gaussian prior of scale roi.registerPx (textureless sky stays at the camera
   * estimate), clamped to ±registerPx (D3 §4.1).
   */
  _register(sl, bs, A0, mask) {
    const w = sl.w, h = sl.h, lim = this.params.roi.registerPx / sl.pool, tmp = new Float32Array(w * h), tv = new Uint8Array(w * h);
    let du = 0, dw = 0;
    const st = w * h > LK_FULL_PX ? 2 : 1;   // every other row and column on large maps
    for (let it = 0; it < LK_ITERS; it++) {
      warp(bs.data, bs.w, bs.h, bs.valid, affShift(A0, du, dw), w, h, tmp, tv);
      let si = 0, sb = 0, n = 0;
      for (let y = 1; y < h - 1; y += st) for (let x = 1, i = y * w + 1; x < w - 1; x += st, i += st) {
        if (mask[i] || !(tv[i] & tv[i - 1] & tv[i + 1] & tv[i - w] & tv[i + w])) continue;
        si += sl.data[i]; sb += tmp[i]; n++;
      }
      if (n < 16) return A0;
      const gain = sb > 0 ? si / sb : 1;
      let gxx = 0, gxy = 0, gyy = 0, bx = 0, by = 0, rr = 0;
      for (let y = 1; y < h - 1; y += st) for (let x = 1, i = y * w + 1; x < w - 1; x += st, i += st) {
        if (mask[i] || !(tv[i] & tv[i - 1] & tv[i + 1] & tv[i - w] & tv[i + w])) continue;
        const gx = gain * (tmp[i + 1] - tmp[i - 1]) / 2, gy = gain * (tmp[i + w] - tmp[i - w]) / 2, r = sl.data[i] - gain * tmp[i];
        gxx += gx * gx; gxy += gx * gy; gyy += gy * gy; bx += gx * r; by += gy * r; rr += r * r;
      }
      const lam = rr / n / (lim * lim), a = gxx + lam, d = gyy + lam, det = a * d - gxy * gxy;
      if (!(det > 0)) break;
      const su = (d * bx - gxy * by) / det, sw = (a * by - gxy * bx) / det;
      du = clamp(du + su, -lim, lim); dw = clamp(dw + sw, -lim, lim);
      if (Math.abs(su) < 0.01 && Math.abs(sw) < 0.01) break;
    }
    return affShift(A0, du, dw);
  }

  /** Acceptance checks beyond S ≥ T; returns the failed check's name or null. */
  _check(rec, pred, win, pk, gridN, spacing, buf) {
    const R = this.params.roi, g = rec.plan.g, sgn = pk.pol, c = win.c, n = win.views.length, zmin = R.minPeakZ;
    // Centre frame: z ≥ minPeakZ (D3 §4.2(5)), relaxed to "within 2·minPeakZ of the window mean" for faint
    // tracks, whose single frames hover near 2σ (and stutter on codec skip blocks): an occluded centre frame of
    // a bright track is still rejected. Window: the median frame at least half the mean (or within minPeakZ/2 of
    // it, for faint tracks), so an object that crosses the path and lights up a few frames of the window cannot
    // carry the score, while a bright ball's frame-to-frame swings and codec dropouts can.
    pathSamples(win, pk.u, pk.w, pk.vx, pk.vy, buf);
    const zs = Array.from(buf.subarray(0, n), v => sgn * v).sort((a, b) => a - b), mean = zs.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? zs[n >> 1] : (zs[n / 2 - 1] + zs[n / 2]) / 2;
    if (!(sgn * buf[c] >= Math.min(zmin, mean - 2 * zmin))) return 'peak_z';
    if (!(median >= Math.min(mean - zmin / 2, mean / 2))) return 'window';
    // Velocity: no track near the peak with a velocity outside the predicted grid (+ one spacing) may beat it by
    // minPeakZ (an airplane crossing the path). The scan reaches h/(J·m) px/frame, beyond which a crossing track
    // leaves the ROI, on a (2·VEL_STEPS + 1)² grid, and positions within the response radius of the peak.
    const inner = ((gridN - 1) / 2 + 1) * spacing, dv = Math.max(2 * inner, g.h / (g.J * g.m)) / VEL_STEPS, wide = [];
    for (let i = -VEL_STEPS; i <= VEL_STEPS; i++) for (let j = -VEL_STEPS; j <= VEL_STEPS; j++) {
      if (Math.abs(j * dv) > inner || Math.abs(i * dv) > inner) wide.push(pred.vx + j * dv, pred.vy + i * dv);
    }
    const sIn = sgn * pathScore(win, pk.u, pk.w, pk.vx, pk.vy, buf), pool = rec.slots[0].pool;
    const rv = Math.ceil(SQRT2 * g.sigmaMf / pool) + 1, nv = 2 * rv + 1, vb = { u0: Math.round(pk.u) - rv, w0: Math.round(pk.w) - rv, nu: nv, nw: nv };
    const SW = new Float32Array((wide.length >> 1) * nv * nv), wn = sgn / Math.sqrt(n);
    tbdBox(win, vb, Float64Array.from(wide), SW);
    for (let i = 0; i < SW.length; i++) if (wn * SW[i] > sIn + zmin) return 'velocity';
    // Size (D3 §4.2(5)): across the path (motion blur stretches a ball along it), the response of an object as
    // wide as the gate is still at half its peak at (gate + FWHM_mf)/2 from it (arcs of ±RING_DEG on both sides).
    const V = win.views[c], Vi = affInv(V.A), [px, py] = affApply(Vi, pk.u, pk.w), rg = (g.gate + FWHM * g.sigmaMf) / 2, sp = Math.hypot(pk.vx, pk.vy);
    const ang0 = sp > EPS ? Math.atan2(pk.vx, -pk.vy) : 0;   // ⟂ to the velocity
    let ring = 0, na = 0;
    for (const side of [0, Math.PI]) for (let a = -RING; a <= RING; a++) {
      const th = ang0 + side + a * RING_DEG * Math.PI / 180 / Math.max(1, RING), [u, w] = affApply(V.A, px + rg * Math.cos(th), py + rg * Math.sin(th));
      ring += sgn * pathScore(win, u, w, pk.vx, pk.vy, buf); na++;
    }
    if (ring / na > SIZE_RATIO * sIn) return 'size';
    // Ghost: the background frames leave ¼-amplitude, opposite-sign copies of a ball at its position in those
    // frames; a candidate that is one has a ball of the other polarity at least twice as strong behind it.
    if (win.z.mode === 'temporal') {
      for (const b of this._backgrounds(rec).bgs) {
        const dt = b.index - rec.index, [u, w] = affApply(V.A, px - pk.vx * dt - 0.5 * (pred.ax || 0) * dt * dt, py - pk.vy * dt - 0.5 * (pred.ay || 0) * dt * dt);
        if (-sgn * pathScore(win, u, w, pk.vx, pk.vy, buf) >= GHOST_RATIO * sIn) return 'ghost';
      }
    }
    return null;
  }

  /** Observation of an accepted peak: stabilized position, covariance from the peak curvature and SNR. */
  _observation(rec, win, pk, bg) {
    const g = rec.plan.g, sl = rec.slots[0], V = win.views[win.c], Ai = affInv(sl.A), [x, y] = affApply(Ai, pk.u, pk.w);
    // Position information ≈ S·(−Hessian of S) in index px, mapped to stabilized px.
    let cxx, cxy, cyy;
    const H = pk.hess;
    if (H && H.ok) {
      const s = Math.max(pk.score, 1e-3), a = -H.hxx * s, b = -H.hxy * s, d = -H.hyy * s, det = a * d - b * b;
      const ixx = d / det, ixy = -b / det, iyy = a / det, m11 = Ai.ax, m12 = Ai.bx, m21 = Ai.ay, m22 = Ai.by;
      cxx = m11 * m11 * ixx + 2 * m11 * m12 * ixy + m12 * m12 * iyy;
      cxy = m11 * m21 * ixx + (m11 * m22 + m12 * m21) * ixy + m12 * m22 * iyy;
      cyy = m21 * m21 * ixx + 2 * m21 * m22 * ixy + m22 * m22 * iyy;
    } else {
      const s = SQRT2 * g.sigmaMf / Math.max(pk.score, 1e-3);
      cxx = cyy = s * s; cxy = 0;
    }
    const f2 = SIGMA_FLOOR_PX * SIGMA_FLOOR_PX;
    cxx = Math.max(cxx, f2); cyy = Math.max(cyy, f2);
    this._bgRef[pk.pol] = bg;
    return makeObservation({
      index: rec.index, t: rec.t, x, y, sigma: Math.sqrt(lamMax([cxx, cxy, cyy])), cov: [cxx, cxy, cyy], z: pk.score,
      z1: pk.pol * bilinear(V.data, V.w, V.h, pk.u, pk.w), polarity: pk.pol, src: 'tbd', flag: 'inlier',
      // U5 uses sizes only while the radius is at least fit.minRadiusPx (log-radius observations)
      d: rec.plan.pred.d >= 2 * this.params.fit.minRadiusPx ? this._diameter(rec, pk, win.acc) : null
    });
  }

  /**
   * Disc-equivalent diameter 4σ from second moments of the window-stacked crop around the path minus the
   * median of a surrounding ring; null unless its log error is within fit.logRadiusSigma, and null when it fills
   * more than DIAMETER_MAX_GATE of the gate: an evenly bright gate gives 4σ = the gate whatever the ball's size (a
   * floodlit ball's glow on a night range read 0.8 gate, 2.5x the ball, from the first frame of TBD on).
   */
  _diameter(rec, pk, acc = [0, 0]) {
    const g = rec.plan.g, rad = g.gate / 2, pool = rec.slots[0].pool, sgn = pk.pol, ring = Math.ceil(2 * rad / pool) + 1, N = 2 * ring + 1;
    const stack = new Float64Array(N * N), cnt = new Uint16Array(N * N), [sx, sy] = affApply(affInv(rec.slots[0].A), pk.u, pk.w);
    for (let j = -g.J; j <= g.J; j++) {
      const r = this._atStep(rec.step + j);
      if (!r) continue;
      const sl = r.slots[0], dt = r.index - rec.index, f = pool / sl.pool;
      const [u, w] = affApply(sl.A, sx + pk.vx * dt + 0.5 * (acc[0] || 0) * dt * dt, sy + pk.vy * dt + 0.5 * (acc[1] || 0) * dt * dt);
      for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
        const uu = u + (a - ring) * f, ww = w + (b - ring) * f;
        if (uu < 0 || ww < 0 || uu > sl.w - 1 || ww > sl.h - 1) continue;
        stack[b * N + a] += bilinear(sl.data, sl.w, sl.h, uu, ww); cnt[b * N + a]++;
      }
    }
    const outer = [], inner = [];
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const i = b * N + a;
      if (!cnt[i]) continue;
      const v = stack[i] / cnt[i], dx = (a - ring) * pool, dy = (b - ring) * pool;
      (Math.hypot(dx, dy) <= rad ? inner : outer).push([v, dx, dy]);
    }
    if (outer.length < 8 || inner.length < 4) return null;
    const st = robustStats(Float32Array.from(outer, o => o[0]), outer.length);
    let F = 0, X = 0, Y = 0;
    for (const [v, dx, dy] of inner) { const q = sgn * (v - st.med); F += q; X += q * dx; Y += q * dy; }
    if (!(F > 0)) return null;
    const mx = X / F, my = Y / F;
    let M = 0, r2 = 0, r4 = 0;
    for (const [v, dx, dy] of inner) { const q = (dx - mx) ** 2 + (dy - my) ** 2; M += sgn * (v - st.med) * q; r2 += q; r4 += q * q; }
    if (!(M > 0)) return null;
    const lnVar = st.sigma * st.sigma * (r4 / (M * M) + inner.length / (F * F) - 2 * r2 / (M * F));
    if (!(lnVar >= 0) || 0.5 * Math.sqrt(lnVar) > this.params.fit.logRadiusSigma) return null;
    const d = 4 * Math.sqrt(M / (2 * F));
    return d <= DIAMETER_MAX_GATE * g.gate ? d : null;
  }

  /** Cached z map of the main ROI around the prediction: stabilized grid, Int8 at roi.zmapScale per z. */
  _zmap(rec, z, pred, coasting) {
    const R = this.params.roi, sl = rec.slots[0], half = coasting ? R.zmapHalfCoast : R.zmapHalf, sim = rec.sim, pool = sl.pool;
    const [cu, cw] = affApply(sl.A, pred.x, pred.y), q = v => clamp(Math.round(R.zmapScale * v), -127, 127);
    if (Math.abs(sim.a - 1) < 1e-9 && Math.abs(sim.b) < 1e-9) {
      // Translation only: the crop grid is a stabilized grid with a fractional origin.
      const u0 = clamp(Math.round(cu) - half, 0, sl.w - 1), u1 = clamp(Math.round(cu) + half, 0, sl.w - 1);
      const w0 = clamp(Math.round(cw) - half, 0, sl.h - 1), w1 = clamp(Math.round(cw) + half, 0, sl.h - 1);
      const w = u1 - u0 + 1, h = w1 - w0 + 1, data = new Int8Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = q(z.z[(w0 + j) * sl.w + u0 + i]);
      return { index: rec.index, t: rec.t, x0: sl.x0 + pool * u0 - sim.tx, y0: sl.y0 + pool * w0 - sim.ty, pool, w, h, data, zScale: R.zmapScale };
    }
    // Rotation or scale: resample onto an axis-aligned stabilized grid.
    const n = 2 * half + 1, x0 = pred.x - pool * (half + 0.5), y0 = pred.y - pool * (half + 0.5), data = new Int8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const [u, w] = affApply(sl.A, x0 + pool * (i + 0.5), y0 + pool * (j + 0.5));
      data[j * n + i] = q(bilinear(z.z, sl.w, sl.h, u, w));
    }
    return { index: rec.index, t: rec.t, x0, y0, pool, w: n, h: n, data, zScale: R.zmapScale };
  }
}
