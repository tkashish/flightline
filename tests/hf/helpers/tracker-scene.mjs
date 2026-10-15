/**
 * Procedural pixel-level scenes for the U6 tracker tests. A flat sky with deterministic hash noise (sensor noise
 * in raw px) and antialiased discs (ball, plane, bird, specks...) at per-frame positions given in STABILIZED px,
 * mapped to raw px by a CameraTrack. Pixels are rendered only inside requested rects, so a 720x1280 or 4K clip
 * costs only its ROIs; lumaRect follows cropLuma exactly (edge clamping, integer pooling with rounding, `valid`).
 */
import { makeSourceMeta, timingFromTimes, identityTrack, simAt, applySim, poolLuma, HFError } from '../../../dist/hf/types.js';

/** Uniform hash in [0, 1) of integer coordinates. */
export function hash01(x, y, k, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(k | 0, 2246822519) ^ Math.imul(seed | 0, 3266489917);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** E5-style "size" (blob area px) to a disc diameter. */
export const sizeToD = size => 2 * Math.sqrt(size / Math.PI);

/**
 * @param {{width?:number, height?:number, fps?:number, frameCount?:number, sky?:number, noise?:number, seed?:number,
 *   objects?:{id:string, at:(k:number)=>({x:number, y:number, d:number, c:number}|null)}[],
 *   occluders?:{at:(k:number)=>({x0:number, y0:number, x1:number, y1:number, v:number}|null)}[], camera?:object}} o
 */
export function makeScene(o = {}) {
  const { width = 720, height = 1280, fps = 30, frameCount = 120, sky = 110, noise = 2, seed = 1, objects = [], occluders = [] } = o;
  const times = Float64Array.from({ length: frameCount }, (_, i) => i / fps);
  const timing = timingFromTimes(times, fps);
  const meta = makeSourceMeta({ width, height, fps: timing.fps, vfr: false, frameCount, times, duration: timing.duration, path: 'memory', hasAudio: false });
  const camera = o.camera ?? identityTrack(meta);
  const cache = new Map();
  const frameObjects = k => {
    let v = cache.get(k);
    if (v) return v;
    const sim = simAt(camera, k), objs = [];
    for (const ob of objects) {
      const p = ob.at(k);
      if (!p || !(p.d > 0) || !p.c) continue;
      const raw = applySim(sim, p.x, p.y), r = p.d / 2;
      objs.push({ x: raw.x, y: raw.y, r, c: p.c, x0: Math.floor(raw.x - r - 1), x1: Math.ceil(raw.x + r + 1), y0: Math.floor(raw.y - r - 1), y1: Math.ceil(raw.y + r + 1) });
    }
    const occ = occluders.map(q => q.at(k)).filter(Boolean);
    v = { objs, occ };
    cache.set(k, v);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return v;
  };
  const amp = noise * Math.sqrt(12);
  /** Luma of native raw pixel (X, Y) of frame k (integer coordinates inside the frame). */
  const pixel = (X, Y, k, fo) => {
    for (const q of fo.occ) if (X >= q.x0 && X < q.x1 && Y >= q.y0 && Y < q.y1) return q.v;
    let v = sky + (hash01(X, Y, k, seed) - 0.5) * amp;
    for (const b of fo.objs) {
      if (X < b.x0 || X > b.x1 || Y < b.y0 || Y > b.y1) continue;
      const cov = Math.min(1, Math.max(0, b.r + 0.5 - Math.hypot(X + 0.5 - b.x, Y + 0.5 - b.y)));
      if (cov) v += b.c * cov;
    }
    return Math.min(255, Math.max(0, Math.round(v)));
  };
  const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function lumaRect(k, rect, pool = 1) {
    if (!(Number.isInteger(pool) && pool > 0) || rect.w < pool || rect.h < pool) throw new HFError('bad-arg', 'rect/pool');
    const fo = frameObjects(k), w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool), data = new Uint8Array(w * h);
    const area = pool * pool, half = area >> 1;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0;
      for (let b = 0; b < pool; b++) {
        const Y = clampI(rect.y + j * pool + b, 0, height - 1);
        for (let a = 0; a < pool; a++) s += pixel(clampI(rect.x + i * pool + a, 0, width - 1), Y, k, fo);
      }
      data[j * w + i] = (s + half) / area | 0;
    }
    const x0 = clampI(Math.ceil(-rect.x / pool), 0, w), y0 = clampI(Math.ceil(-rect.y / pool), 0, h);
    const valid = { x0, y0, x1: clampI(Math.floor((width - rect.x) / pool), x0, w), y1: clampI(Math.floor((height - rect.y) / pool), y0, h) };
    return { data, w, h, x0: rect.x, y0: rect.y, pool, valid };
  }
  /** Whole native plane of frame k (slow: tests of the renderer itself only). */
  function plane(k) {
    const fo = frameObjects(k), out = new Uint8Array(width * height);
    for (let Y = 0; Y < height; Y++) for (let X = 0; X < width; X++) out[Y * width + X] = pixel(X, Y, k, fo);
    return out;
  }
  const source = {
    meta,
    async *frames({ from = 0, to = frameCount, stride = 1 } = {}) {
      for (let k = Math.max(0, from); k < Math.min(to, frameCount); k += stride) {
        let open = true;
        yield {
          index: k, t: times[k],
          async lumaRect(rect, { pool = 1 } = {}) { if (!open) throw new HFError('closed', 'closed'); return lumaRect(k, rect, pool); },
          async lumaCoarse(longEdge) { const p = Math.max(1, Math.round(Math.max(width, height) / longEdge)); return poolLuma(plane(k), width, height, p); },
          close() { open = false; }
        };
      }
    },
    async close() {}
  };
  return { meta, camera, source, lumaRect, plane, pixel: (X, Y, k) => pixel(X, Y, k, frameObjects(k)) };
}

/** E5 `ballPath` (D1-scratch/e5/synth.mjs): discrete drag + gravity in px/frame, frames impact+1 .. impact+n. */
export function ballPath({ impact = 60, x0 = 400, y0 = 900, vx = 3, vy = -25, g = 0.55, drag = 0.03, n = 40, size0 = 40, fps = 30 } = {}) {
  const out = [];
  let x = x0, y = y0, ux = vx, uy = vy;
  for (let k = 1; k <= n; k++) {
    x += ux; y += uy; uy += g; ux *= (1 - drag); uy = uy * (1 - drag);
    const i = impact + k;
    out.push({ i, t: i / fps, x, y, size: Math.max(3, Math.round(size0 * Math.exp(-k / 12))) });
  }
  return out;
}

/** Deterministic LCG in [0, 1) (E5 rng). */
export function rng(seed = 7) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

/** Scene object from a per-frame table {i -> {x, y, d}} with a fixed contrast. */
export function tableObject(id, rows, c) {
  const m = new Map(rows.map(r => [r.i, r]));
  return { id, at: k => { const r = m.get(k); return r ? { x: r.x, y: r.y, d: r.d ?? sizeToD(r.size), c: r.c ?? c } : null; } };
}
