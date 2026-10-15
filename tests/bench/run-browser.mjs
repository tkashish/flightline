#!/usr/bin/env node
/**
 * Browser benchmark runner (U7): the real app in headless Chrome over CDP, one clip per fresh tab, scored with the
 * same metrics as run-node.mjs. Serves dist/ at / and the corpus at /corpus/ with HTTP Range support (element-path
 * seeks need it), uploads each clip with DOM.setFileInputFiles, samples worker heap and renderer RSS while the app
 * analyzes, and verifies the exported video of every 10th traced clip with ffmpeg.
 *
 *   node tests/bench/run-browser.mjs --corpus DIR[,DIR] [--with controls,perf|none] [--engine hf|v2|legacy]
 *        [--path auto|codec|element] [--only id,id] [--limit N] [--out report.json] [--md report.md]
 *        [--export-frac 0.1] [--timeout-s 600] [--headed] [--isolate] [--resume] [--allow-holdout] [--keep-exports DIR]
 *        [--run-log FILE|none]
 *
 * App hook (dist/app.js, only with ?bench=1; I1 and U7 share exactly this contract):
 *   window.__flightlineBench = { ready: true, version }              once the app has loaded
 *   window.__flightlineLastResult = { engine, status, result,        after every single-clip analysis, success or not:
 *     timings: { analysisMs, phases: { <phase>: ms } },              engine 'hf'|'v2'|'legacy', status as the UI shows it,
 *     frameTiming, error: null | string }                            result the engine's (hf: the HFResult); phases
 *                                                                    include the one a failed or cancelled run was in; a
 *                                                                    pick the app's check refuses sets it too (status,
 *                                                                    result and timings null/empty, error the refusal)
 *   window.__flightlineLastExport = { mime, bytes, durationSec }     after an export
 *   ?engine=hf|v2|legacy selects the engine; ?decode=auto|codec|element forces the hf decode path.
 * The runner clears __flightlineLastResult / __flightlineLastExport before each upload / export and waits for the
 * app to set them again. Export uses the app's own #export button; the download is captured with
 * Browser.setDownloadBehavior and must match __flightlineLastExport.bytes. Corpus pin, --with and --resume
 * (`<out>.clips.jsonl`) work as in run-node.mjs.
 */
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, rmSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PARAMS_VERSION } from '../../dist/hf/params.js';
import { scoredView } from './metrics.mjs';
import { buildReport, renderMarkdown } from './report.mjs';
import { codeIdentity, splitOf, logRun, probeVideo, ffmpegVersion, ENGINES, openClipLog, parseArgs, withSets, scoreRun } from './run-node.mjs';
import { resolveCorpora, listClips, pinCorpus, clipsSha256, changedFiles } from './corpus.mjs';
import { launchChrome, openPage, setFiles, workerHeapsMb, RendererMemory } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg', FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ static server with Range */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'
};

/** Parse a single-range `Range: bytes=...` header; null = whole file, false = unsatisfiable. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return false;
  let start, end;
  if (m[1] === '') { const n = +m[2]; if (!n) return false; start = Math.max(0, size - n); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  return start <= end && start < size ? { start, end } : false;
}

/**
 * Static server for mounts {urlPrefix: dir}, longest prefix first: Range (206/416), HEAD, no-store, no traversal.
 * isolate adds COOP/COEP so performance.measureUserAgentSpecificMemory() is available to the page.
 */
export async function serveStatic(mounts, { port = 0, isolate = false } = {}) {
  const table = Object.entries(mounts).map(([p, d]) => [p.endsWith('/') ? p : `${p}/`, resolve(d)]).sort((a, b) => b[0].length - a[0].length);
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'accept-ranges': 'bytes', ...(isolate ? { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' } : {}) };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); return res.end(); }
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const mount = table.find(([p]) => path === p.slice(0, -1) || path.startsWith(p));
      if (!mount) { res.writeHead(404, headers); return res.end(); }
      let rel = path.slice(mount[0].length - 1);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = normalize(join(mount[1], rel));
      if (file !== mount[1] && !file.startsWith(mount[1] + sep)) { res.writeHead(403, headers); return res.end(); }
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) { res.writeHead(404, headers); return res.end(); }
      headers['content-type'] = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const range = parseRange(req.headers.range, st.size);
      if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}` }); return res.end(); }
      const { start, end } = range ?? { start: 0, end: st.size - 1 };
      res.writeHead(range ? 206 : 200, { ...headers, 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}) });
      if (req.method === 'HEAD' || st.size === 0) return res.end();
      createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch (e) { res.writeHead(500, headers); res.end(String(e.message)); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/* ------------------------------------------------------------------ export verification */

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
/** One RGB frame at time t scaled to w×h (accurate seek), or null. RGB, not luma: a yellow tracer on a bright sky is a small luma change. */
function grab(file, t, w, h) {
  let b;
  try { b = run(FFMPEG, ['-v', 'error', '-i', file, '-ss', String(Math.max(0, t)), '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=bilinear`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']); } catch { return null; }
  return b.length === w * h * 3 ? new Uint8Array(b.buffer, b.byteOffset, b.length) : null;
}

/**
 * Check an exported video: a video stream, an audio stream when the source has one, and tracer pixels: at the
 * result's own drawn points (raw px), the export must differ from the source frame by > 40 levels in some RGB channel
 * in at least half of the sampled places (points older than 0.15 s, so the ball itself has moved on, which also
 * absorbs the export's few-frame start lag). The frames compared are 0.1 s inside the end of both videos (an accurate
 * seek to the last frame's tail yields no frame); tracer: 'checked', 'few-points' (under 5 drawn points to sample:
 * not judged) or 'no-frame' (the frames could not be read: the export fails).
 */
export function verifyExport(file, { video, view, width, height, sourceHasAudio, sourceDuration = null }) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,format_name', '-of', 'json', file]).toString());
  const v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio'), duration = Number(j.format?.duration) || null;
  const out = { hasVideo: !!v, hasAudio: !!a, sourceHasAudio, duration, format: j.format?.format_name ?? null, codec: v?.codec_name ?? null, size: v ? `${v.width}x${v.height}` : null, tracer: 'few-points', tracerChecked: 0, tracerHitFrac: null, preLaunchHitFrac: null };
  if (v && view?.observed?.length && view.launch) {
    const tB = Math.min(view.observed.at(-1).t + 0.1, (duration ?? Infinity) - 0.1, (sourceDuration ?? Infinity) - 0.1), w = 360, h = 2 * Math.round(180 * height / width);
    const pts = view.points.filter(p => p.t >= view.launch.t + 0.03 && p.t <= tB - 0.15 && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
    const step = Math.max(1, Math.floor(pts.length / 40)), sample = pts.filter((_, i) => i % step === 0);
    const hits = (E, S) => {
      let n = 0;
      for (const p of sample) {
        const cx = Math.round(p.x * w / width), cy = Math.round(p.y * h / height);
        let best = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const o = 3 * (y * w + x);
          best = Math.max(best, Math.abs(E[o] - S[o]), Math.abs(E[o + 1] - S[o + 1]), Math.abs(E[o + 2] - S[o + 2]));
        }
        if (best > 40) n++;
      }
      return sample.length ? n / sample.length : null;
    };
    if (sample.length >= 5) {
      const E = grab(file, tB, w, h), S = grab(video, tB, w, h);
      out.tracer = E && S ? 'checked' : 'no-frame';
      if (E && S) { out.tracerChecked = sample.length; out.tracerHitFrac = hits(E, S); out.tracerT = tB; }
      const tA = view.launch.t - 0.3;
      if (tA > 0) { const E0 = grab(file, tA, w, h), S0 = grab(video, tA, w, h); if (E0 && S0) out.preLaunchHitFrac = hits(E0, S0); }
    }
  }
  out.pass = out.hasVideo && (!sourceHasAudio || out.hasAudio) && (out.tracer === 'few-points' || (out.tracer === 'checked' && out.tracerHitFrac >= 0.5));
  return out;
}

/* ------------------------------------------------------------------ one clip */

/** Seconds a page gets to announce the hook (window.__flightlineBench.ready) after it has loaded. */
export const HOOK_WAIT_MS = 20000;
const HOOK_READY = `(() => window.__flightlineBench?.ready === true && !!document.getElementById('fileInput') && JSON.stringify({ version: window.__flightlineBench.version ?? null }))()`;
const LAST = name => `(() => { const r = window.${name}; return r == null ? null : JSON.stringify(r); })()`;

/**
 * Analyze one clip in a fresh tab through the ?bench=1 hook; exportIf(shown) decides whether to export it there too.
 * Returns {result (the engine's), shown (with the UI status), uiStatus, error, runtime, exported, hookVersion}.
 */
export async function runBrowserClip(chrome, base, clip, { engine, path = 'auto', timeoutMs, exportIf = () => false, downloadDir = null, keepExports = null, hookWaitMs = HOOK_WAIT_MS } = {}) {
  const url = `${base}/index.html?bench=1&engine=${engine}${path !== 'auto' ? `&decode=${path}` : ''}`;
  const page = await openPage(chrome.cdp, url);
  const mem = { heap: 0, main: 0 }, rss = new RendererMemory(chrome.cdp);
  try {
    let hook;
    try { hook = JSON.parse(await page.waitFor(HOOK_READY, { timeoutMs: hookWaitMs })); } catch { throw new Error(`no bench hook: ${url} never set window.__flightlineBench.ready`); }
    await rss.baseline();
    const sample = async () => {
      const hs = (await workerHeapsMb(chrome.cdp, page)).filter(Number.isFinite);
      if (hs.length) mem.heap = Math.max(mem.heap, ...hs);
      const m = await page.send('Runtime.getHeapUsage').then(r => r.usedSize / 2 ** 20, () => null);
      if (Number.isFinite(m)) mem.main = Math.max(mem.main, m);
      await rss.sample();
      if (page.crashed) throw new Error('renderer crashed');
    };
    await page.evaluate('window.__flightlineLastResult = null, window.__flightlineLastExport = null, true');
    const t0 = performance.now();
    await setFiles(page, '#fileInput', [clip.video]);
    const got = JSON.parse(await page.waitFor(LAST('__flightlineLastResult'), { timeoutMs, intervalMs: 250, onTick: sample }));
    const elapsedMs = performance.now() - t0;
    await sample().catch(() => {});
    const tab = rss.result(), result = got.result ?? null, ui = got.status ?? null;
    const runtime = {
      elapsedMs, phases: got.timings?.phases ?? {}, appAnalysisMs: got.timings?.analysisMs ?? null, path: got.frameTiming?.path ?? result?.diagnostics?.path ?? null, frameTiming: got.frameTiming ?? null,
      peakWorkerHeapMb: mem.heap || null, peakMainHeapMb: mem.main || null, peakTabRssMb: tab.peakMb, tabRssIncreaseMb: tab.increaseMb, tabRenderer: { pid: tab.pid, cpuSec: tab.cpuSec, renderers: tab.renderers }
    };
    if (got.engine !== engine) return { result: null, shown: null, uiStatus: ui, error: `the app ran engine ${got.engine}, not ${engine}`, runtime, exported: null, hookVersion: hook.version };
    // What the user sees: the engine result with the status the UI applied (normalizeTrackReport only downgrades).
    const shown = result && ui && ui !== result.status ? { ...result, status: ui } : result;
    let exported = null;
    if (shown && !got.error && exportIf(shown)) exported = await exportClip(chrome, page, clip, shown, downloadDir, keepExports).catch(e => ({ pass: false, error: e.message }));
    return { result, shown, uiStatus: ui, error: got.error ?? null, runtime, exported, hookVersion: hook.version };
  } finally { await page.close(); }
}

/** Export through the app's button; the captured download must be what __flightlineLastExport reports. */
async function exportClip(chrome, page, clip, result, downloadDir, keepExports) {
  const ok = await page.evaluate(`!document.getElementById('export').disabled`);
  if (!ok) return { pass: null, skipped: 'export disabled (not exportable)' };
  const info = probeVideo(clip.video), cdp = chrome.cdp, limit = (info.duration * 2 + 120) * 1000;
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
  const begin = cdp.once('Browser.downloadWillBegin', { timeoutMs: limit });
  await page.evaluate(`window.__flightlineLastExport = null, document.getElementById('export').click(), true`);
  const { guid } = await begin;
  const done = await cdp.once('Browser.downloadProgress', { filter: p => p.guid === guid && p.state !== 'inProgress', timeoutMs: 60000 });
  if (done.state !== 'completed') return { pass: false, error: `download ${done.state}` };
  const hook = JSON.parse(await page.waitFor(LAST('__flightlineLastExport'), { timeoutMs: 10000 }).catch(() => 'null'));
  const file = join(downloadDir, guid), bytes = statSync(file).size, view = scoredView(result, { width: info.width, height: info.height });
  const v = verifyExport(file, { video: clip.video, view, width: info.width, height: info.height, sourceHasAudio: info.hasAudio, sourceDuration: info.duration });
  v.hook = hook; v.bytes = bytes;
  v.hookMatches = !!hook && hook.bytes === bytes && /^video\/(mp4|webm)/.test(hook.mime ?? '') && (hook.mime.startsWith('video/webm') === /webm|matroska/.test(v.format ?? ''));
  v.pass = v.pass && v.hookMatches;
  if (keepExports) { v.kept = join(keepExports, `${clip.id}.export${/webm|matroska/.test(v.format ?? '') ? '.webm' : '.mp4'}`); copyFileSync(file, v.kept); }
  rmSync(file, { force: true });
  return v;
}

/* ------------------------------------------------------------------ CLI */

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!a.corpus || a.help) {
    console.log('Usage: node tests/bench/run-browser.mjs --corpus DIR[,DIR] [--with controls,perf|none] [--engine hf|v2|legacy] [--path auto|codec|element] [--only id,id] [--limit N] [--out report.json] [--md report.md] [--export-frac 0.1] [--timeout-s 600] [--headed] [--isolate] [--resume] [--allow-holdout] [--keep-exports DIR] [--run-log FILE|none]');
    process.exit(a.help ? 0 : 1);
  }
  const engine = a.engine ?? 'hf', path = a.path ?? 'auto', exportFrac = +(a['export-frac'] ?? 0.1);
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${engine}`);
  const dirs = resolveCorpora(a.corpus, withSets(a.with)), corpus = dirs[0].dir;
  const clips = await listClips(dirs, { only: a.only ? String(a.only).split(',') : null, limit: a.limit ? +a.limit : null });
  if (!clips.length) throw new Error(`no <id>.gt.json clips in ${dirs.map(d => d.dir).join(', ')}`);
  const split = splitOf(clips, corpus);
  if (/holdout/.test(split) && !a['allow-holdout']) throw new Error('holdout runs are rationed: pass --allow-holdout (the run is logged with the code hash)');
  const { pin, files, stats } = await pinCorpus(dirs), code = await codeIdentity('app');
  const out = resolve(a.out ?? `${basename(corpus)}-${engine}-browser.json`), md = a.md ? resolve(a.md) : out.replace(/\.json$/, '') + '.md';
  const log = await openClipLog(out.replace(/\.json$/, '') + '.clips.jsonl', { resume: !!a.resume });
  const server = await serveStatic({ '/': join(ROOT, 'dist'), '/corpus/': dirname(corpus) }, { isolate: !!a.isolate });
  const chrome = await launchChrome({ headless: !a.headed });
  const keyOf = id => createHash('sha256').update(JSON.stringify({ engine, path, engineHash: code.engineHash, files: files.get(id), chrome: chrome.version.product })).digest('hex');
  const downloadDir = mkdtempSync(join(tmpdir(), 'flightline-bench-dl-'));
  const startedAt = new Date().toISOString(), t0 = performance.now(), scored = [], every = exportFrac > 0 ? Math.max(1, Math.round(1 / exportFrac)) : Infinity;
  let traced = 0, hookVersion = null;
  console.error(`run-browser: ${engine} (${path}) on ${clips.length} clips, ${chrome.version.product}, serving ${server.url}, app ${code.engineHash}, manifest ${pin.manifestSha256.slice(0, 12)}`);
  try {
    for (const c of clips) {
      const prev = log.done.get(c.id), gt = JSON.parse(readFileSync(c.gtPath, 'utf8')), dur = gt.meta?.video?.durationS ?? 10;
      let r;
      if (prev && prev.key === keyOf(c.id)) r = { ...prev, reused: true };
      else {
        const exportIf = res => scoredView(res, { width: gt.meta.video.width, height: gt.meta.video.height }).traced && traced++ % every === 0;
        try {
          r = await runBrowserClip(chrome, server.url, c, { engine, path, timeoutMs: (+(a['timeout-s'] ?? Math.max(120, 30 * dur))) * 1000, exportIf, downloadDir, keepExports: a['keep-exports'] ? resolve(a['keep-exports']) : null });
        } catch (e) { r = { result: null, shown: null, error: `${e.name}: ${e.message}`, runtime: null, exported: null }; }
        hookVersion ??= r.hookVersion ?? null;
        await log.append({ id: c.id, key: keyOf(c.id), result: r.shown, error: r.error, runtime: r.runtime, uiStatus: r.uiStatus ?? null, exported: r.exported ?? null });
      }
      const s = scoreRun({ id: c.id, result: r.shown ?? r.result ?? null, error: r.error, runtime: r.runtime }, c, { engine, files });
      Object.assign(s, { uiStatus: r.uiStatus ?? null, exported: r.exported ?? null }, r.reused ? { reused: true } : {});
      scored.push(s);
      console.error(`[${scored.length}/${clips.length}] ${c.id}: ${r.error ?? `${s.outcome}${s.wrong ? ` WRONG(${s.wrongReasons.join('+')})` : ''}`}${r.runtime ? ` ${(r.runtime.elapsedMs / 1000).toFixed(1)} s, heap ${r.runtime.peakWorkerHeapMb?.toFixed(0) ?? '?'} MB, rss +${r.runtime.tabRssIncreaseMb?.toFixed(0) ?? '?'} MB` : ''}${s.exported ? ` export ${s.exported.pass ? 'ok' : 'FAIL'}` : ''}${r.reused ? ' (resumed)' : ''}`);
    }
  } finally {
    await log.flush(); await chrome.close(); await server.close(); rmSync(downloadDir, { recursive: true, force: true });
  }
  const changed = await changedFiles(stats);
  Object.assign(pin, { stable: changed.length === 0, changed: changed.map(f => relative(dirname(corpus), f)), clipsSha256: clipsSha256(clips, files) });
  const exports = scored.filter(c => c.exported && c.exported.pass !== null);
  const report = buildReport(scored, {
    runner: 'browser', engine, path, entry: 'app', corpus: dirs.map(d => d.dir).join(','), split, generator: pin.generator, corpusPin: pin, code, startedAt, finishedAt: new Date().toISOString(),
    wallMs: performance.now() - t0, jobs: 1, chrome: chrome.version.product, node: process.version, ffmpeg: ffmpegVersion(), paramsVersion: PARAMS_VERSION, hookVersion,
    exportCheck: { checked: exports.length, passed: exports.filter(c => c.exported.pass).length, every }, options: { with: dirs.filter(d => d.added).map(d => basename(d.dir)), clipLog: log.file }
  });
  await writeFile(out, JSON.stringify(report));
  await writeFile(md, renderMarkdown(report) + `\nExport check: ${report.exportCheck.passed}/${report.exportCheck.checked} exported videos verified (every ${every}th traced clip).\n`);
  const runLog = await logRun(corpus, { runner: 'browser', engine, path, split, corpus: report.corpus, clips: clips.length, codeHash: code.codeHash, engineHash: code.engineHash, gitSha: code.gitSha, dirty: code.dirty, manifestSha256: pin.manifestSha256, generator: pin.generator, out, gatePass: report.gate.pass }, a['run-log'] === true ? null : a['run-log']);
  console.error(`run-browser: wrote ${out} and ${md}; gate ${report.gate.pass ? 'PASS' : 'FAIL'}${runLog ? `; logged to ${runLog}` : ''}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
