import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), { width: W, height: H } = src.meta;
const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {} }), d = r.diagnostics || {};
console.log(r.status, r.reasonCodes, 'rules', JSON.stringify(r.rules ?? d.rules ?? null));
for (const c of d.candidates ?? []) {
  const o = c.track?.observations ?? c.observations ?? [];
  const first = o[0], last = o[o.length - 1];
  console.log(`cand ${c.id ?? ''} launch ${c.launch?.impactId ?? c.impactId ?? ''} conf ${(c.confidence?.value ?? c.value ?? NaN).toFixed?.(3)} inl ${c.features?.inliers} obs ${o.length} first ${first ? `${first.index ?? first.k}:(${(first.x * (first.x <= 1 ? W : 1)).toFixed(0)},${(first.y * (first.y <= 1 ? H : 1)).toFixed(0)})` : '-'} last ${last ? `${last.index ?? last.k}:(${(last.x * (last.x <= 1 ? W : 1)).toFixed(0)},${(last.y * (last.y <= 1 ? H : 1)).toFixed(0)})` : '-'} end ${c.track?.observedEnd} keys ${Object.keys(c).join(',')}`);
}
