#!/usr/bin/env bash
# Pull a run's logs and data out of GCS, and say whether it actually finished.
#   collect.sh <run-id> [dest-dir]
set -euo pipefail
RUN=$1; DEST=${2:-./run-$RUN}
BUCKET=${BUCKET:-gs://focus-surfer-494820-g0-sigil}
mkdir -p "$DEST"
gsutil -q -m cp "$BUCKET/runs/$RUN/live/*" "$DEST/" 2>/dev/null || true
gsutil -q -m cp "$BUCKET/runs/$RUN/data/*.npz" "$DEST/" 2>/dev/null || true
gsutil -q cp "$BUCKET/runs/$RUN/COMPLETE" "$DEST/" 2>/dev/null \
  && echo "COMPLETE: $(cat "$DEST/COMPLETE")" \
  || echo "WARNING: no COMPLETE marker -- the run did not finish cleanly, so any"
echo "         result below may be partial. Check for a running VM."
[ -f "$DEST/COMMIT.txt" ] && echo "ran against: $(cat "$DEST/COMMIT.txt")"
ls "$DEST" | wc -l | xargs echo "files:"
