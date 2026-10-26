'use strict';
/**
 * Server analysis of rated games: the review the browser's Quick Review
 * computes (game-review.js reviewGameRust, last position to first), searched
 * longer (RUST_SERVER_PRESET, 1 s/position), written as the
 * `game_evals/{roomCode}` document the review panel already reads
 * (rustEvalsToReview), so both players find the review ready.
 *
 * index.js `analyzeGame` (a task queue) runs `analyzeStep` for a game: each
 * task searches up to ANALYSIS_BATCH positions, keeps the rows in
 * `game_evals_progress/{gameId}` and is enqueued again until the game is
 * done. The search, the rows and the document come from game-review.js
 * itself (rustReviewSearchPosition, rustReviewDoc), loaded with the wasm
 * engine in pricing.js's context, so there is one source for both.
 *
 * Every position searched with no history (positionEvalCacheable) is cached
 * in `position_evals/{key}`, keyed like position_prices, and read before
 * searching. Clients read the cache; only this file writes it, the
 * evalPositions callable included (it searches each position itself).
 */

const crypto = require('crypto');
const { load } = require('./pricing');
const { freshEngine } = require('./engine-loader');

// Positions per task. A search is 1 s (RUST_SERVER_PRESET; the retries,
// quadrupling the time, are for a search that completes no depth), so a
// task takes about 10 s.
const ANALYSIS_BATCH = 10;
// Positions per evalPositions call.
const EVAL_CALL_MAX = 10;
// evalPositions quotas, in positions per UTC day (each about 1 s of search):
// per account, and for the whole site, so neither one player nor many
// throwaway accounts can run the engine without bound.
const EVAL_DAILY_PER_UID = 200;
const EVAL_DAILY_TOTAL = 3000;

/** position_evals / position_prices key of an SFN. */
function positionEvalKey(sfn) {
	return crypto.createHash('sha256').update(String(sfn)).digest('hex').slice(0, 40);
}

let _engines = null;
let _worker = null;

/**
 * The wasm engine behind the interface reviewGameRust uses
 * (getRustEngineWorker(): `post({type: 'new_game'})` and `search(req)`), so
 * rustReviewSearchPosition runs unchanged. One table per preset size.
 */
async function engineWorker() {
	if (_worker) return _worker;
	const { p } = await load();
	if (!_engines) _engines = {};
	const table = (bits) => {
		if (!_engines[bits]) _engines[bits] = new p.wasm_bindgen.Engine(bits);
		return _engines[bits];
	};
	_worker = {
		p,
		post(msg) { if (msg && msg.type === 'new_game') table(msg.ttBits || 16).new_game(); },
		async search(req) {
			const a = req.adaptive || [0, 0, 0];
			return JSON.parse(table(req.ttBits || 16).search(req.sfn, req.timeMs >>> 0, (req.widthScale || 4) >>> 0,
				req.historySfns || [], req.evalName, a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0, () => {}));
		},
	};
	return _worker;
}

/** The fields of a search result a review row needs (rustReviewRow), plus bookkeeping. */
function cacheEntry(sfn, res, tag, ms, now) {
	const e = { sfn, engine: tag, depth: res.depth || 0, ms, at: now };
	if (typeof res.stones === 'number') e.stones = res.stones;
	if (typeof res.mate_in === 'number') e.mate_in = res.mate_in;
	if (typeof res.mate_proven === 'boolean') e.mate_proven = res.mate_proven;
	if (Array.isArray(res.actions)) e.actions = res.actions;
	if (typeof res.expected_sfn === 'string') e.expected_sfn = res.expected_sfn;
	return e;
}

async function readCache(db, sfn, tag) {
	const hit = (await db.ref('position_evals/' + positionEvalKey(sfn)).once('value')).val();
	return hit && hit.sfn === sfn && hit.engine === tag ? hit : null;
}

/**
 * Review position i of `sfns`: from the cache when it may stand for it,
 * else searched (and cached when it may be). Resolves to the red-POV row.
 */
async function positionRow(db, w, sfns, i, stats, preset) {
	const { p } = w;
	preset = preset || p.RUST_SERVER_PRESET;
	const tag = p.positionEvalEngineTag();
	const cacheable = p.positionEvalCacheable(sfns, i);
	if (cacheable) {
		const hit = await readCache(db, sfns[i], tag);
		if (hit) {
			if (stats) stats.hits++;
			return p.rustReviewRow(sfns[i].split(' ')[1] === 'b' ? 'blue' : 'red', hit);
		}
	}
	// The search's own result, for the cache entry: the row drops the fields
	// a later review would rebuild it from.
	let last = null;
	const tap = { post: (m) => w.post(m), search: async (req) => (last = await w.search(req)) };
	const t0 = Date.now();
	// A position the cache may hold is searched as the cache holds it: alone,
	// with no game history, so the entry does not depend on the game it came
	// from. The others keep the game's history (threefold repetition).
	const row = cacheable
		? await p.rustReviewSearchPosition(tap, [sfns[i]], 0, preset, 1)
		: await p.rustReviewSearchPosition(tap, sfns, i, preset, 1);
	const ms = Date.now() - t0;
	if (stats) { stats.searched++; stats.ms += ms; }
	if (cacheable && last) {
		await db.ref('position_evals/' + positionEvalKey(sfns[i])).set(cacheEntry(sfns[i], last, tag, ms, Date.now()));
	}
	return row;
}

/**
 * The game's positions (game-review.js _reviewPositions) from a
 * completed_games record, rebuilt by replay as rateGame replays it, or
 * { error } when the Rust engine cannot review the game.
 */
async function recordPositions(p, record) {
	const turns = Array.isArray(record.turns) ? record.turns : Object.values(record.turns || {});
	if (!turns.length) return { error: 'no-turns' };
	const engine = freshEngine();
	const variant = engine.normalizeVariant(record.variant);
	if (p.variantHasDuplicates(variant) || p.variantHasScramble(variant)) return { error: 'variant' };
	let log;
	try {
		log = await engine.reconstructGameLog(record.spellNames || [], variant, record.setupSfn || null, turns);
	} catch (e) {
		return { error: 'replay' };
	}
	if (log.length !== turns.length) return { error: 'replay' };
	return { sfns: p._reviewPositions(log) };
}

/**
 * One analysis task for completed_games/{gameId}. Resolves to
 * { done: true, reason } when there is nothing more to do (the document is
 * written, or the game cannot be analysed), else { done: false, next }: the
 * caller enqueues the next task. Throws on errors worth a retry.
 */
async function analyzeStep(db, gameId, opts) {
	const batch = (opts && opts.batch) || ANALYSIS_BATCH;
	// The result as rated: rateGame may overturn the record's (a finish the
	// room does not support is the finisher's resignation).
	const ratedWinner = opts && (opts.winner === 'red' || opts.winner === 'blue') ? opts.winner : null;
	const stats = (opts && opts.stats) || null;
	// Tests and the emulators may search shorter (opts.timeMs).
	const progressRef = db.ref('game_evals_progress/' + gameId);
	const record = (await db.ref('completed_games/' + gameId).once('value')).val();
	if (!record || !record.roomCode) return { done: true, reason: 'no-record' };
	const docRef = db.ref('game_evals/' + record.roomCode);
	// Room codes are reused: a document for another game is never replaced
	// (engine/harness/eval_games.py upload refuses the same).
	const owner = (await docRef.child('gameId').once('value')).val();
	if (owner === gameId) return { done: true, reason: 'exists' };
	if (owner || (await docRef.child('plies').once('value')).exists()) {
		await progressRef.remove();
		return { done: true, reason: 'room-code-taken' };
	}
	const w = await engineWorker();
	const { p } = w;
	const got = await recordPositions(p, record);
	if (got.error) {
		await progressRef.remove();
		return { done: true, reason: got.error };
	}
	const sfns = got.sfns;
	const n = sfns.length - 1;
	const prog = (await progressRef.once('value')).val() || {};
	const rows = new Array(n);
	for (const [k, r] of Object.entries(prog.rows || {})) if (Number(k) < n) rows[Number(k)] = r;
	let next = typeof prog.next === 'number' && prog.plies === n ? prog.next : n - 1;
	if (prog.plies !== n) rows.fill(undefined);
	// A fresh table per task, walked from the last position back as the
	// browser's review walks.
	w.post({ type: 'new_game', ttBits: p.RUST_SERVER_PRESET.ttBits });
	for (let k = 0; k < batch && next >= 0; k++, next--) {
		try {
			rows[next] = await positionRow(db, w, sfns, next, stats, presetFor(p, opts));
		} catch (e) {
			// The engine refuses the position (a pack it does not play): give up.
			if (/cannot review|no evaluation/.test(String(e && e.message))) {
				await progressRef.remove();
				return { done: true, reason: 'engine' };
			}
			throw e;
		}
	}
	if (next >= 0) {
		const save = {};
		rows.forEach((r, i) => { if (r) save[i] = r; });
		await progressRef.set({ roomCode: record.roomCode, plies: n, next, rows: save, at: Date.now() });
		return { done: false, next };
	}
	// Firebase drops nulls inside stored rows: put the row fields back.
	const full = rows.map((r) => Object.assign({ eval: null, mate: null, proven: true, best: null, bestSfn: null, depth: null }, r));
	const winner = ratedWinner || (record.winner === 'red' || record.winner === 'blue' ? record.winner : null);
	const doc = Object.assign(p.rustReviewDoc(sfns, full, winner ? { winner } : null, p.positionEvalEngineTag()), {
		gameId, roomCode: record.roomCode, preset: 'server', timeMs: presetFor(p, opts).timeMs, source: 'server', walk: 'backward',
		computedAt: Date.now(),
	});
	await db.ref().update({
		['game_evals/' + record.roomCode]: doc,
		['game_evals_progress/' + gameId]: null,
	});
	return { done: true, reason: 'written', doc };
}

/**
 * Take `n` positions of today's evalPositions quota for `uid`
 * (`eval_quota/{day}/{uid}` and `eval_quota/{day}/_total`, server-only).
 * Resolves false, taking nothing, when either quota would be exceeded.
 */
async function claimEvalQuota(db, uid, n, now) {
	const day = new Date(now).toISOString().slice(0, 10);
	const take = (limit) => (cur) => ((cur || 0) + n > limit ? undefined : (cur || 0) + n);
	const mine = await db.ref('eval_quota/' + day + '/u_' + uid).transaction(take(EVAL_DAILY_PER_UID));
	if (!mine.committed) return false;
	const all = await db.ref('eval_quota/' + day + '/_total').transaction(take(EVAL_DAILY_TOTAL));
	if (all.committed) return true;
	// Give the account's share back.
	await db.ref('eval_quota/' + day + '/u_' + uid).transaction((cur) => Math.max(0, (cur || 0) - n));
	return false;
}

/**
 * The evalPositions callable: search and cache up to EVAL_CALL_MAX
 * positions a browser review searched for itself. Each SFN must be a
 * well-formed position (it reads back to itself) the engine plays; it is
 * searched here, never taken from the caller, so the cache cannot be
 * poisoned. Resolves to { cached, searched, skipped }.
 */
async function evalPositions(db, sfns, opts) {
	if (!Array.isArray(sfns) || sfns.length > EVAL_CALL_MAX) throw new Error('bad-request');
	const w = await engineWorker();
	const { p } = w;
	const out = { cached: 0, searched: 0, skipped: 0 };
	const seen = new Set();
	for (const sfn of sfns) {
		if (typeof sfn !== 'string' || sfn.length > 400 || seen.has(sfn) || !wellFormed(p, sfn)) { out.skipped++; continue; }
		seen.add(sfn);
		const stats = { hits: 0, searched: 0, ms: 0 };
		try {
			w.post({ type: 'new_game', ttBits: p.RUST_SERVER_PRESET.ttBits });
			await positionRow(db, w, [sfn], 0, stats, presetFor(p, opts));
		} catch (e) {
			if (/cannot review|no evaluation/.test(String(e && e.message))) { out.skipped++; continue; }
			throw e;
		}
		if (stats.hits) out.cached++; else out.searched++;
	}
	return out;
}

/** RUST_SERVER_PRESET, or a shorter search for tests (`opts.timeMs`). */
function presetFor(p, opts) {
	const ms = opts && opts.timeMs;
	return ms > 0 ? Object.assign({}, p.RUST_SERVER_PRESET, { timeMs: ms }) : p.RUST_SERVER_PRESET;
}

/** True when `sfn` is a position the site's engine reads back to itself. */
function wellFormed(p, sfn) {
	try {
		const d = p.sfnToDict(sfn);
		if (!d || (d.turn !== 'red' && d.turn !== 'blue') || !(d.turncounter >= 1)) return false;
		const variant = p.normalizeVariant(d.variant);
		if (p.variantHasDuplicates(variant) || p.variantHasScramble(variant)) return false;
		const b = new p.SigilBoard(d.spell_names, variant);
		b.loadFromSfn(sfn);
		b.variant = d.variant;
		return p.boardToSfn(b) === p.normalizeSfnString(sfn);
	} catch (e) {
		return false;
	}
}

module.exports = { analyzeStep, evalPositions, claimEvalQuota, positionEvalKey, wellFormed, engineWorker,
	ANALYSIS_BATCH, EVAL_CALL_MAX, EVAL_DAILY_PER_UID, EVAL_DAILY_TOTAL };
