// Anti-aliased rasterizers for projected capsules and spheres with cheap cylinder/sphere shading,
// a z-buffer for the body, and per-pixel sample-aware accumulation for motion-blurred layers. Edge ramps are
// light.aa px wide (the optical PSF); `zbin` keeps the nearest depth per exposure-phase bin inside a box (the
// ball's patch) so the ball is occluded only where the club is in front at the same instant. While F.tr is set
// ({ x0, y0, x1, y1, w, t }), direct-mode draws multiply its per-pixel transmission (layers drawn over the ball).
import { project } from './camera.mjs';
import { sub, norm, dot, cross, add, scale } from './math.mjs';

/** Display-space factor for a linear-light shade value: x^(1/2.2) via a LUT over [0, 4). */
export const GAMMA = (() => { const t = new Float32Array(4096); for (let i = 0; i < 4096; i++) t[i] = Math.pow(i / 1024, 1 / 2.2); return t; })();
export const gam = x => GAMMA[x <= 0 ? 0 : x >= 3.999 ? 4095 : (x * 1024) | 0];

/** Environment radiance (linear RGB, see envLight in scene.mjs) for a unit direction of height y, into out; blur mixes in the hemisphere mean (satin). */
export function envAt(E, y, blur, out) {
  const up = y >= 0, s = up ? Math.pow(Math.asin(y < 1 ? y : 1) / (Math.PI / 2), 0.55) : 0, g = up ? 0 : -y * 5 < 1 ? -y * 5 : 1;
  for (let k = 0; k < 3; k++) {
    let v;
    if (up) { const sky = E.horizon[k] + (E.zenith[k] - E.horizon[k]) * s; v = sky + (E.cloud[k] - sky) * E.cover; }
    else v = E.far[k] + (E.ground[k] - E.far[k]) * g;
    out[k] = blur > 0 ? v + (E.mean[k] - v) * blur : v;
  }
  return out;
}

export function makeFrame(W, H) {
  return { W, H, rgb: new Float32Array(W * H * 3), z: new Float32Array(W * H).fill(Infinity), tr: null };
}
export function makeAcc(W, H) {
  return { W, H, a: new Float32Array(W * H), c: new Float32Array(W * H * 3), ca: new Float32Array(W * H), cc: new Float32Array(W * H * 3), id: new Int32Array(W * H).fill(-1), box: [W, H, -1, -1] };
}
export function resetAcc(A) {
  const [x0, y0, x1, y1] = A.box;
  if (x1 < x0) return;
  for (let y = y0; y <= y1; y++) {
    const i0 = y * A.W + x0, i1 = y * A.W + x1 + 1;
    A.a.fill(0, i0, i1); A.ca.fill(0, i0, i1); A.c.fill(0, i0 * 3, i1 * 3); A.cc.fill(0, i0 * 3, i1 * 3); A.id.fill(-1, i0, i1);
  }
  A.box = [A.W, A.H, -1, -1];
}
/** Composite an accumulation buffer over the frame (premultiplied). */
export function compositeAcc(F, A) {
  const [x0, y0, x1, y1] = A.box, W = F.W, rgb = F.rgb;
  for (let y = y0; y <= y1; y++) for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
    const a = A.a[i]; if (a <= 0) continue;
    const k = 1 - (a > 1 ? 1 : a), o = i * 3;
    rgb[o] = rgb[o] * k + A.c[o]; rgb[o + 1] = rgb[o + 1] * k + A.c[o + 1]; rgb[o + 2] = rgb[o + 2] * k + A.c[o + 2];
  }
}

/** Projects a world capsule and precomputes shading terms. Returns null when behind the camera. */
export function prepCapsule(view, p, light) {
  const A = project(view, p.a), B = p.b === p.a ? A : project(view, p.b);
  if (!(A.z > 0.05 && B.z > 0.05)) return null;
  const mid = p.b === p.a ? p.a : scale(add(p.a, p.b), 0.5), toCam = norm(sub(view.C, mid));
  const R0 = p.ra * A.ppm, R1 = p.rb * B.ppm, sphere = !!p.sphere || (Math.hypot(B.x - A.x, B.y - A.y) < 1e-6 && p.ra === p.rb);
  let pL = 0, vL = 1, pH = 0, vH = 1, aL = 0, bL = 0, aH = 0, bH = 0, basis = null;
  const L = light.sun, Hv = norm(add(L, toCam));
  if (sphere) { aL = dot(view.r, L); bL = dot(view.d, L); vL = dot(toCam, L); aH = dot(view.r, Hv); bH = dot(view.d, Hv); vH = dot(toCam, Hv); basis = [view.r, view.d, toCam]; }
  else {
    const ax = norm(sub(p.b, p.a)), v = norm(sub(toCam, scale(ax, dot(toCam, ax)))), pp = norm(cross(ax, v));
    // Match the 3-D perpendicular to the screen-space side the pixel offset is measured on.
    const q = project(view, add(mid, scale(pp, 0.01))), m = project(view, mid), dx = B.x - A.x, dy = B.y - A.y;
    const sgn = ((q.x - m.x) * -dy + (q.y - m.y) * dx) >= 0 ? 1 : -1;
    pL = sgn * dot(pp, L); vL = dot(v, L); pH = sgn * dot(pp, Hv); vH = dot(v, Hv); basis = [scale(pp, sgn), v];
  }
  // flatN: one shading normal for the whole capsule (parts of a flat surface such as an iron blade).
  const flat = !!p.flatN, fL = flat ? dot(p.flatN, L) : 0, fH = flat ? dot(p.flatN, Hv) : 0;
  // env: a mirror (chrome) that reflects the environment along the view ray reflected about its normal, plus a little diffuse.
  const env = p.env && light.env ? { E: light.env, V: toCam, basis, flatN: p.flatN, blur: p.env.blur || 0, kr: p.col.map(c => p.env.refl * Math.min(1, c / 198)), kd: p.col.map(c => (p.env.diffuse ?? 0.05) * (c / 255) ** 2.2), e: [0, 0, 0] } : null;
  return { x0: A.x, y0: A.y, x1: B.x, y1: B.y, z0: A.z, z1: B.z, R0, R1, w0: p.ra, w1: p.rb, sphere, pL, vL, pH, vH, aL, bL, aH, bH, col: p.col, spec: env ? 0 : p.spec || 0, shin: p.shin || 20, flat, fL, fH, env };
}

function rowSpan(c, y, Rm) {
  let lo = Infinity, hi = -Infinity;
  for (const [cx, cy] of [[c.x0, c.y0], [c.x1, c.y1]]) { const dy = y - cy; if (Math.abs(dy) <= Rm) { const h = Math.sqrt(Rm * Rm - dy * dy); if (cx - h < lo) lo = cx - h; if (cx + h > hi) hi = cx + h; } }
  const dx = c.x1 - c.x0, dy = c.y1 - c.y0, L = Math.hypot(dx, dy);
  if (L > 1e-6) {
    const nx = -dy / L * Rm, ny = dx / L * Rm, P = [[c.x0 + nx, c.y0 + ny], [c.x1 + nx, c.y1 + ny], [c.x1 - nx, c.y1 - ny], [c.x0 - nx, c.y0 - ny]];
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = P[k], [bx, by] = P[(k + 1) & 3];
      if ((ay - y) * (by - y) <= 0 && ay !== by) { const x = ax + (bx - ax) * (y - ay) / (by - ay); if (x < lo) lo = x; if (x > hi) hi = x; }
    }
  }
  return [lo, hi];
}

/**
 * Rasterize a prepared capsule. mode: 'direct' (z-tested write into F), 'acc' (motion-blur accumulation into Acc with
 * sample id), 'mask' (max coverage into a Float32 mask). clip = [x0, y0, x1, y1) in pixels.
 */
export function drawCapsule(F, c, light, { mode = 'direct', acc = null, sid = 0, invS = 1, mask = null, clip = null, zTest = true, alpha = 1, zWrite = true, zbin = null } = {}) {
  const W = F.W, Hh = F.H, aw = light.aa || 1, iaw = 1 / aw, Rm = Math.max(c.R0, c.R1) + Math.max(1, aw);
  const cx0 = clip ? clip[0] : 0, cy0 = clip ? clip[1] : 0, cx1 = clip ? clip[2] : W, cy1 = clip ? clip[3] : Hh;
  const yA = Math.max(cy0, Math.floor(Math.min(c.y0, c.y1) - Rm)), yB = Math.min(cy1 - 1, Math.ceil(Math.max(c.y0, c.y1) + Rm));
  if (yB < yA || Math.max(c.x0, c.x1) + Rm < cx0 || Math.min(c.x0, c.x1) - Rm >= cx1) return 0;
  const dx = c.x1 - c.x0, dy = c.y1 - c.y0, L2 = dx * dx + dy * dy, inv = L2 > 1e-12 ? 1 / L2 : 0, Lm = Math.sqrt(L2);
  const amb = light.amb, dif = light.sunI, sky = light.skyTint, sun = light.sunTint, col = c.col, rgb = F.rgb, zb = F.z, T = mode === 'direct' ? F.tr : null;
  const spK = c.spec * light.sunI * 255;
  let drawn = 0;
  for (let y = yA; y <= yB; y++) {
    const py = y + 0.5, [lo, hi] = rowSpan(c, py, Rm);
    if (!(hi >= lo)) continue;
    const xA = Math.max(cx0, Math.floor(lo)), xB = Math.min(cx1 - 1, Math.ceil(hi));
    if (acc && xB >= xA) { const b = acc.box; if (xA < b[0]) b[0] = xA; if (y < b[1]) b[1] = y; if (xB > b[2]) b[2] = xB; if (y > b[3]) b[3] = y; }
    for (let x = xA; x <= xB; x++) {
      const px = x + 0.5, ex = px - c.x0, ey = py - c.y0;
      let t = (ex * dx + ey * dy) * inv; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ex - t * dx, qy = ey - t * dy, d = Math.sqrt(qx * qx + qy * qy), R = c.R0 + (c.R1 - c.R0) * t;
      let cov = R >= 0.5 ? (R - d) * iaw + 0.5 : 2 * R * iaw * (1 - d * iaw);
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      cov *= alpha;
      const i = y * W + x;
      const sR = d / (R > 1e-6 ? R : 1e-6), s2 = sR > 1 ? 1 : sR * sR, sz = Math.sqrt(1 - s2);
      const z = c.z0 + (c.z1 - c.z0) * t - (c.w0 + (c.w1 - c.w0) * t) * sz;
      if (mode === 'mask') { if (cov > mask[i]) mask[i] = cov; drawn++; continue; }
      if (zTest && z >= zb[i]) continue;
      let nL, nH, w0 = 0, w1 = 0;
      if (c.flat) { nL = c.fL; nH = c.fH; }
      else if (c.sphere) { const sx = R > 0 ? qx / R : 0, sy = R > 0 ? qy / R : 0; nL = sx * c.aL + sy * c.bL + sz * c.vL; nH = sx * c.aH + sy * c.bH + sz * c.vH; w0 = sx; w1 = sy; }
      else { const side = Lm > 0 ? (qx * -dy + qy * dx) / Lm / (R > 1e-6 ? R : 1) : 0, sv = side > 1 ? 1 : side < -1 ? -1 : side; nL = sv * c.pL + sz * c.vL; nH = sv * c.pH + sz * c.vH; w0 = sv; }
      const lam = nL > 0 ? nL * dif : 0, sp = nH > 0 && spK > 0 ? spK * Math.pow(nH, c.shin) : 0;
      let r, g, bl;
      if (c.env) {
        const e = c.env, B = e.basis, V = e.V, N = c.flat ? e.flatN : c.sphere ? [w0 * B[0][0] + w1 * B[1][0] + sz * B[2][0], w0 * B[0][1] + w1 * B[1][1] + sz * B[2][1], w0 * B[0][2] + w1 * B[1][2] + sz * B[2][2]] : [w0 * B[0][0] + sz * B[1][0], w0 * B[0][1] + sz * B[1][1], w0 * B[0][2] + sz * B[1][2]];
        const nv = N[0] * V[0] + N[1] * V[1] + N[2] * V[2], E = envAt(e.E, 2 * nv * N[1] - V[1], e.blur, e.e), lk = k => e.kr[k] * E[k] + e.kd[k] * (amb * sky[k] + lam * sun[k]);
        r = 255 * GAMMA[(lk(0) * 1024) | 0]; g = 255 * GAMMA[(lk(1) * 1024) | 0]; bl = 255 * GAMMA[(lk(2) * 1024) | 0];
      } else { r = col[0] * GAMMA[((amb * sky[0] + lam * sun[0]) * 1024) | 0] + sp; g = col[1] * GAMMA[((amb * sky[1] + lam * sun[1]) * 1024) | 0] + sp; bl = col[2] * GAMMA[((amb * sky[2] + lam * sun[2]) * 1024) | 0] + sp; }
      if (mode === 'direct') {
        const o = i * 3, k = 1 - cov;
        rgb[o] = rgb[o] * k + r * cov; rgb[o + 1] = rgb[o + 1] * k + g * cov; rgb[o + 2] = rgb[o + 2] * k + bl * cov;
        if (T && x >= T.x0 && x <= T.x1 && y >= T.y0 && y <= T.y1) T.t[(y - T.y0) * T.w + x - T.x0] *= k;
        if (zWrite && cov >= 0.5) zb[i] = z;
      } else {
        const o = i * 3;
        if (acc.id[i] !== sid) { acc.id[i] = sid; acc.ca[i] = 0; acc.cc[o] = 0; acc.cc[o + 1] = 0; acc.cc[o + 2] = 0; }
        const oa = acc.ca[i], k = 1 - cov, na = cov + oa * k, nr = r * cov + acc.cc[o] * k, ng = g * cov + acc.cc[o + 1] * k, nb = bl * cov + acc.cc[o + 2] * k;
        acc.a[i] += (na - oa) * invS; acc.c[o] += (nr - acc.cc[o]) * invS; acc.c[o + 1] += (ng - acc.cc[o + 1]) * invS; acc.c[o + 2] += (nb - acc.cc[o + 2]) * invS;
        acc.ca[i] = na; acc.cc[o] = nr; acc.cc[o + 1] = ng; acc.cc[o + 2] = nb;
        if (zbin && cov >= 0.5) {
          const bx = x - zbin.x0, by = y - zbin.y0;
          if (bx >= 0 && by >= 0 && bx < zbin.w && by < zbin.h) {
            const zz = zbin.z || (zbin.z = new Float32Array(zbin.nb * zbin.n).fill(Infinity)), j = by * zbin.w + bx;
            for (let b = zbin.b0; b < zbin.b1; b++) if (z < zz[b * zbin.n + j]) zz[b * zbin.n + j] = z;
          }
        }
      }
      drawn++;
    }
  }
  return drawn;
}

/** Gaussian spot (glints, lights): `acc` mode adds as one more sample-aware layer, direct mode blends over F. */
export function drawSpot(F, x, y, sigma, alpha, col, { acc = null, sid = 0, invS = 1, clip = null, z = 0, zTest = false } = {}) {
  const W = F.W, ext = Math.ceil(3 * sigma + 1), cx0 = clip ? clip[0] : 0, cy0 = clip ? clip[1] : 0, cx1 = clip ? clip[2] : W, cy1 = clip ? clip[3] : F.H;
  const xA = Math.max(cx0, Math.floor(x - ext)), xB = Math.min(cx1 - 1, Math.ceil(x + ext)), yA = Math.max(cy0, Math.floor(y - ext)), yB = Math.min(cy1 - 1, Math.ceil(y + ext));
  if (acc && xB >= xA && yB >= yA) { const b = acc.box; if (xA < b[0]) b[0] = xA; if (yA < b[1]) b[1] = yA; if (xB > b[2]) b[2] = xB; if (yB > b[3]) b[3] = yB; }
  const k2 = 1 / (2 * sigma * sigma), T = acc ? null : F.tr;
  for (let yy = yA; yy <= yB; yy++) for (let xx = xA; xx <= xB; xx++) {
    const dx = xx + 0.5 - x, dy = yy + 0.5 - y, a = alpha * Math.exp(-(dx * dx + dy * dy) * k2);
    if (a < 0.004) continue;
    const i = yy * W + xx, o = i * 3;
    if (zTest && z >= F.z[i]) continue;
    if (!acc) {
      const k = 1 - a; F.rgb[o] = F.rgb[o] * k + col[0] * a; F.rgb[o + 1] = F.rgb[o + 1] * k + col[1] * a; F.rgb[o + 2] = F.rgb[o + 2] * k + col[2] * a;
      if (T && xx >= T.x0 && xx <= T.x1 && yy >= T.y0 && yy <= T.y1) T.t[(yy - T.y0) * T.w + xx - T.x0] *= k;
      continue;
    }
    if (acc.id[i] !== sid) { acc.id[i] = sid; acc.ca[i] = 0; acc.cc[o] = 0; acc.cc[o + 1] = 0; acc.cc[o + 2] = 0; }
    const oa = acc.ca[i], k = 1 - a, na = a + oa * k, nr = col[0] * a + acc.cc[o] * k, ng = col[1] * a + acc.cc[o + 1] * k, nb = col[2] * a + acc.cc[o + 2] * k;
    acc.a[i] += (na - oa) * invS; acc.c[o] += (nr - acc.cc[o]) * invS; acc.c[o + 1] += (ng - acc.cc[o + 1]) * invS; acc.c[o + 2] += (nb - acc.cc[o + 2]) * invS;
    acc.ca[i] = na; acc.cc[o] = nr; acc.cc[o + 1] = ng; acc.cc[o + 2] = nb;
  }
}

/** Darken F by a coverage mask within box: rgb *= 1 - k * mask; clears the mask. */
export function applyMask(F, mask, box, k) {
  const [x0, y0, x1, y1] = box, W = F.W, rgb = F.rgb;
  for (let y = Math.max(0, y0); y <= Math.min(F.H - 1, y1); y++) for (let x = Math.max(0, x0), i = y * W + x; x <= Math.min(W - 1, x1); x++, i++) {
    const m = mask[i]; if (m <= 0) continue;
    const f = 1 - k * m, o = i * 3; rgb[o] *= f; rgb[o + 1] *= f; rgb[o + 2] *= f; mask[i] = 0;
  }
}
