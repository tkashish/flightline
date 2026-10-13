#!/usr/bin/env node
/**
 * Side-by-side comparison of two evaluate-tracking JSON reports.
 * Usage: node tests/compare-results.mjs baseline.json candidate.json
 */
import { readFile } from 'node:fs/promises';

function indexById(report) {
  const map = new Map();
  for (const clip of report.clips || []) map.set(clip.id, clip);
  return map;
}

function cell(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

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

  console.log(`# Compare ${a.engine || aPath} → ${b.engine || bPath}`);
  console.log('');
  console.log('| Clip | A status | B status | A obs | B obs | A impact err | B impact err | A launch px | B launch px | Delta obs |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const id of ids) {
    const x = am.get(id) || {};
    const y = bm.get(id) || {};
    const dObs = (y.observedFrames ?? 0) - (x.observedFrames ?? 0);
    console.log(`| ${id} | ${cell(x.status)} | ${cell(y.status)} | ${cell(x.observedFrames)} | ${cell(y.observedFrames)} | ${cell(x.impactTimingErrorSec)} | ${cell(y.impactTimingErrorSec)} | ${cell(x.launchAnchorErrorPx)} | ${cell(y.launchAnchorErrorPx)} | ${dObs >= 0 ? '+' : ''}${dObs} |`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
