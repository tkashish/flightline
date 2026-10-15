import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), r1 = v => Math.round(v);
const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {} });
for (const c of r.diagnostics?.candidates ?? []) {
  const o = c.track?.observations ?? [];
  console.log(c.launchId, 'end', c.track?.observedEnd, 'obs', o.length);
  console.log('  ', o.map(q => `${q.index}:${q.flag[0]}${q.src ? q.src[0] : ''}(${r1(q.x)},${r1(q.y)})z${r1(q.z ?? 0)}`).join(' '));
}
