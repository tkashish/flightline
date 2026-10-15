// Experimental, model-free candidate detection. All positions are observed, never extrapolated.
import {
  associateFlight,
  framesFromTracks,
  launchesFromHypotheses,
  mergeAssocFrames,
  toRendererResult
} from './global-associate.js?v=53';

export class MotionTracker {
  constructor(width, height, { engine = 'legacy' } = {}) {
    this.w = width; this.h = height; this.previous = null;
    this.tracks = []; this.best = null; this.frame = 0;
    this.offset = { x: 0, y: 0 }; this.camera = []; this.spots = []; this.seedBlockedUntil = -1;
    // Phase 2: retain competing launch identities until final selection.
    this.launchHypotheses = [];
    this.nextLaunchId = 1;
    // Phase 4: per-frame soft candidates for offline global association.
    this.engine = engine === 'v2' || engine === 'global-v2' ? 'v2' : 'legacy';
    this.frameLog = [];
  }
  cameraShift(current) {
    if (!this.previous) return { x: 0, y: 0 };
    const w = this.w, h = this.h;
    let best = Infinity, stationary = Infinity, shift = { x: 0, y: 0 };
    // Robust global translation estimate discounts local motion and exposure changes.
    for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
      let error = 0, count = 0;
      for (let y = 16; y < h - 16; y += 24) for (let x = 16; x < w - 16; x += 24) {
        error += Math.min(35, Math.abs(current[y * w + x] - this.previous[(y - dy) * w + x - dx])); count++;
      }
      const score = error / Math.max(count, 1) + Math.hypot(dx, dy) * .08;
      if (dx === 0 && dy === 0) stationary = score;
      if (score < best) { best = score; shift = { x: dx, y: dy }; }
    }
    return stationary - best > 1.4 ? shift : { x: 0, y: 0 };
  }
  lastStepVelocity(track) {
    const pts = track.points;
    if (pts.length < 2) return { vx: 0, vy: -2, climb: 2, speed: 2 };
    const b = pts.at(-2), c = pts.at(-1), dt = Math.max(1, c.f - b.f);
    const vx = (c.x - b.x) / dt, vy = (c.y - b.y) / dt;
    return { vx, vy, climb: -vy, speed: Math.hypot(vx, vy) };
  }
  recentVelocity(track) {
    const pts = track.points;
    if (pts.length < 2) return { vx: 0, vy: -2, climb: 2, speed: 2 };
    const segs = [];
    for (let i = Math.max(1, pts.length - 5); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dt = Math.max(1, b.f - a.f);
      segs.push({ vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt });
    }
    const median = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const vx = median(segs.map(s => s.vx)), vy = median(segs.map(s => s.vy));
    return { vx, vy, climb: -vy, speed: Math.hypot(vx, vy) };
  }
  isBallisticHook(vx, vy, pvx, pvy, { strict = false } = {}) {
    const speed = Math.hypot(vx, vy), prevSpeed = Math.hypot(pvx, pvy);
    if (prevSpeed < .7 || speed < .35) return false;
    const prevClimb = -pvy, climb = -vy;
    if (prevSpeed < 12 && climb > prevClimb + .85 && climb > Math.max(1.0, prevClimb * 1.25 + .4)) return true;
    const heading = Math.atan2(-vy, vx), prevHeading = Math.atan2(-pvy, pvx);
    const turn = Math.abs(Math.atan2(Math.sin(heading - prevHeading), Math.cos(heading - prevHeading)));
    // Gravity bends the path down without reversing or speeding up the run; that is not a hook.
    const gravityBend = climb <= prevClimb + .25 && (Math.abs(pvx) < .3 || vx * pvx > 0) && Math.abs(vx) <= Math.abs(pvx) * 1.35 + .6;
    if (turn > .65 && (strict || !gravityBend)) return true;
    // Snap toward vertical, measured from the horizontal run so left and right flights match.
    // Strict mode (weak sky peaks) also refuses a snap flat while the ball is still climbing.
    const prevAng = Math.atan2(-pvy, Math.abs(pvx)), ang = Math.atan2(-vy, Math.abs(vx));
    const snap = Math.abs(ang) - Math.abs(prevAng);
    return prevSpeed < 8 && climb > .8 && (snap > .45 || (strict && snap < -.45));
  }
  detect(rgba, t) {
    const w = this.w, h = this.h, n = w * h;
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    const shift = this.cameraShift(gray);
    this.offset.x += shift.x; this.offset.y += shift.y;
    this.camera.push({ t, x: this.offset.x / w, y: this.offset.y / h });
    const mask = new Uint8Array(n), candidates = [];
    {
      // Slightly softer in the upper frame so a shrinking ball against sky still
      // lights up — but not so soft that mat glare floods the linker.
      for (let y = 9; y < h - 9; y++) for (let x = 9; x < w - 9; x++) {
        const i = y * w + x, v = gray[i];
        const sky = y < h * .55;
        if (v < (sky ? 142 : 150)) continue;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > (sky ? 100 : 90)) continue;
        const surround = (gray[i - 6] + gray[i + 6] + gray[i - w * 6] + gray[i + w * 6]) / 4;
        if (v - surround > (sky ? 12 : 16)) mask[i] = 1;
      }
      // Connected components reject large objects such as clothing, clubs, and clouds.
      const stack = [];
      for (let y = 9; y < h - 9; y++) for (let x = 9; x < w - 9; x++) {
        const start = y * w + x;
        if (!mask[start]) continue;
        stack.push(start); mask[start] = 0;
        let sx = 0, sy = 0, count = 0, bright = 0, motion = 0, minx = x, maxx = x, miny = y, maxy = y;
        while (stack.length) {
          const i = stack.pop(), px = i % w, py = Math.floor(i / w);
          sx += px; sy += py; count++; bright += gray[i];
          if (this.previous && gray[i] - this.previous[(py - shift.y) * w + px - shift.x] > (py < h * .55 ? 12 : 16)) motion++;
          minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
          for (const step of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
            const j = i + step;
            if (j >= 0 && j < n && mask[j]) { mask[j] = 0; stack.push(j); }
          }
        }
        if (count > 0 && count < 600 && maxx - minx < 36 && maxy - miny < 36) {
          const moving = motion / count > (miny < h * .55 ? .16 : .22);
          candidates.push({ x: sx / count - this.offset.x, y: sy / count - this.offset.y, t, f: this.frame, quality: bright / count / 255, size: count, moving, roundness: (maxx - minx + 1) / (maxy - miny + 1), compactness: count / ((maxx - minx + 1) * (maxy - miny + 1)) });
        }
      }
    }
    // Mid-flight: globally-thresholded sky often misses a blue-cast ball. Search
    // a small window around each established track's predicted position.
    // Never let a malformed coaster candidate reach linking or the v2 frame log.
    const localBalls = this.localFlightCandidates(gray, rgba, t, shift).filter(finiteCandidate);
    for (const p of localBalls) {
      if (!candidates.some(c => Math.hypot(c.x - p.x, c.y - p.y) < 2.5)) candidates.push(p);
    }
    this.previous = gray;
    candidates.sort((a, b) => b.quality - a.quality);
    this.lastCandidates = candidates;
    if (this.engine === 'v2') {
      this.frameLog.push({
        t,
        f: this.frame,
        candidates: candidates.slice(0, 28).map(c => ({
          t: c.t, x: c.x, y: c.y, size: c.size, quality: c.quality,
          score: (c.quality ?? 0.7) * 18 + Math.min(8, Math.sqrt(c.size ?? 1)),
          id: `c:${this.frame}:${c.x | 0}:${c.y | 0}`,
          moving: c.moving
        }))
      });
    }
    // Impact frames can produce >1000 movers. The real ball is often outside the
    // brightest 120, so keep bright seeds plus every trackable mid-size mover.
    const moving = candidates.filter(p => p.moving);
    const linkSet = moving.length <= 220
      ? moving
      : [...moving.slice(0, 140), ...moving.filter(p => p.size >= 3 && p.quality >= .78 && p.y < this.h * .92)].filter((p, i, arr) => arr.indexOf(p) === i).slice(0, 360);
    for (const p of localBalls) {
      if (!linkSet.includes(p)) linkSet.push(p);
    }
    this.link(linkSet, candidates);
    this.updateSpots(candidates); this.frame++;
    return candidates.length;
  }
  coastTracks() {
    // Keep local search on up to 3 launch identities — not only this.best —
    // so an early clothing highlight cannot starve the real ball of ROI evidence.
    const pool = [];
    const seen = new Set();
    const consider = track => {
      if (!track || track.points.length < 6) return;
      const key = track.launchId || `${track.points[0].f}:${track.points[0].x|0}:${track.points[0].y|0}`;
      if (seen.has(key)) return;
      seen.add(key);
      pool.push(track);
    };
    consider(this.best);
    for (const track of this.tracks) consider(track);
    pool.sort((a, b) => this.identityScore(b) - this.identityScore(a));
    return pool.slice(0, 3);
  }
  localFlightCandidates(gray, rgba, t, shift) {
    const out = [];
    const used = new Set();
    for (const track of this.coastTracks()) {
      for (const cand of this.localFlightCandidatesForTrack(track, gray, rgba, t)) {
        const key = `${cand.x.toFixed(1)}:${cand.y.toFixed(1)}`;
        if (used.has(key)) continue;
        used.add(key);
        out.push(cand);
      }
    }
    return out;
  }
  localFlightCandidatesForTrack(track, gray, rgba, t) {
    if (!track || track.points.length < 6) return [];
    const w = this.w, h = this.h;
    const last = track.points.at(-1), prev = track.points.at(-2);
    const gap = Math.max(1, this.frame - last.f);
    if (gap > 12) return [];
    const smooth = this.recentVelocity(track);
    const dt = Math.max(1, last.f - (prev?.f ?? last.f - 1));
    const stepVx = prev ? (last.x - prev.x) / dt : smooth.vx;
    const stepVy = prev ? (last.y - prev.y) / dt : smooth.vy;
    // Step velocity for the search window; median velocity for validation.
    const pvx = stepVx * .45 + smooth.vx * .55;
    const pvy = stepVy * .45 + smooth.vy * .55;
    const px = Math.round(last.x + this.offset.x + pvx * gap);
    const py = Math.round(last.y + this.offset.y + pvy * gap);
    if (py < 9 || py > h * .82 || px < 9 || px > w - 10) return [];
    const highSky = last.y < h * .55;
    const minV = highSky ? 112 : 145;
    const minContrast = highSky ? 2.2 : 10;
    // Integer radius: a half-pixel window reads gray[] between pixels and yields NaN candidates.
    const rad = Math.round(Math.min(highSky ? 42 : 24, 10 + gap * (highSky ? 5 : 3.5)));
    const lastScreenY = last.y + this.offset.y;
    let peak = null, nearPeak = null;
    for (let y = Math.max(9, py - rad); y <= Math.min(h - 10, py + rad); y++) {
      for (let x = Math.max(9, px - rad); x <= Math.min(w - 10, px + rad); x++) {
        const i = y * w + x, v = gray[i];
        if (v < minV) continue;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        // Blue-sky cast pushes chroma well past the global sky gate.
        if (Math.max(r, g, b) - Math.min(r, g, b) > (highSky ? 155 : 145)) continue;
        const surround = (gray[i - 6] + gray[i + 6] + gray[i - w * 6] + gray[i + w * 6]) / 4;
        const contrast = v - surround;
        if (contrast < minContrast) continue;
        // Faint sky balls can sit on a soft gradient; only require a crisp peak lower down.
        if (!highSky && (gray[i - 1] > v || gray[i + 1] > v || gray[i - w] > v || gray[i + w] > v)) continue;
        // Netting / horizon often outshines the ball below the predicted arc.
        if (pvy <= .45 && y > lastScreenY + 28) continue;
        const dist = Math.hypot(x - px, y - py);
        const score = contrast * 1.35 + (v - 120) * .12 - dist * 1.85;
        const hit = { x, y, v, contrast, score, dist };
        if (dist <= 14 && (!nearPeak || score > nearPeak.score)) nearPeak = hit;
        if (!peak || score > peak.score) peak = hit;
      }
    }
    peak = nearPeak || peak;
    if (!peak || peak.contrast < minContrast) return [];
    let sx = 0, sy = 0, count = 0, bright = 0, minx = peak.x, maxx = peak.x, miny = peak.y, maxy = peak.y;
    const growFloor = highSky ? 2 : 7;
    for (let y = peak.y - 1; y <= peak.y + 1; y++) for (let x = peak.x - 1; x <= peak.x + 1; x++) {
      const i = y * w + x, v = gray[i];
      if (v < peak.v - (highSky ? 40 : 28)) continue;
      const surround = (gray[i - 6] + gray[i + 6] + gray[i - w * 6] + gray[i + w * 6]) / 4;
      if (v - surround < growFloor && !(x === peak.x && y === peak.y)) continue;
      sx += x; sy += y; count++; bright += v;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    }
    if (count < 1) { sx = peak.x; sy = peak.y; count = 1; bright = peak.v; }
    const cand = {
      x: sx / count - this.offset.x, y: sy / count - this.offset.y, t, f: this.frame,
      quality: bright / count / 255, size: Math.min(4, count), moving: true,
      roundness: (maxx - minx + 1) / (maxy - miny + 1),
      compactness: count / ((maxx - minx + 1) * (maxy - miny + 1)),
      local: true,
      launchId: track.launchId
    };
    // Coasting can pick up a little lateral drift; only reject sharp reversals
    // and anti-gravity climb jumps (the classic late vertical hook).
    const vx = (cand.x - last.x) / gap, vy = (cand.y - last.y) / gap;
    const speed = Math.hypot(vx, vy);
    const minCoast = highSky ? 0.22 : 0.35;
    if (speed < minCoast || speed > Math.max(8, smooth.speed * 2.4 + 2.5)) return [];
    const smoothSpeed = smooth.speed;
    if (smoothSpeed > 1.6 && speed > 1.2 && (vx * smooth.vx + vy * smooth.vy) / (speed * smoothSpeed) < .4) return [];
    if (vy > (track.points.length >= 12 ? 1.45 : 0.85)) return [];
    const predX = last.x + pvx * gap;
    const predY = last.y + pvy * gap + (pvy > -.15 ? .125 : 0) * gap * gap;
    const predDist = Math.hypot(cand.x - predX, cand.y - predY);
    const maxPred = Math.max(highSky ? 14 : 10, smoothSpeed * gap * .75 + 8 + gap * 1.25);
    if (predDist > maxPred) return [];
    const allowRise = smooth.vy <= -.08 && predDist <= 14
      && cand.y < predY - 1 && cand.y >= predY - Math.max(18, gap * 2.8 + 5);
    if (cand.y < predY - Math.max(5, gap * 1.3 + 1) && !allowRise) return [];
    // The coaster reads weak sky peaks near its own prediction, so it applies the strict hook rules.
    if (this.isBallisticHook(vx, vy, smooth.vx, smooth.vy, { strict: true })) return [];
    return [cand];
  }
  identityScore(track) {
    if (!track?.points?.length) return -Infinity;
    const points = track.points;
    const source = points[0];
    const last = points.at(-1);
    const rise = (source.y - last.y) / this.h;
    const n = points.length;
    // Length-normalized score: long clothing creeps must not beat a solid address launch.
    const meanCost = (track.cost || 0) / Math.max(1, n);
    const sizeBonus = Math.min(40, Math.sqrt(track.sourceSize ?? source.size ?? 0) * 2.8);
    const compact = track.sourceCompactness ?? source.compactness ?? 1;
    const shapeBonus = Math.min(compact, 1) * 10;
    const anchor = track.anchor || 0;
    return sizeBonus + shapeBonus + anchor * 1.1 + Math.min(.75, Math.max(0, rise)) * 36
      + Math.min(6, Math.sqrt(n)) * 2.2 - meanCost * 2.4;
  }
  rememberHypothesis(track) {
    if (!track || (track.sourceSize ?? track.points[0]?.size ?? 0) < 6) return;
    if (!track.launchId) track.launchId = `L${this.nextLaunchId++}`;
    const snap = {
      id: track.launchId,
      impactT: track.points[0]?.t ?? null,
      anchorX: track.points[0]?.x ?? null,
      anchorY: track.points[0]?.y ?? null,
      sourceSize: track.sourceSize ?? track.points[0]?.size ?? null,
      sourceQuality: track.sourceQuality ?? track.points[0]?.quality ?? null,
      confidence: this.identityScore(track),
      pointCount: track.points.length,
      score: track.score
    };
    const idx = this.launchHypotheses.findIndex(h => h.id === snap.id);
    if (idx >= 0) this.launchHypotheses[idx] = snap;
    else this.launchHypotheses.push(snap);
    this.launchHypotheses.sort((a, b) => b.confidence - a.confidence);
    this.launchHypotheses = this.launchHypotheses.slice(0, 12);
  }
  selectBestTrack() {
    const pool = [];
    const seen = new Set();
    const add = track => {
      if (!track?.points || track.points.length < 5) return;
      const key = track.launchId || `${track.points[0].f}:${track.points[0].x|0}:${track.points[0].y|0}:${track.points.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      pool.push(track);
    };
    add(this.best);
    for (const track of this.tracks) add(track);
    if (!pool.length) return null;
    pool.sort((a, b) => this.identityScore(b) - this.identityScore(a));
    const incumbent = this.best?.points?.length >= 5 ? this.best : null;
    // Ranked first is not enough to take over: another launch must pass the promotion gates.
    for (const track of pool) {
      if (track === incumbent || this.canSwitchTo(track, incumbent)) return track;
    }
    return incumbent;
  }
  // Promotion gates for a track of another launch: an address-sized source, a clean rising flight,
  // and, against an established flight, comparable evidence (no 5-point stub replaces a long track).
  canSwitchTo(track, incumbent) {
    const points = track.points, source = points[0], last = points.at(-1), n = points.length;
    if (n < 5) return false;
    const size = track.sourceSize ?? source.size ?? 0, quality = track.sourceQuality ?? source.quality ?? 0;
    if (size < 16 || quality < .74 || (track.sourceCompactness ?? source.compactness ?? 1) < .55) return false;
    if ((source.y - last.y) / this.h <= .065) return false;
    const efficiency = Math.hypot(last.x - source.x, last.y - source.y) / Math.max(1, track.length || 0);
    const meanCost = (track.cost || 0) / n;
    if (!(efficiency > .85 && meanCost < .85) && !(n >= 8 && efficiency > .68 && meanCost < 1.05)) return false;
    if (!incumbent) return true;
    if (incumbent.points.length >= 10 && n < Math.min(incumbent.points.length, 12)) return false;
    return this.identityScore(track) > this.identityScore(incumbent);
  }
  updateSpots(candidates) {
    const used = new Set();
    // Filter before limiting work: single-pixel highlights must not evict a
    // persistent ball from the stationary-object history.
    const eligible = candidates.filter(p => p.size >= 2 && p.size <= 400 && p.roundness >= .4 && p.roundness <= 2.5);
    for (const p of eligible) {
      const existing = this.spots.find(s => !used.has(s) && Math.abs(s.quality - p.quality) < .12 && p.size >= s.size * .35 && Math.hypot(s.originX - p.x, s.originY - p.y) < 2.5);
      if (existing) { existing.seen++; Object.assign(existing, p); used.add(existing); }
      else if (!p.moving) { const spot = { ...p, seen: 1, originX: p.x, originY: p.y }; this.spots.push(spot); used.add(spot); }
    }
    this.spots = this.spots.filter(s => this.frame - s.f <= 5).sort((a, b) => b.seen - a.seen).slice(0, 350);
  }
  link(candidates, allCandidates) {
    const d = Math.hypot(this.w, this.h), next = [];
    const movingCount = allCandidates.filter(p => p.moving).length;
    if (movingCount > 80 && movingCount > allCandidates.length * .2) this.seedBlockedUntil = this.frame + 3;
    for (const track of this.tracks) {
      const last = track.points.at(-1), gap = this.frame - last.f;
      // Established mid-flight tracks can miss a few dim sky observations.
      if (gap > (track.points.length >= 12 ? 12 : track.points.length >= 6 ? 8 : 5)) continue;
      next.push(track);
      // Browser impact frames often skip one observation; allow a single-frame
      // hole while the track is still establishing itself.
      if (track.points.length < 4 && gap > 2) continue;
      const previous = track.points.at(-2);
      for (const p of candidates) {
        const source = track.points[0];
        if (p.size > source.size * 2.8 + 4) continue;
        // Establish the launch using a consistent bright object. A chain of
        // unrelated highlights on a moving golfer can otherwise score highly.
        if (track.points.length < 6 && p.quality < Math.max(.75, source.quality - .15)) continue;
        // Only the first links must resemble the address ball; distant flight
        // shrinks to a few pixels and must not be rejected against source size.
        if (track.points.length < 3 && p.size < source.size * .2) continue;
        if (track.points.length < 3 && source.size >= 40 && p.size < 5) continue;
        if (track.points.length >= 3 && p.size > last.size * 2 + 4) continue;
        // Club heads are large soft/elongated blobs. Motion-blurred balls can
        // look slightly oblong when they are only a few pixels across.
        if (track.points.length >= 3 && p.size >= 5 && ((p.compactness ?? 1) < .45 || p.roundness < .55 || p.roundness > 1.85)) continue;
        if (track.points.length >= 3 && p.size < 5 && (p.compactness ?? 1) < .35) continue;
        // Ball shrinks downrange. Growing mid-flight is almost always the club.
        if (track.points.length >= 4 && p.size > last.size * 1.35 + 2 && p.size > source.size * .35) continue;
        const vx = (p.x - last.x) / gap, vy = (p.y - last.y) / gap;
        const speed = Math.hypot(vx, vy);
        if (track.points.length >= 10 && gap <= 2) {
          const ls = this.lastStepVelocity(track);
          const stepUp = last.y - p.y;
          if (stepUp > 8 && ls.climb < 1.2) continue;
          if (stepUp > 4 && ls.speed < 3.5) continue;
          if (stepUp > 2.5 && ls.climb < 1.5 && -vy > ls.climb + 2) continue;
        }
        if (p.size <= 2 && last.y - p.y > 6 + gap * 3 && track.points.length >= 10) continue;
        if (speed < .3 || speed > d * .16) continue;
        // Seeds always start with two points, so rising motion must be enforced
        // here rather than in a never-reached single-point branch.
        if (track.points.length < 5) {
          const riseRate = (source.y - p.y) / Math.max(1, this.frame - source.f);
          if (riseRate < .8 || vy > -.8) continue;
          // Reject sideways hops onto legs/clothing / mat glare.
          const stepDist = Math.hypot(p.x - last.x, p.y - last.y);
          const stepRise = last.y - p.y;
          if (stepRise / Math.max(1, stepDist) < .55) continue;
          if (Math.abs(vx) > Math.abs(vy) * 1.15) continue;
        } else {
          // Screen-space speed falls downrange. Compare only to the last step so
          // the explosive launch frames don't make later ball links look "too slow".
          const recentSpeed = previous
            ? Math.hypot(last.x - previous.x, last.y - previous.y) / Math.max(1, last.f - previous.f)
            : speed;
          // Late flight is often ~1px/frame and can coast near-level near apex.
          const long = track.points.length >= 10;
          const minSpeed = p.size <= 2
            ? Math.max(long ? 0.4 : 0.75, recentSpeed * .35)
            : Math.max(long ? 0.35 : 0.6, recentSpeed * .28);
          if (speed < minSpeed) continue;
          // Reject dropping back toward the tee, but allow upper-sky apex fall.
          const upperSky = last.y < this.h * .52;
          if (vy > (long ? (upperSky ? 1.35 : 0.55) : -.15) && (source.y - p.y) / this.h > .04) continue;
        }
        let cost = 0;
        if (previous) {
          const dt = Math.max(1, last.f - previous.f);
          const pvx = (last.x - previous.x) / dt, pvy = (last.y - previous.y) / dt;
          // Reject creep→explosion on clothing highlights, but allow the real
          // post-impact acceleration in the first few linked observations.
          const growth = track.points.length <= 3 ? Math.hypot(pvx, pvy) * 4.5 + 8 : Math.hypot(pvx, pvy) * 2.5 + 3 + Math.max(0, gap - 1) * 6;
          if (speed > growth) continue;
          const change = Math.hypot(vx - pvx, vy - pvy);
          const tolerance = track.points.length === 2 ? d * .09 : 5 + Math.hypot(pvx, pvy) * .52;
          if (change > tolerance) continue;
          if (speed > 3 && Math.hypot(pvx, pvy) > 3 && (vx * pvx + vy * pvy) / (speed * Math.hypot(pvx, pvy)) < .4) continue;
          // Mid-flight coasting must stay aligned; a left/right sky speck can
          // otherwise steal a long best track via extendsBest.
          const align = (vx * pvx + vy * pvy) / (speed * Math.hypot(pvx, pvy) || 1);
          if (track.points.length >= 6 && Math.hypot(pvx, pvy) > 1.4 && speed > 1.6 && align < .55) continue;
          // Sky speck "teleport up" while the coast is shallow.
          if (track.points.length >= 10 && last.y - p.y > 10 && -vy > Math.max(2, -pvy + 1.2)) continue;
          // Ballistic coast: gravity reduces climb. A late "rocket up" or a
          // diagonal→vertical hook is a sky speck, not the ball.
          if (track.points.length >= 8) {
            const smooth = this.recentVelocity(track);
            const spvx = smooth.vx, spvy = smooth.vy;
            const prevSpeed = smooth.speed;
            const predX = last.x + spvx * gap;
            const predY = last.y + spvy * gap + (spvy > -.15 ? .125 : 0) * gap * gap;
            const predDist = Math.hypot(p.x - predX, p.y - predY);
            const maxPred = Math.max(9, prevSpeed * gap * .65 + 6 + gap * 1.1);
            const nearPred = predDist <= Math.max(5.5, gap * 1.15);
            const allowRise = spvy <= -.25 && nearPred
              && p.y < predY - 2 && p.y >= predY - Math.max(10, gap * 1.6 + 3);
            if (predDist > maxPred) continue;
            if (p.y < predY - Math.max(3.5, gap * 1.05 + 1) && !allowRise) continue;
            const hook = this.isBallisticHook(vx, vy, spvx, spvy);
            if (hook && !(p.local && nearPred)) continue;
            if (!nearPred && spvy <= .35 && predDist > 14 && p.y > last.y + 30) continue;
          }
          cost = change / tolerance + (gap - 1) * .55;
        } else if (vy > -1.5 || speed > d * .12) continue;
        const points = [...track.points, p];
        const rise = (points[0].y - p.y) / this.h;
        const distance = Math.hypot(p.x - points[0].x, p.y - points[0].y);
        const length = (track.length || 0) + Math.hypot(p.x - last.x, p.y - last.y);
        const efficiency = distance / Math.max(1, length);
        if (points.length > 5 && efficiency < .75) continue;
        // Club follow-through swings around the body (big lateral arc, weak
        // radial escape from the address point). Ball flight leaves more radially.
        if (points.length >= 6) {
          const lateral = Math.abs(p.x - source.x);
          if (lateral > rise * this.h * .85 + 18 && efficiency < .92) continue;
        }
        const totalCost = track.cost + cost;
        // Prefer rise and anchor over a long creeping tail of noise.
        const score = Math.min(8, Math.sqrt(points.length)) * 4 + Math.min(.75, rise) * 42 + track.anchor * 1.35 - totalCost * 1.5;
        const linked = {
          points, cost: totalCost, score, length, anchor: track.anchor,
          launchId: track.launchId,
          sourceSize: track.sourceSize ?? source.size,
          sourceQuality: track.sourceQuality ?? source.quality,
          sourceCompactness: track.sourceCompactness ?? source.compactness
        };
        next.push(linked);
        this.rememberHypothesis(linked);
        const extendsBest = this.best && points.length > this.best.points.length && points.includes(this.best.points.at(-1));
        // Tiny clothing/glare seeds can rocket upward; only promote tracks that
        // started from an address-sized stationary ball.
        const addressLike = source.size >= 16 && source.quality >= .74 && (source.compactness ?? 1) >= .55;
        const betterAnchor = this.best && track.anchor > this.best.anchor + 6 && score >= this.best.score * .92;
        // A shorter sky-speck branch can score higher on rise; never demote a
        // longer established flight unless the anchor is clearly better.
        const demotesLonger = this.best && this.best.points.length >= 10
          && points.length < this.best.points.length && !betterAnchor;
        const extendOk = extendsBest && points.length >= 8 && efficiency > .68 && totalCost / points.length < 1.05;
        if (!demotesLonger && addressLike && points.length >= 5 && rise > .065
          && (extendOk || (efficiency > .85 && totalCost / points.length < .85))
          && (!this.best || this.identityScore(linked) > this.identityScore(this.best) || extendOk || betterAnchor)) {
          this.best = linked;
        }
      }
    }
    // Anchor a launch to a bright object that was stationary and has just left its position.
    // Size-aware anchors prevent long tracks on gloves and club heads from winning by lasting longer.
    for (const spot of this.spots) {
      // Impact floods the frame with motion. Keep blocking weak opportunistic
      // seeds, but still allow a well-established mid-frame address ball to launch.
      const strongAddress = spot.seen >= 12 && spot.size >= 16 && spot.quality >= .8
        && (spot.compactness ?? 1) >= .55
        && spot.y >= this.h * .35 && spot.y <= this.h * .82;
      if (this.frame <= this.seedBlockedUntil && !strongAddress) continue;
      // Browser color pipelines can read a white ball slightly dimmer than offline FFmpeg.
      if (spot.moving || spot.seen < 8 || spot.size < 6 || spot.quality < .74 || (spot.compactness ?? 1) < .55 || spot.roundness < .6 || spot.roundness > 1.7 || this.frame - spot.f > 3 || spot.y < this.h * .3) continue;
      if (allCandidates.some(p => !p.moving && p.quality > spot.quality - .1 && p.size > spot.size * .5 && Math.hypot(p.x - spot.x, p.y - spot.y) < 3)) continue;
      for (const p of candidates) {
        const distance = Math.hypot(p.x - spot.x, p.y - spot.y);
        const rise = spot.y - p.y;
        if (distance < 5 || distance > d * .11 || rise < 4 || p.y > spot.y - 3 || p.size > spot.size * 3 + 4 || p.size < spot.size * .25 || p.quality < Math.max(.75, spot.quality - .12)) continue;
        // First moving observation must still look like a ball, not the clubface.
        if ((p.compactness ?? 1) < .5 || p.roundness < .55 || p.roundness > 1.85) continue;
        // Launch must leave mostly upward. A bright leg/glove blob to the side
        // can otherwise steal the address seed on harsh sunlight clips.
        if (rise / distance < .55) continue;
        const sizeBoost = Math.min(35, Math.sqrt(spot.size) * 2.2);
        const shapeBoost = Math.min(spot.compactness ?? 1, 1) * 8 + Math.min(spot.roundness, 1 / spot.roundness) * 4;
        const anchor = spot.quality * 30 + Math.min(20, spot.seen) * .5 - distance / d * 100 + sizeBoost + shapeBoost;
        // Stamp the source frame beside the first moving observation so the
        // initial launch velocity is not diluted by a stale stationary timestamp.
        const seeded = {
          points: [{ ...spot, f: p.f - 1, t: Math.max(0, p.t - 1 / 30) }, p],
          cost: 0,
          score: anchor + 7,
          anchor,
          length: distance,
          launchId: `L${this.nextLaunchId++}`,
          sourceSize: spot.size,
          sourceQuality: spot.quality,
          sourceCompactness: spot.compactness ?? 1
        };
        next.push(seeded);
        this.rememberHypothesis(seeded);
      }
    }
    next.sort((a, b) => this.identityScore(b) - this.identityScore(a));
    // Limit duplicate histories ending on the same observations.
    const counts = new Map();
    this.tracks = next.filter(track => {
      const p = track.points.at(-1), key = `${p.f}:${p.x}:${p.y}`, count = counts.get(key) || 0;
      counts.set(key, count + 1); return count < 3;
    }).slice(0, 160);
    // Refresh provisional best from identity-aware ranking (not only raw score).
    const ranked = this.selectBestTrack();
    if (ranked) this.best = ranked;
  }
  result() {
    if (this.engine === 'v2') return this.resultGlobal();
    return this.resultLegacy();
  }
  resultLegacy() {
    this.best = this.selectBestTrack() || this.best;
    const raw = this.best?.points || [];
    // Drop a near-static glare tail; keep faint samples that are still climbing
    // even when screen-space speed has fallen below ~1px/frame.
    let end = raw.length;
    while (end > 4) {
      const a = raw[end - 2], b = raw[end - 1];
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.f - a.f);
      const climb = (a.y - b.y) / Math.max(1, b.f - a.f);
      if (speed > 0.85 || climb > 0.45) break;
      end--;
    }
    // Chop a late anti-gravity hook: climb suddenly steepens, heading snaps
    // toward vertical, or the tip climbs much harder than the mid-flight coast.
    const midClimb = (() => {
      if (end < 8) return null;
      const climbs = [];
      const lo = Math.floor(end * .35), hi = Math.floor(end * .75);
      for (let i = Math.max(1, lo); i < hi; i++) {
        const a = raw[i - 1], b = raw[i], dt = Math.max(1, b.f - a.f);
        climbs.push((a.y - b.y) / dt);
      }
      if (!climbs.length) return null;
      climbs.sort((a, b) => a - b);
      return climbs[Math.floor(climbs.length / 2)];
    })();
    while (end > 6) {
      const a = raw[end - 3], b = raw[end - 2], c = raw[end - 1];
      const dt1 = Math.max(1, b.f - a.f), dt2 = Math.max(1, c.f - b.f);
      const vx1 = (b.x - a.x) / dt1, vy1 = (b.y - a.y) / dt1;
      const vx2 = (c.x - b.x) / dt2, vy2 = (c.y - b.y) / dt2;
      const speed1 = Math.hypot(vx1, vy1), speed2 = Math.hypot(vx2, vy2);
      const climb1 = -vy1, climb2 = -vy2;
      const antiGravity = speed1 < 12 && climb2 > climb1 + .85 && climb2 > Math.max(1.0, climb1 * 1.25 + .4);
      let sharpUp = false;
      if (speed1 > .7 && speed2 > .5 && speed1 < 14) {
        const ang1 = Math.atan2(-vy1, vx1), ang2 = Math.atan2(-vy2, vx2);
        const turn = Math.abs(Math.atan2(Math.sin(ang2 - ang1), Math.cos(ang2 - ang1)));
        // Near-vertical coasts naturally wobble in atan2; only flag a real hook when
        // climb steepens while the heading snaps more upright from a diagonal.
        // Elevation is measured from the horizontal run so left and right flights match.
        const elev1 = Math.atan2(-vy1, Math.abs(vx1)), elev2 = Math.atan2(-vy2, Math.abs(vx2));
        const wasDiagonal = Math.abs(elev1) < 1.15;
        sharpUp = (turn > .85 && climb2 > climb1 + .5)
          || (wasDiagonal && speed1 < 8 && climb2 > climb1 + .9 && Math.abs(elev2) > Math.abs(elev1) + .55);
      }
      const aboveCoast = midClimb != null && climb2 > midClimb + 2.2 && climb2 > 2.2;
      if (!antiGravity && !sharpUp && !aboveCoast) break;
      end--;
    }
    const points = raw.slice(0, end).map(p => ({ t: p.t, x: p.x / this.w, y: p.y / this.h }));
    return {
      points,
      camera: this.camera,
      engine: 'motion-beta',
      observedFrames: points.length,
      launchHypotheses: this.launchHypotheses.slice(0, 8).map(h => ({
        id: h.id,
        impactT: h.impactT,
        anchorX: h.anchorX != null ? h.anchorX / this.w : null,
        anchorY: h.anchorY != null ? h.anchorY / this.h : null,
        sourceSize: h.sourceSize,
        confidence: h.confidence,
        pointCount: h.pointCount
      })),
      selectedLaunchId: this.best?.launchId || null,
      status: points.length >= 2 ? 'tracked' : 'no_reliable_track',
      reasonCodes: points.length >= 2 ? [] : ['insufficient_visible_frames']
    };
  }
  resultGlobal() {
    // Ensure hypotheses exist even if ranking never promoted this.best.
    this.best = this.selectBestTrack() || this.best;
    if (this.best) this.rememberHypothesis(this.best);
    for (const track of this.tracks.slice(0, 40)) this.rememberHypothesis(track);

    const trackPool = [...(this.best ? [this.best] : []), ...this.tracks];
    const launches = launchesFromHypotheses(this.launchHypotheses, trackPool);
    // Detector candidates alone often drop the faint mid-flight ball; merge linked observations.
    const frames = mergeAssocFrames(this.frameLog, framesFromTracks(trackPool));
    const assoc = associateFlight({
      frames,
      launches,
      imageWidth: this.w,
      imageHeight: this.h,
      beamWidth: 28,
      maxMiss: 8,
      minObs: 5,
      nullMargin: 2.2
    });
    const rendered = toRendererResult(assoc, {
      width: this.w,
      height: this.h,
      camera: this.camera,
      engine: 'global-v2'
    });
    rendered.launchHypotheses = this.launchHypotheses.slice(0, 8).map(h => ({
      id: h.id,
      impactT: h.impactT,
      anchorX: h.anchorX != null ? h.anchorX / this.w : null,
      anchorY: h.anchorY != null ? h.anchorY / this.h : null,
      sourceSize: h.sourceSize,
      confidence: h.confidence,
      pointCount: h.pointCount
    }));
    // A v2 abstention stays an abstention: the legacy linker never substitutes its own track.
    return rendered;
  }
}

function finiteCandidate(c) {
  return Number.isFinite(c?.x) && Number.isFinite(c?.y) && Number.isFinite(c?.quality) && Number.isFinite(c?.size);
}

export function cameraAt(camera, time) {
  if (!camera?.length) return { x: 0, y: 0 };
  let lo = 0, hi = camera.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (camera[mid].t < time) lo = mid + 1; else hi = mid; }
  const b = camera[lo], a = camera[Math.max(0, lo - 1)];
  const u = b.t === a.t ? 0 : Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

export function visiblePath(points, time, hold = true) {
  if (points.length < 2 || time < points[0].t) return [];
  const firstTime = hold ? -Infinity : time - .55;
  const visible = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.t <= time) { if (p.t >= firstTime) visible.push(p); }
    else {
      const a = points[i - 1];
      if (a && time >= firstTime) {
        const u = (time - a.t) / (p.t - a.t);
        visible.push({ t: time, x: a.x + (p.x - a.x) * u, y: a.y + (p.y - a.y) * u });
      }
      break;
    }
  }
  return visible;
}
