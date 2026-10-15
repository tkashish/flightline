import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicker } from '../dist/picker.js';

// Checks resolve when the test says so, or 'Cancelled.' once their signal aborts (like inspectVideoFile).
function harness({ honorAbort = true } = {}) {
  const checks = [], opened = [], log = [];
  const picker = createPicker({
    check: (file, signal) => new Promise(resolve => {
      checks.push({ file, signal, resolve });
      if (honorAbort && signal.aborted) resolve('Cancelled.');
      else if (honorAbort) signal.addEventListener('abort', () => resolve('Cancelled.'), { once: true });
    }),
    open: results => { opened.push(results.map(r => r.file + (r.problem ? `: ${r.problem}` : ''))); log.push('open'); },
    refuse: () => log.push('refused')
  });
  const pick = files => picker.pick(files, { checking: () => log.push(`checking ${files}`), checked: () => log.push(`checked ${files}`) });
  return { picker, checks, opened, log, pick };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const quick = { timeout: 5000 };

test('a pick opens once every file is checked, with each problem', quick, async () => {
  const { checks, opened, log, pick } = harness();
  const done = pick(['a.mp4', 'b.txt']);
  await settle();
  assert.deepEqual(checks.map(c => c.file), ['a.mp4']);
  checks[0].resolve(null); await settle();
  checks[1].resolve('Choose a video file.');
  await done;
  assert.deepEqual(opened, [['a.mp4', 'b.txt: Choose a video file.']]);
  assert.deepEqual(log, ['checking a.mp4,b.txt', 'checked a.mp4,b.txt', 'open']);
});

test('a newer pick stops and replaces one still being checked', quick, async () => {
  const { checks, opened, log, pick } = harness();
  const first = pick(['a.mp4']);
  const second = pick(['b.mp4']);
  assert.equal(checks[0].signal.aborted, true);
  await first;
  checks[1].resolve(null);
  await second;
  assert.deepEqual(opened, [['b.mp4']]);
  assert.deepEqual(log, ['checking a.mp4', 'checking b.mp4', 'checked a.mp4', 'checked b.mp4', 'open']);
});

test('Cancel drops a pick still being checked, even if its check finishes anyway', quick, async () => {
  for (const honorAbort of [true, false]) {
    const { picker, checks, opened, log, pick } = harness({ honorAbort });
    const pending = pick(['a.mp4']);
    picker.cancel();
    assert.equal(checks[0].signal.aborted, true);
    checks[0].resolve(null);
    await pending;
    assert.deepEqual(opened, [], `abort honored: ${honorAbort}`);
    assert.deepEqual(log, ['checking a.mp4', 'checked a.mp4']);
    // The next pick is unaffected.
    const next = pick(['b.mp4']);
    checks[1].resolve(null);
    await next;
    assert.deepEqual(opened, [['b.mp4']]);
  }
});

test('a batch refuses other picks from its check on, and opens intact', quick, async () => {
  const { picker, checks, opened, log, pick } = harness();
  const batch = pick(['a.mp4', 'b.mp4']);
  assert.equal(picker.batching, true);
  pick(['c.mp4']); pick(['d.mp4', 'e.mp4']);
  await settle();
  assert.deepEqual(checks.map(c => c.file), ['a.mp4']);
  assert.equal(checks[0].signal.aborted, false);
  checks[0].resolve(null); await settle();
  checks[1].resolve(null);
  await batch;
  assert.equal(picker.batching, false);
  assert.deepEqual(opened, [['a.mp4', 'b.mp4']]);
  assert.deepEqual(log, ['checking a.mp4,b.mp4', 'refused', 'refused', 'checked a.mp4,b.mp4', 'open']);
  // A single-file pick never blocks others.
  const single = pick(['c.mp4']);
  assert.equal(picker.batching, false);
  checks[2].resolve(null);
  await single;
  assert.deepEqual(opened.at(-1), ['c.mp4']);
});

test('Cancel ends a batch check at once: the rest is not checked and the next pick is accepted', quick, async () => {
  const { picker, checks, opened, pick } = harness();
  const batch = pick(['a.mp4', 'b.mp4', 'c.mp4']);
  picker.cancel();
  assert.equal(picker.batching, false);
  const next = pick(['d.mp4']);
  await batch;
  assert.deepEqual(checks.map(c => c.file), ['a.mp4', 'd.mp4']);
  checks[1].resolve(null);
  await next;
  assert.deepEqual(opened, [['d.mp4']]);
});
