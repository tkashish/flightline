# Flightline HF engine — final merged design (binding for all phase-2 units)

Sources: D3 (`D3.md`, next to this file in `docs/hf-design/`; originally `/tmp/flightline-understand/design/`) is the BASE design. Grafts come from D1 (`D1.md`) and D2 (`D2.md`), as recommended by the two judges. The judgments are in the design workflow journal; their key advice is reproduced below. Where this file and a design disagree, this file wins.

## Fixed user decisions

1. Build on the v2 branch: the main checkout `/Users/katayal/Documents/flightline`, branch `high-fidelity-traces`.
2. Synthetic validation only. Real clips are unavailable.
3. **Complete the full arc** like TV tracers: continue the fitted flight to landing, frame exit, or an uncertainty fade, drawn as ONE continuous line. Predicted points are drawn the same as observed ones; only the end fades. Each point carries a status internally.
4. Classical CV first. No ML, no npm dependencies, buildless ES modules.

## Engine identity and rollout

- New engine id `hf`. Its code lives in `dist/hf/`.
- `?engine=v2` and `?engine=legacy` stay selectable for A/B. Do NOT delete `global-associate.js` or `tracker.js`: they back v2 and legacy.
- The default becomes `hf` ONLY after the acceptance gate (below) passes on the synthetic holdout in both Node and headless Chrome. Until then the default stays `v2`, with its safety fixes.
- v2 gets targeted fixes: the safety bugs and cheap correctness bugs (unit U10). Its deep algorithmic limits are solved by `hf`, not patched in v2.

## Pipeline (D3 §2, with grafts)

```
FrameSource (WebCodecs+demux primary | element frame-centre seeks fallback | Node ffmpeg for tests)
  → P1 coarse scan, every frame (decimate only above 60 fps), analysis long edge about 960:
       similarity camera motion (IRLS, lens-fixed speck mask), spot tracker, vacate events, pass energy, horizon
  → impact hypotheses (vacate impulse + R1 last-to-leave + arrival veto)
  → launch confirmation at NATIVE resolution on the t0-0.25 s .. t0+0.5 s window
       (two-body emergence + projective-line law + club tracker + ray-transform streak mode; null-launch margin)
  → P2 native flight pass from t0 - 0.25 s: physics-predicted ROI tubes, TBD, MHT
  → global re-association (Viterbi/EM on cached z-maps) after each M3D refit
  → M3D fit + completion (landing | exit | fade | cap) → dense display curve with per-point status
  → decision R1-R5 + confidence → result
```

## Decode (unit U1)

- One `FrameSource`/`FrameRef` abstraction (D2 §8.1 typedefs). The engine sees only FrameRef.
- **Primary:** WebCodecs + a dependency-free MP4/MOV demuxer, running in the worker. Start from the prototype at `/tmp/flightline-understand/design/D3-scratch/web/mp4-demux.js`. It must handle:
  - avc1/hvc1, mov/mp4, display rotation 90/180/270, B-frames (ctts), co64, edit lists (DROP pts<0 pre-roll), VFR;
  - 10-bit planes (shift to 8-bit), limited-range Y (expand using VideoColorSpace.fullRange);
  - fragmented MP4 (detect `moof` and use the FALLBACK, don't throw).
  - Any decoder error → fallback.
- **Fallback:** element source. Seek to frame centres and verify with requestVideoFrameCallback `mediaTime`. Phase 1 already implemented `sourceFrameSchedule`, `snapSourceFps`, and a presented-frame reader in `dist/frame-source.js`; REUSE them (that file is merged from phase 1).
- **Node:** an ffmpeg source (`-fps_mode passthrough`, pts from ffprobe/showinfo) for tests and the bench. Identical frames to the browser source on the same file.
- Rotation is handled inside the sources; FrameRef coordinates are upright display pixels.

## Launch and club rejection (units U2 and U3)

- **Vacate as an impulse (D3 §3).** NCC change test, stable post-impact patch, gradual-departure veto (rejects glints, gloves, raked balls, balls falling off the tee). Plus from D1:
  - R1: the ball is the LAST stationary object to leave the address cluster;
  - arrival veto: body parts arrive and pause;
  - pass-energy disks: frame-difference energy in small/large disks around the address, for impact timing and faint-streak activity.
  - Every rule is TIME-LIMITED. D1's untimed R5 / 'returned' rules are cut.
- **Two-body emergence (D3).** The ball is the leading emitter on a straight line through the address, ball-width, with a streak-axis check. It obeys D1's projective-line law: position s(τ)=vτ/(1+cτ) and width D0/(1+cτ) with ONE shared c, and t0 inside the impact interval. No launch-angle gates. Flat face-on launches (8-12°) must be accepted.
- **Club head (D2).** Track the club head through impact (2 pre-impact frames suffice). Apply:
  - an extent-sized 'club-explained' exclusion;
  - the outrun-the-club rule (the ball leads the club, distance ratio about 1.1-2.2);
  - the pre-existing-mover rule;
  - the precursor rule;
  - the address-hole mask and local CFAR.
  Face-on club head height is about 1.1-1.4 ball diameters, so the width test alone cannot reject it there; it needs the club chain.
- **Streak mode (D3).** Ray transform around the address with a monotone DP, for long-exposure or faint launches that never segment as blobs.
- **Acceptance (D2 null launches).** S ≥ 1.15·max(S_null) + 1, where the nulls are fake anchors at ±0.22·W and fake (earlier) impact times. D3's learned LLR densities are DIAGNOSTICS ONLY (logged, not gating).
- **Single-sample launches are OFF by default.** They may be enabled only behind D2's guards (club chain measured, distance ratio in [1.1, 2.2], loft cone, z ≥ 7) and only if the holdout shows club acceptance ≤ 1%.
- Must pass pixel-level tests: ball-sized chrome glints; the face-on club head; the ball/club merging in frame 1; codec artifacts; the invisible-ball control.

## Flight tracking (units U4 and U6)

- **ROI tubes at native resolution (D3 §4).** Placement is physics-predicted. Background is a two-sided, lag-scaled model with L = ceil(2.5·r/|v|) frames (D2), with a spatial fallback for very slow balls. It must NOT self-subtract slow balls at the apex or in slow motion; the D1 trailing 5-crop median is cut.
- Centred 7-frame track-before-detect.
- Detection thresholds come from decoy-ROI empirical nulls (D3), never fixed CFAR constants. Detect both polarities (a dark ball against bright sky). Lens-fixed speck mask.
- **MHT with distractor masks (D3), plus from D1:**
  - reserved per-launch hypothesis quotas (a later true launch survives 4+ earlier wrong ones);
  - static-persistence and pre-impact-mover labels;
  - change-point trimming;
  - 3-of-5 re-acquisition after gaps (D3).
- Physics-residual test that rejects airplanes even after 6 consecutive misses (the D1 E5 leak case).
- Swing-disc escape (D2) as a flight-level identity confirmation.
- **Global re-association (D2).** Viterbi/EM over the z-maps cached along the tube, after each M3D refit. It recovers faint early-flight and post-occlusion points without re-decoding.

## Trajectory, completion, display (unit U5)

- **M3D (D3 §5).** Drag, lift and side spin through a pinhole camera, with:
  - horizon-tightened pitch/roll;
  - a focal mixture including ultra-wide (0.5x) with k1 distortion;
  - early diameter observations as log-radius observations (D2).
- The time scale τ (slow-motion factor) is ALWAYS fitted (multi-start on τ, D3 grid with early abandon). Detect iPhone-style speed ramps (piecewise τ or a ramp detector) and fade if a ramp can't be modelled.
- When M3D is ill-conditioned, D1's forward-validation picks between M3D and a short-horizon image model, with an early fade.
- The fade is driven by the Laplace σ(t).
- End types: landing | exit | fade | cap. Report observedEnd separately from endReason (D3).
- **Display curve.** Dense, about 120 Hz, C¹ at the observed/predicted junction. Every inlier observation lies within 1.5σ of the curve. Status per point is anchor|observed|interpolated|predicted. Never drop observations; outliers are rejected only by the robust fit. The renderer draws hf points directly; it must NOT run smoothFlight on them.
- The generator's aero model (tests/synth) is richer than M3D, and tests must NOT import the fitter's physics into the generator or vice versa.

## Decision, confidence, invariants (unit U6)

- D3 rules R1-R5 (§6). 'tracked' requires all of:
  - a confirmed launch;
  - flight-confirmed identity (≥ 8 observations AND ≥ 0.15 s of real time, or a confirmed frame exit);
  - no conflict;
  - usable camera motion.
- Invariants, enforced by tests:
  - `no_reliable_track` ⇒ `points = []`;
  - `normalizeTrackReport` never upgrades a status;
  - arc completion only happens after a confirmed launch AND flight-confirmed identity.
- Confidence: `{value, calibratedOn:'synthetic-tune-v1', components}`, mapped monotonically from the null margin and fit features (logistic with ≤ 6 params or isotonic), fitted on tune only. The UI labels it 'calibrated on synthetic clips'. Bulk export requires status 'tracked' and value ≥ 0.9.

## Worker protocol (U9)

- Every message carries a `jobId` (D2). Stale jobs are ignored.
- `analyzeClip(source, {onProgress, signal}) -> result` lives in `dist/hf/pipeline.js`.
- Main-thread `startAnalysis(file, {onProgress, signal})` lives in `dist/analysis-client.js` and hosts the element-source server for the fallback.

## Result contract (renderer-compatible)

```
{ points:[{t,x,y,status:'anchor'|'observed'|'interpolated'|'predicted', alpha?}],   // normalized, camera-stabilized, dense display curve
  observations:[{t,x,y,sigma}], camera:[{t,x,y,s?,r?}], engine:'hf', observedFrames,
  status:'tracked'|'partial'|'no_reliable_track', reasonCodes:[...],
  confidence:{value, calibratedOn, components},
  launch:{t,x,y,dir,view}|null,
  completion:{end:{type,t,x,y}, observedEnd, observedSec, predictedSec, slowMoFactor}|null,
  diagnostics? }
```

## Acceptance gate (synthetic holdout, both Node and headless Chrome)

- **SAFETY (all must pass before the default flips to hf):**
  - P(wrong | traced) ≤ 1.0%;
  - club-head false-track rate ≤ 0.5% of clips;
  - no-ball (practice swing/whiff) false trace ≤ 1%;
  - invisible-ball-in-flight control abstention ≥ 98%.
- **QUALITY (reported; default flips only if hf beats v2 on coverage AND position error on the same holdout):** the D3 §9.5 targets — coverage by view, launch timing/point, identity, recall by SNR bin, position error, completion error, calibration ECE, runtime, memory, Node/browser parity.
- Holdout runs are rationed and logged with the code hash. Tune only on the tune split.

## Cut / deferred

- Audio onsets (deferred).
- The one-tap 'help find the ball' assist (deferred).
- D1 playback capture as the primary path, the trailing-median background, fixed-threshold CFAR, the n≤2 leader rule, and image-quadratic completion for n<8.
- D2's 24-start fit grid and its lockstep ROI-request fallback protocol.
- D3's learned LLR as a gate.
