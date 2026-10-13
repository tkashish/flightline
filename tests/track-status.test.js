import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfidence,
  canExportTrack,
  humanizeReasons,
  normalizeTrackReport,
  statusHeadline
} from '../dist/track-status.js';

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
