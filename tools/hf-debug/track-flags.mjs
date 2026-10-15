import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
import { mergeParams } from '../../dist/hf/params.js';
const src = await openNodeSource(process.argv[2]);
const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {}, params: mergeParams(JSON.parse(process.env.OVR ?? '{}')) });
for (const c of r.diagnostics?.candidates ?? []) {
  const o = c.track?.observations ?? [], flags = {};
  for (const q of o) flags[q.flag] = (flags[q.flag] ?? 0) + 1;
  console.log(c.launchId, 'obs', o.length, 'flags', JSON.stringify(flags), 'end', c.track?.observedEnd, 'last', o.at(-1)?.index, 'spots', r.diagnostics?.counts?.spots ?? '');
}
