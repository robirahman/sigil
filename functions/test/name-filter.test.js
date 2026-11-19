'use strict';
// The offensive-name filter (docs/static/scripts/engine/name-filter.js), the
// functions that enforce it (names.js), and the preferences schema
// (docs/static/scripts/prefs.js) against database.rules.json:
//   cd functions && npm test
// The prefs rules themselves are exercised on the emulator in rules.test.js.

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const names = require('../names');

const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'docs', 'static', 'scripts', 'engine', 'name-filter.js'));
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8')).rules;

test('blocks offensive names, however they are spelled', () => {
	const bad = ['fuck', 'FuCk_you', 'xXfuckerXx', 'f.u.c.k', 'f u c k', 'fuuuuck', 'fvck', 'Motherfucker',
		'f4gg0t', 'b!tch', 'B1TCH', '$hit', 'sh1t', 'Shit99', 'n1gg3r', 'niggers', 'Nigga', 'cunt', 'CUNTS',
		'twat', 'Retarded', 'rape', 'porn', 'kys', 'Hitler_fan', 'sieg heil', 'Sieg_Heil', 'kill_your_self',
		'wet-back', 'dickhead', 'asshole', 'Tits', 'FVCK', 'B.I.T.C.H', 'FÜCK', 'ｆｕｃｋ', 'fück', 'Bïtch'];
	for (const n of bad) assert.ok(!F.allowed(n), n + ' should be blocked');
});

test('passes ordinary words and names (the Scunthorpe problem)', () => {
	const good = ['Scunthorpe', 'Scunthorpe United', 'Dickens', 'Dick', 'grape', 'analysis', 'therapist', 'Pakistan',
		'Essex', 'Sussex', 'Middlesex', 'Hancock', 'peacock', 'cocktail', 'snigger', 'sniggering', 'niggardly',
		'Penistone', 'Ashita', 'Yoshitaka', 'Livshitz', 'cucumber', 'document', 'circumstance', 'Analía', 'José María',
		'Nesbit Chen', 'Rabbit_Chaser', 'Rabbit Charlie', 'Bob Itchy', 'A55', '7175', 'Player_7175', 'Saltwater',
		'swanky', 'Slutsky', 'spice', 'raccoon', 'Japan', 'classic', 'assassin', 'Arsenal', 'Shitake', 'shiite',
		'whittler', 'Pennisi', 'retardant', 'Pissarro', 'Siriporn', 'Fukuoka', 'Jack Offord', 'Dick Headley',
		'Kike', 'Nazi Paikidze', 'Player1', 'Robi', 'Guest', 'Player'];
	for (const n of good) assert.ok(F.allowed(n), n + ' should pass (matched ' + F.match(n) + ')');
});

test('match() names the term and agrees with allowed()', () => {
	assert.strictEqual(F.match('xXfuckerXx'), 'fuck');
	assert.strictEqual(F.match('Sieg_Heil'), 'siegheil');
	assert.strictEqual(F.match('Scunthorpe'), null);
	for (const n of ['b!tch', 'Dickens', 'kys', 'sky']) assert.strictEqual(F.allowed(n), F.match(n) === null, n);
	assert.strictEqual(F.safe('shit'), 'Player');
	assert.strictEqual(F.safe('Robi'), 'Robi');
	assert.strictEqual(F.allowed(null), false);
});

// A database reference that records what the trigger did.
function fakeRef() {
	const r = { writes: [], set(v) { r.writes.push(['set', v]); return Promise.resolve(); }, remove() { r.writes.push(['remove']); return Promise.resolve(); } };
	return r;
}

test('the server puts back Player for a refused name, and leaves the rest', async () => {
	assert.strictEqual(names.NameFilter, F, 'the functions use the site\'s own filter');
	let ref = fakeRef();
	assert.strictEqual(await names.enforceName(ref, 'xXfuckerXx'), true);
	assert.deepStrictEqual(ref.writes, [['set', 'Player']]);
	for (const v of ['Scunthorpe', 'Player', 'Guest', null, undefined, 42]) {
		ref = fakeRef();
		assert.strictEqual(await names.enforceName(ref, v), false, String(v));
		assert.deepStrictEqual(ref.writes, []);
	}
	assert.deepStrictEqual(names.NAME_LISTS, ['users', 'leaderboard', 'storm_leaderboard', 'puzzle_leaderboard']);
});

test('the server drops a refused usernames/ claim, not a deleted or allowed one', async () => {
	let ref = fakeRef();
	assert.strictEqual(await names.enforceUsername(ref, 'sh1t_head', 'uid1'), true);
	assert.deepStrictEqual(ref.writes, [['remove']]);
	ref = fakeRef();
	assert.strictEqual(await names.enforceUsername(ref, 'sh1t_head', null), false);
	assert.strictEqual(await names.enforceUsername(ref, 'scunthorpe', 'uid1'), false);
	assert.deepStrictEqual(ref.writes, []);
});

test('functions/ deploys the filter with the engine files', () => {
	const { SHARED_FILES } = require('../engine-loader');
	assert.ok(SHARED_FILES.includes('name-filter.js'));
});

test('the account copy of the preferences matches the rules', () => {
	const src = fs.readFileSync(path.join(ROOT, 'docs', 'static', 'scripts', 'prefs.js'), 'utf8');
	const m = src.match(/const SIGIL_PREF_DEFS = (\{[\s\S]*?\n\});/);
	assert.ok(m, 'SIGIL_PREF_DEFS found');
	const defs = Function('return ' + m[1])();
	const synced = Object.keys(defs).filter((k) => defs[k].sync).sort();
	const ruled = Object.keys(RULES.users.$uid.prefs).filter((k) => !k.startsWith('.') && k !== '$other').sort();
	assert.deepStrictEqual(ruled, synced);
});
