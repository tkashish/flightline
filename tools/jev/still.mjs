// Draw a result on the clip's frame at the end of its curve (observed red, predicted fading yellow): node tools/jev/still.mjs CLIP RESULT.json OUT.jpg
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [video, json, out] = process.argv.slice(2), r = JSON.parse(readFileSync(json, 'utf8'));
const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim().split(',').map(Number);
const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString();
const tEnd = Math.min(r.points.at(-1).t, dur - 0.1);   // a predicted tail can run past the clip's end
const f = Buffer.from(execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, tEnd - 0.01)), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }));
const dot = (x, y, rad, c, a = 1) => { for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { if (dx * dx + dy * dy > rad * rad) continue; const X = Math.round(x + dx), Y = Math.round(y + dy); if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const i = (Y * W + X) * 3; for (let j = 0; j < 3; j++) f[i + j] = Math.round(f[i + j] * (1 - a) + c[j] * a); } };
for (const p of r.points) dot(p.x * W, p.y * H, 4, p.status === 'predicted' ? [255, 220, 0] : [255, 50, 30], p.alpha ?? 1);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-', '-vf', 'scale=-2:900', out], { input: f });
