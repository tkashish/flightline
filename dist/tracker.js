// Experimental, model-free candidate detection. All positions are observed, never extrapolated.
export class MotionTracker {
  constructor(width, height) {
    this.w = width; this.h = height; this.previous = null;
    this.tracks = []; this.best = null; this.frame = 0;
    this.offset = { x: 0, y: 0 }; this.camera = []; this.spots = []; this.seedBlockedUntil = -1;
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
    const localBalls = this.localFlightCandidates(gray, rgba, t, shift);
    for (const p of localBalls) {
      if (!candidates.some(c => Math.hypot(c.x - p.x, c.y - p.y) < 2.5)) candidates.push(p);
    }
    this.previous = gray;
    candidates.sort((a, b) => b.quality - a.quality);
    this.lastCandidates = candidates;
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
  localFlightCandidates(gray, rgba, t, shift) {
    // Only coast the current best flight — searching every track latches onto sky junk.
    const track = this.best;
    if (!track || track.points.length < 6) return [];
    const w = this.w, h = this.h;
    const last = track.points.at(-1), prev = track.points.at(-2);
    const gap = Math.max(1, this.frame - last.f);
    if (gap > 8) return [];
    const dt = Math.max(1, last.f - (prev?.f ?? last.f - 1));
    const pvx = prev ? (last.x - prev.x) / dt : 0;
    const pvy = prev ? (last.y - prev.y) / dt : -2;
    const px = Math.round(last.x + this.offset.x + pvx * gap);
    const py = Math.round(last.y + this.offset.y + pvy * gap);
    if (py < 9 || py > h * .72 || px < 9 || px > w - 10) return [];
    const rad = Math.min(22, 8 + gap * 3.5);
    let peak = null;
    for (let y = Math.max(9, py - rad); y <= Math.min(h - 10, py + rad); y++) {
      for (let x = Math.max(9, px - rad); x <= Math.min(w - 10, px + rad); x++) {
        const i = y * w + x, v = gray[i];
        if (v < 145) continue;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        // Blue-sky cast pushes chroma well past the global sky gate.
        if (Math.max(r, g, b) - Math.min(r, g, b) > 145) continue;
        const surround = (gray[i - 6] + gray[i + 6] + gray[i - w * 6] + gray[i + w * 6]) / 4;
        const contrast = v - surround;
        if (contrast < 10) continue;
        if (gray[i - 1] > v || gray[i + 1] > v || gray[i - w] > v || gray[i + w] > v) continue;
        const score = contrast + (v - 140) * .2 - Math.hypot(x - px, y - py) * .7;
        if (!peak || score > peak.score) peak = { x, y, v, contrast, score };
      }
    }
    if (!peak || peak.contrast < 10) return [];
    let sx = 0, sy = 0, count = 0, bright = 0, minx = peak.x, maxx = peak.x, miny = peak.y, maxy = peak.y;
    for (let y = peak.y - 1; y <= peak.y + 1; y++) for (let x = peak.x - 1; x <= peak.x + 1; x++) {
      const i = y * w + x, v = gray[i];
      if (v < peak.v - 28) continue;
      const surround = (gray[i - 6] + gray[i + 6] + gray[i - w * 6] + gray[i + w * 6]) / 4;
      if (v - surround < 7) continue;
      sx += x; sy += y; count++; bright += v;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    }
    if (count < 1) return [];
    const cand = {
      x: sx / count - this.offset.x, y: sy / count - this.offset.y, t, f: this.frame,
      quality: bright / count / 255, size: Math.min(4, count), moving: true,
      roundness: (maxx - minx + 1) / (maxy - miny + 1),
      compactness: count / ((maxx - minx + 1) * (maxy - miny + 1)),
      local: true
    };
    // Coasting can pick up a little lateral drift; only reject sharp reversals.
    const vx = (cand.x - last.x) / gap, vy = (cand.y - last.y) / gap;
    const speed = Math.hypot(vx, vy), prevSpeed = Math.hypot(pvx, pvy);
    if (speed < .35 || speed > Math.max(8, prevSpeed * 2.4 + 2.5)) return [];
    if (prevSpeed > 1.2 && (vx * pvx + vy * pvy) / (speed * prevSpeed) < .55) return [];
    if (vy > 0.7) return [];
    return [cand];
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
      if (gap > (track.points.length >= 6 ? 8 : 5)) continue;
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
          // Reject clear descent back toward the golfer, but allow apex coasting.
          if (vy > (long ? 0.55 : -.15) && (source.y - p.y) / this.h > .04) continue;
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
          if (track.points.length >= 6 && Math.hypot(pvx, pvy) > .8
            && (vx * pvx + vy * pvy) / (speed * Math.hypot(pvx, pvy)) < .65) continue;
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
        const linked = { points, cost: totalCost, score, length, anchor: track.anchor };
        next.push(linked);
        const extendsBest = this.best && points.length > this.best.points.length && points.includes(this.best.points.at(-1));
        // Tiny clothing/glare seeds can rocket upward; only promote tracks that
        // started from an address-sized stationary ball.
        const addressLike = source.size >= 16 && source.quality >= .74 && (source.compactness ?? 1) >= .55;
        const betterAnchor = this.best && track.anchor > this.best.anchor + 6 && score >= this.best.score * .92;
        if (addressLike && points.length >= 5 && rise > .065 && efficiency > .85 && totalCost / points.length < .85 && (!this.best || score > this.best.score || extendsBest || betterAnchor)) this.best = linked;
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
        next.push({ points: [{ ...spot, f: p.f - 1, t: Math.max(0, p.t - 1 / 30) }, p], cost: 0, score: anchor + 7, anchor, length: distance });
      }
    }
    next.sort((a, b) => b.score - a.score);
    // Limit duplicate histories ending on the same observations.
    const counts = new Map();
    this.tracks = next.filter(track => {
      const p = track.points.at(-1), key = `${p.f}:${p.x}:${p.y}`, count = counts.get(key) || 0;
      counts.set(key, count + 1); return count < 3;
    }).slice(0, 160);
  }
  result() {
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
    const points = raw.slice(0, end).map(p => ({ t: p.t, x: p.x / this.w, y: p.y / this.h }));
    return { points, camera: this.camera, engine: 'motion-beta', observedFrames: points.length };
  }
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
