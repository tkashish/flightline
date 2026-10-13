import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateFlight,
  pathScore,
  launchPrior,
  framesFromTracks,
  launchesFromHypotheses,
  mergeAssocFrames,
  toRendererResult
} from '../dist/global-associate.js';

function ballFlight(opts = {}) {
  const startT = opts.startT ?? 4.43;
  const x0 = opts.x0 ?? 400;
  const y0 = opts.y0 ?? 900;
  const n = opts.n ?? 20;
  const fps = opts.fps ?? 30;
  const ballSize = opts.ballSize ?? 120;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = startT + i / fps;
    const pxSize = Math.max(8, ballSize - i * 4);
    frames.push({
      t,
      f: Math.round(t * fps),
      candidates: [{
        t,
        x: x0 + i * 0.4,
        y: y0 - i * 9,
        size: pxSize,
        quality: 0.9,
        score: 16,
        id: `ball:${i}`
      }]
    });
  }
  return frames;
}

test('pathScore does not systematically favor a longer clutter track', () => {
  const short = pathScore({
    launch: 30, evidenceSum: 40, motionSum: 4, gapSum: 0, identityPenalty: 0, nObs: 8
  });
  const longClutter = pathScore({
    launch: 8, evidenceSum: 90, motionSum: 50, gapSum: 2, identityPenalty: 6, nObs: 40
  });
  assert.ok(short > longClutter, `short=${short} long=${longClutter}`);
});

test('large address launch prior beats tiny clothing seed', () => {
  const ball = launchPrior({ sourceSize: 180, sourceQuality: 0.9, y: 900 }, 1280);
  const cloth = launchPrior({ sourceSize: 6, sourceQuality: 0.95, y: 860 }, 1280);
  assert.ok(ball > cloth + 10, `ball=${ball} cloth=${cloth}`);
});

test('selects real ball launch over earlier longer clothing creep', () => {
  // Clothing starts at 3.47s with many weak points; ball at 4.43s.
  const frames = [];
  for (let i = 0; i < 50; i++) {
    const t = 3.47 + i / 30;
    const cands = [];
    if (i < 40) {
      cands.push({
        t, x: 80 + i * 1.1, y: 860 - i * 12,
        size: 3, quality: 0.92, score: 14, id: `cloth:${i}`
      });
    }
    const bi = i - 29; // ball starts ~4.43
    if (bi >= 0 && bi < 18) {
      cands.push({
        t, x: 410 + bi * 0.3, y: 890 - bi * 10,
        size: Math.max(20, 160 - bi * 6), quality: 0.9, score: 17, id: `ball:${bi}`
      });
    }
    frames.push({ t, f: Math.round(t * 30), candidates: cands });
  }
  const launches = [
    { id: 'cloth', t: 3.47, x: 80, y: 860, sourceSize: 8, sourceQuality: 0.92 },
    { id: 'ball', t: 4.43, x: 410, y: 890, sourceSize: 160, sourceQuality: 0.9 }
  ];
  const result = associateFlight({ frames, launches, imageHeight: 1280, nullMargin: 1.5 });
  assert.notEqual(result.status, 'no_reliable_track');
  assert.equal(result.selectedLaunchId, 'ball');
  assert.ok(result.points[0].t >= 4.3, `start t=${result.points[0].t}`);
});

test('airplane crossing after ball fades does not steal identity', () => {
  const frames = ballFlight({ startT: 2.1, x0: 360, y0: 1000, n: 16, ballSize: 100 });
  // After ball ends, airplane continues with many bright points in another region.
  const lastBallT = frames.at(-1).t;
  for (let i = 0; i < 25; i++) {
    const t = lastBallT + 0.05 + i / 30;
    frames.push({
      t,
      f: Math.round(t * 30),
      candidates: [{
        t, x: 200 + i * 8, y: 200 + i * 0.5,
        size: 40, quality: 0.95, score: 22, id: `plane:${i}`
      }]
    });
  }
  const launches = [
    { id: 'ball', t: 2.1, x: 360, y: 1000, sourceSize: 100, sourceQuality: 0.9 }
  ];
  const result = associateFlight({ frames, launches, imageHeight: 1280, maxMiss: 6, nullMargin: 1.5 });
  assert.ok(result.points.length >= 8);
  assert.ok(result.points.at(-1).t <= lastBallT + 0.35, `tail t=${result.points.at(-1).t}`);
  assert.ok(!result.points.some(p => p.y < 350), 'should not jump onto airplane');
});

test('abstains when only sparse clutter exists', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const t = i / 30;
    frames.push({
      t,
      candidates: [{
        t, x: 100 + (i % 5) * 30, y: 100 + (i % 7) * 20,
        size: 4, quality: 0.7, score: 5, id: `noise:${i}`
      }]
    });
  }
  const result = associateFlight({
    frames,
    launches: [{ id: 'weak', t: 0.1, x: 100, y: 100, sourceSize: 4, sourceQuality: 0.7 }],
    minObs: 6,
    nullMargin: 3
  });
  assert.equal(result.status, 'no_reliable_track');
  assert.equal(result.points.length, 0);
});

test('leftward and rightward launches both associate', () => {
  for (const dir of [-1, 1]) {
    const frames = [];
    for (let i = 0; i < 15; i++) {
      const t = 1 + i / 30;
      frames.push({
        t,
        candidates: [{
          t, x: 400 + dir * i * 3, y: 900 - i * 8,
          size: 40, quality: 0.88, score: 15, id: `p:${i}`
        }]
      });
    }
    const result = associateFlight({
      frames,
      launches: [{ id: 'L', t: 1, x: 400, y: 900, sourceSize: 40, sourceQuality: 0.88 }]
    });
    assert.ok(result.points.length >= 8, `dir=${dir}`);
  }
});

test('framesFromTracks + launchesFromHypotheses round-trip helpers', () => {
  const tracks = [{
    launchId: 'L1',
    sourceSize: 50,
    points: Array.from({ length: 8 }, (_, i) => ({
      t: 1 + i / 30, f: 30 + i, x: 10 + i, y: 120 - i * 12, size: 50 - i, quality: 0.9
    }))
  }];
  const frames = framesFromTracks(tracks);
  assert.equal(frames.length, 8);
  const launches = launchesFromHypotheses([], tracks);
  assert.equal(launches[0].id, 'L1');
  assert.ok(launches[0].vy < 0);
  const rendered = toRendererResult(
    associateFlight({ frames, launches, minObs: 2, nullMargin: 0.5 }),
    { width: 100, height: 200, camera: [] }
  );
  assert.ok(rendered.points.length >= 2);
  assert.ok(rendered.points[0].x <= 1);
  assert.equal(rendered.engine, 'global-v2');
});

test('associates a fast ball launch that would fail a cold-start accel gate', () => {
  // ~80 px/frame climb ≈ real analysis-scale launch; seed starts near-stationary.
  const frames = [];
  for (let i = 0; i < 14; i++) {
    const t = 2 + i / 30;
    frames.push({
      t,
      f: Math.round(t * 30),
      candidates: [{
        t, x: 420 + i * 2, y: 980 - i * 80,
        size: Math.max(12, 140 - i * 8), quality: 0.9, score: 18, id: `fast:${i}`
      }]
    });
  }
  const result = associateFlight({
    frames,
    launches: [{ id: 'ball', t: 2, x: 420, y: 980, sourceSize: 140, sourceQuality: 0.9 }],
    imageHeight: 1280,
    nullMargin: 1.5
  });
  assert.notEqual(result.status, 'no_reliable_track');
  assert.ok(result.points.length >= 8, `n=${result.points.length}`);
  assert.ok(result.points.at(-1).y < 500, `end y=${result.points.at(-1).y}`);
});

test('mergeAssocFrames unions track observations into detector frames', () => {
  const merged = mergeAssocFrames(
    [{ t: 1, f: 30, candidates: [{ x: 10, y: 10, id: 'a' }] }],
    [{ t: 1, f: 30, candidates: [{ x: 50, y: 50, id: 'b' }] }, { t: 1.1, f: 33, candidates: [{ x: 55, y: 40, id: 'c' }] }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].candidates.length, 2);
});
