// Pinhole phone camera: intrinsics with optional radial distortion, yaw/pitch/roll pose, placement per view,
// handheld shake (Ornstein-Uhlenbeck drift plus tremor), slight pan or zoom, rolling-shutter row time.
import { DEG, clamp, smooth, rngFor, sub, norm } from './math.mjs';

/** k1 is radial distortion relative to the frame corner: the corner moves by k1 of its radius (monotone for k1 > -1/3). */
export function intrinsics({ W, H, fovLongDeg, k1 = 0 }) {
  const f = (Math.max(W, H) / 2) / Math.tan(fovLongDeg * DEG / 2), rc = Math.hypot(W, H) / 2 / f;
  return { W, H, f, cx: W / 2, cy: H / 2, k1, rc2: rc * rc, fovLongDeg };
}

/** Camera axes in world coordinates (world: X right, Y up, Z toward target). Positive pitch looks up. */
export function axes(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const fw = [sy * cp, sp, cy * cp], r0 = [cy, 0, -sy], u0 = [-sy * sp, cp, -cy * sp];
  const r = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
  const u = [u0[0] * cr + r0[0] * sr, u0[1] * cr + r0[1] * sr, u0[2] * cr + r0[2] * sr];
  return { r, d: [-u[0], -u[1], -u[2]], fw };
}

export function makeView(intr, C, pose) {
  const a = axes(pose.yaw, pose.pitch, pose.roll);
  return { ...intr, f: intr.f * (pose.zoom || 1), C, ...a };
}

/** World point -> distorted pixel. ppm = pixels per meter at that depth (for sizes). */
export function project(v, P) {
  const dx = P[0] - v.C[0], dy = P[1] - v.C[1], dz = P[2] - v.C[2];
  const z = dx * v.fw[0] + dy * v.fw[1] + dz * v.fw[2];
  if (!(z > 1e-4)) return { x: NaN, y: NaN, z, ppm: 0 };
  const xn = (dx * v.r[0] + dy * v.r[1] + dz * v.r[2]) / z, yn = (dx * v.d[0] + dy * v.d[1] + dz * v.d[2]) / z;
  const k = v.k1 ? 1 + v.k1 * (xn * xn + yn * yn) / v.rc2 : 1;
  return { x: v.cx + v.f * xn * k, y: v.cy + v.f * yn * k, z, ppm: v.f * k / z };
}

/** Pixel -> unit world ray (inverts the radial term with a few Newton steps). */
export function rayDir(v, u, w) {
  let xd = (u - v.cx) / v.f, yd = (w - v.cy) / v.f, xn = xd, yn = yd;
  if (v.k1) {
    const rd = Math.hypot(xd, yd);
    if (rd > 0) {
      let rr = rd;
      const k = v.k1 / v.rc2;
      for (let i = 0; i < 8; i++) { const g = rr * (1 + k * rr * rr) - rd, dg = 1 + 3 * k * rr * rr; rr -= g / dg; }
      xn = xd * rr / rd; yn = yd * rr / rd;
    }
  }
  return norm([v.r[0] * xn + v.d[0] * yn + v.fw[0], v.r[1] * xn + v.d[1] * yn + v.fw[1], v.r[2] * xn + v.d[2] * yn + v.fw[2]]);
}

/** Solve yaw/pitch so `anchor` lands on pixel (u, w) for a given roll (Newton with a numeric Jacobian). */
export function aim(intr, C, anchor, u, w, roll = 0) {
  const d = norm(sub(anchor, C)), at = (yaw, pitch) => project(makeView(intr, C, { yaw, pitch, roll }), anchor);
  let yaw = Math.atan2(d[0], d[2]), pitch = Math.asin(d[1]);
  for (let i = 0; i < 30; i++) {
    const p = at(yaw, pitch), e = 1e-5, py = at(yaw + e, pitch), pp = at(yaw, pitch + e);
    const a = (py.x - p.x) / e, b = (pp.x - p.x) / e, c = (py.y - p.y) / e, dd = (pp.y - p.y) / e, det = a * dd - b * c;
    const ru = u - p.x, rw = w - p.y;
    if (Math.abs(ru) + Math.abs(rw) < 1e-6 || !det) break;
    yaw += clamp((dd * ru - b * rw) / det, -0.3, 0.3); pitch += clamp((-c * ru + a * rw) / det, -0.3, 0.3);
  }
  return { yaw, pitch };
}

/** Deterministic camera motion in capture (real) time. */
export function cameraMotion(seed, cfg, tSpan) {
  const r = rngFor(seed, 'cam-motion'), [t0, t1] = tSpan, dt = 0.002, n = Math.ceil((t1 - t0) / dt) + 3;
  const sh = cfg.shake || { sigmaDeg: 0 }, axesN = [1, 0.85, 0.45];
  const ou = axesN.map(k => {
    const a = new Float32Array(n), tau = sh.tauS || 1, s = (sh.sigmaDeg || 0) * k * DEG, e = Math.exp(-dt / tau), q = s * Math.sqrt(1 - e * e);
    let x = r.normal(0, s);
    for (let i = 0; i < n; i++) { a[i] = x; x = x * e + q * r.gauss(); }
    return a;
  });
  const trem = axesN.map(k => Array.from({ length: 3 }, () => ({ a: (sh.tremorDeg || 0) * k * DEG * r.range(0.5, 1), f: r.range(2, 10), p: r.range(0, 6.283) })));
  const pan = cfg.pan, zoom = cfg.zoom;
  return t => {
    const x = clamp((t - t0) / dt, 0, n - 2), i = Math.floor(x), u = x - i;
    const o = ou.map(a => a[i] + (a[i + 1] - a[i]) * u), tr = trem.map(ts => ts.reduce((s, q) => s + q.a * Math.sin(2 * Math.PI * q.f * t + q.p), 0));
    let yaw = cfg.yaw + o[0] + tr[0], pitch = cfg.pitch + o[1] + tr[1], roll = cfg.roll + o[2] + tr[2], z = 1;
    if (pan) { const s = smooth((t - pan.t0) / pan.dur); yaw += pan.dyaw * DEG * s; pitch += pan.dpitch * DEG * s; }
    if (zoom) { const s = smooth((t - zoom.t0) / zoom.dur); z = 1 + (zoom.factor - 1) * s; }
    return { yaw, pitch, roll, zoom: z };
  };
}

/** Readout offset (s) of a display pixel relative to the frame time; zero without rolling shutter. */
export function rsOffset(rs, W, H, x, y) {
  if (!rs) return 0;
  const u = rs.axis === 'x' ? x / W : y / H;
  return (rs.dir > 0 ? u - 0.5 : 0.5 - u) * rs.readoutS;
}

export const LENSES = {
  main: { fov: [62, 72], k1: [0, 0] },
  ultra: { fov: [100, 110], k1: [-0.12, -0.05] },
  tele: { fov: [36, 44], k1: [0, 0] },
  mainShift: { fov: [54, 61], k1: [0, 0] }
};

/**
 * Places the camera for a view. `g` carries golfer landmarks in world space (feet center, hands, head, ball, hand sign).
 * Returns { C, yaw, pitch, roll, view, low } where the ball/golfer are framed like a phone clip. `dist` fixes the camera
 * distance range (easy clips); landscape down-the-line frames keep the horizon at least 20% below the top edge.
 */
export function placeCamera(r, view, g, intr, { styleShift = false, dist = null } = {}) {
  const s = g.hand, ball = g.ball, portrait = intr.H > intr.W;
  const roll = r.normal(0, styleShift ? 2.5 : 1.2) * DEG, vBall = portrait ? r.range(0.66, 0.84) : r.range(0.62, 0.8);
  // Every random choice is drawn once; the camera then backs off until the golfer fits in the frame.
  const q = { D: r.range(2.3, styleShift ? 6.5 : 5), h: r.range(0.75, 1.6), xn: r.normal(0, 0.08), off: r.chance(0.7) ? -r.range(1.2, 2) : r.range(0.6, 1.2), uk: r.range(0.04, 0.16), uo: r.range(-0.08, 0.12), ub: r.range(0.42, 0.6),
    Df: r.range(3, styleShift ? 9 : 8), hf: r.range(0.8, 1.5), zf: r.normal(0, 0.25), uf: r.range(0.42, 0.58), wf: portrait ? r.range(0.7, 0.86) : r.range(0.66, 0.82),
    az: (styleShift && r.chance(0.5) ? r.pick([r.range(15, 28), r.range(62, 75)]) : r.range(30, 60)) * DEG, Do: r.range(2.5, 6), ho: r.range(0.8, 1.5), uob: r.range(0.4, 0.6) };
  if (dist) Object.assign(q, { D: r.range(...dist), Df: r.range(...dist), Do: r.range(...dist), h: r.range(1, 1.4), hf: r.range(1, 1.4), ho: r.range(1, 1.4) });
  // A share of phones sit on the ground or a bag (as in the one real Pixel frame at hand, dist/qa/offline-f52.png): the lens
  // 0.12-0.5 m up and the ball nearer mid-frame, so the flight soon has sky behind it.
  const low = !dist && r.chance(view.startsWith('dtl') ? 0.25 : 0.2), vB = low ? r.range(0.52, 0.7) : vBall;
  if (low) { const h = r.range(0.12, 0.5); Object.assign(q, { h, hf: h, ho: h, wf: r.range(0.55, 0.72) }); }
  const build = m => {
    let C, anchor = ball, u, w;
    if (view.startsWith('dtl')) {
      const x = view === 'dtl-ball' ? q.xn : view === 'dtl-hands' ? g.hands[0] + q.xn : s * q.off;
      C = [x, q.h, -q.D * m];
      u = view === 'dtl-ball' ? q.ub : view === 'dtl-hands' ? 0.5 + s * q.uk : 0.5 + s * q.uo;
      w = vB;
    } else if (view === 'face-on' || view === 'behind-back') {
      const side = view === 'face-on' ? s : -s;
      C = [side * q.Df * m + g.feet[0] * (view === 'face-on' ? 0 : 1), q.hf, g.feet[2] + q.zf];
      anchor = [(ball[0] + g.feet[0]) / 2, 0.02, (ball[2] + g.feet[2]) / 2]; u = q.uf; w = q.wf;
    } else { C = [ball[0] + s * q.Do * m * Math.sin(q.az), q.ho, ball[2] - q.Do * m * Math.cos(q.az)]; u = q.uob; w = vB; }
    // Re-centre when the anchor would push the golfer off the frame edge.
    return { C, anchor, u, w };
  };
  let out = null;
  const flat = view.startsWith('dtl') && !portrait;
  for (let i = 0, m = 1, dw = 0; i < 18; i++) {
    const { C, anchor, u, w } = build(m), a = aim(intr, C, anchor, u * intr.W, Math.min(0.92, w + dw) * intr.H, roll), v = makeView(intr, C, { ...a, roll });
    out = { C, yaw: a.yaw, pitch: a.pitch, roll, view, distanceScale: m, low };
    const ok = (g.fit || []).every(P => { const p = project(v, P); return p.z > 0.3 && p.x > 0.04 * intr.W && p.x < 0.96 * intr.W && p.y > 0.03 * intr.H && p.y < 0.97 * intr.H; });
    const hz = flat ? project(v, [C[0] + 1e4 * Math.sin(a.yaw), C[1], C[2] + 1e4 * Math.cos(a.yaw)]).y : Infinity;
    if (ok && hz >= 0.2 * intr.H) break;
    // Too steep for landscape: lower the ball in the frame (pitch up), then back off.
    if (hz < 0.2 * intr.H && w + dw < 0.9) dw += 0.04; else m *= 1.1;
  }
  return out;
}

export const viewClass = v => (v.startsWith('dtl') ? 'dtl' : v === 'oblique' ? 'oblique' : 'fo');
