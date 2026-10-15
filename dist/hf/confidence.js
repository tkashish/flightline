/**
 * hf confidence (U6): a monotone map from the launch null margin and flight-fit features to [0, 1], read as the
 * probability that the drawn trace is good (identity correct, completion shape error <= confidence.labelShapeErrDiag).
 * Every model input has a sign (+1: more is better, -1: less is better) and the model weights are non-negative
 * magnitudes, so the value can only rise when evidence improves; a missing input takes its worst value.
 *
 * DEFAULT_CONFIDENCE_MODEL is provisional ('uncalibrated') but not hand-tuned: every weight follows from the R-rule
 * thresholds (provisionalModel). With all inputs at full evidence p = confidence.provisionalFull; moving any ONE input
 * from full evidence to its gate lowers p to decide.partialMinConfidence, so a candidate that only just passes a rule is
 * partial at best, and two half-way inputs cost as much as one at its gate (log-odds add). The integrator replaces it
 * with calibrate(samples) on the synthetic tune split (logistic with <= confidence.maxParams parameters, or isotonic),
 * labelled 'synthetic-tune-v1'. Also holds the small track helpers shared by decide.js (no import cycles).
 */
import { PARAMS } from './params.js';
import { HFError, makeConfidence } from './types.js';

/* ------------------------------------------------------------------ shared track helpers */

/** Inlier observations of a track: flag 'inlier' (or unflagged) and, when the fit's mask lines up, kept by the fit. */
export function inlierObservations(track, fit = null) {
  const obs = track?.observations ?? [];
  const mask = fit?.inlier;
  const flagged = obs.filter(o => (o.flag ?? 'inlier') === 'inlier');
  if (!mask || !mask.length) return flagged;
  if (mask.length === obs.length) return obs.filter((o, i) => (o.flag ?? 'inlier') === 'inlier' && mask[i]);
  if (mask.length === flagged.length) return flagged.filter((o, i) => mask[i]);
  return flagged;
}

/** Slow-motion factor used for real-time spans: completion first (it is what the result reports), then the fit. */
export const tauOf = (fit, completion) => completion?.slowMoFactor ?? fit?.tau ?? 1;

/** Observed real-time span (s) between the first and last inlier, as validateResult measures it. */
export function realSpan(inliers, tau = 1) {
  return inliers.length >= 2 ? (inliers.at(-1).t - inliers[0].t) / tau : 0;
}

/**
 * Robust data χ²/dof of a fit (U5 FlightFit.chi2Dof: Huber cost of the inlier data rows over rows − free parameters;
 * priors excluded). Fits without it (stubs, older fits) fall back to rmsNorm²; NaN when neither is known.
 */
export const fitChi2Dof = fit => (Number.isFinite(fit?.chi2Dof) ? fit.chi2Dof : Number.isFinite(fit?.rmsNorm) ? fit.rmsNorm * fit.rmsNorm : NaN);

/**
 * Dof-aware residual excess of a fit in normalized-RMS units: fit.r2MaxRmsNorm·sqrt(chi2Dof / chi2Limit) (U5 dataFit).
 * It equals sqrt(chi2Dof) wherever D3's adequacy limit applies, and is scaled down where the effective dof are too few
 * for the excess to be significant. R2 passes when it is <= fit.r2MaxRmsNorm; it is also the confidence input fitRms.
 * Fits without chi2Limit use fit.r2MaxRmsNorm² (so stubs reduce to rmsNorm); NaN when nothing is known.
 */
export function fitExcess(fit, params = PARAMS) {
  const g = params.fit.r2MaxRmsNorm, lim = Number.isFinite(fit?.chi2Limit) && fit.chi2Limit > 0 ? fit.chi2Limit : g * g;
  return g * Math.sqrt(fitChi2Dof(fit) / lim);
}

/** A frame exit that confirms flight identity from the track alone: decide.exitConfirmed without a completion. */
export function trackExitConfirmed(track, inliers, meta, params = PARAMS) {
  if (track?.observedEnd !== 'frame_exit' || !inliers.length) return false;
  if (track.exitT == null || !(meta?.fps > 0)) return true;
  return track.exitT - inliers.at(-1).t <= (params.decide.exitWithinFrames + 0.5) / meta.fps;
}

/**
 * Observation evidence for flight identity, in units of the R2 requirement: min(inliers / r2MinObs, real span /
 * r2MinRealSec), and 1 for a confirmed frame exit (R2's alternative). 1 means flight-confirmed.
 */
export function observationEvidence(inliers, tau, exit, params = PARAMS) {
  const D = params.decide;
  return exit ? 1 : Math.min(inliers.length / D.r2MinObs, realSpan(inliers, tau) / D.r2MinRealSec);
}

/* ------------------------------------------------------------------ features */

const fin = v => (Number.isFinite(v) ? v : null);

/**
 * Confidence features of one FlightCandidate: the launch null margin first, then observation and fit features.
 * Model inputs are nullMargin, obsEvidence, fitRms, inlierFrac and priorZMax (confidenceInputs); the rest are
 * diagnostics (numbers or null). The features never read the completion's end, so dropping a completion cannot
 * change the value (the decision's never-upgrade invariant); only τ prefers the completion's slowMoFactor.
 */
export function confidenceFeatures(cand, ctx = {}) {
  const P = ctx?.params ?? PARAMS, fit = cand?.fit ?? null, comp = cand?.completion ?? null, track = cand?.track ?? null;
  const inl = inlierObservations(track, fit), tau = tauOf(fit, comp), exit = trackExitConfirmed(track, inl, ctx?.meta, P);
  return {
    nullMargin: fin(cand?.launch?.margin ?? cand?.decision?.margin),
    obsEvidence: observationEvidence(inl, tau, exit, P),
    fitRms: fin(fit ? fitExcess(fit, P) : NaN),
    inlierFrac: fin(fit?.inlierFrac),
    priorZMax: fin(fit?.priorZMax),
    logObs: Math.log1p(inl.length),
    realSpan: realSpan(inl, tau),
    rmsNorm: fin(fit?.rmsNorm),
    plausible: fit?.plausible == null ? null : fit.plausible ? 1 : 0,
    trackLlr: fin(track?.llr),
    identityMargin: fin(track?.features?.identityMargin),
    escape: cand?.escape == null ? null : cand.escape ? 1 : 0,
    launchS: fin(cand?.decision?.S)
  };
}

/* ------------------------------------------------------------------ models */

/**
 * Model inputs: sign, full-evidence value, gate value (an R-rule threshold) and clamp range (from two gate spans past
 * full evidence to full evidence; obsEvidence stops at 0). Gates:
 *   nullMargin   0 (launch accepted);  full: launch.support zCap − zOffset, one fully supported frame beyond the null bound
 *   obsEvidence  2 / r2MinObs (two inliers, the least that draws a trace);  full: 1 (R2's observation requirement met)
 *   fitRms       fit.r2MaxRmsNorm (R2 data gate on fitExcess);  full: 1 (residuals at the noise level)
 *   inlierFrac   fit.r2MinInlierFrac (R2 gate);  full: 1
 *   priorZMax    2·fit.r2MaxPriorZ;  full: fit.r2MaxPriorZ. A soft term: priors cost nothing below the conflict level and
 *                lower confidence gradually above it, but never veto a good data fit.
 * @returns {{name:string, sign:1|-1, full:number, gate:number, range:[number, number]}[]}
 */
export function confidenceInputs(params = PARAMS) {
  const F = params.fit, D = params.decide, S = params.launch.support;
  const spec = [
    ['nullMargin', 1, S.zCap - S.zOffset, 0, -Infinity],
    ['obsEvidence', 1, 1, 2 / D.r2MinObs, 0],
    ['fitRms', -1, 1, F.r2MaxRmsNorm, 0],
    ['inlierFrac', 1, 1, F.r2MinInlierFrac, 0],
    ['priorZMax', -1, F.r2MaxPriorZ, 2 * F.r2MaxPriorZ, 0]
  ];
  return spec.map(([name, sign, full, gate, floor]) => {
    const worst = full - 2 * (full - gate);
    const r = v => Math.round(v * 1e9) / 1e9;   // 0.8 − 0.2 is 0.6000000000000001
    return { name, sign, full, gate, range: sign > 0 ? [Math.max(floor, r(worst)), full] : [full, r(worst)] };
  });
}

const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const logit = p => Math.log(p / (1 - p));

/**
 * The provisional model of the header: logistic weights w_i = (logit(provisionalFull) − logit(partialMinConfidence)) /
 * |full_i − gate_i| and the bias that puts full evidence on every input at provisionalFull.
 */
export function provisionalModel(params = PARAMS) {
  const C = params.confidence, D = params.decide, ins = confidenceInputs(params);
  if (!(C.provisionalFull > D.partialMinConfidence && C.provisionalFull < 1)) throw new HFError('bad-arg', 'confidence.provisionalFull must lie in (decide.partialMinConfidence, 1)');
  const span = logit(C.provisionalFull) - logit(D.partialMinConfidence), weights = ins.map(i => span / Math.abs(i.full - i.gate));
  const bias = logit(C.provisionalFull) - ins.reduce((s, i, k) => s + weights[k] * i.sign * i.full, 0);
  return deepFreeze({
    kind: 'logistic', calibratedOn: C.uncalibrated, features: ins.map(i => i.name), signs: ins.map(i => i.sign),
    ranges: ins.map(i => [...i.range]), weights, bias
  });
}

export const DEFAULT_CONFIDENCE_MODEL = provisionalModel(PARAMS);

const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Signed, clamped model inputs: x_i = sign_i · clamp(f_i); missing values take the worst end. */
function inputs(features, model) {
  return model.features.map((name, i) => {
    const [lo, hi] = model.ranges[i], s = model.signs[i], v = features?.[name];
    const c = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : s > 0 ? lo : hi;
    return s * c;
  });
}

function linear(x, model) {
  let z = model.bias ?? 0;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * x[i];
  return z;
}

function isoEval(iso, z) {
  const { x, y } = iso, n = x.length;
  if (!n) return 0.5;
  if (z <= x[0]) return y[0];
  if (z >= x[n - 1]) return y[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= z) lo = m; else hi = m; }
  const u = x[hi] > x[lo] ? (z - x[lo]) / (x[hi] - x[lo]) : 0;
  return y[lo] + u * (y[hi] - y[lo]);
}

/** Model probability for features (no Confidence wrapper). */
function probability(features, model) {
  const z = linear(inputs(features, model), model), v = model.kind === 'isotonic' ? isoEval(model.isotonic, z) : sigmoid(z);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Confidence {value, calibratedOn, components} from features (confidenceFeatures output). */
export function scoreConfidence(features = {}, model = DEFAULT_CONFIDENCE_MODEL) {
  const value = probability(features, model);
  const components = {};
  for (const [k, v] of Object.entries(features ?? {})) components[k] = Number.isFinite(v) ? v : null;
  return makeConfidence(value, components, model.calibratedOn);
}

/* ------------------------------------------------------------------ fitting (tune split only) */

function solve(A, b, n) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Mean log loss (with an L2 term on the weights) of parameters [bias, w...] over X (signed inputs) and y. */
function loss(theta, X, y, l2) {
  let s = 0;
  for (let i = 0; i < X.length; i++) {
    let z = theta[0];
    for (let j = 0; j < X[i].length; j++) z += theta[j + 1] * X[i][j];
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
    s -= y[i] ? Math.log(p) : Math.log(1 - p);
  }
  let r = 0;
  for (let j = 1; j < theta.length; j++) r += theta[j] * theta[j];
  return s / X.length + l2 * r;
}

/** Projected Newton for logistic regression with non-negative weights (the bias is free). */
function fitLogistic(X, y, { l2, iters }) {
  const m = X[0].length, n = m + 1;
  let theta = new Array(n).fill(0), cur = loss(theta, X, y, l2);
  for (let it = 0; it < iters; it++) {
    const g = new Array(n).fill(0), H = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = [1, ...X[i]];
      let z = 0;
      for (let j = 0; j < n; j++) z += theta[j] * xi[j];
      const p = sigmoid(z), w = Math.max(1e-9, p * (1 - p));
      for (let j = 0; j < n; j++) {
        g[j] += (p - y[i]) * xi[j] / X.length;
        for (let k = 0; k < n; k++) H[j][k] += w * xi[j] * xi[k] / X.length;
      }
    }
    for (let j = 1; j < n; j++) { g[j] += 2 * l2 * theta[j]; H[j][j] += 2 * l2; }
    // Active set: weights at 0 whose gradient pushes them negative stay fixed at 0.
    const free = theta.map((v, j) => j === 0 || v > 0 || g[j] < 0);
    const idx = free.map((f, j) => (f ? j : -1)).filter(j => j >= 0);
    const d = solve(idx.map(a => idx.map(b => H[a][b])), idx.map(a => -g[a]), idx.length);
    let step = 1, next = null, nl = Infinity;
    for (let ls = 0; ls < 30; ls++, step *= 0.5) {
      next = [...theta];
      idx.forEach((j, q) => { next[j] = theta[j] + step * d[q]; });
      for (let j = 1; j < n; j++) next[j] = Math.max(0, next[j]);
      nl = loss(next, X, y, l2);
      if (nl <= cur) break;
    }
    if (!(nl <= cur)) break;
    const moved = Math.max(...next.map((v, j) => Math.abs(v - theta[j])));
    theta = next; cur = nl;
    if (moved < 1e-9) break;
  }
  return theta;
}

/** Pool-adjacent-violators: non-decreasing step fit of labels against the index z. */
function isotonicFit(z, y) {
  const order = z.map((v, i) => i).sort((a, b) => z[a] - z[b]);
  const blocks = [];
  for (const i of order) {
    blocks.push({ sum: y[i], n: 1, x: z[i] });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).n > blocks.at(-1).sum / blocks.at(-1).n) {
      const b = blocks.pop(), a = blocks.at(-1);
      a.x = (a.x * a.n + b.x * b.n) / (a.n + b.n); a.sum += b.sum; a.n += b.n;
    }
  }
  return { x: blocks.map(b => b.x), y: blocks.map(b => b.sum / b.n) };
}

/**
 * Fit a confidence model on tune rows [{features, label: 0|1}] (label: identity correct and completion shape
 * error <= confidence.labelShapeErrDiag). 'logistic' keeps <= confidence.maxParams parameters (bias included) with
 * monotone (non-negative) weights; 'isotonic' maps the provisional model's linear index through a PAV step fit.
 */
export function fitConfidence(rows, { kind = PARAMS.confidence.kind, features, l2 = 1e-3, iters = 60, params = PARAMS } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new HFError('bad-arg', 'fitConfidence needs at least 2 rows');
  const prov = provisionalModel(params), names = features ?? prov.features;
  if (names.length + 1 > params.confidence.maxParams) throw new HFError('bad-arg', `${names.length + 1} parameters > confidence.maxParams ${params.confidence.maxParams}`);
  const idx = names.map(f => { const k = prov.features.indexOf(f); if (k < 0) throw new HFError('bad-arg', `unknown confidence feature ${f}`); return k; });
  const base = { calibratedOn: params.confidence.calibratedOn, features: [...names], signs: idx.map(k => prov.signs[k]), ranges: idx.map(k => [...prov.ranges[k]]) };
  const X = rows.map(r => inputs(r.features, base)), y = rows.map(r => (r.label ? 1 : 0));
  if (kind === 'isotonic') {
    const ref = { ...base, weights: idx.map(k => prov.weights[k]), bias: 0 };
    const z = X.map(x => linear(x, ref));
    return { kind: 'isotonic', ...ref, isotonic: isotonicFit(z, y) };
  }
  if (kind !== 'logistic') throw new HFError('bad-arg', `unknown confidence model kind ${kind}`);
  const theta = fitLogistic(X, y, { l2, iters });
  return { kind: 'logistic', ...base, weights: theta.slice(1), bias: theta[0] };
}

/** Log loss, Brier score and expected calibration error (equal-width bins) of probabilities p against labels y. */
export function calibrationReport(p, y, bins = 10) {
  const n = p.length, cl = v => Math.min(1 - 1e-12, Math.max(1e-12, v));
  let ll = 0, brier = 0;
  const cnt = new Array(bins).fill(0), sp = new Array(bins).fill(0), sy = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    ll -= y[i] ? Math.log(cl(p[i])) : Math.log(1 - cl(p[i])); brier += (p[i] - y[i]) ** 2;
    const b = Math.min(bins - 1, Math.floor(p[i] * bins)); cnt[b]++; sp[b] += p[i]; sy[b] += y[i];
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) if (cnt[b]) ece += cnt[b] / n * Math.abs(sp[b] / cnt[b] - sy[b] / cnt[b]);
  return { n, positives: y.reduce((s, v) => s + v, 0), logLoss: n ? ll / n : NaN, brier: n ? brier / n : NaN, ece };
}

/**
 * Calibrate the confidence model on the synthetic TUNE split (the integrator runs this; never on holdout).
 * samples: [{features | components, label | correct}], e.g. HFResult.confidence.components of every traced tune clip
 * with the bench's ClipMetrics.correct (identity right and completion shape error within the gate), or
 * [{candidate, ctx, label}] to compute the features here. Both good and bad samples are required.
 * Returns the fitted model (kind 'logistic' with non-negative signed weights, <= confidence.maxParams parameters, or
 * 'isotonic' over the provisional index), labelled confidence.calibratedOn, with `report` = {provisional, fitted}
 * calibration reports on the samples. Pass it to decide as ctx.confidenceModel.
 * @param {{features?:object, components?:object, candidate?:object, ctx?:object, label?:number|boolean, correct?:boolean}[]} samples
 * @param {{kind?:'logistic'|'isotonic', features?:string[], params?:object, l2?:number, iters?:number}} [opts]
 */
export function calibrate(samples, { kind, features, params = PARAMS, l2, iters } = {}) {
  if (!Array.isArray(samples)) throw new HFError('bad-arg', 'calibrate needs an array of samples');
  const rows = samples.map((s, i) => {
    const f = s.features ?? s.components ?? (s.candidate ? confidenceFeatures(s.candidate, { params, ...(s.ctx ?? {}) }) : null), lab = s.label ?? s.correct;
    if (!f || typeof f !== 'object') throw new HFError('bad-arg', `calibrate sample ${i} has no features`);
    if (lab == null) throw new HFError('bad-arg', `calibrate sample ${i} has no label`);
    return { features: f, label: lab ? 1 : 0 };
  });
  const pos = rows.filter(r => r.label).length;
  if (!pos || pos === rows.length) throw new HFError('bad-arg', 'calibrate needs both good and bad samples');
  const model = fitConfidence(rows, { kind: kind ?? params.confidence.kind, features, params, ...(l2 != null ? { l2 } : {}), ...(iters != null ? { iters } : {}) });
  const y = rows.map(r => r.label), prov = provisionalModel(params);
  model.report = { provisional: calibrationReport(rows.map(r => probability(r.features, prov)), y), fitted: calibrationReport(rows.map(r => probability(r.features, model)), y) };
  return model;
}
