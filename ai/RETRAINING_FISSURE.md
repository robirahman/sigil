# Retraining the AI for the new Fissure mechanic

Fissure now permanently destroys its target node (an impassable "wall"). The
search engine already handles walls correctly; this is about teaching the
**neural net** to (a) recognize every non-Panda spell and (b) evaluate boards
that contain destroyed nodes. All the code below is already wired — this is the
procedure to run on a training machine (ideally with a GPU).

## What changed in the code (already done)

- `ai/config.py`
  - `SPELL_TO_ID`: now 42 spells = core + every official expansion
    (springtime, celestial, inferno, tempest, tsunami, autumn, gloom,
    covenant, tectonic). IDs 0–14 unchanged. **Panda is excluded.**
  - `NUM_POSSIBLE_SPELLS = 42`, `RAW_FEATURE_DIM = 495`.
- `ai/features.py` / `docs/static/scripts/engine/features.js`: a 39-dim
  **destroyed-node channel** appended at the end of the feature vector
  (1.0 per walled node). Python and JS vectors are byte-identical (verified).
  Both spell-id maps match `config.py`.
- `ai/migrate_checkpoint.py`: grows an old 15-spell / 456-dim checkpoint into
  the new 42-spell / 495-dim architecture for warm-starting.
- `ai/selfplay.py:random_spell_set()` + `ai/generate_selfplay_minimax.py
  --expansions`: self-play can now draw spell sets that include Fissure and
  the other expansions.

> **Autumn caveat:** `Harvest`/`Gather`/`Seal_of_Autumn` have embedding IDs
> (30–32) for cross-engine consistency, but the **Python simulator
> (`simboard.py`) does not implement them**, so self-play can't generate
> Autumn games and those three embeddings stay at init until Autumn is added
> to `simboard.py`. Everything else (incl. all of Tectonic) trains normally.

> **Out of scope:** `ai/genetic.py` (the legacy genome heuristic, `best_genome.json`)
> still assumes 15 spells. It is a separate non-NN policy and is not retrained here.

## Procedure (on the training machine)

### 0. Environment
```bash
pip install torch numpy            # GPU build recommended
# sanity: dims and parity
PYTHONPATH=. python -m pytest ai/test_tectonic.py -q   # or: python ai/test_tectonic.py
```

### 1. Warm-start checkpoint (recommended over from-scratch)
Grow the current best model into the new architecture:
```bash
PYTHONPATH=. python -m ai.migrate_checkpoint \
    --in  ai/models/best_model.pt \
    --out ai/models/best_model_fissure_init.pt
```
Core spell embeddings and all 456 legacy feature weights are preserved; the new
expansion-embedding rows start fresh and the destroyed-channel columns start at
zero (so the migrated net scores wall-free core boards identically to the old
one). For the hard net add `--arch SigilNetHard`.

### 2. Generate self-play data that includes Fissure
The minimax generator plays walls correctly, so its data is sound. Generate a
batch covering all expansions, plus a Tectonic-biased batch for denser Fissure
coverage:
```bash
# Broad coverage across every official expansion (Fissure ~20% of games)
PYTHONPATH=. python -m ai.generate_selfplay_minimax \
    --hours 12 --expansions all \
    --model ai/models/best_model_fissure_init.pt \
    --output ai/data/selfplay_fissure_all.jsonl

# Denser Fissure/Tectonic coverage (Fissure ~45% of games)
PYTHONPATH=. python -m ai.generate_selfplay_minimax \
    --hours 12 --expansions tectonic \
    --model ai/models/best_model_fissure_init.pt \
    --output ai/data/selfplay_fissure_tectonic.jsonl
```
Run on as many cores/time as you can; more Fissure positions = better wall play.

### 3. (Optional) human games
The old Fissure games were wiped from Firebase, so a fresh
`ai/import_human_games.py` export contains no stale-mechanic data. Re-import if
you want the human policy signal; it simply won't teach Fissure (self-play does).
Old self-play JSONLs (e.g. `selfplay_v22b_*.jsonl`) are safe to keep —
`train_sigil_v2.py` re-featurizes any record whose `raw_features` length ≠ 495
from its stored SFN, so they upgrade to the new schema automatically.

### 4. Train (warm-start)
```bash
PYTHONPATH=. python -m ai.train_sigil_v2 \
    --model ai/models/best_model_fissure_init.pt \
    --self-play ai/data/selfplay_fissure_all.jsonl \
                ai/data/selfplay_fissure_tectonic.jsonl \
                ai/data/selfplay_v22b_2026-05-03.jsonl \
    --device cuda          # or cpu
    # add --human ai/data/human_games_v3.jsonl if you re-imported step 3
```
(From scratch instead: omit `--model`. Needs much more self-play.)

### 5. Gate — specifically on Fissure boards
Evaluate the candidate vs the current best with a **Fissure-inclusive** spell
pool, not just core, so acceptance reflects the new mechanic. Use the project's
gating harness with expansion spell sets (`random_spell_set('all'/'tectonic')`).
Accept only if it clears `GATE_THRESHOLD` (0.55) and doesn't regress on core.

### 6. Export to the browser
```bash
PYTHONPATH=. python -m ai.export_binary \
    --model ai/models/best_model.pt \
    --output-dir docs/static/models --name sigil_net
```
This overwrites `docs/static/models/sigil_net.bin` (+ `.json`). The manifest
carries `num_possible_spells: 42` and `raw_feature_dim: 495`; `sigil-net.js`
reads those from the manifest and tensor shapes, so the browser adapts
automatically — **as long as `features.js` matches `config.py`** (it does:
both 495 dims, identical spell map).

### 7. Final parity + smoke checks
```bash
# Python<->JS feature parity (needs a self-play JSONL present)
PYTHONPATH=. python ai/test_feature_parity.py
PYTHONPATH=. python ai/test_graph_inference_parity.py
# In the browser: play a game with Fissure in the pool, confirm the AI
# moves around walls, never targets disabled spells, and uses Fissure itself.
```

## Quick checklist
- [ ] `migrate_checkpoint.py` → `best_model_fissure_init.pt`
- [ ] self-play with `--expansions all` (and `tectonic`) → JSONL
- [ ] `train_sigil_v2.py` warm-started from the migrated checkpoint
- [ ] gate on Fissure-inclusive matchups
- [ ] `export_binary.py` → `docs/static/models/sigil_net.bin`
- [ ] feature-parity tests green; browser smoke test on a Fissure board
