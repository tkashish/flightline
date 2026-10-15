// Deterministic RNG, hashing and small vector/matrix helpers shared by the generator.
export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const smoother = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (6 * t - 15) + 10));
export const round = (v, d = 3) => { const k = 10 ** d; return Math.round(v * k) / k; };

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const addS = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function rotAxis(v, axis, ang) {
  const k = norm(axis), c = Math.cos(ang), s = Math.sin(ang), kv = dot(k, v), kx = cross(k, v);
  return [0, 1, 2].map(i => v[i] * c + kx[i] * s + k[i] * kv * (1 - c));
}
// Rotation about world Y (yaw), positive turns +Z toward +X.
export const rotY = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; };
export const mirrorX = v => [-v[0], v[1], v[2]];

/** Cubic Hermite on [0,1] with end values and end slopes (slopes per unit s). */
export function hermite(p0, m0, p1, m1, s) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}
export function hermiteD(p0, m0, p1, m1, s) {
  const s2 = s * s;
  return (6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1;
}

/** FNV-1a over the string forms of the parts. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x2f; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** sfc32 state [a, b, c, d] seeded through splitmix32 (before the 12 warm-up rounds). */
export function sfc32Seed(seed) {
  let s = seed >>> 0;
  const mix32 = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  return [mix32(), mix32(), mix32(), mix32()];
}

/** sfc32 seeded through splitmix32; every stream is independent and reproducible. */
export function rng(seed) {
  let [a, b, c, d] = sfc32Seed(seed);
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0; d = (d + 1) >>> 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) >>> 0; c = ((c << 21) | (c >>> 11)) >>> 0; c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    gauss: () => { let u = 0; while (u <= 1e-12) u = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); },
    normal: (m, sd) => m + sd * r.gauss(),
    logn: (median, sigma) => median * Math.exp(sigma * r.gauss()),
    pick: arr => arr[Math.floor(next() * arr.length)],
    weighted: obj => { const e = Object.entries(obj), tot = e.reduce((s, [, w]) => s + w, 0); let x = next() * tot; for (const [k, w] of e) if ((x -= w) < 0) return k; return e.at(-1)[0]; },
    shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
    sign: () => (next() < 0.5 ? -1 : 1)
  };
  return r;
}
export const rngFor = (seed, ...tags) => rng(hash32(seed, ...tags));

/** Smooth 1-D noise in [-1,1] from a seed: sum of a few incommensurate sines (cheap, deterministic). */
export function wobble(r, { freqs = [0.31, 0.73, 1.37], amps = [1, 0.5, 0.25] } = {}) {
  const ph = freqs.map(() => r.range(0, 2 * Math.PI)), fr = freqs.map(f => f * r.range(0.8, 1.25)), tot = amps.reduce((a, b) => a + b, 0);
  return t => { let v = 0; for (let i = 0; i < fr.length; i++) v += amps[i] * Math.sin(2 * Math.PI * fr[i] * t + ph[i]); return v / tot; };
}

/** Standard normal quantile (Acklam's rational approximation, relative error < 1.2e-9). */
export function invNormal(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = q => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 2-D value noise with smooth interpolation; returns n(x,y) in [0,1). */
export function valueNoise2(seed, period = 256) {
  const r = rng(seed), N = period, g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = r.next();
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const x0 = ((ix % N) + N) % N, y0 = ((iy % N) + N) % N, x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
    const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
}
/** Fractal sum of value noise, octave count limited by the sample footprint (anti-aliased). */
export function fbm2(seed, octaves = 5, gain = 0.5) {
  const ns = Array.from({ length: octaves }, (_, i) => valueNoise2(hash32(seed, 'oct', i)));
  return (x, y, footprint = 0) => {
    let v = 0, a = 1, f = 1, tot = 0;
    for (let i = 0; i < octaves; i++) {
      const fade = footprint > 0 ? clamp(1.5 - footprint * f, 0, 1) : 1;
      v += a * (fade ? ns[i](x * f + i * 17.3, y * f - i * 9.1) * fade + 0.5 * (1 - fade) : 0.5); tot += a; a *= gain; f *= 2.03;
    }
    return v / tot;
  };
}
