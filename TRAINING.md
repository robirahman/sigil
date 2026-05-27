# Training the Sigil Hard Mode AI

This guide explains how to train the AlphaZero-style AI that powers hard mode
in single-player Sigil. The system uses Monte Carlo Tree Search (MCTS) guided
by a 2.17M-parameter neural network (SigilNet) trained via self-play.

## Hardware Requirements

### Minimum (CPU-only)
- 4+ CPU cores
- 8 GB RAM
- 10 GB disk space
- Expect ~1 self-play game per minute, ~3 days for one training iteration

### Recommended (GPU)
- NVIDIA GPU with 4+ GB VRAM (RTX 3060 or better)
- 8+ CPU cores (self-play is CPU-bound; more cores = more parallelism)
- 16 GB RAM
- 20 GB disk space
- Expect ~10 self-play games per minute on GPU, ~1 day per iteration

Self-play is the bottleneck. The MCTS game tree search runs on CPU (SimBoard
is pure Python), while the neural network evaluations benefit from GPU. Most
training time is spent generating games, not running gradient descent.

## Setup

```bash
# Install PyTorch (pick one)
pip install torch                                          # GPU (CUDA auto-detected)
pip install torch --index-url https://download.pytorch.org/whl/cpu  # CPU-only

# Verify
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

No other dependencies are needed beyond NumPy (included with PyTorch).

## Exhaustive turn enumeration (important)

Self-play, arena, and live play enumerate **every** legal turn — including
the keep-set chosen when refilling a spell (which stones to keep vs. spend),
push destinations, and every spell effect-target. Previously the engine
collapsed these into one greedy variant, so the network trained on a
truncated action space and never learned moves like "keep the stone next to
the opponent when casting Fireblast." This is controlled by
`EXHAUSTIVE_ENUM` in `ai/config.py` (default `True`); set it `False` to fall
back to the old greedy enumeration.

Consequences for training:

- **Branching explodes** from ~14 to a few hundred legal turns per position
  (p99 ~10k at rich mid-game positions). `NUM_SIMS_TRAIN`/`NUM_SIMS_PLAY`
  were raised (1200/2400) so MCTS still visits moves more than once — tune
  these on your GPU. Too few sims relative to branching makes MCTS fall back
  to the raw policy prior.
- **Self-play is much slower** (enumeration + per-turn feature encoding is
  CPU-bound Python, ~20–100× the old cost). Parallelize across CPU workers;
  the GPU mainly speeds the NN evals, not the enumeration. Start with a small
  `--games`/`--sims` run to gauge wall-time before committing to a full
  generation.
- **Old self-play data is on the truncated action space.** For the new
  enumeration to pay off, regenerate self-play data with the current code
  rather than training only on pre-existing JSONLs.

Quick sanity check before a long run:

```bash
python -m ai.test_exhaustive_enum        # replay parity + keep-set/push tests
python -m ai.selfplay_mcts --games 1 --sims 30 --output /tmp/smoke.jsonl
```

## Quick Start

Run these commands from the project root directory.

```bash
# Step 1: Generate self-play training data (start small to verify it works)
python -m ai.selfplay_mcts --games 100 --sims 400

# Step 2: Train the network
python -m ai.train_sigil --data ai/data/*.jsonl --epochs 10 --device cuda

# Step 3: Test the trained model against the previous best
python -m ai.arena --model1 ai/models/best_model.pt --games 100 --sims 200
```

## Full Training Loop

The AI improves through repeated cycles of self-play and training. Each
iteration generates new games using the current best model, trains a new
model on the accumulated data, then tests whether the new model is stronger.

### Step 1: Generate Self-Play Data

```bash
python -m ai.selfplay_mcts \
  --games 10000 \
  --sims 400 \
  --model ai/models/best_model.pt \
  --output ai/data/selfplay_gen01.jsonl
```

| Flag | Description | Default |
|------|-------------|---------|
| `--games` | Number of games to play | 100 |
| `--sims` | MCTS simulations per move (more = stronger play, slower) | 400 |
| `--model` | Model checkpoint to use (omit for random/new model) | None |
| `--output` | Output file path | `ai/data/selfplay_<timestamp>.jsonl` |

Each game produces ~20-50 training positions. 10,000 games yields ~300K
positions, enough for a meaningful training iteration.

**Tip:** You can run multiple self-play processes in parallel on different
CPU cores, each writing to a different output file. The training step can
read multiple files.

### Step 2: Train the Network

```bash
python -m ai.train_sigil \
  --data ai/data/selfplay_gen01.jsonl ai/data/selfplay_gen02.jsonl \
  --model ai/models/best_model.pt \
  --output ai/models/candidate_gen02.pt \
  --epochs 10 \
  --batch-size 512 \
  --lr 0.001 \
  --device cuda
```

| Flag | Description | Default |
|------|-------------|---------|
| `--data` | One or more JSONL data files | (required) |
| `--model` | Existing model to continue training | None (new model) |
| `--output` | Where to save the trained model | `ai/models/best_model.pt` |
| `--epochs` | Training epochs over the data | 10 |
| `--batch-size` | Batch size | 512 |
| `--lr` | Initial learning rate | 0.001 |
| `--max-records` | Max positions to load (rolling window) | 500,000 |
| `--device` | `cpu` or `cuda` | cpu |

The training loop reports per-epoch loss (value + policy), validation loss,
and value prediction accuracy. You should see:

- **Value loss** decreasing over epochs (MSE between predicted and actual outcome)
- **Policy loss** decreasing (cross-entropy between network policy and MCTS visit counts)
- **Value accuracy** increasing (did the network predict the right winner?)

### Step 3: Gate the New Model

Before accepting a newly trained model, test it against the current best:

```bash
python -m ai.arena \
  --model1 ai/models/candidate_gen02.pt \
  --model2 ai/models/best_model.pt \
  --games 400 \
  --sims 200
```

The candidate must win at least 55% of games to be accepted. If accepted,
copy it to `best_model.pt`:

```bash
cp ai/models/candidate_gen02.pt ai/models/best_model.pt
```

### Step 4: Repeat

Go back to Step 1 using the new best model. Each iteration should produce
a stronger AI. A typical training schedule:

| Iteration | Games | Cumulative Positions | Expected Strength |
|-----------|-------|---------------------|-------------------|
| 1 | 10,000 | ~300K | Beats random play consistently |
| 2 | 10,000 | ~600K | Beats heuristic AI |
| 3-5 | 10,000 each | ~1.5M | Beats old NN+alpha-beta AI |
| 5-10 | 10,000 each | ~3M | Competitive with strong humans |

## Deploying a Trained Model

### Option A: PyTorch (if PyTorch is installed on the server)

Just place the `.pt` file at `ai/models/best_model.pt`. The game server
loads it automatically when a hard-mode game starts.

### Option B: NumPy export (no PyTorch on server)

Export the trained model to a pure-NumPy format:

```bash
python -m ai.export_numpy \
  --model ai/models/best_model.pt \
  --output ai/models/best_model_numpy.json
```

This produces a JSON file (~46 MB) that can run inference using only NumPy.
To use it, update `ai/mcts_ai_player.py` to load the NumPy model instead.

## Tuning Tips

- **More simulations = stronger but slower.** 400 sims for training, 800 for
  production play is a good balance. Increase to 1600+ for maximum strength
  at the cost of longer think times.

- **Learning rate.** Start at 0.001, the cosine scheduler drops it to 0.0001
  over the training epochs. If training is unstable (loss spikes), try 0.0005.

- **Data quality matters more than quantity.** Games played with more MCTS
  simulations produce better training signal. 1,000 games at 800 sims can
  be more valuable than 10,000 games at 50 sims.

- **Keep old data.** The training script accepts multiple data files. Include
  data from earlier generations (up to the 500K position window) so the
  network doesn't forget what it learned.

- **First iteration bootstrap.** The very first training run starts from a
  random network, so the self-play games will be low quality. This is normal.
  Quality improves rapidly after the first training cycle.

## Rule changes and training-data hygiene

When game rules change, every training position recorded under the old rules
becomes potentially poisoned: positions that the network learns to evaluate
under the old rules will guide it toward moves that misvalue the new
mechanics. To keep things clean, the loaders apply per-record date-aware
filters that exclude affected positions automatically.

### Fireblast nerf — cutoff 2026-05-07

On 2026-05-07 the latest-edition rules nerfed Fireblast. The spell still
destroys all enemy stones bordering yours, but the caster must now sacrifice
one of their own stones afterward. Boards that contain Fireblast and were
generated before this date encode the OLD value of the spell (no sacrifice
cost), and training on them teaches the network the wrong cost-benefit for
casting Fireblast.

The training data loaders (`ai/train_sigil.py` and `ai/train_sigil_v2.py`)
import `is_pre_cutoff_fireblast_record` from `ai/data_filters.py` and skip
any record whose:

  1. board's spell list contains `Fireblast`, AND
  2. data file's effective date is strictly before `2026-05-07`.

The "effective date" is parsed from the filename if it contains a
`YYYY-MM-DD` token (e.g. `selfplay_v22b_2026-05-03.jsonl`), and falls back
to the file's mtime otherwise. Boards that don't contain Fireblast are
unaffected and are kept regardless of date.

You'll see a count printed at load time, e.g.:

```
ai/data/selfplay_v22b_2026-05-03.jsonl: skipped 14823 pre-2026-05-07 Fireblast position(s)
```

If a future rule change invalidates more old positions, add another check
to `ai/data_filters.py` and document the new cutoff alongside this one.

### Competitive variant opening-pass bug — cutoff 2026-05-08

When the Competitive variant first shipped on 2026-05-07, the opening-pass
check that suspends the immediate-loss rule during the empty-board opening
had an off-by-one against the live game-controller's 1-indexed turn
numbering. Blue's opening blink ran with `turnCounter == 2`, but the
guard tested `< 2` instead of `<= 2`, so `update()` fired the
zero-stones-loses rule against blue *during their own opening turn*.
Effects:

  - Single-player games against the easy AI ended after one move with red
    declared the winner (the user, who'd just placed their first stone).
  - Multiplayer competitive games and games against the medium AI hit the
    same trip but produced different downstream symptoms (legal-turn list
    collapsed to `[pass]`, MCTS hung).

These short games are not real play and would teach the network to
expect quick wins for the side that goes first under the Competitive
variant. The fix landed the same day the variant shipped, so any
Competitive-variant record dated strictly before 2026-05-08 is excluded
via `is_pre_competitive_fix_record(path, sfn)` in `ai/data_filters.py`.
The check looks at the SFN's trailing variant token (written by both
the Python and JS engines) and the file's effective date; standard-
variant records are never skipped by this filter regardless of date.

You'll see the count printed at load time, alongside any Fireblast
skips:

```
ai/data/selfplay_2026-05-07.jsonl: skipped 31 pre-2026-05-08 Competitive-variant position(s) (opening-pass bug)
```

## Git Branch Strategy

Training data and model weights are managed across two branches:

- **`main`** — Production code and the latest/best model checkpoint
  (`ai/models/best_model.pt`). Training data files (`training_data/`,
  `training_data_v2/`, `ai/data/`) should NOT be committed here. Only
  update `best_model.pt` on main when a new model passes gating.

- **`training-data`** — All self-play training data (JSONL files, SGN game
  transcripts). This branch tracks main and adds the data on top. Use it
  for development and training runs.

When you produce a new trained model:

```bash
# On training-data branch: commit new self-play data
git checkout training-data
git add ai/data/selfplay_gen03.jsonl
git commit -m "Add gen03 self-play data (10K games)"

# After gating passes: update best model on main
git checkout main
cp ai/models/candidate_gen03.pt ai/models/best_model.pt
git add ai/models/best_model.pt
git commit -m "Update best model to gen03"
```

This keeps the main branch lightweight (the model checkpoint is ~9 MB)
while preserving the full training history on the data branch.
