import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seekFrameTiming, sourceFrameSchedule, snapSourceFps } from '../dist/frame-source.js';
import { createFrameSelector, packetRate, runTrackerOffline } from './lib/run-tracker-offline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const skip = (ffmpeg.status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) && 'ffmpeg/ffprobe not installed';
const codec = ffmpeg.stdout?.includes('libx264') ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0'] : ['-c:v', 'mpeg4', '-q:v', '1'];
const W = 64, H = 48;

// The browser rule as agreed for app.js (and exported from dist/frame-source.js): frames from the
// first one (start) to the clip end; a sample slot within 0.001 of the end is not sampled.
function specSchedule(end, sourceFps, sampleFps = 30, start = 0) {
  const span = end - start, out = [];
  for (let i = 0; i < Math.ceil(span * sampleFps - 1e-3); i++) {
    const index = Math.floor((i / sampleFps) * sourceFps + 1e-6);
    if (out.length && out.at(-1).index === index) continue;
    out.push({ index, pts: start + index / sourceFps, t: Math.min(end - 1e-3, start + (index + 0.5) / sourceFps) });
  }
  return out;
}

/** Frames carry their index as 8 dark/bright 8x8 blocks on the top rows; `offset` delays the first frame, `trim` cuts the start by an edit list. */
function codedClip(path, { rate = '30', frames = 60, vf = null, offset = 0, trim = 0 } = {}) {
  const raw = Buffer.alloc(W * H * frames, 60);
  for (let i = 0; i < frames; i++) for (let b = 0; b < 8; b++) for (let y = 0; y < 8; y++) {
    const at = i * W * H + y * W + b * 8;
    raw.fill((i >> b) & 1 ? 230 : 20, at, at + 8);
  }
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', rate, '-i', 'pipe:0',
    ...(vf ? ['-vf', vf, '-enc_time_base:v', '1/30000', '-fps_mode', 'passthrough'] : []),
    ...(offset ? ['-output_ts_offset', String(offset)] : []),
    ...codec, '-pix_fmt', 'yuv420p', ...(trim ? ['-g', '30', `${path}.src.mp4`] : [path])], { input: raw });
  assert.equal(r.status, 0, String(r.stderr));
  // A stream copy from mid-GOP keeps the frames before the cut, flagged discard: only the edit list hides them.
  if (trim) assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(trim), '-i', `${path}.src.mp4`, '-c', 'copy', path]).status, 0);
  return path;
}
const codeAt = (px, width, bytes = 4) => {
  let c = 0;
  for (let b = 0; b < 8; b++) if (px[(4 * width + b * 8 + 4) * bytes] > 128) c |= 1 << b;
  return c;
};
const framePts = path => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path],
  { encoding: 'utf8' }).stdout.trim().split('\n').map(line => Number(line.split(',')[0]));
// What readSample (dist/frame-source.js) gets from exact seeks: the frame on screen at each target (the
// last one starting at or before it); on a repeat, one retry `nudge` later, else the sample drops.
const browserPicks = (pts, schedule, nudge = 0, maxT = Infinity) => {
  const shown = t => { let k = 0; while (k + 1 < pts.length && pts[k + 1] <= t) k++; return k; };
  const out = [];
  for (const { t } of schedule) {
    let k = shown(t);
    if (k === out.at(-1)) k = shown(Math.min(maxT, t + nudge));
    if (k !== out.at(-1)) out.push(k);
  }
  return out;
};
const select = (pts, schedule, opts) => {
  const sel = createFrameSelector(schedule, opts), out = [];
  pts.forEach((p, n) => out.push(...sel.push({ n, pts: p })));
  return [...out, ...sel.end()].map(f => f.n);
};

test('dist sourceFrameSchedule implements the agreed browser frame rule', () => {
  for (const sampleFps of [30, 15]) {
    for (const start of [0, 0.2, 1 / 15]) {
      for (const duration of [0.5, 1, 2.5, 3, 3.003, 7.77, 29.9]) {
        for (const fps of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240, 22.42]) {
          const end = start + duration, got = sourceFrameSchedule(end, fps, sampleFps, start), want = specSchedule(end, fps, sampleFps, start);
          assert.deepEqual(got.map(e => e.index), want.map(e => e.index), `${duration}s from ${start} @ ${fps}`);
          got.forEach((e, i) => {
            assert.ok(Math.abs(e.pts - want[i].pts) < 1e-9 && Math.abs(e.t - want[i].t) < 1e-9, `${duration}s from ${start} @ ${fps} #${i}`);
          });
        }
      }
    }
  }
  assert.deepEqual(sourceFrameSchedule(1, 60).slice(0, 3).map(e => e.index), [0, 2, 4]);
  assert.equal(sourceFrameSchedule(1, 25).length, 25);
});

test('snapSourceFps snaps within 3% of a common rate', () => {
  assert.equal(snapSourceFps(29.85), 29.97);
  assert.equal(snapSourceFps(30.4), 30);
  assert.equal(snapSourceFps(59.7), 59.94);
  assert.equal(snapSourceFps(22.418), 22.42);
  for (const bad of [NaN, 0, -5, Infinity]) assert.equal(snapSourceFps(bad), 30);
});

test('frame selector feeds exactly the scheduled frames of a constant-rate clip', () => {
  for (const fps of [24, 25, 29.97, 30, 50, 59.94, 60, 120]) {
    for (const duration of [1, 2.5, 3.003]) {
      const schedule = sourceFrameSchedule(duration, fps, 30);
      const pts = Array.from({ length: schedule.at(-1).index + 1 }, (_, n) => n / fps);
      assert.deepEqual(select(pts, schedule, { nudge: 0.25 / fps, maxT: duration - 1e-3 }), schedule.map(e => e.index), `${duration}s @ ${fps}`);
    }
  }
});

test('frame selector picks the frame on screen at each target, once', () => {
  const schedule = [1, 3, 5, 7, 9, 11].map(i => ({ t: i / 60 }));
  assert.deepEqual(select([0, 0.05, 0.0667, 0.1, 0.18, 0.2], schedule), [0, 1, 2, 3, 4]);
  // A target before the first frame shows the first frame.
  assert.deepEqual(select([0.02, 0.06], [{ t: 0.01 }, { t: 0.03 }, { t: 0.07 }]), [0, 1]);
});

test('frame selector retries a repeated frame once, a quarter frame later', () => {
  const schedule = [0.5, 1.5, 2.5, 3.5].map(i => ({ t: i / 30 })), nudge = 0.25 / 30;
  // Frame 1 starts 0.2 frame after its target (the retry finds it); frame 3 starts 0.4 late (dropped).
  const pts = [0, 1.7, 2, 3.9, 4].map(i => i / 30);
  assert.deepEqual(select(pts, schedule, { nudge }), [0, 1, 2]);
  assert.deepEqual(select(pts, schedule), [0, 2]);
  assert.deepEqual(select(pts, schedule, { nudge }), browserPicks(pts, schedule, nudge));
  // The retry never seeks past maxT.
  assert.deepEqual(select([0, 1.7].map(i => i / 30), [{ t: 0.5 / 30 }, { t: 1.5 / 30 }], { nudge, maxT: 1.6 / 30 }), [0]);
});

test('offline runner feeds the browser-scheduled source frames with their own pts', { skip }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flightline-frames-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clips = {
    cfr60: codedClip(join(dir, 'cfr60.mp4'), { rate: '60', frames: 120 }),
    cfr25: codedClip(join(dir, 'cfr25.mp4'), { rate: '25', frames: 50 }),
    ntsc: codedClip(join(dir, 'ntsc.mp4'), { rate: '30000/1001', frames: 60 }),
    // Late frames: N = 1 mod 4 by 0.9 frame (never shown), N = 3 mod 8 by 0.7 (found by the retry).
    vfr: codedClip(join(dir, 'vfr.mp4'), { frames: 60, vf: "settb=1/30000,setpts='(N+0.9*eq(mod(N,4),1)+0.7*eq(mod(N,8),3))/(30*TB)'" }),
    // Every 4th 30 fps slot empty: the average rate is ~22.8 fps, the median interval 1/30 s.
    drops: codedClip(join(dir, 'drops.mp4'), { frames: 60, vf: "settb=1/30000,setpts='(N+floor(N/3))/(30*TB)'" }),
    // 29.5 fps measures within 3% of 29.97, so the schedule uses 29.97 like the browser.
    odd: codedClip(join(dir, 'odd.mp4'), { rate: '59/2', frames: 59 }),
    // The first frame starts at 0.2 s: the browser shows it there and reaches all 60 frames.
    late: codedClip(join(dir, 'late.mp4'), { frames: 60, offset: 0.2 }),
    // Cut 0.5 s in without re-encoding: frames 0-14 stay in the file as discarded packets, the clip starts at frame 15.
    trim: codedClip(join(dir, 'trim.mp4'), { frames: 60, trim: 0.5 }),
    // The first 15 frames at 15 fps, the rest at 30: the browser re-measures the rate later in the clip.
    slowstart: codedClip(join(dir, 'slowstart.mp4'), { frames: 75, vf: "settb=1/30000,setpts='(N+min(N,15))/(30*TB)'" })
  };
  const rates = { cfr60: 60, cfr25: 25, ntsc: 29.97, vfr: 30, drops: 30, odd: 29.97, late: 30, trim: 30, slowstart: 30 }, firstCode = { trim: 15 };
  for (const [name, path] of Object.entries(clips)) {
    const codes = [];
    const run = await runTrackerOffline(path, { onFrame: ({ pixels, width }) => codes.push(codeAt(pixels, width)) });
    // The app's default engine, v2, unless told otherwise.
    assert.deepEqual([run.engine, run.result.engine], ['v2', 'global-v2'], name);
    // Same rate the browser measures (sourceRate in dist/frame-source.js).
    assert.equal(run.meta.sourceFps, rates[name], name);
    // Container-clock pts of the shown frames (what the browser reports), from the first frame through the last.
    const pts = framePts(path), schedule = sourceFrameSchedule(run.meta.end, run.meta.sourceFps, 30, run.meta.start);
    assert.ok(Math.abs(run.meta.start - pts[0]) < 1e-6 && Math.abs(run.meta.end - Math.max(run.meta.duration, pts.at(-1) + 1 / run.meta.sourceFps)) < 1e-6, name);
    const expected = browserPicks(pts, schedule, 0.25 / run.meta.sourceFps, run.meta.end - 1e-3);
    assert.deepEqual(codes, expected.map(n => n + (firstCode[name] || 0)), name);
    assert.deepEqual(run.fed.map(f => f.frame), expected, name);
    for (const f of run.fed) assert.ok(Math.abs(f.pts - pts[f.frame]) < 1e-4, `${name}: frame ${f.frame} fed at ${f.pts}`);
    // The tracker itself receives each frame's pts (one camera sample per detect call).
    assert.deepEqual(run.result.camera.map(c => c.t), run.fed.map(f => f.pts), name);
    assert.equal(run.frameCount, expected.length);
    assert.equal(run.sampling.ptsSource, 'showinfo');
    assert.deepEqual(run.sampling.warnings, []);
    if (['drops', 'late', 'trim', 'slowstart'].includes(name)) assert.deepEqual(expected, pts.map((_, n) => n), `${name}: every frame once`);
    if (name === 'drops') assert.ok(run.meta.avgFps < 23, `average rate ${run.meta.avgFps}`);
    else if (name === 'late') assert.ok(Math.abs(pts[0] - 0.2) < 1e-6 && Math.abs(run.fed[59].pts - (0.2 + 59 / 30)) < 1e-4, `late: ${pts[0]} .. ${run.fed.at(-1).pts}`);
    else if (name === 'trim') assert.ok(pts.length === 45 && Math.abs(pts[0]) < 1e-6, `trim: ${pts.length} frames from ${pts[0]}`);
    else if (name === 'slowstart') assert.equal(pts.length, 75);
    else if (name === 'odd') assert.ok(Math.abs(run.meta.rawFps - 29.5) < 1e-3, `measured ${run.meta.rawFps}`);
    else if (name !== 'vfr') assert.deepEqual(expected, schedule.map(e => e.index), `${name} picks exactly the scheduled indices`);
    else {
      // Picked by pts, not frame count: frame 1 never shows, frame 3 shows on the retry.
      assert.deepEqual(expected.slice(0, 5), [0, 2, 3, 4, 6]);
      assert.notDeepEqual(expected, browserPicks(pts, schedule), 'vfr exercises the retry');
    }
  }
});

test('the runner measures the source rate by the browser rule: the fastest of the first frames and two later spots', async () => {
  const cfr = (fps, n, t0 = 0) => Array.from({ length: n }, (_, k) => t0 + k / fps);
  const patterns = {
    cfr30: [cfr(30, 90), 30], cfr24: [cfr(24, 72), 24], ntsc: [cfr(30000 / 1001, 90), 29.97], cfr120: [cfr(120, 240), 120],
    held: [[0, ...cfr(30, 89, 0.5)], 30],
    slowstart: [[...cfr(15, 15), ...cfr(30, 60, 1)], 30],
    slowEnds: [[...cfr(15, 15), ...cfr(30, 30, 1), ...cfr(15, 15, 2)], 30],
    late24: [[...cfr(24, 48), ...cfr(30, 30, 2)], 30],
    // A head at the sample rate or faster is final: the later 30 fps stretch does not lower it.
    fastHead: [[...cfr(60, 60), ...cfr(30, 60, 1)], 60],
    // Only the first two intervals are long: the median over 12 frames keeps 30 fps, three frames would give 15.
    twoLong: [[...cfr(15, 2), ...cfr(30, 11, 2 / 15), ...cfr(15, 38, 0.5)], 30],
    slow15: [cfr(15, 45), 15]
  };
  for (const [name, [starts, fps]] of Object.entries(patterns)) {
    // An exact frame clock: the start of the last frame starting at or before t.
    const read = async t => starts.reduce((f, s) => (s <= t + 1e-9 ? s : f), starts[0]);
    assert.equal((await seekFrameTiming(read, () => starts.at(-1) + 1 / 30)).fps, fps, `${name}: browser`);
    assert.equal(snapSourceFps(await packetRate(starts)), fps, `${name}: runner`);
  }
  assert.ok(Math.abs(await packetRate(cfr(29.5, 59)) - 29.5) < 1e-9);
  assert.equal(await packetRate([]), null);
  assert.equal(await packetRate([0.5]), null);
});

test('the runner takes the app engine names only', async () => {
  for (const engine of ['global-v2', 'V2', 'bogus']) {
    await assert.rejects(runTrackerOffline('/nonexistent/clip.mp4', { engine }), /Unknown tracking engine/, engine);
  }
});

test('contact sheet labels each extracted frame with its own pts', { skip }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'flightline-sheet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sheetOf = (clip, name, times) => {
    const out = join(dir, name);
    const r = spawnSync('node', [join(root, 'tests/contact-sheet.mjs'), '--input', clip, '--out', out, '--times', times, '--width', String(W)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const sheet = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8'));
    for (const f of sheet.frames) {
      const png = spawnSync('ffmpeg', ['-v', 'error', '-i', join(out, f.file), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout;
      assert.equal(codeAt(png, W, 1), f.frame);
    }
    return sheet;
  };
  const sheet = sheetOf(codedClip(join(dir, 'cfr60.mp4'), { rate: '60', frames: 120 }), 'sheet', '0,0.51,1.99,5');
  // 0.51 s shows frame 30 (pts 0.5); 1.99 s and 5 s both show the last frame.
  assert.deepEqual(sheet.frames.map(f => f.frame), [0, 30, 119]);
  assert.deepEqual(sheet.frames.map(f => f.requestedT), [0, 0.51, 1.99]);
  for (const f of sheet.frames) assert.ok(Math.abs(f.t - f.frame / 60) < 1e-4, `t ${f.t} for frame ${f.frame}`);
  // A first frame at 0.2 s: times and labels on the browser's clock, the same one the runner feeds.
  const late = sheetOf(codedClip(join(dir, 'late.mp4'), { frames: 60, offset: 0.2 }), 'late', '0,0.51,1.99,5');
  assert.deepEqual(late.frames.map(f => f.frame), [0, 9, 53, 59]);
  for (const f of late.frames) assert.ok(Math.abs(f.t - (0.2 + f.frame / 30)) < 1e-4, `t ${f.t} for frame ${f.frame}`);
});
