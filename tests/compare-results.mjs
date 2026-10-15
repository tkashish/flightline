#!/usr/bin/env node
/**
 * Side-by-side comparison of two evaluate-tracking JSON reports.
 * Usage: node tests/compare-results.mjs baseline.json candidate.json
 */
import { readFile } from 'node:fs/promises';
import { summarizeTotals } from './lib/metrics.mjs';

function indexById(report) {
  const map = new Map();
  for (const clip of report.clips || []) map.set(clip.id, clip);
  return map;
}

function cell(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v).replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '/');
}

const label = r => {
  const git = r.provenance?.git;
  return `${r.engine || '?'} @ ${git?.short || r.gitSha || 'unknown'}${git?.dirty ? '+dirty' : ''}`;
};
const track = c => c.trackStatus && `${c.trackStatus}${c.fallback ? ' (fallback)' : ''}`;

async function main() {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) {
    console.error('Usage: node tests/compare-results.mjs <baseline.json> <candidate.json>');
    process.exit(1);
  }
  const a = JSON.parse(await readFile(aPath, 'utf8'));
  const b = JSON.parse(await readFile(bPath, 'utf8'));
  const am = indexById(a);
  const bm = indexById(b);
  const ids = [...new Set([...am.keys(), ...bm.keys()])];

  console.log(`# Compare ${label(a)} → ${label(b)}`);
  console.log('');
  console.log('| Clip | Split | A result | B result | A track | B track | A obs | B obs | A impact err | B impact err | A launch px | B launch px | A recall | B recall | A path px | B path px | Delta obs |');
  console.log('| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const id of ids) {
    const x = am.get(id) || {};
    const y = bm.get(id) || {};
    const dObs = (y.observedFrames ?? 0) - (x.observedFrames ?? 0);
    console.log(`| ${[id, y.split || x.split, x.status, y.status, track(x), track(y), x.observedFrames, y.observedFrames,
      x.impactTimingErrorSec, y.impactTimingErrorSec, x.launchAnchorErrorPx, y.launchAnchorErrorPx,
      x.flightRecall, y.flightRecall, x.maxPathErrorPx, y.maxPathErrorPx].map(cell).join(' | ')} | ${dObs >= 0 ? '+' : ''}${dObs} |`);
  }
  const at = a.totals || summarizeTotals(a.clips || []), bt = b.totals || summarizeTotals(b.clips || []);
  console.log('');
  console.log('| Split | A pass/fail/unknown/not run/error | B pass/fail/unknown/not run/error |');
  console.log('| --- | --- | --- |');
  const line = t => (t ? [t.pass, t.fail, t.unknown_ground_truth, t.not_run, t.error].map(v => v ?? 0).join(' / ') : '—');
  for (const split of new Set([...Object.keys(at), ...Object.keys(bt)])) console.log(`| ${split} | ${line(at[split])} | ${line(bt[split])} |`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
