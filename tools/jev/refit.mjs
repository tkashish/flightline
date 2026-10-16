// Rebuild saved results with the current curve code, without asking Jev again:
//   node tools/jev/refit.mjs VIDEO SAVED_RESULT.json OUT.json
import { readFileSync, writeFileSync } from 'node:fs';
import { refit } from './track.mjs';
const [video, saved, out] = process.argv.slice(2);
const r = await refit(video, JSON.parse(readFileSync(saved, 'utf8')));
writeFileSync(out, JSON.stringify(r));
console.log(JSON.stringify({ status: r.status, observed: r.observedFrames, tail: r.points.filter(p => p.status === 'predicted').length, fitResidualPx: r.diagnostics.fitResidualPx, end: r.completion?.end?.type, validation: r.diagnostics.validation ?? 'ok' }));
