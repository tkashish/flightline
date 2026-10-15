// Replays findImpacts' filters and prints why each vacate near (X,Y) was kept or dropped.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { CoarseScanner } from '../../dist/hf/coarse-scan.js';
import { PARAMS as P0, spanFrames, mergeParams } from '../../dist/hf/params.js';
const PARAMS = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : P0;
import { findImpacts, arrivalVetoes, lastToLeave, castShadows, tauPriorFromStep, tauForWindows } from '../../dist/hf/impact.js';
const [path, xs, ys, rs] = process.argv.slice(2), AX = +xs, AY = +ys, R = +(rs ?? 80);
const src = await openNodeSource(path), meta = src.meta, P = PARAMS, sc = new CoarseScanner(meta, { params: P });
let buf; for await (const ref of src.frames({ from: 0, to: meta.frameCount, stride: sc.stride })) { const img = await ref.lumaCoarse(P.scan.longEdge, buf); buf = img.data; sc.push(ref.index, ref.t, img); }
const log = sc.finish(), fps = meta.fps, spots = new Map(log.spots.map(s => [s.id, s])), dwell = spanFrames(P.scan.spot.minDwell, fps);
const cands = [], why = [];
for (const v of log.vacates) {
  const s = spots.get(v.spotId); if (!s) continue;
  const near = Math.hypot(s.x - AX, s.y - AY) < R;
  let r = null;
  if (!v.valid) r = `invalid[${v.fails}]`; else if (v.recovered) r = 'recovered'; else if (v.gradualDeparture) r = 'gradual';
  else if (!s.ballLike) r = 'notBallLike'; else if (s.presence < P.scan.spot.minPresence) r = 'presence'; else if (s.lastIndex - s.firstIndex + 1 < dwell) r = 'dwell';
  const tau = tauPriorFromStep(v.impulse?.step1D0 ?? null, 'unknown', P, fps), tauW = tauForWindows(tau);
  if (!r && arrivalVetoes(s.arrivalMovers, v.kLast - s.firstIndex, fps, P, tauW)) r = `arrivalVeto(movers ${s.arrivalMovers}, dwell ${v.kLast - s.firstIndex}, win ${spanFrames(P.impact.r1Window, fps, tauW)})`;
  if (!r) cands.push({ v, s, tauW });
  if (near) why.push({ v, s, r });
}
const ev = cands.map(c => ({ kLast: c.v.kLast, x: c.s.x, y: c.s.y, d: c.s.d, tauW: c.tauW, polarity: c.s.polarity }));
const sup = lastToLeave(ev, fps, P), sh = castShadows(ev, P);
for (const w of why) {
  let r = w.r;
  if (!r) { const i = cands.findIndex(c => c.v === w.v); r = sup[i] >= 0 ? `R1 superseded by ${cands[sup[i]].s.id}@${cands[sup[i]].v.kLast} (${cands[sup[i]].s.x.toFixed(0)},${cands[sup[i]].s.y.toFixed(0)})` : sh[i] >= 0 ? `castShadow of ${cands[sh[i]].s.id}` : 'CANDIDATE'; }
  console.log(`${w.s.id} (${w.s.x.toFixed(0)},${w.s.y.toFixed(0)}) d ${w.s.d.toFixed(1)} pol ${w.s.polarity} f${w.s.firstIndex}-${w.s.lastIndex} kLast ${w.v.kLast}: ${r}`);
}
console.log('candidates after veto', cands.length, 'kept', ev.filter((_, i) => sup[i] < 0 && sh[i] < 0).length);
for (const h of findImpacts(log, meta, { params: P })) console.log('  impact', h.spotId, `(${h.address.x.toFixed(0)},${h.address.y.toFixed(0)})`, 'k', h.kLast, 'q', h.scores.vacate.toFixed(2));
