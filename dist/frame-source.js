/**
 * Analysis frame timing: the clip's frame clock (the start time of the frame a seek shows), its
 * frame rate and span, which source frames to sample, and the feed that hands each one on once.
 */

// Tracking engine names: the UI's ?engine= picks any (ENGINES); the frame-fed MotionTracker (worker init, QA pages,
// the offline harness) runs v2 and legacy only, so that is the default list: hf never runs as legacy by omission.
export const ENGINES = ['v2', 'legacy', 'hf'], FRAME_ENGINES = ['v2', 'legacy'], DEFAULT_ENGINE = 'v2';

const either = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
/** Tracking engine name out of `allowed`: empty means the default; any other name throws instead of silently picking one. */
export function pickEngine(name, allowed = FRAME_ENGINES) {
  if (name == null || name === '') return DEFAULT_ENGINE;
  if (!allowed.includes(name)) throw new Error(`${ENGINES.includes(name) ? `Tracking engine "${name}" cannot run here` : `Unknown tracking engine "${name}"`}. Use ${either(allowed)}.`);
  return name;
}

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240];

/** Snap a measured frame rate to the nearest common rate within 3%, else round to 0.01; `fallback` for unusable input. */
export function snapSourceFps(rawFps, fallback = 30) {
  if (!Number.isFinite(rawFps) || rawFps <= 0) return fallback;
  const near = COMMON_FPS.reduce((a, b) => Math.abs(b - rawFps) < Math.abs(a - rawFps) ? b : a);
  return Math.abs(near - rawFps) <= near * 0.03 ? near : Math.round(rawFps * 100) / 100;
}

// Seek phase for a guessed 30 fps: at least 1.6 ms from every frame boundary at 24-240 fps.
export const UNMEASURED_PHASE = .45;
// Analysis samples at most this many source frames per second.
const SAMPLE_FPS = 30;

/**
 * One entry per distinct source frame hit by a sampleFps grid over frames that start at `start` and
 * end at `end`: index, pts (frame start) and t (the seek target, `phase` of the way into the frame,
 * kept inside the clip).
 */
export function sourceFrameSchedule(end, sourceFps, sampleFps = 30, start = 0, phase = .5) {
  const span = end - start;
  if (!(span > 0) || !(sourceFps > 0) || !(sampleFps > 0)) return [];
  // Clip ends read from microsecond timestamps land a hair past whole frames: no extra sample (or frame) for that.
  const samples = Math.ceil(span * sampleFps - 1e-3), out = [];
  for (let i = 0; i < samples; i++) {
    const index = Math.floor((i / sampleFps) * sourceFps + 1e-6);
    if (out.length && out.at(-1).index === index) continue;
    out.push({ index, pts: start + index / sourceFps, t: Math.min(end - 1e-3, start + (index + phase) / sourceFps) });
  }
  return out;
}

/** Seek target for frame k of a clip with known frame times: the centre of its display interval. */
export function frameCentre(times, k, fps) {
  return k + 1 < times.length ? (times[k] + times[k + 1]) / 2 : times[k] + 0.5 / fps;
}

/** The source frames analysis samples: frame centres at a measured rate, else a phase off every common frame boundary. */
export const analysisSchedule = (clip, sampleFps = SAMPLE_FPS) => sourceFrameSchedule(clip.end, clip.fps, sampleFps, clip.start, clip.measured ? .5 : UNMEASURED_PHASE);

const median = values => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** Median interval of increasing frame start times; null for fewer than two. */
export const medianInterval = starts => median(starts.slice(1).map((s, i) => s - starts[i]).filter(d => d > 0));

// Besides the first frames, a rate slower than the sample rate is re-measured over SPOT_FRAMES frames
// at these fractions of the clip (first frame to last), off round times.
const RATE_SPOTS = [1 / 3, 2 / 3], SPOT_FRAMES = 6, SPOT_OFFSET = 3.7e-4;
const slowerThan = (interval, sampleFps) => snapSourceFps(1 / interval) < .97 * sampleFps;

/**
 * Source frame rate (frames per second, unsnapped), one rule for the browser's seeks and the offline
 * runner's packet times: the median interval of the first `count` frames. When that is slower than
 * sampleFps, 6 frames a third and two thirds into the clip are measured too and the fastest stretch
 * wins, so a clip that starts slow (or holds its first frame) is not undersampled once it speeds up.
 * framesFrom(t, n) resolves the starts of up to n consecutive frames from the one shown at t, or null.
 */
export async function sourceRate(framesFrom, start, last, { count = 12, sampleFps = SAMPLE_FPS } = {}) {
  const head = await framesFrom(start, count);
  let interval = head && medianInterval(head);
  if (!interval) return null;
  if (slowerThan(interval, sampleFps)) {
    for (const f of RATE_SPOTS) {
      const t = start + f * (last - start) + SPOT_OFFSET;
      if (t <= head.at(-1)) continue;
      const frames = await framesFrom(t, SPOT_FRAMES), d = frames && medianInterval(frames);
      if (d) interval = Math.min(interval, d);
    }
  }
  return 1 / interval;
}

/** Median per-frame interval of presented rVFC metadata; callbacks missed between presentations are divided out. */
export function medianFrameInterval(frames) {
  const d = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i], n = b.presentedFrames - a.presentedFrames;
    const dt = (b.mediaTime - a.mediaTime) / (n >= 1 ? n : 1);
    if (dt > 0) d.push(dt);
  }
  return median(d);
}

const hasFrameCallback = video => typeof video?.requestVideoFrameCallback === 'function';
// env: the globals to use (document for visibility, setTimeout, clearTimeout); tests and the hf element source inject them.
const hidden = (env = globalThis) => !!env.document?.hidden;
const same = (a, b) => Math.abs(a - b) < 1e-6;
const isTime = v => Number.isFinite(v) && v >= 0;

/** Start time (s) of the frame the element shows now, from a WebCodecs VideoFrame; null if unavailable. */
export function shownFrameTime(video) {
  if (typeof VideoFrame !== 'function') return null;
  let frame = null;
  try { frame = new VideoFrame(video); return frame.timestamp / 1e6; } catch { return null; } finally { frame?.close(); }
}

/**
 * seekFrame(t, signal) seeks (seek(video, t, signal)) and resolves with the presented frame's rVFC
 * metadata, or null when rVFC is missing, the page is hidden (no rendering), or no frame arrives
 * within ms. After maxMisses consecutive misses it stops waiting for this clip.
 */
export function presentedFrameReader(video, seek, { ms = 200, maxMisses = 3, env = globalThis } = {}) {
  let misses = 0;
  return async (t, signal) => {
    if (!hasFrameCallback(video) || misses >= maxMisses || hidden(env)) { await seek(video, t, signal); return null; }
    let handle, timer;
    // Registered before the seek: Chrome sometimes presents the frame before 'seeked' fires.
    const presented = new Promise(resolve => { handle = video.requestVideoFrameCallback((now, md) => resolve(md)); });
    try {
      await seek(video, t, signal);
      const md = await Promise.race([presented, new Promise(resolve => { timer = env.setTimeout(resolve, ms, null); })]);
      misses = md ? 0 : misses + 1;
      return md;
    } finally { env.clearTimeout(timer); video.cancelVideoFrameCallback(handle); }
  };
}

/**
 * Clip timing from seeks alone: read(t, signal) seeks and resolves the start time of the frame then
 * shown. Returns the first frame's time, the rate (sourceRate) and the time just past the last
 * frame, or null when read is not a frame clock (no value, a constant, or an echo of the seek target).
 */
export async function seekFrameTiming(read, duration, signal, { count = 12, sampleFps = SAMPLE_FPS, maxSeeks = 160 } = {}) {
  let seeks = 0;
  // Probe targets avoid round times, so a real clock answers with the target itself only when a frame
  // starts right there (a rate that halves or doubles); a nudged second read tells that from an echo.
  const at = async t => {
    if (++seeks > maxSeeks) return NaN;
    const v = await read(t, signal);
    if (!isTime(v) || !same(v, t)) return isTime(v) ? v : NaN;
    if (++seeks > maxSeeks) return NaN;
    return same(await read(t + 1.9e-4, signal), v) ? v : NaN;
  };
  // Starts of up to n consecutive frames from the one starting at s; null when read is not a frame clock.
  const frames = async (s, n) => {
    const starts = [s];
    for (let step = .0519; starts.length < n;) {
      const p = starts.at(-1);
      let lo = p, hi = p + step, q = await at(hi);
      // Frame p lasts past the probe: look further, up to the clip end.
      while (same(q, p) && hi < Math.min(duration(), p + 1)) { lo = hi; q = await at(hi = p + 2 * (hi - p)); }
      if (same(q, p)) break;
      // Narrow to the first frame after p: the frame shown just before q starts must be p.
      for (let k = 0; ; k++) {
        if (!(q > p && q <= hi + 1e-4) || k > 12) return null;
        const b = await at(q - 4.7e-4);
        if (same(b, p)) break;
        if (!(b > p && b < q)) return null;
        hi = q - 4.7e-4; q = b;
        if (hi - lo > 4e-3) {
          const mid = (lo + hi) / 2, m = await at(mid);
          if (same(m, p)) lo = mid; else if (m > p && m <= q) { hi = mid; q = m; } else return null;
        }
      }
      starts.push(q);
      step = 1.5 * (q - p);
    }
    return starts;
  };
  // Just past 0: a seek to where the element already is presents no frame, so rVFC would never fire.
  const start = await read(1e-3, signal);
  if (!isTime(start)) return null;
  // Chrome extends duration once it has demuxed the last frames, so look again if it grew.
  let end = duration(), last = await read(end, signal);
  if (duration() > end + 1e-6) last = await read(end = duration(), signal);
  if (!(isTime(last) && last >= start)) return null;
  const rate = await sourceRate(async (t, n) => {
    const s = t === start ? start : await at(t);
    return isTime(s) ? frames(s, n) : null;
  }, start, last, { count, sampleFps });
  if (!rate) return null;
  const fps = snapSourceFps(rate);
  return { start, fps, measured: true, end: Math.max(duration(), last + 1 / fps) };
}

function playFrameTimes(video, rate, signal, { ms = 600, max = 12, env = globalThis } = {}) {
  return new Promise(resolve => {
    const out = [];
    let handle, timer, done = false;
    const finish = () => {
      if (done) return;
      done = true; env.clearTimeout(timer); video.cancelVideoFrameCallback(handle); signal?.removeEventListener('abort', finish);
      video.pause(); resolve(out);
    };
    const tick = (now, md) => {
      out.push({ mediaTime: md.mediaTime, presentedFrames: md.presentedFrames });
      if (out.length >= max) finish(); else handle = video.requestVideoFrameCallback(tick);
    };
    signal?.addEventListener('abort', finish, { once: true });
    handle = video.requestVideoFrameCallback(tick);
    video.playbackRate = rate;
    timer = env.setTimeout(finish, ms + 1000);
    Promise.resolve(video.play()).then(() => { if (!done) { env.clearTimeout(timer); timer = env.setTimeout(finish, ms); } }, finish);
  });
}

/**
 * Source frame rate from short muted playbacks (presented mediaTime deltas), by sourceRate's rule:
 * from 0, and when that is slower than sampleFps (or gives nothing) also from the rate spots, so a
 * held first frame or a slow start does not set the rate; the fastest stretch wins. Near display
 * rates the compositor skips frames, so fast stretches are re-checked at quarter speed. Restores
 * time, paused, muted and playbackRate. Falls back to `fallback` fps without rVFC or while the page is hidden.
 */
export async function probeSourceFps(video, seek, signal, { sampleFps = SAMPLE_FPS, env = globalThis, fallback = 30 } = {}) {
  if (!hasFrameCallback(video) || hidden(env)) return { fps: fallback, measured: false };
  const { currentTime, paused, muted, playbackRate } = video;
  let interval = null;
  const play = async (t, max) => {
    let d = null;
    for (const rate of [1, .25]) {
      await seek(video, t, signal);
      // The first callback can be the frame the seek showed, stamped with the seek target (Firefox): skip it.
      const r = medianFrameInterval((await playFrameTimes(video, rate, signal, { max: max + 1, env })).slice(1));
      if (r) d = Math.min(d ?? r, r);
      if (!r || 1 / r < 45) break;
    }
    return d;
  };
  video.muted = true;
  try {
    // Presented frames are noisier than a clock's, so every stretch gets 12 of them.
    interval = await play(0, 12);
    if (!interval || slowerThan(interval, sampleFps)) {
      for (const f of RATE_SPOTS) {
        const d = await play(f * video.duration + SPOT_OFFSET, 12);
        if (d) interval = Math.min(interval ?? d, d);
      }
    }
  } finally {
    video.pause(); video.playbackRate = playbackRate; video.muted = muted;
  }
  // Wait for the restored frame so a late presentation is not read as the first sample.
  await presentedFrameReader(video, seek, { env })(currentTime, signal);
  if (!paused) video.play().catch(() => {});
  return { fps: snapSourceFps(interval ? 1 / interval : NaN, fallback), measured: interval != null };
}

/**
 * Frame clock and timing for the loaded clip. A WebCodecs clock works hidden and without rVFC; an
 * rVFC clock needs a rendering tab, so whenVisible(signal) is awaited first. Without a frame-accurate
 * clock the rate comes from playback and samples are stamped from the schedule (read gives null).
 */
export async function measureFrameTiming(video, seek, signal, whenVisible = async () => {}) {
  const duration = () => video.duration, rvfc = hasFrameCallback(video), clocks = [];
  if (typeof VideoFrame === 'function') clocks.push(['videoframe', async (t, s) => { await seek(video, t, s); return shownFrameTime(video); }]);
  if (rvfc) { const reader = presentedFrameReader(video, seek); clocks.push(['rvfc', async (t, s) => (await reader(t, s))?.mediaTime ?? null]); }
  for (const [clock, read] of clocks) {
    if (clock === 'rvfc' && hidden()) await whenVisible(signal);
    const timing = await seekFrameTiming(read, duration, signal);
    if (timing) return { ...timing, clock, read };
  }
  if (rvfc && hidden()) await whenVisible(signal);
  const { fps, measured } = await probeSourceFps(video, seek, signal);
  // Seeking to the end lets the browser settle the duration; seeking to 0 shows the first frame's time.
  await seek(video, duration(), signal);
  await seek(video, 0, signal);
  return { fps, measured, start: video.currentTime || 0, end: duration(), clock: 'none', read: async (t, s) => { await seek(video, t, s); return null; } };
}

/**
 * Seek to a scheduled frame and stamp the sample with the shown frame's own time (the schedule's pts
 * when read has no clock). A repeat of the previous sample's frame is retried once a quarter frame
 * later, then dropped (null).
 */
export async function readSample(read, entry, prevT, fps, maxT, timing, signal) {
  let t = await read(entry.t, signal);
  if (!isTime(t)) return { t: entry.pts, verified: false };
  if (t <= prevT + 1e-6) {
    timing.duplicatesBeforeRetry++;
    t = await read(Math.min(maxT, entry.t + .25 / fps), signal);
    if (!(t > prevT + 1e-6)) { timing.duplicatesAfterRetry++; return null; }
  }
  return { t, verified: true };
}

/** FNV-1a over every pixel: without a frame clock, only a repeated frame matches the previous one. */
export function frameHash(pixels) {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
  return h >>> 0;
}

/**
 * Analysis frame pipeline: take() grabs the frame on screen (grab()), send() hands it to
 * post(pixels, t), which resolves when done; one post runs at a time. Each source frame goes out
 * once: a stamped sample is new by its clock (readSample retries, then drops, a repeat), and an
 * unstamped one whose pixels repeat the last frame sent is dropped. Counts into timing.
 */
export function frameFeed(grab, post, timing) {
  const times = new Set();
  let resident = 0, lastHash = null, pending = null;
  const feed = {
    prevT: -Infinity,
    take(t, verified) {
      timing.peakResidentFrames = Math.max(timing.peakResidentFrames, ++resident);
      return { pixels: grab(), t, verified };
    },
    send({ pixels, t, verified }) {
      resident--;
      const hash = verified ? null : frameHash(pixels);
      if (hash !== null && hash === lastHash) { timing.repeatsDropped++; return pending; }
      lastHash = hash; timing.sent++; feed.prevT = t;
      if (verified) times.add(t); else timing.unverified++;
      return pending = post(pixels, t);
    },
    /** Seeks schedule[from..] in order; the next seek overlaps the post of the frame before. */
    async seek(clip, schedule, from, signal, progress = () => {}) {
      for (let i = from; i < schedule.length; i++) {
        if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
        const sample = await readSample(clip.read, schedule[i], feed.prevT, clip.fps, clip.end - 1e-3, timing, signal);
        await pending;
        if (sample) feed.send(feed.take(sample.t, sample.verified));
        progress(i + 1);
      }
      await pending;
      // Distinct frames confirmed by the frame clock; samples without one are counted as unverified.
      timing.distinctFrames = times.size || null;
    }
  };
  return feed;
}
