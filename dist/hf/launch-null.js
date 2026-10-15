/**
 * Launch confirmation and null launches (U3; FINAL "Launch and club rejection"). LaunchConfirmer is the
 * FrameConsumer the pipeline drives over the native launch window: it requests one processing-grid crop per
 * needed frame (pool = max(1, round(d0 / launch.roiD0Px))), streams ball evidence (reference residual, two-scale
 * box-DoG, local CFAR, address hole), club evidence (|Y − B| DoG), the pre-impact swing envelope and ray-transform
 * segments, and keeps only peaks, pooled z maps and segments. finish() runs the identical search for the real
 * launch and for the nulls (fake anchors at ±0.22·W, fake impacts 12 and 20 frames earlier) and accepts only
 * S >= 1.15·max(S_null) + 1. Streak mode (the ray transform) is the rescue when no blob chain passes; an accepted
 * streak chain is observed at its segment centres, not its quantized ray positions (streakChain, E5 follow-up).
 *
 * Acceptance order: hard gates (sample counts, projective-line law with one shared c, D3's min step, the start
 * gap, f1, f2, f5, f7, f4 on exits), then the club chain rules (club-explained extent inside support collection,
 * outrun the club, rigid attachment, pre-existing mover, precursor), then the null margin. No launch-angle gate.
 * The learned LLR is diagnostic only. Single-sample launches stay off unless launch.singleSample.enabled.
 *
 * Impact timing (E2 fix round, checker gap 6). findImpacts widens the hypothesis interval by impact.timingTolFrames
 * on both sides of the coarse scan's [t_last, t_firstAbsent], because the coarse k_last is often 1-2 frames off (the
 * club hides the ball just before impact, or covers the vacated address just after it). The candidate last-address
 * frames are k' = floor(T0) .. floor(T1) of that interval in fractional frames, and every frame's evidence is kept
 * as the single-k_last search at any k' needs it (the address hole masked only after k').
 *  - Pass 1 is the single-k_last search at the coarse k_last: t0 in [k_last − 0.5, k_last + 1.5], post frames
 *    (k_last, k_last + 1 + K], the club arriving in [k_last − 0.5, k_last + 1], the envelope of the frames before.
 *    Two rules are new. A chain whose fitted t0 is pinned to an edge of its range fails ('timing'): it wants another
 *    impact time (with k_last 2 frames early the single-k_last search accepted club parts that way on 4.3% of the
 *    invisible-ball controls). When the search found no club at all, a chain meets the head of another candidate
 *    frame that arrived within launch.club.impactTolFrames of its t0 (chainClub) instead of vacuous club rules.
 *  - Only when pass 1 finds no passing chain, pass 2 runs the same search at every other k', with t0 between frames
 *    k' and k' + 1, and the strongest winner decides (with the first passing frame deciding, a weak chain at a
 *    nearer, wrong frame was confirmed). There a chain also needs a head tracked through impact (a measured exit)
 *    that arrived within launch.club.impactTolFrames of its t0: a mistimed search sees a wrong club (often the
 *    hands, without an exit) or none, and a vacuous club rule must not let a club part through.
 *  - The nulls keep pass 1's rules in both passes: the fake anchors at the winner's k', the fake impacts at their
 *    fixed times 12 and 20 frames before the coarse k_last.
 * Every search range lies inside the interval, and an accepted t0 is checked to lie inside it and strictly before
 * the first sample (protocol §5).
 */
import { PARAMS, spanFrames } from './params.js';
import { frameAt, simAt, applySim, makeLaunchDecision, makeLaunchCandidate, makeObservation, HFError, IDENTITY_SIM } from './types.js';
import {
  buildReference, ballEvidence, makeScratch, zLookup, emergenceChains, fitProjectiveLine, chainFeatures, rayGeometry,
  raySegments, rayTransform, diagnosticLLR, lawAt, blobWidths
} from './emergence.js';
import { clubEvidence, trackClub, clubExplained, clubAt, outrunsClub, attachedToClub, singleSampleOk } from './club.js';

const DEG = Math.PI / 180;
// the D3 min step shrinks with the law's size, down to this fraction of minStepD0·d0
const STEP_FLOOR = 0.25;
// precursor hits that stay within this many address-ball diameters of each other are one static object (d0)
const PRECURSOR_STATIC_D0 = 1;
// precursor search band on the backward line, as multiples of the law's initial speed × |τ| (ratio)
const PRECURSOR_SPEED = [0.4, 1.6];
// pass 2: a fitted t0 this close (frames) to an edge of its candidate frame's range is pinned there
const PIN_FRAMES = 0.01;

/**
 * Processing pool for an address-ball diameter d0 (px): the integer p >= 1 that brings d0/p nearest to
 * launch.roiD0Px in ratio, i.e. p or p + 1 around x = d0/roiD0Px, p + 1 once x² > p(p + 1). The protocol's
 * round(d0/roiD0Px) left d0 = 11.3-12 px (common at 1080×1920) at pool 1, a 4× larger grid at d0p ≈ 12 (E2 fix,
 * checker gap 7 cost); here they get pool 2 (d0p 5.7-6). The boundaries move from 12, 20, 28 to 11.3, 19.6, 27.7 px.
 */
export function launchPool(d0, params = PARAMS) {
  const x = d0 / params.launch.roiD0Px;
  let p = Math.max(1, Math.floor(x));
  if (x * x > p * (p + 1)) p++;
  return p;
}

/** S >= nulls.factor·max(S_null) + nulls.offset; margin = S − that bound (null scores below 0 count as 0). */
export function acceptLaunch(S, Snull, params = PARAMS) {
  const N = params.launch.nulls, mx = Math.max(0, ...Snull), margin = S - (N.factor * mx + N.offset);
  return { accepted: margin >= 0, margin };
}

const isIdentity = s => !s || (Math.abs(s.a - 1) < 1e-12 && Math.abs(s.b) < 1e-12 && Math.abs(s.tx) < 1e-12 && Math.abs(s.ty) < 1e-12);

/** Sample a LumaCrop into a processing grid {w, h, p, bx, by} through sim (stabilized -> raw); bilinear, edge-clamped. */
export function warpToGrid(crop, sim, grid, out = new Uint8Array(grid.w * grid.h)) {
  const { w, h, p, bx, by } = grid, s = sim ?? IDENTITY_SIM, cp = crop.pool, cw = crop.w, ch = crop.h, d = crop.data;
  if (Math.abs(s.a - 1) < 1e-12 && Math.abs(s.b) < 1e-12 && cp === p) {
    const ox = (bx + s.tx - crop.x0) / p, oy = (by + s.ty - crop.y0) / p;
    if (Math.abs(ox - Math.round(ox)) < 1e-6 && Math.abs(oy - Math.round(oy)) < 1e-6) {
      const ix = Math.round(ox), iy = Math.round(oy);
      for (let j = 0; j < h; j++) {
        const sy = Math.min(ch - 1, Math.max(0, j + iy)), o = j * w, so = sy * cw;
        for (let i = 0; i < w; i++) out[o + i] = d[so + Math.min(cw - 1, Math.max(0, i + ix))];
      }
      return out;
    }
  }
  for (let j = 0; j < h; j++) {
    const Y = by + p * (j + 0.5);
    for (let i = 0; i < w; i++) {
      const X = bx + p * (i + 0.5), rx = s.a * X - s.b * Y + s.tx, ry = s.b * X + s.a * Y + s.ty;
      let u = (rx - crop.x0) / cp - 0.5, v = (ry - crop.y0) / cp - 0.5;
      u = u < 0 ? 0 : u > cw - 1 ? cw - 1 : u; v = v < 0 ? 0 : v > ch - 1 ? ch - 1 : v;
      const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(cw - 1, u0 + 1), v1 = Math.min(ch - 1, v0 + 1), fu = u - u0, fv = v - v0;
      const a = d[v0 * cw + u0], b = d[v0 * cw + u1], c = d[v1 * cw + u0], e = d[v1 * cw + u1];
      out[j * w + i] = (a + (b - a) * fu) * (1 - fv) + (c + (e - c) * fu) * fv + 0.5;
    }
  }
  return out;
}

/**
 * The FrameConsumer for one ImpactHypothesis. ctx = {meta, log, params}; log.camera (CameraTrack) maps stabilized to
 * raw native px (identity when absent).
 */
export class LaunchConfirmer {
  constructor(hyp, { meta, log = null, params = PARAMS, streak = true } = {}) {
    if (!hyp || !meta) throw new HFError('bad-arg', 'LaunchConfirmer needs a hypothesis and meta');
    const P = params, L = P.launch, E = L.evidence;
    this.hyp = hyp; this.meta = meta; this.P = P; this.camera = log?.camera ?? null; this.streakMode = streak !== false;
    const fps = meta.fps, n = meta.frameCount, W = meta.width, H = meta.height, times = meta.times;
    const d0 = hyp.d0, pool = launchPool(d0, P), A = hyp.address;
    Object.assign(this, { fps, times, W, H, d0, pool, d0p: d0 / pool, A });
    this.K = Math.min(spanFrames(E.post, fps), L.emergence.maxFrames);
    const kLast = hyp.kLast;
    // impact range in fractional frames: the hypothesis interval (findImpacts widens it by the coarse scan's timing
    // tolerance); without one, D3's f3 range around k_last
    const iv = hyp.interval && Number.isFinite(hyp.interval.t0) && Number.isFinite(hyp.interval.t1) && hyp.interval.t1 >= hyp.interval.t0
      ? hyp.interval : { t0: this.timeOf(kLast + L.law.t0Frames[0]), t1: this.timeOf(kLast + L.law.t0Frames[1]) };
    this.interval = { t0: iv.t0, t1: iv.t1 };
    this.Treal = [this.fracOf(iv.t0), this.fracOf(iv.t1)];
    // One reference for every impact time: the per-pixel median of refFrames frames over refSec before the REAL
    // impact (D2), ending before its pre-impact frames. D2 gave each fake impact its own reference; sharing it makes
    // a frame's residual, DoG, CFAR, club evidence and ray segments identical for every impact time, so each frame is
    // processed once (3x less work), and the later reference only lets the fake-impact nulls see more motion.
    const preEnd = kLast - E.preFrames - 1, refs = new Set();
    if (preEnd >= 0) for (let i = 0; i < E.refFrames; i++) {
      const t = times[kLast] + E.refSec[0] + (E.refSec[1] - E.refSec[0]) * i / Math.max(1, E.refFrames - 1);
      refs.add(Math.min(preEnd, Math.max(0, frameAt(times, t))));
    }
    this.refs = [...refs].sort((a, b) => a - b);
    this.ref = null; this.refImgs = []; this.pending = [];
    // impacts: the real one and the fake (earlier) null impacts with the same range shifted by their offset; each has
    // its candidate last-address frames kLo..kHi and its pre/post evidence window around them
    // fake impacts keep the single-k_last null search at their fixed times (pass 2's nulls included: the fake impacts
    // stay 12 and 20 frames before the coarse k_last, with D3's f3 range), so only the real impact has a range
    const mkImp = (name, k, T) => ({ name, k, T, kLo: Math.floor(T[0]), kHi: Math.max(Math.floor(T[0]), Math.floor(T[1])) });
    const impacts = [mkImp('real', kLast, this.Treal)];
    for (const f of L.nulls.fakeImpactFrames) { const k = kLast - f; impacts.push({ ...mkImp(`t-${f}`, k, [k + L.law.t0Frames[0], k + L.law.t0Frames[1]]), kLo: k, kHi: k }); }
    this.impacts = impacts.filter(imp => imp.kLo - E.preFrames >= 0 && this.refs.length).map(imp => ({ ...imp, envBase: imp.kLo - E.preFrames, envBits: null, envs: new Map(), clubs: new Map() }));
    this.real = this.impacts.find(imp => imp.name === 'real') ?? null;
    // anchors: the address and the fake anchors at ±anchorOffsetW·W, address height, kept inside the frame
    const margin = 2 * d0;
    this.fakeAnchors = [-1, 1].map(sg => ({ name: sg < 0 ? 'a-' : 'a+', x: A.x + sg * L.nulls.anchorOffsetW * W, y: A.y })).filter(a => a.x >= margin && a.x <= W - margin);
    // processing grid: the reachable launch cone around every anchor, clipped to the frame
    const diag = Math.hypot(W, H), R = L.emergence.maxReachDiag * diag, below = R * Math.sin(-L.streak.coneDeg[0] * DEG) + 2 * d0;
    let x0 = A.x - R, x1 = A.x + R, y0 = A.y - R, y1 = A.y + below;
    for (const a of this.fakeAnchors) { x0 = Math.min(x0, a.x - R); x1 = Math.max(x1, a.x + R); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    this.grid = { bx: x0, by: y0, p: pool, w: Math.max(1, Math.ceil((x1 - x0) / pool)), h: Math.max(1, Math.ceil((y1 - y0) / pool)) };
    this.reachR = R;
    const ar = Math.ceil(2 * d0 + pool);
    this.addrGrid = { bx: Math.floor(A.x - ar), by: Math.floor(A.y - ar), p: pool, w: Math.max(1, Math.ceil(2 * ar / pool)), h: Math.max(1, Math.ceil(2 * ar / pool)) };
    // frame roles: 2 = full grid crop (reference or evidence), 1 = address crop only
    const roles = new Map(), mark = (k, r) => { if (k >= 0 && k < n) roles.set(k, Math.max(roles.get(k) ?? 0, r)); };
    this.evFrames = new Set();
    for (const k of this.refs) mark(k, 2);
    for (const imp of this.impacts) for (let k = imp.kLo - E.preFrames; k <= imp.kHi + 1 + this.K; k++) { mark(k, 2); if (k >= 0 && k < n) this.evFrames.add(k); }
    // frames only a pass-2 candidate frame needs (outside every impact's single-k_last window) are kept as grid images
    // and processed on first use, so a launch that pass 1 decides costs what the single-k_last search cost
    this.lazyFrames = new Set();
    const eager = new Set(this.refs);
    for (const imp of this.impacts) for (let k = imp.k - E.preFrames; k <= imp.k + 1 + this.K; k++) eager.add(k);
    for (const k of this.evFrames) if (!eager.has(k)) this.lazyFrames.add(k);
    // the address must stay empty after the latest possible impact
    const s0 = (this.real?.kHi ?? kLast) + P.scan.vacate.skipFrames + 1;
    this.addrRange = [s0, s0 + spanFrames(E.emptyAddress, fps)];
    for (let k = this.addrRange[0]; k <= this.addrRange[1]; k++) mark(k, 1);
    const ks = [...roles.keys()];
    this.from = ks.length ? Math.min(...ks) : 0;
    this.to = ks.length ? Math.max(...ks) + 1 : 0;
    this.roles = roles;
    this.sc = makeScratch(this.grid.w, this.grid.h);
    const gn = this.grid.w * this.grid.h;
    this.csc = { D: new Float32Array(gn), S: this.sc.S, S2: this.sc.S2, dog: new Float32Array(gn), z: new Float32Array(gn) };
    // ball and club evidence and ray segments as the single-k_last search at the coarse k_last needs them (the hole
    // masked after it); the grid images of the ambiguous frames (kLo, kHi] are kept so that the other version (the
    // hole masked from a different candidate frame on) can be computed if pass 2 needs it (`alt`)
    this.ev = new Map(); this.club = new Map(); this.segs = {}; this.Yamb = new Map(); this.alts = new Map(); this.Ylazy = new Map();
    this.last = this.from - 1;
    this.presence = []; this.geos = null;
    this.timing = { evidence: 0, club: 0, rays: 0, search: 0 };
  }

  /** Fractional frame index of video time t (VFR-safe, extrapolated by 1/fps outside the clip). */
  fracOf(t) {
    const times = this.times, n = times?.length ?? 0, dt = 1 / this.fps;
    if (!n) return t / dt;
    if (t < times[0]) return (t - times[0]) / dt;
    const k = frameAt(times, t);
    if (k >= n - 1) return n - 1 + (t - times[n - 1]) / dt;
    return k + (t - times[k]) / (times[k + 1] - times[k]);
  }

  /** Video time of a fractional frame index (the inverse of fracOf). */
  timeOf(T) {
    const times = this.times, n = times?.length ?? 0, dt = 1 / this.fps, k = Math.floor(T);
    if (!n) return T * dt;
    if (k < 0) return times[0] + T * dt;
    if (k >= n - 1) return times[n - 1] + (T - (n - 1)) * dt;
    return times[k] + (T - k) * (times[k + 1] - times[k]);
  }

  window() { return { from: this.from, to: this.to }; }

  get done() { return this.last >= this.to - 1; }

  roiRequests(index) {
    const r = this.roles.get(index);
    if (!r) return [];
    const g = r === 2 ? this.grid : this.addrGrid;
    return [{ rect: this.rectFor(index, g), pool: this.pool, purpose: r === 2 ? 'launch' : 'launch-address' }];
  }

  /** Raw native rect covering grid g at frame index under the camera similarity (exact when the camera is static). */
  rectFor(index, g) {
    const sim = this.camera ? simAt(this.camera, index) : IDENTITY_SIM, p = this.pool;
    if (isIdentity(sim)) return { x: g.bx, y: g.by, w: g.w * p, h: g.h * p };
    const cs = [[g.bx, g.by], [g.bx + g.w * p, g.by], [g.bx, g.by + g.h * p], [g.bx + g.w * p, g.by + g.h * p]].map(([x, y]) => applySim(sim, x, y));
    const x0 = Math.floor(Math.min(...cs.map(c => c.x))) - p, y0 = Math.floor(Math.min(...cs.map(c => c.y))) - p;
    const x1 = Math.ceil(Math.max(...cs.map(c => c.x))) + p, y1 = Math.ceil(Math.max(...cs.map(c => c.y))) + p;
    return { x: x0, y: y0, w: Math.max(p, x1 - x0), h: Math.max(p, y1 - y0) };
  }

  consume(index, t, crops, sim) {
    this.last = Math.max(this.last, index);
    const r = this.roles.get(index);
    if (!r || !crops?.length) return;
    if (r === 1) { if (this.ref) this.addressPresence(index, warpToGrid(crops[0], sim, this.addrGrid), this.addrGrid); return; }
    const Y = warpToGrid(crops[0], sim, this.grid);
    if (!this.ref && this.refs.includes(index)) {
      this.refImgs.push(Y);
      if (index === this.refs[this.refs.length - 1]) {
        this.ref = buildReference(this.refImgs, this.grid, this.A, this.d0p, this.hyp.polarity);
        this.refImgs = [];
        for (const f of this.pending) this.process(f.index, f.t, f.Y);
        this.pending = [];
      }
    }
    if (this.lazyFrames.has(index)) this.Ylazy.set(index, { t, Y });
    else if (this.evFrames.has(index)) { if (this.ref) this.process(index, t, Y); else this.pending.push({ index, t, Y }); }
    if (this.ref && index >= this.addrRange[0] && index <= this.addrRange[1]) this.addressPresence(index, Y, this.grid);
  }

  /** Evidence for one frame, shared by every impact time: ball peaks, pooled z, club peaks, envelopes, ray segments. */
  process(index, t, Y) {
    const P = this.P, E = P.launch.evidence, g = this.grid, d0p = this.d0p, real = this.real;
    const t0 = performance.now();
    // the single-k_last search's evidence: the address hole masked after the coarse k_last
    const hole = real && index > real.k ? this.holeDisc() : null;
    this.ev.set(index, this.ballPeaks(index, t, Y, hole));
    const t1 = performance.now();
    this.club.set(index, clubEvidence(Y, this.ref.B, g, d0p, this.csc, P, hole));
    this.timing.club += performance.now() - t1;
    if (real && index > real.kLo && index <= real.kHi) this.Yamb.set(index, Y);
    for (const imp of this.impacts) if (index >= imp.envBase && index <= imp.kHi) this.markMoved(imp, Y, index);
    const t2 = performance.now();
    for (const geo of this.geometries()) {
      if (!this.rayFrame(geo, index)) continue;
      (this.segs[geo.name] ??= new Map()).set(index, { k: index, t, segs: raySegments(this.sc.R, geo).segs });
    }
    this.timing.rays += performance.now() - t2;
    this.timing.evidence += performance.now() - t0;
    void E;
  }

  /** The address hole disc in grid px. */
  holeDisc() {
    const g = this.grid;
    return { x: (this.A.x - g.bx) / g.p, y: (this.A.y - g.by) / g.p, r: this.P.launch.evidence.holeD0 * this.d0p };
  }

  /**
   * Does frame index carry eager ray segments of geometry geo? Every geometry: the real impact's frames after the
   * coarse k_last up to K past the latest candidate frame (earlier ones are post-impact only for an earlier candidate
   * frame, whose masked version `alt` computes); the address also the fake impacts' post-impact frames.
   */
  rayFrame(geo, index) {
    const real = this.real, post = !!real && index > real.k && index <= real.kHi + this.K;
    return geo.name !== 'A' ? post : post || this.impacts.some(imp => imp !== real && index > imp.k && index <= imp.k + this.K);
  }

  /**
   * The other version of an ambiguous frame k (memoized per part): its evidence with the hole masked when the eager
   * one is not, or not when it is, from the kept grid image; part 'club' (club peaks) or 'ball' (ball peaks and ray
   * segments, which read the ball residual).
   */
  alt(k, part) {
    const Y = this.Yamb.get(k), ev = this.ev.get(k);
    if (!Y || !ev) return null;
    const out = this.alts.get(k) ?? {}, t0 = performance.now(), hole = k > this.real.k ? null : this.holeDisc();
    this.alts.set(k, out);
    if (part === 'club' && !out.club) out.club = clubEvidence(Y, this.ref.B, this.grid, this.d0p, this.csc, this.P, hole);
    if (part !== 'club' && !out.ev) {
      // the ball residual this leaves in the scratch is what the ray segments read
      out.ev = this.ballPeaks(k, ev.t, Y, hole);
      out.segs = {};
      for (const geo of this.geometries()) out.segs[geo.name] = { k, t: ev.t, segs: raySegments(this.sc.R, geo).segs };
    }
    this.timing.alt = (this.timing.alt ?? 0) + performance.now() - t0;
    return out;
  }

  /** Is the eager version of frame k the one wanted when the real impact follows frame h (hole after h)? */
  eagerFor(k, h) { return !this.real || (k > this.real.k) === (k > h); }

  /** Ball peaks and pooled z map of one frame, the address hole optional (grid px disc). */
  ballPeaks(index, t, Y, hole) {
    const g = this.grid, ev = ballEvidence(Y, this.ref, g, this.d0p, this.sc, this.P, { hole, exclude: hole ? (x, y) => (x - hole.x) ** 2 + (y - hole.y) ** 2 <= hole.r * hole.r : null });
    const peaks = ev.peaks.map((q, qi) => ({ id: `${index}:${qi}`, x: g.bx + g.p * q.x, y: g.by + g.p * q.y, z: q.z, zBig: q.zBig, zSmall: q.zSmall, blob: q.blob }));
    return { k: index, t, peaks, zmap: ev.zmap };
  }

  /** Ball evidence of frame k when the real impact follows frame h (the hole masked after h). */
  /** Process a lazily kept frame on first use (pass 2's extra frames). */
  ensure(k) {
    const f = this.Ylazy.get(k);
    if (f && this.ref) { this.Ylazy.delete(k); this.process(k, f.t, f.Y); }
  }

  evFor(k, h) { this.ensure(k); return this.eagerFor(k, h) ? this.ev.get(k) : (this.alt(k, 'ball')?.ev ?? this.ev.get(k)); }

  /** Club peaks of frame k when the real impact follows frame h. */
  clubFor(k, h) { this.ensure(k); return this.eagerFor(k, h) ? this.club.get(k) : (this.alt(k, 'club')?.club ?? this.club.get(k)); }

  /** Ray segments of geometry geo in frame k when the real impact follows frame h. */
  segsFor(geo, k, h) { this.ensure(k); return this.eagerFor(k, h) ? this.segs[geo.name]?.get(k) : (this.alt(k, 'ball')?.segs[geo.name] ?? this.segs[geo.name]?.get(k)); }

  /** Ray geometries: the address (every impact time) and the fake anchors (real impact frames). */
  geometries() {
    if (!this.geos) {
      const mk = (a, name) => ({ ...rayGeometry(this.grid, a, this.d0, this.reachR, this.P), name });
      this.geos = { A: mk(this.A, 'A') };
      for (const a of this.fakeAnchors) this.geos[a.name] = mk(a, a.name);
    }
    return Object.values(this.geos);
  }

  // Pre-impact swing envelope (D2): pixels that moved against the reference in the pre-impact frames, dilated by d0.
  // Per impact one bit per frame of envBase .. kHi records which pixels moved, so the envelope of any candidate
  // impact frame k (frames k − preFrames .. k) is one pass over the bits.
  markMoved(imp, Y, index) {
    const j = index - imp.envBase;
    if (j < 0 || j > 31) return;
    const { B, sigmaN } = this.ref, n = B.length, thr = Math.max(12, 4 * sigmaN);
    const bits = imp.envBits ??= new (imp.kHi - imp.envBase < 16 ? Uint16Array : Uint32Array)(n), b = (1 << j) >>> 0;
    for (let i = 0; i < n; i++) { const v = Y[i] - B[i]; if (v > thr || v < -thr) bits[i] |= b; }
  }

  /** The dilated swing envelope of impact imp for the candidate last-address frame k (memoized), or null. */
  envelopeAt(imp, k) {
    if (imp.envs.has(k)) return imp.envs.get(k);
    for (let kk = k - this.P.launch.evidence.preFrames; kk <= k; kk++) this.ensure(kk);
    let env = null;
    const lo = Math.max(0, k - this.P.launch.evidence.preFrames - imp.envBase), hi = Math.min(31, k - imp.envBase);
    if (imp.envBits && hi >= lo) {
      let mask = 0;
      for (let b = lo; b <= hi; b++) mask = (mask | (1 << b)) >>> 0;
      const { w, h } = this.grid, n = w * h, bits = imp.envBits, r = Math.max(1, Math.round(this.P.impact.envelope.dilateD0 * this.d0p));
      const raw = new Uint8Array(n), tmp = new Uint8Array(n);
      env = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (bits[i] & mask) raw[i] = 1;
      for (let y = 0; y < h; y++) { let run = -1e9; for (let x = 0; x < w; x++) { if (raw[y * w + x]) run = x; tmp[y * w + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = w - 1; x >= 0; x--) { if (raw[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; } }
      for (let x = 0; x < w; x++) { let run = -1e9; for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; env[y * w + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) env[y * w + x] = 1; } }
    }
    imp.envs.set(k, env);
    return env;
  }

  /**
   * The club head for impact imp seen from anchor A with last address frame k (the real impact following frame h):
   * the arrival lands in [k − 0.5, k + 1] within the impact range, club evidence up to h without the hole (memoized).
   */
  clubAtFrame(imp, A, k, h, tOf) {
    const key = `${A.x},${A.y}|${k}|${h}`;
    if (!imp.clubs.has(key)) {
      const T = [Math.max(imp.T[0], k - 0.5), Math.min(imp.T[1], k + 1)];
      const peaks = { get: kk => this.clubFor(kk, h) };
      imp.clubs.set(key, T[1] >= T[0] ? trackClub(peaks, { address: A, d0: this.d0 }, { T, kEnd: k + 1 + this.K, kLast: k, tOf, params: this.P, fps: this.fps }) : null);
    }
    return imp.clubs.get(key);
  }

  // Native address check (D2 §6): the ball must not be back at the address after the skip frames.
  addressPresence(index, Y, g) {
    if (!this.ref) return;
    const ax = (this.A.x - g.bx) / g.p, ay = (this.A.y - g.by) / g.p, rb = Math.max(0.6, 0.3 * this.d0p), rr = [0.9 * this.d0p, 1.6 * this.d0p];
    let sb = 0, nb = 0, sr = 0, nr = 0;
    for (let y = Math.floor(ay - rr[1]); y <= Math.ceil(ay + rr[1]); y++) for (let x = Math.floor(ax - rr[1]); x <= Math.ceil(ax + rr[1]); x++) {
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      const d = Math.hypot(x + 0.5 - ax, y + 0.5 - ay), v = Y[y * g.w + x];
      if (d <= rb) { sb += v; nb++; } else if (d >= rr[0] && d <= rr[1]) { sr += v; nr++; }
    }
    if (!nb || !nr) return;
    const pres = (sb / nb - sr / nr) / (this.ref.contrast || 1);
    this.presence.push({ k: index, p: pres });
  }

  /** Decide (LaunchDecision): the identical search for the launch and its nulls, then acceptance. */
  finish() {
    const t0 = performance.now(), out = this.decide();
    this.timing.search = performance.now() - t0;
    out.features.timing = { ...this.timing, grid: [this.grid.w, this.grid.h, this.pool] };
    return makeLaunchDecision(out);
  }

  /**
   * Candidate last-address frames for pass 2, nearest the coarse k_last first, later before earlier at equal
   * distance (the club hiding the ball just before impact makes the coarse k_last early more often than late).
   */
  altFrames() {
    const real = this.real, out = [];
    for (let k = real.kLo; k <= real.kHi; k++) if (k !== real.k) out.push(k);
    return out.sort((a, b) => (Math.abs(a - real.k) - Math.abs(b - real.k)) || (b - a));
  }

  decide() {
    const P = this.P, hyp = this.hyp, real = this.real;
    const reject = (reason, extra = {}) => ({ hypId: hyp.id, accepted: false, reason, candidate: null, S: extra.S ?? 0, Snull: extra.Snull ?? [], margin: extra.margin ?? -(P.launch.nulls.offset), llr: extra.llr ?? null, features: extra.features ?? {} });
    if (!real || !this.ref || !this.ev.size) return reject('ball_not_found_after_impact', { features: { why: 'no native frames' } });
    const refilled = this.presence.filter(q => q.p >= P.scan.vacate.recoverPresence);
    if (refilled.length) return reject('no_launch', { features: { why: 'address not empty', presence: this.presence } });
    // blob chains and streak chains compete; the larger S wins (both score Σ (min(z, zCap) − zOffset) less misses)
    // streak mode is the rescue for launches that never segment as blobs (D3); it runs when no blob chain passes
    const runAt = (k, strict) => {
      const o = { k, strict }, res = this.search(real, this.A, o);
      const streak = res.best || !this.streakMode ? { best: null, counts: null, passing: [] } : this.searchStreak(real, this.geos?.A, o);
      return { k, strict, res, streak, win: res.best ?? streak.best ?? null, mode: res.best ? 'blob' : streak.best ? 'streak' : 'blob' };
    };
    // pass 1: the coarse k_last, the single-k_last search; pass 2 (only when it finds nothing): the other candidate
    // frames of the impact interval, nearest first, each needing the head's arrival at the chain's t0
    const first = runAt(real.k, false), tried = [{ k: real.k, pass: !!first.win }];
    let run = first;
    // pass 2 takes the strongest winner over every candidate frame (ties to the nearer one): a weak chain at a
    // nearer, wrong frame must not pre-empt the launch at the right one
    if (!run.win) for (const k of this.altFrames()) {
      // a chain in pass 2 needs a head with an exit arriving near its t0 (chainClub): skip frames with none nearby
      let exitClub = false;
      for (let kk = Math.max(real.kLo, k - 1); kk <= Math.min(real.kHi, k + 1) && !exitClub; kk++) exitClub = this.clubAtFrame(real, this.A, kk, kk, this.tOf)?.measuredPost > 0;
      if (!exitClub) { tried.push({ k, pass: false, club: false }); continue; }
      const q = runAt(k, true);
      tried.push({ k, pass: !!q.win, S: q.win ? q.win.S : null });
      if (q.win && (!run.win || q.win.S > run.win.S)) run = q;
    }
    const { res, streak, win, mode, k, strict } = run;
    const club = win?.club ?? res.club;
    const features = {
      mode, chains: res.evaluated.slice(0, P.launch.emergence.keepChains).map(summary), club: clubSummary(club), counts: res.counts,
      streak: { counts: streak.counts, best: streak.best ? summary(streak.best) : null },
      impactTiming: { kLast: real.k, k, pass: strict ? 2 : 1, interval: [this.interval.t0, this.interval.t1], frames: [real.kLo, real.kHi], tried }
    };
    if (!win) {
      features.chains = first.res.evaluated.slice(0, P.launch.emergence.keepChains).map(summary);
      features.counts = first.res.counts; features.club = clubSummary(first.res.club);
      return reject(this.reasonFrom(first.res, first.streak), { S: first.res.topS, features });
    }
    // identity conflict: another passing chain off the winner's path that the winner does not clear by the null margin
    const rival = this.rival(win, [...res.passing, ...(streak.passing ?? [])]);
    // null launches (identical search at the same candidate frame, same mode)
    // a blob winner faces blob nulls; a streak winner (the rescue) faces the larger of blob and streak nulls
    const Snull = [];
    const both = (b, st) => mode === 'blob' ? b() : Math.max(b(), st());
    // the nulls keep pass 1's rules (no club-fit requirement, which would only lower them): the fake anchors at the
    // winner's candidate frame, the fake impacts at their fixed times before the coarse k_last
    for (const a of this.fakeAnchors) Snull.push(both(() => this.search(real, a, { k, exclude: win.support }).bestS, () => this.searchStreak(real, this.geos?.[a.name], { anchor: a, k }).bestS));
    for (const imp of this.impacts) if (imp !== real) Snull.push(both(() => this.search(imp, this.A, {}).bestS, () => this.searchStreak(imp, this.geos?.A, {}).bestS));
    const acc = acceptLaunch(win.S, Snull, P);
    const llr = win.features ? diagnosticLLR(win.features, P) : null;
    Object.assign(features, { S: win.S, Snull, margin: acc.margin, winner: summary(win), rival: rival ? summary(rival) : null, llrModel: 'e2-fixed-untrained' });
    if (rival && acc.accepted) return reject('identity_conflict', { S: win.S, Snull, margin: acc.margin, llr, features });
    if (win.single && !P.launch.singleSample.enabled) return reject('ball_left_frame_too_fast', { S: win.S, Snull, margin: acc.margin, llr, features });
    if (!acc.accepted) return reject('launch_not_confirmed', { S: win.S, Snull, margin: acc.margin, llr, features });
    const cand = this.candidate(win, mode, club, acc.margin);
    // protocol §5: t0 inside the impact interval and strictly before the first post-impact observation (the search
    // ranges guarantee it; a violation is a bug and must not reach the tracker)
    if (!(cand.t0 >= this.interval.t0 - 1e-9 && cand.t0 <= this.interval.t1 + 1e-9 && cand.t0 < cand.samples[0].t)) {
      features.why = 't0 outside the impact interval';
      return reject('launch_not_confirmed', { S: win.S, Snull, margin: acc.margin, llr, features });
    }
    return { hypId: hyp.id, accepted: true, reason: null, candidate: cand, S: win.S, Snull, margin: acc.margin, llr, features };
  }

  reasonFrom(res, streak) {
    const c = res.counts;
    if (!res.evaluated.length && !(streak?.counts?.chains)) return 'ball_not_found_after_impact';
    if (c.club > 0 && c.club >= c.gates) return 'club_only_motion';
    if (c.single > 0 && c.single >= c.gates) return 'ball_left_frame_too_fast';
    return 'ball_not_found_after_impact';
  }

  rival(win, passing) {
    const Sup = this.P.launch.support, need = this.P.decide.identityShareMax, N = this.P.launch.nulls;
    for (const r of passing) {
      if (r === win) continue;
      let on = 0;
      for (const q of r.support) {
        const pos = lawAt(win.law, this.A, q.t, this.fps), tol = Sup.tolPx + Sup.tolD0 * this.d0 + Sup.tolDist * pos.s;
        if (Math.hypot(q.x - pos.x, q.y - pos.y) <= tol) on++;
      }
      if (on / r.support.length < need && r.S * N.factor + N.offset > win.S) return r;
    }
    return null;
  }

  /** Video time of integer frame k (extrapolated by 1/fps past the clip). */
  tOf = k => this.times[Math.max(0, Math.min(this.times.length - 1, k))] + (k >= this.times.length ? (k - this.times.length + 1) / this.fps : 0);

  /**
   * Search context shared by the blob and streak searches for one (impact, anchor) pair at candidate last-address
   * frame k (the single-k_last search with k_last = k): t0 in [k − 0.5, k + 1.5] (pass 2: [k, k + 1]) within the
   * impact range, post frames (k, k + 1 + K], the club arriving in [k − 0.5, k + 1], the swing envelope of frames k − preFrames .. k.
   * holeAt: the frame after which the address hole is masked (the real impact's k; fake impacts use the real one's).
   * strict (pass 2): a chain also needs the head's arrival within launch.club.impactTolFrames of its t0.
   */
  context(imp, anchor, { exclude = null, k = imp.k, holeAt = imp === this.real ? k : this.real.k, strict = false } = {}) {
    const P = this.P, L = P.launch, E = L.evidence, d0 = this.d0, fps = this.fps, A = anchor, g = this.grid, tOf = this.tOf;
    const holeR = E.holeD0 * d0, isReal = anchor === this.A;
    const exR = d0 + 3;
    const keep = (kk, q) => {
      if (!isReal && Math.hypot(q.x - A.x, q.y - A.y) < holeR) return false;
      if (exclude) for (const s of exclude) if (s.k === kk && Math.hypot(s.x - q.x, s.y - q.y) < exR) return false;
      return true;
    };
    const evAt = kk => this.evFor(kk, holeAt);
    const framesPost = [];
    for (let kk = k + 1; kk <= k + 1 + this.K; kk++) {
      const ev = evAt(kk);
      if (ev) framesPost.push({ k: kk, t: ev.t, peaks: ev.peaks.filter(q => keep(kk, q)) });
    }
    // pass 1 keeps D3's f3 range around the coarse k_last; in pass 2, k is the last address frame, so the impact
    // lies between frames k and k + 1 (the union over k is the whole impact interval)
    const T = strict ? [Math.max(imp.T[0], k), Math.min(imp.T[1], k + 1)] : [Math.max(imp.T[0], k + L.law.t0Frames[0]), Math.min(imp.T[1], k + L.law.t0Frames[1])];
    // the head reaches the ball no later than the frame where the ball is first absent (were it hiding the ball
    // there, it would sit inside the address exclusion and could not be c_0)
    const club = this.clubAtFrame(imp, A, k, holeAt, tOf);
    const W = this.W, H = this.H, cam = this.camera;
    const inFrame = (kk, x, y) => { const q = cam ? applySim(simAt(cam, kk), x, y) : { x, y }; return q.x >= 0 && q.y >= 0 && q.x < W && q.y < H && x >= g.bx && y >= g.by && x < g.bx + g.w * g.p && y < g.by + g.h * g.p; };
    const zAt = (kk, x, y, r = 1) => { const ev = evAt(kk); return ev ? zLookup(ev.zmap, (x - g.bx) / g.p, (y - g.by) / g.p, r) : 0; };
    const inEnvelope = (x, y) => { const env = this.envelopeAt(imp, k); if (!env) return false; const i = Math.floor((x - g.bx) / g.p), j = Math.floor((y - g.by) / g.p); return i >= 0 && j >= 0 && i < g.w && j < g.h && env[j * g.w + i] === 1; };
    const reachPerFrame = L.emergence.reachD0PerFrame * d0 * 30 / Math.max(30, fps);
    const cHi = L.law.maxBallSpeedMps / (Math.min(...P.fit.focalComponents) * (Math.max(W, H) / 2) / Math.tan(P.fit.fovLongDeg / 2 * DEG) * P.fit.ballDiameterM / d0) / fps;
    return {
      A, d0, fps, pool: this.pool, framesPost, params: P, T, tOf, kImpact: k, holeAt, holeR, club, inFrame, zAt, inEnvelope, evAt, strict,
      reach: kk => Math.min(this.reachR, (kk - T[0] + 1) * reachPerFrame), cRange: [L.gates.minBetaPerFrame, Math.max(0.05, cHi)],
      clubExplained: (kk, x, y) => clubExplained(x, y, kk, club, d0, P), imp
    };
  }

  /** The identical blob search (real launch and nulls). */
  search(imp, anchor, opts) {
    const ctx = this.context(imp, anchor, opts);
    const chains = emergenceChains(ctx);
    const counts = { chains: chains.length, gates: 0, club: 0, single: 0, score: 0, pass: 0 };
    const evaluated = [], passing = [];
    let topS = 0;
    for (const ch of chains) {
      const e = this.evaluate(ch, ctx);
      evaluated.push(e);
      topS = Math.max(topS, ch.S);
      if (e.pass) { passing.push(e); counts.pass++; }
      else if (e.fail === 'single') counts.single++;
      else if (['outrun', 'attached', 'premover', 'precursor', 'clubhits'].includes(e.fail)) counts.club++;
      else if (e.fail === 'score') counts.score++;
      else counts.gates++;
    }
    passing.sort((a, b) => b.S - a.S);
    evaluated.sort((a, b) => (b.pass - a.pass) || b.S - a.S);
    const best = passing[0] ?? null;
    return { best, bestS: best ? best.S : 0, passing, evaluated, club: ctx.club, counts, topS };
  }

  /**
   * Timing rules. Both passes: the chain's t0 must not be pinned to an edge of the search range. Pass 2 also: the
   * head must be tracked through impact (a measured exit: an exit-less arrival at a mistimed frame is the hands or a
   * slow link, which explains nothing of the real head) and must have arrived within impactTolFrames of the t0.
   */
  timingOk(ctx, law, samples, club) {
    // the chain belongs to the candidate frame whose range holds its free t0: one pinned to an edge of the range
    // prefers another impact time (a mistimed coarse k_last: at 2 frames early the single-k_last search accepted club
    // parts with t0 pressed against its upper edge; a mover already crossing the address). Pass 1 defers such a
    // chain to pass 2. A single sample does not measure t0.
    const T0 = this.fracOf(law.t0);
    if (samples.length >= 2) {
      const tFirst = Math.min(...samples.map(q => q.t)), hi = Math.min(ctx.T[1], this.fracOf(tFirst - 0.02 / this.fps));
      if (T0 - ctx.T[0] < PIN_FRAMES || hi - T0 < PIN_FRAMES) return false;
    }
    return !ctx.strict || this.clubFits(club, T0);
  }

  /** A head tracked through impact (a measured exit) that arrived within impactTolFrames of fractional frame T0. */
  clubFits(club, T0) { return !!club && club.measuredPost > 0 && Math.abs(club.T - T0) <= this.P.launch.club.impactTolFrames; }

  /**
   * The club a chain is judged against. Pass 1 keeps the single-k_last search's club whenever it found one; only
   * when it found none (vacuous club rules) does the chain meet the head of another candidate frame that fits its t0
   * (clubFits), nearest first (later before earlier). Pass 2: the context's head when it fits, else such a fitting
   * head, else none. With the coarse k_last off by a frame the arrival search misses the head (no club), which let
   * club parts through on the shifted scene matrix. Replacing a club that WAS found cost recall instead: the
   * replacement's exit can follow the ball when the head goes undetected after impact (easy-02 at its exact
   * k_last, and 1.9 points of the exact-k_last matrix).
   */
  chainClub(ctx, law) {
    const T0 = this.fracOf(law.t0), imp = ctx.imp;
    if (!ctx.strict && ctx.club) return ctx.club;
    if (this.clubFits(ctx.club, T0)) return ctx.club;
    const ks = [];
    for (let k = imp.kLo; k <= imp.kHi; k++) if (k !== ctx.kImpact) ks.push(k);
    ks.sort((a, b) => (Math.abs(a - ctx.kImpact) - Math.abs(b - ctx.kImpact)) || (b - a));
    for (const k of ks) {
      const c = this.clubAtFrame(imp, ctx.A, k, imp === this.real ? k : ctx.holeAt, this.tOf);
      if (this.clubFits(c, T0)) return c;
    }
    return ctx.strict ? null : ctx.club;
  }

  /**
   * The outrun rule compares image distances from the address, which order the ball ahead of the head only while
   * both cross the image. A chain receding from the camera (law c >= club.recede.minC per frame, down the line)
   * covers little image distance for its travel while the head sweeps across the image, so it is exempt when it has
   * club.recede.minSamples samples, each at least clearD0·d0 from the measured head in its frame (a part riding on
   * the head stays near it; clubhits and the attachment test still apply).
   */
  recedesClear(law, samples, club) {
    const R = this.P.launch.club.recede;
    if (!club || !(law?.c * this.fps >= R.minCPerSec) || samples.length < R.minSamples) return false;
    return samples.every(q => { const pt = clubAt(club, q.k ?? q.index); return !pt?.measured || Math.hypot(q.x - pt.x, q.y - pt.y) >= R.clearD0 * this.d0; });
  }

  /**
   * The lone-ball case: the club's exit seed (its first measured post-impact point) lies on a sample of this chain in
   * its frame (within max(d0, the head's extent)), and the chain has club.recede.loneSamples samples on a law receding
   * from the camera (c·fps >= loneCPerSec). At night the dark head goes unseen and club.js takes the lone body leaving
   * the address, the ball, as the head; a head stays within the golfer's reach and turns along its arc, so five samples
   * on one receding line are the ball. The club rules do not apply then (the decision's swing-disc escape still guards
   * the flight).
   */
  loneBall(club, law, samples) {
    const R = this.P.launch.club.recede;
    if (!club || samples.length < R.loneSamples || !(law?.c * this.fps >= R.loneCPerSec)) return false;
    const seed = club.points.find(p => p.measured && p.index > club.T);
    const q = seed && samples.find(s => (s.k ?? s.index) === seed.index);
    return !!q && Math.hypot(q.x - seed.x, q.y - seed.y) <= Math.max(this.d0, seed.extent ?? 0);
  }

  /** Gates and club rules for one chain; returns {pass, fail, ...}. */
  evaluate(ch, ctx) {
    const P = this.P, L = P.launch, G = L.gates, Sm = L.samples, d0 = this.d0, A = ctx.A;
    const e = { S: ch.S, support: ch.support, law: ch.law, m: ch.support.length, inFrame: ch.inFrame, exited: ch.exited, clubHits: ch.clubHits, misses: ch.misses, single: false, pass: false, fail: null, mode: 'blob', club: ctx.club, kImpact: ctx.kImpact };
    const law = ch.law;
    if (!law) { e.fail = 'law'; return e; }
    // the head that arrived at this chain's own t0 (chainClub); support collected against another club is checked
    // against it once more below
    const club = this.chainClub(ctx, law), clubEx = (kk, x, y) => clubExplained(x, y, kk, club, d0, P);
    e.club = club;
    // lead (f4): no other ball-scale peak farther along the line within ±15° (and within 2.5× the distance)
    for (const q of ch.support) {
      const f = ctx.framesPost.find(r => r.k === q.k), s = Math.hypot(q.x - A.x, q.y - A.y);
      q.leader = !f.peaks.some(o => {
        if (o.id === q.id || clubEx(q.k, o.x, o.y)) return false;
        const dx = o.x - A.x, dy = o.y - A.y, d = Math.hypot(dx, dy);
        if (d <= s + d0 || d > 2.5 * s) return false;
        return Math.acos(Math.max(-1, Math.min(1, (dx * law.dir.x + dy * law.dir.y) / d))) < 15 * DEG && !(o.blob?.big);
      });
    }
    const feat = chainFeatures({ law, samples: ch.support }, this.hyp, club, { params: P, fps: this.fps, pool: this.pool, addressFlux: this.addressFlux() });
    e.features = feat;
    const m = e.m, stays = ch.inFrame >= Sm.minInFrame, need = stays ? Sm.minInFrame : Sm.minExit;
    if (m < need) {
      if (m === 1 && ch.inFrame <= 1) { e.single = true; if (!L.singleSample.enabled || !singleSampleOk({ ...ch.support[0] }, club, P)) { e.fail = 'single'; return e; } }
      else { e.fail = 'samples'; return e; }
    }
    // a two-sample exit is a sighting plus one confirmation: a predicted in-frame miss between them leaves one
    if (m === 2 && ch.support[1].k - ch.support[0].k > 1) { e.fail = 'samples'; return e; }
    if (!law.ok) { e.fail = 'law'; return e; }
    // D3 chains move at least minStepD0·d0 per frame: the law's own step at every support (a static speck near the
    // address fits s = vτ/(1 + cτ) with a large c, since s saturates at v/c). d0 is the size at the address: the
    // step is scaled by the law's own shrink 1/(1 + cτ), floored at STEP_FLOOR (far down the line a real ball
    // moves 3-6 px/frame at 0.2 d0 across)
    const sOf = tau => law.v * tau / (1 + law.c * tau);
    for (const q of ch.support) {
      const tau = (q.t - law.t0) * this.fps, shrink = Math.max(STEP_FLOOR, Math.min(1, 1 / (1 + law.c * tau)));
      if (sOf(tau) - sOf(Math.max(0, tau - 1)) < L.emergence.minStepD0 * d0 * shrink) { e.fail = 'step'; return e; }
    }
    // the chain must emerge from the address: D3's gap limit also holds before the first support, counting only
    // predicted frames that no merge explains (club-explained or merged 'wide' blobs are the ball hidden by the club)
    let lead = 0;
    for (const ms of ch.misses) { if (ms.k >= ch.support[0].k) break; if (ms.reason !== 'club' && ms.reason !== 'wide') lead++; }
    if (lead > L.emergence.maxGapFrames) { e.fail = 'latestart'; return e; }
    if (m >= 3 && feat.f1 > G.straightnessD) { e.fail = 'f1'; return e; }
    if (m >= 3 && (feat.f2 > G.profileD0 || law.c < G.minBetaPerFrame)) { e.fail = 'f2'; return e; }
    const dMed = [...law.dExp].sort((a, b) => a - b)[law.dExp.length >> 1];
    if (feat.f5 !== null && feat.f5 > G.widthRatio + G.widthSlackPx / dMed) { e.fail = 'f5'; return e; }
    if (feat.f7 > 1) { e.fail = 'f7'; return e; }
    if (!stays && feat.f4 < 1) { e.fail = 'f4'; return e; }
    if (!this.timingOk(ctx, law, ch.support, club)) { e.fail = 'timing'; return e; }
    const lone = this.loneBall(club, law, ch.support);
    e.lone = lone;
    if (!lone && club !== ctx.club && ch.support.some(q => clubEx(q.k, q.x, q.y))) { e.fail = 'clubhits'; return e; }
    if (!lone && !outrunsClub({ dir: law.dir, v: law.v, samples: ch.support }, club, P) && !this.recedesClear(law, ch.support, club)) { e.fail = 'outrun'; return e; }
    if (!lone && attachedToClub(ch.support, club, this.d0)) { e.fail = 'attached'; return e; }
    if (this.preMover(ch, ctx, clubEx)) { e.fail = 'premover'; return e; }
    const pc = this.precursor(law, ctx, clubEx);
    e.precursor = pc.pre;
    if (this.precursorFails(pc, ch.S, m)) { e.fail = 'precursor'; return e; }
    if (ch.S < L.support.minScore) { e.fail = 'score'; return e; }
    e.pass = true;
    return e;
  }

  addressFlux() { return Math.abs(this.ref?.contrast ?? 0) * Math.PI * (this.d0 / 2) ** 2; }

  /**
   * Pre-existing mover (D2): one frame before the first support, a peak with z >= preMoverZ·z_first within
   * max(preMoverD0·d0, preMoverStep·step) of it, not the hypothesis's own predicted previous position and not the
   * club. D2's disc alone fires on any arm, glove or golfer edge one frame earlier when steps are large (≈220 px at
   * 30 fps down the line), so the earlier peak must also lie on the hypothesis line (support tolerance across it)
   * and behind the first support: an object already moving along the path, which a launched ball cannot be.
   */
  preMover(ch, ctx, clubEx = ctx.clubExplained) {
    const C = this.P.launch.club, Sup = this.P.launch.support, d0 = this.d0, sp = ch.support[0], kp = sp.k - 1, law = ch.law, u = law.dir;
    const prev = lawAt(law, ctx.A, ctx.tOf(kp), this.fps), step = Math.hypot(sp.x - prev.x, sp.y - prev.y);
    const R = Math.max(C.preMoverD0 * d0, C.preMoverStep * step), own = 0.75 * d0 + 2;
    // a ball's own streak one frame earlier is at most one law step long (exposure <= one frame interval)
    const prev2 = lawAt(law, ctx.A, ctx.tOf(kp - 1), this.fps), stepKp = Math.hypot(prev.x - prev2.x, prev.y - prev2.y);
    const sSp = (sp.x - ctx.A.x) * u.x + (sp.y - ctx.A.y) * u.y, halfLen = 0.5 * Math.max(stepKp, Math.max(0, (sp.len ?? 0) - (sp.w ?? 0)));
    for (const q of ctx.evAt(kp)?.peaks ?? []) {
      if (Math.hypot(q.x - sp.x, q.y - sp.y) > R) continue;
      // its own predicted previous position, anywhere along its own streak (a blurred ball's peak sits anywhere on it)
      const ox = q.x - prev.x, oy = q.y - prev.y, oAlong = Math.abs(ox * u.x + oy * u.y), oAcross = Math.abs(-ox * u.y + oy * u.x);
      if (oAcross < own && oAlong < own + halfLen) continue;
      if (Math.hypot(q.x - ctx.A.x, q.y - ctx.A.y) < this.P.launch.evidence.holeD0 * d0) continue;
      if (clubEx(kp, q.x, q.y)) continue;
      const dx = q.x - ctx.A.x, dy = q.y - ctx.A.y, along = dx * u.x + dy * u.y, across = Math.abs(-dx * u.y + dy * u.x);
      if (along >= sSp || across > Sup.tolPx + Sup.tolD0 * d0 + Sup.tolDist * Math.abs(along)) continue;
      if (q.z >= C.preMoverZ * sp.z) return true;
    }
    return false;
  }

  /** Precursor evidence (D2): z along the constant-velocity backward extension over the pre-impact frames. */
  precursor(law, ctx, clubEx = ctx.clubExplained) {
    const Sup = this.P.launch.support, G = this.P.launch.gates, d0 = this.d0, A = ctx.A, u = law.dir, p = this.grid.p;
    const wBall = G.widthRatio * d0 + G.widthSlackPx;
    let pre = 0, n = 0, hits = 0;
    const at = [];
    for (let k = ctx.kImpact - this.P.launch.evidence.preFrames + 1; k <= ctx.kImpact + 1; k++) {
      const tau = (ctx.tOf(k) - law.t0) * this.fps;
      if (!(tau < 0)) continue;
      // D2's point is the constant-velocity backward extension v·τ; the law trades a later t0 and a higher v against
      // a little c, so an object it continues at constant speed sits off that point: the best BALL-SIZED peak on
      // the backward line within PRECURSOR_SPEED × v·|τ| counts. The arriving head (wider, or club-explained) does
      // not: down the line it climbs the ball's own line to the V's apex.
      const lo = Math.max(ctx.holeR, PRECURSOR_SPEED[0] * law.v * -tau), hi = PRECURSOR_SPEED[1] * law.v * -tau + d0;
      const mid = 0.5 * (lo + hi);
      if (!ctx.inFrame(k, A.x - u.x * mid, A.y - u.y * mid)) continue;
      let best = 0, bq = null;
      for (const q of ctx.evAt(k)?.peaks ?? []) {
        const dx = q.x - A.x, dy = q.y - A.y, back = -(dx * u.x + dy * u.y), across = Math.abs(-dx * u.y + dy * u.x);
        if (back < lo || back > hi || across > Sup.tolPx + Sup.tolD0 * d0 + Sup.tolDist * back || q.z <= best) continue;
        if (!q.blob || q.blob.big || blobWidths(q.blob, u.x, u.y).minor * p > wBall || clubEx(k, q.x, q.y)) continue;
        best = q.z; bq = q;
      }
      const ev = Math.max(0, Math.min(Sup.zCap, best) - Sup.zOffset);
      pre += ev; n++;
      if (ev > 0) { hits++; at.push({ x: bq.x, y: bq.y, ev }); }
    }
    // A precursor moves along the line toward the address; a static object (a tee, a ball on the mat, a shoe) only
    // sits in the band while it sweeps past it, frame after frame, and is no precursor (it vetoed real launches).
    if (at.length >= 2 && at.every(q => Math.hypot(q.x - at[0].x, q.y - at[0].y) <= PRECURSOR_STATIC_D0 * d0)) return { pre: 0, n, hits: 0, static: true };
    return { pre, n, hits };
  }

  /**
   * Precursor rule (D2): the backward evidence exceeds precursorFrac·max(1, S), or, seen in at least two
   * pre-impact frames, its mean per evaluated frame exceeds precursorFrac × the chain's mean per support (D2's
   * total alone can never reject a chain with S > 2·preFrames·(zCap − zOffset), however strong the object it
   * continues; one glint in one frame is not an object moving through the address).
   */
  precursorFails(pc, S, m) {
    const f = this.P.launch.support.precursorFrac;
    return pc.pre > f * Math.max(1, S) || (pc.hits >= 2 && pc.pre / pc.n > f * S / Math.max(1, m));
  }

  /** Streak mode (D3 ray transform + monotone DP) for one (impact, anchor) pair: the best passing direction. */
  searchStreak(imp, geo, { anchor = this.A, k = imp.k, holeAt = imp === this.real ? k : this.real.k, strict = false } = {}) {
    const counts = { chains: 0, pass: 0, gates: 0, club: 0 }, segs = [];
    if (geo) for (let kk = k + 1; kk <= k + this.K; kk++) { const f = this.segsFor(geo, kk, holeAt); if (f) segs.push(f); }
    if (!segs.length) return { best: null, bestS: 0, counts, evaluated: [] };
    const ctx = this.context(imp, anchor, { k, strict, holeAt });
    const evaluated = rayTransform(segs, geo, { address: anchor, d0: this.d0 }, { params: this.P }).map(ch => this.evaluateStreak(ch, ctx, segs, anchor));
    for (const e of evaluated) {
      counts.chains++;
      if (e.pass) counts.pass++; else if (['clubhits', 'outrun', 'attached', 'precursor'].includes(e.fail)) counts.club++; else counts.gates++;
    }
    const passing = evaluated.filter(e => e.pass).sort((a, b) => b.S - a.S);
    return { best: passing[0] ?? null, bestS: passing[0]?.S ?? 0, counts, evaluated, passing, rejected: passing[0] ? null : evaluated[0] ?? null };
  }

  /** Gates for one streak chain: the projective-line law with widths, f1, f2, f5/f6 for streaks, club rules. */
  evaluateStreak(chain, ctx, segs, anchor) {
    const P = this.P, L = P.launch;
    let pc = null;
    const samples = chain.samples.map(q => ({ ...q, index: q.k }));
    const lawCtx = { t0Range: [this.timeOf(ctx.T[0]), this.timeOf(ctx.T[1])], cRange: ctx.cRange };
    const law = fitProjectiveLine(samples.map(q => ({ t: q.t, x: q.x, y: q.y, w: q.w > 0 ? q.w : null })), { address: anchor, d0: this.d0 }, { fps: this.fps, ...lawCtx, params: P, dir: chain.dir, quantum: L.streak.sStepD0 * this.d0 });
    const e = { S: chain.score, support: samples, law, m: samples.length, mode: 'streak', pass: false, fail: null, single: false, chain, club: ctx.club, kImpact: ctx.kImpact, lawCtx };
    if (!law) { e.fail = 'law'; return e; }
    const club = this.chainClub(ctx, law), clubEx = (kk, x, y) => clubExplained(x, y, kk, club, this.d0, P);
    e.club = club;
    let inFrame = 0;
    for (const f of segs) { const pos = lawAt(law, anchor, f.t, this.fps); if (pos.s >= ctx.holeR && ctx.inFrame(f.k, pos.x, pos.y)) inFrame++; }
    e.inFrame = inFrame;
    // streaks need three samples even on an exit: a two-frame streak exit (face-on 30/60 fps) is physically
    // limited, and two segments constrain neither the law nor a constant exposure
    const need = Math.max(3, inFrame >= L.samples.minInFrame ? L.samples.minInFrame : L.samples.minExit);
    const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
    const dExp = samples.map(q => this.d0 / (1 + law.c * Math.max(0, (q.t - law.t0) * this.fps)));
    // f5 for streaks: the 2-D minor axis of each streak against d_exp, bounded below by D1's start-width band (a
    // shaft or a body edge is a thin line; seen across an oblique ray it reads w/sin α, so the cross-ray profile is
    // not used), and f7: its major axis along the ray within max(streakAxisDeg, atan(2/len)) (D3)
    const wRatio = med(samples.map((q, i) => (q.shape ? q.shape.minor : q.w) / dExp[i]));
    const th = Math.atan2(law.dir.y, law.dir.x);
    const axis = med(samples.map(q => {
      if (!q.shape) return Infinity;
      let da = Math.abs(q.shape.angle - th) % Math.PI;
      if (da > Math.PI / 2) da = Math.PI - da;
      return da / Math.max(L.gates.streakAxisDeg * Math.PI / 180, Math.atan(2 / Math.max(1, q.shape.major)));
    }));
    // f6 for streaks (flux is conserved under blur, D3): segment flux against a ball of the expected size with the
    // contrast the ball would have against the reference at that place
    const g = this.grid, ref = this.ref;
    const fluxRatio = med(samples.map((q, i) => {
      const gi = Math.floor((q.x - g.bx) / g.p), gj = Math.floor((q.y - g.by) / g.p);
      const cap = gi >= 0 && gj >= 0 && gi < g.w && gj < g.h ? ref.cap[gj * g.w + gi] - Math.max(6, 3 * ref.sigmaN) : Math.abs(ref.contrast);
      return q.flux / Math.max(1e-6, Math.max(1, cap) * Math.PI * dExp[i] * dExp[i] / 4);
    }));
    // streak mode is for streaks: elongated (length >= streakMinAspect × d_exp) and physical (a streak cannot be
    // longer than its frame step plus the ball, the exposure being at most one frame interval)
    const aspect = med(samples.map((q, i) => q.len / dExp[i]));
    e.features = { f5: wRatio, f6: fluxRatio, aspect };
    // Exposure-consistent ends: a ball streak at frame k runs from s(τ_k − e/2) − d/2 to s(τ_k + e/2) + d/2 on its
    // own law, with ONE exposure fraction e in (0, 1] for the chain (the near end may be cut at the hole edge).
    // A shaft or edge crossing the strip ends wherever it leaves the strip. Best e on a 0.05 grid; RMS of the end
    // residuals must stay within the bin quantization (one bin) plus half a ball.
    const ds = L.streak.sStepD0 * this.d0, sOf = tau => (tau > 0 ? law.v * tau / (1 + law.c * tau) : 0);
    let bestE = null, bestR = Infinity;
    for (let e = 0.05; e <= 1.0001; e += 0.05) {
      let ss = 0, n = 0;
      samples.forEach((q, i) => {
        const tau = (q.t - law.t0) * this.fps, far = sOf(tau + e / 2) + dExp[i] / 2, near = sOf(tau - e / 2) - dExp[i] / 2;
        const mFar = q.s + q.len / 2, mNear = q.s - q.len / 2;
        ss += (mFar - far) ** 2; n++;
        if (mNear > ctx.holeR + ds) { ss += (mNear - near) ** 2; n++; }
      });
      const rms = Math.sqrt(ss / n);
      if (rms < bestR) { bestR = rms; bestE = e; }
    }
    const physical = bestR <= ds + 0.5 * this.d0;
    e.features.exposure = bestE; e.features.endRms = bestR / this.d0;
    // the ball leads the club head (E2b: farther from the address in every frame, any direction)
    const leads = !club || samples.every(q => { const pt = clubAt(club, q.k); return !pt || q.s >= L.club.outrunRatio * Math.hypot(pt.x - anchor.x, pt.y - anchor.y); });
    // club-explained on the streak midpoint (at long exposure the streak's tail touches the trailing head for a
    // frame or two; the lead rule below separates the two bodies)
    const clubHit = samples.some(q => clubEx(q.k, q.x, q.y));
    // radial (f7 for streaks): the neighbour-ray shift of the segment stays within half a ball plus a tenth of its length
    const radial = med(samples.map((q, i) => q.shift === null ? Infinity : q.shift / (0.5 * dExp[i] + 0.1 * q.len)));
    e.features.f7 = Math.max(radial, axis);
    if (e.m < need) e.fail = 'samples';
    else if (!(aspect >= L.gates.streakMinAspect) || !physical) e.fail = 'notstreak';
    else if (!law.ok) e.fail = 'law';
    else if (e.m >= 3 && law.perpRms / this.d0 > L.gates.straightnessD) e.fail = 'f1';
    else if (e.m >= 3 && (law.rms / this.d0 > L.gates.profileD0 || law.c < L.gates.minBetaPerFrame)) e.fail = 'f2';
    else if (!(wRatio <= L.gates.widthRatio + L.gates.widthSlackPx / med(dExp)) || !(wRatio >= L.law.startWidthD0[0])) e.fail = 'f5';
    else if (!(fluxRatio >= L.gates.fluxRange[0] && fluxRatio <= L.gates.fluxRange[1])) e.fail = 'f6';
    else if (!(radial <= 1) || !(axis <= 1)) e.fail = 'f7';
    else if (!this.timingOk(ctx, law, samples, club)) e.fail = 'timing';
    else {
      // the club rules, unless the club's exit was this chain (loneBall)
      const lone = e.lone = this.loneBall(club, law, samples);
      if (!lone && clubHit) e.fail = 'clubhits';
      else if (!lone && !leads) e.fail = 'outrun';
      else if (!lone && !outrunsClub({ dir: law.dir, v: law.v, samples }, club, P) && !this.recedesClear(law, samples, club)) e.fail = 'outrun';
      else if (!lone && attachedToClub(samples, club, this.d0)) e.fail = 'attached';
      else if (this.precursorFails(pc = this.precursor(law, ctx, clubEx), e.S, e.m)) { e.precursor = pc.pre; e.fail = 'precursor'; }
      else if (e.S < L.support.minScore) e.fail = 'score';
      else e.pass = true;
    }
    return e;
  }

  /**
   * Where a streak sample is observed (E5 follow-up). A ray-transform sample sits on its ray at the midpoint of its
   * bin run, so it carries the polar grid's quantization: half a bin (sStepD0·d0) along the ray and up to s·tan of
   * a θ step across it (5-7 px on smoke-17, more than its far ball's 0.75·d match radius of 5-6 px). The segment's
   * half-maximum centroid (its 2-D shape) is the streak centre, the ball at mid-exposure; it is used when it lies in
   * the sample's own quantization cell (within one bin along the ray, half a strip plus one θ step across), so a
   * brighter neighbour in the moment box can never move the sample. The chain's gates and law keep the ray positions.
   */
  streakCentre(q, dir) {
    const c = q.shape, S = this.P.launch.streak;
    if (!c || !Number.isFinite(c.cx) || !Number.isFinite(c.cy)) return null;
    const dx = c.cx - q.x, dy = c.cy - q.y, along = dx * dir.x + dy * dir.y, across = -dx * dir.y + dy * dir.x;
    const ds = S.sStepD0 * this.d0, wide = 0.5 * S.stripD0 * this.d0 + Math.abs(q.s ?? 0) * Math.tan(S.thetaStepDeg * DEG);
    return Math.abs(along) <= ds && Math.abs(across) <= wide ? { x: c.cx, y: c.cy } : null;
  }

  /**
   * A streak chain observed at its segment centres (streakCentre), with the projective-line law refitted on them:
   * quantized run midpoints also bias the law, its t0 by up to a bin over the step (1.4 ms on smoke-17, which the
   * flight fit cannot absorb with t0 fixed). The centres are used only when that law still holds (ok) and its t0 is
   * not pinned to an edge of the chain's t0 range (timingOk's rule); otherwise the chain keeps its ray positions and
   * law. Returns {law, at: per-sample centre or null} or null.
   */
  streakChain(win) {
    const dir = win.chain?.dir ?? win.law.dir, at = win.support.map(q => this.streakCentre(q, dir));
    if (!win.lawCtx || !at.some(Boolean)) return null;
    const pts = win.support.map((q, i) => ({ t: q.t, x: (at[i] ?? q).x, y: (at[i] ?? q).y, w: q.w > 0 ? q.w : null }));
    const quantum = at.every(Boolean) ? undefined : this.P.launch.streak.sStepD0 * this.d0;
    const law = fitProjectiveLine(pts, { address: this.A, d0: this.d0 }, { fps: this.fps, ...win.lawCtx, params: this.P, quantum });
    if (!law?.ok) return null;
    const [lo, hi0] = win.lawCtx.t0Range, T0 = this.fracOf(law.t0), hi = Math.min(this.fracOf(hi0), this.fracOf(Math.min(...pts.map(q => q.t)) - 0.02 / this.fps));
    return T0 - this.fracOf(lo) < PIN_FRAMES || hi - T0 < PIN_FRAMES ? null : { law, at };
  }

  /** LaunchCandidate from the winning chain (a streak chain at its centres when they hold the law, streakChain). */
  candidate(win, mode, club, margin) {
    const hyp = this.hyp, d0 = this.d0, st = mode === 'streak' ? this.streakChain(win) : null, law = st?.law ?? win.law;
    const samples = win.support.map((q, i) => {
      const dExp = law.dExp?.[i] ?? d0, z = Math.max(1e-3, q.z), at = st?.at[i] ?? q;
      return makeObservation({
        index: q.k, t: q.t, x: at.x, y: at.y, sigma: Math.max(0.15, 1.5 * (dExp / 2 + 0.7) / z), z, z1: mode === 'blob' ? q.z : null,
        d: q.w > 0 ? q.w : null, polarity: hyp.polarity, src: mode === 'streak' ? 'streak' : 'launch', flag: 'inlier'
      });
    }).sort((a, b) => a.t - b.t);
    const shrink = 1 + law.c * Math.max(...law.tau);
    const view = shrink >= 1.5 ? 'dtl' : shrink <= 1.15 ? 'fo' : 'oblique';
    const ct = club ? { points: club.points.map(p => ({ index: p.index, t: p.t, x: p.x, y: p.y, measured: p.measured, extent: p.extent })), impactVel: club.impactVel, dir: club.dir } : null;
    return makeLaunchCandidate({
      id: `${hyp.id}:L`, hypId: hyp.id, t0: Math.max(this.interval.t0, Math.min(law.t0, this.interval.t1, samples[0].t - 1e-6)), address: { ...this.A }, d0, dir: law.dir, v: law.v, c: law.c,
      polarity: hyp.polarity, samples, view, single: !!win.single, streak: mode === 'streak', clubTrack: ct, S: win.S, margin
    });
  }
}

function summary(e) {
  if (!e) return null;
  const law = e.law;
  return {
    pass: e.pass, fail: e.fail, mode: e.mode, S: +e.S.toFixed(3), m: e.m, inFrame: e.inFrame ?? null, single: !!e.single,
    dir: law ? [+law.dir.x.toFixed(4), +law.dir.y.toFixed(4)] : null, v: law ? +law.v.toFixed(3) : null, c: law ? +law.c.toFixed(4) : null, t0: law ? law.t0 : null,
    f: e.features ? Object.fromEntries(Object.entries(e.features).map(([k, v]) => [k, v === null ? null : +(+v).toFixed(4)])) : null,
    samples: e.support.map(q => [q.k, +q.x.toFixed(2), +q.y.toFixed(2), +(q.z ?? 0).toFixed(2), q.w ? +q.w.toFixed(2) : null])
  };
}
function clubSummary(c) {
  if (!c) return null;
  return { T: c.T, score: +c.score.toFixed(3), impactVel: [+c.impactVel.x.toFixed(2), +c.impactVel.y.toFixed(2)], dir: c.dir ? [+c.dir.x.toFixed(4), +c.dir.y.toFixed(4)] : null, measuredPost: c.measuredPost, points: c.points.map(p => [p.index, +p.x.toFixed(1), +p.y.toFixed(1), p.measured ? 1 : 0]) };
}

/**
 * Functional form: run a LaunchConfirmer over LaunchFrames {index, t, crop, sim} (or a crop source
 * (index, rect, pool) => LumaCrop) and return its LaunchDecision.
 */
export function confirmLaunch(hyp, frames, ctx) {
  const lc = new LaunchConfirmer(hyp, ctx), { from, to } = lc.window();
  const cam = ctx.log?.camera ?? null;
  if (typeof frames === 'function') {
    for (let k = from; k < to; k++) {
      const reqs = lc.roiRequests(k);
      lc.consume(k, ctx.meta.times[k], reqs.map(q => frames(k, q.rect, q.pool)), cam ? simAt(cam, k) : IDENTITY_SIM);
    }
  } else {
    for (const f of [...frames].sort((a, b) => a.index - b.index)) if (f.index >= from && f.index < to) lc.consume(f.index, f.t, f.crop ? [f.crop] : [], f.sim ?? IDENTITY_SIM);
  }
  return lc.finish();
}

/**
 * Null-launch scores for a decided winner (FINAL): fake anchors at ±anchorOffsetW·W (winner support removed) and
 * fake impacts fakeImpactFrames earlier. `lc` is a LaunchConfirmer that has consumed its window.
 */
export function nullLaunchScores(lc, winner) {
  const real = lc.impacts.find(i => i.name === 'real'), out = [];
  for (const a of lc.fakeAnchors) out.push(lc.search(real, a, { exclude: winner?.support ?? null }).bestS);
  for (const imp of lc.impacts) if (imp !== real) out.push(lc.search(imp, lc.A, {}).bestS);
  return out;
}
export { clubAt };
