#!/usr/bin/env node
/**
 * Offline tracking evaluation CLI (Phase 0).
 *
 * Usage:
 *   node tests/evaluate-tracking.mjs --manifest tests/fixtures/local-manifest.json --engine legacy
 *   node tests/evaluate-tracking.mjs --manifest tests/fixtures/manifest.example.json --engine legacy --json docs/benchmark-runs/legacy.json
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runTrackerOffline } from './lib/run-tracker-offline.mjs';
import { evaluateClip, formatMarkdownReport } from './lib/metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { engine: 'legacy', manifest: null, json: null, md: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') out.engine = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--md') out.md = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function loadAnnotation(clip, baseDir) {
  if (clip.annotationInline) return { id: clip.id, ...clip.annotationInline };
  if (!clip.annotation) return null;
  const path = isAbsolute(clip.annotation) ? clip.annotation : resolve(baseDir, clip.annotation);
  if (!(await exists(path))) return null;
  const data = JSON.parse(await readFile(path, 'utf8'));
  return { id: clip.id, ...data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest) {
    console.log(`Usage: node tests/evaluate-tracking.mjs --manifest <path> [--engine legacy] [--json out.json] [--md out.md]`);
    process.exit(args.help ? 0 : 1);
  }

  const manifestPath = resolve(root, args.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const baseDir = dirname(manifestPath);
  let clips = manifest.clips || [];
  if (args.limit) clips = clips.slice(0, args.limit);

  const report = {
    schema: 'flightline-tracking-eval-v1',
    engine: args.engine,
    baselineLabel: manifest.baselineLabel || 'tracking-v1',
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    manifest: args.manifest,
    tolerancesPx: manifest.tolerancesPx || [5, 10, 20],
    clips: []
  };

  for (const clip of clips) {
    const id = clip.id || clip.path;
    const videoPath = isAbsolute(clip.path) ? clip.path : resolve(baseDir, clip.path);
    process.stderr.write(`\n[${id}] ${videoPath}\n`);

    if (!(await exists(videoPath))) {
      report.clips.push({
        id,
        status: 'not_run',
        reason: 'video_missing',
        path: clip.path,
        notes: [`Video not found at ${videoPath}`]
      });
      console.error('  NOT RUN — video missing');
      continue;
    }

    if (clip.skip) {
      report.clips.push({
        id,
        status: 'not_run',
        reason: clip.skipReason || 'skipped',
        notes: [clip.skipReason || 'Skipped in manifest']
      });
      console.error('  NOT RUN — skipped');
      continue;
    }

    try {
      const annotation = await loadAnnotation(clip, baseDir);
      const run = await runTrackerOffline(videoPath, {
        engine: args.engine,
        fps: clip.fps || manifest.fps || 30,
        longEdge: clip.longEdge || manifest.longEdge || 1280,
        onProgress: ({ index }) => {
          if (index % 60 === 0) process.stderr.write(`  frame ${index}\n`);
        }
      });
      const metrics = evaluateClip(run, annotation, {
        tolerancesPx: report.tolerancesPx
      });
      metrics.id = id;
      metrics.path = clip.path;
      metrics.split = clip.split || 'unspecified';
      metrics.tags = clip.tags || [];
      metrics.rawFirst = run.result.points[0] || null;
      metrics.rawLast = run.result.points.at(-1) || null;
      metrics.competingTracks = run.competingTracks?.slice(0, 5) || [];
      report.clips.push(metrics);
      console.error(`  observed=${metrics.observedFrames} first=${metrics.firstT} last=${metrics.lastT} status=${metrics.status} (${metrics.elapsedMs.toFixed(0)} ms)`);
    } catch (error) {
      report.clips.push({
        id,
        status: 'failed',
        reason: 'runner_error',
        notes: [error.message]
      });
      console.error(`  FAILED — ${error.message}`);
    }
  }

  const md = formatMarkdownReport(report);
  if (args.json) {
    const out = resolve(root, args.json);
    await writeFile(out, JSON.stringify(report, null, 2));
    console.log(`Wrote ${out}`);
  }
  if (args.md) {
    const out = resolve(root, args.md);
    await writeFile(out, md);
    console.log(`Wrote ${out}`);
  }
  console.log('\n' + md);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
