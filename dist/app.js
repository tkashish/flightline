import { DEFAULT_ENGINE, ENGINES, analysisSchedule, frameFeed, measureFrameTiming, pickEngine } from './frame-source.js?v=53';
import { bulkReviewReason, normalizeTrackReport, stopReason } from './track-status.js?v=53';
import { createPicker } from './picker.js?v=53';
import { DECODE_PATHS, createAnalysisWorker, startAnalysis } from './analysis-client.js?v=53';
import { cameraAt, drawKnots, drawTrace as renderTrace, toStab, traceCurve } from './render-trace.js?v=53';

const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d'), video = $('video');
const BULK_LIMIT = 25, BULK_RETRIES = 2, BATCH_BUSY = 'Finish or cancel the batch first.';
const query = new URLSearchParams(location.search);
// ?bench=1: the benchmark hook (tests/bench/run-browser.mjs) reads window.__flightline{Bench,LastResult,LastExport}.
const BENCH = query.get('bench') === '1', BUILD = Number(new URL(import.meta.url).searchParams.get('v')) || null;
const state = {
  demo: true, time: 0, playing: true, points: [], camera: [], color: '#f5fa9b', glow: true, hold: true,
  showTrace: true, editing: false, busy: false, exporting: false, url: null, file: null, controller: null, history: [], bulk: false,
  report: null, trackStatus: null, reasonCodes: [], confidence: null, engine: 'v2', dense: false, exportable: false, downloadURL: null, batchURLs: []
};
const scene = new Image(); scene.src = 'scene.svg';
let lastTime = performance.now(), toastTimer, audioContext, audioSource, monitor, curve = null, analysis = null;
const demoPoints = Array.from({ length: 100 }, (_, i) => {
  const u = i / 99, v = 1 - u;
  return { t: 1 + u * 4.4, x: v ** 3 * .55 + 3 * v * v * u * .64 + 3 * v * u * u * .88 + u ** 3 * .693, y: v ** 3 * .88 + 3 * v * v * u * -.28 + 3 * v * u * u * .03 + u ** 3 * .513 };
});
const format = seconds => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function setBusy(busy, title = '', detail = '') {
  state.busy = busy; $('busyOverlay').hidden = !busy;
  $('busyTitle').textContent = title; $('busyText').textContent = detail; $('progress').value = 0;
  // Upload controls stay enabled: choosing a valid new clip replaces a running analysis or export.
  for (const id of ['play', 'timeline', 'editTrace', 'styleControls', 'toggleTrace', 'backFrame', 'forwardFrame', 'undo', 'clearTrace', 'doneEditing']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  syncExportEnabled();
}
function syncExportEnabled() {
  $('export').disabled = !(!state.busy && !state.demo && state.exportable && state.points.length >= 2);
}
function applyTrackReport(report) {
  // The latest analysis report (automatic or stopped); unedited points fall back to it after manual adjust.
  if (report.status !== 'manual') state.report = report;
  state.points = report.points;
  state.camera = report.camera;
  state.trackStatus = report.status;
  state.reasonCodes = report.reasonCodes;
  state.confidence = report.confidence;
  state.exportable = report.exportable;
  state.engine = report.engine || state.engine;
  // An hf result is the dense display curve, drawn as it is; v2 and manual traces go through curve.js.
  state.dense = report.engine === 'hf' && report.status !== 'manual';
  curve = null;
  const statusEl = $('resultStatus');
  statusEl.textContent = report.headline;
  statusEl.dataset.status = report.status || '';
  statusEl.classList.toggle('warn', !report.exportable || report.status === 'partial');
  const reasons = $('resultReasons');
  if (report.reasonText?.length) {
    reasons.hidden = false;
    reasons.textContent = report.reasonText.join(' ');
  } else {
    reasons.hidden = true;
    reasons.textContent = '';
  }
  const confRow = $('confidenceRow');
  const fill = $('confidenceFill');
  if (confRow && fill && report.confidence) {
    confRow.hidden = false;
    fill.style.width = `${Math.round(report.confidence.displayScore * 100)}%`;
    $('confidenceTitle').textContent = report.confidence.title ?? 'Evidence';
    $('confidenceNote').textContent = report.confidence.caption ?? (report.confidence.calibrated ? '' : '(relative evidence)');
  } else if (confRow) {
    confRow.hidden = true;
  }
  syncExportEnabled();
}
/** A new clip starts with no status, reasons, evidence or export from the previous one. */
function resetReport() {
  Object.assign(state, { report: null, trackStatus: null, reasonCodes: [], confidence: null, exportable: false, dense: false });
  const statusEl = $('resultStatus');
  statusEl.textContent = ''; statusEl.dataset.status = ''; statusEl.classList.remove('warn');
  $('resultReasons').hidden = true; $('resultReasons').textContent = '';
  $('confidenceRow').hidden = true;
  syncExportEnabled();
}
/** The analysis report while the points are unedited (or undone back to it), else a manual trace. */
function manualStatus() {
  const automatic = state.report && state.points === state.report.points;
  applyTrackReport(automatic ? state.report : normalizeTrackReport({ status: 'manual', points: state.points, camera: state.camera, engine: state.engine }));
}
function setEditing(editing) {
  const wasEditing = state.editing;
  state.editing = editing; $('manualTools').hidden = !editing; $('stage').classList.toggle('editing', editing);
  $('editTrace').hidden = editing;
  if (editing) {
    video.pause(); state.playing = false;
    updateStatus('Manual override · click the ball to place points.', false, 'manual');
  } else if (wasEditing && !state.demo) manualStatus();
}
function abortError() { return new DOMException('Operation cancelled', 'AbortError'); }
function timeoutError(message) { return new DOMException(message, 'TimeoutError'); }
// Hiding the tab freezes the canvas, so it stops a recording; bulk mode retries once the tab is back.
function tabHiddenError() { return Object.assign(new Error('Export stopped because the tab was hidden.'), { name: 'TabHiddenError' }); }
function seek(element, time, signal, last = element.duration - .001) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const target = Math.max(0, Math.min(Math.max(0, last), time));
    if (Math.abs(element.currentTime - target) < .0001 && element.readyState >= 2) return resolve();
    const clean = () => { clearTimeout(timeout); element.removeEventListener('seeked', done); element.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted); };
    const done = () => { clean(); resolve(); }, failed = () => { clean(); reject(new Error('This video could not be decoded. Try an H.264 MP4.')); }, aborted = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(() => { clean(); reject(timeoutError('Video decoding timed out. Try a shorter H.264 MP4.')); }, 15000);
    element.addEventListener('seeked', done, { once: true }); element.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', aborted, { once: true }); element.currentTime = target;
  });
}
// Analysis seeks may land on the very end: a clip whose first frame starts late keeps its last frame there.
const seekThrough = (element, time, signal) => seek(element, time, signal, element.duration);
// A hidden tab defers media loading entirely, so load timeouts count only time the page is visible.
function visibleTimeout(fn, ms) {
  let timer;
  const arm = () => { clearTimeout(timer); if (!document.hidden) timer = setTimeout(fn, ms); };
  document.addEventListener('visibilitychange', arm); arm();
  return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', arm); };
}
function loadVideo(url, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { stopTimeout(); video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('Your browser cannot read this video codec. Try an H.264 MP4.')); };
    const abort = () => { clean(); reject(abortError()); };
    const stopTimeout = visibleTimeout(() => { clean(); reject(new Error('Video took too long to load. Try a smaller clip.')); }, 20000);
    video.addEventListener('loadeddata', done, { once: true }); video.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', abort, { once: true });
    video.src = url; video.load();
  });
}
/** The engine named by ?engine= (v2 by default, hf allowed); an unknown name falls back to the default, with a note when asked. */
function selectedEngine(note = true) {
  try { return pickEngine(query.get('engine'), ENGINES); } catch (error) { if (note) toast(`${error.message} Using ${DEFAULT_ENGINE}.`); return DEFAULT_ENGINE; }
}
function workerCall(worker, message, signal, transfer = []) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const clean = () => { clearTimeout(timeout); worker.removeEventListener('message', done); worker.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = event => { clean(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    const failed = () => { clean(); reject(new Error('Automatic detection could not start.')); };
    const aborted = () => { clean(); reject(abortError()); };
    // Finish/association can exceed 20s on long clips; frames stay short.
    const timeoutMs = message?.type === 'finish' ? 120000 : 30000;
    const timeout = setTimeout(() => { clean(); reject(timeoutError('Detection timed out.')); }, timeoutMs);
    worker.addEventListener('message', done, { once: true }); worker.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
    worker.postMessage(message, transfer);
  });
}
function updateStatus(message, warning = false, status = '') {
  $('resultStatus').textContent = message;
  $('resultStatus').classList.toggle('warn', warning);
  if (status) $('resultStatus').dataset.status = status;
  syncExportEnabled();
}
function resetDemo() {
  video.pause(); video.removeAttribute('src'); video.load();
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { demo: true, time: 0, playing: true, url: null, file: null, points: [], camera: [], history: [] });
  resetReport();
  canvas.width = 1280; canvas.height = 720;
  video.hidden = true;
  $('uploadPanel').hidden = false; $('editPanel').hidden = true;
  $('timeline').max = 8; $('duration').textContent = '0:08';
  setEditing(false);
}
function isVideoFile(file) {
  return !!file && (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name));
}
function validateVideoFile(file) {
  if (!isVideoFile(file)) return 'Choose a video file: MP4, MOV, or WebM.';
  if (file.size > 250 * 1024 * 1024) return 'This clip is over 250 MB. Trim or compress it, then try again.';
  return null;
}
/** Why a loaded clip cannot be analyzed, or null. */
function clipProblem(element) {
  if (!Number.isFinite(element.duration) || element.duration <= 0) return 'This video has no readable duration. Try an H.264 MP4.';
  if (element.duration > 30.05) return 'Please trim your video to one swing, 30 seconds or less.';
  if (!element.videoWidth || !element.videoHeight) return 'This file has no video picture. Choose a video clip.';
  return null;
}
/** Every check, including duration and a decoded first frame, on a detached element: a rejected pick never touches the open clip. */
function inspectVideoFile(file, signal) {
  const invalid = validateVideoFile(file);
  if (invalid || signal?.aborted) return Promise.resolve(invalid || 'Cancelled.');
  const probe = document.createElement('video'), url = URL.createObjectURL(file);
  probe.muted = true; probe.preload = 'auto';
  return new Promise(resolve => {
    const done = problem => {
      stopTimeout(); probe.onloadeddata = probe.onerror = null; signal?.removeEventListener('abort', stopped);
      probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url); resolve(problem);
    };
    const stopped = () => done('Cancelled.');
    const stopTimeout = visibleTimeout(() => done('Video took too long to load. Try a smaller clip.'), 20000);
    probe.onerror = () => done('Your browser cannot read this video codec. Try an H.264 MP4.');
    probe.onloadeddata = () => done(clipProblem(probe));
    signal?.addEventListener('abort', stopped, { once: true });
    probe.src = url;
  });
}
function enterEditorChrome(file) {
  $('uploadPanel').hidden = true; $('editPanel').hidden = false;
  $('timeline').max = video.duration; $('duration').textContent = format(video.duration);
  state.demo = false; state.file = file; state.playing = false;
  // Show the real video element — canvas only draws the tracer on top.
  video.hidden = false;
}
async function openSwing(file, signal, { title = 'Opening your swing…', detail = 'Your video stays on this device.' } = {}) {
  const invalid = validateVideoFile(file);
  if (invalid) throw new Error(invalid);
  video.pause(); setEditing(false); resetReport();
  setBusy(true, title, detail);
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file); state.points = []; state.camera = []; state.history = [];
  curve = null;
  await loadVideo(state.url, signal);
  const problem = clipProblem(video);
  if (problem) throw new Error(problem);
  const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight), 1080 / Math.min(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
  canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
  enterEditorChrome(file);
  // Paint the first frame immediately so the stage is never a blank green plate.
  await seek(video, 0, signal).catch(() => {});
  draw();
}
let runGeneration = 0;
/** Start an upload, batch or export: stop the running one. Only the newest run may clean up after itself. */
function beginRun() {
  state.controller?.abort();
  const generation = ++runGeneration, controller = state.controller = new AbortController();
  return { signal: controller.signal, current: () => generation === runGeneration };
}
function endRun(run) {
  if (!run.current()) return false;
  setBusy(false); state.controller = null;
  return true;
}
/** An analysis that never finished gets its own report (cancelled, timed out, failed). */
function stopAnalysis(error) {
  applyTrackReport(normalizeTrackReport({ status: 'no_reliable_track', reasonCodes: [stopReason(error)], engine: state.engine }));
}
async function upload(file) {
  const run = beginRun(), { signal } = run;
  let loaded = false, analyzed = false, failure = null;
  analysis = null;
  try {
    await openSwing(file, signal);
    if (!run.current()) return;
    loaded = true;
    clearDownloads();
    updateStatus('Finding your flight… scanning frames.');
    await analyze(signal);
    if (!run.current()) return;
    analyzed = true;
    const reviewAt = state.points.length ? Math.max(0, video.duration - .001) : 0;
    await seek(video, reviewAt, signal);
    draw();
  } catch (error) {
    failure = error;
    if (!run.current()) return;
    if (!loaded) resetDemo();
    else if (!analyzed) stopAnalysis(error);
    if (error.name !== 'AbortError') toast(error.message);
  } finally { if (endRun(run)) publishResult(failure); }
}
/**
 * ?bench=1: what the last single-clip run gave, once the page is idle again (export enabled or not): an analysis,
 * a clip that did not open, or a pick the check refused (no analysis: status and result null).
 */
function publishResult(error) {
  if (!BENCH) return;
  const info = analysis;
  globalThis.__flightlineLastResult = {
    engine: info?.engine ?? selectedEngine(false), status: info ? state.trackStatus : null, result: info?.result ?? null,
    timings: { analysisMs: info?.analysisMs ?? null, phases: { ...info?.phases } }, frameTiming: info?.frameTiming ?? null,
    error: error ? `${error.name}: ${error.message}${error.detail ? ` (${error.detail})` : ''}` : null
  };
}
/** Link to a finished export; its object URL lives until a new clip or batch replaces it. */
function downloadLink(blob, baseName, again = false) {
  const extension = blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: `${baseName.replace(/\.[^.]+$/, '')}-flightline.${extension}`,
    textContent: `Download ${extension.toUpperCase()}${again ? ' again' : ''} ↓`
  });
}
function clearDownloads() {
  for (const url of [state.downloadURL, ...state.batchURLs]) if (url) URL.revokeObjectURL(url);
  Object.assign(state, { downloadURL: null, batchURLs: [] });
  $('exportNote').textContent = 'Original audio · Up to 1080p · No watermark';
  $('batchList').replaceChildren(); $('batchResults').hidden = true;
}
function setBatchRow(row, kind, text, link) {
  row.dataset.kind = kind; row.lastChild.replaceChildren(text, ...(link ? [' · ', link] : []));
}
function batchRow(name, kind, text) {
  const row = document.createElement('li'), title = document.createElement('span');
  title.className = 'batch-name'; title.textContent = title.title = name;
  row.append(title, Object.assign(document.createElement('span'), { className: 'batch-note' }));
  setBatchRow(row, kind, text);
  $('batchList').append(row); $('batchResults').hidden = false;
  return row;
}
function whenVisible(signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { document.removeEventListener('visibilitychange', check); signal.removeEventListener('abort', aborted); };
    const check = () => { if (!document.hidden) { clean(); resolve(); } };
    const aborted = () => { clean(); reject(abortError()); };
    if (signal.aborted) return reject(abortError());
    document.addEventListener('visibilitychange', check); signal.addEventListener('abort', aborted, { once: true }); check();
  });
}
/** Bulk export of the open clip. A hidden tab stops only this recording; it restarts once the tab is visible. */
async function exportClip(signal, label, name) {
  for (let attempt = 0; ; attempt++) {
    setBusy(true, `Bulk ${label} · Exporting…`, `${name} · Keep this tab visible. Export runs at playback speed.`);
    try { return await recordExport(signal); } catch (error) { if (error.name !== 'TabHiddenError' || attempt >= BULK_RETRIES) throw error; }
    setBusy(true, `Bulk ${label} · Paused`, `${name} · The tab was hidden. This clip exports again when you come back.`);
    await whenVisible(signal);
  }
}
async function processBulk(files, rejected = []) {
  const run = beginRun(), { signal } = run, queue = files.slice(0, BULK_LIMIT), tally = { saved: 0, review: 0, failed: 0, skipped: 0 };
  if (files.length > BULK_LIMIT) toast(`Bulk mode handles up to ${BULK_LIMIT} clips at a time. Processing the first ${BULK_LIMIT}.`);
  state.bulk = true;
  clearDownloads();
  const settle = (row, kind, text, link) => { tally[kind]++; setBatchRow(row, kind, text, link); };
  const counts = () => [`${tally.saved} saved`, tally.review && `${tally.review} to review`, tally.failed && `${tally.failed} failed`, tally.skipped && `${tally.skipped} not processed`].filter(Boolean);
  // Every clip of the batch gets a row: its outcome, and a download link that outlives the batch.
  const skip = (name, text) => { tally.skipped++; batchRow(name, 'skipped', text); };
  for (const { file, problem } of rejected) skip(file.name, problem);
  for (const file of files.slice(BULK_LIMIT)) skip(file.name, `Not processed · up to ${BULK_LIMIT} clips per batch`);
  const rows = queue.map(file => batchRow(file.name, 'waiting', 'Waiting'));
  let i = 0, opened = false, cancelled = false;
  try {
    for (; i < queue.length; i++) {
      if (signal.aborted) throw abortError();
      const file = queue[i], label = `${i + 1} of ${queue.length}`, detail = `${file.name} · Keep this tab visible.`;
      $('batchTitle').textContent = `Batch · ${label}`;
      setBatchRow(rows[i], 'active', 'In progress');
      opened = false;
      try {
        await openSwing(file, signal, { title: `Bulk ${label} · Opening…`, detail });
        opened = true;
        await analyze(signal, { title: `Bulk ${label} · Finding flight…`, detail }).catch(error => { stopAnalysis(error); throw error; });
        // Only confirmed automatic tracks export unseen; everything else waits for review.
        const review = bulkReviewReason(state.report);
        if (review) { settle(rows[i], 'review', `Needs review · ${review}`); continue; }
        const link = downloadLink(await exportClip(signal, label, file.name), file.name);
        state.batchURLs.push(link.href); settle(rows[i], 'saved', 'Saved', link); link.click();
        // Give the browser a beat between successive downloads.
        await new Promise(resolve => setTimeout(resolve, 450));
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        settle(rows[i], 'failed', error.message || 'Failed');
      }
    }
  } catch (error) {
    if (!run.current()) return;
    cancelled = true;
    rows.slice(i).forEach((row, k) => settle(row, 'skipped', k ? 'Not processed' : 'Cancelled'));
    toast(error.name === 'AbortError' ? 'Bulk cancelled.' : error.message || 'Bulk processing failed.');
  } finally {
    if (run.current()) {
      if (!opened) resetDemo();
      else if (!cancelled) await seek(video, state.points.length ? Math.max(0, video.duration - .001) : 0, signal).catch(() => {});
      $('batchTitle').textContent = `Batch ${cancelled ? 'cancelled' : 'done'} · ${counts().join(' · ')}`;
      if (!cancelled) toast(`Bulk done: ${counts().join(', ')}.${tally.review || tally.failed || tally.skipped ? ' See the batch list for details.' : ''}`);
      state.bulk = false; endRun(run);
    }
  }
}
function openChecked(checked) {
  const valid = checked.filter(c => !c.problem).map(c => c.file), rejected = checked.filter(c => c.problem);
  if (!valid.length) {
    const problem = [...new Set(rejected.map(c => c.problem))].join(' ') || 'Choose a video file: MP4, MOV, or WebM.';
    toast(problem);
    // ?bench=1: a refused single-clip pick is a finished run too, unless other work is still running (it reports).
    if (checked.length === 1 && !state.controller) { analysis = null; publishResult(new Error(problem)); }
    return;
  }
  if (valid.length > 1) return processBulk(valid, rejected);
  if (rejected.length) toast(`Skipped ${rejected.map(c => c.file.name).join(', ')}. ${rejected[0].problem}`);
  return upload(valid[0]);
}
// Check first, duration and decoding included: an unusable pick never touches the open clip or the work in progress.
// A newer pick replaces one still being checked; Cancel drops it; a batch refuses other picks from its check on.
const picker = createPicker({ check: inspectVideoFile, open: openChecked, refuse: () => toast(BATCH_BUSY) });
let checkRun = null;
function handleIncomingFiles(fileList) {
  // A running batch stops only through its Cancel button.
  if (state.bulk) return toast(BATCH_BUSY);
  const files = [...(fileList || [])], note = files.length > 1 ? `Checking ${files.length} clips…` : 'Opening your swing…';
  let run = null;
  return picker.pick(files, {
    // Idle (or only checking an earlier pick) the check is this pick's own run, shown at once; a running analysis or export carries on meanwhile.
    checking: () => {
      run = !state.controller || checkRun?.current() ? checkRun = beginRun() : null;
      if (run) setBusy(true, note, 'Your video stays on this device.'); else if (files.length > 1) toast(note);
    },
    checked: () => { if (run) endRun(run); else if ($('toast').textContent === note) $('toast').hidden = true; }
  });
}
function analysisSeekable() {
  const seekable = video.seekable?.length ? video.seekable.end(video.seekable.length - 1) : 0;
  return seekable >= video.duration * .9;
}

/**
 * Fallback when seeking is unreliable: muted playback hands over each scheduled frame as it is
 * presented. Stops when the clip ends, playback stalls or the tab is hidden (nothing is presented
 * then) and returns the index of the first scheduled frame it did not deliver, for seeks to fetch.
 */
async function captureByPlayback(feed, schedule, { fps, start, read }, send, signal) {
  const rvfc = typeof video.requestVideoFrameCallback === 'function', muted = video.muted, queue = [];
  let next = 0, lastT = -Infinity, done = false, wake = null, handle, moved = Date.now();
  const finish = () => { if (!done) { done = true; video.pause(); wake?.(); } };
  // rVFC stamps the presented frame itself; without it the playback clock picks the frame.
  const listen = () => { handle = rvfc ? video.requestVideoFrameCallback((now, md) => pump(md.mediaTime, true)) : requestAnimationFrame(() => pump(video.currentTime, false)); };
  const pump = (t, verified) => {
    if (done) return;
    // Listen first: a frame presented while this one is read still gets its callback.
    listen();
    // The presented frame's slot: rounded, so a jittered (variable-rate) frame still lands on its own.
    const index = verified ? Math.round((t - start) * fps) : Math.floor((t - start) * fps + 1e-6);
    while (next + 1 < schedule.length && schedule[next + 1].index <= index) next++;
    if (next < schedule.length && schedule[next].index <= index && t > lastT + 1e-6) {
      queue.push(feed.take(verified ? t : schedule[next].pts, verified)); lastT = t; next++; moved = Date.now(); wake?.();
      // Bounded queue: hold playback while the worker catches up.
      if (queue.length >= 3) video.pause();
    }
    if (next >= schedule.length) finish();
  };
  // 'ended' can precede the last frame's callback, so stop on the next tick instead.
  const stall = setInterval(() => { if (video.ended || (!video.paused && Date.now() - moved > 5000)) finish(); }, 250);
  const hide = () => { if (document.hidden) finish(); };
  signal.addEventListener('abort', finish, { once: true }); document.addEventListener('visibilitychange', hide);
  try {
    video.pause(); video.muted = true;
    // Playback only reports frames presented after it starts, so take the first one from a seek.
    const first = await read(schedule[0].t, signal).catch(error => { if (error.name === 'AbortError') throw error; return null; });
    pump(first ?? schedule[0].pts, first != null);
    hide();
    if (done) return next;
    video.play().catch(finish);
    while (!done || queue.length) {
      if (signal.aborted) break;
      if (!queue.length) { await new Promise(resolve => wake = resolve); wake = null; continue; }
      await send(queue.shift());
      if (!done && video.paused && !video.ended && queue.length < 2) { moved = Date.now(); video.play().catch(finish); }
    }
    if (signal.aborted) throw abortError();
    return next;
  } finally {
    finish(); clearInterval(stall); signal.removeEventListener('abort', finish); document.removeEventListener('visibilitychange', hide);
    if (rvfc) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
    video.muted = muted;
  }
}

/** Accumulates ms per named phase: mark(name) ends the running phase and starts `name` (null: none). */
function phaseClock(phases) {
  let name = null, at = performance.now();
  return next => { const now = performance.now(); if (name) phases[name] = (phases[name] ?? 0) + now - at; name = next; at = now; };
}
/**
 * Analyze the open clip with the ?engine= engine (v2 by default; hf through the analysis client) and apply the
 * report. What it gave (engine, result, timings, frame timing) is kept in `analysis` for the bench hook.
 */
async function analyze(signal, labels = {}) {
  const engine = state.engine = selectedEngine(), info = analysis = { engine, result: null, analysisMs: null, phases: {}, frameTiming: null }, t0 = performance.now();
  try { await (engine === 'hf' ? analyzeHF(signal, labels, info) : analyzeFrames(signal, labels, engine, info)); }
  finally { info.analysisMs = performance.now() - t0; }
}
// hf progress phases (dist/hf/types.js PROGRESS_PHASES) on the progress bar: [from %, to %, label].
const HF_STEPS = {
  probe: [1, 2, 'Opening the video…'], scan: [2, 58, 'Scanning frames'], impact: [58, 60, 'Finding the impact…'],
  launch: [60, 74, 'Confirming the launch…'], track: [74, 94, 'Following the ball…'], fit: [94, 98, 'Fitting the flight…'],
  decide: [98, 100, 'Checking the trace…'], done: [100, 100, 'Done.']
};
async function analyzeHF(signal, labels, info) {
  setBusy(true, labels.title || 'Finding your flight…', labels.detail || 'Reading every frame. This may take a minute.');
  const prefer = DECODE_PATHS.includes(query.get('decode')) ? query.get('decode') : 'auto', mark = phaseClock(info.phases);
  const prefix = state.bulk ? `${labels.detail?.split(' · ')[0] || 'Bulk'} · ` : '';
  let phase = null, slow = false, result;
  mark('open');
  // A failed or cancelled run still closes the phase it was in, so the bench hook's phases add up to analysisMs.
  try {
    result = await startAnalysis(state.file, {
      engine: 'hf', signal, prefer, diagnostics: query.has('diagnostics'),
      // The element path seeks a hidden <video> on this page: slower, and it needs the tab visible.
      onSource: (meta, fallback) => { info.frameTiming = { ...meta, fallback }; slow = meta.path === 'element'; },
      onProgress: p => {
        if (p.phase !== phase) mark((phase = p.phase) === 'done' ? null : phase);
        const [lo, hi, label] = HF_STEPS[p.phase] ?? [0, 100, 'Analyzing…'], pct = Math.round(lo + (hi - lo) * (p.total ? p.done / p.total : 1));
        $('progress').value = pct;
        $('busyText').textContent = `${prefix}${p.phase === 'scan' ? `${label} · ${p.done} of ${p.total}` : label}${slow ? ' · Slower decoding path: keep this tab visible.' : ''}`;
        updateStatus(`Finding your flight… ${pct}%`);
      }
    });
  } finally { mark(null); }
  info.result = result;
  canvas.dataset.frameTimingDiagnostic = JSON.stringify(info.frameTiming);
  canvas.dataset.trackingDiagnostic = JSON.stringify(result);
  applyTrackReport(normalizeTrackReport(result));
}
/** v2 and legacy: this page reads each sampled frame from the <video> and feeds it to the worker's tracker. */
async function analyzeFrames(signal, labels, engine, info) {
  setBusy(true, labels.title || 'Finding your flight…', labels.detail || 'Scanning for the ball’s motion. This may take a minute.');
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const scan = document.createElement('canvas'); scan.width = Math.round(video.videoWidth * scale); scan.height = Math.round(video.videoHeight * scale);
  const scanCtx = scan.getContext('2d', { willReadFrequently: true });
  const worker = createAnalysisWorker(), mark = phaseClock(info.phases);
  try {
    const from = Math.max(0, Number(query.get('diagnosticFrom')) || 0);
    const diagnostics = query.has('diagnostics') ? { from, to: from + 1 } : null;
    mark('init');
    await workerCall(worker, { type: 'init', width: scan.width, height: scan.height, diagnostics, engine }, signal);
    mark('timing');
    // Sample real source frames: frame centres of a schedule from the clip's own frame clock, rate and span.
    const canSeek = analysisSeekable(), clip = await measureFrameTiming(video, seekThrough, signal, waitSignal => {
      $('busyText').textContent = 'Keep this tab visible to start reading frames.';
      return whenVisible(waitSignal);
    });
    mark('frames');
    const schedule = analysisSchedule(clip), frames = schedule.length;
    const timing = info.frameTiming = {
      sourceFps: clip.fps, fpsMeasured: clip.measured, clock: clip.clock, start: clip.start, end: clip.end, sampleFps: 30,
      mode: canSeek ? 'seek' : 'playback', planned: frames, sent: 0, distinctFrames: 0, duplicatesBeforeRetry: 0, duplicatesAfterRetry: 0,
      repeatsDropped: 0, unverified: 0, peakResidentFrames: 0, frameBytes: scan.width * scan.height * 4
    };
    const grab = () => {
      scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
      return new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
    };
    // One worker call in flight; the next seek overlaps the worker's detect of the previous frame.
    const feed = frameFeed(grab, (pixels, t) => {
      // Keep the preview alive under the overlay so processing is visible.
      if (timing.sent % 3 === 1) draw();
      // Transfer ownership of the buffer to the worker — no long-lived RGBA cache.
      const call = workerCall(worker, { type: 'frame', buffer: pixels.buffer, time: t }, signal, [pixels.buffer]);
      call.catch(() => {});
      return call;
    }, timing);
    const progress = done => {
      $('progress').value = done / frames * 100;
      if (done % 5 !== 1 && done !== frames) return;
      const pct = Math.round(done / frames * 100), prefix = state.bulk ? `${labels.detail?.split(' · ')[0] || 'Bulk'} · ` : '';
      $('busyText').textContent = `${prefix}Analyzing frame ${done} of ${frames} · ${pct}%`;
      updateStatus(`Finding your flight… ${done}/${frames} · ${pct}%`);
    };
    $('busyText').textContent = canSeek ? `Analyzing 0 of ${frames} frames…` : 'Reading video frames… Keep this tab visible.';
    updateStatus(`Finding your flight… 0/${frames} frames`);
    // Playback hands frames over while it can; seeks fetch every frame it did not (all of them when seeking works).
    const next = canSeek ? 0 : await captureByPlayback(feed, schedule, clip, async sample => { await feed.send(sample); progress(timing.sent); }, signal);
    if (!canSeek && next < frames) timing.mode = 'playback+seek';
    await feed.seek(clip, schedule, next, signal, progress);
    $('busyText').textContent = 'Selecting the best ball path…';
    updateStatus('Finding your flight… finishing association.');
    canvas.dataset.frameTimingDiagnostic = JSON.stringify(timing);
    mark('finish');
    const result = info.result = await workerCall(worker, { type: 'finish' }, signal);
    mark(null);
    const { frames: diagnosticFrames, ...diagnosticSummary } = result;
    canvas.dataset.trackingDiagnostic = JSON.stringify(diagnosticSummary);
    if (diagnostics) canvas.dataset.candidateDiagnostic = JSON.stringify(diagnosticFrames);
    const report = normalizeTrackReport(result);
    applyTrackReport(report);
  } finally { mark(null); worker.terminate(); }
}
/** The tracer at `time` (render-trace.js: the same drawing for the preview and the export). */
function drawTrace(time) {
  if (!state.showTrace) return;
  // Abstention: never invent a tracer when automatic tracking failed.
  if (!state.demo && (state.trackStatus === 'no_reliable_track' || state.points.length < 2)) return;
  const source = state.demo ? demoPoints : state.points, dense = !state.demo && state.dense;
  const clipEnd = !state.demo && Number.isFinite(video.duration) ? video.duration : Infinity;
  if (curve?.source !== source || curve.dense !== dense || curve.clipEnd !== clipEnd) curve = { ...traceCurve(source, { dense, clipEnd }), source };
  renderTrace(ctx, curve, time, { width: canvas.width, height: canvas.height, camera: state.demo ? [] : state.camera, color: state.color, glow: state.glow, hold: state.hold });
}
function draw() {
  const composite = state.demo || state.exporting;
  if (composite) {
    ctx.fillStyle = '#152b21';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (state.demo) {
      if (scene.complete && scene.naturalWidth) ctx.drawImage(scene, 0, 0, canvas.width, canvas.height);
    } else if (video.readyState >= 2) {
      try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { /* decode gap */ }
    }
  } else {
    // Preview: native <video> is visible underneath; keep canvas transparent.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  drawTrace(state.demo ? state.time : video.currentTime);
  if (state.editing) drawKnots(ctx, state.points, video.currentTime, { width: canvas.width, height: canvas.height, camera: state.camera });
}
function loop(now) {
  const dt = Math.min(.1, (now - lastTime) / 1000); lastTime = now;
  if (state.demo && state.playing && !state.busy) state.time = (state.time + dt) % 8;
  draw();
  const t = state.demo ? state.time : video.currentTime;
  $('timeline').value = t; $('time').textContent = format(t);
  $('play').textContent = (state.demo ? state.playing : !video.paused) ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', (state.demo ? state.playing : !video.paused) ? 'Pause preview' : 'Play preview');
  if (state.busy && $('busyTitle').textContent === 'Finishing your replay…') $('progress').value = t / video.duration * 100;
  requestAnimationFrame(loop);
}
async function togglePlay() {
  if (state.busy) return;
  if (state.demo) { state.playing = !state.playing; return; }
  setEditing(false);
  if (video.paused) { if (video.ended) await seek(video, 0); try { await audioContext?.resume(); await video.play(); } catch { toast('Playback could not start. Try pressing play again.'); } }
  else video.pause();
}
/** Export audio runs through the AudioContext, which browsers start only after a click or key press on the page. */
async function startAudio(signal) {
  const started = audioContext.resume();
  if (await Promise.race([started.then(() => true), new Promise(resolve => setTimeout(resolve, 400, false))])) return;
  // No click on the page yet (e.g. a batch started by a drop): wait for one, and let Cancel still stop the run.
  $('busyText').textContent = 'Click anywhere on this page to start the export with sound.';
  await new Promise((resolve, reject) => {
    const clean = () => { document.removeEventListener('pointerdown', go, true); document.removeEventListener('keydown', go, true); signal.removeEventListener('abort', aborted); };
    const ready = () => { clean(); resolve(); }, aborted = () => { clean(); reject(abortError()); };
    const go = () => { audioContext.resume().then(ready, () => {}); };
    started.then(ready, () => {});
    document.addEventListener('pointerdown', go, true); document.addEventListener('keydown', go, true); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
async function recordExport(signal) {
  if (!canvas.captureStream || !window.MediaRecorder) throw new Error('Video export is unavailable in this browser. Try a current desktop Chrome, Edge, or Safari.');
  const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('No compatible video encoder is available in this browser.');
  video.pause();
  const oldTrace = state.showTrace;
  setEditing(false); state.showTrace = true; state.exporting = true;
  let stream, recorder, destination, wakeLock, startedAt = performance.now();
  // A hidden tab stops only this recording (TabHiddenError); the run's own signal stays untouched.
  const hidden = new AbortController(), visibility = () => { if (document.hidden) hidden.abort(); };
  document.addEventListener('visibilitychange', visibility); visibility();
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioSource = audioContext.createMediaElementSource(video);
      monitor = audioContext.createGain(); audioSource.connect(monitor); monitor.connect(audioContext.destination);
    }
    await startAudio(signal);
    monitor.gain.value = 0;
    destination = audioContext.createMediaStreamDestination(); audioSource.connect(destination);
    await seek(video, 0, signal); draw();
    stream = canvas.captureStream(30);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 9_000_000, audioBitsPerSecond: 128_000 });
    const recorded = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', cancelled); hidden.signal.removeEventListener('abort', cancelled); video.removeEventListener('ended', ended); video.removeEventListener('error', videoError); };
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      const cancelled = () => { cleanup(); stop(); reject(signal.aborted ? abortError() : tabHiddenError()); };
      const ended = () => { draw(); stop(); };
      const videoError = () => { cleanup(); stop(); reject(new Error('Video decoding failed during export.')); };
      const timeout = setTimeout(() => { cleanup(); stop(); reject(new Error('Export stalled. Keep this tab visible and try again.')); }, (video.duration + 20) * 1000);
      signal.addEventListener('abort', cancelled, { once: true }); hidden.signal.addEventListener('abort', cancelled, { once: true });
      video.addEventListener('ended', ended, { once: true }); video.addEventListener('error', videoError, { once: true });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cleanup(); reject(new Error('The browser’s video encoder failed. Try another browser.')); };
      recorder.onstop = () => { cleanup(); if (!signal.aborted && !hidden.signal.aborted) resolve(new Blob(chunks, { type: recorder.mimeType || mimeType })); };
      if (signal.aborted || hidden.signal.aborted) return cancelled();
      recorder.start(250); startedAt = performance.now();
      video.play().catch(error => { cleanup(); stop(); reject(error); });
    });
    recorded.catch(() => {});
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    const blob = await recorded;
    if (!blob.size) throw new Error('The export was empty. Please try again.');
    if (BENCH) globalThis.__flightlineLastExport = { mime: blob.type, bytes: blob.size, durationSec: (performance.now() - startedAt) / 1000 };
    return blob;
  } finally {
    video.pause(); if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); if (destination) audioSource.disconnect(destination);
    if (monitor) monitor.gain.value = 1; await wakeLock?.release();
    document.removeEventListener('visibilitychange', visibility);
    state.showTrace = oldTrace;
    state.exporting = false;
  }
}
async function exportVideo() {
  if (state.busy || state.demo) return;
  if (!state.exportable || state.points.length < 2) return toast('No reliable ball flight to export.');
  video.pause();
  const oldTime = video.currentTime, run = beginRun();
  setBusy(true, 'Finishing your replay…', 'Keep this tab visible. Export runs at the video’s playback speed.');
  try {
    const blob = await recordExport(run.signal);
    if (!run.current()) return;
    const link = downloadLink(blob, state.file.name, true);
    $('exportNote').replaceChildren(link); link.click();
    if (state.downloadURL) URL.revokeObjectURL(state.downloadURL);
    state.downloadURL = link.href;
    toast('Your traced video is ready. No watermark, all yours.');
  } catch (error) {
    if (!run.current()) return;
    if (error.name === 'AbortError') toast('Export cancelled.');
    else if (error.name === 'TabHiddenError') toast(`${error.message} Keep this tab visible to finish your video.`);
    else toast(error.message || 'Export failed. Try a shorter clip.');
  } finally {
    // A newer clip owns the video now: never seek or unlock it from here.
    if (endRun(run)) await seek(video, oldTime).catch(() => {});
  }
}

$('fileInput').addEventListener('change', event => { if (event.target.files.length) handleIncomingFiles(event.target.files); event.target.value = ''; });
// Every picker path (dropzone label, keyboard, "Upload another swing") clicks the input; a batch keeps it shut.
$('fileInput').addEventListener('click', event => { if (state.bulk || picker.batching) { event.preventDefault(); toast(BATCH_BUSY); } });
// Running work continues until a valid new clip is actually chosen; a dismissed picker changes nothing.
$('newVideo').onclick = () => {
  if (isPreviewFullscreen()) {
    try {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch { /* continue to file picker */ }
  }
  $('fileInput').click();
};
// The whole page takes drops, so a stray file can never make the browser navigate away from the open clip.
for (const type of ['dragenter', 'dragover']) document.addEventListener(type, event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); handleIncomingFiles(event.dataTransfer?.files); });
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, () => $('dropzone').classList.add('dragover'));
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
$('play').onclick = togglePlay;
// A clip whose first frame starts late reports its full length only once its end has been read.
video.addEventListener('durationchange', () => { if (!state.demo && Number.isFinite(video.duration)) { $('timeline').max = video.duration; $('duration').textContent = format(video.duration); } });
$('timeline').addEventListener('input', event => { if (state.busy) return; if (state.demo) { state.time = +event.target.value; state.playing = false; } else { video.pause(); video.currentTime = +event.target.value; } });
$('toggleTrace').onclick = () => { state.showTrace = !state.showTrace; $('toggleTrace').classList.toggle('active', state.showTrace); $('toggleTrace').setAttribute('aria-pressed', String(state.showTrace)); };
function setTracerColor(color) {
  state.color = color;
  document.querySelectorAll('.swatch').forEach(button => {
    const on = button.dataset.color === color;
    button.classList.toggle('selected', on);
    button.setAttribute('aria-pressed', String(on));
  });
}
function setTracerGlow(on) {
  state.glow = on;
  $('glow').checked = on;
}
function setTracerHold(on) {
  state.hold = on;
  $('hold').checked = on;
}
document.querySelectorAll('.swatch').forEach(button => button.onclick = () => setTracerColor(button.dataset.color));
$('glow').onchange = event => setTracerGlow(event.target.checked);
$('hold').onchange = event => setTracerHold(event.target.checked);
$('editTrace').onclick = () => setEditing(true); $('doneEditing').onclick = () => setEditing(false);
for (const [id, delta] of [['backFrame', -1 / 30], ['forwardFrame', 1 / 30]]) $(id).onclick = () => { video.pause(); seek(video, video.currentTime + delta).catch(error => toast(error.message)); };
// History holds the replaced point arrays themselves, so Undo can land back on the automatic track.
$('undo').onclick = () => { if (state.history.length) { state.points = state.history.pop(); manualStatus(); } };
$('clearTrace').onclick = () => { state.history.push(state.points); state.points = []; manualStatus(); };
canvas.addEventListener('click', async event => {
  if (!state.editing || state.busy || video.seeking) return;
  video.pause(); const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const left = rect.left + (rect.width - canvas.width * scale) / 2, top = rect.top + (rect.height - canvas.height * scale) / 2;
  const x = (event.clientX - left) / (canvas.width * scale), y = (event.clientY - top) / (canvas.height * scale);
  if (x < 0 || y < 0 || x > 1 || y > 1) return;
  // The click is on the frame on screen: back to stabilized coordinates through its camera (hf: with scale and roll).
  const p = toStab(cameraAt(state.camera, video.currentTime), x, y, canvas.width, canvas.height);
  state.history.push(state.points);
  state.points = state.points.filter(q => Math.abs(q.t - video.currentTime) > 1 / 60);
  state.points.push({ t: video.currentTime, x: p.x, y: p.y, status: 'manual' }); state.points.sort((a, b) => a.t - b.t);
  manualStatus(); await seek(video, video.currentTime + .1).catch(error => toast(error.message));
});
// Cancel stops the running work and any pick still being checked, so that pick never opens afterwards.
$('export').onclick = exportVideo; $('cancel').onclick = () => { picker.cancel(); state.controller?.abort(); };
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = $('gotIt').onclick = () => $('helpDialog').close();
$('helpDialog').addEventListener('click', event => { if (event.target === $('helpDialog')) { const r = $('helpDialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('helpDialog').close(); } });

function isPreviewFullscreen() {
  return document.fullscreenElement === $('previewColumn') || document.webkitFullscreenElement === $('previewColumn');
}
function syncFullscreenUi() {
  const on = isPreviewFullscreen();
  document.body.classList.toggle('is-fullscreen', on);
  $('fullscreen').setAttribute('aria-pressed', String(on));
  $('fullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  $('fullscreen').title = on ? 'Exit full screen' : 'Full screen';
}
async function toggleFullscreen() {
  try {
    if (isPreviewFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      const node = $('previewColumn');
      if (node.requestFullscreen) await node.requestFullscreen();
      else if (node.webkitRequestFullscreen) node.webkitRequestFullscreen();
      else toast('Full screen is unavailable in this browser.');
    }
  } catch {
    toast('Full screen could not start. Try again from this tab.');
  }
}
$('fullscreen').onclick = () => toggleFullscreen();
document.addEventListener('fullscreenchange', syncFullscreenUi);
document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

document.addEventListener('keydown', event => {
  if ($('helpDialog').open) return;
  const tag = event.target.tagName;
  if (event.code === 'Space' && !['INPUT', 'BUTTON', 'A', 'TEXTAREA', 'SUMMARY'].includes(tag)) {
    event.preventDefault(); togglePlay();
  }
  // Plain f only: Ctrl/Cmd+F stays the browser's find.
  if ((event.key === 'f' || event.key === 'F') && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) && !['INPUT', 'TEXTAREA'].includes(tag)) {
    event.preventDefault(); toggleFullscreen();
  }
});
if (matchMedia('(prefers-reduced-motion: reduce)').matches) { state.playing = false; state.time = 5.5; }
requestAnimationFrame(loop);
if (BENCH) globalThis.__flightlineBench = { ready: true, version: BUILD };
