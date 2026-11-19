#!/usr/bin/env bash
# Startup script for a small always-on keeper VM: runs bench/gcp/winmine_fleet.py
# for every fleet spec in gs://…-sigilbench-private/fleets/specs/ (state from
# fleets/<name>/state.json), so Spot fleets keep relaunching and cleaning up while
# no interactive session is open. Uploads the keeper logs every 10 minutes and
# shuts the VM down when every keeper has exited (all shards done) or after the
# metadata max-hours cap. Runs as the project's Compute Engine service account
# (cloud-platform scope), which can create the shard VMs as sigilbench-eval.
#   gcloud compute instances create sigil-keeper --machine-type=e2-small \
#     --scopes=cloud-platform --metadata=max-hours=24 \
#     --metadata-from-file=startup-script=bench/gcp/keeper_vm.sh ...
set -u
B=gs://focus-surfer-494820-g0-sigilbench-private
md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
MAXH=$(md max-hours || echo 24); BRANCH=$(md branch || echo sigil-bench-v3)
( sleep $((MAXH * 3600)); echo "WATCHDOG"; shutdown -h now ) &
export CLOUDSDK_CORE_PROJECT=focus-surfer-494820-g0 HOME=/root
apt-get -qq update >/dev/null 2>&1; apt-get -qq install -y git python3 >/dev/null 2>&1
rm -rf /opt/keeper && mkdir -p /opt/keeper && cd /opt/keeper
git clone -q --depth 1 --branch "$BRANCH" https://github.com/robirahman/sigil.git repo
gsutil -q cp "$B/fleets/specs/*.json" . || { echo "no specs"; shutdown -h now; }
KEEPERS=()
for spec in *.json; do
  n=${spec%.json}
  python3 repo/bench/gcp/winmine_fleet.py "$spec" --state "/opt/keeper/${n}_state.json" --interval 300 > "$n.log" 2>&1 &
  KEEPERS+=($!)
done
( while true; do sleep 600; gsutil -q cp /opt/keeper/*.log "$B/fleets/logs/"; done ) &
wait "${KEEPERS[@]}"          # every keeper exits once all its shards are done
gsutil -q cp /opt/keeper/*.log "$B/fleets/logs/"
shutdown -h now
