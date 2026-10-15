/**
 * hf flight model (U5): the M3D ballistic fit of D3 §5 with the FINAL grafts.
 *
 * Model. A golf ball leaves the address at video time t0 and flies with gravity, quadratic drag and Magnus lift
 * whose direction is tilted about the velocity by the spin-axis tilt ψ (draws and fades are symmetric):
 *   dv/dt = g − k_D·|v|·v + k_L·|v|²·n(ψ),  k = ρ·A·C/(2m),  n = cos ψ·(up ⟂ v) + sin ψ·(right of travel).
 * It is seen by a pinhole camera at the origin (yaw-aligned world: X right, Y up, Z forward) with pitch θ (+ looks
 * up), roll φ, focal f and one radial term k1 (x = c + f·x_n·(1 + k1·r²)). The address ball's size fixes the
 * scale: its depth is Z0 = f·D/d0 along the address ray. Real time is t_real = (t − t0)/τ; τ is ALWAYS fitted, and a
 * detected speed ramp splits it into τ before and τ2 after `ramp.tSplit`.
 *
 * Fit. Robust Levenberg-Marquardt (Huber, lm.js) on whitened image positions plus early sizes as log-radius
 * observations (D2), with priors from PARAMS.fit: focal mixture (main, ultra-wide 0.5x with k1, tele), pitch/roll
 * tightened by a geometric horizon (a sky line only bounds pitch from below: horizonKind), speed, elevation, C_L, C_D,
 * tilt, τ. Every observation σ gets fit.sigmaFloorPx in quadrature (detector σ omits codec, blur and background
 * error; without it the focal/k1/τ freedom chases correlated detection errors). Multi-start over the D3 grid (elevation × speed ×
 * azimuth from the image launch direction) × τ modes × focal components, plus a ray-constraint linear start; the best
 * starts by MAP go to LM, and starts whose cost exceeds abandonFactor × the best are abandoned early. Outliers
 * (> outlierSigmas, robust scale) are rejected with one refit; RANSAC re-initializes when inliers drop below
 * minInlierFrac. Laplace covariance (JᵀWJ + priors)⁻¹ gives σ(t) through the projection Jacobian. When M3D is
 * ill-conditioned, forward validation (D1) picks M3D or a short-horizon image model (kind 'image').
 * R2 inputs (decide.js): FlightFit.chi2Dof is the robust data χ²/dof over the effective dof, chi2Limit the value that
 * fails R2 at that dof (dataFit; priors excluded: they shape the MAP estimate but never veto a good data fit), and
 * FlightFit.plausible says the fitted ball physics lies in fit.physical.
 *
 * Coordinates: stabilized native px, video seconds (protocol doc §4-§5). The synthetic generator never imports this.
 */
import { HFError, throwIfAborted } from './types.js';
import { PARAMS } from './params.js';
import { levenbergMarquardt, invertSPD, solveSPD, huber } from './lm.js';
import { sigmaMajor } from './complete.js';

const DEG = Math.PI / 180;
export const M3D_PARAM_NAMES = Object.freeze(['logF', 'pitch', 'roll', 'logS0', 'elev', 'azim', 'cl', 'tilt', 'cd', 'logTau', 'k1', 'logTau2']);
const LF = 0, PITCH = 1, ROLL = 2, LS0 = 3, ELEV = 4, AZIM = 5, CL = 6, TILT = 7, CD = 8, LTAU = 9, K1 = 10, LTAU2 = 11, NP = 12;
const DYN = [LS0, ELEV, CL, TILT, CD];
const IS_DYN = Uint8Array.from({ length: NP }, (_, k) => DYN.includes(k) ? 1 : 0);
const FD = [1e-5, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-5, 1e-5, 1e-5, 1e-6, 1e-5, 1e-6];
export const IMAGE_PARAM_NAMES = Object.freeze(['x0', 'vx', 'ax', 'y0', 'vy', 'ay']);

// Numerical guard rails of the optimizer, not decision thresholds (protocol doc §2: thresholds live in PARAMS).
const BIG = 50;               // residual (σ) when the model puts the ball behind the camera
const GRID_TRUNC = 400;       // grid scoring truncates each observation's χ² here (D3 E4 prototype)
const TAU_FLOOR = 0.01;       // every τ mode keeps at least this prior weight, so τ is always fitted
const PHASE1 = 8;             // LM iterations before the early-abandon check
const THIN = 160;             // multi-start phases use at most this many observations (the final refit uses all)
const RANSAC_TRIALS = 6;
const LO = [NaN, -60 * DEG, -30 * DEG, Math.log(2), -30 * DEG, -10, -0.3, -80 * DEG, 0.02, Math.log(0.25), -0.3, Math.log(0.25)];
const HI = [NaN, 60 * DEG, 30 * DEG, Math.log(120), 85 * DEG, 10, 0.8, 80 * DEG, 0.8, Math.log(64), 0.3, Math.log(64)];

/**
 * What a ctx.horizon line constrains (U2 Horizon, old {slope, y0, conf} or new {kind, slope, y0, conf} shape):
 * 'horizon' — a geometric horizon (kind 'horizon'): tight two-sided pitch/roll priors (D3 §5.1);
 * 'skyline' — the top of trees, nets or buildings (kind 'skyline', any other kind, and the legacy shape without a
 *             kind, which U2's sky-line detector produces): the true horizon lies at or below it, so it is only a
 *             one-sided lower bound on pitch, and its slope says nothing reliable about roll;
 * null      — no usable line.
 * @param {{kind?:string, slope:number, y0:number}|null|undefined} h
 * @returns {'horizon'|'skyline'|null}
 */
export function horizonKind(h) {
  if (!h || !Number.isFinite(h.slope) || !Number.isFinite(h.y0)) return null;
  return h.kind === 'horizon' ? 'horizon' : 'skyline';
}

/* ------------------------------------------------------------------ time grid and integrator */

const gridCache = new Map();
function realGrid(fp) {
  const key = `${fp.rk4Hz}|${fp.rk4EarlyHz}|${fp.rk4EarlyRealSec}`;
  let g = gridCache.get(key);
  if (!g) {
    const he = 1 / fp.rk4EarlyHz, h = 1 / fp.rk4Hz, nE = Math.max(0, Math.round(fp.rk4EarlyRealSec * fp.rk4EarlyHz));
    gridCache.set(key, g = { he, h, nE, tE: nE * he });
  }
  return g;
}
const nodeTime = (g, i) => i <= g.nE ? i * g.he : g.tE + (i - g.nE) * g.h;
const nodeIndex = (g, t) => t < g.tE ? Math.floor(t / g.he) : g.nE + Math.floor((t - g.tE) / g.h);
const nodesFor = (g, T) => nodeIndex(g, Math.max(0, T)) + 3;

let AX = 0, AY = 0, AZ = 0;
function accel(vx, vy, vz, kd, kl, ct, st, g) {
  const hz2 = vx * vx + vz * vz, s = Math.sqrt(hz2 + vy * vy), hz = Math.sqrt(hz2) + 1e-12;
  const ls = kl * s, a = ls * ct / hz, b = ls * s * st / hz, ds = kd * s;
  AX = -ds * vx - a * vy * vx + b * vz;
  AY = -g - ds * vy + ls * ct * hz;
  AZ = -ds * vz - a * vy * vz - b * vx;
}

/**
 * RK4 on the fixed real-time grid in the canonical frame (x right of the launch azimuth, y up, z along it; the ball
 * starts at the origin). Writes p, v per node into buf (6 per node). A fixed grid keeps the trajectory a smooth
 * function of the parameters, so finite differences are exact to rounding.
 */
function integrate(M, s0, el, cl, tilt, cd, N, buf) {
  if (!buf || buf.length < 6 * N) buf = new Float64Array(6 * N);
  const gr = M.grid, g = M.g, kd = M.kAero * cd, kl = M.kAero * cl, ct = Math.cos(tilt), st = Math.sin(tilt);
  let px = 0, py = 0, pz = 0, vx = 0, vy = s0 * Math.sin(el), vz = s0 * Math.cos(el);
  buf[0] = 0; buf[1] = 0; buf[2] = 0; buf[3] = vx; buf[4] = vy; buf[5] = vz;
  for (let i = 1; i < N; i++) {
    const h = i <= gr.nE ? gr.he : gr.h, h2 = 0.5 * h;
    accel(vx, vy, vz, kd, kl, ct, st, g); const a1x = AX, a1y = AY, a1z = AZ;
    const v2x = vx + h2 * a1x, v2y = vy + h2 * a1y, v2z = vz + h2 * a1z;
    accel(v2x, v2y, v2z, kd, kl, ct, st, g); const a2x = AX, a2y = AY, a2z = AZ;
    const v3x = vx + h2 * a2x, v3y = vy + h2 * a2y, v3z = vz + h2 * a2z;
    accel(v3x, v3y, v3z, kd, kl, ct, st, g); const a3x = AX, a3y = AY, a3z = AZ;
    const v4x = vx + h * a3x, v4y = vy + h * a3y, v4z = vz + h * a3z;
    accel(v4x, v4y, v4z, kd, kl, ct, st, g);
    const h6 = h / 6;
    px += h6 * (vx + 2 * v2x + 2 * v3x + v4x); py += h6 * (vy + 2 * v2y + 2 * v3y + v4y); pz += h6 * (vz + 2 * v2z + 2 * v3z + v4z);
    vx += h6 * (a1x + 2 * a2x + 2 * a3x + AX); vy += h6 * (a1y + 2 * a2y + 2 * a3y + AY); vz += h6 * (a1z + 2 * a2z + 2 * a3z + AZ);
    const o = 6 * i;
    buf[o] = px; buf[o + 1] = py; buf[o + 2] = pz; buf[o + 3] = vx; buf[o + 4] = vy; buf[o + 5] = vz;
  }
  return buf;
}
const trajOf = (M, p, N, buf) => ({ N, buf: integrate(M, Math.exp(p[LS0]), p[ELEV], p[CL], p[TILT], p[CD], N, buf) });

let PX = 0, PY = 0, PZ = 0, VX = 0, VY = 0, VZ = 0;
/** Cubic Hermite position (and velocity) at real time tr from the stored nodes. */
function hermite(gr, buf, N, tr, vel) {
  if (!(tr > 0)) tr = 0;
  let i = nodeIndex(gr, tr);
  if (i > N - 2) i = N - 2;
  const h = i < gr.nE ? gr.he : gr.h, s = (tr - nodeTime(gr, i)) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = 3 * s2 - 2 * s3, h11 = (s3 - s2) * h, o = 6 * i, q = o + 6;
  PX = h00 * buf[o] + h10 * buf[o + 3] + h01 * buf[q] + h11 * buf[q + 3];
  PY = h00 * buf[o + 1] + h10 * buf[o + 4] + h01 * buf[q + 1] + h11 * buf[q + 4];
  PZ = h00 * buf[o + 2] + h10 * buf[o + 5] + h01 * buf[q + 2] + h11 * buf[q + 5];
  if (vel) {
    const d00 = 6 * (s2 - s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = -d00, d11 = 3 * s2 - 2 * s;
    VX = d00 * buf[o] + d10 * buf[o + 3] + d01 * buf[q] + d11 * buf[q + 3];
    VY = d00 * buf[o + 1] + d10 * buf[o + 4] + d01 * buf[q + 1] + d11 * buf[q + 4];
    VZ = d00 * buf[o + 2] + d10 * buf[o + 5] + d01 * buf[q + 2] + d11 * buf[q + 5];
  }
}

/* ------------------------------------------------------------------ camera */

function undistort(xd, yd, k1) {
  if (!k1) return [xd, yd];
  const rd = Math.hypot(xd, yd);
  if (!rd) return [0, 0];
  const rMax = k1 < 0 ? Math.sqrt(-1 / (3 * k1)) * 0.999 : Infinity;
  let r = Math.min(rd, rMax);
  for (let i = 0; i < 10; i++) r = Math.min(rMax, Math.max(0, r - (r * (1 + k1 * r * r) - rd) / (1 + 3 * k1 * r * r)));
  return [xd * r / rd, yd * r / rd];
}

/**
 * Camera axes (yaw-aligned world) and the address point PA for (f, θ, φ, k1). k1 is relative to the frame corner
 * (the corner moves by k1 of its radius, as in the synthetic generator's intrinsics); G.k1 is the per-normalized-radius
 * coefficient k1 / r_c², r_c = half-diagonal / f, used by the projection.
 */
function geometry(M, logF, pitch, roll, k1, G = {}) {
  const f = Math.exp(logF), st = Math.sin(pitch), ct = Math.cos(pitch), sp = Math.sin(roll), cp = Math.cos(roll);
  G.f = f; G.k1 = k1 ? k1 * (f * f) / (0.25 * (M.W * M.W + M.H * M.H)) : 0;
  G.rx = cp; G.ry = sp * ct; G.rz = -sp * st;
  G.dx = sp; G.dy = -cp * ct; G.dz = cp * st;
  G.fy = st; G.fz = ct;
  const [xn, yn] = undistort((M.ax - M.cx) / f, (M.ay - M.cy) / f, G.k1);
  const Z0 = f * (1 + G.k1 * (xn * xn + yn * yn)) * M.D / M.d0;
  G.Z0 = Z0; G.xnA = xn; G.ynA = yn;
  G.PAx = Z0 * (xn * G.rx + yn * G.dx);
  G.PAy = Z0 * (xn * G.ry + yn * G.dy + G.fy);
  G.PAz = Z0 * (xn * G.rz + yn * G.dz + G.fz);
  return G;
}

let OX = 0, OY = 0, OD = 0, OZ = 0;
/** Project canonical position (PX, PY, PZ) rotated by β into px; false when behind the camera. */
function projectCanon(M, G, cb, sb, px, py, pz) {
  const X = G.PAx + cb * px + sb * pz, Y = G.PAy + py, Z = G.PAz - sb * px + cb * pz;
  const zc = Y * G.fy + Z * G.fz;
  OZ = zc;
  if (!(zc > 0.05)) return false;
  const xn = (X * G.rx + Y * G.ry + Z * G.rz) / zc, yn = (X * G.dx + Y * G.dy + Z * G.dz) / zc, k = 1 + G.k1 * (xn * xn + yn * yn);
  OX = M.cx + G.f * xn * k; OY = M.cy + G.f * yn * k; OD = G.f * k * M.D / zc;
  return true;
}

/* ------------------------------------------------------------------ time warp (τ, optional ramp) */

function warp(M, p, t) {
  if (!M.ramp) return (t - M.t0) / Math.exp(p[LTAU]);
  const tS = M.ramp.tSplit;
  return t <= tS ? (t - M.t0) / Math.exp(p[LTAU]) : (tS - M.t0) / Math.exp(p[LTAU]) + (t - tS) / Math.exp(p[LTAU2]);
}
function unwarp(M, p, tr) {
  if (!M.ramp) return M.t0 + Math.exp(p[LTAU]) * tr;
  const tS = M.ramp.tSplit, trS = (tS - M.t0) / Math.exp(p[LTAU]);
  return tr <= trS ? M.t0 + Math.exp(p[LTAU]) * tr : tS + Math.exp(p[LTAU2]) * (tr - trS);
}

/* ------------------------------------------------------------------ model setup */

function buildModel(obs, ctx, P) {
  const meta = ctx.meta, L = ctx.launch;
  if (!meta || !L) throw new HFError('bad-arg', 'fitFlight needs ctx.meta and ctx.launch');
  const fp = P.fit, W = meta.width, H = meta.height, D = fp.ballDiameterM;
  const M = {
    P, W, H, cx: W / 2, cy: H / 2, diag: Math.hypot(W, H), ax: L.address.x, ay: L.address.y, d0: L.d0, t0: L.t0, fps: meta.fps,
    D, kAero: fp.airDensity * Math.PI * D * D / 4 / (2 * fp.ballMassKg), g: fp.gravity, grid: realGrid(fp), ramp: null,
    fNom: (Math.max(W, H) / 2) / Math.tan(fp.fovLongDeg / 2 * DEG), horizon: null, sky: null
  };
  const n = obs.length;
  M.src = obs; M.n = n;
  M.t = new Float64Array(n); M.x = new Float64Array(n); M.y = new Float64Array(n); M.sig = new Float64Array(n);
  M.w11 = new Float64Array(n); M.w21 = new Float64Array(n); M.w22 = new Float64Array(n); M.ld = new Float64Array(n); M.hasD = new Uint8Array(n);
  const base = [], f2 = fp.sigmaFloorPx * fp.sigmaFloorPx;
  for (let i = 0; i < n; i++) {
    // Measurement σ plus the floor in quadrature (on the isotropic σ and on both diagonal terms of a full cov).
    const o = obs[i], s = Math.sqrt((o.sigma > 0 ? o.sigma * o.sigma : 1) + f2);
    M.t[i] = o.t; M.x[i] = o.x; M.y[i] = o.y; M.sig[i] = s;
    const c = o.cov;
    if (c && c.length === 3 && c[0] > 0 && c[2] > 0 && c[0] * c[2] > c[1] * c[1]) {
      const l11 = Math.sqrt(c[0] + f2), l21 = c[1] / l11, l22 = Math.sqrt(c[2] + f2 - l21 * l21);
      M.w11[i] = 1 / l11; M.w21[i] = -l21 / (l11 * l22); M.w22[i] = 1 / l22;
    } else { M.w11[i] = 1 / s; M.w21[i] = 0; M.w22[i] = 1 / s; }
    if (o.d != null && o.d / 2 >= fp.minRadiusPx) { M.hasD[i] = 1; M.ld[i] = Math.log(o.d); }
    if ((o.flag ?? 'inlier') === 'inlier' && o.t > M.t0 && Number.isFinite(o.x) && Number.isFinite(o.y)) base.push(i);
  }
  base.sort((a, b) => M.t[a] - M.t[b]);
  M.base = Int32Array.from(base);
  setActive(M, M.base);
  // Horizon (D3 §5.1). A geometric horizon tightens pitch/roll: φ_h = atan(slope), tan θ_h = (y_h(cx) − cy)·cos φ_h / f.
  // A sky line keeps the generic priors and adds a one-sided row: the true horizon at the centre column is at or below
  // the line, i.e. θ >= atan(y_s(cx) − cy)·cos φ / f (skyPitch); only a pitch above that bound costs nothing.
  const h = ctx.horizon, kind = horizonKind(h);
  if (kind === 'horizon') {
    M.horizon = h; M.rollMu = Math.atan(h.slope); M.rollSig = fp.horizonRollSigmaDeg * DEG; M.pitchSig = fp.horizonPitchSigmaDeg * DEG;
    M.yh = h.y0 + h.slope * M.cx - M.cy;
  } else {
    M.rollMu = fp.rollDeg[0] * DEG; M.rollSig = fp.rollDeg[1] * DEG; M.pitchSig = fp.pitchDeg[1] * DEG;
    if (kind === 'skyline') M.sky = { yh: h.y0 + h.slope * M.cx - M.cy, sig: fp.skylineSigmaDeg * DEG };
  }
  return M;
}
const pitchMu = (M, f) => M.horizon ? Math.atan(M.yh * Math.cos(M.rollMu) / f) : M.P.fit.pitchDeg[0] * DEG;
/** Lowest pitch a sky line allows (the true horizon at or below it) for focal f and roll φ; −∞ without a sky line. */
const skyPitch = (M, f, roll) => M.sky ? Math.atan(M.sky.yh * Math.cos(roll) / f) : -Infinity;

function setActive(M, idx) {
  M.active = idx;
  let rows = 0;
  for (const k of idx) rows += 2 + M.hasD[k];
  M.nData = rows;
  M.tMax = idx.length ? M.t[idx[idx.length - 1]] : M.t0;
}

/** τ modes with prior weights (ctx.tauPrior, or capture-fps metadata); every mode keeps a floor weight. */
function tauModes(ctx, P) {
  const meta = ctx.meta, hint = meta.captureFpsHint;
  if (hint > 0 && hint / meta.fps >= 1) return [{ tau: hint / meta.fps, w: 1, pen: 0 }];
  const tp = ctx.tauPrior ?? { modes: P.impact.tau.modes, weights: P.impact.tau.modes.map((_, i) => i ? 0 : 1) };
  const ws = tp.weights.map(w => Math.max(TAU_FLOOR, w)), sum = ws.reduce((s, w) => s + w, 0);
  return tp.modes.map((tau, i) => ({ tau, w: ws[i] / sum, pen: -2 * Math.log(ws[i] / sum) }));
}

/** Focal mixture (D3 §5.1): main, ultra-wide 0.5x with k1, tele; metadata focal35 overrides. */
function focalComponents(M, meta) {
  const fp = M.P.fit;
  if (meta.focal35 > 0) {
    const f = meta.focal35 * Math.max(M.W, M.H) / 36;
    return [{ i: 0, ratio: f / M.fNom, f, w: 1, pen: 0, k1Free: f < 0.75 * M.fNom }];
  }
  const sum = fp.focalWeights.reduce((s, w) => s + w, 0);
  return fp.focalComponents.map((ratio, i) => ({ i, ratio, f: ratio * M.fNom, w: fp.focalWeights[i] / sum, pen: -2 * Math.log(fp.focalWeights[i] / sum), k1Free: ratio < 1 }));
}

/* ------------------------------------------------------------------ residuals */

const priorCount = (M, PC) => 9 + (PC.comp.k1Free ? 1 : 0) + (M.ramp ? 1 : 0) + (M.sky ? 1 : 0);
/** Names of the prior rows, in priorRows order (diagnostics). */
const priorNames = (M, PC) => ['logF', 'pitch', 'roll', 'logS0', 'elev', 'cl', 'tilt', 'cd', 'logTau', ...(PC.comp.k1Free ? ['k1'] : []), ...(M.ramp ? ['logTau2'] : []), ...(M.sky ? ['skyline'] : [])];

function priorRows(M, PC, p, out, o) {
  const fp = M.P.fit;
  out[o++] = (p[LF] - Math.log(PC.comp.f)) / fp.focalSigmaLog;
  out[o++] = (p[PITCH] - pitchMu(M, Math.exp(p[LF]))) / M.pitchSig;
  out[o++] = (p[ROLL] - M.rollMu) / M.rollSig;
  out[o++] = (p[LS0] - Math.log(fp.speedMps[0])) / fp.speedMps[1];
  out[o++] = (p[ELEV] - fp.elevationDeg[0] * DEG) / (fp.elevationDeg[1] * DEG);
  out[o++] = (p[CL] - fp.cl[0]) / fp.cl[1];
  out[o++] = (p[TILT] - fp.spinTiltDeg[0] * DEG) / (fp.spinTiltDeg[1] * DEG);
  out[o++] = (p[CD] - fp.cd[0]) / fp.cd[1];
  out[o++] = (p[LTAU] - Math.log(PC.mode.tau)) / fp.tauLogSigma;
  if (PC.comp.k1Free) out[o++] = (p[K1] - fp.k1Prior[0]) / fp.k1Prior[1];
  if (M.ramp) out[o++] = (p[LTAU2] - Math.log(M.ramp.tau2Prior)) / fp.rampTauLogSigma;
  // One-sided sky-line bound (zero above the bound, so it never pulls pitch toward the trees).
  if (M.sky) out[o++] = Math.min(0, p[PITCH] - skyPitch(M, Math.exp(p[LF]), p[ROLL])) / M.sky.sig;
  return out;
}

const GS = {};
/** Whitened data rows (x, y and log-radius per active observation) followed by the prior rows. */
function rows(M, PC, p, traj, out) {
  const G = geometry(M, p[LF], p[PITCH], p[ROLL], p[K1], GS), cb = Math.cos(p[AZIM]), sb = Math.sin(p[AZIM]);
  const lrs = M.P.fit.logRadiusSigma, act = M.active;
  let o = 0;
  for (let a = 0; a < act.length; a++) {
    const k = act[a];
    hermite(M.grid, traj.buf, traj.N, warp(M, p, M.t[k]), false);
    if (!projectCanon(M, G, cb, sb, PX, PY, PZ)) { out[o++] = BIG; out[o++] = BIG; if (M.hasD[k]) out[o++] = BIG; continue; }
    const ex = OX - M.x[k], ey = OY - M.y[k];
    out[o++] = ex * M.w11[k];
    out[o++] = ex * M.w21[k] + ey * M.w22[k];
    if (M.hasD[k]) out[o++] = (Math.log(OD) - M.ld[k]) / lrs;
  }
  return priorRows(M, PC, p, out, o);
}

/** LM problem over the free parameters of one start (focal component, τ mode). */
function makeProblem(M, PC, pFull, free) {
  const nf = free.length, m = M.nData + priorCount(M, PC);
  const fullOf = x => { const p = Float64Array.from(pFull); for (let j = 0; j < nf; j++) p[free[j]] = x[j]; return p; };
  const cache = [];
  const span = p => nodesFor(M.grid, warp(M, p, M.tMax) + 2 * M.grid.h);
  const base = p => {
    const N = span(p);
    for (const c of cache) if (c.N >= N && c.k[0] === p[LS0] && c.k[1] === p[ELEV] && c.k[2] === p[CL] && c.k[3] === p[TILT] && c.k[4] === p[CD]) return c;
    const c = cache.length < 2 ? { k: new Float64Array(5) } : cache.shift();
    const t = trajOf(M, p, N, c.buf);
    c.N = t.N; c.buf = t.buf; c.k[0] = p[LS0]; c.k[1] = p[ELEV]; c.k[2] = p[CL]; c.k[3] = p[TILT]; c.k[4] = p[CD];
    cache.push(c);
    return c;
  };
  const residuals = x => { const p = fullOf(x); return rows(M, PC, p, base(p), new Float64Array(m)); };
  const scratch = new Float64Array(m), fdBufs = [];
  const jacobian = (x, r) => {
    const p = fullOf(x), bt = base(p), J = new Float64Array(m * nf);
    for (let j = 0; j < nf; j++) {
      const k = free[j], h = FD[k], pj = Float64Array.from(p);
      pj[k] += h;
      let tj = bt;
      if (IS_DYN[k]) { tj = trajOf(M, pj, bt.N, fdBufs[j]); fdBufs[j] = tj.buf; }
      rows(M, PC, pj, tj, scratch);
      for (let i = 0; i < m; i++) J[i * nf + j] = (scratch[i] - r[i]) / h;
    }
    return J;
  };
  // k1 (ultra-wide only) is barrel or corrected (fit.k1Max): a pincushion k1 lets the focal mixture chase correlated
  // detection errors with τ about 2× off (checker easy-09: 0.5x lens, k1 +0.11, τ 8.6 vs 4).
  const lower = free.map(k => k === LF ? Math.log(0.2 * M.fNom) : LO[k]), upper = free.map(k => k === LF ? Math.log(5 * M.fNom) : k === K1 ? Math.min(HI[k], M.P.fit.k1Max) : HI[k]);
  return { residuals, jacobian, fullOf, m, nf, lower, upper };
}

const freeFor = (M, PC) => { const f = []; for (let k = 0; k < NP; k++) if ((k !== K1 || PC.comp.k1Free) && (k !== LTAU2 || M.ramp)) f.push(k); return f; };

/** One LM run from full parameters p0 for start PC. Returns {p, cost, map, converged, iters, JtJ, free, PC}. */
function runLM(M, PC, p0, maxIter, jtj) {
  const fp = M.P.fit, free = freeFor(M, PC), pr = makeProblem(M, PC, p0, free);
  const x0 = free.map(k => p0[k]);
  const res = levenbergMarquardt(pr.residuals, x0, {
    jacobian: pr.jacobian, maxIter, huberDelta: fp.huberSigmas, robustRows: M.nData, lower: pr.lower, upper: pr.upper, jtj, tol: 1e-7
  });
  const p = pr.fullOf(res.x);
  return { p, cost: res.cost, map: res.cost + PC.mode.pen + PC.comp.pen, converged: res.converged, iters: res.iters, JtJ: res.JtJ, free, PC, r: res.r, weights: res.weights };
}

/** Per-observation whitened residual norms (2D) at full parameters p for observation indices idx. */
function obsNorms(M, p, idx) {
  const N = nodesFor(M.grid, warp(M, p, idx.length ? M.t[idx[idx.length - 1]] : M.t0) + 2 * M.grid.h);
  const tr = trajOf(M, p, N), G = geometry(M, p[LF], p[PITCH], p[ROLL], p[K1], {}), cb = Math.cos(p[AZIM]), sb = Math.sin(p[AZIM]);
  const out = new Float64Array(idx.length);
  for (let a = 0; a < idx.length; a++) {
    const k = idx[a];
    hermite(M.grid, tr.buf, tr.N, warp(M, p, M.t[k]), false);
    if (!projectCanon(M, G, cb, sb, PX, PY, PZ)) { out[a] = BIG; continue; }
    const ex = OX - M.x[k], ey = OY - M.y[k], r1 = ex * M.w11[k], r2 = ex * M.w21[k] + ey * M.w22[k];
    out[a] = Math.sqrt(r1 * r1 + r2 * r2);
  }
  return out;
}
const median = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };
/** Robust scale of 2D normalized residual norms (median of a unit 2D Gaussian norm is √(2 ln 2)), at least 1. */
const robustScale = norms => Math.max(1, median(norms) / Math.sqrt(2 * Math.LN2));

/* ------------------------------------------------------------------ initialization */

/** Azimuths β whose projected launch direction at the address matches the image direction (local minima). */
function launchAzimuths(M, G, el, dir) {
  const ce = Math.cos(el), se = Math.sin(el), out = [], err = [];
  const n = 72;
  for (let i = 0; i < n; i++) {
    const b = -Math.PI + 2 * Math.PI * i / n;
    err.push(dirError(G, ce * Math.sin(b), se, ce * Math.cos(b), dir));
  }
  for (let i = 0; i < n; i++) {
    const a = err[(i + n - 1) % n], c = err[i], d = err[(i + 1) % n];
    if (c <= a && c <= d && c < 0.5) {
      const den = a - 2 * c + d, off = den > 1e-12 ? 0.5 * (a - d) / den : 0;
      out.push(-Math.PI + 2 * Math.PI * (i + Math.max(-0.5, Math.min(0.5, off))) / n);
    }
  }
  return out.length ? out : [Math.atan2(dir.x, 1)];
}
function dirError(G, ux, uy, uz, dir) {
  const ur = ux * G.rx + uy * G.ry + uz * G.rz, ud = ux * G.dx + uy * G.dy + uz * G.dz, uf = uy * G.fy + uz * G.fz;
  const ix = ur - G.xnA * uf, iy = ud - G.ynA * uf, n = Math.hypot(ix, iy);
  if (!(n > 1e-12)) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (ix * dir.x + iy * dir.y) / n)));
}

/** Image launch direction: the launch candidate's, else address -> early observations. */
function launchDir(M, ctx) {
  const d = ctx.launch.dir;
  if (d && Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-2) return d;
  const k = M.active[Math.min(2, M.active.length - 1)];
  const dx = M.x[k] - M.ax, dy = M.y[k] - M.ay, n = Math.hypot(dx, dy) || 1;
  return { x: dx / n, y: dy / n };
}

/** D1 linear start: V0 from ray constraints (P_A + V·t + ½g·t²) ∥ ray on early observations, plus sizes. */
function linearStart(M, G, tau) {
  const act = M.active, rowsA = [], rhs = [];
  const g = M.g, lrs = M.P.fit.logRadiusSigma;
  for (let a = 0; a < act.length && rowsA.length < 30; a++) {
    const k = act[a], t = (M.t[k] - M.t0) / tau;
    if (t > 0.6 && rowsA.length >= 8) break;
    const [xn, yn] = undistort((M.x[k] - M.cx) / G.f, (M.y[k] - M.cy) / G.f, G.k1);
    let rx = xn * G.rx + yn * G.dx, ry = xn * G.ry + yn * G.dy + G.fy, rz = xn * G.rz + yn * G.dz + G.fz;
    const rn = Math.hypot(rx, ry, rz); rx /= rn; ry /= rn; rz /= rn;
    let e1 = [rz, 0, -rx]; const e1n = Math.hypot(e1[0], e1[2]) || 1; e1 = [e1[0] / e1n, 0, e1[2] / e1n];
    const e2 = [ry * e1[2] - rz * e1[1], rz * e1[0] - rx * e1[2], rx * e1[1] - ry * e1[0]];
    const B = [G.PAx, G.PAy - 0.5 * g * t * t, G.PAz], wpos = G.f / (M.sig[k] * G.Z0);
    for (const e of [e1, e2]) { rowsA.push([e[0] * t * wpos, e[1] * t * wpos, e[2] * t * wpos]); rhs.push(-(e[0] * B[0] + e[1] * B[1] + e[2] * B[2]) * wpos); }
    if (M.hasD[k]) {
      const Z = G.f * M.D / Math.exp(M.ld[k]), wz = 1 / (Z * lrs);
      rowsA.push([0, G.fy * t * wz, G.fz * t * wz]); rhs.push((Z - (G.fy * B[1] + G.fz * B[2])) * wz);
    }
  }
  if (rowsA.length < 3) return null;
  const A = new Float64Array(9), b = new Float64Array(3);
  rowsA.forEach((r, i) => { for (let a = 0; a < 3; a++) { b[a] += r[a] * rhs[i]; for (let c = 0; c < 3; c++) A[a * 3 + c] += r[a] * r[c]; } });
  const ridge = 1e-6 * (A[0] + A[4] + A[8]) + 1e-12;
  for (let a = 0; a < 3; a++) A[a * 4] += ridge;
  const v = solveSPD(A, b, 3);
  if (!v) return null;
  const s = Math.hypot(v[0], v[1], v[2]);
  if (!(s > 3 && s < 110)) return null;
  return { s0: s, el: Math.max(-25 * DEG, Math.min(80 * DEG, Math.asin(v[1] / s))), beta: Math.atan2(v[0], v[2]) };
}

/** D3 §5.2 grid scored by truncated MAP cost on a subset of observations (no LM), plus the linear starts. */
function gridCandidates(M, ctx, comps, modes) {
  const fp = M.P.fit, act = M.active, n = act.length, K = Math.min(n, 32);
  const sub = Int32Array.from({ length: K }, (_, i) => act[K > 1 ? Math.round(i * (n - 1) / (K - 1)) : 0]);
  const scale = n / K, dir = launchDir(M, ctx);
  const tauMin = Math.min(...modes.map(m => m.tau)), N = nodesFor(M.grid, (M.tMax - M.t0) / tauMin + 0.05);
  const sq = v => v * v, cands = [];
  const prior = (s0, el, pitch, f) => sq((Math.log(s0) - Math.log(fp.speedMps[0])) / fp.speedMps[1]) + sq((el - fp.elevationDeg[0] * DEG) / (fp.elevationDeg[1] * DEG)) + sq((pitch - pitchMu(M, f)) / M.pitchSig);
  const score = (traj, G, beta, md) => {
    const cb = Math.cos(beta), sb = Math.sin(beta);
    let c2 = 0;
    for (const k of sub) {
      hermite(M.grid, traj, N, (M.t[k] - M.t0) / md.tau, false);
      if (!projectCanon(M, G, cb, sb, PX, PY, PZ)) { c2 += GRID_TRUNC; continue; }
      const ex = OX - M.x[k], ey = OY - M.y[k], r1 = ex * M.w11[k], r2 = ex * M.w21[k] + ey * M.w22[k];
      c2 += Math.min(r1 * r1 + r2 * r2, GRID_TRUNC);
    }
    return c2 * scale;
  };
  // Pitch starts: the horizon's pitch, else the generic prior ±1σ, lifted to a sky line's lower bound.
  const muOf = c => Math.max(pitchMu(M, c.f), skyPitch(M, c.f, M.rollMu));
  const pitches = c => { const mu = pitchMu(M, c.f), lo = skyPitch(M, c.f, M.rollMu); return M.horizon ? [mu] : [...new Set([mu - M.pitchSig, mu, mu + M.pitchSig].map(v => Math.max(v, lo)))]; };
  const geoms = comps.map(c => pitches(c).map(pitch => ({ pitch, G: geometry(M, Math.log(c.f), pitch, M.rollMu, c.k1Free ? fp.k1Prior[0] : 0, {}) })));
  for (const elD of fp.gridElevationDeg) {
    const el = elD * DEG, az = geoms.map(gs => gs.map(({ G }) => launchAzimuths(M, G, el, dir)));
    for (const s0 of fp.gridSpeedMps) {
      const traj = integrate(M, s0, el, fp.cl[0], 0, fp.cd[0], N);
      comps.forEach((c, ci) => geoms[ci].forEach(({ pitch, G }, gi) => {
        const pr = prior(s0, el, pitch, c.f);
        for (const b0 of az[ci][gi]) for (const db of fp.gridAzimuthDeg) {
          const beta = b0 + db * DEG;
          for (const md of modes) cands.push({ score: score(traj, G, beta, md) + pr + md.pen + c.pen, s0, el, beta, pitch, comp: c, mode: md });
        }
      }));
    }
  }
  const main = comps.reduce((a, b) => b.w > a.w ? b : a);
  const Gm = geoms[comps.indexOf(main)].find(g => g.pitch === muOf(main)) ?? geoms[comps.indexOf(main)][0];
  for (const md of modes) {
    const ls = linearStart(M, Gm.G, md.tau);
    if (!ls) continue;
    const traj = integrate(M, ls.s0, ls.el, fp.cl[0], 0, fp.cd[0], N);
    cands.push({ score: score(traj, Gm.G, ls.beta, md) + prior(ls.s0, ls.el, Gm.pitch, main.f) + md.pen + main.pen, s0: ls.s0, el: ls.el, beta: ls.beta, pitch: Gm.pitch, comp: main, mode: md, linear: true });
  }
  return cands.sort((a, b) => a.score - b.score);
}

function startParams(M, c) {
  const fp = M.P.fit, p = new Float64Array(NP);
  p[LF] = Math.log(c.comp.f); p[PITCH] = c.pitch; p[ROLL] = M.rollMu; p[LS0] = Math.log(c.s0); p[ELEV] = c.el; p[AZIM] = c.beta;
  p[CL] = fp.cl[0]; p[TILT] = 0; p[CD] = fp.cd[0]; p[LTAU] = Math.log(c.mode.tau); p[K1] = c.comp.k1Free ? fp.k1Prior[0] : 0; p[LTAU2] = p[LTAU];
  return p;
}

/** Thin the active set to at most THIN observations (always keeping the first and last). */
function thinned(M, idx) {
  if (idx.length <= THIN) return idx;
  const out = new Int32Array(THIN);
  for (let i = 0; i < THIN; i++) out[i] = idx[Math.round(i * (idx.length - 1) / (THIN - 1))];
  return out;
}

/** Multi-start: grid → best starts (top by MAP + best per τ mode and focal component) → LM with early abandon. */
function multiStart(M, ctx, comps, modes, signal) {
  const fp = M.P.fit, all = M.active;
  setActive(M, thinned(M, all));
  const cands = gridCandidates(M, ctx, comps, modes), picked = [];
  const add = c => { if (c && !picked.includes(c)) picked.push(c); };
  cands.slice(0, fp.topStarts).forEach(add);
  for (const md of modes) add(cands.find(c => c.mode === md));
  for (const cp of comps) add(cands.find(c => c.comp === cp));
  add(cands.find(c => c.linear));
  let runs = [];
  for (const c of picked) {
    throwIfAborted(signal);
    runs.push(runLM(M, { comp: c.comp, mode: c.mode }, startParams(M, c), PHASE1, false));
  }
  const best0 = Math.min(...runs.map(r => r.map));
  runs = runs.filter(r => r.map <= fp.abandonFactor * best0 || r.map === best0);
  const rest = Math.max(0, fp.maxIter - PHASE1);
  runs = runs.map(r => { throwIfAborted(signal); return r.converged || !rest ? r : runLM(M, r.PC, r.p, rest, false); });
  // A run is charged the prior of the τ mode it started from, but the mixture MAP belongs to the mode that explains
  // its fitted τ (a start from τ = 2 that drifts to 3.5 is a τ = 4 solution): re-assign and refit, EM-style.
  runs = runs.map(r => { throwIfAborted(signal); return relabelTau(M, modes, r, Math.max(PHASE1, rest)); });
  runs.sort((a, b) => a.map - b.map);
  setActive(M, all);
  return { best: runs[0], starts: picked.length, survivors: runs.length, survivorModes: [...new Set(runs.map(r => r.PC.mode.tau))] };
}

/** The τ mode whose prior term (z² + mixture-weight penalty) is cheapest at log τ = lt. */
function tauModeAt(M, modes, lt) {
  const s = M.P.fit.tauLogSigma;
  let best = modes[0], bc = Infinity;
  for (const md of modes) { const z = (lt - Math.log(md.tau)) / s, c = z * z + md.pen; if (c < bc) { bc = c; best = md; } }
  return best;
}

/** Refit run r under the τ mode that explains its fitted τ (no-op when that is its own mode). Its MAP can only drop. */
function relabelTau(M, modes, r, maxIter) {
  const md = tauModeAt(M, modes, r.p[LTAU]);
  return md === r.PC.mode ? r : runLM(M, { comp: r.PC.comp, mode: md }, r.p, maxIter, false);
}

/* ------------------------------------------------------------------ robust passes */

/** Reject > outlierSigmas (robust scale), then one refit; returns the refit and the inlier index set. */
function outlierPass(M, run, maxIter) {
  const fp = M.P.fit, base = M.base;
  const norms = obsNorms(M, run.p, base), s = robustScale(norms);
  const keep = [];
  for (let a = 0; a < base.length; a++) if (norms[a] <= fp.outlierSigmas * s) keep.push(base[a]);
  if (keep.length === base.length || keep.length < 2) { setActive(M, base); return runLM(M, run.PC, run.p, maxIter, true); }
  setActive(M, Int32Array.from(keep));
  return runLM(M, run.PC, run.p, maxIter, true);
}

function finalMask(M, p) {
  const fp = M.P.fit, base = M.base, norms = obsNorms(M, p, base);
  const inl = [];
  for (let a = 0; a < base.length; a++) if (norms[a] <= fp.outlierSigmas) inl.push(norms[a]);
  const s = robustScale(inl.length ? inl : norms), mask = new Uint8Array(M.n);
  for (let a = 0; a < base.length; a++) if (norms[a] <= fp.outlierSigmas * s) mask[base[a]] = 1;
  return { mask, norms, scale: s };
}

/**
 * RANSAC re-initialization (D3 §5.2): fit the first 4 + 4 random inliers, keep the largest consensus, then a fresh
 * multi-start on that consensus: the trials' local refits inherit the contaminated start's τ mode and focal component,
 * which a local LM cannot leave once τ is tied to its mode (fit.tauLogSigma).
 */
function ransac(M, run, signal, ctx, comps, modes) {
  const r0 = ransacTrials(M, run, signal), keep = M.active;
  const ms = multiStart(M, ctx, comps, modes, signal);
  setActive(M, keep);
  const r1 = runLM(M, ms.best.PC, ms.best.p, M.P.fit.maxIter, true);
  return r1.map < r0.map ? r1 : r0;
}

function ransacTrials(M, run, signal) {
  const fp = M.P.fit, base = M.base;
  let seed = 0x9e3779b9 ^ base.length, best = null;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  for (let trial = 0; trial < RANSAC_TRIALS; trial++) {
    throwIfAborted(signal);
    const pick = new Set(Array.from(base.slice(0, fp.ransacFirst)));
    for (let tries = 0; pick.size < Math.min(base.length, fp.ransacFirst + fp.ransacRandom) && tries < 100; tries++) pick.add(base[Math.floor(rnd() * base.length)]);
    setActive(M, Int32Array.from([...pick].sort((a, b) => M.t[a] - M.t[b])));
    const r = runLM(M, run.PC, run.p, 15, false);
    const norms = obsNorms(M, r.p, base);
    let count = 0;
    for (const v of norms) if (v <= fp.outlierSigmas) count++;
    if (!best || count > best.count) best = { count, r, norms };
  }
  const keep = [];
  best.norms.forEach((v, a) => { if (v <= fp.outlierSigmas) keep.push(base[a]); });
  setActive(M, keep.length >= 2 ? Int32Array.from(keep) : base);
  return runLM(M, best.r.PC, best.r.p, fp.maxIter, true);
}

/* ------------------------------------------------------------------ speed ramps */

/**
 * iPhone-style speed ramps: the video clock changes its rate while the ball flies, which a single τ cannot follow.
 * Scans split times between rampMinObs observations on each side, refits M3D with τ2 after the split, and reports a
 * ramp when the split model wins by the BIC margin and τ changes by at least rampMinRatio.
 * @returns {{ramp:boolean, tSplit:number|null, tau:[number, number]|null}}
 */
export function detectSpeedRamp(obs, ctx, { fit, signal } = {}) {
  const P = ctx.params ?? PARAMS, fp = P.fit;
  // Forward validation may have replaced a poor single-τ M3D by the image model: scan the M3D it carries.
  const m3dOf = f => (f?.kind === 'm3d' ? f : f?.m3d ?? null);
  const base = m3dOf(fit)?._state?.run ? m3dOf(fit) : m3dOf(fitFlight(obs, ctx, { signal, noRamp: true }));
  const st = base?._state;
  if (!st || base.kind !== 'm3d') return { ramp: false, tSplit: null, tau: null };
  if (base.ramp) return { ramp: true, tSplit: base.ramp.tSplit, tau: [...base.ramp.tau] };
  // Scan every inlier-flagged observation: a single τ rejects the far side of a ramp as outliers.
  const keep = st.M.active;
  setActive(st.M, st.M.base);
  let r;
  try { r = scanRamp(st.M, st.run, signal); } finally { setActive(st.M, keep); }
  return r ? { ramp: true, tSplit: r.tSplit, tau: [Math.exp(r.run.p[LTAU]), Math.exp(r.run.p[LTAU2])] } : { ramp: false, tSplit: null, tau: null };
}

/** The LM objective (Huber data rows + prior rows) at full parameters p on the current active set. */
function costAt(M, PC, p) {
  const fp = M.P.fit, free = freeFor(M, PC), pr = makeProblem(M, PC, p, free), r = pr.residuals(Float64Array.from(free, k => p[k]));
  let c = 0;
  for (let i = 0; i < r.length; i++) c += i < M.nData ? huber(r[i], fp.huberSigmas) : r[i] * r[i];
  return c;
}

function scanRamp(M, run, signal) {
  const fp = M.P.fit, all = M.active, mo = fp.rampMinObs;
  if (all.length < 2 * mo || M.ramp) return null;
  setActive(M, thinned(M, all));
  const act = M.active, n = act.length;
  const sp = (a, b) => Math.hypot(M.x[act[b]] - M.x[act[a]], M.y[act[b]] - M.y[act[a]]) / (M.t[act[b]] - M.t[act[a]]);
  const tau1 = Math.exp(run.p[LTAU]);
  // One split: τ2 starts from the speed change across the split (the single-τ model has none there).
  // The single τ is a compromise between τ1 and τ2: start both from it, centred geometrically, and from (τ, τ·r).
  const trySplit = (tS, from) => {
    let j = 1;
    while (j < n - 1 && M.t[act[j]] < tS) j++;
    const vb = sp(Math.max(0, j - mo), Math.max(1, j - 1)), va = sp(Math.min(n - 2, j), Math.min(n - 1, j + mo - 1));
    const ratio = va > 0 && vb > 0 ? vb / va : 1;
    let best = null;
    const starts = from ? [[from[LTAU], from[LTAU2]]] : [[Math.log(tau1 / Math.sqrt(ratio)), Math.log(tau1 * Math.sqrt(ratio))], [Math.log(tau1), Math.log(tau1 * ratio)]];
    for (const [l1, l2] of starts) {
      M.ramp = { tSplit: tS, tau2Prior: Math.exp(l2) };
      const p0 = Float64Array.from(from ?? run.p);
      p0[LTAU] = l1; p0[LTAU2] = l2;
      const r = runLM(M, run.PC, p0, 12, false);
      if (!best || r.cost < best.run.cost) best = { run: r, tSplit: tS, tau2Prior: Math.exp(l2) };
    }
    M.ramp = null;
    return best;
  };
  const nC = Math.min(12, n - 2 * mo + 1), splits = [], mid = j => 0.5 * (M.t[act[j - 1]] + M.t[act[j]]);
  for (let c = 0; c < nC; c++) splits.push(mid(mo + Math.round(c * (n - 2 * mo) / Math.max(1, nC - 1))));
  // Plus the three sharpest local speed jumps between adjacent windows of rampMinObs (a ramp is such a jump).
  const jumps = [];
  for (let j = mo; j <= n - mo; j++) { const a = sp(j - mo, j - 1), b = sp(j, Math.min(n - 1, j + mo - 1)); if (a > 0 && b > 0) jumps.push([Math.abs(Math.log(b / a)), j]); }
  jumps.sort((a, b) => b[0] - a[0]);
  const taken = [];
  for (const [, j] of jumps) { if (taken.length >= 3) break; if (taken.every(k => Math.abs(k - j) >= mo)) { taken.push(j); splits.push(mid(j)); } }
  splits.sort((a, b) => a - b);
  let best = null, bi = 0;
  [...new Set(splits)].forEach((tS, i) => { throwIfAborted(signal); const r = trySplit(tS); if (!best || r.run.cost < best.run.cost) { best = r; bi = i; } });
  // Golden-section refinement of the split time between the neighbouring candidates.
  const u = [...new Set(splits)];
  let a = u[Math.max(0, bi - 1)], b = u[Math.min(u.length - 1, bi + 1)];
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = b - phi * (b - a), x2 = a + phi * (b - a), r1 = trySplit(x1, best.run.p), r2 = trySplit(x2, best.run.p);
  for (let it = 0; it < 5; it++) {
    throwIfAborted(signal);
    if (r1.run.cost < r2.run.cost) { b = x2; x2 = x1; r2 = r1; x1 = b - phi * (b - a); r1 = trySplit(x1, best.run.p); }
    else { a = x1; x1 = x2; r1 = r2; x2 = a + phi * (b - a); r2 = trySplit(x2, best.run.p); }
  }
  for (const r of [r1, r2]) if (r.run.cost < best.run.cost) best = r;
  setActive(M, all);
  const bic = 2 * Math.log(Math.max(2, M.nData)), lr = Math.abs(best.run.p[LTAU2] - best.run.p[LTAU]);
  // Compare on the full set: the single-τ model against the split model.
  M.ramp = { tSplit: best.tSplit, tau2Prior: best.tau2Prior };
  const costRamp = costAt(M, best.run.PC, best.run.p);
  M.ramp = null;
  const costSingle = costAt(M, run.PC, run.p);
  return costSingle - costRamp > bic && lr >= Math.log(fp.rampMinRatio) ? best : null;
}

/** Longest run of consecutive base observations the fit rejects. */
function longestRejectedRun(M, mask) {
  let run = 0, best = 0;
  for (const k of M.base) { run = mask[k] ? 0 : run + 1; best = Math.max(best, run); }
  return best;
}

/* ------------------------------------------------------------------ predictions */

/** Laplace predictor over the fitted parameters: base and finite-difference trajectories, extended on demand. */
function makePredictor(M, run, cov) {
  const fp = M.P.fit, cp = M.P.complete, p = run.p, free = run.free, nf = free.length;
  const G0 = geometry(M, p[LF], p[PITCH], p[ROLL], p[K1], {});
  const geo = free.map(k => (k === LF || k === PITCH || k === ROLL || k === K1) ? (() => { const q = Float64Array.from(p); q[k] += FD[k]; return geometry(M, q[LF], q[PITCH], q[ROLL], q[K1], {}); })() : null);
  const capReal = cp.capRealSec, maxSpan = 4 * capReal + 1;   // beyond this the model holds its last state
  let span = 0, fdSpan = 0, full = false, base = null, fdT = [];
  const grow = (tr, have) => nodesFor(M.grid, Math.min(maxSpan, Math.max(tr + 0.25, have * 2, (M.tMax - M.t0) / Math.exp(p[LTAU]) + 1)));
  const ensure = tr => {
    if (base && (tr <= span || full)) return;
    const N = grow(tr, span);
    base = trajOf(M, p, N); span = nodeTime(M.grid, N - 3); full = span >= maxSpan - 2 * M.grid.h;
  };
  const ensureFD = tr => {
    ensure(tr);
    if (fdT.length && fdSpan >= span) return;
    const N = base.N;
    fdT = free.map(k => { if (!IS_DYN[k]) return null; const q = Float64Array.from(p); q[k] += FD[k]; return trajOf(M, q, N); });
    fdSpan = span;
  };
  const cb0 = Math.cos(p[AZIM]), sb0 = Math.sin(p[AZIM]);
  const posAt = (traj, G, cb, sb, tr) => { hermite(M.grid, traj.buf, traj.N, Math.min(tr, span), false); return projectCanon(M, G, cb, sb, PX, PY, PZ); };
  const at = t => {
    if (t <= M.t0) return { x: M.ax, y: M.ay };
    const tr = warp(M, p, t);
    ensure(tr);
    return posAt(base, G0, cb0, sb0, tr) ? { x: OX, y: OY } : { x: NaN, y: NaN };
  };
  const predict = t => {
    if (t <= M.t0) return { t, x: M.ax, y: M.ay, cov: [0, 0, 0], d: M.d0, h: 0 };
    const tr = warp(M, p, t);
    ensureFD(tr);
    if (!posAt(base, G0, cb0, sb0, tr)) return { t, x: NaN, y: NaN, cov: [Infinity, 0, Infinity], d: M.d0, h: PY };
    const x = OX, y = OY, d = OD, h = PY, jx = new Float64Array(nf), jy = new Float64Array(nf);
    for (let j = 0; j < nf; j++) {
      const k = free[j], hstep = FD[k];
      let ok;
      if (IS_DYN[k]) ok = posAt(fdT[j], G0, cb0, sb0, tr);
      else if (geo[j]) ok = posAt(base, geo[j], cb0, sb0, tr);
      else if (k === AZIM) ok = posAt(base, G0, Math.cos(p[AZIM] + hstep), Math.sin(p[AZIM] + hstep), tr);
      else { const q = Float64Array.from(p); q[k] += hstep; ok = posAt(base, G0, cb0, sb0, warp(M, q, t)); }
      if (ok) { jx[j] = (OX - x) / hstep; jy[j] = (OY - y) / hstep; }
    }
    let sxx = 0, sxy = 0, syy = 0;
    if (cov) for (let a = 0; a < nf; a++) {
      let cx = 0, cy = 0;
      for (let b = 0; b < nf; b++) { const c = cov[a * nf + b]; cx += c * jx[b]; cy += c * jy[b]; }
      sxx += jx[a] * cx; sxy += jx[a] * cy; syy += jy[a] * cy;
    }
    const out = { t, x, y, cov: [sxx, sxy, syy], d: Math.max(d, 1e-3), h };
    Object.defineProperty(out, 'jx', { value: jx }); Object.defineProperty(out, 'jy', { value: jy });
    return out;
  };
  const velocity = t => { const e = 1e-3 * Math.max(Math.exp(p[LTAU]), 1e-3), a = at(t - e), b = at(t + e); return { x: (b.x - a.x) / (2 * e), y: (b.y - a.y) / (2 * e) }; };
  // Landing-point covariance: the position Jacobian at t_L plus the image velocity times dt_L/dp, where
  // dt_L/dp = −(∂H/∂p)/(∂H/∂t) for H(t, p) = height above the address plane at video time t.
  const landingCov = tL => {
    if (tL == null || !cov) return null;
    const q = predict(tL);
    if (!Number.isFinite(q.x)) return null;
    const tr = warp(M, p, tL);
    ensureFD(tr);
    hermite(M.grid, base.buf, base.N, tr, true);
    const h0 = PY, dHdt = VY / Math.exp(M.ramp && tL > M.ramp.tSplit ? p[LTAU2] : p[LTAU]);
    if (!(dHdt < 0)) return null;
    const v = velocity(tL), jx = new Float64Array(nf), jy = new Float64Array(nf);
    for (let j = 0; j < nf; j++) {
      const k = free[j], hs = FD[k];
      let dH = 0;
      if (IS_DYN[k]) { hermite(M.grid, fdT[j].buf, fdT[j].N, tr, false); dH = (PY - h0) / hs; }
      else if (k === LTAU || k === LTAU2) { const qq = Float64Array.from(p); qq[k] += hs; hermite(M.grid, base.buf, base.N, warp(M, qq, tL), false); dH = (PY - h0) / hs; }
      const dt = -dH / dHdt;
      jx[j] = q.jx[j] + v.x * dt; jy[j] = q.jy[j] + v.y * dt;
    }
    let sxx = 0, sxy = 0, syy = 0;
    for (let a = 0; a < nf; a++) {
      let cx = 0, cy = 0;
      for (let b = 0; b < nf; b++) { const c = cov[a * nf + b]; cx += c * jx[b]; cy += c * jy[b]; }
      sxx += jx[a] * cx; sxy += jx[a] * cy; syy += jy[a] * cy;
    }
    return [sxx, sxy, syy];
  };
  // Landing: height back below the address plane after the apex (D3 §5.1).
  const landing = () => {
    ensure(capReal);
    const N = base.N, buf = base.buf;
    let apex = 0;
    for (let i = 1; i < N - 2; i++) {
      if (buf[6 * i + 1] > buf[6 * apex + 1]) apex = i;
      if (i > apex && buf[6 * i + 1] < 0 && buf[6 * i + 4] < 0) {
        let lo = nodeTime(M.grid, i - 1), hi = nodeTime(M.grid, i);
        for (let it = 0; it < 40; it++) { const mid = 0.5 * (lo + hi); hermite(M.grid, buf, N, mid, false); if (PY < 0) hi = mid; else lo = mid; }
        return unwarp(M, p, hi);
      }
      if (nodeTime(M.grid, i) > capReal) break;
    }
    return null;
  };
  return { at, predict, velocity, landing, landingCov };
}

/* ------------------------------------------------------------------ assembling a FlightFit */

function viewOf(M, p) {
  const G = geometry(M, p[LF], p[PITCH], p[ROLL], p[K1], {});
  const rel = Math.atan2(Math.sin(p[AZIM] - Math.atan2(G.PAx, G.PAz)), Math.cos(p[AZIM] - Math.atan2(G.PAx, G.PAz)));
  const lim = M.P.fit.dtlAzimuthDeg * DEG;
  return Math.abs(rel) < lim || Math.abs(rel) > Math.PI - lim ? 'dtl' : 'fo';
}

function priorZ(M, PC, p) {
  const out = priorRows(M, PC, p, new Float64Array(priorCount(M, PC)), 0);
  let z = 0;
  for (const v of out) z = Math.max(z, Math.abs(v));
  return z;
}

/** Prior rows by name with |z| above fit.r2MaxPriorZ: diagnostics only (priors are soft terms, never a gate). */
function priorConflict(M, PC, p) {
  const out = priorRows(M, PC, p, new Float64Array(priorCount(M, PC)), 0), names = priorNames(M, PC), lim = M.P.fit.r2MaxPriorZ, c = {};
  out.forEach((v, i) => { if (Math.abs(v) > lim) c[names[i]] = +v.toFixed(2); });
  return c;
}

/**
 * Effective number of parameters the data fix in this MAP fit: trace((JᵀWJ + H_prior)⁻¹·JᵀWJ) = n_free −
 * trace(C·H_prior), C the Laplace covariance (run.JtJ includes the prior rows). It never exceeds the data rows, so a
 * 3-frame track is not charged for the 10 parameters its priors pin.
 */
function effectiveParams(M, run) {
  const n = run.free.length, C = run.JtJ ? invertSPD(run.JtJ, n) : null;
  if (!C) return Math.min(n, M.nData);
  const PC = run.PC, m = priorCount(M, PC), base = priorRows(M, PC, run.p, new Float64Array(m), 0), Jp = new Float64Array(m * n);
  for (let j = 0; j < n; j++) {
    const k = run.free[j], q = Float64Array.from(run.p);
    q[k] += FD[k];
    const r = priorRows(M, PC, q, new Float64Array(m), 0);
    for (let i = 0; i < m; i++) Jp[i * n + j] = (r[i] - base[i]) / FD[k];
  }
  let tr = 0;
  for (let i = 0; i < m; i++) for (let a = 0; a < n; a++) { let s = 0; for (let b = 0; b < n; b++) s += C[a * n + b] * Jp[i * n + b]; tr += Jp[i * n + a] * s; }
  return Math.max(0, Math.min(n - tr, M.nData));
}

/** Wilson-Hilferty χ² quantile for k degrees of freedom at the one-sided normal quantile z. */
const chi2Quantile = (k, z) => k * Math.pow(1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k)), 3);

/**
 * R2 data fit of a run on the current active set (D3 §6 'normalized RMS', made robust and dof-aware):
 *   chi2Dof   = Huber cost of the whitened data rows (positions and log-radii) / dof; prior rows are excluded;
 *   dof       = data rows − effectiveParams (>= 1);
 *   chi2Limit = max(fit.r2MaxRmsNorm², χ²_{1−α}(dof)/dof), α from fit.r2Chi2Z: a fit fails R2 only when its residual
 *               excess is beyond the model-adequacy limit AND significant, so a track too short to test ballistics
 *               (a face-on exit after 2-3 frames) is not rejected by chance. From about 21 dof on it is the D3 limit.
 */
function dataFit(M, run) {
  const fp = M.P.fit, r = makeProblem(M, run.PC, run.p, run.free).residuals(Float64Array.from(run.free, k => run.p[k]));
  let c = 0;
  for (let i = 0; i < M.nData; i++) c += huber(r[i], fp.huberSigmas);
  const dof = Math.max(1, M.nData - effectiveParams(M, run));
  return { chi2Dof: c / dof, dof, chi2Limit: Math.max(fp.r2MaxRmsNorm * fp.r2MaxRmsNorm, chi2Quantile(dof, fp.r2Chi2Z) / dof) };
}

/** Fitted ball physics outside fit.physical (R2 plausibility): names of the offending quantities, [] when plausible. */
function implausible(M, p) {
  const ph = M.P.fit.physical, bad = [];
  const chk = (name, v, [lo, hi]) => { if (!(v >= lo && v <= hi)) bad.push(name); };
  chk('speed', Math.exp(p[LS0]), ph.speedMps); chk('elevation', p[ELEV] / DEG, ph.elevationDeg);
  chk('cd', p[CD], ph.cd); chk('cl', p[CL], ph.cl); chk('tilt', p[TILT] / DEG, ph.spinTiltDeg);
  return bad;
}

function finalize(M, run, mask, extra) {
  const fp = M.P.fit, n = run.free.length;
  let nIn = 0, ss = 0;
  setActive(M, Int32Array.from(M.base.filter(k => mask[k])));
  const norms = obsNorms(M, run.p, M.active);
  for (const v of norms) { ss += v * v; nIn++; }
  const rmsNorm = nIn ? Math.sqrt(ss / (2 * nIn)) : 0;
  let covFree = run.JtJ ? invertSPD(run.JtJ, n) : null;
  if (covFree) { const s = Math.max(1, rmsNorm * rmsNorm); for (let i = 0; i < covFree.length; i++) covFree[i] *= s; }
  const cov = new Float64Array(NP * NP);
  if (covFree) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) cov[run.free[a] * NP + run.free[b]] = covFree[a * n + b];
  const pred = makePredictor(M, run, covFree);
  const tau = Math.exp(run.p[LTAU]);
  const verdict = new WeakMap();
  M.src.forEach((o, i) => { if (o && typeof o === 'object') verdict.set(o, !!mask[i]); });
  const { chi2Dof, dof, chi2Limit } = dataFit(M, run), bad = implausible(M, run.p);
  const fit = {
    kind: 'm3d', params: run.p, names: M3D_PARAM_NAMES, cov: covFree ? cov : null, tau, view: viewOf(M, run.p), rmsNorm,
    inlier: mask, inlierFrac: M.base.length ? nIn / M.base.length : 0, priorZMax: priorZ(M, run.PC, run.p), converged: !!run.converged,
    ill: false, landingT: pred.landing(), landingCov: () => pred.landingCov(fit.landingT),
    chi2Dof, dof, chi2Limit, plausible: !bad.length, implausible: bad,
    predict: pred.predict, sample: ({ t0, t1, dt }) => sampleRange(pred.predict, t0, t1, dt),
    at: pred.at, velocity: pred.velocity, isInlier: o => verdict.get(o),
    ramp: M.ramp ? { tSplit: M.ramp.tSplit, tau: [tau, Math.exp(run.p[LTAU2])] } : null,
    component: run.PC.comp.i, tauMode: run.PC.mode.tau,
    diagnostics: { ...extra, iters: run.iters, cost: run.cost, map: run.map, focal: Math.exp(run.p[LF]), focalRatio: Math.exp(run.p[LF]) / M.fNom, priorConflict: priorConflict(M, run.PC, run.p) },
    _state: { M, run }
  };
  // Ill-conditioned: not converged, data not explained (robust χ²/dof), a prior conflict (the data pull a parameter
  // beyond r2MaxPriorZ), or already uncertain at the last observation. Ill only sends cold fits to forward validation,
  // where held-out data choose M3D or the image model: a prior conflict never vetoes a fit by itself (R2 ignores it).
  const tLast = M.tMax, sLast = sigmaMajor(pred.predict(tLast).cov);
  fit.ill = !fit.converged || chi2Dof > chi2Limit || fit.priorZMax > fp.r2MaxPriorZ || !(sLast <= M.P.complete.fadeStartDiag * M.diag);
  return fit;
}

function sampleRange(predict, t0, t1, dt) {
  const out = [];
  if (!(dt > 0)) throw new HFError('bad-arg', 'sample needs dt > 0');
  for (let i = 0, t = t0; t <= t1 + 1e-9; t = t0 + ++i * dt) out.push(predict(t));
  return out;
}

/* ------------------------------------------------------------------ short-horizon image model (D1 §5.1 M_img) */

/** Per-axis robust quadratic in video time on the trailing observations (2 × imageHorizonRealSec real). */
function fitImageModel(M, idx, tau, mask) {
  const fp = M.P.fit, n = idx.length;
  if (!n) throw new HFError('bad-arg', 'image model needs observations');
  const tL = M.t[idx[n - 1]], win = 2 * fp.imageHorizonRealSec * tau;
  let a0 = n - 1;
  while (a0 > 0 && (tL - M.t[idx[a0 - 1]] <= win || n - a0 < 3)) a0--;
  const use = idx.slice(a0), deg = Math.min(2, use.length - 1);
  const fitAxis = (val, wts) => {
    const k = deg + 1, A = new Float64Array(k * k), b = new Float64Array(k);
    use.forEach((j, i) => {
      const u = M.t[j] - tL, pw = [1, u, u * u].slice(0, k), w = wts[i];
      for (let a = 0; a < k; a++) { b[a] += w * pw[a] * val[j]; for (let c = 0; c < k; c++) A[a * k + c] += w * pw[a] * pw[c]; }
    });
    for (let a = 0; a < k; a++) A[a * k + a] += 1e-12 * (1 + A[a * k + a]);
    return { c: solveSPD(A, b, k) ?? new Float64Array(k), A };
  };
  let w = use.map(j => 1 / (M.sig[j] * M.sig[j])), fx, fy;
  for (let round = 0; round < 3; round++) {
    fx = fitAxis(M.x, w); fy = fitAxis(M.y, w);
    w = use.map(j => {
      const u = M.t[j] - tL, ev = c => c[0] + (c[1] ?? 0) * u + (c[2] ?? 0) * u * u;
      const r = Math.hypot(ev(fx.c) - M.x[j], ev(fy.c) - M.y[j]) / M.sig[j];
      return (r <= fp.huberSigmas ? 1 : fp.huberSigmas / r) / (M.sig[j] * M.sig[j]);
    });
  }
  const k = deg + 1, ev = (c, u) => c[0] + (c[1] ?? 0) * u + (c[2] ?? 0) * u * u;
  let chi = 0;
  use.forEach(j => { const u = M.t[j] - tL; chi += ((ev(fx.c, u) - M.x[j]) ** 2 + (ev(fy.c, u) - M.y[j]) ** 2) / (M.sig[j] * M.sig[j]); });
  const s2 = Math.max(1, use.length > k ? chi / (2 * (use.length - k)) : 1);
  const Cx = invertSPD(fx.A, k), Cy = invertSPD(fy.A, k);
  // Diameters: log-linear trend of measured sizes in the window, else the launch law d0/(1 + c·frames), else d0.
  const ds = use.filter(j => M.hasD[j]);
  let dAt;
  if (ds.length >= 2) {
    let sw = 0, su = 0, sl = 0, suu = 0, sul = 0;
    for (const j of ds) { const u = M.t[j] - tL; sw++; su += u; sl += M.ld[j]; suu += u * u; sul += u * M.ld[j]; }
    const den = sw * suu - su * su, b1 = den > 1e-18 ? (sw * sul - su * sl) / den : 0, b0 = (sl - b1 * su) / sw;
    dAt = t => Math.exp(b0 + Math.min(0, b1) * (t - tL));
  } else dAt = t => M.d0 / Math.max(1, 1 + (M.c ?? 0) * (t - M.t0) * M.fps);
  const pad = c => [c[0], c[1] ?? 0, c[2] ?? 0];
  const params = Float64Array.from([...pad(fx.c), ...pad(fy.c)]), cov = new Float64Array(36);
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) { cov[a * 6 + b] = (Cx?.[a * k + b] ?? 0) * s2; cov[(a + 3) * 6 + b + 3] = (Cy?.[a * k + b] ?? 0) * s2; }
  const predict = t => {
    if (t <= M.t0) return { t, x: M.ax, y: M.ay, cov: [0, 0, 0], d: M.d0, h: null };
    const u = t - tL, pw = [1, u, u * u];
    let vx = 0, vy = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { vx += pw[a] * cov[a * 6 + b] * pw[b]; vy += pw[a] * cov[(a + 3) * 6 + b + 3] * pw[b]; }
    return { t, x: ev(params, u), y: ev(params.subarray(3), u), cov: [vx, 0, vy], d: Math.max(1e-3, dAt(t)), h: null };
  };
  const at = t => { const q = predict(t); return { x: q.x, y: q.y }; };
  return { params, cov, predict, at, tL, window: [M.t[use[0]], tL], s2, velocity: t => ({ x: params[1] + 2 * params[2] * (t - tL), y: params[4] + 2 * params[5] * (t - tL) }) };
}

function imageFit(M, m3d, mask, extra) {
  const idx = Int32Array.from(M.base.filter(k => mask[k]));
  const img = fitImageModel(M, idx, m3d.tau, mask);
  const verdict = new WeakMap();
  M.src.forEach((o, i) => { if (o && typeof o === 'object') verdict.set(o, !!mask[i]); });
  return {
    kind: 'image', params: img.params, names: IMAGE_PARAM_NAMES, cov: img.cov, tau: m3d.tau, view: m3d.view, rmsNorm: Math.sqrt(img.s2),
    inlier: mask, inlierFrac: m3d.inlierFrac, priorZMax: 0, converged: true, ill: true, landingT: null,
    // R2 inputs judge the physics (D3 §6: "the M3D fit"): the χ²/dof and plausibility of the M3D fit this replaced.
    // The image model only draws a short horizon; its local quadratics would absorb any non-ballistic wobble.
    chi2Dof: m3d.chi2Dof, dof: m3d.dof, chi2Limit: m3d.chi2Limit, plausible: m3d.plausible, implausible: m3d.implausible,
    predict: img.predict, sample: ({ t0, t1, dt }) => sampleRange(img.predict, t0, t1, dt), at: img.at, velocity: img.velocity,
    isInlier: o => verdict.get(o), ramp: m3d.ramp, component: m3d.component, tauMode: m3d.tauMode,
    diagnostics: { ...extra, imageWindow: img.window, m3d: { rmsNorm: m3d.rmsNorm, priorZMax: m3d.priorZMax, converged: m3d.converged } },
    _state: null, m3d
  };
}

/** D1 §5.2 forward validation: fit on the first forwardSplit of inliers, score both models on the rest. */
function forwardValidation(M, ctx, comps, modes, fit, signal) {
  const fp = M.P.fit, idx = M.base.filter(k => fit.inlier[k]), n = idx.length;
  if (n < 4) return { pick: 'm3d', m3dScore: null, imageScore: null };
  const cut = Math.min(n - 1, Math.max(3, Math.ceil(fp.forwardSplit * n))), head = Int32Array.from(idx.slice(0, cut)), tail = idx.slice(cut);
  setActive(M, head);
  const ms = multiStart(M, ctx, comps, modes, signal);
  setActive(M, head);
  const m3dHead = runLM(M, ms.best.PC, ms.best.p, fp.maxIter, true);
  const pr = makePredictor(M, m3dHead, null), img = fitImageModel(M, head, Math.exp(m3dHead.p[LTAU]), fit.inlier);
  const score = at => tail.reduce((s, k) => { const q = at(M.t[k]); const r1 = (q.x - M.x[k]) * M.w11[k], r2 = (q.x - M.x[k]) * M.w21[k] + (q.y - M.y[k]) * M.w22[k]; const v = r1 * r1 + r2 * r2; return s + (Number.isFinite(v) ? Math.min(v, 100) : 100); }, 0);
  const m3dScore = score(pr.at), imageScore = score(img.at);
  setActive(M, M.base);
  return { pick: imageScore < m3dScore ? 'image' : 'm3d', m3dScore, imageScore };
}

/* ------------------------------------------------------------------ public API */

/**
 * Robust M3D fit (contract). Uses only observations with flag 'inlier' (after t0); FlightFit.inlier marks, per
 * input observation, those the robust fit kept. predict(t) -> FitPrediction {t, x, y, cov, d, h} in stabilized px.
 * Extra members used inside U5: at(t) -> {x, y}, velocity(t) (px per video s), isInlier(o) (true/false, undefined
 * when the fit never saw o), ramp {tSplit, tau:[τ, τ2]} | null, diagnostics.
 * @param {import('./types.js').Observation[]} obs
 * @param {import('./types.js').FitContext} ctx
 * @param {{warm?:object, signal?:AbortSignal, noRamp?:boolean, forward?:boolean}} [opts]
 * @returns {import('./types.js').FlightFit}
 */
export function fitFlight(obs, ctx, { warm, signal, noRamp = false, forward = true } = {}) {
  const P = ctx.params ?? PARAMS, fp = P.fit, t0 = Date.now();
  throwIfAborted(signal);
  const M = buildModel(obs, ctx, P);
  if (!M.base.length) throw new HFError('bad-arg', 'fitFlight needs at least one inlier observation after t0');
  M.c = ctx.launch.c;
  const comps = focalComponents(M, ctx.meta), modes = tauModes(ctx, P);
  let run, starts = 0, survivors = 0, survivorModes = [], path = 'cold';
  const ws = warm?._state;
  if (ws && warm.kind === 'm3d' && ws.M.W === M.W && ws.M.H === M.H) {
    if (ws.M.ramp) M.ramp = { ...ws.M.ramp };
    const comp = comps.find(c => c.i === ws.run.PC.comp.i) ?? comps[0], mode = modes.find(m => m.tau === ws.run.PC.mode.tau) ?? modes[0];
    run = outlierPass(M, runLM(M, { comp, mode }, ws.run.p, fp.maxIter, false), fp.maxIter);
    path = 'warm';
    if (!run.converged && fitQuality(M, run) > 2 * fp.r2MaxRmsNorm) run = null;
  }
  if (!run) {
    const ms = multiStart(M, ctx, comps, modes, signal);
    starts = ms.starts; survivors = ms.survivors; survivorModes = ms.survivorModes;
    run = outlierPass(M, ms.best, fp.maxIter);
    path = 'cold';
  }
  let { mask } = finalMask(M, run.p);
  let nIn = mask.reduce((s, v) => s + v, 0);
  if (nIn < fp.minInlierFrac * M.base.length && M.base.length >= fp.ransacFirst + fp.ransacRandom) {
    const r = ransac(M, run, signal, ctx, comps, modes), m2 = finalMask(M, r.p), n2 = m2.mask.reduce((s, v) => s + v, 0);
    if (n2 > nIn) { run = r; mask = m2.mask; nIn = n2; path += '+ransac'; }
  }
  // Speed ramp: only when a single τ leaves a poor fit (D3/FINAL: detect, model as piecewise τ, else fade).
  let rampTried = false;
  if (!noRamp && !M.ramp && (fitQuality(M, run) > fp.r2MaxRmsNorm || nIn < fp.r2MinInlierFrac * M.base.length || longestRejectedRun(M, mask) >= fp.rampMinObs)) {
    rampTried = true;
    setActive(M, M.base);
    const r = scanRamp(M, run, signal);
    if (r) {
      // Keep the split only when it explains the track (a ramp that cannot be modelled stays ill and fades).
      const keep = M.active;
      M.ramp = { tSplit: r.tSplit, tau2Prior: r.tau2Prior };
      const rr = outlierPass(M, r.run, fp.maxIter), m2 = finalMask(M, rr.p), n2 = m2.mask.reduce((s, v) => s + v, 0);
      setActive(M, Int32Array.from(M.base.filter(k => m2.mask[k])));
      if (fitQuality(M, rr) <= fp.r2MaxRmsNorm && n2 >= fp.r2MinInlierFrac * M.base.length) { run = rr; mask = m2.mask; path += '+ramp'; }
      else { M.ramp = null; setActive(M, keep); path += '+ramp?'; }
    }
  }
  setActive(M, Int32Array.from(M.base.filter(k => mask[k])));
  if (!M.ramp) run = relabelTau(M, modes, run, fp.maxIter);   // warm and outlier refits can drift to another τ mode too
  run = runLM(M, run.PC, run.p, 4, true);
  let fit = finalize(M, run, mask, { path, starts, survivors, survivorModes, ms: 0, rampTried });
  if (fit.ill && forward && path.startsWith('cold')) {
    const fv = forwardValidation(M, ctx, comps, modes, fit, signal);
    setActive(M, Int32Array.from(M.base.filter(k => mask[k])));
    fit.diagnostics.forward = fv;
    if (fv.pick === 'image') fit = imageFit(M, fit, mask, { ...fit.diagnostics });
  }
  fit.diagnostics.ms = Date.now() - t0;
  return fit;
}

function fitQuality(M, run) {
  const norms = obsNorms(M, run.p, M.active);
  let ss = 0;
  for (const v of norms) ss += v * v;
  return norms.length ? Math.sqrt(ss / (2 * norms.length)) : 0;
}

/** predict(t) plus the 1σ major axis of its Laplace covariance (px). */
export function predictWithSigma(fit, t) {
  const q = fit.predict(t);
  return { ...q, sigma: sigmaMajor(q.cov) };
}

/**
 * World states of the M3D model at video times (diagnostics; the synthetic generator must not import this).
 * World here: metres, ball (address) at the origin, Y up, Z along the launch azimuth, X to its right.
 * @param {ArrayLike<number>} params  M3D parameters (M3D_PARAM_NAMES)
 * @param {import('./types.js').FitContext & {ramp?:{tSplit:number}}} ctx
 * @param {ArrayLike<number>} times  video seconds
 * @returns {{t:number, tReal:number, X:number, Y:number, Z:number, VX:number, VY:number, VZ:number, x:number, y:number, d:number, h:number}[]}
 */
export function simulate(params, ctx, times) {
  const P = ctx.params ?? PARAMS, M = buildModel([], ctx, P), p = Float64Array.from(params);
  if (ctx.ramp) M.ramp = { tSplit: ctx.ramp.tSplit, tau2Prior: Math.exp(p[LTAU2]) };
  const trs = Array.from(times, t => Math.max(0, warp(M, p, t)));
  const N = nodesFor(M.grid, Math.max(0, ...trs) + 0.01), traj = trajOf(M, p, N);
  const G = geometry(M, p[LF], p[PITCH], p[ROLL], p[K1], {}), cb = Math.cos(p[AZIM]), sb = Math.sin(p[AZIM]);
  return trs.map((tr, i) => {
    hermite(M.grid, traj.buf, traj.N, tr, true);
    const ok = projectCanon(M, G, cb, sb, PX, PY, PZ);
    return { t: times[i], tReal: tr, X: PX, Y: PY, Z: PZ, VX, VY, VZ, x: ok ? OX : NaN, y: ok ? OY : NaN, d: ok ? OD : NaN, h: PY };
  });
}
