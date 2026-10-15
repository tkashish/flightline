// Minimal MP4/MOV writer for decode tests: exact control over sample tables (decode order, ctts, stss, stsc,
// stsz/stz2, stco/co64), edit lists, display matrix, sample entry, colr, mdta metadata, an audio track and
// fragmented layouts, without ffmpeg. Sample bytes are a pattern (or given), so a fake decoder can identify them.

const te = new TextEncoder();
const u8 = (...a) => Uint8Array.from(a);
const be = (n, bytes) => { const b = new Uint8Array(bytes); let v = BigInt(n); for (let i = bytes - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const u16 = n => be(n & 0xffff, 2), u32 = n => be(n >>> 0, 4), i32 = n => be(n < 0 ? 2 ** 32 + n : n, 4), u64 = n => be(n, 8), i64 = n => be(n < 0 ? 2n ** 64n + BigInt(n) : n, 8);
const cat = parts => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const box = (type, ...parts) => { const body = cat(parts.flat(Infinity)); return cat([u32(body.length + 8), te.encode(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version), be(flags, 3), ...parts);

const MATRIX = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
/** tkhd matrix (a, b, c, d in units) for a clockwise display rotation, or [a, b, c, d] given. */
const matrix = (m, w, h) => {
  const [a, b, c, d] = Array.isArray(m) ? m : MATRIX[m ?? 0];
  const tx = a < 0 || c < 0 ? (c < 0 ? h : w) : 0, ty = b < 0 || d < 0 ? (b < 0 ? w : h) : 0;
  return [i32(a * 65536), i32(b * 65536), u32(0), i32(c * 65536), i32(d * 65536), u32(0), i32(tx * 65536), i32(ty * 65536), u32(1 << 30)];
};

/** A small avcC (no parameter sets unless sps given): codec string avc1.PPCCLL. */
export function avcC({ profile = 0x64, compat = 0, level = 0x1f, sps = null } = {}) {
  return sps ? cat([u8(1, profile, compat, level, 0xff, 0xe1), u16(sps.length), sps, u8(0)]) : u8(1, profile, compat, level, 0xff, 0xe0, 0);
}
/** A small hvcC: profile_space/tier/idc byte p, compatibility flags, level. */
export function hvcC({ p = 0x01, compat = 0x60000000, level = 93, constraints = [0x90, 0, 0, 0, 0, 0] } = {}) {
  return cat([u8(1, p), u32(compat), u8(...constraints), u8(level), u8(0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0)]);
}

function visualEntry(entry, w, h, config, colr) {
  const children = [];
  if (config) children.push(box(entry.startsWith('hv') || entry.startsWith('he') ? 'hvcC' : 'avcC', config));
  if (colr) children.push(box('colr', te.encode('nclx'), u16(colr.primaries ?? 1), u16(colr.transfer ?? 1), u16(colr.matrix ?? 1), u8(colr.fullRange ? 0x80 : 0)));
  return box(entry, new Uint8Array(6), u16(1), new Uint8Array(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), i32(-1).subarray(2), ...children);
}

/**
 * @param {Object} o
 * @param {{size?:number, dur:number, cto?:number, key?:boolean, data?:Uint8Array}[]} o.samples  decode order
 * @returns {Uint8Array} file bytes
 */
export function writeMp4(o) {
  const {
    samples, timescale = 30000, movieTimescale = 1000, width = 64, height = 48, entry = 'avc1', config = entry.startsWith('h') ? hvcC() : avcC(),
    rotation = 0, edits = null, cttsVersion = 0, co64 = false, stz2 = false, chunkSize = 4, audio = false, colr = null, metadata = null,
    fragmented = false, moovFirst = true, brand = 'isom', stss = true, enabled = true, handler = 'vide'
  } = o;
  const data = samples.map((s, i) => s.data ?? Uint8Array.from({ length: s.size ?? 16 }, (_, k) => (i * 31 + k * 7) & 255));
  const sizes = data.map(d => d.length), durTotal = samples.reduce((s, x) => s + x.dur, 0);
  const ftyp = box('ftyp', te.encode(brand), u32(0x200), te.encode(brand), te.encode('mp41'));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(Math.round(durTotal * movieTimescale / timescale)), u32(0x00010000), u16(0x0100), new Uint8Array(10), ...matrix(0, 0, 0), new Uint8Array(24), u32(3));
  const tkhd = (id, m) => full('tkhd', 0, enabled ? 3 : 2, u32(0), u32(0), u32(id), u32(0), u32(Math.round(durTotal * movieTimescale / timescale)), new Uint8Array(8), u16(0), u16(0), u16(id === 1 ? 0 : 0x0100), u16(0), ...m, u32(width << 16), u32(height << 16));
  const mdhd = (ts, dur) => full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u16(0x55c4), u16(0));
  const hdlr = h => full('hdlr', 0, 0, u32(0), te.encode(h), new Uint8Array(12), te.encode('h\0'));
  const edts = edits ? box('edts', full('elst', edits.some(e => e.v1) ? 1 : 0, 0, u32(edits.length), ...edits.map(e => e.v1
    ? [u64(e.dur), i64(e.mediaTime), u16(e.rate ?? 1), u16(0)] : [u32(e.dur), i32(e.mediaTime), u16(e.rate ?? 1), u16(0)]))) : null;
  const tables = offsets => {
    const n = samples.length, runs = [];
    for (const s of samples) { if (runs.length && runs.at(-1)[1] === s.dur) runs.at(-1)[0]++; else runs.push([1, s.dur]); }
    const ct = [];
    for (const s of samples) { const c = s.cto ?? 0; if (ct.length && ct.at(-1)[1] === c) ct.at(-1)[0]++; else ct.push([1, c]); }
    const chunks = Math.ceil(n / chunkSize), rem = n - (chunks - 1) * chunkSize, chunkOff = Array.from({ length: chunks }, (_, c) => offsets[c * chunkSize]);
    return [
      full('stsd', 0, 0, u32(1), visualEntry(entry, width, height, config, colr)),
      full('stts', 0, 0, u32(runs.length), ...runs.map(([c, d]) => [u32(c), u32(d)])),
      ...(samples.some(s => s.cto) ? [full('ctts', cttsVersion, 0, u32(ct.length), ...ct.map(([c, d]) => [u32(c), i32(d)]))] : []),
      ...(stss && samples.some(s => !s.key) ? [full('stss', 0, 0, u32(samples.filter(s => s.key).length), ...samples.flatMap((s, i) => (s.key ? [u32(i + 1)] : [])))] : []),
      full('stsc', 0, 0, u32(rem === chunkSize ? 1 : 2), u32(1), u32(chunkSize), u32(1), ...(rem === chunkSize ? [] : [u32(chunks), u32(rem), u32(1)])),
      stz2 ? full('stz2', 0, 0, new Uint8Array(3), u8(16), u32(n), ...sizes.map(u16)) : full('stsz', 0, 0, u32(0), u32(n), ...sizes.map(u32)),
      co64 ? full('co64', 0, 0, u32(chunks), ...chunkOff.map(u64)) : full('stco', 0, 0, u32(chunks), ...chunkOff.map(u32))
    ];
  };
  const emptyTables = () => [full('stsd', 0, 0, u32(1), visualEntry(entry, width, height, config, colr)), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0))];
  const videoTrak = offsets => box('trak', tkhd(1, matrix(rotation, width, height)), ...(edts ? [edts] : []),
    box('mdia', mdhd(timescale, durTotal), hdlr(handler), box('minf', full('vmhd', 0, 1, new Uint8Array(8)), box('stbl', ...(fragmented ? emptyTables() : tables(offsets))))));
  const audioTrak = audio ? box('trak', tkhd(2, matrix(0, 0, 0)), box('mdia', mdhd(48000, 48000), hdlr('soun'), box('minf', full('smhd', 0, 0, u32(0)),
    box('stbl', full('stsd', 0, 0, u32(1), box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(2), u16(16), u32(0), u32(48000 << 16))),
      full('stts', 0, 0, u32(1), u32(1), u32(1024)), full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)), full('stsz', 0, 0, u32(4), u32(1)), full('stco', 0, 0, u32(1), u32(0)))))) : null;
  const meta = metadata ? box('meta', full('hdlr', 0, 0, u32(0), te.encode('mdta'), new Uint8Array(12), u8(0)),
    full('keys', 0, 0, u32(Object.keys(metadata).length), ...Object.keys(metadata).map(k => box('mdta', te.encode(k)))),
    box('ilst', ...Object.values(metadata).map((v, i) => { const d = typeof v === 'number' ? (() => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v); return [u32(23), u32(0), b]; })() : [u32(1), u32(0), te.encode(String(v))]; return cat([u32(8 + 8 + d.flat().reduce((s, x) => s + x.length, 0)), u32(i + 1), box('data', ...d)]); }))) : null;
  const mvex = fragmented ? box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))) : null;
  const moov = offsets => box('moov', mvhd, videoTrak(offsets), ...(audioTrak ? [audioTrak] : []), ...(meta ? [meta] : []), ...(mvex ? [mvex] : []));
  if (fragmented) {
    // One fragment per keyframe run: moof(mfhd, traf(tfhd default-base-is-moof, tfdt, trun with every field)) + mdat.
    const out = [ftyp, moov(null)];
    let t = 0;
    for (let i = 0, seq = 1; i < samples.length; seq++) {
      let j = i + 1;
      while (j < samples.length && !samples[j].key) j++;
      const run = samples.slice(i, j), runData = data.slice(i, j);
      const trun = off => full('trun', 1, 0x1 | 0x100 | 0x200 | 0x400 | 0x800, u32(run.length), i32(off), ...run.map((s, k) => [u32(s.dur), u32(runData[k].length), u32(s.key ? 0x02000000 : 0x01010000), i32(s.cto ?? 0)]));
      const moof = off => box('moof', full('mfhd', 0, 0, u32(seq)), box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(t)), trun(off)));
      const size = moof(0).length;
      out.push(moof(size + 8), box('mdat', ...runData));
      t += run.reduce((s, x) => s + x.dur, 0);
      i = j;
    }
    return cat(out);
  }
  const mdat = box('mdat', ...data);
  if (!moovFirst) {
    const base = ftyp.length + 8, offsets = sizes.map((_, i) => base + sizes.slice(0, i).reduce((s, x) => s + x, 0));
    return cat([ftyp, mdat, moov(offsets)]);
  }
  const head = ftyp.length + moov(sizes.map(() => 0)).length + 8, offsets = sizes.map((_, i) => head + sizes.slice(0, i).reduce((s, x) => s + x, 0));
  return cat([ftyp, moov(offsets), mdat]);
}

/**
 * Typical decode orders. ipb(n, {gop, bf}): closed GOPs of `gop` frames, `bf` B-frames between references, as
 * {dur, cto, key} in decode order plus the presentation index of each sample (dur = frame duration in timescale units).
 */
export function gopOrder(n, { gop = 12, bf = 2, dur = 1000, delay = bf ? 1 : 0, openGop = false } = {}) {
  const pres = [];
  let lead = [];
  for (let g = 0; g < n; g += gop) {
    const end = Math.min(n, g + gop), refs = [];
    for (let k = g; k < end; k += bf + 1) refs.push(k);
    if (refs.at(-1) !== end - 1 && !(openGop && end < n)) refs.push(end - 1);
    // Open GOP: the previous GOP's trailing B-frames follow this keyframe in decode order (leading pictures).
    pres.push(refs[0], ...lead);
    lead = [];
    for (let r = 1; r < refs.length; r++) { pres.push(refs[r]); for (let k = refs[r - 1] + 1; k < refs[r]; k++) pres.push(k); }
    for (let k = refs.at(-1) + 1; k < end; k++) lead.push(k);
  }
  pres.push(...lead);
  const keyAt = new Set(Array.from({ length: Math.ceil(n / gop) }, (_, i) => i * gop));
  // dts_i = (i − delay)·dur in decode order; pts_k = k·dur, so cto = (k − i + delay)·dur.
  const d = Math.max(delay, ...pres.map((k, i) => i - k));
  return pres.map((k, i) => ({ dur, cto: (k - i + d) * dur, key: keyAt.has(k), index: k }));
}
