# Flightline

A private, browser-local golf tracer prototype. Upload a video, try automatic motion tracking, correct the observed flight, and download a video with the trace composited into its frames and the original audio.

See [architecture, progress, and known issues](ARCHITECTURE_AND_PROGRESS.md) for the implementation handoff and the unresolved real-video tracking bugs.

## Run

`npm run dev` serves the buildless app at http://127.0.0.1:5173. There are no npm dependencies. `npm test` runs synthetic tracking and trace timing tests.

## Current capabilities

- Browser-decodable MP4, MOV, or WebM, up to 250 MB and 30 seconds.
- Experimental bright-ball motion detection at 30 samples per second and up to 1280 pixels on the long edge, using a worker, connected components, simple translation compensation, and temporal association. Launches are anchored to a previously stationary ball. Broad image changes suppress new tracks.
- Both left- and right-moving rising launches are considered, without an angle preset.
- A second pass follows the detected ball in a moving patch at native video resolution, using local contrast and motion to retain faint, distant balls. It stops after repeated misses rather than switching to a stationary highlight.
- A time-aware, shape-preserving cubic curve smooths the trace through the observed positions, including its turn at the apex. Preview and export use the same curve.
- Manual time-indexed point correction, undo, color, width, glow, and persistent/trailing lines.
- Canvas compositing and MediaRecorder export at up to 1080p/30 fps, preserving aspect ratio and audio. Uses MP4 when the browser supports it, otherwise WebM. Exports run in real time and cancel when the tab is hidden.
- Files are object URLs in browser memory. No uploads, analytics, external scripts, or video storage.

## Important limits

This is a working prototype, **not a validated golf-trained neural detector**. A candidate path is labeled “possible flight” and must be reviewed. Include the stationary ball for at least a quarter-second before impact. Tiny balls, light skies, motion blur, moving cameras, cuts, zoom, and confounding objects can cause misses or wrong paths. No distance/speed estimates or unseen landing positions are fabricated. The illustrated demo uses a known synthetic curve and is labeled as such.

`dist/tracker.js` owns launch detection, `dist/refiner.js` follows the distant ball, and `dist/curve.js` smooths the displayed path. The worker returns `{ points: [{ t, x, y }], camera: [{ t, x, y }], engine, observedFrames }`. Times are seconds; coordinates are normalized and camera-stabilized. This is the boundary for a future golf-trained detector. A model swap must include real footage evaluation rather than only API integration.

## Open-source research

- [TrackNetV5-SDK](https://github.com/thaonan/TrackNetV5-SDK): The README describes tennis tracking, says trained weights and datasets are not public, and labels the SDK proprietary, for technical exchange and academic study only. **Not integrated or copied.**
- [TrackNetV4](https://github.com/TrackNetV4/TrackNetV4): MIT-licensed code with training/evaluation for tennis and badminton. A candidate foundation for golf fine-tuning; no claim of ready-made golf accuracy. **Not integrated.**
- [WASB-SBDT](https://github.com/nttcom/WASB-SBDT): Another multi-sport research baseline with pretrained models worth evaluating. Model and dataset terms require separate review before inclusion.

Next useful step: benchmark a properly licensed model against representative down-the-line and face-on swing clips with labeled ball coordinates. Keep evaluation clips separate from training footage. Measure coordinate error, recall during visible flight, false tracks, and per-clip correction effort.

## Verification

Node tests cover synthetic ball motion, bright clutter, thin club reflections, a one-frame occlusion, faint-ball refinement, static distractors, smooth-curve bounds, and time-based rendering. They do not establish real golf performance. Browser QA should include file decoding, worker execution, manual edits, cancellation, and checking that exported video has the tracer and an audio stream.
