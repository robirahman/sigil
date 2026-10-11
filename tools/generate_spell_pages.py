#!/usr/bin/env python3
"""Generate dedicated pages for every official spell and spell pack in Sigil.

Excludes unofficial packs: Panda and Experimental.
Outputs:
  docs/spells/<spell-slug>.html (45 official spells)
  docs/spells/index.html (Spells Compendium)
  docs/packs/<pack-slug>.html (11 official packs + 5 core subpacks)
  docs/packs/index.html (Packs Compendium)
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(REPO, 'docs')
SPELLS_DIR = os.path.join(DOCS, 'spells')
PACKS_DIR = os.path.join(DOCS, 'packs')

# Load spell-charts.json if available
CHARTS_PATH = os.path.join(DOCS, 'static', 'data', 'spell-charts.json')
CHARTS = json.load(open(CHARTS_PATH)) if os.path.exists(CHARTS_PATH) else {}

# Load winrate data if available
WR_PATH = os.path.join(DOCS, 'strategy', 'data', 'spell_position_winrates.json')
WINRATES = json.load(open(WR_PATH)) if os.path.exists(WR_PATH) else {}

def slugify(name):
    return name.lower().replace('_', '-')

def pretty(name):
    return name.replace('_', ' ')

# Official packs definitions
PACKS = [
    {
        'key': 'core',
        'name': 'Core',
        'slug': 'core',
        'tagline': 'The foundational terrain of Sigil — five elemental disciplines governing growth, destruction, impact, speed, and deception.',
        'description': (
            'The Core spell set forms the printed foundation of Sigil. Spanning fifteen spells across five thematic trios '
            '(Growth, Havoc, Crater, Tempo, and Hex), the core set establishes the fundamental game dynamics: soft movement '
            'expansion, aggressive hard-move pushing, long-range blink strikes, dash mobility, and mind-control conversions. '
            'Every standard match draws from this rich pool, balancing raw power with intricate counter-play.'
        ),
        'rituals': ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning'],
        'sorceries': ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind'],
        'charms': ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer'],
        'subpacks': [
            {'key': 'core_growth', 'name': 'Growth', 'slug': 'growth', 'rituals': ['Flourish'], 'sorceries': ['Grow'], 'charms': ['Sprout']},
            {'key': 'core_havoc', 'name': 'Havoc', 'slug': 'havoc', 'rituals': ['Carnage'], 'sorceries': ['Fireblast'], 'charms': ['Slash']},
            {'key': 'core_crater', 'name': 'Crater', 'slug': 'crater', 'rituals': ['Starfall'], 'sorceries': ['Meteor'], 'charms': ['Comet']},
            {'key': 'core_tempo', 'name': 'Tempo', 'slug': 'tempo', 'rituals': ['Seal_of_Lightning'], 'sorceries': ['Seal_of_Wind'], 'charms': ['Seal_of_Summer']},
            {'key': 'core_hex', 'name': 'Hex', 'slug': 'hex', 'rituals': ['Bewitch'], 'sorceries': ['Hail_Storm'], 'charms': ['Surge']},
        ]
    },
    {
        'key': 'springtime',
        'name': 'Springtime',
        'slug': 'springtime',
        'tagline': 'Explosive proliferation and multi-spell dispersion across the entire board.',
        'description': (
            'The Springtime expansion introduces sprawling multi-theater tactics. Rather than contesting one spell at a time, '
            'Blossom and Scatter seed friendly stones into multiple 3-node and 5-node sigils simultaneously. Combined with '
            'Seal of Spring\'s ability to cast locked spells a second time, Springtime forces the opponent to defend everywhere at once.'
        ),
        'rituals': ['Blossom'],
        'sorceries': ['Scatter'],
        'charms': ['Seal_of_Spring'],
    },
    {
        'key': 'celestial',
        'name': 'Celestial',
        'slug': 'celestial',
        'tagline': 'Astronomical geometry, cross-ring alignments, and precise positional thresholds.',
        'description': (
            'The Celestial expansion turns the board into a cosmic dial. Syzygy strikes straight across the board\'s opposite ring, '
            'while Eclipse and Azimuth reward precise counting by instantly completing spells where you control all but one or two nodes. '
            'Celestial rewards calculative players who plan multi-turn conversions and geometric closures.'
        ),
        'rituals': ['Syzygy'],
        'sorceries': ['Eclipse'],
        'charms': ['Azimuth'],
    },
    {
        'key': 'fury',
        'name': 'Inferno',
        'slug': 'inferno',
        'tagline': 'High-velocity aggression, self-sacrificial blasts, and overwhelming frontline demolition.',
        'description': (
            'The Inferno expansion accelerates the game to fever pitch. Fury sacrifices a stone to unleash three devastating hard moves, '
            'Charge ramps directly into 3-node and 5-node sigils for immediate pressure, and Erupt converts every existing foothold into '
            'two explosive advancements. Inferno players trade attrition for unstoppable board momentum.'
        ),
        'rituals': ['Erupt'],
        'sorceries': ['Fury'],
        'charms': ['Charge'],
    },
    {
        'key': 'tempest',
        'name': 'Tempest',
        'slug': 'tempest',
        'tagline': 'Surgical elimination, gale-force displacement, and total disruption of enemy formations.',
        'description': (
            'The Tempest expansion commands the wind to dismantle enemy armies piece by piece. Storm Front provides unmitigated '
            'destruction of any two stones anywhere, Hurricane wipes isolated clusters, and Gust physically relocates bordering foes '
            'to neutral ground. Tempest disrupts opponent setups with merciless accuracy.'
        ),
        'rituals': ['Hurricane'],
        'sorceries': ['Storm_Front'],
        'charms': ['Gust'],
    },
    {
        'key': 'flood',
        'name': 'Flood',
        'slug': 'flood',
        'tagline': 'Fluid motion combining placement and pushing in seamless momentum chains.',
        'description': (
            'The Flood expansion introduces chain-reaction resolution. Tsunami and Torrent execute fluid sequences of soft moves '
            'followed immediately by hard moves, enabling players to place a stone and push an enemy with the same cast. '
            'Splash provides free movement whenever a dash is avoided, rewarding continuous board fluidity.'
        ),
        'rituals': ['Tsunami'],
        'sorceries': ['Torrent'],
        'charms': ['Splash'],
    },
    {
        'key': 'autumn',
        'name': 'Autumn',
        'slug': 'autumn',
        'tagline': 'Infinite fuel engines, locked-spell recycling, and dash denial.',
        'description': (
            'The Autumn expansion contains some of the highest-rated engine tools in the game. Gather and Harvest pump stones directly '
            'into your freshly cast, locked spells, creating self-refilling cycles that generate insurmountable stone leads. Meanwhile, '
            'Seal of Autumn prevents opponents from sacrificing stones in spells to dash, locking down their mobility.'
        ),
        'rituals': ['Harvest'],
        'sorceries': ['Gather'],
        'charms': ['Seal_of_Autumn'],
    },
    {
        'key': 'gloom',
        'name': 'Gloom',
        'slug': 'gloom',
        'tagline': 'Shadowy corruption, punishing overextension, and opportunistic infiltration.',
        'description': (
            'The Gloom expansion preys on vulnerable formations. Corrupt turns up to three bordering enemy stones into your color in '
            'a game-ending swing, Decay vaporizes any exposed stone bordering two or more empty nodes, and Lurk slips stones into '
            '1-node charms or void nodes unhindered. Gloom punishes loose play and rewards tight defensive encirclement.'
        ),
        'rituals': ['Corrupt'],
        'sorceries': ['Decay'],
        'charms': ['Lurk'],
    },
    {
        'key': 'covenant',
        'name': 'Covenant',
        'slug': 'covenant',
        'tagline': 'Ancient binding edicts, absolute prohibitions, and the ultimate double-edged victory seal.',
        'description': (
            'The Covenant expansion is built around permanent static seals that alter the core rules of play. Seal of Winter forbids '
            'the opponent from casting charms; Seal of Stone forces their first move each turn to be soft. And Seal of Destruction '
            'presents the ultimate high-wire act: annihilate bordering foes at turn\'s end, but lose the game if it remains filled '
            'at the start of your next turn.'
        ),
        'rituals': ['Seal_of_Destruction'],
        'sorceries': ['Seal_of_Stone'],
        'charms': ['Seal_of_Winter'],
    },
    {
        'key': 'tectonic',
        'name': 'Tectonic',
        'slug': 'tectonic',
        'tagline': 'Permanent catastrophic seismic terraforming, simultaneous pushes, and unbreakable wards.',
        'description': (
            'The Tectonic expansion shatters the physical board. Fissure permanently obliterates a target node into an impassable void, '
            'destroying bordering units and permanently severing any spell traversing it. Rock Slide triggers simultaneous multi-directional '
            'avalanches with deadly collision physics, while Bulwark renders locked spells completely immune to hard moves, destruction, and conversion.'
        ),
        'rituals': ['Fissure'],
        'sorceries': ['Rock_Slide'],
        'charms': ['Bulwark'],
    },
    {
        'key': 'providence',
        'name': 'Providence',
        'slug': 'providence',
        'tagline': 'Long-term investment banking, untouchable reserves, and alternate victory paths.',
        'description': (
            'The Providence expansion introduces an alternative road to victory: banking stones. Endowment, Annuity, and Dividend deposit '
            'stones into the player\'s personal Providence reserve. Because banked stones count toward the victory stone lead '
            '(3 for red, 2 for blue) without occupying board space, Providence turns the game into a relentless race against time.'
        ),
        'rituals': ['Endowment'],
        'sorceries': ['Annuity'],
        'charms': ['Dividend'],
    },
]

# Spell metadata dictionary: 45 official spells
SPELLS_DATA = {
    # --- CORE: Growth ---
    'Flourish': {
        'pack': 'core', 'subpack': 'Growth', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 4 soft moves.',
        'mechanics': (
            'Allows the caster to make four soft moves in sequence. Soft moves can only be made onto empty adjacent nodes '
            '(or empty mana/void nodes depending on board rules), placing new stones or maneuvering without pushing. '
            'Cannot push enemy stones or enter occupied nodes.'
        ),
        'strategy': (
            'Flourish is a rapid expansion tool. While 4 soft moves do not directly remove enemy stones, they allow you to '
            'fill multiple other sigils in a single turn. It pairs extraordinarily well with Gather and Harvest, where Flourish '
            'fills the engine and the Autumn spells refill Flourish on subsequent turns.'
        ),
    },
    'Grow': {
        'pack': 'core', 'subpack': 'Growth', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 2 soft moves.',
        'mechanics': (
            'Allows the caster to make two soft moves onto empty adjacent nodes. Does not permit pushing or dashing.'
        ),
        'strategy': (
            'On its own, Grow is a modest spell (2 soft moves for 3 nodes invested). However, its true value is as an engine '
            'partner: next to Harvest or Gather, Grow can be repeatedly cast and refilled to build up board control and net '
            'stones over 4 to 6 turns.'
        ),
    },
    'Sprout': {
        'pack': 'core', 'subpack': 'Growth', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 soft move.',
        'mechanics': (
            'Allows the caster to make a single soft move onto an empty adjacent node.'
        ),
        'strategy': (
            'A low-cost, 1-node utility charm. Sprout is ideal for quick micro-adjustments, triggering cast counters, '
            'or grabbing a contested mana node just before ending your turn.'
        ),
    },

    # --- CORE: Havoc ---
    'Carnage': {
        'pack': 'core', 'subpack': 'Havoc', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 4 hard moves.',
        'mechanics': (
            'Allows the caster to make four hard moves. A hard move pushes an adjacent enemy stone into an unoccupied node behind it. '
            'If the destination node is occupied or off the board, the pushed stone is crushed and destroyed!'
        ),
        'strategy': (
            'Carnage is one of the most dominant combat rituals in the game (ranked #8, Strong tier). It shreds enemy defensive lines, '
            'crushes clustered defenders, and seizes the contested center. Carnage beats Fireblast head-to-head because it establishes '
            'immediate physical superiority before Fireblast can assemble its contact network.'
        ),
    },
    'Fireblast': {
        'pack': 'core', 'subpack': 'Havoc', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Destroy all enemy stones which are touching you, then sacrifice a stone.',
        'mechanics': (
            'Every enemy stone that is directly adjacent to any stone of the caster\'s color is destroyed. '
            'After resolving all enemy stone destructions, the caster must choose and sacrifice one of their own stones.'
        ),
        'strategy': (
            'Ranked #2 overall (Top tier). Fireblast possesses catastrophic swing potential. In mid-game positions with sprawling '
            'frontline contact, a single Fireblast cast can eliminate 4 or 5 enemy stones simultaneously for the cost of 1 sacrifice. '
            'It forces the opponent to maintain spacing and punishes reckless clustering.'
        ),
    },
    'Slash': {
        'pack': 'core', 'subpack': 'Havoc', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 hard move.',
        'mechanics': (
            'Allows the caster to make one hard move, pushing an adjacent enemy stone backward and potentially crushing it.'
        ),
        'strategy': (
            'Ranked #10 overall and the highest-rated charm in the Core set. For a single node, Slash gives immediate frontline '
            'leverage. It can break an enemy lock attempt, crush a key defender, or push an intruder off your ritual.'
        ),
    },

    # --- CORE: Crater ---
    'Starfall': {
        'pack': 'core', 'subpack': 'Crater', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them.',
        'mechanics': (
            'The caster places two friendly stones on any two empty nodes that are adjacent to each other anywhere on the board '
            '(blink moves ignore board distance). Then, all enemy stones touching either of those two new stones are destroyed!'
        ),
        'strategy': (
            'Ranked #16 (Solid tier). Starfall is an orbital strike. Because blink moves ignore distance, Starfall can drop directly '
            'into the opponent\'s backline or between their key sigils, assassinating their stones and creating an instant fortified outpost.'
        ),
    },
    'Meteor': {
        'pack': 'core', 'subpack': 'Crater', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 1 blink move, then destroy 1 enemy stone touching it.',
        'mechanics': (
            'The caster places one stone onto any empty node on the board (blink move). Then, one enemy stone adjacent to '
            'the newly placed stone is chosen and destroyed.'
        ),
        'strategy': (
            'Ranked #17 (Solid tier). Meteor is the quintessential tactical sniper. It provides guaranteed disruption from anywhere '
            'on the board, ideal for picking off a stone in an opponent\'s nearly-charged ritual.'
        ),
    },
    'Comet': {
        'pack': 'core', 'subpack': 'Crater', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 blink move, then sacrifice a stone.',
        'mechanics': (
            'The caster places a stone onto any empty node across the board via blink, then chooses and sacrifices one friendly stone.'
        ),
        'strategy': (
            'Ranked #22 (Middling tier). While stone-neutral (place 1, sacrifice 1), Comet provides unmatched global teleportation. '
            'It lets you sacrifice a stranded backline stone to instantly contest an enemy win-condition node.'
        ),
    },

    # --- CORE: Tempo ---
    'Seal_of_Lightning': {
        'pack': 'core', 'subpack': 'Tempo', 'type': 'ritual', 'nodes': 5, 'static': True,
        'text': 'STATIC: Your dash only requires 1 sacrifice.',
        'mechanics': (
            'While this static seal is charged, whenever the caster performs a dash, they only need to sacrifice 1 stone '
            'instead of the standard 2 sacrifices. The seal remains active indefinitely until an enemy stone breaches the sigil.'
        ),
        'strategy': (
            'Ranked #6 overall (Strong tier). Halving the sacrifice cost of dashing transforms your entire tactical mobility. '
            'You can dash aggressively every turn to reposition and push enemy stones while preserving total stone advantage.'
        ),
    },
    'Seal_of_Wind': {
        'pack': 'core', 'subpack': 'Tempo', 'type': 'sorcery', 'nodes': 3, 'static': True,
        'text': 'STATIC: Your first move each turn is a blink move.',
        'mechanics': (
            'While this seal is active, the first move you make on every turn can jump to any empty node on the entire board, '
            'bypassing standard adjacency requirements.'
        ),
        'strategy': (
            'Ranked #13 overall (Strong tier). Permanent first-move blink breaks the opponent\'s ability to contain you. '
            'You can reinforce isolated areas, start surprise surrounds, or escape pins effortlessly.'
        ),
    },
    'Seal_of_Summer': {
        'pack': 'core', 'subpack': 'Tempo', 'type': 'charm', 'nodes': 1, 'static': True,
        'text': 'STATIC: You may cast 2 spells on your turn.',
        'mechanics': (
            'Under standard rules, a player may cast at most one spell per turn. While Seal of Summer is active, the caster may '
            'cast up to two separate spells on their turn.'
        ),
        'strategy': (
            'Ranked #32 in isolation, but an exponential force multiplier in engine setups. On crowded boards or alongside '
            'Harvest/Gather, Seal of Summer lets you trigger two spells in a single turn, doubling your tactical output.'
        ),
    },

    # --- CORE: Hex ---
    'Bewitch': {
        'pack': 'core', 'subpack': 'Hex', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Choose 2 enemy stones touching each other. Convert them to your color.',
        'mechanics': (
            'The caster selects two adjacent enemy stones. Both stones immediately switch allegiance and become friendly stones. '
            'This creates a direct 4-stone relative swing (+2 for you, -2 for the enemy).'
        ),
        'strategy': (
            'Ranked #12 (Strong tier). Bewitch punishes tight enemy defensive walls. Opponents must actively avoid placing stones '
            'next to each other when Bewitch is charged, disrupting their standard geometric formations.'
        ),
    },
    'Hail_Storm': {
        'pack': 'core', 'subpack': 'Hex', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Destroy 1 enemy stone in each 3-node and 5-node spell.',
        'mechanics': (
            'The spell sweeps the entire board: in every 3-node sorcery sigil and every 5-node ritual sigil that contains at least '
            'one enemy stone, exactly one enemy stone is destroyed.'
        ),
        'strategy': (
            'Ranked #14 (Solid tier). Hail Storm is the premier anti-expansion weapon. When an opponent uses Blossom or Scatter '
            'to seed stones across the entire board, Hail Storm wipes a stone from every single one of those spells simultaneously.'
        ),
    },
    'Surge': {
        'pack': 'core', 'subpack': 'Hex', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'If you dashed this turn, make 1 move.',
        'mechanics': (
            'If the caster performed a dash action earlier during the current turn, casting Surge grants an immediate additional move.'
        ),
        'strategy': (
            'Ranked #19 (Middling tier). A powerful tempo extender for dash-heavy turns, particularly lethal when combined with '
            'Seal of Lightning to maintain high offensive momentum.'
        ),
    },

    # --- SPRINGTIME ---
    'Blossom': {
        'pack': 'springtime', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 1 soft blink move into each other 3-node and 5-node spell.',
        'mechanics': (
            'For every other 3-node sorcery and 5-node ritual on the board, the caster places one stone onto an empty node in that spell '
            'via a soft blink move.'
        ),
        'strategy': (
            'Ranked #4 overall (Strong tier). Blossom floods the board in a single cast, establishing simultaneous threats in up to '
            'four or five distinct spells. It pairs destructively with Erupt (which adds 2 moves into every spell you occupy).'
        ),
    },
    'Scatter': {
        'pack': 'springtime', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 1 soft blink move into each of 2 spells.',
        'mechanics': (
            'The caster selects two separate spells and places one stone into each via a soft blink move onto an empty node.'
        ),
        'strategy': (
            'Ranked #3 overall (Top tier). Scatter offers rapid, flexible board presence with low setup cost. It enables seamless '
            'multi-front development and sets up devastating mid-game Erupt payoff turns.'
        ),
    },
    'Seal_of_Spring': {
        'pack': 'springtime', 'type': 'charm', 'nodes': 1, 'static': True,
        'text': 'STATIC: You may cast your locked spells a second time.',
        'mechanics': (
            'Normally, a spell becomes locked upon casting and cannot be cast again until unlocked. While Seal of Spring is active, '
            'the caster may cast any of their locked spells once more before requiring an unlock.'
        ),
        'strategy': (
            'Ranked #29 (Weak tier). While situational, Seal of Spring allows double-casting high-impact rituals like Blossom, '
            'Carnage, or Corrupt without waiting for lock cycle progression.'
        ),
    },

    # --- CELESTIAL ---
    'Syzygy': {
        'pack': 'celestial', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 1 blink move into the 1-node spell opposite Syzygy, then 3 into the 3-node spell.',
        'mechanics': (
            'Direct cross-board projection: places one stone via blink into the charm (1-node) directly opposite Syzygy across the ring, '
            'followed by three blink moves into the sorcery (3-node) opposite Syzygy.'
        ),
        'strategy': (
            'Ranked #35 (Weak tier due to fixed geometric targeting), but Syzygy delivers unmatched focused firepower into the '
            'opposing quadrant, often charging two opponent-facing spells in a single turn.'
        ),
    },
    'Eclipse': {
        'pack': 'celestial', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 2 moves into a spell where you control all but 2 nodes.',
        'mechanics': (
            'The caster targets a spell where exactly two nodes remain uncontrolled (empty or enemy-held) and immediately makes two moves '
            'into those nodes, completing or capturing the spell.'
        ),
        'strategy': (
            'Ranked #36 (Bottom tier in general due to strict activation conditions), but acts as an instant finisher for 3-node and '
            '5-node spells that need two final stones to trigger.'
        ),
    },
    'Azimuth': {
        'pack': 'celestial', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 move into a spell where you control all but 1 node.',
        'mechanics': (
            'The caster makes a move directly into any spell on the board where they already control all but exactly one node.'
        ),
        'strategy': (
            'Ranked #21 (Middling tier). Azimuth is an efficient 1-node closer that locks down contested rituals and sorceries before '
            'the opponent can react.'
        ),
    },

    # --- INFERNO ---
    'Erupt': {
        'pack': 'fury', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 2 moves into every spell, except Erupt, in which you have a stone.',
        'mechanics': (
            'For every spell on the board (excluding Erupt itself) where the caster already controls at least one stone, '
            'the caster makes two moves into that spell.'
        ),
        'strategy': (
            'Ranked #18 (Solid tier). The ultimate wide-board payoff. When paired with Blossom or Scatter, Erupt can generate 6, 8, '
            'or 10 moves across the board in a single devastating turn.'
        ),
    },
    'Fury': {
        'pack': 'fury', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Sacrifice 1 stone, then make 3 hard moves.',
        'mechanics': (
            'The caster sacrifices one friendly stone, then performs three hard moves (pushes) with remaining stones.'
        ),
        'strategy': (
            'Ranked #11 (Strong tier). Frontline demolition at sorcery cost. Sacrificing one backline stone to push and crush '
            'three enemy units produces immediate board dominance.'
        ),
    },
    'Charge': {
        'pack': 'fury', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 move into a 3- or 5-node spell.',
        'mechanics': (
            'The caster makes a move directly into any 3-node sorcery or 5-node ritual sigil.'
        ),
        'strategy': (
            'Ranked #7 overall (Strong tier). The highest-rated charm in the entire game. For just 1 node, Charge accelerates progress '
            'into heavy rituals and sorceries with unparalleled efficiency.'
        ),
    },

    # --- TEMPEST ---
    'Hurricane': {
        'pack': 'tempest', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Destroy the smallest contiguous group of enemy stones. If tied, you choose which.',
        'mechanics': (
            'Calculates all contiguous connected groups of enemy stones on the board. The group with the fewest stones is completely '
            'destroyed. If there is a tie for smallest size, the caster chooses which group to destroy.'
        ),
        'strategy': (
            'Ranked #24 (Middling tier). Hurricane surgically cleanses isolated enemy scouts, single-node infiltrators, and small '
            'clusters. Opponents must keep their stones connected to avoid losing units for free.'
        ),
    },
    'Storm_Front': {
        'pack': 'tempest', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Destroy any 2 enemy stones of your choice.',
        'mechanics': (
            'The caster selects any two enemy stones anywhere on the board and destroys them unconditionally.'
        ),
        'strategy': (
            'Ranked #15 (Solid tier). Clean, dependable, unconditional removal. Storm Front breaks enemy locks, destroys key defenders, '
            'and resets dangerous board threats without proximity constraints.'
        ),
    },
    'Gust': {
        'pack': 'tempest', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Pick up every enemy stone touching one of your stones, then place them on any empty nodes.',
        'mechanics': (
            'Every enemy stone touching a friendly stone is picked up and placed by the caster onto any empty nodes across the board.'
        ),
        'strategy': (
            'Ranked #38 in general play, but possesses game-winning hard counter interactions. Specifically, Gust hard-counters '
            'Seal of Destruction by picking up enemy stones and dumping them into the opponent\'s seal so they lose at the start of their turn!'
        ),
    },

    # --- FLOOD ---
    'Tsunami': {
        'pack': 'flood', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 2 soft moves, then 2 hard moves.',
        'mechanics': (
            'The caster executes a fluid sequence: first two soft moves (placements/positioning), followed immediately by two hard moves (pushes).'
        ),
        'strategy': (
            'Ranked #34 (Weak tier due to high ritual cost), but provides great versatility: you can place stones to create push angles '
            'and then immediately shove enemy stones into collisions.'
        ),
    },
    'Torrent': {
        'pack': 'flood', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 1 soft move, then 1 hard move.',
        'mechanics': (
            'The caster makes one soft move, followed immediately by one hard move.'
        ),
        'strategy': (
            'Ranked #39 (Bottom tier). A flexible micro-chain that allows positioning a stone and then shoving an opponent, '
            'though modest in raw efficiency.'
        ),
    },
    'Splash': {
        'pack': 'flood', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'If you did not dash this turn, make 1 move.',
        'mechanics': (
            'If the caster has not performed a dash action during the current turn, casting Splash grants an immediate free move.'
        ),
        'strategy': (
            'Ranked #25 (Middling tier). A dependable charm that rewards standard positional play without sacrifice costs.'
        ),
    },

    # --- AUTUMN ---
    'Harvest': {
        'pack': 'autumn', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Make 5 moves into your locked spell or into Harvest.',
        'mechanics': (
            'The caster makes five moves, directed either into the spell they currently have locked (the one they previously cast) '
            'or into Harvest itself.'
        ),
        'strategy': (
            'Ranked #9 overall (Strong tier). A primary engine piece. By refilling whatever ritual or sorcery you previously cast, '
            'Harvest unlocks it and establishes recurring multi-turn advantage.'
        ),
    },
    'Gather': {
        'pack': 'autumn', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Make 3 moves into your locked spell or into Gather.',
        'mechanics': (
            'The caster makes three moves into their locked spell or into Gather.'
        ),
        'strategy': (
            'Ranked #1 overall (Top tier — the single highest rated spell in Sigil!). Gather instantly refills any 3-node sorcery, '
            'creating an unbreakable loop that generates persistent stone leads and dictates the entire match.'
        ),
    },
    'Seal_of_Autumn': {
        'pack': 'autumn', 'type': 'charm', 'nodes': 1, 'static': True,
        'text': 'STATIC: Opponent cannot sacrifice stones in spells to dash.',
        'mechanics': (
            'While this seal is active, the opponent is forbidden from sacrificing any stone occupying a spell sigil when dashing. '
            'They can only sacrifice stones on mana or void nodes.'
        ),
        'strategy': (
            'Ranked #27 (Weak tier). A crippling counter against dash-dependent opponents on crowded boards where stones are mostly '
            'situated within spell nodes.'
        ),
    },

    # --- GLOOM ---
    'Corrupt': {
        'pack': 'gloom', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Choose up to 3 enemy stones touching your stones. Convert them to your color, then sacrifice a stone.',
        'mechanics': (
            'The caster chooses up to three enemy stones adjacent to friendly stones and converts them into friendly stones, '
            'then sacrifices one friendly stone. Results in a massive net swing of +2 friendly stones and -3 enemy stones.'
        ),
        'strategy': (
            'Ranked #5 overall (Strong tier). One of the most terrifying late-game finishers in Sigil. Converting three frontline '
            'defenders shatters the opponent\'s formation and frequently causes instant victory.'
        ),
    },
    'Decay': {
        'pack': 'gloom', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Destroy all enemy stones touching 2 or more empty nodes.',
        'mechanics': (
            'Checks every enemy stone on the board: if it is adjacent to at least two empty nodes, it is destroyed.'
        ),
        'strategy': (
            'Ranked #30 in general, but a catastrophic hard counter to Blossom, Scatter, and open-board expansion strategies '
            'where newly placed stones are surrounded by empty terrain.'
        ),
    },
    'Lurk': {
        'pack': 'gloom', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Make 1 move into a 1-node spell or a node outside of a spell.',
        'mechanics': (
            'Allows the caster to make one move into a charm (1-node spell) or into a mana/void node outside of any spell.'
        ),
        'strategy': (
            'Ranked #28 (Weak tier). Infiltration tool for slipping stones into secondary positions without exposing them '
            'to heavy ritual combat.'
        ),
    },

    # --- COVENANT ---
    'Seal_of_Destruction': {
        'pack': 'covenant', 'type': 'ritual', 'nodes': 5, 'static': True,
        'text': 'STATIC: If filled at the end of your turn, destroy all enemy stones touching you. If filled at the start of your turn, you lose.',
        'mechanics': (
            'At the end of the caster\'s turn, if the seal is completely filled with friendly stones, all enemy stones touching '
            'any friendly stone are obliterated. However, if the seal remains filled at the start of the caster\'s NEXT turn, '
            'the caster immediately loses the game!'
        ),
        'strategy': (
            'Ranked #33 (Weak tier). The ultimate high-stakes gamble. Blue can use it as a lethal sudden-death weapon, while red '
            'must beware of Gust or placement counters that trap the seal in a filled state.'
        ),
    },
    'Seal_of_Stone': {
        'pack': 'covenant', 'type': 'sorcery', 'nodes': 3, 'static': True,
        'text': "STATIC: Your opponent's first move each turn must be soft.",
        'mechanics': (
            'While this seal is active, the opponent is forbidden from leading their turn with a hard move, dash, or push. '
            'Their first move each turn must be a soft placement.'
        ),
        'strategy': (
            'Ranked #20 (Middling tier). A powerful defensive dampener that prevents opponent blitz attacks and protects '
            'your charging rituals from opening-turn hard move strikes.'
        ),
    },
    'Seal_of_Winter': {
        'pack': 'covenant', 'type': 'charm', 'nodes': 1, 'static': True,
        'text': 'STATIC: Your opponent cannot cast 1-node spells (charms).',
        'mechanics': (
            'While this seal is active, the opponent is completely blocked from casting any 1-node charm on the board.'
        ),
        'strategy': (
            'Ranked #26 (Weak tier in general, but completely shuts down charm-reliant strategies like Slash, Charge, and Dividend).'
        ),
    },

    # --- TECTONIC ---
    'Fissure': {
        'pack': 'tectonic', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': (
            'Choose a target node. It is permanently destroyed: its stone is removed and it becomes an impassable void '
            'that stones cannot move into, retreat into, or be pushed through, disabling any spell that includes it. '
            'Also destroy all stones on adjacent nodes, including your own.'
        ),
        'mechanics': (
            'The target node is permanently replaced by a DESTROYED crater wall. Stones occupying adjacent nodes are destroyed. '
            'Any spell sigil spanning the target node can never be charged again for the remainder of the game!'
        ),
        'strategy': (
            'The definitive static seal counter and terrain-shaping weapon. Fissure can permanently disable an opponent\'s '
            'key ritual or static seal, creating permanent tactical choke points.'
        ),
    },
    'Rock_Slide': {
        'pack': 'tectonic', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': (
            'Push each enemy stone bordering you into an adjacent node. All pushes happen simultaneously. '
            'Stones already occupying a destination are destroyed; stones pushed onto each other\'s nodes, or into the same node, are destroyed.'
        ),
        'mechanics': (
            'Triggers simultaneous pushes on all bordering enemy units. Complex collision physics crush overlapping and colliding enemy units.'
        ),
        'strategy': (
            'A massive area-of-effect defensive blast. Punishes opponent surround attempts by smashing multiple enemy stones against each other.'
        ),
    },
    'Bulwark': {
        'pack': 'tectonic', 'type': 'charm', 'nodes': 1, 'static': True,
        'text': 'STATIC: Stones in your locked spell cannot be moved, crushed, converted, or destroyed by the opponent.',
        'mechanics': (
            'While Bulwark is active, stones occupying your currently locked spell become completely invulnerable to enemy hard moves, '
            'conversions (Bewitch/Corrupt), and destructive spells (Fireblast, Hail Storm, Starfall).'
        ),
        'strategy': (
            'The ultimate defensive aegis for engine builders. Protects your Gather/Harvest refilling engines from enemy disruption.'
        ),
    },

    # --- PROVIDENCE ---
    'Endowment': {
        'pack': 'providence', 'type': 'ritual', 'nodes': 5, 'static': False,
        'text': 'Add 4 stones to your Providence bank.',
        'mechanics': (
            'Immediately deposits 4 stones into the caster\'s Providence bank. Banked stones count directly toward stone lead '
            'for the game-winning victory condition (win lead: red +3, blue +2) without occupying board nodes.'
        ),
        'strategy': (
            'A massive leap toward victory. Casting Endowment puts the player on the verge of winning the match outright '
            'via stone lead.'
        ),
    },
    'Annuity': {
        'pack': 'providence', 'type': 'sorcery', 'nodes': 3, 'static': False,
        'text': 'Add 2 stones to your Providence bank.',
        'mechanics': (
            'Immediately deposits 2 stones into the caster\'s Providence bank, adding directly to their victory stone lead.'
        ),
        'strategy': (
            'Consistent incremental investment that applies steady pressure to the opponent\'s win-condition clock.'
        ),
    },
    'Dividend': {
        'pack': 'providence', 'type': 'charm', 'nodes': 1, 'static': False,
        'text': 'Add 1 stone to your Providence bank.',
        'mechanics': (
            'Immediately deposits 1 stone into the caster\'s Providence bank for just 1 node investment.'
        ),
        'strategy': (
            'A high-tempo charm that can be cast quickly to break ties or tip the stone lead over the victory threshold.'
        ),
    },
}

# Helper to find pack for a spell
SPELL_TO_PACK = {}
for p in PACKS:
    for s in p['rituals'] + p['sorceries'] + p['charms']:
        SPELL_TO_PACK[s] = p

def get_tier_info(spell_name):
    tiers_data = CHARTS.get('tiers', [])
    spells_data = CHARTS.get('spells', {})
    meta = spells_data.get(spell_name, {})
    rank = meta.get('rank')
    board = meta.get('board')
    for t in tiers_data:
        if spell_name in t.get('spells', []):
            return t['key'], t['name'], rank, board
    return '?', 'Official', rank, board

def get_synergies(spell_name):
    # From CHARTS['synergies']
    results = []
    for a, b, level in CHARTS.get('synergies', []):
        other = b if a == spell_name else (a if b == spell_name else None)
        if other and other in SPELLS_DATA:
            results.append((other, level))
    # Sort: strong positive (2), positive (1), neutral (0), anti (-1), strong anti (-2)
    results.sort(key=lambda x: -x[1])
    return results

def get_matchups(spell_name):
    # From CHARTS['matchups']: [favoured, other, level] or [a, b, 0]
    favoured = []
    even = []
    unfavoured = []
    for entry in CHARTS.get('matchups', []):
        if len(entry) == 3:
            f, o, lvl = entry
            if lvl == 0:
                if f == spell_name and o in SPELLS_DATA: even.append((o, 0))
                elif o == spell_name and f in SPELLS_DATA: even.append((f, 0))
            else:
                if f == spell_name and o in SPELLS_DATA: favoured.append((o, lvl))
                elif o == spell_name and f in SPELLS_DATA: unfavoured.append((f, lvl))
    favoured.sort(key=lambda x: -x[1])
    unfavoured.sort(key=lambda x: -x[1])
    return favoured, even, unfavoured

def html_header(title, depth=1):
    prefix = '../' * depth
    return f"""<!DOCTYPE html>
<html class="height:100%" lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="{prefix}static/css/global.css?v202305191" rel="stylesheet" />
	<link href="{prefix}static/css/layout.css" rel="stylesheet" />
	<link href="{prefix}static/css/styles.css" rel="stylesheet" />
	<link href="{prefix}static/css/compendium.css" rel="stylesheet" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
	<link href="https://fonts.googleapis.com/css2?family=Arvo&family=Overlock&display=swap" rel="stylesheet" />
	<link href="https://use.typekit.net/rot4udi.css" rel="stylesheet" />
	<script src="{prefix}static/scripts/theme-manager.js"></script>
	<title>{title} - Sigil Online</title>
</head>
<body>
	<header>
		<div class="container">
			<div class="header-container">
				<div>
					<h1 class="logo"><a href="{prefix}"><span class="visually-hidden">Sigil Online</span><img alt="" src="{prefix}static/images/logo-icon.svg" height="40" width="32" /></a></h1>
				</div>
				<h1></h1>
				<div id="auth-status"></div>
			</div>
		</div>
	</header>
	<div class="main">
"""

def html_footer(depth=1):
    prefix = '../' * depth
    return f"""
	</div>
	<!-- Firebase SDK + auth status -->
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
	<script>
		firebase.initializeApp({{
			apiKey: "AIzaSyDcYsA9GxotScZ6m92B_TDSArkeN1qMHvE",
			authDomain: "sigil-js.firebaseapp.com",
			databaseURL: "https://sigil-js-default-rtdb.firebaseio.com",
			projectId: "sigil-js",
			storageBucket: "sigil-js.firebasestorage.app",
			messagingSenderId: "174679859896",
			appId: "1:174679859896:web:9f8e5ddc4388ae73a60a4d"
		}});
	</script>
	<script src="{prefix}static/scripts/auth-status.js"></script>
</body>
</html>
"""

def generate_spell_page(spell_name, all_spell_names):
    info = SPELLS_DATA[spell_name]
    pack = SPELL_TO_PACK[spell_name]
    slug = slugify(spell_name)
    disp = pretty(spell_name)
    tier_key, tier_name, rank, board = get_tier_info(spell_name)
    
    idx = all_spell_names.index(spell_name)
    prev_spell = all_spell_names[(idx - 1) % len(all_spell_names)]
    next_spell = all_spell_names[(idx + 1) % len(all_spell_names)]
    
    synergies = get_synergies(spell_name)
    favoured, even, unfavoured = get_matchups(spell_name)
    
    board_desc = {
        'empty': 'Better on an emptier board',
        'crowded': 'Better on a crowded board',
    }.get(board, 'Flexible across board states')
    
    tier_badge_class = f"badge-tier-{tier_key.lower()}" if tier_key in ['S', 'A', 'B', 'C', 'D', 'F'] else "badge-tier-unranked"
    type_badge_class = f"badge-{info['type']}"
    glow_class = f"{info['type']}-glow"
    
    # Siblings in the same pack
    sibling_names = [s for s in (pack['rituals'] + pack['sorceries'] + pack['charms']) if s != spell_name]
    
    html = html_header(f"{disp} ({pack['name']} {info['type'].capitalize()})", depth=1)
    html += f"""
		<div class="compendium-container">
			<nav class="breadcrumb-nav" aria-label="Breadcrumb">
				<a href="../">Home</a>
				<span class="breadcrumb-separator">/</span>
				<a href="./">Spells</a>
				<span class="breadcrumb-separator">/</span>
				<a href="../packs/{pack['slug']}.html">{pack['name']} Pack</a>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-current">{disp}</span>
			</nav>

			<div class="quick-nav-bar">
				<div class="quick-nav-links">
					<a class="quick-nav-link" href="{slugify(prev_spell)}.html">&larr; {pretty(prev_spell)}</a>
					<a class="quick-nav-link" href="{slugify(next_spell)}.html">{pretty(next_spell)} &rarr;</a>
				</div>
				<div class="quick-nav-links">
					<a class="quick-nav-link" href="../packs/{pack['slug']}.html">View {pack['name']} Pack</a>
					<a class="quick-nav-link" href="../spells.html">Interactive Tier List &amp; Matrix</a>
				</div>
			</div>

			<div class="spell-showcase">
				<div class="card-column">
					<div class="spell-card-frame {glow_class}">
						<img id="card-image" class="spell-card-img" src="../static/images/spells/{spell_name}.webp" alt="{disp} Spell Card" />
					</div>
					<button class="art-toggle-btn" id="art-toggle" onclick="toggleArt()">View Card Art Only</button>
					<script>
						let artOnly = false;
						function toggleArt() {{
							artOnly = !artOnly;
							const img = document.getElementById('card-image');
							const btn = document.getElementById('art-toggle');
							img.src = artOnly ? '../static/images/spells/art_only/{spell_name}.webp' : '../static/images/spells/{spell_name}.webp';
							btn.textContent = artOnly ? 'View Full Spell Card' : 'View Card Art Only';
						}}
					</script>
					<div class="badge-row">
						<span class="badge {type_badge_class}">{info['type'].capitalize()} ({info['nodes']} Node{'s' if info['nodes'] > 1 else ''})</span>
						{'<span class="badge badge-static">Static Seal</span>' if info['static'] else '<span class="badge">Action Spell</span>'}
						<a class="badge {tier_badge_class}" href="../spells.html#tiers">Tier {tier_key} ({tier_name}){' · #' + str(rank) if rank else ''}</a>
					</div>
				</div>

				<div class="details-column">
					<div class="page-header" style="text-align:left; margin-bottom:12px;">
						<h1 class="page-title">{disp}</h1>
						<div class="page-subtitle">From the <a style="color:var(--color-accent); text-decoration:none;" href="../packs/{pack['slug']}.html"><strong>{pack['name']}</strong> Pack</a>{' (' + info.get('subpack', '') + ')' if info.get('subpack') else ''}</div>
					</div>

					<div class="card-text-box">
						{info['text']}
					</div>

					<div class="stats-grid">
						<div class="stat-card">
							<div class="stat-label">Sigil Size</div>
							<div class="stat-value">{info['nodes']} Node{'s' if info['nodes'] > 1 else ''}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">Spell Category</div>
							<div class="stat-value">{info['type'].capitalize()}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">Activation</div>
							<div class="stat-value">{'Static Seal' if info['static'] else 'Instant Action'}</div>
						</div>
						<div class="stat-card">
							<div class="stat-label">Board State</div>
							<div class="stat-value" style="font-size:0.95em;">{board_desc}</div>
						</div>
					</div>

					<div class="content-section">
						<h3>Rules &amp; Kernel Mechanics</h3>
						<p>{info['mechanics']}</p>
					</div>

					<div class="content-section">
						<h3>Tactical Strategy &amp; Play Advice</h3>
						<p>{info['strategy']}</p>
					</div>
				</div>
			</div>
    """

    # Synergies Section
    if synergies:
        html += """
			<section class="content-section" style="margin-bottom:28px;">
				<h3>Synergies &amp; Combos</h3>
				<p>Holding both spells enables powerful combinational tactics. The rated synergies below are judged from competitive play:</p>
				<div class="chips-grid">
        """
        for other_name, lvl in synergies[:8]:
            tag_class = 'tag-strong-synergy' if lvl == 2 else ('tag-synergy' if lvl == 1 else ('tag-even' if lvl == 0 else ('tag-anti-synergy' if lvl == -1 else 'tag-strong-anti')))
            tag_text = '++ Strong Synergy' if lvl == 2 else ('+ Synergy' if lvl == 1 else ('Neutral' if lvl == 0 else ('- Anti-Synergy' if lvl == -1 else '-- Strong Anti')))
            html += f"""
					<a class="relation-card" href="{slugify(other_name)}.html">
						<img class="relation-thumb" src="../static/images/spells/art_only/{other_name}.webp" alt="{pretty(other_name)}" loading="lazy" />
						<div class="relation-info">
							<div class="relation-name">{pretty(other_name)}</div>
							<span class="relation-tag {tag_class}">{tag_text}</span>
						</div>
					</a>
            """
        html += """
				</div>
			</section>
        """

    # Matchups Section
    if favoured or unfavoured or even:
        html += """
			<section class="content-section" style="margin-bottom:28px;">
				<h3>Head-to-Head Matchups</h3>
				<p>How this spell contends when you build toward it against an opponent developing a rival spell:</p>
				<div class="chips-grid">
        """
        for o, lvl in favoured[:4]:
            t_text = '++ Strongly Favoured' if lvl == 2 else '+ Favoured'
            html += f"""
					<a class="relation-card" href="{slugify(o)}.html">
						<img class="relation-thumb" src="../static/images/spells/art_only/{o}.webp" alt="{pretty(o)}" loading="lazy" />
						<div class="relation-info">
							<div class="relation-name">vs {pretty(o)}</div>
							<span class="relation-tag tag-favoured">{t_text}</span>
						</div>
					</a>
            """
        for o, _ in even[:2]:
            html += f"""
					<a class="relation-card" href="{slugify(o)}.html">
						<img class="relation-thumb" src="../static/images/spells/art_only/{o}.webp" alt="{pretty(o)}" loading="lazy" />
						<div class="relation-info">
							<div class="relation-name">vs {pretty(o)}</div>
							<span class="relation-tag tag-even">= Even Matchup</span>
						</div>
					</a>
            """
        for o, lvl in unfavoured[:4]:
            t_text = '-- Countered By' if lvl == 2 else '- Unfavoured'
            html += f"""
					<a class="relation-card" href="{slugify(o)}.html">
						<img class="relation-thumb" src="../static/images/spells/art_only/{o}.webp" alt="{pretty(o)}" loading="lazy" />
						<div class="relation-info">
							<div class="relation-name">vs {pretty(o)}</div>
							<span class="relation-tag tag-unfavoured">{t_text}</span>
						</div>
					</a>
            """
        html += """
				</div>
			</section>
        """

    # Pack Siblings Section
    if sibling_names:
        html += f"""
			<section class="content-section" style="margin-bottom:28px;">
				<h3>Other Spells in the {pack['name']} Pack</h3>
				<div class="chips-grid">
        """
        for sib in sibling_names:
            s_info = SPELLS_DATA[sib]
            html += f"""
					<a class="relation-card" href="{slugify(sib)}.html">
						<img class="relation-thumb" src="../static/images/spells/art_only/{sib}.webp" alt="{pretty(sib)}" loading="lazy" />
						<div class="relation-info">
							<div class="relation-name">{pretty(sib)}</div>
							<span class="relation-tag tag-even">{s_info['type'].capitalize()} ({s_info['nodes']}n)</span>
						</div>
					</a>
            """
        html += f"""
				</div>
			</section>
        """

    html += f"""
			<div style="text-align:center; margin-top:32px;">
				<a class="view-spell-btn" href="../packs/{pack['slug']}.html">&larr; Explore All {pack['name']} Spells</a>
				<span style="display:inline-block; width:12px;"></span>
				<a class="view-spell-btn" href="./">Browse Spells Directory &rarr;</a>
			</div>
		</div>
    """
    html += html_footer(depth=1)
    return html

def generate_pack_page(pack):
    all_spells = pack['rituals'] + pack['sorceries'] + pack['charms']
    html = html_header(f"{pack['name']} Pack", depth=1)
    
    html += f"""
		<div class="compendium-container">
			<nav class="breadcrumb-nav" aria-label="Breadcrumb">
				<a href="../">Home</a>
				<span class="breadcrumb-separator">/</span>
				<a href="./">Packs</a>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-current">{pack['name']}</span>
			</nav>

			<div class="page-header">
				<h1 class="page-title">{pack['name']} Pack</h1>
				<p class="page-subtitle">{pack['tagline']}</p>
				<div class="badge-row">
					<span class="badge badge-static">Official Expansion</span>
					<span class="badge badge-charm">Rated in Competitive Play</span>
					<span class="badge">{len(all_spells)} Spells</span>
				</div>
			</div>

			<div class="content-section" style="margin-bottom:32px;">
				<h3>Pack Overview &amp; Identity</h3>
				<p>{pack['description']}</p>
			</div>
    """

    # If Core, also render subpacks
    if pack.get('subpacks'):
        html += """
			<h2 style="font-family:'Arvo',serif; color:var(--color-text-warm); margin:36px 0 16px;">Core Sub-Packs</h2>
			<p style="color:var(--color-text-muted); margin-bottom:20px;">Core is divided into five balanced trios (one ritual, one sorcery, one charm), allowing modular drafting in custom matches:</p>
			<div class="chips-grid" style="margin-bottom:36px;">
        """
        for sp in pack['subpacks']:
            html += f"""
				<div class="content-section" style="padding:14px;">
					<h4 style="font-family:'Arvo',serif; color:var(--color-accent); margin:0 0 6px;">{sp['name']} Trio</h4>
					<div style="font-size:0.9em; color:var(--color-text-light); margin-bottom:8px;">
						Ritual: <a href="../spells/{slugify(sp['rituals'][0])}.html" style="color:var(--color-text-warm);">{pretty(sp['rituals'][0])}</a><br/>
						Sorcery: <a href="../spells/{slugify(sp['sorceries'][0])}.html" style="color:var(--color-text-warm);">{pretty(sp['sorceries'][0])}</a><br/>
						Charm: <a href="../spells/{slugify(sp['charms'][0])}.html" style="color:var(--color-text-warm);">{pretty(sp['charms'][0])}</a>
					</div>
				</div>
            """
        html += """
			</div>
			<h2 style="font-family:'Arvo',serif; color:var(--color-text-warm); margin:36px 0 16px;">All Core Spells</h2>
        """
    else:
        html += f"""
			<h2 style="font-family:'Arvo',serif; color:var(--color-text-warm); margin:36px 0 16px;">Spells in the {pack['name']} Pack</h2>
        """

    # Spells cards
    html += '<div class="pack-spells-container">'
    for s_name in all_spells:
        s_info = SPELLS_DATA[s_name]
        s_slug = slugify(s_name)
        s_disp = pretty(s_name)
        t_key, t_name, rank, _ = get_tier_info(s_name)
        t_badge = f'<span class="badge badge-tier-{t_key.lower()}">Tier {t_key}</span>' if t_key in ['S','A','B','C','D','F'] else ''
        
        html += f"""
			<div class="pack-spell-detail-card">
				<img src="../static/images/spells/{s_name}.webp" alt="{s_disp}" loading="lazy" />
				<h3>{s_disp}</h3>
				<div class="badge-row" style="margin-bottom:8px;">
					<span class="badge badge-{s_info['type']}">{s_info['type'].capitalize()} ({s_info['nodes']}n)</span>
					{'<span class="badge badge-static">Static</span>' if s_info['static'] else ''}
					{t_badge}
				</div>
				<div class="spell-text">"{s_info['text']}"</div>
				<a class="view-spell-btn" href="../spells/{s_slug}.html">View Spell Details &rarr;</a>
			</div>
        """
    html += '</div>'

    html += f"""
			<div style="text-align:center; margin-top:40px;">
				<a class="view-spell-btn" href="./">&larr; Browse All Spell Packs</a>
				<span style="display:inline-block; width:12px;"></span>
				<a class="view-spell-btn" href="../spells.html">Interactive Spell Charts &rarr;</a>
			</div>
		</div>
    """
    html += html_footer(depth=1)
    return html

def generate_spells_index(all_spell_names):
    html = html_header("Spells Directory", depth=1)
    html += """
		<div class="compendium-container">
			<nav class="breadcrumb-nav" aria-label="Breadcrumb">
				<a href="../">Home</a>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-current">Spells</span>
			</nav>

			<div class="page-header">
				<h1 class="page-title">Spells Directory</h1>
				<p class="page-subtitle">Every official spell in Sigil: rules, mechanics, strategic tier rankings, synergies, and head-to-head matchups.</p>
				<div class="badge-row">
					<span class="badge badge-charm">45 Official Spells</span>
					<a class="badge badge-static" href="../packs/">11 Official Packs</a>
					<a class="badge" href="../spells.html">Interactive Tier List &amp; Matrix &rarr;</a>
				</div>
			</div>

			<div class="filter-bar">
				<div class="filter-group">
					<label for="search-input">Search:</label>
					<input class="search-input" id="search-input" type="text" placeholder="Filter by name or effect…" oninput="filterSpells()" />
				</div>
				<div class="filter-group">
					<label for="type-select">Type:</label>
					<select class="filter-select" id="type-select" onchange="filterSpells()">
						<option value="all">All Types</option>
						<option value="ritual">Ritual (5 Nodes)</option>
						<option value="sorcery">Sorcery (3 Nodes)</option>
						<option value="charm">Charm (1 Node)</option>
					</select>
				</div>
				<div class="filter-group">
					<label for="pack-select">Pack:</label>
					<select class="filter-select" id="pack-select" onchange="filterSpells()">
						<option value="all">All Packs</option>
    """
    for p in PACKS:
        html += f'<option value="{p["slug"]}">{p["name"]}</option>\n'
    html += """
					</select>
				</div>
			</div>

			<div class="spells-grid" id="spells-grid">
    """
    for s_name in all_spell_names:
        s_info = SPELLS_DATA[s_name]
        pack = SPELL_TO_PACK[s_name]
        s_slug = slugify(s_name)
        s_disp = pretty(s_name)
        t_key, t_name, _, _ = get_tier_info(s_name)
        t_badge = f'<span class="badge badge-tier-{t_key.lower()}">Tier {t_key}</span>' if t_key in ['S','A','B','C','D','F'] else ''
        
        html += f"""
				<a class="spell-grid-item" href="{s_slug}.html" data-name="{s_disp.lower()}" data-pack="{pack['slug']}" data-type="{s_info['type']}" data-text="{s_info['text'].lower()}">
					<img class="spell-grid-thumb" src="../static/images/spells/art_only/{s_name}.webp" alt="{s_disp}" loading="lazy" />
					<div class="spell-grid-body">
						<div>
							<div class="spell-grid-title">{s_disp}</div>
							<div class="spell-grid-meta">{pack['name']} · {s_info['type'].capitalize()}</div>
						</div>
						<div class="spell-grid-badges">
							<span class="badge badge-{s_info['type']}">{s_info['nodes']}n</span>
							{'<span class="badge badge-static">Static</span>' if s_info['static'] else ''}
							{t_badge}
						</div>
					</div>
				</a>
        """
    html += """
			</div>

			<script>
				function filterSpells() {
					const query = document.getElementById('search-input').value.toLowerCase().trim();
					const type = document.getElementById('type-select').value;
					const pack = document.getElementById('pack-select').value;
					const items = document.querySelectorAll('.spell-grid-item');
					
					items.forEach(el => {
						const name = el.dataset.name;
						const p = el.dataset.pack;
						const t = el.dataset.type;
						const text = el.dataset.text;
						
						const matchesQuery = !query || name.includes(query) || text.includes(query);
						const matchesType = (type === 'all') || (t === type);
						const matchesPack = (pack === 'all') || (p === pack);
						
						el.style.display = (matchesQuery && matchesType && matchesPack) ? 'flex' : 'none';
					});
				}
			</script>
		</div>
    """
    html += html_footer(depth=1)
    return html

def generate_packs_index():
    html = html_header("Spell Packs Directory", depth=1)
    html += """
		<div class="compendium-container">
			<nav class="breadcrumb-nav" aria-label="Breadcrumb">
				<a href="../">Home</a>
				<span class="breadcrumb-separator">/</span>
				<span class="breadcrumb-current">Spell Packs</span>
			</nav>

			<div class="page-header">
				<h1 class="page-title">Spell Packs</h1>
				<p class="page-subtitle">The 11 official expansions and Core sets available in Sigil Online.</p>
				<div class="badge-row">
					<span class="badge badge-static">11 Official Packs</span>
					<a class="badge badge-charm" href="../spells/">45 Official Spells &rarr;</a>
					<a class="badge" href="../spells.html">Interactive Tier List &amp; Matrix &rarr;</a>
				</div>
			</div>

			<div class="pack-grid">
    """
    for p in PACKS:
        spells = p['rituals'] + p['sorceries'] + p['charms']
        html += f"""
				<a class="pack-card" href="{p['slug']}.html">
					<div>
						<div class="pack-card-header">
							<h2 class="pack-card-title">{p['name']}</h2>
							<span class="badge">{len(spells)} Spells</span>
						</div>
						<p style="font-size:0.95em; color:var(--color-text-muted); margin:0 0 14px; line-height:1.45;">
							{p['tagline']}
						</p>
						<div class="pack-spell-row">
        """
        for s in spells[:3]:
            html += f"""
							<div class="pack-spell-pill">
								<img src="../static/images/spells/art_only/{s}.webp" alt="{pretty(s)}" />
								<span>{pretty(s)}</span>
							</div>
            """
        html += f"""
						</div>
					</div>
					<div style="font-size:0.9em; color:var(--color-accent); font-weight:700; margin-top:12px;">
						Explore {p['name']} Pack &rarr;
					</div>
				</a>
        """
    html += """
			</div>
		</div>
    """
    html += html_footer(depth=1)
    return html

def main():
    os.makedirs(SPELLS_DIR, exist_ok=True)
    os.makedirs(PACKS_DIR, exist_ok=True)
    
    all_spells = []
    for p in PACKS:
        all_spells.extend(p['rituals'] + p['sorceries'] + p['charms'])
    
    print(f"Generating {len(all_spells)} official spell pages...")
    for s_name in all_spells:
        slug = slugify(s_name)
        page_html = generate_spell_page(s_name, all_spells)
        out_path = os.path.join(SPELLS_DIR, f"{slug}.html")
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(page_html)
        
        # Also create symlink or alias for exact spell name if different from slug
        if s_name != slug:
            exact_path = os.path.join(SPELLS_DIR, f"{s_name}.html")
            try:
                if os.path.exists(exact_path) or os.path.islink(exact_path):
                    os.unlink(exact_path)
                os.symlink(f"{slug}.html", exact_path)
            except Exception:
                with open(exact_path, 'w', encoding='utf-8') as f:
                    f.write(page_html)

    # Spells directory index
    spells_index_html = generate_spells_index(all_spells)
    with open(os.path.join(SPELLS_DIR, "index.html"), 'w', encoding='utf-8') as f:
        f.write(spells_index_html)

    print(f"Generating {len(PACKS)} official pack pages...")
    for p in PACKS:
        pack_html = generate_pack_page(p)
        out_path = os.path.join(PACKS_DIR, f"{p['slug']}.html")
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(pack_html)
            
        # If pack slug != pack key (e.g. inferno != fury), create alias
        if p['slug'] != p['key']:
            key_path = os.path.join(PACKS_DIR, f"{p['key']}.html")
            try:
                if os.path.exists(key_path) or os.path.islink(key_path):
                    os.unlink(key_path)
                os.symlink(f"{p['slug']}.html", key_path)
            except Exception:
                with open(key_path, 'w', encoding='utf-8') as f:
                    f.write(pack_html)

        # If pack has subpacks (e.g. Core subpacks), create subpack pages too
        if p.get('subpacks'):
            for sp in p['subpacks']:
                sp_pack = {
                    'key': sp['key'],
                    'name': f"Core: {sp['name']}",
                    'slug': sp['slug'],
                    'tagline': f"The {sp['name']} trio from the Core spell set.",
                    'description': f"A balanced three-spell trio from the Core set featuring {pretty(sp['rituals'][0])} (Ritual), {pretty(sp['sorceries'][0])} (Sorcery), and {pretty(sp['charms'][0])} (Charm).",
                    'rituals': sp['rituals'],
                    'sorceries': sp['sorceries'],
                    'charms': sp['charms'],
                }
                sp_html = generate_pack_page(sp_pack)
                sp_path = os.path.join(PACKS_DIR, f"{sp['slug']}.html")
                with open(sp_path, 'w', encoding='utf-8') as f:
                    f.write(sp_html)
                if sp['slug'] == 'crater':
                    legacy_impact = os.path.join(PACKS_DIR, "impact.html")
                    try:
                        if os.path.exists(legacy_impact) or os.path.islink(legacy_impact):
                            os.unlink(legacy_impact)
                        os.symlink("crater.html", legacy_impact)
                    except Exception:
                        with open(legacy_impact, 'w', encoding='utf-8') as f:
                            f.write(sp_html)

    # Packs directory index
    packs_index_html = generate_packs_index()
    with open(os.path.join(PACKS_DIR, "index.html"), 'w', encoding='utf-8') as f:
        f.write(packs_index_html)

    print("Spell and pack page generation completed successfully.")

if __name__ == '__main__':
    main()
