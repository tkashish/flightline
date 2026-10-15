/**
 * Display rotation (U1, protocol doc §4). `rotation` is the clockwise turn applied to the coded image for
 * display; ffmpeg `-display_rotation 90` (counter-clockwise) is 270 here. Continuous coordinates, pixel (i, j)
 * covering [i, i+1) × [j, j+1). With coded size cw × ch, coded (x, y) maps to display:
 * 0° (x, y); 90° (ch − y, x); 180° (cw − x, ch − y); 270° (y, cw − x).
 */
import { HFError } from '../types.js';

const check = r => { if (r !== 0 && r !== 90 && r !== 180 && r !== 270) throw new HFError('bad-arg', `rotation ${r}`); return r; };

/** Display width and height of a coded cw × ch image. */
export function displaySize(codedW, codedH, rotation) {
  return check(rotation) % 180 ? { width: codedH, height: codedW } : { width: codedW, height: codedH };
}

export function codedToDisplay(x, y, rotation, codedW, codedH) {
  switch (check(rotation)) {
    case 0: return { x, y };
    case 90: return { x: codedH - y, y: x };
    case 180: return { x: codedW - x, y: codedH - y };
    default: return { x: y, y: codedW - x };
  }
}

export function displayToCoded(x, y, rotation, codedW, codedH) {
  switch (check(rotation)) {
    case 0: return { x, y };
    case 90: return { x: y, y: codedH - x };
    case 180: return { x: codedW - x, y: codedH - y };
    default: return { x: codedW - y, y: x };
  }
}

const mapRect = (f, rect, rotation, cw, ch) => {
  const a = f(rect.x, rect.y, rotation, cw, ch), b = f(rect.x + rect.w, rect.y + rect.h, rotation, cw, ch);
  const x0 = Math.floor(Math.min(a.x, b.x)), y0 = Math.floor(Math.min(a.y, b.y));
  return { x: x0, y: y0, w: Math.ceil(Math.max(a.x, b.x)) - x0, h: Math.ceil(Math.max(a.y, b.y)) - y0 };
};
/** Integer coded rect covering a display rect (exact for integer rects: rotations map pixel grids onto pixel grids). */
export const displayRectToCoded = (rect, rotation, codedW, codedH) => mapRect(displayToCoded, rect, rotation, codedW, codedH);
/** Inverse of displayRectToCoded. */
export const codedRectToDisplay = (rect, rotation, codedW, codedH) => mapRect(codedToDisplay, rect, rotation, codedW, codedH);

/**
 * Plane walk for display pixel (X, Y) of a coded window: the window's element index is base(Y) + X·step.
 * The window holds coded pixels [sx0, sx0 + …) × [sy0, sy0 + …) of a cw × ch coded frame with row stride `stride`.
 */
export function displayWalk(rotation, cw, ch, stride, sx0 = 0, sy0 = 0) {
  switch (check(rotation)) {
    case 0: return { base: Y => (Y - sy0) * stride - sx0, step: 1 };
    case 90: return { base: Y => (ch - 1 - sy0) * stride + Y - sx0, step: -stride };
    case 180: return { base: Y => (ch - 1 - Y - sy0) * stride + cw - 1 - sx0, step: -1 };
    default: return { base: Y => -sy0 * stride + cw - 1 - Y - sx0, step: stride };
  }
}
