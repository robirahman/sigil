// Sentinel stored in board.stones[node] when a node has been permanently
// destroyed by Fissure (a wall): not null, not 'red'/'blue'. Impassable to
// moves and push chains; a spell whose position includes it can never charge.
const DESTROYED = 'X';

// Canonical node order for SFN strings (39 nodes)
const NODE_ORDER = [];
for (const zone of ['a', 'b', 'c']) {
	for (let num = 1; num <= 13; num++) {
		NODE_ORDER.push(zone + num);
	}
}

// Spell position mapping: position_index -> [node_names]
const POSITIONS = {
	1: ['a2', 'a3', 'a4', 'a5', 'a6'],
	2: ['b2', 'b3', 'b4', 'b5', 'b6'],
	3: ['c2', 'c3', 'c4', 'c5', 'c6'],
	4: ['a8', 'a9', 'a10'],
	5: ['b8', 'b9', 'b10'],
	6: ['c8', 'c9', 'c10'],
	7: ['a7'],
	8: ['b7'],
	9: ['c7'],
};

const ADJACENCY = {
	a1: ['a2', 'a11'], a2: ['a1', 'a3', 'a6'], a3: ['a2', 'a4', 'a13'],
	a4: ['a3', 'a5', 'a7'], a5: ['a4', 'a6', 'a12'], a6: ['a2', 'a5', 'a11'],
	a7: ['a4', 'a8', 'b12'], a8: ['a7', 'a9', 'a10'], a9: ['a8', 'a10', 'a13'],
	a10: ['a8', 'a9', 'b11'], a11: ['a1', 'a6', 'c10'], a12: ['a5', 'c7'],
	a13: ['a3', 'a9'],
	b1: ['b2', 'b11'], b2: ['b1', 'b3', 'b6'], b3: ['b2', 'b4', 'b13'],
	b4: ['b3', 'b5', 'b7'], b5: ['b4', 'b6', 'b12'], b6: ['b2', 'b5', 'b11'],
	b7: ['b4', 'b8', 'c12'], b8: ['b7', 'b9', 'b10'], b9: ['b8', 'b10', 'b13'],
	b10: ['b8', 'b9', 'c11'], b11: ['a10', 'b1', 'b6'], b12: ['a7', 'b5'],
	b13: ['b3', 'b9'],
	c1: ['c2', 'c11'], c2: ['c1', 'c3', 'c6'], c3: ['c2', 'c4', 'c13'],
	c4: ['c3', 'c5', 'c7'], c5: ['c4', 'c6', 'c12'], c6: ['c2', 'c5', 'c11'],
	c7: ['a12', 'c4', 'c8'], c8: ['c7', 'c9', 'c10'], c9: ['c8', 'c10', 'c13'],
	c10: ['a11', 'c8', 'c9'], c11: ['b10', 'c1', 'c6'], c12: ['b7', 'c5'],
	c13: ['c3', 'c9'],
};

const MANA_NODES = ['a1', 'b1', 'c1'];

// Nodes that sit on a spell sigil (positions 1..9). Seal of Autumn forbids the
// opponent from sacrificing any of these to pay for a dash.
const SPELL_NODES = new Set();
for (let _spellPos = 1; _spellPos <= 9; _spellPos++) {
	for (const _spellNode of POSITIONS[_spellPos]) SPELL_NODES.add(_spellNode);
}
function isSpellNode(name) {
	return SPELL_NODES.has(name);
}

// Nodes on no spell sigil and not mana nodes: a11-13, b11-13, c11-13.
// A stone parked here charges nothing and holds no mana ("void" nodes).
// Mirrors ai/minimax_ai.py _VOID_NODES.
const VOID_NODES = NODE_ORDER.filter(
	n => !SPELL_NODES.has(n) && !MANA_NODES.includes(n));

// Nodes that sit on a 3-node (sorcery) or 5-node (ritual) sigil — positions 1..6.
// Lurk (Gloom charm) may move onto any node EXCEPT these; 1-node spells (charms)
// and non-spell nodes remain valid targets.
const BIG_SPELL_NODES = new Set();
for (let _bigPos = 1; _bigPos <= 6; _bigPos++) {
	for (const _bigNode of POSITIONS[_bigPos]) BIG_SPELL_NODES.add(_bigNode);
}
function isBigSpellNode(name) {
	return BIG_SPELL_NODES.has(name);
}

// Core spells metadata
const CORE_SPELLS = {
	Flourish:          { resolve: 'soft_moves', count: 4, static: false, ischarm: false },
	Carnage:           { resolve: 'hard_moves', count: 4, static: false, ischarm: false },
	Bewitch:           { resolve: 'bewitch',    static: false, ischarm: false },
	Starfall:          { resolve: 'starfall',   static: false, ischarm: false },
	Seal_of_Lightning: { resolve: null,         static: true,  ischarm: false },
	Grow:              { resolve: 'soft_moves', count: 2, static: false, ischarm: false },
	Fireblast:         { resolve: 'fireblast',  static: false, ischarm: false },
	Hail_Storm:        { resolve: 'hail_storm', static: false, ischarm: false },
	Meteor:            { resolve: 'meteor',     static: false, ischarm: false },
	Seal_of_Wind:      { resolve: null,         static: true,  ischarm: false },
	Sprout:            { resolve: 'soft_moves', count: 1, static: false, ischarm: true },
	Slash:             { resolve: 'hard_moves', count: 1, static: false, ischarm: true },
	Surge:             { resolve: 'surge_move', static: false, ischarm: true },
	Comet:             { resolve: 'comet',      static: false, ischarm: true },
	Seal_of_Summer:    { resolve: null,         static: true,  ischarm: true },
	// Springtime expansion
	Seal_of_Spring:    { resolve: null,         static: true,  ischarm: true },
	Scatter:           { resolve: 'scatter',    static: false, ischarm: false },
	Blossom:           { resolve: 'blossom',    static: false, ischarm: false },
	// Celestial expansion
	Azimuth:           { resolve: 'azimuth',    static: false, ischarm: true },
	Eclipse:           { resolve: 'eclipse',    static: false, ischarm: false },
	Syzygy:            { resolve: 'syzygy',     static: false, ischarm: false },
	// Inferno expansion
	Charge:            { resolve: 'charge',     static: false, ischarm: true  },
	Fury:              { resolve: 'fury',       static: false, ischarm: false },
	Erupt:             { resolve: 'erupt',      static: false, ischarm: false },
	// Tempest expansion
	Gust:              { resolve: 'gust',       static: false, ischarm: true },
	Storm_Front:       { resolve: 'storm_front', static: false, ischarm: false },
	Hurricane:         { resolve: 'hurricane',  static: false, ischarm: false },
	// Flood expansion
	Splash:              { resolve: 'surge_move', static: false, ischarm: true },
	Torrent:           { resolve: 'soft_hard_chain', counts: [1, 1], static: false, ischarm: false },
	Tsunami:           { resolve: 'soft_hard_chain', counts: [2, 2], static: false, ischarm: false },
	// Panda expansion
	Bear_Trap:         { resolve: 'bear_trap',       static: false, ischarm: true },
	Shiver:            { resolve: 'shiver',          static: false, ischarm: true },
	Blood_Saplings:    { resolve: 'blood_saplings', count: 2, static: false, ischarm: true },
	Itch:              { resolve: 'itch',            static: false, ischarm: true },
	Free_Spirit:       { resolve: 'free_spirit', count: 1, static: false, ischarm: true },
	Residue_Mixture:   { resolve: 'residue_mixture', static: false, ischarm: true },
	Stampede:          { resolve: 'stampede',        static: false, ischarm: false },
	Choke:             { resolve: 'choke',           static: false, ischarm: false },
	Perfect_Heist:     { resolve: 'perfect_heist',   static: false, ischarm: false },
	Moth_Plague:       { resolve: 'moth_plague', count: 3, static: false, ischarm: false },
	Ripples:           { resolve: 'ripples',         static: false, ischarm: false },
	Lifesap:           { resolve: null,              static: true,  ischarm: false },
	// Autumn expansion
	Seal_of_Autumn:    { resolve: null,              static: true,  ischarm: true },
	Gather:            { resolve: 'locked_or_self_moves', count: 3, static: false, ischarm: false },
	Harvest:           { resolve: 'locked_or_self_moves', count: 5, static: false, ischarm: false },
	// Gloom expansion
	Lurk:              { resolve: 'restricted_move',         static: false, ischarm: true },
	Decay:             { resolve: 'destroy_exposed',         static: false, ischarm: false },
	Corrupt:           { resolve: 'corrupt',        static: false, ischarm: false },
	// Covenant expansion (static seals)
	Seal_of_Winter:    { resolve: null, static: true, ischarm: true },
	Seal_of_Stone:     { resolve: null, static: true, ischarm: false },
	Seal_of_Destruction: { resolve: null, static: true, ischarm: false },
	// Tectonic expansion
	Fissure:           { resolve: 'fissure',         static: false, ischarm: false },
	Rock_Slide:        { resolve: 'rock_slide',      static: false, ischarm: false },
	Bulwark:           { resolve: null,              static: true,  ischarm: true },
	// Providence expansion (scheduled extra moves)
	Dividend:          { resolve: 'schedule_moves', turns: 1, static: false, ischarm: true },
	Annuity:           { resolve: 'schedule_moves', turns: 2, static: false, ischarm: false },
	Endowment:         { resolve: 'schedule_moves', turns: 4, static: false, ischarm: false },
	// Experimental expansion (unofficial, unrated: unreleased spells under
	// playtest). Spring Tide rides the Flood soft_hard_chain resolver with
	// `hard_first` (pushes before placements) and an optional trailing
	// `sacrifice` count; Torrent/Tsunami leave both unset.
	Spring_Tide:       { resolve: 'soft_hard_chain', counts: [2, 2], hard_first: true, sacrifice: 2, static: false, ischarm: false },
	// Rapids: Torrent's chain, plus `extra_cast` — the cast reopens the turn's
	// spell window once (one more cast, no dash), the way Seal of Summer's
	// second cast works. Consumed by the turn drivers, not the resolver.
	Rapids:            { resolve: 'soft_hard_chain', counts: [1, 1], extra_cast: true, static: false, ischarm: false },
};

const SPELL_TEXTS = {
	Flourish:          'Make 4 soft moves.',
	Carnage:           'Make 4 hard moves.',
	Bewitch:           'Choose 2 enemy stones touching each other. Convert them to your color.',
	Starfall:          'Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them.',
	Seal_of_Lightning: 'STATIC: Your dash only requires 1 sacrifice.',
	Grow:              'Make 2 soft moves.',
	Fireblast:         'Destroy all enemy stones which are touching you, then sacrifice a stone.',
	Hail_Storm:        'Destroy 1 enemy stone in each 3-node and 5-node spell.',
	Meteor:            'Make 1 blink move, then destroy 1 enemy stone touching it.',
	Seal_of_Wind:      'STATIC: Your first move each turn is a blink move.',
	Sprout:            'Make 1 soft move.',
	Slash:             'Make 1 hard move.',
	Surge:             'If you dashed this turn, make 1 move.',
	Comet:             'Make 1 blink move, then sacrifice a stone.',
	Seal_of_Summer:    'STATIC: You may cast 2 spells on your turn.',
	Seal_of_Spring:    'STATIC: You may cast your locked spells a second time.',
	Scatter:           'Make 1 soft blink move into each of 2 spells.',
	Blossom:           'Make 1 soft blink move into each other 3-node and 5-node spell.',
	Azimuth:           'Make 1 move into a spell where you control all but 1 node.',
	Eclipse:           'Make 2 moves into a spell where you control all but 2 nodes.',
	Syzygy:            'Make 1 blink move into the 1-node spell opposite Syzygy, then 3 into the 3-node spell.',
	Charge:            'Make 1 move into a 3- or 5-node spell.',
	Fury:              'Sacrifice 1 stone, then make 3 hard moves.',
	Erupt:             'Make 2 moves into every spell, except Erupt, in which you have a stone.',
	Gust:              'Pick up every enemy stone touching one of your stones, then place them on any empty nodes.',
	Storm_Front:       'Destroy any 2 enemy stones of your choice.',
	Hurricane:         'Destroy the smallest contiguous group of enemy stones. If tied, you choose which.',
	Splash:              'If you did not dash this turn, make 1 move.',
	Torrent:           'Make 1 soft move, then 1 hard move.',
	Tsunami:           'Make 2 soft moves, then 2 hard moves.',
	Bear_Trap:         'Destroy all enemy stones in 1-node spells.',
	Shiver:            'Swap the positions of any two stones on the board.',
	Blood_Saplings:    'If you crushed an enemy stone this turn, make 2 soft moves.',
	Itch:              'Make 1 move, then advance the enemy lock by 1. (Scramble: reduce it by 1 instead.)',
	Free_Spirit:       'If your lock is 0 or 1, make 1 soft move.',
	Residue_Mixture:   'If your lock is higher than the enemy lock, convert 1 enemy stone to your color and advance the enemy lock by 1. (Scramble: reduce it by 1 instead.)',
	Stampede:          'Make hard moves equal to your lock value (0–5).',
	Choke:             'Choose an enemy stone; place your stones on all of its empty adjacent nodes.',
	Perfect_Heist:     'Destroy every stone on the mana nodes, then occupy all three.',
	Moth_Plague:       'Make 3 hard blink moves (push any enemy stone, no adjacency required).',
	Ripples:           'Choose two charged 1-node spells in play and apply each of their effects twice.',
	Lifesap:           'STATIC: You refill 2 stones when you cast a 5-node spell (ritual).',
	Seal_of_Autumn:    'STATIC: Opponent cannot sacrifice stones in spells to dash.',
	Gather:            'Make 3 moves into your locked spell or into Gather.',
	Harvest:           'Make 5 moves into your locked spell or into Harvest.',
	Lurk:              'Make 1 move into a 1-node spell or a node outside of a spell.',
	Decay:             'Destroy all enemy stones touching 2 or more empty nodes.',
	Corrupt:           'Choose up to 3 enemy stones touching your stones. Convert them to your color, then sacrifice a stone.',
	Seal_of_Winter:    'STATIC: Your opponent cannot cast 1-node spells (charms).',
	Seal_of_Stone:     "STATIC: Your opponent's first move each turn must be soft.",
	Seal_of_Destruction: 'STATIC: If filled at the end of your turn, destroy all enemy stones touching you. If filled at the start of your turn, you lose.',
	Fissure:           'Choose a target node. It is permanently destroyed: its stone is removed and it becomes an impassable void that stones cannot move into, retreat into, or be pushed through, disabling any spell that includes it. Also destroy all enemy stones on adjacent nodes.',
	Rock_Slide:        'Push any enemy stones adjacent to you 1 space. (Order is chosen by the casting player.) If a stone is pushed to an occupied space, the stone previously occupying that space is crushed.',
	Bulwark:           'STATIC: Stones in your locked spell cannot be targeted by enemy hard moves.',
	Dividend:          'Make 1 extra move at the beginning of your next turn.',
	Annuity:           'Make 1 extra move at the beginning of each of your next 2 turns.',
	Endowment:         'Make 1 extra move at the beginning of each of your next 4 turns.',
	Spring_Tide:       'Make 2 hard moves, then 2 soft moves, then sacrifice 2 stones.',
	Rapids:            'Make 1 soft move, then 1 hard move. You may cast 1 additional spell this turn.',
};

// ---- Duplicate-copy aliases (the "allow duplicates" variant) ----
// Spell identity is the NAME everywhere (slot lookup by indexOf, locks, SFN
// lock fields, transcript cast tokens), so a board may never hold two
// spells with the same name. The variant instead draws from a pool that
// holds every spell three times under three names — X, X~2, X~3 — and the
// two extra names alias X's metadata here, so every CORE_SPELLS /
// SPELL_TEXTS lookup works untouched. Only art paths, display strings,
// NN spell IDs and the few by-name rules (Surge/Splash, statics) reduce a
// name to its base. `~` is safe in SFN (never a separator), in Firebase
// keys (unlike `#`) and in URLs.
const DUPLICATE_SUFFIXES = ['~2', '~3'];
function baseSpellName(name) {
	if (typeof name !== 'string') return name;
	const i = name.indexOf('~');
	return i === -1 ? name : name.slice(0, i);
}
function displaySpellName(name) {
	return baseSpellName(name).replace(/_/g, ' ');
}
for (const name of Object.keys(CORE_SPELLS)) {
	for (const sfx of DUPLICATE_SUFFIXES) {
		CORE_SPELLS[name + sfx] = CORE_SPELLS[name];
		if (SPELL_TEXTS[name] !== undefined) SPELL_TEXTS[name + sfx] = SPELL_TEXTS[name];
	}
}

const CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning'];
const CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind'];
const CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer'];

// Core sub-packs: Core split into five one-ritual/one-sorcery/one-charm trios,
// shaped like an expansion, so a player can draw from part of Core. The key
// 'core' still means all fifteen; a selection may hold either form (or both).
const CORE_SUBPACKS = {
	core_growth: { name: 'Growth', rituals: ['Flourish'],          sorceries: ['Grow'],         charms: ['Sprout'] },
	core_havoc:  { name: 'Havoc',  rituals: ['Carnage'],           sorceries: ['Fireblast'],    charms: ['Slash'] },
	core_impact: { name: 'Impact', rituals: ['Starfall'],          sorceries: ['Meteor'],       charms: ['Comet'] },
	core_tempo:  { name: 'Tempo',  rituals: ['Seal_of_Lightning'], sorceries: ['Seal_of_Wind'], charms: ['Seal_of_Summer'] },
	core_hex:    { name: 'Hex',    rituals: ['Bewitch'],           sorceries: ['Hail_Storm'],   charms: ['Surge'] },
};
const CORE_SUBPACK_KEYS = Object.keys(CORE_SUBPACKS);

const SPRINGTIME_RITUALS = ['Blossom'];
const SPRINGTIME_SORCERIES = ['Scatter'];
const SPRINGTIME_CHARMS = ['Seal_of_Spring'];

const CELESTIAL_RITUALS = ['Syzygy'];
const CELESTIAL_SORCERIES = ['Eclipse'];
const CELESTIAL_CHARMS = ['Azimuth'];

const FURY_RITUALS = ['Erupt'];
const FURY_SORCERIES = ['Fury'];
const FURY_CHARMS = ['Charge'];

const TEMPEST_RITUALS = ['Hurricane'];
const TEMPEST_SORCERIES = ['Storm_Front'];
const TEMPEST_CHARMS = ['Gust'];

const FLOOD_RITUALS = ['Tsunami'];
const FLOOD_SORCERIES = ['Torrent'];
const FLOOD_CHARMS = ['Splash'];

const AUTUMN_RITUALS = ['Harvest'];
const AUTUMN_SORCERIES = ['Gather'];
const AUTUMN_CHARMS = ['Seal_of_Autumn'];

const GLOOM_RITUALS = ['Corrupt'];
const GLOOM_SORCERIES = ['Decay'];
const GLOOM_CHARMS = ['Lurk'];

const COVENANT_RITUALS = ['Seal_of_Destruction'];
const COVENANT_SORCERIES = ['Seal_of_Stone'];
const COVENANT_CHARMS = ['Seal_of_Winter'];

const TECTONIC_RITUALS = ['Fissure'];
const TECTONIC_SORCERIES = ['Rock_Slide'];
const TECTONIC_CHARMS = ['Bulwark'];

const PROVIDENCE_RITUALS = ['Endowment'];
const PROVIDENCE_SORCERIES = ['Annuity'];
const PROVIDENCE_CHARMS = ['Dividend'];

// Experimental: the unofficial, permanently unrated home for spells that are
// still being playtested before release. Unlike the official packs it need
// not fill all three slots — the pool check only requires core + selected
// packs to reach 3 spells per category.
const EXPERIMENTAL_RITUALS = [];
const EXPERIMENTAL_SORCERIES = ['Spring_Tide', 'Rapids'];
const EXPERIMENTAL_CHARMS = [];

const PANDA_RITUALS = ['Perfect_Heist', 'Moth_Plague', 'Ripples', 'Lifesap'];
const PANDA_SORCERIES = ['Stampede', 'Choke'];
const PANDA_CHARMS = ['Bear_Trap', 'Shiver', 'Blood_Saplings', 'Itch', 'Free_Spirit', 'Residue_Mixture'];

// Each expansion lists only its OWN new spells (not the core ones). A game's
// spell pool is core + every selected expansion. Multiple expansions can be
// combined. EXPANSION_KEYS fixes the display/iteration order.
const EXPANSIONS = {
	core:       { name: 'Core',       rituals: CORE_RITUALS,       sorceries: CORE_SORCERIES,       charms: CORE_CHARMS },
	springtime: { name: 'Springtime', rituals: SPRINGTIME_RITUALS, sorceries: SPRINGTIME_SORCERIES, charms: SPRINGTIME_CHARMS },
	celestial:  { name: 'Celestial',  rituals: CELESTIAL_RITUALS,  sorceries: CELESTIAL_SORCERIES,  charms: CELESTIAL_CHARMS },
	fury:       { name: 'Inferno',    rituals: FURY_RITUALS,       sorceries: FURY_SORCERIES,       charms: FURY_CHARMS },
	tempest:    { name: 'Tempest',    rituals: TEMPEST_RITUALS,    sorceries: TEMPEST_SORCERIES,    charms: TEMPEST_CHARMS },
	flood:      { name: 'Flood',      rituals: FLOOD_RITUALS,      sorceries: FLOOD_SORCERIES,      charms: FLOOD_CHARMS },
	autumn:     { name: 'Autumn',     rituals: AUTUMN_RITUALS,     sorceries: AUTUMN_SORCERIES,     charms: AUTUMN_CHARMS },
	gloom:      { name: 'Gloom',      rituals: GLOOM_RITUALS,      sorceries: GLOOM_SORCERIES,      charms: GLOOM_CHARMS },
	covenant:   { name: 'Covenant',   rituals: COVENANT_RITUALS,   sorceries: COVENANT_SORCERIES,   charms: COVENANT_CHARMS },
	panda:      { name: 'Panda',      rituals: PANDA_RITUALS,      sorceries: PANDA_SORCERIES,      charms: PANDA_CHARMS },
	tectonic:   { name: 'Tectonic',   rituals: TECTONIC_RITUALS,   sorceries: TECTONIC_SORCERIES,   charms: TECTONIC_CHARMS },
	providence: { name: 'Providence', rituals: PROVIDENCE_RITUALS, sorceries: PROVIDENCE_SORCERIES, charms: PROVIDENCE_CHARMS },
	experimental: { name: 'Experimental', rituals: EXPERIMENTAL_RITUALS, sorceries: EXPERIMENTAL_SORCERIES, charms: EXPERIMENTAL_CHARMS },
};
const EXPANSION_KEYS = ['springtime', 'celestial', 'fury', 'tempest', 'flood', 'autumn', 'gloom', 'covenant', 'panda', 'tectonic', 'providence', 'experimental'];

// Flat set of every expansion spell name (across all packs), derived from the
// EXPANSIONS map so it stays in sync. Use isExpansionSpell() to test a name.
const EXPANSION_SPELL_NAMES = new Set(
	EXPANSION_KEYS.flatMap(k => [...EXPANSIONS[k].rituals, ...EXPANSIONS[k].sorceries, ...EXPANSIONS[k].charms])
);
function isExpansionSpell(name) {
	return EXPANSION_SPELL_NAMES.has(baseSpellName(name));
}

// Panda is the unofficial expansion: its games stay unrated even though every
// other expansion is rated. Derived from the EXPANSIONS map so it stays in sync.
const PANDA_SPELL_NAMES = new Set(
	[...EXPANSIONS.panda.rituals, ...EXPANSIONS.panda.sorceries, ...EXPANSIONS.panda.charms]
);
function isPandaSpell(name) {
	return PANDA_SPELL_NAMES.has(baseSpellName(name));
}

// Derived from the EXPANSIONS map so it stays in sync. (Providence
// graduated from its unrated playtest 2026-08 and is rated like every
// other official expansion.)
const PROVIDENCE_SPELL_NAMES = new Set(
	[...EXPANSIONS.providence.rituals, ...EXPANSIONS.providence.sorceries, ...EXPANSIONS.providence.charms]
);
function isProvidenceSpell(name) {
	return PROVIDENCE_SPELL_NAMES.has(baseSpellName(name));
}

// Experimental is permanently unrated: it holds unreleased designs under
// playtest, which graduate into a real pack (or get cut) rather than rate.
const EXPERIMENTAL_SPELL_NAMES = new Set(
	[...EXPANSIONS.experimental.rituals, ...EXPANSIONS.experimental.sorceries, ...EXPANSIONS.experimental.charms]
);
function isExperimentalSpell(name) {
	return EXPERIMENTAL_SPELL_NAMES.has(baseSpellName(name));
}

// One switch for every "does this spell set stay unrated?" consumer.
// Panda and Experimental are permanently unrated (unofficial).
function isUnratedSpell(name) {
	return isPandaSpell(name) || isExperimentalSpell(name);
}

// Game variants. Orthogonal dimensions encoded in a single string:
//   competitive — empty-board opening (both players blink onto any node for
//                 their first move) instead of the classic a1/b1 stones.
//   deathmatch  — win ONLY by eliminating all opponent stones; the +3-lead and
//                 6th-spell terminal conditions are disabled (threefold board
//                 repetition still ends the game as a Blue win, to guarantee
//                 termination). Spell counters are removed in this mode.
//   scramble    — the +3-lead win is disabled; the first player to cast their
//                 sixth spell WINS outright (no stone comparison). Elimination
//                 and threefold repetition (Blue win) still apply. Unrated.
//   duplicates  — the spell draw may repeat a spell (up to three copies):
//                 the pool holds every spell as X, X~2, X~3 (see
//                 DUPLICATE_SUFFIXES) and the draw stays without
//                 replacement. A setup-only rule: play is otherwise
//                 standard. Unrated.
// Deathmatch and Scramble are both end-condition rules and are mutually
// exclusive: they share one slot, and Deathmatch wins if both are asked for.
// Tokens combine in this fixed order: 'competitive_deathmatch_duplicates',
// 'competitive_scramble_duplicates'. Kept as one string so it rides the
// existing variant plumbing (SFN, Firebase, URL, localStorage) unchanged.
const VARIANT_TOKENS = ['competitive', 'deathmatch', 'scramble', 'duplicates'];
function composeVariant(competitive, deathmatch, duplicates, scramble) {
	const parts = [];
	if (competitive) parts.push('competitive');
	if (deathmatch) parts.push('deathmatch');
	else if (scramble) parts.push('scramble');
	if (duplicates) parts.push('duplicates');
	return parts.length ? parts.join('_') : 'standard';
}
// 2 (competitive) x 3 (end condition: standard / deathmatch / scramble)
// x 2 (duplicates) = 12 strings.
const SIGIL_VARIANTS = [];
for (let mask = 0; mask < 8; mask++) {
	SIGIL_VARIANTS.push(composeVariant(mask & 1, mask & 2, mask & 4));
}
for (let mask = 0; mask < 8; mask++) {
	if (!(mask & 2)) SIGIL_VARIANTS.push(composeVariant(mask & 1, false, mask & 4, true));
}
function variantHasCompetitive(v) {
	return typeof v === 'string' && v.indexOf('competitive') !== -1;
}
function variantHasDeathmatch(v) {
	return typeof v === 'string' && v.indexOf('deathmatch') !== -1;
}
function variantHasScramble(v) {
	return typeof v === 'string' && v.indexOf('scramble') !== -1 && !variantHasDeathmatch(v);
}
function variantHasDuplicates(v) {
	return typeof v === 'string' && v.indexOf('duplicates') !== -1;
}
// Itch / Residue Mixture (Panda): "advance the enemy lock by 1". Deathmatch
// has no counters; in Scramble (where the counter is the race to six) the
// effect is reversed -- the enemy counter goes BACK by 1, floored at 0.
// Every resolver and replayer goes through here.
function bumpEnemySpellCounter(board, target) {
	if (variantHasDeathmatch(board.variant)) return;
	if (variantHasScramble(board.variant)) {
		board.spellCounter[target] = Math.max(0, board.spellCounter[target] - 1);
	} else {
		board.spellCounter[target] = Math.min(6, board.spellCounter[target] + 1);
	}
}
function enemySpellCounterMessage(variant) {
	return variantHasScramble(variant) ? 'Enemy lock reduced by 1 (Scramble).' : 'Enemy lock advanced by 1.';
}
// Canonicalize any input (handles legacy strings, wrong order, junk) to one of
// the SIGIL_VARIANTS values.
function normalizeVariant(v) {
	return composeVariant(variantHasCompetitive(v), variantHasDeathmatch(v),
		variantHasDuplicates(v), variantHasScramble(v));
}
// Stone-spot positions (fractions of the square spell image), measured from the
// core spell cards which bake white circles at these spots. Expansion spell art
// is full-bleed with no spots, so the game overlays white circles here instead.
// Keyed by spell type; the radii live in CSS (.spell-spot sizing per type).
// Regular polygons centered on the spell (0.5, 0.5), vertex pointing down, to
// match the core cards' node layout. They rotate with the slot via the shared
// positioning class, so centering on (0.5, 0.5) keeps them aligned regardless
// of slot rotation. Radii live in CSS (.spell-spot sizing per type).
const SPELL_SPOT_TEMPLATES = {
	ritual:  [[0.500, 0.803], [0.212, 0.594], [0.788, 0.594], [0.322, 0.255], [0.678, 0.255]],
	sorcery: [[0.500, 0.755], [0.279, 0.373], [0.721, 0.373]],
	charm:   [[0.500, 0.500]],
};
// type is 'charm' | 'ritual' | 'sorcery'; returns [] for anything unknown.
function spellSpotTemplate(type) {
	return SPELL_SPOT_TEMPLATES[type] || [];
}

// Normalize a spell-pack selection into a clean list of valid expansion keys.
// Accepts an array of keys (current format), or a legacy single-key string
// ('core', 'all', or one expansion).
// Spell names renamed over the project's history. Old names survive in
// stored data (Firebase records, SFN strings, localStorage saves, cast
// tokens from stale-cached clients), so every data-ingress point runs
// names through these; writes always use the current name.
// 2026-08-24: spell Flood -> Tsunami (pack Tsunami -> Flood in the same swap).
const LEGACY_SPELL_RENAMES = { Flood: 'Tsunami' };

function normalizeSpellName(name) {
	if (typeof name !== 'string') return name;
	const base = baseSpellName(name);
	const renamed = LEGACY_SPELL_RENAMES[base];
	return renamed ? renamed + name.slice(base.length) : name;
}

function normalizeSpellNames(names) {
	return (names || []).map(normalizeSpellName);
}

// Rewrite every spell name embedded in an SFN string to current names —
// the spell-list segment plus the lock/springlock fields (parts 4-5, which
// hold spell names too) — leaving all other fields byte-identical. For
// comparing freshly serialized SFNs (always current names) against stored
// ones that may predate a rename.
function normalizeSfnString(sfn) {
	if (!sfn) return sfn;
	const parts = sfn.split(' ');
	const slash = parts[0].indexOf('/');
	if (slash !== -1) {
		const spells = parts[0].slice(slash + 1).split(',').map(normalizeSpellName);
		parts[0] = parts[0].slice(0, slash + 1) + spells.join(',');
	}
	for (const i of [4, 5]) {
		if (parts[i] && parts[i].includes(':')) {
			parts[i] = parts[i].split(':')
				.map(v => v === '-' ? v : normalizeSpellName(v)).join(':');
		}
	}
	return parts.join(' ');
}

// Pack keys renamed over the project's history; stored selections
// (localStorage, env vars) may still carry the old key.
const LEGACY_PACK_KEYS = { tsunami: 'flood' };

// A pack key's spell lists: an expansion (including 'core') or a Core sub-pack.
function packDefinition(key) {
	return EXPANSIONS[key] || CORE_SUBPACKS[key] || null;
}
// Display name; sub-packs read "Core: Growth".
function packDisplayName(key) {
	if (CORE_SUBPACKS[key]) return 'Core: ' + CORE_SUBPACKS[key].name;
	return (EXPANSIONS[key] && EXPANSIONS[key].name) || key;
}

function normalizeExpansionSelection(selection) {
	if (Array.isArray(selection)) {
		return selection.map(k => LEGACY_PACK_KEYS[k] || k).filter(k => packDefinition(k));
	}
	if (typeof selection === 'string') {
		if (selection === 'all') return ['core', ...EXPANSION_KEYS];
		const key = LEGACY_PACK_KEYS[selection] || selection;
		if (EXPANSIONS[key]) return [key];
	}
	return [];
}

// Read the player's chosen expansions from localStorage, supporting both the
// current multi-select key (sigilSpellPacks, a JSON array) and the legacy
// single-select key (sigilSpellPack, a string).
function readStoredExpansions() {
	if (typeof localStorage === 'undefined') return ['core'];
	const multi = localStorage.getItem('sigilSpellPacks');
	if (multi !== null) {
		try { return normalizeExpansionSelection(JSON.parse(multi)); }
		catch (e) { return ['core']; }
	}
	const legacy = localStorage.getItem('sigilSpellPack');
	if (legacy) {
		return normalizeExpansionSelection(legacy);
	}
	return ['core'];
}

function shuffleArray(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// `allowDuplicates` (the 'duplicates' variant) triples the pool — every spell
// as X, X~2, X~3 — and then draws WITHOUT replacement exactly as before, so
// the board comes out as if drawn with replacement while every slot still
// carries a unique name.
function generateSpellList(selection, allowDuplicates = false) {
	let selectedKeys = normalizeExpansionSelection(selection);
	if (selectedKeys.length === 0) {
		if (typeof localStorage !== 'undefined') {
			selectedKeys = readStoredExpansions();
		}
		if (selectedKeys.length === 0) {
			selectedKeys = ['core'];
		}
	}

	// Sets: 'core' plus a Core sub-pack must not put a spell in the pool twice.
	const poolSets = [new Set(), new Set(), new Set()];
	for (const key of selectedKeys) {
		const pack = packDefinition(key);
		if (pack) {
			pack.rituals.forEach(n => poolSets[0].add(n));
			pack.sorceries.forEach(n => poolSets[1].add(n));
			pack.charms.forEach(n => poolSets[2].add(n));
		}
	}
	const poolByCat = poolSets.map(set => [...set]);

	if (allowDuplicates) {
		for (let c = 0; c < 3; c++) {
			poolByCat[c] = poolByCat[c].flatMap(n => [n, ...DUPLICATE_SUFFIXES.map(s => n + s)]);
		}
	}

	if (poolByCat[0].length < 3 || poolByCat[1].length < 3 || poolByCat[2].length < 3) {
		throw new Error("Not enough spells selected to fill the board. Please select more spell packs.");
	}

	const picks = poolByCat.map(cat => shuffleArray(cat).slice(0, 3));
	return [...picks[0], ...picks[1], ...picks[2]];
}
