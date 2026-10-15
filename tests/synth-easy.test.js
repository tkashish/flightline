import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The tracking harness (evaluate-tracking.mjs and lib/): this repo's tests/ unless FLIGHTLINE_HARNESS points elsewhere.
const harness = resolve(process.env.FLIGHTLINE_HARNESS || here);
const run = (args) => new Promise((ok, fail) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
  p.stderr.on('data', d => { err += d; }); p.on('close', c => (c === 0 ? ok() : fail(new Error(`${args[0]} exited ${c}: ${err.slice(-800)}`))));
});

test('the easy split is passable: each shipped engine passes clips in the down-the-line 30 and 60 fps cells', { timeout: 900000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'synth-easy-')), manifest = join(out, 'manifest.json');
  await run([join(here, 'synth', 'cli.mjs'), '--split', 'easy', '--only', 'dtl30-,dtl60-', '--out', out]);
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).clips.length, 6);
  const engines = ['legacy', 'v2'];
  await Promise.all(engines.map(e => run([join(harness, 'evaluate-tracking.mjs'), '--manifest', manifest, '--engine', e, '--json', join(out, `${e}.json`)])));
  for (const e of engines) {
    const clips = JSON.parse(readFileSync(join(out, `${e}.json`), 'utf8')).clips, pass = clips.filter(c => c.status === 'pass');
    const summary = clips.map(c => `${c.id} ${c.status}${c.failReasons?.length ? ` (${c.failReasons})` : ''}`).join('; ');
    for (const fps of [30, 60]) assert.ok(pass.some(c => c.id.includes(`dtl${fps}-`)), `${e}: no easy down-the-line ${fps} fps clip passes: ${summary}`);
  }
});
