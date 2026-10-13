// Local diagnostic only. Never included in the deployed app.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { MotionTracker } from '../dist/tracker.js';
const input = process.argv[2], output = process.argv[3];
const w = Number(process.argv[4] || 540), h = Number(process.argv[5] || 960);
const tracker = new MotionTracker(w, h), frames = [], frameSize = w * h * 4;
const processVideo = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `fps=30,scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
let pending = Buffer.alloc(0), index = 0;
for await (const chunk of processVideo.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= frameSize) {
    tracker.detect(pending.subarray(0, frameSize), index / 30);
    frames.push({ t: index / 30, candidates: tracker.lastCandidates });
    pending = pending.subarray(frameSize); index++;
  }
}
const result = tracker.result();
await writeFile(output, JSON.stringify({ result, frames }));
console.log(JSON.stringify({ frames: index, count: result.points.length, first: result.points[0], last: result.points.at(-1), output }));
