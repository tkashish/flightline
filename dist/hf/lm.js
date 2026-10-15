/**
 * Small dense nonlinear least squares for the hf flight model (U5): Levenberg-Marquardt with Marquardt-scaled
 * damping, Huber IRLS weights on the leading (data) rows, Gaussian parameter priors, box bounds and Cholesky
 * solves. Matrices are row-major Float64Arrays. Runs in browsers and Node; no dependencies.
 */

/** Lower Cholesky factor of a symmetric row-major n×n matrix, or null when it is not positive definite. */
export function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}

/** Solve A·x = b for symmetric positive definite A (row-major n×n). Returns null when A is not SPD. */
export function solveSPD(A, b, n = b.length) {
  const L = cholesky(A, n);
  if (!L) return null;
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]; x[i] = s / L[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

/** Inverse of a symmetric positive definite matrix (row-major n×n), or null when it is not SPD. */
export function invertSPD(A, n) {
  const L = cholesky(A, n);
  if (!L) return null;
  const Li = new Float64Array(n * n);   // L⁻¹ (lower)
  for (let j = 0; j < n; j++) {
    Li[j * n + j] = 1 / L[j * n + j];
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i * n + k] * Li[k * n + j];
      Li[i * n + j] = s / L[i * n + i];
    }
  }
  const X = new Float64Array(n * n);   // A⁻¹ = L⁻ᵀ·L⁻¹
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = 0;
    for (let k = i; k < n; k++) s += Li[k * n + i] * Li[k * n + j];
    X[i * n + j] = X[j * n + i] = s;
  }
  return X;
}

/** Huber cost of one residual: r² inside ±δ, 2δ|r| − δ² outside (δ = Infinity is plain least squares). */
export const huber = (r, d) => { const a = Math.abs(r); return a <= d ? r * r : 2 * d * a - d * d; };

/**
 * Minimize Σ_{i<robustRows} huber(r_i, δ) + Σ_{i>=robustRows} r_i² + Σ_priors ((x_j − μ)/σ)² over x.
 * @param {(x:Float64Array) => Float64Array} residuals  whitened residuals; any non-finite value rejects a trial step
 * @param {ArrayLike<number>} x0
 * @param {{jacobian?:(x:Float64Array, r:Float64Array) => Float64Array, maxIter?:number, lambda0?:number, tol?:number,
 *   huberDelta?:number, robustRows?:number, priors?:{index:number, mu:number, sigma:number}[],
 *   lower?:ArrayLike<number>, upper?:ArrayLike<number>, step?:number, jtj?:boolean}} [opts]
 *   jacobian returns the m×n row-major ∂r/∂x (default: forward differences with step·max(1, |x_j|));
 *   jtj false skips the final JᵀWJ (multi-start phases that only compare costs).
 * @returns {{x:Float64Array, cost:number, iters:number, converged:boolean, JtJ:Float64Array|null, r:Float64Array, weights:Float64Array}}
 *   JtJ = JᵀWJ + prior precision at x (the Laplace precision; W = Huber weights at the solution).
 */
export function levenbergMarquardt(residuals, x0, opts = {}) {
  const { maxIter = 50, lambda0 = 1e-3, tol = 1e-7, huberDelta = Infinity, priors = [], lower, upper, step = 1e-6, jtj = true } = opts;
  const n = x0.length;
  const clamp = x => {
    if (lower) for (let j = 0; j < n; j++) if (x[j] < lower[j]) x[j] = lower[j];
    if (upper) for (let j = 0; j < n; j++) if (x[j] > upper[j]) x[j] = upper[j];
    return x;
  };
  const jac = opts.jacobian ?? ((x, r) => {
    const m = r.length, J = new Float64Array(m * n);
    for (let j = 0; j < n; j++) {
      const xj = Float64Array.from(x), h = step * Math.max(1, Math.abs(x[j]));
      xj[j] += h;
      const rj = residuals(xj);
      for (let i = 0; i < m; i++) J[i * n + j] = (rj[i] - r[i]) / h;
    }
    return J;
  });
  const costOf = (r, x) => {
    const nr = opts.robustRows ?? r.length;
    let c = 0;
    for (let i = 0; i < r.length; i++) c += i < nr ? huber(r[i], huberDelta) : r[i] * r[i];
    for (const p of priors) { const z = (x[p.index] - p.mu) / p.sigma; c += z * z; }
    return c;
  };
  const weightsOf = r => {
    const nr = opts.robustRows ?? r.length, w = new Float64Array(r.length).fill(1);
    if (Number.isFinite(huberDelta)) for (let i = 0; i < nr; i++) { const a = Math.abs(r[i]); if (a > huberDelta) w[i] = huberDelta / a; }
    return w;
  };
  const normal = (J, r, w, x) => {
    const m = r.length, A = new Float64Array(n * n), g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const wi = w[i], ri = r[i], o = i * n;
      if (!wi) continue;
      for (let a = 0; a < n; a++) {
        const ja = J[o + a];
        if (!ja) continue;
        const wja = wi * ja;
        g[a] += wja * ri;
        for (let b = a; b < n; b++) A[a * n + b] += wja * J[o + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    for (const p of priors) { const s2 = p.sigma * p.sigma; A[p.index * n + p.index] += 1 / s2; g[p.index] += (x[p.index] - p.mu) / s2; }
    return { A, g };
  };

  let x = clamp(Float64Array.from(x0)), r = residuals(x), cost = costOf(r, x);
  if (!Number.isFinite(cost)) return { x, cost: Infinity, iters: 0, converged: false, JtJ: null, r, weights: weightsOf(r) };
  let lambda = lambda0, iters = 0, converged = false, Jx = null;
  for (; iters < maxIter; iters++) {
    const J = jac(x, r), w = weightsOf(r), { A, g } = normal(J, r, w, x);
    Jx = { J, w, x };
    let accepted = false, small = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = Float64Array.from(A);
      for (let a = 0; a < n; a++) M[a * n + a] += lambda * (A[a * n + a] + 1e-9) + 1e-12;
      const d = solveSPD(M, g, n);
      if (!d) { lambda *= 10; continue; }
      const xt = new Float64Array(n);
      let stepNorm = 0;
      for (let j = 0; j < n; j++) { xt[j] = x[j] - d[j]; stepNorm = Math.max(stepNorm, Math.abs(d[j]) / (1 + Math.abs(x[j]))); }
      clamp(xt);
      const rt = residuals(xt), ct = costOf(rt, xt);
      if (Number.isFinite(ct) && ct < cost) {
        const rel = (cost - ct) / Math.max(cost, 1e-300);
        x = xt; r = rt; cost = ct; lambda = Math.max(1e-12, lambda / 3); accepted = true;
        small = rel < tol || stepNorm < 1e-10;
        break;
      }
      if (stepNorm < 1e-12) { small = true; break; }
      lambda *= 6;
    }
    if (!accepted || small) { converged = small || lambda > 1e10 || !accepted; iters++; break; }
  }
  let JtJ = null;
  if (jtj) {
    const same = Jx && Jx.x.every((v, j) => v === x[j]);
    const J = same ? Jx.J : jac(x, r), w = weightsOf(r);
    JtJ = normal(J, r, w, x).A;
  }
  return { x, cost, iters, converged, JtJ, r, weights: weightsOf(r) };
}
