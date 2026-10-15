# Synthetic golf-swing clips

Deterministic, dependency-free generator for the tracking benchmark (D3 section 9, D2 section 9). Node 24 built-ins plus ffmpeg
(`/opt/homebrew/bin/ffmpeg` or `$FFMPEG`).

```bash
node tests/synth/cli.mjs --split smoke                 # 29 clips: every view x capture cell, key confounders, easy-recipe clips, ~2 min
node tests/synth/cli.mjs --split easy                  # 22 genuinely easy scenes (sanity stratum), ~1 min
node tests/synth/cli.mjs --split tune                  # seeds 1-400, about 24 min on 14 cores
node tests/synth/cli.mjs --split holdout               # seeds 100001-100300, 30% style-shifted, about 19 min
node tests/synth/cli.mjs --split tune --only face-on --count 20 --jobs 8 --out /tmp/x
node tests/synth/sheet.mjs --corpus /tmp/flightline-corpus/smoke   # contact sheets with GT overlays
node tests/evaluate-tracking.mjs --manifest /tmp/flightline-corpus/smoke/manifest.json --engine v2 --json /tmp/v2.json
node tests/synth/report.mjs /tmp/v2.json              # pass rates by confounder count, stratum, view x capture, expected
```

Default output is `/tmp/flightline-corpus/<split>/`: `<id>.mp4|mov`, `<id>.gt.json`, `manifest.json` (harness format,
`annotationInline` per clip), `coverage.json` (failure modes F1-F34 per split), `checksums.sha256`, `run-*.json` (timings).
Every GT file and the manifest record `generator.codeSha256` (sha256 of `tests/synth/*.mjs`), node and ffmpeg; manifest and
`--index` builds refuse a directory that mixes versions, so regenerate the whole split after a code change.

| Module | Role |
| --- | --- |
| `ball-physics.mjs` | Re- and spin-dependent drag, lift, spin decay, gusting height-profiled wind, terrain landing, bounce and roll |
| `golfer.mjs`, `club.mjs` | Golfer, palettes and swing (waggle, forward press, timed back/downswing); at t0 the face meets the back of the ball at ball speed / smash (`club.contact` passes through the ball center); a practice swing beside the ball can come first (`chainPractice`: let down, step in, still address); blade irons and steel shafts in chrome mirror the sky and turf around them, black irons are diffuse; curved-chrome sun glints and ball-sized flash regions, one kind a persistent hosel highlight at address; dark driver |
| `camera.mjs` | Pinhole phone lenses (main, ultra-wide with distortion, tele), placements (a share on the ground or a bag, 0.12-0.5 m; landscape down-the-line keeps the horizon low), OU shake + tremor, pan, zoom, rolling shutter |
| `scene.mjs`, `distractors.mjs` | Sky (clear blue from pale to deep)/clouds/grass/mat (most mats on a concrete tee line), tree line of shaded crowns with sky gaps, nets, poles; airplane, birds, insects, lens dust, walkers, flags, neighbour bay, divot and turf (also brushed up by practice swings), tee, ball piles; some distractors anchored to the projected flight |
| `world.mjs` | Samples one clip: shot, swing and pre-shot routine, camera, scene, sensor; schedules glint flashes; places bay posts and the neighbour bay clear of the camera and the shot |
| `render.mjs` | Background warp (optical PSF applied once), z-buffered bodies, exposure-sampled motion blur with per-phase depth for the ball, sensor (AE, noise drawn independently per frame, luma sharpening); per-frame GT |
| `encode.mjs`, `audio.mjs` | x264/x265 at phone bitrates, mp4/mov, exact 90 kHz PTS (VFR, drops, dups), rotation remux, AAC with impact click and swing whooshes |
| `scenarios.mjs`, `gt-schema.mjs` | Split plans, failure-mode catalog, tags and expected outcome from realized GT, GT assembly and harness annotation |
| `report.mjs` | Harness pass rates by stratum from manifest tags |

Splits: view x capture cells are stratified jointly (at least 12 clips per cell and split), clubs are spread within each view
and cell, and sky, ground and format are spread across those strata. Clips carry at most 3 confounders, counting shake and minor
scenery (codec and rotation are format factors); a stress stratum (8%) stacks 5-7. One clean baseline per view x capture cell
and the `easy` split are easy scenes: blue sky, sun behind, exposure at most 1/2000 s, tripod, main lens, 1080p portrait,
standard h264, camera 4-6 m, straight behind the ball down the line. Manifest tags include `confounders:N`,
`stratum:clean|main|stress|easy` and `kind:hit|practice-hit|practice|practice-noball|whiff`.

Pre-shot routine: real-time clips start 1.1-2.8 s before impact, or (45% of them at 30/60 fps, 30% at 120 fps, 20% at 240 fps)
2-5 s before, so the setup, waggles and forward press are in the clip; slow-motion clips cover well under a second of real time
before impact. `practiceFirst` hit clips (D2's "practice swing first"; 15% of real-time 30/60 fps hits, at least 16 per split;
factor `kind: practice-hit`) start 5.8-7.5 s before impact with a practice swing 28-50 cm beside the ball 2-4 s before the real
takeaway; the golfer lets the club down, steps in and settles. Iron practice swings on grass (practice-only clips too) brush the
turf at their low point (`F33`); a practice swing in view tags `F19`. `factors.routine` records what each clip realized (lead-in,
setup time, waggles inside the clip, forward press, practice swing, turf) and `factors.camera` the lens height and distance.

Determinism: the same seed gives byte-identical raw frames (`meta.rawSha256`), encoded files and GT for a given ffmpeg
build (`generator.ffmpeg`). Encoders run with one thread by default (`--threads`); x264 frame threads are not bit-reproducible.
Sensor noise is drawn independently for every frame (its own sfc32 stream from the seed and frame index, inverse-CDF normals,
a 3-tap spatial correlation filter): consecutive noise fields correlate below 0.05 at every shift, so the encoder cannot code
the noise by motion compensation (`synth-noise.test.js`).

Ground truth is in upright display pixels at exact frame PTS. `expected` is `trace`, `abstain` (no ball leaves) or `either`
(the address ball shows in at most two pre-impact frames, or the ball is detectable in at most two post-impact frames).
Failure-mode tags are derived from what each clip realized (in frame, inside the clip, near the ball where that matters), not
from scenario flags. Visibility labels use a matched-filter SNR measured on the decoded video (`snrCoded`); `expectedSnr` is
the same statistic on the clean render. Its template is the final frame with and without the ball: layers drawn over the ball
(front net, insects, divot and tee debris, the neighbour ball) scale its contribution by their transmission, and they count
against `visibleFrac` and `occluded`. The harness annotation has no `addressBall.t` (the harness anchors on the first observed
point) and a per-clip `maxLaunchErrorPx` (4 address-ball diameters, 1.2-3.5% of the long edge).

Calibration: the only real footage at hand is one Pixel frame, `dist/qa/offline-f52.png` (pxl_qa at 1.733 s, 720x1280: down
the line from a phone on the ground, a mat on a concrete tee line, deep blue sky). The shipped tracker sees its address ball
as size 52 px, quality 0.90, compactness 0.83, roundness 1.29; synthetic address balls on the smoke split have medians of 59,
0.88, 0.72 and 1.0. That frame has about 1300 tracker candidates, mostly concrete texture near the lens; synthetic smoke frames
have a median of 52 (at most 243), so synthetic scenes remain cleaner. From it come the low phone placements (25% down the
line, 20% otherwise), the concrete tee line under 70% of mats, and blue skies ranging down to its deep blue. The real runs in
`docs/benchmark-runs` never abstain, but they carry no labels and come from one setup, so they bound nothing.

The current trackers: the clean stratum and the easy split are easy scenes, not easy for the shipped engines. Their seed and
link gates (the first 30 Hz sample within 0.11 of the frame diagonal of the address, a launch rising at least 0.55 in the
image, no sideways steps, a stationary bright address spot) reject most face-on and oblique launches, close down-the-line
cameras and sub-pixel camera jitter on small balls. On the regenerated tune split, of the 16 clean clips expected to trace 4
pass with legacy and 3 with v2, and the engines abstain on 327 and 325 of 400 clips (down the line: 4 of 9 clips with the
camera 5 m or more away, 35 of 44 under 3.5 m). When they do track they mostly follow the ball; tracks now also start on a
practice swing or on the glove or hands at takeaway (BALL-01: 5 legacy and 14 v2 tracks start more than 0.3 s before impact),
while club-head steals stay rare. The four easy-recipe smoke clips use seeds chosen so both engines pass them (a pipeline check, not
a measurement; of five candidate seeds per entry both engines passed 1 down-the-line 60 fps wedge, 4 slow-motion drivers and 3
oblique slow-motion irons). `synth-easy.test.js` runs the harness from this repo's `tests/` or from `FLIGHTLINE_HARNESS` (for
the phase-1 harness, `FLIGHTLINE_HARNESS=/tmp/flightline-phase1/tests`). Synthetic only: no claim about real footage follows
from results on these clips.
