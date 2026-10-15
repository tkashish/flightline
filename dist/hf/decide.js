/**
 * hf decision (U6): D3 rules R1-R5 per FlightCandidate, selection, status mapping and reason codes.
 *   R1 launch confirmed (accepted LaunchDecision with a candidate)
 *   R2 identity confirmed by flight: fit gates (inliers, robust data χ²/dof, plausible ball physics; priors are soft
 *      terms of the fit and never veto a good data fit) plus >= decide.r2MinObs inliers spanning >= decide.r2MinRealSec
 *      real, or a confirmed frame exit; and the swing-disc escape (D2)
 *   R3 no conflict: the selected flight beats every overlapping rival of another identity by decide.r3Margin
 *      confidence, and its own best rival branch by decide.identityMarginNats
 *   R4 camera usable: at most scan.camera.maxBadFrac of the flight window below decide.r4MinInlier
 *   R5 confidence >= decide.trackedMinConfidence
 * Confidence is the probability that the drawn trace is good. An abstention on a failed rule draws nothing, so it
 * reports value 0 (the rejected candidate's own value stays in components.candidate); a low_confidence abstention
 * reports its value, which is below decide.partialMinConfidence by definition.
 * Invariants (tested): no_reliable_track never selects or completes anything; completion needs R1 and R2; a
 * worse input never yields a better status.
 */
import { PARAMS } from './params.js';
import { makeDecision, makeConfidence, frameAt } from './types.js';
import { confidenceFeatures, scoreConfidence, DEFAULT_CONFIDENCE_MODEL, inlierObservations, tauOf, realSpan, fitExcess } from './confidence.js';

/** Swing-disc escape: some inlier lies where the swing envelope recorded no motion. A null envelope cannot be tested and passes. */
export function swingEscape(observations, envelope) {
  if (!envelope) return true;
  const { x0, y0, cellPx, w, h, mask } = envelope;
  for (const o of observations ?? []) {
    if ((o.flag ?? 'inlier') !== 'inlier') continue;
    const i = Math.floor((o.x - x0) / cellPx), j = Math.floor((o.y - y0) / cellPx);
    if (i < 0 || j < 0 || i >= w || j >= h || !mask[j * w + i]) return true;
  }
  return false;
}

/**
 * R2 fit gates (D3 §6, data first): inliers >= fit.r2MinInlierFrac, the dof-aware robust residual excess
 * (confidence.fitExcess of FlightFit.chi2Dof and chi2Limit; rmsNorm for fits without them) <= fit.r2MaxRmsNorm, and
 * plausible ball physics (FlightFit.plausible !== false: speed, elevation, C_D, C_L and tilt inside fit.physical, which
 * also rejects tee flights and club tracks that stop). The prior z (priorZMax)
 * is NOT a gate: priors are soft terms that shape the fit and lower confidence, and a good data fit that disagrees
 * with them (e.g. a camera pitch far from a sky line) is still a golf ball.
 */
export function fitGatesPass(fit, params = PARAMS) {
  const F = params.fit;
  return !!fit && fit.inlierFrac >= F.r2MinInlierFrac && fitExcess(fit, params) <= F.r2MaxRmsNorm && fit.plausible !== false;
}

/** Confirmed frame exit: observation ended at the frame edge and the exit came within decide.exitWithinFrames of the last inlier. */
export function exitConfirmed(track, completion, inliers, meta, params = PARAMS) {
  const end = completion ? completion.observedEnd : track?.observedEnd;
  if (end !== 'frame_exit' || !inliers.length) return false;
  const exitT = track?.exitT ?? (completion?.end?.type === 'exit' ? completion.end.t : null);
  if (exitT == null) return true;
  return exitT - inliers.at(-1).t <= (params.decide.exitWithinFrames + 0.5) / meta.fps;
}

/** Observation part of R2: >= r2MinObs inliers over >= r2MinRealSec real (first to last inlier, like validateResult). */
export function enoughObserved(inliers, tau, params = PARAMS) {
  const D = params.decide;
  return inliers.length >= D.r2MinObs && realSpan(inliers, tau) >= D.r2MinRealSec - 1e-9;
}

/** R2 without the swing escape: fit gates, and enough observation or a confirmed frame exit. */
export function flightConfirmed(track, fit, completion, meta, params = PARAMS) {
  const inl = inlierObservations(track, fit);
  if (!inl.length || !fitGatesPass(fit, params)) return false;
  return enoughObserved(inl, tauOf(fit, completion), params) || exitConfirmed(track, completion, inl, meta, params);
}

/** R4: fraction of camera entries in [t0, t1] with motion inliers below decide.r4MinInlier must not exceed scan.camera.maxBadFrac. */
export function cameraUsable(camera, t0, t1, params = PARAMS) {
  if (!camera || !camera.index?.length || !(t1 >= t0)) return { ok: true, badFrac: 0 };
  let n = 0, bad = 0;
  for (let k = 0; k < camera.index.length; k++) {
    if (camera.t[k] < t0 - 1e-9 || camera.t[k] > t1 + 1e-9) continue;
    n++;
    if (camera.inlier[k] < params.decide.r4MinInlier) bad++;
  }
  if (!n) {   // window between two analyzed frames: use the entry shown at t1
    const k = Math.max(0, frameAt(camera.t, t1));
    return { ok: camera.inlier[k] >= params.decide.r4MinInlier, badFrac: camera.inlier[k] >= params.decide.r4MinInlier ? 0 : 1 };
  }
  const badFrac = bad / n;
  return { ok: badFrac <= params.scan.camera.maxBadFrac, badFrac };
}

/* ------------------------------------------------------------------ candidates */

function evaluate(c, idx, ctx, P, model) {
  const meta = ctx.meta, fit = c.fit ?? null, comp = c.completion ?? null;
  const R1 = !!(c.decision?.accepted && c.launch);
  const inl = R1 ? inlierObservations(c.track, fit) : [];
  const confidence = scoreConfidence(confidenceFeatures(c, ctx), model);
  const tau = tauOf(fit, comp);
  const exit = R1 && exitConfirmed(c.track, comp, inl, meta, P);
  const observed = enoughObserved(inl, tau, P);
  const gates = fitGatesPass(fit, P);
  const escape = c.escape ?? swingEscape(inl, c.impact?.envelope ?? null);
  const escapeOk = !P.decide.requireEscape || escape || exit;
  // A fit that fails the R2 gates did not move like a golf ball. No fit at all only means no flight confirmation
  // (its confidence features take their worst values), so fewer observations can never improve the status.
  const fitBad = inl.length > 0 && !!fit && !gates;
  const R2 = R1 && inl.length > 0 && gates && (observed || exit) && escapeOk;
  const t0 = c.launch?.t0 ?? c.impact?.t0Est ?? 0, t1 = inl.at(-1)?.t ?? t0;
  const cam = cameraUsable(ctx.log?.camera, t0, t1, P);
  return {
    c, idx, R1, R2, R4: cam.ok, confidence, value: confidence.value, inl, exit, observed, escape, escapeOk, fitBad,
    span: [t0, t1], camBadFrac: cam.badFrac, single: !!c.launch?.single
  };
}

/** Share of a's inliers that b also observed (same frame, within max(2 px, its sigma·3)). */
function shared(a, b) {
  if (!a.inl.length || !b.inl.length) return 0;
  const byIndex = new Map(b.inl.map(o => [o.index, o]));
  let n = 0;
  for (const o of a.inl) {
    const q = byIndex.get(o.index);
    if (q && Math.hypot(q.x - o.x, q.y - o.y) <= Math.max(2, 3 * Math.max(o.sigma, q.sigma))) n++;
  }
  return n / a.inl.length;
}

const overlaps = (a, b) => Math.min(a.span[1], b.span[1]) - Math.max(a.span[0], b.span[0]) >= 0;
const rank = e => [e.R1 ? 1 : 0, e.R2 ? 1 : 0, e.value, e.inl.length, -e.idx];

/**
 * Two confidences closer than r3Margin are a tie the provisional model cannot break: it clamps every input at full
 * evidence (real clip: a two-frame fake launch at 0.980 beside a 125-inlier flight at 0.977). The raw evidence it
 * clamps breaks the tie: a dominates b when it leads by identityMarginNats on both the launch statistic S and the
 * track LLR (there S 24 vs 8, LLR 1332 vs 16 nats).
 */
function dominates(a, b, D) {
  const p = a.confidence.components, q = b.confidence.components, m = D.identityMarginNats;
  if (!(Math.abs(a.value - b.value) < D.r3Margin) || ![p.launchS, q.launchS, p.trackLlr, q.trackLlr].every(Number.isFinite)) return false;
  return p.launchS - q.launchS >= m && p.trackLlr - q.trackLlr >= m;
}
const better = (a, b, D) => {
  if (a.R1 === b.R1 && a.R2 === b.R2) { if (dominates(a, b, D)) return true; if (dominates(b, a, D)) return false; }
  const p = rank(a), q = rank(b);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] > q[i];
  return false;
};

function abstainCodes(evals, ctx) {
  if (!evals.length) {
    if (!ctx.impacts?.length) return ['no_launch'];
    const rej = [...new Set((ctx.decisions ?? []).filter(d => !d.accepted && d.reason).map(d => d.reason))];
    return rej.length ? rej : ['ball_not_found_after_impact'];
  }
  const rej = [...new Set(evals.map(e => e.c.decision?.reason).filter(Boolean))];
  return rej.length ? rej : ['launch_not_confirmed'];
}

function abstain(codes, rules, confidence, info = []) {
  return makeDecision({
    status: 'no_reliable_track', reasonCodes: [...new Set([...codes, ...info])], selected: null, allowCompletion: false,
    rules, confidence
  });
}

/** Confidence of an abstention on a failed rule: nothing is drawn, so value 0; the candidate's value is kept as a component. */
const ruleAbstention = conf => makeConfidence(0, { ...conf.components, candidate: conf.value }, conf.calibratedOn);

/**
 * Decide over FlightCandidates (one per launch, best track each). ctx: DecideContext {meta, log, impacts, decisions,
 * params}; optional ctx.confidenceModel overrides DEFAULT_CONFIDENCE_MODEL. Returns a validated Decision.
 */
export function decide(candidates, ctx) {
  const P = ctx?.params ?? PARAMS, D = P.decide, model = ctx?.confidenceModel ?? DEFAULT_CONFIDENCE_MODEL;
  const evals = (candidates ?? []).map((c, i) => evaluate(c, i, ctx, P, model));
  const none = { R1: false, R2: false, R3: false, R4: false, R5: false };
  if (!evals.some(e => e.R1)) return abstain(abstainCodes(evals, ctx), none, makeConfidence(0, {}, model.calibratedOn));

  let best = null;
  for (const e of evals) if (!best || better(e, best, D)) best = e;
  // Rivals: other confirmed launches that overlap in time and are not the same object (share < identityShareMax).
  const others = evals.filter(e => e !== best && e.R1 && e.inl.length);
  const same = e => Math.max(shared(best, e), shared(e, best)) >= D.identityShareMax;
  const rivals = others.filter(e => overlaps(best, e) && !same(e));
  const branchMargin = best.c.track?.features?.identityMargin;
  const R3 = rivals.every(e => best.value - e.value >= D.r3Margin || dominates(best, e, D)) && !(Number.isFinite(branchMargin) && branchMargin < D.identityMarginNats);
  const R5 = best.value >= D.trackedMinConfidence;
  const rules = { R1: true, R2: best.R2, R3, R4: best.R4, R5 };
  const info = others.some(e => !overlaps(best, e) && !same(e) && e.R2 && e.value >= D.partialMinConfidence) ? ['multiple_shots'] : [];
  const conf = best.confidence;

  const ruleConf = ruleAbstention(conf);
  if (!best.inl.length) return abstain(['ball_not_found_after_impact'], rules, ruleConf, info);
  if (!best.R4) return abstain(['camera_motion_uncompensated'], rules, ruleConf, info);
  if (!R3) return abstain(['identity_conflict'], rules, ruleConf, info);
  if (best.fitBad) return abstain(['flight_inconsistent'], rules, ruleConf, info);
  if (!best.escapeOk) return abstain(['club_only_motion'], rules, ruleConf, info);

  const comp = best.c.completion ?? null;
  if (comp?.ramp) info.push('speed_ramp');
  const out = (status, codes, allowCompletion) => makeDecision({
    status, reasonCodes: [...new Set([...codes, ...info])], selected: best.c, allowCompletion, rules, confidence: conf
  });
  if (best.value < D.partialMinConfidence) return abstain([best.inl.length < 2 ? 'insufficient_visible_frames' : 'low_confidence'], rules, conf, info);
  if (!best.R2) return out('partial', [best.single ? 'single_sample_launch' : 'tracking_ended_early'], false);
  if (best.single) return out('partial', ['single_sample_launch'], !!comp);
  if (!comp) return out('partial', ['tracking_ended_early'], false);
  if (R5 && !comp.uncertain) return out('tracked', [], true);
  return out('partial', ['completion_uncertain'], true);
}
