/**
 * Minimal Chrome DevTools Protocol client (U7 bench): launch headless Chrome, talk CDP over the WebSocket built into
 * Node (>= 22), open pages as flattened sessions, auto-attach workers, sample renderer RSS. No dependencies.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Chrome executable: $CHROME, then the usual macOS and Linux locations. */
export function findChrome() {
  const c = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return c.find(p => existsSync(p)) ?? null;
}

/** One CDP connection; sessions are flattened (every message may carry a sessionId). */
export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    ws.addEventListener('message', e => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(`${p.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`), { cdp: m.error }));
        else p.resolve(m.result);
        return;
      }
      for (const l of [...this.listeners]) if (l.method === m.method && (l.sessionId === undefined || l.sessionId === m.sessionId)) l.fn(m.params, m.sessionId);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: CDP connection closed`));
      this.pending.clear();
    });
  }
  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP connect timeout ${url}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`CDP connect failed ${url}`)); }, { once: true });
    });
    return new CDP(ws);
  }
  /** One command; rejects after timeoutMs (a browser that stops answering fails the call instead of hanging it). */
  send(method, params = {}, sessionId, { timeoutMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no CDP reply in ${timeoutMs} ms`)); }, timeoutMs);
      const done = f => v => { clearTimeout(timer); f(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  /** Subscribe to an event (optionally of one session); returns the unsubscribe function. */
  on(method, fn, sessionId) { const l = { method, fn, sessionId }; this.listeners.add(l); return () => this.listeners.delete(l); }
  /** Resolve with the first matching event's params, or reject after timeoutMs. */
  once(method, { sessionId, filter = () => true, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (p, s) => { if (!filter(p, s)) return; clearTimeout(t); off(); resolve(p); }, sessionId);
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/**
 * Launch Chrome with a fresh profile and remote debugging on a free port (read from DevToolsActivePort).
 * @returns {Promise<{cdp:CDP, proc:import('node:child_process').ChildProcess, version:object, userDataDir:string, close:() => Promise<void>}>}
 */
export async function launchChrome({ chrome = findChrome(), headless = true, args = [], userDataDir = null, timeoutMs = 20000 } = {}) {
  if (!chrome) throw new Error('Chrome not found; set $CHROME');
  const dir = userDataDir ?? mkdtempSync(join(tmpdir(), 'flightline-bench-chrome-'));
  const flags = [
    ...(headless ? ['--headless=new'] : []), '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-component-update', '--disable-sync', '--mute-audio', '--enable-precise-memory-info', ...args, 'about:blank'
  ];
  const proc = spawn(chrome, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const portFile = join(dir, 'DevToolsActivePort'), t0 = Date.now();
  let ws = null;
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode != null) throw new Error(`Chrome exited (${proc.exitCode}): ${stderr.slice(-400)}`);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && path) { ws = `ws://127.0.0.1:${port}${path}`; break; }
    }
    await sleep(100);
  }
  if (!ws) { proc.kill('SIGKILL'); throw new Error(`Chrome did not open a debugging port: ${stderr.slice(-400)}`); }
  const cdp = await CDP.connect(ws), version = await cdp.send('Browser.getVersion');
  const exited = new Promise(r => (proc.exitCode != null || proc.signalCode != null ? r() : proc.once('exit', r)));
  const close = async () => {
    try { await cdp.send('Browser.close', {}, undefined, { timeoutMs: 5000 }); } catch { /* gone */ }
    cdp.close();
    await Promise.race([exited, sleep(3000)]);
    if (proc.exitCode == null && proc.signalCode == null) { proc.kill('SIGKILL'); await Promise.race([exited, sleep(2000)]); }
    // Orphaned helper processes can hold the stderr pipe open and keep the test process alive.
    proc.stderr?.destroy(); proc.unref();
    // Helpers may still be writing the profile for a moment after the browser exits.
    if (!userDataDir) try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort */ }
  };
  return { cdp, proc, version, userDataDir: dir, close };
}

/**
 * Open url in a new tab as a flattened session with Page/Runtime/DOM enabled. Dedicated workers are auto-attached
 * and tracked in page.workers (sessionId -> targetInfo) so their heaps can be sampled.
 */
export async function openPage(cdp, url, { timeoutMs = 30000 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId), workers = new Map(), offs = [];
  offs.push(cdp.on('Target.attachedToTarget', p => { if (/worker/.test(p.targetInfo.type)) workers.set(p.sessionId, p.targetInfo); }, sessionId));
  offs.push(cdp.on('Target.detachedFromTarget', p => workers.delete(p.sessionId), sessionId));
  let crashed = false;
  offs.push(cdp.on('Inspector.targetCrashed', () => { crashed = true; }, sessionId));
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('DOM.enable')]);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const loaded = cdp.once('Page.loadEventFired', { sessionId, timeoutMs });
  await send('Page.navigate', { url });
  await loaded;
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return {
    targetId, sessionId, send, evaluate, workers,
    get crashed() { return crashed; },
    /** Poll expression until it returns something truthy (that value), or throw after timeoutMs. */
    async waitFor(expression, { timeoutMs: limit = 30000, intervalMs = 200, onTick } = {}) {
      const t0 = Date.now();
      for (;;) {
        const v = await evaluate(expression);
        if (v) return v;
        if (Date.now() - t0 > limit) throw new Error(`timeout after ${limit} ms waiting for ${expression.slice(0, 80)}`);
        await onTick?.();
        await sleep(intervalMs);
      }
    },
    async close() { offs.forEach(f => f()); await cdp.send('Target.closeTarget', { targetId }, undefined, { timeoutMs: 5000 }).catch(() => {}); }
  };
}

/** Upload local files to an <input type=file> (dispatches input and change like a user pick). */
export async function setFiles(page, selector, files) {
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no element ${selector}`);
  await page.send('DOM.setFileInputFiles', { nodeId, files });
}

/** Used JS heap (MB) of every attached worker; null entries for workers that went away. */
export async function workerHeapsMb(cdp, page) {
  return Promise.all([...page.workers.keys()].map(s => cdp.send('Runtime.getHeapUsage', {}, s).then(r => r.usedSize / 2 ** 20, () => null)));
}

/** Renderer processes now: pid -> {cpu (s), rssMb}. ps supplies RSS; empty when SystemInfo or ps is unavailable. */
export async function rendererSnapshot(cdp) {
  const out = new Map();
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const procs = processInfo.filter(p => p.type === 'renderer' && p.id);
    if (!procs.length) return out;
    const rss = new Map(execFileSync('ps', ['-o', 'pid=,rss=', '-p', procs.map(p => p.id).join(',')], { encoding: 'utf8' })
      .trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)));
    for (const p of procs) if (rss.has(p.id)) out.set(p.id, { cpu: p.cpuTime, rssMb: rss.get(p.id) / 1024 });
  } catch { /* no process info */ }
  return out;
}

/**
 * Track the tab's renderer RSS: Chrome runs several renderers (and spawns helpers during playback), so the tab is
 * the renderer whose CPU time grew most since the baseline; its peak RSS minus its baseline is the tab increase.
 */
export class RendererMemory {
  constructor(cdp) { this.cdp = cdp; this.base = new Map(); this.peak = new Map(); this.last = new Map(); }
  async baseline() { this.base = await rendererSnapshot(this.cdp); this.peak.clear(); this.last = new Map(this.base); return this; }
  async sample() {
    for (const [pid, s] of await rendererSnapshot(this.cdp)) { this.last.set(pid, s); this.peak.set(pid, Math.max(this.peak.get(pid) ?? 0, s.rssMb)); }
  }
  result() {
    let pid = null, best = -1;
    for (const [p, s] of this.last) { const d = s.cpu - (this.base.get(p)?.cpu ?? 0); if (d > best) { best = d; pid = p; } }
    if (pid == null) return { pid: null, increaseMb: null, peakMb: null, cpuSec: null, renderers: this.last.size };
    const peakMb = this.peak.get(pid) ?? this.last.get(pid).rssMb;
    return { pid, peakMb, increaseMb: Math.max(0, peakMb - (this.base.get(pid)?.rssMb ?? 0)), cpuSec: best, renderers: this.last.size };
  }
}
