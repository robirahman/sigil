# Cloud runner

These four scripts are **in the repo on purpose.** An earlier copy lived only in an
ephemeral Cloud Shell scratch directory; a VM reset destroyed it together with an
unpushed engine change, and the run that was in flight could not be reproduced.

```
launch.sh <name> <harness> <arms-file> <smoke-args> [workers] [zone] [max-hours]
collect.sh <run-id> [dest]
teardown.sh
```

`runner.sh` is the startup script; it clones the branch from GitHub, builds the
engine, runs the smoke arm, fans the arms out over shards, streams logs to
`gs://…-sigil/runs/<run-id>/live/`, uploads `.npz` artefacts to `…/data/`, writes a
`COMPLETE` marker, and shuts the VM down.

## Three failures this encodes

**`wait` waited for the uploader.** The progress uploader is an infinite
`while true; do …; sleep 60; done &`. `wait` with no arguments waits for *every*
background job, so it never returned: no run ever reached its summary upload, its
`COMPLETE` marker, or its `shutdown -h now`. Three VMs billed ~10 hours each before
anyone noticed, and the tell — every run missing its `COMPLETE` marker — had been
visible for hours. Arm PIDs are now collected explicitly and `wait "${PIDS[@]}"`
waits only for them.

**A hung upload could still hang the script,** and the script is what shuts the VM
down. Every `curl` now has `--max-time`.

**Nothing below the bootstrap is trusted to terminate.** A watchdog
(`max-hours`, default 4) shuts the VM down regardless of what the rest of the
script does. `--boot-disk-auto-delete` means a deleted instance cannot leave a
25 GB disk behind, which happened too.

## Reading a result

`collect.sh` prints a **warning when there is no `COMPLETE` marker**, because a
partial result looks exactly like a finished one otherwise. It also prints
`COMMIT.txt`, the commit the VM actually cloned — worth checking, since a local
commit that failed to push once caused an arena to silently measure the previous
code.

## Cost

`c3d-highcpu-30` is ~$1.06/hr on demand. A 1,200-game 300 ms arena arm is minutes;
a 60 s/move gate is hours. Always run `teardown.sh` when done — it matches
`^sigil-` only and never touches the `spar-*` instances and 500 GB disks that
belong to other work in this project.
