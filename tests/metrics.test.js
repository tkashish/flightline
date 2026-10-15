import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateClip, observedToSourcePixels, nearestObserved, interpolateAt, cameraAt, labelPath, pathError,
  trackerFields, summarizeTotals, formatMarkdownReport
} from './lib/metrics.mjs';

const META = { width: 1080, height: 1920, analysisWidth: 720, analysisHeight: 1280 };
const META_4K = { width: 2160, height: 3840, analysisWidth: 720, analysisHeight: 1280 };
const T0 = 1.5;
// Straight flight from the address ball: 100 px/s right, 500 px/s up; visible until 3.0 s.
const ball = (t, s = 1) => (t <= T0 ? { x: 540 * s, y: 1500 * s } : { x: (540 + 100 * (t - T0)) * s, y: (1500 - 500 * (t - T0)) * s });
const grid = (from, to, per = 30) => {
  const out = [];
  for (let i = Math.round(from * per); i <= Math.round(to * per); i++) out.push(i / per);
  return out;
};
const track = (from = T0, to = 3, f = ball) => grid(from, to).map(t => ({ t, ...f(t) }));
const labels = (from = T0, to = 3, f = ball) => grid(from, to, 10).map(t => ({ t, status: 'visible', ...f(t) }));
const shot = (extra = {}) => ({ impactT: T0, addressBall: { t: T0, x: 540, y: 1500 }, frames: labels(), ...extra });
const mkRun = (points, result = {}, meta = META) => ({
  engine: 'v2', meta, elapsedMs: 1, frameCount: 90, competingTracks: [],
  result: {
    status: 'tracked', camera: [], ...result,
    points: points.map(p => ({ t: p.t, x: p.x / meta.width, y: p.y / meta.height, ...(p.status ? { status: p.status } : {}) }))
  }
});
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('observedToSourcePixels undoes normalization with camera offset and keeps predicted status', () => {
  const points = [{ t: 1, x: 0.5, y: 0.25 }, { t: 1, x: 0.5, y: 0.25, status: 'predicted' }];
  const camera = [{ t: 1, x: 0.1, y: -0.05 }];
  const src = observedToSourcePixels(points, camera, 100, 200, 1000, 2000);
  near(src[0].x, 600); near(src[0].y, 400);
  assert.deepEqual(src.map(p => p.status), ['observed', 'predicted']);
});

test('cameraAt interpolates between samples and clamps at both ends', () => {
  const camera = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: -0.2 }];
  near(cameraAt(camera, 0.5).x, 0.05); near(cameraAt(camera, 0.5).y, -0.1);
  assert.deepEqual(cameraAt(camera, -1), { x: 0, y: 0 });
  near(cameraAt(camera, 2).x, 0.1); near(cameraAt(camera, 2).y, -0.2);
});

test('interpolateAt is linear between bracketing samples and never extrapolates', () => {
  const pts = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 20 }, { t: 3, x: 30, y: 20 }];
  assert.deepEqual(interpolateAt(pts, 0.5), { t: 0.5, x: 5, y: 10 });
  assert.deepEqual(interpolateAt(pts, 2), { t: 2, x: 20, y: 20 });
  assert.deepEqual(interpolateAt(pts, 3), { t: 3, x: 30, y: 20 });
  assert.equal(interpolateAt(pts, -0.01), null);
  assert.equal(interpolateAt(pts, 3.01), null);
  assert.equal(interpolateAt([], 1), null);
});

test('nearestObserved respects time window', () => {
  const pts = [{ t: 1.0, x: 1, y: 1 }, { t: 1.2, x: 2, y: 2 }];
  assert.equal(nearestObserved(pts, 1.05, 0.1).t, 1.0);
  assert.equal(nearestObserved(pts, 1.5, 0.1), null);
});

test('a clean track passes and reports every metric', () => {
  const m = evaluateClip(mkRun(track()), shot({ lastVisibleT: 3 }));
  assert.equal(m.status, 'pass');
  assert.deepEqual(m.failReasons, []);
  assert.equal(m.shotSuccess, true);
  assert.equal(m.flightRecall, 1);
  assert.equal(m.offPathPoints, 0);
  assert.equal(m.pathCheckedPoints, 46);
  near(m.impactTimingErrorSec, 0); near(m.launchAnchorErrorPx, 0); near(m.overshootSec, 0);
  near(m.trackTolerancePx, 0.02 * 1920);
  assert.deepEqual(m.gates, { tracked: true, impactTiming: true, earlyStart: true, launchAnchor: true, onPath: true, recall: true, termination: true });
});

test('recall interpolates the track at each label time instead of taking the nearest sample', () => {
  // Labels halfway between samples: the nearest sample is ~8.5 px away, the interpolated track 0 px.
  const frames = grid(T0, 2.9).map(t => ({ t: t + 1 / 60, status: 'visible', ...ball(t + 1 / 60) }));
  const m = evaluateClip(mkRun(track()), { frames });
  assert.equal(m.visibleRecall['5'], 1);
  assert.ok(m.maxPathErrorPx < 1e-6);
});

test('labels outside the track span are misses: no extrapolation', () => {
  const m = evaluateClip(mkRun(track(T0, 2.2)), { frames: labels() });
  assert.equal(m.flightRecall, 0.5);
  assert.equal(m.visibleRecall['20'], 0.5);
});

test('recall interpolates only across short gaps: a few sparse points cover only their own labels', () => {
  // Curved flight: the chord between far-apart samples stays near the arc for a while.
  const arc = t => ({ x: 540 + 112.5 * (t - T0), y: 1500 - 675 * (t - T0) + 202.5 * (t - T0) ** 2 });
  const frames = labels(T0 + 0.1, 3, arc), sparse = ts => evaluateClip(mkRun(ts.map(t => ({ t, ...arc(t) }))), shot({ frames }));
  // Launch plus one mid-flight point, or launch, middle and end: only labels at those sample times count.
  for (const [ts, hits] of [[[T0, 2.2], 1], [[T0, 2.2, 3], 2]]) {
    const m = sparse(ts);
    assert.deepEqual(m.failReasons, ['low_recall'], `${ts}`);
    near(m.flightRecall, hits / 15);
    assert.equal(m.offPathPoints, 0);
  }
  near(interpolateAt([{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }], 0.5, 1).x, 5);
  assert.equal(interpolateAt([{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }], 0.5, 0.9), null);
  near(interpolateAt([{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }], 1, 0.9).x, 10);
  // A track that misses two samples (a 0.1 s gap) still covers the label inside it; a 0.2 s gap does not.
  const gapped = (from, to) => mkRun(track().filter(p => p.t <= from / 30 + 1e-9 || p.t >= to / 30 - 1e-9));
  assert.equal(evaluateClip(gapped(59, 62), shot()).flightRecall, 1);
  near(evaluateClip(gapped(59, 65), shot()).flightRecall, 14 / 16);
  assert.equal(evaluateClip(gapped(59, 65), shot({ maxGapSec: 0.2 })).flightRecall, 1);
});

test('recall ignores labels of the ball at address before impactT', () => {
  const frames = [...labels(0.5, 1.4), ...labels()];
  assert.equal(evaluateClip(mkRun(track()), shot({ frames })).flightRecall, 1);
  near(evaluateClip(mkRun(track()), { frames }).flightRecall, 16 / 26);
});

test('the on-path radius is 2% of the source long edge at any resolution', () => {
  for (const [meta, s] of [[META, 1], [META_4K, 2]]) {
    const L = Math.max(meta.width, meta.height);
    const f = t => ball(t, s);
    const frames = labels(T0, 3, f);
    // Offset only the samples between label times, so recall is untouched.
    const offset = frac => grid(T0, 3).map((t, i) => ({ t, ...f(t), x: f(t).x + (i % 3 ? frac * L : 0) }));
    const ok = evaluateClip(mkRun(offset(0.019), {}, meta), { frames });
    const bad = evaluateClip(mkRun(offset(0.021), {}, meta), { frames });
    assert.equal(ok.status, 'pass', `${L}: 1.9%`);
    assert.equal(bad.status, 'fail', `${L}: 2.1%`);
    assert.deepEqual(bad.failReasons, ['off_labeled_path']);
    assert.equal(bad.flightRecall, 1);
    assert.equal(evaluateClip(mkRun(offset(0.021), {}, meta), { frames, maxTrackErrorPx: 0.03 * L }).status, 'pass');
    // Recall uses the same radius.
    const shifted = d => evaluateClip(mkRun(grid(T0, 3).map(t => ({ t, ...f(t), x: f(t).x + d * L })), {}, meta), { frames }).flightRecall;
    assert.equal(shifted(0.019), 1);
    assert.equal(shifted(0.021), 0);
  }
});

test('a track that leaves the labeled flight fails even when launch and recall pass', () => {
  const jumped = track().map(p => (p.t > 2.5 ? { ...p, x: p.x + 150 } : p));
  const m = evaluateClip(mkRun(jumped), shot());
  assert.equal(m.status, 'fail');
  assert.deepEqual(m.failReasons, ['off_labeled_path']);
  near(m.flightRecall, 11 / 16);
  assert.equal(m.offPathPoints, 15);
  assert.equal(m.gates.launchAnchor, true);
  assert.equal(m.gates.impactTiming, true);
});

test('a single observed point off the label path fails the clip', () => {
  // One glitch between two labels: recall, launch and run-on all still pass.
  const glitch = track().map(p => (Math.abs(p.t - 2.0333) < 1e-3 ? { ...p, x: p.x + 100 } : p));
  const m = evaluateClip(mkRun(glitch), shot());
  assert.deepEqual(m.failReasons, ['off_labeled_path']);
  assert.equal(m.offPathPoints, 1);
  assert.equal(m.flightRecall, 1);
  near(m.observedPrecision, 45 / 46);
});

test('past the last label the track must continue the labeled flight; later unlabeled points cannot pass', () => {
  // Labels stop at 2.0 s although lastVisibleT says the ball was visible until 2.8 s.
  const frames = labels(T0, 2);
  // The ball until switchT, then another object far away.
  const run = (switchT, to = 2.8) => mkRun(track(T0, to, t => (t > switchT + 1e-9 ? { x: 100, y: 200 } : ball(t))));
  // A jump onto another object right after the last label is an off-path switch, whatever follows.
  const steal = evaluateClip(run(2.0, 2.9), shot({ frames, lastVisibleT: 2.8 }));
  assert.deepEqual(steal.failReasons, ['off_labeled_path']);
  assert.equal(steal.offPathPoints, 3);
  assert.equal(steal.pathCheckedPoints, 19);
  // Within the margin the track is checked along the last label segment, extended: the true ball passes.
  const along = evaluateClip(run(9, 2.1), shot({ frames, lastVisibleT: 2.1 }));
  assert.equal(along.status, 'pass');
  assert.equal(along.pathCheckedPoints, 19);
  assert.equal(along.unlabeledPoints, 0);
  // Later points no label covers make the clip undecidable, whether they follow the ball or not.
  for (const switchT of [9, 2.4]) {
    const m = evaluateClip(run(switchT), shot({ frames, lastVisibleT: 2.8 }));
    assert.equal(m.status, 'unknown_ground_truth', `switch at ${switchT}`);
    assert.deepEqual(m.failReasons, []);
    assert.equal(m.unlabeledPoints, 21);
    assert.ok(m.notes.some(n => /21 observed points come after the last visible label/.test(n)), m.notes.join());
  }
  // Labeling the flight through lastVisibleT decides it.
  assert.equal(evaluateClip(run(9), shot({ frames: labels(T0, 2.8), lastVisibleT: 2.8 })).status, 'pass');
  assert.deepEqual(evaluateClip(run(2.4), shot({ frames: labels(T0, 2.8), lastVisibleT: 2.8 })).failReasons, ['off_labeled_path']);
});

test('points outside the labeled visible window are not path-checked', () => {
  const early = grid(1, 1.4667).map(t => ({ t, x: 300, y: 1000 }));
  const m = evaluateClip(mkRun([...early, ...track()]), { frames: labels() });
  assert.equal(m.status, 'pass');
  assert.equal(m.pathCheckedPoints, 46);
  assert.equal(m.offPathPoints, 0);
});

test('the label path starts the flight at the address ball at impact', () => {
  // Sparse labels: one at address long before impact, then 0.5 s apart in flight. The track sits on the address
  // ball from 1.2 s (early start allowed here): the pre-impact label does not bend the flight path.
  const frames = [{ t: 1, status: 'visible', ...ball(1) }, ...[2, 2.5, 3].map(t => ({ t, status: 'visible', ...ball(t) }))];
  const anchored = evaluateClip(mkRun(track(1.2, 3)), shot({ frames, maxEarlyStartSec: 0.3 }));
  assert.equal(anchored.status, 'pass');
  assert.ok(anchored.maxPathErrorPx < 1e-6);
  assert.equal(anchored.flightRecall, 1);
  // Flight labels from 2 s only: the anchor makes the track between impact and the first flight label count.
  // Here it leaves the address sideways (a club) and joins the ball at the first label.
  const club = mkRun([...grid(T0, 1.9667).map(t => ({ t, x: 540 - 600 * (t - T0), y: 1500 })), ...track(2, 3)]);
  const late = frames.slice(1);
  const checked = evaluateClip(club, shot({ frames: late }));
  assert.deepEqual(checked.failReasons, ['off_labeled_path']);
  assert.equal(checked.offPathPoints, 12, 'the first two club points are still within 38.4 px of the address');
  assert.equal(evaluateClip(club, { frames: late }).status, 'pass', 'without impactT and addressBall nothing labels 1.5-2 s');
});

test('sparse labels: a perfectly tracked flight passes however far apart its labels are', () => {
  // Phase-1 regression (verify-3 i2-sparse): the chord between labels 1.6 s apart is 130 px off this parabola.
  const T = 44 / 30, arc = t => { const u = Math.max(0, t - T); return { x: 540 + 112.5 * u, y: 1500 - 675 * u + 202.5 * u * u }; };
  const perfect = grid(T, 97 / 30).map(t => ({ t, ...arc(t) }));
  const at = fs => fs.map(f => ({ t: f / 30, status: 'visible', ...arc(f / 30) }));
  const ann = fs => ({ impactT: T, addressBall: { t: T, x: 540, y: 1500 }, frames: at(fs), lastVisibleT: fs.at(-1) / 30 });
  for (const step of [3, 10, 20, 30, 40, 52]) {
    const fs = []; for (let f = 45; f <= 97; f += step) fs.push(f);
    const m = evaluateClip(mkRun(perfect.filter(p => p.t <= fs.at(-1) / 30 + 1e-9)), ann(fs));
    assert.equal(m.status, 'pass', `labels every ${step} frames: ${m.failReasons} ${m.maxPathErrorPx}`);
  }
  // tests/fixtures/manifest.example.json spacing: +0.033, +0.167 and +1.767 s.
  const example = evaluateClip(mkRun(perfect), ann([45, 49, 97]));
  assert.equal(example.status, 'pass');
  assert.equal(example.pathCheckedPoints, 54);
  // A down-the-line launch decelerates several-fold in its first frames (s = v·u / (1 + c·u), fitted to a generator
  // clip: 119, 81, 58, 44 px per frame): with labels 0.33 s apart the time-aligned chord is over 4% of the long edge
  // off; the path itself stays within reach.
  const dtl = t => { const u = Math.max(0, t - T), s = 4400 * u / (1 + 7 * u); return { x: 540 + 0.1 * s + 20 * u * u, y: 1500 - s }; };
  const lab = [45, 55, 65, 75].map(f => ({ t: f / 30, status: 'visible', ...dtl(f / 30) }));
  const chordErr = grid(45 / 30, 75 / 30).map(t => { const i = Math.min(2, Math.floor((t * 30 - 45) / 10)), a = lab[i], b = lab[i + 1], u = (t - a.t) / (b.t - a.t);
    return Math.hypot(a.x + (b.x - a.x) * u - dtl(t).x, a.y + (b.y - a.y) * u - dtl(t).y); });
  assert.ok(Math.max(...chordErr) > 0.04 * 1920, `the time-aligned chord would fail it: ${Math.max(...chordErr)}`);
  const m = evaluateClip(mkRun(grid(T, 75 / 30).map(t => ({ t, ...dtl(t) }))), { impactT: T, addressBall: { t: T, x: 540, y: 1500 }, frames: lab, lastVisibleT: 2.5 });
  assert.equal(m.status, 'pass', `${m.failReasons} ${m.maxPathErrorPx}`);
  assert.ok(m.maxPathErrorPx < 1);
});

test('label path: at a label the label, between labels anywhere along the curve, across it within the bend allowance', () => {
  const path = labelPath([{ t: 0, x: 0, y: 0 }, { t: 1, x: 100, y: 0 }, { t: 2, x: 200, y: 0 }, { t: 3, x: 300, y: 0 }]);
  // At a label time the point must be at the label; between labels its progress along the path is free.
  near(pathError(path, { t: 1, x: 130, y: 0 }), 30);
  for (const x of [101, 150, 199]) near(pathError(path, { t: 1.5, x, y: 0 }), 0);
  near(pathError(path, { t: 1.5, x: 150, y: 20 }), 20);
  near(pathError(path, { t: 1.5, x: 250, y: 0 }), 50, 1e-9);
  // The bend allowance curvature·(t − ta)(tb − t)/2 is largest mid-gap and zero at the labels.
  near(pathError(path, { t: 1.5, x: 150, y: 20 }, { curvature: 40 }), 15);
  near(pathError(path, { t: 1.1, x: 150, y: 20 }, { curvature: 40 }), 20 - 40 * 0.1 * 0.9 / 2);
  near(pathError(path, { t: 1.5, x: 150, y: 4 }, { curvature: 40 }), 0);
  // Past the last label: forward along the end tangent at up to twice the last speed (100 px/s here), else off.
  assert.equal(pathError(path, { t: 3.1, x: 310, y: 0 }), null, 'outside [first, last + ext]');
  near(pathError(path, { t: 3.1, x: 315, y: 0 }, { ext: 0.1 }), 0);
  near(pathError(path, { t: 3.1, x: 330, y: 0 }, { ext: 0.1 }), 10, 1e-9);
  near(pathError(path, { t: 3.1, x: 290, y: 0 }, { ext: 0.1 }), 10, 1e-9);
  near(pathError(path, { t: 3.1, x: 300, y: 12 }, { ext: 0.1 }), 12);
  // A smooth curve, not a chord: labels on a circle of radius 500 keep the arc between them within 0.05 px (1.7 px
  // for the chord); the end pieces, with mirrored neighbours, still halve the chord's gap.
  const circle = Array.from({ length: 7 }, (_, i) => ({ t: i, x: 500 * Math.cos(i / 6), y: 500 * Math.sin(i / 6) }));
  const curved = labelPath(circle), chordGap = 500 * (1 - Math.cos(1 / 12)), mid = i => ({ t: i + 0.5, x: 500 * Math.cos((i + 0.5) / 6), y: 500 * Math.sin((i + 0.5) / 6) });
  for (let i = 1; i < 5; i++) assert.ok(pathError(curved, mid(i)) < 0.05, `piece ${i}`);
  for (const i of [0, 5]) assert.ok(pathError(curved, mid(i)) < 0.55 * chordGap, `end piece ${i}`);
  // No smoothing across impactT: an address label a few px off (labeling noise) leaves the straight launch straight.
  const kinked = { t: 0.5, x: -8, y: 4 }, launch = [{ t: 1, x: 0, y: 0 }, { t: 1.2, x: 30, y: -100 }, { t: 1.4, x: 60, y: -200 }];
  const onLaunch = path => Math.max(...[1.05, 1.1, 1.15].map(t => pathError(path, { t, x: 150 * (t - 1), y: -500 * (t - 1) })));
  assert.ok(onLaunch(labelPath([kinked, ...launch], { impactT: 1 })) < 1e-9);
  assert.ok(onLaunch(labelPath([kinked, ...launch])) > 1, 'smoothed across impact, the launch would bend');
  near(pathError(labelPath([kinked, ...launch], { impactT: 1 }), { t: 0.7, x: -4, y: 2 }), 0, 1e-9);
});

test('earlier pass/fail verdicts hold: the phase-1 verifiers\' fail cases still fail for the same reasons', () => {
  // passfail-semantics, passfail-extra and i2-variants (phase1-verify-1..3): a parabola labeled every frame.
  const T = 44 / 30, arc = t => { const u = Math.max(0, t - T); return { x: 540 + 112.5 * u, y: 1500 - 675 * u + 202.5 * u * u }; };
  const frames = (a, b, step = 1) => { const o = []; for (let f = a; f <= b; f += step) o.push({ t: f / 30, status: 'visible', ...arc(f / 30) }); return o; };
  const trk = (a, b, f = arc) => { const o = []; for (let k = a; k <= b; k++) o.push({ t: k / 30, ...f(k / 30) }); return o; };
  const full = { impactT: T, addressBall: { t: T, x: 540, y: 1500 }, frames: frames(45, 84), lastVisibleT: 84 / 30 };
  const wander = [...trk(44, 46), ...trk(47, 84, t => ({ x: 300 + (t * 30 - 47) * 2, y: 900 + (t * 30 - 47) * 1.5 }))];
  const far = (a, b, p = { x: 100, y: 200 }) => trk(a, b, () => p);
  const zig = trk(44, 84, t => { const p = arc(t), f = Math.round(t * 30); return (f - 45) % 10 ? { x: p.x + 150, y: p.y } : p; });
  const cases = [
    ['right launch, then a wrong object', wander, full, ['off_labeled_path', 'low_recall']],
    ['... and 3.2 s past lastVisibleT', [...wander, ...trk(85, 180, t => ({ x: 380 + 30 * t, y: 950 - 30 * t }))], full, ['off_labeled_path', 'low_recall', 'run_on']],
    ['address frames labeled visible, no impactT', trk(44, 84), { frames: [...Array.from({ length: 44 }, (_, f) => ({ t: f / 30, status: 'visible', x: 540, y: 1500 })), ...frames(45, 84)] }, ['low_recall']],
    ['0.2 s stationary early start', [...trk(38, 43, () => ({ x: 540, y: 1500 })), ...trk(44, 84)], full, ['early_start']],
    ['labels to 2.0 s, lastVisibleT 2.8 s, wrong object after', [...trk(44, 60), ...far(61, 84, { x: 200, y: 460 })], { ...full, frames: frames(45, 60) }, ['off_labeled_path']],
    ['labels every 10th frame, 150 px off between them', zig, { ...full, frames: frames(45, 84, 10) }, ['launch_anchor', 'off_labeled_path']],
    ['3 observed points: launch, middle, end', [44, 64, 84].map(f => ({ t: f / 30, ...arc(f / 30) })), full, ['low_recall']],
    ['perfect, then 3 points on a far object inside the margin', [...trk(44, 84), ...far(85, 87)], full, ['off_labeled_path']],
    ['an extra far point at a labeled time', [...trk(44, 84), { t: 2, x: 100, y: 100 }].sort((a, b) => a.t - b.t), full, ['off_labeled_path']],
    ['labels end in not_visible, the track goes on elsewhere', [...trk(44, 60), ...far(61, 84, { x: 100, y: 100 })], { ...full, frames: [...frames(45, 60), { t: 61 / 30, status: 'not_visible' }], lastVisibleT: undefined }, ['off_labeled_path', 'run_on']],
    ['occluded 1.8-2.2 s, the track on a far object there', trk(44, 84, t => (t > 1.8 && t < 2.2 ? { x: 100, y: 100 } : arc(t))), { ...full, frames: full.frames.map(f => (f.t > 1.8 && f.t < 2.2 ? { t: f.t, status: 'occluded' } : f)) }, ['off_labeled_path']],
    ['identity steal mid-flight, +80 px', [...trk(44, 63), ...trk(64, 84, t => ({ x: arc(t).x + 80, y: arc(t).y }))], full, ['off_labeled_path', 'low_recall']],
    ['40% observed, wrong predicted arc', [...trk(44, 60), ...trk(61, 84, () => ({ x: 900, y: 300 })).map(p => ({ ...p, status: 'predicted' }))], full, ['low_recall']],
    ['perfect track', trk(44, 84), full, []],
    ['perfect track, frames only', trk(44, 84), { frames: full.frames }, []],
    ['half the flight, frames only', trk(44, 64), { frames: full.frames }, []],
    ['perfect + 3 s of predicted run-on', [...trk(44, 84), ...trk(85, 180, () => ({ x: 900, y: 300 })).map(p => ({ ...p, status: 'predicted' }))], full, []]
  ];
  for (const [label, points, annotation, reasons] of cases) {
    const m = evaluateClip(mkRun(points), annotation);
    assert.deepEqual(m.failReasons, reasons, label);
    assert.equal(m.status, reasons.length ? 'fail' : 'pass', label);
  }
});

test('flight recall must reach minRecall (default 0.5)', () => {
  assert.equal(evaluateClip(mkRun(track(T0, 2.2)), shot()).status, 'pass');
  const short = evaluateClip(mkRun(track(T0, 2.1)), shot());
  assert.equal(short.status, 'fail');
  assert.deepEqual(short.failReasons, ['low_recall']);
  near(short.flightRecall, 7 / 16);
  assert.equal(evaluateClip(mkRun(track(T0, 2.1)), shot({ minRecall: 0.4 })).status, 'pass');
});

test('observed points more than 0.1 s past the last visible label are a run-on', () => {
  const runOn = evaluateClip(mkRun(track(T0, 3.1333)), shot());
  assert.equal(runOn.status, 'fail');
  assert.deepEqual(runOn.failReasons, ['run_on']);
  near(runOn.overshootSec, 0.1333, 1e-3);
  assert.equal(evaluateClip(mkRun(track(T0, 3.0667)), shot()).status, 'pass');
  assert.equal(evaluateClip(mkRun(track(T0, 3.1333)), shot({ maxOvershootSec: 0.2 })).status, 'pass');
  // A later lastVisibleT is no run-on, but the point past the label margin has no label to check it.
  const later = evaluateClip(mkRun(track(T0, 3.1333)), shot({ lastVisibleT: 3.1 }));
  assert.deepEqual([later.status, later.failReasons, later.unlabeledPoints], ['unknown_ground_truth', [], 1]);
  assert.equal(evaluateClip(mkRun(track(T0, 3.1333)), shot({ lastVisibleT: 3.1, frames: [...labels(), { t: 3.1333, status: 'visible', ...ball(3.1333) }] })).status, 'pass');
  // An earlier lastVisibleT never cuts the labeled flight short.
  const earlier = evaluateClip(mkRun(track()), shot({ lastVisibleT: 2.5 }));
  assert.equal(earlier.status, 'pass');
  near(earlier.overshootSec, 0);
  // lastVisibleT alone bounds the track when no frame is labeled.
  const bounded = evaluateClip(mkRun(track(T0, 3.1333)), { impactT: T0, lastVisibleT: 3 });
  assert.deepEqual(bounded.failReasons, ['run_on']);
});

test('predicted points get no recall credit and no run-on, only an arc-completion error', () => {
  const observed = track(T0, 2);
  const predicted = grid(2.0334, 3.5).map(t => ({ t, ...ball(t), x: ball(t).x + 12, status: 'predicted' }));
  const m = evaluateClip(mkRun([...observed, ...predicted]), shot());
  assert.equal(m.observedFrames, 16);
  assert.equal(m.predictedFrames, 45);
  near(m.lastT, 2);
  near(m.flightRecall, 6 / 16);
  assert.deepEqual(m.failReasons, ['low_recall']);
  assert.equal(m.trackTerminationOk, true);
  assert.equal(m.arcCompletion.predicted, 45);
  assert.equal(m.arcCompletion.scored, 30);
  // 12 px at the label times; between labels only the part across the path counts (12·cos 11.3°, less the bend allowance).
  near(m.arcCompletion.maxErrorPx, 12, 1e-6);
  assert.ok(m.arcCompletion.meanErrorPx > 11 && m.arcCompletion.meanErrorPx < 12, `${m.arcCompletion.meanErrorPx}`);
  assert.equal(evaluateClip(mkRun([...observed, ...predicted]), shot({ minRecall: 0.3 })).status, 'pass');
  assert.equal(evaluateClip(mkRun(track()), shot()).arcCompletion, null);
});

test('impact timing: a late start passes at 0.34 s and fails at 0.36 s by default', () => {
  // Launch and recall overrides isolate the timing gate.
  const late = d => evaluateClip(mkRun([{ t: T0 + d, ...ball(T0 + d) }, ...track(T0 + 0.4)]), shot({ minRecall: 0, maxLaunchErrorPx: 1e4 }));
  assert.equal(late(0.34).status, 'pass');
  const m = late(0.36);
  assert.deepEqual(m.failReasons, ['impact_timing']);
  near(m.impactTimingErrorSec, 0.36);
  near(m.impactOffsetSec, 0.36);
  near(evaluateClip(mkRun(track(1.6)), shot({ minRecall: 0 })).impactOffsetSec, 0.1);
  assert.equal(evaluateClip(mkRun([{ t: T0 + 0.36, ...ball(T0 + 0.36) }, ...track(T0 + 0.4)]), shot({ minRecall: 0, maxLaunchErrorPx: 1e4, maxImpactErrorSec: 0.4 })).status, 'pass');
});

test('a track that starts before impact fails beyond maxEarlyStartSec (0.1 s by default)', () => {
  // v2 seeds beams up to 0.2 s early: stationary points on the address ball, then a perfect flight.
  const early = d => mkRun([...grid(T0 - d, T0 - 1 / 30).map(t => ({ t, x: 540, y: 1500 })), ...track()]);
  assert.equal(evaluateClip(early(0.1), shot()).status, 'pass');
  for (const d of [0.2, 1 / 3]) {
    const m = evaluateClip(early(d), shot());
    assert.equal(m.status, 'fail', `${d}`);
    assert.deepEqual(m.failReasons, ['early_start']);
    near(m.impactOffsetSec, -d);
    // The symmetric 0.35 s timing gate alone would pass it.
    assert.equal(m.gates.impactTiming, true);
  }
  assert.equal(evaluateClip(early(0.2), shot({ maxEarlyStartSec: 0.25 })).status, 'pass');
  assert.deepEqual(evaluateClip(mkRun([{ t: T0 - 0.36, x: 540, y: 1500 }, ...track()]), shot()).failReasons, ['impact_timing', 'early_start']);
});

test('launch checks alone can fail a clip but never pass it', () => {
  const launchOnly = { impactT: T0, addressBall: { t: T0, x: 540, y: 1500 } };
  // The right launch, then the track wanders off onto another object.
  const wander = to => [...track(T0, 1.6), ...grid(1.6334, to).map((t, i) => ({ t, x: 300 + 2 * i, y: 900 + i }))];
  for (const [label, run, ann] of [['impact + address', wander(3), launchOnly], ['+ lastVisibleT', wander(3), { ...launchOnly, lastVisibleT: 3 }]]) {
    const m = evaluateClip(mkRun(run), ann);
    assert.equal(m.status, 'unknown_ground_truth', label);
    assert.equal(m.shotSuccess, null, label);
    assert.deepEqual(m.failReasons, [], label);
    assert.ok(m.notes.some(n => /no visible flight label/.test(n)), label);
  }
  // A run-on past lastVisibleT, a wrong launch or an early start still fail without flight labels.
  assert.deepEqual(evaluateClip(mkRun(wander(6)), { ...launchOnly, lastVisibleT: 3 }).failReasons, ['run_on']);
  assert.deepEqual(evaluateClip(mkRun(track()), { ...launchOnly, addressBall: { t: T0, x: 700, y: 1500 } }).failReasons, ['launch_anchor']);
  assert.deepEqual(evaluateClip(mkRun([{ t: T0 - 0.2, x: 540, y: 1500 }, ...track()]), launchOnly).failReasons, ['early_start']);
  // With the flight labeled, the same wandering track fails.
  const labeled = evaluateClip(mkRun(wander(3)), shot());
  assert.equal(labeled.status, 'fail');
  assert.ok(labeled.failReasons.includes('off_labeled_path') && labeled.failReasons.includes('low_recall'), labeled.failReasons.join());
});

test('launch anchor uses the track at addressBall.t and allows 60 px by default', () => {
  const at = x => shot({ addressBall: { t: T0, x, y: 1500 } });
  assert.equal(evaluateClip(mkRun(track()), at(540 + 59)).status, 'pass');
  const off = evaluateClip(mkRun(track()), at(540 + 61));
  assert.deepEqual(off.failReasons, ['launch_anchor']);
  near(off.launchAnchorErrorPx, 61);
  assert.equal(evaluateClip(mkRun(track()), shot({ addressBall: { t: T0, x: 601, y: 1500 }, maxLaunchErrorPx: 70 })).status, 'pass');
  // A stray first point does not matter when the track covers addressBall.t ...
  const stray = mkRun([{ t: 1.3, x: 440, y: 1500 }, { t: 1.4, x: 540, y: 1500 }, ...track()]);
  near(evaluateClip(stray, shot()).launchAnchorErrorPx, 0);
  // ... but it is the launch when addressBall.t precedes the track (its early start allowed here).
  const before = evaluateClip(stray, shot({ addressBall: { t: 1, x: 540, y: 1500 }, maxEarlyStartSec: 0.25 }));
  near(before.launchAnchorErrorPx, 100);
  assert.deepEqual(before.failReasons, ['launch_anchor']);
});

test('a track that visits a labeled distractor away from the ball fails', () => {
  const run = mkRun([...grid(1, 1.4).map(t => ({ t, x: 300, y: 1400 })), ...track()]);
  const at = (t, x) => evaluateClip(run, { frames: labels(), distractors: [{ label: 'golfer', t, x, y: 1400 }] });
  // Between samples, 20 px from the track: within the 38.4 px radius.
  const hit = at(1.25, 320);
  assert.equal(hit.identitySwitch, true);
  assert.deepEqual(hit.failReasons, ['distractor_switch']);
  assert.equal(at(1.25, 345).identitySwitch, false);
  // The nearest track point may be up to 0.25 s from the distractor label.
  assert.equal(at(0.8, 300).identitySwitch, true);
  assert.equal(at(0.7, 300).identitySwitch, false);
  const onBall = evaluateClip(run, { frames: labels(), distractors: [{ label: 'glint', t: 2, x: ball(2).x + 5, y: ball(2).y }] });
  assert.equal(onBall.identitySwitch, false);
  assert.equal(onBall.status, 'pass');
  const far = evaluateClip(run, { frames: labels(), distractors: [{ label: 'plane', t: 2, x: 100, y: 100 }] });
  assert.equal(far.identitySwitch, false);
});

test('expected abstention passes only when the engine abstains', () => {
  const abstain = { expectAbstention: true };
  const none = evaluateClip(mkRun([], { status: 'no_reliable_track' }), abstain);
  assert.equal(none.status, 'pass');
  assert.equal(none.abstention, 'true_abstention');
  assert.equal(evaluateClip(mkRun(track(T0, T0)), abstain).status, 'pass');
  const traced = evaluateClip(mkRun(track(T0, 1.5334)), abstain);
  assert.equal(traced.status, 'fail');
  assert.deepEqual(traced.failReasons, ['false_trace']);
  assert.equal(traced.falseTrace, true);
  assert.equal(evaluateClip(mkRun(track(T0, 1.7), { status: 'no_reliable_track' }), abstain).status, 'pass');
  assert.deepEqual(evaluateClip(mkRun(track()), { ballVisible: false }).failReasons, ['false_trace']);
});

test('an engine that abstains on a ball-visible annotation fails', () => {
  const missed = evaluateClip(mkRun([], { status: 'no_reliable_track' }), { impactT: T0, addressBall: { t: T0, x: 540, y: 1500 } });
  assert.equal(missed.status, 'fail');
  assert.deepEqual(missed.failReasons, ['missed_visible_ball']);
  assert.equal(missed.abstained, true);
  const refused = evaluateClip(mkRun(track(), { status: 'no_reliable_track' }), { frames: labels() });
  assert.deepEqual(refused.failReasons, ['missed_visible_ball']);
  const visibleNoXY = evaluateClip(mkRun([]), { frames: [{ t: 2, status: 'visible' }] });
  assert.deepEqual(visibleNoXY.failReasons, ['missed_visible_ball']);
});

test('firstNorm and lastNorm come from observed points, not predicted ones', () => {
  const pre = { t: 1.4, x: 100, y: 100, status: 'predicted' };
  const predicted = grid(2.0334, 2.5).map(t => ({ t, ...ball(t), x: ball(t).x + 40, status: 'predicted' }));
  const m = evaluateClip(mkRun([pre, ...track(T0, 2), ...predicted]), null);
  near(m.firstNorm.x, 540 / 1080); near(m.firstNorm.y, 1500 / 1920);
  near(m.lastNorm.x, ball(2).x / 1080); near(m.lastNorm.y, ball(2).y / 1920);
  near(m.firstT, T0); near(m.lastT, 2);
});

test('without decidable labels the verdict is unknown_ground_truth', () => {
  assert.equal(evaluateClip(mkRun(track()), null).status, 'unknown_ground_truth');
  const notVisible = { frames: [{ t: 2, status: 'not_visible' }] };
  const tracked = evaluateClip(mkRun(track()), notVisible);
  assert.equal(tracked.status, 'unknown_ground_truth');
  assert.equal(tracked.shotSuccess, null);
  assert.equal(evaluateClip(mkRun([], { status: 'no_reliable_track' }), notVisible).status, 'unknown_ground_truth');
});

test('tracker fields record status, reasons, confidence, vsRunner, engine and the legacy-link fallback', () => {
  const fallback = trackerFields({
    engine: 'global-v2', status: 'tracked', confidence: 1.2, reasonCodes: ['no_ball_evidence'],
    points: [], diagnostics: { fallback: 'legacy-link', assocStatus: 'no_reliable_track', assocFrames: 0, margin: 0.9, vsRunner: 0.4 }
  });
  assert.deepEqual({ ...fallback, ui: undefined }, {
    resultEngine: 'global-v2', trackStatus: 'tracked', reasonCodes: ['no_ball_evidence'], confidence: 1.2, vsRunner: 0.4,
    fallback: true, fallbackKind: 'legacy-link', assocStatus: 'no_reliable_track', assocFrames: 0, ui: undefined
  });
  const v2 = trackerFields({ engine: 'global-v2', status: 'partial', confidence: 3, vsRunner: 1, reasonCodes: [], points: [], diagnostics: { margin: 3, vsRunner: 1 } });
  assert.equal(v2.fallback, false);
  assert.equal(v2.fallbackKind, null);
  assert.equal(v2.trackStatus, 'partial');
  const legacy = trackerFields({ engine: 'motion-beta', status: 'tracked', reasonCodes: [], points: [] });
  assert.equal(legacy.confidence, null);
  assert.equal(legacy.vsRunner, null);
  assert.equal(legacy.fallback, false);
  assert.equal(trackerFields({ diagnostics: { margin: 0.9 }, points: [] }).confidence, 0.9);
  assert.equal(trackerFields({ points: [] }).trackStatus, 'no_reliable_track');
  assert.equal(trackerFields({ points: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }] }).trackStatus, 'tracked');
  // The UI demotes short tracks to partial.
  const m = evaluateClip(mkRun(track(T0, 1.6334)), null);
  assert.equal(m.trackStatus, 'tracked');
  assert.equal(m.ui.status, 'partial');
  assert.ok(m.ui.reasonCodes.includes('tracking_ended_early'));
  assert.equal(m.engine, 'v2');
});

test('summarizeTotals counts every status per split', () => {
  const totals = summarizeTotals([
    { split: 'tune', status: 'pass' }, { split: 'tune', status: 'fail', abstained: true },
    { split: 'holdout', status: 'error' }, { split: 'holdout', status: 'pass', fallback: true },
    { split: 'holdout', status: 'not_run' }, { status: 'unknown_ground_truth' }
  ]);
  assert.deepEqual(totals.all, { clips: 6, pass: 2, fail: 1, unknown_ground_truth: 1, not_run: 1, error: 1, abstained: 1, fallback: 1 });
  assert.deepEqual(totals.tune, { clips: 2, pass: 1, fail: 1, unknown_ground_truth: 0, not_run: 0, error: 0, abstained: 1, fallback: 0 });
  assert.deepEqual(totals.holdout, { clips: 3, pass: 1, fail: 0, unknown_ground_truth: 0, not_run: 1, error: 1, abstained: 0, fallback: 1 });
  assert.equal(totals.unspecified.clips, 1);
  assert.deepEqual(Object.keys(summarizeTotals([])), ['all', 'tune', 'holdout']);
});

test('markdown report has engine columns, per-split totals, provenance and one line per clip', () => {
  const pass = { ...evaluateClip(mkRun(track(), { engine: 'global-v2', confidence: 4, vsRunner: 2, reasonCodes: ['ambiguous_launch'] }), shot()), id: 'a', split: 'tune' };
  const report = {
    engine: 'v2', generatedAt: 'now', manifest: 'm.json',
    provenance: { git: { sha: 'f'.repeat(40), short: 'fffffff', dirty: true, changedFiles: 2, diffSha256: 'd'.repeat(64) }, engine: 'v2', options: { limit: null }, node: 'v24', ffmpeg: '8.1', ffprobe: '8.1', platform: 'x', manifestSha256: 'e'.repeat(64) },
    clips: [
      pass,
      { id: 'b', split: 'holdout', status: 'error', reason: 'runner_error', notes: ['ffmpeg failed\nline two | three'] },
      { id: 'c', split: 'holdout', status: 'not_run', reason: 'skipped', skipReason: 'placeholder', notes: ['placeholder'] },
      { id: 'd', split: 'holdout', status: 'fail', fallback: true, fallbackKind: 'legacy-link', trackStatus: 'tracked', failReasons: ['run_on'] }
    ]
  };
  const md = formatMarkdownReport(report);
  const rows = md.split('\n').filter(l => l.startsWith('| '));
  assert.ok(rows.some(r => r.startsWith('| a | tune | pass | global-v2 | tracked | ambiguous_launch | 4 | 2 | no |')));
  assert.ok(rows.some(r => r.startsWith('| b | holdout | error |') && r.includes('runner_error; ffmpeg failed line two / three')));
  assert.ok(rows.some(r => r.startsWith('| c | holdout | not_run |') && r.endsWith('| skipped; placeholder |')));
  assert.ok(rows.some(r => r.startsWith('| d |') && r.includes('| yes (legacy-link) |') && r.includes('run_on')));
  assert.ok(rows.includes('| tune | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |'));
  assert.ok(rows.includes('| holdout | 3 | 0 | 1 | 0 | 1 | 1 | 0 | 1 |'));
  assert.match(md, /dirty: yes, 2 paths, diff sha256 `d{64}`/);
  assert.match(md, /Manifest sha256: `e{64}`/);
  assert.match(md, /Node v24; ffmpeg 8\.1; ffprobe 8\.1/);
});
