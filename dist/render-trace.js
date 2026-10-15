/**
 * The tracer, drawn the same way in the preview and the export: one continuous stroke that grows with video time,
 * in camera-stabilized normalized coordinates mapped onto the frame on screen (camera samples {t, x, y, s?, r?}).
 *
 * hf results are already the dense display curve (docs/TRACKING_HF_PROTOCOL.md §8), so their points are drawn as
 * they are, never through smoothFlight: predicted points look exactly like observed ones and only the end fades,
 * by each point's alpha; the last point is completion.end. v2 and manual traces are curved by curve.js first.
 *
 * Reveal (the design's revealT and compressedReveal; an HFResult keeps only t): a point shows once video time
 * reaches its reveal time, which is its t, unless a predicted tail runs past what the clip can show. Then the arc
 * after the last measured point (at the latest END_HOLD_SEC + MIN_REVEAL_SEC before the clip ends) is revealed on
 * a linear compressed clock that finishes END_HOLD_SEC before the end, so the last frames hold the completed arc.
 */
import { smoothFlight } from './curve.js?v=53';

// Line width per 1280 px of the canvas long side: fat enough that small mid-flight wobble reads as one ribbon.
export const TRACE_WIDTH = 14;
export const TRAIL_SEC = 0.55;        // what stays visible with "Keep the full flight visible" off (reveal seconds)
export const END_HOLD_SEC = 0.15;     // the completed arc stays up for the clip's last 0.15 s
export const MIN_REVEAL_SEC = 0.25;   // a compressed reveal runs at least this long
const IDENTITY = Object.freeze({ t: 0, x: 0, y: 0, s: 1, r: 0 });
const FADE_STEPS = 32;                // alpha levels the fading end is drawn in
const finite = p => Number.isFinite(p?.t) && Number.isFinite(p.x) && Number.isFinite(p.y);
const lerp = (a, b, u) => a + (b - a) * u;
const measured = p => p.status !== 'predicted' && p.status !== 'interpolated';

/**
 * Reveal clock: video time -> reveal time of a curve point at t. Identity unless the arc has a predicted tail
 * (after `last`, the last measured point) that ends after clipEnd − END_HOLD_SEC; then times after
 * a = max(first, min(last, clipEnd − END_HOLD_SEC − MIN_REVEAL_SEC)) map linearly onto [a, clipEnd − END_HOLD_SEC].
 * clock.compressed is {from, to, scale} or null.
 */
export function revealClock(first, last, end, clipEnd) {
  const to = clipEnd - END_HOLD_SEC;
  if (!Number.isFinite(clipEnd) || !(end > to) || !(end > last + 1e-9)) return Object.assign(t => t, { compressed: null });
  const from = Math.max(first, Math.min(last, to - MIN_REVEAL_SEC)), stop = Math.max(from, to), scale = (stop - from) / (end - from);
  return Object.assign(t => (t <= from ? t : from + (t - from) * scale), { compressed: { from, to: stop, scale } });
}

/**
 * The drawable curve of a trace: samples {t, x, y, alpha, revealT}, stabilized and normalized, sorted by t.
 * dense: an hf display curve, drawn as given; otherwise (v2, manual) smoothFlight, with the source's alpha
 * carried over by time (an edited hf trace keeps its end fade). clipEnd: the clip's duration (s).
 */
export function traceCurve(points, { dense = false, clipEnd = Infinity } = {}) {
  const src = (points ?? []).filter(finite).sort((a, b) => a.t - b.t);
  let samples;
  if (dense) samples = src.map(p => ({ t: p.t, x: p.x, y: p.y, alpha: p.alpha ?? 1 }));
  else {
    const fades = src.some(p => (p.alpha ?? 1) < 1);
    samples = smoothFlight(src).map(p => ({ t: p.t, x: p.x, y: p.y, alpha: fades ? alphaAt(src, p.t) : 1 }));
  }
  const last = src.filter(measured).at(-1)?.t ?? -Infinity;
  const clock = revealClock(samples[0]?.t ?? 0, last, samples.at(-1)?.t ?? 0, clipEnd);
  for (const s of samples) s.revealT = clock(s.t);
  return { samples, dense, clipEnd, compressed: clock.compressed };
}

/** Alpha of a sorted point list at time t (linear between points, held outside). */
function alphaAt(points, t) {
  let lo = 0, hi = points.length - 1;
  if (t <= points[0].t) return points[0].alpha ?? 1;
  if (t >= points[hi].t) return points[hi].alpha ?? 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].t <= t) lo = m; else hi = m; }
  const a = points[lo], b = points[hi];
  return lerp(a.alpha ?? 1, b.alpha ?? 1, (t - a.t) / (b.t - a.t));
}

/**
 * The part of the curve shown at video time `time`: every sample revealed by then (the last TRAIL_SEC of reveal
 * time without hold), plus the head, interpolated between the last revealed sample and the next. [] before the start.
 */
export function visibleTrace(curve, time, { hold = true } = {}) {
  const s = curve.samples, n = s.length;
  if (n < 2 || !(time >= s[0].revealT)) return [];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].revealT <= time) lo = m; else hi = m - 1; }
  const from = hold ? -Infinity : time - TRAIL_SEC, out = [];
  for (let i = 0; i <= lo; i++) if (s[i].revealT >= from) out.push(s[i]);
  if (lo + 1 < n) {
    const a = s[lo], b = s[lo + 1], u = (time - a.revealT) / (b.revealT - a.revealT);
    out.push({ t: lerp(a.t, b.t, u), x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), alpha: lerp(a.alpha, b.alpha, u), revealT: time });
  }
  return out;
}

/** Camera sample at time t: linear between samples, clamped to the first and last; s and r default to 1 and 0. */
export function cameraAt(camera, t) {
  if (!camera?.length) return IDENTITY;
  let lo = 0, hi = camera.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (camera[m].t < t) lo = m + 1; else hi = m; }
  const b = camera[lo], a = camera[Math.max(0, lo - 1)], u = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  // Rotation by the short way round (r is tiny in practice).
  const dr = Math.atan2(Math.sin((b.r ?? 0) - (a.r ?? 0)), Math.cos((b.r ?? 0) - (a.r ?? 0)));
  return { t, x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), s: lerp(a.s ?? 1, b.s ?? 1, u), r: (a.r ?? 0) + dr * u };
}

/**
 * Stabilized -> raw (normalized) for a width × height frame: raw = c + s·R(r)·(stab − c) + (x·W, y·H), c the frame
 * centre (dist/hf/types.js cameraToRaw). With s = 1, r = 0 it is v2's raw = stab + (x, y).
 */
export function toRaw(cam, x, y, width, height) {
  const s = cam.s ?? 1, r = cam.r ?? 0, a = s * Math.cos(r), b = s * Math.sin(r), dx = (x - 0.5) * width, dy = (y - 0.5) * height;
  return { x: 0.5 + (a * dx - b * dy) / width + cam.x, y: 0.5 + (b * dx + a * dy) / height + cam.y };
}
/** Raw -> stabilized (normalized): the inverse of toRaw, for points placed on the frame on screen. */
export function toStab(cam, x, y, width, height) {
  const s = cam.s ?? 1, r = cam.r ?? 0, a = Math.cos(r) / s, b = -Math.sin(r) / s, dx = (x - 0.5 - cam.x) * width, dy = (y - 0.5 - cam.y) * height;
  return { x: 0.5 + (a * dx - b * dy) / width, y: 0.5 + (b * dx + a * dy) / height };
}

/**
 * Draw the trace at video time `time` on a width × height canvas: a soft glow (optional) and a core stroke, one path
 * while opaque; the fading end in a few constant-alpha runs (butt-capped, so they never overlap), and a head dot.
 * @returns {number} the number of points drawn (0: nothing)
 */
export function drawTrace(ctx, curve, time, { width, height, camera = [], color = '#f5fa9b', glow = true, hold = true } = {}) {
  const path = visibleTrace(curve, time, { hold });
  if (path.length < 2) return 0;
  const cam = cameraAt(camera, time), line = TRACE_WIDTH * Math.max(width, height) / 1280;
  const pts = path.map(p => { const r = toRaw(cam, p.x, p.y, width, height); return { x: r.x * width, y: r.y * height, a: Math.round(Math.max(0, Math.min(1, p.alpha ?? 1)) * FADE_STEPS) / FADE_STEPS }; });
  const runs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = Math.min(pts[i - 1].a, pts[i].a), run = runs.at(-1);
    if (run && run.alpha === a) run.end = i; else runs.push({ alpha: a, start: i - 1, end: i });
  }
  ctx.save();
  ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.shadowColor = color;
  const stroke = (lineWidth, alpha, blur) => {
    ctx.lineWidth = lineWidth; ctx.shadowBlur = blur;
    for (const [k, run] of runs.entries()) {
      if (!run.alpha) continue;
      // The opaque body keeps round caps; fading runs meet their neighbours edge to edge.
      ctx.lineCap = !k && run.alpha === 1 ? 'round' : 'butt';
      ctx.globalAlpha = alpha * run.alpha;
      ctx.beginPath(); ctx.moveTo(pts[run.start].x, pts[run.start].y);
      for (let i = run.start + 1; i <= run.end; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  };
  // Soft under-stroke + fat core so tiny lateral jitter disappears into the ribbon.
  if (glow) stroke(line * 1.55, 0.45, line * 1.8);
  stroke(line, 1, 0);
  const head = pts.at(-1);
  ctx.shadowBlur = 0; ctx.globalAlpha = head.a; ctx.fillStyle = '#ffffec';
  ctx.beginPath(); ctx.arc(head.x, head.y, line * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  return pts.length;
}

/**
 * Points shown while adjusting a trace: v2 and manual points as they are; an hf display curve (120 Hz) thinned to
 * its anchor, its placed points, its end and one sample every `gap` s, so the dots stay readable.
 */
export function traceKnots(points, { gap = 1 / 30 } = {}) {
  if (!points.some(p => p.status && p.status !== 'manual')) return points;
  const out = [];
  for (const [i, p] of points.entries()) {
    if (!i || i === points.length - 1 || p.status === 'anchor' || p.status === 'manual' || p.t - out.at(-1).t >= gap - 1e-9) out.push(p);
  }
  return out;
}

/** Manual-adjust dots: measured and placed points full size, predicted ones smaller; the one at `time` highlighted. */
export function drawKnots(ctx, points, time, { width, height, camera = [] } = {}) {
  const cam = cameraAt(camera, time);
  ctx.save();
  for (const p of traceKnots(points)) {
    const r = toRaw(cam, p.x, p.y, width, height), near = Math.abs(p.t - time) < .055, guess = p.status === 'predicted' || p.status === 'interpolated';
    ctx.globalAlpha = guess && !near ? 0.6 : 1;
    ctx.strokeStyle = near ? '#fff' : '#e4f799'; ctx.lineWidth = 2; ctx.fillStyle = '#173d2b99';
    ctx.beginPath(); ctx.arc(r.x * width, r.y * height, near ? 9 : guess ? 3.5 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
