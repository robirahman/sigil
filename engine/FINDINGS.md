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
+1 token. The rule is the **±3 lead and it is SYMMETRIC IN SCORE** — each side wins
on a score lead of 3, where blue's score is its real stones **+1**. In REAL STONES
that is red +4 / blue +2, and quoting only the real-stone half without naming the
unit reads as an off-by-one to anyone thinking in score.
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
   random positions are ALREADY game over, because in REAL STONES red needs +4 and
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

## The search is blind to dashes at shallow depth — diagnosis confirmed, fix failed

Robi's playtest (~1400, engine lost) reported that the engine does not see a player
dashing to place TWO stones in one turn — to fill a sigil and cast it, or to spend
stones that were about to be crushed. Confirmed as a code fault, not a horizon effect.

`TurnIter` yields turns in STAGES: Moves, MoveCast, Dash, DashCast. Progressive
widening then takes the first K (6 near the leaves, 40 deep). Over 120 legal
midgame positions the first dash turn sat at **median index 40, p90 284**, so:

| depth remaining | width | positions where the first dash was outside the budget |
|---|---|---|
| 6+ | 40 | 61/120 |
| 4 | 24 | 78/120 |
| 2 | 10 | **118/120** |
| 1 | 6 | **119/120** |

At shallow depth — most nodes in the tree — the search never generated a dash for
either side. That also explains the playtest's `win in 7` that evaporated: the
refutation was a dash the widening never produced.

### Two attempted fixes, both measured regressions

Best-first merge across move/cast/dash classes with a per-class quota, colour-swapped
over 80 games at 200 ms against the stage ordering:

| variant | score | Elo | depth |
|---|---|---|---|
| merge everywhere, whole-turn simulation scoring | **21.2%** | −228 | 4.31 vs 5.62 |
| merge near the root only, simulation-free scoring | **16.2%** | −285 | 5.64 vs 5.81 |

The first lost partly on cost: scoring resolved cast outcomes per candidate and cost
**88–93% of node rate**. The second removed that (depth is level), and still lost —
which isolates the cause: **the ordering itself is worse**. Reserving budget for
dashes displaces stronger moves, and the cheap dash valuation (tempo credit, sigil
completion) over-rates them.

An incidental discovery: generating dash and cast turns is *inherently* expensive,
and the old ordering was fast precisely BECAUSE laziness never reached those stages.
Any real fix has to make dash generation cheap, not merely fair.

Kept behind `Search::set_merge_min_width` (default `usize::MAX`, off) so the next
attempt has a harness. The blindness is real and still unfixed.

## Dash blindness, attempt 3: filter the class instead of quota-ing it (2026-08-27)

Robi's framing, which is what finally worked: do to dashes what was done to Gust —
don't rank the whole class, GENERATE only the part a human would consider.

A dash earns a slot when it does one of the things players actually dash for:

| reason | test |
|---|---|
| `CRUSH` | the dash's move crushes an enemy stone outright |
| `SPELL_CRUSH` | it leaves MORE enemy stones crushable by an ALREADY-CHARGED spell than the same turn would without dashing |
| `FILLS` | it lands the last stone of a sigil — dash, fill, cast, one turn |
| `MANA` | it claims a mana node |
| `DOOMED` | the stones spent had no escape and were lost anyway |

Two corrections from Robi shaped `SPELL_CRUSH`, and both matter:

1. Not "a 1-node spell" but **any spell already charged that can hard-move**.
   Carnage, Tsunami, Torrent and Fury all pay for a dash that encircles a group
   first; a one-node crusher only helps if it happens to be charged already. So the
   set is classified off the RESOLVER (`Resolve::HardMoves`, `SoftHardChain`,
   `SurgeMove`, `Fury`, plus the restricted steppers Lurk/Meteor/Comet/Azimuth/
   Charge/Erupt/Eclipse/Syzygy), not off the spell's sigil size.
2. The gain must be **marginal**. A dash that seals a stone you could already crush
   without it has spent two stones for nothing, so the crushable count is compared
   against the no-dash baseline rather than against zero.

### Measured: the blindness is gone

120 midgame positions sampled from engine-vs-engine play, index of the first dash
turn in the ordered stream:

| ordering | median | p90 | dash inside width 4 / 6 / 10 |
|---|---|---|---|
| stage order (shipped before) | 12 | 171 | 0 / 12 / 37 of 120 |
| key-dash filter | **3** | **7** | **103 / 103 / 114** of 120 |

The 17 positions with no dash in the first four are positions where nothing passes
the filter — which is the intent, not a miss.

### Why this differs from the two attempts that lost

Both earlier fixes gave dashes a QUOTA of the width budget (`take_each = width.max(8)`),
so at width 10 up to two thirds of the budget went to a class that is mostly junk.
This reserves ONE slot in four (`KEY_DASH_EVERY`), never re-sorts the plain moves,
and only fills the slot when a dash passes the filter. Displacement is bounded at
17-25% instead of 66%, and what displaces is a dash that does something.

### Gates

* 58/58 Rust unit tests, including `the_key_dash_filter_never_invents_an_illegal_turn`
  (promoted dashes must all appear in full enumeration) and
  `a_key_dash_is_reachable_inside_a_narrow_width_budget`.
* `parity_primitives` 4,000 positions OK.
* Emit gate: **4,335 (position, turn) pairs replayed through the real `applyAITurn`,
  0 mismatches**, 30/30 castable spells covered, 347 dash + 258 sacrifice actions.

## The `hard` arena result was invalid — a Python default re-enabled the regression

`merge_min_width` shipped in `1f61f1f` with the **Rust** default `usize::MAX` (off,
because the merge is a -285 Elo regression) and a **Python binding** default of
**32** (on). `vs_caveman.py` passes the argument positionally and never reached it,
so every cloud arena launched on that commit ran the crippled engine.

That is what the 120-game `hard` campaign measured: 44.2% (53-67) against
`__ai_hard__`, i.e. ~993 — consistent with the -285 Elo the merge was already known
to cost, and NOT a strength result. It also explains the apparent non-transitivity
(beating `positional` and `very_hard` while losing to the weaker `hard`).

Fixes, both structural rather than a corrected constant:
* `play_best`'s `merge_min_width` and `key_dash_reasons` are now `Option`. Absent
  means "leave the engine's own default alone", so a binding default cannot drift
  from the Rust default again.
* `search_defaults()` reads the knobs off a real `Search`, and `vs_caveman.py`
  prints an `ENGINE CONFIG` line into every arena log. A result can no longer be
  ambiguous about which engine produced it.

This is the second time a stale structural default silently invalidated reported
numbers (the first was `pick_move_actions` never setting `s.weights`). Both had the
same shape: a default restated in a second place.

### Per-reason A/B, 250 games per arm, 300 ms/move (2026-08-27)

Every arm is the same binary against the same pre-fix stage ordering, merge held
off in both sides, colour-swapped and seeded. `min_w` reserves the dash slot only
where the width budget is at least that.

| rules | min_w | games | score | SE | Elo | depth new/old |
|---|---|---|---|---|---|---|
| CRUSH | 0 | 250 | 47.6% | 3.2% | −17 | 5.52 / 5.88 |
| CRUSH\|SPELL_CRUSH | 0 | 250 | 39.2% | 3.1% | −76 | 5.48 / 5.88 |
| CRUSH\|SPELL_CRUSH | 16 | 250 | 48.8% | 3.2% | −8 | 5.79 / 5.90 |
| CRUSH\|SPELL_CRUSH\|FILLS | 0 | 250 | 33.6% | 3.0% | −118 | 5.51 / 5.87 |
| all five | 0 | 250 | 34.0% | 3.0% | −115 | 5.47 / 5.86 |
| all five | 16 | 250 | 46.4% | 3.2% | −25 | 5.83 / 5.90 |

Two monotone trends, and neither is noise at this sample size:

* **the more reasons are live, the worse it plays** — CRUSH alone −17, adding
  SPELL_CRUSH −76, adding FILLS −118;
* **the more the filter is gated off (`min_w`), the closer to neutral** — the best
  arms are the ones that do the least.

So the reserved slot is a cost with no measurable payoff, and the payoff is absent
even for CRUSH, the most tactically justified rule. This is the fourth measured
attempt at the dash blindness and the fourth regression.

A plausible reading, and one that connects to the eval work rather than the
ordering work: **a material-only eval cannot price a positional dash.** FILLS is
worth something only if the cast it enables is worth something, which material
scoring sees only when the cast wins stones outright; MANA and DOOMED are purely
positional. Promoting those turns spends budget on moves the leaf evaluation is
structurally unable to reward — which would also explain why CRUSH, the one rule
whose payoff IS material, is the least bad.

### The decisive experiment: strictly additive, 490 games per arm (2026-08-27)

Every earlier attempt confounded two things — the dashes the search gained and the
moves it lost to make room. `key_dash_extra` APPENDS key dashes to the successor
list instead of reserving slots inside it, so the search still sees every turn it
saw before. A loss on this path can only be the cost of the extra subtrees.

| rules | min_w | extra | games | score | SE | Elo | depth new/old |
|---|---|---|---|---|---|---|---|
| CRUSH | 0 | 1 | 490 | 39.6% | 2.2% | −73 | 5.50 / 5.91 |
| CRUSH | 0 | 4 | 490 | 42.9% | 2.2% | −50 | 5.50 / 5.93 |
| CRUSH | 16 | 4 | 490 | **50.6%** | 2.3% | **+4** | 5.86 / 5.98 |
| all five | 0 | 4 | 490 | 35.5% | 2.2% | −104 | 5.28 / 5.93 |

**The additive path loses too.** So it was never displacement: the extra subtrees
cost 0.4-0.6 ply of depth, and that depth is worth more than the dashes. The one
arm at parity (+4 ± 17) is the one gated to `min_width >= 16`, i.e. the sparse upper
tree, where it fires rarely enough to cost nothing — and it gains nothing either.

### Conclusion after four attempts

The blindness is real, was correctly diagnosed, and is now closed on demand — the
first dash in the ordered stream moves from median index 12 (p90 171) to median 3
(p90 7), and from 37/120 positions inside width 10 to 114/120. **Closing it does
not make the engine stronger**, by four independent constructions:

| attempt | mechanism | best result |
|---|---|---|
| 1 | class quota, whole-turn simulation scoring | 21.2% (−228) |
| 2 | class quota, simulation-free scoring | 16.2% (−285) |
| 3 | interest filter, reserved 1-in-4 slot | 47.6% (−17) |
| 4 | interest filter, strictly additive | 50.6% (+4) |

Attempts 3 and 4 are far better than 1 and 2 — the filter is the right idea and
Robi's Gust analogy holds — but the ceiling is parity, not gain.

Everything ships OFF (`key_dash_reasons: 0`), and the shipped default is verified
bit-identical to the pre-change engine (same completed depth and same node count on
four seeds). The machinery stays reachable behind `set_key_dash_*`.

**Where this points.** The per-reason ordering is the informative part: CRUSH, the
only rule whose payoff is material, is the least bad (−17 / +4); the purely
positional rules are the worst (FILLS took the reserved-slot arm from −76 to −118).
A material-only eval cannot price a dash that fills a sigil or claims a mana, so
surfacing those turns spends search budget on moves the leaf evaluation is
structurally unable to reward. The next lever is therefore the EVAL, not the
generator — which is also the one place a 39-node bitboard at depth ~6 has headroom
the old Python/JS engines never had.

# Phase A/B, 2026-08-27

## A3 CORRECTION: depth scaling is NOT flat. The old measurement was wrong.

`FINDINGS.md` has said "20x thinking time was worth only ~57.5% (40 games)" and that
claim has been load-bearing for two plans. It was forty games — SE +/-7.8%, i.e.
52 +/- 55 Elo — and it does not survive re-measurement.

Re-run with SPRT (`engine/harness/ab_time.py`), same engine against itself at a time
ratio, colour-swapped, seeded, merge held off, 3 shards x 100 pairs per arm:

| eval | mult | games | score | Elo | 95% CI | Elo/doubling | SPRT |
|---|---|---|---|---|---|---|---|
| material | 2x | 529 | 55.4% | +38 | [+8,+68] | +38 | continue |
| material | 4x | 283 | 68.2% | +133 | [+91,+178] | +66 | **H1** |
| material | 8x | 180 | 68.9% | +138 | [+86,+197] | +46 | **H1** |
| material | 16x | 95 | 68.4% | +134 | [+64,+218] | +34 | continue |
| structural | 2x | 485 | 62.7% | +90 | [+59,+123] | +90 | **H1** |
| structural | 4x | 288 | 69.8% | +145 | [+104,+192] | +73 | **H1** |
| structural | 8x | 181 | 68.0% | +131 | [+79,+189] | +44 | **H1** |
| structural | 16x | 104 | 90.4% | +389 | [+298,+554] | +97 | **H1** |

**34-66 Elo per doubling on material is a HEALTHY curve** (40-70 is normal), with the
usual diminishing returns. 16x time is worth +134 Elo, not the +52 previously
believed. So "the search is fine but depth buys nothing" is false, and any argument
resting on it — including the headline framing of the current plan — has to be
rebuilt.

What survives, and is arguably more useful: **the structural eval scales
substantially better with time than material does** (+389 vs +134 at 16x, and a
steeper per-doubling curve throughout). A richer evaluation converts depth into
strength more efficiently. That is a direct, positive argument for the learned-eval
programme, and it replaces the flat-scaling argument that just died. Caveat: the 16x
arms are ~100 games with wide intervals, and these are two separate self-play
ladders rather than a head-to-head.

## The one-stone-per-ply parity wave is real, and now fixed

Every move PLACES a stone, so the side that has just moved is exactly one stone up on
that account alone. Root score at fixed search depth, material eval, five real
midgame positions:

```text
 seed     d1    d2    d3    d4    d5    d6    d7    d8    d9   d10
   11    100     0   100     0   100     0   100     0   100     0
   19      0  -100     0  -100     0  -100     0  -100     0  -100
   33      0  -100     0  -100     0  -100     0  -100     0  -100
```

A pure square wave of exactly ONE STONE per ply with no convergence — and blue wins
on a real lead of 2. The structural eval is *worse*: 152 centistones/ply, because its
extra terms also move when a stone lands. That plausibly explains why every richer
eval tried so far lost (22.5%, 17.5%) and why capped sub-material positional terms
were inert: they were being stacked on top of a one-stone square wave.

`Weights::tempo` (default 50 centistones to the side to move) is the exact
first-order correction — the side that has just placed looks +1, so the side to move
sits half a stone below the mean. Measured effect:

| eval | mean \|score change per extra ply\|, d3..d8 |
|---|---|
| material | 96 centistones |
| material + tempo | **4 centistones** |

Note what this does and does not buy. It removes an artifact; it does not add
knowledge — with material-only the corrected score is now *constant* across depth,
because material genuinely has nothing to say about these positions. And it does not
explain the strength numbers on its own: within a single fixed-depth search all
leaves share the same parity, so alpha-beta's comparisons were already consistent,
which is exactly why scaling could be healthy despite the wave. The wave mainly
corrupted the reported score, the aspiration window and cross-depth comparisons at
early terminations. Whether it is worth Elo is an open SPRT question, not a claim.

## Two silent-default hazards closed

* `hand_features` returns the raw quantity each `Weights` field multiplies, and a
  test asserts `evaluate(c, w) == dot(w, hand_features(c))` over 7 weight sets x 40
  positions x both colours. It **failed on first run**: `eval.rs` multiplied the
  weight in before dividing by sigil size, truncating differently from the feature
  path. Fixed by summing the feature and applying the weight once. Without that
  invariant a fitted weight vector would have meant something subtly different from
  what the search computes.
* The eval-name resolver existed in **three** copies with `_ => Weights::default()`
  fallbacks, and one copy was missing several presets. A typo'd or new name silently
  selected the structural eval — the same shape as the `merge_min_width` binding
  default that invalidated a 120-game campaign. Now one `weights_by_name` that
  **errors** on an unknown name.

## B4: the tempo fix is Elo-neutral, and the structural eval is mispriced 27x

Six arms, `ab_eval.py`, SPRT, colour-swapped, merge off, 300 ms matched-time or
depth 6 matched-depth:

| arm | vs | mode | n | score | Elo | 95% CI | SPRT |
|---|---|---|---|---|---|---|---|
| mtempo | material | time | 277 | 45.5% | −31 | [−73,+9] | continue |
| mtempo | material | depth | 95 | 52.6% | +18 | [−52,+90] | continue |
| structural | material | **time** | 283 | **19.4%** | **−247** | [−304,−200] | **H0** |
| structural | material | **depth** | 95 | **63.2%** | **+94** | [+24,+172] | continue |
| structural | mtempo | time | 278 | 14.7% | −305 | [−371,−253] | **H0** |
| structural | snotempo | time | 250 | 46.4% | −25 | [−69,+18] | continue |

**The tempo correction is Elo-neutral.** −31 [−73,+9] at matched time and +18 at
matched depth: a wash, possibly slightly negative. It flattens the parity wave
beautifully (96 → 4 centistones/ply) and makes the reported score readable, but it
does not buy strength. The hedge in the previous section was the right call, and the
hypothesis that the wave was what killed richer evals is **dead** — removing it
changes the structural set's result by −25 Elo, not by the +250 that hypothesis
needed.

**The real defect is that the structural set is priced 27x too high.** Worst-case
positional contribution, using each feature's maximum on a 39-node board:

```text
  near_threshold      |w|=150 x   1 =  150
  own_zero_liberty    |w|= 70 x   6 =  420
  own_one_liberty     |w|= 20 x   6 =  120
  enemy_zero_liberty  |w|= 70 x   6 =  420
  enemy_one_liberty   |w|= 20 x   6 =  120
  sigil_stone         |w|= 14 x  27 =  378
  sigil_charged       |w|= 80 x   9 =  720
  mana                |w|= 40 x   3 =  120
  sixth_spell_danger  |w|=130 x   1 =  130
  TOTAL                          = 2578 centistones = 25.8 STONES
```

The production engine holds this below **96** centistones so "position only ever
breaks material ties, never outbids a stone". 2,578 is **27x** the budget, in a game
where blue wins on a real lead of 2 — the eval can outbid twelve wins' worth of
material.

That reconciles the two halves of the table, and it is the most useful result here:
**at matched depth the structural knowledge is worth +94 Elo, and at matched time
its pricing throws away 247.** The verdict is "re-price", not "abandon" — which is
exactly the distinction the matched-nodes/matched-time split was added to expose,
and which the four dash experiments never had.

So the next experiment is a scale sweep, not a new feature: `scaled_structural()`
plus presets `s04` / `s12` / `s25` / `s50`. `s04` sits at roughly the production
0.96-stone budget; `s100` is the current default. Both ends are known-bad, so the
answer is in between or nowhere.

## A third instance of the silent-default hazard

`pick_successor` never set `s.weights`, so `/api/pick` silently ran the 25.8-stone
structural set. It is not the route the browser client uses (`rust-ai.js` posts to
`/api/move`, which goes through `pick_move_actions` with `--eval material`), so no
published measurement or playtest was affected — but it is the same shape as the two
that did invalidate results. Now takes `eval_name`, defaulting to `material`.

## The eval's MAGNITUDES were the problem, and fixing them scales with depth

Three shapes, each rescaled by `at_budget()` to exactly 1.00x the production
96-centistone budget, so the comparison isolates SHAPE from SCALE. Against
material-only, colour-swapped, SPRT:

| shape | 300 ms | 3000 ms | 10000 ms |
|---|---|---|---|
| `hand` (hand-chosen magnitudes) | **+40** [+20,+60] H1 | **+5** [−28,+37] | — |
| `tfit` (magnitudes from a texel fit) | **+42** [+22,+62] H1 | **+112** [+79,+147] H1 | **+159** [+96,+233] H1 |
| `tflip` (hand shape, 4 signs flipped) | **−38** [−59,−17] H0 | −14 [−63,+34] | — |

n = 1000-1200 at 300 ms, 450 at 3 s, 126 at 10 s.

**The hand magnitudes decay with depth; the fitted magnitudes grow with it.** That is
the whole result. Everything earlier in this file that reads "static positional
knowledge substitutes for depth in this game" was drawn from the `hand` row alone and
is wrong as a general claim -- it is true of those particular magnitudes and false of
better ones.

Where the two shapes differ, and why it plausibly matters at depth: `tfit` has a much
smaller `near_threshold` (56 vs 150) and `sigil_charged` (2 vs 80), and larger `mana`
(82 vs 40) and `sigil_stone` (36 vs 14). The hand set's two big DISCONTINUOUS bonuses
are exactly the kind of thing a deep search discovers unaided -- and can be actively
misled by -- while the smooth mana and sigil-progress terms encode long-horizon value
search cannot reach inside its horizon.

`tfit` pays for this in depth and still wins: 7.11 vs 7.38 ply at 3 s, 7.75 vs 8.23 at
10 s. So it is buying more than the ~0.3-0.5 ply it costs.

Three things this corrects, all mine:
* The `s04 = +93 Elo` claim was 442 games and regressed to +41 on 1200. My own SPRT
  self-check said a true zero needs ~900 games; I ran 440 and believed it.
* "The gain evaporates at longer TC" came from 200 games on the `hand` shape. With
  450 games and a second shape it is the opposite.
* The texel fit's SIGNS are not to be trusted -- `tflip` is -38 Elo -- but its
  MAGNITUDES are. That is a coherent split: signs on confounded observational data
  are unreliable, while relative magnitudes carry real information about which terms
  deserve weight.

### The beyond-search residual, on one subset

Excluding the 12.6% of positions the search had already solved:

```text
  (a') lead only               0.6623 nats
  (b') 12 features only        0.6483    features beat material by +0.0140
  (s)  search score only       0.6269    search beats the features by +0.0214
  (d)  search score + features 0.6190    features add +0.0079 on top of search
```

A depth-7 search absorbs ~44% of what the static features know; ~56% survives. That
residual is small in log-loss and large in Elo, which is the point: log-loss on
isolated positions understates an eval applied at millions of leaves, because
alpha-beta compounds leaf error. The arena is the instrument for eval value.

## RETRACTION: every ab_eval sample size was replication, not independence

`ab_eval.py` read `off = argv[5]` and `mode = argv[6]`, while the cloud runner
appended each shard's seed offset as the LAST argv element. Any arm that passed
`mode` explicitly -- which all of them did -- pushed the real offset to `argv[7]`,
where nothing read it. **Every shard therefore ran the same seeds.** At 60 s/move the
14 shards produced byte-identical games, verified by diffing two shard logs.

So a reported "56 games" was **four distinct games replicated fourteen times**. SPRT
assumes independent trials, so every SPRT verdict computed on an `ab_eval` run was
invalid, and every confidence interval was too narrow by roughly sqrt(workers).
Distinct games = reported n / workers.

Re-analysed by deduplicating on (seed, colour):

| run | shape | ms | reported | distinct | score | Elo | 95% CI |
|---|---|---|---|---|---|---|---|
| shape | `tfit` | 300 | 1200 | **300** | 57.7% | **+54** | [+14,+94] |
| shape | `tflip` | 300 | 1048 | **300** | 42.3% | **−54** | [−94,−14] |
| shape | `hand` | 300 | 1170 | **300** | 54.3% | +30 | [−9,+70] |
| shape | `tfit` | 3000 | 200 | 50 | 62.0% | +85 | [−10,+195] |
| longtc | `tfit` | 3000 | 450 | 50 | 68.0% | +131 | [+35,+251] |
| longtc | `tfit` | 10000 | 126 | 14 | 64.3% | +102 | [−76,+370] |
| gate60 | `tfit` | 30000 | 112 | 8 | 50.0% | 0 | uninformative |
| gate60 | `tfit` | 60000 | 56 | **4** | 100% | — | worthless |

### What survives and what does not

SURVIVES: **`tfit` beats material at 300 ms, +54 Elo [+14,+94] over 300 distinct
games**, and **`tflip` is genuinely bad, −54 [−94,−14]** -- so the texel fit's
MAGNITUDES help and its SIGNS hurt. Both rest on 300 independent games.

WEAKLY SUPPORTED: `tfit` at 3 s. Two independent 50-game samples, +85 [−10,+195] and
+131 [+35,+251]; pooled over 100 distinct games it is plausibly around +105, and both
samples point the same way.

WITHDRAWN: "+112 Elo at 3 s, +159 at 10 s, and the gain GROWS with time control", and
the 60 s figure entirely. The 10 s estimate rests on 14 games and the 60 s on 4.
**There is still no valid measurement at Robi's 60 s/move acceptance gate.**

Also withdrawn: the claim that the hand magnitudes DECAY with depth while the fitted
ones GROW. At honest sample sizes the long-TC arms cannot separate those hypotheses.

### The fix

The shard offset now travels in `$SIGIL_SHARD_OFF`, set by the runner, read by
`sprt.shard_offset()`. It can no longer depend on argv position. `ab_eval.py` also
prints its seed RANGE at startup, so two shards sharing seeds is visible in the log
rather than silently halving the information content.

This is the fifth "value written down in two places" failure in this project, and the
first that corrupted results rather than merely wasting time or money.

## The bottleneck is MOVE COVERAGE, not evaluation or depth

`width_scale` multiplies the progressive-widening schedule (6 successors near the
leaves up to 40 deep). Raising it, at eval `tfit`, vs the shipped schedule:

| `width_scale` | 300 ms | 3000 ms |
|---|---|---|
| 2 vs 1 | +29 [+8,+51] H1 | **+107 [+54,+165] H1** |
| 3 vs 1 | +38 [+20,+58] H1 | **+144 [+90,+206] H1** |
| 4 vs 1 | +47 [+28,+65] H1 | — |

Monotone in scale, and far stronger at the longer clock -- the opposite shape from
the evaluation work, which was ~+58 and flat. This is the largest effect measured in
the project, and it is a one-line default change.

It also wins while GIVING UP DEPTH: at scale 2, 4.73 ply vs 5.77. The engine would
rather see more moves than look further ahead.

### Why, quantified

Two direct measurements over 846 sampled midgame positions, searching to depth 6:

**True branching is far higher than assumed.** The ordered generator produces a
median of **316** turns (p10 125, p90 at the 400 cap). The plan's "~80-150" was an
underestimate; the search at scale 1 expands 6-40 of them, i.e. 2-13%.

**Where the best move ranks in the current ordering:**

```text
  median 1    p75 6    p90 42    p95 99    max 165
  within width   6:  73.8%
  within width  40:  88.9%
  within width  80:  93.9%
  within width 120:  97.2%
```

So the ordering is ALREADY GOOD at the median -- the best move is rank 0 or 1 most of
the time -- and the problem is entirely the tail: in ~11% of positions the move the
search wants is ranked beyond 40, and it simply never gets expanded. Widening from 40
to 120 (scale 3) lifts coverage 88.9% -> 97.2%, and that 8-point tail is worth +144
Elo at 3 s.

### What this says about NNUE vs a policy network

It argues against a value network. The binding constraint is which moves get
EXPANDED, not how accurately leaves are scored, and the residual positional
information beyond a depth-7 search score is small (+0.0079 nats).

It argues for a policy -- but the honest version of that case is narrower than
"policy is the answer". Widening already buys 97% coverage for free. A learned prior
would be worth the DEPTH that widening spends: reaching the same coverage at width
~20 instead of ~120 gives back the ply that scale 3 costs. That is a real prize, and
it is bounded by that ply rather than by the 11% coverage gap, which brute widening
already closes.

## SHIPPED: width_scale 4, and the 60 s gate passes

Full widening sweep vs scale 1, eval `tfit`, colour-swapped, SPRT, all H1:

| scale | 300 ms | 3000 ms |
|---|---|---|
| 2 | +29 [+8,+51] | +107 [+54,+165] |
| 3 | +38 [+20,+58] | +144 [+90,+206] |
| **4** | +47 [+28,+65] | **+223 [+155,+311]** peak |
| 6 | **+69 [+46,+92]** peak | +191 [+125,+272] |
| 8 | +56 [+33,+79] | +154 [+90,+230] |

Peaks at 4-6, worth MORE at the longer clock. `DEFAULT_WIDTH_SCALE = 4`, chosen
because 4 peaks at the longest control measured and 60 s/move is the target.

At scale 4 and 3 s the search reaches **5.47 ply against 7.68** -- it gives up 2.2
plies and still wins by 223 Elo. The schedule sat at 1 for the entire life of this
project, and it was the single largest loss in it.

### The 60 s acceptance gate

`tfit` vs `material`, 224 independent games at 60 s/move: **57.1%, +50 Elo [+5,+97]**,
depth 9.28 vs 9.62. Above the project's own 55% threshold, on 224 games rather than
400. Consistent across every control tested: +54 / +54 / +82 / +50 at
300 ms / 3 s / 10 s / 60 s. The evaluation gain is real and does not decay.

### What the tail is made of, and the next re-test

The rank data says the ordering is already optimal at the MEDIAN (best move at rank
0-1) and the whole deficit is the tail past rank ~40. `TurnIter` yields in STAGE
order -- every plain move, then move+cast, then dashes, then dash+cast -- so the tail
is systematically casts and dashes.

That makes two shelved results worth re-testing rather than replacing:

* `merge_min_width`, which interleaves the classes, measured **-285 Elo at scale 1**.
  That was a budget of 6-40, where merging starved plain moves. At 24-160 the
  arithmetic is entirely different.
* `key_dash` gated to wide nodes, already +19 [+3,+35] at scale 1 with `tfit`.

Neither is a new idea; both were measured under a narrow budget and a weaker eval,
and both of those premises have now changed.

## Policy-label data: 175,500 games, and the coverage curve on 1.39M labels

The full-scale generation run hit the plan's Phase D target. Watchdog-truncated at
8 h, but checkpointing meant the data survived:

```text
  positions                4,366,971
  independent games          175,500     (plan target: 150,000-600,000)
  with a search score       4,016,560
  with a POLICY label       1,392,592
  corrupt shards                   1 of 28  (0 bytes, see below)
```

Where the search's chosen turn ranks in the current ordering, on 1.39M labels rather
than the 846-position probe:

```text
  median 1   p75 5   p90 34   p95 63   p99 112   max 295
  coverage:  w6 = 75.5%   w24 = 86.9%   w40 = 91.5%
             w96 = 98.2%  w160 = 100.0%
```

This confirms the probe and sharpens the target. At the shipped `width_scale 4` the
budget runs 24 near the leaves to 160 deep, i.e. **86.9% coverage at the frontier and
100% at the root**; the old scale 1 (6-40) gave 75.5% and 91.5%. The gap a learned
ordering would close is w24 -> w96, **86.9% -> 98.2%**, and the prize is the ~2.2
plies that reaching w96-160 by brute widening costs.

### Checkpointing was not atomic

One shard came back 0 bytes: the watchdog killed it inside `savez_compressed`, which
rewrites the target file IN PLACE. A corrupt shard is worse than a missing one
because it breaks the loader for every other shard. Now writes to `<out>.tmp.npz` and
`os.replace`s it, so a reader never sees a partial file.

Worth recording how that fix went wrong twice before it worked: `savez_compressed`
appends `.npz` unless the name already ends in it, so the first temp name became
`positions_0.npz.tmp.npz`; and the anchored edit that inserted the rename matched
nothing and failed SILENTLY, leaving the temp file as the only output. The check that
caught both was running the generator and asserting the output loads and no `.tmp`
remains -- not reading the diff.

## Adaptive widening: the budget follows the position

The coverage gate passed at **grad-boost AUC 0.8947** / logistic 0.8403 for predicting
"this position's best move lies beyond width 24", over 1,392,592 labelled positions
from 175,485 games, split by game. Its most useful number was the ORACLE floor: a
perfect predictor reaches 98% coverage at average width **10.5**, against **96**
today -- a ~9x reduction in effective branching, which sizes better move SELECTION far
above the 2.2 plies uniform widening costs.

### The model is nearly free

| feature set | AUC |
|---|---|
| all 132 | 0.8403 |
| no `control_diff` | 0.8401 |
| no control, no castable (113) | 0.8341 |
| **31 cheap: sigil fills + scalars** | **0.8306** |

`control_diff`, a 12-layer flood fill and by far the most expensive feature,
contributes **nothing**. The shipped model is 31 features the board already
maintains -- a few popcounts and a 31-term dot product, well under 2% of a ~6.4 us
node. Coefficients are fitted on RAW features so the engine carries no mean/scale
table, and the logit is compared against a pre-transformed threshold so no `exp` runs
in the search.

What the threshold buys, on the held-out split:

```text
  threshold   %wide   coverage (w24 easy / w96 hard)
       0.10   42.4%                          96.7%
       0.20   23.4%                          93.6%
       0.50    3.2%                          88.0%
  uniform w96  100%                          98.1%
```

At threshold 0.10 the average width is ~54 instead of 96 for 1.4 points of coverage.

### Guards

Two tests, both of the kind that has caught real drift here: `hard_logit` must be a
deterministic, finite function of exactly the 31 columns sliced out of
`full_features` (the same shape as the `evaluate == dot(weights, hand_features)`
invariant), and adaptive widening with BOTH scales equal to the shipped one must
reproduce the uniform search **node for node**.

Default is `None` -- uniform -- until an arena says otherwise.

## The cast keep choice was never enumerated (2026-09-08)

The largest rules gap found in the engine so far, and the only one measured against
the recorded game history rather than against synthetic positions.

### What the rules are

Casting a charged spell clears the spell's sigil, and the caster then places `mana`
stones back onto nodes **of its choice**. `game-controller.js:644-718` — the live
game — emits `chooserefills` and prompts "Select a stone to keep:" once per refill,
skipping the prompt only when `refills >= emptyNodes.length` leaves no degrees of
freedom. The choice is `C(n, mana)` over all of the sigil's nodes, at most
`C(5,2) = 10`.

`sim-board.js:1633 _castClearAndRefill` substitutes ONE fixed priority order for
that choice — 5-node `[2,3,4,0,1]`, 3-node `[2,1,0]` — and `engine/src/cast.rs`
mirrored sim-board rather than the rules (its comment reads "JS priority", so the
port was faithful to the wrong reference). **The bug therefore predates the Rust
engine and the whole AI lineage shares it.**

### How it was found, and how the harness was validated

`eval_drop_audit.py --checks b` asks, for every turn in `completed_games`, whether
the engine's own enumeration can produce the layout that was actually played.
Over 2,403 games / 66,820 positions it found **2,016 turns the engine cannot
generate**.

The control was already inside the run: the 165 human-vs-rust games contain 2,305
turns the Rust engine played itself, through the identical Firebase -> replay bridge
-> SFN -> `enumerate_turns` pipeline. **0 of 2,305 were unreachable**, so the
pipeline is faithful. The rate then orders itself by how much of the move space a
player uses — human 6.67%, ai_very_hard 2.71%, ai_hard 1.31%, ai_medium 0.20%,
ai_easy 0.09%, rust 0.00% — which a harness bug would not do.

Also required: separating the **5,809 out-of-scope flags** (spell pools the engine
does not implement — Fissure, Gush, Thunder, Rock_Slide, Endowment, Bulwark,
Lifesap — or state SFN cannot carry: Providence `pm:`, Aftershock `ab:`, Ambush
`sn:`). Mixing them in reports 12% of turns unreachable instead of 3%.

### The natural experiment that identified the cause

Over 4,598 audited casts matched to a sigil position:

| played by | keeps by priority | keeps differently |
|---|---|---|
| human | 25/725 = 3.4% missed | **1001/1644 = 60.9% missed** |
| ai_hard | 24/705 = 3.4% | 0/7 |
| ai_very_hard | 18/351 = 5.1% | 1/2 |
| ai_easy | 9/483 = 1.9% | 0/0 |
| **rust** | **0/252 = 0.0%** | 0/0 |

Every engine keeps by priority in ~100% of its casts because none has a chooser;
humans are prompted and keep differently in **69.4%**. The two groups differ by
which code path chose the keep, so this is not a correlation.

Ruled out by measurement, not argument: `OUTCOME_CAP` truncation
(`layout_nearest` reports `resolver_truncated` 0/83 and `turn_cap_truncated` 0/83,
and the Hamming distance to the nearest enumerated layout is almost always 1 or 2 —
one stone misplaced, not a missing turn shape); and dash generation
(dash-without-cast was **0/5,671**, which also closes the `key_dash` "unenumerable
dashes" as an identity bug).

### The fix

`Board::keep_options` / `keep_count` / `cast_clear_and_keep`, with **index 0 the
priority order**, so `cast_clear_and_refill` is `cast_clear_and_keep(.., 0)` and
enumerating the rest is a provable superset. `Action::Cast` gained `keep`;
`apply_turn` and `emit_actions` replay it. Both full-enumeration cast branches
expand every keep. The ordered stream expands them too, windowed by the
`keep_window` Search knob and **stratified round-robin** — scoring the (keep,
outcome) pairs jointly collapsed the entire window onto keep 0, because
`configuration_value` often cannot tell two keeps apart and the tie-break to the
lower index took everything. Full enumeration being complete buys nothing if the
search never sees the options.

### Results

| gate | before | after |
|---|---|---|
| unreachable turns (2,403 games) | 2,016 (3.13%) | **675 (1.05%)** — 66.5% recovered |
| human-played | 1,623 (6.67%) | **318 (1.31%)** — **80%** recovered |
| engine-played | 377 | 353 — 6-7% |
| node rate, kw=1 / 2 / 3 / 10 | 20.15 us/node | 18.04 / 19.38 / 21.47 / 25.74 |
| `cargo test` | 75 | **84 passed, 0 failed** |
| `parity_primitives` | — | 4,000 positions, OK |
| `run_emit_gate` | — | **12,474 matched, 0 mismatch**, 30/30 spells |

Engine-played misses barely move because those engines already kept by priority;
their residual has other causes. Of the 675 remaining, 417 show no spell-counter
change — charm casts (charms skip `finish_cast`) and non-cast turns, i.e. a
different gap: `enumerate_post_dash` emits only `Pass` or `Cast`+`Pass`, and
`RESOLVER_LEVEL_COMPLETE` in turn.rs lists the resolver choice points still
outstanding.

### Elo: NEUTRAL in self-play, at every dose

| arm | games | win rate | Elo |
|---|---|---|---|
| keep_window 2 vs 1 | 7,040 | 49.94% [48.78, 51.11] | **-0.4 [-8.5, +7.7]** |
| keep_window 10 vs 1 | 6,997 | 49.91% [48.74, 51.08] | **-0.6 [-8.8, +7.5]** |

Not a dose problem: at kw=10 the search picks a **non-priority keep 40.9%** of the
time (38 of 93 cast positions at depth 4), so it is making different decisions and
they are neither better nor worse — the eval cannot tell a good keep from a bad
one. Fourth instance of the pattern, after the leaf eval, the width classifier and
the re-ranker.

**Why self-play understates THIS knob specifically.** Engine-vs-engine, both sides
draw keeps from the same distribution, so "the opponent always keeps by priority"
is a *correct* opponent model. Against a human it is wrong 69.4% of the time in
cast positions. No self-play SPRT can see that cost, and the right instrument for
the reported symptom — an eval of +0.5 into a mate-in-one — is **Check A**, the
eval-drop audit over real human games (~630 CPU-hours), which has NOT been run.

Ship it as a correctness fix at `keep_window = 2`. Do not sell it as an Elo lever.

### Four collateral bugs, each found by a test or a log rather than by reading

1. The ordered generator stored `Action::Cast::outcome` as a position in the
   **sorted** `resolve_outcomes_ordered` list while `apply_turn` applies it against
   the **raw** list — so the search applied a resolution it had not scored.
   `resolve_outcomes_ranked` returns raw indices.
2. `ordered_dash_branches` built `sacs` in `sacrifice_cost` order against
   `turn.rs`'s node order, so one dash compared and hashed as two turns under the
   derived `PartialEq`/`Hash`. One `sort_unstable()`; changes no board, only turn
   identity, so TT probes, killer matching and the emit gate stop missing.
3. `legal_draw` seeded its xorshift with `seed | 1`, so seeds 2n and 2n+1 gave the
   SAME draw. Caught by an SPRT whose first 22 games had 5 of 5 seed pairs identical
   in winner AND ply count — an SPRT over duplicated games understates its variance
   and reaches a boundary with false confidence. SplitMix64, and a test.
4. `--limit-games` was ignored on the audit's pre-hydrated path, so a fleet smoke
   gate audited all 2,403 games, ran past `runner.sh`'s 900s timeout, and a
   90-vCPU VM spent its entire life inside its own smoke test.

Two tooling repairs of the same kind: `buildtest.sh` piped cargo through
`tail -30`, and since cargo prints errors first and the summary last it showed
"5 previous errors" while hiding four of them; and the parity/emit harnesses need
`SCRATCH` plus a `ref/` tree that only `runner.sh` built, so all three exited 1 for
environmental reasons — the emit gate printing a 12,474-pair census and then dying
*before* its node comparison, which looks exactly like mismatches. A gate that
cannot run is worse than no gate.

### Adjudicated 2026-09-09: the enumeration campaign closes at ZERO

Robi ruled on 7 of the 61, through the real UI, and every one came back
**"no legal turn reaches the after-state"**. The 7 span both patterns -- four
from the dash-empties-its-own-sigil group, one from the no-cast `dist=4`
outlier, two from the no-overlap group -- so the finding generalises rather
than covering only the dominant mechanism.

So the whole residual is record artifacts and the engine is right:

| classification | count | what it is |
|---|---|---|
| FAT | 237 | after-state is a stored snapshot, never derived from actions |
| NO-OP SACRIFICE | 134 | a `sacrifice` names a sigil node the cast already cleared, so a mandatory cost goes unpaid |
| TRANSCRIPTION GLITCH | 61 | adjudicated unreachable by any legal turn |
| **GENUINE ENUMERATION GAP** | **0** | |

**2,016 -> 0.** The engine can now generate every turn in the recorded
history that was ever legal.

Why the records contain them at all: `applyAITurn` applies a stored action
list WITHOUT validating legality, so a corrupted or mis-ordered transcript
replays "cleanly" and its after-state gets stored. The no-op sacrifice is the
clearest case -- the cast clears the sigil, then a `sacrifice` names a node
inside it, and the applier silently does nothing. Any future audit against
`completed_games` needs these three filters or it will attribute record
damage to the engine: 371 of 432 flags here were not engine behaviour at all,
and the 61 that survived every mechanical filter still were not.

**Do NOT relax `castable` to accept them.** Allowing a cast whose sigil the
dash emptied would let the search play illegal moves -- strictly worse than
the 0.095% it was declining -- and the emit gate would then reject the
engine's own output.

---

## The mate guard was in a function nothing ships (2026-09-09)

The guard exists because the engine announced `+MATE` and then, two half-moves
later, announced `+0.38` — a "proof" that was not one. It clamps such a score
to `UNPROVEN_MATE` and stops iterative deepening from breaking early on it.

**It was written into `pick_successor` and only there.** The call graph:

| entry point | who drives it | had the guard |
|---|---|---|
| `pick_successor` | `py.rs` only, i.e. `engine/server/serve.py`, the local `?ai=rust_native` playtest | yes |
| `go_with_progress` | `wasm.rs pick_move_actions` — **the shipped site** | **no** |
| `go_with_progress` | `play_best` — **every arena, every audit, the native engine** | **no** |

`go_with_progress` ended its loop with

    if score.abs() >= WIN - MAX_PLY as i32 { break; }   // decisive

and had no clamp after it, so `set_mate_guard` set a field the shipped search
never read. The symptom Robi reported — the engine showing a win it does not
have — reaches the player through `pick_move_actions` → `go_with_progress` →
`ui_score`, every step of which bypassed the guard.

### Two measurements retracted

Both were evidence of the omission, not of the guard:

1. **`smoke_knobbite`: `mate_guard` changed nothing on 60 of 60 positions.** I
   explained it away — "the guard only fires where a mate meets a
   width-limited search, so a low count is expected" — and let the check exit
   0 with a WARNING. **"Expected to be rare" is indistinguishable from "not
   wired."** The check had found the bug and I talked it out of reporting it.
2. **The A/B over the 145 flagged positions.** Guard off: 145 starts, 117
   self-inconsistencies, **4 false mates**. Guard on: 145, 117, **4** — the
   same four transitions at byte-identical scores (`9999997` → `+1.50`,
   `+0.38`, `+1.49`, `+1.52`). I had written the gate as "off should
   reproduce the four seen earlier; on should be zero", so this was a clean
   failed gate. The correct reading was not "the guard does not work" but
   "the guard was never called", and the only way to tell those apart was to
   read the call graph.

The self-play control arm was uninformative either way, as designed: 3,915
starts guard-off and 3,960 guard-on, 0 false mates in both, because fresh
self-play does not produce them.

### The fix, and the gate that would have caught it

`go_with_progress` now carries the same two-part treatment as
`pick_successor`. `UNPROVEN_MATE` reaches the player as +50 stones
(`ui_score` divides by 3900, the UI multiplies by 39): unmistakably winning,
past no mate threshold.

> Superseded 2026-09-21 (engine v10): the clamp is now internal only. The mate
> distance is recorded before it (`SearchStats::mate_plies` / `mate_proven`) and
> the interface prints `search::report` -- "win in N" in the winner's turns,
> "likely win in N" when width-limited -- never the sentinel's 50 stones.
> STATUS.md, 2026-09-21.

The smoke test no longer samples and hopes. It **constructs** the condition —
mate-bearing positions with the cast-outcome window starved so the search is
certainly budget-limited — requires the guard to clamp every mate it finds,
and **fails when zero positions were exercised**, which is precisely how the
first version passed. Two `cargo test`s pin the behaviour to `go` itself so
it cannot drift back out of the shipping path.

### Measured after the fix

| gate | before | after |
|---|---|---|
| `smoke_knobbite`, mate_guard differs | **0 / 60** | **2 / 2** mates clamped, 0 missed |
| `smoke_guardfires` window 2, depth 4 | — | 10 mates, all budget-limited, **10 clamped, 0 leaked** |
| `smoke_guardfires` window 1, depth 4 | — | 11 mates, **10** budget-limited, 10 clamped, 0 leaked |
| `cargo test` | 84 | 87 passing, plus the two below |

The window-1 row is the one that shows the guard is not simply clamping every
mate it sees: one of the 11 was found by a search that never exhausted its
budget, and the guard left it alone. A mate from an exhaustive search IS a
proof. The cargo test asserts that direction too.

`an_unproven_mate_is_not_announced_as_a_mate_through_go` pins ten harvested
positions and fails when none is exercised.
`the_mate_guard_defaults_on_and_leaves_ordinary_scores_alone` asserts the
default is on and that guard on/off agree at the opening on score, node count,
completed depth and chosen turn.

### Rule

**A knob is not wired until it is proven to bite in the function the
deliverable calls.** `play_best` is not the only such function: the site
calls `wasm.rs`, the playtest server calls `pick_successor`. A guard that
exists in one root loop and not the others is worse than no guard, because
the field, the setter, the stats flag and the tests all read as present.

---

## keep_window, re-measured with the knob actually wired (2026-09-09)

The first two keep-window SPRTs were void: `play_best` took `keep_window` and
dropped it, so both arms of both runs were the same engine. Re-run on the
fixed binding, with `smoke_knobbite` first showing the knob changes something
on 56 of 60 real midgame positions:

| | |
|---|---|
| config | kw arm 2 vs base 1, 300 ms, tfit, width_scale 4, adaptive (0.10,2,6) |
| games | 7,040 decided, 0 unfinished, 3,520 distinct seeds, both colours |
| arm | **48.89%** [47.73, 50.06] |
| Elo | **-7.7 [-15.8, +0.4]** |
| depth at matched time | arm 4.30, base 4.40 |

The interval spans parity: **no measured difference.** What downward drift
there is matches the node-rate cost — expanding keeps costs time, and the arm
completes 0.1 ply less at the same clock. Note the engine default is now
kw=2, so the *base* arm is the narrower engine and kw=1 reproduces the
pre-fix search exactly.

This is a real null, unlike the two it replaces, and it does not change the
case for the enumeration fix. Self-play cannot price this particular change:
both sides draw keeps from the same distribution, so "the opponent keeps by
priority" is a correct opponent model in an arena and a wrong one against a
human, who keeps non-priority in 69.4% of casts. The fix ships on
correctness.

---

## Check A re-run, with the corrupt-window filter (2026-09-09)

2,403 recorded games / 66,820 positions, depths 2 and 4 against windows 2 and
4, 264 shards, **264 of 264 finished** (no shard dropped, so the rates below
are over the whole corpus).

| | all flags | engine to move |
|---|---|---|
| flagged windows | **5,655** | **404 (7.1%)** |
| announced provably lost (`score1 <= -1e6`) | **0** | **0** |
| announced lost, NOT provably (`+-5000`) | 1,023 | — |
| UNTESTED -- nothing deeper in the run | — | **220 (54.5%)** |
| `OTHER` -- a deeper search DID still flag | — | 107 (26.5%) |
| horizon effect (deepening cured it) | — | 77 (19.1%) |
| dropPerPly 0.5-1.0 | 4,057 | 230 |
| dropPerPly 1.0-2.0 | 336 | 43 |
| dropPerPly > 2.0 | — | **128** |

### Three things this table does not say

**1. `MATE FLIPS: 0` is the mate guard, not the defect going away.**
`mateFlip` tests `score1 <= -MATE` (1e6). A mate the search cannot prove is
now reported as `UNPROVEN_MATE` = 5,000, far above `-MATE`, so the SAME flag
stops being labelled one. `dropPerPly` is untouched, because the gradual
metric clamps at +-20 stones (2,000 centistones) and both `1e7` and `5,000`
saturate to that bound. The symptom is still there and now reads
`+UNPRV -> -1.57` at 10.79 stones/half-move. **Compare drop distributions
across runs, never the mate-flip label.**

**2. Only 184 of the 404 flags were TESTABLE, and the first report of this
run said `80.9% OTHER`, which was misleading.** The horizon test asks whether
a DEEPER search at the SAME window still flags, so it needs a deeper depth in
the same run, and the flags at a run's deepest depth have none. Lumping those
in with genuinely-still-flagged ones inflated `OTHER` from 107 to 327.
`attribute_drops` now has a separate `UNTESTED AT THIS DEPTH` bucket so this
cannot be read as a verdict again. Of the 184 testable flags: **107 other
(58.2%) / 77 horizon (41.8%)**. Depth 6 tests the remaining 220.

**2b. The big drops are MATE-related, and deepening cures them fastest.**
Of the 128 flags past 2 stones/half-move with the engine to move, **126 have
`+-UNPROVEN_MATE` at one end** -- the engine claimed a win or loss it could
not prove and then did not have it, which is the originally reported symptom
rather than the eval mispricing material. Cure rate by band, depth 2 -> 4:

| dropPerPly | n | cured | rate |
|---|---|---|---|
| 0.5-0.75 (envelope edge) | 118 | 45 | 38.1% |
| 0.75-1 | 1 | 0 | — |
| 1-2 | 21 | 6 | 28.6% |
| 2-5 | 15 | 9 | **60.0%** |
| 5+ | 29 | 17 | **58.6%** |

So the mate-adjacent drops behave like horizon effects -- a shallow search
sees a mate that depth dissolves -- while the harder residual sits at the
envelope edge. The mate guard fixes the CLAIM; depth fixes the CAUSE.

**3. The recorded corpus is a 3.6% instrument.** `rust` played **2,305 of
64,417 turns**; the rest are human (24,322), ai_hard (13,568), ai_medium
(8,896), ai_easy (7,776), ai_very_hard (6,321) and a long tail. Check A
re-scores after the ACTUAL continuation, so a decline means the mover's
position got worse -- and when the mover is a human who blundered, **the
engine's declining eval is CORRECT**. That is why 5,655 flags collapse to 404.

### What to run instead, and when

**Make Check A on engine SELF-PLAY the primary instrument.** Every
continuation is then the engine's own choice, so 100% of flags bear on the
0.5-stones-per-half-move envelope instead of 7%. It is cheap enough to be a
pre-merge gate, and the `--checks a` path already supports it: self-play has
no `pairs`, so no record filter is built and nothing is refused.

**Re-run the recorded-games audit on a TRIGGER, never a schedule:** changed
eval weights, a changed width schedule or move ordering, or a materially
larger human corpus. The corpus is static at 2,403 games, so a repeat without
one of those returns this same number.

### Two unit bugs found in the reporting, both the same 41x error

`attribute_drops.fmt_score` still divided by **4096** while `STONE = 100`,
after the module-level shadow had been fixed -- so every endpoint in the
worst-declines table printed 41x too small, a +50.00 stone unproven mate as
`+1.22`. The tell was a self-contradicting row: `+20.00/half-move ... +1.22 ->
-1.22`, where the RATE came from the flag JSON (correct) and the ENDPOINTS
came from `fmt_score`. A 1.22-to--1.22 swing over two half-moves is
1.22/half-move, not 20.

And `--checks a` printed a CHECK B verdict -- "every played turn IS
enumerable; no enumeration gap here" -- from an empty miss list that nothing
had populated. `do_reach` says the SOURCE supports Check B, not that it ran.

### And one fleet trap

`runner.sh` hard-coded `timeout 900` on the smoke arm. A Check A smoke of 2
games at depth 6 is ~950 s of scoring alone, so the smoke is killed, the
runner reads that as a smoke failure, and the arms never launch. Three
90-vCPU VMs were killed before they burned the cycle. The cap is now
overridable (`SMOKE_TIMEOUT=` -> `smoke-timeout` metadata) and the runner
echoes which cap applied. Related: the ~17 s/position figure for depth 6 is
inherited from full-width self-play and is far too pessimistic for the filled
midgame boards this audit scores.

---

# Superhuman campaign, 2026-09-09

Plan: `~/.claude/plans/this-is-the-repo-silly-glacier.md` (Robi approved 2026-09-09).
Acceptance: the top listed in-browser Rust tier at >= 30 s/move beats the humans rated
>= 1400, measured by a draw-free SPRT over rated `completed_games`, not by site Elo.

## §0.1 The human-vs-Rust record nobody had computed

`engine/harness/human_vs_rust_report.py` over the 2026-09-09 dump (2,465 games; 655 arena
records, 113 unranked, 10 AI-vs-AI, 1 human-vs-human and 10 uid-less excluded). Ranked
human-vs-AI only, Wilson 95% intervals, Elo gap = `p_to_elo(ai win rate)`:

| ai uid | games | ai wins | ai% | 95% CI | elo gap | first..last |
|---|---|---|---|---|---|---|
| `__ai_hard__` (JS, 5 s) | 587 | 44 | 7.5% | [5.6, 9.9] | −437 | 05-04..08-18 |
| `__ai_very_hard__` (JS, 60 s) | 164 | 16 | 9.8% | [6.1, 15.3] | −386 | 05-05..08-26 |
| **`__ai_rust_hard__` (10 s)** | **167** | **59** | **35.3%** | **[28.5, 42.8]** | **−105** | 08-31..09-09 |
| `__ai_rust__` (10 s, pre-swap) | 9 | 5 | 55.6% | [26.7, 81.1] | +39 | 08-26..08-30 |
| `__ai_rust_very_hard__` (60 s) | 5 | 3 | 60.0% | [23.1, 88.2] | +70 | 09-02..09-08 |

Per human against the Rust tiers: Robi (1403) 157 games vs `rust_hard`, **AI 33.1%
[26.2, 40.8], gap −122**; 4 vs `rust_very_hard`, AI 2/4; FlyingPandas (1372) 9 games vs
`rust_hard`, **AI 7/9**; Simonster 0/1 and 1/1. Fakey_McFaker (1503) and Futuresight (1501)
have not played a Rust tier at all.

Three things this changes:

1. **The gap is ~100-150 Elo at 10 s, not the 300-450 the plan's context section estimated
   from the JS tiers.** The Rust swap moved the AI from 7.5% to 35% against the same humans,
   i.e. ~+330 Elo in human play, which is consistent with the self-play chain (+120 at 200 ms
   growing with the clock). With 34-66 Elo per doubling, 10 s -> 60 s alone is worth +90-170,
   so the 60 s tier may already be near parity with Robi (2/4 is no evidence either way).
2. **The human sample is one person.** 157 of the 167 `rust_hard` games are Robi's. The
   acceptance SPRT needs the other >= 1400 players (Fakey, Futuresight) to play the top Rust
   tier; until they do, "superhuman" means "beats Robi", and Robi's own rating has fallen from
   1542 (2026-08-17) to 1403 while playing it, which is the site Elo doing exactly what §0.2
   says it does (the pool is anchored through AI games).
3. **Colour is not the story:** `rust_hard` scored 27/74 as red and 32/93 as blue.

Baseline JSON: `ai/data/human_vs_ai_2026-09-09.json`. Re-run on a trigger (new tier, new
engine release, a new strong human), never on a schedule.

## §1.0-1.1 Node rate: 2.93x, tree byte-identical (2026-09-09)

Tooling first: `engine/examples/bench.rs` runs a fixed-depth, CLOCKLESS search over
`engine/harness/positions_midgame.txt` (76 self-play midgame positions at plies 8/14/20/26,
generated once by `harness/midgame_positions.py` and committed; regenerating it moves the
baseline) and prints per-position `(nodes, score, best)` hashes plus a combined HASH. Two
binaries with the same HASH searched the same tree, so wall time is the only thing being
compared. `perf` on a `CARGO_PROFILE_RELEASE_DEBUG=1` build of the bench gave the profile.

What the first profile said (12 positions, depth 5, self time): `sort_by_key` recomputing
`move_score` -> `placement_goal` -> `escape_distance` PER COMPARISON ~15%; malloc/free
~20% plus SipHash ~9%, both from `resolve_outcomes_logged` building and discarding a
`Vec<JsAct>` log per branch and a fresh `HashSet` per resolution step; `Board::update` 7.5%;
the TT/killer promotion `sort_by_key` 3%.

Five changes, each verified by an unchanged HASH on the 12-position subset before the next:

| change | where | subset us/node |
|---|---|---|
| (baseline, main `b5c6a366`) | | 7.34 |
| `sort_by_cached_key`, `placement_goal` hoisted (`move_score_goal`) | `order.rs`, `turn_iter.rs`, `key_dash.rs` | 5.77 |
| `Log` trait: `()` for the search, `Vec<JsAct>` for replay; `StoneHasher` | `cast_enum.rs` | 3.24 |
| stable 4-tier partition replaces the promotion sort; cached `sacrifice_cost`; lazy dedupe set (`LINEAR_DEDUPE_MAX` 24) | `search.rs`, `turn_iter.rs`, `cast_enum.rs` | 3.69 (noise: a background bench was running) |
| `Frontier::push` dedupes on stones BEFORE `update()`; 13 pre-push `update()` calls dropped | `cast_enum.rs` | 2.89 |
| fixed-size dash combos instead of `Vec<Vec<u8>>` | `turn_iter.rs` | 2.64 |

Clean sequential A/B on the full 76 positions at depth 5, same machine, nothing else running:

| | nodes | ms | us/node | HASH |
|---|---|---|---|---|
| main | 9,078,002 | 308,486 | **33.98** | `753f5ce31fd8f037` |
| this branch | 9,078,002 | 105,385 | **11.61** | `753f5ce31fd8f037` |

**2.93x at an identical tree.** At the measured 34-66 Elo per doubling that is +53-102 Elo
of effective time for free, before any search change. (This box is ~2x slower per node
than the cloud c3d figures in this file; the RATIO is the portable number.)

Guard added: `logged_and_unlogged_resolution_agree` -- the `()`-log enumeration and the
`Vec<JsAct>` enumeration must produce the same outcome boards in the same order over
~250 castable (position, spell) pairs, because `Action::Cast::outcome` is an index into
that list. `cargo test --release`: 90 passed.

What is left in the profile after these (self time): `Board::update` ~16% (now mostly
genuine per-branch derivation), `TurnIter::next` 7%, `evaluate` 5% (the `tfit` control
flood fill), `escape_distance` 5%, dash-branch generation ~5%, malloc ~8%. Nothing above
5% is a free win any more; the next 1.3x would need the generator to hand resolved boards
to `apply_turn` (`turn.rs:194` re-resolves every cast it expands), which is a structural
change and is deferred until the search work in §1.2-1.4 settles what the generator must
return.

## §1.3 TT persistence: wired, 16-byte entries, Elo-neutral at 300 ms (2026-09-09)

`TtEntry` is now 16 bytes (`key_hi: u32`, packed first action `u32`, score, depth,
bound, age) in a plain `Vec` with `depth == TT_EMPTY` as the empty marker, instead of
`Option<TtEntry>` at 32 bytes. Same `tt_bits` -> half the memory (2^21 = 32 MB), and the
fixed-depth bench HASH is unchanged. Mate scores are stored node-relative
(`score_to_tt`/`score_from_tt`), which is also what makes entries reusable across moves.
`age` is bumped per `go`; a stale-generation entry yields to any new one. For a fresh
`Search` per move -- every path that shipped before this -- the aging rule never fires,
so the single-search tree is byte-identical (bench HASH `753f5ce31fd8f037`, unchanged).

Persistence surfaces: `Search::new_game/clear_history/tt_filled`, the wasm `Engine`
(`engine.search / ponder_begin / ponder_step / ponder_end / new_game`), and the Python
`SearchSession` for harnesses. `rust-worker.js` now holds ONE `Engine` per table size for
the whole game; `RustAI` sends `new_game` from its constructor. `pick_move_actions` is
kept as a wrapper (fresh table) so `tools/wasm-smoke.js`'s existing gate still runs, and
the smoke now also drives a search -> ponder -> search cycle on one `Engine`.

**Local A/B, persistence alone** (`harness/ab_session.py 25 300 persist`, 8 shards, this
machine, colour-swapped, seeds 8,000,000+): **400 games, 200-200, 50.0%**; the arm
completed 0.15 ply deeper at equal clock (4.40 vs 4.25 / 4.64 vs 4.49 on two shards).
The plan expected +8-20, which 400 games cannot resolve (SE 2.5% ~ +/-35 Elo), so this is
"wired and not harmful", not a measured gain. It ships as the substrate pondering needs.
Do not re-measure it alone; measure it with pondering, at 3 s and 10 s on the fleet.

## §1.2 / §1.4 / §1.5 wired, default off, smoke-proven; arenas pending (2026-09-09)

Knobs added to `Search`, every one OFF by default and node-identical when off (bench
HASH `753f5ce31fd8f037` / `e87151533a366158` unchanged; `the_section_1_2_knobs_default_off…`):

| knob | what | bites through `play_best` (gcp/smoke_knobs12.py) |
|---|---|---|
| `force_hints` | a TT move or killer the width budget dropped is ADDED as `[move, pass]` if legal here (`Board::first_action_is_legal`, pinned to the generator by test) | yes |
| `root_resort` | root ordered by the previous iteration's scores, PV first | 71/76 positions differ at depth 5 |
| `aspiration_steps` | failed side widens x3 per fail, full after 3 | 12/76 |
| `adopt_partial` | a timed-out iteration may adopt a later root move whose COMPLETED subtree beat the fully-searched seed | 16/40 moves differ at 300 ms, same mean time |
| `elastic` (`Elastic::DEFAULT` 2.0/0.4/2/50/predict) | instability extension, stability early-stop, don't-start-unfinishable-iteration | 14/40; mean 324 vs 302 ms -> MUST be gated at matched average time |
| `pvs` | zero-window after the first child, re-search on `alpha < v < beta` | pending |
| `lmr (ext, r)` | pull `width*ext`, search the band past `width` at `depth-1-r` zero-window, re-search on fail-high, instead of dropping it | pending |
| `use_history` | per-colour history on (node, push_to) / cast spell / dash; +d^2 bonus, -d^2 malus; halved per `go`; orders tier 3 | pending |

Pondering (§1.5) is wired end to end: `rust-worker.js` owns one `Engine`, `RustAI.startPonder`
posts the human-to-move position (and now records it in the repetition history, fixing the
gap where only AI-root positions were recorded), `ponder_step` slices of 250 ms to depth 12
run between messages, and `game-board-local.js` turns pondering on for the >= 10 s tiers unless
the account setting is explicitly off (`RustAI.ponderEnabledFor`). `RUST_ENGINE_VERSION` 3,
`sw.js` cache `v27`, wasm rebuilt (430,424 bytes unoptimised; the `Log` refactor shrank it).

Harnesses: `harness/ab_session.py <pairs> <ms> persist|ponder` (honest ponder: the arm
ponders the pre-move position for the opponent's think time and never sees their choice),
`harness/ab_search.py` gained the knobs (`lmr` arm value = ext*10 + r) and per-arm mean
seconds on every GAME line, so an elastic arm can be checked for matched time when pooled.

## §1.5 Pondering: +40 Elo [+3, +77] at 300 ms, local (2026-09-09)

`harness/ab_session.py 25 300 ponder`, 7 shards on this machine, colour-swapped, seeds
8,000,000+, honest ponder (the arm ponders the pre-move position for the opponent's think
time and never sees the opponent's choice; the opponent searches on a fresh table):

| | |
|---|---|
| games | **350** (195-155) |
| arm score | **55.7%** [50.5, 60.8] Wilson |
| Elo | **+40 [+3, +77]** |
| depth at equal clock | arm 4.96 / 4.36 vs base 4.62 / 4.08 (two shards) |
| table at the arm's 2nd move | median 21,756 entries |

Persistence alone was 200-200, so the gain is the ponder. This is the deploy-only lever
(self-play cannot see it; a human's think time is free), at the LEAST favourable ratio --
300 ms of ponder for 300 ms of search. A human at 30 s/move against `rust_very_hard` gives
the engine 30-60 s of priming per move, so the shipped effect should be larger, bounded by
one doubling (34-66 Elo). Fleet confirmation at 3 s/3 s and 10 s/10 s is queued behind the
knob arenas; the wasm side already ships it (`rust-worker.js` slices, default-on for the
>= 10 s tiers).

## §2 step A: prior inputs, parts, labels -- pipeline built, gate 0 pending data (2026-09-09)

`engine/src/prior.rs` defines the data side of the move-ordering prior in one place
shared by training and serving: `context_inputs` (`NX = 170` integers: sigil fills,
charged, castable-now, one-short flags for both sides, 20 scalars, 78 occupancy bits),
`turn_parts` (up to `MAX_PARTS = 16` indices into a `NP = 284` vocabulary: first-move
kind/node/push/`move_score` bucket, dash n_sacs/sacs/landing/push/kind, cast spell/pos/
keep bucket/within-stub outcome rank, second cast, class), and `dataset_rows` (the
shipped generator drained to `cap`, each turn with parts, a STUB id -- the generator's own
choice point -- and its rank within the stub). Layout pinned by
`prior_part_layout_is_contiguous_and_parts_are_in_range`.

Bindings: `PyBoard.prior_label_and_play(depth, …)` (fixed-depth shipped-config search;
returns the SFN before, the chosen turn as `pack_action` words, score, nodes; plays it) and
`PyBoard.prior_dataset(cap)`. Harnesses: `harness/selfplay_prior.py` (labels every 3rd ply
from ply 4 at depth 7, play depth 5, atomic npz per shard, seeds 12,000,000 + shard) and
`harness/prior_gate0.py` (stream-rank coverage, stub oracle, oracle width).

Smoke only -- 3 games, label depth 5, **34 labels**, NOT a result: stream rank median 2 /
p90 64, coverage w24 79%, w96 91%; stub oracle k1 85%, k2 88%, **k4 94%** (gate needs
>= 97% on >= 10^5 labels); 1 of 35 labels outside cap 400. The within-stub number is the one
to watch: if it holds near 94% at scale, the heuristic ORDER INSIDE a cast stub is a real
part of the tail and the prior needs the within-stub scorer (plan §2.4 gate 0) before
training. Data run: one `c3d-highcpu-90` x 8 h ≈ $26 (`selfplay_prior.py 1000 <out> 7 5 3 4`
per shard), not launched -- fleet spend needs Robi's go.

## §1.2/§1.4 knob arenas, local, 300 ms, 8 shards x 25 pairs (2026-09-09, running)

Same binary both arms, eval tfit, shipped widening, colour-swapped, seeds 6,000,000+shard,
pooled with `pool_shards.py` (which now checks matched average time via the GAME lines'
`arm_s=`/`base_s=` and refuses a verdict past `--max-time-ratio`):

| knob | games | arm% | 95% CI | Elo | time ratio | read |
|---|---|---|---|---|---|---|
| `force_hints` | 399 | 47.1% | [42.3, 52.0] | −20 [−54, +14] | 0.999 | null, leaning negative: a hint the width dropped is rarely the best move at 300 ms, and its subtree costs |
| `pvs` | 400 | 50.5% | [45.6, 55.4] | +4 [−31, +38] | 1.000 | null; completed depth identical (4.68 vs 4.68): the zero windows save what the re-searches cost, so ordering is already good enough that plain alpha-beta cuts almost as early |
| `lmr` 2/1 (band x2, R=1) | 400 | 46.8% | [41.9, 51.7] | −23 [−57, +12] | 1.000 | leaning negative at 300 ms and 0.4 ply shallower (4.00 vs 4.38): the reduced band's subtrees cost depth that a 300 ms search cannot spare. This is the one knob where a 300 ms verdict is least informative -- it trades depth for coverage exactly as `width_scale` did, and that trade was +47 at 300 ms but +223 at 3 s. Worth the ~$5 fleet run at 3 s despite the local rule |
| `use_history` | 400 | 47.5% | [42.7, 52.4] | −17 [−51, +17] | 1.000 | null, leaning negative, same depth (4.63 vs 4.64): re-sorting tier 3 by history displaces the generator's order, which is already best at the median (FINDINGS "best move rank median 1"); the tail it could help is casts/dashes that the width never generates anyway |
| `root_resort` | 400 | 49.0% | [44.1, 53.9] | −7 [−41, +27] | 1.000 | null, same depth: the root already searches the previous best first, and with a root width of 72-480 the order of the rest rarely changes which move wins |
| `aspiration_steps` | 400 | 51.5% | [46.6, 56.4] | +10 [−24, +44] | 1.000 | first knob with a point estimate above 50% (same depth); qualifies for the 3 s fleet run (`arms/aspiration_steps_3s.txt`) |
| `adopt_partial` | 400 | 51.0% | [46.1, 55.9] | +7 [−27, +41] | 1.000 | above 50%, same depth; qualifies for the 3 s fleet run (`arms/adopt_partial_3s.txt`) |

`elastic` was not in the local queue (it needs matched-average-time calibration); its 3 s
fleet arm is listed in CAMPAIGN.md with `--max-time-ratio 1.05` pooling.

Summary of the seven at 300 ms: nothing clears on its own (all seven intervals span
parity; SE ~2.5% = +/-35 Elo), two lean positive (`aspiration_steps` 51.5%,
`adopt_partial` 51.0%), three lean negative (`force_hints` 47.1%, `lmr` 46.8%, `use_history`
47.5%), two flat (`pvs` 50.5%, `root_resort` 49.0%). The pattern matches the engine's
history: ordering is already good at the median, and anything that spends nodes on the tail
(hints, LMR band, history re-sorts) costs depth that 300 ms cannot spare. The two positive
leaners and `lmr` (the depth-for-coverage trade that grows with the clock) go to the fleet
at 3 s; the rest stay off and are not re-tried without a changed premise.

## Fleet campaign, runs 1-4 pooled (launched 2026-09-09 23:34 UTC, pooled 2026-09-16)

Everything below is `launch.sh` on `main` (runs 1/3/4 cloned `abfe019`, run 2 `b284da0`),
one VM per run, pooled from GAME / FLAG lines with `pool_shards.py` / `pool_drops.py` --
never from a shard's own SPRT line. Eight VMs ran concurrently (714 vCPUs); the limit that
bit was `CPUS_PER_VM_FAMILY` = 500 per family in us-central1, so three runs fell through
to `c3-highcpu-88`. All eight self-terminated; `teardown.sh` ran 2026-09-16 15:10 UTC.

### Run 1 -- pondering CONFIRMED at both controls (~$14)

`ab_session.py <pairs> <ms> ponder`, honest ponder (the arm ponders the pre-move position
for the opponent's think time and never sees their choice), colour-swapped, 45 shards:

| control | games | arm% | 95% CI | Elo | mean plies |
|---|---|---|---|---|---|
| 3 s / 3 s (`20260909T233422Z`) | 2,250 | **53.51%** | [51.45, 55.56] | **+24 [+10, +39]** | 32.8 |
| 10 s / 10 s (`20260909T233436Z`) | 540 | **54.44%** | [50.23, 58.60] | **+31 [+2, +60]** | 32.5 |

Both lower bounds are above 50%: first row of the CAMPAIGN.md table. Pondering stays
default-on for the >= 10 s tiers, no redeploy. The 300 ms local number (+40 [+3, +77])
sits inside both intervals; the effect does not shrink with the clock at equal
ponder/search time, which is the least favourable ratio a human ever gives it.

### Run 2 -- search knobs at 3 s, 45 shards x 25 pairs each (~$8 each)

| knob | local 300 ms | 3 s games | arm% | 95% CI | Elo | time ratio | decision |
|---|---|---|---|---|---|---|---|
| `aspiration_steps` | 51.5% | 2,250 | 50.18% | [48.11, 52.24] | +1 [-13, +16] | 1.000 | spans parity: **OFF**, recorded, not re-run |
| `adopt_partial` | 51.0% | 2,250 | 51.69% | [49.62, 53.75] | +12 [-3, +26] | 1.000 | spans parity: **OFF**, recorded, not re-run |
| **`elastic`** (2.0, 0.4, 2, 50) | untested | 2,250 | **54.62%** | [52.56, 56.67] | **+32 [+18, +47]** | 0.997 | clears -> 10 s confirmation `20260916T151012Z` |
| **`lmr` 21** (band x2, R=1) | 46.8% | 2,250 | **53.02%** | [50.96, 55.08] | **+21 [+7, +35]** | 1.000 | clears -> 10 s confirmation `20260916T151027Z` |

`elastic` spent 2.990 s/move against the base's 3.001 (ratio 0.997, inside the 1.05 gate),
so its verdict stands at matched time. `lmr` is the `width_scale` pattern exactly: -23 at
300 ms, +21 at 3 s -- the reduced band's subtrees cost depth a short search cannot spare
and buy coverage a longer one can. Two knobs cleared individually, so per the runbook
ONE bundle arm runs at 10 s before either default flips (`ab_search.py` knob `bundle`,
value 21 = elastic DEFAULT + lmr 2/1; `arms/bundle_10s.txt`; `20260916T151519Z`).

### Run 3 -- prior labels: 4,605 labels, and the sizing error (~$29, watchdog-killed)

`selfplay_prior.py 800 <out> 7 5 3 4`, 90 shards. The runbook sized this at ~36 s/game
(800 games in 8 h); the one shard that checkpointed early ran at **170 s/game**, and after
9 h the fleet had **42 shards with a checkpoint, 520 distinct games, 4,605 labels** --
not 70k / 700k. 48 shards never reached their first 10-game checkpoint, i.e. ran slower
than 3,240 s/game at 90 processes on 45 physical cores. This is the E1 error again --
"size it from a MEASURED games/hour, not an extrapolation" -- and the rule now has a
number: a depth-7 label costs 90 shards ~15 s each under contention, so **20 labels per
shard-hour** is the planning figure. Gate 0 needs a few thousand labels and has them;
`prior_gate0.py` needs `sigil_engine`, so it runs on a build VM, not in Cloud Shell.

### Run 4 -- Check A over the recorded human games, depth 6 (~$29, 88/90 shards)

`eval_drop_audit.py --checks a --depths 6 --windows 2` over `hydrated_lines_v2.json`
(2,403 games). 88 of 90 shards finished before the 9 h watchdog; two shards' positions
are MISSING, so no rate is read off this. 2,884 flags, 1,488 games, **0 provable-mate
announcements** (the mate guard holding on human lines), 566 with an UNPROVEN_MATE
sentinel at one end. Restricted to HUMAN movers (`--identities`, `--mover human`):
**537 flags**, 382 games, opponents mostly `ai_hard` (207), `rust` (122), `ai_medium` (80).

| dropPerPly band (human to move) | n | with a mate sentinel at either end |
|---|---|---|
| 0.50-0.75 (envelope edge) | 311 | 0 (0%) |
| 0.75-1.00 | 18 | 0 |
| 1.00-2.00 | 34 | 0 |
| 2.00-5.00 | 2 | 0 |
| **5.00+** | **172** | **172 (100%)** |

The same perfect separation as the self-play audit: every large drop is a mate
announcement (98 from `+UNPRV` collapsing, 74 into `-UNPRV`), no small drop is. Spell
composition of the >2 flags matches the <=2 flags to within 0.5 pp on every spell (largest
deviation `Lurk` 1.4% vs 0.9%), and no game carries more than 5 human flags in 382. That
is the runbook's second row -- **mostly UNPROVEN_MATE at one end: horizon effects, depth is
the cure, nothing to change** -- with the third row's conclusion for the remainder: no
spell or shape structure, so self-play stays a sufficient instrument.

Filtered to movers rated **>= 1400** at game time (`redEloBefore`/`blueEloBefore` from
`completed_games_raw.json`; 490 of the 537 human flags have a rating): **144 flags, 99
games, 3 humans**, all ranked:

| dropPerPly band (human >= 1400 to move) | n | mate sentinel at either end |
|---|---|---|
| 0.50-0.75 | 85 | 0 |
| 0.75-1.00 | 4 | 0 |
| 1.00-2.00 | 8 | 0 |
| 2.00-5.00 | 0 | 0 |
| **5.00+** | **47** | **47 (100%)** |

Same separation, same verdict, and 83 of the 144 are one player's.

One limit, stated so it is not read past: the run used ONE depth, so every flag is
`UNTESTED` for a cure rate. Cure rates live in the depth-2/4/6 self-play run ("Check A
re-run" above); this run answers the runbook's question -- structure, or horizon? -- and the
answer is horizon.

### Costs (list price, c3d-highcpu-90 ~$3.2/h, c3-highcpu-88 ~$3.6/h)

Run 1 ~2.4 h + ~2.2 h = $14; Run 2 four VMs ~1.6-1.9 h = $24; Run 3 9 h = $29; Run 4
9 h = $29. Campaign so far ~**$96**, plus the three 10 s runs in flight (~2.2 h each, ~$21).

### Run 2 at 10 s -- both knobs confirm, and the pair is worth more than either (2026-09-16)

45 shards x 6 pairs, `ab_search.py`, same binary both arms, colour-swapped:

| arm at 10 s | games | arm% | 95% CI | Elo | time ratio |
|---|---|---|---|---|---|
| `elastic` DEFAULT (`20260916T151012Z`) | 540 | **58.33%** | [54.13, 62.42] | **+58 [+29, +88]** | 1.018 |
| `lmr` 21 (`20260916T151027Z`) | 540 | **56.67%** | [52.45, 60.78] | **+47 [+17, +76]** | 1.000 |
| **`bundle` 21 = elastic + lmr** (`20260916T151519Z`) | 540 | **61.48%** | [57.31, 65.49] | **+81 [+51, +111]** | 1.014 |

Every lower bound clears 50%, the elastic arms sit inside the 1.05 matched-time gate, and
the pair does not cancel through node rate: +81 against +58 and +47 alone. Both grow
with the clock (elastic +32 -> +58, lmr +21 -> +47 from 3 s to 10 s), the `width_scale`
signature again. Decision per the runbook: flip both defaults in `Search::new` (and so in
`search_defaults`), STATUS.md shipped config, rebuild the wasm, redeploy. The 300 ms
local arena had `lmr` at 46.8% -- the single knob whose short-clock verdict the runbook
explicitly refused to trust, and it is the second-largest search gain in the project.

One consequence to decide before the flip: `?ai=rust_anchor` ("frozen reference; never
upgrade it") runs the SAME wasm and pins only `fresh` (a throwaway table), not the search
knobs, so a default flip would move the anchor too. The anchor path must set
`elastic None` / `lmr 0` explicitly, which is the one place restating a default is the
point rather than the trap.

### SHIPPED 2026-09-16: elastic + LMR defaults, RUST_ENGINE_VERSION 4

`Search::new` carries `elastic: Some(Elastic::DEFAULT)` and `lmr_ext: 2` (`aba05af2`);
`pick_move_actions` -- the only entry point `?ai=rust_anchor` uses -- sets both back off
(`3a0f96c1`), so the frozen reference is still the 2026-09 search. The defaults test now
pins every knob (`8f2cbf88`). Build VM on `main` at `8f2cbf8`: **95/95 tests**; wasm
465,955 bytes unoptimised (`wasm-opt` -O2 still fails `tools/wasm-smoke.js` at init and
the build falls back, as designed). `RUST_ENGINE_VERSION` 3 -> 4, `sw.js` v27 -> v28 with
`?v=4` on the three engine assets. Human-facing consequence: the >= 10 s tiers now think
for a variable time per move around the same average; the acceptance gate (Run 0) is the
measurement that matters next, and it needs Fakey_McFaker / Futuresight on the top tier.

## Seal of Destruction was never implemented (2026-09-17)

Fakey_McFaker's game against the new tiers ended with the engine filling Seal of
Destruction while touching almost nothing, then losing when its turn began. That is not a
search or eval defect but a MISSING RULE: `spells_meta.rs` lists the seal as a
`Resolve::None_` static like the other seven Seals, `charged` is computed for it, and
nothing anywhere consumed that bit -- no end-of-turn burn, no start-of-turn loss --
while `sigil_charged` (+80 in the older weights, +2 in `tfit`) paid for filling any
sigil. Every other Seal has its trigger somewhere (`cast.rs`, `turn.rs`,
`turn_iter.rs`); Destruction was the one orphan.

The live rule (`constants.js`): "STATIC: If filled at the end of your turn, destroy all
enemy stones touching you. If filled at the start of your turn, you lose." Order in the
controller (`game-controller.js`): `applyAITurn` -> `endTurn` burn -> win checks ->
next turn's opening check claims the loser.

### The fix (branch `seal-of-destruction`, merged to main)

| where | what |
|---|---|
| `board.rs` | `destruction_end_of_turn` (mask op: enemy & dilate(mine), adjacency off the pre-burn board), `destruction_start_of_turn`, `destruction_fill_targets` |
| `turn.rs apply_turn` | burn -> `check_game_over` -> start-of-turn loss for `c.other()`, so a burn that reaches the +/-3 lead wins first |
| `turn.rs emit_actions` | deliberately PRE-burn: `rust-ai.js` replays the actions with `applyAITurn` (no burn) and compares stones against `expected_sfn` before `endTurn` burns; a post-burn board would make every winning fill fail the replay gate |
| `search.rs` | a side NOT to move that holds the seal is scored `WIN - ply - 1` for the mover (it never breaks the seal), in `negamax` and `quiesce`; without it a leaf priced the just-burned stones as a lead -- the horizon shape of the suicide |
| `order.rs` | `destruction_swing`: +100k when the enemy holds the seal after a resolution, +100k when we hold it and the burn wins, -100k when we hold it and it does not; folded into `configuration_value` (so every outcome ranking sees it) and into `move_score` for moves whose target or push destination touches the seal; Gust placements rank the enemy's empty seal nodes first |
| `cast_enum.rs` | seal-completing targets branch first in capped frontiers; Gust emits the enemy-filling placement as raw outcome 0 so no cap can hide it |
| `turn_iter.rs` | `decisive_destruction_turns`: guarded to the seal being drawn and within reach, one resolution per (first move, castable spell) plus a dash probe, each verified through the seal's own rules; `TurnIter::new` pushes them to the FRONT of the stream |

### What the tests caught while being written

Three fixture/ordering findings, each a real property of the engine rather than a typo:

1. **A mate under the last-ranked first move is invisible to width.** The stream is
   staged (every first move, then every cast under every first move, then dashes); in a
   position full of tempting pushes the only soft move ranks last and its Gust mate sat
   ~126 turns deep, past the root width. Hence the decisive pre-pass.
2. **Casting a charm clears its node and keeps nothing back.** A blue stone that touched
   red only through the Gust node is no longer picked up after the cast -- the first k=5
   fixture had no mate at all. Fixtures anchor the picked stones elsewhere now.
3. **Blossom reaches the lead by placement alone** against three far stones; the 5-node
   fixtures carry six so the burn is the only win.

### Tests (101/101)

`seal_of_destruction_burns_at_end_of_turn_and_claims_at_start_of_turn` (the rule, both
branches), `emit_actions_hands_back_the_pre_burn_board_the_client_replays`,
`gust_blows_the_enemy_into_seal_of_destruction_for_a_mate_in_one` (k = 1..5),
`filling_seal_of_destruction_by_move_or_dash_is_found_when_the_burn_wins`,
`every_cast_that_can_fill_seal_of_destruction_is_enumerated_ranked_first_and_found`
(Sprout, Grow, Flourish, Scatter, Blossom, Eclipse, Torrent, Tsunami: enumerated,
top-ranked inside the outcome window, and found by the search),
`the_engine_refuses_to_fill_seal_of_destruction_when_the_burn_does_not_win` (search
avoids it; blue reads the position as won; ordering flags the suicide and the mate).

Not measured: Elo. This is a rules fix -- the engine could not previously see a whole
class of forced wins and losses -- and ships on correctness, as the cast-keep fix did.
The human acceptance gate (Run 0) is where its effect will show.

## Audit of every recorded game's final position: the mate-in-1 blind spot is CASTS, not Gust (2026-09-19)

`tools/audit_mates.py` hydrated all 2,501 `completed_games` records, kept the 1,614 that ended
by a board win with a consistent, engine-enumerable final position, and asked two questions of
each: does the ordered search see the winning reply, and did the losing side's search know?

| loser | games | depth-1 finds the mate | mate rank <24 | 24..4096 | not generated | depth-2 move allows a mate yet scores ~0 (v5 / v6) |
|---|---|---|---|---|---|---|
| js medium | 405 | 92% | 277 | 70 | 58 | 59 / 36 |
| js hard | 352 | 74% | 123 | 141 | 88 | 97 / 59 |
| js easy | 349 | 93% | 225 | 79 | 45 | 44 / 28 |
| human | 139 | 83% | 67 | 50 | 22 | 42 / 25 |
| js very_hard | 126 | 73% | 42 | 53 | 31 | 43 / 26 |
| **rust_hard** | 121 | **59%** | 36 | 50 | 35 | **43 / 29** |

* 261 of 1,533 solvable positions (17%) hold a mate-in-1 the depth-1 shipped search scores at
  about +0.04. In 260 of them EVERY mate needs a cast (Fireblast 52, Surge 47, Carnage 38,
  Slash 33, Starfall 22, Hurricane 17, Hail Storm 14...). The mate is either generated but ranked
  24..4096 (66) or never generated within 200k stream turns (137): the stream puts casts under a
  few first moves, and a cast under the wrong first move is out of reach of any width.
* **Gust is not the mechanism.** Gust is charged by the winner in 0 of the 261 blind spots and no
  mate anywhere needs it. Draws with Gust have a 26% blind rate (10/39) against 17% without, on
  39 games -- noise, and the recorded games with Gust in the draw were lost to Meteor, Scatter
  and Hail Storm mates.
* The recorded rust_hard losses (121) are the worst tier because they are the most recent and
  competitive-variant heavy, not because of the tier: 43 depth-2 positions where the AI's own
  chosen move walks into a mate while scoring -0.01..-0.04.
* Two Fireblast games from 2026-04 record a win the current rules do not allow (the sacrifice
  was recorded on a node the cast had cleared): old rules, excluded. The Rust Fireblast never
  enumerates the SACRIFICE choice (`sacrifice_pick` = highest node), so 54 recorded winning
  layouts are unreachable by the enumerator; it does not change the win/loss of the turn.
* The v6 bookends (`mate::immediate_win`) discarded the whole scan when the enumeration was
  incomplete (580 of 2,194 final positions hit the turn or resolver cap). A win found in a
  truncated list is still a win; the fallback ships in this commit.

**Fix in this commit: `decisive_lead_turns`, a material-gated, pruned scan for turns that reach
the stone lead (or the sixth cast) NOW, emitted at the front of the ordered stream like the Seal
of Destruction pre-pass.** It walks the enumerator's grammar (move; dash and cast in either
order; Summer second cast) with an optimistic per-spell material bound per branch, verifies
candidates through `apply_turn`, examines at most `DECISIVE_LEAD_CAP` = 2,000 boards, and is
memoised per position for iterative deepening.

Re-running the corpus checks with it (all 1,533 solvable final positions):

| | shipped v5 | v6 bookends | pre-pass alone | pre-pass + bookends |
|---|---|---|---|---|
| depth-1 search finds the recorded mate | 1,272 (83%) | -- | **1,457 (95%)** | -- |
| depth-2 move from the loser's position walks into a mate while scoring ~0 | 333 | 206 | 116 | **52** |
| ...rust_hard losses only (121) | 43 | 29 | 12 | **6** |

Cost, idle machine, 20 positions x 1 s, `tfit`/scale 4/adaptive, bookends off: endgame
313k -> 198k nodes/s (depth 4.6 -> 4.5), midgame 372k -> 230k nodes/s (depth 5.85 -> 5.55).
~55 us when a mate exists, ~170 us for a fruitless scan inside the gate. The gate's per-spell
bounds are generous (Erupt 16, Carnage 8), which is why midgame pays too; tightening them and
`DECISIVE_LEAD_CAP` is the tuning space. Not gated by arena yet: the corpus gate is
`tools/audit_mates.py` on a fresh hydrated dump, the strength gate is the fleet SPRT at
matched average time (the depth loss must be bought back by the blunders removed).

## Arena: the mate-in-1 fixes cost Elo at 3 s, and the bookends are untimed (2026-09-19/20)

Fleet `ab_search.py`, `tfit`, 45 shards x 25 colour-swapped pairs, 3 s/move, c3d-highcpu-90,
pooled from GAME lines (`pool_shards.py`).

| run | arm vs base | games | arm win rate | Elo | s/move arm / base |
|---|---|---|---|---|---|
| `20260919T200757Z` | `decisive_lead` pre-pass ON vs OFF, v6 bookends on BOTH sides | 1,952 (watchdog cut 15/45 shards) | 45.9% [43.6, 48.1] | **-29 [-45, -13]** | 4.75 / 4.81 (ratio 0.99) |
| `20260919T200809Z` | pre-pass + bookends vs neither (the whole change against the v5 search on `main`) | 2,250 | 38.4% [36.5, 40.5] | **-82 [-97, -67]** | 4.99 / 2.87 (ratio 1.74) |

Two findings, one of them about the clock:

* **The v6 bookends (`mate::immediate_win`, up to 250k turns enumerated twice per move) run
  OUTSIDE the time control.** `go_with_progress` sets the deadline, then runs the front scan
  inside it (the search loses that time), then runs the back scan and any re-search after it
  (the move overspends). With bookends on, a 3 s budget averaged 4.8 s per move and some games
  averaged 50+ s per move. Run 2's arm therefore searched LESS than its base while using 1.7x
  the wall time, and still lost 82 Elo. The shipped v6/v7 wasm has this on every rust_hard move.
  Whatever their merit, the bookends cannot ship untimed: either budget the scans inside
  `time_ms` and cap their cost (a 250k-turn enumeration is not a 10 ms check), or replace them
  with the pre-pass, which finds 95% of the recorded mates for microseconds.
* **The stone-lead pre-pass alone costs ~29 Elo at 3 s** (run 1, matched time): the 35% node-rate
  cost measured in the previous section is not bought back by the mates it stops the engine
  walking into, at least at this control and with the bookends' clock distortion on both sides.
  Run 3 (`decisive_lead_nb`, pre-pass ON vs OFF with bookends OFF on both sides, matched time,
  5-VM fleet `20260920T2056*`) is the clean measurement; result appended below when pooled.

Reading rule that would have caught this before the fleet: **look at `mean s/move` per arm
before the Elo.** A ratio far from 1.0 means the knob changed the clock, not just the tree, and
the SPRT is then comparing budgets, not searches. `pool_shards.py --max-time-ratio 1.05` refuses
such a verdict; it was not passed here.

**Run 3 pooled (2026-09-20, 5 x c3d-highcpu-90, 225 shards x 5 pairs, 3 s, `decisive_lead_nb`
= pre-pass ON vs OFF with bookends OFF on both sides):** 2,250 games, arm **49.1% [47.1, 51.2],
Elo -6 [-21, +8]**, s/move 2.87 / 2.91 (ratio 0.98). NO measured difference: the pre-pass's
node-rate cost and the blunders it removes cancel within +/-15 Elo at 3 s, while it lifts
depth-1 detection of the recorded mates from 83% to 95% and cuts the "walked into a mate while
scoring ~0" positions from 333 to 116. Run 1's -29 for the same knob was measured with the
untimed bookends on both sides, i.e. under a distorted clock; run 3 is the number to use.

Decision: the pre-pass is shippable on correctness grounds (Elo-neutral, fixes the reported
class of blunder); the v6 exhaustive bookends are NOT in their current form (untimed, -50-ish
Elo and 1.7x wall time) -- remove them or budget them inside `time_ms` before any merge to main.
Fleet note: five VMs with distinct SHARD_BASEs finished the 2,250 games in ~35 minutes for the
same vCPU-hours as one VM in 2.5 h; pool with a glob that spans per-run folders, because shard
log names repeat across runs and a flat copy silently keeps one run.

## Weakness audit of the recorded games (2026-09-21)

Every recorded game (2,599 `completed_games` records; 2,485 replayed; 2,354 with spells the engine
models) was scored position by position with the SHIPPED search at untimed depth 6
(`engine/harness/eval_games.py`, 63,193 positions, four c3d-highcpu-90 Spot VMs, ~12 VM-hours), and
the position before every game-ending turn was put to the exhaustive mate-in-1 solver
(`engine/harness/final_blow_probe.py`). `engine/harness/weakness_report.py` turns the three artefacts
into `engine/harness/reports/weakness_2026-09-21.md`; the numbers below are from that report.

### Where the Rust AI loses (347 human-vs-Rust games, 60.2% lost)

* **Long games.** 87% of games lasting 40–49 turns are lost (34/39, z +3.6) against 40% of games under
  20 turns (z −3.1) and 0/7 under 10. The AI wins the games it wins early; whatever it lacks shows
  after move 30. Colour, tier, variant and opponent Elo bucket are all within noise.
* **Spells in the draw.** Hurricane (42% lost, z −4.0) and Lurk (46%, z −3.2) make the AI win more;
  Blossom (78%, z +3.0), Storm Front and Corrupt (~68–70%, z +2) make it lose more. Nine spells per
  draw over 347 games: only |z| ≥ 3 is believable, so Hurricane/Lurk/Blossom are the leads.
* **By week** the loss rate wanders 50–68% with no trend; the corpus is too small per week to see
  engine releases.

### Where the evaluation fails (all 63,193 positions)

Class A, "winning but did not win": 1,767 positions (28 per 1,000) where one side had a proven or
"likely" mate or a ≥ 3-stone lead and did not win the game. Most are humans failing to convert;
**15 are the Rust engine sitting on a PROVEN mate-in-1 and losing the game**, 46 more on a "likely"
mate. Class B, "loss arrived sooner than the mate distance": 938 positions, **70 with the Rust engine
as the loser**. Class C, a non-decisive eval collapsing by > 1 stone within two plies: 1,339 across the
AI's own move (194 Rust), 556 across the opponent's move. Rates are lower in the Rust era (A 10 vs 31
per 1,000; C 37 vs 47) -- the Rust engine's positions are less chaotic than the JS tiers' -- and blue
claims fail twice as often as red's (A 39 vs 18 per 1,000), which is blue's +1 token making "decisive"
reachable one stone earlier.

### The game-ending blow (1,489 games whose last turn was the winner's)

The winner had an immediate win in 1,364 of them (the rest ended by Seal of Destruction, the sixth
cast, repetition, or a JS-only win). **The depth-2 shipped search reports a forced win in 95.5%;
in 61 positions (4.5%) it does not, and 32 of those 61 had more than 100 winning turns available** --
an ordering failure, not a tactic. The miss rate is 7.9% in the Rust era against 3.9% before, and
14–16% when Torrent, Syzygy, Azimuth or Lurk are in the draw (z +4 to +5): the newer packs' turn
shapes are the ones the ordered generator hides. The stone-lead pre-pass (`decisive_lead_turns`,
cap 2,000) surfaces a win in 92% of the 1,364 -- and in **none** of the 61 misses; at cap 50,000 it
recovers 29 of them. On the worst miss (12,143 of 88,674 turns win) it returns nothing in 0.00 s: the
winning shape is a crushing hard move, a dash, a second hard move and a placement ritual (Flourish /
Scatter), whose optimistic material bound never clears `lead_req`. This is the engine's most concrete
weakness: about one game in twenty ends with a win the engine would not have seen coming one ply
earlier, and the pre-pass built for exactly this is gated out of every one of them.

### Rechecking the Rust engine's own failures with today's engine

Every Rust-side A/B position (89) was re-searched by the CURRENT engine at a 3 s budget (on a shared
4-core shell, so it reached depth 3–5 where the browser reaches ~8; "not seen" is therefore weak
evidence, "seen" is strong). **All 15 proven mate-in-1s the live engine failed to play are found now,
with a different move from the one played** -- they date from 2026-09-02..09-10, before the v8
stone-lead pre-pass, and are closed. Of the 43 class-A positions 30 are found; of the 46 class-B
positions today's engine sees the loss coming in 15. **Four class-B positions are open generator gaps:
after the move the AI played, the opponent had 315–2,518 immediate wins that the exhaustive solver
lists and a depth-2 search reports as +1.0 stones** (games 98MCXZ, ABNA29, QFJ939, NNMACJ in the
report). These are the same shape as the final-blow misses above and are the positions to fix the
pre-pass against.

### Moves players flagged as bad (1,063 flags, 106 on Rust turns)

Flags are volunteered, so each split is compared with all AI turns of the same tier. On Rust tiers:
**cast Flourish is flagged 8 times in 27 casts (30%, z +9)** -- every flagged cast kept a single stone
(`a4`) and sacrificed the rest of the sigil for four placements, today's engine still chooses the same
cast in 7 of 8, and by its own depth-6 account two of them lost about a stone. Gust (2/13) and Splash
(3/30) follow at z +3. The middle game (turns 11–25) carries 2.9 flags per 100 turns against 0.3 in the
opening. The engine's own verdict agrees with the players more often than not: 28% of the flagged Rust
turns collapsed by more than a stone two plies later against 9.6% of all its turns, while 52 of 82 lost
nothing by its account (style, or a disagreement with the eval). On the JS tiers the flags were about
plain hard moves (315) and Carnage casts (11% flagged).

### What to fix first

1. The final-blow gap: make the pre-pass cover the dash-then-ritual shapes (or bound them honestly),
   and confirm on the 61 probe positions before an arena.
2. Flourish: look at what the four placements are worth against the sigil stones sacrificed; the
   players and the depth-6 re-evaluation both say the cast is often a stone too generous.
3. The long-game decline (87% lost at 40–49 turns): the per-ply evals of those games are in
   `game_evals` and the cases file; the collapse listings (C1) are where to start reading.

## Arena: the v11 changes at 3 s (2026-09-21, one c3d-highcpu-90 per arm, 88 shards x 25 pairs)

Each arm against the same engine with its knob off, `tfit`, 3,000 ms per move, colour-swapped seeds,
pooled from GAME lines by `pool_shards.py` (4,400 decided games per arm; runs 20260921T164801Z /
164813Z / 164825Z).

| change | knob | arm wins | win rate | Elo [95%] | verdict |
|---|---|---|---|---|---|
| placement-cast ordering (`Board::placement_bonus`) | `outcome_order_v2` | 2,306 / 4,400 | 52.4% [50.9, 53.9] | **+16.8 [+6.5, +27.0]** | ships |
| pre-pass v2 bounds + two-phase scan, cap 2,500 | `lead_bounds_v2` | 2,194 / 4,400 | 49.9% [48.4, 51.3] | −0.9 [−11.2, +9.3] | ships (Elo-neutral, closes 26 of the 61 recorded final-blow misses); s/move ratio 0.990 |
| `tfit2` = tfit + cast_pace 15 + mobility 4 + control 40 | eval `tfit2` vs `tfit` | 1,950 / 4,400 | 44.3% [42.9, 45.8] | **−39.7 [−50.0, −29.3]** | does NOT ship |

**What the tfit2 result says.** Three hand-weighted terms were added at once and the package lost
40 Elo, so at least one of them is badly priced; the arena cannot say which. Candidates, in the order
I would test them: `control` at 40 raw (~2 cs/node, an 80 cs swing across the board) is 13x the fitted
value and competes with `mana`/`sigil_stone` inside the same scaled sum; `cast_pace` at 15 cs per unit
reaches ±75 cs with the counters at 5 and flips sign on a one-stone lead change, which is a large
discontinuity for alpha-beta; `mobility` at 4 cs per net target is probably the least harmful. The
designer's rule about neutral casts still stands -- the placement ORDERING fix, which needs no eval
change, is what actually removed the refill behaviour and it gained Elo. Next step if the eval is
revisited: one term at a time, and fit the magnitude on the labelled corpus before any arena.

The competitive-opening arm (`opening_book`, `SIGIL_VARIANT=competitive`, run 20260921T191932Z, relaunched
after its smoke refused the knob because the runner had not exported the variant to the smoke run):

| change | knob | arm wins | win rate | Elo [95%] | verdict |
|---|---|---|---|---|---|
| opening selector, competitive self-play | `opening_book` | 2,101 / 4,400 | 47.8% [46.3, 49.2] | **−15.6 [−25.9, −5.4]** | shipped anyway for a human playtest |

**Reading it.** In 3 s self-play the base engine's spell-blind opening -- `move_score_goal` grabs a mana
node (+90) or a charm (+70) -- beats the table-driven sigil pick by about 15 Elo. Two things this does
NOT settle: (1) whether the pick is worth more against humans over a long game, which is what the
designer expects and what the selector was built for, so it shipped (`742e3c4a`) and the recorded
human-vs-`rust_hard` games from 2026-09-21 on are the measurement (rerun `weakness_report.py` Part 1
by week); (2) the selector never considers the mana node itself as an opening, while the base's +90
grab is exactly what it loses to -- adding "the zone's mana" as a candidate valued by the tempo it
buys the zone-mates is the obvious next iteration if the human numbers are flat.


## A one-ply refutation the stream never generates (2026-09-21, room DSJZ2B)

Robi (red, 1477) beat rust_hard (blue) after the AI cast Slash on its turns 7 and 8 reading +1.0 both
times, and lost two stones to the same reply: move b7, dash whose move crushes on b8, Slash whose hard
move crushes on b9 -- a single-ply, +2-stone refutation. Offline the shipped engine reproduces it:
at fixed depth 4-6 blue picks the same Slash line at about 0.0; from red's side the refutation reads
+2.08 only from iteration 5 (root width 288) and +1.08 / +0.08 at depths 1-4.

**Not a depth problem: the turn does not exist in the candidate stream.** At the shipped window the
ordered stream for that position holds 216 turns; the first turn that both dashes and casts is #124,
and red's actual line is not there at any rank -- the dash stage caps sacrifice pairs per first move
and only the survivors get a cast, so `[move, dash(crush), Slash(crush)]` is never built. The search
at iteration 5 finds a sibling with a different sacrifice pair once the root is wide enough; blue's
inner nodes get 24-40 candidates and never see either. The opening selector was in use in this game
(blue's first stone on b7, the Slash charm in red's Erupt zone, is its pick) and is unrelated.

**Fix: a material-swing pre-pass at the shallow plies** (`Board::swing_turns`, knob
`turn_iter::set_swing_prepass`, default on). The stone-lead scanner run with the criterion "gains
SWING_MIN = 2 stones now" instead of "reaches the lead", 1,500-board cap, up to 3 turns, verified
through `apply_turn`; `Search::ordered_turns_action_hint` puts what it finds at the front of the
candidate list at plies 0 and 1 (root and the replies to it), where nodes are few and a hidden
one-ply refutation costs a game. Measured on the game: red's depth-1 search +1.08 -> +2.08 and it
picks the refutation; blue at turns 7 and 8 reads −1.04 from depth 4 and no longer plays the line.
Cost: ~0.1 ms per scan; fixed depth 6 over the game's 16 positions 69.1 s -> 66.4 s (4% fewer nodes:
the promoted turns also improve ordering). Regression tests
`swing_prepass_finds_the_recorded_one_ply_refutation` and
`the_ai_no_longer_walks_into_the_recorded_slash_refutation` pin both sides of the position and
assert the defect reproduces with the pass off.

**Arena verdict (run 20260921T211851Z, 3 s, one c3d-highcpu-90, 88 shards x 25 pairs, 4,343 games, mean 31.8
plies):** arm 2,424 : base 1,919, win rate 55.81% [54.33, 57.29], **Elo +40.6 [+30.2, +51.0]**, s/move ratio
0.994. The largest single gain of the campaign, from a 0.1 ms scan at two plies. Shipped as engine v12.

Why the browser said +1.0 where the fixed-depth replay says 0.0: the live search runs with a
persistent table, pondering and the elastic budget, and the browser had just crushed a red stone the
ply before; the sign is the same story -- the AI believed its Slash line was safe because the reply
that punishes it was not in its move list.

## A one-ply +2 reply behind a Seal-of-Summer second cast (2026-09-21, room U4TL2D)

Robi (red) vs Hard AI (blue), competitive, draw Tsunami, Harvest, Starfall, Gather, Seal of Stone, Meteor,
Sprout, Seal of Autumn, Seal of Summer (record `-P25022Z0YamsS7g9B9X`). Blue's turn 11 (ply 22) searched
depth 4 in 9.2 s (94,070 nodes -- 10k nodes/s, a cast-heavy position), read **+0.9**, and played hard move
a7->a8, dash (b11, b13) a4->a12, Harvest. Red's reply: hard move a4 pushing to b5, dash (a12, c7) to a6
charging Tsunami, cast Tsunami, then **Meteor as the Seal of Summer second cast** -- 10:10 -> 9:7, a +2
swing in one ply. Blue's turn 12 read "likely loss in 1".

Position after blue's turn (red to move, `U4TL2D_RED_T23` in tests.rs):
`rrrbr.bbbb.rrbbb..b....rb.......rr.r.../Tsunami,Harvest,Starfall,Gather,Seal_of_Stone,Meteor,Sprout,Seal_of_Autumn,Seal_of_Summer r 23 2:2 Gather:Harvest -:- b1 competitive`.
The v12 engine reads it **+0.08** at depth 1 and −1.00 at depth 2: the reply is not in its move list at any
width, and the swing pre-pass shipped for DSJZ2B does not find it either. Three defects, all one ply deep:

1. **The stream had no `[move, dash, cast, cast]`.** The move-cast stage has had a Seal-of-Summer
   continuation since the keep fix; the dash-cast stage never got one. The exhaustive enumerator produces
   725,544 turns here, 563,910 of them dash-then-two-casts (376,444 dash + Tsunami + Meteor); the ordered
   stream produced 832 turns and **0** with a dash and two casts, at window 16, 32 or 64.
2. **The swing scan's Meteor bound was 2.** `resolve_meteor` places (or pushes, crushing) a stone and THEN
   destroys an adjacent enemy: 3. After the Tsunami (gain 1) the Meteor second cast bounded to 2 − 2 (clear
   loss) = 0 and `reachable(1 + 0 >= 2)` pruned the continuation before an outcome was looked at. The
   bound is not merely loose, it is wrong in the pessimistic direction. The scan also followed only the 3
   outcomes with the largest count: the Tsunami resolution that leaves Meteor charged tied 65 others at
   gain 1 and ranked 60th.
3. **Budget.** With 1 and 2 fixed the reply was found at a cap of ~80,000 boards (25 ms), never at 1,500:
   the winning push ranks fifth among 11 first moves, and each of the four before it has 55 sacrifice
   pairs x 3 keeps re-resolving the same hopeless Meteor (~50 outcomes) -- ~3,300 boards per first move.

**Fix (knob `turn_iter::set_dash_summer`, default on; arm `engine/gcp/arms/dash_summer_3s.txt`):**
`TurnIter::push_summer_casts`, the Summer continuation shared by the move-cast and dash-cast stages (the
stream here becomes 1,241 turns, 409 with a dash and two casts, each verified against the exhaustive
enumeration); Meteor's swing bound 3 **in the swing scan only** (`swing_scan_active`: at 3 the lead scan
starves at its 2,500 cap and loses the recorded P2 and Erupt mates, so it keeps 2); among equal counts the
swing scan follows the outcomes with the best Summer continuation (`LeadScan::continuation`); at most
`SWING_PAIRS_PER_CAST` = 3 sacrifice pairs resolve the same post-dash cast (`cast_tries`, keyed by the
post-dash board with the sacrificed stones put back); first moves in best-first order (gain, then
potential); swing cap 1,500 -> **6,000** (`SWING_CAP_V2`; the reply is found at 3,000, in 2.3 ms). Cost over
50 recorded scans (both sides of 25 positions): mean 0.19 -> 0.25 ms, max 1.1 -> 3.2 ms, at plies 0-1
only. Measured on the game: red's depth-1 search **+0.08 -> +1.03** stones and it plays the
dash-Tsunami-Meteor reply; blue's recorded turn is therefore worth about −1 for blue. (The fixed-depth
replay of blue's turn never chooses the recorded turn with either engine -- it picks the same shape with
b12 in place of b13 as the second sacrifice, which red cannot punish; the live search's persistent table,
pondering and elastic budget are not reproduced offline.) Regression tests
`meteor_swing_bound_counts_the_placement_the_crush_and_the_kill`,
`swing_scan_finds_the_recorded_dash_tsunami_meteor_reply` (asserts the v12 scan misses it even at 6,000)
and `the_stream_offers_a_summer_second_cast_after_a_dash_cast` (asserts v12's stream has none).

**Arena verdict (run `20260921T231344Z`, `dash_summer` 1 vs 0 at 3 s, one c3d-highcpu-90, 88 shards x 25
pairs, 4,400 games): arm 2,303 - base 2,097, 52.34% [50.86, 53.81], +16.3 Elo [+6.0, +26.6], s/move ratio
0.999.** The interval excludes parity: the bundle is better, and at no time cost; it stays ON.

Two things worth remembering from the diagnosis. The dash-then-cast shape multiplies every cast by the
sacrifice pairs, and a pre-pass that charges boards generated pays for the same resolution 55 times; any
future scan over dash lines needs a per-cast bound on pairs. And a "bound" that is smaller than the real
effect silently deletes lines: `cast_swing_bound` is used as an upper bound everywhere, so each entry
should be checked against the resolver (Comet is 1 -- place + crush − sacrifice -- and correct).

## The Hard AI spent 71% of its clock: a matched-time policy in a fixed-budget browser (2026-09-22, room X4TNAS)

Game X4TNAS (record `-P25Tzrrd-K9lf99exYX`, Robi red vs Hard AI blue, 2026-09-22 00:20 UTC, red
1490 -> 1501). The player watched the AI think for a few seconds, reach depth 3 on a small node
count, and move with most of its 10 s unspent, in a position where it was losing. The hypothesis
was "it saw every move losing and gave up". It had not: replayed natively at 10 s, none of blue's
positions before turn 36 is a mate score (turn 18 reads -0.04 stones, turn 32 -1.96), and the only
mate-driven exit in `deepen` needs a PROVEN mate (no widening anywhere in the tree), which a
midgame search never satisfies. The clock was given back by the elastic time manager.

**The mechanism.** `Elastic::DEFAULT` (2.0 / 0.4 / 2 / 50 / predict) carries three rules: extend
to 2x the budget once when the best move changes or the score drops at depth >= 3; stop when the
answer has been stable for two iterations past 40% of the budget; and `predict`: after each
completed depth, estimate the next iteration as `t_last x clamp(t_last / t_prev, 2, 6)` and do not
start it if that exceeds the remaining clock x 1.15. In Sigil the per-depth cost ratio is 7-10
(turn 18: depth 3 63 ms, depth 4 445 ms, depth 5 4,392 ms), so the estimate sits at its clamp of
6x, and the rule refuses depth d+1 whenever depth d took more than about a sixth of what is left.
Partial iterations were then discarded (`adopt_partial` off), so nothing could be gained by
continuing, and the search returned. Blue's 18 turns of X4TNAS at 10 s natively:

| turn | used | depth | nodes | score |
|---|---|---|---|---|
| 8 | 2.8 s (28%) | 5 | 82,336 | -0.02 |
| 18 | 4.5 s (45%) | 5 | 140,923 | -0.04 |
| 32 | **3.2 s (32%)** | **3** | **14,603** | -1.96 |
| 34 | 7.3 s (73%) | 3 | 18,038 | -1.99 |
| all 18 | **127.9 of 180 s (71%)** | | | |

Turn 32 is the turn the player described: depth 3 completed at 3.2 s and was predicted to need 6 x
3 s for depth 4 against 6.8 s remaining. The wasm build is slower than native, so in the browser
the same rule lands at a lower depth on more turns.

**Why the arenas liked it.** `elastic` shipped from matched-AVERAGE-time arenas (FINDINGS "Run 2
at 10 s": +58 Elo [+29, +88]): the harness scales the arm's base budget so its mean seconds per
move equals the fixed arm's, so every early stop funds an extension elsewhere. The browser has no
pool. A tier budget is a per-move ceiling; a move that stops at 3 s of 10 forfeits 7 s. The Hard
tier therefore inherited a policy whose gain came from redistribution it cannot do, and was
running a ~7 s mean search under a 10 s label. That comparison (elastic at base 10 s vs fixed
10 s) was never made.

**Fix (engine default; arm `engine/gcp/arms/full_budget_10s.txt`, knob `full_budget` in
`ab_search.py`, 0 = the old policy).** `Elastic::FULL` = (2.0, 1.0, 2, 50, no predict): the
instability extension stays, the predictor is gone, and the stability stop can fire only past the
base budget, i.e. only inside an extension. `adopt_partial` ships ON so the iteration the deadline
cuts is not wasted: the previous best is searched first, and a later root move whose subtree
COMPLETED and beat it is adopted (measured +12 [-3, +26] alone at 3 s). The same 18 turns:

| | old policy | `FULL` + `adopt_partial` |
|---|---|---|
| clock used | 127.9 s (71%) | 250.2 s (139%: every move to its deadline, 7 of 18 extended to 20 s) |
| turns 30 / 32 / 34 depth | 3 / 3 / 3 | 4 / 4 / 4 |
| turn 32 nodes | 14,603 | 96,576 |
| turn 32 move | c8, pass | c7, Storm Front (kept c10), ... |

The extension now fires on 7 turns instead of 1, because the iterations that used to be predicted
away now run and change the answer; a Hard move can take 20 s. If that is too long a wait,
`max_factor` is the dial (1.5 would cap it at 15 s) and is worth an arena of its own.

The arena for this MUST be gated at FIXED per-move time, not matched time: the browser's budget is
fixed, and the arm using more of it is the point. Arms `full_budget` 1 vs 0 at 10 s, 8 pairs x 88
shards.

**Arena verdict (run `20260922T010321Z`, `full_budget` 1 vs 0 at a FIXED 10 s per move, one c3d-highcpu-90, 88
shards x 8 pairs, 1,406 of 1,408 games when recorded): arm 765 - base 641, 54.41% [51.80, 57.00], +30.7 Elo
[+12.5, +48.9]; s/move arm 16.04 vs base 9.67 (ratio 1.66).** The interval excludes parity. Note what the
time ratio says: even in self-play the old policy gave back only ~3% of a 10 s budget on average (9.67 s), so
most of the arm's extra time is the instability extension running more often, not the predictor alone; the
human game X4TNAS (71% used) was a worse case than the self-play mean. Shipped as engine v14 (cache v41).

Two smaller notes. First, `deepen`'s "decisive" break also fires on a proven LOSS; that is sound
(a proof that every move loses within d plies bounds any deeper search, and the score already
prefers the longest resistance), but a "most challenging line" tie-break among equally lost moves,
by how few of the opponent's replies win, would be the next lever for the situation the player
described, and it now has the clock to run in. Second, pondering was checked as a cause and
cleared: a session that pondered red's turn-17 position for 30 s then searched turn 18 used 8.5 s
of 10, not less. Tests: `the_shipped_policy_spends_the_whole_budget_on_a_midgame_position`
(position `X4TNAS_BLUE_T32`) and the defaults pin.

## A turn with no legal placement was skipped by the site (2026-09-22)

The ruling of 2026-08-26 is that a turn is move + optional dash + optional cast, and a missing first
move (a surrounded player facing Seal of Stone, so every reachable node is occupied and pushes are
barred) invalidates only the MOVE: the dash, the casts and the bare pass remain. The engine has
followed it since (`Board::enumerate_turns_capped`, the lazy stream's fallback in `TurnIter::new`,
tests `no_first_move_still_offers_dash_cast_and_pass` and
`lazy_iterator_matches_the_enumerator_when_no_first_move_exists`). The site did not:

- `GameController._takeTurn` and `MultiplayerController._takeTurn` computed the first-move targets
  and, finding none, `return`ed -- the turn ended before the post-move menu was ever offered. A human
  who could still dash or cast lost the turn. (The AI path never hit it: `_takeAITurn` applies the
  engine's action list through `applyAITurn`, so the Hard AI already dashed and cast in that spot.)
- `SimBoard.getLegalTurns` and `getLegalTurnsExhaustive` (the puzzles page, the review flags, the JS
  AIs) collapsed the same position to a bare `[pass]`.

Fix: both controllers fall through to the post-move menu (`_takeTurn(color, false, ...)`) with a
message ("No legal stone placement: dash, cast a spell, or pass."); both enumerators call their
post-move enumerator with an empty prefix, which yields the pass first and then the dash and cast
turns. The review replayer shares `_takeTurn`, so recorded human turns that start with `dash`
replay. `tools/no-placement-smoke.js` builds the engine's fixture (red b4 b7 b8 walled in, blue on
the Seal of Stone sigil, red's Sprout charged), asserts both JS enumerators offer a dash and a cast
and no first move, and replays the transcript `dash, b4, b7, b7, pass` to the position the engine
reaches for the same turn; it fails on the previous code with "getLegalTurns: no dash turn (pass)".

## The deadline is the budget: `exact_clock` and the overflow read-ahead (2026-09-22)

v14 (`Elastic::FULL`) made every move run to its deadline but kept the 2x instability extension, so
a Hard move averaged 16 s and could take 20 s. The user's requirement is stricter: spend exactly the
allotted time on every turn, with no exits -- not for a proven mate, not for a single legal turn --
and, when the root has nothing left to learn, spend the remainder reading the future and keep it.

`Search::exact_clock` (ships ON; knob `exact_clock`, 0 = v14's policy) does three things:

1. The deadline is `t_start + budget`, never moved: the elastic block in `deepen` is skipped, so
   there is no extension and no stability stop. `adopt_partial` stays on, because the last
   iteration is always the one the clock cuts.
2. A proven decisive score still ends the ROOT's deepening (nothing deeper can change a proof, and
   the score already prefers the shortest win and the longest resistance), but not the move: the
   remaining clock goes to `spend_remaining`.
3. `spend_remaining` deepens the position the opponent will face after the chosen move, from their
   side, until the deadline -- the same work `ponder_step` does between moves, but inside the move
   and in the same persistent table, so the next search starts from that tree. If that position is
   terminal (the move mates), the root itself is deepened further without the decisive exit. The
   root's move, score and depth are untouched; `overflow_ms` / `overflow_depth` record the extra
   work, and the think report prints "reply read to depth N". A single legal turn needs no special
   case: the one root child gets the whole budget, which is the read-ahead the user asked for.

The think report also gained the selective depth (`max_ply_seen`, printed as `depth 5/9`) so the
extensions and reductions of the next section are visible to the player.

Tests: `the_exact_clock_spends_the_whole_budget_and_never_extends` (X4TNAS turn 32, 600 ms:
no extension, no early stop, the deadline cuts the last iteration), `a_proven_mate_still_spends_the_clock`
(the corpus mate-in-1 at 300 ms: proof found, clock spent in the overflow; with the knob off the
v14 policy exits on the proof), `a_single_legal_turn_reads_ahead_instead_of_returning` (a walled-in
single stone with one legal turn: the search runs its budget and completes at least the depth a full
root reaches). Arena at FIXED 10 s (`engine/gcp/arms/exact_clock_10s.txt`): the arm uses ~10.0 s/move
against the v14 base's ~16 s, so this measures what the extension was worth; the policy is the
user's decision either way.

**Arena verdict (run `20260922T181548Z`, `exact_clock` 1 vs 0 at a FIXED 10 s nominal budget, 88 shards x 8
pairs, 1,408 games): arm 614 - base 794, 43.61% [41.04, 46.21], -44.7 Elo [-63.0, -26.4]; s/move arm
10.00 vs base 16.13 (ratio 0.62).** Read it plainly: the v14 base stretches to 20 s whenever its answer
wobbles and averages 16 s a move, so "exactly 10 s" is 38% less thinking, and self-play prices that at
about 45 Elo. That is the cost of the extension going away, not of the policy being wrong; a 10 s exact
budget against a 10 s exact budget is by construction a tie. The policy stays ON by the user's decision
(a player who picks a 10 s tier gets 10 s a move, every move). If the strength matters more than the
predictability, the dial is the tier's NOMINAL budget: 15 s exact thinks about as much as v14 did on
average.

## Selective depth: four Stockfish-style mechanisms, each measured alone (2026-09-22)

Until v15 every child of a node was searched at `depth - 1`; the only exception was the LMR band
beyond the width (`lmr_ext 2, lmr_r 1`, +47 Elo at 10 s). Forcing lines stopped at the same horizon
as quiet ones, and quiet late turns inside the window cost the same as the principal variation.
Four mechanisms now exist in `negamax`, each behind its own knob (default OFF), each with a fixed-10 s
arena of its own against the then-current default. Shared plumbing, byte-identical with the knobs off:
`iter_depth` (the iteration's root depth; `depth + ply - iter_depth` is the number of extensions spent
on the line, `iter_depth - ply` the nominal depth the width is taken from, so an extended child does
not also jump a width bucket), the TT probe keeps the entry's score/bound/depth for the singular test,
and every probe or re-search carries the band's `!timed_out` guard so a cut-off probe never cuts or
re-searches. The TT stores the depth a node was CALLED with (an extended child stores the deeper
depth, a reduced one the shallower), so the `e.depth >= depth` cutoff stays sound.

One premise: a bare `[pass]` is legal only when no first move exists, so pass-as-null-move is a
probe on an illegal move exactly as in chess. Sigil is otherwise unusually null-move friendly: every
legal move adds a stone, a pass is a strict sacrifice, there is no zugzwang.

**1. `nmp` (pass as null move).** At a node with `ply >= 1`, `depth >= 2`, a non-mate window, outside
the competitive opening, with no stone of either side on Seal of Destruction's sigil, and static eval
already `>= beta`: search the pass at `depth - 1 - R` with the window `(beta - 1, beta)`; if it still
beats beta (and is not a mate score) return it without generating a single turn -- which is where
the saving is, since `ordered_turns` is nearly the whole cost of a node. Mode 0 fires only at
zero-window nodes (with PVS off, the LMR-band subtrees), mode 1 at every node from ply 2. Arms
`nmp_10s.txt` (R 2, mode 0) and `nmp_all_10s.txt` (R 2, mode 1). Tests
`nmp_finds_the_corpus_mate_in_two_with_fewer_nodes`, `nmp_never_fires_in_the_opening_or_around_the_seal`,
`selective_depth_is_off_by_default_and_touches_nothing`.

**2. `lmr_quiet` (in-window late-quiet reductions).** Inside the width, a turn at index `>= lmr_quiet`
that is a plain move (`[move, pass]`, no stone-count change) is searched one ply shallower (two past
half the width) with a zero window and re-searched in full on a fail-high; the TT move, killers and
the first generator picks keep full depth, the band beyond the width is unchanged, and nothing fires
under a mate-bound alpha. Risk: the stream is class-staged (all `[move, pass]` first, then casts, then
dashes), so "late quiet" means "low-ranked first move" while every cast sits behind them at full depth,
the inverse of chess LMR's premise. Arm `lmr_quiet_10s.txt` (from index 4). Test
`lmr_quiet_reduces_late_quiet_turns_and_keeps_the_mate`.

**3. `tact_ext` (tactical extensions).** A child whose turn casts (1), dashes (2), crushes (4) or lands
one crush from the +/-3 lead (8) is searched at `depth` instead of `depth - 1` while the line's budget
(`ext_cap`) lasts; never on a band child, never together with a reduction, and the width is taken from
the nominal depth so an extension does not also widen. Risk: this is quiescence by another name
(`q_depth` measured -13 Elo: every move places a stone, so the "quiet position" the technique assumes
does not exist, and casts are a large share of the deep stream). Arms `tact_ext_10s.txt` (cast|dash|crush,
cap 2) and `tact_ext_crush_10s.txt` (crush only, cap 1). Test `tactical_extensions_see_deeper_on_the_corpus_mate`.

**4. `singular` (singular extension of the TT move).** At a PV node of depth >= 4 whose TT move has an
Exact/Lower score from a search at most two plies shallower, every alternative inside the width is
probed at half depth against `tt_score - margin`; if all fail low, the TT move is the only move and is
searched one ply deeper. Exclusion probes run over the list already pulled, so no second generation.
At 10 s this qualifies a few dozen nodes per move (the root's children); it is a 60 s-clock feature and
a null verdict at 10 s is expected. Arm `singular_10s.txt` (150 cs). Test
`singular_extension_tests_the_tt_move_at_pv_nodes`.

Measured on X4TNAS turn 32 at fixed depth 4 (`tfit`, native): `nmp` mode 1 fires 156 probes, every
one of them cuts, 73k -> 59k nodes; mode 0 (zero-window nodes only) 29 probes, 73k -> 73k. On the corpus
mate-in-2 no probe fires at all: every window under a mating line is mate-bound.

**Verdicts (fixed 10 s per move, one c3d-highcpu-90, 88 shards x 8 pairs each, base = the then-current
default):**

| knob | run | games | win rate | Elo | s/move |
|---|---|---|---|---|---|
| `nmp` (2, 1) vs off | `20260922T181612Z` | 1,408 | 52.98% [50.37, 55.58] | **+20.8 [+2.6, +38.9]** | 1.000 |
| `lmr_quiet` 4 vs 0 (base with `nmp`) | `20260922T203629Z` | 1,408 | 47.30% [44.70, 49.91] | **-18.8 [-36.9, -0.6]** | 1.000 |
| `tact_ext` 72 vs 0 | pending | | | | |
| `singular` 150 vs 0 | pending | | | | |

`nmp` clears parity and **ships ON as (R 2, every node from ply 2)**; the later knobs are measured on top of it.
`lmr_quiet` loses, as the class-staged stream predicted ("late quiet" is a low-ranked first move, not a late
move): **stays OFF**.

## Game clocks: base + increment for the AI (2026-09-22)

The site's tiers were per-move budgets only. `search::move_budget_ms(remaining, inc, my_moves_played)`
turns a whole-game clock ("5+0": five minutes for the game; "10+1": ten minutes plus a second back per
move) into the per-move budget the exact-clock search then spends to the millisecond: the increment
plus an equal share of what is left after a reserve (2% of the remainder, at least 150 ms, for the
browser's messaging around a search), over the moves the side is still expected to make. Sigil
self-play averages ~31 plies and human games run longer, so the horizon starts at 18 of the side's
moves and floors at 6: 1/18, 1/17, ... of the remainder, then a sixth of it from the 12th move on, a
geometric taper that cannot flag. Simulated 5+0: 16.3 s a move at the start, ~88% of the clock gone by
the 18th move, ~30 s left there, ~8 s at move 25, 0.8 s at move 40. 10+1 opens at 33.7 s a move and the
increment keeps every later move above a second. The floor is 50 ms even on an exhausted clock (0 ms
would mean "no deadline"): Sigil has no time forfeit, so a flagged side keeps playing at the floor and
its clock reads 0:00.

Browser: `RustAI` takes `clock: { baseMs, incMs }` (from `?clock=M+S` on any Rust tier; the menu offers
Hard 5+0 and Hard 10+1), mirrors the allocation in `RustAI.moveBudgetMs` so no worker round trip is
needed, charges the clock with the WALL time of each move and credits the increment after it, and
reports budget and clock in the thinking meter ("3.2s of 16.3s (clock 4:12)") and the think report
("..., 4:12 left"). Pondering defaults on for clock games. `tools/wasm-smoke.js` checks 198 allocations
of the JS mirror against the wasm export `move_budget_ms` and the `parseClock` grammar. Python:
`se.move_budget_ms` for a clock-driven harness (not yet written; the arenas remain fixed per-move
time, which is what the tiers and the browser's clock allocation both reduce to). Test
`a_game_clock_is_spent_across_the_game_and_never_flags`.
