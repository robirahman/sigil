# SigilBench changelog

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
