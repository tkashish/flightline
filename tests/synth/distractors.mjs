// Moving and static confounders. World-space objects return capsules/spots per instant; lens-space objects
// (insects, dust specks) live in display pixel coordinates and ignore camera motion. An optional anchor
// { t, x, y, dir } puts the first object on the ball's projected path at time t (identity-steal tests).
import { DEG, clamp, add, sub, scale, addS, norm, cross, rotY, hash32, rngFor } from './math.mjs';
import { BALL } from './ball-physics.mjs';

/** Airliner at 3-12 km: constant 3-D velocity, optional strobe; tiny cross shape. */
export function makePlane(r, cam, tSpan, anchor = null) {
  const dist = r.range(3000, 12000), az = Math.atan2(cam.fw[0], cam.fw[2]) + r.range(-0.35, 0.35), el = r.range(4, 22) * DEG;
  const p0 = [cam.C[0] + dist * Math.cos(el) * Math.sin(az), cam.C[1] + dist * Math.sin(el), cam.C[2] + dist * Math.cos(el) * Math.cos(az)];
  const head = r.range(0, 2 * Math.PI), sp = r.range(140, 240), v = [sp * Math.sin(head), r.normal(0, 3), sp * Math.cos(head)];
  const mid = (tSpan[0] + tSpan[1]) / 2, high = anchor && anchor.dir[1] > 0.035, start = high ? addS(addS(cam.C, anchor.dir, dist), v, -anchor.t) : addS(p0, v, -mid);
  return { type: 'airplane', id: 'plane', size: r.range(30, 65), col: r.chance(0.6) ? [228, 230, 234] : [70, 72, 78], strobe: r.chance(0.5) ? { period: r.range(0.9, 1.5), on: 0.07, phase: r.range(0, 1) } : null, at: t => addS(start, v, t), v, anchored: !!high };
}
export function planePrims(p, t) {
  const c = p.at(t), d = norm(p.v), side = norm(cross(d, [0, 1, 0])), L = p.size, out = [];
  out.push({ a: addS(c, d, -L / 2), b: addS(c, d, L / 2), ra: L * 0.06, rb: L * 0.05, col: p.col });
  out.push({ a: addS(c, side, -L * 0.48), b: addS(c, side, L * 0.48), ra: L * 0.035, rb: L * 0.035, col: p.col });
  const blink = p.strobe && ((t / p.strobe.period + p.strobe.phase) % 1 + 1) % 1 < p.strobe.on / p.strobe.period;
  return { caps: out, light: blink ? { p: addS(c, side, -L * 0.48), col: [255, 250, 245] } : null };
}

/** Birds: erratic 3-D flight with flapping wings (dark crows or white gulls). */
export function makeBirds(r, cam, n, tSpan, anchor = null) {
  const birds = [];
  for (let i = 0; i < n; i++) {
    const br = rngFor(hash32(r.int(0, 1e9)), 'bird');
    let dist = br.range(12, 70);
    const az = Math.atan2(cam.fw[0], cam.fw[2]) + br.range(-0.45, 0.45), el = br.range(3, 28) * DEG;
    let p0 = [cam.C[0] + dist * Math.cos(el) * Math.sin(az), cam.C[1] + dist * Math.sin(el), cam.C[2] + dist * Math.cos(el) * Math.cos(az)];
    const sp = br.range(6, 14), hd = br.range(0, 2 * Math.PI), dt = 0.01, steps = Math.ceil((tSpan[1] - tSpan[0]) / dt) + 2;
    const pts = new Float32Array(steps * 3), v = [sp * Math.sin(hd), br.normal(0, 1), sp * Math.cos(hd)];
    let k0 = Math.floor(steps / 2), anchored = false;
    // The first bird crosses the ball's path at anchor.t (kept at least 1.5 m above the ground).
    if (i === 0 && anchor) { if (anchor.dir[1] < 0) dist = Math.min(dist, (cam.C[1] - 1.5) / -anchor.dir[1]); if (dist >= 6) { p0 = addS(cam.C, anchor.dir, dist); k0 = clamp(Math.round((anchor.t - tSpan[0]) / dt), 0, steps - 1); anchored = true; } }
    // integrate forward and backward from k0 so the bird is at p0 then
    const walk = (dir) => { let q = [...p0], w = [...v]; for (let k = k0; k >= 0 && k < steps; k += dir) { pts.set(q, k * 3); const a = [br.normal(0, 6), br.normal(0, 3), br.normal(0, 6)]; w = add(w, scale(a, dt)); const s = Math.hypot(...w); w = scale(w, clamp(s, sp * 0.6, sp * 1.4) / s); q = addS(q, w, dir * dt); } };
    walk(1); walk(-1);
    birds.push({ type: 'bird', id: `bird${i}`, span: br.range(0.35, 1.1), flap: br.range(3, 8), phase: br.range(0, 6.28), col: br.chance(0.75) ? [br.range(25, 45), br.range(25, 45), br.range(25, 50)] : [225, 225, 222], t0: tSpan[0], dt, steps, pts, anchored });
  }
  return birds;
}
export function birdAt(b, t) {
  const x = clamp((t - b.t0) / b.dt, 0, b.steps - 1.001), i = Math.floor(x), u = x - i, o = i * 3;
  return [b.pts[o] + (b.pts[o + 3] - b.pts[o]) * u, b.pts[o + 1] + (b.pts[o + 4] - b.pts[o + 1]) * u, b.pts[o + 2] + (b.pts[o + 5] - b.pts[o + 2]) * u];
}
export function birdPrims(b, t) {
  const c = birdAt(b, t), n = birdAt(b, t + 0.02), d = norm(sub(n, c)), side = norm(cross(d, [0, 1, 0])), up = cross(side, d);
  const fl = Math.sin(2 * Math.PI * b.flap * t + b.phase), wing = b.span / 2, tipL = addS(addS(c, side, wing * Math.cos(fl * 0.8)), up, wing * 0.7 * Math.sin(fl * 0.8)), tipR = addS(addS(c, side, -wing * Math.cos(fl * 0.8)), up, wing * 0.7 * Math.sin(fl * 0.8));
  return [{ a: addS(c, d, -b.span * 0.18), b: addS(c, d, b.span * 0.16), ra: b.span * 0.07, rb: b.span * 0.05, col: b.col },
    { a: c, b: tipL, ra: b.span * 0.05, rb: b.span * 0.02, col: b.col }, { a: c, b: tipR, ra: b.span * 0.05, rb: b.span * 0.02, col: b.col }];
}

/** Insects close to the lens: large, soft, semi-transparent blobs crossing quickly (display pixels). */
export function makeInsects(r, W, H, n, tSpan, anchor = null) {
  return Array.from({ length: n }, (_, i) => {
    let t0 = r.range(tSpan[0], tSpan[1] - 0.4), a = [r.range(0, W), r.range(0, H)];
    const dur = r.range(0.15, 0.6), ang = r.range(0, 2 * Math.PI), sp = r.range(1.2, 3.5) * Math.max(W, H), v = [Math.cos(ang) * sp, Math.sin(ang) * sp];
    if (i === 0 && anchor) { t0 = anchor.t - dur / 2; a = [anchor.x - v[0] * dur / 2, anchor.y - v[1] * dur / 2]; }
    return { type: 'insect', id: `insect${i}`, t0, dur, a, v, wob: r.range(20, 80), f: r.range(4, 12), rad: r.range(10, 45) * Math.max(W, H) / 1920, alpha: r.range(0.15, 0.45), col: [r.range(10, 50), r.range(10, 45), r.range(10, 40)], anchored: i === 0 && !!anchor };
  });
}
export function insectAt(it, t) {
  if (t < it.t0 || t > it.t0 + it.dur) return null;
  const u = t - it.t0; return { x: it.a[0] + it.v[0] * u + it.wob * Math.sin(2 * Math.PI * it.f * u), y: it.a[1] + it.v[1] * u + it.wob * Math.cos(2 * Math.PI * it.f * u * 0.7) };
}

/** Dust on the lens: fixed in display coordinates. */
export function makeSpecks(r, W, H, n, anchor = null) {
  const k = Math.max(W, H) / 1920;
  return Array.from({ length: n }, (_, i) => {
    const s = { x: r.range(0.05, 0.95) * W, y: r.range(0.03, 0.97) * H, rad: r.range(2, 12) * k, gain: r.chance(0.8) ? r.range(0.86, 0.97) : r.range(1.03, 1.08) };
    return i === 0 && anchor ? { ...s, x: clamp(anchor.x, 0, W - 1), y: clamp(anchor.y, 0, H - 1), anchored: true } : s;
  });
}

/** People walking 8-45 m away: simple gait. */
export function makeWalkers(r, n, cam) {
  return Array.from({ length: n }, (_, i) => {
    const dist = r.range(8, 45), az = Math.atan2(cam.fw[0], cam.fw[2]) + r.range(-0.4, 0.4), p0 = [cam.C[0] + dist * Math.sin(az), 0, cam.C[2] + dist * Math.cos(az)];
    const hd = r.range(0, 2 * Math.PI), sp = r.range(0.8, 1.5);
    return { type: 'person', id: `person${i}`, p0, v: [sp * Math.sin(hd), 0, sp * Math.cos(hd)], h: r.range(1.55, 1.9), shirt: r.pick([[200, 40, 40], [240, 240, 240], [40, 60, 140], [60, 60, 60], [230, 200, 60]]), pants: r.pick([[40, 40, 45], [120, 100, 80], [60, 70, 110]]), skin: r.pick([[230, 190, 160], [180, 130, 95], [110, 75, 50]]), f: sp * 0.9, ph: r.range(0, 6.28) };
  });
}
export function walkerPrims(w, t) {
  const c = addS(w.p0, w.v, t), d = norm(w.v), s = norm(cross(d, [0, 1, 0])), h = w.h, sw = Math.sin(2 * Math.PI * w.f * t + w.ph) * 0.35;
  const hip = add(c, [0, 0.52 * h, 0]), sh = add(c, [0, 0.8 * h, 0]), out = [];
  for (const k of [-1, 1]) {
    const hp = addS(hip, s, k * 0.09 * h), foot = addS(addS(c, s, k * 0.09 * h), d, k * sw * 0.45 * h);
    out.push({ a: hp, b: add(foot, [0, 0.05, 0]), ra: 0.07, rb: 0.05, col: w.pants });
    const sp = addS(sh, s, k * 0.17 * h), hand = addS(addS(sp, [0, -1, 0], 0.4 * h), d, -k * sw * 0.3 * h);
    out.push({ a: sp, b: hand, ra: 0.045, rb: 0.035, col: w.shirt });
  }
  out.push({ a: hip, b: sh, ra: 0.15, rb: 0.17, col: w.shirt }, { a: add(sh, [0, 0.13 * h, 0]), b: add(sh, [0, 0.13 * h, 0]), ra: 0.11, rb: 0.11, col: w.skin, sphere: true });
  return out;
}

/** Waving flag on a pole: a stack of thin capsules whose free ends ripple. */
export function flagPrims(fl, t) {
  const out = [{ a: [fl.x, 0, fl.z], b: [fl.x, fl.h, fl.z], ra: 0.03, rb: 0.025, col: [235, 235, 235] }], dir = rotY([0, 0, 1], fl.dir);
  for (let k = 0; k < 4; k++) {
    const y = fl.h - 0.08 - k * fl.fh / 4, seg = [];
    for (let j = 0; j <= 4; j++) { const u = j / 4, wave = Math.sin(2 * Math.PI * (fl.f * t - u * 1.3) + k * 0.4) * 0.12 * u * fl.fw; seg.push(add([fl.x, y, fl.z], add(scale(dir, u * fl.fw), rotY([wave, 0, 0], fl.dir)))); }
    for (let j = 0; j < 4; j++) out.push({ a: seg[j], b: seg[j + 1], ra: fl.fh / 8, rb: fl.fh / 8, col: fl.col });
  }
  return out;
}
export function makeFlags(r, n) {
  return Array.from({ length: n }, () => ({ x: r.range(-30, 30), z: r.range(30, 150), h: r.range(2, 3.2), fw: r.range(0.5, 0.9), fh: r.range(0.35, 0.55), f: r.range(0.8, 2.2), dir: r.range(-1, 1), col: r.pick([[220, 30, 30], [240, 210, 40], [245, 245, 245], [40, 90, 200]]) }));
}

/** Turf spray and a divot chunk launched at impact (iron shots from grass). */
export function makeDivot(r, ballStart, dirZ = 1) {
  const parts = Array.from({ length: r.int(8, 22) }, (_, i) => {
    const sp = r.range(3, 13), el = r.range(8, 45) * DEG, az = r.normal(0, 14) * DEG;
    return { id: `turf${i}`, p0: add(ballStart, [r.normal(0, 0.02), -0.01, r.range(0.02, 0.1)]), v0: [sp * Math.cos(el) * Math.sin(az), sp * Math.sin(el), dirZ * sp * Math.cos(el) * Math.cos(az)], size: r.range(0.008, 0.025), col: r.chance(0.6) ? [r.range(60, 90), r.range(100, 130), r.range(40, 60)] : [r.range(80, 110), r.range(60, 80), r.range(40, 55)], spin: r.range(5, 25) };
  });
  const sp = r.range(4, 9), el = r.range(10, 30) * DEG;
  parts.push({ id: 'divot', p0: add(ballStart, [0, -0.01, 0.08]), v0: [r.normal(0, 0.5), sp * Math.sin(el), dirZ * sp * Math.cos(el)], size: r.range(0.06, 0.11), col: [86, 102, 52], spin: r.range(6, 16), chunk: true });
  return parts;
}
/** Grass brushed up by a practice swing on turf at time t0: a few small blades and clods, slower than a divot. */
export function makeBrush(r, at, t0) {
  const parts = Array.from({ length: r.int(4, 12) }, (_, i) => {
    const sp = r.range(1.5, 6), el = r.range(10, 40) * DEG, az = r.normal(0, 18) * DEG;
    return { id: `brush${i}`, t0, p0: [at[0] + r.normal(0, 0.02), 0.004, at[2] + r.range(-0.02, 0.08)], v0: [sp * Math.cos(el) * Math.sin(az), sp * Math.sin(el), sp * Math.cos(el) * Math.cos(az)], size: r.range(0.006, 0.022), col: [r.range(60, 95), r.range(95, 130), r.range(40, 60)], spin: r.range(5, 25) };
  });
  if (r.chance(0.3)) { const sp = r.range(2, 5), el = r.range(10, 30) * DEG; parts.push({ id: 'brushclod', t0, p0: [at[0], 0, at[2] + 0.05], v0: [r.normal(0, 0.3), sp * Math.sin(el), sp * Math.cos(el)], size: r.range(0.025, 0.045), col: [86, 102, 52], spin: r.range(6, 16), chunk: true }); }
  return parts;
}
/** Simple ballistic object with quadratic drag that stops on the ground; launched at p.t0 (default 0, impact). */
export function particleAt(p, t, drag = 0.4) {
  t -= p.t0 || 0;
  if (t <= 0) return { pos: p.p0, landed: false };
  const k = drag / Math.max(0.01, p.size * 10), e = Math.exp(-k * t), vx = p.v0[0], vz = p.v0[2];
  const x = p.p0[0] + vx * (1 - e) / k, z = p.p0[2] + vz * (1 - e) / k;
  let y = p.p0[1] + (p.v0[1] + 9.81 / k) * (1 - e) / k - 9.81 * t / k;
  const landed = y < 0.004; if (landed) y = 0.004;
  return { pos: [x, y, z], landed };
}

export function makeTee(r, ball, flies, dirZ = 1) {
  const h = ball[1] - BALL.r, sp = r.range(3, 9), el = r.range(5, 28) * DEG;
  return { h, col: r.pick([[245, 245, 245], [240, 120, 30], [235, 205, 60], [190, 150, 100]]), flies, p0: [ball[0], h / 2, ball[2]], v0: [r.normal(0, 0.8), sp * Math.sin(el), dirZ * sp * Math.cos(el)], size: 0.012, spin: r.range(15, 35) };
}
// Tee shank radius at the ground and under the cup (a 4-5 mm shank tapering into the turf).
const TEE_R = [0.0017, 0.0024];
export function teePrims(tee, t, ballStart) {
  if (!tee.flies || t <= 0) return [{ a: [ballStart[0], 0, ballStart[2]], b: [ballStart[0], tee.h, ballStart[2]], ra: TEE_R[0], rb: TEE_R[1], col: tee.col }];
  const { pos, landed } = particleAt(tee, t, 0.25), ang = landed ? Math.PI / 2 : tee.spin * t, d = [Math.sin(ang) * 0.3, Math.cos(ang), Math.sin(ang)];
  const L = Math.max(0.03, tee.h + 0.012), dn = norm(d);
  return [{ a: addS(pos, dn, -L / 2), b: addS(pos, dn, L / 2), ra: TEE_R[0], rb: TEE_R[1] * 1.6, col: tee.col }];
}

/** Other balls: a few loose balls near the address and an optional pile/bucket. */
export function makeLooseBalls(r, hand, { multiball = false, pile = false }) {
  const out = [];
  if (multiball) for (let i = 0, n = r.int(1, 3); i < n; i++) out.push([hand * r.range(-0.75, -0.2), BALL.r, r.range(-0.7, -0.15) * (r.chance(0.5) ? 1 : -0.4)]);
  if (pile) { const cx = hand * r.range(-1.2, -0.6), cz = r.range(-0.9, -0.5); for (let i = 0, n = r.int(8, 30); i < n; i++) { const a = r.range(0, 6.283), d = Math.sqrt(r.next()) * 0.16; out.push([cx + d * Math.cos(a), BALL.r + (i > 12 ? BALL.d * r.range(0.4, 1) : 0), cz + d * Math.sin(a)]); } }
  return out;
}
