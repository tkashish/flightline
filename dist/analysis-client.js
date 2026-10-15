/**
 * Main-thread side of the analysis worker (docs/TRACKING_HF_PROTOCOL.md §11). startAnalysis runs one hf job in its
 * own worker and serves the element fallback from this thread (serveElementFrames on a MessageChannel), so a clip
 * WebCodecs cannot decode still runs; the worker answers with hf-source, hf-progress and one hf-result or hf-error,
 * each carrying the job's id (others are ignored). On abort it rejects at once, sends hf-cancel and terminates the
 * worker when the job's last message arrives, or after CANCEL_GRACE_MS. The first hf job of a new build first
 * revalidates dist/hf in the HTTP cache (refreshHF). v2 and legacy are fed frame by frame by app.js through the same
 * worker script (createAnalysisWorker).
 */
export const CANCEL_GRACE_MS = 2000;
// No message for this long means a stuck job (progress comes at least every phase, about every 100 ms).
export const STALL_MS = 60000;
export const DECODE_PATHS = ['auto', 'codec', 'element'];
const WORKER_URL = new URL('./worker.js?v=53', import.meta.url);

/**
 * Every dist/hf module. They import one another without ?v= (protocol doc §2), so a new build changes only the URLs
 * of the entry points loaded from outside (worker.js: engine.js, decode/codec-source.js; this file:
 * decode/element-source.js), and the HTTP cache would hand a returning user the previous build's copy of everything
 * they import. refreshHF revalidates them all once per build, before the first hf job loads any of them.
 */
export const HF_FILES = Object.freeze([
  'types.js', 'params.js', 'engine.js', 'pipeline.js', 'camera-motion.js', 'coarse-scan.js', 'spots.js', 'impact.js', 'emergence.js', 'club.js',
  'launch-null.js', 'roi-detect.js', 'flight-model.js', 'lm.js', 'complete.js', 'display-curve.js', 'flight-tracker.js', 'decide.js', 'confidence.js',
  'decode/codec-source.js', 'decode/element-source.js', 'decode/mp4-demux.js', 'decode/orient.js', 'decode/planes.js'
]);
export const HF_BUILD_KEY = 'flightline.hfBuild';
// A refresh that has not finished by then lets the job start anyway (the server is slow, not the cache stale).
export const REFRESH_MS = 10000;
const localStore = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/**
 * A once-per-build revalidation of `files` under `base`: fetch with cache 'no-cache' (a conditional request) stores
 * the server's current copy in the HTTP cache that this page's and the worker's module loads read. `store` (default
 * localStorage; without one, this page's memory) remembers the last build refreshed. The returned function gives
 * null when there is nothing to do (no build version, no fetch, done already), else a promise that resolves true once
 * done, false on a network failure (the next job retries); it never rejects.
 */
export function hfRefresher({ build = new URL(import.meta.url).searchParams.get('v'), files = HF_FILES, base = new URL('./hf/', import.meta.url), fetch, store } = {}) {
  let running = null, memo = null;
  const storage = () => store ?? localStore();
  const seen = () => { try { const s = storage(); return s ? s.getItem(HF_BUILD_KEY) : memo; } catch { return memo; } };
  return () => {
    const get = fetch ?? globalThis.fetch;
    if (!build || typeof get !== 'function' || seen() === build) return null;
    return running ??= Promise.all(files.map(f => get(new URL(f, base), { cache: 'no-cache' }).then(r => r.arrayBuffer()))).then(() => {
      running = null; memo = build;
      try { storage()?.setItem(HF_BUILD_KEY, build); } catch { /* storage full: the next job revalidates again */ }
      return true;
    }, () => { running = null; return false; });
  };
}
/** The page's refresher for this build (?v= of this module's own URL). */
export const refreshHF = hfRefresher();

/** A fresh analysis worker (a module worker running dist/worker.js). */
export const createAnalysisWorker = () => new Worker(WORKER_URL, { type: 'module' });
// Loaded with the first hf job, so the v2 app never loads dist/hf.
const serveElement = async (file, port, opts) => (await import('./hf/decode/element-source.js?v=53')).serveElementFrames(file, port, opts);
const abortError = signal => signal?.reason ?? new DOMException('Operation cancelled', 'AbortError');
const stallError = () => new DOMException('The analysis stopped responding. Try again, or try a shorter H.264 MP4.', 'TimeoutError');
// What a worker hf-error says to the user; its own message stays in error.detail.
const FAILED = {
  unsupported: 'This video could not be decoded in this browser. Try an H.264 MP4.',
  decode: 'Decoding failed partway through the video. Try an H.264 MP4.',
  internal: 'The analysis hit an internal error.'
};
let jobs = 0;

/**
 * Analyze one clip with the hf engine.
 * @param {File|Blob} file
 * @param {{engine?:'hf', onProgress?:(p:{phase:string, done:number, total:number, message?:string}) => void,
 *   onSource?:(meta:object, fallback:object|null) => void, signal?:AbortSignal, prefer?:'auto'|'codec'|'element',
 *   diagnostics?:boolean, worker?:() => Worker, serve?:Function, refresh?:() => Promise|null, stallMs?:number,
 *   graceMs?:number, refreshMs?:number}} [opts]  onSource gets the hf-source meta {path, width, height, fps, frameCount,
 *   vfr, rotation, hasAudio} and why the codec path was not used; worker, serve and refresh replace the worker factory,
 *   serveElementFrames and refreshHF (tests)
 * @returns {Promise<object>} the HFResult; rejects with an AbortError on abort, a TimeoutError when the job stalls,
 *   and an AnalysisError {code: 'unsupported' | 'decode' | 'internal', detail: the worker's message} when it fails
 */
export function startAnalysis(file, opts = {}) {
  const { engine = 'hf', signal, prefer = 'auto', refresh = refreshHF, refreshMs = REFRESH_MS } = opts;
  if (engine !== 'hf') return Promise.reject(new Error(`startAnalysis runs the hf engine, not "${engine}": app.js feeds v2 and legacy frame by frame.`));
  if (!DECODE_PATHS.includes(prefer)) return Promise.reject(new Error(`Unknown decode path "${prefer}". Use auto, codec or element.`));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const ready = refresh?.();
  if (!ready) return runJob(file, opts);
  // This build's dist/hf goes into the HTTP cache before the worker or the element server loads any of it.
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.race([ready, new Promise(r => { timer = setTimeout(r, refreshMs); })]).then(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (!signal?.aborted) runJob(file, opts).then(resolve, reject);
    });
  });
}

function runJob(file, { onProgress, onSource, signal, prefer = 'auto', diagnostics = false, worker = createAnalysisWorker, serve = serveElement, stallMs = STALL_MS, graceMs = CANCEL_GRACE_MS }) {
  const jobId = `hf-${Date.now().toString(36)}-${++jobs}`, w = worker(), server = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false, stopping = false, grace, stall;
    const close = () => {
      clearTimeout(grace); clearTimeout(stall);
      w.removeEventListener('message', onMessage); w.removeEventListener('error', onError); signal?.removeEventListener('abort', onAbort);
      server.abort(); w.terminate();
    };
    const settle = (error, result) => { if (settled) return; settled = true; if (error) reject(error); else resolve(result); };
    // Stop: reject now; the worker still gets to cancel the job (closing its decoder) before it is terminated.
    const stop = error => {
      if (stopping || settled) return;
      stopping = true; settle(error); server.abort(); clearTimeout(stall);
      try { w.postMessage({ type: 'hf-cancel', jobId }); } catch { /* gone */ }
      grace = setTimeout(close, graceMs);
    };
    const watch = () => { clearTimeout(stall); stall = setTimeout(() => stop(stallError()), stallMs); };
    const onMessage = ({ data: m }) => {
      if (m?.jobId !== jobId) return;
      if (m.type === 'hf-result' || m.type === 'hf-error') {
        close();
        if (m.type === 'hf-result') settle(null, m.result);
        else settle(m.code === 'aborted' ? abortError(signal) : Object.assign(new Error(FAILED[m.code] ?? FAILED.internal), { name: 'AnalysisError', code: m.code, detail: m.message }));
        return;
      }
      if (stopping) return;
      watch();
      try {
        if (m.type === 'hf-source') onSource?.(m.meta, m.fallback ?? null);
        else if (m.type === 'hf-progress') onProgress?.({ phase: m.phase, done: m.done, total: m.total, ...(m.message === undefined ? {} : { message: m.message }) });
      } catch (error) { stop(error); }
    };
    // The worker itself failed (a script error, or a module that would not load): an internal error, not the video.
    const onError = event => { close(); settle(Object.assign(new Error(`The analysis worker failed${event?.message ? `: ${event.message}` : ''}.`), { name: 'AnalysisError', code: 'internal' })); };
    const onAbort = () => stop(abortError(signal));
    w.addEventListener('message', onMessage); w.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    let port = null;
    if (prefer !== 'codec' && typeof MessageChannel === 'function') {
      const channel = new MessageChannel();
      port = channel.port2;
      Promise.resolve().then(() => serve(file, channel.port1, { signal: server.signal })).catch(error => refuse(channel.port1, error, server.signal));
    }
    try {
      w.postMessage({ type: 'hf-analyze', jobId, file, options: { prefer, diagnostics: !!diagnostics }, ...(port ? { port } : {}) }, port ? [port] : []);
      watch();
    } catch (error) { close(); settle(error); }
  });
}

/** The element server could not start: answer the worker's open with an error, so it fails at once instead of waiting. */
function refuse(port, error, signal) {
  port.onmessage = ({ data }) => {
    if (data?.type === 'open') port.postMessage({ type: 'error', jobId: data.jobId, code: 'unsupported', message: `The fallback decoder could not start: ${error?.message ?? error}` });
  };
  signal.addEventListener('abort', () => port.close(), { once: true });
}
