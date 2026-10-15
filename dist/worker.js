import { MotionTracker } from './tracker.js?v=53';
import { FRAME_ENGINES, pickEngine } from './frame-source.js?v=53';
let tracker, diagnostics, frames;
// v2/legacy protocol: init → frame × N → finish. Every message gets one reply; failures reply { error }.
// hf protocol (docs/TRACKING_HF_PROTOCOL.md §11): hf-analyze and hf-cancel, every message carrying its jobId.
self.onmessage = ({ data }) => {
  if (typeof data?.type === 'string' && data.type.startsWith('hf-')) return hfMessage(data);
  try {
    if (data?.type === 'init') {
      // Shared default with the UI; unknown names (and hf, which is not fed frames) reply with an error instead of silently running legacy.
      tracker = new MotionTracker(data.width, data.height, { engine: pickEngine(data.engine, FRAME_ENGINES) });
      diagnostics = data.diagnostics;
      frames = [];
      self.postMessage({ ok: true });
    } else if (!tracker && (data?.type === 'frame' || data?.type === 'finish')) {
      throw new Error(`Worker message "${data.type}" before init.`);
    } else if (data?.type === 'frame') {
      tracker.detect(new Uint8ClampedArray(data.buffer), data.time);
      if (diagnostics && data.time >= diagnostics.from && data.time <= diagnostics.to) frames.push({
        t: data.time, blockedUntil: tracker.seedBlockedUntil,
        movingCount: tracker.lastCandidates.filter(p => p.moving).length,
        totalCandidates: tracker.lastCandidates.length,
        candidates: tracker.lastCandidates.filter(p => p.size >= 6 && p.quality > .75).slice(0, 160),
        spots: tracker.spots.filter(p => p.seen >= 8 && p.size >= 6 && p.quality > .78).slice(0, 80).map(p => ({ ...p })),
        tracks: tracker.tracks.slice(0, 50).map(p => ({ first: p.points[0], last: p.points.at(-1), count: p.points.length, score: p.score }))
      });
      self.postMessage({ ok: true });
    } else if (data?.type === 'finish') {
      self.postMessage({ ...tracker.result(), ...(diagnostics ? { frames, best: tracker.best, width: tracker.w, height: tracker.h } : {}) });
    } else throw new Error(`Unknown worker message "${data?.type}". Use init, frame or finish (hf: hf-analyze, hf-cancel).`);
  } catch (error) { self.postMessage({ error: error.message }); }
};

/* ------------------------------------------------------------------ hf */

// Loaded by the first hf job, so a v2 or legacy worker never loads dist/hf.
let hfModules = null;
const loadHF = () => hfModules ??= Promise.all([import('./hf/engine.js?v=53'), import('./hf/decode/codec-source.js?v=53')])
  .then(([engine, decode]) => ({ runHF: engine.runHF, openFrameSource: decode.openFrameSource }), e => { hfModules = null; throw e; });
const META = ['path', 'width', 'height', 'fps', 'frameCount', 'vfr', 'rotation', 'hasAudio'], metaOf = source => Object.fromEntries(META.map(k => [k, source.meta[k]]));
const UNSUPPORTED = ['unsupported', 'fragmented', 'no-moov', 'no-video'];
const failure = (code, message) => Object.assign(new Error(message), { code });
/** hf-error code: aborted | unsupported | decode | internal. */
const errorCode = (e, signal) => signal.aborted || e?.name === 'AbortError' ? 'aborted' : e?.code === 'decode' ? 'decode' : UNSUPPORTED.includes(e?.code) ? 'unsupported' : 'internal';
let job = null;   // the running hf job: { jobId, controller }

function hfMessage(m) {
  if (m.type === 'hf-cancel') { if (job && job.jobId === m.jobId) job.controller.abort(); return; }
  // A new job cancels the running one; that one still posts its own hf-error, which the main thread ignores as stale.
  if (m.type === 'hf-analyze') { job?.controller.abort(); runJob(m); return; }
  self.postMessage({ type: 'hf-error', jobId: m.jobId ?? null, code: 'internal', message: `Unknown worker message "${m.type}". Use hf-analyze or hf-cancel.` });
}

/** One clip: open the best FrameSource (codec, else the element frames the main thread serves on `port`), run hf, post the result once. */
async function runJob({ jobId, file, options = {}, port }) {
  const controller = new AbortController(), { signal } = controller, me = job = { jobId, controller };
  const post = m => self.postMessage({ ...m, jobId });
  let source = null, result = null, error = null;
  try {
    if (typeof jobId !== 'string' || !jobId) throw failure('internal', 'hf-analyze needs a jobId.');
    if (typeof Blob !== 'function' || !(file instanceof Blob)) throw failure('unsupported', 'hf-analyze needs a File or Blob.');
    const { runHF, openFrameSource } = await loadHF();
    signal.throwIfAborted();
    const run = { signal, diagnostics: !!options.diagnostics }, onProgress = p => post({ type: 'hf-progress', ...p });
    source = await openFrameSource(file, { prefer: options.prefer ?? 'auto', signal, port, jobId });
    post({ type: 'hf-source', meta: metaOf(source), ...(source.fallback ? { fallback: source.fallback } : {}) });
    try { result = await runHF(source, run, onProgress); }
    catch (e) {
      // The decoder failed mid-clip: once more on the element path, which claims the port before the codec source lets it go.
      if (e?.code !== 'decode' || source.meta.path !== 'codec' || !port) throw e;
      const failed = source;
      source = await openFrameSource(file, { prefer: 'element', signal, port, jobId });
      await failed.close();
      post({ type: 'hf-source', meta: metaOf(source), fallback: { path: 'codec', code: 'decode', message: e.message } });
      result = await runHF(source, run, onProgress);
    }
  } catch (e) { error = e; }
  // A codec source releases the unused element port; a remote one tells the main thread to stop serving.
  try { await source?.close(); } catch { /* closed already */ }
  if (job === me) job = null;
  try {
    if (error) post({ type: 'hf-error', code: errorCode(error, signal), message: error?.message || String(error) });
    else post({ type: 'hf-result', result });
  } catch (e) { post({ type: 'hf-error', code: 'internal', message: `The result could not be sent: ${e.message}` }); }
}
