/**
 * Offline MotionTracker runner using FFmpeg-decoded RGBA frames.
 * Matches the browser analysis path: fps=30, long-edge ≤1280, autorotated.
 */
import { spawn } from 'node:child_process';
import { MotionTracker } from '../../dist/tracker.js';

export function analysisSize(sourceWidth, sourceHeight, longEdge = 1280) {
  const scale = Math.min(1, longEdge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale)),
    scale
  };
}

/** Probe display-oriented size (FFmpeg applies rotation for filters). */
export async function probeVideo(input) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration',
    '-of', 'json',
    input
  ];
  const raw = await runCapture('ffprobe', args);
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
  const [num, den] = String(stream.avg_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  return {
    width,
    height,
    duration: Number(format.duration) || 0,
    codec: stream.codec_name || null,
    avgFps: fps,
    rotation
  };
}

export async function runTrackerOffline(input, {
  fps = 30,
  longEdge = 1280,
  width = null,
  height = null,
  engine = 'legacy',
  onProgress = null
} = {}) {
  if (engine !== 'legacy') {
    throw new Error(`Engine "${engine}" is not implemented yet; use --engine legacy for baseline.`);
  }
  const meta = await probeVideo(input);
  // Prefer an explicit size; otherwise match browser analysis sizing on upright geometry.
  const sized = (width && height)
    ? { width, height, scale: width / meta.width }
    : analysisSize(meta.width, meta.height, longEdge);
  const w = sized.width, h = sized.height;
  const tracker = new MotionTracker(w, h);
  const frameSize = w * h * 4;
  const vf = `fps=${fps},scale=${w}:${h}`;
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-vf', vf,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let pending = Buffer.alloc(0);
  let index = 0;
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });

  const started = performance.now();
  for await (const chunk of proc.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      const frame = pending.subarray(0, frameSize);
      const t = index / fps;
      tracker.detect(new Uint8ClampedArray(frame), t);
      pending = pending.subarray(frameSize);
      index++;
      if (onProgress && index % 30 === 0) onProgress({ index, t });
    }
  }
  const code = await new Promise(resolve => proc.on('close', resolve));
  if (code !== 0) {
    throw new Error(`ffmpeg failed (code ${code}): ${stderr.trim() || 'no stderr'}`);
  }
  const result = tracker.result();
  const elapsedMs = performance.now() - started;
  return {
    engine: 'legacy',
    meta: { ...meta, analysisWidth: w, analysisHeight: h, sampleFps: fps },
    result,
    frameCount: index,
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
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (${code}): ${err.trim()}`));
    });
  });
}
