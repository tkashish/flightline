import test from 'node:test';
import assert from 'node:assert/strict';

// dist/app.js on a minimal DOM: every id is an element, nothing loads by itself, canvases draw nothing.
// The test plays the browser: it answers each pick's check (the detached probe <video>), loads the clip,
// seeks it (frames start at `starts`), and stands in for the tracking worker.
class El {
  constructor(tag) { Object.assign(this, { tag, hidden: false, disabled: false, textContent: '', value: '', files: [], dataset: {}, style: {}, listeners: {}, children: [], srcs: [], _src: '' }); }
  get src() { return this._src; }
  set src(url) { this._src = url; if (url) this.srcs.push(url); }
  get classList() { return { toggle() {}, add() {}, remove() {}, contains: () => false }; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
    return event;
  }
  removeAttribute(name) { if (name === 'src') this._src = ''; else delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  // A drawn video frame's pixels carry its index + 1 in every byte; dots (arc) are recorded in this.arcs.
  getContext() {
    let shown = 0;
    const arcs = this.arcs = [], lines = this.lines = [];
    return new Proxy({
      drawImage: source => { shown = source.frame?.() ?? 0; }, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(shown + 1) }),
      arc: (x, y, r) => arcs.push([x, y, r]), moveTo: (x, y) => lines.push([x, y]), lineTo: (x, y) => lines.push([x, y])
    }, { get: (t, k) => t[k] ?? (() => {}) });
  }
  load() {} pause() { this.paused = true; } play() { return Promise.resolve(); }
  get lastChild() { return this.children.at(-1); }
  replaceChildren(...nodes) { this.children = nodes; } append(...nodes) { this.children.push(...nodes); } click() { this.dispatch('click'); }
  // Laid out at its own pixel size at the page origin (the stage canvas, for manual clicks).
  getBoundingClientRect() { return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height }; }
}
// v2: replies { ok } to init and frame, and an abstention to finish; keeps every frame it was sent.
// hf: FakeWorker.hf(worker, message) answers hf-analyze and hf-cancel (default: an hf-source, two progress events, FakeWorker.result).
class FakeWorker {
  constructor() { Object.assign(this, { listeners: {}, frames: [], sent: [] }); FakeWorker.all.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  emit(data) { if (!this.terminated) for (const fn of [...(this.listeners.message || [])]) fn({ data }); }
  postMessage(m) {
    this.sent.push(m);
    if (m.type?.startsWith('hf-')) return (FakeWorker.hf ?? hfDefault)(this, m);
    if (m.type === 'frame') this.frames.push({ n: new Uint8ClampedArray(m.buffer)[0] - 1, t: m.time });
    const data = m.type === 'finish' ? FakeWorker.finish ?? { engine: 'global-v2', status: 'no_reliable_track', points: [], camera: [], reasonCodes: ['no_launch'] } : { ok: true };
    setTimeout(() => this.emit(data), 0);
  }
  terminate() { this.terminated = true; }
}
FakeWorker.all = [];
const HF_META = { path: 'codec', width: 64, height: 36, fps: 30, frameCount: 90, vfr: false, rotation: 0, hasAudio: false };
function hfDefault(worker, m) {
  if (m.type !== 'hf-analyze') return;
  const { jobId } = m, result = typeof FakeWorker.result === 'function' ? FakeWorker.result(m) : FakeWorker.result;
  const replies = [{ type: 'hf-source', jobId, meta: HF_META }, { type: 'hf-progress', jobId, phase: 'probe', done: 0, total: 1 }, { type: 'hf-progress', jobId, phase: 'scan', done: 45, total: 90 },
    { type: 'hf-progress', jobId, phase: 'done', done: 1, total: 1, message: result.status }, { type: 'hf-result', jobId, result }];
  replies.forEach((data, i) => setTimeout(() => worker.emit(data), 2 * i));
}
// The page's network for the dist/hf revalidation (analysis-client.js refreshHF, active: app.js loads it with ?v=):
// every fetch is recorded; with Net.hold the response bodies wait for Net.release().
const Net = { calls: [], hold: false, waiting: [], release() { this.waiting.splice(0).forEach(r => r(new ArrayBuffer(0))); } };
const netFetch = (url, init) => {
  Net.calls.push([String(url), init?.cache]);
  return Promise.resolve({ ok: true, arrayBuffer: () => Net.hold ? new Promise(r => Net.waiting.push(r)) : Promise.resolve(new ArrayBuffer(0)) });
};
const pageStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
// The app's long timeouts (toast, load, seek) and the playback stall check must not hold the test process open.
const later = globalThis.setTimeout, every = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...args) => { const timer = later(fn, ms, ...args); if (ms >= 1000) timer.unref?.(); return timer; };
globalThis.setInterval = (fn, ms, ...args) => { const timer = every(fn, ms, ...args); timer.unref?.(); return timer; };
let instance = 0;
async function boot({ clock = true, search = '' } = {}) {
  const els = {}, probes = [], doc = new El('document');
  let pending = null;
  Object.assign(doc, {
    hidden: false,
    getElementById: id => (els[id] ||= Object.assign(new El('div'), { id })),
    createElement: tag => { const el = new El(tag); if (tag === 'video') probes.push(el); return el; },
    querySelectorAll: () => []
  });
  Object.assign(globalThis, {
    document: doc, location: { search }, matchMedia: () => ({ matches: false }), Worker: FakeWorker, fetch: netFetch, localStorage: pageStorage(),
    // Animation frames run only when the test asks (frame()).
    requestAnimationFrame: fn => { pending = fn; return 1; }, cancelAnimationFrame: () => {}, Image: class { set src(v) {} }
  });
  // WebCodecs frame clock: a VideoFrame of the clip carries the shown frame's start in microseconds.
  if (clock) globalThis.VideoFrame = class { constructor(video) { this.timestamp = Math.round(video.starts[video.frame()] * 1e6); } close() {} };
  else delete globalThis.VideoFrame;
  await import(`../dist/app.js?test=${++instance}`);
  const $ = doc.getElementById;
  const ui = () => ({ busy: !$('busyOverlay').hidden, title: $('busyTitle').textContent, toast: $('toast').hidden || !$('toast').textContent ? null : $('toast').textContent });
  const pick = names => {
    els.fileInput.files = names.map(n => new File(['x'], n, { type: 'video/mp4' }));
    els.fileInput.dispatch('change');
  };
  // A probe that decodes: a 3 s clip with a picture.
  const loads = probe => { Object.assign(probe, { duration: 3, videoWidth: 64, videoHeight: 36 }); probe.onloadeddata(); };
  // The opened clip: its frames start at `starts`, and a seek shows the last one starting at or before the target.
  const opens = (starts, duration) => {
    const video = $('video');
    let t = 0;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => t, set: v => { t = v; setTimeout(() => video.dispatch('seeked'), 0); } });
    Object.assign(video, { starts, duration, videoWidth: 64, videoHeight: 36, readyState: 4, seekable: { length: 1, end: () => duration } });
    video.frame = () => { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= t + 1e-9) k++; return k; };
    video.dispatch('loadeddata');
  };
  const frame = () => pending?.(performance.now());
  return { els: new Proxy(els, { get: (t, id) => $(id) }), probes, ui, pick, loads, opens, frame };
}
const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (ok, ms = 10000) => { for (const t0 = Date.now(); !ok(); await settle()) if (Date.now() - t0 > ms) throw new Error('timed out'); };

test('app: Cancel during an idle pick check hides the overlay at once and nothing opens', async () => {
  const { els, probes, ui, pick } = await boot();
  pick(['a.mp4']);
  assert.deepEqual(ui(), { busy: true, title: 'Opening your swing…', toast: null });
  els.cancel.onclick();
  await settle();
  assert.equal(ui().busy, false);
  assert.equal(probes[0].onloadeddata, null, 'the check stopped');
  assert.deepEqual(els.video.srcs, []);
});

test('app: Cancel during a pick checked behind running work stops both, and the pick never opens', async () => {
  const { els, probes, ui, pick, loads } = await boot();
  pick(['a.mp4']);
  loads(probes[0]);
  await settle();
  // a.mp4 is opening (its load never finishes here): b.mp4 is checked in the background.
  assert.equal(els.video.srcs.length, 1);
  pick(['b.mp4']);
  assert.equal(probes.length, 2);
  assert.deepEqual(ui(), { busy: true, title: 'Opening your swing…', toast: null });
  els.cancel.onclick();
  await settle();
  assert.equal(probes[1].onloadeddata, null, 'the background check stopped');
  assert.equal(els.video.srcs.length, 1, 'b.mp4 never loads');
  assert.equal(ui().busy, false);
  assert.equal(els.uploadPanel.hidden, false);
});

test('app: a newer pick takes over the check overlay from one still being checked', async () => {
  const { els, probes, ui, pick, loads } = await boot();
  pick(['a.mp4']);
  pick(['b.mp4']);
  await settle();
  assert.equal(probes[0].onloadeddata, null, 'the first check stopped');
  assert.deepEqual(ui(), { busy: true, title: 'Opening your swing…', toast: null });
  loads(probes[1]);
  await settle();
  assert.equal(ui().title, 'Opening your swing…');
  els.cancel.onclick();
});

test('app: while a batch is checked, picks, drops and the file picker are refused', async () => {
  const { els, probes, ui, pick, loads } = await boot();
  pick(['a.mp4', 'b.mp4']);
  assert.deepEqual(ui(), { busy: true, title: 'Checking 2 clips…', toast: null });
  pick(['c.mp4']);
  assert.equal(ui().toast, 'Finish or cancel the batch first.');
  els.toast.hidden = true;
  document.dispatch('drop', { dataTransfer: { files: [new File(['x'], 'd.mp4', { type: 'video/mp4' })] } });
  assert.equal(ui().toast, 'Finish or cancel the batch first.');
  assert.equal(els.fileInput.dispatch('click').defaultPrevented, true);
  assert.equal(probes.length, 1);
  // The batch opens intact once both clips pass.
  loads(probes[0]); await settle();
  loads(probes[1]); await settle();
  assert.equal(ui().title, 'Bulk 1 of 2 · Opening…');
  assert.deepEqual([els.batchResults.hidden, els.batchList.children.map(row => row.dataset.kind)], [false, ['active', 'waiting']]);
  els.cancel.onclick();
  await settle();
  assert.equal(ui().busy, false);
  assert.equal(els.fileInput.dispatch('click').defaultPrevented, false);
});

// The first second at 15 fps, then 30 fps: measured on its first frames alone, it would be sampled at 15 Hz.
const slowStart = [...Array.from({ length: 15 }, (_, k) => k / 15), ...Array.from({ length: 60 }, (_, k) => 1 + k / 30)];

test('app: analysis feeds the worker each frame once, stamped by the frame clock, at the fastest stretch rate', async () => {
  const { els, probes, ui, pick, loads, opens } = await boot();
  const workers = FakeWorker.all.length;
  pick(['swing.mp4']); loads(probes[0]); await settle();
  opens(slowStart, 3);
  await until(() => !ui().busy);
  const worker = FakeWorker.all[workers], timing = JSON.parse(els.preview.dataset.frameTimingDiagnostic);
  assert.deepEqual(worker.frames.map(f => f.n), slowStart.map((_, n) => n));
  for (const f of worker.frames) assert.ok(Math.abs(f.t - slowStart[f.n]) < 1e-6, `frame ${f.n} at ${f.t}`);
  assert.deepEqual([timing.clock, timing.sourceFps, timing.sent, timing.distinctFrames, timing.unverified], ['videoframe', 30, 75, 75, 0]);
  // Each 15 fps frame is hit twice by the 30 Hz schedule: the repeat is retried, then dropped.
  assert.deepEqual([timing.planned, timing.duplicatesBeforeRetry, timing.duplicatesAfterRetry], [90, 15, 15]);
  assert.equal(worker.terminated, true);
  assert.equal(els.resultStatus.textContent, 'Could not reliably identify the ball in this video.');
});

test('app: without a frame clock analysis feeds each picture once, stamped from the schedule', async () => {
  const { els, probes, ui, pick, loads, opens } = await boot({ clock: false });
  const workers = FakeWorker.all.length;
  pick(['swing.mp4']); loads(probes[0]); await settle();
  opens(slowStart, 3);
  await until(() => !ui().busy);
  const worker = FakeWorker.all[workers], timing = JSON.parse(els.preview.dataset.frameTimingDiagnostic);
  // No rVFC either, so a guessed, unmeasured 30 fps: exact pixel repeats of the 15 fps frames are dropped.
  assert.deepEqual([timing.clock, timing.sourceFps, timing.fpsMeasured, timing.sent, timing.unverified, timing.repeatsDropped, timing.distinctFrames], ['none', 30, false, 75, 75, 15, null]);
  assert.deepEqual(worker.frames.map(f => f.n), slowStart.map((_, n) => n));
  for (const f of worker.frames) assert.ok(Math.abs(f.t - slowStart[f.n]) < 1e-6, `frame ${f.n} at ${f.t}`);
});

/* ---------------------------------------------------------------- hf engine, bench hook, manual adjust, bulk */

import { exampleResult, makeAbstention } from '../dist/hf/types.js';
import { cameraAt, toRaw } from '../dist/render-trace.js';
import { HF_BUILD_KEY, HF_FILES } from '../dist/analysis-client.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const frames30 = Array.from({ length: 90 }, (_, k) => k / 30);
async function hfBoot(search = '?engine=hf&bench=1') {
  for (const k of ['__flightlineBench', '__flightlineLastResult', '__flightlineLastExport']) delete globalThis[k];
  return boot({ search });
}
/** Pick and open one clip, then wait for its analysis to finish (the bench hook is set once the page is idle). */
async function analyzeClip(app, name = 'swing.mp4') {
  const workers = FakeWorker.all.length;
  app.pick([name]); app.loads(app.probes.at(-1)); await settle();
  app.opens(frames30, 3);
  await until(() => !app.ui().busy && globalThis.__flightlineLastResult);
  return FakeWorker.all[workers];
}

test('app ?engine=hf: the analysis client runs the clip, the HFResult is applied, and the bench hook reports it', async () => {
  const result = exampleResult('tracked');
  Object.assign(FakeWorker, { hf: null, result });
  const app = await hfBoot(), { els } = app;
  assert.deepEqual(globalThis.__flightlineBench, { ready: true, version: null });
  const worker = await analyzeClip(app), [job] = worker.sent;
  assert.deepEqual([job.type, job.options, job.file.name, !!job.port], ['hf-analyze', { prefer: 'auto', diagnostics: false }, 'swing.mp4', true]);
  assert.match(job.jobId, /^hf-/);
  assert.equal(worker.terminated, true);
  assert.equal(els.resultStatus.textContent, 'Flight traced · 12 observed frames · arc completed to the landing.');
  assert.deepEqual([els.resultStatus.dataset.status, els.resultReasons.hidden, els.export.disabled], ['tracked', true, false]);
  assert.deepEqual([els.confidenceTitle.textContent, els.confidenceNote.textContent, els.confidenceFill.style.width], ['Confidence 93%', '(calibrated on synthetic clips)', '93%']);
  const hook = globalThis.__flightlineLastResult;
  assert.deepEqual(Object.keys(hook), ['engine', 'status', 'result', 'timings', 'frameTiming', 'error']);
  assert.deepEqual([hook.engine, hook.status, hook.error, hook.result], ['hf', 'tracked', null, result]);
  assert.deepEqual(hook.frameTiming, { ...HF_META, fallback: null });
  assert.ok(hook.timings.analysisMs > 0);
  assert.deepEqual(Object.keys(hook.timings.phases), ['open', 'probe', 'scan']);
  assert.deepEqual(JSON.parse(els.preview.dataset.trackingDiagnostic), result);
  // ?decode= forces the decode path.
  const forced = await hfBoot('?engine=hf&decode=element');
  assert.deepEqual((await analyzeClipQuiet(forced)).sent[0].options, { prefer: 'element', diagnostics: false });
});
/** analyzeClip for a page without the bench hook: wait for the analysis client's worker to finish. */
async function analyzeClipQuiet(app) {
  const workers = FakeWorker.all.length;
  app.pick(['swing.mp4']); app.loads(app.probes.at(-1)); await settle();
  app.opens(frames30, 3);
  await until(() => FakeWorker.all[workers]?.terminated && !app.ui().busy);
  return FakeWorker.all[workers];
}

test('app ?engine=hf draws the result\'s own points through its camera, never a smoothFlight resampling', async () => {
  const result = exampleResult('tracked');
  Object.assign(FakeWorker, { hf: null, result });
  const app = await hfBoot(), { els } = app;
  await analyzeClip(app);
  els.preview.lines.length = 0;
  app.frame();
  const t = els.video.currentTime, cam = cameraAt(result.camera, t), drawn = els.preview.lines;
  assert.ok(t > result.points.at(-1).t, 'the whole arc is revealed');
  for (const p of result.points.filter(q => (q.alpha ?? 1) >= 0.1)) {
    const r = toRaw(cam, p.x, p.y, 64, 36), x = r.x * 64, y = r.y * 36;
    assert.ok(drawn.some(([dx, dy]) => Math.abs(dx - x) < 1e-9 && Math.abs(dy - y) < 1e-9), `point at t=${p.t} drawn as it is`);
  }
});

test('app ?engine=hf: an abstention shows its reason, draws nothing and keeps export locked', async () => {
  Object.assign(FakeWorker, { hf: null, result: makeAbstention(['no_launch']) });
  const app = await hfBoot(), { els } = app;
  await analyzeClip(app);
  assert.equal(els.resultStatus.textContent, 'Could not reliably identify the ball in this video.');
  assert.deepEqual([els.resultStatus.dataset.status, els.resultReasons.hidden, els.resultReasons.textContent], ['no_reliable_track', false, 'No ball left the address in this clip.']);
  assert.equal(els.export.disabled, true);
  assert.deepEqual([globalThis.__flightlineLastResult.status, globalThis.__flightlineLastResult.error], ['no_reliable_track', null]);
  els.preview.arcs.length = 0;
  app.frame();
  assert.equal(els.preview.arcs.length, 0, 'no tracer, no head dot');
});

test('app ?engine=hf: manual adjust places points where clicked (through the camera), is labelled manual, and Undo restores the arc', async () => {
  // The camera pans right by 0.3 of the width over the clip.
  const result = { ...exampleResult('tracked'), camera: [{ t: 0, x: 0, y: 0, s: 1, r: 0 }, { t: 3, x: 0.3, y: 0, s: 1, r: 0 }] };
  Object.assign(FakeWorker, { hf: null, result });
  const app = await hfBoot(), { els } = app, scrub = t => els.timeline.dispatch('input', { target: { value: String(t) } });
  const click = async (x, y) => { els.preview.dispatch('click', { clientX: x, clientY: y }); await settle(10); };
  await analyzeClip(app);
  els.editTrace.onclick();
  assert.equal(els.resultStatus.dataset.status, 'manual');
  scrub(1.5);
  await click(32, 18);
  assert.equal(els.resultStatus.textContent, 'Manual trace · 1 placed point on the automatic arc · Ready to export.');
  assert.equal(els.export.disabled, false);
  // Placed at t = 1.5 under a 0.15 pan, so at t = 3 (0.3 pan) its dot is 0.15 of the width further right.
  scrub(3); els.preview.arcs.length = 0; app.frame();
  assert.ok(els.preview.arcs.some(([x, y]) => Math.abs(x - (0.5 + 0.15) * 64) < 1e-6 && Math.abs(y - 18) < 1e-6), JSON.stringify(els.preview.arcs.slice(-3)));
  els.undo.onclick();
  assert.match(els.resultStatus.textContent, /^Flight traced · 12 observed frames/);
  assert.equal(els.resultStatus.dataset.status, 'tracked');
  els.clearTrace.onclick();
  assert.equal(els.resultStatus.textContent, 'Manual trace · Place at least two points at different times.');
  assert.equal(els.export.disabled, true);
  scrub(1); await click(20, 30);
  scrub(1.4); await click(40, 10);
  assert.equal(els.resultStatus.textContent, 'Manual trace · 2 points · Ready to export.');
  els.doneEditing.onclick();
  assert.deepEqual([els.resultStatus.dataset.status, els.export.disabled], ['manual', false]);
});

test('app ?engine=hf: Cancel stops the analysis at once and says so; the worker is told to cancel the job, then terminated', async () => {
  FakeWorker.hf = (worker, m) => {
    if (m.type === 'hf-analyze') setTimeout(() => { worker.emit({ type: 'hf-source', jobId: m.jobId, meta: { ...HF_META, path: 'element' } }); worker.emit({ type: 'hf-progress', jobId: m.jobId, phase: 'scan', done: 3, total: 90 }); }, 0);
    if (m.type === 'hf-cancel') setTimeout(() => worker.emit({ type: 'hf-error', jobId: m.jobId, code: 'aborted', message: 'aborted' }), 5);
  };
  const app = await hfBoot(), { els, ui } = app, workers = FakeWorker.all.length;
  app.pick(['swing.mp4']); app.loads(app.probes.at(-1)); await settle();
  app.opens(frames30, 3);
  await until(() => els.busyText.textContent.includes('Scanning frames · 3 of 90'));
  assert.match(els.busyText.textContent, /Slower decoding path: keep this tab visible\./);
  els.cancel.onclick();
  await settle();
  assert.equal(ui().busy, false);
  assert.deepEqual([els.resultStatus.textContent, els.export.disabled], ['Analysis cancelled.', true]);
  const worker = FakeWorker.all[workers], job = worker.sent[0].jobId;
  assert.deepEqual(worker.sent.slice(1), [{ type: 'hf-cancel', jobId: job }]);
  await until(() => worker.terminated);
  const hook = globalThis.__flightlineLastResult;
  assert.deepEqual([hook.engine, hook.status, hook.result, hook.frameTiming.path], ['hf', 'no_reliable_track', null, 'element']);
  assert.match(hook.error, /^AbortError: /);
  FakeWorker.hf = null;
});

test('app ?engine=hf: a worker failure says so in plain words; the hook keeps the worker\'s own message', async () => {
  FakeWorker.hf = (worker, m) => { if (m.type === 'hf-analyze') setTimeout(() => worker.emit({ type: 'hf-error', jobId: m.jobId, code: 'unsupported', message: 'codec: no-moov; element: cannot play' }), 0); };
  const app = await hfBoot(), { els } = app;
  await analyzeClip(app);
  assert.deepEqual([els.resultStatus.textContent, els.export.disabled], ['Analysis failed.', true]);
  assert.equal(app.ui().toast, 'This video could not be decoded in this browser. Try an H.264 MP4.');
  assert.equal(globalThis.__flightlineLastResult.error, 'AnalysisError: This video could not be decoded in this browser. Try an H.264 MP4. (codec: no-moov; element: cannot play)');
  FakeWorker.hf = null;
});

test('bulk mode exports an hf clip unseen only when it is tracked with confidence >= 0.9', async () => {
  Object.assign(FakeWorker, { hf: null, result: m => ({ ...exampleResult('tracked'), confidence: { value: m.file.name === 'sure.mp4' ? 0.93 : 0.85, calibratedOn: 'synthetic-tune-v1', components: {} } }) });
  const app = await hfBoot('?engine=hf'), { els, ui } = app;
  app.pick(['sure.mp4', 'unsure.mp4']);
  app.loads(app.probes[0]); await settle(); app.loads(app.probes[1]); await settle();
  app.opens(frames30, 3);
  await until(() => els.video.srcs.length === 2);
  app.opens(frames30, 3);
  await until(() => !ui().busy && /^Batch done/.test(els.batchTitle.textContent));
  const rows = els.batchList.children.map(row => [row.dataset.kind, String(row.lastChild.children[0])]);
  // The confident clip went on to export (which this test browser cannot do); the other waits for review.
  assert.deepEqual(rows, [['failed', 'Video export is unavailable in this browser. Try a current desktop Chrome, Edge, or Safari.'], ['review', 'Needs review · Confidence 85% is below 90%']]);
  assert.equal(globalThis.__flightlineLastResult, undefined, 'no bench hook without ?bench=1');
});

test('app ?bench=1: a clip that does not open still gets a hook entry, with the selected engine and the error', async () => {
  const app = await hfBoot(), { els } = app;
  app.pick(['broken.mp4']); app.loads(app.probes.at(-1)); await settle();
  els.video.dispatch('error');
  await until(() => globalThis.__flightlineLastResult);
  const hook = globalThis.__flightlineLastResult;
  assert.deepEqual([hook.engine, hook.status, hook.result, hook.timings], ['hf', null, null, { analysisMs: null, phases: {} }]);
  assert.equal(hook.error, 'Error: Your browser cannot read this video codec. Try an H.264 MP4.');
  assert.equal(app.ui().busy, false);
});

test('app ?bench=1: a pick the check refuses still gets a hook entry at once; one refused behind running work does not', async () => {
  const app = await hfBoot(), { els } = app;
  app.pick(['junk.mp4']); app.probes.at(-1).onerror(); await settle();
  assert.equal(app.ui().toast, 'Your browser cannot read this video codec. Try an H.264 MP4.');
  assert.deepEqual(globalThis.__flightlineLastResult, {
    engine: 'hf', status: null, result: null, timings: { analysisMs: null, phases: {} }, frameTiming: null,
    error: 'Error: Your browser cannot read this video codec. Try an H.264 MP4.'
  });
  assert.deepEqual([app.ui().busy, els.uploadPanel.hidden, els.video.srcs], [false, false, []]);
  delete globalThis.__flightlineLastResult;
  els.fileInput.files = [new File(['x'], 'notes.txt', { type: 'text/plain' })]; els.fileInput.dispatch('change'); await settle();
  assert.equal(globalThis.__flightlineLastResult.error, 'Error: Choose a video file: MP4, MOV, or WebM.');
  // A refused batch is no single-clip run: no hook entry.
  delete globalThis.__flightlineLastResult;
  els.fileInput.files = ['a.txt', 'b.txt'].map(n => new File(['x'], n, { type: 'text/plain' })); els.fileInput.dispatch('change'); await settle();
  assert.equal(app.ui().toast, 'Choose a video file: MP4, MOV, or WebM.');
  assert.equal(globalThis.__flightlineLastResult, undefined);
  // While an analysis runs, a refused pick leaves it (and the hook) alone: the analysis reports when it ends.
  FakeWorker.hf = (worker, m) => { if (m.type === 'hf-cancel') setTimeout(() => worker.emit({ type: 'hf-error', jobId: m.jobId, code: 'aborted', message: 'aborted' }), 0); };
  delete globalThis.__flightlineLastResult;
  app.pick(['swing.mp4']); app.loads(app.probes.at(-1)); await settle();
  app.opens(frames30, 3);
  await until(() => FakeWorker.all.at(-1).sent.length);
  app.pick(['junk2.mp4']); app.probes.at(-1).onerror(); await settle();
  assert.equal(globalThis.__flightlineLastResult, undefined);
  assert.equal(app.ui().busy, true);
  els.cancel.onclick();
  await until(() => globalThis.__flightlineLastResult);
  assert.match(globalThis.__flightlineLastResult.error, /^AbortError: /);
  FakeWorker.hf = null;
  // A refusal once that run is over reports itself, not the run before it.
  app.pick(['junk3.mp4']); app.probes.at(-1).onerror(); await settle();
  assert.deepEqual(globalThis.__flightlineLastResult, {
    engine: 'hf', status: null, result: null, timings: { analysisMs: null, phases: {} }, frameTiming: null,
    error: 'Error: Your browser cannot read this video codec. Try an H.264 MP4.'
  });
});

test('app ?bench=1: a failed or cancelled analysis keeps the phase it was in, so the phases add up', async () => {
  // hf: the decoder fails at least 45 ms into the scan (each message timed from the one before).
  FakeWorker.hf = (worker, m) => {
    if (m.type !== 'hf-analyze') return;
    const steps = [[0, { type: 'hf-source', meta: HF_META }], [1, { type: 'hf-progress', phase: 'probe', done: 0, total: 1 }], [1, { type: 'hf-progress', phase: 'scan', done: 3, total: 90 }],
      [45, { type: 'hf-error', code: 'decode', message: 'sample 87 lies past the end of the file' }]];
    const next = () => { const [ms, data] = steps.shift() ?? []; if (data) setTimeout(() => { worker.emit({ jobId: m.jobId, ...data }); next(); }, ms); };
    next();
  };
  const app = await hfBoot();
  await analyzeClip(app);
  let hook = globalThis.__flightlineLastResult;
  assert.match(hook.error, /^AnalysisError: Decoding failed partway/);
  assert.deepEqual(Object.keys(hook.timings.phases), ['open', 'probe', 'scan']);
  assert.ok(hook.timings.phases.scan >= 44, JSON.stringify(hook.timings));
  const sum = Object.values(hook.timings.phases).reduce((a, b) => a + b, 0);
  assert.ok(sum <= hook.timings.analysisMs + 1e-6 && sum >= 0.5 * hook.timings.analysisMs, JSON.stringify(hook.timings));
  // v2: the worker fails the finish call.
  FakeWorker.hf = null; FakeWorker.finish = { error: 'association blew up' };
  const v2 = await hfBoot('?bench=1');
  v2.pick(['swing.mp4']); v2.loads(v2.probes.at(-1)); await settle();
  v2.opens(slowStart, 3);
  await until(() => !v2.ui().busy && globalThis.__flightlineLastResult);
  hook = globalThis.__flightlineLastResult;
  assert.deepEqual([hook.engine, hook.error], ['v2', 'Error: association blew up']);
  assert.deepEqual(Object.keys(hook.timings.phases), ['init', 'timing', 'frames', 'finish']);
  FakeWorker.finish = null;
});

test('app ?engine=hf: the first hf job of a build revalidates every dist/hf file before its worker starts; the next one does not', async () => {
  Object.assign(FakeWorker, { hf: null, result: exampleResult('tracked') });
  Object.assign(Net, { calls: [], hold: true });
  const app = await hfBoot(), workers = FakeWorker.all.length;
  app.pick(['swing.mp4']); app.loads(app.probes.at(-1)); await settle();
  app.opens(frames30, 3);
  await until(() => Net.calls.length === HF_FILES.length);
  await settle(20);
  assert.equal(FakeWorker.all.length, workers, 'no worker before the refresh is done');
  const hf = fileURLToPath(new URL('../dist/hf/', import.meta.url));
  assert.deepEqual(Net.calls.map(([url, cache]) => [relative(hf, fileURLToPath(url)), cache]), HF_FILES.map(f => [f, 'no-cache']));
  Net.release(); Net.hold = false;
  await until(() => !app.ui().busy && globalThis.__flightlineLastResult);
  assert.deepEqual([FakeWorker.all.length, globalThis.__flightlineLastResult.status], [workers + 1, 'tracked']);
  assert.equal(localStorage.getItem(HF_BUILD_KEY), '53');
  await analyzeClip(app);
  assert.equal(Net.calls.length, HF_FILES.length, 'once per build');
});

test('app ?bench=1 with v2: the hook reports the worker result, phase timings and the frame timing', async () => {
  const app = await hfBoot('?bench=1'), { els } = app;
  const workers = FakeWorker.all.length;
  app.pick(['swing.mp4']); app.loads(app.probes.at(-1)); await settle();
  app.opens(slowStart, 3);
  await until(() => !app.ui().busy && globalThis.__flightlineLastResult);
  const hook = globalThis.__flightlineLastResult, timing = JSON.parse(els.preview.dataset.frameTimingDiagnostic);
  assert.deepEqual([hook.engine, hook.status, hook.error, hook.result.engine], ['v2', 'no_reliable_track', null, 'global-v2']);
  assert.deepEqual(Object.keys(hook.timings.phases), ['init', 'timing', 'frames', 'finish']);
  assert.deepEqual(hook.frameTiming, timing);
  assert.equal(FakeWorker.all[workers].sent[0].engine, 'v2');
});

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

test('the dist/hf revalidation list is every dist/hf module, so a build change refreshes all of them', () => {
  const hf = fileURLToPath(new URL('../dist/hf/', import.meta.url)), files = walk(hf).filter(f => /\.m?js$/.test(f)).map(f => relative(hf, f)).sort();
  assert.deepEqual([...HF_FILES].sort(), files, 'add a new dist/hf file to HF_FILES in dist/analysis-client.js');
});

test('one build version for every ?v= specifier, and every module, worker, script and stylesheet outside dist/hf carries it', () => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url)), files = walk(dist).filter(f => /\.(m?js|html|css)$/.test(f)), versions = new Map();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\?v=([\w.-]+)/g)) versions.set(m[1], [...new Set([...(versions.get(m[1]) ?? []), relative(dist, f)])]);
  assert.equal(versions.size, 1, `build versions: ${[...versions].map(([v, where]) => `${v} in ${where.join(', ')}`).join('; ')}`);
  const [build] = versions.keys(), outside = files.filter(f => !relative(dist, f).startsWith('hf'));
  // Static and dynamic imports, worker URLs, the page's script and stylesheet: relative .js / .css specifiers.
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*|\bsrc=|\bhref=)['"](\.{0,2}\/?[\w./-]+\.(?:m?js|css))(\?[^'"]*)?['"]/g;
  let count = 0;
  for (const f of outside) for (const m of readFileSync(f, 'utf8').matchAll(SPEC)) { count++; assert.equal(m[2], `?v=${build}`, `${relative(dist, f)}: ${m[1]}`); }
  assert.ok(count >= 25, `${count} specifiers checked`);
  assert.match(readFileSync(join(dist, 'tracker.js'), 'utf8'), new RegExp(`\\} from '\\./global-associate\\.js\\?v=${build}';`));
  for (const page of ['index.html', 'qa/diagnose.html']) assert.ok(readFileSync(join(dist, page), 'utf8').includes(`?v=${build}`), page);
  // The v2 app and worker never load dist/hf up front: it is imported dynamically, by an hf job only.
  for (const f of ['app.js', 'analysis-client.js', 'render-trace.js', 'track-status.js', 'frame-source.js', 'picker.js', 'curve.js', 'worker.js', 'tracker.js', 'global-associate.js']) {
    for (const m of readFileSync(join(dist, f), 'utf8').matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)) assert.ok(!m[1].includes('hf/'), `${f} statically imports ${m[1]}`);
  }
});
