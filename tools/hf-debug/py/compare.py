# compare.py BASELINE.jsonl NOW.jsonl [NIGHT.jsonl]: traced counts and every per-clip change against the baseline.
import json, os, sys
load = lambda p: {json.loads(l)['clip']: json.loads(l) for l in open(p) if l.strip()} if os.path.exists(p) else {}
base, now = load(sys.argv[1]), load(sys.argv[2])
ok = lambda d: d.get('status') in ('tracked', 'partial')
print(f"real clips: traced {sum(ok(d) for d in now.values())} of {len(now)} (baseline {sum(ok(d) for d in base.values())} of {len(base)}), "
      f"fully tracked {sum(d.get('status') == 'tracked' for d in now.values())} (baseline {sum(d.get('status') == 'tracked' for d in base.values())})")
for c in sorted(set(base) | set(now)):
    a, b = base.get(c, {}), now.get(c, {})
    if a.get('status') != b.get('status') or abs(a.get('obs', 0) - b.get('obs', 0)) > 2:
        print(f"  {'LOST ' if ok(a) and not ok(b) else 'GAIN ' if ok(b) and not ok(a) else 'diff '}{c}: {a.get('status')} ({a.get('obs', 0)}) -> {b.get('status')} ({b.get('obs', 0)}) {b.get('reasons')}")
if len(sys.argv) > 3 and os.path.exists(sys.argv[3]):
    for l in open(sys.argv[3]):
        if l.strip(): d = json.loads(l); print(f"night clip: {d.get('status')} ({d.get('obs', 0)} frames), baseline 2026-10-14: partial (10)")
