/**
 * U2 camera motion (D3 §4.3, FINAL pipeline). estimateMotion finds the similarity that maps one coarse frame
 * onto another, robust to the golfer; MotionTracker matches every frame against a keyframe, so shake and odd or
 * sub-pixel drift never accumulate frame-to-frame error (v2 tracker-detection-I4); CameraPath composes the
 * estimates into the CameraTrack (stabilized native px -> raw native px of each frame).
 *
 * Per patch: truncated-SAD search of ±coarseSearchPx at the top pyramid level (1/4 res), ±1 at every middle
 * level, integer SSD search of ±patchSearchPx at full coarse res, then inverse-compositional Lucas-Kanade for an
 * exact sub-pixel position (no parabolic pixel locking). A Tukey IRLS similarity fit with a MAD scale rejects
 * golfer, club and ball patches. All coordinates follow types.js: pixel (i, j) covers [i, i+1) × [j, j+1).
 */
import { PARAMS } from './params.js';
import { HFError, IDENTITY_SIM, applySim, invertSim, composeSim, cameraSamples } from './types.js';

/** Numeric internals, not decision thresholds (not in PARAMS; integrator may promote them to scan.camera). */
export const CAMERA_INTERNALS = Object.freeze({
  minEig: 2,            // textured patch: structure-tensor min eigenvalue per px at 1/2 res (levels²/px²), above sensor noise
  scaleFloorPx: 0.25,   // IRLS MAD-scale floor (coarse px), so residuals within tukeyC·0.25 px always count as inliers
  initPx: 1.5,          // robust start: support radius of the prior and of single-patch translation hypotheses (coarse px)
  pairWin: 1.5,         // robust start: a two-patch similarity replaces the best translation at this × its score (ratio)
  pairMaxScale: 0.15,   // ... with |scale − 1| at most this (frac)
  pairMaxRotDeg: 5,     // ... and rotation at most this (deg)
  minNcc: 0.6,          // a patch match counts only if template and matched patch correlate this well (NCC); else a non-inlier
  minPatches: 6,        // inlier patches needed for a usable estimate (count)
  minSpreadFrac: 0.12,  // rotation and scale are fitted only when inliers spread this × min(w, h) (RMS), else kept from the prior
  truncSad: 40,         // top-level SAD truncation (levels): bounds the pull of the golfer on one patch search
  blockPx: 8,           // pyramid search block side at every level above full res (level px)
  narrowSearch: 2,      // top-level search radius tried first; widened to coarseSearchPx when its minimum is on the border (level px)
  lkIters: 6,           // Lucas-Kanade iterations at most (count)
  lkEps: 0.004,         // LK convergence step (coarse px)
  lkMaxMovePx: 1.5,     // LK may move at most this far from the integer search (coarse px), else it is ignored
  key: { minInlierFrac: 0.5, maxShiftFrac: 0.12, maxRotDeg: 2, maxScale: 0.02 } // key refresh: < 50% of its patches searchable, or the shift/rotation/scale limits
});
const C = CAMERA_INTERNALS;

/* ------------------------------------------------------------------ pyramid */

/** 2×2 rounded box mean; trailing odd row/column dropped (same rule as poolLuma). */
export function halfLuma(src, w, h, out) {
  const w2 = w >> 1, h2 = h >> 1, n = w2 * h2, d = out && out.length >= n ? out : new Uint8Array(n);
  for (let j = 0; j < h2; j++) {
    let a = 2 * j * w, b = a + w, o = j * w2;
    for (let i = 0; i < w2; i++, a += 2, b += 2) d[o++] = (src[a] + src[a + 1] + src[b] + src[b + 1] + 2) >> 2;
  }
  return { data: d, w: w2, h: h2 };
}

/**
 * Pyramid of a coarse image for estimateMotion. levels[0].data IS img.data (not copied): keep it unchanged while
 * the frame is used. reuse: a previous motion frame of the same size whose level buffers may be overwritten.
 */
export function motionFrame(img, { params = PARAMS, reuse } = {}) {
  const n = Math.max(1, params.scan.camera.pyramidLevels | 0), levels = [{ data: img.data, w: img.w, h: img.h }];
  for (let l = 1; l < n; l++) { const p = levels[l - 1]; levels.push(halfLuma(p.data, p.w, p.h, reuse?.levels?.[l]?.data)); }
  const top = levels[n - 1].data;
  let s = 0;
  for (let i = 0; i < top.length; i++) s += top[i];
  return { motionFrame: true, w: img.w, h: img.h, levels, mean: s / Math.max(1, top.length), patches: null };
}
const asFrame = (f, params) => f?.motionFrame ? f : motionFrame(f, { params });

/* ------------------------------------------------------------------ patch selection */

const overlapsBoxes = (x0, y0, P, boxes) => boxes?.some(b => x0 < b.x1 && x0 + P > b.x0 && y0 < b.y1 && y0 + P > b.y0);
function maskFrac(x0, y0, P, m) {
  if (!m) return 0;
  const c = m.cellPx, i0 = Math.max(0, Math.floor(x0 / c)), i1 = Math.min(m.w, Math.ceil((x0 + P) / c));
  const j0 = Math.max(0, Math.floor(y0 / c)), j1 = Math.min(m.h, Math.ceil((y0 + P) / c));
  let on = 0, all = 0;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { all++; on += m.data[j * m.w + i] ? 1 : 0; }
  return all ? on / all : 0;
}

/**
 * Textured patches on a motion frame (the reference side of estimateMotion): candidates on a non-overlapping
 * grid scored by the structure-tensor min eigenvalue. The best candidate of every cell of a region grid about
 * 4× finer than `patches` is taken, then those cells are subsampled uniformly in raster order, so the patch
 * share of a strongly textured golfer follows its area instead of its texture. Each patch carries its template,
 * gradients and LK sums at full res and one search block per higher level.
 * exclude: coarse boxes {x0, y0, x1, y1}; excludeMask: {data, w, h, cellPx} cells to avoid (>= 25% covered);
 * skyLine: {slope, y0} horizon in the frame's coarse px: ground candidates fill the budget first and patches
 * entirely above it are marked `sky`, so estimateMotion can trust the ground first (drifting clouds must not drag
 * the camera, yet help while the golfer hides the ground).
 */
export function selectPatches(frame, { params = PARAMS, exclude, excludeMask, skyLine } = {}) {
  const P = params.scan.camera.patchPx, want = params.scan.camera.patches, L = frame.levels, nl = L.length;
  const f = 1 << (nl - 1), B = C.blockPx, w = frame.w, h = frame.h;
  // keep every level's search block and the LK border inside the frame
  const margin = Math.max(2, Math.ceil((B * f - P) / 2) + f);
  const x1 = w - P - margin, y1 = h - P - margin;
  if (x1 < margin || y1 < margin) return [];
  const L1 = L[nl > 1 ? 1 : 0], s1 = nl > 1 ? 2 : 1, q = P / s1;
  const cols = Math.max(1, Math.round(Math.sqrt(4 * want * w / h))), rows = Math.max(1, Math.ceil(4 * want / cols));
  const regions = Array.from({ length: cols * rows }, () => []);
  for (let y0 = margin; y0 <= y1; y0 += P) {
    for (let x0 = margin; x0 <= x1; x0 += P) {
      if (overlapsBoxes(x0, y0, P, exclude) || maskFrac(x0, y0, P, excludeMask) >= 0.25) continue;
      const e = minEig(L1.data, L1.w, Math.floor(x0 / s1), Math.floor(y0 / s1), q);
      if (e < C.minEig) continue;
      const r = Math.min(rows - 1, Math.floor((y0 + P / 2) / h * rows)) * cols + Math.min(cols - 1, Math.floor((x0 + P / 2) / w * cols));
      regions[r].push({ x0, y0, e });
    }
  }
  for (const g of regions) g.sort((a, b) => b.e - a.e);
  // the sky can move on its own (drifting clouds, birds): with a known horizon the ground fills the budget first
  // and patches entirely above the horizon are marked `sky`
  const isSky = c => !!skyLine && c.y0 + P <= skyLine.y0 + skyLine.slope * (c.x0 + P / 2);   // entirely above (a tree line on the horizon stays ground)
  const chosen = [];
  for (const part of skyLine ? [c => !isSky(c), isSky] : [() => true]) {
    const sub = regions.map(g => g.filter(part));
    for (let round = 0; chosen.length < want; round++) {
      const layer = sub.filter(g => g.length > round).map(g => g[round]);   // raster order
      if (!layer.length) break;
      const room = want - chosen.length;
      if (layer.length <= room) chosen.push(...layer);
      else for (let i = 0; i < room; i++) chosen.push(layer[Math.floor((i + 0.5) * layer.length / room)]);
    }
  }
  return chosen.map(c => { const p = buildPatch(frame, c.x0, c.y0, P, c.e); p.sky = isSky(c); return p; });
}

function minEig(d, w, x0, y0, n) {
  let gxx = 0, gyy = 0, gxy = 0;
  for (let j = 0; j < n; j++) {
    let k = (y0 + j) * w + x0;
    for (let i = 0; i < n; i++, k++) {
      const gx = d[k + 1] - d[k - 1], gy = d[k + w] - d[k - w];
      gxx += gx * gx; gyy += gy * gy; gxy += gx * gy;
    }
  }
  const m = n * n * 4, a = gxx / m, c = gyy / m, b = gxy / m;
  return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
}

function buildPatch(frame, x0, y0, P, eig) {
  const d = frame.levels[0].data, w = frame.w, N = P * P;
  const T = new Float32Array(N), gx = new Float32Array(N), gy = new Float32Array(N);
  for (let j = 0, k = 0; j < P; j++) for (let i = 0, r = (y0 + j) * w + x0; i < P; i++, k++, r++) T[k] = d[r];
  // LK uses the interior only: its central differences read template pixels, never an edge just outside the patch
  let n = 0, sT = 0, sTT = 0, sgx = 0, sgy = 0, sgxT = 0, sgyT = 0, hxx = 0, hyy = 0, hxy = 0;
  for (let j = 1; j < P - 1; j++) {
    for (let i = 1; i < P - 1; i++) {
      const k = j * P + i, v = T[k], a = (T[k + 1] - T[k - 1]) / 2, b = (T[k + P] - T[k - P]) / 2;
      gx[k] = a; gy[k] = b; n++;
      sT += v; sTT += v * v; sgx += a; sgy += b; sgxT += a * v; sgyT += b * v; hxx += a * a; hyy += b * b; hxy += a * b;
    }
  }
  // the mean offset is fitted too, so the Hessian is of mean-centred gradients
  hxx -= sgx * sgx / n; hyy -= sgy * sgy / n; hxy -= sgx * sgy / n;
  const det = hxx * hyy - hxy * hxy;
  const blocks = [null];
  for (let l = 1; l < frame.levels.length; l++) {
    const Lv = frame.levels[l], s = 1 << l, B = C.blockPx;
    const bx = Math.round((x0 + P / 2) / s - B / 2), by = Math.round((y0 + P / 2) / s - B / 2), v = new Float32Array(B * B);
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) v[j * B + i] = Lv.data[(by + j) * Lv.w + bx + i];
    blocks.push({ bx, by, v });
  }
  return {
    x0, y0, P, cx: x0 + P / 2, cy: y0 + P / 2, eig, T, gx, gy, nLK: n, meanT: sT / n, varT: sTT / n - (sT / n) ** 2, sgx, sgy, sgxT, sgyT,
    ok: det > 1e-6, i11: hyy / det, i12: -hxy / det, i22: hxx / det, blocks
  };
}

/* ------------------------------------------------------------------ matching one patch */

/** Truncated zero-mean SAD search of a level block around (bx, by): brightness offsets never bias the match. */
function searchBlock(blk, Lv, bx, by, R, trunc) {
  const B = C.blockPx, w = Lv.w, d = Lv.data, v = blk.v, nB = B * B;
  if (blk.mean === undefined) { let a = 0; for (const x of v) a += x; blk.mean = a / nB; }
  const dx0 = Math.max(-R, -bx), dx1 = Math.min(R, w - B - bx), dy0 = Math.max(-R, -by), dy1 = Math.min(R, Lv.h - B - by);
  if (dx0 > dx1 || dy0 > dy1) return null;
  let best = Infinity, bdx = 0, bdy = 0;
  for (let dy = dy0; dy <= dy1; dy++) {
    for (let dx = dx0; dx <= dx1; dx++) {
      let m = 0;
      for (let j = 0; j < B; j++) for (let i = 0, r = (by + dy + j) * w + bx + dx; i < B; i++) m += d[r + i];
      const off = m / nB - blk.mean;
      let s = 0;
      for (let j = 0, k = 0; j < B && s < best; j++) {
        let r = (by + dy + j) * w + bx + dx;
        for (let i = 0; i < B; i++, k++, r++) { let e = d[r] - v[k] - off; if (e < 0) e = -e; s += e < trunc ? e : trunc; }
      }
      if (s < best) { best = s; bdx = dx; bdy = dy; }
    }
  }
  return { x: bx + bdx, y: by + bdy };
}

/** Zero-mean SSD of the template at (tx, ty): Σ(I − T)² − (Σ(I − T))²/N, blind to a brightness offset. */
function ssdAt(p, d, w, tx, ty) {
  const P = p.P, T = p.T;
  let s = 0, s1 = 0;
  for (let j = 0, k = 0; j < P; j++) {
    let r = (ty + j) * w + tx;
    for (let i = 0; i < P; i++, k++, r++) { const e = d[r] - T[k]; s += e * e; s1 += e; }
  }
  return s - s1 * s1 / (P * P);
}

/** Inverse-compositional LK (translation + mean offset) over the patch interior from displacement (dx, dy). */
function lucasKanade(p, Lv, dx, dy) {
  const P = p.P, d = Lv.data, w = Lv.w, h = Lv.h, gx = p.gx, gy = p.gy;
  for (let it = 0; it < C.lkIters; it++) {
    const X = p.x0 + dx, Y = p.y0 + dy, ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy;
    if (ix < 0 || iy < 0 || ix + P + 1 > w || iy + P + 1 > h) return null;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    let sI = 0, sgxI = 0, sgyI = 0;
    for (let j = 1; j < P - 1; j++) {
      let r = (iy + j) * w + ix + 1, k = j * P + 1;
      for (let i = 1; i < P - 1; i++, k++, r++) {
        const I = w00 * d[r] + w10 * d[r + 1] + w01 * d[r + w] + w11 * d[r + w + 1];
        sI += I; sgxI += gx[k] * I; sgyI += gy[k] * I;
      }
    }
    const dmu = sI / p.nLK - p.meanT, bx = sgxI - p.sgxT - dmu * p.sgx, by = sgyI - p.sgyT - dmu * p.sgy;
    const ux = p.i11 * bx + p.i12 * by, uy = p.i12 * bx + p.i22 * by;
    dx -= ux; dy -= uy;
    if (ux * ux + uy * uy < C.lkEps * C.lkEps) break;
  }
  return { dx, dy };
}

/** NCC of the template interior with cur sampled (bilinear) at displacement (dx, dy); −1 outside the frame. */
function matchNcc(p, Lv, dx, dy) {
  const P = p.P, d = Lv.data, w = Lv.w, T = p.T, X = p.x0 + dx, Y = p.y0 + dy, ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy;
  if (ix < 0 || iy < 0 || ix + P + 1 > w || iy + P + 1 > Lv.h) return -1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  let sI = 0, sII = 0, sIT = 0;
  for (let j = 1; j < P - 1; j++) {
    let r = (iy + j) * w + ix + 1, k = j * P + 1;
    for (let i = 1; i < P - 1; i++, k++, r++) {
      const I = w00 * d[r] + w10 * d[r + 1] + w01 * d[r + w] + w11 * d[r + w + 1];
      sI += I; sII += I * I; sIT += I * T[k];
    }
  }
  const n = p.nLK, mI = sI / n, vI = sII / n - mI * mI, cov = sIT / n - mI * p.meanT;
  return vI > 1e-9 && p.varT > 1e-9 ? cov / Math.sqrt(vI * p.varT) : -1;
}

/**
 * Patch displacement on cur (coarse px) given the predicted similarity; null if it cannot be searched. Every
 * search is zero-mean (truncated SAD per position, SSD at full res, the LK offset), so neither exposure changes nor
 * a large bright or dark golfer changing the frame mean can bias the background patches.
 */
function matchPatch(p, A, B, pred, params) {
  const nl = A.levels.length, Pc = params.scan.camera;
  let dx = 0, dy = 0;
  if (nl > 1) {
    const top = nl - 1, s = 1 << top, blk = p.blocks[top], half = C.blockPx / 2;
    const q = applySim(pred, (blk.bx + half) * s, (blk.by + half) * s), bx0 = Math.round(q.x / s - half), by0 = Math.round(q.y / s - half);

    // a narrow search first; the full ±coarseSearchPx only when its minimum sits on the narrow border
    const R0 = Math.min(C.narrowSearch, Pc.coarseSearchPx);
    let r = searchBlock(blk, B.levels[top], bx0, by0, R0, C.truncSad);
    if (r && R0 < Pc.coarseSearchPx && (Math.abs(r.x - bx0) >= R0 || Math.abs(r.y - by0) >= R0)) r = searchBlock(blk, B.levels[top], bx0, by0, Pc.coarseSearchPx, C.truncSad);
    if (!r) return null;
    dx = (r.x - blk.bx) * s; dy = (r.y - blk.by) * s;
    for (let l = top - 1; l >= 1; l--) {
      const sl = 1 << l, bl = p.blocks[l];
      const rr = searchBlock(bl, B.levels[l], Math.round(bl.bx + dx / sl), Math.round(bl.by + dy / sl), 1, C.truncSad);
      if (!rr) return null;
      dx = (rr.x - bl.bx) * sl; dy = (rr.y - bl.by) * sl;
    }
  } else {
    const q = applySim(pred, p.cx, p.cy);
    dx = q.x - p.cx; dy = q.y - p.cy;
  }
  // integer SSD search at full res (re-centred once if the minimum sits on the border)
  const L0 = B.levels[0], R = Pc.patchSearchPx, w = L0.w, P = p.P;
  let tx = p.x0 + Math.round(dx), ty = p.y0 + Math.round(dy), best = Infinity, bx = 0, by = 0, sx = null;
  for (let pass = 0; pass < 2; pass++) {
    const dx0 = Math.max(-R, -tx), dx1 = Math.min(R, w - P - tx), dy0 = Math.max(-R, -ty), dy1 = Math.min(R, L0.h - P - ty);
    if (dx0 > dx1 || dy0 > dy1) return null;
    const S = new Float64Array((2 * R + 1) * (2 * R + 1)).fill(Infinity);
    best = Infinity;
    for (let ey = dy0; ey <= dy1; ey++) for (let ex = dx0; ex <= dx1; ex++) {
      const v = ssdAt(p, L0.data, w, tx + ex, ty + ey);
      S[(ey + R) * (2 * R + 1) + ex + R] = v;
      if (v < best) { best = v; bx = ex; by = ey; }
    }
    sx = S;
    if ((Math.abs(bx) < R && Math.abs(by) < R) || pass) break;
    tx += bx; ty += by;
  }
  const at = (ex, ey) => (Math.abs(ex) > R || Math.abs(ey) > R ? Infinity : sx[(ey + R) * (2 * R + 1) + ex + R]);
  const parab = (a, b, c) => { const den = a - 2 * b + c; return Number.isFinite(a) && Number.isFinite(c) && den > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0; };
  const fx = parab(at(bx - 1, by), best, at(bx + 1, by)), fy = parab(at(bx, by - 1), best, at(bx, by + 1));
  const ix = tx + bx - p.x0 + fx, iy = ty + by - p.y0 + fy;
  const lk = p.ok ? lucasKanade(p, L0, ix, iy) : null;
  const m = lk && Math.hypot(lk.dx - ix, lk.dy - iy) <= C.lkMaxMovePx ? lk : { dx: ix, dy: iy };
  m.ncc = matchNcc(p, L0, m.dx, m.dy);   // a match must explain the template (flat or occluded frames do not)
  return m;
}

/* ------------------------------------------------------------------ robust similarity fit */

const median = (a, n) => {
  const s = Float64Array.from(a.subarray ? a.subarray(0, n) : a.slice(0, n)).sort();
  return n ? (n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
};

/** Weighted least-squares similarity dst ≈ S(src); rotation/scale come from `fixed` when the spread is small. */
function fitSimilarity(sx, sy, tx, ty, wt, n, minSpread, fixed) {
  let W = 0, mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { const v = wt[i]; W += v; mx += v * sx[i]; my += v * sy[i]; nx += v * tx[i]; ny += v * ty[i]; }
  if (!(W > 0)) return null;
  mx /= W; my /= W; nx /= W; ny /= W;
  let sxx = 0, sxy = 0, q = 0;
  for (let i = 0; i < n; i++) {
    const v = wt[i]; if (!v) continue;
    const ax = sx[i] - mx, ay = sy[i] - my, bx = tx[i] - nx, by = ty[i] - ny;
    sxx += v * (ax * bx + ay * by); sxy += v * (ax * by - ay * bx); q += v * (ax * ax + ay * ay);
  }
  const free = q / W >= minSpread * minSpread;
  const a = free ? sxx / q : fixed.a, b = free ? sxy / q : fixed.b;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my), free };
}

/**
 * Robust similarity over the patch measurements src (sx, sy) -> dst (tx, ty), entries in `use` (index list).
 * Start: the prior or the best single-patch translation; a hypothesis scores its support within initPx times the
 * extent of the supporting patches (camera motion moves the whole frame, a golfer is local), and the prior wins
 * at half the best score (camera motion is temporally smooth, a golfer is not). A zoom step (phone stabilization
 * or digital zoom, 2-6% in one frame on real clips) moves every patch differently, so no translation gathers
 * support: the exact similarity of each pair of patches at least minSpread apart is a hypothesis too, and the best
 * one replaces the best translation when it scores pairWin times more. Then Tukey IRLS with a trimmed MAD scale
 * (median residual of the current inlier set, floored). Returns {sim, scale} or null.
 */
function robustFit(m, use, prior, minSpread, Pc, area) {
  const { sx, sy, tx, ty } = m, n = use.length;
  const X = new Float64Array(n), Y = new Float64Array(n), U = new Float64Array(n), V = new Float64Array(n);
  for (let i = 0; i < n; i++) { const j = use[i]; X[i] = sx[j]; Y[i] = sy[j]; U[i] = tx[j]; V[i] = ty[j]; }
  const r = new Float64Array(n), wt = new Float64Array(n), dxs = new Float64Array(n), dys = new Float64Array(n), kept = new Float64Array(n);
  for (let i = 0; i < n; i++) { dxs[i] = U[i] - X[i]; dys[i] = V[i] - Y[i]; }
  const tau = C.initPx, tau2 = tau * tau;
  const score = inside => {
    let k = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < n; j++) if (inside(j)) { k++; x0 = Math.min(x0, X[j]); x1 = Math.max(x1, X[j]); y0 = Math.min(y0, Y[j]); y1 = Math.max(y1, Y[j]); }
    return k ? k * Math.sqrt(((x1 - x0 + 16) * (y1 - y0 + 16)) / area) : 0;
  };
  let bestT = -1, bestS = 0;
  for (let i = 0; i < n; i++) {
    const sc = score(j => { const ex = dxs[j] - dxs[i], ey = dys[j] - dys[i]; return ex * ex + ey * ey <= tau2; });
    if (sc > bestS) { bestS = sc; bestT = i; }
    const q = applySim(prior, X[i], Y[i]);
    r[i] = Math.hypot(U[i] - q.x, V[i] - q.y);
  }
  let bestP = null, bestPS = 0;
  const maxRot = C.pairMaxRotDeg * Math.PI / 180, spread2 = minSpread * minSpread;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ax = X[j] - X[i], ay = Y[j] - Y[i], q = ax * ax + ay * ay;
    if (q < spread2) continue;
    const bx = U[j] - U[i], by = V[j] - V[i], a = (ax * bx + ay * by) / q, b = (ax * by - ay * bx) / q;
    if (Math.abs(Math.hypot(a, b) - 1) > C.pairMaxScale || Math.abs(Math.atan2(b, a)) > maxRot) continue;
    const S = { a, b, tx: U[i] - (a * X[i] - b * Y[i]), ty: V[i] - (b * X[i] + a * Y[i]) };
    const sc = score(k => { const p = applySim(S, X[k], Y[k]), ex = U[k] - p.x, ey = V[k] - p.y; return ex * ex + ey * ey <= tau2; });
    if (sc > bestPS) { bestPS = sc; bestP = S; }
  }
  const pairWins = bestP && bestPS >= C.pairWin * bestS;
  let priorN = 0;
  for (let i = 0; i < n; i++) if (r[i] <= tau) priorN++;
  if (!(priorN >= C.minPatches && score(j => r[j] <= tau) >= 0.5 * (pairWins ? bestPS : bestS))) {
    for (let i = 0; i < n; i++) {
      if (!pairWins) { r[i] = Math.hypot(dxs[i] - dxs[bestT], dys[i] - dys[bestT]); continue; }
      const p = applySim(bestP, X[i], Y[i]);
      r[i] = Math.hypot(U[i] - p.x, V[i] - p.y);
    }
  }
  const c = Pc.tukeyC;
  const scaleOf = lim => { let k = 0; for (let i = 0; i < n; i++) if (r[i] <= lim) kept[k++] = r[i]; return Math.max(C.scaleFloorPx, 1.4826 * median(kept, k)); };
  let sim = null, scale = scaleOf(tau);
  for (let it = 0; it < Pc.irlsIters; it++) {
    for (let i = 0; i < n; i++) { const u = r[i] / (c * scale); wt[i] = u < 1 ? (1 - u * u) ** 2 : 0; }
    const f = fitSimilarity(X, Y, U, V, wt, n, minSpread, prior);
    if (!f) return null;
    sim = f;
    for (let i = 0; i < n; i++) { const q = applySim(sim, X[i], Y[i]); r[i] = Math.hypot(U[i] - q.x, V[i] - q.y); }
    scale = scaleOf(c * scale);
  }
  return { sim, scale };
}

/**
 * Similarity mapping previous-frame coarse px to current-frame coarse px (content motion), robust to the
 * golfer: SAD at 1/4 res, textured patches, IRLS Tukey (PARAMS.scan.camera). exclude: coarse boxes to ignore.
 * prev / cur: LumaImage-like {data, w, h} or motionFrame() results (prev.patches are selected once and reused).
 * Ground first: when prev's patches carry a horizon (selectPatches skyLine), the fit uses the ground patches alone
 * if at least minPatches of them agree, because drifting clouds can outvote a smooth lawn; otherwise all patches.
 * @returns {{sim:import('./types.js').Sim, inlierRatio:number, ok:boolean, residual:number, patches:number,
 *   inliers:number, rigid:boolean, ground:boolean, detail?:object[]}}  residual: RMS inlier residual (coarse px);
 *   inlierRatio = inliers / matched patches (NCC >= CAMERA_INTERNALS.minNcc), leaving out patches >= 25% inside
 *   `foreground` ({data, w, h, cellPx}: last frame's registered motion) and, for a ground-first fit, sky patches
 *   when enough remain; 0 when nothing matched
 */
export function estimateMotion(prev, cur, { prior = IDENTITY_SIM, exclude, excludeMask, foreground, params = PARAMS, detail = false } = {}) {
  const A = asFrame(prev, params), Bf = asFrame(cur, params);
  if (A.w !== Bf.w || A.h !== Bf.h) throw new HFError('bad-arg', `frame sizes differ: ${A.w}×${A.h} vs ${Bf.w}×${Bf.h}`);
  if (!A.patches) A.patches = selectPatches(A, { params, exclude, excludeMask });
  const Pc = params.scan.camera, list = A.patches, cap = list.length;
  const m = { sx: new Float64Array(cap), sy: new Float64Array(cap), tx: new Float64Array(cap), ty: new Float64Array(cap) }, idx = new Int32Array(cap), sky = new Uint8Array(cap), fg = new Uint8Array(cap);
  let n = 0, tried = 0;
  for (let k = 0; k < cap; k++) {
    const p = list[k];
    if (overlapsBoxes(p.x0, p.y0, p.P, exclude) || (excludeMask && maskFrac(p.x0, p.y0, p.P, excludeMask) >= 0.25)) continue;
    const q = matchPatch(p, A, Bf, prior, params);
    if (!q) continue;
    tried++;
    if (q.ncc < C.minNcc) continue;
    m.sx[n] = p.cx; m.sy[n] = p.cy; m.tx[n] = p.cx + q.dx; m.ty[n] = p.cy + q.dy; sky[n] = p.sky ? 1 : 0;
    fg[n] = foreground && maskFrac(p.x0, p.y0, p.P, foreground) >= 0.25 ? 1 : 0; idx[n++] = k;
  }
  const fail = { sim: { ...prior }, inlierRatio: 0, ok: false, residual: Infinity, patches: tried, inliers: 0, rigid: false, ground: false };
  if (n < C.minPatches) return fail;
  const minSpread = C.minSpreadFrac * Math.min(A.w, A.h), area = A.w * A.h, c = Pc.tukeyC, all = Array.from({ length: n }, (_, i) => i);
  const resid = (sim, i) => { const q = applySim(sim, m.sx[i], m.sy[i]); return Math.hypot(m.tx[i] - q.x, m.ty[i] - q.y); };
  let fit = null, ground = false;
  const g = all.filter(i => !sky[i]);
  if (g.length < n && g.length >= C.minPatches) {
    const fg = robustFit(m, g, prior, minSpread, Pc, area);
    if (fg) {
      const gi = g.filter(i => resid(fg.sim, i) <= c * fg.scale).length;
      if (gi >= C.minPatches) { fit = fg; ground = true; }
    }
  }
  fit ??= robustFit(m, all, prior, minSpread, Pc, area);
  if (!fit) return fail;
  const { sim, scale } = fit, r = all.map(i => resid(sim, i));
  // the ratio asks whether the model fits the visible background: unmatched (occluded) patches, patches on last
  // frame's registered motion (the golfer) and, for a ground-first fit, the sky (drifting clouds) stay out of its
  // denominator
  let inl = 0, ss = 0, bgN = 0, bgIn = 0;
  for (let i = 0; i < n; i++) {
    const isIn = r[i] <= c * scale;
    if (isIn) { inl++; ss += r[i] * r[i]; }
    if (!fg[i] && !(ground && sky[i])) { bgN++; if (isIn) bgIn++; }
  }
  const ratio = bgN >= C.minPatches ? bgIn / bgN : inl / n;
  const out = {
    sim: { a: sim.a, b: sim.b, tx: sim.tx, ty: sim.ty }, inlierRatio: ratio, ok: inl >= C.minPatches,
    residual: inl ? Math.sqrt(ss / inl) : Infinity, patches: tried, inliers: inl, rigid: sim.free, ground
  };
  if (detail) out.detail = all.map(i => ({ x: m.sx[i], y: m.sy[i], dx: m.tx[i] - m.sx[i], dy: m.ty[i] - m.sy[i], r: r[i], inlier: r[i] <= c * scale, patch: idx[i], sky: !!sky[i] }));
  return out;
}

/* ------------------------------------------------------------------ camera path */

const GROW = n => Math.max(64, n * 2);
function grow(a, n) { if (n <= a.length) return a; const b = new a.constructor(GROW(n)); b.set(a); return b; }

/** Stabilized-to-raw similarities per analyzed frame; entry 0 is the identity reference. */
export class CameraPath {
  /** @param {import('./types.js').SourceMeta} meta  @param {{pool:number}} o  coarse pooling factor of the estimates */
  constructor(meta, { pool = 1 } = {}) {
    if (!(Number.isInteger(pool) && pool > 0)) throw new HFError('bad-arg', `pool ${pool}`);
    this.meta = meta; this.pool = pool; this.n = 0;
    this._index = new Int32Array(64); this._t = new Float64Array(64); this._sim = new Float64Array(256); this._inlier = new Float32Array(64);
  }
  get length() { return this.n; }
  /**
   * est null (or est.ok false): hold the previous similarity, inlier 0. Otherwise est.sim (coarse px) maps raw
   * coords of the reference entry est.ref (a frame index; default the previous entry) to this frame's raw coords.
   */
  push(index, t, est) {
    const n = this.n;
    if (!Number.isInteger(index) || (n && index <= this._index[n - 1])) throw new HFError('bad-arg', `camera index ${index} not increasing`);
    this._index = grow(this._index, n + 1); this._t = grow(this._t, n + 1); this._inlier = grow(this._inlier, n + 1); this._sim = grow(this._sim, 4 * n + 4);
    let s = IDENTITY_SIM, inl = 1;
    if (n) {
      if (!est || est.ok === false) { s = this.at(n - 1); inl = 0; }
      else {
        const k = est.ref == null ? n - 1 : this.entryOf(est.ref);
        if (k < 0) throw new HFError('bad-arg', `camera reference frame ${est.ref} not in the path`);
        s = composeSim({ a: est.sim.a, b: est.sim.b, tx: est.sim.tx * this.pool, ty: est.sim.ty * this.pool }, this.at(k));
        inl = Math.max(0, Math.min(1, est.inlierRatio ?? 1));
      }
    }
    this._index[n] = index; this._t[n] = t; this._inlier[n] = inl;
    this._sim.set([s.a, s.b, s.tx, s.ty], 4 * n);
    this.n = n + 1;
    return s;
  }
  /** Entry k's similarity (stabilized native px -> raw native px). */
  at(k) { const o = 4 * k, s = this._sim; return { a: s[o], b: s[o + 1], tx: s[o + 2], ty: s[o + 3] }; }
  /** Entry position of a frame index, or −1. */
  entryOf(index) {
    let lo = 0, hi = this.n - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, v = this._index[m]; if (v === index) return m; if (v < index) lo = m + 1; else hi = m - 1; }
    return -1;
  }
  /** Similarity at any frame index: exact at entries, linear between, clamped outside (as types.simAt). */
  simAt(index) {
    const n = this.n, ix = this._index;
    if (!n) return IDENTITY_SIM;
    if (index <= ix[0]) return this.at(0);
    if (index >= ix[n - 1]) return this.at(n - 1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ix[m] <= index) lo = m; else hi = m; }
    const u = (index - ix[lo]) / (ix[hi] - ix[lo]), A = this.at(lo), B = this.at(hi), mix = (p, q) => p + (q - p) * u;
    return { a: mix(A.a, B.a), b: mix(A.b, B.b), tx: mix(A.tx, B.tx), ty: mix(A.ty, B.ty) };
  }
  /** Raw native px of frame `index` -> stabilized native px. */
  toStab(index, x, y) { return applySim(invertSim(this.simAt(index)), x, y); }
  /** Stabilized native px -> raw native px of frame `index`. */
  fromStab(index, x, y) { return applySim(this.simAt(index), x, y); }
  /** @returns {import('./types.js').CameraTrack} copies */
  track() {
    const n = this.n;
    return { index: this._index.slice(0, n), t: this._t.slice(0, n), sim: this._sim.slice(0, 4 * n), inlier: this._inlier.slice(0, n) };
  }
  /** Result camera samples {t, x, y, s, r} (types.cameraSamples). */
  samples() { return cameraSamples(this.track(), this.meta); }
  /** Translation-only samples {t, x, y} for v2-style renderers: normalized raw − stabilized at the frame centre. */
  translationTrack() { return this.samples().map(({ t, x, y }) => ({ t, x, y })); }
}

/* ------------------------------------------------------------------ keyframe tracker */

/**
 * Matches every frame against a keyframe (no frame-to-frame drift), falls back to the previous frame when the
 * key match fails, and holds the previous similarity (inlier 0) when both fail. The key is replaced only when
 * most of its patches leave the view, the motion relative to it grows large, fewer than 2·minPatches agree, or
 * the inlier ratio drops below scan.camera.minInlierRatio (the golfer settled in front of its patches): a swing
 * that hides most patches for a second is an occlusion, not a reason to drop a good key. With a horizon
 * (setSkyLine, stabilized native px) every key fills its patch budget from the ground first.
 */
export class MotionTracker {
  constructor(meta, { pool = 1, params = PARAMS } = {}) {
    this.params = params; this.pool = pool; this.path = new CameraPath(meta, { pool });
    this.key = null; this.keyIndex = -1; this.keyPatches = 0; this.prev = null; this.prevIndex = -1; this.skyLine = null;
    this.stats = { frames: 0, keyRefresh: 0, fallback: 0, held: 0 };
  }
  /** Raw-to-raw native similarity from frame entry ka to entry kb, in coarse px (for priors and energy). */
  relCoarse(ka, kb) {
    const m = composeSim(this.path.at(kb), invertSim(this.path.at(ka)));
    return { a: m.a, b: m.b, tx: m.tx / this.pool, ty: m.ty / this.pool };
  }
  /**
   * frame: motionFrame() of the current coarse image (its buffers must stay valid until the next push returns).
   * exclude: coarse raw boxes (lens specks) whose patches are skipped. Returns {S: stabilized->raw native
   * similarity, est, ok}; call maybeRefreshKey afterwards.
   */
  push(index, t, frame, { exclude, excludeMask, foreground } = {}) {
    this.stats.frames++;
    const path = this.path;
    if (!path.length) {
      const S = path.push(index, t, null);
      this.setKey(frame, index, { exclude, excludeMask });
      this.prev = frame; this.prevIndex = index;
      return { S, est: null, ok: true };
    }
    const kk = path.entryOf(this.keyIndex), kp = path.length - 1;
    // an estimate with minPatches inliers is used even when the golfer hides most patches (the inlier ratio is
    // recorded for R4); the previous frame is tried only when the key gives no usable estimate
    let est = estimateMotion(this.key, frame, { prior: this.relCoarse(kk, kp), exclude, foreground, params: this.params });
    est.ref = this.keyIndex;
    let ok = est.ok;
    if (!ok && this.prev !== this.key) {
      this.stats.fallback++;
      if (!this.prev.patches) this.prev.patches = selectPatches(this.prev, { params: this.params, exclude, excludeMask, skyLine: this.skyLineAt(path.entryOf(this.prevIndex)) });
      const e2 = estimateMotion(this.prev, frame, { prior: IDENTITY_SIM, exclude, foreground, params: this.params });
      e2.ref = this.prevIndex;
      if (e2.ok) { est = e2; ok = true; this.needKey = true; }
    }
    if (!ok) this.stats.held++;
    const S = path.push(index, t, ok ? est : null);
    // a new key only when the old one is leaving the view, deforming, or weakly supported (an occlusion passes)
    if (ok && !this.needKey) {
      const K = C.key, m = est.sim, sc = Math.hypot(m.a, m.b), q = applySim(m, frame.w / 2, frame.h / 2);
      // ... or when most of its visible patches no longer agree although the estimate holds (the golfer settled
      // into a new pose in front of them): the new key, chosen off recent motion, is all background
      this.needKey = est.patches < K.minInlierFrac * this.keyPatches || est.inliers < 2 * C.minPatches
        || est.inlierRatio < this.params.scan.camera.minInlierRatio
        || Math.hypot(q.x - frame.w / 2, q.y - frame.h / 2) > K.maxShiftFrac * Math.min(frame.w, frame.h)
        || Math.abs(Math.atan2(m.b, m.a)) > K.maxRotDeg * Math.PI / 180 || Math.abs(sc - 1) > K.maxScale;
    }
    this.prev = frame; this.prevIndex = index;
    return { S, est, ok };
  }
  /** Make frame the keyframe when the last push asked for it (or force). */
  maybeRefreshKey(frame, index, opts = {}, force = false) {
    if (!(this.needKey || force)) return false;
    this.setKey(frame, index, opts);
    this.stats.keyRefresh++;
    return true;
  }
  /** Horizon {slope, y0} in stabilized native px (or null): later keyframes keep their patches on the ground. */
  setSkyLine(line) { this.skyLine = line; }
  skyLineAt(entry) {
    if (!this.skyLine || entry < 0) return undefined;
    const S = this.path.at(entry), L = this.skyLine, x1 = 1000, P = this.pool;
    const a = applySim(S, 0, L.y0), b = applySim(S, x1, L.y0 + L.slope * x1), slope = (b.y - a.y) / (b.x - a.x);
    return { slope, y0: (a.y - slope * a.x) / P };
  }
  setKey(frame, index, { exclude, excludeMask } = {}) {
    const skyLine = this.skyLineAt(this.path.entryOf(index));
    frame.patches = selectPatches(frame, { params: this.params, exclude, excludeMask, skyLine });
    this.key = frame; this.keyIndex = index; this.keyPatches = frame.patches.length; this.needKey = false;
  }
}
