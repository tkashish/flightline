// Golf-ball flight, independent of any tracker model: Reynolds- and spin-dependent drag, saturating
// lift, exponential spin decay, height-profiled gusting wind, terrain-height landing, bounce and roll.
import { DEG, clamp, hermite } from './math.mjs';

export const BALL = { m: 0.04593, d: 0.04267, r: 0.021335 };
const AREA = Math.PI * BALL.r * BALL.r, MU = 1.81e-5, G = 9.81;
// Fitted once against published launch-monitor averages (tour/LPGA driver, 7-iron, PW): carry within ~4%.
export const AERO = { cdHi: 0.21, cdLo: 0.42, reC: 5e4, cdS: 0.25, clMax: 0.35, s0: 0.15 };

export const CLUBS = {
  driver: { speed: [60, 78], launch: [8.5, 15], spin: [1900, 3300], smash: [1.42, 1.5], tilt: 7, tee: true },
  iron7: { speed: [42, 56], launch: [14, 21], spin: [5200, 7800], smash: [1.3, 1.38], tilt: 6 },
  wedge: { speed: [30, 46], launch: [22, 34], spin: [7000, 10500], smash: [1.15, 1.27], tilt: 5 },
  topped: { speed: [14, 34], launch: [-3, 5], spin: [-600, 900], smash: [0.85, 1.15], tilt: 3 }
};

export function sampleShot(r, club, { curve = null } = {}) {
  const c = CLUBS[club], speed = r.range(...c.speed);
  const bigCurve = curve ?? r.chance(0.15);
  return {
    club, speed,
    launchDeg: r.range(...c.launch),
    azimuthDeg: r.normal(0, 2.5),
    spinRpm: r.range(...c.spin),
    axisTiltDeg: bigCurve ? r.sign() * r.range(14, 30) : r.normal(0, c.tilt),
    smash: r.range(...c.smash)
  };
}

export function sampleEnv(r, { calm = false } = {}) {
  const ws = calm ? r.range(0, 1) : r.weighted({ 1: 3, 3: 4, 6: 2, 9: 1 }) * r.range(0.4, 1.1), wd = r.range(0, 2 * Math.PI);
  return {
    rho: r.range(1.1, 1.25),
    tauSpin: r.range(18, 30),
    wind: { speed: ws, dir: wd, gust: r.range(0.1, 0.4), gustHz: r.range(0.15, 0.6), phase: r.range(0, 6.28) },
    landingHeight: r.chance(0.5) ? r.range(-1.5, 1.5) : 0,
    ground: { restitution: r.range(0.32, 0.5), friction: r.range(0.45, 0.75), roll: r.range(0.6, 1.6) }
  };
}

export const terrainHeight = (env, x, z) => env.landingHeight * clamp((Math.hypot(x, z) - 30) / 120, 0, 1);

function windAt(env, h, t) {
  const w = env.wind, prof = Math.log((Math.max(0, h) + 0.03) / 0.03) / Math.log(10.03 / 0.03);
  const g = 1 + w.gust * (0.7 * Math.sin(2 * Math.PI * w.gustHz * t + w.phase) + 0.3 * Math.sin(5.3 * w.gustHz * t + 2 * w.phase));
  const s = w.speed * prof * g, d = w.dir + 0.15 * Math.sin(1.7 * w.gustHz * t + w.phase);
  return [s * Math.sin(d), 0, s * Math.cos(d)];
}

export function aeroCoefficients(speed, spinRadS, rho = 1.2) {
  const S = BALL.r * Math.abs(spinRadS) / Math.max(speed, 1), Re = rho * speed * BALL.d / MU;
  const cd = AERO.cdHi + (AERO.cdLo - AERO.cdHi) / (1 + (Re / AERO.reC) ** 4) + AERO.cdS * S;
  const cl = Math.sign(spinRadS) * AERO.clMax * (1 - Math.exp(-S / AERO.s0));
  return { cd, cl, S, Re };
}

function accel(env, tilt, w0, p, v, t) {
  const wind = windAt(env, p[1], t), rx = v[0] - wind[0], ry = v[1], rz = v[2] - wind[2];
  const s = Math.hypot(rx, ry, rz) || 1e-9, { cd, cl } = aeroCoefficients(s, w0 * Math.exp(-t / env.tauSpin), env.rho);
  const k = env.rho * AREA / (2 * BALL.m), h = Math.hypot(rx, rz) || 1e-9;
  // Lift: upward normal to the relative velocity, rotated toward the right of travel by the spin-axis tilt.
  const ux = -ry * rx / (h * s), uy = h / s, uz = -ry * rz / (h * s), sx = rz / h, sz = -rx / h;
  const ct = Math.cos(tilt), st = Math.sin(tilt), nx = ct * ux + st * sx, ny = ct * uy, nz = ct * uz + st * sz;
  return [-k * cd * s * rx + k * cl * s * s * nx, -G - k * cd * s * ry + k * cl * s * s * ny, -k * cd * s * rz + k * cl * s * s * nz];
}

/**
 * Integrates (RK4, 1 ms) from `start` until the first ground contact, then bounces and rolls until rest or tEnd.
 * Returns time samples with position and velocity for Hermite interpolation.
 */
export function simulateFlight(shot, env, { start = [0, BALL.r, 0], dt = 1e-3, tEnd = 14 } = {}) {
  const la = shot.launchDeg * DEG, az = shot.azimuthDeg * DEG, tilt = shot.axisTiltDeg * DEG, w0 = shot.spinRpm * Math.PI / 30;
  let p = [...start], v = [shot.speed * Math.cos(la) * Math.sin(az), shot.speed * Math.sin(la), shot.speed * Math.cos(la) * Math.cos(az)];
  const T = [0], P = [[...p]], V = [[...v]];
  let t = 0, apex = p[1], landing = null, bounces = 0, rolling = false, rest = null, airborne = true;
  const ground = (x, z) => terrainHeight(env, x, z) + BALL.r;
  while (t < tEnd - 1e-9) {
    if (airborne) {
      const a1 = accel(env, tilt, w0, p, v, t);
      const p2 = p.map((c, i) => c + v[i] * dt / 2), v2 = v.map((c, i) => c + a1[i] * dt / 2), a2 = accel(env, tilt, w0, p2, v2, t + dt / 2);
      const p3 = p.map((c, i) => c + v2[i] * dt / 2), v3 = v.map((c, i) => c + a2[i] * dt / 2), a3 = accel(env, tilt, w0, p3, v3, t + dt / 2);
      const p4 = p.map((c, i) => c + v3[i] * dt), v4 = v.map((c, i) => c + a3[i] * dt), a4 = accel(env, tilt, w0, p4, v4, t + dt);
      const np = p.map((c, i) => c + dt / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i])), nv = v.map((c, i) => c + dt / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]));
      const gh = ground(np[0], np[2]);
      if (np[1] < gh && nv[1] < 0) {
        const u = clamp((p[1] - ground(p[0], p[2])) / Math.max(1e-9, p[1] - ground(p[0], p[2]) - (np[1] - gh)), 0, 1);
        const tc = t + u * dt, pc = p.map((c, i) => c + (np[i] - c) * u), vc = v.map((c, i) => c + (nv[i] - c) * u);
        pc[1] = ground(pc[0], pc[2]);
        if (!landing) landing = { t: tc, p: [...pc], v: [...vc], angleDeg: Math.atan2(-vc[1], Math.hypot(vc[0], vc[2])) / DEG };
        const spinK = 0.3 * clamp(Math.abs(shot.spinRpm) / 9000, 0, 1) * Math.exp(-tc / env.tauSpin);
        const e = env.ground.restitution * clamp(1.15 - Math.abs(vc[1]) / 40, 0.5, 1), kt = clamp(1 - env.ground.friction * clamp(Math.abs(vc[1]) / 18, 0.25, 1) - spinK, 0.05, 1);
        p = pc; v = [vc[0] * kt, -vc[1] * e, vc[2] * kt]; t = tc; bounces++;
        if (v[1] < 0.6 || bounces > 8) { airborne = false; rolling = true; v[1] = 0; }
      } else { p = np; v = nv; t += dt; }
      apex = Math.max(apex, p[1]);
    } else if (rolling) {
      const s = Math.hypot(v[0], v[2]), ds = (env.ground.roll + 0.3 * s) * dt;
      if (s <= ds) { v = [0, 0, 0]; rolling = false; rest = t; }
      else { const k = (s - ds) / s; v = [v[0] * k, 0, v[2] * k]; }
      p = [p[0] + v[0] * dt, ground(p[0], p[2]), p[2] + v[2] * dt]; t += dt;
    } else { t = tEnd; }
    T.push(t); P.push([...p]); V.push([...v]);
    if (rest != null) break;
  }
  const carryM = landing ? Math.hypot(landing.p[0] - start[0], landing.p[2] - start[2]) : null;
  return { shot, env, start, T, P, V, apex: apex - start[1] + BALL.r, landing, carryM, rest, tEnd: T.at(-1) };
}

/** Position at time t (seconds after impact); before 0 the ball sits at start. Hermite between samples. */
export function ballAt(traj, t) {
  const { T, P, V } = traj;
  if (t <= 0) return [...traj.start];
  if (t >= T.at(-1)) return [...P.at(-1)];
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const h = T[hi] - T[lo], s = h > 0 ? (t - T[lo]) / h : 0, a = P[lo], b = P[hi], va = V[lo], vb = V[hi];
  // A bounce flips the velocity inside the step: fall back to linear there.
  if (va[1] * vb[1] < 0 && Math.abs(va[1] - vb[1]) > 5) return a.map((c, i) => c + (b[i] - c) * s);
  return [0, 1, 2].map(i => hermite(a[i], va[i] * h, b[i], vb[i] * h, s));
}
export function ballVelAt(traj, t) {
  if (t <= 0) return [0, 0, 0];
  const e = 1e-4, a = ballAt(traj, t - e), b = ballAt(traj, t + e);
  return [(b[0] - a[0]) / (2 * e), (b[1] - a[1]) / (2 * e), (b[2] - a[2]) / (2 * e)];
}
