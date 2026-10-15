import test from 'node:test';
import assert from 'node:assert/strict';
import * as spots from '../dist/hf/spots.js';
import { CandidateDetector, detectCandidates, impulseOk, gradualDeparture, vacateFailures, patchNcc, patchStability, noiseSigma, SPOT_INTERNALS } from '../dist/hf/spots.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, makeSourceMeta } from '../dist/hf/types.js';
import { makeClip, runSpots, ballPath, shakePath, landscape, worldToStab, quantize, rng, drawEllipse, drawRect, drawShadedBall, renderField } from './hf/helpers/u2-scene.mjs';

/* ------------------------------------------------------------------ candidate detector */

const r = rng(21);
function blobs(w, h, list, { bgLuma = 100, noise = 1.5 } = {}) {
  const fr = new Float32Array(w * h).fill(bgLuma);
  for (const b of list) drawEllipse(fr, w, h, b.x, b.y, b.rx, b.ry ?? b.rx, b.luma, { angle: b.angle ?? 0 });
  return { data: quantize(fr, r, noise), w, h };
}

test('candidates: both polarities, sub-pixel centroids, diameter and z', () => {
  const list = [{ x: 60.3, y: 80.7, rx: 3, luma: 220 }, { x: 150.6, y: 60.2, rx: 2.5, luma: 30 }, { x: 100.5, y: 200.5, rx: 5, luma: 200 }];
  const cs = detectCandidates(blobs(240, 300, list));
  for (const b of list) {
    const c = cs.find(q => Math.hypot(q.x - b.x, q.y - b.y) < 2);
    assert.ok(c, `found ${b.x},${b.y}`);
    assert.ok(Math.hypot(c.x - b.x, c.y - b.y) <= 0.2, `centroid error ${Math.hypot(c.x - b.x, c.y - b.y).toFixed(3)}`);
    assert.equal(c.polarity, b.luma > 100 ? 1 : -1);
    assert.ok(Math.abs(c.d - 2 * b.rx) <= 0.25 * 2 * b.rx, `d ${c.d} vs ${2 * b.rx}`);
    assert.ok(c.z >= PARAMS.scan.candidates.zMin && c.roundness < 1.5 && c.fill > 0.6, JSON.stringify(c));
  }
  assert.equal(cs.length, list.length, 'nothing else on a flat noisy background');
});

test('candidates: flat noise gives none (z threshold), and a lower zMin would find noise', () => {
  const flat = blobs(240, 300, []);
  assert.equal(detectCandidates(flat).length, 0);
  assert.ok(detectCandidates(flat, { params: mergeParams({ scan: { candidates: { zMin: 1.2 } } }) }).length > 0, 'the threshold is what keeps noise out');
});

test('candidates: at most maxPerTile per 60-px tile and maxPerFrame per frame', () => {
  const crowd = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) crowd.push({ x: 8 + 13 * i, y: 8 + 13 * j, rx: 2.5, luma: 230 });   // 16 in one tile
  const cs = detectCandidates(blobs(240, 300, crowd));
  assert.equal(cs.length, PARAMS.scan.candidates.maxPerTile);
  const many = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) many.push({ x: 15 + 30 * i, y: 15 + 30 * j, rx: 2.5, luma: 230 });
  // the per-frame cap binds (checked at the old 48) ...
  assert.equal(detectCandidates(blobs(360, 360, many), { params: mergeParams({ scan: { candidates: { maxPerFrame: 48 } } }) }).length, 48);
  // ... and the default leaves room for a busy frame (a night range: floodlights and balls on the range)
  assert.ok(PARAMS.scan.candidates.maxPerFrame >= 144);
  assert.equal(detectCandidates(blobs(360, 360, many)).length, 144);
});

test('candidates: on a textured 1280×720 frame (pool 1) higher-z texture peaks cannot starve the ball of measurements', () => {
  // hundreds of texture peaks outrank the ball's z and fail the blob tests; the measurement budget scales with the
  // tile count, so the ball is still measured
  const fr = renderField(landscape({ seed: 8, horizonY: 216, texture: 60 }), 1280, 720);
  for (const [x, y] of [[704.3, 576.6], [300.5, 500.5]]) drawEllipse(fr, 1280, 720, x, y, 4, 4, 235);
  const cs = detectCandidates({ data: quantize(fr, r, 1.5), w: 1280, h: 720 });
  for (const [x, y] of [[704.3, 576.6], [300.5, 500.5]]) assert.ok(cs.some(c => Math.hypot(c.x - x, c.y - y) < 1 && c.z >= PARAMS.scan.candidates.zMin), `ball at ${x},${y} (${cs.length} candidates)`);
});

test('candidates: no DoG side-lobe on the rim of a bright ball on textured ground', () => {
  // the dark lobe of the box DoG hugs the ball's rim (2-8 px out); the annulus-median background and the
  // explain-the-response test drop it (a weak real texture spot farther out may stay, below darkMinZ)
  const bg = landscape({ seed: 3, horizonY: -1, texture: 55 }), w = 200, h = 200, fr = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) fr[j * w + i] = bg(i + 0.5, j + 0.5);
  drawEllipse(fr, w, h, 100.5, 100.5, 3, 3, 235);
  for (const seed of [1, 2, 3, 4]) {
    const cs = detectCandidates({ data: quantize(fr, rng(seed), 1.5), w, h });
    assert.ok(cs.some(c => c.polarity > 0 && Math.hypot(c.x - 100.5, c.y - 100.5) < 1), 'the ball');
    const lobes = cs.filter(c => c.polarity < 0 && Math.hypot(c.x - 100.5, c.y - 100.5) < 1.5 * 6);
    assert.equal(lobes.length, 0, `seed ${seed}: side-lobes ${JSON.stringify(lobes.map(c => [c.x.toFixed(1), c.y.toFixed(1), c.z.toFixed(1)]))}`);
  }
});

test('candidates: a standing tee is elongated (fails the eigenvalue ratio), a disc is not', () => {
  const img = blobs(200, 200, [{ x: 60, y: 60, rx: 0.8, ry: 4, luma: 240 }, { x: 140, y: 140, rx: 3, luma: 240 }]);
  const cs = detectCandidates(img), tee = cs.find(c => Math.abs(c.x - 60) < 2), ball = cs.find(c => Math.abs(c.x - 140) < 2);
  assert.ok(tee && tee.roundness > PARAMS.scan.spot.maxEigRatio, `tee roundness ${tee?.roundness}`);
  assert.ok(ball && ball.roundness < 1.5);
});

test('candidates: a ball on a tall tee or with a glint tail keeps a ball shape (axis ratio and fill of the eroded core)', () => {
  for (const [name, extra] of [['tee 1 D below', { x: 100, y: 106, rx: 0.8, ry: 6 }], ['tee 1.6 D below', { x: 100, y: 108, rx: 0.9, ry: 8 }], ['glint tail', { x: 106, y: 100, rx: 6, ry: 0.8 }]]) {
    const c = detectCandidates(blobs(200, 200, [{ ...extra, luma: 235 }, { x: 100, y: 100, rx: 3, luma: 235 }])).find(q => Math.hypot(q.x - 100, q.y - 100) < 5);
    assert.ok(c && c.roundness <= PARAMS.scan.spot.maxEigRatio && c.fill >= PARAMS.scan.spot.minFill, `${name}: ${JSON.stringify(c)}`);
  }
});

test('candidates: the large scale finds a big address ball only when enabled', () => {
  // d = 20 coarse px: above largeBlobPx (12), inside the (4, 12) scale's range
  const img = blobs(300, 300, [{ x: 150, y: 150, rx: 10, luma: 230 }]);
  const near = cs => cs.find(c => Math.hypot(c.x - 150, c.y - 150) < 3 && c.d > 16);
  assert.ok(near(detectCandidates(img, { large: true })), 'large scale');
  const det = new CandidateDetector(300, 300);
  assert.ok(!det.detect(img.data).some(c => c.scale === 2), 'scale 2 off by default');
});

test('candidates: a side-lit ball (Lambert shading, terminator near the rim) is still ball-shaped', () => {
  // the region is everything above 0.3 of the peak over the annulus median and the shape is the axis ratio
  // sqrt(λ1/λ2): a lit gibbous region of a sunlit ball stays inside maxEigRatio, its full disc mostly inside the region
  for (const [light, rr] of [[[1, 0, 0.2], 4], [[1, 0, 0.2], 3], [[0.6, 0.6, 0.5], 4]]) {
    const fr = new Float32Array(200 * 200).fill(110);
    drawShadedBall(fr, 200, 200, 100.3, 100.6, rr, 245, 125, light);
    const c = detectCandidates({ data: quantize(fr, r, 1.5), w: 200, h: 200 }).find(q => Math.hypot(q.x - 100.3, q.y - 100.6) < rr);
    assert.ok(c && c.polarity > 0, `found (light ${light}, r ${rr})`);
    assert.ok(c.roundness <= PARAMS.scan.spot.maxEigRatio && c.fill >= PARAMS.scan.spot.minFill, `light ${light}, r ${rr}: ${JSON.stringify(c)}`);
    assert.ok(c.d >= 0.65 * 2 * rr, `diameter ${c.d.toFixed(1)} of ${2 * rr}`);
  }
});

test('candidates: ground pockets beside the dark golfer and the ends of his limbs are not ball-shaped blobs (every-side test)', () => {
  // ground between arm and torso is "bright" against a mostly dark ring, a leg's rounded end "dark" against mostly
  // ground: both explain the DoG response, but neither stands out toward the body / the ground on every side
  const w = 240, h = 300, round = c => c.roundness <= PARAMS.scan.spot.maxEigRatio && c.fill >= PARAMS.scan.spot.minFill;
  const near = (x, y, m = 8) => ((x - 120) / (26 + m)) ** 2 + ((y - 110) / (45 + m)) ** 2 < 1 || (x > 104 - m && x < 122 + m && y > 140 - m && y < 250 + m) || (x > 60 - m && x < 100 + m && y > 120 - m && y < 128 + m);
  const pockets = [[89.5, 115.5], [92, 133], [127.5, 159.5], [64.5, 124], [109, 245], [117, 245], [98, 146.5]];
  for (const texture of [0, 30]) {
    const g = landscape({ seed: 5, horizonY: -1, texture }), fr = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) fr[j * w + i] = g(i + 0.5, j + 0.5);
    drawEllipse(fr, w, h, 120, 110, 26, 45, 50);                                      // torso
    drawRect(fr, w, h, 104, 140, 122, 250, 50); drawRect(fr, w, h, 60, 120, 100, 128, 50);   // leg, arm
    for (const seed of [1, 2, 3]) {
      const cs = detectCandidates({ data: quantize(fr, rng(seed), 1.5), w, h }).filter(round);
      // on flat ground nothing ball-shaped hugs the body; on textured ground real texture blobs can, but not at
      // the pockets and limb ends
      const bad = texture ? cs.filter(c => pockets.some(([x, y]) => Math.hypot(c.x - x, c.y - y) < 3)) : cs.filter(c => near(c.x, c.y));
      assert.deepEqual(bad.map(c => [+c.x.toFixed(1), +c.y.toFixed(1), c.polarity]), [], `texture ${texture}, seed ${seed}`);
    }
  }
});

test('probe: finds the blob near the prediction, not one beyond the radius', () => {
  const img = blobs(200, 200, [{ x: 100.5, y: 100.5, rx: 3, luma: 230 }]);
  const det = new CandidateDetector(200, 200);
  det.detect(img.data);
  const p = det.probe(101.2, 100.1, 0, 1, 2);
  assert.ok(p.x !== undefined && Math.hypot(p.x - 100.5, p.y - 100.5) < 0.3 && p.resp > 50);
  assert.ok(!(det.probe(112, 100.5, 0, 1, 2).resp > 10), 'nothing 11 px away');
});

test('patch NCC and stability: regularized for flat patches, sensitive to structure', () => {
  const side = 8, ball = new Float32Array(side * side), flat = new Float32Array(side * side), flat2 = new Float32Array(side * side);
  for (let i = 0; i < ball.length; i++) { const x = i % side - 3.5, y = Math.floor(i / side) - 3.5; ball[i] = 100 + (x * x + y * y < 6 ? 120 : 0) + r.gauss(); flat[i] = 100 + 1.5 * r.gauss(); flat2[i] = 100 + 1.5 * r.gauss(); }
  const n2 = (SPOT_INTERNALS.noiseK * 1.5) ** 2;
  assert.ok(patchNcc(ball, flat, n2) < 0.2, 'ball vs empty: changed');
  assert.ok(patchNcc(ball, ball, n2) > 0.95, 'ball vs ball: unchanged');
  assert.ok(patchStability(flat, flat2, 2 * n2) >= PARAMS.scan.vacate.minPostStableNcc, 'flat vs flat is stable');
  assert.ok(patchStability(flat, ball, 2 * n2) < 0.2, 'something moved in');
  const plane = quantize(new Float32Array(300 * 300).fill(120), r, 2);
  assert.ok(Math.abs(noiseSigma(plane, 300, 300) - 2) < 0.6, `noise ${noiseSigma(plane, 300, 300)}`);
});

/* ------------------------------------------------------------------ pure vacate rules */

test('impulseOk: full speed in one frame, then no acceleration (D3 §3.3(3))', () => {
  assert.equal(impulseOk([3, 3]), true);
  assert.equal(impulseOk([3]), true);
  assert.equal(impulseOk([0.45, 0.4]), false, 'first step below minStep1D0');
  assert.equal(impulseOk([1, 2]), false, 'σ1 < 0.6·σ2');
  assert.equal(impulseOk([2, 2.7]), true);
  assert.equal(impulseOk([0.6, 1.04]), false, 'σ1 < 0.6·σ2 although the growth rule allows it');
  assert.equal(impulseOk([2, 2.9]), false, 'σ2 > 1.25·σ1 + 0.3');
  assert.equal(impulseOk([4, 3, 2.5, 2]), true, 'perspective decay');
  assert.equal(impulseOk([]), false);
});

test('gradualDeparture: slow start, steps not shrinking, and the start disc left', () => {
  const d0 = 6;
  assert.equal(gradualDeparture([1.5, 2.1, 2.7], 6.3, d0), true);
  assert.equal(gradualDeparture([3.2, 3.5, 3.8], 10.5, d0), false, 'first step at 0.5·d0 or more');
  assert.equal(gradualDeparture([2.5, 2, 1.5], 6, d0), false, 'decelerating (a nudge)');
  assert.equal(gradualDeparture([0.4, 0.5], 0.9, d0), false, 'never left the start disc');
  assert.equal(gradualDeparture([1.5], 1.5, d0), false, 'needs two steps');
});

test('vacateFailures names every failed D3 §3.3 test', () => {
  const ok = { eligible: true, recovered: false, outOfView: false, absenceRatio: 1, ncc: 0.1, postStable: 0.95, surround: 0.02, impulse: { step1D0: 3, step2D0: 3, ok: true }, gradualDeparture: false };
  assert.deepEqual(vacateFailures(ok), []);
  assert.deepEqual(vacateFailures({ ...ok, impulse: null }), [], 'nothing seen leaving is not a failure');
  const V = PARAMS.scan.vacate;
  const cases = [['eligible', false, 'eligibility'], ['recovered', true, 'recovered'], ['outOfView', true, 'outOfView'], ['absenceRatio', V.minAbsence - 0.01, 'persistence'],
    ['ncc', V.maxNcc + 0.01, 'ncc'], ['postStable', V.minPostStableNcc - 0.01, 'postStable'], ['impulse', { step1D0: 0.2, step2D0: 0.2, ok: false }, 'impulse'],
    ['surround', PARAMS.scan.spot.lumaTol + 0.01, 'surround'], ['gradualDeparture', true, 'gradual']];
  for (const [k, v, name] of cases) assert.deepEqual(vacateFailures({ ...ok, [k]: v }), [name], k);
  assert.deepEqual(vacateFailures({ ...ok, absenceRatio: V.minAbsence, ncc: V.maxNcc, postStable: V.minPostStableNcc }), [], 'boundaries pass');
});

test('the coarse scan applies neither the arrival veto nor R1: U3 (impact.js) owns both (checker gap 11)', () => {
  // one owner, one semantics: spots.js only measures (arrivalMovers, positions); vacateFailures has no such test
  const ok = { eligible: true, recovered: false, outOfView: false, absenceRatio: 1, ncc: 0.1, postStable: 0.95, surround: 0.02, impulse: { step1D0: 3, step2D0: 3, ok: true }, gradualDeparture: false };
  assert.deepEqual(vacateFailures({ ...ok, arrivalVeto: true }), []);
  assert.equal(spots.arrivalVetoes, undefined);
  assert.equal(spots.lastToLeave, undefined);
});

/* ------------------------------------------------------------------ pixel-level vacate scenarios (true camera) */

const W = 270, H = 480, BX = 135, BY = 330, R = 3, D0 = 2 * 2 * R;   // d0 = 12 native px (pool 2)
const bg = landscape({ seed: 3, horizonY: 150, texture: 55 });
const clipOf = (objects, o = {}) => makeClip({ w: W, h: H, n: o.n ?? 72, pool: 2, bg, objects, G: o.G, noise: 1.5, seed: o.seed ?? 2, fps: o.fps ?? 30 });
const run = (objects, o = {}) => runSpots(spots, clipOf(objects, o), o.run ?? {});
const A0 = { x: 2 * BX, y: 2 * BY };
const at = (res, x = A0.x, y = A0.y) => res.vacates.filter(v => { const s = res.spots.find(q => q.id === v.spotId); return s && Math.hypot(s.x - x, s.y - y) < 0.5 * D0; });
const valid = res => res.vacates.filter(v => v.valid);
const hit = (kHit, o = {}) => ballPath({ x: BX, y: BY, r: R, kHit, vx: 2, vy: -20, ...o });

/* synthetic candidate lists (coarse px, identity camera) for rules that pixels exercise only by accident */
const I0 = { a: 1, b: 0, tx: 0, ty: 0 }, FLAT = { data: new Uint8Array(W * H).fill(100), w: W, h: H, pool: 2 };
const metaN = n => makeSourceMeta({ width: 2 * W, height: 2 * H, fps: 30, frameCount: n, times: Float64Array.from({ length: n }, (_, k) => k / 30), duration: n / 30 });
const cand = (x, y, o = {}) => ({ x, y, d: 6, z: 40, resp: 30, polarity: 1, contrast: 100, roundness: 1.1, fill: 0.8, luma: 200, scale: 0, ...o });
const noMotion = { data: new Uint8Array(Math.ceil(W / 4) * Math.ceil(H / 4)), w: Math.ceil(W / 4), h: Math.ceil(H / 4), cellPx: 4 };
const motionAt = pts => { const m = { ...noMotion, data: new Uint8Array(noMotion.data.length) }; for (const [x, y] of pts) m.data[Math.floor(y / 4) * m.w + Math.floor(x / 4)] = 1; return m; };
function playCands(n, candsAt, { motion = () => undefined, img = () => FLAT, detector } = {}) {
  const st = new spots.SpotTracker(metaN(n), { pool: 2 });
  for (let k = 0; k < n; k++) { const cs = candsAt(k); st.push(k, k / 30, img(k), cs, I0, { motion: motion(k), detector: detector?.(k) }); }
  return st.finish();
}

test('ball-like needs a consistently detected blob: seen above zMin one frame in three, otherwise only probed weakly, is not one', () => {
  // a clean faint disc in a busy 60-px tile: its probes find it every frame but at z ~ 2 (tile noise), while a
  // detection at z 9 arrives only every third frame (the median z decides, not the best)
  const busy = new Float32Array(W * H).fill(100), bx = 150.5, by = 330.5;
  for (let y = 300; y < 360; y++) for (let x = 120; x < 180; x++) if (Math.abs(x + 0.5 - bx) > 11 || Math.abs(y + 0.5 - by) > 11) busy[y * W + x] = 100 + 30 * Math.sin(x * 1.3) * Math.sin(y * 0.9);
  drawEllipse(busy, W, H, bx, by, 3, 3, 110);
  const det = new CandidateDetector(W, H), rr = rng(5);
  let img = null;
  const res = playCands(60, k => {
    const data = quantize(busy, rr, 1);
    img = { data, w: W, h: H, pool: 2 };
    const cs = det.detect(data).filter(c => Math.hypot(c.x - bx, c.y - by) > 8);
    if (k % 3 === 0) cs.push(cand(bx, by, { z: 9, resp: 5, contrast: 10, roundness: 1.05, luma: 105 }));
    return cs;
  }, { img: () => img, detector: () => det });
  const s = res.spots.find(q => Math.hypot(q.x - 2 * bx, q.y - 2 * by) < 4);
  assert.ok(s && s.presence > 0.9 && s.roundness <= PARAMS.scan.spot.maxEigRatio && s.fill >= PARAMS.scan.spot.minFill, JSON.stringify(s));
  assert.ok(s.z < PARAMS.scan.candidates.zMin && !s.ballLike, `median z ${s.z.toFixed(1)}`);
});

test('vacate: a ball struck with an impulse gives exactly one valid vacate at the address', () => {
  const res = run([hit(40)]);
  const vs = valid(res);
  assert.equal(vs.length, 1, JSON.stringify(res.vacates.map(v => [v.spotId, v.kLast, v.fails])));
  const v = vs[0], s = res.spots.find(q => q.id === v.spotId);
  assert.ok(Math.hypot(s.x - A0.x, s.y - A0.y) < 0.5, 'stabilized native address');
  assert.equal(v.kLast, 40); assert.equal(v.kFirstAbsent, 41);
  assert.ok(v.impulse?.ok && Math.abs(v.impulse.step1D0 - Math.hypot(2, 20) / (2 * R)) < 0.3, JSON.stringify(v.impulse));
  assert.ok(v.absenceRatio >= 0.9 && v.ncc <= 0.6 && v.postStable >= 0.8 && !v.gradualDeparture);
  assert.ok(s.ballLike && Math.abs(s.d - D0) < 0.25 * D0 && s.polarity === 1 && s.presence > 0.95);
  for (const sp of res.spots) assert.deepEqual(check('Spot', sp), []);
  for (const vv of res.vacates) assert.deepEqual(check('VacateEvent', vv), []);
});

test('vacate impulse vs ramp: a raked ball that accelerates from rest is rejected', () => {
  const ramp = { at: k => { const j = Math.max(0, k - 40); return { x: BX + 0.3 * j * j, y: BY - 0.1 * j * j, rx: R, luma: 235 }; } };
  const v = at(run([ramp]));
  assert.equal(v.length, 1);
  assert.equal(v[0].valid, false);
  assert.ok(v[0].impulse && !v[0].impulse.ok, `impulse ${JSON.stringify(v[0].impulse)}`);
  assert.ok(v[0].gradualDeparture, 'gradual-departure veto');
});

test('vacate: a nudge (slow, decelerating) is rejected by the impulse rule alone', () => {
  // starts at 3 px/frame (0.47 d0) and slows down, stopping 2.6 d0 away (out of the 2·d0 patch)
  const nudge = { at: k => { const j = Math.min(Math.max(0, k - 40), 8); return { x: BX + 3 * j - 0.15 * j * (j - 1), y: BY, rx: R, luma: 235 }; } };
  const v = at(run([nudge]));
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].fails, ['impulse']);
  assert.equal(v[0].gradualDeparture, false);
});

test('vacate: a glove at takeaway is rejected by the gradual-departure veto even though its later steps look impulsive', () => {
  // accelerates from rest at 0.9 px/frame²: the start is slow (< 0.5 d0/frame) but a chain from the second
  // post-impact frame already passes the impulse rule, which is exactly what the veto is for
  const glove = { at: k => { const j = Math.max(0, k - 40); return { x: BX + 0.45 * j * j, y: BY, rx: R + 0.5, luma: 232 }; } };
  const v = at(run([glove]));
  assert.equal(v.length, 1);
  assert.ok(v[0].impulse?.ok, 'the impulse test alone would pass it');
  assert.deepEqual(v[0].fails, ['gradual']);
});

test('vacate: a struck sunlit ball (shaded, lit from the side) is ball-like and vacates', () => {
  const bp = hit(40), lit = { at: k => { const s = bp.at(k); return s && { ...s, luma: 245, shade: { dark: 125, light: [1, 0, 0.2] } }; } };
  const res = run([lit]), v = at(res);
  assert.equal(v.length, 1);
  const s = res.spots.find(q => q.id === v[0].spotId);
  assert.ok(s.ballLike && s.roundness <= PARAMS.scan.spot.maxEigRatio, JSON.stringify(s));
  assert.ok(v[0].valid, JSON.stringify(v[0].fails));
});

test('vacate: the tee stays (no tee vacate) and the ball still vacates over it', () => {
  const tee = { at: () => ({ x: BX, y: BY + 4, rx: 0.7, ry: 3, luma: 240 }) };
  const res = run([hit(40), tee]);
  const vs = valid(res);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].kLast, 40);
  assert.ok(!res.vacates.some(v => { const s = res.spots.find(q => q.id === v.spotId); return Math.hypot(s.x - A0.x, s.y - (A0.y + 8)) < 3 && v.kLast > 41; }), 'nothing vacates at the tee');
  assert.ok(!res.spots.some(s => s.ballLike && Math.hypot(s.x - A0.x, s.y - (A0.y + 8)) < 3 && s.lastIndex < 71), 'no ball-like spot leaves from the tee');
});

test('vacate: two balls, one hit: one valid vacate, the other ball stays a spot', () => {
  const res = run([hit(40), ballPath({ x: BX + 24, y: BY + 2, r: R })]);
  const vs = valid(res);
  assert.equal(vs.length, 1);
  assert.ok(Math.hypot(res.spots.find(s => s.id === vs[0].spotId).x - A0.x, 0) < 1);
  const other = res.spots.find(s => Math.hypot(s.x - 2 * (BX + 24), s.y - 2 * (BY + 2)) < 2);
  assert.ok(other && other.lastIndex === 71 && other.ballLike, 'the neighbour stays to the end');
  assert.equal(at(res, other.x, other.y).length, 0);
});

test('vacate: a practice swing over the ball (occluded 5 frames) is recovered, not a vacate', () => {
  const club = { at: k => k >= 38 && k <= 42 ? { x: BX - 30 + 15 * (k - 38), y: BY, rx: 7, ry: 4, luma: 40 } : null };
  const res = run([ballPath({ x: BX, y: BY, r: R }), club]);
  assert.equal(valid(res).length, 0);
  assert.ok(at(res).every(v => v.recovered));
});

test('vacate: occlusion recovery is time-limited (0.3 s: recovered; a new ball after 0.83 s does not undo the shot)', () => {
  const occl = run([ballPath({ x: BX, y: BY, r: R }), { at: k => k >= 40 && k < 50 ? { x: BX + 1, y: BY, rx: 6, luma: 90 } : null }]);
  assert.equal(valid(occl).length, 0);
  assert.ok(at(occl).length >= 1 && at(occl).every(v => v.recovered));
  const soon = run([hit(30), ballPath({ x: BX, y: BY, r: R, fromK: 39 })]);
  assert.equal(valid(soon).length, 0, 'replaced within vacate.recover: an occlusion');
  const late = run([hit(30), ballPath({ x: BX, y: BY, r: R, fromK: 55 })]);
  assert.equal(valid(late).length, 1, 'replaced after vacate.recover: the shot stands');
  assert.equal(valid(late)[0].kLast, 30);
});

test('vacate: a dimming ball (no change in structure) fails the NCC change test', () => {
  const v = at(run([{ at: k => ({ x: BX, y: BY, rx: R, luma: k < 40 ? 235 : 150 }) }]));
  assert.ok(v.length >= 1);
  assert.ok(v.every(e => !e.valid && e.fails.includes('ncc')), JSON.stringify(v.map(e => e.fails)));
});

test('vacate: something moving over the address after the ball left fails the stable post patch', () => {
  const club = { at: k => k >= 43 && k <= 52 ? { x: BX + 6 * Math.sin((k - 43) * 1.3), y: BY + 1, rx: 4, ry: 3, luma: 60 } : null };
  const v = at(run([hit(40), club]));
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].fails, ['postStable']);
});

test('vacate: an address that keeps showing a lookalike after the ball left fails persistence', () => {
  // occlusion recovery would claim a full-strength lookalike first, so it is switched off to isolate the rule
  const noRecover = mergeParams({ scan: { vacate: { recover: { frames: 0, sec: 0 } } } });
  // gone for 3 frames (the watch is confirmed), then present every other frame of the absence window
  const flick = { at: k => k >= 44 && k <= 54 && k % 2 === 0 ? { x: BX, y: BY, rx: R, luma: 235 } : null };
  const v = at(run([hit(40), flick], { run: { params: noRecover } }));
  assert.equal(v.length, 1, JSON.stringify(v.map(e => [e.kLast, e.fails])));
  assert.ok(v[0].absenceRatio < PARAMS.scan.vacate.minAbsence && v[0].fails.includes('persistence'), JSON.stringify(v[0]));
  assert.ok(!v[0].recovered);
});

test('vacate: a spot covered by the golfer is not a vacate (the surround must stay the same ground)', () => {
  // a large dark body slides over the ball at about 2 px/frame and stays: absence, NCC change and a stable post
  // patch all pass, only the ring around the address shows the change
  const body = { at: k => k < 30 ? null : { x: Math.min(BX + 2, BX - 60 + 2 * (k - 30)), y: BY, rx: 24, ry: 40, luma: 55 } };
  const v = at(run([ballPath({ x: BX, y: BY, r: R }), body], { n: 80 }));
  assert.ok(v.length >= 1);
  assert.ok(v.every(e => !e.valid), JSON.stringify(v.map(e => e.fails)));
  assert.ok(v.some(e => e.fails.includes('surround') && e.surround > PARAMS.scan.spot.lumaTol));
  const clean = at(run([hit(40)]));
  assert.ok(clean[0].surround < 0.05, `a struck ball leaves the ring unchanged (${clean[0].surround})`);
});

test('vacate: a ball that leaves the field of view (camera pan) is not a vacate', () => {
  const G = shakePath(60, { seed: 5, amp: 0.3, driftX: 0.9 });
  const clip = clipOf([ballPath({ x: 250, y: 300, r: R })], { n: 60, G });
  const res = runSpots(spots, clip), A = worldToStab(clip, 250, 300);
  const v = at(res, A.x, A.y);
  assert.ok(v.length >= 1, 'the spot was watched as it left');
  assert.ok(v.every(e => !e.valid && e.outOfView && e.fails.includes('outOfView')), JSON.stringify(v.map(e => e.fails)));
});

test('arrival measurement: a body part that arrives and pauses has arrivalMovers > 0; its vacate stays valid for U3 to judge', () => {
  // the veto itself (time-limited, τ-aware) is findImpacts' (tests/hf-impact.test.js runs this scene through it)
  const arriving = (kA, kH) => ({ at: k => { if (k < kA) { const j = kA - k; return { x: BX - 0.4 * j * j, y: BY, rx: R, luma: 235 }; } if (k <= kH) return { x: BX, y: BY, rx: R, luma: 235 }; const j = k - kH; return { x: BX + 2 * j, y: BY - 20 * j, rx: R, luma: 235 }; } });
  const res = run([arriving(20, 38)]), short = at(res);
  assert.equal(short.length, 1);
  assert.deepEqual(short[0].fails, []);
  assert.equal(short[0].valid, true);
  assert.ok(res.spots.find(s => s.id === short[0].spotId).arrivalMovers > 0, 'arrived');
});

test('R1 measurement: both vacates of one address cluster stay valid (U3 picks the last to leave); clusterId is report-only', () => {
  const res = run([ballPath({ x: BX - 15, y: BY, r: R, kHit: 30, vx: -2, vy: -20 }), hit(50)]), vs = valid(res);
  assert.deepEqual(vs.map(v => v.kLast).sort((a, b) => a - b), [30, 50]);
  assert.ok(vs.every(v => !v.fails.length && v.supersededBy === undefined));
  const s1 = res.spots.find(s => s.id === vs[0].spotId), s2 = res.spots.find(s => s.id === vs[1].spotId);
  assert.equal(s1.clusterId, s2.clusterId);
});

test('arrival count: approaching objects only; one leaving the address just before the spot appears does not count', () => {
  // a same-looking object at the address that moves 0.3 -> 3 D away over the frames before the ball's spot first
  // appears (a club head uncovering the ball at takeaway), or one that comes in 4.5 -> 1 D (a body part arriving)
  const play = dists => {
    const out = playCands(60, k => {
      const cs = [];
      if (k >= 10 && k <= 30) cs.push(cand(BX, BY));
      if (k >= 6 && k - 6 < dists.length) cs.push(cand(BX - 6 * dists[k - 6], BY, { d: 7, luma: 205 }));
      return cs;
    });
    const sp = out.spots.find(s => Math.hypot(s.x - A0.x, s.y - A0.y) < 1);
    return { sp, v: out.vacates.find(v => v.spotId === sp?.id) };
  };
  const leave = play([0.3, 1, 2, 3]), come = play([4.5, 3, 2, 1]);
  assert.ok(leave.sp && leave.sp.firstIndex === 10 && come.sp && come.sp.firstIndex === 10);
  assert.equal(leave.sp.arrivalMovers, 0, 'moving away from the address');
  assert.ok(come.sp.arrivalMovers > 0, 'approaching the address');
  // U2 only counts; both vacates stand for findImpacts' veto
  assert.ok(leave.v && come.v && leave.v.valid === come.v.valid, JSON.stringify([leave.v?.fails, come.v?.fails]));
});

test('impulse chains keep the growth rule: a glint far along the launch line does not break a real launch', () => {
  // the ball is lost for one frame (k 44) while a same-polarity glint shows 160 px out on the launch line; a chain
  // that took it would grow 5× in one step, so it is another object and the chain waits for the ball at k 45
  const bp = ballPath({ x: BX, y: BY, r: R, kHit: 40, vx: 2, vy: -20, ay: 1.5 }), u = [2 / Math.hypot(2, 19.25), -19.25 / Math.hypot(2, 19.25)];
  const ball = { at: k => k === 44 ? null : bp.at(k) }, glint = { at: k => k === 44 ? { x: BX + 160 * u[0], y: BY + 160 * u[1], rx: 2.5, luma: 250 } : null };
  const v = at(run([ball, glint]));
  assert.equal(v.length, 1);
  assert.ok(v[0].valid && v[0].impulse?.ok, JSON.stringify([v[0].fails, v[0].impulse]));
});

test('impulse chains use registered motion only: static texture revealed along the launch line is not a departing ball', () => {
  // the address spot is gone after k 30; three blobs that appear then and stay put (grass uncovered by the club)
  // lie on a line from the address at impulse-like spacing; without frame-difference energy they form no chain
  const line = [[20, 0.2], [32, 0.4], [60, 0.6]].map(([s, p]) => [BX + s, BY + p]);
  const res = playCands(72, k => {
    if (k <= 30) return [cand(BX, BY)];
    return line.map(([x, y]) => cand(x, y, { luma: 190 }));
  }, { motion: k => k ? noMotion : undefined });
  const v = res.vacates.find(e => { const s = res.spots.find(q => q.id === e.spotId); return Math.hypot(s.x - A0.x, s.y - A0.y) < 1; });
  assert.ok(v && v.kLast === 30, JSON.stringify(res.vacates.map(e => [e.spotId, e.kLast])));
  assert.equal(v.impulse, null, JSON.stringify(v.impulse));
});

test('two spots on one object give one vacate: the weaker duplicate fails "duplicate"', () => {
  const res = playCands(60, k => k <= 30 ? [cand(BX, BY, { z: 40 }), cand(BX + 0.8, BY + 0.4, { z: 30, d: 5.6 })] : []);
  const vs = res.vacates.filter(e => e.kLast === 30);
  assert.equal(vs.length, 2, JSON.stringify(res.vacates.map(e => [e.spotId, e.kLast, e.fails])));
  assert.equal(vs.filter(e => e.valid).length, 1);
  const dup = vs.find(e => !e.valid), keep = vs.find(e => e.valid);
  assert.deepEqual(dup.fails, ['duplicate']);
  assert.ok(res.spots.find(q => q.id === keep.spotId).z > res.spots.find(q => q.id === dup.spotId).z, 'the stronger detection stands');
});

test('two records of one ball (split at address): the surviving record counts the frames either record saw', () => {
  // A (stronger) sees the ball in frames 0-11, every other frame to 33 and 34-45: 35 of 46, under minPresence alone.
  // B, 0.45 D off (too far to link, close enough to be one object), sees it every frame from 12 on. Both leave at 45.
  const res = playCands(60, k => {
    const out = [];
    if (k <= 45 && (k < 12 || k > 33 || k % 2 === 0)) out.push(cand(BX, BY, { z: 40 }));
    if (k >= 12 && k <= 45) out.push(cand(BX + 2.7, BY, { z: 30 }));
    return out;
  });
  const vs = res.vacates.filter(e => e.kLast === 45);
  assert.equal(vs.length, 2, JSON.stringify(res.vacates.map(e => [e.spotId, e.kLast, e.fails])));
  const keep = vs.find(e => e.valid), dup = vs.find(e => !e.valid), sp = res.spots.find(q => q.id === keep?.spotId);
  assert.deepEqual(dup?.fails, ['duplicate']);
  assert.ok(sp && Math.hypot(sp.x - A0.x, sp.y - A0.y) < 1, 'the stronger record stands');
  assert.ok(sp.presence >= 0.95, `presence ${sp.presence}: the object was seen in every frame`);
});

test('movers are tracklets on registered motion: the same constant-velocity track without frame-difference energy is none', () => {
  const at = k => [BX + 100 - 4 * k, 80 + 0.5 * k], track = k => k < 30 ? [cand(...at(k), { d: 3.2, luma: 60, polarity: -1 })] : [];
  const moving = playCands(40, track, { motion: k => k && k < 30 ? motionAt([at(k)]) : noMotion });
  assert.equal(moving.movers.length, 1, JSON.stringify(moving.movers));
  assert.ok(Math.abs(moving.movers[0].vx + 8) < 0.5 && Math.abs(moving.movers[0].vy - 1) < 0.5);
  assert.deepEqual(playCands(40, track, { motion: () => noMotion }).movers, [], 'misregistered static texture');
});

test('spots persist through 1-3 px shake and odd/sub-pixel drift (v2 tracker-detection-I4)', () => {
  for (const [name, o] of [['shake 3 px', { amp: 3 }], ['odd drift', { amp: 1, driftX: 0.37, driftY: -0.23 }], ['shake + drift', { amp: 2, driftX: -0.51, driftY: 0.29 }]]) {
    const G = shakePath(90, { seed: 6, ...o });
    const clip = clipOf([ballPath({ x: BX, y: BY, r: R })], { n: 90, G });
    const res = runSpots(spots, clip), A = worldToStab(clip, BX, BY);
    const s = res.spots.filter(q => Math.hypot(q.x - A.x, q.y - A.y) < 0.5 * D0);
    assert.equal(s.length, 1, `${name}: one address spot`);
    assert.ok(s[0].firstIndex === 0 && s[0].lastIndex === 89 && s[0].presence >= 0.95, `${name}: ${JSON.stringify(s[0])}`);
    assert.equal(at(res, A.x, A.y).length, 0, `${name}: no vacate watch ever opened`);
  }
});

test('an established address spot survives being crowded out of the candidate caps (local probe)', () => {
  // from frame 20 eight brighter blobs share the ball's tile, so the per-tile cap drops the ball from the candidates
  const crowd = [];
  for (let i = 0; i < 8; i++) crowd.push({ at: k => k >= 20 ? { x: 125 + 7 * (i % 4) + (i % 4 > 1 ? 14 : 0), y: 318 + (i < 4 ? 0 : 26), rx: 2.5, luma: 255 } : null });
  const res = run([ballPath({ x: BX, y: BY, r: R, luma: 200 }), ...crowd], { n: 60 });
  const s = res.spots.filter(q => Math.hypot(q.x - A0.x, q.y - A0.y) < 0.5 * D0);
  assert.equal(s.length, 1);
  assert.ok(s[0].lastIndex === 59 && s[0].presence >= 0.95, JSON.stringify(s[0]));
  assert.equal(at(res).length, 0);
});

/* ------------------------------------------------------------------ movers, specks, clusters, stride */

test('movers: an airplane crossing before impact is a pre-impact mover; a slow sky track is a sky mover', () => {
  const plane = { at: k => k < 50 ? { x: 250 - 4 * k, y: 60 + 0.5 * k, rx: 1.6, luma: 60 } : null };
  const glider = { at: k => ({ x: 40 + 0.5 * k, y: 100, rx: 1.8, luma: 70 }) };
  const res = run([hit(55), plane, glider], { n: 75 });
  const pre = res.movers.filter(m => m.kind === 'preimpact'), sky = res.movers.filter(m => m.kind === 'sky');
  assert.equal(pre.length, 1, JSON.stringify(res.movers));
  assert.ok(Math.abs(pre[0].vx - 2 * -4) < 0.6 && Math.abs(pre[0].vy - 2 * 0.5) < 0.6, 'native px per frame');
  assert.ok(pre[0].index0 < 55 && Math.abs(pre[0].y - (2 * (60 + 0.5 * pre[0].index0))) < 3);
  assert.equal(sky.length, 1);
  assert.ok(Math.abs(sky[0].vx - 1) < 0.3 && Math.abs(sky[0].vy) < 0.3);
  for (const m of res.movers) assert.deepEqual(check('Mover', m), []);
  const quiet = run([hit(40)]);
  assert.equal(quiet.movers.length, 0, 'the ball after impact and static texture are not movers');
});

test('specks: a lens-fixed blob is found in raw coordinates only when the camera moves under it', () => {
  const G = shakePath(60, { seed: 9, amp: 2.5, driftX: 0.2 });
  const speckRaw = { x: 60.5, y: 220.5 };
  const withSpeck = (G0) => {
    const clip = clipOf([ballPath({ x: BX, y: BY, r: R })], { n: 60, G: G0 });
    const frame0 = clip.frame;
    clip.frame = k => { const d = frame0(k), f = Float32Array.from(d); drawEllipse(f, W, H, speckRaw.x, speckRaw.y, 2, 2, 40); return quantize(f); };
    clip.image = k => ({ data: clip.frame(k), w: W, h: H, pool: 2 });
    return runSpots(spots, clip);
  };
  const moving = withSpeck(G);
  assert.equal(moving.specks.length, 1, JSON.stringify(moving.specks));
  assert.ok(Math.hypot(moving.specks[0].x - 2 * speckRaw.x, moving.specks[0].y - 2 * speckRaw.y) < 1 && moving.specks[0].r > 2);
  assert.deepEqual(check('Speck', moving.specks[0]), []);
  assert.equal(withSpeck(null).specks.length, 0, 'a static camera cannot tell a speck from the scene');
});

test('clusters group spots within clusterD diameters; arrival counts default to 0 for a ball present from the start', () => {
  const res = run([ballPath({ x: BX, y: BY, r: R }), ballPath({ x: BX + 18, y: BY, r: R }), ballPath({ x: BX - 80, y: BY - 60, r: R })], { n: 30 });
  const find = (x, y) => res.spots.find(s => Math.hypot(s.x - 2 * x, s.y - 2 * y) < 2);
  const a = find(BX, BY), b = find(BX + 18, BY), c = find(BX - 80, BY - 60);
  assert.ok(a && b && c);
  assert.equal(a.clusterId, b.clusterId);
  assert.notEqual(a.clusterId, c.clusterId);
  assert.equal(a.arrivalMovers, 0);
});

test('vacate windows are in frames at any rate: a 240 fps clip analyzed at stride 4', () => {
  // 2.5 d0 per container frame (E6 DTL 240 fps: p05 2.1, p50 2.8); windows Q = 0.3 s = 72 frames, recover 0.6 s = 144
  const clip = makeClip({ w: W, h: H, n: 300, pool: 2, bg, fps: 240, objects: [ballPath({ x: BX, y: BY, r: R, kHit: 150, vx: 1.5, vy: -14.9 })], noise: 1.5, seed: 4 });
  const res = runSpots(spots, clip, { stride: 4 });
  const vs = valid(res);
  assert.equal(vs.length, 1, JSON.stringify(res.vacates.map(v => [v.kLast, v.fails])));
  assert.ok(vs[0].kLast >= 147 && vs[0].kLast <= 150 && vs[0].kFirstAbsent - vs[0].kLast === 4);
  assert.ok(vs[0].impulse?.ok && Math.abs(vs[0].impulse.step1D0 - Math.hypot(1.5, 14.9) / 6) < 0.2, `per-frame steps ${JSON.stringify(vs[0].impulse)}`);
});

test('a slow chip at 240 fps (0.8 d0/frame, stride 4) stays valid: the step out of k_last is never judged', () => {
  // the analyzed frame after k_last sees the ball only 2 frames into its flight, i.e. 0.4 d0/frame over the gap
  const clip = makeClip({ w: W, h: H, n: 300, pool: 2, bg, fps: 240, objects: [ballPath({ x: BX, y: BY, r: R, kHit: 150, vx: 0.5, vy: -4.8 })], noise: 1.5, seed: 4 });
  const v = at(runSpots(spots, clip, { stride: 4 }));
  assert.equal(v.length, 1);
  assert.equal(v[0].valid, true, JSON.stringify(v[0].fails));
  assert.equal(v[0].gradualDeparture, false);
});

test('a blob crawling over the lens is not a lens speck (raw-drift test)', () => {
  const clip = clipOf([ballPath({ x: BX, y: BY, r: R })], { n: 60, G: shakePath(60, { seed: 9, amp: 2.5 }) });
  const f0 = clip.frame;
  clip.image = k => { const f = Float32Array.from(f0(k)); drawEllipse(f, W, H, 60.5 + 0.15 * k, 220.5, 2, 2, 35); return { data: quantize(f), w: W, h: H, pool: 2 }; };
  assert.equal(runSpots(spots, clip).specks.length, 0);
});

test('two lights moving together are one mover, not two', () => {
  const lights = [0, 1].map(i => ({ at: k => k < 50 ? { x: 250 + 4 * i - 4 * k, y: 60 + 3 * i + 0.5 * k, rx: 1.6 - 0.2 * i, luma: 60 } : null }));
  const res = run([hit(55), ...lights], { n: 75 });
  assert.equal(res.movers.filter(m => m.kind === 'preimpact').length, 1, JSON.stringify(res.movers));
});

test('SpotTracker validates its input order', () => {
  const st = new spots.SpotTracker(makeSourceMeta({ width: 540, height: 960, fps: 30, frameCount: 2, times: Float64Array.from([0, 1 / 30]), duration: 2 / 30 }), { pool: 2 });
  const img = { data: new Uint8Array(W * H).fill(100), w: W, h: H, pool: 2 };
  st.push(1, 0, img, [], { a: 1, b: 0, tx: 0, ty: 0 });
  assert.throws(() => st.push(1, 0, img, [], { a: 1, b: 0, tx: 0, ty: 0 }), /not increasing/);
});
