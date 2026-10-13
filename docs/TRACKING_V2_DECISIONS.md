# Tracking V2 — decision log

| Date | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| 2026-10-13 | Start with Phase 0 harness before any tracker threshold changes | Jump to Kalman / reconnect refiner | Spec forbids claims without measured baseline; reconnecting refiner known to steal identity |
| 2026-10-13 | Offline eval via FFmpeg RGBA @ 30fps, long-edge 1280, autorotate | Browser-only automation first | Deterministic, scriptable, matches existing `inspect-video.mjs`; browser acceptance still required later |
| 2026-10-13 | Annotations in upright **source pixels** | Analysis-normalized labels | Resolution-invariant scoring; matches spec |
| 2026-10-13 | Mark missing historical clips as `not_run`, never pass | Synthetic stand-ins claiming BALL-01 fixed | Spec: never assert bugs fixed without footage |
| 2026-10-13 | Keep `BallRefiner` code but do not wire into `analyze` | Re-enable immediately | Clothing/airplane false positives; needs multi-candidate identity-safe design (Phase 3–4) |
| 2026-10-13 | Gitignore `local-manifest.json` and annotation exports | Commit user paths | Privacy; paths are machine-specific |

| 2026-10-13 | Stream seek→analyze→release; drop ≤16s full RGBA prefetch | Keep prefetch for speed | Spec memory bound; ~1.8GB prefetch risk on 1080p×16s; seekable uploads don't need it |
| 2026-10-13 | Rank final track with length-normalized `identityScore` + multi-coast seeds | Keep winner-takes-all `this.best` only | Early clothing creeps starve local search; Phase 2 requires competing launches |
| 2026-10-13 | Add `RoiEvidenceDetector` soft top-K; do not fuse into `analyze()` yet | Reconnect `BallRefiner.detect()` | Spec forbids winner-take-all native refine; need Phase 4 association first |
| 2026-10-13 | Chronological 65/35 tune/holdout split on Photos-1-001 by filename | Random frame split | Spec: never split neighboring frames; whole videos only |

## Rejected (for now)

- Relaxing global sky brightness thresholds without ROI evidence (raises false alarms).
- Hard image-space gravity (`ay = g`) without camera calibration.
- Treating `smoothFlight` extensions as observed detections in metrics.
- Reconnecting legacy `BallRefiner.detect()` as sole late-flight decider.
