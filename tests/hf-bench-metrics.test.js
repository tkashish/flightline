import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../dist/hf/params.js';
import {
  wilson, quantile, bootstrapCI, ece, cameraAt, toRawPx, scoredView, gtIndex, matchRadius, clipClass, clipSet, recallBins, arcAt,
  distToArc, arcAlign, scoreClip, summarize, aggregate, parity, compareEngines, pinCheck, assertSamePin, ACCEPTANCE_SPEC, DEFINITIONS
} from './bench/metrics.mjs';
import { checkGate, flipDecision, getPath } from './bench/gate.mjs';

/* ---------------------------------------------------------------- fixtures: GT in the generator schema */

const W = 1000, H = 1000, FPS = 30, N = 90, T0 = 1 + 0.4 / FPS, ADDR = { x: 500, y: 900 }, D0 = 10;
const DIAG = Math.hypot(W, H);
const ballAt = t => { const u = Math.max(0, t - T0); return { x: ADDR.x + 100 * u, y: ADDR.y - 600 * u + 150 * u * u, diam: D0 / (1 + 4 * u) }; };
const clubAt = t => ({ x: ADDR.x + 300 * (t - T0), y: ADDR.y + 5 - 100 * (t - T0), size: 25 });
const FLIGHT = 4; // real seconds until the ball is back at address height
const BALL = ballAt, FLIGHT_SEC = FLIGHT;
// Down the line: the ball rises almost straight up the frame and its descent comes back down over the ascent,
// landing 250 px above the address (2.9 s), 7 px beside the ascent at that height.
const DTL_LAND = 2.9, dtlAt = t => { const u = Math.max(0, t - T0); return { x: ADDR.x + 3 * u, y: ADDR.y - 550 * u + 160 * u * u, diam: D0 / (1 + 4 * u) }; };

/**
 * A down-the-line hit on a 1000×1000, 30 fps clip: impact between frames 30 and 31, a parabola landing in frame at
 * t0 + 4 s (after the 3 s clip ends). Options override the club, SNR, occlusion, distractors and labels.
 */
function makeGt(o = {}) {
  const snr = o.snr ?? (t => 30 / (1 + 3 * Math.max(0, t - T0))), ballAt = o.at ?? BALL, FLIGHT = o.flight ?? FLIGHT_SEC;
  const club = o.club ?? clubAt, occluded = o.occluded ?? (() => false), diamAt = o.diam ?? (t => ballAt(t).diam);
  const frames = Array.from({ length: N }, (_, i) => {
    const t = i / FPS, b = ballAt(t), c = club(t), post = t > T0;
    return {
      i, t, tc: t - T0,
      ball: o.noBall ? null : { x: b.x, y: b.y, diam: diamAt(t), inFrame: b.x >= 0 && b.y >= 0 && b.x < W && b.y < H, occluded: occluded(i), visibleFrac: occluded(i) ? 0 : 1,
        expectedSnr: snr(t) / 0.6, snrCoded: snr(t), state: post && !o.noFlight ? 'flight' : 'address' },
      club: { x: c.x, y: c.y, size: c.size, inFrame: true },
      distractors: (o.distractors ?? (() => []))(i, t)
    };
  });
  const arc2d = [];
  for (let u = 0; u <= FLIGHT + 1e-9; u += 1 / FPS) { const b = ballAt(T0 + u); arc2d.push({ t: T0 + u, x: b.x, y: b.y, inFrame: true, diam: b.diam }); }
  const land = ballAt(T0 + FLIGHT);
  return {
    schema: 'flightline-synth-gt-v1', id: o.id ?? 'clip', split: o.split ?? 'tune', expected: o.expected ?? 'trace',
    failureModes: o.failureModes ?? ['F1'], styleShift: false,
    meta: {
      kind: o.kind ?? 'hit',
      factors: { viewClass: o.viewClass ?? 'dtl', capture: '30', format: `${W}x${H}`, sky: 'blue', codec: 'h264', confounders: o.confounders ?? {} },
      video: { width: W, height: H, fpsOut: FPS, captureFps: o.captureFps ?? FPS, playbackFactor: 1, slowmo: false, frameCount: N, durationS: N / FPS }
    },
    impact: o.noImpact ? null : { t0: T0, frame: 31, lastAddressFrame: 30, address: { ...ADDR }, ballDiameterPx: D0 },
    landing: o.noImpact ? null : { t: T0 + FLIGHT, x: land.x, y: land.y, inFrame: true },
    arc2d: o.noImpact ? [] : arc2d, frames
  };
}

/* ---------------------------------------------------------------- fixtures: results */

const ft = k => k / FPS;
const norm = p => ({ x: p.x / W, y: p.y / H });
const IDENTITY_CAMERA = [{ t: 0, x: 0, y: 0, s: 1, r: 0 }, { t: 10, x: 0, y: 0, s: 1, r: 0 }];

/**
 * An hf-shaped result in normalized stabilized coordinates (identity camera unless given): anchor at the launch,
 * one observed point per frame in `frames` placed by at(t) (raw px), then predicted points every 1/120 s until
 * predTo placed by predAt(t), with alpha(t).
 */
function hfResult({ frames = [], at = ballAt, predTo = null, predAt = ballAt, alpha = () => 1, status = 'tracked', launch = { t: T0, ...ADDR }, confidence = 0.9, camera = IDENTITY_CAMERA, end = 'landing' } = {}) {
  const obs = frames.map(k => ({ t: ft(k), ...norm(at(ft(k))), sigma: 0.5 / DIAG }));
  const points = [{ t: launch.t, ...norm(launch), status: 'anchor' }, ...obs.map(o => ({ t: o.t, x: o.x, y: o.y, status: 'observed' }))];
  const last = obs.at(-1)?.t ?? launch.t;
  if (predTo != null) for (let t = last + 1 / 120; t <= predTo + 1e-9; t += 1 / 120) { const a = alpha(t); points.push({ t, ...norm(predAt(t)), status: 'predicted', ...(a < 1 ? { alpha: a } : {}) }); }
  const e = points.at(-1);
  return {
    engine: 'hf', status, reasonCodes: [], points, observations: obs, camera, observedFrames: obs.length,
    confidence: { value: confidence, calibratedOn: 'synthetic-tune-v1', components: {} }, launch: { t: launch.t, ...norm(launch), dir: { x: 0, y: -1 }, view: 'dtl' },
    completion: predTo == null ? null : { end: { type: end, t: e.t, x: e.x, y: e.y }, observedEnd: 'lost', observedSec: last - launch.t, predictedSec: e.t - last, slowMoFactor: 1 }
  };
}
/** A v2-shaped reply: normalized points without statuses, translation camera. */
function v2Result({ frames = [], at = ballAt, status = 'tracked', camera = IDENTITY_CAMERA } = {}) {
  return { engine: 'global-v2', status, reasonCodes: [], points: frames.map(k => ({ t: ft(k), ...norm(at(ft(k))) })), camera, confidence: 3.1 };
}
const abstention = () => ({ engine: 'hf', status: 'no_reliable_track', reasonCodes: ['no_launch'], points: [], observations: [], camera: [], observedFrames: 0, confidence: { value: 0, calibratedOn: 'uncalibrated', components: {} }, launch: null, completion: null });
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const off = (dx, dy = 0) => t => { const b = ballAt(t); return { x: b.x + dx, y: b.y + dy }; };
const POST = range(31, 61);

/* ---------------------------------------------------------------- statistics */

test('Wilson interval matches the closed form', () => {
  const a = wilson(5, 10);
  assert.ok(Math.abs(a.lo - 0.2366) < 1e-3 && Math.abs(a.hi - 0.7634) < 1e-3, JSON.stringify(a));
  const z = wilson(0, 50);
  assert.equal(z.p, 0);
  assert.ok(Math.abs(z.hi - 0.0714) < 1e-3, `0/50 upper bound ${z.hi}`);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, p: null, lo: null, hi: null });
});

test('quantile interpolates linearly and bootstrap intervals are seeded', () => {
  assert.equal(quantile([3, 1, 2, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.95), 4.8);
  assert.equal(quantile([], 0.5), null);
  const groups = Array.from({ length: 30 }, (_, i) => [i, i + 1]);
  const stat = gs => quantile(gs.flat(), 0.5);
  assert.deepEqual(bootstrapCI(groups, stat, { n: 100, seed: 7 }), bootstrapCI(groups, stat, { n: 100, seed: 7 }));
  const [lo, hi] = bootstrapCI(groups, stat, { n: 200, seed: 7 });
  assert.ok(lo < 15 && hi > 15 && lo > 8 && hi < 22, `${lo}..${hi}`);
});

test('ECE is 0 when calibrated and |acc − conf| when not', () => {
  const calibrated = [...Array(8)].map((_, i) => [0.75, i < 6 ? 1 : 0]);
  assert.ok(Math.abs(ece(calibrated, 10).value) < 1e-12);
  const over = [...Array(10)].map((_, i) => [0.95, i < 5 ? 1 : 0]);
  assert.ok(Math.abs(ece(over, 10).value - 0.45) < 1e-12);
  const mixed = [[0.15, 0], [0.15, 0], [0.95, 1], [0.95, 1]];
  assert.ok(Math.abs(ece(mixed, 10).value - 0.1) < 1e-12);
});

/* ---------------------------------------------------------------- coordinates */

test('result points map to raw px through the result camera (hf similarity, v2 translation)', () => {
  // hf sample: scale 1.1 and rotation 0.05 about the frame centre, plus a translation of (0.01, −0.02).
  const cam = [{ t: 0, x: 0.01, y: -0.02, s: 1.1, r: 0.05 }, { t: 2, x: 0.03, y: -0.02, s: 1.1, r: 0.05 }];
  const p = toRawPx(cam, 1, 0.6, 0.4, W, H);
  const a = 1.1 * Math.cos(0.05), b = 1.1 * Math.sin(0.05), dx = 100, dy = -100;
  assert.ok(Math.abs(p.x - (500 + a * dx - b * dy + 20)) < 1e-9 && Math.abs(p.y - (500 + b * dx + a * dy - 20)) < 1e-9, JSON.stringify(p));
  assert.deepEqual(cameraAt(cam, -5), { x: 0.01, y: -0.02, s: 1.1, r: 0.05 });
  // v2 camera: raw_norm = stab_norm + offset.
  const q = toRawPx([{ t: 0, x: 0.1, y: 0.2 }], 0.5, 0.3, 0.3, W, H);
  assert.ok(Math.abs(q.x - 400) < 1e-9 && Math.abs(q.y - 500) < 1e-9);
  // A shaking camera: GT is raw, so a stabilized result must be compared after the camera is applied.
  const shake = [{ t: 0, x: 0.02, y: 0 }, { t: 5, x: 0.02, y: 0 }];
  const atStab = t => { const b = ballAt(t); return { x: b.x - 20, y: b.y }; };
  const m = scoreClip(v2Result({ frames: POST, at: atStab, camera: shake }), makeGt());
  assert.equal(m.identity.matched, POST.length);
  const wrongCam = scoreClip(v2Result({ frames: POST, at: atStab }), makeGt());
  assert.ok(wrongCam.identity.matched < POST.length / 2);
});

test('GT lookup returns the frame on screen at time t', () => {
  const G = gtIndex(makeGt());
  assert.equal(G.index(ft(40)), 40);
  assert.equal(G.index(ft(40) + 0.5 / FPS), 40);
  assert.equal(G.index(ft(40) - 1e-7), 40);
  assert.equal(G.index(-1), -1);
  assert.equal(G.index(ft(N) + 1), -1);
});

/* ---------------------------------------------------------------- point match and identity */

test('point match radius is max(2 px, 0.75 d)', () => {
  assert.equal(matchRadius(10), 7.5);
  assert.equal(matchRadius(2), 2);
  assert.equal(matchRadius(0), 2);
  const gt = makeGt();
  // Early flight (d ≈ 9 px): 0.2 px inside the radius matches, 0.2 px outside does not.
  const by = dr => t => off(matchRadius(ballAt(t).diam) + dr)(t);
  const near = scoreClip(v2Result({ frames: [31, 32], at: by(-0.2) }), gt), far = scoreClip(v2Result({ frames: [31, 32], at: by(0.2) }), gt);
  assert.equal(near.identity.matched, 2);
  assert.equal(far.identity.matched, 0);
  // Late flight (d < 2.67 px): the 2 px floor applies.
  const late = scoreClip(v2Result({ frames: [80, 81], at: off(1.9) }), gt);
  assert.equal(late.identity.matched, 2);
});

test('identity switch needs switchRun consecutive unmatched observed points', () => {
  const gt = makeGt(), pattern = flags => t => (flags[Math.round(t * FPS) - 31] ? off(0)(t) : off(40)(t));
  const two = scoreClip(v2Result({ frames: range(31, 37), at: pattern([1, 1, 0, 0, 1, 1]) }), gt);
  assert.equal(two.identity.switch, false);
  assert.equal(two.identity.longestUnmatchedRun, 2);
  const three = scoreClip(v2Result({ frames: range(31, 37), at: pattern([1, 0, 0, 0, 1, 1]) }), gt);
  assert.equal(three.identity.switch, true);
  assert.ok(three.wrong && three.wrongReasons.includes('switch'));
});

/* ---------------------------------------------------------------- club and distractor steals */

test('club steal: post-impact observed points on the GT club are a club false track', () => {
  const gt = makeGt(), m = scoreClip(hfResult({ frames: range(31, 40), at: clubAt }), gt);
  assert.equal(m.club.falseTrack, true);
  assert.ok(m.club.hits >= 5, `hits ${m.club.hits}`);
  assert.ok(m.wrong && m.wrongIdentity && m.wrongReasons.includes('club'));
  const ok = scoreClip(hfResult({ frames: range(31, 40) }), gt);
  assert.equal(ok.club.falseTrack, false);
  assert.equal(ok.wrong, false);
});

test('club steal: only the first 6 post-impact points count, and one hit is not enough', () => {
  const gt = makeGt();
  // Ball for the first 6 post-impact frames, then the club on 2 frames: not a club track (and no switch).
  const late = t => (t < ft(37) ? ballAt(t) : clubAt(t));
  const m = scoreClip(hfResult({ frames: range(31, 39), at: late }), gt);
  assert.equal(m.club.considered, 6);
  assert.equal(m.club.falseTrack, false);
  assert.equal(m.wrong, false);
  // Exactly one of the first six on the club.
  const once = t => (Math.round(t * FPS) === 33 ? clubAt(t) : ballAt(t));
  const one = scoreClip(hfResult({ frames: range(31, 40), at: once }), gt);
  assert.equal(one.club.hits, 1);
  assert.equal(one.club.falseTrack, false);
  // Two of the first six: a club track.
  const twice = t => ([33, 34].includes(Math.round(t * FPS)) ? clubAt(t) : ballAt(t));
  assert.equal(scoreClip(hfResult({ frames: range(31, 40), at: twice }), gt).club.falseTrack, true);
});

test('club steal: a club within 2 d of the ball is not a club hit (ball and club merged)', () => {
  const hug = t => { const b = ballAt(t); return { x: b.x + 1.5 * b.diam, y: b.y, size: 25 }; };
  const gt = makeGt({ club: hug });
  const m = scoreClip(hfResult({ frames: range(31, 40), at: hug }), gt);
  assert.equal(m.club.hits, 0);
  assert.equal(m.club.falseTrack, false);
});

test('club steal: pre-impact points never count (the definition is post-impact only)', () => {
  // v2-style early seeding: points on the club during the downswing, then the ball after impact.
  const gt = makeGt(), at = t => (t < T0 ? clubAt(t) : ballAt(t));
  const m = scoreClip(v2Result({ frames: range(26, 45), at }), gt);
  assert.equal(m.club.hits, 0);
  assert.equal(m.club.falseTrack, false);
  assert.equal(m.club.considered, 6);
});

test('distractor steal: a point that matches the ball is never a steal, even for a sub-pixel ball', () => {
  // d = 0.8 px: the 2 px match floor exceeds 2·d, so a ball match can sit more than 2·d from the ball.
  const near = t => { const b = ballAt(t); return { x: b.x + 1.8, y: b.y }; };
  const gt = makeGt({ diam: () => 0.8, distractors: (i, t) => [{ type: 'bird', id: 'b', ...near(t), size: 4 }] });
  const m = scoreClip(hfResult({ frames: range(40, 50), at: near }), gt);
  assert.equal(m.identity.matched, 10);
  assert.deepEqual([m.steal.hits, m.steal.falseTrack], [0, false]);
});

test('distractor steal: stealHits observed points on one distractor away from the ball', () => {
  const bird = (i, t) => (i >= 40 && i < 70 ? [{ type: 'bird', id: 'bird0', x: 100 + 10 * (i - 40), y: 300, size: 15 }] : []);
  const gt = makeGt({ distractors: bird });
  const birdPos = t => ({ x: 100 + 10 * (Math.round(t * FPS) - 40), y: 300 });
  // Interleaved ball / bird points: three bird hits but no run of three unmatched points.
  const on = ks => t => (ks.includes(Math.round(t * FPS)) ? birdPos(t) : ballAt(t));
  const three = scoreClip(hfResult({ frames: range(40, 50), at: on([41, 43, 45]) }), gt);
  assert.equal(three.identity.switch, false);
  assert.deepEqual([three.steal.target, three.steal.hits, three.steal.falseTrack], ['bird:bird0', 3, true]);
  assert.ok(three.wrongReasons.includes('steal'));
  const two = scoreClip(hfResult({ frames: range(40, 50), at: on([41, 43]) }), gt);
  assert.equal(two.steal.falseTrack, false);
  assert.equal(two.wrong, false);
  // A distractor right next to the ball is not a steal.
  const close = (i, t) => { const b = ballAt(t); return [{ type: 'bird', id: 'b', x: b.x + b.diam, y: b.y, size: 15 }]; };
  const nearGt = makeGt({ distractors: close }), nearAt = t => { const b = ballAt(t); return { x: b.x + b.diam, y: b.y }; };
  assert.equal(scoreClip(hfResult({ frames: range(40, 50), at: nearAt }), nearGt).steal.hits, 0);
});

/* ---------------------------------------------------------------- recall */

test('status-aware recall: predicted points never count as detections', () => {
  const gt = makeGt();
  const hf = scoreClip(hfResult({ frames: range(31, 41), predTo: ft(60) }), gt);
  const vis = hf.recall.reduce((s, b) => s + b.visible, 0), hit = hf.recall.reduce((s, b) => s + b.matched, 0);
  assert.equal(vis, N - 31);
  assert.equal(hit, 10, 'the 20 predicted frames lie on the GT ball but must not count');
  // The same frames as v2 points (no statuses) are all observed.
  const v2 = scoreClip(v2Result({ frames: range(31, 61) }), gt);
  assert.equal(v2.recall.reduce((s, b) => s + b.matched, 0), 30);
  // An abstention scores no recall and is not in the recall population, but counts against coverage.
  const ab = scoreClip(abstention(), gt);
  assert.equal(ab.recall, null);
  const S = summarize([hf, ab]);
  assert.equal(S.quality.recall.reduce((s, b) => s + b.n, 0), N - 31);
  assert.equal(S.quality.coverage.dtl.n, 2);
  assert.equal(S.quality.coverage.dtl.k, 1);
});

test('recall bins split GT-visible frames by SNR; occluded and pre-impact frames are not visible', () => {
  const bins = recallBins();
  assert.deepEqual(bins.map(b => [b.lo, b.hi, b.target]), [[6, null, 0.97], [3, 6, 0.85], [2, 3, 0.5], [null, 2, null]]);
  const snr = t => { const k = Math.round(t * FPS); return k < 45 ? 8 : k < 60 ? 4 : k < 75 ? 2.5 : 1; };
  const gt = makeGt({ snr, occluded: i => i >= 50 && i < 55 });
  const m = scoreClip(hfResult({ frames: range(31, N).filter(k => k % 2) }), gt);
  assert.deepEqual(m.recall.map(b => b.visible), [14, 10, 15, 15]);
  assert.deepEqual(m.recall.map(b => b.matched), [7, 6, 7, 8]);
  const S = summarize([m]);
  assert.ok(Math.abs(S.quality.recall[0].p - 0.5) < 1e-12 && Math.abs(S.quality.recall[1].p - 0.6) < 1e-12);
  // The bin keeps its SNR bounds next to the rate's interval (lo/hi), and the report labels the bins by them.
  assert.deepEqual(S.quality.recall.map(b => [b.snrLo, b.snrHi]), [[6, null], [3, 6], [2, 3], [null, 2]]);
  assert.ok(S.quality.recall[0].lo < 0.5 && S.quality.recall[0].hi > 0.5);
  const md = renderMarkdown(buildReport([m], { runner: 'node' }, { bootstrap: { n: 10, seed: 1 } }));
  for (const label of ['| >= 6 |', '| 3-6 |', '| 2-3 |', '| < 2 |']) assert.ok(md.includes(label), label);
});

/* ---------------------------------------------------------------- launch and position */

test('launch error is reported in frames and d0 with the 1 frame / 0.5 d0 targets', () => {
  const gt = makeGt();
  const at = (dt, dx) => scoreClip(hfResult({ frames: range(31, 45), launch: { t: T0 + dt / FPS, x: ADDR.x + dx, y: ADDR.y } }), gt).launch;
  const a = at(0.5, 4);
  assert.ok(Math.abs(a.dtFrames - 0.5) < 1e-9 && Math.abs(a.pointD0 - 0.4) < 1e-9);
  assert.deepEqual([a.frameOk, a.pointOk, a.wrong], [true, true, false]);
  const b = at(-1.5, 6);
  assert.deepEqual([b.frameOk, b.pointOk, b.wrong], [false, false, false]);
  assert.equal(at(-6, 0).wrong, false, "v2's 0.2 s early seed at the address is still the right launch");
  assert.equal(at(-8, 0).wrong, true, 'more than 0.25 s real early is another event');
  assert.equal(at(0, 25).wrong, true, 'more than 2 d0 away is another object');
});

test('position error: flight points only, in d for balls >= 2 px and in px below', () => {
  const gt = makeGt(), m = scoreClip(v2Result({ frames: [29, 30, ...range(31, N)], at: off(1, 0) }), gt);
  // Frames 29 and 30 are pre-impact: not position samples. Every flight point is 1 px off.
  assert.equal(m.position.px.length, N - 31);
  assert.ok(m.position.px.every(e => Math.abs(e - 1) < 1e-6));
  const large = range(31, N).filter(k => ballAt(ft(k)).diam >= 2).length;
  assert.equal(m.position.large.length, large);
  assert.equal(m.position.small.length, N - 31 - large);
  const S = summarize([m]);
  assert.ok(Math.abs(S.quality.position.small.median.value - 1) < 1e-6);
  assert.ok(S.quality.position.large.median.value > 0.1 && S.quality.position.large.median.value < 0.5);
});

/* ---------------------------------------------------------------- completion */

test('predicted-only completion error: observed points never enter it', () => {
  const gt = makeGt();
  // Perfect predicted arc, observed points 20 px off: completion error 0 (identity is wrong, separately).
  const a = scoreClip(hfResult({ frames: range(31, 50), at: off(20), predTo: T0 + 3 }), gt);
  assert.ok(a.completion.shapeMax < 0.1 / DIAG && a.completion.timeMax < 0.1 / DIAG, JSON.stringify(a.completion));
  assert.ok(a.wrongReasons.includes('unmatched') && !a.wrongReasons.includes('completion'));
  // Perfect observed points, predicted arc shifted 30 px perpendicular: 30 px of shape error.
  const b = scoreClip(hfResult({ frames: range(31, 50), predTo: T0 + 3, predAt: off(30, 0) }), gt);
  assert.ok(b.completion.shapeMax > 25 / DIAG && b.completion.shapeMax <= 30 / DIAG + 1e-9, `${b.completion.shapeMax * DIAG}`);
  assert.ok(Math.abs(b.completion.timeMax - 30 / DIAG) < 1e-6);
  assert.equal(b.identityOk, true);
});

test('completion: faded points below completionMinAlpha are not scored; shapeMaxAll keeps them', () => {
  const gt = makeGt(), tFade = T0 + 2;
  const far = t => (t > tFade ? off(200, 0)(t) : ballAt(t));
  const m = scoreClip(hfResult({ frames: range(31, 50), predTo: T0 + 3, predAt: far, alpha: t => (t > tFade ? 0.3 : 1) }), gt);
  assert.ok(m.completion.shapeMax < 0.1 / DIAG, `${m.completion.shapeMax}`);
  assert.ok(m.completion.shapeMaxAll > 150 / DIAG);
  assert.ok(m.completion.nVisible < m.completion.n);
});

test('completion: landing time, end error, observed fraction and the long/short strata', () => {
  const gt = makeGt();
  // Observed for 1 s of a 4 s flight (25%: short stratum), predicted to a landing 0.2 s late.
  const late = t => ballAt(Math.min(t, T0 + FLIGHT));
  const m = scoreClip(hfResult({ frames: range(31, 61), predTo: T0 + FLIGHT + 0.2, predAt: late }), gt);
  assert.ok(Math.abs(m.completion.landingTimeFrac - 0.2 / FLIGHT) < 0.01, `${m.completion.landingTimeFrac}`);
  assert.ok(Math.abs(m.completion.observedFrac - (ft(60) - T0) / FLIGHT) < 1e-9);
  assert.equal(m.completion.long, false);
  assert.deepEqual([m.completion.endType, m.completion.gtEndType], ['landing', 'landing']);
  const longObs = scoreClip(hfResult({ frames: range(31, N), predTo: T0 + FLIGHT }), gt);
  assert.equal(longObs.completion.long, true);
  // Overshoot past the true landing is completion error.
  const over = scoreClip(hfResult({ frames: range(31, 61), predTo: T0 + FLIGHT + 0.5 }), gt);
  assert.ok(over.completion.shapeMax > 50 / DIAG, `${over.completion.shapeMax * DIAG}`);
});

test('a completion more than 5% of the diagonal off makes a trace wrong without an identity error', () => {
  const gt = makeGt(), lim = DEFINITIONS.wrong.completionDiag * DIAG;
  const bent = d => scoreClip(hfResult({ frames: range(31, 61), predTo: T0 + 3, predAt: off(d, 0) }), gt);
  const ok = bent(0.8 * lim), bad = bent(1.2 * lim);
  assert.deepEqual([ok.correct, ok.wrong], [true, false]);
  assert.deepEqual([bad.wrong, bad.wrongIdentity, bad.identityOk], [true, false, true]);
  assert.ok(bad.wrongReasons.includes('completion'));
  const S = summarize([ok, bad]);
  assert.equal(S.safety.wrongGivenTraced.k, 1);
  assert.equal(S.safety.wrongIdentityGivenTraced.k, 0);
});

test('completion shape is order-aware: a down-the-line landing overshoot is wrong even though it lies over the ascent', () => {
  const gt = makeGt({ at: dtlAt, flight: DTL_LAND }), lim = DEFINITIONS.wrong.completionDiag * DIAG;
  const run = predTo => scoreClip(hfResult({ frames: range(31, 51), at: dtlAt, predTo, predAt: dtlAt }), gt);
  const right = run(T0 + DTL_LAND), over = run(T0 + DTL_LAND + 0.4);
  assert.ok(right.completion.shapeMax < 1 / DIAG, `${right.completion.shapeMax * DIAG} px`);
  assert.deepEqual([right.correct, right.wrongReasons], [true, []]);
  // The overshoot ends 177 px below the landing, yet within 10 px of the early ascent: nearest-point shape would pass it.
  const tail = scoredView(hfResult({ frames: range(31, 51), at: dtlAt, predTo: T0 + DTL_LAND + 0.4, predAt: dtlAt }), { width: W, height: H }).predicted;
  assert.ok(Math.max(...tail.map(p => distToArc(gt.arc2d, p.x, p.y))) < 10, 'the fold: the overshoot is near the ascent');
  assert.ok(over.completion.shapeMax * DIAG > 2 * lim && over.completion.shapeMax * DIAG > 170, `${over.completion.shapeMax * DIAG} px`);
  assert.deepEqual([over.wrong, over.identityOk, over.wrongReasons], [true, true, ['completion']]);
  assert.ok(Math.abs(over.completion.shapeMaxAll - over.completion.shapeMax) < 1e-12);
});

test('arcAlign: points advance along the arc, the largest distance as small as possible, then the sum', () => {
  // A hairpin arc out along y = 0 and back along y = 2: the return leg passes 2 px from the outward one.
  const arc = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 0, y: 2 }];
  assert.deepEqual(arcAlign(arc, [{ x: 5, y: 0.5 }]), [0.5]);
  assert.deepEqual(arcAlign(arc, [{ x: 3, y: 0 }, { x: 3, y: 2 }]), [0, 0]);
  // Back over the outward leg after the return leg: one of the two must be 2 px off (nearest-point distance: 0 and 0).
  assert.equal(Math.max(...arcAlign(arc, [{ x: 3, y: 2 }, { x: 3, y: 0 }])), 2);
  // The largest distance first: 1.9 px on every point beats a smaller sum with one point 2 px off.
  const r2 = v => Math.round(v * 100) / 100;
  assert.deepEqual(arcAlign(arc, [{ x: 3, y: 1.9 }, { x: 4, y: 1.9 }, { x: 5, y: 1.9 }, { x: 6, y: 0 }]).map(r2), [1.9, 1.9, 1.9, 0]);
  // Then the sum: both legs fit within 1 px, and the alignment that does it with the least total is kept.
  assert.deepEqual(arcAlign(arc, [{ x: 3, y: 1 }, { x: 4, y: 1.9 }]).map(r2), [1, 0.1]);
  assert.deepEqual(arcAlign(arc, []), []);
  assert.deepEqual(arcAlign([{ x: 1, y: 1 }], [{ x: 4, y: 5 }]), [5]);
});

test('arc helpers: time-aligned position and polyline distance', () => {
  const arc = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }, { t: 2, x: 10, y: 10 }];
  assert.deepEqual(arcAt(arc, 0.5), { t: 0.5, x: 5, y: 0 });
  assert.equal(arcAt(arc, 9).y, 10);
  assert.equal(distToArc(arc, 5, 3), 3);
  assert.equal(distToArc(arc, 13, 5), 3);
});

/* ---------------------------------------------------------------- abstention classes and the safety summary */

test('clip classes: no-ball kinds, invisible-ball controls by marker or label, hidden address is not invisible', () => {
  assert.deepEqual(clipClass(makeGt({ kind: 'practice', noImpact: true, expected: 'abstain' })), { kind: 'practice', invisible: false, noBall: true, hit: false });
  assert.equal(clipClass(makeGt({ kind: 'whiff', noImpact: true, expected: 'abstain' })).noBall, true);
  assert.equal(clipClass(makeGt({ expected: 'abstain' })).invisible, true, 'a hit labelled abstain is a control');
  assert.equal(clipClass(makeGt({ kind: 'hit-invisible', expected: 'abstain' })).invisible, true);
  assert.equal(clipClass(makeGt({ confounders: { invisibleBall: true } })).invisible, true);
  assert.equal(clipClass(makeGt({ confounders: { hideBall: 1 } })).invisible, true);
  const hidden = clipClass(makeGt({ expected: 'either', confounders: { hiddenAddress: 'start' } }));
  assert.deepEqual([hidden.invisible, hidden.noBall, hidden.hit], [false, false, true]);
});

test('safety summary: P(wrong | traced), club rate, no-ball false trace, invisible abstention, confusion', () => {
  const good = scoreClip(hfResult({ frames: range(31, 61), predTo: T0 + 3 }), makeGt({ id: 'good' }));
  const club = scoreClip(hfResult({ frames: range(31, 40), at: clubAt }), makeGt({ id: 'club' }));
  const missed = scoreClip(abstention(), makeGt({ id: 'missed' }));
  const practice = makeGt({ id: 'practice', kind: 'practice', noImpact: true, expected: 'abstain', noFlight: true });
  const nbTrace = scoreClip(v2Result({ frames: range(31, 45), at: clubAt }), practice), nbAbstain = scoreClip(abstention(), practice);
  const control = makeGt({ id: 'invisible', expected: 'abstain', confounders: { invisibleBall: true } });
  const invTrace = scoreClip(hfResult({ frames: range(31, 45) }), control), invAbstain = scoreClip(abstention(), control);
  assert.deepEqual([nbTrace.wrongReasons, invTrace.wrongReasons], [['expected_abstain'], ['expected_abstain']]);
  const S = summarize([good, club, missed, nbTrace, nbAbstain, invTrace, invAbstain, invAbstain]);
  assert.deepEqual([S.n, S.traced, S.abstained], [8, 4, 4]);
  assert.deepEqual([S.safety.wrongGivenTraced.k, S.safety.wrongGivenTraced.n], [3, 4]);
  assert.deepEqual([S.safety.clubFalseTrack.k, S.safety.clubFalseTrack.n], [1, 6]);
  assert.deepEqual([S.safety.noBallFalseTrace.k, S.safety.noBallFalseTrace.n], [1, 2]);
  assert.deepEqual([S.safety.invisibleAbstain.k, S.safety.invisibleAbstain.n], [2, 3]);
  assert.deepEqual(S.confusion.trace, { n: 3, tracked: 2, partial: 0, abstained: 1, wrong: 1 });
  assert.deepEqual(S.confusion.abstain, { n: 5, tracked: 2, partial: 0, abstained: 3, wrong: 2 });
  assert.equal(S.quality.coverage.all.k, 1);
  assert.equal(S.safety.wrongReasons.club, 1);
});

test('partial traces count as traced; v2 status comes from the reply', () => {
  const gt = makeGt(), m = scoreClip(v2Result({ frames: range(31, 36), status: 'partial' }), gt);
  assert.deepEqual([m.traced, m.outcome], [true, 'partial']);
  const one = scoreClip(v2Result({ frames: [31] }), gt);
  assert.equal(one.traced, false, 'fewer than 2 points draws nothing');
  const sv = scoredView({ engine: 'motion-beta', points: [{ t: 1, x: 0.5, y: 0.5 }, { t: 1.1, x: 0.5, y: 0.4 }], camera: [] }, { width: W, height: H });
  assert.deepEqual([sv.status, sv.traced, sv.observed.length, sv.launch.t], ['tracked', true, 2, 1]);
});

test('calibration uses traced clips with probability confidences only', () => {
  const gt = makeGt();
  const a = scoreClip(hfResult({ frames: range(31, 61), confidence: 0.9 }), gt);
  const b = scoreClip(hfResult({ frames: range(31, 40), at: clubAt, confidence: 0.9 }), gt);
  const v2 = scoreClip(v2Result({ frames: range(31, 61) }), gt);
  assert.equal(v2.confidence, null, 'a v2 margin is not a probability');
  const S = summarize([a, b, v2]);
  assert.equal(S.quality.calibration.n, 2);
  assert.ok(Math.abs(S.quality.calibration.ece.value - 0.4) < 1e-12);
});

test('aggregate: strata are multi-label for failure modes and keep overall intervals', () => {
  const c1 = scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id: 'a', failureModes: ['F1', 'F5'] }));
  const c2 = scoreClip(abstention(), makeGt({ id: 'b', failureModes: ['F5'], viewClass: 'fo', captureFps: 240 }));
  const R = aggregate([c1, c2], { bootstrap: { n: 50, seed: 3 } });
  assert.equal(R.n, 2);
  assert.equal(R.strata.failureModes.F5.n, 2);
  assert.equal(R.strata.failureModes.F1.n, 1);
  assert.deepEqual(Object.keys(R.strata.viewClass), ['dtl', 'fo']);
  assert.equal(R.overall.quality.coverage.foFast.n, 1);
  assert.equal(R.overall.quality.coverage.foFast.k, 0);
  assert.equal(R.overall.quality.coverage.dtl.k, 1);
});

/* ---------------------------------------------------------------- runtime, parity, engine comparison */

test('runtime projects ms/frame to a 10 s clip per format', () => {
  const gt = makeGt(), m = scoreClip(abstention(), gt, { runtime: { elapsedMs: 900, phases: { scan: 500 } } });
  assert.equal(m.runtime.msPerFrame, 10);
  const fake = (w, h, fps, ms) => ({ ...m, dims: { ...m.dims, width: w, height: h, fps }, runtime: { msPerFrame: ms, elapsedMs: ms * 100 } });
  const S = summarize([fake(2160, 3840, 60, 30), fake(2160, 3840, 60, 40), fake(1080, 1920, 30, 20)]);
  assert.ok(Math.abs(S.quality.runtime.k4k60.value - 35 * 600 / 1000) < 1e-9);
  assert.ok(Math.abs(S.quality.runtime.p1080p30.value - 6) < 1e-9);
  assert.deepEqual(Object.keys(S.quality.runtime.byFormat).sort(), ['1920p30', '3840p60']);
  assert.equal(S.quality.runtime.byFormat['3840p60'].msPerFrame, 35);
});

test('parity: decision, launch frame and observed-position delta between two runs', () => {
  const gt = makeGt(), a = scoreClip(hfResult({ frames: range(31, 61) }), gt);
  const b = scoreClip(hfResult({ frames: range(31, 61), at: off(0.3, 0.4) }), gt);
  const c = scoreClip(abstention(), makeGt({ id: 'other' })), c2 = scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id: 'other' }));
  const d = scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id: 'late' })), d2 = scoreClip(hfResult({ frames: range(33, 61), launch: { t: T0 + 2 / FPS, ...ADDR } }), makeGt({ id: 'late' }));
  assert.deepEqual([d.launchFrame, d2.launchFrame], [30, 32]);
  const P = parity([a, c, d], [b, c2, d2]);
  assert.equal(P.n, 3);
  assert.deepEqual([P.decision.k, P.decision.n], [2, 3]);
  assert.deepEqual([P.launchFrame.k, P.launchFrame.n], [1, 3]);
  assert.ok(Math.abs(P.positionPx.value - 0.5) < 0.01, `${P.positionPx.value}`);
});

test('compareEngines needs hf to beat v2 on both coverage and position error', () => {
  const gt = makeGt();
  const hf = summarize([scoreClip(hfResult({ frames: range(31, 61) }), gt), scoreClip(hfResult({ frames: range(31, 61) }), gt)]);
  const v2 = summarize([scoreClip(v2Result({ frames: range(31, 61), at: off(1) }), gt), scoreClip(abstention(), gt)]);
  assert.equal(compareEngines(hf, v2).beats, true);
  assert.equal(compareEngines(v2, hf).beats, false);
  const v2good = summarize([scoreClip(v2Result({ frames: range(31, 61) }), gt), scoreClip(v2Result({ frames: range(31, 61) }), gt)]);
  const r = compareEngines(hf, v2good);
  assert.deepEqual([r.coverage.better, r.beats], [false, false], 'equal coverage is not a win');
});

/* ---------------------------------------------------------------- gate */

test('acceptance.json mirrors PARAMS.acceptance and covers every safety and quality value', () => {
  const A = PARAMS.acceptance, used = new Set();
  for (const t of ACCEPTANCE_SPEC.targets) {
    assert.ok(['safety', 'quality'].includes(t.tier) && ['le', 'ge'].includes(t.op), t.id);
    assert.deepEqual(getPath(A, t.param), t.value, `${t.id}: acceptance.json ${t.value} vs PARAMS.acceptance.${t.param}`);
    used.add(t.param.replace(/\.\d+\.1$/, ''));
  }
  const definitionLeaves = ['quality.launchPointD0', 'quality.longObservedFrac'];
  for (const tier of ['safety', 'quality']) for (const k of Object.keys(A[tier])) {
    const p = `${tier}.${k}`;
    assert.ok(used.has(p) || definitionLeaves.includes(p), `${p} has no gate target`);
  }
  assert.equal(new Set(ACCEPTANCE_SPEC.targets.map(t => t.id)).size, ACCEPTANCE_SPEC.targets.length);
  assert.equal(DEFINITIONS.wrong.completionDiag, PARAMS.confidence.labelShapeErrDiag);
  assert.equal(ACCEPTANCE_SPEC.paramsVersion, 'hf-params-1');
  assert.equal(ACCEPTANCE_SPEC.targets.filter(t => t.tier === 'safety').length, 4);
});

/** A summary whose safety block is set by hand (everything else empty), for gate tests. */
function safetySummary(over = {}) {
  const S = summarize([]);
  Object.assign(S, { n: 500, errors: 0, invalid: 0 });
  S.safety = { ...S.safety, wrongGivenTraced: wilson(2, 400), clubFalseTrack: wilson(1, 450), noBallFalseTrace: wilson(0, 60), invisibleAbstain: wilson(59, 60), ...over };
  return S;
}

test('gate: safety passes only when every safety target passes with data', () => {
  const ok = checkGate(safetySummary(), PARAMS.acceptance, { runner: 'node' });
  assert.equal(ok.safetyPass, true);
  assert.equal(ok.pass, true);
  assert.ok(ok.results.filter(r => r.tier === 'safety').every(r => r.status === 'pass'));
  const cases = {
    wrongGivenTraced: wilson(5, 400), clubFalseTrack: wilson(3, 450), noBallFalseTrace: wilson(1, 60), invisibleAbstain: wilson(58, 60)
  };
  for (const [k, bad] of Object.entries(cases)) {
    const g = checkGate(safetySummary({ [k]: bad }), PARAMS.acceptance, { runner: 'node' });
    assert.equal(g.pass, false, k);
    assert.deepEqual(g.failures, [k]);
  }
  const none = checkGate(safetySummary({ invisibleAbstain: wilson(0, 0) }));
  assert.equal(none.pass, false, 'no invisible-ball controls is not evidence of abstention');
  assert.equal(none.results.find(r => r.id === 'invisibleAbstain').status, 'no-data');
  const crashed = checkGate(Object.assign(safetySummary(), { errors: 1 }));
  assert.deepEqual([crashed.pass, crashed.safetyPass, crashed.failures], [false, true, ['noRunErrors']]);
  const bound = ok.results.find(r => r.id === 'wrongGivenTraced');
  assert.deepEqual([bound.pass, bound.passAtBound], [true, false], '2/400 passes on the estimate; its Wilson upper bound does not');
});

test('gate: thresholds are read from the acceptance values, browser and parity targets are n/a without data', () => {
  const S = safetySummary(), strict = { ...PARAMS.acceptance, safety: { ...PARAMS.acceptance.safety, maxWrongGivenTraced: 0.001 } };
  assert.equal(checkGate(S, strict).pass, false);
  const g = checkGate(S, PARAMS.acceptance, { runner: 'node' });
  for (const id of ['runtime4k60', 'workerHeap', 'tabRss', 'parityDecision']) assert.equal(g.results.find(r => r.id === id).status, 'n/a', id);
  assert.equal(g.results.find(r => r.id === 'ece').status, 'no-data');
  const gb = checkGate(S, PARAMS.acceptance, { runner: 'browser', parity: { decision: wilson(99, 100), launchFrame: wilson(97, 100), positionPx: { value: 0.1, n: 50 } } });
  assert.equal(gb.results.find(r => r.id === 'runtime4k60').status, 'no-data');
  assert.deepEqual(['parityDecision', 'parityLaunchFrame', 'parityPosition'].map(id => gb.results.find(r => r.id === id).status), ['pass', 'pass', 'pass']);
});

test('gate: quality targets compare in the right direction', () => {
  const gt = makeGt();
  const clips = range(0, 4).map(i => scoreClip(hfResult({ frames: range(31, N), predTo: T0 + FLIGHT }), makeGt({ id: `c${i}` })));
  const g = checkGate(summarize(clips));
  const st = id => g.results.find(r => r.id === id).status;
  assert.equal(st('coverageDtl'), 'pass');
  assert.equal(st('identityMatched'), 'pass');
  assert.equal(st('posMedian'), 'pass');
  assert.equal(st('completionLongMedian'), 'pass');
  assert.equal(st('coverageFoFast'), 'no-data');
  const sloppy = range(0, 4).map(i => scoreClip(v2Result({ frames: range(31, N), at: off(0, 1.4) }), makeGt({ id: `s${i}` })));
  assert.equal(checkGate(summarize(sloppy)).results.find(r => r.id === 'posMedianSmall').status, 'fail');
  void gt;
});

test('flipDecision needs both runners on holdout, both gates, and hf beating v2', () => {
  const S = safetySummary(), rep = (runner, split = 'holdout') => ({ runner, split, aggregate: { overall: S } });
  const gt = makeGt(), v2 = { runner: 'node', split: 'holdout', aggregate: { overall: summarize([scoreClip(abstention(), gt), scoreClip(v2Result({ frames: range(31, 61), at: off(1) }), gt)]) } };
  const hfS = summarize([scoreClip(hfResult({ frames: range(31, 61) }), gt), scoreClip(hfResult({ frames: range(31, 61) }), gt)]);
  Object.assign(S.quality, { coverage: hfS.quality.coverage, position: hfS.quality.position });
  assert.equal(flipDecision({ node: rep('node'), browser: rep('browser'), baselineNode: v2 }).flip, true);
  assert.equal(flipDecision({ node: rep('node'), baselineNode: v2 }).flip, false);
  assert.equal(flipDecision({ node: rep('node', 'tune'), browser: rep('browser'), baselineNode: v2 }).flip, false);
  assert.equal(flipDecision({ node: rep('node'), browser: rep('browser') }).flip, false);
});

/* ---------------------------------------------------------------- controls, perf set, corpus pins */

test('controls split: its hits not expected to trace are invisible-ball controls; markers in factors and tags count', () => {
  const ctl = o => makeGt({ split: 'controls', ...o });
  assert.equal(clipClass(ctl({ expected: 'either' })).invisible, true);
  assert.equal(clipClass(ctl({ expected: 'abstain' })).invisible, true);
  assert.equal(clipClass(ctl({ expected: 'trace' })).invisible, false, 'a visible twin in the controls split is a normal hit');
  assert.deepEqual(clipClass(ctl({ kind: 'practice', noImpact: true, expected: 'abstain' })).noBall, true);
  const hide = makeGt({ expected: 'either' }), tagged = makeGt({ expected: 'either' });
  hide.meta.factors.hideBall = true; tagged.tags = ['control:invisible-ball'];
  assert.deepEqual([clipClass(hide).invisible, clipClass(tagged).invisible, clipClass(makeGt({ expected: 'either' })).invisible], [true, true, false]);
  assert.deepEqual([clipSet(ctl()), clipSet(makeGt({ split: 'perf' })), clipSet(makeGt({ split: 'holdout' }))], ['controls', 'perf', 'main']);
  // A traced control is a wrong trace; the abstention rate counts the controls.
  const traced = scoreClip(hfResult({ frames: range(31, 45) }), ctl({ id: 'c1', expected: 'either' })), quiet = scoreClip(abstention(), ctl({ id: 'c2', expected: 'either' }));
  assert.deepEqual([traced.control, traced.set, traced.wrongReasons, traced.strata.control], ['invisible-ball', 'controls', ['expected_abstain'], 'invisible-ball']);
  const S = summarize([traced, quiet]);
  assert.deepEqual([S.safety.invisibleAbstain.k, S.safety.invisibleAbstain.n, S.safety.wrongGivenTraced.k, S.safety.wrongGivenTraced.n], [1, 2, 1, 1]);
  const R = aggregate([traced, quiet, scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id: 'h' }))], { bootstrap: { n: 10, seed: 1 } });
  assert.deepEqual([R.strata.set.controls.n, R.strata.set.main.n, R.strata.control['invisible-ball'].n, R.strata.control.hit.n], [2, 1, 2, 1]);
});

test('perf set: runtime targets use the measured 10 s perf clips of their format; perf clips stay out of accuracy', () => {
  const perfGt = id => { const g = makeGt({ id, split: 'perf' }); Object.assign(g.meta.video, { width: 2160, height: 3840, fpsOut: 60, frameCount: 600, durationS: 10 }); return g; };
  const perf = [15, 25].map((s, i) => scoreClip(abstention(), perfGt(`p${i}`), { runtime: { elapsedMs: s * 1000 } }));
  const main4k = scoreClip(abstention(), (g => { Object.assign(g.meta.video, { width: 2160, height: 3840, fpsOut: 60, frameCount: 300, durationS: 5 }); return g; })(makeGt({ id: 'm' })), { runtime: { elapsedMs: 30000 } });
  const S = summarize([...perf, main4k]);
  assert.deepEqual([S.n, S.scored, S.perf, S.quality.coverage.all.n, S.confusion.trace.n], [3, 1, 2, 1, 1]);
  assert.deepEqual([S.quality.runtime.k4k60.value, S.quality.runtime.k4k60.n, S.quality.runtime.k4k60.projected], [20, 2, false]);
  // Without perf clips the target is projected from ms/frame (100 ms/frame here: 60 s for 600 frames).
  assert.deepEqual([summarize([main4k]).quality.runtime.k4k60.value, summarize([main4k]).quality.runtime.k4k60.projected], [60, true]);
  // A run error on a perf clip still fails the run; a perf-only stratum scores its own accuracy.
  assert.equal(summarize([{ ...perf[0], error: 'watchdog: timeout' }, main4k]).errors, 1);
  assert.equal(summarize(perf).scored, 2);
});

const GEN = { version: 'synth-1.1', codeSha256: 'c'.repeat(64) };
const PIN = { schema: 'flightline-bench-pin-v1', generator: GEN, mixed: [], manifestSha256: 'm'.repeat(64), stable: true,
  splits: { tune: { dir: '/c/tune', clips: 2, set: 'main', generator: GEN, manifestSha256: 't'.repeat(64), checksums: 'match' } } };
const tune = o => ({ splits: { tune: { ...PIN.splits.tune, ...o } } });
const pinned = (clips, pin = PIN) => ({ schema: 'flightline-bench-report-v1', runner: 'node', split: 'tune', clips, corpusPin: pin });
const filed = (m, id = m.id) => ({ ...m, files: { gt: `g-${id}`, video: `v-${id}` } });

test('corpus pins: reports compare only with one generator, equal split manifests and equal clip files', () => {
  const good = id => filed(scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id })));
  const a = pinned([good('a'), good('b')]), b = pinned([good('a')]);
  assert.deepEqual(pinCheck(a, b), { ok: true, reasons: [], splits: ['tune'] });
  const with_ = o => pinned(a.clips, { ...PIN, ...o });
  const refused = {
    'no pin': [{ ...a, corpusPin: undefined }, /no corpus pin/],
    'generator code': [with_(tune({ generator: { ...GEN, codeSha256: 'd'.repeat(64) } })), /split tune: generator synth-1\.1\/c+ vs synth-1\.1\/d+/],
    'generator version': [with_(tune({ generator: { ...GEN, version: 'synth-1.2' } })), /vs synth-1\.2/],
    'manifest': [with_(tune({ manifestSha256: 'x'.repeat(64) })), /split tune: manifest tttt/],
    'no common split': [with_({ splits: { holdout: PIN.splits.tune } }), /no split in common/],
    'unstable': [with_({ stable: false }), /changed during its run/],
    'split mixing generators': [with_({ mixed: ['tune'], ...tune({ generator: { mixed: ['synth-1.1/a', 'synth-1.1/b'] } }) }), /split tune mixes generators/],
    'clip files': [pinned([{ ...good('a'), files: { gt: 'other', video: 'v-a' } }]), /1 clips scored different files \(a\)/]
  };
  for (const [name, [other, re]] of Object.entries(refused)) {
    const r = pinCheck(a, other);
    assert.equal(r.ok, false, name);
    assert.match(r.reasons.join('; '), re, name);
    assert.throws(() => assertSamePin(a, other), e => e.code === 'corpus-pin' && /refusing to compare/.test(e.message), name);
    assert.throws(() => compareEngines(a, other), e => e.code === 'corpus-pin', name);
  }
  // A split only one side ran does not matter (holdout + controls against holdout), nor its generator: the
  // controls are generated by later generator code than the holdout.
  const later = { ...PIN.splits.tune, generator: { ...GEN, codeSha256: 'e'.repeat(64) }, manifestSha256: 'k'.repeat(64) };
  assert.equal(pinCheck(a, with_({ generator: { mixed: ['synth-1.1/c', 'synth-1.1/e'] }, splits: { ...PIN.splits, controls: later } })).ok, true);
  assert.equal(compareEngines(a, b).clips, 1);
  assert.throws(() => parity([good('a')], [{ ...good('a'), files: { gt: 'g-a', video: 'other' } }]), e => e.code === 'corpus-pin');
});

test('gate: a run report needs a stable pin with one generator per split; flipDecision refuses reports with different pins', () => {
  const clips = [filed(scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id: 'a' })))];
  const pre = r => checkGate(r).preconditions.find(p => p.id === 'corpusPinned');
  assert.equal(pre(pinned(clips)).pass, true);
  assert.equal(pre(pinned(clips, { ...PIN, generator: { mixed: ['a', 'b'] }, splits: { ...PIN.splits, controls: { ...PIN.splits.tune, generator: { version: 'synth-1.2' } } } })).pass, true, 'splits from different generators');
  for (const pin of [null, { ...PIN, stable: false, changed: ['x'] }, { ...PIN, mixed: ['tune'], ...tune({ generator: { mixed: ['a', 'b'] } }) }]) {
    const g = checkGate(pinned(clips, pin));
    assert.deepEqual([pre(pinned(clips, pin)).pass, g.pass, g.failures.includes('corpusPinned')], [false, false, true], JSON.stringify(pin?.generator ?? null));
  }
  assert.equal(checkGate(summarize(clips)).preconditions.some(p => p.id === 'corpusPinned'), false, 'summaries are judged on their numbers');
  const other = { ...PIN, splits: { tune: { ...PIN.splits.tune, manifestSha256: 'z'.repeat(64) } } };
  const flip = flipDecision({ node: pinned(clips), browser: { ...pinned(clips, other), runner: 'browser' }, baselineNode: pinned(clips, other) });
  assert.equal(flip.flip, false);
  assert.ok(flip.reasons.some(r => /node and browser reports have different corpus pins/.test(r)), flip.reasons.join(' | '));
  assert.ok(flip.reasons.some(r => /^node: refusing to compare hf and the baseline/.test(r)), flip.reasons.join(' | '));
});

/* ---------------------------------------------------------------- runners (ffmpeg / Chrome parts skip when absent) */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { probeVideo, runMotionTracker, splitOf, runPool, openClipLog, withSets, main as runNode } from './bench/run-node.mjs';
import { parseRange, serveStatic, verifyExport, runBrowserClip } from './bench/run-browser.mjs';
import { resolveCorpora, listClips, pinCorpus, changedFiles } from './bench/corpus.mjs';
import { buildReport, renderMarkdown } from './bench/report.mjs';
import { findChrome, launchChrome } from './bench/cdp.mjs';
import { sourceFrameSchedule } from '../dist/frame-source.js';

const HAS_FFMPEG = ['ffmpeg', 'ffprobe'].every(c => spawnSync(process.env[c.toUpperCase()] ?? c, ['-version'], { stdio: 'ignore' }).status === 0);
const ff = args => { const r = spawnSync(process.env.FFMPEG ?? 'ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const tmp = name => mkdtempSync(join(tmpdir(), `hf-bench-${name}-`));
const sha = b => createHash('sha256').update(b).digest('hex');
/** A generator-shaped split directory: <id>.gt.json (no-ball practice swings) next to <id>.mp4. */
function fakeSplit(dir, split, ids, { version = 'synth-1.1', code = 'abc', video = id => `video ${id}`, checksums = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const id of ids) {
    const gt = JSON.stringify({ ...makeGt({ id, split, kind: 'practice', noImpact: true, expected: 'abstain' }), generator: { version, codeSha256: code } });
    const v = video(id);
    if (typeof v === 'string') writeFileSync(join(dir, `${id}.mp4`), v);
    writeFileSync(join(dir, `${id}.gt.json`), gt);
    lines.push(`${sha(readFileSync(join(dir, `${id}.mp4`)))}  ${id}.mp4`, `${sha(gt)}  ${id}.gt.json`);
  }
  if (checksums) writeFileSync(join(dir, 'checksums.sha256'), lines.join('\n') + '\n');
  return lines;
}

test('corpus: --with adds the controls and perf siblings, the pin hashes every clip file and spots any change', async () => {
  const root = tmp('corpus');
  try {
    const listing = fakeSplit(join(root, 'tune'), 'tune', ['t1', 't2', 't3'], { checksums: true });
    fakeSplit(join(root, 'controls'), 'controls', ['c1']);
    fakeSplit(join(root, 'perf'), 'perf', ['p1']);
    assert.deepEqual(resolveCorpora(join(root, 'tune')).map(d => [d.dir.slice(root.length), d.added]), [['/tune', false], ['/controls', true], ['/perf', true]]);
    assert.deepEqual(resolveCorpora(join(root, 'tune'), withSets('none')).length, 1);
    assert.deepEqual(withSets('controls'), ['controls']);
    const dirs = resolveCorpora(join(root, 'tune'));
    const clips = await listClips(dirs);
    assert.deepEqual(clips.map(c => [c.id, c.set]), [['t1', 'main'], ['t2', 'main'], ['t3', 'main'], ['c1', 'controls'], ['p1', 'perf']]);
    assert.deepEqual((await listClips(dirs, { only: ['t2', 'c'] })).map(c => c.id), ['t2', 'c1']);
    assert.deepEqual((await listClips(dirs.slice(0, 1), { limit: 2 })).map(c => c.id), ['t1', 't2']);
    const { pin, files, stats } = await pinCorpus(dirs);
    // The tune listing is the generator's checksums.sha256 exactly, so its hash is that file's.
    assert.equal(pin.splits.tune.manifestSha256, sha(listing.join('\n') + '\n'));
    assert.deepEqual([pin.splits.tune.checksums, pin.splits.controls.checksums, pin.splits.perf.set], ['match', 'absent', 'perf']);
    assert.deepEqual([pin.generator, pin.splits.tune.generator, pin.mixed], [{ version: 'synth-1.1', codeSha256: 'abc' }, { version: 'synth-1.1', codeSha256: 'abc' }, []]);
    assert.deepEqual(files.get('t2'), { gt: sha(readFileSync(join(root, 'tune', 't2.gt.json'))), video: sha('video t2') });
    // Subsets of one corpus share its pin; a changed file changes it and is reported by changedFiles.
    assert.equal((await pinCorpus(dirs)).pin.manifestSha256, pin.manifestSha256);
    assert.deepEqual(await changedFiles(stats), []);
    appendFileSync(join(root, 'tune', 't3.mp4'), 'x');
    assert.deepEqual((await changedFiles(stats)).map(f => f.slice(root.length)), ['/tune/t3.mp4']);
    const after = (await pinCorpus(dirs)).pin;
    assert.notEqual(after.splits.tune.manifestSha256, pin.splits.tune.manifestSha256);
    assert.equal(after.splits.tune.checksums, 'mismatch');
    assert.equal(after.splits.controls.manifestSha256, pin.splits.controls.manifestSha256);
    fakeSplit(join(root, 'perf'), 'perf', ['p2'], { code: 'later' });
    fakeSplit(join(root, 'perf'), 'perf', ['p1'], { code: 'later' });
    const perSplit = (await pinCorpus(dirs)).pin;
    assert.deepEqual([perSplit.mixed, perSplit.splits.perf.generator, perSplit.generator.mixed], [[], { version: 'synth-1.1', codeSha256: 'later' }, ['synth-1.1/abc', 'synth-1.1/later']]);
    fakeSplit(join(root, 'controls'), 'controls', ['c2'], { code: 'other' });
    const mixed = (await pinCorpus(dirs)).pin;
    assert.deepEqual([mixed.mixed, mixed.splits.controls.generator.mixed], [['controls'], ['synth-1.1/abc', 'synth-1.1/other']]);
    fakeSplit(join(root, 'tune2'), 'tune', ['u1']);
    await assert.rejects(pinCorpus([join(root, 'tune'), join(root, 'tune2')]), /two corpus directories hold split tune/);
    fakeSplit(join(root, 'dup'), 'dup', ['t1']);
    await assert.rejects(listClips([join(root, 'tune'), join(root, 'dup')]), /t1 appears in two corpus directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runPool: the watchdog kills a clip past its time or RSS limit, a crash is an error, and the pool carries on', { timeout: 60000 }, async () => {
  const dir = tmp('pool'), script = join(dir, 'child.mjs');
  writeFileSync(script, `process.on('message', ({ job }) => {
  if (job.id === 'hang') return;
  if (job.id === 'crash') process.exit(3);
  if (job.id === 'fat') { const keep = []; const grow = () => { if (keep.length < 20) keep.push(Buffer.alloc(32 << 20, 1)); setTimeout(grow, 10); }; return grow(); }
  process.send({ type: 'done', id: job.id, result: { ok: job.id }, error: null, runtime: { elapsedMs: 1 } });
});`);
  try {
    const done = new Map(), t0 = performance.now();
    await runPool(['a', 'hang', 'fat', 'crash', 'b', 'c'].map(id => ({ id })), { jobs: 2, timeoutMs: 2500, maxRssMb: 250, script, execArgv: [], tickMs: 100, onDone: m => done.set(m.id, m) });
    assert.deepEqual([...done.keys()].sort(), ['a', 'b', 'c', 'crash', 'fat', 'hang']);
    for (const id of ['a', 'b', 'c']) assert.deepEqual([done.get(id).result, done.get(id).error], [{ ok: id }, null]);
    assert.match(done.get('hang').error, /^watchdog: timeout after 2\.5 s$/);
    assert.match(done.get('fat').error, /^watchdog: RSS \d+ MB over the 250 MB limit$/);
    assert.ok(done.get('fat').runtime.watchdogPeakRssMb > 250);
    assert.match(done.get('crash').error, /child exited \(3\)/);
    assert.ok(performance.now() - t0 < 15000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clip log: a resumed log keeps the last entry per clip and skips a line torn by a kill', async () => {
  const dir = tmp('log'), file = join(dir, 'r.clips.jsonl');
  try {
    const log = await openClipLog(file);
    log.append({ id: 'a', key: 'k1', result: 1 }); log.append({ id: 'b', key: 'k1', result: 2 }); log.append({ id: 'a', key: 'k2', result: 3 });
    await log.flush();
    appendFileSync(file, '{"id":"c","key":"k1","resu');
    const again = await openClipLog(file, { resume: true });
    assert.deepEqual([...again.done.entries()].map(([id, e]) => [id, e.key, e.result]), [['a', 'k2', 3], ['b', 'k1', 2]]);
    assert.equal((await openClipLog(file)).done.size, 0);
    assert.equal(readFileSync(file, 'utf8'), '', 'without resume the log starts empty');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe: one presentation time per container frame at its exact PTS, VFR kept', { skip: !HAS_FFMPEG && 'no ffmpeg' }, () => {
  const dir = tmp('probe'), file = join(dir, 'vfr.mp4');
  try {
    // 12 frames at 60 fps with a +50 ms jump after frame 5, B-frames.
    ff(['-f', 'lavfi', '-i', "nullsrc=s=64x48:r=60,geq=lum='16*N+8':cb=128:cr=128", '-frames:v', '12', '-vf', "setpts='(N/60+gte(N,6)*0.05)/TB'",
      '-fps_mode', 'passthrough', '-video_track_timescale', '90000', '-c:v', 'libx264', '-qp', '0', '-bf', '2', '-g', '6', '-pix_fmt', 'yuv420p', file]);
    const info = probeVideo(file);
    assert.equal(info.times.length, 12);
    for (let k = 0; k < 12; k++) assert.ok(Math.abs(info.times[k] - (k / 60 + (k >= 6 ? 0.05 : 0))) < 2e-5, `t[${k}] = ${info.times[k]}`);
    assert.deepEqual([info.vfr, info.width, info.height, info.hasAudio], [true, 64, 48, false]);
    assert.equal(splitOf([{ split: 'holdout' }, { split: 'holdout' }], '/x/y'), 'holdout');
    assert.equal(splitOf([{ split: 'holdout' }, { split: 'controls' }], '/x/y'), 'holdout+controls');
    assert.equal(splitOf([{ split: null }], '/x/tune'), 'tune');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v2 runner: the browser\'s frame schedule at exact container PTS, and the status the UI shows', { skip: !HAS_FFMPEG && 'no ffmpeg', timeout: 120000 }, async () => {
  const dir = tmp('v2');
  try {
    // 60 fps: every other source frame at its PTS. With a +50 ms VFR jump after frame 9 the browser takes the frame
    // on screen at each seek target, so the fed times are container PTS, in order, never index / fps.
    const make = (name, vf) => { ff(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=60', '-frames:v', '20', '-vf', vf, '-fps_mode', 'passthrough', '-video_track_timescale', '90000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, name)]); return join(dir, name); };
    const cfr = await runMotionTracker(make('cfr.mp4', 'setpts=N/60/TB'), 'v2');
    assert.equal(cfr.sampling.rule, 'sourceFrameSchedule');
    assert.deepEqual(cfr.fed.map(f => f.frame), sourceFrameSchedule(20 / 60, 60, 30).map(s => s.index));
    assert.deepEqual(cfr.fed.map(f => f.frame), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    assert.ok(cfr.result.camera.every((c, i) => Math.abs(c.t - 2 * i / 60) < 1e-4), `sample times ${cfr.result.camera.map(c => c.t.toFixed(4))}`);
    assert.ok(['tracked', 'partial', 'no_reliable_track'].includes(cfr.result.status));
    assert.equal(cfr.result.engine, 'global-v2');
    const file = make('vfr.mp4', "setpts='(N/60+gte(N,10)*0.05)/TB'"), pts = probeVideo(file).times;
    const vfr = await runMotionTracker(file, 'v2'), times = vfr.result.camera.map(c => c.t);
    assert.ok(times.every(t => pts.some(p => Math.abs(p - t) < 1e-4)), `fed times are frame PTS: ${times.map(t => t.toFixed(4))}`);
    assert.ok(times.every((t, i) => !i || t > times[i - 1]));
    assert.ok(vfr.fed.some(f => f.frame % 2), 'after the jump the frames on screen at the seek targets are not every other frame');
    assert.equal((await runMotionTracker(file, 'legacy')).result.engine, 'motion-beta');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run-node end to end: parallel children, a pinned report, the clip log and --resume', { skip: !HAS_FFMPEG && 'no ffmpeg', timeout: 180000 }, async () => {
  const root = tmp('e2e'), split = join(root, 'smoke'), out = join(root, 'r.json');
  const quiet = console.error;
  try {
    fakeSplit(split, 'smoke', ['a', 'b'], { video: id => ff(['-f', 'lavfi', '-i', `testsrc2=s=96x64:r=30`, '-frames:v', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(split, `${id}.mp4`)]) });
    // makeGt clips are 1000 x 1000; the scorer reads the GT, the runner the video.
    console.error = () => {};
    const args = ['--corpus', split, '--with', 'none', '--jobs', '2', '--out', out];
    for (const engine of ['v2', 'hf']) {
      const r = await runNode([...args, '--engine', engine]);
      assert.deepEqual([r.runner, r.engine, r.n, r.split, r.corpusPin.stable, r.corpusPin.splits.smoke.clips], ['node', engine, 2, 'smoke', true, 2], engine);
      assert.equal(r.gate.preconditions.find(p => p.id === 'corpusPinned').pass, true);
      for (const c of r.clips) {
        assert.equal(c.error, null, `${engine} ${c.id}: ${c.error}`);
        assert.ok(c.files?.gt && c.files?.video);
        assert.equal(c.runtime.source, engine === 'hf' ? 'node-source' : 'run-tracker-offline');
        if (engine === 'hf') assert.deepEqual([c.valid, c.runtime.entry, c.runtime.path], [true, 'runHF', 'node'], JSON.stringify(c.validationErrors));
      }
      assert.equal(readFileSync(join(root, 'r.clips.jsonl'), 'utf8').trim().split('\n').length, 2);
      assert.match(readFileSync(join(root, 'r.md'), 'utf8'), /Corpus pin: generator synth-1\.1 code `abc`/);
    }
    // --resume reuses both hf entries; a clip whose GT file changed runs again.
    const resumed = await runNode([...args, '--engine', 'hf', '--resume', '--run-log', join(root, 'mine.jsonl')]);
    assert.deepEqual([resumed.options.resumed, resumed.clips.every(c => c.reused)], [2, true]);
    appendFileSync(join(split, 'b.gt.json'), ' ');
    const partly = await runNode([...args, '--engine', 'hf', '--resume', '--run-log', 'none']);
    assert.deepEqual(partly.clips.map(c => [c.id, !!c.reused]), [['a', true], ['b', false]]);
    assert.notEqual(partly.corpusPin.splits.smoke.manifestSha256, resumed.corpusPin.splits.smoke.manifestSha256);
    // Every run is logged with its pin: the first two next to the corpus, one to --run-log, none for 'none'.
    const logged = f => readFileSync(join(root, f), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(logged('bench-runs.jsonl').map(e => [e.engine, e.manifestSha256 === resumed.corpusPin.manifestSha256]), [['v2', true], ['hf', true]]);
    assert.equal(logged('mine.jsonl').length, 1);
  } finally { console.error = quiet; rmSync(root, { recursive: true, force: true }); }
});

test('static server answers byte ranges, HEAD and 416, and refuses path traversal', async () => {
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  assert.equal(parseRange(undefined, 100), null);
  for (const bad of ['bytes=100-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,4-5', 'items=1-2']) assert.equal(parseRange(bad, 100), false, bad);
  const root = tmp('www'), corpus = join(root, 'corpus-dir');
  mkdirSync(corpus);
  writeFileSync(join(root, 'index.html'), '<!doctype html>hi');
  writeFileSync(join(corpus, 'clip.mp4'), Uint8Array.from({ length: 1000 }, (_, i) => i % 256));
  const secret = `hf-bench-secret-${process.pid}.txt`;
  writeFileSync(join(tmpdir(), secret), 'secret');
  const srv = await serveStatic({ '/': root, '/corpus/': corpus });
  try {
    const r = await fetch(`${srv.url}/corpus/clip.mp4`, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const full = await fetch(`${srv.url}/corpus/clip.mp4`);
    assert.deepEqual([full.status, full.headers.get('accept-ranges'), (await full.arrayBuffer()).byteLength], [200, 'bytes', 1000]);
    const tail = await fetch(`${srv.url}/corpus/clip.mp4`, { headers: { range: 'bytes=-3' } });
    assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [997 % 256, 998 % 256, 999 % 256]);
    const bad = await fetch(`${srv.url}/corpus/clip.mp4`, { headers: { range: 'bytes=5000-' } });
    assert.deepEqual([bad.status, bad.headers.get('content-range')], [416, 'bytes */1000']);
    const head = await fetch(`${srv.url}/corpus/clip.mp4`, { method: 'HEAD' });
    assert.deepEqual([head.status, head.headers.get('content-length')], [200, '1000']);
    assert.equal((await fetch(`${srv.url}/`)).status, 200);
    const get = path => new Promise(res => http.get({ host: '127.0.0.1', port: new URL(srv.url).port, path }, r => { r.resume(); res(r.statusCode); }));
    for (const p of [`/../${secret}`, `/..%2f${secret}`, `/corpus/..%2f..%2f${secret}`]) {
      const status = await get(p);
      assert.ok(status === 403 || status === 404, `traversal ${p} answered ${status}`);
    }
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); rmSync(join(tmpdir(), secret), { force: true }); }
  const iso = await serveStatic({ '/': tmpdir() }, { isolate: true });
  try {
    const r = await fetch(`${iso.url}/missing`);
    assert.deepEqual([r.headers.get('cross-origin-opener-policy'), r.headers.get('cross-origin-embedder-policy')], ['same-origin', 'require-corp']);
  } finally { await iso.close(); }
});

test('export check: tracer pixels at the drawn points and an audio stream when the source has one', { skip: !HAS_FFMPEG && 'no ffmpeg' }, () => {
  const dir = tmp('export'), src = join(dir, 'src.mp4'), traced = join(dir, 'traced.mp4'), plain = join(dir, 'plain.mp4'), mute = join(dir, 'mute.mp4');
  try {
    const base = ['-f', 'lavfi', '-i', 'color=c=0xc8c8cc:s=320x240:d=2:r=30', '-f', 'lavfi', '-i', 'sine=d=2'];
    const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'];
    ff([...base, ...enc, src]);
    ff([...base, '-vf', "drawbox=x=50:y=97:w=200:h=6:color=yellow:t=fill:enable='gte(t,0.5)'", ...enc, traced]);
    ff([...base, ...enc, plain]);
    ff([...base, '-vf', "drawbox=x=50:y=97:w=200:h=6:color=yellow:t=fill:enable='gte(t,0.5)'", '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mute]);
    const points = Array.from({ length: 40 }, (_, i) => ({ t: 0.55 + i * 0.02, x: 55 + i * 4, y: 100, status: 'observed', alpha: 1 }));
    const view = { launch: { t: 0.5, x: 50, y: 100 }, points, observed: points };
    const opts = { video: src, view, width: 320, height: 240, sourceHasAudio: true };
    const ok = verifyExport(traced, opts);
    assert.ok(ok.pass && ok.tracer === 'checked' && ok.tracerHitFrac >= 0.9 && ok.preLaunchHitFrac === 0 && ok.hasAudio && /mp4/.test(ok.format), JSON.stringify(ok));
    const none = verifyExport(plain, opts);
    assert.deepEqual([none.pass, none.tracerHitFrac], [false, 0]);
    const silent = verifyExport(mute, opts);
    assert.deepEqual([silent.pass, silent.hasAudio, silent.tracerHitFrac >= 0.9], [false, false, true]);
    // A trace drawn to the clip's end is compared 0.1 s inside it (a seek into the last frame's tail yields no
    // frame); frames that cannot be read fail the export instead of passing it unchecked.
    const late = { ...view, observed: [...points, { t: 1.99, x: 215, y: 100 }] };
    const end = verifyExport(traced, { ...opts, view: late, sourceDuration: 2 });
    assert.deepEqual([end.tracer, end.pass, Math.abs(end.tracerT - 1.9) < 1e-9], ['checked', true, true], JSON.stringify(end));
    const lost = verifyExport(traced, { ...opts, video: join(dir, 'missing.mp4') });
    assert.deepEqual([lost.tracer, lost.pass], ['no-frame', false]);
    assert.equal(verifyExport(traced, { ...opts, view: { ...view, points: points.slice(0, 3) } }).tracer, 'few-points');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('report markdown shows the gate with pass/fail per target, the corpus pin, strata, intervals and definitions', () => {
  const clips = [scoreClip(hfResult({ frames: range(31, 61), predTo: T0 + 3 }), makeGt({ id: 'a' })), scoreClip(abstention(), makeGt({ id: 'b', kind: 'practice', noImpact: true, expected: 'abstain' }))];
  const rep = buildReport(clips, { runner: 'node', engine: 'hf', corpus: '/c', split: 'tune', corpusPin: PIN, code: { gitSha: 'abc', dirty: false, codeHash: 'h' } }, { bootstrap: { n: 20, seed: 1 } });
  assert.equal(rep.gate.results.length, ACCEPTANCE_SPEC.targets.length);
  const md = renderMarkdown(rep);
  for (const t of ACCEPTANCE_SPEC.targets) assert.match(md, new RegExp(`\\| ${t.id} \\| ${t.tier} \\|`), t.id);
  assert.match(md, /## Gate: SAFETY FAIL/);
  assert.match(md, /\| invisibleAbstain \| safety \|.*\| NO DATA \|/);
  assert.match(md, /\| noBallFalseTrace \| safety \|.*\| PASS \|/);
  assert.match(md, /\| corpusPinned \| PASS \|/);
  assert.match(md, /Corpus pin: generator synth-1\.1 code `cccccccccccc`; manifest `mmmmmmmmmmmm` \(tune 2 clips `tttttttttttt`, checksums match\)/);
  for (const h of ['## Safety', '## Quality', '### set', '### viewClass', '### control', '### failureModes', '## Clips', '## Definitions']) assert.ok(md.includes(h), h);
  assert.match(md, /\[0\.00%, \d+\.\d%\]/, 'Wilson intervals are printed');
  assert.match(renderMarkdown(buildReport(clips, { runner: 'node' })), /Corpus pin: none/);
});

const CHROME = findChrome();
test('browser runner: the ?bench=1 hook contract on a mock app, export included, and no hook fails fast', { skip: !CHROME ? 'no Chrome' : !HAS_FFMPEG ? 'no ffmpeg' : process.env.FLIGHTLINE_SKIP_CHROME ? 'FLIGHTLINE_SKIP_CHROME is set' : false, timeout: 180000 }, async () => {
  const root = tmp('app'), clip = join(root, 'clip.mp4'), dl = join(root, 'dl');
  mkdirSync(dl);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30', '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30', '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'export.mp4')]);
  // The app side of the contract (dist/app.js with ?bench=1), mocked: hf answers with an abstention, v2 with a trace
  // the UI demotes to partial, ?engine=wrong reports another engine than asked; /nohook/ never announces the hook.
  writeFileSync(join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><input id="fileInput" type="file"><button id="export" disabled>Save</button><script>
const q = new URLSearchParams(location.search), engine = q.get('engine');
document.getElementById('fileInput').addEventListener('change', e => setTimeout(() => {
  const v2 = { engine: 'global-v2', status: 'tracked', reasonCodes: [], points: [{ t: 0.1, x: 0.5, y: 0.5 }, { t: 0.2, x: 0.5, y: 0.4 }], camera: [] };
  const hf = { engine: 'hf', status: 'no_reliable_track', reasonCodes: ['no_launch'], points: [], observations: [], camera: [], observedFrames: 0, launch: null, completion: null, confidence: { value: 0, calibratedOn: 'uncalibrated', components: {} }, diagnostics: { path: q.get('decode') ?? 'codec' } };
  const res = engine === 'hf' ? hf : v2;
  document.getElementById('export').disabled = engine === 'hf';
  window.__flightlineLastResult = { engine: engine === 'wrong' ? 'v2' : engine, status: engine === 'hf' ? 'no_reliable_track' : 'partial', result: res,
    timings: { analysisMs: 12, phases: engine === 'hf' ? { scan: 7, impact: 1 } : { frames: 9 } }, frameTiming: engine === 'hf' ? { path: q.get('decode') ?? 'codec' } : { sourceFps: 30 }, error: null };
}, 50));
document.getElementById('export').addEventListener('click', async () => {
  const blob = await (await fetch('/export.mp4')).blob(), a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'x-flightline.mp4' });
  document.body.append(a); a.click();
  window.__flightlineLastExport = { mime: blob.type || 'video/mp4', bytes: blob.size, durationSec: 1 };
});
window.__flightlineBench = { ready: true, version: 53 };
</script>`);
  mkdirSync(join(root, 'nohook'));
  writeFileSync(join(root, 'nohook', 'index.html'), '<!doctype html><meta charset="utf-8"><input id="fileInput" type="file">');
  const srv = await serveStatic({ '/': root }), chrome = await launchChrome();
  try {
    const at = (engine, opts = {}) => runBrowserClip(chrome, srv.url, { id: 'c', video: clip }, { engine, timeoutMs: 15000, downloadDir: dl, ...opts });
    const hf = await at('hf', { path: 'element' });
    assert.equal(hf.error, null);
    assert.deepEqual([hf.result.engine, hf.result.status, hf.uiStatus, hf.runtime.path, hf.runtime.appAnalysisMs, hf.hookVersion], ['hf', 'no_reliable_track', 'no_reliable_track', 'element', 12, 53]);
    assert.deepEqual(hf.runtime.phases, { scan: 7, impact: 1 });
    assert.ok(hf.runtime.elapsedMs > 0 && hf.runtime.elapsedMs < 15000 && hf.runtime.peakTabRssMb > 0);
    const v2 = await at('v2', { exportIf: () => true });
    assert.deepEqual([v2.result.engine, v2.result.status, v2.shown.status, v2.uiStatus], ['global-v2', 'tracked', 'partial', 'partial'], 'the UI status is what gets scored');
    assert.deepEqual([v2.exported.pass, v2.exported.hookMatches, v2.exported.hook.mime, v2.exported.bytes], [true, true, 'video/mp4', readFileSync(join(root, 'export.mp4')).length], JSON.stringify(v2.exported));
    assert.match((await at('wrong')).error, /the app ran engine v2, not wrong/);
    const t0 = performance.now();
    await assert.rejects(runBrowserClip(chrome, `${srv.url}/nohook`, { id: 'c', video: clip }, { engine: 'hf', timeoutMs: 5000, hookWaitMs: 1500 }), /no bench hook: .*never set window.__flightlineBench.ready/);
    assert.ok(performance.now() - t0 < 10000);
  } finally { await chrome.close(); await srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('compareEngines on run reports uses only the clips both reports scored', () => {
  const good = id => filed(scoreClip(hfResult({ frames: range(31, 61) }), makeGt({ id }))), miss = id => filed(scoreClip(abstention(), makeGt({ id })));
  const sloppy = id => filed(scoreClip(v2Result({ frames: range(31, 61), at: off(1) }), makeGt({ id })));
  const hf = pinned([good('a'), miss('b')]), v2 = pinned([sloppy('a'), good('b'), good('c'), good('d')]);
  const r = compareEngines(hf, v2);
  assert.equal(r.clips, 2);
  assert.deepEqual([r.coverage.hf, r.coverage.base], [0.5, 1]);
  assert.equal(r.beats, false);
  const r2 = compareEngines(pinned([good('a'), good('b')]), pinned([sloppy('a'), miss('b'), good('zz')]));
  assert.deepEqual([r2.clips, r2.coverage.hf, r2.coverage.base, r2.beats], [2, 1, 0.5, true]);
  assert.equal(compareEngines(pinned([good('a')]), pinned([good('b')])).beats, false, 'no common clips is no evidence');
});
