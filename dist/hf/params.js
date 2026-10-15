/**
 * hf engine thresholds: one frozen object, grouped by unit. Nothing in dist/hf hard-codes a threshold.
 *
 * Units used in the comments:
 *   d0      address-ball diameter in native px (D2's r_A is d0/2; D2 radii are converted to d0 here)
 *   d       expected ball diameter at that time, native px;  r = d/2
 *   px      native display px (upright, full resolution);  coarse px = pixels of the pooled coarse image
 *   frames  container frames (= capture frames for slow motion);  frame interval Δ = 1/fps
 *   sec     video seconds (the clip's own clock);  realSec = real seconds = sec / tau
 *   z       noise-normalized score;  frac = fraction 0..1;  diag = frame diagonal in px
 *   deg     degrees; angles are measured with y UP (counter-clockwise from +x) unless noted
 * A duration written {frames, sec} or {frames, realSec} means max(frames, seconds): see spanFrames().
 * Sources: D1/D2/D3 = /tmp/flightline-understand/design/D?.md section; FINAL = FINAL.md section;
 * "this doc" = value chosen in docs/TRACKING_HF_PROTOCOL.md (tune on the tune split only).
 */

export const PARAMS_VERSION = 'hf-params-1';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const PARAMS = deepFreeze({
  // U1 decode (dist/hf/decode/*)
  decode: {
    maxDecodeQueue: 8,          // VideoDecoder.decodeQueueSize cap (chunks); D2 §2.3
    maxOpenFrames: 3,           // live VideoFrames at once (frames); D2 §2.3
    vfrRatio: 1.1,              // VFR when p95/p5 of frame intervals exceeds this (ratio); D3 §7
    rvfcWaitMs: 250,            // element path: max wait for the presented frame after a seek (ms); D3 §7
    seekTimeoutMs: 15000,       // element path: seek timeout (ms); v2 app.js seek()
    dupNudgeFrac: 0.25,         // element path: a repeated mediaTime gets one re-seek nudged by this × Δ (frac of Δ); D2 §2.3
    elementCredit: 2,           // element path: frames the main thread may stream ahead of acks (frames); this doc §7
    limitedRange: [16, 235],    // limited-range luma black/white levels, expanded to 0..255 (8-bit levels); FINAL decode
    tenBitShift: 2,             // 10-bit planes shift right by 2 to 8 bits (bits); FINAL decode
    fallbackFps: 30             // fps when nothing can be measured (frames/s); phase-1 probeSourceFps
  },

  // U2 camera motion, coarse scan, spots (camera-motion.js, coarse-scan.js, spots.js)
  scan: {
    longEdge: 960,              // coarse long edge target; pool = max(1, round(longSide/longEdge)) (coarse px); FINAL pipeline
    maxRateHz: 60,              // analyze every frame up to this rate, stride = round(fps/60) above it (frames/s); FINAL pipeline
    camera: {
      pyramidLevels: 3,         // levels incl. full coarse res; the top is 1/4 res (count); D3 §4.3
      coarseSearchPx: 6,        // SAD search radius at the 1/4-res level (px of that level); D3 §4.3
      patches: 48,              // textured patches per frame (count); D3 §4.3
      patchPx: 16,              // patch side (coarse px); this doc (D2 used 32 px at 720p)
      patchSearchPx: 3,         // per-patch refinement radius with parabolic sub-pixel fit (coarse px); D3 §4.3
      tukeyC: 4.685,            // IRLS Tukey constant (MAD-scaled residual sigmas); D3 §4.3
      irlsIters: 5,             // IRLS iterations (count); this doc
      minInlierRatio: 0.5,      // a frame's motion is usable at this inlier ratio or more (frac); D3 §4.3, §6 R4
      maxBadFrac: 0.2,          // camera_motion_uncompensated when more of the flight window is below minInlierRatio (frac); D3 §4.3
      largePanFrac: 0.15        // pans beyond this fraction of W or H are flagged in diagnostics (frac); D2 §4.7
    },
    speck: {
      maxRawMovePx: 0.5,        // lens-fixed speck: raw-image drift at most this (coarse px) ...; D3 §4.3
      minCameraMovePx: 3,       // ... while the camera moved at least this (coarse px); D3 §4.3 (values: this doc)
      minFrames: 8              // seen in at least this many analyzed frames (frames); this doc
    },
    candidates: {
      dogRadii: [[1, 4], [2, 7]], // box-DoG inner/outer radii (coarse px); D3 §3.2
      dogRadiiLarge: [4, 12],   // extra scale when the largest stationary blob exceeds largeBlobPx (coarse px); D3 §3.2
      largeBlobPx: 12,          // (coarse px); D3 §3.2
      zMin: 5,                  // |DoG| / MAD of DoG in the tile (z); D3 §3.2
      tilePx: 60,               // MAD tile side (coarse px); D3 §3.2
      maxPerTile: 6,            // candidates kept per tile, so a bright shirt cannot take every slot (count); D3 §3.2
      maxPerFrame: 256          // candidates kept per analyzed frame (count); D3 §2.3 had 48. A night range (floodlights, hundreds of balls on the grass) holds 460-550 blobs a frame: at 192 the address ball dropped out of 14 of its 24 backswing frames; listing them all (640) added faint static blobs the flight tracker then mistook the ball for
    },
    spot: {
      matchD: 0.35,             // link radius (spot diameters); D3 §3.2
      lumaTol: 0.15,            // link luma tolerance (frac); D3 §3.2
      maxGapFrames: 2,          // link gap (analyzed frames); D3 §3.2
      maxEigRatio: 1.8,         // ball-like: second-moment eigenvalue ratio at most (ratio); D3 §3.2 ...
      maxEigRatioBright: 2.3,   // ... for a bright spot: a white ball lit from above (floodlights) shows its lit half, a half disc reads 1.89 and real night balls 1.9-2.25; a dark spot (a resting club head) keeps maxEigRatio (ratio)
      minFill: 0.55,            // ball-like: fill at least (frac); D3 §3.2
      darkMinZ: 6,              // ball-like: negative polarity needs |contrast| at least this (z); D3 §3.2
      minDiamCoarsePx: 2.5,     // ball-like: diameter at least (coarse px); D3 §3.2
      maxDiamFracShort: 0.08,   // ball-like: diameter at most this × short side (frac); D3 §3.2
      yPriorFrac: 0.3,          // soft prior, not a gate: y >= this × H scores higher (frac of H); D3 §3.2
      minPresence: 0.8,         // eligible: present in at least this fraction of frames ... (frac); D3 §3.2
      minDwell: { frames: 8, sec: 0.25 }, // ... over at least max(8 frames, 0.25 s); D3 §3.2
      maxPositionSigmaD0: 0.15, // stationary: position sigma at most (d0); D3 §7
      clusterD: 4,              // address cluster radius for R1 (spot diameters); D1 §3.3(4)
      arrivalBandD: [0.5, 4],   // arrival veto: a mover at this distance band (spot diameters) ...; D1 §3.2
      arrivalFrames: 3          // ... within this many frames before the spot first appears (frames); D1 §3.2
    },
    vacate: {
      skipFrames: 2,            // k_last+1 and k_last+2 are excluded from the tests (frames); D3 §3.3(1)
      absence: { frames: 8, sec: 0.3 }, // persistence window Q after the skip; D3 §3.3(1)
      minAbsence: 0.9,          // absence ratio over Q at least (frac); D3 §3.3(1)
      patchD0: 2,               // NCC change box side (d0); D3 §3.3(2)
      preFrames: [-6, -1],      // pre-vacate mean over these frames relative to k_last (frames); D3 §3.3(2)
      postFrames: [4, 10],      // post-vacate mean over these frames relative to k_last (frames); D3 §3.3(2)
      maxNcc: 0.6,              // pre/post patch NCC at most (NCC); D3 §3.3(2)
      minPostStableNcc: 0.8,    // post patch frame-to-frame NCC at least: the spot became tee/grass/mat (NCC); D3 §3.3(2)
      impulse: {
        minStep1D0: 0.5,        // first step s1 >= max(0.5·d0, ...) (d0/frame); D3 §3.3(3)
        minStep1VsStep2: 0.6,   // ... and s1 >= 0.6·s2 (ratio); D3 §3.3(3)
        growth: 1.25,           // s_{j+1} <= 1.25·s_j + growthSlackD0·d0 (ratio); D3 §3.3(3)
        growthSlackD0: 0.3      // (d0/frame); D3 §3.3(3)
      },
      gradual: {
        startD0: 0.5,           // veto: a track starting within 0.5·d0 of the address ... (d0); D3 §3.3(3)
        windowFrames: 3,        // ... in [k_last, k_last+3] ... (frames); D3 §3.3(3)
        maxStep1D0: 0.5         // ... with s1 < 0.5·d0 and growing steps vetoes the vacate (d0/frame); D3 §3.3(3)
      },
      recover: { frames: 18, sec: 0.6 }, // occlusion: presence recovers within this window -> no event (time-limited); D2 §3.2, FINAL launch
      recoverPresence: 0.7      // recovered when normalized presence reaches this (frac); D2 §3.2
    },
    energy: {
      cellPx: 4,                // energy map cell (coarse px); this doc (D3 §2.3 stores low-res energy maps)
      diffMin: 10,              // a pixel counts when |Δluma| exceeds this (8-bit levels); D1 §3.3(2)
      smallDisk: { d0: 3, fracH: 0.02 }, // small disk radius max(3·d0, 0.02·H) (d0, frac of H); D1 §3.3(2)
      largeDisk: { d0: 4, fracH: 0.06 }, // large disk radius max(4·d0, 0.06·H) (d0, frac of H); D1 §3.3(2)
      runVsMedian: 25,          // run: E > max(25·median, ...) (ratio); D1 §3.3(2)
      runVsMax: 0.05,           // ... 0.05·max) (ratio); D1 §3.3(2)
      strongVsMedian: 50,       // strong run peak >= max(50·median, ...) (ratio); D1 §3.3(2)
      strongVsMax: 0.1,         // ... 0.1·max) (ratio); D1 §3.3(2)
      timingFrames: 1           // soft impact-timing support: vacate within ±1 frame of a strong small-disk run (frames); D1 §3.3(3a)
    },
    horizon: {
      maxTiltDeg: 8,            // only near-horizontal lines qualify (deg); D3 §5.1 (value: this doc)
      minConf: 0.6              // report a horizon only at or above this confidence (frac); this doc
    },
    movers: {
      minFrames: 5,             // pre-impact constant-velocity tracklet length (frames); D1 §4.3
      minSpeedPx: 3,            // ... speed at least (coarse px/frame); D1 §4.3
      skyMinFrames: 15          // long straight slow sky track length for a distractor mask (frames); D3 §4.5(5) (value: this doc)
    }
  },

  // U3 impact hypotheses (impact.js)
  impact: {
    maxHypotheses: 8,           // kept, ranked by vacate quality, never by size (count); D3 §3.3(6) had 4, which co-timed vacates of a camera/zoom step on real exports filled before the ball
    r1Window: { frames: 30, realSec: 1.5 }, // R1 last-to-leave applies only to vacates this close in one cluster (use the τ prior); D1 §3.3(4), FINAL launch (time-limited)
    r1MinGap: { frames: 0, sec: 0.3 }, // R1: the later vacate must come at least this much later; D1 §3.3(4)
    intervalPadFrames: 0.25,    // impact interval [t(k_last − tol) − 0.25Δ, t(k_firstAbsent + tol) + 0.25Δ] (frames); D1 §3.4
    timingTolFrames: 2,         // tol: the coarse scan's k_last is off by up to 2 frames (club hides the ball before impact, covers the address after) (frames); E2 fix of checker gap 6
    clubPassage: {
      annulusD0: [0.6, 8],      // energy annulus around the address (d0); D3 §3.3(4)
      peakFrames: [-3, 2],      // peak must fall in [k_last−3, k_last+2] (frames); D3 §3.3(4)
      baselineSec: 1,           // baseline = median over the previous second (sec); D3 §3.3(4)
      supportRatio: 4           // swing support when peak/baseline >= 4 (ratio); D2 §3.2
    },
    envelope: {
      preSec: 1.5,              // swing envelope = motion over [t_v − 1.5 s, ...] (sec); D2 §6
      postSec: 0.1,             // ... t_v + 0.1 s] (sec); D2 §6 used 0.5 s, which on a real down-the-line clip took in the ball's own flight and vetoed it as club motion; 0.1 s keeps the club's sweep through the address
      dilateD0: 1,              // dilated by 2·r_A (d0); D2 §6
      conicScale: 1.15          // club-arc conic bound scale when the club is measured on both sides (ratio); D2 §6
    },
    tau: {
      modes: [1, 2, 4, 8],      // slow-motion factor candidates (video s per real s); D3 §5.1
      captureFps: [30, 60, 120, 240], // capture rates for the step medians below (frames/s); D3 §3.5
      stepMediansDtlD0: [11.8, 8.3, 5.0, 2.8], // first-step medians, down-the-line (d0/frame); D3 §3.5 (E6)
      stepMediansFoD0: [48.8, 24.9, 12.5, 6.3] // first-step medians, face-on (d0/frame); D3 §3.5 (E6)
    }
  },

  // U3 launch confirmation (emergence.js, club.js, launch-null.js)
  launch: {
    window: { preSec: 0.25, postSec: 0.5 }, // native confirmation window around t0 (sec); FINAL pipeline
    roiD0Px: 8,                 // processing pool chosen so d0 is about 8 px, pool >= 1 (px); D3 §3.4
    emergence: {
      maxFrames: 12,            // K_e = min(12, frames until s > 0.4·diag) (frames); D3 §3.4
      maxReachDiag: 0.4,        // (frac of diag); D3 §3.4
      reachD0PerFrame: 70,      // search radius s <= (k − k_last + 1)·70·d0 (d0/frame); D3 §3.4 (E6 p95 58)
      excludeD0: 0.6,           // ignore points within 0.6·d0 of the address from k_last+3 on (d0); D3 §3.4
      minStepD0: 0.5,           // chain steps after the first at least (d0/frame); D3 §3.4
      wedgeDeg: 3,              // new points within ±max(3°, atan(0.6·d0/s)) of the line (deg); D3 §3.4
      wedgeD0: 0.6,             // (d0); D3 §3.4
      maxGapFrames: 2,          // chain gaps (frames); D3 §3.4
      keepChains: 8,            // (count); D3 §3.4
      maxCandidatesPerFrame: 10 // (count); D3 §3.4
    },
    law: {                      // projective-line law s(τ)=vτ/(1+cτ), width D0/(1+cτ), ONE shared c; D1 §3.5, FINAL launch
      bandPx: 2.5,              // straight: max ⟂ residual <= max(2.5 px, 0.35·D0) + 0.04·L (px); D1 §3.5
      bandD0: 0.35,             // (d0); D1 §3.5
      bandSlope: 0.04,          // (frac of the distance L along the band); D1 §3.5
      maxMeanLogWidth: Math.log(1.6), // size law: mean |ln(w(1+cτ)/D0)| at most (nats); D1 §3.5
      startWidthD0: [0.6, 2.2], // start: w1 within this band (d0); D1 §3.5
      maxStartShrink: 1.6,      // start: 1 + c·τ1 at most (ratio); D1 §3.5
      rmsPx: 1.5,               // n >= 3: RMS <= max(1.5 px, 0.05·L) (px); D1 §3.5
      rmsFrac: 0.05,            // (frac of chain length L); D1 §3.5
      maxSpeedRatio: 1.25,      // consecutive speed ratio at most (ratio); D1 §3.5
      maxBallSpeedMps: 80,      // c <= 80 m/s / Z0 (m/s real); D1 §3.5
      t0Frames: [-0.5, 1.5]     // t0 within [k_last − 0.5, k_last + 1.5] (frames); D3 §3.4 f3
    },
    gates: {                    // hard gates, applied before any learned density; D3 §3.4
      straightnessD: 0.35,      // f1: RMS ⟂ residual to the line through the address when m >= 3 (mean expected d)
      profileD0: 0.5,           // f2: RMS of the projective profile when m >= 3 (d0)
      minBetaPerFrame: -0.05,   // f2: β >= −0.05 (1/frame)
      widthRatio: 1.35,         // f5: ⟂ width <= 1.35·d_exp + widthSlackPx (ratio)
      widthSlackPx: 1,          // (px)
      fluxRange: [0.3, 6],      // f6 soft: flux / address flux × (d0/d)² (ratio); D3 had 1.6, but the lighting changes along the path: a ball leaving a covered bay into a floodlit range read 2.1-5.0 on real night clips
      streakAxisDeg: 4,         // f7 soft: streak axis within max(4°, atan(2/len)) of the chain line (deg)
      streakMinAspect: 2,       // f7 applies when length/width >= 2 (ratio)
      llrClampNats: 3           // learned LLR terms clamp; the LLR is a DIAGNOSTIC only, never a gate (nats); D3 §3.4, FINAL launch
    },
    samples: {
      minInFrame: 4,            // m >= 4 when the chain stays in frame 4 frames (count); D3 §3.4
      minExit: 2                // m >= 2 on a frame exit, with f4/f5/f7 passing (count); D3 §3.4
    },
    singleSample: {             // single-sample launches: OFF by default; FINAL launch
      enabled: false,
      minZ: 7,                  // (z); D2 §3.3
      clubRatio: [1.1, 2.2],    // d_ball/d_club in the same frame (ratio); D2 §3.3, FINAL launch
      loftConeDeg: [-12, 60],   // ball direction vs the club's impact direction, toward image-up (deg); D2 §3.3
      maxHoldoutClubAccept: 0.01 // enable only if holdout club acceptance for single samples is at most this (frac); FINAL launch
    },
    evidence: {                 // D2 §3.3 reference and ball evidence
      refFrames: 5,             // B_ref = per-pixel median of 5 frames ... (count)
      refSec: [-0.45, -0.15],   // ... spread over [t_v − 0.45 s, t_v − 0.15 s] (sec)
      holeD0: 1.5,              // address hole disc radius zeroed for j >= 1 (d0; D2: 3·r_A)
      dogSigmaD0: [0.4, 0.2],   // DoG sigmas at processing scale (d0; D2: 0.8 r_A, 0.4 r_A)
      minSigmaPx: 0.8,          // (processing px)
      cfarInner: [2, 1],        // local CFAR annulus inner radius 2σ + 1 (σ multiples, px)
      cfarOuter: [6, 3],        // outer radius 6σ + 3 (σ multiples, px)
      maxPeaks: 14,             // peaks per frame (count)
      minPeakZ: 3.5,            // (z)
      nmsD0: 1,                 // NMS radius (d0; D2: 2·r_A)
      post: { frames: 6, sec: 0.2, maxFrames: 16 }, // K_L = clamp(0.2 s·fps, 6, 16) post-impact frames
      preFrames: 4,             // pre-impact frames searched (frames)
      emptyAddress: { frames: 9, sec: 0.3 } // the address must stay empty this long; D2 §6
    },
    support: {                  // D2 §3.3 hypothesis support and score
      tolPx: 1.5,               // support within 1.5 px + 0.3·d0 + 0.03·distance (px)
      tolD0: 0.3,               // (d0; D2: 0.6·r_A)
      tolDist: 0.03,            // (frac of distance from the address)
      smallRatio: 0.6,          // if r(τ) < 0.6·r_A then z_big <= 1.25·z_small (ratio)
      smallZ: 1.25,             // (ratio)
      bigRatio: 0.85,           // if r(τ) > 0.85·r_A then z_small <= 1.6·z_big (ratio)
      bigZ: 1.6,                // (ratio)
      noveltyStepD: 1.25,       // novel: predicted step >= 1.25·d(τ) requires z_{j−1} <= 0.5·z_j (d; D2: 2.5·r)
      noveltyZ: 0.5,            // (ratio)
      zCap: 8,                  // S = Σ w·(min(z, 8) − 2) ... (z)
      zOffset: 2,               // (z)
      missWeight: 0.5,          // ... + Σ_unsupported (0.5·min(0, z_pred − 2) − 0.5) (ratio)
      missCost: 0.5,            // (score units)
      envelopeWeight: 0.35,     // w inside the pre-impact swing envelope (ratio)
      minScore: 3,              // reject S < 3 (score units)
      precursorFrac: 0.5        // reject: backward constant-velocity evidence > 0.5·max(1, S) (ratio)
    },
    club: {                     // D2 §3.3 club chain, FINAL launch
      sigmaD0: 0.8,             // club evidence DoG σ on |Y_j − Y_{j−1}| (d0; D2: 1.6·r_A)
      peaks: 8,                 // club peaks per frame (count)
      phases: [0.15, 0.4, 0.65, 0.9], // impact phase grid (frac of the frame interval)
      arrivalRatio: [0.55, 1.8], // (|p_A − c_0|/φ) / |c_0 − c_{−1}| (ratio)
      minCos: 0.5,              // heading turn cos at least (cos)
      minStepD0: 1,             // club step at least (d0; D2: 2·r_A)
      prevRatio: [0.4, 1.6],    // optional c_{−2} step ratio (ratio)
      prevMinCos: 0.4,          // (cos)
      exitSpeedFrac: 0.75,      // forward tracker starts at 0.75 × impact velocity (frac)
      damp: 0.92,               // per-frame speed damping (frac)
      snapD0: 2.5,              // snap to a club peak within max(2.5·d0, 0.5·|v|) (d0; D2: 5·r_A)
      snapSpeedFrac: 0.5,       // (frac of |v|)
      extentD0: 0.85,           // club-explained extent 0.85·d0 + 1.5 px (+0.06·distance if unmeasured) (d0; D2: 1.7·r_A)
      extentPx: 1.5,            // (px)
      extentUnmeasured: 0.06,   // (frac of distance)
      outrunRatio: 1.1,         // within outrunMaxDeg of the club direction, the ball's first support is >= 1.1 × club distance (ratio)
      outrunMaxDeg: 30,         // (deg)
      recede: { minCPerSec: 9, minSamples: 4, clearD0: 3, loneCPerSec: 6, loneSamples: 5 }, // a chain receding from the camera (law c·fps >= minCPerSec: down the line its image distance understates its lead over a head sweeping across the image) skips outrun with >= minSamples, each >= clearD0·d0 from the measured head (real DTL clip: ball 70 px out vs head 256 px, 15 d0 apart). The lone-ball case: the head's exit seed lies on the chain and the chain has >= loneSamples on a law with c·fps >= loneCPerSec, so no club rule applies (real night clips: the unseen dark head's 'exit' was the ball streak)
      leadRatio: [1.1, 2.2],    // expected ball/club distance ratio after impact (ratio); FINAL launch
      preMoverZ: 0.6,           // pre-existing mover: z >= 0.6·z_first ... (ratio)
      preMoverD0: 1,            // ... within max(1·d0, 1.5·step) one frame before (d0; D2: 2·r_A)
      preMoverStep: 1.5,        // (steps)
      impactTolFrames: 1.5,     // with the head tracked, the ball's t0 lies within ±1.5 frames of its arrival at the address (frames); E2 fix of checker gap 6
      faceOnHeadD0: [1.1, 1.4]  // face-on club-head height, why width alone cannot reject it (d0, informational); FINAL launch
    },
    streak: {                   // ray transform for faint or long-exposure launches; D3 §3.4
      thetaStepDeg: 0.5,        // (deg)
      coneDeg: [-25, 205],      // launch cone, y up (deg)
      sStepD0: 0.5,             // radial step (d0)
      stripD0: 1                // strip width across the ray (d0)
    },
    nulls: {                    // null launches; FINAL launch (D2 §3.3)
      anchorOffsetW: 0.22,      // fake anchors at ±0.22·W at address height (frac of W)
      fakeImpactFrames: [12, 20], // fake impact times this many frames earlier (frames)
      factor: 1.15,             // accept only if S >= 1.15·max(S_null) + 1 (ratio)
      offset: 1                 // (score units)
    }
  },

  // U4 ROI detection (roi-detect.js)
  roi: {
    halfSize: { sigmas: 3, d: 1.5, padPx: 4, minPx: 12, maxPx: 192 }, // h = clamp(3·√λmax(Σ) + 1.5·d + J·|v|·m + 4, 12, 192) (px); D3 §4.1
    poolD: 6,                   // processing pool = max(1, round(d/6)) so the ball spans about 6 px (px); D3 §4.1
    bgLagRadii: 2.5,            // two-sided background lag L = ceil(2.5·r/|v|) (radii); FINAL tracking, D2 §4.3
    bgLagMax: 8,                // L above this uses the spatial background (frames); D2 §4.3
    spatialSigmaR: 4,           // spatial background Gaussian σ = 4·r + 2 px (radii) ...; D2 §4.3
    spatialSigmaPx: 2,          // (px)
    mfSigmaD: 0.35,             // matched filter σ = max(0.7 px, 0.35·d) (d); D3 §4.2(2)
    mfMinSigmaPx: 0.7,          // (px)
    tbd: {
      J: 3,                     // centred window 2J+1 = 7 frames (frames); D3 §4.2(3), FINAL tracking
      fastJ: 2,                 // J when |v| > fastPx (frames); D3 §4.2(3)
      fastPx: 6,                // (px/frame)
      grid: 3,                  // velocity grid 3×3 ... (count); D3 §4.2(3)
      wideGrid: 5,              // ... 5×5 when σ_v is large (count)
      spacing: 0.4              // grid spacing 0.4·m (px/frame per stride); D3 §4.2(3)
    },
    decoyOffsetH: 4,            // two decoy ROIs offset ⟂ to the path by 4·h (ROI half-sizes); D3 §4.2(4)
    nullQuantile: 0.995,        // T = max(T_min(N), q_0.995(null history)) (quantile); D3 §4.2(4)
    nullAlpha: 0.01,            // T_min: Gaussian tail at per-frame family-wise α over N tests (frac); D3 §4.2(4) (E3: 1% false alarms)
    nullHistory: [20, 300],     // decoy samples needed before the quantile is used / kept at most (count); this doc
    minPeakZ: 2,                // single-frame z at the TBD peak at least (z); D3 §4.2(5)
    polarityFlipLevels: 25,     // a polarity flip is allowed when the ROI background mean changed by more than this (8-bit levels); D3 §4.2(5)
    oppositePolarityZ: 0.5,     // opposite polarity costs this z penalty (z); D2 §4.3
    maxSizeD: 3,                // size <= 3·max(d, 1.5 px) ... (d); D3 §4.2(5)
    groundSizeD: 2,             // ... 2·max(d, 1.5 px) over textured ground (d); D3 §4.3
    minSizePx: 1.5,             // (px)
    registerPx: 1.5,            // local SAD registration refinement radius, parabolic sub-pixel (px); D3 §4.1
    zmapHalf: 20,               // cached z-map half-size: 41×41 while tracking (map px); D2 §4.3
    zmapHalfCoast: 40,          // 81×81 while coasting (map px); D2 §4.3
    zmapScale: 8,               // cached as round(8·z) clamped to Int8 (levels per z); D2 §4.3
    reacquireExtraZ: 1.5,       // re-acquisition needs the threshold + 1.5 (z); D2 §4.5
    maxDetectWork: 6e6,         // hard cap on one detect call's TBD samples (positions × velocities × frames, decoy tiles included): the wide grid, then the search radius shrink (count); check gap 1
    noise: { tilePx: 16, outlierRatio: 36, minLiveTiles: 3 } // z noise: tiles of 16 map px; a tile whose mean square is > 36× the median live tile (RMS 6×: golfer, club; sky codec noise reaches 17× at 2 Mbps) keeps its own σ; needs >= 3 live tiles (map px, ratio, count); check gap 3
  },

  // U6 flight tracker (flight-tracker.js)
  track: {
    launchProfileObs: 6,        // predict with the launch law for the first 6 inliers (count); D3 §4.1
    refitEveryObs: 10,          // warm M3D refit every 10 observations ... (count); D3 §4.1
    refitChi2: 9,               // ... or after refitChi2Count innovations with χ² > 9 (χ²); D3 §4.1
    refitChi2Count: 2,          // (count)
    gateChi2: 13.8,             // association gate, χ² with 2 dof at 0.999 (χ²); D3 §4.5(1), D2 §4.2
    lost: { frames: 8, realSec: 0.25 }, // lost after this many unmasked misses; D3 §4.4
    search: { realSec: 0.6, flightFrac: 0.25 }, // keep searching until max(0.6 s real, 0.25 × elapsed flight); D3 §4.4
    reacquire: [3, 5],          // re-acquire on 3 of 5 consistent detections (count of count); D3 §4.4, FINAL tracking
    exitSigmas: 2,              // stop when the prediction ±2σ leaves the frame (σ); D3 §4.4
    stride: { px: 1, max: 8, fullRealSec: 0.1 }, // m = clamp(floor(1 px/|v|), 1, 8); m = 1 for the first 0.1 s real; D3 §4.4
    landingTailRealSec: 0.3,    // stop at the model landing + 0.3 s real (realSec); D3 §4.4
    maxBranches: 4,             // MHT branches per launch (count); D3 §4.5(4)
    resolveFrames: 5,           // resolve branches after this many frames by fit residual (frames); D3 §4.5(4)
    spawnRatio: 1.5,            // spawn a child when two peaks score within this ratio (ratio); D2 §4.5
    maxSpawnPerFrame: 2,        // (count); D2 §4.5
    quotaPerLaunch: 4,          // reserved hypotheses per launch, so a later true launch survives earlier wrong ones (count); D1 §4.3, FINAL tracking
    moverD: 1.5,                // detections within 1.5·d of a known mover are 'ambiguous' ... (d); D3 §4.5(5)
    moverVelSigmas: 3,          // ... unless the TBD velocity differs by > 3σ (σ); D3 §4.5(5)
    staticPx: 1.5,              // static: same stabilized position within this (coarse px) ...; D1 §4.3
    staticHits: 8,              // ... in >= 8 ... (count)
    staticWindowFrames: 30,     // ... of ±30 frames (frames)
    changePoint: { minIndex: 8, before: 10, after: 8, minPx: 1, headFactor: 2.5, base: 0.35, stepFrac: 0.03 }, // quadratic change-point trim; D1 §4.3
    outlierSigmas: 4,           // robust-fit residual > 4σ -> 'rejected' (σ); D3 §4.5(6)
    trailingRejects: 3,         // a terminal run of >= 3 rejects truncates the observed segment (count); D2 §5.2
    trend: { minObs: 4, sigmas: 2 }, // residual-trend steal test: >= 4 trailing same-signed residuals, mean beyond 2σ/√N; D2 §4.6
    planeMissFrames: 6,         // the physics-residual test must reject a steal even after this many consecutive misses (frames); FINAL tracking (D1 E5)
    reassocIters: 2,            // Viterbi/EM rounds after each M3D refit (count); D2 §4.9
    viterbiGateChi2: 9,         // Viterbi state gate around the refit (χ²; tighter than gateChi2); D2 §4.9 (value: this doc)
    minPd: 0.05,                // P_d floor in the miss cost −ln(1 − P_d); lost when P_d < 0.05 for W frames (frac); D2 §4.5
    coastMaxSigmaDiag: 0.06     // a branch stops coasting (exited if predicted outside the frame, else lost) once its 1σ major axis passes this × diag; = complete.fadeEndDiag, where the drawn arc is gone (frac of diag); check gap 1
  },

  // U5 flight model and LM (flight-model.js, lm.js)
  fit: {
    ballDiameterM: 0.04267,     // D = 42.67 mm (m); D3 §5.1
    ballMassKg: 0.04593,        // (kg); standard
    airDensity: 1.2,            // (kg/m³); standard
    gravity: 9.81,              // (m/s²)
    fovLongDeg: 69,             // f_nom = (long side/2)/tan(34.5°) (deg); D3 §5.1
    focalSigmaLog: 0.12,        // log-normal σ of f around each mixture component (nats); D3 §5.1
    focalComponents: [1, 0.5, 2], // focal mixture × f_nom: main, ultra-wide 0.5x, tele 2x (ratio); D3 §5.1, D2 §5.1, FINAL trajectory
    focalWeights: [0.75, 0.15, 0.1], // mixture weights (frac); this doc
    k1Prior: [-0.08, 0.05],     // ultra-wide radial distortion k1 ~ N(μ, σ) (unitless); D3 §5.1
    k1Max: 0,                   // ... and k1 <= this: wide lenses are barrel or corrected; a pincushion fit only absorbs correlated detection errors (unitless); check gap 4
    pitchDeg: [8, 12],          // camera pitch ~ N(μ, σ) (deg); D3 §5.1
    rollDeg: [0, 3],            // camera roll ~ N(μ, σ) (deg); D3 §5.1
    horizonPitchSigmaDeg: 2,    // σ_pitch when a horizon is found (deg); D3 §5.1
    horizonRollSigmaDeg: 1,     // σ_roll when a horizon is found (deg); D3 §5.1
    skylineSigmaDeg: 1,         // sky line (Horizon kind 'skyline', or no kind): one-sided bound, σ of a true horizon above it (deg); check gap 4
    cd: [0.25, 0.04],           // drag coefficient ~ N(μ, σ); D3 §5.1
    cl: [0.22, 0.08],           // lift coefficient ~ N(μ, σ); D3 §5.1
    speedMps: [52, 0.35],       // launch speed ~ logN(median m/s, σ log); D3 §5.1
    elevationDeg: [18, 11],     // launch elevation ~ N(μ, σ), no gate (deg); D3 §5.1
    spinTiltDeg: [0, 20],       // spin-axis tilt ~ N(μ, σ), symmetric draws/fades (deg); D2 §5.1
    tauLogSigma: 0.15,          // log τ refinement σ around each τ mode (nats): τ is a capture/playback ratio, off-nominal ones (25/24 fps, 50 fps capture) are <= 0.22 nats away; D3 §5.1 had 0.5, which let aero mismatch move τ 17-25% (check gap τ)
    rampTauLogSigma: 0.5,       // log σ of a speed ramp's second τ around its split-scan start (nats); D3 §5.1
    rk4Hz: 240,                 // RK4 rate (Hz real); D3 §5.1
    rk4EarlyHz: 480,            // ... for the first rk4EarlyRealSec (Hz real); D3 §5.1
    rk4EarlyRealSec: 0.1,       // (realSec)
    gridElevationDeg: [6, 12, 20, 30, 40], // multi-start elevations (deg); D3 §5.2
    gridAzimuthDeg: [0, -20, 20], // azimuth = image direction + these (deg); D3 §5.2
    gridSpeedMps: [35, 50, 65], // (m/s); D3 §5.2
    topStarts: 3,               // best starts by MAP cost sent to LM (count); D3 §5.2
    maxIter: 40,                // LM iterations (count); D3 §5.2
    huberSigmas: 2.5,           // Huber δ (σ); D3 §5.2
    abandonFactor: 3,           // abandon a start whose cost exceeds 3× the best (ratio); D2 §5.2
    outlierSigmas: 4,           // residual > 4σ -> rejected, then one refit (σ); D3 §5.2
    minInlierFrac: 0.7,         // below this, RANSAC re-initialization (frac); D3 §5.2
    ransacFirst: 4,             // first 4 + 4 random observations (count); D3 §5.2
    ransacRandom: 4,            // (count)
    logRadiusSigma: 0.25,       // early size observations as log-radius (nats) ...; D2 §5.1, FINAL trajectory
    minRadiusPx: 1.2,           // ... while the radius is at least this (px); D2 §5.1
    sigmaFloorPx: 0.5,          // added in quadrature to every observation σ: centroid σ omits codec, blur and background error (px); = U6 floorPx, check gap 4
    forwardSplit: 0.75,         // forward validation: fit the first 75%, score the rest (frac); D1 §5.2, FINAL trajectory
    imageHorizonRealSec: 0.25,  // short-horizon image model extent when M3D is ill-conditioned (realSec); D1 §6.1
    rampMinRatio: 1.5,          // speed ramp: τ changes by at least this ratio ... (ratio); FINAL trajectory (value: this doc)
    rampMinObs: 6,              // ... with this many observations per segment (count); this doc
    r2MinInlierFrac: 0.8,       // R2 fit gates: inliers >= 80% ... (frac); D3 §6
    r2MaxRmsNorm: 1.5,          // ... robust data χ²/dof <= 1.5² (Huber, inliers, dof = rows − effective params) ... (σ); D3 §6
    r2Chi2Z: 3.09,              // ... unless that excess is not significant: χ² <= the (1 − 0.001) quantile at the dof (normal z), so 2-3 frame tracks are not rejected by chance (z); check gap R2
    physical: { speedMps: [3, 110], elevationDeg: [-5, 80], cd: [0.03, 0.7], cl: [-0.25, 0.7], spinTiltDeg: [-75, 75] }, // ... and the ball physics plausible: fitted values inside these (inside the LM box, so a value pinned at a bound fails; golf: C_D 0.2-0.5, C_L <= 0.35, 70-90 m/s drives; a launch > 5° down from a 3 cm tee is in the turf within 0.3 m); check gap R2
    r2MaxPriorZ: 3,             // NOT an R2 gate (priors stay soft terms): a prior z above this only marks the fit ill, which sends cold fits to forward validation, and is listed in fit.diagnostics.priorConflict (z); check gap R2
    dtlAzimuthDeg: 45,          // |β| < 45° is down-the-line-like (deg); D3 §3.5
    warmRefitMs: 40             // warm refit budget (ms, laptop); D3 §2.4
  },

  // U5 completion (complete.js)
  complete: {
    fadeStartDiag: 0.03,        // 1σ major axis: alpha starts fading at 3% of diag ... (frac of diag); D3 §5.4
    fadeEndDiag: 0.06,          // ... and reaches 0 at 6% (frac of diag); D3 §5.4
    uncertainBeforeFrac: 0.5,   // fade before 50% of the predicted remainder -> partial + completion_uncertain (frac); D3 §5.4
    landingFadeRealSec: 0.25,   // landing: alpha fades over the last 0.25 s real (realSec); D3 §5.4
    capRealSec: 9,              // cap at t0 + 9 s × τ (realSec); D2 §5.4
    exitMarginD: 1,             // exit once the prediction is this far outside the frame (d); D1 §4.5
    kappa: 0.05                 // predictive σ inflation κ·(t − t_last)·|v_last| (unitless; tune); D2 §5.4
  },

  // U5 display curve (display-curve.js)
  display: {
    hz: 120,                    // dense curve rate (samples per video second); FINAL display
    withinSigma: 1.5,           // every inlier observation lies within 1.5σ of the curve (σ); FINAL display
    maxResidualD: 1.5,          // residual spline |ρ| <= 1.5·mean expected d (d); D3 §5.3
    decay: { frames: 6, realSec: 0.15 }, // after the last observation ρ decays over max(6 frames, 0.15 s real), b(u) = 1 − 3u² + 2u³; D2 §5.3
    observedHalfFrame: 0.5      // a sample within 0.5 frame interval of an inlier is 'observed' (frames); this doc §8
  },

  // U6 decision (decide.js)
  decide: {
    r2MinObs: 8,                // flight-confirmed identity: >= 8 observations ... (count); FINAL decision
    r2MinRealSec: 0.15,         // ... spanning >= 0.15 s real, or a confirmed frame exit (realSec); FINAL decision
    exitWithinFrames: 2,        // confirmed exit: predicted exit within 2 frames of the last observation (frames); D3 §6 R2
    r3Margin: 0.15,             // best hypothesis beats the next by this confidence margin (frac); D3 §6 R3
    identityMarginNats: 4,      // ... and by this LLR vs the best alternative ... (nats); D2 §6
    identityShareMax: 0.5,      // ... that shares < 50% of its observations (frac); D2 §6
    r4MinInlier: 0.5,           // camera inlier ratio over the flight window (frac); D3 §6 R4
    trackedMinConfidence: 0.85, // R5 for 'tracked' (frac); D3 §6
    partialMinConfidence: 0.6,  // 'partial' (a) (frac); D3 §6
    bulkMinConfidence: 0.9,     // bulk export needs status 'tracked' and value >= 0.9 (frac); FINAL decision
    requireEscape: true         // swing-disc escape (or a frame exit) is part of flight identity (bool); D2 §6, FINAL tracking
  },

  // U6 confidence (confidence.js)
  confidence: {
    calibratedOn: 'synthetic-tune-v1', // label once fitted on the tune split; FINAL decision
    uncalibrated: 'uncalibrated', // label before any fit (string); this doc
    kind: 'logistic',           // 'logistic' or 'isotonic', monotone in the null margin; FINAL decision
    maxParams: 6,               // logistic parameters at most (count); FINAL decision
    labelShapeErrDiag: 0.05,    // training label: identity correct and completion shape error <= 5% of diag (frac); D3 §6
    provisionalFull: 0.98       // provisional model (before the tune fit): p with every input at full evidence; one input at its R-rule gate gives decide.partialMinConfidence (frac); check gap 10
  },

  // U9 pipeline (pipeline.js)
  pipeline: {
    progressMs: 100,            // progress events at most every 100 ms (ms); D3 §2.2
    flightPreSec: 0.25,         // native flight pass starts at t0 − 0.25 s (sec); FINAL pipeline
    maxLaunches: 4,             // launches tracked in the flight pass (count); D3 §3.4
    restartGapSec: 1,           // a pass restarts (seek) instead of decoding through a gap longer than this before the next needed frame (sec); this doc §6
    unverifiedRetries: 2,       // re-reads of a frame its source could not verify (element path verified:false) before it is used and recorded (count); this doc §6
    maxRequestFrames: 4,        // one RoiRequest rect may cover at most this many frame areas W·H, else the consumer broke its contract (frame areas); this doc §6
    maxFrameCropFrames: 16      // all requests of one frame together at most this many frame areas, a memory bound (frame areas); this doc §6
  },

  // U0 result validator (types.js validateResult)
  result: {
    coordRange: [-1, 2],        // normalized x, y bounds: arcs may leave the frame, px-unit bugs may not (normalized); this doc §9
    maxPoints: 60000,           // (count); this doc
    maxPointGapSec: 1 / 60,     // dense curve: consecutive points at most this far apart (sec); FINAL display (about 120 Hz)
    timeTolSec: 2e-3,           // tolerance for time identities (sec); this doc
    sampleTolSec: 1e-6,         // a curve sample "at" an observation time (sec); this doc
    posTol: 1e-6,               // tolerance for position identities (normalized); this doc
    sigmaSlackPx: 1e-3          // numeric slack on the 1.5σ check (px); this doc
  },

  // U7 benchmark gate (tests/bench); FINAL acceptance gate, D3 §9.4-9.5
  acceptance: {
    safety: {                   // all must pass before the default flips to hf (frac of clips)
      maxWrongGivenTraced: 0.01,
      maxClubFalseTrack: 0.005,
      maxNoBallFalseTrace: 0.01,
      minInvisibleAbstain: 0.98
    },
    quality: {                  // reported; default flips only if hf beats v2 on coverage AND position error
      coverageDtl: 0.95,        // down-the-line, ball visible >= 0.3 s real (frac)
      coverageFoFast: 0.9,      // face-on 120/240 fps and slow motion (frac)
      coverageFoRealtime: 0.6,  // face-on 30/60 fps (frac)
      launchFrameFrac: 0.97,    // |Δt| <= 1 frame in this fraction of traced clips (frac)
      launchPointD0: 0.5,       // launch point error <= 0.5·d0 ... (d0)
      launchPointFrac: 0.97,    // ... in this fraction (frac)
      identityMatched: 0.995,   // observed points matched (frac)
      maxIdentitySwitch: 0.005, // traced clips with a switch (frac)
      recallBySnr: [[6, 0.97], [3, 0.85], [2, 0.5]], // [min SNR, min recall] (z, frac)
      posMedianD: 0.35,         // position error median <= 0.35·d (d) ...
      posMedianSmallPx: 0.6,    // ... or 0.6 px when d < 2 px (px)
      posP95D: 1,               // p95 <= 1.0·d (d) ...
      posP95SmallPx: 1.5,       // ... or 1.5 px when d < 2 px (px)
      completionLongMedianDiag: 0.02, // >= 30% of flight observed: shape median <= 2% (frac of diag)
      completionLongP90Diag: 0.05,
      completionShortMedianDiag: 0.035, // < 30% observed: median <= 3.5% (frac of diag)
      completionShortP90Diag: 0.08,
      longObservedFrac: 0.3,    // boundary between the two completion strata (frac of flight)
      landingTimeMedian: 0.08,  // landing-time error median (frac of flight time)
      maxEce: 0.05,             // calibration ECE (frac)
      runtime4k60Sec: 20,       // 10 s 4K60 clip, laptop Chrome, codec path (sec)
      runtime1080p30Sec: 10,    // 10 s 1080p30 clip (sec)
      workerHeapMb: 150,        // (MB)
      tabRssMb: 400,            // tab RSS increase (MB)
      parityDecision: 0.98,     // Node/browser decision agreement (frac)
      parityLaunchFrame: 0.97,  // launch frame agreement (frac)
      parityMedianPx: 0.3       // median Δposition (px)
    },
    matchPx: 2,                 // a point matches when |p − g| <= max(2 px, 0.75·d(t)) (px); D3 §9.4
    matchD: 0.75,               // (d)
    clubFirstObs: 6,            // club false track: >= 2 of the first 6 observed points ... (count); D3 §9.4
    clubMinHits: 2,             // (count)
    clubSizes: 1,               // ... within 1.0 club-head size of the GT club ... (club sizes)
    clubFarD: 2                 // ... and > 2·d from the GT ball (d)
  }
});

/**
 * Frames covered by a duration spec: max(frames, ceil(sec·fps), ceil(realSec·tau·fps)), then capped by maxFrames.
 * @param {{frames?:number, sec?:number, realSec?:number, maxFrames?:number}} spec
 * @param {number} fps container frame rate (frames/s)
 * @param {number} [tau] slow-motion factor (video s per real s)
 */
export function spanFrames(spec, fps, tau = 1) {
  const e = 1e-9;
  let n = spec.frames ?? 0;
  if (spec.sec != null) n = Math.max(n, Math.ceil(spec.sec * fps - e));
  if (spec.realSec != null) n = Math.max(n, Math.ceil(spec.realSec * tau * fps - e));
  return spec.maxFrames != null ? Math.min(n, spec.maxFrames) : n;
}

/** Coarse-scan frame stride: every frame up to scan.maxRateHz, decimated above it. */
export function scanStride(fps, params = PARAMS) {
  return Math.max(1, Math.round(fps / params.scan.maxRateHz));
}

/**
 * A frozen copy of base with overrides applied (tests and tuning). Unknown keys and type changes throw,
 * so a typo cannot silently fall back to a default.
 */
export function mergeParams(overrides = {}, base = PARAMS) {
  const merge = (b, o, path) => {
    if (o === undefined) return b;
    const kind = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (kind(b) !== kind(o)) throw new TypeError(`param ${path}: expected ${kind(b)}, got ${kind(o)}`);
    if (kind(b) !== 'object') return o;
    for (const k of Object.keys(o)) if (!(k in b)) throw new TypeError(`param ${path}.${k}: unknown`);
    const out = {};
    for (const k of Object.keys(b)) out[k] = merge(b[k], o[k], `${path}.${k}`);
    return out;
  };
  return deepFreeze(merge(base, overrides, 'PARAMS'));
}
