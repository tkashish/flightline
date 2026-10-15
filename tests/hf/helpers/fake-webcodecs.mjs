// Fake WebCodecs (VideoDecoder, EncodedVideoChunk, VideoFrame) for Node tests of the codec source. The decoder
// "decodes" a chunk by asking render(timestamp) for that frame's coded planes, holds `reorder` frames and emits
// them in timestamp order (B-frame reordering), requires a key chunk after configure/flush like Chrome, and with
// openGop drops frames earlier than the keyframe it started from (leading pictures that need the previous GOP).
// Stats record queue depth, live frames, copies and closes so tests can pin backpressure and leaks.

export class FakeChunk {
  constructor({ type, timestamp, data, duration }) {
    if (type !== 'key' && type !== 'delta') throw new TypeError('chunk type');
    if (!Number.isFinite(timestamp)) throw new TypeError('timestamp');
    this.type = type; this.timestamp = Math.trunc(timestamp); this.duration = duration ?? null;
    this.byteLength = data.byteLength; this.data = new Uint8Array(data.byteLength); this.data.set(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
  }
}

const SUB = { I420: [2, 2], I420P10: [2, 2], NV12: [2, 2], I422: [2, 1], I444: [1, 1], RGBX: [1, 1], BGRX: [1, 1], RGBA: [1, 1] };

/**
 * A fake VideoFrame over a coded picture: y (Uint8Array, or Uint16Array for P10) codedWidth × codedHeight, or
 * rgba (4 bytes per pixel) for RGB formats.
 */
export class FakeFrame {
  constructor(pic, { format, codedWidth, codedHeight, visibleRect, colorSpace, timestamp, stats }) {
    this.pic = pic; this.format = format; this.codedWidth = codedWidth; this.codedHeight = codedHeight;
    this.visibleRect = visibleRect ?? { x: 0, y: 0, width: codedWidth, height: codedHeight };
    this.displayWidth = this.visibleRect.width; this.displayHeight = this.visibleRect.height;
    this.colorSpace = colorSpace; this.timestamp = timestamp; this.stats = stats; this.closed = false;
    stats.live++; stats.maxLive = Math.max(stats.maxLive, stats.live); stats.frames.push(this);
  }
  #rect(o) {
    const r = o?.rect ?? { x: this.visibleRect.x, y: this.visibleRect.y, width: this.visibleRect.width, height: this.visibleRect.height }, [sx, sy] = SUB[this.format] ?? [1, 1];
    const v = this.visibleRect;
    if (r.x % sx || r.y % sy) throw new TypeError(`rect ${r.x},${r.y} not aligned to ${sx}x${sy}`);
    if (r.x < v.x || r.y < v.y || r.x + r.width > v.x + v.width || r.y + r.height > v.y + v.height) throw new TypeError('rect outside the visible rect');
    if (this.stats.noRect && o?.rect) throw new TypeError('rect copies are not supported');
    return r;
  }
  #planes(r) {
    const w = r.width, h = r.height, cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
    switch (this.format) {
      case 'I420': return [[w, h, 1], [cw, ch, 1], [cw, ch, 1]];
      case 'I420P10': return [[w, h, 2], [cw, ch, 2], [cw, ch, 2]];
      case 'NV12': return [[w, h, 1], [2 * cw, ch, 1]];
      case 'I444': return [[w, h, 1], [w, h, 1], [w, h, 1]];
      default: return [[4 * w, h, 1]];
    }
  }
  allocationSize(o) { if (this.closed) throw new DOMException('closed', 'InvalidStateError'); return this.#planes(this.#rect(o)).reduce((s, [w, h, b]) => s + w * h * b, 0); }
  async copyTo(dest, o) {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    const r = this.#rect(o), size = this.allocationSize(o);
    if (dest.byteLength < size) throw new TypeError('destination too small');
    await new Promise(res => setTimeout(res, 0));
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    this.stats.copies.push({ x: r.x, y: r.y, w: r.width, h: r.height, full: !o?.rect });
    const out = new Uint8Array(dest.buffer, dest.byteOffset, size);
    if (this.pic.rgba) {
      for (let y = 0; y < r.height; y++) out.set(this.pic.rgba.subarray(((r.y + y) * this.codedWidth + r.x) * 4, ((r.y + y) * this.codedWidth + r.x + r.width) * 4), y * r.width * 4);
    } else {
      const bps = this.format === 'I420P10' ? 2 : 1, src = new Uint8Array(this.pic.y.buffer, this.pic.y.byteOffset, this.pic.y.byteLength);
      for (let y = 0; y < r.height; y++) out.set(src.subarray(((r.y + y) * this.codedWidth + r.x) * bps, ((r.y + y) * this.codedWidth + r.x + r.width) * bps), y * r.width * bps);
      out.fill(128, r.width * r.height * bps); // chroma
    }
    return this.#planes(r).map(([w, , b], i, a) => ({ offset: a.slice(0, i).reduce((s, [pw, ph, pb]) => s + pw * ph * pb, 0), stride: w * b }));
  }
  close() { if (!this.closed) { this.closed = true; this.stats.live--; this.stats.closed++; } }
}

/**
 * @param {{render:(timestamp:number)=>({y?:Uint8Array|Uint16Array, rgba?:Uint8Array}), format?:string, codedWidth:number,
 *   codedHeight:number, visibleRect?:object, colorSpace?:object, reorder?:number, openGop?:boolean, supported?:boolean,
 *   failAfter?:number, dropTimestamps?:number[], configureThrows?:boolean, noRect?:boolean, delayMs?:number}} o
 */
export function fakeWebCodecs(o) {
  const stats = { live: 0, maxLive: 0, maxQueue: 0, decoded: 0, fed: [], configured: 0, closed: 0, frames: [], copies: [], decoders: 0, noRect: !!o.noRect };
  const format = 'format' in o ? o.format : 'I420', reorder = o.reorder ?? 2;
  class VideoDecoder extends EventTarget {
    static async isConfigSupported(config) { return { supported: o.supported ?? true, config }; }
    #out; #err; #queue = []; #held = []; #needKey = true; #start = null; #busy = false; #flushes = [];
    constructor({ output, error }) { super(); this.#out = output; this.#err = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; stats.decoders++; }
    configure(config) {
      if (this.state === 'closed') throw new DOMException('closed', 'InvalidStateError');
      if (o.configureThrows) throw new TypeError('bad config');
      this.state = 'configured'; this.config = config; this.#needKey = true; stats.configured++;
    }
    decode(chunk) {
      if (this.state !== 'configured') throw new DOMException(`decode in state ${this.state}`, 'InvalidStateError');
      if (this.#needKey && chunk.type !== 'key') throw new DOMException('A key frame is required after configure() or flush()', 'DataError');
      if (this.#needKey) { this.#needKey = false; this.#start = chunk.timestamp; }
      this.#queue.push(chunk); this.decodeQueueSize++; stats.maxQueue = Math.max(stats.maxQueue, this.decodeQueueSize); stats.fed.push(chunk.timestamp);
      this.#pump();
    }
    #pump() {
      if (this.#busy) return;
      this.#busy = true;
      setTimeout(() => {
        this.#busy = false;
        if (this.state !== 'configured') return;
        const chunk = this.#queue.shift();
        if (!chunk) { this.#settle(); return; }
        this.decodeQueueSize--;
        this.dispatchEvent(new Event('dequeue'));
        stats.decoded++;
        if (o.failAfter != null && stats.decoded > o.failAfter) { this.#fail(new DOMException('fake decode failure', 'EncodingError')); return; }
        const dropped = (o.openGop && chunk.timestamp < this.#start) || o.dropTimestamps?.includes(chunk.timestamp);
        if (!dropped) {
          this.#held.push(chunk.timestamp);
          this.#held.sort((a, b) => a - b);
          while (this.#held.length > reorder) this.#emit(this.#held.shift());
        }
        if (this.#queue.length) this.#pump(); else this.#settle();
      }, o.delayMs ?? 0);
    }
    #emit(ts) {
      const pic = o.render(ts);
      this.#out(new FakeFrame(pic, { format, codedWidth: o.codedWidth, codedHeight: o.codedHeight, visibleRect: o.visibleRect, colorSpace: o.colorSpace ?? { fullRange: false, matrix: 'bt709' }, timestamp: ts, stats }));
    }
    #settle() {
      if (this.#queue.length || !this.#flushes.length) return;
      while (this.#held.length) this.#emit(this.#held.shift());
      this.#needKey = true;
      for (const f of this.#flushes.splice(0)) f.resolve();
    }
    #fail(e) {
      this.state = 'closed'; this.#queue = []; this.#held = []; this.decodeQueueSize = 0;
      for (const f of this.#flushes.splice(0)) f.reject(e);
      this.#err(e);
    }
    flush() {
      if (this.state !== 'configured') return Promise.reject(new DOMException('flush', 'InvalidStateError'));
      return new Promise((resolve, reject) => { this.#flushes.push({ resolve, reject }); if (!this.#queue.length && !this.#busy) this.#settle(); });
    }
    reset() { this.#queue = []; this.#held = []; this.decodeQueueSize = 0; this.state = 'unconfigured'; for (const f of this.#flushes.splice(0)) f.reject(new DOMException('reset', 'AbortError')); }
    close() { this.#queue = []; this.#held = []; this.decodeQueueSize = 0; this.state = 'closed'; for (const f of this.#flushes.splice(0)) f.reject(new DOMException('closed', 'AbortError')); }
  }
  return { VideoDecoder, EncodedVideoChunk: FakeChunk, stats };
}
