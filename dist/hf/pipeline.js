/**
 * hf pipeline (U9): analyzeClip runs one clip through every pass (protocol doc §3 and §6, FINAL "Pipeline").
 *
 *   P1   coarse scan of every frame (stride scanStride(fps): decimated only above 60 fps) -> CoarseLog
 *   P1b  findImpacts -> ImpactHypothesis[] ([] -> no_launch)
 *   P2a  native launch confirmation over the union of the LaunchConfirmer windows (t0 − 0.25 s .. t0 + 0.5 s
 *        plus null windows) -> LaunchDecision[] (none accepted -> the rejections' reasons)
 *   P2b  native flight pass from frameAt(t0 − 0.25 s): every FlightTracker in one pass, crops per roiRequests,
 *        ending when all are done -> TrackHypothesis[] per launch, best first
 *   fit  per launch (best branch): fitFlight, then track.reassocIters × (reassociate, warm fitFlight); what the
 *        final fit rejects is flagged 'rejected'; completeFlight on the inliers -> FlightCandidate
 *   decide -> Decision; displayCurve(fit, inliers, allowCompletion ? completion : null) -> HFResult (normalized)
 *
 * Memory: no FrameRef outlives its loop step (the source closes it on next() / return()); native passes
 * re-decode instead of buffering; crops are fresh copies the consumers own, and one frame's requests are bounded
 * (pipeline.maxRequestFrames per rect, pipeline.maxFrameCropFrames in total, in frame areas). When the next frame any
 * consumer needs is more than pipeline.restartGapSec of video away (two shots far apart), the pass restarts there.
 * Decode policy: a frame the source could not verify (verified === false, element path) is re-read up to
 * pipeline.unverifiedRetries times; one still unverified marks the result slow_decode_path, or abstains with
 * decoder_limited when it lies in the launch or flight window.
 * Errors: an aborted signal rejects with its AbortError, and a failing FrameSource rejects with an HFError
 * ('decode' unless the source set a code), so the worker can retry on the element path. A collaborator that
 * throws or breaks its output contract gives an internal_error abstention (fail closed; the message is in
 * diagnostics.errors), one that could not be loaded gives engine_not_ready, and a result that fails
 * validateResult becomes an internal_error abstention.
 */
import {
  HFError, RESULT_ENGINE, cameraSamples, check, coarsePool, frameAt, make, makeAbstention, makeProgress, simAt, throwIfAborted,
  validateResult
} from './types.js';
import { PARAMS, PARAMS_VERSION, scanStride } from './params.js';

/** Collaborator -> the unit file that exports it (protocol doc §1, §6). */
export const MODULE_FILES = Object.freeze({
  CoarseScanner: 'coarse-scan.js', findImpacts: 'impact.js', LaunchConfirmer: 'launch-null.js', RoiTube: 'roi-detect.js',
  FlightTracker: 'flight-tracker.js', reassociate: 'flight-tracker.js', fitFlight: 'flight-model.js',
  completeFlight: 'complete.js', displayCurve: 'display-curve.js', decide: 'decide.js'
});
// One literal import() per file, so a cache-busting rewrite can find every specifier.
const LOADERS = {
  'coarse-scan.js': () => import('./coarse-scan.js'),
  'impact.js': () => import('./impact.js'),
  'launch-null.js': () => import('./launch-null.js'),
  'roi-detect.js': () => import('./roi-detect.js'),
  'flight-tracker.js': () => import('./flight-tracker.js'),
  'flight-model.js': () => import('./flight-model.js'),
  'complete.js': () => import('./complete.js'),
  'display-curve.js': () => import('./display-curve.js'),
  'decide.js': () => import('./decide.js')
};
const now = () => globalThis.performance?.now?.() ?? Date.now();
const msg = e => e?.message ?? String(e);
const PASS = new WeakSet();   // errors that reject analyzeClip unchanged: source failures, onProgress throws
const passOn = e => { const err = e instanceof Error ? e : new Error(msg(e)); PASS.add(err); return err; };

/** A collaborator threw or broke its output contract; `where` names the call. */
class ModuleError extends Error {
  constructor(where, cause) { super(`${where}: ${msg(cause)}`, { cause }); this.name = 'ModuleError'; this.where = where; }
}
async function guard(where, fn) {
  try { return await fn(); } catch (e) { throw e instanceof ModuleError || PASS.has(e) ? e : new ModuleError(where, e); }
}
function contract(where, errs) {
  if (errs.length) throw new ModuleError(where, new HFError('internal', `contract: ${errs.slice(0, 6).join('; ')}${errs.length > 6 ? ` (+${errs.length - 6} more)` : ''}`));
}
async function fromSource(where, fn) {
  try { return await fn(); } catch (e) { throw passOn(e instanceof HFError ? e : new HFError('decode', `${where}: ${msg(e)}`)); }
}
function sourceContract(where, errs) { if (errs.length) throw passOn(new HFError('decode', `${where}: ${errs.slice(0, 4).join('; ')}`)); }

/** Stand-in for a collaborator that is not available: calling or constructing it throws HFError 'unsupported'. */
export function unavailableModule(name, reason) {
  const stub = function () {
    const e = new HFError('unsupported', `hf collaborator ${name} is unavailable: ${reason}`);
    e.unavailable = name;
    throw e;
  };
  return Object.defineProperty(stub, 'unavailable', { value: reason });
}

/**
 * The real collaborators (HFModules), loaded with dynamic import(). A unit file that fails to load, or lacks
 * the export, yields unavailableModule(name), so it fails only when used (analyzeClip: engine_not_ready).
 * @param {{load?:(file:string) => Promise<object>}} [opts]  load replaces the importer (tests)
 * @returns {Promise<import('./types.js').HFModules>}
 */
export async function defaultModules({ load = file => LOADERS[file]() } = {}) {
  const files = [...new Set(Object.values(MODULE_FILES))];
  const got = await Promise.allSettled(files.map(f => Promise.resolve().then(() => load(f))));
  const byFile = Object.fromEntries(files.map((f, i) => [f, got[i]]));
  const out = {};
  for (const [name, file] of Object.entries(MODULE_FILES)) {
    const r = byFile[file], fn = r.status === 'fulfilled' ? r.value?.[name] : undefined;
    out[name] = typeof fn === 'function' ? fn
      : unavailableModule(name, r.status === 'rejected' ? `${file} failed to load (${msg(r.reason)})` : `${file} has no export ${name}`);
  }
  return out;
}

/**
 * Analyze one clip (protocol doc §6). The caller owns and closes the source.
 * @param {import('./types.js').FrameSource} source
 * @param {{onProgress?:(p:import('./types.js').Progress) => void, signal?:AbortSignal, modules?:object,
 *   params?:object, diagnostics?:boolean}} [opts]  modules: HFModules (default: await defaultModules());
 *   diagnostics adds per-impact, per-launch and per-candidate detail to result.diagnostics
 * @returns {Promise<import('./types.js').HFResult>}  always a valid result; rejects with an AbortError on
 *   signal, or with an HFError ('decode' unless the source set a code) when the source fails
 */
export async function analyzeClip(source, { onProgress, signal, modules, params = PARAMS, diagnostics = false } = {}) {
  throwIfAborted(signal);
  const R = {
    source, signal, params, detail: !!diagnostics, meta: source?.meta ?? null, M: null, log: null, impacts: [], decisions: [],
    candidates: [], decision: null, rejected: null, ms: {}, counts: {}, start: now(),
    windows: new Map(), unverified: new Map(), replaced: null,   // confirmer windows by hypothesis id; unverified frame -> phase
    progress: reporter(onProgress, params.pipeline.progressMs)
  };
  try {
    R.progress('probe', 0, 1);
    if (R.meta) sourceContract('source.meta', check('SourceMeta', R.meta, 'meta'));
    if (!R.meta?.frameCount) return finish(R, abstain(R, ['no_frames']));
    const M = modules ?? await defaultModules();
    R.M = Object.fromEntries(Object.keys(MODULE_FILES).map(k => [k, typeof M?.[k] === 'function' ? M[k] : unavailableModule(k, 'not in modules')]));
    R.progress('probe', 1, 1);
    return finish(R, await run(R));
  } catch (e) {
    if (signal?.aborted) throwIfAborted(signal);
    if (PASS.has(e)) throw e;
    const missing = e instanceof ModuleError && e.cause?.unavailable;
    return finish(R, makeAbstention(codes(R, [missing ? 'engine_not_ready' : 'internal_error'])), [e instanceof ModuleError ? e.message : `pipeline: ${msg(e)}`]);
  }
}

async function run(R) {
  const { meta, params, M } = R;
  R.log = await timed(R, 'scan', () => coarseScan(R));
  if (!R.log) return abstain(R, ['no_frames']);
  R.progress('impact', 0, 1);
  const impacts = await timed(R, 'impact', () => guard('findImpacts', () => M.findImpacts(R.log, meta, { params })));
  contract('findImpacts', listErrors('ImpactHypothesis', impacts, 'impacts', h => h.id));
  R.impacts = impacts.slice(0, params.impact.maxHypotheses);
  R.progress('impact', 1, 1);
  if (!R.impacts.length) return abstain(R, ['no_launch']);
  R.decisions = await timed(R, 'launch', () => confirmLaunches(R));
  const accepted = R.decisions.filter(d => d.accepted);
  if (!accepted.length) return abstain(R, R.decisions.map(d => d.reason));
  contract('LaunchConfirmer.finish', new Set(accepted.map(d => d.candidate.id)).size === accepted.length ? [] : ['duplicate launch ids']);
  const jobs = await timed(R, 'track', () => trackLaunches(R, strongest(accepted, params.pipeline.maxLaunches)));
  R.candidates = await timed(R, 'fit', () => fitLaunches(R, jobs));
  return timed(R, 'decide', () => conclude(R));
}

/* ------------------------------------------------------------------ passes */

async function coarseScan(R) {
  const { meta, params, M } = R, n = meta.frameCount, stride = scanStride(meta.fps, params), total = Math.ceil(n / stride);
  const longEdge = params.scan.longEdge, pool = coarsePool(meta.width, meta.height, longEdge);
  const scanner = await guard('new CoarseScanner', () => new M.CoarseScanner(meta, { params }));
  let buf, k = 0;
  R.progress('scan', 0, total);
  await pass(R, 'scan', { from: 0, to: n, stride }, async ref => {
    const where = `frame ${ref.index} lumaCoarse`, img = await fromSource(where, () => ref.lumaCoarse(longEdge, buf));
    sourceContract(where, imageErrors(img, meta, pool));
    buf = img.data;   // reused: the scanner copies what it keeps (CoarseScanner.push contract)
    await guard(`CoarseScanner.push(${ref.index})`, () => scanner.push(ref.index, ref.t, img));
    R.progress('scan', ++k, total);
  });
  R.counts.scan.fed = k;
  if (!k) return null;
  const log = await guard('CoarseScanner.finish', () => scanner.finish());
  contract('CoarseScanner.finish', check('CoarseLog', log, 'log'));
  return log;
}

async function confirmLaunches(R) {
  const { meta, log, params, M } = R, list = [], out = [];
  for (const h of R.impacts) {
    const x = await consumer(R, `LaunchConfirmer(${h.id})`, () => new M.LaunchConfirmer(h, { meta, log, params }));
    R.windows.set(h.id, { from: x.from, to: x.to });
    list.push(x);
  }
  await drive(R, 'launch', list);
  for (const [j, h] of R.impacts.entries()) {
    const where = `${list[j].label}.finish`, d = await guard(where, () => list[j].c.finish());
    contract(where, check('LaunchDecision', d, 'decision'));
    contract(where, d.hypId === h.id && (!d.candidate || d.candidate.hypId === h.id) ? [] : [`decided '${d.hypId}' (launch of '${d.candidate?.hypId}'), not '${h.id}'`]);
    out.push(d);
  }
  return out;
}

async function trackLaunches(R, accepted) {
  const { meta, log, params, M } = R, list = [], jobs = [];
  for (const decision of accepted) {
    const launch = decision.candidate, impact = R.impacts.find(h => h.id === decision.hypId);
    const ctx = { meta, log, impact, params }, deps = { RoiTube: M.RoiTube, fitFlight: M.fitFlight };
    list.push(await consumer(R, `FlightTracker(${launch.id})`, () => new M.FlightTracker(launch, ctx, deps)));
    jobs.push({ impact, decision, launch, ctx, deps, hyps: [] });
  }
  await drive(R, 'track', list);
  for (const [j, job] of jobs.entries()) {
    const where = `${list[j].label}.finish`, hyps = await guard(where, () => list[j].c.finish());
    contract(where, listErrors('TrackHypothesis', hyps, 'hyps'));
    contract(where, hyps.filter(h => h.launchId !== job.launch.id).map(h => `${h.id}: launchId '${h.launchId}' != '${job.launch.id}'`));
    job.hyps = hyps;
  }
  return jobs;
}

async function fitLaunches(R, jobs) {
  const out = [];
  R.progress('fit', 0, jobs.length);
  for (const job of jobs) { out.push(await fitLaunch(R, job)); R.progress('fit', out.length, jobs.length); }
  return out;
}

/** The best branch of one launch: fit, re-associate, refit warm, flag fit outliers, complete. */
async function fitLaunch(R, { impact, decision, launch, ctx, deps, hyps }) {
  const { meta, log, params, M } = R, fitCtx = { meta, launch, horizon: log.horizon, tauPrior: impact.tauPrior, params };
  let track = hyps[0] ?? null, fit = null, completion = null, rounds = 0;
  const tracked = track ? inliers(track).length : 0;
  if (tracked) {
    fit = await fitTrack(R, track, fitCtx);
    while (fit && rounds < params.track.reassocIters) {
      throwIfAborted(R.signal);
      const where = `reassociate(${track.id})`, prev = track;
      track = await guard(where, () => M.reassociate(prev, fit, ctx, deps));
      rounds++;
      contract(where, check('TrackHypothesis', track, 'track'));
      contract(where, track.launchId === launch.id ? [] : [`launchId '${track.launchId}' != '${launch.id}'`]);
      // Converged: the same observations would be refitted warm from this very fit and re-associated the same way.
      if (sameObservations(prev, track)) break;
      fit = inliers(track).length ? await fitTrack(R, track, fitCtx, fit) : null;
    }
    if (fit) track = flagOutliers(track, fit);
    const obs = inliers(track);
    if (fit && obs.length) {
      throwIfAborted(R.signal);
      const cctx = { meta, camera: log.camera, horizon: log.horizon, launch, observedEnd: track.observedEnd, params };
      completion = await guard('completeFlight', () => M.completeFlight(fit, obs, cctx));
      contract('completeFlight', check('Completion', completion, 'completion'));
    }
  }
  const features = {
    branches: hyps.length, trackedInliers: tracked, inliers: track ? inliers(track).length : 0,
    rejected: track ? track.observations.filter(o => o.flag === 'rejected').length : 0, reassocRounds: rounds
  };
  return guard('FlightCandidate', () => make('FlightCandidate', { impact, decision, launch, track, fit, completion, escape: null, features }));
}

async function fitTrack(R, track, ctx, warm) {
  throwIfAborted(R.signal);
  const where = `fitFlight(${track.id})`, fit = await guard(where, () => R.M.fitFlight(track.observations, ctx, { warm, signal: R.signal }));
  contract(where, check('FlightFit', fit, 'fit'));
  contract(where, fit.inlier.length === track.observations.length ? [] : [`inlier mask of ${fit.inlier.length} for ${track.observations.length} observations`]);
  return fit;
}

async function conclude(R) {
  const { meta, log, params, M } = R;
  R.progress('decide', 0, 1);
  const dec = await guard('decide', () => M.decide(R.candidates, { meta, log, impacts: R.impacts, decisions: R.decisions, params }));
  contract('decide', check('Decision', dec, 'decision'));
  R.decision = dec;
  if (dec.status === 'no_reliable_track') return abstain(R, dec.reasonCodes, dec.confidence);
  const sel = dec.selected, obs = sel.track ? inliers(sel.track) : [];
  contract('decide', selectionErrors(R, dec, obs));
  const completion = dec.allowCompletion ? sel.completion : null;   // arc completion only after R1 and R2
  throwIfAborted(R.signal);
  const curve = await guard('displayCurve', () => M.displayCurve(sel.fit, obs, completion, { meta, launch: sel.launch, params }));
  contract('displayCurve', listErrors('DisplayPoint', curve, 'curve'));
  R.progress('decide', 1, 1);
  return assemble(R, dec, sel, obs, completion, curve);
}

/* ------------------------------------------------------------------ frame loop */

/**
 * One frames() pass over [from, to) by stride. visit(ref) returns undefined to go on, anything else ends the pass
 * and is returned. The iterator is always closed, so the source closes its last FrameRef. A frame the source could
 * not verify (ref.verified === false: the element path never saw the presented frame match its time) is re-read up
 * to pipeline.unverifiedRetries times by restarting the iteration at it, before anyone sees it; after that it is
 * used and recorded in R.unverified for decodePolicy.
 */
async function pass(R, phase, { from, to, stride = 1 }, visit) {
  const c = R.counts[phase] ??= { passes: 0, frames: 0, fed: 0, crops: 0, cropPx: 0 };
  const retries = R.params.pipeline.unverifiedRetries, tries = new Map();
  let expect = from, out, again = true;
  while (again) {
    again = false;
    c.passes++;
    const it = await fromSource('frames()', () => R.source.frames({ from: expect, to, stride, signal: R.signal })[Symbol.asyncIterator]());
    try {
      for (;;) {
        throwIfAborted(R.signal);
        const step = await fromSource('frames().next()', () => it.next());
        if (step.done) break;
        const ref = step.value;
        sourceContract('frames()', refErrors(ref, expect, to, R.meta));
        if (ref.verified === false) {
          const n = tries.get(ref.index) ?? 0;
          if (n < retries) { tries.set(ref.index, n + 1); c.retries = (c.retries ?? 0) + 1; again = true; break; }
          if (!R.unverified.has(ref.index)) R.unverified.set(ref.index, phase);
          c.unverified = (c.unverified ?? 0) + 1;
        }
        c.frames++; expect += stride;
        if ((out = await visit(ref)) !== undefined) break;
      }
    } finally {
      try { await it.return?.(); } catch { /* cleanup only: the source closes its last FrameRef here */ }
    }
  }
  return out;
}

async function consumer(R, label, create) {
  const c = await guard(`new ${label}`, create), w = await guard(`${label}.window`, () => c.window());
  contract(`${label}.window`, Number.isInteger(w?.from) && Number.isInteger(w?.to) ? [] : [`expected integer from/to, got ${w?.from}, ${w?.to}`]);
  const n = R.meta.frameCount, from = Math.min(n, Math.max(0, w.from)), to = Math.min(n, Math.max(from, w.to));
  return { c, label, from, to, over: from >= to };
}

/**
 * Feed FrameConsumers (protocol doc §6): for each frame inside a live consumer's window, its roiRequests are
 * cropped from that frame and consume(i, t, crops, simAt(camera, i)) is called, for every index in order, even
 * with no requests. A consumer is never called again once done; the pass ends when every consumer is done or
 * past its window, and restarts across long gaps.
 */
async function drive(R, phase, list) {
  // Scheduling only, never a result change (consumers see exactly their windows either way): a gap longer than
  // pipeline.restartGapSec before the next needed frame restarts the pass (one keyframe pre-roll) instead of decoding
  // through it. Element sources seek every frame, so they always restart.
  const { meta } = R, n = meta.frameCount, gap = meta.path === 'element' ? 0 : Math.ceil(meta.fps * R.params.pipeline.restartGapSec);
  const over = async x => {
    if (x.over) return true;
    const v = await guard(`${x.label}.done`, () => x.c.done);
    contract(`${x.label}.done`, typeof v === 'boolean' ? [] : [`expected a boolean, got ${typeof v}`]);   // a done() method would read as done
    return (x.over = v);
  };
  for (const x of list) await over(x);
  const needed = i => list.reduce((k, x) => x.over || x.to <= i ? k : Math.min(k, Math.max(i, x.from)), Infinity);
  const total = unionLength(list);
  let fed = 0, from = needed(0);
  R.progress(phase, 0, total);
  while (from < n) {
    const to = list.reduce((m, x) => x.over || x.to <= from ? m : Math.max(m, x.to), from + 1);
    const next = await pass(R, phase, { from, to }, async ref => {
      const i = ref.index, active = [];
      for (const x of list) if (i >= x.from && i < x.to && !(await over(x))) active.push(x);
      if (active.length) {
        await feed(R, phase, ref, active);
        for (const x of active) await over(x);
        R.progress(phase, ++fed, total);
      }
      const k = needed(i + 1);
      if (k - i - 1 > gap) return k;   // Infinity: nothing left to feed
    });
    if (next === undefined || next === Infinity) break;
    from = next;
  }
  if (R.counts[phase]) R.counts[phase].fed = fed;
}

async function feed(R, phase, ref, active) {
  const i = ref.index, asks = [], P = R.params.pipeline, area = R.meta.width * R.meta.height;
  let total = 0;
  for (const x of active) {
    const where = `${x.label}.roiRequests(${i})`, q = await guard(where, () => x.c.roiRequests(i));
    contract(where, requestErrors(q, P.maxRequestFrames * area));
    for (const r of q) total += r.rect.w * r.rect.h;
    asks.push(q);
  }
  // Memory bound: one frame's crops, all consumers together (a runaway request fails closed, not out of memory).
  contract(`frame ${i} roiRequests`, total <= P.maxFrameCropFrames * area ? [] : [`${(total / 1e6).toFixed(1)} Mpx requested, more than pipeline.maxFrameCropFrames (${P.maxFrameCropFrames}) frame areas`]);
  const reqs = asks.flat(), where = `frame ${i} lumaRect`;
  const crops = reqs.length ? await fromSource(where, () => Promise.all(reqs.map(q => ref.lumaRect(q.rect, { pool: q.pool })))) : [];
  sourceContract(where, cropErrors(crops, reqs));
  const c = R.counts[phase];
  c.crops += reqs.length;
  for (const q of reqs) c.cropPx += q.rect.w * q.rect.h;
  for (let j = 0, o = 0; j < active.length; j++) {
    const x = active[j], mine = crops.slice(o, o += asks[j].length);
    await guard(`${x.label}.consume(${i})`, () => x.c.consume(i, ref.t, mine, simAt(R.log.camera, i)));
  }
}

function unionLength(list) {
  const w = list.filter(x => !x.over).map(x => [x.from, x.to]).sort((a, b) => a[0] - b[0]);
  let n = 0, end = -Infinity;
  for (const [a, b] of w) if (b > end) { n += b - Math.max(a, end); end = b; }
  return n;
}

/* ------------------------------------------------------------------ contract checks */

function listErrors(type, list, path, idOf) {
  if (!Array.isArray(list)) return [`${path}: expected an array of ${type}`];
  const errs = list.flatMap((v, i) => check(type, v, `${path}[${i}]`));
  if (idOf && !errs.length && new Set(list.map(idOf)).size !== list.length) errs.push(`${path}: duplicate ids`);
  return errs;
}
function imageErrors(img, meta, pool) {
  const errs = check('LumaImage', img, 'image');
  if (!errs.length && !(img.pool === pool && img.w === Math.floor(meta.width / pool) && img.h === Math.floor(meta.height / pool))) {
    errs.push(`image ${img.w}×${img.h} pool ${img.pool}, expected pool ${pool} of ${meta.width}×${meta.height}`);
  }
  return errs;
}
function refErrors(ref, expect, to, meta) {
  const errs = check('FrameRef', ref, 'ref');
  if (errs.length) return errs;
  if (ref.index !== expect || ref.index >= to) return [`yielded frame ${ref.index}, expected ${expect < to ? expect : 'the end'}`];
  if (ref.t !== meta.times[ref.index]) return [`frame ${ref.index}: t ${ref.t} != meta.times[${ref.index}] ${meta.times[ref.index]}`];
  return [];
}
function requestErrors(q, maxArea = Infinity) {
  if (!Array.isArray(q)) return ['expected an array of RoiRequest'];
  return q.flatMap((r, j) => {
    const e = check('RoiRequest', r, `request[${j}]`);
    if (e.length) return e;
    if (!(r.rect.w >= r.pool && r.rect.h >= r.pool)) return [`request[${j}]: ${r.rect.w}×${r.rect.h} rect is smaller than pool ${r.pool}`];
    return r.rect.w * r.rect.h <= maxArea ? [] : [`request[${j}]: ${r.rect.w}×${r.rect.h} rect is larger than pipeline.maxRequestFrames frame areas`];
  });
}
function cropErrors(crops, reqs) {
  if (!Array.isArray(crops) || crops.length !== reqs.length) return ['expected one crop per request'];
  return crops.flatMap((k, j) => {
    const e = check('LumaCrop', k, `crop[${j}]`), q = reqs[j];
    if (e.length) return e;
    return k.x0 === q.rect.x && k.y0 === q.rect.y && k.pool === q.pool && k.w === Math.floor(q.rect.w / q.pool) && k.h === Math.floor(q.rect.h / q.pool)
      ? [] : [`crop[${j}] does not match its request`];
  });
}
function selectionErrors(R, dec, obs) {
  const sel = dec.selected, errs = [];
  if (!sel.launch || !R.candidates.some(c => c.launch.id === sel.launch.id)) errs.push(`${dec.status} must select a tracked launch`);
  else if (!sel.track || sel.track.launchId !== sel.launch.id) errs.push(`${dec.status} needs the selected launch's track`);
  if (!obs.length) errs.push(`${dec.status} needs inlier observations`);
  if (dec.allowCompletion && !(sel.fit && sel.completion)) errs.push('allowCompletion needs a fit and a completion');
  return errs;
}

/* ------------------------------------------------------------------ result */

/** The accepted decisions to track: all of them, or the `max` with the largest null margin, in impact order. */
function strongest(accepted, max) {
  if (accepted.length <= max) return accepted;
  const keep = new Set([...accepted].sort((a, b) => b.margin - a.margin).slice(0, max));
  return accepted.filter(d => keep.has(d));
}
const inliers = track => track.observations.filter(o => o.flag === 'inlier');
/** Same observations in order, in every field fitFlight reads (t, x, y, sigma, cov, d, flag): a refit would see the same data. */
function sameObservations(a, b) {
  const p = a.observations, q = b.observations;
  const sameCov = (u, v) => u === v || (!!u && !!v && u.length === v.length && u.every((x, k) => x === v[k]));
  return p.length === q.length && p.every((o, i) => o.index === q[i].index && o.t === q[i].t && o.x === q[i].x && o.y === q[i].y &&
    o.sigma === q[i].sigma && o.flag === q[i].flag && (o.d ?? null) === (q[i].d ?? null) && sameCov(o.cov, q[i].cov));
}
/** Observations the final robust fit left out become 'rejected': never drawn, listed in diagnostics. */
function flagOutliers(track, fit) {
  let changed = false;
  const observations = track.observations.map((o, i) => o.flag === 'inlier' && !fit.inlier[i] ? (changed = true, { ...o, flag: 'rejected' }) : o);
  return changed ? { ...track, observations } : track;
}
const codes = (R, list) => [...new Set([...list, ...(R.meta?.path === 'element' ? ['slow_decode_path'] : [])])];
const copyConfidence = c => ({ value: c.value, calibratedOn: c.calibratedOn, components: { ...c.components } });
function abstain(R, reasons, confidence) {
  return makeAbstention(codes(R, reasons), { camera: R.log ? cameraSamples(R.log.camera, R.meta) : [], confidence: confidence && copyConfidence(confidence) });
}

function assemble(R, dec, sel, obs, completion, curve) {
  const { meta } = R, W = meta.width, H = meta.height, diag = Math.hypot(W, H), L = sel.launch, fit = sel.fit;
  const point = p => { const q = { t: p.t, x: p.x / W, y: p.y / H, status: p.status }; if (p.alpha < 1) q.alpha = p.alpha; return q; };
  const ob = o => ({ t: o.t, x: o.x / W, y: o.y / H, sigma: o.sigma / diag });
  R.rejected = sel.track.observations.filter(o => o.flag === 'rejected').map(ob);
  return {
    points: curve.map(point),
    observations: obs.map(ob),
    camera: cameraSamples(R.log.camera, meta),
    engine: RESULT_ENGINE,
    observedFrames: obs.length,
    status: dec.status,
    reasonCodes: codes(R, dec.reasonCodes),
    confidence: copyConfidence(dec.confidence),
    launch: { t: L.t0, x: L.address.x / W, y: L.address.y / H, dir: { x: L.dir.x, y: L.dir.y }, view: fit && fit.view !== 'unknown' ? fit.view : L.view },
    completion: completion && {
      end: { type: completion.end.type, t: completion.end.t, x: completion.end.x / W, y: completion.end.y / H },
      observedEnd: completion.observedEnd, observedSec: completion.observedSec, predictedSec: completion.predictedSec,
      slowMoFactor: completion.slowMoFactor
    }
  };
}

/** Attach diagnostics, validate, fall back to an internal_error abstention, report 'done'. */
function finish(R, result, errors = []) {
  throwIfAborted(R.signal);
  R.ms.total = now() - R.start;
  result = decodePolicy(R, result);
  result.diagnostics = diagnosticsOf(R, errors);
  const v = validateResult(result, R.meta ? { width: R.meta.width, height: R.meta.height, fps: R.meta.fps } : {});
  if (!v.ok) {
    result = makeAbstention(codes(R, ['internal_error']));
    result.diagnostics = { paramsVersion: PARAMS_VERSION, errors: [...errors, ...v.errors.slice(0, 20).map(m => `validateResult: ${m}`)] };
  }
  R.progress('done', 1, 1, result.status);
  return result;
}

/**
 * Frames still unverified after their retries (R.unverified). Outside the windows below they only mark the result
 * slow_decode_path. Inside one, the frame may show another moment than its time says, so nothing is drawn: the
 * result abstains with decoder_limited (an abstention adds it to its own codes). Windows: the launch window is the
 * confirmer window of the drawn launch (of every hypothesis, for an abstention); the flight window runs from
 * frameAt(t0 − pipeline.flightPreSec) to the last drawn observation.
 */
function decodePolicy(R, result) {
  if (!R.unverified.size || result.reasonCodes.some(c => c === 'internal_error' || c === 'engine_not_ready')) return result;
  const T = R.meta.times, bad = [...R.unverified.keys()], hit = (a, b) => bad.some(k => k >= a && k < b);
  const inLaunch = id => { const w = R.windows.get(id); return !!w && hit(w.from, w.to); };
  const drawn = result.status !== 'no_reliable_track';
  const affected = drawn
    ? inLaunch(R.decision.selected.impact.id) || hit(Math.max(0, frameAt(T, result.launch.t - R.params.pipeline.flightPreSec)), frameAt(T, result.observations.at(-1).t) + 1)
    : R.impacts.some(h => inLaunch(h.id));
  if (!affected) return { ...result, reasonCodes: [...new Set([...result.reasonCodes, 'slow_decode_path'])] };
  if (drawn) R.replaced = { status: result.status, reasonCodes: [...result.reasonCodes], observedFrames: result.observedFrames };
  return abstain(R, [...(drawn ? [] : result.reasonCodes.filter(c => c !== 'slow_decode_path')), 'decoder_limited', 'slow_decode_path'], R.decision?.confidence ?? result.confidence);
}

function diagnosticsOf(R, errors) {
  const d = {
    paramsVersion: PARAMS_VERSION, path: R.meta?.path ?? null,
    ms: Object.fromEntries(Object.entries(R.ms).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    counts: Object.fromEntries(Object.entries(R.counts).map(([k, v]) => [k, { ...v }]))
  };
  if (errors.length) d.errors = errors.slice(0, 20);
  if (R.rejected) d.rejected = R.rejected;
  if (R.unverified.size) d.unverified = [...R.unverified].slice(0, 50).map(([index, phase]) => ({ index, t: R.meta.times[index], phase }));
  if (R.replaced) d.decoderLimited = R.replaced;
  if (R.detail && R.meta) try { Object.assign(d, detail(R)); } catch (e) { d.detailError = msg(e); }
  return d;
}

/** Per-impact, per-launch and per-candidate detail (diagnostics: true); normalized like the result, no functions. */
function detail(R) {
  const W = R.meta.width, H = R.meta.height, diag = Math.hypot(W, H);
  const ob = o => ({ index: o.index, t: o.t, x: o.x / W, y: o.y / H, sigma: o.sigma / diag, z: o.z, src: o.src, flag: o.flag });
  const d = R.decision;
  return {
    impacts: R.impacts.map(h => ({
      id: h.id, spotId: h.spotId, x: h.address.x / W, y: h.address.y / H, d0: h.d0, kLast: h.kLast, kFirstAbsent: h.kFirstAbsent,
      t0Est: h.t0Est, scores: { ...h.scores }
    })),
    launches: R.decisions.map(x => ({
      hypId: x.hypId, accepted: x.accepted, reason: x.reason, S: x.S, Snull: Array.from(x.Snull), margin: x.margin, llr: x.llr,
      ...(x.candidate && { id: x.candidate.id, t0: x.candidate.t0, view: x.candidate.view, samples: x.candidate.samples.length, single: x.candidate.single, streak: x.candidate.streak })
    })),
    candidates: R.candidates.map(c => ({
      launchId: c.launch.id, features: { ...c.features },
      track: c.track && { id: c.track.id, state: c.track.state, observedEnd: c.track.observedEnd, llr: c.track.llr, observations: c.track.observations.map(ob) },
      fit: c.fit && {
        kind: c.fit.kind, tau: c.fit.tau, view: c.fit.view, rmsNorm: c.fit.rmsNorm, inlierFrac: c.fit.inlierFrac, priorZMax: c.fit.priorZMax,
        converged: c.fit.converged, ill: c.fit.ill, landingT: c.fit.landingT
      },
      completion: c.completion && {
        type: c.completion.end.type, t: c.completion.end.t, x: c.completion.end.x / W, y: c.completion.end.y / H,
        observedEnd: c.completion.observedEnd, uncertain: c.completion.uncertain, ramp: c.completion.ramp
      }
    })),
    decision: d && {
      status: d.status, reasonCodes: [...d.reasonCodes], rules: { ...d.rules }, allowCompletion: d.allowCompletion,
      confidence: copyConfidence(d.confidence), selected: d.selected?.launch?.id ?? null
    }
  };
}

/* ------------------------------------------------------------------ helpers */

/** Progress at most every `every` ms within a phase; a new phase (so also 'done') is always reported. */
function reporter(onProgress, every) {
  if (typeof onProgress !== 'function') return () => {};
  let phase = null, last = -Infinity;
  return (p, done, total, message) => {
    const t = now();
    if (p === phase && t - last < every) return;
    phase = p; last = t;
    const ev = makeProgress(p, Math.min(done, total), total, message);
    try { onProgress(ev); } catch (e) { throw passOn(e); }
  };
}
async function timed(R, phase, fn) {
  const t = now();
  try { return await fn(); } finally { R.ms[phase] = (R.ms[phase] ?? 0) + now() - t; }
}
