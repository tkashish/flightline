/**
 * hf engine shared contracts (U0). Frozen for every unit: typedefs, tiny constructors and validators,
 * coordinate and time helpers, the reference luma pooling every FrameSource must match, an in-memory
 * FrameSource for tests, and validateResult for the result contract. docs/TRACKING_HF_PROTOCOL.md is the
 * prose version. Units may import only this file and params.js from other units.
 *
 * Conventions (protocol doc §4-§5):
 * - Native display px: upright (rotation applied), full resolution, x right, y down. Pixel (i, j) covers
 *   [i, i+1) × [j, j+1), centre (i+0.5, j+0.5); the image spans [0, W] × [0, H].
 * - Coarse / crop px: an image pooled by an integer factor `pool`; continuous coordinate u maps to native
 *   X = x0 + pool·u (x0 = 0 for coarse images). No half-pixel offsets anywhere.
 * - Stabilized px: native px in the reference frame (the first scanned frame). raw_k = S_k(stab), with S_k
 *   the CameraTrack similarity of frame k. All tracking, fitting and curves use stabilized native px.
 * - Normalized: x / W, y / H (results only). Result sigmas are px / hypot(W, H).
 * - t: presentation time in video seconds (frame PTS). Frame index k: presentation order, meta.times[k] = t_k.
 */
import { PARAMS } from './params.js';

export const RESULT_ENGINE = 'hf';

const freeze = a => Object.freeze(a);
export const STATUSES = freeze(['tracked', 'partial', 'no_reliable_track']);
export const STATUS_RANK = freeze({ no_reliable_track: 0, partial: 1, tracked: 2 });
export const POINT_STATUSES = freeze(['anchor', 'observed', 'interpolated', 'predicted']);
export const END_TYPES = freeze(['landing', 'exit', 'fade', 'cap']);
export const OBSERVED_ENDS = freeze(['lost', 'frame_exit', 'occluded', 'clip_end', 'landing']);
export const VIEWS = freeze(['dtl', 'fo', 'oblique', 'unknown']);
export const SOURCE_PATHS = freeze(['codec', 'element', 'node', 'memory']);
export const ROTATIONS = freeze([0, 90, 180, 270]);
export const POLARITIES = freeze([1, -1]);
export const OBS_SOURCES = freeze(['launch', 'tbd', 'peak', 'viterbi', 'streak']);
export const OBS_FLAGS = freeze(['inlier', 'rejected', 'ambiguous', 'static', 'mover']);
export const TRACK_STATES = freeze(['active', 'exited', 'lost', 'ended']);
export const FIT_KINDS = freeze(['m3d', 'image']);
export const MOVER_KINDS = freeze(['preimpact', 'sky']);
export const PROGRESS_PHASES = freeze(['probe', 'scan', 'impact', 'launch', 'track', 'fit', 'decide', 'done']);
export const CALIBRATIONS = freeze([PARAMS.confidence.uncalibrated, PARAMS.confidence.calibratedOn]);
export const ERROR_CODES = freeze(['closed', 'busy', 'bad-arg', 'unsupported', 'fragmented', 'no-moov', 'no-video', 'decode', 'internal']);

/**
 * Every reason code an hf result may carry. kind 'abstain' codes explain no_reliable_track, 'partial' codes
 * explain partial, 'info' codes may accompany any status. text is suggested UI copy.
 */
export const REASON_CODES = freeze({
  no_frames: { kind: 'abstain', text: 'No frames could be read from this video.' },
  decoder_limited: { kind: 'abstain', text: 'Video decoding limited what could be analyzed.' },
  no_launch: { kind: 'abstain', text: 'No ball left the address in this clip.' },
  ball_not_found_after_impact: { kind: 'abstain', text: 'The ball was not found leaving the address after impact.' },
  launch_not_confirmed: { kind: 'abstain', text: 'A possible launch did not stand out from the background.' },
  club_only_motion: { kind: 'abstain', text: 'Only club or body motion left the address.' },
  ball_left_frame_too_fast: { kind: 'abstain', text: 'The ball left the frame too fast to confirm.' },
  identity_conflict: { kind: 'abstain', text: 'The track risked switching to another object.' },
  flight_inconsistent: { kind: 'abstain', text: 'The tracked object did not move like a golf ball.' },
  camera_motion_uncompensated: { kind: 'abstain', text: 'Camera motion made tracking unreliable.' },
  insufficient_visible_frames: { kind: 'abstain', text: 'Too few reliable ball observations.' },
  low_confidence: { kind: 'abstain', text: 'The trace was not certain enough to show.' },
  engine_not_ready: { kind: 'abstain', text: 'The high-fidelity engine is not available in this build.' },
  internal_error: { kind: 'abstain', text: 'The analysis hit an internal error.' },
  tracking_ended_early: { kind: 'partial', text: 'The ball was only followed while clearly visible.' },
  completion_uncertain: { kind: 'partial', text: 'The end of the arc is uncertain, so it fades early.' },
  single_sample_launch: { kind: 'partial', text: 'The launch was seen in only one frame.' },
  multiple_shots: { kind: 'info', text: 'More than one shot was found; the clearest one is shown.' },
  slow_decode_path: { kind: 'info', text: 'A slower decoding path was used for this video.' },
  speed_ramp: { kind: 'info', text: 'A slow-motion speed change was detected.' }
});

/** Error with a machine-readable code from ERROR_CODES (decode failures, closed frames, bad arguments). */
export class HFError extends Error {
  constructor(code, message) { super(message || code); this.name = 'HFError'; this.code = code; }
}

/** Throw the signal's AbortError (a DOMException named 'AbortError') when it has been aborted. */
export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/* ------------------------------------------------------------------ typedefs (the contract) */

/** @typedef {{x:number, y:number}} XY  a point (px) or a unit direction (display px space, y down) */
/** @typedef {{x:number, y:number, w:number, h:number}} Rect  integer native px; may extend outside the frame */
/** @typedef {{x0:number, y0:number, x1:number, y1:number}} Box  integer, half-open [x0, x1) × [y0, y1) */
/**
 * @typedef {Object} LumaImage  whole frame pooled by an integer factor (see poolLuma)
 * @property {Uint8Array} data  full-range 8-bit luma, row-major, length w·h, owned by the caller
 * @property {number} w
 * @property {number} h
 * @property {number} pool  pixel (i, j) covers native [pool·i, pool·(i+1)) × [pool·j, pool·(j+1))
 */
/**
 * @typedef {Object} LumaCrop  native crop pooled by an integer factor (see cropLuma)
 * @property {Uint8Array} data  length w·h, owned by the caller
 * @property {number} w  floor(rect.w / pool)
 * @property {number} h  floor(rect.h / pool)
 * @property {number} x0  rect.x; crop coordinate u maps to native x0 + pool·u
 * @property {number} y0  rect.y
 * @property {number} pool
 * @property {Box} valid  crop pixels built only from inside pixels (outside pixels clamp to the edge)
 */
/**
 * @typedef {Object} SourceMeta
 * @property {number} width  visible luma width in display orientation (native px; = video.videoWidth for square pixels)
 * @property {number} height  visible luma height in display orientation (native px)
 * @property {number} codedWidth  decoder plane width before rotation (may include padding)
 * @property {number} codedHeight
 * @property {0|90|180|270} rotation  clockwise degrees the coded image is turned for display
 * @property {number} fps  1 / median frame interval (frames/s)
 * @property {boolean} vfr  p95/p5 of frame intervals exceeds PARAMS.decode.vfrRatio
 * @property {number} frameCount
 * @property {Float64Array} times  presentation time of every frame (s), strictly increasing, length frameCount
 * @property {number} duration  end of the last frame (s): times[n−1] + median interval
 * @property {'codec'|'element'|'node'|'memory'} path
 * @property {boolean} hasAudio
 * @property {string} [codec]  WebCodecs codec string, when known
 * @property {number} [captureFpsHint]  capture rate from container metadata (slow motion), when present
 * @property {number} [focal35]  35 mm-equivalent focal length from metadata, when present
 */
/**
 * @typedef {Object} FrameRef  one decoded frame; invalid once closed or once the iterator advances
 * @property {number} index  presentation index
 * @property {number} t  = meta.times[index] (s)
 * @property {(longEdge:number, out?:Uint8Array) => Promise<LumaImage>} lumaCoarse
 *   whole frame pooled by coarsePool(W, H, longEdge), exactly as poolLuma
 * @property {(rect:Rect, opts?:{pool?:number, out?:Uint8Array}) => Promise<LumaCrop>} lumaRect
 *   native crop pooled by opts.pool (default 1), exactly as cropLuma
 * @property {() => void} close  idempotent; later lumaCoarse/lumaRect calls reject with HFError 'closed'
 */
/**
 * @typedef {Object} FramesOptions
 * @property {number} [from]  first index, default 0 (clamped to [0, frameCount])
 * @property {number} [to]  exclusive end, default frameCount (clamped)
 * @property {number} [stride]  positive integer, default 1: yields from, from+stride, ...
 * @property {AbortSignal} [signal]  aborting rejects the pending next() with an AbortError
 */
/**
 * @typedef {Object} FrameSource  FINAL decode; rotation is handled inside, frames are upright
 * @property {SourceMeta} meta
 * @property {(opts?:FramesOptions) => AsyncIterable<FrameRef>} frames  re-iterable; one live iteration at a time
 *   (another one rejects with HFError 'busy'); next() closes the previous FrameRef
 * @property {() => Promise<void>} close  releases decoder resources; frames() then rejects with 'closed'
 */
/** @typedef {{rect:Rect, pool:number, purpose:string}} RoiRequest  a crop a consumer needs for one frame */
/** @typedef {{a:number, b:number, tx:number, ty:number}} Sim  p -> (a·x − b·y + tx, b·x + a·y + ty) */
/**
 * @typedef {Object} CameraTrack  per analyzed frame; sim maps stabilized native px -> raw native px of that frame
 * @property {Int32Array} index  frame indices, strictly increasing; the first entry is the reference (identity)
 * @property {Float64Array} t
 * @property {Float64Array} sim  4 per entry: a, b, tx, ty
 * @property {Float32Array} inlier  motion inlier ratio per entry (1 for the reference)
 */
/** @typedef {{t:number, x:number, y:number, s?:number, r?:number}} CameraSample  result camera; see cameraSamples */
/**
 * @typedef {Object} EnergyStore  registered frame-difference energy from the coarse scan (|Δluma| > diffMin)
 * @property {number} cellPx  native px per stored cell
 * @property {(x:number, y:number, r:number, i0:number, i1:number) => {index:Int32Array, e:Float32Array}} disk
 *   energy summed in a disk (stabilized native px) for every analyzed frame in [i0, i1]; only ratios are meaningful
 * @property {(index:number, x:number, y:number, r:number) => number} active  active-cell fraction of a disk at a frame
 */
/**
 * @typedef {{slope:number, y0:number, conf:number, kind?:'skyline'|'horizon'}} Horizon  stabilized native px: y = y0 + slope·x.
 *   kind 'skyline' (what U2 finds; also when absent): the lower edge of the open sky, a one-sided bound (the true
 *   horizon is at or below it); 'horizon': the geometric horizon itself
 */
/**
 * @typedef {Object} Mover  a distractor known from the coarse scan
 * @property {string} id
 * @property {'preimpact'|'sky'} kind  pre-impact constant-velocity mover, or a slow straight sky track
 * @property {number} index0  first frame seen
 * @property {number} index1  last frame seen
 * @property {number} x  stabilized native px at index0
 * @property {number} y
 * @property {number} vx  px/frame
 * @property {number} vy
 * @property {number} d  diameter px
 */
/** @typedef {{x:number, y:number, r:number}} Speck  lens-fixed blob in RAW native px (same in every frame) */
/**
 * @typedef {Object} Spot  stationary ball-like candidate (D3 §3.2)
 * @property {string} id
 * @property {number} x  stabilized native px
 * @property {number} y
 * @property {number} d  diameter px
 * @property {1|-1} polarity
 * @property {number} contrast  luma levels
 * @property {number} z  DoG z
 * @property {number} firstIndex  first present frame
 * @property {number} lastIndex  last present frame
 * @property {number} presence  present fraction over [firstIndex, lastIndex]
 * @property {number} roundness  second-moment eigenvalue ratio (>= 1)
 * @property {number} fill
 * @property {boolean} ballLike  passes the D3 §3.2 shape gates
 * @property {number} arrivalMovers  movers in PARAMS.scan.spot.arrivalBandD during arrivalFrames before firstIndex
 * @property {number} clusterId  address cluster: spots within clusterD diameters share it
 */
/** @typedef {{step1D0:number, step2D0:number|null, ok:boolean}} Impulse  departure steps (d0/frame) */
/**
 * @typedef {Object} VacateEvent  a spot that disappeared (D3 §3.3); every candidate is listed, `valid` marks passes
 * @property {string} spotId
 * @property {number} kLast  last present frame
 * @property {number} tLast
 * @property {number} kFirstAbsent
 * @property {number} tFirstAbsent
 * @property {number} absenceRatio
 * @property {number} ncc  pre/post patch NCC
 * @property {number} postStable  post patch frame-to-frame NCC
 * @property {Impulse|null} impulse
 * @property {boolean} gradualDeparture  the veto fired
 * @property {boolean} recovered  presence came back within PARAMS.scan.vacate.recover (occlusion)
 * @property {boolean} valid
 */
/**
 * @typedef {Object} CoarseLog  output of the coarse scan (U2)
 * @property {number} pool  coarse pooling factor
 * @property {number} w  coarse width
 * @property {number} h  coarse height
 * @property {number} stride  scan frame stride
 * @property {{index:Int32Array, t:Float64Array}} frames  analyzed frames
 * @property {CameraTrack} camera
 * @property {Spot[]} spots
 * @property {VacateEvent[]} vacates
 * @property {EnergyStore} energy
 * @property {Horizon|null} horizon
 * @property {Mover[]} movers
 * @property {Speck[]} specks
 */
/** @typedef {{t0:number, t1:number}} Interval  video seconds */
/** @typedef {{modes:number[], weights:number[]}} TauPrior  slow-motion factor modes and weights (sum 1) */
/**
 * @typedef {Object} SwingEnvelope  union of swing motion around impact (D2 §6) on a stabilized native px grid
 * @property {number} x0
 * @property {number} y0
 * @property {number} cellPx  cell (i, j) covers [x0 + cellPx·i, x0 + cellPx·(i+1)) × ...
 * @property {number} w
 * @property {number} h
 * @property {Uint8Array} mask  1 inside, length w·h
 */
/**
 * @typedef {Object} ImpactHypothesis  (U3 impact.js)
 * @property {string} id
 * @property {string} spotId
 * @property {XY} address  stabilized native px
 * @property {number} d0  address-ball diameter px
 * @property {1|-1} polarity
 * @property {number} kLast
 * @property {number} tLast
 * @property {number} kFirstAbsent
 * @property {number} tFirstAbsent
 * @property {Interval} interval  impact interval (D1 §3.4)
 * @property {number} t0Est  inside interval
 * @property {{vacate:number, passEnergy:number, clubPassage:number}} scores
 * @property {TauPrior} tauPrior
 * @property {SwingEnvelope|null} envelope
 */
/** @typedef {{index:number, t:number, x:number, y:number, measured:boolean, extent:number}} ClubPoint  stabilized px */
/** @typedef {{points:ClubPoint[], impactVel:XY, dir:XY|null}} ClubTrack  impactVel px/frame; dir unit, after impact */
/**
 * @typedef {Object} Observation  one ball measurement (stabilized native px)
 * @property {number} index
 * @property {number} t
 * @property {number} x
 * @property {number} y
 * @property {number} sigma  isotropic 1σ position error (px)
 * @property {number[]} [cov]  [sxx, sxy, syy] (px²)
 * @property {number} z  detection score (TBD S or peak z)
 * @property {number|null} z1  single-frame z
 * @property {number|null} d  measured diameter (px)
 * @property {1|-1} polarity
 * @property {'launch'|'tbd'|'peak'|'viterbi'|'streak'} src
 * @property {'inlier'|'rejected'|'ambiguous'|'static'|'mover'} flag  only 'inlier' feeds fits and results
 */
/**
 * @typedef {Object} LaunchCandidate  an accepted launch; seeds flight tracking (U3)
 * @property {string} id
 * @property {string} hypId
 * @property {number} t0  sub-frame impact time (s), before samples[0].t
 * @property {XY} address
 * @property {number} d0
 * @property {XY} dir  unit, display px space
 * @property {number} v  speed at t0 (px/frame)
 * @property {number} c  perspective decay (1/frame), shared by position and width
 * @property {1|-1} polarity
 * @property {Observation[]} samples  chain points (src 'launch' or 'streak')
 * @property {'dtl'|'fo'|'oblique'|'unknown'} view  preliminary
 * @property {boolean} single
 * @property {boolean} streak
 * @property {ClubTrack|null} clubTrack
 * @property {number} S  launch score
 * @property {number} margin  S − (1.15·max S_null + 1)
 */
/**
 * @typedef {Object} LaunchDecision  (U3 LaunchConfirmer.finish)
 * @property {string} hypId
 * @property {boolean} accepted
 * @property {string|null} reason  abstain code when rejected, null when accepted
 * @property {LaunchCandidate|null} candidate  non-null exactly when accepted
 * @property {number} S
 * @property {number[]} Snull
 * @property {number} margin  >= 0 when accepted
 * @property {number|null} llr  learned ball/club LLR, DIAGNOSTIC ONLY
 * @property {object} features
 */
/**
 * @typedef {Object} Prediction  where a tube looks at one frame (stabilized native px)
 * @property {number} index
 * @property {number} t
 * @property {number} x
 * @property {number} y
 * @property {number} vx  px/frame
 * @property {number} vy
 * @property {number[]} cov  [sxx, sxy, syy] px²
 * @property {number} d  expected diameter px
 * @property {1|-1|0} polarity  0 = unknown, test both
 */
/**
 * @typedef {Object} ZMap  cached matched-filter z map around a prediction, for global re-association
 * @property {number} index
 * @property {number} t
 * @property {number} x0  stabilized px of the map corner; map px u maps to x0 + pool·u
 * @property {number} y0
 * @property {number} pool  native px per map px
 * @property {number} w
 * @property {number} h
 * @property {Int8Array} data  round(zScale·z) clamped to ±127
 * @property {number} zScale
 */
/**
 * @typedef {Object} RoiDetection  (U4 RoiTube.detect)
 * @property {number} index
 * @property {number} t
 * @property {Observation|null} observation
 * @property {ZMap} zmap
 * @property {number} score  best TBD S
 * @property {number} threshold  empirical-null T
 * @property {number[]} nullScores  decoy scores this frame
 */
/**
 * @typedef {Object} TrackHypothesis  one MHT branch (U6)
 * @property {string} id
 * @property {string} launchId
 * @property {Observation[]} observations  sorted by t, flagged
 * @property {'active'|'exited'|'lost'|'ended'} state
 * @property {'lost'|'frame_exit'|'occluded'|'clip_end'|'landing'} observedEnd  why observation stopped
 * @property {number|null} exitT
 * @property {number} llr  vs clutter
 * @property {ZMap[]} zmaps
 * @property {object} features
 */
/** @typedef {{t:number, x:number, y:number, cov:number[], d:number, h:number|null}} FitPrediction  stabilized px, px², diameter px, m above the address plane (null for kind 'image') */
/**
 * @typedef {Object} FlightFit  (U5 fitFlight); holds functions, so never put one in a result
 * @property {'m3d'|'image'} kind
 * @property {number[]|Float64Array} params
 * @property {string[]} names
 * @property {number[]|Float64Array|null} cov  row-major Laplace covariance
 * @property {number} tau  slow-motion factor
 * @property {'dtl'|'fo'|'oblique'|'unknown'} view
 * @property {number} rmsNorm  RMS of residual/σ
 * @property {Uint8Array} inlier  per input observation
 * @property {number} inlierFrac
 * @property {number} priorZMax
 * @property {boolean} converged
 * @property {boolean} ill  ill-conditioned
 * @property {number|null} landingT
 * @property {(t:number) => FitPrediction} predict
 * @property {(o:{t0:number, t1:number, dt:number}) => FitPrediction[]} sample
 */
/**
 * @typedef {Object} Completion  (U5 completeFlight); end x, y in stabilized native px
 * @property {{type:'landing'|'exit'|'fade'|'cap', t:number, x:number, y:number}} end
 * @property {'lost'|'frame_exit'|'occluded'|'clip_end'|'landing'} observedEnd
 * @property {number} tLastObs
 * @property {number} observedSec  (tLastObs − t0)/τ
 * @property {number} predictedSec  (end.t − tLastObs)/τ
 * @property {number} slowMoFactor  τ
 * @property {{from:number, to:number}|null} fade  alpha 1 at from, 0 at to
 * @property {boolean} uncertain  faded before uncertainBeforeFrac of the remainder
 * @property {boolean} ramp  a speed ramp was detected
 */
/** @typedef {{t:number, x:number, y:number, status:'anchor'|'observed'|'interpolated'|'predicted', alpha:number}} DisplayPoint  stabilized px */
/** @typedef {{value:number, calibratedOn:string, components:Object<string, number|null>}} Confidence */
/** @typedef {{R1:boolean, R2:boolean, R3:boolean, R4:boolean, R5:boolean}} Rules  D3 §6 */
/**
 * @typedef {Object} FlightCandidate  one launch's best evidence; input to decide
 * @property {ImpactHypothesis} impact
 * @property {LaunchDecision} decision
 * @property {LaunchCandidate|null} launch
 * @property {TrackHypothesis|null} track
 * @property {FlightFit|null} fit
 * @property {Completion|null} completion
 * @property {boolean|null} escape  swing-disc escape
 * @property {object} features
 */
/**
 * @typedef {Object} Decision  (U6 decide)
 * @property {'tracked'|'partial'|'no_reliable_track'} status
 * @property {string[]} reasonCodes
 * @property {FlightCandidate|null} selected
 * @property {boolean} allowCompletion  only with R1 and R2
 * @property {Rules} rules
 * @property {Confidence} confidence
 */
/**
 * @typedef {Object} FrameConsumer  LaunchConfirmer and FlightTracker, driven by the pipeline frame loop
 * @property {() => {from:number, to:number}} window  frame indices [from, to) it needs
 * @property {(index:number) => RoiRequest[]} roiRequests  crops for this frame, maybe []
 * @property {(index:number, t:number, crops:LumaCrop[], sim:Sim) => void} consume  called for every index in the window, in order
 * @property {boolean} done  no more frames needed
 * @property {() => any} finish
 */
/** @typedef {{phase:string, done:number, total:number, message?:string}} Progress  phase from PROGRESS_PHASES */
/** @typedef {{meta:SourceMeta, log:CoarseLog, params:object}} LaunchContext */
/** @typedef {{meta:SourceMeta, log:CoarseLog, impact:ImpactHypothesis, params:object}} TrackerContext */
/** @typedef {{meta:SourceMeta, camera:CameraTrack, params:object, polarity:1|-1|0, specks:Speck[]}} RoiTubeOptions */
/**
 * @typedef {Object} RoiTubeLike  (U4 RoiTube instance)
 * @property {(index:number, pred:Prediction) => RoiRequest[]} plan  main crop first, then decoys
 * @property {(index:number, t:number, crops:LumaCrop[], sim:Sim) => void} push  crops in plan order
 * @property {(index:number) => boolean} ready  enough later frames pushed to detect at index
 * @property {(index:number, pred:Prediction) => RoiDetection|null} detect
 */
/** @typedef {{RoiTube:new (o:RoiTubeOptions) => RoiTubeLike, fitFlight:Function}} TrackerDeps */
/** @typedef {{meta:SourceMeta, launch:LaunchCandidate, horizon:Horizon|null, tauPrior:TauPrior, params:object}} FitContext */
/** @typedef {{meta:SourceMeta, camera:CameraTrack, horizon:Horizon|null, launch:LaunchCandidate, observedEnd:string, params:object}} CompleteContext */
/** @typedef {{meta:SourceMeta, launch:LaunchCandidate, params:object}} CurveContext */
/** @typedef {{meta:SourceMeta, log:CoarseLog, impacts:ImpactHypothesis[], decisions:LaunchDecision[], params:object}} DecideContext */
/**
 * @typedef {Object} HFModules  every collaborator analyzeClip calls; tests replace any of them (protocol doc §6)
 * @property {new (meta:SourceMeta, opts?:{params?:object}) => {push(index:number, t:number, img:LumaImage):void, finish():CoarseLog}} CoarseScanner
 * @property {(log:CoarseLog, meta:SourceMeta, opts?:{params?:object}) => ImpactHypothesis[]} findImpacts
 * @property {new (hyp:ImpactHypothesis, ctx:LaunchContext) => FrameConsumer} LaunchConfirmer  finish() -> LaunchDecision
 * @property {new (o:RoiTubeOptions) => RoiTubeLike} RoiTube
 * @property {new (launch:LaunchCandidate, ctx:TrackerContext, deps:TrackerDeps) => FrameConsumer} FlightTracker  finish() -> TrackHypothesis[]
 * @property {(hyp:TrackHypothesis, fit:FlightFit, ctx:TrackerContext, deps:TrackerDeps) => TrackHypothesis} reassociate
 * @property {(obs:Observation[], ctx:FitContext, opts?:{warm?:FlightFit}) => FlightFit} fitFlight
 * @property {(fit:FlightFit, obs:Observation[], ctx:CompleteContext) => Completion} completeFlight
 * @property {(fit:FlightFit|null, obs:Observation[], completion:Completion|null, ctx:CurveContext) => DisplayPoint[]} displayCurve
 * @property {(cands:FlightCandidate[], ctx:DecideContext) => Decision} decide
 */
/** @typedef {{t:number, x:number, y:number, status:'anchor'|'observed'|'interpolated'|'predicted', alpha?:number}} ResultPoint  normalized, stabilized */
/** @typedef {{t:number, x:number, y:number, sigma:number}} ResultObservation  normalized; sigma = px / hypot(W, H) */
/** @typedef {{t:number, x:number, y:number, dir:XY, view:'dtl'|'fo'|'oblique'|'unknown'}} ResultLaunch  t = t0; dir unit in display px space */
/**
 * @typedef {Object} ResultCompletion
 * @property {{type:'landing'|'exit'|'fade'|'cap', t:number, x:number, y:number}} end  = the last curve point (normalized)
 * @property {'lost'|'frame_exit'|'occluded'|'clip_end'|'landing'} observedEnd
 * @property {number} observedSec  (last observation t − launch.t) / τ, real seconds
 * @property {number} predictedSec  (end.t − last observation t) / τ, real seconds
 * @property {number} slowMoFactor  τ, video seconds per real second
 */
/**
 * @typedef {Object} HFResult  FINAL "Result contract"; validateResult lists every invariant
 * @property {ResultPoint[]} points  dense display curve; [] unless a trace exists
 * @property {ResultObservation[]} observations  inliers used by the fit, sorted by t
 * @property {CameraSample[]} camera
 * @property {'hf'} engine
 * @property {number} observedFrames  = observations.length
 * @property {'tracked'|'partial'|'no_reliable_track'} status
 * @property {string[]} reasonCodes  keys of REASON_CODES
 * @property {Confidence} confidence
 * @property {ResultLaunch|null} launch
 * @property {ResultCompletion|null} completion
 * @property {object} [diagnostics]  structured-cloneable; never read by the renderer
 */

/* ------------------------------------------------------------------ schemas, constructors, validators */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isNums = v => (Array.isArray(v) || ArrayBuffer.isView(v)) && Array.prototype.every.call(v, Number.isFinite);
const fmt = v => typeof v === 'string' ? `'${v}'` : Array.isArray(v) ? `array(${v.length})` : ArrayBuffer.isView(v) ? v.constructor.name : String(v);
const PRIM = {
  num: Number.isFinite,
  int: Number.isInteger,
  nat: v => Number.isInteger(v) && v >= 0,
  posint: v => Number.isInteger(v) && v > 0,
  pos: v => Number.isFinite(v) && v > 0,
  frac: v => Number.isFinite(v) && v >= 0 && v <= 1,
  bool: v => typeof v === 'boolean',
  str: v => typeof v === 'string' && v.length > 0,
  fn: v => typeof v === 'function',
  obj: isObj,
  arr: Array.isArray,
  nums: isNums,
  xy: v => isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y),
  f64: v => v instanceof Float64Array,
  f32: v => v instanceof Float32Array,
  i32: v => v instanceof Int32Array,
  u8: v => v instanceof Uint8Array,
  i8: v => v instanceof Int8Array
};
const ENUMS = {
  STATUSES, POINT_STATUSES, END_TYPES, OBSERVED_ENDS, VIEWS, SOURCE_PATHS, ROTATIONS, POLARITIES, OBS_SOURCES,
  OBS_FLAGS, TRACK_STATES, FIT_KINDS, MOVER_KINDS, PROGRESS_PHASES, CALIBRATIONS, POLARITIES_ANY: freeze([1, -1, 0])
};

/**
 * Field specs: a PRIM name, '#ENUM', '@Type' or '@Type[]'; suffix '?' = may be undefined, '|null' = may be null.
 * The typedefs above document the meaning of every field.
 */
export const SCHEMAS = freeze({
  Rect: { x: 'int', y: 'int', w: 'posint', h: 'posint' },
  Box: { x0: 'int', y0: 'int', x1: 'int', y1: 'int' },
  LumaImage: { data: 'u8', w: 'posint', h: 'posint', pool: 'posint' },
  LumaCrop: { data: 'u8', w: 'posint', h: 'posint', x0: 'int', y0: 'int', pool: 'posint', valid: '@Box' },
  SourceMeta: {
    width: 'posint', height: 'posint', codedWidth: 'posint', codedHeight: 'posint', rotation: '#ROTATIONS', fps: 'pos',
    vfr: 'bool', frameCount: 'nat', times: 'f64', duration: 'num', path: '#SOURCE_PATHS', hasAudio: 'bool',
    codec: 'str?', captureFpsHint: 'pos?', focal35: 'pos?'
  },
  FrameSource: { meta: '@SourceMeta', frames: 'fn', close: 'fn' },
  FrameRef: { index: 'nat', t: 'num', lumaCoarse: 'fn', lumaRect: 'fn', close: 'fn' },
  RoiRequest: { rect: '@Rect', pool: 'posint', purpose: 'str' },
  Sim: { a: 'num', b: 'num', tx: 'num', ty: 'num' },
  CameraTrack: { index: 'i32', t: 'f64', sim: 'f64', inlier: 'f32' },
  CameraSample: { t: 'num', x: 'num', y: 'num', s: 'pos?', r: 'num?' },
  EnergyStore: { cellPx: 'pos', disk: 'fn', active: 'fn' },
  Horizon: { slope: 'num', y0: 'num', conf: 'frac' },
  Mover: { id: 'str', kind: '#MOVER_KINDS', index0: 'nat', index1: 'nat', x: 'num', y: 'num', vx: 'num', vy: 'num', d: 'pos' },
  Speck: { x: 'num', y: 'num', r: 'pos' },
  Spot: {
    id: 'str', x: 'num', y: 'num', d: 'pos', polarity: '#POLARITIES', contrast: 'num', z: 'num', firstIndex: 'nat',
    lastIndex: 'nat', presence: 'frac', roundness: 'num', fill: 'frac', ballLike: 'bool', arrivalMovers: 'nat', clusterId: 'nat'
  },
  Impulse: { step1D0: 'num', step2D0: 'num|null', ok: 'bool' },
  VacateEvent: {
    spotId: 'str', kLast: 'nat', tLast: 'num', kFirstAbsent: 'nat', tFirstAbsent: 'num', absenceRatio: 'frac', ncc: 'num',
    postStable: 'num', impulse: '@Impulse|null', gradualDeparture: 'bool', recovered: 'bool', valid: 'bool'
  },
  FrameList: { index: 'i32', t: 'f64' },
  CoarseLog: {
    pool: 'posint', w: 'posint', h: 'posint', stride: 'posint', frames: '@FrameList', camera: '@CameraTrack',
    spots: '@Spot[]', vacates: '@VacateEvent[]', energy: '@EnergyStore', horizon: '@Horizon|null', movers: '@Mover[]', specks: '@Speck[]'
  },
  Interval: { t0: 'num', t1: 'num' },
  TauPrior: { modes: 'nums', weights: 'nums' },
  SwingEnvelope: { x0: 'num', y0: 'num', cellPx: 'pos', w: 'posint', h: 'posint', mask: 'u8' },
  ImpactScores: { vacate: 'num', passEnergy: 'num', clubPassage: 'num' },
  ImpactHypothesis: {
    id: 'str', spotId: 'str', address: 'xy', d0: 'pos', polarity: '#POLARITIES', kLast: 'nat', tLast: 'num',
    kFirstAbsent: 'nat', tFirstAbsent: 'num', interval: '@Interval', t0Est: 'num', scores: '@ImpactScores',
    tauPrior: '@TauPrior', envelope: '@SwingEnvelope|null'
  },
  ClubPoint: { index: 'nat', t: 'num', x: 'num', y: 'num', measured: 'bool', extent: 'pos' },
  ClubTrack: { points: '@ClubPoint[]', impactVel: 'xy', dir: 'xy|null' },
  Observation: {
    index: 'nat', t: 'num', x: 'num', y: 'num', sigma: 'pos', z: 'num', z1: 'num|null', d: 'pos|null',
    polarity: '#POLARITIES', src: '#OBS_SOURCES', flag: '#OBS_FLAGS', cov: 'nums?'
  },
  LaunchCandidate: {
    id: 'str', hypId: 'str', t0: 'num', address: 'xy', d0: 'pos', dir: 'xy', v: 'pos', c: 'num', polarity: '#POLARITIES',
    samples: '@Observation[]', view: '#VIEWS', single: 'bool', streak: 'bool', clubTrack: '@ClubTrack|null', S: 'num', margin: 'num'
  },
  LaunchDecision: {
    hypId: 'str', accepted: 'bool', reason: 'str|null', candidate: '@LaunchCandidate|null', S: 'num', Snull: 'nums',
    margin: 'num', llr: 'num|null', features: 'obj'
  },
  Prediction: { index: 'nat', t: 'num', x: 'num', y: 'num', vx: 'num', vy: 'num', cov: 'nums', d: 'pos', polarity: '#POLARITIES_ANY' },
  ZMap: { index: 'nat', t: 'num', x0: 'num', y0: 'num', pool: 'pos', w: 'posint', h: 'posint', data: 'i8', zScale: 'pos' },
  RoiDetection: {
    index: 'nat', t: 'num', observation: '@Observation|null', zmap: '@ZMap', score: 'num', threshold: 'num', nullScores: 'nums'
  },
  TrackHypothesis: {
    id: 'str', launchId: 'str', observations: '@Observation[]', state: '#TRACK_STATES', observedEnd: '#OBSERVED_ENDS',
    exitT: 'num|null', llr: 'num', zmaps: '@ZMap[]', features: 'obj'
  },
  FitPrediction: { t: 'num', x: 'num', y: 'num', cov: 'nums', d: 'pos', h: 'num|null' },
  FlightFit: {
    kind: '#FIT_KINDS', params: 'nums', names: 'arr', cov: 'nums|null', tau: 'pos', view: '#VIEWS', rmsNorm: 'num',
    inlier: 'u8', inlierFrac: 'frac', priorZMax: 'num', converged: 'bool', ill: 'bool', landingT: 'num|null', predict: 'fn', sample: 'fn'
  },
  EndPoint: { type: '#END_TYPES', t: 'num', x: 'num', y: 'num' },
  Fade: { from: 'num', to: 'num' },
  Completion: {
    end: '@EndPoint', observedEnd: '#OBSERVED_ENDS', tLastObs: 'num', observedSec: 'num', predictedSec: 'num',
    slowMoFactor: 'pos', fade: '@Fade|null', uncertain: 'bool', ramp: 'bool'
  },
  DisplayPoint: { t: 'num', x: 'num', y: 'num', status: '#POINT_STATUSES', alpha: 'frac' },
  Confidence: { value: 'frac', calibratedOn: '#CALIBRATIONS', components: 'obj' },
  Rules: { R1: 'bool', R2: 'bool', R3: 'bool', R4: 'bool', R5: 'bool' },
  FlightCandidate: {
    impact: '@ImpactHypothesis', decision: '@LaunchDecision', launch: '@LaunchCandidate|null', track: '@TrackHypothesis|null',
    fit: '@FlightFit|null', completion: '@Completion|null', escape: 'bool|null', features: 'obj'
  },
  Decision: {
    status: '#STATUSES', reasonCodes: 'arr', selected: '@FlightCandidate|null', allowCompletion: 'bool', rules: '@Rules',
    confidence: '@Confidence'
  },
  FrameConsumer: { window: 'fn', roiRequests: 'fn', consume: 'fn', done: 'bool', finish: 'fn' },
  Progress: { phase: '#PROGRESS_PHASES', done: 'nat', total: 'nat', message: 'str?' }
});

const increasing = a => { for (let i = 1; i < a.length; i++) if (!(a[i] > a[i - 1])) return false; return true; };
const len3 = (v, path, errs) => { if (v !== undefined && v.length !== 3) errs.push(`${path}: expected [sxx, sxy, syy]`); };
const reasonKind = c => REASON_CODES[c]?.kind;

/**
 * Reason codes must be known and unique; no_reliable_track needs an 'abstain' code, partial a 'partial' code,
 * and no status carries the other kind (tracked: 'info' only). Returns messages, [] when consistent.
 */
export function reasonErrors(status, codes, path = 'reasonCodes') {
  const errs = [], kinds = new Set();
  codes.forEach((c, i) => { if (!REASON_CODES[c]) errs.push(`${path}[${i}]: unknown ${fmt(c)}`); else kinds.add(reasonKind(c)); });
  if (new Set(codes).size !== codes.length) errs.push(`${path}: duplicates`);
  if (status === 'no_reliable_track' && !kinds.has('abstain')) errs.push(`${path}: no_reliable_track needs an abstain reason`);
  if (status === 'partial' && !kinds.has('partial')) errs.push(`${path}: partial needs a partial reason`);
  if (status !== 'no_reliable_track' && kinds.has('abstain')) errs.push(`${path}: ${status} cannot carry abstain reasons`);
  if (status !== 'partial' && kinds.has('partial')) errs.push(`${path}: ${status} cannot carry partial reasons`);
  return errs;
}

/** Cross-field rules per type; each pushes messages into errs. */
const REFINE = {
  LumaImage: (v, p, e) => { if (v.data.length !== v.w * v.h) e.push(`${p}.data: length ${v.data.length} != w·h`); },
  LumaCrop: (v, p, e) => {
    if (v.data.length !== v.w * v.h) e.push(`${p}.data: length ${v.data.length} != w·h`);
    const b = v.valid;
    if (!(b.x0 >= 0 && b.x0 <= b.x1 && b.x1 <= v.w && b.y0 >= 0 && b.y0 <= b.y1 && b.y1 <= v.h)) e.push(`${p}.valid: outside the crop`);
  },
  SourceMeta: (v, p, e) => {
    if (v.times.length !== v.frameCount) e.push(`${p}.times: length ${v.times.length} != frameCount ${v.frameCount}`);
    if (!increasing(v.times)) e.push(`${p}.times: not strictly increasing`);
    if (v.frameCount && !(v.duration >= v.times[v.frameCount - 1])) e.push(`${p}.duration: before the last frame`);
  },
  CameraTrack: (v, p, e) => {
    const n = v.index.length;
    if (!n) e.push(`${p}: empty`);
    if (v.t.length !== n || v.sim.length !== 4 * n || v.inlier.length !== n) e.push(`${p}: array lengths disagree`);
    if (!increasing(v.index)) e.push(`${p}.index: not strictly increasing`);
  },
  Interval: (v, p, e) => { if (!(v.t0 <= v.t1)) e.push(`${p}: t0 > t1`); },
  TauPrior: (v, p, e) => {
    if (v.modes.length !== v.weights.length || !v.modes.length) e.push(`${p}: modes/weights lengths`);
    if (Math.abs(Array.prototype.reduce.call(v.weights, (s, w) => s + w, 0) - 1) > 1e-6) e.push(`${p}.weights: must sum to 1`);
  },
  SwingEnvelope: (v, p, e) => { if (v.mask.length !== v.w * v.h) e.push(`${p}.mask: length != w·h`); },
  VacateEvent: (v, p, e) => { if (!(v.kFirstAbsent > v.kLast)) e.push(`${p}: kFirstAbsent must follow kLast`); },
  ImpactHypothesis: (v, p, e) => {
    if (!(v.kFirstAbsent > v.kLast)) e.push(`${p}: kFirstAbsent must follow kLast`);
    if (!(v.t0Est >= v.interval.t0 && v.t0Est <= v.interval.t1)) e.push(`${p}.t0Est: outside the impact interval`);
  },
  Observation: (v, p, e) => len3(v.cov, `${p}.cov`, e),
  Prediction: (v, p, e) => len3(v.cov, `${p}.cov`, e),
  FitPrediction: (v, p, e) => len3(v.cov, `${p}.cov`, e),
  LaunchCandidate: (v, p, e) => {
    if (Math.abs(Math.hypot(v.dir.x, v.dir.y) - 1) > 1e-3) e.push(`${p}.dir: not a unit vector`);
    if (v.samples.length < (v.single ? 1 : 2)) e.push(`${p}.samples: too few for ${v.single ? 'a single-sample' : 'a'} launch`);
    if (!increasing(v.samples.map(o => o.t))) e.push(`${p}.samples: not sorted by t`);
    if (v.samples.length && !(v.samples[0].t > v.t0)) e.push(`${p}.t0: must precede the first sample`);
  },
  LaunchDecision: (v, p, e) => {
    if (v.accepted !== (v.candidate !== null)) e.push(`${p}: candidate must be set exactly when accepted`);
    if (v.accepted && v.reason !== null) e.push(`${p}.reason: must be null when accepted`);
    if (v.accepted && !(v.margin >= 0)) e.push(`${p}.margin: accepted launches need S >= 1.15·max(S_null) + 1`);
    if (!v.accepted && reasonKind(v.reason) !== 'abstain') e.push(`${p}.reason: rejected launches need an abstain code`);
  },
  ZMap: (v, p, e) => { if (v.data.length !== v.w * v.h) e.push(`${p}.data: length != w·h`); },
  TrackHypothesis: (v, p, e) => { if (!increasing(v.observations.map(o => o.t))) e.push(`${p}.observations: not sorted by t`); },
  FlightFit: (v, p, e) => {
    const n = v.params.length;
    if (v.names.length !== n) e.push(`${p}.names: length != params`);
    if (v.cov !== null && v.cov.length !== n * n) e.push(`${p}.cov: expected ${n}×${n}`);
  },
  Completion: (v, p, e) => {
    if (!(v.observedSec >= 0 && v.predictedSec >= 0)) e.push(`${p}: negative durations`);
    if (!(v.end.t >= v.tLastObs)) e.push(`${p}.end: before the last observation`);
    if (v.fade && !(v.fade.from <= v.fade.to)) e.push(`${p}.fade: from > to`);
  },
  Confidence: (v, p, e) => {
    for (const [k, x] of Object.entries(v.components)) if (x !== null && !Number.isFinite(x)) e.push(`${p}.components.${k}: not a finite number`);
  },
  FlightCandidate: (v, p, e) => { if (v.launch && !v.decision.accepted) e.push(`${p}.launch: needs an accepted decision`); },
  Decision: (v, p, e) => {
    for (const m of reasonErrors(v.status, v.reasonCodes, `${p}.reasonCodes`)) e.push(m);
    if (v.allowCompletion && !(v.rules.R1 && v.rules.R2)) e.push(`${p}.allowCompletion: needs R1 (launch) and R2 (flight identity)`);
    if (v.status === 'tracked' && !Object.values(v.rules).every(Boolean)) e.push(`${p}: tracked needs R1-R5`);
    if (v.status !== 'no_reliable_track' && !v.selected) e.push(`${p}.selected: required unless abstaining`);
    if (v.status === 'no_reliable_track' && v.allowCompletion) e.push(`${p}: an abstention cannot allow completion`);
  },
  Progress: (v, p, e) => { if (v.done > v.total) e.push(`${p}: done > total`); }
};

function checkSpec(spec, v, path, errs) {
  if (spec.endsWith('?')) { if (v === undefined) return; spec = spec.slice(0, -1); }
  if (spec.endsWith('|null')) { if (v === null) return; spec = spec.slice(0, -5); }
  if (spec[0] === '#') { if (!ENUMS[spec.slice(1)].includes(v)) errs.push(`${path}: ${fmt(v)} not in ${spec.slice(1)}`); return; }
  if (spec[0] === '@') {
    if (!spec.endsWith('[]')) { checkInto(spec.slice(1), v, path, errs); return; }
    if (!Array.isArray(v)) { errs.push(`${path}: expected an array`); return; }
    v.forEach((x, i) => checkInto(spec.slice(1, -2), x, `${path}[${i}]`, errs));
    return;
  }
  if (!PRIM[spec](v)) errs.push(`${path}: expected ${spec}, got ${fmt(v)}`);
}
function checkInto(name, v, path, errs) {
  if (!isObj(v)) { errs.push(`${path}: expected a ${name} object, got ${fmt(v)}`); return; }
  const before = errs.length;
  for (const [k, spec] of Object.entries(SCHEMAS[name])) checkSpec(spec, v[k], `${path}.${k}`, errs);
  if (errs.length === before) REFINE[name]?.(v, path, errs);
}

/** Error messages for value as type `name` (a SCHEMAS key); [] when valid. */
export function check(name, value, path = name) {
  if (!SCHEMAS[name]) throw new HFError('bad-arg', `unknown type ${name}`);
  const errs = [];
  checkInto(name, value, path, errs);
  return errs;
}

const DEFAULTS = {
  SourceMeta: f => ({
    codedWidth: f.rotation === 90 || f.rotation === 270 ? f.height : f.width,
    codedHeight: f.rotation === 90 || f.rotation === 270 ? f.width : f.height,
    rotation: 0, vfr: false, hasAudio: false, path: 'memory', frameCount: f.times?.length
  }),
  Spot: () => ({ arrivalMovers: 0, clusterId: 0 }),
  VacateEvent: () => ({ impulse: null, gradualDeparture: false, recovered: false }),
  ImpactHypothesis: () => ({
    scores: { vacate: 0, passEnergy: 0, clubPassage: 0 }, envelope: null,
    tauPrior: { modes: [...PARAMS.impact.tau.modes], weights: PARAMS.impact.tau.modes.map((_, i) => i ? 0 : 1) }
  }),
  Observation: () => ({ z1: null, d: null, src: 'tbd', flag: 'inlier' }),
  LaunchCandidate: () => ({ view: 'unknown', single: false, streak: false, clubTrack: null }),
  LaunchDecision: () => ({ reason: null, candidate: null, Snull: [], llr: null, features: {} }),
  TrackHypothesis: () => ({ exitT: null, llr: 0, zmaps: [], features: {} }),
  Completion: () => ({ fade: null, uncertain: false, ramp: false }),
  Confidence: () => ({ calibratedOn: PARAMS.confidence.uncalibrated, components: {} }),
  FlightCandidate: () => ({ launch: null, track: null, fit: null, completion: null, escape: null, features: {} })
};

/** Build a value of type `name`: defaults, then fields; throws HFError 'bad-arg' listing every problem. */
export function make(name, fields = {}) {
  const v = { ...DEFAULTS[name]?.(fields), ...fields };
  const errs = check(name, v);
  if (errs.length) throw new HFError('bad-arg', errs.join('; '));
  return v;
}
export const makeSourceMeta = f => make('SourceMeta', f);
export const makeObservation = f => make('Observation', f);
export const makeSpot = f => make('Spot', f);
export const makeVacate = f => make('VacateEvent', f);
export const makeImpact = f => make('ImpactHypothesis', f);
export const makeLaunchCandidate = f => make('LaunchCandidate', f);
export const makeLaunchDecision = f => make('LaunchDecision', f);
export const makeTrackHypothesis = f => make('TrackHypothesis', f);
export const makeCompletion = f => make('Completion', f);
export const makeDecision = f => make('Decision', f);
export const makeFlightFit = f => make('FlightFit', f);
export const makeCoarseLog = f => make('CoarseLog', f);
export const makeFlightCandidate = f => make('FlightCandidate', f);
export const makeProgress = (phase, done, total, message) => make('Progress', message === undefined ? { phase, done, total } : { phase, done, total, message });
export const makeConfidence = (value, components = {}, calibratedOn = PARAMS.confidence.uncalibrated) => make('Confidence', { value, components, calibratedOn });

/* ------------------------------------------------------------------ time */

/** Nominal fps, VFR flag and duration from presentation times (s). */
export function timingFromTimes(times, fallbackFps = PARAMS.decode.fallbackFps) {
  const n = times.length;
  if (n < 2) return { fps: fallbackFps, vfr: false, duration: n ? times[0] + 1 / fallbackFps : 0 };
  const d = Float64Array.from({ length: n - 1 }, (_, i) => times[i + 1] - times[i]).sort();
  const q = p => d[Math.round(p * (d.length - 1))];
  const med = q(0.5);
  return { fps: 1 / med, vfr: q(0.95) / q(0.05) > PARAMS.decode.vfrRatio, duration: times[n - 1] + med };
}

/** Index of the frame shown at video time t: the last k with times[k] <= t, or −1 before the first frame. */
export function frameAt(times, t) {
  let lo = 0, hi = times.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t + 1e-9) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

/**
 * Status of a dense-curve sample after the anchor (protocol doc §8): 'predicted' after the last inlier
 * observation, 'observed' within halfFrame of one, else 'interpolated'. obsTimes ascending; halfFrame in s.
 */
export function curveStatus(t, obsTimes, halfFrame, tol = PARAMS.result.sampleTolSec) {
  const n = obsTimes.length;
  if (!n || t > obsTimes[n - 1] + tol) return 'predicted';
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (obsTimes[m] < t) lo = m + 1; else hi = m; }
  const d = Math.min(Math.abs(obsTimes[lo] - t), lo ? t - obsTimes[lo - 1] : Infinity);
  return d <= halfFrame + tol ? 'observed' : 'interpolated';
}

/* ------------------------------------------------------------------ coordinates */

export const IDENTITY_SIM = freeze({ a: 1, b: 0, tx: 0, ty: 0 });
export function applySim(s, x, y) { return { x: s.a * x - s.b * y + s.tx, y: s.b * x + s.a * y + s.ty }; }
export function invertSim(s) {
  const n = s.a * s.a + s.b * s.b, a = s.a / n, b = -s.b / n;
  return { a, b, tx: -(a * s.tx - b * s.ty), ty: -(b * s.tx + a * s.ty) };
}
/** p ∘ q: apply q first, then p. */
export function composeSim(p, q) {
  return { a: p.a * q.a - p.b * q.b, b: p.b * q.a + p.a * q.b, tx: p.a * q.tx - p.b * q.ty + p.tx, ty: p.b * q.tx + p.a * q.ty + p.ty };
}
/** CameraTrack similarity at any frame index: exact at analyzed frames, linear between, clamped outside. */
export function simAt(track, index) {
  const ix = track.index, s = track.sim, n = ix.length;
  const at = k => ({ a: s[4 * k], b: s[4 * k + 1], tx: s[4 * k + 2], ty: s[4 * k + 3] });
  if (index <= ix[0]) return at(0);
  if (index >= ix[n - 1]) return at(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ix[m] <= index) lo = m; else hi = m; }
  const u = (index - ix[lo]) / (ix[hi] - ix[lo]), A = at(lo), B = at(hi), mix = (p, q) => p + (q - p) * u;
  return { a: mix(A.a, B.a), b: mix(A.b, B.b), tx: mix(A.tx, B.tx), ty: mix(A.ty, B.ty) };
}
/** A CameraTrack for a static camera: identity at every frame of meta (or at the given frame indices). */
export function identityTrack(meta, indices = null) {
  const index = Int32Array.from(indices ?? Array.from({ length: meta.frameCount }, (_, k) => k));
  const sim = new Float64Array(4 * index.length);
  for (let k = 0; k < index.length; k++) sim[4 * k] = 1;
  return { index, t: Float64Array.from(index, k => meta.times[k]), sim, inlier: new Float32Array(index.length).fill(1) };
}
export const stabToRaw = (track, index, x, y) => applySim(simAt(track, index), x, y);
export const rawToStab = (track, index, x, y) => applySim(invertSim(simAt(track, index)), x, y);
export const toNormalized = (x, y, meta) => ({ x: x / meta.width, y: y / meta.height });
export const fromNormalized = (x, y, meta) => ({ x: x * meta.width, y: y * meta.height });
export const sigmaToNormalized = (sigmaPx, meta) => sigmaPx / Math.hypot(meta.width, meta.height);
/** Integer pooling factor that brings the long side near longEdge. */
export const coarsePool = (width, height, longEdge) => Math.max(1, Math.round(Math.max(width, height) / longEdge));

/**
 * Result camera samples. For S = [a −b; b a]·p + t (stabilized -> raw px) and frame centre c:
 * raw = c + s·R(r)·(stab − c) + (x·W, y·H), s = hypot(a, b), r = atan2(b, a). With s = 1 and r = 0 this is the
 * v2 translation convention raw_norm = stab_norm + (x, y), so translation-only renderers stay correct.
 */
export function cameraSamples(track, meta) {
  const W = meta.width, H = meta.height, cx = W / 2, cy = H / 2, out = [];
  for (let k = 0; k < track.index.length; k++) {
    const a = track.sim[4 * k], b = track.sim[4 * k + 1], tx = track.sim[4 * k + 2], ty = track.sim[4 * k + 3];
    out.push({ t: track.t[k], x: (tx + a * cx - b * cy - cx) / W, y: (ty + b * cx + a * cy - cy) / H, s: Math.hypot(a, b), r: Math.atan2(b, a) });
  }
  return out;
}
/** Renderer side of cameraSamples: a normalized stabilized point to normalized raw for a W×H canvas. */
export function cameraToRaw(sample, x, y, width, height) {
  const s = sample.s ?? 1, r = sample.r ?? 0, a = s * Math.cos(r), b = s * Math.sin(r);
  const dx = (x - 0.5) * width, dy = (y - 0.5) * height;
  return { x: 0.5 + (a * dx - b * dy) / width + sample.x, y: 0.5 + (b * dx + a * dy) / height + sample.y };
}

/* ------------------------------------------------------------------ reference luma (every FrameSource matches these) */

const outBuf = (out, n) => {
  if (!out) return new Uint8Array(n);
  if (out.length < n) throw new HFError('bad-arg', `out buffer ${out.length} < ${n}`);
  return out.length === n ? out : out.subarray(0, n);
};
const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Pool a tightly packed full-range 8-bit plane by an integer factor: each output pixel is the rounded mean
 * floor((sum + floor(pool²/2)) / pool²) of its pool×pool block; trailing partial rows and columns are dropped.
 * @returns {LumaImage}
 */
export function poolLuma(src, srcW, srcH, pool, out) {
  if (!(Number.isInteger(pool) && pool > 0)) throw new HFError('bad-arg', `pool ${pool}`);
  const w = Math.floor(srcW / pool), h = Math.floor(srcH / pool), data = outBuf(out, w * h);
  if (pool === 1) { data.set(src.subarray(0, w * h)); return { data, w, h, pool }; }
  const area = pool * pool, half = area >> 1, acc = new Uint32Array(w);
  // 4K -> 960 (pool 4) is the per-frame hot path: sum 4 bytes per 32-bit word when rows are word-aligned.
  const words = pool === 4 && srcW % 4 === 0 && src.byteOffset % 4 === 0 ? new Uint32Array(src.buffer, src.byteOffset, (srcW * srcH) >> 2) : null;
  for (let j = 0; j < h; j++) {
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      let p = (j * pool + q) * srcW;
      if (words) for (let i = 0, k = p >> 2; i < w; i++) { const v = words[k++], s = (v & 0xff00ff) + ((v >>> 8) & 0xff00ff); acc[i] += (s & 0xffff) + (s >>> 16); }
      else if (pool === 2) for (let i = 0; i < w; i++, p += 2) acc[i] += src[p] + src[p + 1];
      else if (pool === 3) for (let i = 0; i < w; i++, p += 3) acc[i] += src[p] + src[p + 1] + src[p + 2];
      else if (pool === 4) for (let i = 0; i < w; i++, p += 4) acc[i] += src[p] + src[p + 1] + src[p + 2] + src[p + 3];
      else for (let i = 0; i < w; i++) { let s = 0; for (let k = 0; k < pool; k++) s += src[p++]; acc[i] += s; }
    }
    const o = j * w;
    for (let i = 0; i < w; i++) data[o + i] = (acc[i] + half) / area | 0;
  }
  return { data, w, h, pool };
}

/**
 * Crop rect (integer native px, may leave the frame) from a tightly packed plane, pooled like poolLuma.
 * Outside pixels take the nearest edge pixel; `valid` marks crop pixels built only from inside pixels.
 * @returns {LumaCrop}
 */
export function cropLuma(src, srcW, srcH, rect, pool = 1, out) {
  const errs = check('Rect', rect);
  if (errs.length || !(Number.isInteger(pool) && pool > 0) || rect.w < pool || rect.h < pool) {
    throw new HFError('bad-arg', errs.join('; ') || `rect ${rect.w}×${rect.h} with pool ${pool}`);
  }
  const { x, y } = rect, w = Math.floor(rect.w / pool), h = Math.floor(rect.h / pool), data = outBuf(out, w * h);
  const area = pool * pool, half = area >> 1, W1 = srcW - 1;
  // Output columns [0, iL) read only source column 0 and [iR, w) only srcW − 1 (edge clamping): one value per row.
  // Columns [iA, iB) lie inside and are read directly; the at most one column on each side between them is mixed.
  const iL = clampI(Math.floor((1 - x) / pool), 0, w), iR = clampI(Math.ceil((W1 - x) / pool), iL, w);
  const iA = clampI(Math.ceil(-x / pool), iL, iR), iB = clampI(Math.floor((srcW - x) / pool), iA, iR), m = iB - iA, mx = x + iA * pool;
  const rows = new Int32Array(pool), acc = pool > 1 ? new Uint32Array(m) : null;
  const mixed = (i, o) => { let s = 0; for (let q = 0; q < pool; q++) for (let k = 0, c = x + i * pool; k < pool; k++, c++) s += src[rows[q] + clampI(c, 0, W1)]; data[o + i] = (s + half) / area | 0; };
  for (let j = 0; j < h; j++) {
    const o = j * w, om = o + iA;
    for (let q = 0; q < pool; q++) rows[q] = clampI(y + j * pool + q, 0, srcH - 1) * srcW;
    if (iL || iR < w) {
      let l = 0, r = 0;
      for (let q = 0; q < pool; q++) { l += src[rows[q]]; r += src[rows[q] + W1]; }
      if (iL) data.fill((pool * l + half) / area | 0, o, o + iL);
      if (iR < w) data.fill((pool * r + half) / area | 0, o + iR, o + w);
    }
    for (let i = iL; i < iA; i++) mixed(i, o);
    for (let i = iB; i < iR; i++) mixed(i, o);
    if (!m) continue;
    if (pool === 1) { data.set(src.subarray(rows[0] + mx, rows[0] + mx + m), om); continue; }
    if (pool === 2) {   // the launch-window and tube hot path (1080p, d0 about 12-20 px)
      for (let i = 0, p0 = rows[0] + mx, p1 = rows[1] + mx; i < m; i++, p0 += 2, p1 += 2) data[om + i] = (src[p0] + src[p0 + 1] + src[p1] + src[p1 + 1] + 2) >> 2;
      continue;
    }
    acc.fill(0);
    for (let q = 0; q < pool; q++) {
      const p = rows[q] + mx;
      if (pool === 3) for (let i = 0, k = p; i < m; i++, k += 3) acc[i] += src[k] + src[k + 1] + src[k + 2];
      else if (pool === 4) for (let i = 0, k = p; i < m; i++, k += 4) acc[i] += src[k] + src[k + 1] + src[k + 2] + src[k + 3];
      else for (let i = 0, k = p; i < m; i++) { let s = 0; for (let e = 0; e < pool; e++) s += src[k++]; acc[i] += s; }
    }
    for (let i = 0; i < m; i++) data[om + i] = (acc[i] + half) / area | 0;
  }
  const x0 = clampI(Math.ceil(-x / pool), 0, w), y0 = clampI(Math.ceil(-y / pool), 0, h);
  const valid = { x0, y0, x1: clampI(Math.floor((srcW - x) / pool), x0, w), y1: clampI(Math.floor((srcH - y) / pool), y0, h) };
  return { data, w, h, x0: x, y0: y, pool, valid };
}

/* ------------------------------------------------------------------ in-memory FrameSource */

/**
 * FrameSource over full-resolution display-orientation luma planes (tests, mocks, synthetic scenes).
 * It is the executable definition of the FrameSource/FrameRef contract.
 * @param {{width:number, height:number, frames:Uint8Array[]|((index:number)=>Uint8Array), frameCount?:number,
 *   times?:ArrayLike<number>, fps?:number, rotation?:0|90|180|270, hasAudio?:boolean, codec?:string}} o
 * @returns {FrameSource}
 */
export function createMemorySource(o) {
  const { width, height, frames, fps = 30, rotation = 0, hasAudio = false } = o;
  if (typeof frames === 'function' && !Number.isInteger(o.frameCount)) throw new HFError('bad-arg', 'a frame generator needs frameCount');
  const n = typeof frames === 'function' ? o.frameCount : frames.length;
  const times = o.times ? Float64Array.from(o.times) : Float64Array.from({ length: n }, (_, i) => i / fps);
  const timing = timingFromTimes(times, fps);
  const meta = makeSourceMeta({
    width, height, rotation, fps: timing.fps, vfr: timing.vfr, frameCount: n, times, duration: timing.duration,
    path: 'memory', hasAudio, ...(o.codec ? { codec: o.codec } : {})
  });
  const plane = typeof frames === 'function' ? frames : i => frames[i];
  let busy = false, closed = false;
  const frameRef = (index, data) => {
    let open = true;
    const live = () => { if (!open) throw new HFError('closed', `frame ${index} is closed`); };
    return {
      index, t: times[index],
      async lumaCoarse(longEdge, out) { live(); return poolLuma(data, width, height, coarsePool(width, height, longEdge), out); },
      async lumaRect(rect, { pool = 1, out } = {}) { live(); return cropLuma(data, width, height, rect, pool, out); },
      close() { open = false; }
    };
  };
  async function* iterate({ from = 0, to = n, stride = 1, signal } = {}) {
    if (closed) throw new HFError('closed', 'source is closed');
    if (!(Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(stride) && stride > 0)) {
      throw new HFError('bad-arg', `frames({from:${from}, to:${to}, stride:${stride}})`);
    }
    if (busy) throw new HFError('busy', 'another frames() iteration is live');
    busy = true;
    let ref = null;
    try {
      for (let k = clampI(from, 0, n), end = clampI(to, 0, n); k < end; k += stride) {
        throwIfAborted(signal);
        ref?.close();
        const data = plane(k);
        if (!(data instanceof Uint8Array) || data.length !== width * height) throw new HFError('bad-arg', `frame ${k}: expected ${width}×${height} luma`);
        ref = frameRef(k, data);
        yield ref;
      }
    } finally {
      ref?.close();
      busy = false;
    }
  }
  return { meta, frames: iterate, async close() { closed = true; } };
}

/* ------------------------------------------------------------------ results */

/** True when `to` is the same status as `from` or lower (normalizeTrackReport may only downgrade). */
export function isDowngradeOrSame(from, to) {
  return from in STATUS_RANK && to in STATUS_RANK && STATUS_RANK[to] <= STATUS_RANK[from];
}

/** A valid no_reliable_track result; reasonCodes must include an abstain code. */
export function makeAbstention(reasonCodes, { camera = [], confidence, launch = null, diagnostics } = {}) {
  const codes = [...new Set(reasonCodes)];
  for (const c of codes) if (!REASON_CODES[c]) throw new HFError('bad-arg', `unknown reason code ${c}`);
  if (!codes.some(c => reasonKind(c) === 'abstain')) throw new HFError('bad-arg', 'an abstention needs an abstain reason');
  const r = {
    points: [], observations: [], camera, engine: RESULT_ENGINE, observedFrames: 0, status: 'no_reliable_track',
    reasonCodes: codes, confidence: confidence ?? makeConfidence(0), launch, completion: null
  };
  if (diagnostics !== undefined) r.diagnostics = diagnostics;
  return r;
}

/**
 * A canonical valid HFResult for tests and UI work: a down-the-line arc on a portrait frame with a 2-frame
 * miss. kind 'tracked' completes to a landing, 'partial-a' fades early (completion_uncertain), 'partial-b' is
 * observed-only (tracking_ended_early), 'abstain' is no_launch. Validate it with the same {width, height, fps}.
 */
export function exampleResult(kind = 'tracked', { width = 1080, height = 1920, fps = 30 } = {}) {
  if (kind === 'abstain') return makeAbstention(['no_launch']);
  if (!['tracked', 'partial-a', 'partial-b'].includes(kind)) throw new HFError('bad-arg', `unknown example ${kind}`);
  const t0 = 1 + 0.4 / fps, diag = Math.hypot(width, height);
  const path = t => { const u = t - t0; return { x: 0.5 + 0.05 * u, y: 0.8 - 0.9 * u + 0.6 * u * u }; };
  // Observed every `step` frames (about 30 Hz at any fps) from the first frame after t0, with a 2-step miss.
  const step = Math.max(1, Math.round(fps / 30)), k0 = Math.floor(t0 * fps + 1e-9) + 1;
  const frames = (kind === 'partial-b' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13]).map(o => k0 + o * step);
  const observations = frames.map(k => {
    const t = k / fps, p = path(t);
    return { t, x: p.x + 0.2 * Math.sin(k) / width, y: p.y - 0.2 * Math.cos(k) / height, sigma: 0.6 / diag };
  });
  const lastT = observations.at(-1).t, endT = lastT + { tracked: 0.8, 'partial-a': 0.4, 'partial-b': 0 }[kind];
  const fade = { tracked: [endT - 0.25, endT], 'partial-a': [lastT + 0.2, endT], 'partial-b': null }[kind];
  const fixed = [...observations.map(o => o.t), endT], times = [...fixed];
  for (let t = t0 + 1 / PARAMS.display.hz; t < endT; t += 1 / PARAMS.display.hz) if (fixed.every(f => Math.abs(f - t) > 1e-4)) times.push(t);
  times.sort((a, b) => a - b);
  const obsT = observations.map(o => o.t), half = PARAMS.display.observedHalfFrame / fps;
  const points = [{ t: t0, ...path(t0), status: 'anchor' }];
  for (const t of times) {
    if (t - points.at(-1).t <= 1e-9) continue;
    const p = { t, ...path(t), status: curveStatus(t, obsT, half) };
    if (fade && t > fade[0]) p.alpha = Math.max(0, (fade[1] - t) / (fade[1] - fade[0]));
    points.push(p);
  }
  const camera = Array.from({ length: Math.ceil(endT * fps) + 2 }, (_, k) => ({
    t: k / fps, x: 0.002 * Math.sin(k / 9), y: 0.001 * Math.cos(k / 11), s: 1 + 0.001 * Math.sin(k / 13), r: 0.001 * Math.sin(k / 17)
  }));
  const vx = 0.05 * width, vy = -0.9 * height, vn = Math.hypot(vx, vy);
  const end = points.at(-1);
  return {
    points, observations, camera, engine: RESULT_ENGINE, observedFrames: observations.length,
    status: kind === 'tracked' ? 'tracked' : 'partial',
    reasonCodes: { tracked: [], 'partial-a': ['completion_uncertain'], 'partial-b': ['tracking_ended_early'] }[kind],
    confidence: makeConfidence(kind === 'tracked' ? 0.93 : 0.7, { nullMargin: 3.2, rmsNorm: 0.8 }, PARAMS.confidence.calibratedOn),
    launch: { t: t0, ...path(t0), dir: { x: vx / vn, y: vy / vn }, view: 'dtl' },
    completion: kind === 'partial-b' ? null : {
      end: { type: kind === 'tracked' ? 'landing' : 'fade', t: end.t, x: end.x, y: end.y }, observedEnd: 'lost',
      observedSec: lastT - t0, predictedSec: endT - lastT, slowMoFactor: 1
    }
  };
}

const RESULT_KEYS = ['points', 'observations', 'camera', 'engine', 'observedFrames', 'status', 'reasonCodes', 'confidence', 'launch', 'completion', 'diagnostics'];
const KEYS = {
  point: ['t', 'x', 'y', 'status', 'alpha'], observation: ['t', 'x', 'y', 'sigma'], camera: ['t', 'x', 'y', 's', 'r'],
  launch: ['t', 'x', 'y', 'dir', 'view'], completion: ['end', 'observedEnd', 'observedSec', 'predictedSec', 'slowMoFactor'],
  end: ['type', 't', 'x', 'y'], confidence: ['value', 'calibratedOn', 'components']
};

/**
 * Check an HFResult against every contract invariant (protocol doc §9). opts.width/height enable the
 * 1.5σ curve check in px; opts.fps enables the per-point status rule. Returns {ok, errors}.
 * @param {HFResult} r
 * @param {{width?:number, height?:number, fps?:number}} [opts]
 */
export function validateResult(r, opts = {}) {
  const P = PARAMS.result, errs = [], bad = m => errs.push(m);
  if (!isObj(r)) return { ok: false, errors: ['result: not an object'] };
  const keysOnly = (v, allowed, path) => { for (const k of Object.keys(v)) if (!allowed.includes(k)) bad(`${path}.${k}: unknown key`); };
  const inRange = (v, path) => { if (!(Number.isFinite(v) && v >= P.coordRange[0] && v <= P.coordRange[1])) bad(`${path}: ${fmt(v)} outside ${P.coordRange}`); };
  const list = (v, name) => Array.isArray(v) ? v : (bad(`result.${name}: expected an array`), []);
  keysOnly(r, RESULT_KEYS, 'result');
  for (const k of RESULT_KEYS.slice(0, -1)) if (!(k in r)) bad(`result.${k}: missing`);
  if (r.engine !== RESULT_ENGINE) bad(`result.engine: expected '${RESULT_ENGINE}'`);
  const status = r.status;
  if (!STATUSES.includes(status)) bad(`result.status: ${fmt(status)} unknown`);

  for (const m of reasonErrors(status, list(r.reasonCodes, 'reasonCodes'), 'result.reasonCodes')) bad(m);

  const pts = list(r.points, 'points');
  if (pts.length > P.maxPoints) bad(`result.points: more than ${P.maxPoints}`);
  let fadeFrom = -1;
  pts.forEach((p, i) => {
    const path = `result.points[${i}]`;
    if (!isObj(p)) { bad(`${path}: not an object`); return; }
    keysOnly(p, KEYS.point, path);
    if (!Number.isFinite(p.t)) bad(`${path}.t: not finite`);
    inRange(p.x, `${path}.x`); inRange(p.y, `${path}.y`);
    if (!POINT_STATUSES.includes(p.status)) bad(`${path}.status: ${fmt(p.status)} unknown`);
    if (p.alpha !== undefined && !PRIM.frac(p.alpha)) bad(`${path}.alpha: not in [0, 1]`);
    const alpha = p.alpha ?? 1;
    if (fadeFrom < 0 && alpha < 1) fadeFrom = i;
    if (fadeFrom >= 0 && i > fadeFrom && alpha > (pts[i - 1].alpha ?? 1)) bad(`${path}.alpha: the end fade must not increase`);
    if (i) {
      const dt = p.t - pts[i - 1].t;
      if (!(dt > 0)) bad(`${path}.t: not after the previous point`);
      else if (dt > P.maxPointGapSec + 1e-9) bad(`${path}.t: gap ${dt.toFixed(4)} s > ${P.maxPointGapSec.toFixed(4)} s`);
    }
  });

  const obs = list(r.observations, 'observations');
  obs.forEach((o, i) => {
    const path = `result.observations[${i}]`;
    if (!isObj(o)) { bad(`${path}: not an object`); return; }
    keysOnly(o, KEYS.observation, path);
    if (!Number.isFinite(o.t)) bad(`${path}.t: not finite`);
    else if (i && !(o.t > obs[i - 1].t)) bad(`${path}.t: not after the previous observation`);
    inRange(o.x, `${path}.x`); inRange(o.y, `${path}.y`);
    if (!PRIM.pos(o.sigma)) bad(`${path}.sigma: must be > 0`);
  });
  if (r.observedFrames !== obs.length) bad(`result.observedFrames: ${fmt(r.observedFrames)} != observations.length ${obs.length}`);

  const cam = list(r.camera, 'camera'), camMax = Math.max(...P.coordRange.map(Math.abs));
  cam.forEach((c, i) => {
    const path = `result.camera[${i}]`;
    if (!isObj(c)) { bad(`${path}: not an object`); return; }
    keysOnly(c, KEYS.camera, path);
    if (!Number.isFinite(c.t)) bad(`${path}.t: not finite`);
    else if (i && !(c.t > cam[i - 1].t)) bad(`${path}.t: not after the previous sample`);
    if (!(Math.abs(c.x) <= camMax && Math.abs(c.y) <= camMax)) bad(`${path}: translation outside ±${camMax}`);
    if (c.s !== undefined && !(PRIM.pos(c.s) && c.s < 10)) bad(`${path}.s: not a plausible scale`);
    if (c.r !== undefined && !(Math.abs(c.r) <= Math.PI)) bad(`${path}.r: not an angle in radians`);
  });

  const L = r.launch;
  if (L !== null && L !== undefined) {
    if (!isObj(L)) bad('result.launch: expected an object or null');
    else {
      keysOnly(L, KEYS.launch, 'result.launch');
      if (!Number.isFinite(L.t)) bad('result.launch.t: not finite');
      inRange(L.x, 'result.launch.x'); inRange(L.y, 'result.launch.y');
      if (!PRIM.xy(L.dir) || Math.abs(Math.hypot(L.dir.x, L.dir.y) - 1) > 1e-3) bad('result.launch.dir: not a unit vector');
      if (!VIEWS.includes(L.view)) bad(`result.launch.view: ${fmt(L.view)} unknown`);
    }
  }
  const launch = isObj(L) ? L : null;

  const C = r.confidence;
  if (!isObj(C)) bad('result.confidence: expected an object');
  else { keysOnly(C, KEYS.confidence, 'result.confidence'); for (const e of check('Confidence', C, 'result.confidence')) bad(e); }

  const comp = r.completion ?? null;
  if (comp !== null) {
    if (!isObj(comp) || !isObj(comp.end)) bad('result.completion: expected an object with end');
    else {
      keysOnly(comp, KEYS.completion, 'result.completion');
      keysOnly(comp.end, KEYS.end, 'result.completion.end');
      if (!END_TYPES.includes(comp.end.type)) bad(`result.completion.end.type: ${fmt(comp.end.type)} unknown`);
      if (!OBSERVED_ENDS.includes(comp.observedEnd)) bad(`result.completion.observedEnd: ${fmt(comp.observedEnd)} unknown`);
      if (!PRIM.pos(comp.slowMoFactor)) bad('result.completion.slowMoFactor: must be > 0');
      if (!(comp.observedSec >= 0 && comp.predictedSec >= 0)) bad('result.completion: observedSec/predictedSec must be >= 0');
    }
  }

  // Cross-field invariants (FINAL "Decision, confidence, invariants").
  if (status === 'no_reliable_track') {
    if (pts.length) bad('no_reliable_track must have points = []');
    if (obs.length) bad('no_reliable_track must have observations = []');
    if (comp !== null) bad('no_reliable_track must have completion = null');
  } else if (pts.length < 2) bad(`${status} needs a curve of at least 2 points`);
  if (status === 'tracked' && (comp === null || !launch)) bad('tracked needs a launch and a completion');
  if (obs.length && !pts.length) bad('observations without a curve');
  if (obs.length && launch && !(obs[0].t > launch.t)) bad('the first observation must come after launch.t');

  const lastObs = obs.at(-1), predicted = pts.filter(p => p.status === 'predicted');
  if (pts.length) {
    if (!launch) bad('a curve needs a confirmed launch');
    if (!obs.length) bad('a curve needs observations');
    if (!cam.length) bad('a curve needs camera samples');
    if (pts.filter(p => p.status === 'anchor').length !== 1 || pts[0]?.status !== 'anchor') bad('the first point, and only it, must be the anchor');
    if (launch && pts[0] && (Math.abs(pts[0].t - launch.t) > P.sampleTolSec || Math.abs(pts[0].x - launch.x) > P.posTol || Math.abs(pts[0].y - launch.y) > P.posTol)) {
      bad('the anchor must sit at launch t, x, y');
    }
    const firstPred = pts.findIndex(p => p.status === 'predicted');
    if (firstPred >= 0 && pts.slice(firstPred).some(p => p.status !== 'predicted')) bad('predicted points must form the tail');
    if (lastObs) {
      for (const p of pts.slice(1)) {
        const after = p.t > lastObs.t + P.sampleTolSec;
        if (after !== (p.status === 'predicted')) { bad(`point at t=${p.t}: '${p.status}' but ${after ? 'after' : 'not after'} the last observation`); break; }
      }
      if (!(pts.at(-1).t >= lastObs.t - P.sampleTolSec)) bad('the curve must reach the last observation');
      if (comp === null && Math.abs(pts.at(-1).t - lastObs.t) > P.sampleTolSec) bad('without a completion the curve ends at the last observation');
    }
    // Every observation has an 'observed' curve sample at its time, within 1.5σ when the frame size is known.
    const diag = opts.width && opts.height ? Math.hypot(opts.width, opts.height) : 0;
    for (let i = 0, j = 0; i < obs.length; i++) {
      const o = obs[i];
      while (j < pts.length && pts[j].t < o.t - P.sampleTolSec) j++;
      const p = pts[j];
      if (!p || Math.abs(p.t - o.t) > P.sampleTolSec) { bad(`observation ${i}: no curve sample at t=${o.t}`); continue; }
      if (p.status !== 'observed') bad(`observation ${i}: its curve sample is '${p.status}'`);
      if (diag) {
        const dPx = Math.hypot((p.x - o.x) * opts.width, (p.y - o.y) * opts.height), lim = PARAMS.display.withinSigma * o.sigma * diag + P.sigmaSlackPx;
        if (!(dPx <= lim)) bad(`observation ${i}: curve ${dPx.toFixed(3)} px away, limit ${lim.toFixed(3)} px (${PARAMS.display.withinSigma}σ)`);
      }
    }
    if (opts.fps && obs.length) {
      const times = obs.map(o => o.t), half = PARAMS.display.observedHalfFrame / opts.fps;
      for (let i = 1; i < pts.length; i++) {
        const want = curveStatus(pts[i].t, times, half);
        if (pts[i].status !== want) { bad(`point ${i} at t=${pts[i].t}: '${pts[i].status}', rule says '${want}'`); break; }
      }
    }
  }
  if (predicted.length && comp === null) bad('predicted points need a completion');
  if (comp !== null && isObj(comp?.end)) {
    // Arc completion only after a confirmed launch AND flight-confirmed identity (FINAL, D3 §6 R2).
    if (!launch) bad('completion needs a confirmed launch');
    const D = PARAMS.decide, tau = comp.slowMoFactor;
    const span = obs.length ? (lastObs.t - obs[0].t) / tau : 0;
    const confirmed = (obs.length >= D.r2MinObs && span >= D.r2MinRealSec - 1e-9) || comp.observedEnd === 'frame_exit';
    if (!confirmed) bad(`completion needs flight-confirmed identity: ${obs.length} observations over ${span.toFixed(3)} s real, observedEnd '${comp.observedEnd}'`);
    const last = pts.at(-1);
    if (last && (Math.abs(comp.end.t - last.t) > P.sampleTolSec || Math.abs(comp.end.x - last.x) > P.posTol || Math.abs(comp.end.y - last.y) > P.posTol)) {
      bad('completion.end must be the last curve point');
    }
    if (launch && lastObs && PRIM.pos(tau)) {
      if (Math.abs(comp.observedSec - (lastObs.t - launch.t) / tau) > P.timeTolSec) bad('completion.observedSec != (last observation t − launch.t)/τ');
      if (Math.abs(comp.predictedSec - (comp.end.t - lastObs.t) / tau) > P.timeTolSec) bad('completion.predictedSec != (end.t − last observation t)/τ');
    }
    if (comp.end.type === 'fade' && last && !((last.alpha ?? 1) < 1)) bad("a 'fade' end must fade the last point");
  }
  noFunctions(r, 'result', bad, new Set(), 0);
  return { ok: errs.length === 0, errors: errs };
}

/** validateResult that throws HFError 'internal' with every message. */
export function assertResult(r, opts) {
  const { ok, errors } = validateResult(r, opts);
  if (!ok) throw new HFError('internal', `invalid hf result: ${errors.join('; ')}`);
  return r;
}

// Results cross the worker boundary by structured clone: no functions (a FlightFit in diagnostics would fail).
function noFunctions(v, path, bad, seen, depth) {
  if (typeof v === 'function' || typeof v === 'symbol') { bad(`${path}: ${typeof v} is not structured-cloneable`); return; }
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
  if (seen.has(v)) { bad(`${path}: circular reference`); return; }
  if (depth > 12) return;
  seen.add(v);
  if (Array.isArray(v)) v.forEach((x, i) => noFunctions(x, `${path}[${i}]`, bad, seen, depth + 1));
  else for (const [k, x] of Object.entries(v)) noFunctions(x, `${path}.${k}`, bad, seen, depth + 1);
  seen.delete(v);
}
