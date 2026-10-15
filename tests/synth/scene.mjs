// Static environment rendered once per clip at the base camera pose: sky gradient with clouds and sun glow,
// perspective grass (mowing stripes, footprint-limited noise) or a hitting mat, a tree line of shaded crowns with
// sky gaps and holes, distant nets and poles, range balls and target greens. Clouds can live on a separate layer so
// they drift per frame.
import { DEG, clamp, lerp, fbm2, hash32, norm } from './math.mjs';
import { rayDir, project } from './camera.mjs';
import { prepCapsule, drawCapsule, drawSpot } from './raster.mjs';

export const SKIES = {
  blue: { zenith: [62, 112, 196], horizon: [172, 202, 232], haze: [190, 208, 226], sunI: [1.7, 2.3], amb: [0.24, 0.36], vis: [6000, 20000] },
  overcast: { zenith: [206, 210, 216], horizon: [226, 228, 232], haze: [222, 224, 228], sunI: [0.04, 0.14], amb: [0.75, 0.95], vis: [2500, 8000], cloudy: true },
  haze: { zenith: [148, 172, 200], horizon: [206, 212, 218], haze: [208, 212, 216], sunI: [1.0, 1.4], amb: [0.36, 0.5], vis: [700, 2500] },
  sunset: { zenith: [62, 76, 140], horizon: [246, 160, 92], haze: [220, 160, 120], sunI: [1.2, 1.8], amb: [0.18, 0.28], vis: [3000, 10000], lowSun: true, warm: true },
  dusk: { zenith: [22, 28, 62], horizon: [128, 96, 110], haze: [110, 92, 104], sunI: [0.04, 0.12], amb: [0.14, 0.22], vis: [3000, 9000], lowSun: true, dark: true },
  teal: { zenith: [40, 120, 150], horizon: [190, 220, 210], haze: [180, 210, 205], sunI: [1.6, 2.2], amb: [0.26, 0.38], vis: [4000, 12000] },
  violet: { zenith: [92, 82, 160], horizon: [214, 190, 214], haze: [200, 186, 206], sunI: [1.3, 1.8], amb: [0.3, 0.42], vis: [3000, 9000] }
};
const DEEP_BLUE = { zenith: [24, 52, 104], horizon: [118, 162, 218] };
const GRASS = [[66, 118, 52], [78, 132, 58], [58, 104, 46], [92, 128, 62], [104, 132, 70], [70, 126, 64]];

export function sampleScene(r, { sky = 'blue', ground = 'grass', trees = true, nets = false, poles = false, styleShift = false, cloud = null, camYaw = 0, easy = false, hand = 1 } = {}) {
  // Phone users mostly film with the sun behind or beside them; 10% of clips look into the sun. Easy clips: sun behind, high.
  // Clear blue skies range from pale to the deep blue of the real Pixel frame (dist/qa/offline-f52.png: about (38, 76, 119)
  // high up, (116, 160, 217) just above the horizon).
  const S = { ...SKIES[sky] }, el = (S.lowSun ? r.range(3, 14) : easy ? r.range(32, 62) : r.range(18, 68)) * DEG, rel = easy ? (r.next(), 'back') : r.weighted({ back: 6, side: 3, front: 1 });
  if (sky === 'blue') { const k = r.next(); S.zenith = S.zenith.map((c, i) => c + (DEEP_BLUE.zenith[i] - c) * k); S.horizon = S.horizon.map((c, i) => c + (DEEP_BLUE.horizon[i] - c) * k); S.depth = k; }
  const az = camYaw + (rel === 'back' ? Math.PI + r.normal(0, easy ? 0.3 : 0.8) : rel === 'side' ? r.sign() * r.range(1.0, 2.1) : r.normal(0, 0.7));
  const sun = norm([Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]);
  const tint = S.warm ? [1.12, 0.98, 0.82] : sky === 'overcast' ? [1, 1, 1.02] : [1.04, 1, 0.94];
  const grass = r.pick(GRASS).map(c => c * r.range(0.9, 1.1) * (S.dark ? 0.55 : 1));
  return {
    sky, palette: S, sun, sunEl: el / DEG, sunAz: az / DEG, sunRel: rel,
    light: { sun, sunI: r.range(...S.sunI), amb: r.range(...S.amb), skyTint: sky === 'sunset' ? [0.85, 0.85, 1.05] : [0.94, 0.98, 1.08], sunTint: tint },
    vis: r.range(...S.vis),
    clouds: { cover: cloud ?? (S.cloudy ? r.range(0.75, 1) : r.weighted({ 0: 2, 0.25: 3, 0.5: 3, 0.7: 1 }) * r.range(0.7, 1.2) * (easy ? 0.4 : 1)), alt: r.range(1200, 3000), scale: r.range(600, 1600), drift: [r.normal(0, 8), r.normal(0, 8)], seed: hash32(r.int(0, 1e9), 'clouds'), thick: S.cloudy ? 1 : r.range(0.6, 1) },
    ground: { kind: ground, grass, stripe: r.range(0.05, 0.12), stripeW: r.range(3.5, 7), stripeAxis: r.chance(0.7) ? 'z' : 'x', noise: r.range(0.12, 0.25), seed: hash32(r.int(0, 1e9), 'ground'), dry: r.chance(0.2) },
    // The golfer stands on the mat (mirrored for a left-hander); most range mats sit on a concrete tee line that runs back
    // toward the camera (bright, textured, jointed: like the real Pixel frame dist/qa/offline-f52.png).
    mat: ground === 'mat' ? { x0: hand > 0 ? -1.35 : -0.32, x1: hand > 0 ? 0.32 : 1.35, z0: -0.8, z1: 0.8, col: [r.range(60, 80), r.range(128, 150), r.range(56, 70)].map(c => c * (S.dark ? 0.55 : 1)), border: [36, 40, 36].map(c => c * (S.dark ? 0.55 : 1)) } : null,
    apron: ground === 'mat' && r.chance(0.7) ? { col: (k => [k * r.range(0.98, 1.04), k, k * r.range(0.93, 0.99)])(r.range(150, 190) * (S.dark ? 0.55 : 1)), depth: r.range(5, 12), joint: r.range(1.8, 3.2), seed: hash32(r.int(0, 1e9), 'apron'), grit: r.range(0.06, 0.14) } : null,
    trees: trees ? (() => { const h = r.range(9, 24); return { dist: r.range(170, 380), h, col: [r.range(24, 44), r.range(46, 70), r.range(26, 42)], seed: hash32(r.int(0, 1e9), 'trees'), hills: r.chance(0.4), crown: h * r.range(0.6, 1.1) + 4, phase: r.range(0, 1), holes: r.range(0.7, 0.8) }; })() : null,
    nets: nets ? { side: r.range(22, 45), height: r.range(14, 30), dens: r.range(0.05, 0.14), col: [40, 44, 44], poleStep: r.range(12, 22) } : null,
    poles: poles ? Array.from({ length: r.int(2, 6) }, () => ({ x: r.range(-35, 35), z: r.range(12, 140), h: r.range(3, 12), r: r.range(0.04, 0.12), col: r.pick([[230, 230, 230], [200, 40, 40], [70, 70, 70], [230, 200, 40]]) })) : [],
    rangeBalls: r.chance(0.8) ? Array.from({ length: r.int(30, 260) }, () => [r.range(-45, 45), 0.0213, r.range(8, 230) ** 1]) : [],
    greens: Array.from({ length: r.int(0, 4) }, () => ({ x: r.range(-30, 30), z: r.range(40, 160), rx: r.range(6, 14), rz: r.range(5, 10) })),
    boards: Array.from({ length: r.int(0, 3) }, () => ({ x: r.range(-40, 40), z: r.range(50, 200), w: r.range(1.5, 3), h: r.range(1, 2) }))
  };
}

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * What chrome mirrors (linear light, display white = 1): the sky by elevation with its mean cloud cover, the sunlit turf or
 * mat around the golfer below, the far ground or tree line near the horizon. The sun itself is left to the glints.
 */
export function envLight(sc) {
  const P = sc.palette, L = sc.light, lin = c => c.map(v => (Math.max(0, v) / 255) ** 2.2), lit = Math.pow(L.amb * 0.9 + L.sunI * Math.max(0, sc.sun[1]) * 1.05, 1 / 2.2);
  const ground = lin((sc.mat ? sc.mat.col : sc.ground.grass).map(c => c * lit)), far = sc.trees ? lin(sc.trees.col.map(c => c * 1.4 * Math.pow(0.5 + 0.35 * L.sunI, 1 / 2.2))) : ground.map(v => v * 0.85);
  const tw = L.sunTint, cloud = lin([0, 1, 2].map(k => (sc.sky === 'overcast' ? 228 : sc.sky === 'dusk' ? 90 : 240) * tw[k]));
  const horizon = lin(P.horizon);
  return { zenith: lin(P.zenith), horizon, cloud, cover: clamp(sc.clouds.cover * (sc.sky === 'overcast' ? 0.35 : 0.6) * sc.clouds.thick, 0, 1), ground, far, mean: horizon.map((h, k) => 0.5 * (h + ground[k])) };
}

/**
 * Renders the base-pose background into canvases of size (W + 2M) x (H + 2M).
 * Returns { ox, oy, BW, BH, fg: Float32 RGB, alpha: Float32 (1 = solid foreground) | null, sky: Float32 RGB | null }.
 * With `cloudLayer` the sky (with clouds) is kept separately so it can drift; fg alpha marks non-sky pixels.
 */
export function renderBackground(sc, view, { margin = 64, cloudLayer = false } = {}) {
  const M = margin, BW = view.W + 2 * M, BH = view.H + 2 * M, n = BW * BH;
  const fg = new Float32Array(n * 3), sky = cloudLayer ? new Float32Array(n * 3) : null, alpha = cloudLayer ? new Float32Array(n) : null;
  const P = sc.palette, C = view.C, cl = sc.clouds, cloudN = fbm2(cl.seed, 6, 0.55), grassN = fbm2(sc.ground.seed, 6, 0.5), fineN = fbm2(sc.ground.seed + 7, 3, 0.6), treeN = treeNoise(sc.trees?.seed || 1);
  const sun = sc.sun, f = view.f, hz = sc.palette.haze;
  const skyAt = (d, out) => {
    const e = Math.asin(clamp(d[1], -1, 1)), k = Math.pow(clamp(e / (Math.PI / 2), 0, 1), 0.55);
    let r = lerp(P.horizon[0], P.zenith[0], k), g = lerp(P.horizon[1], P.zenith[1], k), b = lerp(P.horizon[2], P.zenith[2], k);
    const cs = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2], glow = Math.exp((cs - 1) * 18) * 0.55 + Math.exp((cs - 1) * 300) * 0.9;
    const tw = sc.light.sunTint; r += glow * 255 * tw[0] * 0.5; g += glow * 235 * tw[1] * 0.5; b += glow * 200 * tw[2] * 0.5;
    if (cl.cover > 0.01 && d[1] > 0.004) {
      const s = cl.alt / d[1], X = (C[0] + d[0] * s) / cl.scale, Z = (C[2] + d[2] * s) / cl.scale, fp = s / (f * d[1] * cl.scale);
      const nv = cloudN(X, Z, fp * 8), thr = 1.02 - cl.cover * 0.62, cov = smoothstep(thr - 0.07, thr + 0.09, nv) * smoothstep(0.004, 0.06, d[1]) * (sc.sky === 'overcast' ? 0.35 : 1);
      if (cov > 0) {
        const oc = sc.sky === 'overcast', shade = oc ? 0.96 + 0.07 * smoothstep(thr, thr + 0.25, nv) : 0.82 + 0.3 * smoothstep(thr, thr + 0.25, nv) + 0.12 * cs, base = oc ? 228 : sc.sky === 'dusk' ? 90 : 240;
        const cr = base * shade * tw[0], cg = base * shade * tw[1], cb = base * shade * (tw[2] * 0.98 + 0.04);
        const a = cov * cl.thick; r = lerp(r, cr, a); g = lerp(g, cg, a); b = lerp(b, cb, a);
      }
    }
    out[0] = r; out[1] = g; out[2] = b;
  };
  const tmp = [0, 0, 0], L = sc.light, groundLit = Math.pow(L.amb * 0.9 + L.sunI * Math.max(0, sun[1]) * 1.05, 1 / 2.2);
  const tr = sc.trees, mat = sc.mat, G = sc.ground, ap = sc.apron, apN = ap ? fbm2(ap.seed, 5, 0.55) : null;
  for (let py = 0; py < BH; py++) {
    for (let px = 0; px < BW; px++) {
      const d = rayDir(view, px - M + 0.5, py - M + 0.5), i = py * BW + px, o = i * 3;
      let r, g, b, solid = 0;
      // Ground hit distance and tree wall.
      const sG = d[1] < -1e-6 ? C[1] / -d[1] : Infinity, hor = Math.hypot(d[0], d[2]);
      let treeHit = false, tDist = 0;
      if (tr) {
        tDist = tr.dist / Math.max(1e-6, hor);
        const az = Math.atan2(d[0], d[2]), yAt = C[1] + d[1] * tDist, shade = sG * hor > tr.dist ? treeShade(tr, treeN, az, yAt, sc.sunAz * DEG) : null;
        treeHit = shade != null;
        if (treeHit) {
          // Crown-scale shading times isotropic leaf texture (two scales, metres on the wall), footprint-limited.
          const u = az * tr.dist, fpw = tDist / f, tex = treeN(u * 0.9, yAt * 0.9, fpw * 0.9), fine = treeN(u * 2.6 + 5, yAt * 2.6, fpw * 2.6), dark = shade * (0.5 + 0.75 * tex + 0.35 * (fine - 0.5));
          r = tr.col[0] * dark; g = tr.col[1] * dark; b = tr.col[2] * dark;
          const lit = Math.pow(0.5 + 0.35 * L.sunI, 1 / 2.2); r *= lit; g *= lit; b *= lit;
          const hk = 1 - Math.exp(-tDist / sc.vis); r = lerp(r, hz[0], hk); g = lerp(g, hz[1], hk); b = lerp(b, hz[2], hk);
          solid = 1;
        }
      }
      if (!treeHit && sG < Infinity && sG < 4e4) {
        const gx = C[0] + d[0] * sG, gz = C[2] + d[2] * sG, fp = sG / (f * Math.max(0.02, -d[1]));
        let base = G.grass;
        const s = G.stripeAxis === 'z' ? gz : gx, band = Math.sin(Math.PI * s / G.stripeW), soft = Math.max(0.08, fp / G.stripeW * 3);
        const stripe = 1 + G.stripe * Math.tanh(band / soft) * (1 / (1 + fp * 0.5));
        const nz = grassN(gx * 2.2, gz * 2.2, fp * 4.4) - 0.5, coarse = grassN(gx * 0.08 + 31, gz * 0.08, fp * 0.16) - 0.5;
        const fine = fineN(gx * 140, gz * 90, fp * 280) - 0.5, ff = clamp(1.4 - fp * 120, 0, 1);
        let k = stripe * (1 + G.noise * 1.2 * nz + 0.16 * coarse + G.noise * 2.2 * fine * ff);
        r = base[0] * k; g = base[1] * k; b = base[2] * k;
        if (G.dry) { r += 18 * (coarse + 0.5); g += 8 * (coarse + 0.5); }
        for (const gr of sc.greens) { const e = ((gx - gr.x) / gr.rx) ** 2 + ((gz - gr.z) / gr.rz) ** 2; if (e < 1.2) { const a = smoothstep(1.2, 0.9, e); r = lerp(r, base[0] * 1.18, a); g = lerp(g, base[1] * 1.22, a); b = lerp(b, base[2] * 1.05, a); } }
        if (ap && gz < mat.z1 + 0.05 && gz > mat.z1 - ap.depth) {
          // Concrete: aggregate grit and stains (footprint-limited), darker sawn joints every ap.joint metres.
          const grit = 2 * (apN(gx * 55, gz * 55, fp * 110) - 0.5) + 1.4 * (apN(gx * 230 + 3, gz * 230, fp * 460) - 0.5), stain = apN(gx * 0.7 + 13, gz * 0.7, fp * 1.4) - 0.5, jw = Math.max(0.006, fp * 0.7);
          const jx = Math.abs(((gx / ap.joint) % 1 + 1) % 1 - 0.5) * ap.joint, jz = Math.abs((((gz - mat.z1) / ap.joint) % 1 + 1) % 1 - 0.5) * ap.joint;
          const joint = Math.max(smoothstep(jw, 0, ap.joint / 2 - jx), smoothstep(jw, 0, ap.joint / 2 - jz)), k = (1 + ap.grit * grit + 0.2 * stain) * (1 - 0.45 * joint);
          r = ap.col[0] * k; g = ap.col[1] * k; b = ap.col[2] * k;
        }
        if (mat && gx > mat.x0 - 0.05 && gx < mat.x1 + 0.05 && gz > mat.z0 - 0.05 && gz < mat.z1 + 0.05) {
          const inner = gx > mat.x0 && gx < mat.x1 && gz > mat.z0 && gz < mat.z1, mt = 1 + 0.06 * (grassN(gx * 300, gz * 300, fp * 600) - 0.5);
          const c = inner ? mat.col : mat.border; r = c[0] * mt; g = c[1] * mt; b = c[2] * mt;
        }
        r *= groundLit; g *= groundLit; b *= groundLit;
        const hk = 1 - Math.exp(-sG / sc.vis); r = lerp(r, hz[0], hk); g = lerp(g, hz[1], hk); b = lerp(b, hz[2], hk);
        solid = 1;
      }
      if (sc.nets && !solid && d[1] > 0) {
        const side = d[0] > 0 ? sc.nets.side : -sc.nets.side, s = (side - C[0]) / d[0];
        if (s > 0 && C[1] + d[1] * s < sc.nets.height && C[2] + d[2] * s > -5) {
          const z = C[2] + d[2] * s, pole = Math.abs(((z / sc.nets.poleStep) % 1 + 1) % 1 - 0.5) < 0.35 / (s * 0.002 * sc.nets.poleStep + 0.35) * 0.02;
          skyAt(d, tmp); const a = pole ? 0.85 : sc.nets.dens;
          r = lerp(tmp[0], sc.nets.col[0], a); g = lerp(tmp[1], sc.nets.col[1], a); b = lerp(tmp[2], sc.nets.col[2], a); solid = 1;
        }
      }
      if (!solid) { skyAt(d, tmp); r = tmp[0]; g = tmp[1]; b = tmp[2]; }
      fg[o] = r; fg[o + 1] = g; fg[o + 2] = b;
      if (cloudLayer) { alpha[i] = solid; if (!solid) { sky[o] = r; sky[o + 1] = g; sky[o + 2] = b; } else { skyAt(d, tmp); sky[o] = tmp[0]; sky[o + 1] = tmp[1]; sky[o + 2] = tmp[2]; } }
    }
  }
  // Far static objects: poles, boards, range balls (painter's order, far first).
  const canvas = { W: BW, H: BH, rgb: fg, z: new Float32Array(n).fill(Infinity) }, v2 = { ...view, cx: view.cx + M, cy: view.cy + M };
  const items = [];
  for (const p of sc.poles) items.push({ d: Math.hypot(p.x - C[0], p.z - C[2]), draw: () => { const c = prepCapsule(v2, { a: [p.x, 0, p.z], b: [p.x, p.h, p.z], ra: p.r, rb: p.r * 0.8, col: p.col }, L); if (c) drawCapsule(canvas, c, L, { zTest: false }); } });
  for (const bd of sc.boards) items.push({ d: Math.hypot(bd.x - C[0], bd.z - C[2]), draw: () => { for (let k = 0; k < 4; k++) { const y = 0.6 + bd.h * (k + 0.5) / 4, c = prepCapsule(v2, { a: [bd.x - bd.w / 2, y, bd.z], b: [bd.x + bd.w / 2, y, bd.z], ra: bd.h / 8, rb: bd.h / 8, col: [236, 236, 230] }, L); if (c) drawCapsule(canvas, c, L, { zTest: false }); } } });
  for (const bp of sc.rangeBalls) items.push({ d: Math.hypot(bp[0] - C[0], bp[2] - C[2]), draw: () => { const q = project(v2, bp); if (!(q.z > 0)) return; const rad = 0.0213 * q.ppm, hk = Math.exp(-q.z / sc.vis); drawSpot(canvas, q.x, q.y, Math.max(0.55, rad * 0.8), Math.min(1, Math.PI * rad * rad / (2 * Math.PI * Math.max(0.55, rad * 0.8) ** 2)) * hk, [238, 238, 232]); } });
  items.sort((a, b) => b.d - a.d).forEach(it => it.draw());
  if (cloudLayer) for (let i = 0; i < n; i++) if (!alpha[i]) { const o = i * 3; sky[o] = fg[o]; sky[o + 1] = fg[o + 1]; sky[o + 2] = fg[o + 2]; }
  return { M, BW, BH, fg, alpha, sky };
}

/**
 * Tree line at azimuth az and wall height y: null where sky shows (above the crowns, between them, through holes in
 * the upper crowns), else a crown-scale shade (domes lit on the sun side, darker toward the ground).
 */
function treeShade(tr, N, az, y, sunAz) {
  if (y <= -5) return null;
  // Two interleaved rows of overlapping round crowns: the skyline is the higher dome at each point, so notches are shallow.
  let top = -Infinity, dome = 0, u = 0;
  for (const [off, k] of [[0, 1], [0.5, 0.82]]) {
    const s = az * tr.dist / tr.crown + tr.phase + off, i = Math.floor(s), f = s - i, d = Math.sqrt(Math.max(0, 1 - (2 * f - 1) ** 2));
    const t = tr.h * k * (0.55 + 0.55 * N(i * 7.31 + off * 3, 3.7)) * (0.35 + 0.65 * d);
    if (t > top) { top = t; dome = d; u = f; }
  }
  top += tr.h * 0.08 * (N(az * 160, 1.3) - 0.5) + (tr.hills ? 18 * N(az * 4, 7.1) : 0);
  if (y >= top) return null;
  const rel = clamp(y / Math.max(1, top), 0, 1);
  if (rel > 0.5 && N(az * tr.dist * 1.3 + 11, y * 1.3) > tr.holes + 0.5 * (1 - rel)) return null;
  const side = (2 * u - 1) * Math.sin(sunAz - az) - 0.35 * Math.cos(sunAz - az);
  return (0.62 + 0.38 * rel) * (1 + 0.3 * clamp(side, -1, 1)) * (0.85 + 0.15 * dome);
}

/** What lies behind a world ray from C: 'ground', 'tree' or 'sky' (same geometry as the background render). */
export function classifyRay(sc, C, d) {
  const sG = d[1] < -1e-6 ? C[1] / -d[1] : Infinity, hor = Math.hypot(d[0], d[2]), tr = sc.trees;
  if (tr) {
    const tDist = tr.dist / Math.max(1e-6, hor), yAt = C[1] + d[1] * tDist;
    if (sG * hor > tr.dist && yAt < tr.h * 1.15 + (tr.hills ? 18 : 0) && treeShade(tr, treeNoise(tr.seed), Math.atan2(d[0], d[2]), yAt, sc.sunAz * DEG) != null) return 'tree';
  }
  return sG < 4e4 ? 'ground' : 'sky';
}
const treeCache = new Map();
function treeNoise(seed) { if (!treeCache.has(seed)) treeCache.set(seed, fbm2(seed, 5, 0.5)); return treeCache.get(seed); }
