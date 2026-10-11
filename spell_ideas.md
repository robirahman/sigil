# Spell ideas

Abandoned / prototype spell designs that were sketched in the original Python
engine (`spellfile.py`) but never shipped as written. Kept here as design notes
after removing the dead commented-out classes from the code. Full prototype
implementations remain in git history.

## Un-shipped ideas

Concepts that were prototyped (and in some cases playtested) but never added to
the game.

| Spell | Type | Effect |
|---|---|---|
| Winter | Static Charm | Your opponent cannot cast charms. (Static charms still work.) |
| Spring | Static Charm | You may cast your locked spells 1 additional time. (Then they are Spring-locked until your lock moves.) |
| Autumn | Static Charm | Your opponent cannot dash. |
| Thunder | Sorcery | Destroy 2 enemy stones that are touching each other. *(Playtested, decided not to add.)* |
| Full Moon | Sorcery | Make 2 moves that finish filling a spell with your stones. |
| Gather | Sorcery | Make 3 moves into locked spells. |
| Gravity | Static Sorcery | Your opponent's standard move each turn must be soft. |
| Tempest | Ritual | Destroy all connected groups of enemy stones that are not connected to mana. |
| Harvest | Ritual | Make 5 moves into locked spells or into Harvest. |
| Inferno | Static Ritual | At the end of your turn, destroy all enemy stones touching you. At the start of your turn, you lose the game. |

## Early drafts of spells that later shipped

These names made it into the game, but the released mechanics differ from the
original prototype below. The shipped definitions live in
`docs/static/scripts/engine/constants.js`.

| Spell | Prototype effect | Shipped as |
|---|---|---|
| Gust | Relocate all enemy stones touching you into any empty nodes. | Shipped ~as-is (Tempest charm). |
| Blossom | Make 1 soft blink move into each other Ritual and Sorcery. | Shipped ~as-is, reworded to 3-node/5-node (Springtime ritual). |
| Eclipse | Make 1 move that finishes filling a spell with your stones. | Revised: make 2 moves into a spell where you control all but 2 nodes (Celestial sorcery). |
| Scatter | Make 1 soft blink move into each charm. | Revised: make 1 soft blink move into each of 2 spells (Springtime sorcery). |
| Fury | Make 2 hard moves. | Revised: sacrifice 1 stone, then make 3 hard moves (Inferno sorcery). |
| Syzygy | Make 3 blink moves into the Sorcery across the board from Syzygy, then 1 into the Charm. | Revised: 1 blink move into the 1-node spell opposite Syzygy, then 3 into the 3-node spell (Celestial ritual). |

## Proposed expansion packs

Two themed expansion line-ups sketched in the old Python spell generator
(`spellgenerator.py`), each following the core 3-rituals / 3-sorceries /
3-charms shape. Neither shipped. Several member spells only ever existed as
names (no mechanics were written); those are marked *(name only)*. The
expansions that actually shipped in the JS game are different sets entirely
(Springtime, Celestial, Inferno, Tempest, Flood).

### Equinox

| Slot | Spell | Effect / status |
|---|---|---|
| Ritual | Planetary_Alignment | *(name only)* |
| Ritual | Blossom | Make 1 soft blink move into each other Ritual and Sorcery. *(shipped, see above)* |
| Ritual | Harvest | Make 5 moves into locked spells or into Harvest. |
| Sorcery | Full_Moon | Make 2 moves that finish filling a spell with your stones. |
| Sorcery | Scattered_Seeds | *(name only)* |
| Sorcery | Fallen_Leaves | *(name only)* |
| Charm | Eclipse | Make 1 move that finishes filling a spell. *(shipped with revised mechanics, see above)* |
| Charm | Spring | You may cast your locked spells 1 additional time (then Spring-locked until your lock moves). |
| Charm | Autumn | Your opponent cannot dash. |

### Apocalypse

| Slot | Spell | Effect / status |
|---|---|---|
| Ritual | Tidal_Wave | *(name only)* |
| Ritual | Tempest | Destroy all connected groups of enemy stones that are not connected to mana. |
| Ritual | Consuming_Darkness | *(name only)* |
| Sorcery | Rushing_Waters | *(name only)* |
| Sorcery | Thunder | Destroy 2 enemy stones that are touching each other. *(playtested, decided not to add)* |
| Sorcery | Blinding_Snow | *(name only)* |
| Charm | Gush | Relocate all enemy stones touching you into any empty nodes. *(shipped as Splash → Flood pack)* |
| Charm | Lightning | *(name only)* |
| Charm | Winter | Your opponent cannot cast charms. (Static charms still work.) |

## 2026 Brainstormed Expansion Packs

Refined spell concepts developed in design sessions based on gameplay balance and board geometry constraint analysis.

### Tectonic

*Focuses on physical board force, anchoring, and cascading destruction.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Fissure | Choose a target node. It is permanently destroyed: its stone is removed and it becomes an impassable void that stones cannot move into, retreat into, or be pushed through, disabling any spell that includes it. Also destroy all stones on adjacent nodes, including your own. |
| Sorcery | Rock Slide | Push each enemy stone bordering you into an adjacent node. All pushes happen simultaneously. Stones already occupying a destination are destroyed; stones pushed onto each other's nodes, or into the same node, are destroyed. |
| Charm | Bulwark | STATIC: Stones in your locked spell cannot be moved, crushed, converted, or destroyed by the opponent. |

Fissure and Bulwark were rebalanced on 2026-10-03. Fissure's blast now also
destroys the caster's own adjacent stones. Bulwark now reads "STATIC: Stones in your
locked spell cannot be moved, crushed, converted, or destroyed by the opponent." Rulings: the shield covers destruction from any source, so it
protects its owner's stones from their own Fissure too, but never blocks a
sacrifice the owner chooses. Fissure may target a node holding a shielded
stone: its unshielded neighbors are destroyed, but the stone stays and no
void forms. Gust can't pick up shielded stones; Rock Slide doesn't push them,
and a stone pushed into one is destroyed as if pushed into a wall. Hurricane
forms its groups from unshielded stones only.

Timing: effects that act one step at a time re-check Bulwark before every
step. These are the hard moves of Carnage, Slash, Fury, Torrent and Tsunami,
Storm Front's two picks, and Corrupt's conversions. Taking the Bulwark stone
with an early step therefore exposes the locked spell to the later steps:
for example, Carnage can push the stone off Bulwark and then push the locked
spell's stones. Effects that hit all their targets at once check Bulwark
only once, when cast: Fireblast, Bewitch, Decay, Rock Slide, Hurricane, Gust,
Starfall's blast, Fissure and the Seal of Destruction. For these the locked
spell stays immune even if the same effect destroys the Bulwark stone.

Rock Slide was reworked on 2026-10-03, after playtesting the new rules as the
Experimental spell "Avalanche". It used to push the bordering stones one at
a time, each push crushing whatever it landed on. Now the caster assigns a
destination to every bordering enemy stone first, and all pushes resolve at
once. Rulings: the pushed set is fixed at cast time and every stone in it
must be pushed, even onto the caster's own stone; any neighbor is a legal
destination, including a Fissure wall, which destroys the stone and stays a
wall; a node whose stone is pushed away counts as vacated, so chains slide
and closed loops rotate harmlessly, while the end of a chain destroys its
stationary occupant; two stones pushed into one node, or onto each other's
nodes, are all destroyed. Recorded games from before the rework were deleted.
The AI's push choice is exact: simboard.rock_slide_optimal_pushes /
constants.js rockSlideOptimalPushes return every max-net push set (one per
distinct resulting board), and the exhaustive enumerators branch over them.

### Providence (shipped, rated)

*Deferred payouts: bank stones now, place them on later turns. Each player
has one Providence bank. Banked stones count toward your stone total at all
times (±3-lead win and sixth-spell count, not zero-stone elimination). A
turn that starts with a nonempty bank may place one banked stone (an
ordinary soft or hard move, untouched by Seal of Wind / Seal of Stone)
after the standard move and before dashing; skipped or blocked placements
stay banked. At most one placement per turn, however many stones are
banked (2026-10 simplification; replaced the per-turn extra-move
schedules).*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Endowment | Add 4 stones to your Providence bank. |
| Sorcery | Annuity | Add 2 stones to your Providence bank. |
| Charm | Dividend | Add 1 stone to your Providence bank. |

### Aftershock (shipped, unrated playtest)

*Providence's aggressive twin: scheduled destruction instead of scheduled
growth. At the start of each affected turn, destroy 1 enemy stone touching
your stones (your choice). A burn triggers only while you are in contact:
if no enemy stone touches yours, the burn is saved — banked back into the
schedule — until one does (2026-08 buff; originally fizzled burns were
lost). Pending burns count fully toward your stone total in the score,
±3-lead, and sixth-spell counts. Burns ignore Bulwark.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Conflagration | Destroy 1 enemy stone touching your stones at the beginning of each of your next 4 turns. |
| Sorcery | Smolder | Destroy 1 enemy stone touching your stones at the beginning of each of your next 2 turns. |
| Charm | Ember | Destroy 1 enemy stone touching your stones at the beginning of your next turn. |

### Ambush (shipped, unrated playtest)

*Visible snare markers on empty nodes. A snare is removed by exactly two
things: an enemy stone coming to rest on it (that stone is destroyed and
the snare consumed) or Fissure's blast (which destroys enemy-of-caster
snares on the target and adjacent nodes). Your own stones coexist with
your snares, and attacking a stone that stands on its own snare triggers
the snare first: the incoming stone is consumed with the snare and no
push resolves — only later moves can push or crush the occupant. Snares
count fully toward your stone count in the score, ±3-lead, and
sixth-spell counts (2026-08 buff; originally defense-only).*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Minefield | Place snares on up to 4 empty nodes. |
| Sorcery | Deadfall | Place snares on up to 2 empty nodes. |
| Charm | Tripwire | Place a snare on an empty node. |

### Experimental (shipped, unofficial, permanently unrated)

*Not a themed pack: the holding pen for not-yet-released spells undergoing
playtest. Spells here may be rebalanced, renamed or cut without notice, and
a game drawing any of them is never rated. The pack need not fill all three
slots (the draw only requires core + selected packs to reach 3 per
category). Experimental spells are absent from the NN spell-ID table (they
encode as ID 0, like Panda) and from the Rust engine, which rejects them.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Shatter | Make 1 hard move, then destroy all enemy stones touching 2 or more of your stones. |
| Ritual | Petrify | STATIC: Opponent cannot make hard moves. |
| Ritual | Fulgurite | Make 1 blink move, then 2 hard moves. |
| Sorcery | Spring Tide | Make 2 hard moves, then 2 soft moves, then sacrifice 2 stones. |
| Sorcery | Rapids | Make 1 soft move, then 1 hard move. You may cast 1 additional spell this turn. |
| Sorcery | Vitrify | STATIC: The enemy cannot dash as long as you have this seal filled. |
| Sorcery | Spellbreak | Unlock the opponent's locked spell and destroy 1 stone on that sigil. Then make 1 soft move. |
| Charm | Silence | Opponent may not cast spells on their next turn. |

Silence (added 2026-10-11) is a 1-node Charm that disables the opponent's
spell window for their entire next turn (`board.silenced[enemy] = true`). The
opponent retains the ability to make opening moves, dash, and pass. The
suppression expires automatically when the opponent ends their turn.

Vitrify (added 2026-10-11) is a 3-node static Sorcery seal that suppresses
the enemy's ability to dash for as long as the seal is held filled. Dash
buttons and dash turn options are completely withheld.

Spellbreak (added 2026-10-11) is a 3-node Sorcery that targets the opponent's
locked spell. Because each player can hold at most one locked spell at any
time, Spellbreak requires no target selection: it unlocks `board.lock[enemy]`
(and any associated springlock) and destroys 1 stone on that sigil (respecting
Bulwark protection). If the opponent has no locked spell, the unlock and
destruction phases do nothing. The caster then makes 1 soft move.

Shatter (added 2026-10-11) is a 5-node Ritual: the caster executes 1 hard
move, followed by the immediate destruction of all enemy stones bordering two
or more of the caster's stones. Destruction is simultaneous and respects
Bulwark.

Petrify (added 2026-10-11) is a 5-node static Ritual seal: while charged, the
opponent cannot make hard moves under any circumstances. Their standard
opening move must be soft, and any hard moves offered by spells have empty
target sets.

Fulgurite (added 2026-10-11) is a 5-node Ritual: the caster makes 1 blink move
(which can blink into an empty node or execute a blink push), followed by 2
hard moves.

Spring Tide (added 2026-09-07; phases flipped to pushes-first the same day)
is Tsunami's chain with the hard moves ahead of the soft ones, at sorcery
price, with the 2-stone sacrifice as the balancing cost. Net material at M mana (a hard move
places a stone on the pushed node, so every move is +1): −3 + M + 4 − 2 =
M − 1, exactly the sorcery line shared by Torrent (−3 + M + 2 = M − 1) and
Tsunami (−5 + M + 4 = M − 1). Without the sacrifice it would sit at M + 1,
two above the line. What the caster buys over Torrent is tempo and shape: a
ritual's four-move burst, two of them pushes, out of a 3-node slot that
charges far sooner, at the cost of choosing which two stones to give up
afterwards. The sacrifice is not paid if the moves already ended the game
(Fireblast/Corrupt convention).

Rapids (added 2026-09-07) is Torrent (M − 1 material) plus a one-turn Seal
of Summer: after it resolves, the caster's spell window reopens for exactly
one more cast, with no dash. Rulings: the extra cast may be any castable
spell, charm or not, and pays its own full cost; Rapids itself is locked by
its own cast, so a second Rapids needs Seal of Spring (and the springlock
then bars a third); it stacks with Seal of Summer (Rapids + Summer = three
casts); a Rapids cast as the Summer second spell still grants its extra
cast. Encoded as the `extra_cast` metadata flag consumed by every turn
driver (live controllers, both sims, both exhaustive enumerators, Flask),
not by the resolver.

### Cosmic

*Symmetry, orbits, and cross-board movement.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Nebula | Make 3 soft blink moves. |
| Sorcery | Conjunction | Make 2 soft blink moves into the spell position directly opposite this one. |
| Charm | Stardust | Make 1 soft blink move into the opposite ritual spell. |

### Chrono

*Time manipulation, spell reaction, and tempo-pacts.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Time Warp | Re-cast the last spell you cast this game, without paying its sacrifice cost. |
| Sorcery | Precognition | STATIC: At the start of your turn, if your opponent cast a spell on their last turn, you may make 1 soft move. |
| Charm | Blood Pact | Sacrifice 1 stone, then make 2 soft moves. |

