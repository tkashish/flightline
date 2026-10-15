// Fake DOM for ElementFrameSource tests: a <video> whose seeks present a frame chosen by seekMap (default: the
// frame shown at that time; tests make some frames stale or unreachable), requestVideoFrameCallback with mediaTime,
// playback that presents frames in order (1 ms per frame), a 2D canvas whose readback is the presented frame, and
// `new VideoFrame(video)` that copies the coded Y plane. Frame k's picture: coded Y = codedY(k); the upright
// full-range luma both readbacks must produce is upright(k) = rotate(limited-range expansion(codedY(k))).
import { lumaLut, rotatePlane } from '../../../dist/hf/decode/planes.js';
import { displaySize } from '../../../dist/hf/decode/orient.js';

export function codedY(k, cw, ch) {
  const y = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) y[j * cw + i] = 16 + ((k * 29 + i * 5 + j * 3 + ((i * j) % 7) * 11) % 220);
  return y;
}
export const upright = (k, cw, ch, rotation) => rotatePlane(Uint8Array.from(codedY(k, cw, ch), v => lumaLut(8, true)[v]), cw, ch, rotation).data;

/**
 * @param {{times:ArrayLike<number>, cw:number, ch:number, rotation?:number, duration?:number, seekMap?:(t:number, cur:number, n:number)=>number,
 *   rvfc?:boolean, videoFrame?:boolean, failLoad?:boolean, presentBeforeSeeked?:boolean, frameFormat?:string}} o
 */
export function fakeDom(o) {
  const { times, cw, ch, rotation = 0, rvfc = true } = o, n = times.length, { width: W, height: H } = displaySize(cw, ch, rotation);
  const log = { seeks: [], plays: [], pauses: 0, created: [], appended: 0, removed: 0, revoked: [], urls: 0, draws: 0, videoFrames: 0 };
  const shownAt = t => { let k = 0; for (let i = 0; i < n; i++) if (times[i] <= t + 1e-9) k = i; return k; };
  let video = null;

  class FakeVideo extends EventTarget {
    constructor() { super(); this.style = {}; this.muted = false; this.paused = true; this.playbackRate = 1; this.readyState = 0; this._k = 0; this._t = 0; this._cbs = new Map(); this._id = 0; this._presented = 0; this._timer = null; }
    get videoWidth() { return this.readyState ? W : 0; }
    get videoHeight() { return this.readyState ? H : 0; }
    get duration() { return o.duration ?? (times[n - 1] + (n > 1 ? times[n - 1] - times[n - 2] : 1 / 30)); }
    set src(url) {
      this._src = url;
      setTimeout(() => {
        if (o.failLoad) { this.dispatchEvent(new Event('error')); return; }
        this.readyState = 4; this._k = 0; this.dispatchEvent(new Event('loadeddata'));
      }, 0);
    }
    get src() { return this._src; }
    get currentTime() { return this._t; }
    set currentTime(t) {
      log.seeks.push(t);
      this._t = t;
      const k = (o.seekMap ?? ((tt) => shownAt(tt)))(t, this._k, n);
      // As in browsers, the new frame is current (drawable) when 'seeked' fires; rVFC may run before or after it.
      setTimeout(() => {
        this._k = k;
        if (o.presentBeforeSeeked) this._present();
        this.dispatchEvent(new Event('seeked'));
        if (!o.presentBeforeSeeked) setTimeout(() => this._present(), 0);
      }, 0);
    }
    _present() {
      this._presented++;
      const md = { mediaTime: times[this._k], presentedFrames: this._presented }, cbs = [...this._cbs.values()];
      this._cbs.clear();
      for (const cb of cbs) cb(performance.now(), md);
    }
    play() {
      if (!this.paused) return Promise.resolve();
      this.paused = false; log.plays.push(this.playbackRate);
      const step = () => {
        if (this.paused) return;
        if (this._k + 1 >= n) { this.paused = true; return; }
        this._k++; this._t = times[this._k]; this._present();
        this._timer = setTimeout(step, 1);
      };
      this._timer = setTimeout(step, 1);
      return Promise.resolve();
    }
    pause() { if (!this.paused) log.pauses++; this.paused = true; clearTimeout(this._timer); }
    load() {}
    removeAttribute(a) { if (a === 'src') this._src = ''; }
    remove() { log.removed++; }
  }
  if (rvfc) {
    FakeVideo.prototype.requestVideoFrameCallback = function (cb) { const id = ++this._id; this._cbs.set(id, cb); return id; };
    FakeVideo.prototype.cancelVideoFrameCallback = function (id) { this._cbs.delete(id); };
  }

  class FakeContext {
    constructor(c) { this.canvas = c; this._k = 0; }
    drawImage(v) { log.draws++; this._k = v._k; }
    getImageData(x, y, w, h) {
      const lum = upright(this._k, cw, ch, rotation), data = new Uint8ClampedArray(4 * w * h);
      for (let i = 0; i < w * h; i++) { data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = lum[i]; data[4 * i + 3] = 255; }
      return { data, width: w, height: h };
    }
  }
  class FakeCanvas { constructor(w, h) { this.width = w; this.height = h; } getContext() { return this._ctx ??= new FakeContext(this); } }

  class FakeVideoFrame {
    constructor(v) {
      log.videoFrames++;
      this._k = v._k; this.format = 'frameFormat' in o ? o.frameFormat : 'I420'; this.visibleRect = { x: 0, y: 0, width: cw, height: ch };
      this.colorSpace = { fullRange: false, matrix: 'bt709' }; this.timestamp = Math.round(times[v._k] * 1e6); this.closed = false;
    }
    allocationSize() { return cw * ch * 3 / 2; }
    async copyTo(buf) { if (this.closed) throw new DOMException('closed', 'InvalidStateError'); buf.set(codedY(this._k, cw, ch)); buf.fill(128, cw * ch); }
    close() { this.closed = true; }
  }

  const document = {
    hidden: false,
    body: { appendChild: () => { log.appended++; } },
    createElement: tag => {
      log.created.push(tag);
      if (tag === 'video') return (video = new FakeVideo());
      if (tag === 'canvas') return new FakeCanvas(0, 0);
      throw new Error(`fake createElement(${tag})`);
    }
  };
  const env = {
    document, URL: { createObjectURL: () => `blob:fake-${++log.urls}`, revokeObjectURL: u => log.revoked.push(u) },
    OffscreenCanvas: FakeCanvas, setTimeout, clearTimeout, ...(o.videoFrame ? { VideoFrame: FakeVideoFrame } : {})
  };
  return { env, log, video: () => video, W, H };
}
