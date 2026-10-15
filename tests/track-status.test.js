import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASON_COPY,
  buildConfidence,
  bulkReviewReason,
  canExportTrack,
  humanizeReasons,
  normalizeTrackReport,
  statusHeadline,
  stopReason
} from '../dist/track-status.js';

const track = (n, t0 = 1) => Array.from({ length: n }, (_, i) => ({ t: t0 + i / 30, x: 0.5, y: 0.8 - i * 0.01 }));

test('canExportTrack blocks abstention and allows tracked/partial with ≥2 points', () => {
  assert.equal(canExportTrack('no_reliable_track', 10), false);
  assert.equal(canExportTrack('tracked', 1), false);
  assert.equal(canExportTrack('tracked', 2), true);
  assert.equal(canExportTrack('partial', 5), true);
});

test('humanizeReasons maps known codes and passes through unknowns', () => {
  const text = humanizeReasons(['no_launch', 'custom_code']);
  assert.match(text[0], /launch/i);
  assert.equal(text[1], 'custom_code');
});

test('buildConfidence is relative and not calibrated', () => {
  const c = buildConfidence({
    status: 'tracked',
    margin: 12,
    vsRunner: 3,
    observedFrames: 40,
    firstT: 1,
    lastT: 2.5
  });
  assert.equal(c.calibrated, false);
  assert.ok(c.displayScore > 0.35 && c.displayScore <= 0.95);
  assert.match(c.note, /not a calibrated/i);
});

test('normalizeTrackReport abstains with export locked', () => {
  const report = normalizeTrackReport({
    points: [],
    status: 'no_reliable_track',
    reasonCodes: ['ambiguous_launch'],
    engine: 'global-v2'
  });
  assert.equal(report.status, 'no_reliable_track');
  assert.equal(report.exportable, false);
  assert.ok(report.reasonText.length);
  assert.equal(report.confidence.calibrated, false);
  assert.match(report.headline, /Could not reliably identify/i);
});

test('normalizeTrackReport demotes short tracks to partial and tags early end', () => {
  const points = Array.from({ length: 5 }, (_, i) => ({ t: i * 0.033, x: 0.4, y: 0.5 - i * 0.01 }));
  const report = normalizeTrackReport({
    points,
    status: 'tracked',
    confidence: 4,
    engine: 'global-v2'
  });
  assert.equal(report.status, 'partial');
  assert.ok(report.reasonCodes.includes('tracking_ended_early'));
  assert.equal(report.exportable, true);
  assert.match(statusHeadline(report.status, { observedFrames: 5 }), /Partial/i);
});

test('normalizeTrackReport keeps long observed tracks exportable', () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ t: 4 + i / 30, x: 0.5, y: 0.8 - i * 0.02 }));
  const report = normalizeTrackReport({
    points,
    status: 'tracked',
    confidence: 10,
    diagnostics: { vsRunner: 2 },
    engine: 'global-v2'
  });
  assert.equal(report.status, 'tracked');
  assert.equal(report.exportable, true);
  assert.equal(report.points.length, 20);
});

test('stopReason gives cancel, timeout and other failures their own reason codes', () => {
  assert.equal(stopReason(new DOMException('x', 'AbortError')), 'analysis_cancelled');
  assert.equal(stopReason(new DOMException('Detection timed out.', 'TimeoutError')), 'analysis_timed_out');
  assert.equal(stopReason(new Error('Automatic detection could not start.')), 'analysis_failed');
  assert.equal(stopReason(undefined), 'analysis_failed');
});

test('a stopped analysis reports itself, not decoder or evidence limits, and stays locked', () => {
  const headlines = new Set();
  for (const code of ['analysis_cancelled', 'analysis_timed_out', 'analysis_failed']) {
    const report = normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: [code], engine: 'v2' });
    assert.equal(report.status, 'no_reliable_track');
    assert.equal(report.exportable, false);
    assert.deepEqual(report.reasonCodes, [code]);
    assert.deepEqual(report.reasonText, [REASON_COPY[code]]);
    assert.equal(report.confidence, null, 'no evidence bar for a scan that never finished');
    assert.doesNotMatch(report.headline, /Could not reliably identify/);
    headlines.add(report.headline);
  }
  assert.equal(headlines.size, 3);
  assert.match(normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: ['analysis_cancelled'] }).headline, /cancelled/i);
  assert.match(normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: ['analysis_timed_out'] }).headline, /timed out/i);
});

test('stop reasons do not change the headline of a finished track', () => {
  assert.match(statusHeadline('tracked', { observedFrames: 20, reasonCodes: ['analysis_failed'] }), /^Flight traced · 20/);
});

test('manual traces get their own status and copy, with no automatic reasons or evidence', () => {
  const points = track(2);
  const report = normalizeTrackReport({ status: 'manual', points, camera: [{ t: 0, x: 0, y: 0 }], engine: 'v2', reasonCodes: ['ambiguous_launch'], confidence: 40 });
  assert.equal(report.status, 'manual');
  assert.equal(report.points, points, 'points are kept by reference so Undo can find the automatic track again');
  assert.deepEqual(report.reasonCodes, []);
  assert.deepEqual(report.reasonText, []);
  assert.equal(report.confidence, null);
  assert.equal(report.exportable, true);
  assert.match(report.headline, /^Manual trace · 2 points/);
  assert.doesNotMatch(report.headline, /Partial|observed frames/);
  const one = normalizeTrackReport({ status: 'manual', points: track(1) });
  assert.equal(one.exportable, false);
  assert.match(one.headline, /at least two points/);
});

test('bulk mode only exports confirmed automatic tracks unseen', () => {
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'tracked', points: track(20), confidence: 10 })), null);
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'tracked', points: track(5) })), 'Partial flight');
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'partial', points: track(30) })), 'Partial flight');
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'no_reliable_track', points: [] })), 'No reliable flight found');
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: ['analysis_timed_out'] })), 'No reliable flight found');
  assert.ok(bulkReviewReason(normalizeTrackReport({ status: 'manual', points: track(12) })));
  assert.ok(bulkReviewReason(null));
});

test('a legacy-fallback track is flagged and never auto-exported in bulk', () => {
  const report = normalizeTrackReport({
    status: 'tracked', points: track(22), confidence: 57, reasonCodes: ['no_ball_evidence'], engine: 'global-v2',
    diagnostics: { fallback: 'legacy-link', assocStatus: 'no_reliable_track', assocFrames: 0 }
  });
  assert.equal(report.fallback, 'legacy-link');
  assert.equal(bulkReviewReason(report), 'Unconfirmed track');
  assert.equal(normalizeTrackReport({ status: 'tracked', points: track(22) }).fallback, null);
});

test('unknown engine statuses abstain instead of exporting', () => {
  const report = normalizeTrackReport({ status: 'maybe', points: track(12) });
  assert.equal(report.status, 'no_reliable_track');
  assert.equal(report.exportable, false);
  assert.match(report.headline, /Could not reliably identify/);
  assert.match(statusHeadline('maybe', { observedFrames: 12 }), /Could not reliably identify/);
});

/* ---------------------------------------------------------------- hf results */

import { REASON_CODES, exampleResult, makeAbstention, isDowngradeOrSame } from '../dist/hf/types.js';
import { PARAMS } from '../dist/hf/params.js';
import { BULK_MIN_CONFIDENCE, HF_CALIBRATED_ON, HF_REASONS, hfConfidence } from '../dist/track-status.js';

test('every hf reason code has user-facing copy of the same kind, and nothing else does', () => {
  assert.deepEqual(Object.keys(HF_REASONS).sort(), Object.keys(REASON_CODES).sort());
  for (const [code, { kind }] of Object.entries(REASON_CODES)) {
    assert.equal(HF_REASONS[code].kind, kind, code);
    assert.ok(HF_REASONS[code].text.length > 10 && /[.!]$/.test(HF_REASONS[code].text), code);
  }
  assert.equal(BULK_MIN_CONFIDENCE, PARAMS.decide.bulkMinConfidence);
  assert.equal(HF_CALIBRATED_ON, PARAMS.confidence.calibratedOn);
});

test('an hf trace keeps its status, dense points, observed count and own confidence, labelled with its calibration', () => {
  const r = exampleResult('tracked'), report = normalizeTrackReport(r);
  assert.deepEqual([report.status, report.engine, report.exportable, report.observedFrames], ['tracked', 'hf', true, r.observedFrames]);
  assert.equal(report.points, r.points);
  assert.equal(report.camera, r.camera);
  assert.equal(report.headline, `Flight traced · ${r.observedFrames} observed frames · arc completed to the landing.`);
  assert.deepEqual([report.reasonCodes, report.reasonText], [[], []]);
  assert.deepEqual([report.confidence.value, report.confidence.displayScore, report.confidence.calibrated], [0.93, 0.93, true]);
  assert.deepEqual([report.confidence.title, report.confidence.caption], ['Confidence 93%', '(calibrated on synthetic clips)']);
  const raw = { ...r, confidence: { value: 0.7, calibratedOn: PARAMS.confidence.uncalibrated, components: {} } };
  assert.deepEqual([normalizeTrackReport(raw).confidence.calibrated, normalizeTrackReport(raw).confidence.caption], [false, '(not calibrated yet)']);
  assert.equal(hfConfidence(undefined).value, 0);
  for (const [type, phrase] of [['exit', 'to the frame edge'], ['fade', 'until it fades']]) {
    const ended = { ...r, completion: { ...r.completion, end: { ...r.completion.end, type } } };
    assert.match(normalizeTrackReport(ended).headline, new RegExp(`arc completed ${phrase}\\.$`));
  }
});

test('hf partial and abstention reports explain themselves with the hf copy; info codes come last; export is locked when abstaining', () => {
  const partial = normalizeTrackReport({ ...exampleResult('partial-a'), reasonCodes: ['slow_decode_path', 'completion_uncertain'] });
  assert.deepEqual([partial.status, partial.exportable], ['partial', true]);
  assert.deepEqual(partial.reasonCodes, ['completion_uncertain', 'slow_decode_path']);
  assert.deepEqual(partial.reasonText, [HF_REASONS.completion_uncertain.text, HF_REASONS.slow_decode_path.text]);
  assert.match(partial.headline, /^Partial flight traced · 12 observed frames\.$/);
  for (const code of ['no_launch', 'club_only_motion', 'decoder_limited', 'engine_not_ready', 'internal_error']) {
    const report = normalizeTrackReport(makeAbstention([code, 'slow_decode_path']));
    assert.deepEqual([report.status, report.exportable, report.points.length], ['no_reliable_track', false, 0]);
    assert.deepEqual(report.reasonText, [HF_REASONS[code].text, HF_REASONS.slow_decode_path.text]);
    // An engine fault is not a verdict on the video: no 'could not identify the ball', and no 0% confidence bar.
    const fault = ['engine_not_ready', 'internal_error'].includes(code);
    assert.equal(report.headline, fault ? 'Analysis failed.' : 'Could not reliably identify the ball in this video.', code);
    assert.equal(report.confidence === null, fault, code);
  }
  assert.doesNotMatch(HF_REASONS.engine_not_ready.text, /H\.264|this build/);
  // A stopped hf analysis reports the stop, with no evidence bar.
  const stopped = normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: ['analysis_cancelled'], engine: 'hf' });
  assert.deepEqual([stopped.headline, stopped.reasonText, stopped.confidence], ['Analysis cancelled.', [REASON_COPY.analysis_cancelled], null]);
});

test('an analysis that failed inside the engine says so, not "try an H.264 MP4"', () => {
  const internal = Object.assign(new Error('The analysis hit an internal error.'), { name: 'AnalysisError', code: 'internal' });
  assert.equal(stopReason(internal), 'analysis_internal');
  for (const code of ['unsupported', 'decode']) assert.equal(stopReason(Object.assign(new Error('x'), { name: 'AnalysisError', code })), 'analysis_failed');
  for (const engine of ['hf', 'global-v2']) {
    const report = normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: [stopReason(internal)], engine });
    assert.deepEqual([report.headline, report.confidence, report.exportable], ['Analysis failed.', null, false], engine);
    assert.deepEqual(report.reasonText, [REASON_COPY.analysis_internal]);
    assert.doesNotMatch(report.reasonText[0], /H\.264/);
  }
});

test('normalizeTrackReport only ever lowers an hf status and keeps its reason codes consistent', () => {
  const short = { ...exampleResult('tracked'), points: exampleResult('tracked').points.slice(0, 5) };
  const one = { ...exampleResult('partial-a'), points: exampleResult('partial-a').points.slice(0, 1) };
  const odd = { ...exampleResult('tracked'), status: 'maybe' };
  for (const [r, status, codes] of [[short, 'partial', ['tracking_ended_early']], [one, 'no_reliable_track', ['insufficient_visible_frames']], [odd, 'no_reliable_track', ['insufficient_visible_frames']]]) {
    const report = normalizeTrackReport(r);
    assert.equal(report.status, status);
    assert.deepEqual(report.reasonCodes, codes);
    assert.ok(isDowngradeOrSame(STATUS_OF[r.status] ?? 'tracked', report.status));
  }
  for (const kind of ['tracked', 'partial-a', 'partial-b', 'abstain']) {
    const r = exampleResult(kind);
    assert.equal(normalizeTrackReport(r).status, r.status, kind);
  }
});
const STATUS_OF = { tracked: 'tracked', partial: 'partial', no_reliable_track: 'no_reliable_track' };

test('bulk mode exports an hf clip unseen only when tracked with confidence >= 0.9', () => {
  const at = value => normalizeTrackReport({ ...exampleResult('tracked'), confidence: { value, calibratedOn: HF_CALIBRATED_ON, components: {} } });
  assert.equal(bulkReviewReason(at(0.93)), null);
  assert.equal(bulkReviewReason(at(0.9)), null);
  assert.equal(bulkReviewReason(at(0.89)), 'Confidence 89% is below 90%');
  assert.equal(bulkReviewReason(normalizeTrackReport(exampleResult('partial-a'))), 'Partial flight');
  assert.equal(bulkReviewReason(normalizeTrackReport(exampleResult('abstain'))), 'No reliable flight found');
  // An uncalibrated (provisional) score is no probability yet, however high: every such trace waits for review.
  for (const value of [0.98, 1]) {
    const raw = normalizeTrackReport({ ...exampleResult('tracked'), confidence: { value, calibratedOn: PARAMS.confidence.uncalibrated, components: {} } });
    assert.equal(bulkReviewReason(raw), 'Confidence is not calibrated yet');
  }
  assert.equal(bulkReviewReason(normalizeTrackReport({ ...exampleResult('tracked'), confidence: undefined })), 'Confidence is not calibrated yet');
  // v2 keeps its own rule: confirmed 'tracked' with no confidence gate.
  assert.equal(bulkReviewReason(normalizeTrackReport({ status: 'tracked', points: track(20), confidence: 0.1, engine: 'global-v2' })), null);
});

test('an adjusted hf trace is manual: it counts the points placed on the automatic arc', () => {
  const r = exampleResult('tracked'), points = [...r.points, { t: r.points.at(-1).t + 0.01, x: 0.5, y: 0.5, status: 'manual' }];
  const report = normalizeTrackReport({ status: 'manual', points, camera: r.camera, engine: 'hf' });
  assert.deepEqual([report.status, report.engine, report.exportable, report.confidence], ['manual', 'hf', true, null]);
  assert.equal(report.headline, 'Manual trace · 1 placed point on the automatic arc · Ready to export.');
  assert.equal(bulkReviewReason(report), 'Manual trace');
  // Hand-placed only (after Clear trace): every point counts.
  const placed = [{ t: 1, x: 0.4, y: 0.6, status: 'manual' }, { t: 1.2, x: 0.45, y: 0.5, status: 'manual' }];
  assert.match(normalizeTrackReport({ status: 'manual', points: placed, engine: 'hf' }).headline, /^Manual trace · 2 points · Ready to export\.$/);
});
