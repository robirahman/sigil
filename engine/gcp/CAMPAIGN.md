# Superhuman campaign: what to run on Google Cloud, and what each result decides

Every run below is `launch.sh` on `main` (its default branch is now `main`; the old
default pointed at a deleted branch). Read results with `collect.sh <run-id>` and pool
with `harness/pool_shards.py` -- never from a single shard's SPRT line. One VM per run,
`c3d-highcpu-90` (~$3.2/h); `SHARD_BASE` must differ per VM if a run is ever split.
Timed arenas use 45 workers (hyperthreads halve node rate; 90 shards would make "3 s"
mean 1.5 s); data generation uses 90.

Run `teardown.sh` when the bucket shows `COMPLETE` for every run.

## Run 1 -- pondering + persistence, the thing that just shipped (~$8 + ~$7)

```sh
cd engine/gcp
./launch.sh sigil-ponder3 ab_session.py arms/ponder_3s.txt "1,200,ponder" 45 us-central1-f 4 c3d-highcpu-90
SHARD_BASE=100 ./launch.sh sigil-ponder10 ab_session.py arms/ponder_10s.txt "1,200,ponder" 45 us-central1-f 4 c3d-highcpu-90
```

3 s: 45 shards x 50 games = 2,250 games (~2.5 h). 10 s: 45 x 12 = 540 games (~2 h).
Pool: `python harness/pool_shards.py "runs/<id>/live/arm*.log"`.

| pooled result | decision |
|---|---|
| lower CI bound > 50% at both controls | pondering confirmed; leave it default-on; note the Elo in FINDINGS |
| 3 s positive, 10 s spans parity | keep it on: the human effect at 30-60 s think time is what matters, and equal ponder/search time is the least favourable ratio; re-test only once >= 100 human games exist on the top tier |
| upper CI bound < 50% at either control | set `ponderPolicy: 'setting'` for every tier in game-board-local.js (opt-in only), bump RUST_ENGINE_VERSION and sw.js, redeploy; investigate slice overhead in `Engine::ponder_step` |

## Run 2 -- search knobs that survived the local 300 ms arenas (~$3-7 each at 3 s)

Only knobs whose local point estimate is >= 50% get a fleet run (local results: FINDINGS
"§1.2/§1.4 knob arenas"). Qualifying: `aspiration_steps` (51.5%), `adopt_partial` (51.0%),
`elastic` (untested locally; needs matched time), and `lmr` (46.8% at 300 ms, but its
depth-for-coverage trade grows with the clock, as `width_scale` did). Not qualifying:
`force_hints` 47.1%, `use_history` 47.5%, `root_resort` 49.0%, `pvs` 50.5% with identical depth. For each survivor the arm is `25,3000,tfit,<knob>,<arm>,<base>`:

```sh
printf '25,3000,tfit,lmr,21,0\n'        > arms/lmr_3s.txt        # LMR band x2, R=1
printf '25,3000,tfit,history,1,0\n'     > arms/history_3s.txt
printf '25,3000,tfit,root_resort,1,0\n' > arms/root_resort_3s.txt
printf '25,3000,tfit,elastic,1,0\n'     > arms/elastic_3s.txt    # gate at MATCHED average time
printf '25,3000,tfit,aspiration_steps,1,0\n' > arms/aspiration_steps_3s.txt   # local 51.5%: qualifies
printf '25,3000,tfit,adopt_partial,1,0\n'    > arms/adopt_partial_3s.txt      # local 51.0%: qualifies
./launch.sh sigil-knob-lmr ab_search.py arms/lmr_3s.txt "1,200,tfit,lmr,21,0" 45 us-central1-f 4 c3d-highcpu-90
```

Pool `elastic` with `--max-time-ratio 1.05` (it refuses a verdict if the arm overspent;
re-run with the arm's budget scaled down by the printed ratio).

| pooled result at 3 s | decision |
|---|---|
| lower bound > 50% | confirm at 10 s (`6,10000,...`, ~$9-24); if that also clears, flip the default in `Search::new` (and `search_defaults`), add the knob to STATUS.md's shipped config, rebuild wasm, redeploy |
| spans parity | leave off; record; do not re-run without a changed premise |
| upper bound < 50% | leave off; record the number so it is not re-tried |

If two or more knobs clear individually, run ONE bundle arm at 10 s before flipping
defaults (knobs interact through node rate).

## Run 3 -- §2 prior labels (~$26, 8 h)

```sh
SMOKE_TIMEOUT=1800 ./launch.sh sigil-prior selfplay_prior.py arms/prior_labels.txt "2,/opt/sigil/out/data,5,4,3,4" 90 us-central1-f 9 c3d-highcpu-90
```

90 shards x 800 games, label depth 7 (every 3rd ply from ply 4), play depth 5: expect
~70k games / ~700k labels in `runs/<id>/data/prior_*.npz`. Then locally:

```sh
gsutil -m cp gs://focus-surfer-494820-g0-sigil/runs/<id>/data/prior_*.npz /tmp/prior/
~/.venvs/sigil/bin/python engine/harness/prior_gate0.py "/tmp/prior/*.npz"
```

| gate 0 (chosen turn within first 4 of its own stub) | decision |
|---|---|
| >= 97% | train the stub-level prior (`fit_prior.py`, to be written: listwise softmax over each position's candidates, export to `prior_weights.rs`), then gate 1: offline coverage w24 >= 95% and >= +7 pts over stage order, average width at 98% <= 40 |
| 90-97% | add a within-stub outcome scorer (features of the already-resolved child boards) BEFORE training; same gate 1 |
| < 90% | the heuristic order INSIDE cast stubs is the bottleneck, not stub selection; the cheaper fix is `outcome_score` / `stratify_by_keep`; re-plan §2 |

Gate 1 failing stops §2 (~$60 spent, recorded). Passing leads to `prior_iter.rs`, the
node-cost gate (< 5%), knobbite, then arenas exactly as in Run 2.

## Run 4 -- Check A over the recorded human games (~$25, 7 h)

```sh
SMOKE_TIMEOUT=3600 ./launch.sh sigil-checka eval_drop_audit.py arms/checka_human.txt "--checks,a,--lines,gs://focus-surfer-494820-g0-sigil/data/hydrated_lines_v2.json,--depths,2,--windows,2,--limit-games,2,--out,/opt/sigil/out/smoke.json" 90 us-central1-f 9 c3d-highcpu-90
```

Then `harness/pool_drops.py` and `harness/attribute_drops.py` on the pooled JSON (see
FINDINGS "Check A re-run"), filtered to HUMAN movers rated >= 1400. The hydrated file
predates the 2026-09-09 dump by ~60 games; re-hydrate with `--hydrate-out` if that matters.

| drop distribution | decision |
|---|---|
| clusters on a spell or turn shape (dash, keep, cast) | an ordering/eval blind spot: add the shape as a `turn_parts` feature for §2 and to a `human_blindspots.json` regression set (§3.2) |
| mostly `+-UNPROVEN_MATE` at one end | horizon effects; depth is the cure (what §1 buys); nothing to change |
| no structure | self-play SPRT is a sufficient instrument for now; do not re-run on a schedule |

## Run 0 -- nothing to launch: the human acceptance gate

Accrues on the live site. Re-run whenever a new strong human has played the top tier:

```sh
python3 engine/harness/human_vs_rust_report.py <completed_games dump> --users <users dump> \
    --min-human-elo 1400 --gate __ai_rust_very_hard__
```

H1 = superhuman by the campaign's definition (>= 65% vs humans rated >= 1400); H0 = not;
`continue` = more games needed. `?ai=rust_anchor` is the frozen reference; never upgrade it.
