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
  const hooks = [];
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
    if (hook) hooks.push(hook);
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  // Original f787233 assertion (weakened in 011df5e, which hid the apex regression).
  const points = tracker.result().points;
  assert.ok(points.length >= 10, `${points.length} points found`);
  const last = points.at(-1);
  const mid = points[Math.floor(points.length * .7)];
  const lateRise = (mid.y - last.y) * 1280;
  const lateRun = Math.abs(last.x - mid.x) * 720;
  assert.ok(lateRise < Math.max(14, lateRun * 1.25 + 8),
    `hooked upward: lateRise=${lateRise.toFixed(1)} lateRun=${lateRun.toFixed(1)}`);
  // True coast stays near-level; a vertical speck would be much higher.
  assert.ok(last.y * 1280 > mid.y * 1280 - 40, `climbed into vertical speck y=${last.y * 1280}`);
  // The gravity bend at the apex is kept, so the track never rides the 2-px speck.
  const onHook = points.filter(p => hooks.some(h => Math.abs(h.t - p.t) < 1e-9 && Math.hypot(h.x / 720 - p.x, h.y / 1280 - p.y) < 1e-6));
  assert.equal(onHook.length, 0, `${onHook.length} speck points`);
  assert.ok(Math.abs(last.t - 41 / 30) < 1e-9, `ball followed to the end, last t=${last.t}`);
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
test('hook verdicts are mirror-symmetric: left and right flights are judged alike', () => {
  const tracker = new MotionTracker(720, 1280);
  const cases = [
    { v: [1.0, -3.5], pv: [3, -3], hook: true },   // snaps ~29 deg toward vertical
    { v: [2.0, -1.5], pv: [1, -2], hook: false },  // normal flattening
    { v: [3, -3], pv: [1, -3.5], hook: false },    // normal flattening
    { v: [-1.6, -1.0], pv: [-0.8, -2.0], hook: false }
  ];
  for (const { v, pv, hook } of cases) {
    assert.equal(tracker.isBallisticHook(v[0], v[1], pv[0], pv[1]), hook, `right ${v}`);
    assert.equal(tracker.isBallisticHook(-v[0], v[1], -pv[0], pv[1]), hook, `mirrored ${v}`);
  }
});
test('gravity-consistent bends are not hooks; anti-gravity turns and reversals still are', () => {
  const tracker = new MotionTracker(720, 1280);
  for (const s of [1, -1]) {
    assert.equal(tracker.isBallisticHook(s * .5, 0, s * .5, -.9), false, 'apex turnover');
    assert.equal(tracker.isBallisticHook(s * .5, .2, s * .5, -.9), false, 'apex into descent');
    assert.equal(tracker.isBallisticHook(s * 2.2, -.4, s * 2.25, -2.95), false, 'coast bending down');
    assert.equal(tracker.isBallisticHook(s * .3, -2.5, s * 2, -1), true, 'diagonal to vertical up');
    assert.equal(tracker.isBallisticHook(-s * 2, -.5, s * 2, -1), true, 'horizontal reversal');
    assert.equal(tracker.isBallisticHook(s * 3, .2, s * 1, -2), true, 'sharp bend that also speeds the run up');
    assert.equal(tracker.isBallisticHook(s * .1, -.7, s * 2, -.3), true, 'sharp turn upward: only the turn rule sees it');
  }
});
test('the sky coaster keeps strict hook rules for its weak sky peaks', () => {
  const tracker = new MotionTracker(720, 1280);
  for (const s of [1, -1]) {
    assert.equal(tracker.isBallisticHook(s * .5, 0, s * .5, -.9, { strict: true }), true, 'no gravity-bend allowance');
    assert.equal(tracker.isBallisticHook(s * 1.73, -1.03, s * 1.42, -3.14, { strict: true }), true, 'snap flat while climbing');
    assert.equal(tracker.isBallisticHook(s * 1.73, -1.03, s * 1.42, -3.14), false, 'linking accepts the flattening');
  }
  // End to end: a sky peak that needs a sharp downward bend is not offered by the coaster
  // (with the linking rules it would be: the bend is gravity-consistent).
  const track = { points: [], cost: 0, score: 50, length: 100, anchor: 40 };
  for (let k = 0; k < 8; k++) track.points.push({ x: 300 + 2 * k, y: 500 - 1.5 * k, f: 12 + k, t: (12 + k) / 30, size: 4, quality: .9, roundness: 1, compactness: .8 });
  tracker.best = track; tracker.frame = 20;
  const last = track.points.at(-1), peak = { x: Math.round(last.x + 2.2), y: Math.round(last.y + 0.6) };
  const rgba = new Uint8ClampedArray(720 * 1280 * 4);
  for (let i = 0; i < 720 * 1280; i++) rgba.set([120, 170, 230, 255], i * 4);
  rgba.set([200, 200, 200, 255], (peak.y * 720 + peak.x) * 4);
  const gray = new Uint8Array(720 * 1280);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  assert.deepEqual(tracker.localFlightCandidatesForTrack(track, gray, rgba, 20 / 30), []);
  const lenient = new MotionTracker(720, 1280);
  lenient.isBallisticHook = (vx, vy, pvx, pvy) => tracker.isBallisticHook(vx, vy, pvx, pvy);
  lenient.best = track; lenient.frame = 20;
  assert.equal(lenient.localFlightCandidatesForTrack(track, gray, rgba, 20 / 30).length, 1, 'only the strict rule rejects it');
});
test('left- and right-moving flights keep the same number of points', () => {
  const run = (dir, g, vx, v0) => {
    const tracker = new MotionTracker(720, 1280);
    for (let i = 0; i < 70; i++) {
      tracker.frame = i;
      const k = Math.max(0, i - 15);
      const ball = { x: 360 + dir * vx * k, y: 900 - (v0 * k - 0.5 * g * k * k), t: i / 30, f: i, size: k === 0 ? 48 : Math.max(3, 30 - k * 2), quality: .88, moving: k > 0, roundness: 1.05, compactness: .8 };
      tracker.link(ball.moving ? [ball] : [], [ball]);
      tracker.updateSpots([ball]);
    }
    return tracker.result().points.length;
  };
  for (const [g, vx, v0] of [[.6, 1, 12], [.7, 3, 12], [.7, 2.5, 14], [.8, 3, 12], [.6, 2.5, 12]]) {
    assert.equal(run(-1, g, vx, v0), run(1, g, vx, v0), `g=${g} vx=${vx} v0=${v0}`);
  }
});
test('the result() hook trim treats a left-moving snap upright like a right-moving one', () => {
  const trimmed = dir => {
    const tracker = new MotionTracker(720, 1280);
    const points = [];
    for (let k = 0; k <= 15; k++) points.push({ x: 360 + dir * 3 * k, y: 1000 - 4 * k, f: k, t: k / 30, size: 6, quality: .9 });
    points.push({ x: points.at(-1).x + dir * .3, y: points.at(-1).y - 5, f: 16, t: 16 / 30, size: 4, quality: .9 });
    tracker.best = { points, cost: 0, score: 50, length: 100, anchor: 40, launchId: 'L1' };
    return points.length - tracker.result().points.length;
  };
  assert.equal(trimmed(1), 1, 'diagonal-to-vertical snap trimmed when moving right');
  assert.equal(trimmed(-1), 1, 'and when moving left');
});
test('a golfer highlight that does seed its own track still loses to the address ball (BALL-01)', () => {
  // Unlike the creep above (too slow to ever seed), this highlight leaves its spot with a clear jump and
  // keeps a real competing track for ~20 frames before the ball launches.
  const tracker = new MotionTracker(720, 1280);
  let highlightTrack = 0;
  for (let i = 0; i < 160; i++) {
    tracker.frame = i;
    const t = i / 30, hl = Math.max(0, i - 104), bl = Math.max(0, i - 133);
    const highlight = hl === 0 ? { x: 72, y: 865 } : { x: 75 + (hl - 1) * .5, y: 857 - (hl - 1) * 1.6 };
    const ball = { x: 413 + bl * .15, y: 882 - bl * 8 };
    const candidates = [
      { ...ball, t, f: i, size: bl === 0 ? 196 : Math.max(40, 196 - bl * 8), quality: .9, moving: bl > 0, roundness: 1.12, compactness: .68 },
      ...(hl <= 24 ? [{ ...highlight, t, f: i, size: hl ? 7 : 9, quality: .91, moving: hl > 0, roundness: 1.3, compactness: .6 }] : [])
    ];
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
    for (const track of tracker.tracks) if (Math.abs(track.points[0].x - 72) < 3) highlightTrack = Math.max(highlightTrack, track.points.length);
  }
  assert.ok(highlightTrack >= 8, `the highlight only reached ${highlightTrack} points`);
  const points = tracker.result().points;
  assert.ok(points.length >= 12, `${points.length} points found`);
  assert.ok(Math.abs(points[0].x * 720 - 413) < 2, `started at x=${points[0].x * 720}`);
  assert.ok(points[0].t >= 4.3, `started too early at t=${points[0].t}`);
});
