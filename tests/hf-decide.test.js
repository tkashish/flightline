// U6 decision and confidence: D3 R1-R5, status mapping, reason codes, invariants, monotone confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import {
  makeObservation, makeLaunchCandidate, makeLaunchDecision, makeImpact, makeTrackHypothesis, makeFlightFit, makeCompletion,
  makeFlightCandidate, makeSourceMeta, identityTrack, check, STATUS_RANK, isDowngradeOrSame, curveStatus, cameraSamples,
  validateResult, makeAbstention, makeConfidence
} from '../dist/hf/types.js';
import { decide, swingEscape, flightConfirmed, cameraUsable, exitConfirmed } from '../dist/hf/decide.js';
import { confidenceFeatures, scoreConfidence, fitConfidence, DEFAULT_CONFIDENCE_MODEL, inlierObservations, confidenceInputs, provisionalModel, calibrate } from '../dist/hf/confidence.js';
import { normalizeTrackReport } from '../dist/track-status.js';

const W = 1080, H = 1920;
const metaFor = (fps = 30, n = 300) => makeSourceMeta({ width: W, height: H, fps, frameCount: n, times: Float64Array.from({ length: n }, (_, i) => i / fps), duration: n / fps });

/**
 * One synthetic FlightCandidate: a ball rising from (540, 1500) observed every frame from t0. Options cover every
 * rule input: observation count, fps, slow motion, fit gates, completion, exit, envelope, launch margin, rivals.
 */
function cand(o = {}) {
  const fps = o.fps ?? 30, k0 = o.k0 ?? 30, t0 = (k0 + 0.3) / fps, n = o.n ?? 20, id = o.id ?? 'A', tau = o.tau ?? 1;
  const dx = o.dx ?? 2, dy = o.dy ?? -15, ax = o.x0 ?? 540, ay = o.y0 ?? 1500;
  const pos = j => ({ x: ax + dx * j, y: ay + dy * j + 0.2 * j * j });
  const observations = Array.from({ length: n }, (_, j) => makeObservation({ index: k0 + 1 + j, t: (k0 + 1 + j) / fps, ...pos(j + 0.7), sigma: 0.5, z: 10, z1: 8, polarity: 1, src: j < 4 ? 'launch' : 'tbd' }));
  const launch = makeLaunchCandidate({
    id, hypId: `H${id}`, t0, address: { x: ax, y: ay }, d0: 12, dir: { x: dx / Math.hypot(dx, dy), y: dy / Math.hypot(dx, dy) }, v: Math.hypot(dx, dy), c: 0.02,
    polarity: 1, samples: observations.slice(0, Math.min(4, n)).map(x => ({ ...x, src: 'launch' })), view: 'dtl', single: !!o.single, S: o.S ?? 10, margin: o.margin ?? 3
  });
  const accepted = o.accepted ?? true;
  const decision = makeLaunchDecision(accepted
    ? { hypId: launch.hypId, accepted: true, candidate: launch, S: o.S ?? 10, Snull: [5], margin: launch.margin }
    : { hypId: launch.hypId, accepted: false, reason: o.reason ?? 'launch_not_confirmed', S: 2, Snull: [5], margin: -6 });
  const impact = makeImpact({
    id: launch.hypId, spotId: `S${id}`, address: launch.address, d0: 12, polarity: 1, kLast: k0, tLast: k0 / fps, kFirstAbsent: k0 + 1,
    tFirstAbsent: (k0 + 1) / fps, interval: { t0: k0 / fps, t1: (k0 + 1) / fps }, t0Est: t0, envelope: o.envelope ?? null
  });
  const last = observations.at(-1);
  const exitT = o.exitT !== undefined ? o.exitT : (o.observedEnd === 'frame_exit' ? last.t + 1 / fps : null);
  const track = n ? makeTrackHypothesis({
    id: `${id}/b0`, launchId: id, observations, state: o.observedEnd === 'frame_exit' ? 'exited' : 'lost', observedEnd: o.observedEnd ?? 'lost',
    exitT: (o.observedEnd ?? 'lost') === 'frame_exit' ? exitT : null, llr: o.llr ?? 80, features: { identityMargin: o.identityMargin ?? null }
  }) : null;
  const fit = o.fit === null || !n ? null : makeFlightFit({
    kind: 'm3d', params: [0], names: ['p'], cov: [1], tau, view: 'dtl', rmsNorm: o.rmsNorm ?? 0.8, inlier: new Uint8Array(n).fill(1),
    inlierFrac: o.inlierFrac ?? 1, priorZMax: o.priorZMax ?? 1, converged: true, ill: false, landingT: null,
    ...(o.chi2Dof != null ? { chi2Dof: o.chi2Dof } : {}), ...(o.chi2Limit != null ? { chi2Limit: o.chi2Limit } : {}), ...(o.plausible != null ? { plausible: o.plausible } : {}),
    predict: t => ({ t, ...pos((t - t0) * fps), cov: [0.2, 0, 0.2], d: 6, h: null }), sample: () => []
  });
  const endT = last ? last.t + (o.predictedVideoSec ?? 0.6) : 0;
  const completion = fit && o.completion !== false ? makeCompletion({
    end: { type: o.endType ?? ((o.observedEnd ?? 'lost') === 'frame_exit' ? 'exit' : 'landing'), t: endT, ...pos((endT - t0) * fps) },
    observedEnd: o.observedEnd ?? 'lost', tLastObs: last.t, observedSec: (last.t - t0) / tau, predictedSec: (endT - last.t) / tau,
    slowMoFactor: tau, uncertain: !!o.uncertain, ramp: !!o.ramp, fade: o.uncertain ? { from: last.t + 0.1, to: endT } : null
  }) : null;
  const keep = accepted && !o.noTrack;
  return makeFlightCandidate({ impact, decision, launch: accepted ? launch : null, track: keep ? track : null, fit: keep ? fit : null, completion: keep ? completion : null, escape: o.escape ?? null });
}

const ctxFor = (cands, o = {}) => {
  const meta = o.meta ?? metaFor(o.fps ?? 30);
  const camera = o.camera ?? identityTrack(meta);
  return { meta, log: { camera }, impacts: o.impacts ?? cands.map(c => c.impact), decisions: o.decisions ?? cands.map(c => c.decision), params: o.params ?? PARAMS };
};
const run = (cands, o) => decide(cands, ctxFor(cands, o));
const rank = d => STATUS_RANK[d.status];

/* ---------------------------------------------------------------- status mapping (D3 §6, protocol §10) */

test('tracked: R1-R5 and a normal completion; allowCompletion; only info codes', () => {
  const c = cand(), d = run([c]);
  assert.equal(d.status, 'tracked');
  assert.deepEqual(d.reasonCodes, []);
  assert.equal(d.allowCompletion, true);
  assert.deepEqual(d.rules, { R1: true, R2: true, R3: true, R4: true, R5: true });
  assert.equal(d.selected, c);
  assert.ok(d.confidence.value >= PARAMS.decide.trackedMinConfidence);
  assert.deepEqual(check('Decision', d), []);
});

test('partial (a): R1-R4 with an early fade or confidence below tracked -> completion_uncertain, arc allowed', () => {
  const faded = run([cand({ uncertain: true })]);
  assert.equal(faded.status, 'partial');
  assert.deepEqual(faded.reasonCodes, ['completion_uncertain']);
  assert.equal(faded.allowCompletion, true);
  // R5 binds: a launch margin of 1 (5/6 of the way from full launch evidence to the acceptance gate) is partial.
  const mid = run([cand({ margin: 1 })]);
  assert.ok(mid.confidence.value >= PARAMS.decide.partialMinConfidence && mid.confidence.value < PARAMS.decide.trackedMinConfidence, `${mid.confidence.value}`);
  assert.equal(mid.status, 'partial');
  assert.deepEqual(mid.reasonCodes, ['completion_uncertain']);
  assert.equal(mid.rules.R5, false);
  // ... and so is a fit residual near the R2 data gate.
  const rough = run([cand({ margin: 6, rmsNorm: 1.35 })]);
  assert.equal(rough.status, 'partial'); assert.equal(rough.rules.R2, true); assert.equal(rough.rules.R5, false);
});

test('partial (b): R1 without R2 (short track, no exit) -> observed-only, tracking_ended_early, no completion', () => {
  const d = run([cand({ n: 6, margin: 4 })]);
  assert.equal(d.status, 'partial');
  assert.deepEqual(d.reasonCodes, ['tracking_ended_early']);
  assert.equal(d.allowCompletion, false);
  assert.equal(d.rules.R2, false);
  assert.equal(run([cand({ completion: false })]).reasonCodes[0], 'tracking_ended_early', 'no completion: observed-only');
});

test('low confidence abstains: low_confidence, nothing selected, no completion', () => {
  const d = run([cand({ margin: 0, n: 9, rmsNorm: 1.4, inlierFrac: 0.82 })]);
  assert.ok(d.confidence.value < PARAMS.decide.partialMinConfidence, `${d.confidence.value}`);
  assert.equal(d.status, 'no_reliable_track');
  assert.deepEqual(d.reasonCodes, ['low_confidence']);
  assert.equal(d.selected, null);
  assert.equal(d.allowCompletion, false);
});

test('single-sample launch (when enabled upstream) is at most partial: single_sample_launch', () => {
  assert.deepEqual(run([cand({ single: true })]).reasonCodes, ['single_sample_launch']);
  assert.equal(run([cand({ single: true })]).status, 'partial');
  assert.equal(run([cand({ single: true, n: 5 })]).allowCompletion, false);
});

test('speed ramp is reported as info; early exits give no_launch or the launch rejections', () => {
  assert.deepEqual(run([cand({ ramp: true })]).reasonCodes, ['speed_ramp']);
  assert.deepEqual(decide([], ctxFor([], { impacts: [], decisions: [] })).reasonCodes, ['no_launch']);
  const rej = cand({ accepted: false, reason: 'club_only_motion' });
  assert.deepEqual(decide([], ctxFor([], { impacts: [rej.impact], decisions: [rej.decision] })).reasonCodes, ['club_only_motion']);
  assert.deepEqual(run([rej]).reasonCodes, ['club_only_motion']);
  assert.deepEqual(decide([], ctxFor([], { impacts: [rej.impact], decisions: [] })).reasonCodes, ['ball_not_found_after_impact']);
  assert.deepEqual(run([cand({ noTrack: true })]).reasonCodes, ['ball_not_found_after_impact']);
});

/* ---------------------------------------------------------------- R2 identity confirmed by flight */

test('R2: >= r2MinObs inliers spanning >= r2MinRealSec real, with the fit gates; real time uses the slow-motion factor', () => {
  const meta = metaFor(30), D = PARAMS.decide, ok = c => flightConfirmed(c.track, c.fit, c.completion, meta, PARAMS);
  assert.equal(ok(cand({ n: D.r2MinObs })), true, '8 frames at 30 fps = 0.233 s');
  assert.equal(ok(cand({ n: D.r2MinObs - 1 })), false);
  assert.equal(ok(cand({ n: 8, fps: 240 })), false, '8 frames at 240 fps span 0.03 s');
  assert.equal(ok(cand({ n: 37, fps: 240 })), true, '37 frames at 240 fps span 0.15 s');
  assert.equal(ok(cand({ n: 8, tau: 8 })), false, '8x slow motion: 0.23 s video is 0.03 s real');
  assert.equal(ok(cand({ n: 37, tau: 8 })), true, '1.2 s video = 0.15 s real');
  // Fit gates: data first. The robust χ²/dof (FlightFit.chi2Dof, else rmsNorm²) and plausible physics gate; priors never do.
  for (const bad of [{ inlierFrac: 0.79 }, { rmsNorm: 1.6 }, { chi2Dof: 2.26 }, { rmsNorm: 0.5, chi2Dof: 2.3 }, { plausible: false }]) assert.equal(ok(cand({ n: 30, ...bad })), false, JSON.stringify(bad));
  for (const edge of [{ inlierFrac: 0.8 }, { rmsNorm: 1.5 }, { chi2Dof: 2.25 }, { rmsNorm: 2, chi2Dof: 1 }, { plausible: true }]) assert.equal(ok(cand({ n: 30, ...edge })), true, JSON.stringify(edge));
  for (const z of [3.1, 3.66, 5, 20]) assert.equal(ok(cand({ n: 30, priorZMax: z })), true, `prior z ${z} must not veto a good data fit`);
  // The data gate is dof-aware: FlightFit.chi2Limit (the χ²/dof that is both beyond 1.5² and significant at its dof).
  assert.equal(ok(cand({ n: 30, chi2Dof: 3, chi2Limit: 4 })), true, 'few dof: an excess that is not significant passes');
  assert.equal(ok(cand({ n: 30, chi2Dof: 4.1, chi2Limit: 4 })), false);
  assert.equal(ok(cand({ n: 30, chi2Dof: 2.3, chi2Limit: 2.25 })), false);
  assert.equal(ok(cand({ n: 30, fit: null })), false, 'no fit, no flight confirmation');
});

test('R2 by frame exit: a short track confirmed only when the exit comes within exitWithinFrames of the last inlier', () => {
  const meta = metaFor(30);
  const c = cand({ n: 3, observedEnd: 'frame_exit' });
  assert.equal(flightConfirmed(c.track, c.fit, c.completion, meta, PARAMS), true);
  const late = cand({ n: 3, observedEnd: 'frame_exit', exitT: (30 + 3) / 30 + 3 / 30 });
  assert.equal(exitConfirmed(late.track, late.completion, inlierObservations(late.track, late.fit), meta, PARAMS), false, 'exit 3 frames after the last inlier');
  assert.equal(flightConfirmed(cand({ n: 3, observedEnd: 'lost' }).track, c.fit, null, meta, PARAMS), false);
  const d = run([cand({ n: 3, observedEnd: 'frame_exit', margin: 6 })]);
  assert.equal(d.rules.R2, true);
  assert.equal(d.allowCompletion, true);
  // A confirmed exit is R2's alternative to r2MinObs, so it is full observation evidence: a strong launch is tracked.
  assert.equal(d.confidence.components.obsEvidence, 1);
  assert.equal(d.status, 'tracked');
  const lateExit = run([cand({ n: 3, observedEnd: 'frame_exit', margin: 6, exitT: (30 + 3) / 30 + 3 / 30 })]);
  assert.ok(lateExit.confidence.components.obsEvidence < 1 && lateExit.status !== 'tracked', 'an unconfirmed exit is only 3 observations');
});

test('fit gates failing -> flight_inconsistent; no fit -> no flight confirmation (never tracked)', () => {
  for (const bad of [{ inlierFrac: 0.6 }, { rmsNorm: 2.5 }, { chi2Dof: 4 }, { plausible: false }]) {
    const d = run([cand({ n: 30, ...bad })]);
    assert.equal(d.status, 'no_reliable_track', JSON.stringify(bad));
    assert.deepEqual(d.reasonCodes, ['flight_inconsistent'], JSON.stringify(bad));
    // An abstention draws nothing: never a high confidence, the candidate's own value is kept as a component.
    assert.equal(d.confidence.value, 0, JSON.stringify(bad));
    assert.ok(Number.isFinite(d.confidence.components.candidate));
  }
  const nofit = run([cand({ n: 30, fit: null })]);
  assert.equal(nofit.rules.R2, false);
  assert.equal(nofit.allowCompletion, false);
  assert.deepEqual(nofit.reasonCodes, ['low_confidence'], 'missing fit features take their worst values');
});

test('priors are soft terms: a prior conflict never vetoes a good data fit, it only lowers confidence beyond r2MaxPriorZ', () => {
  const F = PARAMS.fit, clean = run([cand({ n: 30, margin: 6 })]);
  assert.equal(clean.status, 'tracked');
  for (const z of [F.r2MaxPriorZ + 0.66, 2 * F.r2MaxPriorZ, 20]) {
    const d = run([cand({ n: 30, margin: 6, priorZMax: z })]);
    assert.equal(d.rules.R2, true, `prior z ${z}`);
    assert.ok(!d.reasonCodes.includes('flight_inconsistent'), `prior z ${z}: ${d.reasonCodes}`);
    assert.ok(d.confidence.value < clean.confidence.value, `prior z ${z} lowers the value`);
  }
  // No cost below the conflict level; at twice it (others full) the value is the partial boundary.
  assert.equal(run([cand({ n: 30, margin: 6, priorZMax: F.r2MaxPriorZ })]).confidence.value, clean.confidence.value);
  const atGate = run([cand({ n: 30, margin: 6, priorZMax: 2 * F.r2MaxPriorZ })]);
  assert.ok(Math.abs(atGate.confidence.value - PARAMS.decide.partialMinConfidence) < 1e-9, `${atGate.confidence.value}`);
  assert.equal(run([cand({ n: 30, margin: 6, priorZMax: 2 * F.r2MaxPriorZ - 0.1 })]).status, 'partial', 'just inside the boundary: drawn, partial');
});

test('abstentions are never marked high-confidence: rule failures report 0, low_confidence its value below partial', () => {
  const env = { x0: 0, y0: 0, cellPx: 8, w: 200, h: 300, mask: new Uint8Array(60000).fill(1) };
  const meta = metaFor(30), cam = identityTrack(meta); for (let k = 0; k < cam.index.length; k++) cam.inlier[k] = 0.2;
  const cases = [
    run([cand({ margin: 6, envelope: env })]), run([cand({ margin: 6 })], { camera: cam }),
    run([cand({ id: 'A', margin: 4 }), cand({ id: 'B', margin: 4, x0: 200, dx: -2 })]), run([cand({ margin: 6, plausible: false })])
  ];
  assert.deepEqual(cases.map(d => d.reasonCodes[0]), ['club_only_motion', 'camera_motion_uncompensated', 'identity_conflict', 'flight_inconsistent']);
  for (const d of cases) {
    assert.equal(d.status, 'no_reliable_track');
    assert.equal(d.confidence.value, 0, d.reasonCodes.join());
    assert.ok(d.confidence.components.candidate > PARAMS.decide.trackedMinConfidence, 'the rejected candidate itself looked good');
  }
  const low = run([cand({ margin: 0, n: 9, rmsNorm: 1.4, inlierFrac: 0.82 })]);
  assert.deepEqual(low.reasonCodes, ['low_confidence']);
  assert.ok(low.confidence.value > 0 && low.confidence.value < PARAMS.decide.partialMinConfidence);
});

test('swing-disc escape (D2): a track that never leaves the swing envelope is club_only_motion, unless it exits the frame', () => {
  const env = (x0, y0, w, h) => ({ x0, y0, cellPx: 8, w, h, mask: new Uint8Array(w * h).fill(1) });
  const all = env(0, 0, 200, 300);                 // covers the whole 1600 x 2400 area of every observation
  const some = env(400, 1300, 40, 30);             // covers only the first observations
  assert.equal(swingEscape(cand().track.observations, null), true, 'no envelope: nothing to escape');
  assert.equal(swingEscape(cand().track.observations, all), false);
  assert.equal(swingEscape(cand().track.observations, some), true);
  assert.equal(swingEscape(cand().track.observations.map(o => ({ ...o, flag: 'rejected' })), some), false, 'only inliers count');
  const club = run([cand({ envelope: all })]);
  assert.deepEqual(club.reasonCodes, ['club_only_motion']);
  assert.equal(club.status, 'no_reliable_track');
  assert.equal(run([cand({ envelope: some })]).status, 'tracked');
  assert.equal(run([cand({ n: 3, observedEnd: 'frame_exit', envelope: all, margin: 6 })]).rules.R2, true, 'a frame exit confirms instead');
  assert.equal(run([cand({ envelope: all })], { params: mergeParams({ decide: { requireEscape: false } }) }).status, 'tracked');
});

test('R4: camera motion inliers below r4MinInlier on more than maxBadFrac of the flight window abstain', () => {
  const meta = metaFor(30), cam = identityTrack(meta), c = cand({ n: 20 });
  const window = Array.from(cam.index).filter(k => cam.t[k] >= c.launch.t0 && cam.t[k] <= c.track.observations.at(-1).t);
  const bad = (frac) => { const t = identityTrack(meta); window.slice(0, Math.floor(frac * window.length)).forEach(k => { t.inlier[k] = 0.3; }); return t; };
  assert.equal(cameraUsable(bad(0.2), c.launch.t0, c.track.observations.at(-1).t, PARAMS).ok, true, `20% of ${window.length} bad is allowed`);
  const d = run([c], { camera: bad(0.35) });
  assert.deepEqual(d.reasonCodes, ['camera_motion_uncompensated']);
  assert.equal(d.rules.R4, false);
});

test('R3: an overlapping rival must trail by r3Margin; a later non-overlapping confirmed flight is multiple_shots', () => {
  const best = cand({ id: 'A', margin: 4 });
  const close = cand({ id: 'B', margin: 3.6, x0: 200, dx: -2 });
  const far = cand({ id: 'C', margin: 0.2, x0: 200, dx: -2, n: 9, rmsNorm: 1.3 });
  assert.deepEqual(run([best, close]).reasonCodes, ['identity_conflict']);
  assert.equal(run([best, close]).rules.R3, false);
  assert.equal(run([best, far]).status, 'tracked');
  assert.equal(run([far, best]).selected.launch.id, 'A', 'order does not matter');
  const later = cand({ id: 'D', margin: 3.8, k0: 120, x0: 200 });
  const two = run([best, later]);
  assert.equal(two.status, 'tracked');
  assert.deepEqual(two.reasonCodes, ['multiple_shots']);
  // A second impact hypothesis that follows the same ball is the same identity, not a rival.
  const twin = cand({ id: 'E', margin: 3.9 });
  assert.equal(run([best, twin]).status, 'tracked');
});

test('R3: a rival inside r3Margin is no identity risk when the best leads on both launch S and track LLR', () => {
  const m = PARAMS.decide.identityMarginNats;
  const real = cand({ id: 'A', margin: 3.6, S: 10 + m, llr: 80 + m });
  const fake = cand({ id: 'B', margin: 4, x0: 200, dx: -2 });
  for (const order of [[real, fake], [fake, real]]) {
    const d = run(order);
    assert.equal(d.status, 'tracked');
    assert.equal(d.selected.launch.id, 'A', 'the dominating candidate is selected although its value is lower');
  }
  // a lead on one of the two is not enough
  assert.deepEqual(run([cand({ id: 'A', margin: 3.6, S: 10 + m, llr: 80 + m - 0.1 }), fake]).reasonCodes, ['identity_conflict']);
  assert.deepEqual(run([cand({ id: 'A', margin: 3.6, S: 10 + m - 0.1, llr: 80 + m }), fake]).reasonCodes, ['identity_conflict']);
  // beyond r3Margin the confidence decides as before
  const weak = cand({ id: 'C', margin: 0.2, x0: 200, dx: -2, n: 9, rmsNorm: 1.3, S: 10 + m, llr: 80 + m });
  assert.equal(run([cand({ id: 'A', margin: 4 }), weak]).selected.launch.id, 'A');
});

test('R3: the selected track needs identityMarginNats over its best rival branch', () => {
  assert.deepEqual(run([cand({ identityMargin: PARAMS.decide.identityMarginNats - 0.1 })]).reasonCodes, ['identity_conflict']);
  assert.equal(run([cand({ identityMargin: PARAMS.decide.identityMarginNats })]).status, 'tracked');
  assert.equal(run([cand({ identityMargin: null })]).status, 'tracked', 'no rival branch');
});

/* ---------------------------------------------------------------- invariants */

function lcg(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
function randomOptions(r) {
  const n = 2 + Math.floor(r() * 40), fps = pick(r, [30, 60, 240]);
  return {
    n, fps, tau: pick(r, [1, 1, 4, 8]), margin: r() * 8, rmsNorm: 0.3 + r() * 1.5, inlierFrac: 0.72 + r() * 0.28, priorZMax: r() * 3.6,
    observedEnd: pick(r, ['lost', 'lost', 'frame_exit', 'clip_end']), uncertain: r() < 0.25, completion: r() > 0.15, ramp: r() < 0.1,
    single: r() < 0.08, accepted: r() > 0.08, noTrack: r() < 0.05, identityMargin: pick(r, [null, null, null, null, 2, 6]), fit: r() < 0.08 ? null : undefined,
    envelope: r() < 0.12 ? { x0: 0, y0: 0, cellPx: 8, w: 200, h: 300, mask: new Uint8Array(60000).fill(1) } : null
  };
}

test('invariants over 400 random decisions: abstentions select and complete nothing; completion needs R1 and R2', () => {
  const r = lcg(11), D = PARAMS.decide;
  for (let i = 0; i < 400; i++) {
    const o = randomOptions(r), cands = [cand(o)];
    if (r() < 0.3) cands.push(cand({ ...randomOptions(r), id: 'B', x0: 200, k0: pick(r, [30, 31, 150]) }));
    const d = run(cands, { fps: o.fps });
    assert.deepEqual(check('Decision', d), [], JSON.stringify(o));
    if (d.status === 'no_reliable_track') { assert.equal(d.selected, null); assert.equal(d.allowCompletion, false); }
    if (d.allowCompletion) {
      assert.ok(d.rules.R1 && d.rules.R2);
      // validateResult invariant 4 on what the pipeline will publish.
      const s = d.selected, inl = inlierObservations(s.track, s.fit), tau = s.completion.slowMoFactor;
      assert.ok((inl.length >= D.r2MinObs && (inl.at(-1).t - inl[0].t) / tau >= D.r2MinRealSec - 1e-9) || s.completion.observedEnd === 'frame_exit', JSON.stringify(o));
    }
    if (d.status === 'tracked') assert.ok(Object.values(d.rules).every(Boolean));
    if (!o.accepted && cands.length === 1) assert.equal(d.status, 'no_reliable_track');
  }
});

test('never upgrade: degrading any one input never raises the status (400 random bases x 10 degradations)', () => {
  const r = lcg(23);
  const all = { x0: 0, y0: 0, cellPx: 8, w: 200, h: 300, mask: new Uint8Array(60000).fill(1) };
  const degrade = [
    o => ({ ...o, n: Math.max(2, Math.floor(o.n / 2)) }), o => ({ ...o, margin: Math.max(0, o.margin - 1.5) }),
    o => ({ ...o, rmsNorm: o.rmsNorm + 0.6 }), o => ({ ...o, inlierFrac: Math.max(0.3, o.inlierFrac - 0.15) }),
    o => ({ ...o, priorZMax: o.priorZMax + 1.5 }), o => ({ ...o, uncertain: true }), o => ({ ...o, completion: false }),
    o => ({ ...o, envelope: all, observedEnd: o.observedEnd === 'frame_exit' ? 'lost' : o.observedEnd }), o => ({ ...o, identityMargin: 1 }),
    o => ({ ...o, accepted: false })
  ];
  for (let i = 0; i < 400; i++) {
    const o = { ...randomOptions(r), accepted: true, noTrack: false }, base = run([cand(o)], { fps: o.fps });
    for (const [j, f] of degrade.entries()) {
      const worse = run([cand(f(o))], { fps: o.fps });
      assert.ok(rank(worse) <= rank(base), `degradation ${j} upgraded ${base.status} -> ${worse.status}: ${JSON.stringify(o)}`);
    }
    // A weaker overlapping rival never helps the selected flight either.
    const rival = run([cand(o), cand({ ...o, id: 'B', x0: 200, margin: Math.max(0, o.margin - 2) })], { fps: o.fps });
    assert.ok(rank(rival) <= rank(base), `rival upgraded ${base.status} -> ${rival.status}`);
  }
});

/** Minimal pipeline-style assembly of an HFResult from a Decision (normalized, dense curve through the inliers). */
function assemble(d, c, meta, { forceCompletion = false } = {}) {
  const camera = cameraSamples(identityTrack(meta), meta);
  if (d.status === 'no_reliable_track' && !forceCompletion) return makeAbstention(d.reasonCodes, { camera, confidence: d.confidence });
  const L = c.launch, inl = inlierObservations(c.track, c.fit), comp = d.allowCompletion || forceCompletion ? c.completion : null;
  const knots = [{ t: L.t0, x: L.address.x, y: L.address.y }, ...inl.map(o => ({ t: o.t, x: o.x, y: o.y }))];
  if (comp) knots.push({ t: comp.end.t, x: comp.end.x, y: comp.end.y });
  const at = t => { let i = 1; while (i < knots.length - 1 && knots[i].t < t) i++; const a = knots[i - 1], b = knots[i], u = (t - a.t) / (b.t - a.t); return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) }; };
  const tEnd = knots.at(-1).t, times = new Set(knots.map(k => k.t));
  for (let t = L.t0; t < tEnd; t += 1 / PARAMS.display.hz) times.add(t);
  const obsT = inl.map(o => o.t), half = PARAMS.display.observedHalfFrame / meta.fps, diag = Math.hypot(W, H);
  const points = [...times].sort((a, b) => a - b).filter((t, i, a) => !i || t - a[i - 1] > 1e-7).map((t, i) => {
    const p = i ? at(t) : L.address;
    return { t, x: p.x / W, y: p.y / H, status: i ? curveStatus(t, obsT, half) : 'anchor' };
  });
  if (comp?.end.type === 'fade') points.at(-1).alpha = 0;
  const tau = comp?.slowMoFactor ?? 1, last = inl.at(-1);
  return {
    points, observations: inl.map(o => ({ t: o.t, x: o.x / W, y: o.y / H, sigma: o.sigma / diag })), camera, engine: 'hf', observedFrames: inl.length,
    status: forceCompletion && d.status === 'no_reliable_track' ? 'partial' : d.status,
    reasonCodes: forceCompletion && d.status === 'no_reliable_track' ? ['tracking_ended_early'] : d.reasonCodes, confidence: d.confidence,
    launch: { t: L.t0, x: L.address.x / W, y: L.address.y / H, dir: L.dir, view: L.view },
    completion: comp ? { end: { type: comp.end.type, t: comp.end.t, x: comp.end.x / W, y: comp.end.y / H }, observedEnd: comp.observedEnd,
      observedSec: (last.t - L.t0) / tau, predictedSec: (comp.end.t - last.t) / tau, slowMoFactor: tau } : null
  };
}

test('decide agrees with validateResult: allowed completions validate, a completion without R2 is refused', () => {
  const meta = metaFor(30);
  for (const o of [{}, { uncertain: true }, { n: 3, observedEnd: 'frame_exit', margin: 6 }, { n: 6, margin: 5 }, { margin: 0.4, rmsNorm: 1.2 }]) {
    const c = cand(o), d = run([c]), res = assemble(d, c, meta);
    const v = validateResult(res, { width: W, height: H, fps: 30 });
    assert.ok(v.ok, `${JSON.stringify(o)} ${d.status}: ${v.errors.join('; ')}`);
    assert.ok(isDowngradeOrSame(d.status, normalizeTrackReport(res).status), `normalizeTrackReport upgraded ${d.status}`);
  }
  // Negative control: R2 fails (7 observations, no exit), so a pipeline that completed anyway breaks invariant 4.
  const short = cand({ n: 7, margin: 5 }), d = run([short]);
  assert.equal(d.allowCompletion, false);
  const forced = validateResult(assemble(d, short, meta, { forceCompletion: true }), { width: W, height: H, fps: 30 });
  assert.equal(forced.ok, false);
  assert.match(forced.errors.join('\n'), /flight-confirmed identity/);
});

/* ---------------------------------------------------------------- confidence */

test('confidence: monotone in every model input, worst value for missing inputs, valid Confidence objects', () => {
  const r = lcg(5), M = DEFAULT_CONFIDENCE_MODEL;
  assert.equal(M.calibratedOn, PARAMS.confidence.uncalibrated);
  assert.ok(M.weights.length + 1 <= PARAMS.confidence.maxParams);
  assert.equal(M.features[0], 'nullMargin', 'monotone in the null margin first');
  assert.deepEqual([...M.features], ['nullMargin', 'obsEvidence', 'fitRms', 'inlierFrac', 'priorZMax']);
  for (let i = 0; i < 300; i++) {
    const f = { nullMargin: r() * 14 - 7, obsEvidence: r() * 1.4, fitRms: 0.5 + r() * 2, inlierFrac: 0.5 + r() * 0.5, priorZMax: r() * 10 };
    const v = scoreConfidence(f).value;
    assert.deepEqual(check('Confidence', scoreConfidence(f)), []);
    M.features.forEach((k, j) => {
      const up = { ...f, [k]: f[k] + M.signs[j] * (0.1 + r()) };
      assert.ok(scoreConfidence(up).value >= v - 1e-12, `${k} must not lower the value`);
      assert.ok(scoreConfidence({ ...f, [k]: null }).value <= v + 1e-12, `missing ${k} is the worst case`);
    });
  }
  // Semantic directions, independent of the model's own sign table.
  const base = { nullMargin: 2, obsEvidence: 0.6, fitRms: 1.2, inlierFrac: 0.9, priorZMax: 4 }, val = f => scoreConfidence({ ...base, ...f }).value;
  assert.ok(val({ nullMargin: 5 }) > val({}) && val({ obsEvidence: 0.9 }) > val({}) && val({ inlierFrac: 1 }) > val({}));
  assert.ok(val({ fitRms: 1.4 }) < val({}), 'a worse fit lowers confidence');
  assert.ok(val({ priorZMax: 6 }) < val({}), 'a stronger prior conflict lowers confidence (soft)');
  const feats = confidenceFeatures(cand(), { meta: metaFor() });
  assert.equal(Object.keys(feats)[0], 'nullMargin');
  for (const v of Object.values(feats)) assert.ok(v === null || Number.isFinite(v));
  assert.ok(scoreConfidence(confidenceFeatures(cand({ margin: 6 }))).value > scoreConfidence(confidenceFeatures(cand({ margin: 0.5 }))).value);
});

test('fitConfidence: logistic with <= maxParams and non-negative weights; isotonic is monotone; tune label', () => {
  const r = lcg(9), rows = [];
  for (let i = 0; i < 600; i++) {
    const f = { nullMargin: r() * 8 - 1, obsEvidence: r(), fitRms: 1 + r(), inlierFrac: 0.6 + 0.4 * r(), priorZMax: 3 + 6 * r() };
    // Truth rises with the margin and observation, falls with the fit residual; priorZMax is made ANTI-correlated
    // (higher prior z -> more often good) to test the sign constraint.
    const z = 1.0 * f.nullMargin + 2.5 * f.obsEvidence - 3 * (f.fitRms - 1) + 0.5 * (f.priorZMax - 3) - 2.5;
    rows.push({ features: f, label: r() < 1 / (1 + Math.exp(-z)) ? 1 : 0 });
  }
  const m = fitConfidence(rows);
  assert.equal(m.kind, 'logistic');
  assert.equal(m.calibratedOn, PARAMS.confidence.calibratedOn);
  assert.ok(m.weights.length + 1 <= PARAMS.confidence.maxParams);
  assert.ok(m.weights.every(w => w >= 0), `${m.weights}`);
  assert.ok(m.weights[0] > 0.5 && m.weights[2] > 1, `margin and fitRms weights ${m.weights}`);
  assert.equal(m.weights[4], 0, 'an anti-monotone relation is clamped at 0, never reversed');
  const score = f => scoreConfidence(f, m).value;
  assert.ok(score({ nullMargin: 6, obsEvidence: 1, fitRms: 1, inlierFrac: 1, priorZMax: 3 }) > 0.95);
  assert.ok(score({ nullMargin: 0, obsEvidence: 0.1, fitRms: 2, inlierFrac: 0.6, priorZMax: 9 }) < 0.2);
  assert.equal(scoreConfidence({ nullMargin: 6 }, m).calibratedOn, 'synthetic-tune-v1');
  const iso = fitConfidence(rows, { kind: 'isotonic' });
  assert.ok(iso.isotonic.y.every((v, i, a) => !i || v >= a[i - 1]), 'PAV output is non-decreasing');
  let prev = -1;
  for (let x = -2; x <= 10; x += 0.5) { const v = scoreConfidence({ nullMargin: x, obsEvidence: 0.8, fitRms: 1.2, inlierFrac: 0.9, priorZMax: 3 }, iso).value; assert.ok(v >= prev - 1e-12); prev = v; }
  assert.throws(() => fitConfidence(rows, { params: mergeParams({ confidence: { maxParams: 5 } }) }), /maxParams/, '5 inputs + bias > 5');
  assert.equal(fitConfidence(rows, { features: ['nullMargin', 'fitRms'], params: mergeParams({ confidence: { maxParams: 3 } }) }).weights.length, 2);
  assert.throws(() => fitConfidence(rows, { features: ['nullMargin', 'colour'] }), /unknown/);
  assert.throws(() => fitConfidence([rows[0]]), /at least 2/);
});

test('provisional confidence: every weight follows from the R-rule gates (full evidence -> provisionalFull, one gate -> partial)', () => {
  const C = PARAMS.confidence, D = PARAMS.decide, M = DEFAULT_CONFIDENCE_MODEL, ins = confidenceInputs(PARAMS);
  assert.equal(M.calibratedOn, C.uncalibrated);
  const full = Object.fromEntries(ins.map(i => [i.name, i.full]));
  assert.ok(Math.abs(scoreConfidence(full).value - C.provisionalFull) < 1e-9, 'all inputs at full evidence');
  for (const i of ins) {
    const v = scoreConfidence({ ...full, [i.name]: i.gate }).value;
    assert.ok(Math.abs(v - D.partialMinConfidence) < 1e-9, `${i.name} at its gate ${i.gate}: ${v}`);
    // Half way to the gate is between partial and full; log-odds add, so two half-way inputs equal one at its gate.
    const half = scoreConfidence({ ...full, [i.name]: (i.full + i.gate) / 2 }).value;
    assert.ok(half > D.partialMinConfidence && half < C.provisionalFull, `${i.name} half way: ${half}`);
  }
  const [a, b] = ins, two = scoreConfidence({ ...full, [a.name]: (a.full + a.gate) / 2, [b.name]: (b.full + b.gate) / 2 }).value;
  assert.ok(Math.abs(two - D.partialMinConfidence) < 1e-9, `two half-way inputs: ${two}`);
  // The gates are the R-rule thresholds themselves: change one and the model follows (no hand-set weight).
  const P2 = mergeParams({ fit: { r2MaxRmsNorm: 2 } }), M2 = provisionalModel(P2), j = M2.features.indexOf('fitRms');
  assert.ok(Math.abs(scoreConfidence({ ...full, fitRms: 2 }, M2).value - D.partialMinConfidence) < 1e-9);
  assert.ok(M2.weights[j] < M.weights[j], 'a looser data gate weighs the residual less');
  assert.ok(M.weights.every(w => w > 0) && M.weights.length + 1 <= C.maxParams);
  assert.throws(() => provisionalModel(mergeParams({ confidence: { provisionalFull: 0.5 } })), /provisionalFull/);
});

test('calibrate(samples): monotone tune-split model from result components or candidates, with a calibration report', () => {
  const r = lcg(31), samples = [];
  for (let i = 0; i < 400; i++) {
    const components = { nullMargin: r() * 10 - 2, obsEvidence: r(), fitRms: 0.8 + r() * 1.2, inlierFrac: 0.7 + 0.3 * r(), priorZMax: r() * 6, logObs: 3 };
    const z = 0.8 * components.nullMargin + 3 * components.obsEvidence - 4 * (components.fitRms - 1) - 1;
    samples.push({ components, correct: r() < 1 / (1 + Math.exp(-z)) });
  }
  const m = calibrate(samples);
  assert.equal(m.kind, PARAMS.confidence.kind);
  assert.equal(m.calibratedOn, PARAMS.confidence.calibratedOn);
  assert.ok(m.weights.every(w => w >= 0) && m.weights.length + 1 <= PARAMS.confidence.maxParams);
  assert.equal(m.report.fitted.n, 400);
  assert.ok(m.report.fitted.logLoss < m.report.provisional.logLoss, 'the tune fit beats the provisional model on its own samples');
  assert.ok(m.report.fitted.ece >= 0 && m.report.fitted.ece < 0.1, `ECE ${m.report.fitted.ece}`);
  // A calibrated model drives decide through ctx.confidenceModel and labels the result.
  const c = cand(), d = decide([c], { ...ctxFor([c]), confidenceModel: m });
  assert.equal(d.confidence.calibratedOn, 'synthetic-tune-v1');
  // Samples may be candidates (features computed here); one-class sample sets are refused.
  const fromCands = calibrate([...Array(6)].map((_, i) => ({ candidate: cand({ margin: i, rmsNorm: 0.8 + 0.2 * i }), ctx: { meta: metaFor() }, label: i > 2 })));
  assert.ok(fromCands.weights.every(w => w >= 0));
  assert.throws(() => calibrate(samples.map(s => ({ ...s, correct: true }))), /both good and bad/);
  assert.throws(() => calibrate([{ correct: true }, { correct: false }]), /no features/);
  const iso = calibrate(samples, { kind: 'isotonic' });
  assert.equal(iso.kind, 'isotonic');
  assert.ok(iso.isotonic.y.every((v, i, a) => !i || v >= a[i - 1]));
});

test('decide cost per call (one strong candidate, and four with rivals)', () => {
  const one = [cand()], four = [cand(), cand({ id: 'B', x0: 200 }), cand({ id: 'C', x0: 300, k0: 120 }), cand({ id: 'D', x0: 700, margin: 1 })];
  for (const [name, cs] of [['1 candidate', one], ['4 candidates', four]]) {
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) run(cs);
    const ms = (performance.now() - t1) / 200;
    console.log(`  decide ${name}: ${ms.toFixed(3)} ms/call`);
    assert.ok(ms < 5);
  }
});
