#!/usr/bin/env node
/**
 * Picks the "Try it" position for every official spell on docs/spell.html
 * and writes docs/static/data/spell-examples.json.
 *
 *   node tools/gen_spell_examples.js [--check]
 *
 * Every example is a real position from the puzzle set
 * (docs/static/puzzles/mate_puzzles.json, recorded games):
 *   - a cast spell: a puzzle whose first stored solution casts it, preferring
 *     mate in 1, then the shortest solution;
 *   - a static seal (never cast): a puzzle in which a player holds the seal
 *     filled, preferring the side to move, or one whose winning turn fills it.
 * Spells no puzzle shows fall back to HAND_BUILT below (positions checked by
 * the browser rules: the side to move can fill and cast the spell this turn).
 * tools/browser/spell-reference-test.js loads every example in analysis.html.
 * --check exits non-zero when the committed file is stale.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const OUT = path.join(REPO, 'docs', 'static', 'data', 'spell-examples.json');
const PUZZLES = path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json');

const sandbox = { console, localStorage: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['constants.js', 'notation.js', 'board.js']) {
	vm.runInContext(fs.readFileSync(path.join(ENGINE, f), 'utf8'), sandbox, { filename: f });
}
const E = vm.runInContext('({ SigilBoard, EXPANSIONS, CORE_SPELLS, setBoardLayout })', sandbox);

const OFFICIAL_PACKS = ['core', 'springtime', 'celestial', 'fury', 'tempest', 'flood', 'autumn', 'gloom', 'covenant', 'tectonic', 'providence'];
const OFFICIAL = OFFICIAL_PACKS.flatMap(k => [...E.EXPANSIONS[k].rituals, ...E.EXPANSIONS[k].sorceries, ...E.EXPANSIONS[k].charms]);

// Positions for spells no puzzle shows. The side to move fills the spell with
// its regular move and may then cast it.
const HAND_BUILT = {
	// Blue fills b6 to complete Endowment (b2-b6), keeps 1 stone (mana b1)
	// and banks 4.
	Endowment: {
		sfn: 'rrrr.r.......bbbbb.....b..rr.........../Flourish,Endowment,Carnage,Grow,Fireblast,Hail_Storm,Sprout,Slash,Surge b 14 0:0 -:- -:- tied',
		mover: 'blue', variant: 'standard', fill: 'b6',
	},
};

function chargedOf(sfn) {
	const b = new E.SigilBoard(null, 'standard');
	b.loadFromSfn(sfn);
	b.update();
	return b.chargedSpells;
}

const data = JSON.parse(fs.readFileSync(PUZZLES, 'utf8')).puzzles;
const rank = p => [p.kind === 'mate' ? p.mate : 9, (p.solutions[0].actions || []).length, p.variant === 'standard' ? 0 : 1, p.id];
const better = (a, b) => {
	const ra = rank(a), rb = rank(b);
	for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
	return false;
};

const out = {};
for (const spell of OFFICIAL) {
	const isStatic = E.CORE_SPELLS[spell].static;
	let best = null, how = null;
	for (const p of data) {
		const sol = p.solutions && p.solutions[0];
		if (!sol || !p.sfn.split('/')[1].split(' ')[0].split(',').includes(spell)) continue;
		let h = null;
		if (!isStatic) {
			if ((sol.actions || []).some(a => a.type === 'cast' && a.spell === spell)) h = 'cast';
		} else {
			const c = chargedOf(p.sfn);
			const enemy = p.mover === 'red' ? 'blue' : 'red';
			if (c[p.mover].includes(spell)) h = 'held';
			else if (c[enemy].includes(spell)) h = 'enemy';
			else if (sol.after && chargedOf(sol.after)[p.mover].includes(spell)) h = 'fills';
		}
		if (!h) continue;
		// Statics: the mover holding it beats filling it beats the enemy holding it.
		const hr = { cast: 0, held: 0, fills: 1, enemy: 2 };
		if (!best || hr[h] < hr[how] || (hr[h] === hr[how] && better(p, best))) { best = p; how = h; }
	}
	if (best) {
		out[spell] = {
			sfn: best.sfn, how, mover: best.mover, kind: best.kind, mate: best.mate,
			puzzle: best.id, date: best.game && best.game.date, variant: best.variant,
		};
	} else if (HAND_BUILT[spell]) {
		out[spell] = Object.assign({ how: 'fill' }, HAND_BUILT[spell]);
	}
}

const missing = OFFICIAL.filter(s => !out[s]);
const json = JSON.stringify({
	generated_by: 'tools/gen_spell_examples.js',
	source: 'docs/static/puzzles/mate_puzzles.json',
	examples: out,
}, null, '\t') + '\n';
if (process.argv.includes('--check')) {
	const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
	if (cur !== json) { console.error('spell-examples.json is stale: run node tools/gen_spell_examples.js'); process.exit(1); }
} else {
	fs.writeFileSync(OUT, json);
}
const counts = {};
for (const v of Object.values(out)) counts[v.how] = (counts[v.how] || 0) + 1;
console.log(Object.keys(out).length + '/' + OFFICIAL.length + ' spells have an example', JSON.stringify(counts));
if (missing.length) console.log('missing:', missing.join(', '));
