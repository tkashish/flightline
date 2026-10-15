/**
 * Pixel-level near-impact scene renderer for the hf launch tests (U3). Tests only; never imported by dist/.
 *
 * One 3-D world (metres, Y up, target +Z, ball at the origin; a right-handed golfer stands at +X facing −X,
 * `hand: -1` mirrors X), a pinhole phone camera (69° long-axis FOV), and luma-only rendering in native display px
 * with pixel (i, j) covering [i, i+1) × [j, j+1) (centre +0.5, protocol §4). Fast parts (arms, glove, shaft, club
 * head, glints, ferrule, ball) are temporally supersampled over the exposure; the body sways slowly.
 *
 * Built from D1's E3 renderer (D1-scratch/sim/scene.mjs) and D2's expC scene (D2-scratch/expC-launch*.mjs), with
 * these known problems fixed:
 *  - Club head: a projected 3-D head (iron 7.6 × 4.8 × 2.4 cm, driver 11.5 × 6 × 10.5 cm) seen from its real
 *    orientation. Face-on it is 1.1-1.4 d0 tall, so the width test alone cannot reject it (FINAL). expC drew a
 *    3.2·d0 disc in every view and D1 a 3.5 cm line, which made width a free win.
 *  - The ball launches from the club's 3-D path with loft and smash factor, and the face touches the ball's back
 *    at impact, so the two merge in the first post-impact frame. expC's DTL ball used a 2-D vanishing-point model
 *    unrelated to the club, and its club centre passed through the ball centre.
 *  - Exposure is centred on the frame time and capped by the capture interval; physics runs in capture (real)
 *    time, so 240→30 slow motion is right. Ground truth is at mid-exposure.
 *  - Noise comes from a fixed bank with a per-frame offset, so frame k is identical whatever order or subset of
 *    frames is rendered (D1 drew noise from the scene RNG stream, so content depended on render order). Every
 *    frame is a fresh buffer (the E7 buffer-reuse desync).
 *  - Ball-sized chrome glints (0.6-1.2·d0) on iron heads flicker with the head angle; driver glints are small.
 *  - The invisible-ball control (`ball: 'hidden'`) simply stops drawing the ball at impact. D2's first control
 *    painted background over the hidden path and left a ball-like trail.
 */
import { spawnSync } from 'node:child_process';
import { cropLuma, makeSourceMeta, createMemorySource } from '../../../dist/hf/types.js';
import { PARAMS } from '../../../dist/hf/params.js';
import { impactInterval } from '../../../dist/hf/impact.js';

export const R_BALL = 0.021335;
const DEG = Math.PI / 180;
const G = 9.81;

/* ------------------------------------------------------------------ small math */

export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  next.pick = arr => arr[Math.floor(next() * arr.length)];
  next.chance = p => next() < p;
  return next;
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const addS = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
function rotAbout(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), kd = dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);

/* ------------------------------------------------------------------ camera */

function makeCamera(W, H, C, look, fovLongDeg = 69) {
  const F = (Math.max(W, H) / 2) / Math.tan(fovLongDeg / 2 * DEG);
  const f = norm(sub(look, C)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), cx = W / 2, cy = H / 2;
  const project = P => {
    const d = sub(P, C), z = dot(d, f);
    if (z < 0.05) return null;
    return { x: cx + F * dot(d, r) / z, y: cy - F * dot(d, u) / z, z };
  };
  // 2×3 Jacobian of (x, y) at P, for projecting small ellipsoids (weak perspective about their centre).
  const jac = P => {
    const d = sub(P, C), z = dot(d, f), xr = dot(d, r) / z, yu = dot(d, u) / z, k = F / z;
    return [[k * (r[0] - xr * f[0]), k * (r[1] - xr * f[1]), k * (r[2] - xr * f[2])],
      [-k * (u[0] - yu * f[0]), -k * (u[1] - yu * f[1]), -k * (u[2] - yu * f[2])]];
  };
  return { W, H, F, C, f, r, u, project, jac };
}

/** Aim a camera at C so that world point P lands at image (px, py): a few fixed-point steps on the look point. */
function aimCamera(W, H, C, P, px, py, fov) {
  let look = add(P, [0, 0, 10]);
  for (let it = 0; it < 30; it++) {
    const cam = makeCamera(W, H, C, look, fov), q = cam.project(P);
    if (!q) { look = add(look, [0, 0, 5]); continue; }
    const ex = (q.x - px) / cam.F, ey = (q.y - py) / cam.F;
    if (Math.abs(ex) + Math.abs(ey) < 1e-7) break;
    const dist = Math.hypot(...sub(look, C));
    look = addS(addS(look, cam.r, ex * dist), cam.u, -ey * dist);
  }
  return makeCamera(W, H, C, look, fov);
}

/* ------------------------------------------------------------------ raster (region-local float layers) */

// A layer accumulates coverage (acc) and coverage·luma (accL) over a region, tracking the dirty box it touched.
function makeLayer(reg) {
  const n = reg.w * (reg.y1 - reg.y0);
  return { reg, acc: new Float32Array(n), accL: new Float32Array(n), bx0: reg.x1, by0: reg.y1, bx1: reg.x0, by1: reg.y0 };
}
function clearLayer(L) {
  const { reg } = L;
  for (let y = L.by0; y < L.by1; y++) { const o = (y - reg.y0) * reg.w - reg.x0; L.acc.fill(0, o + L.bx0, o + L.bx1); L.accL.fill(0, o + L.bx0, o + L.bx1); }
  L.bx0 = reg.x1; L.by0 = reg.y1; L.bx1 = reg.x0; L.by1 = reg.y0;
}
function touch(L, x0, y0, x1, y1) { if (x0 < L.bx0) L.bx0 = x0; if (y0 < L.by0) L.by0 = y0; if (x1 > L.bx1) L.bx1 = x1; if (y1 > L.by1) L.by1 = y1; }
/** Composite the layer over buf (alpha = min(1, coverage)·alpha), then clear it. */
function composite(L, buf, alpha = 1) {
  const { reg } = L;
  for (let y = L.by0; y < L.by1; y++) {
    const o = (y - reg.y0) * reg.w - reg.x0;
    for (let x = L.bx0; x < L.bx1; x++) {
      const i = o + x, c = L.acc[i];
      if (c > 0) { const a = Math.min(1, c) * alpha; buf[i] = buf[i] * (1 - a) + (L.accL[i] / c) * a; }
    }
  }
  clearLayer(L);
}
function rasterDisc(L, cx, cy, r, w, lum, shade) {
  const { reg, acc, accL } = L;
  const x0 = Math.max(reg.x0, Math.floor(cx - r - 1)), x1 = Math.min(reg.x1, Math.ceil(cx + r + 1));
  const y0 = Math.max(reg.y0, Math.floor(cy - r - 1)), y1 = Math.min(reg.y1, Math.ceil(cy + r + 1));
  if (x1 <= x0 || y1 <= y0) return;
  touch(L, x0, y0, x1, y1);
  const area = r < 0.6 ? (r / 0.6) ** 2 : 1;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy, row = (y - reg.y0) * reg.w - reg.x0;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, c = clamp01(r + 0.5 - Math.sqrt(dx * dx + dy * dy)) * area * w;
      if (c <= 0) continue;
      const i = row + x;
      acc[i] += c;
      accL[i] += c * (shade ? lum * (1 - shade * clamp01((dx * 0.35 + dy) / (r + 0.5) * 0.5 + 0.5)) : lum);
    }
  }
}
function rasterEllipse(L, cx, cy, S, w, lum) {
  // S = 2×2 image matrix: the ellipse is {d : dᵀ S⁻¹ d <= 1}.
  const { reg, acc, accL } = L, det = S[0] * S[2] - S[1] * S[1];
  if (!(det > 1e-9)) return;
  const m11 = S[2] / det, m12 = -S[1] / det, m22 = S[0] / det, ex = Math.sqrt(S[0]) + 1, ey = Math.sqrt(S[2]) + 1;
  const x0 = Math.max(reg.x0, Math.floor(cx - ex)), x1 = Math.min(reg.x1, Math.ceil(cx + ex));
  const y0 = Math.max(reg.y0, Math.floor(cy - ey)), y1 = Math.min(reg.y1, Math.ceil(cy + ey));
  if (x1 <= x0 || y1 <= y0) return;
  touch(L, x0, y0, x1, y1);
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy, row = (y - reg.y0) * reg.w - reg.x0;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, q = dx * dx * m11 + 2 * dx * dy * m12 + dy * dy * m22;
      const c = q < 1e-12 ? w : clamp01(0.5 + Math.sqrt(dx * dx + dy * dy) * (1 / Math.sqrt(q) - 1)) * w;
      if (c <= 0) continue;
      const i = row + x;
      acc[i] += c; accL[i] += c * lum;
    }
  }
}
function rasterCapsule(L, a, b, r, w, lum) {
  const { reg, acc, accL } = L;
  const x0 = Math.max(reg.x0, Math.floor(Math.min(a.x, b.x) - r - 1)), x1 = Math.min(reg.x1, Math.ceil(Math.max(a.x, b.x) + r + 1));
  const y0 = Math.max(reg.y0, Math.floor(Math.min(a.y, b.y) - r - 1)), y1 = Math.min(reg.y1, Math.ceil(Math.max(a.y, b.y) + r + 1));
  if (x1 <= x0 || y1 <= y0) return;
  touch(L, x0, y0, x1, y1);
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5 - a.y, row = (y - reg.y0) * reg.w - reg.x0;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5 - a.x, u = clamp01((px * dx + py * dy) / L2), ex = px - u * dx, ey = py - u * dy;
      const c = clamp01(r + 0.5 - Math.sqrt(ex * ex + ey * ey)) * w;
      if (c <= 0) continue;
      const i = row + x;
      acc[i] += c; accL[i] += c * lum;
    }
  }
}

// One shared N(0, 1) bank; frames index it at hashed offsets, so content never depends on render order.
const BANK_N = 1 << 20;
let BANK = null;
function noiseBank() {
  if (BANK) return BANK;
  BANK = new Float32Array(BANK_N);
  const nr = rng(104729);
  for (let i = 0; i < BANK_N; i++) BANK[i] = nr.normal();
  return BANK;
}

/* ------------------------------------------------------------------ scene */

const CLUBS = {
  // head semi-axes along toe, height, depth (m): face-on the lofted iron is ~1.1-1.3 d0 tall, the driver ~1.4 d0;
  // speeds (m/s); smash; launch elevation (deg); loft (deg)
  iron: { semi: [0.038, 0.0275, 0.012], speed: [33, 40], smash: [1.3, 1.38], launch: [15, 24], loft: 34, radius: 1.6, lum: [150, 200], glints: [2, 3], glintD0: [0.6, 1.2], tee: false },
  driver: { semi: [0.0575, 0.03, 0.0525], speed: [40, 50], smash: [1.42, 1.5], launch: [9, 15], loft: 10.5, radius: 1.72, lum: [32, 52], glints: [1, 2], glintD0: [0.25, 0.5], tee: true }
};

/**
 * @param {object} o
 *  view 'dtl'|'fo'; fps container frames/s; tau slow-motion factor (capture fps = fps·tau); club 'iron'|'driver';
 *  shutter real exposure (s, capped by the capture interval); width, height native px; seed;
 *  ball 'flight' (default) | 'hidden' (invisible-ball control: never drawn after impact) | 'stays' (whiff:
 *  the club passes over a ball that never moves) | 'none' (practice swing, no ball);
 *  launchDeg, aziDeg, camDist (m), hand (±1), noise (luma σ), glint (0..1 scale), glove 'white'|'dark'|null,
 *  ferrule (bool), shirt luma, extraBall {x, z} (a second ball that stays), sky 'blue'|'overcast',
 *  impactPhase in (0, 1) (impact time inside its frame interval), preRealSec / postRealSec clip extent,
 *  mover {speed, angleDeg, before, after, dD0, lum} (a ball-sized object crossing the address at impact).
 */
export function makeImpactScene(o = {}) {
  const seed = o.seed ?? 1, r = rng(seed * 7919 + 17);
  const view = o.view ?? 'dtl', fps = o.fps ?? 60, tau = o.tau ?? 1, clubKind = o.club ?? 'iron', CL = CLUBS[clubKind];
  const portrait = o.orient ? o.orient === 'portrait' : true;
  const W = o.width ?? (portrait ? 540 : 960), H = o.height ?? (portrait ? 960 : 540);
  const hand = o.hand ?? 1, ballMode = o.ball ?? 'flight', noise = o.noise ?? r.range(1.6, 2.6);
  const capFps = fps * tau, shutter = Math.min(o.shutter ?? 1 / 1000, 1 / capFps);
  const X = v => [v[0] * hand, v[1], v[2]];  // mirror for left-handers

  // --- golfer and club geometry (right-handed frame, mirrored by X)
  const clubSpeed = o.clubSpeed ?? r.range(...CL.speed), smash = o.smash ?? r.range(...CL.smash);
  const keep = o.speedKeep ?? r.range(0.66, 0.8);  // club speed retained after impact
  const ballC0 = [0, R_BALL + (CL.tee ? 0.022 : 0), 0];
  const [st, sh, sd] = CL.semi;
  const Q0 = X([0, Math.max(sh, ballC0[1] - 0.004), -(R_BALL + sd + 0.001)]);  // head centre at impact: face on the ball's back
  const swingR = CL.radius + r.range(-0.06, 0.06);
  const planeDeg = r.range(50, 60);
  const pivot = add(Q0, X([swingR * Math.cos(planeDeg * DEG), swingR * Math.sin(planeDeg * DEG), 0]));
  const uAx = norm(sub(Q0, pivot)), vAx = norm(sub([0, 0, 1], mul(uAx, uAx[2]))), nAx = norm(cross(uAx, vAx));
  const R = Math.hypot(...sub(Q0, pivot));
  const whiffLift = ballMode === 'stays' ? 0.035 : 0;
  // swing timeline in real seconds: address, backswing, pause, downswing, impact at tI, follow-through
  const phiTop = -r.range(2.3, 2.7), omegaI = clubSpeed / R, Tdown = -3 * phiTop / omegaI;
  const Tback = r.range(0.75, 0.95), Tpause = r.range(0.04, 0.09), tauC = r.range(0.3, 0.4);
  const preReal = o.preRealSec ?? Math.max(1.6, Tback + Tpause + Tdown + 0.35);
  const postReal = o.postRealSec ?? 0.6;
  const phase = o.impactPhase ?? r.range(0.08, 0.92);
  const kI = Math.ceil(preReal * capFps);               // impact falls between frames kI and kI + 1
  const tI = (kI + phase) / capFps;                     // real time of impact (t_real = t_video / tau)
  const tTopEnd = tI - Tdown, tTop = tTopEnd - Tpause, tTake = tTop - Tback;
  const phiAt = t => {
    if (t <= tTake) return 0;
    if (t < tTop) return phiTop * smooth((t - tTake) / Tback);
    if (t < tTopEnd) return phiTop;
    if (t < tI) { const u = (t - tTopEnd) / Tdown; return phiTop * (1 - u * u * u); }
    return keep * omegaI * tauC * (1 - Math.exp(-(t - tI) / tauC));
  };
  const headAt = t => { const p = phiAt(t); return addS(addS(addS(pivot, uAx, R * Math.cos(p)), vAx, R * Math.sin(p)), [0, 1, 0], whiffLift); };
  const handR = 0.62 + r.range(-0.04, 0.04);
  const handsAt = t => { const p = 0.86 * phiAt(t); return addS(addS(pivot, uAx, handR * Math.cos(p)), vAx, handR * Math.sin(p)); };
  const loft = CL.loft * DEG, toe0 = X([-1, 0, 0]), face0 = [0, Math.sin(loft), Math.cos(loft)], up0 = norm(addS([0, 1, 0], face0, -face0[1]));
  const headFrame = t => { const p = phiAt(t); return [rotAbout(toe0, nAx, p), rotAbout(up0, nAx, p), rotAbout(face0, nAx, p)]; };
  // ball flight: speed smash·clubSpeed along the club path with launch elevation and azimuth; gravity + drag
  const launchDeg = o.launchDeg ?? r.range(...CL.launch), aziDeg = o.aziDeg ?? r.range(-4, 4);
  const vb = smash * clubSpeed, la = launchDeg * DEG, az = aziDeg * DEG;
  const v0 = [vb * Math.cos(la) * Math.sin(az), vb * Math.sin(la), vb * Math.cos(la) * Math.cos(az)];
  const kDrag = 1.2 * Math.PI * R_BALL * R_BALL * 0.25 / (2 * 0.04593), dtB = 1 / 2000, nB = Math.ceil((postReal + 0.1) / dtB) + 2;
  const ballTraj = new Float64Array(3 * nB);
  { let p = [...ballC0], v = [...v0];
    for (let i = 0; i < nB; i++) {
      ballTraj.set(p, 3 * i);
      const s = Math.hypot(...v);
      for (let j = 0; j < 3; j++) { const a = (j === 1 ? -G : 0) - kDrag * s * v[j]; v[j] += a * dtB; p[j] += v[j] * dtB; }
    } }
  const flying = t => ballMode !== 'stays' && ballMode !== 'none' && t > tI;
  const ballAt = t => {
    if (!flying(t)) return ballC0;
    const u = (t - tI) / dtB, i = Math.min(nB - 2, Math.floor(u)), f = Math.min(1, u - i);
    return [0, 1, 2].map(j => ballTraj[3 * i + j] * (1 - f) + ballTraj[3 * i + 3 + j] * f);
  };
  const ballDrawn = t => ballMode === 'flight' || ballMode === 'stays' || (ballMode === 'hidden' && t <= tI);

  // --- camera
  let cam;
  const fov = o.fovDeg ?? 69;
  if (view === 'dtl') {
    const D = o.camDist ?? r.range(2.6, 4.2), hc = r.range(1.05, 1.45), xc = X([r.range(0.1, 0.6), 0, 0])[0];
    cam = aimCamera(W, H, [xc, hc, -D], ballC0, W * r.range(0.44, 0.58), H * r.range(0.74, 0.84), fov);
  } else {
    const D = o.camDist ?? (portrait ? r.range(3.2, 4.6) : r.range(4.5, 7)), hc = r.range(0.8, 1.25);
    cam = aimCamera(W, H, X([-D, hc, r.range(-0.25, 0.25)]), ballC0, W * (portrait ? r.range(0.42, 0.56) : r.range(0.36, 0.5)) * (hand > 0 ? 1 : -1) + (hand > 0 ? 0 : W), H * r.range(0.72, 0.84), fov);
  }
  const addrP = cam.project(ballC0), d0 = 2 * cam.F * R_BALL / addrP.z;

  // --- appearance (luma)
  const sky = o.sky ?? (r.chance(0.3) ? 'overcast' : 'blue');
  const ballL = o.ballLuma ?? r.range(222, 240), shirtL = o.shirt ?? r.pick([235, 228, 60, 90, 140, 180, 110]);
  const gloveL = o.glove === null ? null : o.glove === 'dark' ? 70 : o.glove === 'white' || o.glove === undefined ? 238 : o.glove;
  const headL = o.headLuma ?? r.range(...CL.lum), shaftL = r.chance(0.6) ? r.range(160, 185) : r.range(35, 55);
  const glintScale = o.glint ?? 1, ferrule = o.ferrule ?? r.chance(0.4);
  const glints = [];
  const nG = Math.round(r.range(CL.glints[0], CL.glints[1] + 0.99) - 0.49);
  for (let i = 0; i < nG; i++) {
    glints.push({
      off: [r.range(-0.9, 0.95) * st, r.range(-0.7, 0.8) * sh],  // along toe and up (head-local m), inside the silhouette
      dM: r.range(...CL.glintD0) * 2 * R_BALL, phi0: r.range(-0.25, 0.3), width: r.range(0.05, 0.16), peak: r.range(0.7, 1)
    });
  }

  // --- static background (luma, float)
  const bg = new Float32Array(W * H);
  const horizonP = cam.project(add(cam.C, mul(norm([cam.f[0], 0, cam.f[2]]), 2000)));
  const hy = horizonP ? horizonP.y : H * 0.35;
  const cloud = valueNoise(r, 70), grass = valueNoise(r, 6), grass2 = valueNoise(r, 23), tree = valueNoise(r, 9);
  const treeH = r.range(10, 34) * (H / 960), skyTop = sky === 'overcast' ? r.range(200, 214) : r.range(128, 150), skyBot = sky === 'overcast' ? r.range(214, 228) : r.range(175, 196);
  const grassL = r.range(88, 118), stripeW = r.range(30, 70) * (W / 540);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v;
      const tree0 = hy - treeH * (0.55 + 0.45 * tree(x, 0));
      if (y < tree0) {
        const u = Math.max(0, Math.min(1, y / Math.max(1, tree0)));
        v = skyTop + (skyBot - skyTop) * u + (sky === 'overcast' ? 6 : 22) * (cloud(x, y) - 0.5);
      } else if (y < hy) v = 52 + 26 * tree(x * 1.7, y * 1.7);
      else {
        const stripe = Math.floor((x + (y - hy) * 0.4) / stripeW) % 2;
        v = grassL + 14 * (grass(x, y) - 0.5) + 10 * (grass2(x, y) - 0.5) + stripe * 7;
      }
      bg[y * W + x] = v;
    }
  }
  // tee, extra stationary ball, range balls: static, stamped into the background
  const L0 = makeLayer({ x0: 0, y0: 0, x1: W, y1: H, w: W });
  if (CL.tee) {
    const t0 = cam.project([0, 0.0, 0]), t1 = cam.project([0, ballC0[1] - R_BALL * 0.8, 0]);
    if (t0 && t1) { rasterCapsule(L0, t0, t1, Math.max(0.6, cam.F * 0.003 / t0.z), 1, 215); composite(L0, bg); }
  }
  const extra = o.extraBall ? cam.project([o.extraBall.x * hand, R_BALL, o.extraBall.z]) : null;
  if (extra) { rasterDisc(L0, extra.x, extra.y, cam.F * R_BALL / extra.z, 1, ballL - 6, 0.2); composite(L0, bg); }
  for (let i = 0; i < (o.rangeBalls ?? 3); i++) {
    const p = cam.project([r.range(-3, 3), R_BALL, r.range(2, 25)]);
    if (p && p.y > hy + 4 && p.x > 2 && p.x < W - 2 && p.y < H - 2 && Math.hypot(p.x - addrP.x, p.y - addrP.y) > 6 * d0) { rasterDisc(L0, p.x, p.y, cam.F * R_BALL / p.z, 1, 225, 0.2); composite(L0, bg); }
  }
  const shadowP = cam.project([0.012 * hand, 0.001, 0.018]);

  // --- body (slow): legs, hips, torso, head; the torso sways with the swing
  const body = t => {
    const p = phiAt(t), sway = 0.06 * Math.sin(Math.max(-1, Math.min(1, p / 2.6)) * 1.4);
    const hip = X([0.62, 0.92, 0.03 + sway * 0.5]), shoulder = X([0.5, 1.36, 0.02 + sway]), headC = X([0.43, 1.55, 0.04 + sway]);
    return { hip, shoulder, headC, footL: X([0.66, 0.05, 0.26]), footR: X([0.66, 0.05, -0.24]) };
  };
  const shoulderL = t => add(body(t).shoulder, X([0, 0, 0.14])), shoulderR = t => add(body(t).shoulder, X([0, 0, -0.14]));

  // Fast objects: each returns, for real time t, a drawable {kind, depth, ...} in image px.
  const pxR = (P, m) => cam.F * m / cam.project(P).z;
  const fastObjects = [];
  // arms (capsules from each shoulder to the hands)
  for (const shf of [shoulderL, shoulderR]) {
    fastObjects.push({ name: 'arm', lum: shirtL * 0.92, at: t => { const a = cam.project(shf(t)), b = cam.project(handsAt(t)); return a && b ? { k: 'cap', a, b, r: pxR(handsAt(t), 0.045), z: b.z } : null; } });
  }
  if (gloveL !== null) fastObjects.push({ name: 'glove', lum: gloveL, at: t => { const h = cam.project(handsAt(t)); return h ? { k: 'disc', x: h.x, y: h.y, r: pxR(handsAt(t), 0.05), z: h.z - 0.01 } : null; } });
  fastObjects.push({ name: 'shaft', lum: shaftL, at: t => { const a = cam.project(handsAt(t)), hd = headAt(t), [tt] = headFrame(t), b = cam.project(addS(hd, tt, -st * 0.75)); return a && b ? { k: 'cap', a, b, r: Math.max(0.55, pxR(hd, 0.0055)), z: b.z + 0.001 } : null; } });
  if (ferrule) fastObjects.push({ name: 'ferrule', lum: 236, at: t => { const hd = headAt(t), [tt] = headFrame(t), hs = addS(hd, tt, -st * 0.75), dir = norm(sub(handsAt(t), hs)), q = cam.project(addS(hs, dir, 0.06)); return q ? { k: 'disc', x: q.x, y: q.y, r: Math.max(0.6, pxR(hs, 0.0075)), z: q.z - 0.002 } : null; } });
  // a ball-sized mover crossing the address at impact on a straight image line (a glove, a hand, a rolling ball):
  // a pre-existing mover / precursor confounder. mover {speed (px per capture frame), angleDeg (image, y up),
  // before, after (capture frames around impact it is drawn), dD0 (diameter, d0), lum}
  if (o.mover) {
    const M = o.mover, ang = (M.angleDeg ?? 30) * DEG, vx = Math.cos(ang) * (M.speed ?? 20), vy = -Math.sin(ang) * (M.speed ?? 20);
    fastObjects.push({ name: 'mover', lum: M.lum ?? 236, at: t => {
      const u = (t - tI) * capFps;
      if (u < -(M.before ?? 6) || u > (M.after ?? 8)) return null;
      return { k: 'disc', x: addrP.x + vx * u, y: addrP.y + vy * u, r: 0.5 * (M.dD0 ?? 1) * d0, z: addrP.z - 0.3 };
    } });
  }
  fastObjects.push({ name: 'head', lum: headL, at: t => {
    const c = headAt(t), q = cam.project(c); if (!q) return null;
    const [tt, uu, ff] = headFrame(t), J = cam.jac(c);
    let S = [0, 0, 0];
    for (const [ax, s] of [[tt, st], [uu, sh], [ff, sd]]) {
      const a = J[0][0] * ax[0] + J[0][1] * ax[1] + J[0][2] * ax[2], b = J[1][0] * ax[0] + J[1][1] * ax[1] + J[1][2] * ax[2];
      S = [S[0] + a * a * s * s, S[1] + a * b * s * s, S[2] + b * b * s * s];
    }
    return { k: 'ell', x: q.x, y: q.y, S, z: q.z };
  } });
  glints.forEach((g, gi) => fastObjects.push({ name: 'glint', gi, lum: 252, at: t => {
    const p = phiAt(t), a = g.peak * glintScale * Math.exp(-0.5 * ((p - g.phi0) / g.width) ** 2);
    if (a < 0.03) return null;
    const c = headAt(t), [tt, uu] = headFrame(t), P = addS(addS(c, tt, g.off[0]), uu, g.off[1]);
    const q = cam.project(P); return q ? { k: 'disc', x: q.x, y: q.y, r: Math.max(0.5, cam.F * g.dM / 2 / q.z), z: q.z - 0.03, w: a } : null;
  } }));
  fastObjects.push({ name: 'ball', lum: ballL, shade: 0.22, at: t => {
    if (!ballDrawn(t)) return null;
    const P = ballAt(t), q = cam.project(P); return q ? { k: 'disc', x: q.x, y: q.y, r: cam.F * R_BALL / q.z, z: q.z } : null;
  } });

  // --- per-frame rendering
  const n = Math.ceil((tI + postReal) * capFps) + 1;
  const times = Float64Array.from({ length: n }, (_, k) => k / fps);
  const bank = noiseBank(), bankOff = (Math.imul(seed + 7, 0x9e3779b1) >>> 0) % BANK_N;
  const realOf = k => k / capFps;
  const sigLut = Float32Array.from({ length: 256 }, (_, v) => noise * Math.sqrt(0.35 + v / 255));
  let decoded = null;

  function renderRegion(k, out, x0, y0, x1, y1) {
    const reg = { x0, y0, x1, y1, w: x1 - x0 }, nPix = reg.w * (y1 - y0);
    const buf = new Float32Array(nPix), L = makeLayer(reg);
    for (let y = y0; y < y1; y++) buf.set(bg.subarray(y * W + x0, y * W + x1), (y - y0) * reg.w);
    const tr = realOf(k);
    // slow body parts at mid-exposure
    const B = body(tr);
    for (const f of [B.footL, B.footR]) { const a = cam.project(B.hip), b = cam.project(f); if (a && b) rasterCapsule(L, a, b, pxR(B.hip, 0.075), 1, 52); }
    composite(L, buf);
    { const a = cam.project(B.hip), b = cam.project(B.shoulder); if (a && b) rasterCapsule(L, a, b, pxR(B.shoulder, 0.17), 1, shirtL); }
    composite(L, buf);
    { const h = cam.project(B.headC); if (h) rasterDisc(L, h.x, h.y, pxR(B.headC, 0.105), 1, 150, 0.1); }
    composite(L, buf);
    // address shadow while the ball sits there
    if (shadowP && ballDrawn(tr) && !flying(tr) && ballMode !== 'none') { rasterDisc(L, shadowP.x, shadowP.y, d0 * 0.55, 1, 0); composite(L, buf, 0.35); }
    // fast parts: temporal supersampling over the exposure, painted far to near (depth at mid-exposure)
    const objs = [];
    for (const ob of fastObjects) { const s = ob.at(tr); if (s) objs.push({ ob, z: s.z }); }
    objs.sort((p, q) => q.z - p.z);
    const e = shutter;
    for (const { ob } of objs) {
      const a = ob.at(tr - e / 2), b = ob.at(tr + e / 2), m = ob.at(tr);
      const pa = a ? (a.a ? a.b : a) : m, pb = b ? (b.a ? b.b : b) : m, pm = m.a ? m.b : m;
      const disp = Math.hypot(pb.x - pm.x, pb.y - pm.y) + Math.hypot(pm.x - pa.x, pm.y - pa.y);
      const slowPart = ob.name === 'shaft' || ob.name === 'arm';
      const NS = Math.max(1, Math.min(slowPart ? 40 : 320, Math.ceil(disp / (slowPart ? 2 : 0.5))));
      for (let s = 0; s < NS; s++) {
        const sh = ob.at(NS === 1 ? tr : tr + (s / (NS - 1) - 0.5) * e);
        if (!sh) continue;
        const w = (sh.w ?? 1) / NS;
        if (sh.k === 'disc') rasterDisc(L, sh.x, sh.y, sh.r, w, ob.lum, ob.shade);
        else if (sh.k === 'ell') rasterEllipse(L, sh.x, sh.y, sh.S, w, ob.lum);
        else rasterCapsule(L, sh.a, sh.b, sh.r, w, ob.lum);
      }
      composite(L, buf);
    }
    // luma-dependent sensor noise from the bank at a per-frame offset; quantize
    const off = (bankOff + (Math.imul(k + 1, 2654435761) >>> 0)) % BANK_N;
    for (let y = y0; y < y1; y++) {
      const o = (y - y0) * reg.w - x0, ob = y * W;
      for (let x = x0; x < x1; x++) {
        const v = buf[o + x], q = Math.round(v + sigLut[v < 0 ? 0 : v > 255 ? 255 : v | 0] * bank[(off + ob + x) & (BANK_N - 1)]);
        out[ob + x] = q < 0 ? 0 : q > 255 ? 255 : q;
      }
    }
  }

  const frame = k => {
    if (decoded?.has(k)) return decoded.get(k).slice();
    const out = new Uint8Array(W * H);
    renderRegion(k, out, 0, 0, W, H);
    return out;
  };
  // crop(k, rect, pool): render only the in-frame part of the rect, then cropLuma (exact edge-clamp semantics).
  const scratch = new Uint8Array(W * H);
  const crop = (k, rect, pool = 1) => {
    const x0 = Math.max(0, Math.min(W - 1, rect.x)), y0 = Math.max(0, Math.min(H - 1, rect.y));
    const x1 = Math.max(x0 + 1, Math.min(W, rect.x + rect.w)), y1 = Math.max(y0 + 1, Math.min(H, rect.y + rect.h));
    if (decoded?.has(k)) return cropLuma(decoded.get(k), W, H, rect, pool);
    renderRegion(k, scratch, x0, y0, x1, y1);
    return cropLuma(scratch, W, H, rect, pool);
  };

  // --- ground truth (display px, mid-exposure)
  const kLastTrue = Math.floor(tI * capFps);  // last frame whose mid-exposure precedes impact
  const ballGt = k => {
    const t = realOf(k), P = ballAt(t), q = cam.project(P);
    if (!q) return null;
    const qa = cam.project(ballAt(t - shutter / 2)), qb = cam.project(ballAt(t + shutter / 2));
    return { x: q.x, y: q.y, d: 2 * cam.F * R_BALL / q.z, blur: qa && qb ? Math.hypot(qb.x - qa.x, qb.y - qa.y) : 0,
      inFrame: q.x >= 0 && q.x < W && q.y >= 0 && q.y < H, flying: flying(t), drawn: ballDrawn(t) };
  };
  const clubGt = k => {
    const t = realOf(k), h = fastObjects.find(f => f.name === 'head').at(t);
    if (!h) return null;
    const ev = Math.sqrt((h.S[0] + h.S[2]) / 2 + Math.sqrt(((h.S[0] - h.S[2]) / 2) ** 2 + h.S[1] ** 2));
    const parts = [{ x: h.x, y: h.y }];
    for (const name of ['glint', 'ferrule', 'glove']) for (const f of fastObjects.filter(q => q.name === name)) { const s = f.at(t); if (s) parts.push({ x: s.x, y: s.y, name }); }
    return { x: h.x, y: h.y, size: 2 * ev, heightPx: 2 * Math.sqrt(Math.min(h.S[0], h.S[2])), parts };
  };
  const meta = makeSourceMeta({ width: W, height: H, fps, frameCount: n, times, duration: n / fps, path: 'memory' });

  return {
    meta, width: W, height: H, fps, tau, view, club: clubKind, seed, shutter, d0, noise,
    gt: {
      address: { x: addrP.x, y: addrP.y }, d0, tImpact: tI * tau, kImpact: kLastTrue, phase, launchDeg, aziDeg, clubSpeed, smash, keep,
      ballAt: ballGt, clubAt: clubGt, takeaway: { t: tTake * tau, k: Math.floor(tTake * capFps) }, hands: k => cam.project(handsAt(realOf(k))),
      gloveD: gloveL === null ? 0 : 2 * pxR(handsAt(tTake), 0.05), extra
    },
    frame, crop,
    /**
     * ImpactHypothesis fields as findImpacts would report them for a coarse k_last (for makeImpact): the interval is
     * impact.js's, so it carries the coarse scan's timing tolerance. over.kLast may be off the true one (shift tests);
     * over.params picks the interval's params.
     */
    hypothesis(over = {}) {
      const kLast = over.kLast ?? kLastTrue, kFA = over.kFirstAbsent ?? kLast + 1;
      const base = {
        id: 'h0', spotId: 's0', address: { x: addrP.x, y: addrP.y }, d0, polarity: 1, kLast, tLast: kLast / fps, kFirstAbsent: kFA,
        tFirstAbsent: kFA / fps, interval: impactInterval(meta, kLast, kFA, over.params ?? PARAMS), t0Est: (kLast + kFA) / 2 / fps
      };
      const { params: _p, ...rest } = over;
      return { ...base, ...rest, address: over.address ?? base.address };
    },
    source() { return createMemorySource({ width: W, height: H, frames: k => frame(k), frameCount: n, times, fps }); },
    /** Replace frames [from, to) by an x264 round trip (gray -> yuv420p -> gray). Returns false without ffmpeg. */
    encode(from, to, { crf = 23, preset = 'veryfast', ffmpeg = process.env.FFMPEG ?? 'ffmpeg' } = {}) {
      const ks = []; for (let k = Math.max(0, from); k < Math.min(n, to); k++) ks.push(k);
      const raw = Buffer.concat(ks.map(k => Buffer.from(frame(k).buffer)));
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-g', '60', '-bf', '2', '-pix_fmt', 'yuvj420p', '-f', 'h264', '-'];
      const enc = spawnSync(ffmpeg, args, { input: raw, maxBuffer: 1 << 30 });
      if (enc.status !== 0 || !enc.stdout?.length) return false;
      const dec = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { input: enc.stdout, maxBuffer: 1 << 30 });
      if (dec.status !== 0) return false;
      const out = dec.stdout, fsz = W * H;
      if (out.length < fsz * ks.length) return false;
      decoded = new Map();
      ks.forEach((k, i) => decoded.set(k, new Uint8Array(out.buffer.slice(out.byteOffset + i * fsz, out.byteOffset + (i + 1) * fsz))));
      return true;
    }
  };
}

function valueNoise(r, scale) {
  const N = 64, g = Float32Array.from({ length: N * N }, () => r());
  return (x, y) => {
    const gx = x / scale, gy = y / scale, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const at = (i, j) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
  };
}

/** Is p (stabilized = display px for a static camera) on the GT ball at frame k? Tolerance max(2 px, 0.75·d) + blur/4. */
export function onBall(scene, k, p) {
  const b = scene.gt.ballAt(k);
  if (!b) return false;
  return Math.hypot(p.x - b.x, p.y - b.y) <= Math.max(2, 0.75 * b.d) + 0.25 * b.blur;
}
/** Is p on a club part (head, glints, ferrule, glove) at frame k and not on the ball? */
export function onClub(scene, k, p) {
  const c = scene.gt.clubAt(k);
  if (!c || onBall(scene, k, p)) return false;
  return c.parts.some(q => Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(c.size, 2 * scene.d0));
}
