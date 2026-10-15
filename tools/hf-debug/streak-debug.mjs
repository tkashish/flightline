// Logs every streak-chain evaluation (and blob-chain evaluation) of the real address for the hypothesis whose spot id is argv[3].
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), want = process.argv[3];
const M = await defaultModules();
const r2 = v => typeof v === 'number' ? +v.toFixed(2) : v;
class LogLC extends M.LaunchConfirmer {
  evaluateStreak(chain, ctx, segs, anchor) {
    const e = super.evaluateStreak(chain, ctx, segs, anchor);
    if (this.hyp.spotId === want && Math.hypot(anchor.x - this.hyp.address.x, anchor.y - this.hyp.address.y) < 1 && ctx.imp === this.real)
      console.log('STREAK', 'k', ctx.kImpact, 'fail', e.fail, 'm', e.m, 'inF', e.inFrame, 'S', r2(e.S), 'law', e.law ? JSON.stringify({ ok: e.law.ok, perp: r2(e.law.perpRms / this.d0), rms: r2(e.law.rms / this.d0), c: r2(e.law.c), v: r2(e.law.v) }) : null,
        'feat', JSON.stringify(e.features, (k, v) => r2(v)), 'samples', JSON.stringify(e.support.map(q => [q.k, r2(q.x), r2(q.y), r2(q.len), r2(q.w)])));
    return e;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, LaunchConfirmer: LogLC }, onProgress: () => {} });
