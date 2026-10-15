import test from 'node:test';
import assert from 'node:assert/strict';

// dist/worker.js driven in-process: a stand-in `self` collects the replies.
let instance = 0;
async function worker() {
  const scope = { replies: [] };
  scope.postMessage = message => scope.replies.push(message);
  globalThis.self = scope;
  await import(`../dist/worker.js?test=${++instance}`);
  return message => {
    const before = scope.replies.length;
    scope.onmessage({ data: message });
    return scope.replies.slice(before);
  };
}
const frame = (w, h) => new Uint8ClampedArray(w * h * 4).fill(90).buffer;

test('worker answers every message: init, frame and finish, with v2 when init names no engine', async () => {
  const send = await worker();
  assert.deepEqual(send({ type: 'init', width: 32, height: 24 }), [{ ok: true }]);
  for (let i = 0; i < 3; i++) assert.deepEqual(send({ type: 'frame', buffer: frame(32, 24), time: i / 30 }), [{ ok: true }]);
  const [result] = send({ type: 'finish' });
  assert.equal(result.engine, 'global-v2');
  assert.equal(send({ type: 'init', width: 32, height: 24, engine: 'legacy' }).length, 1);
  assert.equal(send({ type: 'finish' })[0].engine, 'motion-beta');
});

test('worker replies with an error to unknown messages, engines and out-of-order calls', async () => {
  const send = await worker();
  assert.deepEqual(send({ type: 'frame', buffer: frame(4, 4), time: 0 }), [{ error: 'Worker message "frame" before init.' }]);
  assert.deepEqual(send({ type: 'finish' }), [{ error: 'Worker message "finish" before init.' }]);
  for (const type of ['bogus', 'roi-frame', 'refine-init', undefined]) {
    const replies = send({ type });
    assert.equal(replies.length, 1, String(type));
    assert.match(replies[0].error, /^Unknown worker message/);
  }
  for (const engine of ['V2', 'global-v2', 'bogus']) assert.match(send({ type: 'init', width: 4, height: 4, engine })[0].error, /Unknown tracking engine/);
});

/* ---------------------------------------------------------------- hf protocol (docs/TRACKING_HF_PROTOCOL.md §11) */

import { createMemorySource, validateResult } from '../dist/hf/types.js';
import { RemoteFrameSource, serveElementFrames } from '../dist/hf/decode/element-source.js';
import { writeMp4, gopOrder } from './hf/helpers/mp4-writer.mjs';
import { fakeWebCodecs } from './hf/helpers/fake-webcodecs.mjs';
import { CANCEL_GRACE_MS, HF_BUILD_KEY, HF_FILES, REFRESH_MS, hfRefresher, refreshHF, startAnalysis } from '../dist/analysis-client.js';

const W = 96, H = 64, flat = new Uint8Array(W * H).fill(120);
const clip = (n = 24) => new Blob([writeMp4({ samples: gopOrder(n, { gop: 12, bf: 0 }), width: W, height: H })]);
const memory = (n = 24) => createMemorySource({ width: W, height: H, frames: Array.from({ length: n }, () => flat), fps: 30 });
// WebCodecs for this process: the fake decoder renders the same flat picture for every chunk.
function codecs(o = {}) {
  const wc = fakeWebCodecs({ format: 'I420', codedWidth: W, codedHeight: H, render: () => ({ y: flat }), ...o });
  Object.assign(globalThis, { VideoDecoder: wc.VideoDecoder, EncodedVideoChunk: wc.EncodedVideoChunk });
  return wc;
}
const noCodecs = () => { delete globalThis.VideoDecoder; delete globalThis.EncodedVideoChunk; };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const ends = r => r.type === 'hf-result' || r.type === 'hf-error';

/** dist/worker.js in this process, driven message by message; replies are collected (async ones included). */
async function hfWorker() {
  const scope = { replies: [] };
  scope.postMessage = m => scope.replies.push(m);
  globalThis.self = scope;
  await import(`../dist/worker.js?test=${++instance}`);
  const of = id => scope.replies.filter(r => r.jobId === id);
  return {
    scope, of, post: m => scope.onmessage({ data: m }), final: id => of(id).find(ends),
    async until(ok, ms = 30000) { for (const t0 = Date.now(); !ok(); await tick(10)) if (Date.now() - t0 > ms) throw new Error('timed out'); }
  };
}
const META_KEYS = ['fps', 'frameCount', 'hasAudio', 'height', 'path', 'rotation', 'vfr', 'width'];

test('hf-analyze: hf-source, progress and exactly one hf-result, all with the job id; the codec source releases the element port', async () => {
  codecs();
  const w = await hfWorker(), ch = new MessageChannel(), served = serveElementFrames(memory(), ch.port1);
  w.post({ type: 'hf-analyze', jobId: 'j1', file: clip(), options: { prefer: 'auto', diagnostics: false }, port: ch.port2 });
  await w.until(() => w.final('j1'));
  const replies = w.scope.replies, [source] = replies, last = replies.at(-1), progress = replies.filter(r => r.type === 'hf-progress');
  assert.ok(replies.every(r => r.jobId === 'j1'));
  assert.equal(source.type, 'hf-source');
  assert.deepEqual(Object.keys(source.meta).sort(), META_KEYS);
  assert.deepEqual([source.meta.path, source.meta.width, source.meta.height, source.meta.frameCount, source.meta.rotation], ['codec', W, H, 24, 0]);
  assert.ok(progress.length >= 3 && progress.every(p => Number.isInteger(p.done) && Number.isInteger(p.total)));
  assert.deepEqual([progress[0].phase, progress.at(-1).phase], ['probe', 'done']);
  assert.equal(replies.filter(ends).length, 1);
  assert.equal(last.type, 'hf-result');
  assert.deepEqual(validateResult(last.result, { width: W, height: H, fps: 30 }), { ok: true, errors: [] });
  assert.deepEqual([last.result.engine, last.result.status], ['hf', 'no_reliable_track']);
  await served;   // the codec source told the main thread to stop serving
  noCodecs();
});

test('a decoder failure mid-clip is retried once on the element path, which takes the port over first', async () => {
  codecs({ failAfter: 14 });
  const w = await hfWorker(), ch = new MessageChannel(), served = serveElementFrames(memory(), ch.port1);
  w.post({ type: 'hf-analyze', jobId: 'j2', file: clip(), options: { prefer: 'auto' }, port: ch.port2 });
  await w.until(() => w.final('j2'));
  const sources = w.of('j2').filter(r => r.type === 'hf-source');
  assert.deepEqual(sources.map(s => s.meta.path), ['codec', 'memory']);
  assert.deepEqual([sources[1].fallback.path, sources[1].fallback.code], ['codec', 'decode']);
  assert.equal(w.final('j2').type, 'hf-result');
  assert.equal(w.of('j2').filter(ends).length, 1);
  await served;   // the element source closed the port at the end
  noCodecs();
});

test('a new hf-analyze cancels the running job, hf-cancel stops only its own job, and each job ends once', async () => {
  codecs({ delayMs: 12 });
  const w = await hfWorker(), file = clip(48);
  w.post({ type: 'hf-analyze', jobId: 'a', file, options: { prefer: 'codec' } });
  await w.until(() => w.of('a').some(r => r.type === 'hf-progress' && r.phase === 'scan'));
  w.post({ type: 'hf-cancel', jobId: 'someone-else' });
  await tick(40);
  assert.equal(w.final('a'), undefined, 'a cancel for another job is ignored');
  w.post({ type: 'hf-analyze', jobId: 'b', file, options: { prefer: 'codec' } });
  await w.until(() => w.final('a') && w.final('b'));
  assert.deepEqual([w.final('a').type, w.final('a').code], ['hf-error', 'aborted']);
  assert.equal(w.final('b').type, 'hf-result');
  w.post({ type: 'hf-analyze', jobId: 'c', file, options: { prefer: 'codec' } });
  await w.until(() => w.of('c').length);
  w.post({ type: 'hf-cancel', jobId: 'c' });
  await w.until(() => w.final('c'));
  assert.deepEqual([w.final('c').type, w.final('c').code], ['hf-error', 'aborted']);
  for (const id of ['a', 'b', 'c']) assert.equal(w.of(id).filter(ends).length, 1, id);
  noCodecs();
});

test('hf failures come back once with a code: no file, no job id, an unknown message, an unreadable clip', async () => {
  noCodecs();
  const w = await hfWorker();
  const run = async (m, id = m.jobId) => { w.post(m); await w.until(() => w.final(id)); return w.final(id); };
  assert.equal((await run({ type: 'hf-analyze', jobId: 'nofile' })).code, 'unsupported');
  assert.equal((await run({ type: 'hf-analyze', file: clip() }, undefined)).code, 'internal');
  assert.deepEqual(await run({ type: 'hf-frob', jobId: 'odd' }), { type: 'hf-error', jobId: 'odd', code: 'internal', message: 'Unknown worker message "hf-frob". Use hf-analyze or hf-cancel.' });
  const bad = await run({ type: 'hf-analyze', jobId: 'bad', file: new Blob([new Uint8Array(64)]), options: { prefer: 'codec' } });
  assert.deepEqual([bad.type, bad.code], ['hf-error', 'unsupported']);
  // No WebCodecs and no element port in a worker: nothing can decode it.
  assert.equal((await run({ type: 'hf-analyze', jobId: 'noport', file: clip() })).code, 'unsupported');
  // The frame-fed protocol does not run hf.
  const send = await worker();
  assert.match(send({ type: 'init', width: 4, height: 4, engine: 'hf' })[0].error, /Tracking engine "hf" cannot run here\. Use v2 or legacy\./);
});

/* ---------------------------------------------------------------- analysis client */

/** A Worker-like object over dist/worker.js in this process; messages cross on a later tick, like postMessage. */
async function bridge() {
  const listeners = new Set(), scope = {}, w = { sent: [], terminated: false };
  scope.postMessage = m => setTimeout(() => { if (!w.terminated) for (const fn of [...listeners]) fn({ data: m }); }, 0);
  globalThis.self = scope;
  await import(`../dist/worker.js?test=${++instance}`);
  return Object.assign(w, {
    postMessage: m => { w.sent.push(m); setTimeout(() => { if (!w.terminated) scope.onmessage({ data: m }); }, 0); },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    emit: m => { for (const fn of [...listeners]) fn({ data: m }); },
    terminate: () => { w.terminated = true; }
  });
}
/** A scripted Worker-like object: onPost(message, worker) decides what it answers. */
function scripted(onPost = () => {}) {
  const listeners = { message: new Set(), error: new Set() }, w = { sent: [], terminated: false };
  return Object.assign(w, {
    postMessage: (m, transfer) => { w.sent.push(m); w.transfer = transfer; onPost(m, w); },
    addEventListener: (type, fn) => listeners[type]?.add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
    emit: m => { for (const fn of [...listeners.message]) fn({ data: m }); },
    fail: message => { for (const fn of [...listeners.error]) fn({ message }); },
    terminate: () => { w.terminated = true; }
  });
}
const sourceMeta = { path: 'codec', width: W, height: H, fps: 30, frameCount: 24, vfr: false, rotation: 0, hasAudio: false };

test('startAnalysis runs the worker to an HFResult, reports source and progress, ignores other jobs, then stops the worker and the server', async () => {
  codecs();
  const w = await bridge(), servers = [], sources = [], phases = [];
  const serve = (file, port, opts) => { servers.push(opts.signal); return serveElementFrames(memory(), port, opts); };
  const running = startAnalysis(clip(), { worker: () => w, serve, onSource: (meta, fallback) => sources.push([meta.path, fallback]), onProgress: p => phases.push(p.phase) });
  const job = w.sent[0].jobId;
  // Stale messages of another job must not reach the caller.
  w.emit({ type: 'hf-progress', jobId: 'stale', phase: 'stale', done: 0, total: 1 });
  w.emit({ type: 'hf-result', jobId: 'stale', result: 'not this one' });
  const result = await running;
  assert.match(job, /^hf-/);
  assert.deepEqual([w.sent[0].type, w.sent[0].options], ['hf-analyze', { prefer: 'auto', diagnostics: false }]);
  assert.ok(w.sent[0].port, 'the element fallback port goes with the job');
  assert.deepEqual(validateResult(result, { width: W, height: H, fps: 30 }), { ok: true, errors: [] });
  assert.deepEqual(sources, [['codec', null]]);
  assert.ok(!phases.includes('stale') && phases.at(-1) === 'done');
  assert.deepEqual([w.terminated, servers.length, servers[0].aborted], [true, 1, true]);
  noCodecs();
});

test('abort rejects at once; the worker gets hf-cancel for its job and is terminated when the job ends, or after the grace period', async () => {
  assert.equal(CANCEL_GRACE_MS, 2000);
  let server = null;
  const w = scripted((m, worker) => { if (m.type === 'hf-analyze') setTimeout(() => worker.emit({ type: 'hf-source', jobId: m.jobId, meta: sourceMeta }), 0); });
  const ac = new AbortController(), seen = [];
  const running = startAnalysis(new Blob(['x']), { worker: () => w, signal: ac.signal, onSource: m => seen.push(m.path), serve: (f, p, opts) => { server = opts.signal; return new Promise(() => {}); } });
  await tick(5);
  ac.abort();
  await assert.rejects(running, { name: 'AbortError' });
  const job = w.sent[0].jobId;
  assert.deepEqual(w.sent.slice(1), [{ type: 'hf-cancel', jobId: job }]);
  assert.deepEqual([seen, server.aborted, w.terminated], [['codec'], true, false]);
  w.emit({ type: 'hf-progress', jobId: job, phase: 'scan', done: 1, total: 2 });
  assert.equal(w.terminated, false);
  w.emit({ type: 'hf-error', jobId: job, code: 'aborted', message: 'aborted' });
  assert.equal(w.terminated, true);
  // A worker that never answers is terminated after the grace period.
  const mute = scripted(), stop = new AbortController();
  const quiet = startAnalysis(new Blob(['x']), { worker: () => mute, signal: stop.signal, prefer: 'codec', graceMs: 30 });
  stop.abort();
  await assert.rejects(quiet, { name: 'AbortError' });
  assert.equal(mute.terminated, false);
  await tick(60);
  assert.equal(mute.terminated, true);
  // An already aborted signal starts nothing.
  let made = 0;
  await assert.rejects(startAnalysis(new Blob(['x']), { worker: () => { made++; return scripted(); }, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(made, 0);
});

test('startAnalysis rejects worker errors with their code, stalls with a TimeoutError, and refuses other engines and decode paths', async () => {
  const answer = reply => scripted((m, w) => { if (m.type === 'hf-analyze') setTimeout(() => w.emit({ jobId: m.jobId, ...reply }), 0); });
  for (const [code, message] of [['unsupported', /could not be decoded in this browser/], ['decode', /Decoding failed partway/], ['internal', /internal error/], ['odd', /internal error/]]) {
    const w = answer({ type: 'hf-error', code, message: `no luck (${code})` });
    await assert.rejects(startAnalysis(new Blob(['x']), { worker: () => w, prefer: 'codec' }), e => e.name === 'AnalysisError' && e.code === code && message.test(e.message) && e.detail === `no luck (${code})`);
    assert.equal(w.terminated, true);
  }
  const crashing = scripted((m, w) => setTimeout(() => w.fail('boom'), 0));
  // A crashed worker is the engine failing, not the video: an internal AnalysisError.
  await assert.rejects(startAnalysis(new Blob(['x']), { worker: () => crashing, prefer: 'codec' }), e => /^The analysis worker failed: boom\.$/.test(e.message) && e.name === 'AnalysisError' && e.code === 'internal');
  assert.equal(crashing.terminated, true);
  const stalled = scripted();
  await assert.rejects(startAnalysis(new Blob(['x']), { worker: () => stalled, prefer: 'codec', stallMs: 25, graceMs: 10 }), { name: 'TimeoutError' });
  assert.deepEqual(stalled.sent.map(m => m.type), ['hf-analyze', 'hf-cancel']);
  // A throwing callback stops the job like an abort, with its own error.
  const chatty = answer({ type: 'hf-source', meta: sourceMeta });
  await assert.rejects(startAnalysis(new Blob(['x']), { worker: () => chatty, prefer: 'codec', graceMs: 10, onSource: () => { throw new Error('ui broke'); } }), /ui broke/);
  assert.equal(chatty.sent.at(-1).type, 'hf-cancel');
  await assert.rejects(startAnalysis(new Blob(['x']), { engine: 'v2' }), /runs the hf engine, not "v2"/);
  await assert.rejects(startAnalysis(new Blob(['x']), { prefer: 'gpu' }), /Unknown decode path "gpu"/);
});

test('only the codec preference goes without an element port; a server that cannot start refuses the open at once', async () => {
  const codec = scripted();
  startAnalysis(new Blob(['x']), { worker: () => codec, prefer: 'codec', stallMs: 20, graceMs: 5 }).catch(() => {});
  assert.deepEqual([codec.sent[0].port, codec.transfer], [undefined, []]);
  for (const prefer of ['auto', 'element']) {
    const w = scripted(), ac = new AbortController();
    const running = startAnalysis(new Blob(['x']), { worker: () => w, prefer, signal: ac.signal, graceMs: 5, serve: () => Promise.reject(new Error('no element source here')) });
    const { port, jobId } = w.sent[0];
    assert.deepEqual(w.transfer, [port]);
    await assert.rejects(RemoteFrameSource.open(port, { jobId }), e => e.code === 'unsupported' && /fallback decoder could not start: no element source here/.test(e.message));
    ac.abort();
    await assert.rejects(running, { name: 'AbortError' });
    port.close();
  }
  await tick(30);
});

/* ---------------------------------------------------------------- dist/hf revalidation across a build change */

const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
/** fetch stand-in: records [url, cache mode]; with hold, the response bodies arrive only on release(). */
function fakeFetch({ fail = false, hold = false } = {}) {
  const calls = [], waiting = [];
  const fetch = (url, init) => {
    calls.push([String(url), init?.cache]);
    if (fail) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, arrayBuffer: () => hold ? new Promise(r => waiting.push(r)) : Promise.resolve(new ArrayBuffer(0)) });
  };
  return { fetch, calls, pending: () => waiting.length, release: () => waiting.splice(0).forEach(r => r(new ArrayBuffer(0))) };
}

test('refreshHF revalidates every dist/hf file once per build, with a conditional request, before saying done', async () => {
  const net = fakeFetch({ hold: true }), store = memStore({ [HF_BUILD_KEY]: '53' }), base = new URL('https://app.test/hf/');
  const refresh = hfRefresher({ build: '54', base, fetch: net.fetch, store });
  const first = refresh(), again = refresh();
  assert.ok(first instanceof Promise && again === first, 'calls during a refresh share it');
  assert.deepEqual(net.calls, HF_FILES.map(f => [`https://app.test/hf/${f}`, 'no-cache']));
  await tick();
  assert.equal(net.pending(), HF_FILES.length);
  assert.equal(store.getItem(HF_BUILD_KEY), '53', 'not done before every body is in');
  net.release();
  assert.equal(await first, true);
  assert.equal(store.getItem(HF_BUILD_KEY), '54');
  assert.equal(refresh(), null, 'done for this build');
  // Another page of the same build (a new refresher, the same storage) does nothing; the next build refreshes again.
  assert.equal(hfRefresher({ build: '54', base, fetch: net.fetch, store })(), null);
  const next = hfRefresher({ build: '55', base, fetch: net.fetch, store })();
  assert.ok(next instanceof Promise);
  await tick(); net.release();
  assert.equal(await next, true);
  assert.deepEqual([net.calls.length, store.getItem(HF_BUILD_KEY)], [2 * HF_FILES.length, '55']);
});

test('refreshHF does nothing without a build version or fetch, retries after a network failure, and copes without storage', async () => {
  const net = fakeFetch(), base = new URL('https://app.test/hf/');
  assert.equal(hfRefresher({ build: null, base, fetch: net.fetch, store: memStore() })(), null);
  assert.equal(hfRefresher({ build: '54', base, fetch: 'not a function', store: memStore() })(), null);
  assert.equal(net.calls.length, 0);
  // This module was loaded without ?v=: the page's refresher is off (tests and the bench's unversioned loads).
  assert.equal(refreshHF(), null);
  const down = fakeFetch({ fail: true }), store = memStore(), flaky = hfRefresher({ build: '54', base, fetch: down.fetch, store });
  assert.equal(await flaky(), false);
  assert.equal(store.getItem(HF_BUILD_KEY), null);
  assert.ok(flaky() instanceof Promise, 'a failed refresh is tried again by the next job');
  // No storage, or storage that throws (blocked): this page remembers the build instead.
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  for (const store of [null, blocked]) {
    const refresh = hfRefresher({ build: '54', base, fetch: net.fetch, store });
    assert.equal(await refresh(), true);
    assert.equal(refresh(), null);
  }
});

test('startAnalysis starts the worker only once the refresh is done; an abort meanwhile starts nothing; a stuck refresh times out', async () => {
  let made = 0, done;
  const w = scripted((m, worker) => { if (m.type === 'hf-analyze') setTimeout(() => worker.emit({ type: 'hf-result', jobId: m.jobId, result: 'ok' }), 0); });
  const running = startAnalysis(new Blob(['x']), { worker: () => { made++; return w; }, prefer: 'codec', refresh: () => new Promise(r => { done = r; }) });
  await tick(5);
  assert.equal(made, 0, 'no worker while dist/hf is revalidated');
  done(true);
  assert.equal(await running, 'ok');
  assert.equal(made, 1);
  // Cancel during the refresh: rejects at once, and no worker or element server ever starts.
  const ac = new AbortController();
  let served = 0;
  const cancelled = startAnalysis(new Blob(['x']), { worker: () => { made++; return scripted(); }, serve: () => { served++; return new Promise(() => {}); }, signal: ac.signal, refresh: () => new Promise(r => { done = r; }) });
  ac.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  done(true); await tick(5);
  assert.deepEqual([made, served], [1, 0]);
  // A refresh that never settles holds the job for refreshMs at most.
  assert.equal(REFRESH_MS, 10000);
  const late = scripted((m, worker) => { if (m.type === 'hf-analyze') setTimeout(() => worker.emit({ type: 'hf-result', jobId: m.jobId, result: 'late' }), 0); });
  assert.equal(await startAnalysis(new Blob(['x']), { worker: () => late, prefer: 'codec', refresh: () => new Promise(() => {}), refreshMs: 20 }), 'late');
});
