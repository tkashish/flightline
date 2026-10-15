import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateFlight, sampleShot, sampleEnv, ballAt } from './synth/ball-physics.mjs';
import { rng } from './synth/math.mjs';

const calm = { rho: 1.2, tauSpin: 25, wind: { speed: 0, dir: 0, gust: 0, gustHz: 0.3, phase: 0 }, landingHeight: 0, ground: { restitution: 0.4, friction: 0.6, roll: 1 } };
const fly = (speed, launchDeg, spinRpm, extra = {}, env = calm) => simulateFlight({ speed, launchDeg, spinRpm, azimuthDeg: 0, axisTiltDeg: 0, ...extra }, env);
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

test('driver: tour-average launch carries 200-280 m with a 5-7 s flight and a realistic apex', () => {
  for (const [v, la, rpm] of [[74.7, 10.9, 2686], [62.6, 13.2, 2611], [69, 12, 2700]]) {
    const f = fly(v, la, rpm);
    assert.ok(f.carryM > 195 && f.carryM < 280, `carry ${f.carryM.toFixed(1)} m`);
    assert.ok(f.landing.t > 5 && f.landing.t < 7.2, `flight ${f.landing.t.toFixed(2)} s`);
    assert.ok(f.apex > 18 && f.apex < 38, `apex ${f.apex.toFixed(1)} m`);
    assert.ok(f.landing.angleDeg > 28 && f.landing.angleDeg < 50, `landing angle ${f.landing.angleDeg.toFixed(1)}`);
  }
  const tour = fly(74.7, 10.9, 2686);
  assert.ok(Math.abs(tour.carryM - 251) < 13, `tour driver carry ${tour.carryM.toFixed(1)} vs ~251 m`);
});

test('sampled driver shots in random wind: median carry 200-280 m and median flight 5-7 s', () => {
  const carries = [], times = [];
  for (let s = 1; s <= 120; s++) { const r = rng(s), f = simulateFlight(sampleShot(r, 'driver'), sampleEnv(r)); carries.push(f.carryM); times.push(f.landing.t); }
  assert.ok(median(carries) > 200 && median(carries) < 280, `median carry ${median(carries).toFixed(1)}`);
  assert.ok(median(times) > 5 && median(times) < 7, `median flight ${median(times).toFixed(2)}`);
  assert.ok(carries.filter(c => c > 160 && c < 310).length >= 114, 'nearly all drives between 160 and 310 m');
});

test('7-iron and wedge carry, apex and landing angles are plausible', () => {
  const i7 = fly(53.6, 16.3, 7097), i7a = fly(46.5, 19, 6699), pw = fly(45.6, 24.2, 9304);
  assert.ok(i7.carryM > 145 && i7.carryM < 172, `tour 7-iron ${i7.carryM.toFixed(1)}`);
  assert.ok(i7a.carryM > 115 && i7a.carryM < 145, `amateur 7-iron ${i7a.carryM.toFixed(1)}`);
  assert.ok(pw.carryM > 105 && pw.carryM < 135, `pitching wedge ${pw.carryM.toFixed(1)}`);
  for (const f of [i7, i7a, pw]) { assert.ok(f.apex > 18 && f.apex < 36); assert.ok(f.landing.t > 4.5 && f.landing.t < 7); }
  assert.ok(pw.landing.angleDeg > 45 && i7.landing.angleDeg > 42, 'irons land steeply');
  assert.ok(pw.P.at(-1)[2] - pw.landing.p[2] < 10, 'a spinning wedge checks up within 10 m');
  const samples = Array.from({ length: 60 }, (_, s) => { const r = rng(1000 + s); return simulateFlight(sampleShot(r, 'wedge'), sampleEnv(r)).carryM; });
  assert.ok(median(samples) > 60 && median(samples) < 125, `median sampled wedge ${median(samples).toFixed(1)}`);
});

test('spin-axis tilt curves symmetrically and wind changes carry', () => {
  const right = fly(70, 12, 2700, { axisTiltDeg: 15 }), left = fly(70, 12, 2700, { axisTiltDeg: -15 });
  assert.ok(right.landing.p[0] > 10 && left.landing.p[0] < -10, 'positive tilt curves right, negative left');
  assert.ok(Math.abs(right.landing.p[0] + left.landing.p[0]) < 0.5, 'mirror symmetric');
  const head = fly(70, 12, 2700, {}, { ...calm, wind: { ...calm.wind, speed: 6, dir: Math.PI } }), tail = fly(70, 12, 2700, {}, { ...calm, wind: { ...calm.wind, speed: 6, dir: 0 } });
  const still = fly(70, 12, 2700).carryM;
  assert.ok(head.carryM < still - 10 && tail.carryM > still + 8, `head ${head.carryM.toFixed(0)} / calm ${still.toFixed(0)} / tail ${tail.carryM.toFixed(0)}`);
  // Low-spin drives need their lift: fast spin decay drops apex and carry (high-spin irons may even gain).
  const decay = fly(70, 11, 2400, {}, { ...calm, tauSpin: 3 }), slow = fly(70, 11, 2400);
  assert.ok(decay.carryM < slow.carryM - 10 && decay.apex < slow.apex, 'faster spin decay loses lift and carry');
});

test('topped shot reaches the ground within a few metres and rolls out; flight starts at the address', () => {
  const top = fly(25, 1, 200, { club: 'topped' });
  assert.ok(top.landing.p[2] < 15, `first contact at ${top.landing.p[2].toFixed(1)} m`);
  assert.ok(top.P.at(-1)[2] > 20 && top.P.at(-1)[2] < 120, `rest at ${top.P.at(-1)[2].toFixed(1)} m`);
  const f = fly(60, 12, 2600);
  assert.deepEqual(ballAt(f, -0.5), f.start);
  const a = ballAt(f, 0.0004), b = ballAt(f, 0.0008);
  assert.ok(Math.hypot(...a.map((v, i) => v - f.start[i])) < 0.03 && Math.hypot(...b.map((v, i) => v - a[i])) < 0.03, 'continuous from the address');
});
