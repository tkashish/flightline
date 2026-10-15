/**
 * Track status presentation: v2's relative evidence (not a calibrated %), and hf results (dist/hf/types.js
 * HFResult) with their own reason copy and confidence, calibrated on synthetic clips once fitted.
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
  no_frames: 'No frames were available to analyze.',
  analysis_cancelled: 'The scan stopped before the end of the clip. Choose the clip again to retry.',
  analysis_timed_out: 'Decoding or detection took too long. Try a shorter H.264 MP4.',
  analysis_failed: 'The video could not be analyzed. Try an H.264 MP4.',
  analysis_internal: 'The analysis hit an internal error. Reload the page and try again.'
};

// Analyses that never finished get their own headline instead of the abstention copy.
const STOPPED_HEADLINE = {
  analysis_cancelled: 'Analysis cancelled.',
  analysis_timed_out: 'Analysis timed out.',
  analysis_failed: 'Analysis failed.',
  analysis_internal: 'Analysis failed.'
};
// hf abstentions for a fault of the engine itself, not of the video: the same headline, and no confidence bar.
const HF_FAULTS = ['engine_not_ready', 'internal_error'];

/**
 * Copy for every hf reason code (the closed set REASON_CODES in dist/hf/types.js, same kinds): 'abstain' explains
 * an abstention, 'partial' a partial trace, 'info' may come with any status and is shown after the others.
 */
export const HF_REASONS = {
  no_frames: { kind: 'abstain', text: 'No frames could be read from this video. Try an H.264 MP4.' },
  decoder_limited: { kind: 'abstain', text: 'Some frames could not be read exactly, so no trace is drawn. Try an H.264 MP4.' },
  no_launch: { kind: 'abstain', text: 'No ball left the address in this clip.' },
  ball_not_found_after_impact: { kind: 'abstain', text: 'The ball was not found leaving the address after impact.' },
  launch_not_confirmed: { kind: 'abstain', text: 'A possible launch did not stand out from the background.' },
  club_only_motion: { kind: 'abstain', text: 'Only club or body motion left the address.' },
  ball_left_frame_too_fast: { kind: 'abstain', text: 'The ball left the frame too fast to confirm.' },
  identity_conflict: { kind: 'abstain', text: 'The track risked switching to another object.' },
  flight_inconsistent: { kind: 'abstain', text: 'The tracked object did not move like a golf ball.' },
  camera_motion_uncompensated: { kind: 'abstain', text: 'Camera motion made tracking unreliable.' },
  insufficient_visible_frames: { kind: 'abstain', text: 'Too few reliable ball observations.' },
  low_confidence: { kind: 'abstain', text: 'The trace was not certain enough to show.' },
  engine_not_ready: { kind: 'abstain', text: 'Part of the tracking engine could not load. Reload the page and try again.' },
  internal_error: { kind: 'abstain', text: 'The analysis hit an internal error.' },
  tracking_ended_early: { kind: 'partial', text: 'The ball was only followed while clearly visible.' },
  completion_uncertain: { kind: 'partial', text: 'The end of the arc is uncertain, so it fades early.' },
  single_sample_launch: { kind: 'partial', text: 'The launch was seen in only one frame.' },
  multiple_shots: { kind: 'info', text: 'More than one shot was found; the clearest one is shown.' },
  slow_decode_path: { kind: 'info', text: 'A slower decoding path was used for this video.' },
  speed_ramp: { kind: 'info', text: 'A slow-motion speed change was detected.' }
};
// Bulk mode exports an hf clip unseen only when 'tracked' at least this confident (PARAMS.decide.bulkMinConfidence),
// and only once the confidence is calibrated: the provisional model scores most traces 0.98, so it would pass them all.
export const BULK_MIN_CONFIDENCE = 0.9;
// The hf confidence model's label once fitted (PARAMS.confidence.calibratedOn).
export const HF_CALIBRATED_ON = 'synthetic-tune-v1';

/** Reason code for an analysis that stopped with this error: cancel, timeout, an internal error (code 'internal': the engine failed, not the video), or any other failure. */
export function stopReason(error) {
  if (error?.name === 'AbortError') return 'analysis_cancelled';
  if (error?.name === 'TimeoutError') return 'analysis_timed_out';
  return error?.code === 'internal' ? 'analysis_internal' : 'analysis_failed';
}

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
    note: 'Relative evidence score only — not a calibrated probability.',
    title: 'Evidence',
    caption: '(relative evidence)'
  };
}

/** hf confidence {value, calibratedOn, components} for the UI: the value itself, labelled with what it was calibrated on. */
export function hfConfidence(confidence) {
  const value = Number.isFinite(confidence?.value) ? Math.max(0, Math.min(1, confidence.value)) : 0;
  const calibrated = confidence?.calibratedOn === HF_CALIBRATED_ON;
  return {
    value, displayScore: value, calibrated, calibratedOn: confidence?.calibratedOn ?? 'uncalibrated', components: { ...confidence?.components },
    note: calibrated ? 'Calibrated on synthetic clips, not on real footage.' : 'Not calibrated yet: a provisional score.',
    title: `Confidence ${Math.round(value * 100)}%`,
    caption: calibrated ? '(calibrated on synthetic clips)' : '(not calibrated yet)'
  };
}

export function humanizeReasons(reasonCodes = []) {
  return reasonCodes.map(code => REASON_COPY[code] || code);
}

export function statusHeadline(status, { observedFrames = 0, reasonCodes = [], placed = null } = {}) {
  if (status === 'manual') {
    if (observedFrames < 2) return 'Manual trace · Place at least two points at different times.';
    // An adjusted automatic arc counts the points placed on it; a hand-made trace all of its points.
    return placed == null
      ? `Manual trace · ${observedFrames} points · Ready to export.`
      : `Manual trace · ${placed} placed point${placed === 1 ? '' : 's'} on the automatic arc · Ready to export.`;
  }
  if (status === 'partial') {
    return `Partial flight traced · ${observedFrames} observed frames. Tracking stopped when the ball was no longer clear.`;
  }
  if (status === 'tracked') return `Flight traced · ${observedFrames} observed frames.`;
  const stopped = reasonCodes.find(code => STOPPED_HEADLINE[code]);
  return stopped ? STOPPED_HEADLINE[stopped] : 'Could not reliably identify the ball in this video.';
}

export function canExportTrack(status, pointsLength) {
  if (status === 'no_reliable_track') return false;
  return pointsLength >= 2;
}

/**
 * Why bulk mode leaves a clip for review instead of exporting it unseen.
 * Null only for a confirmed automatic track: 'tracked', exportable, and not a fallback substitute.
 */
export function bulkReviewReason(report) {
  if (report?.status === 'manual') return 'Manual trace';
  if (report?.engine === 'hf') {
    // hf: 'tracked' and a calibrated confidence of at least BULK_MIN_CONFIDENCE.
    if (report.status === 'tracked' && report.exportable) {
      if (!report.confidence?.calibrated) return 'Confidence is not calibrated yet';
      return report.confidence.value >= BULK_MIN_CONFIDENCE ? null : `Confidence ${Math.round(report.confidence.value * 100)}% is below ${BULK_MIN_CONFIDENCE * 100}%`;
    }
    return report.status === 'no_reliable_track' ? 'No reliable flight found' : 'Partial flight';
  }
  if (report?.status === 'tracked' && report.exportable && !report.fallback) return null;
  if (report?.status === 'no_reliable_track') return 'No reliable flight found';
  return report?.fallback ? 'Unconfirmed track' : 'Partial flight';
}

const ENGINE_STATUSES = ['tracked', 'partial', 'no_reliable_track'];

/**
 * Normalize any engine result into a Phase 5 track report.
 * status 'manual' marks hand-placed points: own copy, no automatic reasons or evidence.
 */
export function normalizeTrackReport(result = {}) {
  const points = result.points || [], camera = result.camera || [];
  if (result.status === 'manual') {
    // Points still carrying hf statuses are an adjusted automatic arc.
    const adjusted = points.some(p => p.status && p.status !== 'manual');
    return {
      status: 'manual', points, camera, engine: result.engine || 'manual', reasonCodes: [], reasonText: [],
      confidence: null, selectedLaunchId: null, fallback: null,
      exportable: canExportTrack('manual', points.length),
      headline: statusHeadline('manual', { observedFrames: points.length, placed: adjusted ? points.filter(p => p.status === 'manual').length : null })
    };
  }
  if (result.engine === 'hf') return hfReport(result);
  let status = result.status;
  if (!status) {
    status = points.length >= 2 ? 'tracked' : 'no_reliable_track';
  }
  // Unknown statuses abstain rather than export.
  if (!ENGINE_STATUSES.includes(status)) status = 'no_reliable_track';
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
  // A scan that never finished measured no evidence: no bar at all rather than 0%.
  const stopped = status === 'no_reliable_track' && reasonCodes.some(code => STOPPED_HEADLINE[code]);
  const confidence = stopped ? null : buildConfidence({
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
    camera,
    engine: result.engine || 'unknown',
    reasonCodes,
    reasonText: humanizeReasons(reasonCodes),
    confidence,
    selectedLaunchId: result.selectedLaunchId || null,
    // v2 tags a track it took from the legacy linker; bulk mode never exports those unseen.
    fallback: result.diagnostics?.fallback || null,
    exportable: canExportTrack(status, points.length),
    headline: statusHeadline(status, { observedFrames: points.length, reasonCodes })
  };
}

const END_PHRASE = { landing: ' · arc completed to the landing', exit: ' · arc completed to the frame edge', fade: ' · arc completed until it fades' };

/**
 * An hf result as a track report. The engine's status is only ever lowered (a curve needs >= 2 points, and
 * 'tracked' >= 9, as for v2), with reason codes kept consistent with it; the confidence is the result's own.
 */
function hfReport(result) {
  const points = result.points || [], camera = result.camera || [];
  const kind = code => HF_REASONS[code]?.kind ?? (STOPPED_HEADLINE[code] ? 'abstain' : 'unknown');
  let status = ENGINE_STATUSES.includes(result.status) ? result.status : 'no_reliable_track';
  if (status !== 'no_reliable_track' && points.length < 2) status = 'no_reliable_track';
  if (status === 'tracked' && points.length < 9) status = 'partial';
  let codes = [...new Set(result.reasonCodes || [])];
  if (status === 'partial' && !codes.some(c => kind(c) === 'partial')) codes.push('tracking_ended_early');
  if (status === 'no_reliable_track') {
    codes = codes.filter(c => kind(c) !== 'partial');
    if (!codes.some(c => kind(c) === 'abstain')) codes.push('insufficient_visible_frames');
  }
  codes = [...codes.filter(c => kind(c) !== 'info'), ...codes.filter(c => kind(c) === 'info')];
  const observedFrames = result.observedFrames ?? result.observations?.length ?? 0, completion = result.completion ?? null;
  const stopped = codes.find(c => STOPPED_HEADLINE[c]), fault = status === 'no_reliable_track' && codes.some(c => HF_FAULTS.includes(c));
  const headline = status === 'tracked' ? `Flight traced · ${observedFrames} observed frames${END_PHRASE[completion?.end?.type] ?? ''}.`
    : status === 'partial' ? `Partial flight traced · ${observedFrames} observed frames.`
      : stopped ? STOPPED_HEADLINE[stopped] : fault ? 'Analysis failed.' : 'Could not reliably identify the ball in this video.';
  return {
    status, points: status === 'no_reliable_track' ? [] : points, camera, engine: 'hf', reasonCodes: codes,
    reasonText: codes.map(c => HF_REASONS[c]?.text ?? REASON_COPY[c] ?? c),
    // A scan that never finished, or an engine that failed, measured nothing about the ball: no bar at all.
    confidence: stopped || fault ? null : hfConfidence(result.confidence),
    selectedLaunchId: null, fallback: null, observedFrames, completion, launch: result.launch ?? null,
    exportable: canExportTrack(status, points.length), headline
  };
}
