// FrameSource over ffmpeg for Node tests and the bench (U1 contract; meta.path 'node'). Frame list and times
// come from ffprobe packets (discarded pre-roll dropped), so they equal the browser demuxer's; every decoded
// frame is checked against its showinfo pts (-copyts keeps the container timeline). Pixels: ffmpeg autorotates to
// display orientation and extractplanes=y hands over the raw Y plane. It is kept raw: lumaCoarse / lumaRect map it
// through the same lookup table as the WebCodecs path (10/12-bit shift, limited-range expansion) inside the fused
// planes.js kernels (poolPlane / cropPlane, bit-exact with poolLuma / cropLuma of the converted plane), so a frame
// nobody reads costs no conversion and frames equal the codec path's bit for bit. Crops whose footprint is over
// FULL_FRAC of the frame (the codec path's full-copy rule) convert the whole plane once for that frame instead, so
// several large crops of one frame pay one table pass. next() closes the previous FrameRef at once (before any byte
// of the next frame is read), so one raw buffer and one converted buffer serve the single live FrameRef.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HFError, throwIfAborted, makeSourceMeta, timingFromTimes, poolLuma, cropLuma, coarsePool } from '../../../dist/hf/types.js';
import { lumaLut, poolPlane, cropPlane, cropFootprint } from '../../../dist/hf/decode/planes.js';

const FULL_FRAC = 0.25;
const DEFAULT_FFMPEG = process.env.FFMPEG ?? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => existsSync(p)) ?? 'ffmpeg';
const probeName = ff => ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
let available = null;

/** True when ffmpeg and ffprobe run; tests skip otherwise. */
export function hasFfmpeg() {
  if (available === null) available = [DEFAULT_FFMPEG, process.env.FFPROBE ?? probeName(DEFAULT_FFMPEG)].every(p => spawnSync(p, ['-version'], { stdio: 'ignore' }).status === 0);
  return available;
}

/** High-bit-depth samples above the table (not produced by valid streams) clamp to its last entry, in place. */
function clamp16(s, max) { for (let i = 0; i < s.length; i++) if (s[i] > max) s[i] = max; return s; }

const execJson = (cmd, args, signal) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 1 << 28, signal }, (err, out) => {
    if (err) reject(err.name === 'AbortError' ? err : new HFError('unsupported', `${cmd}: ${err.message.slice(0, 300)}`));
    else { try { resolve(JSON.parse(out)); } catch (e) { reject(new HFError('internal', `ffprobe output: ${e.message}`)); } }
  });
});
/**
 * @param {string} path
 * @param {{ffmpeg?:string, ffprobe?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<import('../../../dist/hf/types.js').FrameSource>}
 */
export async function openNodeSource(path, { ffmpeg = DEFAULT_FFMPEG, ffprobe, signal } = {}) {
  ffprobe ??= process.env.FFPROBE ?? probeName(ffmpeg);
  throwIfAborted(signal);
  const j = await execJson(ffprobe, ['-v', 'error', '-show_entries',
    'format=start_time:stream=index,codec_type,codec_name,width,height,pix_fmt,color_range,time_base:stream_side_data=rotation:packet=stream_index,pts,flags',
    '-of', 'json', path], signal);
  const v = j.streams?.find(s => s.codec_type === 'video');
  if (!v) throw new HFError('no-video', `${path}: no video stream`);
  const [tbNum, tbDen] = String(v.time_base).split('/').map(Number);
  const pts = j.packets.filter(p => p.stream_index === v.index && !p.flags.includes('D') && p.pts !== undefined).map(p => Number(p.pts)).sort((a, b) => a - b);
  const ticks = pts.filter((p, i) => !i || p > pts[i - 1]);
  if (!ticks.length) throw new HFError('no-video', `${path}: no video frames`);
  const times = Float64Array.from(ticks, p => p * tbNum / tbDen);
  const ccw = Number(v.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0), rotation = (((-ccw) % 360) + 360) % 360;
  if (rotation % 90) throw new HFError('unsupported', `rotation ${ccw}`);
  const pix = v.pix_fmt ?? '';
  if (!/^(yuv|yuvj|nv|gray)/.test(pix)) throw new HFError('unsupported', `pixel format ${pix}`);
  const bits = /p1[02]/.test(pix) ? Number(pix.match(/p(1[02])/)[1]) : 8;
  const limited = !(v.color_range === 'pc' || pix.startsWith('yuvj'));
  const lut = lumaLut(bits, limited), W = rotation % 180 ? v.height : v.width, H = rotation % 180 ? v.width : v.height;
  const timing = timingFromTimes(times), start = Number(j.format?.start_time) || 0;
  const meta = makeSourceMeta({
    width: W, height: H, codedWidth: v.width, codedHeight: v.height, rotation, fps: timing.fps, vfr: timing.vfr,
    frameCount: times.length, times, duration: timing.duration, path: 'node', hasAudio: j.streams.some(s => s.codec_type === 'audio')
  });
  const index = new Map(ticks.map((p, k) => [p, k]));
  let busy = false, closed = false;

  // raw: the display-orientation Y samples as ffmpeg wrote them (Uint8Array, or Uint16Array for 10/12-bit).
  let conv = null;   // the converted plane of the live FrameRef, when a large crop asked for it
  const frameRef = (k, raw) => {
    let open = true, full = lut ? null : raw;
    const live = () => { if (!open) throw new HFError('closed', `frame ${k} is closed`); };
    const converted = () => {
      if (full) return full;
      const c = conv ??= new Uint8Array(W * H);
      for (let i = 0; i < c.length; i++) c[i] = lut[raw[i]];
      return (full = c);
    };
    return {
      index: k, t: times[k],
      async lumaCoarse(longEdge, out) {
        live();
        const pool = coarsePool(W, H, longEdge);
        return full ? poolLuma(full, W, H, pool, out) : poolPlane(raw, W, H, W, 0, pool, lut, out);
      },
      async lumaRect(rect, { pool = 1, out } = {}) {
        live();
        if (full) return cropLuma(full, W, H, rect, pool, out);
        const f = cropFootprint(rect, W, H, pool);
        return f.w * f.h > FULL_FRAC * W * H ? cropLuma(converted(), W, H, rect, pool, out) : cropPlane(raw, W, H, W, 0, 0, W, H, 0, rect, pool, lut, out);
      },
      close() { open = false; }
    };
  };

  // One ffmpeg run from (just before) frame `first`. Yields [index, plane] for decoded frames with want(index);
  // others are skipped before conversion.
  async function* decode(first, want, signal) {
    const ss = first > 0 ? Math.max(0, times[first] - start - 0.5 / timing.fps) : 0;
    const bytes = W * H * (bits > 8 ? 2 : 1);
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-copyts', ...(ss > 0 ? ['-ss', ss.toFixed(6)] : []), '-i', path,
      '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'extractplanes=y,showinfo=checksum=0', '-f', 'rawvideo', '-pix_fmt', bits > 8 ? `gray${bits}le` : 'gray', 'pipe:1'];
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [], waiters = [];
    let err = '', partial = '', exited = null;
    const kick = () => { while (waiters.length) waiters.shift()(); };
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', d => {
      partial += d;
      const parts = partial.split('\n'); partial = parts.pop();
      for (const l of parts) { const m = / n: *\d+ pts: *(-?\d+)/.exec(l); if (m) lines.push(Number(m[1])); else if (!/Parsed_showinfo/.test(l)) err = (err + l + '\n').slice(-2000); }
      kick();
    });
    p.on('close', code => { exited = code ?? -1; kick(); });
    p.on('error', e => { err += e.message; exited = -1; kick(); });
    const ptsOf = async n => { while (lines.length <= n && exited === null) await new Promise(r => waiters.push(r)); return lines[n]; };
    try {
      // One buffer: it is refilled only after the consumer called next(), which closed the FrameRef reading it.
      const raw = new Uint8Array(bytes);
      let n = 0, fill = 0;
      for await (const chunk of p.stdout) {
        throwIfAborted(signal);
        for (let o = 0; o < chunk.length;) {
          const take = Math.min(bytes - fill, chunk.length - o);
          raw.set(chunk.subarray(o, o + take), fill);
          fill += take; o += take;
          if (fill < bytes) continue;
          fill = 0;
          throwIfAborted(signal);
          const tick = await ptsOf(n++), k = index.get(tick);
          if (k === undefined) throw new HFError('decode', `${path}: decoded frame pts ${tick} is not in the packet list`);
          if (!want(k)) continue;
          yield [k, bits > 8 ? clamp16(new Uint16Array(raw.buffer, raw.byteOffset, W * H), lut.length - 1) : raw];
        }
      }
      while (exited === null) await new Promise(r => waiters.push(r));
      if (exited !== 0) throw new HFError('decode', `${path}: ffmpeg exited ${exited}: ${err.trim().slice(-400)}`);
    } finally {
      if (exited === null) p.kill('SIGKILL');
    }
  }

  async function* iterate({ from = 0, to = times.length, stride = 1, signal } = {}) {
    if (closed) throw new HFError('closed', 'source is closed');
    if (!(Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(stride) && stride > 0)) throw new HFError('bad-arg', `frames({from:${from}, to:${to}, stride:${stride}})`);
    if (busy) throw new HFError('busy', 'another frames() iteration is live');
    busy = true;
    const a = Math.min(Math.max(from, 0), times.length), b = Math.min(Math.max(to, 0), times.length);
    let ref = null, it = null, next = a;
    try {
      // A seek that lands after `from` (it should not) falls back to decoding from the start once.
      for (let attempt = 0; attempt < 2 && next < b; attempt++) {
        it = decode(attempt ? 0 : a, k => k >= next, signal);
        for await (const [k, plane] of it) {
          throwIfAborted(signal);
          if (closed) throw new HFError('closed', 'source is closed');
          if (k !== next) {
            if (attempt === 0 && next === a) break;
            throw new HFError('decode', `${path}: frame ${next} missing (decoder gave ${k})`);
          }
          ref = frameRef(k, plane);
          yield ref;
          ref.close(); ref = null;   // next() closes the previous FrameRef (contract), before decoding on
          next += stride;
          if (next >= b) break;
        }
        await it.return();
        if (next > a && next < b) throw new HFError('decode', `${path}: decoding stopped before frame ${next}`);
      }
      if (next < b) throw new HFError('decode', `${path}: frame ${next} was never decoded`);
    } finally {
      ref?.close();
      await it?.return();
      busy = false;
    }
  }
  return { meta, frames: iterate, async close() { closed = true; } };
}
