#!/usr/bin/env node
/**
 * Build a local-manifest.json from a folder of videos (gitignored output).
 *
 * Usage:
 *   node tests/build-manifest.mjs --dir ~/Downloads/Photos-1-001 --out tests/fixtures/local-manifest.json
 *   node tests/build-manifest.mjs --dir ~/Downloads/Photos-1-001 --holdout-ratio 0.35
 */
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';

function parseArgs(argv) {
  const out = {
    dir: null,
    out: 'tests/fixtures/local-manifest.json',
    holdoutRatio: 0.35,
    includeQa: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--holdout-ratio') out.holdoutRatio = Number(argv[++i]);
    else if (a === '--no-qa') out.includeQa = false;
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node tests/build-manifest.mjs --dir <video-folder> [--out path] [--holdout-ratio 0.35]');
    process.exit(1);
  }
  const dir = expandHome(args.dir);
  const names = (await readdir(dir))
    .filter(n => /\.(mp4|mov|webm|m4v)$/i.test(n))
    .sort();
  const holdoutCount = Math.max(1, Math.round(names.length * args.holdoutRatio));
  const tuneEnd = Math.max(0, names.length - holdoutCount);

  const clips = names.map((name, i) => ({
    id: basename(name, extname(name)).replace(/[^a-zA-Z0-9._-]+/g, '_'),
    path: resolve(dir, name),
    split: i < tuneEnd ? 'tune' : 'holdout',
    tags: ['pixel-phone', 'photos-1-001', i < tuneEnd ? 'tune' : 'holdout']
  }));

  if (args.includeQa) {
    clips.unshift(
      {
        id: 'pxl_qa',
        path: resolve('dist/qa/pxl.mp4'),
        split: 'tune',
        tags: ['qa']
      },
      {
        id: 'pxl300_qa',
        path: resolve('dist/qa/pxl300.mp4'),
        split: 'tune',
        tags: ['qa']
      }
    );
  }

  const manifest = {
    baselineLabel: 'tracking-v1',
    fps: 30,
    longEdge: 1280,
    tolerancesPx: [5, 10, 20],
    sourceDir: dir,
    notes: [
      'Auto-generated. Paths are machine-local and gitignored.',
      'Split is chronological by filename within the folder (last holdout-ratio = holdout).',
      'Add annotation files later for shot-level pass/fail.'
    ],
    clips
  };

  const outPath = resolve(args.out);
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`Clips: ${clips.length} (tune≈${clips.filter(c => c.split === 'tune').length}, holdout≈${clips.filter(c => c.split === 'holdout').length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
