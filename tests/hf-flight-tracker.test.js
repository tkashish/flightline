// U6 flight tracker: pixel-level synthetic scenes through FlightTracker with a contract-shaped stub RoiTube (real
// detection on the crops) and a stub fitFlight (image-space ballistic model, not U5's M3D).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, makeObservation, makeTrackHypothesis, identityTrack, makeSourceMeta, makeSpot, cropLuma, makeLaunchCandidate } from '../dist/hf/types.js';
import { FlightTracker, reassociate, trendFires, changePointCut, pruneBranches, zmapPeaks, chi2 } from '../dist/hf/flight-tracker.js';
import { makeScene, ballPath, sizeToD, tableObject } from './hf/helpers/tracker-scene.mjs';
import { drive, makeLaunch, makeLog, trackers } from './hf/helpers/tracker-drive.mjs';
import { planeCase, speckCase, evictCase } from './hf/helpers/tracker-e5.mjs';
import { flightCase, ballHits, inliers, near } from './hf/helpers/tracker-cases.mjs';
import { scripted, scriptTube } from './hf/helpers/tracker-script.mjs';
import { stubFitFlight } from './hf/helpers/tracker-stub-fit.mjs';

const T = PARAMS.track;

/* ---------------------------------------------------------------- harness sanity */

test('procedural lumaRect equals cropLuma on the rendered plane (edge clamping and pooling)', () => {
  const s = makeScene({ width: 64, height: 48, frameCount: 2, objects: [tableObject('b', [{ i: 1, x: 20.3, y: 30.7, d: 5 }], 60)] });
  const plane = s.plane(1);
  for (const [rect, pool] of [[{ x: 10, y: 20, w: 16, h: 12 }, 1], [{ x: -5, y: 40, w: 20, h: 14 }, 2], [{ x: 50, y: -3, w: 18, h: 9 }, 3]]) {
    const a = s.lumaRect(1, rect, pool), b = cropLuma(plane, 64, 48, rect, pool);
    assert.deepEqual([a.w, a.h, a.valid], [b.w, b.h, b.valid]);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  }
});

/* ---------------------------------------------------------------- contract */

test('FlightTracker contract: window from t0 − flightPreSec, [] outside it, TrackHypothesis[] best first', async () => {
  const c = await flightCase({ ball: { n: 30 }, N: 90 });
  const w = c.tracker.window(), t0 = c.launch.t0;
  assert.equal(w.to, c.scene.meta.frameCount);
  assert.ok(c.scene.meta.times[w.from] <= t0 - PARAMS.pipeline.flightPreSec + 1e-9 && c.scene.meta.times[w.from + 1] > t0 - PARAMS.pipeline.flightPreSec);
  assert.deepEqual(c.tracker.roiRequests(w.from - 1), []);
  assert.equal(c.tracker.done, true);
  assert.deepEqual(c.tracker.roiRequests(w.from + 40), [], 'a finished tracker requests nothing');
  assert.ok(c.all.length >= 1 && c.all.length <= T.maxBranches);
  for (const h of c.all) assert.deepEqual(check('TrackHypothesis', h), []);
  for (let i = 1; i < c.all.length; i++) assert.ok(c.all[i - 1].llr >= c.all[i].llr);
  assert.ok(structuredClone(c.all[0].observations).length, 'observations are structured-cloneable');
  assert.throws(() => new FlightTracker(c.launch, c.ctx, {}), /RoiTube/);
  assert.throws(() => new FlightTracker(null, c.ctx, c.deps), /launch/);
});

test('clean flight: every frame observed within 1.5 px, the launch chain kept, lost after the ball ends', async () => {
  const c = await flightCase();
  const hits = ballHits(c, 1.5);
  assert.ok(hits.length >= c.path.length - 1, `${hits.length}/${c.path.length}`);
  assert.equal(inliers(c.hyp).filter(o => !near(o, c.bm.get(o.index), 2)).length, 0, 'no observation off the ball');
  assert.equal(inliers(c.hyp).filter(o => o.src === 'launch').length, 4, 'U3 chain points stay as the first observations');
  assert.equal(c.hyp.observedEnd, 'lost');
  assert.ok(c.forward.features.tracker.refits >= 2, 'warm refits run');
  const r = c.tracker.result();
  assert.deepEqual(Object.keys(r).sort(), ['endReason', 'features', 'fit', 'hypothesis', 'observations']);
  assert.equal(r.endReason, 'lost');
  assert.equal(typeof r.fit.predict, 'function');
});

/* ---------------------------------------------------------------- D1 E5 ports */

test('E5 eviction (D1 e6): a later true launch survives 1-6 earlier wrong launch ids, with or without glints', async () => {
  for (const o of [{ wIds: 1 }, { wIds: 4 }, { wIds: 6 }, { wIds: 4, glints: 2 }, { wIds: 4, wEndsAt: 30 }]) {
    const r = await evictCase(o);
    assert.equal(r.selected, 'BALL', JSON.stringify(o));
    assert.equal(r.dec.status, 'tracked', JSON.stringify(o));
    assert.equal(r.ballWithW, r.n, `${JSON.stringify(o)}: ${r.ballWithW}/${r.n}`);
    assert.ok(r.identical, `${JSON.stringify(o)}: the ball track must not depend on the earlier launches`);
  }
  // Equal launch evidence for an overlapping second flight is a conflict, never a guess.
  const tie = await evictCase({ wIds: 4, wMargin: 3 });
  assert.equal(tie.dec.status, 'no_reliable_track');
  assert.deepEqual(tie.dec.reasonCodes, ['identity_conflict']);
  assert.ok(tie.identical);
});

test('pruneBranches reserves per-launch quotas so a fresh later launch is not evicted at birth', () => {
  const branches = [];
  for (let w = 0; w < 4; w++) for (let j = 0; j < 4; j++) branches.push({ launchId: `W${w}`, llr: 40 - j });
  branches.push({ launchId: 'BALL', llr: 1 });
  const kept = pruneBranches(branches, { maxTotal: 8, quota: 2 });
  assert.ok(kept.some(b => b.launchId === 'BALL'), 'the later launch keeps its reserved slot');
  for (const id of ['W0', 'W1', 'W2', 'W3']) assert.equal(kept.filter(b => b.launchId === id).length, 2);
  assert.deepEqual(kept.map(b => b.llr), [...kept.map(b => b.llr)].sort((a, b) => b - a), 'best first');
  assert.equal(pruneBranches([{ launchId: 'A', llr: 3 }, { launchId: 'A', llr: 5 }, { launchId: 'A', llr: 1 }], { maxTotal: 2, quota: 2 }).map(b => b.llr).join(), '5,3');
});

test('E5 static-speck steal (D1 e11): no static point and the trace continues past the object to the end', async () => {
  for (const o of [{ vy: -6 }, { vy: -9 }, { vy: -20 }, { vy: -9, known: true }, { offset: 12 }]) {
    const r = await speckCase({ clipFrames: 120, ...o });
    assert.equal(r.staticPts, 0, `${JSON.stringify(o)}: static points`);
    assert.equal(r.afterPass, 0, `${JSON.stringify(o)}: nothing parks on the object after the ball passed`);
    assert.equal(r.lastBall, r.pathEnd, `${JSON.stringify(o)}: the trace reaches the ball's last frame`);
    // Only frames where the ball's disc merges with the object's may be lost (offset 6 at slow speeds).
    assert.ok(r.ballPts >= ((o.offset ?? 6) >= 12 ? r.n : 24), `${JSON.stringify(o)}: ${r.ballPts}/${r.n} ball points`);
  }
});

test('E5 airplane steal (D1 e4): no plane point, including the 6-miss leak case; the ball kept', async () => {
  const cases = [
    { offset: 0 }, { offset: 30 }, { appearAfterMiss: 6 }, { appearAfterMiss: 9 },
    { alwaysVisible: true }, { alwaysVisible: true, knownMover: false }, { planeV: [2, 1] }
  ];
  for (const o of cases) {
    const r = await planeCase(o);
    assert.equal(r.planePts, 0, `${JSON.stringify(o)}: ${r.planePts} plane points`);
    assert.equal(r.ballPts, r.n, `${JSON.stringify(o)}: ${r.ballPts}/${r.n} ball points`);
  }
  // One frame after the last sighting the plane sits on the ball's prediction: at most that one frame (D1's own result).
  const one = await planeCase({ appearAfterMiss: 1 });
  assert.ok(one.planePts <= 1, `${one.planePts}`);
  assert.equal(one.ballPts, one.n);
});

/* ---------------------------------------------------------------- MHT, re-acquisition, occlusion, exit */

/** A bright, flapping bird that co-moves with the ball around flight frame 20, then veers off. */
function birdRows() {
  const ball = ballPath({ impact: 30, x0: 360, y0: 1000, vx: 2, vy: -20, g: 0.4, drag: 0.01, n: 60, size0: 40 }), rows = [];
  for (let k = 12; k <= 40; k++) {
    const p = ball[k - 1];
    const [dx, dy] = k <= 19 ? [-3 * (20 - k), 2 * (20 - k)] : k <= 22 ? [0.8 * (k - 19), 0] : [2.4 + 4 * (k - 22), 3 * (k - 22) + 2 * Math.sin(k)];
    rows.push({ i: 30 + k, x: p.x + dx, y: p.y + dy, d: 3.5 + 1.2 * Math.sin(k * 1.7) });
  }
  return rows;
}

test('bird crossing: MHT branches at the crossing, no bird point survives, the ball is followed through', async () => {
  const rows = birdRows(), bird = new Map(rows.map(r => [r.i, r]));
  const c = await flightCase({ extras: [tableObject('bird', rows, 90)] });
  const birdPts = inliers(c.hyp).filter(o => near(o, bird.get(o.index), 2) && !near(o, c.bm.get(o.index), 2));
  assert.equal(birdPts.length, 0, `bird points at ${birdPts.map(o => o.index)}`);
  assert.ok(c.forward.features.tracker.spawned >= 1, 'the crossing spawned hypotheses');
  assert.ok(ballHits(c).length >= c.path.length - 4, `${ballHits(c).length}/${c.path.length}`);
  assert.equal(ballHits(c).at(-1).index, c.path.at(-1).i, 'followed to the end of the flight');
});

test('3-of-5 re-acquisition: single false alarms in a gap never extend the trace; 3 of 5 re-acquires the ball', async () => {
  const ball = ballPath({ impact: 30, x0: 360, y0: 1000, vx: 2, vy: -20, g: 0.4, drag: 0.01, n: 60, size0: 40 });
  const fa = [28, 31, 34].map(k => ({ i: 30 + k, x: ball[k - 1].x + 3, y: ball[k - 1].y - 2, d: 3 }));
  const c = await flightCase({ visible: k => k < 25 || k > 36, extras: fa.map((r, q) => tableObject(`fa${q}`, [r], 70)) });
  assert.equal(inliers(c.hyp).filter(o => fa.some(r => r.i === o.index && near(o, r, 2))).length, 0, 'false alarms accepted');
  assert.ok(c.forward.features.lostEvents >= 1 && c.forward.features.reacquired >= 1);
  assert.equal(ballHits(c).filter(o => o.index - 30 > 36).length, c.path.length - 36, 'every post-gap ball frame re-acquired');
  // Two detections in five frames after the gap are not enough.
  const two = await flightCase({ visible: k => k < 25 || k === 37 || k === 39 });
  assert.equal(inliers(two.hyp).filter(o => o.index - 30 > 36).length, 0);
});

test('occlusion: misses inside an energy mask do not count, so the ball is not lost behind the occluder', async () => {
  const ball = ballPath({ impact: 30, x0: 360, y0: 1000, vx: 2, vy: -20, g: 0.4, drag: 0.01, n: 60, size0: 40 });
  const box = [ball[19].x - 60, ball[31].y - 40, ball[31].x + 60, ball[19].y + 40], hidden = k => k < 20 || k > 31;
  const masked = await flightCase({ visible: hidden, mask: { k0: 50, k1: 61, box } });
  const bare = await flightCase({ visible: hidden });
  assert.equal(masked.forward.features.reacquired, 0, 'coasted through the mask without a re-acquisition');
  assert.equal(bare.forward.features.reacquired, 1, 'without the mask the 12 misses lose the ball');
  assert.equal(masked.forward.features.lostEvents + 1, bare.forward.features.lostEvents);
  for (const c of [masked, bare]) assert.equal(ballHits(c).filter(o => o.index - 30 > 31).length, c.path.length - 31, 'post-occlusion ball frames');
});

test('frame exit: observation ends at the edge (frame_exit within 2 frames) and the tracker stops early', async () => {
  const c = await flightCase({ ball: { x0: 300, y0: 900, vx: 25, vy: -8, g: 0.4, drag: 0, n: 30 } });
  const last = inliers(c.hyp).at(-1);
  assert.equal(c.hyp.observedEnd, 'frame_exit');
  assert.equal(c.hyp.state, 'exited');
  assert.ok(c.hyp.exitT - last.t <= (PARAMS.decide.exitWithinFrames + 0.5) / 30);
  assert.ok(last.x > 690, 'observed up to the edge');
  assert.ok(c.tube.calls.plan < 40, `stopped requesting ROIs after the exit (${c.tube.calls.plan} plans)`);
});

test('exit and re-entry: a ball leaving the top is waited for at the fitted re-entry frame and re-acquired', async () => {
  const c = await flightCase({ ball: { x0: 360, y0: 250, vx: 1.5, vy: -22, g: 0.7, drag: 0, n: 60, size0: 30 }, N: 120 });
  const outK = c.path.filter(p => p.y < 0).map(p => p.k), back = outK.at(-1);
  assert.ok(c.forward.features.reentries >= 1 && c.forward.features.reacquired >= 1);
  assert.ok(ballHits(c).filter(o => o.index - 30 > back).length >= 4, 'observed again after re-entry');
  assert.equal(inliers(c.hyp).filter(o => !near(o, c.bm.get(o.index), 2)).length, 0);
});

test('slow apex: the ROI stride grows to floor(1 px / |v|) after the first 0.1 s real', async () => {
  const impact = 10, rows = [];
  for (let k = 0; k <= 80; k++) rows.push({ i: k, x: 300 + (k > impact ? 0.25 * (k - impact) : 0), y: 600 - (k > impact ? 0.1 * (k - impact) : 0), d: 6 });
  const scene = makeScene({ frameCount: 80, objects: [tableObject('ball', rows, 60)] });
  const path = rows.filter(r => r.i > impact);
  const launch = makeLaunch({ path, impact, d0: 6, address: { x: 300, y: 600 } });
  const H = trackers(scene.meta, makeLog(scene.meta, scene.camera), [launch]), tr = H.trackers[0], asked = [];
  const plan = tr.roiRequests.bind(tr);
  tr.roiRequests = i => { const r = plan(i); if (r.length) asked.push(i); return r; };
  await drive(scene.source, [tr], scene.camera);
  const late = asked.filter(i => scene.meta.times[i] - launch.t0 > T.stride.fullRealSec + 0.2);
  const gaps = late.slice(1).map((i, q) => i - late[q]);
  assert.ok(gaps.length > 5 && gaps.every(g => g === Math.floor(T.stride.px / Math.hypot(0.25, 0.1))), `gaps ${gaps}`);
  assert.ok(asked.filter(i => i > impact && i <= impact + 3).length >= 3, 'every frame early in the flight');
});

/* ---------------------------------------------------------------- labels */

test('distractor labels: pre-impact mover -> mover, sky mover -> ambiguous, spot/speck -> static, club -> ambiguous', () => {
  const meta = makeSourceMeta({ width: 720, height: 1280, fps: 30, frameCount: 60, times: Float64Array.from({ length: 60 }, (_, i) => i / 30), duration: 2 });
  const camera = identityTrack(meta);
  const movers = [
    { id: 'p', kind: 'preimpact', index0: 0, index1: 20, x: 100, y: 100, vx: 2, vy: 0, d: 4 },
    { id: 's', kind: 'sky', index0: 0, index1: 59, x: 500, y: 200, vx: 0, vy: 1, d: 4 }
  ];
  const spots = [makeSpot({ id: 'sp', x: 300, y: 900, d: 6, polarity: 1, contrast: 40, z: 9, firstIndex: 0, lastIndex: 59, presence: 1, roundness: 1, fill: 0.8, ballLike: true })];
  const log = makeLog(meta, camera, { movers, spots, specks: [{ x: 600, y: 600, r: 3 }] });
  const clubTrack = { points: [{ index: 31, t: 31 / 30, x: 410, y: 880, measured: true, extent: 8 }], impactVel: { x: 5, y: -2 }, dir: { x: 0.9, y: -0.4 } };
  const path = [31, 32, 33, 34].map(i => ({ i, x: 400 + 3 * (i - 30), y: 900 - 20 * (i - 30) }));
  const launch = makeLaunch({ path, impact: 30, d0: 6, address: { x: 400, y: 900 }, clubTrack });
  const tr = new FlightTracker(launch, { meta, log, impact: null, params: PARAMS }, { RoiTube: class { plan() { return []; } } });
  const L = (k, x, y) => tr.labels.label(k, { x, y }, 4);
  assert.equal(L(40, 181, 100), 'mover', 'extrapolated pre-impact mover (100 + 2·40)');
  assert.equal(L(40, 200, 100), 'inlier', 'away from it');
  assert.equal(L(10, 500, 210), 'ambiguous', 'on a sky track');
  assert.equal(tr.labels.label(10, { x: 500, y: 210, vx: 5, vy: -4 }, 4), 'inlier', 'a TBD velocity far from the sky track clears it');
  assert.equal(L(20, 301, 900), 'static');
  assert.equal(L(20, 601, 600), 'static', 'lens speck in raw px');
  assert.equal(L(31, 412, 882), 'ambiguous', 'club-explained');
  assert.equal(L(32, 412, 882), 'inlier', 'the club point is per frame');
});

/* ---------------------------------------------------------------- pure helpers */

test('trendFires: same-sign run (D2), drift through zero, predictor velocity sigma, run length', () => {
  const S1 = [1, 0, 1], dir = [1, 0], items = (vals, S = S1, sv = 0) => vals.map((v, k) => ({ r: [v, 0], S, dir, k, sv }));
  const tr = { minObs: 4, sigmas: 2 };
  assert.equal(trendFires(items([1.5, 1.6, 1.4, 1.7]), tr), true, 'same-signed, mean 1.55 > 2·1/√4');
  assert.equal(trendFires(items([1.5, 1.6, 1.4, 1.7], [4, 0, 4]), tr), false, 'within 2σ/√N at σ = 2');
  assert.equal(trendFires(items([0.4, -0.3, 0.5, -0.2, 0.1]), tr), false, 'white residuals');
  assert.equal(trendFires(items([-3, -1, 1, 3]), tr), true, 'a steal crossing the prediction drifts through zero');
  assert.equal(trendFires(items([-3, -1, 1, 3], S1, 1.2), tr), false, 'a drift within the predictor velocity sigma');
  assert.equal(trendFires(items([3, 3, 3]), tr), false, 'needs minObs');
  assert.equal(trendFires(items([3, 3, 3]), tr, 3), true);
  assert.equal(trendFires([{ r: [0, 3], S: S1, dir }, { r: [0, 3.1], S: S1, dir }, { r: [0, 2.9], S: S1, dir }, { r: [0, 3.2], S: S1, dir }], tr), true, 'cross-track component');
});

test('changePointCut (D1 §4.3): a kink onto another object is cut at the junction, a smooth arc is not', () => {
  const cp = T.changePoint, arc = Array.from({ length: 28 }, (_, i) => ({ t: i / 30, x: 400 + 3 * i, y: 900 - 25 * i + 0.55 * i * i / 2 }));
  assert.equal(changePointCut(arc, cp), arc.length);
  const steal = [...arc.slice(0, 20), ...Array.from({ length: 8 }, (_, j) => ({ t: (20 + j) / 30, x: arc[19].x + 6 + 1.5 * j, y: arc[19].y - 4 }))];
  assert.equal(changePointCut(steal, cp), 20);
  assert.equal(changePointCut(arc.slice(0, 12), cp), 12, 'too short to test');
});

test('zmapPeaks: local maxima by polarity with sub-pixel parabolas in stabilized px', () => {
  const w = 9, h = 9, data = new Int8Array(w * h), set = (i, j, v) => { data[j * w + i] = v; };
  set(3, 4, 40); set(2, 4, 20); set(4, 4, 20); set(3, 3, 10); set(3, 5, 30);   // bright peak, sub-pixel +y
  set(7, 1, -50);                                                              // dark peak
  const zm = { index: 5, t: 0.1, x0: 100, y0: 200, pool: 2, w, h, data, zScale: 8 };
  const bright = zmapPeaks(zm, 1, 2);
  assert.equal(bright.length, 1);
  assert.ok(Math.abs(bright[0].x - (100 + 2 * 3.5)) < 1e-9 && bright[0].y > 200 + 2 * 4.5, JSON.stringify(bright[0]));
  assert.equal(bright[0].z, 5);
  assert.equal(zmapPeaks(zm, -1, 2)[0].polarity, -1);
  assert.equal(zmapPeaks(zm, 0, 2).length, 2);
  assert.equal(zmapPeaks(zm, 1, 6).length, 0);
});

test('reassociate (Viterbi over cached z-maps): recovers a missed point, drops a point off the refit, never extends', () => {
  const pos = k => ({ x: 100 + 3 * k, y: 300 - 2 * k }), zs = 8;
  const zmap = (k, at, z) => {
    const w = 41, data = new Int8Array(w * w), c = pos(k), x0 = c.x - 20.5, y0 = c.y - 20.5;
    for (const [p, v] of at) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = Math.floor(p.x - x0) + di, j = Math.floor(p.y - y0) + dj;
      data[j * w + i] = Math.max(data[j * w + i], Math.round(zs * v * (di || dj ? 0.5 : 1)));
    }
    return { index: k, t: k / 30, x0, y0, pool: 1, w, h: w, data, zScale: zs };
  };
  const obs = [], zmaps = [];
  for (let k = 10; k <= 24; k++) {
    if (k <= 20 && k !== 13) obs.push(makeObservation({ index: k, t: k / 30, x: pos(k).x + (k === 16 ? 9 : 0), y: pos(k).y, sigma: 0.5, z: 8, z1: 8, polarity: 1, src: 'tbd' }));
    zmaps.push(zmap(k, [[pos(k), k === 13 ? 4 : 8]], 8));
  }
  const hyp = makeTrackHypothesis({ id: 'h', launchId: 'L', observations: obs, state: 'lost', observedEnd: 'lost', llr: 50, zmaps });
  const fit = { tau: 1, predict: t => { const k = t * 30; return { t, ...pos(k), cov: [0.04, 0, 0.04], d: 4, h: null }; } };
  const meta = makeSourceMeta({ width: 720, height: 1280, fps: 30, frameCount: 40, times: Float64Array.from({ length: 40 }, (_, i) => i / 30), duration: 40 / 30 });
  const out = reassociate(hyp, fit, { meta, log: null, impact: null, params: PARAMS }, {});
  const at = k => out.observations.filter(o => o.index === k);
  assert.equal(at(13)[0]?.src, 'viterbi', 'faint missed point recovered');
  assert.ok(near(at(13)[0], pos(13), 0.5));
  assert.equal(at(16).length, 1);
  assert.equal(at(16)[0].src, 'viterbi', 'the off-fit forward point is replaced by the peak on the refit path');
  assert.ok(near(at(16)[0], pos(16), 0.5));
  assert.equal(out.observations.filter(o => o.index > 20).length, 0, 'no additions after the last forward inlier');
  assert.deepEqual(check('TrackHypothesis', out), []);
  assert.equal(reassociate(hyp, null, { meta, params: PARAMS }, {}), hyp, 'no fit: unchanged');
});

/* ---------------------------------------------------------------- cost */

test('tracker overhead per frame (truth tube, no pixel work) at 1080x1920 and 2160x3840', async () => {
  for (const [W, H] of [[1080, 1920], [2160, 3840]]) {
    const fps = 60, N = 600, s = W / 1080, impact = 30;
    const path = ballPath({ impact, x0: 540 * s, y0: 1500 * s, vx: 1.5 * s, vy: -8 * s, g: 0.03 * s, drag: 0.002, n: 560, size0: 60 }).map(p => ({ ...p, d: Math.max(1.5, 14 * s * Math.exp(-(p.i - impact) / 120)) }));
    const truth = new Map(path.map(p => [p.i, p]));
    class TruthTube {
      constructor() { this.max = -1; }
      plan(i, pred) { return [{ rect: { x: Math.round(pred.x) - 8, y: Math.round(pred.y) - 8, w: 16, h: 16 }, pool: 1, purpose: 'main' }]; }
      push(i) { this.max = Math.max(this.max, i); }
      ready(i) { return this.max >= i + 2; }
      detect(i, pred) {
        const p = truth.get(i), w = 41, data = new Int8Array(w * w);
        const zmap = { index: i, t: i / fps, x0: pred.x - 20.5, y0: pred.y - 20.5, pool: 1, w, h: w, data, zScale: 8 };
        if (!p || chi2(p.x - pred.x, p.y - pred.y, [pred.cov[0] + 1, pred.cov[1], pred.cov[2] + 1]) > T.gateChi2) return { index: i, t: i / fps, observation: null, zmap, score: 0, threshold: 5, nullScores: [] };
        const o = { index: i, t: i / fps, x: p.x + 0.2 * Math.sin(i), y: p.y + 0.2 * Math.cos(i), sigma: 0.4, z: 12, z1: 9, d: null, polarity: 1, src: 'tbd', flag: 'inlier' };
        return { index: i, t: i / fps, observation: o, zmap, score: 12, threshold: 5, nullScores: [] };
      }
    }
    const meta = makeSourceMeta({ width: W, height: H, fps, frameCount: N, times: Float64Array.from({ length: N }, (_, i) => i / fps), duration: N / fps });
    const camera = identityTrack(meta), log = makeLog(meta, camera);
    const launch = makeLaunch({ path, impact, fps, d0: 14 * s, address: { x: 540 * s, y: 1500 * s } });
    const { stubFitFlight } = await import('./hf/helpers/tracker-stub-fit.mjs');
    const tr = new FlightTracker(launch, { meta, log, impact: null, params: PARAMS }, { RoiTube: TruthTube, fitFlight: stubFitFlight });
    const crop = { data: new Uint8Array(1), w: 1, h: 1, x0: 0, y0: 0, pool: 1, valid: { x0: 0, y0: 0, x1: 1, y1: 1 } };
    const t1 = performance.now();
    let n = 0;
    for (let i = tr.window().from; i < N && !tr.done; i++, n++) { const reqs = tr.roiRequests(i); tr.consume(i, i / fps, reqs.map(() => crop), { a: 1, b: 0, tx: 0, ty: 0 }); }
    const hyps = tr.finish(), ms = (performance.now() - t1) / n;
    console.log(`  tracker ${W}x${H}: ${ms.toFixed(3)} ms/frame over ${n} frames, ${inliers(hyps[0]).length} inliers, ${tr.stats.refits} refits (stub fit)`);
    assert.ok(inliers(hyps[0]).length >= 0.9 * n, `${inliers(hyps[0]).length}/${n}`);
    assert.ok(ms < 5, `${ms} ms/frame`);
  }
});

/* ---------------------------------------------------------------- rules pinned in isolation */

test('F17: a ball flickering on its own path every third frame after it fades never extends the trace', async () => {
  const c = await flightCase({ visible: k => k <= 40 || (k <= 58 && (k - 40) % 3 === 0) });
  assert.equal(inliers(c.forward).at(-1).index - 30, 40, 'forward pass ends at the fade');
  assert.equal(inliers(c.hyp).at(-1).index - 30, 40, 'and re-association does not extend it');
});

test('static persistence (D1): an unregistered static speck on a slow ball\'s coasted path is never taken', async () => {
  const spk = { x: 360 + 0.7 * 40, y: 700 - 0.35 * 40, d: 5 };
  const c = await flightCase({ ball: { x0: 360, y0: 700, vx: 0.7, vy: -0.35, g: 0, drag: 0, n: 30, size0: 30 }, extras: [tableObject('speck', Array.from({ length: 140 }, (_, i) => ({ i, ...spk })), 60)] });
  assert.equal(inliers(c.hyp).filter(o => near(o, spk, 2)).length, 0, 'speck points');
  assert.ok(inliers(c.hyp).at(-1).index <= c.path.at(-1).i, 'the trace does not park on the speck');
  assert.ok(c.forward.features.flags.static > 20, 'the speck was recognized as static');
});

test('MHT: two admissible peaks within spawnRatio spawn a child; the decoy branch is resolved away', async () => {
  // A small ball (d0 2 px): a decoy 3.6 px away is a distinct object (> 1.5·d) yet inside the gate.
  const decoy = (i, b) => (i >= 45 && i <= 62 ? { x: b.x + 3.6 + (i > 50 ? 3 * (i - 50) : 0), y: b.y, S: 12 } : null);
  const { tr, hyps, truth } = await scripted((i, b) => (b ? [{ ...b, S: 12 }, decoy(i, b)].filter(Boolean) : []), { d0: 2 });
  assert.ok(tr.stats.spawned >= 1, 'an ambiguous association spawns a hypothesis');
  const best = inliers(hyps[0]);
  assert.equal(best.filter(o => !near(o, truth.get(o.index), 1)).length, 0, 'the best branch is the ball');
  assert.ok(best.length >= 60);
});

test('MHT resolution: a sibling trailing by identityMarginNats is dropped once resolveFrames have passed', async () => {
  const { tr } = await scripted((i, b) => (b ? [{ ...b, S: 12 }] : []), { n: 20, N: 40, finish: false });
  const root = tr.branches[0], M = PARAMS.decide.identityMarginNats;
  const sib = (llr, k) => { const c = tr.clone(root, k); c.llr = llr; c.obs = c.obs.slice(0, -2); return c; };
  tr.branches = [root, sib(root.llr - M - 1, 30)];
  tr.resolve(30 + T.resolveFrames - 1);
  assert.equal(tr.branches.length, 2, 'too young to resolve');
  tr.resolve(30 + T.resolveFrames);
  assert.deepEqual(tr.branches.map(b => b.id), [root.id], 'the trailing sibling is dropped');
  tr.branches = [root, sib(root.llr - M + 1, 30)];
  tr.resolve(40);
  assert.equal(tr.branches.length, 2, 'within the identity margin both stay (decide reports the conflict)');
  const a = sib(root.llr - 10, 30);
  a.probation = { kind: 'gap', planned: 3, pts: [{ inc: 6 }, { inc: 6 }], dir: [1, 0] };
  tr.branches = [root, a];
  tr.resolve(40);
  assert.equal(tr.branches.length, 2, 'tentative probation evidence counts before a branch is dropped');
});

test('MHT: a sudden flux jump on the prediction spawns the missed-detection hypothesis', async () => {
  // An intruder three times brighter sits on the ball at frame 50, then leaves sideways.
  const { tr, hyps, truth } = await scripted((i, b) => {
    if (!b) return [];
    if (i === 50) return [{ x: b.x, y: b.y, S: 40 }];
    return i > 50 && i < 60 ? [{ ...b, S: 12 }, { x: b.x + 5 * (i - 50), y: b.y + 2, S: 40 }] : [{ ...b, S: 12 }];
  });
  assert.ok(tr.stats.spawned >= 1, 'the flux jump spawned the miss branch');
  assert.equal(inliers(hyps[0]).filter(o => o.index > 50 && !near(o, truth.get(o.index), 1)).length, 0);
});

test('joint physics test refuses a segment the fit can only absorb by bending the committed track', async () => {
  const { tr, truth } = await scripted((i, b) => (b && i <= 70 ? [{ ...b, S: 12 }] : []), { n: 70, N: 75 });
  const b = tr.branches[0], last = inliers({ observations: b.obs }).at(-1);
  // A smooth climbing segment (a bird) that starts where the ball would be after a 3-frame gap.
  const pts = [1, 2, 3, 4, 5].map(j => {
    const k = last.index + 3 + j, p = truth.get(last.index) ?? last, o = { index: k, t: k / 30, x: p.x + 2 * (3 + j), y: p.y - 3 * (3 + j) - 0.6 * j * j, sigma: 0.5, z: 12, z1: 8, d: null, polarity: 1, src: 'tbd', flag: 'inlier' };
    return { o, inc: 5, chi2: 1, r: [0, 0], S: [1, 0, 1], dir: [0.5, -0.8], k, sv: 0 };
  });
  assert.equal(tr.jointOk(b, pts), false);
  const ball = [1, 2, 3, 4, 5].map(j => { const k = last.index + j, p = truth.get(k); return { ...pts[0], o: { ...pts[0].o, index: k, t: k / 30, x: p.x, y: p.y }, k }; });
  assert.ok(tr.jointOk(b, ball), 'the ball continuing its arc passes');
});

test('learned distractors come only from a coherent constant-velocity rejected segment', async () => {
  const { tr } = await scripted((i, b) => (b ? [{ ...b, S: 12 }] : []), { n: 40, N: 50 });
  const b = tr.branches[0], mk = (k, x, y) => ({ o: { index: k, t: k / 30, x, y, d: 4 }, inc: 1, chi2: 1, r: [0, 0], S: [1, 0, 1], dir: [1, 0], k });
  const n0 = b.distractors.length;
  b.probation = { kind: 'gap', planned: 4, pts: [mk(80, 100, 100), mk(81, 140, 60), mk(82, 90, 170), mk(83, 160, 120)], dir: [1, 0] };
  tr.rejectProbation(b, true);
  assert.equal(b.distractors.length, n0, 'incoherent points are not one object');
  b.probation = { kind: 'gap', planned: 4, pts: [mk(80, 100, 100), mk(81, 101.5, 100), mk(82, 103, 100.1), mk(83, 104.5, 99.9)], dir: [1, 0] };
  tr.rejectProbation(b, true);
  assert.equal(b.distractors.length, n0 + 1, 'a plane-like line is learned');
  assert.equal(tr.labels.mover(86, 109, 100, 4, b.distractors), 'mover', 'and masks its extrapolation');
});

test('offline change-point trim (D1) cuts a committed steal tail when no physics fit is available', async () => {
  const meta = makeSourceMeta({ width: 720, height: 1280, fps: 30, frameCount: 80, times: Float64Array.from({ length: 80 }, (_, i) => i / 30), duration: 80 / 30 });
  const path = ballPath({ impact: 30, x0: 400, y0: 900, vx: 3, vy: -25, g: 0.55, drag: 0.03, n: 20, size0: 40 });
  const launch = makeLaunch({ path, impact: 30, d0: 7, address: { x: 400, y: 900 } });
  const tr = new FlightTracker(launch, { meta, log: makeLog(meta, identityTrack(meta)), impact: null, params: PARAMS }, { RoiTube: class { plan() { return []; } } });
  const b = tr.branches[0], last = path.at(-1), tail = Array.from({ length: 8 }, (_, j) => ({ i: last.i + 1 + j, x: last.x + 6 + 1.5 * j, y: last.y - 4 }));
  b.obs = [...path, ...tail].map(p => makeObservation({ index: p.i, t: p.i / 30, x: p.x, y: p.y, sigma: 0.4, z: 10, polarity: 1, src: 'tbd' }));
  b.inc = b.obs.map(() => 1);
  const [h] = tr.finish();
  assert.equal(inliers(h).at(-1).index, last.i, `kept ${inliers(h).length}`);
  assert.ok(h.features.cuts.some(c => c.why === 'change_point'));
});

test('trailing fit rejects (D2 §5.2): a terminal run of >= trailingRejects fit outliers truncates the track', async () => {
  const { tr, truth } = await scripted((i, b) => (b && i <= 60 ? [{ ...b, S: 12 }] : []), { n: 30, N: 62, finish: false });
  const b = tr.branches[0], tail = [61, 62, 63].map(k => makeObservation({ index: k, t: k / 30, x: truth.get(60).x + 25 + 4 * (k - 61), y: truth.get(60).y + 30, sigma: 0.5, z: 9, polarity: 1, src: 'tbd' }));
  for (const o of tail) tr.record(b, o, 1);
  const h = tr.finish()[0];
  assert.equal(inliers(h).at(-1).index, 60);
  assert.ok(h.features.cuts.some(c => c.why === 'trailing_rejects'));
});

/* ---------------------------------------------------------------- composition fixes (check gaps 1, 2, 5; null history) */

test('gap 2: a probation the joint physics test cannot judge (jointOk null) commits, through evalProbation and endProbation', async () => {
  // A gap right after the 4-sample launch chain: the committed track has fewer than launchProfileObs inliers, so
  // jointOk really returns null ("cannot judge"); commitProbation used to dereference it (TypeError at joint.obs).
  const seen = [];
  class Spy extends FlightTracker {
    jointOk(b, pts) { const r = super.jointOk(b, pts); seen.push({ nInl: b.nInl, r }); return r; }
    commitProbation(b, joint) { seen.push({ commit: joint }); return super.commitProbation(b, joint); }
  }
  // evalProbation path: the ball is back for good after a 3-frame gap; endProbation path: back for 4 frames only.
  for (const [vis, after] of [[i => i < 35 || i > 37, 30], [i => i < 35 || (i > 37 && i <= 41), 4]]) {
    seen.length = 0;
    const { hyps } = await scripted((i, b) => (b && vis(i) ? [{ ...b, S: 12 }] : []), { n: 40, N: 80, Tracker: Spy });
    assert.ok(seen.some(e => 'r' in e && e.r === null && e.nInl < T.launchProfileObs), 'jointOk returned null for real');
    assert.ok(seen.some(e => 'commit' in e && e.commit === null), 'and the probation was committed with it');
    const post = inliers(hyps[0]).filter(o => o.index > 37);
    assert.ok(post.length >= after, `${post.length} post-gap inliers`);
  }
});

test('gap 1: a ball leaving the frame right after its launch chain ends at the edge (frame_exit), no pending deadlock, no wide late plans', async () => {
  // easy-15 / smoke-13 / smoke-17: the tracker stopped planning at the edge, its pending detections waited for crops
  // that never came, the coasting σ grew until the prediction "returned" and 5-10k px σ plans blew up the tube.
  const rec = [], W = 1080, H = 1920;
  const { tr, hyps, lastFrame } = await scripted((i, b) => (b && b.x < W ? [{ ...b, S: 12 }] : []),
    { n: 60, N: 150, d0: 11, m: 3, width: W, height: H, record: rec, ball: { x0: 570, y0: 1540, vx: 151, vy: -35, g: 0, drag: 0, size0: 100 } });
  assert.ok(lastFrame <= 36, `the tracker was done at frame ${lastFrame}`);
  assert.equal(rec.filter(r => r.call === 'plan' && r.i >= 34).length, 0, 'nothing planned once the prediction left the frame');
  assert.ok(Math.max(...rec.map(r => r.sigma)) <= tr.sigmaCap, 'every plan and detect within the σ cap');
  assert.equal(hyps[0].observedEnd, 'frame_exit');
  assert.ok(Math.abs(hyps[0].exitT - 34 / 30) < 1e-9, `exit at the first frame predicted outside (${hyps[0].exitT})`);
  // Pre-impact plans cover the address and the start of the law within one crop, as backgrounds only.
  const pre = rec.filter(r => r.call === 'plan' && r.i <= 30);
  assert.ok(pre.length > 0 && pre.every(r => r.pred.background === true && r.sigma <= PARAMS.roi.halfSize.maxPx / 3 + 1e-9), `pre-impact σ ${Math.max(...pre.map(r => r.sigma))}`);
});

test('gap 1: a fast two-sample launch that is never seen again: coasting σ never passes the frame-relative cap, the branch ends', async () => {
  // easy-17: two launch samples, the law's decay is unpinned and its σ grows ~100 px/frame; the old exit test (±2σ
  // outside) never fired because the σ grew with the excursion, so it coasted to 800+ px σ.
  const rec = [], W = 1080, H = 1920;
  for (const vis of [i => i <= 32, () => false]) {
    rec.length = 0;
    const { tr, hyps, lastFrame } = await scripted((i, b) => (b && b.x < W && vis(i) ? [{ ...b, S: 12 }] : []),
      { n: 60, N: 150, d0: 14, m: 2, width: W, height: H, record: rec, ball: { x0: 480, y0: 1358, vx: 300, vy: -190, g: 0, drag: 0.3, size0: 150 } });
    assert.ok(Math.max(...rec.map(r => r.sigma)) <= tr.sigmaCap, `max σ ${Math.max(...rec.map(r => r.sigma))} > cap ${tr.sigmaCap}`);
    assert.ok(lastFrame < 60, `ended at frame ${lastFrame}`);
    assert.ok(['exited', 'lost'].includes(hyps[0].state));
  }
  // In frame: a ball that fades after its chain is ended by the cap or the miss count, never searched with σ > cap.
  rec.length = 0;
  const fade = await scripted((i, b) => (b && i <= 34 ? [{ ...b, S: 12 }] : []), { n: 60, N: 150, m: 2, record: rec, ball: { x0: 360, y0: 1100, vx: 30, vy: -60, g: 0.3, drag: 0.15, size0: 60 } });
  assert.ok(Math.max(...rec.map(r => r.sigma)) <= fade.tr.sigmaCap);
  assert.equal(fade.hyps[0].state, 'lost');
});

test('gap 1: a launch-law coast stays inside the law\'s kinematic envelope where the law-vs-quadratic disagreement exploded', () => {
  // smoke-01 (synth-1.0): five chain samples, the ball missed by U4 for 12 frames. The law's mean stayed within
  // 13 px, but the disagreement with a quadratic through a projective deceleration pushed σ from 23 to 931 px.
  const fps = 30, N = 185, times = Float64Array.from({ length: N }, (_, i) => i / fps + 0.0036);
  const meta = makeSourceMeta({ width: 1080, height: 1920, fps, frameCount: N, times, duration: N / fps });
  const rows = [[64, 560.2, 1171.2], [65, 520.9, 1026.4], [66, 494, 931.1], [69, 452.1, 774.5], [70, 442.6, 743.9]];
  const samples = rows.map(([i, x, y]) => makeObservation({ index: i, t: times[i], x, y, sigma: 0.5, z: 12, z1: 12, d: null, polarity: 1, src: 'launch' }));
  const launch = makeLaunchCandidate({ id: 'L', hypId: 'H', t0: 2.1035917968749995, address: { x: 616.465, y: 1385.547 }, d0: 14.8, dir: { x: -0.2599762, y: -0.9656150 },
    v: 323.479, c: 0.3415, polarity: 1, samples, view: 'dtl', clubTrack: null, S: 20, margin: 10 });
  const tr = new FlightTracker(launch, { meta, log: null, impact: null, params: PARAMS }, { RoiTube: class { plan() { return []; } } });
  const b = tr.branches[0], truth = { 71: [435.7, 718.5], 74: [420.4, 665.0], 78: [406.7, 622.6], 82: [397.1, 597.4] };
  assert.ok(b.quad && b.mode === 'law', 'law mode with a local quadratic (the old explosion)');
  for (const [k, [x, y]] of Object.entries(truth)) {
    const p = tr.predict(b, +k), s = Math.sqrt(Math.max(p.cov[0], p.cov[2])), e = Math.hypot(p.x - x, p.y - y);
    assert.ok(s < 60, `frame ${k}: σ ${s.toFixed(1)} px`);
    assert.ok(e < 3 * s, `frame ${k}: error ${e.toFixed(1)} px vs σ ${s.toFixed(1)}`);
    assert.ok(Number.isFinite(p.ax) && Number.isFinite(p.ay) && p.svel > 0, 'acceleration and velocity σ for U4');
  }
});

test('gap 5 / null history: the tube gets ax, ay, sv = the velocity σ (3×3 grid while tracked), a nullKey per branch and probe on confirmations', async () => {
  // U4 picks its 5×5 velocity grid when sv exceeds one grid spacing; the tracker used to send the position σ over the
  // horizon as sv, so 96-99% of real detects ran the 2.8× costlier grid, and it sent no acceleration.
  const rec = [];
  const decoy = (i, b) => (i >= 45 && i <= 62 ? { x: b.x + 3.6 + (i > 50 ? 3 * (i - 50) : 0), y: b.y, S: 12 } : null);
  const { tr, hyps, truth, launch } = await scripted((i, b) => (b ? [{ ...b, S: 12 }, decoy(i, b)].filter(Boolean) : []), { d0: 2, record: rec });
  const det = rec.filter(r => r.call === 'detect' && !r.pred.probe), probes = rec.filter(r => r.call === 'detect' && r.pred.probe);
  assert.ok(det.length > 40 && det.every(r => Number.isFinite(r.pred.ax) && Number.isFinite(r.pred.ay) && Number.isFinite(r.pred.sv)));
  const root = det.filter(r => r.pred.nullKey === `${launch.id}/b0` && !r.pred.coasting && r.i > 40);
  assert.ok(root.length > 30 && root.every(r => r.pred.sv <= PARAMS.roi.tbd.spacing), `tracked root detects with sv > spacing: ${root.filter(r => r.pred.sv > PARAMS.roi.tbd.spacing).length}/${root.length}`);
  assert.ok(det.some(r => r.pred.coasting && r.pred.sv > PARAMS.roi.tbd.spacing), 'after misses the velocity σ grows (wide grid)');
  assert.ok(det.every(r => typeof r.pred.nullKey === 'string'));
  const kids = det.filter(r => r.pred.nullFrom);
  assert.ok(tr.stats.spawned >= 1 && kids.length > 0 && kids.every(r => r.pred.nullKey !== r.pred.nullFrom), 'MHT children search with their own null history, seeded from the parent');
  assert.ok(probes.length > 0 && probes.every(r => r.sigma <= 2.5), 'tight confirmations are flagged as probes');
  assert.equal(inliers(hyps[0]).filter(o => !near(o, truth.get(o.index), 1)).length, 0, 'the best branch is the ball');
});

/* ---------------------------------------------------------------- launch chain head (E5 follow-up) */

/**
 * Scripted run whose launch chain (m = 4 samples) starts `skip` path frames after the impact frame, so the frames
 * between t0 and the chain hold no chain point; objectsAt(i, truth) as for scripted().
 */
function chainAfter(skip, objectsAt, { ball = {}, N = 80, W = 720, Tracker = FlightTracker } = {}) {
  const impact = 30, b = { impact, x0: 520, y0: 1000, vx: 25, vy: -12, g: 0.3, drag: 0, n: 30, size0: 30, ...ball }, path = ballPath(b);
  const meta = makeSourceMeta({ width: W, height: 1280, fps: 30, frameCount: N, times: Float64Array.from({ length: N }, (_, i) => i / 30), duration: N / 30 });
  const camera = identityTrack(meta), truth = new Map(path.map(p => [p.i, p]));
  const launch = makeLaunch({ path: path.slice(skip), impact, d0: 6, m: 4, address: { x: b.x0, y: b.y0 } });
  const tr = new Tracker(launch, { meta, log: makeLog(meta, camera), impact: null, params: PARAMS }, { RoiTube: scriptTube(i => objectsAt(i, truth.get(i))), fitFlight: stubFitFlight });
  const crop = { data: new Uint8Array(1), w: 1, h: 1, x0: 0, y0: 0, pool: 1, valid: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  for (let i = tr.window().from; i < N && !tr.done; i++) { const reqs = tr.roiRequests(i); tr.consume(i, i / 30, reqs.map(() => crop), { a: 1, b: 0, tx: 0, ty: 0 }); }
  return { tr, hyps: tr.finish(), truth, launch };
}

test('launch chain head: a frame between t0 and the chain is no gap, so the points after the chain commit and the exit is confirmed', () => {
  // smoke-24 (synth-1.1, a duplicated frame right after t0): the tracker's miss there counted as a gap after the
  // chain (k54-60), the ball's TBD points k61-63 (1-2 px from GT) went to probation and the frame exit at k64
  // rejected them, so the ball's track ended 'lost' and its cast shadow's launch was drawn instead.
  const W = 720, seen = (i, b) => (b && b.x < W && i !== 31 ? [{ ...b, S: 12 }] : []);
  for (const skip of [0, 1]) {
    const { hyps, launch, tr } = chainAfter(skip, seen, { W });
    const h = hyps[0], inl = inliers(h), first = launch.samples[0].index;
    assert.equal(first, 31 + skip);
    assert.deepEqual(inl.map(o => o.index), [31, 32, 33, 34, 35, 36, 37].filter(k => k >= first), `skip ${skip}: inliers ${inl.map(o => o.index)}`);
    assert.deepEqual(inl.filter(o => o.src === 'tbd').map(o => o.index), [35, 36, 37].filter(k => k > first + 3), `skip ${skip}: tracker points after the chain`);
    assert.equal(h.observations.filter(o => o.flag !== 'inlier').length, 0, `skip ${skip}: nothing rejected`);
    assert.equal(h.features.probationRejects, 0);
    assert.equal(h.observedEnd, 'frame_exit', `skip ${skip}`);
    assert.ok(h.exitT - inl.at(-1).t <= (PARAMS.decide.exitWithinFrames + 0.5) / 30);
    assert.equal(tr.headIndex, launch.samples.at(-1).index);
  }
  // the chain stands for its frames: nothing is associated behind its head, not even an object on the prediction
  const decoy = (i, b) => (i === 31 ? [{ x: 545, y: 988, S: 12 }] : seen(i, b));
  const { hyps } = chainAfter(1, decoy, { W });
  assert.equal(hyps[0].observations.filter(o => o.index <= 35 && o.src !== 'launch').length, 0, 'no tracker observation behind the chain head');
});
