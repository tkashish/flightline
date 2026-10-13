import { cameraAt, visiblePath } from './tracker.js?v=37';
import { smoothFlight } from './curve.js?v=37';

const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d'), video = $('video');
const TRACE_WIDTH = 7;
const state = { demo: true, time: 0, playing: true, points: [], camera: [], color: '#f5fa9b', glow: true, hold: true, showTrace: true, editing: false, busy: false, url: null, file: null, controller: null, history: [] };
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
  for (const id of ['play', 'timeline', 'editTrace', 'newVideo', 'dropzone', 'styleControls', 'replay', 'toggleTrace', 'backFrame', 'forwardFrame', 'undo', 'clearTrace', 'doneEditing']) $(id).disabled = busy;
  const canExport = !busy && !state.demo && state.points.length >= 2;
  $('export').disabled = !canExport;
  $('focusExport').disabled = !canExport;
}
function setEditing(editing) {
  state.editing = editing; $('manualTools').hidden = !editing; $('stage').classList.toggle('editing', editing);
  $('editTrace').hidden = editing;
  if (editing) { video.pause(); state.playing = false; $('previewHint').textContent = 'Find the ball, then click to place a point. Scrub to continue.'; }
  else $('previewHint').textContent = 'Review the flight before exporting.';
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
    const failed = () => { clean(); reject(new Error('Automatic detection could not start. You can still place the trace manually.')); };
    const aborted = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(() => { clean(); reject(new Error('Detection timed out. You can still place the trace manually.')); }, 20000);
    worker.addEventListener('message', done, { once: true }); worker.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
    worker.postMessage(message, transfer);
  });
}
function updateStatus(message, warning = false) {
  $('resultStatus').textContent = message; $('resultStatus').classList.toggle('warn', warning);
  const canExport = !state.busy && !state.demo && state.points.length >= 2;
  $('export').disabled = !canExport;
  $('focusExport').disabled = !canExport;
}
function resetDemo() {
  video.pause(); video.removeAttribute('src'); video.load();
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { demo: true, time: 0, playing: true, url: null, file: null, points: [], camera: [], history: [] });
  canvas.width = 1280; canvas.height = 720;
  $('uploadPanel').hidden = false; $('editPanel').hidden = true;
  $('demoCaption').hidden = false; $('stageTag').hidden = false; $('stageNote').hidden = false;
  $('previewTitle').textContent = 'A LITTLE FLIGHTLINE MAGIC'; $('clipMeta').textContent = 'INTERACTIVE DEMO';
  $('timeline').max = 8; $('duration').textContent = '0:08'; $('replay').textContent = 'Replay demo ↻';
  setEditing(false); $('previewHint').textContent = 'A great shot. An even better replay.';
}
async function upload(file) {
  if (!file || state.busy) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) return toast('Choose a video file: MP4, MOV, or WebM.');
  if (file.size > 250 * 1024 * 1024) return toast('This clip is over 250 MB. Trim or compress it, then try again.');
  state.controller = new AbortController(); const signal = state.controller.signal;
  video.pause(); setEditing(false); setBusy(true, 'Opening your swing…', 'Your video stays on this device.');
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file); state.points = []; state.camera = []; state.history = [];
  let loaded = false;
  try {
    await loadVideo(state.url, signal);
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration. Try an H.264 MP4.');
    if (video.duration > 30.05) throw new Error('Please trim your video to one swing, 30 seconds or less.');
    loaded = true; state.demo = false; state.file = file; state.playing = false;
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight), 1080 / Math.min(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2); canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
    $('uploadPanel').hidden = true; $('editPanel').hidden = false; $('demoCaption').hidden = true; $('stageTag').hidden = true; $('stageNote').hidden = true;
    $('previewTitle').textContent = 'YOUR SWING'; $('clipMeta').textContent = `${video.videoWidth} × ${video.videoHeight} · ${format(video.duration)}`;
    $('timeline').max = video.duration; $('duration').textContent = format(video.duration); $('replay').textContent = 'Replay swing ↻'; $('exportNote').textContent = 'Original audio · Up to 1080p · No watermark';
    updateStatus('Looking for a continuous ball flight…');
    await analyze(signal);
    // Land near the end so the held trace includes the extrapolated finish.
    const reviewAt = state.points.length ? Math.max(0, video.duration - .001) : 0;
    await seek(video, reviewAt, signal);
  } catch (error) {
    if (!loaded) resetDemo();
    if (error.name !== 'AbortError') toast(error.message);
    if (loaded) updateStatus(error.name === 'AbortError' ? 'Detection cancelled. You can place the trace manually.' : 'Detection unavailable. Add points with “Adjust the flight”.', true);
  } finally { setBusy(false); state.controller = null; }
}
function frameSignature(pixels) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 97) sum = (sum + pixels[i]) | 0;
  return sum;
}
async function captureAnalysisFrames(scan, scanCtx, fps, signal) {
  const frames = Math.ceil(video.duration * fps);
  const captured = Array.from({ length: frames }, () => null);
  const seekable = video.seekable?.length ? video.seekable.end(video.seekable.length - 1) : 0;
  // Uploaded blobs are seekable. Precise seeks give the tracker real launch
  // frames; play-sampling can duplicate a pre-impact frame over the launch.
  const canSeek = seekable >= video.duration * .9;
  $('busyText').textContent = canSeek
    ? 'Reading video frames…'
    : 'Reading video frames… Keep this tab visible.';
  if (canSeek) {
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw abortError();
      await seek(video, Math.min(i / fps, video.duration - .002), signal);
      scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
      captured[i] = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
      $('progress').value = (i + 1) / frames * 55;
      if (i % 10 === 0) $('busyText').textContent = `Reading video frames… ${i + 1} / ${frames}`;
    }
    return captured;
  }
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
        captured[i] = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
        const filled = captured.reduce((n, frame) => n + (frame ? 1 : 0), 0);
        $('progress').value = filled / frames * 45;
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
    await seek(video, Math.min(i / fps, video.duration - .002), signal);
    scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
    captured[i] = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
    $('progress').value = 45 + (i + 1) / frames * 10;
  }
  // Replace accidental duplicate samples when a later seek is possible.
  for (let i = 1; i < frames; i++) {
    if (!captured[i] || !captured[i - 1]) continue;
    if (frameSignature(captured[i]) !== frameSignature(captured[i - 1])) continue;
    try {
      await seek(video, Math.min(i / fps, video.duration - .002), signal);
      scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
      const next = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
      if (frameSignature(next) !== frameSignature(captured[i - 1])) captured[i] = next;
    } catch { /* keep the duplicate rather than abort analysis */ }
  }
  return captured;
}
async function analyze(signal) {
  setBusy(true, 'Finding your flight…', 'Scanning for the ball’s motion. This may take a minute.');
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const scan = document.createElement('canvas'); scan.width = Math.round(video.videoWidth * scale); scan.height = Math.round(video.videoHeight * scale);
  const scanCtx = scan.getContext('2d', { willReadFrequently: true });
  const worker = new Worker(new URL('./worker.js?v=37', import.meta.url), { type: 'module' });
  try {
    const params = new URLSearchParams(location.search), from = Math.max(0, Number(params.get('diagnosticFrom')) || 0);
    const diagnostics = params.has('diagnostics') ? { from, to: from + 1 } : null;
    await workerCall(worker, { type: 'init', width: scan.width, height: scan.height, diagnostics }, signal);
    const frames = Math.ceil(video.duration * 30);
    // Prefetch frames before the worker loop. Seek when the media is seekable
    // (normal uploads); fall back to play-sampling only when seeking is broken.
    const captured = video.duration <= 16
      ? await captureAnalysisFrames(scan, scanCtx, 30, signal)
      : null;
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw abortError();
      const t = Math.min(i / 30, video.duration - .002);
      let pixels = captured?.[i];
      if (!pixels) {
        await seek(video, t, signal);
        scanCtx.drawImage(video, 0, 0, scan.width, scan.height);
        pixels = new Uint8ClampedArray(scanCtx.getImageData(0, 0, scan.width, scan.height).data);
      }
      const copy = new Uint8ClampedArray(pixels);
      await workerCall(worker, { type: 'frame', buffer: copy.buffer, time: t }, signal, [copy.buffer]);
      $('progress').value = 55 + (i + 1) / frames * 45;
      if (i % 15 === 0) $('busyText').textContent = `Analyzing frame ${i + 1} of ${frames} · ${Math.round((i + 1) / frames * 100)}%`;
    }
    const result = await workerCall(worker, { type: 'finish' }, signal);
    const { frames: diagnosticFrames, ...diagnosticSummary } = result;
    canvas.dataset.trackingDiagnostic = JSON.stringify(diagnosticSummary);
    if (diagnostics) canvas.dataset.candidateDiagnostic = JSON.stringify(diagnosticFrames);
    state.points = result.points; state.camera = result.camera;
    curveSource = null;
    // Native-resolution refinement was locking onto clothing after the ball
    // faded. Keep the observed motion track only until that path is reliable.
    if (state.points.length) {
      updateStatus(`Possible flight found in ${state.points.length} frames.`, true);
      $('previewHint').textContent = `Motion tracking beta · ${state.points.length} observed points · build 37`;
    } else {
      updateStatus('No reliable flight found. Use “Adjust the flight” to place the ball at a few moments.', true);
      $('previewHint').textContent = 'The ball may be too small or blend into the background.';
    }
  } finally { worker.terminate(); }
}
function drawTrace(time) {
  if (!state.showTrace) return;
  const source = state.demo ? demoPoints : state.points;
  if (curveSource !== source) {
    curveSource = source;
    // Extend the sparse observations first, then smooth so the join stays calm.
    curvePoints = smoothFlight(source);
  }
  const path = visiblePath(curvePoints, time, state.hold);
  if (path.length < 2) return;
  const offset = state.demo ? { x: 0, y: 0 } : cameraAt(state.camera, time);
  const xy = p => [(p.x + offset.x) * canvas.width, (p.y + offset.y) * canvas.height];
  ctx.save(); ctx.strokeStyle = state.color; ctx.lineWidth = TRACE_WIDTH * Math.max(canvas.width, canvas.height) / 1280; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = state.color; ctx.shadowBlur = state.glow ? ctx.lineWidth * 2.4 : 0;
  ctx.beginPath(); ctx.moveTo(...xy(path[0]));
  for (let i = 1; i < path.length; i++) ctx.lineTo(...xy(path[i]));
  ctx.stroke();
  const [x, y] = xy(path.at(-1));
  ctx.fillStyle = '#ffffec'; ctx.beginPath(); ctx.arc(x, y, ctx.lineWidth * .7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
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
async function exportVideo() {
  if (state.busy || state.demo || state.points.length < 2) return;
  if (!canvas.captureStream || !window.MediaRecorder) return toast('Video export is unavailable in this browser. Try a current desktop Chrome, Edge, or Safari.');
  const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return toast('No compatible video encoder is available in this browser.');
  video.pause(); const oldTime = video.currentTime, oldTrace = state.showTrace;
  setEditing(false); state.showTrace = true; state.controller = new AbortController(); const signal = state.controller.signal;
  let stream, recorder, destination, wakeLock;
  setBusy(true, 'Finishing your replay…', 'Keep this tab visible. Export runs at the video’s playback speed.');
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
    // Observe errors immediately while optional screen wake lock is acquired.
    recorded.catch(() => {});
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    const blob = await recorded;
    if (!blob.size) throw new Error('The export was empty. Please try again.');
    const url = URL.createObjectURL(blob), extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const link = document.createElement('a'); link.href = url; link.download = `${state.file.name.replace(/\.[^.]+$/, '')}-flightline.${extension}`; link.textContent = `Download ${extension.toUpperCase()} again ↓`;
    $('exportNote').replaceChildren(link); link.click();
    // Keep the latest download available while the page is open.
    if (state.downloadURL) URL.revokeObjectURL(state.downloadURL); state.downloadURL = url;
    toast('Your traced video is ready. No watermark, all yours.');
  } catch (error) {
    if (error.name === 'AbortError') toast('Export cancelled. Keep this tab visible to finish your video.');
    else toast(error.message || 'Export failed. Try a shorter clip.');
  } finally {
    video.pause(); if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); if (destination) audioSource.disconnect(destination);
    if (monitor) monitor.gain.value = 1; await wakeLock?.release();
    document.removeEventListener('visibilitychange', visibility);
    state.showTrace = oldTrace; state.controller = null; setBusy(false);
    await seek(video, oldTime).catch(() => {});
  }
}

$('fileInput').addEventListener('change', event => { upload(event.target.files[0]); event.target.value = ''; });
async function pickNewVideo() {
  if (isPreviewFullscreen()) {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch { /* continue to file picker */ }
  }
  $('fileInput').click();
}
$('dropzone').onclick = $('newVideo').onclick = $('focusNewVideo').onclick = () => pickNewVideo();
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); });
$('dropzone').addEventListener('drop', event => upload(event.dataTransfer.files[0]));
$('play').onclick = togglePlay;
$('timeline').addEventListener('input', event => { if (state.busy) return; if (state.demo) { state.time = +event.target.value; state.playing = false; } else { video.pause(); video.currentTime = +event.target.value; } });
$('replay').onclick = async () => { if (state.demo) { state.time = 0; state.playing = true; } else { video.pause(); await seek(video, 0).catch(error => toast(error.message)); await togglePlay(); } };
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
  $('focusGlow').checked = on;
}
function setTracerHold(on) {
  state.hold = on;
  $('hold').checked = on;
  $('focusHold').checked = on;
}
document.querySelectorAll('.swatch').forEach(button => button.onclick = () => setTracerColor(button.dataset.color));
$('glow').onchange = event => setTracerGlow(event.target.checked);
$('focusGlow').onchange = event => setTracerGlow(event.target.checked);
$('hold').onchange = event => setTracerHold(event.target.checked);
$('focusHold').onchange = event => setTracerHold(event.target.checked);
$('editTrace').onclick = () => setEditing(true); $('doneEditing').onclick = () => setEditing(false);
for (const [id, delta] of [['backFrame', -1 / 30], ['forwardFrame', 1 / 30]]) $(id).onclick = () => { video.pause(); seek(video, video.currentTime + delta).catch(error => toast(error.message)); };
function manualStatus() { updateStatus(state.points.length < 2 ? 'Place at least two points at different times to make a trace.' : `${state.points.length} trace points · Preview your edits, then export.`, state.points.length < 2); }
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
$('export').onclick = $('focusExport').onclick = exportVideo; $('cancel').onclick = () => state.controller?.abort();
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = $('gotIt').onclick = () => $('helpDialog').close();
$('helpDialog').addEventListener('click', event => { if (event.target === $('helpDialog')) { const r = $('helpDialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('helpDialog').close(); } });

const studio = document.querySelector('.studio');
function setPanelCollapsed(collapsed) {
  studio.classList.toggle('panel-collapsed', collapsed);
  $('togglePanel').setAttribute('aria-pressed', String(collapsed));
  $('togglePanel').setAttribute('aria-label', collapsed ? 'Show controls' : 'Hide controls');
  $('togglePanel').title = collapsed ? 'Show controls' : 'Hide controls';
  try { localStorage.setItem('flightline-panel-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
}
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
$('togglePanel').onclick = () => setPanelCollapsed(!studio.classList.contains('panel-collapsed'));
$('fullscreen').onclick = $('exitFullscreen').onclick = () => toggleFullscreen();
document.addEventListener('fullscreenchange', syncFullscreenUi);
document.addEventListener('webkitfullscreenchange', syncFullscreenUi);
try { if (localStorage.getItem('flightline-panel-collapsed') === '1') setPanelCollapsed(true); } catch { /* ignore */ }

document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !['INPUT','BUTTON','A','TEXTAREA'].includes(event.target.tagName) && !$('helpDialog').open) {
    event.preventDefault(); togglePlay();
  }
  if ((event.key === 'f' || event.key === 'F') && !['INPUT','TEXTAREA'].includes(event.target.tagName) && !$('helpDialog').open) {
    event.preventDefault(); toggleFullscreen();
  }
  if ((event.key === '\\' || event.key === ']') && !['INPUT','TEXTAREA'].includes(event.target.tagName) && !$('helpDialog').open && !isPreviewFullscreen()) {
    event.preventDefault(); setPanelCollapsed(!studio.classList.contains('panel-collapsed'));
  }
});
if (matchMedia('(prefers-reduced-motion: reduce)').matches) { state.playing = false; state.time = 5.5; }
requestAnimationFrame(loop);
