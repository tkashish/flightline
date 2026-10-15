// Articulated golfer: appearance, body rotation schedule, and the coupled arm/club swing.
// The lead arm hangs straight from the moving lead shoulder; the club rotates in its swing plane.
// The stance is solved so the club face meets the back of the ball at t = 0 (head center a ball radius plus the
// face offset behind the ball along the path) with head speed `headSpeed`; the follow-through continues on the arc.
// pose.club.contact is the point on the face normal that passes through the ball center at t = 0.
import { DEG, clamp, smooth, hermite, add, sub, scale, addS, dot, cross, norm, len, rotAxis, rotY, mirrorX } from './math.mjs';
import { CLUB_SPECS, sampleClubLook, clubPrims } from './club.mjs';
import { BALL } from './ball-physics.mjs';

const SKIN = [[250, 220, 192], [238, 192, 158], [222, 170, 128], [196, 138, 98], [160, 106, 72], [122, 82, 56], [92, 62, 44]];
const SHIRT = { white: [242, 242, 244], black: [32, 32, 36], navy: [32, 42, 82], red: [182, 34, 44], royal: [42, 82, 182], sky: [132, 182, 230], gray: [142, 144, 150], green: [42, 122, 72], yellow: [236, 212, 72], pink: [236, 152, 182], orange: [236, 122, 42], purple: [112, 62, 142], teal: [42, 142, 142] };
const PANTS = { khaki: [190, 170, 130], black: [32, 32, 34], navy: [36, 42, 72], gray: [122, 124, 130], white: [236, 236, 238], charcoal: [62, 64, 68], olive: [102, 106, 72], tan: [172, 142, 102] };
const SHOES = { white: [244, 244, 246], black: [30, 30, 32], brown: [102, 66, 42], gray: [152, 152, 158] };
const CAPS = { white: [242, 242, 242], black: [32, 32, 36], navy: [36, 42, 82], red: [182, 34, 44], gray: [142, 144, 150], khaki: [190, 170, 130] };
const HAIR = [[30, 24, 20], [60, 42, 30], [110, 80, 50], [190, 160, 110], [150, 150, 150], [20, 20, 22]];

export function sampleGolfer(r, { hand = 1, white = false, styleShift = false, plain = false } = {}) {
  const shifted = styleShift && r.chance(0.6);
  const height = shifted ? (r.chance(0.5) ? r.range(1.48, 1.6) : r.range(1.92, 2.02)) : r.range(1.6, 1.92);
  const girth = styleShift && r.chance(0.5) ? (r.chance(0.5) ? r.range(0.82, 0.9) : r.range(1.25, 1.42)) : r.range(0.9, 1.25);
  const pick = obj => obj[r.pick(Object.keys(obj))];
  let shirt = white ? SHIRT.white : r.chance(0.18) ? SHIRT.white : pick(SHIRT);
  if (plain && shirt === SHIRT.white) shirt = SHIRT.navy;
  const pants = white && r.chance(0.5) ? PANTS.white : pick(PANTS);
  return {
    hand, height, girth,
    look: {
      skin: r.pick(SKIN), hair: r.pick(HAIR), shirt, pants,
      sleeves: r.chance(0.7) ? 'short' : 'long', shorts: r.chance(0.25),
      shoes: white || r.chance(0.45) ? SHOES.white : pick(SHOES),
      glove: white || r.chance(0.75) ? (r.chance(0.85) ? [246, 246, 246] : r.pick([[30, 30, 30], [200, 170, 120]])) : null,
      cap: r.chance(0.7) ? (white && r.chance(0.6) ? CAPS.white : pick(CAPS)) : null,
      belt: r.pick([[30, 30, 30], [90, 60, 40], [240, 240, 240]])
    }
  };
}

const seg = (t, t0, t1, v0, v1, m0 = 0, m1 = 0) => { const T = t1 - t0, s = clamp((t - t0) / T, 0, 1); return hermite(v0, m0 * T, v1, m1 * T, s); };
const expTo = (t, v0, v1, rate) => { const d = v1 - v0, tau = Math.abs(rate) > 1e-6 ? Math.max(0.05, Math.abs(d / rate)) : 0.3; return v0 + d * (1 - Math.exp(-t / tau)); };

function ik2(root, target, a, b, pole) {
  const d = sub(target, root), D = len(d), ax = scale(d, 1 / (D || 1));
  const Dc = clamp(D, Math.abs(a - b) + 1e-3, a + b - 1e-4), along = (a * a - b * b + Dc * Dc) / (2 * Dc), h = Math.sqrt(Math.max(0, a * a - along * along));
  const perp = norm(addS(pole, ax, -dot(pole, ax)));
  return add(add(root, scale(ax, along)), scale(perp, h));
}

/**
 * opts: { club, kind: 'hit'|'whiff'|'practice', target: [x,y,z] world ball center (or the virtual swing point),
 *         headSpeed, waggles?, teeHeight? }
 */
export function planGolfer(r, golfer, o) {
  const H = golfer.height, hs = H / 1.8, g = golfer.girth, hand = golfer.hand, spec = CLUB_SPECS[o.club];
  const dims = {
    ankleH: 0.075 * hs, thigh: 0.25 * H, shin: 0.23 * H - 0.035 * hs, hipW: 0.1 * H * g ** 0.3, torso: 0.3 * H, shW: 0.215 * H * g ** 0.25,
    upper: 0.172 * H, fore: 0.165 * H, neck: 0.045 * H, headR: 0.058 * H, footLen: 0.27 * hs
  };
  const armLen = dims.upper + dims.fore;
  // Timing (real seconds, impact at 0).
  let Tds = r.range(0.25, 0.3);
  const full = o.kind === 'practice' && r.chance(0.4) ? r.range(0.6, 0.85) : 1;
  const Tbs = r.range(0.75, 1.0) * (0.85 + 0.15 * full), tTop = () => -Tds;
  // Body schedule parameters (degrees; positive = open toward the target).
  const B = {
    tilt: r.range(33, 44), Ptop: r.range(38, 52) * full, Ttop: r.range(82, 100) * full, Pimp: r.range(28, 45), Timp: r.range(12, 30),
    Pfin: r.range(80, 95), Tfin: r.range(100, 122), wP: r.range(6, 9), wT: r.range(9, 13),
    shTop: -r.range(0.01, 0.035), shImp: r.range(0.05, 0.1), shFin: r.range(0.1, 0.17), lift: r.range(0.03, 0.07),
    sideA: r.range(4, 8), sideImp: r.range(10, 18), sideFin: r.range(4, 10), tiltFin: r.range(10, 18),
    stance: (spec.kind === 'wood' ? r.range(0.42, 0.55) : r.range(0.32, 0.45)) * hs, flareL: r.range(12, 28), flareT: r.range(0, 14),
    dxp: r.range(0.08, 0.15) * hs, flex: r.range(0.03, 0.07) * hs, heelFin: r.range(55, 78),
    tRelax: r.range(1.3, 2.4), Trelax: r.range(0.8, 1.2)
  };
  // A practice swing before the real one is let down soon after its finish.
  if (o.relax) [B.tRelax, B.Trelax] = o.relax;
  const tFin = 0.8;
  let tBs = -Tds - Tbs;
  const bodyAngles = t => {
    const tT = tTop(), tP = tT - 0.04, tB = tBs;
    let P, T, sh, lift = 0, tilt = B.tilt, side = B.sideA;
    if (t <= tB) { P = 0; T = 0; sh = 0; }
    else if (t <= tT) {
      P = t <= tP ? seg(t, tB + 0.08 * Tbs, tP, 0, -B.Ptop) : seg(t, tP, 0, -B.Ptop, B.Pimp, 0, B.wP / DEG);
      T = seg(t, tB, tT, 0, -B.Ttop); sh = seg(t, tB, tT, 0, B.shTop); side = seg(t, tB, tT, B.sideA, B.sideA - 3);
    } else if (t <= 0) {
      P = seg(t, tP, 0, -B.Ptop, B.Pimp, 0, B.wP / DEG); T = seg(t, tT, 0, -B.Ttop, B.Timp, 0, B.wT / DEG);
      sh = seg(t, tT - 0.03, 0, B.shTop, B.shImp, 0, 0.3); side = seg(t, tT, 0, B.sideA - 3, B.sideImp);
    } else {
      P = expTo(t, B.Pimp, B.Pfin, B.wP / DEG); T = expTo(t, B.Timp, B.Tfin, B.wT / DEG); sh = expTo(t, B.shImp, B.shFin, 0.3);
      lift = B.lift * smooth(t / 0.6); tilt = B.tilt + (B.tiltFin - B.tilt) * smooth(t / 0.55); side = B.sideImp + (-B.sideFin - B.sideImp) * smooth(t / 0.5);
      if (t > B.tRelax) { const k = smooth((t - B.tRelax) / B.Trelax); P += (B.Pfin * 0.8 - P) * k; T += (B.Tfin * 0.72 - T) * k; tilt += (8 - tilt) * k; side += (0 - side) * k; }
    }
    return { P, T, sh, lift, tilt, side };
  };
  // Body joints in the right-handed local frame, relative to the stance origin `S` (ground, between the ankles).
  const bodyRel = (t, S, hp) => {
    const a = bodyAngles(t), lean = t > 0 ? rotY([1, 0, 0], -a.P * DEG * smooth(t / 0.35)) : [1, 0, 0];
    const pc = add(S, [-B.dxp, hp + a.lift, a.sh]);
    const hipL = add(pc, rotY([0, -0.05 * hs, dims.hipW / 2], -a.P * DEG)), hipR = add(pc, rotY([0, -0.05 * hs, -dims.hipW / 2], -a.P * DEG));
    const ti = a.tilt * DEG, si = a.side * DEG, spine = norm([Math.sin(ti) * lean[0], Math.cos(ti), Math.sin(ti) * lean[2] - Math.sin(si) * 0.9]);
    const sc = addS(pc, spine, dims.torso);
    const shL = add(sc, rotAxis([0.03 * hs, 0, dims.shW / 2], spine, -a.T * DEG)), shR = add(sc, rotAxis([0.03 * hs, -0.02 * hs, -dims.shW / 2], spine, -a.T * DEG));
    return { a, pc, hipL, hipR, spine, sc, shL, shR };
  };
  // Club geometry at impact and address (local frame).
  const target = hand > 0 ? o.target : mirrorX(o.target);
  const path = r.normal(0, 2.2) * DEG, att = r.range(...spec.attack) * DEG, lean = r.range(...spec.lean) * DEG, psi = r.range(...spec.plane) * DEG;
  const et = [Math.sin(path) * Math.cos(att), Math.sin(att), Math.cos(path) * Math.cos(att)];
  const ed = norm(addS([Math.cos(psi), -Math.sin(psi), 0], et, -dot([Math.cos(psi), -Math.sin(psi), 0], et)));
  const uc = th => [Math.cos(th) * ed[0] - Math.sin(th) * et[0], Math.cos(th) * ed[1] - Math.sin(th) * et[1], Math.cos(th) * ed[2] - Math.sin(th) * et[2]];
  const lieC = spec.lie * DEG, back = BALL.r + spec.faceOff, Lc = spec.length - 0.08, hc0 = addS(target, et, -back), G0 = sub(hc0, scale(uc(lean), Lc));
  const restY = spec.restY, headAddr = [target[0], o.kind === 'whiff' ? restY : Math.min(restY, target[1]), target[2] - back - r.range(0.004, 0.02)];
  const laPref = r.range(...spec.addrLie) * DEG, zeta = (spec.kind === 'wood' ? r.range(-2, 2) : r.range(2, 8)) * DEG;
  const gripAt = la => addS(headAddr, norm([-Math.cos(la) * Math.cos(zeta), Math.sin(la), Math.cos(la) * Math.sin(zeta)]), Lc);
  const ballZ = spec.kind === 'wood' ? r.range(0.08, 0.16) * hs : r.range(-0.03, 0.06) * hs;
  const tAddr = tBs - 0.5;
  // Stance distance, pelvis height, address lie and spine tilt by regularized least squares: one straight
  // lead-arm length must reach the grip at address and at impact, with the shoulders over the hands.
  const Aw = r.range(0.95, 0.99) * armLen, hpStand = 0.48 * H + 0.09 * hs, hpPref = hpStand - B.flex, tilt0 = B.tilt;
  const resid = ([x, h, la, dt]) => {
    B.tilt = tilt0 + dt;
    const S = [x, 0, target[2] - ballZ], ra = bodyRel(tAddr, S, h), ri = bodyRel(0, S, h), Ga = gripAt(la);
    const out = [(len(sub(Ga, ra.shL)) - Aw) / 0.004, (len(sub(G0, ri.shL)) - Aw) / 0.004, (h - hpPref) / 0.03, (la - laPref) / (5 * DEG), (ra.shL[0] - Ga[0] + 0.03 * hs) / 0.04, dt / 4];
    B.tilt = tilt0;
    return out;
  };
  let X = [-0.85 * hs - (spec.kind === 'wood' ? 0.1 : 0), hpPref, laPref, 0], lam = 1e-2;
  const cost = v => v.reduce((a, b) => a + b * b, 0);
  for (let it = 0; it < 60; it++) {
    const f = resid(X), J = X.map((_, j) => { const e = j === 2 ? 1e-5 : j === 3 ? 1e-3 : 1e-5, Xp = X.slice(); Xp[j] += e; return resid(Xp).map((v, i) => (v - f[i]) / e); });
    const n = X.length, Mx = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? lam * (1 + J[a].reduce((s, v) => s + v * v, 0)) : 0)));
    const gv = Array.from({ length: n }, (_, a) => -J[a].reduce((s, v, i) => s + v * f[i], 0));
    for (let c = 0; c < n; c++) { let pv = c; for (let q2 = c + 1; q2 < n; q2++) if (Math.abs(Mx[q2][c]) > Math.abs(Mx[pv][c])) pv = q2; [Mx[c], Mx[pv]] = [Mx[pv], Mx[c]]; [gv[c], gv[pv]] = [gv[pv], gv[c]]; for (let q2 = c + 1; q2 < n; q2++) { const k = Mx[q2][c] / Mx[c][c]; for (let k2 = c; k2 < n; k2++) Mx[q2][k2] -= k * Mx[c][k2]; gv[q2] -= k * gv[c]; } }
    const dx = new Array(n).fill(0); for (let c = n - 1; c >= 0; c--) { let sum = gv[c]; for (let k2 = c + 1; k2 < n; k2++) sum -= Mx[c][k2] * dx[k2]; dx[c] = sum / Mx[c][c]; }
    const Xn = X.map((v, i) => v + dx[i]);
    if (cost(resid(Xn)) < cost(f)) { X = Xn; lam = Math.max(1e-6, lam / 3); if (Math.abs(cost(f) - cost(resid(Xn))) < 1e-9) break; } else lam *= 8;
  }
  let [sx, hp, la, dTilt] = X;
  B.tilt = tilt0 + dTilt; hp = Math.min(hp, hpStand - 0.005);
  const Gaddr = gripAt(la);
  const S = [sx, 0, target[2] - ballZ];
  const legReach = dims.thigh + dims.shin;
  const A = len(sub(G0, bodyRel(0, S, hp).shL));
  // Arm and club bases: anchored at address, blended to the impact-anchored bases during the downswing.
  const kappa = -r.range(25, 40) * DEG;
  const armBasis = (u0) => { const e = norm(addS(et, u0, -dot(et, u0))), e2 = rotAxis(e, u0, kappa); return ph => norm(addS(scale(u0, Math.cos(ph)), e2, -Math.sin(ph))); };
  const shLAddr = bodyRel(tAddr, S, hp).shL, uA0 = norm(sub(Gaddr, shLAddr)), uI0 = norm(sub(G0, bodyRel(0, S, hp).shL));
  const armA = armBasis(uA0), armI = armBasis(uI0);
  const GaddrR = addS(shLAddr, uA0, A), dA = norm(sub(headAddr, GaddrR));
  const thA = Math.atan2(-dot(dA, et), dot(dA, ed)), u0 = uc(thA), fixAx = cross(u0, dA), fixAng = Math.asin(clamp(len(fixAx), -1, 1));
  const fixRot = v => (fixAng > 1e-6 ? rotAxis(v, fixAx, fixAng) : v);
  const phiTop = r.range(2.2, 2.6) * full, thTop = r.range(...spec.top) * DEG * (0.55 + 0.45 * full), phiFin = -r.range(2.5, 3.0), thFin = -r.range(265, 305) * DEG;
  const dTh = thTop - lean;
  let p = r.range(1.2, 1.6), q = 2.6;
  const shVel = () => { const e = 1e-5, a = bodyRel(-e, S, hp).shL, b = bodyRel(e, S, hp).shL; return scale(sub(b, a), 1 / (2 * e)); };
  const sV = shVel(), eth = norm(rotAxis(norm(addS(et, uI0, -dot(et, uI0))), uI0, kappa)), wc = add(scale(ed, Math.sin(lean)), scale(et, Math.cos(lean)));
  const solveQ = T => {
    const base = addS(sV, eth, A * phiTop * p / T), b = dot(base, wc), c = dot(base, base) - o.headSpeed ** 2;
    const K = -b + Math.sqrt(Math.max(0, b * b - c)); return K * T / (Lc * dTh);
  };
  for (let i = 0; i < 60; i++) { q = solveQ(Tds); if (q < 1.8) Tds *= 1.02; else if (q > 3.6) Tds /= 1.02; else break; Tds = clamp(Tds, 0.2, 0.4); }
  tBs = -Tds - Tbs;
  const Tfp = r.range(0.12, 0.25), tFp = tBs - Tfp, dFp = r.range(0.03, 0.07), setStart = r.range(0.1, 0.35), setPow = r.range(0.8, 1.3);
  const wPhi = -phiTop * p / Tds, wTh = -dTh * q / Tds;
  const thRel = -r.range(0.5, 1.1), phiRel = -r.range(0.4, 0.9);
  const waggles = [];
  let tw = tFp - r.range(0.25, 0.6);
  for (let i = 0, n = o.waggles ?? r.weighted({ 0: 3, 1: 4, 2: 2 }); i < n; i++) {
    const T = r.range(0.45, 0.8); waggles.push({ t0: tw - T, T, aT: r.range(0.25, 0.5), aP: r.range(0.03, 0.08) }); tw -= T + r.range(0.15, 0.5);
  }
  const angles = t => {
    let phi, th;
    const tT = -Tds;
    if (t < tFp) {
      phi = 0; th = thA;
      for (const w of waggles) if (t > w.t0 && t < w.t0 + w.T) { const k = (1 - Math.cos(2 * Math.PI * (t - w.t0) / w.T)) / 2; phi += w.aP * k; th += w.aT * k; }
    } else if (t < tBs) { const k = smooth((t - tFp) / Tfp); phi = -dFp * k; th = thA; }
    else if (t < tT) {
      const s = (t - tBs) / Tbs; phi = -dFp + (phiTop + dFp) * smooth(s);
      th = thA + (thTop - thA) * (0.25 * smooth(s) + 0.75 * smooth(clamp((s - setStart) / (1 - setStart), 0, 1)) ** setPow);
    } else if (t <= 0) {
      const s = (t - tT) / Tds;
      phi = phiTop * (1 - ((3 - p) * s * s + (p - 2) * s * s * s)); th = lean + dTh * (1 - (3 - q) * s * s - (q - 2) * s * s * s);
    } else {
      phi = expTo(t, 0, phiFin, wPhi); th = expTo(t, lean, thFin, wTh);
      if (t > B.tRelax) { const k = smooth((t - B.tRelax) / B.Trelax); phi += (phiRel - phi) * k; th += (thRel - th) * k; }
    }
    return { phi, th };
  };
  const blendW = t => (t <= -Tds ? 0 : t >= 0 ? 1 : smooth((t + Tds) / (0.65 * Tds)));
  const faceRot = (t, phi) => (t <= 0 ? 1.15 * clamp(phi / phiTop, 0, 1) ** 0.7 : -1.4 * smooth(t / 0.35));
  const headCenterAddr = (() => { const b = bodyRel(tAddr, S, hp), nb = addS(b.sc, b.spine, dims.neck); return addS(nb, norm(addS(b.spine, [1, 0, 0], 0.55)), dims.headR * 1.25); })();
  const localPose = t => {
    const b = bodyRel(t, S, hp), { phi, th } = angles(t), w = blendW(t);
    const Aeff = t > 0 ? A * (1 - 0.18 * smooth(t / 0.6)) : A;
    const ua = norm(add(scale(armA(phi), 1 - w), scale(armI(phi), w))), grip = addS(b.shL, ua, Aeff);
    const ucl = norm(add(scale(fixRot(uc(th)), 1 - w), scale(uc(th), w))), head = addS(grip, ucl, Lc);
    // Heel -> toe along the sole line: the shaft turned by the club's lie angle about the face normal (toe away from the golfer).
    const sh = ucl, f0 = norm(addS(et, sh, -dot(et, sh))), face = rotAxis(f0, sh, faceRot(t, phi));
    const toe = norm(add(scale(sh, Math.cos(lieC)), scale(cross(face, sh), Math.sin(lieC)))), upv = norm(cross(face, toe));
    const trailHand = addS(grip, sh, 0.095), butt = addS(grip, sh, -0.06);
    // Legs and feet.
    const a = b.a, heel = t > 0 ? B.heelFin * smooth(t / 0.7) * DEG : 0;
    const ankL = add(S, [0, dims.ankleH, B.stance / 2]), toeDirL = rotY([1, 0, 0], -B.flareL * DEG);
    const toeDirT = rotY([1, 0, 0], (B.flareT - (t > 0 ? 35 * smooth(t / 0.6) : 0)) * DEG), ballT = add(add(S, [0, 0.02, -B.stance / 2]), scale(toeDirT, dims.footLen * 0.62));
    const ankT = add(ballT, add(scale(toeDirT, -dims.footLen * 0.62 * Math.cos(heel)), [0, (dims.ankleH - 0.02) + dims.footLen * 0.62 * Math.sin(heel), 0]));
    const kneeL = ik2(b.hipL, ankL, dims.thigh, dims.shin, add(toeDirL, [0, 0, 0.25])), kneeT = ik2(b.hipR, ankT, dims.thigh, dims.shin, add(toeDirT, [0, 0.1, -0.25]));
    const elbL = len(sub(grip, b.shL)) >= armLen * 0.995 ? addS(b.shL, norm(sub(grip, b.shL)), dims.upper) : ik2(b.shL, grip, dims.upper, dims.fore, [0.2, -1, 0.3]);
    const elbT = ik2(b.shR, trailHand, dims.upper, dims.fore, [-0.35, -1, -0.25]);
    // Neck and head: the head stays over the ball until just after impact, then turns toward the target.
    const nb = addS(b.sc, b.spine, dims.neck), kH = smooth((t - 0.05) / 0.45);
    const hcFollow = addS(nb, norm(addS(b.spine, [0.3, 0, 0.5], 0.4)), dims.headR * 1.2), hcStill = add(headCenterAddr, [0, 0, 0.3 * a.sh]);
    const hc = add(scale(hcStill, 1 - kH), scale(hcFollow, kH));
    const look0 = norm(sub(target, headCenterAddr)), look1 = norm([0.25, 0.15, 1]), kL = smooth((t - 0.08) / 0.45);
    return {
      pc: b.pc, hipL: b.hipL, hipR: b.hipR, kneeL, kneeT, ankL, ankT, toeL: addS(ankL, toeDirL, dims.footLen * 0.72), toeT: addS(ankT, norm(sub(ballT, ankT)), dims.footLen * 0.72 * (0.85 + 0.15 * Math.cos(heel))),
      heelL: addS(ankL, toeDirL, -dims.footLen * 0.22), heelT: addS(ankT, norm(sub(ballT, ankT)), -dims.footLen * 0.22),
      spine: b.spine, sc: b.sc, shL: b.shL, shR: b.shR, elbL, elbT, handL: grip, handT: trailHand, nb, hc, look: norm(add(scale(look0, 1 - kL), scale(look1, kL))),
      club: { butt, grip, head, sh, face, toe, up: upv }
    };
  };
  // Contact point: fixed in the head frame, through the ball center at t = 0.
  const c0 = localPose(0).club, d0 = sub(target, c0.head), cO = [dot(d0, c0.face), dot(d0, c0.toe), dot(d0, c0.up)];
  const withContact = t => { const p = localPose(t), c = p.club; c.contact = addS(addS(addS(c.head, c.face, cO[0]), c.toe, cO[1]), c.up, cO[2]); return p; };
  const M = v => (hand > 0 ? v : mirrorX(v));
  const poseAt = t => {
    const p = withContact(t), out = {};
    for (const [k, v] of Object.entries(p)) out[k] = k === 'club' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, M(vv)])) : M(v);
    return out;
  };
  const headVel = t => { const e = 1e-5, a = poseAt(t - e).club.head, b = poseAt(t + e).club.head; return scale(sub(b, a), 1 / (2 * e)); };
  return {
    golfer, dims, spec, club: o.club, kind: o.kind, look: sampleClubLook(r, spec.kind, o), poseAt, headVel,
    times: { waggles: waggles.map(w => +w.t0.toFixed(4)), waggleDur: waggles.map(w => +w.T.toFixed(4)), tPress: tFp, tTakeaway: tBs, tTop: -Tds, t0: 0, tFinish: tFin, tRelax: B.tRelax, tRelaxEnd: B.tRelax + B.Trelax },
    params: { armA: A, armLen, legReach, hp, stanceX: sx, addrLieDeg: la / DEG, tiltDeg: B.tilt, Lc, planeDeg: psi / DEG, pathDeg: path / DEG, attackDeg: att / DEG, leanDeg: lean / DEG, phiTop, thTopDeg: thTop / DEG, p, q, Tds, Tbs, headSpeed: o.headSpeed, full, contactBackM: back, addressGapM: target[2] - back - headAddr[2] }
  };
}

/**
 * Practice swing first: the practice plan P (beside the ball, its own impact at local time 0) is swung at real time tPI,
 * let down, and blended into the hit plan's still address (the golfer steps in) before its first pre-shot motion. The
 * practice takeaway is kept after tMin (inside the clip) by moving the routine toward the real swing.
 */
export function chainPractice(P, Hp, r, tMin) {
  const T = Hp.times, first = Math.min(T.tPress, ...T.waggles);
  let tB1 = first - r.range(0.25, 0.7), tB0 = tB1 - r.range(0.8, 1.2), tPI = tB0 - r.range(1.0, 1.5);
  const late = tMin - (tPI + P.times.tTakeaway);
  if (late > 0) { const k = Math.max(0.35, 1 - late / (first - tPI)); [tPI, tB0, tB1] = [tPI, tB0, tB1].map(t => first - (first - t) * k); }
  const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k], dirs = new Set(['spine', 'look', 'sh', 'face', 'toe', 'up']);
  const blend = (a, b, k) => Object.fromEntries(Object.keys(b).map(key => [key, key === 'club' ? blend(a.club, b.club, k) : dirs.has(key) ? norm(mix(a[key], b[key], k)) : mix(a[key], b[key], k)]));
  const poseAt = t => {
    if (t >= tB1) return Hp.poseAt(t);
    const a = P.poseAt(t - tPI); if (t <= tB0) return a;
    const p = blend(a, Hp.poseAt(tB1), smooth((t - tB0) / (tB1 - tB0))), c = p.club;
    // A rigid shaft: the head a club length from the grip along the blended shaft.
    c.sh = norm(sub(c.head, c.grip)); c.head = addS(c.grip, c.sh, Hp.params.Lc); c.butt = addS(c.grip, c.sh, -0.06);
    return p;
  };
  const headVel = t => { const e = 1e-5, a = poseAt(t - e).club.head, b = poseAt(t + e).club.head; return scale(sub(b, a), 1 / (2 * e)); };
  const pt = P.times, practice = { tImpact: tPI, tPress: tPI + pt.tPress, tTakeaway: tPI + pt.tTakeaway, tTop: tPI + pt.tTop, blendS: [tB0, tB1] };
  return { ...Hp, poseAt, headVel, practicePlan: P, times: { ...T, practice }, params: { ...Hp.params, practice: { full: P.params.full, headSpeed: P.params.headSpeed } } };
}

/** Render primitives (capsules/spheres) for one pose; 'fast' parts are motion-blur sub-sampled. */
export function golferPrims(pose, plan, light, camPos) {
  const { look } = plan.golfer, d = plan.dims, hs = plan.golfer.height / 1.8, g = plan.golfer.girth, out = [];
  const cap = (a, b, ra, rb, col, part, extra = {}) => out.push({ a, b, ra, rb, col, part, ...extra });
  const shin = look.shorts ? look.skin : look.pants;
  cap(pose.heelL, pose.toeL, 0.042 * hs, 0.045 * hs, look.shoes, 'body'); cap(pose.heelT, pose.toeT, 0.042 * hs, 0.045 * hs, look.shoes, 'body');
  cap(pose.ankL, pose.kneeL, 0.042 * hs * g, 0.054 * hs * g, shin, 'body'); cap(pose.ankT, pose.kneeT, 0.042 * hs * g, 0.054 * hs * g, shin, 'body');
  const kneeTop = (k, h) => (look.shorts ? addS(k, norm(sub(h, k)), 0.05) : k);
  cap(kneeTop(pose.kneeL, pose.hipL), pose.hipL, 0.06 * hs * g, 0.085 * hs * g, look.pants, 'body'); cap(kneeTop(pose.kneeT, pose.hipR), pose.hipR, 0.06 * hs * g, 0.085 * hs * g, look.pants, 'body');
  cap(pose.hipL, pose.hipR, 0.1 * hs * g, 0.1 * hs * g, look.pants, 'body');
  const waist = addS(pose.pc, pose.spine, 0.07 * hs), chest = addS(pose.sc, pose.spine, -0.09 * hs);
  cap(addS(pose.pc, pose.spine, 0.11 * hs), addS(pose.pc, pose.spine, 0.11 * hs), 0.118 * hs * g, 0.118 * hs * g, look.belt, 'body');
  cap(waist, chest, 0.125 * hs * g, 0.15 * hs * g, look.shirt, 'body');
  cap(pose.shL, pose.shR, 0.066 * hs * g, 0.066 * hs * g, look.shirt, 'body');
  cap(pose.nb, addS(pose.nb, norm(sub(pose.hc, pose.nb)), 0.06 * hs), 0.05 * hs, 0.048 * hs, look.skin, 'body');
  cap(pose.hc, pose.hc, d.headR, d.headR, look.skin, 'body', { sphere: true });
  if (look.cap) {
    cap(addS(pose.hc, pose.spine, 0.018 * hs), addS(pose.hc, pose.spine, 0.018 * hs), d.headR * 1.04, d.headR * 1.04, look.cap, 'body', { sphere: true, capTop: pose.spine });
    const fwd = norm(addS(pose.look, pose.spine, -dot(pose.look, pose.spine)));
    cap(addS(addS(pose.hc, pose.spine, 0.01), fwd, d.headR * 0.85), addS(addS(pose.hc, pose.spine, 0.004), fwd, d.headR * 1.55), 0.014 * hs, 0.011 * hs, look.cap, 'body');
  } else cap(addS(pose.hc, pose.spine, 0.02 * hs), addS(pose.hc, pose.spine, 0.02 * hs), d.headR * 0.98, d.headR * 0.98, look.hair, 'body', { sphere: true, capTop: pose.spine });
  const sleeve = (s, e) => (look.sleeves === 'long' ? e : addS(s, norm(sub(e, s)), d.upper * 0.55));
  for (const [s, e, h, lead] of [[pose.shL, pose.elbL, pose.handL, true], [pose.shR, pose.elbT, pose.handT, false]]) {
    const se = sleeve(s, e);
    cap(s, se, 0.05 * hs * g, 0.045 * hs * g, look.shirt, 'body');
    if (look.sleeves !== 'long') cap(se, e, 0.04 * hs * g, 0.037 * hs * g, look.skin, 'body');
    cap(e, h, 0.037 * hs * g, 0.028 * hs, look.sleeves === 'long' ? look.shirt : look.skin, 'fast');
    cap(h, h, 0.042 * hs, 0.042 * hs, lead && look.glove ? look.glove : look.skin, 'fast', { sphere: true });
  }
  for (const c of clubPrims(pose.club, plan.spec, plan.look, light, camPos)) out.push({ ...c, part: 'fast' });
  return out;
}

export function landmarks(plan, t) {
  const p = plan.poseAt(t), top = add(p.hc, [0, plan.dims.headR * 1.4, 0]);
  return { feet: scale(add(p.ankL, p.ankT), 0.5), hands: p.handL, head: p.hc, pelvis: p.pc, fit: [p.toeL, p.toeT, p.heelL, p.heelT, top, p.handL, p.shL, p.shR] };
}
