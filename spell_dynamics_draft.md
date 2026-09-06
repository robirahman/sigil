# Spell dynamics — article data (DRAFT, first-pass guesses awaiting Robi's review)

Scale: `--` `-` `=` `+` `++`. Scope (Robi 2026-09-05): the 39 official spells = core 15 + Springtime, Celestial, Inferno, Tempest, Flood, Autumn, Gloom, Covenant. Tectonic/Providence/Aftershock/Ambush/Panda deferred.

## 0. Tier list (data-driven first pass, 2026-09-05)

Source: all 2,411 completed games in Firebase (2,380 replayed for board states). Logistic regression of red-wins on (red uses − blue uses) of every spell, with controls for each side's player class (human / AI tier) and pre-game Elo difference. A coefficient c is the log-odds swing of ONE cast; 'Win% if even' = win probability from a 50/50 position after one cast = 1/(1+e^-c). Statics (seals) are not cast, so their row measures 'held the seal for at least one turn'.
CAVEATS: only 21 human-vs-human games; the rest involve an AI on one or both sides, so AI casting habits shape the data (e.g. Gust cast 5 times in 96 games). A spell is cast when its caster already has stones to spare, so coefficients partly reflect being ahead. Expansion spells have small samples (flagged with *).

| Tier | Spell | Games avail | Sides using | Uses/user | c | ±se | Win% if even | Raw WR of users | Unit |
|---|---|---|---|---|---|---|---|---|---|
| S | Hurricane* | 134 | 36 | 1.0 | +2.89 | 0.48 | 95% | 94% | per cast |
| S | Fireblast | 1202 | 464 | 1.1 | +1.71 | 0.20 | 85% | 83% | per cast |
| A | Surge | 1235 | 112 | 1.3 | +1.27 | 0.41 | 78% | 96% | per cast |
| A | Corrupt* | 43 | 13 | 1.5 | +1.22 | 0.43 | 77% | 77% | per cast |
| A | Fury | 185 | 90 | 1.4 | +1.22 | 0.35 | 77% | 76% | per cast |
| A | Hail Storm | 1250 | 516 | 1.2 | +1.16 | 0.14 | 76% | 66% | per cast |
| A | Carnage | 1233 | 448 | 1.1 | +1.02 | 0.16 | 74% | 65% | per cast |
| A | Decay* | 60 | 18 | 1.1 | +0.97 | 0.64 | 73% | 72% | per cast |
| A | Starfall | 1267 | 440 | 1.1 | +0.92 | 0.17 | 71% | 61% | per cast |
| B | Harvest* | 130 | 46 | 1.7 | +0.81 | 0.33 | 69% | 59% | per cast |
| B | Erupt* | 118 | 44 | 1.0 | +0.77 | 0.56 | 68% | 84% | per cast |
| B | Tsunami* | 113 | 43 | 1.4 | +0.76 | 0.33 | 68% | 65% | per cast |
| B | Bewitch | 1215 | 442 | 1.2 | +0.75 | 0.18 | 68% | 65% | per cast |
| B | Seal of Lightning | 1239 | 517 | 10.4 | +0.70 | 0.18 | 67% | 52% | held ≥1 turn |
| B | Grow | 1221 | 470 | 1.3 | +0.70 | 0.15 | 67% | 64% | per cast |
| B | Flourish | 1225 | 477 | 1.2 | +0.68 | 0.14 | 66% | 56% | per cast |
| B | Seal of Spring | 183 | 151 | 11.1 | +0.62 | 0.35 | 65% | 52% | held ≥1 turn |
| B | Gust* | 96 | 4 | 1.2 | +0.61 | 0.72 | 65% | 25% | per cast |
| B | Gather | 152 | 101 | 1.6 | +0.51 | 0.25 | 62% | 70% | per cast |
| B | Meteor | 1250 | 542 | 1.2 | +0.50 | 0.14 | 62% | 62% | per cast |
| B | Eclipse* | 91 | 35 | 1.4 | +0.48 | 0.34 | 62% | 63% | per cast |
| B | Torrent | 102 | 54 | 1.3 | +0.48 | 0.31 | 62% | 52% | per cast |
| B | Storm Front | 119 | 72 | 1.7 | +0.46 | 0.30 | 61% | 53% | per cast |
| B | Blossom | 213 | 92 | 1.2 | +0.46 | 0.33 | 61% | 66% | per cast |
| C | Seal of Stone* | 65 | 29 | 11.0 | +0.44 | 0.58 | 61% | 69% | held ≥1 turn |
| C | Syzygy | 114 | 55 | 1.1 | +0.35 | 0.37 | 59% | 56% | per cast |
| C | Lurk | 79 | 53 | 2.6 | +0.34 | 0.16 | 58% | 53% | per cast |
| C | Scatter | 182 | 137 | 1.6 | +0.21 | 0.21 | 55% | 77% | per cast |
| C | Azimuth | 117 | 57 | 2.1 | +0.19 | 0.19 | 55% | 56% | per cast |
| C | Seal of Summer | 1261 | 856 | 9.4 | +0.18 | 0.16 | 55% | 50% | held ≥1 turn |
| C | Seal of Wind | 1221 | 784 | 11.5 | +0.18 | 0.16 | 55% | 64% | held ≥1 turn |
| C | Charge | 129 | 107 | 3.0 | +0.16 | 0.11 | 54% | 52% | per cast |
| C | Slash | 1264 | 488 | 2.2 | +0.09 | 0.06 | 52% | 47% | per cast |
| C | Splash | 70 | 53 | 2.9 | +0.08 | 0.17 | 52% | 55% | per cast |
| C | Sprout | 1199 | 762 | 2.9 | +0.07 | 0.03 | 52% | 56% | per cast |
| D | Seal of Winter | 62 | 52 | 12.8 | -0.27 | 0.56 | 43% | 44% | held ≥1 turn |
| D | Comet | 1213 | 236 | 1.1 | -0.30 | 0.20 | 43% | 44% | per cast |
| D | Seal of Autumn | 119 | 93 | 13.2 | -0.39 | 0.52 | 40% | 48% | held ≥1 turn |
| D | Seal of Destruction* | 44 | 12 | 1.3 | -0.75 | 0.69 | 32% | 33% | held ≥1 turn |

Strength controls fitted (log-odds vs a human of equal Elo): easy -2.73, hard -0.79, medium -2.00, rust_hard -0.67, very_hard -0.65; Elo +1.35 per 400.
Reproduce: `python3 tools/spell_tier_stats.py <dir containing completed_games_live.json and hydrated.json>`


### Workflow change (2026-09-05)
Ratings are now collected through the survey page `docs/dev/spell-survey.html` (serve `docs/` on localhost, open /dev/spell-survey.html). Robi exports JSON; ingest it into these tables. Confirmed rulings below are prefilled in the page.

### Robi's rulings, round 6 (2026-09-06)
- RETRACTED: Bewitch − Grow is neutral (=), they simply don't interact. (Applied as a chat override in tools/ingest_spell_survey.py.)
- Carnage − Slash / Surge: all three destroy cornered enemy stones, so (a) there may be only so many enemy stones you can trap, and (b) they compete for the one spell cast per turn (unless you hold Seal of Summer). Reason (b) is minor and technically gives EVERY pair a sliver of negative synergy, except soft-move spells with Gather/Harvest, which refill and accelerate each other on alternating turns.
- Harvest / Gather: excellent overall because they synergise with every non-static spell: cast spell X, then Harvest/Gather refills X (unlocking it) for a net +1 stone. Alone they do nothing but refill themselves. Best with soft-move spells (Grow, Flourish, Tsunami): the pair refills each other, you cast one every turn, and net +2/+3 stones over 4-6 turns once both are filled. Harvest − Gather themselves: no synergy (they only refill each other, netting nothing).
- Fastest known win (blue, red not interfering): layout [blue mana]-[Harvest]-[Sprout]-[Grow]. Spread through Harvest for 3 turns; place in Sprout T4; place in Grow and use Sprout to place Grow's 2nd node T5; fill Grow's 3rd node and cast it to complete Harvest T6; place in Grow and cast Harvest for net +1 T7; cast Grow T8; cast Harvest again T9 and win. Fastest win that doesn't rely on the opponent sacrificing suicidally or walking into a Hurricane / Seal of Destruction one-shot.

### Robi's rulings, round 5 (2026-09-06): why the negative synergies
- Bewitch − Hail Storm / Meteor: destroying and converting enemy stones are both useful but redundant; every stone Hail Storm or Meteor destroys is one Bewitch can no longer convert, and vice versa. Same logic explains the other destroy-vs-convert pairs.
- Carnage − Hail Storm: both want a crowded board, but both destroy enemy stones, so casting one on consecutive turns thins the targets for the other.
- Meteor − Blossom: both extend map control and reach distant mana, but once you have reached a mana you do not need to reach it again (unless the opponent retakes the area), so the second reach spell is wasted.
- (Carnage − Slash/Surge, Harvest − Gather and Bewitch − Grow are explained in round 6 above.)

### Robi's rulings, round 4 (2026-09-06)
- Bewitch is better on EMPTIER boards, and its pair-in-contact requirement is never binding: every turn starts with a regular move placing a stone next to one of yours, so you almost always end your turn with a touching pair. Avoiding that means dashing/sacrificing (−1 stone per turn), which is worse than being Bewitched. With Seal of Wind you may start with a non-adjacent blink, but then the opponent can Bewitch two adjacent stones in Seal of Wind itself.
- Flourish + Seal of Wind is NEGATIVE synergy because both solve the same problem (covering distance quickly); Comet and Meteor also do that. Flourish + Comet is POSITIVE: Comet first to gain an extra mana, then Flourish converts 2+ mana into a stone advantage.
- Survey page now also asks "which spell is better?" per pair; the ranking is fitted by Bradley-Terry in tools/ingest_spell_survey.py.

### Robi's charm ranking (round 3)
Strong: Slash. Medium: Sprout, Comet, Azimuth, Splash, Lurk, Seal of Spring, Seal of Summer, Seal of Autumn. Weak: Seal of Winter, Gust. (Charge = very good, from round 2. Surge unranked.)

### Robi's tier-list rulings (2026-09-05, round 2)
- Corrupt is genuinely good (A is right): nets +1 stone whenever you border 3+ enemy stones before casting.
- Torrent is probably the WEAKEST spell in the game (1 soft + 1 hard move does little) → D. Eclipse is also not very good → C/D.
- Syzygy and Azimuth: correctly placed (C).
- Charge is very good, one of the best charms → A/B.
- Charms clustering near 50% is an ARTIFACT: both sides usually hold whichever charm sits in their territory, so cast counts reflect geography not choice; real charm variance is larger.
- Seal of Destruction: much stronger for BLUE than red. Blue wins at +2 stones, so blue can border two enemy stones, fill the seal, and win instantly; red needs +3, so red must already be +1 up for the same trick.
- Hurricane: far stronger for RED (tempo). Blue is usually forced to dash and sacrifice stones to avoid being one-shotted by an early Hurricane.
- Hurricane vs move-granting charms (Sprout, Slash, Surge, Splash, Charge, Azimuth, Lurk) = -- for Hurricane: place stones across the charm node, cast the charm, and the vacated node splits your stones into two groups so only the smaller one dies.

### Colour-split check (2026-09-05)
Refit with separate coefficients for red's and blue's uses of each spell. NO spell shows a statistically significant colour asymmetry (largest z=1.6). Hurricane: red +1.90±0.56 vs blue +2.48±0.64 (17/19 casters) — the data does not show a red advantage in the CAST effect; Robi's mechanism (blue forced to dash early) is a THREAT effect, tested separately below. Seal of Destruction: red −0.06 vs blue −0.86 on 5/7 users — no signal. Global red-side intercept −0.50 (blue favoured at equal strength/Elo): the +2/+3 win thresholds may over-compensate red's tempo.

<!-- SURVEY-BEGIN (generated by tools/ingest_spell_survey.py; do not hand-edit) -->
## Survey results (Robi, latest export 2026-09-06)

### Single-spell ratings

| Spell | Pack | Type | Quality | Better on | Source |
|---|---|---|---|---|---|
| Bewitch | core | ritual | good | empty | robi |
| Blossom | springtime | ritual | good | empty | robi |
| Carnage | core | ritual | good | crowded | robi |
| Charge | fury | charm | good | neither | robi |
| Corrupt | gloom | ritual | good | crowded | robi |
| Fireblast | core | sorcery | good | crowded | robi |
| Fury | fury | sorcery | good | crowded | robi |
| Gather | autumn | sorcery | good | neither | robi |
| Harvest | autumn | ritual | good | neither | robi |
| Scatter | springtime | sorcery | good | empty | robi |
| Seal of Lightning | core | ritual | good | neither | robi |
| Seal of Wind | core | sorcery | good | empty | robi |
| Slash | core | charm | good | crowded | robi |
| Starfall | core | ritual | good | empty | robi |
| Azimuth | celestial | charm | medium | crowded | robi |
| Comet | core | charm | medium | empty | robi |
| Erupt | fury | ritual | medium | neither | robi |
| Flourish | core | ritual | medium | empty | robi |
| Hail Storm | core | sorcery | medium | crowded | robi |
| Hurricane | tempest | ritual | medium | neither | robi |
| Lurk | gloom | charm | medium | neither | robi |
| Meteor | core | sorcery | medium | empty | robi |
| Seal of Autumn | autumn | charm | medium | neither | robi |
| Seal of Destruction | covenant | ritual | medium | neither | robi |
| Seal of Spring | springtime | charm | medium | crowded | robi |
| Seal of Stone | covenant | sorcery | medium | crowded | robi |
| Seal of Summer | core | charm | medium | crowded | robi |
| Splash | flood | charm | medium | crowded | robi |
| Sprout | core | charm | medium | empty | robi |
| Storm Front | tempest | sorcery | medium | neither | robi |
| Surge | core | charm | medium | crowded | robi |
| Syzygy | celestial | ritual | medium | crowded | robi |
| Decay | gloom | sorcery | bad | empty | robi |
| Eclipse | celestial | sorcery | bad | crowded | robi |
| Grow | core | sorcery | bad | empty | robi |
| Gust | tempest | charm | bad | empty | robi |
| Seal of Winter | covenant | charm | bad | crowded | robi |
| Torrent | flood | sorcery | bad | crowded | robi |
| Tsunami | flood | ritual | bad | crowded | robi |

**Board preference summary**

- empty: Bewitch, Blossom, Comet, Decay, Flourish, Grow, Gust, Meteor, Scatter, Seal of Wind, Sprout, Starfall
- neither: Charge, Erupt, Gather, Harvest, Hurricane, Lurk, Seal of Autumn, Seal of Destruction, Seal of Lightning, Storm Front
- crowded: Azimuth, Carnage, Corrupt, Eclipse, Fireblast, Fury, Hail Storm, Seal of Spring, Seal of Stone, Seal of Summer, Seal of Winter, Slash, Splash, Surge, Syzygy, Torrent, Tsunami

### Synergy (same player holds both)

| Pair | Rating | Source |
|---|---|---|
| Blossom + Erupt | ++ | prefill |
| Flourish + Gather | ++ | robi |
| Grow + Harvest | ++ | robi |
| Gust + Decay | ++ | prefill |
| Scatter + Erupt | ++ | prefill |
| Seal of Lightning + Surge | ++ | prefill |
| Bewitch + Comet | + | robi |
| Bewitch + Fireblast | + | robi |
| Bewitch + Tsunami | + | robi |
| Carnage + Seal of Summer | + | robi |
| Comet + Corrupt | + | robi |
| Comet + Eclipse | + | robi |
| Comet + Erupt | + | robi |
| Comet + Gather | + | robi |
| Comet + Seal of Destruction | + | robi |
| Comet + Seal of Stone | + | robi |
| Comet + Syzygy | + | robi |
| Comet + Torrent | + | robi |
| Comet + Tsunami | + | robi |
| Flourish + Azimuth | + | robi |
| Flourish + Charge | + | robi |
| Flourish + Comet | + | robi |
| Flourish + Corrupt | + | robi |
| Flourish + Eclipse | + | robi |
| Flourish + Erupt | + | robi |
| Flourish + Fireblast | + | robi |
| Flourish + Fury | + | robi |
| Flourish + Grow | + | robi |
| Flourish + Gust | + | robi |
| Flourish + Harvest | + | robi |
| Flourish + Seal of Destruction | + | robi |
| Flourish + Seal of Stone | + | robi |
| Flourish + Seal of Summer | + | robi |
| Flourish + Torrent | + | robi |
| Fury + Corrupt | + | robi |
| Grow + Corrupt | + | robi |
| Grow + Erupt | + | robi |
| Grow + Seal of Spring | + | robi |
| Hail Storm + Decay | + | robi |
| Harvest + Corrupt | + | robi |
| Meteor + Seal of Spring | + | robi |
| Seal of Spring + Torrent | + | robi |
| Seal of Summer + Harvest | + | robi |
| Seal of Wind + Azimuth | + | robi |
| Seal of Wind + Charge | + | robi |
| Seal of Wind + Lurk | + | robi |
| Seal of Wind + Seal of Spring | + | robi |
| Slash + Syzygy | + | robi |
| Torrent + Seal of Stone | + | robi |
| Tsunami + Seal of Stone | + | robi |
| Tsunami + Torrent | + | robi |
| Azimuth + Seal of Winter | = | robi |
| Azimuth + Torrent | = | robi |
| Bewitch + Blossom | = | robi |
| Bewitch + Charge | = | robi |
| Bewitch + Grow | = | robi-chat |
| Bewitch + Harvest | = | robi |
| Bewitch + Seal of Autumn | = | robi |
| Bewitch + Seal of Lightning | = | robi |
| Bewitch + Seal of Summer | = | robi |
| Bewitch + Seal of Wind | = | robi |
| Bewitch + Slash | = | robi |
| Bewitch + Sprout | = | robi |
| Bewitch + Starfall | = | robi |
| Bewitch + Surge | = | robi |
| Blossom + Harvest | = | robi |
| Blossom + Scatter | = | robi |
| Carnage + Bewitch | = | robi |
| Carnage + Comet | = | robi |
| Carnage + Fireblast | = | robi |
| Carnage + Grow | = | robi |
| Carnage + Meteor | = | robi |
| Carnage + Seal of Lightning | = | robi |
| Carnage + Starfall | = | robi |
| Charge + Seal of Winter | = | robi |
| Charge + Torrent | = | robi |
| Comet + Harvest | = | robi |
| Corrupt + Lurk | = | robi |
| Eclipse + Seal of Destruction | = | robi |
| Fireblast + Charge | = | robi |
| Fireblast + Lurk | = | robi |
| Fireblast + Seal of Autumn | = | robi |
| Fireblast + Seal of Spring | = | robi |
| Fireblast + Splash | = | robi |
| Flourish + Bewitch | = | robi |
| Flourish + Blossom | = | robi |
| Flourish + Carnage | = | robi |
| Flourish + Decay | = | robi |
| Flourish + Hail Storm | = | robi |
| Flourish + Hurricane | = | robi |
| Flourish + Lurk | = | robi |
| Flourish + Meteor | = | robi |
| Flourish + Scatter | = | robi |
| Flourish + Seal of Autumn | = | robi |
| Flourish + Seal of Lightning | = | robi |
| Flourish + Seal of Spring | = | robi |
| Flourish + Seal of Winter | = | robi |
| Flourish + Slash | = | robi |
| Flourish + Sprout | = | robi |
| Flourish + Starfall | = | robi |
| Flourish + Storm Front | = | robi |
| Flourish + Surge | = | robi |
| Flourish + Tsunami | = | robi |
| Gather + Seal of Autumn | = | robi |
| Grow + Azimuth | = | robi |
| Grow + Blossom | = | robi |
| Grow + Charge | = | robi |
| Grow + Gust | = | robi |
| Grow + Lurk | = | robi |
| Grow + Seal of Autumn | = | robi |
| Grow + Tsunami | = | robi |
| Gust + Torrent | = | robi |
| Hail Storm + Fury | = | robi |
| Hail Storm + Storm Front | = | robi |
| Harvest + Seal of Autumn | = | robi |
| Meteor + Seal of Autumn | = | robi |
| Seal of Autumn + Seal of Winter | = | robi |
| Seal of Spring + Seal of Winter | = | robi |
| Seal of Summer + Lurk | = | robi |
| Seal of Wind + Seal of Autumn | = | robi |
| Seal of Wind + Seal of Winter | = | robi |
| Seal of Wind + Splash | = | robi |
| Slash + Gather | = | robi |
| Slash + Scatter | = | robi |
| Splash + Seal of Winter | = | robi |
| Starfall + Grow | = | robi |
| Starfall + Seal of Lightning | = | robi |
| Surge + Erupt | = | robi |
| Surge + Hurricane | = | robi |
| Syzygy + Seal of Autumn | = | robi |
| Bewitch + Azimuth | - | robi |
| Bewitch + Hail Storm | - | robi |
| Bewitch + Meteor | - | robi |
| Bewitch + Seal of Spring | - | robi |
| Bewitch + Syzygy | - | robi |
| Carnage + Hail Storm | - | robi |
| Carnage + Slash | - | robi |
| Carnage + Surge | - | robi |
| Comet + Blossom | - | robi |
| Comet + Decay | - | robi |
| Comet + Fury | - | robi |
| Comet + Scatter | - | robi |
| Fireblast + Azimuth | - | robi |
| Flourish + Seal of Wind | - | robi |
| Flourish + Splash | - | robi |
| Flourish + Syzygy | - | robi |
| Gather + Decay | - | robi |
| Grow + Splash | - | robi |
| Grow + Syzygy | - | robi |
| Hail Storm + Eclipse | - | robi |
| Hail Storm + Gather | - | robi |
| Hail Storm + Scatter | - | robi |
| Hail Storm + Torrent | - | robi |
| Harvest + Gather | - | robi |
| Meteor + Blossom | - | robi |
| Seal of Spring + Syzygy | - | robi |
| Slash + Decay | - | robi |
| Slash + Eclipse | - | robi |
| Slash + Fury | - | robi |
| Slash + Torrent | - | robi |
| Surge + Blossom | - | robi |
| Surge + Harvest | - | robi |
| Surge + Syzygy | - | robi |
| Torrent + Splash | - | robi |
| Tsunami + Splash | - | robi |
| Seal of Lightning + Splash | -- | prefill |

### Matchups (opposite players; rating is for the favoured spell)

| Favoured | vs | Rating | Source |
|---|---|---|---|
| Azimuth | Hurricane | ++ | prefill |
| Charge | Hurricane | ++ | prefill |
| Decay | Blossom | ++ | prefill |
| Decay | Scatter | ++ | prefill |
| Hail Storm | Blossom | ++ | prefill |
| Lurk | Hurricane | ++ | prefill |
| Slash | Hurricane | ++ | prefill |
| Splash | Hurricane | ++ | prefill |
| Sprout | Hurricane | ++ | prefill |
| Surge | Hurricane | ++ | robi |
| Azimuth | Torrent | + | robi |
| Bewitch | Grow | + | robi-chat |
| Bewitch | Seal of Spring | + | robi |
| Bewitch | Seal of Summer | + | robi |
| Bewitch | Sprout | + | robi |
| Bewitch | Syzygy | + | robi |
| Blossom | Bewitch | + | robi |
| Blossom | Comet | + | robi |
| Blossom | Flourish | + | robi |
| Blossom | Grow | + | robi |
| Carnage | Fireblast | + | robi |
| Carnage | Grow | + | robi |
| Carnage | Seal of Lightning | + | robi |
| Carnage | Seal of Summer | + | robi |
| Charge | Flourish | + | robi |
| Charge | Grow | + | robi |
| Charge | Torrent | + | robi |
| Comet | Bewitch | + | robi |
| Comet | Carnage | + | robi |
| Comet | Flourish | + | robi |
| Comet | Fury | + | robi |
| Comet | Syzygy | + | robi |
| Comet | Torrent | + | robi |
| Comet | Tsunami | + | robi |
| Corrupt | Flourish | + | robi |
| Corrupt | Lurk | + | robi |
| Decay | Comet | + | robi |
| Decay | Starfall | + | prefill |
| Erupt | Flourish | + | robi |
| Erupt | Grow | + | robi |
| Fireblast | Azimuth | + | robi |
| Fireblast | Flourish | + | robi |
| Fireblast | Lurk | + | robi |
| Fireblast | Seal of Spring | + | robi |
| Flourish | Eclipse | + | robi |
| Flourish | Grow | + | robi |
| Flourish | Gust | + | robi |
| Flourish | Hurricane | + | robi |
| Flourish | Seal of Destruction | + | robi |
| Flourish | Seal of Summer | + | robi |
| Flourish | Seal of Winter | + | robi |
| Flourish | Torrent | + | robi |
| Flourish | Tsunami | + | robi |
| Fury | Flourish | + | robi |
| Fury | Slash | + | robi |
| Gather | Comet | + | robi |
| Gather | Decay | + | robi |
| Gather | Flourish | + | robi |
| Gather | Hail Storm | + | robi |
| Gather | Harvest | + | robi |
| Hail Storm | Decay | + | robi |
| Hail Storm | Scatter | + | robi |
| Harvest | Comet | + | robi |
| Harvest | Flourish | + | robi |
| Harvest | Grow | + | robi |
| Harvest | Seal of Summer | + | robi |
| Meteor | Bewitch | + | robi |
| Meteor | Flourish | + | robi |
| Scatter | Comet | + | robi |
| Scatter | Flourish | + | robi |
| Seal of Autumn | Fireblast | + | robi |
| Seal of Autumn | Seal of Winter | + | robi |
| Seal of Autumn | Syzygy | + | robi |
| Seal of Destruction | Comet | + | robi |
| Seal of Destruction | Eclipse | + | robi |
| Seal of Lightning | Seal of Stone | + | prefill |
| Seal of Lightning | Starfall | + | robi |
| Seal of Spring | Seal of Winter | + | robi |
| Seal of Spring | Syzygy | + | robi |
| Seal of Spring | Torrent | + | robi |
| Seal of Stone | Flourish | + | robi |
| Seal of Stone | Torrent | + | robi |
| Seal of Wind | Azimuth | + | robi |
| Seal of Wind | Bewitch | + | robi |
| Seal of Wind | Flourish | + | robi |
| Seal of Wind | Lurk | + | robi |
| Seal of Wind | Seal of Autumn | + | robi |
| Seal of Wind | Seal of Winter | + | robi |
| Seal of Wind | Splash | + | robi |
| Seal of Winter | Azimuth | + | robi |
| Seal of Winter | Charge | + | robi |
| Seal of Winter | Splash | + | robi |
| Slash | Decay | + | robi |
| Slash | Torrent | + | robi |
| Splash | Torrent | + | robi |
| Starfall | Grow | + | robi |
| Syzygy | Flourish | + | robi |
| Syzygy | Grow | + | robi |
| Syzygy | Slash | + | robi |
| Tsunami | Torrent | + | robi |
| Bewitch | Azimuth | = | robi |
| Bewitch | Charge | = | robi |
| Bewitch | Fireblast | = | robi |
| Bewitch | Hail Storm | = | robi |
| Bewitch | Harvest | = | robi |
| Bewitch | Seal of Autumn | = | robi |
| Bewitch | Seal of Lightning | = | robi |
| Bewitch | Slash | = | robi |
| Bewitch | Starfall | = | robi |
| Bewitch | Surge | = | robi |
| Bewitch | Tsunami | = | robi |
| Blossom | Harvest | = | robi |
| Blossom | Scatter | = | robi |
| Carnage | Bewitch | = | robi |
| Carnage | Hail Storm | = | robi |
| Carnage | Meteor | = | robi |
| Carnage | Seal of Stone | = | prefill |
| Carnage | Slash | = | robi |
| Carnage | Starfall | = | robi |
| Carnage | Surge | = | robi |
| Comet | Corrupt | = | robi |
| Comet | Eclipse | = | robi |
| Comet | Erupt | = | robi |
| Comet | Seal of Stone | = | robi |
| Fireblast | Charge | = | robi |
| Fireblast | Splash | = | robi |
| Flourish | Azimuth | = | robi |
| Flourish | Bewitch | = | robi |
| Flourish | Carnage | = | robi |
| Flourish | Decay | = | robi |
| Flourish | Hail Storm | = | robi |
| Flourish | Lurk | = | robi |
| Flourish | Seal of Autumn | = | robi |
| Flourish | Seal of Lightning | = | robi |
| Flourish | Seal of Spring | = | robi |
| Flourish | Slash | = | robi |
| Flourish | Splash | = | robi |
| Flourish | Sprout | = | robi |
| Flourish | Starfall | = | robi |
| Flourish | Storm Front | = | robi |
| Flourish | Surge | = | robi |
| Fury | Corrupt | = | robi |
| Fury | Seal of Stone | = | prefill |
| Gather | Seal of Autumn | = | robi |
| Grow | Azimuth | = | robi |
| Grow | Corrupt | = | robi |
| Grow | Gust | = | robi |
| Grow | Lurk | = | robi |
| Grow | Seal of Autumn | = | robi |
| Grow | Seal of Spring | = | robi |
| Grow | Splash | = | robi |
| Grow | Tsunami | = | robi |
| Gust | Torrent | = | robi |
| Hail Storm | Eclipse | = | robi |
| Hail Storm | Fury | = | robi |
| Hail Storm | Lurk | = | prefill |
| Hail Storm | Storm Front | = | robi |
| Hail Storm | Torrent | = | robi |
| Harvest | Corrupt | = | robi |
| Harvest | Seal of Autumn | = | robi |
| Meteor | Blossom | = | robi |
| Meteor | Seal of Autumn | = | robi |
| Meteor | Seal of Destruction | = | prefill |
| Meteor | Seal of Spring | = | robi |
| Meteor | Seal of Stone | = | prefill |
| Meteor | Seal of Summer | = | prefill |
| Meteor | Seal of Wind | = | prefill |
| Meteor | Seal of Winter | = | prefill |
| Seal of Lightning | Meteor | = | prefill |
| Seal of Lightning | Storm Front | = | prefill |
| Seal of Spring | Storm Front | = | prefill |
| Seal of Summer | Lurk | = | robi |
| Seal of Summer | Storm Front | = | prefill |
| Seal of Wind | Charge | = | robi |
| Seal of Wind | Seal of Spring | = | robi |
| Seal of Wind | Storm Front | = | prefill |
| Slash | Eclipse | = | robi |
| Slash | Gather | = | robi |
| Slash | Scatter | = | robi |
| Slash | Seal of Stone | = | prefill |
| Storm Front | Seal of Autumn | = | prefill |
| Storm Front | Seal of Destruction | = | prefill |
| Storm Front | Seal of Stone | = | prefill |
| Storm Front | Seal of Winter | = | prefill |
| Surge | Blossom | = | robi |
| Surge | Erupt | = | robi |
| Surge | Harvest | = | robi |
| Surge | Syzygy | = | robi |
| Tsunami | Seal of Stone | = | robi |
| Tsunami | Splash | = | robi |

### Data tier fit vs Robi quality (log-odds per cast; seals: held ≥1 turn)

| Spell | Robi | data c | flag |
|---|---|---|---|
| Hurricane | medium | +2.89 |  |
| Fireblast | good | +1.71 |  |
| Surge | medium | +1.27 |  |
| Corrupt | good | +1.22 |  |
| Fury | good | +1.22 |  |
| Hail Storm | medium | +1.16 |  |
| Carnage | good | +1.02 |  |
| Decay | bad | +0.97 | data likes it more |
| Starfall | good | +0.92 |  |
| Harvest | good | +0.81 |  |
| Erupt | medium | +0.77 |  |
| Tsunami | bad | +0.76 | data likes it more |
| Bewitch | good | +0.75 |  |
| Grow | bad | +0.70 | data likes it more |
| Flourish | medium | +0.68 |  |
| Gust | bad | +0.61 | data likes it more |
| Gather | good | +0.51 |  |
| Meteor | medium | +0.50 |  |
| Eclipse | bad | +0.48 |  |
| Torrent | bad | +0.48 |  |
| Storm Front | medium | +0.46 |  |
| Blossom | good | +0.46 |  |
| Syzygy | medium | +0.35 |  |
| Lurk | medium | +0.34 |  |
| Scatter | good | +0.21 | data likes it less |
| Azimuth | medium | +0.19 |  |
| Charge | good | +0.16 | data likes it less |
| Slash | good | +0.09 | data likes it less |
| Seal of Lightning | good | +0.70 |  |
| Splash | medium | +0.08 |  |
| Sprout | medium | +0.07 |  |
| Seal of Winter | bad | -0.27 |  |
| Seal of Stone | medium | +0.44 |  |
| Seal of Wind | good | +0.18 | data likes it less |
| Seal of Spring | medium | +0.62 |  |
| Seal of Summer | medium | +0.18 |  |
| Seal of Autumn | medium | -0.39 |  |
| Comet | medium | -0.30 |  |
| Seal of Destruction | medium | -0.75 |  |

### Ranking from "which spell is better" (160 comparisons, Bradley-Terry)

| # | Spell | Strength | Comparisons | Robi quality |
|---|---|---|---|---|
| 1 | Gather | +1.63 | 7 | good |
| 2 | Fireblast | +1.56 | 9 | good |
| 3 | Scatter | +1.24 | 5 | good |
| 4 | Blossom | +1.12 | 8 | good |
| 5 | Charge | +0.84 | 7 | good |
| 6 | Corrupt | +0.81 | 6 | good |
| 7 | Bewitch | +0.77 | 21 | good |
| 8 | Seal of Wind | +0.77 | 9 | good |
| 9 | Harvest | +0.73 | 10 | good |
| 10 | Carnage | +0.70 | 12 | good |
| 11 | Slash | +0.69 | 10 | good |
| 12 | Fury | +0.63 | 5 | good |
| 13 | Meteor | +0.55 | 6 | medium |
| 14 | Starfall | +0.53 | 5 | good |
| 15 | Seal of Lightning | +0.46 | 4 | good |
| 16 | Hail Storm | +0.42 | 10 | medium |
| 17 | Storm Front | +0.33 | 2 | medium |
| 18 | Erupt | +0.28 | 4 | medium |
| 19 | Hurricane | +0.25 | 2 | medium |
| 20 | Seal of Stone | +0.11 | 4 | medium |
| 21 | Azimuth | +0.11 | 7 | medium |
| 22 | Surge | -0.01 | 8 | medium |
| 23 | Comet | -0.20 | 17 | medium |
| 24 | Splash | -0.31 | 7 | medium |
| 25 | Sprout | -0.40 | 2 | medium |
| 26 | Seal of Winter | -0.46 | 7 | bad |
| 27 | Seal of Spring | -0.55 | 9 | medium |
| 28 | Seal of Autumn | -0.56 | 10 | medium |
| 29 | Seal of Destruction | -0.66 | 3 | medium |
| 30 | Lurk | -0.78 | 6 | medium |
| 31 | Flourish | -0.79 | 38 | medium |
| 32 | Decay | -0.92 | 5 | bad |
| 33 | Tsunami | -0.93 | 6 | bad |
| 34 | Seal of Summer | -1.03 | 5 | medium |
| 35 | Eclipse | -1.14 | 5 | bad |
| 36 | Syzygy | -1.18 | 8 | medium |
| 37 | Gust | -1.34 | 3 | bad |
| 38 | Grow | -1.36 | 17 | bad |
| 39 | Torrent | -1.92 | 11 | bad |
<!-- SURVEY-END -->

<!-- POSWR-BEGIN (generated by tools/spell_position_winrates.py + this block) -->
## Three win-rate views per spell (2026-09-06, all 2,411 games, raw, no strength adjustment)

Robi's objection to view (a): a spell is only cast when it is useful, so 'win rate when cast' is selection-biased upward (a player who filled Hurricane but got neutralised never casts it and probably loses). Views (b) and (c) condition on INVESTMENT, not on the payoff.
- (a) win rate of the side that cast the spell at least once.
- (b) win rate of the side starting closer (graph distance from its stones to the nearest node of the spell) once both players have a first stone: standard = the fixed a1/b1 setup, so the spell layout is RANDOM and this is effectively a randomised experiment; competitive = after turn 2, where placement is a choice. Ties excluded.
- (c) win rate of the side with strictly more stones in the spell after blue's 5th turn (turn 10). Ties and shorter games excluded.
z = standard-normal distance from 50%; |z| ≥ 2 is roughly significant.

| Spell | (a) cast WR | n | (b) closer WR | n | (b-std) | n | (b-comp) | n | (c) more at T10 | n | z(c) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Splash | 55% | 53 | 70% | 60 | 80% | 5 | 69% | 55 | 80% | 10 | +1.9 |
| Scatter | 74% | 87 | 69% | 163 | 43% | 21 | 73% | 142 | 77% | 112 | +5.7 |
| Seal of Wind | – | 0 | 55% | 1185 | 50% | 935 | 76% | 250 | 72% | 594 | +10.7 |
| Fireblast | 82% | 417 | 51% | 1166 | 51% | 941 | 51% | 225 | 70% | 379 | +7.9 |
| Charge | 52% | 107 | 62% | 107 | 40% | 5 | 63% | 102 | 67% | 30 | +1.8 |
| Decay | 75% | 12 | 52% | 48 | 67% | 3 | 51% | 45 | 64% | 11 | +0.9 |
| Comet | 44% | 236 | 51% | 868 | 48% | 629 | 59% | 239 | 63% | 91 | +2.4 |
| Eclipse | 56% | 25 | 49% | 81 | 52% | 21 | 48% | 60 | 60% | 20 | +0.9 |
| Hail Storm | 64% | 490 | 51% | 1205 | 51% | 946 | 49% | 259 | 59% | 323 | +3.1 |
| Grow | 63% | 445 | 49% | 1180 | 49% | 934 | 49% | 246 | 58% | 329 | +2.9 |
| Meteor | 60% | 470 | 51% | 1200 | 51% | 952 | 48% | 248 | 57% | 362 | +2.7 |
| Harvest | 50% | 20 | 46% | 112 | 33% | 3 | 46% | 109 | 56% | 71 | +1.1 |
| Blossom | 63% | 73 | 55% | 186 | 46% | 28 | 57% | 158 | 56% | 124 | +1.3 |
| Sprout | 56% | 762 | 52% | 856 | 51% | 596 | 56% | 260 | 54% | 110 | +0.8 |
| Storm Front | 39% | 44 | 54% | 101 | 67% | 15 | 52% | 86 | 53% | 38 | +0.3 |
| Corrupt | 33% | 3 | 53% | 36 | 67% | 3 | 52% | 33 | 53% | 19 | +0.2 |
| Seal of Summer | 100% | 1 | 53% | 868 | 49% | 613 | 61% | 255 | 52% | 115 | +0.5 |
| Hurricane | 94% | 31 | 59% | 111 | 56% | 9 | 59% | 102 | 51% | 67 | +0.1 |
| Carnage | 65% | 377 | 52% | 1195 | 51% | 948 | 60% | 247 | 51% | 599 | +0.3 |
| Fury | 70% | 54 | 51% | 175 | 53% | 15 | 51% | 160 | 48% | 50 | -0.3 |
| Gather | 68% | 72 | 50% | 141 | 50% | 2 | 50% | 139 | 47% | 53 | -0.4 |
| Seal of Spring | – | 0 | 57% | 155 | 50% | 16 | 58% | 139 | 46% | 26 | -0.4 |
| Torrent | 50% | 40 | 49% | 87 | 64% | 14 | 47% | 73 | 46% | 26 | -0.4 |
| Azimuth | 56% | 57 | 52% | 102 | 36% | 14 | 55% | 88 | 46% | 24 | -0.4 |
| Syzygy | 42% | 33 | 50% | 106 | 46% | 28 | 51% | 78 | 46% | 57 | -0.7 |
| Tsunami | 56% | 25 | 55% | 105 | 45% | 11 | 56% | 94 | 45% | 38 | -0.6 |
| Bewitch | 64% | 415 | 51% | 1180 | 50% | 945 | 54% | 235 | 45% | 658 | -2.8 |
| Seal of Lightning | – | 0 | 51% | 1205 | 47% | 918 | 63% | 287 | 44% | 687 | -2.9 |
| Starfall | 61% | 409 | 50% | 1238 | 49% | 954 | 51% | 284 | 44% | 651 | -3.3 |
| Slash | 47% | 488 | 54% | 939 | 49% | 660 | 65% | 279 | 43% | 163 | -1.8 |
| Flourish | 54% | 431 | 49% | 1192 | 50% | 954 | 47% | 238 | 41% | 650 | -4.5 |
| Seal of Stone | – | 0 | 43% | 51 | 0% | 3 | 46% | 48 | 40% | 15 | -0.8 |
| Surge | 96% | 112 | 54% | 872 | 52% | 647 | 62% | 225 | 39% | 175 | -2.9 |
| Lurk | 53% | 53 | 47% | 64 | 100% | 1 | 46% | 63 | 33% | 15 | -1.3 |
| Seal of Winter | – | 0 | 56% | 50 | 100% | 1 | 55% | 49 | 33% | 15 | -1.3 |
| Erupt | 79% | 19 | 40% | 103 | 100% | 1 | 39% | 102 | 31% | 58 | -2.9 |
| Seal of Autumn | – | 0 | 48% | 111 | 50% | 2 | 48% | 109 | 29% | 31 | -2.3 |
| Gust | 25% | 4 | 48% | 73 | 50% | 6 | 48% | 67 | 27% | 11 | -1.5 |
| Seal of Destruction | – | 0 | 45% | 33 | – | 0 | 45% | 33 | 27% | 11 | -1.5 |

Reproduce: `python3 tools/spell_position_winrates.py <dir with completed_games_live.json + hydrated.json>`
<!-- POSWR-END -->

## 1. Board crowdedness (MY PRE-SURVEY GUESSES — superseded where the survey has an answer) (Empty / Crowded)

| Spell | Empty | Crowded | Note |
|---|---|---|---|
| Flourish | ++ | - | soft moves need empty neighbours |
| Carnage | - | ++ | pushes crush on full boards |
| Bewitch | - | + | needs an enemy pair in contact |
| Starfall | - | ++ | landing zone is surrounded |
| Seal of Lightning | = | = | |
| Grow | + | - | |
| Fireblast | -- | ++ | |
| Hail Storm | - | + | scales with enemy spell occupancy |
| Meteor | = | + | |
| Seal of Wind | + | = | |
| Sprout | = | - | |
| Slash | - | + | |
| Surge | = | = | |
| Comet | = | = | |
| Seal of Summer | = | = | |
| Blossom | ++ | - | needs empty spell nodes |
| Scatter | + | - | |
| Seal of Spring | = | = | |
| Syzygy | + | - | fixed targets must be empty |
| Eclipse | = | = | |
| Azimuth | = | = | |
| Erupt | - | + | more spells seeded late |
| Fury | - | ++ | |
| Charge | = | = | |
| Hurricane | ++ | - | GUESS v2: early/empty boards have one group → one-shot threat; crowded boards are already split |
| Storm Front | = | + | |
| Gust | -- | ++ | |
| Tsunami | = | + | |
| Torrent | = | = | |
| Splash | = | = | |
| Harvest | + | - | |
| Gather | + | - | |
| Seal of Autumn | = | = | |
| Corrupt | - | ++ | |
| Decay | ++ | -- | |
| Lurk | + | - | |
| Seal of Destruction | - | ++ | |
| Seal of Stone | = | + | soft moves scarce when crowded |
| Seal of Winter | = | = | |

## 2. Synergy (same player holds both)

| Pair | Rating | Why |
|---|---|---|
| Grow + Harvest | ++ | refill loop (Robi) |
| Flourish + Gather | ++ | refill loop (Robi) |
| Gather + Harvest | ++ | each refills the other |
| Seal of Spring + Grow/Flourish/Harvest | ++ | recast locked mover |
| Seal of Summer + Gather/Harvest | ++ | double cast fuels the loop |
| Seal of Summer + Azimuth/Eclipse | ++ | fill-then-finish in one turn |
| Eclipse + Azimuth | + | |
| Blossom + Erupt | ++ | CONFIRMED (Robi) |
| Scatter + Erupt | ++ | CONFIRMED (Robi) |
| Charge + Erupt | + | |
| Seal of Lightning + Surge | ++ | CONFIRMED (Robi) |
| Seal of Lightning + Splash | -- | CONFIRMED (Robi) |
| Surge + Splash | - | mutually exclusive |
| Carnage + Fireblast | = | CONFIRMED neutral (Robi): no synergy |
| Gust + Decay | ++ | CONFIRMED (Robi) |
| Storm Front + Hurricane | ++ | cut a group in two, then delete the small half |
| Storm Front + Decay | + | |
| Bewitch + Corrupt | + | |
| Corrupt + Fireblast | + | |
| Seal of Stone + Carnage/Fury | = | Robi: Stone doesn't stop spell/dash pushes, so no real synergy (unconfirmed) |
| Seal of Winter + Seal of Summer | + | |
| Seal of Wind + Meteor/Comet | = | redundant blinks |
| Seal of Wind + Flourish | + | |
| Seal of Destruction + ? | ? | ask Robi how it is actually used |

## 3. Matchups (row spell vs column spell; rating is for the ROW holder)

| Row vs Column | Rating | Why |
|---|---|---|
| Hail Storm vs Blossom | ++ | (Robi) |
| Hail Storm vs Erupt | ++ | stones in every spell |
| Hail Storm vs Scatter | + | |
| Hail Storm vs Lurk | = | CONFIRMED (Robi) |
| Decay vs Blossom/Scatter | ++ | CONFIRMED (Robi) |
| Decay vs Flourish/Grow | + | thin spreads |
| Decay vs Starfall | + | CONFIRMED (Robi) |
| Hurricane vs Scatter/Blossom | + | tiny groups (but kills only the smallest) — UNCONFIRMED |
| Hurricane vs Sprout/Slash/Surge/Splash/Charge/Azimuth/Lurk | -- | CONFIRMED (Robi): charm cast vacates a node and splits the group |
| Seal of Destruction (as blue) vs anything | + | Robi: blue wins at +2, so fill-and-win is easy; as red only = |
| Carnage vs Fireblast | + | CONFIRMED (Robi): Fireblast needs slow buildup of bordering stones; Carnage seizes the spell/contested area first |
| Fireblast vs Corrupt | + | Fireblast resolves first / cheaper |
| Storm Front / Meteor vs any Seal | = | CONFIRMED (Robi): not a real counter in practice |
| Fissure vs any Seal | ++ | CONFIRMED (Robi) — Tectonic, keep for later |
| Seal of Winter vs Surge/Splash/Sprout/Slash/Charge/Azimuth/Dividend/Ember/Tripwire/Lurk | ++ | charm denial |
| Seal of Winter vs Seal of Summer (already charged) | = | |
| Seal of Stone vs Carnage/Fury/Slash | = | CONFIRMED (Robi): Stone only softens the REGULAR move; dashes and spells still push/destroy |
| Seal of Lightning vs Seal of Stone | + | CONFIRMED (Robi): cheap dash bypasses Stone |
| Seal of Stone vs Seal of Wind | = | Wind blink to empty is still soft (engine) |
| Seal of Autumn vs Seal of Lightning | + | |
| Gust vs Decay | + | Gust caster clumps own stones? ask |
