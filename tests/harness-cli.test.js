import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './lib/metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) && 'ffmpeg/ffprobe not installed';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const node = (script, args, cwd = root) => {
  const r = spawnSync('node', [join(root, 'tests', script), ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const tempDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'flightline-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('evaluate-tracking defaults to v2 and reports engine fields, errors, skips, splits and provenance', { skip }, t => {
  const dir = tempDir(t);
  // A motionless clip: every engine abstains on it.
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '64x48', '-r', '30', '-i', 'pipe:0',
    '-pix_fmt', 'yuv420p', join(dir, 'static.mp4')], { input: Buffer.alloc(64 * 48 * 30, 90) });
  assert.equal(r.status, 0, String(r.stderr));
  const annotation = JSON.stringify({ impactT: 0.5, addressBall: { t: 0.5, x: 30, y: 30 }, frames: [{ t: 0.6, status: 'visible', x: 32, y: 25 }] });
  writeFileSync(join(dir, 'ball.json'), annotation);
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  const manifest = JSON.stringify({
    baselineLabel: 'cli-test', fps: 30,
    clips: [
      { id: 'missed', path: 'static.mp4', split: 'tune', annotation: 'ball.json' },
      { id: 'unlabeled', path: 'static.mp4', split: 'tune' },
      { id: 'typo', path: 'static.mp4', split: 'holdout', annotation: 'ball.jsno' },
      { id: 'bad-json', path: 'static.mp4', split: 'holdout', annotation: 'bad.json' },
      { id: 'abstain', path: 'static.mp4', split: 'holdout', annotationInline: { expectAbstention: true } },
      { id: 'skipped', path: '/nonexistent/clip.mp4', split: 'holdout', skip: true, skipReason: 'placeholder clip' },
      { id: 'no-video', path: 'missing.mp4', split: 'holdout' }
    ]
  });
  writeFileSync(join(dir, 'manifest.json'), manifest);
  const evaluate = (...extra) => {
    const json = join(dir, `report-${extra.join('') || 'default'}.json`), md = json.replace(/json$/, 'md');
    node('evaluate-tracking.mjs', ['--manifest', join(dir, 'manifest.json'), '--json', json, '--md', md, ...extra]);
    return { report: JSON.parse(readFileSync(json, 'utf8')), md: readFileSync(md, 'utf8') };
  };

  const { report, md } = evaluate();
  assert.equal(report.engine, 'v2');
  const clip = Object.fromEntries(report.clips.map(c => [c.id, c]));
  assert.equal(clip.missed.status, 'fail');
  assert.deepEqual(clip.missed.failReasons, ['missed_visible_ball']);
  assert.equal(clip.missed.trackStatus, 'no_reliable_track');
  assert.equal(clip.missed.resultEngine, 'global-v2');
  assert.equal(clip.missed.fallback, false);
  assert.ok(Array.isArray(clip.missed.reasonCodes) && 'confidence' in clip.missed && 'vsRunner' in clip.missed);
  assert.equal(clip.missed.sampling.rule, 'sourceFrameSchedule');
  assert.equal(clip.missed.annotationSha256, sha256(annotation));
  assert.equal(clip.unlabeled.status, 'unknown_ground_truth');
  assert.equal(clip.typo.status, 'error');
  assert.equal(clip.typo.reason, 'annotation_missing');
  assert.ok(clip.typo.notes[0].includes(join(dir, 'ball.jsno')), clip.typo.notes[0]);
  assert.equal(clip['bad-json'].status, 'error');
  assert.equal(clip['bad-json'].reason, 'annotation_invalid');
  assert.equal(clip.abstain.status, 'pass');
  assert.equal(clip.skipped.status, 'not_run');
  assert.equal(clip.skipped.reason, 'skipped');
  assert.equal(clip.skipped.skipReason, 'placeholder clip');
  assert.equal(clip['no-video'].reason, 'video_missing');

  assert.deepEqual(report.totals.tune, { clips: 2, pass: 0, fail: 1, unknown_ground_truth: 1, not_run: 0, error: 0, abstained: 2, fallback: 0 });
  assert.deepEqual(report.totals.holdout, { clips: 5, pass: 1, fail: 0, unknown_ground_truth: 0, not_run: 2, error: 2, abstained: 1, fallback: 0 });
  assert.ok(md.includes('| tune | 2 | 0 | 1 | 1 | 0 | 0 | 2 | 0 |'));
  assert.ok(md.includes('| holdout | 5 | 1 | 0 | 0 | 2 | 2 | 1 | 0 |'));
  assert.ok(md.includes('| missed | tune | fail | global-v2 | no_reliable_track |'));

  const p = report.provenance;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status === 0) {
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout;
    assert.equal(p.git.sha, head.stdout.trim());
    assert.equal(p.git.dirty, status.trim().length > 0);
    if (p.git.dirty) assert.match(p.git.diffSha256, /^[0-9a-f]{64}$/);
    else assert.equal(p.git.diffSha256, null);
  }
  assert.equal(p.engine, 'v2');
  assert.equal(p.node, process.version);
  assert.ok(p.ffmpeg && p.ffprobe);
  assert.equal(p.manifestSha256, sha256(manifest));
  assert.deepEqual(p.options.metrics, DEFAULTS);
  assert.equal(p.options.frameRule, 'sourceFrameSchedule');
  assert.match(md, /## Provenance/);

  const legacy = evaluate('--engine', 'legacy').report;
  assert.equal(legacy.engine, 'legacy');
  assert.equal(legacy.clips.find(c => c.id === 'missed').resultEngine, 'motion-beta');
});

test('the frame-fed harness refuses hf and unknown engines up front instead of running legacy under their name', async t => {
  const dir = tempDir(t), json = join(dir, 'never.json');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ clips: [{ id: 'a', path: 'missing.mp4' }] }));
  for (const [engine, message] of [['hf', /^Tracking engine "hf" cannot run here\. Use v2 or legacy\. The hf engine runs in tests\/bench\/run-node\.mjs\.$/m], ['bogus', /^Unknown tracking engine "bogus"\. Use v2 or legacy\.$/m]]) {
    const r = spawnSync('node', [join(root, 'tests', 'evaluate-tracking.mjs'), '--manifest', join(dir, 'manifest.json'), '--engine', engine, '--json', json], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, message);
    assert.throws(() => readFileSync(json), { code: 'ENOENT' }, 'no report is written');
  }
  // The library entry checks the name before it reads the video.
  const { runTrackerOffline } = await import('./lib/run-tracker-offline.mjs');
  await assert.rejects(runTrackerOffline(join(dir, 'missing.mp4'), { engine: 'hf' }), /Tracking engine "hf" cannot run here/);
});

test('build-manifest fixes each clip split by its place in the whole folder', t => {
  const dir = tempDir(t);
  const names = Array.from({ length: 20 }, (_, i) => `PXL_20261011_1825${String(i).padStart(2, '0')}000.mp4`);
  for (const n of names) writeFileSync(join(dir, n), '');
  writeFileSync(join(dir, 'notes.txt'), '');
  let k = 0;
  const build = (...args) => {
    const out = join(dir, `m${k++}.json`);
    node('build-manifest.mjs', ['--dir', dir, '--out', out, ...args], dir);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  const splits = m => Object.fromEntries(m.clips.filter(c => !c.tags.includes('qa')).map(c => [c.id, c.split]));
  const full = build('--limit', '0');
  const truth = splits(full);
  assert.equal(Object.keys(truth).length, 20);
  // The last round(20 * 0.35) = 7 clips of the folder are holdout.
  assert.deepEqual(Object.keys(truth).filter(id => truth[id] === 'holdout'), names.slice(13).map(n => n.replace('.mp4', '')));
  assert.deepEqual(full.clips.filter(c => c.order != null).map(c => c.order), names.map((_, i) => i));
  for (const m of [build('--limit', '4'), build('--stride', '3', '--limit', '0'), build('--limit', '5', '--no-qa')]) {
    assert.ok(Object.keys(splits(m)).length < 20);
    for (const [id, split] of Object.entries(splits(m))) assert.equal(split, truth[id], id);
  }
  const small = build('--limit', '4');
  assert.deepEqual(Object.values(splits(small)), ['tune', 'tune', 'holdout', 'holdout']);
  // QA clips resolve against the repo, not the working directory.
  assert.deepEqual(full.clips.filter(c => c.tags.includes('qa')).map(c => c.path), [resolve(root, 'dist/qa/pxl.mp4'), resolve(root, 'dist/qa/pxl300.mp4')]);
});
