import { MotionTracker } from './tracker.js?v=41';
import { BallRefiner } from './refiner.js?v=40';
let tracker, diagnostics, frames, refiner;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') { tracker = new MotionTracker(data.width, data.height); diagnostics = data.diagnostics; frames = []; self.postMessage({ ok: true }); }
    if (data.type === 'frame') {
      tracker.detect(new Uint8ClampedArray(data.buffer), data.time);
      if (diagnostics && data.time >= diagnostics.from && data.time <= diagnostics.to) frames.push({
        t: data.time, blockedUntil: tracker.seedBlockedUntil,
        movingCount: tracker.lastCandidates.filter(p => p.moving).length,
        totalCandidates: tracker.lastCandidates.length,
        candidates: tracker.lastCandidates.filter(p => p.size >= 6 && p.quality > .75).slice(0, 160),
        spots: tracker.spots.filter(p => p.seen >= 8 && p.size >= 6 && p.quality > .78).slice(0, 80).map(p => ({ ...p })),
        tracks: tracker.tracks.slice(0, 50).map(p => ({ first: p.points[0], last: p.points.at(-1), count: p.points.length, score: p.score }))
      });
      self.postMessage({ ok: true });
    }
    if (data.type === 'finish') self.postMessage({ ...tracker.result(), ...(diagnostics ? { frames, best: tracker.best, width: tracker.w, height: tracker.h } : {}) });
    if (data.type === 'refine-init') { refiner = new BallRefiner(data.width, data.height, data.seed); self.postMessage({ ok: true }); }
    if (data.type === 'refine-frame') {
      const point = refiner.detect(new Uint8ClampedArray(data.buffer), data.width, data.height, data.left, data.top, data.time, data.camera);
      self.postMessage({ point, finished: refiner.finished, prediction: refiner.predict(data.time + 1 / 30) });
    }
    if (data.type === 'refine-finish') self.postMessage({ points: refiner.result() });
  } catch (error) { self.postMessage({ error: error.message }); }
};
