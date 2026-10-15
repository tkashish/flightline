/**
 * U2 coarse scan (FINAL pipeline P1, D3 §2.1, §3.2-3.3, §4.3). Every pushed frame (the pipeline decimates only
 * above 60 fps: scanStride) is analyzed at the coarse long edge (about 960):
 *   camera similarity against a keyframe (camera-motion.js) -> registered frame-difference energy cells
 *   -> box-DoG candidates -> spot tracker and vacate watches (spots.js) -> horizon about once a second.
 * finish() returns the CoarseLog: camera track, spots, vacates (every candidate, `valid` marks passes), the
 * energy store (pass-energy disks, active-cell fractions, motion masks), horizon, movers and lens specks.
 *
 * Protocol note (E2 fix round, checker gap 4; for U5/E3 in flight-model.js, which consumes CoarseLog.horizon):
 * CoarseLog.horizon is {kind, slope, y0, conf} | null in stabilized native px, the line y = y0 + slope·x (y down).
 *  - kind 'skyline' (what estimateHorizon finds): the lower edge of the open sky, i.e. the top of whatever meets
 *    the sky (tree line, hills, buildings, or the ground itself when nothing stands on it). The geometric horizon
 *    (the ground plane's vanishing line, where the pitch/roll priors live) lies ON OR BELOW it in the image:
 *    y_horizon(x) >= y_skyline(x) − a few px of fit error. It is a ONE-SIDED pitch bound: tree lines at 100-400 m
 *    stand 1-8° tall, and on the frozen synth-1.1 clips the sky line sits 1.9-5.7° above the true horizon. Its
 *    slope is only a weak roll hint (crown heights vary along the line: slope − (−tan roll) reached 0.05 there).
 *  - kind 'horizon': the line is the geometric horizon itself (sky meeting open ground or water, nothing standing
 *    on it); tight pitch/roll priors apply. Not emitted yet (no test here separates the two cases reliably), but
 *    consumers must accept it. A missing kind (older logs) means 'skyline'.
 *  - conf: fraction of sampled columns on the fitted line.
 */
import { PARAMS, scanStride } from './params.js';
import { HFError, applySim, invertSim, coarsePool, makeCoarseLog } from './types.js';
import { MotionTracker, motionFrame, halfLuma } from './camera-motion.js';
import { CandidateDetector, SpotTracker, noiseSigma } from './spots.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const ENERGY_BLOCK = 16;     // energy registration block (half-res px): one sub-pixel shift per block
const HORIZON_MIN_EDGE = 10; // horizon: per-column sky/ground step at least this (levels); numeric internal, not in PARAMS

/* ------------------------------------------------------------------ registered frame-difference energy */

/**
 * Per analyzed frame, |cur − registered prev| summed per cell over pixels above energy.diffMin, computed on the
 * 1/2-res pyramid level (4× cheaper; a cell of energy.cellPx coarse px is (cellPx/2)² half-res px). The previous
 * frame is registered by the camera similarity with one sub-pixel shift per 16-px block (bilinear, 8-bit fixed
 * point); a pixel above the threshold must also fall outside the luma range of the previous frame's ±1 half-res px
 * neighbourhood of the registered position (its energy is the distance outside that range), so static texture
 * and sharp small objects stay silent under shake, drift and slight rotation, while anything arriving or leaving
 * registers. Cells hold the mean energy per coarse px (uint8), stored sparse when few are active.
 */
export class EnergyRecorder {
  constructor(w, h, pool, params = PARAMS) {
    const E = params.scan.energy;
    this.w = w; this.h = h; this.pool = pool; this.cell = E.cellPx; this.diffMin = E.diffMin;
    if (this.cell % 2) throw new HFError('bad-arg', `energy cell ${this.cell} must be even (half-res cells)`);
    this.cw = Math.ceil(w / this.cell); this.ch = Math.ceil(h / this.cell);
    this.acc = new Uint32Array(this.cw * this.ch); this.dense = new Uint8Array(this.cw * this.ch);
    this.recent = new Uint8Array(this.cw * this.ch);   // analyzed frames since each cell last moved, counting down
    this.frames = []; this.index = []; this.sims = []; this.total = [];
  }
  /** Cells that moved within the last `frames` analyzed frames (raw coords of the last frame; a keyframe mask). */
  recentMask() { return { data: this.recent, w: this.cw, h: this.ch, cellPx: this.cell }; }
  /**
   * prev / cur: half-res images {data, w, h} of consecutive analyzed frames (prev null on the first frame);
   * M: similarity from prev raw coarse px to cur raw coarse px; S: this frame's stabilized->raw native sim.
   */
  add(index, prev, cur, M, S, memory = 30) {
    const { cw, diffMin } = this, acc = this.acc, hc = this.cell >> 1;
    acc.fill(0);
    if (prev && M) {
      const w = cur.w, h = cur.h, P = prev.data, Cd = cur.data, B = ENERGY_BLOCK;
      const I = invertSim({ a: M.a, b: M.b, tx: M.tx / 2, ty: M.ty / 2 });   // cur half-res -> prev half-res
      for (let by = 0; by < h; by += B) for (let bx = 0; bx < w; bx += B) {
        const c = applySim(I, bx + B / 2, by + B / 2), sx = c.x - bx - B / 2, sy = c.y - by - B / 2;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = Math.round((sx - ix) * 16), fy = Math.round((sy - iy) * 16);
        const w00 = (16 - fx) * (16 - fy), w10 = fx * (16 - fy), w01 = (16 - fx) * fy, w11 = fx * fy;
        // keep the ±1 px neighbourhood of the bilinear support inside the frame
        const x0 = Math.max(bx, 1 - ix), x1 = Math.min(bx + B, w - 2 - ix), y0 = Math.max(by, 1 - iy), y1 = Math.min(by + B, h - 2 - iy);
        const nr = (fy >= 8 ? w : 0) + (fx >= 8 ? 1 : 0);   // nearest prev pixel of the registered position
        for (let y = y0; y < y1; y++) {
          const crow = ((y / hc) | 0) * cw;
          for (let x = x0, q = (y + iy) * w + x + ix, r = y * w + x; x < x1; x++, q++, r++) {
            const c = Cd[r], v = (w00 * P[q] + w10 * P[q + 1] + w01 * P[q + w] + w11 * P[q + w + 1] + 128) >> 8;
            let e = c - v; if (e < 0) e = -e;
            if (e <= diffMin) continue;
            // interpolation cannot reproduce a sharp small object at a new sub-pixel phase: a value inside the range
            // of the previous frame's ±1 px neighbourhood is not motion; energy is the distance outside that range
            let lo = 255, hi = 0;
            for (let t = q + nr - w - 1, k = 0; k < 3; k++, t += w) for (let u = 0; u < 3; u++) { const g = P[t + u]; if (g < lo) lo = g; if (g > hi) hi = g; }
            e = c < lo ? lo - c : c > hi ? c - hi : 0;
            if (e > diffMin) acc[crow + ((x / hc) | 0)] += e;
          }
        }
      }
    }
    const area = hc * hc, n = acc.length, d = this.dense;
    let on = 0, tot = 0;
    const rc = this.recent, mem = Math.min(255, Math.max(1, memory));
    for (let i = 0; i < n; i++) { const s = acc[i]; d[i] = s ? Math.min(255, Math.ceil(s / area)) : 0; if (s) { on++; tot += s; rc[i] = mem; } else if (rc[i]) rc[i]--; }
    let rec;
    if (on * 5 < n) {
      const sp = new Uint32Array(on);
      for (let i = 0, k = 0; i < n; i++) if (d[i]) sp[k++] = (i << 8) | d[i];
      rec = { sparse: sp };
    } else rec = { dense: d.slice() };
    this.frames.push(rec); this.index.push(index); this.sims.push(S); this.total.push(tot * 4);
  }
  /** Active cells of the last added frame: {data, w, h, cellPx} in coarse px (for keyframe patch exclusion). */
  lastMask() { return { data: this.dense, w: this.cw, h: this.ch, cellPx: this.cell }; }

  /** @returns {import('./types.js').EnergyStore} queries in stabilized native px */
  store() {
    const { cw, ch, cell, pool, frames } = this, ix = Int32Array.from(this.index), sims = this.sims, area = cell * cell, cpx = cell * pool; // area: coarse px per cell
    const nearest = index => {
      let lo = 0, hi = ix.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ix[m] < index) lo = m + 1; else hi = m; }
      return lo > 0 && Math.abs(ix[lo - 1] - index) <= Math.abs(ix[lo] - index) ? lo - 1 : lo;
    };
    // a sparse frame is expanded once into a dense scratch and reused while queries stay on that frame (callers loop
    // frames outermost); scanning the sparse list per query made swing envelopes cost up to 1.5 s per clip
    let cacheK = -1, cache = null;
    const denseOf = k => {
      const rec = frames[k];
      if (rec.dense) return rec.dense;
      if (cacheK !== k) {
        cache ??= new Uint8Array(cw * ch);
        cache.fill(0);
        for (const v of rec.sparse) cache[v >>> 8] = v & 255;
        cacheK = k;
      }
      return cache;
    };
    const cellsIn = (k, x, y, r, fn) => {
      const q = applySim(sims[k], x, y), cx = q.x / cpx, cy = q.y / cpx, rc = r / cpx, d = denseOf(k);
      const i0 = Math.max(0, Math.floor(cx - rc - 0.5)), i1 = Math.min(cw - 1, Math.floor(cx + rc - 0.5) + 1);
      const j0 = Math.max(0, Math.floor(cy - rc - 0.5)), j1 = Math.min(ch - 1, Math.floor(cy + rc - 0.5) + 1);
      const within = (i, j) => (i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= rc * rc || (i === Math.floor(cx) && j === Math.floor(cy));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (within(i, j)) fn(d[j * cw + i]);
    };
    return {
      cellPx: cpx,
      disk(x, y, r, i0, i1) {
        const ks = [];
        for (let k = 0; k < ix.length; k++) if (ix[k] >= i0 && ix[k] <= i1) ks.push(k);
        const index = new Int32Array(ks.length), e = new Float32Array(ks.length);
        ks.forEach((k, j) => { let s = 0; cellsIn(k, x, y, r, v => { s += v; }); index[j] = ix[k]; e[j] = s * area; });
        return { index, e };
      },
      active(index, x, y, r) {
        if (!ix.length) return 0;
        let on = 0, all = 0;
        cellsIn(nearest(index), x, y, r, v => { all++; if (v) on++; });
        return all ? on / all : 0;
      },
      /** Extension: union of active cells over frames [i0, i1] on the reference-frame grid (SwingEnvelope shape). */
      union(i0, i1) {
        const mask = new Uint8Array(cw * ch);
        for (let k = 0; k < ix.length; k++) {
          if (ix[k] < i0 || ix[k] > i1) continue;
          const inv = invertSim(sims[k]), rec = frames[k];
          const mark = c => { const i = c % cw, j = (c - i) / cw, p = applySim(inv, (i + 0.5) * cpx, (j + 0.5) * cpx), u = Math.floor(p.x / cpx), v = Math.floor(p.y / cpx); if (u >= 0 && v >= 0 && u < cw && v < ch) mask[v * cw + u] = 1; };
          if (rec.dense) { for (let c = 0; c < rec.dense.length; c++) if (rec.dense[c]) mark(c); } else for (const v of rec.sparse) mark(v >>> 8);
        }
        return { x0: 0, y0: 0, cellPx: cpx, w: cw, h: ch, mask };
      }
    };
  }
}

/* ------------------------------------------------------------------ horizon */

/**
 * Dominant near-horizontal boundary between a smooth bright region above and texture below (D3 §5.1, D2 §4.8):
 * per column the best such edge, then a robust line through them. conf = fraction of columns on the line.
 * That boundary is where the sky ends, so the result is a sky line (kind 'skyline', see the header): the
 * geometric horizon lies on or below it.
 * Returns {kind, slope, y0, conf} in the frame's raw coarse px, or null.
 */
export function estimateHorizon(img, { params = PARAMS } = {}) {
  const { data, w, h } = img, Hp = params.scan.horizon, win = Math.max(4, Math.round(h / 80)), tw = 2 * win;
  const xs = [], ys = [];
  const colStep = Math.max(2, Math.round(w / 64)), yA = Math.max(tw, Math.round(0.05 * h)), yB = Math.min(h - tw - 1, Math.round(0.95 * h));
  const lum = new Float64Array(h + 1), tex = new Float64Array(h + 1);
  for (let x = 2; x < w - 2; x += colStep) {
    for (let y = 0; y < h; y++) {
      const o = y * w + x, v = (data[o - 1] + data[o] + data[o + 1]) / 3;
      lum[y + 1] = lum[y] + v; tex[y + 1] = tex[y] + Math.abs(data[o + 2] - data[o]) + Math.abs(data[o] - data[o - 2]);
    }
    let best = 0, by = -1;
    for (let y = yA; y <= yB; y++) {
      const g = (lum[y] - lum[y - win]) / win - (lum[y + win] - lum[y]) / win;
      const ta = (tex[y] - tex[y - tw]) / tw, tb = (tex[y + tw] - tex[y]) / tw;
      if (g <= 0 || tb < 1.4 * ta + 0.5) continue;      // brighter above, more texture below
      const s = g + 0.5 * (tb - ta);
      if (s > best) { best = s; by = y; }
    }
    if (by >= 0 && best >= HORIZON_MIN_EDGE) { xs.push(x + 0.5); ys.push(by); }
  }
  const cols = Math.ceil((w - 4) / colStep);
  if (xs.length < Math.max(4, Hp.minConf * cols)) return null;
  // robust line: best two-point hypothesis by support, then least squares on its inliers
  const tol = Math.max(2, 0.01 * h), maxSlope = Math.tan(Hp.maxTiltDeg * Math.PI / 180), n = xs.length;
  let bestIn = null;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 24))) for (let j = i + 1; j < n; j += Math.max(1, Math.floor(n / 24))) {
    const m = (ys[j] - ys[i]) / (xs[j] - xs[i]);
    if (!(Math.abs(m) <= maxSlope)) continue;
    const inl = [];
    for (let k = 0; k < n; k++) if (Math.abs(ys[i] + m * (xs[k] - xs[i]) - ys[k]) <= tol) inl.push(k);
    if (!bestIn || inl.length > bestIn.length) bestIn = inl;
  }
  if (!bestIn || bestIn.length < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const k of bestIn) { sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; }
  const m = bestIn.length, den = m * sxx - sx * sx, slope = den ? (m * sxy - sx * sy) / den : 0, y0 = (sy - slope * sx) / m;
  if (!(Math.abs(slope) <= maxSlope)) return null;
  return { kind: 'skyline', slope, y0, conf: Math.min(1, m / cols) };
}

/** A raw coarse-px line of frame S (stabilized->raw native sim) as a stabilized native-px Horizon (kind kept). */
function horizonToStab(hz, S, pool, w) {
  const inv = invertSim(S), a = applySim(inv, 0, pool * hz.y0), b = applySim(inv, pool * w, pool * (hz.y0 + hz.slope * w));
  const slope = (b.y - a.y) / (b.x - a.x);
  return { kind: hz.kind ?? 'skyline', slope, y0: a.y - slope * a.x, conf: hz.conf };
}

/* ------------------------------------------------------------------ pass energy (D1 §3.3(2)) */

/**
 * Runs of a pass-energy series: contiguous frames with E > max(runVsMedian·median, runVsMax·max); a run is strong
 * when its peak >= max(strongVsMedian·median, strongVsMax·max). Returns [{i0, i1, k0, k1, peak, strong}].
 */
export function energyRuns(index, e, params = PARAMS) {
  const E = params.scan.energy, n = e.length;
  if (!n) return [];
  const sorted = Float64Array.from(e).sort(), med = sorted[n >> 1], max = sorted[n - 1];
  if (!(max > 0)) return [];
  const thr = Math.max(E.runVsMedian * med, E.runVsMax * max), strong = Math.max(E.strongVsMedian * med, E.strongVsMax * max), out = [];
  for (let i = 0; i < n; i++) {
    if (!(e[i] > thr)) continue;
    let j = i, peak = 0;
    while (j < n && e[j] > thr) { peak = Math.max(peak, e[j]); j++; }
    out.push({ i0: i, i1: j - 1, k0: index[i], k1: index[j - 1], peak, strong: peak >= strong });
    i = j;
  }
  return out;
}

/**
 * Pass energy around a vacated address (D1 §3.3(2)-(3a), FINAL launch): small disk r_s = max(smallDisk.d0·d0,
 * fracH·H), large disk r_l = max(largeDisk.d0·d0, fracH·H), their runs over the clip, and the soft impact-timing
 * support (a strong small-disk run within ±timingFrames of the vacate). A soft score for findImpacts, never a gate.
 */
export function passEnergy(store, spot, vac, frames, meta, params = PARAMS) {
  const E = params.scan.energy, H = meta.height, i0 = frames[0], i1 = frames[frames.length - 1];
  const rs = Math.max(E.smallDisk.d0 * spot.d, E.smallDisk.fracH * H), rl = Math.max(E.largeDisk.d0 * spot.d, E.largeDisk.fracH * H);
  const small = store.disk(spot.x, spot.y, rs, i0, i1), large = store.disk(spot.x, spot.y, rl, i0, i1);
  const rsRuns = energyRuns(small.index, small.e, params), rlRuns = energyRuns(large.index, large.e, params);
  const a = vac.kLast - E.timingFrames, b = vac.kFirstAbsent + E.timingFrames;
  const at = rsRuns.find(r => r.strong && r.k1 >= a && r.k0 <= b) ?? null;
  const sorted = Float64Array.from(small.e).sort(), med = sorted[sorted.length >> 1] || 0;
  return {
    smallRadius: rs, largeRadius: rl, timing: !!at, peak: at ? at.peak : 0, peakVsMedian: at ? at.peak / Math.max(med, 1) : 0,
    runs: { small: rsRuns.map(({ k0, k1, peak, strong }) => ({ k0, k1, peak, strong })), large: rlRuns.map(({ k0, k1, peak, strong }) => ({ k0, k1, peak, strong })) }
  };
}

/* ------------------------------------------------------------------ scanner */

export class CoarseScanner {
  /** @param {import('./types.js').SourceMeta} meta */
  constructor(meta, { params = PARAMS } = {}) {
    if (!(meta?.width > 0 && meta?.height > 0 && meta?.fps > 0)) throw new HFError('bad-arg', 'CoarseScanner needs meta.width, height, fps');
    this.meta = meta; this.params = params;
    this.pool = coarsePool(meta.width, meta.height, params.scan.longEdge);
    this.w = Math.floor(meta.width / this.pool); this.h = Math.floor(meta.height / this.pool);
    this.stride = scanStride(meta.fps, params);
    this.memory = Math.max(1, Math.ceil(meta.fps / this.stride));   // keyframe motion memory: about 1 s of analyzed frames
    this.motion = new MotionTracker(meta, { pool: this.pool, params });
    this.detector = new CandidateDetector(this.w, this.h, { params });
    this.spots = new SpotTracker(meta, { pool: this.pool, params, stride: this.stride });
    this.energy = new EnergyRecorder(this.w, this.h, this.pool, params);
    this.buf = [new Uint8Array(this.w * this.h), new Uint8Array(this.w * this.h)];
    this.mfs = [null, null]; this.half = [null, null]; this.index = []; this.t = [];
    this.horizons = []; this.lastHorizon = -Infinity; this.hist = new Uint32Array(256);
    this.ms = { camera: 0, energy: 0, detect: 0, spots: 0, horizon: 0 };
  }

  /**
   * img = await ref.lumaCoarse(params.scan.longEdge) for frames from, from + stride, ... in order. img.data may
   * be reused by the caller after push returns (it is copied).
   */
  push(index, t, img) {
    const n = this.index.length, { w, h } = this;
    if (!img || img.w !== w || img.h !== h || (img.pool ?? this.pool) !== this.pool || !(img.data?.length >= w * h)) {
      throw new HFError('bad-arg', `coarse frame ${img?.w}×${img?.h}/${img?.pool}, expected ${w}×${h}/${this.pool}`);
    }
    if (!Number.isInteger(index) || (n && index <= this.index[n - 1])) throw new HFError('bad-arg', `frame ${index} not increasing`);
    const slot = n & 1, cur = this.buf[slot], prev = n ? this.buf[slot ^ 1] : null;
    cur.set(img.data.subarray(0, w * h));
    let t0 = now();
    const mf = motionFrame({ data: cur, w, h }, { params: this.params, reuse: this.mfs[slot] });
    this.mfs[slot] = mf;
    // the first frame's horizon keeps camera patches on the ground (frame 0 is the stabilized reference)
    if (!n) {
      const hz = estimateHorizon(mf.levels[0], { params: this.params });
      if (hz && hz.conf >= this.params.scan.horizon.minConf) this.motion.setSkyLine({ slope: hz.slope, y0: hz.y0 * this.pool });
    }
    // lens-fixed specks found so far are masked out of the camera patches (raw coords are frame-independent)
    const specks = this.spots.speckBoxes(), exclude = specks.length ? specks : undefined;
    const { S } = this.motion.push(index, t, mf, { exclude, foreground: n ? this.energy.lastMask() : undefined });
    let t1 = now(); this.ms.camera += t1 - t0;
    const half = mf.levels[1] ?? halfLuma(cur, w, h);
    this.half[slot] = half;
    this.energy.add(index, n ? this.half[slot ^ 1] : null, half, n ? this.motion.relCoarse(n - 1, n) : null, S, this.memory);
    // a new key avoids everything that moved in the last second (the golfer's swing), not just the last frame
    this.motion.maybeRefreshKey(mf, index, { exclude, excludeMask: n ? this.energy.recentMask() : undefined });
    t0 = now(); this.ms.energy += t0 - t1;
    const cands = this.detector.detect(cur, { large: this.spots.largest > this.params.scan.candidates.largeBlobPx });
    t1 = now(); this.ms.detect += t1 - t0;
    this.spots.push(index, t, { data: cur, w, h, pool: this.pool }, cands, S, { detector: this.detector, noise: noiseSigma(cur, w, h, this.hist), motion: n ? this.energy.lastMask() : null });
    t0 = now(); this.ms.spots += t0 - t1;
    if (index - this.lastHorizon >= this.meta.fps) {
      const hz = estimateHorizon(mf.levels[0], { params: this.params });
      if (hz) {
        const st = horizonToStab(hz, S, this.pool, w);
        this.horizons.push(st);
        if (st.conf >= this.params.scan.horizon.minConf) this.motion.setSkyLine(st);
      }
      this.lastHorizon = index;
      this.ms.horizon += now() - t0;
    }
    this.index.push(index); this.t.push(t);
  }

  /** @returns {import('./types.js').CoarseLog} plus extension fields candidates, motionEnergy, diagnostics */
  finish() {
    if (!this.index.length) throw new HFError('bad-arg', 'CoarseScanner.finish: no frames were pushed');
    const P = this.params.scan, res = this.spots.finish();
    const good = this.horizons.filter(hz => hz.conf >= P.horizon.minConf).sort((a, b) => b.conf - a.conf);
    const horizon = good.length ? good[0] : null;
    const nf = this.index.length, ms = Object.fromEntries(Object.entries(this.ms).map(([k, v]) => [k, v / nf]));
    const log = makeCoarseLog({
      pool: this.pool, w: this.w, h: this.h, stride: this.stride,
      frames: { index: Int32Array.from(this.index), t: Float64Array.from(this.t) },
      camera: this.motion.path.track(), spots: res.spots, vacates: res.vacates, energy: this.energy.store(), horizon,
      movers: res.movers, specks: res.specks
    });
    // extension: D1 pass-energy runs and timing support for every eligible vacate (soft evidence for U3)
    for (const v of log.vacates) {
      const sp = v.eligible ? log.spots.find(q => q.id === v.spotId) : null;
      v.passEnergy = sp ? passEnergy(log.energy, sp, v, log.frames.index, this.meta, this.params) : null;
    }
    log.candidates = res.candidates;
    log.motionEnergy = Float32Array.from(this.energy.total);
    log.diagnostics = { msPerFrame: ms, camera: { ...this.motion.stats }, horizons: this.horizons.length };
    return log;
  }
}
