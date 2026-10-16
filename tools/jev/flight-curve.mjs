/**
 * One smooth flight curve through a trace's measured points, for a clean, launch-monitor-like arc.
 *
 * Shape and timing are fitted separately:
 *   shape   x(s), y(s) over s = distance along the path: a penalized cubic spline (P-spline), robust to outliers
 *           (Huber weights) and pinned to the ball's spot at impact. Fitting against distance, not time, keeps the
 *           arc smooth even though the ball slows sharply on screen just after launch.
 *   timing  s(t): the points' distances made non-decreasing (pool-adjacent-violators), then a monotone cubic
 *           (PCHIP) through them, so the reveal never runs backwards.
 *   tail    past the last point, the arc continues along its own end direction and gently keeps its end bend,
 *           at the end speed slowing to half over the tail.
 * Pure functions; positions in any one unit (px), times in seconds.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Solve A x = b (A n×n, row-major array of arrays) by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-12;
    for (let r = i + 1; r < n; r++) { const f = M[r][i] / d; if (f) for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]; x[i] = s / (M[i][i] || 1e-12); }
  return x;
}

/** Uniform cubic B-spline basis on [0, S] with nb functions: the nb values at s. */
function basis(s, S, nb) {
  const seg = nb - 3, h = S / seg, u = clamp(s / h, 0, seg - 1e-9), i = Math.floor(u), t = u - i, out = new Array(nb).fill(0);
  const b0 = (1 - t) ** 3 / 6, b1 = (3 * t ** 3 - 6 * t * t + 4) / 6, b2 = (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, b3 = t ** 3 / 6;
  out[i] = b0; out[i + 1] = b1; out[i + 2] = b2; out[i + 3] = b3;
  return out;
}

/** Penalized spline z(s) through (s_i, z_i) with weights w_i; lambda on squared second differences of the coefficients. */
function pspline(ss, zs, ws, S, nb, lambda) {
  const A = Array.from({ length: nb }, () => new Array(nb).fill(0)), b = new Array(nb).fill(0);
  for (let i = 0; i < ss.length; i++) {
    const B = basis(ss[i], S, nb);
    for (let p = 0; p < nb; p++) { if (!B[p]) continue; b[p] += ws[i] * B[p] * zs[i]; for (let q = 0; q < nb; q++) if (B[q]) A[p][q] += ws[i] * B[p] * B[q]; }
  }
  for (let j = 0; j + 2 < nb; j++) {                       // D2ᵀD2
    const d = [[j, 1], [j + 1, -2], [j + 2, 1]];
    for (const [p, a] of d) for (const [q, c] of d) A[p][q] += lambda * a * c;
  }
  const coef = solve(A, b);
  return s => basis(s, S, nb).reduce((acc, v, j) => acc + v * coef[j], 0);
}

/** Pool-adjacent-violators: the closest non-decreasing sequence (weights 1). */
function isotonic(v) {
  const blocks = [];
  for (const x of v) {
    blocks.push({ sum: x, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).n > blocks.at(-1).sum / blocks.at(-1).n) { const b = blocks.pop(); blocks.at(-1).sum += b.sum; blocks.at(-1).n += b.n; }
  }
  return blocks.flatMap(b => new Array(b.n).fill(b.sum / b.n));
}

/** Monotone cubic (Fritsch–Carlson PCHIP) through increasing xs with non-decreasing ys. */
function pchip(xs, ys) {
  const n = xs.length, h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  if (n === 2) { m[0] = m[1] = d[0]; }
  else {
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / d[i - 1] + (h[i] + 2 * h[i - 1]) / d[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
  }
  const f = x => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (xs[i + 1] < x) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
  f.endSlope = m[n - 1];
  return f;
}

/**
 * @param {{t:number, x:number, y:number}} anchor  the ball's spot at impact
 * @param {{t:number, x:number, y:number, w?:number}[]} points  measured positions after impact, any order
 * @param {{smooth?:number, huber?:number}} [opts]  smooth: spline stiffness (higher = smoother); huber: px
 * @returns {{at:(t:number) => {x:number, y:number}, t0:number, tEnd:number, tail:(horizonSec:number, stepSec:number) => {t:number, x:number, y:number}[], residuals:number[]}}
 */
export function fitFlightCurve(anchor, points, { smooth = 1, huber = 3 } = {}) {
  const P = points.filter(p => p.t > anchor.t).sort((a, b) => a.t - b.t);
  const all = [anchor, ...P];
  // Distance along the path through the points (a 3-point median first, so one bad point cannot stretch it).
  const med = (a, b, c) => a + b + c - Math.max(a, b, c) - Math.min(a, b, c);
  const mx = all.map((p, i) => i && i < all.length - 1 ? med(all[i - 1].x, p.x, all[i + 1].x) : p.x);
  const my = all.map((p, i) => i && i < all.length - 1 ? med(all[i - 1].y, p.y, all[i + 1].y) : p.y);
  const sRaw = [0]; for (let i = 1; i < all.length; i++) sRaw.push(sRaw[i - 1] + Math.hypot(mx[i] - mx[i - 1], my[i] - my[i - 1]));
  const S = Math.max(1, sRaw.at(-1)), nb = clamp(Math.round(all.length / 3), 6, 30);
  // Stiffness in units of the curve's own length, so a long and a short flight are smoothed alike.
  const lambda = smooth * 0.05 * (nb - 3) ** 3 / 10;
  let w = all.map((p, i) => (i ? p.w ?? 1 : 50));          // the impact spot is pinned
  let fx, fy;
  for (let iter = 0; iter < 4; iter++) {
    fx = pspline(sRaw, all.map(p => p.x), w, S, nb, lambda);
    fy = pspline(sRaw, all.map(p => p.y), w, S, nb, lambda);
    w = all.map((p, i) => { if (!i) return 50; const r = Math.hypot(fx(sRaw[i]) - p.x, fy(sRaw[i]) - p.y); return (p.w ?? 1) * (r <= huber ? 1 : huber / r); });
  }
  // Timing: distance along the path at each time, never decreasing.
  const ts = all.map(p => p.t), sMono = isotonic(sRaw);
  const ux = [], uy = []; for (let i = 0; i < ts.length; i++) if (!ux.length || ts[i] > ux.at(-1) + 1e-9) { ux.push(ts[i]); uy.push(sMono[i]); } else uy[uy.length - 1] = Math.max(uy.at(-1), sMono[i]);
  const sOf = pchip(ux, uy);
  const at = t => { const s = clamp(sOf(t), 0, S); return { x: fx(s), y: fy(s) }; };
  const residuals = P.map(p => { const q = at(p.t); return Math.hypot(q.x - p.x, q.y - p.y); });

  /** "Where it was heading": continue along the end direction, keeping the end bend, slowing to half speed. */
  const tail = (horizonSec, stepSec) => {
    const e = 0.02 * S, p1 = { x: fx(S), y: fy(S) }, p0 = { x: fx(S - e), y: fy(S - e) }, pm = { x: fx(S - 2 * e), y: fy(S - 2 * e) };
    let tx = (p1.x - p0.x) / e, ty = (p1.y - p0.y) / e; const tn = Math.hypot(tx, ty) || 1; tx /= tn; ty /= tn;
    // Curvature at the end (second difference), bounded so the tail bends at most like a circle of radius S/2.
    let kx = (p1.x - 2 * p0.x + pm.x) / (e * e), ky = (p1.y - 2 * p0.y + pm.y) / (e * e);
    const kn = Math.hypot(kx, ky), kMax = 2 / S; if (kn > kMax) { kx *= kMax / kn; ky *= kMax / kn; }
    // End speed along the path, from the last 0.2 s.
    const tEnd = ux.at(-1), back = Math.max(ux[0], tEnd - 0.2), v = Math.max(0, (sOf(tEnd) - sOf(back)) / Math.max(1e-3, tEnd - back));
    const out = [];
    for (let k = 1; k * stepSec <= horizonSec + 1e-9; k++) {
      const tau = k * stepSec, u = v * (tau - tau * tau / (4 * horizonSec));   // speed falls linearly to half at the horizon
      out.push({ t: tEnd + tau, x: p1.x + tx * u + 0.5 * kx * u * u, y: p1.y + ty * u + 0.5 * ky * u * u });
    }
    return out;
  };
  return { at, t0: anchor.t, tEnd: ux.at(-1), tail, residuals };
}
