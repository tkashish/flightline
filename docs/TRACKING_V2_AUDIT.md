# Tracking V2 — code audit (Phase 0)

**Date:** 2026-10-13  
**Starting commit:** `9899b38` (`feat/automatic-tracking-v2` branched from `master`)  
**Method:** Read checked-out source; ran `npm test` (28 pass); ran offline FFmpeg baseline on available QA clips. Docs are secondary to code.

## Call graph (what actually runs)

```
File picker / drop
  → app.js openSwing / handleIncomingFiles
  → analyze(signal)
       → canvas scale long-edge ≤ 1280
       → Worker(dist/worker.js) init
       → if duration ≤ 16s: captureAnalysisFrames(..., fps=30)  [full RGBA prefetch]
       → else: seek+draw per frame
       → for i in 0..ceil(duration*30):
            t = i/30   ← hardcoded sample grid
            worker frame { buffer, time: t }
              → MotionTracker.detect(rgba, t)
                   cameraShift → mask → components
                   localFlightCandidates (only around this.best)
                   updateSpots / link / launch seed
                   may set this.best during forward pass
       → worker finish → tracker.result()
       → state.points = result.points   ← NO native refiner call
  → smoothFlight(points) on draw/export only
  → MediaRecorder export (unchanged)
```

**Present but not used by `analyze()`:**

- `dist/refiner.js` `BallRefiner`
- Worker messages `refine-init` / `refine-frame` / `refine-finish`
- Comment in `app.js` (~L334): refinement disabled after clothing false positives

`README.md` still claims a native second pass runs. **That claim is stale relative to `app.js`.**

## Stages: runs vs exists

| Stage | Status |
| --- | --- |
| HTMLVideo seek/decode on main thread | Runs |
| Analysis downscale ≤1280 | Runs |
| Prefetch all RGBA frames if duration ≤16s | Runs (memory-heavy) |
| Assumed 30 Hz sample times `t=i/30` | Runs |
| Camera translation estimate (±6 px) | Runs |
| Bright/contrast blob candidates | Runs |
| Stationary address spots + launch seed | Runs |
| Multi-track link with score; early `this.best` | Runs |
| Local sky coast around `this.best` only | Runs |
| `result()` glare/hook trim | Runs |
| Native `BallRefiner` | **Exists, disconnected** |
| Global offline path optimization | **Missing** |
| Multi-hypothesis launch retention until sequence end | **Partial** (tracks array exists; decision favors early `best`) |
| Calibrated abstention / reasonCodes | **Missing** (empty points → UI suggests manual adjust) |
| Feature flag `legacy` vs `v2` | **Not yet** (eval CLI accepts `--engine legacy` only) |

## Frame timing and coordinates

- **Time:** association uses `t` seconds, but sampling is a fixed 30 Hz grid, not measured PTS from `requestVideoFrameCallback.mediaTime` / WebCodecs.
- **Analysis space:** downscaled RGBA; tracker stores pixel coords then normalizes by `w/h` in `result()`.
- **Camera:** cumulative translation in analysis pixels → normalized in `camera[]`; renderer adds `cameraAt` when drawing.
- **Source orientation:** phone clips often have displaymatrix ±90. Browser `videoWidth/Height` is upright; FFmpeg filter graph also autorotates. Offline eval probes rotation and sizes analysis on upright geometry.
- **Contract:** `{ points:[{t,x,y}], camera:[{t,x,y}], engine:'motion-beta', observedFrames }` — no `status`, confidence, or observed/interpolated tags. `curve.js` `smoothFlight` may **extend** beyond last observation for drawing (separate from tracker observations).

## Memory footprint (order-of-magnitude)

- One 720×1280 RGBA frame ≈ 3.7 MB.
- Prefetch for ≤16 s @ 30 fps ≈ 480 frames ≈ **~1.8 GB** peak for analysis buffers alone before worker copies.
- Longer clips stream seek-per-frame (still one full RGBA/frame into the worker).

## Launch / ranking heuristics (failure-relevant)

- Launch seeds from stationary spots after disappearance; impact flood sets `seedBlockedUntil`.
- Ranking score ≈ length/rise/anchor − cost; longer creeping tracks can win.
- `localFlightCandidates` only searches around **current `this.best`** — wrong early identity poisons late search.
- Hard gates on brightness, speed, climb, chroma (many thresholds without measured calibration).

## Known failure paths (from architecture doc + code)

| ID | Clip (if available) | Failure | Phase 0 status |
| --- | --- | --- | --- |
| BALL-01 | `golf_slow_mo.mp4` | False launch ~3.47 s on golfer/club vs real ~4.43 s | **NOT RUN** — file not found under Downloads / repo |
| BALL-02 | `golf_swing.mp4` | Airplane identity switch ~4.1 s (historical refiner) | **NOT RUN** — file not found; refiner also disconnected now |
| BALL-03 | any | Browser decode ≠ FFmpeg candidates | Tooling ready; paired compare not yet automated |
| QA | `dist/qa/pxl.mp4`, `pxl300.mp4` | Available local regression clips | Offline baseline **RUN** (see `TRACKING_V2_BENCHMARK.md`) |

## Baseline commands executed

```text
git rev-parse HEAD  → 9899b38… (branch start)
npm test            → 28 pass / 0 fail (before Phase 0 test additions)
```

Offline eval (after harness landed) is recorded in `docs/TRACKING_V2_BENCHMARK.md` and `docs/benchmark-runs/`.

## Integration risks for V2

1. Do **not** reconnect `BallRefiner.detect()` as winner-takes-all without multi-candidate + global identity.
2. Replacing `t=i/30` requires updating velocity gates to use real `dt`.
3. UI currently nudges manual adjust on failure — keep control for compatibility but automatic flow must abstain cleanly (`no_reliable_track`) without requiring clicks.
4. `smoothFlight` extension must not be scored as observed recall.
