import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { HFError } from '../dist/hf/types.js';
import { demuxMp4, readSample, sampleReader, matrixRotation, avcVideoSignal } from '../dist/hf/decode/mp4-demux.js';
import { writeMp4, gopOrder, avcC, hvcC } from './hf/helpers/mp4-writer.mjs';
import { ffmpegOk, buildFixtures, probeFrames, probePackets, probeStream } from './hf/helpers/decode-fixtures.mjs';

const blob = bytes => new Blob([bytes]);
const demux = (o, opts) => demuxMp4(blob(writeMp4(o)), opts);
const rejectsCode = (p, code) => assert.rejects(p, e => e instanceof HFError && e.code === code, `expected HFError ${code}`);
const cfr = (n, dur = 1000) => Array.from({ length: n }, (_, i) => ({ dur, key: i % 10 === 0 }));

/** A Baseline H.264 SPS NAL (header + RBSP with emulation prevention) carrying a video signal type. */
function sps({ fullRange, matrix = 1, signal = true }) {
  const bits = [], put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const ue = v => { const x = v + 1, n = 32 - Math.clz32(x); put(0, n - 1); put(x, n); };
  put(66, 8); put(0, 8); put(30, 8); ue(0); ue(0); ue(2); ue(1); put(0, 1); ue(3); ue(2); put(1, 1); put(1, 1); put(0, 1);
  put(1, 1); put(0, 1); put(0, 1); // VUI present, no aspect ratio, no overscan
  put(signal ? 1 : 0, 1);
  if (signal) { put(5, 3); put(fullRange ? 1 : 0, 1); put(1, 1); put(1, 8); put(1, 8); put(matrix, 8); }
  put(1, 1); while (bits.length % 8) bits.push(0);
  const rbsp = Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(8 * i, 8 * i + 8).reduce((a, b) => a * 2 + b, 0)), out = [0x67];
  for (const b of rbsp) { if (out.length >= 3 && out.at(-1) === 0 && out.at(-2) === 0 && b <= 3) out.push(3); out.push(b); }
  return Uint8Array.from(out);
}

/* ---------------------------------------------------------------- written files (no ffmpeg) */

test('B-frames: decode order is kept, presentation order and times come from ctts', async () => {
  const order = gopOrder(30, { gop: 12, bf: 2 }), info = await demux({ samples: order, timescale: 30000 });
  assert.equal(info.codec, 'avc1.64001F');
  assert.deepEqual(info.samples.map(s => s.index), order.map(s => s.index), 'sample -> presentation index');
  assert.deepEqual([...info.order].map(i => order[i].index), Array.from({ length: 30 }, (_, k) => k));
  assert.ok(order.some((s, i) => s.index !== i), 'the fixture really reorders');
  // No edit list: times are raw composition times (one frame of B-frame delay).
  assert.deepEqual([...info.times], Array.from({ length: 30 }, (_, k) => (k + 1) / 30));
  assert.ok(Math.abs(info.fps - 30) < 1e-9); assert.equal(info.vfr, false);
  assert.ok(Math.abs(info.duration - 31 / 30) < 1e-12);
  assert.deepEqual([...info.order].map(i => info.samples[i].key), Array.from({ length: 30 }, (_, k) => k % 12 === 0));
});

test('ctts version 1 negative offsets with an edit list starting at 0', async () => {
  const order = gopOrder(12, { gop: 12, bf: 2, delay: 0 }).map(s => ({ ...s, cto: s.cto - 1000 }));
  const info = await demux({ samples: order, cttsVersion: 1, edits: [{ dur: 400, mediaTime: 0 }] });
  assert.ok(order.some(s => s.cto < 0));
  assert.equal(info.times.length, 12);
  assert.equal(info.times[0], 0);
  assert.deepEqual([...info.order].map(i => order[i].index), Array.from({ length: 12 }, (_, k) => k));
});

test('edit list: media_time shifts, pre-roll before it is not presented, the tail after the segment is trimmed', async () => {
  // 30 fps, frames k at cts = k·1000 (no B-frames). Edit: start at frame 5's time, 10 frames long.
  const samples = cfr(30), info = await demux({ samples, edits: [{ dur: 10 * 1000 / 30, mediaTime: 5000 }] });
  assert.equal(info.times.length, 10);
  assert.deepEqual([...info.times].map(t => Math.round(t * 30)), Array.from({ length: 10 }, (_, k) => k));
  assert.deepEqual(info.samples.slice(0, 5).map(s => s.index), [-1, -1, -1, -1, -1], 'pre-roll');
  assert.equal(info.samples[5].index, 0);
  assert.equal(info.samples[15].index, -1, 'trimmed tail');
  assert.ok(info.samples[0].key && info.samples[0].pts < 0, 'the keyframe the pre-roll starts from has pts < 0');
});

test('edit list: the first presented frame lands on the empty-edit offset (libavformat convention)', async () => {
  const samples = cfr(20), ms = n => Math.round(n * 1000 / 30);
  // media_time inside frame 3 (3.4 frames): frame 3 is pre-roll, frame 4 is presented at exactly 0.
  let info = await demux({ samples, edits: [{ dur: ms(10), mediaTime: 3400 }] });
  assert.equal(info.times[0], 0);
  assert.equal(info.samples[3].index, -1);
  assert.equal(info.samples[4].index, 0);
  // A leading empty edit of 250 ms delays the presentation; trailing empty edits do nothing.
  info = await demux({ samples, edits: [{ dur: 250, mediaTime: -1 }, { dur: ms(20), mediaTime: 0 }, { dur: 100, mediaTime: -1 }] });
  assert.equal(info.times[0], 0.25);
  assert.equal(info.times.length, 20);
  // Contiguous segments merge; segment duration 0 means "to the end".
  info = await demux({ samples, movieTimescale: 30000, edits: [{ dur: 5000, mediaTime: 0 }, { dur: 5000, mediaTime: 5000 }] });
  assert.equal(info.times.length, 10);
  info = await demux({ samples, edits: [{ dur: ms(5), mediaTime: 0 }, { dur: ms(5), mediaTime: 5000 }] }); // within a movie tick
  assert.equal(info.times.length, 11);
  info = await demux({ samples, edits: [{ dur: 0, mediaTime: 2000 }] });
  assert.equal(info.times.length, 18);
  // 64-bit (version 1) entries.
  info = await demux({ samples, edits: [{ dur: ms(10), mediaTime: 1000, v1: true }] });
  assert.equal(info.times.length, 10);
});

test('edit lists the demuxer cannot express are unsupported (the element path plays them)', async () => {
  const samples = cfr(20);
  await rejectsCode(demux({ samples, edits: [{ dur: 100, mediaTime: 0 }, { dur: 100, mediaTime: 9000 }] }), 'unsupported');
  await rejectsCode(demux({ samples, edits: [{ dur: 300, mediaTime: 0, rate: 2 }] }), 'unsupported');
  await rejectsCode(demux({ samples, edits: [{ dur: 300, mediaTime: 99000 }] }), 'no-video');
});

test('display rotation from the tkhd matrix: 0/90/180/270 clockwise; mirrored matrices are unsupported', async () => {
  for (const r of [0, 90, 180, 270]) assert.equal((await demux({ samples: cfr(3), rotation: r, width: 64, height: 48 })).rotation, r);
  const info = await demux({ samples: cfr(3), rotation: 90, width: 64, height: 48 });
  assert.equal(info.codedWidth, 64); assert.equal(info.codedHeight, 48);
  await rejectsCode(demux({ samples: cfr(3), rotation: [-1, 0, 0, 1] }), 'unsupported');
  assert.equal(matrixRotation(0, 65536, -65536, 0), 90);
  assert.equal(matrixRotation(0, -2, 2, 0), 270, 'scale does not matter');
  assert.throws(() => matrixRotation(1, 0, 0, -1), HFError);
  assert.throws(() => matrixRotation(1, 1, -1, 1), HFError, '45° is not a right angle');
});

test('sample tables: stz2, co64, multi-entry stsc and moov after mdat give the same samples', async () => {
  const order = gopOrder(23, { gop: 8, bf: 2 }).map((s, i) => ({ ...s, size: 10 + (i % 7) }));
  const ref = await demux({ samples: order, chunkSize: 4 });
  for (const opts of [{ stz2: true }, { co64: true }, { chunkSize: 5 }, { chunkSize: 1 }, { moovFirst: false }, { co64: true, moovFirst: false, stz2: true, chunkSize: 3 }]) {
    const bytes = writeMp4({ samples: order, ...opts }), info = await demuxMp4(blob(bytes));
    assert.deepEqual([...info.times], [...ref.times], JSON.stringify(opts));
    assert.deepEqual(info.samples.map(s => [s.size, s.key, s.index]), ref.samples.map(s => [s.size, s.key, s.index]), JSON.stringify(opts));
    const read = sampleReader(blob(bytes), info.samples);
    for (let i = 0; i < order.length; i++) {
      const want = Uint8Array.from({ length: order[i].size }, (_, k) => (i * 31 + k * 7) & 255);
      assert.deepEqual(await readSample(blob(bytes), info.samples[i]), want, `readSample ${i}`);
      assert.deepEqual(await read(i), want, `sampleReader ${i}`);
    }
  }
});

test('without stss every sample is a sync sample', async () => {
  const info = await demux({ samples: cfr(6).map(s => ({ ...s, key: true })) });
  assert.deepEqual(info.samples.map(s => s.key), [true, true, true, true, true, true]);
  const some = await demux({ samples: cfr(6) });
  assert.deepEqual(some.samples.map(s => s.key), [true, false, false, false, false, false]);
});

test('sampleReader batches contiguous samples into one Blob read', async () => {
  const bytes = writeMp4({ samples: cfr(40).map(s => ({ ...s, size: 1000 })) }), info = await demuxMp4(blob(bytes));
  let reads = 0;
  const b = blob(bytes), counting = { size: b.size, slice: (...a) => { reads++; return b.slice(...a); } };
  const read = sampleReader(counting, info.samples, { maxBytes: 10000 });
  for (let i = 0; i < 40; i++) await read(i);
  assert.ok(reads <= 5, `${reads} reads for 40 samples`);
});

test('fragmented MP4 throws fragmented by default; fragments:true reads moof/trun timing', async () => {
  const order = gopOrder(30, { gop: 10, bf: 2 });
  await rejectsCode(demux({ samples: order, fragmented: true }), 'fragmented');
  const ref = await demux({ samples: order }), info = await demux({ samples: order, fragmented: true, audio: true }, { fragments: true });
  assert.equal(info.fragmented, true);
  assert.deepEqual([...info.times], [...ref.times]);
  assert.deepEqual(info.samples.map(s => [s.key, s.index]), ref.samples.map(s => [s.key, s.index]));
  assert.equal(info.hasAudio, true);
});

test('codec strings from avcC / hvcC; other entries are unsupported unless allowUnsupported', async () => {
  assert.equal((await demux({ samples: cfr(2), config: avcC({ profile: 0x42, compat: 0xc0, level: 0x1e }) })).codec, 'avc1.42C01E');
  assert.equal((await demux({ samples: cfr(2), entry: 'avc3' })).codec, 'avc3.64001F');
  assert.equal((await demux({ samples: cfr(2), entry: 'hvc1' })).codec, 'hvc1.1.6.L93.90');
  assert.equal((await demux({ samples: cfr(2), entry: 'hev1', config: hvcC({ p: 0x22, compat: 0x20000000, level: 120, constraints: [0x80, 0, 0, 0, 0, 0] }) })).codec, 'hev1.2.4.H120.80');
  await rejectsCode(demux({ samples: cfr(2), entry: 'mp4v', config: null }), 'unsupported');
  const info = await demux({ samples: cfr(4), entry: 'mp4v', config: null }, { allowUnsupported: true });
  assert.equal(info.codec, null);
  assert.equal(info.times.length, 4);
});

test('missing pieces: no moov, no video track, empty files, bad arguments', async () => {
  const bytes = writeMp4({ samples: cfr(4), moovFirst: false }), dv = new DataView(bytes.buffer);
  let moovAt = 0;
  for (let o = 0; o + 8 <= bytes.length; o += dv.getUint32(o)) if (String.fromCharCode(...bytes.subarray(o + 4, o + 8)) === 'moov') moovAt = o;
  assert.ok(moovAt > 0);
  await rejectsCode(demuxMp4(blob(bytes.subarray(0, moovAt))), 'no-moov');
  await rejectsCode(demuxMp4(blob(new Uint8Array(0))), 'no-moov');
  await rejectsCode(demuxMp4(blob(Uint8Array.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))), 'no-moov');
  await rejectsCode(demux({ samples: cfr(4), handler: 'text' }), 'no-video');
  await assert.rejects(demuxMp4(null), e => e.code === 'bad-arg');
});

test('audio presence, mdta capture-rate and focal hints', async () => {
  assert.equal((await demux({ samples: cfr(3) })).hasAudio, false);
  assert.equal((await demux({ samples: cfr(3), audio: true })).hasAudio, true);
  const info = await demux({ samples: cfr(3), metadata: { 'com.android.capture.fps': 240, 'com.apple.quicktime.camera.focal_length.35mm_equivalent': '26', 'com.example.other': 5 } });
  assert.equal(info.hints.captureFps, 240);
  assert.equal(info.hints.focal35, 26);
  assert.deepEqual((await demux({ samples: cfr(3) })).hints, {});
});

test('colour range: the H.264 VUI flag first (as libavcodec), then colr nclx, else null', async () => {
  assert.deepEqual(avcVideoSignal(avcC({ profile: 66, sps: sps({ fullRange: true, matrix: 1 }) })), { fullRange: true, matrix: 'bt709' });
  assert.deepEqual(avcVideoSignal(avcC({ profile: 66, sps: sps({ fullRange: false, matrix: 6 }) })), { fullRange: false, matrix: 'smpte170m' });
  assert.equal(avcVideoSignal(avcC({ profile: 66, sps: sps({ signal: false }) })), null);
  assert.equal(avcVideoSignal(avcC()), null, 'no SPS');
  const vuiFull = avcC({ profile: 66, sps: sps({ fullRange: true }) }), vuiLimited = avcC({ profile: 66, sps: sps({ fullRange: false }) });
  assert.equal((await demux({ samples: cfr(2), config: vuiFull })).fullRange, true);
  assert.equal((await demux({ samples: cfr(2), config: vuiLimited, colr: { fullRange: true } })).fullRange, false, 'VUI wins over colr');
  assert.equal((await demux({ samples: cfr(2), colr: { fullRange: true, matrix: 1 } })).fullRange, true);
  assert.equal((await demux({ samples: cfr(2), colr: { fullRange: false, matrix: 6 } })).matrix, 'smpte170m');
  assert.equal((await demux({ samples: cfr(2) })).fullRange, null);
});

test('VFR timing: fps is 1/median interval and the vfr flag uses decode.vfrRatio', async () => {
  const durs = [1000, 1300, 700, 1000, 1300, 700, 1000, 1300, 700, 1000, 1000, 1000];
  const info = await demux({ samples: durs.map((dur, i) => ({ dur, key: i === 0 })) });
  assert.equal(info.vfr, true);
  assert.ok(Math.abs(info.fps - 30) < 1e-9);
  assert.equal((await demux({ samples: cfr(12) })).vfr, false);
});

test('an aborted signal rejects with AbortError', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(demuxMp4(blob(writeMp4({ samples: cfr(3) })), { signal: ac.signal }), e => e.name === 'AbortError');
});

/* ---------------------------------------------------------------- ffmpeg fixtures vs ffprobe */

const FF = ffmpegOk();
const fixtures = FF ? await buildFixtures() : null;
const rotationOf = ccw => (((-ccw) % 360) + 360) % 360;

test('ffmpeg fixtures: samples, presentation times, keyframes, rotation and audio equal ffprobe', { skip: !FF && 'ffmpeg not found' }, async () => {
  const names = ['avc-bf', 'avc-60', 'avc-240', 'avc-vfr', 'avc-full', 'hevc-r90', 'hevc-r180', 'hevc-r270', 'hevc-10bit', 'avc-cut', 'avc-delay', 'avc-tail', 'avc-co64', 'avc-large'];
  for (const name of names) {
    const file = fixtures.path(name), info = await demuxMp4(await openAsBlob(file)), frames = probeFrames(file), packets = probePackets(file), st = probeStream(file);
    assert.equal(info.times.length, frames.length, `${name}: frame count`);
    for (let k = 0; k < frames.length; k++) assert.ok(Math.abs(info.times[k] - frames[k].t) <= 1e-6, `${name}: t[${k}] ${info.times[k]} vs ${frames[k].t}`);
    assert.deepEqual([...info.order].map(i => info.samples[i].key), frames.map(f => f.key), `${name}: keyframes`);
    assert.deepEqual(info.samples.map(s => [s.offset, s.size, s.key]), packets.map(p => [p.pos, p.size, p.key]), `${name}: packets`);
    assert.deepEqual(info.samples.map(s => s.index < 0), packets.map(p => p.discard), `${name}: pre-roll = discarded packets`);
    assert.equal(info.rotation, rotationOf(st.rotation), `${name}: rotation`);
    assert.equal(info.rotation, fixtures.spec(name).rotation ?? 0, `${name}: generated rotation`);
    assert.equal(info.hasAudio, st.audio, `${name}: audio`);
    assert.deepEqual([info.codedWidth, info.codedHeight], [st.width, st.height], `${name}: coded size`);
    assert.match(info.codec, st.codec === 'hevc' ? /^hvc1\.\d\.[0-9A-F]+\.[LH]\d+/ : /^avc1\.[0-9A-F]{6}$/, `${name}: codec`);
    assert.ok(Math.abs(info.fps - fixtures.spec(name).fps) < 1e-6 || name === 'avc-vfr', `${name}: fps ${info.fps}`);
  }
});

test('ffmpeg fixtures: edit-list cut, start delay, VFR, 10-bit, full range, co64 and 64-bit mdat', { skip: !FF && 'ffmpeg not found' }, async () => {
  const get = async name => demuxMp4(await openAsBlob(fixtures.path(name)));
  const cut = await get('avc-cut');
  assert.equal(cut.times.length, 32);
  assert.equal(cut.times[0], 0);
  assert.ok(cut.samples[0].key && cut.samples[0].index === -1, 'the cut starts on a pre-roll keyframe');
  assert.equal((await get('avc-delay')).times[0], 0.25);
  const vfr = await get('avc-vfr');
  assert.equal(vfr.vfr, true);
  assert.ok(new Set([...vfr.times].slice(1).map((t, i) => Math.round((t - vfr.times[i]) * 9e4))).size >= 2);
  assert.match((await get('hevc-10bit')).codec, /^hvc1\.2\./, 'Main 10 profile');
  assert.equal((await get('avc-full')).fullRange, true);
  assert.equal((await get('avc-bf')).fullRange, null);
  const tail = await get('avc-tail');
  for (const name of ['avc-co64', 'avc-large']) {
    const info = await get(name);
    assert.deepEqual([...info.times], [...tail.times], name);
    assert.deepEqual(info.samples.map(s => [s.offset, s.size]), tail.samples.map(s => [s.offset, s.size]), name);
  }
});

test('ffmpeg fixtures: fragmented, unsupported codec, audio only, truncated', { skip: !FF && 'ffmpeg not found' }, async () => {
  const b = name => openAsBlob(fixtures.path(name));
  await rejectsCode(demuxMp4(await b('avc-frag')), 'fragmented');
  const frag = await demuxMp4(await b('avc-frag'), { fragments: true }), frames = probeFrames(fixtures.path('avc-frag'));
  assert.equal(frag.times.length, frames.length);
  frames.forEach((f, k) => assert.ok(Math.abs(frag.times[k] - f.t) <= 1e-6, `frag t[${k}]`));
  await rejectsCode(demuxMp4(await b('mpeg4')), 'unsupported');
  assert.equal((await demuxMp4(await b('mpeg4'), { allowUnsupported: true })).times.length, 6);
  await rejectsCode(demuxMp4(await b('audio-only')), 'no-video');
  await rejectsCode(demuxMp4(await b('no-moov')), 'no-moov');
});
