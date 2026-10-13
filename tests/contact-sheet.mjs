#!/usr/bin/env node
/**
 * Extract a contact sheet / frame sequence at chosen timestamps for labeling.
 * Does not call the tracker. Requires ffmpeg.
 *
 * Usage:
 *   node tests/contact-sheet.mjs --input path/to/video.mp4 --out /tmp/sheet --every 0.25
 *   node tests/contact-sheet.mjs --input path/to/video.mp4 --out /tmp/sheet --times 2.1,4.43,5.0
 */
import { mkdir } from 'node:fs/promises';
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
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.out) {
    console.error('Usage: node tests/contact-sheet.mjs --input video.mp4 --out dir [--every 0.25 | --times t1,t2]');
    process.exit(1);
  }
  const meta = await probeVideo(args.input);
  const aspect = meta.height / meta.width;
  const w = args.width;
  const h = Math.round(w * aspect / 2) * 2;
  await mkdir(args.out, { recursive: true });

  let times = args.times;
  if (!times?.length) {
    const step = args.every || 0.5;
    times = [];
    for (let t = 0; t < meta.duration; t += step) times.push(Number(t.toFixed(3)));
  }

  const manifest = [];
  for (let i = 0; i < times.length; i++) {
    const t = Math.min(times[i], Math.max(0, meta.duration - 0.001));
    const name = `frame_${String(i).padStart(4, '0')}_t${t.toFixed(3).replace('.', 'p')}.png`;
    const outPath = resolve(args.out, name);
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(t),
      '-i', args.input,
      '-frames:v', '1',
      '-vf', `scale=${w}:${h}`,
      outPath
    ]);
    manifest.push({ index: i, t, file: name, sourceWidth: meta.width, sourceHeight: meta.height });
    process.stderr.write(`wrote ${name}\n`);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(args.out, 'frames.json'), JSON.stringify({
    input: args.input,
    meta,
    frames: manifest,
    labelHint: 'Annotate ball center in source pixels on upright frames, or status not_visible/occluded/uncertain.'
  }, null, 2));
  console.log(`Contact sheet: ${manifest.length} frames → ${args.out}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
