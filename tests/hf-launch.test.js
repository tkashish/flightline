// U3 launch confirmation: pixel-level near-impact scenes (tests/hf/helpers/impact-scene.mjs) through the
// LaunchConfirmer, plus rule-level units for the projective-line law, the club chain, the null margin, the
// address hole and local CFAR. Scenes render on a small worker pool so the file stays well under 20 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { PARAMS } from '../dist/hf/params.js';
import { acceptLaunch, launchPool, LaunchConfirmer } from '../dist/hf/launch-null.js';
import { fitProjectiveLine, chainFeatures, ballEvidence, buildReference, makeScratch } from '../dist/hf/emergence.js';
import { trackClub, clubAt, clubExplained, outrunsClub, attachedToClub, singleSampleOk } from '../dist/hf/club.js';

/* ------------------------------------------------------------------ scene pool */

const URLS = {
  scene: new URL('./hf/helpers/impact-scene.mjs', import.meta.url).href,
  launch: new URL('../dist/hf/launch-null.js', import.meta.url).href,
  types: new URL('../dist/hf/types.js', import.meta.url).href,
  params: new URL('../dist/hf/params.js', import.meta.url).href
};
// One job: render the scene, run a LaunchConfirmer on the scene's (or an overridden) hypothesis, classify the
// decision against ground truth: 'ball' (most samples on the GT ball), 'club' (on a club part), 'wrong', 'abstain'.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const S = await import(workerData.urls.scene), L = await import(workerData.urls.launch), T = await import(workerData.urls.types), Pm = await import(workerData.urls.params);
  const run = j => {
    const P = j.params ? Pm.mergeParams(j.params) : Pm.PARAMS, sc = S.makeImpactScene(j.scene), g = sc.gt;
    let over = { params: P };
    if (j.anchor === 'glove') over = { ...over, address: g.hands(g.takeaway.k), d0: g.gloveD, kLast: g.takeaway.k };
    if (j.anchor === 'extra') over = { ...over, address: { x: g.extra.x, y: g.extra.y } };
    // shift: the coarse k_last off by this many frames (the interval is findImpacts', with its timing tolerance)
    if (j.shift) over = { ...over, kLast: g.kImpact + j.shift };
    const hyp = T.makeImpact(sc.hypothesis(over));
    const lc = new L.LaunchConfirmer(hyp, { meta: sc.meta, log: { camera: T.identityTrack(sc.meta) }, params: P, streak: j.streak !== false });
    const { from, to } = lc.window();
    const encoded = j.encode ? sc.encode(from, to, j.encode) : null;
    for (let k = from; k < to; k++) lc.consume(k, sc.meta.times[k], lc.roiRequests(k).map(q => sc.crop(k, q.rect, q.pool)), T.IDENTITY_SIM);
    // nullBoost: the null searches (a fake anchor or a fake impact time) report a strong launch of their own
    if (j.nullBoost) {
      const search = lc.search.bind(lc), real = lc.impacts.find(i => i.name === 'real');
      lc.search = (imp, anchor, o) => { const r = search(imp, anchor, o), fake = j.nullBoost === 'anchor' ? anchor !== lc.A : imp !== real; return fake ? { ...r, bestS: j.boostS } : r; };
    }
    const dec = lc.finish(), s = dec.candidate?.samples ?? [];
    const nb = s.filter(q => S.onBall(sc, q.index, q)).length, nc = s.filter(q => S.onClub(sc, q.index, q)).length;
    const cls = !dec.accepted ? 'abstain' : nb > 0 && nb >= Math.ceil(s.length / 2) ? 'ball' : nc > 0 ? 'club' : 'wrong';
    let vis = 0, inFrame = 0;
    for (let k = g.kImpact + 1; k <= g.kImpact + 1 + lc.K; k++) {
      const b = g.ballAt(k);
      if (!b || !b.drawn || !b.flying) continue;
      if (!b.inFrame) break;
      inFrame++;
      if (Math.hypot(b.x - g.address.x, b.y - g.address.y) >= P.launch.evidence.holeD0 * g.d0 + 0.5 * b.blur) vis++;
    }
    const t0 = dec.candidate?.t0 ?? null;
    return { id: j.id, accepted: dec.accepted, reason: dec.reason, S: dec.S, Snull: dec.Snull, margin: dec.margin, cls, eligible: vis >= (inFrame >= 4 ? 4 : 2),
      t0In: t0 === null ? null : t0 >= hyp.interval.t0 - 1e-9 && t0 <= hyp.interval.t1 + 1e-9 && t0 < s[0].t, dt0: t0 === null ? null : (t0 - g.tImpact) * sc.fps,
      pass: dec.features.impactTiming?.pass ?? null,
      mode: dec.features.mode ?? null, single: dec.candidate?.single ?? null, streak: dec.candidate?.streak ?? null, n: s.length, errors: T.check('LaunchDecision', dec), encoded,
      anchors: lc.fakeAnchors.map(a => ({ dx: (a.x - lc.A.x) / sc.width, dy: a.y - lc.A.y })), fakeK: lc.impacts.filter(i => i.name !== 'real').map(i => g.kImpact - i.k) };
  };
  for (const j of workerData.jobs) { try { parentPort.postMessage(run(j)); } catch (e) { parentPort.postMessage({ id: j.id, error: String(e && e.stack || e) }); } }
  parentPort.postMessage(null);
})();
`;
function runScenes(jobs) {
  const nW = Math.max(1, Math.min(jobs.length, 8, (os.availableParallelism?.() ?? 4) - 1)), out = new Map();
  return Promise.all(Array.from({ length: nW }, (_, w) => new Promise((res, rej) => {
    const wk = new Worker(WORKER_SRC, { eval: true, workerData: { urls: URLS, jobs: jobs.filter((_, i) => i % nW === w) } });
    wk.on('message', m => { if (m === null) { wk.terminate(); res(); } else out.set(m.id, m); });
    wk.on('error', rej);
  }))).then(() => out);
}
const SHORT = 1 / 2000, long = (fps, tau = 1) => Math.min(1 / (fps * tau), 1 / 120);
const scene = (view, fps, tau, club, ex, seed, more = {}) => ({ view, fps, tau, club, shutter: ex === 'long' ? long(fps, tau) : SHORT, seed, ...more });
const ffmpegOk = (() => { try { return spawnSync(process.env.FFMPEG ?? 'ffmpeg', ['-version']).status === 0; } catch { return false; } })();

// Scene matrix (view × container fps × capture rate × club × exposure), one seed per cell; seeds from the scratch
// matrix (tune split). Every one is ball-eligible: the ball is outside the address hole in >= 2 frames before
// exiting (or >= 4 when it stays in frame).
const MATRIX = [
  scene('dtl', 30, 1, 'iron', 'short', 38), scene('dtl', 30, 1, 'driver', 'long', 378), scene('dtl', 60, 1, 'iron', 'long', 108),
  scene('dtl', 60, 1, 'driver', 'short', 368), scene('dtl', 240, 1, 'iron', 'short', 248), scene('dtl', 240, 1, 'driver', 'long', 588),
  scene('dtl', 30, 8, 'iron', 'long', 127), scene('fo', 30, 8, 'driver', 'short', 5387), scene('fo', 60, 1, 'iron', 'short', 5068),
  scene('fo', 240, 1, 'driver', 'short', 5548), scene('fo', 240, 1, 'iron', 'long', 5793), scene('fo', 30, 8, 'iron', 'long', 5228)
];
// invisible-ball controls: the same swings with the ball never drawn after impact; several were club accepts
// during development (90288 down-the-line slow head, 95430 slow-motion face-on, 90389 head at the ball)
const CONTROLS = [
  scene('dtl', 60, 1, 'iron', 'short', 90068, { ball: 'hidden' }), scene('dtl', 240, 1, 'iron', 'long', 90288, { ball: 'hidden' }),
  scene('dtl', 240, 1, 'iron', 'long', 90389, { ball: 'hidden' }), scene('dtl', 30, 8, 'iron', 'long', 90127, { ball: 'hidden' }),
  scene('fo', 30, 8, 'iron', 'long', 95430, { ball: 'hidden' }), scene('fo', 60, 1, 'iron', 'short', 95573, { ball: 'hidden' }),
  scene('fo', 240, 1, 'driver', 'long', 95588, { ball: 'hidden' }), scene('fo', 30, 8, 'driver', 'short', 95387, { ball: 'hidden' }),
  // rule pins from ablations of the scratch matrix: the streak-axis check (140188, 145427), the address hole
  // (145430), the two-sample exit (145411), D3's min step (140408), the late-start gap (90270), the two-body
  // lead f4 (140280)
  scene('dtl', 30, 8, 'iron', 'short', 140188, { ball: 'hidden' }), scene('fo', 30, 8, 'driver', 'long', 145427, { ball: 'hidden' }),
  scene('fo', 30, 8, 'iron', 'long', 145430, { ball: 'hidden' }), scene('fo', 60, 1, 'iron', 'long', 145411, { ball: 'hidden' }),
  scene('dtl', 60, 1, 'driver', 'long', 140408, { ball: 'hidden' }), scene('dtl', 60, 1, 'iron', 'short', 90270, { ball: 'hidden' }),
  scene('dtl', 30, 1, 'iron', 'long', 140280, { ball: 'hidden' })
];
// impact timing: flights the single-k_last search lost with the coarse k_last off by 1-2 frames (base sweep of the tune
// matrix), and invisible-ball controls it then confirmed as the club (shift in frames). Known gap: with k_last one
// frame early, 3 of 256 tune controls (90270, 95490, 95087) still pass the single-k_last search against its own,
// mistimed club; base did the same (3/256)
const TIMING = [['dtl', 60, 1, 'iron', 'short', 68], ['fo', 240, 1, 'driver', 'short', 5548], ['fo', 60, 1, 'iron', 'short', 5068]];
const TIMING_CTL = [['dtl', 240, 1, 'iron', 'short', 90652, -2], ['fo', 240, 1, 'iron', 'long', 95288, -2], ['fo', 30, 8, 'iron', 'long', 95228, -2], ['dtl', 240, 1, 'iron', 'short', 90551, -1]];
// whose club judges a chain: with k_last early the single-k_last search found no club and confirmed the head
// (430, 733 at -1; 5894, 5389 at -2: the head that arrived at the chain's t0 rejects it), while at the exact k_last
// replacing a club it DID find lost the ball (641, 873, 5512: the replacement's exit followed the ball)
const CHAIN_CLUB = [['dtl', 30, 8, 'iron', 'long', 430, -1], ['dtl', 30, 8, 'iron', 'long', 733, -1], ['fo', 240, 1, 'iron', 'long', 5894, -2],
  ['fo', 240, 1, 'iron', 'long', 5389, -2], ['dtl', 30, 1, 'driver', 'short', 641, 0], ['dtl', 60, 1, 'driver', 'short', 873, 0], ['fo', 60, 1, 'iron', 'long', 5512, 0],
  // pass 2 takes the strongest winner over all candidate frames: with the first passing frame deciding, a weak
  // chain at a nearer frame was confirmed instead of the ball (5491 at -2)
  ['fo', 30, 8, 'iron', 'short', 5491, -2]];
// flights where a removed rule turned an abstain or a ball into a club or wrong accept: the universal lead and
// outrun (5389), D3's min step (5439, the ball not eligible), the exit evidence in the arrival choice (5127)
const PINS = [scene('fo', 240, 1, 'iron', 'long', 5389), scene('fo', 30, 1, 'driver', 'short', 5439), scene('fo', 30, 8, 'iron', 'long', 5127)];
const JOBS = [
  ...MATRIX.map((s, i) => ({ id: `m${i}`, scene: s })),
  ...CONTROLS.map((s, i) => ({ id: `c${i}`, scene: s })),
  ...PINS.map((s, i) => ({ id: `p${i}`, scene: s })),
  // flat face-on launches (8-12°): no launch-angle gate
  ...[[8, 'iron', 5248], [10, 'driver', 5548], [12, 'iron', 5450]].map(([deg, club, seed]) => ({ id: `flat${deg}`, scene: scene('fo', 240, 1, club, 'short', seed, { launchDeg: deg }) })),
  // streak-only launch: a long-exposure face-on ball that never segments as blobs
  { id: 'streak', scene: scene('fo', 240, 1, 'iron', 'long', 5288) }, { id: 'streakOff', scene: scene('fo', 240, 1, 'iron', 'long', 5288), streak: false },
  { id: 'streak2', scene: scene('fo', 240, 1, 'driver', 'long', 5588) },
  // glove takeaway: a hypothesis anchored at the glove when the hands start the backswing
  { id: 'glove', scene: scene('dtl', 60, 1, 'iron', 'short', 68, { glove: 'white' }), anchor: 'glove' },
  // two balls, one hit: the hit ball launches, the parked one does not
  { id: 'two', scene: scene('fo', 240, 1, 'iron', 'short', 5349, { extraBall: { x: -0.25, z: -0.15 } }) },
  { id: 'twoExtra', scene: scene('fo', 240, 1, 'iron', 'short', 5349, { extraBall: { x: -0.25, z: -0.15 } }), anchor: 'extra' },
  // pre-existing movers: a ball-sized object crossing the address at impact on a straight line, ball hidden
  ...[[15, 120], [60, 100], [40, 60]].map(([speed, angleDeg]) => ({ id: `mover${speed}`, scene: scene('dtl', 60, 1, 'iron', 'short', 90068, { ball: 'hidden', mover: { speed, angleDeg, before: 6, after: 30 } }) })),
  // null launches decide: the same accepted launch, with a fake anchor or a fake impact reporting S_null
  { id: 'nullA', scene: scene('dtl', 60, 1, 'iron', 'short', 68), nullBoost: 'anchor', boostS: 1000 },
  { id: 'nullT', scene: scene('dtl', 60, 1, 'iron', 'short', 68), nullBoost: 'impact', boostS: 1000 },
  { id: 'nullBase', scene: scene('dtl', 60, 1, 'iron', 'short', 68) },
  // practice swing over a ball that never moves
  { id: 'whiff', scene: scene('dtl', 60, 1, 'iron', 'short', 270, { ball: 'stays' }) },
  // single sighting (real-time face-on 30 fps, one frame before the exit): off by default, guarded when enabled
  { id: 'single', scene: scene('fo', 30, 1, 'iron', 'short', 5442) },
  { id: 'singleOn', scene: scene('fo', 30, 1, 'iron', 'short', 5442), params: { launch: { singleSample: { enabled: true } } } },
  { id: 'singleGuard', scene: scene('fo', 30, 1, 'iron', 'short', 5442), params: { launch: { singleSample: { enabled: true, minZ: 99 } } } },
  { id: 'singleHidden', scene: scene('fo', 30, 1, 'iron', 'short', 95442, { ball: 'hidden' }), params: { launch: { singleSample: { enabled: true } } } },
  ...(ffmpegOk ? [{ id: 'x264', scene: scene('dtl', 60, 1, 'iron', 'short', 169), encode: { crf: 23 } }] : []),
  // impact timing (checker gap 6): the coarse k_last 1-2 frames early or late. Scenes the single-k_last search lost
  // at some shift (tune matrix), controls it confirmed as the club at a shift, and the tolerance mutation
  ...TIMING.flatMap(([v, f, t, c, e, sd], i) => [-2, -1, 1, 2].map(sh => ({ id: `tm${i}${sh}`, scene: scene(v, f, t, c, e, sd), shift: sh }))),
  ...TIMING_CTL.map(([v, f, t, c, e, sd, sh], i) => ({ id: `tc${i}`, scene: scene(v, f, t, c, e, sd, { ball: 'hidden' }), shift: sh })),
  ...TIMING.map(([v, f, t, c, e, sd], i) => ({ id: `tn${i}`, scene: scene(v, f, t, c, e, sd), shift: -2, params: { impact: { timingTolFrames: 0 } } })),
  ...CHAIN_CLUB.map(([v, f, t, c, e, sd, sh], i) => ({ id: `cc${i}`, scene: scene(v, f, t, c, e, sd), shift: sh }))
];
let pool = null;
const results = () => (pool ??= runScenes(JOBS));
const get = async id => { const r = (await results()).get(id); assert.ok(r, `no result for ${id}`); assert.equal(r.error, undefined, r.error); return r; };
const confusion = rs => { const c = { ball: 0, club: 0, wrong: 0, abstain: 0 }; for (const r of rs) c[r.cls]++; return c; };

/* ------------------------------------------------------------------ scenes */

test('scene matrix: every eligible ball accepted on the ball, no club or wrong accept; decisions are valid', async () => {
  const rs = await Promise.all(MATRIX.map((_, i) => get(`m${i}`)));
  const el = rs.filter(r => r.eligible), c = confusion(rs);
  assert.equal(el.length, rs.length, 'matrix scenes are ball-eligible');
  assert.ok(el.filter(r => r.cls === 'ball').length >= Math.ceil(0.9 * el.length), `ball accepted ${JSON.stringify(c)}: ${rs.map(r => `${r.id}:${r.cls}/${r.reason}`).join(' ')}`);
  assert.equal(c.club, 0); assert.equal(c.wrong, 0);
  for (const r of rs) {
    assert.deepEqual(r.errors, [], r.id);
    if (r.accepted) assert.ok(r.margin >= 0 && r.S >= 1.15 * Math.max(0, ...r.Snull) + 1 - 1e-9, `${r.id} null margin`);
    assert.equal(r.Snull.length, r.accepted ? 4 : r.Snull.length);  // two fake anchors + two fake impact times
  }
});

test('invisible-ball control: no confirmed launch (>= 95%), the club never confirmed', async () => {
  const rs = await Promise.all(CONTROLS.map((_, i) => get(`c${i}`)));
  const c = confusion(rs);
  assert.ok(c.abstain >= Math.ceil(0.95 * rs.length), `controls ${JSON.stringify(c)}: ${rs.filter(r => r.accepted).map(r => `${r.id}:${r.cls}`).join(' ')}`);
  for (const r of rs) assert.deepEqual(r.errors, [], r.id);
});

test('pre-existing mover and precursor: an object already moving through the address at impact is not a launch', async () => {
  for (const id of ['mover15', 'mover60', 'mover40']) {
    const r = await get(id);
    assert.equal(r.accepted, false, `${id} accepted (${r.cls})`);
  }
});

test('flat face-on launches (8-12°) are accepted: no launch-angle gate', async () => {
  for (const deg of [8, 10, 12]) {
    const r = await get(`flat${deg}`);
    assert.equal(r.cls, 'ball', `${deg}° ${r.reason}`);
  }
});

test('streak-only launch: found by the ray transform when no blob chain passes, missed without it', async () => {
  const on = await get('streak'), off = await get('streakOff'), on2 = await get('streak2');
  assert.equal(on.cls, 'ball', on.reason);
  assert.equal(on.mode, 'streak');
  assert.equal(on.streak, true);
  assert.equal(off.accepted, false);
  assert.equal(on2.cls, 'ball', on2.reason);  // a driver streak the monotone DP chains
  assert.equal(on2.mode, 'streak');
});

test('rule pins: launches no club rule may let through as a club or wrong accept', async () => {
  for (let i = 0; i < PINS.length; i++) {
    const r = await get(`p${i}`);
    assert.ok(r.cls === 'ball' || r.cls === 'abstain', `p${i} ${r.cls}`);
  }
  assert.equal((await get('p2')).cls, 'ball');  // 5127: the head's exit picks its arrival over the hands
});

test('glove takeaway: a hypothesis at the glove leaving with the hands is rejected', async () => {
  const r = await get('glove');
  assert.equal(r.accepted, false, `glove accepted (${r.cls})`);
});

test('two balls, one hit: one launch, on the hit ball; the parked ball does not launch', async () => {
  const hit = await get('two'), parked = await get('twoExtra');
  assert.equal(hit.cls, 'ball', hit.reason);
  assert.equal(parked.accepted, false);
  assert.equal(parked.reason, 'no_launch');  // its address never empties
});

test('null launches decide: S must clear 1.15·max(S_null) + 1 at the fake anchors (±0.22·W) and fake impacts (12, 20 frames earlier)', async () => {
  const base = await get('nullBase'), a = await get('nullA'), t = await get('nullT');
  assert.equal(base.cls, 'ball', base.reason);
  for (const r of [a, t]) {
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'launch_not_confirmed');
    assert.ok(Math.abs(r.margin - (base.S - (1.15 * 1000 + 1))) < 1e-6, `margin ${r.margin}`);
  }
  assert.equal(a.Snull.filter(x => x === 1000).length, 2);  // both anchors
  assert.equal(t.Snull.filter(x => x === 1000).length, 2);  // both earlier impacts
  assert.deepEqual(base.anchors.map(q => +q.dx.toFixed(2)).sort(), [-0.22, 0.22]);
  assert.ok(base.anchors.every(q => q.dy === 0));
  assert.deepEqual(base.fakeK.sort((x, y) => x - y), [...PARAMS.launch.nulls.fakeImpactFrames].sort((x, y) => x - y));
});

test('practice swing over an unmoved ball: no launch', async () => {
  const r = await get('whiff');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'no_launch');
});

test('single-sample launches: off by default; enabled they need D2\'s guards; the control stays rejected', async () => {
  const off = await get('single'), on = await get('singleOn'), guard = await get('singleGuard'), ctl = await get('singleHidden');
  assert.equal(PARAMS.launch.singleSample.enabled, false);
  assert.equal(off.accepted, false);
  assert.equal(on.cls, 'ball', on.reason);
  assert.equal(on.single, true);
  assert.equal(guard.accepted, false);
  assert.equal(ctl.accepted, false);
});

test('x264 round trip (crf 23): the launch survives codec artifacts', { skip: !ffmpegOk && 'ffmpeg not found' }, async () => {
  const r = await get('x264');
  assert.equal(r.encoded, true);
  assert.equal(r.cls, 'ball', r.reason);
});

test('impact timing: with the coarse k_last 1-2 frames off the launch is confirmed on the ball, t0 inside the impact interval', async () => {
  const rs = await Promise.all(TIMING.flatMap((_, i) => [-2, -1, 1, 2].map(sh => get(`tm${i}${sh}`))));
  const bad = rs.filter(r => r.cls !== 'ball');
  assert.ok(bad.length <= 1, `not confirmed on the ball: ${bad.map(r => `${r.id}:${r.cls}/${r.reason}`).join(' ')}`);
  for (const r of rs) if (r.accepted) {
    assert.equal(r.t0In, true, `${r.id}: t0 outside the interval or not before the first sample`);
    assert.ok(Math.abs(r.dt0) < 1, `${r.id}: t0 ${r.dt0.toFixed(2)} frames from the impact`);
    assert.deepEqual(r.errors, [], r.id);
  }
  assert.ok(rs.some(r => r.pass === 2), 'some are found by pass 2 (another candidate frame)');
});

test('impact timing: invisible-ball controls the shifted single-k_last search confirmed as the club stay unconfirmed', async () => {
  const rs = await Promise.all(TIMING_CTL.map((_, i) => get(`tc${i}`)));
  assert.deepEqual(rs.map(r => r.cls), rs.map(() => 'abstain'), rs.map(r => `${r.id}:${r.cls}/${r.reason}`).join(' '));
});

test('impact timing: a chain meets the head that arrived at its own t0 only when the single-k_last search found none; pass 2 takes the strongest frame', async () => {
  const rs = await Promise.all(CHAIN_CLUB.map((_, i) => get(`cc${i}`)));
  assert.deepEqual(rs.map(r => r.cls), rs.map(() => 'ball'), rs.map(r => `${r.id}:${r.cls}/${r.reason}`).join(' '));
});

test('impact timing: without the timing tolerance (interval of the coarse frames only) k_last 2 frames early loses the launches', async () => {
  const rs = await Promise.all(TIMING.map((_, i) => get(`tn${i}`))), on = await Promise.all(TIMING.map((_, i) => get(`tm${i}-2`)));
  assert.ok(rs.filter(r => r.cls === 'ball').length < on.filter(r => r.cls === 'ball').length, `tol 0: ${rs.map(r => r.cls)} vs tol 2: ${on.map(r => r.cls)}`);
});

/* ------------------------------------------------------------------ rules */

test('processing pool: the integer that brings d0 nearest to roiD0Px (8 px) in ratio', () => {
  // 11.3-12 px balls (1080×1920) went to pool 1 under round(d0/8): a 4× larger grid at d0p ≈ 12
  assert.equal(launchPool(5), 1); assert.equal(launchPool(11.2), 1); assert.equal(launchPool(11.4), 2); assert.equal(launchPool(11.9), 2);
  assert.equal(launchPool(19.5), 2); assert.equal(launchPool(19.7), 3); assert.equal(launchPool(27.6), 3); assert.equal(launchPool(27.8), 4);
  for (const d0 of [6, 9, 11.4, 15, 21, 33]) { const p = launchPool(d0), r = x => Math.abs(Math.log(d0 / x / 8)); assert.ok(r(p) <= r(p + 1) && (p === 1 || r(p) <= r(p - 1)), `d0 ${d0}`); }
});

test('null launches: accept only when S >= 1.15·max(S_null) + 1', () => {
  const N = PARAMS.launch.nulls;
  assert.equal(N.factor, 1.15); assert.equal(N.offset, 1);
  assert.equal(acceptLaunch(1.15 * 10 + 1, [10, 2, 0, 3]).accepted, true);
  assert.equal(acceptLaunch(1.15 * 10 + 1 - 1e-6, [10, 2, 0, 3]).accepted, false);
  assert.equal(acceptLaunch(1, []).accepted, true);
  assert.equal(acceptLaunch(0.99, [0, 0]).accepted, false);
  assert.ok(Math.abs(acceptLaunch(20, [10, 4]).margin - (20 - 12.5)) < 1e-9);
});

const LAW_A = { x: 100, y: 500 }, LAW_D0 = 10, FPS = 60, T0 = 1, DIR = { x: 0.6, y: -0.8 };
const lawCtx = { fps: FPS, t0Range: [T0 - 0.5 / FPS, T0 + 0.5 / FPS], cRange: [-0.05, 0.6], params: PARAMS };
const lawSamples = (sOf, wOf) => [1, 2, 3, 4, 5, 6].map(k => { const tau = k - 0.3, s = sOf(tau); return { t: T0 + tau / FPS, x: LAW_A.x + DIR.x * s, y: LAW_A.y + DIR.y * s, w: wOf(tau) }; });

test('projective-line law: s = vτ/(1+cτ) and w = d0/(1+cτ) share ONE c', () => {
  const v = 40, c = 0.2;
  const law = fitProjectiveLine(lawSamples(t => v * t / (1 + c * t), t => LAW_D0 / (1 + c * t)), { address: LAW_A, d0: LAW_D0 }, lawCtx);
  assert.ok(law.ok);
  assert.ok(Math.abs(law.c - c) < 0.02 && Math.abs(law.v - v) < 1 && Math.abs(law.t0 - T0) * FPS < 0.05, JSON.stringify({ v: law.v, c: law.c }));
  // a decelerating path whose width does not shrink (converging clutter) fails the size law
  const flat = fitProjectiveLine(lawSamples(t => v * t / (1 + c * t), () => LAW_D0), { address: LAW_A, d0: LAW_D0 }, lawCtx);
  assert.equal(flat.sizeOk, false); assert.equal(flat.ok, false);
  // and so does a shrinking width on a constant-velocity path
  const cv = fitProjectiveLine(lawSamples(t => 30 * t, t => LAW_D0 / (1 + 0.3 * t)), { address: LAW_A, d0: LAW_D0 }, lawCtx);
  assert.equal(cv.sizeOk, false); assert.equal(cv.ok, false);
  // without widths the same path is a clean c = 0 line
  assert.equal(fitProjectiveLine(lawSamples(t => 30 * t, () => null), { address: LAW_A, d0: LAW_D0 }, lawCtx).ok, true);
});

test('streak-axis check (f7): a streaky chain must blur along its own line', () => {
  const law = fitProjectiveLine(lawSamples(t => 40 * t, () => null), { address: LAW_A, d0: LAW_D0 }, lawCtx);
  const th = Math.atan2(DIR.y, DIR.x), mk = da => ({ law, samples: law.s.map(() => ({ major: 30, minor: 10, angle: th + da, w: 10 })) });
  const ctx = { params: PARAMS, fps: FPS, pool: 1, addressFlux: 0 };
  assert.ok(chainFeatures(mk(0), { d0: LAW_D0, tLast: T0 }, null, ctx).f7 <= 1);
  assert.ok(chainFeatures(mk(25 * Math.PI / 180), { d0: LAW_D0, tLast: T0 }, null, ctx).f7 > 1);
  // round blobs are not streaks: no axis to check
  const round = { law, samples: law.s.map(() => ({ major: 10, minor: 9.5, angle: th + 1, w: 10 })) };
  assert.equal(chainFeatures(round, { d0: LAW_D0, tLast: T0 }, null, ctx).f7, 0);
});

// Synthetic club evidence: a head arriving at A along +x at 40 px/frame, impact at 100.5, then the head at
// 0.75× along a slow upward turn and the ball leading it 1.5× farther on a 20° line (both seen by club evidence).
const CA = { x: 300, y: 600 }, CD0 = 10, TI = 100.5;
const headAt = k => k <= TI ? { x: CA.x + 40 * (k - TI), y: CA.y + 4 } : { x: CA.x + 30 * (k - TI) * Math.cos(0.17), y: CA.y - 30 * (k - TI) * Math.sin(0.17) };
const ballAt = k => ({ x: CA.x + 45 * (k - TI) * Math.cos(0.35), y: CA.y - 45 * (k - TI) * Math.sin(0.35) });
function clubPeaks({ ball = true, head = true, still = [] } = {}) {
  const m = new Map();
  for (let k = 95; k <= 112; k++) {
    const pk = [];
    if (k <= 100 || head) pk.push({ ...headAt(k), z: 12 });
    if (k > TI && ball) pk.push({ ...ballAt(k), z: 10 });
    for (const s of still) pk.push({ ...s, z: 15 });
    m.set(k, pk);
  }
  return m;
}
const clubCtx = { T: [99.5, 101], kEnd: 112, kLast: 100, tOf: k => k / 60, params: PARAMS };

test('club tracker: the arrival lands at the impact and the trailing body after it is the head, not the ball', () => {
  const club = trackClub(clubPeaks(), { address: CA, d0: CD0 }, clubCtx);
  assert.ok(club, 'club chain');
  assert.ok(Math.abs(club.T - TI) < 0.25, `T ${club.T}`);
  for (let k = 103; k <= 108; k++) {
    const h = headAt(k), b = ballAt(k);
    assert.ok(clubExplained(h.x, h.y, k, club, CD0), `head explained at ${k}`);
    assert.ok(!clubExplained(b.x, b.y, k, club, CD0), `ball not explained at ${k}`);
  }
  assert.ok(club.measuredPost >= 6);
  // the invisible-ball control: the head alone is still tracked through impact
  const lone = trackClub(clubPeaks({ ball: false }), { address: CA, d0: CD0 }, clubCtx);
  for (let k = 103; k <= 108; k++) { const h = headAt(k); assert.ok(clubExplained(h.x, h.y, k, lone, CD0), `lone head at ${k}`); }
});

test('club tracker: static residuals lined up with the address are not an arrival', () => {
  // three strong static peaks on a line through A, one per arrival frame, and no moving head
  const still = [{ x: CA.x - 150, y: CA.y - 150 }, { x: CA.x - 100, y: CA.y - 100 }, { x: CA.x - 50, y: CA.y - 50 }];
  const m = new Map();
  for (let k = 95; k <= 112; k++) m.set(k, still.map(s => ({ ...s, z: 15 })));
  assert.equal(trackClub(m, { address: CA, d0: CD0 }, clubCtx), null);
});

test('club-explained exclusion: inside the head extent (0.85·d0 + 1.5 px, + 0.06·distance unmeasured)', () => {
  const club = trackClub(clubPeaks(), { address: CA, d0: CD0 }, clubCtx), pt = clubAt(club, 104);
  const ext = 0.85 * CD0 + 1.5 + (pt.measured ? 0 : 0.06 * Math.hypot(pt.x - CA.x, pt.y - CA.y));
  assert.ok(clubExplained(pt.x + 0.95 * ext, pt.y, 104, club, CD0));
  assert.ok(!clubExplained(pt.x + 1.05 * ext, pt.y, 104, club, CD0));
});

test('outrun the club: the ball leads the head (E2b), D2\'s first-support rule, arrival continuation', () => {
  const club = trackClub(clubPeaks(), { address: CA, d0: CD0 }, clubCtx);
  const chainOf = (f, k0 = 102) => { const s = []; for (let k = k0; k <= k0 + 4; k++) s.push({ k, ...f(k) }); const d = { x: s[4].x - s[0].x, y: s[4].y - s[0].y }, L = Math.hypot(d.x, d.y); return { dir: { x: d.x / L, y: d.y / L }, v: L / 4, samples: s }; };
  assert.equal(outrunsClub(chainOf(ballAt), club), true);
  // a body that moves with the head (ratio ~1) fails the universal lead
  assert.equal(outrunsClub(chainOf(k => ({ x: headAt(k).x + 2, y: headAt(k).y - 3 })), club), false);
  // along the head's direction, a first support at 1.05x the head's distance is not leading (D2), even when the
  // later ones lead
  const slow = k => { const h = headAt(k), r = k === 102 ? 1.05 : 1.4; return { x: CA.x + r * (h.x - CA.x), y: CA.y + r * (h.y - CA.y) }; };
  assert.equal(outrunsClub(chainOf(slow), club), false);
  const fine = k => { const h = headAt(k), r = k === 102 ? 1.15 : 1.4; return { x: CA.x + r * (h.x - CA.x), y: CA.y + r * (h.y - CA.y) }; };
  assert.equal(outrunsClub(chainOf(fine), club), true);
  // D2's rule on its own: the head unmeasured at the first support (predicted there), measured later
  const gap = { ...club, points: club.points.map(p => (p.index === 102 ? { ...p, measured: false } : p)) };
  assert.equal(outrunsClub(chainOf(slow), gap), false);
  assert.equal(outrunsClub(chainOf(fine), gap), true);
  // without a measured exit: a chain along the arrival must beat 1.1 × 0.75 × the arrival speed
  const arrivalOnly = { ...club, dir: null, measuredPost: 0, points: club.points.map(p => (p.index > 100 ? { ...p, measured: false } : p)) };
  assert.equal(outrunsClub({ dir: { x: 1, y: 0 }, v: 0.7 * 40, samples: [{ k: 102, x: CA.x + 40, y: CA.y }] }, arrivalOnly), false);
  assert.equal(outrunsClub({ dir: { x: 1, y: 0 }, v: 1.2 * 40, samples: [{ k: 102, x: CA.x + 60, y: CA.y }] }, arrivalOnly), true);
});

test('outrun exemption: a chain receding from the camera, clear of the measured head, is not out-run by a head sweeping across', () => {
  // real down-the-line clip: the ball recedes (c 0.51/frame) 70 px from the address while the head sweeps 256 px up-left
  const recedesClear = (law, samples, club, d0 = 13) => LaunchConfirmer.prototype.recedesClear.call({ P: PARAMS, d0, fps: 30 }, law, samples, club);
  const head = [[50, 520.7, 886], [51, 450.7, 680], [52, 404.3, 572.7], [53, 357.7, 475.9], [54, 311.3, 388.6], [55, 265.3, 310.1], [56, 220.2, 239.7]];
  const club = { points: head.map(([index, x, y]) => ({ index, x, y, measured: true })) };
  const ball = [[50, 655.4, 1029.7], [51, 650.2, 988.9], [52, 647, 964.8], [53, 645.9, 951], [54, 643.7, 939.2], [55, 642, 931.6], [56, 640.7, 925.5]].map(([k, x, y]) => ({ k, x, y }));
  assert.equal(recedesClear({ c: 0.51 }, ball, club), true);
  assert.equal(recedesClear({ c: 0.1 }, ball, club), false, 'crossing the image: the image lead applies');
  assert.equal(recedesClear({ c: 0.51 }, ball.slice(0, 3), club), false, 'too few samples');
  const riding = head.map(([k, x, y]) => ({ k, x: x + 20, y: y + 15 }));
  assert.equal(recedesClear({ c: 0.51 }, riding, club), false, 'a part riding near the head');
  assert.equal(recedesClear({ c: 0.51 }, ball, null), false, 'no club, no exemption needed');
});

test('rigid attachment: a ferrule-like peak riding on the head is the club; the separating ball is not', () => {
  const club = trackClub(clubPeaks(), { address: CA, d0: CD0 }, clubCtx);
  const ride = [103, 104, 105, 106].map(k => ({ k, x: headAt(k).x - 2, y: headAt(k).y - 15 }));
  assert.equal(attachedToClub(ride, club, CD0), true);
  assert.equal(attachedToClub([103, 104, 105, 106].map(k => ({ k, ...ballAt(k) })), club, CD0), false);
});

test('single-sample guards (D2): z, a club chain, the distance ratio and the loft cone', () => {
  const club = trackClub(clubPeaks(), { address: CA, d0: CD0 }, clubCtx), k = 103, b = ballAt(k);
  assert.equal(singleSampleOk({ k, ...b, z: 9 }, club), true);
  assert.equal(singleSampleOk({ k, ...b, z: 5 }, club), false);                              // z < 7
  assert.equal(singleSampleOk({ k, ...b, z: 9 }, null), false);                              // no club chain
  const h = clubAt(club, k), near = { x: CA.x + 1.02 * (h.x - CA.x), y: CA.y + 1.02 * (h.y - CA.y) };
  assert.equal(singleSampleOk({ k, ...near, z: 9 }, club), false);                           // d_ball/d_club < 1.1
  const r = Math.hypot(b.x - CA.x, b.y - CA.y), down = { x: CA.x + r * Math.cos(-0.5), y: CA.y - r * Math.sin(-0.5) };
  assert.equal(singleSampleOk({ k, ...down, z: 9 }, club), false);                           // below the loft cone
});

test('address hole and local CFAR: the vacated address is masked, clutter energy lowers z', () => {
  const w = 160, h = 120, grid = { bx: 0, by: 0, p: 1, w, h }, d0p = 8, A = { x: 40, y: 60 };
  let seed = 7;
  const noisy = () => { const f = new Uint8Array(w * h); for (let i = 0; i < f.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; f[i] = 80 + ((seed >>> 16) % 7) - 3; } return f; };
  const disc = (Y, cx, cy, r, v) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) Y[y * w + x] = v; };
  // reference with the bright ball at the address; after impact the address holds a bright club residual
  const refFrames = [0, 1, 2, 3, 4].map(() => { const f = noisy(); disc(f, A.x, A.y, 4, 200); return f; });
  const ref = buildReference(refFrames, grid, A, d0p, 1);
  const at = (pk, x, y) => pk.find(q => Math.hypot(q.x - x, q.y - y) < 3);
  const Y = noisy(); disc(Y, A.x, A.y + 5, 5, 230);
  assert.ok(at(ballEvidence(Y, ref, grid, d0p, makeScratch(w, h), PARAMS).peaks, A.x, A.y + 5), 'residual at the address without the hole');
  assert.ok(!at(ballEvidence(Y, ref, grid, d0p, makeScratch(w, h), PARAMS, { hole: { x: A.x, y: A.y, r: PARAMS.launch.evidence.holeD0 * d0p } }).peaks, A.x, A.y + 5), 'masked by the hole');
  // two identical balls, one inside golfer-like clutter (residual stripes): local CFAR scores it lower
  const Z = noisy(); disc(Z, 100, 30, 4, 200); disc(Z, 120, 85, 4, 200);
  for (let y = 60; y < 110; y++) for (let x = 95; x < 145; x++) if (Math.hypot(x - 120, y - 85) > 10 && ((x >> 2) & 1)) Z[y * w + x] = 200;
  const pk = ballEvidence(Z, ref, grid, d0p, makeScratch(w, h), PARAMS).peaks, quiet = at(pk, 100, 30), busy = at(pk, 120, 85);
  assert.ok(quiet && (!busy || busy.z < 0.7 * quiet.z), `quiet ${quiet?.z} busy ${busy?.z}`);
});
