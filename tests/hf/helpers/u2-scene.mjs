// U2 test helpers: deterministic procedural textures, exact similarity warps and simple pixel-level scenes
// (ground/sky, ball, tee, glove, club head, golfer blob, lens speck) rendered straight at coarse resolution.
// A camera similarity G_k maps world (= stabilized coarse) px to raw px of frame k; content at world w is drawn
// at raw G_k(w). Nothing here imports dist/hf except types.js helpers.
import { applySim, invertSim, composeSim } from '../../../dist/hf/types.js';

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.gauss = () => { let u = 0; while (!u) u = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); };
  return next;
}

const hash2 = (ix, iy, seed) => {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Smooth fractal value noise around 0 (about ±1). */
export function fbm(seed, scales = [26, 12, 6], amps = [1, 0.6, 0.35]) {
  return (x, y) => { let s = 0; for (let i = 0; i < scales.length; i++) s += amps[i] * (vnoise(x / scales[i], y / scales[i], seed + 31 * i) - 0.5); return s; };
}

/** Ground (textured) below the horizon y = horizonY, smooth bright sky above; world px -> luma. */
export function landscape({ seed = 1, horizonY = 300, skyLuma = 200, groundLuma = 95, texture = 70, skyTexture = 4 } = {}) {
  const g = fbm(seed), s = fbm(seed + 7, [80, 40], [1, 0.5]);
  return (x, y) => y < horizonY ? skyLuma - 0.05 * (horizonY - y) + skyTexture * s(x, y) : groundLuma + texture * g(x, y) + 6 * Math.sin(y / 9);
}

/** Render f at pixel centres through G (world -> raw): frame(p) = f(G^-1(p + 0.5)). */
export function renderField(f, w, h, G = { a: 1, b: 0, tx: 0, ty: 0 }, out = new Float32Array(w * h)) {
  const I = invertSim(G);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const X = I.a * (i + 0.5) - I.b * (j + 0.5) + I.tx, Y = I.b * (i + 0.5) + I.a * (j + 0.5) + I.ty;
      out[j * w + i] = f(X, Y);
    }
  }
  return out;
}

/** Precompute f on a canvas covering world [x0, x0 + cw) × [y0, y0 + ch) for fast bilinear warps. */
export function canvas(f, x0, y0, cw, ch) {
  const d = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) d[j * cw + i] = f(x0 + i + 0.5, y0 + j + 0.5);
  return { d, x0, y0, w: cw, h: ch };
}
/** Bilinear warp of a canvas through G (world -> raw) into a w×h float frame. */
export function warpCanvas(cv, w, h, G, out = new Float32Array(w * h)) {
  const I = invertSim(G), cw = cv.w, ch = cv.h, d = cv.d;
  for (let j = 0; j < h; j++) {
    let X = I.a * 0.5 - I.b * (j + 0.5) + I.tx - cv.x0 - 0.5, Y = I.b * 0.5 + I.a * (j + 0.5) + I.ty - cv.y0 - 0.5;
    for (let i = 0; i < w; i++, X += I.a, Y += I.b) {
      let ix = Math.floor(X), iy = Math.floor(Y);
      if (ix < 0) ix = 0; else if (ix > cw - 2) ix = cw - 2;
      if (iy < 0) iy = 0; else if (iy > ch - 2) iy = ch - 2;
      const fx = Math.min(1, Math.max(0, X - ix)), fy = Math.min(1, Math.max(0, Y - iy)), k = iy * cw + ix;
      out[j * w + i] = d[k] + (d[k + 1] - d[k]) * fx + (d[k + cw] - d[k]) * fy + (d[k] - d[k + 1] - d[k + cw] + d[k + cw + 1]) * fx * fy;
    }
  }
  return out;
}

/** Anti-aliased filled ellipse (raw px) blended into a float frame: coverage from a 1-px soft edge. */
export function drawEllipse(fr, w, h, cx, cy, rx, ry, luma, { angle = 0, alpha = 1 } = {}) {
  const c = Math.cos(angle), s = Math.sin(angle), R = Math.max(rx, ry) + 1.5;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const dx = i + 0.5 - cx, dy = j + 0.5 - cy, u = (c * dx + s * dy) / rx, v = (-s * dx + c * dy) / ry, q = Math.hypot(u, v);
      const edge = (1 - q) * Math.min(rx, ry), cov = Math.max(0, Math.min(1, edge + 0.5)) * alpha;
      if (cov > 0) fr[j * w + i] += (luma - fr[j * w + i]) * cov;
    }
  }
}
/**
 * Lambert-shaded sphere (raw px): luma = dark + (lit − dark)·clamp(n·L), with L the direction toward the light
 * (x right, y down, z toward the camera; the default lights the lower-right front), anti-aliased rim.
 */
export function drawShadedBall(fr, w, h, cx, cy, r, lit, dark, [lx, ly, lz] = [0.6, 0.6, 0.5]) {
  const ln = Math.hypot(lx, ly, lz), Lx = lx / ln, Ly = ly / ln, Lz = lz / ln, R = r + 1.5;
  for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(h - 1, Math.ceil(cy + R)); j++) {
    for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(w - 1, Math.ceil(cx + R)); i++) {
      const dx = (i + 0.5 - cx) / r, dy = (j + 0.5 - cy) / r, q = Math.hypot(dx, dy), cov = Math.max(0, Math.min(1, (1 - q) * r + 0.5));
      if (!cov) continue;
      const nz = Math.sqrt(Math.max(0, 1 - q * q)), v = dark + (lit - dark) * Math.min(1, Math.max(0, dx * Lx + dy * Ly + nz * Lz));
      fr[j * w + i] += (v - fr[j * w + i]) * cov;
    }
  }
}
/** Filled axis-aligned rectangle with fractional coverage. */
export function drawRect(fr, w, h, x0, y0, x1, y1, luma) {
  for (let j = Math.max(0, Math.floor(y0)); j < Math.min(h, Math.ceil(y1)); j++) {
    const cy = Math.min(j + 1, y1) - Math.max(j, y0);
    for (let i = Math.max(0, Math.floor(x0)); i < Math.min(w, Math.ceil(x1)); i++) {
      const cov = cy * (Math.min(i + 1, x1) - Math.max(i, x0));
      if (cov > 0) fr[j * w + i] += (luma - fr[j * w + i]) * cov;
    }
  }
}
const GTAB = (() => { const r = rng(12345), t = new Float32Array(1 << 16); for (let i = 0; i < t.length; i++) t[i] = r.gauss(); return t; })();
/** Float frame -> Uint8 with Gaussian noise (a shared table of normals at a random offset and stride per call). */
export function quantize(fr, r = null, sigma = 0, out = new Uint8Array(fr.length)) {
  const m = GTAB.length - 1, o = r ? (r() * m) | 0 : 0, st = r ? 1 + 2 * ((r() * 999) | 0) : 1;
  for (let i = 0, k = o; i < fr.length; i++, k = (k + st) & m) { const v = fr[i] + (sigma && r ? sigma * GTAB[k] : 0); out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
  return out;
}

/** Handheld-like similarity per frame: smooth random shake (px, deg, scale) plus optional drift/pan, zoom ramp. */
export function shakePath(n, { seed = 3, amp = 2, rotDeg = 0, zoom = 0, driftX = 0, driftY = 0, cx = 0, cy = 0, jitter = 0 } = {}) {
  const r = rng(seed), G = [];
  let ox = 0, oy = 0, vx = 0, vy = 0;
  for (let k = 0; k < n; k++) {
    // damped random walk (OU-like) for shake, plus white jitter
    vx = 0.7 * vx + r.gauss() * amp * 0.5; vy = 0.7 * vy + r.gauss() * amp * 0.5;
    ox = 0.8 * ox + vx; oy = 0.8 * oy + vy;
    const sx = Math.max(-2.5 * amp, Math.min(2.5 * amp, ox)) + jitter * r.gauss(), sy = Math.max(-2.5 * amp, Math.min(2.5 * amp, oy)) + jitter * r.gauss();
    const th = rotDeg * Math.PI / 180 * Math.sin(k / 7), sc = 1 + zoom * k / Math.max(1, n - 1);
    const a = sc * Math.cos(th), b = sc * Math.sin(th);
    // rotate/scale about (cx, cy), then translate
    G.push({ a, b, tx: cx - (a * cx - b * cy) + sx + driftX * k, ty: cy - (b * cx + a * cy) + sy + driftY * k });
  }
  return G;
}

export const relSim = (Ga, Gb) => composeSim(Gb, invertSim(Ga));   // raw of frame a -> raw of frame b
/** Max displacement error (px) of similarity E vs truth T over a grid of the frame. */
export function simError(E, T, w, h, step = 16) {
  let m = 0;
  for (let y = 0; y <= h; y += step) for (let x = 0; x <= w; x += step) {
    const p = applySim(E, x, y), q = applySim(T, x, y);
    m = Math.max(m, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return m;
}

const CANVASES = new WeakMap();
/**
 * A coarse-resolution clip: background canvas warped by the camera path G (world -> raw coarse px) plus objects
 * drawn in world coordinates. objects: [{at(k) -> {x, y, rx, ry?, angle?, luma, alpha?} | null}] (world px).
 * Returns {w, h, n, fps, pool, meta, G, frame(k) -> Uint8Array, image(k) -> LumaImage}.
 */
export function makeClip({ w = 540, h = 960, n = 60, fps = 30, pool = 2, seed = 1, G = null, bg = null, noise = 1.5, objects = [], margin = 160 } = {}) {
  const field = bg ?? landscape({ seed, horizonY: Math.round(h * 0.32) });
  const key = `${w}x${h}m${margin}`, per = CANVASES.get(field) ?? new Map();
  CANVASES.set(field, per);
  if (!per.has(key)) per.set(key, canvas(field, -margin, -margin, w + 2 * margin, h + 2 * margin));
  const cv = per.get(key), path = G ?? Array.from({ length: n }, () => ({ a: 1, b: 0, tx: 0, ty: 0 }));
  const fr = new Float32Array(w * h), r = rng(seed * 7919 + 1);
  const frame = k => {
    warpCanvas(cv, w, h, path[k], fr);
    const g = path[k], sc = Math.hypot(g.a, g.b), rot = Math.atan2(g.b, g.a);
    for (const o of objects) {
      const s = o.at(k);
      if (!s) continue;
      const q = applySim(g, s.x, s.y);
      if (s.shade) drawShadedBall(fr, w, h, q.x, q.y, s.rx * sc, s.luma, s.shade.dark, s.shade.light);
      else drawEllipse(fr, w, h, q.x, q.y, s.rx * sc, (s.ry ?? s.rx) * sc, s.luma, { angle: (s.angle ?? 0) + rot, alpha: s.alpha ?? 1 });
    }
    return quantize(fr, r, noise);
  };
  const times = Float64Array.from({ length: n }, (_, k) => k / fps);
  const meta = { width: w * pool, height: h * pool, fps, frameCount: n, times, duration: n / fps, rotation: 0, vfr: false, path: 'memory', hasAudio: false, codedWidth: w * pool, codedHeight: h * pool };
  return { w, h, n, fps, pool, meta, G: path, frame, image: k => ({ data: frame(k), w, h, pool }) };
}

/** Push every frame of a clip through a scanner; returns {log, ms} (ms = mean push time per frame). */
export function scanClip(Scanner, clip, opts = {}) {
  const sc = new Scanner(clip.meta, opts);
  let ms = 0;
  for (let k = 0; k < clip.n; k++) { const img = clip.image(k); const t0 = performance.now(); sc.push(k, k / clip.fps, img); ms += performance.now() - t0; }
  const t0 = performance.now(), log = sc.finish();
  return { log, ms: ms / clip.n, finishMs: performance.now() - t0, scanner: sc };
}

/**
 * Ball at (x, y) until kHit, then leaving along (vx, vy) world px/frame with optional per-frame acceleration.
 * phase in [0, 1): the impact happens that fraction of a frame after kHit (late impacts leave the first
 * post-impact frame near the address, D3 E6).
 */
export function ballPath({ x, y, r = 3, luma = 235, kHit = 1e9, vx = 0, vy = -10, ax = 0, ay = 0, untilK = 1e9, fromK = 0, phase = 0 }) {
  return { at: k => k < fromK || k > untilK ? null : k <= kHit ? { x, y, rx: r, luma } : (() => { const j = Math.max(0, k - kHit - phase); return { x: x + vx * j + 0.5 * ax * j * j, y: y + vy * j + 0.5 * ay * j * j, rx: r, luma }; })() };
}

/** Stabilized->raw native similarity of frame k when world px are coarse px of the clip (reference: frame 0). */
export function trueSim(clip, k) {
  const m = composeSim(clip.G[k], invertSim(clip.G[0]));
  return { a: m.a, b: m.b, tx: m.tx * clip.pool, ty: m.ty * clip.pool };
}
/** World (coarse) px -> stabilized native px. */
export function worldToStab(clip, x, y) { const q = applySim(clip.G[0], x, y); return { x: q.x * clip.pool, y: q.y * clip.pool }; }

/** Run a CandidateDetector + SpotTracker over a clip with the true camera; returns SpotTracker.finish() + tracker. */
export function runSpots(mod, clip, { params, stride = 1, motion = true } = {}) {
  const det = new mod.CandidateDetector(clip.w, clip.h, params ? { params } : {});
  const st = new mod.SpotTracker(clip.meta, { pool: clip.pool, stride, ...(params ? { params } : {}) });
  let prev = null;
  for (let k = 0; k < clip.n; k += stride) {
    const img = clip.image(k);
    const cands = det.detect(img.data, { large: st.largest > 12 });
    // a cheap motion mask for mover tests: raw |Δ| > 10 against the previous analyzed frame (static camera clips)
    let mm = null;
    if (motion && prev) {
      const cw = Math.ceil(clip.w / 4), ch = Math.ceil(clip.h / 4), data = new Uint8Array(cw * ch);
      for (let y = 0; y < clip.h; y++) for (let x = 0; x < clip.w; x++) if (Math.abs(img.data[y * clip.w + x] - prev[y * clip.w + x]) > 10) data[((y / 4) | 0) * cw + ((x / 4) | 0)] = 1;
      mm = { data, w: cw, h: ch, cellPx: 4 };
    }
    st.push(k, k / clip.fps, img, cands, trueSim(clip, k), { detector: det, motion: mm });
    prev = img.data;
  }
  return { ...st.finish(), tracker: st };
}

/**
 * A simplified swing around a ball at (bx, by) (world coarse px): a golfer body (big dark ellipse that turns),
 * a white glove on the hands' arc, and a club head (dark ellipse, 2·r long) on a circle through the address that
 * rests behind the ball, takes away, pauses at the top and comes down to strike at kHit. ball: false for a
 * practice swing; hit: false for a swing that misses (whiff, the club passes 2 radii short).
 */
export function swing({ bx, by, r = 3, kTake = 30, kTop = 52, kDown = 58, kHit = 64, n = 100, ball = true, hit = true, ballV = [3, -40], club = 'dark', golfer = true } = {}) {
  const Rc = 22 * r, cx = bx, cy = by - Rc, rest = 0.14, top = 2.7, miss = hit ? 0 : 2 * r;
  const ease = u => u * u * (3 - 2 * u);
  const phi = k => {
    if (k < kTake) return Math.PI / 2 + rest;
    if (k < kTop) return Math.PI / 2 + rest + (top - rest) * ease((k - kTake) / (kTop - kTake));
    if (k < kDown) return Math.PI / 2 + top;
    if (k <= kHit) { const u = (k - kDown) / (kHit - kDown); return Math.PI / 2 + top * (1 - u * u); }
    // follow-through: leaves the address at the impact speed, decelerates and stops at the finish
    const T = (kHit - kDown) * 1.5, v = Math.min(1, (k - kHit) / T);
    return Math.PI / 2 - top * (2 * v - v * v);
  };
  const head = k => { const p = phi(k); return { x: cx + (Rc + miss) * Math.cos(p), y: cy + (Rc + miss) * Math.sin(p) }; };
  const objs = [];
  if (golfer) {
    objs.push({ at: k => { const p = phi(k) - Math.PI / 2; return { x: bx - 9 * r - 2 * p, y: by - 26 * r, rx: 8 * r, ry: 17 * r, luma: 55, angle: 0.15 * p }; } });
    objs.push({ at: k => { const p = phi(k), q = { x: cx + 0.45 * Rc * Math.cos(p), y: cy + 0.45 * Rc * Math.sin(p) }; return { x: q.x - 4 * r, y: q.y + 2 * r, rx: 1.5 * r, luma: 225 }; } });
  }
  objs.push({ at: k => { const h = head(k), p = phi(k); return { x: h.x, y: h.y + 0.2 * r, rx: 2 * r, ry: 1.1 * r, angle: p + Math.PI / 2, luma: club === 'dark' ? 30 : 245 }; } });
  if (ball) objs.push(ballPath({ x: bx, y: by, r, kHit: hit ? kHit : 1e9, vx: ballV[0], vy: ballV[1] }));
  return { objects: objs, head, kHit, n };
}
