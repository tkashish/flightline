/**
 * Timestamp-aware analysis frame sampling helpers (Phase 1).
 * Browser analyze() still defaults to the legacy 30 Hz seek grid; this module
 * records actual presentation times after seeks and rejects bad dt.
 */

/** @typedef {{ index:number, t:number, targetT:number, width:number, height:number, duplicate:boolean }} FrameStamp */

export function plannedSampleTimes(duration, fps = 30) {
  const frames = Math.max(1, Math.ceil(duration * fps));
  const times = [];
  for (let i = 0; i < frames; i++) {
    times.push(Math.min(i / fps, Math.max(0, duration - 0.002)));
  }
  return times;
}

/**
 * Build motion dt from consecutive presentation timestamps.
 * Rejects non-positive / near-zero gaps; callers must not use NaN velocities.
 */
export function motionDt(tPrev, tNext, { minDt = 1 / 240, maxDt = 1.0 } = {}) {
  if (!Number.isFinite(tPrev) || !Number.isFinite(tNext)) return null;
  const dt = tNext - tPrev;
  if (!(dt >= minDt) || dt > maxDt) return null;
  return dt;
}

export function isNearDuplicateTime(tPrev, tNext, eps = 1 / 240) {
  return Number.isFinite(tPrev) && Number.isFinite(tNext) && Math.abs(tNext - tPrev) < eps;
}

/**
 * Velocity in analysis pixels / second using real dt (not px/frame).
 */
export function velocityPerSecond(x0, y0, t0, x1, y1, t1, opts) {
  const dt = motionDt(t0, t1, opts);
  if (dt == null) return null;
  return { vx: (x1 - x0) / dt, vy: (y1 - y0) / dt, dt };
}

/**
 * Bounded ring buffer for analysis frames (RGBA copies).
 * Capacity is frame count, not bytes — callers choose capacity from memory budget.
 */
export class FrameRingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.slots = Array.from({ length: this.capacity }, () => null);
    this.write = 0;
    this.size = 0;
  }
  push(frame) {
    const prev = this.slots[this.write];
    this.slots[this.write] = frame;
    this.write = (this.write + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
    return prev;
  }
  /** Newest-first iteration of retained frames. */
  *recent() {
    for (let i = 0; i < this.size; i++) {
      const idx = (this.write - 1 - i + this.capacity * 4) % this.capacity;
      yield this.slots[idx];
    }
  }
  clear() {
    this.slots.fill(null);
    this.write = 0;
    this.size = 0;
  }
}

/**
 * Estimate bytes for an RGBA analysis frame.
 */
export function rgbaBytes(width, height) {
  return width * height * 4;
}

/**
 * Suggest ring capacity so analysis RGBA cache stays under budgetBytes.
 * Always keeps at least 8 frames when budget allows.
 */
export function suggestRingCapacity(width, height, budgetBytes = 256 * 1024 * 1024) {
  const per = rgbaBytes(width, height);
  if (per <= 0) return 8;
  return Math.max(8, Math.min(480, Math.floor(budgetBytes / per)));
}
