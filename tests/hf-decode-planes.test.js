import test from 'node:test';
import assert from 'node:assert/strict';
import { poolLuma, cropLuma, HFError } from '../dist/hf/types.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { displaySize, codedToDisplay, displayToCoded, displayRectToCoded, codedRectToDisplay, displayWalk } from '../dist/hf/decode/orient.js';
import { lumaLut, expandLimitedRange, shiftTo8, rotatePlane, rgbaToLuma, poolPlane, cropPlane, validBox, cropFootprint } from '../dist/hf/decode/planes.js';
import * as planes from '../dist/hf/decode/planes.js';

let seed = 1;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const randPlane = (n, bits = 8) => { const a = bits > 8 ? new Uint16Array(n) : new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = Math.floor(rnd() * (1 << bits)); return a; };
const same = (a, b, msg) => { assert.equal(a.length, b.length, `${msg}: length`); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${msg}: element ${i} ${a[i]} != ${b[i]}`); };
const ROT = [0, 90, 180, 270];
/** Reference: display-orientation full-range plane, built pixel by pixel from the protocol formulas. */
function referenceUpright(src, cw, ch, rotation, lut) {
  const { width: W, height: H } = displaySize(cw, ch, rotation), out = new Uint8Array(W * H);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const d = codedToDisplay(x + 0.5, y + 0.5, rotation, cw, ch); // pixel centres map to pixel centres
    const v = src[y * cw + x];
    out[Math.floor(d.y) * W + Math.floor(d.x)] = lut ? lut[v] : v;
  }
  return { data: out, w: W, h: H };
}

/* ---------------------------------------------------------------- orient */

test('rotation formulas match the protocol doc: 90° (ch − y, x), 180° (cw − x, ch − y), 270° (y, cw − x)', () => {
  const cw = 40, ch = 30;
  assert.deepEqual(codedToDisplay(3, 5, 0, cw, ch), { x: 3, y: 5 });
  assert.deepEqual(codedToDisplay(3, 5, 90, cw, ch), { x: 25, y: 3 });
  assert.deepEqual(codedToDisplay(3, 5, 180, cw, ch), { x: 37, y: 25 });
  assert.deepEqual(codedToDisplay(3, 5, 270, cw, ch), { x: 5, y: 37 });
  // Clockwise: the coded top-left corner ends at the display top-right for 90°, bottom-left for 270°.
  assert.deepEqual(codedToDisplay(0, 0, 90, cw, ch), { x: ch, y: 0 });
  assert.deepEqual(codedToDisplay(0, 0, 270, cw, ch), { x: 0, y: cw });
  assert.deepEqual(displaySize(cw, ch, 90), { width: ch, height: cw });
  assert.deepEqual(displaySize(cw, ch, 180), { width: cw, height: ch });
  assert.throws(() => displaySize(cw, ch, 45), HFError);
  for (const r of ROT) for (const [x, y] of [[0, 0], [3.25, 7.5], [cw, ch], [12, 0]]) {
    const d = codedToDisplay(x, y, r, cw, ch), c = displayToCoded(d.x, d.y, r, cw, ch);
    assert.ok(Math.abs(c.x - x) < 1e-12 && Math.abs(c.y - y) < 1e-12, `round trip ${r}`);
  }
});

test('displayRectToCoded covers exactly the rect; codedRectToDisplay inverts it', () => {
  const cw = 40, ch = 30;
  for (const r of ROT) {
    const { width: W, height: H } = displaySize(cw, ch, r);
    for (const rect of [{ x: 0, y: 0, w: W, h: H }, { x: 3, y: 4, w: 5, h: 7 }, { x: W - 2, y: H - 3, w: 2, h: 3 }]) {
      const c = displayRectToCoded(rect, r, cw, ch);
      assert.equal(c.w * c.h, rect.w * rect.h, `area ${r}`);
      assert.deepEqual(codedRectToDisplay(c, r, cw, ch), rect);
      for (let Y = rect.y; Y < rect.y + rect.h; Y++) for (let X = rect.x; X < rect.x + rect.w; X++) {
        const p = displayToCoded(X + 0.5, Y + 0.5, r, cw, ch);
        assert.ok(p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h, `pixel ${X},${Y} inside the coded cover (rotation ${r})`);
      }
    }
  }
});

test('displayWalk addresses the coded pixel under each display pixel, for windows too', () => {
  const cw = 9, ch = 7;
  for (const r of ROT) {
    const { width: W, height: H } = displaySize(cw, ch, r);
    for (const [sx0, sy0, stride] of [[0, 0, cw], [2, 3, 12]]) {
      const { base, step } = displayWalk(r, cw, ch, stride, sx0, sy0);
      for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
        const p = displayToCoded(X + 0.5, Y + 0.5, r, cw, ch), x = Math.floor(p.x), y = Math.floor(p.y);
        assert.equal(base(Y) + X * step, (y - sy0) * stride + (x - sx0), `rotation ${r} (${X}, ${Y})`);
      }
    }
  }
});

/* ---------------------------------------------------------------- value maps */

test('limited-range expansion is clamp(round((Y − 16)·255/219)) from decode.limitedRange', () => {
  const lut = lumaLut(8, true);
  assert.equal(lut[16], 0);
  assert.equal(lut[235], 255);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 255);
  assert.equal(lut[128], Math.round(112 * 255 / 219));
  for (let v = 0; v < 256; v++) assert.equal(lut[v], Math.min(255, Math.max(0, Math.round((v - 16) * 255 / 219))), `Y=${v}`);
  same(expandLimitedRange(Uint8Array.from([0, 16, 17, 126, 235, 240])), Uint8Array.from([0, 0, 1, Math.round(110 * 255 / 219), 255, 255]), 'expand');
  assert.equal(lumaLut(8, false), null, '8-bit full range is the identity');
  const custom = lumaLut(8, true, mergeParams({ decode: { limitedRange: [32, 223] } }));
  assert.equal(custom[32], 0);
  assert.equal(custom[223], 255);
});

test('10-bit samples shift right by decode.tenBitShift, then expand; 12-bit by 4', () => {
  assert.equal(PARAMS.decode.tenBitShift, 2);
  same(shiftTo8(Uint16Array.from([0, 3, 4, 512, 1023, 4095])), Uint8Array.from([0, 0, 1, 128, 255, 255]), 'shift');
  const l10 = lumaLut(10, false), l10l = lumaLut(10, true), l12 = lumaLut(12, false), lim = lumaLut(8, true);
  assert.equal(l10.length, 1024);
  for (const v of [0, 64, 513, 940, 1023]) { assert.equal(l10[v], v >> 2); assert.equal(l10l[v], lim[v >> 2]); }
  assert.equal(l12[4095], 255);
  assert.equal(l12[1600], 100);
});

test('rgbaToLuma: BT.709 (54, 183, 19) when hd, BT.601 (77, 150, 29) otherwise, BGR order swaps', () => {
  const px = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  same(rgbaToLuma(px, 4, 1, { hd: true }), Uint8Array.from([54, 182, 19, 255]), 'hd');
  same(rgbaToLuma(px, 4, 1, { hd: false }), Uint8Array.from([77, 149, 29, 255]), 'sd');
  same(rgbaToLuma(px, 4, 1, { hd: true, bgr: true }), Uint8Array.from([19, 182, 54, 255]), 'bgr');
  const strided = new Uint8Array(4 * 4 * 2); strided.set(px.subarray(0, 8), 0); strided.set(px.subarray(8), 16);
  same(rgbaToLuma(strided, 2, 2, { stride: 4 }), Uint8Array.from([54, 182, 19, 255]), 'stride');
});

test('rotatePlane turns clockwise into display orientation', () => {
  // Coded 3 × 2:  a b c / d e f.  90° clockwise display (2 × 3): d a / e b / f c.
  const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...rotatePlane(src, 3, 2, 90).data], [4, 1, 5, 2, 6, 3]);
  assert.deepEqual([...rotatePlane(src, 3, 2, 180).data], [6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...rotatePlane(src, 3, 2, 270).data], [3, 6, 2, 5, 1, 4]);
  assert.deepEqual([...rotatePlane(src, 3, 2, 0).data], [1, 2, 3, 4, 5, 6]);
  for (const r of ROT) same(rotatePlane(src, 3, 2, r).data, referenceUpright(src, 3, 2, r).data, `reference ${r}`);
});

/* ---------------------------------------------------------------- fused pooling and crops */

test('poolPlane equals poolLuma of the rotated, range-expanded plane bit for bit (every kernel path)', () => {
  let cases = 0;
  for (const [cw, ch] of [[17, 11], [64, 36], [48, 32], [30, 18], [37, 64], [96, 54]]) for (const bits of [8, 10]) for (const limited of [false, true]) {
    const src = randPlane(cw * ch, bits), lut = lumaLut(bits, limited);
    if (bits > 8 && !lut) continue;
    for (const r of ROT) {
      const up = referenceUpright(src, cw, ch, r, lut);
      for (const pool of [1, 2, 3, 4, 5]) {
        const ref = poolLuma(up.data, up.w, up.h, pool), got = poolPlane(src, cw, ch, cw, r, pool, lut);
        assert.equal(got.w, ref.w); assert.equal(got.h, ref.h); assert.equal(got.pool, pool);
        same(got.data, ref.data, `${cw}x${ch} ${bits}-bit limited=${limited} rot=${r} pool=${pool}`);
        cases++;
      }
    }
  }
  // Strided source rows (a copyTo layout wider than the picture) and an unaligned view.
  const src = randPlane(40 * 20), view = randPlane(1 + 32 * 20).subarray(1);
  const tight = new Uint8Array(32 * 20); for (let y = 0; y < 20; y++) tight.set(src.subarray(y * 40, y * 40 + 32), y * 32);
  same(poolPlane(src, 32, 20, 40, 90, 2, lumaLut(8, true)).data, poolPlane(tight, 32, 20, 32, 90, 2, lumaLut(8, true)).data, 'stride');
  same(poolPlane(view, 32, 20, 32, 0, 4, lumaLut(8, true)).data, poolLuma(expandLimitedRange(view), 32, 20, 4).data, 'unaligned view');
  assert.ok(cases > 400);
  assert.throws(() => poolPlane(randPlane(16, 10), 4, 4, 4, 0, 2, null), HFError, '16-bit planes need a table');
});

test('cropPlane equals cropLuma of the upright full-range plane, from full planes and coded windows', () => {
  for (const [cw, ch] of [[23, 17], [64, 36]]) for (const bits of [8, 10]) for (const limited of [false, true]) {
    const src = randPlane(cw * ch, bits), lut = lumaLut(bits, limited);
    if (bits > 8 && !lut) continue;
    for (const r of ROT) {
      const up = referenceUpright(src, cw, ch, r, lut), W = up.w, H = up.h;
      for (const pool of [1, 2, 3]) for (const rect of [{ x: 2, y: 3, w: 9, h: 8 }, { x: -5, y: -4, w: 11, h: 9 }, { x: W - 4, y: H - 3, w: 10, h: 9 }, { x: W + 5, y: -20, w: 6, h: 6 }, { x: -2, y: -2, w: W + 4, h: H + 4 }]) {
        if (rect.w < pool || rect.h < pool) continue;
        const ref = cropLuma(up.data, W, H, rect, pool), got = cropPlane(src, cw, ch, cw, 0, 0, cw, ch, r, rect, pool, lut);
        assert.deepEqual({ ...got, data: null }, { ...ref, data: null }, `geometry rot=${r} pool=${pool} ${JSON.stringify(rect)}`);
        same(got.data, ref.data, `data rot=${r} pool=${pool} ${JSON.stringify(rect)}`);
        // The same crop from the smallest even-aligned coded window around it.
        const c = displayRectToCoded(cropFootprint(rect, W, H, pool), r, cw, ch);
        const x0 = c.x & ~1, y0 = c.y & ~1, x1 = Math.min(cw, (c.x + c.w + 1) & ~1), y1 = Math.min(ch, (c.y + c.h + 1) & ~1);
        const win = new (bits > 8 ? Uint16Array : Uint8Array)((x1 - x0) * (y1 - y0));
        for (let y = y0; y < y1; y++) win.set(src.subarray(y * cw + x0, y * cw + x1), (y - y0) * (x1 - x0));
        same(cropPlane(win, x1 - x0, y1 - y0, x1 - x0, x0, y0, cw, ch, r, rect, pool, lut).data, ref.data, `window rot=${r}`);
      }
    }
  }
  assert.throws(() => cropPlane(new Uint8Array(4), 2, 2, 2, 10, 10, 64, 36, 0, { x: 0, y: 0, w: 4, h: 4 }, 1, null), /does not cover/);
  assert.throws(() => cropPlane(new Uint8Array(16), 4, 4, 4, 0, 0, 4, 4, 0, { x: 0, y: 0, w: 1, h: 4 }, 2, null), HFError);
});

test('crops are bit-exact with a per-pixel reference for random rects and pools 1-5 (cropLuma fast paths, fused-table upright crop)', () => {
  // naive reference: every output pixel is the rounded mean of its pool² block, edge-clamped, through the table
  const naive = (src, W, H, rect, pool, lut) => {
    const w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool), out = new Uint8Array(w * h), cl = (v, n) => Math.min(n - 1, Math.max(0, v));
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let t = 0;
      for (let q = 0; q < pool; q++) for (let k = 0; k < pool; k++) { const v = src[cl(rect.y + j * pool + q, H) * W + cl(rect.x + i * pool + k, W)]; t += lut ? lut[v] : v; }
      out[j * w + i] = Math.floor((t + (pool * pool >> 1)) / (pool * pool));
    }
    return out;
  };
  let n = 0;
  for (const [W, H] of [[37, 29], [64, 48]]) for (const bits of [8, 10]) for (const limited of [false, true]) {
    const src = randPlane(W * H, bits), lut = lumaLut(bits, limited);
    if (bits > 8 && !lut) continue;
    const conv = lut ? Uint8Array.from(src, v => lut[v]) : src;
    for (let trial = 0; trial < 60; trial++) {
      const pool = 1 + Math.floor(rnd() * 5), rw = pool + Math.floor(rnd() * (W + 10)), rh = pool + Math.floor(rnd() * (H + 10));
      const inside = trial % 3 === 0, x = inside ? Math.floor(rnd() * Math.max(1, W - rw)) : Math.floor(rnd() * (W + 20)) - 10, y = Math.floor(rnd() * (H + 20)) - 10;
      const rect = { x, y, w: inside ? Math.min(rw, W) : rw, h: rh };
      if (rect.w < pool) continue;
      const want = naive(src, W, H, rect, pool, lut);
      same(cropLuma(conv, W, H, rect, pool).data, want, `cropLuma ${W}x${H} pool ${pool} ${JSON.stringify(rect)}`);
      same(cropPlane(src, W, H, W, 0, 0, W, H, 0, rect, pool, lut).data, want, `cropPlane bits=${bits} limited=${limited} pool ${pool} ${JSON.stringify(rect)}`);
      n++;
    }
  }
  assert.ok(n > 300, `${n} crops`);
});

test('validBox and cropFootprint agree with cropLuma', () => {
  const W = 30, H = 20, plane = randPlane(W * H);
  for (const rect of [{ x: -7, y: -3, w: 14, h: 9 }, { x: 25, y: 15, w: 9, h: 11 }, { x: 40, y: 2, w: 4, h: 4 }, { x: 3, y: 4, w: 7, h: 5 }]) for (const pool of [1, 2, 3]) {
    if (rect.w < pool || rect.h < pool) continue;
    assert.deepEqual(validBox(rect, W, H, pool), cropLuma(plane, W, H, rect, pool).valid);
    const f = cropFootprint(rect, W, H, pool);
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= W && f.y + f.h <= H && f.w > 0 && f.h > 0);
  }
});

test('planes re-exports the reference pooling from types.js (no re-implementation)', () => {
  assert.equal(planes.poolLuma, poolLuma);
  assert.equal(planes.cropLuma, cropLuma);
});

test('hot paths: fused pooling and ROI crops at 1080×1920 and 2160×3840 (report)', () => {
  const rows = [];
  for (const [cw, ch, pool] of [[1920, 1080, 2], [3840, 2160, 4]]) {
    const y = randPlane(cw * ch), lut = lumaLut(8, true);
    const best = f => { for (let i = 0; i < 3; i++) f(); let b = Infinity; for (let i = 0; i < 8; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };
    rows.push(`${ch}x${cw} display: poolPlane rot90 limited ${best(() => poolPlane(y, cw, ch, cw, 90, pool, lut)).toFixed(2)} ms, rot0 full ${best(() => poolPlane(y, cw, ch, cw, 0, pool, null)).toFixed(2)} ms, `
      + `2×256² cropPlane rot90 ${best(() => { cropPlane(y, cw, ch, cw, 0, 0, cw, ch, 90, { x: 301, y: 517, w: 256, h: 256 }, 1, lut); cropPlane(y, cw, ch, cw, 0, 0, cw, ch, 90, { x: 700, y: 900, w: 256, h: 256 }, 1, lut); }).toFixed(2)} ms`);
  }
  console.log(`# U1 planes (Node, min of 8): ${rows.join(' | ')}`);
});
