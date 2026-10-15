import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), { width: W, height: H } = src.meta;
const M = await defaultModules();
class LogLC extends M.LaunchConfirmer {
  finish() {
    const r = super.finish();
    const f = r?.features || {};
    console.log('HYP', r.hypId, 'accepted', r.accepted, 'reason', r.reason, 'S', r.S, 'margin', r.margin);
    console.log('  counts', JSON.stringify(f.counts), 'streak', JSON.stringify(f.streak?.counts), 'timing', JSON.stringify(f.impactTiming?.tried?.slice?.(0, 6)));
    for (const c of (f.chains || []).slice(0, 5)) console.log('  chain', JSON.stringify(c, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v).slice(0, 400));
    if (f.winner) console.log('  winner', JSON.stringify(f.winner, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v).slice(0, 600));
    return r;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, LaunchConfirmer: LogLC }, onProgress: () => {} });
