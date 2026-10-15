/**
 * Generic pixel-level flight cases for the U6 tracker tests: an E5-style ball path plus extra scene objects, an
 * optional energy-store occlusion mask, run through FlightTracker (stub tube and fit) and the refine loop.
 */
import { makeScene, ballPath, sizeToD, tableObject } from './tracker-scene.mjs';
import { drive, makeLaunch, makeLog, trackers, refine } from './tracker-drive.mjs';

export const near = (o, p, r) => !!p && Math.hypot(o.x - p.x, o.y - p.y) <= r;
export const inliers = h => h.observations.filter(o => o.flag === 'inlier');

/**
 * @param {{ball?:object, visible?:(k:number)=>boolean, extras?:object[], N?:number, impact?:number, mask?:{k0:number,k1:number,box:number[]}|null,
 *   tube?:object, params?:object, movers?:object[], width?:number, height?:number, patch?:(tracker:object)=>void}} o
 * ball: ballPath options (impact, x0, y0, vx, vy, g, drag, n, size0); visible(k): ball drawn at flight frame k (1-based).
 */
export async function flightCase(o = {}) {
  const impact = o.impact ?? 30, N = o.N ?? 140, b = { impact, x0: 360, y0: 1000, vx: 2, vy: -20, g: 0.4, drag: 0.01, n: 60, size0: 40, ...o.ball };
  const path = ballPath(b).map(p => ({ ...p, k: p.i - impact, d: sizeToD(Math.max(4, p.size)) }));
  const shown = path.filter(p => (o.visible ? o.visible(p.k) : true));
  const addr = Array.from({ length: impact + 1 }, (_, i) => ({ i, x: b.x0, y: b.y0, d: sizeToD(b.size0) }));
  const scene = makeScene({ frameCount: N, width: o.width ?? 720, height: o.height ?? 1280, objects: [tableObject('ball', [...addr, ...shown], o.ballC ?? 60), ...(o.extras ?? [])] });
  const m = o.mask;
  const active = m ? (k, x, y) => (k >= m.k0 && k <= m.k1 && x >= m.box[0] && x <= m.box[2] && y >= m.box[1] && y <= m.box[3] ? 1 : 0) : null;
  const log = makeLog(scene.meta, scene.camera, { active, movers: o.movers ?? [] });
  const launch = makeLaunch({ path, impact, d0: sizeToD(b.size0), address: { x: b.x0, y: b.y0 } });
  const T = trackers(scene.meta, log, [launch], { tube: o.tube ?? {}, params: o.params });
  o.patch?.(T.trackers[0]);
  const [hyps] = await drive(scene.source, T.trackers, scene.camera);
  const { hyp, fit } = refine(hyps[0], T.ctxs[0], launch, T.deps, o.params);
  const bm = new Map(path.map(p => [p.i, p]));
  return { path, bm, hyp, fit, forward: hyps[0], all: hyps, tracker: T.trackers[0], tube: T.tubes[0], scene, launch, ctx: T.ctxs[0], deps: T.deps };
}

/** Ball inliers matching the truth within r px. */
export const ballHits = (c, r = 2) => inliers(c.hyp).filter(o => near(o, c.bm.get(o.index), r));
