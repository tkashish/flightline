/**
 * Test fixtures for the hf pipeline (U9): an instrumented FrameSource, a synthetic ball scene rendered at the
 * pixel level, and mock collaborators (HFModules) that measure the ball in the frames and crops the pipeline
 * hands them and return contract-valid outputs. No real unit module is imported.
 */
import {
  HFError, applySim, coarsePool, cropLuma, curveStatus, frameAt, invertSim, make, makeCompletion, makeConfidence,
  makeDecision, makeFlightFit, makeImpact, makeLaunchCandidate, makeLaunchDecision, makeObservation, makeSourceMeta,
  makeTrackHypothesis, poolLuma, simAt, throwIfAborted, timingFromTimes
} from '../../../dist/hf/types.js';

const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * FrameSource over plane(k) (fresh full-resolution luma per request) that records every iteration, live and
 * closed FrameRefs, use after close, and WeakRefs to every FrameRef and plane (for GC retention checks).
 * macrotask: yield a macrotask before every frame (lets WeakRefs clear mid-run). fail(k, iteration): throw
 * HFError 'decode' there. skipAt: silently skip that index (a broken source). tOffsetAt: corrupt ref.t there.
 * badCropAt / badCoarseAt: at that index lumaRect answers for a rect 1 px to the right / lumaCoarse pools wrongly.
 * ignoreSignal: never look at the AbortSignal (a lax source). verified(k, iteration): the FrameRef's `verified`
 * flag (true | false | null, as the element path sets it; undefined leaves it off). stats.reads[k] counts reads.
 */
export function instrumentedSource({ width, height, plane, frameCount, fps = 30, times, path = 'memory', macrotask = false, fail = () => false, skipAt = -1, tOffsetAt = -1, badCropAt = -1, badCoarseAt = -1, ignoreSignal = false, verified, log } = {}) {
  const T = times ? Float64Array.from(times) : Float64Array.from({ length: frameCount }, (_, k) => k / fps);
  const timing = timingFromTimes(T, fps), n = T.length;
  const meta = makeSourceMeta({ width, height, fps: timing.fps, vfr: timing.vfr, frameCount: n, times: T, duration: timing.duration, path });
  const stats = { iterations: [], live: 0, maxLive: 0, opened: 0, closed: 0, afterClose: 0, refs: [], planes: [], lumaRect: 0, lumaCoarse: 0, reads: {} };
  let busy = false, closed = false;
  const frameRef = index => {
    const data = plane(index);
    let open = true;
    const live = () => { if (!open) { stats.afterClose++; throw new HFError('closed', `frame ${index} is closed`); } };
    const ref = {
      index, t: index === tOffsetAt ? T[index] + 1e-3 : T[index],
      async lumaCoarse(longEdge, out) { live(); stats.lumaCoarse++; return poolLuma(data, width, height, coarsePool(width, height, longEdge) + (index === badCoarseAt), index === badCoarseAt ? undefined : out); },
      async lumaRect(rect, { pool = 1, out } = {}) { live(); stats.lumaRect++; return cropLuma(data, width, height, index === badCropAt ? { ...rect, x: rect.x + 1 } : rect, pool, out); },
      close() { if (open) { open = false; stats.live--; stats.closed++; } }
    };
    const v = verified?.(index, stats.iterations.length - 1);
    if (v !== undefined) ref.verified = v;
    stats.reads[index] = (stats.reads[index] ?? 0) + 1;
    stats.live++; stats.opened++; stats.maxLive = Math.max(stats.maxLive, stats.live);
    stats.refs.push(new WeakRef(ref)); stats.planes.push(new WeakRef(data));
    return ref;
  };
  async function* frames({ from = 0, to = n, stride = 1, signal } = {}) {
    if (closed) throw new HFError('closed', 'source is closed');
    if (busy) throw new HFError('busy', 'another frames() iteration is live');
    busy = true;
    const it = { from, to, stride, yielded: [] };
    stats.iterations.push(it);
    log?.push(`frames ${from} ${to} ${stride}`);
    let ref = null;
    try {
      for (let k = clampI(from, 0, n), end = clampI(to, 0, n); k < end; k += stride) {
        if (macrotask) await new Promise(r => setImmediate(r));
        if (!ignoreSignal) throwIfAborted(signal);
        ref?.close();
        ref = null;
        if (fail(k, stats.iterations.length - 1)) throw new HFError('decode', `synthetic decoder failure at frame ${k}`);
        if (k === skipAt) continue;
        ref = frameRef(k);
        it.yielded.push(k);
        yield ref;
      }
    } finally {
      ref?.close();
      busy = false;
    }
  }
  return { meta, frames, async close() { closed = true; }, stats, get busy() { return busy; } };
}

/** Pixels (i, j) whose centre lies within r of (cx, cy) get value v. */
export function disc(img, w, h, cx, cy, r, v) {
  for (let j = Math.max(0, Math.floor(cy - r)); j <= Math.min(h - 1, Math.ceil(cy + r)); j++) {
    for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(w - 1, Math.ceil(cx + r)); i++) {
      if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= r * r) img[j * w + i] = v;
    }
  }
}

/** Centroid of pixels brighter than thresh in an image pooled by `pool` with corner (x0, y0): native px. */
export function centroid(data, w, h, x0 = 0, y0 = 0, pool = 1, thresh = 150) {
  let sx = 0, sy = 0, n = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (data[j * w + i] > thresh) { sx += i + 0.5; sy += j + 0.5; n++; }
  return n ? { x: x0 + pool * sx / n, y: y0 + pool * sy / n, n } : null;
}

/**
 * Synthetic scene: a gradient background and one or more balls. Ball b sits at its address until its impact
 * frame, then flies p(u) = address + v·u + a·u²/2 (stabilized px, u = t − t0 in video s). shift(k) moves the
 * whole frame (raw = stab + shift(k), integer px, shift(0) = 0) like camera shake. Balls are not drawn from
 * frame hideFrom on (invisible-ball control). texture > 0 adds static blocky noise of that amplitude (levels)
 * fixed to the scene, so real camera-motion estimators have something to lock on.
 */
export function ballScene({
  width = 270, height = 480, fps = 30, n = 60, times, d = 6, shift = () => ({ x: 0, y: 0 }), hideFrom = Infinity, texture = 0,
  balls = [{ address: { x: 135, y: 400 }, impactFrame: 30.4, vel: { x: 60, y: -600 }, acc: { x: 0, y: 800 } }]
} = {}) {
  const T = times ? Float64Array.from(times) : Float64Array.from({ length: n }, (_, k) => k / fps);
  const B = balls.map(b => ({ ...b, t0: b.impactFrame / fps, kLast: Math.floor(b.impactFrame) }));
  const posAt = (t, b = 0) => {
    const ball = B[b], u = Math.max(0, t - ball.t0);
    return { x: ball.address.x + ball.vel.x * u + 0.5 * ball.acc.x * u * u, y: ball.address.y + ball.vel.y * u + 0.5 * ball.acc.y * u * u };
  };
  const texAt = (x, y) => { const h = Math.imul(((x >> 2) & 4095) * 73856093 ^ ((y >> 2) & 4095) * 19349663, 2654435761) >>> 0; return (h % (2 * texture + 1)) - texture; };
  const plane = k => {
    const img = new Uint8Array(width * height), s = shift(k);
    for (let j = 0; j < height; j++) img.fill(50 + ((j * 40 / height) | 0), j * width, (j + 1) * width);
    if (texture) for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) img[j * width + i] += texAt(i - s.x, j - s.y);
    B.forEach((ball, b) => {
      if (k >= hideFrom) return;
      const p = posAt(T[k], b);
      disc(img, width, height, p.x + s.x, p.y + s.y, d / 2, 230);
    });
    return img;
  };
  return { width, height, fps, n: T.length, times: T, d, shift, balls: B, posAt, plane, t0: B[0].t0, kLast: B[0].kLast, address: B[0].address };
}

/** An ImpactHypothesis for ball b of the scene (vacate between kLast and kLast + 1). */
export function sceneImpact(scene, b = 0, { id = `I${b}`, t0Est } = {}) {
  const ball = scene.balls[b], T = scene.times, kLast = ball.kLast, kFirst = kLast + 1, fps = scene.fps;
  return makeImpact({
    id, spotId: `S${b}`, address: { ...ball.address }, d0: scene.d, polarity: 1, kLast, tLast: T[kLast], kFirstAbsent: kFirst,
    tFirstAbsent: T[kFirst], interval: { t0: T[kLast] - 0.25 / fps, t1: T[kFirst] + 0.25 / fps }, t0Est: t0Est ?? (T[kLast] + T[kFirst]) / 2
  });
}

/** Dense display curve (protocol doc §8) for mocks: observed samples sit on the observations. */
export function curveFor(fit, obs, completion, { meta, launch, params }) {
  const hz = params.display.hz, half = params.display.observedHalfFrame / meta.fps, t0 = launch.t0, ot = obs.map(o => o.t);
  const end = completion ? completion.end.t : ot.at(-1), times = [...ot];
  for (let t = t0 + 1 / hz; t < end - 1e-9; t += 1 / hz) if (ot.every(x => Math.abs(x - t) > 1e-4)) times.push(t);
  if (completion) times.push(end);
  times.sort((a, b) => a - b);
  const knots = [{ t: t0, x: launch.address.x, y: launch.address.y }, ...obs];
  const at = t => {
    if (t > ot.at(-1)) return fit.predict(t);
    let j = 1;
    while (knots[j].t < t) j++;
    if (knots[j].t === t) return knots[j];
    const a = knots[j - 1], b = knots[j], u = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
  const fade = completion?.fade, pts = [{ t: t0, x: launch.address.x, y: launch.address.y, status: 'anchor', alpha: 1 }];
  for (const t of times) {
    if (t - pts.at(-1).t <= 1e-9) continue;
    const p = at(t), alpha = fade && t > fade.from ? Math.max(0, Math.min(1, (fade.to - t) / (fade.to - fade.from))) : 1;
    pts.push({ t, x: p.x, y: p.y, status: curveStatus(t, ot, half), alpha });
  }
  return pts;
}

const ALL = { R1: true, R2: true, R3: true, R4: true, R5: true };
const nIn = c => (c.track ? c.track.observations.filter(o => o.flag === 'inlier').length : 0);

/** R-rule stand-in: most inliers wins; tracked with >= r2MinObs and a completion, partial (b) with any, else abstain. */
export function defaultDecide(cands, ctx) {
  const best = [...cands].sort((a, b) => nIn(b) - nIn(a))[0], need = ctx.params.decide.r2MinObs;
  if (best && nIn(best) >= need && best.completion) {
    const many = cands.filter(c => nIn(c) >= need).length > 1;
    return makeDecision({ status: 'tracked', reasonCodes: many ? ['multiple_shots'] : [], selected: best, allowCompletion: true, rules: ALL, confidence: makeConfidence(0.92, { nullMargin: best.launch.margin }) });
  }
  if (best && nIn(best)) return makeDecision({ status: 'partial', reasonCodes: ['tracking_ended_early'], selected: best, allowCompletion: false, rules: { ...ALL, R2: false, R5: false }, confidence: makeConfidence(0.7) });
  return makeDecision({ status: 'no_reliable_track', reasonCodes: ['insufficient_visible_frames'], selected: null, allowCompletion: false, rules: { ...ALL, R2: false, R5: false }, confidence: makeConfidence(0.1) });
}
export const decision = (status, reasonCodes, selected, { allowCompletion = false, value = 0.5, rules } = {}) =>
  makeDecision({ status, reasonCodes, selected, allowCompletion, rules: rules ?? (allowCompletion ? ALL : { ...ALL, R2: false, R5: false }), confidence: makeConfidence(value) });

/**
 * Mock HFModules for a scene. Every call is appended to `calls` (strings) in order; `state` keeps the
 * instances and arguments. Options (all optional):
 *   impacts(log, meta)       ImpactHypothesis[] (default: found from the coarse frames, single ball)
 *   verdict(h)               'accept' or an abstain code for LaunchConfirmer.finish
 *   margin(h)                null margin of an accepted launch
 *   launchDoneAfter          a confirmer reports done after this many post-impact sightings
 *   launchRoi                half-size of the confirmers' address crop (px, default 48)
 *   trackUntil               trackers report done after consuming this index (number or tracker => number)
 *   ballOf(launch)           which scene ball a tracker follows (default: from the impact id 'I<b>')
 *   miss                     frame indices the trackers do not observe
 *   flagAs                   {index: flag} for tracker observations that are not inliers ('ambiguous', ...)
 *   recover                  frame indices reassociate adds (src 'viterbi'); a function (round => indices) adds per round
 *   reassocEdit(round, obs)  edits reassociate's output observations (relabel or move points), returns the new list
 *   outliers                 frame indices fitFlight marks as outliers
 *   endType, predictSec, tau, fitView   completion / fit shape
 *   decide(cands, ctx)       replaces defaultDecide
 *   curve(fit, obs, completion, ctx)  replaces curveFor
 *   hook(event, ...args)     called at each mock event (abort tests)
 */
export function mockModules(scene, o = {}) {
  const calls = [], state = { scanner: null, confirmers: [], trackers: [], fits: [], reassoc: [], completes: [], decide: null, curve: null, impactsArgs: null };
  const hook = (...a) => o.hook?.(...a);
  const ballOf = L => o.ballOf?.(L) ?? Math.max(0, +(L.hypId.match(/\d+$/)?.[0] ?? 0)) % scene.balls.length;

  class CoarseScanner {
    constructor(meta, { params } = {}) { calls.push('scan.new'); Object.assign(this, { meta, params, idx: [], t: [], blobs: [] }); state.scanner = this; }
    push(index, t, img) {
      calls.push(`scan.push ${index}`);
      hook('scan.push', index, img);
      const c = centroid(img.data, img.w, img.h, 0, 0, img.pool), s = scene.shift(index);
      this.idx.push(index); this.t.push(t); this.blobs.push(c && { x: c.x - s.x, y: c.y - s.y });
      Object.assign(this, { pool: img.pool, w: img.w, h: img.h });
    }
    finish() {
      calls.push('scan.finish');
      const n = this.idx.length, index = Int32Array.from(this.idx), t = Float64Array.from(this.t), sim = new Float64Array(4 * n);
      for (let k = 0; k < n; k++) { const s = scene.shift(this.idx[k]); sim[4 * k] = 1; sim[4 * k + 2] = s.x; sim[4 * k + 3] = s.y; }
      return make('CoarseLog', {
        pool: this.pool, w: this.w, h: this.h, stride: n > 1 ? this.idx[1] - this.idx[0] : 1, frames: { index, t },
        camera: { index, t, sim, inlier: new Float32Array(n).fill(1) }, spots: [], vacates: [],
        energy: { cellPx: 4, disk: () => ({ index: new Int32Array(0), e: new Float32Array(0) }), active: () => 0 },
        horizon: null, movers: [], specks: []
      });
    }
  }

  function findImpacts(log, meta, opts = {}) {
    calls.push('findImpacts');
    state.impactsArgs = { log, meta, opts };
    hook('findImpacts');
    if (o.impacts) return o.impacts(log, meta);
    const sc = state.scanner, b0 = sc.blobs[0];   // pixel level: where the bright blob sat, and when it left
    if (!b0) return [];
    let j = 0;
    while (j + 1 < sc.idx.length && sc.blobs[j + 1] && Math.hypot(sc.blobs[j + 1].x - b0.x, sc.blobs[j + 1].y - b0.y) < 1) j++;
    if (j + 1 >= sc.idx.length) return [];
    const T = meta.times, kLast = sc.idx[j], kFirst = sc.idx[j + 1], fps = meta.fps;
    return [makeImpact({
      id: 'I0', spotId: 'S0', address: { x: b0.x, y: b0.y }, d0: scene.d, polarity: 1, kLast, tLast: T[kLast], kFirstAbsent: kFirst,
      tFirstAbsent: T[kFirst], interval: { t0: T[kLast] - 0.25 / fps, t1: T[kFirst] + 0.25 / fps }, t0Est: (T[kLast] + T[kFirst]) / 2
    })];
  }

  class LaunchConfirmer {
    constructor(h, ctx) { calls.push(`launch.new ${h.id}`); Object.assign(this, { h, ctx, seen: [], found: [], over: false }); state.confirmers.push(this); }
    window() {
      const T = this.ctx.meta.times, P = this.ctx.params.launch.window;
      return { from: frameAt(T, this.h.t0Est - P.preSec), to: frameAt(T, this.h.t0Est + P.postSec) + 1 };
    }
    get done() { return this.over; }
    roiRequests(i) {
      const c = applySim(simAt(this.ctx.log.camera, i), this.h.address.x, this.h.address.y), r = o.launchRoi ?? 48;
      return [{ rect: { x: Math.round(c.x) - r, y: Math.round(c.y) - r, w: 2 * r, h: 2 * r }, pool: 1, purpose: 'address' }];
    }
    consume(i, t, crops, sim) {
      calls.push(`launch.consume ${this.h.id} ${i}`);
      this.seen.push({ i, t, crops, sim });
      hook('launch.consume', this, i);
      const k = crops[0], c = k && centroid(k.data, k.w, k.h, k.x0, k.y0, k.pool);
      if (c && i > this.h.kLast) this.found.push({ i, t, ...applySim(invertSim(sim), c.x, c.y) });
      if (o.launchDoneAfter && this.found.length >= o.launchDoneAfter) this.over = true;
    }
    finish() {
      calls.push(`launch.finish ${this.h.id}`);
      const verdict = o.verdict?.(this.h) ?? 'accept', fps = this.ctx.meta.fps;
      const samples = this.found.slice(0, 3).map(f => makeObservation({ index: f.i, t: f.t, x: f.x, y: f.y, sigma: 0.5, z: 9, polarity: 1, src: 'launch' }));
      const reason = verdict !== 'accept' ? verdict : samples.length < 2 ? 'ball_not_found_after_impact' : null;
      if (reason) return makeLaunchDecision({ hypId: this.h.id, accepted: false, reason, S: 2, Snull: [3], margin: 2 - (1.15 * 3 + 1) });
      const a = this.h.address, last = samples.at(-1), dx = last.x - a.x, dy = last.y - a.y, len = Math.hypot(dx, dy);
      const margin = o.margin?.(this.h) ?? 6.4, S = margin + 1.15 * 4 + 1;
      return makeLaunchDecision({
        hypId: this.h.id, accepted: true, S, Snull: [4], margin,
        candidate: makeLaunchCandidate({
          id: `L${this.h.id}`, hypId: this.h.id, t0: this.h.t0Est, address: { ...a }, d0: this.h.d0, dir: { x: dx / len, y: dy / len },
          v: len / ((last.t - this.h.t0Est) * fps), c: 0, polarity: 1, samples, S, margin, view: 'dtl'
        })
      });
    }
  }

  class RoiTube { constructor() { calls.push('RoiTube.new'); } }

  class FlightTracker {
    constructor(L, ctx, deps) { calls.push(`track.new ${L.id}`); Object.assign(this, { L, ctx, deps, b: ballOf(L), obs: [], seen: [], over: false }); state.trackers.push(this); }
    window() { return { from: frameAt(this.ctx.meta.times, this.L.t0 - this.ctx.params.pipeline.flightPreSec), to: this.ctx.meta.frameCount }; }
    get done() { return this.over; }
    roiRequests(i) {
      const t = this.ctx.meta.times[i];
      if (t <= this.L.t0) return [];
      const p = scene.posAt(t, this.b), c = applySim(simAt(this.ctx.log.camera, i), p.x, p.y), r = 16, x = Math.round(c.x) - r, y = Math.round(c.y) - r;
      return [
        { rect: { x, y, w: 2 * r, h: 2 * r }, pool: 1, purpose: 'main' },
        { rect: { x: x - 4 * r, y, w: 2 * r, h: 2 * r }, pool: 1, purpose: 'decoy' },
        { rect: { x: x + 4 * r, y, w: 2 * r, h: 2 * r }, pool: 2, purpose: 'decoy' }
      ];
    }
    consume(i, t, crops, sim) {
      calls.push(`track.consume ${this.L.id} ${i}`);
      this.seen.push({ i, t, crops, sim });
      hook('track.consume', this, i);
      const k = crops[0], c = k && centroid(k.data, k.w, k.h, k.x0, k.y0, k.pool);
      if (c && !(o.miss ?? []).includes(i)) {
        const p = applySim(invertSim(sim), c.x, c.y);
        this.obs.push(makeObservation({ index: i, t, x: p.x, y: p.y, sigma: 0.5, z: 8, polarity: 1, src: 'tbd', flag: o.flagAs?.[i] ?? 'inlier' }));
      }
      const q = scene.posAt(t, this.b);
      const until = typeof o.trackUntil === 'function' ? o.trackUntil(this) : o.trackUntil ?? Infinity;
      if (i >= until || q.y < 0 || q.y > scene.height || q.x < 0 || q.x > scene.width) this.over = true;
    }
    finish() {
      calls.push(`track.finish ${this.L.id}`);
      const best = makeTrackHypothesis({ id: `${this.L.id}/0`, launchId: this.L.id, observations: this.obs, state: 'lost', observedEnd: 'lost' });
      return o.branches ? [best, ...o.branches(this)] : [best];
    }
  }

  function reassociate(hyp, fit, ctx, deps) {
    calls.push(`reassociate ${hyp.id}`);
    state.reassoc.push({ hyp, fit, ctx, deps });
    hook('reassociate');
    const b = state.trackers.find(t => t.L.id === hyp.launchId)?.b ?? 0, round = state.reassoc.length - 1;
    const add = (typeof o.recover === 'function' ? o.recover(round) : o.recover ?? []).filter(i => !hyp.observations.some(x => x.index === i)).map(i => {
      const t = ctx.meta.times[i], p = scene.posAt(t, b);
      return makeObservation({ index: i, t, x: p.x, y: p.y, sigma: 0.7, z: 4, polarity: 1, src: 'viterbi' });
    });
    const out = [...hyp.observations, ...add].sort((a, c) => a.t - c.t);
    return makeTrackHypothesis({ ...hyp, observations: o.reassocEdit ? o.reassocEdit(round, out) : out });
  }

  function fitFlight(obs, ctx, opts = {}) {
    calls.push(`fit ${obs.length} ${opts.warm ? 'warm' : 'cold'}`);
    hook('fit', opts);
    const b = state.trackers.find(t => t.L.id === ctx.launch.id)?.b ?? 0;
    const inlier = Uint8Array.from(obs, x => (x.flag === 'inlier' && !(o.outliers ?? []).includes(x.index) ? 1 : 0));
    const fit = makeFlightFit({
      kind: 'm3d', params: [1, 2], names: ['a', 'b'], cov: null, tau: o.tau ?? 1, view: o.fitView ?? 'dtl', rmsNorm: 0.8, inlier,
      inlierFrac: obs.length ? inlier.reduce((s, v) => s + v, 0) / obs.length : 0, priorZMax: 0.5, converged: true, ill: false, landingT: null,
      predict: t => ({ t, ...scene.posAt(t, b), cov: [1, 0, 1], d: scene.d, h: 1 }), sample: () => []
    });
    state.fits.push({ obs, ctx, opts, fit });
    return fit;
  }

  function completeFlight(fit, obs, ctx) {
    calls.push(`complete ${obs.length}`);
    state.completes.push({ fit, obs, ctx });
    const t0 = ctx.launch.t0, last = obs.at(-1).t, tau = fit.tau, end = last + (o.predictSec ?? 0.5) * tau, p = fit.predict(end), type = o.endType ?? 'landing';
    return makeCompletion({
      end: { type, t: end, x: p.x, y: p.y }, observedEnd: ctx.observedEnd, tLastObs: last, observedSec: (last - t0) / tau,
      predictedSec: (end - last) / tau, slowMoFactor: tau, fade: type === 'fade' ? { from: last + 0.2 * tau, to: end } : { from: end - 0.25 * tau, to: end },
      uncertain: type === 'fade'
    });
  }

  function displayCurve(fit, obs, completion, ctx) {
    calls.push(`curve ${obs.length} ${completion ? 'completion' : 'observed-only'}`);
    state.curve = { fit, obs, completion, ctx };
    hook('curve');
    return (o.curve ?? curveFor)(fit, obs, completion, ctx);
  }

  function decide(cands, ctx) {
    calls.push(`decide ${cands.length}`);
    state.decide = { cands, ctx };
    hook('decide');
    return (o.decide ?? defaultDecide)(cands, ctx);
  }

  const modules = { CoarseScanner, findImpacts, LaunchConfirmer, RoiTube, FlightTracker, reassociate, fitFlight, completeFlight, displayCurve, decide };
  return { modules, calls, state };
}
