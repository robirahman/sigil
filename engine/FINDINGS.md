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
