import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plannedSampleTimes,
  motionDt,
  isNearDuplicateTime,
  velocityPerSecond,
  FrameRingBuffer,
  suggestRingCapacity,
  rgbaBytes
} from '../dist/frame-source.js';

test('plannedSampleTimes covers duration on a 30 Hz grid without exceeding end', () => {
  const times = plannedSampleTimes(1.0, 30);
  assert.equal(times.length, 30);
  assert.equal(times[0], 0);
  assert.ok(times.at(-1) < 1.0);
  assert.ok(Math.abs(times.at(-1) - 29 / 30) < 1e-9);
  const long = plannedSampleTimes(2.5, 30);
  assert.equal(long.length, 75);
  assert.ok(long.at(-1) <= 2.5 - 0.002 + 1e-9);
});

test('motionDt rejects zero, negative, and huge gaps', () => {
  assert.equal(motionDt(1.0, 1.0), null);
  assert.equal(motionDt(1.2, 1.0), null);
  assert.equal(motionDt(1.0, 3.5), null);
  assert.ok(Math.abs(motionDt(1.0, 1.0 + 1 / 30) - 1 / 30) < 1e-9);
});

test('velocityPerSecond uses real dt not frame counts', () => {
  const a = velocityPerSecond(0, 0, 0, 10, -20, 0.5);
  assert.deepEqual(a, { vx: 20, vy: -40, dt: 0.5 });
  assert.equal(velocityPerSecond(0, 0, 1, 1, 1, 1), null);
});

test('duplicate timestamp detection', () => {
  assert.equal(isNearDuplicateTime(1.0, 1.0 + 1 / 500), true);
  assert.equal(isNearDuplicateTime(1.0, 1.0 + 1 / 30), false);
});

test('FrameRingBuffer drops oldest when over capacity', () => {
  const ring = new FrameRingBuffer(3);
  ring.push({ id: 1 });
  ring.push({ id: 2 });
  ring.push({ id: 3 });
  const dropped = ring.push({ id: 4 });
  assert.equal(dropped.id, 1);
  assert.equal(ring.size, 3);
  const ids = [...ring.recent()].map(f => f.id);
  assert.deepEqual(ids, [4, 3, 2]);
});

test('suggestRingCapacity stays within byte budget', () => {
  const w = 720, h = 1280;
  const cap = suggestRingCapacity(w, h, 64 * 1024 * 1024);
  assert.ok(cap >= 8);
  assert.ok(cap * rgbaBytes(w, h) <= 64 * 1024 * 1024);
});
