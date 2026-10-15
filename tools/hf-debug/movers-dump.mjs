import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { analyzeClip } from '../../dist/hf/pipeline.js';
import { PARAMS as P0, mergeParams } from '../../dist/hf/params.js';
const P = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : P0, path = process.argv[2];
const src = await openNodeSource(path), sc = new CoarseScanner(src.meta, { params: P });
let buf; for await (const ref of src.frames({ from: 0, to: src.meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(P.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish(), r1 = v => Math.round(v);
console.log('movers', log.movers.length);
for (const m of log.movers) console.log(`  ${m.id} ${m.kind} k ${m.index0}-${m.index1} at (${r1(m.x)},${r1(m.y)}) v (${m.vx.toFixed(1)},${m.vy.toFixed(1)}) d ${m.d.toFixed(1)}`);
const r = await analyzeClip(await openNodeSource(path), { diagnostics: true, onProgress: () => {}, params: P });
const c = (r.diagnostics?.candidates ?? [])[0];
console.log('mover-flagged obs:', JSON.stringify((c?.track?.observations ?? []).filter(o => o.flag === 'mover').map(o => [o.index, r1(o.x), r1(o.y)])));
