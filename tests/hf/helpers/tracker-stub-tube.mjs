/**
 * Stand-in for U4's RoiTube with the frozen contract shape: plan(index, pred) -> [main, decoy, decoy],
 * push(index, t, crops, sim), ready(index) after J + L more frames, detect(index, pred) -> RoiDetection with a
 * cached ZMap. Detection is real pixel work on the crops: background (spatial median, or two-sided temporal),
 * box matched filter, MAD noise, signed z, best gated local maximum. With the default spatial background static
 * objects stay visible, which is the worst case for static-speck steals (the tracker's labels must handle them).
 */
import { PARAMS } from '../../../dist/hf/params.js';
import { simAt, applySim, invertSim } from '../../../dist/hf/types.js';

const sq = v => v * v;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lmax = m => (m[0] + m[2]) / 2 + Math.sqrt(sq((m[0] - m[2]) / 2) + sq(m[1]));
function chi2(dx, dy, m) { const d = m[0] * m[2] - m[1] * m[1]; return d > 1e-12 ? (m[2] * dx * dx - 2 * m[1] * dx * dy + m[0] * dy * dy) / d : Infinity; }

/** Median of an 8-bit array via a histogram. */
function median8(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let acc = 0, half = data.length / 2;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
  return 0;
}

/** Signed box-filter z field of a residual image (w×h Float32Array) with box radius r. */
function zField(res, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) { let row = 0; for (let i = 0; i < w; i++) { row += res[j * w + i]; I[(j + 1) * (w + 1) + i + 1] = I[j * (w + 1) + i + 1] + row; } }
  const out = new Float32Array(w * h), tmp = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x0 = Math.max(0, i - r), x1 = Math.min(w, i + r + 1), y0 = Math.max(0, j - r), y1 = Math.min(h, j + r + 1);
    const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    out[j * w + i] = s / ((x1 - x0) * (y1 - y0));
  }
  for (let i = 0, step = Math.max(1, Math.floor(out.length / 4096)); i < out.length; i += step) tmp.push(Math.abs(out[i]));
  tmp.sort((a, b) => a - b);
  const sigma = Math.max(1e-3, 1.4826 * tmp[tmp.length >> 1]);
  for (let i = 0; i < out.length; i++) out[i] /= sigma;
  return out;
}

/** A RoiTube class with options baked in: J (TBD half window), L (background lag), zThresh, bg 'spatial'|'temporal'. */
export function stubTube({ J = 1, L = 1, zThresh = 4.5, bg = 'spatial', log = null } = {}) {
  return class StubTube {
    constructor({ meta, camera, params = PARAMS, polarity = 0, specks = [] }) {
      this.meta = meta; this.camera = camera; this.P = params; this.polarity = polarity; this.specks = specks;
      this.frames = new Map(); this.maxPushed = -1; this.zcache = new Map(); this.calls = { plan: 0, push: 0, detect: 0 };
      log?.push(this);
    }
    plan(index, pred) {
      this.calls.plan++;
      const R = this.P.roi, H = R.halfSize, v = Math.hypot(pred.vx, pred.vy);
      const h = Math.round(clamp(H.sigmas * Math.sqrt(Math.max(0, lmax(pred.cov))) + H.d * pred.d + R.tbd.J * v + H.padPx, H.minPx, H.maxPx));
      const pool = Math.max(1, Math.round(pred.d / R.poolD)), side = Math.max(pool, Math.ceil((2 * h) / pool) * pool);
      const raw = applySim(simAt(this.camera, index), pred.x, pred.y);
      const at = (x, y, sd) => ({ x: Math.floor(x - sd / 2), y: Math.floor(y - sd / 2), w: sd, h: sd });
      const n = Math.hypot(pred.vx, pred.vy) > 1e-6 ? [-pred.vy / v, pred.vx / v] : [1, 0], off = R.decoyOffsetH * h, ds = 24 * pool;
      return [
        { rect: at(raw.x, raw.y, side), pool, purpose: 'main' },
        { rect: at(raw.x + n[0] * off, raw.y + n[1] * off, ds), pool, purpose: 'decoy' },
        { rect: at(raw.x - n[0] * off, raw.y - n[1] * off, ds), pool, purpose: 'decoy' }
      ];
    }
    push(index, t, crops, sim) {
      this.calls.push++;
      this.frames.set(index, { t, crops, sim: sim ?? simAt(this.camera, index) });
      this.maxPushed = Math.max(this.maxPushed, index);
      for (const k of this.frames.keys()) if (k < index - 64) { this.frames.delete(k); this.zcache.delete(k); }
    }
    ready(index) { return this.maxPushed >= index + J + L; }
    residual(index, crop) {
      const out = new Float32Array(crop.w * crop.h);
      if (bg === 'temporal') {
        const a = this.frames.get(index - L)?.crops[0], b = this.frames.get(index + L)?.crops[0];
        const sample = (c, X, Y) => {
          if (!c) return null;
          const u = Math.floor((X - c.x0) / c.pool), v = Math.floor((Y - c.y0) / c.pool);
          return u >= 0 && v >= 0 && u < c.w && v < c.h ? c.data[v * c.w + u] : null;
        };
        const med = median8(crop.data);
        for (let j = 0; j < crop.h; j++) for (let i = 0; i < crop.w; i++) {
          const X = crop.x0 + crop.pool * i, Y = crop.y0 + crop.pool * j, pa = sample(a, X, Y), pb = sample(b, X, Y);
          const bgv = pa != null && pb != null ? (pa + pb) / 2 : pa ?? pb ?? med;
          out[j * crop.w + i] = crop.data[j * crop.w + i] - bgv;
        }
      } else {
        const med = median8(crop.data);
        for (let i = 0; i < out.length; i++) out[i] = crop.data[i] - med;
      }
      return out;
    }
    field(index, which, d) {
      const key = `${index}:${which}`;
      let f = this.zcache.get(key);
      if (f) return f;
      const fr = this.frames.get(index), crop = fr?.crops[which];
      if (!crop) return null;
      const r = Math.max(1, Math.round(0.5 * d / crop.pool));
      f = { crop, z: zField(which === 0 ? this.residual(index, crop) : this.residual(-1e9, crop), crop.w, crop.h, r) };
      this.zcache.set(key, f);
      return f;
    }
    detect(index, pred) {
      this.calls.detect++;
      const fr = this.frames.get(index);
      if (!fr) return null;
      const f = this.field(index, 0, pred.d);
      if (!f) return null;
      const { crop, z } = f, w = crop.w, h = crop.h, pool = crop.pool, pol = pred.polarity || this.polarity || 0;
      const sim = fr.sim, inv = invertSim(sim), sgn = v => (pol > 0 ? v : pol < 0 ? -v : Math.abs(v));
      const rawP = applySim(sim, pred.x, pred.y), uc = Math.floor((rawP.x - crop.x0) / pool), vc = Math.floor((rawP.y - crop.y0) / pool);
      const gate = [pred.cov[0] + sq(pred.d / 2) + 0.25, pred.cov[1], pred.cov[2] + sq(pred.d / 2) + 0.25];
      let best = null;
      for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
        const c = sgn(z[j * w + i]);
        if (c < zThresh) continue;
        let peak = true;
        for (let dj = -1; dj <= 1 && peak; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && sgn(z[(j + dj) * w + i + di]) > c) { peak = false; break; }
        if (!peak) continue;
        const l = sgn(z[j * w + i - 1]), rr = sgn(z[j * w + i + 1]), u = sgn(z[(j - 1) * w + i]), dd = sgn(z[(j + 1) * w + i]);
        const dx = l - 2 * c + rr < 0 ? clamp(0.5 * (l - rr) / (l - 2 * c + rr), -0.5, 0.5) : 0;
        const dy = u - 2 * c + dd < 0 ? clamp(0.5 * (u - dd) / (u - 2 * c + dd), -0.5, 0.5) : 0;
        const st = applySim(inv, crop.x0 + pool * (i + 0.5 + dx), crop.y0 + pool * (j + 0.5 + dy));
        if (chi2(st.x - pred.x, st.y - pred.y, gate) > this.P.track.gateChi2) continue;
        if (!best || c > best.z) best = { x: st.x, y: st.y, z: c, polarity: z[j * w + i] >= 0 ? 1 : -1 };
      }
      const half = this.P.roi.zmapHalf, side = 2 * half + 1, data = new Int8Array(side * side), zs = this.P.roi.zmapScale;
      for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
        const u = uc - half + i, v = vc - half + j;
        if (u >= 0 && v >= 0 && u < w && v < h) data[j * side + i] = clamp(Math.round(zs * z[v * w + u]), -127, 127);
      }
      const corner = applySim(inv, crop.x0 + pool * (uc - half), crop.y0 + pool * (vc - half));
      const zmap = { index, t: fr.t, x0: corner.x, y0: corner.y, pool, w: side, h: side, data, zScale: zs };
      const nullScores = [1, 2].map(q => { const g = this.field(index, q, pred.d); if (!g) return 0; let m = 0; for (const v of g.z) m = Math.max(m, Math.abs(v)); return m; });
      const observation = best ? {
        index, t: fr.t, x: best.x, y: best.y, sigma: Math.max(0.5, 1.5 * (pred.d / 2 + 0.7) / best.z),
        z: best.z, z1: best.z, d: null, polarity: best.polarity, src: 'peak', flag: 'inlier'
      } : null;
      return { index, t: fr.t, observation, zmap, score: best?.z ?? 0, threshold: zThresh, nullScores };
    }
  };
}
