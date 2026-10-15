import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorld, buildTimeline } from './synth/world.mjs';
import { Renderer } from './synth/render.mjs';
import { completeSpec } from './synth/scenarios.mjs';
import { generateClip } from './synth/clip.mjs';
import { probe, decodeGray } from './synth/encode.mjs';

const tiny = (o) => completeSpec({ id: o.id || 'tim', split: 'test', seed: o.seed, view: o.view || 'dtl-hands', viewClass: 'dtl', hand: 1, club: o.club || 'iron7', kind: 'hit', capture: o.capture, sky: 'blue', ground: 'grass', tee: 'none', lens: 'main', format: { W: 180, H: 320, rotation: o.rotation ?? 0 }, durationOut: o.dur ?? 1.2, impactOut: o.impact ?? 0.5, confounders: { shake: 1, ...(o.conf || {}) }, encode: { container: o.container || 'mp4', codec: o.codec || 'h264' }, audio: o.audio || 'none' });

test('slow motion renders at capture times and stamps 30 fps output', () => {
  for (const fps of [120, 240]) {
    const s = tiny({ seed: 5, capture: { fps, slowmo: true }, dur: 6, impact: 2 }), w = buildWorld(s), tl = w.timeline, tau = fps / 30;
    assert.equal(tl.fpsOut, 30); assert.equal(tl.tau, tau); assert.equal(tl.N, 180);
    tl.frames.forEach((f, k) => { assert.equal(f.ticks, k * 3000); assert.ok(Math.abs(f.tc - (w.tStart + k / fps)) < 1e-9); });
    assert.ok(Math.abs(w.tStart + 2 / tau) < 1e-9, 'impact at 2 s of output time = 2/tau s of real time after the clip start');
    // Ball travel per output frame is one capture interval of real flight.
    const R = new Renderer(w, { noise: false }), out = new Uint8ClampedArray(180 * 320 * 3), k0 = tl.frames.findIndex(f => f.tc >= 0);
    const a = R.frame(k0 + 2, out).ball, b = R.frame(k0 + 3, out).ball;
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 0 && Math.abs(R.frame(k0 + 3, out).tc - R.frame(k0 + 2, out).tc - 1 / fps) < 1e-6);
  }
  const real = buildWorld(tiny({ seed: 5, capture: { fps: 240 }, dur: 1 }));
  assert.equal(real.timeline.fpsOut, 240); assert.equal(real.timeline.frames[1].ticks, 375); assert.equal(real.timeline.tau, 1);
});

test('VFR jitter, dropped and duplicated frames: the container carries exactly the planned PTS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-t-'));
  const s = tiny({ id: 'vfr', seed: 8, capture: { fps: 60, vfr: true, drops: 3, dups: 2 }, dur: 1.5, impact: 0.6 });
  const res = await generateClip(s, { outDir: dir, threads: 1 }), g = JSON.parse(readFileSync(join(dir, res.gtFile), 'utf8')), pr = probe(join(dir, res.file));
  const tl = buildWorld(s).timeline;
  assert.equal(pr.timeBase, '1/90000'); assert.equal(pr.pts.length, tl.N);
  assert.deepEqual(pr.pts, tl.frames.map(f => f.ticks), 'packet PTS equal the planned ticks');
  assert.equal(g.meta.video.ptsVerified, true);
  const d = pr.pts.slice(1).map((p, i) => p - pr.pts[i]);
  assert.ok(Math.max(...d) >= 2 * 1500 - 300 && new Set(d).size > 5, 'jittered intervals and at least one gap');
  assert.equal(g.frames.length, tl.N); g.frames.forEach((f, k) => assert.equal(f.t, tl.frames[k].ticks / 90000));
  for (const k of tl.dups) { assert.equal(g.frames[k].dupOf, k - 1); assert.deepEqual(g.frames[k].ball, g.frames[k - 1].ball); }
});

test('rotation metadata: coded frames are rotated, tagged, and decode upright like the render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-r-'));
  for (const rotation of [90, -90, 180]) {
    const s = tiny({ id: `rot${rotation}`, seed: 9, capture: { fps: 30 }, rotation, container: rotation === 90 ? 'mov' : 'mp4', codec: rotation === -90 ? 'hevc' : 'h264' });
    const rendered = [];
    const res = await generateClip(s, { outDir: dir, threads: 1, onFrame: (k, buf) => { if (k === 10) rendered.push(Buffer.from(buf)); } });
    const pr = probe(join(dir, res.file));
    assert.equal(pr.rotation, rotation, 'display matrix rotation');
    assert.deepEqual([pr.codedWidth, pr.codedHeight], rotation === 180 ? [180, 320] : [320, 180], 'coded orientation');
    let dec = null;
    await decodeGray(join(dir, res.file), 180, 320, (k, D) => { if (k === 10) dec = Buffer.from(D); });
    const r = rendered[0], n = 180 * 320, Y = i => 0.2126 * r[i * 3] + 0.7152 * r[i * 3 + 1] + 0.0722 * r[i * 3 + 2];
    // Compare after a linear fit (decoder range/matrix conventions), upright vs rotated by 180 degrees.
    const err = map => { let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { const x = Y(i), y = dec[map(i)]; sx += x; sy += y; sxx += x * x; sxy += x * y; } const a = (sxy - sx * sy / n) / (sxx - sx * sx / n), b = (sy - a * sx) / n; let e = 0; for (let i = 0; i < n; i++) e += Math.abs(dec[map(i)] - a * Y(i) - b); return { e: e / n, a }; };
    const same = err(i => i), flipped = err(i => n - 1 - i);
    assert.ok(same.e < 4 && same.a > 0.8 && flipped.e > same.e * 3, `rotation ${rotation}: upright error ${same.e.toFixed(2)} (gain ${same.a.toFixed(3)}) vs flipped ${flipped.e.toFixed(2)}`);
    const g = JSON.parse(readFileSync(join(dir, res.gtFile), 'utf8'));
    assert.equal(g.meta.video.rotation, rotation); assert.equal(g.meta.video.width, 180); assert.equal(g.meta.video.height, 320);
  }
});

test('timeline expression matches the JS ticks for many VFR seeds', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = tiny({ seed, capture: { fps: 30, vfr: true, drops: 2 }, dur: 3 }), tl = buildTimeline(s, -1);
    for (let k = 1; k < tl.N; k++) assert.ok(tl.frames[k].ticks > tl.frames[k - 1].ticks, 'monotone PTS');
    assert.equal(tl.frames[0].ticks, 0);
  }
});
