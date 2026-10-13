import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionTracker, visiblePath, cameraAt } from '../dist/tracker.js';

function frame(width, height, ball, shift = 0) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const texture = ((x - shift) * 7 + y * 3) % 22;
    pixels[i] = 55 + texture; pixels[i + 1] = 95 + texture; pixels[i + 2] = 60 + texture; pixels[i + 3] = 255;
    if (x > 20 + shift && x < 50 + shift && y > 100 && y < 145) pixels.set([240, 240, 240, 255], i);
    if (ball && Math.hypot(x - ball.x, y - ball.y) <= (ball.radius || 2.3)) {
      const light = ball.radius ? Math.round(255 - 80 * ((x - ball.x) ** 2 + (y - ball.y) ** 2) / ball.radius ** 2) : 255;
      pixels.set([light, light, light, 255], i);
    }
  }
  return pixels;
}
for (const direction of [-1, 1]) test(`follows a visible rising ball moving ${direction < 0 ? 'left' : 'right'}`, () => {
  const tracker = new MotionTracker(320, 180);
  for (let i = 0; i < 35; i++) tracker.detect(frame(320, 180, { x: 160 + direction * Math.max(0, i - 13) * 3, y: 150 - Math.max(0, i - 13) * 4 }), i / 30);
  const result = tracker.result();
  assert.ok(result.points.length >= 18, `${result.points.length} points found`);
  const end = result.points.at(-1);
  assert.ok(Math.abs(end.x * 320 - (160 + direction * 21 * 3)) < 3);
  assert.ok(Math.abs(end.y * 180 - 66) < 3);
});
test('does not trace static white objects', () => {
  const tracker = new MotionTracker(320, 180);
  for (let i = 0; i < 20; i++) tracker.detect(frame(320, 180, { x: 160, y: 150 }), i / 30);
  assert.equal(tracker.result().points.length, 0);
});
test('tracks a larger address ball in a closely framed clip', () => {
  const tracker = new MotionTracker(320, 180);
  for (let i = 0; i < 50; i++) tracker.detect(frame(320, 180, { x: 170 + Math.max(0, i - 15) * .6, y: 150 - Math.max(0, i - 15) * 3, radius: 8 }), i / 30);
  const points = tracker.result().points;
  assert.ok(points.length >= 20, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 320 - 170) < 2);
  assert.ok(Math.abs(points.at(-1).y * 180 - 48) < 3);
});
test('keeps the address ball when brighter single-pixel clutter exceeds the old candidate limit', () => {
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 35; i++) {
    tracker.frame = i;
    const clutter = Array.from({ length: 400 }, (_, j) => ({ x: j % 40 * 17, y: Math.floor(j / 40) * 13, t: i / 30, f: i, size: 1, quality: 1, moving: false, roundness: 1, compactness: 1 }));
    const ball = { x: 444 + Math.max(0, i - 13) * 3, y: 730 - Math.max(0, i - 13) * 10, t: i / 30, f: i, size: 48, quality: .88, moving: i > 13, roundness: 1.28, compactness: .78 };
    const candidates = [...clutter, ball];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 18);
  assert.ok(Math.abs(points[0].x * 720 - 444) < 1);
  assert.ok(Math.abs(points[0].y * 1280 - 730) < 1);
});
test('does not seed a flight from a thin stationary reflection', () => {
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 35; i++) {
    tracker.frame = i;
    const highlight = { x: 468 - Math.max(0, i - 13) * 5, y: 830 - Math.max(0, i - 13) * 20, t: i / 30, f: i, size: 10, quality: .92, moving: i > 13, roundness: 1.5, compactness: .42 };
    tracker.link(highlight.moving ? [highlight] : [], [highlight]);
    tracker.updateSpots([highlight]);
  }
  assert.equal(tracker.result().points.length, 0);
});
test('selects the ball over a faster chain of dim highlights on the golfer', () => {
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 45; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 15);
    const ball = { x: 413 + launched * .2, y: 882 - launched * 6, t: i / 30, f: i, size: 100, quality: .88, moving: launched > 0, roundness: 1.1, compactness: .7 };
    const highlight = { x: 72, y: 865 - launched * 25, t: i / 30, f: i, size: 9, quality: launched < 2 ? .91 : .72, moving: launched > 0, roundness: 1, compactness: .7 };
    const candidates = [ball, highlight];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 20);
  assert.ok(Math.abs(points[0].x * 720 - 413) < 1);
});
test('rejects an elongated growing club-head arc after address', () => {
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 40; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 15);
    const ball = {
      x: 440 + launched * .5,
      y: 730 - launched * 12,
      t: i / 30, f: i,
      size: launched === 0 ? 48 : Math.max(4, 30 - launched * 3),
      quality: .88, moving: launched > 0, roundness: 1.1, compactness: .8
    };
    // Club swings left+up around the body and grows in the image.
    const club = {
      x: 440 - launched * 8,
      y: 730 - launched * 10,
      t: i / 30, f: i,
      size: launched === 0 ? 20 : 20 + launched * 4,
      quality: .86, moving: launched > 0, roundness: 2.2, compactness: .32
    };
    const candidates = launched ? [ball, club] : [ball];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 5, `${points.length} points found`);
  assert.ok(points.at(-1).x * 720 > 420, `followed club left to x=${points.at(-1).x * 720}`);
  assert.ok(points.every((p, i) => i === 0 || p.x * 720 > 400), 'path crossed into club arc');
});
test('stops when the ball fades instead of creeping on a 1px glare tail', () => {
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 45; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 14);
    // Real rise for ~7 frames, then a near-static 1px speck (glare).
    const y = launched === 0 ? 730
      : launched <= 7 ? 730 - launched * 14
      : 730 - 7 * 14 - (launched - 7) * .8;
    const ball = {
      x: 440 + Math.min(launched, 7) * .4,
      y,
      t: i / 30, f: i,
      size: launched === 0 ? 48 : launched <= 7 ? Math.max(3, 28 - launched * 3) : 1,
      quality: .88, moving: launched > 0, roundness: 1.1, compactness: .8
    };
    const candidates = [ball];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 5, `${points.length} points found`);
  assert.ok(points.length <= 9, `crept too long: ${points.length} points`);
  assert.ok(points.at(-1).y * 1280 < 660, `did not rise: y=${points.at(-1).y * 1280}`);
  assert.ok(points.at(-1).t <= 22 / 30, `tail continued into glare t=${points.at(-1).t}`);
});
test('rejects a late anti-gravity vertical hook after diagonal coasting', () => {
  // Fast launch, then a near-level diagonal coast. A sky speck then snaps upward.
  const tracker = new MotionTracker(720, 1280);
  let x = 440, y = 730, vx = 0, vy = 0;
  for (let i = 0; i < 42; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 12);
    if (launched === 1) { vx = 2.4; vy = -14; }
    if (launched > 0) {
      x += vx; y += vy;
      // Gravity: climb decays toward a shallow diagonal coast.
      vy = Math.min(0.4, vy + 0.85);
      vx *= 0.995;
    }
    const ball = {
      x, y, t: i / 30, f: i,
      size: launched === 0 ? 48 : Math.max(2, 24 - Math.min(launched, 10) * 2),
      quality: .88, moving: launched > 0, roundness: 1.05, compactness: .82
    };
    const coasting = launched >= 16;
    const hook = coasting ? {
      x: x - 0.5,
      y: y - 16 - (launched - 16) * 9,
      t: i / 30, f: i,
      size: 2, quality: .9, moving: true, roundness: 1, compactness: 1
    } : null;
    const candidates = hook ? [hook, ball] : [ball];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const raw = tracker.best?.points || [];
  const coast = raw.slice(12);
  let maxStepUp = 0;
  for (let i = 1; i < coast.length; i++) {
    const dt = Math.max(1, coast[i].f - coast[i - 1].f);
    maxStepUp = Math.max(maxStepUp, (coast[i - 1].y - coast[i].y) / dt);
  }
  assert.ok(maxStepUp < 11, `sky hook jump ${maxStepUp.toFixed(1)} px/frame after launch`);
});
test('rejects a sideways body highlight that steals the address seed', () => {
  // Mirrors PXL_20261011_184957300: address ball at mid-frame, then a large
  // bright clothing blob appears far to the side with almost no rise.
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 40; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 18);
    const ball = {
      x: 439 + launched * .4,
      y: 731 - launched * 12,
      t: i / 30, f: i,
      size: launched === 0 ? 48 : Math.max(4, 28 - launched * 3),
      quality: .88, moving: launched > 0, roundness: 1.14, compactness: .84
    };
    const leg = {
      x: launched > 2 ? 244 : 310,
      y: launched > 2 ? 575 : 724,
      t: i / 30, f: i, size: launched > 2 ? 50 : 75, quality: .85,
      moving: launched > 0, roundness: 2.1, compactness: .55
    };
    const glare = {
      x: 275, y: 829 - launched * 40,
      t: i / 30, f: i, size: 7, quality: .9,
      moving: launched > 5, roundness: 1, compactness: .7
    };
    const candidates = launched ? [ball, leg, glare] : [ball];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 8, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 720 - 439) < 3, `started at x=${points[0].x * 720}`);
  assert.ok(points.at(-1).x * 720 > 400, `drifted onto body at x=${points.at(-1).x * 720}`);
  assert.ok(points.at(-1).y * 1280 < 620, `did not rise enough: y=${points.at(-1).y * 1280}`);
});
test('bridges a one-frame impact flood after a strong address launch', () => {
  // Browser Pixel clips: address ball seeds, then one flooded frame hides the
  // ball, then a shrinking rising ball reappears. Top-bright movers alone miss it.
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 45; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 20);
    const ball = {
      x: 444 + (launched ? 1.5 + (launched - 1) * 2.2 : 0),
      y: 732 - (launched ? 8 + (launched - 1) * 18 : 0),
      t: i / 30, f: i,
      size: launched === 0 ? 52 : Math.max(4, 48 - launched * 7),
      quality: .9, moving: launched > 0, roundness: 1.25, compactness: .8
    };
    const flood = i === 21
      ? Array.from({ length: 900 }, (_, j) => ({
          x: (j * 13) % 700, y: 100 + (j % 90) * 12, t: i / 30, f: i,
          size: 1 + (j % 3), quality: .98, moving: true, roundness: 1, compactness: .7
        }))
      : [];
    // Hide the ball on the flooded frame so linking must bridge a gap.
    const candidates = i === 21 ? flood : [ball, ...flood];
    const moving = candidates.filter(p => p.moving);
    const linkSet = moving.length <= 220
      ? moving
      : [...moving.slice(0, 140), ...moving.filter(p => p.size >= 3 && p.quality >= .78)].filter((p, idx, arr) => arr.indexOf(p) === idx).slice(0, 360);
    tracker.link(linkSet, candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 8, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 720 - 444) < 3, `started at x=${points[0].x * 720}`);
  assert.ok(points.at(-1).y * 1280 < 650, `did not rise enough: y=${points.at(-1).y * 1280}`);
});
test('still seeds a strong address ball when impact motion would otherwise block seeding', () => {
  const tracker = new MotionTracker(720, 1280);
  tracker.seedBlockedUntil = 999;
  for (let i = 0; i < 40; i++) {
    tracker.frame = i;
    const launched = Math.max(0, i - 20);
    const ball = {
      x: 444 + launched * .4,
      y: 730 - launched * 8,
      t: i / 30, f: i,
      size: launched ? Math.max(18, 52 - launched * 3) : 52,
      quality: .9, moving: launched > 0, roundness: 1.28, compactness: .82
    };
    const clutter = Array.from({ length: 100 }, (_, j) => ({
      x: (j * 17) % 700, y: 200 + (j % 40) * 20, t: i / 30, f: i,
      size: 8, quality: .95, moving: true, roundness: 1, compactness: .7
    }));
    const candidates = [ball, ...clutter];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 8, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 720 - 444) < 2);
});
test('rejects a bright creeping golfer highlight that launches before the address ball', () => {
  // Mirrors golf_slow_mo.mp4: a tiny clothing highlight creeps from ~3.47s, while the
  // real ball stays put until ~4.43s and then rises nearly vertically.
  const tracker = new MotionTracker(720, 1280);
  for (let i = 0; i < 160; i++) {
    tracker.frame = i;
    const t = i / 30;
    const highlightLaunch = Math.max(0, i - 104);
    const ballLaunch = Math.max(0, i - 133);
    const highlight = {
      x: 72 + Math.min(highlightLaunch, 20) * .35 + Math.max(0, highlightLaunch - 20) * 1.2,
      y: 865 - Math.min(highlightLaunch, 20) * .7 - Math.max(0, highlightLaunch - 20) * 28,
      t, f: i, size: highlightLaunch > 0 ? (highlightLaunch < 8 ? 5 : 2) : 9,
      quality: .91, moving: highlightLaunch > 0, roundness: 1.6, compactness: .6
    };
    const ball = {
      x: 413 + ballLaunch * .15,
      y: 882 - ballLaunch * 8,
      t, f: i, size: ballLaunch === 0 ? 196 : Math.max(40, 196 - ballLaunch * 8),
      quality: .9, moving: ballLaunch > 0, roundness: 1.12, compactness: .68
    };
    const candidates = [ball, highlight];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  const points = tracker.result().points;
  assert.ok(points.length >= 12, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 720 - 413) < 2, `started at x=${points[0].x * 720}`);
  assert.ok(points[0].t >= 4.3, `started too early at t=${points[0].t}`);
});
test('bridges a brief occlusion without inventing observed positions', () => {
  const tracker = new MotionTracker(320, 180);
  for (let i = 0; i < 35; i++) tracker.detect(frame(320, 180, i !== 24 ? { x: 160 + Math.max(0, i - 13) * 3, y: 150 - Math.max(0, i - 13) * 4 } : null), i / 30);
  const result = tracker.result();
  assert.ok(result.points.length >= 18);
  assert.ok(!result.points.some(p => p.t === 24 / 30));
});
test('reveals the line with time and never extends beyond its observed endpoint', () => {
  const points = [{ t: 1, x: 0, y: 1 }, { t: 2, x: 1, y: 0 }];
  assert.deepEqual(visiblePath(points, .5), []);
  assert.deepEqual(visiblePath(points, 1.5).at(-1), { t: 1.5, x: .5, y: .5 });
  assert.deepEqual(visiblePath(points, 9).at(-1), points[1]);
  assert.deepEqual(visiblePath(points, 9, false), []);
});
test('camera positions interpolate and clamp at boundaries', () => {
  const camera = [{ t: 0, x: 0, y: 0 }, { t: 1, x: .1, y: .2 }];
  assert.deepEqual(cameraAt(camera, .5), { x: .05, y: .1 });
  assert.deepEqual(cameraAt(camera, 3), { x: .1, y: .2 });
  assert.deepEqual(cameraAt([], .5), { x: 0, y: 0 });
});
