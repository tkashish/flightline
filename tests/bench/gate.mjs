/**
 * Acceptance gate (U7): FINAL.md "Acceptance gate". Values come from PARAMS.acceptance (dist/hf/params.js); the
 * target list (which report metric each value bounds, its tier and comparison) comes from acceptance.json.
 * SAFETY targets must all pass, with data, and every run must have finished with a valid result; QUALITY targets
 * are reported. The default engine flips to hf only when the gate passes in both Node and headless Chrome AND hf
 * beats v2 on coverage and position error on the same holdout (flipDecision).
 */
import { PARAMS } from '../../dist/hf/params.js';
import { ACCEPTANCE_SPEC, compareEngines, pinCheck } from './metrics.mjs';

export const getPath = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const summaryOf = r => r?.aggregate?.overall ?? r?.overall ?? r;

/**
 * A run report (it has clips) must also carry a corpus pin from a corpus that did not change during the run, with one
 * generator per split (corpusPinned); aggregates and summaries are judged on their numbers alone.
 * @param {object} report  a run report ({runner, aggregate, clips, corpusPin}), an aggregate ({overall}) or a summary
 * @param {object} [acceptance]  threshold values, PARAMS.acceptance shape
 * @param {{spec?:object, parity?:object|null, runner?:string}} [opts]  parity: metrics.parity() of node vs browser
 * @returns {{pass:boolean, safetyPass:boolean, qualityPass:boolean, preconditions:object[], results:object[], failures:string[]}}
 */
export function checkGate(report, acceptance = PARAMS.acceptance, { spec = ACCEPTANCE_SPEC, parity = null, runner = report?.runner ?? null } = {}) {
  const S = summaryOf(report);
  const results = spec.targets.map(t => {
    const target = getPath(acceptance, t.param), base = { id: t.id, tier: t.tier, metric: t.metric, op: t.op, target, unit: t.unit, text: t.text };
    if (t.source === 'browser' && runner !== 'browser') return { ...base, status: 'n/a', pass: null, note: 'browser runs only' };
    if (t.source === 'parity' && !parity) return { ...base, status: 'n/a', pass: null, note: 'needs a node and a browser report' };
    const m = getPath(t.source === 'parity' ? parity : S, t.metric);
    const est = typeof m === 'number' ? m : m?.p ?? m?.value ?? null, n = typeof m === 'object' ? m?.n ?? null : null;
    const lo = m?.lo ?? null, hi = m?.hi ?? null;
    if (est == null || !Number.isFinite(est)) return { ...base, status: 'no-data', pass: false, estimate: null, n, lo, hi };
    const ok = v => t.op === 'le' ? v <= target + 1e-12 : v >= target - 1e-12, bound = t.op === 'le' ? hi : lo;
    return { ...base, status: ok(est) ? 'pass' : 'fail', pass: ok(est), estimate: est, n, lo, hi, passAtBound: bound == null ? null : ok(bound) };
  });
  const preconditions = [
    { id: 'noRunErrors', pass: (S?.errors ?? 0) === 0, detail: `${S?.errors ?? 0} clips ended in a runner or engine error` },
    { id: 'validResults', pass: (S?.invalid ?? 0) === 0, detail: `${S?.invalid ?? 0} results failed validateResult` },
    { id: 'clips', pass: (S?.n ?? 0) > 0, detail: `${S?.n ?? 0} clips scored` }
  ];
  if (Array.isArray(report?.clips)) {
    const p = report.corpusPin, mixed = p?.mixed ?? (p?.generator?.mixed ? ['all'] : []), ok = !!p && p.stable !== false && !mixed.length;
    const gens = p && Object.entries(p.splits ?? {}).map(([s, v]) => `${s} ${v.generator?.version ?? p.generator?.version ?? '?'} ${String(v.generator?.codeSha256 ?? p.generator?.codeSha256 ?? '?').slice(0, 12)}`).join(', ');
    preconditions.push({ id: 'corpusPinned', pass: ok, detail: !p ? 'no corpus pin' : mixed.length ? `split ${mixed.join(', ')} mixes generator versions` : p.stable === false ? `corpus changed during the run (${p.changed?.length ?? '?'} files)` : `manifest ${p.manifestSha256.slice(0, 12)}; generator ${gens}` });
  }
  const tier = k => results.filter(r => r.tier === k && r.status !== 'n/a');
  const safetyPass = tier('safety').every(r => r.status === 'pass');
  const qualityPass = tier('quality').every(r => r.status === 'pass');
  const pass = safetyPass && preconditions.every(p => p.pass);
  const failures = [...preconditions.filter(p => !p.pass).map(p => p.id), ...results.filter(r => r.status === 'fail' || (r.tier === 'safety' && r.status === 'no-data')).map(r => r.id)];
  return { pass, safetyPass, qualityPass, preconditions, results, failures };
}

/**
 * The default-engine decision: hf gate passes on Node and on headless Chrome, and hf beats v2 on coverage and
 * position error on the same holdout clips (Node and, when given, browser). Every missing input blocks the flip, and
 * so do run reports whose corpus pins differ (metrics.mjs pinCheck).
 */
export function flipDecision({ node, browser, baselineNode, baselineBrowser = null, parity = null, acceptance = PARAMS.acceptance } = {}) {
  const reasons = [], gates = {};
  for (const [name, r] of [['node', node], ['browser', browser]]) {
    if (!r) { reasons.push(`no ${name} hf report`); continue; }
    if (r.split && r.split !== 'holdout') reasons.push(`${name} report is on split '${r.split}', not holdout`);
    gates[name] = checkGate(r, acceptance, { parity, runner: name });
    if (!gates[name].pass) reasons.push(`${name} gate fails: ${gates[name].failures.join(', ')}`);
  }
  if (node && browser && Array.isArray(node.clips) && Array.isArray(browser.clips)) {
    const pin = pinCheck(node, browser);
    if (!pin.ok) reasons.push(`node and browser reports have different corpus pins: ${pin.reasons.join('; ')}`);
  }
  const vs = {};
  for (const [name, a, b] of [['node', node, baselineNode], ['browser', browser, baselineBrowser]]) {
    if (!a || !b) { if (name === 'node' || baselineBrowser) reasons.push(`no ${name} v2 baseline`); continue; }
    try { vs[name] = compareEngines(a, b); } catch (e) { if (e.code !== 'corpus-pin') throw e; reasons.push(`${name}: ${e.message}`); continue; }
    if (!vs[name].coverage.better) reasons.push(`${name}: hf coverage ${vs[name].coverage.hf} does not beat v2 ${vs[name].coverage.base}`);
    if (!vs[name].position.better) reasons.push(`${name}: hf position error ${vs[name].position.hf} ${vs[name].position.unit} does not beat v2 ${vs[name].position.base}`);
  }
  return { flip: reasons.length === 0, reasons, gates, vs };
}
