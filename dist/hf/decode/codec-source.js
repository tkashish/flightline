/**
 * WebCodecs FrameSource (U1 primary path, runs in the worker) and openFrameSource, the entry point that picks a
 * decode path. demuxMp4 + VideoDecoder: frames({from}) starts at the last sync sample presented at or before
 * `from`, feeds samples in decode order with backpressure (decode.maxDecodeQueue chunks, decode.maxOpenFrames
 * held frames), drops outputs it does not want, and yields every wanted presented frame exactly once, in order,
 * with its container time. Pixels stay in the VideoFrame until asked for: lumaCoarse copies the visible Y plane
 * once (VideoFrame.copyTo) and pools it with rotation and range handling fused (planes.poolPlane); lumaRect copies
 * only the even-aligned coded rect covering the request (planes.cropPlane). Both equal poolLuma / cropLuma of the
 * upright full-range plane bit for bit.
 */
import { HFError, throwIfAborted, makeSourceMeta, coarsePool, check } from '../types.js';
import { PARAMS } from '../params.js';
import { demuxMp4, sampleReader } from './mp4-demux.js';
import { displaySize, displayRectToCoded } from './orient.js';
import { lumaLut, poolPlane, cropPlane, cropFootprint, rgbaToLuma } from './planes.js';
import { ElementFrameSource, RemoteFrameSource, hasDom, releaseElementPort } from './element-source.js';

const FORMATS = {};
for (const f of ['I420', 'I420A', 'I422', 'I422A', 'I444', 'I444A', 'NV12']) FORMATS[f] = { kind: 'yuv', bits: 8 };
for (const f of ['I420', 'I420A', 'I422', 'I422A', 'I444', 'I444A']) for (const b of [10, 12]) FORMATS[`${f}P${b}`] = { kind: 'yuv', bits: b };
for (const f of ['RGBA', 'RGBX']) FORMATS[f] = { kind: 'rgb', bits: 8, bgr: false };
for (const f of ['BGRA', 'BGRX']) FORMATS[f] = { kind: 'rgb', bits: 8, bgr: true };

const isAbort = e => e?.name === 'AbortError';
const asDecode = e => (e instanceof HFError || isAbort(e) ? e : new HFError('decode', e?.message || String(e)));
/** Footprints above this fraction of the frame are served from one full copy instead of a rect copy. */
const FULL_COPY_FRAC = 0.25;

function describeFrame(frame, info) {
  const f = FORMATS[frame.format] ?? { kind: 'canvas', bits: 8 };
  const cs = frame.colorSpace ?? {}, vr = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  // Range: the H.264 VUI or the container colr (what libavcodec and so the Node source use), then the decoder's
  // report (Chrome reports limited for some full-range streams), else limited.
  const fullRange = info.fullRange ?? (typeof cs.fullRange === 'boolean' ? cs.fullRange : null);
  const matrix = info.matrix ?? (cs.matrix && cs.matrix !== 'rgb' ? cs.matrix : null);
  return {
    ...f, format: frame.format ?? null, vis: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
    codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
    // Unknown range is treated as limited, as browsers render it and as ffmpeg converts it.
    limited: f.kind === 'yuv' && fullRange !== true,
    lut: f.kind === 'yuv' ? lumaLut(f.bits, fullRange !== true) : null,
    hd: matrix ? matrix === 'bt709' : vr.height >= 720
  };
}

export class CodecFrameSource {
  /**
   * @param {Blob} blob
   * @param {{signal?:AbortSignal, webcodecs?:{VideoDecoder:Function, EncodedVideoChunk:Function}, params?:object}} [opts]
   *   webcodecs: the WebCodecs constructors (default globalThis; tests inject fakes)
   * @returns {Promise<CodecFrameSource>}
   */
  static async open(blob, { signal, webcodecs = globalThis, params = PARAMS } = {}) {
    throwIfAborted(signal);
    const info = await demuxMp4(blob, { signal });
    const { VideoDecoder, EncodedVideoChunk } = webcodecs;
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') throw new HFError('unsupported', 'WebCodecs VideoDecoder is not available');
    const config = { codec: info.codec, codedWidth: info.codedWidth, codedHeight: info.codedHeight, ...(info.description ? { description: info.description } : {}) };
    let support;
    try { support = await VideoDecoder.isConfigSupported(config); } catch (e) { throw new HFError('unsupported', `isConfigSupported(${info.codec}): ${e.message}`); }
    if (!support?.supported) throw new HFError('unsupported', `decoder does not support ${info.codec} ${info.codedWidth}x${info.codedHeight}`);
    const src = new CodecFrameSource(blob, info, config, webcodecs, params);
    await src.#probe(signal);
    return src;
  }

  #blob; #info; #config; #wc; #params; #fmt = null; #ts; #byTs; #busy = false; #closed = false; #run = null; #pool = []; #noRect = false;
  #port = null; #jobId = null;

  constructor(blob, info, config, webcodecs, params) {
    this.#blob = blob; this.#info = info; this.#config = config; this.#wc = webcodecs; this.#params = params;
    // Chunk timestamps (µs): presented samples carry their frame time, so outputs map back to presentation indices.
    this.#ts = info.samples.map(s => Math.round(s.pts / info.timescale * 1e6));
    this.#byTs = new Map();
    for (let k = 0; k < info.order.length; k++) {
      const t = this.#ts[info.order[k]];
      if (this.#byTs.has(t)) throw new HFError('unsupported', 'frame times closer than 1 µs');
      this.#byTs.set(t, k);
    }
    /** @type {import('../types.js').SourceMeta} */
    this.meta = null;
  }

  /** Decode the first frames once: proves the decoder works and reads format, visible size and colour range. */
  async #probe(signal) {
    const { VideoDecoder, EncodedVideoChunk } = this.#wc, info = this.#info, samples = info.samples;
    let frame = null, error = null;
    const dec = new VideoDecoder({ output: f => { if (frame) f.close(); else frame = f; }, error: e => { error = e; } });
    try {
      dec.configure(this.#config);
      const read = sampleReader(this.#blob, samples);
      // A few chunks from the first keyframe (more than any reorder depth), then flush for the first output.
      for (let i = 0, keys = 0; i < samples.length && i < 8 && !error; i++) {
        throwIfAborted(signal);
        if (samples[i].key && ++keys > 1) break;
        dec.decode(new EncodedVideoChunk({ type: samples[i].key ? 'key' : 'delta', timestamp: this.#ts[i], data: await read(i) }));
      }
      if (!error) await dec.flush();
      if (error || !frame) throw new HFError('decode', `first frame: ${error?.message ?? 'no output'}`);
      this.#fmt = describeFrame(frame, info);
      if (this.#fmt.kind === 'canvas' && typeof OffscreenCanvas !== 'function') throw new HFError('unsupported', `frame format ${frame.format} needs OffscreenCanvas`);
    } catch (e) {
      throw asDecode(e);
    } finally {
      frame?.close();
      if (dec.state !== 'closed') dec.close();
    }
    const { width, height } = displaySize(this.#fmt.vis.w, this.#fmt.vis.h, info.rotation), h = info.hints;
    this.meta = makeSourceMeta({
      width, height, codedWidth: this.#fmt.codedWidth, codedHeight: this.#fmt.codedHeight, rotation: info.rotation,
      fps: info.fps, vfr: info.vfr, frameCount: info.times.length, times: info.times, duration: info.duration, path: 'codec',
      hasAudio: info.hasAudio, codec: info.codec, ...(h.captureFps > 0 ? { captureFpsHint: h.captureFps } : {}), ...(h.focal35 > 0 ? { focal35: h.focal35 } : {})
    });
  }

  /** Decoder output facts (diagnostics): {format, kind, bits, limited, hd, rectCopy}. */
  get format() { const f = this.#fmt; return f && { format: f.format, kind: f.kind, bits: f.bits, limited: f.limited, hd: f.hd, rectCopy: !this.#noRect }; }

  /**
   * @param {import('../types.js').FramesOptions} [opts]
   * @returns {AsyncGenerator<import('../types.js').FrameRef>}
   */
  async *frames({ from = 0, to = this.meta.frameCount, stride = 1, signal } = {}) {
    if (this.#closed) throw new HFError('closed', 'source is closed');
    if (!(Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(stride) && stride > 0)) throw new HFError('bad-arg', `frames({from:${from}, to:${to}, stride:${stride}})`);
    if (this.#busy) throw new HFError('busy', 'another frames() iteration is live');
    this.#busy = true;
    const n = this.meta.frameCount, a = Math.min(Math.max(from, 0), n), b = Math.min(Math.max(to, 0), n);
    let ref = null, run = null;
    try {
      if (a >= b) return;
      run = this.#run = new DecodeRun(this, a, b, stride, signal);
      for (let k = a; k < b; k += stride) {
        ref?.close(); ref = null;
        const frame = await run.take(k);
        ref = this.#ref(k, frame);
        yield ref;
      }
    } finally {
      ref?.close();
      run?.close();
      if (this.#run === run) this.#run = null;
      this.#busy = false;
    }
  }

  /**
   * Hold the element-fallback port this source made unnecessary (openFrameSource does this when the codec path
   * wins): close() then tells the main-thread server to stop, unless a RemoteFrameSource has opened on the port
   * since (the worker's retry on the element path), which then owns it.
   */
  holdPort(port, jobId = null) { this.#port = port ?? null; this.#jobId = jobId ?? null; }

  /** Releases decoder resources (and a held element port); a live iteration rejects with HFError 'closed', later frames() calls too. */
  async close() {
    this.#closed = true;
    this.#run?.fail(new HFError('closed', 'source is closed'));
    const port = this.#port;
    this.#port = null;
    if (port) releaseElementPort(port, this.#jobId);
  }

  // Internals shared with DecodeRun.
  get _info() { return this.#info; }
  get _ts() { return this.#ts; }
  get _byTs() { return this.#byTs; }
  get _blob() { return this.#blob; }
  get _config() { return this.#config; }
  get _wc() { return this.#wc; }
  get _params() { return this.#params; }

  #ref(k, frame) {
    const fmt = this.#fmt, rot = this.#info.rotation, W = this.meta.width, H = this.meta.height, vis = fmt.vis;
    let open = true, full = null, pending = 0, buffer = null;
    const live = () => { if (!open) throw new HFError('closed', `frame ${k} is closed`); };
    const settle = async p => {
      pending++;
      try { const v = await p; live(); return v; }
      catch (e) { if (!open) throw new HFError('closed', `frame ${k} is closed`); throw asDecode(e); }
      finally { if (--pending === 0 && !open) this.#release(buffer); }
    };
    const readFull = () => (full ??= (async () => {
      if (fmt.kind === 'canvas') return { data: canvasLuma(frame, vis, fmt), w: vis.w, h: vis.h, x: 0, y: 0 };
      // No options: the visible rect with the default tight layout (the most widely supported copy).
      buffer = this.#take(frame.allocationSize());
      await frame.copyTo(buffer);
      return planeOf(buffer, vis.w, vis.h, fmt, 0, 0);
    })());
    const readRect = async c => {
      // Even-aligned (chroma) coded rect inside the visible area, offset to the frame's coded coordinates.
      const x0 = Math.max(0, c.x & ~1), y0 = Math.max(0, c.y & ~1), x1 = Math.min(vis.w, (c.x + c.w + 1) & ~1), y1 = Math.min(vis.h, (c.y + c.h + 1) & ~1);
      if (this.#noRect || x1 < c.x + c.w || y1 < c.y + c.h || (vis.x | vis.y) & 1) return readFull();
      if (fmt.kind === 'canvas') return { data: canvasLuma(frame, { x: vis.x + x0, y: vis.y + y0, w: x1 - x0, h: y1 - y0 }, fmt), w: x1 - x0, h: y1 - y0, x: x0, y: y0 };
      const rect = { x: vis.x + x0, y: vis.y + y0, width: x1 - x0, height: y1 - y0 };
      let buf;
      try { buf = new Uint8Array(frame.allocationSize({ rect })); await frame.copyTo(buf, { rect }); }
      catch (e) { if (!open || isAbort(e)) throw e; this.#noRect = true; return readFull(); } // rect copies refused: full copies from now on
      return planeOf(buf, x1 - x0, y1 - y0, fmt, x0, y0);
    };
    return {
      index: k, t: this.meta.times[k],
      async lumaCoarse(longEdge, out) {
        live();
        const p = await settle(readFull());
        return poolPlane(p.data, p.w, p.h, p.w, rot, coarsePool(W, H, longEdge), p.lut, out);
      },
      async lumaRect(rect, { pool = 1, out } = {}) {
        live();
        const errs = check('Rect', rect);
        if (errs.length || !(Number.isInteger(pool) && pool > 0) || rect.w < pool || rect.h < pool) throw new HFError('bad-arg', errs.join('; ') || `rect ${rect.w}×${rect.h} with pool ${pool}`);
        const f = cropFootprint(rect, W, H, pool), c = displayRectToCoded(f, rot, vis.w, vis.h);
        const p = await settle(full || f.w * f.h > FULL_COPY_FRAC * W * H ? readFull() : readRect(c));
        return cropPlane(p.data, p.w, p.h, p.w, p.x, p.y, vis.w, vis.h, rot, rect, pool, p.lut, out);
      },
      close: () => {
        if (!open) return;
        open = false;
        frame.close();
        if (pending === 0) this.#release(buffer);
      }
    };
  }

  // Full-frame copy buffers are reused once their frame is closed and no copy into them is pending.
  #take(size) { const i = this.#pool.findIndex(b => b.length >= size); return i >= 0 ? this.#pool.splice(i, 1)[0] : new Uint8Array(size); }
  #release(buf) { if (buf && this.#pool.length < 2) this.#pool.push(buf); }
}

/** Plane 0 of a copyTo buffer (tight default layout) as {data, w, h, x, y, lut}; RGB formats become luma. */
function planeOf(buf, w, h, fmt, x, y) {
  if (fmt.kind === 'rgb') return { data: rgbaToLuma(buf, w, h, { hd: fmt.hd, bgr: fmt.bgr }), w, h, x, y, lut: null };
  const data = fmt.bits > 8 ? new Uint16Array(buf.buffer, buf.byteOffset, w * h) : buf.subarray(0, w * h);
  return { data, w, h, x, y, lut: fmt.lut };
}

/** Formats copyTo cannot describe: draw the coded rect through an OffscreenCanvas and take luma of the RGBA. */
function canvasLuma(frame, r, fmt) {
  const c = new OffscreenCanvas(r.w, r.h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return rgbaToLuma(ctx.getImageData(0, 0, r.w, r.h).data, r.w, r.h, { hd: fmt.hd });
}

/** One decoder session for one frames() iteration. */
class DecodeRun {
  constructor(src, a, b, stride, signal) {
    const info = src._info, samples = info.samples, P = src._params.decode;
    this.src = src; this.a = a; this.b = b; this.stride = stride; this.signal = signal;
    this.maxQueue = P.maxDecodeQueue; this.maxOpen = P.maxOpenFrames;
    this.ready = new Map(); this.waiters = []; this.error = null; this.closed = false; this.flushed = false;
    this.nextWanted = a;
    // Start at the last sync sample whose presentation time is at or before the first wanted frame: its leading
    // pictures (open GOP) are earlier than `from`, so they are never needed.
    const target = samples[info.order[a]].pts;
    let s0 = 0, last = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].key && samples[i].pts <= target) s0 = i;
      const k = samples[i].index;
      if (k >= a && k < b && (k - a) % stride === 0) last = i;
    }
    this.next = Math.min(s0, last); this.last = last;
    this.read = sampleReader(src._blob, samples);
    this.wake = () => { const w = this.waiters; this.waiters = []; for (const r of w) r(); };
    const { VideoDecoder } = src._wc;
    this.decoder = new VideoDecoder({ output: f => this.onOutput(f), error: e => this.fail(new HFError('decode', e?.message || String(e))) });
    this.decoder.addEventListener?.('dequeue', this.wake);
    signal?.addEventListener('abort', this.wake);
    try { this.decoder.configure(src._config); } catch (e) { this.fail(asDecode(e)); }
    this.pump();
  }

  wanted(k) { return k >= this.nextWanted && k < this.b && (k - this.a) % this.stride === 0; }

  onOutput(f) {
    const k = this.src._byTs.get(f.timestamp);
    if (this.closed || k === undefined || !this.wanted(k) || this.ready.has(k)) { f.close(); return; }
    this.ready.set(k, f);
    if (this.ready.size > this.maxOpen + this.maxQueue + 8) this.fail(new HFError('decode', 'decoder output is out of order'));
    this.wake();
  }

  /** Resolves on any change (output, dequeue, take, abort), or after ms while polling a full decode queue. */
  changed(ms) {
    return new Promise(r => { this.waiters.push(r); if (ms) setTimeout(r, ms); });
  }

  async pump() {
    const { EncodedVideoChunk } = this.src._wc, samples = this.src._info.samples, ts = this.src._ts;
    try {
      while (!this.closed && !this.error) {
        if (this.next > this.last) { await this.decoder.flush(); this.flushed = true; this.wake(); return; }
        // Hold back while the queue is full or enough wanted frames wait; if the frame the consumer waits for is
        // not among them, keep feeding (the flush then proves it missing instead of deadlocking).
        const full = this.decoder.decodeQueueSize >= this.maxQueue, held = this.ready.size >= this.maxOpen && this.ready.has(this.nextWanted);
        if (full || held) { await this.changed(full ? 4 : 0); continue; }
        const i = this.next++, data = await this.read(i);
        if (this.closed || this.error) return;
        this.decoder.decode(new EncodedVideoChunk({ type: samples[i].key ? 'key' : 'delta', timestamp: ts[i], data }));
      }
    } catch (e) {
      if (!this.closed) this.fail(asDecode(e));
    }
  }

  async take(k) {
    for (;;) {
      throwIfAborted(this.signal);
      if (this.error) throw this.error;
      const f = this.ready.get(k);
      if (f) { this.ready.delete(k); this.nextWanted = k + this.stride; this.wake(); return f; }
      if (this.flushed) throw new HFError('decode', `frame ${k} was not decoded`);
      await this.changed(0);
    }
  }

  fail(e) { if (!this.error) this.error = e; this.wake(); }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.ready.values()) f.close();
    this.ready.clear();
    try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch { /* already closed */ }
    this.decoder.removeEventListener?.('dequeue', this.wake);
    this.signal?.removeEventListener('abort', this.wake);
    this.wake();
  }
}

/**
 * Best FrameSource for a file (protocol doc §7). prefer 'auto' tries the codec path, then the element path;
 * 'codec' or 'element' forces one. In a worker the element path needs `port` (a MessagePort answered by
 * serveElementFrames on the main thread); on the main thread without a port ElementFrameSource is used directly.
 * Codec failures (fragmented, no moov, unsupported codec or config, missing WebCodecs, first-frame decode error)
 * fall back; the reason is kept in source.fallback. When the codec path wins, the returned source holds `port` and
 * its close() posts {type:'close', jobId} on it so the main thread releases its element server; a retry on the
 * element path must therefore open (RemoteFrameSource claims the port) before the codec source is closed.
 * Rejects HFError 'unsupported' when no path works, and with an AbortError when signal aborts.
 * @param {Blob} fileOrBlob
 * @param {{prefer?:'auto'|'codec'|'element', signal?:AbortSignal, port?:MessagePort, jobId?:string, webcodecs?:object, params?:object}} [opts]
 * @returns {Promise<import('../types.js').FrameSource>}
 */
export async function openFrameSource(fileOrBlob, { prefer = 'auto', signal, port, jobId, webcodecs, params } = {}) {
  if (!['auto', 'codec', 'element'].includes(prefer)) throw new HFError('bad-arg', `prefer ${prefer}`);
  throwIfAborted(signal);
  const failures = [];
  const why = (path, e) => ({ path, code: e?.code ?? e?.name ?? 'error', message: String(e?.message ?? e) });
  if (prefer !== 'element') {
    try {
      const src = await CodecFrameSource.open(fileOrBlob, { signal, webcodecs, params });
      if (port) src.holdPort(port, jobId);   // released on close() unless an element retry claims it first
      return src;
    } catch (e) { if (isAbort(e)) throw e; failures.push(why('codec', e)); }
  }
  if (prefer !== 'codec') {
    try {
      let src;
      if (port) src = await RemoteFrameSource.open(port, { signal, jobId });
      else if (hasDom()) src = await ElementFrameSource.open(fileOrBlob, { signal, params });
      else throw new HFError('unsupported', 'the element path needs a main-thread port in a worker');
      if (failures.length) src.fallback = failures[0];
      return src;
    } catch (e) { if (isAbort(e)) throw e; failures.push(why('element', e)); }
  }
  const err = new HFError('unsupported', failures.map(f => `${f.path}: ${f.code}: ${f.message}`).join('; '));
  err.failures = failures;
  throw err;
}
