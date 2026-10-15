import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]);
const M = await defaultModules();
class LogTube extends M.RoiTube {
  detect(index, pred) {
    const r = super.detect(index, pred);
    if (index >= +process.argv[3] && index <= +process.argv[4]) {
      const o = r?.observation;
      console.log(`detect f${index} pred(${pred.x.toFixed(1)},${pred.y.toFixed(1)}) sig ${Math.sqrt(Math.max(pred.cov[0], pred.cov[2])).toFixed(1)} v(${(pred.vx ?? 0).toFixed(1)},${(pred.vy ?? 0).toFixed(1)}) sv ${(pred.sv ?? pred.svel ?? 0).toFixed?.(1)} probe ${pred.probe ? 1 : 0} -> ${o ? `obs(${o.x.toFixed(1)},${o.y.toFixed(1)}) z ${o.z.toFixed(1)}` : 'none'} score ${r?.score?.toFixed?.(1)} thr ${r?.threshold?.toFixed?.(1) ?? r?.T?.toFixed?.(1)} reason ${r?.reason} grid ${r?.grid} cands ${(r?.candidates ?? r?.cands ?? []).length ?? ""} rej ${JSON.stringify(r?.rejected ?? r?.reasons ?? null)?.slice(0, 160)}`);
    }
    return r;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, RoiTube: LogTube }, onProgress: () => {} });
