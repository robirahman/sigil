#!/usr/bin/env bash
# Pull a run's logs and data out of GCS, and say whether it actually finished.
#   collect.sh <run-id> [dest-dir]
set -euo pipefail
RUN=$1; DEST=${2:-./run-$RUN}
BUCKET=${BUCKET:-gs://focus-surfer-494820-g0-sigil}
mkdir -p "$DEST"
gsutil -q -m cp "$BUCKET/runs/$RUN/live/*" "$DEST/" 2>/dev/null || true
gsutil -q -m cp "$BUCKET/runs/$RUN/data/*.npz" "$DEST/" 2>/dev/null || true
if gsutil -q cp "$BUCKET/runs/$RUN/COMPLETE" "$DEST/" 2>/dev/null; then
  echo "COMPLETE: $(cat "$DEST/COMPLETE")"
elif gsutil -q cp "$BUCKET/runs/$RUN/FAILED" "$DEST/" 2>/dev/null; then
  echo "FAILED: $(cat "$DEST/FAILED")"
  echo "         the run ended but a stage or shard exited nonzero; results are partial."
else
  echo "WARNING: no COMPLETE marker -- the run did not finish cleanly, so any"
  echo "         result below may be partial. Check for a running VM."
fi
[ -f "$DEST/COMMIT.txt" ] && echo "ran against: $(cat "$DEST/COMMIT.txt")"
ls "$DEST" | wc -l | xargs echo "files:"
