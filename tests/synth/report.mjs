#!/usr/bin/env node
// Harness pass rates by stratum, from evaluate-tracking.mjs --json reports over synthetic manifests (their clip tags):
// confounder count, stratum (clean/main/stress/easy), view x capture and expected outcome.
// node tests/synth/report.mjs <report.json> [...]
import { readFileSync } from 'node:fs';

const tag = (c, p) => (c.tags || []).find(t => t.startsWith(p))?.slice(p.length) ?? '?';
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
for (const file of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(file, 'utf8')), lines = [`# ${R.engine}: ${R.manifest} (${R.clips.length} clips)`];
  const table = (title, key, order = (a, b) => a.localeCompare(b, 'en', { numeric: true })) => {
    lines.push('', `| ${title} | clips | pass | fail | unknown | pass / decided |`, '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [k, g] of [...Map.groupBy(R.clips, key)].sort((a, b) => order(a[0], b[0]))) {
      const n = s => g.filter(c => c.status === s).length, p = n('pass'), f = n('fail');
      lines.push(`| ${k} | ${g.length} | ${p} | ${f} | ${n('unknown_ground_truth')} | ${pct(p, p + f)} |`);
    }
  };
  table('confounders', c => tag(c, 'confounders:'));
  table('stratum', c => tag(c, 'stratum:'));
  table('view x capture', c => `${tag(c, 'view:')} ${tag(c, 'capture:')}`);
  table('expected', c => tag(c, 'expected:'));
  console.log(lines.join('\n') + '\n');
}
