/**
 * Offline MotionTracker runner on FFmpeg-decoded RGBA frames. Mirrors the browser analysis:
 * autorotated upright frames, long edge <= 1280, and the browser's source-frame schedule
 * (sourceFrameSchedule in dist/frame-source.js) from the first frame to just past the last, at the
 * rate the browser measures (sourceRate, over packet times instead of seeks).
 * Frames are decoded at their native rate (no fps filter) on the container's own clock, which is
 * the browser's (a clip whose first frame starts at 0.2 s keeps it there), and each selected frame
 * is fed with its own presentation time.
 */
import { spawn } from 'node:child_process';
import { MotionTracker } from '../../dist/tracker.js';
import { DEFAULT_ENGINE, pickEngine, snapSourceFps, sourceFrameSchedule, sourceRate } from '../../dist/frame-source.js';

/** The engine the app ships by default. */
export { DEFAULT_ENGINE };

/**
 * The source rate the browser measures (sourceRate in dist/frame-source.js), from the sorted frame
 * start times: the frame shown at t is the last one starting at or before it.
 */
export function packetRate(pts, sampleFps = 30) {
  const framesFrom = async (t, n) => {
    let k = 0;
    while (k + 1 < pts.length && pts[k + 1] <= t) k++;
    return pts.slice(k, k + n);
  };
  return sourceRate(framesFrom, pts[0], pts.at(-1), { sampleFps });
}

export function analysisSize(sourceWidth, sourceHeight, longEdge = 1280) {
  const scale = Math.min(1, longEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale)),
    scale
  };
}

const rate = r => { const [n, d = 1] = String(r || '0/1').split('/').map(Number); return d ? n / d || 0 : 0; };

/** Probe display-oriented size (FFmpeg applies rotation for filters). */
export async function probeVideo(input, { sampleFps = 30 } = {}) {
  const raw = await runCapture('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,codec_name:format=duration,start_time',
    '-of', 'json',
    input
  ]);
  const json = JSON.parse(raw);
  const stream = json.streams?.[0] || {};
  const format = json.format || {};
  let width = Number(stream.width) || 0;
  let height = Number(stream.height) || 0;
  let rotation = 0;
  try {
    const rotRaw = await runCapture('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream_side_data=rotation',
      '-of', 'csv=p=0', input
    ]);
    const parsed = Number(String(rotRaw).trim().split('\n').filter(Boolean).pop());
    if (Number.isFinite(parsed)) rotation = parsed;
  } catch { /* no display matrix */ }
  // Display matrix ±90 swaps axes for browser-equivalent upright geometry.
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
    [width, height] = [height, width];
  }
  const avgFps = rate(stream.avg_frame_rate), rFps = rate(stream.r_frame_rate);
  // Every shown video packet (demux only; edit-list discards dropped) in presentation order, on the
  // container clock: the first frame, the rate the browser measures and the last frame.
  let pts = [];
  try {
    const packets = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input]);
    pts = packets.split('\n').map(line => line.split(','))
      .filter(([p, flags = '']) => p && p !== 'N/A' && !flags.includes('D'))
      .map(([p]) => Number(p)).filter(Number.isFinite).sort((a, b) => a - b);
  } catch { /* fall back to the stream rate */ }
  const rawFps = await packetRate(pts, sampleFps) || avgFps || rFps, startTime = Number(format.start_time) || 0;
  return {
    width,
    height,
    duration: Number(format.duration) || Number(stream.duration) || 0,
    codec: stream.codec_name || null,
    avgFps,
    rFps,
    rawFps,
    sourceFps: snapSourceFps(rawFps),
    startTime,
    firstFrameT: pts.length ? pts[0] : startTime,
    lastFrameT: pts.length ? pts.at(-1) : null,
    frames: Number(stream.nb_frames) || null,
    rotation
  };
}

/** The browser's analysis span: the first frame to just past the last (Chrome extends duration to reach it). */
export function analysisSpan(meta, sourceFps) {
  return { start: meta.firstFrameT ?? 0, end: Math.max(meta.duration || 0, (meta.lastFrameT ?? -Infinity) + 1 / sourceFps) };
}

/**
 * Browser-equivalent frame picking (readSample in dist/frame-source.js). A seek to target t shows
 * the last decoded frame with pts <= t (the first frame if t precedes it). If that frame was
 * already fed, the browser seeks once more, `nudge` seconds later (capped at maxT), and drops the
 * sample if the frame still has not changed.
 * push() takes decoded frames in presentation order ({ n, pts, ... }) and returns the frames to
 * feed now; end() flushes the remaining targets.
 */
export function createFrameSelector(schedule, { nudge = 0, maxT = Infinity } = {}) {
  let j = 0, last = -1;
  const buf = [];
  const shown = t => buf.reduce((f, g) => (g.pts <= t ? g : f), buf[0]);
  // A frame followed by one still at or before the next target can never be shown again.
  const prune = () => { while (j < schedule.length && buf.length > 1 && buf[1].pts <= schedule[j].t) buf.shift(); };
  const drain = final => {
    const out = [];
    for (prune(); j < schedule.length; j++, prune()) {
      const t = schedule[j].t, retry = Math.min(maxT, t + nudge);
      // Wait until the frame on screen at the retry time is known.
      if (!final && !(buf.at(-1).pts > Math.max(t, retry))) break;
      let f = shown(t);
      if (f.n === last) f = shown(retry);
      if (f.n !== last) { out.push(f); last = f.n; }
    }
    return out;
  };
  return {
    push(frame) { buf.push(frame); return drain(false); },
    end() { return buf.length ? drain(true) : []; }
  };
}

const SHOWINFO = /\bn:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+)/;

export async function runTrackerOffline(input, {
  fps = 30,
  sampleFps = fps,
  sourceFps = null,
  longEdge = 1280,
  width = null,
  height = null,
  engine = DEFAULT_ENGINE,
  onProgress = null,
  onFrame = null
} = {}) {
  // The app's engine names: v2 or legacy (an unknown name throws, never runs another engine).
  engine = pickEngine(engine);
  const meta = await probeVideo(input, { sampleFps });
  const srcFps = sourceFps || meta.sourceFps, { start, end } = analysisSpan(meta, srcFps);
  const schedule = sourceFrameSchedule(end, srcFps, sampleFps, start);
  if (!schedule.length) throw new Error(`No frames to sample (${start}-${end} s at ${srcFps} fps)`);
  // Prefer an explicit size; otherwise match browser analysis sizing on upright geometry.
  const sized = (width && height)
    ? { width, height, scale: width / meta.width }
    : analysisSize(meta.width, meta.height, longEdge);
  const w = sized.width, h = sized.height;
  const tracker = new MotionTracker(w, h, { engine });
  const frameSize = w * h * 4;
  // Native rate (passthrough: nothing dropped or duplicated); showinfo logs each frame's pts, and
  // -copyts keeps them on the container clock instead of shifting the first frame to 0.
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-nostats', '-loglevel', 'info',
    '-copyts', '-i', input,
    '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough',
    '-vf', `scale=${w}:${h},showinfo`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ptsByN = [], logTail = [];
  let partial = '', stderrDone = false, waiter = null;
  const wake = () => { const w = waiter; waiter = null; w?.(); };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      const m = SHOWINFO.exec(line);
      if (m) ptsByN[Number(m[1])] = Number(m[2]);
      else if (line.trim() && !line.includes('Parsed_showinfo')) {
        logTail.push(line.trim());
        if (logTail.length > 8) logTail.shift();
      }
    }
    wake();
  });
  proc.stderr.on('end', () => { stderrDone = true; wake(); });
  const closed = new Promise((resolve, reject) => { proc.on('close', resolve); proc.on('error', reject); });
  closed.catch(() => {});
  const ptsFor = async n => {
    while (ptsByN[n] === undefined && !stderrDone) await new Promise(r => { waiter = r; });
    return ptsByN[n];
  };

  const select = createFrameSelector(schedule, { nudge: 0.25 / srcFps, maxT: end - 1e-3 });
  const fed = [];
  let decoded = 0, counted = 0;
  const feed = frames => {
    for (const f of frames) {
      const pixels = new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, frameSize);
      tracker.detect(pixels, f.pts);
      fed.push({ frame: f.n, pts: f.pts });
      onFrame?.({ pixels, t: f.pts, frame: f.n, width: w, height: h });
      if (onProgress && fed.length % 30 === 0) onProgress({ index: fed.length, t: f.pts });
    }
  };

  const started = performance.now();
  let buf = Buffer.allocUnsafe(frameSize), fill = 0;
  for await (const chunk of proc.stdout) {
    for (let off = 0; off < chunk.length;) {
      const n = Math.min(frameSize - fill, chunk.length - off);
      chunk.copy(buf, fill, off, off + n);
      fill += n; off += n;
      if (fill < frameSize) continue;
      let pts = await ptsFor(decoded);
      // Without a logged pts, fall back to frame counting at the source rate.
      if (!Number.isFinite(pts)) { pts = start + decoded / srcFps; counted++; }
      feed(select.push({ n: decoded++, pts, data: buf }));
      buf = Buffer.allocUnsafe(frameSize); fill = 0;
    }
  }
  feed(select.end());
  const code = await closed;
  if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${logTail.join(' / ') || 'no stderr'}`);
  if (!decoded) throw new Error(`ffmpeg decoded no frames: ${logTail.join(' / ')}`);
  const result = tracker.result();
  const elapsedMs = performance.now() - started;
  const warnings = [];
  if (counted) warnings.push(`${counted}/${decoded} frames had no showinfo pts; used frame counting`);
  if (ptsByN.length !== decoded) warnings.push(`showinfo logged ${ptsByN.length} frames, ffmpeg emitted ${decoded}`);
  return {
    engine: tracker.engine === 'v2' ? 'v2' : 'legacy',
    meta: { ...meta, analysisWidth: w, analysisHeight: h, sampleFps, sourceFps: srcFps, start, end },
    result,
    frameCount: fed.length,
    sampling: {
      rule: 'sourceFrameSchedule',
      sourceFps: srcFps,
      sampleFps,
      start,
      end,
      scheduled: schedule.length,
      decoded,
      fed: fed.length,
      ptsSource: counted ? (counted === decoded ? 'frame-count' : 'mixed') : 'showinfo',
      warnings
    },
    fed,
    elapsedMs,
    competingTracks: (tracker.tracks || []).slice(0, 20).map(track => ({
      count: track.points.length,
      score: track.score,
      anchor: track.anchor,
      first: track.points[0] && {
        t: track.points[0].t,
        x: track.points[0].x / w,
        y: track.points[0].y / h
      },
      last: track.points.at(-1) && {
        t: track.points.at(-1).t,
        x: track.points.at(-1).x / w,
        y: track.points.at(-1).y / h
      }
    })),
    bestScore: tracker.best?.score ?? null
  };
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (${code}): ${err.trim()}`));
    });
  });
}
