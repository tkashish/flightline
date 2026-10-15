import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END_HOLD_SEC, MIN_REVEAL_SEC, TRACE_WIDTH, TRAIL_SEC, cameraAt, drawKnots, drawTrace, revealClock, toRaw, toStab, traceCurve, traceKnots, visibleTrace
} from '../dist/render-trace.js';
import { smoothFlight } from '../dist/curve.js';
import { cameraToRaw, exampleResult } from '../dist/hf/types.js';

const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const W = 1080, H = 1920;
// A 2D context that records every stroke and fill with the state it was drawn in.
function recorder() {
  const ops = [];
  let path = [];
  const ctx = {
    globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', strokeStyle: '', fillStyle: '', shadowBlur: 0, shadowColor: '',
    save() {}, restore() {},
    beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); }, arc(x, y, r) { path.push([x, y, r]); },
    stroke() { ops.push({ op: 'stroke', path, alpha: this.globalAlpha, width: this.lineWidth, cap: this.lineCap, color: this.strokeStyle, blur: this.shadowBlur }); },
    fill() { ops.push({ op: 'fill', path, alpha: this.globalAlpha, color: this.fillStyle }); }
  };
  return { ctx, ops };
}
const px = (camera, t, p) => { const r = toRaw(cameraAt(camera, t), p.x, p.y, W, H); return [r.x * W, r.y * H]; };

test('hf points are drawn as they are: the curve is the result itself, never smoothFlight', () => {
  const r = exampleResult('tracked'), c = traceCurve(r.points, { dense: true, clipEnd: 100 });
  assert.equal(c.samples.length, r.points.length);
  c.samples.forEach((s, i) => {
    const p = r.points[i];
    assert.deepEqual([s.t, s.x, s.y, s.alpha, s.revealT], [p.t, p.x, p.y, p.alpha ?? 1, p.t], `point ${i}`);
  });
  // v2 and manual traces are curved by curve.js instead.
  const plain = r.points.map(({ t, x, y }) => ({ t, x, y })), v2 = traceCurve(plain, { clipEnd: 100 });
  assert.deepEqual(v2.samples.map(s => [s.t, s.x, s.y]), smoothFlight(plain).map(p => [p.t, p.x, p.y]));
  assert.equal(v2.compressed, null);
});

test('progressive reveal: nothing before the launch, then the arc up to the current time with an interpolated head', () => {
  const r = exampleResult('tracked'), c = traceCurve(r.points, { dense: true, clipEnd: 100 }), t0 = r.points[0].t;
  assert.deepEqual(visibleTrace(c, t0 - 1e-3), []);
  const mid = (r.observations[5].t + r.observations[6].t) / 2 + 1e-3, v = visibleTrace(c, mid), head = v.at(-1);
  assert.ok(v.slice(0, -1).every(p => p.revealT <= mid));
  near(head.t, mid, 1e-9, 'head time');
  const k = r.points.findIndex(p => p.t > mid), a = r.points[k - 1], b = r.points[k], u = (mid - a.t) / (b.t - a.t);
  near(head.x, a.x + (b.x - a.x) * u); near(head.y, a.y + (b.y - a.y) * u);
  assert.equal(v.length, k + 1);
  assert.equal(visibleTrace(c, r.points.at(-1).t).length, r.points.length);
  assert.equal(visibleTrace(c, 1e9).length, r.points.length);
  // Without hold only the last TRAIL_SEC of reveal time stays, head included.
  const trail = visibleTrace(c, r.points.at(-1).t, { hold: false });
  assert.ok(trail.length > 2 && trail.length < r.points.length);
  assert.ok(trail.every(p => p.revealT >= r.points.at(-1).t - TRAIL_SEC));
});

test('predicted points are drawn exactly like observed ones, in one opaque stroke; only the end fades, never brightening', () => {
  const r = exampleResult('tracked'), c = traceCurve(r.points, { dense: true, clipEnd: 100 }), t = r.points.at(-1).t;
  assert.ok(r.points.some(p => p.status === 'predicted' && p.alpha === undefined), 'fixture: an unfaded predicted stretch');
  for (const glow of [false, true]) {
    const { ctx, ops } = recorder(), line = TRACE_WIDTH * H / 1280;
    assert.equal(drawTrace(ctx, c, t, { width: W, height: H, camera: r.camera, glow, color: '#59ccff' }), r.points.length);
    const core = ops.filter(o => o.op === 'stroke' && o.width === line), body = core[0];
    if (glow) assert.ok(ops.filter(o => o.op === 'stroke' && o.width > line).every(o => o.blur > 0 && o.alpha <= 0.45 + 1e-9));
    // Every point up to the first faded one is in the opaque body, predicted or not, at its camera-mapped position.
    const firstFaded = r.points.findIndex(p => (p.alpha ?? 1) < 1);
    assert.deepEqual([body.alpha, body.cap, body.color], [1, 'round', '#59ccff']);
    assert.equal(body.path.length, firstFaded);
    body.path.forEach(([x, y], i) => { const [ex, ey] = px(r.camera, t, r.points[i]); near(x, ex, 1e-6); near(y, ey, 1e-6); });
    assert.ok(r.points.slice(0, firstFaded).some(p => p.status === 'predicted') && r.points.slice(0, firstFaded).some(p => p.status === 'observed'));
    // The fading end: butt-capped runs, alpha never increasing, each run following its points' alpha.
    const fade = core.slice(1);
    assert.ok(fade.length >= 3);
    for (let i = 0; i < fade.length; i++) {
      assert.equal(fade[i].cap, 'butt'); assert.equal(fade[i].color, '#59ccff');
      assert.ok(fade[i].alpha < 1 && fade[i].alpha > 0 && (!i || fade[i].alpha <= fade[i - 1].alpha), `run ${i} alpha ${fade[i].alpha}`);
    }
    // Faded runs meet edge to edge: each starts where the previous ended.
    for (let i = 1; i < core.length; i++) assert.deepEqual(core[i].path[0], core[i - 1].path.at(-1));
    // The arc fades out completely, and so does its head dot.
    const dot = ops.at(-1);
    assert.deepEqual([dot.op, dot.alpha, dot.color], ['fill', 0, '#ffffec']);
  }
});

test('a predicted tail past the clip end is revealed on a compressed clock that finishes END_HOLD_SEC before the end', () => {
  const r = exampleResult('tracked'), lastObs = r.observations.at(-1).t;
  for (const after of [0.1, 0.5, -0.05]) {
    // The clip ends `after` s after the last observation: the 0.8 s tail could never show in real time.
    const clipEnd = lastObs + after, c = traceCurve(r.points, { dense: true, clipEnd }), { from, to } = c.compressed;
    near(to, clipEnd - END_HOLD_SEC, 1e-12, 'to');
    near(from, Math.min(lastObs, to - MIN_REVEAL_SEC), 1e-12, 'from');
    for (let i = 1; i < c.samples.length; i++) assert.ok(c.samples[i].revealT >= c.samples[i - 1].revealT);
    for (const s of c.samples) {
      if (s.t <= from) assert.equal(s.revealT, s.t, 'real time before the compressed stretch');
      assert.ok(s.revealT <= to + 1e-9);
    }
    assert.ok(visibleTrace(c, from - 1e-3).length < r.points.length);
    assert.equal(visibleTrace(c, to + 1e-9).length, r.points.length, 'complete before the end');
    assert.equal(visibleTrace(c, clipEnd).length, r.points.length);
  }
  // A launch in the clip's last moments: the arc after it shows at once.
  const late = revealClock(4.95, 4.97, 7, 5);
  assert.deepEqual([late(4.9), late(4.95), late(6), late(7)], [4.9, 4.95, 4.95, 4.95]);
});

test('no compressed reveal when the arc ends in time, without a predicted tail, or with an unknown clip length', () => {
  const r = exampleResult('tracked'), end = r.points.at(-1).t;
  for (const clipEnd of [end + END_HOLD_SEC + 1e-3, Infinity, NaN]) {
    const c = traceCurve(r.points, { dense: true, clipEnd });
    assert.equal(c.compressed, null, String(clipEnd));
    assert.ok(c.samples.every(s => s.revealT === s.t));
  }
  // Observed to the very last frame (v2, or an hf trace without completion): real time, the head stays on the ball.
  const plain = r.points.map(({ t, x, y }) => ({ t, x, y }));
  assert.equal(traceCurve(plain, { clipEnd: end + 0.01 }).compressed, null);
  const observedOnly = exampleResult('partial-b');
  assert.equal(traceCurve(observedOnly.points, { dense: true, clipEnd: observedOnly.points.at(-1).t + 0.01 }).compressed, null);
});

test('camera: toRaw is cameraToRaw (scale and roll about the frame centre), toStab inverts it, v2 samples only translate', () => {
  for (const cam of [{ t: 0, x: 0.01, y: -0.02, s: 1.03, r: 0.05 }, { t: 0, x: -0.004, y: 0.003, s: 0.97, r: -0.02 }]) {
    for (const [x, y] of [[0.2, 0.3], [0.9, 0.7], [0.5, 0.5]]) {
      const a = toRaw(cam, x, y, W, H), b = cameraToRaw(cam, x, y, W, H), back = toStab(cam, a.x, a.y, W, H);
      near(a.x, b.x, 1e-12); near(a.y, b.y, 1e-12); near(back.x, x, 1e-12); near(back.y, y, 1e-12);
    }
  }
  const v2 = { t: 0, x: 0.01, y: -0.02 }, raw = toRaw(v2, 0.3, 0.4, 640, 360), stab = toStab(v2, 0.31, 0.38, 640, 360);
  near(raw.x, 0.31, 1e-12); near(raw.y, 0.38, 1e-12); near(stab.x, 0.3, 1e-12); near(stab.y, 0.4, 1e-12);
  const track = [{ t: 1, x: 0, y: 0, s: 1, r: 0 }, { t: 2, x: 0.02, y: -0.04, s: 1.1, r: 0.2 }];
  const mid = cameraAt(track, 1.25);
  near(mid.x, 0.005); near(mid.y, -0.01); near(mid.s, 1.025); near(mid.r, 0.05);
  assert.deepEqual([cameraAt(track, 0).x, cameraAt(track, 9).x, cameraAt([], 1).s], [0, 0.02, 1]);
  assert.deepEqual(cameraAt([{ t: 0, x: 0.1, y: 0.2 }], 5), { t: 5, x: 0.1, y: 0.2, s: 1, r: 0 });
});

test('the tracer follows the camera: every point is drawn on the frame on screen', () => {
  const r = exampleResult('tracked'), c = traceCurve(r.points, { dense: true, clipEnd: 100 }), t = r.observations[8].t;
  const { ctx, ops } = recorder(), moved = r.camera.map(s => ({ ...s, x: s.x + 0.05, s: 1.02, r: 0.03 }));
  drawTrace(ctx, c, t, { width: W, height: H, camera: moved, glow: false });
  const body = ops[0].path, visible = visibleTrace(c, t);
  body.forEach(([x, y], i) => { const [ex, ey] = px(moved, t, visible[i]); near(x, ex, 1e-6); near(y, ey, 1e-6); });
  const still = recorder();
  drawTrace(still.ctx, c, t, { width: W, height: H, camera: [], glow: false });
  assert.ok(Math.hypot(still.ops[0].path[3][0] - body[3][0], still.ops[0].path[3][1] - body[3][1]) > 30, 'the camera moves the drawn trace');
});

test('an adjusted hf trace goes through curve.js: placed points exactly on it, and it keeps its end fade', () => {
  const r = exampleResult('tracked'), pts = r.points.map(p => ({ ...p })), k = 30;
  pts[k] = { t: pts[k].t, x: pts[k].x + 0.002, y: pts[k].y - 0.001, status: 'manual' };
  const c = traceCurve(pts, { clipEnd: 100 }), at = c.samples.find(s => Math.abs(s.t - pts[k].t) < 1e-9);
  near(at.x, pts[k].x, 1e-9); near(at.y, pts[k].y, 1e-9);
  assert.equal(c.samples[0].alpha, 1);
  assert.ok(c.samples.at(-1).alpha < 1e-9 && c.samples.some(s => s.alpha > 0 && s.alpha < 1));
});

test('traceKnots: v2 points as they are; an hf curve thinned to 1/30 s, keeping its anchor, placed points and end', () => {
  const r = exampleResult('tracked'), k = traceKnots(r.points);
  assert.equal(k[0], r.points[0]); assert.equal(k.at(-1), r.points.at(-1));
  assert.ok(k.length > 20 && k.length < r.points.length / 3, `${k.length} of ${r.points.length}`);
  for (let i = 1; i < k.length - 1; i++) assert.ok(k[i].t - k[i - 1].t >= 1 / 30 - 1e-9);
  const v2 = [{ t: 0, x: 0.1, y: 0.2 }, { t: 0.01, x: 0.1, y: 0.2 }, { t: 0.02, x: 0.1, y: 0.2 }];
  assert.equal(traceKnots(v2), v2);
  const placed = { t: r.points[10].t + 1e-3, x: 0.5, y: 0.5, status: 'manual' }, edited = [...r.points.slice(0, 11), placed, ...r.points.slice(11)];
  assert.ok(traceKnots(edited).includes(placed));
  // Dots: one per knot, predicted ones smaller.
  const { ctx, ops } = recorder();
  drawKnots(ctx, r.points, 0, { width: W, height: H, camera: r.camera });
  assert.equal(ops.filter(o => o.op === 'fill').length, k.length);
  const radius = new Map(ops.filter(o => o.op === 'fill').map((o, i) => [k[i].status, o.path[0][2]]));
  assert.ok(radius.get('predicted') < radius.get('observed'));
});

test('nothing is drawn before the launch or for a curve of fewer than two points', () => {
  const r = exampleResult('tracked'), { ctx, ops } = recorder();
  assert.equal(drawTrace(ctx, traceCurve(r.points, { dense: true }), r.points[0].t - 0.01, { width: W, height: H }), 0);
  assert.equal(drawTrace(ctx, traceCurve([r.points[0]], { dense: true }), 99, { width: W, height: H }), 0);
  assert.equal(drawTrace(ctx, traceCurve([], {}), 99, { width: W, height: H }), 0);
  assert.equal(ops.length, 0);
});
