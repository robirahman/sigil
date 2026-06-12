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
