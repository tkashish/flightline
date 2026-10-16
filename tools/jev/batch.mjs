// Trace a set of clips with full logs and a review report per clip, plus an index: node tools/jev/batch.mjs OUT_DIR CLIP...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const run = promisify(execFile), [OUT, ...clips] = process.argv.slice(2), HERE = new URL('.', import.meta.url).pathname;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rows = []; let next = 0;
async function worker() {
  while (next < clips.length) {
    const v = clips[next++], name = v.split('/').pop().replace(/\.(mp4|mov)$/i, ''), dir = join(OUT, name), t = Date.now();
    mkdirSync(dir, { recursive: true });
    const row = { name, video: v };
    try {
      await run('node', [join(HERE, 'run.mjs'), v, join(dir, 'result.json'), '--keep-crops', dir], { maxBuffer: 1 << 26, timeout: 600000 });
      await run('node', [join(HERE, 'report.mjs'), v, join(dir, 'result.json'), dir], { maxBuffer: 1 << 26, timeout: 600000 });
      await run('node', [join(HERE, 'still.mjs'), v, join(dir, 'result.json'), join(dir, 'still.jpg')]).catch(() => {});
      const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), d = r.diagnostics;
      Object.assign(row, { status: r.status, obs: r.observedFrames, tail: r.points.filter(p => p.status === 'predicted').length, calls: d.jev.calls, tokens: d.jev.tokens, usd: d.jev.tokens * 42e-9, jevSec: d.jev.ms / 1000, why: r.reasonCodes.join(', ') + (d.why ? ` — ${d.why}` : '') });
    } catch (e) { Object.assign(row, { status: 'error', why: String(e.stderr || e.message).slice(-300) }); writeFileSync(join(dir, 'error.txt'), String(e.stderr || e.message)); }
    row.sec = (Date.now() - t) / 1000; rows.push(row);
    console.log(`${rows.length}/${clips.length} ${name} ${row.status} obs=${row.obs ?? '-'} $${(row.usd ?? 0).toFixed(5)}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
rows.sort((a, b) => a.name.localeCompare(b.name));
const tot = rows.reduce((s, r) => ({ usd: s.usd + (r.usd || 0), calls: s.calls + (r.calls || 0), tokens: s.tokens + (r.tokens || 0) }), { usd: 0, calls: 0, tokens: 0 });
const count = st => rows.filter(r => r.status === st).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ totals: tot, rows }, null, 1));
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset=utf-8><title>Jev traces — all videos</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:middle}img{height:160px}.tracked{color:#1a7f37}.partial{color:#b26a00}.no_reliable_track,.error{color:#c62828}</style>
<h1>Jev traces — ${rows.length} videos</h1><p><b>${count('tracked')}</b> traced with a heading tail · <b>${count('partial')}</b> partial · <b>${count('no_reliable_track')}</b> no trace · <b>${count('error')}</b> errors · ${tot.calls} Jev questions · ${tot.tokens.toLocaleString()} tokens · <b>$${tot.usd.toFixed(4)}</b> in total (TypeSafe's listed $42 per billion input tokens)</p>
<table><tr><th>Video</th><th>Trace</th><th>Result</th><th>Frames traced</th><th>Tail</th><th>Jev questions</th><th>Cost</th><th>Time</th><th>Note</th></tr>
${rows.map(r => `<tr><td><a href="${encodeURIComponent(r.name)}/index.html">${esc(r.name)}</a></td><td><a href="${encodeURIComponent(r.name)}/index.html"><img src="${encodeURIComponent(r.name)}/still.jpg"></a></td><td class="${esc(r.status)}">${esc(r.status)}</td><td>${r.obs ?? '—'}</td><td>${r.tail ?? '—'}</td><td>${r.calls ?? '—'}</td><td>$${(r.usd ?? 0).toFixed(5)}</td><td>${r.sec.toFixed(0)} s</td><td>${esc(r.why)}</td></tr>`).join('')}</table>`);
console.log('TOTAL', rows.length, 'clips · tracked', count('tracked'), 'partial', count('partial'), 'none', count('no_reliable_track'), 'error', count('error'), '· calls', tot.calls, '· $' + tot.usd.toFixed(4), '\nindex:', join(OUT, 'index.html'));
