/**
 * Benchmark metrics (U7): score one engine result against synthetic ground truth (`<id>.gt.json`, schema
 * flightline-synth-gt-v1) and aggregate clips into a report with Wilson and cluster-bootstrap intervals.
 * Every D3 §9.4 metric plus the FINAL.md safety metrics. Pure functions, no Node APIs.
 *
 * Coordinates: GT positions are raw upright display px (pixel centres at +0.5); result points are normalized and
 * camera-stabilized, so each one is mapped to raw px through the result camera at its own time first.
 * Status-aware: only 'observed' points count as detections; 'predicted' points are scored only by the completion
 * metrics; 'anchor' and 'interpolated' points are never scored. v2 and legacy results have no point statuses, so
 * all of their points count as observed.
 */
import { PARAMS } from '../../dist/hf/params.js';
import { cameraToRaw } from '../../dist/hf/types.js';
import SPEC from './acceptance.json' with { type: 'json' };

export const ACCEPTANCE_SPEC = SPEC;
export const DEFINITIONS = SPEC.definitions;
export const DEFAULT_STRATA = SPEC.definitions.strata;
export const OUTCOMES = Object.freeze(['tracked', 'partial', 'abstained']);

const finite = Number.isFinite;
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r6 = v => Math.round(v * 1e6) / 1e6, r2 = v => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------ statistics */

/** Wilson score interval (95% by default) for k successes in n trials. n = 0 gives p = null. */
export function wilson(k, n, z = 1.959964) {
  if (!(n > 0)) return { k: 0, n: 0, p: null, lo: null, hi: null };
  const p = k / n, z2 = z * z, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den;
  const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return { k, n, p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** Linear-interpolated quantile (type 7); null for an empty list. */
export function quantile(values, q) {
  const a = Float64Array.from(values).sort(), n = a.length;
  if (!n) return null;
  const x = (n - 1) * q, i = Math.floor(x), f = x - i;
  return i + 1 < n ? a[i] + (a[i + 1] - a[i]) * f : a[n - 1];
}
export const median = values => quantile(values, 0.5);

/** Small seeded PRNG (mulberry32) so bootstrap intervals are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap: resample groups (one per clip) with replacement and recompute stat(groups). Clips are the
 * independent unit, so frame- and point-pooled metrics get honest intervals. Returns [lo, hi] or [null, null].
 */
export function bootstrapCI(groups, stat, { n = 200, seed = 1, alpha = 0.05 } = {}) {
  if (groups.length < 2 || !(n > 0)) return [null, null];
  const r = rng(seed), vals = [], pick = new Array(groups.length);
  for (let b = 0; b < n; b++) {
    for (let i = 0; i < groups.length; i++) pick[i] = groups[(r() * groups.length) | 0];
    const v = stat(pick);
    if (finite(v)) vals.push(v);
  }
  return vals.length ? [quantile(vals, alpha / 2), quantile(vals, 1 - alpha / 2)] : [null, null];
}

/** Expected calibration error over equal-width bins of [0, 1]; pairs are [confidence, correct 0|1]. */
export function ece(pairs, bins = DEFINITIONS.eceBins) {
  const acc = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, conf: 0, acc: 0 }));
  for (const [c, y] of pairs) { const b = acc[Math.min(bins - 1, Math.max(0, Math.floor(c * bins)))]; b.n++; b.conf += c; b.acc += y; }
  let e = 0;
  for (const b of acc) if (b.n) { b.conf /= b.n; b.acc /= b.n; e += b.n / pairs.length * Math.abs(b.acc - b.conf); }
  return { n: pairs.length, value: pairs.length ? e : null, bins: acc.filter(b => b.n) };
}

/* ------------------------------------------------------------------ result side */

/** Result camera at time t, linear between samples and clamped at the ends ({t, x, y, s?, r?} samples). */
export function cameraAt(camera, t) {
  const n = camera?.length ?? 0, at = c => ({ x: c.x, y: c.y, s: c.s ?? 1, r: c.r ?? 0 });
  if (!n) return { x: 0, y: 0, s: 1, r: 0 };
  if (!(t > camera[0].t)) return at(camera[0]);
  if (t >= camera[n - 1].t) return at(camera[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (camera[m].t <= t) lo = m; else hi = m; }
  const a = at(camera[lo]), b = at(camera[hi]), u = (t - camera[lo].t) / (camera[hi].t - camera[lo].t), mix = (p, q) => p + (q - p) * u;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), s: mix(a.s, b.s), r: mix(a.r, b.r) };
}

/** A normalized stabilized point at time t to raw display px (types.js cameraToRaw convention). */
export function toRawPx(camera, t, x, y, width, height) {
  const q = cameraToRaw(cameraAt(camera, t), x, y, width, height);
  return { x: q.x * width, y: q.y * height };
}

const lowerBound = (arr, t, key = p => p.t) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < t) lo = m + 1; else hi = m; }
  return lo;
};

/**
 * Engine-independent view of a result in raw display px. hf results are recognized by engine 'hf'; anything else
 * is treated as a v2/legacy reply (all points observed, launch from the selected launch hypothesis or points[0]).
 * hf observed points are the drawn curve samples at the observation times (what the user sees); `obs` keeps the
 * raw detections.
 */
export function scoredView(result, { width, height }) {
  const empty = { engine: result?.engine ?? null, status: 'no_reliable_track', traced: false, points: [], observed: [], predicted: [], launch: null, end: null, confidence: null, calibratedOn: null, reasonCodes: [] };
  if (!result || typeof result !== 'object') return empty;
  const hf = result.engine === 'hf', cam = result.camera || [], raw = p => toRawPx(cam, p.t, p.x, p.y, width, height);
  const points = (result.points || []).filter(p => p && finite(p.t) && finite(p.x) && finite(p.y))
    .map(p => ({ t: p.t, ...raw(p), status: hf ? p.status : (p.status ?? 'observed'), alpha: p.alpha ?? 1 }));
  let observed;
  if (hf && result.observations?.length) {
    observed = result.observations.map(o => {
      const i = lowerBound(points, o.t - 1e-6), p = points[i] && Math.abs(points[i].t - o.t) <= 1e-6 ? points[i] : null;
      const r = raw(o);
      return { t: o.t, x: p ? p.x : r.x, y: p ? p.y : r.y, obs: r };
    });
  } else observed = points.filter(p => p.status === 'observed');
  observed.sort((a, b) => a.t - b.t);
  const status = result.status ?? (points.length >= 2 ? 'tracked' : 'no_reliable_track');
  const traced = status !== 'no_reliable_track' && points.length >= 2;
  let launch = null;
  if (result.launch && finite(result.launch.t)) launch = { t: result.launch.t, ...raw(result.launch) };
  else if (!hf) {
    const h = (result.launchHypotheses || []).find(x => x.id === result.selectedLaunchId);
    if (h && finite(h.impactT) && finite(h.anchorX) && finite(h.anchorY)) launch = { t: h.impactT, ...raw({ t: h.impactT, x: h.anchorX, y: h.anchorY }) };
    else if (points.length) launch = { t: points[0].t, x: points[0].x, y: points[0].y };
  }
  const e = result.completion?.end;
  const end = e && finite(e.t) ? { type: e.type, t: e.t, ...raw(e) } : null;
  const c = result.confidence, confidence = c && typeof c === 'object' && finite(c.value) && c.value >= 0 && c.value <= 1 ? c.value : null;
  return {
    engine: result.engine ?? null, status, traced: traced, points: traced ? points : [], observed: traced ? observed : [],
    predicted: traced ? points.filter(p => p.status === 'predicted') : [], launch: traced ? launch : null, end: traced ? end : null,
    confidence, calibratedOn: confidence == null ? null : c.calibratedOn ?? null, reasonCodes: [...(result.reasonCodes || [])]
  };
}

/* ------------------------------------------------------------------ ground-truth side */

/** GT frames sorted by t with a frame lookup: the frame on screen at time t (last PTS <= t). */
export function gtIndex(gt) {
  const frames = [...(gt.frames || [])].sort((a, b) => a.t - b.t), times = Float64Array.from(frames, f => f.t);
  const dts = []; for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
  const dt = median(dts) ?? 1 / 30, eps = Math.min(1e-4, 0.25 * dt);
  const index = t => {
    if (!finite(t) || !times.length || t + eps < times[0] || t > times[times.length - 1] + dt) return -1;
    let lo = 0, hi = times.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t + eps) { k = m; lo = m + 1; } else hi = m - 1; }
    return k;
  };
  return { frames, times, dt, fps: 1 / dt, index, at: t => frames[index(t)] ?? null };
}

/** SNR of a GT ball: the decoded-video oracle when present, else the scaled clean-render SNR (generator convention). */
export const snrOf = (ball, D = DEFINITIONS) => !ball ? 0 : finite(ball.snrCoded) ? ball.snrCoded : (ball.expectedSnr ?? 0) * D.snrUncodedScale;
/** D3 §9.4 point match radius max(2 px, 0.75·d(t)). */
export const matchRadius = (d, A = PARAMS.acceptance) => Math.max(A.matchPx, A.matchD * (d || 0));
const ballOf = f => f?.ball && finite(f.ball.x) && finite(f.ball.y) ? f.ball : null;

/** The clip's set: 'controls' (invisible-ball controls split), 'perf' (perf set) or 'main' (D3 §9.2). */
export const clipSet = gt => (['controls', 'perf'].includes(String(gt.split ?? '').toLowerCase()) ? String(gt.split).toLowerCase() : 'main');

/**
 * Clip classes from GT: no-ball clips (practice swing, whiff: no ball leaves), invisible-ball controls (a real
 * impact whose ball is never drawn in flight: explicit markers in kind, control, tags, true-valued factors or
 * confounders; a hit labelled expected 'abstain'; any hit of the 'controls' split not expected to trace), and hits.
 */
export function clipClass(gt, D = DEFINITIONS) {
  const kind = gt.meta?.kind ?? (gt.impact ? 'hit' : 'unknown'), f = gt.meta?.factors ?? {}, on = o => Object.entries(o ?? {}).filter(([, v]) => v === true).map(([k]) => k);
  const words = [kind, gt.control, gt.meta?.control, f.control, f.kind, ...(gt.tags ?? []), ...on(f), ...on(gt.meta), ...Object.entries(f.confounders ?? {}).filter(([, v]) => v).map(([k]) => k)]
    .filter(Boolean).map(s => String(s).toLowerCase().replace(/[^a-z]/g, ''));
  const hidden = !D.noBallKinds.includes(kind) && (gt.expected === 'abstain' || (clipSet(gt) === 'controls' && gt.expected !== 'trace'));
  const invisible = !!gt.impact && (words.some(w => D.invisibleMarkers.some(m => w.includes(m))) || hidden);
  const noBall = !invisible && (D.noBallKinds.includes(kind) || (!gt.impact && gt.expected === 'abstain'));
  return { kind, invisible, noBall, hit: !!gt.impact };
}

/** Recall bins from PARAMS.acceptance.quality.recallBySnr ([min SNR, min recall]), highest first, plus the sub-threshold bin. */
export function recallBins(A = PARAMS.acceptance) {
  const rows = [...A.quality.recallBySnr].sort((a, b) => b[0] - a[0]);
  const bins = rows.map(([lo, target], i) => ({ lo, hi: i ? rows[i - 1][0] : null, target }));
  bins.push({ lo: null, hi: rows.at(-1)[0], target: null });
  return bins;
}
const binOf = (bins, s) => bins.findIndex(b => (b.lo == null || s >= b.lo) && (b.hi == null || s < b.hi));

/** Position on the GT arc2d at time t (linear in t; clamped to the first/last sample). */
export function arcAt(arc, t) {
  const n = arc.length;
  if (!n) return null;
  if (!(t > arc[0].t)) return arc[0];
  if (t >= arc[n - 1].t) return arc[n - 1];
  const i = lowerBound(arc, t), a = arc[i - 1], b = arc[i], u = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

const POLY = new WeakMap();
/** Minimum distance from (x, y) to the arc2d polyline (shape error). The arc is cached as a typed array. */
export function distToArc(arc, x, y) {
  let P = POLY.get(arc);
  if (!P) { P = Float64Array.from(arc.flatMap(p => [p.x, p.y])); POLY.set(arc, P); }
  const n = P.length >> 1;
  if (n === 1) return Math.hypot(x - P[0], y - P[1]);
  let best = Infinity;
  for (let i = 2; i < 2 * n; i += 2) {
    const ax = P[i - 2], ay = P[i - 1], dx = P[i] - ax, dy = P[i + 1] - ay, L = dx * dx + dy * dy, px = x - ax, py = y - ay;
    let u = L > 0 ? (px * dx + py * dy) / L : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const ex = px - u * dx, ey = py - u * dy, d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Distance from (x, y) to segment j (samples j, j+1) of a flat [x0, y0, x1, y1, ...] polyline. */
function segDist(P, j, x, y) {
  const ax = P[2 * j], ay = P[2 * j + 1];
  if (2 * j + 3 >= P.length) return Math.hypot(x - ax, y - ay);
  const dx = P[2 * j + 2] - ax, dy = P[2 * j + 3] - ay, L = dx * dx + dy * dy, px = x - ax, py = y - ay;
  const u = L > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L)) : 0;
  return Math.hypot(px - u * dx, py - u * dy);
}

/**
 * Order-aware shape error (px) of each point of `pts` (time order) against the arc2d polyline: the points must advance
 * along the arc (point i on a segment at or after point i − 1's). A down-the-line arc folds back, its descent lying
 * over the ascent in the image, so the nearest point anywhere on it (distToArc) lets a landing overshoot match the
 * early ascent and look right. The alignment keeps the largest distance as small as possible, then the sum.
 */
export function arcAlign(arc, pts) {
  const n = pts.length, m = Math.max(1, arc.length - 1);
  if (!n || !arc.length) return [];
  let P = POLY.get(arc);
  if (!P) { P = Float64Array.from(arc.flatMap(p => [p.x, p.y])); POLY.set(arc, P); }
  const d = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) d[i * m + j] = segDist(P, j, pts[i].x, pts[i].y);
  // Bottleneck: B(i, j) = max(d(i, j), min over k <= j of B(i − 1, k)).
  let prev = d.slice(0, m), cur = new Float64Array(m);
  for (let i = 1; i < n; i++) {
    let lo = Infinity;
    for (let j = 0; j < m; j++) { if (prev[j] < lo) lo = prev[j]; cur[j] = Math.max(d[i * m + j], lo); }
    [prev, cur] = [cur, prev];
  }
  let B = Infinity;
  for (let j = 0; j < m; j++) if (prev[j] < B) B = prev[j];
  // Smallest sum over the alignments within B; back[i·m + j] is the segment of point i − 1.
  const cap = B * (1 + 1e-9) + 1e-9, back = new Int32Array(n * m);
  for (let j = 0; j < m; j++) prev[j] = d[j] <= cap ? d[j] : Infinity;
  for (let i = 1; i < n; i++) {
    let lo = Infinity, at = -1;
    for (let j = 0; j < m; j++) {
      if (prev[j] < lo) { lo = prev[j]; at = j; }
      const e = d[i * m + j];
      cur[j] = e <= cap && at >= 0 ? lo + e : Infinity; back[i * m + j] = at;
    }
    [prev, cur] = [cur, prev];
  }
  let j = 0;
  for (let k = 1; k < m; k++) if (prev[k] < prev[j]) j = k;
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = d[i * m + j]; j = back[i * m + j]; }
  return out;
}

/** Why the true arc stops being visible: 'landing' (in frame) or 'exit' (last in-frame sample before leaving). */
export function gtEnd(gt) {
  const arc = gt.arc2d || [];
  if (gt.landing?.inFrame) return { type: 'landing', t: gt.landing.t, x: gt.landing.x, y: gt.landing.y };
  let k = arc.length;
  while (k > 0 && !arc[k - 1].inFrame) k--;
  if (k > 0 && k < arc.length) return { type: 'exit', t: arc[k - 1].t, x: arc[k - 1].x, y: arc[k - 1].y };
  return gt.landing ? { type: 'landing', t: gt.landing.t, x: gt.landing.x, y: gt.landing.y } : null;
}

/* ------------------------------------------------------------------ per clip */

/**
 * Score one result against one GT clip.
 * @param {object|null} result  HFResult, or a v2/legacy reply (status from normalizeTrackReport); null = run error
 * @param {object} gt  generator ground truth (flightline-synth-gt-v1)
 * @param {{width?:number, height?:number, fps?:number, acceptance?:object, definitions?:object, runtime?:object,
 *   error?:string|null, valid?:boolean|null, validationErrors?:string[], engine?:string, files?:{gt:string, video:string}}} [opts]
 *   files: the clip's file hashes (corpus pin), so comparisons can check they scored the same files
 * @returns {object} ClipMetrics (JSON-safe)
 */
export function scoreClip(result, gt, opts = {}) {
  const A = opts.acceptance ?? PARAMS.acceptance, D = opts.definitions ?? DEFINITIONS, W0 = D.wrong;
  const video = gt.meta?.video ?? {}, fac = gt.meta?.factors ?? {};
  const W = opts.width ?? video.width, H = opts.height ?? video.height, G = gtIndex(gt);
  const fps = opts.fps ?? video.fpsOut ?? G.fps, tau = video.playbackFactor ?? 1, diag = Math.hypot(W, H);
  const cls = clipClass(gt, D), imp = gt.impact ?? null, t0 = imp?.t0 ?? null, d0 = imp?.ballDiameterPx ?? null;
  const v = scoredView(result, { width: W, height: H });
  const bins = recallBins(A), minVisSnr = bins.at(-2).lo;

  // GT-visible flight frames (D3 §9.4: in frame, not occluded, SNR >= 2), dups excluded.
  const visible = imp ? G.frames.map((f, k) => ({ f, k })).filter(({ f }) => {
    const b = ballOf(f);
    return f.t > t0 + 1e-9 && f.dupOf == null && b && b.state === 'flight' && b.inFrame && !b.occluded;
  }) : [];
  const visibleRealSec = visible.filter(({ f }) => snrOf(f.ball, D) >= minVisSnr).length / (fps * tau);
  const flightSnr = median(visible.map(({ f }) => snrOf(f.ball, D)));
  const snrBin = flightSnr == null ? 'none' : (b => b.lo == null ? `<${b.hi}` : b.hi == null ? `>=${b.lo}` : `${b.lo}-${b.hi}`)(bins[binOf(bins, flightSnr)]);

  const out = {
    id: gt.id, engine: v.engine ?? opts.engine ?? null, split: gt.split ?? null, set: clipSet(gt), files: opts.files ?? null, expected: gt.expected ?? null, kind: cls.kind,
    control: cls.invisible ? 'invisible-ball' : null, noBall: cls.noBall, hit: cls.hit,
    strata: {
      set: clipSet(gt), viewClass: fac.viewClass ?? 'unknown', capture: fac.capture ?? 'unknown', format: fac.format ?? `${W}x${H}`, sky: fac.sky ?? 'unknown',
      expected: gt.expected ?? 'unknown', kind: cls.kind, control: cls.invisible ? 'invisible-ball' : cls.noBall ? 'no-ball' : cls.hit ? 'hit' : 'other',
      styleShift: gt.styleShift ? 'shifted' : 'in-style', codec: fac.codec ?? 'unknown', snrBin, failureModes: [...(gt.failureModes || [])]
    },
    dims: { width: W, height: H, fps, tau, diag, frames: video.frameCount ?? G.frames.length, durationSec: video.durationS ?? null },
    status: v.status, outcome: v.traced ? (v.status === 'tracked' ? 'tracked' : 'partial') : 'abstained', traced: v.traced,
    error: opts.error ?? null, valid: opts.valid ?? null, validationErrors: opts.validationErrors ?? [],
    reasonCodes: v.reasonCodes, confidence: v.confidence, calibratedOn: v.calibratedOn,
    visibleRealSec,
    coverageClass: {
      dtl: fac.viewClass === 'dtl' && visibleRealSec >= D.dtlMinVisibleRealSec,
      foFast: fac.viewClass === 'fo' && (video.captureFps ?? fps) >= D.foFastMinCaptureFps,
      foRealtime: fac.viewClass === 'fo' && (video.captureFps ?? fps) < D.foFastMinCaptureFps && !video.slowmo,
      oblique: fac.viewClass === 'oblique'
    },
    launchT: v.launch?.t ?? null, launchFrame: v.launch ? G.index(v.launch.t) : null,
    launch: null, identity: null, club: null, steal: null, recall: null, position: null, completion: null,
    obs: v.observed.map(o => [r6(o.t), r2(o.x), r2(o.y)]),
    wrong: false, wrongIdentity: false, identityOk: false, correct: false, wrongReasons: [],
    runtime: opts.runtime ? { ...opts.runtime } : null
  };
  if (out.runtime && !finite(out.runtime.msPerFrame) && finite(out.runtime.elapsedMs) && out.dims.frames) out.runtime.msPerFrame = out.runtime.elapsedMs / out.dims.frames;

  // Observed points against the GT ball of the frame on screen at their time.
  const scored = v.observed.map(o => {
    const k = G.index(o.t), f = G.frames[k] ?? null, b = ballOf(f), dist = b ? hyp(o, b) : Infinity;
    return { o, k, f, b, dist, matched: !!b && dist <= matchRadius(b.diam, A) };
  });

  if (v.traced && imp) {
    // Identity: matched fraction and the longest run of consecutive unmatched observed points (a switch).
    let run = 0, longest = 0;
    for (const s of scored) { run = s.matched ? 0 : run + 1; longest = Math.max(longest, run); }
    const matched = scored.filter(s => s.matched).length;
    out.identity = { n: scored.length, matched, fracMatched: scored.length ? matched / scored.length : null, longestUnmatchedRun: longest, switch: longest >= W0.switchRun };

    // Club head: >= clubMinHits of the first clubFirstObs post-impact observed points within clubSizes club-head
    // sizes of the GT club and more than clubFarD·d from the GT ball.
    const first = scored.filter(s => s.o.t > t0).slice(0, A.clubFirstObs);
    const hits = first.filter(s => {
      const c = s.f?.club;
      return c && c.inFrame && finite(c.x) && hyp(s.o, c) <= A.clubSizes * c.size && (!s.b || s.dist > A.clubFarD * s.b.diam);
    }).length;
    out.club = { considered: first.length, hits, falseTrack: hits >= A.clubMinHits };

    // Distractor steal: >= stealHits observed points on one GT distractor while away from the ball.
    const counts = new Map();
    for (const s of scored) {
      if (s.matched) continue;
      for (const d of s.f?.distractors || []) {
        if (!finite(d.x) || hyp(s.o, d) > Math.max(A.matchPx, A.matchD * (d.size || 0))) continue;
        if (s.b && s.dist <= A.clubFarD * s.b.diam) continue;
        const key = `${d.type}:${d.id}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const [target, hitsD] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    out.steal = { target, hits: hitsD, falseTrack: hitsD >= W0.stealHits };

    // Launch: timing in frames, point in d0.
    if (v.launch) {
      const dtFrames = Math.abs(v.launch.t - t0) * fps, pointD0 = d0 ? hyp(v.launch, imp.address) / d0 : null;
      out.launch = {
        t: v.launch.t, frame: out.launchFrame, dtFrames, pointD0, frameOk: dtFrames <= 1 + 1e-9, pointOk: pointD0 != null && pointD0 <= A.quality.launchPointD0,
        wrong: dtFrames > Math.max(W0.launchFrames, W0.launchRealSec * tau * fps) + 1e-9 || (pointD0 != null && pointD0 > W0.launchD0)
      };
    } else out.launch = { t: null, frame: null, dtFrames: null, pointD0: null, frameOk: false, pointOk: false, wrong: true };

    // Recall per SNR bin (status-aware: only observed points at that frame can match).
    const best = new Map();
    for (const s of scored) if (s.k >= 0) best.set(s.k, Math.min(best.get(s.k) ?? Infinity, s.dist));
    out.recall = bins.map(b => ({ lo: b.lo, hi: b.hi, visible: 0, matched: 0 }));
    for (const { f, k } of visible) {
      const r = out.recall[binOf(bins, snrOf(f.ball, D))];
      r.visible++;
      if ((best.get(k) ?? Infinity) <= matchRadius(f.ball.diam, A)) r.matched++;
    }

    // Position error over flight points with a known GT ball (px; in d for d >= smallBallPx, px below).
    const pos = { px: [], large: [], small: [] };
    for (const s of scored) {
      if (!s.b || s.b.state !== 'flight' || !(s.o.t > t0)) continue;
      pos.px.push(r6(s.dist));
      if (s.b.diam >= D.smallBallPx) pos.large.push(r6(s.dist / s.b.diam)); else pos.small.push(r6(s.dist));
    }
    out.position = pos;

    // Arc completion over predicted points only. Shape is order-aware (arcAlign), over the visible points (alpha >=
    // completionMinAlpha, a prefix: the fade never brightens) and, for shapeMaxAll, over all of them.
    const arc = gt.arc2d || [];
    if (v.predicted.length && arc.length) {
      const shown = v.predicted.filter(p => p.alpha >= D.completionMinAlpha), shapeVis = arcAlign(arc, shown), shapeAll = arcAlign(arc, v.predicted);
      const errs = v.predicted.map((p, i) => {
        const q = arcAt(arc, p.t);
        return { alpha: p.alpha, shapeAll: shapeAll[i] / diag, time: Math.hypot(p.x - q.x, p.y - q.y) / diag };
      });
      const vis = errs.filter(e => e.alpha >= D.completionMinAlpha).map((e, i) => ({ ...e, shape: shapeVis[i] / diag })), mx = (a, k) => a.length ? a.reduce((m, e) => Math.max(m, e[k]), -Infinity) : null;
      const mean = (a, k) => a.length ? a.reduce((s, e) => s + e[k], 0) / a.length : null;
      const end = v.end ?? v.points.at(-1), qa = arcAt(arc, end.t), ge = gtEnd(gt);
      const tLast = scored.length ? scored.at(-1).o.t : t0, tEnd = gt.landing?.t ?? arc.at(-1).t;
      const observedFrac = tEnd > t0 ? Math.max(0, Math.min(1, (tLast - t0) / (tEnd - t0))) : null;
      const landing = end.type === 'landing' && gt.landing && gt.landing.t > t0;
      out.completion = {
        n: errs.length, nVisible: vis.length, shapeMax: mx(vis, 'shape'), shapeMean: mean(vis, 'shape'), timeMax: mx(vis, 'time'), timeMean: mean(vis, 'time'),
        shapeMaxAll: mx(errs, 'shapeAll'), endType: end.type ?? null, gtEndType: ge?.type ?? null, endErr: Math.hypot(end.x - qa.x, end.y - qa.y) / diag,
        landingTimeFrac: landing ? Math.abs(end.t - gt.landing.t) / (gt.landing.t - t0) : null,
        landingPointErr: landing ? Math.hypot(end.x - gt.landing.x, end.y - gt.landing.y) / diag : null,
        observedFrac, long: observedFrac != null && observedFrac >= A.quality.longObservedFrac
      };
    }
  }

  // Verdict. Any trace on a clip without a ball flight is wrong; otherwise the identity and completion rules.
  if (v.traced) {
    const why = out.wrongReasons;
    if (!imp || cls.noBall || cls.invisible || gt.expected === 'abstain') why.push('expected_abstain');
    if (out.club?.falseTrack) why.push('club');
    if (out.steal?.falseTrack) why.push('steal');
    if (out.identity?.switch) why.push('switch');
    if (out.identity && !(out.identity.n && out.identity.fracMatched >= W0.minMatchedFrac)) why.push('unmatched');
    if (out.launch?.wrong) why.push('launch');
    out.wrongIdentity = why.length > 0;
    if (out.completion?.shapeMax != null && out.completion.shapeMax > W0.completionDiag) why.push('completion');
    out.identityOk = !out.wrongIdentity;
    out.correct = out.identityOk && !(W0.includeCompletion && why.includes('completion'));
    out.wrong = !out.correct;
  }
  return out;
}

/* ------------------------------------------------------------------ aggregation */

const dist = (values, qs = [0.5, 0.95]) => ({ n: values.length, ...Object.fromEntries(qs.map(q => [q === 0.5 ? 'median' : `p${Math.round(q * 100)}`, quantile(values, q)])) });
const pooledRate = (groups, boot) => {
  const k = groups.reduce((s, g) => s + g.k, 0), n = groups.reduce((s, g) => s + g.n, 0), w = wilson(k, n);
  if (!boot || !n) return { ...w, ci: 'wilson' };
  const [lo, hi] = bootstrapCI(groups.filter(g => g.n), gs => { let a = 0, b = 0; for (const g of gs) { a += g.k; b += g.n; } return b ? a / b : null; }, boot);
  return lo == null ? { ...w, ci: 'wilson' } : { ...w, lo, hi, ci: 'bootstrap' };
};
/** Quantiles of point values pooled over clips; one cluster-bootstrap pass (one sort per resample) serves every q. */
const pooledQuantiles = (groups, qs, boot) => {
  const all = groups.flat(), out = qs.map(q => ({ value: quantile(all, q), n: all.length, lo: null, hi: null }));
  const gs = groups.filter(g => g.length);
  if (!boot || !all.length || gs.length < 2) return out;
  const r = rng(boot.seed ?? 1), vals = qs.map(() => []), pick = new Array(gs.length);
  for (let b = 0; b < (boot.n ?? 200); b++) {
    let n = 0;
    for (let i = 0; i < gs.length; i++) { pick[i] = gs[(r() * gs.length) | 0]; n += pick[i].length; }
    const a = new Float64Array(n);
    let o = 0;
    for (const g of pick) { a.set(g, o); o += g.length; }
    a.sort();
    qs.forEach((q, j) => { const x = (n - 1) * q, i = Math.floor(x); vals[j].push(i + 1 < n ? a[i] + (a[i + 1] - a[i]) * (x - i) : a[n - 1]); });
  }
  out.forEach((o, j) => { o.lo = quantile(vals[j], 0.025); o.hi = quantile(vals[j], 0.975); });
  return out;
};

/**
 * One summary block (overall or one stratum). boot = {n, seed} enables cluster-bootstrap intervals. Perf-set clips
 * count for runtime, memory and errors only (a fixed 4K60 format set would skew the holdout's accuracy mix); their
 * accuracy shows in the 'set' stratum.
 */
export function summarize(all, { boot = null, acceptance = PARAMS.acceptance, definitions = DEFINITIONS } = {}) {
  const A = acceptance, D = definitions, bins = recallBins(A), perfOnly = all.length > 0 && all.every(c => c.set === 'perf');
  const clips = perfOnly ? all : all.filter(c => c.set !== 'perf');
  const traced = clips.filter(c => c.traced), hits = clips.filter(c => c.hit), ball = traced.filter(c => c.identity);
  const count = (list, f) => list.filter(f).length, rate = (list, f) => wilson(count(list, f), list.length);
  const noBall = clips.filter(c => c.noBall), inv = clips.filter(c => c.control === 'invisible-ball');
  const trace = clips.filter(c => c.expected === 'trace'), tracedHits = traced.filter(c => c.hit);
  const okPos = traced.filter(c => c.identityOk && c.position), comp = traced.filter(c => c.identityOk && c.completion?.shapeMax != null);
  const clipQ = (values, q) => { const value = quantile(values, q); if (!boot || value == null) return { value, n: values.length, lo: null, hi: null }; const [lo, hi] = bootstrapCI(values, vs => quantile(vs, q), boot); return { value, n: values.length, lo, hi }; };
  const compBlock = list => { const vals = list.map(c => c.completion.shapeMax); return { n: vals.length, median: clipQ(vals, 0.5), p90: clipQ(vals, 0.9) }; };
  const landing = comp.map(c => c.completion.landingTimeFrac).filter(finite);
  const pairs = traced.filter(c => finite(c.confidence)).map(c => [c.confidence, c.correct ? 1 : 0]);
  const cal = ece(pairs, D.eceBins);
  const runtime = all.filter(c => c.runtime && finite(c.runtime.msPerFrame));
  const fmt = c => `${Math.max(c.dims.width, c.dims.height)}p${Math.round(c.dims.fps)}`, byFormat = {};
  for (const c of runtime) (byFormat[fmt(c)] ||= []).push(c);
  // A runtime target is measured on perf-set clips of its format and length when there are any, else projected from ms/frame.
  const projected = spec => {
    const g = runtime.filter(c => Math.max(c.dims.width, c.dims.height) === spec.longEdge && Math.abs(c.dims.fps - spec.fps) <= 0.1 * spec.fps);
    const ms = median(g.map(c => c.runtime.msPerFrame)), sec = c => c.dims.durationSec || c.dims.frames / c.dims.fps;
    const perf = g.filter(c => c.set === 'perf' && finite(c.runtime.elapsedMs) && Math.abs(sec(c) - spec.clipSec) <= 0.1 * spec.clipSec);
    if (perf.length) return { value: median(perf.map(c => c.runtime.elapsedMs / 1000 * spec.clipSec / sec(c))), n: perf.length, msPerFrame: median(perf.map(c => c.runtime.msPerFrame)), projected: false };
    return { value: ms == null ? null : ms * spec.fps * spec.clipSec / 1000, n: g.length, msPerFrame: ms, projected: true };
  };
  const maxOf = key => { const vals = all.map(c => c.runtime?.[key]).filter(finite); return { value: vals.length ? vals.reduce((m, v) => Math.max(m, v)) : null, n: vals.length, p95: quantile(vals, 0.95) }; };
  const phases = {};
  for (const c of runtime) for (const [k, ms] of Object.entries(c.runtime.phases || {})) if (finite(ms)) (phases[k] ||= []).push(ms);
  return {
    n: all.length, scored: clips.length, perf: all.length - clips.length, traced: traced.length, abstained: clips.length - traced.length,
    errors: count(all, c => c.error), invalid: count(all, c => c.valid === false),
    safety: {
      wrongGivenTraced: rate(traced, c => c.wrong),
      wrongIdentityGivenTraced: rate(traced, c => c.wrongIdentity),
      clubFalseTrack: rate(hits, c => c.club?.falseTrack),
      noBallFalseTrace: rate(noBall, c => c.traced),
      invisibleAbstain: rate(inv, c => !c.traced),
      distractorSteal: rate(ball, c => c.steal?.falseTrack),
      wrongReasons: Object.fromEntries(['expected_abstain', 'club', 'steal', 'switch', 'unmatched', 'launch', 'completion'].map(r => [r, count(traced, c => c.wrongReasons.includes(r))]))
    },
    quality: {
      coverage: {
        all: rate(trace, c => c.identityOk),
        ...Object.fromEntries(['dtl', 'foFast', 'foRealtime', 'oblique'].map(k => [k, rate(trace.filter(c => c.coverageClass[k]), c => c.identityOk)]))
      },
      launchFrame: rate(tracedHits, c => c.launch?.frameOk), launchPoint: rate(tracedHits, c => c.launch?.pointOk),
      launchDtFrames: dist(tracedHits.map(c => c.launch?.dtFrames).filter(finite)), launchPointD0: dist(tracedHits.map(c => c.launch?.pointD0).filter(finite)),
      identityMatched: pooledRate(ball.map(c => ({ k: c.identity.matched, n: c.identity.n })), boot),
      identitySwitch: rate(ball, c => c.identity.switch),
      // snrLo/snrHi bound the bin; lo/hi are the rate's 95% interval (the gate's CI bound).
      recall: bins.map((b, i) => ({ snrLo: b.lo, snrHi: b.hi, target: b.target, ...pooledRate(ball.map(c => ({ k: c.recall[i].matched, n: c.recall[i].visible })), boot) })),
      position: Object.fromEntries(['large', 'small', 'px'].map(k => {
        const [med, p95] = pooledQuantiles(okPos.map(c => c.position[k]), [0.5, 0.95], boot);
        return [k, { unit: k === 'large' ? 'd' : 'px', median: med, p95 }];
      })),
      completion: {
        long: compBlock(comp.filter(c => c.completion.long)), short: compBlock(comp.filter(c => !c.completion.long)),
        landingTime: { n: landing.length, median: clipQ(landing, 0.5), p90: clipQ(landing, 0.9) },
        endErr: dist(comp.map(c => c.completion.endErr).filter(finite), [0.5, 0.9]),
        shapeMean: dist(comp.map(c => c.completion.shapeMean).filter(finite), [0.5, 0.9]),
        endTypeAgree: rate(comp.filter(c => ['landing', 'exit'].includes(c.completion.endType) && c.completion.gtEndType), c => c.completion.endType === c.completion.gtEndType)
      },
      calibration: { n: cal.n, ece: { value: cal.value, n: cal.n }, bins: cal.bins, calibratedOn: [...new Set(traced.map(c => c.calibratedOn).filter(Boolean))] },
      runtime: {
        k4k60: projected(D.runtimeFormats.k4k60), p1080p30: projected(D.runtimeFormats.p1080p30),
        byFormat: Object.fromEntries(Object.entries(byFormat).map(([k, g]) => [k, { n: g.length, msPerFrame: median(g.map(c => c.runtime.msPerFrame)), realtime: median(g.map(c => c.runtime.elapsedMs / 1000 / (c.dims.durationSec || c.dims.frames / c.dims.fps))) }])),
        phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, median(v)]))
      },
      memory: { workerHeapMb: maxOf('peakWorkerHeapMb'), tabRssMb: maxOf('tabRssIncreaseMb'), nodeRssMb: maxOf('peakRssMb'), nodeHeapMb: maxOf('peakHeapMb') }
    },
    confusion: Object.fromEntries(['trace', 'either', 'abstain'].map(e => {
      const g = clips.filter(c => c.expected === e);
      return [e, { n: g.length, ...Object.fromEntries(OUTCOMES.map(o => [o, count(g, c => c.outcome === o)])), wrong: count(g, c => c.wrong) }];
    }))
  };
}

/**
 * Report over clips: an overall summary (with cluster-bootstrap intervals) and one summary per stratum value.
 * strata: keys of ClipMetrics.strata (array values such as failureModes are multi-label).
 */
export function aggregate(clips, { strata = DEFAULT_STRATA, bootstrap = DEFINITIONS.bootstrap, acceptance = PARAMS.acceptance, definitions = DEFINITIONS } = {}) {
  const opts = { acceptance, definitions };
  const groups = key => {
    const m = new Map();
    for (const c of clips) for (const v of [c.strata?.[key]].flat()) if (v != null) (m.get(v) ?? m.set(v, []).get(v)).push(c);
    return Object.fromEntries([...m].sort(([a], [b]) => String(a).localeCompare(String(b), 'en', { numeric: true })).map(([v, g]) => [v, summarize(g, opts)]));
  };
  return {
    schema: 'flightline-bench-aggregate-v1', n: clips.length,
    overall: summarize(clips, { ...opts, boot: bootstrap }),
    strata: Object.fromEntries(strata.map(k => [k, groups(k)]))
  };
}

/* ------------------------------------------------------------------ corpus pins */

const genKey = g => (g?.mixed ? `mixed(${g.mixed.join(', ')})` : `${g?.version ?? '?'}/${g?.codeSha256 ?? '?'}`);
const sameFiles = (a, b) => !a?.files || !b?.files || (a.files.gt === b.files.gt && a.files.video === b.files.video);

/**
 * Can two run reports be compared? Both need a corpus pin (corpus.mjs pinCorpus) from a corpus that did not change
 * during the run; at least one split in common, and for every split both ran the same generator version and code
 * hash (one per split: a split mixing generators is refused) and the same manifest hash; and identical files for
 * every clip both scored. Splits of one run may come from different generator code (controls are generated later).
 */
export function pinCheck(a, b) {
  const pa = a?.corpusPin, pb = b?.corpusPin, reasons = [];
  if (!pa || !pb) return { ok: false, reasons: [`the ${pa ? 'second' : 'first'} report has no corpus pin`], splits: [] };
  for (const [name, p] of [['first', pa], ['second', pb]]) if (p.stable === false) reasons.push(`the corpus of the ${name} report changed during its run`);
  const splits = Object.keys(pa.splits ?? {}).filter(s => pb.splits?.[s]);
  if (!splits.length) reasons.push('no split in common');
  for (const s of splits) {
    const ga = pa.splits[s].generator ?? pa.generator, gb = pb.splits[s].generator ?? pb.generator, x = pa.splits[s].manifestSha256, y = pb.splits[s].manifestSha256;
    if (ga?.mixed || gb?.mixed) reasons.push(`split ${s} mixes generators ${genKey(ga?.mixed ? ga : gb)}`);
    else if (genKey(ga) !== genKey(gb)) reasons.push(`split ${s}: generator ${genKey(ga)} vs ${genKey(gb)}`);
    if (x !== y) reasons.push(`split ${s}: manifest ${String(x).slice(0, 12)} vs ${String(y).slice(0, 12)}`);
  }
  const other = new Map((b.clips ?? []).map(c => [c.id, c])), differ = (a.clips ?? []).filter(c => other.has(c.id) && !sameFiles(c, other.get(c.id))).map(c => c.id);
  if (differ.length) reasons.push(`${differ.length} clips scored different files (${differ.slice(0, 3).join(', ')}${differ.length > 3 ? ', ...' : ''})`);
  return { ok: reasons.length === 0, reasons, splits };
}

/** pinCheck or throw: reports from different corpus pins are never compared. */
export function assertSamePin(a, b, what = 'reports') {
  const r = pinCheck(a, b);
  if (!r.ok) throw Object.assign(new Error(`refusing to compare ${what}: different corpus pins (${r.reasons.join('; ')})`), { code: 'corpus-pin', reasons: r.reasons });
  return r;
}

/* ------------------------------------------------------------------ comparisons */

/**
 * Node/browser (or any two runs) parity on the same clips: decision, launch frame, observed-position delta. Clips of
 * one id that scored different files (ClipMetrics.files) are never paired: that throws.
 */
export function parity(clipsA, clipsB) {
  const byId = new Map(clipsB.map(c => [c.id, c])), pairs = clipsA.filter(c => byId.has(c.id)).map(c => [c, byId.get(c.id)]);
  const differ = pairs.filter(([a, b]) => !sameFiles(a, b)).map(([a]) => a.id);
  if (differ.length) throw Object.assign(new Error(`refusing to compare runs: ${differ.length} clips scored different files (${differ.slice(0, 3).join(', ')})`), { code: 'corpus-pin' });
  const withLaunch = pairs.filter(([a, b]) => a.launchFrame != null || b.launchFrame != null), deltas = [], perClip = [];
  for (const [a, b] of pairs) {
    const tol = 0.25 / (a.dims?.fps || 30), ob = b.obs || [], ds = [];
    for (const [t, x, y] of a.obs || []) {
      const i = lowerBound(ob, t - tol, p => p[0]);
      if (ob[i] && Math.abs(ob[i][0] - t) <= tol) ds.push(Math.hypot(ob[i][1] - x, ob[i][2] - y));
    }
    deltas.push(...ds);
    perClip.push({ id: a.id, a: a.status, b: b.status, launchFrameA: a.launchFrame, launchFrameB: b.launchFrame, pairs: ds.length, medianPx: median(ds) });
  }
  return {
    n: pairs.length, decision: wilson(pairs.filter(([a, b]) => a.status === b.status).length, pairs.length),
    launchFrame: wilson(withLaunch.filter(([a, b]) => a.launchFrame != null && a.launchFrame === b.launchFrame).length, withLaunch.length),
    positionPx: { value: median(deltas), p95: quantile(deltas, 0.95), n: deltas.length }, perClip
  };
}

/**
 * FINAL flip condition, quality half: does `hf` beat `base` (v2) on coverage AND position error on the same clips?
 * Run reports (with clips) must share a corpus pin (assertSamePin) and are restricted to their common clip ids first;
 * bare summaries are compared as given.
 */
export function compareEngines(hf, base) {
  let a = hf?.aggregate?.overall ?? hf?.overall ?? hf, b = base?.aggregate?.overall ?? base?.overall ?? base, common = null;
  if (hf?.clips && base?.clips) {
    assertSamePin(hf, base, 'hf and the baseline');
    const ids = new Set(base.clips.map(c => c.id)), mine = hf.clips.filter(c => ids.has(c.id)), keep = new Set(mine.map(c => c.id));
    common = keep.size;
    a = summarize(mine); b = summarize(base.clips.filter(c => keep.has(c.id)));
  }
  const cov = { hf: a?.quality.coverage.all.p ?? null, base: b?.quality.coverage.all.p ?? null };
  cov.better = cov.hf != null && cov.base != null && cov.hf > cov.base;
  const pick = s => s?.quality.position.large.median.value ?? null, pickPx = s => s?.quality.position.px.median.value ?? null;
  const pos = { unit: 'd', hf: pick(a), base: pick(b) };
  if (pos.hf == null || pos.base == null) Object.assign(pos, { unit: 'px', hf: pickPx(a), base: pickPx(b) });
  pos.better = pos.hf != null && pos.base != null ? pos.hf < pos.base : false;
  return { clips: common, coverage: cov, position: pos, beats: common !== 0 && cov.better === true && pos.better === true };
}
