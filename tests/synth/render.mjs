// Per-frame compositor. Static background (optical PSF applied once) warped by the per-row camera rotation
// (grid-interpolated, so it also covers rolling shutter, zoom and lens distortion); shadows; z-buffered bodies;
// motion-blurred club, ball and distractors by sub-sampling the exposure, with the ball depth-tested against the
// club per exposure phase; lens-space layers; sensor model (AE, vignette, tone, noise, luma sharpening).
import { DEG, clamp, smooth, add, sub, scale, addS, norm, dot, mix, hash32, sfc32Seed, invNormal } from './math.mjs';
import { makeView, project, rayDir, rsOffset } from './camera.mjs';
import { BALL, ballAt } from './ball-physics.mjs';
import { golferPrims } from './golfer.mjs';
import { clubPrims } from './club.mjs';
import { renderBackground, classifyRay } from './scene.mjs';
import { makeFrame, makeAcc, resetAcc, compositeAcc, prepCapsule, drawCapsule, drawSpot, applyMask, gam } from './raster.mjs';
import { planePrims, birdPrims, birdAt, insectAt, walkerPrims, flagPrims, particleAt, teePrims } from './distractors.mjs';

const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Unit-variance normal deviates for 16-bit uniforms (bin centres): one sfc32 output gives a luma and a chroma deviate. */
const GAUSS16 = (() => { const t = new Float32Array(65536); let v = 0; for (let i = 0; i < 65536; i++) { t[i] = invNormal((i + 0.5) / 65536); v += t[i] * t[i]; } const s = Math.sqrt(65536 / v); for (let i = 0; i < 65536; i++) t[i] *= s; return t; })();

export class Renderer {
  constructor(world, { noise = true, keepPatches = true, hideBall = false } = {}) {
    this.w = world; this.noiseOn = noise; this.keepPatches = keepPatches; this.hideBall = hideBall;
    const { intr, place, scene, sensor, timeline, spec } = world, W = intr.W, H = intr.H;
    this.W = W; this.H = H;
    this.baseView = makeView(intr, place.C, { yaw: place.yaw, pitch: place.pitch, roll: place.roll, zoom: 1 });
    this.light = scene.light;
    // Margin: how far any frame (and its readout) maps outside the base canvas.
    let need = 16;
    const corners = [[0, 0], [W, 0], [0, H], [W, H], [W / 2, 0], [W / 2, H], [0, H / 2], [W, H / 2]];
    for (let i = 0; i < timeline.N; i += Math.max(1, Math.round(timeline.N / 60))) for (const dt of [-0.02, 0, 0.02]) {
      const v = this.viewAt(timeline.frames[i].tc + dt);
      for (const [u, q] of corners) { const p = project(this.baseView, add(v.C, rayDir(v, u, q))); need = Math.max(need, -p.x, p.x - W, -p.y, p.y - H); }
    }
    const cl = scene.clouds, drift = cl.cover > 0.05 && spec.cloudDrift !== false;
    const span = world.tEnd - world.tStart;
    this.drift = drift ? [cl.drift[0] * 0.35 * intr.f / 1400, cl.drift[1] * 0.08 * intr.f / 1400] : null;
    const M = Math.ceil(need + 8 + (drift ? Math.hypot(...this.drift) * span : 0));
    this.bg = renderBackground(scene, this.baseView, { margin: M, cloudLayer: drift });
    // Optical PSF on the static layers; moving objects carry it in their edge ramps (light.aa) and the ball in its profile.
    const a = Math.max(0, sensor.psf ** 2 - 0.09) / 2;
    if (a > 0) { blur3(this.bg.fg, this.bg.BW, this.bg.BH, a); if (this.bg.sky) blur3(this.bg.sky, this.bg.BW, this.bg.BH, a); }
    this.still = !sensor.rs && !world.shake.sigmaDeg && !world.shake.tremorDeg && !world.pan && !world.zoom && !drift;
    if (drift) { const al = this.bg.alpha; this.alpha8 = new Uint8Array(al.length); for (let i = 0; i < al.length; i++) this.alpha8[i] = Math.round(clamp(al[i], 0, 1) * 255); }
    this.F = makeFrame(W, H); this.acc = makeAcc(W, H); this.mask = new Float32Array(W * H);
    // Exposure: meter the base frame like phone auto-exposure.
    // Metering on the subject region (lower part, centre), robust to a bright sky: phones expose the golfer and
    // let overcast or hazy skies run toward white.
    const lum = [], bg = this.bg;
    for (let y = Math.round(H * 0.3); y < H; y += 8) for (let x = Math.round(W * 0.1); x < W * 0.9; x += 8) { const o = ((y + M) * bg.BW + x + M) * 3; lum.push(lumaOf(bg.fg[o], bg.fg[o + 1], bg.fg[o + 2])); }
    lum.sort((a, b) => a - b);
    this.g0 = clamp(sensor.target / Math.max(20, lum[Math.floor(lum.length * 0.45)]), 0.6, 2.4);
    // Static gain map: vignette and lens dust.
    this.gainMap = new Float32Array(W * H);
    const R2 = (W * W + H * H) / 4;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2; this.gainMap[y * W + x] = 1 - sensor.vignette * (dx * dx + dy * dy) / R2; }
    for (const s of world.D.specks) {
      const ext = Math.ceil(s.rad * 2.5);
      for (let y = Math.max(0, Math.floor(s.y - ext)); y < Math.min(H, s.y + ext); y++) for (let x = Math.max(0, Math.floor(s.x - ext)); x < Math.min(W, s.x + ext); x++) {
        const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) / s.rad, k = Math.exp(-d * d * 1.3); this.gainMap[y * W + x] *= 1 + (s.gain - 1) * k;
      }
    }
    // Tone curve with a soft highlight knee, and luma-dependent noise sigma.
    this.tone = new Float32Array(1024);
    const knee = sensor.knee;
    for (let i = 0; i < 1024; i++) { const v = i * 0.5; this.tone[i] = v < knee ? v : knee + (255 - knee) * (1 - Math.exp(-(v - knee) / (255 - knee))); }
    this.sig = new Float32Array(256);
    for (let y = 0; y < 256; y++) this.sig[y] = Math.sqrt(sensor.noise.read ** 2 + sensor.noise.shot ** 2 * (0.15 + 0.85 * y / 255)) * (1.1 - 0.35 * (y / 255) ** 2);
    this.chromaOn = noise && sensor.noise.chroma > 0.25;
    this.patches = [];
    this.prevOut = null;
    if (world.D.netFront) this.netOverlay = this.renderNet(M);
  }
  viewAt(t) { const w = this.w; return makeView(w.intr, w.place.C, w.motion(t)); }
  /**
   * Frame k's sensor noise, independent from frame to frame (its own sfc32 stream, hash(seed, 'noise', k)), with mild
   * spatial correlation (ISP denoise leaves blotchy noise): a separable 3-tap filter, renormalized to unit variance.
   */
  noiseFields(k) {
    const { W, H } = this, c = this.w.sensor.noise.corr, k0 = c * 0.25, k1 = 1 - c * 0.5, s = 1 / (2 * k0 * k0 + k1 * k1), G = GAUSS16, ch = this.chromaOn;
    const L = this.nl ||= new Float32Array(W * H), C = ch ? (this.nc ||= new Float32Array(W * H)) : null, We = W + (W & 1);
    const hl = this.nHL ||= [0, 1, 2].map(() => new Float32Array(We)), hc = this.nHC ||= [0, 1, 2].map(() => new Float32Array(We));
    let [a, b, cc, d] = sfc32Seed(hash32(this.w.spec.seed, 'noise', k)), t = 0;
    for (let i = 0; i < 12; i++) { t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = cc + (cc << 3) | 0; cc = cc << 21 | cc >>> 11; cc = cc + t | 0; }
    // Rows of horizontally filtered deviates (one row of margin each side), then the vertical tap per output row. With
    // chroma, each draw gives a luma and a chroma deviate; without, two luma deviates.
    for (let j = 0; j < H + 2; j++) {
      const h = hl[j % 3], g = hc[j % 3];
      t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = cc + (cc << 3) | 0; cc = cc << 21 | cc >>> 11; cc = cc + t | 0;
      let l0 = G[t >>> 16], l1 = G[t & 0xffff], c0 = 0, c1 = 0;
      if (ch) {
        c0 = l1; t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = cc + (cc << 3) | 0; cc = cc << 21 | cc >>> 11; cc = cc + t | 0; l1 = G[t >>> 16]; c1 = G[t & 0xffff];
        for (let x = 0; x < W; x++) {
          t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = cc + (cc << 3) | 0; cc = cc << 21 | cc >>> 11; cc = cc + t | 0;
          const l2 = G[t >>> 16], c2 = G[t & 0xffff]; h[x] = k0 * (l0 + l2) + k1 * l1; g[x] = k0 * (c0 + c2) + k1 * c1; l0 = l1; l1 = l2; c0 = c1; c1 = c2;
        }
      } else for (let x = 0; x < We; x += 2) {
        t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = cc + (cc << 3) | 0; cc = cc << 21 | cc >>> 11; cc = cc + t | 0;
        const l2 = G[t >>> 16], l3 = G[t & 0xffff]; h[x] = k0 * (l0 + l2) + k1 * l1; h[x + 1] = k0 * (l1 + l3) + k1 * l2; l0 = l2; l1 = l3;
      }
      if (j < 2) continue;
      const o = (j - 2) * W, a0 = hl[(j + 1) % 3], a1 = hl[(j + 2) % 3];
      for (let x = 0; x < W; x++) L[o + x] = (k0 * (a0[x] + h[x]) + k1 * a1[x]) * s;
      if (ch) { const b0 = hc[(j + 1) % 3], b1 = hc[(j + 2) % 3]; for (let x = 0; x < W; x++) C[o + x] = (k0 * (b0[x] + g[x]) + k1 * b1[x]) * s; }
    }
    return { L, C };
  }
  renderNet(M) {
    const { W, H } = this, net = this.w.D.netFront, BW = W + 2 * M, BH = H + 2 * M, a = new Float32Array(BW * BH), v = this.baseView;
    const fw = v.fw, P0 = addS(v.C, fw, net.dist), n = norm(add(fw, [0, net.tilt, 0]));
    const ex = norm([fw[2], 0, -fw[0]]), ey = [0, 1, 0];
    for (let py = 0; py < BH; py++) for (let px = 0; px < BW; px++) {
      const d = rayDir(v, px - M + 0.5, py - M + 0.5), den = dot(d, n); if (den <= 1e-6) continue;
      const s = dot(sub(P0, v.C), n) / den, q = sub(addS(v.C, d, s), P0), u = dot(q, ex) / net.cell, w = dot(q, ey) / net.cell;
      const fp = s / (v.f * net.cell), wire = net.wire / net.cell, blur = Math.max(fp, 0.04);
      const du = Math.abs(u - Math.round(u)), dw = Math.abs(w - Math.round(w)), cu = clamp((wire / 2 + blur / 2 - du) / blur, 0, 1), cw = clamp((wire / 2 + blur / 2 - dw) / blur, 0, 1);
      a[py * BW + px] = Math.min(0.85, (cu + cw - cu * cw) * 0.8);
    }
    return { a, BW, M };
  }
  /** Base-canvas coordinates for a grid of output pixels at the frame's (per-row) capture times. */
  warpGrid(tc) {
    const { W, H } = this, rs = this.w.sensor.rs, distort = !!this.w.intr.k1, cell = distort ? 32 : 64, nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
    const gx = new Float32Array(nx * ny), gy = new Float32Array(nx * ny), M = this.bg.M, bv = this.baseView;
    const vFrame = rs ? null : this.viewAt(tc), cache = new Map();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u = Math.min(W, i * cell), q = Math.min(H, j * cell);
      let v = vFrame;
      if (rs) { const t = tc + rsOffset(rs, W, H, u, q), key = Math.round(t * 2e4); v = cache.get(key); if (!v) { v = this.viewAt(t); cache.set(key, v); } }
      const p = project(bv, add(v.C, rayDir(v, u, q)));
      gx[j * nx + i] = p.x + M; gy[j * nx + i] = p.y + M;
    }
    return { gx, gy, nx, ny, cell };
  }
  warpBackground(tc) {
    if (this.still) {
      // Tripod, no drift: the warp is the identity, so copy the canvas rows.
      const { W, H, F, bg } = this, M = bg.M;
      this.grid ||= this.warpGrid(tc);
      for (let y = 0; y < H; y++) { const q = ((y + M) * bg.BW + M) * 3; F.rgb.set(bg.fg.subarray(q, q + W * 3), y * W * 3); }
      return;
    }
    const { W, H, F, bg } = this, g = this.warpGrid(tc), rgb = F.rgb, BW = bg.BW, BH = bg.BH, fg = bg.fg, sky = bg.sky, a8 = this.alpha8;
    const dx = this.drift ? this.drift[0] * (tc - this.w.tStart) : 0, dy = this.drift ? this.drift[1] * (tc - this.w.tStart) : 0;
    const rowX = new Float32Array(g.nx), rowY = new Float32Array(g.nx), mx = BW - 2.001, my = BH - 2.001;
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / g.cell, j = Math.min(g.ny - 2, Math.floor(fy)), wy = fy - j;
      for (let i = 0; i < g.nx; i++) { const a = j * g.nx + i, b = a + g.nx; rowX[i] = g.gx[a] + (g.gx[b] - g.gx[a]) * wy; rowY[i] = g.gy[a] + (g.gy[b] - g.gy[a]) * wy; }
      let o = y * W * 3;
      if (!sky) { this.warpRowFast(rowX, rowY, g, o, fg, rgb, BW, mx, my); continue; }
      for (let i = 0; i < g.nx - 1; i++) {
        const x0 = i * g.cell, x1 = Math.min(W, x0 + g.cell); if (x0 >= W) break;
        const sx0 = rowX[i], sy0 = rowY[i], ddx = (rowX[i + 1] - sx0) / g.cell, ddy = (rowY[i + 1] - sy0) / g.cell;
        for (let x = x0; x < x1; x++, o += 3) {
          const t = x + 0.5 - x0; let sx = sx0 + ddx * t - 0.5, sy = sy0 + ddy * t - 0.5;
          sx = sx < 0 ? 0 : sx > mx ? mx : sx; sy = sy < 0 ? 0 : sy > my ? my : sy;
          const ix = sx | 0, iy = sy | 0, fx = sx - ix, fyy = sy - iy;
          let src = fg, q, w00, w10, w01, w11, k = 0;
          if (sky) {
            const av = a8[iy * BW + ix];
            if (av === 0) { let ux = sx + dx, uy = sy + dy; ux = ux < 0 ? 0 : ux > mx ? mx : ux; uy = uy < 0 ? 0 : uy > my ? my : uy; const jx = ux | 0, jy = uy | 0, ex = ux - jx, ey = uy - jy; src = sky; q = (jy * BW + jx) * 3; w00 = (1 - ex) * (1 - ey); w10 = ex * (1 - ey); w01 = (1 - ex) * ey; w11 = ex * ey; }
            else k = av === 255 ? 0 : 1 - av / 255;
          }
          if (src === fg) { q = (iy * BW + ix) * 3; w00 = (1 - fx) * (1 - fyy); w10 = fx * (1 - fyy); w01 = (1 - fx) * fyy; w11 = fx * fyy; }
          const q2 = q + BW * 3;
          let r = src[q] * w00 + src[q + 3] * w10 + src[q2] * w01 + src[q2 + 3] * w11;
          let gg = src[q + 1] * w00 + src[q + 4] * w10 + src[q2 + 1] * w01 + src[q2 + 4] * w11;
          let b = src[q + 2] * w00 + src[q + 5] * w10 + src[q2 + 2] * w01 + src[q2 + 5] * w11;
          if (k > 0) {
            // Partial sky (tree tops, net edges): swap in the drifted sky for the sky share of the pixel.
            let ux = sx + dx, uy = sy + dy; ux = ux < 0 ? 0 : ux > mx ? mx : ux; uy = uy < 0 ? 0 : uy > my ? my : uy;
            const jx = ux | 0, jy = uy | 0, ex = ux - jx, ey = uy - jy, s1 = (jy * BW + jx) * 3, s2 = s1 + BW * 3, v00 = (1 - ex) * (1 - ey), v10 = ex * (1 - ey), v01 = (1 - ex) * ey, v11 = ex * ey;
            r += k * (sky[s1] * v00 + sky[s1 + 3] * v10 + sky[s2] * v01 + sky[s2 + 3] * v11 - (sky[q] * w00 + sky[q + 3] * w10 + sky[q2] * w01 + sky[q2 + 3] * w11));
            gg += k * (sky[s1 + 1] * v00 + sky[s1 + 4] * v10 + sky[s2 + 1] * v01 + sky[s2 + 4] * v11 - (sky[q + 1] * w00 + sky[q + 4] * w10 + sky[q2 + 1] * w01 + sky[q2 + 4] * w11));
            b += k * (sky[s1 + 2] * v00 + sky[s1 + 5] * v10 + sky[s2 + 2] * v01 + sky[s2 + 5] * v11 - (sky[q + 2] * w00 + sky[q + 5] * w10 + sky[q2 + 2] * w01 + sky[q2 + 5] * w11));
          }
          rgb[o] = r; rgb[o + 1] = gg; rgb[o + 2] = b;
        }
      }
    }
    this.grid = g;
  }
  warpRowFast(rowX, rowY, g, o, fg, rgb, BW, mx, my) {
    const W = this.W, cell = g.cell, nx = g.nx, B3 = BW * 3;
    for (let i = 0; i < nx - 1; i++) {
      const x0 = i * cell; if (x0 >= W) break;
      const x1 = x0 + cell < W ? x0 + cell : W, ddx = (rowX[i + 1] - rowX[i]) / cell, ddy = (rowY[i + 1] - rowY[i]) / cell;
      let sx = rowX[i] + ddx * 0.5 - 0.5, sy = rowY[i] + ddy * 0.5 - 0.5;
      for (let x = x0; x < x1; x++, o += 3, sx += ddx, sy += ddy) {
        const cx = sx < 0 ? 0 : sx > mx ? mx : sx, cy = sy < 0 ? 0 : sy > my ? my : sy, ix = cx | 0, iy = cy | 0, fx = cx - ix, fy = cy - iy;
        const q = (iy * BW + ix) * 3, q2 = q + B3, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        rgb[o] = fg[q] * w00 + fg[q + 3] * w10 + fg[q2] * w01 + fg[q2 + 3] * w11;
        rgb[o + 1] = fg[q + 1] * w00 + fg[q + 4] * w10 + fg[q2 + 1] * w01 + fg[q2 + 4] * w11;
        rgb[o + 2] = fg[q + 2] * w00 + fg[q + 5] * w10 + fg[q2 + 2] * w01 + fg[q2 + 5] * w11;
      }
    }
  }
  applyNet() {
    const { W, H, F } = this, g = this.grid, N = this.netOverlay, col = this.w.D.netFront.col, rgb = F.rgb, mx = N.BW - 2.001, my = (N.a.length / N.BW) - 2.001, T = F.tr;
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / g.cell, j = Math.min(g.ny - 2, Math.floor(fy)), wy = fy - j;
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / g.cell, i = Math.min(g.nx - 2, Math.floor(fx)), wx = fx - i, a0 = j * g.nx + i;
        const gxv = (g.gx[a0] * (1 - wx) + g.gx[a0 + 1] * wx) * (1 - wy) + (g.gx[a0 + g.nx] * (1 - wx) + g.gx[a0 + g.nx + 1] * wx) * wy - this.bg.M + N.M - 0.5;
        const gyv = (g.gy[a0] * (1 - wx) + g.gy[a0 + 1] * wx) * (1 - wy) + (g.gy[a0 + g.nx] * (1 - wx) + g.gy[a0 + g.nx + 1] * wx) * wy - this.bg.M + N.M - 0.5;
        const sx = clamp(gxv, 0, mx), sy = clamp(gyv, 0, my), ix = sx | 0, iy = sy | 0, u = sx - ix, v = sy - iy, q = iy * N.BW + ix;
        const a = N.a[q] * (1 - u) * (1 - v) + N.a[q + 1] * u * (1 - v) + N.a[q + N.BW] * (1 - u) * v + N.a[q + N.BW + 1] * u * v;
        if (a <= 0.002) continue;
        const o = (y * W + x) * 3, k = 1 - a; rgb[o] = rgb[o] * k + col[0] * a; rgb[o + 1] = rgb[o + 1] * k + col[1] * a; rgb[o + 2] = rgb[o + 2] * k + col[2] * a;
        if (T && x >= T.x0 && x <= T.x1 && y >= T.y0 && y <= T.y1) T.t[(y - T.y0) * T.w + x - T.x0] *= k;
      }
    }
  }
  /** Ball world position (address, nudge, flight) at real time t. */
  ballPos(t) {
    const w = this.w;
    if (!w.hasBall) return null;
    if (t <= 0 || !w.flight) {
      const n = w.nudge; if (!n || t >= n.t0 + n.dur) return w.ballStart;
      const k = t <= n.t0 ? 0 : smooth((t - n.t0) / n.dur); return add(w.ballStart, scale(n.d, 1 - k));
    }
    return ballAt(w.flight, t);
  }
  /** Apparent ball center for a frame: the projection at the readout time of its own row (fixed point). */
  ballImage(tc, P = null) {
    const rs = this.w.sensor.rs; let t = tc, p = null;
    for (let it = 0; it < (rs ? 4 : 1); it++) { const pos = P || this.ballPos(t); if (!pos) return null; p = project(this.viewAt(t), pos); p.t = t; p.pos = pos; if (rs && Number.isFinite(p.x)) t = tc + rsOffset(rs, this.W, this.H, p.x, p.y); }
    return p;
  }
  /** Readout bands for rolling shutter; boundaries shift with the exposure sub-sample so steps average out. */
  bands(frac = 0) {
    const rs = this.w.sensor.rs, { W, H } = this;
    if (!rs) return [{ clip: null, dt: 0 }];
    const n = 48, L = rs.axis === 'x' ? W : H, bw = L / n, out = [];
    for (let b = -1; b < n; b++) {
      const a0 = Math.max(0, Math.floor((b + frac) * bw)), a1 = Math.min(L, Math.floor((b + 1 + frac) * bw)); if (a1 <= a0) continue;
      const c = rs.axis === 'x' ? [a0, 0, a1, H] : [0, a0, W, a1];
      out.push({ clip: c, dt: rsOffset(rs, W, H, (c[0] + c[2]) / 2, (c[1] + c[3]) / 2) });
    }
    return out;
  }
  drawGolferBody(plan, t, offset, view, light) {
    const pose = shiftPose(plan.poseAt(t), offset), prims = golferPrims(pose, plan, light, view.C);
    const cs = prims.filter(p => p.part === 'body').map(p => prepCapsule(view, p, light)).filter(Boolean).sort((a, b) => (b.z0 + b.z1) - (a.z0 + a.z1));
    for (const c of cs) drawCapsule(this.F, c, light);
    return pose;
  }
  shadows(view, t) {
    const L = this.light, sun = L.sun; if (L.sunI < 0.15 || sun[1] < 0.05) return;
    const sy = Math.max(0.18, sun[1]), proj = P => [P[0] - sun[0] * P[1] / sy, 0.002, P[2] - sun[2] * P[1] / sy], box = [this.W, this.H, -1, -1], W = this.W;
    const prims = [];
    const addPrims = (plan, tt, off) => { if (!plan) return; const pose = shiftPose(plan.poseAt(tt), off); for (const p of golferPrims(pose, plan, L, view.C)) if (!p.glint) prims.push(p); };
    addPrims(this.w.plan, t, [0, 0, 0]);
    const nb = this.w.neighbor; if (nb?.drawGolfer) addPrims(nb.plan, t - nb.tImpact, nb.offset);
    const bp = this.ballPos(t); if (bp && bp[1] < 3) prims.push({ a: bp, b: bp, ra: BALL.r, rb: BALL.r, col: [0, 0, 0] });
    for (const p of prims) {
      const c = prepCapsule(view, { ...p, a: proj(p.a), b: proj(p.b), ra: p.ra * 1.15, rb: p.rb * 1.15, sphere: false }, L); if (!c) continue;
      drawCapsule(this.F, c, L, { mode: 'mask', mask: this.mask });
      const R = Math.max(c.R0, c.R1) + 2; box[0] = Math.min(box[0], Math.floor(Math.min(c.x0, c.x1) - R)); box[1] = Math.min(box[1], Math.floor(Math.min(c.y0, c.y1) - R)); box[2] = Math.max(box[2], Math.ceil(Math.max(c.x0, c.x1) + R)); box[3] = Math.max(box[3], Math.ceil(Math.max(c.y0, c.y1) + R));
    }
    // Shadowed ground keeps only the sky term: darkening in display space from the linear ratio.
    const lit = L.amb * 0.9 + L.sunI * Math.max(0.05, sun[1]), k = 1 - Math.pow(L.amb * 0.9 / lit, 1 / 2.2);
    if (box[2] >= box[0]) applyMask(this.F, this.mask, box, clamp(k, 0.05, 0.5));
  }
  /**
   * Fast-layer sub-samples: copies closer than the edge ramp (light.aa) so blur is a smooth sheet, not a comb; when the
   * cap leaves them coarser, the thin shaft gets k extra interpolated sub-samples of its own.
   */
  fastPlan(plan, tc, offset, tShift = 0) {
    const exp = this.w.sensor.exposure, v0 = this.viewAt(tc), at = t => shiftPose(plan.poseAt(t - tShift), offset).club.head, aa = this.light.aa || 1;
    const p0 = project(v0, at(tc - exp / 2)), p1 = project(v0, at(tc + exp / 2)), blur = Number.isFinite(p0.x + p1.x) ? Math.hypot(p1.x - p0.x, p1.y - p0.y) : 0;
    const S = clamp(Math.ceil(blur / (0.6 * aa)) + 1, 2, this.w.sensor.rs ? 64 : 160), gap = blur / S;
    return { S, blur, k: gap > 0.5 * aa ? Math.min(8, Math.ceil(gap / (0.4 * aa))) : 1 };
  }
  /** Sub-sampled fast layer (club, forearms, hands, glints) into the accumulation buffer; nearest depth per phase bin into zb. */
  drawFast(plan, tc, offset, light, zb = null, tShift = 0, fp = this.fastPlan(plan, tc, offset, tShift)) {
    const exp = this.w.sensor.exposure, rs = this.w.sensor.rs, v0 = this.viewAt(tc), S = fp.S, pose = t => shiftPose(plan.poseAt(t - tShift), offset);
    let env = null;
    if (rs) {
      // Rolling shutter: draw only the readout bands the layer can reach during the readout window.
      env = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i <= 8; i++) {
        const t = tc + (i / 8 - 0.5) * (rs.readoutS + exp), v = this.viewAt(t);
        for (const p of golferPrims(pose(t), plan, light, v.C)) {
          if (p.part !== 'fast' || p.glint) continue;
          const c = prepCapsule(v, p, light); if (!c) continue;
          const R = Math.max(c.R0, c.R1) + 3; env[0] = Math.min(env[0], c.x0 - R, c.x1 - R); env[1] = Math.min(env[1], c.y0 - R, c.y1 - R); env[2] = Math.max(env[2], c.x0 + R, c.x1 + R); env[3] = Math.max(env[3], c.y0 + R, c.y1 + R);
        }
      }
      const m = fp.blur / exp * (rs.readoutS + exp) / 8 + 4; env = [env[0] - m, env[1] - m, env[2] + m, env[3] + m];
    }
    let sid = this.sidBase || 0;
    const sweep = (n, shaftOnly) => {
      for (let s = 0; s < n; s++) {
        const u = (s + 0.5) / n;
        if (zb) { zb.b0 = Math.floor(s / n * zb.nb); zb.b1 = Math.max(zb.b0 + 1, Math.ceil((s + 1) / n * zb.nb)); }
        for (const band of this.bands(u)) {
          const cl = band.clip; if (env && cl && (cl[2] <= env[0] || cl[0] > env[2] || cl[3] <= env[1] || cl[1] > env[3])) continue;
          const ts = tc + band.dt + (u - 0.5) * exp, v = cl ? this.viewAt(ts) : v0, ps = pose(ts), opt = { mode: 'acc', acc: this.acc, sid: sid++, invS: 1 / n, clip: cl, zbin: zb };
          if (shaftOnly) {
            // Ends pulled in by the radius so the refined shaft abuts the grip and hosel instead of double-covering them.
            const sp = clubPrims(ps.club, plan.spec, plan.look, light, v.C).find(p => p.tag === 'shaft'), d = norm(sub(sp.b, sp.a));
            const c = prepCapsule(v, { ...sp, a: addS(sp.a, d, sp.ra), b: addS(sp.b, d, -sp.rb) }, light); if (c) drawCapsule(this.F, c, light, opt); continue;
          }
          const prims = golferPrims(ps, plan, light, v.C).filter(p => p.part === 'fast' && !(fp.k > 1 && p.tag === 'shaft'));
          const caps = prims.filter(p => !p.glint).map(p => prepCapsule(v, p, light)).filter(Boolean).sort((a, b) => (b.z0 + b.z1) - (a.z0 + a.z1));
          for (const c of caps) drawCapsule(this.F, c, light, opt);
          for (const gl of prims.filter(p => p.glint)) { const q = project(v, gl.p); if (q.z > 0) drawSpot(this.F, q.x, q.y, Math.max(0.6, gl.size * q.ppm / 2.6), gl.a, gl.col, { ...opt, z: q.z - 0.02, zTest: true }); }
        }
      }
    };
    sweep(S, false);
    if (fp.k > 1) sweep(S * fp.k, true);
    this.sidBase = sid;
    return fp;
  }
  /** Pixel box the ball touches over the exposure (its streak plus the PSF), or null when it does not project. */
  ballBox(tc) {
    const exp = this.w.sensor.exposure, W = this.W, H = this.H, c = this.ballImage(tc); if (!c || !Number.isFinite(c.x)) return null;
    const pa = this.ballImage(tc - exp / 2), pb = this.ballImage(tc + exp / 2);
    const blur = pa && pb && Number.isFinite(pa.x + pb.x) ? Math.hypot(pb.x - pa.x, pb.y - pa.y) : 0, R0 = BALL.r * c.ppm;
    const ext = Math.ceil(Math.max(R0, 1) + 3 * this.w.sensor.psf + 2);
    const bx0 = Math.max(0, Math.floor(Math.min(pa?.x ?? c.x, pb?.x ?? c.x) - ext)), bx1 = Math.min(W - 1, Math.ceil(Math.max(pa?.x ?? c.x, pb?.x ?? c.x) + ext));
    const by0 = Math.max(0, Math.floor(Math.min(pa?.y ?? c.y, pb?.y ?? c.y) - ext)), by1 = Math.min(H - 1, Math.ceil(Math.max(pa?.y ?? c.y, pb?.y ?? c.y) + ext));
    return { c, blur, R0, bx0, bx1, by0, by1, inside: bx1 >= bx0 && by1 >= by0 };
  }
  /** The ball: shaded disc or flux-preserving Gaussian, sub-sampled over the exposure; returns visibility stats. */
  drawBall(tc, light, B = this.ballBox(tc), zb = null) {
    const exp = this.w.sensor.exposure, W = this.W, F = this.F, vis = this.w.scene.vis;
    if (!B) return null;
    const { c, blur, R0, bx0, bx1, by0, by1 } = B;
    if (!B.inside) return { c, blur, R0, visibleFrac: 0, inside: false };
    const S = clamp(Math.ceil(blur / Math.max(0.35, Math.min(R0, 2))) + 1, 1, 96), psf = this.w.sensor.psf;
    const pw = bx1 - bx0 + 1, ph = by1 - by0 + 1, pA = new Float32Array(pw * ph), pC = new Float32Array(pw * ph * 3);
    let tot = 0, seen = 0;
    const L = light.sun;
    for (let s = 0; s < S; s++) {
      const u = S > 1 ? (s + 0.5) / S : 0.5, ts = tc + (u - 0.5) * exp, q = this.ballImage(ts); if (!q || !Number.isFinite(q.x)) continue;
      const bin = zb?.z ? Math.min(zb.nb - 1, Math.floor(u * zb.nb)) * zb.n : -1;
      const R = BALL.r * q.ppm, v = this.viewAt(q.t), toCam = norm(sub(v.C, q.pos)), hk = Math.exp(-q.z / vis), hz = this.w.scene.palette.haze;
      const small = R < 1.5, sig2 = psf * psf + R * R / 4, peak = small ? Math.min(1, R * R / (2 * sig2)) : 1;
      const e = Math.ceil((small ? 3 * Math.sqrt(sig2) : R + 1.5) + 1);
      // Mean shaded color for small balls; per-pixel normal shading for resolved ones.
      // Linear-light radiance (display white = 1): sky dome from above, sun by Lambert, a little specular.
      const radiance = (nx, ny, nz) => {
        const n = [nx * v.r[0] + ny * v.d[0] + nz * toCam[0], nx * v.r[1] + ny * v.d[1] + nz * toCam[1], nx * v.r[2] + ny * v.d[2] + nz * toCam[2]];
        const nl = Math.max(0, dot(n, L)), hv = norm(add(L, toCam)), sp = Math.pow(Math.max(0, dot(n, hv)), 60) * 0.5 * light.sunI, up = 0.65 + 0.35 * n[1];
        const bounce = 0.22 * (light.sunI * Math.max(0, L[1]) + light.amb) * 0.5 * (1 - n[1]);
        return [0, 1, 2].map(k => this.ballLin[k] * (light.amb * light.skyTint[k] * up + bounce * (k === 1 ? 1.1 : 0.9) + light.sunI * nl * light.sunTint[k] * 1.08) + sp);
      };
      const toDisp = lin => [0, 1, 2].map(k => { const d = 255 * gam(lin[k]); return d + (hz[k] - d) * (1 - hk); });
      const shade = (nx, ny, nz) => toDisp(radiance(nx, ny, nz));
      let mean = null;
      if (small) { const m = [0, 0, 0]; let n = 0; for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const nx = a / 3.5, ny = b / 3.5, rr = nx * nx + ny * ny; if (rr > 1) continue; const l = radiance(nx, ny, Math.sqrt(1 - rr)); m[0] += l[0]; m[1] += l[1]; m[2] += l[2]; n++; } mean = toDisp(m.map(x => x / n)); }
      for (let y = Math.max(by0, Math.floor(q.y - e)); y <= Math.min(by1, Math.ceil(q.y + e)); y++) for (let x = Math.max(bx0, Math.floor(q.x - e)); x <= Math.min(bx1, Math.ceil(q.x + e)); x++) {
        const dx = x + 0.5 - q.x, dy = y + 0.5 - q.y, d2 = dx * dx + dy * dy;
        let a, col;
        if (small) { a = peak * Math.exp(-d2 / (2 * sig2)); if (a < 1e-3) continue; col = mean; }
        else { const d = Math.sqrt(d2); a = clamp((R - d) / (1 + psf) + 0.5, 0, 1); if (a <= 0) continue; const nx = clamp(dx / R, -1, 1), ny = clamp(dy / R, -1, 1), rr = Math.min(1, nx * nx + ny * ny); col = shade(nx, ny, Math.sqrt(1 - rr)); }
        const i = y * W + x, zq = q.z - BALL.r, j = (y - by0) * pw + (x - bx0); tot += a;
        if (zq >= F.z[i] || (bin >= 0 && zq >= zb.z[bin + j])) continue;
        seen += a;
        pA[j] += a / S; pC[j * 3] += col[0] * a / S; pC[j * 3 + 1] += col[1] * a / S; pC[j * 3 + 2] += col[2] * a / S;
      }
    }
    // Composite, keeping the clean patch just before and just after the ball for SNR and the decoded-video oracle;
    // `trans` collects what the layers drawn later (neighbour ball, debris, front net, insects) let through.
    const before = new Float32Array(pw * ph * 3), after = new Float32Array(pw * ph * 3), trans = new Float32Array(pw * ph);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const j = (y - by0) * pw + (x - bx0), o = (y * W + x) * 3, a = Math.min(1, pA[j]);
      before[j * 3] = F.rgb[o]; before[j * 3 + 1] = F.rgb[o + 1]; before[j * 3 + 2] = F.rgb[o + 2];
      if (a > 0 && !this.hideBall) { const k = 1 - a; F.rgb[o] = F.rgb[o] * k + pC[j * 3]; F.rgb[o + 1] = F.rgb[o + 1] * k + pC[j * 3 + 1]; F.rgb[o + 2] = F.rgb[o + 2] * k + pC[j * 3 + 2]; }
      after[j * 3] = F.rgb[o]; after[j * 3 + 1] = F.rgb[o + 1]; after[j * 3 + 2] = F.rgb[o + 2];
    }
    return { c, blur, R0, S, visibleFrac: tot > 0 ? seen / tot : 0, patch: { x0: bx0, y0: by0, w: pw, h: ph, before, after, trans, alpha: pA }, inside: true };
  }
  drawDistractors(tc, view, light, phase) {
    const D = this.w.D, F = this.F, out = [];
    const capsDirect = (caps, zt) => { for (const p of caps) { const c = prepCapsule(view, p, light); if (c) drawCapsule(F, c, light, { zTest: zt }); } };
    if (phase === 'far') {
      if (D.plane) { const pp = planePrims(D.plane, tc); capsDirect(pp.caps, false); if (pp.light) { const q = project(view, pp.light.p); if (q.z > 0) drawSpot(F, q.x, q.y, 0.9, 0.9, pp.light.col); } }
      for (const b of D.birds) { const bp = birdPrims(b, tc); capsDirect(bp, true); }
      for (const wk of D.walkers) capsDirect(walkerPrims(wk, tc), true);
      for (const fl of D.flags) capsDirect(flagPrims(fl, tc), true);
      for (const p of this.w.scene.nearPoles || []) capsDirect([{ a: [p.x, 0, p.z], b: [p.x, p.h, p.z], ra: p.r, rb: p.r, col: p.col }], true);
      for (const p of D.bayPosts) capsDirect([{ a: [p.x, 0, p.z], b: [p.x, p.h, p.z], ra: p.r, rb: p.r, col: [70, 70, 74] }], true);
      for (const b of D.loose) capsDirect([{ a: b, b, ra: BALL.r, rb: BALL.r, col: this.ballLook, sphere: true, spec: 0.3, shin: 40 }], true);
      if (D.tee && (!D.tee.flies || tc <= 0)) capsDirect(teePrims(D.tee, tc, this.w.ballStart), true);
    } else {
      if (D.tee && D.tee.flies && tc > 0) capsDirect(teePrims(D.tee, tc, this.w.ballStart), true);
      for (const p of D.divot) { if (tc <= (p.t0 || 0)) continue; const { pos } = particleAt(p, tc), s = p.chunk ? p.size * (0.6 + 0.4 * Math.abs(Math.sin(p.spin * tc))) : p.size; capsDirect([{ a: pos, b: pos, ra: s / 2, rb: s / 2, col: p.col, sphere: true }], true); }
    }
    return out;
  }
  drawInsects(tc) {
    for (const it of this.w.D.insects) { const p = insectAt(it, tc); if (p) drawSpot(this.F, p.x, p.y, it.rad, it.alpha, it.col); }
  }
  /** Exposure gain at capture time tc: metering times auto-exposure drift. */
  gainAt(tc) { const ae = this.w.sensor.ae; return this.g0 * (1 + ae.amp * smooth((tc - ae.t0) / ae.dur) + ae.wob * Math.sin(2 * Math.PI * 0.37 * tc)); }
  /** Sensor and ISP: gain, vignette and dust, tone knee, luma-dependent noise, then luma unsharp masking (sharpens the noise too). */
  sensorPass(tc, out) {
    const { W, H, F } = this, s = this.w.sensor, n = W * H, rgb = F.rgb, gm = this.gainMap, tone = this.tone, sig = this.sig, knee = s.knee;
    const g = this.frameGain, wr = s.wb[0] * g, wg = s.wb[1] * g, wb = s.wb[2] * g, sh = s.sharpen, Y = sh > 0 ? (this.Ybuf ||= new Float32Array(n)) : null;
    const NL = this.noiseOn ? this.noiseFields(this.frameIndex || 0) : null, L = NL?.L, C = NL?.C, chroma = s.noise.chroma, dst = Y ? rgb : out;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const m = gm[i];
      let r = rgb[o] * wr * m, gg = rgb[o + 1] * wg * m, b = rgb[o + 2] * wb * m;
      if (r > knee || gg > knee || b > knee) { r = tone[r > 511 ? 1023 : (r * 2) | 0]; gg = tone[gg > 511 ? 1023 : (gg * 2) | 0]; b = tone[b > 511 ? 1023 : (b * 2) | 0]; }
      if (L) {
        const sg = sig[gg < 0 ? 0 : gg > 255 ? 255 : gg | 0], nl = L[i] * sg;
        if (C) { const nc = C[i] * sg * chroma; r += nl + nc; gg += nl; b += nl - nc; } else { r += nl; gg += nl; b += nl; }
      }
      dst[o] = r; dst[o + 1] = gg; dst[o + 2] = b;
      if (Y) Y[i] = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    }
    if (!Y) return;
    for (let y = 0; y < H; y++) {
      const i0 = y * W, edge = y === 0 || y === H - 1;
      out[i0 * 3] = rgb[i0 * 3]; out[i0 * 3 + 1] = rgb[i0 * 3 + 1]; out[i0 * 3 + 2] = rgb[i0 * 3 + 2];
      const iL = i0 + W - 1; out[iL * 3] = rgb[iL * 3]; out[iL * 3 + 1] = rgb[iL * 3 + 1]; out[iL * 3 + 2] = rgb[iL * 3 + 2];
      if (edge) { for (let i = i0 + 1, o = i * 3; i < iL; i++, o += 3) { out[o] = rgb[o]; out[o + 1] = rgb[o + 1]; out[o + 2] = rgb[o + 2]; } continue; }
      for (let i = i0 + 1, o = i * 3; i < iL; i++, o += 3) {
        const d = sh * (Y[i] - 0.25 * (Y[i - 1] + Y[i + 1] + Y[i - W] + Y[i + W]));
        out[o] = rgb[o] + d; out[o + 1] = rgb[o + 1] + d; out[o + 2] = rgb[o + 2] + d;
      }
    }
  }
  /** Clean (noise-free) sensor luma for a linear-light pixel triple, for SNR bookkeeping. */
  cleanLuma(r, g, b, i) {
    const s = this.w.sensor, m = this.gainMap[i] * this.frameGain, t = v => this.tone[clamp((v * 2) | 0, 0, 1023)];
    return lumaOf(t(r * s.wb[0] * m), t(g * s.wb[1] * m), t(b * s.wb[2] * m));
  }
  /** Renders frame k into `out` (Uint8, W*H*3) and returns its ground truth record. */
  frame(k, out) {
    const w = this.w, f = w.timeline.frames[k], tc = f.tc, light = this.light, W = this.W, H = this.H;
    this.frameIndex = k;
    if (!this.ballLook) { this.ballLook = w.spec.yellowBall ? [238, 222, 72] : [244, 244, 240]; this.ballLin = this.ballLook.map(c => (c / 255) ** 2.2 * 0.92); }
    if (f.dupOf != null && this.prevOut) { out.set(this.prevOut); return { ...this.prevGt, i: k, t: f.t, dupOf: f.dupOf }; }
    const view = this.viewAt(tc);
    this.warpBackground(tc);
    this.F.z.fill(Infinity);
    this.shadows(view, tc);
    this.drawDistractors(tc, view, light, 'far');
    const nb = w.neighbor;
    if (nb?.drawGolfer) this.drawGolferBody(nb.plan, tc - nb.tImpact, nb.offset, view, light);
    const pose = this.drawGolferBody(w.plan, tc, [0, 0, 0], view, light);
    this.sidBase = 0;
    const B = this.ballBox(tc), fp = this.fastPlan(w.plan, tc, [0, 0, 0]);
    const zb = B?.inside ? { x0: B.bx0, y0: B.by0, w: B.bx1 - B.bx0 + 1, h: B.by1 - B.by0 + 1, n: (B.bx1 - B.bx0 + 1) * (B.by1 - B.by0 + 1), nb: fp.S, z: null, b0: 0, b1: 1 } : null;
    const fast = this.drawFast(w.plan, tc, [0, 0, 0], light, zb, 0, fp);
    if (nb?.drawGolfer) this.drawFast(nb.plan, tc, nb.offset, light, zb, nb.tImpact);
    compositeAcc(this.F, this.acc);
    const ball = this.drawBall(tc, light, B, zb), P = ball?.patch;
    this.lastBall = ball;
    // Layers over the ball: every one is an over-composite, so the ball patch keeps their per-pixel transmission.
    if (P) this.F.tr = { x0: P.x0, y0: P.y0, x1: P.x0 + P.w - 1, y1: P.y0 + P.h - 1, w: P.w, t: P.trans.fill(1) };
    if (nb) this.drawNeighborBall(tc, light);
    resetAcc(this.acc);
    this.drawDistractors(tc, view, light, 'near');
    if (this.netOverlay) this.applyNet();
    this.drawInsects(tc);
    this.F.tr = null;
    this.frameGain = this.gainAt(tc);
    const gt = this.groundTruth(k, f, view, pose, ball, fast);
    this.sensorPass(tc, out);
    this.prevOut = out; this.prevGt = gt;
    return gt;
  }
  drawNeighborBall(tc, light) {
    const nb = this.w.neighbor, t = tc - nb.tImpact, P = t <= 0 ? nb.start : ballAt(nb.flight, t), q = project(this.viewAt(tc), P);
    if (!(q.z > 0) || q.x < -50 || q.y < -50 || q.x > this.W + 50 || q.y > this.H + 50) return;
    const R = BALL.r * q.ppm, exp = this.w.sensor.exposure, q2 = project(this.viewAt(tc), t <= 0 ? nb.start : ballAt(nb.flight, t + exp / 2)), q1 = project(this.viewAt(tc), t <= 0 ? nb.start : ballAt(nb.flight, t - exp / 2));
    const S = clamp(Math.ceil(Math.hypot(q2.x - q1.x, q2.y - q1.y) / 0.6) + 1, 1, 48), hk = Math.exp(-q.z / this.w.scene.vis), col = mix(this.ballLook.map(c => c * gam(light.amb + light.sunI * 0.6)), this.w.scene.palette.haze, 1 - hk);
    for (let s = 0; s < S; s++) { const ts = t + ((s + 0.5) / S - 0.5) * exp, p = project(this.viewAt(tc), ts <= 0 ? nb.start : ballAt(nb.flight, ts)); if (p.z > 0) drawSpot(this.F, p.x, p.y, Math.max(0.55, R * 0.75), Math.min(1, R * R / (2 * Math.max(0.3, (R * 0.75) ** 2))) / S * (S > 1 ? S * 0.9 : 1), col, { z: p.z, zTest: true }); }
  }
  groundTruth(k, f, view, pose, ball, fast) {
    const w = this.w, W = this.W, H = this.H, inFrame = p => p && Number.isFinite(p.x) && p.x >= 0 && p.y >= 0 && p.x < W && p.y < H, r3 = v => Math.round(v * 1000) / 1000;
    const pose0 = w.motion(f.tc), gt = { i: k, t: f.t, tc: r3(f.tc * 1000) / 1000, gain: r3(this.frameGain), cam: { yaw: r3(pose0.yaw / DEG), pitch: r3(pose0.pitch / DEG), roll: r3(pose0.roll / DEG), zoom: r3(pose0.zoom) } };
    if (f.dupOf != null) gt.dupOf = f.dupOf;
    let snr = null;
    if (ball && ball.patch) {
      const P = ball.patch, n = P.w * P.h, sh = w.sensor.sharpen, rgb = this.F.rgb; let s2 = 0, bgSum = 0, bgN = 0, aT = 0, aS = 0;
      let c = new Float32Array(n), b = new Float32Array(n);
      // The final frame with and without the ball: the layers over the ball scale its contribution by their transmission.
      for (let j = 0; j < n; j++) {
        const x = P.x0 + (j % P.w), y = P.y0 + ((j / P.w) | 0), i = y * W + x, o = i * 3, T = P.trans[j], q = j * 3;
        const yb = this.cleanLuma(rgb[o] - T * (P.after[q] - P.before[q]), rgb[o + 1] - T * (P.after[q + 1] - P.before[q + 1]), rgb[o + 2] - T * (P.after[q + 2] - P.before[q + 2]), i), ya = this.cleanLuma(rgb[o], rgb[o + 1], rgb[o + 2], i);
        b[j] = yb; c[j] = ya - yb; if (P.alpha[j] < 0.01) { bgSum += yb; bgN++; }
        aT += P.alpha[j] * T; aS += P.alpha[j];
      }
      if (aS > 0) ball.visibleFrac *= aT / aS;
      // The template sees the same ISP sharpening as the frame (linear in output luma).
      if (sh > 0) { c = sharpenPatch(c, P.w, P.h, sh); b = sharpenPatch(b, P.w, P.h, sh); }
      for (let j = 0; j < n; j++) s2 += c[j] * c[j];
      const yBg = bgN ? bgSum / bgN : b.reduce((a, v) => a + v, 0) / n;
      snr = Math.sqrt(s2) / (this.sig[clamp(yBg | 0, 0, 255)] * Math.sqrt((1 + sh) ** 2 + sh * sh / 4));
      let ca = 0, aa = 0; for (let j = 0; j < n; j++) { ca += c[j] * P.alpha[j]; aa += P.alpha[j]; }
      ball.contrast = aa > 0 ? ca / aa : 0;
      if (this.keepPatches) this.patches[k] = { x0: P.x0, y0: P.y0, w: P.w, h: P.h, c, b };
      ball.bgLuma = yBg;
    }
    const bi = ball?.c;
    const state = !w.hasBall ? 'none' : f.tc <= 0 || !w.flight ? 'address' : w.flight.landing && f.tc > w.flight.landing.t ? (w.flight.rest != null && f.tc >= w.flight.rest ? 'rest' : 'rolling') : 'flight';
    gt.ball = bi && Number.isFinite(bi.x) ? { x: r3(bi.x), y: r3(bi.y), diam: r3(BALL.d * bi.ppm), inFrame: inFrame(bi), occluded: ball.visibleFrac < 0.5, visibleFrac: r3(ball.visibleFrac), expectedSnr: snr == null ? 0 : r3(snr), contrast: r3(ball.contrast ?? 0), bgLuma: r3(ball.bgLuma ?? null), blurPx: r3(ball.blur), state, bg: state === 'flight' && inFrame(bi) ? classifyRay(w.scene, view.C, rayDir(view, bi.x, bi.y)) : undefined } : (w.hasBall ? { x: null, y: null, diam: 0, inFrame: false, occluded: false, visibleFrac: 0, expectedSnr: 0, blurPx: 0, state } : null);
    // The club head where it appears: with rolling shutter, at the readout time of its own row (fixed point).
    let hp = project(view, pose.club.head), tClub = f.tc;
    if (w.sensor.rs) for (let it = 0; it < 3 && Number.isFinite(hp.x); it++) { tClub = f.tc + rsOffset(w.sensor.rs, W, H, hp.x, hp.y); hp = project(this.viewAt(tClub), w.plan.poseAt(tClub).club.head); }
    const vg = tClub === f.tc ? view : this.viewAt(tClub), pc = tClub === f.tc ? pose : w.plan.poseAt(tClub), cp = project(vg, pc.club.contact);
    gt.club = { x: r3(hp.x), y: r3(hp.y), size: r3(w.plan.spec.headLen * Math.max(0, hp.ppm)), inFrame: inFrame(hp), blurPx: r3(fast.blur), contact: Number.isFinite(cp.x) ? { x: r3(cp.x), y: r3(cp.y) } : null };
    const ds = [], D = w.D, push = (type, id, p, size) => { if (p && Number.isFinite(p.x) && p.z > 0 && p.x > -20 && p.y > -20 && p.x < W + 20 && p.y < H + 20) ds.push({ type, id, x: r3(p.x), y: r3(p.y), size: r3(size) }); };
    if (D.plane) { const q = project(view, D.plane.at(f.tc)); push('airplane', 'plane', q, D.plane.size * q.ppm); }
    for (const b of D.birds) { const q = project(view, birdAt(b, f.tc)); push('bird', b.id, q, b.span * q.ppm); }
    for (const it of D.insects) { const p = insectAt(it, f.tc); if (p) ds.push({ type: 'insect', id: it.id, x: r3(p.x), y: r3(p.y), size: r3(it.rad * 2) }); }
    for (const wk of D.walkers) { const q = project(view, add(addS(wk.p0, wk.v, f.tc), [0, wk.h * 0.6, 0])); push('person', wk.id, q, wk.h * q.ppm); }
    if (D.tee && D.tee.flies && f.tc > 0) { const q = project(view, particleAt(D.tee, f.tc, 0.25).pos); push('tee', 'tee', q, 0.05 * q.ppm); }
    for (const p of D.divot) if (f.tc > (p.t0 || 0) && (p.chunk || p.size > 0.018)) { const q = project(view, particleAt(p, f.tc).pos); push(p.chunk ? 'divot' : 'turf', p.id, q, p.size * q.ppm); }
    if (w.neighbor) { const nb = w.neighbor, t = f.tc - nb.tImpact, q = project(view, t <= 0 ? nb.start : ballAt(nb.flight, t)); push('neighbor_ball', 'nball', q, BALL.d * q.ppm); if (nb.drawGolfer) { const h = project(view, shiftPose(nb.plan.poseAt(t), nb.offset).club.head); push('neighbor_club', 'nclub', h, nb.plan.spec.headLen * h.ppm); } }
    // Glints at the head's capture time, unless something nearer hides most of the spot (5 footprint samples).
    for (const g of golferPrims(pc, w.plan, this.light, vg.C).filter(p => p.glint && p.a > 0.3)) {
      const q = project(vg, g.p), rr = Math.max(1, g.size * q.ppm / 3);
      const open = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => { const px = Math.round(q.x + a * rr - 0.5), py = Math.round(q.y + b * rr - 0.5); return !(px >= 0 && py >= 0 && px < W && py < H) || q.z - 0.02 < this.F.z[py * W + px]; }).length;
      if (open >= 2) push('glint', 'glint', q, g.size * q.ppm);
    }
    gt.distractors = ds;
    return gt;
  }
}

export function shiftPose(p, off) {
  if (!off || (!off[0] && !off[1] && !off[2])) return p;
  const o = {}, dir = new Set(['sh', 'face', 'toe', 'up']);
  for (const [k, v] of Object.entries(p)) o[k] = k === 'club' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, dir.has(kk) ? vv : add(vv, off)])) : k === 'spine' || k === 'look' ? v : add(v, off);
  return o;
}

/** Separable 3-tap blur [a, 1 - 2a, a] of an interleaved RGB float canvas, in place (edges clamped). */
export function blur3(buf, W, H, a) {
  const c = 1 - 2 * a, row = new Float32Array(W * 3), col = new Float32Array(H * 3);
  for (let y = 0; y < H; y++) {
    const o0 = y * W * 3; row.set(buf.subarray(o0, o0 + W * 3));
    for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) { const l = row[Math.max(0, x - 1) * 3 + ch], r = row[Math.min(W - 1, x + 1) * 3 + ch]; buf[o0 + x * 3 + ch] = c * row[x * 3 + ch] + a * (l + r); }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) for (let ch = 0; ch < 3; ch++) col[y * 3 + ch] = buf[(y * W + x) * 3 + ch];
    for (let y = 0; y < H; y++) for (let ch = 0; ch < 3; ch++) buf[(y * W + x) * 3 + ch] = c * col[y * 3 + ch] + a * (col[Math.max(0, y - 1) * 3 + ch] + col[Math.min(H - 1, y + 1) * 3 + ch]);
  }
}

/** The sensor pass's luma unsharp mask applied to a patch (interior pixels; borders unchanged). */
function sharpenPatch(v, w, h, sh) {
  const out = Float32Array.from(v);
  for (let y = 1; y < h - 1; y++) for (let x = 1, j = y * w + 1; x < w - 1; x++, j++) out[j] = v[j] + sh * (v[j] - 0.25 * (v[j - 1] + v[j + 1] + v[j - w] + v[j + w]));
  return out;
}
