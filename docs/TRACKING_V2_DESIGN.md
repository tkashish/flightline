# Tracking V2 — design (living doc)

**Status:** Phases 0–5 landed. UI defaults to `engine=v2` with relative confidence + honest abstention.  
**Constraint:** Browser-local upload → automatic ball track → export. No runtime manual ball/impact clicks.

## Target pipeline

```
Timestamp-aware decode (bounded cache)
  → Coarse scan: camera motion + multiple LaunchHypothesis
  → Per-hypothesis native ROI evidence (top-K soft candidates, multi-frame matched motion)
  → Global beam / second-order association + null state
  → Bidirectional smooth of OBSERVED points only; abstain if weak
  → Existing smoothFlight / preview / export contract
```

## Engines

| Flag | Meaning |
| --- | --- |
| `v2` | **UI default.** Detectors + Phase 4 beam association. Returns `status` / `reasonCodes` / relative confidence; may abstain. Escape hatch: `?engine=legacy`. |
| `legacy` | Forward `MotionTracker` ranking only (`?engine=legacy` or `--engine legacy`). |

## Coordinate systems

1. **Source pixels** — upright decoded frame (`video.videoWidth` × `video.videoHeight`). Annotation space.
2. **Analysis pixels** — downscaled long-edge ≤1280.
3. **Camera-stabilized analysis** — minus cumulative translation.
4. **Normalized** — `/w`, `/h` for renderer contract.
5. **Native ROI local** — crop-relative; map with `source = cropOrigin + local` exactly once.

Eval metrics convert normalized+camera → source pixels before scoring.

## Observation vs prediction

Internal points carry `status: observed | interpolated | predicted`.  
Only `observed` (and short bridged `interpolated` between anchors) may feed the export tracer by default. Predictions never become new measurements.

## Scoring (planned)

`score(path) = launch_prior + Σ evidence − Σ motion − Σ gap − Σ identity`  
Normalize for length so long clutter paths cannot win by accumulation alone. Compare to explicit null/no-ball hypothesis.

## Phase map

| Phase | Goal | Gate |
| --- | --- | --- |
| 0 | Audit, fixtures, metrics CLI, baseline | Harness runs; baseline recorded |
| 1 | PTS-aware frames + bounded memory | Parity with legacy on labeled clips; no OOM on 1080p 15s |
| 2 | Multi launch hypotheses | Real launch survives; false 3.47s-style rejected when GT available |
| 3 | Native multi-frame ROI evidence | Weak per-frame / strong temporal unit tests pass |
| 4 | Global association | No airplane/golfer identity steal on holdout |
| 5 | Confidence + UI abstention | `no_reliable_track` without manual requirement |
| 6 | Optional ML | Only if classical fails measured holdout |

## Non-goals

World-space gravity, carry distance, launch-monitor numbers, cloud inference, mandatory audio impact detection.
