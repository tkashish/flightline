#!/usr/bin/env node
// Browser decode bench (U1). Headless Chrome over CDP decodes barcode-indexed clips through the WebCodecs path (a
// module worker running openFrameSource) and the element path (serveElementFrames on the page, RemoteFrameSource
// in the worker), and checks every frame: barcode == frame index (no duplicates, skips or wrong frames), t equals
// the ffprobe pts exactly, the upright image agrees with what <video> renders, and pixels equal the Node ffmpeg
// source (per-frame hash of lumaCoarse(960) and of the barcode crop). Then it times the codec path at 1080p30 and
// 4K60 (decode only, + lumaCoarse, + two 256² lumaRect crops) and the element path.
// Usage: node tests/bench/browser-decode.mjs [--quick] [--only name,...] [--out report.json] [--headed] [--chrome PATH]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { buildFixtures, probeFrames, readBarcode, barcodeRect, fnv, UNIT_FIXTURES } from '../hf/helpers/decode-fixtures.mjs';
import { openNodeSource } from '../hf/helpers/node-source.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; }, flag = k => args.includes(`--${k}`);
const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CHROME = opt('chrome', process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const OUT = opt('out', null), QUICK = flag('quick'), ONLY = opt('only', null)?.split(',');
const PERF = QUICK ? ['perf-1080p30'] : ['perf-1080p30', 'perf-4k60', 'perf-4k60-hevc'];
const CHECK = UNIT_FIXTURES.filter(n => !['mpeg4', 'no-moov', 'audio-only'].includes(n));
const log = (...a) => console.error(...a);

/* ---------------------------------------------------------------- page + worker (served from memory) */

const PAGE = `<!doctype html><meta charset="utf-8"><title>loading</title><body>
<script type="module">
import { serveElementFrames } from '/dist/hf/decode/element-source.js';
import { readBarcode, fnv } from '/tests/hf/helpers/barcode.mjs';
window.runPath = async (url, prefer, opts) => {
  const blob = await (await fetch(url)).blob();
  const worker = new Worker('/__bench/worker.js', { type: 'module' });
  let port = null, serving = null;
  if (prefer !== 'codec') { const ch = new MessageChannel(); port = ch.port2; serving = serveElementFrames(blob, ch.port1); }
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = e => resolve(e.data);
      worker.onerror = e => reject(new Error(e.message));
      worker.postMessage({ blob, prefer, opts, port }, port ? [port] : []);
    });
  } finally { worker.terminate(); }
};
// What the <video> element itself shows: size, and the barcode of the frame at each requested frame centre.
window.videoReference = async (url, times) => {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; document.body.appendChild(v);
  v.src = URL.createObjectURL(await (await fetch(url)).blob());
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video load')); });
  const W = v.videoWidth, H = v.videoHeight, c = new OffscreenCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true }), out = [];
  for (const [k, t] of times) {
    const md = new Promise(r => v.requestVideoFrameCallback((now, m) => r(m)));
    await new Promise(r => { v.onseeked = r; v.currentTime = t; });
    const m = await Promise.race([md, new Promise(r => setTimeout(r, 400, null))]);
    ctx.drawImage(v, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data, y = new Uint8Array(W * H);
    for (let i = 0; i < y.length; i++) y[i] = (54 * d[4 * i] + 183 * d[4 * i + 1] + 19 * d[4 * i + 2] + 128) >> 8;
    out.push({ k, code: readBarcode(y, W, H), mediaTime: m?.mediaTime ?? null });
  }
  v.remove();
  return { W, H, frames: out };
};
document.title = 'ready';
</script>`;

const WORKER = `
import { openFrameSource } from '/dist/hf/decode/codec-source.js';
import { readBarcode, barcodeRect, fnv } from '/tests/hf/helpers/barcode.mjs';
self.onmessage = async ({ data: { blob, prefer, opts, port } }) => {
  let src = null;
  try {
    const t0 = performance.now();
    src = await openFrameSource(blob, { prefer, port });
    const tOpen = performance.now() - t0, m = src.meta, br = barcodeRect(m.width, m.height), rows = [];
    const rois = [{ x: (m.width >> 2) & ~1, y: (m.height >> 2) & ~1, w: 256, h: 256 }, { x: (m.width >> 1) + 3, y: (m.height >> 1) + 5, w: 256, h: 256 }];
    let tCoarse = 0, tRoi = 0, tBar = 0;
    const t1 = performance.now();
    for await (const ref of src.frames({ from: opts.from ?? 0, to: opts.to ?? m.frameCount, stride: opts.stride ?? 1 })) {
      const row = { index: ref.index, t: ref.t };
      if (ref.mediaTime !== undefined) row.mediaTime = ref.mediaTime;
      let a = performance.now();
      if (opts.coarse) { const img = await ref.lumaCoarse(960); if (opts.check) row.coarse = fnv(img.data); if (opts.dump?.includes(ref.index)) row.dump = Array.from(img.data); }
      let b = performance.now(); tCoarse += b - a;
      if (opts.rois) for (const r of rois) await ref.lumaRect(r);
      a = performance.now(); tRoi += a - b;
      if (opts.check) { const c = await ref.lumaRect(br); row.code = readBarcode(c.data, m.width, m.height, { stride: c.w }); row.bar = fnv(c.data); }
      tBar += performance.now() - a;
      rows.push(row);
    }
    const total = performance.now() - t1;
    self.postMessage({ ok: true, path: m.path, meta: { width: m.width, height: m.height, rotation: m.rotation, fps: m.fps, frameCount: m.frameCount, codec: m.codec ?? null, times: Array.from(m.times) },
      fallback: src.fallback ?? null, format: src.format ?? null, stats: src.stats ?? null, rows, ms: { open: tOpen, total, coarse: tCoarse, roi: tRoi, barcode: tBar } });
  } catch (e) {
    self.postMessage({ ok: false, error: (e.code ?? e.name) + ': ' + e.message });
  } finally { await src?.close(); }
};`;

/* ---------------------------------------------------------------- HTTP server with Range */

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4' };
function serve(fixtureDir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
    const head = { 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    if (p === '/__bench/page.html') { res.writeHead(200, { ...head, 'content-type': 'text/html' }); return res.end(PAGE); }
    if (p === '/__bench/worker.js') { res.writeHead(200, { ...head, 'content-type': 'text/javascript' }); return res.end(WORKER); }
    const file = p.startsWith('/fx/') ? join(fixtureDir, basename(p)) : join(ROOT, normalize(p));
    if ((!p.startsWith('/fx/') && !/^\/(dist|tests\/hf\/helpers)\//.test(p)) || !file.startsWith(p.startsWith('/fx/') ? fixtureDir : ROOT) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = statSync(file).size, type = MIME[extname(file)] ?? 'application/octet-stream', m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const start = m[1] ? Number(m[1]) : size - Number(m[2]), end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (!(start >= 0 && start <= end)) { res.writeHead(416, { ...head, 'content-range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-type': type, 'content-length': size });
    createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

/* ---------------------------------------------------------------- CDP */

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'flightline-u1-chrome-'));
  const chrome = spawn(CHROME, [...(flag('headed') ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!port) throw new Error('Chrome did not start');
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { chrome, profile, ws, send, logs, version: ver.Browser };
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async expression => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100 && (await ev('document.title').catch(() => '')) !== 'ready'; i++) await new Promise(r => setTimeout(r, 100));
  return ev;
}

/* ---------------------------------------------------------------- checks */

async function nodeTruth(path) {
  const src = await openNodeSource(path), m = src.meta, br = barcodeRect(m.width, m.height), rows = [];
  for await (const ref of src.frames()) {
    const c = await ref.lumaRect(br);
    rows.push({ index: ref.index, t: ref.t, coarse: fnv((await ref.lumaCoarse(960)).data), bar: fnv(c.data), code: readBarcode(c.data, m.width, m.height, { stride: c.w }) });
  }
  await src.close();
  return { meta: m, rows };
}

function judge(name, r, truth, probe, skip) {
  if (!r.ok) return { name, ok: false, error: r.error };
  const n = r.rows.length, codes = r.rows.map(x => x.code);
  let dup = 0, skips = 0, wrong = 0, maxDt = 0, maxProbe = 0, coarseEq = 0, barEq = 0;
  r.rows.forEach((x, i) => {
    if (i && codes[i] === codes[i - 1]) dup++; else if (i && codes[i] !== codes[i - 1] + 1) skips++;
    if (x.code !== x.index + skip) wrong++;
    maxDt = Math.max(maxDt, Math.abs(x.t - truth.rows[x.index].t)); // exact: both from integer container pts
    maxProbe = Math.max(maxProbe, Math.abs(x.t - probe[x.index].t)); // ffprobe -show_frames prints 6 decimals
    if (x.coarse === truth.rows[x.index].coarse) coarseEq++;
    if (x.bar === truth.rows[x.index].bar) barEq++;
  });
  const mt = r.rows.filter(x => x.mediaTime != null), mtErr = mt.length ? Math.max(...mt.map(x => Math.abs(x.mediaTime - x.t))) : null;
  return {
    name, ok: true, path: r.path, fallback: r.fallback?.code ?? null, frames: n, expected: probe.length, dup, skips, wrong, maxDtSec: maxDt, maxProbeDtSec: maxProbe,
    rotation: r.meta.rotation, size: `${r.meta.width}x${r.meta.height}`, coarseExact: `${coarseEq}/${n}`, cropExact: `${barEq}/${n}`,
    mediaTimeMaxErr: mtErr, format: r.format, stats: r.stats, msPerFrame: +(r.ms.total / n).toFixed(2), openMs: +r.ms.open.toFixed(1)
  };
}

/* ---------------------------------------------------------------- main */

const fx = await buildFixtures([...CHECK, 'mpeg4', ...PERF]);
const { server, port } = await serve(fx.dir);
const cdp = await launchChrome();
log(`Chrome ${cdp.version}, fixtures ${fx.dir}`);
const report = { chrome: cdp.version, date: new Date().toISOString(), checks: [], video: [], perf: [], fallback: [] };
try {
  const ev = await openPage(cdp, `http://127.0.0.1:${port}/__bench/page.html`);
  const urlOf = name => `http://127.0.0.1:${port}/fx/${basename(fx.path(name))}`;
  const run = (name, prefer, o) => ev(`runPath(${JSON.stringify(urlOf(name))}, ${JSON.stringify(prefer)}, ${JSON.stringify(o)})`);
  const names = ONLY ?? [...CHECK, ...PERF];
  // Where pixels are not bit-exact: mean and max |Δluma| of lumaCoarse(960) against the Node source on three frames.
  const lumaDiff = async (name, prefer, file) => {
    const node = await openNodeSource(file), n = node.meta.frameCount, ks = [0, n >> 1, n - 1], want = new Map();
    for await (const ref of node.frames()) if (ks.includes(ref.index)) want.set(ref.index, (await ref.lumaCoarse(960)).data);
    await node.close();
    const r = await run(name, prefer, { coarse: true, dump: ks });
    let sum = 0, max = 0, cnt = 0, eq = 0;
    for (const row of r.rows ?? []) if (row.dump) { const w = want.get(row.index); row.dump.forEach((v, i) => { const d = Math.abs(v - w[i]); sum += d; cnt++; max = Math.max(max, d); if (!d) eq++; }); }
    return { mean: sum / cnt, max, exactFrac: eq / cnt, frames: ks };
  };

  for (const name of names.filter(n => CHECK.includes(n) || PERF.includes(n))) {
    const file = fx.path(name), probe = probeFrames(file), truth = await nodeTruth(file), skip = name === 'avc-cut' ? 16 : 0;
    for (const prefer of ['codec', 'element']) {
      if (prefer === 'element' && PERF.includes(name) && name !== 'perf-1080p30') continue; // 4K element checks run in the perf section
      const r = await run(name, prefer, { check: true, coarse: true });
      if (name === 'avc-frag' && prefer === 'codec') { // expected: the codec path refuses fragmented files (they fall back)
        const ok = !r.ok && /fragmented/.test(r.error);
        report.checks.push({ prefer, name, ok, expectedError: 'fragmented', error: r.error ?? null, frames: 0, expected: 0, dup: 0, skips: 0, wrong: 0, maxDtSec: 0, maxProbeDtSec: 0 });
        log(`${name.padEnd(16)} ${prefer.padEnd(7)} ${ok ? 'refused as expected' : 'UNEXPECTED'}: ${r.error ?? 'opened'}`);
        continue;
      }
      const j = judge(name, r, truth, probe, skip);
      if (j.ok && j.coarseExact !== `${j.frames}/${j.frames}`) j.lumaDiff = await lumaDiff(name, prefer, file);
      report.checks.push({ prefer, ...j });
      if (j.lumaDiff) log(`${name.padEnd(16)} ${prefer.padEnd(7)} luma vs Node: mean |d| ${j.lumaDiff.mean.toFixed(2)}, max |d| ${j.lumaDiff.max}, ${(100 * j.lumaDiff.exactFrac).toFixed(1)}% of coarse pixels equal`);
      log(`${name.padEnd(16)} ${prefer.padEnd(7)} ${j.ok ? `path=${j.path}${j.fallback ? `(${j.fallback})` : ''} ${j.frames}/${j.expected} dup=${j.dup} skip=${j.skips} wrong=${j.wrong} maxdt=${j.maxDtSec.toExponential(1)} rot=${j.rotation} coarse=${j.coarseExact} crop=${j.cropExact} mt=${j.mediaTimeMaxErr?.toExponential(1) ?? '-'} ${j.msPerFrame} ms/f fmt=${j.format?.format ?? j.stats?.readback ?? ''}` : j.error}`);
    }
    // Rotation as the browser itself renders it: <video> size and barcodes at a few frame centres.
    const m = truth.meta, ks = [0, 1, Math.floor(m.frameCount / 2), m.frameCount - 1].filter((k, i, a) => a.indexOf(k) === i);
    const centres = ks.map(k => [k, k + 1 < m.frameCount ? (m.times[k] + m.times[k + 1]) / 2 : m.times[k] + 0.5 / m.fps]);
    const v = await ev(`videoReference(${JSON.stringify(urlOf(name))}, ${JSON.stringify(centres)})`);
    const agree = v.W === m.width && v.H === m.height && v.frames.every(f => f.code === f.k + skip);
    report.video.push({ name, size: `${v.W}x${v.H}`, expected: `${m.width}x${m.height}`, rotation: m.rotation, agree, frames: v.frames });
    log(`${name.padEnd(16)} <video> ${v.W}x${v.H} barcodes ${v.frames.map(f => `${f.k}->${f.code}`).join(' ')} ${agree ? 'agrees' : 'DISAGREES'}`);
  }

  // Fallback routing: fragmented MP4 and an unsupported codec under prefer 'auto'.
  for (const name of ['avc-frag', 'mpeg4'].filter(n => !ONLY || ONLY.includes(n))) {
    const r = await run(name, 'auto', { check: true });
    report.fallback.push({ name, ok: r.ok, path: r.path ?? null, fallback: r.fallback ?? null, frames: r.rows?.length ?? 0, wrong: r.rows?.filter(x => x.code !== x.index).length ?? null, error: r.error ?? null });
    log(`${name.padEnd(16)} auto    ${r.ok ? `path=${r.path} fallback=${r.fallback?.code}: ${r.fallback?.message} frames=${r.rows.length} wrong=${r.rows.filter(x => x.code !== x.index).length}` : r.error}`);
  }

  // Timing: codec decode only, + lumaCoarse(960) per frame (P1), + two 256² native crops per frame (P2); element + coarse.
  for (const name of PERF.filter(n => !ONLY || ONLY.includes(n))) {
    const modes = [['codec', 'decode', {}], ['codec', 'coarse', { coarse: true }], ['codec', 'rois', { rois: true }], ['codec', 'coarse+rois', { coarse: true, rois: true }], ['element', 'coarse', { coarse: true }]];
    for (const [prefer, mode, o] of modes) {
      const runs = [];
      for (let i = 0; i < (prefer === 'element' ? 1 : 3); i++) runs.push(await run(name, prefer, o));
      const ok = runs.filter(r => r.ok);
      if (!ok.length) { report.perf.push({ name, prefer, mode, error: runs[0].error }); log(`${name} ${prefer} ${mode}: ${runs[0].error}`); continue; }
      const per = ok.map(r => r.ms.total / r.rows.length).sort((a, b) => a - b), r = ok[0];
      const row = { name, prefer, mode, frames: r.rows.length, size: `${r.meta.width}x${r.meta.height}`, fps: r.meta.fps, msPerFrameMedian: +per[per.length >> 1].toFixed(2), msPerFrameRuns: per.map(x => +x.toFixed(2)),
        coarseMsPerFrame: +(r.ms.coarse / r.rows.length).toFixed(2), roiMsPerFrame: +(r.ms.roi / r.rows.length).toFixed(2), openMs: +r.ms.open.toFixed(1), format: r.format?.format ?? r.stats?.readback ?? null };
      report.perf.push(row);
      log(`${name.padEnd(16)} ${prefer.padEnd(7)} ${mode.padEnd(12)} ${row.msPerFrameMedian} ms/frame (runs ${row.msPerFrameRuns.join(', ')}) coarse ${row.coarseMsPerFrame} roi ${row.roiMsPerFrame} open ${row.openMs} ms ${row.format}`);
    }
  }
} finally {
  if (cdp.logs.length) log('console:', cdp.logs.slice(0, 20).join(' | '));
  cdp.ws.close(); cdp.chrome.kill(); server.close();
  try { rmSync(cdp.profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failures = report.checks.filter(c => !c.ok || c.dup || c.skips || c.wrong || c.frames !== c.expected || c.maxDtSec > 0 || c.maxProbeDtSec > 1e-6).length + report.video.filter(v => !v.agree).length;
report.summary = { checks: report.checks.length, failures };
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
log(`done: ${report.checks.length} checks, ${failures} failing${OUT ? `, report ${OUT}` : ''}`);
process.exit(failures ? 1 : 0);
