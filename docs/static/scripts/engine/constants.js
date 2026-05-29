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
	// Fury expansion
	Fury:              { resolve: 'fury',       static: false, ischarm: false },
	// Tempest expansion
	Thunder:           { resolve: 'thunder',    static: false, ischarm: true },
	Storm_Front:       { resolve: 'storm_front', static: false, ischarm: false },
	Hurricane:         { resolve: 'hurricane',  static: false, ischarm: false },
	// Tsunami expansion
	Gush:              { resolve: 'surge_move', static: false, ischarm: true },
	Torrent:           { resolve: 'soft_hard_chain', counts: [1, 1], static: false, ischarm: false },
	Flood:             { resolve: 'soft_hard_chain', counts: [2, 2], static: false, ischarm: false },
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
	Fury:              'Sacrifice 1 stone, then make 3 hard moves.',
	Thunder:           'Pick up every enemy stone touching one of your stones, then place them on any empty nodes.',
	Storm_Front:       'Destroy any 2 enemy stones of your choice.',
	Hurricane:         'Destroy the smallest contiguous group of enemy stones. If tied, you choose which.',
	Gush:              'If you did not dash this turn, make 1 move.',
	Torrent:           'Make 1 soft move, then 1 hard move.',
	Flood:             'Make 2 soft moves, then 2 hard moves.',
	Bear_Trap:         'Destroy all enemy stones in 1-node spells.',
	Shiver:            'Swap the positions of any two stones on the board.',
	Blood_Saplings:    'If you crushed an enemy stone this turn, make 2 soft moves.',
	Itch:              'Make 1 move, then advance the enemy lock by 1.',
	Free_Spirit:       'If your lock is 0 or 1, make 1 soft move.',
	Residue_Mixture:   'If your lock is higher than the enemy lock, convert 1 enemy stone to your color and advance the enemy lock by 1.',
	Stampede:          'Make hard moves equal to your lock value (0–5).',
	Choke:             'Choose an enemy stone; place your stones on all of its empty adjacent nodes.',
	Perfect_Heist:     'Destroy every stone on the mana nodes, then occupy all three.',
	Moth_Plague:       'Make 3 hard blink moves (push any enemy stone, no adjacency required).',
};

const CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning'];
const CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind'];
const CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer'];

const SPRINGTIME_RITUALS = ['Blossom'];
const SPRINGTIME_SORCERIES = ['Scatter'];
const SPRINGTIME_CHARMS = ['Seal_of_Spring'];

const CELESTIAL_RITUALS = ['Syzygy'];
const CELESTIAL_SORCERIES = ['Eclipse'];
const CELESTIAL_CHARMS = ['Azimuth'];

const FURY_RITUALS = [];
const FURY_SORCERIES = ['Fury'];
const FURY_CHARMS = [];

const TEMPEST_RITUALS = ['Hurricane'];
const TEMPEST_SORCERIES = ['Storm_Front'];
const TEMPEST_CHARMS = ['Thunder'];

const TSUNAMI_RITUALS = ['Flood'];
const TSUNAMI_SORCERIES = ['Torrent'];
const TSUNAMI_CHARMS = ['Gush'];

const PANDA_RITUALS = ['Perfect_Heist', 'Moth_Plague'];
const PANDA_SORCERIES = ['Stampede', 'Choke'];
const PANDA_CHARMS = ['Bear_Trap', 'Shiver', 'Blood_Saplings', 'Itch', 'Free_Spirit', 'Residue_Mixture'];

const SPELL_PACKS = {
	core: {
		rituals: CORE_RITUALS,
		sorceries: CORE_SORCERIES,
		charms: CORE_CHARMS,
	},
	springtime: {
		rituals: [...CORE_RITUALS, ...SPRINGTIME_RITUALS],
		sorceries: [...CORE_SORCERIES, ...SPRINGTIME_SORCERIES],
		charms: [...CORE_CHARMS, ...SPRINGTIME_CHARMS],
	},
	celestial: {
		rituals: [...CORE_RITUALS, ...CELESTIAL_RITUALS],
		sorceries: [...CORE_SORCERIES, ...CELESTIAL_SORCERIES],
		charms: [...CORE_CHARMS, ...CELESTIAL_CHARMS],
	},
	fury: {
		rituals: [...CORE_RITUALS, ...FURY_RITUALS],
		sorceries: [...CORE_SORCERIES, ...FURY_SORCERIES],
		charms: [...CORE_CHARMS, ...FURY_CHARMS],
	},
	tempest: {
		rituals: [...CORE_RITUALS, ...TEMPEST_RITUALS],
		sorceries: [...CORE_SORCERIES, ...TEMPEST_SORCERIES],
		charms: [...CORE_CHARMS, ...TEMPEST_CHARMS],
	},
	tsunami: {
		rituals: [...CORE_RITUALS, ...TSUNAMI_RITUALS],
		sorceries: [...CORE_SORCERIES, ...TSUNAMI_SORCERIES],
		charms: [...CORE_CHARMS, ...TSUNAMI_CHARMS],
	},
	panda: {
		rituals: [...CORE_RITUALS, ...PANDA_RITUALS],
		sorceries: [...CORE_SORCERIES, ...PANDA_SORCERIES],
		charms: [...CORE_CHARMS, ...PANDA_CHARMS],
	},
	all: {
		rituals: [...CORE_RITUALS, ...SPRINGTIME_RITUALS, ...CELESTIAL_RITUALS,
		          ...FURY_RITUALS, ...TEMPEST_RITUALS, ...TSUNAMI_RITUALS, ...PANDA_RITUALS],
		sorceries: [...CORE_SORCERIES, ...SPRINGTIME_SORCERIES, ...CELESTIAL_SORCERIES,
		            ...FURY_SORCERIES, ...TEMPEST_SORCERIES, ...TSUNAMI_SORCERIES, ...PANDA_SORCERIES],
		charms: [...CORE_CHARMS, ...SPRINGTIME_CHARMS, ...CELESTIAL_CHARMS,
		         ...FURY_CHARMS, ...TEMPEST_CHARMS, ...TSUNAMI_CHARMS, ...PANDA_CHARMS],
	},
};

function shuffleArray(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function generateSpellList(packKey) {
	const pack = SPELL_PACKS[packKey] || SPELL_PACKS.core;
	const rituals = shuffleArray(pack.rituals).slice(0, 3);
	const sorceries = shuffleArray(pack.sorceries).slice(0, 3);
	const charms = shuffleArray(pack.charms).slice(0, 3);
	return [...rituals, ...sorceries, ...charms];
}
