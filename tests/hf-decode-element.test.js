import test from 'node:test';
import assert from 'node:assert/strict';
import { HFError, createMemorySource, poolLuma, cropLuma, coarsePool, check } from '../dist/hf/types.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import {
  ElementFrameSource, RemoteFrameSource, serveElementFrames, hasDom, snapSourceFps, sourceFrameSchedule, medianFrameInterval, frameCentre
} from '../dist/hf/decode/element-source.js';
import { demuxMp4 } from '../dist/hf/decode/mp4-demux.js';
import { writeMp4, gopOrder } from './hf/helpers/mp4-writer.mjs';
import { fakeDom, upright } from './hf/helpers/fake-dom.mjs';

const isCode = code => e => e instanceof HFError && e.code === code;
const same = (a, b, msg) => { assert.equal(a.length, b.length, `${msg}: length`); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${msg}: element ${i} ${a[i]} != ${b[i]}`); };
const range = (a, b, s = 1) => { const r = []; for (let k = a; k < b; k += s) r.push(k); return r; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ---------------------------------------------------------------- phase-1 timing helpers */

test('snapSourceFps snaps to common rates within 3% and falls back to decode.fallbackFps', () => {
  assert.equal(snapSourceFps(29.97), 29.97);
  assert.equal(snapSourceFps(30.6), 30);
  assert.equal(snapSourceFps(59.2), 59.94);
  assert.equal(snapSourceFps(238), 240);
  assert.equal(snapSourceFps(41.234), 41.23);
  assert.equal(snapSourceFps(0), PARAMS.decode.fallbackFps);
  assert.equal(snapSourceFps(NaN, 25), 25);
});

test('frame centres: (t_k + t_k+1)/2, and half a frame after the last; sourceFrameSchedule hits every distinct frame once', () => {
  const times = [0, 0.04, 0.07, 0.1];
  assert.ok(near(frameCentre(times, 0, 30), 0.02));
  assert.ok(near(frameCentre(times, 1, 30), 0.055));
  assert.ok(near(frameCentre(times, 3, 30), 0.1 + 1 / 60));
  const s = sourceFrameSchedule(1, 60, 30);
  assert.equal(s.length, 30);
  assert.deepEqual(s.slice(0, 3).map(e => e.index), [0, 2, 4]);
  assert.ok(near(s[1].t, 2.5 / 60));
  assert.equal(sourceFrameSchedule(0.5, 30).length, 15);
  assert.deepEqual(sourceFrameSchedule(0, 30), []);
});

test('medianFrameInterval divides out callbacks missed between presentations', () => {
  const f = [{ mediaTime: 0, presentedFrames: 1 }, { mediaTime: 1 / 30, presentedFrames: 2 }, { mediaTime: 3 / 30, presentedFrames: 4 }, { mediaTime: 4 / 30, presentedFrames: 5 }];
  assert.ok(near(medianFrameInterval(f), 1 / 30));
  assert.equal(medianFrameInterval([f[0]]), null);
});

/* ---------------------------------------------------------------- the port protocol (Node MessageChannel) */

const plane = (k, w, h) => Uint8Array.from({ length: w * h }, (_, i) => (k * 17 + i * 3) & 255);
const memory = (n = 9, w = 12, h = 8, extra = {}) => createMemorySource({ width: w, height: h, frames: Array.from({ length: n }, (_, k) => plane(k, w, h)), fps: 30, ...extra });
async function pair(source, opts = {}) {
  const ch = new MessageChannel(), served = serveElementFrames(source, ch.port1, opts.serve);
  const remote = await RemoteFrameSource.open(ch.port2, opts.open);
  return { ch, served, remote, done: async () => { await remote.close(); await served; ch.port2.close(); } };
}

test('RemoteFrameSource mirrors the served source: meta, frames, times and pixels', async () => {
  const src = memory(), { remote, done } = await pair(src);
  assert.deepEqual(check('SourceMeta', remote.meta), []);
  assert.deepEqual([...remote.meta.times], [...src.meta.times]);
  for (const opts of [{}, { from: 2, to: 7, stride: 2 }, { from: 8 }, { from: -3, to: 2 }, { from: 5, to: 5 }]) {
    const got = [];
    for await (const ref of remote.frames(opts)) {
      assert.equal(ref.t, src.meta.times[ref.index]);
      same((await ref.lumaRect({ x: 0, y: 0, w: 12, h: 8 })).data, plane(ref.index, 12, 8), `frame ${ref.index}`);
      same((await ref.lumaCoarse(6)).data, poolLuma(plane(ref.index, 12, 8), 12, 8, coarsePool(12, 8, 6)).data, `coarse ${ref.index}`);
      same((await ref.lumaRect({ x: -2, y: 3, w: 7, h: 9 }, { pool: 2 })).data, cropLuma(plane(ref.index, 12, 8), 12, 8, { x: -2, y: 3, w: 7, h: 9 }, 2).data, 'crop');
      got.push(ref.index);
    }
    const a = Math.max(0, opts.from ?? 0), b = Math.min(9, opts.to ?? 9);
    assert.deepEqual(got, range(a, b, opts.stride ?? 1), JSON.stringify(opts));
  }
  await done();
});

test('credit: at most decode.elementCredit frames are in flight before an ack', async () => {
  const src = memory(20), ch = new MessageChannel(), served = serveElementFrames(src, ch.port1);
  let received = 0, acked = 0, maxOutstanding = 0;
  ch.port2.addEventListener('message', ({ data }) => { if (data.type === 'frame') { received++; maxOutstanding = Math.max(maxOutstanding, received - acked); } });
  const post = ch.port2.postMessage.bind(ch.port2);
  ch.port2.postMessage = (m, t) => { if (m.type === 'ack') acked += m.n; post(m, t); };
  const remote = await RemoteFrameSource.open(ch.port2);
  for await (const ref of remote.frames()) await new Promise(r => setTimeout(r, 3 + (ref.index % 3)));
  assert.equal(received, 20);
  assert.ok(maxOutstanding <= PARAMS.decode.elementCredit, `outstanding ${maxOutstanding}`);
  assert.ok(maxOutstanding >= 1);
  await remote.close(); await served; ch.port2.close();
});

test('an abandoned iteration is stopped, and the next one starts clean', async () => {
  const { remote, done } = await pair(memory(30));
  for await (const ref of remote.frames()) if (ref.index === 2) break;
  const got = [];
  for await (const ref of remote.frames({ from: 10, to: 14 })) got.push(ref.index);
  assert.deepEqual(got, [10, 11, 12, 13]);
  // Two quick abandoned iterations back to back.
  for (let i = 0; i < 2; i++) { const it = remote.frames({ from: i })[Symbol.asyncIterator](); await it.next(); await it.return(); }
  const all = [];
  for await (const ref of remote.frames()) all.push(ref.index);
  assert.deepEqual(all, range(0, 30));
  await done();
});

test('errors cross the port with their codes; busy, closed, abort and stale jobIds', async () => {
  // A served source that fails at frame 3.
  const base = memory(8), failing = { meta: base.meta, close: () => base.close(), frames: async function* (o) { for await (const r of base.frames(o)) { if (r.index === 3) throw new HFError('decode', 'boom'); yield r; } } };
  let { remote, done } = await pair(failing);
  const seen = [];
  await assert.rejects((async () => { for await (const ref of remote.frames()) seen.push(ref.index); })(), e => isCode('decode')(e) && /boom/.test(e.message));
  assert.deepEqual(seen, [0, 1, 2]);
  const it = remote.frames()[Symbol.asyncIterator]();
  await it.next();
  await assert.rejects(remote.frames().next(), isCode('busy'));
  await it.return();
  const ac = new AbortController();
  await assert.rejects((async () => { for await (const ref of remote.frames({ signal: ac.signal })) if (ref.index === 1) ac.abort(); })(), e => e.name === 'AbortError');
  await assert.rejects(remote.frames({ stride: -1 }).next(), isCode('bad-arg'));
  await done();
  await assert.rejects(remote.frames().next(), isCode('closed'));
  // Open failures: in Node a Blob cannot be played (no DOM), so the server reports 'unsupported'.
  const ch = new MessageChannel(), served = serveElementFrames(new Blob([new Uint8Array(4)]), ch.port1);
  await assert.rejects(RemoteFrameSource.open(ch.port2), isCode('unsupported'));
  ch.port2.postMessage({ type: 'close' }); ch.port2.close(); await served;
  // Messages for another job (or a stale iteration) are ignored.
  let chan;
  ({ remote, done, ch: chan } = await pair(memory(4), { open: { jobId: 'job-a' } }));
  const forged = { type: 'frame', iter: 1, index: 0, t: 0, mediaTime: null, w: 12, h: 8 };
  chan.port1.postMessage({ ...forged, jobId: 'job-b', luma: new Uint8Array(96).fill(255).buffer });
  chan.port1.postMessage({ ...forged, jobId: 'job-a', iter: 99, luma: new Uint8Array(96).fill(255).buffer });
  await new Promise(r => setTimeout(r, 5));
  const got = [];
  for await (const ref of remote.frames()) { got.push(ref.index); same((await ref.lumaRect({ x: 0, y: 0, w: 12, h: 8 })).data, plane(ref.index, 12, 8), `job frame ${ref.index}`); }
  assert.deepEqual(got, [0, 1, 2, 3]);
  await done();
  await assert.rejects(RemoteFrameSource.open(null), isCode('bad-arg'));
});

test('serveElementFrames resolves on close or abort and closes what it opened', async () => {
  let closed = 0;
  const src = memory(3), wrapped = { meta: src.meta, frames: o => src.frames(o), close: async () => { closed++; } };
  const ch = new MessageChannel(), ac = new AbortController(), served = serveElementFrames(wrapped, ch.port1, { signal: ac.signal });
  const remote = await RemoteFrameSource.open(ch.port2);
  ac.abort();
  await served;
  assert.equal(closed, 1);
  ch.port2.close();
  assert.ok(remote);
});

/* ---------------------------------------------------------------- ElementFrameSource on a fake DOM */

async function element({ n = 12, gop = 12, bf = 0, rotation = 0, cw = 16, ch = 12, mp4 = true, dom = {}, params } = {}) {
  const bytes = writeMp4({ samples: gopOrder(n, { gop, bf }), width: cw, height: ch, rotation });
  const blob = mp4 ? new Blob([bytes]) : new Blob(['not a video']), info = await demuxMp4(new Blob([bytes]));
  const fake = fakeDom({ times: info.times, cw, ch, rotation, ...dom });
  const src = await ElementFrameSource.open(blob, { env: fake.env, ...(params ? { params } : {}) });
  return { src, fake, info, times: info.times };
}
async function read(src) {
  const out = [];
  for await (const ref of src.frames()) out.push({ index: ref.index, t: ref.t, mediaTime: ref.mediaTime, verified: ref.verified, luma: (await ref.lumaRect({ x: 0, y: 0, w: src.meta.width, h: src.meta.height })).data });
  return out;
}

test('ElementFrameSource seeks to frame centres and yields every frame verified by its mediaTime', async () => {
  const { src, fake, times } = await element({ n: 12 });
  assert.equal(src.meta.path, 'element');
  assert.deepEqual(check('SourceMeta', src.meta), []);
  const seeks0 = fake.log.seeks.length, frames = await read(src);
  assert.deepEqual(frames.map(f => f.index), range(0, 12));
  frames.forEach(f => { assert.equal(f.t, times[f.index]); assert.equal(f.mediaTime, times[f.index]); assert.equal(f.verified, true); same(f.luma, upright(f.index, 16, 12, 0), `pixels ${f.index}`); });
  const targets = fake.log.seeks.slice(seeks0);
  assert.equal(targets.length, 12, 'one seek per frame');
  targets.forEach((t, k) => assert.ok(near(t, frameCentre(times, k, src.meta.fps)), `target ${k}: ${t}`));
  assert.equal(src.stats.retries, 0);
  assert.equal(src.stats.readback, 'canvas');
  await src.close();
  assert.equal(fake.log.removed, 1);
  assert.equal(fake.log.revoked.length, 1);
});

test('a repeated (stale) mediaTime gets one re-seek nudged forward by decode.dupNudgeFrac·Δ', async () => {
  const stale = new Set([4, 7]), first = new Set();
  // The first seek into frames 4 and 7 still shows the previous frame.
  const seekMap = (t, cur, n, times = seekMap.times) => { let k = 0; for (let i = 0; i < n; i++) if (times[i] <= t + 1e-9) k = i; if (stale.has(k) && !first.has(k)) { first.add(k); return k - 1; } return k; };
  const bytes = writeMp4({ samples: gopOrder(10, { gop: 10, bf: 0 }), width: 16, height: 12 }), info = await demuxMp4(new Blob([bytes]));
  seekMap.times = info.times;
  const fake = fakeDom({ times: info.times, cw: 16, ch: 12, seekMap: (t, c, n) => seekMap(t, c, n) });
  for (const frac of [PARAMS.decode.dupNudgeFrac, 0.4]) {
    first.clear();
    const src = await ElementFrameSource.open(new Blob([bytes]), { env: fake.env, params: mergeParams({ decode: { dupNudgeFrac: frac } }) });
    const s0 = fake.log.seeks.length, frames = await read(src), seeks = fake.log.seeks.slice(s0);
    assert.deepEqual(frames.map(f => [f.index, f.verified]), range(0, 10).map(k => [k, true]));
    frames.forEach(f => same(f.luma, upright(f.index, 16, 12, 0), `frame ${f.index}`));
    assert.equal(src.stats.retries, 2);
    assert.equal(seeks.length, 12);
    const dt = 1 / 30, retryOf4 = seeks[5];
    assert.ok(near(retryOf4, frameCentre(info.times, 4, 30) + frac * dt), `nudge ${retryOf4} for frac ${frac}`);
    await src.close();
  }
});

test('frames a seek cannot reach (it lands on the next keyframe) are caught during slow playback', async () => {
  // Like Chrome on open-GOP HEVC: seeks into frames 10 and 11 present keyframe 12.
  const bytes = writeMp4({ samples: gopOrder(24, { gop: 12, bf: 0 }), width: 16, height: 12 }), info = await demuxMp4(new Blob([bytes]));
  const shown = t => { let k = 0; for (let i = 0; i < 24; i++) if (info.times[i] <= t + 1e-9) k = i; return k; };
  const fake = fakeDom({ times: info.times, cw: 16, ch: 12, seekMap: t => { const k = shown(t); return k === 10 || k === 11 ? 12 : k; } });
  const src = await ElementFrameSource.open(new Blob([bytes]), { env: fake.env });
  const frames = await read(src);
  assert.deepEqual(frames.map(f => [f.index, f.verified, f.mediaTime]), range(0, 24).map(k => [k, true, info.times[k]]));
  frames.forEach(f => same(f.luma, upright(f.index, 16, 12, 0), `frame ${f.index}`));
  assert.equal(src.stats.rescued, 2);
  assert.equal(src.stats.unverified, 0);
  assert.equal(fake.log.plays.length, 2);
  assert.ok(fake.log.plays.every(r => near(r, 20 / 30, 1e-12)), `slow playback rate ${fake.log.plays}`);
  assert.ok(fake.video().paused);
  await src.close();
});

test('a frame that cannot be presented at all is yielded unverified, not dropped', async () => {
  const bytes = writeMp4({ samples: gopOrder(8, { gop: 8, bf: 0 }), width: 16, height: 12 }), info = await demuxMp4(new Blob([bytes]));
  const shown = t => { let k = 0; for (let i = 0; i < 8; i++) if (info.times[i] <= t + 1e-9) k = i; return k; };
  const fake = fakeDom({ times: info.times, cw: 16, ch: 12, seekMap: t => (shown(t) === 5 ? 6 : shown(t)) });
  // Playback also skips frame 5 (no frame 5 is ever presented).
  const src = await ElementFrameSource.open(new Blob([bytes]), { env: fake.env });
  const v = fake.video(), present = v._present.bind(v);
  v._present = function () { if (this._k === 5) this._k = 6; present(); };
  const frames = await read(src);
  assert.deepEqual(frames.map(f => f.index), range(0, 8));
  assert.equal(frames[5].verified, false);
  assert.equal(src.stats.unverified, 1);
  assert.ok(frames.filter(f => f.index !== 5).every(f => f.verified));
  await src.close();
});

test('without rVFC frames are still yielded at container times, unverified (null)', async () => {
  const { src } = await element({ n: 6, dom: { rvfc: false } });
  const frames = await read(src);
  assert.deepEqual(frames.map(f => [f.index, f.verified, f.mediaTime]), range(0, 6).map(k => [k, null, null]));
  frames.forEach(f => same(f.luma, upright(f.index, 16, 12, 0), `frame ${f.index}`));
  assert.equal(src.stats.noRvfc, 6);
});

test('decode.rvfcWaitMs bounds the wait for a presented frame; decode.seekTimeoutMs bounds a seek', async () => {
  const bytes = writeMp4({ samples: gopOrder(4, { gop: 4, bf: 0 }), width: 16, height: 12 }), info = await demuxMp4(new Blob([bytes]));
  // rVFC exists but never fires: each frame waits rvfcWaitMs, then is yielded unverified.
  const quiet = fakeDom({ times: info.times, cw: 16, ch: 12 });
  const P = mergeParams({ decode: { rvfcWaitMs: 15 } }), src = await ElementFrameSource.open(new Blob([bytes]), { env: quiet.env, params: P });
  quiet.video()._present = function () { this._presented++; };
  const t0 = performance.now(), frames = await read(src), ms = performance.now() - t0;
  assert.deepEqual(frames.map(f => [f.index, f.verified]), range(0, 4).map(k => [k, null]));
  assert.ok(ms >= 4 * 15 * 0.8 && ms < 2000, `${ms.toFixed(0)} ms for 4 frames at 15 ms`);
  // A seek that never completes rejects with HFError decode after seekTimeoutMs.
  const stuck = fakeDom({ times: info.times, cw: 16, ch: 12 });
  const S = mergeParams({ decode: { seekTimeoutMs: 40 } }), slow = await ElementFrameSource.open(new Blob([bytes]), { env: stuck.env, params: S });
  Object.defineProperty(stuck.video(), 'currentTime', { set() {}, get() { return 0; } });
  await assert.rejects(slow.frames().next(), e => isCode('decode')(e) && /timed out/.test(e.message));
});

test('VideoFrame readback gives the decoder Y plane (range-expanded, rotated) identical to the canvas path', async () => {
  for (const rotation of [0, 90, 270]) {
    const { src, fake } = await element({ n: 5, rotation, dom: { videoFrame: true } });
    assert.equal(src.stats.readback, 'videoframe');
    assert.deepEqual([src.meta.width, src.meta.height, src.meta.rotation], rotation % 180 ? [12, 16, rotation] : [16, 12, 0]);
    const frames = await read(src);
    frames.forEach(f => same(f.luma, upright(f.index, 16, 12, rotation), `rotation ${rotation} frame ${f.index}`));
    assert.equal(fake.log.videoFrames, 5);
    assert.equal(fake.log.draws, 0);
  }
  // An unreadable VideoFrame format switches to the canvas for good.
  const { src, fake } = await element({ n: 4, dom: { videoFrame: true, frameFormat: null } });
  const frames = await read(src);
  frames.forEach(f => same(f.luma, upright(f.index, 16, 12, 0), `fallback frame ${f.index}`));
  assert.equal(src.stats.readback, 'canvas');
  assert.ok(fake.log.draws >= 4);
});

test('without a parsable moov the frame rate comes from an rVFC playback probe', async () => {
  const { src, fake } = await element({ n: 30, mp4: false });
  assert.match(src.stats.demux, /no-moov/);
  assert.ok(near(src.meta.fps, 30, 1e-9), `fps ${src.meta.fps}`);
  assert.equal(src.meta.frameCount, 30);
  assert.ok(fake.log.plays.length >= 1, 'probed by playing');
  const frames = await read(src);
  assert.deepEqual(frames.map(f => f.index), range(0, 30));
  assert.ok(frames.every(f => f.verified));
  frames.forEach(f => same(f.luma, upright(f.index, 16, 12, 0), `frame ${f.index}`));
});

test('ElementFrameSource: load errors, no DOM, busy, closed and abort', async () => {
  const bytes = writeMp4({ samples: gopOrder(4, { gop: 4, bf: 0 }), width: 16, height: 12 }), info = await demuxMp4(new Blob([bytes]));
  await assert.rejects(ElementFrameSource.open(new Blob([bytes]), { env: fakeDom({ times: info.times, cw: 16, ch: 12, failLoad: true }).env }), isCode('unsupported'));
  await assert.rejects(ElementFrameSource.open(new Blob([bytes])), isCode('unsupported'), 'Node has no DOM');
  assert.equal(hasDom(), false);
  const { src } = await element({ n: 6 });
  const it = src.frames()[Symbol.asyncIterator]();
  await it.next();
  await assert.rejects(src.frames().next(), isCode('busy'));
  await it.return();
  const ac = new AbortController();
  await assert.rejects((async () => { for await (const ref of src.frames({ signal: ac.signal })) if (ref.index === 2) ac.abort(); })(), e => e.name === 'AbortError');
  await src.close();
  await assert.rejects(src.frames().next(), isCode('closed'));
});

test('serveElementFrames opens an ElementFrameSource from a blob and streams it to the worker side', async () => {
  const bytes = writeMp4({ samples: gopOrder(6, { gop: 6, bf: 0 }), width: 16, height: 12, rotation: 90 }), info = await demuxMp4(new Blob([bytes]));
  const fake = fakeDom({ times: info.times, cw: 16, ch: 12, rotation: 90 });
  const ch = new MessageChannel(), served = serveElementFrames(new Blob([bytes]), ch.port1, { env: fake.env });
  const remote = await RemoteFrameSource.open(ch.port2);
  assert.deepEqual([remote.meta.path, remote.meta.width, remote.meta.height, remote.meta.rotation], ['element', 12, 16, 90]);
  const got = [];
  for await (const ref of remote.frames()) { got.push([ref.index, ref.verified]); same((await ref.lumaRect({ x: 0, y: 0, w: 12, h: 16 })).data, upright(ref.index, 16, 12, 90), `frame ${ref.index}`); }
  assert.deepEqual(got, range(0, 6).map(k => [k, true]));
  assert.equal(remote.stats.seeks >= 6, true, 'stats arrive with the end of the iteration');
  await remote.close(); await served; ch.port2.close();
  assert.equal(fake.log.removed, 1, 'the server closed the element source');
});
