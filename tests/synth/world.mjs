// Builds every sampled, deterministic object of a clip from its scenario spec.
import { rngFor, add, sub, addS, norm, dot, dist, clamp } from './math.mjs';
import { BALL, sampleShot, sampleEnv, simulateFlight, ballAt } from './ball-physics.mjs';
import { intrinsics, makeView, placeCamera, cameraMotion, LENSES, axes, project, rayDir, rsOffset, aim } from './camera.mjs';
import { sampleGolfer, planGolfer, chainPractice, landmarks, golferPrims } from './golfer.mjs';
import { mirrorNormal } from './club.mjs';
import { sampleScene, envLight } from './scene.mjs';
import { makePlane, makeBirds, makeInsects, makeSpecks, makeWalkers, makeFlags, makeDivot, makeBrush, makeTee, makeLooseBalls } from './distractors.mjs';

export const TICKS = 90000;

export function buildTimeline(spec, tStart) {
  const c = spec.capture, fpsOut = c.slowmo ? 30 : c.fps, P = TICKS / fpsOut, N = Math.round(spec.durationOut * fpsOut), r = rngFor(spec.seed, 'timeline');
  const fx = v => +v.toFixed(6), vfr = c.vfr ? { a1: fx(r.range(0.04, 0.12) * P), w1: fx(r.range(1.7, 2.9)), p1: fx(r.range(0, 6.28)), a2: fx(r.range(0.02, 0.06) * P), w2: fx(r.range(0.05, 0.2)), p2: fx(r.range(0, 6.28)) } : null;
  const pick = n => r.shuffle(Array.from({ length: Math.max(0, N - 20) }, (_, i) => i + 10)).slice(0, n).sort((a, b) => a - b);
  const drops = c.drops ? pick(c.drops) : [], dups = c.dups ? pick(c.dups) : [];
  const J = k => (vfr ? Math.floor(k * P + vfr.a1 * Math.sin(k * vfr.w1 + vfr.p1) + vfr.a2 * Math.sin(k * vfr.w2 + vfr.p2)) - k * P : 0), J0 = J(0);
  const frames = [];
  for (let k = 0; k < N; k++) {
    const ticks = k * P + J(k) - J0 + P * drops.filter(d => k >= d).length;
    const tc = c.slowmo ? tStart + k / c.fps : tStart + ticks / TICKS;
    frames.push({ k, ticks, t: ticks / TICKS, tc, dupOf: null });
  }
  for (const d of dups) { frames[d].tc = frames[d - 1].tc; frames[d].dupOf = d - 1; }
  // Same arithmetic as the ffmpeg setpts expression below; ffprobe verifies the written PTS after encoding.
  const expr = `floor(N*${P}${vfr ? `+${vfr.a1}*sin(N*${vfr.w1}+${vfr.p1})+${vfr.a2}*sin(N*${vfr.w2}+${vfr.p2})` : ''})${J0 ? `-(${J0})` : ''}${drops.map(d => `+${P}*gte(N\\,${d})`).join('')}`;
  return { fpsOut, P, N, frames, expr, vfr: !!vfr, drops, dups, tau: c.slowmo ? c.fps / 30 : 1 };
}

// Sunny skies follow phone auto-exposure at base ISO (about 1/8000-1/1000 s); longExposure is the explicit confounder.
const EXPO = { blue: [1 / 8000, 1 / 1000], teal: [1 / 8000, 1 / 1000], violet: [1 / 6000, 1 / 800], haze: [1 / 5000, 1 / 700], overcast: [1 / 2000, 1 / 300], sunset: [1 / 1000, 1 / 150], dusk: [1 / 250, 1 / 50] };
export const SUNNY = new Set(['blue', 'teal', 'violet', 'haze', 'sunset']);

/** Closest approach of segments p0p1 and q0q1: distance and the parameter s along p. */
export function segDist(p0, p1, q0, q1) {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a < 1e-12) t = e < 1e-12 ? 0 : clamp(f / e, 0, 1);
  else {
    const c = dot(d1, r);
    if (e < 1e-12) s = clamp(-c / a, 0, 1);
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0; t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return { d: dist(addS(p0, d1, s), addS(q0, d2, t)), s };
}

/** A capsule is clear of the shot: not within 3 m of the lens while in view, and not between the camera and any target. */
export function clearOfShot(view, cap, targets) {
  const C = view.C, { a, b, r } = cap;
  if (segDist(C, C, a, b).d < 3) for (let i = 0; i <= 4; i++) { const q = project(view, addS(a, sub(b, a), i / 4)), m = r * (q.ppm || 0); if (q.z > 0 && q.x > -m && q.y > -m && q.x < view.W + m && q.y < view.H + m) return false; }
  return targets.every(T => { const o = segDist(C, T, a, b); return !(o.d < r + 0.06 && o.s < 0.97); });
}

/** Ball image samples under the base camera (in frame only), for anchoring distractors to the flight. */
function imagePath(flight, view, t0, t1, step = 1 / 120) {
  const out = [];
  for (let t = t0; t <= t1; t += step) { const q = project(view, ballAt(flight, t)); if (q.z > 0.5 && q.x >= 0 && q.y >= 0 && q.x < view.W && q.y < view.H) out.push({ t, x: q.x, y: q.y }); }
  return out;
}

export function buildWorld(spec) {
  const R = tag => rngFor(spec.seed, tag), cf = spec.confounders || {}, hand = spec.hand, easy = !!(spec.clean || spec.easy);
  const { W, H } = spec.format;
  const lr = R('lens'), lens = LENSES[spec.lens || 'main'], intr = intrinsics({ W, H, fovLongDeg: lr.range(...lens.fov), k1: lr.range(...lens.k1) });
  const tau = spec.capture.slowmo ? spec.capture.fps / 30 : 1, tStart = -spec.impactOut / tau;
  const timeline = buildTimeline(spec, tStart), tEnd = timeline.frames.at(-1).tc;
  // Ball, shot, flight.
  const shotClub = spec.club, swingClub = spec.club === 'topped' ? (spec.toppedWith || 'iron7') : spec.club;
  const br = R('ball'), teeOn = spec.tee !== 'none' && spec.tee != null;
  const ballY = teeOn ? BALL.r + (swingClub === 'driver' ? br.range(0.03, 0.05) : br.range(0.004, 0.012)) : spec.ground === 'grass' ? BALL.r - br.range(0, 0.004) : BALL.r;
  const hasBall = spec.kind !== 'practice-noball';
  const ballStart = [0, ballY, 0];
  // A nudged ball rolls back into its address from 3-8 cm in front, inside the clip: [tStart + 0.3, -0.4] s.
  const nudge = cf.nudge ? (() => { const dur = br.range(0.3, 0.6), lo = tStart + 0.3, hi = -0.4 - dur; return { t0: hi > lo ? br.range(lo, hi) : lo, dur, d: [hand * br.normal(0, 0.03), 0, br.range(0.03, 0.08)] }; })() : null;
  const shot = sampleShot(R('shot'), shotClub), env = sampleEnv(R('env'), { calm: spec.calm });
  const hit = spec.kind === 'hit';
  const flight = hit ? simulateFlight(shot, env, { start: ballStart, tEnd: Math.max(14, tEnd + 1) }) : null;
  const headSpeed = shot.speed / shot.smash;
  // Golfer and swing.
  const golfer = sampleGolfer(R('golfer'), { hand, white: !!cf.white, styleShift: spec.styleShift, plain: easy });
  let target = [...ballStart];
  if (spec.kind === 'whiff') target = [0, ballY + br.range(0.055, 0.08), 0];
  if (spec.kind === 'practice') target = [-hand * br.range(0.28, 0.5), BALL.r + 0.004, br.range(-0.12, 0.12)];
  if (spec.kind === 'practice-noball') target = [0, BALL.r + 0.004, 0];
  // Practice swing first (hit clips): a practice swing beside the ball, then the golfer steps in and hits; the practice
  // swing takes the place of the waggles. Practice swings with an iron on grass brush the turf at their low point.
  const pf = hit && !!cf.practiceFirst;
  let plan = planGolfer(R('swing'), golfer, { club: swingClub, kind: hit ? 'hit' : spec.kind === 'whiff' ? 'whiff' : 'practice', target, headSpeed, styleShift: spec.styleShift, waggles: pf ? 0 : spec.waggles });
  let practiceAt = spec.kind === 'practice' || spec.kind === 'practice-noball' ? { p: target, t: 0 } : null;
  if (pf) {
    const pr = R('practice-first'), pTarget = [-hand * pr.range(0.28, 0.5), BALL.r + 0.004, pr.range(-0.15, 0.1)];
    const P = planGolfer(R('practice-swing'), golfer, { club: swingClub, kind: 'practice', target: pTarget, headSpeed: headSpeed * pr.range(0.55, 0.85), styleShift: spec.styleShift, waggles: 0, relax: [pr.range(0.5, 0.8), pr.range(0.8, 1.2)] });
    plan = chainPractice(P, plan, pr, tStart + 0.25);
    practiceAt = { p: pTarget, t: plan.times.practice.tImpact };
  }
  if (easy && plan.look.kind === 'iron') Object.assign(plan.look, { finish: 'satin', gloss: 0.4, flashes: [] });
  // Camera: the golfer fits the frame at address (and at the practice address).
  const lm = landmarks(plan, plan.times.tPress - 0.2), lmP = pf ? landmarks(plan, plan.times.practice.tPress - 0.05) : null;
  const cr = R('camera');
  let place = placeCamera(cr, spec.view, { hand, ball: ballStart, feet: lm.feet, hands: lm.hands, fit: [...lm.fit, ballStart, ...(lmP ? lmP.fit : [])] }, intr, { styleShift: spec.styleShift, dist: easy ? [4, 6] : null });
  // Easy clips: if the golfer would hide the first 0.5 s of flight, slide the camera away from the golfer.
  for (let i = 0; easy && hit && i < 4; i++) {
    const C = place.C, hidden = [0.05, 0.12, 0.2, 0.3, 0.4, 0.5].some(t => { const pose = plan.poseAt(t), B = ballAt(flight, t); return golferPrims(pose, plan, { sun: [0, 1, 0], sunI: 0 }, C).some(p => { const o = segDist(C, B, p.a, p.b); return o.s < 0.98 && o.d < Math.max(p.ra, p.rb) + 0.03; }); });
    if (!hidden) break;
    const q = project(makeView(intr, C, place), ballStart), C2 = [C[0] + hand * 0.3, C[1], C[2]], a = aim(intr, C2, ballStart, q.x, q.y, place.roll);
    place = { ...place, C: C2, yaw: a.yaw, pitch: a.pitch };
  }
  const shakeLv = cf.shake ?? 0;
  const shake = shakeLv === 0 ? { sigmaDeg: easy || cr.chance(0.7) ? 0 : cr.range(0.005, 0.02), tauS: 1, tremorDeg: 0 } : shakeLv === 1 ? { sigmaDeg: cr.range(0.05, 0.15), tauS: cr.range(0.5, 2), tremorDeg: cr.range(0.008, 0.025) } : { sigmaDeg: cr.range(0.2, 0.5), tauS: cr.range(0.4, 1.5), tremorDeg: cr.range(0.025, 0.07) };
  let pan = null, zoom = null;
  if (cf.pan) { const v0 = hit ? norm(sub(ballAt(flight, 1), ballStart)) : [0, 0.3, 1], cam0 = axes(place.yaw, place.pitch, place.roll); pan = { t0: cr.range(0.1, 0.6), dur: cr.range(0.8, 2), dyaw: Math.sign(v0[0] * cam0.fw[2] - v0[2] * cam0.fw[0] || 1) * cr.range(1.5, 6), dpitch: cr.range(1, 6) }; }
  if (cf.zoom) zoom = { t0: cr.range(tStart + 0.2, 0.8), dur: cr.range(0.4, 1.4), factor: cr.range(1.12, 1.5) };
  const motion = cameraMotion(spec.seed, { yaw: place.yaw, pitch: place.pitch, roll: place.roll, shake, pan, zoom }, [tStart - 0.2, tEnd + 0.3]);
  const cam0 = makeView(intr, place.C, { yaw: place.yaw, pitch: place.pitch, roll: place.roll });
  // What scenery must not hide: the address ball, the golfer (8 landmarks and the pelvis), the early flight.
  const targets = [ballStart, ...lm.fit, lm.pelvis, ...(lmP ? [...lmP.fit, lmP.pelvis] : []), ...(hit ? [0.05, 0.15, 0.3, 0.5].map(t => ballAt(flight, t)) : [])];
  // Scene and light.
  const scene = sampleScene(R('scene'), { sky: spec.sky, ground: spec.ground, trees: spec.trees !== false, nets: !!cf.nets, poles: !!cf.poles, styleShift: spec.styleShift, camYaw: place.yaw, easy, hand });
  scene.light.env = envLight(scene);
  if (cf.occludePole && hit) {
    // A pole between the camera and the early flight (0.25-0.6 s), clear of the address ball.
    const pr = R('pole'), P = ballAt(flight, pr.range(0.25, 0.6)), C = place.C;
    for (let i = 0; i < 6; i++) {
      const u = pr.range(0.45, 0.75), q = add(C, [(P[0] - C[0]) * u, 0, (P[2] - C[2]) * u]), pole = { x: q[0], z: q[2], h: Math.max(P[1] * u + 2, 4), r: 0.05, col: [210, 210, 214] };
      if (clearOfShot(cam0, { a: [q[0], 0, q[2]], b: [q[0], pole.h, q[2]], r: 0.05 }, [ballStart]) || i === 5) { scene.nearPoles = [pole]; break; }
    }
  }
  // Sensor.
  const sr = R('sensor'), ex = easy ? [1 / 8000, 1 / 2000] : EXPO[spec.sky] || EXPO.blue, maxExp = 0.95 / spec.capture.fps;
  let exposure = Math.min(maxExp, Math.exp(sr.range(Math.log(ex[0]), Math.log(ex[1]))));
  if (cf.longExposure) exposure = Math.min(maxExp, sr.range(1 / 200, 1 / 60));
  const shifted = spec.styleShift && sr.chance(0.5);
  const sensor = {
    exposure,
    rs: cf.rs ? { readoutS: Math.min(0.9 / spec.capture.fps, sr.range(0.01, 0.033)), axis: H > W ? 'x' : 'y', dir: sr.sign() } : null,
    noise: { read: shifted ? sr.range(1.5, 3) : sr.range(0.4, 1.4), shot: shifted ? sr.range(2.5, 5) : sr.range(0.8, 2.4) * (spec.sky === 'dusk' ? 2 : 1), chroma: sr.range(0.15, 0.4), corr: sr.range(0.4, 1) },
    ae: cf.ae ? { amp: sr.range(0.08, 0.25) * sr.sign(), t0: sr.range(tStart, Math.max(tStart + 0.1, tEnd - 1)), dur: sr.range(0.3, 1.2), wob: sr.range(0.01, 0.04) } : { amp: 0, t0: 0, dur: 1, wob: sr.range(0, 0.01) },
    vignette: spec.lens === 'ultra' ? sr.range(0.2, 0.35) : sr.range(0.04, 0.2), wb: [sr.range(0.97, 1.03), 1, sr.range(0.97, 1.03)],
    knee: sr.range(200, 230), target: sr.range(110, 135), psf: sr.range(0.45, 0.75), sharpen: shifted ? sr.range(0.7, 1.1) : sr.range(0.2, 0.7)
  };
  scene.light.aa = Math.max(1, 2.5 * sensor.psf);
  // Chrome glint clips: a ball-sized flash on a frame within 0.1 s of impact where the flash point is in view (at the
  // head's own readout time), often a second one: mostly a persistent highlight on the hosel, lit while the club rests
  // at address (dimming through waggles) and gone once it turns at takeaway (BALL-01), else at another swing phase. Each
  // flash region's normal is fixed in the head frame.
  if (cf.glint && plan.look.kind === 'iron' && plan.look.finish !== 'satin') {
    const gr = R('glint'), look = plan.look, F = timeline.frames, C = place.C, light = scene.light;
    Object.assign(look, { finish: 'chrome', gloss: Math.max(look.gloss, 0.95) });
    const readout = k => {
      let t = F[k].tc;
      if (sensor.rs) for (let it = 0; it < 3; it++) { const q = project(makeView(intr, C, motion(t)), plan.poseAt(t).club.head); if (!Number.isFinite(q.x)) break; t = F[k].tc + rsOffset(sensor.rs, W, H, q.x, q.y); }
      return t;
    };
    // Where the flash would sit at t (the mirror normal fixes it), and whether the camera sees it past the body (3 cm margin).
    const inView = t => {
      const pose = plan.poseAt(t), saved = look.flashes; look.flashes = [{ n: mirrorNormal(pose.club, light, C), half: 0.1, size: BALL.d, peak: 1 }];
      const prims = golferPrims(pose, plan, light, C), P = prims.filter(p => p.glint).sort((a, b) => b.size - a.size)[0]?.p; look.flashes = saved;
      const q = P && project(makeView(intr, C, motion(t)), P);
      return !!q && q.z > 0 && q.x >= 0 && q.y >= 0 && q.x < W && q.y < H && !prims.some(p => { if (p.part !== 'body') return false; const o = segDist(C, P, p.a, p.b); return o.s < 0.98 && o.d < Math.max(p.ra, p.rb) + 0.03; });
    };
    const all = F.map((f, k) => k).filter(k => F[k].dupOf == null && Math.abs(F[k].tc) <= 0.1).map(k => ({ k, t: readout(k) })), seen = all.filter(c => inView(c.t)), cs = seen.length ? seen : all;
    // Weighted toward the frames nearest impact, where the flash sits beside the launching ball.
    const wts = cs.map(c => Math.exp(-Math.abs(F[c.k].tc) / 0.03)), tot = wts.reduce((x, y) => x + y, 0);
    let u = gr.next() * tot, pick = cs.at(-1); for (let i = 0; i < cs.length; i++) if ((u -= wts[i]) < 0) { pick = cs[i]; break; }
    const flash = t => ({ n: mirrorNormal(plan.poseAt(t).club, light, C), half: gr.range(0.1, 0.16), size: gr.range(0.75, 1.2) * BALL.d, peak: 1, part: 'flash', t: Math.round(t * 1e4) / 1e4 });
    if (pick) look.flashes = [flash(pick.t)];
    const still = plan.times.tPress - 0.1;
    if (still >= tStart + 0.2 && (cf.glint === 'address' || gr.chance(0.7))) look.flashes.push({ ...flash(still), half: gr.range(0.06, 0.1), size: gr.range(0.6, 1.1) * BALL.d, peak: 0.95, part: 'address', at: 'hosel' });
    else if (gr.chance(0.5)) look.flashes.push(flash(gr.pick([plan.times.tTakeaway + gr.range(0.1, 0.3), plan.times.tTop + gr.range(-0.05, 0.05), gr.range(0.15, 0.4)])));
  }
  // Distractors; a share anchored to the projected flight (near the apex or where it fades, or along the early flight).
  const dr = R('distractors'), path = hit ? imagePath(flight, cam0, 0.03, Math.min(tEnd, flight.landing?.t ?? tEnd)) : [], L = Math.max(W, H);
  const anchorAt = (late, jitter) => {
    if (!path.length || !dr.chance(0.6)) return null;
    const pt = late ? (dr.chance(0.5) ? path.reduce((a, b) => (b.y < a.y ? b : a)) : path.at(-1)) : dr.pick(path), x = pt.x + dr.normal(0, jitter * L), y = pt.y + dr.normal(0, jitter * L);
    return { t: pt.t, x, y, dir: rayDir(cam0, x, y) };
  };
  const D = {
    plane: cf.plane ? makePlane(dr, cam0, [tStart, tEnd], anchorAt(true, 0.006)) : null,
    birds: cf.birds ? makeBirds(dr, cam0, dr.int(1, 5), [tStart - 0.5, tEnd + 0.5], anchorAt(true, 0.008)) : [],
    insects: cf.insect ? makeInsects(dr, W, H, dr.int(1, 3), [tStart, tEnd], anchorAt(false, 0.01)) : [],
    specks: cf.specks ? makeSpecks(dr, W, H, dr.int(2, 7), anchorAt(false, 0.006)) : [],
    walkers: cf.people ? makeWalkers(dr, dr.int(1, 3), cam0) : [],
    flags: cf.flags ? makeFlags(dr, dr.int(1, 4)) : [],
    divot: [...(cf.divot && hit ? makeDivot(dr, ballStart) : []), ...(practiceAt && spec.ground === 'grass' && plan.look.kind === 'iron' && dr.chance(0.75) ? makeBrush(dr, practiceAt.p, practiceAt.t) : [])],
    tee: teeOn ? makeTee(dr, ballStart, spec.tee === 'flies' && hit) : null,
    loose: makeLooseBalls(dr, hand, { multiball: !!cf.multiball, pile: !!cf.pile }),
    netFront: cf.netFront ? { dist: dr.range(0.5, 1.6), cell: dr.range(0.025, 0.05), wire: dr.range(0.0015, 0.003), col: [dr.range(20, 60), dr.range(20, 60), dr.range(20, 60)], tilt: dr.range(-0.1, 0.1) } : null,
    bayPosts: []
  };
  if (cf.bay) {
    // Bay dividers on both sides; a post that would sit near the lens in view or hide the shot slides along its divider, else is dropped.
    for (const s of [-1, 1]) {
      const x = s * dr.range(1.6, 2.3) - hand * 0.4, h = dr.range(1.1, 2.4), r = dr.range(0.04, 0.08);
      for (let i = 0; i < 8; i++) { const z = i ? dr.range(-2.6, 0.8) : dr.range(-1.2, 0.2); if (clearOfShot(cam0, { a: [x, 0, z], b: [x, h, z], r }, targets)) { D.bayPosts.push({ x, z, h, r }); break; } }
    }
  }
  // Neighbor bay: a real ballistic object one bay over (two if one would crowd the camera or hide the shot), on the side
  // away from a face-on or oblique camera so that golfer stands behind ours; half the time timed to cross our ball early.
  let neighbor = null;
  if (cf.neighbor) {
    const nr = R('neighbor'), C = place.C, away = spec.view === 'face-on' || spec.view === 'oblique', side = away ? -(Math.sign(C[0]) || hand) : nr.sign();
    const nClub = nr.pick(['driver', 'iron7', 'wedge']), nHand = nr.chance(0.85) ? 1 : -1, nGolfer = sampleGolfer(nr, { hand: nHand });
    let spot = null;
    for (let i = 0; i < 8 && !spot; i++) {
      const nx = side * (i < 4 ? nr.range(3, 4.2) : nr.range(6, 8)), nz = nr.range(-0.6, 0.6), bx = nx - nHand * 0.8;
      const ok = clearOfShot(cam0, { a: [bx, 0.1, nz], b: [bx, 1.9, nz], r: 0.7 }, targets) && clearOfShot(cam0, { a: [nx, 0.2, nz], b: [bx, 1, nz], r: 0.4 }, targets);
      if (ok || i === 7) spot = { nx, nz, drawGolfer: ok };
    }
    const nStart = [spot.nx, nClub === 'driver' ? BALL.r + 0.03 : BALL.r, spot.nz], nEnv = { ...env };
    const shots = Array.from({ length: 4 }, () => sampleShot(nr, nClub)), cross = hit && cf.neighborT == null && nr.chance(0.5);
    let nShot = shots[0], tN = cf.neighborT ?? nr.range(tStart + 0.3, tEnd - 0.4), crossing = null;
    if (cross) {
      // Shot and timing that bring the neighbor ball closest to ours during our first 0.5 s of flight.
      const ours = imagePath(flight, cam0, 0.03, 0.5);
      for (const s of shots) {
        const theirs = imagePath(simulateFlight(s, nEnv, { start: nStart, tEnd: 2 }), cam0, 0.03, 1.8);
        for (const a of ours) for (const b of theirs) {
          const d = Math.hypot(a.x - b.x, a.y - b.y), t = a.t - b.t;
          if (t > tStart + 0.05 && t < tEnd - 0.3 && (!crossing || d < crossing.d)) crossing = { d, t, shot: s, at: a.t };
        }
      }
      if (crossing && crossing.d < 0.05 * L) { nShot = crossing.shot; tN = crossing.t; } else crossing = null;
    }
    const nFlight = simulateFlight(nShot, nEnv, { start: nStart, tEnd: Math.max(12, tEnd - tN + 1) });
    const nPlan = planGolfer(nr, nGolfer, { club: nClub, kind: 'hit', target: [0, nStart[1], 0], headSpeed: nShot.speed / nShot.smash });
    neighbor = { start: nStart, tImpact: tN, shot: nShot, flight: nFlight, golfer: nGolfer, plan: nPlan, offset: [spot.nx, 0, spot.nz], drawGolfer: spot.drawGolfer, crossing: crossing && { distPx: Math.round(crossing.d * 10) / 10, atS: Math.round(crossing.at * 1e3) / 1e3 } };
  }
  return { spec, intr, tStart, tEnd, timeline, ballStart, hasBall, nudge, shot: hit ? shot : null, swingShot: shot, env, flight, plan, golfer, place, motion, shake, pan, zoom, scene, sensor, D, neighbor, headSpeed, targets, practiceAt };
}
