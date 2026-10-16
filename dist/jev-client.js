/**
 * Browser side of the Jev tracer (?engine=jev): uploads the clip to the local server (tools/jev/server.mjs), which keeps
 * the Jev key, and polls until it returns an HFResult. Crops of the video are sent to TypeSafe's Jev by that server.
 */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** @returns {Promise<object>} the HFResult; rejects with an AbortError when `signal` aborts. */
export async function analyzeWithJev(file, { signal, onProgress = () => {} } = {}) {
  onProgress({ phase: 'probe', message: 'Uploading the video to the local tracer…', done: 0, total: 1 });
  const start = await fetch('/api/jev/track', { method: 'POST', body: file, headers: { 'X-Filename': file.name || 'clip.mp4' }, signal });
  if (!start.ok) throw new Error((await start.json().catch(() => ({}))).error || `The Jev tracer is not running (HTTP ${start.status}). Start it with npm run dev:jev.`);
  const { id } = await start.json();
  try {
    for (;;) {
      await sleep(500, signal);
      const job = await (await fetch(`/api/jev/job/${id}`, { signal })).json();
      if (job.error) throw new Error(`Jev tracer: ${job.error}`);
      onProgress(job);
      if (job.result) return job.result;
    }
  } catch (e) {
    if (signal?.aborted) fetch(`/api/jev/job/${id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}
