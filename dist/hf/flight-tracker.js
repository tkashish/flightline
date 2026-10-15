/**
 * hf flight tracker (U6). One FlightTracker per accepted launch drives an injected RoiTube (U4) along
 * physics-predicted ROIs and keeps up to track.maxBranches MHT branches:
 *   - prediction: the launch law s = v(τ+δ)/(1+c(τ+δ)) plus an image acceleration for the first
 *     track.launchProfileObs inliers, then Kalman-style: the warm fitFlight (U5) supplies the dynamics and a residual
 *     line through the latest inliers the state; refit every track.refitEveryObs inliers, after track.refitChi2Count
 *     innovations with χ² > track.refitChi2, and at the start of every gap (local quadratic without a fit);
 *   - association: χ² gate track.gateChi2 on the residual shrunk by the ball radius, distractor labels (coarse-scan
 *     movers, static spots, lens specks, the club track, self-observed static persistence, learned steal tracks),
 *     occlusion masks from the energy store; a distractor or poor fit as the tube's best widens the search to the
 *     other z-map maxima in the gate;
 *   - MHT: a second admissible peak within track.spawnRatio, or a flux jump (missed-detection hypothesis), spawns a
 *     child unless another branch already follows that object; siblings resolve after track.resolveFrames frames by
 *     evidence, duplicates merge, pruneBranches keeps reserved per-launch quotas;
 *   - probation (physics-residual test, FINAL): after any gap or an innovation beyond track.refitChi2, detections are
 *     judged against the frozen pre-gap prediction by the same-sign trend (track.trend, D2) and a residual drift test,
 *     need track.reacquire (3 of 5) density, and commit only if a joint refit with the committed track keeps them
 *     without a trend; so a steal is refused even after track.planeMissFrames misses. After track.lost misses the
 *     re-acquisition also needs the null threshold + roi.reacquireExtraZ;
 *   - frame exit when the prediction ±track.exitSigmas·σ leaves the frame, with re-entry from the fit; landing
 *     tail, search expiry, slow-apex stride;
 *   - finish(): trailing fit rejects (walked forward against refits), D1 change-point trim.
 * reassociate() is D2's Viterbi over the cached z-maps after a refit. Positions are stabilized native px.
 */
import { PARAMS } from './params.js';
import { frameAt, stabToRaw, identityTrack, makeTrackHypothesis, HFError } from './types.js';
import { swingEscape } from './decide.js';

/** Model constants that are not PARAMS keys yet (integrator: move them into params.track when tuning). */
export const TRACKER_MODEL = Object.freeze({
  procAccD: 0.15,      // law/quad predictors: unmodelled acceleration 1σ, × expected diameter per frame² (D3 §4.1)
  floorPx: 0.5,        // prediction 1σ floor (px)
  maskActive: 0.5,     // energy active fraction that marks a predicted position as occluded
  maskRadiusD: 2,      // energy mask disk radius (expected diameters)
  llrCap: 10,          // cap of one observation's evidence above the null threshold (z)
  peaks: 6,            // z-map local maxima kept per frame (D2 §4.3)
  moverExtrapSec: 3,   // known movers are extrapolated this long past their last sighting (D1 §4.3)
  moverGrowth: 0.05,   // ... with the tolerance growing by this × |v| per frame (D1 §4.3)
  cpRefineSigmas: 3,   // change-point refine keeps points within this many σ of the head extrapolation (D1 §4.3)
  cpGapPx: 0.5,        // ... plus this per missed frame (D1 §4.3)
  cpRefPx: 1280,       // D1's change-point px are analysis px of a 1280 long edge; scaled to native px
  lawIters: 8,         // Gauss-Newton iterations of the launch-law predictor
  pdInit: 0.8,         // initial detection-probability estimate
  pdRate: 0.2          // detection-probability EMA rate
});

/* ------------------------------------------------------------------ small math */

const sq = v => v * v;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isoCov = s2 => [s2, 0, s2];
const addCov = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lmax = m => (m[0] + m[2]) / 2 + Math.sqrt(sq((m[0] - m[2]) / 2) + sq(m[1]));
const obsCov = o => (o.cov?.length === 3 ? o.cov : isoCov(sq(o.sigma > 0 ? o.sigma : TRACKER_MODEL.floorPx)));
const unit = (x, y) => { const n = Math.hypot(x, y); return n > 1e-9 ? [x / n, y / n] : [1, 0]; };
const median = a => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const isInlier = o => (o.flag ?? 'inlier') === 'inlier';
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Mahalanobis χ² of (dx, dy) under the 2×2 covariance [sxx, sxy, syy]. */
export function chi2(dx, dy, m) {
  const d = m[0] * m[2] - m[1] * m[1];
  return d > 1e-12 ? (m[2] * dx * dx - 2 * m[1] * dx * dy + m[0] * dy * dy) / d : Infinity;
}

function solveN(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) { const t = M[c]; M[c] = M[p]; M[p] = t; }
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const invertN = A => { const cols = A.map((_, j) => solveN(A, A.map((__, i) => (i === j ? 1 : 0)))); return A.map((_, i) => cols.map(c => c[i])); };

/** Damped Gauss-Newton on whitened residuals res(θ); returns {theta, cov = (JᵀJ)⁻¹}. */
function gaussNewton(theta0, res, iters) {
  const jac = th => {
    const r0 = res(th);
    return th.map((v, j) => { const h = 1e-6 * Math.max(1, Math.abs(v)), t = [...th]; t[j] += h; const r1 = res(t); return r1.map((x, i) => (x - r0[i]) / h); });
  };
  const normal = J => J.map(a => J.map(b => dot(a, b)));
  let th = [...theta0], r = res(th), cost = dot(r, r), lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = jac(th), A = normal(J), g = J.map(col => dot(col, r));
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const d = solveN(A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v))), g.map(v => -v));
      const t = th.map((v, j) => v + d[j]), rt = res(t), ct = dot(rt, rt);
      if (ct < cost) { const gain = cost - ct; th = t; r = rt; cost = ct; lambda = Math.max(1e-7, lambda * 0.3); ok = true; if (gain < 1e-9 * (1 + cost)) it = iters; }
      else lambda *= 10;
    }
    if (!ok) break;
  }
  return { theta: th, cov: invertN(normal(jac(th))) };
}

/* ------------------------------------------------------------------ predictors (τ in frames after t0) */

/**
 * Launch law (D1 §3.5, D3 §4.1) with an image acceleration and a t0 offset δ (U3's t0 is good to about a frame):
 * p = A + u(ang)·v(τ+δ)/(1+c(τ+δ)) + ½·a·τ². θ = [ang, v, c, ax, ay, δ].
 */
function lawPos(th, A, tau) {
  const q = tau + th[5], s = th[1] * q / Math.max(0.05, 1 + th[2] * q);
  return [A.x + Math.cos(th[0]) * s + 0.5 * th[3] * tau * tau, A.y + Math.sin(th[0]) * s + 0.5 * th[4] * tau * tau];
}

function lawFit(launch, pts, prev) {
  const n = pts.length, sa = n >= 4 ? Math.max(0.5, 0.5 * launch.d0) : 1e-3;
  const mu = [Math.atan2(launch.dir.y, launch.dir.x), launch.v, launch.c, 0, 0, 0];
  const sig = [0.15, 0.3 * launch.v + 1, 0.05 + Math.abs(launch.c), sa, sa, n >= 2 ? 0.5 : 1e-3];
  const res = th => {
    const out = [];
    for (const p of pts) { const [x, y] = lawPos(th, launch.address, p.tau), s = Math.sqrt(p.s2); out.push((p.x - x) / s, (p.y - y) / s); }
    for (let j = 0; j < mu.length; j++) out.push((th[j] - mu[j]) / sig[j]);
    return out;
  };
  const g = gaussNewton(prev?.length === mu.length ? prev : mu, res, TRACKER_MODEL.lawIters);
  // Misfit inflates the covariance: data χ² per degree of freedom beyond 1.
  const r = res(g.theta).slice(0, 2 * n), scale = n >= 3 ? Math.max(1, dot(r, r) / Math.max(1, 2 * n - 3)) : 1;
  return { theta: g.theta, cov: g.cov.map(row => row.map(v => v * scale)) };
}

/** J·C·Jᵀ for J = d f(θ)/dθ (f: θ -> [x, y], forward differences) as [sxx, sxy, syy]. */
function propagate(f, theta, C) {
  const p = theta.length, [x, y] = f(theta), J = theta.map((v, j) => {
    const h = 1e-6 * Math.max(1, Math.abs(v)), t = [...theta]; t[j] += h;
    const [x1, y1] = f(t); return [(x1 - x) / h, (y1 - y) / h];
  });
  let sxx = 0, sxy = 0, syy = 0;
  for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) {
    const c = C[a][b];
    sxx += J[a][0] * J[b][0] * c; sxy += J[a][0] * J[b][1] * c; syy += J[a][1] * J[b][1] * c;
  }
  return [sxx, sxy, syy];
}

/** Law position, velocity (px/frame) and acceleration (px/frame²) at τ, with the position and velocity covariances. */
function lawPredict(law, A, tau) {
  const th = law.theta, at = q => lawPos(th, A, q), [x, y] = at(tau);
  const [xa, ya] = at(tau - 0.5), [xb, yb] = at(tau + 0.5), [x0, y0] = at(tau - 1), [x1, y1] = at(tau + 1);
  const vel = t => { const a = lawPos(t, A, tau - 0.5), b = lawPos(t, A, tau + 0.5); return [b[0] - a[0], b[1] - a[1]]; };
  return { x, y, cov: propagate(t => lawPos(t, A, tau), th, law.cov), vx: xb - xa, vy: yb - ya, ax: x1 - 2 * x + x0, ay: y1 - 2 * y + y0, covV: propagate(vel, th, law.cov) };
}

/**
 * Physical envelope of the law's coasting uncertainty (gap 1): the covariance of the second-order kinematic
 * extrapolation from the last inlier, p(τl) + v(τl)·h + ½·a(τl)·h², i.e. the position, velocity and acceleration
 * uncertainty AT THE LAST INLIER carried forward. The full law extrapolates its perspective decay c, whose poorly
 * pinned asymptote v/c makes the covariance explode within a few frames of a miss.
 */
function lawTaylorCov(law, A, tl, h, velocity = false) {
  return propagate(t => {
    const [x, y] = lawPos(t, A, tl), [xa, ya] = lawPos(t, A, tl - 0.5), [xb, yb] = lawPos(t, A, tl + 0.5), [x0, y0] = lawPos(t, A, tl - 1), [x1, y1] = lawPos(t, A, tl + 1);
    if (velocity) return [xb - xa + (x1 - 2 * x + x0) * h, yb - ya + (y1 - 2 * y + y0) * h];   // v(τl) + a(τl)·h
    return [x + (xb - xa) * h + 0.5 * (x1 - 2 * x + x0) * h * h, y + (yb - ya) * h + 0.5 * (y1 - 2 * y + y0) * h * h];
  }, law.theta, law.cov);
}

/** Weighted per-axis quadratic over recent inliers (D1 §4.3 constant-acceleration fallback). */
function quadFit(pts) {
  const t1 = pts.at(-1).tau, A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (const p of pts) {
    const u = p.tau - t1, w = 1 / p.s2, f = [1, u, u * u];
    for (let a = 0; a < 3; a++) { bx[a] += w * f[a] * p.x; by[a] += w * f[a] * p.y; for (let b = 0; b < 3; b++) A[a][b] += w * f[a] * f[b]; }
  }
  if (pts.length < 4) A[2][2] += 1e4;
  if (pts.length < 2) A[1][1] += 1e4;
  const C = invertN(A), qx = C.map(r => dot(r, bx)), qy = C.map(r => dot(r, by));
  let chi = 0;
  for (const p of pts) { const u = p.tau - t1; chi += (sq(p.x - (qx[0] + qx[1] * u + qx[2] * u * u)) + sq(p.y - (qy[0] + qy[1] * u + qy[2] * u * u))) / p.s2; }
  return { t1, qx, qy, C, scale: pts.length > 3 ? Math.max(1, chi / (2 * pts.length - 6)) : 1 };
}

function quadPredict(q, tau) {
  const u = tau - q.t1, f = [1, u, u * u], v = Math.max(0, dot(f, q.C.map(r => dot(r, f)))) * q.scale, g = [0, 1, 2 * u];
  const vv = Math.max(0, dot(g, q.C.map(r => dot(r, g)))) * q.scale;
  return { x: dot(q.qx, f), y: dot(q.qy, f), cov: isoCov(v), vx: q.qx[1] + 2 * q.qx[2] * u, vy: q.qy[1] + 2 * q.qy[2] * u, ax: 2 * q.qx[2], ay: 2 * q.qy[2], covV: isoCov(vv) };
}

/* ------------------------------------------------------------------ exported pure helpers */

/**
 * Physics-residual steal test (D2 §4.6 plus a drift test). items: [{r:[dx, dy], S:[sxx, sxy, syy], dir:[ux, uy],
 * k?, sv?}] in time order: residuals of observations against a FROZEN physics prediction, their covariance, the
 * predicted motion direction, the frame index k and the predictor's own velocity σ sv (px/frame). In the along- or
 * cross-track component it fires when
 *   - a trailing run of >= minRun same-signed residuals has |mean| > sigmas·mean(σ)/√run (D2), or
 *   - with >= minObs items, the weighted residual slope over k exceeds drift·SE (default sigmas + 1), SE² = 1/Σw(k − k̄)² + sv²
 *     (a steal that crosses the predicted path drifts through zero, which a same-sign run cannot see).
 */
export function trendFires(items, { minObs, sigmas }, minRun = minObs, drift = sigmas + 1) {
  const n = items.length;
  if (n < Math.max(2, minRun)) return false;
  const [ux, uy] = items[0].dir ?? [1, 0];
  for (const [cx, cy] of [[ux, uy], [-uy, ux]]) {
    const v = items.map(it => it.r[0] * cx + it.r[1] * cy);
    const s = items.map(it => Math.sqrt(Math.max(1e-12, cx * cx * it.S[0] + 2 * cx * cy * it.S[1] + cy * cy * it.S[2])));
    let run = 0, sum = 0, ssum = 0, sign = 0;
    for (let i = n - 1; i >= 0; i--) {
      const sg = Math.sign(v[i]);
      if (!sg || (sign && sg !== sign)) break;
      sign = sg; run++; sum += v[i]; ssum += s[i];
    }
    if (run >= minRun && Math.abs(sum / run) > sigmas * (ssum / run) / Math.sqrt(run)) return true;
    if (n < minObs) continue;
    let W = 0, K = 0, V = 0;
    items.forEach((it, i) => { const w = 1 / sq(s[i]), k = it.k ?? i; W += w; K += w * k; V += w * v[i]; });
    const kb = K / W, vb = V / W;
    let Skk = 0, Skv = 0;
    items.forEach((it, i) => { const w = 1 / sq(s[i]), dk = (it.k ?? i) - kb; Skk += w * dk * dk; Skv += w * dk * (v[i] - vb); });
    if (!(Skk > 0)) continue;
    const sv = Math.max(...items.map(it => it.sv ?? 0)), se = Math.sqrt(1 / Skk + sv * sv);
    if (Math.abs(Skv / Skk) > drift * se) return true;
  }
  return false;
}

/** Unweighted per-axis quadratic in t through pts [{t, x, y}] (D1 change point); returns t -> [x, y]. */
function quadT(pts) {
  const t0 = pts.at(-1).t, S = [0, 0, 0, 0, 0], X = [0, 0, 0], Y = [0, 0, 0];
  for (const p of pts) { const u = p.t - t0; let w = 1; for (let k = 0; k < 5; k++) { S[k] += w; if (k < 3) { X[k] += w * p.x; Y[k] += w * p.y; } w *= u; } }
  const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  if (pts.length < 3) M[2][2] += 1e6;
  const qx = solveN(M, X), qy = solveN(M, Y);
  return t => { const u = t - t0; return [qx[0] + qx[1] * u + qx[2] * u * u, qy[0] + qy[1] * u + qy[2] * u * u]; };
}
const rmsOf = (pts, f) => Math.sqrt(pts.reduce((s, p) => { const [x, y] = f(p.t); return s + sq(p.x - x) + sq(p.y - y); }, 0) / pts.length);

/**
 * D1 §4.3 change-point trim over points [{t, x, y}] sorted by t (raw positions, or residuals against a fit).
 * For j >= cp.minIndex: quadratics on the cp.before points before j and on those plus the cp.after next; a joint RMS
 * above max(cp.minPx, cp.headFactor·max(rHead, cp.base + cp.stepFrac·step)) cuts, refined by extending the head while
 * the next point stays on its extrapolation. px values scale by pxScale. Returns the cut index (pts.length = none).
 */
export function changePointCut(pts, cp, pxScale = 1) {
  const n = pts.length, minPx = cp.minPx * pxScale, base = cp.base * pxScale;
  for (let j = cp.minIndex; j + cp.after <= n; j++) {
    const head = pts.slice(Math.max(0, j - cp.before), j), both = head.concat(pts.slice(j, j + cp.after));
    const fh = quadT(head), fb = quadT(both);
    const step = Math.hypot(head.at(-1).x - head.at(-2).x, head.at(-1).y - head.at(-2).y);
    const sig = Math.max(rmsOf(head, fh), base + cp.stepFrac * step);
    if (!(rmsOf(both, fb) > Math.max(minPx, cp.headFactor * sig))) continue;
    let m = j;
    while (m < n) {
      const h = pts.slice(Math.max(0, m - cp.before), m), g = quadT(h), dtf = Math.max(1e-6, h.at(-1).t - h.at(-2).t);
      const gap = Math.max(0, (pts[m].t - h.at(-1).t) / dtf - 1), [px, py] = g(pts[m].t);
      const lim = Math.max(minPx, TRACKER_MODEL.cpRefineSigmas * Math.max(rmsOf(h, g), base + cp.stepFrac * step)) + TRACKER_MODEL.cpGapPx * pxScale * gap;
      if (Math.hypot(pts[m].x - px, pts[m].y - py) > lim) break;
      m++;
    }
    return m;
  }
  return n;
}

/**
 * Prune hypotheses with RESERVED per-launch quotas (D1 §4.3): every launch keeps its best `quota` first, then the
 * rest fill by score up to maxTotal, so a later true launch survives many established wrong ones.
 */
export function pruneBranches(branches, { maxTotal, quota, score = b => b.llr }) {
  const sorted = [...branches].sort((a, b) => score(b) - score(a)), kept = [], rest = [], per = new Map();
  for (const b of sorted) {
    const n = per.get(b.launchId) ?? 0;
    if (n < quota) { per.set(b.launchId, n + 1); kept.push(b); } else rest.push(b);
  }
  for (const b of rest) { if (kept.length >= maxTotal) break; kept.push(b); }
  return kept.sort((a, b) => score(b) - score(a));
}

/**
 * Local maxima of a cached z-map (signed by polarity; 0 = either) with z >= zMin, sub-pixel by parabolas, as
 * stabilized px: map pixel (i, j) has its centre at (x0 + pool·(i + 0.5), y0 + pool·(j + 0.5)). Best first.
 */
export function zmapPeaks(zm, polarity, zMin, maxPeaks = TRACKER_MODEL.peaks) {
  const { w, h, data, zScale, pool } = zm, out = [], lim = zMin * zScale;
  const v = (i, j) => { const s = data[j * w + i]; return polarity > 0 ? s : polarity < 0 ? -s : Math.abs(s); };
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const c = v(i, j);
    if (c < lim) continue;
    let peak = true;
    for (let dj = -1; dj <= 1 && peak; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const q = v(i + di, j + dj);
      if (q > c || (q === c && (dj < 0 || (dj === 0 && di < 0)))) { peak = false; break; }
    }
    if (!peak) continue;
    const l = v(i - 1, j), r = v(i + 1, j), u = v(i, j - 1), d = v(i, j + 1);
    const dx = l - 2 * c + r < 0 ? clamp(0.5 * (l - r) / (l - 2 * c + r), -0.5, 0.5) : 0;
    const dy = u - 2 * c + d < 0 ? clamp(0.5 * (u - d) / (u - 2 * c + d), -0.5, 0.5) : 0;
    out.push({ x: zm.x0 + pool * (i + 0.5 + dx), y: zm.y0 + pool * (j + 0.5 + dy), z: c / zScale, polarity: data[j * w + i] >= 0 ? 1 : -1 });
  }
  return out.sort((a, b) => b.z - a.z).slice(0, maxPeaks);
}

const zmapOk = z => z && z.data instanceof Int8Array && Number.isInteger(z.w) && Number.isInteger(z.h) && z.w > 0 && z.h > 0
  && z.data.length === z.w * z.h && Number.isFinite(z.x0) && Number.isFinite(z.y0) && z.pool > 0 && z.zScale > 0 && Number.isInteger(z.index);

/* ------------------------------------------------------------------ distractor labels and masks */

/**
 * Known distractors and static evidence for one clip (D3 §4.5(5), D1 §4.3): coarse-scan movers ('preimpact' ->
 * 'mover', inadmissible; 'sky' -> 'ambiguous' unless the detection's own TBD velocity differs by > moverVelSigmas),
 * stationary spots and lens specks ('static'), the club track ('ambiguous', club-explained), learned steal tracks.
 */
class Labeler {
  constructor({ meta, log, params, launch = null }) {
    this.meta = meta; this.P = params; this.log = log;
    this.camera = log?.camera ?? identityTrack(meta);
    this.pool = log?.pool ?? 1;
    this.movers = (log?.movers ?? []).map(m => ({ ...m }));
    this.spots = log?.spots ?? [];
    this.specks = log?.specks ?? [];
    this.club = new Map((launch?.clubTrack?.points ?? []).map(p => [p.index, p]));
    this.extrap = Math.ceil(TRACKER_MODEL.moverExtrapSec * meta.fps);
    this.cells = new Map();
  }
  staticRadius(d) { return Math.max(this.P.track.staticPx * this.pool, 0.5 * d, 1); }
  /** A coarse-scan movers or learned steal track at (x, y) at frame k: its kind, else null. */
  mover(k, x, y, d, extra = [], vel = null) {
    const T = this.P.track;
    for (const m of extra.length ? this.movers.concat(extra) : this.movers) {
      if (k < m.index0) continue;
      const past = Math.max(0, k - m.index1);
      if (past > this.extrap) continue;
      const dk = k - m.index0, sp = Math.hypot(m.vx, m.vy);
      // A learned track that does not move is a static object: use the static radius, not the mover band.
      const tol = m.kind === 'learned' && sp < T.staticPx * this.pool ? Math.max(this.staticRadius(d), 0.5 * m.d)
        : T.moverD * Math.max(d, m.d) + TRACKER_MODEL.moverGrowth * sp * past;
      if (Math.hypot(x - (m.x + m.vx * dk), y - (m.y + m.vy * dk)) > tol) continue;
      if (m.kind === 'sky' && vel && Math.hypot(vel.vx - m.vx, vel.vy - m.vy) > T.moverVelSigmas * this.P.roi.tbd.spacing) continue;
      return m.kind === 'sky' ? 'ambiguous' : 'mover';
    }
    return null;
  }
  /** Stationary spot present at k, or a lens-fixed speck, at (x, y). */
  fixed(k, x, y, d) {
    const r = this.staticRadius(d);
    for (const s of this.spots) if (k >= s.firstIndex && k <= s.lastIndex && Math.hypot(x - s.x, y - s.y) <= Math.max(r, 0.5 * s.d)) return true;
    if (this.specks.length) {
      const raw = stabToRaw(this.camera, k, x, y);
      for (const s of this.specks) if (Math.hypot(raw.x - s.x, raw.y - s.y) <= s.r + 0.5 * d) return true;
    }
    return false;
  }
  clubAt(k, x, y, d) { const p = this.club.get(k); return !!p && Math.hypot(x - p.x, y - p.y) <= Math.max(p.extent, 0.5 * d); }
  /** Register a detection position for self-observed static persistence. */
  note(k, x, y) {
    const key = `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
    let a = this.cells.get(key);
    if (!a) this.cells.set(key, (a = []));
    a.push({ k, x, y });
  }
  /**
   * Self-observed persistence (D1 §4.3): detections at (x, y) in >= track.staticHits other frames within
   * ±track.staticWindowFrames (earlier frames only unless `future`) while the predicted ball moved > 2 radii.
   */
  persistent(k, x, y, d, predAt, future = false) {
    const T = this.P.track, r = this.staticRadius(d), frames = new Set(), here = predAt(k);
    for (let gx = Math.floor((x - r) / 8); gx <= Math.floor((x + r) / 8); gx++) for (let gy = Math.floor((y - r) / 8); gy <= Math.floor((y + r) / 8); gy++) {
      for (const e of this.cells.get(`${gx},${gy}`) ?? []) {
        if (e.k === k || Math.abs(e.k - k) > T.staticWindowFrames || (!future && e.k > k)) continue;
        if (Math.hypot(e.x - x, e.y - y) > r) continue;
        const p = predAt(e.k);
        if (here && p && Math.hypot(p.x - here.x, p.y - here.y) <= 2 * r) continue;
        frames.add(e.k);
      }
    }
    return frames.size >= T.staticHits;
  }
  /** Flag for a detection: 'static' | 'mover' | 'ambiguous' | 'inlier'. */
  label(k, o, d, { extra = [], predAt = null, future = false } = {}) {
    if (this.fixed(k, o.x, o.y, d)) return 'static';
    if (predAt && this.persistent(k, o.x, o.y, d, predAt, future)) return 'static';
    const vel = Number.isFinite(o.vx) && Number.isFinite(o.vy) ? { vx: o.vx, vy: o.vy } : null;
    const m = this.mover(k, o.x, o.y, d, extra, vel);
    if (m) return m;
    if (this.clubAt(k, o.x, o.y, d)) return 'ambiguous';
    return 'inlier';
  }
  /** Why a predicted position cannot be observed at k (misses there do not count), or null. */
  mask(k, pred, extra = []) {
    const E = this.log?.energy;
    if (typeof E?.active === 'function') {
      try { if (E.active(k, pred.x, pred.y, Math.max(TRACKER_MODEL.maskRadiusD * pred.d, E.cellPx ?? 0)) >= TRACKER_MODEL.maskActive) return 'occluded'; } catch { /* no energy */ }
    }
    if (this.mover(k, pred.x, pred.y, pred.d, extra)) return 'mover';
    if (this.fixed(k, pred.x, pred.y, pred.d)) return 'static';
    return null;
  }
}

/** Constant-velocity line through points [{index, x, y, d}] (a learned steal track for the mover mask). */
function lineTrack(pts, id) {
  const n = pts.length, mi = pts.reduce((s, p) => s + p.index, 0) / n, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sii = 0, six = 0, siy = 0;
  for (const p of pts) { const di = p.index - mi; sii += di * di; six += di * (p.x - mx); siy += di * (p.y - my); }
  const vx = sii > 0 ? six / sii : 0, vy = sii > 0 ? siy / sii : 0, i0 = pts[0].index;
  return { id, kind: 'learned', index0: i0, index1: pts.at(-1).index, x: mx + vx * (i0 - mi), y: my + vy * (i0 - mi), vx, vy, d: Math.max(1, median(pts.map(p => p.d ?? 1))) };
}

/* ------------------------------------------------------------------ the tracker */

const LIVE = new Set(['active', 'search']);
const TERMINAL = new Set(['lost', 'exited', 'ended']);
const OUT_STATE = { active: 'active', search: 'lost', wait: 'exited', lost: 'lost', exited: 'exited', ended: 'ended' };

export class FlightTracker {
  /**
   * @param {import('./types.js').LaunchCandidate} launch
   * @param {import('./types.js').TrackerContext} ctx {meta, log, impact, params}
   * @param {import('./types.js').TrackerDeps} deps {RoiTube, fitFlight}
   */
  constructor(launch, ctx, deps = {}) {
    if (!launch || !ctx?.meta) throw new HFError('bad-arg', 'FlightTracker needs a launch and a TrackerContext');
    if (typeof deps.RoiTube !== 'function') throw new HFError('bad-arg', 'FlightTracker needs deps.RoiTube');
    const meta = ctx.meta, P = ctx.params ?? PARAMS;
    this.launch = launch; this.meta = meta; this.log = ctx.log ?? null; this.impact = ctx.impact ?? null; this.P = P;
    this.deps = deps; this.ctx = ctx; this.times = meta.times; this.fps = meta.fps; this.t0 = launch.t0;
    this.k0 = frameAt(this.times, this.t0);
    this.win = { from: Math.max(0, frameAt(this.times, this.t0 - P.pipeline.flightPreSec)), to: meta.frameCount };
    this.camera = this.log?.camera ?? identityTrack(meta);
    const tp = this.impact?.tauPrior;
    this.tauPrior = tp ? tp.modes[tp.weights.indexOf(Math.max(...tp.weights))] : 1;
    this.fitCtx = { meta, launch, horizon: this.log?.horizon ?? null, tauPrior: tp ?? { modes: [1], weights: [1] }, params: P };
    this.tube = new deps.RoiTube({ meta, camera: this.camera, params: P, polarity: launch.polarity, specks: this.log?.specks ?? [] });
    this.labels = new Labeler({ meta, log: this.log, params: P, launch });
    this.pxScale = Math.max(1, Math.max(meta.width, meta.height) / TRACKER_MODEL.cpRefPx);
    // Coasting ends once the prediction's 1σ major axis passes this frame-relative cap (gap 1).
    this.sigmaCap = P.track.coastMaxSigmaDiag * Math.hypot(meta.width, meta.height);
    this.plans = new Map(); this.pending = []; this.nextPlan = this.win.from; this.stride = 1; this.seq = 0; this.idle = false;
    this._done = false; this.hyps = null;
    this.stats = { detectCalls: 0, refits: 0, spawned: 0, merged: 0, resolved: 0, planned: 0 };
    this.headIndex = Math.max(-1, ...launch.samples.map(o => o.index));   // the launch chain's last sample (step)
    const root = this.newBranch();
    for (const o of launch.samples) this.record(root, { ...o, flag: o.flag ?? 'inlier' }, Math.min(Math.max(o.z ?? 0, 0), TRACKER_MODEL.llrCap));
    root.llr = root.inc.reduce((s, v) => s + v, 0);
    this.updatePredictor(root);
    this.branches = [root];
  }

  window() { return { ...this.win }; }
  get done() { return this._done; }

  newBranch() {
    return {
      id: `${this.launch.id}/b${this.seq++}`, launchId: this.launch.id, parentId: null, spawnIndex: -1,
      obs: [], inc: [], zmaps: [], state: 'active', misses: 0, since: 0, maskedSince: 0, llr: 0, pd: TRACKER_MODEL.pdInit,
      planned: 0, hits: 0, mode: 'law', law: null, quad: null, fit: null, lastFitN: 0, chi2Count: 0, reentry: false,
      resid: null, probation: null, distractors: [], predHist: new Map(), junctions: [],
      polarity: this.launch.polarity, lastInl: null, nInl: 0, searchUntil: Infinity, waitUntil: -1,
      exitIndex: null, exitT: null, exitPlanned: null, capPlanned: null, endIndex: null, endWhy: null,
      lostEvents: 0, reentries: 0, reacquired: 0, probRejects: 0, spawns: 0, flags: { static: 0, mover: 0, ambiguous: 0, rejected: 0 }
    };
  }

  clone(b, k) {
    const c = { ...b, id: `${this.launch.id}/b${this.seq++}`, parentId: b.id, spawnIndex: k };
    c.obs = [...b.obs]; c.inc = [...b.inc]; c.zmaps = [...b.zmaps]; c.distractors = [...b.distractors];
    c.predHist = new Map(b.predHist); c.junctions = [...b.junctions]; c.flags = { ...b.flags };
    c.probation = b.probation ? { ...b.probation, pts: [...b.probation.pts] } : null;
    b.spawns++; c.spawns = b.spawns;
    return c;
  }

  tauOf(b) { return b?.fit?.tau ?? this.tauPrior; }
  lostN(b) { const L = this.P.track.lost; return Math.max(L.frames, Math.ceil(L.realSec * this.tauOf(b) * this.fps / this.stride - 1e-9)); }
  searchSpan(b, t) { const S = this.P.track.search; return Math.max(S.realSec * this.tauOf(b), S.flightFrac * (t - this.t0)); }

  /**
   * Where the ball should be at frame k for branch b (stabilized px, px/frame, px²), plus the Prediction extras U4
   * uses: the acceleration ax, ay (px/frame²), the VELOCITY σ svel (px/frame: the model's own, plus the unmodelled
   * acceleration over the frames missed since the last inlier; it picks U4's wide velocity grid only when it exceeds
   * a grid spacing), and driftSv (the drift test's predictor velocity σ, internal).
   * Coasting σ is inflated physically (gap 1): beyond the last inlier, the law's growth is bounded by its Taylor
   * envelope at that inlier (lawTaylorCov), the fit's by the process bound, both plus the unmodelled acceleration
   * ½·procAccD·d·h² (and κ·h·|v| for the fit); the tracker ends a branch whose σ passes the frame-relative cap.
   */
  predict(b, k) {
    const t = this.times[k], tau = (t - this.t0) * this.fps, L = this.launch, P = this.P;
    const h = b.lastInl ? Math.max(0, k - b.lastInl.index) : Math.max(1, tau);
    let p, d, vv;
    if (b.mode === 'fit' && b.fit) {
      // Kalman-style: the fit supplies the dynamics, a residual line through the latest inliers the state (D3 §4.1).
      const dt = 1 / this.fps, f = b.fit.predict(t), fa = b.fit.predict(t - 0.5 * dt), fb = b.fit.predict(t + 0.5 * dt);
      const R = b.resid, u = R ? (t - R.t1) * this.fps : 0, vx = fb.x - fa.x + (R?.bx ?? 0), vy = fb.y - fa.y + (R?.by ?? 0);
      const fc = f.cov?.length === 3 ? f.cov : [0, 0, 0], fl = R?.cov1 ?? fc;
      const dd = Math.max(f.d ?? L.d0, 1), proc = 0.5 * TRACKER_MODEL.procAccD * dd * h * h;
      const growth = Math.min(Math.max(0, lmax(fc) - lmax(fl)), sq(proc));
      const vr = R ? Math.max(0, R.C[0][0] + 2 * u * R.C[0][1] + u * u * R.C[1][1]) : 0;
      const infl = vr + growth + sq(P.complete.kappa * h * Math.hypot(vx, vy)) + sq(TRACKER_MODEL.floorPx);
      // acceleration from the half-frame samples: (f(t+½) − 2f(t) + f(t−½)) / ½² (exact for a local quadratic)
      p = { x: f.x + (R ? R.ax + R.bx * u : 0), y: f.y + (R ? R.ay + R.by * u : 0), vx, vy, ax: 4 * (fb.x - 2 * f.x + fa.x), ay: 4 * (fb.y - 2 * f.y + fa.y), cov: isoCov(infl) };
      vv = (R ? Math.max(0, R.C[1][1]) : 0) + sq(TRACKER_MODEL.procAccD * dd * Math.max(0, h - 1));
      d = f.d;
    } else {
      p = b.mode === 'quad' && b.quad ? quadPredict(b.quad, tau) : lawPredict(b.law, L.address, tau);
      if (b.mode === 'law' && b.quad) {   // law vs local quadratic disagreement: half of it counts as 1σ
        const q = quadPredict(b.quad, tau);
        p.cov = addCov(p.cov, [sq(0.5 * (p.x - q.x)), 0, sq(0.5 * (p.y - q.y))]);
      }
      if (b.mode === 'law' && b.lastInl && h > 0) {
        // Beyond the last inlier the model's growth (the law's decay extrapolation, the quadratic's disagreement)
        // is bounded by the law's own kinematic envelope from that inlier; its velocity σ likewise.
        const tl = (b.lastInl.t - this.t0) * this.fps, c0 = lawPredict(b.law, L.address, tl).cov, env = lawTaylorCov(b.law, L.address, tl, tau - tl);
        const gT = Math.max(0, lmax(env) - lmax(c0));
        if (lmax(p.cov) - lmax(c0) > gT) p.cov = addCov(c0, isoCov(gT));
        const ev = lawTaylorCov(b.law, L.address, tl, tau - tl, true);
        if (lmax(p.covV) > lmax(ev)) p.covV = ev;
      }
      const q = Math.max(0, tau + b.law.theta[5]);
      d = b.mode === 'quad' && b.lastInl?.d ? b.lastInl.d : L.d0 / Math.max(0.05, 1 + b.law.theta[2] * q);
      const dd = Math.max(d, 1), proc = 0.5 * TRACKER_MODEL.procAccD * dd * h * h;
      p.cov = addCov(p.cov, isoCov(sq(proc) + sq(TRACKER_MODEL.floorPx)));
      vv = lmax(p.covV) + sq(TRACKER_MODEL.procAccD * dd * Math.max(0, h - 1));
    }
    // A re-entry search after a frame exit is a deliberate wide search: its σ is held at the cap instead of ending it.
    const lc = lmax(p.cov);
    if (b.reentry && lc > sq(this.sigmaCap)) p.cov = p.cov.map(v => v * sq(this.sigmaCap) / lc);
    // Velocity uncertainty for the drift test: one predicted σ over the horizon (a drift that large is 1σ).
    p.driftSv = Math.sqrt(Math.max(0, lmax(p.cov))) / Math.max(1, h);
    d = Math.max(P.roi.minSizePx, Number.isFinite(d) ? d : L.d0);
    // coasting: tells U4 to cache the wide z map (after a gap, for re-association); explicit, so it does not depend
    // on which branch called detect last.
    return {
      index: k, t, x: p.x, y: p.y, vx: p.vx, vy: p.vy, cov: p.cov, d, polarity: b.polarity, ax: p.ax, ay: p.ay,
      svel: Math.sqrt(Math.max(0, vv)), driftSv: p.driftSv, coasting: b.state === 'search' || b.since > 0
    };
  }

  /**
   * The Prediction handed to the tube: the contract fields plus the extras agreed with U4 (gap 5): ax, ay; sv = the
   * velocity σ (U4 widens its velocity grid only above one grid spacing); coasting; nullKey/nullFrom, so each branch
   * keeps its own decoy-null history (a child starts from its parent's); extra (e.g. probe).
   */
  tubePred(b, p, extra = null) {
    const q = { index: p.index, t: p.t, x: p.x, y: p.y, vx: p.vx, vy: p.vy, cov: p.cov, d: p.d, polarity: p.polarity };
    if (Number.isFinite(p.ax) && Number.isFinite(p.ay)) { q.ax = p.ax; q.ay = p.ay; }
    if (Number.isFinite(p.svel)) q.sv = p.svel;
    if (p.coasting != null) q.coasting = p.coasting;
    if (b) { q.nullKey = b.id; q.nullFrom = b.parentId; }
    return extra ? Object.assign(q, extra) : q;
  }

  /** 1σ major axis (px) beyond which a branch stops coasting (track.coastMaxSigmaDiag of the frame diagonal). */
  overCap(pred) { return Math.sqrt(Math.max(0, lmax(pred.cov))) > this.sigmaCap; }

  /**
   * Pre-impact frames: cover the address and the start of the launch law (its first J+1 frames, at most what one
   * crop holds), so the tube has background there; σ bounded by the crop and the coasting cap. background: they
   * never join a TBD window (U4 then never computes their z maps; the ball sits at the address there).
   */
  prePred(i) {
    const L = this.launch, hs = this.P.roi.halfSize, tauE = this.P.roi.tbd.J + 1;
    const s = Math.min(L.v * tauE / Math.max(0.05, 1 + L.c * tauE), 2 * Math.max(hs.minPx, hs.maxPx - L.d0));
    const e = { x: L.address.x + L.dir.x * s, y: L.address.y + L.dir.y * s }, half = s / 2 + L.d0;
    return {
      index: i, t: this.times[i], x: (L.address.x + e.x) / 2, y: (L.address.y + e.y) / 2, vx: 0, vy: 0,
      cov: isoCov(sq(Math.min(half / 3, this.sigmaCap))), d: L.d0, polarity: L.polarity, background: true
    };
  }

  outside(k, pred) {
    const raw = stabToRaw(this.camera, k, pred.x, pred.y), m = this.P.track.exitSigmas * Math.sqrt(Math.max(0, lmax(pred.cov))) + pred.d / 2;
    return raw.x < -m || raw.y < -m || raw.x > this.meta.width + m || raw.y > this.meta.height + m;
  }

  strideAt(i, lead) {
    const S = this.P.track.stride;
    if (!lead || i <= this.k0 || this.times[i] - this.t0 < S.fullRealSec * this.tauOf(this.branches[0])) return 1;
    return clamp(Math.floor(S.px / Math.max(1e-6, Math.hypot(lead.vx, lead.vy))), 1, S.max);
  }

  /** RoiRequests for frame i: one tube covering every live branch; [] on strided frames. */
  roiRequests(i) {
    if (this._done || i < this.win.from || i >= this.win.to || i < this.nextPlan) return [];
    for (const b of this.branches) if (b.state === 'wait' && i >= b.waitUntil) {
      b.state = 'search'; b.misses = this.lostN(b); b.searchUntil = this.times[i] + this.searchSpan(b, this.times[i]); b.reentry = true;
    }
    const preds = [];
    for (const b of this.branches) {
      if (!LIVE.has(b.state) || b.capPlanned != null) continue;
      const pred = i <= this.k0 ? this.prePred(i) : this.predict(b, i);
      // Inside the launch chain (impact .. its last sample) the chain's own points stand (step skips those frames), so a
      // launch-law prediction there only places background crops: its σ (the law's first-frame speed is ~ a frame
      // height per frame) is held at the cap instead of ending the branch before it starts.
      if (i > this.k0 && i <= this.headIndex) this.holdAtCap(pred);
      // Too uncertain to place an ROI: the branch ends once the frames before this one are detected (capBranch).
      else if (i > this.k0 && this.overCap(pred)) { b.capPlanned = i; continue; }
      if (i > this.k0 && this.outside(i, pred)) { if (b.exitPlanned == null) b.exitPlanned = i; continue; }
      b.exitPlanned = null;
      preds.push(i <= this.k0 ? pred : this.tubePred(b, pred));
    }
    // Idle: no live branch can be planned, so the crops the pending detections wait for will never come.
    this.idle = !preds.length;
    if (!preds.length) return [];
    let reqs = [];
    try { reqs = this.tube.plan(i, unionPred(preds)) ?? []; } catch { reqs = []; }
    if (!reqs.length) { this.idle = true; return []; }
    this.plans.set(i, true);
    this.stats.planned++;
    this.stride = this.strideAt(i, preds[0]);
    this.nextPlan = i + this.stride;
    return reqs;
  }

  /** Called for every index of the window, in order; crops answer this frame's roiRequests. */
  consume(i, t, crops, sim) {
    if (this._done) return;
    if (this.plans.get(i) && crops?.length) {
      let ok = true;
      try { this.tube.push(i, t, crops, sim); } catch { ok = false; }
      if (ok && i > this.k0) this.pending.push(i);
    }
    this.plans.delete(i);
    // At the window end, or when nothing is planned any more (every branch left the frame or passed the σ cap), the
    // pending detections run with the crops that are in instead of waiting forever for crops that never come.
    const flush = i >= this.win.to - 1 || (this.idle && !this.plans.size);
    while (this.pending.length && (flush || this.ready(this.pending[0]))) this.step(this.pending.shift());
    this.housekeep(i);
  }

  ready(k) { try { return !!this.tube.ready(k); } catch { return true; } }

  /** Scale a prediction's position covariance down to the σ cap (in place). */
  holdAtCap(p) { const lc = lmax(p.cov); if (lc > sq(this.sigmaCap)) p.cov = p.cov.map(v => v * sq(this.sigmaCap) / lc); }

  /** Detection step at frame k (crops up to k + J + L are in): per live branch detect, label, gate, spawn, update. */
  step(k) {
    const T = this.P.track, spawned = [], asks = [];
    for (const b of this.branches.filter(x => LIVE.has(x.state))) {
      if (b.exitPlanned != null && k >= b.exitPlanned) continue;
      if (b.capPlanned != null && k >= b.capPlanned) continue;
      const pred = this.predict(b, k);
      if (k > this.k0 && k <= this.headIndex) this.holdAtCap(pred);
      else if (k > this.k0 && this.overCap(pred)) { this.capBranch(b, k); continue; }
      b.predHist.set(k, pred);
      let det = null;
      try { det = this.tube.detect(k, this.tubePred(b, pred)); this.stats.detectCalls++; } catch { det = null; }
      if (zmapOk(det?.zmap)) b.zmaps.push(det.zmap);
      // The launch chain stands for every frame up to its last sample: its points, the frames between t0 and its first
      // sample and its gaps (U3 judged them: the ball hidden by or merged with the club). Nothing there is a gap after
      // the branch's head, so a miss must not send the first detections after the chain into probation (E5 follow-up:
      // one empty frame before the chain made every early point a probation that a fast exit then rejected);
      // reassociate fills these frames from the cached z-maps.
      if (k <= this.headIndex) continue;
      const cands = this.candidates(b, k, pred, det, asks.length < T.maxSpawnPerFrame && b.state === 'active');
      const ok = cands.filter(c => c.gated && c.flag === 'inlier');
      if (!ok.length) this.miss(b, k, pred, cands.find(c => c.gated) ?? null);
      else {
        // MHT: an ambiguous second peak, or a flux jump that may be another object on the prediction (missed-
        // detection hypothesis), asks for a child cloned before this hit; children are added after every branch
        // took its frame, so a hypothesis another branch already follows is never spawned twice.
        if (ok[1] && ok[0].S / Math.max(1e-9, ok[1].S) < T.spawnRatio) asks.push({ child: this.clone(b, k), pred, c: ok[1] });
        else if (this.fluxJump(b, ok[0])) asks.push({ child: this.clone(b, k), pred, c: null });
        this.hit(b, k, pred, ok[0]);
      }
      this.transitions(b, k, pred);
    }
    for (const a of asks) {
      if (spawned.length >= T.maxSpawnPerFrame || this.branches.length + spawned.length >= 2 * T.maxBranches) break;
      const sep = Math.max(1.5 * a.pred.d, 3);
      if (a.c && [...this.branches, ...spawned].some(o => claims(o, k, a.c.o, sep))) continue;
      if (a.c) this.hit(a.child, k, a.pred, a.c); else this.miss(a.child, k, a.pred, null);
      this.transitions(a.child, k, a.pred);
      spawned.push(a.child); this.stats.spawned++;
    }
    this.branches.push(...spawned);
    this.resolve(k);
  }

  /** Appearance trend (D3 §4.5(3)): evidence jumping above spawnRatio² × the median of the last 5 tube inliers. */
  fluxJump(b, c) {
    const zs = [];
    for (let i = b.obs.length - 1; i >= 0 && zs.length < 5; i--) { const o = b.obs[i]; if (isInlier(o) && o.src !== 'launch' && o.src !== 'streak') zs.push(o.z); }
    return zs.length >= 3 && c.S > sq(this.P.track.spawnRatio) * median(zs);
  }

  /** Candidate detections for branch b at frame k: the tube's best plus one confirmed secondary z-map peak. */
  candidates(b, k, pred, det, second) {
    const out = [], T = this.P.track, extra = this.P.roi.reacquireExtraZ, rad = 0.5 * pred.d;
    const gateCov = addCov(pred.cov, isoCov(sq(rad)));
    const predAt = j => b.predHist.get(j) ?? null;
    const add = (o, S, Tn) => {
      if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
      const z = Number.isFinite(S) ? S : (o.z ?? 0), thr = Number.isFinite(Tn) ? Tn : 0;
      // Innovation χ² (decisions) and the gate χ² on the residual shrunk by the ball radius (D2 §4.2 margin).
      const dx = o.x - pred.x, dy = o.y - pred.y, r = Math.hypot(dx, dy), shrink = r > rad ? 1 - rad / r : 0, Sc = addCov(pred.cov, obsCov(o));
      const c2 = chi2(dx, dy, Sc), cg = chi2(dx * shrink, dy * shrink, Sc);
      const big = o.d != null && o.d > this.P.roi.maxSizeD * Math.max(pred.d, this.P.roi.minSizePx);
      const strong = z >= thr + (b.state === 'search' ? extra : 0);
      this.labels.note(k, o.x, o.y);
      const obs = {
        index: k, t: this.times[k], x: o.x, y: o.y, sigma: o.sigma > 0 ? o.sigma : TRACKER_MODEL.floorPx, z,
        z1: o.z1 ?? null, d: o.d ?? null, polarity: o.polarity ?? (b.polarity || 1), src: o.src ?? 'tbd', flag: 'inlier'
      };
      if (o.cov?.length === 3) obs.cov = o.cov;
      out.push({ o: obs, S: z, T: thr, chi2: c2, gated: cg <= T.gateChi2 && !big && strong,
        flag: this.labels.label(k, obs, pred.d, { extra: b.distractors, predAt }),
        gain: Math.min(z - thr, TRACKER_MODEL.llrCap) + 1 - 0.5 * c2 });
    };
    const prim = det?.observation;
    if (prim) add(prim, prim.z ?? det.score, det.threshold);
    // Other z-map maxima inside the gate, each confirmed by a tight detect: a possible MHT child when the primary is
    // a good fit, or a replacement when the tube's best was a distractor, outside this branch's gate, or a jump
    // beyond refitChi2 (a dimmer peak may sit on the prediction).
    const wide = !!b.probation || b.state === 'search' || !(out.length > 0 && out[0].gated && out[0].flag === 'inlier' && out[0].chi2 <= T.refitChi2 && !this.fluxJump(b, out[0]));
    if (prim && zmapOk(det.zmap) && (second || wide)) {
      const sep = Math.max(1.5 * pred.d, 3), want = wide ? 2 : 1;
      const zMin = wide ? this.P.roi.minPeakZ : Math.max(this.P.roi.minPeakZ, Math.abs(prim.z1 ?? prim.z ?? det.score) / T.spawnRatio);
      let found = 0;
      for (const p of zmapPeaks(det.zmap, b.polarity, zMin)) {
        if (found >= want) break;
        if (out.some(c => Math.hypot(p.x - c.o.x, p.y - c.o.y) < sep) || chi2(p.x - pred.x, p.y - pred.y, gateCov) > T.gateChi2) continue;
        let d2 = null;
        try { d2 = this.tube.detect(k, this.tubePred(b, { ...pred, x: p.x, y: p.y, cov: isoCov(sq(Math.max(1, rad))) }, { probe: true })); this.stats.detectCalls++; } catch { d2 = null; }
        const o2 = d2?.observation;
        if (!o2 || Math.hypot(o2.x - p.x, o2.y - p.y) > sep || out.some(c => Math.hypot(o2.x - c.o.x, o2.y - c.o.y) < sep)) continue;
        add(o2, o2.z ?? d2.score, d2.threshold);
        found++;
      }
    }
    return out.sort((p, q) => q.gain - p.gain);
  }

  hit(b, k, pred, c) {
    b.planned++; b.hits++; b.pd += TRACKER_MODEL.pdRate * (1 - b.pd);
    if (c.chi2 > this.P.track.refitChi2) b.chi2Count++;
    // After a gap, or on an innovation beyond refitChi2, detections are judged against the frozen prediction first.
    if (b.probation || b.state === 'search' || b.since > 0 || c.chi2 > this.P.track.refitChi2) { this.probationHit(b, pred, c); return; }
    this.commit(b, [{ o: c.o, inc: c.gain }]);
  }

  miss(b, k, pred, flagged) {
    b.planned++; b.since++;
    // A gap starts: refit on every pre-gap inlier so the frozen gap predictor is current (D3 §4.1 warm refit).
    if (b.since === 1 && b.mode === 'fit' && this.deps.fitFlight && b.nInl - b.lastFitN >= 3) {
      const fit = this.runFit(b.obs, b.fit);
      if (fit) { b.fit = fit; b.lastFitN = b.nInl; b.chi2Count = 0; b.resid = this.residLine(fit, b.obs.filter(isInlier).slice(-6)); }
    }
    if (flagged) { this.record(b, { ...flagged.o, flag: flagged.flag }, 0); b.flags[flagged.flag] = (b.flags[flagged.flag] ?? 0) + 1; }
    if (flagged || this.labels.mask(k, pred, b.distractors)) { b.maskedSince++; return; }
    b.misses++;
    b.pd += TRACKER_MODEL.pdRate * (0 - b.pd);
    b.llr -= -Math.log(1 - clamp(b.pd, this.P.track.minPd, 0.95));
    if (b.probation) { b.probation.planned++; this.evalProbation(b); }
  }

  /** Tentative detections after a gap, judged against the frozen pre-gap prediction. */
  probationHit(b, pred, c) {
    const pr = b.probation ?? (b.probation = { kind: b.state === 'search' ? 'reacq' : 'gap', planned: 0, pts: [], dir: unit(pred.vx, pred.vy) });
    pr.planned++;
    pr.pts.push({ o: c.o, inc: c.gain, chi2: c.chi2, r: [c.o.x - pred.x, c.o.y - pred.y], S: addCov(pred.cov, obsCov(c.o)), dir: pr.dir, k: c.o.index, sv: pred.driftSv ?? 0 });
    this.evalProbation(b);
  }

  /**
   * Joint physics test (FINAL physics-residual test): refit on the committed inliers plus the probation points. The
   * segment belongs to the same ball when the robust joint fit keeps at least track.reacquire[0] of its points and
   * shows no residual trend on them at the strict drift bound (outliers among them are dropped); a plane or bird
   * segment cannot share one ballistic path with the ball. Returns {fit, keep, drop, obs}, false (reject), or null
   * (cannot judge).
   */
  jointOk(b, pts) {
    const T = this.P.track;
    if (!this.deps.fitFlight || b.nInl < T.launchProfileObs || pts.length < T.reacquire[0]) return null;
    const obs = [...b.obs.filter(isInlier), ...pts.map(p => ({ ...p.o, flag: 'inlier' }))].sort((a, c) => a.index - c.index);
    const fit = this.runFit(obs, b.fit);
    if (!fit) return null;
    const at = new Map(obs.map((o, i) => [o.index, i])), aligned = fit.inlier?.length === obs.length;
    const keep = pts.filter(p => !aligned || fit.inlier[at.get(p.o.index)]), drop = pts.filter(p => !keep.includes(p));
    if (keep.length < T.reacquire[0]) return false;
    const items = keep.map(p => { const q = fit.predict(p.o.t); return { r: [p.o.x - q.x, p.o.y - q.y], S: addCov(q.cov?.length === 3 ? q.cov : [0, 0, 0], obsCov(p.o)), dir: p.dir, k: p.o.index }; });
    const m = Math.min(keep.length, T.trend.minObs);
    return trendFires(items, { ...T.trend, minObs: m }, m, T.trend.sigmas) ? false : { fit, keep, drop, obs };
  }

  evalProbation(b) {
    const pr = b.probation, T = this.P.track, [need, of] = T.reacquire, n = pr.pts.length;
    const commitN = Math.max(T.trend.minObs + 1, pr.kind === 'reacq' ? need : 1);   // one past the run, so a crossing junction point cannot hide a trend
    if (pr.planned >= of && n < need) return this.rejectProbation(b, false);   // 3 of 5 after any gap (FINAL, D3 F17)
    if (trendFires(pr.pts, T.trend)) {
      // The frozen prediction disagrees with the segment. Either the predictor is biased (contaminated or stale) and
      // the segment shares the committed track's ballistic path (joint fit), or the newest point is an intruder, or
      // the segment is another object.
      const lastPt = pr.pts.at(-1), rest = pr.pts.slice(0, -1), all = this.jointOk(b, pr.pts);
      if (all) return n >= commitN ? this.commitProbation(b, all) : undefined;
      const restJ = rest.length ? this.jointOk(b, rest) : false;
      if (n > 1 && (restJ || (lastPt.chi2 > T.refitChi2 && rest.every(p => p.chi2 <= T.refitChi2) && !trendFires(rest, T.trend, Math.min(rest.length, T.trend.minObs))))) {
        pr.pts.pop();
        this.record(b, { ...lastPt.o, flag: 'rejected' }, 0); b.flags.rejected++; b.misses++;
        return;
      }
      // The newest point may be the ball re-emerging next to the distractor: keep it as a fresh probation.
      if (n > 1 && lastPt.chi2 <= T.refitChi2) {
        pr.pts.pop();
        this.rejectProbation(b, restJ === false);
        b.probation = { ...pr, planned: 1, pts: [lastPt] };
        return;
      }
      return this.rejectProbation(b, all === false);
    }
    if (n >= commitN) {
      const j = this.jointOk(b, pr.pts);
      return j === false ? this.rejectProbation(b, false) : this.commitProbation(b, j);
    }
    if (pr.planned >= 3 * commitN) return this.endProbation(b);
  }

  /**
   * Resolve a probation that cannot run to commitN: it needs track.reacquire[0] points (single false alarms never
   * extend a trace, D3 F17), no trend at that length, and every point within refitChi2 of the frozen prediction.
   */
  endProbation(b) {
    const pr = b.probation, T = this.P.track;
    if (!pr) return;
    // A short probation is about to become track: hold it to the stricter drift bound (trend.sigmas).
    const m = Math.min(pr.pts.length, T.trend.minObs);
    if (trendFires(pr.pts, { ...T.trend, minObs: m }, m, T.trend.sigmas)) return this.rejectProbation(b, false);
    const ok = pr.pts.length >= T.reacquire[0] && pr.pts.every(p => p.chi2 <= T.refitChi2);
    const j = ok ? this.jointOk(b, pr.pts) : false;
    return ok && j !== false ? this.commitProbation(b, j) : this.rejectProbation(b, false);
  }

  /** Commit a probation; a joint fit that accepted it re-anchors the predictor and drops its outliers. */
  commitProbation(b, joint = null) {
    const pr = b.probation, keep = joint ? joint.keep : pr.pts;
    b.probation = null;
    if (pr.kind === 'reacq') { b.state = 'active'; b.reacquired++; b.exitIndex = null; b.exitT = null; b.reentry = false; }
    for (const p of joint?.drop ?? []) { this.record(b, { ...p.o, flag: 'rejected' }, 0); b.flags.rejected++; }
    // The accepted joint fit also repairs contamination: committed points it rejects are flagged (evidence removed).
    // joint is null when jointOk could not judge (too few committed inliers, or no fit): nothing to repair then.
    if (joint && joint.fit?.inlier?.length === joint.obs.length) {
      const bad = new Set(joint.obs.filter((o, i) => !joint.fit.inlier[i] && !pr.pts.some(p => p.o.index === o.index)).map(o => o.index));
      for (let i = 0; i < b.obs.length; i++) if (bad.has(b.obs[i].index) && isInlier(b.obs[i]) && b.obs[i].src !== 'launch') {
        b.llr -= b.inc[i]; b.inc[i] = 0; b.obs[i] = { ...b.obs[i], flag: 'rejected' }; b.flags.rejected++;
      }
    }
    if (keep.length) b.junctions.push(keep[0].o.index);
    if (joint) { b.fit = joint.fit; b.mode = 'fit'; b.chi2Count = 0; b.lastFitN = b.nInl + keep.length; }
    this.commit(b, keep.map(p => ({ o: p.o, inc: p.inc })));
  }

  rejectProbation(b, learn) {
    const pr = b.probation;
    b.probation = null; b.probRejects++;
    for (const p of pr.pts) { this.record(b, { ...p.o, flag: 'rejected' }, 0); b.flags.rejected++; }
    b.misses += pr.pts.length;
    // Learn the steal as a distractor track only when the joint fit refused it (or no fit exists) and the rejected
    // points are one coherent constant-velocity object; a ball segment rejected by a biased predictor is never learned.
    if (learn && pr.pts.length >= 3) {
      const line = lineTrack(pr.pts.map(p => p.o), `${b.id}/steal${b.probRejects}`);
      const rms = Math.sqrt(pr.pts.reduce((s2, p) => s2 + sq(p.o.x - line.x - line.vx * (p.o.index - line.index0)) + sq(p.o.y - line.y - line.vy * (p.o.index - line.index0)), 0) / pr.pts.length);
      if (rms <= Math.max(1.5, 0.5 * line.d)) b.distractors.push(line);
    }
  }

  commit(b, items) {
    for (const { o, inc } of items) { this.record(b, { ...o, flag: 'inlier' }, inc); b.llr += inc; }
    b.misses = 0; b.since = 0; b.maskedSince = 0;
    this.updatePredictor(b);
  }

  /** Insert an observation, one per frame: an inlier wins over a flagged one. */
  record(b, o, inc) {
    let i = b.obs.length;
    while (i > 0 && b.obs[i - 1].index > o.index) i--;
    if (i > 0 && b.obs[i - 1].index === o.index) {
      if (isInlier(b.obs[i - 1]) && !isInlier(o)) return;
      b.obs[i - 1] = o; b.inc[i - 1] = inc;
      return;
    }
    b.obs.splice(i, 0, o); b.inc.splice(i, 0, inc);
  }

  updatePredictor(b) {
    const T = this.P.track, inl = b.obs.filter(isInlier), s2 = o => sq(o.sigma) + sq(TRACKER_MODEL.floorPx);
    b.lastInl = inl.at(-1) ?? null; b.nInl = inl.length;
    const pol = inl.slice(-3).reduce((s, o) => s + (o.polarity ?? 0), 0);
    if (pol) b.polarity = Math.sign(pol);
    const pts = inl.map(o => ({ tau: (o.t - this.t0) * this.fps, x: o.x, y: o.y, s2: s2(o) }));
    if (inl.length < T.launchProfileObs || !b.law) b.law = lawFit(this.launch, pts.slice(-T.launchProfileObs), b.law?.theta);
    if (inl.length < T.launchProfileObs) { b.mode = 'law'; b.quad = inl.length >= 4 ? quadFit(pts.slice(-6)) : null; return; }
    const due = b.mode !== 'fit' || inl.length - b.lastFitN >= T.refitEveryObs || b.chi2Count >= T.refitChi2Count;
    if (due && this.deps.fitFlight) {
      const fit = this.runFit(b.obs, b.fit);
      if (fit) { b.fit = fit; b.mode = 'fit'; b.lastFitN = inl.length; b.chi2Count = 0; }
    }
    if (b.mode === 'fit' && b.fit) b.resid = this.residLine(b.fit, inl.slice(-6));
    else { b.mode = 'quad'; b.quad = quadFit(pts.slice(-8)); }
  }

  /** Weighted residual line r = a + b·u (u frames after the last inlier) of recent inliers against the fit. */
  residLine(fit, pts) {
    const last = pts.at(-1), rows = pts.map(o => { const p = fit.predict(o.t); return { u: (o.t - last.t) * this.fps, rx: o.x - p.x, ry: o.y - p.y, w: 1 / (sq(o.sigma) + sq(TRACKER_MODEL.floorPx)) }; });
    let S0 = 0, S1 = 0, S2 = 0, X0 = 0, X1 = 0, Y0 = 0, Y1 = 0;
    for (const r of rows) { S0 += r.w; S1 += r.w * r.u; S2 += r.w * r.u * r.u; X0 += r.w * r.rx; X1 += r.w * r.rx * r.u; Y0 += r.w * r.ry; Y1 += r.w * r.ry * r.u; }
    if (rows.length < 3) S2 += 1e4;   // too few points for a slope: offset only
    const det = S0 * S2 - S1 * S1, C = [[S2 / det, -S1 / det], [-S1 / det, S0 / det]];
    const ax = C[0][0] * X0 + C[0][1] * X1, bx = C[1][0] * X0 + C[1][1] * X1, ay = C[0][0] * Y0 + C[0][1] * Y1, by = C[1][0] * Y0 + C[1][1] * Y1;
    let chi = 0;
    for (const r of rows) chi += r.w * (sq(r.rx - ax - bx * r.u) + sq(r.ry - ay - by * r.u));
    const scale = rows.length > 2 ? Math.max(1, chi / (2 * rows.length - 4)) : 1, f1 = fit.predict(last.t);
    return { t1: last.t, ax, bx, ay, by, C: C.map(row => row.map(v => v * scale)), cov1: f1.cov?.length === 3 ? f1.cov : [0, 0, 0] };
  }

  runFit(obs, warm) {
    try {
      const f = this.deps.fitFlight(obs, this.fitCtx, warm ? { warm } : {});
      this.stats.refits++;
      return f && typeof f.predict === 'function' ? f : null;
    } catch { return null; }
  }

  /** Exit, landing tail, cap, lost (-> search), search expiry, after frame k. */
  transitions(b, k, pred) {
    if (!LIVE.has(b.state)) return;
    const t = this.times[k], T = this.P.track, tau = this.tauOf(b);
    if (this.outside(k, pred)) return this.exitBranch(b, k);
    if (b.fit?.landingT != null && t > b.fit.landingT + T.landingTailRealSec * tau) return this.endBranch(b, k, 'landing');
    if (t > this.t0 + this.P.complete.capRealSec * tau) return this.endBranch(b, k, 'cap');
    if (b.state === 'active' && b.misses >= this.lostN(b)) {
      if (b.probation) this.endProbation(b);
      if (b.misses >= this.lostN(b)) { b.state = 'search'; b.lostEvents++; b.searchUntil = t + this.searchSpan(b, t); }
    }
    if (b.state === 'search' && t > b.searchUntil && !b.probation) { b.state = 'lost'; b.endIndex = k; }
  }

  endBranch(b, k, why) {
    if (b.probation) this.endProbation(b);
    b.state = 'ended'; b.endIndex = k; b.endWhy = why;
  }

  /**
   * The prediction at k passed the σ cap (gap 1): settle an open probation (a commit can bring the σ back), then end
   * the branch: 'exited' when the predicted position is outside the frame (exitBranch finds the crossing), else
   * 'lost'. A coast that wide can no longer place an ROI, and its gate would take anything.
   */
  capBranch(b, k) {
    b.capPlanned = null;
    if (b.probation) this.endProbation(b);
    if (!LIVE.has(b.state)) return;
    const pred = this.predict(b, k);
    if (!this.overCap(pred)) return;
    const raw = stabToRaw(this.camera, k, pred.x, pred.y);
    if (raw.x < 0 || raw.y < 0 || raw.x > this.meta.width || raw.y > this.meta.height) return this.exitBranch(b, k);
    b.state = 'lost'; b.endIndex = k; b.endWhy = 'sigma';
  }

  /** The prediction left the frame: record when it crossed the edge, then wait for a predicted re-entry or stop. */
  exitBranch(b, k) {
    if (b.probation) this.endProbation(b);
    const from = (b.lastInl?.index ?? this.k0) + 1;
    let tx = this.times[k];
    for (let j = from; j <= k; j++) {
      const p = b.predHist.get(j) ?? this.predict(b, j), raw = stabToRaw(this.camera, j, p.x, p.y);
      if (raw.x < 0 || raw.y < 0 || raw.x > this.meta.width || raw.y > this.meta.height) { tx = this.times[j]; break; }
    }
    b.exitIndex = k; b.exitT = tx; b.exitPlanned = null;
    const r = this.reentry(b, k);
    if (r != null) { b.state = 'wait'; b.waitUntil = r; b.reentries++; }
    else { b.state = 'exited'; b.endIndex = k; }
  }

  /** First frame after k where the physics fit brings the ball back inside the frame (D3 §4.4), or null. */
  reentry(b, k) {
    if (!b.fit) return null;
    const W = this.meta.width, H = this.meta.height, end = this.meta.frameCount, step = Math.max(1, this.stride);
    for (let j = k + 1, n = 0; j < end && n < 4000; j += step, n++) {
      const t = this.times[j];
      if (b.fit.landingT != null && t > b.fit.landingT) return null;
      const p = b.fit.predict(t), raw = stabToRaw(this.camera, j, p.x, p.y), m = Math.max(p.d ?? 1, 1);
      if (raw.x >= m && raw.y >= m && raw.x <= W - m && raw.y <= H - m) return j;
    }
    return null;
  }

  housekeep(i) {
    for (const b of this.branches) {
      if (LIVE.has(b.state) && b.capPlanned != null && (!this.pending.length || this.pending[0] >= b.capPlanned)) this.capBranch(b, b.capPlanned);
      if (LIVE.has(b.state) && b.exitPlanned != null && (!this.pending.length || this.pending[0] >= b.exitPlanned)) this.exitBranch(b, b.exitPlanned);
      if (b.state === 'wait' && b.waitUntil >= this.win.to) { b.state = 'exited'; b.endIndex = i; }
    }
    if (this.branches.every(b => TERMINAL.has(b.state))) this._done = true;
  }

  /** Merge duplicates, resolve siblings after track.resolveFrames frames by LLR, then cap with reserved quotas. */
  resolve(k) {
    const T = this.P.track, drop = new Set(), bs = this.branches;
    const tail = b => b.obs.filter(isInlier).slice(-2);
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], c = bs[j];
      if (drop.has(a) || drop.has(c)) continue;
      const ta = tail(a), tc = tail(c);
      const dup = ta.length === 2 && tc.length === 2 && ta.every((o, q) => o.index === tc[q].index && Math.hypot(o.x - tc[q].x, o.y - tc[q].y) < 0.5);
      // Resolution counts tentative probation evidence too, so a branch is not dropped before its points commit.
      const div = Math.max(a.spawnIndex, c.spawnIndex), la = evidence(a), lc = evidence(c);
      const ripe = div >= 0 && k - div >= T.resolveFrames && Math.abs(la - lc) >= this.P.decide.identityMarginNats;
      if (dup) { drop.add(a.llr >= c.llr ? c : a); this.stats.merged++; }
      else if (ripe) { drop.add(la >= lc ? c : a); this.stats.resolved++; }
    }
    const kept = bs.filter(b => !drop.has(b));
    this.branches = pruneBranches(kept, { maxTotal: T.maxBranches, quota: T.quotaPerLaunch });
  }

  /** Flush pending detections, run the offline tests, and return TrackHypothesis[] best first (<= track.maxBranches). */
  finish() {
    if (this.hyps) return this.hyps;
    while (this.pending.length) this.step(this.pending.shift());
    const T = this.P.track, best = Math.max(...this.branches.map(b => b.llr));
    for (const b of this.branches) {
      if (b.probation) this.endProbation(b);
      if (b.llr >= best - this.P.decide.identityMarginNats) this.offlineTests(b);
    }
    const hyps = this.branches.map(b => this.hypothesis(b)).sort((a, b) => b.llr - a.llr);
    const inl = hyps.map(h => h.observations.filter(isInlier));
    hyps.forEach((h, i) => {
      let rival = null, share = 0;
      hyps.forEach((g, j) => {
        if (j === i) return;
        const s = sharedFrac(inl[i], inl[j]);
        if (s < this.P.decide.identityShareMax && (!rival || g.llr > rival.llr)) { rival = g; share = s; }
      });
      h.features.identityMargin = rival ? h.llr - rival.llr : null;
      h.features.rivalShare = rival ? share : null;
    });
    this._done = true;
    this.hyps = hyps.slice(0, T.maxBranches);
    return this.hyps;
  }

  /** Convenience (D3's tracker.result()): best hypothesis after the fit / re-association loop. */
  result() {
    const best = this.finish()[0] ?? null;
    if (!best) return { observations: [], fit: null, endReason: 'lost', features: {}, hypothesis: null };
    let hyp = best, fit = null;
    if (this.deps.fitFlight) {
      for (let i = 0; i < this.P.track.reassocIters; i++) {
        fit = this.runFit(hyp.observations, fit) ?? fit;
        if (!fit) break;
        hyp = reassociate(hyp, fit, this.ctx, this.deps);
      }
      fit = this.runFit(hyp.observations, fit) ?? fit;
    }
    return { observations: hyp.observations, fit, endReason: hyp.observedEnd, features: hyp.features, hypothesis: hyp };
  }

  /** Flag inliers from position `from` on as rejected (a truncated steal); subtract their evidence. */
  truncate(b, inl, from, why) {
    if (from >= inl.length) return 0;
    const cut = new Set(inl.slice(from).map(o => o.index));
    for (let i = 0; i < b.obs.length; i++) if (cut.has(b.obs[i].index) && isInlier(b.obs[i])) {
      b.llr -= b.inc[i]; b.inc[i] = 0; b.obs[i] = { ...b.obs[i], flag: 'rejected' }; b.flags.rejected++;
    }
    b.cuts = [...(b.cuts ?? []), { why, at: inl[from].index, n: cut.size }];
    b.lastInl = inl[from - 1] ?? null;
    return cut.size;
  }

  /**
   * Trailing fit rejects (D2 §5.2) and the D1 change-point trim (on residuals against the final fit, raw positions without
   * one). Junctions were judged online by the joint physics test when each post-gap segment was committed.
   */
  offlineTests(b) {
    const T = this.P.track;
    let inl = b.obs.filter(isInlier);
    const fitAll = inl.length >= T.launchProfileObs && this.deps.fitFlight ? this.runFit(b.obs, b.fit) : null;
    if (fitAll?.inlier?.length === b.obs.length) {
      let run = 0;
      for (let i = b.obs.length - 1; i >= 0; i--) { if (!isInlier(b.obs[i])) continue; if (fitAll.inlier[i]) break; run++; }
      if (run >= T.trailingRejects) {
        // A large steal pulls the robust fit and drags genuine late points out with it: refit without the run, then
        // cut from the first point still beyond outlierSigmas of that refit (if the remainder is still a run).
        // Walk the run forward, re-admitting each point that the current fit (refit warm) still explains.
        const cand = inl.slice(-run), out = new Set(cand), obsWithout = () => b.obs.map(o => (out.has(o) ? { ...o, flag: 'rejected' } : o));
        let fit2 = this.runFit(obsWithout(), fitAll) ?? fitAll, first = 0;
        for (; first < cand.length; first++) {
          const o = cand[first], q = fit2.predict(o.t), s2 = sq(o.sigma) + lmax(q.cov?.length === 3 ? q.cov : [0, 0, 0]);
          if (Math.hypot(o.x - q.x, o.y - q.y) > T.outlierSigmas * Math.sqrt(s2) * Math.max(1, fit2.rmsNorm ?? 1)) break;
          out.delete(o);
          fit2 = this.runFit(obsWithout(), fit2) ?? fit2;
        }
        if (cand.length - first >= T.trailingRejects) { this.truncate(b, inl, inl.length - run + first, 'trailing_rejects'); inl = b.obs.filter(isInlier); }
      }
    }
    const fit = fitAll ?? (b.mode === 'fit' ? b.fit : null);
    const pts = fit ? inl.map(o => { const p = fit.predict(o.t); return { t: o.t, x: o.x - p.x, y: o.y - p.y }; }) : inl;
    const cut = changePointCut(pts, T.changePoint, this.pxScale);
    if (cut < inl.length) this.truncate(b, inl, cut, 'change_point');
    if (fitAll) b.fit = fitAll;
  }

  observedEnd(b, inl) {
    const D = this.P.decide, last = inl.at(-1);
    if (!last) return 'lost';
    if (b.exitT != null && (b.state === 'exited' || b.state === 'wait') && b.exitT - last.t <= (D.exitWithinFrames + 0.5) / this.fps) return 'frame_exit';
    if (b.endWhy === 'landing' && b.fit?.landingT != null && b.fit.landingT - last.t <= this.lostN(b) / this.fps) return 'landing';
    if (b.state === 'active' && b.misses < this.lostN(b)) return b.maskedSince > b.misses ? 'occluded' : 'clip_end';
    if (b.maskedSince > 0 && b.maskedSince >= b.misses) return 'occluded';
    return 'lost';
  }

  hypothesis(b) {
    const inl = b.obs.filter(isInlier), end = this.observedEnd(b, inl);
    return makeTrackHypothesis({
      id: b.id, launchId: b.launchId, observations: b.obs.map(o => ({ ...o })), state: OUT_STATE[b.state] ?? 'ended',
      observedEnd: end, exitT: end === 'frame_exit' ? b.exitT : null, llr: b.llr, zmaps: b.zmaps,
      features: {
        planned: b.planned, hits: b.hits, inliers: inl.length, pd: b.pd, mode: b.mode, spawns: b.spawns, parent: b.parentId,
        lostEvents: b.lostEvents, reacquired: b.reacquired, reentries: b.reentries, probationRejects: b.probRejects,
        flags: { ...b.flags }, cuts: b.cuts ?? [], junctions: [...b.junctions], learnedDistractors: b.distractors.length,
        escape: swingEscape(inl, this.impact?.envelope ?? null), stride: this.stride, tracker: { ...this.stats }
      }
    });
  }
}

/** True when branch b holds an observation (committed or on probation) at frame k within r px of o. */
function claims(b, k, o, r) {
  const at = q => q && q.index === k && Math.hypot(q.x - o.x, q.y - o.y) <= r;
  return at(b.obs.findLast?.(q => q.index === k) ?? b.obs.filter(q => q.index === k).at(-1)) || !!b.probation?.pts.some(p => at(p.o));
}

/** Branch evidence for MHT resolution: committed LLR plus the open probation's tentative gains. */
const evidence = b => b.llr + (b.probation ? b.probation.pts.reduce((acc, p) => acc + Math.max(0, p.inc), 0) : 0);

/** Share of a's observations that b also has (same frame, within 1.5 px). */
function sharedFrac(a, b) {
  if (!a.length) return 0;
  const m = new Map(b.map(o => [o.index, o]));
  let n = 0;
  for (const o of a) { const q = m.get(o.index); if (q && Math.hypot(q.x - o.x, q.y - o.y) <= 1.5) n++; }
  return n / a.length;
}

/** One prediction whose 3σ ellipse covers every branch's 3σ + d disk (a single tube serves all branches). */
function unionPred(preds) {
  if (preds.length === 1) return preds[0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of preds) {
    const s = 3 * Math.sqrt(Math.max(0, lmax(p.cov))) + p.d;
    x0 = Math.min(x0, p.x - s); x1 = Math.max(x1, p.x + s); y0 = Math.min(y0, p.y - s); y1 = Math.max(y1, p.y + s);
  }
  const lead = preds[0], d = Math.max(...preds.map(p => p.d)), r = Math.max(x1 - x0, y1 - y0) / 2 - d;
  const pol = preds.every(p => p.polarity === lead.polarity) ? lead.polarity : 0;
  return { ...lead, x: (x0 + x1) / 2, y: (y0 + y1) / 2, cov: isoCov(sq(Math.max(r, 1) / 3)), d, polarity: pol };
}

/* ------------------------------------------------------------------ global re-association (D2 §4.9) */

/**
 * Viterbi over the cached z-maps after a refit: per frame, states are the z-map maxima inside the refit gate
 * (track.viterbiGateChi2) plus the forward observation and a miss state; emission is a z log-likelihood ratio at the
 * track's own SNR, the miss cost −ln(1 − P_d), and transitions penalize changes of the residual against the refit.
 * Recovers faint early-flight and post-occlusion points (src 'viterbi') and flags forward inliers the path drops
 * as 'rejected'. Additions stop at the last forward inlier, so the re-association can never extend a track onto a
 * later object. Frames whose map does not cover the refit path are not evaluated.
 */
export function reassociate(hyp, fit, ctx, deps = {}) {
  if (!hyp || !fit || typeof fit.predict !== 'function' || !hyp.zmaps?.length) return hyp;
  const P = ctx?.params ?? PARAMS, T = P.track, meta = ctx.meta;
  const inl = hyp.observations.filter(isInlier);
  if (!inl.length) return hyp;
  const last = inl.at(-1).index, t0 = ctx.launch?.t0 ?? -Infinity;
  const labels = new Labeler({ meta, log: ctx.log ?? null, params: P, launch: ctx.launch ?? null });
  const byIndex = new Map(hyp.observations.map(o => [o.index, o]));
  const pol = Math.sign(inl.reduce((s, o) => s + (o.polarity ?? 0), 0));
  const mu = clamp(median(inl.map(o => Math.abs(o.z1 ?? o.z ?? 0)).filter(v => v > 0)) || 4, 3, 8);
  // Measurement variance: the reported sigmas, floored by the robust scatter of the forward inliers about the refit
  // (median r² = 2·ln2·σ² for isotropic 2-D errors), so optimistic detector sigmas cannot shrink the gate.
  const r2 = inl.filter(o => o.src !== 'launch').map(o => { const p = fit.predict(o.t); return sq(o.x - p.x) + sq(o.y - p.y); });
  const sig0 = Math.sqrt(Math.max(sq(median(inl.map(o => o.sigma)) || TRACKER_MODEL.floorPx), r2.length >= 3 ? median(r2) / (2 * Math.LN2) : 0));
  const maps = [...new Map(hyp.zmaps.filter(z => zmapOk(z) && z.index <= last && z.t > t0).map(z => [z.index, z])).values()].sort((a, b) => a.index - b.index);
  const pd = clamp(inl.filter(o => maps.some(z => z.index === o.index)).length / Math.max(1, maps.length), T.minPd, 0.95);
  const missCost = -Math.log(1 - pd), emit = z => -(mu * z - mu * mu / 2);
  const frames = [];
  for (const zm of maps) {
    const fwd = byIndex.get(zm.index);
    if (fwd && (fwd.src === 'launch' || fwd.src === 'streak')) continue;
    const p = fit.predict(zm.t), S = addCov(p.cov?.length === 3 ? p.cov : [0, 0, 0], isoCov(sq(sig0)));
    const ext = 3 * Math.sqrt(Math.max(0, lmax(S)));
    if (p.x < zm.x0 - ext || p.y < zm.y0 - ext || p.x > zm.x0 + zm.pool * zm.w + ext || p.y > zm.y0 + zm.pool * zm.h + ext) continue;
    const states = [];
    if (fwd && isInlier(fwd)) {
      const c = chi2(fwd.x - p.x, fwd.y - p.y, addCov(S, obsCov(fwd)));
      if (c <= T.viterbiGateChi2) states.push({ x: fwd.x, y: fwd.y, cost: emit(Math.abs(fwd.z1 ?? fwd.z ?? mu)) + 0.5 * c, fwd, rx: fwd.x - p.x, ry: fwd.y - p.y });
    }
    for (const q of zmapPeaks(zm, pol, P.roi.minPeakZ)) {
      if (fwd && isInlier(fwd) && Math.hypot(q.x - fwd.x, q.y - fwd.y) <= zm.pool * 1.5) continue;
      const c = chi2(q.x - p.x, q.y - p.y, S);
      if (c > T.viterbiGateChi2) continue;
      states.push({ x: q.x, y: q.y, cost: emit(q.z) + 0.5 * c, peak: q, rx: q.x - p.x, ry: q.y - p.y });
    }
    states.push({ miss: true, cost: missCost });
    frames.push({ zm, p, S, fwd, states });
  }
  if (!frames.length) return hyp;
  // Viterbi: residual-continuity transitions between consecutive non-miss states.
  const tr = (a, b, sa, sb) => (a.miss || b.miss ? 0 : 0.5 * (sq(a.rx - b.rx) + sq(a.ry - b.ry)) / (lmax(sa) + lmax(sb)));
  let prev = frames[0].states.map(s => ({ c: s.cost, from: -1 }));
  const back = [prev];
  for (let f = 1; f < frames.length; f++) {
    const cur = frames[f].states.map(s => {
      let bc = Infinity, bi = 0;
      frames[f - 1].states.forEach((q, i) => { const c = prev[i].c + tr(q, s, frames[f - 1].S, frames[f].S); if (c < bc) { bc = c; bi = i; } });
      return { c: bc + s.cost, from: bi };
    });
    back.push(cur); prev = cur;
  }
  let si = prev.reduce((bi, s, i) => (s.c < prev[bi].c ? i : bi), 0);
  const pick = new Array(frames.length);
  for (let f = frames.length - 1; f >= 0; f--) { pick[f] = frames[f].states[si]; si = back[f][si].from; }
  const out = new Map(hyp.observations.map(o => [o.index, o]));
  let added = 0, dropped = 0;
  frames.forEach((fr, f) => {
    const s = pick[f], k = fr.zm.index;
    if (s.fwd) return;
    if (fr.fwd && isInlier(fr.fwd)) { out.set(k, { ...fr.fwd, flag: 'rejected' }); dropped++; }
    if (s.miss) return;
    const o = {
      index: k, t: fr.zm.t, x: s.x, y: s.y, sigma: Math.max(0.15, 1.5 * (fr.p.d / 2 + 0.7) / Math.max(1, s.peak.z)), z: s.peak.z,
      z1: s.peak.z, d: null, polarity: s.peak.polarity, src: 'viterbi', flag: 'inlier'
    };
    o.flag = labels.label(k, o, fr.p.d ?? 1);
    if (o.flag === 'inlier' || !(fr.fwd && isInlier(fr.fwd))) out.set(k, o);
    if (o.flag === 'inlier') added++;
  });
  const observations = [...out.values()].sort((a, b) => a.t - b.t);
  return makeTrackHypothesis({ ...hyp, observations, features: { ...hyp.features, reassoc: { frames: frames.length, added, dropped, mu, pd } } });
}
