import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
import { mergeParams } from '../../dist/hf/params.js';
const params = process.env.OVR ? mergeParams(JSON.parse(process.env.OVR)) : undefined;
const path = process.argv[2], t0 = Date.now();
try {
  const src = await openNodeSource(path), { width: W, height: H } = src.meta;
  const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {}, ...(params ? { params } : {}) }), d = r.diagnostics || {};
  const imp = (d.impacts || []).map(h => ({ x: Math.round(h.x * W), y: Math.round(h.y * H), k: h.kLast }));
  const la = (d.launches || []).map(l => (l.accepted ? `OK(S${l.S?.toFixed?.(0)},m${l.margin?.toFixed?.(0)})` : l.reason));
  const c = (d.candidates || [])[0];
  console.log(JSON.stringify({ clip: path.split('/').pop(), status: r.status, reasons: r.reasonCodes, conf: +(r.confidence?.value ?? 0).toFixed(2), obs: r.observations?.length ?? 0,
    impacts: imp, launches: la, trackInl: c?.features?.inliers ?? null, end: c?.track?.observedEnd ?? null, sec: +((Date.now() - t0) / 1000).toFixed(1) }));
} catch (e) { console.log(JSON.stringify({ clip: path.split('/').pop(), error: String(e).slice(0, 200) })); }
