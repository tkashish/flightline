// One clip end to end: render -> ffmpeg -> rotation remux -> probe (PTS, rotation) -> decoded-video oracle -> GT.
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWorld } from './world.mjs';
import { Renderer } from './render.mjs';
import { planAudio, synthAudio, writeWav } from './audio.mjs';
import { encodePlan, encoderArgs, Encoder, remuxRotation, probe, decodeGray, ffmpegVersion } from './encode.mjs';
import { assembleGt, harnessAnnotation } from './gt-schema.mjs';
import { deriveTags, expectedOutcome, factorSummary, addressVisibility } from './scenarios.mjs';

export const GENERATOR_VERSION = 'synth-1.1';
/** sha256 over tests/synth/*.mjs (names and bytes): clips built by different generator code never share a manifest. */
export const CODE_SHA256 = (() => {
  const dir = dirname(fileURLToPath(import.meta.url)), h = createHash('sha256');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
})();
export const generatorInfo = () => ({ version: GENERATOR_VERSION, codeSha256: CODE_SHA256, node: process.version, ffmpeg: ffmpegVersion() });

/** Oracle matched-filter SNR on the decoded frame using the clean contrast template (local gain/offset fitted). */
function oracleSnr(D, W, P) {
  let cmax = 0; for (let j = 0; j < P.c.length; j++) cmax = Math.max(cmax, Math.abs(P.c[j]));
  if (cmax <= 0) return 0;
  let n = 0, sb = 0, sd = 0, sbb = 0, sbd = 0;
  for (let j = 0; j < P.c.length; j++) { if (Math.abs(P.c[j]) > 0.03 * cmax) continue; const x = P.x0 + (j % P.w), y = P.y0 + ((j / P.w) | 0), d = D[y * W + x], b = P.b[j]; n++; sb += b; sd += d; sbb += b * b; sbd += b * d; }
  if (n < 12) return null;
  const vb = sbb - sb * sb / n, a = vb > 1e-6 ? clampA((sbd - sb * sd / n) / vb) : 1, c0 = (sd - a * sb) / n;
  let ss = 0, num = 0, cc = 0;
  for (let j = 0; j < P.c.length; j++) {
    const x = P.x0 + (j % P.w), y = P.y0 + ((j / P.w) | 0), r = D[y * W + x] - (a * P.b[j] + c0);
    if (Math.abs(P.c[j]) <= 0.03 * cmax) ss += r * r; else { num += P.c[j] * a * r; cc += (P.c[j] * a) ** 2; }
  }
  const sig = Math.sqrt(ss / Math.max(1, n - 2)) || 0.5;
  return cc > 0 ? num / (Math.max(0.5, sig) * Math.sqrt(cc)) : 0;
}
const clampA = a => (a < 0.7 ? 0.7 : a > 1.4 ? 1.4 : a);

export async function generateClip(spec, { outDir, tmpDir = outDir, threads = 1, encode = true, oracle = true, onFrame = null } = {}) {
  const T = { start: performance.now() };
  mkdirSync(outDir, { recursive: true }); mkdirSync(tmpDir, { recursive: true });
  const world = buildWorld(spec), R = new Renderer(world, { keepPatches: encode && oracle }), W = world.intr.W, H = world.intr.H, N = world.timeline.N;
  T.setup = performance.now();
  const plan = encodePlan(spec, world.timeline), ext = plan.container, file = `${spec.id}.${ext}`, finalPath = join(outDir, file), tmpOut = join(tmpDir, `${spec.id}.part.${ext}`);
  const ap = planAudio(world), wav = ap && encode ? join(tmpDir, `${spec.id}.wav`) : null;
  if (wav) writeWav(wav, synthAudio(ap));
  const enc = encode ? new Encoder(encoderArgs(spec, world.timeline, plan, { out: tmpOut, audio: wav, threads }), W * H * 3) : null;
  const hash = createHash('sha256'), frames = [];
  let scratch = null;
  for (let k = 0; k < N; k++) {
    const buf = enc ? enc.buffer() : (scratch ||= new Uint8ClampedArray(W * H * 3));
    const gt = R.frame(k, buf);
    hash.update(buf); frames.push(gt);
    if (onFrame) onFrame(k, buf, gt, R);
    if (enc) await enc.write(buf);
  }
  T.render = performance.now();
  let pr = { codedWidth: plan.rotation % 180 ? H : W, codedHeight: plan.rotation % 180 ? W : H, rotation: plan.rotation }, ptsVerified = null;
  if (enc) {
    await enc.end(); remuxRotation(tmpOut, finalPath, plan.rotation);
    T.encode = performance.now();
    pr = probe(finalPath);
    if (pr.pts.length !== N) throw new Error(`${spec.id}: container has ${pr.pts.length} frames, rendered ${N}`);
    const scale = pr.timeBase === '1/90000' ? 1 : null, mism = scale ? frames.filter((f, k) => world.timeline.frames[k].ticks !== pr.pts[k]).length : N;
    ptsVerified = mism === 0;
    if (!ptsVerified) frames.forEach((f, k) => { f.t = Math.round(pr.ptsSec[k] * 1e6) / 1e6; });
    if (oracle) {
      await decodeGray(finalPath, W, H, (k, D) => {
        const P = R.patches[k], b = frames[k].ball; if (!P || !b) return;
        const z = oracleSnr(D, W, P); if (z != null) b.snrCoded = Math.round(z * 100) / 100;
      });
      for (const f of frames) if (f.dupOf != null && frames[f.dupOf].ball && f.ball) f.ball.snrCoded = frames[f.dupOf].ball.snrCoded;
      T.oracle = performance.now();
    }
    if (wav) rmSync(wav, { force: true });
    if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
  }
  const draft = { frames, world };
  const expected = expectedOutcome(spec, draft), failureModes = deriveTags(spec, draft, expected);
  const gt = assembleGt(world, frames, {
    expected, failureModes, factors: factorSummary(spec, world), file, encode: plan, probe: pr, ptsVerified, audio: ap ? { mode: ap.mode, avOffsetS: Math.round(ap.delay * 1e4) / 1e4, events: ap.events.length, stretched: ap.stretch } : null,
    generator: generatorInfo(), rawSha256: hash.digest('hex')
  });
  if (gt.impact) gt.impact.addressVisibleFrames = addressVisibility(frames).visible;
  gt.annotation = harnessAnnotation(gt);
  writeFileSync(join(outDir, `${spec.id}.gt.json`), JSON.stringify(gt));
  T.end = performance.now();
  return {
    id: spec.id, file, gtFile: `${spec.id}.gt.json`, frames: N, size: `${W}x${H}`, fps: world.timeline.fpsOut, expected, failureModes, rawSha256: gt.meta.rawSha256, ptsVerified,
    ms: { setup: T.setup - T.start, render: T.render - T.setup, encode: (T.encode ?? T.render) - T.render, oracle: (T.oracle ?? T.encode ?? T.render) - (T.encode ?? T.render), total: T.end - T.start }
  };
}
