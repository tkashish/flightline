#!/usr/bin/env node
/**
 * Offline tracking evaluation CLI. The default engine is the one the app ships (DEFAULT_ENGINE, v2).
 *
 * Usage:
 *   node tests/evaluate-tracking.mjs --manifest tests/fixtures/local-manifest.json
 *   node tests/evaluate-tracking.mjs --manifest tests/fixtures/manifest.example.json --engine legacy --json docs/benchmark-runs/legacy.json
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runTrackerOffline, DEFAULT_ENGINE } from './lib/run-tracker-offline.mjs';
import { pickEngine } from '../dist/frame-source.js';
import { evaluateClip, formatMarkdownReport, summarizeTotals, DEFAULTS, DEFAULT_TOLERANCES_PX } from './lib/metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const home = homedir();

function parseArgs(argv) {
  const out = { engine: DEFAULT_ENGINE, manifest: null, json: null, md: null, limit: null };
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

const sha256 = data => createHash('sha256').update(data).digest('hex');
/** Reports are shared; keep the home directory out of them. */
const redact = s => (typeof s === 'string' && home.length > 1 ? s.split(home).join('~') : s);

function git(args) {
  const r = spawnSync('git', args, { cwd: root, maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : null;
}

/** HEAD plus a hash of every uncommitted change (tracked diff and untracked files). */
function gitProvenance() {
  const sha = git(['rev-parse', 'HEAD'])?.toString().trim() || null;
  if (!sha) return { sha: null, short: null, dirty: null, changedFiles: null, diffSha256: null };
  const changed = (git(['status', '--porcelain', '--untracked-files=all'])?.toString() || '').split('\n').filter(Boolean);
  let diffSha256 = null;
  if (changed.length) {
    const hash = createHash('sha256').update(git(['diff', 'HEAD', '--binary']) || '');
    const untracked = (git(['ls-files', '--others', '--exclude-standard', '-z'])?.toString() || '').split('\0').filter(Boolean).sort();
    for (const file of untracked) {
      hash.update(`\0${file}\0`);
      try { hash.update(readFileSync(resolve(root, file))); } catch { /* vanished */ }
    }
    diffSha256 = hash.digest('hex');
  }
  return { sha, short: sha.slice(0, 7), dirty: changed.length > 0, changedFiles: changed.length, diffSha256 };
}

function toolVersion(cmd) {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  const first = r.status === 0 ? r.stdout.split('\n')[0] : '';
  return first.match(/version (\S+)/)?.[1] || first || null;
}

/** Inline or file annotation. A configured file that is missing or unparsable is an error. */
async function loadAnnotation(clip, baseDir) {
  if (clip.annotationInline) {
    return { data: { id: clip.id, ...clip.annotationInline }, path: null, sha256: sha256(JSON.stringify(clip.annotationInline)) };
  }
  if (!clip.annotation) return null;
  const path = isAbsolute(clip.annotation) ? clip.annotation : resolve(baseDir, clip.annotation);
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    throw Object.assign(new Error(`Annotation not readable at ${path} (${error.code || error.message})`),
      { reason: error.code === 'ENOENT' ? 'annotation_missing' : 'annotation_unreadable', path });
  }
  try {
    return { data: { id: clip.id, ...JSON.parse(bytes.toString('utf8')) }, path, sha256: sha256(bytes) };
  } catch (error) {
    throw Object.assign(new Error(`Annotation at ${path} is not valid JSON: ${error.message}`), { reason: 'annotation_invalid', path });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest) {
    console.log('Usage: node tests/evaluate-tracking.mjs --manifest <path> [--engine v2|legacy] [--json out.json] [--md out.md] [--limit n]');
    process.exit(args.help ? 0 : 1);
  }
  // The frame-fed engines only: an hf run here would be a legacy run labelled hf (hf: tests/bench/run-node.mjs).
  try { args.engine = pickEngine(args.engine); } catch (error) {
    console.error(`${error.message}${args.engine === 'hf' ? ' The hf engine runs in tests/bench/run-node.mjs.' : ''}`);
    process.exit(1);
  }

  const manifestPath = resolve(root, args.manifest);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const baseDir = dirname(manifestPath);
  let clips = manifest.clips || [];
  if (args.limit) clips = clips.slice(0, args.limit);
  const tolerancesPx = manifest.tolerancesPx || DEFAULT_TOLERANCES_PX;
  const sampleFps = manifest.fps || 30, longEdge = manifest.longEdge || 1280;
  const gitInfo = gitProvenance();

  const report = {
    schema: 'flightline-tracking-eval-v2',
    engine: args.engine,
    baselineLabel: manifest.baselineLabel || 'tracking-v1',
    generatedAt: new Date().toISOString(),
    gitSha: gitInfo.short,
    manifest: redact(args.manifest),
    tolerancesPx,
    provenance: {
      git: gitInfo,
      engine: args.engine,
      options: { limit: args.limit || null, sampleFps, longEdge, tolerancesPx, frameRule: 'sourceFrameSchedule', metrics: DEFAULTS },
      argv: redact(process.argv.slice(2).join(' ')),
      node: process.version,
      ffmpeg: toolVersion('ffmpeg'),
      ffprobe: toolVersion('ffprobe'),
      platform: `${platform()}-${arch()}`,
      manifestSha256: sha256(manifestBytes)
    },
    clips: []
  };

  for (const clip of clips) {
    const id = clip.id || clip.path;
    const base = { id, path: redact(clip.path), split: clip.split || 'unspecified', tags: clip.tags || [] };
    const videoPath = !clip.path ? '' : isAbsolute(clip.path) ? clip.path : resolve(baseDir, clip.path);
    process.stderr.write(`\n[${id}] ${redact(videoPath)}\n`);

    if (clip.skip) {
      report.clips.push({ ...base, status: 'not_run', reason: 'skipped', skipReason: clip.skipReason || null, notes: [clip.skipReason || 'Skipped in manifest'] });
      console.error(`  NOT RUN — skipped: ${clip.skipReason || 'no reason given'}`);
      continue;
    }
    if (!(await exists(videoPath))) {
      report.clips.push({ ...base, status: 'not_run', reason: 'video_missing', notes: [`Video not found at ${redact(videoPath)}`] });
      console.error('  NOT RUN — video missing');
      continue;
    }

    let annotation;
    try {
      annotation = await loadAnnotation(clip, baseDir);
    } catch (error) {
      report.clips.push({ ...base, status: 'error', reason: error.reason, annotationPath: redact(error.path), notes: [redact(error.message)] });
      console.error(`  ERROR — ${redact(error.message)}`);
      continue;
    }

    try {
      const run = await runTrackerOffline(videoPath, {
        engine: args.engine,
        sampleFps: clip.fps || sampleFps,
        sourceFps: clip.sourceFps || null,
        longEdge: clip.longEdge || longEdge,
        onProgress: ({ index }) => {
          if (index % 60 === 0) process.stderr.write(`  frame ${index}\n`);
        }
      });
      const metrics = evaluateClip(run, annotation?.data || null, { tolerancesPx });
      report.clips.push({
        ...metrics,
        ...base,
        annotationPath: redact(annotation?.path ?? null),
        annotationSha256: annotation?.sha256 ?? null,
        sampling: run.sampling,
        rawFirst: run.result.points[0] || null,
        rawLast: run.result.points.at(-1) || null,
        competingTracks: run.competingTracks?.slice(0, 5) || []
      });
      console.error(`  ${metrics.status} — track ${metrics.trackStatus}${metrics.fallback ? ` (fallback ${metrics.fallbackKind})` : ''}, observed=${metrics.observedFrames} first=${metrics.firstT} last=${metrics.lastT} (${metrics.elapsedMs.toFixed(0)} ms)`);
    } catch (error) {
      report.clips.push({ ...base, status: 'error', reason: 'runner_error', notes: [redact(error.message)] });
      console.error(`  ERROR — ${redact(error.message)}`);
    }
  }

  report.totals = summarizeTotals(report.clips);
  const md = formatMarkdownReport(report);
  if (args.json) {
    const out = resolve(root, args.json);
    await writeFile(out, JSON.stringify(report, null, 2));
    console.log(`Wrote ${redact(out)}`);
  }
  if (args.md) {
    const out = resolve(root, args.md);
    await writeFile(out, md);
    console.log(`Wrote ${redact(out)}`);
  }
  console.log('\n' + md);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
