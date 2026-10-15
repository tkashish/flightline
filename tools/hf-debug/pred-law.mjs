import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), k0 = +process.argv[3], k1 = +process.argv[4], M = await defaultModules(), r2 = v => +(+v).toFixed(2);
class LogFT extends M.FlightTracker {
  predict(b, k) {
    const p = super.predict(b, k);
    if (k === k0 && !this._shown) { this._shown = 1; console.log("launch samples", JSON.stringify(this.launch.samples.map(o => [o.index, r2(o.x), r2(o.y), o.src, r2(o.sigma ?? 0)])), "t0", r2(this.launch.t0 * 30)); }
    if (k >= k0 && k <= k1) console.log(`pred k${k} mode ${b.mode} inl ${b.nInl} launch c ${r2(this.launch.c)} v ${r2(this.launch.v)} law θ ${b.law ? JSON.stringify(b.law.theta.map(r2)) : '-'} -> (${r2(p.x)},${r2(p.y)}) v(${r2(p.vx)},${r2(p.vy)}) a(${r2(p.ax ?? 0)},${r2(p.ay ?? 0)})`);
    return p;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, FlightTracker: LogFT }, onProgress: () => {} });
