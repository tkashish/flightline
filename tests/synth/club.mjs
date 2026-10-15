// Club specifications and the club's render primitives (grip, shaft, hosel, head, specular glints).
import { DEG, add, sub, addS, scale, dot, norm, cross, clamp } from './math.mjs';

// faceOff: head center to the face along the face normal; restY: head-center height at address; lie: shaft to sole line (deg);
// loft: face tilt back from the shaft-perpendicular face normal (deg), which the flat back plate of an iron shares.
export const CLUB_SPECS = {
  driver: { length: 1.143, plane: [44, 52], addrLie: [46, 53], headLen: 0.115, headDepth: 0.1, headH: 0.06, faceOff: 0.045, restY: 0.03, lie: 58, loft: 10.5, kind: 'wood', attack: [-1, 4], lean: [-1, 3], top: [250, 268] },
  iron7: { length: 0.94, plane: [50, 58], addrLie: [52, 58], headLen: 0.077, headDepth: 0.022, headH: 0.045, faceOff: 0.011, restY: 0.02, lie: 62, loft: 33, kind: 'iron', attack: [-6, -2], lean: [4, 10], top: [232, 252] },
  wedge: { length: 0.9, plane: [52, 60], addrLie: [54, 60], headLen: 0.08, headDepth: 0.026, headH: 0.052, faceOff: 0.013, restY: 0.023, lie: 64, loft: 47, kind: 'iron', attack: [-7, -3], lean: [4, 10], top: [222, 245] }
};

export function sampleClubLook(r, kind, { styleShift = false } = {}) {
  const shaft = r.chance(kind === 'wood' ? 0.8 : 0.3) ? 'graphite' : 'steel';
  const grip = r.pick([[30, 30, 32], [45, 45, 48], [20, 20, 22], [70, 70, 75], [35, 40, 60]]);
  if (kind === 'wood') {
    const crown = styleShift && r.chance(0.6) ? r.pick([[225, 225, 228], [190, 40, 40], [40, 70, 160]]) : r.pick([[28, 28, 32], [40, 40, 46], [22, 24, 30], [55, 55, 60]]);
    return { kind, shaft, grip, crown, sole: [150, 150, 158], gloss: r.range(0.3, 0.7), flashes: [] };
  }
  const finish = styleShift && r.chance(0.5) ? 'black' : 'chrome';
  // Chrome irons flash when a flattish region (back cavity, wide sole) mirrors the sun; n is (face, toe, up).
  const flashes = finish === 'chrome' ? [{ n: [-0.94, 0, 0.34], half: r.range(0.14, 0.22), size: r.range(0.024, 0.034), peak: 0.85, part: 'cavity' }] : [];
  if (finish === 'chrome' && r.chance(0.5)) flashes.push({ n: [-0.3, 0, -0.95], half: r.range(0.12, 0.2), size: r.range(0.02, 0.03), peak: 0.75, part: 'sole' });
  return { kind, shaft, grip, finish, metal: finish === 'black' ? [55, 55, 60] : r.pick([[170, 172, 178], [190, 192, 198], [150, 152, 160]]), gloss: finish === 'black' ? 0.35 : r.range(0.75, 1), flashes };
}

const SIG_CYL = 0.09, SIG_FLASH = 0.05;

/**
 * Club primitives at one instant. pose: { butt, grip, head, sh (unit, grip -> head), face, toe, up } in world space.
 * Irons are a blade (sole, back, topline, rounded toe). Glints: the analytic mirror point on the curved chrome
 * (topline, sole and hosel cylinders, toe sphere), plus flattish flash regions that light up ball-sized while
 * their normal mirrors the sun into the camera.
 */
export function clubPrims(pose, spec, look, light, camPos) {
  const out = [], { butt, head, sh, face, toe } = pose, up = pose.up || norm(cross(face, toe));
  const gripEnd = addS(butt, sh, 0.27), hosel = addS(head, toe, -spec.headLen * 0.5), shaftEnd = addS(hosel, sh, -0.03);
  const shaftCol = look.shaft === 'steel' ? [165, 168, 175] : [30, 30, 34], P = (f, t, u) => addS(addS(addS(head, face, f), toe, t), up, u);
  // Chrome (irons, steel shafts) mirrors its surroundings: sky above, turf below. Satin blurs the reflection.
  const chrome = look.kind !== 'wood' && look.finish !== 'black', env = chrome ? { refl: look.finish === 'satin' ? 0.38 : 0.56 + 0.06 * look.gloss, blur: look.finish === 'satin' ? 0.6 : 0.08 } : null;
  out.push({ a: butt, b: gripEnd, ra: 0.0125, rb: 0.0105, col: look.grip, spec: 0.05, tag: 'grip' });
  // A phone resolves the shaft as 2-6 px: a broad highlight (a narrow one turns into a comb under sub-sampled blur).
  out.push({ a: gripEnd, b: shaftEnd, ra: 0.0062, rb: 0.0045, col: shaftCol, ...(look.shaft === 'steel' ? { env: { refl: 0.5, blur: 0.15 } } : { spec: 0.25, shin: 12 }), tag: 'shaft' });
  out.push({ a: shaftEnd, b: hosel, ra: 0.0065, rb: 0.0075, col: look.kind === 'wood' ? look.crown : look.metal, ...(env ? { env } : { spec: 0.6, shin: 40 }), tag: 'hosel' });
  const hl = spec.headLen, mirrors = [];
  if (look.kind === 'wood') {
    // Crown slopes down toward the back of the head.
    const back = addS(addS(head, face, -0.035), up, -0.007);
    out.push({ a: addS(addS(head, toe, -hl * 0.32), face, -0.01), b: addS(addS(head, toe, hl * 0.32), face, -0.01), ra: 0.03, rb: 0.03, col: look.crown, spec: look.gloss, shin: 30, tag: 'head' });
    out.push({ a: addS(back, toe, -hl * 0.12), b: addS(back, toe, hl * 0.12), ra: 0.034, rb: 0.034, col: look.crown, spec: look.gloss, shin: 30, tag: 'head' });
    out.push({ a: addS(addS(head, toe, -hl * 0.36), face, 0.016), b: addS(addS(head, toe, hl * 0.38), face, 0.016), ra: 0.012, rb: 0.012, col: look.sole, spec: 0.8, shin: 50, tag: 'head' });
    mirrors.push({ sphere: P(-0.02, 0, -0.02), r: 0.05, axis: up, cosMin: 0.45, size: 0.012, peak: 0.45 });
  } else {
    const k = spec.headH / 0.045, m = look.metal, g = look.gloss, side = dot(face, sub(camPos, head)) >= 0 ? 1 : -1;
    // Black finish: one diffuse normal for the blade's visible side so its parts read as a single solid head. Chrome: the
    // flat back plate (parallel to the lofted face) mirrors what lies along its normal, mostly turf from behind at address;
    // the rounded top line, sole and toe mirror sky and turf by their own normals.
    const lo = spec.loft * DEG, plateN = scale(norm(addS(scale(face, Math.cos(lo)), up, Math.sin(lo))), side);
    const blade = env ? { col: m, env, tag: 'head' } : { col: m, spec: 0.35 * g, shin: 25, tag: 'head', flatN: norm(addS(scale(face, side), up, 0.35)) };
    const sole = { a: P(0, -0.42 * hl, -0.009 * k), b: P(0, 0.42 * hl, -0.009 * k), ra: 0.011 * k, rb: 0.011 * k };
    const top = { a: P(0.003, -0.46 * hl, 0.004 * k), b: P(0.002, 0.4 * hl, 0.017 * k), ra: 0.0048, rb: 0.0052 };
    out.push({ ...sole, ...blade });
    out.push({ a: P(-0.002, -0.38 * hl, 0.004 * k), b: P(-0.002, 0.39 * hl, 0.005 * k), ra: 0.0095 * k, rb: 0.01 * k, ...blade, ...(env ? { flatN: plateN } : {}) });
    out.push({ ...top, ...blade });
    out.push({ a: P(0, 0.4 * hl, 0.006 * k), b: P(0, 0.4 * hl, 0.006 * k), ra: 0.0125 * k, rb: 0.0125 * k, ...blade, sphere: true });
    if (look.finish === 'chrome') mirrors.push({ ...top, size: 0.012, peak: 0.65, upMin: -0.2 }, { a: shaftEnd, b: hosel, ra: 0.0072, size: 0.008, peak: 0.5 },
      { ...sole, size: 0.014, peak: 0.55, upMax: 0.3 }, { sphere: P(0, 0.4 * hl, 0.006 * k), r: 0.0125 * k, axis: norm(addS(toe, up, 0.4)), cosMin: 0.3, size: 0.009, peak: 0.4 });
  }
  if (!(light.sunI > 0.15 && light.sun[1] > 0)) return out;
  const sunK = Math.min(1, light.sunI / 1.2) * look.gloss * (look.kind === 'wood' ? 0.55 : 1), h = norm(add(norm(sub(camPos, head)), light.sun));
  const emit = (p, size, a) => { if (a > 0.02) out.push({ glint: true, p, size, a: Math.min(1, a), col: [255, 255, 252], tag: 'glint' }); };
  for (const mi of mirrors) {
    if (mi.sphere) { if (dot(h, mi.axis) >= mi.cosMin) emit(addS(mi.sphere, h, mi.r), mi.size, mi.peak * sunK); continue; }
    // Cylinder: the mirror normal is h minus its axial part; it exists while h lies within the roughness of the normal plane.
    const ax = norm(sub(mi.b, mi.a)), s = dot(h, ax), n = norm(addS(h, ax, -s)), un = dot(n, up);
    if ((mi.upMin != null && un < mi.upMin) || (mi.upMax != null && un > mi.upMax)) continue;
    const dev = Math.asin(Math.min(1, Math.abs(s))) / SIG_CYL;
    if (dev < 3) emit(addS(addS(mi.a, sub(mi.b, mi.a), 0.5 - 0.35 * clamp(s / 0.15, -1, 1)), n, mi.ra), mi.size, mi.peak * sunK * Math.exp(-0.5 * dev * dev));
  }
  // Flash regions: lit while h is within `half` of the region normal, at the head's support point for h.
  const af = spec.headDepth / 2, at = hl / 2, au = spec.headH / 2;
  for (const fl of look.flashes || []) {
    const n = norm(addS(addS(scale(face, fl.n[0]), toe, fl.n[1]), up, fl.n[2])), dev = Math.acos(clamp(dot(n, h), -1, 1)) - fl.half;
    const a = fl.peak * sunK * (dev <= 0 ? 1 : Math.exp(-0.5 * (dev / SIG_FLASH) ** 2)); if (a < 0.02) continue;
    const nf = dot(h, face), nt = dot(h, toe), nu = dot(h, up), q = Math.sqrt(af * af * nf * nf + at * at * nt * nt + au * au * nu * nu) || 1;
    // On the head at its support point for h, or on the hosel (a few centimetres from the ball).
    emit(fl.at === 'hosel' ? addS(addS(shaftEnd, sub(hosel, shaftEnd), 0.6), n, 0.0075) : P(af * af * nf / q, at * at * nt / q, au * au * nu / q), fl.size, a);
  }
  return out;
}

/** Local (face, toe, up) normal that mirrors the sun into the camera for a club pose: the flash-region normal that lights at that instant. */
export function mirrorNormal(pose, light, camPos) {
  const up = pose.up || norm(cross(pose.face, pose.toe)), h = norm(add(norm(sub(camPos, pose.head)), light.sun));
  return [dot(h, pose.face), dot(h, pose.toe), dot(h, up)];
}
