#!/usr/bin/env bash
# Delete every sigil-* instance and disk. Never touches anything else: the project
# also hosts spar-* instances with 500 GB disks that belong to other work.
set -euo pipefail
PROJECT=${PROJECT:-focus-surfer-494820-g0}
for kind in instances disks; do
  gcloud compute $kind list --project="$PROJECT" \
    --filter="name~^sigil-" --format="value(name,zone.basename())" 2>/dev/null \
  | while read -r n z; do
      [ -z "$n" ] && continue
      echo "deleting $kind/$n in $z"
      gcloud compute $kind delete "$n" --zone="$z" --project="$PROJECT" --quiet || true
    done
done
echo "--- remaining sigil resources (should be none) ---"
gcloud compute instances list --project="$PROJECT" --filter="name~^sigil-" --format="value(name)"
gcloud compute disks list --project="$PROJECT" --filter="name~^sigil-" --format="value(name)"
