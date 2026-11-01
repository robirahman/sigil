# SigilBench changelog


## 0.2.0-dev (unreleased, branch sigil-bench-v2)
- Dev set v2 (`bench/dev/dev_set_v2.json`): 25 each of mate in 1-4, all 45 spells (see `bench/dev/DEV_SET_V2.md`).
- Mate-in-4 grading: AND-OR prover with mover/defender killers and a proof memo; the resolver adds a deep parallel scan of every mover turn at the outermost choice. Dev-v2 reference answers proven: 20/25 first pass (was ~12), 24/25 with the resolver.

## Unreleased
- Site: SigilBench in the main menu, and a password-protected "Try the dev set" panel: people play the dev puzzles on the board with the first turn graded (`puzzles.html?bench=<id>`); for AIs it copies the harness's exact prompts and grades a pasted answer in the browser (stored proven solutions, wins on the spot, otherwise the in-browser engine's search, which does not check legality).

## 0.1.1-dev (2026-11-01)
- One response per puzzle: the reminder after a response without an answer is removed (it gave models that hit the output cap a second full budget). The Anthropic adapter's output cap defaults to 128k. `bench/tools/rescore_no_reminder.py` re-scores older runs from their transcripts.
- Exhaustive resolver for answers the first pass leaves unproven (`sigilbench/resolve.py`, `BENCH_EXHAUSTIVE=1` / `mate::judge_turn_exhaustive`, multi-threaded); `run.py` runs it at the end of every run.
- Leaderboard: five dev-set runs (Claude Haiku 5.5 x3, Gemini 3.8 Flash, GPT-6 Luna), re-scored under the new protocol.

## 0.1.0-dev (2026-10-31)
- Public dev set: 100 forced mates (34 mate-in-1, 33 mate-in-2, 33 mate-in-3) from the published Puzzles set (`dev/dev_set.json`).
- Grading by proof: browser-rules replay (`grader/apply.js`), then the Rust legality check and mate proof (`engine/examples/bench_grade.rs`, `mate::judge_turn`).
- Harness (`sigilbench/`): prompt, position rendering, Anthropic/OpenAI/xAI/Gemini adapters, oracle and random-legal baselines, resumable runs, cost cap, canary in every output file.
- Engine: rules-complete resolution for Rock Slide, Corrupt, Comet and Erupt behind `cast_enum::set_full_rules` (on in `bench_grade` and `children`).
- Model-facing rules (`prompt/`). Not yet reviewed by Andy.
