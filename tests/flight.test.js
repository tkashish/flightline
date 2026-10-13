import test from 'node:test';
import assert from 'node:assert/strict';
import { BallRefiner } from '../dist/refiner.js';
import { smoothFlight, extendFlight } from '../dist/curve.js';

test('a smooth curve keeps endpoints and bounds while calming mid-flight wobble', () => {
  const points = [
    { t: 1, x: .2, y: .8 },
    { t: 1.07, x: .31, y: .51 },
    { t: 1.14, x: .29, y: .48 },
    { t: 1.2, x: .33, y: .41 },
    { t: 1.9, x: .5, y: .45 }
  ];
  const curve = smoothFlight(points);
  assert.equal(curve[0].t, points[0].t);
  assert.equal(curve.at(-1).t, points.at(-1).t);
  assert.ok(Math.hypot(curve[0].x - points[0].x, curve[0].y - points[0].y) < 1e-10);
  assert.ok(Math.hypot(curve.at(-1).x - points.at(-1).x, curve.at(-1).y - points.at(-1).y) < 1e-10);
  // Interior samples stay near the flight corridor, not glued to pixel chatter.
  for (const p of points.slice(1, -1)) {
    const sample = curve.reduce((best, c) => Math.abs(c.t - p.t) < Math.abs(best.t - p.t) ? c : best);
    assert.ok(Math.hypot(sample.x - p.x, sample.y - p.y) < .2, `midpoint drifted too far at t=${p.t}`);
  }
  assert.ok(curve.every(p => p.x >= .18 && p.x <= .52 && p.y >= .38 && p.y <= .82));
  assert.ok(curve.slice(1).every((p, i) => p.t > curve[i].t));
});
test('extends an established rising flight past the last observation', () => {
  const points = [
    { t: 1.0, x: .55, y: .72 },
    { t: 1.1, x: .56, y: .64 },
    { t: 1.2, x: .57, y: .57 },
    { t: 1.3, x: .58, y: .51 },
    { t: 1.4, x: .59, y: .46 },
    { t: 1.5, x: .60, y: .42 }
  ];
  const extended = extendFlight(points, 2.2, { fps: 30 });
  const extra = extended.filter(p => p.extrapolated);
  assert.ok(extra.length >= 5, `only ${extra.length} extrapolated points`);
  assert.ok(extended.at(-1).t > points.at(-1).t);
  assert.ok(extra[0].y < points.at(-1).y);
  assert.ok(extra[2].y < extra[0].y);
  assert.ok(extended.every(p => p.x > .5 && p.x < .8 && p.y > -.02 && p.y < .75));
});
test('trims a stalled tracking tail before extrapolating', () => {
  const points = [
    { t: 1.0, x: .55, y: .72 },
    { t: 1.1, x: .56, y: .60 },
    { t: 1.2, x: .57, y: .50 },
    { t: 1.3, x: .58, y: .42 },
    { t: 1.4, x: .580, y: .419 },
    { t: 1.5, x: .581, y: .418 },
    { t: 1.6, x: .581, y: .417 }
  ];
  const extended = extendFlight(points, 2.5, { fps: 30 });
  assert.ok(extended.filter(p => p.extrapolated).length >= 5);
  assert.ok(extended.at(-1).t > 1.3);
  assert.ok(extended.filter(p => p.extrapolated)[2].y < .40);
});
test('does not moon-shot from an outlier upward spike', () => {
  const points = [
    { t: 1.0, x: .60, y: .70 },
    { t: 1.1, x: .59, y: .62 },
    { t: 1.2, x: .58, y: .55 },
    { t: 1.3, x: .57, y: .50 },
    // Bad association: jumps almost straight up for one frame.
    { t: 1.33, x: .56, y: .18 },
    { t: 1.4, x: .565, y: .47 },
    { t: 1.5, x: .57, y: .44 }
  ];
  const extended = extendFlight(points, 4, { fps: 30 });
  const extra = extended.filter(p => p.extrapolated);
  assert.ok(extra.length >= 3);
  // Must not leave the top of the frame in a fraction of a second.
  assert.ok(extra[0].y > .25, `first extra y=${extra[0].y}`);
  const early = extra.filter(p => p.t <= points.at(-1).t + .4);
  assert.ok(early.every(p => p.y > .15), 'rocketed off-screen too fast');
  // Path should keep some sideways character, not a pure vertical needle.
  const dx = Math.abs(extra.at(-1).x - points.at(-1).x);
  const dy = Math.abs(extra.at(-1).y - points.at(-1).y);
  assert.ok(dy < .55 || dx > .02, `needle path dx=${dx} dy=${dy}`);
});
test('near-apex stall does not invent a vertical dump back to the tee', () => {
  const points = [
    { t: 1.0, x: .48, y: .82 },
    { t: 1.05, x: .50, y: .72 },
    { t: 1.10, x: .52, y: .63 },
    { t: 1.15, x: .535, y: .55 },
    { t: 1.20, x: .548, y: .48 },
    { t: 1.25, x: .558, y: .42 },
    { t: 1.30, x: .566, y: .37 },
    { t: 1.35, x: .572, y: .33 },
    { t: 1.40, x: .576, y: .30 },
    { t: 1.45, x: .578, y: .28 },
    { t: 1.50, x: .579, y: .275 }
  ];
  const extended = extendFlight(points, 5, { fps: 30 });
  const extra = extended.filter(p => p.extrapolated);
  assert.ok(extra.length >= 3);
  const peakY = Math.min(...extended.map(p => p.y));
  const fall = extended.filter(p => p.extrapolated && p.y > peakY + .01);
  assert.ok(extended.at(-1).y < points[0].y - .2, `dumped toward tee y=${extended.at(-1).y}`);
  if (fall.length >= 2) {
    const dx = Math.abs(fall.at(-1).x - fall[0].x);
    const dy = fall.at(-1).y - fall[0].y;
    assert.ok(dy / Math.max(1e-4, dx) < 4.5, `vertical needle dy=${dy} dx=${dx}`);
  }
  assert.ok(Math.abs(extra.at(-1).x - points.at(-1).x) > .02, 'lost sideways drift');
});
test('strips lightning-bolt kinks before extending', () => {
  const points = [
    { t: 1.00, x: .52, y: .82 },
    { t: 1.05, x: .51, y: .74 },
    { t: 1.10, x: .50, y: .66 },
    { t: 1.15, x: .49, y: .58 },
    { t: 1.20, x: .48, y: .50 },
    { t: 1.25, x: .47, y: .43 },
    { t: 1.28, x: .50, y: .40 },
    { t: 1.31, x: .46, y: .36 },
    { t: 1.35, x: .44, y: .32 },
    { t: 1.40, x: .42, y: .28 }
  ];
  const extended = extendFlight(points, 4, { fps: 30 });
  const extra = extended.filter(p => p.extrapolated);
  assert.ok(extra.length >= 4);
  // No mid-path zig: consecutive turns should stay reasonably open.
  for (let i = 2; i < extended.length - 1; i++) {
    const a = extended[i - 2], b = extended[i - 1], c = extended[i];
    const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
    const lab = Math.hypot(abx, aby), lbc = Math.hypot(bcx, bcy);
    if (lab < 1e-4 || lbc < 1e-4) continue;
    const cos = (abx * bcx + aby * bcy) / (lab * lbc);
    assert.ok(cos > -.15, `kink cos=${cos} at t=${b.t}`);
  }
  // Must not rocket into the far corner from a tiny left bias.
  assert.ok(extra.at(-1).x > .15, `corner rocket x=${extra.at(-1).x}`);
});
test('slowing mid-flight climb still extrapolates upward', () => {
  const points = [];
  for (let i = 0; i < 20; i++) {
    const u = i / 19;
    points.push({
      t: 1 + i * .04,
      x: .45 + .12 * u,
      y: .85 - .5 * (1 - Math.pow(1 - u, 1.8))
    });
  }
  const extended = extendFlight(points, 5, { fps: 30 });
  const extra = extended.filter(p => p.extrapolated);
  assert.ok(extra.length >= 8, `only ${extra.length} extrapolated`);
  assert.ok(extra[3].y < points.at(-1).y, 'should keep climbing after last sighting');
  assert.ok(extra.at(-1).x > points.at(-1).x, 'should keep drifting sideways');
});
test('does not invent an extension without a clear rising flight', () => {
  const points = [{ t: 1, x: .4, y: .5 }, { t: 1.1, x: .41, y: .5 }, { t: 1.2, x: .42, y: .51 }, { t: 1.3, x: .43, y: .5 }];
  assert.equal(extendFlight(points, 5).length, points.length);
});

function faintFrame(x, y, brightness) {
  const pixels = new Uint8ClampedArray(128 * 128 * 4);
  for (let py = 0; py < 128; py++) for (let px = 0; px < 128; px++) {
    const i = (py * 128 + px) * 4;
    pixels.set([60, 100, 150, 255], i);
    if (Math.hypot(px - x, py - y) < 1.5) pixels.set([60 + brightness, 100 + brightness, 150 + brightness, 255], i);
    if (Math.hypot(px - 90, py - 35) < 1.5) pixels.set([240, 240, 240, 255], i);
  }
  return pixels;
}
test('native refinement follows a faint moving ball and ignores a brighter static object', () => {
  const refiner = new BallRefiner(128, 128, [{ t: 0, x: 35 / 128, y: 90 / 128 }, { t: 1 / 30, x: 37 / 128, y: 88 / 128 }]);
  for (let i = 1; i < 25; i++) refiner.detect(faintFrame(35 + i * 2, 90 - i * 2, 40 - i), 128, 128, 0, 0, i / 30);
  const last = refiner.result().at(-1);
  assert.ok(last.t >= 23 / 30);
  assert.ok(Math.hypot(last.x * 128 - 83, last.y * 128 - 42) < 1);
});
test('refinement stops after losing the ball instead of extending into a static highlight', () => {
  const refiner = new BallRefiner(128, 128, [{ t: 0, x: 70 / 128, y: 55 / 128 }, { t: 1 / 30, x: 72 / 128, y: 53 / 128 }]);
  for (let i = 2; i < 20; i++) refiner.detect(faintFrame(-20, -20, 30), 128, 128, 0, 0, i / 30);
  assert.equal(refiner.finished, true);
  assert.ok(refiner.result().at(-1).t < .2);
});
test('does not switch to a bright object moving in the opposite direction at a crossing', () => {
  const refiner = new BallRefiner(128, 128, [{ t: 0, x: 80 / 128, y: 80 / 128 }, { t: 1 / 30, x: 82 / 128, y: 80 / 128 }]);
  for (let i = 2; i < 12; i++) refiner.detect(faintFrame(83 - i, 80, 80), 128, 128, 0, 0, i / 30);
  assert.equal(refiner.finished, true);
  assert.equal(refiner.result().length, 2);
});
