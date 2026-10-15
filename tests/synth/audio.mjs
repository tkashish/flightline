// Range audio: wind (gusty low-passed noise), distant chatter tones, swing whoosh, impact click with resonances,
// clicks from neighbouring bays. Events are placed in output time; slow motion stretches and lowers them.
import { writeFileSync } from 'node:fs';
import { rngFor, clamp } from './math.mjs';

export const RATE = 48000;

export function planAudio(world) {
  const spec = world.spec, r = rngFor(spec.seed, 'audio'), mode = spec.audio || 'aligned';
  if (mode === 'none') return null;
  const tau = world.timeline.tau, out = t => (t - world.tStart) * tau, dur = world.timeline.frames.at(-1).t + 1 / world.timeline.fpsOut;
  const camDist = Math.hypot(...world.place.C.map((c, i) => c - world.ballStart[i]));
  const delay = camDist / 343 + (mode === 'misaligned' ? r.sign() * r.range(0.06, 0.18) : r.normal(0, 0.012));
  const events = [];
  const kind = world.plan.spec.kind;
  if (world.spec.kind === 'hit') events.push({ type: 'impact', t: out(0) + delay * tau, gain: clamp(2.5 / camDist, 0.15, 1), freqs: kind === 'wood' ? [r.range(2800, 4200), r.range(5200, 7000)] : [r.range(1500, 2600), r.range(3800, 5200)], decay: kind === 'wood' ? r.range(0.008, 0.016) : r.range(0.004, 0.009) });
  events.push({ type: 'whoosh', t: out(-0.03) + delay * tau, gain: clamp(1.2 / camDist, 0.05, 0.4), dur: 0.12 });
  const pr = world.plan.times.practice;
  if (pr) events.push({ type: 'whoosh', t: out(pr.tImpact - 0.03) + delay * tau, gain: clamp(0.9 / camDist, 0.04, 0.3), dur: 0.12 });
  if (world.neighbor) events.push({ type: 'impact', t: out(world.neighbor.tImpact) + (Math.hypot(...world.place.C.map((c, i) => c - world.neighbor.start[i])) / 343) * tau, gain: 0.35, freqs: [r.range(1800, 4000), r.range(4500, 6500)], decay: r.range(0.005, 0.012) });
  for (let i = 0, n = r.int(0, Math.round(dur * 0.4)); i < n; i++) events.push({ type: 'impact', t: r.range(0, dur), gain: r.range(0.05, 0.2), freqs: [r.range(1500, 4000), r.range(4000, 7000)], decay: r.range(0.004, 0.012), neighbor: true });
  return { mode, dur, tau, delay, events, wind: r.range(0.005, 0.06), seed: r.int(1, 1e9), stretch: tau > 1 };
}

export function synthAudio(plan) {
  const n = Math.ceil(plan.dur * RATE), x = new Float32Array(n), r = rngFor(plan.seed, 'pcm'), tau = plan.stretch ? plan.tau : 1;
  // Wind: brown-ish noise with slow gusts.
  let b = 0, lp = 0, g = 0;
  for (let i = 0; i < n; i++) {
    b = 0.995 * b + 0.05 * r.gauss(); lp += (b - lp) * 0.02; if (i % 480 === 0) g = 0.7 + 0.3 * Math.sin(i / RATE * 0.9 + 1.3) + 0.15 * r.gauss();
    x[i] = lp * plan.wind * 4 * Math.max(0.2, g) + r.gauss() * 0.0015;
  }
  for (const e of plan.events) {
    const i0 = Math.round(e.t * RATE); if (i0 >= n || i0 < -RATE) continue;
    if (e.type === 'impact') {
      const len = Math.ceil(0.08 * tau * RATE);
      for (let j = 0; j < len && i0 + j < n; j++) {
        if (i0 + j < 0) continue;
        const t = j / RATE / tau, env = Math.exp(-t / e.decay), burst = t < 0.0015 ? r.gauss() * 0.8 : 0;
        x[i0 + j] += e.gain * (burst + env * (0.6 * Math.sin(2 * Math.PI * e.freqs[0] / tau * t * tau) + 0.35 * Math.sin(2 * Math.PI * e.freqs[1] / tau * t * tau)) * 0.9);
      }
    } else {
      const len = Math.ceil(e.dur * tau * RATE); let y = 0;
      for (let j = 0; j < len; j++) { const k = i0 - len + j; if (k < 0 || k >= n) continue; const u = j / len; y += (r.gauss() - y) * 0.35; x[k] += e.gain * y * Math.sin(Math.PI * u) ** 2 * 0.3; }
    }
  }
  return x;
}

export function writeWav(path, x) {
  const n = x.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(clamp(x[i], -1, 1) * 32000), 44 + i * 2);
  writeFileSync(path, buf);
}
