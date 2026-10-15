import test from 'node:test';
import assert from 'node:assert/strict';
import { CoarseScanner, EnergyRecorder, estimateHorizon, energyRuns, passEnergy } from '../dist/hf/coarse-scan.js';
import { PARAMS, mergeParams, scanStride } from '../dist/hf/params.js';
import { check, simAt, applySim, invertSim, composeSim, makeSourceMeta, createMemorySource, coarsePool, cameraSamples } from '../dist/hf/types.js';
import { makeClip, scanClip, swing, shakePath, landscape, worldToStab, ballPath, simError, quantize, rng, drawEllipse, renderField, fbm } from './hf/helpers/u2-scene.mjs';
// cross-unit (checker gaps 6 and 11): the arrival veto and R1 are findImpacts' since the E2 fix round, so "one launch
// at the address" is asserted on what reaches U3, not on the coarse scan's own valid flags
import { findImpacts } from '../dist/hf/impact.js';

// Small coarse frames for behaviour (270×480 at pool 2: meta 540×960 with longEdge 480); 540×960 for the budget.
const P480 = mergeParams({ scan: { longEdge: 480 } });
const W = 270, H = 480, BX = 150, BY = 380, R = 3;
const bg = landscape({ seed: 8, horizonY: 140, texture: 60 });
const swingClip = (o = {}, shake = 0, n) => {
  const sw = swing({ bx: BX, by: BY, r: R, ...o });
  const clip = makeClip({ w: W, h: H, n: n ?? sw.n, pool: 2, bg, objects: sw.objects, G: shake ? shakePath(n ?? sw.n, { seed: 3, amp: shake, driftX: 0.2 }) : null, noise: 1.5, seed: 5 });
  return { sw, clip };
};
const near = (log, A, f = v => v.valid) => log.vacates.filter(f).filter(v => { const s = log.spots.find(q => q.id === v.spotId); return Math.hypot(s.x - A.x, s.y - A.y) < 6; });

let cached = null;
function struck() {
  if (cached) return cached;
  const { sw, clip } = swingClip({}, 2);
  const res = scanClip(CoarseScanner, clip, { params: P480 });
  return (cached = { sw, clip, ...res, A: worldToStab(clip, BX, BY) });
}

test('a full swing under shake: one valid vacate at the address, at impact, and a valid CoarseLog', () => {
  const { log, clip, A, sw } = struck();
  assert.deepEqual(check('CoarseLog', log), []);
  assert.equal(log.pool, 2); assert.equal(log.w, W); assert.equal(log.h, H); assert.equal(log.stride, 1);
  assert.equal(log.frames.index.length, clip.n); assert.equal(log.camera.index.length, clip.n);
  const at = near(log, A);
  assert.equal(at.length, 1, JSON.stringify(log.vacates.filter(v => !v.recovered).map(v => [v.spotId, v.kLast, v.fails])));
  const v = at[0], s = log.spots.find(q => q.id === v.spotId);
  assert.ok(Math.hypot(s.x - A.x, s.y - A.y) < 1, 'address in stabilized native px');
  assert.equal(v.kLast, sw.kHit);
  // the other valid vacates (glove, head) are arrivals: U3's arrival veto removes them, one hypothesis remains
  const hyps = findImpacts(log, clip.meta, { params: P480 });
  assert.deepEqual(hyps.map(h => h.kLast), [sw.kHit], JSON.stringify(log.vacates.filter(q => q.valid).map(q => [q.spotId, q.kLast])));
  assert.ok(log.vacates.filter(q => q.valid && q !== v).every(q => log.spots.find(sp => sp.id === q.spotId).arrivalMovers > 0));
  assert.ok(Math.abs(s.d - 4 * R) < 3 && s.ballLike);
  assert.ok(v.impulse?.ok && v.impulse.step1D0 > 2, JSON.stringify(v.impulse));
  // extension fields
  assert.equal(log.motionEnergy.length, clip.n);
  assert.ok(log.candidates.n > 0 && log.candidates.frameStart.length === clip.n + 1);
  assert.ok(log.diagnostics.msPerFrame.camera > 0);
});

test('the estimated camera path matches the true shake within 0.2 coarse px (0.4 native at pool 2)', () => {
  const { log, clip } = struck();
  let worst = 0;
  for (let k = 0; k < clip.n; k++) {
    const T = composeSim(clip.G[k], invertSim(clip.G[0])), Tn = { a: T.a, b: T.b, tx: 2 * T.tx, ty: 2 * T.ty };
    worst = Math.max(worst, simError(simAt(log.camera, k), Tn, 2 * W, 2 * H, 40));
  }
  assert.ok(worst <= 0.4, `worst ${worst.toFixed(3)} native px`);
  assert.ok([...log.camera.inlier].every(x => x >= PARAMS.scan.camera.minInlierRatio), 'the swing never makes the camera unusable');
  // renderer samples agree with the true path's samples (normalized translation at the frame centre, s, r)
  const meta = makeSourceMeta(clip.meta), cam = cameraSamples(log.camera, meta);
  const truth = { index: log.camera.index, t: log.camera.t, inlier: log.camera.inlier, sim: Float64Array.from({ length: 4 * clip.n }, (_, i) => { const T = composeSim(clip.G[i >> 2], invertSim(clip.G[0])); return [T.a, T.b, 2 * T.tx, 2 * T.ty][i & 3]; }) };
  cameraSamples(truth, meta).forEach((c, k) => assert.ok(Math.abs(c.x - cam[k].x) * 2 * W < 0.4 && Math.abs(c.y - cam[k].y) * 2 * H < 0.4 && Math.abs(c.r - cam[k].r) < 1e-3, `sample ${k}`));
});

test('practice swing over the ball, a whiff and a swing without a ball give no impact hypothesis', () => {
  for (const [name, o] of [['practice / whiff', { hit: false }], ['no ball', { ball: false }]]) {
    const { clip } = swingClip(o, 1);
    const { log } = scanClip(CoarseScanner, clip, { params: P480 });
    assert.equal(near(log, worldToStab(clip, BX, BY)).length, 0, `${name}: the ball never leaves the address`);
    assert.deepEqual(findImpacts(log, clip.meta, { params: P480 }), [], `${name}: ${JSON.stringify(log.vacates.filter(v => v.valid).map(v => [v.spotId, v.kLast]))}`);
  }
});

test('a chrome club head resting behind the ball does not steal the vacate', () => {
  const { clip } = swingClip({ club: 'chrome' }, 1);
  const { log } = scanClip(CoarseScanner, clip, { params: P480 });
  const at = near(log, worldToStab(clip, BX, BY));
  assert.equal(at.length, 1);
  assert.equal(at[0].kLast, 64);
  assert.deepEqual(findImpacts(log, clip.meta, { params: P480 }).map(h => h.kLast), [64]);
});

test('pass energy: the club passage peaks at impact in the small disk; static texture under shake stays silent', () => {
  const { log, A, sw } = struck();
  const E = PARAMS.scan.energy, rs = Math.max(E.smallDisk.d0 * 4 * R, E.smallDisk.fracH * 2 * H);
  const e = log.energy.disk(A.x, A.y, rs, 0, sw.n);
  assert.equal(e.index.length, sw.n);
  const pk = e.index[e.e.indexOf(Math.max(...e.e))];
  assert.ok(pk >= sw.kHit && pk <= sw.kHit + 1, `peak at ${pk}`);
  // before takeaway under 2 px shake only sub-pixel-phase residue of the sharp ball and club head remains: the
  // impact peak stands well above its median (D2 swing support needs peak/baseline >= 4)
  const quiet = [...log.energy.disk(A.x, A.y, rs, 0, 25).e].sort((a, b) => a - b), base = Math.max(1, quiet[quiet.length >> 1]);
  assert.ok(Math.max(...e.e) / base >= 2 * PARAMS.impact.clubPassage.supportRatio, `peak ${Math.max(...e.e)} vs quiet median ${base}`);
  assert.ok(log.energy.active(pk, A.x, A.y, rs) > 0, 'cells under the club passage are active');
  // without shake the registered difference of the static scene is exactly silent
  const still = swingClip({}, 0, 30), sl = scanClip(CoarseScanner, still.clip, { params: P480 }).log, As = worldToStab(still.clip, BX, BY);
  assert.equal(Math.max(...sl.energy.disk(As.x, As.y, rs, 0, 25).e), 0);
  assert.equal(sl.energy.active(10, As.x, As.y, rs), 0);
  assert.equal(log.energy.cellPx, E.cellPx * 2);
  // the motion union over the downswing covers the address and the club arc, not the far sky
  const u = log.energy.union(sw.kHit - 6, sw.kHit + 2), cell = (x, y) => u.mask[Math.floor(y / u.cellPx) * u.w + Math.floor(x / u.cellPx)];
  let hitNear = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) hitNear += cell(A.x + dx * u.cellPx, A.y + dy * u.cellPx);
  assert.ok(hitNear > 0, 'motion at the address during impact');
  assert.equal(cell(40, 40), 0);
  assert.ok([...log.motionEnergy].slice(0, 25).every(e => e === 0), 'nothing moves before takeaway, even under shake');
});

test('energyRuns: runs above max(runVsMedian·median, runVsMax·max); strong at max(strongVsMedian·median, strongVsMax·max)', () => {
  const idx = Array.from({ length: 12 }, (_, i) => 10 + i);
  const r1 = energyRuns(idx, [0, 0, 5, 100, 120, 3, 0, 0, 60, 0, 0, 0]);
  assert.deepEqual(r1.map(r => [r.k0, r.k1, r.peak, r.strong]), [[13, 14, 120, true], [18, 18, 60, true]]);
  const flat = [10, 10, 10, 10, 10, 300, 10, 10, 10, 10, 260, 10];
  assert.deepEqual(energyRuns(idx, flat).map(r => [r.k0, r.strong]), [[15, false], [20, false]], 'median-relative thresholds');
  assert.deepEqual(energyRuns(idx, flat.map((v, i) => i === 5 ? 600 : v)).map(r => [r.k0, r.strong]), [[15, true], [20, false]], 'strong needs max(50·10, 0.1·600) = 500');
  assert.deepEqual(energyRuns(idx, new Array(12).fill(0)), []);
  // 100 is above 0.05·max but below 25·median: not a run
  assert.deepEqual(energyRuns(idx, [10, 10, 10, 10, 10, 10, 10, 10, 100, 1000, 10, 10]).map(r => [r.k0, r.k1]), [[19, 19]]);
});

test('pass energy per vacate: the struck ball has a strong small-disk run at impact (soft timing support)', () => {
  const { log, sw, A } = struck();
  const v = near(log, A)[0], pe = v.passEnergy;
  assert.ok(pe && pe.timing, JSON.stringify(pe));
  assert.ok(pe.runs.small.some(r => r.strong && r.k0 <= sw.kHit + 1 && r.k1 >= sw.kHit));
  assert.ok(pe.smallRadius >= PARAMS.scan.energy.smallDisk.d0 * 4 * R - 2 && pe.largeRadius > pe.smallRadius);
  const off = passEnergy(log.energy, log.spots.find(q => q.id === v.spotId), { kLast: 20, kFirstAbsent: 21 }, log.frames.index, clipMeta(), PARAMS);
  assert.equal(off.timing, false, 'no strong run at a time with no club passage');
});
const clipMeta = () => ({ width: 2 * W, height: 2 * H });

test('energy cells: registration ignores sub-pixel camera motion, a real mover registers', () => {
  const er = new EnergyRecorder(200, 200, 1);
  const f = landscape({ seed: 4, horizonY: -1, texture: 60 }), r = rng(3);
  const frame = (dx, dy, blob) => {
    const fr = new Float32Array(200 * 200);
    for (let j = 0; j < 200; j++) for (let i = 0; i < 200; i++) fr[j * 200 + i] = f(i + 0.5 - dx, j + 0.5 - dy);
    if (blob) drawEllipse(fr, 200, 200, blob.x, blob.y, 4, 4, 240);
    const d = quantize(fr, r, 1);
    const h = { data: new Uint8Array(100 * 100), w: 100, h: 100 };
    for (let j = 0; j < 100; j++) for (let i = 0; i < 100; i++) h.data[j * 100 + i] = (d[2 * j * 200 + 2 * i] + d[2 * j * 200 + 2 * i + 1] + d[(2 * j + 1) * 200 + 2 * i] + d[(2 * j + 1) * 200 + 2 * i + 1] + 2) >> 2;
    return h;
  };
  const a = frame(0, 0), b = frame(1.7, -2.3), c = frame(1.7, -2.3, { x: 100, y: 100 });
  er.add(0, null, a, null, { a: 1, b: 0, tx: 0, ty: 0 });
  er.add(1, a, b, { a: 1, b: 0, tx: 1.7, ty: -2.3 }, { a: 1, b: 0, tx: 1.7, ty: -2.3 });
  er.add(2, b, c, { a: 1, b: 0, tx: 0, ty: 0 }, { a: 1, b: 0, tx: 1.7, ty: -2.3 });
  assert.ok(er.total[1] < 0.02 * er.total[2], `shift ${er.total[1]} vs mover ${er.total[2]}`);
  const st = er.store();
  // the blob sits at raw (100, 100) of frame 2, i.e. stabilized (98.3, 102.3) (S maps stabilized -> raw)
  assert.ok(st.active(2, 98.3, 102.3, 6) > 0.5 && st.active(1, 98.3, 102.3, 6) === 0, `${st.active(2, 98.3, 102.3, 6)} ${st.active(1, 98.3, 102.3, 6)}`);
  assert.ok(er.frames[1].sparse, 'quiet frames are stored sparse');
});

test('energy store: sparse frames answer disk and active exactly like a brute-force scan of their cells, in any query order', () => {
  // the store expands one sparse frame at a time into a dense scratch; queries that alternate frames must not mix them
  const er = new EnergyRecorder(120, 80, 2), cw = er.cw, ch = er.ch, rr = rng(9), cells = [];
  for (let f = 0; f < 4; f++) {
    const on = new Map();
    for (let n = 0; n < 12; n++) on.set(Math.floor(rr() * cw * ch), 1 + Math.floor(rr() * 200));
    cells.push(on);
    // write the frame record directly (sparse), as add() would for a quiet frame
    er.frames.push({ sparse: Uint32Array.from([...on].sort((a, b) => a[0] - b[0]).map(([c, v]) => (c << 8) | v)) });
    er.index.push(10 + f); er.sims.push({ a: 1, b: 0, tx: 0.7 * f, ty: -0.4 * f }); er.total.push(0);
  }
  const st = er.store(), cpx = st.cellPx, area = er.cell * er.cell;
  const brute = (f, x, y, r) => {
    const S = er.sims[f], cx = (x + S.tx) / cpx, cy = (y + S.ty) / cpx, rc = r / cpx;
    let s = 0, on = 0, all = 0;
    for (let j = Math.max(0, Math.floor(cy - rc - 0.5)); j <= Math.min(ch - 1, Math.floor(cy + rc - 0.5) + 1); j++)
      for (let i = Math.max(0, Math.floor(cx - rc - 0.5)); i <= Math.min(cw - 1, Math.floor(cx + rc - 0.5) + 1); i++) {
        if (!((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= rc * rc || (i === Math.floor(cx) && j === Math.floor(cy)))) continue;
        const v = cells[f].get(j * cw + i) ?? 0;
        all++; s += v; if (v) on++;
      }
    return { s: s * area, frac: all ? on / all : 0 };
  };
  for (let q = 0; q < 300; q++) {
    const f = Math.floor(rr() * 4), x = rr() * 240, y = rr() * 160, r = 1 + rr() * 30;
    assert.ok(Math.abs(st.active(10 + f, x, y, r) - brute(f, x, y, r).frac) < 1e-12, `active f${f} (${x}, ${y}, ${r})`);
    const d = st.disk(x, y, r, 10, 13);
    for (let j = 0; j < 4; j++) assert.ok(Math.abs(d.e[j] - brute(j, x, y, r).s) < 1e-3, `disk f${j}`);
  }
});

test('horizon: the sky/ground boundary in stabilized native px, and none without a sky', () => {
  const { log, clip } = struck();
  assert.ok(log.horizon && log.horizon.conf >= PARAMS.scan.horizon.minConf, JSON.stringify(log.horizon));
  // the boundary is where the sky ends, so it is reported as a sky line (checker gap 4): the geometric horizon lies
  // on or below it, a one-sided bound for the flight model's pitch prior
  assert.equal(log.horizon.kind, 'skyline');
  assert.deepEqual(check('Horizon', log.horizon), []);
  const p = applySim(clip.G[0], 135, 140), want = 2 * p.y;                    // world y 140 seen in frame 0
  assert.ok(Math.abs(log.horizon.y0 + log.horizon.slope * 2 * 135 - want) < 4, `y at centre ${log.horizon.y0 + log.horizon.slope * 270} vs ${want}`);
  assert.ok(Math.abs(log.horizon.slope) < 0.02);
  const ground = landscape({ seed: 8, horizonY: -1e9, texture: 60 });
  const img = makeClip({ w: W, h: H, n: 1, pool: 2, bg: ground, noise: 1.5 }).image(0);
  assert.equal(estimateHorizon(img), null);
  const tilt = th => makeClip({ w: W, h: H, n: 1, pool: 2, bg, noise: 1.5, G: [{ a: Math.cos(th), b: Math.sin(th), tx: 0, ty: 0 }] }).image(0);
  const hz = estimateHorizon(tilt(0.05));
  assert.ok(hz && Math.abs(hz.slope - Math.tan(0.05)) < 0.01, JSON.stringify(hz));
  assert.equal(hz.kind, 'skyline');
  assert.equal(estimateHorizon(tilt(15 * Math.PI / 180)), null, 'steeper than scan.horizon.maxTiltDeg');
  // a stronger edge between two smooth bands lower down is not the horizon: texture must lie below it
  const banded = (x, y) => y > 330 && y < 360 ? 225 : y >= 360 && y < 400 ? 40 : bg(x, y);
  const hb = estimateHorizon(makeClip({ w: W, h: H, n: 1, pool: 2, bg: banded, noise: 1.5 }).image(0));
  assert.ok(hb && Math.abs(hb.y0 - 140) < 3, JSON.stringify(hb));
});

test('the address spot persists under 3 px shake plus odd/sub-pixel drift with the estimated camera (tracker-detection-I4)', () => {
  const n = 120, G = shakePath(n, { seed: 13, amp: 3, driftX: 0.37, driftY: -0.23 });
  const clip = makeClip({ w: W, h: H, n, pool: 2, bg, objects: [ballPath({ x: BX, y: BY, r: R })], G, noise: 1.5, seed: 6 });
  const { log } = scanClip(CoarseScanner, clip, { params: P480 });
  const A = worldToStab(clip, BX, BY), s = log.spots.filter(q => Math.hypot(q.x - A.x, q.y - A.y) < 6);
  assert.equal(s.length, 1);
  assert.ok(s[0].firstIndex === 0 && s[0].lastIndex === n - 1 && s[0].presence >= 0.95, JSON.stringify(s[0]));
  assert.equal(near(log, A, () => true).length, 0, 'never even watched');
  assert.equal(log.vacates.filter(v => v.valid).length, 0, JSON.stringify(log.vacates.filter(v => v.valid)));
});

test('movers and lens specks come out of the scan with the registered energy', () => {
  const n = 80, G = shakePath(n, { seed: 21, amp: 2 });
  const plane = { at: k => k < 50 ? { x: 250 - 4 * k, y: 60 + 0.5 * k, rx: 1.6, luma: 60 } : null };
  const clip = makeClip({ w: W, h: H, n, pool: 2, bg, objects: [ballPath({ x: BX, y: BY, r: R, kHit: 55, vx: 3, vy: -40 }), plane], G, noise: 1.5, seed: 7 });
  const frame0 = clip.frame;
  clip.image = k => { const f = Float32Array.from(frame0(k)); drawEllipse(f, W, H, 40.5, 300.5, 2, 2, 35); return { data: quantize(f), w: W, h: H, pool: 2 }; };
  const { log } = scanClip(CoarseScanner, clip, { params: P480 });
  assert.equal(log.vacates.filter(v => v.valid).length, 1);
  const pre = log.movers.filter(m => m.kind === 'preimpact');
  assert.equal(pre.length, 1, JSON.stringify(log.movers));
  assert.ok(Math.abs(pre[0].vx + 8) < 0.8 && Math.abs(pre[0].vy - 1) < 0.8);
  assert.equal(log.specks.length, 1, JSON.stringify(log.specks));
  assert.ok(Math.hypot(log.specks[0].x - 81, log.specks[0].y - 601) < 1.5, 'raw native px');
});

test('the accelerating downswing through impact is never a mover; swing parts off registered motion are not either', () => {
  // a constant-velocity mover through impact would mask the ball's first flight frames downstream (U6)
  const { log, sw } = struck();
  assert.ok(!log.movers.some(m => m.index1 >= sw.kHit - 2 && m.index0 <= sw.kHit + 2), JSON.stringify(log.movers));
  const sw2 = swing({ bx: BX, by: BY, r: R });
  const clip = makeClip({ w: W, h: H, n: sw2.n, pool: 2, bg, objects: sw2.objects, G: shakePath(sw2.n, { seed: 3, amp: 1 }), noise: 1.5, seed: 5 });
  assert.deepEqual(scanClip(CoarseScanner, clip, { params: P480 }).log.movers, []);
});

test('a dusty lens: recognized specks are masked out of the camera patches and the camera tracks the scene', () => {
  // 48 dark specks over textured ground: before they are recognized some key patches sit on them (outliers that
  // pull the inlier ratio down); afterwards the speck boxes keep them out of the estimate
  const n = 60, G = shakePath(n, { seed: 7, amp: 1, driftX: 0.6, driftY: 0.3 }), ground = landscape({ seed: 8, horizonY: -1e9, texture: 40 });
  const clip = makeClip({ w: W, h: H, n, pool: 2, bg: ground, objects: [], G, noise: 1.2, seed: 9 });
  const f0 = clip.frame, dust = Array.from({ length: 48 }, (_, i) => ({ x: 18 + (i % 8) * 33 + 0.5, y: 24 + Math.floor(i / 8) * 71.7 + 0.5 }));
  clip.image = k => { const f = Float32Array.from(f0(k)); for (const d of dust) drawEllipse(f, W, H, d.x, d.y, 2.2, 2.2, 30); return { data: quantize(f), w: W, h: H, pool: 2 }; };
  const { log } = scanClip(CoarseScanner, clip, { params: P480 });
  assert.ok(log.specks.length >= 40, `specks ${log.specks.length}`);
  const late = [...log.camera.inlier].slice(21).sort((a, b) => a - b);
  assert.ok(late[late.length >> 1] >= 0.9, `inlier ratio median ${late[late.length >> 1].toFixed(2)} once the specks are known`);
  const inc = [];
  for (let k = 21; k < n; k++) {
    const Te = composeSim(simAt(log.camera, k), invertSim(simAt(log.camera, k - 1))), Tt = composeSim(clip.G[k], invertSim(clip.G[k - 1]));
    const pe = applySim(Te, W, H), pt = applySim(Tt, W / 2, H / 2);
    inc.push(Math.hypot(pe.x - W - 2 * (pt.x - W / 2), pe.y - H - 2 * (pt.y - H / 2)));
  }
  inc.sort((a, b) => a - b);
  assert.ok(inc[inc.length >> 1] <= 0.4, `frame-to-frame error median ${inc[inc.length >> 1].toFixed(2)} native px`);
});

test('drifting clouds above a hazy horizon: the frame-0 horizon keeps the camera on the ground', () => {
  // textured clouds (upper 42 %) drift 0.5 px/frame and fade into a smooth haze band above the horizon, so the
  // horizon is found; without it the key would hold cloud patches and the path would follow the clouds (~10 px)
  const n = 40, G = shakePath(n, { seed: 3, amp: 1.5 }), cl = fbm(43, [24, 11, 6], [1, 0.7, 0.4]), ground = landscape({ seed: 8, horizonY: -1e9, texture: 60 });
  const haze = y => Math.min(1, Math.max(0, (170 - y) / 30)), rr = rng(11);
  const clip = makeClip({ w: W, h: H, n, pool: 2, bg: ground, G, noise: 1.5 });
  clip.image = k => ({ data: quantize(renderField((x, y) => y < 200 ? 185 + 25 * haze(y) * cl(x - 0.5 * k, y) : ground(x, y), W, H, G[k]), rr, 1.5), w: W, h: H, pool: 2 });
  const { log } = scanClip(CoarseScanner, clip, { params: P480 });
  assert.ok(log.horizon && log.horizon.conf >= PARAMS.scan.horizon.minConf, JSON.stringify(log.horizon));
  let worst = 0;
  for (let k = 0; k < n; k++) { const T = composeSim(G[k], invertSim(G[0])); worst = Math.max(worst, simError(simAt(log.camera, k), { a: T.a, b: T.b, tx: 2 * T.tx, ty: 2 * T.ty }, 2 * W, 2 * H, 40)); }
  assert.ok(worst <= 0.6, `worst ${worst.toFixed(2)} native px`);
  assert.ok(Math.min(...log.camera.inlier) >= 0.8, `inlier ratio ${Math.min(...log.camera.inlier).toFixed(2)}`);
});

test('the scanner feeds the camera its registered motion: energy as foreground, the last second of motion as the key mask', () => {
  // contract between the stages (behaviour is pinned in hf-camera: foreground ratio, golfer-settles refresh)
  const { clip } = swingClip({}, 1, 12), sc = new CoarseScanner(clip.meta, { params: P480 }), seen = [], keys = [];
  const push = sc.motion.push.bind(sc.motion), refresh = sc.motion.maybeRefreshKey.bind(sc.motion);
  sc.motion.push = (i, t, f, o) => { seen.push(o); return push(i, t, f, o); };
  sc.motion.maybeRefreshKey = (f, i, o, force) => { keys.push(o); return refresh(f, i, o, force); };
  for (let k = 0; k < 12; k++) sc.push(k, k / 30, clip.image(k));
  assert.equal(seen[0].foreground, undefined);
  for (let k = 1; k < 12; k++) {
    const fg = seen[k].foreground, km = keys[k].excludeMask;
    assert.ok(fg && fg.cellPx === PARAMS.scan.energy.cellPx && fg.data.length === fg.w * fg.h, `frame ${k} foreground`);
    assert.ok(km && km.cellPx === fg.cellPx && km.data !== fg.data, `frame ${k} key mask`);
  }
});

test('scanner contract: input checks, stride from fps, frames from a memory source', async () => {
  const meta = makeSourceMeta({ width: 540, height: 960, fps: 120, frameCount: 3, times: Float64Array.from([0, 1 / 120, 2 / 120]), duration: 3 / 120 });
  const sc = new CoarseScanner(meta, { params: P480 });
  assert.equal(sc.stride, scanStride(120));
  assert.equal(sc.stride, 2);
  assert.throws(() => sc.finish(), /no frames/);
  const img = { data: new Uint8Array(W * H).fill(90), w: W, h: H, pool: 2 };
  assert.throws(() => sc.push(0, 0, { ...img, pool: 1 }), /expected 270×480\/2/);
  assert.throws(() => sc.push(0, 0, { ...img, w: 271 }), /expected/);
  sc.push(0, 0, img);
  assert.throws(() => sc.push(0, 0, img), /not increasing/);
  // driven like the pipeline: ref.lumaCoarse(longEdge) from a FrameSource
  const clip = makeClip({ w: W, h: H, n: 6, pool: 2, bg, objects: [ballPath({ x: BX, y: BY, r: R })], noise: 1.5 });
  const full = k => { const c = clip.frame(k), d = new Uint8Array(4 * W * H); for (let j = 0; j < 2 * H; j++) for (let i = 0; i < 2 * W; i++) d[j * 2 * W + i] = c[(j >> 1) * W + (i >> 1)]; return d; };
  const src = createMemorySource({ width: 2 * W, height: 2 * H, frames: full, frameCount: 6, fps: 30 });
  const s2 = new CoarseScanner(src.meta, { params: P480 });
  assert.equal(coarsePool(2 * W, 2 * H, P480.scan.longEdge), 2);
  for await (const ref of src.frames({ stride: s2.stride })) s2.push(ref.index, ref.t, await ref.lumaCoarse(P480.scan.longEdge));
  const log = s2.finish();
  assert.deepEqual(check('CoarseLog', log), []);
  assert.deepEqual([...log.frames.index], [0, 1, 2, 3, 4, 5]);
});

test('coarse scan stays under 10 ms of CPU per frame at 540×960 (a 1080×1920 clip, default params)', () => {
  const n = 70, G = shakePath(n, { seed: 2, amp: 2 }), sw = swing({ bx: 300, by: 760, r: 5, kTake: 10, kTop: 30, kDown: 36, kHit: 42 });
  const big = landscape({ seed: 8, horizonY: 300, texture: 60 });
  const clip = makeClip({ w: 540, h: 960, n, pool: 2, bg: big, objects: sw.objects, G, noise: 1.5, seed: 9 });
  const imgs = Array.from({ length: n }, (_, k) => clip.image(k));
  const sc = new CoarseScanner(clip.meta);
  assert.equal(sc.pool, 2); assert.equal(sc.w, 540); assert.equal(sc.h, 960);
  const per = [];
  for (let k = 0; k < n; k++) { const c0 = process.cpuUsage(); sc.push(k, k / 30, imgs[k]); const c = process.cpuUsage(c0); per.push((c.user + c.system) / 1000); }
  const steady = per.slice(5).sort((a, b) => a - b), med = steady[steady.length >> 1], p90 = steady[Math.floor(0.9 * steady.length)];
  const c0 = process.cpuUsage(), log = sc.finish(), fin = process.cpuUsage(c0);
  console.log(`# coarse scan 540x960: median ${med.toFixed(2)} ms/frame CPU, p90 ${p90.toFixed(2)}, finish ${((fin.user + fin.system) / 1000).toFixed(1)} ms; stages ${JSON.stringify(Object.fromEntries(Object.entries(log.diagnostics.msPerFrame).map(([k, v]) => [k, +v.toFixed(2)])))}`);
  assert.ok(med <= 10, `median ${med.toFixed(2)} ms/frame`);
  assert.equal(findImpacts(log, clip.meta).length, 1);
});
