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
};

const SPELL_TEXTS = {
	Flourish:          'Make 4 soft moves.',
	Carnage:           'Make 4 hard moves.',
	Bewitch:           'Choose 2 enemy stones touching each other. Convert them to your color.',
	Starfall:          'Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them.',
	Seal_of_Lightning: 'STATIC: Your dash only requires 1 sacrifice.',
	Grow:              'Make 2 soft moves.',
	Fireblast:         'Destroy all enemy stones which are touching you.',
	Hail_Storm:        'Destroy 1 enemy stone in each 3-node and 5-node spell.',
	Meteor:            'Make 1 blink move, then destroy 1 enemy stone touching it.',
	Seal_of_Wind:      'STATIC: Your first move each turn is a blink move.',
	Sprout:            'Make 1 soft move.',
	Slash:             'Make 1 hard move.',
	Surge:             'If you dashed this turn, make 1 move.',
	Comet:             'Make 1 blink move, then sacrifice a stone.',
	Seal_of_Summer:    'STATIC: You may cast 2 spells on your turn.',
};

const CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning'];
const CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind'];
const CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer'];

function shuffleArray(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function generateSpellList() {
	const rituals = shuffleArray(CORE_RITUALS).slice(0, 3);
	const sorceries = shuffleArray(CORE_SORCERIES).slice(0, 3);
	const charms = shuffleArray(CORE_CHARMS).slice(0, 3);
	return [...rituals, ...sorceries, ...charms];
}
