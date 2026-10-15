#!/usr/bin/env node
/**
 * Build a local-manifest.json from a folder of videos (gitignored output).
 * tune/holdout is fixed per clip by its chronological position in the whole folder, so a clip
 * keeps its split under any --limit or --stride.
 *
 * Usage:
 *   node tests/build-manifest.mjs --dir ~/Downloads/Photos-1-001 --out tests/fixtures/local-manifest.json
 *   node tests/build-manifest.mjs --dir ~/Downloads/Photos-1-001 --holdout-ratio 0.35
 */
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    dir: null,
    out: resolve(root, 'tests/fixtures/local-manifest.json'),
    holdoutRatio: 0.35,
    includeQa: true,
    limit: null,
    stride: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--holdout-ratio') out.holdoutRatio = Number(argv[++i]);
    else if (a === '--no-qa') out.includeQa = false;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--stride') out.stride = Number(argv[++i]);
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
    console.error('Usage: node tests/build-manifest.mjs --dir <video-folder> [--out path] [--limit 8] [--holdout-ratio 0.35]');
    console.error('  --limit 8   default smoke size (spread across folder). Use --limit 0 for all clips.');
    process.exit(1);
  }
  const dir = expandHome(args.dir);
  const all = (await readdir(dir))
    .filter(n => /\.(mp4|mov|webm|m4v)$/i.test(n))
    .sort();
  // Split over the full (chronological for PXL_ names) listing before any subsetting.
  const holdoutCount = args.holdoutRatio > 0 ? Math.max(1, Math.round(all.length * args.holdoutRatio)) : 0;
  const tuneEnd = Math.max(0, all.length - holdoutCount);
  let picked = all.map((name, order) => ({ name, order, split: order < tuneEnd ? 'tune' : 'holdout' }));
  // Default to a small smoke subset — full corpus is opt-in via --limit 0 or a high limit.
  if (args.stride && args.stride > 1) {
    picked = picked.filter((_, i) => i % args.stride === 0);
  }
  if (args.limit == null) args.limit = 8;
  if (args.limit > 0 && picked.length > args.limit) {
    // Spread picks across the session instead of taking only the first N.
    const picks = [];
    for (let i = 0; i < args.limit; i++) {
      picks.push(picked[Math.round(i * (picked.length - 1) / Math.max(1, args.limit - 1))]);
    }
    picked = [...new Set(picks)];
  }

  const clips = picked.map(({ name, order, split }) => ({
    id: basename(name, extname(name)).replace(/[^a-zA-Z0-9._-]+/g, '_'),
    path: resolve(dir, name),
    split,
    order,
    tags: ['pixel-phone', 'photos-1-001', split]
  }));

  if (args.includeQa) {
    clips.unshift(
      {
        id: 'pxl_qa',
        path: resolve(root, 'dist/qa/pxl.mp4'),
        split: 'tune',
        tags: ['qa']
      },
      {
        id: 'pxl300_qa',
        path: resolve(root, 'dist/qa/pxl300.mp4'),
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
      `Split is chronological by filename over the whole folder (${all.length} videos; the last ${holdoutCount} are holdout), independent of --limit/--stride; order is the position in that listing.`,
      'fps is the analysis sample rate; frames are picked from the source like the browser does (sourceFrameSchedule).',
      'Add annotation files later for shot-level pass/fail.'
    ],
    clips
  };

  const outPath = resolve(args.out);
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`Clips: ${clips.length} (tune ${clips.filter(c => c.split === 'tune').length}, holdout ${clips.filter(c => c.split === 'holdout').length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
