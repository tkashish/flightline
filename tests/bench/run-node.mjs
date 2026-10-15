#!/usr/bin/env node
/**
 * Node benchmark runner (U7): run one engine over synthetic corpus splits in parallel child processes, score every
 * clip against its `<id>.gt.json`, and write a JSON report (every ClipMetrics, the aggregate, the gate, the corpus
 * pin) plus markdown.
 *
 *   node tests/bench/run-node.mjs --corpus DIR[,DIR] [--with controls,perf|none] [--engine hf|v2|legacy]
 *        [--only id,id] [--limit N] [--jobs N] [--out report.json] [--md report.md] [--entry runHF|analyzeClip]
 *        [--timeout-s 900] [--max-rss-mb 4096] [--resume] [--allow-holdout] [--keep-results] [--diagnostics]
 *        [--run-log FILE|none]
 *
 * hf: tests/hf/helpers/node-source.mjs openNodeSource (U1) into dist/hf/engine.js runHF, exactly as the worker drives
 * it (--entry analyzeClip calls dist/hf/pipeline.js directly; runHF is the same call).
 * v2 / legacy: tests/lib/run-tracker-offline.mjs, the browser's analysis on exact frame PTS (sourceFrameSchedule at
 * the measured source rate, the frame on screen at each seek target with its container PTS, long edge <= 1280 px),
 * then the status the UI shows (normalizeTrackReport).
 * --with adds the sibling 'controls' (invisible-ball controls) and 'perf' split directories of the first corpus when
 * they exist (default both). Every clip file of every split is hashed into the report's corpus pin; a file that
 * changes during the run marks the pin unstable, and the gate fails.
 * Each child runs one clip at a time under a watchdog: past --timeout-s or --max-rss-mb (RSS sampled with ps every
 * 0.5 s) it is killed and the clip is a runner error. Every finished clip is appended to `<out>.clips.jsonl`;
 * --resume reuses the entries whose engine code, options and clip files match, and runs the rest.
 * Holdout runs need --allow-holdout; every run is appended to <first corpus>/../bench-runs.jsonl (or --run-log) with
 * the code hashes and the corpus pin.
 */
import { fork, execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PARAMS_VERSION } from '../../dist/hf/params.js';
import { HFError, timingFromTimes, validateResult } from '../../dist/hf/types.js';
import { scoreClip } from './metrics.mjs';
import { buildReport, renderMarkdown } from './report.mjs';
import { EXTRA_SETS, resolveCorpora, listClips, pinCorpus, clipsSha256, changedFiles } from './corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg', FFPROBE = process.env.FFPROBE ?? 'ffprobe';
export const ENGINES = Object.freeze(['hf', 'v2', 'legacy']);
const sha256 = s => createHash('sha256').update(s).digest('hex');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/** Display geometry, audio and every presentation time (sorted packet PTS) of the first video stream. */
export function probeVideo(path) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height,time_base:stream_side_data=rotation:format=duration', '-of', 'json', path]));
  const v = j.streams.find(s => s.codec_type === 'video');
  if (!v) throw new HFError('no-video', `${path}: no video stream`);
  const ccw = Number(v.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0), rotation = ((Math.round(-ccw / 90) * 90) % 360 + 360) % 360;
  const [num, den] = v.time_base.split('/').map(Number);
  const pts = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', path])
    .split('\n').map(s => s.trim()).filter(s => s && s !== 'N/A').map(Number).sort((a, b) => a - b);
  const times = Float64Array.from(pts, p => p * num / den), swap = rotation === 90 || rotation === 270, t = timingFromTimes(times);
  return {
    codec: v.codec_name, codedWidth: v.width, codedHeight: v.height, width: swap ? v.height : v.width, height: swap ? v.width : v.height, rotation,
    times, fps: t.fps, vfr: t.vfr, duration: t.duration, hasAudio: j.streams.some(s => s.codec_type === 'audio')
  };
}

/* ------------------------------------------------------------------ engines (child side) */

/** hf collaborators: U1's node source and the engine entry (runHF, as the worker calls it, or analyzeClip). */
export async function hfRunner({ entry = 'runHF' } = {}) {
  if (entry === 'auto') entry = 'runHF';
  if (!['runHF', 'analyzeClip'].includes(entry)) throw new Error(`unknown entry ${entry}; use runHF|analyzeClip`);
  const [{ openNodeSource }, { runHF }, { analyzeClip }] = await Promise.all([
    import('../hf/helpers/node-source.mjs'), import('../../dist/hf/engine.js'), import('../../dist/hf/pipeline.js')]);
  return {
    source: 'node-source', entry, open: p => openNodeSource(p, process.env.FFMPEG ? { ffmpeg: process.env.FFMPEG } : {}),
    run: entry === 'runHF' ? runHF : (src, o, onProgress) => analyzeClip(src, { ...o, onProgress })
  };
}

/** v2 / legacy through the harness's browser-equivalent offline runner; the reply carries the status the UI shows. */
export async function runMotionTracker(path, engine) {
  const [{ runTrackerOffline }, { normalizeTrackReport }] = await Promise.all([import('../lib/run-tracker-offline.mjs'), import('../../dist/track-status.js')]);
  const r = await runTrackerOffline(path, { engine: engine === 'legacy' ? 'legacy' : 'v2' }), ui = normalizeTrackReport(r.result);
  return { result: { ...r.result, status: ui.status, reasonCodes: ui.reasonCodes }, sampling: r.sampling, analysis: { width: r.meta.analysisWidth, height: r.meta.analysisHeight }, fed: r.fed };
}

/** One clip in this process: result plus runtime (elapsed, per-phase ms from progress events, peak memory). */
export async function runClip(job, ctx = {}) {
  const t0 = performance.now(), phases = [], mem = { rss: 0, heap: 0 };
  const sample = () => { const u = process.memoryUsage(); mem.rss = Math.max(mem.rss, u.rss); mem.heap = Math.max(mem.heap, u.heapUsed); };
  const timer = setInterval(sample, 25);
  timer.unref?.();
  const onProgress = p => { if (phases.at(-1)?.phase !== p.phase) phases.push({ phase: p.phase, t: performance.now() - t0 }); };
  let result = null, error = null, extra = {};
  try {
    if (job.engine === 'hf') {
      const hf = ctx.hf ?? await hfRunner({ entry: job.entry });
      const src = await hf.open(job.video);
      extra = { entry: hf.entry, source: hf.source, path: src.meta.path, frameCount: src.meta.frameCount };
      try { result = await hf.run(src, { diagnostics: !!job.diagnostics }, onProgress); } finally { await src.close(); }
    } else {
      const r = await runMotionTracker(job.video, job.engine);
      result = r.result;
      extra = { entry: 'MotionTracker', source: 'run-tracker-offline', analysis: r.analysis, sampling: r.sampling, frameCount: r.sampling.decoded };
    }
  } catch (e) { error = `${e.name}: ${e.message}`; }
  clearInterval(timer); sample();
  const elapsedMs = performance.now() - t0, ph = {};
  phases.forEach((p, i) => { ph[p.phase] = (phases[i + 1]?.t ?? elapsedMs) - p.t; });
  return {
    id: job.id, result, error,
    runtime: { elapsedMs, phases: ph, peakRssMb: mem.rss / 2 ** 20, peakHeapMb: mem.heap / 2 ** 20, maxRssLifetimeMb: process.resourceUsage().maxRSS / 1024, ...extra }
  };
}

/* ------------------------------------------------------------------ code identity, run log (parent side) */

const V2_FILES = ['dist/tracker.js', 'dist/global-associate.js', 'dist/roi-evidence.js', 'dist/refiner.js', 'dist/curve.js', 'dist/track-status.js', 'dist/frame-source.js', 'tests/lib/run-tracker-offline.mjs'];
export const ENGINE_FILES = Object.freeze({ hf: ['dist/hf', 'tests/hf/helpers/node-source.mjs'], v2: V2_FILES, legacy: V2_FILES, app: ['dist'] });
const BENCH_FILES = ['tests/bench/metrics.mjs', 'tests/bench/gate.mjs', 'tests/bench/acceptance.json', 'tests/bench/report.mjs', 'tests/bench/corpus.mjs', 'tests/bench/run-node.mjs', 'tests/bench/run-browser.mjs', 'tests/bench/cdp.mjs'];

async function hashFiles(paths) {
  const files = [];
  const walk = async p => {
    const s = await stat(p).catch(() => null);
    if (s?.isDirectory()) { for (const e of await readdir(p)) await walk(join(p, e)); } else if (s && /\.(m?js|json|html|css)$/.test(p)) files.push(p);
  };
  for (const p of paths) await walk(join(ROOT, p));
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(relative(ROOT, f)).update('\0').update(await readFile(f)).update('\0');
  return { hash: h.digest('hex').slice(0, 12), files: files.length };
}

/** Content hashes of the engine's code (what a result depends on), of the bench code, and of both (logged with every run). */
export async function codeIdentity(engine = 'hf') {
  const [e, b, all] = await Promise.all([hashFiles(ENGINE_FILES[engine] ?? ENGINE_FILES.hf), hashFiles(BENCH_FILES), hashFiles([...(ENGINE_FILES[engine] ?? []), ...BENCH_FILES])]);
  const git = args => { try { return execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const porcelain = git(['status', '--porcelain']);
  return { codeHash: all.hash, engineHash: e.hash, benchHash: b.hash, files: all.files, gitSha: git(['rev-parse', '--short', 'HEAD']), dirty: porcelain == null ? null : porcelain.length > 0 };
}

export const ffmpegVersion = () => { try { return run(FFMPEG, ['-version']).split('\n')[0]; } catch { return null; } };

/** Splits in the clips; holdout runs need explicit consent (rationed, FINAL acceptance gate). */
export function splitOf(clips, corpus) {
  const s = [...new Set(clips.map(c => c.split).filter(Boolean))];
  return s.length === 1 ? s[0] : s.length ? s.join('+') : basename(corpus);
}
/** Append a run to <corpus parent>/bench-runs.jsonl (or `file`; 'none' logs nothing). */
export async function logRun(corpus, entry, file = null) {
  if (file === 'none') return null;
  file = file ? resolve(file) : join(dirname(resolve(corpus)), 'bench-runs.jsonl');
  await appendFile(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n').catch(() => {});
  return file;
}

/**
 * The per-clip result log next to a report: one JSON line per finished clip ({id, key, result, error, runtime}).
 * resume keeps the lines already there (the last line of an id wins) for the caller to reuse by key; otherwise the
 * log starts empty. Appends are serialized.
 */
export async function openClipLog(file, { resume = false } = {}) {
  const done = new Map();
  if (resume) {
    for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
      try { const e = JSON.parse(line); if (e?.id) done.set(e.id, e); } catch { /* a line torn by a kill */ }
    }
  } else await writeFile(file, '');
  let chain = Promise.resolve();
  return { file, done, append: e => (chain = chain.then(() => appendFile(file, JSON.stringify(e) + '\n'))), flush: () => chain };
}

/* ------------------------------------------------------------------ parallel pool with a watchdog */

/** RSS (MB) of each pid, from one ps call; missing pids are absent. */
export function rssMb(pids) {
  if (!pids.length) return new Map();
  try {
    return new Map(execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(([p, r]) => p > 0 && r >= 0).map(([p, r]) => [p, r / 1024]));
  } catch { return new Map(); }
}

/**
 * Run jobs on `jobs` forked children of `script` (one clip at a time each); onDone(msg) per clip. A child past
 * timeoutMs or maxRssMb on its clip is killed (the clip ends with that error) and replaced.
 */
export async function runPool(queue, { jobs, timeoutMs, maxRssMb = null, onDone, script = fileURLToPath(import.meta.url), execArgv = ['--max-old-space-size=8192'], tickMs = 500 }) {
  queue = [...queue];
  await new Promise(resolveAll => {
    const live = new Set();
    let active = 0;
    const tick = setInterval(() => {
      const busy = [...live].filter(w => w.job);
      const rss = rssMb(busy.map(w => w.child.pid));
      for (const w of busy) {
        const mb = rss.get(w.child.pid) ?? 0, ms = performance.now() - w.started;
        w.peakMb = Math.max(w.peakMb, mb);
        if (ms > timeoutMs) w.stop(`watchdog: timeout after ${+(timeoutMs / 1000).toFixed(1)} s`);
        else if (maxRssMb && mb > maxRssMb) w.stop(`watchdog: RSS ${mb.toFixed(0)} MB over the ${maxRssMb} MB limit`);
      }
    }, tickMs);
    const finish = () => { clearInterval(tick); resolveAll(); };
    const start = () => {
      const child = fork(script, ['--child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', execArgv });
      const w = { child, job: null, started: 0, peakMb: 0 };
      const runtime = () => ({ elapsedMs: performance.now() - w.started, watchdogPeakRssMb: w.peakMb });
      w.stop = reason => { const job = w.job; w.job = null; onDone({ id: job.id, result: null, error: reason, runtime: runtime() }); child.kill('SIGKILL'); };
      const next = () => {
        w.job = queue.shift() ?? null;
        if (!w.job) { child.kill(); return; }
        w.started = performance.now(); w.peakMb = 0;
        child.send({ type: 'run', job: w.job });
      };
      live.add(w); active++;
      child.on('message', m => { if (m.type !== 'done' || !w.job || m.id !== w.job.id) return; m.runtime = m.runtime && { ...m.runtime, watchdogPeakRssMb: w.peakMb }; w.job = null; onDone(m); next(); });
      child.on('exit', code => {
        if (w.job) { const job = w.job; w.job = null; onDone({ id: job.id, result: null, error: `child exited (${code})`, runtime: runtime() }); }
        live.delete(w); active--;
        if (queue.length) start(); else if (active === 0) finish();
      });
      next();
    };
    for (let i = 0; i < Math.min(jobs, queue.length); i++) start();
    if (!queue.length && active === 0) finish();
  });
}

/* ------------------------------------------------------------------ CLI */

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
/** --with: sibling split names to add (default controls,perf; 'none' adds none). */
export const withSets = v => (v == null || v === true ? [...EXTRA_SETS] : v === 'none' ? [] : String(v).split(',').filter(Boolean));

/** Scores one finished clip (result, error, runtime) against its GT file; hf results are validated first. */
export function scoreRun(m, clip, { engine, files, keep = false }) {
  const gt = JSON.parse(readFileSync(clip.gtPath, 'utf8')), video = gt.meta?.video ?? {};
  let valid = null, validationErrors = [];
  if (m.result && engine === 'hf') ({ ok: valid, errors: validationErrors } = validateResult(m.result, { width: video.width, height: video.height, fps: video.fpsOut }));
  const s = scoreClip(m.result, gt, { runtime: m.runtime, error: m.error, valid, validationErrors: validationErrors.slice(0, 5), files: files.get(clip.id) ?? null });
  if (keep) s.result = m.result;
  return s;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!a.corpus || a.help) {
    console.log('Usage: node tests/bench/run-node.mjs --corpus DIR[,DIR] [--with controls,perf|none] [--engine hf|v2|legacy] [--only id,id] [--limit N] [--jobs N] [--out report.json] [--md report.md] [--entry runHF|analyzeClip] [--timeout-s 900] [--max-rss-mb 4096] [--resume] [--allow-holdout] [--keep-results] [--diagnostics] [--run-log FILE|none]');
    process.exit(a.help ? 0 : 1);
  }
  const engine = a.engine ?? 'hf', entry = engine === 'hf' ? (a.entry === 'analyzeClip' ? 'analyzeClip' : 'runHF') : 'MotionTracker';
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${engine}; use ${ENGINES.join('|')}`);
  const dirs = resolveCorpora(a.corpus, withSets(a.with)), corpus = dirs[0].dir;
  const clips = await listClips(dirs, { only: a.only ? String(a.only).split(',') : null, limit: a.limit ? +a.limit : null });
  if (!clips.length) throw new Error(`no <id>.gt.json clips in ${dirs.map(d => d.dir).join(', ')}`);
  const split = splitOf(clips, corpus);
  if (/holdout/.test(split) && !a['allow-holdout']) throw new Error('holdout runs are rationed: pass --allow-holdout (the run is logged with the code hash)');
  const tPin = performance.now(), { pin, files, stats } = await pinCorpus(dirs);
  const code = await codeIdentity(engine), ffmpeg = ffmpegVersion();
  const out = resolve(a.out ?? `${basename(corpus)}-${engine}-node.json`), md = a.md ? resolve(a.md) : out.replace(/\.json$/, '') + '.md';
  const log = await openClipLog(out.replace(/\.json$/, '') + '.clips.jsonl', { resume: !!a.resume });
  const jobs = Math.max(1, +(a.jobs ?? Math.max(1, Math.min(clips.length, Math.floor(availableParallelism() / 2)))));
  const timeoutMs = (+(a['timeout-s'] ?? 900)) * 1000, maxRssMb = a['max-rss-mb'] === 'none' ? null : +(a['max-rss-mb'] ?? 4096);
  const keyOf = id => sha256(JSON.stringify({ engine, entry, engineHash: code.engineHash, diagnostics: !!a.diagnostics, files: files.get(id), node: process.version, ffmpeg }));
  const added = dirs.filter(d => d.added).map(d => basename(d.dir));
  console.error(`run-node: ${engine} on ${clips.length} clips of ${dirs.map(d => d.dir).join(', ')} (${split}), ${jobs} jobs, engine ${code.engineHash}${code.dirty ? ' (dirty)' : ''}, ` +
    `generator ${pin.generator.version ?? 'mixed'}, manifest ${pin.manifestSha256.slice(0, 12)} (hashed in ${((performance.now() - tPin) / 1000).toFixed(1)} s)${added.length ? `, with ${added.join(', ')}` : ''}`);
  for (const [s, p] of Object.entries(pin.splits)) if (p.checksums === 'mismatch') console.error(`run-node: WARNING ${p.dir}/checksums.sha256 does not match its files (split ${s} changed after indexing)`);
  const startedAt = new Date().toISOString(), t0 = performance.now(), byId = new Map(clips.map(c => [c.id, c])), scored = [];
  const take = (m, reused = false) => {
    const s = scoreRun(m, byId.get(m.id), { engine, files, keep: !!a['keep-results'] });
    if (reused) s.reused = true;
    scored.push(s);
    console.error(`[${scored.length}/${clips.length}] ${m.id}: ${m.error ?? `${s.outcome}${s.wrong ? ` WRONG(${s.wrongReasons.join('+')})` : ''}`}${m.runtime ? ` ${(m.runtime.elapsedMs / 1000).toFixed(1)} s` : ''}${reused ? ' (resumed)' : ''}`);
  };
  const queue = [];
  for (const c of clips) {
    const prev = log.done.get(c.id);
    if (prev && prev.key === keyOf(c.id)) take(prev, true);
    else queue.push({ id: c.id, video: c.video, engine, entry, diagnostics: !!a.diagnostics });
  }
  if (a.resume) console.error(`run-node: resumed ${clips.length - queue.length} clips from ${log.file}, running ${queue.length}`);
  await runPool(queue, { jobs, timeoutMs, maxRssMb, onDone: ({ type, ...m }) => { log.append({ ...m, key: keyOf(m.id) }); take(m); } });
  await log.flush();
  const changed = await changedFiles(stats);
  Object.assign(pin, { stable: changed.length === 0, changed: changed.map(f => relative(dirname(corpus), f)), clipsSha256: clipsSha256(clips, files) });
  if (changed.length) console.error(`run-node: WARNING ${changed.length} corpus files changed during the run; the report is not comparable`);
  scored.sort((x, y) => x.id.localeCompare(y.id));
  const report = buildReport(scored, {
    runner: 'node', engine, entry, source: engine === 'hf' ? 'node-source' : 'run-tracker-offline', corpus: dirs.map(d => d.dir).join(','), split, generator: pin.generator, corpusPin: pin,
    code, startedAt, finishedAt: new Date().toISOString(), wallMs: performance.now() - t0, jobs, node: process.version, ffmpeg, paramsVersion: PARAMS_VERSION,
    options: { timeoutS: timeoutMs / 1000, maxRssMb, diagnostics: !!a.diagnostics, with: added, resumed: clips.length - queue.length, clipLog: log.file },
    notes: [jobs > 1 ? `Runtime was measured with ${jobs} parallel jobs; use --jobs 1 for timing.` : 'Runtime measured with one job.']
  });
  await writeFile(out, JSON.stringify(report));
  await writeFile(md, renderMarkdown(report));
  const runLog = await logRun(corpus, { runner: 'node', engine, split, corpus: report.corpus, clips: clips.length, codeHash: code.codeHash, engineHash: code.engineHash, gitSha: code.gitSha, dirty: code.dirty, manifestSha256: pin.manifestSha256, generator: pin.generator, out, gatePass: report.gate.pass }, a['run-log'] === true ? null : a['run-log']);
  console.error(`run-node: wrote ${out} and ${md}; gate ${report.gate.pass ? 'PASS' : 'FAIL'} (${report.gate.failures.join(', ') || 'no failures'})${runLog ? `; logged to ${runLog}` : ''}`);
  return report;
}

/* ------------------------------------------------------------------ child entry */

if (process.argv.includes('--child') && process.send) {
  let hf = null;
  process.on('message', async m => {
    if (m.type !== 'run') return;
    if (m.job.engine === 'hf' && !hf) hf = await hfRunner({ entry: m.job.entry }).catch(e => ({ error: e }));
    const r = hf?.error ? { id: m.job.id, result: null, error: `${hf.error.name}: ${hf.error.message}`, runtime: null } : await runClip(m.job, { hf });
    process.send({ type: 'done', ...r });
  });
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
