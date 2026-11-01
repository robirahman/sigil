# SigilBench changelog

## 0.2.0-dev (2026-11-01)
Grader fixes from the dev-set pilot (`analysis/2026-10-31-dev-pilot.md`, section 4):
- **An impossible `pushed_to` is illegal.** `apply.js` checks each non-null `pushed_to` against the push destinations on the board it applies to. The browser replay used to substitute its first destination silently, so a different turn from the submitted one was graded (e.g. GPT-6 Luna's sbdev-040 and sbdev-069, Haiku 5.5's sbdev-014 and sbdev-029). Model-facing change in `prompt/actions.md` ("Pushes"), hence the minor version.
- **Turn cap 2^23 for grading** (`mate::BENCH_TURN_CAP`, `BENCH_TURN_CAP`), was 2^20: sbdev-021's answer leaves Red 1.27M replies; it now grades `wrong` instead of `grader_error`.
- `tools/regrade.py` re-grades a finished run from its stored answers.
- Runs on the leaderboard were graded with 0.1.1-dev and have not been re-graded yet.

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
