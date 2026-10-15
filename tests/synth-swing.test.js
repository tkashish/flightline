import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, len, sub, dot, norm } from './synth/math.mjs';
import { sampleGolfer, planGolfer } from './synth/golfer.mjs';
import { buildWorld } from './synth/world.mjs';
import { completeSpec, planSplit, factorSummary } from './synth/scenarios.mjs';
import { makeView, project } from './synth/camera.mjs';
import { BALL } from './synth/ball-physics.mjs';
import { CLUB_SPECS } from './synth/club.mjs';

const cases = [];
for (const club of ['driver', 'iron7', 'wedge']) for (const hand of [1, -1]) for (const seed of [1, 2, 3, 4]) cases.push({ club, hand, seed });

test('at t0 the face meets the back of the ball: contact point through the ball center, head center r + face offset behind, speed = ball speed / smash', () => {
  for (const { club, hand, seed } of cases) {
    const r = rng(seed * 31 + (hand > 0 ? 0 : 7)), g = sampleGolfer(r, { hand }), ball = [0, club === 'driver' ? 0.058 : 0.0213, 0];
    const ballSpeed = club === 'driver' ? 68 : club === 'iron7' ? 50 : 40, smash = club === 'driver' ? 1.46 : club === 'iron7' ? 1.34 : 1.22, v = ballSpeed / smash;
    const p = planGolfer(r, g, { club, kind: 'hit', target: ball, headSpeed: v }), c0 = p.poseAt(0).club, back = BALL.r + CLUB_SPECS[club].faceOff;
    assert.ok(len(sub(c0.contact, ball)) < 1e-6, `${club}/${hand}/${seed}: contact point misses the ball by ${len(sub(c0.contact, ball))}`);
    assert.ok(Math.abs(len(sub(c0.head, ball)) - back) < 1e-6, `${club}/${hand}/${seed}: head center ${len(sub(c0.head, ball)).toFixed(4)} m from the ball center, want ${back.toFixed(4)}`);
    const speed = len(p.headVel(0));
    assert.ok(Math.abs(speed - v) / v < 0.005, `${club}/${hand}/${seed}: head speed ${speed.toFixed(2)} vs ${v.toFixed(2)}`);
    // Toward the target through impact; the head center trails the ball along its own velocity.
    const vel = norm(p.headVel(0));
    assert.ok(vel[2] > 0.9, `${club}: impact velocity points down the target line (${vel.map(x => x.toFixed(2))})`);
    assert.ok(dot(sub(ball, c0.head), vel) > 0.95 * back, `${club}/${hand}/${seed}: head center behind the ball along the path`);
    const before = p.poseAt(-0.004).club.contact, after = p.poseAt(0.004).club.contact;
    assert.ok(before[2] < 0 && after[2] > 0, 'contact point comes from behind the ball and continues past it');
    assert.ok(Math.abs(dot(c0.up, [0, 1, 0])) > 0.5 && c0.up[1] > 0, `${club}/${hand}: head up vector points up at impact`);
    const v0 = p.headVel(-1e-4), v1 = p.headVel(1e-4);
    assert.ok(len(sub(v0, v1)) / v < 0.02, `velocity continuous through impact (jump ${len(sub(v0, v1)).toFixed(3)} m/s)`);
    // The follow-through stays on the swing arc: speed decays smoothly, no jumps in position.
    let prev = p.poseAt(0).club.head;
    for (let t = 0.005; t < 0.3; t += 0.005) { const q = p.poseAt(t).club.head, d = len(sub(q, prev)); assert.ok(d < v * 0.005 * 1.2, `follow-through jump at ${t.toFixed(3)} s: ${d.toFixed(3)} m`); prev = q; }
    assert.ok(len(p.headVel(0.25)) < speed * 0.8, 'decelerates after impact');
  }
});

test('swing timing: waggle and forward press precede a 0.75-1.0 s backswing and a ~0.25-0.3 s downswing', () => {
  let waggles = 0;
  for (const { club, hand, seed } of cases) {
    const r = rng(seed * 97 + hand), p = planGolfer(r, sampleGolfer(r, { hand }), { club, kind: 'hit', target: [0, 0.0213, 0], headSpeed: 36 });
    const T = p.times, back = T.tTop - T.tTakeaway, down = -T.tTop;
    assert.ok(back >= 0.6 && back <= 1.05, `backswing ${back.toFixed(3)} s`);
    assert.ok(down >= 0.2 && down <= 0.4, `downswing ${down.toFixed(3)} s`);
    assert.ok(T.tPress < T.tTakeaway && T.tTakeaway - T.tPress < 0.3, 'forward press right before the takeaway');
    const pressMove = len(sub(p.poseAt(T.tTakeaway).club.grip, p.poseAt(T.tPress - 0.01).club.grip));
    assert.ok(pressMove > 0.005 && pressMove < 0.08, `forward press moves the hands ${pressMove.toFixed(3)} m`);
    waggles += T.waggles.length;
    for (const w of T.waggles) assert.ok(len(sub(p.poseAt(w + 0.25).club.head, p.poseAt(T.tPress - 0.01).club.head)) > 0.05, 'waggle moves the club head');
    // The top of the backswing is above the shoulders; the shaft length never changes.
    const top = p.poseAt(T.tTop);
    assert.ok(top.club.head[1] > top.shL[1] + 0.2 && top.club.grip[1] > 1.3 * p.golfer.height / 1.8, 'hands and club high at the top');
    for (const t of [T.tTakeaway, T.tTop, -0.1, 0, 0.3, 1.2]) { const q = p.poseAt(t).club; assert.ok(Math.abs(len(sub(q.head, q.grip)) - p.params.Lc) < 1e-6); }
  }
  assert.ok(waggles > 0, 'some swings waggle');
});

test('in the image the GT club contact point passes through the GT address point at t0 (both hands, all views)', () => {
  for (const [view, hand, club] of [['dtl-hands', 1, 'iron7'], ['face-on', -1, 'driver'], ['oblique', 1, 'wedge'], ['dtl-ball', -1, 'iron7']]) {
    const spec = completeSpec({ id: 't', split: 'test', seed: 4242, view, viewClass: view.startsWith('dtl') ? 'dtl' : view === 'face-on' ? 'fo' : 'oblique', hand, club, kind: 'hit', capture: { fps: 60 }, sky: 'blue', ground: 'grass', format: { W: 1080, H: 1920 }, confounders: { shake: 2 } });
    const w = buildWorld(spec), v = makeView(w.intr, w.place.C, w.motion(0)), c0 = w.plan.poseAt(0).club, contact = project(v, c0.contact), ball = project(v, w.ballStart), head = project(v, c0.head);
    assert.ok(Math.hypot(contact.x - ball.x, contact.y - ball.y) < 0.01, `${view}: club contact ${contact.x.toFixed(2)},${contact.y.toFixed(2)} vs address ${ball.x.toFixed(2)},${ball.y.toFixed(2)}`);
    assert.ok(Math.hypot(head.x - ball.x, head.y - ball.y) > 0.3 * BALL.d * ball.ppm || view.startsWith('dtl'), `${view}: the head center sits beside the ball, not on it`);
    assert.ok(Math.abs(len(w.plan.headVel(0)) - w.shot.speed / w.shot.smash) < 0.2);
    assert.ok(ball.x > 0 && ball.y > 0 && ball.x < 1080 && ball.y < 1920, `${view}: address in frame`);
  }
});

test('pre-shot routine: a share of real-time clips start 2-5 s before impact, so the setup, waggles and forward press are in the clip', () => {
  for (const split of ['tune', 'holdout']) {
    const S = planSplit(split), real = S.filter(s => !s.capture.slowmo && s.kind === 'hit' && !s.confounders.hiddenAddress && !s.confounders.practiceFirst);
    const long = real.filter(s => s.impactOut >= 2);
    assert.ok(long.length >= 0.3 * real.length, `${split}: ${long.length}/${real.length} real-time hits start >= 2 s before impact`);
    assert.ok(Math.max(...real.map(s => s.impactOut)) <= 5 + 1e-9, 'lead-ins stay within 5 s');
    let waggling = 0, inClip = 0, press = 0;
    for (const s of long.filter((_, i) => i % 4 === 0)) {
      const w = buildWorld(structuredClone(s)), r = factorSummary(s, w).routine;
      press += r.pressInClip; if (r.waggles) { waggling++; inClip += r.wagglesInClip > 0; }
      assert.ok(r.preImpactS >= 2 - 1e-3 && r.stillBeforeTakeawayS > 0.3, `${s.id}: ${JSON.stringify(r)}`);
    }
    assert.ok(press === long.filter((_, i) => i % 4 === 0).length && inClip >= 0.8 * waggling, `${split}: press in clip ${press}, waggles in clip ${inClip}/${waggling}`);
  }
});

test('practice then hit: a practice swing beside the ball 2-4 s before the real takeaway, inside the clip; then a still address and the hit', () => {
  const specs = [...planSplit('tune'), ...planSplit('holdout')].filter(s => s.confounders.practiceFirst), smoke = planSplit('smoke').filter(s => s.confounders.practiceFirst);
  assert.ok(specs.length >= 32 && smoke.length === 1, `${specs.length} practice-first clips in tune and holdout`);
  let brushed = 0, onGrass = 0;
  for (const s of [...smoke, ...specs.filter((_, i) => i % 3 === 0)]) {
    const w = buildWorld(structuredClone(s)), T = w.plan.times, P = T.practice, f = factorSummary(s, w), ball = w.ballStart;
    assert.equal(f.kind, 'practice-hit'); assert.ok(f.routine.practiceSwingInClip, `${s.id}: practice swing inside the clip`);
    const gap = T.tTakeaway - P.tImpact;
    assert.ok(gap >= 1.8 && gap <= 4.2 && P.tTakeaway >= w.tStart, `${s.id}: practice impact ${P.tImpact.toFixed(2)} s, takeaway ${T.tTakeaway.toFixed(2)} s, clip from ${w.tStart.toFixed(2)} s`);
    // The practice swing passes beside the ball, never through it; the club head comes back and rests at the address.
    let near = Infinity; for (let t = P.tTakeaway; t < P.blendS[0]; t += 0.004) near = Math.min(near, len(sub(w.plan.poseAt(t).club.head, ball)));
    assert.ok(near > 0.15, `${s.id}: practice swing passes ${near.toFixed(2)} m from the ball`);
    assert.ok(len(sub(w.plan.poseAt(P.blendS[1] + 0.05).club.head, w.plan.poseAt(T.tPress - 0.05).club.head)) < 0.01, `${s.id}: still address after stepping in`);
    // Letting the practice club down and stepping in are continuous and slower than a swing.
    let v0 = null; for (let t = P.tImpact + 0.4; t < T.tPress; t += 0.004) { const v = sub(w.plan.poseAt(t + 0.004).club.head, w.plan.poseAt(t).club.head).map(x => x / 0.004); assert.ok(len(v) < 10 && (!v0 || len(sub(v, v0)) < 1.5), `${s.id}: club head jumps at ${t.toFixed(3)} s (${len(v).toFixed(1)} m/s)`); v0 = v; }
    assert.ok(Math.abs(len(w.plan.headVel(0)) - w.shot.speed / w.shot.smash) < 0.2, `${s.id}: the real swing still meets the ball at ball speed / smash`);
    if (s.ground === 'grass' && w.plan.look.kind === 'iron') { onGrass++; if (w.D.divot.some(p => Math.abs((p.t0 ?? 0) - P.tImpact) < 1e-9)) brushed++; }
  }
  assert.ok(onGrass === 0 || brushed >= 0.5 * onGrass, `iron practice swings on grass brush the turf: ${brushed}/${onGrass}`);
});

test('practice-only iron swings on grass brush the turf at their low point; whiffs do not', () => {
  let n = 0, brushed = 0;
  for (const s of [...planSplit('tune'), ...planSplit('holdout')].filter(s => s.kind !== 'hit' && s.ground === 'grass')) {
    const w = buildWorld(structuredClone(s)), turf = w.D.divot.filter(p => p.t0 === 0);
    if (s.kind === 'whiff' || w.plan.look.kind !== 'iron') { assert.equal(turf.length, 0, `${s.id}: ${s.kind} with a ${w.plan.club}`); continue; }
    n++; if (turf.length) { brushed++; assert.ok(turf.every(p => Math.hypot(p.p0[0] - w.practiceAt.p[0], p.p0[2] - w.practiceAt.p[2]) < 0.2), `${s.id}: turf at the swing's low point`); }
  }
  assert.ok(n >= 8 && brushed >= 0.5 * n, `${brushed}/${n} practice iron swings on grass brush the turf`);
});
