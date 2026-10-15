#!/usr/bin/env node
/**
 * Extract frames for labeling. Each requested time picks the frame on screen at that time, and
 * frames.json records that frame's actual presentation time (pts) on the container clock, which is
 * the browser's and the offline runner's (a first frame at 0.2 s stays at 0.2 s): use a frame's `t`
 * as the label time. Does not call the tracker. Requires ffmpeg.
 *
 * Usage:
 *   node tests/contact-sheet.mjs --input path/to/video.mp4 --out /tmp/sheet --every 0.25
 *   node tests/contact-sheet.mjs --input path/to/video.mp4 --out /tmp/sheet --times 2.1,4.43,5.0
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { probeVideo } from './lib/run-tracker-offline.mjs';

function parseArgs(argv) {
  const out = { input: null, out: null, every: null, times: null, width: 540 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--every') out.every = Number(argv[++i]);
    else if (a === '--times') out.times = argv[++i].split(',').map(Number);
    else if (a === '--width') out.width = Number(argv[++i]);
  }
  return out;
}

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolvePromise({ out, err })
      : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`)));
  });
}

/** Frame presentation times from packet timestamps (no decoding), on the container clock. */
async function framePts(input) {
  const { out } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input]);
  return out.split('\n').map(line => line.split(','))
    .filter(([pts, flags = '']) => pts && pts !== 'N/A' && !flags.includes('D'))
    .map(([pts]) => Number(pts))
    .sort((a, b) => a - b);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.out) {
    console.error('Usage: node tests/contact-sheet.mjs --input video.mp4 --out dir [--every 0.25 | --times t1,t2]');
    process.exit(1);
  }
  const meta = await probeVideo(args.input);
  const pts = await framePts(args.input);
  if (!pts.length) throw new Error(`No video frames in ${args.input}`);
  const w = args.width;
  const h = Math.round(w * meta.height / meta.width / 2) * 2;
  await mkdir(args.out, { recursive: true });

  let times = args.times;
  if (!times?.length) {
    const step = args.every > 0 ? args.every : 0.5;
    times = [];
    const end = Math.max(meta.duration, pts.at(-1) + 1 / meta.sourceFps);
    for (let t = 0; t < Math.max(end, step); t += step) times.push(Number(t.toFixed(3)));
  }
  times = times.filter(Number.isFinite);
  if (!times.length) throw new Error('No valid --times given');
  // The frame on screen at t is the last one starting at or before t (so times past the last
  // frame's start still get a frame). Requests that land on one frame share it.
  const picks = new Map();
  for (const t of times) {
    let k = 0;
    while (k + 1 < pts.length && pts[k + 1] <= t + 1e-9) k++;
    if (!picks.has(k)) picks.set(k, t);
  }
  const wanted = [...picks].sort((a, b) => a[0] - b[0]);
  // One decode pass; passthrough keeps the image muxer from padding the gaps with duplicates.
  const { err } = await run('ffmpeg', [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'info',
    '-copyts', '-i', args.input,
    '-an', '-sn', '-dn',
    '-vf', `select='${wanted.map(([k]) => `eq(n,${k})`).join('+')}',showinfo,scale=${w}:${h}`,
    '-fps_mode', 'passthrough',
    '-start_number', '0',
    resolve(args.out, 'pick_%04d.png')
  ]);
  const shown = [...err.matchAll(/\bn:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+)/g)].map(m => Number(m[2]));
  if (shown.length !== wanted.length) throw new Error(`Extracted ${shown.length} of ${wanted.length} frames`);

  const frames = [];
  for (let i = 0; i < wanted.length; i++) {
    const [frame, requestedT] = wanted[i], t = shown[i];
    const file = `frame_${String(i).padStart(4, '0')}_t${t.toFixed(3).replace('.', 'p')}.png`;
    await rename(resolve(args.out, `pick_${String(i).padStart(4, '0')}.png`), resolve(args.out, file));
    if (Math.abs(t - pts[frame]) > 1e-3) process.stderr.write(`warning: frame ${frame} decoded at ${t}s, packets said ${pts[frame]}s\n`);
    frames.push({ index: i, frame, t, requestedT, file, sourceWidth: meta.width, sourceHeight: meta.height });
    process.stderr.write(`wrote ${file}\n`);
  }
  await writeFile(resolve(args.out, 'frames.json'), JSON.stringify({
    input: args.input,
    meta,
    frames,
    labelHint: 'Use each frame\'s t (its presentation time in seconds) as the label time. Annotate the ball centre in upright source pixels, or set status not_visible/occluded/uncertain.'
  }, null, 2));
  console.log(`Contact sheet: ${frames.length} frames → ${args.out}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
