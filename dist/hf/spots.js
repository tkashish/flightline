/**
 * U2 candidates and spots (D3 §3.2-3.3 with the D1 §3.2-3.3 grafts, FINAL launch).
 *
 * detectCandidates: box-DoG at scan.candidates.dogRadii (+ dogRadiiLarge for big address balls) on a stride-2
 * grid, refined at full coarse res; both polarities; z = |DoG| / (1.4826·median|DoG|) per tile; per-tile and
 * per-frame caps; blob region above 0.3 of the peak (centroid, area diameter, luma) with its shape (second-moment
 * axis ratio sqrt(λ1/λ2), bbox fill) taken from the region eroded by one pixel.
 *
 * SpotTracker links candidates in stabilized coordinates and probes established spots locally every frame,
 * so 1-3 px shake and odd or sub-pixel drift never wipe the address history (v2 tracker-detection-I4). An
 * established spot that disappears opens a time-limited vacate watch (presence probe, occlusion recovery within
 * vacate.recover, absence window, pre/post patches). finish() applies the D3 §3.3 tests (persistence, NCC change,
 * stable post patch, impulse, gradual-departure veto, surround, duplicate) and extracts pre-impact / sky movers and
 * lens-fixed specks.
 * Coordinates: candidates in coarse px of the raw frame; spots, vacates and movers in stabilized native px.
 *
 * Protocol note (E2 fix round, checker gap 11): R1 last-to-leave and the D1 arrival veto have ONE owner, U3's
 * findImpacts (impact.js), with one semantics (pairwise clusters, windows from the τ prior). This file only
 * measures what they need: Spot.arrivalMovers (same-looking objects that approached the spot just before it first
 * appeared), the spot position and diameter, and VacateEvent.kLast. VacateEvent.valid covers only the tests above;
 * Spot.clusterId (transitive, clusterD mean diameters) is report-only.
 */
import { PARAMS, spanFrames, scanStride } from './params.js';
import { HFError, applySim, invertSim, makeSpot, makeVacate } from './types.js';

/** Numeric internals, not decision thresholds (not in PARAMS; integrator may promote them). */
export const SPOT_INTERNALS = Object.freeze({
  sigmaFloor: 0.4,        // tile DoG noise floor (levels): flat synthetic tiles must not give infinite z
  preZFrac: 0.6,          // grid pre-threshold as a fraction of zMin before full-res refinement (frac)
  explainFrac: 0.8,       // inner mean − annulus median must reach 0.8 × the box-DoG response (no side-lobes of a bright neighbour)
  sectorFrac: 0.4,        // ... and inner mean − each annulus quadrant's mean at least 0.4 × that contrast (stands out on every side)
  measureCap: 4,          // blob measurements per frame at most 4 × scan.candidates.maxPerFrame (count) ...
  measurePerTile: 1.34,   // ... or this many per MAD tile when that is more (the 540×960 design frame has 144 tiles), so
                          // a 1280×720 coarse frame keeps the same budget per area (count/tile)
  coreMinPx: 12,          // roundness comes from the 1-px-eroded blob region when it keeps this many px (px)
  regionFrac: 0.3,        // blob region: pixels above 0.3 × the peak amplitude over the annulus median, so a shaded ball's
                          // dark side is included (a half-max cut keeps only the lit crescent)
  presentFrac: 0.5,       // per-frame presence: probe response >= 0.5 × the spot's median response (D2 §3.1)
  relinkD: 0.6,           // after a missed frame the spot re-links within 0.6 diameters (a half-hidden ball's centroid shifts when uncovered) ...
  relinkGrow: 1.3,        // ... when the candidate is at least 1.3× the spot's diameter (it was partly hidden)
  probeAfter: 3,          // tentative spots are probed once seen this many times (frames)
  ring: 16,               // per-spot measurement ring for medians (count)
  sizeRatio: [0.4, 2.5],  // same-object size ratio for arrival / departure tracks (D1 §3.2 match tolerance)
  noiseK: 3,              // patch NCC / stability regularizer: (3·σ_noise)² treats noise-level patches as flat
  noiseFloor: 1,          // σ_noise floor (levels)
  departFrames: 12,       // departure tracks are followed at most this many container frames after k_last
  departMaxPts: 6,        // ... and at most this many points
  moverFitPx: 1,          // mover tracklet: constant-velocity RMS at most max(1 px, 0.25·d) (coarse px)
  moverFitD: 0.25,        // (d)
  moverInitFrac: 0.05,    // mover tracklet: first link within 0.05 × long side per frame (frac)
  skyMinSpeedPx: 0.15,    // sky mover: slower than scan.movers.minSpeedPx but at least this (coarse px/frame)
  speckLinkPx: 1          // lens speck: raw-position link radius before the maxRawMovePx test (coarse px)
});
const K = SPOT_INTERNALS;

/* ------------------------------------------------------------------ candidates */

/**
 * Box-DoG detector with buffers for one coarse size; also answers local probes on the last detected frame.
 * Scale (ri, ro) is evaluated on a grid of stride 2·max(1, ri) px, so every scale costs about the same, then
 * refined at full res within ±stride/2.
 */
export class CandidateDetector {
  constructor(w, h, { params = PARAMS } = {}) {
    if (!(w > 0 && h > 0)) throw new HFError('bad-arg', `detector size ${w}×${h}`);
    const Pc = params.scan.candidates;
    this.w = w; this.h = h; this.params = params; this.W1 = w + 1;
    this.sat = new Int32Array((w + 1) * (h + 1));
    this.scales = [...Pc.dogRadii, Pc.dogRadiiLarge];
    this.grid = this.scales.map(([ri]) => { const g = 2 * Math.max(1, ri), gw = Math.ceil(w / g), gh = Math.ceil(h / g); return { g, gw, gh, D: new Float32Array(gw * gh) }; });
    this.tile = Pc.tilePx; this.ntx = Math.ceil(w / this.tile); this.nty = Math.ceil(h / this.tile);
    this.sigma = this.scales.map(() => new Float32Array(this.ntx * this.nty).fill(K.sigmaFloor));
    this.thr = new Float32Array(this.ntx * this.nty);
    this.hist = new Uint32Array(256);
    const R = 2 * Math.max(...this.scales.map(s => s[1])), n = (2 * R + 1) ** 2;   // half-max regions may reach 2·ro
    this.stack = new Int32Array(n); this.seen = new Uint8Array(n); this.inR = new Uint8Array(n); this.pix = new Int32Array(n);
    this.qs = new Float64Array(4); this.qn = new Uint32Array(4); this.per = new Uint8Array(this.ntx * this.nty);
    const cap = 8192;
    this.pk = { cap, z: new Float32Array(cap), x: new Int32Array(cap), y: new Int32Array(cap), s: new Int8Array(cap), r: new Float32Array(cap), order: new Uint32Array(cap) };
    this.data = null; this.large = false;
  }
  integral(data) {
    const w = this.w, h = this.h, W1 = this.W1, S = this.sat;
    for (let y = 0; y < h; y++) {
      let row = 0, o = (y + 1) * W1 + 1, p = y * W1 + 1, q = y * w;
      for (let x = 0; x < w; x++) { row += data[q + x]; S[o + x] = S[p + x] + row; }
    }
    this.data = data;
  }
  boxSum(x0, y0, x1, y1) {
    const W1 = this.W1, S = this.sat;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(this.w, x1); y1 = Math.min(this.h, y1);
    if (x1 <= x0 || y1 <= y0) return { s: 0, n: 0 };
    return { s: S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0], n: (x1 - x0) * (y1 - y0) };
  }
  /** Signed box-DoG at pixel (x, y) for scale s; 0 where the outer box leaves the frame. */
  dogAt(s, x, y) {
    const [ri, ro] = this.scales[s];
    if (x < ro || y < ro || x + ro >= this.w || y + ro >= this.h) return 0;
    const W1 = this.W1, S = this.sat, b = y * W1 + x;
    const I = S[b + (ri + 1) * W1 + ri + 1] - S[b - ri * W1 + ri + 1] - S[b + (ri + 1) * W1 - ri] + S[b - ri * W1 - ri];
    const O = S[b + (ro + 1) * W1 + ro + 1] - S[b - ro * W1 + ro + 1] - S[b + (ro + 1) * W1 - ro] + S[b - ro * W1 - ro];
    return I / ((2 * ri + 1) ** 2) - O / ((2 * ro + 1) ** 2);
  }
  sigmaAt(s, x, y) { return this.sigma[s][Math.min(this.nty - 1, Math.floor(y / this.tile)) * this.ntx + Math.min(this.ntx - 1, Math.floor(x / this.tile))]; }

  /**
   * Candidates of one coarse frame (coarse px, raw frame): {x, y, d, z, resp, polarity, contrast, roundness,
   * fill, luma, scale}. large: also run scan.candidates.dogRadiiLarge.
   */
  detect(data, { large = false } = {}) {
    const P = this.params.scan.candidates, w = this.w, h = this.h, W1 = this.W1, S = this.sat, tile = this.tile, ntx = this.ntx, nty = this.nty;
    this.integral(data); this.large = large;
    const ns = large ? this.scales.length : this.scales.length - 1, pk = this.pk;
    let nf = 0;
    for (let s = 0; s < ns; s++) {
      const [ri, ro] = this.scales[s], { g, gw, gh, D } = this.grid[s], o2 = g >> 1;
      const ai = 1 / ((2 * ri + 1) ** 2), ao = 1 / ((2 * ro + 1) ** 2);
      const iA = -ri * W1 - ri, iB = -ri * W1 + ri + 1, iC = (ri + 1) * W1 - ri, iD = (ri + 1) * W1 + ri + 1;
      const oA = -ro * W1 - ro, oB = -ro * W1 + ro + 1, oC = (ro + 1) * W1 - ro, oD = (ro + 1) * W1 + ro + 1;
      // grid point (i, j) is pixel (g·i + g/2, g·j + g/2); keep the outer box inside the frame
      const i0 = Math.max(0, Math.ceil((ro - o2) / g)), i1 = Math.min(gw - 1, Math.floor((w - 1 - ro - o2) / g));
      const j0 = Math.max(0, Math.ceil((ro - o2) / g)), j1 = Math.min(gh - 1, Math.floor((h - 1 - ro - o2) / g));
      D.fill(0);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0, q = j * gw + i0, b = (g * j + o2) * W1 + g * i0 + o2; i <= i1; i++, q++, b += g) {
          D[q] = (S[b + iD] - S[b + iB] - S[b + iC] + S[b + iA]) * ai - (S[b + oD] - S[b + oB] - S[b + oC] + S[b + oA]) * ao;
        }
      }
      // tile noise: 1.4826·median|DoG| over the tile's grid points (subsampled to about 15×15), 0.25-level bins
      const sig = this.sigma[s], thr = this.thr, hist = this.hist, per = tile / g, step = Math.max(1, Math.round(per / 15)), pre = P.zMin * K.preZFrac;
      for (let ty = 0; ty < nty; ty++) for (let tx = 0; tx < ntx; tx++) {
        hist.fill(0);
        let n = 0;
        const ga = Math.max(i0, Math.ceil(tx * per)), gb = Math.min(i1 + 1, Math.ceil((tx + 1) * per)), ha = Math.max(j0, Math.ceil(ty * per)), hb = Math.min(j1 + 1, Math.ceil((ty + 1) * per));
        for (let j = ha; j < hb; j += step) for (let i = ga; i < gb; i += step) { const v = D[j * gw + i]; hist[Math.min(255, ((v < 0 ? -v : v) * 4) | 0)]++; n++; }
        let m = 0, c = 0;
        if (n) for (; m < 255; m++) { c += hist[m]; if (2 * c >= n) break; }
        const sg = n ? Math.max(K.sigmaFloor, 1.4826 * (m + 0.5) / 4) : K.sigmaFloor;
        sig[ty * ntx + tx] = sg; thr[ty * ntx + tx] = pre * sg;
      }
      // grid maxima of |DoG| above the pre-threshold, refined at full res
      for (let j = Math.max(1, j0); j <= Math.min(gh - 2, j1); j++) {
        const tr = Math.min(nty - 1, ((g * j + o2) / tile) | 0) * ntx;
        for (let i = Math.max(1, i0), q = j * gw + i; i <= Math.min(gw - 2, i1); i++, q++) {
          const v = D[q], a = v < 0 ? -v : v;
          if (a < thr[tr + Math.min(ntx - 1, ((g * i + o2) / tile) | 0)]) continue;
          const pol = v > 0 ? 1 : -1;
          if (pol * D[q - 1] > a || pol * D[q + 1] >= a || pol * D[q - gw] > a || pol * D[q + gw] >= a
            || pol * D[q - gw - 1] > a || pol * D[q - gw + 1] > a || pol * D[q + gw - 1] >= a || pol * D[q + gw + 1] >= a) continue;
          const cx = g * i + o2, cy = g * j + o2;
          let best = 0, bx = cx, by = cy;
          for (let dy = -o2; dy <= o2; dy++) for (let dx = -o2; dx <= o2; dx++) {
            const e = pol * this.dogAt(s, cx + dx, cy + dy);
            if (e > best) { best = e; bx = cx + dx; by = cy + dy; }
          }
          const zz = best / this.sigmaAt(s, bx, by);
          if (zz >= P.zMin && nf < this.pk.cap) { pk.z[nf] = zz; pk.x[nf] = bx; pk.y[nf] = by; pk.s[nf] = s * 2 + (pol > 0 ? 1 : 0); pk.r[nf] = best; nf++; }
        }
      }
    }
    // strongest first: per-tile and per-frame caps, duplicates across scales, then the blob measurement. Tries are
    // bounded so a very textured frame cannot spend unbounded time on rejected blobs; the bound grows with the frame
    // area, so on a large coarse frame (1280×720) texture peaks with a higher z cannot starve the ball
    const order = this.pk.order.subarray(0, nf);
    for (let i = 0; i < nf; i++) order[i] = i;
    order.sort((a, b) => pk.z[b] - pk.z[a]);
    const out = [], per = this.per.fill(0), maxTries = Math.max(K.measureCap * P.maxPerFrame, Math.round(K.measurePerTile * ntx * nty));
    let tries = 0;
    for (let oi = 0; oi < nf && out.length < P.maxPerFrame && tries < maxTries; oi++) {
      const f = order[oi], fx = pk.x[f], fy = pk.y[f], fs = pk.s[f] >> 1, fpol = pk.s[f] & 1 ? 1 : -1;
      const t = Math.min(nty - 1, Math.floor(fy / tile)) * ntx + Math.min(ntx - 1, Math.floor(fx / tile));
      if (per[t] >= P.maxPerTile) continue;
      if (out.some(o => Math.abs(o.x - fx - 0.5) <= Math.max(1.5, 0.5 * o.d) && Math.abs(o.y - fy - 0.5) <= Math.max(1.5, 0.5 * o.d))) continue;
      tries++;
      const m = this.measure(fx, fy, fs, fpol, pk.r[f]);
      if (!m || out.some(o => o.polarity === m.polarity && Math.hypot(o.x - m.x, o.y - m.y) <= Math.max(1.5, 0.5 * Math.max(o.d, m.d)))) continue;
      m.z = pk.z[f]; m.resp = pk.r[f];
      per[t]++;
      out.push(m);
    }
    return out;
  }

  /**
   * Blob at pixel (px, py) for scale s and polarity pol on the last integrated frame; null if none. The background
   * is the median of the ring out to 2·ro (robust to a bright neighbour such as the ball next to a DoG side-lobe);
   * with resp given, the blob must explain explainFrac of that response and stand out on every side (sectorFrac).
   */
  measure(px, py, s, pol, resp = 0) {
    // background: median of the ring between the inner box and 2·ro (wide enough that a ball filling the DoG
    // annulus still sees ground around it), per quadrant for the every-side test
    const d = this.data, w = this.w, h = this.h, [ri, ro] = this.scales[s], hist = this.hist, qs = this.qs, qn = this.qn, Rb = 2 * ro;
    hist.fill(0); qs.fill(0); qn.fill(0);
    let cnt = 0;
    const st = Rb >= 8 ? 2 : 1;   // the median and quadrant means do not need every pixel of a wide ring
    for (let y = Math.max(0, py - Rb); y <= Math.min(h - 1, py + Rb); y += st) {
      const inner = y >= py - ri && y <= py + ri, qy = y < py ? 0 : 2;
      for (let x = Math.max(0, px - Rb); x <= Math.min(w - 1, px + Rb); x += st) {
        if (inner && x >= px - ri && x <= px + ri) continue;
        const v = d[y * w + x], q = qy + (x < px ? 0 : 1);
        hist[v]++; cnt++; qs[q] += v; qn[q]++;
      }
    }
    if (!cnt) return null;
    let bg = 0;
    for (let c = 0; bg < 255; bg++) { c += hist[bg]; if (2 * c >= cnt) break; }
    let A = 0, qx = px, qy = py, sIn = 0, nIn = 0;
    for (let y = Math.max(0, py - ri); y <= Math.min(h - 1, py + ri); y++) for (let x = Math.max(0, px - ri); x <= Math.min(w - 1, px + ri); x++) {
      const v = pol * (d[y * w + x] - bg);
      sIn += v; nIn++;
      if (v > A) { A = v; qx = x; qy = y; }
    }
    if (resp > 0 && sIn / nIn < K.explainFrac * resp) return null;   // the response came from the annulus, not a blob
    // a blob stands out from its surround on every side: ground next to the dark golfer is "bright" only toward him
    if (resp > 0) {
      const inl = sIn / nIn + bg * pol;   // pol·inner mean luma
      for (let q = 0; q < 4; q++) if (qn[q] && inl - pol * qs[q] / qn[q] < K.sectorFrac * (sIn / nIn)) return null;
    }
    if (!(A > 0)) return null;
    const thr = K.regionFrac * A, R = 2 * ro, side = 2 * R + 1, seen = this.seen, stack = this.stack, inR = this.inR, pix = this.pix;
    seen.fill(0, 0, side * side); inR.fill(0, 0, side * side);
    let sp = 0, n = 0, sw = 0, swx = 0, swy = 0, sl = 0;
    stack[sp++] = qy * w + qx; seen[R * side + R] = 1;
    while (sp) {
      const k = stack[--sp], x = k % w, y = (k - x) / w, v = d[k], wv = pol * (v - bg);
      pix[n++] = k; inR[(y - qy + R) * side + x - qx + R] = 1;
      sw += wv; swx += wv * x; swy += wv * y; sl += v;
      for (let e = 0; e < 4; e++) {
        const nx = e === 0 ? x - 1 : e === 1 ? x + 1 : x, ny = e === 2 ? y - 1 : e === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || Math.abs(nx - qx) > R || Math.abs(ny - qy) > R) continue;
        const li = (ny - qy + R) * side + nx - qx + R;
        if (seen[li]) continue;
        seen[li] = 1;
        const nk = ny * w + nx;
        if (pol * (d[nk] - bg) >= thr) stack[sp++] = nk;
      }
    }
    // shape (axis ratio and fill) from the region eroded by one pixel, so a tee stem or a thin glint tail drops
    // out, unless the core is too small
    let core = this.moments(pix, n, inR, qx, qy, R, side, true);
    if (core.m < K.coreMinPx) core = this.moments(pix, n, inR, qx, qy, R, side, false);
    return {
      x: swx / sw + 0.5, y: swy / sw + 0.5, d: 2 * Math.sqrt(n / Math.PI), z: 0, resp: 0, polarity: pol, contrast: pol * A,
      roundness: core.ratio, fill: core.fill, luma: sl / n, scale: s
    };
  }
  /**
   * Second-moment axis ratio sqrt(λ1/λ2) and bounding-box fill of region pixels (eroded: only pixels whose 4
   * neighbours are inside).
   */
  moments(pix, n, inR, qx, qy, R, side, eroded) {
    const w = this.w;
    let m = 0, ax = 0, ay = 0, axx = 0, ayy = 0, axy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const k = pix[i], x = k % w, y = (k - x) / w;
      if (eroded) {
        const li = (y - qy + R) * side + x - qx + R, lx = x - qx, ly = y - qy;
        if (lx <= -R || lx >= R || ly <= -R || ly >= R || !inR[li - 1] || !inR[li + 1] || !inR[li - side] || !inR[li + side]) continue;
      }
      m++; ax += x; ay += y; axx += x * x; ayy += y * y; axy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!m) return { m: 0, ratio: 1, fill: 0 };
    const mx = ax / m, my = ay / m, cxx = axx / m - mx * mx + 1 / 12, cyy = ayy / m - my * my + 1 / 12, cxy = axy / m - mx * my;
    const tr = (cxx + cyy) / 2, dd = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
    // axis ratio sqrt(λ1/λ2): a shaded ball's lit gibbous region stays below 1.8, a tee stem or a glint line does not
    return { m, ratio: Math.sqrt((tr + dd) / Math.max(1e-9, tr - dd)), fill: m / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
  }

  /**
   * Local search on the last integrated frame: best polarity-signed DoG of scale s at pixels within `radius` of
   * (u, v), with the blob measured there. Returns {resp, z, x, y, d, luma, ...} or {resp} when no blob.
   */
  probe(u, v, s, pol, radius) {
    const cx = Math.floor(u), cy = Math.floor(v), R = Math.ceil(radius), lim = (radius + 0.75) ** 2;
    let best = -Infinity, bx = cx, by = cy;
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
      if ((x + 0.5 - u) ** 2 + (y + 0.5 - v) ** 2 > lim) continue;
      const val = pol * this.dogAt(s, x, y);
      if (val > best) { best = val; bx = x; by = y; }
    }
    if (!(best > 0)) return { resp: best > -Infinity ? best : 0 };
    const m = this.measure(bx, by, s, pol);
    if (!m) return { resp: best };
    m.resp = best; m.z = best / this.sigmaAt(s, bx, by);
    return m;
  }
}

/** Box-DoG candidates, both polarities, tile-MAD z, per-tile caps (PARAMS.scan.candidates); coarse px. */
export function detectCandidates(img, { params = PARAMS, large = false } = {}) {
  return new CandidateDetector(img.w, img.h, { params }).detect(img.data, { large });
}

/* ------------------------------------------------------------------ small helpers */

/** Fraction of the analyzed frames over two spot records' combined span in which either record saw its object. */
function unionPresence(p, q) {
  const o0 = Math.min(p.firstOrd, q.firstOrd), o1 = Math.max(p.lastOrd, q.lastOrd);
  const seen = (r, o) => o >= r.firstOrd && o - r.firstOrd < r.nMarked && r.present[o - r.firstOrd] === 1;
  let on = 0;
  for (let o = o0; o <= o1; o++) if (seen(p, o) || seen(q, o)) on++;
  return on / (o1 - o0 + 1);
}

/** Robust σ of 8-bit noise from horizontal neighbour differences on a sparse grid (levels). */
export function noiseSigma(data, w, h, hist = new Uint32Array(256)) {
  hist.fill(0);
  let n = 0;
  for (let y = 1; y < h; y += 7) for (let x = (y % 3) + 1, o = y * w; x < w; x += 5) { const e = data[o + x] - data[o + x - 1]; hist[e < 0 ? -e : e]++; n++; }
  // median of the integer |differences|, interpolated inside its bin (bin m covers [m − 0.5, m + 0.5), bin 0 [0, 0.5))
  let m = 0, c = 0;
  for (; m < 255; m++) { if (2 * (c + hist[m]) >= n) break; c += hist[m]; }
  const f = hist[m] ? (n / 2 - c) / hist[m] : 0.5, med = m ? m - 0.5 + f : 0.5 * f;
  return Math.max(K.noiseFloor, 1.4826 * med / Math.SQRT2);
}

/** Bilinear square patch of `side` coarse px centred at continuous coarse (u, v); edges clamp. */
export function samplePatch(data, w, h, u, v, side, out = new Float32Array(side * side)) {
  const x0 = u - side / 2, y0 = v - side / 2;
  for (let j = 0; j < side; j++) {
    const Y = Math.min(h - 1.001, Math.max(0, y0 + j)), iy = Math.floor(Y), fy = Y - iy;
    for (let i = 0; i < side; i++) {
      const X = Math.min(w - 1.001, Math.max(0, x0 + i)), ix = Math.floor(X), fx = X - ix, k = iy * w + ix;
      out[j * side + i] = data[k] + (data[k + 1] - data[k]) * fx + (data[k + w] - data[k]) * fy + (data[k] - data[k + 1] - data[k + w] + data[k + w + 1]) * fx * fy;
    }
  }
  return out;
}
function moments(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let va = 0, vb = 0, c = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; va += x * x; vb += y * y; c += x * y; }
  return { va: va / n, vb: vb / n, c: c / n };
}
/**
 * Relative change of the median luma of the ring beyond radius rIn (px) between two square patches of side `side`
 * centred on the address: about 0 when the ball left bare ground (its vanished shadow covers a minority of the
 * ring), large when something covered the address. The scanner uses the ring between d and 2·d.
 */
export function ringShift(pre, post, side, rIn) {
  const c = (side - 1) / 2, r2 = rIn * rIn, a = [], b = [];
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) if ((i - c) ** 2 + (j - c) ** 2 > r2) { a.push(pre[j * side + i]); b.push(post[j * side + i]); }
  if (!a.length) return 0;
  const ma = median(a), mb = median(b);
  return Math.abs(mb - ma) / Math.max(1, ma);
}
/** Central s2×s2 crop of a square s4×s4 patch (same centre). */
export function cropCentre(p, s4, s2) {
  const o = (s4 - s2) >> 1, out = new Float32Array(s2 * s2);
  for (let j = 0; j < s2; j++) for (let i = 0; i < s2; i++) out[j * s2 + i] = p[(j + o) * s4 + i + o];
  return out;
}
/** NCC regularized by n2 (levels²): a noise-level patch never correlates with a structured one. */
export function patchNcc(a, b, n2 = 0) { const m = moments(a, b); return m.c / Math.sqrt((m.va + n2) * (m.vb + n2) || 1); }
/** Frame-to-frame similarity (2·cov + C)/(va + vb + C): flat vs flat counts as stable, structure change does not. */
export function patchStability(a, b, Creg) { const m = moments(a, b); return (2 * m.c + Creg) / (m.va + m.vb + Creg); }

const median = a => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(), n = s.length; return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const ringPush = (r, v) => { r.v[r.n++ % K.ring] = v; };
const ringMed = r => median(Array.from(r.v.subarray(0, Math.min(r.n, K.ring))));

/* ------------------------------------------------------------------ vacate rules (pure, D3 §3.3 + D1 grafts) */

/**
 * D3 §3.3(3) impulse rule on a departing chain's steps (d0 per frame, s_{j+1} − s_j over the frame gap):
 * σ1 >= max(minStep1D0, minStep1VsStep2·σ2) and σ_{j+1} <= growth·σ_j + growthSlackD0. Full speed within one
 * frame, then constant (face-on) or perspective-decaying (down-the-line).
 */
export function impulseOk(stepsD0, params = PARAMS) {
  const I = params.scan.vacate.impulse, st = stepsD0;
  if (!st.length || !(st[0] >= I.minStep1D0)) return false;
  if (st.length > 1 && !(st[0] >= I.minStep1VsStep2 * st[1])) return false;
  for (let j = 1; j < st.length; j++) if (st[j] > I.growth * st[j - 1] + I.growthSlackD0) return false;
  return true;
}

/**
 * D3 §3.3(3) gradual-departure veto on a track that started within gradual.startD0 of the address: steps px/frame,
 * at least 3 points (2 steps); first step below gradual.maxStep1D0·d0, the later steps not shrinking on average,
 * and the track actually left the start disc (net >= startD0·d0).
 */
export function gradualDeparture(stepsPx, netPx, d0, params = PARAMS) {
  const G = params.scan.vacate.gradual;
  if (stepsPx.length < 2) return false;
  const later = stepsPx.slice(1).reduce((p, q) => p + q, 0) / (stepsPx.length - 1);
  return stepsPx[0] < G.maxStep1D0 * d0 && later >= stepsPx[0] && netPx >= G.startD0 * d0;
}

/**
 * The D3 §3.3 tests (persistence, NCC change, stable post patch, impulse, gradual-departure veto) plus
 * eligibility, the time-limited occlusion recovery, the address staying in view and the surround staying the same
 * ground (the spot "became tee, grass or mat", not the golfer: post-vs-pre ring luma shift <= spot.lumaTol), on
 * measured quantities. Returns the failed test names; [] passes. The arrival veto and R1 are U3's (impact.js).
 */
export function vacateFailures(m, params = PARAMS) {
  const V = params.scan.vacate, f = [];
  if (!m.eligible) f.push('eligibility');
  if (m.recovered) f.push('recovered');
  if (m.outOfView) f.push('outOfView');
  if (!(m.absenceRatio >= V.minAbsence)) f.push('persistence');
  if (!(m.ncc <= V.maxNcc)) f.push('ncc');
  if (!(m.postStable >= V.minPostStableNcc)) f.push('postStable');
  if (m.surround > params.scan.spot.lumaTol) f.push('surround');
  if (m.impulse && !m.impulse.ok) f.push('impulse');
  if (m.gradualDeparture) f.push('gradual');
  return f;
}

/* ------------------------------------------------------------------ candidate table */

class CandTable {
  constructor() {
    this.n = 0; this.cap = 0;
    this.cols = { ord: Int32Array, X: Float32Array, Y: Float32Array, u: Float32Array, v: Float32Array, d: Float32Array, z: Float32Array, luma: Float32Array, pol: Int8Array, link: Int32Array, stat: Uint8Array, mov: Uint8Array };
    for (const k of Object.keys(this.cols)) this[k] = new this.cols[k](0);
    this.start = [0];
  }
  add(ord, c, link, stat, mov = 0) {
    if (this.n >= this.cap) {
      this.cap = Math.max(1024, this.cap * 2);
      for (const [k, T] of Object.entries(this.cols)) { const a = new T(this.cap); a.set(this[k]); this[k] = a; }
    }
    const i = this.n++;
    this.ord[i] = ord; this.X[i] = c.X; this.Y[i] = c.Y; this.u[i] = c.x; this.v[i] = c.y; this.d[i] = c.d; this.z[i] = c.z;
    this.luma[i] = c.luma; this.pol[i] = c.polarity; this.link[i] = link; this.stat[i] = stat; this.mov[i] = mov;
  }
  endFrame() { this.start.push(this.n); }
  rows(ord) { return [this.start[ord] ?? this.n, this.start[ord + 1] ?? this.n]; }
  /** Plain typed-array table for the CoarseLog (extension field `candidates`). */
  export(frames) {
    const n = this.n, o = { n, frameStart: Int32Array.from(this.start), frameIndex: Int32Array.from(frames) };
    for (const k of ['X', 'Y', 'u', 'v', 'd', 'z', 'luma', 'pol', 'link', 'stat', 'mov', 'ord']) o[k] = this[k].slice(0, n);
    return o;
  }
}

/* ------------------------------------------------------------------ spot tracker */

/**
 * Spot linking, ball-like gates, vacate tests (persistence, NCC change, stable post patch, impulse,
 * gradual-departure veto, time-limited occlusion recovery), arrival counts, movers, lens-fixed specks.
 */
export class SpotTracker {
  /** @param {import('./types.js').SourceMeta} meta  @param {{pool:number, params?:object, stride?:number}} o */
  constructor(meta, { pool = 1, params = PARAMS, stride } = {}) {
    this.meta = meta; this.pool = pool; this.params = params; this.fps = meta.fps;
    this.stride = stride ?? scanStride(meta.fps, params);
    const V = params.scan.vacate;
    this.dwell = spanFrames(params.scan.spot.minDwell, this.fps);
    this.Q = spanFrames(V.absence, this.fps);
    this.recover = spanFrames(V.recover, this.fps);
    this.watchLen = Math.max(V.skipFrames + 1 + this.Q, this.recover, V.postFrames[1]);
    this.table = new CandTable();
    this.frameIndex = []; this.frameT = []; this.hasMotion = []; this.rawLive = []; this.speckList = [];
    this.active = []; this.watching = []; this.kept = []; this.events = [];
    this.nextId = 0; this.noise = K.noiseFloor; this.largest = 0; this.detector = null; this.w = 0; this.h = 0;
    this.scales = [...params.scan.candidates.dogRadii, params.scan.candidates.dogRadiiLarge];
  }

  /**
   * One analyzed frame. img: coarse LumaImage of the raw frame (read during the call only); candidates from
   * detectCandidates on it (coarse px); sim: its CameraTrack similarity (stabilized native -> raw native).
   * aux.detector: the CandidateDetector that produced the candidates (reused for probes); aux.noise: σ levels;
   * aux.motion: this frame's energy cells {data, w, h, cellPx (coarse px)}, marks candidates on registered motion.
   */
  push(index, t, img, candidates, sim, aux = {}) {
    const n = this.frameIndex.length;
    if (n && index <= this.frameIndex[n - 1]) throw new HFError('bad-arg', `spot frame ${index} not increasing`);
    const P = this.pool, S = this.params.scan.spot, ord = n;
    this.w = img.w; this.h = img.h;
    let det = aux.detector;
    if (!det) { det = this.detector ??= new CandidateDetector(img.w, img.h, { params: this.params }); det.integral(img.data); }
    this.noise = aux.noise ?? noiseSigma(img.data, img.w, img.h);
    this.frameIndex.push(index); this.frameT.push(t);
    const inv = invertSim(sim);
    const cs = candidates.map(c => { const q = applySim(inv, P * c.x, P * c.y); return { ...c, X: q.x, Y: q.y, spot: null }; });
    // predicted raw coarse positions of the linked spots
    for (const sp of this.active) { const q = applySim(sim, sp.X, sp.Y); sp.u = q.x / P; sp.v = q.y / P; sp.hit = null; sp.probe = null; }
    for (const sp of this.watching) { const q = applySim(sim, sp.X, sp.Y); sp.u = q.x / P; sp.v = q.y / P; }
    // greedy nearest assignment: same polarity, luma within lumaTol, within matchD diameters
    const pairs = [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      for (const sp of this.active) {
        if (c.polarity !== sp.pol || Math.abs(c.luma - sp.luma) > S.lumaTol * sp.luma) continue;
        const dd = Math.hypot(c.x - sp.u, c.y - sp.v);
        if (dd <= this.linkR(sp, c)) pairs.push([dd, i, sp]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, i, sp] of pairs) if (!cs[i].spot && !sp.hit) { cs[i].spot = sp; sp.hit = cs[i]; }
    const keep = [];
    for (const sp of this.active) {
      let obs = sp.hit;
      if (obs) obs.respOwn = sp.pol * det.dogAt(sp.scale, Math.floor(obs.x), Math.floor(obs.y));
      else if (sp.established || sp.nPresent >= K.probeAfter) {
        const pr = det.probe(sp.u, sp.v, sp.scale, sp.pol, Math.max(1, this.linkR(sp)));
        sp.probe = pr;
        if (this.probeHit(pr, sp)) {
          const q = applySim(inv, P * pr.x, P * pr.y);
          obs = { ...pr, X: q.x, Y: q.y, respOwn: pr.resp };
        }
      }
      if (obs) this.observe(sp, ord, index, obs);
      else sp.gap++;
      this.mark(sp, ord, !!obs);
      if (obs) {
        sp.watch = null;                         // a detection gap within maxGapFrames, not a vacate
        if (sp.established) this.prePatch(sp, index, img);
        keep.push(sp);
        continue;
      }
      // absent: an established spot opens a provisional watch on its first absent frame
      if (sp.established && !sp.watch) sp.watch = this.openWatch(sp);
      if (sp.watch) this.watchStep(sp.watch, sp, index, img, false);
      if (sp.gap <= S.maxGapFrames) keep.push(sp);
      else if (sp.established) { sp.state = 'watch'; this.watching.push(sp); } // confirmed vacate watch
    }
    this.active = keep;
    // confirmed watches: probe, recover (time-limited), collect, finish
    const still = [];
    for (const sp of this.watching) {
      if (sp.watch.lastStep === index) { still.push(sp); continue; }
      const pr = det.probe(sp.u, sp.v, sp.scale, sp.pol, Math.max(1, this.linkR(sp)));
      const present = this.probeHit(pr, sp);
      this.mark(sp, ord, present);
      const res = this.watchStep(sp.watch, sp, index, img, present, pr);
      if (res === 'recovered') {
        const q = applySim(inv, P * pr.x, P * pr.y);
        sp.state = 'active'; sp.watch = null;
        this.observe(sp, ord, index, { ...pr, X: q.x, Y: q.y, respOwn: pr.resp });
        this.active.push(sp);
      } else if (res === 'done') sp.state = 'done';
      else still.push(sp);
    }
    this.watching = still;
    // new tentative spots; candidates on a watched address stay reserved for its recovery, except one clearly larger
    // than the watched spot: a ball the club head half-hid at address, uncovered at takeaway, is not the old blob
    // coming back (its recovery needs the old patch) and must not wait out the recovery window (real clip: 18 frames)
    for (const c of cs) {
      if (c.spot) continue;
      if (this.watching.some(sp => sp.pol === c.polarity && c.d < K.relinkGrow * sp.d && Math.hypot(c.x - sp.u, c.y - sp.v) <= this.linkR(sp, c))) continue;
      const sp = this.newSpot(c, ord, index, det);
      c.spot = sp;
      this.active.push(sp);
    }
    const mm = aux.motion;
    const moving = c => {
      if (!mm) return 0;
      const ci = Math.floor(c.x / mm.cellPx), cj = Math.floor(c.y / mm.cellPx);
      for (let j = Math.max(0, cj - 1); j <= Math.min(mm.h - 1, cj + 1); j++) for (let i = Math.max(0, ci - 1); i <= Math.min(mm.w - 1, ci + 1); i++) if (mm.data[j * mm.w + i]) return 1;
      return 0;
    };
    for (const c of cs) this.table.add(ord, c, c.spot ? c.spot.num : -1, c.spot?.established ? 1 : 0, moving(c));
    this.hasMotion.push(mm ? 1 : 0);
    this.speckStep(ord, cs);
    this.table.endFrame();
  }

  /** A probe sees the spot: blob centroid within matchD diameters of the anchor, same look, half its response. */
  probeHit(pr, sp, frac = K.presentFrac) {
    const S = this.params.scan.spot;
    return pr.x !== undefined && pr.resp >= frac * sp.refResp && Math.abs(pr.luma - sp.luma) <= S.lumaTol * sp.luma
      && Math.hypot(pr.x - sp.u, pr.y - sp.v) <= this.linkR(sp);
  }
  /** Link radius (coarse px): matchD diameters, or relinkD when the candidate is clearly larger than the spot: a ball the club head half-hid at address grows and re-centres when uncovered at
   *  takeaway. Probes and same-size returns (a lens speck under shake) keep matchD. */
  linkR(sp, c) {
    const S = this.params.scan.spot;
    return (c && c.d >= K.relinkGrow * sp.d ? K.relinkD : S.matchD) * sp.d;
  }
  newSpot(c, ord, index, det) {
    const r = () => ({ v: new Float32Array(K.ring), n: 0 });
    const sp = {
      num: this.nextId++, pol: c.polarity, scale: c.scale, first: index, firstOrd: ord, last: index, lastOrd: ord,
      present: new Uint8Array(64), nMarked: 0, nPresent: 0, sx: 0, sy: 0, sxx: 0, syy: 0, X: c.X, Y: c.Y,
      d: c.d, luma: c.luma, refResp: c.resp, gap: 0, established: false, state: 'active', watch: null, pre: [],
      rd: r(), rl: r(), rr: r(), rz: r(), rround: r(), rfill: r(), rcon: r(), u: c.x, v: c.y, hit: c, probe: null
    };
    c.respOwn = c.resp;
    this.observe(sp, ord, index, c);
    this.mark(sp, ord, true);
    return sp;
  }
  mark(sp, ord, on) {
    const k = ord - sp.firstOrd;
    if (k < sp.nMarked) return;
    if (k >= sp.present.length) { const a = new Uint8Array(Math.max(64, 2 * (k + 1))); a.set(sp.present); sp.present = a; }
    sp.present[k] = on ? 1 : 0; sp.nMarked = k + 1;
  }
  observe(sp, ord, index, o) {
    const S = this.params.scan.spot, P = this.pool;
    sp.nPresent++; sp.last = index; sp.lastOrd = ord; sp.gap = 0;
    sp.sx += o.X; sp.sy += o.Y; sp.sxx += o.X * o.X; sp.syy += o.Y * o.Y;
    // the anchor follows the mean only until the spot is established, then stays put: a slowly departing
    // object (raked ball, glove, takeaway) must leave the anchor's disc instead of dragging the spot along
    if (!sp.established) { sp.X = sp.sx / sp.nPresent; sp.Y = sp.sy / sp.nPresent; }
    ringPush(sp.rd, o.d); ringPush(sp.rl, o.luma); ringPush(sp.rr, o.respOwn ?? o.resp); ringPush(sp.rz, o.z);
    ringPush(sp.rround, o.roundness); ringPush(sp.rfill, o.fill); ringPush(sp.rcon, o.contrast);
    if (sp.nPresent <= K.ring || sp.nPresent % 4 === 0) { sp.d = ringMed(sp.rd); sp.luma = ringMed(sp.rl); sp.refResp = Math.max(1e-6, ringMed(sp.rr)); }
    if (!sp.established && index - sp.first + 1 >= this.dwell) {
      const span = ord - sp.firstOrd + 1, sig = this.posSigma(sp);
      if (sp.nPresent / span >= S.minPresence && sig <= S.maxPositionSigmaD0 * sp.d * P) {
        sp.established = true; this.kept.push(sp);
        // the large DoG scale is for big address balls (D3 §3.2): only ball-shaped stationary blobs count
        if (ringMed(sp.rround) <= (sp.pol > 0 ? S.maxEigRatioBright : S.maxEigRatio) && ringMed(sp.rfill) >= S.minFill) this.largest = Math.max(this.largest, sp.d);
      }
    }
  }
  posSigma(sp) {
    const n = sp.nPresent, mx = sp.sx / n, my = sp.sy / n;
    return Math.sqrt(Math.max(0, (sp.sxx / n - mx * mx + sp.syy / n - my * my) / 2));
  }
  /**
   * Watch patches: the D3 box of patchD0 diameters (s2) for the NCC change and stability tests, inside a patch twice
   * as wide (s4) whose ring between d and 2·d tells whether the surround stayed the same ground.
   */
  patchSides(sp) {
    const s2 = Math.max(3, Math.round(this.params.scan.vacate.patchD0 * sp.d));
    return { s2, s4: s2 + 2 * Math.max(2, Math.round(sp.d)) };
  }
  prePatch(sp, index, img) {
    const V = this.params.scan.vacate, { s4 } = this.patchSides(sp);
    sp.pre.push({ index, p: samplePatch(img.data, img.w, img.h, sp.u, sp.v, s4) });
    while (sp.pre.length && sp.pre[0].index < index + V.preFrames[0] - this.stride) sp.pre.shift();
  }
  openWatch(sp) {
    const V = this.params.scan.vacate, { s2, s4 } = this.patchSides(sp);
    let pre = sp.pre.filter(e => e.index >= sp.last + V.preFrames[0] && e.index <= sp.last + V.preFrames[1] && e.p.length === s4 * s4);
    if (!pre.length) pre = sp.pre.filter(e => e.p.length === s4 * s4).slice(-1);
    const big = new Float32Array(s4 * s4);
    for (const e of pre) for (let i = 0; i < big.length; i++) big[i] += e.p[i] / pre.length;
    const ix = this.frameIndex, at = ix.indexOf(sp.last);
    const next = at >= 0 && at + 1 < ix.length ? at + 1 : ix.length - 1;
    return {
      kLast: sp.last, tLast: this.frameT[at], kFirstAbsent: ix[next], tFirstAbsent: this.frameT[next], preBig: big, pre: cropCentre(big, s4, s2),
      side: s2, s4, d: sp.d, absN: 0, absOff: 0, post: [], recovered: false, recoverIndex: null, lastStep: -1, noise: this.noise, outOfView: false
    };
  }
  /** Advance a watch by one frame; returns 'recovered' | 'done' | null. */
  watchStep(w, sp, index, img, present, pr) {
    const V = this.params.scan.vacate, dk = index - w.kLast;
    w.lastStep = index;
    // an address leaving the frame (camera pan or drift) is not a vacate
    const mg = Math.max(w.side / 2, this.scales[sp.scale][1]) + 1;
    if (sp.u < mg || sp.v < mg || sp.u > img.w - mg || sp.v > img.h - mg) w.outOfView = true;
    const n2 = (K.noiseK * Math.max(w.noise, this.noise)) ** 2;
    const needPatch = (dk > V.skipFrames && dk <= this.recover) || (dk >= V.postFrames[0] && dk <= V.postFrames[1]);
    const big = needPatch ? samplePatch(img.data, img.w, img.h, sp.u, sp.v, w.s4) : null, patch = big && cropCentre(big, w.s4, w.side);
    if (sp.state === 'watch' && dk > V.skipFrames && dk <= this.recover && pr && this.probeHit(pr, sp, V.recoverPresence)
      && patchNcc(patch, w.pre, n2) > V.maxNcc) {
      w.recovered = true; w.recoverIndex = index;
      this.events.push({ sp, w });
      return 'recovered';
    }
    if (dk >= V.skipFrames + 1 && dk <= V.skipFrames + 1 + this.Q) { w.absN++; if (!present) w.absOff++; }
    if (dk >= V.postFrames[0] && dk <= V.postFrames[1]) w.post.push(big);
    if (dk >= this.watchLen) { this.events.push({ sp, w }); return 'done'; }
    return null;
  }

  /** @returns {{spots:import('./types.js').Spot[], vacates:import('./types.js').VacateEvent[], movers:import('./types.js').Mover[], specks:import('./types.js').Speck[], candidates:object}} */
  finish() {
    // watches cut by the clip end are judged on the frames they saw; gaps still inside maxGapFrames are not vacates
    for (const sp of this.watching) this.events.push({ sp, w: sp.watch });
    this.watching = [];
    const spots = this.kept, out = this.spotsOut(spots);
    const vacates = this.vacatesOut(out);
    const cutoff = Math.min(Infinity, ...vacates.filter(v => v.valid).map(v => v.kLast));
    return { spots: out.map(o => o.spot), vacates, movers: this.movers(cutoff), specks: this.specks(), candidates: this.table.export(this.frameIndex) };
  }

  spotsOut(spots) {
    const S = this.params.scan.spot, P = this.pool, short = Math.min(this.w || 1, this.h || 1);
    const list = spots.map(sp => {
      const d = ringMed(sp.rd), round = ringMed(sp.rround), fill = ringMed(sp.rfill), z = ringMed(sp.rz), span = sp.lastOrd - sp.firstOrd + 1;
      // ball-like (D3 §3.2): shape, polarity, size, and a consistently detected blob (median z at the detection
      // threshold), not a weak response kept alive by probes
      const ballLike = round <= (sp.pol > 0 ? S.maxEigRatioBright : S.maxEigRatio) && fill >= S.minFill && (sp.pol > 0 || z >= S.darkMinZ) && d >= S.minDiamCoarsePx && d <= S.maxDiamFracShort * short
        && z >= this.params.scan.candidates.zMin;
      return {
        sp, spot: {
          id: `s${sp.num}`, x: sp.X, y: sp.Y, d: d * P, polarity: sp.pol, contrast: ringMed(sp.rcon), z, firstIndex: sp.first, lastIndex: sp.last,
          presence: Math.min(1, sp.nPresent / span), roundness: Math.max(1, round), fill: Math.min(1, Math.max(0, fill)), ballLike,
          arrivalMovers: this.arrivals(sp, d * P), clusterId: 0
        }
      };
    });
    // hand-off: a spot that appears where another of the same polarity ends (overlapping or apart by at most
    // maxGapFrames, within relinkD diameters) is that object re-segmented, e.g. a ball the club head half-hid at
    // address, uncovered at takeaway. It keeps the older spot's first sighting and arrival count: uncovering is no
    // arrival (real night clip: 6 'arrivals' from the takeaway vetoed the ball)
    const gap = (S.maxGapFrames + 1) * this.stride;
    for (const b of list) for (const a of list) {
      const A = a.spot, B = b.spot;
      if (a === b || A.polarity !== B.polarity || !(A.firstIndex < B.firstIndex) || Math.abs(B.firstIndex - A.lastIndex) > gap) continue;
      if (Math.hypot(A.x - B.x, A.y - B.y) > K.relinkD * Math.max(A.d, B.d)) continue;
      B.arrivalMovers = Math.min(B.arrivalMovers, A.arrivalMovers); B.firstIndex = A.firstIndex;
    }
    // address clusters: spots within clusterD mean diameters (union-find)
    const parent = list.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i].spot, b = list[j].spot;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= S.clusterD * (a.d + b.d) / 2) parent[find(i)] = find(j);
    }
    const ids = new Map();
    for (let i = 0; i < list.length; i++) { const r = find(i); if (!ids.has(r)) ids.set(r, ids.size); list[i].spot.clusterId = ids.get(r); }
    for (const o of list) o.spot = makeSpot(o.spot);
    return list;
  }

  /**
   * D1 arrival veto count: same-looking non-static candidates in the arrival band (arrivalBandD diameters) within
   * arrivalFrames before the spot first appeared that were APPROACHING it, i.e. a same-looking candidate one analyzed
   * frame earlier lay farther away (by 0.25 D) within reach. A body part that arrived and paused; a club head
   * leaving the ball at takeaway (which uncovers it) moves away and does not count.
   */
  arrivals(sp, dNative) {
    const S = this.params.scan.spot, T = this.table, back = Math.max(S.arrivalFrames, this.stride), P = this.pool;
    const look = i => !T.stat[i] && T.pol[i] === sp.pol && T.d[i] * P / dNative >= K.sizeRatio[0] && T.d[i] * P / dNative <= K.sizeRatio[1]
      && Math.abs(T.luma[i] - sp.luma) <= S.lumaTol * sp.luma;
    const dist = i => Math.hypot(T.X[i] - sp.X, T.Y[i] - sp.Y) / dNative;
    let n = 0;
    for (let o = sp.firstOrd - 1; o >= 1 && this.frameIndex[o] >= sp.first - back; o--) {
      const [a, b] = T.rows(o), [c, e] = T.rows(o - 1);
      for (let i = a; i < b; i++) {
        const r = dist(i);
        if (!look(i) || !(r > S.arrivalBandD[0] && r < S.arrivalBandD[1])) continue;
        for (let j = c; j < e; j++) {
          if (look(j) && dist(j) > r + 0.25 && Math.hypot(T.X[j] - T.X[i], T.Y[j] - T.Y[i]) <= S.arrivalBandD[1] * dNative) { n++; break; }
        }
      }
    }
    return n;
  }

  vacatesOut(spotList) {
    const byNum = new Map(spotList.map(o => [o.sp.num, o.spot]));
    const evs = this.events.filter(e => byNum.has(e.sp.num)).map(({ sp, w }) => {
      const spot = byNum.get(sp.num), d0 = spot.d;
      const n2 = (K.noiseK * w.noise) ** 2, post = w.post.map(b => cropCentre(b, w.s4, w.side));
      let postBig = null;
      if (w.post.length) { postBig = new Float32Array(w.s4 * w.s4); for (const p of w.post) for (let i = 0; i < p.length; i++) postBig[i] += p[i] / w.post.length; }
      const postMean = postBig && cropCentre(postBig, w.s4, w.side), stab = [];
      for (let i = 1; i < post.length; i++) stab.push(patchStability(post[i - 1], post[i], 2 * n2));
      const ncc = postMean ? patchNcc(w.pre, postMean, n2) : 1, postStable = stab.length ? median(stab) : 0;
      const surround = postBig ? ringShift(w.preBig, postBig, w.s4, w.d) : 0;
      const absenceRatio = w.absN ? (w.absOff / w.absN) : 0;
      const impulse = w.recovered ? null : this.impulse(sp, w.kLast, d0);
      const gradual = w.recovered ? false : this.gradual(sp, w.kLast, d0);
      const eligible = spot.ballLike && this.dwellOk(sp, w.kLast);
      const fails = vacateFailures({ eligible, recovered: w.recovered, outOfView: w.outOfView, absenceRatio, ncc, postStable, surround, impulse, gradualDeparture: gradual }, this.params);
      return {
        ev: {
          spotId: spot.id, kLast: w.kLast, tLast: w.tLast, kFirstAbsent: w.kFirstAbsent, tFirstAbsent: w.tFirstAbsent,
          absenceRatio: Math.min(1, Math.max(0, absenceRatio)), ncc, postStable, impulse, gradualDeparture: gradual, recovered: w.recovered,
          valid: false, clusterId: spot.clusterId, eligible, outOfView: w.outOfView, surround, fails, recoverIndex: w.recoverIndex
        }, pass: !fails.length, sp
      };
    });
    // two spots on one object (re-created after an occlusion) give one vacate: the stronger detection stands
    const S = this.params.scan.spot, spotOf = a => byNum.get(+a.ev.spotId.slice(1));
    for (const a of evs) {
      if (!a.pass) continue;
      const sa = spotOf(a);
      for (const b of evs) {
        if (b === a || !b.pass) continue;
        const sb = spotOf(b);
        if (Math.abs(b.ev.kLast - a.ev.kLast) <= (S.maxGapFrames + 1) * this.stride && Math.hypot(sa.x - sb.x, sa.y - sb.y) <= K.relinkD * Math.max(sa.d, sb.d)
          && (sb.z > sa.z || (sb.z === sa.z && b.ev.spotId < a.ev.spotId))) {
          a.pass = false; a.ev.fails.push('duplicate');
          // one object: the survivor keeps the older spot's first sighting and its arrival count (a ball the club
          // half-hid at address is re-created when uncovered at takeaway; that re-creation did not 'arrive'), and
          // its presence counts the frames either record saw it in (real clip: 78% alone, 96% for the object)
          if (sa.firstIndex < sb.firstIndex) { sb.firstIndex = sa.firstIndex; sb.arrivalMovers = sa.arrivalMovers; }
          sb.presence = Math.max(sb.presence, unionPresence(a.sp, b.sp));
          break;
        }
      }
    }
    evs.forEach(a => {
      a.ev.valid = a.pass;
      // extension for ranking (U3 ranks by vacate quality, never by size): detection strength and how cleanly it left
      const sp = spotOf(a);
      a.ev.quality = Math.log(1 + Math.max(0, sp.z)) + (1 - Math.max(-1, Math.min(1, a.ev.ncc))) + a.ev.postStable - 2 * a.ev.surround;
    });
    return evs.map(a => makeVacate(a.ev)).sort((a, b) => a.kLast - b.kLast);
  }

  /** Present in >= minPresence of the frames over some window of >= minDwell ending at kLast. */
  dwellOk(sp, kLast) {
    const S = this.params.scan.spot, ix = this.frameIndex, end = ix.indexOf(kLast) - sp.firstOrd;
    if (end < 0 || kLast - sp.first + 1 < this.dwell) return false;
    let on = 0;
    for (let k = end; k >= 0; k--) {
      on += sp.present[k];
      const len = ix[sp.firstOrd + end] - ix[sp.firstOrd + k] + 1;
      if (len >= this.dwell && on / (end - k + 1) >= S.minPresence) return true;
    }
    return false;
  }

  /** Candidate rows of analyzed frames with index in (k0, k1], plus each frame's index. */
  framesAfter(k0, k1) {
    const ix = this.frameIndex, out = [];
    for (let o = Math.max(0, ix.indexOf(k0)); o < ix.length && ix[o] <= k1; o++) if (ix[o] > k0) out.push(o);
    return out;
  }
  compatible(i, sp, dNative, luma, moving = false) {
    const T = this.table, q = T.d[i] * this.pool / dNative;
    if (T.pol[i] !== sp.pol || q < K.sizeRatio[0] || q > K.sizeRatio[1]) return false;
    if (T.stat[i] && T.link[i] !== sp.num) return false;
    if (moving && this.hasMotion[T.ord[i]] && !T.mov[i]) return false;   // static texture never forms a departure chain
    return !luma || Math.abs(T.luma[i] - sp.luma) <= this.params.scan.spot.lumaTol * sp.luma;
  }

  /**
   * D3 §3.3(3) impulse: the departing object's chain on a line from the address (wedge of launch.emergence) on
   * registered motion, extended only by points that keep the growth rule (others belong to another object), steps
   * per frame in d0. Best passing chain, else the longest failing one, else null (nothing seen leave).
   */
  impulse(sp, kLast, d0) {
    const T = this.table, E = this.params.launch.emergence, Im = this.params.scan.vacate.impulse, ix = this.frameIndex;
    const ords = this.framesAfter(kLast, kLast + Math.max(K.departFrames, 4 * this.stride));
    if (ords.length < 2) return null;
    const chains = [];
    for (const o0 of ords.slice(0, 2)) {
      const [a, b] = T.rows(o0);
      for (let i = a; i < b; i++) {
        if (!this.compatible(i, sp, d0, false, true) || T.link[i] === sp.num) continue;
        const s1 = Math.hypot(T.X[i] - sp.X, T.Y[i] - sp.Y);
        if (!(s1 > 0) || s1 > (ix[o0] - kLast) * E.reachD0PerFrame * d0) continue;
        const ux = (T.X[i] - sp.X) / s1, uy = (T.Y[i] - sp.Y) / s1, pts = [{ k: ix[o0], s: s1 }];
        let last = ords.indexOf(o0);
        for (let m = last + 1; m < ords.length && pts.length < K.departMaxPts && m - last <= this.params.scan.spot.maxGapFrames + 1; m++) {
          const [c, e] = T.rows(ords[m]), k = ix[ords[m]];
          // a launch chain obeys the growth rule: a point that breaks it is another object (club, divot), not the ball
          const prevStep = pts.length > 1 ? (pts.at(-1).s - pts.at(-2).s) / (pts.at(-1).k - pts.at(-2).k) : Infinity;
          const maxS = pts.at(-1).s + (prevStep === Infinity ? Infinity : (Im.growth * prevStep + Im.growthSlackD0 * d0) * (k - pts.at(-1).k));
          let bj = -1, bperp = Infinity;
          for (let j = c; j < e; j++) {
            if (!this.compatible(j, sp, d0, false, true)) continue;
            const dx = T.X[j] - sp.X, dy = T.Y[j] - sp.Y, along = dx * ux + dy * uy, perp = Math.abs(dx * uy - dy * ux);
            if (along <= pts.at(-1).s || along > maxS || perp > along * Math.tan(Math.max(E.wedgeDeg * Math.PI / 180, Math.atan(E.wedgeD0 * d0 / along)))) continue;
            if (perp < bperp) { bperp = perp; bj = j; }
          }
          if (bj < 0) continue;
          pts.push({ k: ix[ords[m]], s: Math.hypot(T.X[bj] - sp.X, T.Y[bj] - sp.Y) });
          last = m;
        }
        if (pts.length >= 2) chains.push(pts);
      }
    }
    if (!chains.length) return null;
    const judged = chains.map(pts => {
      const st = [];
      for (let j = 1; j < pts.length; j++) st.push((pts[j].s - pts[j - 1].s) / (pts[j].k - pts[j - 1].k) / d0);
      return { step1D0: st[0], step2D0: st.length > 1 ? st[1] : null, ok: impulseOk(st, this.params), n: pts.length };
    });
    judged.sort((a, b) => (b.ok - a.ok) || (b.n - a.n) || (b.step1D0 - a.step1D0));
    const { step1D0, step2D0, ok } = judged[0];
    return { step1D0, step2D0, ok };
  }

  /**
   * D3 §3.3(3) gradual-departure veto: a same-looking track that starts within gradual.startD0·d0 of the address
   * in [k_last, k_last + windowFrames], whose first post-impact step (never the step out of k_last) is below
   * gradual.maxStep1D0·d0/frame with steps not shrinking, and that actually leaves the start disc. Takeaway glints,
   * gloves, feet, raked balls and balls falling off a tee.
   */
  gradual(sp, kLast, d0) {
    const T = this.table, G = this.params.scan.vacate.gradual, Im = this.params.scan.vacate.impulse, S = this.params.scan.spot, ix = this.frameIndex;
    const win = Math.max(G.windowFrames, this.stride);
    const ords = [ix.indexOf(kLast), ...this.framesAfter(kLast, kLast + Math.max(K.departFrames, 4 * this.stride))].filter(o => o >= 0);
    for (let m0 = 0; m0 < ords.length && ix[ords[m0]] <= kLast + win; m0++) {
      const [a, b] = T.rows(ords[m0]);
      for (let i = a; i < b; i++) {
        if (!this.compatible(i, sp, d0, true)) continue;
        const s0 = Math.hypot(T.X[i] - sp.X, T.Y[i] - sp.Y);
        if (s0 > G.startD0 * d0) continue;
        const pts = [{ k: ix[ords[m0]], s: s0, x: T.X[i], y: T.Y[i] }];
        let step = G.maxStep1D0 * d0, last = m0;
        for (let m = m0 + 1; m < ords.length && pts.length < K.departMaxPts && m - last <= S.maxGapFrames + 1; m++) {
          const k = ix[ords[m]], dk = k - pts.at(-1).k, R = (Im.growth * step + Im.growthSlackD0 * d0) * dk + S.matchD * d0;
          const [c, e] = T.rows(ords[m]);
          let bj = -1, bd = Infinity;
          for (let j = c; j < e; j++) {
            if (!this.compatible(j, sp, d0, true)) continue;
            const dd = Math.hypot(T.X[j] - pts.at(-1).x, T.Y[j] - pts.at(-1).y), s = Math.hypot(T.X[j] - sp.X, T.Y[j] - sp.Y);
            if (dd <= R && s >= pts.at(-1).s && dd < bd) { bd = dd; bj = j; }
          }
          if (bj < 0) continue;
          const s = Math.hypot(T.X[bj] - sp.X, T.Y[bj] - sp.Y);
          step = Math.max(G.maxStep1D0 * d0, (s - pts.at(-1).s) / dk);
          pts.push({ k, s, x: T.X[bj], y: T.Y[bj] });
          last = m;
        }
        // steps count from the first post-impact frame: a step that starts at k_last holds the sub-frame impact phase
        const st = [];
        for (let j = 1; j < pts.length; j++) if (pts[j - 1].k > kLast) st.push((pts[j].s - pts[j - 1].s) / (pts[j].k - pts[j - 1].k));
        if (gradualDeparture(st, pts.at(-1).s - pts[0].s, d0, this.params)) return true;
      }
    }
    return false;
  }

  /**
   * Constant-velocity tracklets of candidates on registered motion (not linked to a static spot) that began before
   * the first valid vacate (D1 §4.3, D3 §4.5). Static texture never qualifies: it has no frame-difference energy.
   */
  movers(cutoff) {
    const T = this.table, M = this.params.scan.movers, S = this.params.scan.spot, ix = this.frameIndex, P = this.pool;
    const longSide = Math.max(this.w, this.h), out = [], live = [], closed = [];
    for (let o = 0; o < ix.length; o++) {
      const k = ix[o], [a, b] = T.rows(o), rows = [];
      for (let i = a; i < b; i++) if (!T.stat[i] && T.mov[i]) rows.push(i);   // only candidates on registered motion
      const pairs = [];
      for (const tr of live) {
        const dk = k - tr.k.at(-1), n = tr.k.length, x = tr.x.at(-1) + (n > 1 ? tr.vx * dk : 0), y = tr.y.at(-1) + (n > 1 ? tr.vy * dk : 0);
        const gate = n > 1 ? Math.max(K.moverFitPx * 2, 0.25 * Math.hypot(tr.vx, tr.vy) * dk) : K.moverInitFrac * longSide * dk;
        for (const i of rows) {
          if (T.pol[i] !== tr.pol) continue;
          const dd = Math.hypot(T.X[i] / P - x, T.Y[i] / P - y);
          if (dd <= gate + T.d[i]) pairs.push([dd, tr, i]);
        }
      }
      pairs.sort((p, q) => p[0] - q[0]);
      const used = new Set(), took = new Set();
      for (const [, tr, i] of pairs) {
        if (used.has(i) || took.has(tr)) continue;
        used.add(i); took.add(tr);
        tr.k.push(k); tr.x.push(T.X[i] / P); tr.y.push(T.Y[i] / P); tr.d.push(T.d[i]); tr.o = o;
        const n = tr.k.length, k0 = tr.k[0];
        tr.vx = (tr.x[n - 1] - tr.x[0]) / (k - k0); tr.vy = (tr.y[n - 1] - tr.y[0]) / (k - k0);
      }
      for (const i of rows) if (!used.has(i)) live.push({ k: [k], x: [T.X[i] / P], y: [T.Y[i] / P], d: [T.d[i]], pol: T.pol[i], vx: 0, vy: 0, o });
      for (let j = live.length - 1; j >= 0; j--) if (o - live[j].o > S.maxGapFrames) closed.push(...live.splice(j, 1));
    }
    closed.push(...live);
    // longest first; a tracklet mostly on top of an accepted one is the same object seen twice
    closed.sort((a, b) => b.k.length - a.k.length);
    const kept = [];
    const covers = (a, b) => {
      let on = 0;
      for (let j = 0; j < b.k.length; j++) {
        const i = a.k.indexOf(b.k[j]);
        if (i >= 0 && Math.hypot(a.x[i] - b.x[j], a.y[i] - b.y[j]) <= 2 * Math.max(a.d[i], b.d[j])) on++;
      }
      return on >= 0.5 * b.k.length;
    };
    for (const tr of closed) {
      const n = tr.k.length;
      if (n < M.minFrames || tr.k[0] >= cutoff) continue;
      if (kept.some(o => covers(o, tr))) continue;
      // least-squares constant velocity
      const km = tr.k.reduce((p, q) => p + q, 0) / n, xm = tr.x.reduce((p, q) => p + q, 0) / n, ym = tr.y.reduce((p, q) => p + q, 0) / n;
      let kk = 0, kx = 0, ky = 0;
      for (let j = 0; j < n; j++) { const e = tr.k[j] - km; kk += e * e; kx += e * (tr.x[j] - xm); ky += e * (tr.y[j] - ym); }
      const vx = kx / kk, vy = ky / kk, dm = tr.d.reduce((p, q) => p + q, 0) / n;
      let ss = 0;
      for (let j = 0; j < n; j++) { const e = tr.k[j] - km; ss += (tr.x[j] - xm - vx * e) ** 2 + (tr.y[j] - ym - vy * e) ** 2; }
      if (Math.sqrt(ss / n) > Math.max(K.moverFitPx, K.moverFitD * dm) || Math.max(...tr.d) > K.sizeRatio[1] / K.sizeRatio[0] * Math.min(...tr.d)) continue;
      const speed = Math.hypot(vx, vy);
      const kind = speed >= M.minSpeedPx ? 'preimpact' : n >= M.skyMinFrames && speed >= K.skyMinSpeedPx ? 'sky' : null;
      if (!kind) continue;
      const e0 = tr.k[0] - km;
      kept.push(tr);
      out.push({ id: `m${out.length}`, kind, index0: tr.k[0], index1: tr.k[n - 1], x: (xm + vx * e0) * P, y: (ym + vy * e0) * P, vx: vx * P, vy: vy * P, d: Math.max(1e-3, dm * P) });
    }
    return out;
  }

  /**
   * Online lens-speck tracker (D3 §4.3): candidates linked in RAW coarse coordinates; a track becomes a speck
   * once seen in speck.minFrames analyzed frames with raw drift <= maxRawMovePx while its stabilized position
   * moved >= minCameraMovePx (the camera moved under it). Feeds the camera's patch mask while scanning.
   */
  speckStep(ord, cs) {
    const Sp = this.params.scan.speck, P = this.pool, live = this.rawLive;
    const pairs = [];
    for (let i = 0; i < cs.length; i++) for (const tr of live) {
      if (cs[i].polarity !== tr.pol) continue;
      const dd = Math.hypot(cs[i].x - tr.su / tr.n, cs[i].y - tr.sv / tr.n);
      if (dd <= K.speckLinkPx) pairs.push([dd, tr, i]);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const used = new Set(), took = new Set();
    for (const [, tr, i] of pairs) {
      if (used.has(i) || took.has(tr)) continue;
      used.add(i); took.add(tr);
      const c = cs[i];
      tr.n++; tr.su += c.x; tr.sv += c.y; tr.u.push(c.x); tr.v.push(c.y); tr.sd += c.d; tr.o = ord;
      tr.x0 = Math.min(tr.x0, c.X / P); tr.x1 = Math.max(tr.x1, c.X / P); tr.y0 = Math.min(tr.y0, c.Y / P); tr.y1 = Math.max(tr.y1, c.Y / P);
      if (!tr.speck && tr.n >= Sp.minFrames && Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0) >= Sp.minCameraMovePx) {
        const mu = tr.su / tr.n, mv = tr.sv / tr.n;
        if (!tr.u.some((u, j) => Math.hypot(u - mu, tr.v[j] - mv) > Sp.maxRawMovePx)) { tr.speck = true; this.speckList.push(tr); }
      }
    }
    for (let i = 0; i < cs.length; i++) {
      if (used.has(i)) continue;
      const c = cs[i];
      live.push({ n: 1, su: c.x, sv: c.y, u: [c.x], v: [c.y], sd: c.d, pol: c.polarity, o: ord, x0: c.X / P, x1: c.X / P, y0: c.Y / P, y1: c.Y / P, speck: false });
    }
    for (let j = live.length - 1; j >= 0; j--) if (ord - live[j].o > this.params.scan.spot.maxGapFrames) live.splice(j, 1);
  }
  /** Lens-fixed specks so far as raw coarse boxes {x0, y0, x1, y1}, padded by 1 px (camera patch mask). */
  speckBoxes() {
    return this.speckList.map(tr => { const u = tr.su / tr.n, v = tr.sv / tr.n, r = tr.sd / tr.n / 2 + 1; return { x0: Math.floor(u - r), y0: Math.floor(v - r), x1: Math.ceil(u + r), y1: Math.ceil(v + r) }; });
  }
  /** Lens-fixed specks in raw native px (the mean raw position over the track). */
  specks() {
    const P = this.pool;
    return this.speckList.map(tr => { const mu = tr.su / tr.n, mv = tr.sv / tr.n; return { x: P * mu, y: P * mv, r: P * (tr.sd / tr.n / 2 + 0.5) }; });
  }
}
