// Frame-index barcode shared by the decode fixtures (Node) and the browser decode bench (no Node imports).
// Upright frames carry their presentation index as 16 bits (2 rows of 8 blocks, LSB first) plus a 10101010 guard
// row in the top-left corner; a mirror, a wrong rotation or a wrong frame breaks the read.

export const BITS = 16;
export const blockPx = (W, H) => Math.max(4, Math.floor(Math.min(W, H) / 16));

/** Upright gray frame k: gradient, a moving bar, the index barcode, a guard row and two orientation marks. */
export function renderUpright(k, W, H) {
  const p = new Uint8Array(W * H), B = blockPx(W, H), bar = (k * 7) % W;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = 60 + ((x * 90 / W + y * 60 / H) | 0) + (Math.abs(x - bar) < 3 ? 70 : 0);
  const cell = (cx, cy, on) => { for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) p[(B + cy * B + y) * W + B + cx * B + x] = on ? 255 : 0; };
  for (let b = 0; b < BITS; b++) cell(b % 8, b >> 3, (k >> b) & 1);
  for (let c = 0; c < 8; c++) cell(c, 2, c % 2 === 0);
  for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { p[(B + y) * W + W - 2 * B + x] = 255; p[(H - 2 * B + y) * W + B + x] = 0; }
  return p;
}

/** Index from an upright full-range luma plane (or a crop of it at x0, y0), −1 when the guard row fails. */
export function readBarcode(luma, W, H, { stride = W, x0 = 0, y0 = 0 } = {}) {
  const B = blockPx(W, H), q = Math.max(1, B >> 2);
  const bit = (cx, cy) => {
    let s = 0, n = 0;
    for (let y = B + cy * B + q; y < B + cy * B + B - q; y++) for (let x = B + cx * B + q; x < B + cx * B + B - q; x++) { s += luma[(y - y0) * stride + x - x0]; n++; }
    return s / n > 128 ? 1 : 0;
  };
  for (let c = 0; c < 8; c++) if (bit(c, 2) !== (c % 2 === 0 ? 1 : 0)) return -1;
  let k = 0;
  for (let b = 0; b < BITS; b++) k |= bit(b % 8, b >> 3) << b;
  return k;
}

/** Display rect holding the barcode (for lumaRect reads). */
export const barcodeRect = (W, H) => { const B = blockPx(W, H); return { x: 0, y: 0, w: 10 * B, h: 4 * B }; };

/** FNV-1a hash of bytes (parity checks across sources). */
export function fnv(data) { let h = 0x811c9dc5; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; }
