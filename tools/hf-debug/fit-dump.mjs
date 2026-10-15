import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip } from '../../dist/hf/pipeline.js';
import { PARAMS } from '../../dist/hf/params.js';
import { fitExcess } from '../../dist/hf/confidence.js';
const src = await openNodeSource(process.argv[2]);
const r = await analyzeClip(src, { diagnostics: true, onProgress: () => {} });
for (const c of r.diagnostics?.candidates ?? []) {
  const f = c.fit; if (!f) { console.log(c.launchId, 'no fit'); continue; }
  console.log("implausible", JSON.stringify(f.implausible), "plausible", f.plausible, "params", JSON.stringify(f.names), JSON.stringify(Array.from(f.params ?? []).map(v => +v.toFixed(3))));
  const pick = Object.fromEntries(Object.entries(f).filter(([k, v]) => typeof v !== 'object' || v === null || Array.isArray(v) && v.length < 12));
  console.log(c.launchId, 'fitExcess', fitExcess(f, PARAMS), 'gates: inlierFrac>=', PARAMS.fit.r2MinInlierFrac, 'excess<=', PARAMS.fit.r2MaxRmsNorm, JSON.stringify(pick).slice(0, 900));
}
