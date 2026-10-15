// Barcode-indexed video fixtures for the U1 decode tests and the browser decode bench. Every frame shows its
// presentation index as a 16-bit barcode (plus a guard row that a mirror or wrong rotation breaks) in the top-left
// corner of the UPRIGHT display image; rotated fixtures encode the counter-rotated image and carry a display
// matrix, so a source that rotates correctly reads the barcode back. Files are cached in the OS temp dir, keyed by
// a hash of their spec, so parallel test files share them.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatePlane } from '../../../dist/hf/decode/planes.js';

const which = names => names.find(p => p && (p.includes('/') ? existsSync(p) : spawnSync(p, ['-version']).status === 0));
export const FFMPEG = which([process.env.FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']) ?? null;
export const FFPROBE = which([process.env.FFPROBE, FFMPEG?.replace(/ffmpeg$/, 'ffprobe'), 'ffprobe']) ?? null;
export const ffmpegOk = () => !!(FFMPEG && FFPROBE);

/* ---------------------------------------------------------------- barcode */

import { renderUpright } from './barcode.mjs';
export { BITS, blockPx, renderUpright, readBarcode, barcodeRect, fnv } from './barcode.mjs';

/* ---------------------------------------------------------------- ffmpeg */

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.slice(0, 8).join(' ')} … exited ${c}: ${err.slice(-600)}`))));
    if (input) input(p.stdin).then(() => p.stdin.end(), reject);
  });
}
const pipeFrames = (spec, W, H) => async stdin => {
  stdin.on('error', () => {});
  for (let k = 0; k < spec.frames; k++) {
    const up = renderUpright(k, spec.W, spec.H);
    const coded = spec.rotation ? rotatePlane(up, spec.W, spec.H, (360 - spec.rotation) % 360).data : up;
    if (coded.length !== W * H) throw new Error('fixture size');
    if (!stdin.write(coded)) await new Promise(r => stdin.once('drain', r));
  }
};

/**
 * Fixture specs. W × H is the UPRIGHT display size; rotation the clockwise display rotation of the coded image.
 * derive: build from another fixture (stream copy, rewrite) instead of encoding.
 */
export const SPECS = {
  'avc-bf': { W: 256, H: 144, fps: 30, frames: 48, audio: true, v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '3', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  'avc-60': { W: 192, H: 108, fps: 60, frames: 60, v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '2', '-g', '30', '-pix_fmt', 'yuv420p'] },
  'avc-240': { W: 128, H: 72, fps: 240, frames: 96, v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '2', '-g', '48', '-pix_fmt', 'yuv420p'] },
  'avc-vfr': { W: 192, H: 108, fps: 30, frames: 45, vf: 'settb=1/90000,setpts=(N+0.3*mod(N\\,3))/(30*TB)', v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '2', '-g', '15', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-video_track_timescale', '90000'] },
  'avc-full': { W: 128, H: 72, fps: 30, frames: 12, v: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'pc', '-colorspace', 'bt709', '-movflags', '+write_colr'] },
  'hevc-r90': { W: 144, H: 256, fps: 30, frames: 24, rotation: 90, container: 'mov', v: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18', '-tag:v', 'hvc1', '-x265-params', 'bframes=2:keyint=12:log-level=error', '-pix_fmt', 'yuv420p'] },
  'hevc-r180': { W: 256, H: 144, fps: 30, frames: 24, rotation: 180, container: 'mov', v: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18', '-tag:v', 'hvc1', '-x265-params', 'bframes=2:keyint=12:log-level=error', '-pix_fmt', 'yuv420p'] },
  'hevc-r270': { W: 144, H: 256, fps: 30, frames: 24, rotation: 270, container: 'mov', v: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18', '-tag:v', 'hvc1', '-x265-params', 'bframes=2:keyint=12:log-level=error', '-pix_fmt', 'yuv420p'] },
  'hevc-10bit': { W: 128, H: 72, fps: 30, frames: 12, v: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18', '-tag:v', 'hvc1', '-x265-params', 'bframes=2:keyint=6:log-level=error', '-pix_fmt', 'yuv420p10le'] },
  'mpeg4': { W: 128, H: 72, fps: 30, frames: 6, v: ['-c:v', 'mpeg4', '-q:v', '3'] },
  'avc-cut': { derive: 'avc-bf', args: ['-ss', '0.51', '-i', '{src}', '-map', '0', '-c', 'copy'] },
  'avc-delay': { derive: 'avc-bf', args: ['-itsoffset', '0.25', '-i', '{src}', '-map', '0', '-c', 'copy'] },
  'avc-frag': { derive: 'avc-bf', args: ['-i', '{src}', '-map', '0', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'] },
  'avc-tail': { derive: 'avc-bf', args: ['-i', '{src}', '-map', '0', '-c', 'copy'] }, // moov after mdat (no faststart)
  'audio-only': { derive: 'avc-bf', ext: 'm4a', args: ['-i', '{src}', '-map', '0:a', '-c', 'copy'] },
  'avc-co64': { rewrite: 'avc-tail', fn: 'co64' },
  'avc-large': { rewrite: 'avc-tail', fn: 'largesize' },
  'no-moov': { rewrite: 'avc-tail', fn: 'truncate' },
  // Bench-only (bench: true): phone-like portrait clips coded landscape with a 90° display matrix, as iPhones record,
  // with temporal noise so the bitrate is phone-like (16 Mb/s at 1080p30, 50 Mb/s at 4K60 H.264, 40 Mb/s HEVC).
  'perf-1080p30': { bench: true, W: 1080, H: 1920, fps: 30, frames: 150, rotation: 90, vf: 'noise=alls=12:allf=t+u', v: ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-b:v', '16M', '-maxrate', '20M', '-bufsize', '32M', '-g', '30', '-bf', '2', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709'] },
  'perf-4k60': { bench: true, W: 2160, H: 3840, fps: 60, frames: 180, rotation: 90, vf: 'noise=alls=12:allf=t+u', v: ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-b:v', '50M', '-maxrate', '60M', '-bufsize', '100M', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709'] },
  'perf-4k60-hevc': { bench: true, W: 2160, H: 3840, fps: 60, frames: 180, rotation: 90, container: 'mov', vf: 'noise=alls=12:allf=t+u', v: ['-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '40M', '-tag:v', 'hvc1', '-x265-params', 'bframes=2:keyint=60:vbv-maxrate=50000:vbv-bufsize=80000:log-level=error', '-pix_fmt', 'yuv420p'] }
};
/** Fixtures the unit tests use (bench-only clips excluded). */
export const UNIT_FIXTURES = Object.keys(SPECS).filter(k => !SPECS[k].bench);
const fileOf = (name, spec) => `${name}-${createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 10)}.${spec.ext ?? spec.container ?? 'mp4'}`;
export const fixtureDir = () => join(tmpdir(), 'flightline-hf-decode-fixtures');

async function encode(spec, out) {
  const rot = spec.rotation ?? 0, cw = rot % 180 ? spec.H : spec.W, ch = rot % 180 ? spec.W : spec.H, dur = spec.frames / spec.fps;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${cw}x${ch}`, '-framerate', String(spec.fps), '-i', 'pipe:0'];
  if (spec.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${dur}`);
  args.push('-map', '0:v:0', ...(spec.audio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '64k'] : []));
  if (spec.vf) args.push('-vf', spec.vf);
  args.push(...spec.v, '-f', spec.container === 'mov' ? 'mov' : 'mp4');
  const tmp = rot ? `${out}.coded.${spec.container ?? 'mp4'}` : out;
  await run(FFMPEG, [...args, tmp], pipeFrames(spec, cw, ch));
  if (rot) { await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-display_rotation', String((360 - rot) % 360), '-i', tmp, '-map', '0', '-c', 'copy', out]); rmSync(tmp); }
}

/** Every top-level box of an MP4 buffer. */
export function topBoxes(buf) {
  const out = [];
  for (let o = 0; o + 8 <= buf.length;) {
    let size = buf.readUInt32BE(o), header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16; } else if (size === 0) size = buf.length - o;
    out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, size, header });
    o += size;
  }
  return out;
}
// stco -> co64 in a moov-at-end file (sample offsets stay valid because mdat does not move).
function toCo64(buf) {
  const moov = topBoxes(buf).find(b => b.type === 'moov');
  if (moov.start + moov.size !== buf.length) throw new Error('co64 rewrite needs moov last');
  const m = buf.subarray(moov.start, moov.start + moov.size), parents = [];
  const find = (o, end, depth) => {
    for (let p = o; p + 8 <= end;) {
      const sz = m.readUInt32BE(p), type = m.toString('latin1', p + 4, p + 8);
      if (type === 'stco') return { p, sz, parents: [...parents] };
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) { parents.push(p); const r = find(p + 8, p + sz, depth + 1); if (r) return r; parents.pop(); }
      p += sz;
    }
    return null;
  };
  const hit = find(0, m.length, 0), n = m.readUInt32BE(hit.p + 12), grow = 4 * n;
  const co = Buffer.alloc(hit.sz + grow);
  co.writeUInt32BE(hit.sz + grow, 0); co.write('co64', 4, 'latin1'); m.copy(co, 8, hit.p + 8, hit.p + 16);
  for (let i = 0; i < n; i++) co.writeBigUInt64BE(BigInt(m.readUInt32BE(hit.p + 16 + 4 * i)), 16 + 8 * i);
  const out = Buffer.concat([m.subarray(0, hit.p), co, m.subarray(hit.p + hit.sz)]);
  for (const p of hit.parents) out.writeUInt32BE(out.readUInt32BE(p) + grow, p);
  return Buffer.concat([buf.subarray(0, moov.start), out]);
}
// 'free'(8) + 'mdat'(32-bit) -> one 'mdat' with a 64-bit largesize header, in place.
function toLargesize(buf) {
  const bx = topBoxes(buf), i = bx.findIndex(b => b.type === 'mdat');
  if (i < 1 || bx[i - 1].type !== 'free' || bx[i - 1].size !== 8) throw new Error('largesize rewrite needs free(8) before mdat');
  const out = Buffer.from(buf), s = bx[i - 1].start;
  out.writeUInt32BE(1, s); out.write('mdat', s + 4, 'latin1'); out.writeBigUInt64BE(BigInt(bx[i].size + 8), s + 8);
  return out;
}
const truncateMoov = buf => buf.subarray(0, topBoxes(buf).find(b => b.type === 'moov').start);

/**
 * Build (or reuse) fixtures. Returns {dir, path(name), spec(name)}; specs of derived fixtures inherit their source's
 * W, H, fps and rotation.
 */
export async function buildFixtures(names = UNIT_FIXTURES) {
  const dir = fixtureDir();
  mkdirSync(dir, { recursive: true });
  const done = new Map();
  const build = name => {
    if (done.has(name)) return done.get(name);
    const spec = SPECS[name], out = join(dir, fileOf(name, spec));
    const job = (async () => {
      const base = spec.derive ?? spec.rewrite;
      const src = base ? await build(base) : null;
      if (existsSync(out)) return out;
      const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.${spec.ext ?? spec.container ?? 'mp4'}`;
      if (spec.derive) await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...spec.args.map(a => a.replace('{src}', src)), tmp]);
      else if (spec.rewrite) writeFileSync(tmp, { co64: toCo64, largesize: toLargesize, truncate: truncateMoov }[spec.fn](readFileSync(src)));
      else await encode(spec, tmp);
      renameSync(tmp, out);
      return out;
    })();
    done.set(name, job);
    return job;
  };
  await Promise.all(names.map(build));
  const specOf = name => { const s = SPECS[name]; const b = s.derive ?? s.rewrite; return b ? { ...specOf(b), ...s } : s; };
  return { dir, path: name => join(dir, fileOf(name, SPECS[name])), spec: specOf };
}

/* ---------------------------------------------------------------- ffprobe ground truth */

const probeJson = (args, file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', ...args, '-of', 'json', file], { maxBuffer: 1 << 28 }).toString());
/** Decoded frames in presentation order: {t, key}. */
export const probeFrames = file => probeJson(['-select_streams', 'v:0', '-show_entries', 'frame=pts_time,key_frame'], file).frames.map(f => ({ t: Number(f.pts_time), key: f.key_frame === 1 }));
/** Video packets in decode order: {pts, dts, size, pos, key, discard} (pts, dts in s). */
export const probePackets = file => probeJson(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,size,pos,flags'], file).packets
  .map(p => ({ pts: Number(p.pts_time), dts: Number(p.dts_time), size: Number(p.size), pos: Number(p.pos), key: p.flags.includes('K'), discard: p.flags.includes('D') }));
/** Stream facts: codec, coded size, rotation (ffprobe's counter-clockwise degrees), streams. */
export function probeStream(file) {
  const j = probeJson(['-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,color_range:stream_side_data=rotation'], file);
  const v = j.streams.find(s => s.codec_type === 'video');
  return { codec: v?.codec_name, width: v?.width, height: v?.height, pixFmt: v?.pix_fmt, range: v?.color_range, rotation: Number(v?.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0), audio: j.streams.some(s => s.codec_type === 'audio') };
}

/** Coded-orientation planar frames (presentation order) for fake decoders: pixFmt 'yuv420p' or 'yuv420p10le'. */
export function decodeCoded(file, { pixFmt = 'yuv420p', width, height } = {}) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-noautorotate', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1'], { maxBuffer: 1 << 30 });
  const bps = pixFmt.endsWith('10le') ? 2 : 1, size = width * height * 3 / 2 * bps, out = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(new Uint8Array(buf.buffer, buf.byteOffset + o, size));
  return out;
}
