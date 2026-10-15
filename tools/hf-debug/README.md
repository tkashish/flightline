# hf debug tools

Command-line tools used to debug the `hf` engine on real clips (see `docs/TRACKING_HF_STATUS.md`). They import the
engine from `../../dist/hf`, so run them from any directory with Node 24. Clip arguments are paths to video files;
positions are stabilized native pixels unless noted. Image tools need Python 3 with Pillow and `ffmpeg` on the PATH.

## One-command check

```
zsh tools/hf-debug/check-all.sh [name]
```

It runs three things and compares them with the 2026-10-14 baselines in `baselines/`:

- **Safety bench:** the frozen synthetic clips. The per-clip statuses must stay identical to `baselines/bench-baseline-clean-plus-hold`.
- **Real clips:** the 33 private clips.
- **Night clip:** the night test clip.

Expected now: recallSnr6 90.0%, statuses identical, 25 of 33 real clips traced (19 fully), night clip partial (10).

Override the data locations with environment variables:

| Variable | Default |
| --- | --- |
| `FLIGHTLINE_BENCH` | `~/Documents/flightline-dev/bench/frozen` |
| `FLIGHTLINE_CLIPS` | `~/Documents/Photos-1-001` |
| `FLIGHTLINE_NIGHT_CLIP` | `~/Downloads/PXL_20261014_034239108~3.mp4` |
| `FLIGHTLINE_BASELINE` | `tools/hf-debug/baselines` |
| `FLIGHTLINE_OUT` | `/tmp/flightline-hf-check` |

## Tools by pipeline step

Most scripts accept `OVR='{"scan":{…}}'` (a `mergeParams` override) to try a param change without editing code:
`hf-summary`, `rank-impacts`, `why-impact`, `dump-frames`, `gate-debug`, `club-debug` and `track-flags`.

### Whole pipeline

| Tool | Usage | Shows |
| --- | --- | --- |
| `hf-summary.mjs` | `<clip>` | One JSON line: status, reasons, tracked frames (`obs`), impact hypotheses, launch decisions, seconds. |
| `triage.mjs` + `py/triage_draw.py` | `triage.mjs <clip> > t.json`, then `triage_draw.py t.json <clip> out.png` | Every impact hypothesis drawn on the address frame. Use it to see whether the real ball is among them. |
| `obs-dump.mjs` | `<clip>` | Track observations as JSON (normalized). |
| `py/trace_check.py` | `<obs.json> <clip> out.png` | Flight frames stacked into one image, with the app's points circled. This is the accuracy check. |
| `py/after_hit.py` | `<clip> <x> <y> <k> out.png` | Frames k…k+3 above the address, plus k+1…k+10 stacked: what the ball looks like after the hit. |

### Step 1: ball on the mat (coarse scan, spots)

| Tool | Usage | Shows |
| --- | --- | --- |
| `why-spot.mjs` | `<clip> <x> <y> [r]` | Spots near (x, y): presence, ballLike, roundness, fill, z, and their vacates. |
| `why-impact.mjs` | `<clip> <x> <y> [r]` | Why each vacate near (x, y) did or did not become an impact (invalid, arrival veto, R1, cast shadow). |
| `rank-impacts.mjs` | `<clip> [n]` | The full ranked hypothesis list, with co-timed vacate counts (camera-event bursts). |
| `dump-frames.mjs` | `<clip> <x> <y> <r>` | Per frame, every candidate blob and spot observation near (x, y), as JSON. |
| `py/app_view.py` | `frames.json frames-nocap.json <frames dir> <out dir>` | The app's grayscale view per frame with detections marked. Used for `~/Documents/flightline-debug/033354445`. |
| `cand-count.mjs` | `<clip>` | Candidates per frame without the cap. |
| `movers-dump.mjs` | `<clip>` | Coarse-scan movers. |
| `cam-pair.mjs` | `<clip> <a> <b>` | Camera estimate between frames a and b, with per-patch offsets. Shows zoom steps. |
| `cam-burst.mjs` | `<clip> <k> [w]` | Camera estimates and frame differences around frame k. |

### Step 3: launch confirmation

| Tool | Usage | Shows |
| --- | --- | --- |
| `gate-debug.mjs` | `<clip> <spotId>` | Top blob and streak chains of the real address, and the gate each failed (f1, f2, f5, f6, law, timing, clubhits, outrun, …). |
| `streak-debug.mjs` | `<clip> <spotId>` | Every streak chain evaluation, with its samples. |
| `launch-debug.mjs` | `<clip>` | Launch decision per hypothesis, with chain counts. |
| `club-debug.mjs`, `club-debug-blob.mjs` | `<clip> <spotId>` | The club track against the best streak or blob chain. Shows the lone-ball confusion. |
| `lball.mjs` | `<clip> <spotId>` | The reference ball luma and contrast at the address. |

### Steps 4-6: flight tracking, fit, decision

| Tool | Usage | Shows |
| --- | --- | --- |
| `track-obs.mjs` | `<clip>` | The final track per launch: frame, flag (inlier, rejected, static, mover), source, position, z. |
| `track-flags.mjs` | `<clip>` | Flag counts and end reason. |
| `pred-law.mjs` | `<clip> <k0> <k1>` | The tracker's mode, law θ and predictions for frames k0…k1. |
| `detect-log.mjs` | `<clip> <k0> <k1>` | TBD detection attempts: prediction, σ, velocity σ, score, threshold, rejection reason. |
| `fit-dump.mjs` | `<clip>` | Flight fit summary per candidate. |
| `cands.mjs`, `r3.mjs` | `<clip>` | Candidate summaries and the evaluation parts of R1-R3. |

### Temporary decision logging

`decide.js` and `roi-detect.js` were sometimes given temporary debug lines guarded by `HF_DEBUG_FIT` or `HF_DEBUG_D`.
None are left in the code. Add one, run, then restore the file.
