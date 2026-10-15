import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { CandidateDetector } from '../../dist/hf/spots.js';
import { mergeParams } from '../../dist/hf/params.js';
const P = mergeParams({ scan: { candidates: { maxPerFrame: 5000 } } }), counts = [], d0 = CandidateDetector.prototype.detect;
CandidateDetector.prototype.detect = function (data, o) { const r = d0.call(this, data, o); counts.push(r.length); return r; };
const src = await openNodeSource(process.argv[2]), sc = new CoarseScanner(src.meta, { params: P });
let buf; for await (const ref of src.frames({ from: 0, to: src.meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(P.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const s = [...counts].sort((a, b) => a - b);
console.log(process.argv[2].split('/').pop(), 'candidates/frame without the cap: median', s[s.length >> 1], 'p90', s[Math.floor(0.9 * s.length)], 'max', s[s.length - 1]);
