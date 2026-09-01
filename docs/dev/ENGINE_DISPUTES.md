# Engine rules disputes awaiting a ruling

Generated 2026-09-01 by `tools/export_engine_disputes.py`. Open
`docs/dev/engine-disputes.html` to answer these; no Rust build is needed, the page
carries its cases inline and drives the real game UI.

## Fury: NO BUG. The test is wrong, not the engine.

`tests.rs::greedy_resolution_is_always_among_the_enumerated_outcomes` asserts that
whatever `resolve_spell_at` plays appears in `resolve_outcomes`. Under the fixed
`legal_draw` it failed twice, and that was reported as a shipped-engine bug that
plausibly cost Elo. **It does not.** Triage over all 1,062 checks:

| outcome | n |
|---|---|
| vacuous: spell not castable in this position | 973 |
| ok | 81 |
| vacuous: enumeration truncated at `OUTCOME_CAP` (4096) | 8 |
| **genuine** | **0** |

The test calls `cast_clear_and_refill` unconditionally, so it asserts the invariant
in positions where the cast is illegal and no resolution can occur. **Fix: guard the
assertion on `castable(...)` containing the slot's spell, and skip when
`EnumStats::resolver_truncated`.** No rules question, no engine change.

## key_dash: ONE position, TWO questions, 15 instances

`tests.rs::the_key_dash_filter_never_invents_an_illegal_turn` asserts every dash the
interest filter promotes is also produced by full enumeration. 15 promoted turns are
not — all from a single board, all `move a7` then a 2-sacrifice dash sacrificing a11.

`key_dash_reasons` ships at **0**, so nothing in production is affected. This blocks
ever enabling the filter.

```
before: red  a1 a3 a5 a6 a8 a9 a11 a13
        blue b2 b4 b7 b10 b12
        spells Corrupt, Hurricane, Seal of Destruction, Fury, Seal of Wind,
               Seal of Stone, Azimuth, Splash, Gust   red to move
```

**Q1 — may a dash land on a node vacated by one of its own sacrifices?** (4 cases)

```
dash a11  sac (a11, a3)      dash a3  sac (a11, a3)
dash a11  sac (a11, a5)      dash a5  sac (a11, a5)
```

Not obviously illegal: the sacrifice empties the node before the dash arrives. If
this is legal, full enumeration is missing a whole family of turns.

**Q2 — is a 2-sacrifice dash after a move legal here at all**, to an already-empty
node? (11 cases)

```
dash a10 sac (a11,a3) | (a11,a5) | (a11,a6)
dash a2  sac (a11,a3) | (a11,a5)
dash a4  sac (a11,a3) | (a11,a5)
dash a12 sac (a11,a3)
dash b12 push->b5  sac (a11,a3) | (a11,a5) | (a11,a6)
```

### How to answer

```
git checkout engine-rules-disputes
open docs/dev/engine-disputes.html
```

Per case: enter the listed actions in the UI, **or** press *Flag: NO legal turn
reaches this*. Then *Download solutions* and hand back the JSON.

| your answer | meaning | fix |
|---|---|---|
| the sequence is legal | full enumeration is missing these turns — the SEARCH is blind to them | extend enumeration |
| the UI refuses an action | `key_dash` promotes an illegal turn | fix the filter |

Note `apply_turn_tuples` applies actions **without** validating legality, so the fact
that it produced the after-board is not evidence the turn is legal.

## Regenerating

```
python -m tools.export_engine_disputes --out ai/data/engine_disputes.json
python -m tools.gen_unmatched_review --cases ai/data/engine_disputes.json \
    --out docs/dev/engine-disputes.html
# optional, slow: how often does each invariant fail in REAL positions?
python -m tools.export_engine_disputes --inplay-games 200
```

The in-play sweep matters because `tests.rs` uses random stone masks; a disagreement
in a position no game can reach costs nothing. Run it before spending effort on a
fix, so the frequency and not the synthetic count sizes the bug.
