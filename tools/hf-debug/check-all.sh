#!/bin/zsh
# check-all.sh [NAME]: the hf safety bench, the real-clip batch and the night clip, compared with the 2026-10-14 baselines.
# Data locations (override with env): FLIGHTLINE_BENCH (frozen synthetic corpus), FLIGHTLINE_CLIPS (the private Pixel
# clips), FLIGHTLINE_NIGHT_CLIP, FLIGHTLINE_BASELINE (results folder), FLIGHTLINE_OUT (scratch output).
set -u
HERE=${0:A:h}; ROOT=${HERE:h:h}; NAME=${1:-run}
BENCH=${FLIGHTLINE_BENCH:-$HOME/Documents/flightline-dev/bench/frozen}
CLIPS=${FLIGHTLINE_CLIPS:-$HOME/Documents/Photos-1-001}
NIGHT=${FLIGHTLINE_NIGHT_CLIP:-$HOME/Downloads/PXL_20261014_034239108~3.mp4}
BASE=${FLIGHTLINE_BASELINE:-$HERE/baselines}
OUT=${FLIGHTLINE_OUT:-/tmp/flightline-hf-check}/$NAME
mkdir -p $OUT; cd $ROOT
echo "bench: $BENCH  clips: $CLIPS  out: $OUT"
node tests/bench/run-node.mjs --corpus $BENCH/easy,$BENCH/smoke11 --engine hf --jobs 6 --with none \
  --out $OUT/bench.json --md $OUT/bench.md --run-log none > $OUT/bench.log 2>&1
statuses() { grep -E '^\[' $1 | sed -E 's/^\[[0-9]+\/[0-9]+\] //; s/ [0-9.]+ s$//' | sort; }
if diff <(statuses $BASE/bench-baseline-clean-plus-hold/bench.log) <(statuses $OUT/bench.log) > $OUT/bench.diff; then
  SYN="identical to the baseline"; else SYN="CHANGED, see $OUT/bench.diff"; fi
R=$(grep -E '^\| recallSnr6 ' $OUT/bench.md | awk -F'|' '{print $5}' | tr -d ' ')
echo "synthetic safety bench: recallSnr6 $R, per-clip statuses $SYN"
if [ -d "$CLIPS" ]; then
  ls $CLIPS/*.mp4 | tr '\n' '\0' | xargs -0 -P 7 -n 1 node $HERE/hf-summary.mjs > $OUT/photos.jsonl 2>/dev/null
  [ -f "$NIGHT" ] && node $HERE/hf-summary.mjs $NIGHT > $OUT/night.jsonl 2>/dev/null
  python3 -I $HERE/py/compare.py $BASE/photos-2026-10-14-now.jsonl $OUT/photos.jsonl $OUT/night.jsonl
else echo "real clips not found at $CLIPS (set FLIGHTLINE_CLIPS)"; fi
