#!/usr/bin/env node
'use strict';
/**
 * Backfill (or remove) the Glicko-2 pool ratings from the rated games already
 * played, by replaying them through the rating function's own code
 * (rating.js glickoUpdates), oldest first. The result is what the ratings
 * would be had the function rated in pools from the start: each player's
 * first game in a pool seeds that pool from their Elo before the game (from
 * the record), and an AI tier is an anchor at its Elo before each game.
 * Nothing about the Elo changes.
 *
 * It writes (only with --apply):
 *   ratings/{uid}/{pool}                    the final pool records
 *   pool_leaderboard/{pool}/{uid}           their leaderboard rows
 *   user_games/{uid}/{gameId}/glicko        before/after of each rated game (existing entries only)
 *   completed_games/{gameId}/pool, /glicko  the same per game
 * and nothing else. The replay starts from nothing, so running it again
 * recomputes the same values (plus any game rated since): it is safe to
 * repeat. --undo removes all of the above (the Elo is untouched either way).
 *
 * Usage (from the repo root; a dry run unless --apply):
 *   node functions/scripts/backfill-glicko.js --service-account sa.json [--plan plan.json]
 *   node functions/scripts/backfill-glicko.js --service-account sa.json --apply
 *   node functions/scripts/backfill-glicko.js --service-account sa.json --undo [--apply]
 *   node functions/scripts/backfill-glicko.js --input export.json --plan plan.json   # offline, from a database export
 * --db-url defaults to the production database; with FIREBASE_DATABASE_EMULATOR_HOST
 * set it talks to the emulator instead.
 *
 * Run it while rateGame is quiet: a game rated between this script's read and
 * its write is overwritten by the replay's older value until it runs again.
 */

const fs = require('fs');
const path = require('path');
const { glickoUpdates, freshEngine, AI_UID } = require('../rating');
const Glicko = require('../../docs/static/scripts/engine/glicko.js');

const DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com';
const DEFAULT_ELO = 1000;
// Multi-path updates are written in chunks of this many paths.
const CHUNK = 400;

/** The winner as rated: stored since round 3 (ratedWinner), else from the Elo moves. */
function ratedWinner(g) {
	if (g.ratedWinner === 'red' || g.ratedWinner === 'blue') return g.ratedWinner;
	if (typeof g.redEloAfter === 'number' && typeof g.redEloBefore === 'number' && g.redEloAfter !== g.redEloBefore) {
		return g.redEloAfter > g.redEloBefore ? 'red' : 'blue';
	}
	return g.winner === 'red' || g.winner === 'blue' ? g.winner : null;
}

/**
 * The rated games of completed_games, oldest first: those the rating function
 * (or the old client Elo) rated, with both players named.
 */
function ratedGames(completed) {
	const out = [];
	for (const [id, g] of Object.entries(completed || {})) {
		if (!g || typeof g !== 'object' || g.guest === true) continue;
		if (typeof g.eloChange !== 'number' || g.unratedReason) continue;
		if (typeof g.redUid !== 'string' || typeof g.blueUid !== 'string' || g.redUid === g.blueUid) continue;
		if (g.redUid === 'deleted' || g.blueUid === 'deleted') continue;
		const winner = ratedWinner(g);
		if (!winner) continue;
		const p = g.startPos && typeof g.startPos.redWinProb === 'number' ? g.startPos.redWinProb : null;
		out.push({
			id, ts: typeof g.timestamp === 'number' ? g.timestamp : 0, winner,
			redUid: g.redUid, blueUid: g.blueUid, variant: g.variant, timeControl: g.timeControl,
			startPos: p === null ? null : { redWinProb: p },
			before: {
				red: typeof g.redEloBefore === 'number' ? g.redEloBefore : DEFAULT_ELO,
				blue: typeof g.blueEloBefore === 'number' ? g.blueEloBefore : DEFAULT_ELO,
			},
		});
	}
	out.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return out;
}

/**
 * Replay the rated games. `names`: uid -> display name (leaderboard/);
 * `entries`: uid -> the gameIds of their user_games (only those get a glicko).
 * @returns {{ set: object, stats: object }} the paths to write
 */
function buildPlan(completed, names, entries) {
	const engine = freshEngine();
	const games = ratedGames(completed);
	const state = {}; // uid -> pool -> record
	const played = {}; // uid -> rated games seen
	const set = {};
	const perPool = {};
	for (const g of games) {
		const uidOf = { red: g.redUid, blue: g.blueUid };
		const data = {};
		for (const c of ['red', 'blue']) {
			// gamesPlayed decides a seed's deviation (glicko.js seed): any rated
			// game before, or an Elo that has moved.
			const n = (played[uidOf[c]] || 0) + (g.before[c] !== DEFAULT_ELO ? 1 : 0);
			data[c] = { displayName: names[uidOf[c]], gamesPlayed: n };
		}
		const pool = Glicko.poolOf(engine.normalizeVariant(g.variant), g.timeControl);
		const pools = {
			red: state[g.redUid] && state[g.redUid][pool] || null,
			blue: state[g.blueUid] && state[g.blueUid][pool] || null,
			now: g.ts,
		};
		const verdict = { rated: true, winner: g.winner, startPos: g.startPos };
		const u = glickoUpdates(g.id, { variant: g.variant, timeControl: g.timeControl }, verdict, data, uidOf, g.before, pools, engine);
		for (const [k, v] of Object.entries(u)) {
			const parts = k.split('/');
			if (parts[0] === 'ratings') {
				(state[parts[1]] = state[parts[1]] || {})[parts[2]] = v;
			} else if (parts[0] === 'user_games') {
				if (entries[parts[1]] && entries[parts[1]].has(parts[2])) set[k] = v;
			} else if (parts[0] === 'completed_games') {
				set[k] = v;
			}
			// pool_leaderboard rows: from the final state below.
		}
		played[g.redUid] = (played[g.redUid] || 0) + 1;
		played[g.blueUid] = (played[g.blueUid] || 0) + 1;
		perPool[pool] = (perPool[pool] || 0) + 1;
	}
	let players = 0;
	for (const [uid, pools] of Object.entries(state)) {
		players++;
		for (const [pool, rec] of Object.entries(pools)) {
			set['ratings/' + uid + '/' + pool] = rec;
			const name = names[uid];
			if (typeof name === 'string' && name.length >= 1 && name.length <= 30) {
				const row = { displayName: name, r: rec.r, rd: rec.rd, n: rec.n, at: rec.at };
				if (AI_UID.test(uid)) row.isAI = true;
				set['pool_leaderboard/' + pool + '/' + uid] = row;
			}
		}
	}
	return { set, state, stats: { games: games.length, players, perPool } };
}

/** The paths --undo removes, from what the database holds now. */
function buildUndo(completed, userGames, ratingsNode, poolBoard) {
	const set = {};
	for (const uid of Object.keys(ratingsNode || {})) set['ratings/' + uid] = null;
	for (const pool of Object.keys(poolBoard || {})) set['pool_leaderboard/' + pool] = null;
	for (const [id, g] of Object.entries(completed || {})) {
		if (g && g.pool !== undefined) set['completed_games/' + id + '/pool'] = null;
		if (g && g.glicko !== undefined) set['completed_games/' + id + '/glicko'] = null;
	}
	for (const [uid, games] of Object.entries(userGames || {})) {
		for (const [id, e] of Object.entries(games || {})) {
			if (e && e.glicko !== undefined) set['user_games/' + uid + '/' + id + '/glicko'] = null;
		}
	}
	return { set };
}

/** Write a plan in chunks (each chunk one atomic multi-path update). */
async function applyPlan(db, set, log) {
	const keys = Object.keys(set);
	for (let i = 0; i < keys.length; i += CHUNK) {
		const part = {};
		for (const k of keys.slice(i, i + CHUNK)) part[k] = set[k];
		await db.ref().update(part);
		if (log) log('wrote ' + Math.min(i + CHUNK, keys.length) + ' / ' + keys.length);
	}
	return keys.length;
}

/** names and user_games ids from the leaderboard and user_games nodes. */
function indexes(leaderboard, users, userGames) {
	const names = {};
	for (const [uid, v] of Object.entries(users || {})) if (v && typeof v.displayName === 'string') names[uid] = v.displayName;
	for (const [uid, v] of Object.entries(leaderboard || {})) if (v && typeof v.displayName === 'string') names[uid] = v.displayName;
	const entries = {};
	for (const [uid, games] of Object.entries(userGames || {})) entries[uid] = new Set(Object.keys(games || {}));
	return { names, entries };
}

function summary(plan) {
	const lines = ['rated games replayed: ' + plan.stats.games, 'players: ' + plan.stats.players, 'games per pool:'];
	for (const [p, n] of Object.entries(plan.stats.perPool).sort((a, b) => b[1] - a[1])) lines.push('  ' + p + ': ' + n);
	const byPool = {};
	for (const [uid, pools] of Object.entries(plan.state)) {
		for (const [p, rec] of Object.entries(pools)) (byPool[p] = byPool[p] || []).push([uid, rec]);
	}
	for (const [p, rows] of Object.entries(byPool)) {
		rows.sort((a, b) => b[1].r - a[1].r);
		lines.push('top of ' + p + ':');
		for (const [uid, rec] of rows.slice(0, 5)) lines.push('  ' + Glicko.format(rec).padEnd(6) + ' rd ' + Math.round(rec.rd) + ' n ' + rec.n + '  ' + uid);
	}
	lines.push('paths to write: ' + Object.keys(plan.set).length);
	return lines.join('\n');
}

function parseArgs(argv) {
	const a = { apply: false, undo: false, dbUrl: DB_URL };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--apply') a.apply = true;
		else if (k === '--undo') a.undo = true;
		else if (k === '--service-account') a.serviceAccount = argv[++i];
		else if (k === '--db-url') a.dbUrl = argv[++i];
		else if (k === '--plan') a.plan = argv[++i];
		else if (k === '--input') a.input = argv[++i];
		else if (k === '--help' || k === '-h') a.help = true;
		else throw new Error('unknown argument ' + k);
	}
	return a;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
		return;
	}
	let db = null;
	let app = null;
	let read;
	if (args.input) {
		if (args.apply) throw new Error('--input is offline only: drop --apply');
		const dump = JSON.parse(fs.readFileSync(args.input, 'utf8'));
		read = async (p) => dump[p] || null;
	} else {
		const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
		const { getDatabase } = require('firebase-admin/database');
		const emulator = !!process.env.FIREBASE_DATABASE_EMULATOR_HOST;
		if (!emulator && !args.serviceAccount) throw new Error('--service-account is required (or FIREBASE_DATABASE_EMULATOR_HOST for the emulator)');
		app = initializeApp({
			credential: args.serviceAccount ? cert(JSON.parse(fs.readFileSync(args.serviceAccount, 'utf8'))) : applicationDefault(),
			databaseURL: args.dbUrl,
			projectId: process.env.GCLOUD_PROJECT || undefined,
		});
		db = getDatabase(app);
		console.log('database: ' + (emulator ? 'emulator ' + process.env.FIREBASE_DATABASE_EMULATOR_HOST + ' ' : '') + args.dbUrl);
		read = async (p) => (await db.ref(p).once('value')).val();
	}
	const [completed, userGames] = await Promise.all([read('completed_games'), read('user_games')]);
	let plan;
	if (args.undo) {
		const [ratingsNode, poolBoard] = await Promise.all([read('ratings'), read('pool_leaderboard')]);
		plan = buildUndo(completed, userGames, ratingsNode, poolBoard);
		console.log('paths to remove: ' + Object.keys(plan.set).length);
	} else {
		const [leaderboard, users] = await Promise.all([read('leaderboard'), read('users')]);
		const ix = indexes(leaderboard, users, userGames);
		plan = buildPlan(completed, ix.names, ix.entries);
		console.log(summary(plan));
	}
	if (args.plan) {
		fs.writeFileSync(args.plan, JSON.stringify({ generatedAt: new Date().toISOString(), undo: args.undo, set: plan.set }, null, 1));
		console.log('plan written to ' + path.resolve(args.plan));
	}
	if (!args.apply) {
		console.log('dry run: nothing written (add --apply to write)');
	} else {
		const n = await applyPlan(db, plan.set, (s) => console.log(s));
		console.log('done: ' + n + ' paths');
	}
	if (app) await require('firebase-admin/app').deleteApp(app);
}

if (require.main === module) {
	main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { ratedGames, ratedWinner, buildPlan, buildUndo, applyPlan, indexes };
