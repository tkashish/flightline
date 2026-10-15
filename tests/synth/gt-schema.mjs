// Ground truth (<id>.gt.json) and the phase-1 harness annotation derived from it. All image coordinates are
// upright display pixels; every time `t` is a frame PTS in seconds (output timeline), `tc`/`tReal` is capture time.
import { DEG } from './math.mjs';
import { project, makeView } from './camera.mjs';
import { BALL, ballAt } from './ball-physics.mjs';

export const SCHEMA = 'flightline-synth-gt-v1';
const r3 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
/** Numbers rounded to 1e-3 inside nested arrays and objects; other values kept. */
const round = v => (typeof v === 'number' ? r3(v) : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);

/** Output time <-> capture time through the frame list (monotone, dups skipped); extrapolates at the ends. */
export function timeMaps(frames, tau) {
  const pts = frames.filter(f => f.dupOf == null);
  const toOut = tc => {
    if (tc <= pts[0].tc) return pts[0].t + (tc - pts[0].tc) * tau;
    for (let i = 1; i < pts.length; i++) if (tc <= pts[i].tc) { const a = pts[i - 1], b = pts[i]; return a.t + (b.t - a.t) * (tc - a.tc) / (b.tc - a.tc); }
    const l = pts.at(-1); return l.t + (tc - l.tc) * tau;
  };
  return { toOut };
}

export function arcAndLanding(world, frames) {
  const fl = world.flight; if (!fl) return { arc2d: [], landing: null, trajectory3d: [] };
  const { toOut } = timeMaps(frames, world.timeline.tau), tcLast = frames.at(-1).tc, W = world.intr.W, H = world.intr.H;
  const view = tr => makeView(world.intr, world.place.C, world.motion(Math.min(tr, tcLast)));
  const tLand = fl.landing ? fl.landing.t : fl.tEnd, step = 1 / world.timeline.fpsOut / world.timeline.tau, arc2d = [];
  for (let tr = 0; tr <= tLand + 1e-9; tr += step) {
    const P = ballAt(fl, tr), q = project(view(tr), P);
    arc2d.push({ t: r3(toOut(tr)), tReal: r3(tr), x: r3(q.x), y: r3(q.y), inFrame: q.z > 0 && q.x >= 0 && q.y >= 0 && q.x < W && q.y < H, diam: r3(BALL.d * q.ppm), h: r3(P[1] - BALL.r) });
  }
  let landing = null;
  if (fl.landing) {
    const q = project(view(fl.landing.t), fl.landing.p);
    landing = { t: r3(toOut(fl.landing.t)), tReal: r3(fl.landing.t), x: r3(q.x), y: r3(q.y), inFrame: q.z > 0 && q.x >= 0 && q.y >= 0 && q.x < W && q.y < H, carryM: r3(fl.carryM), angleDeg: r3(fl.landing.angleDeg), p: fl.landing.p.map(r3) };
  }
  const trajectory3d = [];
  for (let tr = 0; tr <= tLand + 1e-9; tr += 0.01) trajectory3d.push([r3(tr), ...ballAt(fl, tr).map(v => Math.round(v * 1e4) / 1e4)]);
  return { arc2d, landing, trajectory3d };
}

/** Visibility label used for the harness: the decoded-video oracle SNR when present, else the clean-render SNR. */
export function frameStatus(f) {
  const b = f.ball; if (!b || !b.inFrame) return 'not_visible';
  if (b.occluded) return 'occluded';
  const s = b.snrCoded ?? b.expectedSnr * 0.6;
  return s >= 3 ? 'visible' : s >= 1.5 ? 'uncertain' : 'not_visible';
}

export function harnessAnnotation(gt) {
  const fr = gt.frames, imp = gt.impact, exp = gt.expected, out = {};
  if (exp === 'abstain') return { expectAbstention: true, ballVisible: false, notes: `synthetic ${gt.meta.kind}: no ball leaves` };
  if (!imp) return { ballVisible: false };
  out.impactT = imp.t0;
  const post = fr.filter(f => f.t >= imp.t0 - 1e-6 && f.dupOf == null), pre = fr.filter(f => f.t < imp.t0 - 1e-6 && f.ball?.x != null);
  const labels = post.map(f => { const s = frameStatus(f); return s === 'visible' ? { t: f.t, status: s, x: f.ball.x, y: f.ball.y } : { t: f.t, status: s }; });
  const lastPossible = post.filter(f => f.ball?.inFrame && !f.ball.occluded && (f.ball.snrCoded ?? f.ball.expectedSnr * 0.6) >= 1.5).at(-1);
  if (lastPossible) out.lastVisibleT = lastPossible.t;
  // No addressBall.t: the harness then anchors on the track's first observed point instead of interpolating at a
  // native pre-impact time that a 30 Hz track may straddle. The launch tolerance scales with the ball and resolution.
  const L = Math.max(gt.meta.video.width, gt.meta.video.height);
  out.maxLaunchErrorPx = Math.round(Math.min(0.035 * L, Math.max(0.012 * L, 4 * (imp.ballDiameterPx || 0))) * 10) / 10;
  if (exp === 'trace') {
    const a = pre.at(-1); if (a) out.addressBall = { x: a.ball.x, y: a.ball.y };
    out.frames = labels;
  } else out.frames = labels.map(l => (l.status === 'visible' ? { t: l.t, status: 'uncertain' } : l));
  // Distractor labels only where they are a real identity test: away from the true ball at that frame
  // (the harness switch radius is 2% of the long edge), and the club head only after impact.
  const ds = [], seen = new Map(), tau = gt.meta.video.playbackFactor, W = gt.meta.video.width, H = gt.meta.video.height, far = 0.03 * Math.max(W, H);
  const away = (f, x, y) => !(f.ball?.x != null && Math.hypot(f.ball.x - x, f.ball.y - y) < far);
  for (const f of fr) {
    if (f.club?.inFrame && f.t > imp.t0 && f.t - imp.t0 <= 0.15 * tau && away(f, f.club.x, f.club.y)) ds.push({ label: 'club_head', t: f.t, x: f.club.x, y: f.club.y });
    for (const d of f.distractors || []) {
      const key = `${d.type}:${d.id}`, last = seen.get(key) ?? -1e9, every = d.type === 'glint' || d.type === 'neighbor_ball' ? 0.08 : 0.25;
      if (d.type === 'turf' || d.x < 0 || d.y < 0 || d.x >= W || d.y >= H || f.t - last < every * tau || !away(f, d.x, d.y)) continue;
      seen.set(key, f.t); ds.push({ label: d.type === 'glint' ? 'club_glint' : d.type, t: f.t, x: d.x, y: d.y });
    }
  }
  out.distractors = ds;
  return out;
}

export function assembleGt(world, frames, extra) {
  const spec = world.spec, tl = world.timeline, fl = world.flight, W = world.intr.W, H = world.intr.H;
  const { toOut } = timeMaps(frames, tl.tau);
  let impact = null;
  if (fl) {
    const k = frames.findIndex(f => f.tc >= 0), last = frames[Math.max(0, k - 1)], t0 = toOut(0);
    const q = project(makeView(world.intr, world.place.C, world.motion(0)), world.ballStart);
    impact = { t0: r3(t0), tReal: 0, frame: k < 0 ? null : k, lastAddressFrame: k <= 0 ? null : k - 1, address: { x: r3(q.x), y: r3(q.y) }, ballDiameterPx: r3(BALL.d * q.ppm), addressFrameBall: last?.ball ? { x: last.ball.x, y: last.ball.y } : null };
  }
  const { arc2d, landing, trajectory3d } = arcAndLanding(world, frames);
  const P = world.plan.params, shot = world.shot;
  return {
    schema: SCHEMA, id: spec.id, split: spec.split, seed: spec.seed, scenario: spec.scenario, styleShift: !!spec.styleShift,
    expected: extra.expected, failureModes: extra.failureModes,
    generator: extra.generator,
    meta: {
      kind: spec.kind, factors: extra.factors,
      video: { file: extra.file, container: extra.encode.container, codec: extra.encode.codec, mbps: extra.encode.mbps, gop: extra.encode.gop, bframes: extra.encode.bframes, width: W, height: H, codedWidth: extra.probe.codedWidth, codedHeight: extra.probe.codedHeight, rotation: extra.probe.rotation, fpsOut: tl.fpsOut, captureFps: spec.capture.fps, playbackFactor: tl.tau, slowmo: !!spec.capture.slowmo, frameCount: frames.length, durationS: r3(frames.at(-1).t + 1 / tl.fpsOut), vfr: tl.vfr, droppedAfter: tl.drops, duplicateFrames: tl.dups, ptsTimescale: 90000, ptsVerified: extra.ptsVerified, audio: extra.audio, captureFpsTag: extra.encode.captureFpsTag },
      intrinsics: { f: r3(world.intr.f), cx: world.intr.cx, cy: world.intr.cy, k1: r3(world.intr.k1), distortion: 'x_d = x_n (1 + k1 r_n^2 / r_corner^2), r_corner = half-diagonal / f', rCorner: r3(Math.sqrt(world.intr.rc2)), fovLongDeg: r3(world.intr.fovLongDeg), lens: spec.lens },
      camera: { position: world.place.C.map(r3), low: !!world.place.low, yawDeg: r3(world.place.yaw / DEG), pitchDeg: r3(world.place.pitch / DEG), rollDeg: r3(world.place.roll / DEG), view: spec.view, shake: world.shake, pan: world.pan, zoom: world.zoom, exposureS: r3(world.sensor.exposure * 1e6) / 1e6, rollingShutter: world.sensor.rs, extrinsics: 'frames[].cam: yaw/pitch/roll degrees and zoom factor at the frame capture time; position fixed' },
      sun: { azDeg: r3(world.scene.sunAz), elDeg: r3(world.scene.sunEl), intensity: r3(world.scene.light.sunI) }, sky: spec.sky, ground: spec.ground,
      shot: shot && { club: shot.club, ballSpeed: r3(shot.speed), launchDeg: r3(shot.launchDeg), azimuthDeg: r3(shot.azimuthDeg), spinRpm: Math.round(shot.spinRpm), axisTiltDeg: r3(shot.axisTiltDeg), smash: r3(shot.smash), clubSpeed: r3(world.headSpeed), carryM: r3(fl?.carryM), apexM: r3(fl?.apex), flightS: r3(fl?.landing?.t), wind: world.env.wind, rho: r3(world.env.rho), landingHeightM: r3(world.env.landingHeight) },
      golfer: { hand: world.golfer.hand > 0 ? 'right' : 'left', heightM: r3(world.golfer.height), look: world.golfer.look, club: world.plan.club, clubLook: world.plan.look, swing: { ...round(P), times: round(world.plan.times) } },
      neighbor: world.neighbor && { start: world.neighbor.start.map(r3), tImpactReal: r3(world.neighbor.tImpact), tImpact: r3(toOut(world.neighbor.tImpact)), club: world.neighbor.shot.club, drawGolfer: world.neighbor.drawGolfer, crossing: world.neighbor.crossing },
      nudge: world.nudge && { t0Real: r3(world.nudge.t0), durS: r3(world.nudge.dur), offsetM: world.nudge.d.map(r3) },
      bayPosts: world.D.bayPosts.map(p => ({ x: r3(p.x), z: r3(p.z), h: r3(p.h) })),
      anchoredDistractors: [world.D.plane?.anchored && 'airplane', world.D.birds[0]?.anchored && 'bird', world.D.insects[0]?.anchored && 'insect', world.D.specks[0]?.anchored && 'speck', world.neighbor?.crossing && 'neighbor_ball'].filter(Boolean),
      lensSpecks: world.D.specks.map(s => ({ x: r3(s.x), y: r3(s.y), rad: r3(s.rad), gain: r3(s.gain) })),
      rawSha256: extra.rawSha256
    },
    impact, landing, arc2d, trajectory3d, frames
  };
}
