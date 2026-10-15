/**
 * Dependency-free MP4/MOV demuxer for the WebCodecs path (U1). Reads box headers and the moov box through
 * Blob.slice, never the whole file. Returns the first enabled video track: codec string and description,
 * display rotation, the sample table in decode order (stts, ctts v0/v1, stss, stsc, stsz/stz2, stco/co64), and
 * presentation order and times with the edit list applied the way libavformat applies it (so Chrome's <video>
 * and the ffmpeg Node source see the same frame list): only samples whose composition time lies inside the
 * edit are presented (the rest is pre-roll or trimmed tail), and the first presented frame sits at the sum of
 * the leading empty edits. Fragmented files throw HFError 'fragmented' so callers fall back to the element path.
 */
import { HFError, throwIfAborted, timingFromTimes } from '../types.js';

/**
 * @typedef {Object} DemuxSample  one coded sample, decode order
 * @property {number} offset  byte offset in the file
 * @property {number} size
 * @property {number} dts  media timescale units, shifted with the edit list like pts
 * @property {number} pts  presentation time in media timescale units (edit list applied); index −1 samples may be < 0
 * @property {boolean} key  sync sample (stss; every sample when stss is absent)
 * @property {number} index  presentation index, or −1 when not presented (pre-roll, trimmed, duplicate time)
 */
/**
 * @typedef {Object} DemuxInfo
 * @property {string|null} codec  WebCodecs codec string (null for an unsupported entry with allowUnsupported)
 * @property {string} entry  sample entry four-cc (avc1, hvc1, ...)
 * @property {Uint8Array|null} description  avcC / hvcC payload
 * @property {number} codedWidth  sample entry width (visible, coded orientation)
 * @property {number} codedHeight
 * @property {0|90|180|270} rotation  clockwise display rotation from the tkhd matrix
 * @property {number} timescale  media timescale (units per second)
 * @property {DemuxSample[]} samples  decode order
 * @property {Int32Array} order  sample index per presentation index
 * @property {Float64Array} times  presentation times (s), strictly increasing
 * @property {number} fps
 * @property {boolean} vfr
 * @property {number} duration  times[n−1] + median interval
 * @property {boolean} hasAudio
 * @property {boolean|null} fullRange  colr nclx full_range_flag, null when absent
 * @property {string|null} matrix  colr matrix coefficients ('bt709', 'bt470bg', 'smpte170m', 'bt2020-ncl') or null
 * @property {{captureFps?:number, focal35?:number}} hints  container metadata (mdta keys)
 * @property {boolean} fragmented  samples came from moof fragments (only with opts.fragments)
 */

const ENTRY = { avc1: 'avcC', avc3: 'avcC', hvc1: 'hvcC', hev1: 'hvcC' };
const MATRIX = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');

function* boxes(v, start, end) {
  for (let o = start; o + 8 <= end;) {
    let size = v.getUint32(o), header = 8;
    const type = fourcc(v, o + 4);
    if (size === 1) { if (o + 16 > end) return; size = Number(v.getBigUint64(o + 8)); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header) return;
    yield { type, start: o, body: o + header, end: Math.min(end, o + size) };
    o += size;
  }
}
const child = (v, box, type) => { if (box) for (const b of boxes(v, box.body, box.end)) if (b.type === type) return b; return null; };
const path = (v, box, ...types) => types.reduce((b, t) => child(v, b, t), box);
const need = (b, what) => { if (!b) throw new HFError('unsupported', `missing ${what}`); return b; };

async function slice(blob, start, end) { return new DataView(await blob.slice(start, end).arrayBuffer()); }

/** Top-level boxes, headers only, until moov. */
async function locateMoov(blob, signal) {
  let moof = false;
  for (let o = 0; o + 8 <= blob.size;) {
    throwIfAborted(signal);
    const h = await slice(blob, o, Math.min(blob.size, o + 16));
    let size = h.getUint32(0), header = 8;
    const type = fourcc(h, 4);
    if (size === 1) { if (h.byteLength < 16) break; size = Number(h.getBigUint64(8)); header = 16; }
    else if (size === 0) size = blob.size - o;
    if (size < header) break;
    if (type === 'moof') moof = true;
    if (type === 'moov') return { start: o, size: Math.min(size, blob.size - o), header, moof };
    o += size;
  }
  throw new HFError(moof ? 'fragmented' : 'no-moov', moof ? 'fragmented MP4 without a moov box' : 'no moov box');
}

/** Clockwise rotation from the tkhd matrix [a b; c d]; mirrored or non-right-angle matrices are unsupported. */
export function matrixRotation(a, b, c, d) {
  const det = a * d - b * c, deg = Math.atan2(b, a) * 180 / Math.PI, r = Math.round(deg / 90) * 90;
  if (!(det > 0) || Math.abs(deg - r) > 1) throw new HFError('unsupported', `display matrix [${a} ${b}; ${c} ${d}]`);
  return ((r % 360) + 360) % 360;
}

function codecString(v, entry, cfg) {
  const d = new Uint8Array(v.buffer, v.byteOffset + cfg.body, cfg.end - cfg.body).slice();
  if (ENTRY[entry] === 'avcC') return { codec: `${entry}.${hex(d[1])}${hex(d[2])}${hex(d[3])}`, description: d };
  const p = d[1], space = ['', 'A', 'B', 'C'][p >> 6], tier = p & 0x20 ? 'H' : 'L';
  let flags = new DataView(d.buffer).getUint32(2), rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (flags & 1); flags >>>= 1; }
  const cons = [...d.slice(6, 12)];
  while (cons.length && !cons.at(-1)) cons.pop();
  return { codec: `${entry}.${space}${p & 0x1f}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${d[12]}${cons.map(x => `.${x.toString(16).toUpperCase()}`).join('')}`, description: d };
}

/** Exp-Golomb bit reader over an RBSP (emulation-prevention bytes removed). */
function bitReader(nal) {
  const b = [];
  for (let i = 0; i < nal.length; i++) { if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; b.push(nal[i]); }
  let pos = 0;
  const bit = () => { if (pos >> 3 >= b.length) throw new RangeError('rbsp'); return (b[pos >> 3] >> (7 - (pos++ & 7))) & 1; };
  const u = n => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (!bit()) if (++z > 31) throw new RangeError('ue'); return 2 ** z - 1 + u(z); };
  return { u, ue, se: () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; } };
}

/**
 * video_full_range_flag and matrix_coefficients from the first SPS of an avcC (H.264 VUI), as libavcodec reads
 * them; null when the SPS has no video signal type.
 */
export function avcVideoSignal(avcC) {
  try {
    if ((avcC[5] & 31) < 1) return null;
    const len = (avcC[6] << 8) | avcC[7], r = bitReader(avcC.subarray(9, 8 + len)); // skip the NAL header byte
    const profile = r.u(8); r.u(16); r.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cf = r.ue(); if (cf === 3) r.u(1);
      r.ue(); r.ue(); r.u(1);
      if (r.u(1)) for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) if (r.u(1)) for (let j = 0, last = 8, next = 8; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + r.se() + 256) % 256; last = next || last; }
    }
    r.ue();
    const poc = r.ue();
    if (poc === 0) r.ue(); else if (poc === 1) { r.u(1); r.se(); r.se(); for (let i = 0, n = r.ue(); i < n; i++) r.se(); }
    r.ue(); r.u(1); r.ue(); r.ue();
    if (!r.u(1)) r.u(1);
    r.u(1);
    if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
    if (!r.u(1)) return null;                         // vui_parameters_present_flag
    if (r.u(1) && r.u(8) === 255) r.u(32);            // aspect ratio
    if (r.u(1)) r.u(1);                               // overscan
    if (!r.u(1)) return null;                         // video_signal_type_present_flag
    r.u(3);
    const fullRange = r.u(1) === 1;
    return { fullRange, matrix: r.u(1) ? (r.u(16), MATRIX[r.u(8)] ?? null) : null };
  } catch { return null; }
}

function sampleEntry(v, stbl, allowUnsupported) {
  const stsd = need(child(v, stbl, 'stsd'), 'stsd');
  if (v.getUint32(stsd.body + 4) !== 1) throw new HFError('unsupported', 'several sample descriptions');
  const e = need(boxes(v, stsd.body + 8, stsd.end).next().value, 'sample entry');
  const out = { entry: e.type, codec: null, description: null, codedWidth: v.getUint16(e.body + 24), codedHeight: v.getUint16(e.body + 26), fullRange: null, matrix: null };
  for (const b of boxes(v, e.body + 78, e.end)) {
    if (b.type === ENTRY[e.type]) Object.assign(out, codecString(v, e.type, b));
    if (b.type === 'colr' && b.end - b.body >= 10) {
      const kind = fourcc(v, b.body);
      if (kind === 'nclx' || kind === 'nclc') out.matrix = MATRIX[v.getUint16(b.body + 8)] ?? null;
      if (kind === 'nclx' && b.end - b.body >= 11) out.fullRange = (v.getUint8(b.body + 10) & 0x80) !== 0;
    }
  }
  if (!out.codec && !allowUnsupported) throw new HFError('unsupported', `video codec ${e.type}`);
  // The H.264 bitstream's own video signal type wins over colr, as in libavcodec (and so the Node source).
  const vui = out.description && ENTRY[e.type] === 'avcC' ? avcVideoSignal(out.description) : null;
  if (vui) { out.fullRange = vui.fullRange; out.matrix = vui.matrix ?? out.matrix; }
  return out;
}

/** Sample table in decode order: offsets, sizes, dts, composition offsets, sync flags. */
function sampleTable(v, stbl) {
  const u32 = o => v.getUint32(o), tab = t => child(v, stbl, t);
  let n, size;
  const stsz = tab('stsz'), stz2 = tab('stz2');
  if (stsz) {
    const fixed = u32(stsz.body + 4); n = u32(stsz.body + 8);
    size = fixed ? () => fixed : i => u32(stsz.body + 12 + 4 * i);
  } else if (stz2) {
    const bits = v.getUint8(stz2.body + 7), b = stz2.body + 12; n = u32(stz2.body + 8);
    size = bits === 16 ? i => v.getUint16(b + 2 * i) : bits === 8 ? i => v.getUint8(b + i) : i => (v.getUint8(b + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15;
  } else throw new HFError('unsupported', 'missing stsz');
  const sizes = new Float64Array(n), offsets = new Float64Array(n), dts = new Float64Array(n), cto = new Float64Array(n), key = new Uint8Array(n);
  for (let i = 0; i < n; i++) sizes[i] = size(i);
  const stco = tab('stco'), co64 = tab('co64'), cb = need(stco ?? co64, 'stco/co64');
  const chunks = u32(cb.body + 4), chunk = stco ? i => u32(cb.body + 8 + 4 * i) : i => Number(v.getBigUint64(cb.body + 8 + 8 * i));
  const stsc = need(tab('stsc'), 'stsc'), runs = u32(stsc.body + 4);
  let s = 0;
  for (let r = 0; r < runs && s < n; r++) {
    const e = stsc.body + 8 + 12 * r, first = u32(e), per = u32(e + 4), last = r + 1 < runs ? u32(e + 12) - 1 : chunks;
    for (let c = first; c <= last && c <= chunks && s < n; c++) for (let k = 0, off = chunk(c - 1); k < per && s < n; k++) { offsets[s] = off; off += sizes[s++]; }
  }
  if (s < n) throw new HFError('unsupported', `chunk table covers ${s} of ${n} samples`);
  const stts = need(tab('stts'), 'stts');
  s = 0;
  let t = 0, delta = 0;
  for (let i = 0, m = u32(stts.body + 4); i < m; i++) {
    const cnt = u32(stts.body + 8 + 8 * i); delta = u32(stts.body + 12 + 8 * i);
    for (let k = 0; k < cnt && s < n; k++) { dts[s++] = t; t += delta; }
  }
  for (; s < n; s++) { dts[s] = t; t += delta; }
  const ctts = tab('ctts');
  if (ctts) {
    s = 0; // Offsets are signed in practice for both versions (libavformat reads them as int32 too).
    for (let i = 0, m = u32(ctts.body + 4); i < m; i++) {
      const cnt = u32(ctts.body + 8 + 8 * i), off = v.getInt32(ctts.body + 12 + 8 * i);
      for (let k = 0; k < cnt && s < n; k++) cto[s++] = off;
    }
  }
  const stss = tab('stss');
  if (stss) for (let i = 0, m = u32(stss.body + 4); i < m; i++) { const k = u32(stss.body + 8 + 4 * i) - 1; if (k >= 0 && k < n) key[k] = 1; }
  else key.fill(1);
  return { n, sizes, offsets, dts, cto, key, end: t };
}

/**
 * Sample table of a fragmented file (moof/traf/trun), for timing only (the codec path does not decode fragments):
 * same shape as sampleTable. Track defaults come from mvex/trex, decode times from tfdt or run on.
 */
async function fragmentTable(blob, v, moov, trackId, signal) {
  let def = { dur: 0, size: 0, flags: 0 };
  for (const b of boxes(v, child(v, moov, 'mvex')?.body ?? 0, child(v, moov, 'mvex')?.end ?? 0)) {
    if (b.type === 'trex' && v.getUint32(b.body + 4) === trackId) def = { dur: v.getUint32(b.body + 12), size: v.getUint32(b.body + 16), flags: v.getUint32(b.body + 20) };
  }
  const sizes = [], offsets = [], dts = [], cto = [], key = [];
  let t = 0;
  for (let o = 0; o + 8 <= blob.size;) {
    throwIfAborted(signal);
    const h = await slice(blob, o, Math.min(blob.size, o + 16));
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = h.byteLength >= 16 ? Number(h.getBigUint64(8)) : 0; else if (size === 0) size = blob.size - o;
    if (size < 8) break;
    if (type === 'moof') {
      const m = await slice(blob, o, Math.min(blob.size, o + size));
      for (const traf of boxes(m, 8, m.byteLength)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(m, traf, 'tfhd');
        if (!tfhd || m.getUint32(tfhd.body + 4) !== trackId) continue;
        const tf = m.getUint32(tfhd.body) & 0xffffff;
        let q = tfhd.body + 8, base = o;
        if (tf & 0x1) { base = Number(m.getBigUint64(q)); q += 8; }
        if (tf & 0x2) q += 4;
        const dDur = tf & 0x8 ? m.getUint32((q += 4) - 4) : def.dur, dSize = tf & 0x10 ? m.getUint32((q += 4) - 4) : def.size, dFlags = tf & 0x20 ? m.getUint32((q += 4) - 4) : def.flags;
        const tfdt = child(m, traf, 'tfdt');
        if (tfdt) t = m.getUint8(tfdt.body) === 1 ? Number(m.getBigUint64(tfdt.body + 4)) : m.getUint32(tfdt.body + 4);
        for (const run of boxes(m, traf.body, traf.end)) {
          if (run.type !== 'trun') continue;
          const ver = m.getUint8(run.body), rf = m.getUint32(run.body) & 0xffffff, n = m.getUint32(run.body + 4);
          let r = run.body + 8, off = base;
          if (rf & 0x1) { off = base + m.getInt32(r); r += 4; }
          const first = rf & 0x4 ? m.getUint32((r += 4) - 4) : null;
          for (let i = 0; i < n; i++) {
            const dur = rf & 0x100 ? m.getUint32((r += 4) - 4) : dDur, sz = rf & 0x200 ? m.getUint32((r += 4) - 4) : dSize;
            const fl = rf & 0x400 ? m.getUint32((r += 4) - 4) : i === 0 && first !== null ? first : dFlags;
            const c = rf & 0x800 ? (ver ? m.getInt32((r += 4) - 4) : m.getUint32((r += 4) - 4)) : 0;
            sizes.push(sz); offsets.push(off); dts.push(t); cto.push(c); key.push((fl >> 16) & 1 ? 0 : 1);
            off += sz; t += dur;
          }
        }
      }
    }
    o += size;
  }
  return { n: sizes.length, sizes: Float64Array.from(sizes), offsets: Float64Array.from(offsets), dts: Float64Array.from(dts), cto: Float64Array.from(cto), key: Uint8Array.from(key), end: t };
}

/** Edit list entries {dur (movie timescale), mediaTime (media timescale, −1 = empty), rate}. */
function editList(v, trak) {
  const elst = path(v, trak, 'edts', 'elst');
  if (!elst) return null;
  const ver = v.getUint8(elst.body), n = v.getUint32(elst.body + 4), out = [];
  for (let i = 0, o = elst.body + 8; i < n && o + (ver ? 20 : 12) <= elst.end; i++, o += ver ? 20 : 12) {
    const dur = ver ? Number(v.getBigUint64(o)) : v.getUint32(o), mediaTime = ver ? Number(v.getBigInt64(o + 8)) : v.getInt32(o + 4);
    out.push({ dur, mediaTime, rate: v.getInt16(o + (ver ? 16 : 8)) + v.getUint16(o + (ver ? 18 : 10)) / 65536 });
  }
  return out;
}

/**
 * Presented window [start, end) in media time and the presentation offset (media units) of its first frame:
 * leading empty edits add their duration; contiguous edits merge; other multi-edit lists and rate changes are
 * unsupported (the element path plays them as the browser does).
 */
function presentedWindow(edits, timescale, movieScale) {
  if (!edits?.length) return null;
  const rescale = d => Math.round(d * timescale / movieScale);
  let empty = 0, win = null;
  for (const e of edits) {
    if (e.mediaTime === -1) { if (!win) empty += rescale(e.dur); continue; }
    if (Math.abs(e.rate - 1) > 1e-9) throw new HFError('unsupported', `edit list rate ${e.rate}`);
    const end = e.dur > 0 ? e.mediaTime + rescale(e.dur) : Infinity;
    if (!win) win = { start: e.mediaTime, end };
    else if (Math.abs(e.mediaTime - win.end) <= Math.ceil(timescale / movieScale)) win.end = end; // contiguous (movie-tick rounding)
    else throw new HFError('unsupported', 'edit list with several segments');
  }
  return win ? { ...win, offset: empty } : null;
}

function ascii(v, o, end) { let s = ''; for (let i = o; i < end; i++) s += String.fromCharCode(v.getUint8(i)); return s; }

/** captureFps / focal35 from QuickTime mdta metadata (moov/meta or moov/udta/meta keys + ilst). */
function metadataHints(v, moov) {
  const hints = {};
  for (const meta of [child(v, moov, 'meta'), path(v, moov, 'udta', 'meta')]) {
    if (!meta) continue;
    const box = { body: fourcc(v, meta.body + 4) === 'hdlr' ? meta.body : meta.body + 4, end: meta.end }; // ISO meta is a full box
    const keys = child(v, box, 'keys'), ilst = child(v, box, 'ilst');
    if (!keys || !ilst) continue;
    const names = [];
    for (let i = 0, o = keys.body + 8, n = v.getUint32(keys.body + 4); i < n && o + 8 <= keys.end; i++) {
      const sz = v.getUint32(o); if (sz < 8) break;
      names.push(ascii(v, o + 8, Math.min(keys.end, o + sz))); o += sz;
    }
    for (const item of boxes(v, ilst.body, ilst.end)) {
      const name = names[v.getUint32(item.start + 4) - 1], data = child(v, item, 'data');
      if (!name || !data || data.end - data.body < 9) continue;
      const kind = v.getUint32(data.body) & 0xffffff, o = data.body + 8, len = data.end - o;
      const value = kind === 23 && len >= 4 ? v.getFloat32(o) : kind === 24 && len >= 8 ? v.getFloat64(o)
        : kind === 1 ? parseFloat(ascii(v, o, data.end)) : (kind === 21 || kind === 22) && len === 4 ? v.getInt32(o) : NaN;
      if (!(value > 0) || !Number.isFinite(value)) continue;
      if (name === 'com.android.capture.fps') hints.captureFps = value;
      else if (/focal.?length.*35/i.test(name)) hints.focal35 = value;
    }
  }
  return hints;
}

const trakInfo = (v, trak) => {
  const hdlr = path(v, trak, 'mdia', 'hdlr'), tkhd = child(v, trak, 'tkhd');
  return { handler: hdlr ? fourcc(v, hdlr.body + 8) : '', enabled: tkhd ? (v.getUint32(tkhd.body) & 1) === 1 : true, samples: (() => {
    const stsz = path(v, trak, 'mdia', 'minf', 'stbl', 'stsz') ?? path(v, trak, 'mdia', 'minf', 'stbl', 'stz2');
    return stsz ? v.getUint32(stsz.body + 8) : 0;
  })() };
};

/**
 * Parse the moov box of an MP4/MOV blob. Throws HFError 'fragmented' (moof/mvex), 'no-moov', 'no-video', or
 * 'unsupported' (codec other than avc1/avc3/hvc1/hev1 unless allowUnsupported, mirrored display matrix,
 * multi-segment or rate-changing edit lists, several sample descriptions).
 * @param {Blob} blob
 * @param {{signal?:AbortSignal, allowUnsupported?:boolean, fragments?:boolean}} [opts]  allowUnsupported: return timing
 *   for any codec (codec null); fragments: read fragmented files too (timing for the element path; info.fragmented)
 * @returns {Promise<DemuxInfo>}
 */
export async function demuxMp4(blob, { signal, allowUnsupported = false, fragments = false } = {}) {
  if (!blob || typeof blob.slice !== 'function' || !Number.isFinite(blob.size)) throw new HFError('bad-arg', 'demuxMp4 needs a Blob');
  const loc = await locateMoov(blob, signal);
  const v = await slice(blob, loc.start, loc.start + loc.size);
  throwIfAborted(signal);
  const moov = { body: loc.header, end: v.byteLength }, fragmented = loc.moof || !!child(v, moov, 'mvex');
  if (fragmented && !fragments) throw new HFError('fragmented', 'fragmented MP4 (mvex/moof)');
  const mvhd = child(v, moov, 'mvhd');
  if (!mvhd) throw new HFError('no-moov', 'moov without mvhd');
  const movieScale = v.getUint32(mvhd.body + (v.getUint8(mvhd.body) === 1 ? 20 : 12)) || 1;
  let trak = null, hasAudio = false;
  for (const b of boxes(v, moov.body, moov.end)) {
    if (b.type !== 'trak') continue;
    const t = trakInfo(v, b);
    if (t.handler === 'soun' && (t.samples > 0 || fragmented)) hasAudio = true;
    if (t.handler === 'vide' && (t.samples > 0 || fragmented) && (!trak || (t.enabled && !trak.enabled))) trak = { ...t, box: b };
  }
  if (!trak) throw new HFError('no-video', 'no video track with samples');
  const box = trak.box, tkhd = need(child(v, box, 'tkhd'), 'tkhd'), m = tkhd.body + (v.getUint8(tkhd.body) === 1 ? 52 : 40);
  const rotation = matrixRotation(v.getInt32(m), v.getInt32(m + 4), v.getInt32(m + 12), v.getInt32(m + 16));
  const mdhd = need(path(v, box, 'mdia', 'mdhd'), 'mdhd'), timescale = v.getUint32(mdhd.body + (v.getUint8(mdhd.body) === 1 ? 20 : 12));
  if (!timescale) throw new HFError('unsupported', 'zero media timescale');
  const stbl = need(path(v, box, 'mdia', 'minf', 'stbl'), 'stbl');
  const entry = sampleEntry(v, stbl, allowUnsupported);
  const tab = fragmented ? await fragmentTable(blob, v, moov, v.getUint32(tkhd.body + (v.getUint8(tkhd.body) === 1 ? 20 : 12)), signal) : sampleTable(v, stbl);
  if (!tab.n) throw new HFError('no-video', 'the video track has no samples');
  const win = presentedWindow(editList(v, box), timescale, movieScale);

  // Presentation: composition times inside the edit window; the first presented one lands on the empty-edit offset.
  const { n, cto, dts } = tab, cts = Float64Array.from(dts, (d, i) => d + cto[i]);
  let shift = 0;
  if (win) {
    let min = Infinity;
    for (let i = 0; i < n; i++) if (cts[i] >= win.start && cts[i] < win.end && cts[i] < min) min = cts[i];
    if (min === Infinity) throw new HFError('no-video', 'the edit list presents no video samples');
    shift = win.offset - min;
  }
  const inside = i => !win || (cts[i] >= win.start && cts[i] < win.end);
  const shown = [];
  for (let i = 0; i < n; i++) if (inside(i)) shown.push(i);
  shown.sort((a, b) => cts[a] - cts[b] || a - b);
  const samples = Array.from({ length: n }, (_, i) => ({ offset: tab.offsets[i], size: tab.sizes[i], dts: dts[i] + shift, pts: cts[i] + shift, key: tab.key[i] === 1, index: -1 }));
  const order = [];
  for (const i of shown) if (!order.length || cts[i] > cts[order.at(-1)]) { samples[i].index = order.length; order.push(i); }
  const times = Float64Array.from(order, i => samples[i].pts / timescale);
  const timing = timingFromTimes(times);
  return {
    codec: entry.codec, entry: entry.entry, description: entry.description, codedWidth: entry.codedWidth, codedHeight: entry.codedHeight,
    rotation, timescale, samples, order: Int32Array.from(order), times, fps: timing.fps, vfr: timing.vfr, duration: timing.duration,
    hasAudio, fullRange: entry.fullRange, matrix: entry.matrix, hints: metadataHints(v, moov), fragmented
  };
}

/** Bytes of one sample. */
export async function readSample(blob, sample) {
  return new Uint8Array(await blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
}

/**
 * Batched sample reads: one Blob.slice covers a run of samples that follow each other in the file (gaps up to
 * maxGap bytes, e.g. interleaved audio, are read through), up to maxBytes. Returns views valid until the next read
 * outside the window (EncodedVideoChunk copies its data, so that is enough).
 */
export function sampleReader(blob, samples, { maxBytes = 4 << 20, maxGap = 256 << 10 } = {}) {
  let base = 0, end = -1, buf = null;
  return async i => {
    const s = samples[i];
    if (!buf || s.offset < base || s.offset + s.size > end) {
      let stop = s.offset + s.size;
      for (let j = i + 1; j < samples.length; j++) {
        const q = samples[j];
        if (q.offset < stop || q.offset - stop > maxGap || q.offset + q.size - s.offset > maxBytes) break;
        stop = q.offset + q.size;
      }
      buf = new Uint8Array(await blob.slice(s.offset, stop).arrayBuffer()); base = s.offset; end = s.offset + buf.length;
      if (s.offset + s.size > end) throw new HFError('decode', `sample ${i} lies past the end of the file`);
    }
    return buf.subarray(s.offset - base, s.offset - base + s.size);
  };
}
