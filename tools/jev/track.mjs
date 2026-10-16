/**
 * Jev tracer: TypeSafe's Jev finds the ball, our code turns its answers into a trace. Runs in Node (ffmpeg needed).
 *
 *   1. address  Jev boxes the ball resting on the mat in a frame shortly before the swing (backswing, so the club
 *               head is not touching it); our code pins its centre and size.
 *   2. impact   our code follows the ball's spot frame by frame; impact is the frame after its last match.
 *   3. flight   Jev on the first 5 frames after impact, then every 3rd frame; each answer is refined to the pixels,
 *               and must fit the path so far (no sudden jumps). After Jev loses the ball, our own search keeps going
 *               for a few frames while it still finds a clear dot on the path.
 *   4. fill     frames Jev was not asked about: our search near the curve, else the curve itself.
 *   5. curve    a light smoothing, then a dense curve; after the last sighting a short predicted tail ("where it was
 *               heading") that fades out.
 *
 * Returns an HFResult (dist/hf/types.js), so the app draws and exports it like an hf trace.
 * Camera: assumed still (phone stabilization off); the result has identity camera samples.
 */
import { readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { curveStatus, makeConfidence, validateResult } from '../../dist/hf/types.js';
import { PARAMS } from '../../dist/hf/params.js';
import { fitFlightCurve } from './flight-curve.mjs';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg', FFPROBE = process.env.FFPROBE || 'ffprobe';
const API = 'https://api.typesafe.ai/v1/systemone', MODEL = 'jev-1.14.0';   // jev-latest is still 1.13, which has no Box

export const JEV = Object.freeze({
  everyNth: 3,            // after the first launchFrames, ask Jev every n-th frame
  launchFrames: 5,        // ask every frame for this many frames after impact
  minConf: 0.5,           // accept a Jev box at or above this confidence
  onPathConf: 0.35,       // ... or down to this when it lands right on the predicted path
  maxAskedMisses: 3,      // stop asking Jev after this many asked frames in a row without the ball
  firstSightFrames: 8,    // right after impact the club hides or blurs the ball: allow this many frames to first see it
  maxGapSec: 0.25,        // the ball may go unseen this long mid-flight (bright sky near the horizon, the club) before we stop
  coastFrames: 8,         // our search may continue this many frames after Jev stops finding the ball
  predictSec: 1.5,        // longest predicted tail (s), and at most as long as the observed flight
  maxFlightFrames: 300
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const median = a => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN; };
export function readKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  return readFileSync(join(homedir(), '.typesafe_key'), 'utf8').trim();
}

/* ------------------------------------------------------------------ questions */
const IGNORE_REST = 'Ignore balls lying farther out on the range, beside the mat, or in a basket or tray.';
const IGNORE_FLY = 'Ignore balls lying on the ground, the mat or in a basket, lights, the golfer, and the golf club (shaft and club head).';
const Q_REST = {
  box: { type: 'box', instructions: `the golf ball resting on the hitting mat or turf in front of the golfer's feet, the one about to be hit, in \`img\`. ${IGNORE_REST}` },
  present: { type: 'noul', instructions: `Is there a golf ball resting on the hitting mat or turf in front of the golfer's feet in \`img\`? ${IGNORE_REST}` }
};
const Q_FLY = {
  look: {
    type: 'choice', instructions: `How does the golf ball that was just hit appear in \`img\`? ${IGNORE_FLY}`,
    criteria: {
      ball: 'a round golf ball',
      streak: 'a short streak or thin line left by the moving ball (motion blur), lighter or darker than the background',
      not_visible: 'the ball that was just hit cannot be seen in the image'
    }
  },
  ball: { type: 'box', instructions: `the round golf ball that was just hit and is flying through the air, in \`img\`. ${IGNORE_FLY}` },
  streak: { type: 'box', instructions: `the streak or thin line left by the golf ball that was just hit, in \`img\`: the moving ball shows as a short streak, lighter or darker than the background, because of motion blur. Box the whole streak, end to end. ${IGNORE_FLY}` },
  present: { type: 'noul', instructions: 'Is the golf ball that was just hit visible in `img`, as a ball or a short streak or line? Answer no if the only balls are lying on the ground, the mat or in a basket, or if what you see is a light, the golf club or part of the golfer.' }
};

/* ------------------------------------------------------------------ math */
function polyfit(xs, ys, deg) {
  const m = deg + 1, M = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (let i = 0; i < xs.length; i++) for (let a = 0; a < m; a++) { M[a][m] += ys[i] * xs[i] ** a; for (let b = 0; b < m; b++) M[a][b] += xs[i] ** (a + b); }
  for (let i = 0; i < m; i++) { const p = M[i][i] || 1e-12; for (let r = i + 1; r < m; r++) { const f = M[r][i] / p; for (let c = i; c <= m; c++) M[r][c] -= f * M[i][c]; } }
  const x = new Array(m).fill(0); for (let i = m - 1; i >= 0; i--) { let s = M[i][m]; for (let c = i + 1; c < m; c++) s -= M[i][c] * x[c]; x[i] = s / (M[i][i] || 1e-12); }
  return x;
}
const ev = (c, u) => c.reduce((s, a, i) => s + a * u ** i, 0);
/** Guess at frame k from the last points: a curve from 4 points on, else a line. */
function predict(pts, k, { line = false } = {}) {
  const P = pts.slice(line ? -3 : -6), kc = P.at(-1).k, us = P.map(p => p.k - kc), deg = !line && P.length >= 4 ? 2 : 1;
  const cx = polyfit(us, P.map(p => p.x), deg), cy = polyfit(us, P.map(p => p.y), deg), u = k - kc;
  return { x: ev(cx, u), y: ev(cy, u), step: Math.hypot(ev(cx, u) - ev(cx, u - 1), ev(cy, u) - ev(cy, u - 1)) };
}
/** Catmull-Rom through points {k, x, y} in frame units, at frame k. */
function curveAt(P, k) {
  if (k <= P[0].k) return { k, x: P[0].x, y: P[0].y }; if (k >= P.at(-1).k) return { k, x: P.at(-1).x, y: P.at(-1).y };
  let i = 0; while (P[i + 1].k < k) i++;
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)], t = (k - p1.k) / (p2.k - p1.k);
  const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3);
  return { k, x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/**
 * A golf ball does not suddenly turn back or sideways: a step from the last point that is longer than a ball
 * width must stay within 60° of the recent flight direction (line through the last 3 points).
 */
function turnsBack(pts, at, d) {
  if (pts.length < 4) return false;
  const P = pts.slice(-3), last = P.at(-1), vx = last.x - P[0].x, vy = last.y - P[0].y, vn = Math.hypot(vx, vy);
  const dx = at.x - last.x, dy = at.y - last.y, dn = Math.hypot(dx, dy);
  if (dn <= Math.max(10, 2 * d)) return false;               // too small a step to have a direction
  if (vn < 1) return dn > Math.max(20, 4 * d);                // the ball had stalled: no big jump anywhere
  return (dx * vx + dy * vy) / (dn * vn) < Math.cos(Math.PI / 3);
}

/* ------------------------------------------------------------------ the clip */
async function openClip(video, dir, { framesToo = true } = {}) {
  mkdirSync(join(dir, 'frames'), { recursive: true });
  mkdirSync(join(dir, 'crops'), { recursive: true });
  const probe = JSON.parse((await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', video], { maxBuffer: 1 << 26 })).stdout);
  const times = probe.frames.map(f => +f.best_effort_timestamp_time).filter(Number.isFinite);
  if (framesToo) await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vsync', '0', '-start_number', '0', join(dir, 'frames', 'f%04d.png')], { maxBuffer: 1 << 26 });
  const NF = framesToo ? readdirSync(join(dir, 'frames')).length : times.length, file = k => join(dir, 'frames', `f${String(k).padStart(4, '0')}.png`);
  // Display size after rotation: what ffmpeg's frames (and the app) show.
  const [W, H] = framesToo ? execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file(0)]).toString().trim().split(',').map(Number)
    : (await run(FFMPEG, ['-v', 'error', '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'ppm', '-'], { encoding: 'latin1', maxBuffer: 1 << 28 })).stdout.split(/\s+/).slice(1, 3).map(Number);
  while (times.length < NF) times.push((times.at(-1) ?? 0) + 1 / 30);
  // A small grey copy of every frame: motion energy for the swing, and frames that repeat the previous one
  // (30 fps footage stored as 60 fps). Repeats show no new ball position, so they are dropped: from here on frame
  // k means the k-th distinct frame, and its time is when it first appears.
  const sw = 96, sh = Math.round(sw * H / W / 2) * 2;
  const raw = (await run(FFMPEG, ['-v', 'error', '-i', video, '-vf', `scale=${sw}:${sh}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 })).stdout;
  const nr = Math.min(NF, Math.floor(raw.length / (sw * sh))), keep = [0], energy = [0];
  for (let k = 1; k < nr; k++) {
    // A repeat changes no pixel by more than compression noise; a quiet real frame still moves the ball by 15+ levels.
    let s = 0, mx = 0; for (let i = 0; i < sw * sh; i++) { const d = Math.abs(raw[k * sw * sh + i] - raw[(k - 1) * sw * sh + i]); s += d; if (d > mx) mx = d; }
    if (mx > 4) { keep.push(k); energy.push(s / (sw * sh)); }
  }
  for (let k = nr; k < NF; k++) { keep.push(k); energy.push(0); }
  const N = keep.length, fr = k => file(keep[k]), utimes = keep.map(k => times[k]);
  const dt = median(utimes.slice(1).map((t, i) => t - utimes[i])) || 1 / 30;
  const cache = new Map();
  const gray = k => {
    if (!cache.has(k)) { if (cache.size > 8) cache.delete(cache.keys().next().value); cache.set(k, execFileSync(FFMPEG, ['-v', 'error', '-i', fr(k), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 })); }
    return cache.get(k);
  };
  return { dir, W, H, N, times: utimes, fps: 1 / dt, fr, gray, energy, repeats: NF - N };
}
const pxOf = (c, g, x, y) => g[clamp(Math.round(y), 0, c.H - 1) * c.W + clamp(Math.round(x), 0, c.W - 1)];
function crop(c, tag, k, cx, cy, size) {
  size = Math.min(size, c.W, c.H);
  const x = clamp(Math.round(cx - size / 2), 0, c.W - size), y = clamp(Math.round(cy - size / 2), 0, c.H - size), file = join(c.dir, 'crops', `${tag}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', c.fr(k), '-vf', `crop=${size}:${size}:${x}:${y}`, file]);
  return { file, x0: x, y0: y, w: size, h: size, s: 1 };
}
function fullFrame(c, tag, k) {
  const s = Math.min(1, 1568 / Math.max(c.W, c.H)), w = Math.round(c.W * s), h = Math.round(c.H * s), file = join(c.dir, 'crops', `${tag}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', c.fr(k), '-vf', `scale=${w}:${h}`, file]);
  return { file, x0: 0, y0: 0, w, h, s };
}
const cropInfo = cr => ({ file: cr.file.split('/').pop(), x0: cr.x0, y0: cr.y0, w: cr.w, h: cr.h, scale: cr.s });
const toFrame = (cr, b) => ({ x0: cr.x0 + b.left * cr.w / cr.s, x1: cr.x0 + b.right * cr.w / cr.s, y0: cr.y0 + b.top * cr.h / cr.s, y1: cr.y0 + b.bottom * cr.h / cr.s });

/** The swing: the biggest bursts of motion energy (distinct frames). */
async function swingPeak(c) {
  const e = c.energy, n = e.length;
  const win = Math.max(1, Math.round(0.1 * c.fps)), sm = new Float64Array(n);
  for (let k = 0; k < n; k++) for (let j = Math.max(0, k - win); j <= Math.min(n - 1, k + win); j++) sm[k] += e[j];
  // The swing is usually the biggest burst, but a zoom step or the golfer walking can beat it: the top 3 bursts, 1 s apart.
  const peaks = [], order = [...sm.keys()].sort((a, b) => sm[b] - sm[a]);
  for (const k of order) { if (peaks.every(p => Math.abs(p - k) > c.fps)) peaks.push(k); if (peaks.length === 3) break; }
  return peaks;
}

/* ------------------------------------------------------------------ Jev */
function jevClient(key, signal) {
  const stats = { calls: 0, tokens: 0, ms: 0, last: null };
  async function ask(cr, questions) {
    const req = { model: MODEL, state: { img: 'img-1' }, assets: { 'img-1': { type: 'image', part: 'img' } }, questions };
    for (let attempt = 0; attempt < 3; attempt++) {
      const fd = new FormData();
      fd.append('request', new Blob([JSON.stringify(req)], { type: 'application/json' }));
      fd.append('img', new Blob([readFileSync(cr.file)], { type: 'image/png' }), 'img.png');
      const t = Date.now(), res = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'TypeSafe-Danger-Zone-Images': 'true' }, body: fd, signal });
      const text = await res.text();
      if (res.ok) {
        const body = JSON.parse(text), ms = Date.now() - t; stats.calls++; stats.tokens += body.usage?.input_tokens ?? 0; stats.ms += ms;
        stats.last = { ms, tokens: body.usage?.input_tokens ?? 0, model: body.model, answers: body.answers, attempt };
        return body.answers;
      }
      if (res.status < 500 && res.status !== 429) throw new Error(`Jev ${res.status}: ${text.slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    throw new Error('Jev did not answer after 3 tries');
  }
  return { ask, stats };
}

/* ------------------------------------------------------------------ our pixel work */
/** The blob inside a box: pixels that differ from the box surroundings; centre and size. */
function refine(c, k, fb, pad = 6) {
  const g = c.gray(k), x0 = Math.floor(fb.x0 - pad), x1 = Math.ceil(fb.x1 + pad), y0 = Math.floor(fb.y0 - pad), y1 = Math.ceil(fb.y1 + pad), ring = [];
  for (let x = x0 - 4; x <= x1 + 4; x++) ring.push(pxOf(c, g, x, y0 - 4), pxOf(c, g, x, y1 + 4));
  for (let y = y0 - 4; y <= y1 + 4; y++) ring.push(pxOf(c, g, x0 - 4, y), pxOf(c, g, x1 + 4, y));
  const bg = median(ring);
  let peak = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) peak = Math.max(peak, Math.abs(pxOf(c, g, x, y) - bg));
  if (peak < 12) return null;
  const thr = Math.max(10, 0.4 * peak); let sw = 0, sx = 0, sy = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const w = Math.abs(pxOf(c, g, x, y) - bg) - thr; if (w > 0) { sw += w; sx += x * w; sy += y * w; n++; } }
  return { x: sx / sw, y: sy / sw, area: n, bg };
}
/** Our own search: the strongest compact blob near a guess. */
function search(c, k, guess, zMin = 5) {
  const R = Math.round(clamp(6 + 0.35 * guess.step, 6, 25)), g = c.gray(k), vals = [];
  for (let y = -R - 8; y <= R + 8; y += 2) for (let x = -R - 8; x <= R + 8; x += 2) vals.push(pxOf(c, g, guess.x + x, guess.y + y));
  const bg = median(vals), mad = Math.max(3, median(vals.map(v => Math.abs(v - bg))) * 1.48);
  let best = null;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const s = (Math.abs(pxOf(c, g, guess.x + x, guess.y + y) - bg) + Math.abs(pxOf(c, g, guess.x + x + 1, guess.y + y) - bg) + Math.abs(pxOf(c, g, guess.x + x, guess.y + y + 1) - bg)) / 3;
    const z = s / mad - Math.hypot(x, y) / R;
    if (z > zMin && (!best || z > best.z)) best = { x: guess.x + x, y: guess.y + y, z };
  }
  return best;
}

/* ------------------------------------------------------------------ the tracer */
/**
 * @param {string} video  path to the clip
 * @param {{workDir:string, key?:string, signal?:AbortSignal, onProgress?:(p:{phase:string, done:number, total:number, message?:string}) => void, keepFiles?:boolean}} opts
 */
export async function trackWithJev(video, { workDir, key = readKey(), signal, onProgress = () => {}, keepFiles = false, keepCrops = false } = {}) {
  const log = [], jev = jevClient(key, signal), started = Date.now();
  onProgress({ phase: 'probe', done: 0, total: 1, message: 'Reading the video…' });
  const c = await openClip(video, workDir);
  try {
    return await trace(c, video, jev, log, signal, onProgress, started);
  } finally {
    if (keepCrops) rmSync(join(workDir, 'frames'), { recursive: true, force: true });   // crops stay for review; frames are large
    else if (!keepFiles) rmSync(workDir, { recursive: true, force: true });
  }
}

async function trace(c, video, jev, log, signal, onProgress, started) {
  const { W, H, N, times } = c, diag = Math.hypot(W, H);
  const abstain = (code, extra = {}) => ({
    points: [], observations: [], camera: [], engine: 'hf', observedFrames: 0, status: 'no_reliable_track', reasonCodes: [code],
    confidence: makeConfidence(0), launch: null, completion: null, diagnostics: { engine: 'jev', log, jev: jev.stats, ms: Date.now() - started, ...extra }
  });

  /* 1. address: a frame shortly before the swing peak, when the club is up and away from the ball */
  onProgress({ phase: 'scan', done: 0, total: 1, message: 'Finding the swing…' });
  const peaks = await swingPeak(c);
  let last = null;
  for (const peak of peaks) {
    const r = await traceSwing(c, peak, jev, log, signal, onProgress, started);
    if (r.status !== 'no_reliable_track') return r;
    last = r; log.push({ step: 'swing', peak, why: r.reasonCodes[0] });
  }
  return last ?? abstain('no_launch');
}

async function traceSwing(c, peak, jev, log, signal, onProgress, started) {
  const { W, H, N, times } = c;
  const abstain = (code, extra = {}) => ({
    points: [], observations: [], camera: [], engine: 'hf', observedFrames: 0, status: 'no_reliable_track', reasonCodes: [code],
    confidence: makeConfidence(0), launch: null, completion: null, diagnostics: { engine: 'jev', log, jev: jev.stats, ms: Date.now() - started, ...extra }
  });
  let A = null, ADDR = -1;
  for (const back of [0.5, 0.8, 0.35, 1.2]) {
    const k = clamp(Math.round(peak - back * c.fps), 0, N - 1);
    if (log.some(l => l.step === 'address' && l.k === k)) continue;
    onProgress({ phase: 'impact', done: 0, total: 1, message: 'Finding the ball before the swing…' });
    const f = fullFrame(c, `addr-${k}`, k), a1 = await jev.ask(f, Q_REST), b1 = toFrame(f, a1.box.box);
    const cr = crop(c, `addr512-${k}`, k, (b1.x0 + b1.x1) / 2, (b1.y0 + b1.y1) / 2, 512), a2 = await jev.ask(cr, Q_REST), b2 = toFrame(cr, a2.box.box);
    const r = refine(c, k, b2);
    log.push({ step: 'address', k, t: times[k], conf: [a1.box.confidence, a2.box.confidence], present: a2.present.noul, refined: r,
      calls: [{ crop: cropInfo(f), boxPx: b1, answers: a1 }, { crop: cropInfo(cr), boxPx: b2, answers: a2, ms: jev.stats.last?.ms, tokens: jev.stats.last?.tokens }] });
    if (r && a2.box.confidence >= 0.5) { A = { x: r.x, y: r.y, d: Math.max(4, 2 * Math.sqrt(r.area / Math.PI)) }; ADDR = k; break; }
  }
  if (!A) return abstain('no_launch', { why: 'Jev did not find the ball before the swing' });

  /* 2. impact: follow the ball's spot; the frame after its last match */
  const r = Math.max(3, Math.round(A.d * 0.6)), S = 24, g0 = c.gray(ADDR), tpl = [];
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) tpl.push(pxOf(c, g0, A.x + x, A.y + y));
  const tm = tpl.reduce((s, v) => s + v, 0) / tpl.length, tv = Math.max(25, tpl.reduce((s, v) => s + (v - tm) ** 2, 0) / tpl.length);
  let cur = { x: A.x, y: A.y }, last = ADDR, absent = 0;
  for (let k = ADDR + 1; k < N && absent < 10; k++) {
    const g = c.gray(k); let best = { cost: Infinity };
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      let s = 0, i = 0; for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) s += (pxOf(c, g, cur.x + dx + x, cur.y + dy + y) - tpl[i++]) ** 2;
      if (s < best.cost) best = { cost: s, x: cur.x + dx, y: cur.y + dy };
    }
    if (best.cost / tpl.length / tv < 0.5) { last = k; absent = 0; cur = { x: best.x, y: best.y }; } else absent++;
  }
  const IMPACT = last + 1;
  if (IMPACT >= N - 2) return abstain('no_launch', { why: 'the ball never left its spot' });
  const t0 = (times[last] + times[IMPACT]) / 2, A0 = { x: cur.x, y: cur.y };
  log.push({ step: 'impact', lastPresent: last, t0, at: A0 });

  /* 3. flight: Jev on the first frames, then every n-th; our search coasts a little after Jev loses the ball */
  const pts = [];
  let askedMisses = 0, coast = 0;
  const end = Math.min(N, IMPACT + JEV.maxFlightFrames);
  let u = -1;   // index among the frames that are not repeats
  for (let k = IMPACT; k < end; k++) {
    u++;
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    onProgress({ phase: 'track', done: k - IMPACT, total: end - IMPACT, message: 'Following the ball…' });
    const isAsk = u < JEV.launchFrames || (u - JEV.launchFrames) % JEV.everyNth === 0;
    if (!pts.length && u >= JEV.firstSightFrames) { log.push({ step: 'stop', k, why: `no ball in the first ${JEV.firstSightFrames} frames` }); break; }
    // The ball can vanish for a moment (crossing the bright sky near the horizon, behind the club): keep looking
    // along the predicted line for up to maxGapSec without a sighting before giving up.
    if (pts.length && k - pts.at(-1).k > Math.round(JEV.maxGapSec * c.fps)) { log.push({ step: 'stop', k, why: `not seen for ${JEV.maxGapSec} s` }); break; }
    if (pts.length >= 2 && askedMisses >= JEV.maxAskedMisses && !isAsk) {
      // Jev keeps missing: between its questions our own search looks for a clear dot on the line.
      const gl = predict(pts, k, { line: true });
      if (gl.x < 0 || gl.y < 0 || gl.x >= W || gl.y >= H) { log.push({ step: 'stop', k, why: 'left the frame' }); break; }
      const f = coast < JEV.coastFrames ? search(c, k, gl, 6) : null;
      if (f && !turnsBack(pts, f, A.d)) { pts.push({ k, x: f.x, y: f.y, src: 'coast' }); coast++; }
      continue;
    }
    if (!isAsk) continue;
    let size = 1024, cx = A0.x, cy = A0.y - 300, guess = null;
    if (pts.length >= 2) {
      // One frame ahead a curve is best; further ahead a curve fitted to a slowing ball can shoot far off, a line does not.
      guess = k - pts.at(-1).k <= 1 ? predict(pts, k) : predict(pts, k, { line: true });
      if (guess.x < -20 || guess.x > W + 20 || guess.y < -20 || guess.y > H + 20) { log.push({ step: 'stop', k, why: 'predicted out of frame' }); break; }
      cx = guess.x; cy = guess.y;
      // Two points do not pin the speed yet: a medium crop around the straight-line guess (the whole frame makes a
      // small ball tiny for Jev); from three points on, a crop sized to the expected movement.
      if (pts.length === 2) { const gl = predict(pts, k, { line: true }); cx = gl.x; cy = gl.y; size = 640; }
      if (pts.length >= 3) size = clamp(Math.round(256 + 4 * predict(pts, k, { line: true }).step * (k - pts.at(-1).k)), 384, 1024);   // straight-line speed: a curve can blow up far ahead
    }
    const cr = crop(c, `fly-${k}`, k, cx, cy, size), ans = await jev.ask(cr, Q_FLY);
    const look = ans.look.choice, box = look === 'ball' ? ans.ball : ans.streak, fb = toFrame(cr, box.box);
    const centre = { x: (fb.x0 + fb.x1) / 2, y: (fb.y0 + fb.y1) / 2 }, ref = box.confidence >= JEV.onPathConf ? refine(c, k, fb) : null, at = ref ?? centre;
    let why = null;
    // Jev says 'not visible' but its box sits on the path over a real dot: treat it like a low-confidence sighting.
    // On faint dots Jev's box is more reliable than its 'how does it look' label: a confident box on the path over a
    // real dot counts, whatever the label says.
    const onPathHidden = look === 'not_visible' && guess && pts.length >= 3 && ref && box.confidence >= JEV.minConf &&
      Math.hypot(at.x - guess.x, at.y - guess.y) <= Math.min(250, Math.max(40, 1.5 * guess.step * (k - pts.at(-1).k) + 2 * A.d));
    if (look === 'not_visible' && !onPathHidden) why = 'Jev: not visible';
    else if (guess) {
      const gap = k - pts.at(-1).k, d = Math.hypot(at.x - guess.x, at.y - guess.y);
      // No sudden jumps: within the path's reach for this gap, and never more than 250 px off it.
      const gate = Math.min(250, Math.max(40, 1.5 * guess.step * gap + 2 * A.d)), tight = Math.max(15, 0.6 * guess.step + A.d);
      if (d > gate) why = `off the path by ${d.toFixed(0)} px`;
      else if (turnsBack(pts, at, A.d)) why = 'turns sharply off the flight direction';
      else if (box.confidence < JEV.minConf && !(pts.length >= 3 && ref && d <= Math.max(tight, 0.8 * guess.step * gap + 2 * A.d) && box.confidence >= JEV.onPathConf)) why = `low confidence ${box.confidence}`;
    } else if (box.confidence < JEV.minConf) why = `low confidence ${box.confidence}`;
    else if (at.y > A0.y + A.d) why = 'below the ball\'s spot';
    log.push({ step: 'flight', k, t: times[k], size, look, conf: box.confidence, present: ans.present.noul, at, accepted: !why, why,
      used: look === 'ball' ? 'ball' : 'streak', guess, crop: cropInfo(cr), boxPx: fb, refined: ref, answers: ans, ms: jev.stats.last?.ms, tokens: jev.stats.last?.tokens });
    if (why) {
      askedMisses++;
      if (pts.length >= 2) {
        const gl = predict(pts, k, { line: true }), f = search(c, k, gl, 6);
        if (f && !turnsBack(pts, f, A.d)) { pts.push({ k, x: f.x, y: f.y, src: 'search' }); log.push({ step: 'search-on-miss', k, at: f }); }
      }
      continue;
    }
    pts.push({ k, x: at.x, y: at.y, src: 'jev', look, conf: box.confidence }); askedMisses = 0;
    // An early point has no path to be checked against when accepted: drop it if the next points' line misses it.
    // Position only, not timing: the ball slows sharply on screen when it flies away from the camera.
    while (pts.length >= 3) {
      const [p0, p1, p2] = pts, dl = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, ux = (p2.x - p1.x) / dl, uy = (p2.y - p1.y) / dl;
      const vx = p0.x - p1.x, vy = p0.y - p1.y, across = Math.abs(vx * uy - vy * ux), along = vx * ux + vy * uy;
      if (across <= Math.max(30, 2 * A.d, 0.15 * Math.hypot(vx, vy)) && along <= 0) break;
      log.push({ step: 'drop', k: p0.k, why: `off the later path's line by ${across.toFixed(0)} px${along > 0 ? ', ahead of it' : ''}` }); pts.shift();
    }
  }
  const seen = pts.filter(p => p.src === 'jev');
  if (seen.length < 3) return abstain('ball_not_found_after_impact', { impact: IMPACT });

  /* 3b. clean: drop a point its neighbours' smooth curve does not pass near (a Jev box a little off the ball) */
  for (let pass = 0; pass < 4 && pts.length > 4; pass++) {
    // Sideways distance from the line through its neighbours (3 points each side), ignoring timing: the ball's
    // on-screen speed changes fast after launch, its direction does not.
    const res = pts.map((p, i) => {
      const nb = [...pts.slice(Math.max(0, i - 3), i), ...pts.slice(i + 1, i + 4)];
      if (nb.length < 3) return 0;
      const mx = nb.reduce((a, q) => a + q.x, 0) / nb.length, my = nb.reduce((a, q) => a + q.y, 0) / nb.length;
      let sxx = 0, syy = 0, sxy = 0; for (const q of nb) { sxx += (q.x - mx) ** 2; syy += (q.y - my) ** 2; sxy += (q.x - mx) * (q.y - my); }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
      return Math.abs((p.x - mx) * uy - (p.y - my) * ux);
    });
    const worst = res.indexOf(Math.max(...res));
    if (res[worst] <= Math.max(6, 3 * median(res))) break;
    log.push({ step: 'clean', k: pts[worst].k, src: pts[worst].src, off: +res[worst].toFixed(1) });
    pts.splice(worst, 1);
  }

  /* 4. fill the frames between answers: our search near the curve, else the curve */
  const track = [...pts];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], step = Math.hypot(b.x - a.x, b.y - a.y) / (b.k - a.k);
    for (let k = a.k + 1; k < b.k; k++) {
      const cv = curveAt(pts, k), f = search(c, k, { ...cv, step });
      track.push(f && Math.hypot(f.x - cv.x, f.y - cv.y) < Math.max(8, 0.6 * step) ? { k, x: f.x, y: f.y, src: 'search' } : { k, x: cv.x, y: cv.y, src: 'curve' });
    }
  }
  track.sort((p, q) => p.k - q.k);

  /* 5. curve: light smoothing (local quadratic over ±3 frames), anchor at the ball's spot at impact */
  const smooth = track.map(p => {
    const nb = track.filter(q => Math.abs(q.k - p.k) <= 3), us = nb.map(q => q.k - p.k), w = nb.length >= 5 ? 2 : 1;
    return { k: p.k, x: polyfit(us, nb.map(q => q.x), w)[0], y: polyfit(us, nb.map(q => q.y), w)[0], src: p.src };
  });
  return buildResult(c, { A0, t0, smooth, jev, log, started, impact: IMPACT, addressFrame: ADDR, raw: track, ballD: A.d });
}

/** Rebuild a saved result's curve and tail from its own points (no Jev calls): for tuning the curve. */
export async function refit(video, saved) {
  const c = await openClip(video, (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'jev-refit-')), { framesToo: false });
  const d = saved.diagnostics, imp = d.log.find(l => l.step === 'impact' && l.lastPresent === d.impactFrame - 1) ?? d.log.filter(l => l.step === 'impact').at(-1);
  const raw = d.track.map(p => ({ ...p })), stats = { calls: d.jev.calls, tokens: d.jev.tokens, ms: d.jev.ms };
  const used = d.log.filter(l => l.step === 'address' && l.refined).at(-1), ballD = used ? Math.max(4, 2 * Math.sqrt(used.refined.area / Math.PI)) : null;
  return buildResult(c, { A0: imp.at, t0: imp.t0, smooth: null, jev: { stats }, log: d.log, started: Date.now() - d.ms, impact: d.impactFrame, addressFrame: d.addressFrame, raw, ballD });
}

/** HFResult: one smooth fitted flight curve (flight-curve.mjs), then a predicted tail that fades ("where it was heading"). */
export function buildResult(c, { A0, t0, smooth, jev, log, started, impact, addressFrame, raw, ballD = null }) {
  const { W, H, times, fps } = c, diag = Math.hypot(W, H), tOf = k => times[k] ?? times.at(-1) + (k - times.length + 1) / fps;
  // Jev answers count fully; our search a bit less; positions read off a curve barely (they only bridge gaps).
  const WEIGHT = { jev: 1, search: 0.7, coast: 0.5, curve: 0.15 };
  const fit = fitFlightCurve({ t: t0, x: A0.x, y: A0.y }, raw.map(p => ({ t: tOf(p.k), x: p.x, y: p.y, w: WEIGHT[p.src] ?? 0.5 })));
  const obsT = [...new Set(raw.map(p => tOf(p.k)))].sort((a, b) => a - b).filter(t => t > t0);
  const obs = obsT.map(t => { const q = fit.at(t); return { t, x: q.x / W, y: q.y / H, sigma: 1 / diag }; });
  const gap = 1 / PARAMS.display.hz, half = PARAMS.display.observedHalfFrame / fps, tLast = obsT.at(-1);
  const points = [{ t: t0, x: A0.x / W, y: A0.y / H, status: 'anchor' }], dense = [];
  for (let t = t0 + gap; t < tLast - 1e-6; t += gap) dense.push(t);
  for (const t of [...new Set([...dense, ...obsT].map(t => +t.toFixed(9)))].sort((a, b) => a - b)) {
    if (t <= points.at(-1).t + 1e-9) continue;
    const q = fit.at(t);
    points.push({ t, x: q.x / W, y: q.y / H, status: curveStatus(t, obsT, half) });
  }
  // "Where it was heading": the trace continues the way it was going (flight-curve.mjs tail), up to the length of the
  // visible flight and at most JEV.predictSec; it fades over its second half, or stops where it leaves the frame.
  const observedSec = tLast - t0, horizon = Math.min(JEV.predictSec, observedSec), raw2 = horizon > gap ? fit.tail(horizon, gap) : [];
  const tailPts = raw2.map((q, i) => ({ ...q, alpha: clamp(2 * (1 - (i + 1) / raw2.length), 0, 1) }));
  let endType = 'fade';
  for (const q of tailPts) {
    if (q.x < 0 || q.y < 0 || q.x > W || q.y > H) { endType = 'exit'; break; }
    if (q.t <= points.at(-1).t + 1e-9) continue;
    points.push({ t: q.t, x: q.x / W, y: q.y / H, status: 'predicted', alpha: clamp(q.alpha, 0, Math.min(1, points.at(-1).alpha ?? 1)) });
  }
  const predicted = points.filter(p => p.status === 'predicted');
  if (predicted.length && endType === 'fade') predicted.at(-1).alpha = 0;
  const endP = points.at(-1);
  const camera = times.map(t => ({ t, x: 0, y: 0 }));
  const status = predicted.length && obs.length >= 9 ? 'tracked' : 'partial';
  const q0 = fit.at(Math.min(tLast, t0 + 0.05)), d0 = { x: q0.x - A0.x, y: q0.y - A0.y }, dn = Math.hypot(d0.x, d0.y) || 1;
  const nJev = raw.filter(p => p.src === 'jev').length;
  const result = {
    points, observations: obs, camera, engine: 'hf', observedFrames: obs.length, status,
    reasonCodes: status === 'tracked' ? [] : ['tracking_ended_early'],
    confidence: makeConfidence(clamp(0.5 + 0.02 * nJev, 0, 0.9), { jevPoints: nJev, searchPoints: raw.filter(p => p.src !== 'jev').length }),
    launch: { t: t0, x: A0.x / W, y: A0.y / H, dir: { x: d0.x / dn, y: d0.y / dn }, view: 'unknown' },
    completion: predicted.length ? { end: { type: endType, t: endP.t, x: endP.x, y: endP.y }, observedEnd: endType === 'exit' ? 'frame_exit' : 'lost', observedSec, predictedSec: endP.t - tLast, slowMoFactor: 1 } : null,
    diagnostics: { engine: 'jev', fitResidualPx: +Math.sqrt(fit.residuals.reduce((a, r) => a + r * r, 0) / Math.max(1, fit.residuals.length)).toFixed(2), repeatedFramesDropped: c.repeats, jev: { ...jev.stats, last: undefined, usd: +(jev.stats.tokens * 42e-9).toFixed(5) }, ms: Date.now() - started, addressFrame, impactFrame: impact, track: raw.map(p => ({ k: p.k, src: p.src, x: Math.round(p.x), y: Math.round(p.y) })), log }
  };
  const v = validateResult(result, { width: W, height: H, fps });
  if (!v.ok && predicted.length) {
    // Too short a flight for a completion (the hf rules): keep the observed trace, without the predicted tail.
    const kept = points.filter(p => p.status !== 'predicted'), noTail = { ...result, points: kept, completion: null, status: 'partial', reasonCodes: ['tracking_ended_early'] };
    const v2 = validateResult(noTail, { width: W, height: H, fps });
    noTail.diagnostics = { ...result.diagnostics, tailDropped: v.errors.slice(0, 3), ...(v2.ok ? {} : { validation: v2.errors.slice(0, 10) }) };
    return noTail;
  }
  if (!v.ok) result.diagnostics.validation = v.errors.slice(0, 10);
  return result;
}
