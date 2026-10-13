import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoiEvidenceDetector,
  matchedMotionScore,
  rgbaToGray,
  dogResponse,
  nmsPeaks,
  visualScoreMap
} from '../dist/roi-evidence.js';

function makeRgba(w, h, paint) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = paint(x, y);
    const i = (y * w + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return rgba;
}

function stampBall(rgba, w, h, x, y, radius = 2, value = 220) {
  for (let yy = Math.max(0, y - radius - 1); yy <= Math.min(h - 1, y + radius + 1); yy++) {
    for (let xx = Math.max(0, x - radius - 1); xx <= Math.min(w - 1, x + radius + 1); xx++) {
      if (Math.hypot(xx - x, yy - y) > radius) continue;
      const i = (yy * w + xx) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
    }
  }
}

test('DoG responds positively on a bright speck', () => {
  const w = 64, h = 64;
  const rgba = makeRgba(w, h, () => 40);
  stampBall(rgba, w, h, 32, 32, 2, 230);
  const gray = rgbaToGray(rgba, w, h);
  const on = dogResponse(gray, w, h, 32, 32, 1, 3);
  const off = dogResponse(gray, w, h, 10, 10, 1, 3);
  assert.ok(on > off + 20, `on=${on} off=${off}`);
});

test('RoiEvidenceDetector returns multiple soft candidates including a faint ball', () => {
  const w = 96, h = 96;
  const rgba = makeRgba(w, h, () => 50);
  // Faint ball + brighter clutter — soft detector must keep BOTH, not only the brightest.
  stampBall(rgba, w, h, 40, 55, 2, 145);
  stampBall(rgba, w, h, 70, 20, 3, 240);
  const det = new RoiEvidenceDetector({ topK: 12, minVisual: 2.5 });
  const cands = det.detect(rgba, w, h, { t: 1, left: 100, top: 200 });
  assert.ok(cands.length >= 2, `got ${cands.length}`);
  assert.ok(cands.every(c => c.observed === true));
  const nearBall = cands.some(c => Math.hypot(c.localX - 40, c.localY - 55) <= 4);
  const nearClutter = cands.some(c => Math.hypot(c.localX - 70, c.localY - 20) <= 4);
  assert.ok(nearBall, `faint ball should remain among soft candidates; got ${cands.slice(0, 5).map(c => `${c.localX},${c.localY}`).join('; ')}`);
  assert.ok(nearClutter, 'bright clutter also listed (soft, not winner-take-all)');
  // Source mapping
  assert.equal(cands[0].x - cands[0].localX, 100);
});

test('matched motion recovers a weak aligned sequence; random dots do not', () => {
  const w = 80, h = 80;
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const rgba = makeRgba(w, h, () => 45);
    // Ball below single-frame threshold-ish but aligned: center moves with vx=8, vy=-10 per frame @ dt=1/30
    const x = 20 + i * (8 / 30) * 30; // 8 px/frame
    const y = 60 - i * 10;
    stampBall(rgba, w, h, Math.round(x), Math.round(y), 1, 95); // weak
    frames.push({ gray: rgbaToGray(rgba, w, h), w, h, t: i / 30 });
  }
  const aligned = matchedMotionScore({
    frames, x0: 20 + 2 * 8, y0: 60 - 2 * 10, mid: 2, vx: 8 * 30, vy: -10 * 30
  });
  // Random path
  const random = matchedMotionScore({
    frames, x0: 50, y0: 20, mid: 2, vx: -100, vy: 80
  });
  assert.ok(aligned > random + 0.5, `aligned=${aligned} random=${random}`);
});

test('nmsPeaks keeps spaced top responses', () => {
  const w = 32, h = 32;
  const scores = new Float32Array(w * h);
  scores[10 * w + 10] = 20;
  scores[10 * w + 11] = 19;
  scores[20 * w + 20] = 18;
  const peaks = nmsPeaks(scores, w, h, { k: 5, minScore: 5, radius: 3 });
  assert.equal(peaks.length, 2);
  assert.equal(peaks[0].x, 10);
});

test('dark polarity candidate is retained against bright sky background', () => {
  const w = 64, h = 64;
  const rgba = makeRgba(w, h, () => 200);
  stampBall(rgba, w, h, 30, 30, 2, 90); // dark speck
  const det = new RoiEvidenceDetector({ topK: 6, minVisual: 2 });
  const cands = det.detect(rgba, w, h, { t: 0.5 });
  assert.ok(cands.some(c => c.polarity === 'dark' && Math.hypot(c.localX - 30, c.localY - 30) <= 3));
});

test('visualScoreMap is finite and peaked near a ball', () => {
  const w = 48, h = 48;
  const rgba = makeRgba(w, h, () => 30);
  stampBall(rgba, w, h, 24, 24, 2, 255);
  const gray = rgbaToGray(rgba, w, h);
  const scores = visualScoreMap(gray, w, h);
  assert.ok(scores[24 * w + 24] > scores[5 * w + 5]);
});
