// Scenario matrix: factor tables, jointly stratified split plans (tune, holdout with a 30% style-shifted subset, smoke,
// easy), the D3 failure-mode catalog F1-F34, and tags / expected outcome derived from realized ground truth.
import { rngFor, hash32, DEG } from './math.mjs';
import { viewClass, makeView, project } from './camera.mjs';
import { BALL, ballAt } from './ball-physics.mjs';
import { SUNNY } from './world.mjs';

export const CAPTURES = { 30: { fps: 30 }, 60: { fps: 60 }, 120: { fps: 120 }, 240: { fps: 240 }, '120s': { fps: 120, slowmo: true }, '240s': { fps: 240, slowmo: true } };
export const SPLITS = { tune: { seeds: [1, 400] }, holdout: { seeds: [100001, 100300], styleShift: 0.3 }, easy: { seeds: [800001, 800022] } };

/** Failure modes (D3 sec. 1.2) and how the generator realizes each; "proxy" rows stand in for tracker-internal bugs. Tags come from GT. */
export const FAILURE_MODES = {
  F1: 'club head passes the address at impact, visible in frame', F2: 'white shirt/glove/shoes on the golfer in frame, or chrome club glints',
  F3: 'practice swing or whiff: no ball leaves (expect abstain)', F4: 'extra balls, ball pile, or a tee at the address, in frame',
  F5: 'faint ball: median flight SNR < 6 or the ball darker than its background', F6: 'ball seen against a blue sky', F7: 'ball seen against trees or ground clutter',
  F8: 'airplane, bird, insect, lens speck or neighbour ball within 5% of the long edge of the ball', F9: 'nets, poles, flags or bay posts in frame, or a net in front of the lens',
  F10: 'camera shake, pan or digital zoom realized in the clip', F11: 'slow motion (capture 120/240 fps stamped at 30 fps)', F12: 'VFR timestamps, duplicated or dropped frames',
  F13: 'face-on launch at <= 30 degrees in the image', F14: 'ball leaves the frame while airborne', F15: 'apex visible in frame', F16: 'ball occluded in flight (golfer, pole, net)',
  F17: 'ball fades to SNR < 2 while airborne in frame', F18: 'proxy: curved or gapped observed path (smoothing must keep interior points)',
  F19: 'proxy: a launch-like event inside the clip before the real launch (practice swing beside the ball, neighbour launch in frame, nudged ball in view)', F20: 'proxy: larger bright movers near the launch within 0.15 s of impact (ball-sized glint, flying tee, divot, white glove)',
  F21: 'proxy: abstain/either clips where a fallback would wrongly trace', F22: 'proxy: abstain-or-assist clips where manual adjust is the user route',
  F23: 'draw, fade, hook or slice (spin-axis tilt >= 8 degrees)', F24: 'landing visible in clip or landing terrain above/below the tee',
  F25: 'auto-exposure drift over 6% within the clip', F26: 'low-bitrate compression smears the ball', F27: 'rolling shutter skew', F28: 'long exposure motion-blur streaks at launch',
  F29: 'display-rotation metadata (coded frames rotated)', F30: 'left-handed golfer', F31: 'second shot in frame (neighbour ball visible)',
  F32: 'address ball visible in at most two frames (clip starts at impact)', F33: 'divot/turf spray (also turf brushed by a practice swing) or flying tee in frame', F34: 'clip ends before landing'
};

const TUNE = {
  viewClass: { dtl: 45, fo: 33, oblique: 22 },
  capture: { 30: 22, 60: 28, 120: 10, 240: 10, '120s': 15, '240s': 15 },
  club: { driver: 30, iron7: 31, wedge: 24, topped: 5, practice: 6, whiff: 4 },
  sky: { blue: 56, overcast: 20, haze: 13, sunset: 11 },
  ground: { grass: 60, mat: 40 },
  format: { p1080: 62, p4k: 7, l1080: 19, p720: 12 }
};
/** At most CAP confounders per clip (shake and minor scenery count; codec and rotation are format factors); a stress stratum stacks more. */
export const CAP = 3, STRESS = { share: 0.08, min: 5, max: 7 }, MIN_CELL = 12;
const tauOf = s => (s.capture.slowmo ? s.capture.fps / 30 : 1);
const CONF = [
  // [name, share of applicable clips, minimum per split, applies(spec)]; most constrained first.
  ['hiddenAddress', 0.04, 16, s => s.kind === 'hit'],
  ['nudge', 0.05, 16, s => s.kind === 'hit' && !s.confounders.hiddenAddress && s.impactOut / tauOf(s) >= 1.5],
  // D2's "practice swing first": real-time 30/60 fps hits whose clip starts before a practice swing beside the ball.
  ['practiceFirst', 0.15, 16, s => s.kind === 'hit' && !s.capture.slowmo && s.capture.fps <= 60 && !s.confounders.hiddenAddress && !s.confounders.nudge],
  ['neighbor', 0.08, 24, s => s.kind === 'hit'],
  ['glint', 0.45, 18, s => (s.club === 'iron7' || s.club === 'wedge') && SUNNY.has(s.sky)],
  ['occludePole', 0.04, 14, s => s.kind === 'hit'], ['longExposure', 0.04, 14, s => s.kind === 'hit'],
  ['vfr', 0.04, 8, s => !s.capture.slowmo], ['dups', 0.03, 7, s => !s.capture.slowmo], ['drops', 0.03, 7, s => !s.capture.slowmo],
  ['lowBitrate', 0.05, 14], ['ae', 0.05, 14], ['rs', 0.07, 16], ['pan', 0.04, 12, s => s.lens !== 'ultra'], ['zoom', 0.03, 10, s => s.lens !== 'ultra'],
  ['plane', 0.06, 16], ['birds', 0.07, 16], ['insect', 0.03, 10], ['specks', 0.05, 14], ['people', 0.04, 8],
  ['white', 0.1, 16], ['netFront', 0.03, 10], ['multiball', 0.06, 12], ['pile', 0.05, 10],
  ['divot', 0.4, 16, s => s.kind === 'hit' && s.ground === 'grass' && (s.club === 'iron7' || s.club === 'wedge')],
  ['bay', 0.08, 12], ['flags', 0.1, 0], ['poles', 0.12, 0], ['nets', 0.1, 0],
  ['rotated', 0.25, 0, s => s.format.H > s.format.W], ['hevc', 0.25, 0]
];
const FORMAT_ONLY = new Set(['rotated', 'hevc', 'neighborT', 'neighborCross']);
export const confounderCount = cf => Object.entries(cf || {}).filter(([k, v]) => v && !FORMAT_ONLY.has(k)).length;

/** n levels in proportion to the weights, ordered so every contiguous run is near proportional (systematic sampling). */
function spread(weights, n, r) {
  const e = Object.entries(weights), tot = e.reduce((s, [, w]) => s + w, 0), cnt = e.map(([k, w]) => [k, Math.floor(n * w / tot), (n * w / tot) % 1]);
  let left = n - cnt.reduce((s, c) => s + c[1], 0);
  [...cnt].sort((a, b) => b[2] - a[2]).forEach(c => { if (left > 0) { c[1]++; left--; } });
  return cnt.flatMap(([k, c]) => { const u = r.next(); return Array.from({ length: c }, (_, j) => [(j + u) / c, k]); }).sort((a, b) => a[0] - b[0]).map(p => p[1]);
}
/** View x capture cells in proportion to the product of the marginals, each with at least MIN_CELL clips. */
function jointCells(n) {
  const V = Object.entries(TUNE.viewClass), Cs = Object.entries(TUNE.capture), tv = V.reduce((a, [, w]) => a + w, 0), tc = Cs.reduce((a, [, w]) => a + w, 0);
  const cells = V.flatMap(([v, a]) => Cs.map(([c, b]) => ({ v, c, w: (a / tv) * (b / tc) }))), k = cells.map(x => Math.max(MIN_CELL, Math.floor(n * x.w)));
  for (let tot = k.reduce((a, b) => a + b, 0); tot !== n;) {
    const dn = tot > n; let best = -1, sc = -Infinity;
    k.forEach((m, i) => { const d = dn ? m - n * cells[i].w : n * cells[i].w - m; if ((!dn || m > MIN_CELL) && d > sc) { sc = d; best = i; } });
    k[best] += dn ? -1 : 1; tot += dn ? -1 : 1;
  }
  return cells.map((x, i) => ({ ...x, n: k[i] }));
}
const FORMATS = { p1080: { W: 1080, H: 1920 }, p4k: { W: 2160, H: 3840 }, l1080: { W: 1920, H: 1080 }, p720: { W: 720, H: 1280 } };

/** Choices that confounder applicability depends on (kind, lens, shifted sky, timing). Idempotent. */
function prePlan(s) {
  const p = rngFor(s.seed, 'pre'), cf = s.confounders ||= {}, c = s.capture, fps = c.fps;
  if (s.club === 'practice' || s.club === 'whiff') s.kind ??= s.club;
  s.kind ??= 'hit';
  s.lens ??= s.styleShift && p.chance(0.5) ? p.pick(['tele', 'mainShift', 'ultra']) : p.chance(0.1) ? 'ultra' : 'main';
  if (s.styleShift && s.skyShift == null) { const q = rngFor(s.seed, 'sky'); s.skyShift = q.chance(0.6); if (s.skyShift) s.sky = q.pick(['dusk', 'teal', 'violet']); }
  if (!s.durationOut) {
    const d = rngFor(s.seed, 'duration');
    if (c.slowmo) { s.durationOut = d.range(5, 8); s.impactOut = d.range(fps === 240 ? 1 : 1.2, fps === 240 ? 3 : 3.5); }
    else {
      // Real time: a short lead-in, or (a share, fewer at high rates) 2-5 s of setup with the waggles and forward press.
      const [i0, i1, share, l1, p0, p1] = fps >= 240 ? [1.1, 1.6, 0.2, 3, 1, 2] : fps >= 120 ? [1.2, 2, 0.3, 3.5, 1.3, 2.8] : [1.3, 2.8, 0.45, 5, 1.5, 4.5];
      s.impactOut = d.chance(share) ? d.range(2, l1) : d.range(i0, i1); s.durationOut = s.impactOut + d.range(p0, p1);
    }
    s.durationOut = Math.round(s.durationOut * 100) / 100; s.impactOut = Math.round(s.impactOut * 1000) / 1000;
  }
  // Practice swing first: the clip starts 5.8-7.5 s before impact so the practice swing, the step in and the setup are in it.
  if (cf.practiceFirst && s.impactOut < 5.8) { const post = s.durationOut - s.impactOut; s.impactOut = Math.round(rngFor(s.seed, 'practice-first').range(5.8, 7.5) * 1000) / 1000; s.durationOut = Math.round((s.impactOut + post) * 100) / 100; }
  // Hidden address: the clip starts at most one capture interval before impact.
  if (cf.hiddenAddress) { cf.hiddenAddress = 'start'; s.impactOut = Math.min(s.impactOut, Math.round(rngFor(s.seed, 'start').range(0.2, 1) / (c.slowmo ? 30 : fps) * 1e6) / 1e6); }
  return s;
}

/** Fills every per-clip choice not fixed by stratification from the clip's own seed. Clean and easy clips are genuinely easy. */
export function completeSpec(s) {
  const r = rngFor(s.seed, 'spec'), shifted = !!s.styleShift, cf = s.confounders ||= {}, easy = !!(s.clean || s.easy);
  if (easy) {
    // Blue sky, sun behind (scene), exposure <= 1/2000 s and tripod (world), main lens, 1080p portrait, standard h264.
    Object.assign(s, { hand: 1, sky: 'blue', lens: 'main', yellowBall: false, cloudDrift: false, styleShift: false });
    s.format = { W: 1080, H: 1920, rotation: 0 }; s.encode = { codec: 'h264', container: 'mp4', lowBitrate: false, rateK: 1, ...s.encode }; s.audio ??= 'aligned';
    for (const k of Object.keys(cf)) delete cf[k];
    cf.shake = 0;
  }
  prePlan(s);
  s.hand ??= r.chance(0.25) ? -1 : 1;
  if (!s.view) s.view = s.viewClass === 'dtl' ? r.weighted(easy ? { 'dtl-ball': 1 } : { 'dtl-ball': 35, 'dtl-hands': 40, 'dtl-offset': 25 }) : s.viewClass === 'fo' ? 'face-on' : 'oblique';
  if (s.club === 'practice' || s.club === 'whiff') { s.kind = s.club === 'whiff' ? 'whiff' : r.chance(0.3) ? 'practice-noball' : 'practice'; s.club = r.pick(['driver', 'iron7', 'wedge']); }
  if (s.club === 'topped') s.toppedWith ??= r.pick(['driver', 'iron7']);
  const c = s.capture, fps = c.fps, tr = rngFor(s.seed, 'timing');
  // Timestamp confounders live on the capture (the timeline reads them there); own RNG stream so other choices are unchanged.
  if (cf.vfr) c.vfr = true;
  if (cf.drops) c.drops ??= tr.int(1, 4);
  if (cf.dups) c.dups ??= tr.int(1, 5);
  if ((fps >= 240 || c.slowmo) && s.format.W * s.format.H > 2.1e6) s.format = { ...FORMATS.p1080, rotation: s.format.rotation };
  s.ground ??= 'grass';
  s.trees ??= r.chance(0.85);
  s.tee ??= (s.toppedWith || s.club) === 'driver' ? (r.chance(0.3) ? 'flies' : 'stays') : r.chance(0.15) ? 'stays' : 'none';
  if (s.kind !== 'hit' && s.tee === 'flies') s.tee = 'stays';
  s.yellowBall ??= r.chance(0.05);
  s.cloudDrift ??= r.chance(0.5);
  cf.shake ??= r.weighted({ 0: 35, 1: 45, 2: 20 }) | 0;
  if (cf.neighbor) cf.neighborT ??= null;
  s.format.rotation ??= cf.rotated ? r.weighted({ 90: 6, '-90': 3, 180: 1 }) | 0 : 0;
  if (cf.rotated) s.format.rotation = Number(s.format.rotation) || 90;
  const e = s.encode ||= {};
  e.codec ??= cf.hevc ? 'hevc' : 'h264'; e.container ??= r.chance(0.45) ? 'mov' : 'mp4';
  e.lowBitrate ??= !!cf.lowBitrate; e.lowFactor ??= shifted && r.chance(0.5) ? r.range(0.06, 0.12) : r.range(0.15, 0.3);
  e.rateK ??= shifted && !e.lowBitrate && r.chance(0.3) ? r.range(1.5, 2) : r.range(0.8, 1.2);
  e.gopS ??= r.chance(0.7) ? 1 : 2; e.bframes ??= r.weighted({ 0: 3, 1: 3, 2: 4 }) | 0;
  e.captureFpsTag ??= (c.slowmo || fps >= 120) && r.chance(0.5);
  s.audio ??= c.slowmo ? (r.chance(0.5) ? 'none' : 'aligned') : r.weighted({ aligned: 65, misaligned: 15, none: 20 });
  s.scenario ??= `${viewClass(s.view)}${fps}${c.slowmo ? 's' : ''}-${s.kind === 'hit' ? s.club : s.kind}${cf.practiceFirst ? '-practice-hit' : ''}`;
  return s;
}

export function planSplit(split) {
  if (split === 'smoke') return SMOKE.map((x, i) => completeSpec(smokeSpec(x, i)));
  if (split === 'easy') return EASY.map((x, i) => completeSpec(easySpec(x, i)));
  const cfg = SPLITS[split]; if (!cfg) throw new Error(`unknown split ${split}`);
  const [s0, s1] = cfg.seeds, n = s1 - s0 + 1, R = tag => rngFor(hash32(split, tag));
  // View x capture jointly with a minimum per cell; clubs spread within every view and cell; sky, ground and format
  // spread across those strata (a discrete Latin hypercube); then the clip order is shuffled onto the seeds.
  const rows = jointCells(n).flatMap(c => Array.from({ length: c.n }, () => ({ viewClass: c.v, cap: c.c })));
  const key = (...ks) => (a, b) => { for (const k of ks) { const d = String(a[k]).localeCompare(String(b[k])); if (d) return d; } return 0; };
  const fill = (k, order) => { rows.sort(order); spread(TUNE[k], n, R(k)).forEach((lv, i) => { rows[i][k] = lv; }); };
  fill('club', key('viewClass', 'cap')); fill('sky', key('viewClass', 'cap', 'club')); fill('ground', key('viewClass', 'club', 'cap')); fill('format', key('viewClass', 'sky', 'cap'));
  rows.sort(key('viewClass', 'cap', 'club', 'sky', 'ground', 'format')); R('order').shuffle(rows);
  const shiftIdx = new Set(cfg.styleShift ? R('shift').shuffle([...Array(n).keys()]).slice(0, Math.round(n * cfg.styleShift)) : []);
  const specs = rows.map((x, i) => {
    const fmt = { ...FORMATS[x.format] };
    if (shiftIdx.has(i) && x.format === 'l1080' && rngFor(s0 + i, 'fmt').chance(0.4)) Object.assign(fmt, { W: 3840, H: 2160 });
    return { id: `${split}-${String(s0 + i).padStart(6, '0')}`, split, seed: s0 + i, viewClass: x.viewClass, capture: { ...CAPTURES[x.cap] }, club: x.club, sky: x.sky, ground: x.ground, format: fmt, styleShift: shiftIdx.has(i), confounders: {} };
  });
  // One genuinely easy, confounder-free baseline per view x capture cell.
  const cells = new Set();
  for (const s of specs) { const k = `${s.viewClass}|${JSON.stringify(s.capture)}`; if (!cells.has(k) && !['practice', 'whiff', 'topped'].includes(s.club) && !s.styleShift) { cells.add(k); s.clean = true; s.sky = 'blue'; } }
  for (const s of specs) prePlan(s);
  // Confounders: exact counts per split, most constrained first, at most CAP per clip (shake included).
  const used = s => confounderCount(s.confounders), free = specs.filter(s => !s.clean);
  for (const [name, share, min, applies] of CONF) {
    const ok = s => !applies || applies(s), target = Math.max(min, Math.round(share * free.filter(ok).length));
    let got = 0;
    for (const s of R(`conf:${name}`).shuffle([...free])) {
      if (got >= target) break;
      const fmt = FORMAT_ONLY.has(name);
      if (!ok(s) || (!fmt && used(s) >= CAP)) continue;
      s.confounders[name] = true; got++;
      if (name === 'hiddenAddress' || name === 'practiceFirst') prePlan(s);
    }
  }
  const shake = R('shake');
  for (const s of specs) s.confounders.shake = s.clean || used(s) >= CAP ? 0 : (shake.weighted({ 0: 56, 1: 32, 2: 12 }) | 0);
  // Stress stratum: a few hit clips stack 5-7 confounders.
  const st = R('stress'), pool = st.shuffle(free.filter(s => s.kind === 'hit' && !s.confounders.hiddenAddress)).slice(0, Math.round(n * STRESS.share));
  for (const s of pool) {
    s.stress = true; const want = st.int(STRESS.min, STRESS.max);
    for (const [name, , , applies] of st.shuffle(CONF.filter(([k]) => !FORMAT_ONLY.has(k) && k !== 'hiddenAddress'))) { if (used(s) >= want) break; if (!s.confounders[name] && (!applies || applies(s))) s.confounders[name] = true; }
    if (used(s) < want && !s.confounders.shake) s.confounders.shake = 1 + (st.chance(0.4) ? 1 : 0);
  }
  for (const s of specs) { s.audio ??= s.clean ? 'aligned' : undefined; completeSpec(s); if (s.clean) s.scenario = `clean-${s.scenario}`; else if (s.stress) s.scenario = `stress-${s.scenario}`; }
  return specs;
}

// Smoke: every view class x capture-rate cell at least twice, with the key confounders spread across them (at most 3
// each), plus clips on the easy recipe that the shipped trackers can pass.
export const SMOKE = [
  ['dtl30-glint', 'dtl-hands', '30', 'iron7', { sky: 'blue', conf: { glint: 'address', shake: 1, flags: true } }],
  ['dtl30-practice', 'dtl-ball', '30', 'practice', { sky: 'blue', ground: 'mat', conf: { multiball: true, shake: 1 } }],
  ['dtl60-white', 'dtl-offset', '60', 'driver', { sky: 'blue', tee: 'stays', conf: { white: true, nets: true, shake: 0 }, format: 'p4k', dur: 4.2, impact: 1.7 }],
  ['dtl60-plane', 'dtl-hands', '60', 'wedge', { sky: 'blue', conf: { plane: true, shake: 1, divot: true } }],
  ['dtl120-neighbor', 'dtl-ball', '120', 'driver', { sky: 'blue', ground: 'mat', conf: { neighbor: true, neighborT: 0.35, bay: true, shake: 0 } }],
  ['dtl120s-slowmo', 'dtl-hands', '120s', 'iron7', { sky: 'haze', conf: { shake: 1, divot: true } }],
  ['dtl240-shake', 'dtl-ball', '240', 'wedge', { sky: 'blue', conf: { shake: 2, rs: true } }],
  ['dtl240s-overcast', 'dtl-offset', '240s', 'driver', { sky: 'overcast', tee: 'flies', conf: { shake: 1 } }],
  ['fo30-fastexit', 'face-on', '30', 'driver', { sky: 'blue', tee: 'stays', conf: { shake: 0 } }],
  ['fo30-birds-lefty', 'face-on', '30', 'iron7', { hand: -1, sky: 'blue', conf: { birds: true, white: true, glint: true, shake: 0 } }],
  ['fo60-overcast', 'face-on', '60', 'wedge', { sky: 'overcast', ground: 'mat', conf: { shake: 1, pile: true } }],
  ['fo60-whiff', 'face-on', '60', 'whiff', { hand: -1, sky: 'blue', tee: 'stays', conf: { shake: 1 } }],
  ['fo120-rotated', 'face-on', '120', 'iron7', { sky: 'blue', conf: { rotated: true, shake: 1 }, encode: { container: 'mov' } }],
  ['fo120s-teeflies', 'face-on', '120s', 'driver', { sky: 'sunset', tee: 'flies', conf: { shake: 0 } }],
  ['fo240-lefty-exit', 'face-on', '240', 'wedge', { hand: -1, sky: 'blue', conf: { shake: 1, rs: true } }],
  ['fo240s-glint-divot', 'face-on', '240s', 'iron7', { sky: 'blue', conf: { glint: true, divot: true, shake: 0 } }],
  ['ob30-haze-lowrate', 'oblique', '30', 'driver', { sky: 'haze', tee: 'stays', conf: { lowBitrate: true, shake: 1 } }],
  ['ob30-sunset-vfr', 'oblique', '30', 'iron7', { sky: 'sunset', conf: { specks: true, vfr: true, drops: true, shake: 0 } }],
  ['ob60-panzoom', 'oblique', '60', 'wedge', { sky: 'blue', conf: { pan: true, zoom: true, birds: true, shake: 0 }, format: 'l1080' }],
  ['ob60-topped-balls', 'oblique', '60', 'topped', { sky: 'blue', ground: 'mat', conf: { multiball: true, pile: true, shake: 1 } }],
  ['ob120-rs-blur-hevc', 'oblique', '120', 'driver', { sky: 'blue', tee: 'stays', conf: { rs: true, longExposure: true, hevc: true, shake: 0 } }],
  ['ob120s-neighbor-plane', 'oblique', '120s', 'wedge', { sky: 'blue', conf: { neighbor: true, neighborT: 0.15, plane: true, shake: 0 } }],
  ['ob240-net-flags', 'oblique', '240', 'iron7', { sky: 'blue', conf: { netFront: true, flags: true, ae: true, shake: 0 } }],
  ['ob240s-trees-dups', 'oblique', '240s', 'driver', { sky: 'blue', tee: 'stays', conf: { ae: true, shake: 1, dups: true } }],
  // A practice swing beside the ball first (turf brushed), then the real hit; and four clips on the easy recipe whose seeds
  // were chosen so both shipped engines pass them (a pipeline check, not a measurement: of five candidate seeds per entry,
  // both engines passed 1 dtl60 wedge, 4 dtl120s drivers and 3 ob120s irons).
  ['dtl60-practice-hit', 'dtl-hands', '60', 'iron7', { sky: 'blue', conf: { practiceFirst: true, shake: 0 } }],
  ['easy-dtl30-wedge', 'dtl-ball', '30', 'wedge', { easy: true, dur: 3.6, impact: 1.6 }],
  ['easy-dtl60-wedge', 'dtl-ball', '60', 'wedge', { easy: true, dur: 3.4, impact: 1.5, seed: 900460 }],
  ['easy-dtl120s-driver', 'dtl-ball', '120s', 'driver', { easy: true, tee: 'stays', seed: 900470 }],
  ['easy-ob120s-iron7', 'oblique', '120s', 'iron7', { easy: true, seed: 900480 }]
];
export function smokeSpec([name, view, cap, club, o], i) {
  const seed = o.seed ?? 900001 + i, fmt = { ...FORMATS[o.format || 'p1080'] };
  return { id: `smoke-${String(i + 1).padStart(2, '0')}-${name}`, split: 'smoke', seed, scenario: name, view, viewClass: viewClass(view), capture: { ...CAPTURES[cap] }, club, ...(o.easy ? { kind: 'hit', easy: true } : {}), hand: o.hand, sky: o.sky, ground: o.ground || 'grass', tee: o.tee ?? (o.easy ? 'none' : undefined), format: fmt, confounders: { ...o.conf }, encode: o.encode ? { ...o.encode } : undefined, styleShift: false, durationOut: o.dur, impactOut: o.impact };
}

// Easy sanity split: one clip per view x capture cell (three per down-the-line 30/60 fps cell, mostly wedges, from
// straight behind the ball, where the golfer never hides the early flight), nothing hard in it. Real-time clips end about
// 2 s after impact, so the labeled flight is the near, large part of the arc.
const EASY = [
  ['dtl-ball', '30', 'iron7'], ['dtl-ball', '30', 'wedge'], ['dtl-ball', '30', 'wedge'], ['dtl-ball', '60', 'wedge'], ['dtl-ball', '60', 'wedge'], ['dtl-ball', '60', 'iron7'],
  ['dtl-ball', '120', 'wedge'], ['dtl-ball', '240', 'iron7'], ['dtl-ball', '120s', 'driver'], ['dtl-ball', '240s', 'iron7'],
  ['face-on', '30', 'iron7'], ['face-on', '60', 'driver'], ['face-on', '120', 'wedge'], ['face-on', '240', 'iron7'], ['face-on', '120s', 'driver'], ['face-on', '240s', 'wedge'],
  ['oblique', '30', 'driver'], ['oblique', '60', 'iron7'], ['oblique', '120', 'driver'], ['oblique', '240', 'wedge'], ['oblique', '120s', 'iron7'], ['oblique', '240s', 'driver']
];
function easySpec([view, cap, club], i) {
  const seed = SPLITS.easy.seeds[0] + i, vc = viewClass(view), capture = { ...CAPTURES[cap] }, d = rngFor(seed, 'easy'), impactOut = Math.round(d.range(1.3, 2) * 1000) / 1000;
  const timing = capture.slowmo ? {} : { impactOut, durationOut: Math.round((impactOut + d.range(1.8, 2.2)) * 100) / 100 };
  return { id: `easy-${String(i + 1).padStart(2, '0')}-${vc}${cap}-${club}`, split: 'easy', seed, view, viewClass: vc, capture, club, kind: 'hit', ground: 'grass', tee: club === 'driver' ? 'stays' : 'none', format: { ...FORMATS.p1080 }, easy: true, confounders: {}, ...timing };
}

/** Clip factors; with the world, also the realized pre-shot routine (real seconds relative to impact, clip start tStart). */
export function factorSummary(s, w = null) {
  const out = { view: s.view, viewClass: viewClass(s.view), hand: s.hand > 0 ? 'right' : 'left', capture: `${s.capture.fps}${s.capture.slowmo ? '->30' : ''}`, club: s.club, kind: s.kind === 'hit' && s.confounders.practiceFirst ? 'practice-hit' : s.kind, sky: s.sky, ground: s.ground, tee: s.tee, lens: s.lens, format: `${s.format.W}x${s.format.H}`, rotation: s.format.rotation, codec: s.encode?.codec, container: s.encode?.container, lowBitrate: !!s.encode?.lowBitrate, audio: s.audio, styleShift: !!s.styleShift, clean: !!s.clean, easy: !!s.easy, stress: !!s.stress, confounderCount: confounderCount(s.confounders), confounders: Object.fromEntries(Object.entries(s.confounders).filter(([, v]) => v != null && v !== false && v !== 0)) };
  if (w) {
    const T = w.plan.times, t0 = w.tStart, r3 = v => Math.round(v * 1000) / 1000, P = T.practice;
    const waggles = T.waggles.filter((t, i) => t + T.waggleDur[i] > t0).length, first = Math.min(T.tPress, ...T.waggles, ...(P ? [P.tTakeaway] : []));
    out.camera = { heightM: r3(w.place.C[1]), low: !!w.place.low, distM: r3(Math.hypot(w.place.C[0] - w.ballStart[0], w.place.C[2] - w.ballStart[2])) };
    out.routine = { preImpactS: r3(-t0), setupS: r3(first - t0), stillBeforeTakeawayS: r3(T.tTakeaway - t0), waggles: T.waggles.length, wagglesInClip: waggles, pressInClip: T.tPress >= t0, practiceSwingInClip: P ? P.tTakeaway >= t0 : w.spec.kind === 'practice' || w.spec.kind === 'practice-noball' ? T.tTakeaway >= t0 : false, turfBrush: w.D.divot.some(p => p.t0 != null) };
  }
  return out;
}

const snrOf = b => b.snrCoded ?? b.expectedSnr * 0.6;
/**
 * Pre-impact native frames, and how many show a detectable part of the address ball: at least 10% of it (from behind,
 * an iron blade hides most of the ball at address) and SNR >= 3 (skip the SNR test for geometry-only checks).
 */
export function addressVisibility(frames, { snr = true } = {}) {
  const pre = frames.filter(f => f.tc < 0 && f.dupOf == null && f.ball);
  return { n: pre.length, visible: pre.filter(f => f.ball.inFrame && f.ball.visibleFrac >= 0.1 && (!snr || snrOf(f.ball) >= 3)).length };
}

export function expectedOutcome(spec, { frames }) {
  if (spec.kind !== 'hit') return 'abstain';
  if (addressVisibility(frames).visible <= 2) return 'either';
  const post = frames.filter(f => f.tc > 0 && f.dupOf == null && f.ball?.state === 'flight');
  return post.filter(f => f.ball.inFrame && !f.ball.occluded && snrOf(f.ball) >= 3).length <= 2 ? 'either' : 'trace';
}

/** Failure-mode tags from what the clip realized: in frame, inside the clip, near the ball where that matters. */
export function deriveTags(spec, { frames, world }, expected) {
  const hit = spec.kind === 'hit', T = new Set(), W = world.intr.W, H = world.intr.H, L = Math.max(W, H), near = 0.05 * L;
  const cam0 = makeView(world.intr, world.place.C, { yaw: world.place.yaw, pitch: world.place.pitch, roll: world.place.roll });
  const inF = q => q && q.z > 0 && q.x >= 0 && q.y >= 0 && q.x < W && q.y < H, seen = P => inF(project(cam0, P));
  const nat = frames.filter(f => f.dupOf == null), post = nat.filter(f => f.tc > 0 && f.ball?.state === 'flight'), vis = post.filter(f => f.ball.inFrame && !f.ball.occluded);
  const imp = frames.findIndex(f => f.tc >= 0), look = world.golfer.look, shot = world.shot, fl = world.flight, D = world.D, sc = world.scene, nb = world.neighbor;
  const ds = (f, ...types) => (f.distractors || []).filter(d => types.includes(d.type) && d.x >= 0 && d.y >= 0 && d.x < W && d.y < H);
  const A = project(cam0, world.ballStart), dA = BALL.d * A.ppm, white = c => c && c[0] > 225 && c[1] > 225 && c[2] > 225;
  if (hit && imp >= 0 && frames.slice(Math.max(0, imp - 2), imp + 2).some(f => f.club?.inFrame)) T.add('F1');
  if (((white(look.shirt) || white(look.glove) || white(look.shoes)) && world.targets.slice(1, 10).some(seen)) || nat.some(f => ds(f, 'glint').length)) T.add('F2');
  if (!hit) T.add('F3');
  if (D.loose.some(seen) || (spec.tee !== 'none' && spec.tee != null && inF(A))) T.add('F4');
  const snrs = vis.map(f => snrOf(f.ball)).sort((a, b) => a - b);
  if (hit && snrs.length && (snrs[snrs.length >> 1] < 6 || vis.filter(f => f.ball.contrast < 0).length >= 2)) T.add('F5');
  if (hit && ['blue', 'teal'].includes(spec.sky) && vis.filter(f => f.ball.bg === 'sky').length >= 3) T.add('F6');
  if (hit && vis.filter(f => f.ball.bg && f.ball.bg !== 'sky').length >= 4) T.add('F7');
  const close = f => f.ball?.x != null && f.ball.inFrame && ds(f, 'airplane', 'bird', 'insect', 'neighbor_ball').some(d => Math.hypot(d.x - f.ball.x, d.y - f.ball.y) < near);
  const speckNear = D.specks.some(s => vis.some(f => Math.hypot(s.x - f.ball.x, s.y - f.ball.y) < Math.max(0.5 * near, 2 * s.rad)));
  if (hit && (post.some(close) || nat.some(f => f.tc > -0.5 && f.tc <= 0 && close(f)) || speckNear)) T.add('F8');
  const poleIn = p => [0.05, 0.5, 1].some(u => seen([p.x, p.h * u, p.z]));
  const netsIn = sc.nets && [-1, 1].some(s => [5, 20, 60, 120].some(z => seen([s * sc.nets.side, sc.nets.height * 0.5, z])));
  if (D.netFront || netsIn || D.bayPosts.some(poleIn) || (sc.nearPoles || []).some(poleIn) || sc.poles.some(poleIn) || D.flags.some(poleIn)) T.add('F9');
  const c0 = nat[0].cam;
  if (nat.some(f => Math.abs(f.cam.yaw - c0.yaw) > 0.06 || Math.abs(f.cam.pitch - c0.pitch) > 0.06 || Math.abs(f.cam.zoom - c0.zoom) > 0.03)) T.add('F10');
  if (spec.capture.slowmo) T.add('F11');
  if (world.timeline.vfr || world.timeline.drops.length || world.timeline.dups.length) T.add('F12');
  if (hit && spec.view === 'face-on') { const b = project(cam0, ballAt(fl, 0.03)); if (Number.isFinite(b.x) && Math.atan2(A.y - b.y, Math.abs(b.x - A.x)) <= 30 * DEG) T.add('F13'); }
  for (let i = 1; i < post.length; i++) if (post[i - 1].ball.inFrame && !post[i].ball.inFrame && post[i - 1].ball.diam >= 0.5) { T.add('F14'); break; }
  if (hit && fl) { const tApex = apexTime(fl), f = frames.find(x => x.tc >= tApex); if (tApex <= frames.at(-1).tc && f?.ball?.inFrame) T.add('F15'); }
  if (hit && post.some(f => f.ball.inFrame && f.ball.occluded)) T.add('F16');
  if (hit && post.filter(f => f.ball.inFrame && !f.ball.occluded && snrOf(f.ball) < 2).length >= 5) T.add('F17');
  if (hit && (Math.abs(shot.axisTiltDeg) >= 12 || T.has('F15') || T.has('F16'))) T.add('F18');
  const nu = world.nudge, nudged = nu && nu.t0 >= world.tStart && nat.filter(f => f.tc >= nu.t0 && f.tc <= nu.t0 + nu.dur && f.ball?.inFrame && !f.ball.occluded).length >= 2;
  const nLaunch = nb && nb.tImpact >= world.tStart && nb.tImpact < 0 && nat.filter(f => f.tc >= nb.tImpact && f.tc <= nb.tImpact + 0.4 && ds(f, 'neighbor_ball').length).length >= 2;
  const pr = world.plan.times.practice, practiceSeen = pr && pr.tTakeaway >= world.tStart && [-0.05, 0, 0.05].some(t => seen(world.plan.poseAt(pr.tImpact + t).club.head));
  if (hit && (nudged || nLaunch || practiceSeen)) T.add('F19');
  const nearImp = nat.filter(f => Math.abs(f.tc) <= 0.15), around = d => Math.hypot(d.x - A.x, d.y - A.y) < 0.25 * L;
  const bigGlint = nearImp.some(f => ds(f, 'glint').some(d => d.size >= 0.5 * dA && around(d))), debris = nearImp.some(f => f.tc > 0 && ds(f, 'tee', 'divot').length);
  const hand = project(cam0, world.plan.poseAt(0).handL), glove = white(look.glove) && inF(hand) && around(hand);
  if (hit && (bigGlint || debris || glove)) T.add('F20');
  if (expected !== 'trace') T.add('F21');
  if (expected === 'either') T.add('F22');
  if (hit && Math.abs(shot.axisTiltDeg) >= 8) T.add('F23');
  if (hit && fl && ((fl.landing && fl.landing.t <= frames.at(-1).tc && frames.find(x => x.tc >= fl.landing.t)?.ball?.inFrame) || world.env.landingHeight !== 0)) T.add('F24');
  const gains = nat.map(f => f.gain).filter(Number.isFinite);
  if (gains.length && Math.max(...gains) / Math.min(...gains) > 1.06) T.add('F25');
  if (spec.encode?.lowBitrate) T.add('F26');
  if (world.sensor.rs) T.add('F27');
  if (hit && post.slice(0, 4).some(f => f.ball.blurPx >= 4 * Math.max(1, f.ball.diam))) T.add('F28');
  if (spec.format.rotation) T.add('F29');
  if (spec.hand < 0) T.add('F30');
  if (nb && nat.filter(f => ds(f, 'neighbor_ball').length).length >= 3) T.add('F31');
  if (hit && addressVisibility(frames).visible <= 2) T.add('F32');
  if (nat.some(f => ds(f, 'tee', 'divot', 'turf').length)) T.add('F33');
  if (hit && fl && (!fl.landing || fl.landing.t > frames.at(-1).tc)) T.add('F34');
  return [...T].sort((a, b) => +a.slice(1) - +b.slice(1));
}
function apexTime(fl) { let best = 0, h = -1; for (let i = 0; i < fl.T.length; i += 5) { if (fl.P[i][1] > h) { h = fl.P[i][1]; best = fl.T[i]; } if (fl.landing && fl.T[i] > fl.landing.t) break; } return best; }

/** Coverage of failure-mode tags per split (from GT). */
export function coverage(gts) {
  const out = Object.fromEntries(Object.keys(FAILURE_MODES).map(k => [k, 0]));
  for (const g of gts) for (const t of g.failureModes) out[t]++;
  return out;
}
