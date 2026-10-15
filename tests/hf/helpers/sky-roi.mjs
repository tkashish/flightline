// Pixel-level sky ROIs for the U4 tests (tests/hf-roi-detect.test.js):
// - the D3 E3 faint-ball scene, ported from /tmp/flightline-understand/design/D3-scratch/e3-faint.mjs (same
//   seeds, sky, noise, ball grid and x264 settings), round-tripped through ffmpeg and cached in os.tmpdir();
// - the E3 baseline detector (fixed D = 6 background, 3×3 filter, ±7 px search, 1%-FA pooled threshold),
//   so the hf detector is compared with it on the very same encoded frames;
// - small synthetic scenes (noisy sky, Gaussian balls, static and lens-fixed specks, planes, camera pans);
// - runTube(), which drives a RoiTube the way the pipeline does: plan -> crop -> push -> detect when ready.
// E3 places pixel centres at integer coordinates; hf at +0.5, so E3 truth is converted with +0.5.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cropLuma, IDENTITY_SIM, makeSourceMeta } from '../../../dist/hf/types.js';

/* ------------------------------------------------------------------ randomness (E3's sim.mjs) */

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export const gauss = r => { let u = 0; while (!u) u = r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/* ------------------------------------------------------------------ ffmpeg */

const FF = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
let ffPath;
export function ffmpeg() {
  if (ffPath !== undefined) return ffPath;
  ffPath = null;
  for (const p of FF) { const r = spawnSync(p, ['-hide_banner', '-version'], { encoding: 'utf8' }); if (r.status === 0 && /libx264/.test(r.stdout)) { ffPath = p; break; } }
  return ffPath;
}

export const CACHE_DIR = join(tmpdir(), 'flightline-hf-u4');

/**
 * Encode gray frames with libx264 (E3 settings, single-threaded so the bitstream is deterministic), decode
 * the Y plane back. Cached by content hash.
 */
export function x264RoundTrip(frames, W, H, { bitrate = '6M', fps = 30, tag = 'clip' } = {}) {
  const ff = ffmpeg();
  if (!ff) throw new Error('ffmpeg with libx264 not found');
  const hash = createHash('sha1');
  hash.update(`${W}x${H}@${fps} ${bitrate} v1`);
  for (const f of frames) hash.update(f);
  const key = hash.digest('hex').slice(0, 16), raw = join(CACHE_DIR, `${tag}-${bitrate}-${key}.y`);
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(raw)) {
    const mp4 = join(CACHE_DIR, `${tag}-${bitrate}-${key}.mp4`);
    const enc = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', '12M', '-g', '30', '-bf', '2', '-threads', '1', '-pix_fmt', 'yuv420p', mp4],
    { input: Buffer.concat(frames.map(f => Buffer.from(f.buffer, f.byteOffset, f.byteLength))), maxBuffer: 1 << 30 });
    if (enc.status !== 0) throw new Error(`x264 encode failed: ${enc.stderr}`);
    const dec = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
    if (dec.status !== 0) throw new Error(`decode failed: ${dec.stderr}`);
    writeFileSync(raw + '.tmp', dec.stdout);
    renameSync(raw + '.tmp', raw);
  }
  const buf = readFileSync(raw), n = W * H, out = [];
  for (let k = 0; k * n < buf.length; k++) out.push(new Uint8Array(buf.buffer, buf.byteOffset + k * n, n));
  return out;
}

/* ------------------------------------------------------------------ the E3 scene */

export const E3 = Object.freeze({
  W: 960, H: 720, FRAMES: 90, FPS: 30, NOISE: 1.6,
  SIZES: Object.freeze([0.8, 1.3, 2.0, 3.0]), CONTRASTS: Object.freeze([-16, -8, 4, 6, 8, 12, 20, 40]),
  // D3 §4.2 TBD table and the full E3 tables (D3-scratch/e3-out-6M.txt, e3-out-2M.txt): [d][contrast] -> %
  TBD_6M: Object.freeze({ 0.8: [3, 0, 0, 0, 0, 0, 9, 89], 1.3: [86, 6, 0, 3, 0, 51, 100, 100], 2: [100, 46, 11, 34, 43, 100, 100, 100], 3: [100, 100, 34, 80, 100, 100, 100, 100] }),
  TBD_2M: Object.freeze({ 0.8: [0, 0, 0, 0, 0, 0, 0, 29], 1.3: [26, 0, 0, 0, 0, 0, 20, 97], 2: [86, 0, 0, 0, 14, 57, 97, 100], 3: [89, 66, 0, 14, 51, 83, 100, 100] }),
  HEADLINE_6M: Object.freeze([[2, 12, 100], [3, 8, 100], [3, 6, 80], [1.3, 20, 100], [2, -8, 46], [2, -16, 100]])
});

function valueNoise(r, w, h, scale) {
  const gw = Math.ceil(w / scale) + 2, gh = Math.ceil(h / scale) + 2, g = new Float32Array(gw * gh).map(() => r());
  return (x, y) => {
    const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy, s = t => t * t * (3 - 2 * t);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    return a + (b - a) * s(u) + (c - a) * s(v) + (a - b - c + d) * s(u) * s(v);
  };
}

/** The 32 E3 balls: diameter d, contrast c, velocity (px/frame), position at frame k (E3 pixel convention). */
export function e3Balls() {
  const { W, H, FRAMES, SIZES, CONTRASTS } = E3, cellW = W / CONTRASTS.length, cellH = H / SIZES.length, out = [];
  SIZES.forEach((d, si) => CONTRASTS.forEach((c, ci) => {
    const r = rng(1000 + si * 37 + ci * 7);
    const vx = (r() - 0.5) * 2.2, vy = 0.6 + r() * 1.4;
    const x0 = ci * cellW + cellW / 2 - vx * FRAMES / 2, y0 = si * cellH + cellH / 2 - vy * FRAMES / 2;
    out.push({ d, c, si, ci, vx, vy, x0, y0, at: k => ({ x: x0 + vx * k, y: y0 + vy * k }) });
  }));
  return out;
}

/** E3 Gaussian ball profile: flux c·πd²/4 spread with σ = √((d/2.5)² + 0.5²). */
export const e3Sigma = d => Math.sqrt((d / 2.5) ** 2 + 0.25);

/** Render the E3 clip pair in one pass (E3 drew the identical sky and noise for both). */
export function renderE3() {
  const { W, H, FRAMES, NOISE } = E3, r = rng(77), n1 = valueNoise(r, W + 400, H, 140), n2 = valueNoise(r, W + 400, H, 45);
  const rn = rng(5), B = e3Balls(), balls = [], empty = [];
  for (let k = 0; k < FRAMES; k++) {
    const img = new Uint8Array(W * H), drift = k * 0.15;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sky = 150 + 40 * (y / H) + 55 * Math.max(0, n1(x + drift, y) - 0.45) + 12 * (n2(x + drift * 1.3, y) - 0.5);
      img[y * W + x] = Math.max(0, Math.min(255, Math.round(sky + gauss(rn) * NOISE)));
    }
    empty.push(img.slice());
    for (const b of B) {
      const p = b.at(k), sb = e3Sigma(b.d), flux = b.c * Math.PI * b.d * b.d / 4;
      for (let y = Math.floor(p.y - 5); y <= p.y + 5; y++) for (let x = Math.floor(p.x - 5); x <= p.x + 5; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const v = flux / (2 * Math.PI * sb * sb) * Math.exp(-((x - p.x) ** 2 + (y - p.y) ** 2) / (2 * sb * sb));
        img[y * W + x] = Math.max(0, Math.min(255, Math.round(img[y * W + x] + v)));
      }
    }
    balls.push(img);
  }
  return { balls, empty };
}

let e3Raw = null;
/** Decoded E3 clips at a bitrate: {balls, empty} arrays of Y planes (cached on disk). */
export function e3Clips(bitrate) {
  const { W, H, FPS } = E3;
  const tagged = ['balls', 'empty'].map(k => [k, join(CACHE_DIR, `e3-${k}-${bitrate}.y`)]);
  if (!tagged.every(([, p]) => existsSync(p))) {
    e3Raw ??= renderE3();
    for (const [k, p] of tagged) {
      const dec = x264RoundTrip(e3Raw[k], W, H, { bitrate, fps: FPS, tag: `e3-${k}` });
      writeFileSync(p + '.tmp', Buffer.concat(dec.map(f => Buffer.from(f.buffer, f.byteOffset, f.byteLength))));
      renameSync(p + '.tmp', p);
    }
  }
  const out = {};
  for (const [k, p] of tagged) {
    const buf = readFileSync(p), n = W * H;
    out[k] = Array.from({ length: buf.length / n }, (_, i) => new Uint8Array(buf.buffer, buf.byteOffset + i * n, n));
  }
  return out;
}

/**
 * Prediction noise of the E3 harness: position N(0, 1.5) px, velocity N(0, 0.15) px/frame, drawn per
 * (ball, frame) from a fixed seed so both detectors see the same predictions.
 */
export function e3Offsets(nBalls, frames, seed = 9) {
  const r = rng(seed), out = [];
  for (let b = 0; b < nBalls; b++) out.push(Array.from({ length: frames }, () => ({ x: gauss(r) * 1.5, y: gauss(r) * 1.5, vx: gauss(r) * 0.15, vy: gauss(r) * 0.15 })));
  return out;
}

/* ------------------------------------------------------------------ the E3 baseline detector */

/**
 * E3's detector at one frame (port of e3-faint.mjs detect(), TBD part): residual against frames k±6, 3×3
 * binomial filter, z by the median |filtered| over the ROI, best TBD over ±7 px at 0.5 px × a 3×3 velocity
 * grid (±0.4) around the predicted velocity. Coordinates are E3's (pixel centres at integers).
 */
export function e3Detect(F, W, H, px, py, vx, vy, k, polarity) {
  const D = 6, J = 3, R = 7, half = R + J * 3 + 4;
  const maps = [];
  for (let j = -J; j <= J; j++) {
    const kk = k + j, x0 = Math.max(2, Math.round(px) - half), x1 = Math.min(W - 3, Math.round(px) + half);
    const y0 = Math.max(2, Math.round(py) - half), y1 = Math.min(H - 3, Math.round(py) + half), w = x1 - x0 + 1, h = y1 - y0 + 1;
    const a = F[Math.max(0, kk - D)], b = F[Math.min(F.length - 1, kk + D)], c = F[kk], res = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y + y0) * W + x + x0; res[y * w + x] = c[i] - 0.5 * (a[i] + b[i]); }
    const mf = new Float32Array(w * h), K = [0.0625, 0.125, 0.0625, 0.125, 0.25, 0.125, 0.0625, 0.125, 0.0625];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let s = 0, q = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += res[(y + dy) * w + x + dx] * K[q++];
      mf[y * w + x] = s;
    }
    const vals = Float32Array.from(mf.subarray(w + 1, w * h - w - 1), Math.abs);
    const sig = Math.max(0.15, (kth(vals, vals.length >> 1) || 1) * 1.4826);   // = sorted[n >> 1], as E3
    for (let i = 0; i < mf.length; i++) mf[i] /= sig;
    maps.push({ x0, y0, w, h, z: mf });
  }
  const sample = (Z, x, y) => {
    const ix = Math.floor(x - Z.x0), iy = Math.floor(y - Z.y0);
    if (ix < 1 || iy < 1 || ix >= Z.w - 2 || iy >= Z.h - 2) return 0;
    const u = x - Z.x0 - ix, v = y - Z.y0 - iy, z = Z.z, w = Z.w, i = iy * w + ix;
    return z[i] * (1 - u) * (1 - v) + z[i + 1] * u * (1 - v) + z[i + w] * (1 - u) * v + z[i + w + 1] * u * v;
  };
  let best = { s: -Infinity, x: px, y: py };
  for (let dy = -R; dy <= R; dy += 0.5) for (let dx = -R; dx <= R; dx += 0.5) {
    const x = px + dx, y = py + dy;
    for (const ovx of [-0.4, 0, 0.4]) for (const ovy of [-0.4, 0, 0.4]) {
      let s = 0;
      for (let j = -J; j <= J; j++) s += polarity * sample(maps[j + J], x + (vx + ovx) * j, y + (vy + ovy) * j);
      s /= Math.sqrt(2 * J + 1);
      if (s > best.s) best = { s, x, y };
    }
  }
  return best;
}

/** k-th smallest of a (in place). */
function kth(a, k) {
  let lo = 0, hi = a.length - 1;
  while (hi > lo) {
    const p = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) { while (a[i] < p) i++; while (a[j] > p) j--; if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}

/* ------------------------------------------------------------------ small synthetic scenes */

/** Add a Gaussian-profile ball (E3 profile) at native (x, y) (hf convention, pixel centres at +0.5). */
export function stampBall(img, W, H, x, y, d, contrast, sigma = e3Sigma(d)) {
  const flux = contrast * Math.PI * d * d / 4, s2 = 2 * sigma * sigma, A = flux / (Math.PI * s2), rad = Math.ceil(4 * sigma + 1);
  for (let j = Math.max(0, Math.floor(y - rad)); j <= Math.min(H - 1, Math.ceil(y + rad)); j++) {
    for (let i = Math.max(0, Math.floor(x - rad)); i <= Math.min(W - 1, Math.ceil(x + rad)); i++) {
      const v = A * Math.exp(-((i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2) / s2);
      img[j * W + i] = Math.max(0, Math.min(255, Math.round(img[j * W + i] + v)));
    }
  }
  return img;
}

/**
 * A float sky of W×H: base level, a vertical gradient and optional clouds (value noise at `scale` px), drifting
 * `drift` px/frame; frame(k, offX, offY) renders it shifted by the camera (raw = stab + off) plus noise.
 */
export function makeSky(W, H, { base = 150, gradient = 30, clouds = 0, scale = 90, drift = 0, noise = 1.6, seed = 1 } = {}) {
  const r = rng(seed), n1 = valueNoise(r, W + 600, H + 200, scale);
  return (k, offX = 0, offY = 0, nr = rng(seed * 7919 + k)) => {
    const img = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - offX + 200 + drift * k, sy = y - offY + 100;
      const v = base + gradient * (y / H) + clouds * (n1(sx, sy) - 0.5);
      img[y * W + x] = Math.max(0, Math.min(255, Math.round(v + gauss(nr) * noise)));
    }
    return img;
  };
}

/* ------------------------------------------------------------------ driving a tube */

/**
 * Drive a RoiTube over frames [from, to) like the pipeline: plan(k) -> crops (cropLuma on the frame, or
 * on decoyFrames(k) for the decoys) -> push(k, t, crops, sim(k)) -> detect every pending frame once
 * ready, and the rest at the end. predict(k) must be deterministic. Returns detections by index.
 */
export function runTube(tube, { W, H, frames, from = 0, to, predict, decoyFrames = null, sim = () => IDENTITY_SIM, fps = 30, onDetect = null }) {
  const pending = [], dets = new Map(), detectOne = i => { const d = tube.detect(i, predict(i)); dets.set(i, d); onDetect?.(i, d); };
  for (let k = from; k < to; k++) {
    const reqs = tube.plan(k, predict(k)), main = frames(k), dec = decoyFrames ? decoyFrames(k) : main;
    tube.push(k, k / fps, reqs.map((q, i) => cropLuma(i ? dec : main, W, H, q.rect, q.pool)), sim(k));
    pending.push(k);
    while (pending.length && tube.ready(pending[0])) detectOne(pending.shift());
  }
  while (pending.length) detectOne(pending.shift());
  return dets;
}

/** A Prediction literal (stabilized px). */
export const pred = (index, x, y, vx, vy, d, { sigma = 1, polarity = 1, fps = 30, ...rest } = {}) =>
  ({ index, t: index / fps, x, y, vx, vy, cov: [sigma * sigma, 0, sigma * sigma], d, polarity, ...rest });

/** Wilson score interval for k successes of n at z = 1.96. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/* ------------------------------------------------------------------ fixtures for the unit tests */

/** CameraTrack (stabilized -> raw px) with a pure translation offset(k) = {x, y} per frame. */
export function translationTrack(meta, offset) {
  const n = meta.frameCount, index = Int32Array.from({ length: n }, (_, k) => k), sim = new Float64Array(4 * n);
  for (let k = 0; k < n; k++) { const o = offset(k); sim[4 * k] = 1; sim[4 * k + 2] = o.x; sim[4 * k + 3] = o.y; }
  return { index, t: Float64Array.from(meta.times), sim, inlier: new Float32Array(n).fill(1) };
}

/**
 * Frames of a scene: a sky (makeSky options) seen by a camera offset(k) (raw = stab + offset), with objects
 * in stabilized px [{x(k), y(k), d, c}] (balls, planes, static specks) and lensSpecks in raw px [{x, y, d, c}].
 */
export function renderScene({ W, H, frames, sky = {}, offset = () => ({ x: 0, y: 0 }), objects = [], lensSpecks = [] }) {
  const render = makeSky(W, H, sky), out = [];
  for (let k = 0; k < frames; k++) {
    const o = offset(k), img = render(k, o.x, o.y);
    for (const b of objects) { const x = b.x(k), y = b.y(k); if (x != null) stampBall(img, W, H, x + o.x, y + o.y, b.d, typeof b.c === 'function' ? b.c(k) : b.c); }
    for (const s of lensSpecks) stampBall(img, W, H, s.x, s.y, s.d, s.c);
    out.push(img);
  }
  return out;
}

/**
 * E3 baseline detection and false-alarm scores on E3's frame schedule (k = 10, 12, ..., 78) with the given
 * prediction offsets; cached on disk (it is the slow part of the E3 tests).
 */
export function e3BaselineScores(bitrate, offsets, { k0 = 10, k1 = 80, step = 2 } = {}) {
  const key = createHash('sha1').update(JSON.stringify({ bitrate, offsets, k0, k1, step, v: 1 })).digest('hex').slice(0, 16);
  const file = join(CACHE_DIR, `e3-baseline-${bitrate}-${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const { W, H } = E3, clips = e3Clips(bitrate), B = e3Balls(), out = { ball: [], empty: [] };
  B.forEach((b, bi) => {
    const pol = Math.sign(b.c), hits = [], nulls = [];
    for (let k = k0; k < k1; k += step) {
      const p = b.at(k), o = offsets[bi][k];
      const rb = e3Detect(clips.balls, W, H, p.x + o.x, p.y + o.y, b.vx + o.vx, b.vy + o.vy, k, pol);
      const re = e3Detect(clips.empty, W, H, p.x + o.x, p.y + o.y, b.vx + o.vx, b.vy + o.vy, k, pol);
      hits.push(Math.hypot(rb.x - p.x, rb.y - p.y) <= 1.5 ? rb.s : null); nulls.push(re.s);
    }
    out.ball.push(hits); out.empty.push(nulls);
  });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** SourceMeta for n frames of W×H at fps (memory path). */
export const metaFor = (W, H, n, fps = 30) => makeSourceMeta({ width: W, height: H, times: Float64Array.from({ length: n }, (_, k) => k / fps), fps, duration: n / fps });
