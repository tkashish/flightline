# Tracking V2 — benchmark log

## Baseline snapshot: `tracking-v1` / engine `legacy`

| Field | Value |
| --- | --- |
| Date (UTC) | 2026-10-13T07:14:11Z |
| Git SHA | `9899b38` (harness added after this SHA on `feat/automatic-tracking-v2`) |
| Command | `node tests/evaluate-tracking.mjs --manifest tests/fixtures/local-manifest.json --engine legacy --json docs/benchmark-runs/baseline-legacy.json` |
| Device | Local macOS; FFmpeg offline decode (not browser) |
| Unit tests | `npm test` → **33 pass / 0 fail** (28 prior + 5 metrics tests) |

### Per-clip results

| Clip | Status | Observed | First t (s) | Last t (s) | Analysis | Wall time | Notes |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| golf_slow_mo | **not_run** | — | — | — | — | — | File missing at `/Users/kashishtayal/Downloads/golf_slow_mo.mp4` |
| golf_swing | **not_run** | — | — | — | — | — | File missing at `/Users/kashishtayal/Downloads/golf_swing.mp4` |
| pxl_qa | unknown_ground_truth | 62 | 1.733 | 3.967 | 720×1280 from 2160×3840 upright | 7.5 s | No source-pixel labels yet |
| pxl300_qa | unknown_ground_truth | 17 | 1.667 | 2.200 | 720×1280 from 2160×3840 upright | 6.9 s | No source-pixel labels yet |

### pxl_qa track summary (legacy)

- Launch (normalized): `(0.617, 0.572)` @ 1.733 s
- End: `(0.726, 0.447)` @ 3.967 s
- Competing track buffer: 20 entries retained (top scores ≈ 102–103); bestScore ≈ 100.8 after result trim
- **No shot-level pass/fail** without annotations — do not treat 62 points as “correct ball”

### pxl300_qa track summary (legacy)

- Launch (normalized): first @ 1.667 s; end @ 2.200 s; **17** observations
- Shorter track than pxl_qa; identity unverified

### Historical acceptance clips

Documented in `ARCHITECTURE_AND_PROGRESS.md` but **not present on disk** for this baseline:

- `golf_slow_mo.mp4`: require impact ≈ 4.43 s; reject false origin ≈ 3.47 s → **NOT RUN**
- `golf_swing.mp4`: require real launch ≈ 2.13 s; no airplane switch ≈ 4.1 s → **NOT RUN**

Place files at the paths in `tests/fixtures/local-manifest.json` (gitignored) and re-run eval. Prefer adding `tests/fixtures/annotations/*.json` with upright source-pixel labels before claiming accuracy.

### How to reproduce

```bash
cp tests/fixtures/manifest.example.json tests/fixtures/local-manifest.json
# edit paths; optional annotations
npm test
npm run eval:tracking -- --json docs/benchmark-runs/baseline-legacy.json --md docs/benchmark-runs/baseline-legacy.md
node tests/contact-sheet.mjs --input dist/qa/pxl.mp4 --out /tmp/pxl-sheet --every 0.25
```

### Browser visual / export

Phase 0 did **not** claim browser export verification. Offline FFmpeg baseline only.

---

## Phase 1 start (timestamp helpers) — 2026-10-13

| Change | Effect on accuracy |
| --- | --- |
| `dist/frame-source.js` + tests | Infrastructure only |
| `analyze()` uses `video.currentTime` after seek | Timing fidelity; **no claim of better ball identity** |
| Ring-buffer helpers | Not yet replacing full RGBA prefetch |

Re-run offline baseline expected to match `tracking-v1` observation counts within sampling noise (same detector). Accuracy claims deferred until labeled clips exist.

---

## After later milestones

Append a new dated section per engine change. Always compare with `node tests/compare-results.mjs docs/benchmark-runs/baseline-legacy.json <new.json>`. Never overwrite the baseline file; write `milestone-N-<engine>.json`.
