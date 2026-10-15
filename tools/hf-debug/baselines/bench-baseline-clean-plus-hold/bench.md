# Flightline benchmark: hf on easy+smoke (node)

- Corpus: `/tmp/flightline-understand/p2c-I2-bench/frozen/easy,/tmp/flightline-understand/p2c-I2-bench/frozen/smoke11` (10 clips)
- Corpus pin: generator per split; manifest `e942b1680a5e` (easy 8 clips `6dea83849eaa` generator synth-1.1 code `2c4a1aa4000f`, checksums absent; smoke 2 clips `cf32261b91c8` generator synth-1.1 code `af07ac05f162`, checksums absent)
- Code: git `fc84dad` (dirty), code hash `c115427319e6` (engine `48eb71195abc`, bench `e618bc337e6c`), params `hf-params-1`, entry `runHF`
- Run: 2026-10-14T20:40:55.395Z, wall 15.2 s, jobs 6
- Synthetic data only: these numbers say nothing about real footage until labelled real clips exist.

## Gate: SAFETY FAIL

Failing: wrongGivenTraced, noBallFalseTrace, invisibleAbstain, coverageFoFast, recallSnr6, completionLongMedian, completionLongP90, landingTime, ece

| Precondition | Status | Detail |
| --- | ---: | ---: |
| noRunErrors | PASS | 0 clips ended in a runner or engine error |
| validResults | PASS | 0 results failed validateResult |
| clips | PASS | 10 clips scored |
| corpusPinned | PASS | manifest e942b1680a5e; generator easy synth-1.1 2c4a1aa4000f, smoke synth-1.1 af07ac05f162 |

| Target | Tier | Requirement | Estimate | 95% CI | n | Bound | Status | At CI bound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| wrongGivenTraced | safety | P(wrong \| traced) <= 1.0% (wrong: not the ball's flight, or a visible predicted arc more than 5% of the diagonal off) | 25.0% | [7.15%, 59.1%] | 8 | ≤ 1.00% | FAIL | fail |
| clubFalseTrack | safety | Club-head false-track rate <= 0.5% of clips | 0.00% | [0.00%, 27.8%] | 10 | ≤ 0.50% | PASS | fail |
| noBallFalseTrace | safety | No-ball (practice swing, whiff) false trace <= 1% | — | — | 0 | ≤ 1.00% | NO DATA | — |
| invisibleAbstain | safety | Invisible-ball-in-flight control abstention >= 98% | — | — | 0 | ≥ 98.0% | NO DATA | — |
| coverageDtl | quality | Coverage, down-the-line, ball visible >= 0.3 s real | 100.0% | [56.6%, 100.0%] | 5 | ≥ 95.0% | PASS | fail |
| coverageFoFast | quality | Coverage, face-on 120/240 fps capture and slow motion | 50.0% | [9.45%, 90.5%] | 2 | ≥ 90.0% | FAIL | fail |
| coverageFoRealtime | quality | Coverage, face-on 30/60 fps (physically limited) | — | — | 0 | ≥ 60.0% | NO DATA | — |
| launchFrame | quality | Launch timing \|dt\| <= 1 frame | 100.0% | [67.6%, 100.0%] | 8 | ≥ 97.0% | PASS | fail |
| launchPoint | quality | Launch point <= 0.5 d0 (d0 from quality.launchPointD0) | 100.0% | [67.6%, 100.0%] | 8 | ≥ 97.0% | PASS | fail |
| identityMatched | quality | Identity: observed points matched | 100.0% | [100.0%, 100.0%] | 547 | ≥ 99.5% | PASS | pass |
| identitySwitch | quality | Identity switches | 0.00% | [0.00%, 32.4%] | 8 | ≤ 0.50% | PASS | fail |
| recallSnr6 | quality | Observed recall, SNR >= 6 | 90.0% | [80.7%, 97.9%] | 608 | ≥ 97.0% | FAIL | fail |
| recallSnr3 | quality | Observed recall, SNR 3-6 | — | — | 0 | ≥ 85.0% | NO DATA | — |
| recallSnr2 | quality | Observed recall, SNR 2-3 | — | — | 0 | ≥ 50.0% | NO DATA | — |
| posMedian | quality | Position error median <= 0.35 d (balls >= 2 px) | 0.102 | [0.061, 0.157] | 253 | ≤ 0.350 | PASS | pass |
| posMedianSmall | quality | Position error median <= 0.6 px (balls < 2 px) | 0.076 | [0.062, 0.104] | 294 | ≤ 0.600 | PASS | pass |
| posP95 | quality | Position error p95 <= 1.0 d (balls >= 2 px) | 0.239 | [0.189, 0.255] | 253 | ≤ 1.000 | PASS | pass |
| posP95Small | quality | Position error p95 <= 1.5 px (balls < 2 px) | 0.202 | [0.116, 0.244] | 294 | ≤ 1.500 | PASS | pass |
| completionLongMedian | quality | Completion shape error median, >= 30% of flight observed | 3.41% | [0.67%, 5.58%] | 4 | ≤ 2.00% | FAIL | fail |
| completionLongP90 | quality | Completion shape error p90, >= 30% of flight observed | 5.57% | [1.29%, 5.58%] | 4 | ≤ 5.00% | FAIL | fail |
| completionShortMedian | quality | Completion shape error median, < 30% observed | 0.24% | [0.04%, 1.07%] | 4 | ≤ 3.50% | PASS | pass |
| completionShortP90 | quality | Completion shape error p90, < 30% observed | 0.87% | [0.09%, 1.07%] | 4 | ≤ 8.00% | PASS | pass |
| landingTime | quality | Landing-time error median | 10.6% | [0.95%, 13.8%] | 3 | ≤ 8.00% | FAIL | fail |
| ece | quality | Calibration ECE of confidence.value vs trace correct | 23.0% | — | 8 | ≤ 5.00% | FAIL | — |
| runtime4k60 | quality | Runtime, 10 s 4K60 (laptop Chrome, codec path) | — | — | — | ≤ 20.000 | n/a | — |
| runtime1080p30 | quality | Runtime, 10 s 1080p30 | — | — | — | ≤ 10.000 | n/a | — |
| workerHeap | quality | Worker heap peak | — | — | — | ≤ 150 | n/a | — |
| tabRss | quality | Tab RSS increase | — | — | — | ≤ 400 | n/a | — |
| parityDecision | quality | Node/browser decision agreement | — | — | — | ≥ 98.0% | n/a | — |
| parityLaunchFrame | quality | Node/browser launch frame agreement | — | — | — | ≥ 97.0% | n/a | — |
| parityPosition | quality | Node/browser median observed-position delta | — | — | — | ≤ 0.300 | n/a | — |

## Safety

| Metric | Rate | 95% CI |
| --- | ---: | ---: |
| P(wrong \| traced) | 25.0% (2/8) | [7.15%, 59.1%] |
| P(wrong identity \| traced) | 0.00% (0/8) | [0.00%, 32.4%] |
| Club-head false track (clips with an impact) | 0.00% (0/10) | [0.00%, 27.8%] |
| No-ball false trace | — | — |
| Invisible-ball control abstention | — | — |
| Distractor steal (traced hits) | 0.00% (0/8) | [0.00%, 32.4%] |

Wrong-trace reasons (traced clips): expected_abstain 0, club 0, steal 0, switch 0, unmatched 0, launch 0, completion 2. Runner errors 0, invalid results 0.

| Expected | n | tracked | partial | abstained | wrong |
| --- | ---: | ---: | ---: | ---: | ---: |
| trace | 8 | 6 | 1 | 1 | 2 |
| either | 2 | 1 | 0 | 1 | 0 |
| abstain | 0 | 0 | 0 | 0 | 0 |

## Quality

| Coverage class | Coverage | 95% CI |
| --- | ---: | ---: |
| all | 87.5% (7/8) | [52.9%, 97.8%] |
| dtl | 100.0% (5/5) | [56.6%, 100.0%] |
| foFast | 50.0% (1/2) | [9.45%, 90.5%] |
| foRealtime | — | — |
| oblique | 100.0% (1/1) | [20.7%, 100.0%] |

| Launch and identity | Value | 95% CI |
| --- | ---: | ---: |
| \|dt\| <= 1 frame | 100.0% (8/8) | [67.6%, 100.0%] |
| point <= 0.5 d0 | 100.0% (8/8) | [67.6%, 100.0%] |
| dt frames median / p95 | 0.023 / 0.067 | n 8 |
| point d0 median / p95 | 0.117 / 0.285 | n 8 |
| observed points matched | 100.0% (547/547) | [100.0%, 100.0%] bootstrap |
| identity switches | 0.00% (0/8) | [0.00%, 32.4%] |

| Recall bin (SNR) | Recall | 95% CI | Target |
| --- | ---: | ---: | ---: |
| >= 6 | 90.0% (547/608) | [80.7%, 97.9%] bootstrap | >= 97.0% |
| 3-6 | — | —  | >= 85.0% |
| 2-3 | — | —  | >= 50.0% |
| < 2 | — | —  | report only |

| Position error | Median [95% CI] | p95 [95% CI] | points |
| --- | ---: | ---: | ---: |
| large (d) | 0.102 [0.061, 0.157] | 0.239 [0.189, 0.255] | 253 |
| small (px) | 0.076 [0.062, 0.104] | 0.202 [0.116, 0.244] | 294 |
| px (px) | 0.106 [0.075, 0.397] | 0.974 [0.843, 1.121] | 547 |

| Completion (identity-correct traces) | n | Median [95% CI] | p90 [95% CI] |
| --- | ---: | ---: | ---: |
| shape max, >= 30% observed (diag) | 4 | 3.41% [0.67%, 5.58%] | 5.57% [1.29%, 5.58%] |
| shape max, < 30% observed (diag) | 4 | 0.24% [0.04%, 1.07%] | 0.87% [0.09%, 1.07%] |
| landing time (flight time) | 3 | 10.6% [0.95%, 13.8%] | 13.2% [8.65%, 13.8%] |
| end point (diag) | 8 | 2.52% | 7.33% |
| shape mean (diag) | 8 | 0.32% | 0.56% |
| end type agrees with GT | 5 | 100.0% (5/5) |  |

Calibration: ECE 23.0% over 8 traced clips (labels: uncalibrated).

| Confidence bin | n | mean confidence | fraction correct |
| --- | ---: | ---: | ---: |
| 0.9-1.0 | 8 | 0.980 | 0.750 |

| Runtime | Value | n |
| --- | ---: | ---: |
| 10 s 4K60 (projected, s) | — | 0 |
| 10 s 1080p30 (projected, s) | 8.7 | 7 |
| 1920p30: ms/frame, x realtime | 28.91 ms, 0.87x | 7 |
| 1920p60: ms/frame, x realtime | 29.36 ms, 1.76x | 2 |
| 1920p120: ms/frame, x realtime | 9.26 ms, 1.11x | 1 |
| phase probe (median ms) | 7.9 |  |
| phase scan (median ms) | 2112 |  |
| phase impact (median ms) | 122 |  |
| phase launch (median ms) | 2215 |  |
| phase track (median ms) | 642 |  |
| phase fit (median ms) | 65.7 |  |
| phase decide (median ms) | 8.6 |  |
| phase done (median ms) | 0.1 |  |

| Memory | max | p95 | n |
| --- | ---: | ---: | ---: |
| workerHeapMb | — | — | 0 |
| tabRssMb | — | — | 0 |
| nodeRssMb | 579 | 549 | 10 |
| nodeHeapMb | 79.6 | 77.0 | 10 |

## Strata

### set

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| main | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### viewClass

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dtl | 5 | 5 | 100.0% (5/5) [56.6%, 100.0%] | 40.0% (2/5) [11.8%, 76.9%] | 0.00% (0/5) | 89.1% (500/561) | 0.074 | 3.41% |
| fo | 3 | 1 | 50.0% (1/2) [9.45%, 90.5%] | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/3) | 100.0% (3/3) | 0.077 | 0.04% |
| oblique | 2 | 2 | 100.0% (1/1) [20.7%, 100.0%] | 0.00% (0/2) [0.00%, 65.8%] | 0.00% (0/2) | 100.0% (44/44) | 0.184 | 0.24% |

### capture

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 4 | 3 | 100.0% (2/2) [34.2%, 100.0%] | 33.3% (1/3) [6.15%, 79.2%] | 0.00% (0/4) | 80.3% (114/142) | 0.063 | 3.10% |
| 60 | 2 | 2 | 100.0% (2/2) [34.2%, 100.0%] | 50.0% (1/2) [9.45%, 90.5%] | 0.00% (0/2) | 90.8% (315/347) | 0.144 | 3.44% |
| 120 | 1 | 0 | 0.00% (0/1) [0.00%, 79.3%] | — — | 0.00% (0/1) | — | — | — |
| 120->30 | 3 | 3 | 100.0% (3/3) [43.9%, 100.0%] | 0.00% (0/3) [0.00%, 56.1%] | 0.00% (0/3) | 99.2% (118/119) | 0.097 | 0.39% |

### format

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1080x1920 | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### sky

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| blue | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### expected

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| either | 2 | 1 | — — | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/2) | 100.0% (2/2) | 0.078 | 0.09% |
| trace | 8 | 7 | 87.5% (7/8) [52.9%, 97.8%] | 28.6% (2/7) [8.22%, 64.1%] | 0.00% (0/8) | 89.9% (545/606) | 0.102 | 3.41% |

### kind

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hit | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### control

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hit | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### styleShift

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| in-style | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### codec

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| h264 | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### snrBin

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| >=6 | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

### failureModes

| Value | n | traced | coverage [CI] | P(wrong|traced) [CI] | club | recall >= 6 | pos median (d) | completion median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| F1 | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |
| F2 | 9 | 7 | 85.7% (6/7) [48.7%, 97.4%] | 28.6% (2/7) [8.22%, 64.1%] | 0.00% (0/9) | 93.4% (510/546) | 0.103 | 5.53% |
| F4 | 3 | 3 | 100.0% (2/2) [34.2%, 100.0%] | 0.00% (0/3) [0.00%, 56.1%] | 0.00% (0/3) | 98.7% (78/79) | 0.061 | 0.09% |
| F6 | 6 | 6 | 100.0% (6/6) [61.0%, 100.0%] | 33.3% (2/6) [9.68%, 70.0%] | 0.00% (0/6) | 89.9% (542/603) | 0.105 | 3.41% |
| F7 | 6 | 5 | 83.3% (5/6) [43.6%, 97.0%] | 40.0% (2/5) [11.8%, 76.9%] | 0.00% (0/6) | 89.8% (368/410) | 0.097 | 5.53% |
| F10 | 2 | 1 | 50.0% (1/2) [9.45%, 90.5%] | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/2) | 90.2% (174/193) | 0.144 | 1.29% |
| F11 | 3 | 3 | 100.0% (3/3) [43.9%, 100.0%] | 0.00% (0/3) [0.00%, 56.1%] | 0.00% (0/3) | 99.2% (118/119) | 0.097 | 0.39% |
| F13 | 3 | 1 | 50.0% (1/2) [9.45%, 90.5%] | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/3) | 100.0% (3/3) | 0.077 | 0.04% |
| F14 | 5 | 3 | 66.7% (2/3) [20.8%, 93.9%] | 0.00% (0/3) [0.00%, 56.1%] | 0.00% (0/5) | 100.0% (47/47) | 0.183 | 0.09% |
| F15 | 3 | 3 | 100.0% (3/3) [43.9%, 100.0%] | 66.7% (2/3) [20.8%, 93.9%] | 0.00% (0/3) | 91.8% (390/425) | 0.131 | 5.53% |
| F18 | 5 | 5 | 100.0% (5/5) [56.6%, 100.0%] | 40.0% (2/5) [11.8%, 76.9%] | 0.00% (0/5) | 92.6% (435/470) | 0.148 | 5.53% |
| F20 | 6 | 5 | 100.0% (5/5) [56.6%, 100.0%] | 40.0% (2/5) [11.8%, 76.9%] | 0.00% (0/6) | 92.8% (466/502) | 0.078 | 5.53% |
| F21 | 2 | 1 | — — | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/2) | 100.0% (2/2) | 0.078 | 0.09% |
| F22 | 2 | 1 | — — | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/2) | 100.0% (2/2) | 0.078 | 0.09% |
| F23 | 3 | 2 | 66.7% (2/3) [20.8%, 93.9%] | 0.00% (0/2) [0.00%, 65.8%] | 0.00% (0/3) | 100.0% (45/45) | 0.183 | 0.22% |
| F24 | 6 | 5 | 100.0% (4/4) [51.0%, 100.0%] | 20.0% (1/5) [3.62%, 62.4%] | 0.00% (0/6) | 87.4% (396/453) | 0.147 | 1.29% |
| F29 | 1 | 0 | 0.00% (0/1) [0.00%, 79.3%] | — — | 0.00% (0/1) | — | — | — |
| F33 | 1 | 1 | 100.0% (1/1) [20.7%, 100.0%] | 0.00% (0/1) [0.00%, 79.3%] | 0.00% (0/1) | 90.2% (174/193) | 0.144 | 1.29% |
| F34 | 10 | 8 | 87.5% (7/8) [52.9%, 97.8%] | 25.0% (2/8) [7.15%, 59.1%] | 0.00% (0/10) | 90.0% (547/608) | 0.102 | 3.41% |

## Clips

| Clip | Set | Expected | Outcome | Wrong | Launch dt (frames) | Matched | Recall | Completion max | ms/frame | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| easy-01-dtl30-iron7 | main | trace | tracked |  | 0.03 | 100.0% | 59.7% | 0.67% | 38.80 |  |
| easy-02-dtl30-wedge | main | trace | tracked | completion | 0.03 | 100.0% | 96.2% | 5.53% | 33.21 |  |
| easy-05-dtl60-wedge | main | trace | tracked | completion | 0.00 | 100.0% | 91.6% | 5.58% | 28.26 |  |
| easy-09-dtl120s-driver | main | trace | tracked |  | 0.03 | 100.0% | 98.6% | 1.07% | 34.61 |  |
| easy-11-fo30-iron7 | main | either | abstained |  | — | — | — | — | 22.61 | ball_not_found_after_impact ball_left_frame_too_fast |
| easy-15-fo120s-driver | main | trace | tracked |  | 0.02 | 100.0% | 100.0% | 0.04% | 20.15 |  |
| easy-17-oblique30-driver | main | either | tracked |  | 0.09 | 100.0% | 100.0% | 0.09% | 28.50 |  |
| easy-21-oblique120s-iron7 | main | trace | partial |  | 0.02 | 100.0% | 100.0% | 0.39% | 28.91 | completion_uncertain |
| smoke-04-dtl60-plane | main | trace | tracked |  | 0.01 | 100.0% | 90.2% | 1.29% | 30.46 |  |
| smoke-13-fo120-rotated | main | trace | abstained |  | — | — | — | — | 9.26 | ball_not_found_after_impact |

## Definitions

- Point match: |p − g| <= max(2 px, 0.75·d(t)) against the GT ball of the frame on screen at the point's time; result points go through the result camera first.
- Traced: status tracked or partial with >= 2 points. Wrong: A traced clip is wrong when the clip has no ball flight, the club or a distractor was tracked, an identity switch happened, fewer than half the observed points are the ball, the launch is off by more than max(3 frames, 0.25 s real: another event, while v2's 0.2 s early seeds stay right) or 2 d0, or (includeCompletion) a visible predicted point is more than completionDiag x diag from the true arc, matched in order along it (metrics.mjs arcAlign: a down-the-line descent lies over the ascent, so the nearest point anywhere would hide a landing overshoot). completionDiag equals PARAMS.confidence.labelShapeErrDiag, the confidence training label.
- A frame's SNR is the generator's decoded-video oracle ball.snrCoded, else 0.6 x ball.expectedSnr (the generator's own visibility convention, D2 sec. 9.3 oracle). GT-visible: post-impact flight frames in frame, not occluded, not duplicates.
- Completion: predicted points only, alpha >= 0.5; shape = distance to the GT arc2d polyline, per clip the max, as a fraction of the diagonal.
- Intervals: Wilson 95% for clip rates; cluster bootstrap over clips for frame- and point-pooled metrics and quantiles.
- Sets: set: the clip's split when it is 'controls' (invisible-ball controls) or 'perf' (perf set, D3 sec. 9.2), else 'main'. Perf clips count for runtime, memory and run errors only; a runtime target uses perf clips of its format and length when present, else a projection from ms/frame.
- Corpus pin: per split, the sha256 of the `<sha256>  <file>` listing of every clip file (the generator's checksums.sha256 format), the generator version and code hash; reports with different pins are not compared.
