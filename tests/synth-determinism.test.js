import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateClip, CODE_SHA256 } from './synth/clip.mjs';
import { planSplit, SPLITS } from './synth/scenarios.mjs';

const small = s => ({ ...s, format: { ...s.format, W: 216, H: Math.round(216 * s.format.H / s.format.W / 2) * 2 }, durationOut: Math.min(s.durationOut, 1.6) });

test('the same seed gives byte-identical raw frames and ground truth', async () => {
  for (const name of ['dtl30-glint', 'ob30-sunset-vfr', 'fo120s-teeflies']) {
    const base = small(planSplit('smoke').find(s => s.scenario === name)), runs = [];
    for (let i = 0; i < 2; i++) {
      const dir = mkdtempSync(join(tmpdir(), 'synth-d-')), frames = createHash('sha256');
      const res = await generateClip(structuredClone(base), { outDir: dir, threads: 1, onFrame: (k, buf) => frames.update(buf) });
      runs.push({ raw: frames.digest('hex'), gt: readFileSync(join(dir, res.gtFile), 'utf8'), video: createHash('sha256').update(readFileSync(join(dir, res.file))).digest('hex'), res });
    }
    assert.equal(runs[0].raw, runs[1].raw, `${name}: raw frames differ`);
    assert.equal(runs[0].gt, runs[1].gt, `${name}: ground truth differs`);
    assert.equal(runs[0].video, runs[1].video, `${name}: encoded bytes differ`);
    assert.equal(JSON.parse(runs[0].gt).meta.rawSha256, runs[0].raw);
    assert.match(JSON.parse(runs[0].gt).generator.ffmpeg, /^ffmpeg version /);
    assert.equal(JSON.parse(runs[0].gt).generator.codeSha256, CODE_SHA256);
  }
});

test('manifest and --index builds refuse a directory whose clips come from different generator code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-v-')), cli = join(dirname(fileURLToPath(import.meta.url)), 'synth', 'cli.mjs');
  for (const [id, sha] of [['smoke-a', 'a'.repeat(64)], ['smoke-b', 'b'.repeat(64)]]) writeFileSync(join(dir, `${id}.gt.json`), JSON.stringify({ id, split: 'smoke', generator: { codeSha256: sha, node: process.version, ffmpeg: 'ffmpeg version x' } }));
  const r = spawnSync(process.execPath, [cli, '--split', 'smoke', '--out', dir, '--index'], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /refusing to index .* 2 generator versions/);
  assert.ok(!existsSync(join(dir, 'manifest.json')) && !existsSync(join(dir, 'coverage.json')), 'nothing written');
  assert.match(CODE_SHA256, /^[0-9a-f]{64}$/);
});

test('split plans are deterministic and use the specified seeds', () => {
  const t1 = planSplit('tune'), t2 = planSplit('tune'), h = planSplit('holdout'), smoke = planSplit('smoke');
  assert.deepEqual(t1, t2);
  assert.deepEqual(t1.map(s => s.seed), Array.from({ length: 400 }, (_, i) => i + 1));
  assert.deepEqual(h.map(s => s.seed), Array.from({ length: 300 }, (_, i) => 100001 + i));
  assert.equal(h.filter(s => s.styleShift).length, 90); assert.equal(t1.filter(s => s.styleShift).length, 0);
  assert.equal(smoke.length, 29);
  const cells = new Set(smoke.map(s => `${s.viewClass}${s.capture.fps}`));
  for (const v of ['dtl', 'fo', 'oblique']) for (const f of [30, 60, 120, 240]) assert.ok(cells.has(`${v}${f}`), `smoke covers ${v} x ${f} fps`);
  assert.equal(smoke.filter(s => s.easy).length, 4, 'smoke carries clips on the easy recipe');
  assert.ok(smoke.some(s => s.confounders.practiceFirst && s.kind === 'hit'), 'smoke has a practice-then-hit clip');
  assert.deepEqual(SPLITS.tune.seeds, [1, 400]);
});
