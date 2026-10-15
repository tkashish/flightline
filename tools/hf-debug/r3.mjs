import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import * as pipe from '../../dist/hf/pipeline.js';
import * as dec from '../../dist/hf/decide.js';
import { confidenceFeatures, scoreConfidence, inlierObservations } from '../../dist/hf/confidence.js';
const src = await openNodeSource(process.argv[2]);
const r = await pipe.analyzeClip(src, { diagnostics: true, onProgress: () => {} }), d = r.diagnostics || {};
console.log('diag keys', Object.keys(d).join(','));
console.log("decision", JSON.stringify(d.decision)?.slice(0, 1500));
for (const c of d.candidates ?? []) {
  const inl = inlierObservations(c.track, c.fit);
  console.log('cand', c.launchId, 'inl', inl.length, 'span', inl[0]?.t?.toFixed(3), inl.at(-1)?.t?.toFixed(3), 'identityMargin', c.track?.features?.identityMargin, 'features', JSON.stringify(c.features)?.slice(0, 300));
}
const { PARAMS } = await import('../../dist/hf/params.js');
const { tauOf } = await import('../../dist/hf/confidence.js');
for (const c of d.candidates ?? []) {
  const inl = inlierObservations(c.track, c.fit), tau = tauOf(c.fit, c.completion);
  console.log('eval', c.launchId, 'gates', dec.fitGatesPass(c.fit, PARAMS), 'observed', dec.enoughObserved(inl, tau, PARAMS), 'exit', dec.exitConfirmed(c.track, c.completion, inl, src.meta, PARAMS), 'tau', tau, 'fit', JSON.stringify({ mode: c.fit?.mode, rmsNorm: c.fit?.rmsNorm, chi2Dof: c.fit?.chi2Dof, plausible: c.fit?.plausible, ok: c.fit?.ok, gates: c.fit?.gates }).slice(0, 400));
}
