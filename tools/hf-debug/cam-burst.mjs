// Camera estimates around a burst frame K (argv[3]); window ±W (argv[4], default 4).
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { MotionTracker } from '../../dist/hf/camera-motion.js';
import { PARAMS } from '../../dist/hf/params.js';
const K = +process.argv[3], W = +(process.argv[4] ?? 4), orig = MotionTracker.prototype.push;
MotionTracker.prototype.push = function (index, t, frame, o) {
  const keyBefore = this.keyIndex, r = orig.call(this, index, t, frame, o), e = r.est;
  if (Math.abs(index - K) <= W) console.log(e ? `f${index} key${keyBefore} ref${e.ref} ok${e.ok ? 1 : 0} rigid${e.rigid ? 1 : 0} inl ${e.inliers}/${e.patches} res ${e.residual.toFixed(2)} scale ${Math.hypot(e.sim.a, e.sim.b).toFixed(4)} rot ${(Math.atan2(e.sim.b, e.sim.a) * 57.3).toFixed(2)} t (${e.sim.tx.toFixed(1)},${e.sim.ty.toFixed(1)}) fallback ${this.stats.fallback}` : `f${index} no est`);
  return r;
};
const src = await openNodeSource(process.argv[2]), meta = src.meta, sc = new CoarseScanner(meta, { params: PARAMS });
let buf, prev = null;
for await (const ref of src.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) {
  const img = await ref.lumaCoarse(PARAMS.scan.longEdge, buf); buf = img.data;
  if (Math.abs(ref.index - K) <= W) { if (prev) { let s = 0; for (let i = 0; i < img.data.length; i++) s += Math.abs(img.data[i] - prev[i]); console.log(`  f${ref.index} t ${ref.t.toFixed(3)} meanAbsDiff ${(s / img.data.length).toFixed(2)} mean ${(img.data.reduce((a, b) => a + b, 0) / img.data.length).toFixed(1)}`); } }
  prev = Uint8Array.from(img.data);
  sc.push(ref.index, ref.t, img);
}
