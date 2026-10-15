/**
 * Luma plane kernels (U1). Every source turns its decoder output into a full-range 8-bit luma plane in display
 * orientation and pools it exactly as types.js poolLuma / cropLuma (bit for bit). The fused kernels here
 * (poolPlane, cropPlane) work on the coded plane directly: sample -> 8-bit full range through a lookup table
 * (10/12-bit shift, limited-range expansion), rotation by index walking, then the reference pooling, so the hot
 * path never materializes a rotated or expanded full-resolution copy.
 */
import { HFError, poolLuma, cropLuma } from '../types.js';
import { PARAMS } from '../params.js';
import { displaySize, displayWalk, displayRectToCoded } from './orient.js';

export { poolLuma, cropLuma };

const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const outBuf = (out, n) => {
  if (!out) return new Uint8Array(n);
  if (out.length < n) throw new HFError('bad-arg', `out buffer ${out.length} < ${n}`);
  return out.length === n ? out : out.subarray(0, n);
};
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const luts = new Map();
/**
 * Table from a decoded sample value to full-range 8-bit luma: shift by bits − 8 (10-bit: decode.tenBitShift),
 * then for limited range Y' = clamp(round((Y − 16)·255/219), 0, 255) (levels from decode.limitedRange).
 * Returns null for the identity (8-bit full range).
 */
export function lumaLut(bits = 8, limited = false, params = PARAMS) {
  if (bits === 8 && !limited) return null;
  const shift = bits === 10 ? params.decode.tenBitShift : bits - 8, [lo, hi] = params.decode.limitedRange;
  const key = `${bits}/${shift}/${limited ? `${lo}-${hi}` : 'full'}`;
  let lut = luts.get(key);
  if (!lut) {
    if (!(shift >= 0 && bits <= 16)) throw new HFError('bad-arg', `bit depth ${bits}`);
    lut = new Uint8Array(1 << bits);
    for (let v = 0; v < lut.length; v++) {
      const y = Math.min(255, v >> shift);
      lut[v] = limited ? clampI(Math.round((y - lo) * 255 / (hi - lo)), 0, 255) : y;
    }
    luts.set(key, lut);
  }
  return lut;
}

/** Limited-range 8-bit luma to full range (the decode.limitedRange formula, as a table). */
export function expandLimitedRange(src, out) {
  const lut = lumaLut(8, true), o = outBuf(out, src.length);
  for (let i = 0; i < src.length; i++) o[i] = lut[src[i]];
  return o;
}

/** High-bit-depth samples (Uint16Array) to 8 bits by a right shift (10-bit: shift = decode.tenBitShift). */
export function shiftTo8(src16, shift = PARAMS.decode.tenBitShift, out) {
  const o = outBuf(out, src16.length);
  for (let i = 0; i < src16.length; i++) o[i] = Math.min(255, src16[i] >> shift);
  return o;
}

/** Rotate a tightly packed w × h plane clockwise by rotation into display orientation. */
export function rotatePlane(src, w, h, rotation, out) {
  const { width: W, height: H } = displaySize(w, h, rotation), data = outBuf(out, W * H);
  if (rotation === 0) { data.set(src.subarray(0, W * H)); return { data, w: W, h: H }; }
  const { base, step } = displayWalk(rotation, w, h, w);
  for (let Y = 0, o = 0; Y < H; Y++) for (let X = 0, k = base(Y); X < W; X++, k += step) data[o++] = src[k];
  return { data, w: W, h: H };
}

/**
 * Luma from 4-byte RGBA (or BGRA with bgr) pixels: hd (BT.709) (54R + 183G + 19B + 128) >> 8, else BT.601
 * (77R + 150G + 29B + 128) >> 8. stride in pixels (default w).
 */
export function rgbaToLuma(rgba, w, h, { hd = true, bgr = false, stride = w } = {}, out) {
  const o = outBuf(out, w * h), [kr, kg, kb] = hd ? [54, 183, 19] : [77, 150, 29];
  const r = bgr ? 2 : 0, b = bgr ? 0 : 2;
  for (let y = 0, q = 0; y < h; y++) {
    for (let x = 0, p = y * stride * 4; x < w; x++, p += 4) o[q++] = (kr * rgba[p + r] + kg * rgba[p + 1] + kb * rgba[p + b] + 128) >> 8;
  }
  return o;
}

const pairs = new WeakMap();
// Sum of the table values of two packed 8-bit samples, indexed by their little-endian 16-bit word.
const pairTable = lut => {
  let t = pairs.get(lut);
  if (!t) { t = new Uint16Array(65536); for (let v = 0; v < 65536; v++) t[v] = lut[v & 255] + lut[v >> 8]; pairs.set(lut, t); }
  return t;
};

// Rounded means of pool × pool blocks starting at (ox, oy) of a coded plane, sample values mapped through lut,
// written to dst[base(j) + i·step] for block (i, j) (so a rotated result needs no second pass).
// Pools 2 and 4 (1080p and 4K to a 960 long edge) read their rows as parallel word streams with no accumulator
// array; with a table, two packed samples are looked up at once (pairTable). The fused range expansion then costs
// about 0.4 ms over plain pooling at 4K, instead of a 4 ms separate table pass.
function poolBlocks(src, stride, ox, oy, pw, ph, pool, lut, dst, base, step) {
  const eight = src.BYTES_PER_ELEMENT === 1, al = n => LE && stride % n === 0 && ox % n === 0 && src.byteOffset % n === 0;
  const view = (T, n) => new T(src.buffer, src.byteOffset, src.length / n | 0);
  if (eight && (pool === 2 || pool === 4) && al(pool === 4 && !lut ? 4 : 2)) {
    const table = lut ? pairTable(lut) : null;
    if (pool === 2) return pool2(view(Uint16Array, 2), stride >> 1, ox >> 1, oy, pw, ph, table, dst, base, step);
    if (!table) return pool4Words(view(Uint32Array, 4), stride >> 2, ox >> 2, oy, pw, ph, dst, base, step);
    if (al(4)) return pool4Pairs32(view(Uint32Array, 4), stride >> 2, ox >> 2, oy, pw, ph, table, dst, base, step);
    return pool4Pairs16(view(Uint16Array, 2), stride >> 1, ox >> 1, oy, pw, ph, table, dst, base, step);
  }
  if (eight && lut && LE && pool % 2 === 0 && al(2)) return sumPairs(view(Uint16Array, 2), stride >> 1, ox >> 1, oy, pw, ph, pool, pairTable(lut), dst, base, step);
  return lut ? sumLut(src, stride, ox, oy, pw, ph, pool, lut, dst, base, step) : sumPlain(src, stride, ox, oy, pw, ph, pool, dst, base, step);
}
function pool2(w, sw, ox, oy, pw, ph, table, dst, base, step) {
  for (let j = 0; j < ph; j++) {
    let k0 = (oy + 2 * j) * sw + ox, k1 = k0 + sw, o = base(j);
    if (table) for (let i = 0; i < pw; i++, o += step) dst[o] = (table[w[k0++]] + table[w[k1++]] + 2) >> 2;
    else for (let i = 0; i < pw; i++, o += step) { const a = w[k0++], b = w[k1++]; dst[o] = ((a & 255) + (a >>> 8) + (b & 255) + (b >>> 8) + 2) >> 2; }
  }
}
function pool4Words(w, sw, ox, oy, pw, ph, dst, base, step) {
  for (let j = 0; j < ph; j++) {
    let k0 = (oy + 4 * j) * sw + ox, k1 = k0 + sw, k2 = k1 + sw, k3 = k2 + sw, o = base(j);
    for (let i = 0; i < pw; i++, o += step) {
      const a = w[k0++], b = w[k1++], c = w[k2++], d = w[k3++];
      const s = (a & 0xff00ff) + ((a >>> 8) & 0xff00ff) + (b & 0xff00ff) + ((b >>> 8) & 0xff00ff) + (c & 0xff00ff) + ((c >>> 8) & 0xff00ff) + (d & 0xff00ff) + ((d >>> 8) & 0xff00ff);
      dst[o] = ((s & 0xffff) + (s >>> 16) + 8) >> 4;
    }
  }
}
function pool4Pairs32(w, sw, ox, oy, pw, ph, t, dst, base, step) {
  for (let j = 0; j < ph; j++) {
    let k0 = (oy + 4 * j) * sw + ox, k1 = k0 + sw, k2 = k1 + sw, k3 = k2 + sw, o = base(j);
    for (let i = 0; i < pw; i++, o += step) {
      const a = w[k0++], b = w[k1++], c = w[k2++], d = w[k3++];
      dst[o] = (t[a & 0xffff] + t[a >>> 16] + t[b & 0xffff] + t[b >>> 16] + t[c & 0xffff] + t[c >>> 16] + t[d & 0xffff] + t[d >>> 16] + 8) >> 4;
    }
  }
}
function pool4Pairs16(w, sw, ox, oy, pw, ph, t, dst, base, step) {
  for (let j = 0; j < ph; j++) {
    let k0 = (oy + 4 * j) * sw + ox, k1 = k0 + sw, k2 = k1 + sw, k3 = k2 + sw, o = base(j);
    for (let i = 0; i < pw; i++, o += step, k0 += 2, k1 += 2, k2 += 2, k3 += 2) {
      dst[o] = (t[w[k0]] + t[w[k0 + 1]] + t[w[k1]] + t[w[k1 + 1]] + t[w[k2]] + t[w[k2 + 1]] + t[w[k3]] + t[w[k3 + 1]] + 8) >> 4;
    }
  }
}
function finishRow(acc, dst, o, step, pw, pool) {
  const area = pool * pool, half = area >> 1;
  for (let i = 0; i < pw; i++, o += step) dst[o] = (acc[i] + half) / area | 0;
}
function sumPairs(words, strideW, oxW, oy, pw, ph, pool, table, dst, base, step) {
  const acc = new Uint32Array(pw), hp = pool >> 1;
  for (let j = 0; j < ph; j++) {
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      let k = (oy + j * pool + q) * strideW + oxW;
      for (let i = 0; i < pw; i++) { let s = 0; for (let m = 0; m < hp; m++) s += table[words[k++]]; acc[i] += s; }
    }
    finishRow(acc, dst, base(j), step, pw, pool);
  }
}
function sumPlain(src, stride, ox, oy, pw, ph, pool, dst, base, step) {
  const acc = new Uint32Array(pw);
  for (let j = 0; j < ph; j++) {
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      let p = (oy + j * pool + q) * stride + ox;
      if (pool === 2) for (let i = 0; i < pw; i++, p += 2) acc[i] += src[p] + src[p + 1];
      else if (pool === 4) for (let i = 0; i < pw; i++, p += 4) acc[i] += src[p] + src[p + 1] + src[p + 2] + src[p + 3];
      else for (let i = 0; i < pw; i++) { let s = 0; for (let m = 0; m < pool; m++) s += src[p++]; acc[i] += s; }
    }
    finishRow(acc, dst, base(j), step, pw, pool);
  }
}
function sumLut(src, stride, ox, oy, pw, ph, pool, lut, dst, base, step) {
  const acc = new Uint32Array(pw);
  for (let j = 0; j < ph; j++) {
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      let p = (oy + j * pool + q) * stride + ox;
      if (pool === 2) for (let i = 0; i < pw; i++, p += 2) acc[i] += lut[src[p]] + lut[src[p + 1]];
      else if (pool === 4) for (let i = 0; i < pw; i++, p += 4) acc[i] += lut[src[p]] + lut[src[p + 1]] + lut[src[p + 2]] + lut[src[p + 3]];
      else for (let i = 0; i < pw; i++) { let s = 0; for (let m = 0; m < pool; m++) s += lut[src[p++]]; acc[i] += s; }
    }
    finishRow(acc, dst, base(j), step, pw, pool);
  }
}

/**
 * poolLuma of the display-orientation full-range plane, computed from the coded plane: equals
 * poolLuma(rotatePlane(lut(src)), W, H, pool) bit for bit. src: Uint8Array or Uint16Array, cw × ch samples with
 * row stride `stride` (samples); lut from lumaLut (null = 8-bit identity).
 * @returns {import('../types.js').LumaImage}
 */
export function poolPlane(src, cw, ch, stride, rotation, pool, lut = null, out) {
  if (!(Number.isInteger(pool) && pool > 0)) throw new HFError('bad-arg', `pool ${pool}`);
  if (src.BYTES_PER_ELEMENT !== 1 && !lut) throw new HFError('bad-arg', 'high bit depth planes need a lut');
  if (pool === 1 && rotation === 0 && !lut && stride === cw) return poolLuma(src, cw, ch, pool, out);
  // Coded blocks that make up the display grid: display trailing partial rows/columns are dropped, which for a
  // rotated image are the coded left/top ones, so the coded grid starts at the remainder there. Block (i, j) is
  // written straight to its display position.
  const pw = Math.floor(cw / pool), ph = Math.floor(ch / pool);
  const ox = rotation === 180 || rotation === 270 ? cw - pw * pool : 0, oy = rotation === 90 || rotation === 180 ? ch - ph * pool : 0;
  const data = outBuf(out, pw * ph), turned = rotation % 180 !== 0;
  const [base, step] = rotation === 0 ? [j => j * pw, 1] : rotation === 90 ? [j => ph - 1 - j, ph] : rotation === 180 ? [j => (ph - 1 - j) * pw + pw - 1, -1] : [j => (pw - 1) * ph + j, -ph];
  poolBlocks(src, stride, ox, oy, pw, ph, pool, lut, data, base, step);
  return { data, w: turned ? ph : pw, h: turned ? pw : ph, pool };
}

/** The `valid` box cropLuma reports for rect on a W × H image. */
export function validBox(rect, W, H, pool) {
  const w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool);
  const x0 = clampI(Math.ceil(-rect.x / pool), 0, w), y0 = clampI(Math.ceil(-rect.y / pool), 0, h);
  return { x0, y0, x1: clampI(Math.floor((W - rect.x) / pool), x0, w), y1: clampI(Math.floor((H - rect.y) / pool), y0, h) };
}

/** Display px read by cropLuma for rect (its clamped footprint), as a rect inside the W × H image. */
export function cropFootprint(rect, W, H, pool) {
  const w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool);
  const x0 = clampI(rect.x, 0, W - 1), y0 = clampI(rect.y, 0, H - 1);
  return { x: x0, y: y0, w: clampI(rect.x + w * pool - 1, 0, W - 1) + 1 - x0, h: clampI(rect.y + h * pool - 1, 0, H - 1) + 1 - y0 };
}

const checkRect = (rect, pool) => {
  const ok = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) && Number.isInteger(pool) && pool > 0 && rect.w >= pool && rect.h >= pool;
  if (!ok) throw new HFError('bad-arg', `rect ${JSON.stringify(rect)} with pool ${pool}`);
};

/**
 * cropLuma(lut(src)) for a whole upright plane (rotation 0, W × H, stride W) with the table applied inside the
 * pooling loop, so no converted window is materialized (node and element planes, and the full codec copy).
 * Same sums, edge clamping and rounding as cropLuma, so bit for bit equal.
 */
function cropUprightLut(src, W, H, rect, pool, lut, out) {
  const { x, y } = rect, w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool), data = outBuf(out, w * h);
  const area = pool * pool, half = area >> 1, W1 = W - 1;
  // As cropLuma: edge columns [0, iL) and [iR, w) are one value per row, [iA, iB) is read directly, the rest is mixed.
  const iL = clampI(Math.floor((1 - x) / pool), 0, w), iR = clampI(Math.ceil((W1 - x) / pool), iL, w);
  const iA = clampI(Math.ceil(-x / pool), iL, iR), iB = clampI(Math.floor((W - x) / pool), iA, iR), m = iB - iA, mx = x + iA * pool;
  const rows = new Int32Array(pool), acc = pool > 1 ? new Uint32Array(m) : null;
  const mixed = (i, o) => { let s = 0; for (let q = 0; q < pool; q++) for (let k = 0, c = x + i * pool; k < pool; k++, c++) s += lut[src[rows[q] + clampI(c, 0, W1)]]; data[o + i] = (s + half) / area | 0; };
  for (let j = 0; j < h; j++) {
    const o = j * w, om = o + iA;
    for (let q = 0; q < pool; q++) rows[q] = clampI(y + j * pool + q, 0, H - 1) * W;
    if (iL || iR < w) {
      let l = 0, r = 0;
      for (let q = 0; q < pool; q++) { l += lut[src[rows[q]]]; r += lut[src[rows[q] + W1]]; }
      if (iL) data.fill((pool * l + half) / area | 0, o, o + iL);
      if (iR < w) data.fill((pool * r + half) / area | 0, o + iR, o + w);
    }
    for (let i = iL; i < iA; i++) mixed(i, o);
    for (let i = iB; i < iR; i++) mixed(i, o);
    if (!m) continue;
    if (pool === 1) { for (let i = 0, p = rows[0] + mx; i < m; i++) data[om + i] = lut[src[p++]]; continue; }
    if (pool === 2) {
      for (let i = 0, p0 = rows[0] + mx, p1 = rows[1] + mx; i < m; i++, p0 += 2, p1 += 2) data[om + i] = (lut[src[p0]] + lut[src[p0 + 1]] + lut[src[p1]] + lut[src[p1 + 1]] + 2) >> 2;
      continue;
    }
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      const p = rows[q] + mx;
      if (pool === 3) for (let i = 0, k = p; i < m; i++, k += 3) acc[i] += lut[src[k]] + lut[src[k + 1]] + lut[src[k + 2]];
      else if (pool === 4) for (let i = 0, k = p; i < m; i++, k += 4) acc[i] += lut[src[k]] + lut[src[k + 1]] + lut[src[k + 2]] + lut[src[k + 3]];
      else for (let i = 0, k = p; i < m; i++) { let t = 0; for (let e = 0; e < pool; e++) t += lut[src[k++]]; acc[i] += t; }
    }
    for (let i = 0; i < m; i++) data[om + i] = (acc[i] + half) / area | 0;
  }
  return { data, w, h, x0: x, y0: y, pool, valid: validBox(rect, W, H, pool) };
}

/**
 * cropLuma of the display-orientation full-range plane, read from a coded window: equals
 * cropLuma(rotatePlane(lut(full)), W, H, rect, pool) bit for bit. The window src (sw × sh samples, row stride
 * `stride`) holds coded px [sx0, sx0 + sw) × [sy0, sy0 + sh) of a cw × ch coded frame and must cover the coded
 * image of cropFootprint(rect).
 * @returns {import('../types.js').LumaCrop}
 */
export function cropPlane(src, sw, sh, stride, sx0, sy0, cw, ch, rotation, rect, pool = 1, lut = null, out) {
  checkRect(rect, pool);
  const { width: W, height: H } = displaySize(cw, ch, rotation);
  if (rotation === 0 && sx0 === 0 && sy0 === 0 && sw === cw && sh === ch && stride === cw) return lut ? cropUprightLut(src, cw, ch, rect, pool, lut, out) : cropLuma(src, cw, ch, rect, pool, out);
  const f = cropFootprint(rect, W, H, pool), c = displayRectToCoded(f, rotation, cw, ch);
  if (c.x < sx0 || c.y < sy0 || c.x + c.w > sx0 + sw || c.y + c.h > sy0 + sh) throw new HFError('internal', `window does not cover ${JSON.stringify(c)}`);
  const win = new Uint8Array(f.w * f.h), { base, step } = displayWalk(rotation, cw, ch, stride, sx0, sy0);
  for (let Y = f.y, o = 0; Y < f.y + f.h; Y++) {
    let k = base(Y) + f.x * step;
    if (lut) for (let X = 0; X < f.w; X++, k += step) win[o++] = lut[src[k]];
    else for (let X = 0; X < f.w; X++, k += step) win[o++] = src[k];
  }
  const crop = cropLuma(win, f.w, f.h, { x: rect.x - f.x, y: rect.y - f.y, w: rect.w, h: rect.h }, pool, out);
  return { data: crop.data, w: crop.w, h: crop.h, x0: rect.x, y0: rect.y, pool, valid: validBox(rect, W, H, pool) };
}
