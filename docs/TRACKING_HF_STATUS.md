# Tracking HF: where we are (status as of 2026-10-14)

This is the working status of the `hf` ("high-fidelity") tracking engine: what is built, how it does on real videos,
every change made while debugging real clips, what still fails and why, what was tried and undone, and how to verify
and continue. To pick the work up in a new session start with [TRACKING_HF_RESUME.md](TRACKING_HF_RESUME.md). For the
engine's module map, contracts and APIs see [TRACKING_HF_PROTOCOL.md](TRACKING_HF_PROTOCOL.md); the design it implements
is in [hf-design/](hf-design/).

## 1. Summary

- **Real clips:** 25 of the 33 Pixel clips in `~/Documents/Photos-1-001` now trace: 19 fully tracked and 6 partial. At the start of the 2026-10-14 debugging this was 15 (11 fully tracked).
- **Night clip:** the user's first test clip (`~/Downloads/PXL_20261014_034239108~3.mp4`) gives a partial trace with 10 tracked frames (was 6).
- **No regressions:** no clip that traced before the 2026-10-14 work stopped tracing.
- **Tests:** all 770 tests pass (`npm test`): 737 engine and app tests plus 33 tests of the synthetic clip generator.
- **Safety bench:** the frozen synthetic bench (fake balls, planes, birds, specks, club-only swings) gives exactly the same per-clip results as before the real-clip fixes. recallSnr6 is 90.0% and wrong-given-traced is ≤ 1%.
- **Still failing (8):** 5 night clips, 1 night "club only", 1 daytime clip (straight-line gate) and 1 likely slow-motion clip. Most of the night ones fail in early-flight tracking: the ball is found and its launch confirmed, then lost 2-3 frames later (section 7).
- **Next step:** measure ground-truth ball positions frame by frame in the three "lost after launch" night clips, then fix the tracker's early-flight predictor against that data. Six trial-and-error predictor changes failed (section 8).

## 2. Where the code is

- **Repo and branch:** `/Users/katayal/Documents/flightline`, branch `high-fidelity-traces` (built on `automatic-tracking-v2`). **Nothing is committed.** `git status` shows the v2 fixes (modified `dist/tracker.js`, `dist/global-associate.js`, `dist/curve.js`, …) plus these untracked additions:
  - the whole new hf engine: `dist/hf/`, `tests/hf-*.test.js`, `tests/hf/`, `tests/bench/`;
  - the synthetic clip generator: `tests/synth/` and `tests/synth-*.test.js`, merged on 2026-10-14 from the `/tmp` worktree `hf-synth`;
  - the debug tools: `tools/hf-debug/`;
  - the docs: `docs/hf-design/`, this doc, `TRACKING_HF_RESUME.md` and `TRACKING_HF_PROTOCOL.md`.
- **Engine selection:** `DEFAULT_ENGINE` is still `'v2'` (`dist/frame-source.js`). Use the hf engine with `?engine=hf`.
- **Run locally:** `npm run dev` serves `dist/` at http://127.0.0.1:5173. Open http://127.0.0.1:5173/?engine=hf and hard-refresh after code changes.
- **Tests:** `npm test` runs `node --test tests/*.test.js` (770 tests, about 75 s).
- **Private videos:** the real clips are the user's private videos. Keep them local; never commit, upload or copy them into the repo. Only their file names appear here.

## 3. How the hf engine finds the ball (plain English)

1. **Coarse scan** (`coarse-scan.js`, `spots.js`, `camera-motion.js`): one low-resolution pass (long edge 960 px) over the whole video. It measures camera motion and lists bright and dark blobs in every frame (`CandidateDetector`, up to `scan.candidates.maxPerFrame`). It links blobs that sit still into spots and records when a spot disappears (a "vacate").
2. **Impact hypotheses** (`impact.js`): the vacates of ball-like, long-dwelling spots, filtered by the arrival veto, R1 last-to-leave and the cast-shadow rule, ranked and capped at `impact.maxHypotheses`.
3. **Launch confirmation** (`launch-null.js`, `emergence.js`, `club.js`): around each impact, at full resolution, the engine looks for the ball leaving the spot. It fits a chain of blobs (blob mode), or of motion-blur streaks (streak mode), to a projective-line law, and applies hard gates f1-f7 plus club rules: club-explained (clubhits), outrun, attachment and precursor. It also checks a null margin against fake anchors.
4. **Flight tracking** (`flight-tracker.js`, `roi-detect.js`): an MHT tracker predicts where the ball should be next and searches a small window with track-before-detect (TBD) over a velocity grid. Its predictor starts from the launch law, then a local quadratic, then the full M3D flight fit.
5. **Flight check and completion** (`flight-model.js`, `complete.js`, `display-curve.js`): an M3D ballistic fit with R2 gates (inliers, χ²/dof, plausible physics), then completion of the arc after the last sighting.
6. **Decision** (`decide.js`, `confidence.js`): rules R1-R5 and a provisional, uncalibrated confidence give `tracked`, `partial` or `no_reliable_track` plus reason codes.

## 4. Results on real clips

These were measured with Node using `tests/hf/helpers/node-source.mjs` and the default params. "Start" is the state at
the start of the 2026-10-14 debugging; "now" is the current code. Numbers in brackets are tracked frames (inlier
observations).

| Clip (`~/Documents/Photos-1-001/…mp4`) | Light | fps | Start | Now | Reasons now |
| --- | --- | --- | --- | --- | --- |
| `PXL_20261011_181512218~2` | day | 30 | no_reliable_track (0) | tracked (65) | - |
| `PXL_20261011_181512218~2_inverted` | day | 30 | tracked (66) | tracked (71) | - |
| `PXL_20261011_181732209~2` | day | 30 | tracked (51) | tracked (51) | multiple_shots |
| `PXL_20261011_182057358~2` | day | 30 | no_reliable_track (0) | tracked (80) | - |
| `PXL_20261011_182136184~2` | day | 30 | tracked (69) | tracked (109) | - |
| `PXL_20261011_182223973~2` | day | 30 | no_reliable_track (0) | tracked (101) | - |
| `PXL_20261011_182310942~2` | day | 30 | tracked (122) | tracked (129) | - |
| `PXL_20261011_182505110~2` | day | 30 | no_reliable_track (0) | no_reliable_track (0) | ball_left_frame_too_fast, no_launch |
| `PXL_20261011_182647649~2` | day | 30 | tracked (26) | tracked (26) | - |
| `PXL_20261011_182951067~2` | day | 30 | no_reliable_track (0) | tracked (13) | - |
| `PXL_20261011_183130509~2` | day | 30 | tracked (123) | tracked (125) | - |
| `PXL_20261011_183206205~2` | day | 30 | no_reliable_track (0) | no_reliable_track (0) | ball_not_found_after_impact, ball_left_frame_too_fast |
| `PXL_20261011_183624850~2` | day | 30 | partial (84) | partial (88) | completion_uncertain |
| `PXL_20261011_183742730~2` | day | 30 | partial (11) | tracked (101) | - |
| `PXL_20261011_184242253~2` | day | 30 | partial (5) | partial (5) | tracking_ended_early |
| `PXL_20261011_184333857~2` | day | 30 | tracked (34) | tracked (34) | - |
| `PXL_20261011_184651468~2` | day | 30 | tracked (41) | tracked (41) | - |
| `PXL_20261011_184909660~2` | day | 30 | tracked (29) | tracked (29) | multiple_shots |
| `PXL_20261011_184957300~2` | day | 30 | tracked (14) | tracked (14) | - |
| `PXL_20261011_185135706~2` | day | 30 | tracked (29) | tracked (29) | - |
| `PXL_20261014_033354445~3` | night | 30 | no_reliable_track (0) | tracked (22) | - |
| `PXL_20261014_033429984~3` | night | 30 | no_reliable_track (0) | no_reliable_track (0) | flight_inconsistent |
| `PXL_20261014_033520851~3` | night | 30 | no_reliable_track (0) | no_reliable_track (0) | flight_inconsistent |
| `PXL_20261014_033724226~3` | night | 30 | partial (26) | partial (27) | completion_uncertain |
| `PXL_20261014_033724226~3_inverted` | night | 30 | no_reliable_track (0) | tracked (26) | - |
| `PXL_20261014_033756395~3` | night | 30 | no_reliable_track (0) | tracked (15) | - |
| `PXL_20261014_033847735~4` | night | 30 | no_reliable_track (0) | no_reliable_track (0) | club_only_motion |
| `PXL_20261014_034024039~3` | night | 30 | no_reliable_track (0) | partial (23) | completion_uncertain |
| `PXL_20261014_034109764~3` | night | 60 | no_reliable_track (0) | no_reliable_track (0) | ball_not_found_after_impact, ball_left_frame_too_fast |
| `PXL_20261014_034147749~2` | night | 30 | no_reliable_track (0) | partial (15) | completion_uncertain |
| `PXL_20261014_034147749~3` | night | 60 | no_reliable_track (0) | partial (29) | completion_uncertain |
| `PXL_20261014_034323643~3` | night | 30 | no_reliable_track (0) | no_reliable_track (0) | ball_left_frame_too_fast, ball_not_found_after_impact |
| `PXL_20261014_034418482~3` | night | 30 | no_reliable_track (0) | no_reliable_track (0) | low_confidence |

**Accuracy spot checks.** New traces were checked against the frames: all flight frames stacked into one image, with the
app's points drawn on top. That was done for `033354445~3`, `182951067~2`, `033756395~3` and `034147749~2`; all follow
the ball. In `034147749~2` single frames 556-559 were also checked, because the stacked path crosses the club's
follow-through: the points sit on the ball, and the trace ends where the ball passes behind the golfer's cap. My
drawings skip the camera correction, so the points sit a few pixels off the ball. The app applies the correction when
it renders.

**About the clips.** All but two are 30 fps. They are Google Photos edited or cropped exports at a low bitrate:
0.7-3 Mbps at 30 fps, and up to 12.5 Mbps for the 60 fps ones. The night clips come from a covered driving-range bay,
filmed from behind at the golfer's back with floodlights out over the range. The daytime clips have a low camera beside
the mat. All but one are 1080p-wide portrait; the night ones are cropped to about 1350-1760 × 1920.

## 5. Changes made while debugging real clips

Each change was made because a real clip failed for that reason, and was kept only if the full test suite and the
safety bench stayed clean. They are grouped by pipeline step. "Test" names the unit test added to pin the change.

### 5.1 Earlier fixes (before 2026-10-14)

- **v2 engine bug fixes.** Every verified v2 bug was fixed in `dist/tracker.js`, `dist/global-associate.js`, `dist/curve.js` and related files. See `git diff` on those files.
- **`scan.candidates.maxPerFrame` 48 → 192.** A night range filled the cap before the address ball was listed.
- **`impact.maxHypotheses` 4 → 8.** Co-timed fake vacates crowded out the real impact.
- **`impact.envelope.postSec` 0.5 → 0.1 s.** On a real down-the-line clip the swing envelope took in the ball's own flight and vetoed it as club motion.
- **`spots.js` relink.** `linkR(sp, c)` uses `relinkD` (0.6 d) for a candidate at least `relinkGrow` (1.3×) the spot's size. A ball the club head half-hid at address grows and re-centres when uncovered.
- **`spots.js` duplicate rule.** The radius is now `relinkD · max(d)`, and the survivor inherits the older spot's `firstIndex` and `arrivalMovers`.
- **`club.js` `LEAD_WINDOW = 1.5`.** The outrun universal lead applies only within 1.5 frames of the club's impact time.
- **`launch-null.js` static precursor.** `PRECURSOR_STATIC_D0`: hits that are all within d0 of each other are a static object, not a precursor.
- **`flight-tracker.js` `holdAtCap`.** The prediction σ is held at the cap while the head index has not passed, instead of planning a cap end.
- **`tests/bench/cdp.mjs`.** The Chrome close no longer hangs the test process.

### 5.2 Camera motion: sudden zoom steps

- **Seen:** the Pixel's stabilisation or digital zoom jumps 2-6% in one frame, often right at impact on night clips. A translation-only robust start found no consensus, so the camera estimate failed. Every spot then "vacated" at once (100-300 fake vacates in one frame), and they filled every impact slot.
- **Change:** `camera-motion.js` `robustFit` also tries the exact similarity of every pair of patches at least `minSpread` apart, with |scale − 1| ≤ `pairMaxScale` (0.15) and rotation ≤ `pairMaxRotDeg` (5°). The best pair replaces the best translation when it scores `pairWin` (1.5×) more. Real frames: the 5.7% zoom went from 1/48 to 37/48 inliers.
- **Test:** `estimateMotion recovers zoom steps of 2-5.5% in one frame on every scene`. It covers 8 scenes × 4 zooms; the old code failed 6 of 8 scenes at 5.5%.

### 5.3 Finding the ball on the mat (coarse scan and impact hypotheses)

- **Arrival veto stretched by a slow-motion guess.**
  - Seen: a club-hidden first step looked like 240 fps capture, so the veto window grew 8× (1.5 s → 12 s). A ball raked in and hit 2.9 s later was vetoed as "a body part that paused".
  - Change: `impact.js` `findImpacts` stretches the arrival veto only with a container capture-rate hint (`meta.captureFpsHint`). R1 still uses the step prior.
  - Test: an extra case in the `arrival veto` test.
- **Split ball record.**
  - Seen: the ball was recorded twice. One record covered 78% of its frames (80% needed); the other was thrown out as a duplicate.
  - Change: `spots.js` `vacatesOut`: the survivor's presence is the union of both records' frames (`unionPresence`).
  - Test: `two records of one ball (split at address): the surviving record counts the frames either record saw`.
  - Debug folder: `~/Documents/flightline-debug/033354445/`.
- **Night blob cap.**
  - Seen: a night frame holds 460-550 blobs. At 192 the address ball dropped off the list in 14 of its 24 backswing frames. Listing everything (640) added faint static spots, the flight tracker then mistook the ball for them, and one clip lost 34 of its 101 points.
  - Change: `scan.candidates.maxPerFrame` = 256.
  - Test: none dedicated (the cap tests use overrides).
- **Floodlit ball looks oval.**
  - Seen: light from above shows only the ball's lit half. A half disc reads 1.89 and real night balls read 1.9-2.25, so they failed `maxEigRatio` 1.8.
  - Change: new `scan.spot.maxEigRatioBright` = 2.3 for bright spots. Dark spots keep 1.8: at 2.3 a dark resting club head became ball-like and a "swing without a ball" produced an impact.
  - Test: none dedicated; the coarse swing tests guard the dark case.
- **Uncovered ball blocked for 0.6 s.**
  - Seen: when the club lifted, the "ball + club" blob vanished. A watched spot reserves its address for its recovery for the whole recover window (18 frames), so the lone ball got a record only 3 frames before the hit.
  - Change: `spots.js` `push`: a candidate clearly larger than the watched spot (≥ `relinkGrow`) is not reserved.
  - Test: none dedicated.
- **Uncovering read as an arrival.**
  - Seen: the uncovered ball's new record counted 6 "arrivals" from the takeaway and was vetoed.
  - Change: `spots.js` `spotsOut` hand-off. A spot that appears where another of the same polarity ends (overlapping, or within `maxGapFrames`, within `relinkD` diameters) inherits that spot's first sighting and arrival count.
  - Test: none dedicated.

### 5.4 Launch confirmation

- **Down-the-line outrun.**
  - Seen: with a low camera behind the ball, a ball flying at the target moves 70 px on screen while the club head sweeps 256 px. E2b's "universal lead" (from synthetic data) rejected the real ball.
  - Change: `launch-null.js` `recedesClear` skips outrun when the chain recedes from the camera and stays clear of the head: law `c·fps ≥ club.recede.minCPerSec` (9/s), at least `minSamples` (4) samples, each at least `clearD0` (3 d0) from the measured head in its frame. Used in both blob and streak modes.
  - Test: `outrun exemption: a chain receding from the camera, clear of the measured head, …`.
- **Tried and reverted: a 1 px slack on f1 straightness.** It fixed `182505110~2` but let a pre-existing mover and the club pin (seed 5389) through in two safety tests.
- **Night: the club tracker takes the ball for the club.**
  - Seen: at night the dark club head is invisible. `club.js` takes the lone body leaving the address as the head (the deliberate invisible-ball control), which here is the ball streak. Its arrival fit was also implausible (an "impact velocity" pointing straight up). The real ball then failed clubhits, outrun or attached.
  - Change: `launch-null.js` `loneBall` skips the club rules (clubhits, outrun, attached) when the club's first measured post-impact point lies on this chain's sample in that frame, and the chain has at least `club.recede.loneSamples` (5) samples on a law with `c·fps ≥ loneCPerSec` (6/s). A head stays within reach and turns, so five samples on one receding line are the ball. The decision's swing-disc escape still guards the flight.
  - Test: none dedicated; the safety tests (club-only controls, rule pins) pass.
- **Night streak brightness (f6).**
  - Seen: the bay roof shades the ball at address while the range is floodlit, so the flying streak reads 2-5× the expected flux. The limit was 1.6.
  - Change: `launch.gates.fluxRange` = [0.3, 6]. It is only used in streak mode.
  - Test: none dedicated.

Together, `loneBall` and the f6 range made `033756395~3` (tracked) and `034147749~2` (partial) trace.

### 5.5 Flight tracking

- **Night glow breaks the size reading.**
  - Seen: the TBD diameter is a second moment over the whole search gate. With floodlight glow filling the gate it read 0.8-0.86 × gate (2.5× the ball). The M3D χ² gate then failed, because the size terms dominated.
  - Change: `roi-detect.js` `_diameter` returns null above `DIAMETER_MAX_GATE` (0.75) × gate. At 0.6 a real but slightly blurred daytime ball (0.68 × gate) was dropped.
  - Test: `a floodlit ball whose glow fills the gate: tracked, and no size is reported that only measures the gate`. The old code reported 40 px for a 14 px ball.

### 5.6 Decision

- **Saturated confidence.**
  - Seen: the provisional confidence clamps every input at "full evidence". A 2-frame fake launch scored 0.980 beside a 125-inlier real flight at 0.977, so R3 abstained (identity_conflict).
  - Change: `decide.js` `dominates`. Within `r3Margin` the candidate that leads by `identityMarginNats` on both the launch S and the track LLR wins, both for best selection and in R3.
  - Test: `R3: a rival inside r3Margin is no identity risk when the best leads on both launch S and track LLR`.

## 6. How to verify

1. `npm test`. Expected: 770 pass, 0 fail.
2. `zsh tools/hf-debug/check-all.sh <name>` runs the frozen synthetic safety bench, the 33 real clips and the night clip, and compares them with the 2026-10-14 baselines in `tools/hf-debug/baselines/`. Expected now:
   ```
   synthetic safety bench: recallSnr6 90.0%, per-clip statuses identical to the baseline
   real clips: traced 25 of 33 (baseline 25 of 33), fully tracked 19 (baseline 19)
   night clip: partial (10 frames), baseline 2026-10-14: partial (10)
   ```
   - The synthetic bench is 10 clips (2 abstained, 1 partial, 5 tracked, 2 tracked WRONG(completion)), with wrong|traced ≤ 1%. The two WRONG(completion) are the known completed-arc issue (section 9). The per-clip statuses must stay identical.
   - Real clips: no clip may be lost (`LOST` lines).
   - Data locations and overrides are in `tools/hf-debug/README.md`.
3. **One real clip:** `node tools/hf-debug/hf-summary.mjs <clip>`. It prints one JSON line (status, reasons, tracked frames, impacts, launch decisions) and accepts params overrides via `OVR='{"…":…}'`.

## 7. Still failing (8) and why

| Clip | Step that fails | What happens | Suggested next step |
| --- | --- | --- | --- |
| `033429984~3` (night) | 4 flight tracking | The ball on the mat and the hit (frame 58) are found and the launch confirmed (S 28). The tracker then loses the ball 2 frames after the launch samples. Its law-mode predictor fits `½·a·τ²` image acceleration instead of the perspective slowdown (c 0.14 against the launch's 0.33; a ≈ 5 px/frame² against gravity's 1-3.6), so the predicted ball stops and falls back. TBD's 5×5 velocity grid (±0.8 px/frame) then rejects the real ball as 'velocity' (scores 27-39 against a threshold of ~5). One launch sample (frame 62) implies a step no projective law allows; it is probably a streak end read as the centre. | Measure ground-truth positions (frames 59-75: the ball is visible every frame), then fix the law-mode predictor and the TBD velocity search against them. |
| `033520851~3` (night) | 4 | Same pattern: launch confirmed (S 22), lost after 4 launch samples. | Same. |
| `034418482~3` (night) | 4 then 6 | Same pattern: launch confirmed (S 29), 5 samples, then low_confidence. | Same. |
| `034109764~3` (night, 60 fps) | 3 launch | The ball is a faint diagonal streak. The best streak chain (8 samples) fails outrun; the blob chain fails latestart (it first appears 5 frames after impact). | Check the club track (likely the same lone-ball confusion, but the chain may fail the receding test at 60 fps) and the latestart counting. |
| `034323643~3` (night) | 3 launch | Streak chains fail the law fit or f2 (profile RMS 0.57-0.70, limit 0.5). | Look at the streak sample positions (same streak-end problem?). |
| `033847735~4` (night) | 6 decision | Launch accepted (S 13); 13 tracked frames judged club_only_motion (the track never leaves the swing envelope). | Check whether the 13 frames are the ball or the club. |
| `182505110~2` (day) | 3 launch | The ball is visible and found (7 samples). f1 straightness is 0.47 against a 0.35 limit: a 5 px far ball, ~1.7 px allowed. A pixel slack broke two safety tests. | Fit the line through a slightly free address point (the spot centroid may be off), or a slack only for long receding chains; recheck the safety tests. |
| `183206205~2` (day) | 3 launch | The ball moves 15-30 px/frame and the golfer barely moves: probably a slow-motion export without a capture-rate hint. Chains are weak (m 3) and the streak chain fails f5 (likely the club). | Confirm slow motion (swing duration); check the τ prior and the launch search for slow clips. |

## 8. Tried and reverted (do not repeat blindly)

| Idea | Why it was undone |
| --- | --- |
| f1 straightness + 1 px slack (`straightSlackPx`) | Broke `pre-existing mover and precursor` and the rule pin `p0` (seed 5389). |
| `maxPerFrame` 640 | Faint static spots made the tracker reject its own ball (183742730: 101 → 67 points); `034024039` was lost through the arrival veto. |
| `maxEigRatio` 2.3 for all spots | A dark resting club head became ball-like: `practice swing … no ball` failed. |
| Night tracker predictor: perspective-damped image acceleration in `lawPos` | The fit used an even larger acceleration (c 0.03, a 18 px/frame²). |
| … a launch-only tight prior (¼ spread) in `lawFit` | The data still outweighed it (c 0.15). |
| … Huber IRLS in `lawFit` | The bad sample was not a 3σ outlier under the accelerated fit. |
| … projective-only extrapolation past the last inlier | No reversal, but too slow (it inherits the law's low velocity); `034147749~2` was lost. |
| … image acceleration prior bounded by gravity (g/fps² · d0/D) | c only rose to 0.18; no clip gained; `034147749~2` stayed lost. |
| … velocity σ inflated by the law-vs-last-step disagreement | σ grew but the TBD grid did not (fixed spacing); no change. |
| TBD velocity grid stretched to ±σ_v | Accepted the ball at 64-65 but broke `033756395~3` (tracked → flight_inconsistent). |
| Fit `sigmaFloorPx` 0.5 → 1.0-1.5 | Not needed once the glow size fix landed. |

## 9. Other known issues and open work

- **Completed-arc shape ("candy cane").** The completed arc descends too early, back to mat level. This is the 2 WRONG(completion) clips on the synthetic bench.
- **Confidence is uncalibrated.** The provisional model saturates (section 5.6) and penalises real fit residuals (fitRms ~1.5). It needs labelled real clips.
- **Integration items from the earlier audit:**
  - Stale browser cache across a version bump for `dist/hf` internals (the `?v=` query on imports).
  - Mutation survivors: clipEnd wiring and the post-cancel progress guard.
- **Generator:** the synthetic clip generator is now in the repo (`tests/synth/`, 33 tests), but uncommitted like the rest.
- **Default engine:** flip `DEFAULT_ENGINE` to `'hf'` only once hf beats v2 on labelled real clips.
- **Missing tests:** five of the 2026-10-14 changes have no dedicated unit test (marked "none dedicated" in section 5).
- **Docs:** `ARCHITECTURE_AND_PROGRESS.md`, the README and the v2 docs predate the hf engine.

## 10. Data, tools and their locations

- **In the repo:**
  - design sources: `docs/hf-design/`;
  - generator: `tests/synth/`;
  - debug tools: `tools/hf-debug/`, see its README, which lists every tool by pipeline step;
  - baselines: `tools/hf-debug/baselines/`, with the real-clip batch at the start and end of 2026-10-14 and the synthetic bench baseline.
- **Outside the repo, persistent:** `~/Documents/flightline-dev/`.
  - `bench/frozen/` is the frozen synthetic corpus (125 MB, checksum-verified copy).
  - `archive/` holds 2026-10-14 snapshots of the `/tmp` worktrees `hf-synth` and `hf-phase1`, the original scratch scripts and the design docs.
  - `results/` holds copies of the baselines and the checkpoint bench run.
- **Private clips (never in the repo):** `~/Documents/Photos-1-001/*.mp4` and `~/Downloads/PXL_20261014_034239108~3.mp4`.
- **User debug folder:** `~/Documents/flightline-debug/033354445/`: original frames, the app's grayscale view per frame with detections marked, an overview, the tracked-ball image and a README.
- **No longer needed:** `/tmp/flightline-understand` (12 GB of workflow scratch), `/tmp/flightline-real` and the `/private/tmp` worktrees. Everything of value was copied; see `TRACKING_HF_RESUME.md` before removing them.

## 11. Recording advice for better traces

- **Frame rate.** Daytime: Slow Motion at 1/4× (120 fps) or 1/8× (240 fps). At 30 fps the ball often shows up in only one or two frames after the hit. Night: 60 fps normal video, because slow motion at night is dark and grainy, and floodlights can flicker frame to frame.
- **Originals.** Share the original file from the phone, not an edited or cropped Google Photos export. The exports are 0.7-3 Mbps and smear the ball.
- **Tripod, stabilisation off.** The sudden zoom steps come from stabilisation, so turn it off if the camera app allows.
