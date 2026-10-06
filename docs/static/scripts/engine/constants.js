// Sentinel stored in board.stones[node] when a node has been permanently
// destroyed by Fissure (a wall): not null, not 'red'/'blue'. Impassable to
// moves and push chains; a spell whose position includes it can never charge.
const DESTROYED = 'X';

// ---- Board layouts ----
// A layout is a ring of identical 13-node zones. Per zone X (next zone Y):
//   X1 mana; X2-X6 5-node sigil (ritual); X7 1-node sigil (charm);
//   X8-X10 3-node sigil (sorcery); X11-X13 void.
//   Internal edges: X1-X2 X1-X11 X2-X3 X3-X4 X4-X5 X5-X6 X6-X2 X3-X13 X4-X7
//   X5-X12 X6-X11 X7-X8 X8-X9 X9-X10 X10-X8 X9-X13; ring edges X7-Y12, X10-Y11.
// Spell positions run rituals, then sorceries, then charms, each in zone
// order, so spellNames[i] sits at position i + 1 and generateSpellList's
// [rituals..., sorceries..., charms...] lines up for any zone count.
//   core      3 zones, 39 nodes, 3/3/3 spells (the printed board)
//   pentagon  5 zones, 65 nodes, 5/5/5 spells (Cataclysm expanded 1v1)
// The core tables below are the canonical literals (topology.rs and
// notation.py are generated from the same data); the ring builder must
// reproduce them exactly for 3 zones (tools/board-layout-smoke.js).
const _CORE_POSITIONS = {
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

const _CORE_ADJACENCY = {
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

const _ZONE_LETTERS = 'abcdefgh';

function buildRingLayout(zoneCount) {
	const zones = _ZONE_LETTERS.slice(0, zoneCount).split('');
	const nodeOrder = [];
	for (const z of zones) for (let k = 1; k <= 13; k++) nodeOrder.push(z + k);
	const index = {};
	nodeOrder.forEach((n, i) => { index[n] = i; });
	const adj = {};
	for (const n of nodeOrder) adj[n] = [];
	const link = (u, v) => { adj[u].push(v); adj[v].push(u); };
	const INTERNAL = [[1, 2], [1, 11], [2, 3], [3, 4], [4, 5], [5, 6], [6, 2], [3, 13],
		[4, 7], [5, 12], [6, 11], [7, 8], [8, 9], [9, 10], [10, 8], [9, 13]];
	zones.forEach((z, zi) => {
		for (const [u, v] of INTERNAL) link(z + u, z + v);
		const y = zones[(zi + 1) % zoneCount];
		link(z + 7, y + 12);
		link(z + 10, y + 11);
	});
	// Index-ascending neighbour lists, like the core literal.
	for (const n of nodeOrder) adj[n].sort((u, v) => index[u] - index[v]);
	const positions = {};
	zones.forEach((z, zi) => {
		positions[1 + zi] = [2, 3, 4, 5, 6].map(k => z + k);
		positions[1 + zoneCount + zi] = [8, 9, 10].map(k => z + k);
		positions[1 + 2 * zoneCount + zi] = [z + 7];
	});
	return { zones, nodeOrder, positions, adjacency: adj, manaNodes: zones.map(z => z + 1) };
}

// Bump when a deploy changes a script API that the (network-first) HTML
// pages call, and raise the number in the pages' stale-asset guards to match
// (the inline script after each page's constants.js tag).
const SIGIL_ASSET_EPOCH = 1;

// Per-layout rules. `spellTarget`: casting this many spells ends the game
// (the stone leader wins). `winLead`: a real-stone lead of this much over the
// opponent's total (blue's +1 phantom and Providence banks included) wins
// outright. Pentagon values are first guesses pending self-play calibration.
const BOARD_LAYOUT_RULES = {
	core:     { zones: 3, spellTarget: 6, winLead: 3, name: 'Core' },
	pentagon: { zones: 5, spellTarget: 8, winLead: 4, name: 'Pentagon' },
};
const BOARD_LAYOUT_IDS = Object.keys(BOARD_LAYOUT_RULES);
// The layout a board of `n` spells fills (9 -> core, 15 -> pentagon), for
// records that carry a spell list but no SFN.
function boardLayoutForSpellCount(n) {
	for (const id of BOARD_LAYOUT_IDS) {
		if (3 * BOARD_LAYOUT_RULES[id].zones === n) return id;
	}
	return 'core';
}

const _BOARD_LAYOUT_CACHE = {};
function boardLayoutDef(id) {
	if (!BOARD_LAYOUT_RULES[id]) id = 'core';
	if (_BOARD_LAYOUT_CACHE[id]) return _BOARD_LAYOUT_CACHE[id];
	const rules = BOARD_LAYOUT_RULES[id];
	const Z = rules.zones;
	const ring = buildRingLayout(Z);
	if (id === 'core') {
		ring.positions = _CORE_POSITIONS;
		ring.adjacency = _CORE_ADJACENCY;
	}
	const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
	// Syzygy's "opposite" spells: the charm and sorcery straight across the
	// ring, half the ring (Z/2 zones) away from Syzygy's ritual. Zone j's charm
	// and sorcery sit between rituals j and j+1, so from ritual k the
	// opposite pair is zone k + floor(Z/2)'s:
	//   core (A-B-C):         A -> between B and C = zone B's (1 -> {8, 5})
	//   pentagon (A-B-C-D-E): A -> between C and D = zone C's (1 -> {13, 8})
	const syzygyOpposite = {};
	for (let k = 0; k < Z; k++) {
		const opp = (k + Math.floor(Z / 2)) % Z;
		syzygyOpposite[1 + k] = { charm: 1 + 2 * Z + opp, sorcery: 1 + Z + opp };
	}
	const def = Object.freeze({
		id,
		name: rules.name,
		zones: ring.zones,
		perType: Z,
		positionCount: 3 * Z,
		ritualPositions: range(1, Z),
		sorceryPositions: range(Z + 1, 2 * Z),
		charmPositions: range(2 * Z + 1, 3 * Z),
		bigPositions: range(1, 2 * Z),
		nodeOrder: ring.nodeOrder,
		positions: ring.positions,
		adjacency: ring.adjacency,
		manaNodes: ring.manaNodes,
		startStones: { red: 'a1', blue: 'b1' },
		spellTarget: rules.spellTarget,
		winLead: rules.winLead,
		syzygyOpposite,
	});
	_BOARD_LAYOUT_CACHE[id] = def;
	return def;
}

// ---- The active layout ----
// Every engine module reads topology through these bindings. They describe
// ONE layout per JS realm (page or worker) and are rewritten IN PLACE by
// setBoardLayout, so references held elsewhere stay valid. Board / SimBoard
// constructors activate the layout their variant names (variantBoardLayout);
// a page never runs two layouts at once.
const NODE_ORDER = [];       // canonical node order (SFN stone field)
const POSITIONS = {};        // spell position index (1-based) -> [node names]
const ADJACENCY = {};        // node -> [neighbour nodes], index-ascending
const MANA_NODES = [];
// Nodes that sit on a spell sigil. Seal of Autumn forbids the opponent from
// sacrificing any of these to pay for a dash.
const SPELL_NODES = new Set();
// Nodes on no spell sigil and not mana nodes (core: a11-13, b11-13, c11-13).
// A stone parked here charges nothing and holds no mana ("void" nodes).
// Mirrors ai/minimax_ai.py _VOID_NODES.
const VOID_NODES = [];
// Nodes that sit on a 3-node (sorcery) or 5-node (ritual) sigil. Lurk (Gloom
// charm) may move onto any node EXCEPT these; 1-node spells (charms) and
// non-spell nodes remain valid targets.
const BIG_SPELL_NODES = new Set();
// Scalar facts about the active layout (see boardLayoutDef): id, perType,
// positionCount, ritual/sorcery/charm/bigPositions, spellTarget, winLead,
// startStones, syzygyOpposite, zones.
const BOARD = {};
const _boardLayoutListeners = [];

function setBoardLayout(id) {
	const def = boardLayoutDef(id);
	if (BOARD.id === def.id) return def;
	NODE_ORDER.length = 0;
	NODE_ORDER.push(...def.nodeOrder);
	for (const k of Object.keys(POSITIONS)) delete POSITIONS[k];
	for (const [k, v] of Object.entries(def.positions)) POSITIONS[k] = v;
	for (const k of Object.keys(ADJACENCY)) delete ADJACENCY[k];
	for (const [k, v] of Object.entries(def.adjacency)) ADJACENCY[k] = v;
	MANA_NODES.length = 0;
	MANA_NODES.push(...def.manaNodes);
	SPELL_NODES.clear();
	for (let p = 1; p <= def.positionCount; p++) {
		for (const n of def.positions[p]) SPELL_NODES.add(n);
	}
	VOID_NODES.length = 0;
	VOID_NODES.push(...NODE_ORDER.filter(n => !SPELL_NODES.has(n) && !MANA_NODES.includes(n)));
	BIG_SPELL_NODES.clear();
	for (const p of def.bigPositions) {
		for (const n of def.positions[p]) BIG_SPELL_NODES.add(n);
	}
	for (const k of Object.keys(BOARD)) delete BOARD[k];
	for (const k of ['id', 'name', 'zones', 'perType', 'positionCount', 'ritualPositions',
		'sorceryPositions', 'charmPositions', 'bigPositions', 'startStones',
		'spellTarget', 'winLead', 'syzygyOpposite']) {
		BOARD[k] = def[k];
	}
	for (const fn of _boardLayoutListeners) fn(def);
	return def;
}

// Modules that precompute from the topology (index tables, typed arrays)
// register here; the callback runs now and after every layout switch.
function onBoardLayoutChange(fn) {
	_boardLayoutListeners.push(fn);
	if (BOARD.id) fn(boardLayoutDef(BOARD.id));
}

function isSpellNode(name) {
	return SPELL_NODES.has(name);
}
function isBigSpellNode(name) {
	return BIG_SPELL_NODES.has(name);
}
// 'ritual' | 'sorcery' | 'charm' for a 1-based position of the active layout.
function spellTypeAtPosition(pos) {
	if (pos >= 1 && pos <= BOARD.perType) return 'ritual';
	if (pos > BOARD.perType && pos <= 2 * BOARD.perType) return 'sorcery';
	if (pos > 2 * BOARD.perType && pos <= BOARD.positionCount) return 'charm';
	return null;
}
// UI slot keys in position order: ritual1..N, sorcery1..N, charm1..N
// (spellNames[i] is slot i). The page keys spell art and text by these.
function spellSlotNames() {
	const out = [];
	for (const type of ['ritual', 'sorcery', 'charm']) {
		for (let k = 1; k <= BOARD.perType; k++) out.push(type + k);
	}
	return out;
}
// 1-based index of the position holding `node`, or null.
function positionOfNode(node) {
	for (let p = 1; p <= BOARD.positionCount; p++) {
		if (POSITIONS[p].includes(node)) return p;
	}
	return null;
}

setBoardLayout('core');

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
	// Rock Slide: every bordering enemy stone gets a push, then all resolve
	// simultaneously (see resolveRockSlide).
	Rock_Slide:        { resolve: 'rock_slide',      static: false, ischarm: false },
	Bulwark:           { resolve: null,              static: true,  ischarm: true },
	// Providence expansion (stones banked into the caster's Providence bank)
	Dividend:          { resolve: 'bank_stones', stones: 1, static: false, ischarm: true },
	Annuity:           { resolve: 'bank_stones', stones: 2, static: false, ischarm: false },
	Endowment:         { resolve: 'bank_stones', stones: 4, static: false, ischarm: false },
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
	Stampede:          'Make hard moves equal to your lock value.',
	Choke:             'Choose an enemy stone; place your stones on all of its empty adjacent nodes.',
	Perfect_Heist:     'Destroy every stone on the mana nodes, then occupy all of them.',
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
	Fissure:           'Choose a target node. It is permanently destroyed: its stone is removed and it becomes an impassable void that stones cannot move into, retreat into, or be pushed through, disabling any spell that includes it. Also destroy all stones on adjacent nodes, including your own.',
	Rock_Slide:        "Push each enemy stone bordering you into an adjacent node. All pushes happen simultaneously. Stones already occupying a destination are destroyed; stones pushed onto each other's nodes, or into the same node, are destroyed.",
	Bulwark:           'STATIC: Stones in your locked spell cannot be targeted by enemy hard moves, converted, or destroyed.',
	Dividend:          'Add 1 stone to your Providence bank.',
	Annuity:           'Add 2 stones to your Providence bank.',
	Endowment:         'Add 4 stones to your Providence bank.',
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

// ---- Bulwark (Tectonic) ----
// Nodes whose stone is shielded by its owner's Bulwark: a player holding
// Bulwark charged protects their own stones in their locked spell from enemy
// hard moves, conversion, and destruction by any effect (their own Fissure
// included); sacrifices are unaffected. Works on the live SigilBoard and the
// SimBoard alike. Mirrors bulwark_protected_nodes in simboard.py.
function bulwarkProtectedNodes(board) {
	const out = new Set();
	for (const c of ['red', 'blue']) {
		const lock = board.lock[c];
		if (!lock || !board.chargedSpells[c].includes('Bulwark')) continue;
		const idx = board.spellNames.indexOf(lock);
		if (idx < 0) continue;
		for (const n of POSITIONS[idx + 1] || []) {
			if (board.stones[n] === c) out.add(n);
		}
	}
	return out;
}

// The nodes whose shield would drop if the stone at `node` were removed (it
// is its owner's Bulwark charm stone). Sequential effects (Carnage-style hard
// moves, Storm Front, Corrupt) re-check Bulwark before every step, so taking
// the Bulwark stone first exposes the locked spell to the later steps.
// Mirrors SimBoard._bulwark_unshielded_by_removing in simboard.py.
function bulwarkUnshieldedByRemoving(board, node) {
	const out = new Set();
	const owner = board.stones[node];
	if (owner !== 'red' && owner !== 'blue') return out;
	const cur = bulwarkProtectedNodes(board);
	if (!cur.size || cur.has(node)) return out;
	// Is `owner` still holding a charged Bulwark without this stone?
	const stillCharged = board.spellNames.some((sn, i) => {
		if (baseSpellName(sn) !== 'Bulwark') return false;
		const nodes = POSITIONS[i + 1] || [];
		return nodes.length > 0 && nodes.every(n => n !== node && board.stones[n] === owner);
	});
	if (stillCharged) return out;
	for (const n of cur) if (board.stones[n] === owner) out.add(n);
	return out;
}

// ---- Fissure (Tectonic) ----
// Fissure's outcome at `target`: { destroyed, wall }. Every unshielded stone
// of EITHER color on an adjacent node is destroyed. The target becomes a
// permanent wall (its stone, if any, destroyed) unless it holds a
// Bulwark-shielded stone, in which case the stone stays and no wall forms
// (wall === null). Mirrors fissure_blast in simboard.py.
function fissureBlast(stones, target, shielded) {
	shielded = shielded || new Set();
	const occupied = (n) => stones[n] === 'red' || stones[n] === 'blue';
	const destroyed = ADJACENCY[target].filter(n => occupied(n) && !shielded.has(n));
	if (occupied(target) && shielded.has(target)) return { destroyed, wall: null };
	if (occupied(target)) destroyed.push(target);
	return { destroyed, wall: target };
}

// Net stone swing of Fissure at `target` for `color` (+1 per enemy stone
// destroyed, -1 per own); null for an existing wall. Mirrors fissure_score.
function fissureScore(stones, color, target, shielded) {
	if (stones[target] === DESTROYED) return null;
	const { destroyed } = fissureBlast(stones, target, shielded);
	let score = 0;
	for (const n of destroyed) score += stones[n] === color ? -1 : 1;
	return score;
}

// Legal Fissure targets, best net swing first (NODE_ORDER on ties).
// Mirrors fissure_ranked_targets.
function fissureRankedTargets(stones, color, shielded) {
	const scored = [];
	NODE_ORDER.forEach((n, i) => {
		const sc = fissureScore(stones, color, n, shielded);
		if (sc !== null) scored.push([sc, i, n]);
	});
	scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	return scored.map(x => x[2]);
}

// ---- Rock Slide (Tectonic) ----
// Pure helpers shared by the interactive resolver (spells.js), the AI sim
// (sim-board.js), replay/playback (applySimTurn, minimax-ai.js,
// ai-player.js). Mirrors rock_slide_sources / resolve_rock_slide /
// rock_slide_greedy_pushes in simboard.py.

// Every enemy stone touching a `color` stone, in NODE_ORDER, except
// Bulwark-shielded ones. Fixed at cast time; every one of them must be pushed.
function rockSlideSources(stones, color, shielded) {
	const enemy = color === 'red' ? 'blue' : 'red';
	shielded = shielded || new Set();
	return NODE_ORDER.filter(n => stones[n] === enemy && !shielded.has(n)
		&& ADJACENCY[n].some(nb => stones[nb] === color));
}

// Resolve pushes ([{from, to}]) simultaneously without mutating `stones`.
// Returns { final: {node: value}, lost: [[node, color]] }. A pushed-away
// node counts as vacated (chains slide, loops of 3+ rotate); a stationary
// stone on a destination is destroyed; 2+ stones into one node all die; a
// swap kills both; a stone pushed into a wall dies and the wall stays; a
// Bulwark-shielded stone on a destination acts as a wall (arrivals die, it
// stays).
function resolveRockSlide(stones, pushes, shielded) {
	shielded = shielded || new Set();
	const destOf = {};
	const arrivals = new Map();
	for (const p of pushes) {
		destOf[p.from] = p.to;
		if (!arrivals.has(p.to)) arrivals.set(p.to, []);
		arrivals.get(p.to).push(p.from);
	}
	const final = {};
	for (const src of Object.keys(destOf)) final[src] = null;
	const lost = [];
	for (const [dest, srcs] of arrivals) {
		const occ = stones[dest];
		const shield = shielded.has(dest) && !(dest in destOf);
		if (!(dest in destOf) && (occ === 'red' || occ === 'blue') && !shield) {
			lost.push([dest, occ]);
			final[dest] = null;
		}
		if (occ === DESTROYED || shield || srcs.length >= 2 || destOf[dest] === srcs[0]) {
			// A stone stopped by a shield dies where it stood: recording it at
			// the shield would put the shielded node in `destroyed`, and the
			// replay (rockSlideReplayShielded) would then read the shield as
			// absent and kill the stone it protects.
			for (const src of srcs) lost.push([shield ? src : dest, stones[src]]);
		} else {
			final[dest] = stones[srcs[0]];
		}
	}
	return { final, lost };
}

// The Bulwark-shielded destinations of a RECORDED Rock Slide: a stationary
// stone on a destination the recorded outcome did not destroy. Replayers use
// this instead of re-deriving protection (the caster's lock changes with the
// cast). Mirrors rock_slide_replay_protected.
function rockSlideReplayShielded(stones, pushes, destroyed) {
	const sources = new Set(pushes.map(p => p.from));
	const dead = new Set(destroyed || []);
	const out = new Set();
	for (const p of pushes) {
		if (!sources.has(p.to) && !dead.has(p.to)
			&& (stones[p.to] === 'red' || stones[p.to] === 'blue')) out.add(p.to);
	}
	return out;
}

// Thrown for an `rock_slide_variant` override past the number of distinct
// optimal outcomes; the exhaustive enumerators' try/catch skips it.
class RockSlideVariantUnavailable extends Error {}

const _ROCK_SLIDE_MEMO = new Map();
const _ROCK_SLIDE_MEMO_MAX = 256;

function _rockSlidePinned(sources, overridePushes) {
	const pinned = {};
	for (const ovr of overridePushes || []) {
		if (sources.includes(ovr.from) && ADJACENCY[ovr.from].includes(ovr.to) && !(ovr.from in pinned)) {
			pinned[ovr.from] = ovr.to;
		}
	}
	return pinned;
}

// Deterministic variable order keeping the DP frontier narrow: BFS over
// interacting sources, seeded and tie-broken by NODE_ORDER.
function _rockSlideOrder(comp, opts) {
	const touches = {};
	for (const src of comp) touches[src] = new Set([...opts[src], src]);
	const order = [], seen = new Set();
	for (const root of comp) {
		if (seen.has(root)) continue;
		seen.add(root);
		const queue = [root];
		while (queue.length) {
			const cur = queue.shift();
			order.push(cur);
			for (const nb of comp) {
				if (!seen.has(nb) && [...touches[cur]].some(n => touches[nb].has(n))) {
					seen.add(nb);
					queue.push(nb);
				}
			}
		}
	}
	return order;
}

// Exact max-net search over one interaction component: DP over a narrow
// frontier of open nodes, then a tie walk using the DP as an exact bound.
// Returns [bestNet, [destMap, ...]] — one assignment per distinct resolved
// outcome, first in canonical order, at most `limit` (null = all).
// Mirrors _rock_slide_component in simboard.py (see there for the scoring).
function _rockSlideComponent(stones, color, comp, opts, srcSet, limit, shielded) {
	shielded = shielded || new Set();
	const enemy = color === 'red' ? 'blue' : 'red';
	const kind = {};
	for (const src of comp) {
		for (const d of [...opts[src], src]) {
			if (srcSet.has(d)) kind[d] = 'mover';
			else if (stones[d] === DESTROYED) kind[d] = 'wall';
			else if (shielded.has(d)) kind[d] = 'shield';   // Bulwark: arrivals die, occupant stays
			else if (stones[d] === enemy) kind[d] = 'enemy';
			else if (stones[d] === color) kind[d] = 'own';
			else kind[d] = 'empty';
		}
	}
	const inComp = new Set(comp);
	const seq = _rockSlideOrder(comp, opts);
	const closeAt = {};
	seq.forEach((src, i) => {
		for (const d of opts[src]) closeAt[d] = i;
		closeAt[src] = Math.max(src in closeAt ? closeAt[src] : i, i);
	});
	const closing = seq.map(() => []);
	for (const d of Object.keys(closeAt)) {
		if (kind[d] === 'mover' && inComp.has(d)) closing[closeAt[d]].push(d);
	}
	const firstHit = { enemy: 1, own: -1 };
	const keyOf = (f) => Object.keys(f).sort().map(n => n + ':' + f[n].join(',')).join(';');

	// frontier: {node: [count, arriver, dest]} (null for unknown)
	function step(frontier, i, d) {
		const src = seq[i];
		const f = Object.assign({}, frontier);
		const kd = kind[d];
		let gain = 0;
		if (kd === 'wall' || kd === 'shield') {
			gain = 1;
		} else {
			const [cnt, , dst] = f[d] || [0, null, null];
			if (cnt === 0) {
				gain = firstHit[kd] || 0;
				f[d] = [1, src, dst];
			} else {
				gain = cnt === 1 ? 2 : 1;
				f[d] = [2, null, dst];
			}
		}
		if (src in closeAt && kind[src] === 'mover') {
			const [cnt, arriver] = f[src] || [0, null, null];
			f[src] = [cnt, arriver, d];
		}
		for (const node of closing[i]) {
			const [cnt, arriver, dst] = f[node] || [0, null, null];
			delete f[node];
			if (cnt === 1 && dst === arriver) gain += 1;   // swap: the lone arrival here dies
		}
		for (const node of Object.keys(f)) if (closeAt[node] <= i) delete f[node];
		return [gain, f];
	}

	const memo = new Map();
	function dp(i, f) {
		if (i === seq.length) return 0;
		const mk = i + '|' + keyOf(f);
		if (memo.has(mk)) return memo.get(mk);
		let best = null;
		for (const d of opts[seq[i]]) {
			const [gain, nf] = step(f, i, d);
			const val = gain + dp(i + 1, nf);
			if (best === null || val > best) best = val;
		}
		memo.set(mk, best);
		return best;
	}

	const best = dp(0, {});
	const dest = {};
	const out = [], keys = new Set();
	function outcomeKey() {
		const arrivals = {};
		for (const src of seq) (arrivals[dest[src]] = arrivals[dest[src]] || []).push(src);
		const vals = {};
		for (const d of Object.keys(kind)) vals[d] = srcSet.has(d) ? null : stones[d];
		for (const d of Object.keys(arrivals)) {
			const srcs = arrivals[d];
			if (kind[d] === 'wall') vals[d] = DESTROYED;
			else if (kind[d] === 'shield') vals[d] = stones[d];
			else if (srcs.length >= 2 || (kind[d] === 'mover' && dest[d] === srcs[0])) vals[d] = null;
			else vals[d] = enemy;
		}
		return Object.keys(vals).sort().map(n => n + '=' + vals[n]).join(';');
	}
	function walk(i, f, acc) {
		if (limit !== null && out.length >= limit) return;
		if (i === seq.length) {
			const k = outcomeKey();
			if (!keys.has(k)) { keys.add(k); out.push(Object.assign({}, dest)); }
			return;
		}
		for (const d of opts[seq[i]]) {
			const [gain, nf] = step(f, i, d);
			if (acc + gain + dp(i + 1, nf) === best) {
				dest[seq[i]] = d;
				walk(i + 1, nf, acc + gain);
				delete dest[seq[i]];
			}
		}
	}
	walk(0, {}, 0);
	return [best, out];
}

function _rockSlideSolve(stones, color, pinned, limit, shielded) {
	const sources = rockSlideSources(stones, color, shielded);
	const srcSet = new Set(sources);
	const opts = {};
	for (const s of sources) opts[s] = s in pinned ? [pinned[s]] : ADJACENCY[s].slice();
	const parent = {};
	for (const s of sources) parent[s] = s;
	const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
	const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
	const byDest = new Map();
	for (const s of sources) for (const d of opts[s]) {
		if (!byDest.has(d)) byDest.set(d, []);
		byDest.get(d).push(s);
	}
	for (const ss of byDest.values()) for (const t of ss.slice(1)) union(ss[0], t);
	for (const s of sources) for (const d of opts[s]) if (srcSet.has(d) && opts[d].includes(s)) union(s, d);
	const comps = [], index = new Map();
	for (const s of sources) {
		const r = find(s);
		if (!index.has(r)) { index.set(r, comps.length); comps.push([]); }
		comps[index.get(r)].push(s);
	}
	let total = 0;
	const perComp = [];
	for (const comp of comps) {
		const [net, assigns] = _rockSlideComponent(stones, color, comp, opts, srcSet, limit, shielded);
		total += net;
		perComp.push(assigns);
	}
	return [sources, total, perComp];
}

// Every Rock Slide push set with the maximum net gain (enemy stones destroyed
// minus own stones destroyed), one per distinct resolved board, in canonical
// order (first = greedy): [bestNet, [pushes, ...]]. Sources split into
// independent interaction components, each solved exactly by DP; component
// optima multiply lazily (last component fastest), stopping at `limit`.
// Mirrors rock_slide_optimal_pushes in simboard.py.
function rockSlideOptimalPushes(stones, color, overridePushes, limit, shielded) {
	limit = limit === undefined ? null : limit;
	shielded = shielded || new Set();
	const sources = rockSlideSources(stones, color, shielded);
	const pinned = _rockSlidePinned(sources, overridePushes);
	// Memo per position; a solve with a larger limit serves smaller ones
	// (the outcome lists are prefix-consistent).
	const key = NODE_ORDER.map(n => stones[n]).join(',') + '|' + color + '|'
		+ Object.keys(pinned).sort().map(k => k + '>' + pinned[k]).join(',')
		+ '|' + [...shielded].sort().join(',');
	let hit = _ROCK_SLIDE_MEMO.get(key);
	if (!hit || !(hit[0] === null || (limit !== null && hit[0] >= limit))) {
		if (_ROCK_SLIDE_MEMO.size >= _ROCK_SLIDE_MEMO_MAX) _ROCK_SLIDE_MEMO.clear();
		hit = [limit, _rockSlideSolve(stones, color, pinned, limit, shielded)];
		_ROCK_SLIDE_MEMO.set(key, hit);
	}
	const [srcs, best, perComp] = hit[1];
	const out = [];
	if (perComp.some(c => !c.length)) return [best, out];
	const idx = perComp.map(() => 0);
	while (true) {
		const merged = {};
		perComp.forEach((c, i) => Object.assign(merged, c[idx[i]]));
		out.push(srcs.map(s => ({ from: s, to: merged[s] })));
		if (limit !== null && out.length >= limit) break;
		let k = idx.length - 1;
		while (k >= 0 && ++idx[k] === perComp[k].length) { idx[k] = 0; k--; }
		if (k < 0) break;
	}
	return [best, out];
}

// The canonical first max-net push set. Mirrors rock_slide_greedy_pushes.
function rockSlideGreedyPushes(stones, color, overridePushes, shielded) {
	return rockSlideOptimalPushes(stones, color, overridePushes, 1, shielded)[1][0];
}

// Game variants. Orthogonal dimensions encoded in a single string:
//   competitive — empty-board opening (both players blink onto any node for
//                 their first move) instead of the classic a1/b1 stones.
//   deathmatch  — win ONLY by eliminating all opponent stones; the stone-lead
//                 and spell-count terminal conditions are disabled (threefold
//                 board repetition still ends the game as a Blue win, to
//                 guarantee termination). Spell counters are removed in this mode.
//   scramble    — the stone-lead win is disabled; the first player to cast
//                 BOARD.spellTarget spells (6 on core) WINS outright (no stone
//                 comparison). Elimination and threefold repetition (Blue win)
//                 still apply. Unrated.
//   duplicates  — the spell draw may repeat a spell (up to three copies):
//                 the pool holds every spell as X, X~2, X~3 (see
//                 DUPLICATE_SUFFIXES) and the draw stays without
//                 replacement. A setup-only rule: play is otherwise
//                 standard. Unrated.
//   pentagon    — the Cataclysm expanded 1v1 board: 5 zones, 65 nodes,
//                 5 spells of each size (see BOARD_LAYOUT_RULES). Absent
//                 means the core board. Unrated.
// Deathmatch and Scramble are both end-condition rules and are mutually
// exclusive: they share one slot, and Deathmatch wins if both are asked for.
// Tokens combine in this fixed order:
// 'competitive_deathmatch_duplicates_pentagon',
// 'competitive_scramble_duplicates_pentagon'. Kept as one string so it rides
// the existing variant plumbing (SFN, Firebase, URL, localStorage) unchanged.
const VARIANT_TOKENS = ['competitive', 'deathmatch', 'scramble', 'duplicates', 'pentagon'];
function composeVariant(competitive, deathmatch, duplicates, scramble, pentagon) {
	const parts = [];
	if (competitive) parts.push('competitive');
	if (deathmatch) parts.push('deathmatch');
	else if (scramble) parts.push('scramble');
	if (duplicates) parts.push('duplicates');
	if (pentagon) parts.push('pentagon');
	return parts.length ? parts.join('_') : 'standard';
}
// 2 (competitive) x 3 (end condition: standard / deathmatch / scramble)
// x 2 (duplicates) x 2 (board: core / pentagon) = 24 strings. The first 12
// are the core-board ones, in the order Python's SimBoard.VARIANTS lists them.
const SIGIL_VARIANTS = [];
for (const pentagon of [false, true]) {
	for (let mask = 0; mask < 8; mask++) {
		SIGIL_VARIANTS.push(composeVariant(mask & 1, mask & 2, mask & 4, false, pentagon));
	}
	for (let mask = 0; mask < 8; mask++) {
		if (!(mask & 2)) SIGIL_VARIANTS.push(composeVariant(mask & 1, false, mask & 4, true, pentagon));
	}
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
function variantHasPentagon(v) {
	return typeof v === 'string' && v.indexOf('pentagon') !== -1;
}
// The board layout id a variant plays on ('core' | 'pentagon').
function variantBoardLayout(v) {
	return variantHasPentagon(v) ? 'pentagon' : 'core';
}
// Itch / Residue Mixture (Panda): "advance the enemy lock by 1". Deathmatch
// has no counters; in Scramble (where the counter is the race to
// BOARD.spellTarget) the effect is reversed -- the enemy counter goes BACK
// by 1, floored at 0. Every resolver and replayer goes through here.
function bumpEnemySpellCounter(board, target) {
	if (variantHasDeathmatch(board.variant)) return;
	if (variantHasScramble(board.variant)) {
		board.spellCounter[target] = Math.max(0, board.spellCounter[target] - 1);
	} else {
		board.spellCounter[target] = Math.min(BOARD.spellTarget, board.spellCounter[target] + 1);
	}
}
function enemySpellCounterMessage(variant) {
	return variantHasScramble(variant) ? 'Enemy lock reduced by 1 (Scramble).' : 'Enemy lock advanced by 1.';
}
// Canonicalize any input (handles legacy strings, wrong order, junk) to one of
// the SIGIL_VARIANTS values.
function normalizeVariant(v) {
	return composeVariant(variantHasCompetitive(v), variantHasDeathmatch(v),
		variantHasDuplicates(v), variantHasScramble(v), variantHasPentagon(v));
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

	// One spell per sigil of each size on the active layout (3 on core).
	const perType = BOARD.perType;
	if (poolByCat[0].length < perType || poolByCat[1].length < perType || poolByCat[2].length < perType) {
		throw new Error("Not enough spells selected to fill the board. Please select more spell packs.");
	}

	const picks = poolByCat.map(cat => shuffleArray(cat).slice(0, perType));
	return [...picks[0], ...picks[1], ...picks[2]];
}
