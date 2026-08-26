# Verified findings

## Scope boundary is exactly clean
`ai/config.py::SPELL_TO_ID`: the 39 official spells (core 15 + Springtime,
Celestial, Inferno, Tempest, Flood, Autumn, Gloom, Covenant) occupy ids
**0..38 contiguously**; deferred playtest packs occupy 39..50 (Tectonic 39-41,
Providence 42-44, Aftershock 45-47, Ambush 48-50). The whole scope filter for the
deferred packs is `spell_id < 39`.

## The JS engine has 63 spells; ai/config.py has 51. The extra 12 are PANDA.
Panda is unofficial/fan-made and excluded per Robi. It is exactly the 12 spells
with **no Python id at all**: Perfect_Heist, Moth_Plague, Ripples, Lifesap,
Stampede, Choke, Bear_Trap, Shiver, Blood_Saplings, Itch, Free_Spirit,
Residue_Mixture. Excluding it removes a real complication: **`Lifesap` is a static
that raises the refill count to `max(mana, 2)` on every 5-node cast**
(sim-board.js:1644), so the cast path needs no Lifesap branch.

Also: `FURY_*` in constants.js is the internal name for the pack ai/config.py
labels **Inferno** (Erupt 21, Fury 22, Charge 23). Same pack, different label.

**Data consequence:** the live site draws from the JS pool, so Firebase games and
annotations can contain Panda spells. Since Panda has no ids, the corpus filter
must drop those **by name**, in addition to `spell_id < 39`.

## Scoping to the official spells restores the legacy 456-dim feature vector
`RAW_FEATURE_DIM = 593` = 250+156+18+18+6+8 + 39 + 10 + 10 + 78, and the last four
blocks are exactly the deferred packs (destroyed-node 39, Providence 10,
Aftershock 10, Ambush snares 78) = 137 dead dims. **593 - 137 = 456**, which
config.py's own comment calls "the older feature columns" that
`ai/migrate_checkpoint.py` zero-pads from. So the in-scope feature dim is exactly
what the legacy checkpoints (`best_model_v13`, `v15_legacy`) were trained at — no
migration needed to warm-start. Per-turn encoding drops 124 -> 116, and cast
one-hot writes reduce to two ranges: `id<15 -> 43+id`, else `84+(id-15)`.

## Parity bug that differential testing caught (would have shipped silently)
`_push_enemy` / `escape_distance` use a **single global FIFO deque**, so children
of an earlier-popped parent precede lower-indexed children of a later parent.
Pushing into `a5` with `a4` and `a6` both enemy-held yields options `[a3, a7, ...]`
— children of `a4`, popped first — so `options[0] == a3`, not `a2`. A neighbour
bitmask sweep visits in node-index order and gets `a2`.

`options[0]` IS the greedy push destination, so this changes played moves. It
failed on ~1 position in 30. My earlier claim that "index-ascending adjacency means
bitmask order reproduces `_adjacent_nodes` order" is true *within one node's list*
and false for the *overall BFS order*. Fixed with an explicit FIFO; pinned by
`push_bfs_uses_global_fifo_order_not_node_index_order`.

## Rule worth pinning: moves PLACE stones, they do not relocate them
`_do_soft_move` / `_do_hard_move` only assign `stones[node] = color`; neither clears
an origin. Every move grows the mover's count by one; a crush is +1/-1. This drives
the whole +-3-lead dynamic and is the rule most likely to be got wrong by assuming
Go-like movement.

## Win conditions, deferred packs out
All phantom-stone terms are zero, so `check_game_over` is real stones plus blue's
+1 token, which makes the lead **asymmetric**: red needs a real lead of 4, blue 2.
Sixth spell: higher total wins, tie goes to the player NOT to move. Elimination is
checked in `update()` and the token does not save blue. Deathmatch disables both
the lead and sixth-spell conditions (and the spell counter never increments).

## Repetition key: RESOLVED — the JS rule is correct, Python has a bug
* `simboard.looping_snapshot()`: spell counters | 39 stones | locks
* `sim-board.js loopingSnapshot()`: side-to-move | 39 stones | locks | springlocks
  | spell counters (counters omitted in deathmatch)
**Robi's ruling (2026-08-26): side-to-move and springlock DO count.** A repetition
only counts when the board and the full game state are exactly the same. If a
position recurs with the springlock advanced it does NOT count, because that player
can no longer continue repeating it.

So `sim-board.js loopingSnapshot()` is right and **`simboard.looping_snapshot()` is
wrong** — it omits side-to-move and springlock, making its key over-broad and able
to declare a threefold (a blue win) that never happened.

**Deferred, not fixed:** Robi has explicitly deferred fixing the Python simulator.
A `TODO(upstream)` marker is in `engine/src/zobrist.rs`. Consequence to remember:
until it is fixed, any repetition-sensitive output of the Python stack — including
existing self-play data — is suspect.

## Autumn semantics (JS is the only implementation; confirmed by Robi)
`constants.js`: `Gather` = `locked_or_self_moves` count **3** (sorcery, 3-node
sigil); `Harvest` = same resolver count **5** (ritual, 5-node sigil);
`Seal_of_Autumn` = `resolve: null, static: true, ischarm: true`.

Resolver (spells.js:848): up to `count` ordinary moves — soft or hard, **never a
blink** — each landing in `POSITIONS[self] ∪ POSITIONS[lock[color]]`. Ends early the
moment the target set is empty, covering both of Robi's cases (no bordering stones;
zone already full) and a mid-resolution game end.

Ordering subtlety: the zone uses the **pre-cast** lock. `_castSpell` reassigns
`lock` only *after* the resolver returns (spells.js:854 says so), so reading `lock`
inside the resolver gives the spell you were locked into before this cast.

`Seal_of_Autumn` is a pure static: while the **enemy holds it charged** (not cast),
you may not sacrifice a stone on any sigil node to dash — only mana/void stones
qualify (`canSac`, sim-board.js:1716). With Seal of Lightning cutting the dash cost
from 2 stones to 1, that is the whole dash rule.

The live game asks the player to choose the push destination during an Autumn
hard-move step (`doPushEnemy` takes input) rather than taking `options[0]` — another
un-collapsed choice point. `autumn_step_options` returns every (target, dest) pair.

## Operational: `/` is ephemeral and DID wipe once
The Cloud Shell VM reset mid-session and destroyed the scratchpad (engine, clone,
toolchain). Everything hand-written now goes to `gs://focus-surfer-494820-g0-sigil`
via `backup.sh` after each increment. Rebuilding is otherwise cheap: fetch only the
8 reference files (356 KB) instead of cloning the 809 MB repo.

## How much the shipped move generator hides: ~4,000x

Measured over 40 random legal midgame positions (legal draws, ~18% stone density),
comparing `simboard.get_legal_turns` against full enumeration:

| | mean | max |
|---|---|---|
| shipped (collapsed) generator | **37.5** turns | 122 |
| full enumeration, nothing hidden | **210,263** turns | 1,048,576 (cap) |
| expansion | **4,144x** | 29,127x |

Turn-level choice points the shipped engine collapses, all now enumerated:
* **push destination** of every hard move (engine takes `options[0]`)
* **which stones a dash sacrifices** (engine takes the last 1-2 in node order).
  Note the dash follows the turn's move, so the sacrificeable set is the POST-move
  one - a 4-stone position becomes C(5,2)=10 pairs per first-move branch.
* the dash's **move target** and its push destination (engine takes `targets[0]`)
* spell selection, and a second cast via Seal of Summer

Resolver-level choice points, also now enumerated (`cast_enum.rs`), e.g.:
* **Hail Storm**: the live game PROMPTS for which enemy stone dies in each
  qualifying sigil (spells.js:190); the engine takes node order.
* **Meteor**: which adjacent enemy dies (engine forces a mana preference).
* **Corrupt / Storm Front**: which stones are converted / destroyed.
* **Hurricane**: which of several equally-smallest groups.
* **Fireblast / Fury / Comet / Corrupt**: which stone is sacrificed.
* **Scatter / Blossom**: which sigils and which node inside each.

Soundness property, asserted in `greedy_resolution_is_always_among_the_enumerated_outcomes`
and verified over all 39 spells x 9 slots x many positions: whatever the shipped
greedy engine would play is always a member of our enumeration. Zero misses.

Outcomes are deduped by resulting stone masks, which is both sound (mid-resolution
nothing but `stones` changes) and a large win: Harvest filling a 5-node zone has
120 orderings but ONE outcome. With a lock widening the zone to 8 nodes it
correctly becomes 14 distinct outcomes.

### Gust is the combinatorial outlier
Gust displaces every enemy stone touching you and the caster chooses where each
lands, so outcomes are C(empties, displaced): 4 stones into 25 empties is 12,650;
6 into 25 is 177,100. `OUTCOME_CAP` (4096) bites here and sets
`EnumStats::resolver_truncated` rather than silently dropping options.

### Architectural consequence (next design decision)
Complete enumeration is correct but a materialised 210k-successor list is not
searchable at every node. The fix is NOT to hide options again - it is to make the
generator **lazy and ordered**: stream successors best-first so a search visits the
promising ones and can still reach any of them. Concretely: return an iterator
rather than a `Vec`, and drive it from a move-ordering heuristic (or a policy
prior). That keeps "the search can always see every move" while making the
branching factor a budget rather than a wall.

## Lazy ordered generation: the searchability fix

`turn_iter.rs` yields turns best-first in stages, doing only bounded work per
`next()`: (1) `[move, pass]` for every first move, (2) `[move, cast, pass]`,
(3) dash branches, (4) post-dash casts. Alpha-beta takes most of its cutoffs from
a good FIRST move, so stage 1 carries most of the value; the later stages exist so
nothing is unreachable.

Measured over 30 random legal midgame positions:

| | cost |
|---|---|
| lazy: first 64 ordered turns | **77 us** |
| full enumeration: all turns | 24.4 ms (mean 142,098 turns) |
| speedup to a usable move list | **~266x** |

`lazy_iterator_covers_every_first_move` asserts stage 1 offers exactly the same
first moves (target AND push destination) that full enumeration does, so ordering
never becomes hiding.

## Move ordering from Robi's human-play framing

A push is two decisions - which enemy stone you DEPORT, and where you SEND it.

**Deport value** (`deport_value`): mana nodes weigh heaviest (they drive refill
tempo); then stones sitting in a sigil either side is close to charging; then
"most dangerous", measured as pressure on our adjacent stones' escape distance, so
a stone that is nearly crushing one of our groups ranks high.

**Destination value** depends on what we are threatening (`placement_goal`), where
"threatening" means charged OR one node short - the point at which a human starts
playing for it:

| threatening | goal | objective |
|---|---|---|
| nothing | `Voids` | park them where they charge nothing |
| Hail Storm | `SpreadSigils` | maximise DISTINCT 3-/5-node sigils holding an enemy stone (it kills one per sigil) |
| Decay | `Fragment` | maximise enemy stones with >= 2 empty neighbours (its exact trigger) |
| Hurricane | `Coalesce` | maximise the SMALLEST group's size (it kills the smallest, so one big group kills everything) |

Mana is never a valid destination under any goal.

### Gust without materialising C(empties, displaced)
Displaced stones are interchangeable, so an outcome is a SET of landing nodes and
the additive proxy score is a sum over nodes. So the best set is the top-n by
`destination_value`, and successive sets follow by swapping one element for the
next-best unused node - a best-first frontier over sets (binary heap), never the
full C(m,n). The shortlist is then re-ranked by the EXACT `configuration_value`,
which is what the spread / fragment / coalesce objectives actually measure (they
are not additive). This is why humans do not agonise over Gust turns: once you
know where you want stones to end up, the plausible set is small.

Each goal is verified to change behaviour measurably:
`gust_sends_enemy_stones_to_voids_by_default`,
`gust_spreads_across_sigils_when_threatening_hail_storm`,
`gust_fragments_when_threatening_decay`,
`gust_coalesces_when_threatening_hurricane`.

## Alpha-beta search, and what it revealed about the evaluation

`search.rs`: iterative deepening, negamax alpha-beta, Zobrist TT, killer moves,
aspiration windows, threefold-repetition-aware (blue wins), progressive widening.

### Completed depth (self-play games, the way the JS arena measured it)
| config | completed depth |
|---|---|
| shipped JS Caveman @ 10 s/move | **3.65** |
| this engine @ 200 ms/move | **6.32** (max 11) |
| this engine @ 2 s/move | **8.10** (max 14) |

Two bugs found while measuring, both worth remembering:

1. **Benchmarking on random positions is invalid here.** 52% of independently-placed
   random positions are ALREADY game over, because red needs a real lead of 4 and
   blue only 2. Depth measured that way looked like 1.25. Measure over played games.
2. **Expanding the full move set collapses the search.** With b ~ 10^4, generation
   not evaluation dominates and depth fell to ~1.25 — worse than the shipped engine,
   which reaches 3.65 precisely BECAUSE it collapses b to ~34. Progressive widening
   (expand the best-ordered K, K shrinking with remaining depth) is the standard fix
   for this shape; Arimaa (~17k moves/turn) is the closest analogue. This is NOT the
   old failure mode: every move is still GENERATED and ranked, widening only bounds
   how many get expanded, it is reported in `SearchStats::widened`, and raising
   `width_scale` recovers any of them.
3. **Never accept a move from a timed-out iteration.** `root_search` originally
   committed its best move even when the iteration was cut short, so a partially
   searched move could displace the previous depth's fully searched choice.

### The evaluation is now the bottleneck, not the search
20x thinking time was worth only ~57.5% (40 games), which is far too little for two
extra doublings. Diagnosis: the material signal is COARSE AND SPARSE — every move
places a stone, so the differential oscillates 1,0,1,0,... and only moves when a
crush or a destructive spell fires. (Robi's correction, recorded: that pattern is
normal play, not a pathology — a game where blue converts a positional edge into a
net stone on turn 12 looks exactly like this. The problem is the *sparsity* of the
signal between those moments, not that it never moves.)

### Positional weights: the cap is the whole story
`caveman-ai.js` computes
`score = stoneDiff + mana*manaDiff - voidPenalty*voidDiff + mapControl*mcDiff`
in stone units, and `cavemanCapWeights` holds the positional part strictly
sub-material: `3*mana + 9*voidPenalty + 39*mapControl <= 0.96`, so "position only
ever breaks material ties, never outbids a stone". The `mc=0.0246` in the committed
arena command is exactly 0.96/39.

Violating that cap is fatal. Colour-swapped 80-game arenas vs material-only:

| eval | worst-case positional total | score |
|---|---|---|
| my first structural set (liberties, thresholds, sigils) | several stones | **22.5%** |
| Robi's classic scale (mana 0.3, control 0.05) | 0.9 + 1.95 = 2.85 stones | **17.5%** |

With 39 nodes an 0.05/node influence term can outbid nearly two stones.

Capped, caveman-faithful, at 40 ms/move (~depth 4.6-4.8) vs material-only:

| arm | games | score | their 2026-08 result at ~depth 4 |
|---|---|---|---|
| capped map-control (96/39 per node) | 100 | **36.0%** | 47.0% (p=.40) |
| capped mana + void | 200 | **53.5%** | 44.5% (p=.12) |

So map-control actively hurts here, while mana+void is mildly positive — the
reverse of the earlier campaign's ordering. 53.5% over 200 games is ~1.0 sigma, so
suggestive only; `ai/config.py`'s own gate is 55% over 400 games, which this does
not yet pass. The depth-interaction question Robi raised (does the verdict change
now depth is cheap?) needs the same arm run at a longer time control.

## STRENGTH RESULT: the gate passes against the deployed engine

First measurement against what actually ships (every earlier arena was this engine
against itself). Rust engine, material-only eval, vs the deployed JS Caveman loaded
from the same ten files in the same order as `ai-worker.js`, `cavemanSearch` called
directly:

| time/move | games | rust | caveman | rust score | rust depth | caveman depth |
|---|---|---|---|---|---|---|
| 200 ms | **402** | 268 | 134 | **66.7%** | 5.9 | 1.7 |
| 1 s | 16 | 12 | 4 | 75.0% | 7.36 | 2.74 |

402 games colour-swapped: **66.7%, SE 2.4%, z = 7.1**, 95% CI [62.1%, 71.3%].
`ai/config.py`'s own gate is 0.55 over 400 games, so this **PASSES** with room.
Per-shard spread 59.0% / 65.7% / 75.4% shows how much variance the spell draw
carries — single-digit-game matches here are worthless.

The margin GROWS with time control (57.5% at 200 ms in an early 40-game run, 75% at
1 s), which is what you would expect from converting time into depth ~3x better
rather than from a better evaluation: the eval is pure material in both engines.

Two bugs in the harness, both of which would have made the arena silently
meaningless, are recorded in the bridge commit: readline not awaiting async
handlers (both sides played as red), and double-advancing the turn counter.

Caveat worth keeping in view: at these time controls the deployed engine only
reaches depth 1.7-2.7, well short of the 3.65 the committed 10 s/move arena runs
measured. A matched 10 s/move gate is the honest confirmation, and at ~36
core-hours it is the first thing actually worth renting CPU for.
