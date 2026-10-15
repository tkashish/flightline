// Per-frame record of what the coarse scan sees near (AX, AY) (stabilized native px, radius R): every candidate blob,
// every spot observation (candidate or probe), the camera similarity, and the final spot/vacate summaries. JSON out.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { SpotTracker } from '../../dist/hf/spots.js';
import { PARAMS as P0, mergeParams } from '../../dist/hf/params.js';
const PARAMS = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : P0;
import { applySim, invertSim } from '../../dist/hf/types.js';
const [path, xs, ys, rs] = process.argv.slice(2), AX = +xs, AY = +ys, R = +rs;
const frames = new Map(), near = (X, Y) => Math.hypot(X - AX, Y - AY) < R;
const push0 = SpotTracker.prototype.push, obs0 = SpotTracker.prototype.observe;
let pool = 1;
SpotTracker.prototype.push = function (index, t, img, cands, sim, aux) {
  pool = this.pool;
  const inv = invertSim(sim), f = { index, t, sim, cands: [], obs: [] };
  frames.set(index, f);
  for (const c of cands) {
    const q = applySim(inv, this.pool * c.x, this.pool * c.y);
    if (near(q.x, q.y)) f.cands.push({ x: c.x, y: c.y, X: q.x, Y: q.y, d: c.d, z: c.z, pol: c.polarity, round: c.roundness, fill: c.fill, luma: c.luma });
  }
  return push0.call(this, index, t, img, cands, sim, aux);
};
SpotTracker.prototype.observe = function (sp, ord, index, o) {
  if (near(o.X, o.Y)) frames.get(index)?.obs.push({ spot: sp.num, src: 'spot' in o ? 'cand' : 'probe', X: o.X, Y: o.Y, d: o.d, round: o.roundness ?? null, fill: o.fill ?? null, z: o.z ?? null, pol: sp.pol });
  return obs0.call(this, sp, ord, index, o);
};
const src = await openNodeSource(path), meta = src.meta, sc = new CoarseScanner(meta, { params: PARAMS });
let buf; for await (const ref of src.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(PARAMS.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish();
const spots = log.spots.filter(s => near(s.x, s.y)).map(s => ({ id: s.id, x: s.x, y: s.y, d: s.d, pol: s.polarity, first: s.firstIndex, last: s.lastIndex, presence: s.presence, ballLike: s.ballLike, round: s.roundness, fill: s.fill, z: s.z,
  vacates: log.vacates.filter(v => v.spotId === s.id).map(v => ({ kLast: v.kLast, valid: v.valid, fails: v.fails, recovered: v.recovered })) }));
console.log(JSON.stringify({ clip: path.split('/').pop(), W: meta.width, H: meta.height, fps: meta.fps, n: meta.frameCount, pool, AX, AY, R,
  params: { maxEigRatio: PARAMS.scan.spot.maxEigRatio, minFill: PARAMS.scan.spot.minFill, minPresence: PARAMS.scan.spot.minPresence, zMin: PARAMS.scan.candidates.zMin },
  frames: [...frames.values()], spots }));
