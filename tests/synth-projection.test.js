import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from './synth/world.mjs';
import { Renderer } from './synth/render.mjs';
import { completeSpec, planSplit } from './synth/scenarios.mjs';
import { arcAndLanding } from './synth/gt-schema.mjs';

const spec = (o) => completeSpec({ id: 'p', split: 'test', seed: o.seed, view: o.view, viewClass: o.view.startsWith('dtl') ? 'dtl' : o.view === 'face-on' ? 'fo' : 'oblique', hand: o.hand ?? 1, club: o.club, kind: 'hit', capture: o.capture || { fps: 60 }, sky: o.sky || 'blue', ground: 'grass', tee: 'none', lens: o.lens || 'main', format: { W: 1080, H: 1920 }, durationOut: 3.2, impactOut: 1.2, confounders: { shake: o.shake ?? 1, rs: !!o.rs } });
const luma = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

/** Coverage centroid of the rendered ball (accumulated over the exposure) and of the clean (pre-quantization) image difference. */
function centroids(R, Rh, k) {
  const W = R.W, a = new Uint8ClampedArray(W * R.H * 3), b = new Uint8ClampedArray(W * R.H * 3);
  const gt = R.frame(k, a); Rh.frame(k, b);
  const P = R.lastBall?.patch; if (!P) return { gt };
  let sw = 0, sx = 0, sy = 0, dw = 0, dx = 0, dy = 0;
  for (let j = 0; j < P.w * P.h; j++) {
    const x = P.x0 + (j % P.w) + 0.5, y = P.y0 + Math.floor(j / P.w) + 0.5, w = P.alpha[j], i = (Math.floor(y) * W + Math.floor(x)) * 3, d = Math.abs(luma(R.F.rgb, i) - luma(Rh.F.rgb, i));
    sw += w; sx += w * x; sy += w * y; dw += d; dx += d * x; dy += d * y;
  }
  return { gt, cov: { x: sx / sw, y: sy / sw }, diff: dw > 0 ? { x: dx / dw, y: dy / dw, w: dw } : null };
}

test('on clean full-resolution frames the GT ball pixel equals the rendered ball centroid within 0.3 px', () => {
  const runs = [
    { seed: 11, view: 'dtl-hands', club: 'iron7' },
    { seed: 12, view: 'face-on', club: 'driver', hand: -1, capture: { fps: 240 } },
    { seed: 13, view: 'oblique', club: 'wedge', rs: true, shake: 2 },
    { seed: 14, view: 'dtl-ball', club: 'driver', lens: 'ultra' },
    { seed: 15, view: 'dtl-offset', club: 'iron7', capture: { fps: 240, slowmo: true } }
  ];
  let checked = 0, diffChecked = 0;
  for (const o of runs) {
    const s = spec(o), w = buildWorld(s);
    w.sensor.exposure = 1 / 4000; // short exposure: the streak centroid is the mid-exposure position
    const R = new Renderer(w, { noise: false }), Rh = new Renderer(w, { noise: false, hideBall: true }), k0 = w.timeline.frames.findIndex(f => f.tc >= 0);
    for (const k of [k0 - 5, k0 + 1, k0 + 3, k0 + 8, k0 + 20, k0 + 45]) {
      if (k < 0 || k >= w.timeline.N) continue;
      const { gt, cov, diff } = centroids(R, Rh, k), b = gt.ball;
      if (!cov || !b?.inFrame || b.visibleFrac < 0.999 || b.x < 8 || b.y < 8 || b.x > 1072 || b.y > 1912) continue;
      const e = Math.hypot(cov.x - b.x, cov.y - b.y);
      assert.ok(e < 0.3, `${s.view} frame ${k}: coverage centroid ${cov.x.toFixed(2)},${cov.y.toFixed(2)} vs GT ${b.x},${b.y} (diam ${b.diam}) err ${e.toFixed(3)} px`);
      checked++;
      // Sub-pixel balls are shaded with one mean colour, so the clean pixel difference has the same centroid.
      if (diff && b.diam < 3) {
        const ed = Math.hypot(diff.x - b.x, diff.y - b.y);
        assert.ok(ed < 0.3, `${s.view} frame ${k}: image-difference centroid off by ${ed.toFixed(3)} px (diam ${b.diam})`);
        diffChecked++;
      }
    }
  }
  assert.ok(checked >= 18 && diffChecked >= 3, `checked ${checked} frames, ${diffChecked} by image difference`);
});

test('arc2d starts at the impact address, is continuous, and ends at the landing', () => {
  const s = spec({ seed: 21, view: 'dtl-ball', club: 'driver' }), w = buildWorld(s), R = new Renderer(w, { noise: false });
  const frames = [], out = new Uint8ClampedArray(1080 * 1920 * 3);
  for (let k = 0; k < w.timeline.N; k += 1) frames.push(k % 6 === 0 || Math.abs(w.timeline.frames[k].tc) < 0.05 ? R.frame(k, out) : { ...w.timeline.frames[k], i: k });
  const { arc2d, landing } = arcAndLanding(w, frames.map((f, k) => ({ ...w.timeline.frames[k], ...f })));
  const k0 = w.timeline.frames.findIndex(f => f.tc >= 0), f0 = R.frame(k0 - 1, out);
  assert.ok(Math.hypot(arc2d[0].x - f0.ball.x, arc2d[0].y - f0.ball.y) < 1.5, 'arc starts at the address ball');
  for (let i = 1; i < arc2d.length; i++) assert.ok(arc2d[i].t > arc2d[i - 1].t, 'monotone time');
  assert.ok(Math.abs(arc2d.at(-1).tReal - landing.tReal) < 0.02 && landing.carryM > 150, 'arc reaches the landing');
  assert.ok(arc2d.some(p => !p.inFrame) || arc2d.every(p => p.inFrame), 'off-frame parts are kept, flagged inFrame=false');
});

test('chrome irons mirror their surroundings: from down the line at address the blade reads darker than the ball beside it', () => {
  let n = 0;
  for (const s of [...planSplit('smoke'), ...planSplit('tune').filter((x, i) => i % 7 === 0)].filter(x => x.viewClass === 'dtl' && x.kind === 'hit' && (x.club === 'iron7' || x.club === 'wedge') && !x.confounders.glint && !x.easy && !x.stress).slice(0, 8)) {
    const w = buildWorld(structuredClone(s)); if (w.plan.look.finish !== 'chrome') continue;
    const R = new Renderer(w, { noise: false, keepPatches: false }), F = w.timeline.frames, t = Math.max(w.tStart + 0.01, w.plan.times.tPress - 0.15), k = F.reduce((b, f, i) => (Math.abs(f.tc - t) < Math.abs(F[b].tc - t) ? i : b), 0);
    const out = new Uint8ClampedArray(w.intr.W * w.intr.H * 3), g = R.frame(k, out), W = w.intr.W, Y = (x, y) => luma(out, (y * W + x) * 3), rb = g.ball.diam / 2, rh = 0.3 * g.club.size;
    let ball = 0; const head = [];
    for (let y = Math.floor(Math.min(g.ball.y - rb, g.club.y - rh)); y <= Math.max(g.ball.y + rb, g.club.y + rh); y++) for (let x = Math.floor(Math.min(g.ball.x - rb, g.club.x - rh)); x <= Math.max(g.ball.x + rb, g.club.x + rh); x++) {
      const db = Math.hypot(x + 0.5 - g.ball.x, y + 0.5 - g.ball.y), dh = Math.hypot(x + 0.5 - g.club.x, y + 0.5 - g.club.y);
      if (db < rb) ball = Math.max(ball, Y(x, y)); else if (dh < rh && db > 1.3 * rb) head.push(Y(x, y));
    }
    if (head.length < 6) continue;
    const med = head.sort((a, b) => a - b)[head.length >> 1];
    assert.ok(med < 0.75 * ball, `${s.id}: blade median luma ${med.toFixed(0)} vs ball ${ball.toFixed(0)} at address`);
    n++;
  }
  assert.ok(n >= 4, `${n} down-the-line chrome irons checked`);
});
