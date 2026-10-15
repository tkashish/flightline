/**
 * Stand-in for U5's fitFlight with the FlightFit contract shape. The model is an image-space ballistic path in
 * frames after t0: constant image acceleration plus linear drag, x(τ) = x0 + v·E1 + a·E2 with E1 = (1 − e^{−kτ})/k
 * and E2 = (τ − E1)/k. It is NOT U5's M3D and it differs from the scenes' discrete drag model. Robust: Huber
 * IRLS at fit.huberSigmas, then residuals > fit.outlierSigmas are outliers and one refit. Uses only inliers.
 */
import { PARAMS } from '../../../dist/hf/params.js';

const sq = v => v * v;
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const inv = A => { const c = A.map((_, j) => solve(A, A.map((__, i) => (i === j ? 1 : 0)))); return A.map((_, i) => c.map(col => col[i])); };

function pos(th, tau) {
  const [x0, y0, vx, vy, ax, ay, k] = th;
  let e1, e2;
  if (Math.abs(k) < 1e-6) { e1 = tau; e2 = tau * tau / 2; } else { e1 = (1 - Math.exp(-k * tau)) / k; e2 = (tau - e1) / k; }
  return [x0 + vx * e1 + ax * e2, y0 + vy * e1 + ay * e2];
}

const NAMES = ['x0', 'y0', 'vx', 'vy', 'ax', 'ay', 'k'];
const PRIOR = { k: [0.01, 0.05] };

/** fitFlight(obs, ctx, {warm}) -> FlightFit (tests only). */
export function stubFitFlight(obs, ctx, { warm } = {}) {
  const P = ctx.params ?? PARAMS, F = P.fit, L = ctx.launch, fps = ctx.meta.fps, t0 = L.t0;
  const use = obs.map((o, i) => ({ o, i })).filter(e => (e.o.flag ?? 'inlier') === 'inlier');
  if (use.length < 3) throw new Error('stub fit: too few observations');
  const pts = use.map(({ o, i }) => ({ i, tau: (o.t - t0) * fps, x: o.x, y: o.y, s: Math.max(0.3, o.sigma) }));
  let th;
  if (warm?.params?.length === 7) th = [...warm.params];
  else {
    const a = pts[0], b = pts[Math.min(2, pts.length - 1)], dt = Math.max(1e-3, b.tau - a.tau);
    th = [L.address.x, L.address.y, (b.x - a.x) / dt, (b.y - a.y) / dt, 0, 0, 0.01];
  }
  let w = pts.map(() => 1), mask = pts.map(() => 1), JtJ = null;
  const run = iters => {
    for (let it = 0; it < iters; it++) {
      const r = [], J = NAMES.map(() => []);
      pts.forEach((p, q) => {
        if (!mask[q]) return;
        const [x, y] = pos(th, p.tau), sw = Math.sqrt(w[q]) / p.s;
        r.push((p.x - x) * sw, (p.y - y) * sw);
        for (let j = 0; j < 7; j++) {
          const h = 1e-6 * Math.max(1, Math.abs(th[j])), t = [...th]; t[j] += h;
          const [x1, y1] = pos(t, p.tau);
          J[j].push((x1 - x) / h * sw, (y1 - y) / h * sw);
        }
      });
      r.push((PRIOR.k[0] - th[6]) / PRIOR.k[1]);
      J.forEach((col, j) => col.push(j === 6 ? 1 / PRIOR.k[1] : 0));
      const A = J.map(a => J.map(b => a.reduce((s, v, q) => s + v * b[q], 0))), g = J.map(a => a.reduce((s, v, q) => s + v * r[q], 0));
      JtJ = A;
      const d = solve(A.map((row, i) => row.map((v, j) => (i === j ? v * 1.001 + 1e-9 : v))), g);
      th = th.map((v, j) => v + d[j]);
      if (Math.max(...d.map(Math.abs)) < 1e-7) break;
    }
  };
  const resid = () => pts.map(p => { const [x, y] = pos(th, p.tau); return Math.hypot(p.x - x, p.y - y) / p.s; });
  run(12);
  let rn = resid();
  w = rn.map(v => (v <= F.huberSigmas ? 1 : F.huberSigmas / v));
  run(8);
  rn = resid();
  mask = rn.map(v => (v <= F.outlierSigmas ? 1 : 0));
  if (mask.some(m => !m)) { w = pts.map(() => 1); run(8); rn = resid(); }
  const kept = mask.reduce((s, m) => s + m, 0), dof = Math.max(1, 2 * kept - 7);
  const chi = pts.reduce((s, p, q) => s + (mask[q] ? sq(rn[q]) : 0), 0);
  const C = inv(JtJ);
  const predict = t => {
    const tau = (t - t0) * fps, [x, y] = pos(th, tau), G = th.map((v, j) => { const h = 1e-6 * Math.max(1, Math.abs(v)), q = [...th]; q[j] += h; const [x1, y1] = pos(q, tau); return [(x1 - x) / h, (y1 - y) / h]; });
    let sxx = 0, sxy = 0, syy = 0;
    for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) { sxx += G[a][0] * G[b][0] * C[a][b]; sxy += G[a][0] * G[b][1] * C[a][b]; syy += G[a][1] * G[b][1] * C[a][b]; }
    return { t, x, y, cov: [Math.max(0, sxx), sxy, Math.max(0, syy)], d: Math.max(0.5, L.d0 / Math.max(0.05, 1 + L.c * Math.max(0, tau))), h: null };
  };
  // Landing in this image model: the path comes back down to the address row after its apex.
  let landingT = null;
  for (let tau = 1; tau < 30 * fps; tau += 1) {
    const [, y] = pos(th, tau), [, yp] = pos(th, tau - 1);
    if (y >= L.address.y && yp < L.address.y && y > yp) { landingT = t0 + tau / fps; break; }
  }
  const inlier = new Uint8Array(obs.length);
  use.forEach((e, q) => { inlier[e.i] = mask[q]; });
  const speed = Math.hypot(th[2], th[3]);
  return {
    kind: 'm3d', params: th, names: NAMES, cov: C.flat(), tau: 1, view: 'dtl', rmsNorm: Math.sqrt(chi / dof), inlier,
    inlierFrac: kept / pts.length, priorZMax: Math.max(Math.abs(th[6] - PRIOR.k[0]) / PRIOR.k[1], Math.max(0, -th[5]) / (0.05 * Math.max(1, speed) + 0.05)),
    converged: true, ill: pts.length < 7, landingT, predict,
    sample: ({ t0: a, t1: b, dt }) => { const out = []; for (let t = a; t <= b + 1e-9; t += dt) out.push(predict(t)); return out; }
  };
}
