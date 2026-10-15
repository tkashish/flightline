// Half the stroke half-width (14 px per 1280 px): every observation stays inside the drawn line.
export const SMOOTH_TOLERANCE = 0.0025;
const isManual = p => p.manual === true || p.status === 'manual';

// Local quadratic in time around t (tricube weights times robustness weights) evaluated at t.
function localTrend(points, i, weights, axis, half = 3) {
  const lo = Math.max(0, i - half), hi = Math.min(points.length - 1, i + half), t0 = points[i].t;
  let h = 0;
  for (let j = lo; j <= hi; j++) h = Math.max(h, Math.abs(points[j].t - t0));
  h = h * 1.0001 || 1;
  const S = [0, 0, 0, 0, 0], Y = [0, 0, 0];
  for (let j = lo; j <= hi; j++) {
    const u = points[j].t - t0, d = Math.abs(u) / h, w = (1 - d * d * d) ** 3 * weights[j];
    let m = w;
    for (let k = 0; k < 5; k++) { S[k] += m; if (k < 3) Y[k] += m * points[j][axis]; m *= u; }
  }
  // Solve [S0 S1 S2; S1 S2 S3; S2 S3 S4] c = Y for c0 (the value at t0), lightly ridged.
  const a = [[S[0], S[1], S[2]], [S[1], S[2] + 1e-12, S[3]], [S[2], S[3], S[4] + 1e-12]];
  const det = m3 => m3[0][0] * (m3[1][1] * m3[2][2] - m3[1][2] * m3[2][1]) - m3[0][1] * (m3[1][0] * m3[2][2] - m3[1][2] * m3[2][0]) + m3[0][2] * (m3[1][0] * m3[2][1] - m3[1][1] * m3[2][0]);
  const D = det(a);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-18) return S[0] > 0 ? Y[0] / S[0] : points[i][axis];
  const c0 = det([[Y[0], a[0][1], a[0][2]], [Y[1], a[1][1], a[1][2]], [Y[2], a[2][1], a[2][2]]]) / D;
  return Number.isFinite(c0) ? c0 : points[i][axis];
}

// Settle knots for drawing: a robust trend may move each interior observation by at most `tolerance`
// (normalized units). Endpoints and manual points are exact and no observation is ever dropped.
function settleFlight(points, tolerance, half = 4) {
  const sorted = points.filter(p => [p.t, p.x, p.y].every(Number.isFinite)).sort((a, b) => a.t - b.t);
  const knots = [];
  for (const p of sorted) {
    const last = knots.at(-1);
    // Two samples at one instant cannot both lie on the curve; a manual one wins, else their mean.
    if (last && p.t - last.t < 1e-6) {
      if (isManual(p) && !isManual(last)) knots[knots.length - 1] = { ...p };
      else if (isManual(p) === isManual(last)) knots[knots.length - 1] = { ...last, x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      continue;
    }
    knots.push({ ...p });
  }
  if (knots.length < 5) return knots;
  // Robust weights from residuals to a running median of 5: an isolated outlier barely moves the
  // median, so it alone is down-weighted and cannot drag its neighbours' trend.
  const med = (i, axis) => knots.slice(Math.max(0, i - 2), i + 3).map(p => p[axis]).sort((a, b) => a - b);
  const res = knots.map((p, i) => { const mx = med(i, 'x'), my = med(i, 'y'); return Math.hypot(p.x - mx[mx.length >> 1], p.y - my[my.length >> 1]); });
  const scale = Math.max(6 * [...res].sort((a, b) => a - b)[res.length >> 1], 2 * tolerance);
  const weights = knots.map((p, i) => isManual(p) ? 20 : Math.max(0, 1 - (res[i] / scale) ** 2) ** 2);
  const fit = knots.map((p, i) => ({ x: localTrend(knots, i, weights, 'x', half), y: localTrend(knots, i, weights, 'y', half) }));
  for (let i = 1; i < knots.length - 1; i++) {
    if (isManual(knots[i])) continue;
    const dx = fit[i].x - knots[i].x, dy = fit[i].y - knots[i].y, d = Math.hypot(dx, dy);
    if (!Number.isFinite(d)) continue;
    const k = d > tolerance ? tolerance / d : 1;
    knots[i].x += dx * k; knots[i].y += dy * k;
  }
  return knots;
}

// Cubic Hermite through settled observations: calm enough to read as a flight, yet every interior
// observation lies within `tolerance` of the curve at its time and manual points lie on it exactly.
export function smoothFlight(points, fps = 120, { tolerance = SMOOTH_TOLERANCE } = {}) {
  if (points.length < 3) return points;
  const source = settleFlight(points, tolerance);
  if (source.length < 3) return source;
  const tangents = axis => {
    const slopes = source.slice(1).map((p, i) => (p[axis] - source[i][axis]) / (p.t - source[i].t));
    return source.map((p, i) => {
      if (!i) return slopes[0];
      if (i === source.length - 1) return slopes.at(-1);
      const a = slopes[i - 1], b = slopes[i];
      if (a * b <= 0) return 0;
      const before = p.t - source[i - 1].t, after = source[i + 1].t - p.t;
      const w1 = 2 * after + before, w2 = after + 2 * before;
      // Extra damping on mid tangents reduces residual zigzag between settled knots.
      return ((w1 + w2) / (w1 / a + w2 / b)) * .68;
    });
  };
  const tx = tangents('x'), ty = tangents('y'), curve = [source[0]];
  for (let i = 0; i < source.length - 1; i++) {
    const a = source[i], b = source[i + 1], dt = b.t - a.t, steps = Math.max(1, Math.ceil(dt * fps));
    for (let j = 1; j <= steps; j++) {
      const u = j / steps, u2 = u * u, u3 = u2 * u;
      const interpolate = (axis, tangent) => (2 * u3 - 3 * u2 + 1) * a[axis] + (u3 - 2 * u2 + u) * dt * tangent[i] + (-2 * u3 + 3 * u2) * b[axis] + (u3 - u2) * dt * tangent[i + 1];
      curve.push({ t: a.t + u * dt, x: interpolate('x', tx), y: interpolate('y', ty) });
    }
  }
  return curve;
}

function fitQuadratic(points, axis) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, sy = 0, sty = 0, st2y = 0;
  for (const p of points) {
    const t = p.t, y = p[axis], t2 = t * t;
    s0++; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
    sy += y; sty += t * y; st2y += t2 * y;
  }
  const det = s4 * (s2 * s0 - s1 * s1) - s3 * (s3 * s0 - s1 * s2) + s2 * (s3 * s1 - s2 * s2);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = (st2y * (s2 * s0 - s1 * s1) - s3 * (sty * s0 - s1 * sy) + s2 * (sty * s1 - s2 * sy)) / det;
  const b = (s4 * (sty * s0 - s1 * sy) - st2y * (s3 * s0 - s1 * s2) + s2 * (s3 * sy - sty * s2)) / det;
  const c = (s4 * (s2 * sy - sty * s1) - s3 * (s3 * sy - sty * s2) + st2y * (s3 * s1 - s2 * s2)) / det;
  if (![a, b, c].every(Number.isFinite)) return null;
  return { a, b, c, at: t => a * t * t + b * t + c, vel: t => 2 * a * t + b };
}

function turnCos(a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
  const lab = Math.hypot(abx, aby), lbc = Math.hypot(bcx, bcy);
  if (lab < 1e-6 || lbc < 1e-6) return 1;
  return (abx * bcx + aby * bcy) / (lab * lbc);
}

function denoiseFlight(points) {
  if (points.length < 5) return points;
  const kept = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = kept.at(-1), p = points[i], dt = Math.max(1e-3, p.t - prev.t);
    const speed = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
    // Reject teleport jumps (clothing blink / bad associations).
    if (speed > 1.15 && i < points.length - 1) {
      const next = points[i + 1], dt2 = Math.max(1e-3, next.t - prev.t);
      const bypass = Math.hypot(next.x - prev.x, next.y - prev.y) / dt2;
      if (bypass < speed * .65) continue;
    }
    kept.push(p);
  }
  if (kept.length < 5) return kept.length >= 4 ? kept : points;
  // Drop lightning-bolt kinks: if b is a sharp corner, prefer a→c when that stays rising-ish.
  const smooth = [kept[0]];
  for (let i = 1; i < kept.length - 1; i++) {
    const a = smooth.at(-1), b = kept[i], c = kept[i + 1];
    if (turnCos(a, b, c) < .2) {
      const skip = turnCos(a, c, kept[Math.min(i + 2, kept.length - 1)]);
      const keepB = turnCos(a, b, kept[Math.min(i + 2, kept.length - 1)]);
      if (skip > keepB) continue;
    }
    smooth.push(b);
  }
  smooth.push(kept.at(-1));
  return smooth.length >= 4 ? smooth : kept;
}

function trimStalledTail(points) {
  let end = points.length - 1;
  while (end > 3) {
    const a = points[end - 1], b = points[end];
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-3, b.t - a.t);
    if (speed > .045) break;
    end--;
  }
  return points.slice(0, end + 1);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function robustEndVelocity(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], dt = b.t - a.t;
    if (dt < 1e-3) continue;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    if (Math.hypot(vx, vy) > 1.15) continue;
    segs.push({ vx, vy });
  }
  const rising = segs.filter(s => s.vy < -.015);
  const use = (rising.length >= 2 ? rising : segs).slice(-5);
  if (!use.length) {
    const a = points[0], b = points.at(-1), dt = Math.max(1e-3, b.t - a.t);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }
  return { vx: median(use.map(s => s.vx)), vy: median(use.map(s => s.vy)) };
}

// Continue past the last clear sighting along a calm fitted arc.
// No sideways rocket from a tiny climb bias; no vertical dump back to the tee.
export function extendFlight(points, untilTime, { fps = 60, margin = -.02, maxMargin = 1.02 } = {}) {
  if (!points?.length || points.length < 4 || !Number.isFinite(untilTime)) return points;
  const cleaned = trimStalledTail(denoiseFlight(points));
  if (cleaned.length < 4) return points;
  const rise = cleaned[0].y - cleaned.at(-1).y;
  if (rise < .025) return cleaned;
  const span = Math.max(.2, cleaned.at(-1).t - cleaned[0].t);
  const sample = cleaned.length > 8 ? cleaned.slice(-Math.max(6, Math.ceil(cleaned.length * .8))) : cleaned;
  const fx = fitQuadratic(sample, 'x'), fy = fitQuadratic(sample, 'y');
  const anchor = cleaned.at(-1);
  if (untilTime <= anchor.t + .5 / fps) return cleaned;

  const climbVx = (anchor.x - cleaned[0].x) / span;
  const avgRise = -rise / span;
  const { vx: endVx, vy: endVy } = robustEndVelocity(sample);
  const late = sample.slice(-Math.min(4, sample.length));
  const lateRise = late[0].y - late.at(-1).y;
  const stillClimbing = endVy < -.05 || lateRise > Math.max(.025, rise * .18);
  const cresting = !stillClimbing && endVy > -.04 && lateRise < Math.max(.02, rise * .1);

  let vx = endVx, vy = endVy, ax = 0;
  let ay = Math.min(.45, Math.max(.12, rise / (span * span) * .5));
  if (fx && fy && fy.a > -.05 && fy.a < 1.6) {
    vx = .65 * fx.vel(anchor.t) + .35 * endVx;
    vy = .65 * fy.vel(anchor.t) + .35 * endVy;
    ax = Math.max(-.12, Math.min(.12, 2 * fx.a));
    if (fy.a > .05) ay = Math.min(.45, Math.max(.12, 2 * fy.a * .8));
  }

  // Mild bias toward the overall climb heading — never invent a minimum sideways speed.
  if (Math.abs(climbVx) > .03 && Math.sign(vx || climbVx) !== Math.sign(climbVx)) vx = climbVx * .5;
  vx = .7 * vx + .3 * climbVx;
  const maxSide = Math.max(.08, Math.min(.55, Math.abs(climbVx) * 1.4 + .06));
  if (Math.abs(vx) > maxSide) vx = Math.sign(vx) * maxSide;

  const maxUp = Math.min(.75, Math.max(.1, -avgRise * 1.7));
  if (vy < -maxUp) vy = -maxUp;
  if (cresting) vy = Math.max(.015, Math.min(.08, .025 - Math.min(0, endVy) * .25));
  else if (vy > -.02) vy = Math.min(-.045, avgRise * .7);
  if (!(ay > .08 && ay < 1)) ay = Math.min(.45, Math.max(.12, rise / (span * span) * .5));

  let x = anchor.x, y = anchor.y;
  const extended = cleaned.map(p => ({ ...p }));
  const dt = 1 / fps;
  const maxTime = Math.min(untilTime, anchor.t + Math.max(.7, Math.min(1.6, span * 2.2)));
  const pathLen = cleaned.reduce((n, p, i) => i ? n + Math.hypot(p.x - cleaned[i - 1].x, p.y - cleaned[i - 1].y) : 0, 0);
  let traveled = 0, climbTravel = 0, sawApex = false, peakY = y;
  const maxDescend = Math.max(.04, rise * .28);
  const maxClimb = Math.max(.28, Math.min(.7, pathLen * 1.35 + rise * .35));
  for (let t = anchor.t + dt; t <= maxTime + 1e-9; t += dt) {
    const nx = x + vx * dt + .5 * ax * dt * dt;
    const ny = y + vy * dt + .5 * ay * dt * dt;
    vx += ax * dt;
    vy += ay * dt;
    if (Math.abs(vx) > maxSide) vx = Math.sign(vx) * maxSide;
    if (nx < margin || nx > maxMargin || ny < margin || ny > maxMargin) break;
    const step = Math.hypot(nx - x, ny - y);
    traveled += step;
    if (!sawApex) climbTravel += step;
    if (!sawApex && climbTravel > maxClimb) break;
    if (sawApex && traveled > climbTravel + Math.max(.08, pathLen * .35)) break;
    peakY = Math.min(peakY, ny);
    if (vy >= 0) sawApex = true;
    if (sawApex && ny - peakY > maxDescend) break;
    if (sawApex && ny >= cleaned[0].y - rise * .45) break;
    x = nx; y = ny;
    extended.push({ t, x, y, extrapolated: true });
  }
  return extended;
}
