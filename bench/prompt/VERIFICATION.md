# SigilBench prompt: verification record

This file records how `rules.md`, `actions.md` and `spells.json` were checked against the
implementation. It is not part of the model prompt.

## Method

**Sources read.** The rules text was written from these files, and the printed rulebook was
used only as a cross-check:

- the browser rules: `docs/static/scripts/engine/{constants,board,moves,spells,sim-board,game-controller,ai-player}.js`;
- the Rust mirror: `engine/src/{turn,cast,cast_enum,rockslide,board,sfn,actions,mate}.rs`.

**The checking pipeline.** Each case is an SFN (the solver to move) plus an action list:

1. `node bench/grader/apply.js` replays the list with `applyAITurn`.
2. The resulting SFN is passed with n = 1 to `target/release/examples/bench_grade`.

`bench_grade` prints `legal` (some legal turn reaches exactly that position) and, as a by-product, a
mate verdict.

**Expected-illegal cases.** A turn can be expected to be illegal and still be graded legal,
because grading looks only at positions: a different, legal action list may happen to
reach the same position. When that happened, the `children` example was used to find that
legal witness list, and the test was repeated on other positions until one had no witness.
Each expected-illegal case below is graded illegal (`legal=false`).

**Where the cases came from.** Positions were drawn from
`docs/static/puzzles/mate_puzzles.json` (puzzle roots plus every stored line's intermediate
position, 4,501 positions). Engine-emitted lists come from the `children` example. The
scripts live in the session scratch directory and are not committed.

**Overall result.** For every documented encoding and rule below, the result matches the
expectation, apart from the four discrepancies listed in the next section.

## Discrepancies found

### A. Browser JS allows it, the grader (Rust) rejects it

The grader will mark these JS-legal turns as illegal. `rules.md` and `spells.json`
describe the JS behaviour and say nothing about the grader's narrower set. Before release,
either widen the Rust enumerator, or add the restriction to the prompt.

1. **Rock Slide: any push assignment vs only the best ones.**
   - **JS:** `spells.js` `rock_slide` lets the caster send each bordering enemy stone to
     any adjacent node.
   - **Rust:** `cast_enum.rs` `Resolve::RockSlide` enumerates only the assignments that
     maximise *(enemy destroyed − own destroyed)*. Its comment claims "the set the JS and
     Python enumerators offer", which is true of the JS enumerator but not of the
     interactive rules.
   - **Test:** on a 2-source position, both non-max assignments are graded illegal and the
     max one legal (case "RS non-max-net assignment" below).
2. **Corrupt: up to 3 vs exactly the maximum.**
   - **JS:** `spells.js` `corrupt` converts "up to 3" and lets the player stop early
     (`actionlist: ['pass']`), including after 0 conversions.
   - **Rust:** `Resolve::Corrupt` only emits sets of the largest convertible size
     (`while k > 0 && !any_legal(...) { k -= 1; }`).
   - **Test:** converting 1 of 2, or 0, is graded illegal.
3. **Comet: sacrificing the stone that just blinked.**
   - **JS:** `spells.js` `comet` accepts any own stone for the sacrifice, including the one
     just placed.
   - **Rust:** `Resolve::Comet` excludes it (`own = b.mine(c) & !(1u64 << node)`).
   - **Test:** of 12 sampled positions, 4 were graded illegal. The other 8 were legal only
     because another legal list happened to reach the same position.
4. **Erupt move order (possible; not verified).**
   - **JS:** `spells.js` `erupt` lets the caster interleave moves across the eligible
     spells in any order, and keeps offering moves until no target remains in any spell
     with quota left.
   - **Rust:** `Resolve::Erupt` resolves spells in a fixed order (positions 1→6), each to
     completion, and never revisits a spell processed earlier. Two kinds of positions
     could be missing:
     - an earlier push changes the targets in a later spell;
     - a later spell's move creates a new target in an earlier spell.
   - **Status:** no differential test was run (it needs a JS enumerator of Erupt
     interleavings). Flagged for the section 1 differential test in `bench/CHECKLIST.md`.

### B. Replay and grading behaviours worth knowing (not rule differences)

These are documented in `actions.md`:

- `applyAITurn` does not check legality step by step:
  - `move` onto an enemy stone overwrites it;
  - `hard_move` onto an empty node creates an enemy stone at the push destination;
  - a `pushed_to` that is not among the push options is silently replaced by the first
    option (T24b).
  - In each of these cases bench_grade catches the resulting impossible position.
- Order errors are invisible whenever a legal reordering reaches the same position. Writing
  the Providence placement after the dash is an example (case "Providence placement written
  after the dash"). The grader accepts such lists. This is harmless, since the position is
  legal.
- For `rock_slide`, the replay infers Bulwark shields from the `destroyed` field
  (`rockSlideReplayShielded`): an occupied, non-moving destination that is *not* listed is
  treated as shielded.
  - Demonstration on the worked-example-4 position with pushes
    `a4→a5, a12→a13, b1→b2, b6→b2, b12→b5`:
    - with `destroyed:["a5","b2","b5"]`, `a5` becomes red;
    - with `destroyed` omitted, `a5` stays blue.
  - Both lists are non-max-net, so the grader rejects both anyway.
- `apply.js` reports `gameover:false` for a turn that leaves the opponent holding Seal of
  Destruction, because it does not apply the next turn's start-of-turn check. bench_grade
  (`turn.rs apply_turn` → `destruction_start_of_turn`) does count it as an immediate win
  (case "turn that leaves the opponent holding Seal of Destruction": verdict mate,
  immediate).
- The `children` example prints `after` SFNs from `emit_actions`, which deliberately skips the
  Seal of Destruction burn (`turn.rs` ~592). Those SFNs can differ from apply.js by the
  burned stones. `legal_successor` uses `apply_turn`, which includes the burn, so grading is
  consistent.
- **Competitive opening counter.** The JS live controller numbers turns from 1, so its
  `update()` opening-pass check is `turnCounter <= 2`. During an apply.js replay the counter
  is the SFN's value (one lower), and Rust uses `turn_counter <= 2` on the SFN value. The
  two could disagree on red's second turn of a competitive game. This is irrelevant here:
  benchmark and dev positions have turn ≥ 6.

### C. Browser rules vs the printed rulebook

`rules.md` follows the JS where the two differ:

- **Zero stones on the board** loses immediately, at any moment, and banks and the phantom
  stone don't count (`board.js update`). The printed rulebook has no such rule.
- **Dash** requires at least 3 stones on the board, even with Seal of Lightning
  (`moves.js canDash`). The rulebook only says "sacrifice any two of your stones".
- **The dash placement and Providence placements** are ordinary adjacent moves. Seal of
  Wind and Seal of Stone apply only to the regular move. The rulebook does not cover this.
- **"No legal regular move":** the turn continues with the optional steps (ruling
  2026-08-26, in `game-controller.js`).
- **Repetition:** JS gives Blue the win on the third occurrence of a position. The rulebook
  describes a looser loop rule. Repetition is ignored in the benchmark.
- **The sixth-spell tie** goes against the caster. JS (`checkGameOver`) and the rulebook
  agree.
- **Digital-only mechanics,** all described from code: Providence bank, Fissure walls,
  springlocks, Seal of Destruction's start-of-turn loss, Bulwark shields, and the competitive
  variant.

## Not verified by a test case (described from code reading only)

- Fissure on a Bulwark-shielded target (`"wall": null`, no wall forms).
- A Gust that picks up every remaining enemy stone. JS ends the game at once (UI) while
  `applyAITurn` still places the stones; the Rust Gust also places them, so the positions
  should agree, but no case was run.
- The zero-stones rule when both players reach zero at once (the mover loses).
- The sixth-spell end, including the tie rule.
- A Seal of Summer second cast enabled by filling Summer during the first spell.
- The Syzygy opposite-slot table. It matches `constants.js` `syzygyOpposite`, and stored
  Syzygy lines from position 1 (into `b7`, `b8`–`b10`) replay legal; positions 2 and 3 were
  not individually tested.
- The Erupt interleavings (item A4).

## General action patterns and rules

- **T1 trailing pass omitted** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a13"},{"type":"dash","sacrificed":["a3","a4"]},{"type":"move","node":"a4"}]`
- **T1b stored with pass** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a13"},{"type":"dash","sacrificed":["a3","a4"]},{"type":"move","node":"a4"},{"type":"pass"}]`
- **T32 single-option push with pushed_to omitted** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a3"},{"type":"pass"}]`
- **T24 push to the other equidistant node** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a5","pushed_to":"c7"}]`
- **T24b push with invalid pushed_to (silently replaced by default)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a5","pushed_to":"a5"}]`
- **T33 hard_move onto an empty node** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"b2"},{"type":"pass"}]`
- **T34 move onto an enemy stone** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a3"},{"type":"pass"}]`
- **T2 cast keeps one fewer stone than mana allows** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrr...brbr.rbbbb.b....br.......rr...../Starfall,Seal_of_Lightning,Bewitch,Hail_Storm,Grow,Fireblast,Seal_of_Summer,Comet,Slash r 23 1:0 Fireblast:- -:- r1`
  - actions: `[{"type":"move","node":"a5"},{"type":"dash","sacrificed":["a9","a11"]},{"type":"move","node":"a6"},{"type":"cast","spell":"Starfall","kept":[]},{"type":"starfall","node":"a2","node2":"a3"},{"type":"pass"}]`
- **T6 dash paying 2 while holding Seal of Lightning** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrr.rrb.rr..rbbbbbb....rbb............./Flourish,Seal_of_Lightning,Bewitch,Hail_Storm,Fireblast,Seal_of_Wind,Seal_of_Summer,Surge,Comet b 18 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash","sacrificed":["a4","a7"]},{"type":"move","node":"a8"},{"type":"pass"}]`
- **T6b dash_lightning (engine list)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrr.rrb.rr..rbbbbbb....rbb............./Flourish,Seal_of_Lightning,Bewitch,Hail_Storm,Fireblast,Seal_of_Wind,Seal_of_Summer,Surge,Comet b 18 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash_lightning","sacrificed":["a4"]},{"type":"move","node":"a8"},{"type":"pass"}]`
- **T7 Wind: regular move is a non-adjacent blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r......r..r..bbbbb..rr.b..r......rrr.b./Starfall,Seal_of_Lightning,Carnage,Grow,Hail_Storm,Seal_of_Wind,Sprout,Slash,Surge r 17 0:0 -:- -:- r1`
  - actions: `[{"type":"blink","node":"a3"},{"type":"pass"}]`
- **T7b same with type blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r......r..r..bbbbb..rr.b..r......rrr.b./Starfall,Seal_of_Lightning,Carnage,Grow,Hail_Storm,Seal_of_Wind,Sprout,Slash,Surge r 17 0:0 -:- -:- r1`
  - actions: `[{"type":"blink","node":"a3"},{"type":"pass"}]`
- **T10 Seal of Summer: two casts** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrr.rrb.rr..rbbbbbb....rbb............./Flourish,Seal_of_Lightning,Bewitch,Hail_Storm,Fireblast,Seal_of_Wind,Seal_of_Summer,Surge,Comet b 18 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash_lightning","sacrificed":["a4"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Surge"},{"type":"move","node":"b7"},{"type":"cast","spell":"Surge"},{"type":"move","node":"b9"},{"type":"pass"}]`
- **T11 Seal of Spring: cast own locked spell** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `b..b..b..b...rrrrrb.r.rrbrb......b...../Starfall,Seal_of_Lightning,Blossom,Meteor,Seal_of_Wind,Fury,Seal_of_Spring,Slash,Comet b 22 0:3 -:Fury -:- tied competitive`
  - actions: `[{"type":"move","node":"c9"},{"type":"dash","sacrificed":["a1","a4"]},{"type":"move","node":"c10"},{"type":"cast","spell":"Fury","kept":["c10"]},{"type":"sacrifice","node":"a7"},{"type":"hard_move","node":"b2","pushed_to":"b7"},{"type":"hard_move","node":"b1"},{"type":"hard_move","node":"b3","pushed_to":"b9"},{"type":"pass"}]`
- **T19b enemy Seal of Stone: soft regular move (engine list)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `...............r...bbbb...rbbrrr....rrr/Tsunami,Bewitch,Seal_of_Lightning,Eclipse,Seal_of_Stone,Grow,Lurk,Splash,Slash r 21 0:0 -:- -:- r1 competitive`
  - actions: `[{"type":"move","node":"b2"},{"type":"pass"}]`
- **T21 enemy Seal of Autumn: dash sacrificing a spell-node stone** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `bbrrbbrrrb.brr....r.....r.......b....../Tsunami,Carnage,Erupt,Hail_Storm,Decay,Grow,Azimuth,Charge,Seal_of_Autumn r 27 3:0 Carnage:- -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"a11"},{"type":"dash","sacrificed":["a2","b1"]},{"type":"hard_move","node":"a1","pushed_to":"c10"},{"type":"pass"}]`
- **T21b enemy Seal of Autumn: dash (engine list)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `bbrrbbrrrb.brr....r.....r.......b....../Tsunami,Carnage,Erupt,Hail_Storm,Decay,Grow,Azimuth,Charge,Seal_of_Autumn r 27 3:0 Carnage:- -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"a11"},{"type":"dash","sacrificed":["a13","b1"]},{"type":"hard_move","node":"a1","pushed_to":"c10"},{"type":"pass"}]`
- **T29 Hail Storm as one action listing every destroyed stone** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r..r..rrrbb..b..rr.....br........bbb.../Flourish,Seal_of_Lightning,Bewitch,Meteor,Seal_of_Wind,Hail_Storm,Seal_of_Summer,Slash,Surge b 16 1:1 Flourish:Meteor -:- tied`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a2"},{"type":"dash","sacrificed":["a1","a10"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Hail_Storm","kept":["c9","c10"]},{"type":"hail_storm","destroyed":["a2","b4","a8"]},{"type":"pass"}]`
- **T29b Hail Storm engine list** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r..r..rrrbb..b..rr.....br........bbb.../Flourish,Seal_of_Lightning,Bewitch,Meteor,Seal_of_Wind,Hail_Storm,Seal_of_Summer,Slash,Surge b 16 1:1 Flourish:Meteor -:- tied`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a2"},{"type":"dash","sacrificed":["a1","a10"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Hail_Storm","kept":["c9","c10"]},{"type":"hail_storm","destroyed":["a2"]},{"type":"hail_storm","destroyed":["b4"]},{"type":"hail_storm","destroyed":["a8"]},{"type":"pass"}]`
- **T30 Fireblast wiping out the enemy, no sacrifice** — expected legal; apply.js ok=True; bench_grade legal=True (mate) → OK
  - SFN: `rrbbr..rrr..b.....b....b.............../Starfall,Seal_of_Lightning,Carnage,Fireblast,Meteor,Grow,Surge,Comet,Sprout r 19 0:0 -:- -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a7"},{"type":"dash","sacrificed":["a2","a5"]},{"type":"hard_move","node":"b11","pushed_to":"b1"},{"type":"cast","spell":"Fireblast","kept":["a8"]},{"type":"fireblast","destroyed":["a4","a7","a13","b1","b6"]},{"type":"pass"}]`
- **N3 Grow making 1 of 2 available soft moves** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `.rrr..rrrr..rrbbbbr.bbbrbb............./Starfall,Seal_of_Lightning,Flourish,Grow,Fireblast,Meteor,Slash,Seal_of_Summer,Surge r 19 0:0 -:- -:- r1`
  - actions: `[{"type":"move","node":"a1"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Grow","kept":["a10"]},{"type":"move","node":"a1"},{"type":"pass"}]`
- **N3b Flourish making 3 of 4 available soft moves** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `bbbbbbrr.r...r......r..rb.r......rrr.../Flourish,Bewitch,Carnage,Meteor,Seal_of_Wind,Hail_Storm,Slash,Sprout,Seal_of_Summer b 26 3:0 Meteor:- -:- r2 competitive`
  - actions: `[{"type":"hard_move","node":"a7","pushed_to":"a9"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Flourish"},{"type":"move","node":"a4"},{"type":"move","node":"a3"},{"type":"move","node":"a2"},{"type":"pass"}]`
- **N3c Carnage making 3 of 4 available hard moves** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrrrr.bbbr....b..........b............/Carnage,Flourish,Starfall,Seal_of_Wind,Hail_Storm,Fireblast,Slash,Comet,Sprout r 13 0:0 -:- -:- r1`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Carnage"},{"type":"hard_move","node":"a8","pushed_to":"a13"},{"type":"hard_move","node":"a9","pushed_to":"b11"},{"type":"hard_move","node":"a10","pushed_to":"b1"},{"type":"pass"}]`
- **N17 Surge cast without dashing** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rbbbrb....rr.b..b..b......rrr........../Carnage,Bewitch,Flourish,Fireblast,Hail_Storm,Grow,Seal_of_Summer,Surge,Comet b 18 0:1 -:Bewitch -:- b1`
  - actions: `[{"type":"move","node":"a7"},{"type":"cast","spell":"Surge"},{"type":"move","node":"b12"},{"type":"pass"}]`
- **N18 Splash cast after dashing** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrrr.....r..bbbbbbb.rrbbr.........r.../Bewitch,Carnage,Syzygy,Torrent,Seal_of_Wind,Fury,Charge,Splash,Sprout b 22 1:0 Bewitch:- -:- tied`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"move","node":"a8"},{"type":"cast","spell":"Splash"},{"type":"hard_move","node":"a4","pushed_to":"a13"},{"type":"pass"}]`
- **N19 enemy Seal of Stone: hard regular move** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `br..r.r..rb..brr.rrbbbbb..r........b.b./Starfall,Syzygy,Flourish,Decay,Seal_of_Stone,Fury,Seal_of_Winter,Lurk,Slash r 57 5:3 Starfall:Fury -:- b2 competitive`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a6"},{"type":"pass"}]`
- **N20 enemy Seal of Winter: casting a 1-node spell** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrrrrrr.....bb.bbbbb...............b../Seal_of_Lightning,Harvest,Carnage,Gather,Storm_Front,Fury,Seal_of_Winter,Charge,Gust b 24 0:3 -:Storm_Front -:- b1 competitive`
  - actions: `[{"type":"move","node":"b3"},{"type":"cast","spell":"Charge"},{"type":"move","node":"c6"},{"type":"pass"}]`
- **N22 hard move onto an enemy stone shielded by Bulwark** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `b.bb..b..x...r..r..rrrr..rb..rrbrbb.br./Fissure,Flourish,Hurricane,Meteor,Eclipse,Scatter,Bulwark,Charge,Sprout r 31 3:3 Flourish:Scatter -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"c8","pushed_to":"c10"},{"type":"pass"}]`
- **N10 two casts without Seal of Summer** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `r.........r..bb.....bbb...rbrrbb..rrr.r/Seal_of_Lightning,Starfall,Bewitch,Meteor,Fireblast,Hail_Storm,Comet,Sprout,Slash b 18 0:0 -:- -:- tied`
  - actions: `[{"type":"move","node":"b3"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Sprout"},{"type":"move","node":"b13"},{"type":"cast","spell":"Fireblast","kept":["b10"]},{"type":"fireblast","destroyed":["c1","c3","c4","c11"]},{"type":"sacrifice","node":"b1"},{"type":"pass"}]`
- **Syzygy placements written as blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `bbbbbbr..rbb..rrbb.rrrr.brrrrrrrbbbbrrb/Harvest,Bewitch,Syzygy,Grow,Gather,Torrent,Azimuth,Seal_of_Winter,Splash r 33 3:3 Grow:Torrent -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a4","pushed_to":"a13"},{"type":"dash","sacrificed":["a4","a7"]},{"type":"move","node":"a8"},{"type":"cast","spell":"Syzygy","kept":["c4"]},{"type":"blink","node":"a7"},{"type":"blink","node":"a9"},{"type":"pass"}]`
- **Meteor placements written as blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rbb.bb..bbrbbbb........b..rrr.rrbrrrr.r/Bewitch,Starfall,Carnage,Fireblast,Seal_of_Wind,Meteor,Slash,Sprout,Surge r 23 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"a4"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Meteor","kept":["c9","c10"]},{"type":"blink","node":"a2"},{"type":"meteor_destroy","node":"a3"},{"type":"pass"}]`
- **Comet placements written as blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrrr.rbbb...b............rb...b....b../Carnage,Seal_of_Lightning,Starfall,Hail_Storm,Meteor,Seal_of_Wind,Comet,Seal_of_Summer,Slash r 15 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a6"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Carnage","kept":["a4"]},{"type":"hard_move","node":"c11","pushed_to":"b10"},{"type":"hard_move","node":"b10","pushed_to":"b8"},{"type":"hard_move","node":"b8","pushed_to":"b7"},{"type":"hard_move","node":"b7","pushed_to":"b4"},{"type":"cast","spell":"Comet"},{"type":"blink","node":"a1"},{"type":"sacrifice","node":"a4"},{"type":"pass"}]`
- **Charge placements written as blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrrrrrr.....bb.bbbbb...............b../Seal_of_Lightning,Harvest,Carnage,Gather,Storm_Front,Fury,Seal_of_Winter,Charge,Gust b 24 0:3 -:Storm_Front -:- b1 competitive`
  - actions: `[{"type":"move","node":"b12"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"hard_move","node":"a7","pushed_to":"a9"},{"type":"cast","spell":"Charge"},{"type":"blink","node":"a4","pushed_to":"a13"},{"type":"pass"}]`
- **Tsunami placements written as blink** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrrrr.............bb.b....b.bbb.rr..b./Tsunami,Corrupt,Seal_of_Destruction,Decay,Seal_of_Stone,Eclipse,Comet,Sprout,Surge r 17 0:0 -:- -:- b1 competitive`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Tsunami"},{"type":"blink","node":"a4"},{"type":"blink","node":"a3"},{"type":"pass"}]`
- **Providence: engine list (['Dividend'])** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r.rr.rbbbb.............r.............../Flourish,Fissure,Endowment,Fury,Storm_Front,Fireblast,Dividend,Sprout,Seal_of_Winter b 14 0:0 -:- -:- b1 competitive pm:0:1`
  - actions: `[{"type":"hard_move","node":"a4","pushed_to":"a5"},{"type":"dash","sacrificed":["a4","a7"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Dividend"},{"type":"bank_stones","spell":"Dividend","banked":1},{"type":"pass"}]`
- **Providence placement then dash (engine)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `.............b.bbb.brrr.bbrr.rrr....rb./Fissure,Flourish,Tsunami,Meteor,Eclipse,Rock_Slide,Lurk,Seal_of_Spring,Dividend r 27 4:0 Tsunami:- -:- r1 competitive pm:1:0`
  - actions: `[{"type":"hard_move","node":"b7","pushed_to":"b2"},{"type":"hard_move","node":"b4","pushed_to":"b6","providence":true},{"type":"dash","sacrificed":["b4","b7"]},{"type":"move","node":"b7"},{"type":"pass"}]`
- **Providence placement written after the dash (order not enforced by grader)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `.............b.bbb.brrr.bbrr.rrr....rb./Fissure,Flourish,Tsunami,Meteor,Eclipse,Rock_Slide,Lurk,Seal_of_Spring,Dividend r 27 4:0 Tsunami:- -:- r1 competitive pm:1:0`
  - actions: `[{"type":"hard_move","node":"b7","pushed_to":"b2"},{"type":"dash","sacrificed":["b4","b7"]},{"type":"move","node":"b7"},{"type":"hard_move","node":"b4","pushed_to":"b6","providence":true},{"type":"pass"}]`
- **Placing a stone banked this same turn** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `................bbb.bbb..brrrrrr.rrrb.r/Erupt,Endowment,Seal_of_Lightning,Torrent,Seal_of_Stone,Annuity,Slash,Azimuth,Charge r 23 0:0 -:- -:- r1 competitive`
  - actions: `[{"type":"move","node":"a11"},{"type":"dash_lightning","sacrificed":["a11"]},{"type":"move","node":"a11"},{"type":"cast","spell":"Annuity","kept":["c10"]},{"type":"bank_stones","spell":"Annuity","banked":2},{"type":"move","node":"a1","providence":true},{"type":"pass"}]`
- **Turn ending with Seal of Destruction filled (burn at end of turn)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `bbbbb...bb..b...rrr.....r..r..rr.....r./Syzygy,Seal_of_Destruction,Hurricane,Fury,Torrent,Gather,Lurk,Sprout,Seal_of_Spring r 17 0:0 -:- -:- b1 competitive`
  - actions: `[{"type":"move","node":"b2"},{"type":"dash","sacrificed":["b12","c2"]},{"type":"move","node":"b3"},{"type":"pass"}]`
- **Wind + enemy Stone: soft blink to a non-adjacent empty node** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `b......b.b...b......rrr..rrrr....bbbrbr/Bewitch,Hurricane,Starfall,Fury,Seal_of_Stone,Seal_of_Wind,Seal_of_Autumn,Lurk,Splash b 18 0:0 -:- -:- tied competitive`
  - actions: `[{"type":"move","node":"a3"}]`
- **Wind + enemy Stone: hard blink** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `b......b.b...b......rrr..rrrr....bbbrbr/Bewitch,Hurricane,Starfall,Fury,Seal_of_Stone,Seal_of_Wind,Seal_of_Autumn,Lurk,Splash b 18 0:0 -:- -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"b8","pushed_to":"b7"}]`
- **crush written with "pushed_to": null** — expected legal; apply.js ok=True; bench_grade legal=True (mate) → OK
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a13"},{"type":"cast","spell":"Slash"},{"type":"hard_move","node":"a9","pushed_to":null},{"type":"pass"}]`
- **non-charm cast with no mana written "kept": [] (Hail_Storm)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rr..rr.bbbb..bb........b....r....rrr..r/Flourish,Starfall,Seal_of_Lightning,Seal_of_Wind,Grow,Hail_Storm,Slash,Comet,Surge r 17 0:0 -:- -:- r1`
  - actions: `[{"type":"move","node":"a3"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Hail_Storm","kept":[]},{"type":"hail_storm","destroyed":["b2"]},{"type":"hail_storm","destroyed":["a8"]},{"type":"pass"}]`
- **Rock Slide engine list** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r......rrr...b..b.rbbbbb.brr....r..r.../Hurricane,Endowment,Tsunami,Rock_Slide,Fury,Scatter,Surge,Bulwark,Seal_of_Spring r 21 2:1 Scatter:Fury Scatter:- tied`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Rock_Slide","kept":["a10"]},{"type":"rock_slide","destroyed":["b1"],"pushes":[{"from":"b11","to":"b1"}]},{"type":"pass"}]`
- **two Providence placements in one turn** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `......x......rrrrrrr..rr..b..b..bbbb.../Carnage,Fissure,Endowment,Meteor,Eclipse,Gather,Seal_of_Autumn,Gust,Seal_of_Winter b 32 3:1 Eclipse:Endowment -:- tied competitive pm:0:2`
  - actions: `[{"type":"move","node":"a11"},{"type":"move","node":"a1","providence":true},{"type":"move","node":"a2","providence":true},{"type":"pass"}]`
- **one Providence placement (engine list)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `......x......rrrrrrr..rr..b..b..bbbb.../Carnage,Fissure,Endowment,Meteor,Eclipse,Gather,Seal_of_Autumn,Gust,Seal_of_Winter b 32 3:1 Eclipse:Endowment -:- tied competitive pm:0:2`
  - actions: `[{"type":"move","node":"a11"},{"type":"move","node":"a1","providence":true},{"type":"pass"}]`
- **turn that leaves the opponent holding Seal of Destruction** — expected legal; apply.js ok=True; bench_grade legal=True (mate) → OK
  - SFN: `...bb.b..r...rrrrbb....rb............../Seal_of_Destruction,Erupt,Harvest,Decay,Fury,Storm_Front,Gust,Seal_of_Winter,Lurk r 17 1:0 Decay:- -:- b1 competitive`
  - actions: `[{"type":"move","node":"a8"},{"type":"dash","sacrificed":["a10","b1"]},{"type":"hard_move","node":"a7","pushed_to":"a3"},{"type":"cast","spell":"Gust"},{"type":"gust","destroyed":["b5","b6"],"kept":["a2","a6"]},{"type":"pass"}]`
- **casting your own lock without Seal of Spring** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrr..rrrr..rbrb..b....bb.b..b......b../Starfall,Carnage,Bewitch,Hail_Storm,Grow,Fireblast,Slash,Sprout,Seal_of_Summer r 33 2:2 Hail_Storm:Bewitch -:- r1 competitive`
  - actions: `[{"type":"move","node":"a5"},{"type":"cast","spell":"Hail_Storm","kept":["a10"]},{"type":"hail_storm","destroyed":["b3"]},{"type":"hail_storm","destroyed":["c4"]},{"type":"pass"}]`
- **third cast of a springlocked spell** — expected illegal; apply.js ok=True; bench_grade legal=False (illegal) → OK
  - SFN: `rrrrrr.bbrrr.bbbbbbb...bb...bb..r.rr.br/Hurricane,Seal_of_Lightning,Blossom,Torrent,Fury,Grow,Sprout,Surge,Seal_of_Spring r 55 3:1 Hurricane:Torrent Hurricane:- b2 competitive`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Hurricane"},{"type":"hurricane","destroyed":["a8","a9"]},{"type":"pass"}]`

## Resolver choices the browser allows and the grader accepts

- **Gust placing stones back on their own nodes** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r.....rrrrr..r.....bbbb.rbr.bbbb....br./Flourish,Bewitch,Harvest,Seal_of_Wind,Hail_Storm,Seal_of_Stone,Seal_of_Spring,Gust,Sprout b 28 0:2 -:Harvest -:- b1 competitive`
  - actions: `[{"type":"move","node":"b3"},{"type":"dash","sacrificed":["b3","b7"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Gust"},{"type":"gust","destroyed":["c1","c12"],"kept":["c1","c12"]},{"type":"pass"}]`
- **Gust placing stones on last empty nodes** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r.....rrrrr..r.....bbbb.rbr.bbbb....br./Flourish,Bewitch,Harvest,Seal_of_Wind,Hail_Storm,Seal_of_Stone,Seal_of_Spring,Gust,Sprout b 28 0:2 -:Harvest -:- b1 competitive`
  - actions: `[{"type":"move","node":"b3"},{"type":"dash","sacrificed":["b3","b7"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Gust"},{"type":"gust","destroyed":["c1","c12"],"kept":["c10","c13"]},{"type":"pass"}]`
- **Fissure on an isolated empty node (no stones destroyed)** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrrrr.rrbbb.r....r....r...bbb.b..bb.../Fissure,Erupt,Bewitch,Storm_Front,Fireblast,Eclipse,Dividend,Gust,Comet r 37 1:1 Storm_Front:Eclipse -:- r1 competitive`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Fissure","kept":["a4"]},{"type":"fissure","node":"a2","destroyed":[],"wall":"a2"},{"type":"pass"}]`
- **Fissure on own stone** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `rrrrrr.rrbbb.r....r....r...bbb.b..bb.../Fissure,Erupt,Bewitch,Storm_Front,Fireblast,Eclipse,Dividend,Gust,Comet r 37 1:1 Storm_Front:Eclipse -:- r1 competitive`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Fissure","kept":["a4"]},{"type":"fissure","node":"a4","destroyed":["a7","a4"],"wall":"a4"},{"type":"pass"}]`
- **Hail_Storm keeping a different subset** — expected legal; apply.js ok=True; bench_grade legal=True (not_mate) → OK
  - SFN: `r..r..rrrbb..b..rr.....br........bbb.../Flourish,Seal_of_Lightning,Bewitch,Meteor,Seal_of_Wind,Hail_Storm,Seal_of_Summer,Slash,Surge b 16 1:1 Flourish:Meteor -:- tied`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a2"},{"type":"dash","sacrificed":["a1","a10"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Hail_Storm","kept":["c9","c8"]},{"type":"hail_storm","destroyed":["a2"]},{"type":"hail_storm","destroyed":["b4"]},{"type":"hail_storm","destroyed":["a8"]},{"type":"pass"}]`

## Discrepancy cases (JS-legal, graded illegal)

- **RS non-max-net assignment** — expected legal; apply.js ok=True; bench_grade legal=False (illegal) → MISMATCH
  - SFN: `r......rrr...b..b.rbbbbb.brr....r..r.../Hurricane,Endowment,Tsunami,Rock_Slide,Fury,Scatter,Surge,Bulwark,Seal_of_Spring r 21 2:1 Scatter:Fury Scatter:- tied`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Rock_Slide","kept":["a10"]},{"type":"rock_slide","pushes":[{"from":"b11","to":"a10"}],"destroyed":["a10"]},{"type":"pass"}]`
- **Corrupt converting 1 of 2 eligible** — expected legal; apply.js ok=True; bench_grade legal=False (illegal) → MISMATCH
  - SFN: `b......bbb..brrrrrrr...r.br......b.b.../Tsunami,Corrupt,Starfall,Seal_of_Wind,Grow,Torrent,Seal_of_Autumn,Seal_of_Winter,Azimuth r 25 1:1 Grow:Torrent -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a10","pushed_to":"a7"},{"type":"dash","sacrificed":["b1","b11"]},{"type":"hard_move","node":"a8","pushed_to":"a4"},{"type":"cast","spell":"Corrupt","kept":["b4"]},{"type":"corrupt","converted":["a7"]},{"type":"sacrifice","node":"a8"},{"type":"pass"}]`
- **Corrupt converting 0 (sacrifice only)** — expected legal; apply.js ok=True; bench_grade legal=False (illegal) → MISMATCH
  - SFN: `b......bbb..brrrrrrr...r.br......b.b.../Tsunami,Corrupt,Starfall,Seal_of_Wind,Grow,Torrent,Seal_of_Autumn,Seal_of_Winter,Azimuth r 25 1:1 Grow:Torrent -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a10","pushed_to":"a7"},{"type":"dash","sacrificed":["b1","b11"]},{"type":"hard_move","node":"a8","pushed_to":"a4"},{"type":"cast","spell":"Corrupt","kept":["b4"]},{"type":"sacrifice","node":"a8"},{"type":"pass"}]`
- **Comet sacrificing the stone it just blinked (JS-legal)** — expected legal; apply.js ok=True; bench_grade legal=False (illegal) → MISMATCH
  - SFN: `rrrrrrrbbbrrrbbbbbbb...bb.......rr...../Flourish,Seal_of_Lightning,Carnage,Fireblast,Meteor,Hail_Storm,Surge,Comet,Slash b 26 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a7","pushed_to":"c10"},{"type":"dash_lightning","sacrificed":["a7"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Comet"},{"type":"hard_move","node":"a1","pushed_to":"c9"},{"type":"sacrifice","node":"a1"},{"type":"pass"}]`

## Worked examples in actions.md

- **worked example 1** — apply.js ok=True, winner=blue; bench_grade legal=True verdict=mate immediate=True
- **worked example 2** — apply.js ok=True, winner=blue; bench_grade legal=True verdict=mate immediate=True
- **worked example 3** — apply.js ok=True, winner=blue; bench_grade legal=True verdict=mate immediate=True
- **worked example 4** — apply.js ok=True, winner=blue; bench_grade legal=True verdict=mate immediate=True

## Per spell (the list each spells.json example was cut from)

- **Flourish** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r..r..rbbbr.rbbbbbbr...brr.......rrr.../Carnage,Flourish,Bewitch,Hail_Storm,Meteor,Seal_of_Wind,Seal_of_Summer,Slash,Surge b 20 0:0 -:- -:- tied`
  - actions: `[{"type":"hard_move","node":"a7","pushed_to":"a3"},{"type":"dash","sacrificed":["a7","a8"]},{"type":"move","node":"a8"},{"type":"cast","spell":"Flourish","kept":["b4"]},{"type":"move","node":"a7"},{"type":"move","node":"b2"},{"type":"move","node":"b3"},{"type":"move","node":"b5"},{"type":"pass"}]`
- **Carnage** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rbrrrrbbrbrrrbb..b.....bb..........r.../Carnage,Flourish,Starfall,Hail_Storm,Meteor,Fireblast,Slash,Comet,Surge r 19 0:0 -:- -:- tied`
  - actions: `[{"type":"hard_move","node":"a2"},{"type":"cast","spell":"Carnage","kept":["a4"]},{"type":"hard_move","node":"a7","pushed_to":"b4"},{"type":"hard_move","node":"a10","pushed_to":"b6"},{"type":"hard_move","node":"a8"},{"type":"hard_move","node":"b11","pushed_to":"b3"},{"type":"pass"}]`
- **Bewitch** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.....bbbb....rrrrr..................../Starfall,Bewitch,Flourish,Hail_Storm,Grow,Fireblast,Seal_of_Summer,Sprout,Slash r 21 1:1 Starfall:Hail_Storm -:- r1`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"b1"},{"type":"cast","spell":"Bewitch","kept":["b4"]},{"type":"bewitch","node":"a7","node2":"a8"},{"type":"pass"}]`
- **Starfall** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `bbrrbbrrrrb.rbb.br.....rr........b.b.../Starfall,Bewitch,Flourish,Grow,Seal_of_Wind,Hail_Storm,Seal_of_Summer,Slash,Sprout b 30 0:2 -:Hail_Storm -:- b1`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"b6"},{"type":"dash","sacrificed":["a11","c8"]},{"type":"hard_move","node":"a4"},{"type":"cast","spell":"Starfall","kept":["a2","a5"]},{"type":"starfall","node":"a3","node2":"a4","destroyed":["a7","a13"]},{"type":"pass"}]`
- **Seal_of_Lightning** — bench_grade legal=True
  - SFN: `rrr.rrb.rr..rbbbbbb....rbb............./Flourish,Seal_of_Lightning,Bewitch,Hail_Storm,Fireblast,Seal_of_Wind,Seal_of_Summer,Surge,Comet b 18 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash_lightning","sacrificed":["a4"]},{"type":"move","node":"a8"},{"type":"pass"}]`
- **Grow** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.rr..rrrrr.rbbbbbb.bbbrb............../Flourish,Seal_of_Lightning,Bewitch,Grow,Fireblast,Hail_Storm,Sprout,Seal_of_Summer,Surge r 19 5:0 Flourish:- -:- b1`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Grow","kept":["a10"]},{"type":"move","node":"a2"},{"type":"move","node":"a5"},{"type":"pass"}]`
- **Fireblast** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r....rbbbb...bbbrrb.r..brb......rrrr.../Starfall,Seal_of_Lightning,Flourish,Fireblast,Seal_of_Wind,Grow,Sprout,Slash,Comet b 26 2:0 Starfall:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash","sacrificed":["a4","a7"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Fireblast","kept":["a10"]},{"type":"fireblast","destroyed":["b4","b5","b12"]},{"type":"sacrifice","node":"a7"},{"type":"pass"}]`
- **Hail_Storm** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r..r..rrrbb..b..rr.....br........bbb.../Flourish,Seal_of_Lightning,Bewitch,Meteor,Seal_of_Wind,Hail_Storm,Seal_of_Summer,Slash,Surge b 16 1:1 Flourish:Meteor -:- tied`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a2"},{"type":"dash","sacrificed":["a1","a10"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Hail_Storm","kept":["c9","c10"]},{"type":"hail_storm","destroyed":["a2"]},{"type":"hail_storm","destroyed":["b4"]},{"type":"hail_storm","destroyed":["a8"]},{"type":"pass"}]`
- **Meteor** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rbb.bb..bbrbbbb........b..rrr.rrbrrrr.r/Bewitch,Starfall,Carnage,Fireblast,Seal_of_Wind,Meteor,Slash,Sprout,Surge r 23 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"a4"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Meteor","kept":["c9","c10"]},{"type":"move","node":"a2"},{"type":"meteor_destroy","node":"a3"},{"type":"pass"}]`
- **Seal_of_Wind** — bench_grade legal=True
  - SFN: `r......r..r..bbbbb..rr.b..r......rrr.b./Starfall,Seal_of_Lightning,Carnage,Grow,Hail_Storm,Seal_of_Wind,Sprout,Slash,Surge r 17 0:0 -:- -:- r1`
  - actions: `[{"type":"blink","node":"a3"},{"type":"pass"}]`
- **Sprout** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.rr..rrrrr.rbbbbbb.bbbrb............../Flourish,Seal_of_Lightning,Bewitch,Grow,Fireblast,Hail_Storm,Sprout,Seal_of_Summer,Surge r 19 5:0 Flourish:- -:- b1`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Sprout"},{"type":"move","node":"a2"},{"type":"pass"}]`
- **Slash** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrbrrbbrb.r.b...b.....bb.r............/Bewitch,Seal_of_Lightning,Flourish,Seal_of_Wind,Grow,Fireblast,Slash,Surge,Comet b 16 0:0 -:- -:- b1`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a13"},{"type":"dash","sacrificed":["a3","a4"]},{"type":"move","node":"a4"},{"type":"cast","spell":"Slash"},{"type":"hard_move","node":"a5","pushed_to":"a11"},{"type":"pass"}]`
- **Surge** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rbbbrb....rr.b..b..b......rrr........../Carnage,Bewitch,Flourish,Fireblast,Hail_Storm,Grow,Seal_of_Summer,Surge,Comet b 18 0:1 -:Bewitch -:- b1`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"c10"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Surge"},{"type":"move","node":"a1"},{"type":"pass"}]`
- **Comet** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrrr.rbbb...b............rb...b....b../Carnage,Seal_of_Lightning,Starfall,Hail_Storm,Meteor,Seal_of_Wind,Comet,Seal_of_Summer,Slash r 15 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a6"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Carnage","kept":["a4"]},{"type":"hard_move","node":"c11","pushed_to":"b10"},{"type":"hard_move","node":"b10","pushed_to":"b8"},{"type":"hard_move","node":"b8","pushed_to":"b7"},{"type":"hard_move","node":"b7","pushed_to":"b4"},{"type":"cast","spell":"Comet"},{"type":"move","node":"a1"},{"type":"sacrifice","node":"a4"},{"type":"pass"}]`
- **Seal_of_Summer** — bench_grade legal=True
  - SFN: `rrr.rrb.rr..rbbbbbb....rbb............./Flourish,Seal_of_Lightning,Bewitch,Hail_Storm,Fireblast,Seal_of_Wind,Seal_of_Summer,Surge,Comet b 18 0:0 -:- -:- b1`
  - actions: `[{"type":"move","node":"a4"},{"type":"dash_lightning","sacrificed":["a4"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Surge"},{"type":"move","node":"b7"},{"type":"cast","spell":"Surge"},{"type":"move","node":"b9"},{"type":"pass"}]`
- **Blossom** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `brrrrbbrrb...b.bbb..brrbbbr..rbrrrrrrb./Blossom,Bewitch,Syzygy,Seal_of_Wind,Decay,Seal_of_Stone,Splash,Lurk,Seal_of_Summer r 57 2:1 Decay:Bewitch -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"a11"},{"type":"dash","sacrificed":["a8","b9"]},{"type":"hard_move","node":"a6"},{"type":"cast","spell":"Blossom","kept":["a4","a5"]},{"type":"blink","node":"b2"},{"type":"blink","node":"c2"},{"type":"blink","node":"a8"},{"type":"blink","node":"b9"},{"type":"pass"}]`
- **Scatter** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `b......b.bb.....rr.rrrr....bb.rr.bbb.r./Harvest,Blossom,Erupt,Gather,Fury,Scatter,Charge,Seal_of_Spring,Seal_of_Autumn b 18 0:2 -:Gather -:- b1 competitive`
  - actions: `[{"type":"move","node":"a2"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Scatter","kept":["c10"]},{"type":"blink","node":"a2"},{"type":"blink","node":"b2"},{"type":"pass"}]`
- **Seal_of_Spring** — bench_grade legal=True
  - SFN: `b..b..b..b...rrrrrb.r.rrbrb......b...../Starfall,Seal_of_Lightning,Blossom,Meteor,Seal_of_Wind,Fury,Seal_of_Spring,Slash,Comet b 22 0:3 -:Fury -:- tied competitive`
  - actions: `[{"type":"move","node":"c9"},{"type":"dash","sacrificed":["a1","a4"]},{"type":"move","node":"c10"},{"type":"cast","spell":"Fury","kept":["c10"]},{"type":"sacrifice","node":"a7"},{"type":"hard_move","node":"b2","pushed_to":"b7"},{"type":"hard_move","node":"b1"},{"type":"hard_move","node":"b3","pushed_to":"b9"},{"type":"pass"}]`
- **Syzygy** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rbbbbr....rrbbrrrrb...b..rbbbb...rrr..r/Syzygy,Bewitch,Seal_of_Lightning,Fireblast,Seal_of_Wind,Scatter,Azimuth,Seal_of_Summer,Sprout b 28 1:0 Scatter:- -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a1","pushed_to":"c7"},{"type":"dash","sacrificed":["a13","b10"]},{"type":"hard_move","node":"a6"},{"type":"cast","spell":"Syzygy","kept":["a4","a5","a6"]},{"type":"move","node":"b7"},{"type":"move","node":"b8"},{"type":"move","node":"b9"},{"type":"move","node":"b10"},{"type":"pass"}]`
- **Eclipse** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.........r..bbbb.b.bbb..r..rrr......rr/Harvest,Syzygy,Flourish,Meteor,Eclipse,Gather,Lurk,Splash,Comet b 30 2:4 Gather:Gather -:- b1 competitive`
  - actions: `[{"type":"move","node":"b5"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"move","node":"b2"},{"type":"cast","spell":"Eclipse"},{"type":"pass"}]`
- **Azimuth** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrbb.bbrr..rb..b......bb.r......r...../Starfall,Tsunami,Blossom,Seal_of_Wind,Meteor,Torrent,Azimuth,Charge,Seal_of_Summer b 18 0:1 -:Tsunami -:- b1 competitive`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a6"},{"type":"dash","sacrificed":["a3","a4"]},{"type":"move","node":"a4"},{"type":"cast","spell":"Azimuth"},{"type":"move","node":"b7"},{"type":"pass"}]`
- **Erupt** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `bb.bbb.b..b..brr..r..rrr..rr..rr.b...../Erupt,Harvest,Blossom,Fury,Gather,Scatter,Charge,Seal_of_Spring,Seal_of_Autumn b 22 0:1 -:Scatter -:- tied competitive`
  - actions: `[{"type":"move","node":"a3"},{"type":"dash","sacrificed":["a1","a11"]},{"type":"hard_move","node":"b2","pushed_to":"b5"},{"type":"cast","spell":"Erupt","kept":["a4"]},{"type":"hard_move","node":"b3","pushed_to":"b4"},{"type":"hard_move","node":"b6","pushed_to":"a10"},{"type":"move","node":"a9"},{"type":"hard_move","node":"a10"},{"type":"move","node":"c9"},{"type":"move","node":"c10"},{"type":"pass"}]`
- **Fury** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `....x.........rr.....r...rrrbbb..bbbr.b/Tsunami,Corrupt,Fissure,Seal_of_Stone,Grow,Fury,Slash,Splash,Charge b 24 2:0 Grow:- -:- b1 competitive`
  - actions: `[{"type":"move","node":"a11"},{"type":"dash","sacrificed":["a11","c3"]},{"type":"move","node":"a11"},{"type":"cast","spell":"Fury"},{"type":"sacrifice","node":"a11"},{"type":"pass"}]`
- **Charge** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrrrrrr.....bb.bbbbb...............b../Seal_of_Lightning,Harvest,Carnage,Gather,Storm_Front,Fury,Seal_of_Winter,Charge,Gust b 24 0:3 -:Storm_Front -:- b1 competitive`
  - actions: `[{"type":"move","node":"b12"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"hard_move","node":"a7","pushed_to":"a9"},{"type":"cast","spell":"Charge"},{"type":"hard_move","node":"a4","pushed_to":"a13"},{"type":"pass"}]`
- **Hurricane** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrrrrr......bbbbbbbb....r............./Bewitch,Hurricane,Blossom,Fury,Hail_Storm,Grow,Comet,Slash,Azimuth b 22 1:0 Bewitch:- -:- b1 competitive`
  - actions: `[{"type":"move","node":"b9"},{"type":"dash","sacrificed":["b1","b2"]},{"type":"move","node":"b2"},{"type":"cast","spell":"Hurricane"},{"type":"hurricane","destroyed":["b13"]},{"type":"pass"}]`
- **Storm_Front** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrbrrbbbbr..b..bb......b....r..r..r.../Seal_of_Lightning,Erupt,Syzygy,Storm_Front,Meteor,Seal_of_Stone,Splash,Seal_of_Spring,Gust b 36 0:2 -:Erupt -:- b1 competitive`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a13"},{"type":"dash","sacrificed":["a3","a4"]},{"type":"move","node":"a4"},{"type":"cast","spell":"Storm_Front","kept":["a10"]},{"type":"storm_front","destroyed":["a1","a2"]},{"type":"pass"}]`
- **Gust** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.....rrrrr..r.....bbbb.rbr.bbbb....br./Flourish,Bewitch,Harvest,Seal_of_Wind,Hail_Storm,Seal_of_Stone,Seal_of_Spring,Gust,Sprout b 28 0:2 -:Harvest -:- b1 competitive`
  - actions: `[{"type":"move","node":"b3"},{"type":"dash","sacrificed":["b3","b7"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Gust"},{"type":"gust","destroyed":["c1","c12"],"kept":["a2","a3"]},{"type":"pass"}]`
- **Tsunami** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `.rrrrrrr.rb..bbrbbbb.....b.......b...../Tsunami,Harvest,Starfall,Gather,Seal_of_Stone,Meteor,Sprout,Seal_of_Autumn,Seal_of_Summer r 29 4:3 Gather:Meteor -:- b1 competitive`
  - actions: `[{"type":"move","node":"a1"},{"type":"cast","spell":"Tsunami","kept":["a4"]},{"type":"move","node":"a2"},{"type":"move","node":"a3"},{"type":"hard_move","node":"a11","pushed_to":"a6"},{"type":"hard_move","node":"a6","pushed_to":"a5"},{"type":"pass"}]`
- **Torrent** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.rrr..rrr.r.rrbbbrbbbbrrbbb.bb.rb...b./Carnage,Seal_of_Lightning,Tsunami,Seal_of_Stone,Torrent,Decay,Surge,Azimuth,Seal_of_Winter b 34 1:4 Carnage:Tsunami -:- b1 competitive`
  - actions: `[{"type":"move","node":"c3"},{"type":"dash","sacrificed":["b3","b4"]},{"type":"move","node":"b3"},{"type":"cast","spell":"Torrent","kept":["b10"]},{"type":"move","node":"b4"},{"type":"hard_move","node":"b2","pushed_to":"a7"},{"type":"pass"}]`
- **Splash** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.......rr....bbb.b......br.....r.rr.../Corrupt,Harvest,Starfall,Meteor,Scatter,Storm_Front,Surge,Seal_of_Summer,Splash r 29 4:1 Meteor:Scatter -:- r1 competitive`
  - actions: `[{"type":"move","node":"a2"},{"type":"cast","spell":"Splash"},{"type":"move","node":"a3"},{"type":"pass"}]`
- **Harvest** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r..r......r...rrrr....b...bbbbbb.r..b../Bewitch,Corrupt,Harvest,Seal_of_Stone,Eclipse,Scatter,Comet,Seal_of_Summer,Charge b 18 1:1 Scatter:Eclipse -:- b1 competitive`
  - actions: `[{"type":"move","node":"b8"},{"type":"dash","sacrificed":["b8","b10"]},{"type":"move","node":"b10"},{"type":"cast","spell":"Harvest","kept":["c4"]},{"type":"move","node":"b8"},{"type":"move","node":"b9"},{"type":"move","node":"c2"},{"type":"move","node":"c3"},{"type":"move","node":"c5"},{"type":"pass"}]`
- **Gather** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrbrrrbbbbrb.b.........b..r..rr....r.../Flourish,Corrupt,Carnage,Gather,Hail_Storm,Eclipse,Seal_of_Winter,Comet,Charge b 20 1:1 Carnage:Flourish -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"c8"},{"type":"dash","sacrificed":["a2","a3"]},{"type":"hard_move","node":"a4","pushed_to":"a3"},{"type":"cast","spell":"Gather","kept":["a10"]},{"type":"hard_move","node":"a3","pushed_to":"a2"},{"type":"hard_move","node":"a2","pushed_to":"c9"},{"type":"hard_move","node":"a5","pushed_to":"c7"},{"type":"pass"}]`
- **Seal_of_Autumn** — bench_grade legal=True
  - SFN: `bbrrbbrrrb.brr....r.....r.......b....../Tsunami,Carnage,Erupt,Hail_Storm,Decay,Grow,Azimuth,Charge,Seal_of_Autumn r 27 3:0 Carnage:- -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"a2","pushed_to":"a11"},{"type":"dash","sacrificed":["a13","b1"]},{"type":"hard_move","node":"a1","pushed_to":"c10"},{"type":"pass"}]`
- **Corrupt** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `b......bbb..brrrrrrr...r.br......b.b.../Tsunami,Corrupt,Starfall,Seal_of_Wind,Grow,Torrent,Seal_of_Autumn,Seal_of_Winter,Azimuth r 25 1:1 Grow:Torrent -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a10","pushed_to":"a7"},{"type":"dash","sacrificed":["b1","b11"]},{"type":"hard_move","node":"a8","pushed_to":"a4"},{"type":"cast","spell":"Corrupt","kept":["b4"]},{"type":"corrupt","converted":["a7","a9"]},{"type":"sacrifice","node":"a7"},{"type":"pass"}]`
- **Decay** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrbbbbbrrrr.r..........r..b...b.bb...../Flourish,Tsunami,Corrupt,Decay,Gather,Torrent,Seal_of_Autumn,Surge,Gust r 23 1:1 Flourish:Corrupt -:- b2 competitive`
  - actions: `[{"type":"hard_move","node":"a3","pushed_to":"a12"},{"type":"dash","sacrificed":["a1","a11"]},{"type":"move","node":"a1"},{"type":"cast","spell":"Decay","kept":["a10"]},{"type":"decay","destroyed":["a7","c1","c5","c8"]},{"type":"pass"}]`
- **Lurk** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `bbbrbbrrrb.bb.rrrrr.............b....r./Hurricane,Seal_of_Lightning,Tsunami,Seal_of_Stone,Fury,Hail_Storm,Sprout,Slash,Lurk b 20 0:0 -:- -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a4","pushed_to":"b12"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Lurk"},{"type":"move","node":"a1"},{"type":"pass"}]`
- **Seal_of_Destruction** — bench_grade legal=True
  - SFN: `rrrrrr.rr.r................bbbb.bbbr.bb/Harvest,Hurricane,Seal_of_Destruction,Gather,Seal_of_Stone,Storm_Front,Gust,Charge,Lurk b 30 1:1 Harvest:Storm_Front -:- tied competitive`
  - actions: `[{"type":"move","node":"a12"},{"type":"dash","sacrificed":["a12","c7"]},{"type":"move","node":"b7"},{"type":"cast","spell":"Charge"},{"type":"move","node":"c6"},{"type":"pass"}]`
- **Seal_of_Stone** — bench_grade legal=True
  - SFN: `...............r...bbbb...rbbrrr....rrr/Tsunami,Bewitch,Seal_of_Lightning,Eclipse,Seal_of_Stone,Grow,Lurk,Splash,Slash r 21 0:0 -:- -:- r1 competitive`
  - actions: `[{"type":"move","node":"b2"},{"type":"pass"}]`
- **Seal_of_Winter** — deliberately ILLEGAL example (opponent holds Seal of Winter); bench_grade legal=False as expected
  - SFN: `rrrrrrrr.....bb.bbbbb...............b../Seal_of_Lightning,Harvest,Carnage,Gather,Storm_Front,Fury,Seal_of_Winter,Charge,Gust b 24 0:3 -:Storm_Front -:- b1 competitive`
  - actions: `[{"type":"move","node":"b3"},{"type":"cast","spell":"Charge"},{"type":"move","node":"c6"},{"type":"pass"}]`
- **Fissure** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `rrrrrr.rrbbb.r....r....r...bbb.b..bb.../Fissure,Erupt,Bewitch,Storm_Front,Fireblast,Eclipse,Dividend,Gust,Comet r 37 1:1 Storm_Front:Eclipse -:- r1 competitive`
  - actions: `[{"type":"move","node":"a7"},{"type":"dash","sacrificed":["a1","a2"]},{"type":"move","node":"a2"},{"type":"cast","spell":"Fissure","kept":["a4"]},{"type":"fissure","node":"a1","destroyed":["a11"],"wall":"a1"},{"type":"pass"}]`
- **Rock_Slide** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `b...bbrbbb.r.rrrrrr....br....r...b.b.../Starfall,Flourish,Erupt,Eclipse,Annuity,Rock_Slide,Surge,Slash,Splash b 28 0:3 -:Starfall -:- tied competitive`
  - actions: `[{"type":"hard_move","node":"a7","pushed_to":"a4"},{"type":"dash","sacrificed":["a6","a8"]},{"type":"move","node":"c9"},{"type":"cast","spell":"Rock_Slide","kept":["c10"]},{"type":"rock_slide","destroyed":["a5","b2","b5"],"pushes":[{"from":"a4","to":"a5"},{"from":"a12","to":"a5"},{"from":"b1","to":"b2"},{"from":"b6","to":"b2"},{"from":"b12","to":"b5"}]},{"type":"pass"}]`
- **Bulwark** — deliberately ILLEGAL example (hard move onto a shielded stone); bench_grade legal=False as expected
  - SFN: `b.bb..b..x...r..r..rrrr..rb..rrbrbb.br./Fissure,Flourish,Hurricane,Meteor,Eclipse,Scatter,Bulwark,Charge,Sprout r 31 3:3 Flourish:Scatter -:- r1 competitive`
  - actions: `[{"type":"hard_move","node":"c8","pushed_to":"c10"},{"type":"pass"}]`
- **Dividend** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `r.rr.rbbbb.............r.............../Flourish,Fissure,Endowment,Fury,Storm_Front,Fireblast,Dividend,Sprout,Seal_of_Winter b 14 0:0 -:- -:- b1 competitive pm:0:1`
  - actions: `[{"type":"hard_move","node":"a4","pushed_to":"a5"},{"type":"dash","sacrificed":["a4","a7"]},{"type":"move","node":"a7"},{"type":"cast","spell":"Dividend"},{"type":"bank_stones","spell":"Dividend","banked":1},{"type":"pass"}]`
- **Annuity** — bench_grade legal=True; all 5 enumerated/stored lists for this spell replay legal (5/5)
  - SFN: `................bbb.bbb..brrrrrr.rrrb.r/Erupt,Endowment,Seal_of_Lightning,Torrent,Seal_of_Stone,Annuity,Slash,Azimuth,Charge r 23 0:0 -:- -:- r1 competitive`
  - actions: `[{"type":"move","node":"a11"},{"type":"dash_lightning","sacrificed":["a11"]},{"type":"move","node":"a11"},{"type":"cast","spell":"Annuity","kept":["c10"]},{"type":"bank_stones","spell":"Annuity","banked":2},{"type":"pass"}]`
- **Endowment** — bench_grade legal=True; all 3 enumerated/stored lists for this spell replay legal (3/3)
  - SFN: `r............bbbbb.bb.b...rrrrrr....r../Starfall,Seal_of_Lightning,Endowment,Seal_of_Stone,Hail_Storm,Seal_of_Wind,Surge,Seal_of_Spring,Splash r 19 1:0 Endowment:- -:- r1 competitive pm:2:0`
  - actions: `[{"type":"move","node":"a2"},{"type":"move","node":"c12","providence":true},{"type":"dash","sacrificed":["a1","a2"]},{"type":"hard_move","node":"b7","pushed_to":"b9"},{"type":"cast","spell":"Endowment","kept":["c4"]},{"type":"bank_stones","spell":"Endowment","banked":4},{"type":"pass"}]`
