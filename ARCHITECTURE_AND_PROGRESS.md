# Flightline: architecture, progress, and known issues

Snapshot: October 12, 2026. This document describes the code and verification completed so far. It distinguishes implemented features from verified behavior and unresolved problems.

**Current status:** the upload, preview, editing, smoothing, and export workflow is implemented. Automatic ball identification remains unreliable. The original swing's initial launch was verified in the browser, but the slow-motion clip still selected golfer/club highlights in the most recent browser test. The latest tracking change passes unit tests and has not yet been verified on that clip in the browser. The project is a prototype, not a finished automatic golf tracer.

## 1. Product goal and scope

The intended workflow is:

1. Upload a golf swing video.
2. Automatically locate the ball at address and track its flight.
3. Show a smooth tracer synchronized with the video.
4. Download the video with the tracer and original audio.

The user films from a mix of behind-the-golfer and face-on angles. Manual correction is implemented as a fallback, but the requested core experience is automatic ball tracking.

Currently supported by the implementation:

- Browser-decodable MP4, MOV, M4V, and WebM inputs, subject to browser codec support.
- Maximum input size of 250 MB and duration of about 30 seconds.
- Preview and export preserve the video aspect ratio, with an output cap of 1080 × 1920 for portrait or 1920 × 1080 for landscape.
- Analysis and export target 30 frames per second. A 60 fps input is sampled at 30 fps.
- Both left- and right-moving rising launches are considered; there is no separate angle-specific model.
- The tracer ends at the last accepted observation. There is no fabricated landing point, carry distance, or ball speed estimate.

## 2. Codebase and local setup

Project folder:

```text
/Users/kashishtayal/Documents/ChatGPT/golf tracer/flightline
```

```text
flightline/
├── dist/
│   ├── index.html       UI structure and controls
│   ├── styles.css       Responsive layout and styling
│   ├── scene.svg        Labeled, illustrated demo scene
│   ├── app.js           Upload, decoding, analysis orchestration, editing, rendering, export
│   ├── worker.js        Worker message handling for coarse tracking and refinement
│   ├── tracker.js       Candidate detection, camera translation, launch and track association
│   ├── refiner.js       Native-resolution local ball tracking after coarse detection
│   └── curve.js         Time-aware cubic interpolation of observed points
├── tests/
│   ├── tracker.test.js         Synthetic detection and temporal tracking tests
│   ├── flight.test.js          Curve and native-refinement tests
│   ├── inspect-video.mjs       Local FFmpeg-based coarse analysis diagnostic
│   └── inspect-refinement.mjs  Local diagnostic with geometry specific to the original clip
├── package.json
├── README.md
└── ARCHITECTURE_AND_PROGRESS.md
```

`dist/` contains the editable source and the files served to the browser. There is no bundler, transpiler, or separate generated build. The app uses plain HTML, CSS, JavaScript ES modules, Canvas, Web Workers, Web Audio, and MediaRecorder. There are no npm package dependencies.

Run locally:

```sh
cd "/Users/kashishtayal/Documents/ChatGPT/golf tracer/flightline"
npm run dev
```

This serves `dist/` through Python's HTTP server at `http://127.0.0.1:5173/`. Node/npm and Python are development requirements; the browser app itself is static. Serve through HTTP because the app uses module workers.

Run tests:

```sh
npm test
```

FFmpeg is only used by local diagnostic scripts and exported-file inspection. It is not part of the browser runtime.

## 3. Architecture and data flow

```text
User-selected File
    → browser object URL
    → hidden HTMLVideoElement decodes frames
    → downsampled analysis canvas
    → transferred RGBA buffers → module Web Worker
    → MotionTracker: candidates → stationary address objects → competing tracks
    → chosen coarse flight + camera offsets
    → native-resolution moving crop → BallRefiner
    → observed points in normalized, camera-stabilized coordinates
    → smoothFlight interpolation
    → preview canvas: decoded video + time-synchronized tracer
    → canvas.captureStream + Web Audio → MediaRecorder → local download
```

### Main-thread orchestration: `app.js`

`upload()` validates the file, creates an object URL, loads metadata/video data, sizes the preview canvas, and invokes `analyze()`. An `AbortController` supports cancellation. Video seeking and worker requests have timeouts and report failures through the UI.

The coarse analysis canvas has a maximum long edge of 1280 pixels. For every sample, the main thread seeks to `i / 30`, draws the decoded frame, and transfers its RGBA buffer to the worker. Processing in the worker avoids running the detector itself on the UI thread; decoding, seeking, and canvas copying still occur on the main thread.

Once a coarse path has at least eight points, the app attempts a second pass if there is remaining video. It seeds the refiner with the last four coarse points and reads a moving 128 × 128 patch at native video resolution. The app combines the earlier coarse points with the refined tail.

### Coarse detector and association: `tracker.js`

`MotionTracker` is a hand-written computer-vision heuristic, not a neural network and not TrackNet.

It performs:

1. RGB-to-grayscale conversion.
2. An approximate camera translation search against the previous frame.
3. A brightness, color, and local-contrast mask to find small bright objects.
4. Connected-component analysis to obtain centroids, size, brightness, aspect ratio, compactness, and a motion flag.
5. Stationary-object history maintenance to find an address ball before impact.
6. Launch seeding when a stationary object disappears and a bright moving candidate appears nearby.
7. Temporal association using displacement, velocity changes, direction, size, and brightness constraints.
8. Ranking competing tracks using their length, rise, anchor, and motion cost.

Important current thresholds include a component cap of 600 pixels, a 36-pixel component extent, and a 400-pixel stationary-object cap in the analysis image. These were increased after the closer slow-motion ball was rejected by the previous size limit. Stationary launch sources need at least eight observations and must satisfy brightness, shape, and compactness checks.

The algorithm retains multiple competing histories, then returns the selected best path. **The ranking/association step is the main unresolved correctness problem:** unrelated highlights can form a plausible rising path and beat the true ball.

Recent edits tighten early-track brightness consistency, reject abrupt increases in component size, and reject a jump to motion more than roughly 2.5 times the previous speed plus a small allowance. The last speed-growth edit is not yet verified on real browser-decoded footage.

### Native refinement: `refiner.js`

`BallRefiner` estimates a search location from recent observed velocity, then looks for a small locally contrasting, moving component in the native-resolution crop. Search distance, component size, motion relative to the previous crop, and direction constrain selection. It stops after more than four consecutive misses.

Prediction is used to position the search window; predicted positions are not appended as ball observations. The refiner depends on a correct coarse seed and cannot reliably rescue a path that already belongs to the club or golfer.

### Smoothing and rendering: `curve.js`

`smoothFlight()` uses time-aware, shape-preserving cubic Hermite interpolation and resamples the curve at approximately 120 samples per second. The curve passes through accepted observations and avoids coordinate overshoot between them. Preview and export use the same curve, revealed according to video time.

This smooths interpolation between points. It does not remove all noisy detections, correct wrong ball coordinates, or extend the flight beyond its final observation.

### Manual correction

The user can pause/scrub, step in 1/30-second increments, click the ball to add or replace time-indexed points, clear the trace, and undo. A placed point advances the video by 0.1 seconds to support continued correction. Manual coordinates are transformed into the same camera-stabilized coordinate system as automatic points.

### Export

The preview canvas is captured at 30 fps. Web Audio routes the video's audio into the recording stream. MediaRecorder chooses an available MP4 format first, otherwise WebM. Export runs at playback speed, requests a screen wake lock when available, and cancels if the page is hidden. The output is downloaded through an object URL.

The input audio is routed into the export but is re-encoded rather than copied losslessly. Browser MediaRecorder controls actual encoding support and timing.

### Data contract and future detector boundary

The coarse result has this shape:

```js
{
  points: [{ t, x, y }],
  camera: [{ t, x, y }],
  engine: 'motion-beta',
  observedFrames: points.length
}
```

`t` is seconds; `x` and `y` are normalized coordinates after subtracting the estimated camera translation. Rendering adds the camera offset at the current time. A future learned detector should produce this contract so the existing preview, smoothing, editing, and export can be retained. The contract currently has no calibrated confidence, visibility label, or explicit track identity.

### Privacy and storage

Selected video files remain in browser memory through object URLs; the application does not upload them to a server. There is no application backend, analytics, account system, model service, or persistent project storage. Reloading the page loses the loaded clip and edits. Local QA files and screenshots are outside the served `dist/` directory.

## 4. Progress and evidence

| Area | Implementation and verification status |
| --- | --- |
| Upload, decode, preview | Implemented and exercised with both supplied MP4 files in the in-app browser. |
| Responsive UI and style controls | Implemented; color, width, glow, full/trailing trace, playback, and timeline controls are present. |
| Manual correction | Implemented; available when automatic detection fails. |
| Automatic launch selection | Improved, but still unreliable on the slow-motion clip in the latest browser test. |
| Distant-ball continuation | Implemented; the original clip exposed a switch onto a moving airplane. Tightened gates passed an offline check but still need a fresh browser check. |
| Smooth path | Implemented and covered by interpolation/timing tests; cannot fix incorrect detections. |
| Video/audio export | Implemented. An earlier browser export of the original clip was inspected and contained the initial correct tracer plus an audible audio stream. The latest tracking changes have not been exported and verified. |
| Automated tests | Latest run: 14 tests passed, zero failures. These are synthetic/unit tests, not an accuracy benchmark. |
| Learned ball detector | Not implemented; no model weights or inference runtime included. |
| Hosting | Local app is running. Hosting project preparation occurred; no deployed version has been verified. |

### Original test clip: `golf_swing.mp4`

- Source: `/Users/kashishtayal/Downloads/golf_swing.mp4`.
- About 4.67 seconds; browser displays the rotated footage at 2160 × 3840; source frame rate is 60 fps.
- Earlier browser verification found 20 coarse observations from approximately 2.133 to 2.800 seconds, beginning at the actual address ball and following the initial launch.
- A native refinement run extended the path but switched to a moving airplane after about 4.1 seconds. That extended result was incorrect.
- After tightening native search, motion, size, and direction checks, an offline refinement followed the ball until about 4.433 seconds and stopped. This has not yet been reverified in the browser on the newest source.
- Earlier export: `/Users/kashishtayal/Downloads/golf_swing-flightline.mp4`, 1080 × 1920 H.264 with AAC audio. It verifies export plumbing and the initial tracer, not the final extended-path implementation.

### Slow-motion test clip: `golf_slow_mo.mp4`

- Source: `/Users/kashishtayal/Downloads/golf_slow_mo.mp4`.
- About 11.5 seconds; browser displays it at 1080 × 1920; approximately 30 fps.
- The address ball is near normalized coordinates `(0.573, 0.691)`, and impact is around 4.43 seconds.
- At the 720 × 1280 analysis size, the address ball occupies roughly 195–200 detected pixels. The former component cap of 150 rejected it.
- Enlarging the size limits allowed the offline detector to select the real ball. One offline run produced 44 observations from 4.4 to 6.367 seconds; the subsequent brightness/size-gate run produced 42 observations over the same approximate range.
- Browser diagnostics confirmed that the real ball's launch is detected and associated. However, a competing path from body/club highlights still won the overall ranking.
- The most recent browser result, before the latest speed-growth guard, started around 3.467 seconds at `(0.100, 0.676)` and ended around 5.233 seconds at `(0.018, 0.057)`. This is the wrong object. Finding more points did not make that result correct.
- The latest speed-growth guard passes unit tests but has not been checked on this clip in the browser. Do not describe slow-motion tracking as fixed yet.

### Issues already addressed

- Bright single-pixel clutter previously crowded the address ball out of stationary-object history. Filtering before limiting history fixed the original clip's launch selection.
- Track source points previously shared mutable spot data, which could corrupt the source timestamp/position. Launch sources are now copied.
- The old size cap rejected the closer slow-motion ball. Component and stationary-source limits were increased, with a larger-ball regression test.
- Jagged line segments were replaced with shape-preserving interpolation.
- Full diagnostics attached to the canvas exceeded the browser automation message limit on longer clips. Diagnostic detail is now restricted to a one-second window.
- Browser module caching could leave stale worker code during QA. Module URLs currently use `?v=9` to force the latest revision. This is a development workaround, not a full versioning system.

## 5. Open bugs and issues

Priority meanings: P0 blocks the core requested behavior; P1 materially affects tracking correctness or confidence in a fix; P2 affects usability, tooling, or robustness.

| ID | Priority | Issue and observed impact | Status / next action |
| --- | --- | --- | --- |
| BALL-01 | P0 | Slow-motion video chooses golfer/club highlights instead of the real ball. Competing highlight chains can win despite a detected ball launch. | Open. Verify the latest guard in the browser, inspect competing tracks, and improve identity/appearance association and ranking. |
| BALL-02 | P1 | Native refinement can switch onto another moving object. A moving airplane captured the original clip's extended trace. | Mitigation implemented and checked offline. Browser regression and export verification remain pending. |
| BALL-03 | P1 | Offline FFmpeg success does not reproduce browser success. Frame selection, scaling/color differences, and resulting track scores can differ; the exact contribution of each is not established. | Open. Compare the same decoded frame timestamps and candidates across both pipelines. Browser playback must be the final acceptance check. |
| BALL-04 | P1 | There is no golf-trained detector, representative labeled dataset, or measured real-video accuracy. Heuristics can confidently assemble the wrong path. | Open architectural limitation. Evaluate a licensed learned detector and benchmark both filming angles before claiming reliable automation. |
| BALL-05 | P1 | Refiner trusts the coarse seed and starts at the end of that path. It may inherit an already incorrect or contaminated track. | Open. Validate seed identity and consider starting refinement earlier, before coarse detections become ambiguous. |
| BALL-06 | P2 | A faint ball, blur, grass highlights, bright sky, occlusion, or overlap can stop or contaminate the trace. The refiner also rejects very small motion, which can shorten tracking near the apex. | Known limitation. Evaluate visibility-aware association and reacquisition; avoid inventing unseen positions. |
| BALL-07 | P2 | Cubic interpolation preserves noisy observations, so small coordinate errors can remain visible. | Open. Add an outlier-aware temporal fit with an error bound after ball identity is reliable. |
| CAM-01 | P2 | Camera compensation handles approximate translation only, within a limited per-frame search. Pan, zoom, rotation, cuts, and exposure changes can break motion tests. | Known limitation. Add stronger stabilization or explicit unsupported-motion detection. |
| TIME-01 | P2 | Fixed 30 fps sampling and frame-step controls do not use source frame timestamps. High-speed footage loses temporal detail, and variable frame rates can shift which frame is analyzed. | Open. Use decoded frame metadata where available and test frame-exact timing. |
| UI-01 | P2 | Portrait footage is shown in a fixed 16:9 stage, leaving substantial side space and making a small ball harder to review. | Known usability issue. Allow a portrait-appropriate review area or zoom. |
| EXPORT-01 | P2 | Export is a real-time browser recording. It can be affected by rendering load, codec support, and tab visibility; MP4 is not guaranteed across browsers. | Known limitation. Broader browser/device and audio-sync testing is pending. |
| STATE-01 | P2 | No persistence for uploaded clips, accepted tracks, or manual edits. Reloading resets the session. | Not implemented. Add local project save/restore if needed. |
| QA-01 | P2 | The native offline refinement script hardcodes the original clip's dimensions/crop. Diagnostic scripts lack robust FFmpeg exit-code validation. | Tooling debt. Generalize geometry and propagate decode errors before using these scripts as a benchmark. |
| QA-02 | P2 | Browser regressions are manually exercised. Synthetic tests passing has repeatedly failed to predict real-clip correctness. | Open. Build a small labeled real-footage regression suite, including false-object identity checks. |
| DEV-01 | P2 | Manual module query revisions and dense CSS reduce maintainability. There is no conventional build or release pipeline. | Tooling debt. Introduce predictable asset versioning and source organization when the detector is stable. |

## 6. Diagnostics and reproduction

Browser diagnostic URL:

```text
http://127.0.0.1:5173/?diagnostics&diagnosticFrom=4
```

Upload `golf_slow_mo.mp4`. This records candidate/spot/track snapshots for 4–5 seconds. The preview canvas exposes `data-tracking-diagnostic`, `data-candidate-diagnostic`, and, when refinement runs, `data-refined-diagnostic`. Candidate detail is intentionally bounded to avoid oversized DOM/tool messages. For the original launch, use `diagnosticFrom=2`.

Offline coarse diagnostic:

```sh
node tests/inspect-video.mjs \
  /Users/kashishtayal/Downloads/golf_slow_mo.mp4 \
  /tmp/flightline-slow-diagnostic.json 720 1280
```

Local QA evidence is currently in `/tmp/flightline-qa/` and may be removed by normal temporary-file cleanup. It is not part of the served app or a durable benchmark. Relevant files include:

- `browser-fixed.json`: earlier correct initial browser track for the original clip.
- `browser-refined.json`: earlier original refinement containing the airplane switch.
- `refined-offline.json`: tightened original refinement's offline observations.
- `slow-large.json` and `slow-ranking.json`: offline slow-motion ball tracks.
- `slow-browser-launch.json`: bounded browser candidate/spot/track data showing that the real launch is detected.
- `slow-browser-ranking.json`: most recent wrong coarse browser track before the speed-growth guard.
- `slow-browser-ranking-refined.json`: refinement of that wrong seed.

Do not infer correctness from a diagnostic filename or number of observations. Compare coordinates with the visible ball, especially launch origin and any object crossing.

## 7. Recommended next steps and acceptance criteria

1. Re-run both supplied videos in the browser with the latest `?v=9` modules. Inspect the actual ball before impact, through launch, and near the last observation. Export only after the trace is visually verified.
2. Resolve BALL-01 by evaluating track identity, early appearance consistency, and association failures. A longer path or better score alone is not success.
3. Re-test the original airplane crossing against BALL-02. The trace must stay with the ball or stop when evidence is lost.
4. Establish labeled ball coordinates/visibility for these clips and additional behind/face-on clips. Record launch-origin error, visible-frame recall, coordinate error, false-object tracks, endpoint timing, and manual correction effort.
5. Evaluate an appropriately licensed learned detector. TrackNetV5-SDK was considered at the user's suggestion; it has not been integrated or copied. Other research candidates noted in the README are also not integrated. Confirm code/model terms and available weights, then measure golf performance rather than assuming tennis performance transfers.
6. Preserve the existing UI/render/export boundary while replacing detection. Add calibrated confidence and visibility to the result contract if the model supports them.
7. Generalize QA tooling, verify browser/export timing and audio sync, then address portrait review and persistence.

Minimum acceptance for the current bug fix: the slow-motion trace must begin on the ball at approximately 4.43 seconds, follow its nearly vertical launch, and never start on the golfer at approximately 3.47 seconds. For the original clip, verify the initial ball launch and ensure late continuation does not switch to the airplane. Both checks must pass in the actual browser and in an inspected exported video before calling the fix complete.

