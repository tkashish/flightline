/**
 * Pixel-level ports of D1's E5 association-steal reproductions (/tmp/flightline-understand/design/D1-scratch/e5:
 * e6 eviction, e11 static speck, e4 airplane) with the same geometry (720x1280 px, 30 fps, E5 ballPath), run through
 * FlightTracker with the stub tube and fit, then the post-finish fit + re-association loop (and decide for e6).
 */
import { makeScene, ballPath, sizeToD, tableObject, rng } from './tracker-scene.mjs';
import { drive, makeLaunch, makeLog, trackers, refine, candidate } from './tracker-drive.mjs';
import { decide } from '../../../dist/hf/decide.js';
import { makeSpot } from '../../../dist/hf/types.js';

const near = (o, p, r) => !!p && Math.hypot(o.x - p.x, o.y - p.y) <= r;
export const inliers = h => h.observations.filter(o => o.flag === 'inlier');
const address = (impact, x, y, size) => Array.from({ length: impact + 1 }, (_, i) => ({ i, x, y, d: sizeToD(size) }));

/** e4-airplane: the ball fades in the sky; an airplane crosses near its coasted prediction after `appearAfterMiss` frames. */
export async function planeCase({ offset = 0, appearAfterMiss = 3, planeV = [1.5, 0], planeFrames = 45, alwaysVisible = false, knownMover = alwaysVisible } = {}) {
  const impact = 30, n = 24, N = 140;
  const path = ballPath({ impact, x0: 400, y0: 900, vx: 3, vy: -26, g: 0.55, drag: 0.02, n, size0: 40 }).map(p => ({ ...p, d: sizeToD(p.size) }));
  const last = path.at(-1), prev = path.at(-2), vx = last.x - prev.x, vy = last.y - prev.y;
  const meet = { i: last.i + appearAfterMiss, x: last.x + vx * appearAfterMiss + offset, y: last.y + vy * appearAfterMiss };
  const plane = [];
  for (let i = alwaysVisible ? 0 : meet.i; i < Math.min(N, meet.i + planeFrames); i++) {
    const k = i - meet.i;
    plane.push({ i, x: meet.x + planeV[0] * k, y: meet.y + planeV[1] * k, d: sizeToD(12) });
  }
  const scene = makeScene({ frameCount: N, objects: [tableObject('ball', [...address(impact, 400, 900, 40), ...path], 60), tableObject('plane', plane, 70)] });
  // A plane already in the sky before impact is a coarse-scan pre-impact mover (U2), when U2 saw it.
  const movers = knownMover ? [{ id: 'plane', kind: 'preimpact', index0: 0, index1: impact, x: plane[0].x, y: plane[0].y, vx: planeV[0], vy: planeV[1], d: sizeToD(12) }] : [];
  const log = makeLog(scene.meta, scene.camera, { movers });
  const launch = makeLaunch({ path, impact, d0: sizeToD(40), address: { x: 400, y: 900 } });
  const T = trackers(scene.meta, log, [launch]);
  const [hyps] = await drive(scene.source, T.trackers, scene.camera);
  const { hyp } = refine(hyps[0], T.ctxs[0], launch, T.deps);
  const pm = new Map(plane.map(p => [p.i, p])), bm = new Map(path.map(p => [p.i, p])), inl = inliers(hyp);
  return {
    planePts: inl.filter(o => near(o, pm.get(o.index), 2) && !near(o, bm.get(o.index), 2)).length,
    ballPts: inl.filter(o => near(o, bm.get(o.index), 2)).length, n, hyp, forward: hyps[0]
  };
}

/** e11-length-bias: a static bright object `offset` px beside flight point k, visible the whole clip. */
export async function speckCase({ vy = -9, offset = 6, clipFrames = 240, k = 14, known = false } = {}) {
  const impact = 30;
  const path = ballPath({ impact, vx: 2, vy, g: 0.25, drag: 0.01, n: 34, size0: 40 }).map(p => ({ ...p, d: sizeToD(Math.max(4, p.size)) }));
  const s = path[k - 1], sp = { x: s.x + offset, y: s.y, d: sizeToD(20) };
  const scene = makeScene({ frameCount: clipFrames, objects: [
    tableObject('ball', [...address(impact, 400, 900, 40), ...path], 60),
    tableObject('static', Array.from({ length: clipFrames }, (_, i) => ({ i, ...sp })), 60)
  ] });
  // known: the coarse scan registered the object as a stationary spot; otherwise only self-observed evidence exists.
  const spots = known ? [makeSpot({ id: 'sp1', x: sp.x, y: sp.y, d: sp.d, polarity: 1, contrast: 60, z: 20, firstIndex: 0, lastIndex: clipFrames - 1, presence: 1, roundness: 1, fill: 0.8, ballLike: true })] : [];
  const log = makeLog(scene.meta, scene.camera, { spots });
  const launch = makeLaunch({ path, impact, d0: sizeToD(40), address: { x: 400, y: 900 } });
  const T = trackers(scene.meta, log, [launch]);
  const [hyps] = await drive(scene.source, T.trackers, scene.camera);
  const { hyp } = refine(hyps[0], T.ctxs[0], launch, T.deps);
  const bm = new Map(path.map(p => [p.i, p])), inl = inliers(hyp);
  return {
    staticPts: inl.filter(o => near(o, sp, 1.5) && !near(o, bm.get(o.index), 1.5)).length,
    ballPts: inl.filter(o => near(o, bm.get(o.index), 2)).length, n: path.length,
    lastBall: inl.filter(o => near(o, bm.get(o.index), 2)).at(-1)?.index ?? -1, pathEnd: path.at(-1).i,
    afterPass: inl.filter(o => o.index > s.i + 3 && near(o, sp, 3)).length, hyp
  };
}

/** e6: `wIds` earlier wrong launches of one rising glint W (alive until frame wEndsAt), then the real ball at frame 50. */
const aloneCache = new Map();
export async function evictCase({ wIds = 4, wEndsAt = 80, glints = 0, wMargin = 0.5, ballMargin = 3 } = {}) {
  const r = rng(5), N = 120, ballImpact = 50, wRows = [], gRows = [];
  let wx = 200, wy = 950, wvy = -9;
  for (let i = 0; i < N; i++) {
    const wl = i - 20;
    if (wl > 0) { wx += 0.5; wy += wvy; wvy = Math.min(-1, wvy + 0.15); }
    if (wl <= wEndsAt - 20) {
      wRows.push({ i, x: wx, y: wy, d: sizeToD(wl > 0 ? Math.max(4, 9 - wl) : 9) });
      for (let q = 0; q < glints && wl > 1; q++) gRows.push({ id: `g${i}_${q}`, i, x: wx + (r() - 0.5) * 16, y: wy + (r() - 0.5) * 16, d: sizeToD(4) });
    }
  }
  const bPath = ballPath({ impact: ballImpact, x0: 470, y0: 900, vx: 0.5, vy: -12, g: 0.3, drag: 0, n: 40, size0: 20 }).map(p => ({ ...p, d: sizeToD(Math.max(4, p.size)) }));
  const scene = makeScene({ frameCount: N, objects: [
    tableObject('W', wRows, 62), tableObject('ball', [...address(ballImpact, 470, 900, 20), ...bPath], 60), ...gRows.map(g => tableObject(g.id, [g], 60))
  ] });
  const log = makeLog(scene.meta, scene.camera);
  // Like the legacy linker, one physical glint yields several launch ids at slightly different times. U3 would score
  // a 9 px² glint far below a 20 px² ball; wMargin is that weak launch evidence.
  const launches = Array.from({ length: wIds }, (_, q) => {
    const imp = 20 + Math.floor(q * 0.5);
    return makeLaunch({ id: `W${q}`, path: wRows.filter(w => w.i > imp), impact: imp, t0Frac: (q * 0.5) % 1 + 0.02, d0: sizeToD(9), address: { x: 200, y: 950 }, margin: wMargin });
  });
  const ball = makeLaunch({ id: 'BALL', path: bPath, impact: ballImpact, d0: sizeToD(20), address: { x: 470, y: 900 }, margin: ballMargin });
  const run = async ls => {
    const T = trackers(scene.meta, log, ls), hyps = await drive(scene.source, T.trackers, scene.camera);
    const cands = ls.map((l, i) => { const { hyp, fit } = refine(hyps[i][0], T.ctxs[i], l, T.deps); return candidate(T.ctxs[i].impact, l, hyp, fit); });
    return { cands, dec: decide(cands, { meta: scene.meta, log, impacts: T.ctxs.map(c => c.impact), decisions: cands.map(c => c.decision) }) };
  };
  // The ball tracked alone (no W launches) is the reference; the scene differs only by glints.
  const key0 = `${glints}:${wEndsAt}:${ballMargin}`;
  if (!aloneCache.has(key0)) aloneCache.set(key0, await run([ball]));
  const all = await run([...launches, ball]), alone = aloneCache.get(key0);
  const bm = new Map(bPath.map(p => [p.i, p])), ballOf = c => inliers(c.track).filter(o => near(o, bm.get(o.index), 2)).length;
  const ballCand = all.cands.at(-1), key = c => JSON.stringify(inliers(c.track).map(o => [o.index, o.x.toFixed(3), o.y.toFixed(3)]));
  return {
    dec: all.dec, selected: all.dec.selected?.launch.id ?? null, ballWithW: ballOf(ballCand), ballAlone: ballOf(alone.cands[0]),
    identical: key(ballCand) === key(alone.cands[0]), n: bPath.length
  };
}
