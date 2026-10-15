import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateClip } from './synth/clip.mjs';
import { planSplit, addressVisibility } from './synth/scenarios.mjs';
import { buildWorld } from './synth/world.mjs';
import { Renderer } from './synth/render.mjs';
import { harnessAnnotation } from './synth/gt-schema.mjs';

const dir = mkdtempSync(join(tmpdir(), 'synth-gt-'));
/** Ground truth only (no encode) at a reduced size, ending `after` s (real) past impact. */
async function gtOf(s0, after = 0.2, W = 216) {
  const tau = s0.capture.slowmo ? s0.capture.fps / 30 : 1;
  const s = { ...structuredClone(s0), format: { ...s0.format, W, H: Math.round(W * s0.format.H / s0.format.W / 2) * 2 }, durationOut: Math.min(s0.durationOut, s0.impactOut + after * tau) };
  const r = await generateClip(s, { outDir: dir, encode: false });
  return JSON.parse(readFileSync(join(dir, r.gtFile), 'utf8'));
}
const every = (a, k) => a.filter((_, i) => i % k === 0);

test('every glint clip shows a ball-sized glint within 0.15 s of impact (smoke and a sample of tune and holdout)', async () => {
  const specs = [...planSplit('smoke'), ...every(planSplit('tune').filter(s => s.confounders.glint), 4), ...every(planSplit('holdout').filter(s => s.confounders.glint), 4)].filter(s => s.confounders.glint);
  assert.ok(specs.length >= 20, `${specs.length} glint clips`);
  for (const s of specs) {
    const g = await gtOf(s), d0 = g.impact.ballDiameterPx;
    const hit = g.frames.filter(f => Math.abs(f.tc) <= 0.15).flatMap(f => f.distractors.filter(d => d.type === 'glint' && d.size >= 0.5 * d0 && d.size <= 2 * d0));
    assert.ok(hit.length > 0, `${s.id}: no ball-sized glint near impact`);
    assert.ok(g.failureModes.includes('F2') && g.failureModes.includes('F20'), `${s.id}: F2/F20 come from the realized glint (${g.failureModes})`);
  }
});

test('the address ball shows in >= 80% of pre-impact frames unless the clip starts at impact; hidden-address clips realize F32 and expect either', async () => {
  const risky = s => s.kind === 'hit' && (s.confounders.neighbor || s.confounders.bay || s.confounders.occludePole || s.confounders.netFront || s.confounders.hiddenAddress || s.view === 'face-on');
  const specs = [...planSplit('smoke').filter(s => s.kind === 'hit'), ...every(planSplit('tune').filter(risky), 5), ...every(planSplit('holdout').filter(risky), 5)];
  let hidden = 0;
  for (const s of specs) {
    const g = await gtOf(s, 0.1), av = addressVisibility(g.frames, { snr: false });
    if (s.confounders.hiddenAddress) {
      hidden++;
      assert.ok(av.n <= 1 && g.expected === 'either' && g.failureModes.includes('F32'), `${s.id}: hidden address ${av.visible}/${av.n}, expected ${g.expected}, ${g.failureModes}`);
    } else assert.ok(av.visible >= 0.8 * av.n, `${s.id}: address visible in ${av.visible}/${av.n} pre-impact frames`);
  }
  assert.ok(hidden >= 4 && specs.length >= 50, `${specs.length} clips, ${hidden} hidden-address`);
});

test('motion-blur occlusion is time-resolved: the club hides the ball only where it is in front at the same instant', () => {
  // smoke-21: oblique, 1/126 s exposure straddling impact. The club sweeps the address after the ball left it.
  const s = planSplit('smoke').find(x => x.id.startsWith('smoke-21')), vis = [];
  for (const wide of [false, true]) {
    const w = buildWorld(structuredClone(s)), R = new Renderer(w, { noise: false }), out = new Uint8ClampedArray(w.intr.W * w.intr.H * 3), k0 = w.timeline.frames.findIndex(f => f.tc >= 0);
    if (wide) { const f = R.drawBall.bind(R); R.drawBall = (tc, light, B, zb) => { if (zb?.z) { const m = new Float32Array(zb.n).fill(Infinity); for (let b = 0; b < zb.nb; b++) for (let j = 0; j < zb.n; j++) m[j] = Math.min(m[j], zb.z[b * zb.n + j]); for (let b = 0; b < zb.nb; b++) zb.z.set(m, b * zb.n); } return f(tc, light, B, zb); }; }
    const g = R.frame(k0 - 1, out);
    assert.ok(w.sensor.exposure > 1 / 200 && g.tc < 0 && g.tc + w.sensor.exposure / 2 > 0, 'the exposure straddles impact');
    vis.push(g.ball.visibleFrac);
  }
  assert.ok(vis[0] >= 0.9, `per-phase depth keeps the streak visible (${vis[0]})`);
  assert.ok(vis[1] < 0.6, `an exposure-wide nearest depth would hide most of it (${vis[1]}); the test discriminates`);
});

test('a ball behind the front net or an insect never scores higher than the same ball unoccluded, and loses visibleFrac', () => {
  // smoke-04 (down the line, 60 fps: the ball stays in frame) with and without a front net 1 m from the lens.
  const s0 = planSplit('smoke').find(x => x.id.startsWith('smoke-04')), W = 432, H = 768;
  const world = (edit) => { const w = buildWorld({ ...structuredClone(s0), format: { ...s0.format, W, H } }); edit?.(w); return w; };
  const free = world(), k0 = free.timeline.frames.findIndex(f => f.tc >= 0), ks = Array.from({ length: 70 }, (_, i) => k0 + 1 + 2 * i).filter(k => k < free.timeline.N);
  const net = world(w => { w.D.netFront = { dist: 1, cell: 0.03, wire: 0.003, col: [40, 42, 40], tilt: 0.05 }; });
  const label = w => { const R = new Renderer(w, { noise: false, keepPatches: false }), out = new Uint8ClampedArray(W * H * 3); return ks.map(k => R.frame(k, out).ball); };
  const ref = label(free), at = ref.findIndex((b, i) => i >= 5 && b.inFrame && b.visibleFrac > 0.99 && b.expectedSnr > 4), ins = ref[at];
  assert.ok(ins, 'a clear in-flight frame to put the insect on');
  // An insect on the ball at that frame (lens space), dark and half transparent, as makeInsects draws them.
  const bug = world(w => { w.D.insects = [{ id: 'insect0', t0: w.timeline.frames[ks[at]].tc - 0.05, dur: 0.1, a: [ins.x, ins.y], v: [0, 0], wob: 0, f: 1, rad: 6, alpha: 0.45, col: [30, 28, 24] }]; });
  let covered = 0, checked = 0;
  for (const [name, w] of [['net', net], ['insect', bug]]) {
    label(w).forEach((b, i) => {
      const r = ref[i]; if (!r?.inFrame || !b?.inFrame || r.expectedSnr <= 0) return;
      checked++;
      assert.ok(b.visibleFrac <= r.visibleFrac + 1e-6, `${name} frame ${ks[i]}: visibleFrac ${b.visibleFrac} > unoccluded ${r.visibleFrac}`);
      // Allowance: the darker background behind a wire has slightly lower luma-dependent noise.
      assert.ok(b.expectedSnr <= r.expectedSnr * 1.1 + 0.05, `${name} frame ${ks[i]}: SNR ${b.expectedSnr} behind it vs ${r.expectedSnr} unoccluded`);
      if (b.visibleFrac < 0.8) { covered++; assert.ok(b.expectedSnr < r.expectedSnr, `${name} frame ${ks[i]}: covered ball (visibleFrac ${b.visibleFrac}) keeps SNR ${b.expectedSnr} >= ${r.expectedSnr}`); }
    });
  }
  assert.ok(checked > 60 && covered >= 3, `${checked} frames compared, ${covered} with the ball mostly behind a wire or the insect`);
});

test('harness annotation: no addressBall.t, launch tolerance scaled to the ball and resolution, glint and club labels away from the ball', async () => {
  const g = await gtOf(planSplit('smoke').find(x => x.id.startsWith('smoke-01')), 0.6, 540), a = harnessAnnotation(g), L = Math.max(g.meta.video.width, g.meta.video.height);
  assert.equal(g.expected, 'trace');
  assert.ok(a.addressBall && a.addressBall.t === undefined && Number.isFinite(a.addressBall.x), 'addressBall without t');
  assert.ok(a.maxLaunchErrorPx >= 0.012 * L - 1e-9 && a.maxLaunchErrorPx <= 0.035 * L + 1e-9 && Math.abs(a.maxLaunchErrorPx - Math.min(0.035 * L, Math.max(0.012 * L, 4 * g.impact.ballDiameterPx))) < 0.06, `maxLaunchErrorPx ${a.maxLaunchErrorPx}`);
  for (const d of a.distractors) { const f = g.frames.find(x => x.t === d.t); assert.ok(!f.ball?.x || Math.hypot(f.ball.x - d.x, f.ball.y - d.y) >= 0.03 * L - 1e-6, `${d.label} label at ${d.t} sits on the ball`); }
  assert.equal(g.generator.codeSha256.length, 64);
});
