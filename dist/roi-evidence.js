/**
 * Phase 3: native-resolution ROI evidence → soft multi-candidates.
 * Does NOT pick a single ball. Global association (Phase 4) owns identity.
 *
 * Evidence stack per ROI:
 *  - local contrast / DoG-like high-pass peaks (bright or dark)
 *  - temporal residual vs previous registered crop (when available)
 *  - multi-frame matched-motion score along a velocity hypothesis family
 */

/** @typedef {{ x:number, y:number, score:number, visualScore:number, temporalScore:number, motionScore:number, radiusPx:number, polarity:'bright'|'dark', origin:string }} RoiCandidate */

export function dogResponse(gray, w, h, x, y, rInner = 1, rOuter = 3) {
  // Approximate Difference-of-Gaussians via box rings (fast, no allocations).
  let inner = 0, innerN = 0, outer = 0, outerN = 0;
  const x0 = Math.max(0, x - rOuter), x1 = Math.min(w - 1, x + rOuter);
  const y0 = Math.max(0, y - rOuter), y1 = Math.min(h - 1, y + rOuter);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx - x, yy - y);
      const v = gray[yy * w + xx];
      if (d <= rInner) { inner += v; innerN++; }
      else if (d <= rOuter) { outer += v; outerN++; }
    }
  }
  if (!innerN || !outerN) return 0;
  return inner / innerN - outer / outerN;
}

export function rgbaToGray(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    gray[i] = rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114;
  }
  return gray;
}

/**
 * Non-max suppress peaks on a score map; return top-K {x,y,score}.
 */
export function nmsPeaks(scores, w, h, { k = 12, minScore = 4, radius = 3 } = {}) {
  const peaks = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const s = scores[i];
      if (s < minScore) continue;
      if (s < scores[i - 1] || s < scores[i + 1] || s < scores[i - w] || s < scores[i + w]) continue;
      peaks.push({ x, y, score: s });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const p of peaks) {
    if (kept.some(q => Math.hypot(q.x - p.x, q.y - p.y) < radius)) continue;
    kept.push(p);
    if (kept.length >= k) break;
  }
  return kept;
}

/**
 * Build a visual score map: |DoG| + local contrast vs neighborhood median-ish.
 */
export function visualScoreMap(gray, w, h) {
  const scores = new Float32Array(w * h);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const dog = dogResponse(gray, w, h, x, y, 1, 3);
      const v = gray[y * w + x];
      const surround = (
        gray[y * w + x - 3] + gray[y * w + x + 3] +
        gray[(y - 3) * w + x] + gray[(y + 3) * w + x]
      ) / 4;
      const contrast = v - surround;
      // Keep both bright and dark residuals; polarity stored later.
      scores[y * w + x] = Math.abs(dog) * 1.2 + Math.abs(contrast) * 0.35;
    }
  }
  return scores;
}

/**
 * Temporal residual map: |current - previous| after optional integer shift.
 */
export function temporalResidualMap(curr, prev, w, h, shift = { x: 0, y: 0 }) {
  const scores = new Float32Array(w * h);
  if (!prev) return scores;
  const sx = shift.x | 0, sy = shift.y | 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const px = x - sx, py = y - sy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      scores[y * w + x] = Math.abs(curr[y * w + x] - prev[py * w + px]);
    }
  }
  return scores;
}

/**
 * Multi-frame matched-motion evidence along a velocity hypothesis.
 * Samples residual/visual energy near predicted positions over a short window.
 * Returns a relative score vs a null (no-motion / random) baseline locally.
 */
export function matchedMotionScore({
  frames, // [{ gray, w, h, t }] chronological, length 3–7
  x0, y0, // position in frames[mid] local crop pixels
  mid = 1,
  vx, vy, // px per second in crop space
  sampleRadius = 2
}) {
  if (!frames?.length || mid < 0 || mid >= frames.length) return 0;
  const w = frames[mid].w, h = frames[mid].h;
  let evidence = 0, nullEvidence = 0, samples = 0;
  for (let i = 0; i < frames.length; i++) {
    const dt = frames[i].t - frames[mid].t;
    const px = Math.round(x0 + vx * dt);
    const py = Math.round(y0 + vy * dt);
    if (px < sampleRadius || py < sampleRadius || px >= w - sampleRadius || py >= h - sampleRadius) continue;
    const g = frames[i].gray;
    let local = 0, n = 0;
    for (let yy = py - sampleRadius; yy <= py + sampleRadius; yy++) {
      for (let xx = px - sampleRadius; xx <= px + sampleRadius; xx++) {
        const dog = Math.abs(dogResponse(g, w, h, xx, yy, 1, 3));
        local += dog;
        n++;
      }
    }
    const mean = n ? local / n : 0;
    evidence += mean;
    // Null: same radius offset away from the predicted path.
    const nx = Math.min(w - sampleRadius - 1, Math.max(sampleRadius, px + 8));
    const ny = Math.min(h - sampleRadius - 1, Math.max(sampleRadius, py + 8));
    let nloc = 0, nn = 0;
    for (let yy = ny - sampleRadius; yy <= ny + sampleRadius; yy++) {
      for (let xx = nx - sampleRadius; xx <= nx + sampleRadius; xx++) {
        nloc += Math.abs(dogResponse(g, w, h, xx, yy, 1, 3));
        nn++;
      }
    }
    nullEvidence += nn ? nloc / nn : 0;
    samples++;
  }
  if (!samples) return 0;
  return (evidence - nullEvidence) / samples;
}

export class RoiEvidenceDetector {
  constructor({ topK = 12, minVisual = 5 } = {}) {
    this.topK = topK;
    this.minVisual = minVisual;
    this.prevGray = null;
  }

  /**
   * @param {Uint8ClampedArray} rgba crop pixels
   * @param {number} width
   * @param {number} height
   * @param {{ t:number, left:number, top:number, prevRgba?:Uint8ClampedArray, motionHypotheses?: {vx:number,vy:number}[], frames?: object[] }} ctx
   * @returns {RoiCandidate[]}
   */
  detect(rgba, width, height, ctx = {}) {
    const gray = rgbaToGray(rgba, width, height);
    const visual = visualScoreMap(gray, width, height);
    let temporal = null;
    if (ctx.prevRgba) {
      const prev = rgbaToGray(ctx.prevRgba, width, height);
      temporal = temporalResidualMap(gray, prev, width, height, ctx.shift || { x: 0, y: 0 });
    } else if (this.prevGray && this.prevGray.length === gray.length) {
      temporal = temporalResidualMap(gray, this.prevGray, width, height, ctx.shift || { x: 0, y: 0 });
    }

    const combined = new Float32Array(width * height);
    for (let i = 0; i < combined.length; i++) {
      combined[i] = visual[i] + (temporal ? temporal[i] * 0.25 : 0);
    }
    // Larger NMS radius so one bright blob cannot fill the entire top-K list.
    const primary = nmsPeaks(combined, width, height, { k: this.topK, minScore: this.minVisual, radius: 6 });
    // Second pass at lower threshold for faint companions far from primary peaks.
    const secondary = nmsPeaks(visual, width, height, { k: this.topK, minScore: this.minVisual * 0.55, radius: 6 });
    const peaks = [];
    const take = list => {
      for (const p of list) {
        if (peaks.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 6)) continue;
        peaks.push(p);
        if (peaks.length >= this.topK) return;
      }
    };
    take(primary);
    take(secondary);
    const hyps = ctx.motionHypotheses?.length
      ? ctx.motionHypotheses
      : [{ vx: 0, vy: -40 }, { vx: 20, vy: -60 }, { vx: -20, vy: -60 }, { vx: 0, vy: -20 }];

    const frames = ctx.frames;
    /** @type {RoiCandidate[]} */
    const candidates = [];
    for (const peak of peaks) {
      const v = gray[peak.y * width + peak.x];
      const surround = (
        gray[peak.y * width + peak.x - 3] + gray[peak.y * width + peak.x + 3] +
        gray[(peak.y - 3) * width + peak.x] + gray[(peak.y + 3) * width + peak.x]
      ) / 4;
      const polarity = v >= surround ? 'bright' : 'dark';
      const temporalScore = temporal ? temporal[peak.y * width + peak.x] : 0;
      let motionScore = 0;
      if (frames?.length >= 3) {
        for (const hyp of hyps) {
          motionScore = Math.max(motionScore, matchedMotionScore({
            frames, x0: peak.x, y0: peak.y, mid: Math.floor(frames.length / 2),
            vx: hyp.vx, vy: hyp.vy
          }));
        }
      }
      candidates.push({
        x: peak.x + (ctx.left || 0),
        y: peak.y + (ctx.top || 0),
        localX: peak.x,
        localY: peak.y,
        score: peak.score + motionScore * 2.5,
        visualScore: visual[peak.y * width + peak.x],
        temporalScore,
        motionScore,
        radiusPx: 2,
        polarity,
        origin: 'roi-evidence',
        observed: true,
        t: ctx.t
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    this.prevGray = gray;
    return candidates.slice(0, this.topK);
  }

  reset() { this.prevGray = null; }
}
