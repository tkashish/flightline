/**
 * Phase 4 — global identity-safe trajectory association (engine 'v2').
 * Offline beam search over per-frame candidate lists with an explicit null hypothesis.
 * Safety rules: one id per physical launch, seeds only at the launch sample, reserved beam slots per
 * launch, static objects and pre-impact movers never extend a flight, a saturating length reward,
 * scores that ignore the trailing coast, change-point trimming, and an evidence test for abstention.
 */

/** @typedef {{ t:number, x:number, y:number, score?:number, size?:number, quality?:number, launchId?:string, id?:string }} AssocCandidate */
/** @typedef {{ t:number, f?:number, candidates:AssocCandidate[] }} AssocFrame */
/** @typedef {{ id:string, t:number, x:number, y:number, sourceSize?:number, sourceQuality?:number, confidence?:number, vx?:number, vy?:number, aliases?:string[] }} LaunchSeed */

const NULL_SCORE = 0;
// Observations past this count add no length reward (about 0.4 s at 30 Hz: enough to confirm a flight).
export const LENGTH_CAP = 12;

export function motionDt(t0, t1, { minDt = 1 / 240, maxDt = 1.5 } = {}) {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const dt = t1 - t0;
  if (!(dt >= minDt) || dt > maxDt) return null;
  return dt;
}

/**
 * Innovation cost using actual dt (pixels/second state).
 * Soft — returns additive penalty, not a hard gate.
 */
export function innovationPenalty(state, cand, dt, { posSigma = 18, velSigma = 90 } = {}) {
  const predX = state.x + state.vx * dt;
  const predY = state.y + state.vy * dt;
  // Mild upward prior only as soft bias, not hard gravity.
  const dx = cand.x - predX;
  const dy = cand.y - predY;
  const mahal = (dx * dx) / (posSigma * posSigma) + (dy * dy) / (posSigma * posSigma);
  const speed = Math.hypot(state.vx, state.vy);
  const newVx = (cand.x - state.x) / dt;
  const newVy = (cand.y - state.y) / dt;
  // Cold start: seed velocity is intentionally weak. Do not reject the first
  // real ball measurement for "impossible acceleration" from ~0 → flight speed.
  const nObs = state.nObs ?? 0;
  if (nObs < 3 || speed < 40) {
    return mahal;
  }
  const dvx = newVx - state.vx;
  const dvy = newVy - state.vy;
  // Drag and perspective slow a fast ball by a fraction of its speed per frame without turning it,
  // so slowing along the path gets a speed-relative tolerance; turning and speeding up do not.
  const ux = state.vx / speed, uy = state.vy / speed, along = dvx * ux + dvy * uy;
  const slow = Math.min(0, along), rest = (dvx * dvx + dvy * dvy) - slow * slow;
  const slowSigma = Math.max(velSigma, 0.3 * speed);
  const accel = rest / (velSigma * velSigma) + (slow * slow) / (slowSigma * slowSigma);
  // Heading flip penalty when already moving.
  let turn = 0;
  if (speed > 80) {
    const prevAng = Math.atan2(-state.vy, state.vx);
    const ang = Math.atan2(-newVy, newVx);
    const dAng = Math.abs(Math.atan2(Math.sin(ang - prevAng), Math.cos(ang - prevAng)));
    if (dAng > 0.9) turn = (dAng - 0.9) * 2.5;
  }
  return mahal + accel * 0.35 + turn;
}

export function launchPrior(seed, imageH) {
  const size = seed.sourceSize ?? seed.size ?? 0;
  const quality = seed.sourceQuality ?? seed.quality ?? 0.8;
  const sizeTerm = Math.min(28, Math.sqrt(Math.max(0, size)) * 2.4);
  const y = seed.y ?? 0;
  // Prefer mid/lower-frame address regions without forbidding sky later.
  const yTerm = y >= imageH * 0.3 && y <= imageH * 0.85 ? 6 : -4;
  return sizeTerm + quality * 12 + yTerm;
}

export function observationEvidence(cand) {
  const visual = cand.score ?? ((cand.quality ?? 0.7) * 20);
  const size = cand.size ?? 2;
  // Tiny far balls still count; huge blobs are mildly down-weighted.
  const sizeTerm = size >= 2 && size <= 80 ? 2 : size > 80 ? -3 : 0;
  return Math.max(0.2, visual * 0.15) + sizeTerm;
}

export function gapPenalty(missStreak, dtSum) {
  // Brief misses OK; long unsupported gaps hurt (time-aware).
  if (missStreak <= 0) return 0;
  return missStreak * 0.55 + Math.max(0, dtSum - 0.12) * 8;
}

/**
 * score = launchPrior + mean(evidence) * log(1 + min(n, lengthCap)) - 1.2 * mean(motion)
 *         - gaps * min(1, gapCap / n) - identity.
 * The length reward saturates, so a path cannot win by collecting more of the same evidence.
 * The search keeps full gap penalties (coasting through noise must cost); the final judgment passes
 * gapCap = lengthCap so a long flight is not penalised for the same rate of misses as a short one.
 */
export function pathScore(parts, lengthCap = LENGTH_CAP, gapCap = Infinity) {
  const n = Math.max(1, parts.nObs);
  const lengthWeight = Math.log1p(Math.min(n, lengthCap));
  return parts.launch
    + (parts.evidenceSum / n) * lengthWeight
    - (parts.motionSum / n) * 1.2
    - parts.gapSum * Math.min(1, gapCap / n)
    - parts.identityPenalty;
}

/**
 * One physical launch often produces several legacy ids (same address spot, impact a frame or two apart).
 * Merge them so association never treats one ball as rival launches. The earliest impact wins.
 */
export function mergeLaunches(launches = [], { radiusPx = 4, windowSec = 0.15 } = {}) {
  const sorted = (launches || [])
    .filter(l => l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.t))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const l of sorted) {
    const aliases = l.aliases?.length ? l.aliases : [l.id];
    const hinted = Number.isFinite(l.vx) && Number.isFinite(l.vy) && l.hint !== false;
    const m = out.find(o => l.t - o.t <= windowSec && Math.hypot(l.x - o.x, l.y - o.y) <= radiusPx);
    if (!m) { out.push({ ...l, aliases: [...aliases] }); continue; }
    m.aliases.push(...aliases.filter(id => !m.aliases.includes(id)));
    m.sourceSize = Math.max(m.sourceSize ?? 0, l.sourceSize ?? 0) || m.sourceSize;
    m.sourceQuality = Math.max(m.sourceQuality ?? 0, l.sourceQuality ?? 0) || m.sourceQuality;
    if (Number.isFinite(l.confidence)) m.confidence = Math.max(m.confidence ?? -Infinity, l.confidence);
    // Keep the earliest launch's velocity hint; a later alias measures a longer first step.
    const mHinted = Number.isFinite(m.vx) && Number.isFinite(m.vy) && m.hint !== false;
    if (hinted && !mHinted) { m.vx = l.vx; m.vy = l.vy; m.hint = true; }
  }
  return out;
}

function medianDt(frames) {
  const d = [];
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt > 1e-6) d.push(dt);
  }
  if (!d.length) return 1 / 30;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/**
 * Static objects: a candidate re-observed at the same stabilized position (±radius) in at least
 * `minRepeats` of the surrounding ±window frames (a speck, sign, shoe, the parked address ball).
 * Returns the set of static candidate objects; inputs are not modified.
 */
export function labelStatic(frames, { radiusPx = 1.5, window = 30, minRepeats = 8 } = {}) {
  const out = new Set();
  const cell = radiusPx * 2, grid = new Map();
  const key = (cx, cy) => (cx + 50000) * 100000 + (cy + 50000);
  frames.forEach((f, fi) => {
    for (const c of f.candidates || []) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      const k = key(Math.floor(c.x / cell), Math.floor(c.y / cell));
      let list = grid.get(k);
      if (!list) grid.set(k, list = []);
      list.push(fi, c.x, c.y);
    }
  });
  const stamp = new Int32Array(frames.length).fill(-1);
  let s = 0;
  frames.forEach((f, fi) => {
    for (const c of f.candidates || []) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      s++;
      let n = 0;
      const cx = Math.floor(c.x / cell), cy = Math.floor(c.y / cell);
      scan: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(key(cx + dx, cy + dy));
        if (!list) continue;
        let lo = 0, hi = list.length / 3;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid * 3] < fi - window) lo = mid + 1; else hi = mid; }
        for (let e = lo * 3; e < list.length && list[e] <= fi + window; e += 3) {
          const fj = list[e];
          if (fj === fi || stamp[fj] === s) continue;
          if (Math.abs(list[e + 1] - c.x) <= radiusPx && Math.abs(list[e + 2] - c.y) <= radiusPx) {
            stamp[fj] = s;
            if (++n >= minRepeats) break scan;
          }
        }
      }
      if (n >= minRepeats) out.add(c);
    }
  });
  return out;
}

function lineFit(points) {
  let n = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
  const tm = points[0].t;
  for (const p of points) { const u = p.t - tm; n++; st += u; stt += u * u; sx += p.x; sy += p.y; stx += u * p.x; sty += u * p.y; }
  const den = n * stt - st * st;
  const vx = den > 1e-12 ? (n * stx - st * sx) / den : 0, vy = den > 1e-12 ? (n * sty - st * sy) / den : 0;
  const x0 = (sx - vx * st) / n, y0 = (sy - vy * st) / n;
  const at = t => ({ x: x0 + vx * (t - tm), y: y0 + vy * (t - tm) });
  let e = 0;
  for (const p of points) { const q = at(p.t); e += (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }
  return { vx, vy, at, rms: Math.sqrt(e / n) };
}

/**
 * Pre-impact movers: constant-velocity tracklets (≥ minPoints) that already moved before a launch
 * (airplane, bird, another player's ball). Their straight-line continuation after the launch is barred
 * from that launch's flight beams. Swing parts passing through the address at impact are exempt.
 * Returns Map(launchId -> Set of inadmissible candidates).
 */
export function labelMovers(frames, launches, {
  staticSet = new Set(), dtTol = 1 / 60, minPoints = 5, maxGapSec = 0.2, linkPx = 4, firstLinkPx = 30,
  minSpeed = 6, minTravelPx = 3, maxRms = 1.5, horizonSec = 3
} = {}) {
  const out = new Map();
  const order = [...launches].sort((a, b) => a.t - b.t);
  const long = [];
  let open = [], k = 0;
  const snapshot = launch => {
    const barred = new Set();
    const r = Math.max(12, 2.3 * Math.sqrt(Math.max(1, launch.sourceSize ?? 20)));
    for (const tr of long) {
      if (tr.at(-1).t >= launch.t - dtTol) continue;
      const fit = lineFit(tr), speed = Math.hypot(fit.vx, fit.vy);
      if (fit.rms > maxRms || speed < minSpeed || Math.hypot(tr.at(-1).x - tr[0].x, tr.at(-1).y - tr[0].y) < minTravelPx) continue;
      let swing = false;
      for (let u = -0.2; u <= 0.2 + 1e-9 && !swing; u += 0.05) {
        const q = fit.at(launch.t + u);
        swing = Math.hypot(q.x - launch.x, q.y - launch.y) <= r;
      }
      if (swing) continue;
      const tLast = tr.at(-1).t;
      for (const f of frames) {
        if (f.t <= launch.t - dtTol) continue;
        if (f.t > tLast + horizonSec) break;
        const q = fit.at(f.t), gate = 3 + Math.min(5, 0.02 * speed * (f.t - tLast));
        for (const c of f.candidates || []) if (Math.hypot(c.x - q.x, c.y - q.y) <= gate) barred.add(c);
      }
    }
    return barred;
  };
  for (const f of frames) {
    while (k < order.length && f.t >= order[k].t - dtTol) { out.set(order[k].id, snapshot(order[k])); k++; }
    if (k >= order.length) break;
    open = open.filter(tr => f.t - tr.at(-1).t <= maxGapSec);
    const used = new Set();
    for (const c of f.candidates || []) {
      if (staticSet.has(c) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      let best = null, bd = Infinity;
      for (const tr of open) {
        if (used.has(tr)) continue;
        const l = tr.at(-1), dt = f.t - l.t;
        if (dt <= 1e-6) continue;
        let px = l.x, py = l.y, gate = firstLinkPx;
        if (tr.length >= 2) {
          const p = tr.at(-2), pdt = Math.max(1e-6, l.t - p.t);
          px += (l.x - p.x) / pdt * dt; py += (l.y - p.y) / pdt * dt;
          gate = linkPx + 1.5 * Math.max(0, Math.round(dt / pdt) - 1);
        }
        const d = Math.hypot(c.x - px, c.y - py);
        if (d <= gate && d < bd) { bd = d; best = tr; }
      }
      if (best) { best.push(c); used.add(best); if (best.length === minPoints) long.push(best); }
      else { const tr = [c]; open.push(tr); used.add(tr); if (minPoints <= 1) long.push(tr); }
    }
  }
  while (k < order.length) { out.set(order[k].id, snapshot(order[k])); k++; }
  return out;
}

// Least-squares polynomial of `degree` in time over points[from..to) (centred on the last point). Below
// degree + 2 points the higher terms are damped so the fit stays near-linear.
function polyFit(points, key, degree = 2, from = 0, to = points.length) {
  const n = degree + 1, t0 = points[to - 1].t, S = new Float64Array(2 * n - 1), Y = new Float64Array(n);
  for (let i = from; i < to; i++) {
    const u = points[i].t - t0, v = points[i][key];
    let w = 1;
    for (let k = 0; k < 2 * n - 1; k++) { S[k] += w; if (k < n) Y[k] += w * v; w *= u; }
  }
  const M = [];
  for (let i = 0; i < n; i++) { const row = new Float64Array(n + 1); for (let j = 0; j < n; j++) row[j] = S[i + j]; row[n] = Y[i]; M.push(row); }
  if (to - from < degree + 2) for (let i = 2; i < n; i++) M[i][i] += 1e3;
  for (let i = 0; i < n; i++) {
    let pv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[pv][i])) pv = r;
    [M[i], M[pv]] = [M[pv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  const q = M.map((row, i) => Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]);
  if (!q.every(Number.isFinite)) return () => points[to - 1][key];
  return t => { const u = t - t0; let v = 0, w = 1; for (const c of q) { v += c * w; w *= u; } return v; };
}
const quadFit = (points, key, from, to) => polyFit(points, key, 2, from, to);

function rmsFit(points, fx, fy, from = 0, to = points.length) {
  let e = 0;
  for (let i = from; i < to; i++) { const p = points[i]; e += (p.x - fx(p.t)) ** 2 + (p.y - fy(p.t)) ** 2; }
  return Math.sqrt(e / (to - from));
}

/**
 * Track-level change point: the first j where a smooth curve through the ≤ headLen points before j
 * cannot absorb the next tailLen points. The joint fit is cubic, so drag and perspective deceleration
 * are absorbed while a switch to another object (airplane, bird, speck) leaves a kink. The tail is cut
 * after extending the head while each next point stays on its extrapolation.
 */
export function trimChangePoint(points, { minHead = 8, headLen = 10, tailLen = 8, floorPx = 1, k = 2.5, kRefine = 3 } = {}) {
  for (let j = minHead; j + tailLen <= points.length; j++) {
    const h0 = Math.max(0, j - headLen), e = j + tailLen;
    const step = Math.hypot(points[j - 1].x - points[j - 2].x, points[j - 1].y - points[j - 2].y);
    const sig = Math.max(rmsFit(points, quadFit(points, 'x', h0, j), quadFit(points, 'y', h0, j), h0, j), 0.35 + 0.03 * step);
    if (rmsFit(points, polyFit(points, 'x', 3, h0, e), polyFit(points, 'y', 3, h0, e), h0, e) <= Math.max(floorPx, k * sig)) continue;
    let m = j;
    while (m < points.length) {
      const g0 = Math.max(0, m - headLen), gx = quadFit(points, 'x', g0, m), gy = quadFit(points, 'y', g0, m);
      const gapFrames = Math.max(0, (points[m].t - points[m - 1].t) / Math.max(1e-3, points[m - 1].t - points[m - 2].t) - 1);
      const r = Math.hypot(points[m].x - gx(points[m].t), points[m].y - gy(points[m].t));
      if (r > Math.max(floorPx, kRefine * Math.max(rmsFit(points, gx, gy, g0, m), 0.35 + 0.03 * step)) + 0.5 * gapFrames) break;
      m++;
    }
    return { points: points.slice(0, m), cut: m };
  }
  return { points, cut: null };
}

// Share of interior observations that a local quadratic through their neighbours predicts.
function coherentFraction(obs, { half = 3, floorPx = 4, rel = 0.5 } = {}) {
  if (obs.length < 3) return 1;
  let ok = 0;
  for (let i = 1; i < obs.length - 1; i++) {
    const nb = [...obs.slice(Math.max(0, i - half), i), ...obs.slice(i + 1, i + 1 + half)];
    const r = Math.hypot(obs[i].x - quadFit(nb, 'x')(obs[i].t), obs[i].y - quadFit(nb, 'y')(obs[i].t));
    const step = Math.hypot(obs[i + 1].x - obs[i - 1].x, obs[i + 1].y - obs[i - 1].y) / 2;
    if (r <= Math.max(floorPx, rel * step)) ok++;
  }
  return ok / (obs.length - 2);
}

/**
 * Evidence test that replaces the old climb/span stump rule. A flight must:
 * - have ≥ minObs observations after the launch sample;
 * - leave the address by ≥ minDepartPx and rise ≥ minRisePx above it at some point (a full arc may
 *   land low, but it rose first);
 * - not fly back to the address (a practice swing or a club does; a ball that lands low lands far away);
 * - come from the address: its first observations, run back to the launch time, land on the anchor;
 * - move coherently and ballistically (each image velocity component changes sign at most once,
 *   vertically only from up to down), and never run much faster than at launch.
 * `whole` is the path the return and ballistic tests judge: the untrimmed path when a cut tail is the
 * same object moving on, else the trimmed path.
 */
export function flightEvidence(points, launch, { minObs = 5, minDepartPx = 40, minRisePx = 25, returnFrac = 0.35, minCoherence = 0.5, launchTolerance = 8, ballistic = true, maxSpeedup = 2.5, whole = points, frameInterval = null } = {}) {
  const t0 = launch?.t ?? points[0]?.t ?? 0;
  const ax = launch?.x ?? points[0]?.x ?? 0, ay = launch?.y ?? points[0]?.y ?? 0;
  const after = list => list.filter(p => p.status !== 'anchor' && p.t > t0 + 1e-6);
  const obs = after(points), all = after(whole);
  const d = p => Math.hypot(p.x - ax, p.y - ay);
  const stats = { nObs: obs.length, departPx: 0, risePx: 0, endPx: 0, coherence: 0 };
  if (obs.length < minObs) return { ok: false, reason: 'insufficient_visible_frames', ...stats };
  stats.departPx = Math.max(...obs.map(d));
  if (stats.departPx < minDepartPx) return { ok: false, reason: 'no_departure', ...stats };
  stats.risePx = Math.max(...obs.map(p => ay - p.y));
  if (stats.risePx < minRisePx) return { ok: false, reason: 'no_rise', ...stats };
  const wholeMax = Math.max(...all.map(d));
  stats.endPx = d(all.at(-1));
  if (stats.endPx < returnFrac * wholeMax) return { ok: false, reason: 'returned_to_address', ...stats };
  // Impact can fall up to a frame after the launch sample, hence the speed term.
  const early = obs.slice(0, Math.min(obs.length, 5)), fit = lineFit(early);
  const back = fit.at(t0), frameDt = Math.max(1e-3, frameInterval ?? medianDt(obs));
  const stepPx = Math.hypot(fit.vx, fit.vy) * frameDt;
  stats.launchMissPx = Math.hypot(back.x - ax, back.y - ay);
  if (stats.launchMissPx > Math.max(launchTolerance, 1.5 * stepPx) + 0.25 * stepPx * (early[0].t - t0) / frameDt) {
    return { ok: false, reason: 'not_from_address', ...stats };
  }
  stats.coherence = coherentFraction(obs);
  if (stats.coherence < minCoherence) return { ok: false, reason: 'incoherent', ...stats };
  if (ballistic && !ballisticSigns(all)) return { ok: false, reason: 'not_ballistic', ...stats };
  // A ball is fastest at launch; a path that later runs several times faster is a club or a body part.
  stats.speedup = speedup(obs, 2 / frameDt);
  if (stats.speedup > maxSpeedup) return { ok: false, reason: 'accelerates', ...stats };
  return { ok: true, reason: null, ...stats };
}

function speedup(obs, floor) {
  const v = [];
  for (let i = 1; i < obs.length; i++) {
    const dt = obs[i].t - obs[i - 1].t;
    if (dt > 1e-6) v.push(Math.hypot(obs[i].x - obs[i - 1].x, obs[i].y - obs[i - 1].y) / dt);
  }
  const sm = v.map((s, i) => i && i < v.length - 1 ? [v[i - 1], s, v[i + 1]].sort((a, b) => a - b)[1] : s);
  if (sm.length < 6) return 0;
  return Math.max(...sm.slice(3)) / Math.max(floor, [...sm.slice(0, 3)].sort((a, b) => a - b)[1]);
}

// A ball's image velocity changes sign at most once per axis: vertically only from climbing to falling,
// horizontally at most once (a hook or slice that curves back). Reversals are counted with hysteresis on
// the positions, with a band above the path's own jitter (6-12 px), so noise and a slow apex do not count.
function ballisticSigns(obs) {
  return moves(obs.map(p => p.x)).length <= 2 && verticalOk(moves(obs.map(p => p.y)));
}
const verticalOk = m => m.length <= 1 || (m.length === 2 && m[0] < 0);
function moves(vals) {
  const d2 = [];
  for (let i = 1; i < vals.length - 1; i++) d2.push(Math.abs(vals[i + 1] - 2 * vals[i] + vals[i - 1]));
  d2.sort((a, b) => a - b);
  const band = Math.min(12, Math.max(6, 3 * (d2[Math.floor(d2.length / 2)] || 0)));
  const out = [];
  let dir = 0, ext = vals[0], lo = vals[0], hi = vals[0];
  for (const v of vals) {
    if (dir === 0) {
      lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (v - lo > band) { dir = 1; ext = v; out.push(1); } else if (hi - v > band) { dir = -1; ext = v; out.push(-1); }
    } else if (dir * (v - ext) > 0) ext = v;
    else if (Math.abs(v - ext) > band) { dir = -dir; ext = v; out.push(dir); }
  }
  return out;
}

function prefixScore(beam, k, lengthCap, gapCap = Infinity) {
  let evidenceSum = 0, motionSum = 0, gapSum = 0, identityPenalty = 0;
  for (let i = 0; i < k; i++) {
    const p = beam.points[i];
    evidenceSum += p.ev ?? 0; motionSum += p.mo ?? 0; gapSum += p.gap ?? 0; identityPenalty += p.idp ?? 0;
  }
  return pathScore({ launch: beam.launch, evidenceSum, motionSum, gapSum, identityPenalty, nObs: k }, lengthCap, gapCap);
}

/**
 * Beam-search association.
 * @returns {{ status:'tracked'|'partial'|'no_reliable_track', points:object[], score:number, margin:number, reasonCodes:string[], beams:object[] }}
 */
export function associateFlight({
  frames,
  launches = [],
  imageWidth = 720,
  imageHeight = 1280,
  beamWidth = 24,
  maxMiss = 8,
  minObs = 5,
  nullMargin = 2.5,
  gatePx = 55,
  quota = 4,
  reserveSec = 1,
  lengthCap = LENGTH_CAP,
  labels = true,
  changePoint = true,
  evidence = {}
} = {}) {
  if (!frames?.length) {
    return {
      status: 'no_reliable_track',
      points: [],
      score: NULL_SCORE,
      margin: 0,
      reasonCodes: ['no_frames'],
      beams: []
    };
  }
  const seeds = mergeLaunches(launches);
  if (!seeds.length) {
    return { status: 'no_reliable_track', points: [], score: NULL_SCORE, margin: 0, reasonCodes: ['no_launch'], beams: [] };
  }
  frames = [...frames].sort((a, b) => a.t - b.t);
  const frameDt = medianDt(frames), dtTol = Math.min(0.05, Math.max(1 / 480, frameDt / 2));
  const staticSet = labels ? labelStatic(frames) : new Set();
  const movers = labels ? labelMovers(frames, seeds, { staticSet, dtTol }) : new Map();
  const launchById = new Map(seeds.map(l => [l.id, l]));
  const nullScore = new Map(), bornAt = new Map();
  const score = b => pathScore({ ...b, gapSum: b.gapAtObs }, lengthCap);
  const searchScore = b => pathScore(b, lengthCap);

  /** @type {object[]} */
  let beams = [];
  // Per launch, the best-scoring and the longest finished beams (scored as of their last observation).
  const archive = new Map();
  const retire = beam => {
    if (beam.nObs < 2) return;
    const slot = archive.get(beam.launchId) || { byScore: [], byLength: [] };
    const entry = { beam, score: score(beam) };
    slot.byScore = [...slot.byScore, entry].sort((a, b) => b.score - a.score).slice(0, 6);
    slot.byLength = [...slot.byLength, entry].sort((a, b) => b.beam.nObs - a.beam.nObs || b.score - a.score).slice(0, 3);
    archive.set(beam.launchId, slot);
  };

  const seed = (launch, frame, frameIndex) => {
    const here = Math.abs(frame.t - launch.t) <= dtTol;
    let anchor = null, bd = 6;
    if (here) for (const c of frame.candidates || []) {
      const d = Math.hypot(c.x - launch.x, c.y - launch.y);
      if (d <= bd) { bd = d; anchor = c; }
    }
    const src = anchor || { score: 12, size: launch.sourceSize ?? 8, quality: launch.sourceQuality ?? 0.85 };
    const ev = observationEvidence(src);
    const prior = launchPrior(launch, imageHeight);
    nullScore.set(launch.id, pathScore({ launch: prior, evidenceSum: ev, motionSum: 0, gapSum: 0, identityPenalty: 0, nObs: 1 }, lengthCap));
    const t = here ? frame.t : launch.t;
    bornAt.set(launch.id, t);
    // The trace starts at the address at the launch sample, never on the parked ball before impact.
    beams.push({
      launchId: launch.id,
      x: anchor ? anchor.x : launch.x,
      y: anchor ? anchor.y : launch.y,
      t,
      f: frame.f ?? frameIndex,
      vx: Number.isFinite(launch.vx) ? launch.vx : 0,
      vy: Number.isFinite(launch.vy) ? launch.vy : -120,
      missStreak: 0,
      missTime: 0,
      nObs: 1,
      evidenceSum: ev,
      motionSum: 0,
      gapSum: 0,
      gapAtObs: 0,
      identityPenalty: 0,
      launch: prior,
      points: [{
        t, x: anchor ? anchor.x : launch.x, y: anchor ? anchor.y : launch.y, status: 'anchor',
        candidateId: anchor ? anchor.id : `${launch.id}:anchor`, launchId: launch.id, size: src.size,
        ev, mo: 0, gap: 0, idp: 0
      }],
      lastFrameIndex: frameIndex
    });
  };

  let nextSeed = 0, peakBeams = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    while (nextSeed < seeds.length && seeds[nextSeed].t <= frame.t + dtTol) seed(seeds[nextSeed++], frame, i);
    if (!beams.length) continue;

    const next = [];
    for (const beam of beams) {
      const dt = motionDt(beam.t, frame.t);
      if (dt == null) {
        // Duplicate / bogus timestamp: keep beam as-is.
        next.push(beam);
        continue;
      }

      // Skip / null observation transition.
      if (beam.missStreak + 1 <= maxMiss) {
        next.push({
          ...beam,
          missStreak: beam.missStreak + 1,
          missTime: beam.missTime + dt,
          gapSum: beam.gapSum + gapPenalty(1, dt),
          t: frame.t,
          f: frame.f ?? i,
          x: beam.x + beam.vx * dt,
          y: beam.y + beam.vy * dt,
          lastFrameIndex: i
        });
      } else {
        retire(beam);
        continue;
      }

      const barred = movers.get(beam.launchId);
      for (const cand of frame.candidates || []) {
        // A flying ball is never a static object or an object that was already moving before impact.
        if (staticSet.has(cand) || barred?.has(cand)) continue;
        const predX = beam.x + beam.vx * dt;
        const predY = beam.y + beam.vy * dt;
        // Early observations need a wide gate: seed velocity is unreliable.
        const early = beam.nObs < 4;
        const gate = (early ? gatePx * 2.2 : gatePx) + Math.hypot(beam.vx, beam.vy) * dt * (early ? 0.9 : 0.35);
        if (Math.hypot(cand.x - predX, cand.y - predY) > gate) continue;
        const innov = innovationPenalty(beam, cand, dt);
        if (innov > (early ? 40 : 14)) continue;
        const newVx = (cand.x - beam.x) / dt;
        const newVy = (cand.y - beam.y) / dt;
        // Soft identity: jumping to a much larger blob mid-flight is suspicious.
        const idp = beam.nObs >= 4 && (cand.size ?? 0) > 40 && (cand.size ?? 0) > (beam.points.at(-1)?.size ?? 8) * 2.5 ? 6 : 0;
        const ev = observationEvidence(cand);
        next.push({
          launchId: beam.launchId,
          x: cand.x,
          y: cand.y,
          t: frame.t,
          f: frame.f ?? i,
          vx: beam.vx * 0.35 + newVx * 0.65,
          vy: beam.vy * 0.35 + newVy * 0.65,
          missStreak: 0,
          missTime: 0,
          nObs: beam.nObs + 1,
          evidenceSum: beam.evidenceSum + ev,
          motionSum: beam.motionSum + innov,
          gapSum: beam.gapSum,
          gapAtObs: beam.gapSum,
          identityPenalty: beam.identityPenalty + idp,
          launch: beam.launch,
          points: [...beam.points, {
            t: frame.t, x: cand.x, y: cand.y, status: 'observed',
            candidateId: cand.id, launchId: beam.launchId, size: cand.size,
            ev, mo: innov, gap: beam.gapSum - beam.gapAtObs, idp
          }],
          lastFrameIndex: i
        });
      }
    }

    // Prune by score, but a young launch (seeded within reserveSec) keeps its best `quota` beams, so a
    // later real launch cannot be evicted at birth by many established beams of earlier launches. Once
    // its length reward has ramped up it competes on score, which keeps the beam count bounded.
    next.sort((a, b) => searchScore(b) - searchScore(a));
    const kept = [], rest = [], perLaunch = new Map(), reserved = new Set();
    for (const b of next) {
      const n = perLaunch.get(b.launchId) || 0;
      if (n < quota && frame.t - bornAt.get(b.launchId) <= reserveSec) { perLaunch.set(b.launchId, n + 1); kept.push(b); reserved.add(b.launchId); } else rest.push(b);
    }
    const cap = Math.max(quota, Math.floor(beamWidth / 3)), total = beamWidth + quota * reserved.size;
    for (const b of rest) {
      if (kept.length >= total) break;
      const n = perLaunch.get(b.launchId) || 0;
      if (n >= cap) continue;
      perLaunch.set(b.launchId, n + 1);
      kept.push(b);
    }
    beams = kept;
    peakBeams = Math.max(peakBeams, beams.length);
  }
  for (const beam of beams) retire(beam);

  // Judge each launch: cut a foreign tail, rescore, then apply the evidence test. Within one launch the
  // longest trimmed path is preferred (uncapped length); identity across launches uses the capped score.
  const judged = [], rejected = [];
  for (const [launchId, slot] of archive) {
    const launch = launchById.get(launchId);
    const entries = [...new Set([...slot.byScore, ...slot.byLength].map(e => e.beam))].map(beam => {
      const cut = changePoint ? trimChangePoint(beam.points) : { points: beam.points, cut: null };
      const k = cut.points.length;
      const s = prefixScore(beam, k, lengthCap, lengthCap);
      return { beam, launchId, points: cut.points, cut: cut.cut, score: s, rank: prefixScore(beam, k, Infinity), margin: s - (nullScore.get(launchId) ?? NULL_SCORE) };
    }).sort((a, b) => b.rank - a.rank);
    let tries = 0;
    for (const entry of entries) {
      if (tries++ >= 4) break;
      // A tail cut without a gap is the same object moving on: judge return and ballistics on all of it.
      // A tail that starts after missed frames is another object, and only the head is judged.
      const pts = entry.beam.points, c = entry.cut;
      const whole = c != null && c < pts.length && pts[c].t - pts[c - 1].t <= 1.5 * frameDt ? pts : entry.points;
      entry.verdict = flightEvidence(entry.points, launch, { minObs, frameInterval: frameDt, ...evidence, whole });
      if (entry.verdict.ok && entry.margin >= nullMargin) { judged.push(entry); break; }
      if (entry.verdict.ok) entry.verdict = { ...entry.verdict, ok: false, reason: 'null_margin' };
      rejected.push(entry);
    }
  }
  judged.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => b.score - a.score);
  const diag = [...judged, ...rejected].sort((a, b) => b.score - a.score).slice(0, 5).map(summarize);

  const best = judged[0];
  if (!best) {
    const top = rejected[0];
    const enough = rejected.some(r => r.verdict.nObs >= minObs);
    return {
      status: 'no_reliable_track',
      points: [],
      score: top?.score ?? NULL_SCORE,
      margin: top?.margin ?? 0,
      reasonCodes: [enough ? 'no_ball_evidence' : 'insufficient_visible_frames'],
      beams: diag,
      peakBeams
    };
  }
  const runnerUp = judged.find(j => j.launchId !== best.launchId);
  const vsRunner = runnerUp ? best.score - runnerUp.score : best.margin;
  const points = best.points.map(({ ev, mo, gap, idp, ...p }) => p);
  const status = points.length >= minObs + 4 ? 'tracked' : 'partial';
  const reasonCodes = [];
  if (runnerUp && vsRunner < 1.5) reasonCodes.push('ambiguous_launch');
  return {
    status,
    points,
    score: best.score,
    margin: best.margin,
    vsRunner,
    selectedLaunchId: best.launchId,
    reasonCodes,
    changePoint: best.cut,
    beams: diag,
    peakBeams
  };
}

function summarize(entry) {
  const b = entry.beam;
  return {
    launchId: b.launchId,
    score: entry.score,
    margin: entry.margin,
    nObs: entry.points.length,
    firstT: entry.points[0]?.t,
    lastT: entry.points.at(-1)?.t,
    launch: b.launch,
    identityPenalty: b.identityPenalty,
    cut: entry.cut,
    verdict: entry.verdict.ok ? 'ok' : entry.verdict.reason
  };
}

/**
 * Convenience: build association input from MotionTracker-like tracks/hypotheses.
 * Each track becomes both a launch seed and a dense candidate timeline.
 */
export function framesFromTracks(tracks, { sampleAllPoints = true } = {}) {
  const byT = new Map();
  for (const track of tracks || []) {
    const pts = track.points || [];
    for (const p of pts) {
      if (![p.t, p.x, p.y].every(Number.isFinite)) continue;
      const key = p.t.toFixed(4);
      if (!byT.has(key)) byT.set(key, { t: p.t, f: p.f, candidates: [] });
      byT.get(key).candidates.push({
        t: p.t, x: p.x, y: p.y,
        size: p.size, quality: p.quality,
        score: (p.quality ?? 0.8) * 18 + Math.min(10, Math.sqrt(p.size ?? 2)),
        id: `${track.launchId || 'T'}:${p.f}:${p.x|0}:${p.y|0}`,
        launchId: track.launchId
      });
    }
    if (!sampleAllPoints && pts.length) break;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function launchVelocityFromTrack(track) {
  const pts = track?.points;
  if (!pts || pts.length < 2) return { vx: 0, vy: -120, hint: false };
  const a = pts[0], b = pts[Math.min(3, pts.length - 1)];
  const dt = Math.max(1 / 240, (b.t ?? 0) - (a.t ?? 0));
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt, hint: true };
}

export function launchesFromHypotheses(hypotheses, tracks) {
  const out = [];
  const trackById = new Map((tracks || []).filter(t => t?.launchId).map(t => [t.launchId, t]));
  for (const h of hypotheses || []) {
    const track = trackById.get(h.id);
    const vel = track ? launchVelocityFromTrack(track) : { vx: 0, vy: -120, hint: false };
    out.push({
      id: h.id,
      t: h.impactT ?? h.t,
      x: h.anchorX ?? h.x,
      y: h.anchorY ?? h.y,
      sourceSize: h.sourceSize,
      sourceQuality: h.sourceQuality,
      confidence: h.confidence,
      vx: vel.vx,
      vy: vel.vy,
      hint: vel.hint
    });
  }
  for (const track of tracks || []) {
    if (!track.launchId || !track.points?.[0]) continue;
    if (out.some(l => l.id === track.launchId)) continue;
    const p = track.points[0];
    const vel = launchVelocityFromTrack(track);
    out.push({
      id: track.launchId,
      t: p.t,
      x: p.x,
      y: p.y,
      sourceSize: track.sourceSize ?? p.size,
      sourceQuality: track.sourceQuality ?? p.quality,
      vx: vel.vx,
      vy: vel.vy,
      hint: vel.hint
    });
  }
  return mergeLaunches(out);
}

/** Merge detector frameLog with linked-track observations so mid-flight balls stay visible. */
export function mergeAssocFrames(frameLog = [], trackFrames = []) {
  const byT = new Map();
  for (const frame of frameLog) {
    byT.set(frame.t.toFixed(4), {
      t: frame.t,
      f: frame.f,
      candidates: [...(frame.candidates || [])]
    });
  }
  for (const frame of trackFrames) {
    const key = frame.t.toFixed(4);
    if (!byT.has(key)) byT.set(key, { t: frame.t, f: frame.f, candidates: [] });
    const slot = byT.get(key);
    for (const cand of frame.candidates || []) {
      if (!slot.candidates.some(c => Math.hypot(c.x - cand.x, c.y - cand.y) < 2.5)) {
        slot.candidates.push(cand);
      }
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Convert association result to renderer contract (normalized coords).
 */
export function toRendererResult(assoc, { width, height, camera = [], engine = 'global-v2' }) {
  // The anchor (address at the launch sample) and observed points only — never predicted fills.
  const points = (assoc.points || [])
    .filter(p => (p.status == null || p.status === 'observed' || p.status === 'anchor') && [p.t, p.x, p.y].every(Number.isFinite))
    .map(p => ({ t: p.t, x: p.x / width, y: p.y / height }));
  return {
    points,
    camera,
    engine,
    observedFrames: points.length,
    status: assoc.status,
    confidence: assoc.margin,
    vsRunner: assoc.vsRunner,
    reasonCodes: assoc.reasonCodes || [],
    selectedLaunchId: assoc.selectedLaunchId || null,
    diagnostics: {
      beams: assoc.beams,
      score: assoc.score,
      margin: assoc.margin,
      vsRunner: assoc.vsRunner,
      changePoint: assoc.changePoint ?? null
    }
  };
}
