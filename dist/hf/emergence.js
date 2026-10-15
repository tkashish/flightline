/**
 * Two-body emergence (U3): native-resolution ball evidence, emergence chains through the address, D1's
 * projective-line law with ONE shared c, the D3 features f1-f7, and D3's ray transform with a monotone DP for
 * streak-only launches. Everything works on a processing grid: the stabilized native box (bx, by) pooled by p,
 * where grid pixel (i, j) covers stabilized [bx + p·i, bx + p·(i+1)) × [by + p·j, by + p·(j+1)) (protocol §4).
 * Positions handed outside this file are stabilized native px.
 *
 * Evidence (D2 §3.3): R = residual against a reference median, rectified with the EXPECTED polarity at each pixel
 * (sign(L_ball − B)) and capped at |L_ball − B| + δ, so a white ball reads as evidence against grass (brighter)
 * and against a bright overcast sky (darker) alike, while a dark arm over a white shirt cannot exceed the contrast
 * a ball could have there. Then box-DoG at two ball scales and local CFAR in an annulus.
 */
import { PARAMS } from './params.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ image primitives */

/** Integral image (w+1)·(h+1) of src (any numeric array); S[(y+1)(w+1) + x+1] = Σ src over [0, x] × [0, y]. */
export function integral(src, w, h, out, square = false) {
  const W1 = w + 1, S = out ?? new Float64Array(W1 * (h + 1));
  for (let x = 0; x < W1; x++) S[x] = 0;
  for (let y = 0; y < h; y++) {
    const o = (y + 1) * W1, p = y * W1, q = y * w;
    let row = 0;
    S[o] = 0;
    if (square) for (let x = 0; x < w; x++) { const v = src[q + x]; row += v * v; S[o + x + 1] = S[p + x + 1] + row; }
    else for (let x = 0; x < w; x++) { row += src[q + x]; S[o + x + 1] = S[p + x + 1] + row; }
  }
  return S;
}

const bounds = (n, r) => {
  const lo = new Int32Array(n), hi = new Int32Array(n), inv = new Float64Array(n);
  for (let i = 0; i < n; i++) { lo[i] = Math.max(0, i - r); hi[i] = Math.min(n, i + r + 1); inv[i] = 1 / (hi[i] - lo[i]); }
  return { lo, hi, inv };
};

/** Box DoG from an integral image: mean over the (2a+1)² box minus mean over the (2b+1)² box (borders clamped). */
export function boxDog(S, w, h, a, b, out) {
  const W1 = w + 1, xa = bounds(w, a), xb = bounds(w, b), ya = bounds(h, a), yb = bounds(h, b);
  for (let y = 0; y < h; y++) {
    const ra0 = ya.lo[y] * W1, ra1 = ya.hi[y] * W1, rb0 = yb.lo[y] * W1, rb1 = yb.hi[y] * W1, ia = ya.inv[y], ib = yb.inv[y], o = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = xa.lo[x], x1 = xa.hi[x], X0 = xb.lo[x], X1 = xb.hi[x];
      const sa = S[ra1 + x1] - S[ra0 + x1] - S[ra1 + x0] + S[ra0 + x0];
      const sb = S[rb1 + X1] - S[rb0 + X1] - S[rb1 + X0] + S[rb0 + X0];
      out[o + x] = sa * xa.inv[x] * ia - sb * xb.inv[x] * ib;
    }
  }
  return out;
}

/** Local CFAR (D2): z = v / sqrt(σg² + mean(v²) over the box annulus [rIn, rOut]); S2 is scratch for ∫v². */
export function localCfar(v, w, h, rIn, rOut, sigmaG, S2, out) {
  integral(v, w, h, S2, true);
  const W1 = w + 1, xi = bounds(w, rIn), xo = bounds(w, rOut), yi = bounds(h, rIn), yo = bounds(h, rOut), g2 = sigmaG * sigmaG;
  // the annulus energy varies slowly (inner radius >= 2σ + 1), so it is evaluated on even rows and columns and
  // reused by the odd neighbours
  const inv = new Float32Array(w);
  for (let y = 0; y < h; y += 2) {
    const ri0 = yi.lo[y] * W1, ri1 = yi.hi[y] * W1, ro0 = yo.lo[y] * W1, ro1 = yo.hi[y] * W1, hi = yi.hi[y] - yi.lo[y], ho = yo.hi[y] - yo.lo[y];
    for (let x = 0; x < w; x += 2) {
      const x0 = xi.lo[x], x1 = xi.hi[x], X0 = xo.lo[x], X1 = xo.hi[x];
      const si = S2[ri1 + x1] - S2[ri0 + x1] - S2[ri1 + x0] + S2[ri0 + x0];
      const so = S2[ro1 + X1] - S2[ro0 + X1] - S2[ro1 + X0] + S2[ro0 + X0];
      const n = (X1 - X0) * ho - (x1 - x0) * hi, e = 1 / Math.sqrt(g2 + (n > 0 ? Math.max(0, so - si) / n : 0));
      inv[x] = e; if (x + 1 < w) inv[x + 1] = e;
    }
    for (let yy = y; yy < Math.min(h, y + 2); yy++) { const o = yy * w; for (let x = 0; x < w; x++) out[o + x] = v[o + x] * inv[x]; }
  }
  return out;
}

/** 1.4826 · median |a| over every step-th value (histogram, no sort). */
export function robustSigma(a, step = 7, top = 64) {
  const NB = 2048, hist = new Uint32Array(NB), k = NB / top;
  let n = 0;
  for (let i = 0; i < a.length; i += step) { const v = Math.abs(a[i]); hist[v >= top ? NB - 1 : (v * k) | 0]++; n++; }
  let c = 0;
  for (let b = 0; b < NB; b++) { c += hist[b]; if (2 * c >= n) return Math.max(1e-3, 1.4826 * (b + 0.5) / k); }
  return 1e-3;
}

/**
 * Strict 3×3 local maxima of z above zMin, sub-pixel by parabolas, greedy NMS (radius nms px), at most max.
 * Positions are continuous grid coordinates (pixel centre = i + 0.5). exclude(x, y) drops a peak.
 */
export function findPeaks(z, w, h, { zMin, nms, max, exclude }) {
  const cand = [];
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = o + x, v = z[i];
      if (v < zMin) continue;
      if (v < z[i - 1] || v <= z[i + 1] || v < z[i - w] || v <= z[i + w] || v < z[i - w - 1] || v < z[i - w + 1] || v <= z[i + w - 1] || v <= z[i + w + 1]) continue;
      cand.push(i);
    }
  }
  cand.sort((p, q) => z[q] - z[p]);
  const out = [], n2 = nms * nms;
  for (const i of cand) {
    if (out.length >= max) break;
    const x = i % w, y = (i - x) / w, v = z[i];
    const ddx = z[i - 1] - 2 * v + z[i + 1], ddy = z[i - w] - 2 * v + z[i + w];
    const sx = ddx < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (z[i - 1] - z[i + 1]) / ddx)) : 0;
    const sy = ddy < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (z[i - w] - z[i + w]) / ddy)) : 0;
    const px = x + 0.5 + sx, py = y + 0.5 + sy;
    if (exclude && exclude(px, py)) continue;
    let ok = true;
    for (const q of out) if ((q.x - px) ** 2 + (q.y - py) ** 2 < n2) { ok = false; break; }
    if (ok) out.push({ x: px, y: py, z: v, i });
  }
  return out;
}

/**
 * Half-max blob of R around grid pixel index i0: 4-connected flood fill over R >= 0.5·peak (peak = 3×3 max)
 * inside a box of radius maxR, at most cap pixels. Returns second moments (grid px) and flux.
 */
export function blobAt(R, w, h, i0, maxR, cap) {
  const x0 = i0 % w, y0 = (i0 - x0) / w;
  let peak = 0, pi = i0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (R[y * w + x] > peak) { peak = R[y * w + x]; pi = y * w + x; }
  }
  if (!(peak > 0)) return null;
  const thr = 0.5 * peak, bx0 = Math.max(0, x0 - maxR), by0 = Math.max(0, y0 - maxR), bx1 = Math.min(w, x0 + maxR + 1), by1 = Math.min(h, y0 + maxR + 1);
  const bw = bx1 - bx0, seen = new Uint8Array(bw * (by1 - by0)), stack = [pi];
  seen[((pi / w | 0) - by0) * bw + (pi % w) - bx0] = 1;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, flux = 0, big = false;
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; flux += R[i];
    if (n >= cap) { big = true; break; }
    if (x === bx0 || x === bx1 - 1 || y === by0 || y === by1 - 1) big = true;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < bx0 || ny < by0 || nx >= bx1 || ny >= by1) continue;
      const j = (ny - by0) * bw + nx - bx0;
      if (seen[j]) continue;
      seen[j] = 1;
      if (R[ny * w + nx] >= thr) stack.push(ny * w + nx);
    }
  }
  const mx = sx / n, my = sy / n;
  return { cx: mx + 0.5, cy: my + 0.5, sxx: sxx / n - mx * mx + 1 / 12, syy: syy / n - my * my + 1 / 12, sxy: sxy / n - mx * my, area: n, flux, peak, big };
}

/** Width (4σ) of a blob along unit direction (ux, uy) and across it; also major/minor and the major-axis angle. */
export function blobWidths(b, ux, uy) {
  const along = b.sxx * ux * ux + 2 * b.sxy * ux * uy + b.syy * uy * uy, across = b.sxx * uy * uy - 2 * b.sxy * ux * uy + b.syy * ux * ux;
  const tr = b.sxx + b.syy, det = b.sxx * b.syy - b.sxy * b.sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  return { along: 4 * Math.sqrt(Math.max(0, along)), across: 4 * Math.sqrt(Math.max(0, across)), major: 4 * Math.sqrt(tr / 2 + disc), minor: 4 * Math.sqrt(Math.max(0, tr / 2 - disc)), angle: 0.5 * Math.atan2(2 * b.sxy, b.sxx - b.syy) };
}

/* ------------------------------------------------------------------ reference and evidence */

/** Per-pixel median of a few Uint8 frames (n <= 7). */
export function medianFrames(frames, n, out) {
  const m = frames.length, tmp = new Uint8Array(m), half = m >> 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) tmp[j] = frames[j][i];
    for (let a = 1; a < m; a++) { const v = tmp[a]; let b = a - 1; while (b >= 0 && tmp[b] > v) { tmp[b + 1] = tmp[b]; b--; } tmp[b + 1] = v; }
    out[i] = m % 2 ? tmp[half] : (tmp[half - 1] + tmp[half] + 1) >> 1;
  }
  return out;
}

/**
 * Reference for one impact time: B (median), the ball luma at the address, the expected-polarity sign and cap
 * maps, and the noise σ (from the spread of the reference frames about B).
 * @param {Uint8Array[]} frames reference grid images; grid {w, h, p, bx, by}; addr {x, y} stabilized native; d0p
 */
export function buildReference(frames, grid, addr, d0p, polarity = 1) {
  const { w, h } = grid, n = w * h, B = medianFrames(frames, n, new Uint8Array(n));
  // noise: robust spread of (frame - B) over a subsample of all reference frames
  const diffs = [];
  for (const f of frames) for (let i = 0; i < n; i += 11) diffs.push(f[i] - B[i]);
  const sigmaN = frames.length > 2 ? Math.max(0.8, robustSigma(diffs, 1)) : 2;
  const ax = (addr.x - grid.bx) / grid.p, ay = (addr.y - grid.by) / grid.p, rb = Math.max(0.6, 0.3 * d0p), rr = [0.9 * d0p, 1.6 * d0p];
  let sb = 0, nb = 0, sr = 0, nr = 0;
  for (let y = Math.floor(ay - rr[1]); y <= Math.ceil(ay + rr[1]); y++) for (let x = Math.floor(ax - rr[1]); x <= Math.ceil(ax + rr[1]); x++) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const d = Math.hypot(x + 0.5 - ax, y + 0.5 - ay);
    if (d <= rb) { sb += B[y * w + x]; nb++; } else if (d >= rr[0] && d <= rr[1]) { sr += B[y * w + x]; nr++; }
  }
  const ring = nr ? sr / nr : 128;
  let Lball = nb ? sb / nb : ring + 60 * polarity;
  if (Math.sign(Lball - ring) !== polarity) Lball = ring + polarity * Math.max(12, Math.abs(Lball - ring));
  const delta = Math.max(6, 3 * sigmaN), signF = new Float32Array(n), cap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Lball - B[i];
    signF[i] = c > delta ? 1 : c < -delta ? -1 : 0;
    cap[i] = Math.abs(c) + delta;
  }
  return { B, signF, cap, sigmaN, Lball, ring, contrast: Lball - ring };
}

/** Ball-consistent residual: R = min(cap, max(0, sign·(Y − B))), zeroed inside the hole disc (grid px) when given. */
export function ballResidual(Y, ref, w, h, out, hole = null) {
  const { B, signF, cap } = ref, n = w * h;
  for (let i = 0; i < n; i++) {
    const v = signF[i] * (Y[i] - B[i]), c = cap[i];
    out[i] = v < 0 ? 0 : v > c ? c : v;
  }
  if (hole) {
    const { x, y, r } = hole, r2 = r * r;
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(h, Math.ceil(y + r)); yy++) for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(w, Math.ceil(x + r)); xx++) {
      if ((xx + 0.5 - x) ** 2 + (yy + 0.5 - y) ** 2 <= r2) out[yy * w + xx] = 0;
    }
  }
  return out;
}

/** Box radii for a DoG matched to a blob of scale sigma (grid px): inner a ≈ σ, outer b ≈ 2.5σ + 1. */
export function dogRadii(sigma) { const a = Math.max(1, Math.round(sigma)); return { a, b: Math.max(a + 2, Math.round(2.5 * sigma + 1)) }; }

/**
 * Scratch buffers for evidence on a w×h grid (reused across frames).
 */
export function makeScratch(w, h) {
  const n = w * h;
  return { R: new Float32Array(n), S: new Float64Array((w + 1) * (h + 1)), S2: new Float64Array((w + 1) * (h + 1)), dogA: new Float32Array(n), dogB: new Float32Array(n), zA: new Float32Array(n), zB: new Float32Array(n), zM: new Float32Array(n) };
}

/**
 * Ball evidence for one frame (D2 §3.3): residual R (in scratch.R), DoG at two scales, local CFAR, z = max of the
 * scales, peaks (grid coords, with zBig/zSmall and the half-max blob). zmap: Uint8 half-resolution max-pooled
 * round(8·z) (z capped at 31) for later point lookups.
 * @returns {{peaks:object[], zmap:{w:number, h:number, data:Uint8Array}, sigmaG:number[]}}
 */
export function ballEvidence(Y, ref, grid, d0p, sc, params, { hole = null, exclude = null } = {}) {
  const E = params.launch.evidence, { w, h } = grid;
  ballResidual(Y, ref, w, h, sc.R, hole);
  integral(sc.R, w, h, sc.S);
  const sig = E.dogSigmaD0.map(f => Math.max(E.minSigmaPx, f * d0p)), sigmaG = [];
  const maps = [[sc.dogA, sc.zA], [sc.dogB, sc.zB]];
  sig.forEach((s, k) => {
    const { a, b } = dogRadii(s), [dog, z] = maps[k];
    boxDog(sc.S, w, h, a, b, dog);
    const g = robustSigma(dog);
    sigmaG.push(g);
    localCfar(dog, w, h, Math.round(E.cfarInner[0] * s + E.cfarInner[1]), Math.round(E.cfarOuter[0] * s + E.cfarOuter[1]), g, sc.S2, z);
  });
  const zM = sc.zM, zA = sc.zA, zB = sc.zB, pw = Math.ceil(w / 2), pz = new Uint8Array(pw * Math.ceil(h / 2));
  for (let y = 0; y < h; y++) {
    const o = y * w, po = (y >> 1) * pw;
    for (let x = 0; x < w; x++) {
      const a = zA[o + x], b = zB[o + x], v = a > b ? a : b;
      zM[o + x] = v;
      if (v > 0) { const q = v >= 31.9 ? 255 : (v * 8) | 0, j = po + (x >> 1); if (q > pz[j]) pz[j] = q; }
    }
  }
  const raw = findPeaks(zM, w, h, { zMin: E.minPeakZ, nms: Math.max(1.5, E.nmsD0 * d0p), max: E.maxPeaks * 2, exclude });
  const maxR = Math.max(4, Math.ceil(3 * d0p)), cap = Math.max(64, Math.ceil(16 * d0p * d0p));
  const peaks = [];
  for (const q of raw) {
    if (peaks.length >= E.maxPeaks) break;
    const blob = blobAt(sc.R, w, h, q.i, maxR, cap);
    peaks.push({ x: q.x, y: q.y, z: q.z, zBig: sc.zA[q.i], zSmall: sc.zB[q.i], blob });
  }
  return { peaks, zmap: { w: pw, h: Math.ceil(h / 2), data: pz }, sigmaG };
}

/** Half-resolution max-pooled z map as Uint8 (8 levels per z, capped at 31.9). */
export function poolZ(z, w, h) {
  const pw = Math.ceil(w / 2), ph = Math.ceil(h / 2), data = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    const o = y * w, po = (y >> 1) * pw;
    for (let x = 0; x < w; x++) {
      const v = z[o + x];
      if (v <= 0) continue;
      const q = v >= 31.9 ? 255 : (v * 8) | 0, j = po + (x >> 1);
      if (q > data[j]) data[j] = q;
    }
  }
  return { w: pw, h: ph, data };
}
/** z from a pooled map at grid coords (x, y), max over a (2r+1)² neighbourhood of pooled cells. */
export function zLookup(zmap, x, y, r = 0) {
  if (!zmap) return 0;
  const cx = Math.floor(x / 2), cy = Math.floor(y / 2);
  let m = 0;
  for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
    if (xx < 0 || yy < 0 || xx >= zmap.w || yy >= zmap.h) continue;
    const v = zmap.data[yy * zmap.w + xx];
    if (v > m) m = v;
  }
  return m / 8;
}

/* ------------------------------------------------------------------ projective-line law */

/**
 * Fit s(τ) = vτ/(1+cτ) along a line through the address and w(τ) = d0/(1+cτ), ONE shared c (D1 §3.5).
 * samples: [{t, x, y, w?}] stabilized native px (w = measured ⟂ width or null). ctx: {fps, t0Range:[lo, hi] (s),
 * cRange:[lo, hi] (1/frame), params}. τ is in frames: (t − t0)·fps.
 * @returns {{v, c, t0, dir:{x,y}, s:number[], perp:number[], tau:number[], dExp:number[], rms, rmsD0, perpRms, perpMax,
 *   bandOk, widthErr, startWidth, startShrink, speedRatioMax, ok}}
 */
export function fitProjectiveLine(samples, hyp, ctx) {
  const P = (ctx.params ?? PARAMS).launch.law, A = hyp.address, d0 = hyp.d0, fps = ctx.fps, n = samples.length;
  if (!n) return null;
  // direction through the address: principal axis of (p − A), oriented toward the samples
  let sxx = 0, sxy = 0, syy = 0, mx = 0, my = 0;
  for (const q of samples) { const dx = q.x - A.x, dy = q.y - A.y; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; mx += dx; my += dy; }
  let th = n === 1 ? Math.atan2(my, mx) : 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(th), uy = Math.sin(th);
  if (ux * mx + uy * my < 0) { ux = -ux; uy = -uy; }
  if (ctx.dir) { ux = ctx.dir.x; uy = ctx.dir.y; }
  const s = samples.map(q => (q.x - A.x) * ux + (q.y - A.y) * uy), perp = samples.map(q => -(q.x - A.x) * uy + (q.y - A.y) * ux);
  const tFirst = Math.min(...samples.map(q => q.t)), [lo0, hi0] = ctx.t0Range, hi = Math.min(hi0, tFirst - 0.02 / fps), lo = Math.min(lo0, hi);
  const [cLo, cHi] = ctx.cRange, lw = samples.map(q => q.w > 0 ? Math.log(q.w / d0) : null), sigW = 0.25;
  const evalAt = (t0, c) => {
    let fs = 0, ff = 0;
    const f = new Float64Array(n), wt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const tau = (samples[i].t - t0) * fps, den = 1 + c * tau;
      if (!(tau > 0) || !(den > 0.05)) return null;
      f[i] = tau / den;
      const sd = Math.max(0.5, 0.15 * d0 / den);
      wt[i] = 1 / (sd * sd);
      fs += wt[i] * f[i] * s[i]; ff += wt[i] * f[i] * f[i];
    }
    const v = fs / ff;
    if (!(v > 0)) return null;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const e = s[i] - v * f[i];
      cost += wt[i] * e * e;
      if (lw[i] !== null) { const tau = (samples[i].t - t0) * fps, e2 = lw[i] + Math.log(1 + c * tau); cost += (e2 / sigW) ** 2; }
    }
    return { v, cost };
  };
  const cs = [cLo, cLo / 2, 0];
  for (let k = 0; k < 14; k++) cs.push(Math.min(cHi, 0.004 * Math.pow(cHi / 0.004, k / 13)));
  let best = null;
  for (let i = 0; i <= 8; i++) {
    const t0 = lo + (hi - lo) * i / 8;
    for (const c of cs) { if (c > cHi) continue; const r = evalAt(t0, c); if (r && (!best || r.cost < best.cost)) best = { t0, c, ...r }; }
  }
  if (!best) return null;
  // local refinement: coordinate search with shrinking steps
  let dt = (hi - lo) / 8 || 0.1 / fps, dc = Math.max(0.002, Math.abs(best.c) * 0.3 + 0.01);
  for (let it = 0; it < 24; it++) {
    let moved = false;
    for (const [t0, c] of [[best.t0 + dt, best.c], [best.t0 - dt, best.c], [best.t0, best.c + dc], [best.t0, best.c - dc]]) {
      if (t0 < lo || t0 > hi || c < cLo || c > cHi) continue;
      const r = evalAt(t0, c);
      if (r && r.cost < best.cost - 1e-12) { best = { t0, c, ...r }; moved = true; }
    }
    if (!moved) { dt /= 2; dc /= 2; }
  }
  const { v, c, t0 } = best, tau = samples.map(q => (q.t - t0) * fps), dExp = tau.map(t => d0 / (1 + c * t));
  const resid = s.map((si, i) => si - v * tau[i] / (1 + c * tau[i]));
  const L = Math.max(...s) - Math.min(0, Math.min(...s));
  const rms = Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / n), perpRms = Math.sqrt(perp.reduce((a, e) => a + e * e, 0) / n);
  const perpMax = Math.max(...perp.map(Math.abs));
  const bandOk = perp.every((e, i) => Math.abs(e) <= Math.max(P.bandPx, P.bandD0 * d0) + P.bandSlope * Math.abs(s[i]));
  // size law error: mean |ln(w(1+cτ)/d0)| (D1), as a median once three widths exist (one width measured across a
  // sky/tree boundary or merged with clutter must not decide it)
  const ws = samples.map((q, i) => q.w > 0 ? Math.abs(Math.log(q.w * (1 + c * tau[i]) / d0)) : null).filter(x => x !== null).sort((a, b) => a - b);
  const widthErr = !ws.length ? 0 : ws.length >= 3 ? ws[ws.length >> 1] : ws.reduce((a, b) => a + b, 0) / ws.length;
  const order = samples.map((q, i) => i).sort((a, b) => samples[a].t - samples[b].t), i1 = order[0];
  // D1's start test, for the first sample: its width against the law's d_exp there within startWidthD0, and the
  // shrink 1 + c·τ1 <= maxStartShrink when it is in the first post-impact frame (τ1 <= 1). D1's chains start in
  // that frame; when the merged first frame is lost the ball has legitimately shrunk further.
  const startWidth = samples[i1].w > 0 ? samples[i1].w * (1 + c * tau[i1]) / d0 : null, startShrink = tau[i1] <= 1 ? 1 + c * tau[i1] : 1;
  // consecutive speed ratio, allowing ctx.quantum of position quantization at each sample (streak run ends are
  // quantized to ray bins; blob peaks are sub-pixel, quantum 0)
  let speedRatioMax = 0;
  for (let k = 2; k < n; k++) {
    const a = order[k - 2], b = order[k - 1], e = order[k];
    // position allowance: ctx.quantum (streak bins) or sub-pixel peak noise 0.5 px + 0.15·d_exp per sample
    const q = i => ctx.quantum ?? 0.5 + 0.15 * d0 / Math.max(0.05, 1 + c * tau[i]);
    const v1 = (s[b] - s[a] + q(a) + q(b)) / (samples[b].t - samples[a].t), v2 = (s[e] - s[b] - q(b) - q(e)) / (samples[e].t - samples[b].t);
    if (v1 > 0) speedRatioMax = Math.max(speedRatioMax, v2 / v1);
  }
  const sizeOk = widthErr <= P.maxMeanLogWidth;
  const startOk = (startWidth === null || (startWidth >= P.startWidthD0[0] && startWidth <= P.startWidthD0[1])) && startShrink <= P.maxStartShrink;
  const rmsOk = n < 3 || rms <= Math.max(P.rmsPx, P.rmsFrac * L);
  const speedOk = n < 3 || speedRatioMax <= P.maxSpeedRatio;
  return {
    v, c, t0, dir: { x: ux, y: uy }, s, perp, tau, dExp, resid, rms, rmsD0: rms / d0, perpRms, perpMax, bandOk, widthErr, startWidth, startShrink,
    speedRatioMax, sizeOk, startOk, rmsOk, speedOk, ok: bandOk && sizeOk && startOk && rmsOk && speedOk, L
  };
}

/** Position on the law at frame time t (stabilized native px). */
export function lawAt(h, A, t, fps) {
  const tau = (t - h.t0) * fps;
  if (!(tau > 0)) return { x: A.x, y: A.y, s: 0, tau, d: h.d0 ?? 0 };
  const den = 1 + h.c * tau, s = h.v * tau / den;
  return { x: A.x + h.dir.x * s, y: A.y + h.dir.y * s, s, tau, den };
}

/* ------------------------------------------------------------------ features */

/**
 * D3 features of a chain (support samples with fitted law): f1 straightness (RMS ⟂ / mean expected d), f2 profile
 * RMS (d0), f3 origin (t0 − t(k_last), frames), f4 lead (fraction of samples that are the farthest emitter within
 * ±15°), f5 median ⟂ width / d_exp, f6 median flux ratio, f7 median streak-axis misalignment / tolerance.
 */
export function chainFeatures(chain, hyp, club, ctx) {
  const P = (ctx.params ?? PARAMS).launch.gates, law = chain.law, d0 = hyp.d0, smp = chain.samples;
  const dbar = law.dExp.reduce((a, b) => a + b, 0) / law.dExp.length;
  const widths = [], fluxes = [], aspects = [], mis = [];
  let lead = 0;
  const th = Math.atan2(law.dir.y, law.dir.x);
  smp.forEach((q, i) => {
    if (q.w > 0) widths.push(q.w / law.dExp[i]);
    if (q.flux > 0 && ctx.addressFlux > 0) fluxes.push(q.flux / ctx.addressFlux * (d0 / law.dExp[i]) ** 2);
    if (q.major > 0 && q.minor > 0) {
      aspects.push(q.major / q.minor);
      // a streak: aspect >= streakMinAspect and an elongation of at least 2 grid px (tiny blobs elongate by noise)
      if (q.major / q.minor >= P.streakMinAspect && (q.major - q.minor) / (ctx.pool ?? 1) >= 2) {
        const tol = Math.max(P.streakAxisDeg * DEG, Math.atan(2 / q.major));
        let da = Math.abs(q.angle - th) % Math.PI;
        if (da > Math.PI / 2) da = Math.PI - da;
        mis.push(da / tol);
      }
    }
    if (q.leader !== false) lead++;
  });
  const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  // f7 applies to streaky launches (median aspect >= streakMinAspect, so the exposure really blurs the ball): the
  // median misalignment of their streak samples. A few merged or noisy blobs in a short exposure say nothing.
  const streaky = (med(aspects) ?? 0) >= P.streakMinAspect;
  return {
    f1: law.perpRms / Math.max(1e-6, dbar), f2: law.rms / d0, f3: (law.t0 - hyp.tLast) * ctx.fps,
    f4: smp.length ? lead / smp.length : 0, f5: med(widths), f6: med(fluxes), f7: streaky ? (med(mis) ?? 0) : 0, dbar, streaky
  };
}

/* ------------------------------------------------------------------ ray transform (streak mode) */

/**
 * Ray geometry for an anchor on a grid: θ over the launch cone (y up) in thetaStepDeg, s from the hole edge in
 * sStepD0·d0 bins, a 1·d0 strip sampled at 3 offsets (inner) and a 2·d0 strip edge at 2 offsets (outer).
 * Returns index tables into the grid (−1 = outside).
 */
export function rayGeometry(grid, anchor, d0, sMax, params) {
  const S = params.launch.streak, p = grid.p, d0p = d0 / p;
  const thetas = [];
  for (let a = S.coneDeg[0]; a <= S.coneDeg[1] + 1e-9; a += S.thetaStepDeg) thetas.push(a * DEG);
  const ds = S.sStepD0 * d0, s0 = params.launch.evidence.holeD0 * d0, nS = Math.max(1, Math.floor((sMax - s0) / ds));
  const nT = thetas.length, inner = new Int32Array(nT * nS * 3), outer = new Int32Array(nT * nS * 2);
  const ax = (anchor.x - grid.bx) / p, ay = (anchor.y - grid.by) / p, half = S.stripD0 * d0p / 2;
  const offIn = [-0.66 * half, 0, 0.66 * half], offOut = [-1.7 * half, 1.7 * half];
  for (let t = 0; t < nT; t++) {
    const ux = Math.cos(thetas[t]), uy = -Math.sin(thetas[t]), nx = -uy, ny = ux;
    for (let k = 0; k < nS; k++) {
      const sp = (s0 + (k + 0.5) * ds) / p, cx = ax + ux * sp, cy = ay + uy * sp, o = t * nS + k;
      offIn.forEach((f, m) => { const x = Math.floor(cx + nx * f), y = Math.floor(cy + ny * f); inner[o * 3 + m] = x >= 0 && y >= 0 && x < grid.w && y < grid.h ? y * grid.w + x : -1; });
      offOut.forEach((f, m) => { const x = Math.floor(cx + nx * f), y = Math.floor(cy + ny * f); outer[o * 2 + m] = x >= 0 && y >= 0 && x < grid.w && y < grid.h ? y * grid.w + x : -1; });
    }
  }
  // segments wider than this never enter the DP (rayTransform's width cut), so they need no 2-D shape
  const wMax = params.launch.law.startWidthD0[1] * d0 + params.launch.gates.widthSlackPx;
  return { thetas, nT, nS, ds, s0, inner, outer, anchor, grid, d0p, wMax };
}

/**
 * ⟂ width (native px) of a ray segment [a, b) at θ index t: the full width at half maximum of the cross-ray profile
 * of R above its edge level (crossings interpolated, 0.125·d0 samples; a disc's chord profile gives 0.87·d), at 25%,
 * 50% and 75% along the segment, median of the three (a line crossing the strip at an angle sits at different
 * offsets along it). Returned as an equivalent diameter (FWHM / 0.87), so a ball streak reads ≈ d and a shaft ≪ d.
 */
export function segmentWidth(R, geo, t, a, b) {
  const { grid, d0p } = geo, p = grid.p, th = geo.thetas[t], ux = Math.cos(th), uy = -Math.sin(th), nx = -uy, ny = ux;
  const ax = (geo.anchor.x - grid.bx) / p, ay = (geo.anchor.y - grid.by) / p, N = 25, step = 0.125 * d0p, prof = new Float64Array(N), ws = [];
  const sample = (x, y) => {
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), fx = x - 0.5 - x0, fy = y - 0.5 - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= grid.w || y0 + 1 >= grid.h) return 0;
    const i = y0 * grid.w + x0;
    return (R[i] * (1 - fx) + R[i + 1] * fx) * (1 - fy) + (R[i + grid.w] * (1 - fx) + R[i + grid.w + 1] * fx) * fy;
  };
  for (const f of [0.25, 0.5, 0.75]) {
    const sp = (geo.s0 + (a + (b - a) * f) * geo.ds) / p, cx = ax + ux * sp, cy = ay + uy * sp;
    for (let i = 0; i < N; i++) { const o = (i - (N - 1) / 2) * step; prof[i] = sample(cx + nx * o, cy + ny * o); }
    const base = Math.min(prof[0], prof[1], prof[N - 2], prof[N - 1]);
    let pk = 0, pi = 0;
    for (let i = 0; i < N; i++) if (prof[i] - base > pk) { pk = prof[i] - base; pi = i; }
    if (!(pk > 0)) { ws.push(0); continue; }
    const half = base + 0.5 * pk;
    let l = pi, r = pi;
    while (l > 0 && prof[l - 1] >= half) l--;
    while (r < N - 1 && prof[r + 1] >= half) r++;
    const xl = l > 0 ? l - (prof[l] - half) / Math.max(1e-9, prof[l] - prof[l - 1]) : l - 0.5;
    const xr = r < N - 1 ? r + (prof[r] - half) / Math.max(1e-9, prof[r] - prof[r + 1]) : r + 0.5;
    ws.push((xr - xl) * step * p / 0.87);
  }
  ws.sort((x, y) => x - y);
  return ws[1];
}

/**
 * Second moments of the half-maximum part of R in a box around (cx, cy) (grid px): {major, minor (native px, 4σ),
 * angle (rad, image), n, cx, cy (its centroid, native px: a streak's centre, the ball at mid-exposure)}. For a ball
 * streak minor ≈ d and the axis points along the motion; a thin line crossing a ray obliquely keeps its own small
 * minor axis and its own direction.
 */
export function boxMoments(R, grid, cx, cy, hx, hy) {
  const x0 = Math.max(0, Math.floor(cx - hx)), x1 = Math.min(grid.w, Math.ceil(cx + hx)), y0 = Math.max(0, Math.floor(cy - hy)), y1 = Math.min(grid.h, Math.ceil(cy + hy));
  let mx = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (R[y * grid.w + x] > mx) mx = R[y * grid.w + x];
  if (!(mx > 0)) return null;
  const thr = 0.5 * mx;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (R[y * grid.w + x] < thr) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const ax = sx / n, ay = sy / n, cxx = sxx / n - ax * ax + 1 / 12, cyy = syy / n - ay * ay + 1 / 12, cxy = sxy / n - ax * ay;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  return { major: 4 * Math.sqrt(tr / 2 + disc) * grid.p, minor: 4 * Math.sqrt(Math.max(1 / 12, tr / 2 - disc)) * grid.p, angle: 0.5 * Math.atan2(2 * cxy, cxx - cyy), n, cx: grid.bx + (ax + 0.5) * grid.p, cy: grid.by + (ay + 0.5) * grid.p };
}

/**
 * Streak segments of one frame (D3 §3.4): strip integrals of R along every ray, normalized by the frame's robust
 * statistics, then maximal runs of elevated bins (one-bin gaps allowed). Keeps the best few runs per θ.
 * @returns {{segs:{t:number, a:number, b:number, z:number, outer:number}[]}}  a, b bin indices [a, b)
 */
export function raySegments(R, geo, { zRun = 1, zMin = 3, perTheta = 3 } = {}) {
  const { nT, nS, inner, outer } = geo, N = nT * nS, P = new Float32Array(N), O = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    let s = 0, cnt = 0;
    for (let m = 0; m < 3; m++) { const i = inner[c * 3 + m]; if (i >= 0) { s += R[i]; cnt++; } }
    P[c] = cnt ? s / cnt : NaN;
    let so = 0, co = 0;
    for (let m = 0; m < 2; m++) { const i = outer[c * 2 + m]; if (i >= 0) { so += R[i]; co++; } }
    O[c] = co ? so / co : 0;
  }
  // robust normalization over all valid cells: median and MAD from 0.25-level histograms (R is 0..255)
  const hist = new Uint32Array(1024);
  let nv = 0;
  for (let c = 0; c < N; c += 3) { const v = P[c]; if (v === v) { hist[Math.min(1023, (v * 4) | 0)]++; nv++; } }
  const quant = (hst, frac) => { let acc = 0; for (let b = 0; b < hst.length; b++) { acc += hst[b]; if (acc >= frac * nv) return (b + 0.5) / 4; } return 0; };
  const med = nv ? quant(hist, 0.5) : 0, hd = new Uint32Array(1024);
  for (let c = 0; c < N; c += 3) { const v = P[c]; if (v === v) hd[Math.min(1023, (Math.abs(v - med) * 4) | 0)]++; }
  const mad = Math.max(0.25, 1.4826 * (nv ? quant(hd, 0.5) : 1));
  const segs = [];
  for (let t = 0; t < nT; t++) {
    const runs = [];
    let a = -1, sum = 0, osum = 0, raw = 0, gap = 0, last = -1;
    for (let k = 0; k <= nS; k++) {
      const pv = k < nS ? P[t * nS + k] : NaN, v = pv === pv ? (pv - med) / mad : -Infinity;
      if (v >= zRun) {
        if (a < 0) { a = k; sum = 0; osum = 0; raw = 0; }
        sum += v; osum += (O[t * nS + k] - med) / mad; raw += pv - med; gap = 0; last = k;
      } else if (a >= 0 && gap === 0 && k < nS && v > 0) { gap = 1; sum += v; raw += pv - med; }
      else if (a >= 0) {
        const len = last - a + 1, z = sum / Math.sqrt(len);
        // flux: strip mean × strip width (1·d0) × bin length, native px² × levels
        if (z >= zMin) runs.push({ t, a, b: last + 1, z, outer: osum / Math.max(1e-6, sum), flux: raw * geo.d0p * geo.grid.p * geo.ds });
        a = -1; gap = 0;
      }
    }
    runs.sort((p, q) => q.z - p.z);
    for (const r of runs.slice(0, perTheta)) { r.w = segmentWidth(R, geo, t, r.a, r.b); segs.push(r); }
  }
  // 2-D shape of every segment narrow enough for the DP, computed once per d0-sized cell of its midpoint (neighbouring
  // rays share a streak)
  const cells = new Map(), g = geo.grid, A = geo.anchor;
  for (const sg of segs) {
    if (geo.wMax !== undefined && !(sg.w <= geo.wMax)) { sg.shape = null; continue; }
    const th = geo.thetas[sg.t], sm = geo.s0 + (sg.a + sg.b) / 2 * geo.ds, len = (sg.b - sg.a) * geo.ds;
    const cx = (A.x + Math.cos(th) * sm - g.bx) / g.p, cy = (A.y - Math.sin(th) * sm - g.by) / g.p, key = `${Math.round(cx / geo.d0p)},${Math.round(cy / geo.d0p)},${Math.round(len / geo.ds / 4)}`;
    if (!cells.has(key)) { const h = (len / 2) / g.p + geo.d0p; cells.set(key, boxMoments(R, g, cx, cy, h, h)); }
    sg.shape = cells.get(key);
  }
  return { segs };
}

/**
 * Monotone DP over frames for one θ (D3): pick at most one segment per frame with increasing midpoints, steps of
 * at least minStep and the impulse growth rule (s_{j+1} <= growth·s_j + slack), consistent exposure (length/step),
 * scoring Σ (min(z, zCap) − zOffset) − missCost per skipped frame. framesSegs: [{k, segs (this θ)}] in frame order.
 * @returns {{score:number, picks:{k:number, seg:object}[]}|null}
 */
export function streakDP(framesSegs, geo, d0, params) {
  const I = params.scan.vacate.impulse, Sup = params.launch.support, minStep = params.launch.emergence.minStepD0 * d0;
  const mid = sg => geo.s0 + (sg.a + sg.b) / 2 * geo.ds, len = sg => (sg.b - sg.a) * geo.ds;
  // states: per frame, per segment: best {score, prev state, step}
  const states = [];
  let best = null;
  for (let f = 0; f < framesSegs.length; f++) {
    const { k, segs } = framesSegs[f], cur = [];
    for (const sg of segs) {
      const m = mid(sg), gain = Math.min(sg.z, Sup.zCap) - Sup.zOffset;
      let st = { score: gain, raw: sg.z, prev: null, k, seg: sg, m, step: null, n: 1 };
      for (let g = Math.max(0, f - 1 - params.launch.emergence.maxGapFrames); g < f; g++) {
        for (const ps of states[g]) {
          const dk = k - ps.k, step = (m - ps.m) / dk;
          if (!(step >= minStep)) continue;
          if (ps.step !== null && step > I.growth * ps.step + I.growthSlackD0 * d0) continue;
          if (ps.step !== null && step < 0.5 * ps.step) continue;
          // exposure consistency: streak length / step stays within a factor 1.6
          const e1 = len(ps.seg) / Math.max(1e-6, step), e0 = ps.e ?? e1;
          if (ps.n > 1 && (e1 > 1.6 * e0 + 0.5 || e1 < e0 / 1.6 - 0.5)) continue;
          const sc = ps.score + gain - Sup.missCost * (dk - 1), raw = ps.raw + sg.z;
          if (sc > st.score || (sc === st.score && raw > st.raw)) st = { score: sc, raw, prev: ps, k, seg: sg, m, step, n: ps.n + 1, e: (e0 * (ps.n - 1) + e1) / ps.n };
        }
      }
      cur.push(st);
      if (st.n >= 2 && (!best || st.score > best.score || (st.score === best.score && st.raw > best.raw))) best = st;
    }
    states.push(cur);
  }
  if (!best) return null;
  const picks = [];
  for (let s = best; s; s = s.prev) picks.unshift({ k: s.k, seg: s.seg, m: s.m });
  return { score: best.score, raw: best.raw, picks };
}

/**
 * Streak-mode chains (D3 rayTransform): the monotone DP over per-frame ray segments for every θ, best first, at
 * most `top` with directions at least 4 θ steps apart. frameSegs: [{k, t, segs}] for post-impact frames (segs from
 * raySegments with this geometry). Ties of the capped score break on the uncapped segment evidence.
 * @returns {{mode:'streak', theta:number, dir:{x,y}, samples:{k,t,x,y,s,len,z,outer,w,flux}[], score:number}[]}
 */
export function rayTransform(frameSegs, geo, hyp, ctx, top = 16) {
  const params = ctx.params ?? PARAMS, byT = new Map();
  // segments wider than the per-sample band of the blob path (D1's start-width bound × d0) cannot be a ball
  const wMax = params.launch.law.startWidthD0[1] * hyp.d0 + params.launch.gates.widthSlackPx;
  for (const f of frameSegs) for (const sg of f.segs) { if (!(sg.w <= wMax)) continue; if (!byT.has(sg.t)) byT.set(sg.t, []); byT.get(sg.t).push({ k: f.k, sg }); }
  // Two pools per θ: the DP over all segments, and over the leading (farthest) segment of each frame, since the
  // ball is the leading emitter and on its own ray the trailing head can hold a longer chain.
  const pools = [[], []];
  for (const [t, list] of byT) {
    const fs = frameSegs.map(f => ({ k: f.k, segs: list.filter(e => e.k === f.k).map(e => e.sg) })).filter(f => f.segs.length);
    if (fs.length < 2) continue;
    const r = streakDP(fs, geo, hyp.d0, params);
    if (r) pools[0].push({ ...r, t });
    const lead = fs.map(f => ({ k: f.k, segs: [f.segs.reduce((a, b) => (b.a + b.b > a.a + a.b ? b : a))] }));
    const q = streakDP(lead, geo, hyp.d0, params);
    if (q && (!r || q.picks.some((p, i) => p.seg !== r.picks[i]?.seg) || q.picks.length !== r.picks.length)) pools[1].push({ ...q, t });
  }
  // cheap pre-gates on segment data only (ball width, elongation, a streak no longer than its step plus the ball),
  // then the best `top` survivors by score go on to the full law and gates
  const G = params.launch.gates, wBall = G.widthRatio * hyp.d0 + G.widthSlackPx, med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
  const ok = r => {
    if (r.picks.length < params.launch.samples.minExit) return false;
    if (!(med(r.picks.map(p => p.seg.w)) <= wBall)) return false;
    if (!(med(r.picks.map(p => (p.seg.b - p.seg.a) * geo.ds / Math.max(1, p.seg.w))) >= G.streakMinAspect)) return false;
    for (let i = 1; i < r.picks.length; i++) {
      const step = (r.picks[i].m - r.picks[i - 1].m) / Math.max(1, r.picks[i].k - r.picks[i - 1].k);
      // at most one step plus the ball, plus a bin of run-end tail at each end
      if ((r.picks[i].seg.b - r.picks[i].seg.a) * geo.ds > step + 2 * r.picks[i].seg.w + 2 * geo.ds) return false;
    }
    return true;
  };
  // ranked by segment evidence capped at 3·zCap: the score's zCap saturates for every strong streak and favours long
  // chains of noise-level runs over a two-frame bright streak, while uncapped sums let one huge body blob win
  const res = [], zc = 3 * params.launch.support.zCap, key = r => r.picks.reduce((a, p) => a + Math.min(zc, p.seg.z), 0);
  for (const r of [...pools[0], ...pools[1]].filter(ok).map(r => ({ ...r, rank: key(r) })).sort((a, b) => b.rank - a.rank || b.score - a.score)) {
    if (res.length >= top) break;
    // neighbouring rays see the same streak: keep one chain per ±2 θ steps with the same frames
    if (res.some(o => Math.abs(o.t - r.t) <= 2 && o.picks[0].k === r.picks[0].k)) continue;
    res.push(r);
  }
  const out = [], A = geo.anchor;
  for (const r of res) {
    const th = geo.thetas[r.t], dir = { x: Math.cos(th), y: -Math.sin(th) };
    const samples = r.picks.map(p => {
      const f = frameSegs.find(q => q.k === p.k);
      return { k: p.k, t: f.t, x: A.x + dir.x * p.m, y: A.y + dir.y * p.m, s: p.m, len: (p.seg.b - p.seg.a) * geo.ds, z: p.seg.z, outer: p.seg.outer, w: p.seg.w, flux: p.seg.flux, shape: p.seg.shape };
    });
    // radial check (f7 for streaks): a ball streak points at the address, so the neighbouring rays (one θ step
    // either side) cross it at the same radius; a line crossing the strip at an angle α shifts by 2·s·δ/tan α
    samples.forEach((q, i) => {
      const p = r.picks[i], segsK = frameSegs.find(f => f.k === p.k).segs, mid = sg => geo.s0 + (sg.a + sg.b) / 2 * geo.ds;
      const near = dt => segsK.filter(sg => sg.t === r.t + dt && sg.a < p.seg.b + 1 && sg.b > p.seg.a - 1).sort((x, y) => Math.abs(mid(x) - p.m) - Math.abs(mid(y) - p.m))[0];
      const lo = near(-1), hi = near(1);
      q.shift = lo && hi ? Math.abs(mid(hi) - mid(lo)) : lo || hi ? 2 * Math.abs(mid(lo ?? hi) - p.m) : null;
    });
    out.push({ mode: 'streak', theta: th, ti: r.t, dir, samples, score: r.score, raw: r.raw });
  }
  return out;
}

/* ------------------------------------------------------------------ diagnostic LLR (never gates) */

/**
 * Ball-vs-club log-likelihood ratio from fixed E2-derived densities (UNTRAINED; FINAL: diagnostics only). Each
 * term is clamped to ±llrClampNats.
 */
export function diagnosticLLR(f, params = PARAMS) {
  const cl = params.launch.gates.llrClampNats, terms = [];
  const gauss = (x, m, s) => -0.5 * ((x - m) / s) ** 2 - Math.log(s);
  if (Number.isFinite(f.f1)) terms.push(gauss(f.f1, 0, 0.1) - gauss(f.f1, 1.5, 1.5));
  if (Number.isFinite(f.f5)) terms.push(gauss(Math.log(f.f5), 0, 0.18) - gauss(Math.log(f.f5), Math.log(2.2), 0.3));
  if (Number.isFinite(f.f7)) terms.push(gauss(f.f7, 0, 0.5) - gauss(f.f7, 2, 2));
  return terms.reduce((a, t) => a + Math.max(-cl, Math.min(cl, t)), 0);
}

/* ------------------------------------------------------------------ chain search over peaks */

/**
 * Emergence chains (D3 §3.4 with D2's support score): seeds from peak pairs collinear with the address (wedge),
 * the law solved for (v, c) at each impact time on the grid, support collected along the predicted path (club-
 * explained, size-consistency and novelty tests), refit, and re-collected. Returns unique chains by support set.
 * search: {A, d0, fps, pool, framesPost:[{k, t, peaks:[{id, x, y, z, zBig, zSmall, blob}]}], zAt(k, x, y),
 * T:[lo, hi] (impact as an absolute fractional frame index), tOf(k), kImpact, inFrame(k, x, y), reach(k),
 * clubExplained(k, x, y), inEnvelope(x, y), holeR (native px), cRange (1/frame), params}
 */
export function emergenceChains(search) {
  const { A, d0, fps, framesPost, params } = search, E = params.launch.emergence;
  const tOfT = T => { const k = Math.floor(T); return search.tOf(k) + (T - k) * (search.tOf(k + 1) - search.tOf(k)); };
  const pk = [];
  framesPost.forEach((f, fi) => f.peaks.forEach(q => {
    const dx = q.x - A.x, dy = q.y - A.y, d = Math.hypot(dx, dy);
    if (d < search.holeR || d > search.reach(f.k)) return;
    pk.push({ ...q, fi, k: f.k, t: f.t, d, th: Math.atan2(dy, dx) });
  }));
  const Ts = [];
  for (let i = 0; i <= 8; i++) Ts.push(search.T[0] + (search.T[1] - search.T[0]) * i / 8);
  const seeds = [];
  for (const p1 of pk) for (const p2 of pk) {
    if (p2.fi <= p1.fi || p2.k - p1.k > 1 + E.maxGapFrames || p2.d <= p1.d) continue;
    if ((p2.d - p1.d) / (p2.k - p1.k) < E.minStepD0 * d0) continue;
    let dth = Math.abs(p2.th - p1.th); if (dth > Math.PI) dth = 2 * Math.PI - dth;
    if (dth > Math.max(E.wedgeDeg * DEG, Math.atan(E.wedgeD0 * d0 / p1.d))) continue;
    const th = Math.atan2(p1.d * Math.sin(p1.th) + p2.d * Math.sin(p2.th), p1.d * Math.cos(p1.th) + p2.d * Math.cos(p2.th));
    // impact times solved per pair for a few c (bisection on the distance ratio): fast face-on balls sit a small
    // fraction of a step from the address in their first frame, so the pair fits only a narrow window of t0
    for (const cf of [0, 0.1, 0.3, 0.6]) {
      const c = Math.min(search.cRange[1], cf), f = t0 => { const a = (p1.t - t0) * fps, b = (p2.t - t0) * fps; return (a / (1 + c * a)) / (b / (1 + c * b)) - p1.d / p2.d; };
      let lo = tOfT(search.T[0]), hi = Math.min(tOfT(search.T[1]), p1.t - 1e-4 / fps);
      if (!(hi > lo) || f(lo) * f(hi) > 0) continue;
      for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
      const t0 = (lo + hi) / 2, a = (p1.t - t0) * fps, v = p1.d * (1 + c * a) / a;
      if (v > 0) seeds.push({ th, v, c, t0, seed: [p1.id, p2.id] });
    }
    for (const T of Ts) {
      const t0 = tOfT(T), t1 = (p1.t - t0) * fps, t2 = (p2.t - t0) * fps;
      if (!(t1 > 0)) continue;
      // d(1 + cτ) = vτ  ->  [τ1, −τ1 d1; τ2, −τ2 d2] [v; c] = [d1; d2]
      const det = -t1 * t2 * p2.d + t2 * t1 * p1.d;
      if (Math.abs(det) < 1e-9) continue;
      const v = (p1.d * (-t2 * p2.d) + t1 * p1.d * p2.d) / det, c = (t1 * p2.d - t2 * p1.d) / det;
      if (!(v > 0) || c < search.cRange[0] || c > search.cRange[1]) continue;
      seeds.push({ th, v, c, t0, seed: [p1.id, p2.id] });
    }
  }
  // single-sample seeds (fast exits): constant velocity through the address
  for (const p of pk) {
    if (p.fi > 1) continue;
    for (const T of Ts) { const t0 = tOfT(T), tau = (p.t - t0) * fps; if (tau > 0) seeds.push({ th: p.th, v: p.d / tau, c: 0, t0, seed: [p.id], single: true }); }
  }
  const chains = new Map();
  for (const sd of seeds) {
    let h = { dir: { x: Math.cos(sd.th), y: Math.sin(sd.th) }, v: sd.v, c: sd.c, t0: sd.t0, d0 };
    let col = null;
    // D2's two-scale size test needs a reliable c, so the first pass (seed law) collects without it
    for (let it = 0; it < 3; it++) {
      col = collectSupport(h, search, { sizeTest: it > 0 });
      if (col.support.length < 2 || it === 2) break;
      const law = fitProjectiveLine(col.support.map(q => ({ t: q.t, x: q.x, y: q.y, w: q.w })), { address: A, d0 }, { fps, t0Range: [tOfT(search.T[0]), tOfT(search.T[1])], cRange: search.cRange, params });
      if (!law) break;
      h = { dir: law.dir, v: law.v, c: law.c, t0: law.t0, d0 };
    }
    const key = col.support.map(q => q.id).sort().join('|') || `none:${sd.seed.join(',')}`;
    col.law = col.support.length ? fitProjectiveLine(col.support.map(q => ({ t: q.t, x: q.x, y: q.y, w: q.w })), { address: A, d0 }, { fps, t0Range: [tOfT(search.T[0]), tOfT(search.T[1])], cRange: search.cRange, params, dir: col.support.length === 1 ? h.dir : null }) : null;
    const prev = chains.get(key);
    if (!prev || col.S > prev.S) chains.set(key, { ...col, h, single: !!sd.single && col.support.length <= 1 });
  }
  return [...chains.values()].filter(c => c.support.length).sort((a, b) => b.S - a.S);
}

/**
 * Support along a hypothesis path (D2 §3.3): the best peak within tolerance of the predicted position, unless it
 * fails size consistency (two DoG scales vs the predicted radius), novelty (already there one frame earlier),
 * the per-sample width band (start-width bound × d_exp), or is club-explained. S = Σ w·(min(z, zCap) − zOffset)
 * + Σ_unsupported in-frame (missWeight·min(0, z_pred − zOffset) − missCost); club-explained hits cost zOffset.
 */
export function collectSupport(h, search, { sizeTest = true } = {}) {
  const { A, d0, fps, params, pool } = search, Sup = params.launch.support, wMax = params.launch.law.startWidthD0[1];
  const support = [], misses = [], inFramePred = [];
  let S = 0, inFrame = 0, exited = false, clubHits = 0;
  for (const f of search.framesPost) {
    const tau = (f.t - h.t0) * fps;
    if (!(tau > 0)) continue;
    const den = 1 + h.c * tau;
    if (!(den > 0.05)) break;
    const s = h.v * tau / den, x = A.x + h.dir.x * s, y = A.y + h.dir.y * s;
    if (!search.inFrame(f.k, x, y)) { exited = true; break; }
    if (s < search.holeR) continue;
    inFrame++;
    inFramePred.push({ k: f.k, t: f.t, x, y, s });
    const dExp = d0 / den, tol = Sup.tolPx + Sup.tolD0 * d0 + Sup.tolDist * s;
    let best = null;
    for (const q of f.peaks) {
      if (Math.hypot(q.x - x, q.y - y) > tol || (best && q.z <= best.z)) continue;
      best = q;
    }
    let reason = best ? null : 'none';
    const wd0 = best?.blob ? blobWidths(best.blob, h.dir.x, h.dir.y) : null;
    // Size consistency. With a measured half-max width the ⟂ width is held to D1's start-width band (below, with
    // the 'wide' bound); D2's two-scale z ratio is only the fallback for blobs without a width (it misreads streaks
    // and, with an imprecise c, rejects the true ball)
    if (best && sizeTest && !wd0) {
      const rPred = dExp / 2, rA = d0 / 2;
      if (rPred < Sup.smallRatio * rA && best.zBig > Sup.smallZ * best.zSmall) reason = 'size';
      else if (rPred > Sup.bigRatio * rA && best.zSmall > Sup.bigZ * best.zBig) reason = 'size';
    }
    if (!reason) {
      const sPrev = tau > 1 ? h.v * (tau - 1) / (1 + h.c * (tau - 1)) : 0;
      // novelty (D2): one frame earlier the spot must not already have held a detectable response (>= minPeakZ and
      // > noveltyZ·z); below the detection level a faint ball would be vetoed by noise
      const zPrev = f.k - 1 > search.kImpact && s - sPrev >= Sup.noveltyStepD * dExp ? search.zAt(f.k - 1, best.x, best.y, 0) : 0;
      if (zPrev > Math.max(Sup.noveltyZ * best.z, params.launch.evidence.minPeakZ)) reason = 'novelty';
    }
    let wd = null;
    if (!reason) {
      wd = wd0;
      const across = wd ? wd.across * pool : null;
      if (best.blob?.big || (wd && across > wMax * dExp + params.launch.gates.widthSlackPx)) reason = 'wide';
      else if (sizeTest && wd && across < params.launch.law.startWidthD0[0] * dExp - params.launch.gates.widthSlackPx) reason = 'size';
    }
    if (!reason && search.clubExplained(f.k, best.x, best.y)) reason = 'club';
    if (reason === 'club') { clubHits++; S -= Sup.zOffset; misses.push({ k: f.k, reason }); continue; }
    if (!reason) {
      const wgt = search.inEnvelope(best.x, best.y) ? Sup.envelopeWeight : 1;
      S += wgt * (Math.min(best.z, Sup.zCap) - Sup.zOffset);
      support.push({
        id: best.id, k: f.k, index: f.k, t: f.t, x: best.x, y: best.y, z: best.z, zBig: best.zBig, zSmall: best.zSmall, sPred: s, dExp, inEnv: wgt < 1,
        w: wd ? wd.across * pool : null, len: wd ? wd.along * pool : null, major: wd ? wd.major * pool : null, minor: wd ? wd.minor * pool : null,
        angle: wd ? wd.angle : 0, flux: best.blob ? best.blob.flux * pool * pool : null
      });
    } else {
      const zp = search.zAt(f.k, x, y);
      S += Sup.missWeight * Math.min(0, zp - Sup.zOffset) - Sup.missCost;
      misses.push({ k: f.k, zPred: zp, reason });
    }
  }
  return { support, misses, S, inFrame, exited, clubHits, inFramePred };
}
