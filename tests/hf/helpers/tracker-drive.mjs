/**
 * Pipeline-shaped harness for the U6 tests: the protocol §6 frame loop over FrameConsumers, builders for
 * LaunchCandidate / TrackerContext / FlightCandidate, and the post-finish fit + re-association loop.
 */
import { PARAMS } from '../../../dist/hf/params.js';
import {
  simAt, makeObservation, makeLaunchCandidate, makeImpact, makeCoarseLog, makeLaunchDecision, makeFlightCandidate, makeCompletion
} from '../../../dist/hf/types.js';
import { FlightTracker, reassociate } from '../../../dist/hf/flight-tracker.js';
import { stubTube } from './tracker-stub-tube.mjs';
import { stubFitFlight } from './tracker-stub-fit.mjs';

/** Protocol §6 frame loop: consume is called for every index of each window, in order, even with no requests. */
export async function drive(source, consumers, camera) {
  const wins = consumers.map(c => c.window());
  const from = Math.min(...wins.map(w => w.from)), to = Math.max(...wins.map(w => w.to));
  for await (const ref of source.frames({ from, to })) {
    const i = ref.index;
    for (let j = 0; j < consumers.length; j++) {
      const c = consumers[j], w = wins[j];
      if (c.done || i < w.from || i >= w.to) continue;
      const reqs = c.roiRequests(i);
      const crops = await Promise.all(reqs.map(q => ref.lumaRect(q.rect, { pool: q.pool })));
      c.consume(i, ref.t, crops, simAt(camera, i));
    }
    if (consumers.every(c => c.done)) break;
  }
  return consumers.map(c => c.finish());
}

/** Projective-law fit of chain samples (test-side stand-in for U3): s = vτ/(1+cτ) along dir from the address. */
export function launchLaw(samples, address, t0, fps) {
  const last = samples.at(-1), dx = last.x - address.x, dy = last.y - address.y, n = Math.hypot(dx, dy);
  const dir = { x: dx / n, y: dy / n };
  let best = null;
  for (let c = 0; c <= 0.6; c += 0.002) {
    let sxy = 0, sxx = 0;
    for (const o of samples) { const tau = (o.t - t0) * fps, f = tau / (1 + c * tau), s = (o.x - address.x) * dir.x + (o.y - address.y) * dir.y; sxy += f * s; sxx += f * f; }
    const v = sxy / sxx;
    let e = 0;
    for (const o of samples) { const tau = (o.t - t0) * fps, s = (o.x - address.x) * dir.x + (o.y - address.y) * dir.y; e += (s - v * tau / (1 + c * tau)) ** 2; }
    if (!best || e < best.e) best = { v, c, e };
  }
  return { dir, v: best.v, c: best.c };
}

/** LaunchCandidate from the first `m` path rows ({i, t, x, y, d}) with impact between frames `impact` and impact+1. */
export function makeLaunch({ id = 'L1', path, impact, fps = 30, m = 4, d0, polarity = 1, margin = 3, clubTrack = null, address, t0Frac = 0.02 }) {
  const t0 = (impact + t0Frac) / fps, A = address ?? { x: path[0].x, y: path[0].y };
  const samples = path.slice(0, m).map(p => makeObservation({ index: p.i, t: p.i / fps, x: p.x, y: p.y, sigma: 0.4, z: 12, z1: 12, d: p.d ?? null, polarity, src: 'launch' }));
  const law = launchLaw(samples, A, t0, fps);
  return makeLaunchCandidate({
    id, hypId: `H-${id}`, t0, address: A, d0, dir: law.dir, v: Math.max(0.1, law.v), c: law.c, polarity, samples,
    view: 'dtl', clubTrack, S: 8 + margin, margin
  });
}

/** Minimal valid CoarseLog: camera, movers, spots, specks, an energy store (optional active(k, x, y, r)). */
export function makeLog(meta, camera, { movers = [], spots = [], specks = [], active = null, pool = 1 } = {}) {
  return makeCoarseLog({
    pool, w: Math.floor(meta.width / pool), h: Math.floor(meta.height / pool), stride: 1,
    frames: { index: Int32Array.from(camera.index), t: Float64Array.from(camera.t) }, camera, spots, vacates: [],
    energy: { cellPx: 8, disk: () => ({ index: new Int32Array(0), e: new Float32Array(0) }), active: active ?? (() => 0) },
    horizon: null, movers, specks
  });
}

export function makeImpactFor(launch, fps, { envelope = null, id } = {}) {
  const k = Math.floor(launch.t0 * fps);
  return makeImpact({
    id: id ?? launch.hypId, spotId: `S-${launch.id}`, address: launch.address, d0: launch.d0, polarity: launch.polarity,
    kLast: k, tLast: k / fps, kFirstAbsent: k + 1, tFirstAbsent: (k + 1) / fps,
    interval: { t0: k / fps, t1: (k + 1) / fps }, t0Est: launch.t0, envelope
  });
}

/** One FlightTracker per launch with the stub tube and fit; returns {trackers, tubes, ctxs}. */
export function trackers(meta, log, launches, { tube = {}, fit = stubFitFlight, params = PARAMS, envelope = null } = {}) {
  const tubes = [], RoiTube = stubTube({ ...tube, log: tubes });
  const ctxs = launches.map(l => ({ meta, log, impact: makeImpactFor(l, meta.fps, { envelope }), params }));
  return { trackers: launches.map((l, i) => new FlightTracker(l, ctxs[i], { RoiTube, fitFlight: fit })), tubes, ctxs, deps: { RoiTube, fitFlight: fit } };
}

/** Post-finish loop of protocol §3: fitFlight, reassociate, ... then a final fit. */
export function refine(hyp, ctx, launch, deps, params = PARAMS) {
  const fitCtx = { meta: ctx.meta, launch, horizon: null, tauPrior: ctx.impact.tauPrior, params };
  let fit = null;
  for (let i = 0; i < params.track.reassocIters; i++) {
    fit = deps.fitFlight(hyp.observations, fitCtx, fit ? { warm: fit } : {});
    hyp = reassociate(hyp, fit, { ...ctx, launch }, deps);
  }
  fit = deps.fitFlight(hyp.observations, fitCtx, { warm: fit });
  return { hyp, fit };
}

/** FlightCandidate with a simple completion stub (U5 is not exercised here). */
export function candidate(impact, launch, hyp, fit, { uncertain = false, type } = {}) {
  const decision = makeLaunchDecision({ hypId: launch.hypId, accepted: true, candidate: launch, S: launch.S, Snull: [launch.S - launch.margin - 1], margin: launch.margin });
  const inl = hyp ? hyp.observations.filter(o => o.flag === 'inlier') : [];
  const last = inl.at(-1);
  const completion = last && fit ? makeCompletion({
    end: { type: type ?? (hyp.observedEnd === 'frame_exit' ? 'exit' : 'landing'), t: last.t + 0.5, x: last.x, y: last.y },
    observedEnd: hyp.observedEnd, tLastObs: last.t, observedSec: (last.t - launch.t0) / fit.tau, predictedSec: 0.5 / fit.tau,
    slowMoFactor: fit.tau, uncertain
  }) : null;
  return makeFlightCandidate({ impact, decision, launch, track: hyp, fit, completion, escape: null, features: {} });
}
