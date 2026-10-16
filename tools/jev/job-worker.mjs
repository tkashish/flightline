// One tracing job in a worker thread, so the server stays responsive while ffmpeg and Jev run.
import { parentPort, workerData } from 'node:worker_threads';
import { trackWithJev } from './track.mjs';

const ac = new AbortController();
parentPort.on('message', m => { if (m === 'abort') ac.abort(new Error('cancelled')); });
try {
  const result = await trackWithJev(workerData.video, { workDir: workerData.workDir, signal: ac.signal, onProgress: p => parentPort.postMessage({ type: 'progress', ...p }) });
  parentPort.postMessage({ type: 'done', result });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e?.message ?? String(e) });
} finally {
  parentPort.close();   // let the thread end, so the server frees it and deletes the job folder
}
