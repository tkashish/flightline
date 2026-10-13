import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClip, observedToSourcePixels, nearestObserved } from './lib/metrics.mjs';

test('observedToSourcePixels undoes normalization with camera offset', () => {
  const points = [{ t: 1, x: 0.5, y: 0.25 }];
  const camera = [{ t: 1, x: 0.1, y: -0.05 }];
  const src = observedToSourcePixels(points, camera, 100, 200, 1000, 2000);
  assert.equal(src.length, 1);
  assert.ok(Math.abs(src[0].x - 600) < 1e-6);
  assert.ok(Math.abs(src[0].y - 400) < 1e-6);
});

test('nearestObserved respects time window', () => {
  const pts = [{ t: 1.0, x: 1, y: 1 }, { t: 1.2, x: 2, y: 2 }];
  assert.equal(nearestObserved(pts, 1.05, 0.1).t, 1.0);
  assert.equal(nearestObserved(pts, 1.5, 0.1), null);
});

test('evaluateClip marks expectAbstention true when no track', () => {
  const run = {
    engine: 'legacy',
    meta: { width: 100, height: 200, analysisWidth: 100, analysisHeight: 200 },
    result: { points: [], camera: [] },
    elapsedMs: 1,
    frameCount: 10,
    competingTracks: []
  };
  const m = evaluateClip(run, { expectAbstention: true });
  assert.equal(m.status, 'pass');
  assert.equal(m.abstention, 'true_abstention');
});

test('evaluateClip fails expectAbstention when a track is produced', () => {
  const run = {
    engine: 'legacy',
    meta: { width: 100, height: 200, analysisWidth: 100, analysisHeight: 200 },
    result: {
      points: [{ t: 1, x: 0.5, y: 0.5 }, { t: 1.1, x: 0.51, y: 0.4 }],
      camera: [{ t: 1, x: 0, y: 0 }]
    },
    elapsedMs: 1,
    frameCount: 10,
    competingTracks: []
  };
  const m = evaluateClip(run, { expectAbstention: true });
  assert.equal(m.status, 'fail');
  assert.equal(m.falseTrace, true);
});

test('evaluateClip scores impact and launch when annotated', () => {
  const run = {
    engine: 'legacy',
    meta: { width: 1000, height: 2000, analysisWidth: 500, analysisHeight: 1000 },
    result: {
      points: [
        { t: 4.43, x: 0.57, y: 0.69 },
        { t: 4.5, x: 0.58, y: 0.60 }
      ],
      camera: [{ t: 4.43, x: 0, y: 0 }, { t: 4.5, x: 0, y: 0 }]
    },
    elapsedMs: 10,
    frameCount: 100,
    competingTracks: []
  };
  const m = evaluateClip(run, {
    impactT: 4.43,
    addressBall: { t: 4.43, x: 570, y: 1380 },
    frames: [
      { t: 4.43, status: 'visible', x: 570, y: 1380 },
      { t: 4.5, status: 'visible', x: 580, y: 1200 }
    ]
  });
  assert.equal(m.status, 'pass');
  assert.ok(m.impactTimingErrorSec < 0.01);
  assert.ok(m.launchAnchorErrorPx < 5);
  assert.equal(m.shotSuccess, true);
});
