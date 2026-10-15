// estimateMotion between two frames A, B of a clip (coarse luma), identity prior; prints the fit and patch detail summary.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { motionFrame, estimateMotion, selectPatches } from '../../dist/hf/camera-motion.js';
import { PARAMS, mergeParams } from '../../dist/hf/params.js';
const P = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : PARAMS;
const [path, as, bs] = process.argv.slice(2), A = +as, B = +bs, src = await openNodeSource(path), imgs = {};
for await (const ref of src.frames({ from: Math.min(A, B), to: Math.max(A, B) + 1, stride: 1 })) {
  if (ref.index === A || ref.index === B) { const img = await ref.lumaCoarse(P.scan.longEdge); imgs[ref.index] = { ...img, data: Uint8Array.from(img.data) }; }
}
const fa = motionFrame(imgs[A], { params: P }), fb = motionFrame(imgs[B], { params: P });
fa.patches = selectPatches(fa, { params: P });
const e = estimateMotion(fa, fb, { params: P, detail: true });
console.log(`f${A}->f${B} coarse ${imgs[A].w}x${imgs[A].h} ok ${e.ok} inl ${e.inliers}/${e.patches} ratio ${e.inlierRatio.toFixed(2)} res ${e.residual.toFixed(2)} scale ${Math.hypot(e.sim.a, e.sim.b).toFixed(4)} t (${e.sim.tx.toFixed(2)},${e.sim.ty.toFixed(2)})`);
const d = e.detail ?? [];
const hist = new Map(); for (const q of d) { const k = `${Math.round(q.dx)},${Math.round(q.dy)}`; hist.set(k, (hist.get(k) ?? 0) + 1); }
console.log(' patch offsets (rounded dx,dy:count):', [...hist].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join('  '));
console.log(' by row:', d.sort((a, b) => a.y - b.y).map(q => `y${q.y.toFixed(0)}:(${q.dx.toFixed(1)},${q.dy.toFixed(1)})`).join(' '));
