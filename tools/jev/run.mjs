// Run the Jev tracer on one clip from the command line: node tools/jev/run.mjs CLIP.mp4 [out.json] [--keep-crops DIR]
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackWithJev } from './track.mjs';

const args = process.argv.slice(2), ki = args.indexOf('--keep-crops'), keepDir = ki >= 0 ? args.splice(ki, 2)[1] : null, [video, out] = args;
const r = await trackWithJev(video, { workDir: keepDir ?? join(tmpdir(), `jev-${process.pid}`), keepCrops: !!keepDir, onProgress: p => process.stderr.write(`\r${p.message ?? p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}     `) });
process.stderr.write('\n');
if (out) writeFileSync(out, JSON.stringify(r, null, 1));
const d = r.diagnostics, src = (d.track ?? []).reduce((m, p) => (m[p.src] = (m[p.src] ?? 0) + 1, m), {});
console.log(JSON.stringify({ status: r.status, reasons: r.reasonCodes, observed: r.observedFrames, points: r.points.length, predicted: r.points.filter(p => p.status === 'predicted').length,
  end: r.completion?.end?.type, addressFrame: d.addressFrame, impactFrame: d.impactFrame, sources: src, jev: d.jev, sec: (d.ms / 1000).toFixed(1), validation: d.validation ?? 'ok', why: d.why }));
