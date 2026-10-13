/**
 * Tracking evaluation metrics against source-pixel annotations.
 * Predicted positions never count as detections.
 */

export const DEFAULT_TOLERANCES_PX = [5, 10, 20];

/**
 * @param {{t:number,x:number,y:number}[]} points normalized camera-stabilized
 * @param {{t:number,x:number,y:number}[]} camera
 * @param {number} analysisW
 * @param {number} analysisH
 * @param {number} sourceW upright source width
 * @param {number} sourceH upright source height
 */
export function observedToSourcePixels(points, camera, analysisW, analysisH, sourceW, sourceH) {
  const scaleX = sourceW / analysisW;
  const scaleY = sourceH / analysisH;
  return points.map(p => {
    const cam = cameraAt(camera, p.t);
    const ax = (p.x + cam.x) * analysisW;
    const ay = (p.y + cam.y) * analysisH;
    return {
      t: p.t,
      x: ax * scaleX,
      y: ay * scaleY,
      status: 'observed'
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
 * Annotation frame: { t, status: 'visible'|'not_visible'|'occluded'|'uncertain', x?, y? }
 * Optional clip fields: impactT, addressBall: {t,x,y}, distractors: [{label,t,x,y}], expectAbstention
 */
export function evaluateClip(run, annotation = null, {
  tolerancesPx = DEFAULT_TOLERANCES_PX,
  matchDt = 1 / 15,
  identitySwitchPx = 40
} = {}) {
  const { result, meta, elapsedMs, frameCount, competingTracks, bestScore } = run;
  const points = result?.points || [];
  const camera = result?.camera || [];
  const sourceW = meta.width, sourceH = meta.height;
  const analysisW = meta.analysisWidth, analysisH = meta.analysisHeight;
  const sourcePoints = observedToSourcePixels(points, camera, analysisW, analysisH, sourceW, sourceH);

  const summary = {
    id: annotation?.id || null,
    status: 'unknown_ground_truth',
    engine: run.engine,
    observedFrames: points.length,
    firstT: points[0]?.t ?? null,
    lastT: points.at(-1)?.t ?? null,
    firstNorm: points[0] ? { x: points[0].x, y: points[0].y } : null,
    lastNorm: points.at(-1) ? { x: points.at(-1).x, y: points.at(-1).y } : null,
    elapsedMs,
    frameCount,
    analysisSize: `${analysisW}x${analysisH}`,
    sourceSize: `${sourceW}x${sourceH}`,
    bestScore,
    competingTrackCount: competingTracks?.length ?? 0,
    impactTimingErrorSec: null,
    launchAnchorErrorPx: null,
    shotSuccess: null,
    falseTrace: null,
    visibleRecall: {},
    observedPrecision: null,
    identitySwitch: null,
    trackTerminationOk: null,
    abstention: null,
    notes: []
  };

  if (!annotation) {
    summary.notes.push('No annotation; metrics limited to track statistics.');
    return summary;
  }

  if (annotation.expectAbstention) {
    const abstained = points.length < 2;
    summary.status = abstained ? 'pass' : 'fail';
    summary.abstention = abstained ? 'true_abstention' : 'false_trace';
    summary.falseTrace = !abstained;
    summary.shotSuccess = abstained;
    return summary;
  }

  const labeled = Array.isArray(annotation.frames) ? annotation.frames : [];
  const visible = labeled.filter(f => f.status === 'visible' && Number.isFinite(f.x) && Number.isFinite(f.y));

  if (annotation.impactT != null && points.length) {
    summary.impactTimingErrorSec = Math.abs(points[0].t - annotation.impactT);
  } else if (annotation.impactT != null && !points.length) {
    summary.impactTimingErrorSec = null;
    summary.notes.push('No track; cannot score impact timing.');
  }

  if (annotation.addressBall && points.length) {
    const launch = sourcePoints[0];
    const ball = annotation.addressBall;
    // Prefer matched time if addressBall.t provided.
    const atLaunch = annotation.addressBall.t != null
      ? nearestObserved(sourcePoints, annotation.addressBall.t, 0.2) || launch
      : launch;
    summary.launchAnchorErrorPx = Math.hypot(atLaunch.x - ball.x, atLaunch.y - ball.y);
  }

  for (const tol of tolerancesPx) {
    let hits = 0;
    for (const frame of visible) {
      const obs = nearestObserved(sourcePoints, frame.t, matchDt);
      if (obs && Math.hypot(obs.x - frame.x, obs.y - frame.y) <= tol) hits++;
    }
    summary.visibleRecall[String(tol)] = visible.length ? hits / visible.length : null;
  }

  if (visible.length && sourcePoints.length) {
    let correct = 0, scored = 0;
    for (const obs of sourcePoints) {
      const label = nearestObserved(visible, obs.t, matchDt);
      if (!label) continue;
      scored++;
      if (Math.hypot(obs.x - label.x, obs.y - label.y) <= tolerancesPx[1]) correct++;
    }
    summary.observedPrecision = scored ? correct / scored : null;
  }

  // Identity switch heuristic vs labeled distractors near track points.
  if (annotation.distractors?.length && sourcePoints.length) {
    let switched = false;
    for (const d of annotation.distractors) {
      const obs = nearestObserved(sourcePoints, d.t, 0.25);
      if (!obs) continue;
      const dist = Math.hypot(obs.x - d.x, obs.y - d.y);
      if (dist <= identitySwitchPx) {
        // Also require being far from true ball at that time if labeled.
        const ball = nearestObserved(visible, d.t, 0.25);
        if (!ball || Math.hypot(obs.x - ball.x, obs.y - ball.y) > identitySwitchPx) {
          switched = true;
          summary.notes.push(`Possible identity switch toward ${d.label || 'distractor'} at t=${d.t}`);
        }
      }
    }
    summary.identitySwitch = switched;
  }

  // Shot-level gate when impact + address are labeled.
  if (annotation.impactT != null && annotation.addressBall && points.length >= 2) {
    const timingOk = summary.impactTimingErrorSec != null && summary.impactTimingErrorSec <= (annotation.maxImpactErrorSec ?? 0.35);
    const anchorOk = summary.launchAnchorErrorPx != null && summary.launchAnchorErrorPx <= (annotation.maxLaunchErrorPx ?? 60);
    const noSwitch = summary.identitySwitch !== true;
    summary.shotSuccess = timingOk && anchorOk && noSwitch;
    summary.status = summary.shotSuccess ? 'pass' : 'fail';
  } else if (visible.length) {
    const recall10 = summary.visibleRecall['10'];
    summary.shotSuccess = recall10 != null && recall10 >= 0.5 && summary.identitySwitch !== true;
    summary.status = summary.shotSuccess ? 'pass' : 'fail';
  } else {
    summary.status = 'unknown_ground_truth';
    summary.notes.push('Annotation lacks visible frames / impact / address; cannot decide pass/fail.');
  }

  if (annotation.lastVisibleT != null && points.length) {
    const overshoot = points.at(-1).t - annotation.lastVisibleT;
    summary.trackTerminationOk = overshoot <= (annotation.maxOvershootSec ?? 0.4);
    if (!summary.trackTerminationOk) {
      summary.notes.push(`Track continues ${overshoot.toFixed(3)}s past lastVisibleT`);
    }
  }

  return summary;
}

export function formatMarkdownReport(report) {
  const lines = [];
  lines.push(`# Tracking evaluation — ${report.engine}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Manifest: \`${report.manifest}\``);
  lines.push(`Git: \`${report.gitSha || 'unknown'}\``);
  lines.push('');
  lines.push('| Clip | Status | Observed | First t | Last t | Impact err (s) | Launch err (px) | Recall@10 | Notes |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const clip of report.clips) {
    const recall = clip.visibleRecall?.['10'];
    lines.push(`| ${clip.id || '?'} | ${clip.status} | ${fmt(clip.observedFrames)} | ${fmt(clip.firstT)} | ${fmt(clip.lastT)} | ${fmt(clip.impactTimingErrorSec)} | ${fmt(clip.launchAnchorErrorPx)} | ${fmt(recall)} | ${(clip.notes || []).join('; ').replace(/\|/g, '/')} |`);
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Clips: ${report.clips.length}`);
  lines.push(`- Pass: ${report.clips.filter(c => c.status === 'pass').length}`);
  lines.push(`- Fail: ${report.clips.filter(c => c.status === 'fail').length}`);
  lines.push(`- Unknown GT: ${report.clips.filter(c => c.status === 'unknown_ground_truth').length}`);
  lines.push(`- Not run: ${report.clips.filter(c => c.status === 'not_run').length}`);
  lines.push('');
  return lines.join('\n');
}

function fmt(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
