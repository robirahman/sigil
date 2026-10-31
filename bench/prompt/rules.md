# Sigil: rules

Sigil is a two-player game for **Red** and **Blue**. Players take turns placing stones on a
39-node graph, pushing and destroying enemy stones, and casting spells. You win by getting
ahead by 3 stones (details in "Winning and losing").

These rules describe the digital game exactly as the browser implements it. Where the
printed rulebook differs, these rules take precedence.

## 1. The board

### Nodes and edges

The board has 39 **nodes** in three zones, `a`, `b` and `c`, named `a1`–`a13`, `b1`–`b13` and
`c1`–`c13`. Two nodes are **adjacent** (they "touch") when they share an edge. Every node
has 2 or 3 neighbours. Here is the complete adjacency list (the graph is undirected):

```
a1: a2 a11     a2: a1 a3 a6    a3: a2 a4 a13   a4: a3 a5 a7    a5: a4 a6 a12
a6: a2 a5 a11  a7: a4 a8 b12   a8: a7 a9 a10   a9: a8 a10 a13  a10: a8 a9 b11
a11: a1 a6 c10 a12: a5 c7      a13: a3 a9
b1: b2 b11     b2: b1 b3 b6    b3: b2 b4 b13   b4: b3 b5 b7    b5: b4 b6 b12
b6: b2 b5 b11  b7: b4 b8 c12   b8: b7 b9 b10   b9: b8 b10 b13  b10: b8 b9 c11
b11: a10 b1 b6 b12: a7 b5      b13: b3 b9
c1: c2 c11     c2: c1 c3 c6    c3: c2 c4 c13   c4: c3 c5 c7    c5: c4 c6 c12
c6: c2 c5 c11  c7: a12 c4 c8   c8: c7 c9 c10   c9: c8 c10 c13  c10: a11 c8 c9
c11: b10 c1 c6 c12: b7 c5      c13: c3 c9
```

The zones are linked in a ring: `a7`–`b12`, `a10`–`b11`, `b7`–`c12`, `b10`–`c11`, `c7`–`a12`
and `c10`–`a11`.

### Spells, mana nodes and void nodes

There are nine **spell positions**, each holding one spell for the whole game:

| Position | Nodes | Size |
|---|---|---|
| 1 | a2 a3 a4 a5 a6 | 5-node |
| 2 | b2 b3 b4 b5 b6 | 5-node |
| 3 | c2 c3 c4 c5 c6 | 5-node |
| 4 | a8 a9 a10 | 3-node |
| 5 | b8 b9 b10 | 3-node |
| 6 | c8 c9 c10 | 3-node |
| 7 | a7 | 1-node |
| 8 | b7 | 1-node |
| 9 | c7 | 1-node |

- **Mana nodes:** `a1`, `b1` and `c1`. You **control** a mana node while your stone is on it.
- **Void nodes:** `a11`–`a13`, `b11`–`b13` and `c11`–`c13`. They belong to no spell.

## 2. Stones

Each node is empty, holds one red stone, holds one blue stone, or is a **wall** (see Fissure).

- Stones never move by themselves. They leave a node only when they are pushed, destroyed,
  sacrificed or converted.
- **Your stones** are the stones of your colour; **enemy stones** are your opponent's.
- **Touching you** means adjacent to at least one of your stones.

## 3. Placing stones

Every placement puts one of your stones on a node that is not your own and not a wall.

- **Soft move:** onto an **empty** node.
- **Hard move:** onto a node holding an **enemy stone**, which is pushed or crushed (see
  section 4).
- **Move** (unqualified): either a soft or a hard move.

By default a placement must touch one of your stones (the node must be adjacent to a node
holding your stone). A **blink** move ignores this requirement and may target any node.

- A **soft blink** must still go onto an empty node.
- A **hard blink** must still go onto an enemy stone.
- A plain **blink** may do either.

Restrictions that apply to every placement:

- You can never place onto your own stone or onto a wall.
- You can never hard-move onto an enemy stone that is protected by **Bulwark**.

## 4. Pushing and crushing

When you hard-move onto an enemy stone, your stone takes the node and the enemy stone is
displaced.

**Finding the destinations.** Search outward from the node, one step at a time, for the
nearest **empty** nodes:

- The search may pass through nodes holding stones of the **pushed stone's own colour**.
- It may **not** pass through your stones (the mover's) or through walls.
- Every empty node at the minimum distance is a legal destination. If there are several,
  **the mover chooses**.

**Crushing.** If no empty node can be reached, the enemy stone is **crushed**: it is removed
from the board.

**Example.** Suppose Blue hard-moves onto a red stone at `a3`, where `a2` is red, `a4` is
blue and `a13` is empty. `a13` is empty at distance 1, so the stone goes there. If `a13`
had been red as well, the search would continue through `a2` and `a13` to empty nodes at
distance 2.

## 5. The turn

Red and Blue alternate turns. Every turn goes in this order. Each step may happen at most
once unless a step says otherwise.

### Step 1. Regular move (mandatory)

Place one stone with a move, soft or hard, that touches one of your stones.

- If you hold **Seal of Wind**, this move may instead be a blink.
- If your opponent holds **Seal of Stone**, this move must be soft. If you also hold Seal of
  Wind, it may be a soft blink onto any empty node.
- If you have no legal regular move, skip it. The rest of the turn still happens.

### Step 2. Providence placement (optional)

This step applies only if your Providence bank was non-empty **at the start of the turn**.

- Take one banked stone and place it with an ordinary adjacent soft or hard move. Seal of
  Wind and Seal of Stone do not apply to this placement.
- Your bank decreases by 1.
- You may place at most one banked stone per turn.

### Step 3. Dash (optional)

1. Sacrifice 2 of your stones from anywhere on the board (remove them).
   - With **Seal of Lightning**, sacrifice only 1 stone.
2. Place one stone with an ordinary adjacent soft or hard move. Seal of Wind and Seal of
   Stone do not apply to this placement.

Restrictions:

- You may dash only if you have **at least 3 stones on the board** before sacrificing.
  This applies even with Seal of Lightning.
- If your opponent holds **Seal of Autumn**, you may not sacrifice stones that sit on any
  spell node (positions 1–9).
- A dash is not allowed after you have cast a spell this turn.

### Step 4. Cast (optional)

Cast one spell (see section 6).

- If you hold **Seal of Summer** after the first cast has resolved, you may cast a **second**
  spell.
- No dash is allowed after a cast.

### Step 5. End of turn

These happen in order (see section 8):

1. Seal of Destruction burns.
2. The game-end checks are made.
3. The turn passes to your opponent.

**Mandatory sub-steps.** Within spells, every instruction is mandatory as far as it is
possible. For example, "Make 4 soft moves" means you must keep making soft moves while a
legal one exists. If none exists, the remaining moves are lost. The only optional parts are
those that say "up to" or "may".

## 6. Spells

### Charging

A spell is **charged** for you (you **hold** it) while **every** node of its position holds
your stone. A position that contains a wall can never be charged.

### Static spells

Seal of Lightning, Seal of Wind, Seal of Summer, Seal of Spring, Seal of Autumn, Seal of
Winter, Seal of Stone, Seal of Destruction and Bulwark are **static**:

- They are never cast.
- Their effect applies to the holder while charged.
- The effect starts or stops **immediately**, even in the middle of a turn, the moment the
  spell becomes filled or loses a stone.

### Casting

To cast a non-static spell it must be charged by you, and:

- It must not be **your lock** (see "Locks" below), unless Seal of Spring allows it.
- **1-node spells** cannot be cast while your opponent holds **Seal of Winter**.
- **Surge** may be cast only if you dashed this turn. **Splash** may be cast only if you did
  not dash this turn.

Casting has three steps:

1. **Pay.** Remove **all** your stones from the spell's nodes.
   - For a 3-node or 5-node spell, you then put back (**keep**) stones on
     `k = min(number of mana nodes you control, size of the spell)` of those nodes. You
     choose which nodes. You must keep exactly `k` stones.
   - A 1-node spell always loses its stone. Mana does not help it.
   - Example: casting a 5-node spell while controlling 2 mana nodes costs 3 stones, and you
     choose which 2 of the 5 nodes keep their stones. With 3 mana, a 3-node spell costs
     nothing and stays charged.
2. **Resolve** the effect (see the spell texts). It is resolved on the board after
   payment. "Touching you", "your stones" and similar phrases refer to that board.
3. **Lock** (3-node and 5-node spells only). The spell becomes your lock, and your **spell
   counter** increases by 1. 1-node spells never lock and never count.

### Locks

Each player has at most one lock: the last 3-node or 5-node spell they cast.

- You cannot cast your own lock.
- You may cast your opponent's lock.
- During a spell's resolution, your lock is still the previous one. It changes only after
  the spell resolves. This matters for Gather, Harvest and Bulwark.

### Seal of Spring and springlocks

While you hold Seal of Spring, you may cast your own lock **once more**.

- That second cast marks it as **springlocked**. A springlocked spell cannot be cast by you
  again.
- Casting any different 3-node or 5-node spell moves your lock to the new spell and clears
  your springlock.
- Each cast still increases the spell counter.

### Bulwark

While you hold Bulwark, **your** stones on the nodes of **your locked spell** are
**shielded**. A shielded stone:

- cannot be hard-moved onto, and therefore never pushed or crushed;
- cannot be converted;
- cannot be destroyed by any effect, including the holder's own Fissure and Seal of
  Destruction burns;
- is never pushed by Rock Slide, and acts like a wall for stones Rock Slide pushes into it.

Bulwark does not stop sacrifices, which are always your own choice. Effects that act one
stone at a time (hard moves, Storm Front, Corrupt) re-check shielding before each step. If
an earlier step removes a stone from Bulwark itself, the protection is gone for the later
steps.

### Fissure walls

Fissure turns a node into a permanent **wall**, shown as `x`. A wall:

- holds no stone, and is not empty;
- cannot be placed on;
- cannot be pushed into or through;
- does not count as empty for Decay;
- permanently disables any spell whose position includes it. The spell can never be
  charged again, so it can't be cast and its static effect never applies.

### Providence bank

Dividend, Annuity and Endowment add 1, 2 and 4 stones to your **bank**.

- Banked stones count fully toward your **score** (lead and sixth-spell totals).
- They do **not** count as stones on the board for the zero-stones rule or for dashing.
- A banked stone can be placed only in step 2 of a later turn.

## 7. Score

The score is a stone count:

- **Red total** = red stones on the board + red bank.
- **Blue total** = blue stones on the board + blue bank + **1**.

The extra 1 is Blue's permanent **phantom score stone**. It can never be sacrificed,
destroyed or placed, and it does not count as a stone on the board. With equal stones on
the board and equal banks, Blue leads by 1.

## 8. Winning and losing

### Immediately, at any moment

If a player has **zero stones on the board**, they lose immediately. This applies even in
the middle of a turn, for example when an enemy's last stone is destroyed. Banks and the
phantom stone do not count. If both players reach zero at once, the player whose turn it is
loses.

### At the end of every turn, in this order

1. **Seal of Destruction burn.** If the player who just moved holds Seal of Destruction,
   every enemy stone touching them is destroyed (shielded stones excepted).
2. **Lead check.** If either total exceeds the other by **3 or more**, the player with the
   larger total wins. This applies to either player, not only the mover.
3. **Sixth spell.** If the player who just moved has a spell counter of **6 or more**, the
   game ends:
   - The larger total wins.
   - On a tie, the player who just moved **loses**.
4. **Seal of Destruction claim.** If the player who is **about to move** holds Seal of
   Destruction at this moment, they lose. ("If filled at the start of your turn, you lose.")
   - A turn that leaves your opponent holding Seal of Destruction therefore wins.
   - If you hold it yourself, it burns now and you lose at the start of your next turn
     unless your opponent breaks it first.

The game ends the moment any of these happens. Nothing later in the turn changes the
result.

Threefold repetition is ignored in this benchmark.

### Variants

Only `standard` and `competitive` positions appear.

- In **competitive** games the board starts empty, and each player's first turn is a single
  stone placed on any empty node.
- After those opening turns the two variants have identical rules. Benchmark positions are
  never in the opening.

## 9. Position format (SFN)

A position is one line of space-separated fields:

```
<stones>/<spells> <side> <turn> <rsc>:<bsc> <rlock>:<block> <rspring>:<bspring> <score> [variant] [pm:<rbank>:<bbank>]
```

| Field | Meaning |
|---|---|
| `stones` | 39 characters, one per node in the order `a1`…`a13`, `b1`…`b13`, `c1`…`c13`: `r` red stone, `b` blue stone, `.` empty, `x` wall. |
| `spells` | The nine spell names (underscores for spaces) for positions 1–9 in order. The first three are the 5-node spells (`a2`–`a6`, `b2`–`b6`, `c2`–`c6`), the next three the 3-node spells (`a8`–`a10`, `b8`–`b10`, `c8`–`c10`), and the last three the 1-node spells (`a7`, `b7`, `c7`). |
| `side` | `r` or `b`: the player to move, who is the solver. |
| `turn` | A turn counter. It is informational only and has no effect on the rules. |
| `rsc:bsc` | Red and Blue spell counters: the number of 3-node and 5-node spells each has cast. Reaching 6 ends the game (see section 8). |
| `rlock:block` | Each player's locked spell, or `-` for none. |
| `rspring:bspring` | Each player's springlocked spell, or `-`. |
| `score` | Derived summary of the totals in section 7 (bank and phantom included): `tied`, `r1`/`r2`/`r3` (Red ahead by 1, 2, or 3 or more), or `b1`/`b2`/`b3`. Recomputed after every change. |
| `variant` | Optional. `competitive` when present; absent means `standard`. |
| `pm:R:B` | Optional. The Providence bank sizes, present only when one is non-zero. |

Example:

```
rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1
```

- Blue is to move.
- `a1`=r, `a2`=r, `a3`=r, `a4`=b, and so on.
- The spell positions hold: Bewitch at `a2`–`a6`, Seal of Lightning at `b2`–`b6`,
  Flourish at `c2`–`c6`, Seal of Wind at `a8`–`a10`, Grow at `b8`–`b10`, Fireblast at
  `c8`–`c10`, Slash at `a7`, Surge at `b7` and Comet at `c7`.
- Nobody has cast a 3-node or 5-node spell, and there are no locks.
- Red and Blue have 8 stones each on the board, so Blue leads by 1 through the phantom
  stone: `b1`.
