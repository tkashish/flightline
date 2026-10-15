// Top blob and streak chains (by S) of the real address for hypothesis spot argv[3], with the gate that failed.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), want = process.argv[3], M = await defaultModules(), r2 = v => typeof v === 'number' ? +v.toFixed(2) : v;
const rows = [];
class LogLC extends M.LaunchConfirmer {
  evaluate(ch, ctx) {
    const e = super.evaluate(ch, ctx);
    if (this.hyp.spotId === want && ctx.imp === this.real && Math.hypot(ctx.A.x - this.hyp.address.x, ctx.A.y - this.hyp.address.y) < 1)
      rows.push({ mode: 'blob', k: ctx.kImpact, fail: e.fail, m: e.m, S: r2(e.S), f: e.features ? Object.fromEntries(Object.entries(e.features).filter(([k]) => /^f\d$/.test(k)).map(([k, v]) => [k, r2(v)])) : null, law: e.law ? { ok: e.law.ok, c: r2(e.law.c), v: r2(e.law.v) } : null, first: e.support?.[0] ? [e.support[0].k, r2(e.support[0].x), r2(e.support[0].y)] : null });
    return e;
  }
  evaluateStreak(chain, ctx, segs, anchor) {
    const e = super.evaluateStreak(chain, ctx, segs, anchor);
    if (this.hyp.spotId === want && ctx.imp === this.real && Math.hypot(anchor.x - this.hyp.address.x, anchor.y - this.hyp.address.y) < 1)
      rows.push({ mode: 'streak', k: ctx.kImpact, fail: e.fail, m: e.m, S: r2(e.S), f: Object.fromEntries(Object.entries(e.features ?? {}).map(([k, v]) => [k, r2(v)])), law: e.law ? { ok: e.law.ok, rms: r2(e.law.rms / this.d0), c: r2(e.law.c) } : null, first: e.support?.[0] ? [e.support[0].k, r2(e.support[0].x), r2(e.support[0].y)] : null });
    return e;
  }
}
const { mergeParams } = await import('../../dist/hf/params.js');
await analyzeClip(src, { diagnostics: true, modules: { ...M, LaunchConfirmer: LogLC }, onProgress: () => {}, ...(process.env.OVR ? { params: mergeParams(JSON.parse(process.env.OVR)) } : {}) });
const seen = new Set();
for (const mode of ['blob', 'streak']) {
  const top = rows.filter(r => r.mode === mode && r.m >= 3).sort((a, b) => b.S - a.S).filter(r => { const key = `${r.fail}|${r.m}|${r.S}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
  for (const r of top) console.log(mode.padEnd(6), 'k', r.k, 'fail', String(r.fail).padEnd(9), 'm', r.m, 'S', r.S, JSON.stringify(r.f), JSON.stringify(r.law), 'first', JSON.stringify(r.first));
}
const fails = {}; for (const r of rows) fails[`${r.mode}:${r.fail}`] = (fails[`${r.mode}:${r.fail}`] ?? 0) + 1;
console.log('fail counts', JSON.stringify(fails));
