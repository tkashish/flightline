/**
 * Independent ground-truth golf-flight simulator for the U5 tests. It never imports dist/hf/flight-model.js, and
 * its physics is deliberately richer than M3D: spin-dependent C_D and C_L (D3 §9.1), exponential spin decay,
 * gusting wind with a height profile, a landing zone that rises or falls (terrain), and a phone camera placed and
 * aimed like real clips (pitch often negative), with radial distortion, slow motion and iPhone-style speed ramps.
 * Positions are display px with pixel centres at +0.5 (protocol doc §4), times are video seconds.
 */
import { makeObservation, makeLaunchCandidate, makeSourceMeta, identityTrack } from '../../../dist/hf/types.js';
import { PARAMS } from '../../../dist/hf/params.js';

export const BALL = { m: 0.04593, d: 0.04267, r: 0.021335 };
const DEG = Math.PI / 180, G = 9.81;

/** Seeded xorshift32 with uniform, range and Gaussian draws. */
export function rng(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  next.range = (a, b) => a + (b - a) * next();
  next.gauss = () => { let u = 0; while (!u) u = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); };
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

export const CLUBS = {
  driver: { speed: [60, 72], launch: [9, 13], spin: [2100, 2900] },
  iron7: { speed: [46, 55], launch: [15, 20], spin: [5800, 7400] },
  wedge: { speed: [35, 43], launch: [24, 32], spin: [7800, 9800] }
};

/** A random shot: curve > 0 bends right of the start line (fade/slice for a right-hander). */
export function randomShot(r, club = null) {
  const names = Object.keys(CLUBS), name = club ?? names[Math.floor(r() * names.length)], c = CLUBS[name];
  return { club: name, speed: r.range(...c.speed), launchDeg: r.range(...c.launch), azimuthDeg: r.gauss() * 2, spinRpm: r.range(...c.spin), curveDeg: r.gauss() * 8 };
}
export function randomEnv(r, { windMax = 3, terrain = 1 } = {}) {
  const ws = r.range(0, windMax), wd = r.range(0, 2 * Math.PI);
  return { rho: r.range(1.15, 1.25), spinDecaySec: r.range(18, 30), wind: { x: ws * Math.sin(wd), z: ws * Math.cos(wd), gust: r.range(0, 0.3), hz: r.range(0.2, 0.6), phase: r.range(0, 6.28) }, landingHeight: r.range(-terrain, terrain) };
}
export const CALM = { rho: 1.2, spinDecaySec: 25, wind: { x: 0, z: 0, gust: 0, hz: 0.3, phase: 0 }, landingHeight: 0 };

/* ------------------------------------------------------------------ physics */

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/** World: metres, X right of the target line, Y up, Z toward the target, the ball centre starts at the origin. */
export function simulateShot(shot, env = CALM, { dt = 1e-3, tMax = 14 } = {}) {
  const la = shot.launchDeg * DEG, az = shot.azimuthDeg * DEG, curve = (shot.curveDeg ?? 0) * DEG;
  const area = Math.PI * BALL.r * BALL.r, w0 = shot.spinRpm * Math.PI / 30;
  let p = [0, 0, 0], v = [shot.speed * Math.cos(la) * Math.sin(az), shot.speed * Math.sin(la), shot.speed * Math.cos(la) * Math.cos(az)];
  const ground = (x, z) => env.landingHeight * Math.min(1, Math.max(0, (Math.hypot(x, z) - 30) / 120));
  const windAt = (h, t) => {
    const prof = Math.pow(Math.max(0.2, h + 1) / 11, 0.14), g = 1 + env.wind.gust * Math.sin(2 * Math.PI * env.wind.hz * t + env.wind.phase);
    return [env.wind.x * prof * g, 0, env.wind.z * prof * g];
  };
  const acc = (p, v, t) => {
    const wnd = windAt(p[1], t), rel = [v[0] - wnd[0], v[1], v[2] - wnd[2]], s = Math.hypot(...rel) || 1e-9;
    const spin = w0 * Math.exp(-t / env.spinDecaySec), S = BALL.r * spin / Math.max(s, 1);
    const cd = 0.21 + 0.22 * S, cl = Math.min(0.34, 0.1 + 1.15 * S), k = env.rho * area / (2 * BALL.m);
    // Backspin axis: horizontal, to the left of travel; rotated about the velocity by −curve (curve > 0 bends right).
    const hz = Math.hypot(rel[0], rel[2]) || 1e-9, a0 = [-rel[2] / hz, 0, rel[0] / hz], vh = [rel[0] / s, rel[1] / s, rel[2] / s];
    const c = Math.cos(-curve), sn = Math.sin(-curve), vxa = cross(vh, a0), da = dot(vh, a0);
    const axis = [0, 1, 2].map(i => a0[i] * c + vxa[i] * sn + vh[i] * da * (1 - c));
    const lift = unit(cross(axis, rel));
    return [0, 1, 2].map(i => -k * cd * s * rel[i] + k * cl * s * s * lift[i] - (i === 1 ? G : 0));
  };
  const T = [0], Pp = [[...p]];
  let t = 0, apex = 0, landing = null;
  while (t < tMax) {
    const a1 = acc(p, v, t), p2 = p.map((x, i) => x + v[i] * dt / 2), v2 = v.map((x, i) => x + a1[i] * dt / 2);
    const a2 = acc(p2, v2, t + dt / 2), p3 = p.map((x, i) => x + v2[i] * dt / 2), v3 = v.map((x, i) => x + a2[i] * dt / 2);
    const a3 = acc(p3, v3, t + dt / 2), p4 = p.map((x, i) => x + v3[i] * dt), v4 = v.map((x, i) => x + a3[i] * dt);
    const a4 = acc(p4, v4, t + dt);
    const np = p.map((x, i) => x + dt / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i])), nv = v.map((x, i) => x + dt / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]));
    const gh = ground(np[0], np[2]);
    if (t > 0.2 && np[1] < gh && nv[1] < 0) {
      const g0 = p[1] - ground(p[0], p[2]), u = g0 / (g0 - (np[1] - gh));
      landing = { t: t + u * dt, p: p.map((x, i) => x + (np[i] - x) * u) };
      T.push(landing.t); Pp.push(landing.p);
      break;
    }
    p = np; v = nv; t += dt; apex = Math.max(apex, p[1]);
    T.push(t); Pp.push([...p]);
  }
  return { shot, env, T, P: Pp, apex, landing, tEnd: T[T.length - 1] };
}
export function ballAt(traj, t) {
  if (t <= 0) return [0, 0, 0];
  const { T, P } = traj;
  if (t >= T[T.length - 1]) return [...P[P.length - 1]];
  const i = Math.min(T.length - 2, Math.floor(t / (T[1] - T[0])));
  let j = i;
  while (j > 0 && T[j] > t) j--;
  while (j < T.length - 2 && T[j + 1] < t) j++;
  const u = (t - T[j]) / (T[j + 1] - T[j]);
  return P[j].map((x, k) => x + (P[j + 1][k] - x) * u);
}

/* ------------------------------------------------------------------ camera */

/** Phone pinhole: x = c + f·x_n·(1 + k1·r²/r_c²), k1 relative to the frame corner (r_c = half-diagonal / f). Pose by yaw (about Y), pitch (+ looks up), roll. */
export function makeCamera({ W, H, fovLongDeg = 69, k1 = 0, C, yaw = 0, pitch = 0, roll = 0 }) {
  const f = (Math.max(W, H) / 2) / Math.tan(fovLongDeg * DEG / 2), cam = { W, H, f, k1, C, yaw, pitch, roll, cx: W / 2, cy: H / 2 };
  const kr = k1 * f * f / (0.25 * (W * W + H * H));
  const fwd = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r0 = [Math.cos(yaw), 0, -Math.sin(yaw)], d0 = cross(r0, fwd);
  cam.fwd = fwd;
  cam.right = r0.map((v, i) => v * Math.cos(roll) + d0[i] * Math.sin(roll));
  cam.down = d0.map((v, i) => v * Math.cos(roll) - r0[i] * Math.sin(roll));
  cam.project = P => {
    const d = [P[0] - C[0], P[1] - C[1], P[2] - C[2]], z = dot(d, fwd);
    if (!(z > 1e-3)) return { x: NaN, y: NaN, z, diam: 0 };
    const xn = dot(d, cam.right) / z, yn = dot(d, cam.down) / z, k = 1 + kr * (xn * xn + yn * yn);
    return { x: cam.cx + f * xn * k, y: cam.cy + f * yn * k, z, diam: f * k * BALL.d / z };
  };
  return cam;
}
/** Yaw and pitch so that world point A lands on pixel (u, w). */
export function aim(spec, A, u, w) {
  let yaw = Math.atan2(A[0] - spec.C[0], A[2] - spec.C[2]), pitch = 0;
  for (let it = 0; it < 40; it++) {
    const at = (y, p) => makeCamera({ ...spec, yaw: y, pitch: p }).project(A), q = at(yaw, pitch), e = 1e-6;
    const qy = at(yaw + e, pitch), qp = at(yaw, pitch + e);
    const a = (qy.x - q.x) / e, b = (qp.x - q.x) / e, c = (qy.y - q.y) / e, d = (qp.y - q.y) / e, det = a * d - b * c;
    const ru = u - q.x, rw = w - q.y;
    if (Math.abs(ru) + Math.abs(rw) < 1e-7 || !det) break;
    yaw += (d * ru - b * rw) / det; pitch += (-c * ru + a * rw) / det;
  }
  return { yaw, pitch };
}
/** True horizon (vanishing line of horizontal planes) as {kind:'horizon', slope, y0, conf}: y = y0 + slope·x. */
export function horizonOf(cam) {
  const far = a => cam.project([cam.C[0] + 1e7 * Math.sin(cam.yaw + a), cam.C[1], cam.C[2] + 1e7 * Math.cos(cam.yaw + a)]);
  const p = far(-0.15), q = far(0.15), slope = (q.y - p.y) / (q.x - p.x);
  return { kind: 'horizon', slope, y0: p.y - slope * p.x, conf: 0.9 };
}

/**
 * A sky line like U2 reports (the tops of trees, nets or buildings): the true horizon raised by elevDeg (> 0, the
 * skyline is that many degrees above the horizon) and tilted by tiltDeg, in the legacy shape without a kind unless
 * kind is given. elevDeg/tiltDeg default to the synthetic corpus's tree line (1.4-8° above, slope off by about 2.5°).
 */
export function skylineOf(cam, { elevDeg = 4.5, tiltDeg = 2.5, kind } = {}) {
  const h = horizonOf(cam), f = cam.f, cx = cam.W / 2, yc = h.y0 + h.slope * cx;
  const yS = cam.H / 2 + f * Math.tan(Math.atan((yc - cam.H / 2) / f) - elevDeg * DEG), slope = Math.tan(Math.atan(h.slope) + tiltDeg * DEG);
  return { ...(kind ? { kind } : {}), slope, y0: yS - slope * cx, conf: 0.9 };
}

/** Camera placements like phone clips (the ball low in the frame, aimed, so pitch is often negative). */
export function placeCamera(r, view, { W = 1080, H = 1920, lens = 'main' } = {}) {
  const fovLongDeg = lens === 'ultra' ? r.range(102, 110) : r.range(64, 72), k1 = lens === 'ultra' ? r.range(-0.13, -0.05) : 0;
  const spec = { W, H, fovLongDeg, k1, roll: r.gauss() * 1.2 * DEG };
  let A = [0, 0, 0], u, w;
  if (view === 'dtl') { spec.C = [r.range(-0.5, 0.5), r.range(0.8, 1.5), -r.range(2.5, 5)]; u = r.range(0.42, 0.58) * W; w = r.range(0.66, 0.82) * H; }
  else if (view === 'oblique') { const a = r.range(30, 55) * DEG, D = r.range(3, 5.5); spec.C = [D * Math.sin(a), r.range(0.8, 1.4), -D * Math.cos(a)]; u = r.range(0.42, 0.58) * W; w = r.range(0.66, 0.82) * H; }
  else { const D = r.range(3.5, 7); spec.C = [-D, r.range(0.8, 1.4), r.range(-0.2, 0.2)]; A = [-0.4, 0, 0]; u = r.range(0.35, 0.5) * W; w = r.range(0.7, 0.84) * H; }
  return makeCamera({ ...spec, ...aim(spec, A, u, w) });
}

/* ------------------------------------------------------------------ clips */

/** Video time -> real seconds since impact for a constant τ or a speed ramp τ1 -> τ2 centred at tSplit (width in video s). */
export function makeClock({ t0, tau = 1, ramp = null }) {
  if (!ramp) return { toReal: t => (t - t0) / tau, toVideo: tr => t0 + tau * tr, tauAt: () => tau };
  const { tSplit, tau2, width = 0.2 } = ramp, a = tSplit - width / 2, b = tSplit + width / 2;
  const tauAt = t => (t <= a ? tau : t >= b ? tau2 : tau + (tau2 - tau) * (t - a) / (b - a));
  const step = 1e-3, tab = [];
  for (let t = t0, tr = 0; t < t0 + 200; t += step) { tab.push(tr); tr += step / tauAt(t + step / 2); }
  const toReal = t => { if (t <= t0) return 0; const x = (t - t0) / step, i = Math.min(tab.length - 2, Math.floor(x)); return tab[i] + (tab[i + 1] - tab[i]) * (x - i); };
  const toVideo = tr => { let lo = t0, hi = t0 + 199; for (let it = 0; it < 60; it++) { const m = 0.5 * (lo + hi); if (toReal(m) < tr) lo = m; else hi = m; } return hi; };
  return { toReal, toVideo, tauAt };
}

/**
 * A synthetic clip: camera, shot, physics and per-frame truth.
 * @param {{seed?:number, view?:'dtl'|'fo'|'oblique', W?:number, H?:number, fps?:number, tau?:number, ramp?:object,
 *   lens?:string, club?:string, shot?:object, env?:object, camera?:object, windMax?:number, terrain?:number}} o
 */
export function makeClip(o = {}) {
  const r = rng(o.seed ?? 1), view = o.view ?? 'dtl', W = o.W ?? 1080, H = o.H ?? 1920, fps = o.fps ?? 30, tau = o.tau ?? 1;
  const cam = o.camera ?? placeCamera(r, view, { W, H, lens: o.lens });
  const shot = { ...randomShot(r, o.club), ...(o.shot ?? {}) }, env = o.env ?? randomEnv(r, { windMax: o.windMax ?? 3, terrain: o.terrain ?? 1 });
  const traj = simulateShot(shot, env);
  const t0 = (Math.round(0.6 * fps) + r.range(0.2, 0.8)) / fps, clock = makeClock({ t0, tau, ramp: o.ramp ?? null });
  const tLandV = clock.toVideo(traj.landing ? traj.landing.t : traj.tEnd);
  const N = Math.ceil((tLandV + 1) * fps) + 1, times = Float64Array.from({ length: N }, (_, k) => k / fps);
  const meta = makeSourceMeta({ width: W, height: H, fps, frameCount: N, times, duration: N / fps, path: 'memory', hasAudio: false });
  const A = cam.project([0, 0, 0]);
  const truthAt = t => { const tr = clock.toReal(t), q = cam.project(ballAt(traj, tr)), P = ballAt(traj, tr); return { t, tReal: tr, x: q.x, y: q.y, d: q.diam, h: P[1], inFrame: q.z > 0 && q.x >= 0 && q.x < W && q.y >= 0 && q.y < H }; };
  const frames = [];
  for (let k = 0; k < N; k++) if (times[k] > t0 && times[k] <= tLandV) frames.push({ index: k, ...truthAt(times[k]) });
  const landing = traj.landing ? { ...truthAt(tLandV), t: tLandV } : null;
  // Permanent exit: the last in-frame time before landing, if the ball ends outside the frame.
  let exit = null;
  const arc = [];
  for (let t = t0; t <= tLandV + 1e-9; t += 1 / 240) arc.push(truthAt(t));
  arc.push(truthAt(tLandV));
  const inside = q => q.x >= -q.d && q.x <= W + q.d && q.y >= -q.d && q.y <= H + q.d;
  if (!inside(arc[arc.length - 1])) {
    let i = arc.length - 1;
    while (i > 0 && !inside(arc[i])) i--;
    let a = arc[i].t, b = arc[Math.min(arc.length - 1, i + 1)].t;
    for (let it = 0; it < 40; it++) { const m = 0.5 * (a + b); if (inside(truthAt(m))) a = m; else b = m; }
    exit = truthAt(b);
  }
  return { seed: o.seed ?? 1, view, W, H, fps, tau, ramp: o.ramp ?? null, cam, shot, env, traj, clock, t0, meta, address: { x: A.x, y: A.y }, d0: A.diam, frames, landing, exit, end: exit ?? landing, arc, horizon: horizonOf(cam), truthAt };
}

/**
 * Noisy observations of a clip.
 * @param {object} clip
 * @param {{realSec?:number, frac?:number, untilT?:number, skip?:number, sigma?:number|null, sizeNoise?:number,
 *   outlierFrac?:number, outlierPx?:[number, number], minDiam?:number, every?:number, seed?:number, drop?:number}} [o]
 *   realSec: observe until this many real seconds after impact; frac: fraction of the visible window; default all.
 */
export function observe(clip, o = {}) {
  const r = rng((o.seed ?? clip.seed) * 7919 + 13), minDiam = o.minDiam ?? 0.8, every = o.every ?? 1;
  const vis = [];
  for (const f of clip.frames) { if (!f.inFrame || f.d < minDiam) break; vis.push(f); }
  let use = vis.slice(o.skip ?? 0);
  if (o.realSec != null) use = use.filter(f => f.tReal <= o.realSec + 1e-9);
  if (o.untilT != null) use = use.filter(f => f.t <= o.untilT + 1e-9);
  if (o.frac != null) use = use.slice(0, Math.max(3, Math.round(use.length * o.frac)));
  use = use.filter((f, i) => i % every === 0 || i === use.length - 1);
  const out = [];
  for (const f of use) {
    if (o.drop && r() < o.drop) continue;
    const sigma = o.sigma ?? 0.35 + 0.05 * f.d;
    let x = f.x + r.gauss() * sigma, y = f.y + r.gauss() * sigma, outlier = false;
    if (o.outlierFrac && r() < o.outlierFrac) {
      const a = r() * 2 * Math.PI, m = r.range(...(o.outlierPx ?? [15, 60]));
      x += m * Math.cos(a); y += m * Math.sin(a); outlier = true;
    }
    const d = f.d / 2 >= 1.2 ? f.d * Math.exp(r.gauss() * (o.sizeNoise ?? 0.08)) : null;
    const ob = makeObservation({ index: f.index, t: f.t, x, y, sigma, z: 8, z1: 6, d, polarity: 1, src: 'tbd', flag: 'inlier' });
    out.push(o.tagOutliers ? Object.assign(ob, { _outlier: outlier }) : ob);
  }
  return out;
}

/** A LaunchCandidate from the truth (address and d0 with small measurement noise), seeded by the first observations. */
export function launchFor(clip, obs, { seed = 3, addrNoise = 0.3, d0Noise = 0.04 } = {}) {
  const r = rng(clip.seed * 31 + seed), q1 = clip.truthAt(clip.t0 + 0.5 / clip.fps), dx = q1.x - clip.address.x, dy = q1.y - clip.address.y, n = Math.hypot(dx, dy) || 1;
  const samples = obs.slice(0, 2).map(o => ({ ...o, src: 'launch' }));
  const vFrame = Math.max(1e-3, n / 0.5), q2 = clip.truthAt(clip.t0 + 2 / clip.fps);
  return makeLaunchCandidate({
    id: 'L1', hypId: 'H1', t0: clip.t0, address: { x: clip.address.x + r.gauss() * addrNoise, y: clip.address.y + r.gauss() * addrNoise },
    d0: clip.d0 * (1 + r.gauss() * d0Noise), dir: { x: dx / n, y: dy / n }, v: vFrame, c: Math.max(0, (clip.d0 / q2.d - 1) / 2),
    polarity: 1, samples: samples.length >= 2 ? samples : [samples[0], { ...samples[0], t: samples[0].t + 1e-3 }], view: clip.view === 'fo' ? 'fo' : 'dtl', S: 10, margin: 3
  });
}

/** τ priors: 'flat' (all modes equal), 'true' (most weight on the nearest mode), 'one' (U3 default: all on τ = 1). */
export function tauPriorFor(clip, kind = 'true') {
  const modes = [...PARAMS.impact.tau.modes];
  if (kind === 'flat') return { modes, weights: modes.map(() => 1 / modes.length) };
  if (kind === 'one') return { modes, weights: modes.map((_, i) => (i ? 0 : 1)) };
  const near = modes.reduce((b, m, i) => Math.abs(Math.log(m / clip.tau)) < Math.abs(Math.log(modes[b] / clip.tau)) ? i : b, 0);
  return { modes, weights: modes.map((_, i) => (i === near ? 0.7 : 0.1)) };
}

export function fitCtx(clip, obs, { horizon = true, tauPrior = 'true', params = PARAMS, launch } = {}) {
  return { meta: clip.meta, launch: launch ?? launchFor(clip, obs), horizon: horizon ? clip.horizon : null, tauPrior: typeof tauPrior === 'string' ? tauPriorFor(clip, tauPrior) : tauPrior, params };
}
export const completeCtx = (clip, fctx, { observedEnd = 'lost' } = {}) => ({ meta: clip.meta, camera: identityTrack(clip.meta, [0, clip.meta.frameCount - 1]), horizon: fctx.horizon, launch: fctx.launch, observedEnd, params: fctx.params });
export const curveCtx = (clip, fctx) => ({ meta: clip.meta, launch: fctx.launch, params: fctx.params });

/** Distance (px) from p to the truth polyline of the arc (shape error, time-free). */
export function shapeDistance(clip, p) {
  let best = Infinity;
  for (const q of clip.arc) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  return best;
}
export const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
export const median = a => quantile(a, 0.5);
