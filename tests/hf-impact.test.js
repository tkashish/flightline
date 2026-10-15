// U3 impact hypotheses: findImpacts, tauPriorFromStep, swingEnvelope, impactInterval, arrivalVetoes and lastToLeave on
// hand-built CoarseLog fixtures, plus cross-unit scenes from the coarse scan's own output (U2 -> U3, checker gaps 6, 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, mergeParams, spanFrames } from '../dist/hf/params.js';
import { make, makeCoarseLog, makeSourceMeta, identityTrack, check } from '../dist/hf/types.js';
import { findImpacts, tauPriorFromStep, swingEnvelope, impactInterval, arrivalVetoes, lastToLeave, castShadows } from '../dist/hf/impact.js';
import * as spots from '../dist/hf/spots.js';
import { CoarseScanner } from '../dist/hf/coarse-scan.js';
import { LaunchConfirmer } from '../dist/hf/launch-null.js';
import { poolLuma, coarsePool, simAt } from '../dist/hf/types.js';
import { makeClip, runSpots, ballPath, landscape } from './hf/helpers/u2-scene.mjs';
import { makeImpactScene, onBall } from './hf/helpers/impact-scene.mjs';

const FPS = 60, N = 360;
const meta = makeSourceMeta({ width: 1080, height: 1920, fps: FPS, frameCount: N, times: Float64Array.from({ length: N }, (_, k) => k / FPS), duration: N / FPS });

/** Energy store from a list of moving discs {x, y, r, k0, k1}: a cell is active when a disc covers it at frame k. */
function energyStore(blobs = [], cellPx = 8) {
  const covers = (k, x, y, r) => blobs.some(b => k >= b.k0 && k <= b.k1 && Math.hypot(b.x + (b.vx ?? 0) * (k - b.k0) - x, b.y + (b.vy ?? 0) * (k - b.k0) - y) <= b.r + r);
  return {
    cellPx,
    disk(x, y, r, i0, i1) {
      const index = [], e = [];
      for (let k = Math.max(0, i0); k <= Math.min(N - 1, i1); k++) {
        index.push(k);
        let s = 0.01;  // a little noise energy so medians are not zero
        for (const b of blobs) {
          if (k < b.k0 || k > b.k1) continue;
          const bx = b.x + (b.vx ?? 0) * (k - b.k0), by = b.y + (b.vy ?? 0) * (k - b.k0), d = Math.hypot(bx - x, by - y);
          if (d <= r + b.r) s += (b.e ?? 100) * Math.min(1, (r + b.r - d) / (2 * b.r));
        }
        e.push(s);
      }
      return { index: Int32Array.from(index), e: Float32Array.from(e) };
    },
    active: (k, x, y, r) => (covers(k, x, y, r) ? 1 : 0)
  };
}

function spot(over = {}) {
  return make('Spot', {
    id: 's1', x: 540, y: 1500, d: 16, polarity: 1, contrast: 120, z: 30, firstIndex: 20, lastIndex: 120, presence: 0.98,
    roundness: 1.1, fill: 0.8, ballLike: true, arrivalMovers: 0, clusterId: 1, ...over
  });
}
function vacate(over = {}) {
  const kLast = over.kLast ?? 120;
  return make('VacateEvent', {
    spotId: 's1', kLast, tLast: kLast / FPS, kFirstAbsent: kLast + 1, tFirstAbsent: (kLast + 1) / FPS, absenceRatio: 1, ncc: 0.1,
    postStable: 0.95, impulse: { step1D0: 8.3, step2D0: 7.9, ok: true }, gradualDeparture: false, recovered: false, valid: true, ...over
  });
}
function log({ spots = [spot()], vacates = [vacate()], energy = energyStore() } = {}) {
  const index = Int32Array.from({ length: N }, (_, k) => k);
  return makeCoarseLog({
    pool: 2, w: 540, h: 960, stride: 1, frames: { index, t: Float64Array.from(index, k => k / FPS) }, camera: identityTrack(meta),
    spots, vacates, energy, horizon: null, movers: [], specks: []
  });
}

test('a valid vacate of a ball-like spot gives one valid ImpactHypothesis with the D1 impact interval widened by the timing tolerance', () => {
  const hyps = findImpacts(log(), meta);
  assert.equal(hyps.length, 1);
  const h = hyps[0];
  assert.deepEqual(check('ImpactHypothesis', h), []);
  assert.deepEqual(h.address, { x: 540, y: 1500 });
  assert.equal(h.d0, 16);
  assert.equal(h.kLast, 120);
  // [t(k_last − 2) − Δ/4, t(k_firstAbsent + 2) + Δ/4]: the coarse k_last is 1-2 frames off around a club (gap 6)
  const tol = PARAMS.impact.timingTolFrames;
  assert.equal(tol, 2);
  assert.ok(Math.abs(h.interval.t0 - (120 - tol - 0.25) / FPS) < 1e-9 && Math.abs(h.interval.t1 - (121 + tol + 0.25) / FPS) < 1e-9, JSON.stringify(h.interval));
  assert.ok(h.t0Est >= h.interval.t0 && h.t0Est <= h.interval.t1);
  assert.ok(Math.abs(h.t0Est - 120.5 / FPS) < 1e-9, 't0Est stays mid-way between the coarse frames');
  // without the tolerance it is D1's interval exactly
  const [h0] = findImpacts(log(), meta, { params: mergeParams({ impact: { timingTolFrames: 0 } }) });
  assert.ok(Math.abs(h0.interval.t0 - (120 - 0.25) / FPS) < 1e-9 && Math.abs(h0.interval.t1 - (121 + 0.25) / FPS) < 1e-9);
});

test('impactInterval follows the frame times (VFR) and extrapolates by 1/fps outside the clip', () => {
  const times = Float64Array.from([0, 0.03, 0.07, 0.1, 0.16, 0.2, 0.23]);
  const vfr = makeSourceMeta({ width: 1080, height: 1920, fps: 30, frameCount: 7, times, duration: 0.26 });
  const iv = impactInterval(vfr, 3, 4, PARAMS);
  assert.ok(Math.abs(iv.t0 - (times[1] - 0.25 / 30)) < 1e-12 && Math.abs(iv.t1 - (times[6] + 0.25 / 30)) < 1e-12, JSON.stringify(iv));
  const edge = impactInterval(vfr, 1, 2, PARAMS);
  assert.ok(Math.abs(edge.t0 - (times[0] - 1 / 30 - 0.25 / 30)) < 1e-12, 'before the first frame');
});

test('practice swing: no valid vacate (the ball never leaves) gives no hypothesis', () => {
  assert.deepEqual(findImpacts(log({ vacates: [] }), meta), []);
  assert.deepEqual(findImpacts(log({ vacates: [vacate({ valid: false })] }), meta), []);
  // a club passing over the ball occludes it, presence recovers: an occlusion, not a departure
  assert.deepEqual(findImpacts(log({ vacates: [vacate({ recovered: true })] }), meta), []);
});

test('glove takeaway: a gradual departure (the veto fired) gives no hypothesis', () => {
  const glove = spot({ id: 'g', d: 40, y: 1100 });
  const v = vacate({ spotId: 'g', gradualDeparture: true, impulse: { step1D0: 0.1, step2D0: 0.25, ok: false } });
  assert.deepEqual(findImpacts(log({ spots: [glove], vacates: [v] }), meta), []);
});

test('arrival veto: a spot that a mover arrived at and paused (hands at the top) is not an address, time-limited', () => {
  // the spot appeared 60 frames (1 s) before it left: within r1Window = max(30 frames, 1.5 s real) = 90 frames
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 1, firstIndex: 60 })] }), meta).length, 0);
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 0, firstIndex: 60 })] }), meta).length, 1);
  // a spot that stayed 100 frames after something arrived is an address again (FINAL: every rule is time-limited)
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 1, firstIndex: 20 })] }), meta).length, 1);
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 1, firstIndex: 120 - 90 })] }), meta).length, 0, 'exactly the window');
  // the window is in real seconds: 8x slow motion (capture-rate hint) stretches it to 12 s of video
  const slow = makeSourceMeta({ ...meta, captureFpsHint: 480 });
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 1, firstIndex: 20 })] }), slow).length, 0);
  // without a hint a slow-motion-looking first step does not stretch it (real clip: a ball raked in, hit 2.9 s later,
  // its first step half hidden by the club read as 240 fps)
  const step = { impulse: { step1D0: 2.6, step2D0: 2.0, ok: true } };
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 2, firstIndex: 20 })], vacates: [vacate(step)] }), meta).length, 1);
  assert.equal(findImpacts(log({ spots: [spot({ arrivalMovers: 2, firstIndex: 60 })], vacates: [vacate(step)] }), meta).length, 0, 'still vetoed within 1.5 s');
});

test('arrivalVetoes and lastToLeave (U3 owns both): time-limited, τ scales the real-second part, clusters pairwise', () => {
  const win = spanFrames(PARAMS.impact.r1Window, 30);
  assert.equal(win, 45);
  assert.equal(arrivalVetoes(2, 20, 30), true);
  assert.equal(arrivalVetoes(2, win, 30), true);
  assert.equal(arrivalVetoes(2, win + 1, 30), false);
  assert.equal(arrivalVetoes(0, 20, 30), false);
  assert.equal(arrivalVetoes(2, win + 1, 30, PARAMS, 8), true, '1.5 s real at 8x is 360 frames');
  const ev = (kLast, x = 0, d = 10, tauW = 1) => ({ kLast, x, y: 0, d, tauW });
  assert.deepEqual(lastToLeave([ev(30), ev(50)], 30), [1, -1]);
  assert.deepEqual(lastToLeave([ev(30), ev(38)], 30), [-1, -1], 'closer than 0.3 s');
  assert.deepEqual(lastToLeave([ev(30), ev(39)], 30), [1, -1], 'exactly 0.3 s');
  assert.deepEqual(lastToLeave([ev(30), ev(76)], 30), [-1, -1], 'beyond max(30 frames, 1.5 s)');
  assert.deepEqual(lastToLeave([ev(30), ev(76, 0, 10, 2)], 30), [1, -1], 'the τ window of either event');
  assert.deepEqual(lastToLeave([ev(10), ev(30), ev(50)], 30), [2, 2, -1], 'the last one wins');
  // D1 §3.3(4) "<= 4·D apart" pairwise: a chain of spots (A-B-C) does not make A and C one cluster
  assert.deepEqual(lastToLeave([ev(30, 0), ev(50, 60)], 30), [-1, -1]);
  assert.deepEqual(lastToLeave([ev(30, 0), ev(40, 30), ev(50, 60)], 30), [1, 2, -1], 'each is superseded by its own neighbour');
  assert.deepEqual(lastToLeave([ev(30, 0), ev(50, 40)], 30), [1, -1], 'exactly clusterD·D apart');
  // the mean diameter, not the larger one: d 10 and 30 at 100 px (4·20 = 80 < 100 < 4·30 = 120)
  assert.deepEqual(lastToLeave([ev(30, 0, 10), ev(50, 100, 30)], 30), [-1, -1]);
  assert.deepEqual(lastToLeave([ev(30, 0, 10), ev(50, 80, 30)], 30), [1, -1]);
});

test('spot gates: not ball-like, too short a dwell, or too little presence gives no hypothesis', () => {
  assert.equal(findImpacts(log({ spots: [spot({ ballLike: false })] }), meta).length, 0);
  const dwell = Math.max(PARAMS.scan.spot.minDwell.frames, Math.ceil(PARAMS.scan.spot.minDwell.sec * FPS));
  assert.equal(findImpacts(log({ spots: [spot({ firstIndex: 121 - dwell + 1 })] }), meta).length, 0);
  assert.equal(findImpacts(log({ spots: [spot({ firstIndex: 121 - dwell })] }), meta).length, 1);
  assert.equal(findImpacts(log({ spots: [spot({ presence: 0.7 })] }), meta).length, 0);
});

test('two balls, one hit: only the vacated one becomes a hypothesis', () => {
  const a = spot({ id: 'a', x: 540 }), b = spot({ id: 'b', x: 600, clusterId: 1 });
  const hyps = findImpacts(log({ spots: [a, b], vacates: [vacate({ spotId: 'a' })] }), meta);
  assert.equal(hyps.length, 1);
  assert.equal(hyps[0].spotId, 'a');
});

test('R1 last-to-leave is time-limited: the earlier vacate in a cluster loses only inside the window', () => {
  // the club head (or a glove) parked beside the ball leaves at takeaway, the ball 0.9 s later
  const club = spot({ id: 'c', x: 560, d: 20 }), ball = spot({ id: 'b', x: 540 });
  const take = vacate({ spotId: 'c', kLast: 66 }), hit = vacate({ spotId: 'b', kLast: 120 });
  let hyps = findImpacts(log({ spots: [club, ball], vacates: [take, hit] }), meta);
  assert.deepEqual(hyps.map(h => h.spotId), ['b']);
  // more than max(30 frames, 1.5 s real) apart: two independent shots, both kept
  const early = vacate({ spotId: 'c', kLast: 120 - Math.ceil(1.6 * FPS) });
  hyps = findImpacts(log({ spots: [club, ball], vacates: [early, hit] }), meta);
  assert.equal(hyps.length, 2);
  // closer than r1MinGap (0.3 s): R1 does not apply
  const near = vacate({ spotId: 'c', kLast: 120 - Math.floor(0.2 * FPS) });
  hyps = findImpacts(log({ spots: [club, ball], vacates: [near, hit] }), meta);
  assert.equal(hyps.length, 2);
  // different clusters never compete
  hyps = findImpacts(log({ spots: [spot({ id: 'c', x: 900, clusterId: 2 }), ball], vacates: [take, hit] }), meta);
  assert.equal(hyps.length, 2);
  // the cluster is pairwise distance (clusterD mean diameters), never the transitive clusterId (report-only)
  hyps = findImpacts(log({ spots: [spot({ id: 'c', x: 560, d: 20, clusterId: 7 }), ball], vacates: [take, hit] }), meta);
  assert.deepEqual(hyps.map(h => h.spotId), ['b'], 'different clusterId, 20 px apart: one cluster');
  hyps = findImpacts(log({ spots: [spot({ id: 'c', x: 540 + 4 * 18 + 1, d: 20 }), ball], vacates: [take, hit] }), meta);
  assert.equal(hyps.length, 2, 'same clusterId, beyond clusterD mean diameters: no R1');
});

test('R1 window follows the τ prior: a slow-motion first step stretches the window', () => {
  // 30 fps container, 240 fps capture: the ball's first step is ~2.8 d0/frame, so 1.5 s real is 12 s of video
  const m30 = makeSourceMeta({ width: 1080, height: 1920, fps: 30, frameCount: N, times: Float64Array.from({ length: N }, (_, k) => k / 30), duration: N / 30 });
  const club = spot({ id: 'c', x: 560, firstIndex: 0 }), ball = spot({ id: 'b', x: 540, firstIndex: 0, lastIndex: 300 });
  const take = vacate({ spotId: 'c', kLast: 100, tLast: 100 / 30, tFirstAbsent: 101 / 30, impulse: { step1D0: 2.8, step2D0: 2.7, ok: true } });
  const hit = vacate({ spotId: 'b', kLast: 300, tLast: 10, tFirstAbsent: 301 / 30, impulse: { step1D0: 2.8, step2D0: 2.7, ok: true } });
  const L = log({ spots: [club, ball], vacates: [take, hit] });
  assert.deepEqual(findImpacts(L, m30).map(h => h.spotId), ['b']);
  // the same 200-frame gap with a real-time first step is beyond the window: both kept
  const rt = s => ({ ...s, impulse: { step1D0: 11.8, step2D0: 11, ok: true } });
  assert.equal(findImpacts(log({ spots: [club, ball], vacates: [rt(take), rt(hit)] }), m30).length, 2);
});

test('hypotheses are capped and ranked by vacate quality, never by size', () => {
  const spots = [], vacates = [];
  for (let i = 0; i < 6; i++) {
    spots.push(spot({ id: `s${i}`, x: 100 + 150 * i, d: 10 + 10 * i, clusterId: 10 + i }));
    vacates.push(vacate({ spotId: `s${i}`, absenceRatio: 0.9 + 0.02 * (5 - i) }));  // the biggest spot vacates worst
  }
  const four = { params: mergeParams({ impact: { maxHypotheses: 4 } }) }, hyps = findImpacts(log({ spots, vacates }), meta, four);
  assert.equal(hyps.length, 4);
  assert.deepEqual(hyps.map(h => h.spotId), ['s0', 's1', 's2', 's3']);
  assert.equal(findImpacts(log({ spots, vacates }), meta).length, Math.min(6, PARAMS.impact.maxHypotheses));
  assert.equal(findImpacts(log({ spots, vacates }), meta, { params: mergeParams({ impact: { maxHypotheses: 2 } }) }).length, 2);
});

test('pass energy and club passage: a club pass at the vacate scores, quiet frames do not', () => {
  const pass = energyStore([{ x: 400, y: 1500, r: 30, k0: 117, k1: 121, vx: 40, vy: 0, e: 400 }]);
  const [h] = findImpacts(log({ energy: pass }), meta);
  assert.ok(h.scores.passEnergy > 0, `passEnergy ${h.scores.passEnergy}`);
  assert.ok(h.scores.clubPassage > Math.log(PARAMS.impact.clubPassage.supportRatio), `clubPassage ${h.scores.clubPassage}`);
  const [q] = findImpacts(log({ energy: energyStore() }), meta);
  assert.equal(q.scores.passEnergy, 0);
  assert.ok(h.scores.vacate > q.scores.vacate);
  // a pass a second earlier (takeaway) does not support this vacate
  const [e] = findImpacts(log({ energy: energyStore([{ x: 400, y: 1500, r: 30, k0: 50, k1: 54, vx: 40, vy: 0, e: 400 }]) }), meta);
  assert.equal(e.scores.passEnergy, 0);
});

test('tauPriorFromStep: the first step picks the capture rate; weights sum to 1', () => {
  const sum = p => p.weights.reduce((a, b) => a + b, 0);
  const argmax = p => p.modes[p.weights.indexOf(Math.max(...p.weights))];
  const rt = tauPriorFromStep(11.8, 'dtl', PARAMS, 30), slow = tauPriorFromStep(2.8, 'dtl', PARAMS, 30), fo = tauPriorFromStep(12.5, 'fo', PARAMS, 30);
  assert.ok(Math.abs(sum(rt) - 1) < 1e-9 && Math.abs(sum(slow) - 1) < 1e-9);
  assert.equal(argmax(rt), 1);
  assert.equal(argmax(slow), 8);
  assert.equal(argmax(fo), 4);  // face-on 12.5 d0/frame is 120 fps capture
  assert.deepEqual(tauPriorFromStep(null, 'unknown', PARAMS, 30).modes, [...PARAMS.impact.tau.modes]);
  // a 240 fps real-time container with a 2.8 d0 step is real time, not 8x
  assert.equal(argmax(tauPriorFromStep(2.8, 'dtl', PARAMS, 240)), 1);
});

test('captureFpsHint overrides the step prior', () => {
  const m = makeSourceMeta({ ...meta, fps: 30, times: Float64Array.from({ length: N }, (_, k) => k / 30), duration: N / 30, captureFpsHint: 240 });
  const [h] = findImpacts(log(), m);
  assert.equal(h.tauPrior.weights[h.tauPrior.modes.indexOf(8)], 1);
});

test('swingEnvelope covers the swing motion around the address, dilated by d0, and is null without energy', () => {
  const store = energyStore([{ x: 540, y: 1200, r: 12, k0: 90, k1: 125, vx: 0, vy: 8 }]);
  const L = log({ energy: store });
  const [h] = findImpacts(L, meta);
  const env = h.envelope;
  assert.deepEqual(check('SwingEnvelope', env), []);
  const at = (x, y) => { const i = Math.floor((x - env.x0) / env.cellPx), j = Math.floor((y - env.y0) / env.cellPx); return env.mask[j * env.w + i]; };
  assert.equal(at(540, 1300), 1);      // on the mover's path
  assert.equal(at(540 + 200, 1300), 0);  // far from it
  assert.equal(swingEnvelope({ ...L, energy: null }, h, meta, PARAMS), null);
});

/* ------------------------------------------------------------------ cross-unit: the coarse scan's output (U2 -> U3) */

// U2's pixel-level vacate scenes (coarse 270×480 at pool 2, 30 fps) through spots.js, then findImpacts: the coarse
// scan only measures, U3 decides (checker gap 11)
const CW = 270, CH = 480, BX = 135, BY = 330, CR = 3, CD0 = 4 * CR;
const cbg = landscape({ seed: 3, horizonY: 150, texture: 55 });
const clipOf = (objects, n = 72) => makeClip({ w: CW, h: CH, n, pool: 2, bg: cbg, objects, noise: 1.5, seed: 2, fps: 30 });
const scanned = (objects, { n = 72, hint = 30 } = {}) => {
  const clip = clipOf(objects, n), res = runSpots(spots, clip), m = makeSourceMeta({ ...clip.meta, captureFpsHint: hint });
  return { res, hyps: findImpacts({ spots: res.spots, vacates: res.vacates, stride: 1 }, m), meta: m };
};
const at = (list, x = 2 * BX, y = 2 * BY) => list.filter(h => Math.hypot(h.address.x - x, h.address.y - y) < 0.5 * CD0);

test('U2 -> U3 arrival veto: a body part that arrives and pauses 0.6 s is no address; after 2 s the veto lapses (τ = 1)', () => {
  const arriving = (kA, kH) => ({ at: k => { if (k < kA) { const j = kA - k; return { x: BX - 0.4 * j * j, y: BY, rx: CR, luma: 235 }; } if (k <= kH) return { x: BX, y: BY, rx: CR, luma: 235 }; const j = k - kH; return { x: BX + 2 * j, y: BY - 20 * j, rx: CR, luma: 235 }; } });
  const short = scanned([arriving(20, 38)]);
  assert.equal(short.res.vacates.filter(v => v.valid).length, 1, 'the coarse scan leaves it valid');
  assert.equal(at(short.hyps).length, 0, 'U3 vetoes it');
  const long = scanned([arriving(10, 70)], { n: 100 });
  assert.equal(at(long.hyps).length, 1, 'arrived the same way, left 2 s later');
  // with an 8x slow-motion capture hint 2 s of video is 0.25 s real: still vetoed
  assert.equal(at(scanned([arriving(10, 70)], { n: 100, hint: 240 }).hyps).length, 0);
});

test('U2 -> U3 R1: of two vacates in one address cluster only the last stands, time-limited both ways', () => {
  const pair = (k1, k2, n = 72) => scanned([ballPath({ x: BX - 15, y: BY, r: CR, kHit: k1, vx: -2, vy: -20 }), ballPath({ x: BX, y: BY, r: CR, kHit: k2, vx: 2, vy: -20 })], { n });
  const p = pair(30, 50);
  assert.equal(p.res.vacates.filter(v => v.valid).length, 2, 'both valid in the coarse scan');
  assert.deepEqual(p.hyps.map(h => h.kLast), [50]);
  assert.equal(pair(20, 75, 100).hyps.length, 2, 'more than r1Window apart: both stand');
  assert.equal(pair(40, 43).hyps.length, 2, 'less than r1MinGap apart: both stand');
});

test('U2 -> U3 seam: the coarse scan of a struck ball gives the hypothesis the LaunchConfirmer confirms, t0 inside its interval', () => {
  // U3's pixel scene (down the line, 60 fps), pooled to the coarse size and scanned by U2's real CoarseScanner;
  // findImpacts' hypothesis (address, d0, the interval with the timing tolerance) goes straight to the confirmer
  const sc = makeImpactScene({ view: 'dtl', fps: 60, tau: 1, club: 'iron', shutter: 1 / 2000, seed: 169 }), m = sc.meta, g = sc.gt;
  const P = mergeParams({ scan: { longEdge: 480 } }), pool = coarsePool(m.width, m.height, 480), scan = new CoarseScanner(m, { params: P });
  for (let k = 0; k < m.frameCount; k++) scan.push(k, m.times[k], { ...poolLuma(sc.frame(k), m.width, m.height, pool), pool });
  const lg = scan.finish(), hyps = findImpacts(lg, m, { params: P });
  const h = hyps.find(q => Math.hypot(q.address.x - g.address.x, q.address.y - g.address.y) < g.d0);
  assert.ok(h, JSON.stringify(hyps.map(q => [q.kLast, q.address])));
  assert.ok(Math.abs(h.kLast - g.kImpact) <= PARAMS.impact.timingTolFrames, `coarse k_last ${h.kLast} vs ${g.kImpact}`);
  assert.ok(g.tImpact >= h.interval.t0 && g.tImpact <= h.interval.t1, 'the true impact lies in the interval');
  const lc = new LaunchConfirmer(h, { meta: m, log: lg, params: P }), { from, to } = lc.window();
  for (let k = Math.max(0, from); k < Math.min(m.frameCount, to); k++) lc.consume(k, m.times[k], lc.roiRequests(k).map(q => sc.crop(k, q.rect, q.pool)), simAt(lg.camera, k));
  const d = lc.finish(), c = d.candidate;
  assert.equal(d.accepted, true, d.reason);
  assert.ok(c.samples.filter(q => onBall(sc, q.index, q)).length >= Math.ceil(c.samples.length / 2), 'on the ball');
  assert.ok(c.t0 >= h.interval.t0 && c.t0 <= h.interval.t1 && c.t0 < c.samples[0].t, `t0 ${c.t0} in ${JSON.stringify(h.interval)}`);
  assert.ok(Math.abs(c.t0 - g.tImpact) * m.fps < 0.5, `t0 ${(c.t0 * m.fps).toFixed(2)} vs ${(g.tImpact * m.fps).toFixed(2)} frames`);
});

/* ---------------------------------------------------------------- cast shadows (E5 follow-up) */

test('cast-shadow rule: a dark vacate leaving with a bright one in its address cluster is the ball\'s shadow, not a hypothesis', () => {
  // smoke-24 (synth-1.1, sunny): the ball's shadow (contrast -65, 1.8·d0 below-right) vacated in the ball's frame;
  // its dark launch beat the ball's on null margin and was drawn as 'tracked' at 0.98. 5 of 34 frozen runs have one.
  const ball = spot({ id: 'b' }), shadow = spot({ id: 'sh', x: 554, y: 1520, d: 20, polarity: -1, contrast: -60 });
  const hit = vacate({ spotId: 'b' }), gone = (k, o = {}) => vacate({ spotId: 'sh', kLast: k, ...o });
  const ids = (sps, vs, opts) => findImpacts(log({ spots: sps, vacates: vs }), meta, opts).map(h => h.spotId).sort();
  assert.deepEqual(ids([ball, shadow], [hit, gone(120)]), ['b']);
  // simultaneous within the coarse scan's timing tolerance, either way; one frame more and they are two departures
  const tol = PARAMS.impact.timingTolFrames;
  for (const dk of [-tol, tol]) assert.deepEqual(ids([ball, shadow], [hit, gone(120 + dk)]), ['b'], `dk ${dk}`);
  assert.deepEqual(ids([ball, shadow], [hit, gone(120 + tol + 1)]), ['b', 'sh']);
  // the shadow takes no hypothesis slot, even when it vacates better than the ball
  const one = { params: mergeParams({ impact: { maxHypotheses: 1 } }) };
  assert.deepEqual(ids([ball, shadow], [vacate({ spotId: 'b', absenceRatio: 0.9 }), gone(120, { absenceRatio: 1 })], one), ['b']);
  // a dark spot alone stands (D3 §3.2: a ball may be darker than a white mat), so does one beyond the address cluster
  assert.deepEqual(ids([shadow], [gone(120)]), ['sh']);
  const far = spot({ id: 'sh', x: 540 + 4 * 18 + 1, d: 20, polarity: -1, contrast: -60 });
  assert.deepEqual(ids([ball, far], [hit, gone(120)]), ['b', 'sh'], 'beyond clusterD mean diameters');
  // two bright co-timed spots (a ball and a white tee) are no shadow pair; a bright spot that stayed casts nothing
  assert.deepEqual(ids([ball, spot({ id: 'sh', x: 554, y: 1520, d: 20 })], [hit, gone(120)]), ['b', 'sh']);
  assert.deepEqual(ids([ball, shadow], [gone(120)]), ['sh'], 'the bright neighbour never left');
});

test('castShadows (U3, the co-timed complement of R1): the nearest bright co-timed neighbour in the cluster supersedes a dark event', () => {
  const ev = (kLast, x, polarity, d = 10) => ({ kLast, x, y: 0, d, polarity });
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(30, 15, -1)]), [-1, 0]);
  assert.deepEqual(castShadows([ev(30, 15, -1), ev(30, 0, 1)]), [1, -1], 'order-free');
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(32, 15, -1), ev(33, 15, -1)]), [-1, 0, -1], 'impact.timingTolFrames');
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(30, 40, -1)]), [-1, 0], 'exactly clusterD mean diameters');
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(30, 41, -1)]), [-1, -1]);
  assert.deepEqual(castShadows([ev(30, 0, -1), ev(30, 15, -1)]), [-1, -1], 'dark with dark');
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(30, 15, 1)]), [-1, -1], 'a bright event is never a shadow');
  assert.deepEqual(castShadows([ev(30, -30, 1), ev(30, 0, -1), ev(30, 10, 1)]), [-1, 2, -1], 'the nearest bright one');
  assert.deepEqual(castShadows([ev(30, 0, 1), ev(30, 15, -1)], mergeParams({ impact: { timingTolFrames: 0 } })), [-1, 0], 'same frame always counts');
});
