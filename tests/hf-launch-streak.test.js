// U3 streak-mode launch observations (E5 follow-up of the P2b composition check). A ray-transform sample sits on its
// ray at the midpoint of its bin run: smoke-17 (synth-1.1, oblique 30 fps, the ball 166-255 px/frame) was drawn as
// 'tracked' from three such samples 5-7 px off the ball (2 of 3 outside the 0.75·d match radius), and the law's t0
// fitted to them was 1.4 ms early. The samples are now observed at their segment centres and the law is refitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../dist/hf/params.js';
import { makeImpact, makeSourceMeta, identityTrack, IDENTITY_SIM } from '../dist/hf/types.js';
import { LaunchConfirmer } from '../dist/hf/launch-null.js';
import { boxMoments, fitProjectiveLine } from '../dist/hf/emergence.js';
import { makeImpactScene } from './hf/helpers/impact-scene.mjs';

const DEG = Math.PI / 180;

test('boxMoments reports the half-maximum centroid in native px (the streak centre)', () => {
  // a 2-px-pool grid with a 7 × 3 streak at grid columns 10-16, rows 20-22, plus a dim pedestal below half maximum
  const grid = { bx: 100, by: 200, p: 2, w: 40, h: 40 }, R = new Float32Array(grid.w * grid.h);
  for (let y = 18; y <= 24; y++) for (let x = 8; x <= 18; x++) R[y * grid.w + x] = 10;
  for (let y = 20; y <= 22; y++) for (let x = 10; x <= 16; x++) R[y * grid.w + x] = 60;
  const m = boxMoments(R, grid, 13, 21, 8, 8);
  assert.ok(Math.abs(m.cx - (100 + 2 * 13.5)) < 1e-9 && Math.abs(m.cy - (200 + 2 * 21.5)) < 1e-9, `${m.cx}, ${m.cy}`);
  assert.equal(m.n, 21);
  assert.ok(m.major > m.minor && Math.abs(m.angle) < 1e-9, 'elongated along x');
});

/** A LaunchConfirmer at a 30 fps, 1080×1920 address, used for its candidate() geometry only. */
function confirmer({ d0 = 13, address = { x: 500, y: 1500 }, kLast = 30 } = {}) {
  const fps = 30, n = 120, meta = makeSourceMeta({ width: 1080, height: 1920, fps, frameCount: n, times: Float64Array.from({ length: n }, (_, k) => k / fps), duration: n / fps });
  const hyp = makeImpact({
    id: 'h', spotId: 's', address, d0, polarity: 1, kLast, tLast: kLast / fps, kFirstAbsent: kLast + 1, tFirstAbsent: (kLast + 1) / fps,
    interval: { t0: (kLast - 2.25) / fps, t1: (kLast + 3.25) / fps }, t0Est: (kLast + 0.5) / fps
  });
  return new LaunchConfirmer(hyp, { meta, log: { camera: identityTrack(meta) }, params: PARAMS });
}

/**
 * A winning streak chain as evaluateStreak hands it to candidate(): three samples of a ball launched at t0 along
 * `deg` (y up) with the law s = vτ/(1 + cτ), seen on the nearest θ ray at the bin-run midpoints (radial error `bin`
 * px per sample), the segment shapes centred on the true positions, the ray law fitted to the ray positions.
 */
function streakWin(lc, { t0 = 30.5 / 30, deg = 37, v = 255, c = 0.27, bin = [3.1, -3.2, 2.9], ks = [31, 32, 33], centres } = {}) {
  const S = PARAMS.launch.streak, A = lc.A, fps = lc.fps, u = { x: Math.cos(deg * DEG), y: -Math.sin(deg * DEG) };
  const rayDeg = Math.round(deg / S.thetaStepDeg) * S.thetaStepDeg + 0.4 * S.thetaStepDeg, r = { x: Math.cos(rayDeg * DEG), y: -Math.sin(rayDeg * DEG) };
  const support = ks.map((k, i) => {
    const tau = (k / fps - t0) * fps, s = v * tau / (1 + c * tau), sr = s + bin[i], truth = { x: A.x + u.x * s, y: A.y + u.y * s };
    const q = { k, index: k, t: k / fps, x: A.x + r.x * sr, y: A.y + r.y * sr, s: sr, len: 20, z: 40, w: lc.d0 / (1 + c * tau), truth };
    const ctr = centres ? centres[i](truth, q) : truth;
    return { ...q, shape: ctr && { major: 20, minor: 8, angle: 0, n: 12, cx: ctr.x, cy: ctr.y } };
  });
  const lawCtx = { t0Range: [lc.interval.t0, lc.interval.t1], cRange: [PARAMS.launch.gates.minBetaPerFrame, 1] };
  const law = fitProjectiveLine(support.map(q => ({ t: q.t, x: q.x, y: q.y, w: q.w })), { address: A, d0: lc.d0 }, { fps, ...lawCtx, params: PARAMS, dir: r, quantum: S.sStepD0 * lc.d0 });
  return { S: 18, support, law, m: support.length, mode: 'streak', pass: true, single: false, chain: { dir: r }, lawCtx, t0 };
}

test('streak launch: samples observed at their segment centres and the law refitted, so t0 loses the bin bias (smoke-17)', () => {
  const lc = confirmer(), win = streakWin(lc);
  assert.ok(win.law?.ok, 'the ray law holds on the quantized samples');
  const cand = lc.candidate(win, 'streak', null, 17);
  for (const [i, o] of cand.samples.entries()) {
    const q = win.support[i];
    assert.ok(Math.hypot(o.x - q.truth.x, o.y - q.truth.y) < 1e-9, `k${o.index}: observed at the centre`);
    assert.ok(Math.hypot(q.x - q.truth.x, q.y - q.truth.y) > 3, `k${o.index}: the ray position is off (${Math.hypot(q.x - q.truth.x, q.y - q.truth.y).toFixed(1)} px)`);
    assert.equal(o.src, 'streak');
  }
  const dtRay = Math.abs(win.law.t0 - win.t0) * lc.fps, dt = Math.abs(cand.t0 - win.t0) * lc.fps;
  assert.ok(dtRay > 0.02, `the ray law's t0 is biased (${dtRay.toFixed(3)} frames)`);
  assert.ok(dt < Math.min(0.05, dtRay / 4), `refitted t0 within ${dt.toFixed(4)} frames (ray law ${dtRay.toFixed(3)})`);
  assert.ok(Math.abs(Math.atan2(-cand.dir.y, cand.dir.x) / DEG - 37) < 0.05, `direction ${Math.atan2(-cand.dir.y, cand.dir.x) / DEG}°`);
  assert.ok(cand.t0 < cand.samples[0].t && cand.t0 >= lc.interval.t0 && cand.t0 <= lc.interval.t1);
  // a blob chain is never moved
  const blob = lc.candidate({ ...win, mode: 'blob' }, 'blob', null, 17);
  for (const [i, o] of blob.samples.entries()) assert.deepEqual([o.x, o.y], [win.support[i].x, win.support[i].y]);
});

test('streak launch: a centre outside its sample\'s quantization cell is not used; without any, ray positions and law stand', () => {
  const lc = confirmer(), S = PARAMS.launch.streak, ds = S.sStepD0 * lc.d0, u = { x: Math.cos(37 * DEG), y: -Math.sin(37 * DEG) }, n = { x: -u.y, y: u.x };
  const shift = (a, b) => p => ({ x: p.x + u.x * a + n.x * b, y: p.y + u.y * a + n.y * b });
  const wide = q => 0.5 * S.stripD0 * lc.d0 + q.s * Math.tan(S.thetaStepDeg * DEG);
  // first centre (a brighter neighbour) 1.2 bins along its ray position, the last beyond half a strip plus a θ step across
  const win = streakWin(lc, { centres: [(p, q) => shift(1.2 * ds, 0)(q), p => p, (p, q) => shift(0, wide(q) + 1)(q)] }), cand = lc.candidate(win, 'streak', null, 17);
  assert.deepEqual([cand.samples[0].x, cand.samples[0].y], [win.support[0].x, win.support[0].y], 'beyond one bin along: ray position');
  assert.ok(Math.hypot(cand.samples[1].x - win.support[1].truth.x, cand.samples[1].y - win.support[1].truth.y) < 1e-9, 'inside the cell: centre');
  assert.deepEqual([cand.samples[2].x, cand.samples[2].y], [win.support[2].x, win.support[2].y], 'beyond the strip and a θ step across: ray position');
  // no usable centre at all (no shape): the chain is exactly the ray chain
  const none = streakWin(lc, { centres: [() => null, () => null, () => null] }), c0 = lc.candidate(none, 'streak', null, 17);
  for (const [i, o] of c0.samples.entries()) assert.deepEqual([o.x, o.y], [none.support[i].x, none.support[i].y]);
  assert.equal(c0.t0, Math.max(lc.interval.t0, Math.min(none.law.t0, lc.interval.t1, c0.samples[0].t - 1e-6)));
  assert.deepEqual([c0.v, c0.c], [none.law.v, none.law.c]);
  // centres inside their cells that break the projective-line law are not used, the ray chain stands: a slow streak
  // (20 px/frame) whose centres zig-zag along the ray accelerates beyond launch.law.maxSpeedRatio
  const zig = streakWin(lc, { v: 20, c: 0, centres: [shift(0, 0), shift(-6, 0), shift(6, 0)] });
  assert.ok(zig.law?.ok, 'the ray law (bin quantum) holds');
  const bent = fitProjectiveLine(zig.support.map(q => ({ t: q.t, x: q.shape.cx, y: q.shape.cy, w: q.w })), { address: lc.A, d0: lc.d0 }, { fps: lc.fps, ...zig.lawCtx, params: PARAMS });
  assert.equal(bent.ok, false, 'the zig-zag centres fail the law');
  const cz = lc.candidate(zig, 'streak', null, 17);
  for (const [i, o] of cz.samples.entries()) assert.deepEqual([o.x, o.y], [zig.support[i].x, zig.support[i].y]);
  // a refit whose t0 is pinned to an edge of the chain's t0 range (the centres want another impact time, timingOk's
  // rule) is not used either: here the range starts 0.1 frame after the true t0
  for (const edge of ['lower', 'upper']) {
    const pin = streakWin(lc), [lo, hi] = pin.lawCtx.t0Range;
    pin.lawCtx = { ...pin.lawCtx, t0Range: edge === 'lower' ? [pin.t0 + 0.1 / lc.fps, hi] : [lo, pin.t0 - 0.1 / lc.fps] };
    const cp = lc.candidate(pin, 'streak', null, 17);
    for (const [i, o] of cp.samples.entries()) assert.deepEqual([o.x, o.y], [pin.support[i].x, pin.support[i].y], `${edge} edge`);
    assert.deepEqual([cp.v, cp.c], [pin.law.v, pin.law.c], `${edge} edge`);
  }
});

test('streak-only scenes: the centred samples lie on the ball, nearer than their ray positions (U3 scenes 5288, 5588)', () => {
  const long = fps => Math.min(1 / fps, 1 / 120);
  for (const [club, seed] of [['iron', 5288], ['driver', 5588]]) {
    const sc = makeImpactScene({ view: 'fo', fps: 240, tau: 1, club, shutter: long(240), seed }), g = sc.gt;
    const lc = new LaunchConfirmer(makeImpact(sc.hypothesis({ params: PARAMS })), { meta: sc.meta, log: { camera: identityTrack(sc.meta) }, params: PARAMS });
    const { from, to } = lc.window();
    for (let k = from; k < to; k++) lc.consume(k, sc.meta.times[k], lc.roiRequests(k).map(q => sc.crop(k, q.rect, q.pool)), IDENTITY_SIM);
    const dec = lc.finish();
    assert.equal(dec.accepted, true, `${seed}: ${dec.reason}`);
    assert.equal(dec.features.mode, 'streak');
    const ray = new Map(dec.features.winner.samples.map(([k, x, y]) => [k, { x, y }])), moved = [];
    for (const o of dec.candidate.samples) {
      const r = ray.get(o.index), b = g.ballAt(o.index);
      if (Math.hypot(o.x - r.x, o.y - r.y) > 0.01) moved.push({ e: Math.hypot(o.x - b.x, o.y - b.y), eRay: Math.hypot(r.x - b.x, r.y - b.y), R: Math.max(2, 0.75 * b.d) });
    }
    const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
    assert.ok(moved.length >= 4, `${seed}: ${moved.length} samples at their centres`);
    assert.ok(moved.every(m => m.e <= m.R), `${seed}: every centred sample on the ball (${moved.map(m => m.e.toFixed(2))})`);
    assert.ok(med(moved.map(m => m.e)) <= 1.25 && med(moved.map(m => m.e)) < med(moved.map(m => m.eRay)), `${seed}: median ${med(moved.map(m => m.e)).toFixed(2)} px, ray ${med(moved.map(m => m.eRay)).toFixed(2)} px`);
  }
});
