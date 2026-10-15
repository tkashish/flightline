/**
 * Tracking evaluation metrics against source-pixel annotations (upright source px; a label's t is
 * the labeled frame's pts in seconds). Observed points are scored for launch, identity along the
 * labeled flight, recall and run-on. Predicted points never count as detections: they are only
 * scored as arc-completion error.
 */
import { normalizeTrackReport } from '../../dist/track-status.js';

export const DEFAULT_TOLERANCES_PX = [5, 10, 20];

/** Gate thresholds. Annotation fields of the same name override them per clip. */
export const DEFAULTS = {
  maxImpactErrorSec: 0.35, // |first observed t - impactT|
  maxEarlyStartSec: 0.1, // first observed t may precede impactT by this much (the ball still sits at address)
  maxLaunchErrorPx: 60, // source px from addressBall to the track at addressBall.t
  trackTolerance: 0.02, // on-path / recall radius as a fraction of the source long edge
  minRecall: 0.5, // share of visible flight labels the observed track must cover
  maxGapSec: 0.1, // recall interpolates the observed track only across gaps up to this long
  maxOvershootSec: 0.1, // observed points allowed past the last visible label (checked along its continuation)
  pathCurvature: 0.25, // long edges / s²: how far the true path may bend away from the label path between sparse labels
  distractorDt: 0.25 // time window for matching a labeled distractor
};

const EPS = 1e-6;
const FAIL_REASON = {
  abstained: 'false_trace',
  tracked: 'missed_visible_ball',
  impactTiming: 'impact_timing',
  earlyStart: 'early_start',
  launchAnchor: 'launch_anchor',
  onPath: 'off_labeled_path',
  recall: 'low_recall',
  termination: 'run_on',
  noDistractorSwitch: 'distractor_switch'
};
// Only an abstention verdict or the labeled flight can pass a clip: launch checks alone say nothing
// about what the track followed after launch, so they can fail a clip but never pass it.
const DECIDING = ['abstained', 'recall'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hasXY = p => p != null && Number.isFinite(p.x) && Number.isFinite(p.y);
const num = v => (Number.isFinite(v) ? v : null);

/**
 * Normalized, camera-stabilized points -> upright source pixels. Keeps 'predicted' status;
 * everything else is 'observed'.
 * @param {{t:number,x:number,y:number,status?:string}[]} points
 * @param {{t:number,x:number,y:number}[]} camera
 */
export function observedToSourcePixels(points, camera, analysisW, analysisH, sourceW, sourceH) {
  const scaleX = sourceW / analysisW;
  const scaleY = sourceH / analysisH;
  return points.map(p => {
    const cam = cameraAt(camera, p.t);
    return {
      t: p.t,
      x: (p.x + cam.x) * analysisW * scaleX,
      y: (p.y + cam.y) * analysisH * scaleY,
      status: p.status === 'predicted' ? 'predicted' : 'observed'
    };
  });
}

export function cameraAt(camera, time) {
  if (!camera?.length) return { x: 0, y: 0 };
  let lo = 0, hi = camera.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (camera[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  const b = camera[lo], a = camera[Math.max(0, lo - 1)];
  const u = b.t === a.t ? 0 : Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

export function nearestObserved(points, t, maxDt = 1 / 15) {
  let best = null, bestDt = Infinity;
  for (const p of points) {
    const dt = Math.abs(p.t - t);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  return bestDt <= maxDt ? best : null;
}

/**
 * Position at t, linear between the bracketing samples (sorted by t); null outside their span, or
 * between two samples more than maxGap apart (a sample at t itself always counts).
 */
export function interpolateAt(points, t, maxGap = Infinity) {
  if (!points.length || !Number.isFinite(t) || t < points[0].t - EPS || t > points.at(-1).t + EPS) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  if (b.t - a.t > maxGap + EPS && t - a.t > EPS && b.t - t > EPS) return null;
  const u = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/* ------------------------------------------------------------------ label path */

const reflect = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });
const near = (a, b) => dist(a, b) < 1e-6;

/** Centripetal Catmull-Rom curve p1 -> p2 (neighbours p0, p3), sampled every ~4 px: no cusp or loop inside a piece. */
function catmullRom(p0, p1, p2, p3) {
  const len = dist(p1, p2);
  if (!(len > 1e-6)) return [p1];
  if (near(p0, p1)) p0 = reflect(p1, p2);
  if (near(p3, p2)) p3 = reflect(p2, p1);
  const t1 = Math.sqrt(dist(p0, p1)), t2 = t1 + Math.sqrt(len), t3 = t2 + Math.sqrt(dist(p2, p3));
  const lerp = (a, b, ta, tb, t) => { const u = (t - ta) / (tb - ta); return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; };
  const n = Math.min(64, Math.max(4, Math.ceil(len / 4))), out = [];
  for (let i = 0; i <= n; i++) {
    const t = t1 + (t2 - t1) * i / n, a2 = lerp(p1, p2, t1, t2, t);
    out.push(lerp(lerp(lerp(p0, p1, 0, t1, t), a2, 0, t2, t), lerp(a2, lerp(p2, p3, t2, t3, t), t1, t3, t), t1, t2, t));
  }
  return out;
}

/** Distance from p to a polyline (a single point is a polyline too). */
function polylineDistance(p, line) {
  let best = dist(p, line[0]);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], dx = line[i].x - a.x, dy = line[i].y - a.y, L = dx * dx + dy * dy;
    const u = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy));
  }
  return best;
}

/**
 * The labeled flight as a path through its labels (sorted by t). The ball's speed between labels is unknown (drag and
 * perspective slow it several-fold in the first frames), so only where it went is interpolated: a smooth centripetal
 * Catmull-Rom curve through the labels, not smoothed across impactT, where the ball leaves the address. See pathError.
 */
export function labelPath(labels, { impactT = null } = {}) {
  const nodes = labels.filter(p => hasXY(p) && Number.isFinite(p.t)).map(p => ({ t: p.t, x: p.x, y: p.y })).sort((a, b) => a.t - b.t);
  const side = p => (Number.isFinite(impactT) && p.t < impactT - EPS ? 0 : 1), cache = new Map();
  // Curve from node i to node i + 1; neighbours across impactT (or past the ends) are reflections.
  const piece = i => {
    if (!cache.has(i)) {
      const a = nodes[i], b = nodes[i + 1], one = side(a) === side(b);
      const p0 = one && i > 0 && side(nodes[i - 1]) === side(a) ? nodes[i - 1] : reflect(a, b);
      const p3 = one && i + 2 < nodes.length && side(nodes[i + 2]) === side(b) ? nodes[i + 2] : reflect(b, a);
      cache.set(i, catmullRom(p0, a, b, p3));
    }
    return cache.get(i);
  };
  return { nodes, piece };
}

/**
 * Distance from an observed point to where the label path puts the ball at its time: at a label time, that label;
 * strictly between labels a and b, anywhere on the curve between them (it only moves forward along its path), widened
 * by curvature·(t − ta)(tb − t)/2 for the bend that sparse labels cannot show (curvature: px/s², the interpolation
 * error bound of a path whose acceleration is at most that); for up to `ext` s past the last label, along the end
 * tangent at up to twice the last segment's mean speed, widened by curvature·(t − tb)²/2. null outside
 * [first label, last label + ext].
 */
export function pathError(path, p, { ext = 0, curvature = 0 } = {}) {
  const n = path.nodes, k = n.length;
  if (!k || !Number.isFinite(p.t) || p.t < n[0].t - EPS || p.t > n[k - 1].t + ext + EPS) return null;
  let i = 0;
  while (i < k && n[i].t < p.t - EPS) i++;
  if (i < k && n[i].t <= p.t + EPS) {
    let d = Infinity;
    for (let j = i; j < k && n[j].t <= p.t + EPS; j++) d = Math.min(d, dist(p, n[j]));
    return d;
  }
  const bend = s2 => Math.max(0, curvature * s2 / 2);
  if (i < k) return Math.max(0, polylineDistance(p, path.piece(i - 1)) - bend((p.t - n[i - 1].t) * (n[i].t - p.t)));
  const b = n[k - 1], last = k > 1 ? path.piece(k - 2) : [b], q = last.at(-2), dt = k > 1 ? b.t - n[k - 2].t : 0;
  let line = [b];
  if (q && dt > 0 && dist(q, b) > 0) {
    let len = 0;
    for (let j = 1; j < last.length; j++) len += dist(last[j - 1], last[j]);
    const s = 2 * len / dt * (p.t - b.t) / dist(q, b);
    line = [b, { x: b.x + (b.x - q.x) * s, y: b.y + (b.y - q.y) * s }];
  }
  return Math.max(0, polylineDistance(p, line) - bend((p.t - b.t) ** 2));
}

/** The engine's own verdict as the app receives it, plus what the UI shows for it. */
export function trackerFields(result = {}) {
  const d = result.diagnostics || {}, points = result.points || [];
  let ui = null;
  try {
    const r = normalizeTrackReport(result);
    ui = { status: r.status, reasonCodes: r.reasonCodes, displayScore: num(r.confidence?.displayScore), exportable: r.exportable };
  } catch { /* report shape changed; the raw fields below still apply */ }
  return {
    resultEngine: result.engine || null,
    trackStatus: result.status || (points.length >= 2 ? 'tracked' : 'no_reliable_track'),
    reasonCodes: [...(result.reasonCodes || [])],
    confidence: num(result.confidence ?? d.margin),
    vsRunner: num(result.vsRunner ?? d.vsRunner),
    // v2 tags a track it took from the legacy linker (dist/tracker.js resultGlobal).
    fallback: Boolean(d.fallback),
    fallbackKind: d.fallback || null,
    assocStatus: d.assocStatus ?? null,
    assocFrames: d.assocFrames ?? null,
    ui
  };
}

/**
 * Annotation: { impactT?, addressBall?: {t?,x,y}, lastVisibleT?, distractors?: [{label,t,x,y}],
 *   expectAbstention?, ballVisible?, frames?: [{ t, status: 'visible'|'not_visible'|'occluded'|'uncertain', x?, y? }],
 *   and per-clip overrides of DEFAULTS plus maxTrackErrorPx (absolute on-path radius) }.
 * Options: { tolerancesPx, trackTolerancePx, identitySwitchPx, ...DEFAULTS overrides }.
 */
export function evaluateClip(run, annotation = null, opts = {}) {
  const { result = {}, meta, elapsedMs, frameCount, competingTracks, bestScore } = run;
  const opt = k => annotation?.[k] ?? opts[k] ?? DEFAULTS[k];
  const tolerancesPx = opts.tolerancesPx || DEFAULT_TOLERANCES_PX;
  const sourceW = meta.width, sourceH = meta.height;
  const analysisW = meta.analysisWidth, analysisH = meta.analysisHeight;
  const raw = (result.points || []).filter(p => p.status !== 'predicted');
  const all = observedToSourcePixels(result.points || [], result.camera || [], analysisW, analysisH, sourceW, sourceH);
  const obs = all.filter(p => p.status === 'observed'), pred = all.filter(p => p.status === 'predicted');
  const engine = trackerFields(result);
  // Same rule as canExportTrack: the app shows nothing for these.
  const abstained = engine.trackStatus === 'no_reliable_track' || obs.length < 2;
  const tolPx = annotation?.maxTrackErrorPx ?? opts.trackTolerancePx ?? opt('trackTolerance') * Math.max(sourceW, sourceH);

  const summary = {
    id: annotation?.id || null,
    status: 'unknown_ground_truth',
    engine: run.engine,
    ...engine,
    abstained,
    observedFrames: obs.length,
    predictedFrames: pred.length,
    firstT: obs[0]?.t ?? null,
    lastT: obs.at(-1)?.t ?? null,
    firstNorm: raw[0] ? { x: raw[0].x, y: raw[0].y } : null,
    lastNorm: raw.at(-1) ? { x: raw.at(-1).x, y: raw.at(-1).y } : null,
    elapsedMs,
    frameCount,
    analysisSize: `${analysisW}x${analysisH}`,
    sourceSize: `${sourceW}x${sourceH}`,
    bestScore,
    competingTrackCount: competingTracks?.length ?? 0,
    trackTolerancePx: tolPx,
    impactTimingErrorSec: null,
    impactOffsetSec: null,
    launchAnchorErrorPx: null,
    visibleRecall: {},
    flightRecall: null,
    pathCheckedPoints: null,
    offPathPoints: null,
    maxPathErrorPx: null,
    observedPrecision: null,
    unlabeledPoints: null,
    overshootSec: null,
    trackTerminationOk: null,
    identitySwitch: null,
    arcCompletion: null,
    abstention: null,
    falseTrace: null,
    shotSuccess: null,
    gates: {},
    failReasons: [],
    notes: []
  };

  if (!annotation) {
    summary.notes.push('No annotation; metrics limited to track statistics.');
    return summary;
  }
  const g = summary.gates;
  if (annotation.expectAbstention || annotation.ballVisible === false) {
    summary.abstention = abstained ? 'true_abstention' : 'false_trace';
    summary.falseTrace = !abstained;
    g.abstained = abstained;
    return decide(summary);
  }

  const frames = Array.isArray(annotation.frames) ? annotation.frames : [];
  const visible = frames.filter(f => f.status === 'visible' && hasXY(f) && Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
  // Recall is over the flight: labels of the ball sitting at address before impact don't count.
  const flight = annotation.impactT != null ? visible.filter(f => f.t >= annotation.impactT - EPS) : visible;
  const ball = annotation.addressBall;
  const ballVisible = annotation.ballVisible === true || frames.some(f => f.status === 'visible') || hasXY(ball);
  // The ball sits at address until impact: the label path starts the flight there, so the track
  // between impact and a late first flight label is checked too. Recall still uses real labels only.
  const anchored = hasXY(ball) && Number.isFinite(annotation.impactT) && !visible.some(f => Math.abs(f.t - annotation.impactT) < EPS);
  const path = labelPath(anchored ? [...visible, { t: annotation.impactT, x: ball.x, y: ball.y }] : visible, { impactT: annotation.impactT });
  const first = path.nodes[0], last = path.nodes.at(-1), curvature = opt('pathCurvature') * Math.max(sourceW, sourceH);

  if (annotation.impactT != null && obs.length) {
    // Signed: v2 seeds beams up to 0.2 s before launch, so an early start has its own, tighter gate.
    summary.impactOffsetSec = obs[0].t - annotation.impactT;
    summary.impactTimingErrorSec = Math.abs(summary.impactOffsetSec);
  }
  if (hasXY(ball) && obs.length) {
    summary.launchAnchorErrorPx = dist(interpolateAt(obs, ball.t) || obs[0], ball);
  }

  // Recall: the observed track interpolated at each label time, never extrapolated past its ends
  // nor across a gap it did not observe (a launch point and one far later sample cover nothing between).
  const labelErr = flight.map(f => { const p = interpolateAt(obs, f.t, opt('maxGapSec')); return p ? dist(p, f) : Infinity; });
  const recallAt = tol => (flight.length ? labelErr.filter(d => d <= tol).length / flight.length : null);
  for (const tol of tolerancesPx) summary.visibleRecall[String(tol)] = recallAt(tol);
  summary.flightRecall = recallAt(tolPx);

  // Identity: every observed point from the first label on stays on the label path (pathError), and
  // for maxOvershootSec past the last label on its continuation (a jump there is a switch too).
  const margin = opt('maxOvershootSec');
  if (visible.length) {
    const errs = obs.filter(p => p.t >= first.t - EPS && p.t <= last.t + margin + EPS).map(p => pathError(path, p, { ext: margin, curvature }));
    summary.pathCheckedPoints = errs.length;
    summary.offPathPoints = errs.filter(d => d > tolPx).length;
    summary.maxPathErrorPx = errs.length ? Math.max(...errs) : null;
    summary.observedPrecision = errs.length ? 1 - summary.offPathPoints / errs.length : null;
  }

  // Run-on: no observed point past the last visible label (or a later lastVisibleT) beyond the margin.
  const end = Math.max(visible.at(-1)?.t ?? -Infinity, annotation.lastVisibleT ?? -Infinity);
  if (Number.isFinite(end) && obs.length) {
    summary.overshootSec = Math.max(...obs.map(p => p.t)) - end;
    summary.trackTerminationOk = summary.overshootSec <= margin + EPS;
    if (!summary.trackTerminationOk) summary.notes.push(`Observed track continues ${summary.overshootSec.toFixed(3)}s past the last visible label`);
    // Up to a later lastVisibleT the ball was visible, but no label shows what the track followed there.
    if (visible.length) summary.unlabeledPoints = obs.filter(p => p.t > last.t + margin + EPS && p.t <= end + margin + EPS).length;
  }

  // Arc completion: predicted points against the label path wherever labels cover them.
  if (pred.length) {
    const errs = pred.map(p => pathError(path, p, { curvature })).filter(d => d != null);
    summary.arcCompletion = {
      predicted: pred.length,
      scored: errs.length,
      meanErrorPx: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
      maxErrorPx: errs.length ? Math.max(...errs) : null
    };
  }

  // Labeled distractors near the track while it is away from the ball.
  const switchPx = opts.identitySwitchPx ?? tolPx;
  if (annotation.distractors?.length && obs.length) {
    summary.identitySwitch = false;
    for (const d of annotation.distractors) {
      const p = nearestObserved(obs, d.t, opt('distractorDt'));
      if (!p || dist(p, d) > switchPx) continue;
      const label = nearestObserved(visible, p.t, opt('distractorDt')), offBall = pathError(path, p, { curvature }) ?? (label && dist(p, label));
      if (offBall != null && offBall <= switchPx) continue;
      summary.identitySwitch = true;
      summary.notes.push(`Possible identity switch toward ${d.label || 'distractor'} at t=${d.t}`);
    }
  }

  if (ballVisible) g.tracked = !abstained;
  if (!abstained) {
    if (summary.impactTimingErrorSec != null) g.impactTiming = summary.impactTimingErrorSec <= opt('maxImpactErrorSec') + EPS;
    if (summary.impactOffsetSec != null) g.earlyStart = summary.impactOffsetSec >= -opt('maxEarlyStartSec') - EPS;
    if (summary.launchAnchorErrorPx != null) g.launchAnchor = summary.launchAnchorErrorPx <= opt('maxLaunchErrorPx') + EPS;
    if (visible.length) g.onPath = summary.offPathPoints === 0;
    if (flight.length) g.recall = summary.flightRecall >= opt('minRecall') - EPS;
    if (summary.trackTerminationOk != null) g.termination = summary.trackTerminationOk;
    if (summary.identitySwitch != null) g.noDistractorSwitch = !summary.identitySwitch;
  }
  return decide(summary);
}

/**
 * Fail on any failed gate; pass only when the abstention or flight-recall gate decided it and the
 * labels cover every observed point up to the track's end.
 */
function decide(summary) {
  const g = summary.gates;
  summary.failReasons = Object.keys(g).filter(k => g[k] === false).map(k => FAIL_REASON[k]);
  const decided = DECIDING.some(k => g[k] != null) && !summary.unlabeledPoints;
  summary.status = summary.failReasons.length ? 'fail' : decided ? 'pass' : 'unknown_ground_truth';
  summary.shotSuccess = summary.status === 'unknown_ground_truth' ? null : summary.status === 'pass';
  if (summary.status === 'unknown_ground_truth') {
    summary.notes.push(summary.abstained
      ? 'Abstained; the annotation does not say whether the ball is visible.'
      : summary.unlabeledPoints
        ? `${summary.unlabeledPoints} observed points come after the last visible label, while lastVisibleT says the ball was still visible; label the flight through lastVisibleT to decide.`
        : Object.keys(g).some(k => g[k])
          ? 'Launch checks passed, but no visible flight label after impact shows what the track followed; cannot pass.'
          : 'Annotation has no visible frames, impact or address label; cannot decide pass/fail.');
  }
  return summary;
}

const SPLITS = ['all', 'tune', 'holdout'];

/** Counts per split (all, tune, holdout, then any other split names). */
export function summarizeTotals(clips) {
  const out = {};
  const row = key => (out[key] ||= { clips: 0, pass: 0, fail: 0, unknown_ground_truth: 0, not_run: 0, error: 0, abstained: 0, fallback: 0 });
  SPLITS.forEach(row);
  for (const c of clips) {
    for (const key of ['all', c.split || 'unspecified']) {
      const t = row(key);
      t.clips++;
      t[c.status] = (t[c.status] || 0) + 1;
      if (c.abstained) t.abstained++;
      if (c.fallback) t.fallback++;
    }
  }
  return out;
}

export function formatMarkdownReport(report) {
  const p = report.provenance, git = p?.git;
  const lines = [`# Tracking evaluation — ${report.engine}`, ''];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Manifest: \`${report.manifest}\``);
  lines.push(`Git: \`${git?.short || report.gitSha || 'unknown'}\`${git?.dirty ? ' (uncommitted changes, see Provenance)' : git?.dirty === false ? ' (clean)' : ''}`);
  lines.push('');
  lines.push('| Clip | Split | Result | Engine | Track | Reasons | Conf | vsRunner | Fallback | Obs | Pred | First t | Last t | Impact err (s) | Launch err (px) | Path err (px) | Recall | Overshoot (s) | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const c of report.clips) {
    const notes = [...new Set([c.reason, c.skipReason, ...(c.failReasons || []), ...(c.notes || [])].filter(Boolean))];
    const fallback = c.fallback == null ? null : c.fallback ? `yes (${c.fallbackKind})` : 'no';
    lines.push(`| ${[c.id || '?', c.split, c.status, c.resultEngine, c.trackStatus, c.reasonCodes?.join(', '),
      fmt(c.confidence), fmt(c.vsRunner), fallback, fmt(c.observedFrames), fmt(c.predictedFrames), fmt(c.firstT), fmt(c.lastT),
      fmt(c.impactTimingErrorSec), fmt(c.launchAnchorErrorPx), fmt(c.maxPathErrorPx), fmt(c.flightRecall), fmt(c.overshootSec),
      notes.join('; ')].map(cell).join(' | ')} |`);
  }
  const totals = report.totals || summarizeTotals(report.clips);
  lines.push('', '## Totals', '');
  lines.push('| Split | Clips | Pass | Fail | Unknown GT | Not run | Error | Abstained | Fallback |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [split, t] of Object.entries(totals)) {
    lines.push(`| ${cell(split)} | ${t.clips} | ${t.pass} | ${t.fail} | ${t.unknown_ground_truth} | ${t.not_run} | ${t.error} | ${t.abstained} | ${t.fallback} |`);
  }
  if (p) {
    lines.push('', '## Provenance', '');
    lines.push(`- Git: \`${git?.sha || 'unknown'}\`; dirty: ${git?.dirty == null ? 'unknown' : git.dirty ? `yes, ${git.changedFiles} paths, diff sha256 \`${git.diffSha256}\`` : 'no'}`);
    lines.push(`- Engine: \`${p.engine}\`; options: \`${cell(JSON.stringify(p.options))}\``);
    lines.push(`- Node ${p.node}; ffmpeg ${p.ffmpeg || 'unknown'}; ffprobe ${p.ffprobe || 'unknown'}; ${p.platform}`);
    lines.push(`- Manifest sha256: \`${p.manifestSha256}\``);
  }
  lines.push('');
  return lines.join('\n');
}

function cell(v) {
  return String(v ?? '—').replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '/');
}

function fmt(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
