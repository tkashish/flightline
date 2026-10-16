// Review report for one traced clip: node tools/jev/report.mjs CLIP.mp4 RESULT.json DIR
// DIR must hold crops/ from `run.mjs --keep-crops DIR`. Writes DIR/trace.mp4 and DIR/index.html.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const [video, resultFile, dir] = process.argv.slice(2);
const r = JSON.parse(readFileSync(resultFile, 'utf8')), d = r.diagnostics ?? {}, log = d.log ?? [];
const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim().split(',').map(Number);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const name = video.split('/').pop(), usd = t => `$${((t ?? 0) * 42e-9).toFixed(5)}`;

/* ---- trace video: the curve drawn up to each frame's time; Jev points ringed on their frame ---- */
const ffj = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', video], { maxBuffer: 1 << 26 }).toString());
const times = ffj.frames.map(f => +f.best_effort_timestamp_time);
const jevAt = new Map((d.track ?? []).filter(p => p.src === 'jev').map(p => [p.k, p]));
await new Promise((resolve, reject) => {
  const dec = spawn('ffmpeg', ['-v', 'error', '-i', video, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(Math.round(times.length / ((times.at(-1) - times[0]) || 1)) || 30), '-i', '-', '-vf', 'scale=-2:min(1280\\,ih)', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', join(dir, 'trace.mp4')]);
  const FS = W * H * 3; let buf = Buffer.alloc(0), k = 0;
  const dot = (f, x, y, rad, c, a = 1) => { for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { if (dx * dx + dy * dy > rad * rad) continue; const X = Math.round(x + dx), Y = Math.round(y + dy); if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const i = (Y * W + X) * 3; for (let j = 0; j < 3; j++) f[i + j] = Math.round(f[i + j] * (1 - a) + c[j] * a); } };
  const ring = (f, x, y, rad, c) => { for (let a = 0; a < 64; a++) dot(f, x + rad * Math.cos(a / 64 * 2 * Math.PI), y + rad * Math.sin(a / 64 * 2 * Math.PI), 1, c); };
  dec.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FS) {
      const f = Buffer.from(buf.subarray(0, FS)); buf = buf.subarray(FS);
      const t = times[k] ?? Infinity;
      for (const p of r.points) if (p.t <= t + 1e-6) dot(f, p.x * W, p.y * H, 4, p.status === 'predicted' ? [255, 220, 0] : [255, 50, 30], p.alpha ?? 1);
      const j = [...jevAt.values()].find(p => Math.abs((times[p.k] ?? -1) - t) < 1e-6) ?? null;
      if (j) ring(f, j.x, j.y, 14, [0, 255, 120]);
      if (!enc.stdin.write(f)) { dec.stdout.pause(); enc.stdin.once('drain', () => dec.stdout.resume()); }
      k++;
    }
  });
  dec.stdout.on('end', () => enc.stdin.end());
  enc.on('close', code => code === 0 ? resolve() : reject(new Error(`encoder exited ${code}`)));
});

/* ---- html ---- */
const boxStyle = (crop, b) => crop && b ? `left:${(b.x0 - crop.x0) / (crop.w / crop.scale) * 100}%;top:${(b.y0 - crop.y0) / (crop.h / crop.scale) * 100}%;width:${(b.x1 - b.x0) / (crop.w / crop.scale) * 100}%;height:${(b.y1 - b.y0) / (crop.h / crop.scale) * 100}%` : '';
const dotStyle = (crop, p) => crop && p ? `left:${(p.x - crop.x0) / (crop.w / crop.scale) * 100}%;top:${(p.y - crop.y0) / (crop.h / crop.scale) * 100}%` : '';
const pic = (crop, b, refined, guess) => crop && existsSync(join(dir, 'crops', crop.file))
  ? `<div class=pic><img src="crops/${esc(crop.file)}"><div class=box style="${boxStyle(crop, b)}"></div>${refined ? `<div class=dot style="${dotStyle(crop, refined)}" title="our refined position"></div>` : ''}${guess ? `<div class=guess style="${dotStyle(crop, guess)}" title="where we expected the ball"></div>` : ''}</div>` : '<i>crop not kept</i>';
const probs = a => a?.probabilities ? Object.entries(a.probabilities).map(([k, v]) => `${esc(k)} ${(+v).toFixed(2)}`).join(' · ') : '';
const addr = log.filter(l => l.step === 'address').map(l => `<tr><td>${l.k}<br><small>${(+l.t || 0).toFixed(3)} s</small></td>${(l.calls ?? []).map((c, i) => `<td>${pic(c.crop, c.boxPx, i === 1 ? l.refined : null)}<div class=k>${i ? '512 px crop' : 'full frame (shrunk)'} · box confidence <b>${c.answers?.box?.confidence}</b> · "ball on the mat?" ${c.answers?.present?.noul}</div></td>`).join('')}<td>${l.refined && l.conf?.[1] >= 0.5 ? '<b class=ok>used</b>' : '<b class=no>not used</b>'}</td></tr>`).join('');
const flights = log.filter(l => l.step === 'flight').map(l => `<tr class="${l.accepted ? 'ok' : 'no'}"><td>${l.k}<br><small>${(+l.t || 0).toFixed(3)} s</small></td><td>${pic(l.crop, l.boxPx, l.refined, l.guess)}</td>
<td><div><b>Look:</b> ${esc(l.look)} <small>(${probs(l.answers?.look)})</small></div><div><b>Ball box</b> conf ${l.answers?.ball?.confidence} · <b>Streak box</b> conf ${l.answers?.streak?.confidence} · used: ${esc(l.used)}</div><div><b>"Ball visible?"</b> ${l.present}</div><div><small>crop ${l.size} px at ${l.crop?.x0},${l.crop?.y0} · ${l.ms ?? '?'} ms · ${l.tokens ?? '?'} tokens (${usd(l.tokens)})</small></div></td>
<td>${l.accepted ? `<b class=ok>accepted</b><br>at ${Math.round(l.at?.x)}, ${Math.round(l.at?.y)}` : `<b class=no>rejected</b><br>${esc(l.why)}`}</td></tr>`).join('');
const events = log.filter(l => !['address', 'flight'].includes(l.step)).map(l => `<li><b>${esc(l.step)}</b>${l.k != null ? ` frame ${l.k}` : ''}${l.lastPresent != null ? ` · ball last on its spot at frame ${l.lastPresent}, impact t=${(+l.t0).toFixed(3)} s at ${Math.round(l.at?.x)}, ${Math.round(l.at?.y)}` : ''}${l.src ? ` · ${esc(l.src)}` : ''}${l.off != null ? ` · ${l.off} px off` : ''}${l.why ? ` · ${esc(l.why)}` : ''}${l.peak != null ? ` · swing guess at frame ${l.peak}` : ''}</li>`).join('');
const track = (d.track ?? []).map(p => `<span class="src ${p.src}">${p.k}:${p.src} ${p.x},${p.y}</span>`).join(' ');
const pred = r.points.filter(p => p.status === 'predicted').length;
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset=utf-8><title>${esc(name)} — Jev trace report</title>
<style>body{font:14px system-ui;margin:24px;max-width:1300px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}
.pic{position:relative;display:inline-block;line-height:0}.pic img{width:240px;height:auto;display:block}.box{position:absolute;border:2px solid #f22;box-sizing:border-box}
.dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#0f8}.guess{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px dashed #3af;border-radius:50%;box-sizing:border-box}
.ok{color:#1a7f37}.no{color:#c62828}tr.no{background:#fff6f6}.k{color:#666;font-size:12px;line-height:1.4;margin-top:4px}.src{font:12px monospace;padding:1px 4px;border-radius:3px;margin:1px;display:inline-block}
.src.jev{background:#fff1a8}.src.search{background:#c9f1ff}.src.curve{background:#eee}.src.coast{background:#e3d9ff}dl{display:grid;grid-template-columns:max-content auto;gap:4px 16px}dt{color:#666}</style>
<p><a href="../index.html">← all videos</a></p>
<h1>${esc(name)}</h1>
<dl><dt>Result</dt><dd><b>${esc(r.status)}</b>${r.reasonCodes?.length ? ` (${esc(r.reasonCodes.join(', '))})` : ''}</dd>
<dt>Traced frames</dt><dd>${r.observedFrames} observed · ${pred} predicted tail points${r.completion ? ` · ends: ${esc(r.completion.end.type)}` : ''}</dd>
<dt>Jev</dt><dd>${d.jev?.calls ?? 0} questions · ${d.jev?.tokens ?? 0} tokens · <b>${usd(d.jev?.tokens)}</b> · ${((d.jev?.ms ?? 0) / 1000).toFixed(1)} s of Jev time</dd>
<dt>Total time</dt><dd>${((d.ms ?? 0) / 1000).toFixed(1)} s</dd>
<dt>Frames</dt><dd>address frame ${d.addressFrame ?? '—'} · impact frame ${d.impactFrame ?? '—'} · repeated frames dropped ${d.repeatedFramesDropped ?? 0}</dd>
${d.why ? `<dt>Why no trace</dt><dd>${esc(d.why)}</dd>` : ''}${d.tailDropped ? `<dt>Tail dropped</dt><dd>${esc(d.tailDropped.join('; '))}</dd>` : ''}</dl>
<h2>Trace video</h2><video src="trace.mp4" controls loop muted style="max-height:720px;max-width:100%"></video>
<p class=k>Red: traced flight. Yellow, fading: predicted "where it was heading". Green ring: a frame where Jev's answer was used.</p>
<h2>1. Ball before the swing (Jev)</h2><table><tr><th>Frame</th><th>Question 1</th><th>Question 2</th><th></th></tr>${addr || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>2. Flight: every Jev question</h2><p class=k>Red box: Jev's answer (the box it chose: ball or streak). Green dot: our refined position. Dashed blue circle: where our code expected the ball.</p>
<table><tr><th>Frame</th><th>Crop sent to Jev</th><th>Jev's answers</th><th>Our decision</th></tr>${flights || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>3. Our code's other decisions</h2><ul>${events || '<li>none</li>'}</ul>
<h2>4. Final points by frame</h2><p class=k>yellow = Jev, blue = our search, grey = curve fill, purple = our search after Jev lost the ball</p><p>${track || 'none'}</p>
<p><a href="result.json">Full result and log (JSON)</a></p>`);
console.log('report:', join(dir, 'index.html'));
