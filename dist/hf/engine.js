/**
 * hf engine entry point (?engine=hf): the stable signature the worker and the bench call. It runs the U9
 * pipeline (dist/hf/pipeline.js analyzeClip), which loads the other units with dynamic import(), so a missing
 * unit file gives an engine_not_ready abstention instead of a load failure here.
 */
import { analyzeClip } from './pipeline.js';

export const ENGINE_ID = 'hf';

/**
 * Analyze one clip.
 * @param {import('./types.js').FrameSource} source  owned by the caller, who closes it
 * @param {{signal?:AbortSignal, diagnostics?:boolean, params?:object, modules?:object}} [opts]  passed to analyzeClip
 * @param {(p:import('./types.js').Progress) => void} [onProgress]
 * @returns {Promise<import('./types.js').HFResult>}  always a valid result; rejects with an AbortError when
 *   opts.signal aborts, and with an HFError ('decode' unless the source set a code) when the source fails
 */
export async function runHF(source, opts = {}, onProgress) {
  return analyzeClip(source, { ...opts, onProgress });
}
