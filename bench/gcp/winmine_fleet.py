#!/usr/bin/env python3
"""Keep a Spot fleet of SigilBench v3 shard jobs running until every shard is done.

    python3 bench/gcp/winmine_fleet.py <spec.json> [--state state.json] [--once] [--interval 300]

spec.json:
    {"name": "wm7", "job": "winmine_v3", "branch": "sigil-bench-v3", "max_hours": 8,
     "slots": [{"zone": "us-central1-a", "machine": "c2d-highcpu-112", "count": 8}, ...],
     "shards": [{"key": "r6d3-0", "shard": "0/62", "args": "v3/corpus/r6d3/ 20000 6 10000 all 1",
                 "inputs": [optional static INPUTS, bucket object paths]}, ...],
     "resume_files": ["tables", "prefilter", "playouts"]}

Each shard runs bench/gcp/runner_v3.sh through bench/gcp/launch_v3.sh as a Spot VM
named sigil-<name>-<n>. Every --interval seconds the keeper:
  * marks a shard done when its newest run has a COMPLETE marker and deletes its VM;
  * relaunches a shard whose VM is gone (Spot preemption deletes it) or stopped
    without COMPLETE, passing the newest copy of each resume file
    (<file>_<i>of<n>.jsonl) from all of the shard's runs as INPUTS, so the job
    picks up where the last VM left off;
  * fills free slots with shards that have not started.
State (run ids per shard, done shards) is written to --state after every change
and copied to gs://focus-surfer-494820-g0-sigilbench-private/fleets/<name>/state.json,
so a keeper restarted after Cloud Shell dies continues the same fleet.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

BUCKET = 'gs://focus-surfer-494820-g0-sigilbench-private'
HERE = os.path.dirname(os.path.abspath(__file__))


def sh(cmd, check=False, timeout=600):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f'{cmd}: {p.stderr[-500:]}')
    return p


def vms(prefix):
    p = sh(f'gcloud compute instances list --filter="name~^{prefix}-" --format="value(name,zone.basename(),status)"')
    if p.returncode:
        raise RuntimeError('gcloud list failed: ' + p.stderr[-300:])
    out = {}
    for line in p.stdout.split('\n'):
        if line.strip():
            n, z, s = line.split('\t')
            out[n] = (z, s)
    return out


def run_files(run):
    """Newest copy of every file of one run: {basename: gs path}."""
    p = sh(f'gsutil ls "{BUCKET}/runs/{run}/**"')
    last = {}
    for line in sorted(p.stdout.split()):
        if re.search(r'/s\d{5}/', line):
            last[line.rsplit('/', 1)[1]] = line
    return last


def save(state, path, name):
    tmp = path + '.tmp'
    json.dump(state, open(tmp, 'w'), indent=1)
    os.replace(tmp, path)
    sh(f'gsutil -q cp {path} {BUCKET}/fleets/{name}/state.json')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('spec')
    ap.add_argument('--state')
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--interval', type=int, default=300)
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    name = spec['name']
    prefix = f'sigil-{name}'
    state_path = a.state or f'{name}_state.json'
    if os.path.exists(state_path):
        state = json.load(open(state_path))
    else:
        p = sh(f'gsutil cat {BUCKET}/fleets/{name}/state.json')
        state = json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else {'shards': {}, 'next_vm': 0}
    for s in spec['shards']:
        state['shards'].setdefault(s['key'], {'runs': [], 'vm': None, 'done': False, 'launches': 0})
    by_key = {s['key']: s for s in spec['shards']}
    while True:
        try:
            live = vms(prefix)
        except Exception as e:  # noqa: BLE001
            print(time.strftime('%H:%M'), 'skip round:', e, flush=True)
            if a.once:
                return
            time.sleep(a.interval)
            continue
        busy = {}
        changed = False
        for key, st in state['shards'].items():
            if st['done'] or not st['vm']:
                continue
            files = run_files(st['runs'][-1]) if st['runs'] else {}
            vm = live.get(st['vm'])
            if 'COMPLETE' in files:
                st['done'] = True
                changed = True
                print(time.strftime('%H:%M'), key, 'COMPLETE', st['runs'][-1], flush=True)
                if vm:
                    sh(f'gcloud compute instances delete {st["vm"]} --zone {vm[0]} --quiet')
                st['vm'] = None
                continue
            if 'FAILED' in files:
                st['done'] = True
                st['failed'] = True
                changed = True
                print(time.strftime('%H:%M'), key, 'FAILED (job exit != 0; not relaunched)', st['runs'][-1], flush=True)
                if vm:
                    sh(f'gcloud compute instances delete {st["vm"]} --zone {vm[0]} --quiet')
                st['vm'] = None
                continue
            if vm and vm[1] in ('RUNNING', 'PROVISIONING', 'STAGING'):
                busy[vm[0]] = busy.get(vm[0], 0) + 1
                continue
            # gone (preempted) or stopped without COMPLETE (watchdog): relaunch
            print(time.strftime('%H:%M'), key, 'lost VM', st['vm'], vm, flush=True)
            if vm:
                sh(f'gcloud compute instances delete {st["vm"]} --zone {vm[0]} --quiet')
            st['vm'] = None
            changed = True
        # launch into free slots: relaunches first, then new shards
        todo = [k for k, st in state['shards'].items() if not st['done'] and not st['vm'] and st['runs']]
        todo += [k for k, st in state['shards'].items() if not st['done'] and not st['vm'] and not st['runs']]
        for slot in spec['slots']:
            free = slot['count'] - busy.get(slot['zone'], 0)
            while free > 0 and todo:
                key = todo.pop(0)
                st = state['shards'][key]
                s = by_key[key]
                inputs = list(s.get('inputs') or [])      # static inputs (bucket object paths)
                safe = s['shard'].replace('/', 'of')
                newest = {}
                for run in st['runs']:
                    for base, path in run_files(run).items():
                        newest[base] = path          # later runs override earlier ones
                for f in spec.get('resume_files', []):
                    path = newest.get(f'{f}_{safe}.jsonl')
                    if path:
                        inputs.append(path.replace(BUCKET + '/', ''))
                vm_name = f'{prefix}-{state["next_vm"]}'
                state['next_vm'] += 1
                env = (f'BRANCH={spec["branch"]} JOB={spec["job"]} PYTHON_BINDING=1 PROVISIONING=SPOT '
                       f'SHARD={s["shard"]} INPUTS="{" ".join(inputs)}" ARGS="{s["args"]}"')
                p = sh(f'{env} bash {HERE}/launch_v3.sh {vm_name} {slot["machine"]} {slot["zone"]} {spec.get("max_hours", 8)}')
                m = re.search(r'^(\d{8}T\d{6}Z-\S+)$', p.stdout, re.M)
                if p.returncode or not m:
                    print(time.strftime('%H:%M'), key, 'launch failed in', slot['zone'], (p.stderr or p.stdout)[-300:], flush=True)
                    todo.insert(0, key)
                    free = 0           # this zone is out of capacity for now
                    break
                st['runs'].append(m.group(1))
                st['vm'] = vm_name
                st['launches'] += 1
                busy[slot['zone']] = busy.get(slot['zone'], 0) + 1
                free -= 1
                changed = True
                print(time.strftime('%H:%M'), key, 'launched', vm_name, slot['zone'], m.group(1),
                      f'resume {len(inputs)} files' if inputs else '', flush=True)
        if changed:
            save(state, state_path, name)
        n_done = sum(1 for st in state['shards'].values() if st['done'])
        n_run = sum(1 for st in state['shards'].values() if st['vm'])
        print(time.strftime('%H:%M'), f'{n_done}/{len(state["shards"])} done, {n_run} running', flush=True)
        if n_done == len(state['shards']) or a.once:
            return
        time.sleep(a.interval)


if __name__ == '__main__':
    sys.exit(main())
