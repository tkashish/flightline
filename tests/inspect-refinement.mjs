import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { BallRefiner } from '../dist/refiner.js';
const input = process.argv[2], diagnostics = JSON.parse(await readFile(process.argv[3], 'utf8'));
const seed = diagnostics.points.slice(-4), start = seed.at(-1).t;
const tracker = new BallRefiner(2160, 3840, seed);
const width = 650, height = 650, left = 1250, top = 1150, size = width * height * 4;
const decode = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', input, '-vf', `fps=30,crop=${width}:${height}:${left}:${top}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
let pending = Buffer.alloc(0), index = 0;
for await (const chunk of decode.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= size) {
    const point = tracker.detect(pending.subarray(0, size), width, height, left, top, start + index / 30);
    if (point) console.log(JSON.stringify(point));
    pending = pending.subarray(size); index++;
  }
}
await writeFile('/tmp/flightline-qa/refined-offline.json', JSON.stringify(tracker.result()));
console.log(JSON.stringify({ count: tracker.points.length, last: tracker.result().at(-1), finished: tracker.finished }));
