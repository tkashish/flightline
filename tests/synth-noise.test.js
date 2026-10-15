import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from './synth/world.mjs';
import { Renderer } from './synth/render.mjs';
import { planSplit } from './synth/scenarios.mjs';

const W = 432, H = 768, Y0 = 12, Y1 = 260;
/** Sensor noise of frame k as rendered: noisy minus clean float output (no quantization), G channel and (R - B) / 2. */
function noiseOf(Rn, Rc, k) {
  const a = new Float32Array(W * H * 3), b = new Float32Array(W * H * 3); Rn.frame(k, a); Rc.frame(k, b);
  const l = new Float32Array(W * H), c = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { l[i] = a[i * 3 + 1] - b[i * 3 + 1]; c[i] = (a[i * 3] - b[i * 3] - a[i * 3 + 2] + b[i * 3 + 2]) / 2; }
  return { l, c };
}
/** Largest |normalized correlation| between A and B shifted by (dx, dy), over the overlap inside rows Y0..Y1. */
function maxShiftCorr(A, B, mdx, mdy) {
  let best = { r: 0 };
  for (let dy = -mdy; dy <= mdy; dy++) for (let dx = -mdx; dx <= mdx; dx++) {
    let s = 0, sa = 0, sb = 0, ma = 0, mb = 0, n = 0;
    const x0 = Math.max(0, -dx), x1 = Math.min(W, W - dx);
    for (let y = Y0; y < Y1; y++) for (let x = x0, i = y * W + x0, j = (y + dy) * W + x0 + dx; x < x1; x++, i++, j++) { const p = A[i], q = B[j]; s += p * q; sa += p * p; sb += q * q; ma += p; mb += q; n++; }
    const r = (s - ma * mb / n) / Math.sqrt((sa - ma * ma / n) * (sb - mb * mb / n));
    if (Math.abs(r) > Math.abs(best.r)) best = { r, dx, dy };
  }
  return best;
}

test('sensor noise is independent from frame to frame: |normalized correlation| < 0.05 over |dx| <= W/2, |dy| <= 4', () => {
  let chromaChecked = 0;
  for (const id of ['smoke-01', 'smoke-04']) {
    const s0 = planSplit('smoke').find(s => s.id.startsWith(id)), w = buildWorld({ ...structuredClone(s0), format: { ...s0.format, W, H } });
    const Rn = new Renderer(w, { keepPatches: false }), Rc = new Renderer(w, { noise: false, keepPatches: false }), k = 9, f = [k, k + 1, k + 2].map(j => noiseOf(Rn, Rc, j));
    let sd = 0, lag = 0; for (let y = Y0; y < Y1; y++) for (let x = 0; x < W - 1; x++) { const i = y * W + x; sd += f[0].l[i] ** 2; lag += f[0].l[i] * f[0].l[i + 1]; }
    assert.ok(sd / (W * (Y1 - Y0)) > 0.2, `${id}: noise present`);
    assert.ok(lag / sd > 0.15, `${id}: noise keeps its spatial correlation (lag-1 ${(lag / sd).toFixed(2)})`);
    const fields = Rn.chromaOn ? ['l', 'c'] : ['l'];
    for (const ch of fields) for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
      const r = maxShiftCorr(f[a][ch], f[b][ch], W / 2, 4);
      assert.ok(Math.abs(r.r) < 0.05, `${id} ${ch === 'l' ? 'luma' : 'chroma'} frames ${k + a}/${k + b}: correlation ${r.r.toFixed(3)} at shift (${r.dx},${r.dy})`);
    }
    chromaChecked += fields.length - 1;
  }
  assert.ok(chromaChecked > 0, 'chroma noise checked on at least one clip');
});
