import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMotion, motionFrame, selectPatches, CameraPath, MotionTracker, halfLuma, CAMERA_INTERNALS } from '../dist/hf/camera-motion.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, applySim, invertSim, composeSim, simAt, cameraSamples, cameraToRaw, makeSourceMeta, IDENTITY_SIM } from '../dist/hf/types.js';
import { landscape, renderField, quantize, rng, simError, canvas, warpCanvas, shakePath, fbm } from './hf/helpers/u2-scene.mjs';

const W = 540, H = 960, CX = W / 2, CY = H / 2;
const scene = landscape({ seed: 5, horizonY: 300, texture: 70 });
const r = rng(9);
const base = renderField(scene, W, H);
const A = quantize(base, r, 1.5);
const img = data => ({ data, w: W, h: H });
const about = (deg, s, tx, ty) => { const th = deg * Math.PI / 180, a = s * Math.cos(th), b = s * Math.sin(th); return { a, b, tx: CX - (a * CX - b * CY) + tx, ty: CY - (b * CX + a * CY) + ty }; };
const shifted = (G, f = scene, noise = 1.5) => quantize(renderField(f, W, H, G), r, noise);
const best = (n, fn) => { let m = Infinity; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); m = Math.min(m, performance.now() - t0); } return m; };

const CASES = [
  ['odd integer shift', { a: 1, b: 0, tx: 3, ty: -5 }],
  ['odd integer shift, other sign', { a: 1, b: 0, tx: -7, ty: 1 }],
  ['sub-pixel shift', { a: 1, b: 0, tx: 1.37, ty: -0.62 }],
  ['large shift (wide 1/4-res search)', { a: 1, b: 0, tx: 17.3, ty: 9.8 }],
  ['rotation 0.5° about the centre', about(0.5, 1, 0.7, -1.2)],
  ['zoom 1.5%', about(0, 1.015, 0.4, 0.3)],
  ['rotation and zoom', about(-0.4, 0.99, -2.2, 1.6)]
];
for (const [name, G] of CASES) {
  test(`estimateMotion recovers ${name} within 0.2 px`, () => {
    const e = estimateMotion(img(A), img(shifted(G)));
    assert.ok(e.ok, 'estimate ok');
    const err = simError(e.sim, G, W, H);
    assert.ok(err <= 0.2, `max displacement error ${err.toFixed(3)} px`);
    assert.ok(e.inlierRatio >= 0.8, `inliers ${e.inlierRatio}`);
  });
}

test('estimateMotion recovers zoom steps of 2-5.5% in one frame on every scene (phone stabilization on real clips)', () => {
  // no single translation explains a zoom step, so a translation-only start found it on 2 of 8 scenes at 5.5%
  for (const s of [1.055, 1.04, 0.97, 1.02]) for (let seed = 1; seed <= 8; seed++) {
    const f = landscape({ seed, horizonY: 300, texture: 70 }), rs = rng(100 + seed), G = about(0.1 * (seed % 3), s, -1.2 + 0.3 * seed, 0.8 - 0.2 * seed);
    const e = estimateMotion(img(quantize(renderField(f, W, H), rs, 1.5)), img(quantize(renderField(f, W, H, G), rs, 1.5)));
    assert.ok(e.ok && simError(e.sim, G, W, H) <= 0.2, `scale ${s} scene ${seed}: ok ${e.ok}, error ${simError(e.sim, G, W, H).toFixed(2)} px`);
  }
});

test('sub-pixel accuracy needs the Lucas-Kanade step (parabolic fit alone pixel-locks)', () => {
  // the estimate must be far better than the integer + parabolic stage on a half-pixel shift
  const G = { a: 1, b: 0, tx: 2.5, ty: -1.5 };
  const e = estimateMotion(img(A), img(shifted(G, scene, 0)));
  assert.ok(simError(e.sim, G, W, H) <= 0.06, `error ${simError(e.sim, G, W, H)}`);
});

test('exposure change between frames does not bias the estimate, even an auto-exposure jump of ±45 levels', () => {
  // zero-mean block SAD at the coarse levels and zero-mean SSD at full res: a level offset larger than the SAD
  // truncation would otherwise flatten the coarse search
  for (const [dl, G] of [[14, { a: 1, b: 0, tx: -2.3, ty: 4.6 }], [45, { a: 1, b: 0, tx: -2.3, ty: 4.6 }], [-45, { a: 1, b: 0, tx: 3.3, ty: 1.2 }]]) {
    const e = estimateMotion(img(A), img(shifted(G, (x, y) => scene(x, y) + dl)));
    assert.ok(e.ok && simError(e.sim, G, W, H) <= 0.2, `exposure ${dl}: error ${simError(e.sim, G, W, H).toFixed(2)}`);
  }
});

/* golfer: a strongly textured body taking about 40% of the textured patches, moving against the camera */
const golferTex = fbm(77, [20, 9, 5], [1, 0.7, 0.4]);
const inGolfer = (x, y, dx, dy) => ((x - 300 - dx) / 120) ** 2 + ((y - 600 - dy) / 260) ** 2 < 1;
function golferPair(G, move) {
  const a = Float32Array.from(base), b = renderField(scene, W, H, G);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (inGolfer(i + 0.5, j + 0.5, 0, 0)) a[j * W + i] = 120 + 90 * golferTex(i + 0.5, j + 0.5);
    if (inGolfer(i + 0.5, j + 0.5, move.x, move.y)) b[j * W + i] = 120 + 90 * golferTex(i + 0.5 - move.x, j + 0.5 - move.y);
  }
  return [quantize(a, r, 1.5), quantize(b, r, 1.5)];
}
const G_CAM = { a: 1, b: 0, tx: 2.4, ty: -1.7 };
const [ga, gb] = golferPair(G_CAM, { x: 11.4, y: -7.7 });

test('golfer patches are rejected as outliers and the camera is recovered', () => {
  const e = estimateMotion(img(ga), img(gb), { detail: true });
  const onG = e.detail.filter(p => inGolfer(p.x, p.y, 0, 0));
  assert.ok(onG.length >= 10, `golfer patches ${onG.length}`);
  assert.equal(onG.filter(p => p.inlier).length, 0, 'no golfer patch is an inlier');
  assert.ok(simError(e.sim, G_CAM, W, H) <= 0.2, `error ${simError(e.sim, G_CAM, W, H)}`);
  assert.ok(e.inlierRatio < 0.7, 'the inlier ratio reports the golfer');
});

test('a minority golfer is rejected even with an exact prior and a wide one', () => {
  for (const prior of [IDENTITY_SIM, G_CAM]) {
    const e = estimateMotion(img(ga), img(gb), { prior });
    assert.ok(simError(e.sim, G_CAM, W, H) <= 0.2, `prior ${JSON.stringify(prior)}`);
  }
});

test('a golfer holding most of the patches still loses to the spread background (extent-weighted robust start)', () => {
  // hand-picked patch set: the golfer's interior patches plus every other background patch near the left and
  // right edges, so the golfer is the majority but the background spans the frame
  const fa = motionFrame(img(ga)), all = selectPatches(fa);
  const gol = all.filter(p => inGolfer(p.cx, p.cy, -12, 8) && inGolfer(p.cx, p.cy, 12, -8));
  const side = all.filter(p => !inGolfer(p.cx, p.cy, 0, 0) && !inGolfer(p.cx, p.cy, 11.4, -7.7) && (p.cx < 120 || p.cx > 440)).filter((_, i) => i % 2 === 0);
  fa.patches = [...gol, ...side];
  assert.ok(gol.length > side.length, `golfer ${gol.length} vs background ${side.length}`);
  const e = estimateMotion(fa, img(gb));
  assert.ok(simError(e.sim, G_CAM, W, H) <= 0.2, `error ${simError(e.sim, G_CAM, W, H).toFixed(2)}`);
});

test('a uniform occluder over most of the frame cannot fake a consensus (patch NCC gate)', () => {
  // noise-free flat regions give every occluded patch the same first-minimum displacement
  const clean = quantize(base, r, 0), G = { a: 1, b: 0, tx: 2, ty: 1 };
  for (const cover of [330, 400]) {
    const fr = renderField(scene, W, H, G);
    for (let j = 0; j < H; j++) for (let i = 0; i < cover; i++) fr[j * W + i] = 128;
    const e = estimateMotion(img(clean), img(quantize(fr, r, 0)));
    assert.ok(e.ok && simError(e.sim, G, W, H) <= 0.2, `cover ${cover}: error ${simError(e.sim, G, W, H).toFixed(2)}`);
  }
});

test('noise-free data keeps every patch an inlier (the MAD scale has a floor)', () => {
  const G = { a: 1, b: 0, tx: 3, ty: -5 };
  const e = estimateMotion(img(quantize(base, r, 0)), img(quantize(renderField(scene, W, H, G), r, 0)));
  assert.ok(e.inlierRatio >= 0.97, `inliers ${e.inlierRatio}`);
});

test('textured patches are spread over the frame (round-robin regions), never all on the golfer', () => {
  const f = motionFrame(img(ga));
  const ps = selectPatches(f);
  assert.equal(ps.length, PARAMS.scan.camera.patches);
  const onG = ps.filter(p => inGolfer(p.cx, p.cy, 0, 0)).length;
  assert.ok(onG / ps.length < 0.5, `golfer share ${onG}/${ps.length}`);
  // no patch in the textureless sky, none overlapping
  assert.ok(ps.every(p => p.cy > 300 - 8), 'no patch in flat sky');
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(Math.abs(ps[i].x0 - ps[j].x0) >= 16 || Math.abs(ps[i].y0 - ps[j].y0) >= 16);
});

test('exclude boxes keep patches out of the given region', () => {
  const f = motionFrame(img(A));
  const box = { x0: 0, y0: 400, x1: W, y1: 700 };
  const ps = selectPatches(f, { exclude: [box] });
  assert.ok(ps.length > 10 && ps.every(p => p.y0 + 16 <= 400 || p.y0 >= 700));
  const m = new Uint8Array(Math.ceil(W / 4) * Math.ceil(H / 4)).fill(1);
  assert.equal(selectPatches(motionFrame(img(A)), { excludeMask: { data: m, w: Math.ceil(W / 4), h: Math.ceil(H / 4), cellPx: 4 } }).length, 0);
});

test('a textureless frame gives no usable estimate', () => {
  const flat = quantize(new Float32Array(W * H).fill(128), r, 1);
  const e = estimateMotion(img(flat), img(flat));
  assert.equal(e.ok, false);
  assert.equal(e.inlierRatio, 0);
});

test('halfLuma is the 2×2 rounded box mean and drops odd trailing rows/columns', () => {
  const src = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], (v, i) => v * 10 % 256);
  const h = halfLuma(src, 5, 3);
  assert.equal(h.w, 2); assert.equal(h.h, 1);
  assert.deepEqual([...h.data], [(10 + 20 + 60 + 70 + 2) >> 2, (30 + 40 + 80 + 90 + 2) >> 2]);
});

/* clouds: a strongly textured sky drifting over a static camera; the rigid ground is a smooth lawn with one short
   textured strip, so the sky holds most patches (ground candidates fill the budget first, the sky the rest) */
const cloudy = (dx) => {
  const sky = fbm(41, [30, 14, 7], [1, 0.7, 0.4]), strip = landscape({ seed: 6, horizonY: -1e9, texture: 60 });
  return (x, y) => y < 530 ? 170 + 70 * sky(x - dx, y) : y < 560 ? 170 : y < 580 && x > 100 && x < 200 ? strip(x, y) : 100;
};
test('drifting clouds cannot drag a static camera once the horizon is known (ground patches first)', () => {
  const f0 = motionFrame(img(quantize(renderField(cloudy(0), W, H), r, 1.5)));
  f0.patches = selectPatches(f0, { skyLine: { slope: 0, y0: 560 } });
  const nSky = f0.patches.filter(p => p.sky).length, nGround = f0.patches.length - nSky;
  assert.ok(nGround >= 6 && nSky > 2 * nGround, `sky ${nSky} ground ${nGround}`);
  const cur = img(quantize(renderField(cloudy(3.2), W, H), r, 1.5));
  const e = estimateMotion(f0, cur);
  assert.ok(e.ground && simError(e.sim, IDENTITY_SIM, W, H) <= 0.2, `ground-first error ${simError(e.sim, IDENTITY_SIM, W, H).toFixed(2)}`);
  // the camera is fine: the inlier ratio of a ground-first fit is over the ground patches (R4 must not abstain)
  assert.ok(e.inlierRatio >= 0.9, `inlier ratio ${e.inlierRatio.toFixed(2)}`);
});

test('the inlier ratio leaves out patches on moving foreground (the golfer), not the camera fit', () => {
  const cw = Math.ceil(W / 4), ch = Math.ceil(H / 4), fgm = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (inGolfer(i * 4 + 2, j * 4 + 2, 0, 0) || inGolfer(i * 4 + 2, j * 4 + 2, 11.4, -7.7)) fgm[j * cw + i] = 1;
  const plain = estimateMotion(img(ga), img(gb)), masked = estimateMotion(img(ga), img(gb), { foreground: { data: fgm, w: cw, h: ch, cellPx: 4 } });
  assert.deepEqual(masked.sim, plain.sim, 'same fit');
  assert.ok(masked.inlierRatio >= 0.9 && plain.inlierRatio < 0.8, `masked ${masked.inlierRatio.toFixed(2)} vs plain ${plain.inlierRatio.toFixed(2)}`);
});

/* ------------------------------------------------------------------ CameraPath */

const META = makeSourceMeta({ width: 1080, height: 1920, fps: 30, frameCount: 10, times: Float64Array.from({ length: 10 }, (_, k) => k / 30), duration: 10 / 30 });

test('CameraPath composes coarse estimates into stabilized->raw native similarities', () => {
  const p = new CameraPath(META, { pool: 2 });
  p.push(0, 0, { sim: { a: 1, b: 0, tx: 9, ty: 9 }, inlierRatio: 1, ok: true });   // the reference is identity whatever est says
  const M1 = { a: Math.cos(0.01), b: Math.sin(0.01), tx: 1.5, ty: -2 };              // coarse px, frame 0 -> frame 1
  p.push(1, 1 / 30, { sim: M1, inlierRatio: 0.8, ok: true });
  const M2 = { a: 1, b: 0, tx: -0.5, ty: 0.25 };                                     // frame 0 (key) -> frame 3
  p.push(3, 0.1, { sim: M2, inlierRatio: 0.9, ok: true, ref: 0 });
  p.push(4, 4 / 30, null);                                                           // hold, inlier 0
  p.push(5, 5 / 30, { sim: M2, inlierRatio: 0.9, ok: false });                       // not ok: hold too
  const tr = p.track();
  assert.deepEqual(check('CameraTrack', tr), []);
  assert.deepEqual([...tr.index], [0, 1, 3, 4, 5]);
  assert.deepEqual([...tr.inlier].map(v => +v.toFixed(2)), [1, 0.8, 0.9, 0, 0]);
  assert.deepEqual(simAt(tr, 0), IDENTITY_SIM);
  const S1 = simAt(tr, 1);
  assert.ok(Math.abs(S1.tx - 3) < 1e-9 && Math.abs(S1.ty + 4) < 1e-9 && Math.abs(S1.b - Math.sin(0.01)) < 1e-12, 'translation scales by pool');
  const S3 = simAt(tr, 3);
  assert.ok(Math.abs(S3.tx + 1) < 1e-9 && Math.abs(S3.ty - 0.5) < 1e-9 && S3.b === 0, 'ref composes with the reference entry, not the previous');
  assert.deepEqual(simAt(tr, 4), S3);
  assert.deepEqual(simAt(tr, 5), S3);
  // toStab/fromStab invert each other and agree with types.js helpers; between entries simAt interpolates
  const q = p.fromStab(1, 100, 200), back = p.toStab(1, q.x, q.y);
  assert.ok(Math.hypot(back.x - 100, back.y - 200) < 1e-9);
  assert.deepEqual(p.simAt(2), simAt(tr, 2));
  // renderer samples: normalized translation at the frame centre, scale and rotation
  const smp = p.samples(), tt = p.translationTrack();
  assert.deepEqual(smp, cameraSamples(tr, META));
  assert.deepEqual(tt.map(s => Object.keys(s)), tt.map(() => ['t', 'x', 'y']));
  const raw = cameraToRaw(smp[1], 0.3, 0.6, 1080, 1920), want = applySim(S1, 0.3 * 1080, 0.6 * 1920);
  assert.ok(Math.abs(raw.x * 1080 - want.x) < 1e-6 && Math.abs(raw.y * 1920 - want.y) < 1e-6);
  assert.throws(() => p.push(5, 0.2, null), /not increasing/);
  assert.throws(() => p.push(6, 0.2, { sim: M1, ok: true, ref: 2 }), /reference/);
});

/* ------------------------------------------------------------------ MotionTracker over a clip */

const cv = canvas(landscape({ seed: 5, horizonY: 300, texture: 60 }), -200, -200, W + 400, H + 400);
function runPath(G, opts = {}) {
  // a fresh noise stream per run, so the paths do not depend on which tests ran before
  const mt = new MotionTracker(META, { pool: 1, params: opts.params ?? PARAMS }), bufs = [new Uint8Array(W * H), new Uint8Array(W * H)], r = rng(opts.seed ?? 77);
  let worst = 0, last = null, prevF = null, prevPrev = null;
  for (let k = 0; k < G.length; k++) {
    const data = quantize(warpCanvas(cv, W, H, G[k]), r, 1.5, bufs[k & 1]);
    const mf = motionFrame(img(data), { reuse: prevPrev });
    last = mt.push(k, k / 30, mf);
    mt.maybeRefreshKey(mf, k);
    worst = Math.max(worst, simError(last.S, composeSim(G[k], invertSim(G[0])), W, H, 60));
    prevPrev = prevF; prevF = mf;
  }
  return { worst, mt };
}

test('MotionTracker keeps the path within 0.2 px through shake, odd/sub-pixel drift and rotation, 0.25 px across a pan', () => {
  // a long pan refreshes the keyframe, and each refresh carries over the current (small) error
  for (const [name, o, lim] of [['shake 3 px', { amp: 3 }, 0.2], ['odd sub-pixel drift', { amp: 1, driftX: 0.37, driftY: -0.23 }, 0.2], ['rotation + zoom', { amp: 1.5, rotDeg: 0.6, zoom: 0.03, cx: CX, cy: CY }, 0.2], ['pan', { amp: 1, driftX: 1.3, driftY: 0.4 }, 0.25]]) {
    const { worst, mt } = runPath(shakePath(90, { seed: 11, ...o }));
    assert.ok(worst <= lim, `${name}: worst ${worst.toFixed(3)} px`);
    assert.equal(mt.stats.held, 0, name);
  }
});

test('the keyframe is refreshed on large pans and the path stays accurate across refreshes', () => {
  // 190 px of pan in 4 s: two refreshes, each adding its frame's estimation error (0.23-0.29 px over noise seeds)
  const { worst, mt } = runPath(shakePath(120, { seed: 2, amp: 0.5, driftX: 1.6 }));
  assert.ok(mt.stats.keyRefresh >= 2, `refreshes ${mt.stats.keyRefresh}`);
  assert.ok(worst <= 0.3, `worst ${worst}`);
});

test('a frame without texture holds the previous similarity with inlier 0, and tracking resumes', () => {
  const mt = new MotionTracker(META, { pool: 1 }), G = shakePath(12, { seed: 4, amp: 2 }), flat = quantize(new Float32Array(W * H).fill(120), r, 1);
  let S6 = null;
  const frames = [];
  for (let k = 0; k < 12; k++) {
    const data = k === 6 ? flat : quantize(warpCanvas(cv, W, H, G[k]), r, 1.5);
    const mf = motionFrame(img(data));
    frames.push(mf);
    const res = mt.push(k, k / 30, mf);
    mt.maybeRefreshKey(mf, k);
    if (k === 5) S6 = res.S;
    if (k === 6) assert.deepEqual(res.S, S6, 'held');
  }
  const tr = mt.path.track();
  assert.equal(tr.inlier[6], 0);
  assert.ok(simError(simAt(tr, 11), composeSim(G[11], invertSim(G[0])), W, H, 60) <= 0.2, 'resumes against the keyframe');
});

test('a golfer hiding most patches during the swing neither drops nor corrupts the key (shaking camera)', () => {
  // the golfer covers about half of the key's patches for 20 frames while the camera shakes: estimates with enough
  // inliers are used (no holds), and the path stays on the truth
  const n = 40, G = shakePath(n, { seed: 8, amp: 2 }), body = fbm(91, [16, 8, 4], [1, 0.8, 0.5]);
  const cover = k => k >= 10 && k < 30 ? (x, y) => x > 140 && x < 420 && y > 320 && y < 880 : () => false;
  const mt = new MotionTracker(META, { pool: 1 });
  let worst = 0;
  for (let k = 0; k < n; k++) {
    const fr = warpCanvas(cv, W, H, G[k]), c = cover(k);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (c(i, j)) fr[j * W + i] = 120 + 90 * body(i + 3 * k, j - 2 * k);
    const mf = motionFrame(img(quantize(fr, r, 1.5)));
    const res = mt.push(k, k / 30, mf);
    mt.maybeRefreshKey(mf, k);
    worst = Math.max(worst, simError(res.S, composeSim(G[k], invertSim(G[0])), W, H, 60));
  }
  assert.equal(mt.stats.held, 0);
  assert.ok(worst <= 0.3, `worst ${worst.toFixed(2)} px`);
});

test('after the golfer settles in a new pose a fresh key restores the inlier ratio', () => {
  // a textured body steps 40 px sideways at frame 8 and stays: the old key's patches on it disagree forever
  const n = 24, body = fbm(92, [16, 8, 4], [1, 0.8, 0.5]), mt = new MotionTracker(META, { pool: 1 });
  const inBody = (x, y, dx) => x > 100 + dx && x < 400 + dx && y > 250 && y < 950;
  const ratios = [];
  for (let k = 0; k < n; k++) {
    const dx = k < 8 ? 0 : 40, fr = renderField(scene, W, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (inBody(i, j, dx)) fr[j * W + i] = 120 + 90 * body(i - dx, j);
    const mf = motionFrame(img(quantize(fr, r, 1.5)));
    const res = mt.push(k, k / 30, mf);
    mt.maybeRefreshKey(mf, k);
    ratios.push(mt.path.track().inlier[k]);
  }
  assert.ok(Math.min(...ratios.slice(12)) >= 0.8, `ratios after settling ${ratios.slice(12).map(v => v.toFixed(2))}`);
  assert.ok(mt.stats.keyRefresh >= 1);
});

test('MotionTracker with a horizon keeps its keys on the ground: drifting clouds never drag a shaking camera', () => {
  // textured clouds fill the upper half and drift 1.5 px/frame; the ground is a smooth lawn with a few soft
  // textured tufts. Without the horizon most key patches would sit on the clouds (the path drifts by tens of px)
  const sky = fbm(41, [30, 14, 7], [1, 0.7, 0.4]), tex = landscape({ seed: 6, horizonY: -1e9, texture: 60 }), sm = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  const tufts = [[90, 640], [270, 610], [450, 650], [150, 780], [390, 800], [90, 900], [270, 890], [450, 910]];
  const field = dx => (x, y) => {
    if (y < 540) return (170 + 70 * sky(x - dx, y)) * (1 - sm((y - 520) / 20)) + 100 * sm((y - 520) / 20);
    let v = 100;
    for (const [tx, ty] of tufts) { const d = Math.hypot(x - tx, y - ty); if (d < 30) v += (tex(x, y) - 100) * (1 - sm((d - 18) / 12)); }
    return v;
  };
  const n = 30, G = shakePath(n, { seed: 4, amp: 2 }), mt = new MotionTracker(META, { pool: 1 });
  mt.setSkyLine({ slope: 0, y0: 540 });   // stabilized native px (pool 1: the frame's own px)
  let worst = 0;
  for (let k = 0; k < n; k++) {
    const mf = motionFrame(img(quantize(renderField(field(1.5 * k), W, H, G[k]), r, 1.5)));
    const res = mt.push(k, k / 30, mf);
    mt.maybeRefreshKey(mf, k);
    worst = Math.max(worst, simError(res.S, composeSim(G[k], invertSim(G[0])), W, H, 60));
  }
  assert.ok(mt.key.patches.every(p => !p.sky), 'the ground fills the key budget first');
  assert.ok(worst <= 0.25, `worst ${worst.toFixed(2)} px`);
  assert.equal(mt.stats.held, 0);
  assert.ok(Math.min(...mt.path.track().inlier) >= 0.8);
});

test('camera motion stays under its 5 ms budget at 540×960 (best of 7)', () => {
  const f0 = motionFrame(img(A)); f0.patches = selectPatches(f0);
  const B = shifted({ a: 1, b: 0, tx: 1.3, ty: -2.1 });
  const ms = best(7, () => estimateMotion(f0, motionFrame(img(B))));
  const sel = best(5, () => selectPatches(motionFrame(img(A))));
  assert.ok(ms <= 5, `estimate ${ms.toFixed(2)} ms`);
  assert.ok(sel <= 5, `patch selection ${sel.toFixed(2)} ms`);
});

test('CAMERA_INTERNALS and params are respected (mergeParams patch count)', () => {
  const p = mergeParams({ scan: { camera: { patches: 12 } } });
  assert.equal(selectPatches(motionFrame(img(A), { params: p }), { params: p }).length, 12);
  assert.ok(Object.isFrozen(CAMERA_INTERNALS));
});
