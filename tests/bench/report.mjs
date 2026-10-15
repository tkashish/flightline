#!/usr/bin/env node
/**
 * Benchmark reports (U7): assemble a run report from scored clips, check the gate, render markdown with strata,
 * confidence intervals and pass/fail per target, and compare runs (node vs browser parity, hf vs v2).
 *
 *   node tests/bench/report.mjs --in node.json [--browser browser.json] [--baseline v2-node.json]
 *        [--baseline-browser v2-browser.json] [--md out.md] [--json out.json]
 *   node tests/bench/report.mjs --a node.json --b browser.json          (parity only, D3 §9.6)
 *
 * Reports from run-node.mjs / run-browser.mjs keep every ClipMetrics, so this CLI re-aggregates them with the
 * current metric code and acceptance values. Two reports are compared only when their corpus pins agree
 * (metrics.mjs pinCheck: same generator version and code hash, same manifest hash for every common split, same
 * files per common clip); otherwise the CLI refuses and exits 2.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARAMS, PARAMS_VERSION } from '../../dist/hf/params.js';
import { aggregate, parity as parityOf, compareEngines, assertSamePin, DEFINITIONS } from './metrics.mjs';
import { checkGate, flipDecision } from './gate.mjs';

export const REPORT_SCHEMA = 'flightline-bench-report-v1';

/** A run report: run metadata, every ClipMetrics, the aggregate and the gate verdict. */
export function buildReport(clips, meta = {}, { acceptance = PARAMS.acceptance, bootstrap = DEFINITIONS.bootstrap } = {}) {
  const agg = aggregate(clips, { acceptance, bootstrap });
  const report = { schema: REPORT_SCHEMA, paramsVersion: PARAMS_VERSION, ...meta, n: clips.length, clips, aggregate: agg };
  report.gate = checkGate(report, acceptance, { runner: meta.runner ?? null });
  return report;
}

/** Re-aggregate a saved report with the current metric and gate code (scores are kept, aggregates are not). */
export const refresh = (report, opts) => buildReport(report.clips, Object.fromEntries(Object.entries(report).filter(([k]) => !['clips', 'aggregate', 'gate', 'n', 'schema'].includes(k))), opts);

/* ------------------------------------------------------------------ formatting */

const isNum = Number.isFinite;
const pct = v => (isNum(v) ? `${(100 * v).toFixed(v < 0.1 ? 2 : 1)}%` : '—');
const num = (v, d = 3) => (isNum(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(d)) : '—');
const rateCell = r => (r && r.n ? `${pct(r.p)} (${r.k}/${r.n})` : '—');
const ci = (lo, hi, f = pct) => (isNum(lo) && isNum(hi) ? `[${f(lo)}, ${f(hi)}]` : '—');
const rateCi = r => (r && r.n ? ci(r.lo, r.hi) : '—');
const qCell = (q, f = v => num(v)) => (q && isNum(q.value) ? `${f(q.value)} ${ci(q.lo, q.hi, f)}` : '—');
const esc = s => String(s ?? '').replace(/\|/g, '\\|');
const STATUS = { pass: 'PASS', fail: 'FAIL', 'no-data': 'NO DATA', 'n/a': 'n/a' };
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map((h, i) => (i ? '---:' : '---')).join(' | ')} |`, ...rows.map(r => `| ${r.map(esc).join(' | ')} |`)].join('\n');

function targetValue(r) {
  if (!isNum(r.estimate)) return '—';
  return /frac/.test(r.unit) ? pct(r.estimate) : num(r.estimate);
}
function targetBound(r) {
  const f = /frac/.test(r.unit) ? pct : v => num(v);
  return `${r.op === 'le' ? '≤' : '≥'} ${f(r.target)}`;
}

/** Markdown for one run report, with optional gate, parity, baseline comparison and flip decision. */
export function renderMarkdown(report, { gate = report.gate, parity = null, compare = null, flip = null, maxClips = 400 } = {}) {
  const S = report.aggregate.overall, Q = S.quality, L = [];
  const code = report.code ?? {};
  L.push(`# Flightline benchmark: ${report.engine ?? '?'} on ${report.split ?? '?'} (${report.runner ?? '?'})`, '');
  const pin = report.corpusPin;
  L.push(`- Corpus: \`${report.corpus ?? '?'}\` (${report.n} clips${pin ? '' : `; generator ${report.generator?.version ?? '?'}`})`);
  if (pin) {
    const gen = g => (g?.mixed ? `MIXED (${g.mixed.join(', ')})` : `${g?.version ?? '?'} code \`${String(g?.codeSha256 ?? '?').slice(0, 12)}\``);
    const one = !pin.generator?.mixed, splits = Object.entries(pin.splits).map(([k, v]) => `${k} ${v.clips} clips \`${v.manifestSha256.slice(0, 12)}\`${one ? '' : ` generator ${gen(v.generator)}`}, checksums ${v.checksums}`);
    L.push(`- Corpus pin: ${one ? `generator ${gen(pin.generator)}; ` : 'generator per split; '}manifest \`${pin.manifestSha256.slice(0, 12)}\` (${splits.join('; ')})${pin.stable === false ? `; **corpus changed during the run (${pin.changed?.length} files): not comparable**` : ''}`);
  } else L.push('- Corpus pin: none (this report cannot be compared with others)');
  L.push(`- Code: git \`${code.gitSha ?? '?'}\`${code.dirty ? ' (dirty)' : ''}, code hash \`${code.codeHash ?? '?'}\`${code.engineHash ? ` (engine \`${code.engineHash}\`, bench \`${code.benchHash}\`)` : ''}, params \`${report.paramsVersion}\`${report.entry ? `, entry \`${report.entry}\`` : ''}${report.path ? `, decode path \`${report.path}\`` : ''}`);
  L.push(`- Run: ${report.startedAt ?? '?'}, wall ${num((report.wallMs ?? NaN) / 1000, 1)} s, jobs ${report.jobs ?? '?'}${report.options?.resumed ? `, ${report.options.resumed} clips resumed from \`${report.options.clipLog}\`` : ''}${report.chrome ? `, ${report.chrome}` : ''}`);
  L.push('- Synthetic data only: these numbers say nothing about real footage until labelled real clips exist.', '');

  if (gate) {
    L.push(`## Gate: SAFETY ${gate.pass ? 'PASS' : 'FAIL'}${gate.qualityPass ? ', QUALITY all pass' : ''}`, '');
    if (!gate.pass) L.push(`Failing: ${gate.failures.join(', ') || '(none)'}`, '');
    L.push(table(['Precondition', 'Status', 'Detail'], gate.preconditions.map(p => [p.id, p.pass ? 'PASS' : 'FAIL', p.detail])), '');
    L.push(table(['Target', 'Tier', 'Requirement', 'Estimate', '95% CI', 'n', 'Bound', 'Status', 'At CI bound'],
      gate.results.map(r => [r.id, r.tier, r.text, targetValue(r), /frac/.test(r.unit) ? ci(r.lo, r.hi) : ci(r.lo, r.hi, v => num(v)), r.n ?? '—', targetBound(r), STATUS[r.status], r.passAtBound == null ? '—' : r.passAtBound ? 'pass' : 'fail'])), '');
  }
  if (flip) {
    L.push(`## Default-engine flip: ${flip.flip ? 'YES' : 'NO'}`, '');
    for (const r of flip.reasons) L.push(`- ${r}`);
    L.push('');
  }
  if (compare) {
    L.push(`## hf vs baseline (${compare.clips == null ? 'summaries' : `${compare.clips} common clips`})`, '');
    L.push(table(['Metric', 'hf', 'baseline', 'hf better'], [
      ['Coverage (trace clips, identity correct)', pct(compare.coverage.hf), pct(compare.coverage.base), compare.coverage.better ? 'yes' : 'no'],
      [`Position error median (${compare.position.unit})`, num(compare.position.hf), num(compare.position.base), compare.position.better ? 'yes' : 'no']
    ]), '');
  }
  if (parity) {
    L.push('## Node / browser parity', '');
    L.push(table(['Metric', 'Value', '95% CI', 'n'], [
      ['Decision agreement', pct(parity.decision.p), rateCi(parity.decision), parity.decision.n],
      ['Launch frame agreement', pct(parity.launchFrame.p), rateCi(parity.launchFrame), parity.launchFrame.n],
      ['Median observed Δposition (px)', num(parity.positionPx.value), `p95 ${num(parity.positionPx.p95)}`, parity.positionPx.n]
    ]), '');
    const dis = parity.perClip.filter(c => c.a !== c.b || c.launchFrameA !== c.launchFrameB);
    if (dis.length) L.push(table(['Clip', 'Status A', 'Status B', 'Launch frame A', 'Launch frame B', 'Median Δ px'], dis.slice(0, 50).map(c => [c.id, c.a, c.b, c.launchFrameA ?? '—', c.launchFrameB ?? '—', num(c.medianPx)])), '');
  }

  L.push('## Safety', '');
  L.push(table(['Metric', 'Rate', '95% CI'], [
    ['P(wrong | traced)', rateCell(S.safety.wrongGivenTraced), rateCi(S.safety.wrongGivenTraced)],
    ['P(wrong identity | traced)', rateCell(S.safety.wrongIdentityGivenTraced), rateCi(S.safety.wrongIdentityGivenTraced)],
    ['Club-head false track (clips with an impact)', rateCell(S.safety.clubFalseTrack), rateCi(S.safety.clubFalseTrack)],
    ['No-ball false trace', rateCell(S.safety.noBallFalseTrace), rateCi(S.safety.noBallFalseTrace)],
    ['Invisible-ball control abstention', rateCell(S.safety.invisibleAbstain), rateCi(S.safety.invisibleAbstain)],
    ['Distractor steal (traced hits)', rateCell(S.safety.distractorSteal), rateCi(S.safety.distractorSteal)]
  ]), '');
  L.push(`Wrong-trace reasons (traced clips): ${Object.entries(S.safety.wrongReasons).map(([k, v]) => `${k} ${v}`).join(', ')}. Runner errors ${S.errors}, invalid results ${S.invalid}.${S.perf ? ` ${S.perf} perf-set clips count for runtime and memory only.` : ''}`, '');
  L.push(table(['Expected', 'n', 'tracked', 'partial', 'abstained', 'wrong'], Object.entries(S.confusion).map(([e, c]) => [e, c.n, c.tracked, c.partial, c.abstained, c.wrong])), '');

  L.push('## Quality', '');
  L.push(table(['Coverage class', 'Coverage', '95% CI'], Object.entries(Q.coverage).map(([k, r]) => [k, rateCell(r), rateCi(r)])), '');
  L.push(table(['Launch and identity', 'Value', '95% CI'], [
    ['|dt| <= 1 frame', rateCell(Q.launchFrame), rateCi(Q.launchFrame)],
    [`point <= ${PARAMS.acceptance.quality.launchPointD0} d0`, rateCell(Q.launchPoint), rateCi(Q.launchPoint)],
    ['dt frames median / p95', `${num(Q.launchDtFrames.median)} / ${num(Q.launchDtFrames.p95)}`, `n ${Q.launchDtFrames.n}`],
    ['point d0 median / p95', `${num(Q.launchPointD0.median)} / ${num(Q.launchPointD0.p95)}`, `n ${Q.launchPointD0.n}`],
    ['observed points matched', rateCell(Q.identityMatched), `${rateCi(Q.identityMatched)} ${Q.identityMatched.ci}`],
    ['identity switches', rateCell(Q.identitySwitch), rateCi(Q.identitySwitch)]
  ]), '');
  L.push(table(['Recall bin (SNR)', 'Recall', '95% CI', 'Target'], Q.recall.map(b => [b.snrLo == null ? `< ${b.snrHi}` : b.snrHi == null ? `>= ${b.snrLo}` : `${b.snrLo}-${b.snrHi}`, rateCell(b), `${rateCi(b)} ${b.n ? b.ci : ''}`, b.target == null ? 'report only' : `>= ${pct(b.target)}`])), '');
  L.push(table(['Position error', 'Median [95% CI]', 'p95 [95% CI]', 'points'], Object.entries(Q.position).map(([k, v]) => [`${k} (${v.unit})`, qCell(v.median), qCell(v.p95), v.median.n])), '');
  L.push(table(['Completion (identity-correct traces)', 'n', 'Median [95% CI]', 'p90 [95% CI]'], [
    ['shape max, >= 30% observed (diag)', Q.completion.long.n, qCell(Q.completion.long.median, pct), qCell(Q.completion.long.p90, pct)],
    ['shape max, < 30% observed (diag)', Q.completion.short.n, qCell(Q.completion.short.median, pct), qCell(Q.completion.short.p90, pct)],
    ['landing time (flight time)', Q.completion.landingTime.n, qCell(Q.completion.landingTime.median, pct), qCell(Q.completion.landingTime.p90, pct)],
    ['end point (diag)', Q.completion.endErr.n, pct(Q.completion.endErr.median), pct(Q.completion.endErr.p90)],
    ['shape mean (diag)', Q.completion.shapeMean.n, pct(Q.completion.shapeMean.median), pct(Q.completion.shapeMean.p90)],
    ['end type agrees with GT', Q.completion.endTypeAgree.n, rateCell(Q.completion.endTypeAgree), '']
  ]), '');
  L.push(`Calibration: ECE ${pct(Q.calibration.ece.value)} over ${Q.calibration.n} traced clips (labels: ${Q.calibration.calibratedOn.join(', ') || 'none'}).`, '');
  if (Q.calibration.bins.length) L.push(table(['Confidence bin', 'n', 'mean confidence', 'fraction correct'], Q.calibration.bins.map(b => [`${num(b.lo, 1)}-${num(b.hi, 1)}`, b.n, num(b.conf), num(b.acc)])), '');
  const R = Q.runtime;
  L.push(table(['Runtime', 'Value', 'n'], [
    [`10 s 4K60 (${R.k4k60.projected === false ? 'perf set' : 'projected'}, s)`, num(R.k4k60.value, 1), R.k4k60.n], [`10 s 1080p30 (${R.p1080p30.projected === false ? 'perf set' : 'projected'}, s)`, num(R.p1080p30.value, 1), R.p1080p30.n],
    ...Object.entries(R.byFormat).map(([k, v]) => [`${k}: ms/frame, x realtime`, `${num(v.msPerFrame, 2)} ms, ${num(v.realtime, 2)}x`, v.n]),
    ...Object.entries(R.phasesMs).map(([k, v]) => [`phase ${k} (median ms)`, num(v, 1), ''])
  ]), '');
  L.push(table(['Memory', 'max', 'p95', 'n'], Object.entries(Q.memory).map(([k, v]) => [k, num(v.value, 1), num(v.p95, 1), v.n])), '');

  L.push('## Strata', '');
  for (const [key, groups] of Object.entries(report.aggregate.strata)) {
    L.push(`### ${key}`, '');
    L.push(table(['Value', 'n', 'traced', 'coverage [CI]', 'P(wrong|traced) [CI]', 'club', 'recall >= 6', 'pos median (d)', 'completion median'],
      Object.entries(groups).map(([v, g]) => [v, g.n, g.traced, `${rateCell(g.quality.coverage.all)} ${rateCi(g.quality.coverage.all)}`, `${rateCell(g.safety.wrongGivenTraced)} ${rateCi(g.safety.wrongGivenTraced)}`,
        rateCell(g.safety.clubFalseTrack), rateCell(g.quality.recall[0]), num(g.quality.position.large.median.value), pct(g.quality.completion.long.median.value ?? g.quality.completion.short.median.value)])), '');
  }

  L.push('## Clips', '');
  L.push(table(['Clip', 'Set', 'Expected', 'Outcome', 'Wrong', 'Launch dt (frames)', 'Matched', 'Recall', 'Completion max', 'ms/frame', 'Notes'],
    report.clips.slice(0, maxClips).map(c => {
      const vis = c.recall?.reduce((s, b) => s + (b.lo == null ? 0 : b.visible), 0) ?? 0, hit = c.recall?.reduce((s, b) => s + (b.lo == null ? 0 : b.matched), 0) ?? 0;
      return [c.id, `${c.set ?? 'main'}${c.control ? ` (${c.control})` : ''}`, c.expected, c.outcome, c.wrong ? c.wrongReasons.join('+') : '', num(c.launch?.dtFrames, 2), c.identity ? pct(c.identity.fracMatched) : '—', vis ? pct(hit / vis) : '—',
        pct(c.completion?.shapeMax), num(c.runtime?.msPerFrame, 2), [c.error, ...(c.validationErrors || []).slice(0, 2), c.reasonCodes?.join(' ')].filter(Boolean).join('; ')];
    })), '');
  if (report.clips.length > maxClips) L.push(`(${report.clips.length - maxClips} more clips in the JSON report)`, '');
  L.push('## Definitions', '');
  L.push(`- Point match: |p − g| <= max(${PARAMS.acceptance.matchPx} px, ${PARAMS.acceptance.matchD}·d(t)) against the GT ball of the frame on screen at the point's time; result points go through the result camera first.`);
  L.push(`- Traced: status tracked or partial with >= 2 points. Wrong: ${DEFINITIONS.wrong.note}`);
  L.push(`- ${DEFINITIONS.snrNote} GT-visible: post-impact flight frames in frame, not occluded, not duplicates.`);
  L.push(`- Completion: predicted points only, alpha >= ${DEFINITIONS.completionMinAlpha}; shape = distance to the GT arc2d polyline, per clip the max, as a fraction of the diagonal.`);
  L.push('- Intervals: Wilson 95% for clip rates; cluster bootstrap over clips for frame- and point-pooled metrics and quantiles.');
  L.push(`- Sets: ${DEFINITIONS.sets}`);
  L.push('- Corpus pin: per split, the sha256 of the `<sha256>  <file>` listing of every clip file (the generator\'s checksums.sha256 format), the generator version and code hash; reports with different pins are not compared.');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
  }
  return o;
}
const load = async p => (p ? refresh(JSON.parse(await readFile(resolve(p), 'utf8'))) : null);

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.a && a.b) {
    const [A, B] = [await load(a.a), await load(a.b)];
    assertSamePin(A, B, `${a.a} and ${a.b}`);
    const P = parityOf(A.clips, B.clips);
    const md = renderMarkdown(A, { parity: P });
    if (a.md) await writeFile(resolve(a.md), md);
    console.log(md);
    return;
  }
  if (!a.in) {
    console.log('Usage: node tests/bench/report.mjs --in report.json [--browser b.json] [--baseline v2.json] [--baseline-browser v2b.json] [--md out.md] [--json out.json]\n       node tests/bench/report.mjs --a node.json --b browser.json');
    process.exit(a.help ? 0 : 1);
  }
  const node = await load(a.in), browser = await load(a.browser), base = await load(a.baseline), baseB = await load(a['baseline-browser']);
  for (const [k, r] of [['browser', browser], ['baseline', base], ['baseline-browser', baseB]]) if (r) assertSamePin(node, r, `${a.in} and --${k} ${a[k]}`);
  const P = browser ? parityOf(node.clips, browser.clips) : null;
  if (P) node.gate = checkGate(node, PARAMS.acceptance, { parity: P, runner: node.runner });
  const compare = base ? compareEngines(node, base) : null;
  const flip = base || browser ? flipDecision({ node: node.runner === 'browser' ? null : node, browser, baselineNode: base, baselineBrowser: baseB, parity: P }) : null;
  const md = renderMarkdown(node, { parity: P, compare, flip });
  if (a.md) await writeFile(resolve(a.md), md);
  if (a.json) await writeFile(resolve(a.json), JSON.stringify(node));
  console.log(md);
  if (browser) console.log(renderMarkdown(browser, { parity: P }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(e => { console.error(e.code === 'corpus-pin' ? e.message : e); process.exit(e.code === 'corpus-pin' ? 2 : 1); });
