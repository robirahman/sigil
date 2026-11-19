'use strict';
// Puzzle Racer's server side (racer.js): node --test test/racer.test.js
// The rules that go with it are in rules.test.js; the whole flow, with the
// page and several browsers, in tools/browser/puzzle-racer-emulator-test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const racer = require('../racer');
const { fakeDb } = require('./fake-db');

const T = Date.UTC(2026, 10, 19, 12);
const alice = { uid: 'alice', name: 'Alice', guest: false };
const bob = { uid: 'bob', name: 'Bob', guest: false };
const guest = (i) => ({ uid: 'anon' + i, name: 'Guest ' + i, guest: true });
const reason = (code) => (e) => e && e.raceError === code;

/** A seeded generator, so two pickers can be fed the same draws. */
function lcg(seed) {
	let s = seed >>> 0;
	return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('the sequence is Puzzle Storm\'s ramp, from the mate puzzles', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'static', 'scripts', 'puzzle-progress.js'), 'utf8');
	const ctx = { Math, JSON, Date, console };
	vm.createContext(ctx);
	vm.runInContext(src + '\n;globalThis.__p = { pickStormPuzzle, stormPool };', ctx);
	const set = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'static', 'puzzles', 'mate_puzzles.json'), 'utf8')).puzzles;
	const pool = racer.racePool();
	assert.deepStrictEqual(pool.map((p) => p.id), ctx.__p.stormPool(set).map((p) => p.id), 'the pool is stormPool');
	assert.ok(pool.length > 1000 && pool.every((p) => typeof p.rating === 'number'));
	const seq = racer.pickRaceSequence(pool, racer.RACE_PUZZLES, lcg(7));
	// The browser picker, fed the same draws, picks the same puzzles.
	const r2 = lcg(7);
	const used = {};
	const storm = [];
	for (let k = 0; k < racer.RACE_PUZZLES; k++) { const p = ctx.__p.pickStormPuzzle(ctx.__p.stormPool(set), k, used, r2); used[p.id] = 1; storm.push(p.id); }
	assert.deepStrictEqual(seq, storm);
	assert.strictEqual(new Set(seq).size, seq.length, 'no repeats');
	const rating = Object.fromEntries(pool.map((p) => [p.id, p.rating]));
	const avg = (a) => a.reduce((x, y) => x + rating[y], 0) / a.length;
	assert.ok(avg(seq.slice(-10)) > avg(seq.slice(0, 10)) + 300, 'it gets harder');
	// copy-engine.js's pool is the same list.
	assert.deepStrictEqual(racer.poolFromSet([{ id: 'w', kind: 'winning' }, { id: 'm', kind: 'mate', mate: 2, rating: 1200 }, { id: 'x', kind: 'mate', mate: 0 }]), [{ id: 'm', rating: 1200 }]);
});

test('names come from the server: the account name, or Guest and four characters', async () => {
	const db = fakeDb({ users: { alice: { displayName: '  Alice the Great  ' } } });
	assert.strictEqual(await racer.racerName(db, 'alice', false), 'Alice the Great');
	assert.strictEqual(await racer.racerName(db, 'nobody', false), 'Player');
	assert.strictEqual(await racer.racerName(db, 'xYz9-ab_Cd', true), 'Guest ABCD');
	// The callable reads the name; whatever a client sends is ignored.
	const res = await racer.handle(db, { action: 'create', public: true, name: 'Mallory' }, { uid: 'alice', guest: false }, T);
	assert.strictEqual(db.dump().puzzle_races[res.id].players.alice.name, 'Alice the Great');
});

test('a public race is listed in the lobby; a private one is not; one open lobby a host', async () => {
	const db = fakeDb();
	const pub = await racer.createRace(db, alice, { public: true }, T);
	const priv = await racer.createRace(db, bob, { public: false }, T);
	let d = db.dump();
	assert.match(pub.id, /^[A-Za-z0-9_-]{12}$/);
	assert.deepStrictEqual(d.puzzle_races[pub.id], { host: 'alice', public: true, status: 'lobby', createdAt: T, max: 10,
		players: { alice: { name: 'Alice', guest: false, joinedAt: T } } });
	assert.deepStrictEqual(d.puzzle_race_lobby, { [pub.id]: { hostName: 'Alice', n: 1, max: 10, createdAt: T } });
	assert.strictEqual(d.puzzle_races[priv.id].public, false);
	assert.deepStrictEqual(d.puzzle_race_hosts, { alice: { [pub.id]: true }, bob: { [priv.id]: true } });
	// Alice opens another: her first lobby closes and leaves the list.
	const again = await racer.createRace(db, alice, { public: true }, T + 1000);
	d = db.dump();
	assert.strictEqual(d.puzzle_races[pub.id].status, 'closed');
	assert.deepStrictEqual(Object.keys(d.puzzle_race_lobby), [again.id]);
	await assert.rejects(racer.joinRace(db, pub.id, bob, T + 2000), reason('closed'));
	// Two at once (two tabs): the host index orders them, and one stays open.
	const [x, y] = await Promise.all([racer.createRace(db, bob, { public: true }, T + 3000), racer.createRace(db, bob, { public: true }, T + 3000)]);
	d = db.dump();
	const open = [x.id, y.id, priv.id].filter((k) => d.puzzle_races[k].status === 'lobby');
	assert.deepStrictEqual(open, Object.keys(d.puzzle_race_hosts.bob), 'exactly the indexed one is open');
	assert.ok(!d.puzzle_race_lobby[x.id] !== !d.puzzle_race_lobby[y.id], 'and only it is listed');
});

test('joining: up to ten racers, never after the start, a seat left is given up', async () => {
	const db = fakeDb();
	const { id } = await racer.createRace(db, alice, { public: true }, T);
	for (let i = 1; i <= 9; i++) await racer.joinRace(db, id, guest(i), T + i);
	let d = db.dump();
	assert.strictEqual(Object.keys(d.puzzle_races[id].players).length, 10);
	assert.strictEqual(d.puzzle_race_lobby[id].n, 10);
	await assert.rejects(racer.joinRace(db, id, bob, T + 20), reason('full'));
	// Joining twice changes nothing.
	await racer.joinRace(db, id, guest(3), T + 30);
	assert.strictEqual(db.dump().puzzle_races[id].players.anon3.joinedAt, T + 3);
	// A racer who closed the tab (onDisconnect sets gone) loses the seat to a newcomer.
	await db.ref('puzzle_races/' + id + '/players/anon4/gone').set(true);
	await racer.joinRace(db, id, bob, T + 40);
	d = db.dump();
	assert.ok(d.puzzle_races[id].players.bob && !d.puzzle_races[id].players.anon4);
	assert.strictEqual(d.puzzle_race_lobby[id].n, 10);
	await assert.rejects(racer.joinRace(db, 'nosuchrace1', bob, T), reason('not-found'));
});

test('leaving a lobby: the host passes on; the last one out closes it', async () => {
	const db = fakeDb();
	const { id } = await racer.createRace(db, alice, { public: true }, T);
	await racer.joinRace(db, id, bob, T + 10);
	await racer.joinRace(db, id, guest(1), T + 20);
	await racer.leaveRace(db, id, 'alice');
	let d = db.dump();
	assert.strictEqual(d.puzzle_races[id].host, 'bob');
	assert.deepStrictEqual(d.puzzle_race_lobby[id], { hostName: 'Bob', n: 2, max: 10, createdAt: T });
	assert.deepStrictEqual(d.puzzle_race_hosts, { bob: { [id]: true } }, 'the race moves to the new host\'s index');
	// The new host opening a race of their own closes the one handed to them.
	const db2 = fakeDb();
	const h = await racer.createRace(db2, alice, { public: true }, T);
	await racer.joinRace(db2, h.id, bob, T + 1);
	await racer.joinRace(db2, h.id, guest(1), T + 2);
	await racer.leaveRace(db2, h.id, 'alice');
	const own = await racer.createRace(db2, bob, { public: true }, T + 10);
	const d2 = db2.dump();
	assert.deepStrictEqual([d2.puzzle_races[h.id].status, d2.puzzle_races[own.id].status], ['closed', 'lobby']);
	assert.deepStrictEqual(Object.keys(d2.puzzle_race_lobby), [own.id]);
	// A lobby handed to someone who hosts another open lobby closes that one.
	const db4 = fakeDb();
	const xr = await racer.createRace(db4, bob, { public: true }, T);
	const yr = await racer.createRace(db4, alice, { public: true }, T);
	await racer.joinRace(db4, yr.id, bob, T + 1);
	await racer.joinRace(db4, yr.id, guest(1), T + 2);
	await racer.leaveRace(db4, yr.id, 'alice');
	const d4 = db4.dump();
	assert.deepStrictEqual([d4.puzzle_races[xr.id].status, d4.puzzle_races[yr.id].status, d4.puzzle_races[yr.id].host], ['closed', 'lobby', 'bob']);
	assert.deepStrictEqual(d4.puzzle_race_hosts, { bob: { [yr.id]: true } });
	assert.deepStrictEqual(Object.keys(d4.puzzle_race_lobby), [yr.id]);
	await racer.leaveRace(db, id, 'bob');
	await racer.leaveRace(db, id, 'anon1');
	d = db.dump();
	assert.strictEqual(d.puzzle_races[id].status, 'closed');
	assert.ok(!d.puzzle_race_lobby);
});

test('the start: the host, two racers at least, the server\'s clock and sequence', async () => {
	const db = fakeDb();
	const { id } = await racer.createRace(db, alice, { public: true }, T);
	const pick = (n) => Array.from({ length: n }, (_, i) => 'p' + i);
	await assert.rejects(racer.startRace(db, id, 'alice', T + 5, pick), reason('too-few'));
	assert.ok(!db.dump().puzzle_race_seq, 'a refused start leaves no sequence');
	await racer.joinRace(db, id, bob, T + 10);
	await racer.joinRace(db, id, guest(1), T + 11);
	await assert.rejects(racer.startRace(db, id, 'bob', T + 20, pick), reason('not-host'));
	await assert.rejects(racer.startRace(db, id, 'mallory', T + 20, pick), reason('not-a-racer'));
	await db.ref('puzzle_races/' + id + '/players/anon1/gone').set(true);
	const res = await racer.startRace(db, id, 'alice', T + 100, pick);
	const d = db.dump();
	const r = d.puzzle_races[id];
	assert.strictEqual(res.startAt, T + 100 + racer.RACE_COUNTDOWN_MS);
	assert.deepStrictEqual([r.status, r.startAt, r.endAt, r.len], ['racing', res.startAt, res.startAt + racer.RACE_MS, racer.RACE_PUZZLES]);
	assert.match(r.seq, /^[A-Za-z0-9_-]{12}$/, 'the race names its sequence');
	assert.deepStrictEqual(Object.keys(r.players).sort(), ['alice', 'bob'], 'a racer who left is dropped');
	assert.deepStrictEqual(r.players.bob.p, { n: 0, score: 0, at: 0, st: 0 });
	assert.strictEqual(r.players.bob.gone, false);
	assert.deepStrictEqual(d.puzzle_race_seq[id], { [r.seq]: pick(racer.RACE_PUZZLES) }, 'written before the start committed, under its key');
	assert.ok(!d.puzzle_race_lobby, 'off the lobby list');
	assert.ok(!d.puzzle_race_hosts, 'and out of the host index');
	await assert.rejects(racer.startRace(db, id, 'alice', T + 200, pick), reason('started'));
	assert.deepStrictEqual(db.dump().puzzle_race_seq[id], { [r.seq]: pick(racer.RACE_PUZZLES) }, 'a second start keeps the first sequence');
	// A start that loses inside the transaction removes its own sequence only.
	const db3 = fakeDb();
	const r3 = await racer.createRace(db3, alice, {}, T);
	await racer.joinRace(db3, r3.id, bob, T);
	const realRef = db3.ref;
	db3.ref = (p) => {
		const x = realRef(p);
		if (p === 'puzzle_races/' + r3.id) {
			const tx = x.transaction;
			x.transaction = async (fn) => { db3.ref = realRef; await racer.startRace(db3, r3.id, 'alice', T + 1, pick); return tx(fn); };
		}
		return x;
	};
	await assert.rejects(racer.startRace(db3, r3.id, 'alice', T + 2, (n) => Array.from({ length: n }, () => 'other')), reason('started'));
	const d3 = db3.dump();
	assert.deepStrictEqual(Object.keys(d3.puzzle_race_seq[r3.id]), [d3.puzzle_races[r3.id].seq]);
	assert.strictEqual(d3.puzzle_race_seq[r3.id][d3.puzzle_races[r3.id].seq][0], 'p0');
	await assert.rejects(racer.joinRace(db, id, guest(2), T + 300), reason('started'));
	await assert.rejects(racer.leaveRace(db, id, 'bob'), reason('started'));
	// The real pool: sixty distinct puzzles.
	const db2 = fakeDb();
	const r2 = await racer.createRace(db2, alice, {}, T);
	await racer.joinRace(db2, r2.id, bob, T);
	await racer.startRace(db2, r2.id, 'alice', T);
	const seq = Object.values(db2.dump().puzzle_race_seq[r2.id])[0];
	assert.strictEqual(new Set(seq).size, racer.RACE_PUZZLES);
});

test('a host who left does not hold the race up', async () => {
	const db = fakeDb();
	const { id } = await racer.createRace(db, alice, { public: false }, T);
	await racer.joinRace(db, id, bob, T + 1);
	await racer.joinRace(db, id, guest(1), T + 2);
	await db.ref('puzzle_races/' + id + '/players/alice/gone').set(true);
	await racer.startRace(db, id, 'bob', T + 10, (n) => Array.from({ length: n }, (_, i) => 'q' + i));
	const r = db.dump().puzzle_races[id];
	assert.strictEqual(r.host, 'bob');
	assert.deepStrictEqual(Object.keys(r.players).sort(), ['anon1', 'bob']);
});

test('a rematch: the first racer opens it, the rest join it', async () => {
	const db = fakeDb();
	const pick = (n) => Array.from({ length: n }, (_, i) => 'p' + i);
	const { id } = await racer.createRace(db, alice, { public: true }, T);
	await racer.joinRace(db, id, bob, T + 1);
	await racer.joinRace(db, id, guest(1), T + 2);
	const { endAt } = await racer.startRace(db, id, 'alice', T + 10, pick);
	await assert.rejects(racer.rematchRace(db, id, bob, endAt - 1), reason('not-finished'));
	await assert.rejects(racer.rematchRace(db, id, guest(2), endAt + 1), reason('not-a-racer'));
	const first = await racer.rematchRace(db, id, bob, endAt + 1000);
	let d = db.dump();
	assert.strictEqual(d.puzzle_races[id].next, first.id);
	assert.deepStrictEqual([d.puzzle_races[first.id].host, d.puzzle_races[first.id].public, d.puzzle_races[first.id].status], ['bob', true, 'lobby']);
	assert.ok(d.puzzle_race_lobby[first.id]);
	const second = await racer.rematchRace(db, id, alice, endAt + 2000);
	assert.strictEqual(second.id, first.id);
	d = db.dump();
	assert.deepStrictEqual(Object.keys(d.puzzle_races[first.id].players).sort(), ['alice', 'bob']);
	// Two asking at once: the one whose link lands second joins the first's.
	await db.ref('puzzle_races/' + id + '/next').remove();
	const realOnce = db.ref;
	let raced = false;
	db.ref = (p) => {
		const r = realOnce(p);
		if (p === 'puzzle_races/' + id + '/next' && !raced) {
			raced = true;
			const tx = r.transaction;
			r.transaction = async (fn) => { await realOnce(p).set(first.id); return tx(fn); };
		}
		return r;
	};
	const third = await racer.rematchRace(db, id, guest(1), endAt + 3000, 'losingRace01');
	db.ref = realOnce;
	d = db.dump();
	assert.strictEqual(third.id, first.id);
	assert.ok(!d.puzzle_races.losingRace01 && !(d.puzzle_race_lobby || {}).losingRace01, 'the losing rematch is removed');
	assert.ok(d.puzzle_races[first.id].players.anon1);
	// A linked rematch nobody can join any more (everyone left it) is replaced.
	for (const u of ['bob', 'alice', 'anon1']) await racer.leaveRace(db, first.id, u);
	assert.strictEqual(db.dump().puzzle_races[first.id].status, 'closed');
	const fresh = await racer.rematchRace(db, id, alice, endAt + 4000);
	d = db.dump();
	assert.notStrictEqual(fresh.id, first.id);
	assert.strictEqual(d.puzzle_races[id].next, fresh.id);
	assert.deepStrictEqual([d.puzzle_races[fresh.id].host, d.puzzle_races[fresh.id].status], ['alice', 'lobby']);
	// ... and so is a full one.
	for (let i = 10; i < 19; i++) await racer.joinRace(db, fresh.id, guest(i), endAt + 5000);
	const third2 = await racer.rematchRace(db, id, bob, endAt + 6000);
	d = db.dump();
	assert.notStrictEqual(third2.id, fresh.id);
	assert.strictEqual(d.puzzle_races[id].next, third2.id);
	assert.strictEqual(d.puzzle_races[third2.id].host, 'bob');
});

test('the sweep: stale lobbies, abandoned lobbies, old races and leftovers go', async () => {
	const M = 60000;
	const lobby = (createdAt, players, pub) => ({ host: 'h', public: pub !== false, status: 'lobby', createdAt, max: 10, players });
	const here = { name: 'A', joinedAt: 1 };
	const db = fakeDb({
		puzzle_races: {
			stale: lobby(T - 31 * M, { h: here }),
			empty: lobby(T - 3 * M, { h: Object.assign({ gone: true }, here) }),
			fresh: lobby(T - 3 * M, { h: here, b: Object.assign({ gone: true }, here) }),
			young: lobby(T - 1 * M, { h: Object.assign({ gone: true }, here) }),
			closed: Object.assign(lobby(T - 5 * M, {}), { status: 'closed' }),
			oldRace: { host: 'h2', status: 'racing', createdAt: T - 200 * M, startAt: T - 199 * M, endAt: T - 197 * M, players: {} },
			doneRace: { host: 'h3', status: 'racing', createdAt: T - 20 * M, startAt: T - 19 * M, endAt: T - 17 * M, players: {} },
		},
		puzzle_race_seq: { oldRace: ['a'], doneRace: ['b'] },
		puzzle_race_lobby: {
			stale: { hostName: 'A', n: 1, max: 10, createdAt: T - 31 * M },
			fresh: { hostName: 'A', n: 2, max: 10, createdAt: T - 3 * M },
			doneRace: { hostName: 'A', n: 2, max: 10, createdAt: T - 20 * M },
			ghost: { hostName: 'A', n: 2, max: 10, createdAt: T - 20 * M },
		},
		puzzle_race_hosts: { h: { fresh: true }, h2: { oldRace: true }, h3: { doneRace: true } },
	});
	const n = await racer.sweepRaces(db, T);
	const d = db.dump();
	assert.strictEqual(n, 4);
	assert.deepStrictEqual(Object.keys(d.puzzle_races).sort(), ['doneRace', 'fresh', 'young']);
	assert.deepStrictEqual(Object.keys(d.puzzle_race_seq), ['doneRace']);
	assert.deepStrictEqual(Object.keys(d.puzzle_race_lobby), ['fresh']);
	assert.strictEqual(d.puzzle_race_lobby.fresh.n, 1, 'the listing counts who is still there');
	assert.deepStrictEqual(d.puzzle_race_hosts, { h: { fresh: true }, h3: { doneRace: true } });
});

test('the callable refuses malformed requests', async () => {
	const db = fakeDb();
	await assert.rejects(racer.handle(db, { action: 'join', id: '../users' }, { uid: 'a' }, T), reason('bad-request'));
	await assert.rejects(racer.handle(db, { action: 'join' }, { uid: 'a' }, T), reason('bad-request'));
	await assert.rejects(racer.handle(db, { action: 'explode', id: 'abcdefabcdef' }, { uid: 'a' }, T), reason('bad-request'));
	await assert.rejects(racer.handle(db, null, { uid: 'a' }, T), reason('bad-request'));
	const g = await racer.handle(db, { action: 'create' }, { uid: 'anonUid1234', guest: true }, T);
	const r = db.dump().puzzle_races[g.id];
	assert.deepStrictEqual([r.public, r.players.anonUid1234.name, r.players.anonUid1234.guest], [false, 'Guest 1234', true]);
});
