'use strict';
/**
 * Matchmaking pools: the server pairs the players waiting for the same game
 * (engine/match-pools.js), so two clients can never both claim one opponent.
 *
 *   mm_tickets/{uid}   { bucket, at, ping }: written by the player (one ticket
 *                      each, by construction); `match` and `error` are the
 *                      server's (database.rules.json).
 *   mm_matches/{id}    { bucket, host, guest, hostName, guestName, hostRating,
 *                      hostRd, guestRating, guestRd, at }: the server's; the
 *                      host adds `room`, the invite-only room it created for
 *                      the guest, once. Readable by the two players.
 *   mm_counts/{bucket} how many tickets wait in the bucket (public).
 *
 * A pairing pass (matchBucket) runs for a ticket's bucket whenever a ticket
 * is written (index.js matchmake: one instance, one event at a time, so passes
 * never overlap) and for every bucket once a minute (sweep, from
 * expireClocks). Each pair is claimed ticket by ticket in transactions: a
 * ticket withdrawn meanwhile aborts the pair, and the other ticket is let go.
 *
 * Everything takes the database and the account checks as arguments, so the
 * tests run it on test/fake-db.js.
 */

const crypto = require('crypto');
const { requireShared } = require('./engine-loader');
const Match = requireShared('match-pools.js');
const Glicko = requireShared('glicko.js');

/** A transaction on a ticket. `fn` sees the stored ticket (never null). */
function ticketTx(db, uid, fn) {
	// Null at first means "not known locally yet": writing null back makes the
	// server answer with its copy, and fn runs again on that.
	return db.ref('mm_tickets/' + uid).transaction((cur) => (cur === null ? null : fn(cur)));
}

/** Drop a ticket nobody has stamped for STALE_MS (unless it changed since it was read). */
async function dropStale(db, uid, seen) {
	await ticketTx(db, uid, (cur) => (cur.ping === seen.ping && !cur.match ? null : undefined));
}

/** Tell a waiting ticket why it cannot be paired ('sign-in', 'suspended'). */
async function refuse(db, uid, seen, code) {
	await ticketTx(db, uid, (cur) => (cur.at === seen.at && !cur.match && !cur.error
		? Object.assign({}, cur, { error: code }) : undefined));
}

/**
 * A player's rating in `pool` for pairing: their Glicko-2 record (deviation
 * grown to `now`), else the seed their first game there would get (their
 * Elo), else a new rating for a guest.
 */
async function ratingFor(db, uid, pool, now, guest) {
	if (guest) return Glicko.seed(null, 0, now);
	const [rec, elo, played] = await Promise.all([
		db.ref('ratings/' + uid + '/' + pool).once('value'),
		db.ref('users/' + uid + '/elo').once('value'),
		db.ref('users/' + uid + '/gamesPlayed').once('value'),
	]);
	const g = Glicko.normalize(rec.val());
	if (g) return Object.assign(g, { rd: Glicko.currentRd(g, now) });
	return Glicko.seed(elo.val(), played.val() || 0, now);
}

/**
 * Claim one pair: the match record first, then the host's ticket, then the
 * guest's. Any ticket gone, changed or taken meanwhile undoes the claim.
 * @returns {Promise<string|null>} the match id, or null
 */
async function claimPair(db, bucket, host, guest, now) {
	const id = 'm' + now.toString(36) + crypto.randomBytes(5).toString('hex');
	const r = (x) => Math.round(x);
	await db.ref('mm_matches/' + id).set({
		bucket, at: now,
		host: host.uid, hostName: host.name, hostRating: r(host.r), hostRd: r(host.rd),
		guest: guest.uid, guestName: guest.name, guestRating: r(guest.r), guestRd: r(guest.rd),
	});
	const claim = (t) => ticketTx(db, t.uid, (cur) => (cur.bucket === bucket && cur.at === t.at && !cur.match && !cur.error
		? Object.assign({}, cur, { match: id }) : undefined));
	const held = (res) => !!(res && res.committed && res.snapshot.val() && res.snapshot.val().match === id);
	if (!held(await claim(host))) {
		await db.ref('mm_matches/' + id).remove();
		return null;
	}
	if (!held(await claim(guest))) {
		await ticketTx(db, host.uid, (cur) => (cur.match === id ? Object.assign({}, cur, { match: null }) : undefined));
		await db.ref('mm_matches/' + id).remove();
		return null;
	}
	return id;
}

/**
 * One pairing pass over a bucket.
 * @param {object} db - admin database (or test/fake-db.js)
 * @param {string} bucket
 * @param {number} now - server ms
 * @param {object} deps - { isFullAccount(uid), isSuspended(uid) }
 * @returns {Promise<{ paired: string[], waiting: number }>} the match ids made
 *   and the tickets left waiting
 */
async function matchBucket(db, bucket, now, deps) {
	const spec = Match.parseBucket(bucket);
	if (!spec) return { paired: [], waiting: 0 };
	const pool = Glicko.poolOf(spec.variant, spec.timeControl);
	const all = (await db.ref('mm_tickets').once('value')).val() || {};
	const tickets = [];
	for (const [uid, t] of Object.entries(all)) {
		if (!t || t.bucket !== bucket || t.match || t.error) continue;
		if (typeof t.ping !== 'number' || typeof t.at !== 'number' || now - t.ping > Match.C.STALE_MS) {
			await dropStale(db, uid, t);
			continue;
		}
		const full = await deps.isFullAccount(uid);
		// The rules keep guests out of rated buckets; this is the server's own check.
		if (spec.rated && !full) { await refuse(db, uid, t, 'sign-in'); continue; }
		if (spec.rated && deps.isSuspended && (await deps.isSuspended(uid))) { await refuse(db, uid, t, 'suspended'); continue; }
		const [rating, blocks, name] = await Promise.all([
			ratingFor(db, uid, pool, now, !full),
			db.ref('blocks/' + uid).once('value'),
			full ? db.ref('users/' + uid + '/displayName').once('value') : Promise.resolve(null),
		]);
		const nm = name && name.val();
		tickets.push({
			uid, at: t.at, r: rating.r, rd: rating.rd,
			blocks: Object.keys(blocks.val() || {}),
			name: typeof nm === 'string' && nm ? nm.slice(0, 30) : 'Guest',
		});
	}
	const paired = [];
	for (const [host, guest] of Match.pairTickets(tickets, now)) {
		const id = await claimPair(db, bucket, host, guest, now);
		if (id) paired.push(id);
	}
	const waiting = tickets.length - 2 * paired.length;
	await db.ref('mm_counts/' + bucket).set(waiting > 0 ? waiting : null);
	return { paired, waiting };
}

/**
 * Once a minute: drop stale tickets and old matches, and pair every bucket
 * again (a hidden tab may stamp its ticket only once a minute).
 */
async function sweep(db, now, deps) {
	const all = (await db.ref('mm_tickets').once('value')).val() || {};
	const buckets = new Set();
	for (const [uid, t] of Object.entries(all)) {
		if (!t) continue;
		if (t.match) {
			// A match the players never finished setting up.
			const m = (await db.ref('mm_matches/' + t.match).once('value')).val();
			if (!m || now - (m.at || 0) > Match.C.MATCH_TTL_MS) {
				await ticketTx(db, uid, (cur) => (cur.match === t.match ? null : undefined));
			}
			continue;
		}
		if (typeof t.ping !== 'number' || now - t.ping > Match.C.STALE_MS) {
			await dropStale(db, uid, t);
			continue;
		}
		if (!t.error && typeof t.bucket === 'string') buckets.add(t.bucket);
	}
	const matches = (await db.ref('mm_matches').once('value')).val() || {};
	let dropped = 0;
	for (const [id, m] of Object.entries(matches)) {
		if (!m || now - (m.at || 0) > Match.C.MATCH_TTL_MS) {
			await db.ref('mm_matches/' + id).remove();
			dropped++;
		}
	}
	// Counts of buckets nobody waits in any more.
	const counts = (await db.ref('mm_counts').once('value')).val() || {};
	for (const b of Object.keys(counts)) if (!buckets.has(b)) await db.ref('mm_counts/' + b).remove();
	let paired = 0;
	for (const b of buckets) paired += (await matchBucket(db, b, now, deps)).paired.length;
	return { paired, dropped };
}

module.exports = { matchBucket, sweep, claimPair, ratingFor };
