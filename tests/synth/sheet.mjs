#!/usr/bin/env node
// Contact sheets from encoded clips: key frames (decoded upright by ffmpeg) with GT overlays on top, and
// 3x zoomed crops around the GT ball below. node tests/synth/sheet.mjs --corpus DIR [--out DIR] [--only id]
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG } from './encode.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const corpus = resolve(opt('corpus', '/tmp/flightline-corpus/smoke')), out = resolve(opt('out', join(corpus, 'sheets'))), only = opt('only'), TW = +opt('width', 300);
mkdirSync(out, { recursive: true });

function box(img, W, H, x, y, half, col, th = 3) {
  for (let yy = Math.floor(y - half - th); yy <= y + half + th; yy++) for (let xx = Math.floor(x - half - th); xx <= x + half + th; xx++) {
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const inner = Math.abs(xx - x) < half && Math.abs(yy - y) < half; if (inner) continue;
    const o = (yy * W + xx) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2];
  }
}

/** Area-average downscale of an RGB image. */
function shrink(img, W, H, w, h) {
  const out = Buffer.alloc(w * h * 3), sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const o = (yy * W + xx) * 3; r += img[o]; g += img[o + 1]; b += img[o + 2]; n++; }
    const o = (y * w + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return out;
}

for (const f of readdirSync(corpus).filter(f => f.endsWith('.gt.json')).sort()) {
  const g = JSON.parse(readFileSync(join(corpus, f), 'utf8')); if (only && !g.id.includes(only)) continue;
  const W = g.meta.video.width, H = g.meta.video.height, fr = g.frames, n = fr.length, fps = g.meta.video.fpsOut;
  const k0 = g.impact?.frame ?? fr.findIndex(x => x.tc >= 0);
  const want = k0 >= 0 ? [Math.max(0, k0 - Math.round(fps * 0.9)), k0 - 1, k0, k0 + 1, k0 + 3, k0 + Math.round(fps * 0.25), k0 + Math.round(fps * 0.6), k0 + Math.round(fps * 1.2), n - 1] : [0, Math.round(n * 0.3), Math.round(n * 0.5), Math.round(n * 0.7), n - 1];
  const idx = [...new Set(want.map(k => Math.max(0, Math.min(n - 1, k))))].sort((a, b) => a - b);
  const sel = idx.map(k => `eq(n\\,${k})`).join('+');
  const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', join(corpus, g.meta.video.file), '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', `select='${sel}'`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 2 ** 31 }).stdout;
  const size = W * H * 3, th = Math.round(TW * H / W / 2) * 2, crop = TW, tiles = [], crops = [];
  idx.forEach((k, j) => {
    const img = Buffer.from(raw.subarray(j * size, (j + 1) * size)), clean = Buffer.from(img), t = fr[k], s = Math.max(2, Math.round(W / TW));
    const b = t.ball; if (b?.x != null) box(img, W, H, b.x, b.y, Math.max(6, b.diam * 1.2 + 4), b.occluded ? [255, 60, 60] : [40, 255, 60], s);
    if (t.club?.inFrame) box(img, W, H, t.club.x, t.club.y, Math.max(8, t.club.size * 0.7), [255, 170, 0], s);
    for (const d of t.distractors || []) box(img, W, H, d.x, d.y, Math.max(6, d.size * 0.7), [255, 0, 255], s);
    tiles.push(img);
    // Zoomed crop (3x) centered on the GT ball (or the address before impact), no overlay.
    const cx = Math.round(b?.x ?? W / 2), cy = Math.round(b?.y ?? H / 2), half = Math.round(crop / 6), c = Buffer.alloc(crop * crop * 3);
    for (let y = 0; y < crop; y++) for (let x = 0; x < crop; x++) { const sx = cx - half + Math.floor(x / 3), sy = cy - half + Math.floor(y / 3); if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue; clean.copy(c, (y * crop + x) * 3, (sy * W + sx) * 3, (sy * W + sx) * 3 + 3); }
    { const m = Math.floor(crop / 2); for (const [dx, dy] of [[-12, 0], [-9, 0], [12, 0], [9, 0], [0, -12], [0, -9], [0, 12], [0, 9]]) { const o = ((m + dy) * crop + m + dx) * 3; c[o] = 255; c[o + 1] = 40; c[o + 2] = 40; } }
    crops.push(c);
  });
  const cols = idx.length, scaled = Buffer.concat(tiles.map(img => shrink(img, W, H, TW, th)));
  // Assemble: row of frames, row of crops.
  const SW = TW * cols, SH = th + crop, sheet = Buffer.alloc(SW * SH * 3, 20);
  for (let j = 0; j < cols; j++) {
    for (let y = 0; y < th; y++) scaled.copy(sheet, (y * SW + j * TW) * 3, (j * th * TW + y * TW) * 3, (j * th * TW + (y + 1) * TW) * 3);
    for (let y = 0; y < crop; y++) crops[j].copy(sheet, ((th + y) * SW + j * TW) * 3, y * crop * 3, (y + 1) * crop * 3);
  }
  spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SW}x${SH}`, '-i', 'pipe:0', '-frames:v', '1', join(out, `${g.id}.png`)], { input: sheet });
  console.log(`${g.id}: frames ${idx.join(',')} (t=${idx.map(k => fr[k].t.toFixed(2)).join(',')}) -> ${join(out, g.id + '.png')}`);
}
