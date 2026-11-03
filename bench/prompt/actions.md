# Writing a turn as an action list

Your answer is **one complete turn** for the player to move, written as a JSON array of
action objects.

## How your answer is checked

1. The browser rules engine replays your actions in order, then applies the end of turn
   (Seal of Destruction burn and the game-end checks).
2. The resulting position is then checked:
   - It must be a position that some **legal** turn reaches.
   - It must force a win within the stated number of turns.

Notes:

- The replay does **not** check legality step by step. Each action just changes the board,
  so a mislabelled action produces a wrong position, and the turn is graded illegal. Two
  examples: `move` onto an enemy stone overwrites it without pushing, and `hard_move` onto
  an empty node conjures an enemy stone.
- Only the final position matters. Two action lists that reach the same position are
  equivalent.
- Unknown action types, unknown fields, malformed node names, and spells that are not on the
  board are rejected as malformed.
- Node names are `a1`–`c13`. Spell names use the underscore form exactly as in the position,
  for example `Hail_Storm`.

## Action types

| type | fields | effect when replayed |
|---|---|---|
| `move` | `node`, optional `providence` | Put your stone on `node`. Use it only when `node` is **empty**. |
| `hard_move` | `node`, `pushed_to`, optional `providence` | Put your stone on `node`, which must hold an **enemy** stone. That stone is pushed to `pushed_to`, or crushed if it has nowhere to go (see "Pushes"). |
| `blink` | `node`, `pushed_to` | The same as `move` if `node` is empty, or as `hard_move` if it holds an enemy stone. It is optional sugar for blink placements; `move` and `hard_move` work equally well for blinks. |
| `dash` | `sacrificed`: [2 nodes] | Remove two of your stones (the dash payment). The dash placement is the **next** action. |
| `dash_lightning` | `sacrificed`: [1 node] | The dash payment while you hold Seal of Lightning. |
| `cast` | `spell`, `kept` | Remove all stones from the spell's nodes, then put your stones back on the `kept` nodes. The spell's lock and counter are updated. |
| `sacrifice` | `node` | Remove one of your stones (for Fireblast, Comet, Corrupt and Fury). |
| `fireblast` | `destroyed` | Remove those enemy stones. |
| `hail_storm` | `destroyed` | Remove those enemy stones. |
| `decay` | `destroyed` | Remove those enemy stones. |
| `hurricane` | `destroyed` | Remove those enemy stones. |
| `storm_front` | `destroyed` | Remove those enemy stones. |
| `meteor_destroy` | `node` | Remove that enemy stone. |
| `bewitch` | `node`, `node2` | Convert those two enemy stones to yours. |
| `corrupt` | `converted` | Convert those enemy stones to yours. |
| `starfall` | `node`, `node2`, `destroyed` | Put your stones on `node` and `node2`, then remove the `destroyed` enemy stones. |
| `gust` | `destroyed`, `kept` | Remove the `destroyed` enemy stones, then put **enemy** stones on the `kept` nodes. |
| `fissure` | `node`, `destroyed`, `wall` | Remove the `destroyed` stones (either colour), then make `wall` a wall. Use `"wall": null` when no wall forms. |
| `rock_slide` | `pushes`: [{`from`, `to`}…], `destroyed` | Resolve all pushes at once (see Rock Slide in the spell guide). |
| `bank_stones` | `spell`, `banked` | Add `banked` (1, 2 or 4) to your Providence bank. |
| `pass` | none | Does nothing. It may end the list, but it is optional. |

The per-spell guide (spells.json) gives the exact action sequence for every spell.

## Order of actions

Write the actions in the order the turn happens:

1. **Regular move.** One `move` or `hard_move`. Omit it only if you have no legal regular
   move.
2. **Providence placement** (optional). One `move` or `hard_move` with `"providence": true`.
   It must come immediately after the regular move, and you may write only one.
3. **Dash** (optional):
   - `{"type":"dash","sacrificed":[A,B]}`, or with Seal of Lightning
     `{"type":"dash_lightning","sacrificed":[A]}`;
   - then exactly one `move` or `hard_move` for the dash placement.
4. **Cast** (optional):
   - `{"type":"cast",...}`;
   - then that spell's resolution actions, in the order they happen.
5. **Second cast** (only while you hold Seal of Summer): another cast block.
6. Optionally `{"type":"pass"}`.

Within a spell, write each step in the order you would make it. A later push depends on
where earlier stones went, so the order matters.

## Pushes

For every `hard_move` (and every `blink` onto an enemy stone), the replay works out the push
destinations itself, using the rule in rules section 4. It then reads `pushed_to` as
follows:

- **Two or more destinations:** `pushed_to` chooses among them. **Always give it.**
  - If you omit it, or name a node that is not one of the nearest empty nodes, the replay
    **silently** uses the first destination in its search order. That may not be the one
    you meant.
- **Exactly one destination:** `pushed_to` may be omitted.
- **No destination (the stone is crushed):** omit `pushed_to` or set it to `null`.

## Casting and `kept`

`kept` lists which of the spell's nodes keep your stones after you pay.

- **3-node and 5-node spells:** `kept` must contain exactly `min(mana nodes you control,
  spell size)` nodes of that spell.
  - With no mana, omit `kept` or use `[]`.
  - Keeping too few, too many, or nodes outside the spell produces an illegal position.
- **1-node spells:** never write `kept`.

The resolution then runs on the board after payment. For example, after casting a spell you
can soft-move back into one of its emptied nodes if that node touches one of your stones.

## Placements made by spells

| Kind of placement | Write it as |
|---|---|
| Soft move, soft blink, or any placement on an empty node | `move` |
| Hard move, hard blink, or any placement on an enemy stone | `hard_move` with `pushed_to` |

Whether a placement had to be adjacent is a rules question, not an encoding one.
`move`/`hard_move` are used for regular moves, dash placements, Providence placements and
every spell's placements alike.

The spells written this way are Flourish, Carnage, Grow, Sprout, Slash, Surge, Splash,
Charge, Lurk, Azimuth, Eclipse, Erupt, Gather, Harvest, Torrent, Tsunami, Syzygy, Scatter,
Blossom, the blink of Meteor and Comet, and the moves after Fury's sacrifice.

## Worked examples

All four are real solutions from the puzzle set, replayed and checked by the grader.

### Example 1: push, then a 1-node spell crush

```
Position: rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1
[{"type":"hard_move","node":"a3","pushed_to":"a13"},
 {"type":"cast","spell":"Slash"},
 {"type":"hard_move","node":"a9"},
 {"type":"pass"}]
```

At the start, Blue has 8 stones on the board plus the phantom (9) and Red has 8.

1. **Regular move.** Blue's regular move lands on the red stone at `a3`, which touches blue
   `a4`. Its only nearest empty node is `a13`, so it is pushed there.
2. **Cast Slash.** Slash sits on `a7` (position 7) and holds a blue stone, so Blue casts it.
   As a 1-node spell, it costs that stone and has no `kept`.
3. **Slash's hard move.** Blue hard-moves onto red `a9`. Its neighbours are `a8` and `a10`,
   which are blue, and `a13`, which is red. From `a13` the search can only reach `a3`, now
   blue. No empty node is reachable, so the stone is **crushed** and `pushed_to` is omitted.

Blue now has 9 + 1 = 10 and Red has 7, a lead of 3, so Blue wins.

### Example 2: dash, then two casts with Seal of Summer

```
Position: r........br..b..br.bbbbb.r.......rrrrr./Bewitch,Flourish,Carnage,Grow,Fireblast,Seal_of_Wind,Comet,Seal_of_Summer,Sprout b 16 0:1 -:Flourish -:- tied
[{"type":"move","node":"a8"},
 {"type":"dash","sacrificed":["a10","b11"]},
 {"type":"move","node":"a7"},
 {"type":"cast","spell":"Comet"},
 {"type":"hard_move","node":"a1","pushed_to":"a2"},
 {"type":"sacrifice","node":"a8"},
 {"type":"cast","spell":"Fireblast","kept":["b9","b10"]},
 {"type":"fireblast","destroyed":["a2","a11","b5","b13","c11","c12"]},
 {"type":"sacrifice","node":"a1"},
 {"type":"pass"}]
```

Blue holds Seal of Summer (`b7`), so it may cast twice.

1. **Regular move.** Blue soft-moves to `a8`.
2. **Dash.** Blue sacrifices `a10` and `b11`, then places on `a7`. That fills Comet, which
   is the 1-node spell at `a7`.
3. **Cast Comet.**
   - Its blink lands on red `a1` and pushes it to `a2`.
   - Then Blue sacrifices `a8`.
4. **Cast Fireblast** (`b8`–`b10`). Blue now controls 2 mana nodes, `b1` and `a1`, so it
   keeps 2 of the 3 stones (`b9`, `b10`).
   - Every red stone touching a blue stone is destroyed.
   - Then Blue sacrifices `a1`.

Blue ends with 5 + 1 = 6 against Red's 3 and wins.

### Example 3: Providence placement and banking

```
Position: r.............bbb...bbb..brr.rrr.r..br./Flourish,Blossom,Erupt,Eclipse,Annuity,Grow,Gust,Dividend,Comet b 28 1:0 Annuity:- -:- b1 competitive pm:1:1
[{"type":"move","node":"b1"},
 {"type":"hard_move","node":"c1","pushed_to":"c3","providence":true},
 {"type":"cast","spell":"Annuity","kept":["b9","b10"]},
 {"type":"bank_stones","spell":"Annuity","banked":2},
 {"type":"pass"}]
```

Blue's bank holds 1 stone at the start of the turn, so Blue may place one banked stone.

1. **Regular move.** Blue moves to the mana node `b1`.
2. **Providence placement.** Blue places its banked stone on red `c1`, which touches blue
   `c11`.
   - The search passes through red `c2` and stops at the empty `c3`, at distance 2.
   - The bank drops to 0.
3. **Cast Annuity** (`b8`–`b10`). Annuity is Red's lock, not Blue's, so Blue may cast it.
   - Blue now controls `b1` and `c1` (2 mana), so it keeps `b9` and `b10`.
   - Annuity banks 2 stones (`pm:1:2`).

Blue's total is 9 + 2 + 1 = 12 against Red's 8 + 1 = 9, so Blue wins.

### Example 4: Rock Slide

```
Position: b...bbrbbb.r.rrrrrr....br....r...b.b.../Starfall,Flourish,Erupt,Eclipse,Annuity,Rock_Slide,Surge,Slash,Splash b 28 0:3 -:Starfall -:- tied competitive
[{"type":"hard_move","node":"a7","pushed_to":"a4"},
 {"type":"dash","sacrificed":["a6","a8"]},
 {"type":"move","node":"c9"},
 {"type":"cast","spell":"Rock_Slide","kept":["c10"]},
 {"type":"rock_slide","destroyed":["a5","b2","b5"],
  "pushes":[{"from":"a4","to":"a5"},{"from":"a12","to":"a5"},{"from":"b1","to":"b2"},
            {"from":"b6","to":"b2"},{"from":"b12","to":"b5"}]},
 {"type":"pass"}]
```

1. **Regular move.** Blue pushes red `a7` to `a4`.
2. **Dash.** Blue sacrifices `a6` and `a8`, then completes Rock Slide (`c8`–`c10`) by placing
   on `c9`.
3. **Cast Rock Slide.** Blue has 1 mana (`a1`), so it keeps 1 stone (`c10`).
4. **Pushes.** The red stones touching blue are `a4`, `a12`, `b1`, `b6` and `b12`. Each one
   must be pushed to a neighbouring node:
   - `a4` and `a12` both go to `a5`. Both die, and the blue stone on `a5` survives.
   - `b1` and `b6` both go to red `b2`. Both die, and `b2` survives.
   - `b12` alone goes to `b5`. The stationary red stone on `b5` is destroyed, and the
     `b12` stone takes its place.

`destroyed` lists every destination where a stone died: `a5`, `b2` and `b5`. Red loses 5
stones, so Blue's lead reaches 3 and Blue wins.
