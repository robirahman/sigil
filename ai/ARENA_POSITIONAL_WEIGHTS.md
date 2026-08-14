# Positional eval weights for the Caveman AI — 2026-08-02 campaign

Conclusion: **no positional weight set beat the pure stone-count
baseline; `CAVEMAN_EVAL_WEIGHTS` ships as zeros.** The wiring
(`cavemanSearch` `opts.evalWeights`, arena spec keys, parity tests)
remains in place for future experiments.

## Weight fitting (ai/fit_positional_weights.py)

Logistic regression of game outcome on red-POV positional differentials
over all Firebase `completed_games` (2,205 downloaded; 1,560 kept —
ranked + standard variant + intact SFN chains + Fireblast-nerf cutoff;
**all ranked games are human-vs-AI**, there were zero ranked
human-vs-human games). 38,603 positions, cluster-robust SEs, AI-tier +
human-side controls. Full output: `ai/data/positional_weights_fit.json`.

| Feature | Stone-equivalents (adjusted fit, 95% CI) | Reading |
|---|---|---|
| map control | +0.05 [+0.03, +0.08] (+0.13 unadjusted) | robust positive association |
| mana | −0.46 [−0.64, −0.33] | negative; early-phase −2.9/node → confounded (mana rushes = overextension) |
| void | −0.11 [−0.26, −0.00] (void stones look *good*) | winners-have-spare-stones confound |

Observational associations, not causal move values — hence the arena.

## Arena A/B campaign (tools/arena, 200 games/run, 10 s/move, seeded, color-swapped)

| Run | Arm vs baseline | Result | p | Verdict |
|---|---|---|---|---|
| 1 (seed 1001) | `caveman:mc=0.0246` (capped tiebreaker, <1 stone total) | 94–106 (47.0%) | 0.40 | wash; ~30% nps and ~0.25 ply cost from per-leaf BFS |
| 2 (seed 1002) | `caveman:mana=0.15,voidp=0.05,mc=0.05` (prior-informed full scale, ~2.9 stones) | 74–126 (37.0%) | 0.0002 | significantly weaker |
| 3 (seed 1003) | `caveman:mana=0.15,voidp=0.05` (no map control, 0.9 stones) | 89–111 (44.5%) | 0.12 | not significant, trending weaker |

Per-game records: `ai/data/arena/arena-run{1,2,3}-*.json`.

Interpretation: at 10 s/move the caveman's deep material search already
prices in most of what these static positional terms describe; biasing
its eval away from material makes it strictly worse (run 2), and even
"free-tiebreaker"-scale terms don't pay for the map-control BFS's
search-speed tax (run 1). Run 3 shows the effect isn't only the BFS
cost: material-only-adjacent bias with zero compute overhead still
trends negative.

## What would change this conclusion

- Much shorter time controls (depth-starved searches lean harder on
  static eval) — but the user's stated position is that <5 s games are
  too weak to be informative.
- A cheaper/incremental map-control computation (delta updates per move
  instead of full BFS per leaf).
- Weights fitted from stronger data (ranked human-vs-human games, once
  they exist; or eval_annotations at scale — only 85 labels today).

## Reproduce

```
python -m ai.fit_positional_weights                 # cached download
node tools/arena/arena.js --games 200 --time 10 --seed 1001 --threads 5 \
    --red caveman --blue "caveman:mc=0.0246"
```
