/**
 * Impact hypotheses (U3; FINAL "Launch and club rejection", D3 §3.3, D1 §3.2-3.4). The coarse scan (U2) lists every
 * vacate with `valid` marking the ones that passed ITS tests: persistence, the NCC change test, the stable post
 * patch, the surround, the impulse profile, the gradual-departure veto, the time-limited occlusion recovery and the
 * duplicate test. findImpacts keeps the valid vacates of ball-like, long-dwelling spots and adds:
 *  - the arrival veto (a body part that arrived and paused is not an address ball, D1 §3.2), time-limited;
 *  - R1 last-to-leave, time-limited: within one address cluster the ball is the last stationary object to leave,
 *    but only vacates within max(30 frames, 1.5 s real) of each other compete (FINAL: every rule is time-limited);
 *  - pass-energy timing support and club-passage support (soft scores, D1 §3.3(2), D3 §3.3(4));
 *  - the impact interval (D1 §3.4) widened by the coarse scan's timing tolerance, the τ prior from the first step
 *    (D3 §3.5) and the swing envelope (D2 §6);
 *  - the cast-shadow rule (castShadows): a dark vacate that leaves together with a bright one in the same address
 *    cluster is the ball's shadow, never the ball (E5 follow-up: a shadow launch was drawn as 'tracked' at 0.98).
 * Hypotheses are ranked by vacate quality, never by size, and at most impact.maxHypotheses are kept.
 *
 * Protocol notes (E2 fix round, checker gaps 6 and 11; supersede the U2/U3 split described in protocol §7):
 *  - ONE owner for R1 and the arrival veto: this file. The coarse scan only measures (Spot.arrivalMovers, spot
 *    positions and diameters, VacateEvent.kLast); its `valid` no longer includes either rule, and Spot.clusterId
 *    (transitive) is report-only. One semantics, both time-limited with the τ prior (protocol §14.11):
 *      arrival veto: spot.arrivalMovers > 0 and k_last − firstIndex <= spanFrames(r1Window, fps, τ_a);
 *      R1: an earlier candidate a is superseded by a later candidate b when |a − b| <= clusterD·(d_a + d_b)/2
 *          (pairwise: a chain of spots does not make one cluster) and k_last(b) − k_last(a) is within
 *          [spanFrames(r1MinGap, fps), spanFrames(r1Window, fps, max(τ_w(a), τ_w(b)))].
 *    τ_w is the largest τ mode holding at least 20% of the vacate's τ prior (a longer window is the safer one).
 *    τ_a is τ_w when the container has a capture-rate hint and 1 without one: the step prior alone does not stretch
 *    the veto. A real-time clip whose first step is half hidden by the club reads as 240 fps, and an 8x arrival
 *    window then vetoes the real ball for good, while a window that is too short only lets a hypothesis through to
 *    the LaunchConfirmer.
 *  - Impact interval = [t(k_last − tol) − pad·Δ, t(k_firstAbsent + tol) + pad·Δ], tol = impact.timingTolFrames,
 *    pad = impact.intervalPadFrames. The coarse scan's k_last is early by 1-2 frames when the club head hides the ball
 *    just before impact and late by 1 when the head covers the vacated address just after it. The LaunchConfirmer
 *    searches t0 over exactly this interval, so an accepted t0 always lies inside it (protocol §5).
 */
import { PARAMS, spanFrames } from './params.js';
import { makeImpact } from './types.js';

const lerp = (a, b, u) => a + (b - a) * u;

/**
 * τ prior from the departure's first step (d0 per container frame), D3 §3.5 / E6: the step is a capture-rate
 * signature, so each mode τ (capture fps = fps·τ) is weighted by a log-normal likelihood around the E6 median for
 * that capture rate (log-log interpolated, extrapolated past 240 fps), mixed over both views when view is
 * 'unknown'. The prior favours real time (most clips). Without a usable step the prior alone is returned.
 * @param {number|null} step1D0
 * @param {'dtl'|'fo'|'unknown'} view
 * @param {object} [params]
 * @param {number} [fps] container frame rate (frames/s); default 30
 * @returns {import('./types.js').TauPrior}
 */
export function tauPriorFromStep(step1D0, view = 'unknown', params = PARAMS, fps = 30) {
  const T = params.impact.tau, modes = [...T.modes];
  const prior = modes.map((m, i) => (i === 0 ? 0.55 : 0.45 / Math.max(1, modes.length - 1)));
  const lc = T.captureFps.map(Math.log);
  const median = (table, cap) => {
    const x = Math.log(cap), ly = table.map(Math.log), n = lc.length;
    let i = 0;
    while (i < n - 2 && x > lc[i + 1]) i++;
    return Math.exp(lerp(ly[i], ly[i + 1], (x - lc[i]) / (lc[i + 1] - lc[i])));
  };
  let w = prior;
  if (Number.isFinite(step1D0) && step1D0 > 0) {
    const sig = 0.35, tables = view === 'dtl' ? [T.stepMediansDtlD0] : view === 'fo' ? [T.stepMediansFoD0] : [T.stepMediansDtlD0, T.stepMediansFoD0];
    w = modes.map((m, i) => prior[i] * tables.reduce((a, tb) => a + Math.exp(-0.5 * ((Math.log(step1D0) - Math.log(median(tb, fps * m))) / sig) ** 2), 0) / tables.length);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return { modes, weights: sum > 0 ? w.map(v => v / sum) : prior };
}

/** τ prior from container metadata (slow-motion capture rate), concentrated on the nearest mode. */
function tauPriorFromHint(captureFps, fps, params) {
  const modes = [...params.impact.tau.modes], tau = captureFps / fps;
  let best = 0;
  modes.forEach((m, i) => { if (Math.abs(Math.log(m / tau)) < Math.abs(Math.log(modes[best] / tau))) best = i; });
  return { modes, weights: modes.map((_, i) => (i === best ? 1 : 0)) };
}

/** The τ the time-limited rules use: the largest mode holding at least 20% of the prior (a longer window is safer). */
export const tauForWindows = prior => prior.modes.reduce((a, m, i) => (prior.weights[i] >= 0.2 ? Math.max(a, m) : a), 1);

/**
 * Impact interval (D1 §3.4) with the coarse scan's timing tolerance: [t(kLast − tol) − pad·Δ,
 * t(kFirstAbsent + tol) + pad·Δ] (video s), tol = impact.timingTolFrames, pad = impact.intervalPadFrames, Δ = 1/fps.
 * Frame times come from meta.times (VFR-safe), extrapolated by Δ outside the clip.
 * @param {import('./types.js').SourceMeta} meta
 * @returns {import('./types.js').Interval}
 */
export function impactInterval(meta, kLast, kFirstAbsent, params = PARAMS) {
  const I = params.impact, dt = 1 / meta.fps, times = meta.times, n = times?.length ?? 0, tol = I.timingTolFrames ?? 0;
  const tAt = k => (n ? (k < 0 ? times[0] + k * dt : k >= n ? times[n - 1] + (k - n + 1) * dt : times[k]) : k * dt);
  return { t0: tAt(kLast - tol) - I.intervalPadFrames * dt, t1: tAt(kFirstAbsent + tol) + I.intervalPadFrames * dt };
}

/**
 * Arrival veto (D1 §3.2), time-limited: same-looking movers approached the spot just before it first appeared
 * (arrivalMovers, counted by the coarse scan) and it left within r1Window of appearing (τ scales the real-second
 * part). A body part that arrived and paused.
 */
export function arrivalVetoes(arrivalMovers, dwellFrames, fps, params = PARAMS, tau = 1) {
  return arrivalMovers > 0 && dwellFrames <= spanFrames(params.impact.r1Window, fps, tau);
}

/**
 * R1 last-to-leave (D1 §3.3(4)), time-limited: within one address cluster only the LAST stationary object to leave
 * can be the ball. events: [{kLast, x, y, d, tauW?}] (stabilized native px; d diameter; tauW the window τ, default 1).
 * Event a is superseded by b when they lie within clusterD mean diameters of each other (pairwise: a chain of
 * spots does not make one cluster) and b left at least r1MinGap and at most r1Window (with max(τ_w)) after a.
 * Returns, per event, the index of the latest event superseding it, or -1.
 */
export function lastToLeave(events, fps, params = PARAMS) {
  const I = params.impact, cd = params.scan.spot.clusterD, gap = Math.max(1, spanFrames(I.r1MinGap, fps));
  return events.map(a => {
    let by = -1, k = -Infinity;
    events.forEach((b, j) => {
      if (b === a || !(Math.hypot(b.x - a.x, b.y - a.y) <= cd * (a.d + b.d) / 2)) return;
      const dk = b.kLast - a.kLast, win = spanFrames(I.r1Window, fps, Math.max(a.tauW ?? 1, b.tauW ?? 1));
      if (dk >= gap && dk <= win && b.kLast > k) { k = b.kLast; by = j; }
    });
    return by;
  });
}

/**
 * Cast-shadow rule (E5 follow-up of the P2b composition check), the co-timed complement of R1: a white ball on the
 * ground is brighter than its surround and its cast shadow darker, and the shadow leaves with the ball. So a DARK
 * vacate is superseded by a BRIGHT one that left within impact.timingTolFrames of it (the coarse scan's k_last
 * tolerance; simultaneous departures) and within clusterD mean diameters (R1's address cluster). Without a bright
 * co-timed neighbour a dark vacate stands (a dark spot alone may still be a ball, D3 §3.2: white mats).
 * events: [{kLast, x, y, d, polarity}]. Returns, per event, the index of the bright event superseding it, or -1.
 */
export function castShadows(events, params = PARAMS) {
  const cd = params.scan.spot.clusterD, tol = params.impact.timingTolFrames;
  return events.map(a => {
    if (!(a.polarity < 0)) return -1;
    let by = -1, best = Infinity;
    events.forEach((b, j) => {
      if (b === a || !(b.polarity > 0) || Math.abs(b.kLast - a.kLast) > tol) return;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist <= cd * (a.d + b.d) / 2 && dist < best) { best = dist; by = j; }
    });
    return by;
  });
}

/**
 * Swing envelope (D2 §6): union of coarse-scan motion over [t_v − preSec, t_v + postSec] around the address,
 * dilated by dilateD0·d0, on a stabilized grid of cells max(energy.cellPx, d0/2) px within 60·d0 of the address
 * (clipped to the frame). A cell is in when its disk was active (energy.active > 0) in any analyzed frame.
 * @returns {import('./types.js').SwingEnvelope|null}
 */
export function swingEnvelope(log, hyp, meta, params = PARAMS) {
  const E = params.impact.envelope, energy = log?.energy;
  if (!energy || typeof energy.active !== 'function') return null;
  const idx = log.frames?.index ?? [], t = log.frames?.t ?? [];
  const tv = hyp.tFirstAbsent ?? hyp.tLast, i0 = tv - E.preSec, i1 = tv + E.postSec, frames = [];
  for (let i = 0; i < idx.length; i++) if (t[i] >= i0 && t[i] <= i1) frames.push(idx[i]);
  if (!frames.length) return null;
  const cell = Math.max(energy.cellPx, hyp.d0 / 2), R = 60 * hyp.d0, W = meta.width, H = meta.height;
  const x0 = Math.max(0, Math.floor((hyp.address.x - R) / cell) * cell), y0 = Math.max(0, Math.floor((hyp.address.y - R) / cell) * cell);
  const w = Math.max(1, Math.ceil((Math.min(W, hyp.address.x + R) - x0) / cell)), h = Math.max(1, Math.ceil((Math.min(H, hyp.address.y + R) - y0) / cell));
  const raw = new Uint8Array(w * h);
  // frames outermost, so the energy store visits each frame's cells once; cells already in are skipped
  let left = w * h;
  for (const k of frames) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = j * w + i;
      if (raw[c] || !(energy.active(k, x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell, cell / 2) > 0)) continue;
      raw[c] = 1; left--;
    }
    if (!left) break;
  }
  const r = Math.max(1, Math.round(E.dilateD0 * hyp.d0 / cell)), mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!raw[j * w + i]) continue;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < w && b < h && di * di + dj * dj <= r * r) mask[b * w + a] = 1;
    }
  }
  return { x0, y0, cellPx: cell, w, h, mask };
}

/**
 * Pass-energy timing support (D1 §3.3(2)) and club passage (D3 §3.3(4)) around a vacate, from the coarse energy
 * store. passEnergy = 1 + log(peak/median) when the vacate lies within timingFrames (scan frames) of a strong
 * small-disk run, else 0. clubPassage = log(peak / baseline) of the annulus [0.6·d0, 8·d0] energy, peak searched in
 * [k_last − 3, k_last + 2], baseline = median over the previous second.
 */
function energyScores(log, spot, v, meta, params) {
  const energy = log?.energy, P = params.scan.energy, C = params.impact.clubPassage, fps = meta.fps, stride = Math.max(1, log?.stride ?? 1);
  if (!energy || typeof energy.disk !== 'function') return { passEnergy: 0, clubPassage: 0, support: false };
  const d0 = spot.d, H = meta.height;
  const rS = Math.max(P.smallDisk.d0 * d0, P.smallDisk.fracH * H);
  const i0 = Math.max(0, v.kLast - Math.ceil(C.baselineSec * fps) - 2 * stride), i1 = v.kLast + Math.ceil(0.5 * fps) + 2 * stride;
  const small = energy.disk(spot.x, spot.y, rS, i0, i1);
  let passEnergy = 0;
  if (small?.e?.length) {
    const e = Array.from(small.e), sorted = [...e].sort((a, b) => a - b), med = Math.max(1e-6, sorted[sorted.length >> 1]), mx = sorted[sorted.length - 1];
    const runThr = Math.max(P.runVsMedian * med, P.runVsMax * mx), strongThr = Math.max(P.strongVsMedian * med, P.strongVsMax * mx);
    for (let i = 0; i < e.length; i++) {
      if (e[i] <= runThr) continue;
      let j = i, pk = e[i];
      while (j + 1 < e.length && e[j + 1] > runThr) pk = Math.max(pk, e[++j]);
      const a = small.index[i], b = small.index[j];
      if (pk >= strongThr && v.kLast >= a - P.timingFrames * stride && v.kLast <= b + P.timingFrames * stride) passEnergy = Math.max(passEnergy, 1 + Math.log(pk / med));
      i = j;
    }
  }
  const outer = energy.disk(spot.x, spot.y, C.annulusD0[1] * d0, i0, i1), inner = energy.disk(spot.x, spot.y, C.annulusD0[0] * d0, i0, i1);
  let clubPassage = 0, support = false;
  if (outer?.e?.length && inner?.e?.length === outer.e.length) {
    const ann = Array.from(outer.e, (x, i) => Math.max(0, x - inner.e[i])), ix = outer.index;
    const base = ann.filter((_, i) => ix[i] < v.kLast - C.peakFrames[1] * stride && ix[i] >= v.kLast - C.baselineSec * fps).sort((a, b) => a - b);
    const baseline = Math.max(1e-6, base.length ? base[base.length >> 1] : 1e-6);
    let peak = 0;
    for (let i = 0; i < ann.length; i++) if (ix[i] >= v.kLast + C.peakFrames[0] * stride && ix[i] <= v.kLast + C.peakFrames[1] * stride) peak = Math.max(peak, ann[i]);
    if (peak > 0) { clubPassage = Math.log(peak / baseline); support = peak / baseline >= C.supportRatio; }
  }
  return { passEnergy, clubPassage, support };
}

/**
 * Valid vacates -> ranked ImpactHypothesis[] (≤ impact.maxHypotheses, by vacate quality, never size). [] means
 * no_launch. Positions are stabilized native px, as in the CoarseLog.
 * @param {import('./types.js').CoarseLog} log
 * @param {import('./types.js').SourceMeta} meta
 * @returns {import('./types.js').ImpactHypothesis[]}
 */
export function findImpacts(log, meta, { params = PARAMS } = {}) {
  const P = params, Sp = P.scan.spot, I = P.impact, fps = meta.fps, times = meta.times;
  const spots = new Map((log?.spots ?? []).map(s => [s.id, s]));
  const dwell = spanFrames(Sp.minDwell, fps);
  const cands = [];
  for (const v of log?.vacates ?? []) {
    const spot = spots.get(v.spotId);
    if (!v.valid || v.recovered || v.gradualDeparture || !spot) continue;
    if (!spot.ballLike || spot.presence < Sp.minPresence || spot.lastIndex - spot.firstIndex + 1 < dwell) continue;
    const tau = meta.captureFpsHint ? tauPriorFromHint(meta.captureFpsHint, fps, P) : tauPriorFromStep(v.impulse?.step1D0 ?? null, 'unknown', P, fps);
    const tauW = tauForWindows(tau);
    if (arrivalVetoes(spot.arrivalMovers, v.kLast - spot.firstIndex, fps, P, meta.captureFpsHint ? tauW : 1)) continue;
    cands.push({ v, spot, tau, tauW });
  }
  const ev = cands.map(c => ({ kLast: c.v.kLast, x: c.spot.x, y: c.spot.y, d: c.spot.d, tauW: c.tauW, polarity: c.spot.polarity }));
  const sup = lastToLeave(ev, fps, P), shadow = castShadows(ev, P);
  const out = [];
  cands.forEach(({ v, spot, tau }, ci) => {
    if (sup[ci] >= 0 || shadow[ci] >= 0) return;
    const dt = 1 / fps, en = energyScores(log, spot, v, meta, P);
    const tLast = v.tLast ?? times[v.kLast], tFA = v.tFirstAbsent ?? times[v.kFirstAbsent] ?? tLast + dt;
    const interval = impactInterval(meta, v.kLast, v.kFirstAbsent, P);
    const vacate = v.absenceRatio * Math.max(0, 1 - Math.max(0, v.ncc)) * Math.min(1, Math.max(0, v.postStable)) + (v.impulse?.ok ? 0.5 : 0) + 0.25 * Math.min(4, en.passEnergy) + (en.support ? 0.5 : 0);
    out.push({
      fields: {
        id: `imp:${v.spotId}:${v.kLast}`, spotId: v.spotId, address: { x: spot.x, y: spot.y }, d0: spot.d, polarity: spot.polarity,
        kLast: v.kLast, tLast, kFirstAbsent: v.kFirstAbsent, tFirstAbsent: tFA, interval, t0Est: Math.min(interval.t1, Math.max(interval.t0, (tLast + tFA) / 2)),
        scores: { vacate, passEnergy: en.passEnergy, clubPassage: en.clubPassage }, tauPrior: tau, envelope: null
      },
      quality: vacate
    });
  });
  out.sort((a, b) => b.quality - a.quality);
  return out.slice(0, I.maxHypotheses).map(o => {
    const h = makeImpact(o.fields);
    h.envelope = swingEnvelope(log, h, meta, P);
    return h;
  });
}
