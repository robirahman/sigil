# Caveman engine upgrades (DEPLOYED 2026-05-27)

Two validated improvements, now the **defaults** in `caveman-ai.js` (no flag):

1. **Ranked narrow enumeration** — ranked top-1 of each dash/cast at every ply.
   Beat the old greedy default **48–16**. `_CAVEMAN_NARROW_CAPS` + the default
   branch in `_cavemanAlphaBeta`.
2. **Joint Carnage refill+push planner** — `SimBoard._bestCarnageRefill` +
   `_planHardMoves`, on by default via `cavemanSearch` (`rankLaterPushes`).
   Chooses which circle stone to keep AND the push sequence to maximize crushes
   (the keep-B2 trap). **93–67 / 160 games (~58%, p≈0.04)** on top of #1; the
   push-only version without the refill choice was a 48–48 wash.

Both are near-free (depth unchanged), 100% spectator-replay coverage. Difficulty
tiers left as pure time budgets (Easy is a stronger 0.1s player now, by design —
not artificially depth-capped). The `deepCap`/`exhaustivePlies`/`enumCaps`/
`rankLaterPushes` opts remain for the arena harness / overrides.

---

## Original recommendation (enumeration)

Switch Caveman to **ranked width-1 enumeration at *every* ply** — including the
root. At each node, expand only the engine's single top-*ranked* variant of each
dash/cast (via the exhaustive enumerator with all caps pinned to 1), instead of
today's full-breadth-at-root + arbitrary-greedy-deeper scheme.

The win is **depth**: narrowing the per-node fan-out (especially the root's
spell-variant explosion) lets alpha-beta reach ~depth 5.4 vs ~3.9 at 3s/move,
and the ranking keeps those narrow choices good. Net: it beat the current
default head-to-head and flipped a losing matchup vs full-width `pure_minimax`
into a win.

> ⚠️ A "conservative" variant that keeps **full `ENUM_CAPS` breadth at root+ply1**
> and only ranks deeper (`deepcap=1`) was tested and **lost 12–20** to the
> current default — the wide root is itself a depth-killer (it fell to depth
> 3.57). Don't keep the wide root. Narrow everywhere.

## The problem

`_cavemanAlphaBeta` only uses the exhaustive (ranked, capped) enumerator at the
root and ply 1 (`caveman-ai.js`). Deeper, it falls back to
`SimBoard.getLegalTurns`, whose `_enumeratePostMove` emits exactly **one,
arbitrary** variant of each spell/dash — e.g. a dash sacrifices whichever stones
come *last in `NODE_ORDER`* and moves to `targets[0]`. Two costs:

1. **Wrong moves explored.** The single greedy variant is often not the best (or
   even a reasonable) cast/dash, so deep nodes are evaluated on bad lines.
2. **Bad move ordering.** Alpha-beta's efficiency lives or dies on move order.
   Feeding it an arbitrary variant first wastes cutoffs.

## Why "just enumerate more" is the wrong fix

Widening deep enumeration (`plies=3`: exhaustive at ply 2 as well) made Caveman
*weaker* — it bought completeness by spending depth, and depth is what the
engine needs. The lever is enumeration **quality at fixed width**, not width.

## Evidence (headless arena, `tools/arena/`, core pack, seed-paired)

All vs. the current greedy-deep default, `pruned_minimax`:

| Config | Result | avgDepth (maxD) @3s |
|---|---|---|
| old default (full root, greedy deep) | baseline | 3.5–3.9 (11–14) |
| `plies=3` (wider deep) | **worse** (4–12 vs pure; lost depth) | 3.0 (13) |
| **`capabs=1` (ranked width-1, every ply)** | **beat pure 10–6** (pure had won 11–5); **beat old default 22–10** (seed 42) + **26–6** (seed 77) = **48–16 / 64 games** | **5.0–5.4 (13)** |
| ranked-vs-ranked (`capabs` 1/2/3, `plies` 6/64) | all within noise (11–13 / 24g) | — |
| `deepcap=1` (full root breadth, ranked top-1 deep) | **lost 12–20** to old default (32g, seed 77) | 3.57 (12) |

Budget dependence: with the *old* default, pruning lost to full-width `pure`
at 3s/move (5–11) but won at 15s/move (10–6) — it needed depth ~5 to pay off.
`capabs=1` reaches depth ~5 at *3s*, so it wins across budgets. The `deepcap=1`
row is the key negative result: ranking *deep* while keeping a *wide root*
doesn't help — the root fan-out is where the depth is lost.

## The code change

In `docs/static/scripts/engine/caveman-ai.js`, make the **default** enumeration
"ranked width-1 at every ply" (what `capabs=1, plies=64` does in the harness):
exhaustive enumeration is used at every ply, and the caps are pinned to 1 so
only the top-ranked variant of each choice-point is expanded.

Add a module constant and use it as the default in `_cavemanAlphaBeta`'s
enumeration decision (the existing `deepCap` / `exhaustivePlies` / `enumCaps`
overrides stay for experiments and parity tests):

```js
// module scope: width-1 ranked caps, one per ENUM_CAPS choice-point
const _CAVEMAN_NARROW_CAPS = (() => {
    const c = {}; for (const k of Object.keys(ENUM_CAPS)) c[k] = 1; return c;
})();

// _cavemanAlphaBeta, default branch (no enumConfig override):
useExhaustive = true;                       // exhaustive at every ply
caps = _CAVEMAN_NARROW_CAPS;                // ranked top-1 of each variant
```

This replaces the old `(exhaustiveRoot && isRoot) || (exhaustiveOpponent && ply === 1)`
greedy-deep default. No call-site changes — game, review, and ponder all flow
through `cavemanSearch`. The browser arena (`?red=…&blue=…`) is unaffected unless
callers pass these opts.

Note the tradeoff being accepted: the root now considers only the **top-ranked**
variant of each spell (not all of them, as the original exhaustive-root change
intended). Empirically the depth gained more than compensates (it beats the
wide-root configs), but this is the one behavioral change to watch — see below.

## Validate before shipping

- [x] Confirm `capabs=1` beats the greedy default over fresh seeds — done:
      22–10 (seed 42) + 26–6 (seed 77) = 48–16 / 64 games @3s. (Optional: 100+
      and at 10–15s/move before flipping live.)
- [ ] **Root cast quality**: with width-1 root, verify on a few positions that
      the engine still finds known strong casts (the original exhaustive-root
      fix was about *not missing the most damaging cast*). If a regression shows,
      try width-2 root (`capabs=2` tied `capabs=1` in testing) as a safer default.
- [ ] **Difficulty tiers**: Easy/Medium/Hard/VeryHard are Caveman time budgets.
      Deeper search = stronger AI at every tier; check Easy isn't now too hard
      (may want to *lower* Easy's time budget to compensate).
- [ ] **AI game review** (`game-review.js`) uses `cavemanSearch` with a shared
      TT; re-check its Quick/Deep depth budgets and runtime stay reasonable.
- [ ] **Ponder** path: deeper enumeration shouldn't change cancel latency
      (bounded by `maxDepth`), but spot-check.
- [ ] **Expansion packs** (Fury/Tempest/Tsunami): the ranker covers their spells
      via `ENUM_CAPS`; sanity-check a few games per pack.
- [ ] **Python parity**: `ai/` mirrors this engine for training/eval. If parity
      matters, mirror the deep-enumeration change in `ai/enumerator.py` /
      `ai/search.py` (the JS-vs-Py parity tests will flag drift).

## Reproduce

```bash
# head-to-head: proposed default (narrow ranked everywhere) vs current default
~/.local/node/bin/node tools/arena/arena.js --games 100 --time 3 \
  --red pruned_minimax --blue pruned_minimax:plies=64,capabs=1
```
