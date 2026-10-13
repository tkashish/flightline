import { cameraAt, visiblePath } from './tracker.js?v=48';
import { smoothFlight } from './curve.js?v=48';
import { plannedSampleTimes, isNearDuplicateTime, suggestRingCapacity, rgbaBytes } from './frame-source.js?v=48';
import { normalizeTrackReport } from './track-status.js?v=48';

const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d'), video = $('video');
// Fat enough that small mid-flight wobble reads as one continuous ribbon.
const TRACE_WIDTH = 14;
const BULK_LIMIT = 25;
const state = {
  demo: true, time: 0, playing: true, points: [], camera: [], color: '#f5fa9b', glow: true, hold: true,
  showTrace: true, editing: false, busy: false, url: null, file: null, controller: null, history: [], bulk: false,
  trackStatus: null, reasonCodes: [], confidence: null, engine: 'v2', exportable: false
};
const scene = new Image(); scene.src = 'scene.svg';
let lastTime = performance.now(), toastTimer, audioContext, audioSource, monitor, curveSource, curvePoints;
const demoPoints = Array.from({ length: 100 }, (_, i) => {
  const u = i / 99, v = 1 - u;
  return { t: 1 + u * 4.4, x: v ** 3 * .55 + 3 * v * v * u * .64 + 3 * v * u * u * .88 + u ** 3 * .693, y: v ** 3 * .88 + 3 * v * v * u * -.28 + 3 * v * u * u * .03 + u ** 3 * .513 };
});
const format = seconds => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function setBusy(busy, title = '', detail = '') {
  state.busy = busy; $('busyOverlay').hidden = !busy;
  $('busyTitle').textContent = title; $('busyText').textContent = detail; $('progress').value = 0;
  // Keep dropzone / newVideo enabled so a stuck analyze cannot trap the file picker.
  for (const id of ['play', 'timeline', 'editTrace', 'styleControls', 'toggleTrace', 'backFrame', 'forwardFrame', 'undo', 'clearTrace', 'doneEditing']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  const dropzone = $('dropzone'), newVideo = $('newVideo');
  if (dropzone) dropzone.disabled = false;
  if (newVideo) newVideo.disabled = false;
  syncExportEnabled();
}
function syncExportEnabled() {
  $('export').disabled = !(!state.busy && !state.demo && state.exportable && state.points.length >= 2);
}
function applyTrackReport(report) {
  state.points = report.points;
  state.camera = report.camera;
  state.trackStatus = report.status;
  state.reasonCodes = report.reasonCodes;
  state.confidence = report.confidence;
  state.exportable = report.exportable;
  state.engine = report.engine || state.engine;
  curveSource = null;
  const statusEl = $('resultStatus');
  statusEl.textContent = report.headline;
  statusEl.dataset.status = report.status || '';
  statusEl.classList.toggle('warn', report.status !== 'tracked');
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
    $('confidenceNote').textContent = report.confidence.calibrated ? '' : '(relative evidence)';
  } else if (confRow) {
    confRow.hidden = true;
  }
  syncExportEnabled();
}
function setEditing(editing) {
  state.editing = editing; $('manualTools').hidden = !editing; $('stage').classList.toggle('editing', editing);
  $('editTrace').hidden = editing;
  if (editing) {
    video.pause(); state.playing = false;
    $('resultStatus').textContent = 'Manual override · click the ball to place points.';
    $('resultStatus').dataset.status = 'partial';
  } else if (!state.demo) {
    applyTrackReport(normalizeTrackReport({
      points: state.points,
      camera: state.camera,
      status: state.trackStatus || (state.points.length >= 2 ? 'tracked' : 'no_reliable_track'),
      reasonCodes: state.reasonCodes,
      confidence: state.confidence?.marginOverNull,
      engine: state.engine
    }));
  }
}
function abortError() { return new DOMException('Operation cancelled', 'AbortError'); }
function seek(element, time, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const target = Math.max(0, Math.min(Math.max(0, element.duration - .001), time));
    if (Math.abs(element.currentTime - target) < .0001 && element.readyState >= 2) return resolve();
    const clean = () => { clearTimeout(timeout); element.removeEventListener('seeked', done); element.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted); };
    const done = () => { clean(); resolve(); }, failed = () => { clean(); reject(new Error('This video could not be decoded. Try an H.264 MP4.')); }, aborted = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(() => { clean(); reject(new Error('Video decoding timed out. Try a shorter H.264 MP4.')); }, 15000);
    element.addEventListener('seeked', done, { once: true }); element.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', aborted, { once: true }); element.currentTime = target;
  });
}
function loadVideo(url, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timeout); video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('Your browser cannot read this video codec. Try an H.264 MP4.')); };
    const abort = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(() => { clean(); reject(new Error('Video took too long to load. Try a smaller clip.')); }, 20000);
    video.addEventListener('loadeddata', done, { once: true }); video.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', abort, { once: true });
    video.src = url; video.load();
  });
}
function workerCall(worker, message, signal, transfer = []) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const clean = () => { clearTimeout(timeout); worker.removeEventListener('message', done); worker.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = event => { clean(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    const failed = () => { clean(); reject(new Error('Automatic detection could not start.')); };
    const aborted = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(() => { clean(); reject(new Error('Detection timed out.')); }, 20000);
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
  Object.assign(state, {
    demo: true, time: 0, playing: true, url: null, file: null, points: [], camera: [], history: [], bulk: false,
    trackStatus: null, reasonCodes: [], confidence: null, exportable: false
  });
  canvas.width = 1280; canvas.height = 720;
  $('uploadPanel').hidden = false; $('editPanel').hidden = true;
  $('timeline').max = 8; $('duration').textContent = '0:08';
  $('resultReasons').hidden = true;
  $('confidenceRow').hidden = true;
  $('resultStatus').dataset.status = '';
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
function collectVideoFiles(list) {
  return [...list].filter(isVideoFile);
}
function enterEditorChrome(file) {
  $('uploadPanel').hidden = true; $('editPanel').hidden = false;
  $('timeline').max = video.duration; $('duration').textContent = format(video.duration);
  if (!$('exportNote').querySelector('a')) $('exportNote').textContent = 'Original audio · Up to 1080p · No watermark';
  state.demo = false; state.file = file; state.playing = false;
}
async function openSwing(file, signal, { title = 'Opening your swing…', detail = 'Your video stays on this device.' } = {}) {
  const invalid = validateVideoFile(file);
  if (invalid) throw new Error(invalid);
  video.pause(); setEditing(false);
  setBusy(true, title, detail);
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file); state.points = []; state.camera = []; state.history = [];
  curveSource = null;
  await loadVideo(state.url, signal);
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration. Try an H.264 MP4.');
  if (video.duration > 30.05) throw new Error('Please trim your video to one swing, 30 seconds or less.');
  const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight), 1080 / Math.min(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
  canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
  enterEditorChrome(file);
}
async function upload(file) {
  if (!file || state.busy) return;
  state.bulk = false;
  state.controller = new AbortController(); const signal = state.controller.signal;
  let loaded = false;
  try {
    await openSwing(file, signal);
    loaded = true;
    updateStatus('Looking for a continuous ball flight…');
    await analyze(signal);
    const reviewAt = state.points.length ? Math.max(0, video.duration - .001) : 0;
    await seek(video, reviewAt, signal);
  } catch (error) {
    if (!loaded) resetDemo();
    if (error.name !== 'AbortError') toast(error.message);
    if (loaded && !state.exportable) {
      applyTrackReport(normalizeTrackReport({
        points: [],
        camera: state.camera,
        status: 'no_reliable_track',
        reasonCodes: error.name === 'AbortError' ? ['decoder_limited'] : ['no_ball_evidence'],
        engine: state.engine
      }));
      if (error.name === 'AbortError') $('resultStatus').textContent = 'Detection cancelled.';
    } else if (loaded && error.name === 'AbortError') {
      updateStatus('Cancelled.', true, state.trackStatus || '');
    }
  } finally { setBusy(false); state.controller = null; }
}
function downloadBlob(blob, baseName) {
  const extension = blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName.replace(/\.[^.]+$/, '')}-flightline.${extension}`;
  link.textContent = `Download ${extension.toUpperCase()} again ↓`;
  $('exportNote').replaceChildren(link);
  link.click();
  if (state.downloadURL) URL.revokeObjectURL(state.downloadURL);
  state.downloadURL = url;
  return extension;
}
async function processBulk(files) {
  if (state.busy) return;
  const queue = files.slice(0, BULK_LIMIT);
  if (!queue.length) return toast('Choose video files: MP4, MOV, or WebM.');
  if (files.length > BULK_LIMIT) toast(`Bulk mode handles up to ${BULK_LIMIT} clips at a time. Processing the first ${BULK_LIMIT}.`);
  state.bulk = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const summary = { ok: 0, skipped: 0, failed: 0, names: [] };
  let lastLoaded = false;
  try {
    for (let i = 0; i < queue.length; i++) {
      if (signal.aborted) throw abortError();
      const file = queue[i];
      const label = `${i + 1} of ${queue.length}`;
      try {
        await openSwing(file, signal, {
          title: `Bulk ${label} · Opening…`,
          detail: `${file.name} · Keep this tab visible.`
        });
        lastLoaded = true;
        await analyze(signal, {
          title: `Bulk ${label} · Finding flight…`,
          detail: `${file.name} · Keep this tab visible.`
        });
        if (!state.exportable || state.points.length < 2) {
          summary.skipped++;
          summary.names.push(`${file.name} (no reliable flight)`);
          continue;
        }
        setBusy(true, `Bulk ${label} · Exporting…`, `${file.name} · Keep this tab visible. Export runs at playback speed.`);
        const blob = await recordExport(signal);
        downloadBlob(blob, file.name);
        summary.ok++;
        // Give the browser a beat between successive downloads.
        await new Promise(resolve => setTimeout(resolve, 450));
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        summary.failed++;
        summary.names.push(`${file.name} (${error.message || 'failed'})`);
      }
    }
    if (lastLoaded && state.points.length) {
      const reviewAt = Math.max(0, video.duration - .001);
      await seek(video, reviewAt, signal).catch(() => {});
      updateStatus(`Bulk finished · ${summary.ok} exported` + (summary.skipped || summary.failed ? ` · ${summary.skipped + summary.failed} need attention` : '') + '.', summary.ok === 0);
    } else if (!lastLoaded) resetDemo();
    const bits = [`${summary.ok} traced`];
    if (summary.skipped) bits.push(`${summary.skipped} skipped`);
    if (summary.failed) bits.push(`${summary.failed} failed`);
    toast(`Bulk done: ${bits.join(', ')}.${summary.names.length ? ' Check the status note for details.' : ''}`);
    if (summary.names.length) updateStatus(`Bulk notes: ${summary.names.slice(0, 4).join(' · ')}${summary.names.length > 4 ? '…' : ''}`, true);
  } catch (error) {
    if (error.name === 'AbortError') toast('Bulk cancelled. Keep this tab visible to finish a batch.');
    else toast(error.message || 'Bulk processing failed.');
    if (!lastLoaded) resetDemo();
  } finally {
    state.bulk = false;
    setBusy(false);
    state.controller = null;
  }
}
function handleIncomingFiles(fileList) {
  const videos = collectVideoFiles(fileList);
  if (!videos.length) return toast('Choose a video file: MP4, MOV, or WebM.');
  if (videos.length === 1) return upload(videos[0]);
  return processBulk(videos);
}
function frameSignature(pixels) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 97) sum = (sum + pixels[i]) | 0;
  return sum;
}
function analysisSeekable() {
  const seekable = video.seekable?.length ? video.seekable.end(video.seekable.length - 1) : 0;
  return seekable >= video.duration * .9;
}

/** Play-sample fallback when seeking is broken — bounded map, not a full-duration RGBA cache. */
async function captureByPlayback(scan, scanCtx, targets, fps, signal) {
  const frames = targets.length;
  const captured = Array.from({ length: frames }, () => null);
  const wasMuted = video.muted;
  video.pause();
  video.muted = true;
  try {
    await seek(video, 0, signal);
  } catch { /* continue anyway */ }
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      video.pause();
      video.muted = wasMuted;
      resolve();
    };
    const watchdog = setTimeout(finish, Math.max(10000, video.duration * 2000 + 5000));
    const pump = () => {
      if (settled || signal.aborted) return finish();
      const mediaTime = video.currentTime;
      const i = Math.max(0, Math.min(frames - 1, Math.round(mediaTime * fps)));
      if (!captured[i]) {
        scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
        captured[i] = {
          pixels: new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data),
          t: mediaTime,
          targetT: targets[i],
          duplicate: false
        };
        const filled = captured.reduce((n, frame) => n + (frame ? 1 : 0), 0);
        $('progress').value = filled / frames * 40;
        if (filled % 10 === 0) $('busyText').textContent = `Reading video frames… ${filled} / ${frames}`;
      }
      if (mediaTime >= video.duration - .04 || video.ended) return finish();
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(pump);
      else requestAnimationFrame(pump);
    };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(pump);
    else requestAnimationFrame(pump);
    const playAttempt = video.play();
    if (playAttempt?.catch) playAttempt.catch(() => finish());
  });
  if (signal.aborted) throw abortError();
  for (let i = 0; i < frames; i++) {
    if (captured[i]) continue;
    if (signal.aborted) throw abortError();
    await seek(video, targets[i], signal);
    scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
    captured[i] = {
      pixels: new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data),
      t: video.currentTime,
      targetT: targets[i],
      duplicate: false
    };
  }
  for (let i = 1; i < frames; i++) {
    if (!captured[i] || !captured[i - 1]) continue;
    if (frameSignature(captured[i].pixels) !== frameSignature(captured[i - 1].pixels)) continue;
    try {
      await seek(video, targets[i], signal);
      scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
      const next = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
      if (frameSignature(next) !== frameSignature(captured[i - 1].pixels)) {
        captured[i] = { pixels: next, t: video.currentTime, targetT: targets[i], duplicate: false };
      } else {
        captured[i].duplicate = true;
      }
    } catch { /* keep the duplicate rather than abort analysis */ }
  }
  return captured;
}

async function readAnalysisSample(scan, scanCtx, targetT, prevT, signal) {
  await seek(video, targetT, signal);
  const t = video.currentTime;
  scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
  return {
    pixels: new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data),
    t,
    targetT,
    duplicate: isNearDuplicateTime(prevT, t)
  };
}

async function analyze(signal, labels = {}) {
  setBusy(true, labels.title || 'Finding your flight…', labels.detail || 'Scanning for the ball’s motion. This may take a minute.');
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const scan = document.createElement('canvas'); scan.width = Math.round(video.videoWidth * scale); scan.height = Math.round(video.videoHeight * scale);
  const scanCtx = scan.getContext('2d', { willReadFrequently: true });
  const worker = new Worker(new URL('./worker.js?v=48', import.meta.url), { type: 'module' });
  try {
    const params = new URLSearchParams(location.search), from = Math.max(0, Number(params.get('diagnosticFrom')) || 0);
    const diagnostics = params.has('diagnostics') ? { from, to: from + 1 } : null;
    // Phase 5 default: v2 global association. Escape hatch: ?engine=legacy
    const engine = params.get('engine') === 'legacy' ? 'legacy' : 'v2';
    state.engine = engine;
    await workerCall(worker, { type: 'init', width: scan.width, height: scan.height, diagnostics, engine }, signal);
    const targets = plannedSampleTimes(video.duration, 30);
    const frames = targets.length;
    const canSeek = analysisSeekable();
    // Phase 1: stream frames (seek → analyze → release). Do NOT prefetch full-duration RGBA.
    // Play-sampling only when seeking is broken; still release after each worker transfer.
    const playbackCache = canSeek ? null : await captureByPlayback(scan, scanCtx, targets, 30, signal);
    const budgetBytes = 96 * 1024 * 1024;
    const ringCap = suggestRingCapacity(scan.width, scan.height, budgetBytes);
    let prevT = -Infinity;
    let duplicateStamps = 0;
    let peakResidentFrames = 0;
    $('busyText').textContent = canSeek
      ? 'Analyzing frames…'
      : 'Reading video frames… Keep this tab visible.';
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw abortError();
      let sample = playbackCache?.[i];
      if (!sample) sample = await readAnalysisSample(scan, scanCtx, targets[i], prevT, signal);
      const t = Number.isFinite(sample.t) ? sample.t : targets[i];
      if (sample.duplicate || isNearDuplicateTime(prevT, t)) duplicateStamps++;
      prevT = t;
      // Transfer ownership of the buffer to the worker — no long-lived RGBA cache.
      const pixels = sample.pixels;
      sample.pixels = null;
      if (playbackCache) playbackCache[i] = null;
      peakResidentFrames = Math.max(peakResidentFrames, 1);
      await workerCall(worker, { type: 'frame', buffer: pixels.buffer, time: t }, signal, [pixels.buffer]);
      $('progress').value = (i + 1) / frames * 100;
      if (i % 15 === 0) {
        const prefix = state.bulk ? `${labels.detail?.split(' · ')[0] || 'Bulk'} · ` : '';
        $('busyText').textContent = `${prefix}Analyzing frame ${i + 1} of ${frames} · ${Math.round((i + 1) / frames * 100)}%`;
      }
    }
    canvas.dataset.frameTimingDiagnostic = JSON.stringify({
      sampleFps: 30,
      planned: frames,
      duplicateStamps,
      seekable: canSeek,
      streaming: true,
      rgbaBytesPerFrame: rgbaBytes(scan.width, scan.height),
      suggestedRingCapacity: ringCap,
      peakResidentFrames,
      note: 'Frames are streamed; association uses measured video.currentTime after seek.'
    });
    const result = await workerCall(worker, { type: 'finish' }, signal);
    const { frames: diagnosticFrames, ...diagnosticSummary } = result;
    canvas.dataset.trackingDiagnostic = JSON.stringify(diagnosticSummary);
    if (diagnostics) canvas.dataset.candidateDiagnostic = JSON.stringify(diagnosticFrames);
    const report = normalizeTrackReport(result);
    applyTrackReport(report);
  } finally { worker.terminate(); }
}
function drawTrace(time) {
  if (!state.showTrace) return;
  // Abstention: never invent a tracer when automatic tracking failed.
  if (!state.demo && (state.trackStatus === 'no_reliable_track' || state.points.length < 2)) return;
  const source = state.demo ? demoPoints : state.points;
  if (curveSource !== source) {
    curveSource = source;
    // Interpolate only between observed points — smoothFlight does not invent past the last observation.
    curvePoints = smoothFlight(source);
  }
  const path = visiblePath(curvePoints, time, state.hold);
  if (path.length < 2) return;
  const offset = state.demo ? { x: 0, y: 0 } : cameraAt(state.camera, time);
  const xy = p => [(p.x + offset.x) * canvas.width, (p.y + offset.y) * canvas.height];
  const scale = Math.max(canvas.width, canvas.height) / 1280;
  const width = TRACE_WIDTH * scale;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(...xy(path[0]));
  for (let i = 1; i < path.length; i++) ctx.lineTo(...xy(path[i]));
  // Soft under-stroke + fat core so tiny lateral jitter disappears into the ribbon.
  if (state.glow) {
    ctx.strokeStyle = state.color;
    ctx.shadowColor = state.color;
    ctx.shadowBlur = width * 1.8;
    ctx.globalAlpha = .45;
    ctx.lineWidth = width * 1.55;
    ctx.stroke();
  }
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  ctx.strokeStyle = state.color;
  ctx.lineWidth = width;
  ctx.stroke();
  const [x, y] = xy(path.at(-1));
  ctx.fillStyle = '#ffffec';
  ctx.beginPath(); ctx.arc(x, y, width * .55, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function draw() {
  ctx.fillStyle = '#152b21'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.demo) { if (scene.complete && scene.naturalWidth) ctx.drawImage(scene, 0, 0, canvas.width, canvas.height); }
  else if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  drawTrace(state.demo ? state.time : video.currentTime);
  if (state.editing) {
    const offset = cameraAt(state.camera, video.currentTime);
    for (const p of state.points) {
      const x = (p.x + offset.x) * canvas.width, y = (p.y + offset.y) * canvas.height;
      const near = Math.abs(p.t - video.currentTime) < .055;
      ctx.strokeStyle = near ? '#fff' : '#e4f799'; ctx.lineWidth = 2; ctx.fillStyle = '#173d2b99';
      ctx.beginPath(); ctx.arc(x, y, near ? 9 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
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
async function recordExport(signal) {
  if (!canvas.captureStream || !window.MediaRecorder) throw new Error('Video export is unavailable in this browser. Try a current desktop Chrome, Edge, or Safari.');
  const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('No compatible video encoder is available in this browser.');
  video.pause();
  const oldTrace = state.showTrace;
  setEditing(false); state.showTrace = true;
  let stream, recorder, destination, wakeLock;
  const visibility = () => { if (document.hidden) state.controller?.abort(); };
  document.addEventListener('visibilitychange', visibility);
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioSource = audioContext.createMediaElementSource(video);
      monitor = audioContext.createGain(); audioSource.connect(monitor); monitor.connect(audioContext.destination);
    }
    await audioContext.resume();
    monitor.gain.value = 0;
    destination = audioContext.createMediaStreamDestination(); audioSource.connect(destination);
    await seek(video, 0, signal); draw();
    stream = canvas.captureStream(30);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 9_000_000, audioBitsPerSecond: 128_000 });
    const recorded = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', cancelled); video.removeEventListener('ended', ended); video.removeEventListener('error', videoError); };
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      const cancelled = () => { cleanup(); stop(); reject(abortError()); };
      const ended = () => { draw(); stop(); };
      const videoError = () => { cleanup(); stop(); reject(new Error('Video decoding failed during export.')); };
      const timeout = setTimeout(() => { cleanup(); stop(); reject(new Error('Export stalled. Keep this tab visible and try again.')); }, (video.duration + 20) * 1000);
      signal.addEventListener('abort', cancelled, { once: true }); video.addEventListener('ended', ended, { once: true }); video.addEventListener('error', videoError, { once: true });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cleanup(); reject(new Error('The browser’s video encoder failed. Try another browser.')); };
      recorder.onstop = () => { cleanup(); if (!signal.aborted) resolve(new Blob(chunks, { type: recorder.mimeType || mimeType })); };
      recorder.start(250);
      video.play().catch(error => { cleanup(); stop(); reject(error); });
    });
    recorded.catch(() => {});
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    const blob = await recorded;
    if (!blob.size) throw new Error('The export was empty. Please try again.');
    return blob;
  } finally {
    video.pause(); if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); if (destination) audioSource.disconnect(destination);
    if (monitor) monitor.gain.value = 1; await wakeLock?.release();
    document.removeEventListener('visibilitychange', visibility);
    state.showTrace = oldTrace;
  }
}
async function exportVideo() {
  if (!state.exportable || state.points.length < 2) {
    toast('No reliable ball flight to export.');
    return;
  }
  if (state.busy || state.demo || state.points.length < 2) return;
  video.pause();
  const oldTime = video.currentTime;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  setBusy(true, 'Finishing your replay…', 'Keep this tab visible. Export runs at the video’s playback speed.');
  try {
    const blob = await recordExport(signal);
    downloadBlob(blob, state.file.name);
    toast('Your traced video is ready. No watermark, all yours.');
  } catch (error) {
    if (error.name === 'AbortError') toast('Export cancelled. Keep this tab visible to finish your video.');
    else toast(error.message || 'Export failed. Try a shorter clip.');
  } finally {
    state.controller = null; setBusy(false);
    await seek(video, oldTime).catch(() => {});
  }
}

$('fileInput').addEventListener('change', event => { handleIncomingFiles(event.target.files); event.target.value = ''; });
function pickNewVideo() {
  // File pickers must open in the same synchronous user-gesture turn (Safari/Chrome).
  // Never await before input.click() or the dialog is silently blocked.
  if (state.busy) {
    state.controller?.abort();
    setBusy(false);
  }
  if (isPreviewFullscreen()) {
    try {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch { /* continue to file picker */ }
  }
  $('fileInput').click();
}
$('dropzone').onclick = $('newVideo').onclick = pickNewVideo;
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); });
$('dropzone').addEventListener('drop', event => handleIncomingFiles(event.dataTransfer.files));
$('play').onclick = togglePlay;
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
function manualStatus() {
  state.exportable = state.points.length >= 2;
  state.trackStatus = state.exportable ? 'tracked' : 'no_reliable_track';
  updateStatus(
    state.points.length < 2 ? 'Place at least two points at different times.' : `${state.points.length} manual points · Ready to export.`,
    state.points.length < 2,
    state.trackStatus
  );
  syncExportEnabled();
}
$('undo').onclick = () => { if (state.history.length) { state.points = state.history.pop(); manualStatus(); } };
$('clearTrace').onclick = () => { state.history.push([...state.points]); state.points = []; manualStatus(); };
canvas.addEventListener('click', async event => {
  if (!state.editing || state.busy || video.seeking) return;
  video.pause(); const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const left = rect.left + (rect.width - canvas.width * scale) / 2, top = rect.top + (rect.height - canvas.height * scale) / 2;
  const x = (event.clientX - left) / (canvas.width * scale), y = (event.clientY - top) / (canvas.height * scale);
  if (x < 0 || y < 0 || x > 1 || y > 1) return;
  const offset = cameraAt(state.camera, video.currentTime);
  state.history.push([...state.points]);
  state.points = state.points.filter(p => Math.abs(p.t - video.currentTime) > 1 / 60);
  state.points.push({ t: video.currentTime, x: x - offset.x, y: y - offset.y }); state.points.sort((a, b) => a.t - b.t);
  manualStatus(); await seek(video, video.currentTime + .1).catch(error => toast(error.message));
});
$('export').onclick = exportVideo; $('cancel').onclick = () => state.controller?.abort();
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
  if (event.code === 'Space' && !['INPUT','BUTTON','A','TEXTAREA'].includes(event.target.tagName) && !$('helpDialog').open) {
    event.preventDefault(); togglePlay();
  }
  if ((event.key === 'f' || event.key === 'F') && !['INPUT','TEXTAREA'].includes(event.target.tagName) && !$('helpDialog').open) {
    event.preventDefault(); toggleFullscreen();
  }
});
if (matchMedia('(prefers-reduced-motion: reduce)').matches) { state.playing = false; state.time = 5.5; }
requestAnimationFrame(loop);
