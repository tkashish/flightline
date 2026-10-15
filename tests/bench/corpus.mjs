/**
 * Bench corpus (U7): the clips of one or more generator split directories (`<id>.gt.json` next to its video), the
 * sibling invisible-ball `controls` split and `perf` set when present, and the corpus pin every report carries: the
 * generator version and code hash, and per split a manifest hash over every clip file (the generator's
 * checksums.sha256 listing, recomputed from the files). metrics.mjs pinCheck refuses to compare reports whose pins
 * differ.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { clipSet } from './metrics.mjs';

export const PIN_SCHEMA = 'flightline-bench-pin-v1';
/** Sibling split directories a run takes along when they exist (--with). */
export const EXTRA_SETS = Object.freeze(['controls', 'perf']);

const sha256 = s => createHash('sha256').update(s).digest('hex');
export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/** Every clip of one split directory, sorted by id: {id, dir, gtPath, video, videoFile, split, set, generator}. */
export async function readSplitDir(dir) {
  dir = resolve(dir);
  const names = (await readdir(dir)).filter(f => f.endsWith('.gt.json')).sort();
  return Promise.all(names.map(async f => {
    const gt = JSON.parse(await readFile(join(dir, f), 'utf8')), id = f.slice(0, -'.gt.json'.length);
    const videoFile = gt.meta?.video?.file ?? `${id}.mp4`;
    return { id, dir, gtPath: join(dir, f), video: join(dir, videoFile), videoFile, split: gt.split ?? null, set: clipSet(gt), generator: gt.generator ?? null };
  }));
}

/**
 * Split directories of a run: --corpus (comma-separated) plus, for each name in `extra`, a sibling directory of the
 * first corpus with that name when it exists and is not already listed. Returns [{dir, added}].
 */
export function resolveCorpora(corpus, extra = EXTRA_SETS) {
  const dirs = String(corpus).split(',').filter(Boolean).map(d => ({ dir: resolve(d), added: false }));
  const parent = dirname(dirs[0].dir);
  for (const name of extra) {
    const d = join(parent, name);
    if (existsSync(d) && !dirs.some(x => x.dir === d)) dirs.push({ dir: d, added: true });
  }
  return dirs;
}

/** Clips of the run: every split directory, then --only (ids or substrings) and --limit (per directory). */
export async function listClips(dirs, { only = null, limit = null } = {}) {
  const out = [];
  for (const d of [dirs].flat()) {
    let clips = await readSplitDir(typeof d === 'string' ? d : d.dir);
    if (only) clips = clips.filter(c => only.some(o => c.id === o || c.id.includes(o)));
    if (limit) clips = clips.slice(0, limit);
    out.push(...clips);
  }
  const seen = new Set();
  for (const c of out) { if (seen.has(c.id)) throw new Error(`clip id ${c.id} appears in two corpus directories`); seen.add(c.id); }
  return out;
}

const genKey = g => (g ? `${g.version ?? '?'}/${g.codeSha256 ?? '?'}` : 'none');
const oneGenerator = gens => (gens.size === 1 ? (([g]) => ({ version: g?.version ?? null, codeSha256: g?.codeSha256 ?? null }))([...gens.values()]) : { mixed: [...gens.keys()].sort() });

/**
 * Pin the corpus of a run: hash every clip file of every split directory (not only the clips run, so two runs on
 * subsets of one corpus share the pin) and record each split's generator (version and code hash; splits may come from
 * different generator code, a split whose clips disagree is listed in pin.mixed). Returns {pin, files: Map(id ->
 * {gt, video}), stats}. A directory whose checksums.sha256 disagrees with its files was changed after the generator
 * indexed it (pin.splits[s].checksums).
 */
export async function pinCorpus(dirs) {
  const splits = {}, files = new Map(), all = new Map(), stats = {};
  for (const d of [dirs].flat().map(x => (typeof x === 'string' ? x : x.dir))) {
    const clips = await readSplitDir(d), lines = [], gens = new Map();
    for (const c of clips) {
      const [video, gt] = await Promise.all([sha256File(c.video), sha256File(c.gtPath)]);
      files.set(c.id, { gt, video });
      lines.push(`${video}  ${c.videoFile}`, `${gt}  ${c.id}.gt.json`);
      gens.set(genKey(c.generator), c.generator); all.set(genKey(c.generator), c.generator);
      for (const p of [c.video, c.gtPath]) { const s = await stat(p); stats[p] = `${s.size}:${s.mtimeMs}`; }
    }
    const text = lines.join('\n') + '\n', sums = join(d, 'checksums.sha256');
    const split = [...new Set(clips.map(c => c.split).filter(Boolean))].join('+') || basename(d);
    if (splits[split]) throw new Error(`two corpus directories hold split ${split}`);
    const listed = existsSync(sums) ? (await readFile(sums, 'utf8')).trim().split('\n').sort().join('\n') : null;
    splits[split] = {
      dir: d, clips: clips.length, set: clips[0]?.set ?? 'main', generator: oneGenerator(gens), manifestSha256: sha256(text),
      checksums: listed == null ? 'absent' : listed === text.trim().split('\n').sort().join('\n') ? 'match' : 'mismatch'
    };
  }
  const mixed = Object.keys(splits).filter(s => splits[s].generator.mixed);
  const manifestSha256 = sha256(Object.entries(splits).sort(([a], [b]) => a.localeCompare(b)).map(([s, v]) => `${s}\t${v.manifestSha256}\n`).join(''));
  return { pin: { schema: PIN_SCHEMA, generator: oneGenerator(all), mixed, manifestSha256, splits }, files, stats };
}

/** Hash of exactly the clips a run scored (ids and file hashes). */
export const clipsSha256 = (clips, files) => sha256(clips.map(c => `${c.id}\t${files.get(c.id)?.gt}\t${files.get(c.id)?.video}\n`).sort().join(''));

/** Files whose size or mtime changed since pinCorpus (the corpus was being regenerated during the run). */
export async function changedFiles(stats) {
  const out = [];
  for (const [p, was] of Object.entries(stats)) {
    const s = await stat(p).catch(() => null);
    if (!s || `${s.size}:${s.mtimeMs}` !== was) out.push(p);
  }
  return out;
}
