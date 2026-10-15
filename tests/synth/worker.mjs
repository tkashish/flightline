// worker_threads entry: generates the clips it is sent, one at a time.
import { parentPort, workerData } from 'node:worker_threads';
import { generateClip } from './clip.mjs';

parentPort.on('message', async ({ spec }) => {
  try { parentPort.postMessage({ ok: true, res: await generateClip(spec, workerData) }); }
  catch (error) { parentPort.postMessage({ ok: false, id: spec.id, error: String(error?.stack || error) }); }
});
