import test from 'node:test';
import assert from 'node:assert/strict';
import { planSplit, confounderCount, CAP, STRESS, MIN_CELL } from './synth/scenarios.mjs';
import { buildWorld, segDist } from './synth/world.mjs';
import { makeView, project } from './synth/camera.mjs';

const cell = s => `${s.viewClass}|${s.capture.fps}${s.capture.slowmo ? 's' : ''}`;

test('view x capture cells are filled jointly (>= 12 clips, >= 10 hits each per split) and clubs spread within every view', () => {
  for (const split of ['tune', 'holdout']) {
    const S = planSplit(split), cells = Map.groupBy(S, cell);
    assert.equal(cells.size, 18, `${split}: 3 views x 6 captures`);
    for (const [k, g] of cells) {
      assert.ok(g.length >= MIN_CELL, `${split} ${k}: ${g.length} clips`);
      assert.ok(g.filter(s => s.kind === 'hit').length >= 10, `${split} ${k}: ${g.filter(s => s.kind === 'hit').length} hits`);
    }
    for (const v of ['dtl', 'fo', 'oblique']) for (const club of ['driver', 'iron7', 'wedge']) {
      const n = S.filter(s => s.viewClass === v && s.kind === 'hit' && s.club === club).length;
      assert.ok(n >= 15, `${split} ${v} x ${club}: ${n} hits`);
    }
  }
});

test('confounders: at most 3 per clip (shake and minor scenery count), 5-7 in the stress stratum, none on clean baselines', () => {
  for (const split of ['tune', 'holdout']) {
    const S = planSplit(split);
    for (const s of S) {
      const n = confounderCount(s.confounders);
      if (s.clean) assert.equal(n, 0, s.id);
      else if (s.stress) assert.ok(n >= STRESS.min && n <= STRESS.max, `${s.id}: stress clip with ${n}`);
      else assert.ok(n <= CAP, `${s.id}: ${n} confounders ${Object.keys(s.confounders)}`);
    }
    const stress = S.filter(s => s.stress).length;
    assert.ok(stress >= 0.06 * S.length && stress <= 0.1 * S.length, `${split}: ${stress} stress clips`);
    assert.equal(S.filter(s => s.clean).length, 18, `${split}: one clean baseline per view x capture cell`);
    assert.equal(new Set(S.filter(s => s.clean).map(cell)).size, 18);
  }
});

test('clean baselines and the easy split are genuinely easy', () => {
  const specs = [...planSplit('tune').filter(s => s.clean), ...planSplit('holdout').filter(s => s.clean), ...planSplit('easy')];
  assert.equal(planSplit('easy').length, 22);
  for (const s of specs) {
    assert.equal(s.sky, 'blue', s.id); assert.equal(s.lens, 'main', s.id); assert.equal(s.hand, 1, s.id);
    assert.deepEqual([s.format.W, s.format.H, s.format.rotation], [1080, 1920, 0], s.id);
    assert.deepEqual([s.encode.codec, s.encode.lowBitrate, s.encode.rateK], ['h264', false, 1], s.id);
    assert.equal(confounderCount(s.confounders), 0, s.id); assert.equal(s.confounders.shake, 0, s.id);
    if (s.viewClass === 'dtl') assert.equal(s.view, 'dtl-ball', `${s.id}: straight behind the ball`);
    const w = buildWorld(structuredClone(s)), d = Math.hypot(w.place.C[0] - w.ballStart[0], w.place.C[2] - w.ballStart[2]);
    assert.ok(w.sensor.exposure <= 1 / 2000 + 1e-12, `${s.id}: exposure 1/${Math.round(1 / w.sensor.exposure)}`);
    assert.equal(w.shake.sigmaDeg, 0, `${s.id}: tripod`); assert.equal(w.scene.sunRel, 'back', `${s.id}: sun behind`);
    assert.ok(d >= 4 && d <= 6.1, `${s.id}: camera ${d.toFixed(2)} m from the ball`);
  }
});

test('hidden-address clips start at most one capture interval before impact; nudges roll in inside the clip before the downswing', () => {
  for (const split of ['tune', 'holdout']) {
    const S = planSplit(split), hidden = S.filter(s => s.confounders.hiddenAddress), nudged = S.filter(s => s.confounders.nudge);
    assert.ok(hidden.length >= 12 && nudged.length >= 12, `${split}: ${hidden.length} hidden-address, ${nudged.length} nudge clips`);
    for (const s of hidden) { const fpsOut = s.capture.slowmo ? 30 : s.capture.fps; assert.ok(s.impactOut > 0 && s.impactOut <= 1 / fpsOut + 1e-6, `${s.id}: impact at ${s.impactOut} s`); }
    for (const s of nudged.slice(0, 8)) {
      const w = buildWorld(structuredClone(s)), n = w.nudge;
      assert.ok(n.t0 >= w.tStart + 0.3 - 1e-9 && n.t0 + n.dur <= -0.4 + 1e-9, `${s.id}: nudge ${n.t0.toFixed(2)}+${n.dur.toFixed(2)} s, clip from ${w.tStart.toFixed(2)} s`);
      assert.ok(n.d[2] > 0, `${s.id}: the ball rolls in from in front, never from under the club`);
    }
  }
});

test('neighbor bays and bay posts stay clear of the camera and the shot', () => {
  for (const split of ['tune', 'holdout']) {
    let n = 0;
    for (const s of planSplit(split).filter(s => s.confounders.neighbor || s.confounders.bay)) {
      const w = buildWorld(structuredClone(s)), C = w.place.C, v = makeView(w.intr, C, { yaw: w.place.yaw, pitch: w.place.pitch, roll: w.place.roll });
      const inView = P => { const q = project(v, P); return q.z > 0 && q.x >= 0 && q.y >= 0 && q.x < v.W && q.y < v.H; };
      const caps = w.D.bayPosts.map(p => ({ a: [p.x, 0, p.z], b: [p.x, p.h, p.z], r: p.r + 0.02 }));
      if (w.neighbor?.drawGolfer) { const nb = w.neighbor, x = nb.offset[0] - nb.golfer.hand * 0.8; caps.push({ a: [x, 0.1, nb.offset[2]], b: [x, 1.9, nb.offset[2]], r: 0.45 }); }
      if (w.neighbor && s.view !== 'face-on' && s.view !== 'oblique') { /* side is free down the line */ } else if (w.neighbor) assert.ok(Math.sign(w.neighbor.offset[0]) !== Math.sign(C[0]), `${s.id}: neighbor bay on the side away from the camera`);
      for (const c of caps) {
        n++;
        const near = segDist(C, C, c.a, c.b).d < 3 && [0, 0.5, 1].some(u => inView(c.a.map((a, i) => a + (c.b[i] - a) * u)));
        assert.ok(!near, `${s.id}: object within 3 m of the lens and in view`);
        for (const T of w.targets) { const o = segDist(C, T, c.a, c.b); assert.ok(!(o.d < c.r && o.s < 0.97), `${s.id}: object between the camera and the golfer, address or early flight`); }
      }
    }
    assert.ok(n > 60, `${split}: checked ${n} objects`);
  }
});
