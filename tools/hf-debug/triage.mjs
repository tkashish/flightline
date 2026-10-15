// Per-clip triage: pipeline decisions for the top hypotheses + the full ranked hypothesis list, with raw positions at
// a chosen "address" frame K. Writes JSON to stdout.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { PARAMS, mergeParams } from '../../dist/hf/params.js';
import { findImpacts } from '../../dist/hf/impact.js';
import { analyzeClip } from '../../dist/hf/pipeline.js';
import { simAt, applySim } from '../../dist/hf/types.js';
const path = process.argv[2];
const s1 = await openNodeSource(path), meta = s1.meta, W = meta.width, H = meta.height;
const r = await analyzeClip(s1, { diagnostics: true, onProgress: () => {} }), d = r.diagnostics ?? {};
const s2 = await openNodeSource(path), sc = new CoarseScanner(meta, { params: PARAMS });
let buf; for await (const ref of s2.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(PARAMS.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish(), all = findImpacts(log, meta, { params: mergeParams({ impact: { maxHypotheses: 1000 } }) });
const top = (d.impacts ?? []).map((h, i) => ({ x: h.x * W, y: h.y * H, k: h.kLast, launch: d.launches?.[i] ? (d.launches[i].accepted ? `OK S${d.launches[i].S?.toFixed?.(0)}` : d.launches[i].reason) : null }));
const K = Math.max(0, Math.min(...all.slice(0, 8).map(h => h.kLast)) - Math.round(0.3 * meta.fps));
const raw = (x, y, k) => applySim(simAt(log.camera, k), x, y);
console.log(JSON.stringify({
  clip: path.split('/').pop(), W, H, fps: meta.fps, n: meta.frameCount, status: r.status, reasons: r.reasonCodes, K,
  top, cands: (d.candidates ?? []).map(c => ({ id: c.launchId, obs: c.track?.observations?.length ?? 0, end: c.track?.observedEnd })),
  all: all.slice(0, 20).map((h, i) => { const p = raw(h.address.x, h.address.y, K); return { rank: i + 1, id: h.spotId, x: h.address.x, y: h.address.y, rx: p.x, ry: p.y, d: h.d0, k: h.kLast, q: +h.scores.vacate.toFixed(2) }; })
}));
