# Tracking HF: module map and protocol (frozen contract)

**Status:** U0 contract for the `hf` engine, written before units U1-U10 started and frozen for them. **Updated after the P2a composition check** (`/tmp/flightline-understand/main/p2a-check.json`) to match the units as built: each unit section in §7 now gives the real signatures, and **As built** notes list where a unit deviates from the original contract (all deviations are additive or confined to the unit unless marked *seam*). §6 and §11 describe the wired pipeline (`runHF` → `analyzeClip`), its decode policy and memory bounds.
**Binding sources:** `FINAL.md` (wins), base design `D3.md`, grafts `D1.md` and `D2.md` (in [`docs/hf-design/`](hf-design/); originally `/tmp/flightline-understand/design/`).
**Executable contract:** `dist/hf/types.js` (typedefs, constructors, validators, coordinate and time helpers, reference luma, in-memory source), `dist/hf/params.js` (every threshold), `dist/hf/engine.js` (entry point). Where this document and those files disagree, the files win, and the disagreement is a bug to report to the integrator.

Sections: 1 module map · 2 rules for every unit · 3 data flow · 4 coordinates · 5 time · 6 pipeline and dependency injection · 7 unit APIs · 8 display curve and point statuses · 9 result contract and invariants · 10 statuses and reason codes · 11 worker protocol · 12 params · 13 performance budgets · 14 decisions made here.

## 1. Module map

| Unit | Files (created by the unit) | Entry points other units call |
| --- | --- | --- |
| U0 contracts | `dist/hf/types.js`, `dist/hf/params.js`, `dist/hf/engine.js`, this doc, `tests/hf-types.test.js` | everything in `types.js` and `params.js`; `runHF`, `ENGINE_ID` |
| U1 decode | `dist/hf/decode/{mp4-demux,codec-source,element-source,orient,planes}.js`, `tests/hf/helpers/node-source.mjs` | `openFrameSource`, `serveElementFrames`, `openNodeSource` |
| U2 camera, coarse scan, spots | `dist/hf/{camera-motion,coarse-scan,spots}.js` | `CoarseScanner`, `estimateMotion`, `CameraPath` |
| U3 impact, launch, club, nulls | `dist/hf/{impact,emergence,club,launch-null}.js` | `findImpacts`, `LaunchConfirmer` |
| U4 ROI detection | `dist/hf/roi-detect.js` | `RoiTube`, `nullThreshold` |
| U5 flight model, LM, completion, curve | `dist/hf/{flight-model,lm,complete,display-curve}.js` | `fitFlight`, `completeFlight`, `displayCurve` |
| U6 tracker, decision, confidence | `dist/hf/{flight-tracker,decide,confidence}.js` | `FlightTracker`, `reassociate`, `decide`, `scoreConfidence` |
| U7 benchmark runner | `tests/bench/*` (tests only) | CLI `run-node.mjs`, `metrics.mjs`, `gate.mjs` |
| U9 pipeline | `dist/hf/pipeline.js` and the body of `runHF` in `engine.js` (wired: `runHF` returns `analyzeClip(source, {...opts, onProgress})`) | `analyzeClip`, `defaultModules` |
| U10 v2 fixes | `dist/tracker.js`, `dist/global-associate.js`, `dist/curve.js` | none (no hf interface) |

Not owned by any unit here (integrator, after the phase-1 merge): `dist/worker.js` hf messages (or a new worker module), `dist/analysis-client.js` (`startAnalysis(file, {onProgress, signal})`, hosts `serveElementFrames`), `dist/app.js` engine selection and hf rendering, `dist/track-status.js` hf copy, `package.json`.

## 2. Rules for every unit

- **Ownership.** Create or edit only your files. Never edit `dist/{app,worker,frame-source,track-status}.js`, `dist/{styles.css,index.html}`, `package.json`, `.gitignore` or the eval-harness files; they change in another worktree.
- **Imports.** Buildless ES modules, no dependencies, plain relative paths without `?v=`. From another unit you may import **only** `./types.js` and `./params.js`. Every cross-unit collaborator is injected (section 6), so a missing sibling file can never break your module at link time. Inside your unit, import freely.
- **Runtime.** Code in `dist/hf` runs in browsers (main thread and worker) and in Node 24. Node-only APIs only behind feature checks; DOM APIs only in `element-source.js` and only on the main thread.
- **Thresholds.** Read every threshold from `PARAMS` (or the `params` passed in a context, which defaults to `PARAMS`). Never hard-code one. Tests may override with `mergeParams(overrides)`.
- **Errors.** Throw `HFError(code, message)` with a code from `ERROR_CODES`. Cancellation is an `AbortError` (`throwIfAborted(signal)`), never a result.
- **Tests.** `node --test tests/hf-<topic>.test.js`, self-contained, synthetic pixel-level inputs, under about 20 s per file. Helpers go in `tests/hf/helpers/`. Build fixtures with `createMemorySource`, `identityTrack` (static camera), `exampleResult` and the `make*` constructors (`make(type, fields)` covers every type in `SCHEMAS`; `check(type, value)` lists problems). For each key rule write a test that fails when the rule is removed or inverted, check it with quick mutations, and report a mutation table. Report ms per frame (or per call) of your hot paths at 1080×1920 and 2160×3840.
- **Physics separation.** The synthetic generator (`tests/synth`) and the fitter (`flight-model.js`) never import each other.

## 3. Data flow

```
FrameSource (U1: codec | element | node | memory)          meta: SourceMeta
  │ P1 frames({stride: scanStride(fps)})  ref.lumaCoarse(960) ──▶ U2 CoarseScanner.push ──▶ finish(): CoarseLog
  │                                                              (camera track, spots, vacates, energy, horizon, movers, specks)
  ├─ U3 findImpacts(log, meta) ──▶ ImpactHypothesis[] (≤ 4)          [] -> no_reliable_track + no_launch
  │ P2a frames({from, to}) over the union of LaunchConfirmer windows (t0 − 0.25 s .. t0 + 0.5 s, plus null windows)
  │     for each hypothesis: roiRequests(k) -> ref.lumaRect -> consume(k, t, crops, sim)
  ├─ U3 LaunchConfirmer.finish() ──▶ LaunchDecision (accepted -> LaunchCandidate)
  │ P2b frames({from: frameAt(t0 − 0.25 s)}) to clip end, all trackers in one pass, stop when all are done
  │     U6 FlightTracker (uses injected U4 RoiTube and U5 fitFlight) roiRequests / consume
  ├─ U6 FlightTracker.finish() ──▶ TrackHypothesis[] per launch (best first; only the best branch is fitted)
  ├─ U5 fitFlight (cold) ──▶ FlightFit; then at most params.track.reassocIters rounds of U6 reassociate (Viterbi/EM on
  │     cached z-maps) + warm fitFlight, stopping early when a round changes no observation (converged)
  ├─ U5 completeFlight ──▶ Completion (landing | exit | fade | cap)
  ├─ U6 decide(FlightCandidate[]) ──▶ Decision {status, reasonCodes, selected, allowCompletion, rules, confidence}
  ├─ U5 displayCurve(fit, inliers, allowCompletion ? completion : null) ──▶ DisplayPoint[] (stabilized px)
  └─ U9 assemble: normalize, camera samples, validateResult ──▶ HFResult
```

Native passes re-decode instead of buffering frames (D2 §2.2). Re-decoding the 0.5 s launch window for P2b costs about 15-30 frames, so P2a and P2b are separate passes. Nothing holds more than one FrameRef at a time. Inside a pass, a gap longer than `pipeline.restartGapSec` before the next needed frame restarts the iteration there (any gap on the element path), so two shots far apart never decode the frames between them.

## 4. Coordinate systems and conversions

| System | Definition | Used by |
| --- | --- | --- |
| Coded px | decoder plane before rotation | U1 only |
| **Native display px** | upright (rotation applied), full resolution, x right, y down. Pixel (i, j) covers [i, i+1) × [j, j+1); its centre is (i+0.5, j+0.5); the image spans [0, W] × [0, H] with W = `meta.width`, H = `meta.height` | everything outside U1 |
| Coarse px | `lumaCoarse(longEdge)` pooled by `pool = coarsePool(W, H, longEdge) = max(1, round(max(W, H)/longEdge))`; coordinate u maps to native X = pool·u | U2 internals |
| Crop px | `lumaRect(rect, {pool})`; u maps to native X = rect.x + pool·u | U3, U4 internals |
| **Stabilized px** | native px in the reference frame = the first scanned frame (CameraTrack entry 0, identity). raw_k = S_k(stab) | all tracking, fitting, curves, ImpactHypothesis, Observation, Completion |
| Normalized | stab px / (W, H); sigmas are px / hypot(W, H) | HFResult only |

- No half-pixel offsets: converting between native, coarse and crop coordinates is a multiply and add. A centroid computed over crop pixel centres (u + 0.5) gives native x0 + pool·(u + 0.5).
- `Sim {a, b, tx, ty}` maps p to (a·x − b·y + tx, b·x + a·y + ty). Helpers: `applySim`, `invertSim`, `composeSim(p, q)` (q first), `simAt(track, index)` (exact at analyzed frames, linear between, clamped), `stabToRaw`, `rawToStab`, `identityTrack(meta)`.
- `CameraTrack.sim[k]` maps **stabilized native px to raw native px** of frame `index[k]`. U2 builds it from frame-to-frame estimates M_k (previous raw to current raw): S_k = M_k ∘ S_{k−1}; a coarse-px estimate converts to native by multiplying tx, ty by pool.
- Result camera (`cameraSamples(track, meta)`): with c the frame centre, raw = c + s·R(r)·(stab − c) + (x·W, y·H), s = hypot(a, b), r = atan2(b, a), R(r) = [[cos r, −sin r], [sin r, cos r]] in y-down px. With s = 1, r = 0 this is v2's convention raw_norm = stab_norm + (x, y), so `cameraAt`-style translation renderers stay correct. `cameraToRaw(sample, x, y, W, H)` is the full inverse for renderers.
- Directions (`dir`, `LaunchCandidate.dir`, `ResultLaunch.dir`) are unit vectors in display px space, y down. Angles in `PARAMS` are measured with **y up** (counter-clockwise from +x) unless noted, e.g. the launch cone [−25°, 205°].
- Rotation (`meta.rotation`, clockwise degrees applied to the coded image for display; ffmpeg `-display_rotation 90`, which is counter-clockwise, gives 270). With coded size cw × ch, a coded point (x, y) maps to display: 0° (x, y); 90° (ch − y, x); 180° (cw − x, ch − y); 270° (y, cw − x). U1 pins this with a barcode fixture and against the `<video>` element's rendering.
- **Ground-truth rotation convention.** The generator's `<id>.gt.json` (`meta.video.rotation`, `meta.factors.rotation`) stores ffmpeg's display-matrix value, which is **counter-clockwise**: the rotated smoke clip has GT rotation 90 and `SourceMeta.rotation` 270 (ffprobe `side_data rotation` 90, coded 1920×1080, display 1080×1920). Never compare raw values: `rotation_cw = (360 − rotation_gt) mod 360`. GT positions (`frames[].ball`, `impact.address`, `landing`, `arc2d`) are already display px with pixel centres at +0.5, the convention of this section.
- World (U5 internal): metres, Y up, Z toward the target, ball at the origin.

## 5. Time conventions

- `t` = presentation time in **video seconds**, the frame PTS: container PTS after the edit list with negative pre-roll dropped (codec), rVFC `mediaTime` (element), ffprobe `pts_time` (node). It is what `video.currentTime` reads while the frame is shown, so renderers compare it directly with `currentTime`.
- Frame index k: presentation order 0..frameCount−1; `meta.times[k]` strictly increasing; `ref.t === meta.times[ref.index]`. Frame k is on screen for currentTime in [t_k, t_{k+1}). Δ = 1/`meta.fps` = median interval; use real `times` for VFR clips.
- `frameAt(times, t)`: the frame shown at t (last k with t_k ≤ t), −1 before the first.
- Impact t0 is continuous video time, inside the impact interval and **strictly before the first post-impact observation**. Real time is t_real = (t − t0)/τ, τ = slow-motion factor (video seconds per real second, ALWAYS fitted by U5).
- Thresholds: `frames` count container frames (= capture frames for slow motion, which keeps per-frame motion gates fps-invariant); `sec` are video seconds; `realSec` are real seconds (= realSec·τ video seconds). `{frames, sec}` means max of both: `spanFrames(spec, fps, tau)`.
- Results are in video seconds; predicted points may extend past `meta.duration`. The coarse scan uses `scanStride(fps)` (every frame up to 60 fps).

## 6. Pipeline and dependency injection (U9)

```js
// dist/hf/pipeline.js
/** @returns {Promise<HFResult>} rejects with AbortError on signal, HFError 'decode' if the source fails mid-stream */
export async function analyzeClip(source, { onProgress, signal, modules, params = PARAMS, diagnostics = false } = {})
/** Real collaborators, loaded with dynamic import() so a missing unit file fails only when used. */
export async function defaultModules()   // -> Promise<HFModules>
```

- `modules` (typedef `HFModules` in `types.js`) holds every collaborator the pipeline calls: `CoarseScanner`, `findImpacts`, `LaunchConfirmer`, `RoiTube`, `FlightTracker`, `reassociate`, `fitFlight`, `completeFlight`, `displayCurve`, `decide`. When `modules` is given it is used as is (tests pass full mocks, or `{...await defaultModules(), findImpacts: mock}`); otherwise `await defaultModules()`.
- The pipeline is the only module that imports other units' runtime code, and only through `defaultModules()`. U6's `FlightTracker` receives its U4/U5 collaborators as `deps = {RoiTube: modules.RoiTube, fitFlight: modules.fitFlight}`.
- Frame loop: one `for await (const ref of source.frames({from, to, signal}))`. For each consumer whose window contains `ref.index` and that is not done: `reqs = c.roiRequests(i)`, `crops = await Promise.all(reqs.map(q => ref.lumaRect(q.rect, {pool: q.pool})))`, `c.consume(i, ref.t, crops, simAt(log.camera, i))`. `consume` is called for every index of the window, in order, even with no requests. The loop ends early when every consumer is done. Windows are clamped to the clip; a consumer is never fed after `done` (a boolean getter: a `done()` method is a contract error). A pass restarts at the next needed frame across a gap longer than `pipeline.restartGapSec` (any gap for element sources); consumers see exactly their windows either way.
- **Memory bounds.** At most one live FrameRef (the source closes it on `next()`); crops are fresh copies the consumers own; one RoiRequest rect may cover at most `pipeline.maxRequestFrames` frame areas (W·H) and one frame's requests together at most `pipeline.maxFrameCropFrames`. A request beyond either bound is a contract violation of that consumer (fail closed: `internal_error`, the message in `diagnostics.errors`), never an allocation of tens of Mpx.
- **Decode policy (element path).** A FrameRef may carry `verified` (true | false | null; element sources only). A frame with `verified === false` (its presented `mediaTime` never matched `meta.times[index]`) is re-read up to `pipeline.unverifiedRetries` times by restarting the iteration at it, before any consumer sees it; `null` (no rVFC) is not retried. A frame still unverified is used and recorded (`diagnostics.unverified`, `counts.<phase>.unverified/retries`). At the end: if one lies in the **launch window** (the confirmer window of the drawn launch; for an abstention, of any hypothesis) or the **flight window** (`frameAt(t0 − pipeline.flightPreSec)` .. the last drawn observation), the result abstains with `decoder_limited` (an abstention keeps its own codes and adds it; a replaced trace is summarized in `diagnostics.decoderLimited`); otherwise the result keeps its status and gets the info code `slow_decode_path`.
- Contexts passed down (typedefs in `types.js`): `LaunchContext {meta, log, params}`, `TrackerContext {meta, log, impact, params}`, `FitContext {meta, launch, horizon, tauPrior, params}`, `CompleteContext {meta, camera, horizon, launch, observedEnd, params}`, `CurveContext {meta, launch, params}`, `DecideContext {meta, log, impacts, decisions, params}`.
- Early exits: `meta.frameCount === 0` (or a scan that yields nothing, or a null source) gives `makeAbstention(['no_frames'])`; no impacts gives `no_launch`; no accepted launch gives the rejected decisions' reasons, unique, in impact order. `meta.path === 'element'` adds the info code `slow_decode_path`.
- Error policy: an aborted signal rejects with its reason (an AbortError by default), also while a source `next()` is pending, and `done` is then never reported; a failing or contract-breaking FrameSource rejects with `HFError` (`decode` unless the source set a code), so the worker can retry on the element path; `onProgress` throwing rejects with its error. A collaborator that throws or breaks its output contract (every boundary is `check()`ed: CoarseLog, ImpactHypothesis[] with unique ids, integer windows, RoiRequest[], LaunchDecision of its own hypothesis, unique launch ids, TrackHypothesis[] of the right launch, FlightFit with one inlier entry per observation, Completion, Decision with a consistent selection, DisplayPoint[]) gives an `internal_error` abstention; a collaborator missing from `modules` or failing to load gives `engine_not_ready`, only when it is first needed.
- Launch and fit details: impacts are truncated to `impact.maxHypotheses`; all accepted launches are tracked when there are at most `pipeline.maxLaunches`, otherwise those with the largest null margin, kept in impact order. Per launch only the best branch (`finish()[0]`) is fitted: `fitFlight` cold on every observation (it skips non-inliers), then up to `track.reassocIters` rounds of `reassociate` + warm `fitFlight`, ending early when a round leaves the observations unchanged in every field `fitFlight` reads (frame, time, position, sigma, cov, d, flag); observations the final inlier mask drops become `'rejected'` before `completeFlight`, `decide`, `displayCurve` and the result. `FlightCandidate.escape` is null (decide computes the swing-disc escape from `impact.envelope`); `features` = `{branches, trackedInliers, inliers, rejected, reassocRounds}`. `launch.view` is the fit's view unless the fit is missing or `'unknown'`, else the LaunchCandidate's.
- Result assembly: `points` from the display curve, normalized; `observations` = the selected track's inlier observations, normalized, sigma / hypot(W, H); `camera = cameraSamples(log.camera, meta)`; `launch = {t: t0, x, y, dir, view}` normalized; `completion` from `Completion` (normalized end); `confidence` from `decide`. Then `validateResult(result, {width, height, fps})`; on failure the pipeline returns `makeAbstention(['internal_error'], {diagnostics: {errors}})` and tests treat that as a bug. Abstentions keep the camera track when the scan ran, and decide's confidence when decide abstained; `launch` is always null in an abstention.
- Diagnostics (always, structured-cloneable): `paramsVersion`, `path`, `ms` per phase and `total`, `counts` per pass phase `{passes, frames, fed, crops, cropPx, retries?, unverified?}`, `errors` (when any), `rejected` (the drawn track's fit outliers, normalized), `unverified` and `decoderLimited` (decode policy). `diagnostics: true` adds `impacts`, `launches`, `candidates` (features, observations with flag/src/z, fit and completion summaries) and `decision`.
- Progress: `onProgress(makeProgress(phase, done, total, message?))`, phases `probe | scan | impact | launch | track | fit | decide | done`, at most one event per `pipeline.progressMs` within a phase; a new phase is always reported (so at most 8 events beyond the throttle), and `done` exactly once per resolved result, never on a rejection.
- `engine.js`: `runHF(source, opts = {}, onProgress)` is the stable entry used by the worker and the bench; its body is `return analyzeClip(source, {...opts, onProgress})` (wired; `opts` = `{signal, diagnostics, params, modules}`). Extra pipeline exports: `MODULE_FILES`, `unavailableModule(name, reason)`, and `defaultModules({load})` (a test seam).

## 7. Unit APIs

Signatures use the typedefs in `dist/hf/types.js`. **(contract)** marks exports other units call: frozen. Other listed exports are the unit's required surface; units may add exports, and other units must not depend on unlisted ones.

### U1 decode

`dist/hf/decode/codec-source.js`
```js
/** Best FrameSource for a file. prefer 'auto' tries codec, then element; 'codec' or 'element' forces one.
 *  port: MessagePort to serveElementFrames (needed for the element path inside a worker; on the main
 *  thread without a port, ElementFrameSource is used directly). Rejects HFError 'unsupported' when no path works
 *  (err.failures lists each path's {path, code, message}); a fallback records source.fallback = the codec failure. */
export async function openFrameSource(fileOrBlob, { prefer = 'auto', signal, port, jobId, webcodecs, params } = {})   // (contract) -> Promise<FrameSource>
export class CodecFrameSource { static async open(blob, { signal, webcodecs, params } = {}); meta; frames(opts); close(); holdPort(port, jobId); get format }   // meta.path 'codec'
```
- **Element port when the codec path wins (as built).** The returned codec source holds `port`; its `close()` posts `{type:'close', jobId}` on it (`releaseElementPort`), so the main-thread `serveElementFrames` releases its video element and resolves. A `RemoteFrameSource` opened on the port before that (the worker's retry, §11) claims it, and the codec close then leaves it alone. A released port cannot be reopened: `RemoteFrameSource.open` rejects at once with `HFError('closed')` instead of waiting for a server that is gone.
- Primary path: `demuxMp4` + WebCodecs `VideoDecoder` (`decodeQueueSize ≤ decode.maxDecodeQueue`, ≤ `decode.maxOpenFrames` live frames). `frames({from})` starts decoding at the keyframe at or before `from` and drops earlier outputs. Every presented frame is yielded exactly once with container PTS.
- Falls back (inside `openFrameSource`) on: fragmented MP4 (`moof`), no `moov`, unsupported codec, missing WebCodecs, `isConfigSupported` false, or an error while decoding the first frame. A decoder error later rejects the iterator with `HFError('decode')`; the worker retries the job once with `prefer: 'element'`.
- `lumaCoarse` / `lumaRect` must equal `poolLuma` / `cropLuma` applied to the full-resolution, display-orientation, full-range luma plane, bit for bit. Plane rules: planar YUV takes plane 0; 10-bit formats shift right by `decode.tenBitShift`; limited range (`VideoColorSpace.fullRange === false`) expands with Y' = clamp(round((Y − 16)·255/219), 0, 255); RGBX/BGRX compute luma as below; anything else draws to an OffscreenCanvas. `lumaRect` may use `copyTo({rect})` on the covering even-aligned coded rect.

`dist/hf/decode/mp4-demux.js`
```js
/** Parse moov (read with Blob.slice, never whole). Throws HFError 'fragmented' | 'no-moov' | 'no-video' | 'unsupported'. */
export async function demuxMp4(blob, { signal } = {})   // -> Promise<DemuxInfo>
/** DemuxInfo: {codec, description?:Uint8Array, codedWidth, codedHeight, rotation, timescale,
 *   samples:{offset, size, dts, pts, key}[] (decode order), order:Int32Array (sample per presentation index),
 *   times:Float64Array (s; edit list applied, pts < 0 pre-roll dropped), fps, vfr, duration, hasAudio,
 *   fullRange:boolean|null, hints:{captureFps?, focal35?}} */
export async function readSample(blob, sample)   // -> Promise<Uint8Array>
```
Handles avc1/avc3/hvc1/hev1, mp4/mov, `tkhd` rotation 90/180/270, B-frames (`ctts`, versions 0 and 1), `co64`, edit lists, VFR. Start from `D3-scratch/web/mp4-demux.js`.

As built (U1):
- `demuxMp4(blob, {signal, allowUnsupported, fragments})`: `fragments: true` parses `moof/traf/trun` timing (the element path uses it for exact fragmented times; the default still throws `'fragmented'`), `allowUnsupported` returns timing for any codec. DemuxInfo also has `entry`, `samples[].index`, `matrix`, `fragmented`; codec strings use the sample-entry fourcc. Also exported: `sampleReader(blob, samples, {maxBytes, maxGap})` (batched reads), `matrixRotation(a, b, c, d)`, `avcVideoSignal(avcC)`.
- Edit lists follow libavformat: only samples with composition time in [media_time, media_time + duration) are presented, the first at the sum of leading empty edits; contiguous segments merge. Non-contiguous multi-segment edit lists, rate ≠ 1, mirrored matrices and several sample descriptions throw `'unsupported'` (→ element path).
- Colour range precedence: H.264 SPS VUI `video_full_range_flag` (parsed, as libavcodec does), then the container `colr nclx`, then `VideoFrame.colorSpace.fullRange`, else limited (Chrome reports limited for some full-range streams). HEVC VUI is not parsed.
- Full-frame reads are `copyTo()` with no rect; `lumaRect` copies the even-aligned coded rect covering its clamped footprint, reuses the full copy when one exists or the footprint is over 25% of the frame, and switches to full copies when rect copies are refused. Backpressure: feeding pauses at `decode.maxDecodeQueue` queued chunks or `decode.maxOpenFrames` waiting frames, so held frames are transiently bounded by maxOpenFrames + maxDecodeQueue + reorder depth.

`dist/hf/decode/orient.js`
```js
export function displaySize(codedW, codedH, rotation)                 // -> {width, height}
export function codedToDisplay(x, y, rotation, codedW, codedH)        // -> {x, y}, continuous coords, formulas in §4
export function displayToCoded(x, y, rotation, codedW, codedH)        // -> {x, y}
export function displayRectToCoded(rect, rotation, codedW, codedH)    // -> Rect, integer cover
export function codedRectToDisplay(rect, rotation, codedW, codedH)    // as built: the inverse cover
export function displayWalk(rotation, codedW, codedH, stride, sx0, sy0)   // as built: {base(Y), step} index walk for fused kernels
```

`dist/hf/decode/planes.js`
```js
export function expandLimitedRange(src, out?)            // -> Uint8Array; LUT of the formula above
export function shiftTo8(src16, shift, out?)             // -> Uint8Array (10-bit -> 8-bit)
export function rotatePlane(src, w, h, rotation, out?)   // -> {data, w, h} in display orientation
export function rgbaToLuma(rgba, w, h, { hd, bgr, stride }, out?)   // -> Uint8Array; hd: (54R + 183G + 19B + 128) >> 8 (BT.709), else (77R + 150G + 29B + 128) >> 8
export { poolLuma, cropLuma } from '../types.js'         // re-export; never re-implement with other rounding
// as built: fused kernels, bit-exact with poolLuma / cropLuma of the upright full-range plane
export function lumaLut(bits = 8, limited = false, params)   // -> Uint8Array table (10/12-bit shift, limited expansion) | null for 8-bit full range
export function poolPlane(src, cw, ch, stride, rotation, pool, lut, out)                      // -> LumaImage
export function cropPlane(src, sw, sh, stride, sx0, sy0, cw, ch, rotation, rect, pool, lut, out)   // -> LumaCrop; a whole upright plane applies lut inside the pooling loop
export function validBox(rect, W, H, pool); export function cropFootprint(rect, W, H, pool)
```

`dist/hf/decode/element-source.js` (main thread unless noted)
```js
/** Own hidden <video>: frame-centre seeks + rVFC mediaTime check (phase-1 helpers in dist/frame-source.js),
 *  canvas readback -> rgbaToLuma at native size. meta.path 'element'. */
export class ElementFrameSource { static async open(fileOrBlob, { signal } = {}); meta; frames(opts); close() }
/** Answer a RemoteFrameSource on port (protocol in §11) until it sends 'close' or signal aborts. */
export async function serveElementFrames(fileOrBlob, port, { signal } = {})   // (contract, for analysis-client)
/** Worker side of the element fallback; a FrameSource fed by serveElementFrames. */
export class RemoteFrameSource { static async open(port, { signal } = {}); meta; frames(opts); close() }
```
- Seek targets are frame centres; a repeated `mediaTime` gets one re-seek nudged by `decode.dupNudgeFrac`·Δ; wait at most `decode.rvfcWaitMs` for the presented frame. Reuse phase-1 `sourceFrameSchedule`, `snapSourceFps`, `presentedFrameReader`, `probeSourceFps` from `dist/frame-source.js`. They land with the phase-1 merge, so until then use `import * as frameSource from '../../frame-source.js'` and feature-check, never a named import of a missing export.
- `meta.times` come from the demuxer when `moov` parses (codec unsupported), else k / fps from the rVFC probe (fallback `decode.fallbackFps`).
- The main thread sends **whole native luma planes**, so lumaCoarse and lumaRect are answered in the worker and there is no per-ROI round trip.

As built (U1):
- `element-source.js` does **not** import `dist/frame-source.js` (it is self-contained while that file is replaced): `hasDom`, `snapSourceFps`, `sourceFrameSchedule`, `frameCentre`, `medianFrameInterval`, `presentedFrameReader`, `probeSourceFps` are copied and adapted. **Open item (checker gap 9, last step):** the phase-1 `dist/frame-source.js` has now landed, but its helpers are not drop-in: `presentedFrameReader` calls `seek(video, t, signal)` (the copy: `seek(t, signal)`) and has no `env` injection (the fake-DOM tests need it), `probeSourceFps(video, seek, signal, {sampleFps})` probes several spots, `sourceFrameSchedule(end, sourceFps, sampleFps, start, phase)` and `snapSourceFps(rawFps)` (fallback fixed at 30) differ. Replacing the copies changes the element path and must be re-validated with the Chrome CDP bench (`tests/bench/browser-decode.mjs`).
- Readback is `new VideoFrame(video)` + `copyTo` of the Y plane when the demuxed rotation and size agree (exactly the codec path's values); `drawImage` + `rgbaToLuma` is the fallback.
- Frames a seek cannot reach (Chrome seeks by decode time: leading pictures of an open GOP, fragmented B-frame H.264) are caught by a slow-playback rescue; the repeat retry also fires on a presented `mediaTime` earlier than the target. Frames that never match are **yielded with `verified: false`, not dropped**; without rVFC every frame has `verified: null`. Element and remote FrameRefs add `mediaTime` and `verified`; element refs add a `plane` getter. The pipeline's decode policy (§6) decides what an unverified frame means. D2's timeline-alignment offset was dropped (a single leading-picture probe reads as a false 2-frame offset).
- `ElementFrameSource.open(blob, {signal, params, env})` (env: injected globals, tests) and `.stats` `{seeks, retries, rescued, unverified, duplicates, noRvfc, readback, demux}`; `serveElementFrames(blobOrOpenSource, port, {signal, params, env})`; `RemoteFrameSource.open(port, {signal, jobId, params})` with `.stats` refreshed at each iteration end; `releaseElementPort(port, jobId)` (see openFrameSource).

`tests/hf/helpers/node-source.mjs`
```js
/** FrameSource from ffmpeg: -fps_mode passthrough, extractplanes=y (raw Y), pts from ffprobe packets; meta.path 'node'.
 *  Frames must equal the browser codec path on the same file (same limited-range expansion). */
export async function openNodeSource(path, { ffmpeg = process.env.FFMPEG ?? 'ffmpeg', ffprobe, signal } = {})   // (contract) -> Promise<FrameSource>
export function hasFfmpeg()   // -> boolean; tests skip when false
```
As built: pixels are ffmpeg's raw display-orientation Y plane (`extractplanes=y`, `gray10le`/`gray12le` for high bit depth) mapped through the **same lookup table** as the WebCodecs path, not `-pix_fmt gray`, so they equal the codec path bit for bit. The table is applied lazily inside the fused `poolPlane` / `cropPlane` kernels; a crop whose footprint is over 25% of the frame converts the plane once for that frame. Times come from ffprobe packets (discarded pre-roll dropped), each frame is checked against its `showinfo` pts under `-copyts`; mid-clip starts use `-ss` with a one-time fallback to decoding from the start; two raw buffers alternate, so no per-frame allocation.

### U2 camera motion, coarse scan, spots

`dist/hf/coarse-scan.js`
```js
export class CoarseScanner {                         // (contract)
  constructor(meta, { params = PARAMS } = {})
  /** img = await ref.lumaCoarse(params.scan.longEdge) for frames from, from + stride, ... in order.
   *  img.data may be reused by the caller after push returns, so copy what you keep. */
  push(index, t, img)
  finish()                                           // -> CoarseLog
}
```
CoarseLog fields (`types.js`): `pool, w, h, stride, frames {index, t}, camera: CameraTrack, spots: Spot[], vacates: VacateEvent[]` (every candidate, `valid` marks passes), `energy: EnergyStore, horizon: Horizon|null, movers: Mover[], specks: Speck[]`. Positions are stabilized native px; specks are raw native px; the energy store answers `disk(x, y, r, i0, i1)` and `active(index, x, y, r)` in stabilized native px.

`dist/hf/camera-motion.js`
```js
/** Similarity mapping previous-frame coarse px to current-frame coarse px (content motion), robust to the
 *  golfer: SAD at 1/4 res, textured patches, IRLS Tukey (PARAMS.scan.camera). exclude: coarse boxes to ignore. */
export function estimateMotion(prev, cur, { prior, exclude, params } = {})   // -> {sim: Sim, inlierRatio, ok, residual}
export class CameraPath {
  constructor(meta, { pool })
  push(index, t, est)          // est null: hold the previous similarity, inlier 0
  track()                      // -> CameraTrack (entry 0 = identity reference)
}
```

`dist/hf/spots.js`
```js
/** Box-DoG candidates, both polarities, tile-MAD z, per-tile caps (PARAMS.scan.candidates). */
export function detectCandidates(img, { params })   // -> {x, y, d, z, polarity, contrast, roundness, fill}[] (coarse px)
/** Spot linking, ball-like gates, vacate tests (persistence, NCC change, stable post patch, impulse,
 *  gradual-departure veto, time-limited occlusion recovery), arrival counts, movers, lens-fixed specks. */
export class SpotTracker {
  constructor(meta, { pool, params })
  push(index, t, img, candidates, sim)
  finish()                     // -> {spots, vacates, movers, specks}
}
```

As built (U2):
- Signatures: `estimateMotion(prev, cur, {prior, exclude, excludeMask, foreground, params, detail})` → `{sim, inlierRatio, ok, residual, patches, inliers, rigid, ground, detail?}` (sim in coarse px, raw prev → raw cur); `CameraPath(meta, {pool})` adds `at, entryOf, simAt, toStab, fromStab, samples, translationTrack, length`; extra classes `MotionTracker`, `CandidateDetector`, `EnergyRecorder`; `detectCandidates(img, {params, large})` → `{x, y, d, z, resp, polarity, contrast, roundness, fill, luma, scale}[]`; `SpotTracker.push(index, t, img, candidates, sim, {detector, noise, motion})`, `finish()` → `{spots, vacates, movers, specks, candidates}`. Pure rules exported: `impulseOk`, `gradualDeparture`, `arrivalVetoes`, `vacateFailures`, `lastToLeave`; helpers `estimateHorizon`, `energyRuns`, `passEnergy`, `noiseSigma`, `samplePatch`, `patchNcc`, `patchStability`.
- `Spot.roundness` is the second-moment **axis ratio** sqrt(λ1/λ2) (the eigenvalue ratio rejects side-lit balls), still compared with `scan.spot.maxEigRatio`; roundness and fill use the blob eroded by one pixel.
- Extension fields (additive; no other unit reads them): VacateEvent `clusterId, eligible, arrivalVeto, outOfView, surround, supersededBy, fails[], recoverIndex, quality, passEnergy`; CoarseLog `candidates, motionEnergy, diagnostics {msPerFrame, camera, horizons}`. Extra vacate guards: outOfView, surround, duplicate, median detection z ≥ `candidates.zMin`.
- **Horizon (seam with U5, checker gap 4):** `estimateHorizon` finds the lower edge of the open sky (tree tops, often 1.4-8° above the true horizon), so `CoarseLog.horizon` carries `kind: 'skyline'` (a missing kind means the same): a one-sided bound, the geometric horizon is at or below it. Only `kind: 'horizon'` may be used as the horizon itself; U5 reads it through `horizonKind(h)`.
- R1 (last to leave) and the arrival veto have **one owner, U3** (`impact.js`; checker gap 11, settled in the fix round): U2 only measures (`Spot.arrivalMovers`, vacate fields) and reports `clusterId`.
- Camera: zero-mean SAD/SSD/LK search, ground-first patches when a horizon is known, keyframe refresh on a low inlier ratio. Energy is computed at half resolution, `energy.cellPx` cells, sparse or dense uint8.
- Constants outside PARAMS (to promote): `CAMERA_INTERNALS`, `SPOT_INTERNALS`, `ENERGY_BLOCK = 16`, `HORIZON_MIN_EDGE = 10`.

### U3 impact, launch, club, nulls

`dist/hf/impact.js`
```js
/** Valid vacates -> ranked hypotheses (≤ impact.maxHypotheses, by vacate quality, never size). Applies R1
 *  last-to-leave within a time-limited window, the arrival veto, pass-energy timing support, the impact interval
 *  and the τ prior from the first step. [] means no_launch. */
export function findImpacts(log, meta, { params = PARAMS } = {})   // (contract) -> ImpactHypothesis[]
export function swingEnvelope(log, hyp, meta, params)              // -> SwingEnvelope | null
export function tauPriorFromStep(step1D0, view = 'unknown', params, fps = 30)   // as built: extra fps -> TauPrior; view 'dtl' | 'fo' | 'unknown'
```

`dist/hf/launch-null.js`
```js
export class LaunchConfirmer {                       // (contract) a FrameConsumer
  constructor(hyp, { meta, log, params })
  window()                     // -> {from, to}: t0 − 0.25 s .. t0 + 0.5 s plus the fake-impact null windows
  roiRequests(index)           // -> RoiRequest[]: the reachable region at pool = max(1, round(d0 / launch.roiD0Px))
  consume(index, t, crops, sim)
  get done()
  finish()                     // -> LaunchDecision
}
/** S >= nulls.factor·max(Snull) + nulls.offset; margin = S − that bound. */
export function acceptLaunch(S, Snull, params)       // -> {accepted, margin}
export function nullLaunchScores(lc, winner)          // as built (was (frames, hyp, winner, ctx)) -> number[]: fake anchors ±0.22·W, fake impacts 12 and 20 frames earlier
export function confirmLaunch(hyp, frames | cropFn, ctx)   // as built: the confirmer over buffered frames -> LaunchDecision
```
Acceptance order: hard gates first (f1, f2, f3, f5, projective-line law with one shared c, sample counts), then the club chain rules (club-explained extent, outrun the club, pre-existing mover, precursor), then the null margin. No launch-angle gate; flat face-on launches (8-12°) pass. The learned LLR is logged in `LaunchDecision.llr` and never gates. Single-sample launches stay off unless `launch.singleSample.enabled` (then they need every D2 guard and yield `partial` + `single_sample_launch`). Rejections carry an abstain code: `ball_not_found_after_impact`, `launch_not_confirmed`, `club_only_motion`, `ball_left_frame_too_fast`, `identity_conflict`. Required pixel-level tests (FINAL): ball-sized chrome glints, the face-on club head (1.1-1.4 d0 tall), ball and club merged in the first post-impact frame, codec artifacts, and the invisible-ball control.

`dist/hf/emergence.js`
```js
/** As built: there is no launchEvidence export; per-frame evidence is ballEvidence (+ LaunchConfirmer.process). */
export function ballEvidence(Y, ref, grid, d0p, sc, params, { hole, exclude })   // -> {peaks, zmap, sigmaG}: DoG, local CFAR, address hole
export function emergenceChains(search)                        // as built (was (peaks, hyp, club, ctx)) -> EmergenceChain[]
export function fitProjectiveLine(samples, hyp, ctx)           // -> {v, c, t0, dir, ..., widthErr, sizeOk, startOk, rmsOk, speedOk, bandOk, ok}; s = vτ/(1+cτ), w = d0/(1+cτ), one shared c
export function chainFeatures(chain, hyp, club, ctx)           // -> {f1, f2, f3, f4, f5, f6, f7}
export function rayTransform(frameSegs, geo, hyp, ctx, top = 16)   // as built: up to `top` streak chains (was one or null); monotone DP (streakDP)
```

`dist/hf/club.js`
```js
export function trackClub(peaksByFrame, hyp, { T, kEnd, kLast, tOf, params })   // as built (club peaks per frame, not frames) -> ClubTrack & {anchor, T, score, measuredPost} | null
export function clubExplained(x, y, index, club, d0, params)   // -> boolean (extent-sized exclusion)
export function outrunsClub(chain, club, params)               // -> boolean (ball/club distance ratio band 1.1-2.2)
```

As built (U3):
- One reference median is shared by the real and fake impact times; the ball residual follows the hypothesis polarity. Club evidence is |Y − B|; the club impact phase is solved continuously; club exit takes the trailing club body as the head; a rigid-attachment rule rejects ferrule/hosel peaks; pre-existing mover and precursor rules as in D2 with documented allowances.
- Law and gates: size law from ≥ 3 widths, novelty floor, start test relative to the expected width, speed-ratio position allowance, late-start gap rule, two-sample exits must be consecutive frames, reach scaled by 30/fps, K capped at 12 frames. Streak mode runs only when no blob chain passes and faces max(blob, streak) nulls.
- A native address-empty check returns `no_launch` when the address refills (practice swing, a parked second ball). The LLR is logged only; single-sample launches stay off.
- `LaunchConfirmer(hyp, {meta, log, params, streak = true})`. `impact.js` is the single owner of R1 (`lastToLeave`: an earlier vacate is superseded by a later one within clusterD·(d_a + d_b)/2, time-limited by `impact.r1Window` with the τ prior) and of the arrival veto (`arrivalVetoes`); also exported: `impactInterval`, `tauForWindows`.
- **Seam with U2 (checker gap 6, fixed):** U2's `k_last` can be one or two frames off (the club hides the ball before impact, covers the address after), so the impact interval is widened by `impact.timingTolFrames` (2 frames), and with the club head tracked the ball's t0 lies within `launch.club.impactTolFrames` (±1.5 frames) of its arrival; the accepted `t0` must lie inside the hypothesis interval (§5).
- *Open item, checker gap 7:* launch confirmation costs 1-9 s per clip in the final composition (0.3 s per hypothesis budget); it is now the largest phase.

### U4 ROI detection

`dist/hf/roi-detect.js`
```js
export class RoiTube {                               // (contract) RoiTubeLike
  constructor({ meta, camera, params = PARAMS, polarity = 0, specks = [] })
  plan(index, pred)            // -> RoiRequest[]: [main, decoy, decoy]; decoys offset ⟂ by roi.decoyOffsetH·h
  push(index, t, crops, sim)   // crops in plan order; registered to stabilized px (camera + local refine)
  ready(index)                 // -> boolean: crops up to index + J + 2L are in (as built: four-frame background)
  detect(index, pred)          // -> RoiDetection | null (+ extras mode 'temporal'|'spatial', L, reason)
}
/** max(T_min(nTests) at roi.nullAlpha, roi.nullQuantile of the decoy history). */
export function nullThreshold(history, nTests, params)   // (contract) -> number
export function tbdSearch(zmaps, pred, { J, grid, spacing, sigmas })   // -> {S, x, y, vx, vy, polarity, z1} | null; shared with reassociate
export function tubeGeometry(pred, m = 1, params)   // as built -> {J, L, spatial, h, pool, sigmaMf, r, gate, ...}
export function normalUpper(q)                       // as built: standard-normal upper-tail quantile
```
Two-sided background I_k − ½(I_{k−L} + I_{k+L}), L = ceil(roi.bgLagRadii·r/|v|); spatial background when L > roi.bgLagMax (slow apex, slow motion: never self-subtract a slow ball; no trailing median). Matched filter σ = max(0.7 px, 0.35·d), both polarities, centred 7-frame TBD (J = 3), thresholds only from decoy empirical nulls (no fixed CFAR constant), lens-fixed speck mask from `specks`, cached `ZMap`s for re-association.

As built (U4; superseding the two lines above where they differ):
- **Background is four-frame, two-sided:** I_k − g·¼(I_{k−2L} + I_{k−L} + I_{k+L} + I_{k+2L}) (noise √1.25 instead of √1.5; the two-frame form keeps only about 83% of a slow d = 2 ball), so the detection delay is J + 2L pushed steps. L = ceil(2.5·r/|v|) counts pushed (stride) steps, with r = max(d/2, √2·σ_mf).
- **Noise normalization is a tiled, outlier-robust RMS outside the ball disc** (`roi.noise`: tiles of `tilePx`; a tile whose mean square exceeds `outlierRatio` × the median live tile, a golfer or club, keeps its own RMS, interpolated between tile centres; the rest share one RMS, floored at the 8-bit rounding noise), not D3's MAD (x264 skip blocks collapse the MAD at 2 Mbps). This fixed checker gap 3 (crop-wide RMS rose 14-28× with the golfer inside).
- Decoys hold 2×2 tiles of the main search region (8 null samples per frame), at sticky offsets 1.25·decoyOffsetH·h, re-chosen when h grows, the path turns > 30° or a decoy leaves the frame. `nullThreshold` = max(T_min, a max-of-N normal model's quantile, a robust order statistic, the history maximum while young); `detect()` also raises T to the frame's highest decoy score (burst guard). Every `detect()` call appends that frame's decoy nulls once.
- **Bounded work (checker gap 1, fixed with U6):** the search σ is capped to what the largest crop holds, every rect is clipped to the frame and to `roi.halfSize.maxPx` (decoys: maxPx plus one search radius), every search box to its map, and one `detect` shrinks its search until the TBD samples fit `roi.maxDetectWork`; U6 stops coasting a branch once its 1σ passes `track.coastMaxSigmaDiag` × diag. The pipeline also bounds every request (§6), so a runaway σ fails closed instead of allocating tens of Mpx (the check saw 29586² decoy rects, 13-27 GB).
- **Prediction extras (checker gap 5, agreed with U6):** `ax, ay` (px/frame², the TBD path becomes x + v·Δi + ½·a·Δi²), `sv` (the velocity 1σ; the wide velocity grid is used only above one grid spacing), `coasting`, and `nullKey`/`nullFrom` (one decoy null history per MHT branch, so re-probing a frame no longer over-weights it). Re-acquisition after a loss needs the threshold + `roi.reacquireExtraZ`.
- Acceptance additions: relaxed z1 rule, window consistency, a wide velocity scan with position freedom (airplanes), a ring size gate, a background-ghost check, polarity flips after > 25 levels of background change. Local registration is Lucas-Kanade on the main ROI. `groundSizeD` is not implemented; `Observation.d` is the disc-equivalent 4σ, reported only when reliable.
- Constants outside PARAMS (to promote to `roi`): SIGMA_FLOOR_PX 0.15, CANDIDATES 3, LK_ITERS 2, LK_FULL_PX 4096, DECOY_TURN 30°, DECOY_HEADROOM 1.25, VEL_STEPS 6, RING 2 / RING_DEG 20, SIZE_RATIO 0.35, GHOST_RATIO 2, BOX_SIGMA 4.

### U5 flight model, LM, completion, display curve

`dist/hf/flight-model.js`
```js
/** Robust M3D fit: drag, lift, spin-axis tilt, pinhole camera with horizon-tightened pitch/roll, focal mixture
 *  incl. ultra-wide 0.5x with k1, early sizes as log-radius observations, τ ALWAYS fitted (multi-start on the τ
 *  modes with early abandon). Ill-conditioned M3D: forward validation picks M3D or the short-horizon image model
 *  (kind 'image', early fade; its predictions have h = null). Uses only obs with flag 'inlier'; sets
 *  FlightFit.inlier per input observation. predict(t) -> FitPrediction {t, x, y, cov, d, h} in stabilized px. */
export function fitFlight(obs, ctx, { warm, signal } = {})   // (contract) -> FlightFit
export function detectSpeedRamp(obs, ctx)                    // -> {ramp, tSplit: number|null, tau: [number, number]|null}
export function simulate(params, ctx, times)                 // -> world states; the generator must not import this
export const M3D_PARAM_NAMES                                 // names of FlightFit.params for kind 'm3d'
```

`dist/hf/lm.js`
```js
export function levenbergMarquardt(residuals, x0, { jacobian, maxIter, lambda0, tol, huberDelta, robustRows, priors, lower, upper, step, jtj } = {})   // -> {x, cost, iters, converged, JtJ, r, weights}
export function solveSPD(A, b, n)    // -> Float64Array | null (as built: null when A is not positive definite; LM raises its damping)
export function invertSPD(A, n)      // -> Float64Array (row-major) | null (same)
export function cholesky(A, n); export const huber   // as built
```

`dist/hf/complete.js`
```js
/** End of the arc: landing (height back to the address plane after the apex) | exit (prediction ≥ exitMarginD·d
 *  outside the frame, raw coordinates via ctx.camera) | fade (Laplace σ(t) major axis 3% -> 6% of diag) | cap
 *  (t0 + capRealSec·τ). Sets fade, uncertain (fade before uncertainBeforeFrac of the remainder) and ramp. */
export function completeFlight(fit, obs, ctx)   // (contract) -> Completion
export function sigmaMajor(cov)                 // -> number, 1σ major axis (px) of [sxx, sxy, syy]
```

`dist/hf/display-curve.js`
```js
/** Dense display curve (section 8), stabilized native px. completion null -> observed-only curve. */
export function displayCurve(fit, obs, completion, ctx)   // (contract) -> DisplayPoint[]; as built: ctx.hz overrides display.hz, fit may be null
```

As built (U5):
- `fitFlight(obs, ctx, {warm, signal, noRamp, forward})`; 12 M3D parameters `M3D_PARAM_NAMES` = logF, pitch, roll, logS0, elev, azim, cl, tilt, cd, logTau, k1, logTau2 (`IMAGE_PARAM_NAMES` for kind 'image'); `cov` is the full Laplace covariance with zero rows for fixed parameters. Extra FlightFit members used inside U5 only (never put in results): `at, velocity, isInlier, landingCov, ramp, component, tauMode, diagnostics, _state`. Also `predictWithSigma(fit, t)`, `detectSpeedRamp(obs, ctx, {fit, signal})`, `horizonKind(h)`.
- `completeFlight` is the contract name (`completeTrack` an alias); complete.js also exports `sigmaMajor, honoredObservations, realTime, videoTime`. Completion adds `fade`, `uncertain` (→ `completion_uncertain`) and `ramp` (→ `speed_ramp`).
- k1 is corner-relative (x = c + f·xₙ·(1 + k1·r²/r_c²), r_c = half-diagonal / f), as in the generator's intrinsics. With a speed ramp, `FlightFit.tau` is τ before the split and `Completion.slowMoFactor` the effective τ = (tLast − t0)/t_real(tLast).
- Forward validation runs only on cold, ill-conditioned fits; if a cold fit chose the image model, the next warm call falls back to a cold fit (the pipeline therefore skips warm refits of unchanged data, §6).
- Horizon (seam with U2, checker gap 4, fixed): a `kind: 'skyline'` line only bounds pitch from below (`fit.skylineSigmaDeg`, one-sided); only `kind: 'horizon'` tightens pitch/roll both ways. Every observation σ gets `fit.sigmaFloorPx` in quadrature; k1 ≤ `fit.k1Max`; τ refines within `fit.tauLogSigma` of each mode. Prior z-scores (`fit.r2MaxPriorZ`) only mark a fit ill (sending cold fits to forward validation), they are not an R2 gate; R2's fit gates are a robust χ²/dof (`fit.r2MaxRmsNorm`, unless not significant at `fit.r2Chi2Z`) and physically plausible fitted values (`fit.physical`).
- Constants outside PARAMS: `TAU_FLOOR = 0.01` (every τ mode keeps 1% prior weight), multi-start and RANSAC sizes, LM box bounds, ramp-scan settings.

### U6 tracker, decision, confidence

`dist/hf/flight-tracker.js`
```js
export class FlightTracker {                         // (contract) a FrameConsumer
  constructor(launch, { meta, log, impact, params }, { RoiTube, fitFlight })
  window()                     // -> {from: frameAt(t0 − pipeline.flightPreSec), to: frameCount}
  roiRequests(index)           // -> RoiRequest[] for every live branch; [] on strided frames
  consume(index, t, crops, sim)
  get done()
  finish()                     // -> TrackHypothesis[] best first (≤ track.maxBranches)
}
/** Global re-association: Viterbi over local maxima of the cached z-maps inside the refit gate, plus a miss
 *  state; recovers faint early and post-occlusion points, drops points the fit rejects. */
export function reassociate(hyp, fit, ctx, deps)   // (contract) -> TrackHypothesis
```
Physics-predicted ROIs (launch law for the first `track.launchProfileObs` inliers, then warm M3D refits), MHT with reserved per-launch quotas, distractor masks (`log.movers`, static persistence, pre-impact movers), change-point trimming, 3-of-5 re-acquisition, occlusion coasting, frame exit and re-entry, stride at slow apex, and the physics-residual test that drops an airplane steal even after `track.planeMissFrames` misses.

As built (U6):
- `finish()` follows the contract; `result()` is an extra convenience (fit / re-association loop inside the tracker). TrackHypothesis `features` include `identityMargin, rivalShare, flags, cuts, lostEvents, reacquired, reentries, spawns, escape` and tracker stats. Extra exports: `trendFires, changePointCut, pruneBranches, zmapPeaks, chi2, TRACKER_MODEL`.
- Model constants live in `TRACKER_MODEL`, not PARAMS (to promote to `track`): procAccD, floorPx, maskActive, maskRadiusD, llrCap, peaks, moverExtrapSec, moverGrowth, cpRefineSigmas, cpGapPx, cpRefPx, lawIters, pdInit, pdRate. procAccD sets the coasting σ growth that U4 sizes crops from; since the fix round a branch stops coasting once its 1σ passes `track.coastMaxSigmaDiag` × diag (checker gap 1).
- Physics-residual test: every probation is judged against the frozen pre-gap prediction (D2 same-sign trend plus a residual-drift test) and commits only if a joint refit keeps the points; 3-of-5 density after any gap; Kalman-style fit-mode prediction (fit dynamics + a residual line through the latest inliers); flux-jump spawns; learned distractor tracks; change-point trim on residuals against the final fit. `reassociate` never adds points after the last forward inlier and cannot apply club labels (TrackerContext has no launch).
- The tracker passes `ax, ay, sv, coasting, nullKey, nullFrom` to the tube (see the U4 notes) and probes `detect` per branch; it stops coasting past `track.coastMaxSigmaDiag`.

`decide.js` / `confidence.js` as built:
- `decide` computes the swing-disc escape from `impact.envelope` when `candidate.escape` is null (the pipeline passes null); a null envelope passes; a missing fit makes R2 false (observed-only partial or `low_confidence`), never `flight_inconsistent`. Status mapping: confidence in [0.6, 0.85) with a normal completion → partial `completion_uncertain` with the arc allowed; partial (b) needs confidence ≥ 0.6; no escape → `club_only_motion`; failing fit gates → `flight_inconsistent`; R3 rivals overlap in time and share < `identityShareMax` observations; non-overlapping confirmed flights → `multiple_shots`. Abstentions carry the best candidate's confidence for diagnostics. Extra exports: `fitGatesPass, exitConfirmed, enoughObserved, cameraUsable`; `ctx.confidenceModel` overrides the model.
- `DEFAULT_CONFIDENCE_MODEL`: a provisional monotone logistic (non-negative weights on signed inputs): every input at full evidence gives `confidence.provisionalFull`, one input at its R-rule gate gives `decide.partialMinConfidence`; labelled `'uncalibrated'`. *Open item, checker gap 10:* it is not calibrated until it is fitted on the tune split (`fitConfidence`). Extra exports: `inlierObservations, tauOf, realSpan`.

`dist/hf/decide.js`
```js
/** Rules R1-R5 (D3 §6) per FlightCandidate; picks the best; maps to status and reason codes (section 10). */
export function decide(candidates, ctx)   // (contract) -> Decision
export function swingEscape(observations, envelope)   // -> boolean: some inlier outside the envelope
export function flightConfirmed(track, fit, completion, meta, params)   // -> boolean (R2)
```

`dist/hf/confidence.js`
```js
export function confidenceFeatures(candidate, ctx)   // -> Object<string, number>: null margin first, fit features
export function scoreConfidence(features, model = DEFAULT_CONFIDENCE_MODEL)   // (contract) -> Confidence
export function fitConfidence(rows, { kind = 'logistic' } = {})   // -> ConfidenceModel {kind, calibratedOn, features, weights?, bias?, isotonic?}
export const DEFAULT_CONFIDENCE_MODEL   // monotone in the null margin; calibratedOn 'uncalibrated' until fitted on tune
```
Monotone map (logistic with ≤ `confidence.maxParams` parameters, or isotonic), fitted on the tune split only. `calibratedOn` is `'synthetic-tune-v1'` once fitted.

### U7 benchmark runner (tests only)

```
node tests/bench/run-node.mjs --corpus /tmp/flightline-corpus/<split> [--engine hf|v2] [--only <id>] [--out report.json]
tests/bench/metrics.mjs   export function scoreClip(result, gt, { width, height, fps })   // -> ClipMetrics
                          export function aggregate(clips, { strata })                     // -> Report with Wilson intervals
tests/bench/gate.mjs      export function checkGate(report, acceptance = PARAMS.acceptance)  // -> {pass, failures}
```
Drive the engine only through `openNodeSource` + `runHF`. Ground truth `<id>.gt.json` belongs to the synthetic generator (`tests/synth`, see its README); positions are display px with pixel centres at +0.5 (the generator's raster), the same convention as section 4. **GT rotation is ffmpeg's counter-clockwise value** (§4): compare `(360 − gt.meta.video.rotation) mod 360` with `SourceMeta.rotation`, never the raw numbers. Gate values are `PARAMS.acceptance`; holdout runs are rationed and logged with the code hash.

As built (U7): `--entry auto` resolves to `analyzeClip` when present and `--entry runHF` forces the engine entry (identical now that `runHF` is wired; the report records which). `checkGate` returns `{pass, safetyPass, qualityPass, preconditions, results, failures}`; SAFETY also requires no runner or engine errors, every result valid, and at least one clip. Bench definitions PARAMS lacks (wrong-trace rules, SNR convention, coverage classes, controls, strata) live in `tests/bench/acceptance.json`. The wrong-trace definition is strict (club track, steal, switch, < 50% matched, launch off by > max(3 frames, 0.25 s real) or 2·d0, a visible point > 5% of the diagonal from arc2d). Recall uses the generator's decoded-video SNR oracle. Runtime targets are projected from ms/frame per format. Every run appends to `<corpus parent>/bench-runs.jsonl`; pin the corpus version for gating (it is regenerated while agents run). The browser runner needs the integrator's `?bench=1` app hook (`window.__flightlineBench`, `window.__flightlineLastResult`).

### U10 v2 fixes

`dist/tracker.js`, `dist/global-associate.js`, `dist/curve.js`: safety and cheap correctness fixes for `?engine=v2|legacy`. No import from or into `dist/hf`.

## 8. Display curve and point statuses

- First point: `anchor` at (launch t0, address). Exactly one.
- One sample at **every inlier observation time** (status `observed`), plus samples every 1/`display.hz` s from t0 to the end, so consecutive points are ≤ `result.maxPointGapSec` (1/60 s) apart.
- Status of every later sample (`curveStatus(t, obsTimes, display.observedHalfFrame / fps)`): `predicted` when t is after the last inlier observation; otherwise `observed` when within half a frame interval of an inlier observation; otherwise `interpolated` (between the anchor and the first observation, and across missed frames). Predicted points therefore form the tail.
- Positions: C(t) = model(t) + ρ(t); ρ is a residual smoothing spline, pinned to 0 at the anchor, decaying after the last observation over max(6 frames, 0.15 s real) with b(u) = 1 − 3u² + 2u³, so the junction is C¹. Every inlier lies within `display.withinSigma` = 1.5σ of its sample. Observations are never dropped; outliers are rejected only by the robust fit and listed in diagnostics.
- `alpha` is absent (= 1) except in the end fade, where it never increases. A `fade` end fades the last point.
- Without a completion the curve ends exactly at the last observation and has no predicted points.
- The renderer draws these points directly and must not run `smoothFlight` on them.

## 9. Result contract and invariants

```
{ points:[{t,x,y,status:'anchor'|'observed'|'interpolated'|'predicted', alpha?}],   // normalized, stabilized, dense
  observations:[{t,x,y,sigma}], camera:[{t,x,y,s?,r?}], engine:'hf', observedFrames,
  status:'tracked'|'partial'|'no_reliable_track', reasonCodes:[...],
  confidence:{value, calibratedOn, components},
  launch:{t,x,y,dir,view}|null,
  completion:{end:{type,t,x,y}, observedEnd, observedSec, predictedSec, slowMoFactor}|null,
  diagnostics? }
```

`validateResult(result, {width, height, fps})` returns `{ok, errors}`; `assertResult` throws. It enforces:

1. Keys: exactly these top-level keys (`diagnostics` optional), and only the listed keys inside points, observations, camera samples, launch, completion and confidence. `engine === 'hf'`.
2. `no_reliable_track` ⇒ `points = []`, `observations = []`, `completion = null` (so `observedFrames = 0`).
3. `tracked` or `partial` ⇒ a curve of ≥ 2 points, a launch, observations and camera samples. `tracked` ⇒ a completion.
4. **Arc completion only after a confirmed launch AND flight-confirmed identity:** completion ⇒ launch ≠ null and (≥ `decide.r2MinObs` = 8 observations spanning ≥ `decide.r2MinRealSec` = 0.15 s real, using `completion.slowMoFactor`) or `observedEnd === 'frame_exit'`. Predicted points ⇒ completion.
5. Curve: one anchor, first, equal to launch t, x, y; times strictly increasing with gaps ≤ 1/60 s; predicted points exactly the samples after the last observation; a curve sample with status `observed` at every observation time; within 1.5σ (when width and height are given); statuses equal `curveStatus` (when fps is given); without a completion the curve ends at the last observation.
6. Completion identities: `end` equals the last point; `observedSec = (lastObs.t − launch.t)/τ`; `predictedSec = (end.t − lastObs.t)/τ` (± `result.timeTolSec`); a `fade` end fades the last point.
7. Observations strictly increasing, the first strictly after `launch.t`, sigma > 0; `observedFrames === observations.length`.
8. Reason codes known, unique, and matching the status (section 10).
9. Numbers finite; normalized coordinates within `result.coordRange` [−1, 2] (catches px units); camera translation within ±2, 0 < s < 10, |r| ≤ π; launch dir a unit vector; view in `VIEWS`; confidence value in [0, 1] with `calibratedOn` in `CALIBRATIONS` and numeric components.
10. Structured-cloneable: no functions or cycles anywhere (never put a `FlightFit` in diagnostics).

Also enforced by tests: `normalizeTrackReport` never upgrades a status (`isDowngradeOrSame(from, to)`); a `Decision` with `allowCompletion` needs R1 and R2; a `LaunchDecision` is accepted exactly when it has a candidate, and then its null margin is ≥ 0.

`exampleResult(kind, {width, height, fps})` (`kind` = `tracked | partial-a | partial-b | abstain`) returns a valid result for UI and pipeline tests.

## 10. Statuses and reason codes

- `tracked`: R1 launch confirmed, R2 identity confirmed by flight, R3 no conflict, R4 camera usable, R5 confidence ≥ `decide.trackedMinConfidence`, and the completion ended normally. Only `info` codes.
- `partial`: (a) R1-R4 hold, confidence ≥ `decide.partialMinConfidence`, completion faded early: `completion_uncertain`; (b) R1 holds but R2 does not: observed-only curve, no completion: `tracking_ended_early`; (c) single-sample launch when enabled: `single_sample_launch`. At least one `partial` code, no `abstain` code.
- `no_reliable_track`: at least one `abstain` code, no `partial` code, nothing drawn.

| Kind | Codes |
| --- | --- |
| abstain | `no_frames`, `decoder_limited`, `no_launch`, `ball_not_found_after_impact`, `launch_not_confirmed`, `club_only_motion`, `ball_left_frame_too_fast`, `identity_conflict`, `flight_inconsistent`, `camera_motion_uncompensated`, `insufficient_visible_frames`, `low_confidence`, `engine_not_ready` (a collaborator could not be loaded), `internal_error` |
| partial | `tracking_ended_early`, `completion_uncertain`, `single_sample_launch` |
| info | `multiple_shots`, `slow_decode_path`, `speed_ramp` |

Pipeline-owned codes: `no_frames`, `no_launch`, `engine_not_ready`, `internal_error`, `decoder_limited` (an unverified frame in the launch or flight window, §6) and `slow_decode_path` (element path, or any unverified frame). `REASON_CODES` in `types.js` holds each code's kind and suggested UI copy. `reasonErrors(status, codes)` implements these rules; `validateResult` and the `Decision` constructor both use it. The set is closed: a new code is an edit to `types.js` by the integrator. Bulk export needs `tracked` and `confidence.value ≥ decide.bulkMinConfidence` (0.9); the UI labels the value "calibrated on synthetic clips".

## 11. Worker protocol

Every message carries `jobId` (a string chosen by the main thread). The main thread ignores any message whose `jobId` is not the current job; the worker ignores a cancel for another job, and a new `hf-analyze` cancels the running job. Results and errors are posted once per job.

| Direction | Message |
| --- | --- |
| main → worker | `{type:'hf-analyze', jobId, file: File\|Blob, options:{prefer:'auto'\|'codec'\|'element', diagnostics:boolean}, port?: MessagePort}` (port transferred; present when the element fallback is available) |
| main → worker | `{type:'hf-cancel', jobId}`: the worker aborts the job's AbortController; the main thread terminates the worker if nothing arrives within 2 s |
| worker → main | `{type:'hf-source', jobId, meta:{path, width, height, fps, frameCount, vfr, rotation, hasAudio}}` once the source is open (the UI warns on path 'element') |
| worker → main | `{type:'hf-progress', jobId, phase, done, total, message?}` at most every `pipeline.progressMs` |
| worker → main | `{type:'hf-result', jobId, result}` (an HFResult) |
| worker → main | `{type:'hf-error', jobId, code:'aborted'\|'unsupported'\|'decode'\|'internal', message}` |

Worker job: `source = await openFrameSource(file, {prefer, signal, port, jobId})`, `result = await runHF(source, {signal, diagnostics}, onProgress)`, `finally source.close()`. On `HFError('decode')` from the codec path, retry once with `prefer: 'element'` when a port exists. The v2 `init / frame / finish` protocol stays as it is for `?engine=v2|legacy`.

Port lifecycle (as built): when the codec path wins, the codec source holds the port and its `close()` posts `{type:'close', jobId}`, so the main thread releases its server at job end without help from the analysis client. The retry must therefore **open the element source before closing the failed codec source** (`RemoteFrameSource.open` claims the port; the codec close then leaves it alone):

```js
let source = await openFrameSource(file, { prefer, signal, port, jobId });
try {
  try { result = await runHF(source, { signal, diagnostics }, onProgress); }
  catch (e) {
    if (e?.code !== 'decode' || source.meta.path !== 'codec' || !port) throw e;
    const failed = source;
    source = await openFrameSource(file, { prefer: 'element', signal, port, jobId });   // claims the port first
    await failed.close();
    result = await runHF(source, { signal, diagnostics }, onProgress);
  }
} finally { await source.close(); }   // codec: releases the unused port; remote: posts close itself
```
A port that was released (by a codec or a remote source) rejects a later `RemoteFrameSource.open` with `HFError('closed')` at once. The main thread may also abort `serveElementFrames`'s signal at job end; both are safe together.

**Element frame port** (MessageChannel; main side `serveElementFrames`, worker side `RemoteFrameSource`, both in U1):

| Direction | Message |
| --- | --- |
| worker → main | `{type:'open', jobId}`; reply `{type:'meta', jobId, meta: SourceMeta}` or `{type:'error', jobId, code, message}` |
| worker → main | `{type:'frames', jobId, iter, from, to, stride, credit}` starts an iteration (`credit` = `decode.elementCredit`) |
| main → worker | `{type:'frame', jobId, iter, index, t, mediaTime, w, h, luma: ArrayBuffer}`: full native display-orientation luma (transferred), at most `credit` unacknowledged |
| worker → main | `{type:'ack', jobId, iter, n}` grants n more frames; `{type:'stop', jobId, iter}` ends early |
| main → worker | `{type:'end', jobId, iter}` after the last frame or a stop |
| worker → main | `{type:'close', jobId}` releases the video element |

`t` always equals `meta.times[index]`; `mediaTime` is the presented frame's rVFC time (or null without rVFC) for diagnostics. As built, `frame` also carries `verified` (true | false | null, the pipeline's decode policy reads it), and `meta` and `end` carry the server's `stats`.

## 12. Params

`PARAMS` is one deep-frozen object grouped by unit: `decode` (U1), `scan` (U2), `impact` and `launch` (U3), `roi` (U4), `fit`, `complete`, `display` (U5), `track`, `decide`, `confidence` (U6), `pipeline` (U9), `result` (validator), `acceptance` (U7 gate). Every leaf has a comment with its unit (d0, d, px, frames, sec, realSec, z, frac, diag, deg) and its source section. `PARAMS_VERSION` goes into `diagnostics.paramsVersion`. Helpers: `spanFrames(spec, fps, tau)`, `scanStride(fps)`, `mergeParams(overrides)` (unknown keys and type changes throw). Tuning edits values in `params.js` on the tune split only; adding a key is an integrator change.

`pipeline` keys (as built): `progressMs` 100, `flightPreSec` 0.25, `maxLaunches` 4, `restartGapSec` 1 (was the module constant RESTART_GAP_SEC), `unverifiedRetries` 2, `maxRequestFrames` 4 and `maxFrameCropFrames` 16 (frame areas; §6). Constants still outside PARAMS, to promote (checker gap 12): U2 `CAMERA_INTERNALS`, `SPOT_INTERNALS`, `ENERGY_BLOCK`, `HORIZON_MIN_EDGE`; U4 the eleven listed in §7; U5 `TAU_FLOOR` and the fit search sizes; U6 `TRACKER_MODEL`.

## 13. Performance budgets

Laptop (M4 Pro) targets from the designs; phones are assumed 2.5-4× slower. Measure your hot paths and report ms per frame or per call.

| Stage | Budget | Source |
| --- | --- | --- |
| U1 codec decode + full copyTo + pool (per frame) | ≤ 2.5 ms 1080p, ≤ 3.6 ms 4K | D3 §2.4 (E1) |
| U1 two 256² ROI crops (per frame) | ≤ 2.2 ms at 4K | D3 §2.4 |
| U2 coarse analysis at 540×960 (per analyzed frame) | ≤ 10 ms, camera ≤ 5 ms | D3 U2, E5 |
| U3 launch confirmation (per hypothesis) | ≤ 0.3 s; ray transform about 10 ms | D2 §2.6, D3 §3.4 |
| U4 ROI evidence + TBD (per frame per tube) | ≤ 2 ms | D3 §2.4 |
| U5 final fit / warm refit | ≤ 500 ms / ≤ 40 ms | D3 §2.4 |
| U9 whole clip (laptop Chrome, codec path) | 10 s 4K60 ≤ 20 s; 10 s 1080p30 ≤ 10 s | FINAL acceptance |
| Memory | worker heap ≤ 150 MB; one FrameRef live | D3 §9.5 |

U0 measured (Node 24, M4 Pro): `poolLuma` 1080×1920 → 540×960 1.4 ms, 2160×3840 → 540×960 1.9 ms; `cropLuma` 384² 0.04 ms (inside, pool 1), 0.23 ms (at the edge, pool 2); `validateResult` on a 164-point result 0.25 ms.

Composition (Node 24, real modules on the node source, 1080×1920, frozen synth-1.1 clips, machine shared with other agents at load 20-150):
- P2a check: whole clips 30-94 ms/frame (budget ≈ 33 ms/frame for 10 s 1080p30 ≤ 10 s); U2 scan 6-10 ms/frame, U3 `findImpacts` 0.2-1.5 s/clip (U2's energy-store `cellsIn`), U3 launch 0.5-4.6 s per hypothesis (budget 0.3 s), U4 `detect` 4.5-17 ms mean, U5 cold fit ≤ 400 ms; two clips grew to 13-27 GB.
- P2b final (10 clips, 2188 frames, all fixes): 15.7-72.3 ms/frame, mean 35; per phase in total: launch 34.9 s, scan 31.8 s, track 7.5 s, impact 1.6 s, fit 0.7 s, decide 0.1 s; peak RSS 0.19-0.43 GB. U3 launch confirmation is now the largest cost (checker gap 7). Pipeline code itself is about 20 ms per phase per clip (< 0.5%). Node-source costs after the fused-table kernels: the scan's source time fell 35% and the flight pass's 46%; `cropLuma` is 2-40× faster on the real request shapes (launch 1086×1288 pool 2: 2.1 → 0.45 ms; tube main 384² pool 2: 0.21 → 0.10 ms; mostly-outside decoys: 1.2 → 0.03 ms) (pool-2 inside fast path, edge columns filled once per row), bit-exact.

## 14. Decisions made in this document

These fill gaps the designs left open. Each is binding for the units.

1. **Element fallback streams whole native luma planes** over a credit-based MessagePort. FINAL cut D2's lockstep ROI-request protocol; with whole planes the FrameRef API is identical on every path.
2. **FrameRef methods are async and pool by integers.** `lumaCoarse(longEdge)` pools by `round(longSide/longEdge)` (long edge about 960, from 640 to 1280); `lumaRect` takes an integer `pool`. Integer box pooling is exact, fast, and identical across codec, element, node and memory sources. `next()` closes the previous FrameRef, so at most one frame is live.
3. **Pixel centres at +0.5** (edge convention), matching the synthetic generator's raster. No half-pixel terms in any conversion.
4. **The stabilized reference is the first scanned frame** (v2's convention: `camera[0]` is identity). Result camera samples add scale and rotation about the frame centre, so translation-only renderers stay correct.
5. **Result sigma is normalized by the frame diagonal**, matching the diagonal-based fade and benchmark units.
6. **The dense curve contains a sample at every inlier observation time**, and the observed/interpolated/predicted rule is the half-frame rule of section 8.
7. **Abstentions are empty:** `no_reliable_track` also requires `observations = []` and `completion = null`; raw evidence goes in diagnostics.
8. **Closed reason-code set with kinds** (section 10). New codes beyond the designs: `launch_not_confirmed`, `club_only_motion`, `speed_ramp`, `slow_decode_path`, `engine_not_ready`, `internal_error`. `low_confidence` is an abstain code. v2's `ambiguous_launch` and `no_ball_evidence` are not hf codes.
9. **`calibratedOn: 'uncalibrated'`** is valid until the confidence model is fitted on tune.
10. **Luma only.** Sources provide no chroma, so D3's address-spot saturation gate is dropped (F6: luma-only detection).
11. **R1 last-to-leave is time-limited** to max(30 frames, 1.5 s real) using the hypothesis's τ prior (FINAL: every rule is time-limited).
12. **Cross-unit imports are limited to `types.js` and `params.js`;** collaborators are injected. A unit's tests never depend on another unit's file existing.
13. **t0 is strictly before the first observation;** the launch fit clamps it.
14. **`view` may be `'unknown'`** when no fit classifies it (observed-only partial traces).
15. **Strict result keys.** No `selectedLaunchId` and no per-point `sigma`; extra data goes in `diagnostics`.
16. **Decode policy (P2b).** An element frame whose presented time never matched is re-read `pipeline.unverifiedRetries` times; one that stays unverified inside the launch or flight window makes the result `decoder_limited` (nothing drawn), elsewhere only `slow_decode_path`. A frame that may show another moment must not carry a trace point.
17. **Request memory bound (P2b).** One crop request ≤ `pipeline.maxRequestFrames` frame areas, one frame's requests ≤ `pipeline.maxFrameCropFrames`; beyond that the consumer broke its contract and the result is `internal_error`, never a multi-GB allocation.
18. **Converged re-association ends the fit loop (P2b).** A `reassociate` round that changes no observation in a field `fitFlight` reads (frame, time, position, sigma, cov, d, flag) ends the loop: the warm refit would see the same data from the same fit.
19. **The codec source owns the unused element port (P2b).** Closing it releases the main-thread server unless an element retry has claimed the port; released ports fail fast.
