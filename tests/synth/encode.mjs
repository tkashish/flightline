// ffmpeg encode (raw RGB on stdin with backpressure, exact PTS via setpts), rotation remux, probe and gray decode.
import { spawn, spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';

export const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = process.env.FFPROBE || FFMPEG.replace(/ffmpeg$/, 'ffprobe');
let version = null;
export const ffmpegVersion = () => (version ??= (spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout || '').split('\n')[0].trim());

const TRANSPOSE = { 0: null, 90: 'transpose=clock', '-90': 'transpose=cclock', 180: 'hflip,vflip' };
const BASE_MBPS = (w, h, fps) => { const px = w * h, k = px > 4e6 ? 40 : px > 1.5e6 ? 16 : 8; return k * (fps >= 240 ? 2.6 : fps >= 120 ? 1.9 : fps >= 60 ? 1.5 : 1); };

export function encodePlan(spec, timeline) {
  const e = spec.encode || {}, { W, H } = spec.format, rot = spec.format.rotation || 0, fps = timeline.fpsOut;
  const hevc = e.codec === 'hevc', mbps = (e.mbps ?? BASE_MBPS(W, H, fps) * (hevc ? 0.6 : 1) * (e.lowBitrate ? e.lowFactor ?? 0.2 : 1) * (e.rateK ?? 1));
  return { codec: hevc ? 'hevc' : 'h264', container: e.container || 'mp4', mbps: Math.round(mbps * 100) / 100, gop: e.gop ?? Math.round(fps * (e.gopS ?? 1)), bframes: e.bframes ?? (hevc ? 2 : 1), rotation: rot, preset: hevc ? 'superfast' : 'veryfast', captureFpsTag: e.captureFpsTag ? spec.capture.fps : null };
}

export function encoderArgs(spec, timeline, plan, { out, audio = null, threads = 1 }) {
  const { W, H } = spec.format, vf = [TRANSPOSE[plan.rotation], 'settb=1/90000', `setpts='${timeline.expr}'`, 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p'].filter(Boolean).join(',');
  const kb = Math.round(plan.mbps * 1000), v = plan.codec === 'hevc'
    ? ['-c:v', 'libx265', '-preset', plan.preset, '-tag:v', 'hvc1', '-b:v', `${kb}k`, '-x265-params', `pools=${threads}:frame-threads=${Math.min(2, threads)}:keyint=${plan.gop}:bframes=${plan.bframes}:vbv-maxrate=${Math.round(kb * 1.5)}:vbv-bufsize=${kb * 2}:log-level=error`]
    : ['-c:v', 'libx264', '-preset', plan.preset, '-profile:v', 'high', '-b:v', `${kb}k`, '-maxrate', `${Math.round(kb * 1.5)}k`, '-bufsize', `${kb * 2}k`, '-g', String(plan.gop), '-bf', String(plan.bframes), '-threads', String(threads)];
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-framerate', String(timeline.fpsOut), '-i', 'pipe:0'];
  if (audio) args.push('-i', audio);
  args.push('-map', '0:v:0'); if (audio) args.push('-map', '1:a:0');
  args.push('-vf', vf, '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-video_track_timescale', '90000', ...v,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
  if (plan.captureFpsTag) args.push('-metadata', `com.android.capture.fps=${plan.captureFpsTag}`);
  args.push('-movflags', `+faststart${plan.captureFpsTag ? '+use_metadata_tags' : ''}`, '-map_metadata', '-1', '-f', plan.container === 'mov' ? 'mov' : 'mp4', out);
  return args;
}

/** Streams frames into ffmpeg. Buffers are recycled only after their write has been flushed. */
export class Encoder {
  constructor(args, frameBytes) {
    this.p = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.err = ''; this.p.stderr.on('data', d => { this.err += d; });
    this.done = new Promise((res, rej) => { this.p.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${this.err.trim().slice(-800)}`)))); this.p.on('error', rej); });
    this.done.catch(() => {});
    this.free = []; this.bytes = frameBytes;
    this.p.stdin.on('error', () => {});
  }
  buffer() { return this.free.pop() || new Uint8ClampedArray(this.bytes); }
  async write(buf) {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!this.p.stdin.write(b, () => this.free.push(buf))) await Promise.race([new Promise(r => this.p.stdin.once('drain', r)), this.done]);
  }
  async end() { this.p.stdin.end(); await this.done; }
}

export function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed: ${(r.stderr || '').slice(-500)}`);
  return r.stdout;
}

export function remuxRotation(tmp, out, rotation) {
  if (!rotation) { renameSync(tmp, out); return; }
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-display_rotation', String(rotation), '-i', tmp, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out]);
}

/** Container-level truth: codec, coded size, rotation and every video packet's PTS in presentation order. */
export function probe(path) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,codec_tag_string,width,height,time_base,avg_frame_rate,nb_frames,sample_rate:stream_side_data=rotation:format=duration,format_name', '-of', 'json', path]));
  const v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio');
  const pk = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', path]).split('\n').filter(Boolean).map(Number).sort((x, y) => x - y);
  const [num, den] = v.time_base.split('/').map(Number);
  let rotation = Number(v.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0);
  if (rotation <= -180) rotation += 360;
  return { codec: v.codec_name, tag: v.codec_tag_string, codedWidth: v.width, codedHeight: v.height, rotation, timeBase: v.time_base, pts: pk, ptsSec: pk.map(p => p * num / den), audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate) } : null, format: j.format.format_name, duration: Number(j.format.duration) };
}

/** Decodes upright gray frames (autorotated like the browser) and calls fn(index, Uint8Array). */
export async function decodeGray(path, W, H, fn) {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const size = W * H; let buf = Buffer.alloc(size), fill = 0, k = 0, err = '';
  p.stderr.on('data', d => { err += d; });
  for await (const chunk of p.stdout) {
    for (let off = 0; off < chunk.length;) {
      const n = Math.min(size - fill, chunk.length - off); chunk.copy(buf, fill, off, off + n); fill += n; off += n;
      if (fill === size) { fn(k++, buf); fill = 0; }
    }
  }
  const code = await new Promise(r => p.on('close', r));
  if (code !== 0) throw new Error(`decode failed: ${err.slice(-400)}`);
  return k;
}
