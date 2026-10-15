/**
 * Club head through impact (U3, D2 §3.3). Club evidence is local-CFAR box-DoG of |Y − B| at σ = 0.8·d0. The
 * arrival picks (c_{−1}, c_0) and optionally c_{−2} so the head ARRIVES at the address at the impact time with a
 * consistent speed (two pre-impact frames suffice, which matters in portrait face-on); the exit is the trailing
 * club-evidence body leaving the address after it (the ball always leads), followed by D2's damped, turning
 * tracker. Ball peaks inside the head's extent are club-explained; a ball must lead the head (outrun) and must not
 * ride on it (rigid attachment). Positions are stabilized native px; frame indices are absolute.
 */
import { PARAMS } from './params.js';
import { integral, boxDog, localCfar, robustSigma, findPeaks, dogRadii } from './emergence.js';

const DEG = Math.PI / 180;
// arrival miss allowed: the head's half-length plus the ball's radius (d0; a driver head is 2.7 d0 long) plus, per px
// of extrapolated distance, ARRIVAL_SLACK (image-path curvature, smeared peaks)
const ARRIVAL_D0 = 1.5, ARRIVAL_SLACK = 0.2;
// exit seed window (frames after impact), direction tolerance to an exit model (deg), mean speed vs it (ratio; down
// the line the head's image speed doubles past the V's apex)
const SEED_FRAMES = 6, SEED_DEG = 60, SEED_SPEED = [0.25, 3];
// seed confirmation: the next step's turn from the seed direction (deg) and its speed vs the seed's mean (ratio)
const SEED_TURN = 35, SEED_ACCEL = 2.5;
// a club peak with a peak this close (d0, at least 1.5 px) in an adjacent frame is static
const STILL_D0 = 0.25;
// universal lead: samples (frames with a measured head after impact) whose median ratio is tested (E2b: the first)
const LEAD_FRAMES = 1;
const LEAD_WINDOW = 1.5;   // frames after the impact time T in which the ball's lead over the head holds (E2b)
// arrivals given an exit search, and the exit evidence's cap in the arrival choice (z above minPeakZ)
const EXIT_TOP = 4, EXIT_CAP = 6;
// rigid attachment: offset spread (d0, or frac of the head's speed per frame) and reach from the head (d0)
const ATTACH_D0 = 0.5, ATTACH_SPEED = 0.25, ATTACH_NEAR_D0 = 2.5;

/**
 * Club evidence for one frame on a processing grid {w, h, p, bx, by}: peaks of local-CFAR box-DoG at σ = 0.8·d0 of
 * the unsigned residual |Y − B| against the impact's reference median. D2 used |Y_j − Y_{j−1}|, whose blobs sit
 * between consecutive head positions (and split into two for fast heads), which biases the chain kinematics; the
 * reference residual puts each peak on the head itself. A dark driver head counts as much as a chrome iron.
 * sc: {D: Float32Array(n), S, S2: Float64Array((w+1)(h+1)), dog, z: Float32Array(n)} scratch; hole {x, y, r} grid px.
 * @returns {{x:number, y:number, z:number}[]} stabilized native px
 */
export function clubEvidence(Y, B, grid, d0p, sc, params = PARAMS, hole = null) {
  const C = params.launch.club, E = params.launch.evidence, { w, h, p, bx, by } = grid;
  // The head is 1.1-2.7 d0 and its extent tolerance 0.85·d0, so the residual is pooled 2×2 when the club scale
  // stays >= 2.4 px there (4× less work).
  const q = C.sigmaD0 * d0p >= 6 ? 2 : 1, cw = Math.floor(w / q), ch = Math.floor(h / q), D = sc.D, inv = 1 / (q * q);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let acc = 0;
      for (let dy = 0; dy < q; dy++) { const o = (y * q + dy) * w + x * q; for (let dx = 0; dx < q; dx++) { const v = Y[o + dx] - B[o + dx]; acc += v < 0 ? -v : v; } }
      D[y * cw + x] = acc * inv;
    }
  }
  // after impact the vacated address differs from the reference most of all; through local CFAR it would hide the
  // head leaving it, so the hole disc is zeroed as in the ball residual
  if (hole) {
    const hx = hole.x / q, hy = hole.y / q, hr = hole.r / q, r2 = hr * hr;
    for (let y = Math.max(0, Math.floor(hy - hr)); y < Math.min(ch, Math.ceil(hy + hr)); y++) for (let x = Math.max(0, Math.floor(hx - hr)); x < Math.min(cw, Math.ceil(hx + hr)); x++) {
      if ((x + 0.5 - hx) ** 2 + (y + 0.5 - hy) ** 2 <= r2) D[y * cw + x] = 0;
    }
  }
  integral(D, cw, ch, sc.S);
  const s = Math.max(E.minSigmaPx, C.sigmaD0 * d0p / q), { a, b } = dogRadii(s);
  boxDog(sc.S, cw, ch, a, b, sc.dog);
  localCfar(sc.dog, cw, ch, Math.round(E.cfarInner[0] * s + E.cfarInner[1]), Math.round(E.cfarOuter[0] * s + E.cfarOuter[1]), robustSigma(sc.dog.subarray(0, cw * ch)), sc.S2, sc.z);
  return findPeaks(sc.z, cw, ch, { zMin: E.minPeakZ, nms: Math.max(1.5, E.nmsD0 * d0p / q), max: 2 * C.peaks })
    .map(r => ({ x: bx + p * q * r.x, y: by + p * q * r.y, z: r.z }));
}

const hyp2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Arc length of p(φ) = v·φ + ½·a·φ² over [0, ph] (8-step midpoint rule). */
const arcLength = (v, a, ph) => { let L = 0; for (let i = 0; i < 8; i++) { const t = (i + 0.5) * ph / 8; L += Math.hypot(v.x + a.x * t, v.y + a.y * t) * ph / 8; } return L; };
const angleBetween = (a, b) => { const c = (a.x * b.x + a.y * b.y) / ((Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) || 1); return Math.acos(Math.max(-1, Math.min(1, c))); };

/** Club-head extent at a track point: extentD0·d0 + extentPx, plus extentUnmeasured·distance when predicted. */
export function clubExtent(pt, anchor, d0, params = PARAMS) {
  const C = params.launch.club;
  return C.extentD0 * d0 + C.extentPx + (pt.measured ? 0 : C.extentUnmeasured * Math.hypot(pt.x - anchor.x, pt.y - anchor.y));
}

/**
 * Track the club head through impact.
 * Arrival: c_0 and c_{−1} (and optionally c_{−2}) on consecutive pre-impact frames, none of them static,
 * extrapolated (linearly, or as the quadratic through c_{−2}) to their closest approach to the address. The chain
 * arrives when that approach is within the head's size (ARRIVAL_D0, plus ARRIVAL_SLACK per px extrapolated) and
 * lands at T = kb + φ inside the impact range, with D2's speed consistency (|A − c_0|/φ over |c_0 − c_{−1}|, or
 * the quadratic's path length, within arrivalRatio). φ is solved continuously instead of D2's phase grid (with a
 * smeared head the grid picked the most speed-consistent phase, up to 0.7 frame late). A straight chain needs the
 * heading test (minCos); a curved one (down the line the image path is a V at the ball) needs c_{−2}.
 * Exit: see the seed rule below; of the best EXIT_TOP arrivals the one whose exit is found and strongest wins.
 * Then D2's forward tracker: damp, learn the turn, snap to the nearest club peak within max(snapD0·d0,
 * snapSpeedFrac·|v|) outside the address hole.
 * @param {{get:(k:number)=>({x,y,z}[]|undefined)}} peaksByFrame  club peaks per absolute frame index (a Map, or any
 *   object with get: the LaunchConfirmer passes a view whose frames up to the candidate impact frame skip the hole)
 * @param {{address:{x,y}, d0:number}} hyp
 * @param {{T:[number, number], kEnd:number, tOf:(k:number)=>number, kLast?:number, params?:object}} ctx  T: impact range
 *   (fractional frames); kLast: the last frame with the ball at the address
 * @returns {import('./types.js').ClubTrack & {anchor, T, score, measuredPost}} | null
 */
export function trackClub(peaksByFrame, hyp, ctx) {
  const params = ctx.params ?? PARAMS, C = params.launch.club, A = hyp.address, d0 = hyp.d0;
  const near = (q, r) => Math.hypot(q.x - A.x, q.y - A.y) < r, holeR = params.launch.evidence.holeD0 * d0;
  // before impact a residual at the address is the head covering the ball (slow heads down the line reach it at
  // the last pre-impact frame); after it the vacated address differs from the reference
  const kLast = ctx.kLast ?? Math.floor(ctx.T[1]) - 1;
  const pre = k => (peaksByFrame.get(k) ?? []).filter(q => k <= kLast || !near(q, 0.6 * d0)).slice(0, C.peaks);
  const ext0 = clubExtent({ x: A.x, y: A.y, measured: true }, A, d0, params), minStep = Math.min(C.minStepD0, params.launch.emergence.minStepD0) * d0;
  const zero = { x: 0, y: 0 }, stillR = Math.max(1.5, STILL_D0 * d0), arr0 = Math.max(ext0, ARRIVAL_D0 * d0);
  // a static residual (the golfer's changed pose, clutter) has a peak at the same place in an adjacent frame; three
  // of them can line up with the address
  const still = (q, k) => [k - 1, k + 1].some(j => (peaksByFrame.get(j) ?? []).some(p => Math.hypot(p.x - q.x, p.y - q.y) < stillR));
  // closest approach of p(φ) = c0 + v·φ + ½·a·φ² to A over φ in (lo, hi]
  const approach = (c0, v, a, lo, hi) => {
    let bestPhi = null, bestE = Infinity;
    for (let i = 1; i <= 40; i++) {
      const ph = lo + (hi - lo) * i / 40, x = c0.x + v.x * ph + 0.5 * a.x * ph * ph, y = c0.y + v.y * ph + 0.5 * a.y * ph * ph, e = Math.hypot(x - A.x, y - A.y);
      if (e < bestE) { bestE = e; bestPhi = ph; }
    }
    for (let it = 0, h = (hi - lo) / 80; it < 12; it++, h /= 2) for (const ph of [bestPhi - h, bestPhi + h]) {
      if (ph <= lo || ph > hi) continue;
      const x = c0.x + v.x * ph + 0.5 * a.x * ph * ph, y = c0.y + v.y * ph + 0.5 * a.y * ph * ph, e = Math.hypot(x - A.x, y - A.y);
      if (e < bestE) { bestE = e; bestPhi = ph; }
    }
    return { ph: bestPhi, e: bestE };
  };
  // c_0 is the last pre-impact frame (φ in (0, 1]); only when no chain qualifies may it be one frame earlier
  // (φ in (1, 2]: the head hid in the address zone at the last frame)
  const arrivals = [];
  for (const [lo, hi] of [[0, 1], [1, 2]]) {
    if (arrivals.length) break;
    for (let kb = Math.floor(ctx.T[0]) - 1; kb <= Math.floor(ctx.T[1]); kb++) {
      const P0 = pre(kb).filter(q => !still(q, kb)), P1 = pre(kb - 1).filter(q => !still(q, kb - 1)), P2 = pre(kb - 2);
      for (const c0 of P0) for (const c1 of P1) {
        const v1 = { x: c0.x - c1.x, y: c0.y - c1.y }, s1 = Math.hypot(v1.x, v1.y);
        if (s1 < minStep) continue;
        const straight = Math.cos(angleBetween(v1, { x: A.x - c0.x, y: A.y - c0.y })) >= C.minCos;
        // models: linear (straight arrivals) and, per consistent c_{-2}, the quadratic through c_{-2}, c_{-1}, c_0 (a
        // smooth 3-D arc has a continuous image velocity, so its image acceleration carries through impact: down
        // the line it turns the V); a straight arrival with c_{-2} keeps the linear model too, as three smeared
        // peaks can invent a deceleration
        const cands = straight ? [{ c2: null, a: zero, v: v1 }] : [];
        for (const q of P2) {
          const s2 = hyp2(c1, q);
          if (s2 < minStep || Math.cos(angleBetween({ x: c1.x - q.x, y: c1.y - q.y }, v1)) < C.prevMinCos) continue;
          if (straight && (s2 / s1 < C.prevRatio[0] || s2 / s1 > C.prevRatio[1])) continue;
          const a = { x: c0.x - 2 * c1.x + q.x, y: c0.y - 2 * c1.y + q.y };
          cands.push({ c2: q, a, v: { x: v1.x + a.x / 2, y: v1.y + a.y / 2 } });
          if (straight) cands.push({ c2: q, a: zero, v: v1 });
        }
        let pair = null;
        for (const cd of cands) {
          // searched one frame past hi: a head still short of the address at the latest admissible impact was faster
          // than its smeared peaks say, which the arrival ratio bounds; the miss allowed grows with the
          // extrapolated distance (path curvature and peak bias), ARRIVAL_SLACK of it
          const ap = approach(c0, cd.v, cd.a, lo, hi + 1), ph = Math.min(ap.ph, hi), T = kb + ph;
          if (ap.e > arr0 + ARRIVAL_SLACK * s1 * ph || T < ctx.T[0] - 1e-9 || T > ctx.T[1] + 1e-9) continue;
          // D2's speed consistency (|A − c_0|/φ over the last step); a quadratic arrival compares its path length to
          // the closest approach, over φ, with the mean of its two steps instead (at a down-the-line V's apex the
          // image speed swings by 4x between consecutive steps while the quadratic follows it)
          const ratio = cd.a === zero ? hyp2(A, c0) / ph / s1 : arcLength(cd.v, cd.a, ap.ph) / ph / (0.5 * (s1 + hyp2(c1, cd.c2)));
          if (ratio < C.arrivalRatio[0] || ratio > C.arrivalRatio[1]) continue;
          // D2's score with the weakest link instead of the mean of c_0 and c_1 (a glove plus a barely detected shaft
          // peak outscored the head), and c_{-2} counted by its own evidence (a flat +2 let a static residual in)
          const score = Math.min(c0.z, c1.z) + (cd.c2 ? Math.max(0, Math.min(2, cd.c2.z - params.launch.evidence.minPeakZ)) : 0) - 3 * Math.abs(Math.log(ratio)) - ap.e / d0;
          if (!pair || score > pair.score) pair = { score, kb, ph, T, c0, c1, c2: cd.c2, a: cd.a, v: cd.v, v1, straight };
        }
        if (pair) arrivals.push(pair);
      }
    }
  }
  if (!arrivals.length) return null;
  const sp = q => Math.hypot(q.x, q.y);
  // Forward tracker (D2): damp, rotate by the learned turn, snap to the nearest club peak within max(snapD0·d0,
  // snapSpeedFrac·|v|) outside the address hole (the vacated address differs from the reference too).
  const follow = (k0, x, y, vx, vy, kEnd) => {
    const out = [];
    let turn = 0, cx = x, cy = y, px = x, py = y, pMeas = true;
    for (let k = k0 + 1; k <= kEnd; k++) {
      const c = Math.cos(turn), sn = Math.sin(turn);
      [vx, vy] = [(vx * c - vy * sn) * C.damp, (vx * sn + vy * c) * C.damp];
      cx += vx; cy += vy;
      const rad = Math.max(C.snapD0 * d0, C.snapSpeedFrac * Math.hypot(vx, vy));
      let snap = null;
      for (const q of peaksByFrame.get(k) ?? []) {
        if (near(q, holeR)) continue;
        const e = Math.hypot(q.x - cx, q.y - cy);
        if (e <= rad && e < (snap?.e ?? Infinity)) snap = { ...q, e };
      }
      if (snap) {
        if (pMeas) {
          const nvx = snap.x - px, nvy = snap.y - py, ang = Math.atan2(vx * nvy - vy * nvx, vx * nvx + vy * nvy);
          turn = 0.5 * turn + 0.5 * Math.max(-0.6, Math.min(0.6, ang));
          vx = nvx; vy = nvy;
        }
        cx = snap.x; cy = snap.y;
      }
      out.push({ index: k, x: cx, y: cy, measured: !!snap });
      px = cx; py = cy; pMeas = !!snap;
    }
    return out;
  };
  // Exit seed. Two bodies leave the address and the ball always leads (E2b's universal lead), so the head is the
  // TRAILING club-evidence chain: seeds are club peaks in the first SEED_FRAMES post-impact frames outside the hole,
  // within SEED_DEG of an exit model (exitSpeedFrac × the arrival velocity: the winner's, the linear last step and
  // the quadratic one) and with an average speed since impact in SEED_SPEED × |u| and >= minStep (down the line
  // the head's image speed is lowest at the V's apex and doubles past it); a seed counts once the tracker confirms it,
  // moving on, in one of the next two frames; the slowest confirmed seed is the head. A lone body is taken as the
  // head (the invisible-ball control): a real ball whose club goes undetected abstains instead.
  const live = (q, k) => !near(q, holeR) && !still(q, k);
  const exitOf = arr => {
    const { kb, ph, a, v, v1, T } = arr;
    // exit models: the arrival's own, plus the linear (last step) and, with c_{-2}, the quadratic one within 2x of it
    const impactVel = { x: v.x + a.x * ph, y: v.y + a.y * ph }, models = [impactVel], alt = [v1];
    if (arr.c2) { const aq = { x: arr.c0.x - 2 * arr.c1.x + arr.c2.x, y: arr.c0.y - 2 * arr.c1.y + arr.c2.y }; alt.push({ x: v1.x + aq.x / 2 + aq.x * ph, y: v1.y + aq.y / 2 + aq.y * ph }); }
    for (const m of alt) if (sp(m) >= 0.5 * sp(v1) && sp(m) <= 2 * sp(v1) && models.every(o => hyp2(o, m) > 0.1 * sp(v1))) models.push(m);
    const U = models.map(m => ({ x: m.x * C.exitSpeedFrac, y: m.y * C.exitSpeedFrac }));
    let pick = null;
    for (let k1 = kb + 1; k1 <= Math.min(ctx.kEnd, kb + SEED_FRAMES); k1++) {
      const dt1 = k1 - T;
      if (dt1 <= 0) continue;
      for (const q of peaksByFrame.get(k1) ?? []) {
        if (!live(q, k1)) continue;
        const dx = q.x - A.x, dy = q.y - A.y, dq = Math.hypot(dx, dy), sAvg = dq / dt1;
        if (pick && sAvg >= pick.sAvg) continue;
        // a body this fast left the hole (radius + extent) at T + (holeR + ext0)/sAvg: first seen much later, it is
        // not one that left the address at T
        if (k1 > Math.ceil(T + (holeR + ext0) / Math.max(sAvg, 1e-6)) + 1) continue;
        if (sAvg < minStep || !U.some(u => sp(u) > 0 && angleBetween({ x: dx, y: dy }, u) <= SEED_DEG * DEG && sAvg >= SEED_SPEED[0] * sp(u) && sAvg <= SEED_SPEED[1] * sp(u))) continue;
        // confirmation: a live peak in one of the next two frames moving on along the seed's direction (within
        // SEED_TURN), farther from the address, at [0.5, SEED_ACCEL]× the seed's mean speed (past a V's apex the
        // head speeds up in the image), the one nearest that speed
        let conf = null;
        for (let k2 = k1 + 1; k2 <= Math.min(ctx.kEnd, k1 + 2) && !conf; k2++) for (const r of peaksByFrame.get(k2) ?? []) {
          if (!live(r, k2) || hyp2(r, A) <= dq) continue;
          const st = { x: (r.x - q.x) / (k2 - k1), y: (r.y - q.y) / (k2 - k1) }, ss = sp(st);
          if (ss < Math.max(minStep, 0.5 * sAvg) || ss > SEED_ACCEL * sAvg || angleBetween(st, { x: dx, y: dy }) > SEED_TURN * DEG) continue;
          const dev = Math.abs(Math.log(ss / sAvg));
          if (!conf || dev < conf.dev) conf = { r, k2, st, dev };
        }
        if (!conf && k1 < ctx.kEnd) continue;
        pick = { k1, q, sAvg, vx: dx / dt1, vy: dy / dt1, conf };
      }
    }
    return { impactVel, U, pick, z: pick ? Math.min(pick.q.z, pick.conf?.r.z ?? pick.q.z) : 0 };
  };
  // The head passes through impact: of the EXIT_TOP best arrivals the one with the best arrival score plus its exit
  // seed's evidence (weakest link, capped at EXIT_CAP above minPeakZ) wins; a hands-to-head link, say, arrives
  // with a strong z but has no exit.
  arrivals.sort((p, q) => q.score - p.score);
  let best = null, ex = null;
  for (const arr of arrivals.slice(0, EXIT_TOP)) {
    const e = exitOf(arr), total = arr.score + (e.pick ? Math.max(0, Math.min(EXIT_CAP, e.z - params.launch.evidence.minPeakZ)) : 0);
    if (!best || total > best.total) { best = { ...arr, total }; ex = e; }
  }
  const { kb, T } = best, { impactVel, U, pick } = ex;
  const points = [], tOf = ctx.tOf, ext = pt => clubExtent(pt, A, d0, params);
  for (const [k, c] of [[kb - 2, best.c2], [kb - 1, best.c1], [kb, best.c0]]) {
    if (!c) continue;
    const pt = { index: k, t: tOf(k), x: c.x, y: c.y, measured: true };
    points.push({ ...pt, extent: ext(pt) });
  }
  for (let k = kb + 1; k <= ctx.kEnd && (!pick || k < pick.k1); k++) {
    const u = pick ? { x: pick.vx, y: pick.vy } : U[0], pt = { index: k, t: tOf(k), x: A.x + u.x * (k - T), y: A.y + u.y * (k - T), measured: false };
    points.push({ ...pt, extent: ext(pt) });
  }
  if (pick) {
    const add = (k, x, y, measured) => { const pt = { index: k, t: tOf(k), x, y, measured }; points.push({ ...pt, extent: ext(pt) }); };
    add(pick.k1, pick.q.x, pick.q.y, true);
    let k0 = pick.k1, x0 = pick.q.x, y0 = pick.q.y, v0 = { x: pick.vx, y: pick.vy };
    if (pick.conf) {
      const { r, k2, st } = pick.conf;
      for (let k = pick.k1 + 1; k < k2; k++) add(k, pick.q.x + st.x * (k - pick.k1), pick.q.y + st.y * (k - pick.k1), false);
      add(k2, r.x, r.y, true);
      k0 = k2; x0 = r.x; y0 = r.y; v0 = st;
    }
    for (const p of follow(k0, x0, y0, v0.x, v0.y, ctx.kEnd)) add(p.index, p.x, p.y, p.measured);
  }
  const post = points.filter(q => q.index > kb && q.measured);
  let dir = null;
  if (post.length >= 2) {
    const dx = post[1].x - post[0].x, dy = post[1].y - post[0].y, L = Math.hypot(dx, dy);
    if (L > 1e-6) dir = { x: dx / L, y: dy / L };
  } else if (post.length === 1) {
    const dx = post[0].x - A.x, dy = post[0].y - A.y, L = Math.hypot(dx, dy);
    if (L > 1e-6) dir = { x: dx / L, y: dy / L };
  }
  return { points, impactVel, dir, anchor: { x: A.x, y: A.y }, T: best.T, score: best.score, measuredPost: post.length, straight: best.straight };
}

/** Club point of a track at a frame index, or null. */
export function clubAt(club, index) { return club?.points.find(q => q.index === index) ?? null; }

/** Is (x, y) at frame `index` inside the club head's extent (the extent-sized club-explained exclusion)? */
export function clubExplained(x, y, index, club, d0, params = PARAMS) {
  const pt = clubAt(club, index);
  if (!pt) return false;
  return Math.hypot(x - pt.x, y - pt.y) < (pt.extent ?? clubExtent(pt, club.anchor, d0, params));
}

/**
 * Outrun-the-club rule (D2, FINAL "the ball leads the club"). Universal lead first (below). With the head tracked
 * after impact: a chain moving
 * within outrunMaxDeg of the club's measured post-impact direction must have its first sample at least
 * outrunRatio × the club's distance from the address in the same frame. Without a measured post-impact head but
 * with the arrival chain: a chain within outrunMaxDeg of the arrival direction must be faster than outrunRatio ×
 * exitSpeedFrac × the arrival speed (D1's arrival continuation: the head keeps its line and slows to 0.65-0.8×;
 * the ball leaves at 1.1-1.5× it). chain: {dir, v (px/frame), samples:[{k|index, x, y}]}. True when it passes.
 */
export function outrunsClub(chain, club, params = PARAMS) {
  const C = params.launch.club;
  if (!club || !chain.samples.length) return true;
  const A = club.anchor;
  // E2b's universal lead: in every direction the ball is farther from the address than the head at the first
  // post-impact frame (ratio >= 1.14 down the line at p01, 0 of 2311 violations): the median over the first
  // LEAD_FRAMES samples whose frame has a measured head must reach outrunRatio. Only the first: two frames on, the
  // follow-through carries the head as far from the address in the image as a ball flying down the line.
  const ratios = [];
  for (const s of [...chain.samples].sort((a, b) => (a.index ?? a.k) - (b.index ?? b.k))) {
    const pt = clubAt(club, s.index ?? s.k);
    if (pt?.measured && pt.index > Math.floor(club.T) && pt.index - club.T <= LEAD_WINDOW && ratios.length < LEAD_FRAMES) ratios.push(Math.hypot(s.x - A.x, s.y - A.y) / Math.max(1e-6, Math.hypot(pt.x - A.x, pt.y - A.y)));
  }
  if (ratios.length) {
    ratios.sort((a, b) => a - b);
    const med = ratios.length % 2 ? ratios[ratios.length >> 1] : 0.5 * (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]);
    if (med < C.outrunRatio) return false;
  }
  if (club.dir) {
    if (angleBetween(chain.dir, club.dir) >= C.outrunMaxDeg * DEG) return true;
    const s = chain.samples[0], pt = clubAt(club, s.index ?? s.k);
    // the lead holds only at the first post-impact frames; a chain first seen later (the ball merged with the blurred
    // head for two frames) is not compared with a follow-through that has caught up
    if (!pt || (s.index ?? s.k) - club.T > LEAD_WINDOW) return true;
    return Math.hypot(s.x - A.x, s.y - A.y) >= C.outrunRatio * Math.hypot(pt.x - A.x, pt.y - A.y);
  }
  const vi = Math.hypot(club.impactVel.x, club.impactVel.y);
  if (!(vi > 0) || !(chain.v > 0) || angleBetween(chain.dir, club.impactVel) >= C.outrunMaxDeg * DEG) return true;
  return chain.v >= C.outrunRatio * C.exitSpeedFrac * vi;
}

/**
 * Rigid attachment: a ball-sized part of the club (the ferrule, the hosel, a toe glint) outside the head's extent
 * moves with the head, so its offset from the tracked head stays put, while a ball leaving the address separates
 * from it at >= 0.14 × the head's speed per frame (E2b's lead, collinear worst case). True when, over at least
 * three samples whose frame has a measured head after impact, the offsets' median deviation from their median is
 * below max(ATTACH_D0·d0, ATTACH_SPEED × the head's speed) px and the median offset is within ATTACH_NEAR_D0·d0.
 */
export function attachedToClub(samples, club, d0) {
  if (!club) return false;
  const off = [], pts = [];
  for (const s of [...samples].sort((a, b) => (a.index ?? a.k) - (b.index ?? b.k))) {
    const pt = clubAt(club, s.index ?? s.k);
    if (pt?.measured && pt.index > Math.floor(club.T)) { off.push({ x: s.x - pt.x, y: s.y - pt.y }); pts.push(pt); }
  }
  if (off.length < 3) return false;
  const med = a => { const b = [...a].sort((x, y) => x - y), n = b.length; return n % 2 ? b[n >> 1] : 0.5 * (b[n / 2 - 1] + b[n / 2]); };
  const mx = med(off.map(o => o.x)), my = med(off.map(o => o.y)), dev = med(off.map(o => Math.hypot(o.x - mx, o.y - my)));
  const span = pts[pts.length - 1].index - pts[0].index, speed = span > 0 ? hyp2(pts[pts.length - 1], pts[0]) / span : 0;
  return Math.hypot(mx, my) < ATTACH_NEAR_D0 * d0 && dev < Math.max(ATTACH_D0 * d0, ATTACH_SPEED * speed);
}

/**
 * Single-sample guards (D2 §3.3, off by default): z >= minZ, a measured club chain, d_ball/d_club in the same frame
 * within clubRatio, and the ball direction inside the loft cone [lo, hi] (deg) of the club's impact direction,
 * measured toward image-up.
 */
export function singleSampleOk(sample, club, params = PARAMS) {
  const S = params.launch.singleSample;
  if (!club || !(sample.z >= S.minZ)) return false;
  const pt = clubAt(club, sample.index ?? sample.k);
  if (!pt) return false;
  const A = club.anchor, dB = Math.hypot(sample.x - A.x, sample.y - A.y), dC = Math.max(1, Math.hypot(pt.x - A.x, pt.y - A.y));
  if (dB / dC < S.clubRatio[0] || dB / dC > S.clubRatio[1]) return false;
  const aC = Math.atan2(-club.impactVel.y, club.impactVel.x), aB = Math.atan2(-(sample.y - A.y), sample.x - A.x);
  let d = aB - aC;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const toward = (club.impactVel.x >= 0 ? d : -d) / DEG;  // + = rotating toward image-up
  return toward >= S.loftConeDeg[0] && toward <= S.loftConeDeg[1];
}
