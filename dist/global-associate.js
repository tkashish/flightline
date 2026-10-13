/**
 * Phase 4 — global identity-safe trajectory association.
 * Offline beam search over per-frame candidate lists + explicit null hypothesis.
 * Length-normalized scoring so long clutter paths cannot win by accumulation.
 */

/** @typedef {{ t:number, x:number, y:number, score?:number, size?:number, quality?:number, launchId?:string, id?:string }} AssocCandidate */
/** @typedef {{ t:number, f?:number, candidates:AssocCandidate[] }} AssocFrame */
/** @typedef {{ id:string, t:number, x:number, y:number, sourceSize?:number, sourceQuality?:number, confidence?:number }} LaunchSeed */

const NULL_SCORE = 0;

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
  const accel = (dvx * dvx + dvy * dvy) / (velSigma * velSigma);
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
 * Path score normalized by observation count so long clutter cannot dominate.
 * score = launchPrior + mean(evidence) * log(1+nObs) - mean(motion) - gaps
 */
export function pathScore(parts) {
  const n = Math.max(1, parts.nObs);
  const lengthWeight = Math.log1p(n);
  return parts.launch
    + (parts.evidenceSum / n) * lengthWeight
    - (parts.motionSum / n) * 1.2
    - parts.gapSum
    - parts.identityPenalty;
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
  gatePx = 55
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

  /** @type {object[]} */
  let beams = [];
  const finished = [];

  const seedBeamsAt = (frame, frameIndex) => {
    for (const launch of launches) {
      if (Math.abs((launch.t ?? 0) - frame.t) > 0.2) continue;
      const near = (frame.candidates || []).filter(c =>
        Math.hypot(c.x - launch.x, c.y - launch.y) <= gatePx
      );
      const seeds = near.length ? near : [{
        t: frame.t, x: launch.x, y: launch.y,
        score: 12, size: launch.sourceSize ?? 8, quality: launch.sourceQuality ?? 0.85,
        id: `${launch.id}:seed`
      }];
      for (const cand of seeds.slice(0, 4)) {
        // Prefer launch-hinted px/s; fall back to a modest upward prior (not flight speed).
        const seedVx = Number.isFinite(launch.vx) ? launch.vx : 0;
        const seedVy = Number.isFinite(launch.vy) ? launch.vy : -120;
        beams.push({
          launchId: launch.id,
          x: cand.x,
          y: cand.y,
          t: frame.t,
          f: frame.f ?? frameIndex,
          vx: seedVx,
          vy: seedVy,
          missStreak: 0,
          missTime: 0,
          nObs: 1,
          evidenceSum: observationEvidence(cand),
          motionSum: 0,
          gapSum: 0,
          identityPenalty: 0,
          launch: launchPrior(launch, imageHeight),
          points: [{ t: frame.t, x: cand.x, y: cand.y, status: 'observed', candidateId: cand.id, launchId: launch.id }],
          lastFrameIndex: frameIndex
        });
      }
    }
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    seedBeamsAt(frame, i);
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
        finished.push(beam);
        continue;
      }

      for (const cand of frame.candidates || []) {
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
        let identityPenalty = beam.identityPenalty;
        if (beam.nObs >= 4 && (cand.size ?? 0) > 40 && (cand.size ?? 0) > (beam.points.at(-1)?.size ?? 8) * 2.5) {
          identityPenalty += 6;
        }
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
          evidenceSum: beam.evidenceSum + observationEvidence(cand),
          motionSum: beam.motionSum + innov,
          gapSum: beam.gapSum,
          identityPenalty,
          launch: beam.launch,
          points: [...beam.points, {
            t: frame.t, x: cand.x, y: cand.y, status: 'observed',
            candidateId: cand.id, launchId: beam.launchId, size: cand.size
          }],
          lastFrameIndex: i
        });
      }
    }

    // Prune by pathScore; keep diversity by launchId.
    next.sort((a, b) => pathScore(b) - pathScore(a));
    const kept = [];
    const perLaunch = new Map();
    for (const b of next) {
      const n = perLaunch.get(b.launchId) || 0;
      if (n >= Math.max(3, Math.floor(beamWidth / 3))) continue;
      perLaunch.set(b.launchId, n + 1);
      kept.push(b);
      if (kept.length >= beamWidth) break;
    }
    beams = kept;
  }

  finished.push(...beams);

  const scored = finished
    .filter(b => b.nObs >= minObs)
    .map(b => ({ ...b, score: pathScore(b) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  const runnerUp = scored[1] || null;
  const margin = best ? best.score - NULL_SCORE : 0;
  const vsRunner = best && runnerUp ? best.score - runnerUp.score : margin;

  if (!best || margin < nullMargin) {
    return {
      status: 'no_reliable_track',
      points: [],
      score: best?.score ?? NULL_SCORE,
      margin,
      reasonCodes: !best ? ['insufficient_visible_frames'] : ['no_ball_evidence'],
      beams: scored.slice(0, 5).map(summarizeBeam)
    };
  }

  // Trim trailing miss predictions — only observed points.
  const points = best.points.filter(p => p.status === 'observed');
  const climb = points.length >= 2 ? points[0].y - points.at(-1).y : 0;
  const span = points.length >= 2
    ? Math.hypot(points.at(-1).x - points[0].x, points.at(-1).y - points[0].y)
    : 0;
  // Reject launch stumps / jitter that never leave the tee (common cold-start failure).
  if (climb < 25 || span < 40) {
    return {
      status: 'no_reliable_track',
      points: [],
      score: best.score,
      margin,
      reasonCodes: ['no_ball_evidence'],
      beams: scored.slice(0, 5).map(summarizeBeam)
    };
  }

  const status = points.length >= minObs + 4 ? 'tracked' : 'partial';
  const reasonCodes = [];
  if (vsRunner < 1.5 && runnerUp && runnerUp.launchId !== best.launchId) {
    reasonCodes.push('ambiguous_launch');
  }

  if (!launches.length) reasonCodes.push('no_launch');
  return {
    status,
    points,
    score: best.score,
    margin,
    vsRunner,
    selectedLaunchId: best.launchId,
    reasonCodes,
    beams: scored.slice(0, 5).map(summarizeBeam)
  };
}

function summarizeBeam(b) {
  return {
    launchId: b.launchId,
    score: b.score,
    nObs: b.nObs,
    firstT: b.points[0]?.t,
    lastT: b.points.at(-1)?.t,
    launch: b.launch,
    identityPenalty: b.identityPenalty
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
  if (!pts || pts.length < 2) return { vx: 0, vy: -120 };
  const a = pts[0], b = pts[Math.min(3, pts.length - 1)];
  const dt = Math.max(1 / 240, (b.t ?? 0) - (a.t ?? 0));
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

export function launchesFromHypotheses(hypotheses, tracks) {
  const out = [];
  const trackById = new Map((tracks || []).filter(t => t?.launchId).map(t => [t.launchId, t]));
  for (const h of hypotheses || []) {
    const track = trackById.get(h.id);
    const vel = track ? launchVelocityFromTrack(track) : { vx: 0, vy: -120 };
    out.push({
      id: h.id,
      t: h.impactT ?? h.t,
      x: h.anchorX ?? h.x,
      y: h.anchorY ?? h.y,
      sourceSize: h.sourceSize,
      sourceQuality: h.sourceQuality,
      confidence: h.confidence,
      vx: vel.vx,
      vy: vel.vy
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
      vy: vel.vy
    });
  }
  return out;
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
  const points = (assoc.points || []).map(p => ({
    t: p.t,
    x: p.x / width,
    y: p.y / height,
    status: p.status || 'observed'
  }));
  // Export/preview contract uses observed points only — never predicted fills.
  const observed = points.filter(p => p.status === 'observed' || p.status == null);
  return {
    points: observed.map(({ t, x, y }) => ({ t, x, y })),
    camera,
    engine,
    observedFrames: observed.length,
    status: assoc.status,
    confidence: assoc.margin,
    vsRunner: assoc.vsRunner,
    reasonCodes: assoc.reasonCodes || [],
    selectedLaunchId: assoc.selectedLaunchId || null,
    diagnostics: {
      beams: assoc.beams,
      score: assoc.score,
      margin: assoc.margin,
      vsRunner: assoc.vsRunner
    }
  };
}
