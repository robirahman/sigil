#!/usr/bin/env node
// Rated games from a position (elo.js + position-rating.js), checked without a browser.
//   1. A standard game's Elo change is exactly the old formula (1..32 floor).
//   2. From a position, each side's expected rating change is zero when the
//      position's odds are right, at any rating gap; changes stay within
//      0..32 and zero-sum; a forced win (p 0 or 1) pays +0 / -32, never NaN.
//   3. positionRedWinProb: proven mates are certain, likely mates use the
//      calibrated rate, a depth picks the deepest fitted curve at or below it,
//      a shallower search has no price.
//   5. processEloClientSide writes the position-adjusted exchange for a game
//      record with startPos, and the old one without.
//   4. positionTurnSfn advances the turn counter and hands the move to its
//      parity's side, as GameController does before each turn.
//
//   node tools/position-rating-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const FILES = ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'sim-board.js',
	'elo.js', 'position-rating.js'];
let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += `\n;\n(${driver.toString()})().catch((e) => { console.error(e); process.exit(1); });\n`;
new Function('require', src)(require);

async function driver() {
	const assert = (c, m) => { if (!c) throw new Error(m); };

	// 1. Standard games: the old formula.
	for (const w of [600, 1000, 1400, 1800]) {
		for (const l of [600, 1000, 1400, 1800]) {
			const old = Math.max(1, Math.round(32 / (1 + Math.pow(10, (w - l) / 400))));
			assert(computeEloChange(w, l) === old, `standard ${w} vs ${l}`);
		}
	}

	// 2. From a position.
	for (const p of [0, 0.001, 0.05, 0.3, 0.5, 0.71, 0.95, 0.999, 1]) {
		for (const [rr, rb] of [[1500, 1500], [1200, 1733], [1733, 1200], [1000, 1600]]) {
			const pay = positionPayoffs(p, rr, rb);
			for (const side of ['red', 'blue']) {
				const v = pay[side];
				assert(Number.isFinite(v.win) && Number.isFinite(v.loss), `finite ${p} ${side}`);
				assert(v.win >= 0 && v.win <= 32 && v.loss <= 0 && v.loss >= -32, `range ${p} ${side}`);
			}
			assert(pay.red.win === -pay.blue.loss && pay.blue.win === -pay.red.loss, `zero-sum ${p}`);
			const eRed = positionExpectedScore(p, rr, rb);
			const evRed = eRed * pay.red.win + (1 - eRed) * pay.red.loss;
			const evBlue = (1 - eRed) * pay.blue.win + eRed * pay.blue.loss;
			// Rounding to whole points is the only source of a non-zero mean.
			assert(Math.abs(evRed) <= 0.5 && Math.abs(evBlue) <= 0.5, `EV ${p} ${rr}/${rb}: ${evRed} ${evBlue}`);
			// Unrounded: exactly zero.
			const exact = eRed * 32 * (1 - eRed) - (1 - eRed) * 32 * eRed;
			assert(Math.abs(exact) < 1e-9, 'unrounded EV');
		}
	}
	let pay = positionPayoffs(1, 1000, 1800);
	assert(pay.red.win === 0 && pay.red.loss === -32 && pay.blue.win === 32 && pay.blue.loss === 0, 'red forced win');
	pay = positionPayoffs(0, 1800, 1000);
	assert(pay.blue.win === 0 && pay.blue.loss === -32, 'blue forced win');
	assert(computeEloChange(1500, 1500, 0.5) === 16, 'even position, equal ratings: 16');
	assert(computeEloChange(1500, 1500, 0.99) === 0, 'no 1-point floor from a position');

	// 3. Pricing.
	const model = { version: 't', depths: {
		'4': { a: 0, b: 0.5, c: 0.1, likelyMateWin: 0.9 },
		'6': { a: 0, b: 1.0, c: 0.1, likelyMateWin: 0.95 } } };
	const red = 'r....../Sprout r 3 0:0 -:- -:- b1', blue = 'r....../Sprout b 4 0:0 -:- -:- b1';
	assert(positionRedWinProb(model, { depth: 5, mateIn: 2, proven: true }, red) === 1, 'proven red');
	assert(positionRedWinProb(model, { depth: 5, mateIn: -2, proven: true }, red) === 0, 'proven blue');
	assert(Math.abs(positionRedWinProb(model, { depth: 5, mateIn: -2, proven: false }, red) - 0.1) < 1e-12, 'likely blue at d4 curve');
	assert(positionRedWinProb(model, { depth: 3, stones: 1 }, red) === null, 'too shallow');
	const p4 = positionRedWinProb(model, { depth: 4, stones: 1, mateIn: null, proven: true }, red);
	assert(Math.abs(p4 - 1 / (1 + Math.exp(-0.6))) < 1e-12, 'd4 red to move');
	const p7 = positionRedWinProb(model, { depth: 7, stones: 1, mateIn: null, proven: true }, blue);
	assert(Math.abs(p7 - 1 / (1 + Math.exp(-1))) < 1e-12, 'd7 uses the d6 curve, blue to move');

	// 4. The first turn's SFN.
	const b = new SigilBoard(generateSpellList(['core']), 'standard');
	b.setupInitial();
	const s0 = boardToSfn(b);
	const t0 = positionTurnSfn(s0).split(' ');
	assert(Number(t0[2]) === Number(s0.split(' ')[2]) + 1, 'counter advances');
	assert(t0[1] === (Number(t0[2]) % 2 === 1 ? 'r' : 'b'), 'side from parity');
	const t1 = positionTurnSfn(positionTurnSfn(s0)).split(' ');
	assert(t1[1] !== t0[1], 'next turn, other side');

	// 5. The Elo write.
	const fakeDb = (users) => {
		const db = { updates: null };
		db.ref = (path) => ({
			once: async () => {
				const parts = (path || '').split('/');
				let v = parts[0] === 'users' ? users[parts[1]] : null;
				if (parts[0] === 'leaderboard') v = null;
				return { val: () => v, exists: () => v !== null && v !== undefined };
			},
			update: async (u) => { db.updates = u; },
		});
		return db;
	};
	const users = { h: { elo: 1500, displayName: 'H' }, a: { elo: 1733, displayName: 'AI', isAI: true } };
	let db = fakeDb(users);
	await processEloClientSide(db, 'g1', { ranked: true, redUid: 'h', blueUid: 'a', winner: 'red',
		startPos: { redWinProb: 0.9 } });
	const e = positionExpectedScore(0.9, 1500, 1733);
	assert(db.updates['users/h/elo'] === 1500 + Math.round(32 * (1 - e)), 'red win from a position');
	assert(db.updates['users/a/elo'] === 1733 - Math.round(32 * (1 - e)), 'zero-sum');
	assert(db.updates['user_games/h/g1'].fromPosition === true, 'user_games marks fromPosition');
	assert(Math.abs(db.updates['completed_games/g1/redExpected'] - e) < 1e-12, 'redExpected recorded');
	db = fakeDb(users);
	await processEloClientSide(db, 'g2', { ranked: true, redUid: 'h', blueUid: 'a', winner: 'red' });
	assert(db.updates['users/h/elo'] === 1500 + computeEloChange(1500, 1733), 'standard game unchanged');
	assert(db.updates['completed_games/g2/redExpected'] === undefined, 'no redExpected on a standard game');

	console.log('position-rating-smoke: all checks passed');
}
