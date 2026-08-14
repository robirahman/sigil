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
(Springtime, Celestial, Inferno, Tempest, Tsunami).

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
| Charm | Gush | Relocate all enemy stones touching you into any empty nodes. *(shipped as Splash → Tsunami)* |
| Charm | Lightning | *(name only)* |
| Charm | Winter | Your opponent cannot cast charms. (Static charms still work.) |

## 2026 Brainstormed Expansion Packs

Refined spell concepts developed in design sessions based on gameplay balance and board geometry constraint analysis.

### Tectonic

*Focuses on physical board force, anchoring, and cascading destruction.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Fissure | Choose a target node. Destroy all enemy stones on that node and all nodes adjacent to it. |
| Sorcery | Rock Slide | Make 1 hard move. If the pushed enemy stone has one or more stone(s) adjacent to it at its new position, destroy the displaced stone and 1 of its adjacent neighbors. |
| Charm | Bulwark | STATIC: Stones in your locked spell cannot be pushed by enemy hard moves. |

### Providence (shipped, rated)

*Deferred payouts: invest mana now, receive extra moves on future turns.
Pending stones shield you from losing (the opponent's win checks count them
against your total) but never power your own ±3-lead win until actually
placed. At the sixth-spell count, invested stones DO count for the player
who cast them (2026-08 playtest ruling).*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Endowment | Make 1 extra move at the beginning of each of your next 4 turns. |
| Sorcery | Annuity | Make 1 extra move at the beginning of each of your next 2 turns. |
| Charm | Dividend | Make 1 extra move at the beginning of your next turn. |

### Aftershock (shipped, unrated playtest)

*Providence's aggressive twin: scheduled destruction instead of scheduled
growth. At the start of each affected turn, destroy 1 enemy stone touching
your stones (your choice; fizzles if none are adjacent — fizzled burns are
lost). Burns ignore Bulwark and count toward no score or win condition.*

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
count toward your stone count defensively — like Providence's pending
stones — but never power your own win claims.*

| Slot | Spell | Effect |
|---|---|---|
| Ritual | Minefield | Place snares on up to 4 empty nodes. |
| Sorcery | Deadfall | Place snares on up to 2 empty nodes. |
| Charm | Tripwire | Place a snare on an empty node. |

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

