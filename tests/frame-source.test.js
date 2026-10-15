import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENGINE,
  ENGINES,
  FRAME_ENGINES,
  UNMEASURED_PHASE,
  frameCentre,
  pickEngine,
  sourceFrameSchedule,
  analysisSchedule,
  snapSourceFps,
  medianInterval,
  medianFrameInterval,
  presentedFrameReader,
  probeSourceFps,
  shownFrameTime,
  seekFrameTiming,
  measureFrameTiming,
  readSample,
  frameHash,
  frameFeed
} from '../dist/frame-source.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('sourceFrameSchedule maps a 30 Hz grid one-to-one onto a 30 fps clip at frame centres', () => {
  const s = sourceFrameSchedule(10, 30);
  assert.equal(s.length, 300);
  s.forEach((e, i) => {
    assert.equal(e.index, i);
    assert.ok(close(e.pts, i / 30));
    assert.ok(close(e.t, (i + 0.5) / 30));
  });
});

test('sourceFrameSchedule samples every other frame of a 60 fps clip', () => {
  const s = sourceFrameSchedule(1, 60, 30);
  assert.deepEqual(s.map(e => e.index), Array.from({ length: 30 }, (_, i) => 2 * i));
  assert.ok(close(s[3].pts, 6 / 60));
  assert.ok(close(s[3].t, 6.5 / 60));
});

test('sourceFrameSchedule drops grid samples that land on an already scheduled frame', () => {
  const film = sourceFrameSchedule(1, 24, 30);
  assert.deepEqual(film.map(e => e.index), Array.from({ length: 24 }, (_, i) => i));
  const ntsc = sourceFrameSchedule(2, 29.97, 30);
  assert.equal(ntsc.length, 59);
  assert.deepEqual(ntsc.slice(0, 3).map(e => e.index), [0, 1, 2]);
  for (let i = 1; i < ntsc.length; i++) assert.ok(ntsc[i].index > ntsc[i - 1].index);
});

test('sourceFrameSchedule keeps indices and seek targets inside the clip', () => {
  const s = sourceFrameSchedule(0.51, 30);
  assert.equal(s.length, 16);
  assert.equal(s.at(-1).index, 15);
  assert.ok(close(s.at(-1).pts, 0.5));
  assert.ok(close(s.at(-1).t, 0.509));
  const slow = sourceFrameSchedule(0.5, 10, 30);
  assert.deepEqual(slow.map(e => e.index), [0, 1, 2, 3, 4]);
  assert.ok(slow.every(e => e.t < 0.5));
  assert.deepEqual(sourceFrameSchedule(0, 30), []);
  assert.deepEqual(sourceFrameSchedule(NaN, 30), []);
  assert.deepEqual(sourceFrameSchedule(1, 0), []);
});

test('sourceFrameSchedule starts at the first frame and covers the clip through its last frame', () => {
  // A first frame at 0.2 s (an edit list or a late video track) and 90 frames after it.
  const s = sourceFrameSchedule(3.2, 30, 30, 0.2);
  assert.equal(s.length, 90);
  s.forEach((e, i) => {
    assert.equal(e.index, i);
    assert.ok(close(e.pts, 0.2 + i / 30));
    assert.ok(close(e.t, Math.min(3.199, 0.2 + (i + 0.5) / 30)));
  });
  // A clip end read from microsecond timestamps (last frame 2.966667 s plus one frame) is still 90 frames.
  assert.equal(sourceFrameSchedule(2.966667 + 1 / 30, 30).length, 90);
  assert.deepEqual(sourceFrameSchedule(0.2, 30, 30, 0.2), []);
});

test('analysisSchedule seeks frame centres at a measured rate and the off-boundary phase for a guessed one', () => {
  const measured = analysisSchedule({ start: 0.2, end: 1.2, fps: 60, measured: true });
  assert.equal(measured.length, 30);
  measured.forEach((e, i) => { assert.equal(e.index, 2 * i); assert.ok(close(e.pts, 0.2 + 2 * i / 60)); assert.ok(close(e.t, 0.2 + (2 * i + 0.5) / 60)); });
  const guessed = analysisSchedule({ start: 0, end: 1, fps: 30, measured: false });
  guessed.forEach((e, i) => assert.ok(close(e.t, (i + UNMEASURED_PHASE) / 30)));
  assert.deepEqual(analysisSchedule({ start: 0, end: 1, fps: 25, measured: true }, 15).map(e => e.index), sourceFrameSchedule(1, 25, 15).map(e => e.index));
});

test('sourceFrameSchedule seeks a guessed 30 fps grid away from every common frame boundary', () => {
  const s = sourceFrameSchedule(30, 30, 30, 0, UNMEASURED_PHASE);
  assert.ok(close(s[3].t, 3.45 / 30));
  for (const fps of [24, 25, 30, 48, 50, 60, 90, 100, 120, 240]) {
    for (const { t } of s) {
      const k = t * fps, gap = Math.min(k - Math.floor(k), Math.ceil(k) - k) / fps;
      assert.ok(gap > 1.6e-3, `${fps} fps: target ${t} is ${(gap * 1e3).toFixed(2)} ms from a frame boundary`);
    }
  }
  // Frame centres of a guessed 30 fps fall exactly on 60 fps boundaries.
  assert.ok(close((sourceFrameSchedule(1, 30)[1].t * 60) % 1, 0));
});

test('snapSourceFps snaps near-common rates and rounds the rest', () => {
  assert.equal(snapSourceFps(1 / (1001 / 30000)), 29.97);
  assert.equal(snapSourceFps(30.4), 30);
  assert.equal(snapSourceFps(29.98), 29.97);
  assert.equal(snapSourceFps(59.9), 59.94);
  assert.equal(snapSourceFps(61), 60);
  assert.equal(snapSourceFps(118), 119.88);
  assert.equal(snapSourceFps(236), 240);
  assert.equal(snapSourceFps(23.9), 23.976);
  assert.equal(snapSourceFps(33.3333), 33.33);
  assert.equal(snapSourceFps(15.004), 15);
  assert.equal(snapSourceFps(1000), 1000);
});

test('snapSourceFps falls back to 30 for unusable input', () => {
  for (const v of [NaN, Infinity, -Infinity, 0, -24, undefined, null]) assert.equal(snapSourceFps(v), 30);
});

test('pickEngine defaults to v2 and rejects unknown names instead of mapping them to legacy', () => {
  assert.equal(DEFAULT_ENGINE, 'v2');
  for (const v of [undefined, null, '']) assert.equal(pickEngine(v), 'v2');
  assert.equal(pickEngine('v2'), 'v2');
  assert.equal(pickEngine('legacy'), 'legacy');
  for (const v of ['V2', 'bogus', 'global-v2']) assert.throws(() => pickEngine(v), /Unknown tracking engine/);
});

test('medianInterval is the median step between frame starts, ignoring repeats', () => {
  assert.equal(medianInterval([0, 1, 3, 4]), 1);
  assert.ok(close(medianInterval([0, 0, 1 / 30, 2 / 30]), 1 / 30));
  assert.equal(medianInterval([0.5]), null);
  assert.equal(medianInterval([]), null);
});

test('medianFrameInterval divides out missed callbacks and ignores non-advancing frames', () => {
  const at = (mediaTime, presentedFrames) => ({ mediaTime, presentedFrames });
  assert.ok(close(medianFrameInterval([at(0, 1), at(1 / 60, 2), at(3 / 60, 4), at(4 / 60, 5)]), 1 / 60));
  assert.ok(close(medianFrameInterval([at(0.1, 1), at(0.1, 2), at(0.1 + 1 / 30, 3)]), 1 / 30));
  assert.ok(close(medianFrameInterval([at(0, 1), at(0.04, 2), at(0.08, 3), at(0.1, 4), at(0.12, 5)]), 0.03));
  assert.ok(close(medianFrameInterval([{ mediaTime: 0 }, { mediaTime: 0.04 }]), 0.04));
  // Missed callbacks on most intervals: the median of the raw deltas would be two frames.
  assert.ok(close(medianFrameInterval([at(0, 1), at(2 / 60, 3), at(4 / 60, 5), at(5 / 60, 6)]), 1 / 60));
  assert.equal(medianFrameInterval([at(0, 1)]), null);
  assert.equal(medianFrameInterval([]), null);
});

// Minimal stand-in for an HTMLVideoElement: frames (CFR from `start`, or explicit `starts`) are
// "presented" to rVFC callbacks after seeks, and on a simulated display clock during playback.
// Like Chrome, `duration` may grow to `grownDuration` once a seek has read the end of the clip.
class FakeVideo {
  constructor({ fps = 30, duration = 3, start = 0, frames = null, starts = null, grownDuration = null, displayHz = 60, rvfc = true, presentOnSeek = 'after', rvfcEcho = false, stallFrom0 = false, playEcho = false } = {}) {
    Object.assign(this, { fps, duration, grownDuration, displayHz, presentOnSeek, rvfcEcho, stallFrom0, playEcho, currentTime: 0, paused: true, muted: false, playbackRate: 1, presented: 0, requests: 0, plays: 0, rates: [], seekId: 0 });
    this.starts = starts || Array.from({ length: frames ?? Math.round((duration - start) * fps) }, (_, k) => start + k / fps);
    this.callbacks = new Map(); this.nextId = 1;
    if (!rvfc) this.requestVideoFrameCallback = undefined;
  }
  requestVideoFrameCallback(cb) { this.requests++; const id = this.nextId++; this.callbacks.set(id, cb); return id; }
  cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
  // The frame on screen at t: the last one starting at or before t (the first before it starts).
  frameTime(t) { let k = 0; while (k + 1 < this.starts.length && this.starts[k + 1] <= t + 1e-9) k++; return this.starts[k]; }
  present(mediaTime) {
    this.presented++; this.shown = mediaTime;
    const due = [...this.callbacks.values()]; this.callbacks.clear();
    for (const cb of due) cb(0, { mediaTime, presentedFrames: this.presented });
  }
  set playbackRate(rate) { this.rate = rate; this.rates?.push(rate); }
  get playbackRate() { return this.rate; }
  play() {
    this.paused = false; this.plays++;
    // Like headless Firefox on a clip that holds its first frame: playing from 0 may present nothing for a while.
    const quiet = this.stallFrom0 && this.currentTime === 0;
    // Like headless Firefox: the first callback is the frame the seek showed, stamped with the seek target, and the
    // next one counts many more presented frames.
    if (this.playEcho) { const due = [...this.callbacks.values()]; this.callbacks.clear(); this.presented++; for (const cb of due) cb(0, { mediaTime: this.currentTime, presentedFrames: this.presented }); this.presented += 13; }
    const tick = () => {
      if (this.paused) return;
      this.currentTime += this.playbackRate / this.displayHz;
      if (this.currentTime >= this.duration) { this.paused = true; return; }
      const f = this.frameTime(this.currentTime);
      if (f !== this.shown && !quiet) this.present(f);
      this.timer = setTimeout(tick, 1);
    };
    this.timer = setTimeout(tick, 1);
    return Promise.resolve();
  }
  pause() { this.paused = true; clearTimeout(this.timer); }
}
const abortError = () => Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
// Same contract as app.js seek(): resolves once the seek completes (here before or after the frame is presented).
// Like app.js, a seek to where the element already is returns at once and presents nothing.
const fakeSeek = async (video, t, signal) => {
  if (signal?.aborted) throw abortError();
  if (Math.abs(video.currentTime - t) < 1e-4) return;
  video.currentTime = t; video.seeks = (video.seeks || 0) + 1;
  if (video.grownDuration && t >= video.duration - 0.1) video.duration = video.grownDuration;
  const plan = Array.isArray(video.presentOnSeek) ? video.presentOnSeek.shift() : video.presentOnSeek;
  const mediaTime = video.rvfcEcho ? t : video.frameTime(t);
  if (plan === 'never') return;
  if (plan === 'before') return video.present(mediaTime);
  // Only the latest seek's frame gets presented.
  const id = ++video.seekId;
  setTimeout(() => { if (video.seekId === id) video.present(mediaTime); }, 1);
};
// WebCodecs stand-in: a VideoFrame of the element carries the shown frame's start in microseconds
// ('frame'), or what some browsers report instead: 0 ('zero'), the seek target ('echo'), or a throw.
class FakeVideoFrame {
  constructor(video) {
    const mode = video.vfMode || 'frame';
    if (mode === 'throw') throw new DOMException('no frame', 'InvalidStateError');
    this.timestamp = mode === 'zero' ? 0 : Math.round((mode === 'echo' ? video.currentTime : video.frameTime(video.currentTime)) * 1e6);
    FakeVideoFrame.open++;
  }
  close() { FakeVideoFrame.open--; }
}
FakeVideoFrame.open = 0;
const withGlobals = async ({ VideoFrame = FakeVideoFrame, hidden = false } = {}, run) => {
  globalThis.VideoFrame = VideoFrame; globalThis.document = { hidden };
  try { return await run(); } finally { delete globalThis.VideoFrame; delete globalThis.document; }
};
// A frame clock over seeks, as app.js builds it: seek, then read the shown frame's VideoFrame timestamp.
const vfClock = video => async (t, signal) => { await fakeSeek(video, t, signal); return shownFrameTime(video); };

test('presentedFrameReader returns the presented frame metadata whether rVFC fires before or after seeked', async () => {
  for (const presentOnSeek of ['after', 'before']) {
    const video = new FakeVideo({ presentOnSeek }), read = presentedFrameReader(video, fakeSeek);
    const md = await read(2 / 30 - 1e-7);
    assert.ok(close(md.mediaTime, 1 / 30));
    assert.equal(video.callbacks.size, 0);
  }
});

test('presentedFrameReader seeks without waiting when rVFC is missing or the page is hidden', async () => {
  const bare = new FakeVideo({ rvfc: false });
  assert.equal(await presentedFrameReader(bare, fakeSeek)(0.5), null);
  assert.equal(bare.currentTime, 0.5);
  const video = new FakeVideo();
  globalThis.document = { hidden: true };
  try { assert.equal(await presentedFrameReader(video, fakeSeek)(0.5), null); } finally { delete globalThis.document; }
  assert.equal(video.requests, 0);
  assert.equal(video.seeks, 1);
});

test('presentedFrameReader times out, then stops waiting after repeated misses', async () => {
  const video = new FakeVideo({ presentOnSeek: 'never' }), read = presentedFrameReader(video, fakeSeek, { ms: 5, maxMisses: 2 });
  assert.equal(await read(0.1), null);
  assert.equal(await read(0.2), null);
  assert.equal(video.requests, 2);
  assert.equal(await read(0.3), null);
  assert.equal(video.requests, 2);
  assert.equal(video.seeks, 3);
  assert.equal(video.callbacks.size, 0);
});

test('presentedFrameReader counts only consecutive misses', async () => {
  const video = new FakeVideo({ presentOnSeek: ['never', 'after', 'never', 'after'] }), read = presentedFrameReader(video, fakeSeek, { ms: 5, maxMisses: 2 });
  assert.equal(await read(0.1), null);
  assert.ok(close((await read(0.2)).mediaTime, 6 / 30));
  assert.equal(await read(0.3), null);
  // One miss since the last presented frame: still waiting for rVFC.
  assert.ok(close((await read(0.4)).mediaTime, 12 / 30));
  assert.equal(video.requests, 4);
});

test('presentedFrameReader propagates seek failures and cancels its callback', async () => {
  const video = new FakeVideo(), controller = new AbortController();
  controller.abort();
  await assert.rejects(presentedFrameReader(video, fakeSeek)(0.5, controller.signal), { name: 'AbortError' });
  assert.equal(video.callbacks.size, 0);
});

test('probeSourceFps measures 30 and 60 fps and restores the element state', async () => {
  for (const fps of [30, 60, 29.97]) {
    const video = new FakeVideo({ fps });
    video.currentTime = 0.25;
    const probe = await probeSourceFps(video, fakeSeek);
    assert.deepEqual(probe, { fps, measured: true });
    assert.equal(video.paused, true);
    assert.equal(video.muted, false);
    assert.equal(video.playbackRate, 1);
    assert.equal(video.currentTime, 0.25);
    assert.equal(video.callbacks.size, 0);
  }
});

test('probeSourceFps re-checks display-capped clips at quarter speed', async () => {
  for (const fps of [120, 240]) {
    const video = new FakeVideo({ fps, duration: 2 });
    assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps, measured: true });
    assert.deepEqual(video.rates.slice(0, 2), [1, 0.25]);
  }
  // Rates the display shows in full take one pass per stretch: 24 fps is slower than the sample rate, so the two spots play too.
  for (const [fps, plays] of [[24, 3], [30, 1]]) {
    const video = new FakeVideo({ fps, duration: 2 });
    assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps, measured: true });
    assert.equal(video.plays, plays, `${fps} fps`);
    assert.ok(!video.rates.includes(0.25), `${fps} fps`);
  }
});

// The first second at 15 fps, then 30 fps (some phones start slow); optionally back to 15 fps for the last second.
const slowStart = (back = false) => Array.from({ length: 90 }, (_, k) => k / 30).filter(t => (t < 1 - 1e-9 || (back && t > 2 - 1e-9) ? Math.round(t * 30) % 2 === 0 : true));

test('probeSourceFps re-measures a slow start later in the clip; the fastest stretch sets the rate', async () => {
  for (const back of [false, true]) {
    const video = new FakeVideo({ starts: slowStart(back), duration: 3 });
    assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps: 30, measured: true }, `back to 15: ${back}`);
    assert.equal(video.plays, 3);
  }
  const slow = new FakeVideo({ fps: 15, duration: 3 });
  assert.deepEqual(await probeSourceFps(slow, fakeSeek), { fps: 15, measured: true });
});

test('probeSourceFps measures the spots when playback from the start reports no frames', async () => {
  const video = new FakeVideo({ fps: 60, duration: 30, stallFrom0: true });
  assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps: 60, measured: true });
  // Nothing from 0, then each spot at full and quarter speed.
  assert.deepEqual(video.rates.slice(0, 5), [1, 1, 0.25, 1, 0.25]);
});

test('probeSourceFps skips the first callback of each playback, which can carry the seek target', async () => {
  // 15 fps for 0.5 s: the last spot plays only two frames, so one bogus interval would halve its median.
  const video = new FakeVideo({ fps: 15, duration: 0.5, playEcho: true, presentOnSeek: 'before' });
  assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps: 15, measured: true });
  assert.equal(video.plays, 3);
});

test('probeSourceFps plays nothing in a hidden tab and resumes a clip that was playing', async () => {
  const video = new FakeVideo();
  globalThis.document = { hidden: true };
  try { assert.deepEqual(await probeSourceFps(video, fakeSeek), { fps: 30, measured: false }); } finally { delete globalThis.document; }
  assert.equal(video.plays, 0);
  assert.equal(video.seeks, undefined);
  const playing = new FakeVideo({ duration: 30 });
  playing.paused = false;
  assert.deepEqual(await probeSourceFps(playing, fakeSeek), { fps: 30, measured: true });
  assert.equal(playing.paused, false);
  playing.pause();
});

test('probeSourceFps falls back to 30 without rVFC and stops on abort', async () => {
  const bare = new FakeVideo({ rvfc: false, fps: 60 });
  assert.deepEqual(await probeSourceFps(bare, fakeSeek), { fps: 30, measured: false });
  assert.equal(bare.seeks, undefined);
  const video = new FakeVideo(), controller = new AbortController();
  controller.abort();
  await assert.rejects(probeSourceFps(video, fakeSeek, controller.signal), { name: 'AbortError' });
  assert.equal(video.muted, false);
  assert.equal(video.paused, true);
});

test('shownFrameTime reads the shown frame from a WebCodecs VideoFrame and closes it', async () => {
  const video = new FakeVideo({ fps: 60 });
  video.currentTime = 0.1;
  assert.equal(shownFrameTime(video), null);
  await withGlobals({}, () => {
    assert.ok(close(shownFrameTime(video), 0.1, 1e-6));
    video.vfMode = 'throw';
    assert.equal(shownFrameTime(video), null);
  });
  assert.equal(FakeVideoFrame.open, 0);
});

test('seekFrameTiming measures rate, first frame and clip end from seeks alone', async () => {
  await withGlobals({}, async () => {
    for (const fps of [12, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240]) {
      const video = new FakeVideo({ fps, duration: 3 });
      const timing = await seekFrameTiming(vfClock(video), () => video.duration);
      assert.equal(timing.fps, fps, `${fps} fps`);
      assert.equal(timing.start, 0);
      // The clip ends with its last frame (duration 3 s, rounded to whole frames).
      assert.ok(Math.abs(timing.end - Math.max(3, video.starts.at(-1) + 1 / fps)) < 1e-5, `${fps} fps end ${timing.end}`);
      // Rates slower than the 30 fps sample rate are measured again at two spots.
      assert.ok(video.seeks <= (fps < 29 ? 50 : 30), `${fps} fps: ${video.seeks} seeks`);
    }
  });
});

test('seekFrameTiming re-measures a slow start later in the clip; the fastest stretch sets the rate', async () => {
  await withGlobals({}, async () => {
    const cfr = (fps, n, t0 = 0) => Array.from({ length: n }, (_, k) => t0 + k / fps);
    const timing = async starts => {
      const video = new FakeVideo({ starts });
      return { ...(await seekFrameTiming(vfClock(video), () => 3)), seeks: video.seeks };
    };
    // Measured on its first frames alone, a slow start would set 15 fps for the whole clip.
    for (const back of [false, true]) {
      const slow = await timing(slowStart(back));
      assert.equal(slow.fps, 30, `back to 15: ${back}`);
      // Every frame then gets a sample of its own.
      assert.equal(new Set(sourceFrameSchedule(slow.end, slow.fps, 30, slow.start).map(e => new FakeVideo({ starts: slowStart(back) }).frameTime(e.t))).size, slowStart(back).length);
    }
    // A first frame held 0.5 s, and a clip at 24 fps until two thirds in, then 30.
    assert.equal((await timing([0, ...cfr(30, 89, 0.5)])).fps, 30);
    assert.equal((await timing([...cfr(24, 48), ...cfr(30, 30, 2)])).fps, 30);
    // A head at or above the sample rate is not re-measured: a later slow stretch never lowers it.
    const fast = await timing([...cfr(60, 60), ...cfr(30, 60, 1)]);
    assert.deepEqual([fast.fps, fast.seeks <= 30], [60, true]);
    // The median over the first 12 frames keeps a clip whose first two intervals are long at 30 fps.
    assert.equal((await timing([...cfr(15, 2), ...cfr(30, 11, 2 / 15), ...cfr(15, 38, 0.5)])).fps, 30);
    assert.equal((await timing(cfr(15, 45))).fps, 15);
    // A short clip the first frames already cover is not measured twice.
    const short = new FakeVideo({ fps: 15, duration: 0.5 });
    assert.equal((await seekFrameTiming(vfClock(short), () => 0.5)).fps, 15);
    assert.ok(short.seeks <= 20, `${short.seeks} seeks`);
  });
});

test('seekFrameTiming tells a frame that starts exactly at a probe target from a clock that echoes it', async () => {
  await withGlobals({}, async () => {
    // From 15 to 30 fps at 2/15 s: the probe 1.5 intervals past 1/15 s lands exactly on a frame start.
    const starts = [0, 1 / 15, ...Array.from({ length: 60 }, (_, k) => 2 / 15 + k / 30)];
    const video = new FakeVideo({ starts });
    assert.equal((await seekFrameTiming(vfClock(video), () => 2.1)).fps, 30);
  });
});

test('seekFrameTiming follows a late first frame and a duration that grows once the end is read', async () => {
  await withGlobals({}, async () => {
    // Like Chrome on an MP4 whose first frame is at 0.2 s: duration 3.0 until the end is demuxed, then the last frame's start.
    const video = new FakeVideo({ fps: 30, start: 0.2, frames: 90, duration: 3, grownDuration: 3.2 - 1 / 30 });
    const timing = await seekFrameTiming(vfClock(video), () => video.duration);
    assert.ok(close(timing.start, 0.2, 1e-6));
    assert.equal(timing.fps, 30);
    assert.ok(close(timing.end, 3.2, 1e-5), `end ${timing.end}`);
    const schedule = sourceFrameSchedule(timing.end, timing.fps, 30, timing.start);
    assert.equal(schedule.length, 90);
    assert.deepEqual(schedule.map(e => video.frameTime(e.t)), video.starts);
  });
});

test('seekFrameTiming takes the median interval, so dropped and jittered frames keep the nominal rate', async () => {
  await withGlobals({}, async () => {
    const drops = Array.from({ length: 90 }, (_, k) => k / 30).filter((t, k) => k % 4 !== 2);
    assert.equal((await seekFrameTiming(vfClock(new FakeVideo({ starts: drops })), () => 3)).fps, 30);
    const jitter = Array.from({ length: 90 }, (_, k) => k / 30 + (k % 3 === 1 ? 0.004 : 0));
    assert.equal((await seekFrameTiming(vfClock(new FakeVideo({ starts: jitter })), () => 3)).fps, 30);
    const slow = Array.from({ length: 90 }, (_, k) => k / 29.97 + (k % 3 === 1 ? 0.004 : 0));
    assert.equal((await seekFrameTiming(vfClock(new FakeVideo({ starts: slow })), () => 3)).fps, 29.97);
  });
});

test('seekFrameTiming rejects readers that are not a frame clock, within a few seeks', async () => {
  await withGlobals({}, async () => {
    for (const vfMode of ['zero', 'echo', 'throw']) {
      const video = new FakeVideo({ fps: 60 });
      video.vfMode = vfMode;
      assert.equal(await seekFrameTiming(vfClock(video), () => video.duration), null, vfMode);
      assert.ok(video.seeks <= 8, `${vfMode}: ${video.seeks} seeks`);
    }
    // rVFC mediaTime that echoes the seek target (instead of the presented frame) is not a clock either.
    const echo = new FakeVideo({ rvfcEcho: true }), reader = presentedFrameReader(echo, fakeSeek);
    assert.equal(await seekFrameTiming(async t => (await reader(t))?.mediaTime ?? null, () => echo.duration), null);
    // A single-frame clip gives no interval to measure.
    assert.equal(await seekFrameTiming(vfClock(new FakeVideo({ starts: [0] })), () => 1 / 30), null);
  });
});

test('measureFrameTiming uses the WebCodecs clock without rVFC and while the tab is hidden', async () => {
  for (const [rvfc, hidden] of [[false, false], [true, true]]) {
    await withGlobals({ hidden }, async () => {
      let waited = 0;
      const video = new FakeVideo({ fps: 60, rvfc });
      const timing = await measureFrameTiming(video, fakeSeek, undefined, async () => { waited++; });
      assert.equal(timing.clock, 'videoframe');
      assert.equal(timing.fps, 60);
      assert.equal(timing.measured, true);
      assert.equal(waited, 0);
      assert.ok(close(await timing.read(0.11), 6 / 60, 1e-6));
    });
  }
});

test('measureFrameTiming falls back to an rVFC clock, after waiting for a visible tab', async () => {
  await withGlobals({ hidden: true }, async () => {
    let waited = 0;
    const video = new FakeVideo({ fps: 25 });
    video.vfMode = 'zero';
    const timing = await measureFrameTiming(video, fakeSeek, undefined, async () => { waited++; globalThis.document.hidden = false; });
    assert.equal(waited, 1);
    assert.equal(timing.clock, 'rvfc');
    assert.equal(timing.fps, 25);
    assert.ok(close(await timing.read(0.1), 0.08));
  });
});

test('measureFrameTiming without a frame clock measures the rate by playback and reads no times', async () => {
  await withGlobals({}, async () => {
    const video = new FakeVideo({ fps: 60, rvfcEcho: true });
    video.vfMode = 'echo';
    const timing = await measureFrameTiming(video, fakeSeek);
    assert.equal(timing.clock, 'none');
    assert.deepEqual([timing.fps, timing.measured, timing.start, timing.end], [60, true, 0, 3]);
    assert.equal(await timing.read(0.5), null);
    assert.equal(video.currentTime, 0.5);
  });
  // No rVFC and no WebCodecs: an unmeasured 30 fps guess.
  const bare = await measureFrameTiming(new FakeVideo({ fps: 60, rvfc: false }), fakeSeek);
  assert.deepEqual([bare.clock, bare.fps, bare.measured], ['none', 30, false]);
});

test('readSample stamps the shown frame, retries a repeat a quarter frame later, then drops it', async () => {
  const timing = () => ({ duplicatesBeforeRetry: 0, duplicatesAfterRetry: 0 });
  const clock = starts => { const video = new FakeVideo({ starts }); return Object.assign(t => Promise.resolve(video.frameTime(t)), { video }); };
  // Frame 1 starts 0.2 frame late: its centre target still shows frame 0, the retry finds frame 1.
  const late = clock([0, 1.7 / 30, 2 / 30]), t1 = timing();
  assert.deepEqual(await readSample(late, { t: 1.5 / 30, pts: 1 / 30 }, 0, 30, 1, t1), { t: 1.7 / 30, verified: true });
  assert.deepEqual(t1, { duplicatesBeforeRetry: 1, duplicatesAfterRetry: 0 });
  // A frame that never shows: dropped after the retry.
  const gone = clock([0, 2 / 30]), t2 = timing();
  assert.equal(await readSample(gone, { t: 1.5 / 30, pts: 1 / 30 }, 0, 30, 1, t2), null);
  assert.deepEqual(t2, { duplicatesBeforeRetry: 1, duplicatesAfterRetry: 1 });
  // The retry never seeks past maxT.
  const seen = [], capped = t => { seen.push(t); return Promise.resolve(0); };
  assert.equal(await readSample(capped, { t: 0.5, pts: 0.48 }, 0, 30, 0.501, timing()), null);
  assert.deepEqual(seen, [0.5, 0.501]);
  // Without a clock the sample is the scheduled frame, unverified.
  assert.deepEqual(await readSample(async () => null, { t: 1.5 / 30, pts: 1 / 30 }, 0, 30, 1, timing()), { t: 1 / 30, verified: false });
});

const feedTiming = () => ({ sent: 0, unverified: 0, repeatsDropped: 0, duplicatesBeforeRetry: 0, duplicatesAfterRetry: 0, peakResidentFrames: 0, distinctFrames: 0 });
// Frame 1 starts 0.9 frame late, so no target shows it; the target after frame 0 shows frame 0 again.
const lateClip = () => {
  const video = new FakeVideo({ starts: [0, 1.9 / 30, 2 / 30, 3 / 30, 4 / 30], duration: 5 / 30 }), events = [];
  // The shown frame's pixels: its index in every byte.
  const grab = () => new Uint8ClampedArray(16).fill(video.starts.indexOf(video.frameTime(video.currentTime)));
  const post = (pixels, t) => { events.push(`post ${pixels[0]}`); return new Promise(resolve => setTimeout(() => { events.push(`done ${pixels[0]}`); resolve(); }, 3)); };
  return { video, events, grab, post, schedule: sourceFrameSchedule(5 / 30, 30) };
};

test('frameFeed posts each frame once with its clock stamp, one post at a time, the next seek overlapping it', async () => {
  const { video, events, grab, post, schedule } = lateClip(), timing = feedTiming(), stamps = [];
  const read = async (t, signal) => { events.push('seek'); await fakeSeek(video, t, signal); return video.frameTime(t); };
  const feed = frameFeed(grab, (pixels, t) => { stamps.push(t); return post(pixels, t); }, timing);
  const done = [];
  await feed.seek({ read, fps: 30, end: 5 / 30 }, schedule, 0, undefined, i => done.push(i));
  assert.deepEqual(stamps.map(t => Math.round(t * 30)), [0, 2, 3, 4]);
  assert.deepEqual(done, [1, 2, 3, 4, 5]);
  assert.deepEqual([timing.sent, timing.distinctFrames, timing.unverified, timing.duplicatesBeforeRetry, timing.duplicatesAfterRetry, timing.peakResidentFrames], [4, 4, 0, 1, 1, 1]);
  // Each post finishes before the next starts, and a seek runs while it is in flight.
  const posts = events.map((e, i) => [e, i]).filter(([e]) => e.startsWith('post'));
  for (const [e, i] of posts.slice(0, -1)) assert.ok(events.indexOf(e.replace('post', 'done')) > events.indexOf('seek', i), `${e} overlaps a seek`);
  for (let k = 1; k < posts.length; k++) assert.ok(events.indexOf(posts[k - 1][0].replace('post', 'done')) < posts[k][1]);
  // Cancel stops the loop at the next frame, even when read itself ignores the signal.
  const controller = new AbortController(), cut = [];
  const stopping = frameFeed(grab, (pixels, t) => { cut.push(t); controller.abort(); return Promise.resolve(); }, feedTiming());
  await assert.rejects(stopping.seek({ read: async t => video.frameTime(t), fps: 30, end: 5 / 30 }, schedule, 0, controller.signal), { name: 'AbortError' });
  assert.equal(cut.length, 1);
});

test('frameFeed without a clock stamps scheduled times and drops a frame whose pixels repeat the last one', async () => {
  const { video, grab, post, schedule } = lateClip(), timing = feedTiming(), stamps = [];
  const read = async (t, signal) => { await fakeSeek(video, t, signal); return null; };
  const feed = frameFeed(grab, (pixels, t) => { stamps.push(t); return post(pixels, t); }, timing);
  await feed.seek({ read, fps: 30, end: 5 / 30 }, schedule, 0);
  assert.deepEqual(stamps, [0, 2, 3, 4].map(i => schedule[i].pts));
  assert.deepEqual([timing.sent, timing.unverified, timing.repeatsDropped, timing.distinctFrames], [4, 4, 1, null]);
  // Playback queues frames before sending them: they all count as resident.
  const queuedTiming = feedTiming(), queued = frameFeed(grab, post, queuedTiming), samples = [];
  for (const t of [0, 2 / 30, 3 / 30]) { video.currentTime = t; samples.push(queued.take(t, false)); }
  for (const s of samples) await queued.send(s);
  assert.deepEqual([queuedTiming.peakResidentFrames, queuedTiming.sent, queued.prevT], [3, 3, 3 / 30]);
});

test('frameHash matches only identical frames', () => {
  const a = new Uint8ClampedArray(64 * 48 * 4).fill(90);
  assert.equal(frameHash(a), frameHash(a.slice()));
  // Any single pixel counts: a ball is a handful of pixels.
  for (const at of [0, 1941, 64 * 48 - 1]) {
    const b = a.slice();
    b[at * 4 + 1] = 91;
    assert.notEqual(frameHash(a), frameHash(b), `pixel ${at}`);
  }
  assert.notEqual(frameHash(new Uint8ClampedArray(16)), frameHash(new Uint8ClampedArray(16).fill(1)));
});

test('pickEngine takes hf only where told to (the app): by default it names the frame-fed engines', () => {
  assert.deepEqual([ENGINES, FRAME_ENGINES, DEFAULT_ENGINE], [['v2', 'legacy', 'hf'], ['v2', 'legacy'], 'v2']);
  assert.equal(pickEngine('hf', ENGINES), 'hf');
  for (const v of [undefined, null, '']) assert.equal(pickEngine(v, ENGINES), 'v2');
  assert.equal(pickEngine('legacy', FRAME_ENGINES), 'legacy');
  // A caller that names no list (the offline harness, inspect-video.mjs) gets an error for hf, never a legacy run.
  for (const allowed of [undefined, FRAME_ENGINES]) assert.throws(() => pickEngine('hf', allowed), /^Error: Tracking engine "hf" cannot run here\. Use v2 or legacy\.$/);
  assert.throws(() => pickEngine('bogus'), /^Error: Unknown tracking engine "bogus"\. Use v2 or legacy\.$/);
  assert.throws(() => pickEngine('bogus', ENGINES), /^Error: Unknown tracking engine "bogus"\. Use v2, legacy or hf\.$/);
});

test('snapSourceFps takes a fallback rate; frameCentre is the middle of a frame\'s display interval', () => {
  assert.equal(snapSourceFps(NaN, 25), 25);
  assert.equal(snapSourceFps(0, 24), 24);
  assert.equal(snapSourceFps(29.98, 25), 29.97);
  const times = [0, 0.04, 0.07, 0.1];
  assert.ok(close(frameCentre(times, 0, 30), 0.02));
  assert.ok(close(frameCentre(times, 2, 30), 0.085));
  assert.ok(close(frameCentre(times, 3, 30), 0.1 + 1 / 60));
});

test('presentedFrameReader and probeSourceFps run on injected globals (timers, visibility) and fall back to a given rate', async () => {
  const waits = [], env = { document: { hidden: false }, setTimeout: (fn, ms, ...a) => { waits.push(ms); return setTimeout(fn, ms, ...a); }, clearTimeout };
  const video = new FakeVideo({ presentOnSeek: 'never' });
  assert.equal(await presentedFrameReader(video, fakeSeek, { ms: 25, env })(0.1), null);
  assert.deepEqual(waits, [25], 'the injected clock bounds the wait');
  // Hidden by the injected document (the real one does not exist here): seek only, no rVFC.
  const hiddenEnv = { ...env, document: { hidden: true } }, shown = new FakeVideo();
  assert.equal(await presentedFrameReader(shown, fakeSeek, { env: hiddenEnv })(0.2), null);
  assert.deepEqual([shown.requests, shown.seeks], [0, 1]);
  assert.deepEqual(await probeSourceFps(new FakeVideo(), fakeSeek, undefined, { env: hiddenEnv, fallback: 25 }), { fps: 25, measured: false });
  assert.deepEqual(await probeSourceFps(new FakeVideo({ rvfc: false }), fakeSeek, undefined, { fallback: 24 }), { fps: 24, measured: false });
  // A measurable clip on the injected clock: the playback windows are timed by it too.
  waits.length = 0;
  assert.deepEqual(await probeSourceFps(new FakeVideo({ fps: 60 }), fakeSeek, undefined, { env }), { fps: 60, measured: true });
  assert.ok(waits.includes(1600) && waits.includes(600), `playback windows ${waits}`);
});
