/**
 * Local dev server for the Jev tracer: serves dist/ like `npm run dev`, plus a small tracing API that keeps the Jev key
 * on this machine (~/.typesafe_key or TYPESAFE_API_KEY). The browser uploads the clip here; crops of it go to Jev.
 *
 *   POST   /api/jev/track      body = the video file  -> { id }
 *   GET    /api/jev/job/:id    -> { phase, message, done, total, result?, error? }
 *   DELETE /api/jev/job/:id    cancels the job
 *
 * Usage: npm run dev:jev  (http://127.0.0.1:5173/?engine=jev)
 */
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { readKey } from './track.mjs';

const ROOT = resolve(new URL('../../dist/', import.meta.url).pathname), PORT = +(process.env.PORT || 5173), HOST = '127.0.0.1';
const MAX_BYTES = 250 * 1024 * 1024;   // the app's own upload limit
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };
const jobs = new Map();
try { readKey(); } catch { console.error('No Jev key: put it in ~/.typesafe_key or set TYPESAFE_API_KEY.'); process.exit(1); }

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

function startJob(req, res) {
  const id = randomUUID(), dir = join(tmpdir(), `flightline-jev-${id}`), video = join(dir, 'clip' + (extname(req.headers['x-filename'] || '') || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, ''));
  mkdirSync(dir, { recursive: true });
  let bytes = 0, tooBig = false;
  const out = createWriteStream(video);
  req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES && !tooBig) { tooBig = true; req.destroy(); } });
  req.pipe(out);
  out.on('finish', () => {
    if (tooBig) { rmSync(dir, { recursive: true, force: true }); return json(res, 413, { error: 'The video is larger than 250 MB.' }); }
    const job = { phase: 'probe', message: 'Uploaded', done: 0, total: 1, result: null, error: null, dir, worker: null, at: Date.now() };
    job.worker = new Worker(new URL('./job-worker.mjs', import.meta.url), { workerData: { video, workDir: join(dir, 'work') } });
    job.worker.on('message', m => {
      if (m.type === 'progress') Object.assign(job, { phase: m.phase, message: m.message, done: m.done, total: m.total });
      else if (m.type === 'done') Object.assign(job, { phase: 'done', result: m.result });
      else if (m.type === 'error') Object.assign(job, { phase: 'error', error: m.message });
    });
    job.worker.on('exit', () => { rmSync(dir, { recursive: true, force: true }); if (!job.result && !job.error) job.error = 'cancelled'; });
    jobs.set(id, job);
    json(res, 202, { id });
  });
  req.on('error', () => rmSync(dir, { recursive: true, force: true }));
}

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname), file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/api\/jev\/(track|job\/([\w-]+))$/);
  if (!m) return req.method === 'GET' || req.method === 'HEAD' ? serveStatic(req, res) : json(res, 405, { error: 'method not allowed' });
  if (m[1] === 'track') return req.method === 'POST' ? startJob(req, res) : json(res, 405, { error: 'POST only' });
  const job = jobs.get(m[2]);
  if (!job) return json(res, 404, { error: 'unknown job' });
  if (req.method === 'DELETE') { job.worker.postMessage('abort'); setTimeout(() => job.worker.terminate(), 2000); jobs.delete(m[2]); return json(res, 200, { cancelled: true }); }
  const { phase, message, done, total, result, error } = job;
  if (result || error) setTimeout(() => jobs.delete(m[2]), 60_000);
  json(res, 200, { phase, message, done, total, result, error });
}).listen(PORT, HOST, () => console.log(`Flightline + Jev tracer: http://${HOST}:${PORT}/?engine=jev`));
