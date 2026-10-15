#!/usr/bin/env node
// node tests/synth/cli.mjs --split smoke|tune|holdout|easy [--count N] [--seed S] [--only <scenario|tag|factor>] [--out DIR] [--jobs N] [--index]
// --index only rebuilds manifest.json, coverage.json and checksums.sha256 from the clips already in DIR. Both refuse a
// directory whose clips come from different generator code, node or ffmpeg (regenerate the split instead).
import { Worker } from 'node:worker_threads';
import { availableParallelism, tmpdir } from 'node:os';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { planSplit, coverage, FAILURE_MODES } from './scenarios.mjs';
import { ffmpegVersion } from './encode.mjs';
import { generatorInfo } from './clip.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const split = opt('split'); if (!split) { console.error('Usage: node tests/synth/cli.mjs --split smoke|tune|holdout|easy [--count N] [--seed S] [--only X] [--out DIR] [--jobs N] [--index]'); process.exit(1); }
const out = resolve(opt('out', `/tmp/flightline-corpus/${split}`)), jobs = Math.max(1, +opt('jobs', availableParallelism())), threads = +opt('threads', 1); // 1 encoder thread: x264 frame threads are not bit-reproducible
let specs = planSplit(split);
const only = opt('only'), seed = opt('seed'), count = opt('count');
if (seed) specs = specs.filter(s => s.seed === +seed);
if (only) { const keys = only.split(','); specs = specs.filter(s => keys.some(k => s.scenario.includes(k) || s.id.includes(k) || s.view === k || s.kind === k || s.club === k || s.confounders[k])); }
if (count) specs = specs.slice(0, +count);
if (!specs.length) { console.error('No clips match.'); process.exit(1); }
mkdirSync(out, { recursive: true });
const indexOnly = args.includes('--index');
const tmp = join(tmpdir(), `flightline-synth-${process.pid}`);
// Longest clips first for load balance.
const cost = s => s.durationOut * (s.capture.slowmo ? 30 : s.capture.fps) * s.format.W * s.format.H;
const queue = indexOnly ? [] : [...specs].sort((a, b) => cost(b) - cost(a)), results = [], failures = [], t0 = performance.now();
if (!indexOnly) console.error(`synth ${split}: ${specs.length} clips -> ${out} with ${Math.min(jobs, specs.length)} workers (${ffmpegVersion()})`);
if (queue.length) await new Promise(done => {
  let active = 0;
  const startWorker = () => {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { outDir: out, tmpDir: tmp, threads } });
    const next = () => { const s = queue.shift(); if (!s) { w.terminate(); if (--active === 0) done(); return; } w.postMessage({ spec: s }); };
    w.on('message', m => {
      if (m.ok) { results.push(m.res); console.error(`[${results.length + failures.length}/${specs.length}] ${m.res.id} ${m.res.size}@${m.res.fps} ${m.res.frames}f ${(m.res.ms.total / 1000).toFixed(1)}s ${m.res.expected} ${m.res.failureModes.join(',')}`); }
      else { failures.push(m); console.error(`FAILED ${m.id}: ${m.error}`); }
      next();
    });
    w.on('error', e => { failures.push({ error: String(e) }); console.error(e); if (--active === 0) done(); });
    active++; next();
  };
  for (let i = 0; i < Math.min(jobs, specs.length); i++) startWorker();
});
const wall = (performance.now() - t0) / 1000;
// Manifest and coverage from every GT file of this split present in the output directory.
const gts = readdirSync(out).filter(f => f.endsWith('.gt.json')).sort().map(f => JSON.parse(readFileSync(join(out, f), 'utf8'))).filter(g => g.split === split);
const versionKey = g => `${g.generator?.codeSha256 ?? 'none'} | ${g.generator?.node ?? '?'} | ${g.generator?.ffmpeg ?? '?'}`, versions = Map.groupBy(gts, versionKey);
if (versions.size > 1) {
  console.error(`refusing to index ${out}: clips from ${versions.size} generator versions (code sha256 | node | ffmpeg):`);
  for (const [k, g] of versions) console.error(`  ${g.length} clips: ${k} (e.g. ${g[0].id})`);
  console.error('Regenerate the whole split (or clean the directory) so every clip comes from the same code.');
  process.exit(3);
}
const gen = gts[0]?.generator || generatorInfo();
const manifest = {
  baselineLabel: `synth-${split}`, fps: 30, longEdge: 1280, tolerancesPx: [5, 10, 20],
  generator: { ...gen, split },
  notes: ['Synthetic clips; coordinates are upright display pixels, label times are frame PTS (s).', 'expected=abstain clips carry expectAbstention; expected=either clips carry no decisive labels.'],
  clips: gts.map(g => { const F = g.meta.factors; return { id: g.id, path: g.meta.video.file, split: g.split, tags: [g.scenario, `expected:${g.expected}`, `kind:${F.kind}`, `view:${F.viewClass}`, `capture:${F.capture}`, `confounders:${F.confounderCount}`, `stratum:${F.easy ? 'easy' : F.clean ? 'clean' : F.stress ? 'stress' : 'main'}`, ...(g.styleShift ? ['style-shifted'] : []), ...g.failureModes], annotationInline: g.annotation }; })
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
const sums = gts.flatMap(g => [g.meta.video.file, `${g.id}.gt.json`]).filter(f => existsSync(join(out, f))).map(f => `${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${f}`);
writeFileSync(join(out, 'checksums.sha256'), sums.join('\n') + '\n');
const cov = coverage(gts);
writeFileSync(join(out, 'coverage.json'), JSON.stringify({ split, clips: gts.length, failureModes: cov, missingOrUnder10: Object.entries(cov).filter(([, n]) => n < 10).map(([k]) => k), catalog: FAILURE_MODES }, null, 1));
const sum = results.reduce((a, r) => { for (const k of Object.keys(r.ms)) a[k] = (a[k] || 0) + r.ms[k]; a.frames += r.frames; return a; }, { frames: 0 });
const runLog = { split, clips: results.length, failed: failures.length, wallS: +wall.toFixed(1), jobs, threads, frames: sum.frames, cpuS: Object.fromEntries(Object.entries(sum).filter(([k]) => k !== "frames").map(([k, v]) => [k, +(v / 1000).toFixed(1)])), generator: generatorInfo(), results: results.map(r => ({ id: r.id, frames: r.frames, size: r.size, fps: r.fps, ms: Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)])), rawSha256: r.rawSha256, ptsVerified: r.ptsVerified })), failures };
if (!indexOnly) writeFileSync(join(out, `run-${Date.now()}.json`), JSON.stringify(runLog, null, 1));
console.error(`done: ${results.length} ok, ${failures.length} failed, wall ${wall.toFixed(1)} s, ${sum.frames} frames; manifest ${join(out, 'manifest.json')}`);
console.error(`coverage (${gts.length} clips): ${Object.entries(cov).map(([k, n]) => `${k}=${n}`).join(' ')}`);
if (failures.length) process.exit(2);
