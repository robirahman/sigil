#!/usr/bin/env node
// Lists the names stored before the offensive-name filter
// (docs/static/scripts/engine/name-filter.js) that it refuses, and with
// --apply resets them the way the filterNames functions do: 'Player' in
// users/, leaderboard/, storm_leaderboard/ and puzzle_leaderboard/ (which
// makes account.html ask the player for a new name), and the usernames/
// claim removed. Room seats are only listed (--rooms): finished games keep
// the names they were played under.
//
//   # Dry run: list what would change
//   node tools/name-filter/audit-names.js --service-account firebase-service-account.json
//   # Change it
//   node tools/name-filter/audit-names.js --service-account firebase-service-account.json --apply
//   # Against the emulator
//   node tools/name-filter/audit-names.js --emulator 127.0.0.1:9000 [--ns sigil-js-default-rtdb]
//
// The service-account token comes from firebase-admin (functions/node_modules).
'use strict';
const fs = require('fs');
const path = require('path');
const F = require(path.join(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine', 'name-filter.js'));

const LISTS = ['users', 'leaderboard', 'storm_leaderboard', 'puzzle_leaderboard'];
const PLACEHOLDER = 'Player';

function args() {
	const a = process.argv.slice(2);
	const opt = (name, dflt) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : dflt; };
	return {
		serviceAccount: opt('--service-account', null),
		dbUrl: opt('--db-url', 'https://sigil-js-default-rtdb.firebaseio.com'),
		emulator: opt('--emulator', null),
		ns: opt('--ns', 'sigil-js-default-rtdb'),
		apply: a.includes('--apply'),
		rooms: a.includes('--rooms'),
	};
}

async function client(o) {
	if (o.emulator) {
		const base = 'http://' + o.emulator;
		return { url: (p, q) => `${base}/${p}.json?ns=${o.ns}${q ? '&' + q : ''}`, headers: { Authorization: 'Bearer owner' } };
	}
	if (!o.serviceAccount) throw new Error('--service-account <file> (or --emulator host:port) is required');
	let admin;
	try { admin = require(path.join(__dirname, '..', '..', 'functions', 'node_modules', 'firebase-admin')); } catch (e) { admin = require('firebase-admin'); }
	const cred = admin.credential.cert(JSON.parse(fs.readFileSync(o.serviceAccount, 'utf8')));
	const { access_token: token } = await cred.getAccessToken();
	const base = o.dbUrl.replace(/\/$/, '');
	return { url: (p, q) => `${base}/${p}.json${q ? '?' + q : ''}`, headers: { Authorization: 'Bearer ' + token } };
}

async function getJson(c, p, q) {
	const r = await fetch(c.url(p, q), { headers: c.headers });
	if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${await r.text()}`);
	return r.json();
}

(async () => {
	const o = args();
	const c = await client(o);
	const updates = {};
	let found = 0;
	for (const list of LISTS) {
		// Keys only, then each name: users/ holds far more than names.
		const keys = Object.keys((await getJson(c, list, 'shallow=true')) || {});
		for (let i = 0; i < keys.length; i += 50) {
			const batch = keys.slice(i, i + 50);
			const got = await Promise.all(batch.map((k) => getJson(c, `${list}/${encodeURIComponent(k)}/displayName`)));
			batch.forEach((k, j) => {
				const name = got[j];
				if (typeof name !== 'string' || F.allowed(name)) return;
				found++;
				console.log(`${list}/${k}/displayName  ${JSON.stringify(name)}  (${F.match(name)})`);
				updates[`${list}/${k}/displayName`] = PLACEHOLDER;
			});
		}
	}
	const claims = (await getJson(c, 'usernames')) || {};
	for (const [key, uid] of Object.entries(claims)) {
		if (F.allowed(key)) continue;
		found++;
		console.log(`usernames/${key}  -> ${uid}  (${F.match(key)})`);
		updates[`usernames/${key}`] = null;
	}
	if (o.rooms) {
		const rooms = (await getJson(c, 'rooms')) || {};
		for (const [code, room] of Object.entries(rooms)) {
			for (const seat of ['red', 'blue']) {
				const name = room && room[seat] && room[seat].displayName;
				if (typeof name === 'string' && !F.allowed(name)) console.log(`rooms/${code}/${seat}/displayName  ${JSON.stringify(name)}  (listed only)`);
			}
		}
	}
	console.log(`${found} refused name(s).`);
	if (!o.apply || !Object.keys(updates).length) {
		if (Object.keys(updates).length) console.log('Dry run: nothing changed. Run again with --apply to reset them.');
		return;
	}
	const r = await fetch(c.url(''), { method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, c.headers), body: JSON.stringify(updates) });
	if (!r.ok) throw new Error(`PATCH: ${r.status} ${await r.text()}`);
	console.log(`Reset ${Object.keys(updates).length} value(s).`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
