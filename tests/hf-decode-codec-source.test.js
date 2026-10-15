import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { HFError, poolLuma, cropLuma, coarsePool, createMemorySource, check } from '../dist/hf/types.js';
import { PARAMS, mergeParams } from '../dist/hf/params.js';
import { CodecFrameSource, openFrameSource } from '../dist/hf/decode/codec-source.js';
import { serveElementFrames, RemoteFrameSource, releaseElementPort } from '../dist/hf/decode/element-source.js';
import { demuxMp4 } from '../dist/hf/decode/mp4-demux.js';
import { lumaLut, rotatePlane, rgbaToLuma } from '../dist/hf/decode/planes.js';
import { displaySize } from '../dist/hf/decode/orient.js';
import { writeMp4, gopOrder } from './hf/helpers/mp4-writer.mjs';
import { fakeWebCodecs } from './hf/helpers/fake-webcodecs.mjs';
import { ffmpegOk, buildFixtures, decodeCoded, probeStream, fnv } from './hf/helpers/decode-fixtures.mjs';
import { openNodeSource } from './hf/helpers/node-source.mjs';

const isCode = code => e => e instanceof HFError && e.code === code;
const same = (a, b, msg) => { assert.equal(a.length, b.length, `${msg}: length`); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${msg}: element ${i} ${a[i]} != ${b[i]}`); };

/** Coded picture k: 8- or 10-bit Y (or RGBA) with a per-frame pattern. */
function picture(k, cw, ch, format) {
  const n = cw * ch, f = (x, y) => (k * 37 + x * 3 + y * 5 + ((x * y) % 13) * 9) & 255;
  if (format === 'RGBX' || format === 'BGRX') {
    const rgba = new Uint8Array(4 * n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const p = 4 * (y * cw + x); rgba[p] = f(x, y); rgba[p + 1] = (f(x, y) * 3) & 255; rgba[p + 2] = (255 - f(x, y)); rgba[p + 3] = 255; }
    return { rgba };
  }
  const y = format === 'I420P10' ? new Uint16Array(n) : new Uint8Array(n);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) y[j * cw + i] = format === 'I420P10' ? 4 * f(i, j) + ((i + j) & 3) : f(i, j);
  return { y };
}
/** What every source must deliver for frame k: the upright full-range luma plane. */
function expected(k, cw, ch, rotation, format, limited) {
  const pic = picture(k, cw, ch, format);
  let y8;
  if (pic.rgba) y8 = rgbaToLuma(pic.rgba, cw, ch, { hd: true, bgr: format === 'BGRX' });
  else { const lut = lumaLut(format === 'I420P10' ? 10 : 8, limited) ?? Uint8Array.from({ length: 256 }, (_, i) => i); y8 = Uint8Array.from(pic.y, v => lut[v]); }
  const r = rotatePlane(y8, cw, ch, rotation);
  return { data: r.data, W: r.w, H: r.h };
}

/** A written MP4 plus a fake decoder that renders picture(k) for the frame with presentation index k. */
async function setup({ n = 30, gop = 12, bf = 2, openGop = false, rotation = 0, cw = 64, ch = 48, format = 'I420', colorSpace, edits, colr, fake = {}, visibleRect, write = {} } = {}) {
  const order = gopOrder(n, { gop, bf, openGop }), bytes = writeMp4({ samples: order, width: cw, height: ch, rotation, edits, colr, ...write });
  const blob = new Blob([bytes]), info = await demuxMp4(blob, { fragments: true });
  const byTs = new Map([...info.times].map((t, k) => [Math.round(t * 1e6), k]));
  const wc = fakeWebCodecs({
    format, codedWidth: cw + (visibleRect ? 16 : 0), codedHeight: ch + (visibleRect ? 16 : 0), visibleRect, colorSpace,
    render: ts => { const k = byTs.get(ts) ?? 0, p = picture(k, cw + (visibleRect ? 16 : 0), ch + (visibleRect ? 16 : 0), format); return p; }, ...fake
  });
  return { blob, info, wc, order };
}
async function collect(src, opts, each) {
  const out = [];
  for await (const ref of src.frames(opts)) { out.push(ref.index); if (each) await each(ref); }
  return out;
}
const range = (a, b, s = 1) => { const r = []; for (let k = a; k < b; k += s) r.push(k); return r; };

/* ---------------------------------------------------------------- frames and pixels */

test('every presented frame exactly once, in order, with container times (B-frames reordered by the decoder)', async () => {
  const { blob, info, wc } = await setup({ n: 30, gop: 12, bf: 2 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  assert.equal(src.meta.path, 'codec');
  assert.deepEqual(check('SourceMeta', src.meta), []);
  const times = [];
  assert.deepEqual(await collect(src, {}, ref => { times.push(ref.t); }), range(0, 30));
  assert.deepEqual(times, [...info.times]);
  assert.equal(wc.stats.live, 0, 'every VideoFrame closed');
  // Re-iterable.
  assert.deepEqual(await collect(src, { from: 5, to: 9 }), [5, 6, 7, 8]);
  await src.close();
});

test('lumaCoarse / lumaRect equal poolLuma / cropLuma of the upright full-range plane for every format and rotation', async () => {
  const cases = [['I420', 0], ['I420', 90], ['NV12', 180], ['I420', 270], ['I420P10', 90], ['RGBX', 270], ['BGRX', 0]];
  for (const [format, rotation] of cases) {
    const cw = 64, ch = 48, { blob, wc } = await setup({ n: 6, gop: 6, bf: 2, rotation, cw, ch, format });
    const src = await CodecFrameSource.open(blob, { webcodecs: wc });
    const { width: W, height: H } = displaySize(cw, ch, rotation);
    assert.deepEqual([src.meta.width, src.meta.height, src.meta.rotation], [W, H, rotation]);
    await collect(src, {}, async ref => {
      const exp = expected(ref.index, cw, ch, rotation, format, true), tag = `${format} rot ${rotation} frame ${ref.index}`;
      for (const longEdge of [64, 32, 21]) {
        const img = await ref.lumaCoarse(longEdge), want = poolLuma(exp.data, W, H, coarsePool(W, H, longEdge));
        assert.deepEqual([img.w, img.h, img.pool], [want.w, want.h, want.pool], tag);
        same(img.data, want.data, `${tag} coarse ${longEdge}`);
      }
      for (const [rect, pool] of [[{ x: 3, y: 5, w: 17, h: 11 }, 1], [{ x: -4, y: -3, w: 12, h: 10 }, 2], [{ x: W - 6, y: H - 5, w: 13, h: 9 }, 3], [{ x: 0, y: 0, w: W, h: H }, 1]]) {
        const got = await ref.lumaRect(rect, { pool }), want = cropLuma(exp.data, W, H, rect, pool);
        assert.deepEqual({ ...got, data: 0 }, { ...want, data: 0 }, `${tag} rect geometry`);
        same(got.data, want.data, `${tag} rect ${JSON.stringify(rect)}`);
      }
    });
    assert.equal(wc.stats.live, 0);
    await src.close();
  }
});

test('the visible rect sets the display size; padding rows of the coded frame are never read', async () => {
  const cw = 64, ch = 48, { blob, wc } = await setup({ n: 4, gop: 4, bf: 0, rotation: 90, cw, ch, visibleRect: { x: 0, y: 0, width: 64, height: 48 } });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  assert.deepEqual([src.meta.width, src.meta.height, src.meta.codedWidth, src.meta.codedHeight], [48, 64, 80, 64]);
  await collect(src, {}, async ref => {
    // The decoder picture is 80 × 64; the visible 64 × 48 corner of it is the image.
    const pic = picture(ref.index, 80, 64, 'I420'), lut = lumaLut(8, true), vis = new Uint8Array(64 * 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) vis[y * 64 + x] = lut[pic.y[y * 80 + x]];
    const up = rotatePlane(vis, 64, 48, 90);
    same((await ref.lumaCoarse(64)).data, poolLuma(up.data, 48, 64, 1).data, `frame ${ref.index}`);
  });
});

test('colour range: bitstream/container signal first, then the decoder report, else limited', async () => {
  const run = async (o, limited) => {
    const { blob, wc } = await setup({ n: 2, gop: 2, bf: 0, ...o });
    const src = await CodecFrameSource.open(blob, { webcodecs: wc });
    assert.equal(src.format.limited, limited, JSON.stringify(o));
    await collect(src, {}, async ref => same((await ref.lumaCoarse(64)).data, expected(ref.index, 64, 48, 0, 'I420', limited).data, 'pixels'));
  };
  await run({ colorSpace: { fullRange: false } }, true);
  await run({ colorSpace: { fullRange: true } }, false);
  await run({ colorSpace: {} }, true);
  await run({ colr: { fullRange: true }, colorSpace: { fullRange: false } }, false);
  await run({ colr: { fullRange: false }, colorSpace: { fullRange: true } }, true);
});

/* ---------------------------------------------------------------- decode windows */

test('frames({from, to, stride}) starts at the last keyframe shown at or before from and yields only the wanted frames', async () => {
  const { blob, info, wc } = await setup({ n: 40, gop: 12, bf: 2 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc }), tsOf = i => Math.round(info.samples[i].pts / info.timescale * 1e6);
  for (const [from, to, stride, keyIndex] of [[0, 40, 1, 0], [13, 20, 1, 12], [12, 13, 1, 12], [11, 30, 3, 0], [25, 26, 1, 24], [37, 40, 2, 36]]) {
    wc.stats.fed.length = 0;
    assert.deepEqual(await collect(src, { from, to, stride }), range(from, to, stride), `frames ${from}-${to}/${stride}`);
    const firstKey = info.order[keyIndex];
    assert.equal(wc.stats.fed[0], tsOf(firstKey), `from ${from}: decoding starts at keyframe ${keyIndex}`);
  }
  assert.deepEqual(await collect(src, { from: -5, to: 3 }), [0, 1, 2], 'clamped');
  assert.deepEqual(await collect(src, { from: 38, to: 99 }), [38, 39]);
  assert.deepEqual(await collect(src, { from: 9, to: 9 }), []);
  assert.equal(wc.stats.live, 0);
});

test('open GOP: leading pictures before a keyframe are reached by starting one GOP earlier', async () => {
  // Decode order ... I12 B10 B11 ...: B10 and B11 need the previous GOP; the fake drops them when decoding starts at I12.
  const { blob, wc } = await setup({ n: 36, gop: 12, bf: 2, openGop: true, fake: { openGop: true } });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  assert.deepEqual(await collect(src, { from: 10, to: 14 }), [10, 11, 12, 13]);
  assert.deepEqual(await collect(src, { from: 23, to: 24 }), [23]);
  assert.deepEqual(await collect(src), range(0, 36));
});

test('backpressure: decodeQueueSize stays within decode.maxDecodeQueue and few frames are held', async () => {
  const P = mergeParams({ decode: { maxDecodeQueue: 3, maxOpenFrames: 2 } });
  const { blob, wc } = await setup({ n: 40, gop: 20, bf: 2 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc, params: P });
  wc.stats.maxQueue = 0; wc.stats.maxLive = 0;
  assert.deepEqual(await collect(src, {}, () => new Promise(r => setTimeout(r, 5))), range(0, 40));
  assert.ok(wc.stats.maxQueue <= 3, `decode queue ${wc.stats.maxQueue}`);
  // Feeding pauses at maxOpenFrames waiting frames; what is already in the decoder can still land: the queued chunks
  // and, at the end-of-window flush, its reorder buffer (2 in the fake). Plus the frame being consumed.
  assert.ok(wc.stats.maxLive <= 2 + 3 + 2 + 1, `live frames ${wc.stats.maxLive}`);
  const loose = await CodecFrameSource.open(blob, { webcodecs: wc });
  wc.stats.maxQueue = 0;
  await collect(loose, {}, () => new Promise(r => setTimeout(r, 2)));
  assert.ok(wc.stats.maxQueue > 3 && wc.stats.maxQueue <= PARAMS.decode.maxDecodeQueue, `default cap ${wc.stats.maxQueue}`);
});

test('FrameRef: invalid after next() and after close(); concurrent reads share one copy', async () => {
  const { blob, wc } = await setup({ n: 6, gop: 6, bf: 0 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  const it = src.frames()[Symbol.asyncIterator]();
  const first = (await it.next()).value;
  wc.stats.copies.length = 0;
  const [a, b] = await Promise.all([first.lumaCoarse(64), first.lumaCoarse(32)]);
  assert.ok(a.w === 64 && b.w === 32);
  assert.equal(wc.stats.copies.filter(c => c.w === 64 && c.h === 48).length, 1, 'one full copy');
  await it.next();
  await assert.rejects(first.lumaCoarse(64), isCode('closed'));
  await assert.rejects(first.lumaRect({ x: 0, y: 0, w: 4, h: 4 }), isCode('closed'));
  first.close(); // idempotent
  await it.return();
  assert.equal(wc.stats.live, 0);
});

test('lumaRect copies only the even-aligned coded rect covering the request (rotated), or reuses the full copy', async () => {
  const { blob, wc } = await setup({ n: 3, gop: 3, bf: 0, rotation: 90, cw: 64, ch: 48 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  await collect(src, {}, async ref => {
    wc.stats.copies.length = 0;
    await ref.lumaRect({ x: 5, y: 9, w: 7, h: 6 });
    assert.equal(wc.stats.copies.length, 1);
    const c = wc.stats.copies[0];
    // Display rect X 5..11, Y 9..14 (W = 48, H = 64) is coded x = Y 9..14, y = 47 − X 36..42; even-aligned 8..16 × 36..44.
    assert.deepEqual(c, { x: 8, y: 36, w: 8, h: 8, full: false });
    await ref.lumaCoarse(48);
    const n = wc.stats.copies.length;
    await ref.lumaRect({ x: 1, y: 1, w: 9, h: 9 });
    assert.equal(wc.stats.copies.length, n, 'served from the full copy');
  });
});

test('rect copies refused by the browser fall back to full copies', async () => {
  const { blob, wc } = await setup({ n: 3, gop: 3, bf: 0, fake: { noRect: true } });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  await collect(src, {}, async ref => same((await ref.lumaRect({ x: 2, y: 2, w: 6, h: 6 })).data, cropLuma(expected(ref.index, 64, 48, 0, 'I420', true).data, 64, 48, { x: 2, y: 2, w: 6, h: 6 }).data, 'rect'));
  assert.equal(src.format.rectCopy, false);
});

/* ---------------------------------------------------------------- failures */

test('a decoder error mid-stream rejects with HFError decode and releases frames', async () => {
  const { blob, wc } = await setup({ n: 30, gop: 30, bf: 2, fake: { failAfter: 20 } });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  wc.stats.decoded = 0;
  const seen = [];
  await assert.rejects(collect(src, {}, ref => { seen.push(ref.index); }), isCode('decode'));
  assert.ok(seen.length > 5 && seen.length < 30);
  assert.equal(wc.stats.live, 0);
});

test('a frame the decoder never outputs rejects with HFError decode instead of hanging', async () => {
  const { blob, info, wc } = await setup({ n: 12, gop: 12, bf: 0 });
  wc.stats.decoded = 0;
  const lost = Math.round(info.times[7] * 1e6);
  const fake = fakeWebCodecs({ format: 'I420', codedWidth: 64, codedHeight: 48, dropTimestamps: [lost], render: () => picture(0, 64, 48, 'I420') });
  const src = await CodecFrameSource.open(blob, { webcodecs: fake });
  const seen = [];
  await assert.rejects(collect(src, {}, ref => { seen.push(ref.index); }), isCode('decode'));
  assert.deepEqual(seen, range(0, 7));
  assert.ok(wc);
});

test('abort, close during iteration, busy and bad arguments', async () => {
  const { blob, wc } = await setup({ n: 20, gop: 20, bf: 2 });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  const ac = new AbortController();
  await assert.rejects(collect(src, { signal: ac.signal }, ref => { if (ref.index === 3) ac.abort(); }), e => e.name === 'AbortError');
  assert.equal(wc.stats.live, 0);
  const it = src.frames()[Symbol.asyncIterator]();
  await it.next();
  await assert.rejects(src.frames().next(), isCode('busy'));
  await it.return();
  await assert.rejects(src.frames({ stride: 0 }).next(), isCode('bad-arg'));
  await assert.rejects(src.frames({ from: 1.5 }).next(), isCode('bad-arg'));
  const live = src.frames()[Symbol.asyncIterator]();
  await live.next();
  const pending = live.next();
  await src.close();
  await assert.rejects(pending.then(() => live.next()), isCode('closed'));
  await assert.rejects(src.frames().next(), isCode('closed'));
  assert.equal(wc.stats.live, 0);
});

test('open() rejects with the reason the codec path cannot be used', async () => {
  const { blob } = await setup({ n: 4, gop: 4, bf: 0 });
  const wc = o => fakeWebCodecs({ format: 'I420', codedWidth: 64, codedHeight: 48, render: () => picture(0, 64, 48, 'I420'), ...o });
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: {} }), isCode('unsupported'));
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: wc({ supported: false }) }), isCode('unsupported'));
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: wc({ configureThrows: true }) }), isCode('decode'));
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: wc({ failAfter: 0 }) }), isCode('decode'));
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: wc({ format: null }) }), isCode('unsupported'), 'canvas formats need OffscreenCanvas');
  const frag = await setup({ n: 4, gop: 4, bf: 0, write: { fragmented: true } });
  await assert.rejects(CodecFrameSource.open(frag.blob, { webcodecs: wc() }), isCode('fragmented'));
  const mp4v = new Blob([writeMp4({ samples: gopOrder(4, { gop: 4, bf: 0 }), entry: 'mp4v', config: null })]);
  await assert.rejects(CodecFrameSource.open(mp4v, { webcodecs: wc() }), isCode('unsupported'));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(CodecFrameSource.open(blob, { webcodecs: wc(), signal: ac.signal }), e => e.name === 'AbortError');
});

test('openFrameSource falls back to the element path over a port and records why', async () => {
  const served = () => createMemorySource({ width: 8, height: 6, frames: Array.from({ length: 5 }, (_, k) => new Uint8Array(48).fill(k * 10)) });
  const wc = fakeWebCodecs({ format: 'I420', codedWidth: 64, codedHeight: 48, render: () => picture(0, 64, 48, 'I420') });
  const frag = await setup({ n: 4, gop: 4, bf: 0, write: { fragmented: true } });
  for (const [what, file, webcodecs] of [['fragmented', frag.blob, wc], ['unsupported', frag.blob.slice(0, 0), wc], ['unsupported', (await setup({ n: 4 })).blob, {}]]) {
    const ch = new MessageChannel(), serving = serveElementFrames(served(), ch.port1);
    const src = await openFrameSource(file, { port: ch.port2, webcodecs });
    assert.equal(src.fallback.path, 'codec');
    assert.ok(what === 'fragmented' ? src.fallback.code === 'fragmented' : ['unsupported', 'no-moov'].includes(src.fallback.code), JSON.stringify(src.fallback));
    assert.deepEqual(await collect(src), [0, 1, 2, 3, 4]);
    await src.close();
    await serving;
    ch.port2.close();
  }
  const ok = await setup({ n: 4, gop: 4, bf: 0 });
  const direct = await openFrameSource(ok.blob, { webcodecs: ok.wc });
  assert.equal(direct.meta.path, 'codec');
  assert.equal(direct.fallback, undefined);
  await assert.rejects(openFrameSource(frag.blob, { prefer: 'codec', webcodecs: wc }), e => isCode('unsupported')(e) && e.failures[0].code === 'fragmented');
  await assert.rejects(openFrameSource(ok.blob, { prefer: 'element' }), isCode('unsupported'), 'no DOM and no port in Node');
  await assert.rejects(openFrameSource(ok.blob, { prefer: 'nope' }), isCode('bad-arg'));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(openFrameSource(ok.blob, { signal: ac.signal, webcodecs: ok.wc }), e => e.name === 'AbortError');
});

test('when the codec path wins, closing it releases the unused element port; an element retry opened first owns the port', { timeout: 20000 }, async () => {
  const ok = await setup({ n: 4, gop: 4, bf: 0 });
  const served = () => createMemorySource({ width: 8, height: 6, frames: Array.from({ length: 5 }, (_, k) => new Uint8Array(48).fill(k * 10)) });
  const tick = () => new Promise(r => setTimeout(r, 5));
  // a wait that fails instead of hanging (an open port would keep the test process alive)
  const within = (p, what, ms = 3000) => { let t; return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, no) => { t = setTimeout(() => no(new Error(`timed out: ${what}`)), ms); })]); };
  const chans = [];
  const channel = () => { const c = new MessageChannel(); chans.push(c); return c; };
  try {
    // the codec path wins: the main-thread server idles (nothing opened) until the codec source is closed
    const ch = channel(), got = [];
    ch.port1.addEventListener('message', ({ data }) => got.push(data));
    let finished = false;
    const serving = serveElementFrames(served(), ch.port1).then(() => { finished = true; });
    const src = await openFrameSource(ok.blob, { port: ch.port2, webcodecs: ok.wc, jobId: 'job-1' });
    assert.equal(src.meta.path, 'codec');
    assert.deepEqual(await collect(src), [0, 1, 2, 3]);
    await tick();
    assert.equal(finished, false, 'the server waits while the codec source is open');
    await src.close();
    await within(serving, 'the server resolves once the codec source closed');
    assert.deepEqual(got.filter(m => m.type === 'close'), [{ type: 'close', jobId: 'job-1' }], 'close() posted {type:close, jobId}');
    await src.close();
    await tick();
    assert.equal(got.filter(m => m.type === 'close').length, 1, 'closing twice posts once');
    await assert.rejects(within(RemoteFrameSource.open(ch.port2), 'open on a released port'), isCode('closed'), 'a released port fails fast instead of hanging');
    assert.equal(releaseElementPort(ch.port2), false, 'released once only');
    // the worker's retry on the element path, opened before the codec source closes, owns the port
    const ch2 = channel(), types = [];
    ch2.port1.addEventListener('message', ({ data }) => types.push(data.type));
    const serving2 = serveElementFrames(served(), ch2.port1);
    const codec = await openFrameSource(ok.blob, { port: ch2.port2, webcodecs: ok.wc, jobId: 'job-2' });
    const retry = await within(openFrameSource(ok.blob, { prefer: 'element', port: ch2.port2, jobId: 'job-2' }), 'element retry opens');
    assert.equal(retry.meta.path, 'memory');
    await codec.close();
    assert.deepEqual(await within(collect(retry), 'the element retry streams'), [0, 1, 2, 3, 4], 'the element retry still streams after the codec source closed');
    assert.ok(!types.includes('close'), 'the codec source did not stop the claimed server');
    await retry.close();
    await within(serving2, 'the retry close releases the server');
    assert.equal(types.filter(t => t === 'close').length, 1);
    await assert.rejects(within(RemoteFrameSource.open(ch2.port2), 'reopen after a remote close'), isCode('closed'), 'a port a remote source closed is released too');
    // no port: nothing to release; prefer 'codec' with a port that fails leaves the port to the caller
    const plain = await openFrameSource(ok.blob, { webcodecs: ok.wc });
    await plain.close();
    const ch3 = channel(), t3 = [];
    ch3.port1.addEventListener('message', ({ data }) => t3.push(data.type)); ch3.port1.start();
    await assert.rejects(openFrameSource(ok.blob.slice(0, 0), { prefer: 'codec', port: ch3.port2, webcodecs: ok.wc }), isCode('unsupported'));
    await tick();
    assert.deepEqual(t3, []);
    assert.equal(releaseElementPort(ch3.port2, 'job-3'), true);
    await tick();
    assert.deepEqual(t3, ['close']);
  } finally {
    for (const c of chans) { c.port1.close(); c.port2.close(); }
  }
});

test('meta carries container hints and timing', async () => {
  const { blob, wc } = await setup({ n: 10, gop: 5, bf: 0, write: { metadata: { 'com.android.capture.fps': 240 }, audio: true } });
  const src = await CodecFrameSource.open(blob, { webcodecs: wc });
  assert.equal(src.meta.captureFpsHint, 240);
  assert.equal(src.meta.hasAudio, true);
  assert.equal(src.meta.codec, 'avc1.64001F');
  assert.ok(Math.abs(src.meta.fps - 30) < 1e-9);
  assert.equal(src.meta.frameCount, 10);
});

/* ---------------------------------------------------------------- real pixels: codec path == Node ffmpeg source */

const FF = ffmpegOk();
test('with ffmpeg-decoded coded planes, the codec path equals the Node source bit for bit (rotation, edit list, 10-bit, range)', { skip: !FF && 'ffmpeg not found' }, async () => {
  const fx = await buildFixtures(['avc-bf', 'hevc-r90', 'hevc-r180', 'hevc-r270', 'avc-cut', 'hevc-10bit', 'avc-full']);
  for (const name of ['avc-bf', 'hevc-r90', 'hevc-r180', 'hevc-r270', 'avc-cut', 'hevc-10bit', 'avc-full']) {
    const file = fx.path(name), st = probeStream(file), ten = st.pixFmt.includes('10');
    const coded = decodeCoded(file, { pixFmt: ten ? 'yuv420p10le' : 'yuv420p', width: st.width, height: st.height });
    const info = await demuxMp4(await openAsBlob(file)), byTs = new Map([...info.times].map((t, k) => [Math.round(t * 1e6), k]));
    const n = st.width * st.height;
    const wc = fakeWebCodecs({
      format: ten ? 'I420P10' : 'I420', codedWidth: st.width, codedHeight: st.height, colorSpace: { fullRange: false },
      render: ts => { const k = byTs.get(ts) ?? 0, b = coded[k]; return { y: ten ? new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + 2 * n)) : b.subarray(0, n) }; }
    });
    const codec = await CodecFrameSource.open(await openAsBlob(file), { webcodecs: wc }), node = await openNodeSource(file);
    assert.deepEqual([codec.meta.width, codec.meta.height, codec.meta.rotation, codec.meta.frameCount], [node.meta.width, node.meta.height, node.meta.rotation, node.meta.frameCount], name);
    assert.deepEqual([...codec.meta.times], [...node.meta.times], `${name}: times`);
    const hashes = [];
    for await (const ref of node.frames()) hashes.push([fnv((await ref.lumaCoarse(64)).data), fnv((await ref.lumaRect({ x: -3, y: 5, w: 41, h: 37 }, { pool: 1 })).data)]);
    let k = 0;
    for await (const ref of codec.frames()) {
      assert.deepEqual([fnv((await ref.lumaCoarse(64)).data), fnv((await ref.lumaRect({ x: -3, y: 5, w: 41, h: 37 }, { pool: 1 })).data)], hashes[k], `${name}: frame ${k}`);
      k++;
    }
    assert.equal(k, hashes.length);
  }
});
