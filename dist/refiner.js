// Once a launch is found, examine a small patch at the video's native resolution.
// This retains the faint, distant ball which disappears in the initial downsample.
export class BallRefiner {
  constructor(width, height, seed) {
    this.w = width; this.h = height;
    this.points = seed.map(p => ({ ...p, x: p.x * width, y: p.y * height }));
    this.previous = null; this.misses = 0; this.finished = false;
  }
  predict(t) {
    const last = this.points.at(-1), first = this.points[Math.max(0, this.points.length - 4)];
    const dt = Math.max(1 / 30, last.t - first.t);
    return { x: last.x + (last.x - first.x) / dt * (t - last.t), y: last.y + (last.y - first.y) / dt * (t - last.t) };
  }
  detect(rgba, width, height, left, top, t, camera = { x: 0, y: 0 }) {
    if (this.finished) return null;
    const gray = new Uint8Array(width * height), mask = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    for (let y = 6; y < height - 6; y++) for (let x = 6; x < width - 6; x++) {
      const i = y * width + x;
      const surround = (gray[i - 5] + gray[i + 5] + gray[i - width * 5] + gray[i + width * 5]) / 4;
      if (gray[i] > 95 && gray[i] - surround > 7) mask[i] = 1;
    }
    const prediction = this.predict(t), last = this.points.at(-1), gap = Math.max(1 / 30, t - last.t);
    const distance = Math.hypot(prediction.x - last.x, prediction.y - last.y);
    const radius = Math.min(24, 4 + distance * .5 + this.misses * 2), stack = [];
    let best = null;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start]) continue;
      mask[start] = 0; stack.push(start);
      let sx = 0, sy = 0, size = 0, contrast = 0, changing = 0, compared = 0;
      let minx = width, maxx = 0, miny = height, maxy = 0;
      while (stack.length) {
        const i = stack.pop(), x = i % width, y = Math.floor(i / width);
        size++; sx += x; sy += y;
        minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
        if (x >= 5 && x < width - 5 && y >= 5 && y < height - 5) contrast += gray[i] - (gray[i - 5] + gray[i + 5] + gray[i - width * 5] + gray[i + width * 5]) / 4;
        if (this.previous) {
          const px = Math.round(left + x - this.previous.left - (camera.x - this.previous.camera.x) * this.w);
          const py = Math.round(top + y - this.previous.top - (camera.y - this.previous.camera.y) * this.h);
          if (px >= 0 && px < this.previous.width && py >= 0 && py < this.previous.height) { compared++; if (gray[i] - this.previous.gray[py * this.previous.width + px] > 4) changing++; }
        }
        for (const step of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) {
          const j = i + step;
          if (j >= 0 && j < mask.length && Math.abs(j % width - x) <= 1 && mask[j]) { mask[j] = 0; stack.push(j); }
        }
      }
      if (size > 80 || maxx - minx > 15 || maxy - miny > 15) continue;
      const x = left + sx / size - camera.x * this.w, y = top + sy / size - camera.y * this.h;
      const error = Math.hypot(x - prediction.x, y - prediction.y);
      if (error > radius || (compared && changing / compared < .15) || (t > last.t && Math.hypot(x - last.x, y - last.y) / gap < 8)) continue;
      if (last.size && size > last.size * 1.8 + 4) continue;
      const vx = x - last.x, vy = y - last.y, px = prediction.x - last.x, py = prediction.y - last.y;
      if (t > last.t && distance > 1 && (vx * px + vy * py) / (Math.hypot(vx, vy) * distance) < .3) continue;
      const score = error / radius + 2 / Math.max(7, contrast / size);
      if (!best || score < best.score) best = { x, y, t, score, contrast: contrast / size, size };
    }
    this.previous = { gray, width, height, left, top, camera };
    if (best) {
      if (t === last.t) this.points[this.points.length - 1] = best;
      else this.points.push(best);
      this.misses = 0;
      return { t, x: best.x / this.w, y: best.y / this.h };
    }
    if (++this.misses > 4) this.finished = true;
    return null;
  }
  result() { return this.points.map(p => ({ t: p.t, x: p.x / this.w, y: p.y / this.h })); }
}
