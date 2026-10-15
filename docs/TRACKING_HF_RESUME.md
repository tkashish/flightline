# Resuming the hf tracking work

Everything needed to pick up the `hf` engine work exactly where it stopped on 2026-10-14, in a new session, by a person
or by Claude Code. Read this first, then [TRACKING_HF_STATUS.md](TRACKING_HF_STATUS.md), which says where things stand.

## 1. Documents, in reading order

1. **This file:** setup, checks, working method, preferences.
2. **[TRACKING_HF_STATUS.md](TRACKING_HF_STATUS.md):** current results, every change and why, what still fails, what was tried and undone.
3. **[TRACKING_HF_PROTOCOL.md](TRACKING_HF_PROTOCOL.md):** module map, contracts, APIs, params and reason codes of the engine.
4. **[hf-design/FINAL.md](hf-design/FINAL.md):** the binding design. It grafts onto the base design [hf-design/D3.md](hf-design/D3.md) with [D1](hf-design/D1.md) and [D2](hf-design/D2.md).
5. **[../tools/hf-debug/README.md](../tools/hf-debug/README.md):** the debug tools.
6. **[../tests/synth/README.md](../tests/synth/README.md):** the synthetic clip generator behind the safety bench.

## 2. What must be on the machine

| Item | Where | Notes |
| --- | --- | --- |
| Repo | `/Users/katayal/Documents/flightline`, branch `high-fidelity-traces` | **Nothing is committed.** The v2 fixes, the whole hf engine (`dist/hf/`), tests, generator, tools and docs exist only in this working tree. Back it up or commit before risky operations. |
| Node | 24.x | `node --version` |
| ffmpeg, ffprobe | `/opt/homebrew/bin` | The generator and the image tools use them. |
| Python 3 + Pillow | system | Image tools in `tools/hf-debug/py`. Run with `python3 -I`. |
| Google Chrome | `/Applications` | Browser tests (`tests/bench/cdp.mjs`). |
| Real clips (private) | `~/Documents/Photos-1-001/*.mp4` (33) and `~/Downloads/PXL_20261014_034239108~3.mp4` (night) | The user's own videos. Never commit, upload or copy them into the repo. |
| Frozen synthetic bench | `~/Documents/flightline-dev/bench/frozen/{easy,smoke11}` (125 MB, 10 clips with `.gt.json`) | The safety reference. Keep it; regenerated clips differ if the generator changed (section 6). |
| Archives | `~/Documents/flightline-dev/archive/` | Snapshots of the `/tmp` worktrees (`hf-synth` generator, `hf-phase1` app work), the original scratch scripts and the design docs, all taken 2026-10-14. |
| Baseline results | `tools/hf-debug/baselines/`, copied to `~/Documents/flightline-dev/results/` | The real-clip batch at the start and end of 2026-10-14, and the bench baseline. |
| User debug folder | `~/Documents/flightline-debug/033354445/` | Frames and the app's view for one clip. |

Leftovers in `/tmp` (`/tmp/flightline-understand` 12 GB, `/tmp/flightline-real`, the worktrees `/private/tmp/flightline-synth`
and `/private/tmp/flightline-phase1`) are no longer needed. Everything of value is in the repo or in
`~/Documents/flightline-dev`. Remove the worktrees with `git worktree remove` only after confirming that.

## 3. Check that the state is as documented

```
cd /Users/katayal/Documents/flightline
git branch --show-current            # high-fidelity-traces
npm test                             # 770 tests, 770 pass (737 engine/app + 33 generator), ~75 s
zsh tools/hf-debug/check-all.sh now  # ~8 min
```

`check-all.sh` should print:

```
synthetic safety bench: recallSnr6 90.0%, per-clip statuses identical to the baseline
real clips: traced 25 of 33 (baseline 25 of 33), fully tracked 19 (baseline 19)
night clip: partial (10 frames), baseline 2026-10-14: partial (10)
```

To try the app: run `npm run dev`, open http://127.0.0.1:5173/?engine=hf and hard-refresh. The default engine is still
`v2`.

## 4. How the work was done (keep doing it this way)

1. **Pick a failing clip** from section 7 of the status doc.
2. **Find the failing step with evidence, not guesses:**
   - `triage.mjs` + `py/triage_draw.py`: is the real ball among the impact hypotheses?
   - `py/after_hit.py`: what does the ball look like after the hit?
   - `gate-debug.mjs`: which launch gate fails?
   - `track-obs.mjs`, `pred-law.mjs`, `detect-log.mjs`: where does tracking lose it?
   - Look at the actual frames whenever a number is surprising.
3. **Fix the cause with the smallest principled change.** It must have a physical or geometric reason that holds beyond the clip. Comment the reason in the code, with the real-clip numbers.
4. **Add a unit test** that fails on the old code and passes on the new.
5. **Verify everything:**
   - `npm test` must pass.
   - `check-all.sh`: the synthetic per-clip statuses must stay identical and no real clip may be lost.
   - Check new traces against the frames with `py/trace_check.py` (accuracy).
6. **Revert anything that does not help.** Record failed ideas in section 8 of the status doc.
7. **Update `TRACKING_HF_STATUS.md`:** results table, changes, still-failing list.

**Lessons:**
- Synthetic-tuned gates break on real video in specific, explainable ways: zoom steps, half-lit night balls, the bay roof shading the address, a camera low behind the ball, compression, an invisible dark club head.
- A change that fixes one clip often breaks a safety test. The fake-ball tests (club pins, movers, practice swings) are the guard.

## 5. User preferences (for whoever continues, including Claude)

- **Debugging:** debug directly with the tools; do not start multi-agent workflows for debugging. The user asked for this explicitly.
- **Explanations:** simple English first (what the app saw, which rule rejected the ball), then the technical detail.
- **Priorities:** accuracy and getting the ball traced matter more than runtime. The user said: "I don't care how much time it takes."
- **Git:** do not commit or push unless asked.
- **Privacy:** the videos are private. Keep them local.
- **Updates:** keep the user informed during long tasks, and say plainly what did not work.

## 6. If the frozen bench is lost

Regenerate with the generator (`node tests/synth/cli.mjs --split easy`, and `--split smoke`; see its README). The
frozen corpus is a fixed subset of 10 clips: `easy-01 -02 -05 -09 -11 -15 -17 -21` and `smoke-04 -13`. Regenerated
clips match only when the generator code is unchanged: every `.gt.json` records `generator.codeSha256`. A regenerated
corpus is a new baseline, so rerun `check-all.sh` on the current code and save its `bench.log` as the new baseline
before using it to judge changes.

## 7. Prompt to start a new Claude Code session

```
Continue the Flightline hf tracking work. Read docs/TRACKING_HF_RESUME.md, then docs/TRACKING_HF_STATUS.md
(and docs/TRACKING_HF_PROTOCOL.md and docs/hf-design/FINAL.md as needed). Verify the state with `npm test` and
`zsh tools/hf-debug/check-all.sh now` and confirm the numbers match the docs. Then work on the next item in section 7 of
the status doc: measure the ground-truth ball positions in the three night clips that are lost right after the launch
(033429984~3, 033520851~3, 034418482~3), then fix the tracker's early-flight predictor and TBD velocity search against
that data. Follow the working method and user preferences in the resume doc: debug directly (no workflows), explain
in simple English, keep the safety bench identical, never lose a real clip, revert what does not help, don't commit.
```
