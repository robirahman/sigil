# Frozen human-game benchmark suites (2026-10)

Built 2026-10-06 by `engine/harness/bench_build.py freeze` (training plan Step 1). Scored by
`engine/harness/bench_suites.py`, at a fixed node budget or candidate count. Every case carries
its own SFNs and the game history before the position, so nothing else is needed to score it.
**Do not regenerate these files in place.** A new suite gets a new name, so numbers from
different dates stay comparable.

Corpus: Firebase `completed_games`, downloaded 2026-10-06 (2,595 games). Hydrated with
`eval_games.py hydrate --analysis`: 2,517 games. Then `bench_build.py filter` kept 2,020 games
(58,111 positions). It excluded 461 pre-nerf Fireblast games, 12 pre-fix Competitive games, and
24 games whose draw holds Fissure, Bulwark, Dividend, Annuity or Endowment. The providence-bank
branch rewrites those spells' rules, so those games were played under the old rules
(`ai/data_filters.py` `OCT2026_RULE_CHANGE_SPELLS`). No case in the older suites below came from
an excluded game, so the filter dropped 0 of them. The record-damage classes (FAT, NO-OP
SACRIFICE, TRANSCRIPTION GLITCH, FINDINGS "the enumeration campaign closes at ZERO") need no
extra filter here. Coverage counts a turn the generator cannot reach as not covered, and that
count is the same for every config.

| file | cases | what |
|---|---|---|
| `surprise_cases.json` | 317 | Opponent turns where the Rust AI's depth-4 value fell by more than 1.0 stone, confirmed by depth 6 of the resulting position. 284 come from `ai/data/surprise_audit_2026-09-26.json` (games 2026-08-26..09-26, target from that run's engine). 33 are new: run 20261006T065736Z, engine v23, the 37 games since then, 42 flagged. `target` is the depth-6 value of the after-position from the AI's point of view. `sfn_after` is the human's actual result. |
| `human_finds.json` | 120 | Human turns whose drop survived the depth-8 / 150 s re-search (`vdrop > 1.0` in `ai/data/human_turn_drops_2026-09-23.json`). |
| `final_blow_misses.json` | 26 | The winner's final position, where the exhaustive solver finds an immediate win and the shipped depth-2 search (v23) reports no forced win. Source: `final_blow_probe.py` over the 2,020 filtered games, run 20261006T070147Z. 1,885 positions were probed, 1,272 have a solver-counted immediate win, and 26 of those were missed (61 in the 2026-09 report on older engines). 28 more depth-2 misses are left out because the solver hit its enumeration cap there (`turn_cap`), so a win could not be confirmed. |

`build_report.json` has the per-suite counts from the build.

## v25 re-scored surprise suite (2026-10-07)

`surprise_cases.json` carries targets from the engines of its source runs (the September
`tfit` engine for 284 cases, v23 for 33), which makes its sees-rate unfair to an eval change.
`engine/harness/bench_rescore.py` scored every case again with the engine as shipped in v25
(`SHIPPED_EVAL` = `nnue_spell`, `SHIPPED_POLICY` = generator policy on at width >= 96,
`DEFAULT_WIDTH_SCALE`, `SHIPPED_ADAPTIVE`, 300 s cap, surprise_audit.py's definitions). Run
20261007T003058Z (branch `r2-bench`, f6f8fadb).

| file | cases | what |
|---|---|---|
| `surprise_cases_v25.json` | 317 | The same 317 cases and fields; `target` / `v4_i` are the v25 depth-6 / depth-4 values, the old ones kept as `target_old` / `v4_i_old`, plus `confirmed_v25`. Score with `bench_suites.py --surprise-file surprise_cases_v25.json`. |
| `surprise_rescore_v25.json` | 317 | Per-case provenance: old and new target and depth-4 value, search depth/nodes/seconds. |

The case SELECTION is unchanged (the older engines' flags). 211 of 317 cases are still
confirmed by v25 (its own depth-4 value minus the v25 depth-6 target > 1.0): 194 of the 284
September cases and 17 of the 33 v23 cases. The suite is deliberately not cut to those 211:
"confirmed" uses the engine's own depth-4 value, so the confirmed subset is by construction
the cases v25 misses at depth 4, and a sees-rate over it would be biased against v25.
`surprise_cases.json` is untouched.
