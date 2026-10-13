/**
 * Phase 5 — track status presentation + relative confidence (not calibrated %).
 */

export const REASON_COPY = {
  no_launch: 'No clear ball launch was found.',
  ambiguous_launch: 'More than one possible launch competed.',
  no_ball_evidence: 'Visual evidence for a ball flight was too weak.',
  identity_conflict: 'The track risked switching to another object.',
  camera_motion_uncompensated: 'Camera motion made association unreliable.',
  insufficient_visible_frames: 'Too few reliable ball observations.',
  decoder_limited: 'Video decoding limited what could be analyzed.',
  tracking_ended_early: 'The ball was only followed while clearly visible.',
  no_frames: 'No frames were available to analyze.'
};

/**
 * Build a relative confidence summary from association margins.
 * Values are comparative evidence scores — not statistical probabilities.
 */
export function buildConfidence({
  status,
  margin = 0,
  vsRunner = null,
  observedFrames = 0,
  firstT = null,
  lastT = null,
  reasonCodes = []
} = {}) {
  const spanSec = (firstT != null && lastT != null) ? Math.max(0, lastT - firstT) : 0;
  const components = {
    marginOverNull: Number.isFinite(margin) ? margin : 0,
    marginOverRunnerUp: vsRunner == null ? null : vsRunner,
    observedFrames,
    spanSec,
    reasonCodes: [...reasonCodes]
  };
  // Relative 0–1 display score for UI bars only — do not call this a probability.
  let display = 0;
  if (status === 'tracked') {
    display = Math.max(0.35, Math.min(0.95, 0.4 + Math.tanh(components.marginOverNull / 8) * 0.35
      + Math.min(0.15, observedFrames / 80)
      + (components.marginOverRunnerUp == null ? 0.05 : Math.tanh(components.marginOverRunnerUp / 4) * 0.1)));
  } else if (status === 'partial') {
    display = Math.max(0.2, Math.min(0.7, 0.25 + Math.tanh(components.marginOverNull / 10) * 0.25
      + Math.min(0.12, observedFrames / 100)));
  } else {
    display = Math.max(0, Math.min(0.25, Math.tanh(Math.max(0, components.marginOverNull) / 12) * 0.2));
  }
  return {
    ...components,
    displayScore: display,
    calibrated: false,
    note: 'Relative evidence score only — not a calibrated probability.'
  };
}

export function humanizeReasons(reasonCodes = []) {
  return reasonCodes.map(code => REASON_COPY[code] || code);
}

export function statusHeadline(status, { observedFrames = 0, partial = false } = {}) {
  if (status === 'no_reliable_track') {
    return 'Could not reliably identify the ball in this video.';
  }
  if (status === 'partial' || partial) {
    return `Partial flight traced · ${observedFrames} observed frames. Tracking stopped when the ball was no longer clear.`;
  }
  if (status === 'tracked') {
    return `Flight traced · ${observedFrames} observed frames.`;
  }
  return observedFrames >= 2
    ? `Possible flight · ${observedFrames} frames.`
    : 'Could not reliably identify the ball in this video.';
}

export function canExportTrack(status, pointsLength) {
  if (status === 'no_reliable_track') return false;
  return pointsLength >= 2;
}

/**
 * Normalize any engine result into a Phase 5 track report.
 */
export function normalizeTrackReport(result = {}) {
  const points = result.points || [];
  let status = result.status;
  if (!status) {
    status = points.length >= 2 ? 'tracked' : 'no_reliable_track';
  }
  if (status === 'tracked' && points.length < 9) status = 'partial';
  const reasonCodes = [...(result.reasonCodes || [])];
  if (status === 'partial' && !reasonCodes.includes('tracking_ended_early')) {
    reasonCodes.push('tracking_ended_early');
  }
  if (status === 'no_reliable_track' && !reasonCodes.length) {
    reasonCodes.push(points.length ? 'no_ball_evidence' : 'insufficient_visible_frames');
  }
  const firstT = points[0]?.t ?? null;
  const lastT = points.at(-1)?.t ?? null;
  const confidence = buildConfidence({
    status,
    margin: result.confidence ?? result.diagnostics?.margin ?? 0,
    vsRunner: result.diagnostics?.vsRunner ?? result.vsRunner ?? null,
    observedFrames: points.length,
    firstT,
    lastT,
    reasonCodes
  });
  return {
    status,
    points,
    camera: result.camera || [],
    engine: result.engine || 'unknown',
    reasonCodes,
    reasonText: humanizeReasons(reasonCodes),
    confidence,
    selectedLaunchId: result.selectedLaunchId || null,
    exportable: canExportTrack(status, points.length),
    headline: statusHeadline(status, { observedFrames: points.length })
  };
}
