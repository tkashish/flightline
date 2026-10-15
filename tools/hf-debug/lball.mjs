import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
const src = await openNodeSource(process.argv[2]), want = process.argv[3], M = await defaultModules();
let done = false;
class LogLC extends M.LaunchConfirmer {
  evaluateStreak(chain, ctx, segs, anchor) {
    const e = super.evaluateStreak(chain, ctx, segs, anchor);
    if (!done && this.hyp.spotId === want && this.ref) { done = true; console.log(process.argv[2].split('/').pop().slice(13, 22), 'Lball', this.ref.Lball.toFixed(0), 'ring', this.ref.ring.toFixed(0), 'contrast', this.ref.contrast.toFixed(0), 'sigmaN', this.ref.sigmaN.toFixed(1)); }
    return e;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, LaunchConfirmer: LogLC }, onProgress: () => {} });
