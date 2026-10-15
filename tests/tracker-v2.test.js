import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionTracker } from '../dist/tracker.js';

// Pixel-level synthetic clips: 360x640 portrait, clean sky over textured grass, white discs for the ball
// and distractors. Times are i/30 s, exactly what the app sends the worker. The sky is noise-free so the
// legacy sky coaster (a known source of invented points, not changed here) stays quiet after the ball.
const W = 360, H = 640;
const BASE = (() => {
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, v = (rnd() - 0.5) * 8;
    if (y < H * 0.55) a.set([120, 170, 230, 255], i);
    else a.set([60 + 3 * v, 110 + 3 * v, 50 + 3 * v, 255], i);
  }
  return a;
})();
function frame(discs) {
  const a = new Uint8ClampedArray(BASE);
  for (const d of discs) {
    const r = d.r ?? 2.2;
    for (let y = Math.floor(d.y - r - 1); y <= d.y + r + 1; y++) for (let x = Math.floor(d.x - r - 1); x <= d.x + r + 1; x++) {
      if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - d.x, y - d.y) <= r) a.set(d.rgb ?? [245, 245, 245, 255], (y * W + x) * 4);
    }
  }
  return a;
}
// Address ball at (180, 470) until frame LAUNCH; frame LAUNCH + k is k steps into the flight.
const LAUNCH = 20;
function flightPath({ vx = 0.8, vy = -8, g = 0.2, steps = 40 } = {}) {
  const pts = [{ x: 180, y: 470 }];
  let x = 180, y = 470, v = vy;
  for (let k = 1; k <= steps; k++) { x += vx; y += v; v += g; pts.push({ x, y }); }
  return pts;
}
function run(engine, { frames = 70, path = flightPath(), extra = () => [], ball = true } = {}) {
  const tracker = new MotionTracker(W, H, { engine });
  for (let i = 0; i < frames; i++) {
    const k = i - LAUNCH, discs = extra(i);
    if (ball && k < path.length) discs.push({ ...path[Math.max(0, k)], r: k > 4 ? 2.2 : 3 });
    tracker.detect(frame(discs), i / 30);
  }
  return { tracker, result: tracker.result() };
}
const px = p => ({ t: p.t, x: p.x * W, y: p.y * H });

test('v2 traces one launched ball from the impact sample to its last visible frame', () => {
  const path = flightPath();
  const { tracker, result } = run('v2', { path });
  assert.equal(result.engine, 'global-v2');
  assert.equal(result.status, 'tracked');
  const pts = result.points.map(px);
  // Starts at the address on the launch sample, never on the parked ball before impact.
  assert.ok(Math.abs(pts[0].t - LAUNCH / 30) < 1e-6, `first t=${pts[0].t}`);
  assert.ok(Math.hypot(pts[0].x - 180, pts[0].y - 470) < 1.5);
  assert.ok(pts.every(p => p.t >= LAUNCH / 30 - 1e-6), 'no pre-impact points');
  // Every point is on the ball, through the last visible frame and not beyond it.
  for (const p of pts) {
    const truth = path[Math.round(p.t * 30) - LAUNCH];
    assert.ok(truth && Math.hypot(p.x - truth.x, p.y - truth.y) < 1.5, `t=${p.t.toFixed(3)} off the ball`);
  }
  assert.ok(Math.abs(pts.at(-1).t - (LAUNCH + path.length - 1) / 30) < 1e-6, `last t=${pts.at(-1).t}`);
  assert.ok(pts.length >= path.length - 2, `n=${pts.length}`);
  assert.equal(result.observedFrames, result.points.length);
  // One physical launch: duplicate legacy ids exist, but they merge, so there is no rival launch.
  assert.ok(result.launchHypotheses.length >= 2, 'legacy produced several ids for one ball');
  assert.ok(!result.reasonCodes.includes('ambiguous_launch'), JSON.stringify(result.reasonCodes));
  // Confidence is the margin over a launch with no flight: evidence-scale, not the size prior.
  assert.equal(result.confidence, result.diagnostics.margin);
  assert.ok(result.confidence > 2.2 && result.confidence < 20, `margin ${result.confidence}`);
  assert.ok(tracker.frameLog.every(f => f.candidates.every(c => [c.x, c.y, c.quality, c.score].every(Number.isFinite))));
});

test('a v2 abstention stays an abstention even when the legacy linker has a long track', () => {
  // Practice swing, no ball: a glove leaves its spot, rises, pauses and comes back down.
  const glove = i => {
    let x = 150, y = 470;
    for (let l = 1; l <= i - 30; l++) {
      if (l <= 20) { x -= 1.2; y -= 8 * Math.max(0.35, 1 - l / 28); }
      else if (l <= 26) { x -= 0.3; y -= 0.3; }
      else if (l <= 46) { x += 1.2; y += 7.2; }
    }
    return [{ x, y, r: 3 }];
  };
  const opts = { frames: 100, ball: false, extra: glove };
  const legacy = run('legacy', opts).result;
  assert.equal(legacy.status, 'tracked');
  assert.ok(legacy.points.length >= 8, `legacy ${legacy.points.length} points: the old fallback would fire`);
  const v2 = run('v2', opts).result;
  assert.equal(v2.status, 'no_reliable_track');
  assert.deepEqual(v2.points, []);
  assert.equal(v2.diagnostics.fallback, undefined);
  assert.ok(v2.reasonCodes.includes('no_ball_evidence'), JSON.stringify(v2.reasonCodes));
});

test('v2 never appends a static speck beside the flight', () => {
  const path = flightPath({ vx: 1, vy: -7, g: 0.15, steps: 30 });
  const s = path[22];
  const { result } = run('v2', { frames: 120, path, extra: () => [{ x: s.x + 5, y: s.y, r: 2 }] });
  assert.equal(result.status, 'tracked');
  const speck = result.points.map(px).filter(p => Math.hypot(p.x - s.x - 5, p.y - s.y) < 2);
  assert.equal(speck.length, 0, `${speck.length} speck points`);
  assert.ok(result.points.at(-1).t <= (LAUNCH + path.length - 1) / 30 + 1e-6);
});

test('the sky coaster never hands a NaN candidate to linking or the v2 frame log', () => {
  // A fast low track with an odd gap in the lower frame used to give a half-pixel search window.
  for (const gap of [1, 3]) {
    const tracker = new MotionTracker(720, 1280, { engine: 'v2' });
    const points = [];
    for (let k = 6; k >= 0; k--) points.push({ x: 360 - 0.5 * k, y: 950 + 13 * k, f: 20 - k, t: (20 - k) / 30, size: 6, quality: 0.9, roundness: 1, compactness: 0.8 });
    tracker.best = { points, cost: 0, score: 50, length: 100, anchor: 40, launchId: 'L1' };
    tracker.tracks = [tracker.best];
    tracker.frame = 20 + gap;
    const rgba = new Uint8ClampedArray(720 * 1280 * 4).fill(200); // bright, flat, low-chroma ground
    tracker.detect(rgba, tracker.frame / 30);
    const logged = tracker.frameLog.at(-1).candidates;
    assert.ok(logged.every(c => [c.x, c.y, c.quality, c.score].every(Number.isFinite)), `gap ${gap}: ${JSON.stringify(logged)}`);
    assert.ok(tracker.lastCandidates.every(c => Number.isFinite(c.quality)));
  }
});

test('the coaster finds a lower-frame ball at odd gaps (integer search radius)', () => {
  for (const gap of [1, 2, 3, 5]) {
    const tracker = new MotionTracker(720, 1280);
    const points = [];
    for (let k = 7; k >= 0; k--) points.push({ x: 360 - 0.5 * k, y: 900 + 6 * k, f: 20 - k, t: (20 - k) / 30, size: 6, quality: 0.9, roundness: 1, compactness: 0.8 });
    tracker.best = { points, cost: 0, score: 50, length: 100, anchor: 40 };
    tracker.frame = 20 + gap;
    const rgba = new Uint8ClampedArray(720 * 1280 * 4);
    for (let i = 0; i < 720 * 1280; i++) rgba.set([70, 110, 70, 255], i * 4);
    const ball = { x: 360 + 0.5 * gap, y: 900 - 6 * gap };
    for (let y = Math.floor(ball.y - 3); y <= ball.y + 3; y++) for (let x = Math.floor(ball.x - 3); x <= ball.x + 3; x++) if (Math.hypot(x - ball.x, y - ball.y) <= 2.3) rgba.set([240, 240, 240, 255], (y * 720 + x) * 4);
    const gray = new Uint8Array(720 * 1280);
    for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    const found = tracker.localFlightCandidates(gray, rgba, tracker.frame / 30);
    assert.equal(found.length, 1, `gap ${gap}`);
    assert.ok(Math.hypot(found[0].x - ball.x, found[0].y - ball.y) < 1, `gap ${gap}`);
  }
});

// ---- Reselection (selectBestTrack) gates, driven through link()/updateSpots like the legacy tests. ----
function feedObjects(tracker, frames, objectsAt) {
  for (let i = 0; i < frames; i++) {
    tracker.frame = i;
    const candidates = objectsAt(i).map(o => ({ t: i / 30, f: i, quality: 0.9, roundness: 1, compactness: 0.8, ...o }));
    tracker.link(candidates.filter(p => p.moving), candidates);
    tracker.updateSpots(candidates);
  }
  return tracker.result();
}
function ballThenLateObject(objSize, rise) {
  let bx = 420, by = 900, bvy = -12, ox = 200, oy = 1000;
  return i => {
    const out = [], bl = i - 20, ol = i - 90;
    if (bl > 0) { bx += 0.6; by += bvy; bvy = Math.min(-1.2, bvy + 0.3); }
    if (bl <= 40) out.push({ x: bx, y: by, size: bl > 0 ? Math.max(4, 48 - bl * 2) : 48, moving: bl > 0, tag: 'ball' });
    if (ol > 0) { ox += 0.5; oy -= 10; }
    if (ol <= rise) out.push({ x: ox, y: oy, size: ol > 0 ? Math.max(6, objSize - ol * 3) : objSize, moving: ol > 0, tag: 'late' });
    return out;
  };
}

test('a bigger object that rises briefly late in the clip does not replace an established flight', () => {
  for (const [size, rise] of [[80, 6], [120, 6], [196, 6], [80, 10]]) {
    const r = feedObjects(new MotionTracker(720, 1280), 130, ballThenLateObject(size, rise));
    assert.ok(Math.abs(r.points[0].x * 720 - 420) < 3, `size ${size} rise ${rise}: started at x=${r.points[0].x * 720}`);
    assert.ok(r.points.length >= 40, `size ${size} rise ${rise}: ${r.points.length} points`);
  }
});

test('canSwitchTo: another launch needs an address-sized source, a clean rise and comparable evidence', () => {
  const tracker = new MotionTracker(720, 1280);
  const track = (n, { size = 48, step = [0.5, -12], jitter = 0, cost = 0.2, anchor = 40 } = {}) => {
    const points = [];
    for (let k = 0; k < n; k++) points.push({ x: 400 + step[0] * k + (k % 2 ? jitter : -jitter), y: 900 + step[1] * k, f: k, t: k / 30, size: k ? 20 : size, quality: .9, compactness: .8, roundness: 1 });
    let length = 0;
    for (let k = 1; k < n; k++) length += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
    return { points, cost: cost * n, length, anchor, sourceSize: size, sourceQuality: .9, sourceCompactness: .8 };
  };
  const incumbent = track(41, { size: 20, anchor: 20 });
  assert.equal(tracker.canSwitchTo(track(12, { size: 196, anchor: 60 }), incumbent), true, 'an established challenger may switch');
  assert.equal(tracker.canSwitchTo(track(11, { size: 196, anchor: 60 }), incumbent), false, 'a shorter stub may not');
  assert.equal(tracker.canSwitchTo(track(7, { size: 196, anchor: 60, step: [0.5, -16] }), track(8, { size: 20, anchor: 20 })), true, 'a young incumbent is not protected');
  assert.equal(tracker.canSwitchTo(track(12, { size: 12, anchor: 60 }), null), false, 'source too small');
  assert.equal(tracker.canSwitchTo(track(12, { anchor: 60, step: [0.5, -4] }), null), false, 'does not rise 6.5% of the frame');
  assert.equal(tracker.canSwitchTo(track(12, { anchor: 60, cost: 1.2 }), null), false, 'too costly a path');
  assert.equal(tracker.canSwitchTo(track(12, { anchor: 60, jitter: 9 }), null), false, 'too inefficient a path');
});

test('reselection never promotes a track from a source too small to be an address ball', () => {
  // A 9-px source rises cleanly; the old reselection output a 5-point stub of it.
  let x = 400, y = 900, vy = -12;
  const r = feedObjects(new MotionTracker(720, 1280), 70, i => {
    const l = i - 20;
    if (l > 0) { x += 0.6; y += vy; vy = Math.min(-1.2, vy + 0.3); }
    return [{ x, y, size: l > 0 ? 6 : 9, moving: l > 0 }];
  });
  assert.equal(r.points.length, 0, `${r.points.length} points from a 9-px source`);
});

test('a later real ball can still take over from an earlier wrong flight once it is established', () => {
  // A 20-px clothing highlight launches first; a 48-px ball launches 40 frames later.
  let wx = 200, wy = 900, wvy = -6, bx = 420, by = 880, bvy = -12;
  const r = feedObjects(new MotionTracker(720, 1280), 110, i => {
    const out = [], wl = i - 20, bl = i - 60;
    if (wl > 0) { wx -= 0.4; wy += wvy; wvy = Math.min(-0.8, wvy + 0.12); }
    if (wl <= 25) out.push({ x: wx, y: wy, size: wl > 0 ? Math.max(6, 20 - wl) : 20, moving: wl > 0 });
    if (bl > 0) { bx += 0.6; by += bvy; bvy = Math.min(-1, bvy + 0.35); }
    if (bl <= 18) out.push({ x: bx, y: by, size: bl > 0 ? Math.max(4, 48 - bl * 2) : 48, moving: bl > 0 });
    return out;
  });
  assert.ok(r.points.length >= 12, `${r.points.length} points`);
  assert.ok(r.points.every(p => p.x * 720 > 300), 'stayed on the earlier clothing flight');
});

test('detect() drops any malformed candidate before linking and logging', () => {
  const tracker = new MotionTracker(W, H, { engine: 'v2' });
  tracker.localFlightCandidates = () => [{ x: 200, y: 200, t: 0, f: 0, quality: NaN, size: 4, moving: true, roundness: 1, compactness: 1, local: true }];
  tracker.detect(frame([]), 0);
  assert.equal(tracker.frameLog[0].candidates.length, 0);
  assert.ok(tracker.lastCandidates.every(c => Number.isFinite(c.quality)));
});

test('reselection never promotes a flight that does not rise', () => {
  // An address-sized object leaves steeply but levels off: it never climbs 6.5% of the frame.
  let x = 400, y = 900, vy = -7;
  const r = feedObjects(new MotionTracker(720, 1280), 60, i => {
    const l = i - 20;
    if (l > 0) { x += 2; y += vy; vy = Math.min(0, vy + 1.4); }
    return [{ x, y, size: l > 0 ? 30 : 48, moving: l > 0 }];
  });
  assert.equal(r.points.length, 0, `${r.points.length} points`);
});
