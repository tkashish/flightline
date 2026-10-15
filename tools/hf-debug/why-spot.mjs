import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { PARAMS } from '../../dist/hf/params.js';
const [path, xs, ys, rs] = process.argv.slice(2), AX = +xs, AY = +ys, R = +(rs ?? 60);
const src = await openNodeSource(path), meta = src.meta, sc = new CoarseScanner(meta, { params: PARAMS });
let buf; for await (const ref of src.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(PARAMS.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish();
console.log('meta', meta.width, meta.height, meta.fps.toFixed(2), meta.frameCount, 'spots', log.spots.length, 'vacates', log.vacates.length);
const near = log.spots.filter(s => Math.hypot(s.x - AX, s.y - AY) < R).sort((a, b) => (b.lastIndex - b.firstIndex) - (a.lastIndex - a.firstIndex)).slice(0, 6);
for (const s of near) {
  console.log(`spot ${s.id} (${s.x.toFixed(0)},${s.y.toFixed(0)}) d ${s.d.toFixed(1)} pol ${s.polarity} frames ${s.firstIndex}-${s.lastIndex} presence ${s.presence.toFixed(2)} ballLike ${s.ballLike} round ${s.roundness.toFixed(2)} fill ${s.fill.toFixed(2)} z ${s.z.toFixed(1)} arrivals ${s.arrivalMovers}`);
  for (const v of log.vacates.filter(v => v.spotId === s.id)) console.log(`   vacate kLast ${v.kLast} valid ${v.valid} eligible ${v.eligible} fails [${v.fails}] ncc ${v.ncc?.toFixed?.(2)} impulse ${JSON.stringify(v.impulse)} recovered ${v.recovered}`);
}
