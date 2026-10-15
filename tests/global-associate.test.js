import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateFlight,
  pathScore,
  launchPrior,
  framesFromTracks,
  launchesFromHypotheses,
  mergeAssocFrames,
  toRendererResult
} from '../dist/global-associate.js';

function ballFlight(opts = {}) {
  const startT = opts.startT ?? 4.43;
  const x0 = opts.x0 ?? 400;
  const y0 = opts.y0 ?? 900;
  const n = opts.n ?? 20;
  const fps = opts.fps ?? 30;
  const ballSize = opts.ballSize ?? 120;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = startT + i / fps;
    const pxSize = Math.max(8, ballSize - i * 4);
    frames.push({
      t,
      f: Math.round(t * fps),
      candidates: [{
        t,
        x: x0 + i * 0.4,
        y: y0 - i * 9,
        size: pxSize,
        quality: 0.9,
        score: 16,
        id: `ball:${i}`
      }]
    });
  }
  return frames;
}

test('pathScore does not systematically favor a longer clutter track', () => {
  const short = pathScore({
    launch: 30, evidenceSum: 40, motionSum: 4, gapSum: 0, identityPenalty: 0, nObs: 8
  });
  const longClutter = pathScore({
    launch: 8, evidenceSum: 90, motionSum: 50, gapSum: 2, identityPenalty: 6, nObs: 40
  });
  assert.ok(short > longClutter, `short=${short} long=${longClutter}`);
});

test('large address launch prior beats tiny clothing seed', () => {
  const ball = launchPrior({ sourceSize: 180, sourceQuality: 0.9, y: 900 }, 1280);
  const cloth = launchPrior({ sourceSize: 6, sourceQuality: 0.95, y: 860 }, 1280);
  assert.ok(ball > cloth + 10, `ball=${ball} cloth=${cloth}`);
});

test('selects real ball launch over earlier longer clothing creep', () => {
  // Clothing starts at 3.47s with many weak points; ball at 4.43s.
  const frames = [];
  for (let i = 0; i < 50; i++) {
    const t = 3.47 + i / 30;
    const cands = [];
    if (i < 40) {
      cands.push({
        t, x: 80 + i * 1.1, y: 860 - i * 12,
        size: 3, quality: 0.92, score: 14, id: `cloth:${i}`
      });
    }
    const bi = i - 29; // ball starts ~4.43
    if (bi >= 0 && bi < 18) {
      cands.push({
        t, x: 410 + bi * 0.3, y: 890 - bi * 10,
        size: Math.max(20, 160 - bi * 6), quality: 0.9, score: 17, id: `ball:${bi}`
      });
    }
    frames.push({ t, f: Math.round(t * 30), candidates: cands });
  }
  const launches = [
    { id: 'cloth', t: 3.47, x: 80, y: 860, sourceSize: 8, sourceQuality: 0.92 },
    { id: 'ball', t: 4.43, x: 410, y: 890, sourceSize: 160, sourceQuality: 0.9 }
  ];
  const result = associateFlight({ frames, launches, imageHeight: 1280, nullMargin: 1.5 });
  assert.notEqual(result.status, 'no_reliable_track');
  assert.equal(result.selectedLaunchId, 'ball');
  assert.ok(result.points[0].t >= 4.3, `start t=${result.points[0].t}`);
});

test('airplane crossing after ball fades does not steal identity', () => {
  const frames = ballFlight({ startT: 2.1, x0: 360, y0: 1000, n: 16, ballSize: 100 });
  // After ball ends, airplane continues with many bright points in another region.
  const lastBallT = frames.at(-1).t;
  for (let i = 0; i < 25; i++) {
    const t = lastBallT + 0.05 + i / 30;
    frames.push({
      t,
      f: Math.round(t * 30),
      candidates: [{
        t, x: 200 + i * 8, y: 200 + i * 0.5,
        size: 40, quality: 0.95, score: 22, id: `plane:${i}`
      }]
    });
  }
  const launches = [
    { id: 'ball', t: 2.1, x: 360, y: 1000, sourceSize: 100, sourceQuality: 0.9 }
  ];
  const result = associateFlight({ frames, launches, imageHeight: 1280, maxMiss: 6, nullMargin: 1.5 });
  assert.ok(result.points.length >= 8);
  assert.ok(result.points.at(-1).t <= lastBallT + 0.35, `tail t=${result.points.at(-1).t}`);
  assert.ok(!result.points.some(p => p.y < 350), 'should not jump onto airplane');
});

test('abstains when only sparse clutter exists', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const t = i / 30;
    frames.push({
      t,
      candidates: [{
        t, x: 100 + (i % 5) * 30, y: 100 + (i % 7) * 20,
        size: 4, quality: 0.7, score: 5, id: `noise:${i}`
      }]
    });
  }
  const result = associateFlight({
    frames,
    launches: [{ id: 'weak', t: 0.1, x: 100, y: 100, sourceSize: 4, sourceQuality: 0.7 }],
    minObs: 6,
    nullMargin: 3
  });
  assert.equal(result.status, 'no_reliable_track');
  assert.equal(result.points.length, 0);
});

test('leftward and rightward launches both associate', () => {
  for (const dir of [-1, 1]) {
    const frames = [];
    for (let i = 0; i < 15; i++) {
      const t = 1 + i / 30;
      frames.push({
        t,
        candidates: [{
          t, x: 400 + dir * i * 3, y: 900 - i * 8,
          size: 40, quality: 0.88, score: 15, id: `p:${i}`
        }]
      });
    }
    const result = associateFlight({
      frames,
      launches: [{ id: 'L', t: 1, x: 400, y: 900, sourceSize: 40, sourceQuality: 0.88 }]
    });
    assert.ok(result.points.length >= 8, `dir=${dir}`);
  }
});

test('framesFromTracks + launchesFromHypotheses round-trip helpers', () => {
  const tracks = [{
    launchId: 'L1',
    sourceSize: 50,
    points: Array.from({ length: 8 }, (_, i) => ({
      t: 1 + i / 30, f: 30 + i, x: 10 + i, y: 120 - i * 12, size: 50 - i, quality: 0.9
    }))
  }];
  const frames = framesFromTracks(tracks);
  assert.equal(frames.length, 8);
  const launches = launchesFromHypotheses([], tracks);
  assert.equal(launches[0].id, 'L1');
  assert.ok(launches[0].vy < 0);
  // Hypotheses of one ball (same spot, impact a frame apart) come back as one launch.
  const twins = launchesFromHypotheses([
    { id: 'L1', impactT: 1, anchorX: 10, anchorY: 120, sourceSize: 50, confidence: 9 },
    { id: 'L2', impactT: 1 + 1 / 30, anchorX: 10, anchorY: 120, sourceSize: 50, confidence: 8 }
  ], tracks);
  assert.equal(twins.length, 1);
  assert.deepEqual(twins[0].aliases, ['L1', 'L2']);
  const rendered = toRendererResult(
    associateFlight({ frames, launches, minObs: 2, nullMargin: 0.5 }),
    { width: 100, height: 200, camera: [] }
  );
  assert.ok(rendered.points.length >= 2);
  assert.ok(rendered.points[0].x <= 1);
  assert.equal(rendered.engine, 'global-v2');
});

test('associates a fast ball launch that would fail a cold-start accel gate', () => {
  // ~80 px/frame climb ≈ real analysis-scale launch; seed starts near-stationary.
  const frames = [];
  for (let i = 0; i < 14; i++) {
    const t = 2 + i / 30;
    frames.push({
      t,
      f: Math.round(t * 30),
      candidates: [{
        t, x: 420 + i * 2, y: 980 - i * 80,
        size: Math.max(12, 140 - i * 8), quality: 0.9, score: 18, id: `fast:${i}`
      }]
    });
  }
  const result = associateFlight({
    frames,
    launches: [{ id: 'ball', t: 2, x: 420, y: 980, sourceSize: 140, sourceQuality: 0.9 }],
    imageHeight: 1280,
    nullMargin: 1.5
  });
  assert.notEqual(result.status, 'no_reliable_track');
  assert.ok(result.points.length >= 8, `n=${result.points.length}`);
  assert.ok(result.points.at(-1).y < 500, `end y=${result.points.at(-1).y}`);
});

test('mergeAssocFrames unions track observations into detector frames', () => {
  const merged = mergeAssocFrames(
    [{ t: 1, f: 30, candidates: [{ x: 10, y: 10, id: 'a' }] }],
    [{ t: 1, f: 30, candidates: [{ x: 50, y: 50, id: 'b' }] }, { t: 1.1, f: 33, candidates: [{ x: 55, y: 40, id: 'c' }] }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].candidates.length, 2);
});

// ---- U10 safety rules. Candidate streams mimic MotionTracker's frameLog (720x1280 analysis px, 30 Hz). ----
import {
  LENGTH_CAP,
  mergeLaunches,
  labelStatic,
  labelMovers,
  trimChangePoint,
  flightEvidence
} from '../dist/global-associate.js';

const OPTS = { imageWidth: 720, imageHeight: 1280, beamWidth: 28, maxMiss: 8, minObs: 5, nullMargin: 2.2 };
const emptyFrames = (n, fps = 30) => Array.from({ length: n }, (_, i) => ({ t: i / fps, f: i, candidates: [] }));
const cand = (t, x, y, size, quality = 0.9, id = '') => ({ t, x, y, size, quality, score: quality * 18 + Math.min(8, Math.sqrt(size)), id });
// Ballistic screen path in px/frame for frames impact+1 .. impact+n.
function ballPath({ impact = 30, x0 = 400, y0 = 900, vx = 3, vy = -25, g = 0.55, drag = 0.03, n = 40, size0 = 40 } = {}) {
  const out = []; let x = x0, y = y0, ux = vx, uy = vy;
  for (let k = 1; k <= n; k++) {
    x += ux; y += uy; uy += g; ux *= 1 - drag; uy *= 1 - drag;
    out.push({ i: impact + k, t: (impact + k) / 30, x, y, size: Math.max(3, Math.round(size0 * Math.exp(-k / 12))) });
  }
  return out;
}
function launchScene({ frames: n = 120, impact = 30, path = {}, size = 40 } = {}) {
  const frames = emptyFrames(n);
  for (let i = 0; i <= impact; i++) frames[i].candidates.push(cand(i / 30, 400, 900, size, 0.9, `addr${i}`));
  const flight = ballPath({ impact, size0: size, ...path });
  for (const p of flight) if (frames[p.i]) frames[p.i].candidates.push(cand(p.t, p.x, p.y, Math.max(3, p.size), 0.9, `ball${p.i}`));
  return { frames, flight, launch: { id: 'ball', t: impact / 30, x: 400, y: 900, sourceSize: size, sourceQuality: 0.9 } };
}
const ids = (r, prefix) => r.points.filter(p => String(p.candidateId).startsWith(prefix)).length;

test('pathScore length reward saturates: more of the same evidence adds nothing past LENGTH_CAP', () => {
  const at = n => pathScore({ launch: 20, evidenceSum: 4.4 * n, motionSum: n, gapSum: 0, identityPenalty: 0, nObs: n });
  assert.ok(at(LENGTH_CAP) > at(5), 'short paths still earn length');
  assert.equal(at(LENGTH_CAP * 10), at(LENGTH_CAP));
  assert.equal(at(200), at(LENGTH_CAP));
});

test('the trace starts at the launch sample, never on the parked address ball', () => {
  const { frames, launch, flight } = launchScene();
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.ok(Math.abs(r.points[0].t - launch.t) < 1e-9, `first point t=${r.points[0].t}`);
  assert.ok(r.points.every(p => p.t >= launch.t - 1e-9), 'no pre-impact points');
  assert.equal(r.points.filter(p => Math.hypot(p.x - 400, p.y - 900) < 1).length, 1, 'one anchor point');
  assert.equal(r.points[0].status, 'anchor');
  assert.equal(r.points.length, flight.length + 1);
});

test('a missing address ball gives an anchor at the launch, not a fake observation', () => {
  const { frames, launch } = launchScene();
  for (const f of frames) f.candidates = f.candidates.filter(c => !c.id.startsWith('addr'));
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.points[0].status, 'anchor');
  assert.equal(r.points.filter(p => String(p.candidateId).endsWith(':seed')).length, 0);
  assert.ok(Math.abs(r.points[0].t - launch.t) < 1e-9);
});

test('duplicate launch ids of one ball merge into one launch: no false ambiguous_launch', () => {
  const { frames, launch } = launchScene();
  const launches = [0, 1, 2].map(k => ({ ...launch, id: `L${k + 1}`, t: launch.t + k / 30, vx: 90, vy: -600 }));
  const r = associateFlight({ frames, launches, ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.equal(r.selectedLaunchId, 'L1');
  assert.ok(!r.reasonCodes.includes('ambiguous_launch'), JSON.stringify(r.reasonCodes));
  assert.ok(r.beams.every(b => b.launchId === 'L1'));
});

test('mergeLaunches keeps distinct anchors and later impacts apart', () => {
  const base = { t: 1, x: 400, y: 900, sourceSize: 30 };
  const merged = mergeLaunches([
    { ...base, id: 'A' }, { ...base, id: 'B', t: 1 + 2 / 30, x: 403, sourceSize: 40 },
    { ...base, id: 'C', x: 406 }, { ...base, id: 'D', t: 1.2 }
  ]);
  assert.deepEqual(merged.map(l => l.id), ['A', 'C', 'D']);
  assert.deepEqual(merged[0].aliases, ['A', 'B']);
  assert.equal(merged[0].t, 1);
  assert.equal(merged[0].sourceSize, 40);
});

test('a later real launch survives several earlier launches (reserved beam quota)', () => {
  // Four earlier objects at distinct anchors keep beams alive when the ball launches at f50.
  const frames = emptyFrames(120);
  const ws = [0, 1, 2, 3].map(k => ({ x: 200 + k * 9, y: 950, vy: -9 }));
  for (let i = 0; i < 120; i++) for (const w of ws) {
    const wl = i - 20;
    if (wl > 0) { w.x += 0.5; w.y += w.vy; w.vy = Math.min(-1, w.vy + 0.15); }
    if (wl <= 60) frames[i].candidates.push(cand(i / 30, w.x, w.y, wl > 0 ? Math.max(4, 9 - wl) : 9, 0.92, `W${i}`));
  }
  for (let i = 0; i <= 50; i++) frames[i].candidates.push(cand(i / 30, 470, 900, 20, 0.9, `B${i}`));
  for (const p of ballPath({ impact: 50, x0: 470, vx: 0.5, vy: -12, g: 0.3, drag: 0, size0: 20 })) frames[p.i].candidates.push(cand(p.t, p.x, p.y, Math.max(4, p.size), 0.9, `B${p.i}`));
  for (const f of frames) f.candidates.sort((a, b) => b.quality - a.quality);
  const launches = ws.map((w, k) => ({ id: `W${k}`, t: 20 / 30, x: 200 + k * 9, y: 950, sourceSize: 9, sourceQuality: 0.92, vx: 15, vy: -270 }));
  launches.push({ id: 'BALL', t: 50 / 30, x: 470, y: 900, sourceSize: 20, sourceQuality: 0.9, vx: 15, vy: -360 });
  const r = associateFlight({ frames, launches, ...OPTS });
  assert.equal(r.selectedLaunchId, 'BALL');
  assert.equal(r.points.length, 41);
  assert.equal(associateFlight({ frames, launches, ...OPTS, quota: 0 }).selectedLaunchId, 'W0', 'without the quota the ball is evicted');
});

test('labelStatic marks objects re-observed in place, not slow movers', () => {
  const frames = emptyFrames(40);
  frames.forEach((f, i) => {
    if (i % 4) f.candidates.push(cand(f.t, 100 + (i % 3) * 0.5, 100, 9, 0.9, 'speck'));  // 30 of 40 frames, ±0.5 px
    if (i < 8) f.candidates.push(cand(f.t, 300, 300, 9, 0.9, 'brief'));                   // only 8 frames: 7 repeats
    f.candidates.push(cand(f.t, 500 + i * 0.8, 500, 9, 0.9, 'mover'));                    // 0.8 px/frame
  });
  const s = labelStatic(frames);
  const tagged = id => frames.flatMap(f => f.candidates).filter(c => c.id === id);
  assert.ok(tagged('speck').every(c => s.has(c)));
  assert.ok(tagged('brief').every(c => !s.has(c)), 'seven repeats are not static');
  assert.ok(tagged('mover').every(c => !s.has(c)));
});

test('a static speck beside the path never extends the flight, and length cannot buy it', () => {
  for (const vy of [-9, -14]) {
    const { frames, launch, flight } = launchScene({ frames: 240, path: { vx: 2, vy, g: 0.25, drag: 0.01, n: 34 } });
    const s = flight[13];
    for (const f of frames) f.candidates.push(cand(f.t, s.x + 6, s.y, 20, 0.9, `static${f.f}`));
    const vx = 60, hinted = { ...launch, vx, vy: vy * 30 };
    // Static label alone (change point off) keeps the speck out.
    const r = associateFlight({ frames, launches: [hinted], ...OPTS, changePoint: false });
    assert.equal(ids(r, 'static'), 0, `vy=${vy}: static points ${ids(r, 'static')}`);
    assert.equal(ids(r, 'ball'), 34);
    assert.ok(r.points.at(-1).t <= flight.at(-1).t + 1e-9);
  }
});

test('an airplane already moving before impact is barred from the flight (pre-impact mover)', () => {
  const { frames, launch, flight } = launchScene({ frames: 140, path: { vx: 3, vy: -26, g: 0.55, drag: 0.02, n: 24 } });
  const last = flight.at(-1), prev = flight.at(-2);
  const meet = { i: last.i + 3, x: last.x + (last.x - prev.x) * 3, y: last.y + (last.y - prev.y) * 3 };
  for (let i = 0; i < 140; i++) frames[i].candidates.push(cand(i / 30, meet.x + 1.5 * (i - meet.i), meet.y, 12, 0.95, `plane${i}`));
  const hinted = { ...launch, vx: (flight[2].x - 400) * 10, vy: (flight[2].y - 900) * 10 };
  const r = associateFlight({ frames, launches: [hinted], ...OPTS, changePoint: false });
  assert.equal(ids(r, 'plane'), 0, `plane points ${ids(r, 'plane')}`);
  assert.equal(ids(r, 'ball'), 24);
  const movers = labelMovers(frames, [hinted]);
  assert.ok(movers.get('ball').size > 30, 'the plane continuation is labelled');
});

test('a mover passing through the address at impact (the swing) is not barred', () => {
  const { frames, launch } = launchScene();
  // A club-like object sweeps through the address, arriving exactly at impact.
  for (let i = 18; i <= 30; i++) frames[i].candidates.push(cand(i / 30, 400 - (30 - i) * 6, 900 + (30 - i) * 2, 10, 0.9, `club${i}`));
  const movers = labelMovers(frames, [launch]);
  assert.equal(movers.get('ball').size, 0);
});

test('an airplane that appears after the ball fades is cut at the change point', () => {
  for (const offset of [0, 10, 15]) {
    const { frames, launch, flight } = launchScene({ frames: 140, path: { vx: 3, vy: -26, g: 0.55, drag: 0.02, n: 24 } });
    const last = flight.at(-1), prev = flight.at(-2);
    const meet = { i: last.i + 3, x: last.x + (last.x - prev.x) * 3 + offset, y: last.y + (last.y - prev.y) * 3 };
    for (let i = meet.i; i < meet.i + 45; i++) frames[i].candidates.push(cand(i / 30, meet.x + 1.5 * (i - meet.i), meet.y, 12, 0.95, `plane${i}`));
    const hinted = { ...launch, vx: (flight[2].x - 400) * 10, vy: (flight[2].y - 900) * 10 };
    const r = associateFlight({ frames, launches: [hinted], ...OPTS });
    assert.ok(ids(r, 'plane') <= 1, `offset ${offset}: plane points ${ids(r, 'plane')}`);
    assert.equal(ids(r, 'ball'), 24);
    assert.ok(associateFlight({ frames, launches: [hinted], ...OPTS, changePoint: false }).points.length > 40, 'without the cut the plane tail stays');
  }
});

test('trimChangePoint leaves clean and noisy ballistic flights whole', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [vy, g, drag, jitter] of [[-25, 0.55, 0.03, 0], [-12, 0.3, 0.01, 0.8], [-40, 0.8, 0.05, 1.5], [-6, 0.15, 0, 0.5]]) {
    const pts = [{ t: 1, x: 400, y: 900 }, ...ballPath({ vx: 3, vy, g, drag, n: 45 }).map(p => ({ t: p.t, x: p.x + (rnd() - 0.5) * 2 * jitter, y: p.y + (rnd() - 0.5) * 2 * jitter }))];
    assert.equal(trimChangePoint(pts).cut, null, `vy=${vy} jitter=${jitter}`);
  }
});

test('a full arc that lands below its start height is still a flight (no climb rule)', () => {
  for (const [vy, n] of [[-8, 30], [-12, 45], [-6, 24]]) {
    const { frames, launch, flight } = launchScene({ path: { vx: 4, vy, g: 0.55, drag: 0.01, n } });
    assert.ok(flight.at(-1).y > 900, 'lands below the start');
    const r = associateFlight({ frames, launches: [launch], ...OPTS });
    assert.notEqual(r.status, 'no_reliable_track', `vy=${vy}`);
    assert.equal(r.points.length, n + 1);
  }
});

test('a path that flies back to the address is a swing, not a ball', () => {
  // Practice swing: a glove leaves its spot, rises, pauses, and comes back down to where it started.
  const frames = emptyFrames(120);
  let x = 300, y = 880;
  for (let i = 0; i < 120; i++) {
    const l = i - 30;
    if (l > 0 && l <= 20) { x -= 1.2; y -= 8 * Math.max(0.35, 1 - l / 28); }
    else if (l > 20 && l <= 26) { x -= 0.3; y -= 0.3; }
    else if (l > 26 && l <= 46) { x += 1.2; y += 7.2; }
    frames[i].candidates.push(cand(i / 30, x, y, Math.max(8, 30 - Math.max(0, l) * 0.3), 0.92, `glove${i}`));
  }
  const launch = { id: 'glove', t: 1, x: 300, y: 880, sourceSize: 30, sourceQuality: 0.92 };
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.deepEqual(r.reasonCodes, ['no_ball_evidence']);
  assert.ok(r.beams.some(b => b.verdict === 'returned_to_address'), JSON.stringify(r.beams.map(b => b.verdict)));
});

test('a flight must come from the address, not from an object beside it', () => {
  // A drifting glint 30 px from the anchor is linked on the first frame after "impact".
  const { frames, launch } = launchScene({ path: { n: 0 } });
  for (let i = 31; i < 110; i++) frames[i].candidates.push(cand(i / 30, 412 + (i - 31) * 1.5, 872, 9, 0.95, `glint${i}`));
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.ok(r.beams.some(b => b.verdict === 'not_from_address'), JSON.stringify(r.beams.map(b => b.verdict)));
  assert.notEqual(associateFlight({ frames, launches: [launch], ...OPTS, evidence: { launchTolerance: Infinity } }).status, 'no_reliable_track');
});

test('jitter that never leaves the tee is not a flight', () => {
  const { frames, launch } = launchScene({ path: { n: 0 } });
  let seed = 9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 31; i < 70; i++) frames[i].candidates.push(cand(i / 30, 400 + (rnd() - 0.5) * 16, 893 + (rnd() - 0.5) * 16, 20, 0.9, `jit${i}`));
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.ok(r.beams.some(b => b.verdict === 'no_departure'), JSON.stringify(r.beams.map(b => b.verdict)));
});

test('a zig-zag chain that no ball could fly is rejected as incoherent', () => {
  const launch = { t: 0, x: 0, y: 0 };
  const zig = Array.from({ length: 12 }, (_, i) => ({ t: (i + 1) / 30, x: i % 2 ? 16 : -16, y: -10 * (i + 1) }));
  assert.equal(flightEvidence(zig, launch).reason, 'incoherent');
  // Noisy but real: ±2.5 px centroid jitter on a ballistic path stays coherent.
  let seed = 4;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noisy = ballPath({ impact: 0, x0: 0, y0: 0, vy: -12, g: 0.3, n: 30 }).map(p => ({ t: p.t, x: p.x + (rnd() - 0.5) * 5, y: p.y + (rnd() - 0.5) * 5 }));
  assert.ok(flightEvidence(noisy, launch).ok, JSON.stringify(flightEvidence(noisy, launch)));
  // The association applies the gate to its chosen path.
  const { frames, launch: l } = launchScene();
  assert.notEqual(associateFlight({ frames, launches: [l], ...OPTS }).status, 'no_reliable_track');
  const strict = associateFlight({ frames, launches: [l], ...OPTS, evidence: { minCoherence: 1.01 } });
  assert.equal(strict.status, 'no_reliable_track');
  assert.ok(strict.beams.every(b => b.verdict === 'incoherent'));
});

test('flightEvidence names the failing rule', () => {
  const launch = { t: 0, x: 0, y: 0 };
  const line = (n, f) => Array.from({ length: n }, (_, i) => ({ t: (i + 1) / 30, ...f(i + 1) }));
  assert.equal(flightEvidence(line(4, k => ({ x: 0, y: -10 * k })), launch).reason, 'insufficient_visible_frames');
  assert.equal(flightEvidence(line(8, k => ({ x: 0, y: -3 * k })), launch).reason, 'no_departure');
  assert.equal(flightEvidence(line(12, k => ({ x: 0, y: -10 * k })), launch).ok, true);
  assert.equal(flightEvidence(line(12, k => ({ x: 0, y: -10 * k })), { ...launch, x: 40 }).reason, 'not_from_address');
});

test('the null margin is measured against a launch with no flight, not against zero', () => {
  const { frames, launch } = launchScene({ path: { vx: 3, vy: -14, g: 0.3, n: 7 } });
  const r = associateFlight({ frames, launches: [launch], ...OPTS, nullMargin: 0 });
  assert.notEqual(r.status, 'no_reliable_track');
  // The margin excludes the launch prior: it is the evidence the flight adds over a bare launch.
  const prior = launchPrior(launch, 1280);
  assert.ok(r.margin > 0 && r.margin < r.score - prior + 1e-9, `margin ${r.margin} score ${r.score} prior ${prior}`);
  const big = associateFlight({ frames, launches: [{ ...launch, sourceSize: 400 }], ...OPTS, nullMargin: 0 });
  assert.ok(Math.abs(big.margin - r.margin) < 0.5, 'a bigger source does not buy margin');
  const above = associateFlight({ frames, launches: [launch], ...OPTS, nullMargin: r.margin + 0.5 });
  assert.equal(above.status, 'no_reliable_track');
  assert.deepEqual(above.reasonCodes, ['no_ball_evidence']);
  assert.notEqual(associateFlight({ frames, launches: [launch], ...OPTS, nullMargin: r.margin - 0.5 }).status, 'no_reliable_track');
});

test('ambiguity is judged against a competing launch, not a sibling beam', () => {
  const frames = emptyFrames(110);
  for (let i = 0; i <= 30; i++) { frames[i].candidates.push(cand(i / 30, 250, 900, 40, 0.9, `w${i}`)); frames[i].candidates.push(cand(i / 30, 470, 900, 40, 0.9, `b${i}`)); }
  for (const p of ballPath({ impact: 30, x0: 250, vx: -1, vy: -14, g: 0.3, n: 30 })) frames[p.i].candidates.push(cand(p.t, p.x, p.y, Math.max(4, p.size), 0.9, `w${p.i}`));
  for (const p of ballPath({ impact: 30, x0: 470, vx: 1, vy: -14, g: 0.3, n: 30 })) frames[p.i].candidates.push(cand(p.t, p.x, p.y, Math.max(4, p.size), 0.9, `b${p.i}`));
  const launches = [{ id: 'W', t: 1, x: 250, y: 900, sourceSize: 40, sourceQuality: 0.9 }, { id: 'B', t: 1, x: 470, y: 900, sourceSize: 40, sourceQuality: 0.9 }];
  const r = associateFlight({ frames, launches, ...OPTS });
  assert.ok(r.reasonCodes.includes('ambiguous_launch'), JSON.stringify(r));
  assert.ok(r.vsRunner < 1.5);
  const alone = associateFlight({ frames, launches: [launches[1]], ...OPTS });
  assert.ok(!alone.reasonCodes.includes('ambiguous_launch'));
  assert.equal(alone.vsRunner, alone.margin);
  // A competing launch that fails the evidence test (a big spot that only jitters) is no rival.
  const jitter = launchScene();
  let seed = 21;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i <= 60; i++) jitter.frames[i].candidates.push(cand(i / 30, 250 + (rnd() - 0.5) * 14, 900 + (rnd() - 0.5) * 14, 200, 0.95, `big${i}`));
  const rivals = [jitter.launch, { id: 'big', t: 1, x: 250, y: 900, sourceSize: 200, sourceQuality: 0.95 }];
  const r2 = associateFlight({ frames: jitter.frames, launches: rivals, ...OPTS });
  assert.equal(r2.selectedLaunchId, 'ball');
  assert.ok(!r2.reasonCodes.includes('ambiguous_launch'), JSON.stringify(r2.reasonCodes));
  assert.ok(r2.beams.some(b => b.launchId === 'big' && b.verdict !== 'ok'), 'the rival was judged and refused');
});

test('no launch gives a no_launch abstention', () => {
  const { frames } = launchScene();
  const r = associateFlight({ frames, launches: [], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.deepEqual(r.reasonCodes, ['no_launch']);
});

test('scores ignore the trailing coast after the last observation', () => {
  const a = launchScene({ frames: 71 }), b = launchScene({ frames: 101 });
  const ra = associateFlight({ frames: a.frames, launches: [a.launch], ...OPTS });
  const rb = associateFlight({ frames: b.frames, launches: [b.launch], ...OPTS });
  assert.equal(ra.points.length, rb.points.length);
  assert.ok(Math.abs(ra.score - rb.score) < 1e-9, `${ra.score} vs ${rb.score}`);
});

test('within one launch the whole flight wins over its own prefix', () => {
  // The second half is faint, so a capped score alone would prefer an early prefix.
  const { frames, launch, flight } = launchScene({ path: { vx: 3, vy: -20, g: 0.45, drag: 0.01, n: 40 } });
  for (const f of frames) for (const c of f.candidates) if (c.id.startsWith('ball') && f.f > 45) { c.quality = 0.62; c.score = 0.62 * 18 + Math.min(8, Math.sqrt(c.size)); }
  frames[42].candidates = [];
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.ok(Math.abs(r.points.at(-1).t - flight.at(-1).t) < 1e-9, `ends at ${r.points.at(-1).t}`);
});

test('toRendererResult keeps the anchor and drops non-finite points', () => {
  const rendered = toRendererResult({
    status: 'tracked', margin: 3, points: [
      { t: 1, x: 100, y: 200, status: 'anchor' }, { t: 1.1, x: NaN, y: 1, status: 'observed' }, { t: 1.2, x: 110, y: 180, status: 'observed' }
    ]
  }, { width: 200, height: 400 });
  assert.deepEqual(rendered.points, [{ t: 1, x: 0.5, y: 0.5 }, { t: 1.2, x: 0.55, y: 0.45 }]);
  assert.equal(rendered.observedFrames, 2);
});

test('an object that never climbs above the address is not a flight', () => {
  // Hands or a club sliding sideways from a small "spot" (no rise), as in a backswing.
  const { frames, launch } = launchScene({ path: { n: 0 } });
  for (let k = 1; k <= 20; k++) frames[30 + k].candidates.push(cand((30 + k) / 30, 400 + k * 4, 900 - k * 0.6, 7, 0.9, `hand${k}`));
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.ok(r.beams.some(b => b.verdict === 'no_rise'), JSON.stringify(r.beams.map(b => b.verdict)));
  assert.notEqual(associateFlight({ frames, launches: [launch], ...OPTS, evidence: { minRisePx: 0 } }).status, 'no_reliable_track');
});

test('a fast launch that slows sharply along its path is followed; a fast arc that turns is not', () => {
  // Down-the-line launch: image speed drops by about a third per frame (perspective and drag).
  const { frames, launch } = launchScene({ path: { n: 0 } });
  let x = 400, y = 900, v = 140;
  for (let k = 1; k <= 30; k++) { y -= v; x -= 0.07 * v; v = Math.max(1.5, v * 0.72); frames[30 + k].candidates.push(cand((30 + k) / 30, x, y, Math.max(4, 40 - k), 0.9, `ball${k}`)); }
  const hinted = { ...launch, vx: -0.07 * 140 * 30, vy: -140 * 30 };
  const r = associateFlight({ frames, launches: [hinted], ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.ok(r.points.length >= 25, `n=${r.points.length}`);
  // Club glints sweeping an arc at the same speeds turn by 0.12 rad per frame: not tolerated.
  let falseTracks = 0;
  for (const speed of [40, 60]) for (const deg of [60, 90, 120]) {
    const scene = launchScene({ path: { n: 0 } });
    for (let k = 1; k <= 10; k++) {
      const ang = deg * Math.PI / 180 + k * 0.12, d = speed * k;
      scene.frames[30 + k].candidates.push(cand((30 + k) / 30, 400 + Math.cos(ang) * d, 900 - Math.sin(ang) * d, 9, 0.88, `club${k}`));
    }
    if (associateFlight({ frames: scene.frames, launches: [scene.launch], ...OPTS }).status !== 'no_reliable_track') falseTracks++;
  }
  assert.equal(falseTracks, 0);
});

test('trimChangePoint does not cut a flight that decelerates geometrically', () => {
  const pts = [{ t: 1, x: 358, y: 989 }];
  let x = 358, y = 989, vx = 26, vy = -35;
  for (let k = 1; k <= 22; k++) { x += vx; y += vy; vx *= 0.88; vy *= 0.88; pts.push({ t: 1 + k / 30, x, y }); }
  assert.equal(trimChangePoint(pts).cut, null);
});

test('a long flight with scattered misses keeps its null margin', () => {
  const { frames, launch } = launchScene({ path: { vx: 2, vy: -12, g: 0.25, drag: 0.01, n: 50 } });
  for (let i = 34; i < 81; i += 4) frames[i].candidates = [];
  const r = associateFlight({ frames, launches: [launch], ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.ok(r.points.length >= 35, `n=${r.points.length}`);
  assert.ok(r.margin >= OPTS.nullMargin, `margin ${r.margin}`);
});

test('a path whose motion reverses more than a ball can is not ballistic', () => {
  const launch = { t: 0, x: 0, y: 0 };
  const path = f => Array.from({ length: 24 }, (_, i) => ({ t: (i + 1) / 30, ...f(i + 1) }));
  // Club or hands after impact: rises, then swings left, right and left again.
  const swing = path(k => ({ x: 20 * Math.sin(k / 3), y: -12 * Math.min(k, 12) - k }));
  assert.equal(flightEvidence(swing, launch).reason, 'not_ballistic');
  // Falls, then climbs again: a bounce or another object, never one ball in flight.
  const bounce = path(k => ({ x: 4 * k, y: k < 8 ? -12 * k : k < 16 ? -96 + 10 * (k - 8) : -16 - 10 * (k - 16) }));
  assert.equal(flightEvidence(bounce, launch).reason, 'not_ballistic');
  // A hook curves back once, and an arc rises then falls: both are ballistic.
  assert.ok(flightEvidence(path(k => ({ x: 30 * Math.sin(k / 10), y: -10 * k + 0.3 * k * k })), launch).ok);
  // Centroid jitter of ±2.5 px on a straight-up flight does not count as reversals.
  let seed = 8;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  assert.ok(flightEvidence(path(k => ({ x: (rnd() - 0.5) * 5, y: -9 * k + 0.2 * k * k + (rnd() - 0.5) * 5 })), launch).ok);
  // In association: the swing path is refused unless the rule is switched off.
  const { frames, launch: l } = launchScene({ path: { n: 0 } });
  swing.forEach((p, i) => frames[31 + i].candidates.push(cand((31 + i) / 30, 400 + p.x, 900 + p.y, 9, 0.9, `sw${i}`)));
  const r = associateFlight({ frames, launches: [l], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.ok(r.beams.some(b => b.verdict === 'not_ballistic'), JSON.stringify(r.beams.map(b => b.verdict)));
  assert.notEqual(associateFlight({ frames, launches: [l], ...OPTS, evidence: { ballistic: false } }).status, 'no_reliable_track');
});

test('a path that runs much faster than at launch is a club, not a ball', () => {
  const launch = { t: 0, x: 0, y: 0 };
  // Speeds up from 6 to 25 px/frame along a rising arc (a club or hands after impact).
  let x = 0, y = 0, v = 6;
  const club = Array.from({ length: 22 }, (_, i) => { x += v * 0.5; y -= v * 0.85; v = Math.min(25, v * 1.1); return { t: (i + 1) / 30, x, y }; });
  assert.equal(flightEvidence(club, launch).reason, 'accelerates');
  assert.ok(flightEvidence(club, launch, { maxSpeedup: Infinity }).ok);
  // A face-on arc speeds up on the way down, but never much past its launch speed.
  assert.ok(flightEvidence(ballPath({ impact: 0, x0: 0, y0: 0, vx: 6, vy: -14, g: 0.6, drag: 0, n: 40 }), launch).ok);
  const { frames, launch: l } = launchScene({ path: { n: 0 } });
  club.forEach((p, i) => frames[31 + i].candidates.push(cand((31 + i) / 30, 400 + p.x, 900 + p.y, 9, 0.9, `club${i}`)));
  const r = associateFlight({ frames, launches: [l], ...OPTS });
  assert.equal(r.status, 'no_reliable_track');
  assert.ok(r.beams.some(b => b.verdict === 'accelerates'), JSON.stringify(r.beams.map(b => b.verdict)));
});

test('another object that zig-zags after the ball fades does not cost the ball its track', () => {
  // The ball fades in the sky; after a gap a bird appears near the coast and flies back and forth.
  const { frames, launch, flight } = launchScene({ frames: 120, path: { vx: 3, vy: -26, g: 0.55, drag: 0.02, n: 24 } });
  const last = flight.at(-1), prev = flight.at(-2);
  for (let k = 0; k < 40; k++) {
    const i = last.i + 3 + k;
    frames[i].candidates.push(cand(i / 30, last.x + (last.x - prev.x) * 3 + 12 * Math.sin(k / 2.5), last.y + (last.y - prev.y) * 3 - 0.5 * k, 10, 0.95, `bird${i}`));
  }
  const hinted = { ...launch, vx: (flight[2].x - 400) * 10, vy: (flight[2].y - 900) * 10 };
  const r = associateFlight({ frames, launches: [hinted], ...OPTS });
  assert.equal(r.status, 'tracked');
  assert.equal(ids(r, 'ball'), 24);
  assert.ok(ids(r, 'bird') <= 1, `bird points ${ids(r, 'bird')}`);
});

test('reserved beams are only for young launches, so many launches cannot blow up the search', () => {
  // 60 objects launch every 5 frames and each flies for 3 s: about 18 launches are alive at once, but
  // only those younger than a second (6 or 7) hold reserved beams.
  const frames = emptyFrames(400), launches = [];
  for (let k = 0; k < 60; k++) {
    const f0 = 5 * k, x0 = 40 + (k * 61) % 640;
    for (let i = 0; i <= f0; i++) frames[i].candidates.push(cand(i / 30, x0, 1100, 20, 0.9, `a${k}`));
    for (let j = 1; j <= 90 && f0 + j < 400; j++) frames[f0 + j].candidates.push(cand((f0 + j) / 30, x0 + 0.3 * j, 1100 - 3 * j, 9, 0.9, `o${k}`));
    launches.push({ id: `L${k}`, t: f0 / 30, x: x0, y: 1100, sourceSize: 20, sourceQuality: 0.9 });
  }
  const r = associateFlight({ frames, launches, ...OPTS });
  assert.ok(r.peakBeams <= OPTS.beamWidth + 4 * 8, `peak ${r.peakBeams} beams`);
});

test('reversals bigger than 12 px count however jittery the path is', () => {
  // Rises 40 px, falls 20, rises 40 again. Alternating ±3 px jitter makes second differences large
  // (a 36 px band if uncapped) while the jitter itself stays below the 12 px cap.
  const ys = k => k < 10 ? -4 * k : k < 20 ? -40 + 2 * (k - 10) : -20 - 4 * (k - 20);
  const path = Array.from({ length: 30 }, (_, i) => ({ t: (i + 1) / 30, x: 6 * (i + 1) + (i % 2 ? 3 : -3), y: ys(i + 1) + (i % 2 ? 3 : -3) }));
  assert.equal(flightEvidence(path, { t: 0, x: 0, y: 0 }, { minCoherence: 0 }).reason, 'not_ballistic');
  // The same jitter on a single rise is not a reversal.
  const rise = path.map((p, i) => ({ ...p, y: -4 * (i + 1) + (i % 2 ? 3 : -3) }));
  assert.ok(flightEvidence(rise, { t: 0, x: 0, y: 0 }, { minCoherence: 0 }).ok);
});
