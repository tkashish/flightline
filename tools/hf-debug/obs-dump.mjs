// Dump every candidate's observations (native px, raw frame coords) as JSON lines.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), { width: W, height: H } = src.meta;
const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {} });
console.log(JSON.stringify({ status: r.status, W, H, obs: (r.observations ?? []).map(o => [o.index ?? o.k, o.x, o.y]),
  cands: (r.diagnostics?.candidates ?? []).map(c => ({ id: c.launchId, obs: (c.track?.observations ?? []).map(o => [o.index, o.x, o.y, o.raw?.x, o.raw?.y]) })) }));
