/**
 * Element fallback (U1). ElementFrameSource (main thread) owns a hidden <video>: it seeks to frame centres,
 * checks the presented frame with requestVideoFrameCallback mediaTime (a repeated or early mediaTime gets one
 * re-seek nudged by decode.dupNudgeFrac·Δ), and reads it back at native size as a full-range luma plane in
 * display orientation: through `new VideoFrame(video)` + copyTo of the Y plane when possible (the same values as
 * the codec path), else drawImage + getImageData + rgbaToLuma. serveElementFrames streams those planes over a
 * MessagePort to RemoteFrameSource in the worker (protocol doc §11, credit-based), so lumaCoarse and lumaRect run
 * worker-side on whole planes. Frame times come from the demuxer when moov parses, else from an rVFC frame-rate
 * probe. The frame timing helpers are phase 1's (dist/frame-source.js), with this source's globals injected.
 */
import { HFError, ERROR_CODES, throwIfAborted, makeSourceMeta, timingFromTimes, poolLuma, cropLuma, coarsePool } from '../types.js';
import { PARAMS } from '../params.js';
import { demuxMp4 } from './mp4-demux.js';
import { displaySize } from './orient.js';
import { lumaLut, rgbaToLuma, rotatePlane } from './planes.js';
import {
  frameCentre, medianFrameInterval, presentedFrameReader, probeSourceFps, snapSourceFps as snapFps, sourceFrameSchedule as schedule
} from '../../frame-source.js?v=53';

/** True on a thread with a DOM (the main thread). */
export const hasDom = (g = globalThis) => typeof g.document?.createElement === 'function';
const abortError = signal => signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
const isAbort = e => e?.name === 'AbortError';
const toHF = (e, code = 'decode') => (e instanceof HFError || isAbort(e) ? e : new HFError(code, e?.message || String(e)));
const portError = (code, message, dflt) => new HFError(ERROR_CODES.includes(code) && code !== 'internal' ? code : dflt, message);

/* ------------------------------------------------------------------ timing (phase 1, dist/frame-source.js) */

export { frameCentre, medianFrameInterval };
/** Snap a measured frame rate to the nearest common rate within 3%, else round to 0.01 (decode.fallbackFps when unusable). */
export const snapSourceFps = (rawFps, fallback = PARAMS.decode.fallbackFps) => snapFps(rawFps, fallback);
/** One entry per distinct source frame hit by a sampleFps grid (every frame by default): index, pts and t (frame centre). */
export const sourceFrameSchedule = (duration, sourceFps, sampleFps = sourceFps) => schedule(duration, sourceFps, sampleFps);

const hasFrameCallback = video => typeof video?.requestVideoFrameCallback === 'function';

function seekVideo(video, t, signal, ms, env) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let timer;
    const done = err => {
      env.clearTimeout(timer);
      video.removeEventListener('seeked', ok); video.removeEventListener('error', bad); signal?.removeEventListener('abort', ab);
      if (err) reject(err); else resolve();
    };
    const ok = () => done(), bad = () => done(new HFError('decode', 'the video element reported an error')), ab = () => done(abortError(signal));
    video.addEventListener('seeked', ok); video.addEventListener('error', bad); signal?.addEventListener('abort', ab);
    timer = env.setTimeout(() => done(new HFError('decode', `seek to ${t.toFixed(4)} s timed out`)), ms);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 1e-4));
  });
}

/* ------------------------------------------------------------------ FrameRef over a whole plane */

function planeRef(index, t, data, W, H, extra = {}) {
  let open = true;
  const live = () => { if (!open) throw new HFError('closed', `frame ${index} is closed`); };
  return {
    index, t, ...extra,
    get plane() { live(); return data; },
    async lumaCoarse(longEdge, out) { live(); return poolLuma(data, W, H, coarsePool(W, H, longEdge), out); },
    async lumaRect(rect, { pool = 1, out } = {}) { live(); return cropLuma(data, W, H, rect, pool, out); },
    close() { open = false; }
  };
}

function checkFrames(from, to, stride) {
  if (!(Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(stride) && stride > 0)) throw new HFError('bad-arg', `frames({from:${from}, to:${to}, stride:${stride}})`);
}

/* ------------------------------------------------------------------ ElementFrameSource (main thread) */

export class ElementFrameSource {
  /**
   * @param {Blob} fileOrBlob
   * @param {{signal?:AbortSignal, params?:object, env?:object}} [opts]  env: globals to use (document, URL, VideoFrame,
   *   OffscreenCanvas, setTimeout, clearTimeout); tests inject fakes
   * @returns {Promise<ElementFrameSource>}
   */
  static async open(fileOrBlob, { signal, params = PARAMS, env = globalThis } = {}) {
    if (!hasDom(env)) throw new HFError('unsupported', 'ElementFrameSource needs the main thread');
    throwIfAborted(signal);
    const src = new ElementFrameSource(fileOrBlob, params, env);
    try { await src.#open(signal); } catch (e) { await src.close(); throw toHF(e, 'unsupported'); }
    return src;
  }

  #blob; #params; #env; #video = null; #url = null; #canvas = null; #ctx = null; #reader = null; #info = null;
  #busy = false; #closed = false; #readback = 'canvas'; #lut = null; #hd = true; #lastMt = null;

  constructor(blob, params, env) {
    this.#blob = blob; this.#params = params; this.#env = env;
    /** @type {import('../types.js').SourceMeta} */
    this.meta = null;
    /**
     * seeks; retries (nudged re-seeks); rescued (frames caught during slow playback because a seek cannot reach
     * them); unverified (presented mediaTime never matched); duplicates (mediaTime repeated after the retry);
     * noRvfc (no presented-frame metadata); readback 'videoframe' | 'canvas'; demux (why times are probed)
     */
    this.stats = { seeks: 0, retries: 0, rescued: 0, unverified: 0, duplicates: 0, noRvfc: 0, readback: 'canvas', demux: null };
  }

  async #open(signal) {
    const env = this.#env, P = this.#params.decode;
    try { this.#info = await demuxMp4(this.#blob, { signal, allowUnsupported: true, fragments: true }); }
    catch (e) { if (isAbort(e)) throw e; this.stats.demux = `${e.code ?? e.name}: ${e.message}`; }
    const video = this.#video = env.document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.disablePictureInPicture = true;
    // Rendered (rVFC fires only for composited videos) but invisible and inert.
    Object.assign(video.style ?? {}, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    env.document.body?.appendChild(video);
    this.#url = env.URL.createObjectURL(this.#blob);
    await new Promise((resolve, reject) => {
      let timer;
      const done = err => {
        env.clearTimeout(timer); video.removeEventListener('loadeddata', ok); video.removeEventListener('error', bad); signal?.removeEventListener('abort', ab);
        if (err) reject(err); else resolve();
      };
      const ok = () => done(), bad = () => done(new HFError('unsupported', 'the browser cannot play this video')), ab = () => done(abortError(signal));
      video.addEventListener('loadeddata', ok); video.addEventListener('error', bad); signal?.addEventListener('abort', ab);
      timer = env.setTimeout(() => done(new HFError('unsupported', 'the video did not load')), P.seekTimeoutMs);
      video.src = this.#url;
    });
    const W = video.videoWidth, H = video.videoHeight;
    if (!(W > 0 && H > 0)) throw new HFError('unsupported', 'the video has no picture');
    const seek = (v, t, s) => { this.stats.seeks++; return seekVideo(v, t, s, P.seekTimeoutMs, env); };
    this.#reader = presentedFrameReader(video, seek, { ms: P.rvfcWaitMs, env });
    let times, info = this.#info;
    if (info?.times.length) times = info.times;
    else {
      const { fps } = await probeSourceFps(video, seek, signal, { env, fallback: P.fallbackFps });
      throwIfAborted(signal);
      const first = (await this.#reader(0.5 / fps, signal))?.mediaTime ?? 0;
      const n = Math.max(1, Math.round((video.duration - first) * fps));
      times = Float64Array.from({ length: n }, (_, k) => first + k / fps);
    }
    const span = timingFromTimes(times);
    const rotation = info?.rotation ?? 0, coded = info ? { w: info.codedWidth, h: info.codedHeight } : null;
    // Readback: the decoder's own Y plane through VideoFrame when the rotation is known and sizes agree.
    const upright = coded && displaySize(coded.w, coded.h, rotation);
    if (typeof env.VideoFrame === 'function' && upright && upright.width === W && upright.height === H) this.#readback = 'videoframe';
    this.#hd = info?.matrix ? info.matrix === 'bt709' : H >= 720 || W >= 1280;
    this.meta = makeSourceMeta({
      width: W, height: H, codedWidth: coded?.w ?? (rotation % 180 ? H : W), codedHeight: coded?.h ?? (rotation % 180 ? W : H), rotation,
      fps: span.fps, vfr: span.vfr, frameCount: times.length, times, duration: span.duration, path: 'element',
      hasAudio: info?.hasAudio ?? false, ...(info?.codec ? { codec: info.codec } : {}),
      ...(info?.hints.captureFps > 0 ? { captureFpsHint: info.hints.captureFps } : {}), ...(info?.hints.focal35 > 0 ? { focal35: info.hints.focal35 } : {})
    });
    this.stats.readback = this.#readback;
  }

  /**
   * Seek to frame k's centre, verify the presented frame by its mediaTime, read it back.
   * A repeated or early mediaTime gets one re-seek nudged forward by decode.dupNudgeFrac·Δ. A frame the seek
   * cannot reach (Chrome seeks by decode time, so the leading pictures before a keyframe land on the keyframe)
   * is caught while playing slowly from an earlier frame.
   * @returns {Promise<{plane:Uint8Array, mediaTime:number|null, verified:boolean|null}>}
   */
  async #read(k, signal) {
    const m = this.meta, P = this.#params.decode, times = m.times, dt = k + 1 < times.length ? times[k + 1] - times[k] : 1 / m.fps;
    const centre = frameCentre(times, k, m.fps), tol = dt / 4, same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-6;
    const ok = t => t != null && Math.abs(t - times[k]) <= tol && !same(t, this.#lastMt);
    let mt = (await this.#reader(centre, signal))?.mediaTime ?? null;
    if (mt == null) { this.stats.noRvfc++; this.#lastMt = null; return { plane: await this.#finish(this.#grab()), mediaTime: null, verified: null }; }
    if (!ok(mt) && (same(mt, this.#lastMt) || mt < times[k] - tol)) {
      this.stats.retries++;
      mt = (await this.#reader(centre + P.dupNudgeFrac * dt, signal))?.mediaTime ?? mt;
      if (same(mt, this.#lastMt)) this.stats.duplicates++;
    }
    if (!ok(mt)) {
      const caught = await this.#rescue(k, mt, tol, signal);
      if (caught) { this.stats.rescued++; this.#lastMt = caught.mediaTime; return { plane: await this.#finish(caught.grab), mediaTime: caught.mediaTime, verified: true }; }
      this.stats.unverified++;
      mt = (await this.#reader(centre, signal))?.mediaTime ?? mt;
    }
    this.#lastMt = mt;
    return { plane: await this.#finish(this.#grab()), mediaTime: mt, verified: Math.abs(mt - times[k]) <= tol };
  }

  /** Play from an earlier presented frame at about 20 presented frames/s and grab frame k in its rVFC callback. */
  async #rescue(k, mt, tol, signal) {
    const m = this.meta, times = m.times, video = this.#video, env = this.#env;
    if (!hasFrameCallback(video)) return null;
    // Step back (1, 2, 4, ... frames) until a seek presents a frame before k.
    for (let back = 1; !(mt != null && mt < times[k] - tol); back *= 2) {
      if (back > 64 || k - back < -1) return null;
      const j = Math.max(0, k - back);
      mt = (await this.#reader(frameCentre(times, j, m.fps), signal))?.mediaTime ?? null;
      if (j === 0 && !(mt < times[k] - tol)) return null;
    }
    const rate = Math.min(1, 20 / m.fps), budget = 1000 + 1000 * (times[k] - mt) / rate;
    return new Promise(resolve => {
      let handle = 0, timer, done = false;
      const finish = v => {
        if (done) return;
        done = true;
        env.clearTimeout(timer); video.cancelVideoFrameCallback(handle); video.pause(); video.playbackRate = 1;
        signal?.removeEventListener('abort', ab);
        resolve(v);
      };
      const ab = () => finish(null);
      const tick = (now, md) => {
        if (done) return;
        const t = md.mediaTime;
        if (Math.abs(t - times[k]) <= tol) { const grab = this.#grab(); finish({ grab, mediaTime: t }); return; }
        if (t > times[k] + tol) { finish(null); return; }
        handle = video.requestVideoFrameCallback(tick);
      };
      handle = video.requestVideoFrameCallback(tick);
      signal?.addEventListener('abort', ab, { once: true });
      timer = env.setTimeout(() => finish(null), budget);
      video.playbackRate = rate;
      Promise.resolve(video.play()).catch(() => finish(null));
    });
  }

  /** Synchronous part of a readback (safe inside an rVFC callback): the presented frame as a VideoFrame, or drawn to the canvas. */
  #grab() {
    const env = this.#env, video = this.#video, W = this.meta.width, H = this.meta.height;
    if (this.#readback === 'videoframe') {
      try { return { vf: new env.VideoFrame(video) }; }
      catch (e) { this.#readback = this.stats.readback = 'canvas'; this.stats.readbackError = String(e?.message ?? e); }
    }
    if (!this.#ctx) {
      this.#canvas = typeof env.OffscreenCanvas === 'function' ? new env.OffscreenCanvas(W, H) : Object.assign(env.document.createElement('canvas'), { width: W, height: H });
      this.#ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    }
    this.#ctx.drawImage(video, 0, 0, W, H);
    return { canvas: true };
  }

  /** Full-range display-orientation luma plane from a grab. */
  async #finish(g) {
    const W = this.meta.width, H = this.meta.height;
    if (g.vf) {
      const vf = g.vf;
      try {
        const vr = vf.visibleRect, info = this.#info, f = vf.format ?? '', bits = /P1[02]$/.test(f) ? Number(f.slice(-2)) : /^(I4|NV12)/.test(f) ? 8 : 0;
        if (!bits || !vr) throw new Error(`frame format ${vf.format}`);
        const rect = { x: vr.x, y: vr.y, width: vr.width, height: vr.height }, buf = new Uint8Array(vf.allocationSize({ rect }));
        await vf.copyTo(buf, { rect });
        // Range as in the codec path: bitstream / container first, then the decoder's report, else limited.
        const full = info.fullRange ?? (typeof vf.colorSpace?.fullRange === 'boolean' ? vf.colorSpace.fullRange : null);
        const lut = this.#lut ??= lumaLut(bits, full !== true) ?? identity8(), n = vr.width * vr.height;
        const src = bits > 8 ? new Uint16Array(buf.buffer, 0, n) : buf, y8 = new Uint8Array(n);
        for (let i = 0; i < n; i++) y8[i] = lut[src[i]];
        const r = info.rotation ? rotatePlane(y8, vr.width, vr.height, info.rotation).data : y8;
        if (r.length !== W * H) throw new Error('visible size differs from the element');
        return r;
      } catch (e) {
        // This frame was already presented: draw the element now (still showing it), and use the canvas from now on.
        this.#readback = this.stats.readback = 'canvas';
        this.stats.readbackError = String(e?.message ?? e);
        return this.#finish(this.#grab());
      } finally { vf.close(); }
    }
    return rgbaToLuma(this.#ctx.getImageData(0, 0, W, H).data, W, H, { hd: this.#hd });
  }

  /** @param {import('../types.js').FramesOptions} [opts] */
  async *frames({ from = 0, to = this.meta.frameCount, stride = 1, signal } = {}) {
    if (this.#closed) throw new HFError('closed', 'source is closed');
    checkFrames(from, to, stride);
    if (this.#busy) throw new HFError('busy', 'another frames() iteration is live');
    this.#busy = true;
    const n = this.meta.frameCount, a = Math.min(Math.max(from, 0), n), b = Math.min(Math.max(to, 0), n);
    let ref = null;
    this.#lastMt = null;
    try {
      for (let k = a; k < b; k += stride) {
        throwIfAborted(signal);
        ref?.close();
        const { plane, mediaTime, verified } = await this.#read(k, signal);
        if (this.#closed) throw new HFError('closed', 'source is closed');
        ref = planeRef(k, this.meta.times[k], plane, this.meta.width, this.meta.height, { mediaTime, verified });
        yield ref;
      }
    } finally {
      ref?.close();
      this.#busy = false;
    }
  }

  async close() {
    this.#closed = true;
    const v = this.#video;
    if (v) { v.pause?.(); v.removeAttribute?.('src'); v.load?.(); v.remove?.(); }
    if (this.#url) this.#env.URL.revokeObjectURL(this.#url);
    this.#video = this.#url = this.#ctx = this.#canvas = null;
  }
}
const identity8 = () => Uint8Array.from({ length: 256 }, (_, i) => i);

/* ------------------------------------------------------------------ main-thread server */

const isSource = v => v && typeof v.frames === 'function' && v.meta && typeof v.close === 'function';

/**
 * Answer a RemoteFrameSource on port until it sends 'close' or signal aborts (protocol doc §11). fileOrBlob may
 * also be an open FrameSource (tests), which the server then closes on 'close'.
 * @param {Blob|import('../types.js').FrameSource} fileOrBlob
 * @param {MessagePort} port
 * @param {{signal?:AbortSignal, params?:object, env?:object}} [opts]
 * @returns {Promise<void>}
 */
export function serveElementFrames(fileOrBlob, port, { signal, params = PARAMS, env } = {}) {
  let source = isSource(fileOrBlob) ? fileOrBlob : null, opening = null, cur = null, finished = false, last = Promise.resolve();
  return new Promise(resolve => {
    const post = (m, transfer = []) => { try { port.postMessage(m, transfer); } catch { /* port closed */ } };
    const finish = async () => {
      if (finished) return;
      finished = true;
      port.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', finish);
      if (cur) cur.stop = true, cur.wake?.();
      try { await source?.close(); } catch { /* ignore */ }
      port.close?.();
      resolve();
    };
    const open = jobId => (opening ??= (async () => {
      source ??= await ElementFrameSource.open(fileOrBlob, { signal, params, ...(env ? { env } : {}) });
      return source;
    })());
    async function stream(m, prev) {
      const it = { id: m.iter, jobId: m.jobId, credit: Math.max(1, m.credit | 0), stop: false, wake: null };
      if (cur) { cur.stop = true; cur.wake?.(); }
      cur = it;
      let iter = null;
      try {
        await prev; // the previous iteration releases the source first
        const src = await open(m.jobId), W = src.meta.width, H = src.meta.height;
        if (it.stop) return;
        iter = src.frames({ from: m.from, to: m.to, stride: m.stride, signal })[Symbol.asyncIterator]();
        for (;;) {
          while (it.credit <= 0 && !it.stop) await new Promise(r => { it.wake = r; });
          if (it.stop) break;
          const { value: ref, done } = await iter.next();
          if (done || it.stop) break;
          let plane = 'plane' in ref ? ref.plane : (await ref.lumaRect({ x: 0, y: 0, w: W, h: H })).data;
          if (plane.byteOffset || plane.byteLength !== plane.buffer.byteLength) plane = plane.slice();
          it.credit--;
          post({ type: 'frame', jobId: m.jobId, iter: it.id, index: ref.index, t: ref.t, mediaTime: ref.mediaTime ?? null, verified: ref.verified ?? null, w: W, h: H, luma: plane.buffer }, [plane.buffer]);
        }
      } catch (e) {
        if (!finished) post({ type: 'error', jobId: m.jobId, iter: it.id, code: isAbort(e) ? 'aborted' : (e?.code ?? 'decode'), message: String(e?.message ?? e) });
      } finally {
        await iter?.return?.();
        if (cur === it) cur = null;
        if (!finished) post({ type: 'end', jobId: m.jobId, iter: it.id, stats: source?.stats ? { ...source.stats } : null });
      }
    }
    async function onMessage({ data: m }) {
      if (!m || typeof m !== 'object' || finished) return;
      if (m.type === 'open') {
        try { const src = await open(m.jobId); post({ type: 'meta', jobId: m.jobId, meta: src.meta, stats: src.stats ?? null }); }
        catch (e) { post({ type: 'error', jobId: m.jobId, code: e?.code ?? 'unsupported', message: String(e?.message ?? e) }); }
      } else if (m.type === 'frames') last = stream(m, last);
      else if (m.type === 'ack') { if (cur && cur.id === m.iter) { cur.credit += Math.max(0, m.n | 0); cur.wake?.(); } }
      else if (m.type === 'stop') { if (cur && cur.id === m.iter) { cur.stop = true; cur.wake?.(); } }
      else if (m.type === 'close') finish();
    }
    port.addEventListener('message', onMessage);
    port.start?.();
    if (signal?.aborted) finish(); else signal?.addEventListener('abort', finish, { once: true });
  });
}

/* ------------------------------------------------------------------ worker-side proxy */

let jobs = 0;
// Element ports a RemoteFrameSource has opened on (claimed), and ports whose main-thread server was told to stop
// (released): a released port has nobody answering, so opening on it fails fast instead of waiting forever.
const claimed = new WeakSet(), released = new WeakSet();

/**
 * Tell the main-thread serveElementFrames on `port` to stop ({type:'close', jobId}), so it releases its video element
 * and resolves. A no-op (false) when a RemoteFrameSource has claimed the port (that source closes it) or it was
 * released already. CodecFrameSource.close() calls this for the element port it made unnecessary (protocol doc §11).
 * @returns {boolean} whether the close message was posted
 */
export function releaseElementPort(port, jobId = null) {
  if (!port || typeof port.postMessage !== 'function' || claimed.has(port) || released.has(port)) return false;
  released.add(port);
  try { port.postMessage({ type: 'close', jobId }); } catch { /* port gone */ }
  return true;
}

export class RemoteFrameSource {
  /**
   * @param {MessagePort} port  connected to serveElementFrames
   * @param {{signal?:AbortSignal, jobId?:string, params?:object}} [opts]
   * @returns {Promise<RemoteFrameSource>}
   */
  static async open(port, { signal, jobId = `e${Date.now().toString(36)}-${++jobs}`, params = PARAMS } = {}) {
    if (!port || typeof port.postMessage !== 'function') throw new HFError('bad-arg', 'RemoteFrameSource needs a MessagePort');
    if (released.has(port)) throw new HFError('closed', 'this element port was released (its server was told to close)');
    claimed.add(port);
    const src = new RemoteFrameSource(port, jobId, params);
    const reply = await src.#request(m => m.type === 'meta' || (m.type === 'error' && m.iter === undefined), { type: 'open', jobId }, signal);
    if (reply.type === 'error') { src.#detach(); throw portError(reply.code, reply.message, 'unsupported'); }
    src.meta = makeSourceMeta(reply.meta);
    src.stats = reply.stats ?? null;
    return src;
  }

  #port; #jobId; #params; #inbox = []; #waiters = []; #iter = 0; #live = 0; #busy = false; #closed = false; #listener;

  constructor(port, jobId, params) {
    this.#port = port; this.#jobId = jobId; this.#params = params;
    /** @type {import('../types.js').SourceMeta} */
    this.meta = null;
    this.#listener = ({ data: m }) => {
      if (!m || m.jobId !== this.#jobId || (m.iter !== undefined && m.iter !== this.#live)) return; // stale iterations are dropped
      this.#inbox.push(m);
      for (const w of this.#waiters.splice(0)) w();
    };
    port.addEventListener('message', this.#listener);
    port.start?.();
  }

  #detach() { this.#port.removeEventListener('message', this.#listener); for (const w of this.#waiters.splice(0)) w(); }

  /** Next inbox message matching pick (others stay queued); rejects on abort or close. */
  async #next(pick, signal) {
    for (;;) {
      throwIfAborted(signal);
      if (this.#closed) throw new HFError('closed', 'source is closed');
      const i = this.#inbox.findIndex(pick);
      if (i >= 0) return this.#inbox.splice(i, 1)[0];
      await new Promise(r => {
        const ab = () => r();
        this.#waiters.push(() => { signal?.removeEventListener('abort', ab); r(); });
        signal?.addEventListener('abort', ab, { once: true });
      });
    }
  }
  #request(pick, msg, signal) { this.#port.postMessage(msg); return this.#next(pick, signal); }

  /** @param {import('../types.js').FramesOptions} [opts] */
  async *frames({ from = 0, to = this.meta.frameCount, stride = 1, signal } = {}) {
    if (this.#closed) throw new HFError('closed', 'source is closed');
    checkFrames(from, to, stride);
    if (this.#busy) throw new HFError('busy', 'another frames() iteration is live');
    this.#busy = true;
    const iter = this.#live = ++this.#iter, jobId = this.#jobId, n = this.meta.frameCount, W = this.meta.width, H = this.meta.height;
    const a = Math.min(Math.max(from, 0), n), b = Math.min(Math.max(to, 0), n);
    let ref = null, ended = a >= b;
    const mine = m => m.iter === iter && (m.type === 'frame' || m.type === 'end' || m.type === 'error');
    try {
      if (ended) return;
      this.#port.postMessage({ type: 'frames', jobId, iter, from: a, to: b, stride, credit: this.#params.decode.elementCredit });
      for (let expect = a; expect < b; expect += stride) {
        const m = await this.#next(mine, signal);
        if (m.type === 'end') { ended = true; this.stats = m.stats ?? this.stats; throw new HFError('decode', `element source ended before frame ${expect}`); }
        if (m.type === 'error') { ended = true; throw portError(m.code, m.message, 'decode'); }
        if (m.index !== expect || m.w !== W || m.h !== H) throw new HFError('decode', `element frame ${m.index} (${m.w}×${m.h}), expected ${expect}`);
        ref?.close();
        ref = planeRef(m.index, this.meta.times[m.index], new Uint8Array(m.luma), W, H, { mediaTime: m.mediaTime, verified: m.verified ?? null });
        yield ref;
        this.#port.postMessage({ type: 'ack', jobId, iter, n: 1 });
      }
      const m = await this.#next(mine, signal);
      ended = m.type === 'end' || m.type === 'error';
      if (m.type === 'end') this.stats = m.stats ?? this.stats;
    } finally {
      ref?.close();
      if (!ended && !this.#closed) this.#port.postMessage({ type: 'stop', jobId, iter });
      // Drop whatever this iteration still has queued; the listener ignores its late messages.
      this.#live = 0;
      this.#inbox = this.#inbox.filter(m => m.iter !== iter);
      this.#busy = false;
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    released.add(this.#port);
    try { this.#port.postMessage({ type: 'close', jobId: this.#jobId }); } catch { /* port gone */ }
    this.#detach();
  }
}
