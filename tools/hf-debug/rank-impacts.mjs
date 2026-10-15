// Full ranked impact list (no cap) with co-timed counts; OVR env = params override JSON.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { PARAMS, mergeParams } from '../../dist/hf/params.js';
import { findImpacts } from '../../dist/hf/impact.js';
const P = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : PARAMS;
const path = process.argv[2], src = await openNodeSource(path), meta = src.meta, sc = new CoarseScanner(meta, { params: P });
let buf; for await (const ref of src.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(P.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish(), all = findImpacts(log, meta, { params: mergeParams({ ...(process.env.OVR ? JSON.parse(process.env.OVR) : {}), impact: { ...(process.env.OVR ? JSON.parse(process.env.OVR).impact : {}), maxHypotheses: 1000 } }) });
const byK = new Map(); for (const h of all) byK.set(h.kLast, (byK.get(h.kLast) ?? 0) + 1);
const vacK = new Map(); for (const v of log.vacates) vacK.set(v.kLast, (vacK.get(v.kLast) ?? 0) + 1);
console.log(path.split('/').pop(), 'n', all.length);
all.slice(0, +(process.argv[3] ?? 14)).forEach((h, i) => console.log(` #${i + 1} ${h.spotId} (${h.address.x.toFixed(0)},${h.address.y.toFixed(0)}) d ${h.d0.toFixed(1)} k ${h.kLast} q ${h.scores.vacate.toFixed(2)} pass ${h.scores.passEnergy.toFixed(2)} club ${h.scores.clubPassage.toFixed(2)} coImp ${byK.get(h.kLast)} coVac ${vacK.get(h.kLast)}`));
