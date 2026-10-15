// U4 ROI detection (dist/hf/roi-detect.js): RoiTube, nullThreshold, tbdSearch, tubeGeometry.
// Synthetic pixel-level scenes (tests/hf/helpers/sky-roi.mjs) for each rule, plus the D3 E3 faint-ball harness
// through real x264 at 6 and 2 Mbps (ffmpeg; cached in os.tmpdir(), the first run renders and encodes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoiTube, nullThreshold, tbdSearch, tubeGeometry, normalUpper } from '../dist/hf/roi-detect.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { check, identityTrack, cropLuma, HFError } from '../dist/hf/types.js';
import {
  E3, e3Balls, e3Clips, e3Offsets, e3BaselineScores, ffmpeg, renderScene, makeSky, stampBall, runTube, pred, metaFor,
  translationTrack, rng, gauss, e3Sigma, wilson
} from './hf/helpers/sky-roi.mjs';

const W = 320, H = 240, R = PARAMS.roi;

/** Run a tube over a rendered scene along a straight predicted track; returns detections by frame. */
function track({ frames, N = frames.length, path, vx, vy, d = 2, sigma = 1, polarity = 1, tubePolarity = polarity, camera, offset, specks = [], params = PARAMS, extra = {} }) {
  const meta = metaFor(W, H, N);
  camera ??= offset ? translationTrack(meta, offset) : identityTrack(meta);
  const tube = new RoiTube({ meta, camera, params, polarity: tubePolarity, specks });
  const sim = k => ({ a: 1, b: 0, tx: camera.sim[4 * k + 2], ty: camera.sim[4 * k + 3] });
  const dets = runTube(tube, { W, H, frames: k => frames[k], from: 0, to: N, sim, predict: k => pred(k, path(k).x, path(k).y, vx, vy, d, { sigma, polarity, ...extra }) });
  return { dets, tube, meta };
}
/** Hits within 1.5 px of the path, other observations, and rejection reasons over [k0, k1). */
function tally(dets, path, k0, k1) {
  const out = { hit: 0, other: 0, n: 0, reasons: {}, err: 0 };
  for (let k = k0; k < k1; k++) {
    const d = dets.get(k), o = d?.observation;
    out.n++;
    if (o) { const e = Math.hypot(o.x - path(k).x, o.y - path(k).y); if (e <= 1.5) { out.hit++; out.err += e; } else out.other++; }
    else out.reasons[d?.reason] = (out.reasons[d?.reason] || 0) + 1;
  }
  out.err /= Math.max(1, out.hit);
  return out;
}
const line = (x0, y0, vx, vy, k0 = 0) => k => ({ x: x0 + vx * (k - k0), y: y0 + vy * (k - k0) });

/* ------------------------------------------------------------------ contract */

test('plan: [main, decoy, decoy] crops around the prediction, decoys ⟂ to the path at ≥ decoyOffsetH·h', () => {
  const meta = metaFor(W, H, 10), tube = new RoiTube({ meta, camera: identityTrack(meta) });
  const p = pred(0, 160, 120, 2, 1, 4, { sigma: 1.5 }), reqs = tube.plan(0, p), g = tubeGeometry(p);
  assert.equal(reqs.length, 3);
  assert.deepEqual(reqs.map(q => q.purpose), ['main', 'decoy', 'decoy']);
  for (const q of reqs) { assert.deepEqual(check('RoiRequest', q), []); assert.equal(q.pool, g.pool); assert.equal(q.rect.x % q.pool, 0); }
  const c = q => ({ x: q.rect.x + q.rect.w / 2, y: q.rect.y + q.rect.h / 2 }), m = c(reqs[0]);
  assert.ok(Math.hypot(m.x - 160, m.y - 120) <= g.pool, 'main crop centred on the prediction');
  assert.ok(reqs[0].rect.w >= 2 * g.h && reqs[0].rect.w < 2 * g.h + 2 * g.pool);
  for (const q of reqs.slice(1)) {
    const dc = c(q), dx = dc.x - m.x, dy = dc.y - m.y;
    assert.ok(Math.hypot(dx, dy) >= R.decoyOffsetH * g.h - 1, 'decoy far enough');
    assert.ok(Math.abs(dx * 2 + dy * 1) / Math.hypot(2, 1) < 1.5, 'decoy perpendicular to the velocity');
  }
});

test('push validates plan, order and crop count; detect on an unknown frame is null', () => {
  const meta = metaFor(W, H, 10), tube = new RoiTube({ meta, camera: identityTrack(meta) }), img = new Uint8Array(W * H).fill(100);
  const crops = reqs => reqs.map(q => cropLuma(img, W, H, q.rect, q.pool));
  assert.throws(() => tube.push(0, 0, [], null), e => e instanceof HFError && e.code === 'bad-arg');
  const r1 = tube.plan(1, pred(1, 100, 100, 1, 0, 2));
  assert.throws(() => tube.push(1, 1 / 30, crops(r1).slice(0, 2)), e => e.code === 'bad-arg');
  tube.push(1, 1 / 30, crops(r1));
  assert.throws(() => tube.plan(1, pred(1, 100, 100, 1, 0, 2)), e => e.code === 'bad-arg');
  assert.equal(tube.detect(5, pred(5, 100, 100, 1, 0, 2)), null);
  assert.throws(() => new RoiTube({ meta }), e => e.code === 'bad-arg');
});

test('ready(index) waits for the crops up to index + J + 2L (centred window, two-sided background)', () => {
  const N = 40, meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta) }), img = new Uint8Array(W * H).fill(120);
  const p = k => pred(k, 100 + 1.5 * k, 100, 1.5, 0, 2), g = tubeGeometry(p(0)), k0 = 20, need = k0 + g.J + 2 * g.L;
  assert.ok(g.L >= 1 && !g.spatial);
  for (let k = 0; k <= need; k++) {
    tube.push(k, k / 30, tube.plan(k, p(k)).map(q => cropLuma(img, W, H, q.rect, q.pool)));
    assert.equal(tube.ready(k0), k >= need, `frame ${k}`);
  }
});

test('detect returns a valid RoiDetection: observation in stabilized px, stabilized cached ZMap, decoy nulls', () => {
  const N = 50, path = line(80, 70, 1.3, 0.9), off = k => ({ x: 0.7 * k, y: -0.4 * k });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 11 }, offset: off, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 12 }] });
  const { dets } = track({ frames, path, vx: 1.3, vy: 0.9, offset: off });
  const d = dets.get(25);
  assert.deepEqual(check('RoiDetection', d), []);
  assert.deepEqual(check('Observation', d.observation), []);
  assert.ok(Math.hypot(d.observation.x - path(25).x, d.observation.y - path(25).y) < 0.5);
  assert.equal(d.observation.src, 'tbd');
  assert.ok(d.observation.z >= d.threshold && d.nullScores.length > 0);
  assert.ok(d.observation.sigma > 0 && d.observation.sigma < 1);
  // the cached z map peaks at the ball in stabilized px
  const z = d.zmap;
  let best = -Infinity, bx = 0, by = 0;
  for (let j = 0; j < z.h; j++) for (let i = 0; i < z.w; i++) if (z.data[j * z.w + i] > best) { best = z.data[j * z.w + i]; bx = z.x0 + z.pool * (i + 0.5); by = z.y0 + z.pool * (j + 0.5); }
  assert.ok(Math.hypot(bx - path(25).x, by - path(25).y) <= 1, `zmap peak (${bx}, ${by})`);
  assert.equal(z.zScale, R.zmapScale);
});

test('a frame probed again (MHT) adds its decoy nulls once and is searched with the new prediction', () => {
  const N = 40, path = line(100, 80, 1.2, 0.8), meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 3 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 9 }] });
  const P = k => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2);
  for (let k = 0; k < 30; k++) tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
  assert.ok(tube.ready(20));
  const a = tube.detect(20, P(20)), n1 = tube.history.length;
  const b = tube.detect(20, { ...P(20), x: path(20).x + 1.5, y: path(20).y - 1 });   // same geometry, moved
  assert.ok(n1 > 0 && n1 === a.nullScores.length && b.nullScores.length === a.nullScores.length);
  assert.equal(tube.history.length, n1, 'no duplicate null samples');
  const c = tube.detect(20, { ...P(20), x: path(20).x + 3, cov: [9, 0, 9], sv: 0.3 });   // a wider probe
  assert.equal(tube.history.length, n1);
  for (const o of [a, b, c].map(x => x.observation)) assert.ok(o && Math.hypot(o.x - path(20).x, o.y - path(20).y) < 0.5);
  assert.ok(c.threshold > a.threshold, 'a wider search is a larger family of tests');
});

test('tubeGeometry: L = ceil(2.5·r/|v|) with r = max(d/2, √2·σ_mf), spatial past bgLagMax, J = 2 above fastPx', () => {
  const g = (vx, d, sigma = 1, m = 1) => tubeGeometry({ vx, vy: 0, d, cov: [sigma * sigma, 0, sigma * sigma] }, m);
  assert.equal(g(1.5, 2).L, Math.ceil(2.5 * Math.SQRT2 * 0.7 / 1.5 - 1e-9));   // r = √2·0.7 for a 2 px ball
  assert.equal(g(2, 8).L, Math.ceil(2.5 * 4 / 2));                              // r = d/2
  assert.equal(g(0.5, 2).L, 5);
  assert.equal(g(0.25, 2).spatial, true);   // L = 10 > bgLagMax
  assert.equal(g(0.25, 2, 1, 4).spatial, false);   // stride 4: 1 px per step
  assert.equal(g(7, 2).J, R.tbd.fastJ);
  assert.equal(g(5, 2).J, R.tbd.J);
  assert.equal(g(1, 13).pool, 2);
  assert.equal(g(1, 13).gate, R.maxSizeD * 13);
  const h = g(2, 4, 1.5);
  assert.ok(Math.abs(h.h - (3 * 1.5 + 1.5 * 4 + 3 * 2 + 4)) < 1e-9);
});

/* ------------------------------------------------------------------ empirical null */

test('nullThreshold: T_min without history; ≈ q-quantile of max-of-N nulls; a stray decoy object cannot blind it', () => {
  const N = 600, tMin = normalUpper(R.nullAlpha / N);
  assert.ok(Math.abs(nullThreshold([], N) - tMin) < 1e-12);
  assert.ok(Math.abs(normalUpper(0.025) - 1.959964) < 1e-5 && Math.abs(normalUpper(1e-6) - 4.753424) < 1e-5);
  // Decoy scores = max of N iid normals scaled ×1.3 (codec-like): the exceedance of T for a new score.
  const r = rng(21), draw = () => { let m = -Infinity; for (let i = 0; i < N; i++) m = Math.max(m, gauss(r)); return 1.3 * m; };
  const trueQ = p => 1.3 * normalUpper(-Math.expm1(Math.log(p) / N));
  let exceed = 0, trials = 0;
  for (let t = 0; t < 30; t++) {
    const hist = Array.from({ length: 120 }, draw), T = nullThreshold(hist, N);
    exceed += 1 - Math.exp(N * Math.log1p(-0.5 * erfcApprox(T / 1.3 / Math.SQRT2))); trials++;   // P(max > T)
    assert.ok(T > tMin, 'heavier than Gaussian nulls raise T above T_min');
  }
  const fa = exceed / trials;
  assert.ok(fa > 0.001 && fa < 0.0075, `mean false-alarm rate ${fa}`);
  // A bird in a decoy: one huge score must not blind the tube.
  const hist = Array.from({ length: 300 }, draw), T0 = nullThreshold(hist, N);
  hist[150] = 60;
  assert.ok(nullThreshold(hist, N) < T0 + 0.3);
  assert.ok(Math.abs(nullThreshold(hist, N) - trueQ(R.nullQuantile)) < 0.6);
});
function erfcApprox(x) { // Numerical Recipes erfc, |err| < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/* ------------------------------------------------------------------ detection rules */

test('a faint 2 px ball on noisy sky is found within 0.5 px; empty sky has ≤ 0.5% false alarms', () => {
  const N = 60, path = line(100, 80, 1.2, 0.8);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 3 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 7 }] });
  const t = tally(track({ frames, path, vx: 1.2, vy: 0.8 }).dets, path, 10, N - 10);
  assert.ok(t.hit >= 0.9 * t.n && t.other === 0, JSON.stringify(t));
  assert.ok(t.err < 0.5);
  let fa = 0, n = 0;
  for (let s = 0; s < 12; s++) {
    const ep = line(60 + 10 * s, 60, 1.2, 0.8), empty = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 100 + s } });
    for (const d of track({ frames: empty, path: ep, vx: 1.2, vy: 0.8 }).dets.values()) { n++; if (d?.observation) fa++; }
  }
  assert.ok(fa / n <= 0.005, `false alarms ${fa}/${n}`);
});

test('dark balls are found with polarity −1 or unknown, and never as a bright ball', () => {
  const N = 50, path = line(100, 80, 1.2, 0.8);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, base: 190, seed: 4 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: -10 }] });
  const dark = tally(track({ frames, path, vx: 1.2, vy: 0.8, polarity: -1 }).dets, path, 10, N - 10);
  assert.ok(dark.hit >= 0.95 * dark.n, JSON.stringify(dark));
  const unknown = track({ frames, path, vx: 1.2, vy: 0.8, polarity: 0 }).dets;
  const u = tally(unknown, path, 10, N - 10);
  assert.ok(u.hit >= 0.95 * u.n, JSON.stringify(u));
  assert.ok([...unknown.values()].every(d => !d?.observation || d.observation.polarity === -1));
  const bright = tally(track({ frames, path, vx: 1.2, vy: 0.8, polarity: 1 }).dets, path, 10, N - 10);
  assert.equal(bright.hit, 0);
});

test('slow balls at 0.15-0.5 px/frame keep ≥ 85% of their contrast (lag-scaled two-sided background, spatial fallback)', () => {
  for (const d of [2, 3]) for (const v of [0.15, 0.3, 0.4, 0.5]) {
    const N = 70, path = line(120, 100, v, 0.3 * v), meta = metaFor(W, H, N), A = 30;
    const frames = renderScene({ W, H, frames: N, sky: { noise: 0, gradient: 20, seed: 1 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d, c: A }] });
    const tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 }), P = k => pred(k, path(k).x, path(k).y, v, 0.3 * v, d, { sigma: 0.5 });
    const lag = Math.max(1, tubeGeometry(P(0)).L), s = e3Sigma(d), amp = A * d * d / 4 / (2 * s * s);
    let num = 0, den = 0, mode = null;
    for (let k = 0; k < N; k++) {
      tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
      const kk = k - 2 * lag - 1;
      if (kk < 30 || kk >= 50) continue;
      // matched amplitude of the true ball profile in the residual, relative to the profile itself
      const r = tube.residual(kk), p = path(kk);
      mode = r.mode;
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
        const gpx = amp * Math.exp(-((r.x0 + i + 0.5 - p.x) ** 2 + (r.y0 + j + 0.5 - p.y) ** 2) / (2 * s * s));
        num += r.data[j * r.w + i] * gpx; den += gpx * gpx;
      }
    }
    assert.ok(num / den >= 0.85, `d ${d} v ${v} (${mode}): kept ${(num / den).toFixed(3)}`);
    assert.equal(mode, tubeGeometry(P(0)).spatial ? 'spatial' : 'temporal');
  }
});

test('a static speck on the path cancels in the residual and is never reported', () => {
  const N = 60, K = 30, path = line(100, 120, 1.5, 0.5, K);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 5 }, objects: [{ x: () => 100, y: () => 120, d: 2, c: 40 }] });
  const { dets } = track({ frames, path, vx: 1.5, vy: 0.5 });
  const z = dets.get(K).zmap, i = Math.floor((100 - z.x0) / z.pool), j = Math.floor((120 - z.y0) / z.pool);
  assert.ok(Math.abs(z.data[j * z.w + i] / z.zScale) < 3, `z at the speck ${z.data[j * z.w + i] / z.zScale}`);
  assert.equal(tally(dets, path, 5, N - 5).hit + tally(dets, path, 5, N - 5).other, 0);
});

test('a lens-fixed speck riding the predicted track (camera pan) is masked', () => {
  const N = 60, off = k => ({ x: 1.2 * k - 30, y: 0.4 * k - 10 }), sx = 160, sy = 120, path = k => ({ x: sx - off(k).x, y: sy - off(k).y });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 6 }, offset: off, lensSpecks: [{ x: sx, y: sy, d: 2, c: 35 }] });
  const masked = tally(track({ frames, path, vx: -1.2, vy: -0.4, offset: off, specks: [{ x: sx, y: sy, r: 2 }] }).dets, path, 5, N - 5);
  assert.equal(masked.hit + masked.other, 0, JSON.stringify(masked));
  const unmasked = tally(track({ frames, path, vx: -1.2, vy: -0.4, offset: off }).dets, path, 5, N - 5);
  assert.ok(unmasked.hit > 0.8 * unmasked.n, 'without the mask the speck looks exactly like the ball');
});

test('an airplane crossing the path with another velocity is never accepted; a ball beside it still is', () => {
  const N = 60, K = 30, path = line(120, 100, 1, 1, K);
  for (const dv of [1.5, 2, 6]) {
    const pv = { x: 1 + dv * Math.SQRT1_2, y: 1 - dv * Math.SQRT1_2 };
    const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 7 }, objects: [{ x: k => 120 + pv.x * (k - K), y: k => 100 + pv.y * (k - K), d: 3, c: 40 }] });
    const t = tally(track({ frames, path, vx: 1, vy: 1 }).dets, path, 5, N - 5);
    assert.equal(t.hit + t.other, 0, `dv ${dv}: ${JSON.stringify(t)}`);
  }
  const pv = { x: 1 + 2 * Math.SQRT1_2, y: 1 - 2 * Math.SQRT1_2 }, plane = k => ({ x: 122 + pv.x * (k - K), y: 98 + pv.y * (k - K) });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 7 }, objects: [
    { x: k => plane(k).x, y: k => plane(k).y, d: 3, c: 40 }, { x: k => path(k).x, y: k => path(k).y, d: 2, c: 10 }] });
  const { dets } = track({ frames, path, vx: 1, vy: 1 }), t = tally(dets, path, 10, N - 10);
  for (const [k, d] of dets) {
    const o = d?.observation;
    if (o) assert.ok(Math.hypot(o.x - path(k).x, o.y - path(k).y) < 2.5 && Math.hypot(o.x - plane(k).x, o.y - plane(k).y) > 3, `frame ${k}: not the ball`);
  }
  assert.ok(t.hit >= 0.6 * t.n, JSON.stringify(t));
});

test('an object much wider than maxSizeD·max(d, minSizePx) is rejected', () => {
  const N = 60, path = line(100, 80, 1.2, 0.6);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 5 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 10, c: 6 }] });
  const t = tally(track({ frames, path, vx: 1.2, vy: 0.6, d: 2 }).dets, path, 8, N - 8);
  assert.ok(t.hit + t.other <= 0.1 * t.n, JSON.stringify(t));
  assert.ok(t.reasons.size >= 0.8 * t.n);
  // the same blob is a fine ball when its size is expected
  const ok = tally(track({ frames, path, vx: 1.2, vy: 0.6, d: 10 }).dets, path, 8, N - 8);
  assert.ok(ok.hit >= 0.75 * ok.n && ok.reasons.size === undefined, JSON.stringify(ok));
});

test('a bright track occluded at the centre frame is not reported there (single-frame evidence)', () => {
  const N = 60, K = 30, path = line(100, 80, 1.2, 0.6);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 5 }, objects: [{ x: k => (k === K ? null : path(k).x), y: k => path(k).y, d: 3, c: 30 }] });
  const { dets } = track({ frames, path, vx: 1.2, vy: 0.6, d: 3 });
  assert.equal(dets.get(K).observation, null);
  assert.equal(dets.get(K).reason, 'peak_z');
  assert.ok(dets.get(K - 1).observation && dets.get(K + 1).observation);
});

test('polarity flips only after the ROI background changes by more than polarityFlipLevels', () => {
  const N = 60, path = line(80, 200, 1.5, -1), sky = makeSky(W, H, { base: 100, gradient: 0, noise: 1.6, seed: 4 });
  const frames = Array.from({ length: N }, (_, k) => {
    const img = sky(k);
    for (let i = 0; i < 160 * W; i++) img[i] = Math.min(255, img[i] + 120);   // bright sky above y = 160
    const p = path(k);
    return stampBall(img, W, H, p.x, p.y, 3, p.y < 160 ? -25 : 25);           // a white ball turns dark there
  });
  const count = params => { const r = { bright: 0, dark: 0 }; for (const [k, d] of track({ frames, path, vx: 1.5, vy: -1, d: 3, params }).dets) { const o = d?.observation; if (o && Math.hypot(o.x - path(k).x, o.y - path(k).y) < 1.5) r[o.polarity > 0 ? 'bright' : 'dark']++; } return r; };
  const flip = count(PARAMS), none = count(mergeParams({ roi: { polarityFlipLevels: 1000 } }));
  assert.ok(flip.bright > 20 && flip.dark > 8, JSON.stringify(flip));
  assert.ok(none.bright > 20 && none.dark === 0, JSON.stringify(none));
});

test('camera pan over clouds: the ball is reported in stabilized px and cached z maps feed tbdSearch', () => {
  const N = 60, off = k => ({ x: 0.9 * k + 0.3 * Math.sin(k), y: -0.5 * k }), path = line(120, 140, 1.1, 0.7);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, clouds: 30, seed: 9 }, offset: off, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 9 }] });
  const { dets } = track({ frames, path, vx: 1.1, vy: 0.7, offset: off });
  const t = tally(dets, path, 8, N - 8);
  assert.ok(t.hit >= 0.95 * t.n && t.other === 0 && t.err < 0.4, JSON.stringify(t));
  const zmaps = [...dets.values()].filter(Boolean).map(d => d.zmap).sort((a, b) => a.index - b.index);
  const r = tbdSearch(zmaps, pred(30, path(30).x + 1, path(30).y - 1, 1.1, 0.7, 2, { sigma: 1.5 }));
  assert.ok(r && r.S > 6 && Math.hypot(r.x - path(30).x, r.y - path(30).y) < 0.5, JSON.stringify(r));
  assert.equal(r.polarity, 1);
  assert.equal(tbdSearch(zmaps, pred(999, 0, 0, 0, 0, 2)), null);
});

test('local registration absorbs a ±0.6 px camera error on fine texture (residual noise as with an exact camera)', () => {
  const N = 50, off = k => ({ x: 0.8 * k, y: 0.3 * k }), jit = k => ({ x: k % 2 ? 0.6 : -0.6, y: k % 3 === 0 ? 0.5 : -0.3 }), path = line(100, 80, 1.2, 0.8);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, clouds: 120, scale: 12, seed: 13 }, offset: off });
  const noise = cam => {
    const meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: translationTrack(meta, cam) }), P = k => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2), L = tubeGeometry(P(0)).L, sig = [];
    for (let k = 0; k < N; k++) {
      tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)), { a: 1, b: 0, tx: cam(k).x, ty: cam(k).y });
      const kk = k - 2 * L - 1;
      if (kk >= 10 && kk < 40) sig.push(tube.residual(kk).sigma);
    }
    return sig.reduce((a, b) => a + b) / sig.length;
  };
  const exact = noise(off), jittered = noise(k => ({ x: off(k).x + jit(k).x, y: off(k).y + jit(k).y }));
  assert.ok(jittered < 1.1 * exact, `residual σ ${jittered} vs ${exact} with an exact camera`);
});

test('a ball tracked with the wrong polarity: its background ghosts are recognised and rejected', () => {
  const N = 60, path = line(100, 80, 1.2, 0.8);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, base: 190, seed: 4 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 3, c: -30 }] });
  const { dets } = track({ frames, path, vx: 1.2, vy: 0.8, d: 3, sigma: 3, polarity: 1 });
  const t = tally(dets, path, 0, N);
  assert.equal(t.hit, 0);
  assert.ok((t.reasons.ghost ?? 0) >= 0.6 * N, JSON.stringify(t));
});

test('an exposure step on a textured sky: per-ROI gain match keeps the residual clean, no false alarm', () => {
  const N = 60, path = line(100, 80, 1.2, 0.8), sky = makeSky(W, H, { base: 120, clouds: 120, scale: 12, noise: 1.6, seed: 12 });
  const frames = Array.from({ length: N }, (_, k) => { const img = sky(k); if (k >= 30) for (let i = 0; i < img.length; i++) img[i] = Math.min(255, Math.round(img[i] * 1.1)); return img; });
  const meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta) }), P = k => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2), L = tubeGeometry(P(0)).L, sig = {};
  for (let k = 0; k < N; k++) {
    tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
    if (k - 2 * L - 1 >= 10) sig[k - 2 * L - 1] = tube.residual(k - 2 * L - 1).sigma;
  }
  const avg = ks => ks.reduce((a, k) => a + sig[k], 0) / ks.length, quiet = avg([10, 11, 12, 13, 14, 15]), step = avg([28, 29, 30, 31, 32, 33]);
  assert.ok(step < 1.2 * quiet, `residual σ across the step ${step} vs ${quiet}`);   // backgrounds straddle the step
  const t = tally(track({ frames, path, vx: 1.2, vy: 0.8 }).dets, path, 0, N);
  assert.equal(t.hit + t.other, 0, JSON.stringify(t));
});

test('early flight: a 14 px ball at 23 px/frame (pool 2, J = 2) is tracked and its diameter measured', () => {
  const N = 26, path = line(40, 200, 9, -6), d = 14;
  const discs = renderScene({ W, H, frames: N, sky: { noise: 2, seed: 2 } });
  for (let k = 0; k < N; k++) stampDisc(discs[k], path(k).x, path(k).y, d, 60);
  const { dets } = track({ frames: discs, path, vx: 9, vy: -6, d, sigma: 3 });
  const g = tubeGeometry(pred(0, 0, 0, 9, -6, d, { sigma: 3 }));
  assert.equal(g.pool, 2); assert.equal(g.J, R.tbd.fastJ);
  const t = tally(dets, path, 4, 22);
  assert.ok(t.hit >= 0.9 * t.n && t.err < 1, JSON.stringify(t));
  const ds = [...dets.values()].map(x => x?.observation?.d).filter(Boolean);
  assert.ok(ds.length >= 5);
  for (const m of ds) assert.ok(Math.abs(m / d - 1) < 0.2, `measured d ${m}`);
});
test('a floodlit ball whose glow fills the gate: tracked, and no size is reported that only measures the gate', () => {
  const N = 26, path = line(40, 200, 9, -6), d = 14;
  const g = tubeGeometry(pred(0, 0, 0, 9, -6, d, { sigma: 3 }));
  const frames = renderScene({ W, H, frames: N, sky: { noise: 2, seed: 2 } });
  for (let k = 0; k < N; k++) { stampDisc(frames[k], path(k).x, path(k).y, 1.1 * g.gate, 40); stampDisc(frames[k], path(k).x, path(k).y, d, 60); }
  const { dets } = track({ frames, path, vx: 9, vy: -6, d, sigma: 3 });
  const t = tally(dets, path, 4, 22);
  assert.ok(t.hit >= 0.9 * t.n && t.err < 1, JSON.stringify(t));
  for (const m of [...dets.values()].map(x => x?.observation?.d).filter(Boolean)) assert.ok(m <= 0.75 * g.gate, `measured d ${m.toFixed(1)}, gate ${g.gate.toFixed(1)}`);
});

test('a strongly decelerating ball (perspective, early flight) is followed when the prediction carries its acceleration', () => {
  const N = 30, a = { x: -2, y: 1.6 }, v0 = { x: 30, y: -25 }, K = 10;
  const path = k => ({ x: 30 + v0.x * k + 0.5 * a.x * k * k, y: 220 + v0.y * k + 0.5 * a.y * k * k });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 8 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 3, c: 12 }] });
  const run = acc => {
    const meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 });
    const P = k => pred(k, path(k).x, path(k).y, v0.x + a.x * k, v0.y + a.y * k, 3, acc ? { ax: a.x, ay: a.y } : {});
    return runTube(tube, { W, H, frames: k => frames[k], from: 0, to: 22, predict: P });
  };
  const withA = run(true), without = run(false), t = tally(withA, path, 3, 18);
  assert.ok(t.hit >= 0.9 * t.n, JSON.stringify(t));
  assert.ok(withA.get(K).score > 1.3 * without.get(K).score, `S ${withA.get(K).score} vs ${without.get(K).score} with a straight path`);
});

/** Anti-aliased disc (4×4 supersampled), contrast c. */
function stampDisc(img, x, y, d, c) {
  const r = d / 2;
  for (let j = Math.floor(y - r - 1); j <= Math.ceil(y + r + 1); j++) for (let i = Math.floor(x - r - 1); i <= Math.ceil(x + r + 1); i++) {
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    let cover = 0;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (Math.hypot(i + (a + 0.5) / 4 - x, j + (b + 0.5) / 4 - y) <= r) cover++;
    if (cover) img[j * W + i] = Math.max(0, Math.min(255, Math.round(img[j * W + i] + c * cover / 16)));
  }
}

/* ------------------------------------------------------------------ the E3 harness (x264 at 6 and 2 Mbps) */

const FF = ffmpeg() ? false : 'ffmpeg with libx264 not found';
const SCHED = Array.from({ length: 70 }, (_, i) => 10 + i);   // E3's frame range (E3 used every other frame)
const e3Cache = new Map();
/** hf on the E3 clips: per-ball hit rates over E3's frame range (decoys on the empty clip), empty-clip false alarms. */
function e3Run(bitrate) {
  if (e3Cache.has(bitrate)) return e3Cache.get(bitrate);
  const { W: EW, H: EH, FRAMES, FPS } = E3, clips = e3Clips(bitrate), B = e3Balls(), OFF = e3Offsets(B.length, FRAMES);
  const meta = metaFor(EW, EH, FRAMES, FPS), camera = identityTrack(meta), rates = [];
  let fa = 0, nfa = 0;
  B.forEach((b, bi) => {
    const pol = Math.sign(b.c), truth = k => { const p = b.at(k); return { x: p.x + 0.5, y: p.y + 0.5 }; };   // E3 centres at integers
    const predict = k => { const p = truth(k), o = OFF[bi][k]; return { index: k, t: k / FPS, x: p.x + o.x, y: p.y + o.y, vx: b.vx + o.vx, vy: b.vy + o.vy, cov: [2.25, 0, 2.25], covV: [0.0225, 0, 0.0225], d: b.d, polarity: pol }; };
    const hits = runTube(new RoiTube({ meta, camera, polarity: pol }), { W: EW, H: EH, frames: k => clips.balls[k], decoyFrames: k => clips.empty[k], from: 0, to: FRAMES, predict });
    rates.push(SCHED.filter(k => { const o = hits.get(k)?.observation; return o && Math.hypot(o.x - truth(k).x, o.y - truth(k).y) <= 1.5; }).length / SCHED.length);
    for (const d of runTube(new RoiTube({ meta, camera, polarity: pol }), { W: EW, H: EH, frames: k => clips.empty[k], from: 0, to: FRAMES, predict }).values()) { nfa++; if (d?.observation) fa++; }
  });
  // E3's own TBD detector on the same frames and predictions; threshold at 1% false alarms pooled over cells.
  const base = e3BaselineScores(bitrate, OFF, { k0: 10, k1: 80, step: 1 }), nulls = base.empty.flat().sort((a, b) => a - b), th = nulls[Math.floor(0.99 * nulls.length)];
  const baseRates = base.ball.map(h => h.filter(s => s !== null && s >= th).length / h.length);
  const out = { rates, baseRates, fa, nfa, B };
  e3Cache.set(bitrate, out);
  return out;
}
const cellTable = (B, a, b) => E3.SIZES.map(d => `${d}: ` + E3.CONTRASTS.map(c => { const i = B.findIndex(x => x.d === d && x.c === c); return `${Math.round(100 * a[i])}/${Math.round(100 * b[i])}`; }).join(' ')).join('\n');

test('E3 harness: false alarms ≤ 0.5% per frame on the empty clip at 6 and 2 Mbps', { skip: FF, timeout: 120000 }, () => {
  for (const br of ['6M', '2M']) {
    const { fa, nfa } = e3Run(br), [lo, hi] = wilson(fa, nfa);
    assert.ok(fa / nfa <= 0.005, `${br}: ${fa}/${nfa} = ${(100 * fa / nfa).toFixed(2)}% [${(100 * lo).toFixed(2)}, ${(100 * hi).toFixed(2)}]`);
  }
});

test('E3 harness at 6 Mbps: every cell ≥ the E3 TBD table − 5 points (same clips and predictions); D3 headline cells', { skip: FF, timeout: 120000 }, () => {
  const { rates, baseRates, B } = e3Run('6M'), msg = cellTable(B, rates, baseRates);
  rates.forEach((r, i) => assert.ok(r >= baseRates[i] - 0.05 - 1e-9, `d ${B[i].d} c ${B[i].c}: hf ${r} < E3 ${baseRates[i]} − 5\n${msg}`));
  for (const [d, c, pub] of E3.HEADLINE_6M) {   // D3 §4.2 table (published E3 run), minus 5 points
    const i = B.findIndex(x => x.d === d && x.c === c);
    assert.ok(rates[i] >= pub / 100 - 0.05, `headline d ${d} c ${c}: ${rates[i]} < ${pub}% − 5`);
  }
  // dark balls (D3 F5): 2 px at −16 and 3 px at −8 levels
  for (const [d, c] of [[2, -16], [3, -8]]) assert.ok(rates[B.findIndex(x => x.d === d && x.c === c)] >= 0.95);
});

test('E3 harness at 2 Mbps: overall ≥ the E3 TBD table, and no cell more than 25 points below it (known gap: faint cells)', { skip: FF, timeout: 120000 }, () => {
  const { rates, baseRates, B } = e3Run('2M'), msg = cellTable(B, rates, baseRates);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(rates) >= mean(baseRates) - 0.01, `mean hf ${mean(rates)} vs E3 ${mean(baseRates)}\n${msg}`);
  rates.forEach((r, i) => assert.ok(r >= baseRates[i] - 0.25, `d ${B[i].d} c ${B[i].c}: hf ${r} vs E3 ${baseRates[i]}\n${msg}`));
  const strong = rates.filter((r, i) => baseRates[i] >= 0.9);   // where E3 detects reliably, so does hf
  assert.ok(strong.every(r => r >= 0.85), msg);
});

/* ------------------------------------------------------------------ composition fixes (check gaps 1, 3, 5; null history) */

test('gap 1: bounded work: rects clipped to the frame and to halfSize.maxPx (decoys + one search radius), an 8000 px σ detects fast', () => {
  // The tracker's coasting σ reached 877-8179 px: decoy rects of 2·(h + 3σ) and an unclipped 3σ search box made
  // 23-40 Mpx crops, 2.8 GB score arrays and 14 s detect calls. Every size is now bounded whatever the covariance.
  const N = 30, path = line(150, 110, 1.2, 0.8), hs = R.halfSize;
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 21 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 12 }] });
  const meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 });
  const P = (k, s) => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2, { sigma: s });
  for (const s of [1, 60, 8000]) {
    const reqs = new RoiTube({ meta, camera: identityTrack(meta) }).plan(0, P(0, s));
    for (const [i, q] of reqs.entries()) {
      assert.ok(q.rect.x >= 0 && q.rect.y >= 0 && q.rect.x + q.rect.w <= W && q.rect.y + q.rect.h <= H, `σ ${s} rect ${i} inside the frame: ${JSON.stringify(q.rect)}`);
      assert.ok(q.rect.w <= 2 * (i ? 2 : 1) * hs.maxPx + 2 * q.pool && q.rect.x % q.pool === 0, `σ ${s} rect ${i} size`);
    }
  }
  const t0 = performance.now(), dets = runTube(tube, { W, H, frames: k => frames[k], from: 0, to: N, predict: k => P(k, k < 10 ? 1 : 8000) }), ms = performance.now() - t0;
  const wide = [...dets.entries()].filter(([k, d]) => k >= 13 && d);
  assert.ok(wide.length > 5, 'the wide detects ran');
  for (const [, d] of wide) assert.ok(d.searchSigma <= tubeGeometry(P(0, 8000)).searchCap + 1e-9 && d.nTests < 2e6, JSON.stringify({ s: d.searchSigma, n: d.nTests }));
  assert.ok(ms < 3000, `${N} frames with an 8000 px σ took ${ms.toFixed(0)} ms`);
  // A frame predicted wholly off the frame plans a one-cell rect and detects nothing.
  const off = new RoiTube({ meta, camera: identityTrack(meta) }).plan(0, pred(0, -5000, -5000, 1, 1, 2));
  assert.ok(off.every(q => q.rect.w === q.pool && q.rect.h === q.pool));
  // In a big frame the size caps hold on their own (no frame clipping): main ≤ 2·maxPx, decoys ≤ 2·2·maxPx.
  const big = metaFor(4000, 3000, 2);
  for (const q of new RoiTube({ meta: big, camera: identityTrack(big) }).plan(0, pred(0, 2000, 1500, 1.2, 0.8, 2, { sigma: 8000 }))) {
    assert.ok(q.rect.w <= 2 * (q.purpose === 'main' ? 1 : 2) * hs.maxPx + 2 * q.pool && q.rect.h === q.rect.w, `${q.purpose} ${q.rect.w}`);
  }
  // Without the work cap the search σ is still capped to what the largest crop holds.
  const free = runTube(new RoiTube({ meta, camera: identityTrack(meta), params: mergeParams({ roi: { maxDetectWork: 1e15 } }), polarity: 1 }),
    { W, H, frames: k => frames[k], from: 0, to: 18, predict: k => P(k, k < 10 ? 1 : 8000) }).get(15);
  assert.ok(free && Math.abs(free.searchSigma - tubeGeometry(P(0, 8000)).searchCap) < 1e-9, `${free?.searchSigma}`);
});

test('gap 1: one detect call honours roi.maxDetectWork: the wide velocity grid goes first, then the search shrinks around the prediction', () => {
  const N = 30, path = line(150, 110, 1.2, 0.8), meta = metaFor(W, H, N);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 22 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 12 }] });
  const run = (params, sv) => {
    const tube = new RoiTube({ meta, camera: identityTrack(meta), params, polarity: 1 });
    return runTube(tube, { W, H, frames: k => frames[k], from: 0, to: N, predict: k => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2, { sigma: 10, sv }) }).get(15);
  };
  const free = run(PARAMS, 0.6), capped = run(mergeParams({ roi: { maxDetectWork: 2e5 } }), 0.6);
  assert.equal(free.grid, R.tbd.wideGrid);
  assert.ok(Math.abs(free.searchSigma - 10) < 1e-9, `uncapped search σ ${free.searchSigma}`);
  assert.equal(capped.grid, R.tbd.grid, 'the 5×5 grid is dropped first');
  assert.ok(capped.searchSigma < 10 && capped.nTests < free.nTests, `capped search σ ${capped.searchSigma}`);
  assert.ok(capped.observation && Math.hypot(capped.observation.x - path(15).x, capped.observation.y - path(15).y) < 0.5, 'the ball near the prediction is still found');
});

test('gap 3: a golfer-like clutter block in the crop does not deflate the ball\'s z (tiled outlier-robust noise)', () => {
  // Early flight: the crop takes in the golfer and club, whose residual raised a whole-crop RMS 14-28× and cut the
  // ball's z 15-25×. Here a 65×80 px block re-textured every frame (σ 40 levels) sits 10 px below a faint 2 px ball,
  // inside a main crop planned with σ 25 px; detection searches 1σ around the truth.
  const N = 40, path = line(150, 100, 1.2, 0.8);
  const block = (img, k) => { const r = rng(1000 + k); for (let y = 135; y < 215; y++) for (let x = 110; x < 175; x++) img[y * W + x] = Math.max(0, Math.min(255, Math.round(120 + 40 * gauss(r)))); return img; };
  const clean = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 31 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 7 }] });
  const golfer = clean.map((f, k) => block(f.slice(), k));
  const run = frames => {
    const meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 }), sig = [], pending = [], dets = new Map();
    let out = 0;
    const det = j => {
      dets.set(j, tube.detect(j, pred(j, path(j).x, path(j).y, 1.2, 0.8, 2, { sigma: 1, sv: 0.2 })));
      const r = tube.residual(j); if (r && j >= 10 && j < N - 10) { sig.push(r.sigma); out = Math.max(out, r.outlierTiles); }
    };
    for (let k = 0; k < N; k++) {
      tube.push(k, k / 30, tube.plan(k, pred(k, path(k).x, path(k).y, 1.2, 0.8, 2, { sigma: 25, sv: 0.2 })).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
      pending.push(k);
      while (pending.length && tube.ready(pending[0])) det(pending.shift());
    }
    while (pending.length) det(pending.shift());
    return { t: tally(dets, path, 10, N - 10), sigma: sig.reduce((a, b) => a + b, 0) / sig.length, out };
  };
  const a = run(clean), b = run(golfer);
  assert.ok(a.t.hit >= 0.9 * a.t.n && b.t.hit >= a.t.hit - 2 && b.t.other === 0, `clean ${JSON.stringify(a.t)} block ${JSON.stringify(b.t)}`);
  assert.ok(b.sigma < 1.3 * a.sigma, `shared noise σ ${b.sigma.toFixed(2)} with the block vs ${a.sigma.toFixed(2)} without`);
  assert.ok(b.out > 0 && a.out === 0, `outlier tiles: ${b.out} with the block, ${a.out} without`);
});

test('null history per nullKey (an MHT branch); a new key starts from nullFrom\'s; probes neither search decoys nor touch histories', () => {
  const N = 40, path = line(100, 80, 1.2, 0.8), meta = metaFor(W, H, N), tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 });
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 3 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 9 }] });
  const P = (k, o = {}) => ({ ...pred(k, path(k).x, path(k).y, 1.2, 0.8, 2), ...o });
  const len = key => tube._hist(key).h.length;
  let b = null, pr = null, nA = 0;
  for (let k = 0; k < N; k++) {
    tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
    const j = k - 10;   // detect well inside the retained window (crops up to j + J + 2L are in)
    if (j < 8 || !tube.ready(j)) continue;
    if (j < 20) { tube.detect(j, P(j, { nullKey: 'A' })); continue; }
    if (j === 20) {
      nA = len('A');
      assert.ok(nA > 30 && tube.history.length === 0, `branch A has its own history (${nA}); the default one is untouched`);
      b = tube.detect(20, P(20, { nullKey: 'B', nullFrom: 'A', cov: [9, 0, 9] }));
      assert.ok(len('B') === nA + b.nullScores.length && len('A') === nA, 'B starts from A\'s history and adds its own frame');
      pr = tube.detect(20, P(20, { nullKey: 'B', probe: true, cov: [0.5, 0, 0.5] }));
      assert.deepEqual(pr.nullScores, []);
      assert.equal(len('B'), nA + b.nullScores.length, 'a probe adds nothing');
      assert.ok(pr.threshold >= Math.max(...b.nullScores) - 1e-9, 'a probe still sees this frame\'s decoy burst for its key');
      assert.ok(pr.observation && Math.hypot(pr.observation.x - path(20).x, pr.observation.y - path(20).y) < 0.5);
    }
    if (j === 21) {
      tube.detect(21, P(21, { nullKey: 'A' }));
      assert.ok(len('A') > nA && len('B') === nA + b.nullScores.length, 'histories stay separate');
      // A probe that comes first on a frame does not use up that frame's decoy samples for its key.
      tube.detect(21, P(21, { nullKey: 'C', probe: true }));
      assert.equal(len('C'), 0);
      const c = tube.detect(21, P(21, { nullKey: 'C' }));
      assert.ok(c.nullScores.length > 0 && len('C') === c.nullScores.length, 'the branch\'s own detect adds them');
    }
  }
  assert.ok(b && pr);
});

test('gap 5: sv is the velocity σ: the 5×5 grid only above one grid spacing per step', () => {
  const N = 30, path = line(150, 110, 1.2, 0.8), meta = metaFor(W, H, N);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 23 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 2, c: 12 }] });
  const grid = extra => runTube(new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 }), { W, H, frames: k => frames[k], from: 0, to: N, predict: k => pred(k, path(k).x, path(k).y, 1.2, 0.8, 2, { sigma: 4, ...extra }) }).get(15).grid;
  assert.equal(grid({ sv: 0.3 }), R.tbd.grid);
  assert.equal(grid({ sv: 0.6 }), R.tbd.wideGrid);
  assert.equal(grid({}), R.tbd.wideGrid, 'without sv the position σ over J steps (4/3 px/frame) widens it');
});

test('fast early flight: a ball outrunning its background crops gets a spatial (outrun) residual instead of an empty one', () => {
  // A decelerating ball (30 -> 4 px/frame) with crops capped at 40 px: the frames 2L away do not hold the ball's
  // position, so a temporal residual needing them was empty there (detect null). Outrun frames now get a spatial
  // residual and TBD windows of their own; the temporal frames' windows are as before.
  const N = 14, params = mergeParams({ roi: { halfSize: { maxPx: 40 } } }), vs = Array.from({ length: N }, (_, k) => 30 * 0.85 ** k), xs = [20];
  for (let k = 1; k < N; k++) xs.push(xs[k - 1] + vs[k - 1]);
  const path = k => ({ x: xs[k], y: 120 + 0.2 * (xs[k] - 20) }), meta = metaFor(W, H, N);
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 41 }, objects: [{ x: k => path(k).x, y: k => path(k).y, d: 4, c: 25 }] });
  const dets = runTube(new RoiTube({ meta, camera: identityTrack(meta), params, polarity: 1 }), { W, H, frames: k => frames[k], from: 0, to: N,
    predict: k => pred(k, path(k).x, path(k).y, vs[k], 0.2 * vs[k], 4, { sigma: 1, sv: 0.2, ax: -0.15 * vs[k], ay: -0.03 * vs[k] }) });
  const hit = k => { const o = dets.get(k)?.observation; return !!o && Math.hypot(o.x - path(k).x, o.y - path(k).y) < 1.5; };
  for (const k of [3, 4]) assert.ok(hit(k) && dets.get(k).mode === 'spatial', `frame ${k} (v ${vs[k].toFixed(0)}): ${dets.get(k)?.reason ?? 'null'}`);
  assert.ok([...dets.keys()].filter(hit).length >= 12, `${[...dets.keys()].filter(hit).length}/${N}`);
  for (let k = 5; k < N; k++) assert.ok(hit(k) && dets.get(k).mode === 'temporal', `frame ${k}`);
});

test('frames planned as background only (before impact) lend their crops but never join a TBD window', () => {
  const N = 30, path = line(100, 80, 1.2, 0.8), meta = metaFor(W, H, N), K = 10;
  const frames = renderScene({ W, H, frames: N, sky: { noise: 1.6, seed: 3 }, objects: [{ x: k => (k < K ? 100 : path(k).x), y: k => (k < K ? 80 : path(k).y), d: 2, c: 9 }] });
  const tube = new RoiTube({ meta, camera: identityTrack(meta), polarity: 1 }), seen = new Set(), z = tube._z.bind(tube);
  tube._z = (rec, s, force) => { seen.add(rec.index); return z(rec, s, force); };
  const P = k => ({ ...pred(k, path(k).x, path(k).y, 1.2, 0.8, 2), ...(k < K ? { vx: 0, vy: 0, background: true } : {}) });
  const dets = new Map(), pending = [];
  for (let k = 0; k < N; k++) {   // like the tracker: every frame planned and pushed, only post-impact frames detected
    tube.push(k, k / 30, tube.plan(k, P(k)).map(q => cropLuma(frames[k], W, H, q.rect, q.pool)));
    if (k >= K) pending.push(k);
    while (pending.length && tube.ready(pending[0])) { const j = pending.shift(); dets.set(j, tube.detect(j, P(j))); }
  }
  for (let k = K; k < K + 3; k++) assert.ok(dets.get(k)?.zmap, `frame ${k} detects`);
  assert.equal([...seen].filter(k => k < K).length, 0, 'no z map of a background-only frame was computed');
});
