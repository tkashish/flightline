import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HFError, poolLuma, coarsePool, check } from '../dist/hf/types.js';
import { demuxMp4 } from '../dist/hf/decode/mp4-demux.js';
import { lumaLut, rotatePlane } from '../dist/hf/decode/planes.js';
import { openNodeSource, hasFfmpeg } from './hf/helpers/node-source.mjs';
import { buildFixtures, readBarcode, decodeCoded, probeStream, fnv } from './hf/helpers/decode-fixtures.mjs';

const skip = !hasFfmpeg() && 'ffmpeg not found';
const fx = skip ? null : await buildFixtures();
const isCode = code => e => e instanceof HFError && e.code === code;
const range = (a, b, s = 1) => { const r = []; for (let k = a; k < b; k += s) r.push(k); return r; };
const full = ref => ref.lumaRect({ x: 0, y: 0, w: ref.W, h: ref.H });
const fnvOf = img => fnv(img.data);
async function frames(src, opts) {
  const out = [];
  for await (const ref of src.frames(opts)) out.push({ index: ref.index, t: ref.t, plane: (await ref.lumaRect({ x: 0, y: 0, w: src.meta.width, h: src.meta.height })).data });
  return out;
}

test('every fixture: barcode == frame index, times equal the demuxer exactly, upright size and rotation', { skip }, async () => {
  for (const name of ['avc-bf', 'avc-60', 'avc-240', 'avc-vfr', 'avc-full', 'hevc-r90', 'hevc-r180', 'hevc-r270', 'hevc-10bit', 'avc-cut', 'avc-delay', 'avc-co64', 'avc-large', 'avc-frag']) {
    const file = fx.path(name), src = await openNodeSource(file), m = src.meta, spec = fx.spec(name);
    assert.deepEqual(check('SourceMeta', m), [], name);
    assert.equal(m.path, 'node');
    assert.deepEqual([m.width, m.height, m.rotation], [spec.W, spec.H, spec.rotation ?? 0], `${name}: upright size`);
    const info = await demuxMp4(await openAsBlob(file), { fragments: true });
    assert.deepEqual([...m.times], [...info.times], `${name}: times`);
    assert.equal(m.hasAudio, info.hasAudio, `${name}: audio`);
    const got = await frames(src), skipFrames = name === 'avc-cut' ? 16 : 0;
    assert.deepEqual(got.map(f => f.index), range(0, m.frameCount), name);
    got.forEach(f => assert.equal(readBarcode(f.plane, m.width, m.height), f.index + skipFrames, `${name}: frame ${f.index}`));
  }
});

test('frames({from, to, stride}) and mid-clip seeks give exactly the planes of a full decode', { skip }, async () => {
  for (const name of ['avc-bf', 'avc-vfr', 'avc-240', 'avc-cut', 'hevc-r90', 'avc-delay']) {
    const src = await openNodeSource(fx.path(name)), all = await frames(src), n = src.meta.frameCount;
    for (const [from, to, stride] of [[Math.floor(n / 2), n, 1], [n - 3, n + 5, 1], [7, Math.min(n, 30), 4], [1, 2, 1], [0, n, 3]]) {
      const got = await frames(src, { from, to, stride });
      assert.deepEqual(got.map(f => f.index), range(from, Math.min(n, to), stride), `${name} ${from}-${to}/${stride}`);
      for (const f of got) { assert.equal(fnv(f.plane), fnv(all[f.index].plane), `${name}: frame ${f.index}`); assert.equal(f.t, all[f.index].t); }
    }
  }
});

test('pixels: raw Y through the shared lookup table (limited expansion, 10-bit shift, full range untouched), then upright', { skip }, async () => {
  for (const name of ['avc-bf', 'hevc-r270', 'hevc-10bit', 'avc-full']) {
    const file = fx.path(name), st = probeStream(file), ten = st.pixFmt.includes('10');
    const raw = decodeCoded(file, { pixFmt: ten ? 'yuv420p10le' : 'yuv420p', width: st.width, height: st.height });
    const lut = lumaLut(ten ? 10 : 8, st.range !== 'pc') ?? Uint8Array.from({ length: 256 }, (_, i) => i), n = st.width * st.height;
    const src = await openNodeSource(file), got = await frames(src);
    assert.equal(got.length, raw.length);
    got.forEach((f, k) => {
      const y = ten ? new Uint16Array(raw[k].buffer.slice(raw[k].byteOffset, raw[k].byteOffset + 2 * n)) : raw[k].subarray(0, n);
      const want = rotatePlane(Uint8Array.from(y, v => lut[v]), st.width, st.height, src.meta.rotation).data;
      assert.equal(fnv(f.plane), fnv(want), `${name}: frame ${k}`);
    });
    if (name === 'avc-full') assert.equal(st.range, 'pc');
  }
});

test('FrameRef and source lifecycle: lumaCoarse = poolLuma, closed refs, busy, closed source, bad arguments', { skip, timeout: 60000 }, async () => {
  const src = await openNodeSource(fx.path('avc-60')), m = src.meta, it = src.frames()[Symbol.asyncIterator]();
  try {
    const ref = (await it.next()).value, plane = (await ref.lumaRect({ x: 0, y: 0, w: m.width, h: m.height })).data;
    for (const e of [96, 50, 20]) assert.deepEqual((await ref.lumaCoarse(e)).data, poolLuma(plane, m.width, m.height, coarsePool(m.width, m.height, e)).data);
    await assert.rejects(src.frames().next(), isCode('busy'));
    const pending = it.next();   // next() closes the previous FrameRef at once, before the next frame is read
    await assert.rejects(ref.lumaRect({ x: 0, y: 0, w: m.width, h: m.height }), isCode('closed'));
    const ref2 = (await pending).value;
    assert.equal(ref2.index, 1);
    assert.notEqual(fnvOf(await ref2.lumaRect({ x: 0, y: 0, w: m.width, h: m.height })), fnvOf({ data: plane }), 'frame 1 has its own pixels');
    await it.next();
    await assert.rejects(ref.lumaCoarse(96), isCode('closed'));
    await assert.rejects(ref2.lumaCoarse(96), isCode('closed'));
  } finally { await it.return(); }   // a failed assertion must not leave ffmpeg running
  await assert.rejects(src.frames({ stride: 0 }).next(), isCode('bad-arg'));
  await src.close();
  await assert.rejects(src.frames().next(), isCode('closed'));
});

test('abort stops ffmpeg; bad files reject', { skip }, async () => {
  const src = await openNodeSource(fx.path('avc-240')), ac = new AbortController(), seen = [];
  await assert.rejects((async () => { for await (const ref of src.frames({ signal: ac.signal })) { seen.push(ref.index); if (ref.index === 5) ac.abort(); } })(), e => e.name === 'AbortError');
  assert.deepEqual(seen, range(0, 6));
  assert.deepEqual((await frames(src, { from: 0, to: 3 })).map(f => f.index), [0, 1, 2], 'usable after an abort');
  const dir = mkdtempSync(join(tmpdir(), 'u1-node-')), junk = join(dir, 'junk.mp4');
  writeFileSync(junk, 'not a video');
  await assert.rejects(openNodeSource(junk), isCode('unsupported'));
  await assert.rejects(openNodeSource(fx.path('audio-only')), isCode('no-video'));
  await assert.rejects(openNodeSource(join(dir, 'missing.mp4')), isCode('unsupported'));
});
