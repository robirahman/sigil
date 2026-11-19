#!/usr/bin/env node
'use strict';
/**
 * A reference bot for the Sigil bot API (docs/api.html): it plays random
 * legal turns. Start from it to connect an engine of your own: replace
 * randomTurn() with your engine's choice, in the same token format.
 *
 *   node tools/sigil-bot.js --token sgl_... [options]
 *
 *   --token T        a token with the `bot` scope, of a BOT account (account page)
 *   --api URL        the API (default https://us-central1-sigil-js.cloudfunctions.net/api)
 *   --engine DIR|URL the site's rules engine, which the bot plays by
 *                    (default: docs/static/scripts/engine next to this file,
 *                    else https://sigilbattle.com/static/scripts/engine/)
 *   --accept WHO     challenges to accept: all (default), bots, none
 *   --challenge USER challenge a player (uid or display name) once connected
 *   --tc M+S         the challenge's clock, minutes + seconds per move (default 5+3)
 *   --rated          ask for a rated game (bots only: a human is never challenged rated)
 *   --games N        stop after N games
 *   --seed N         the random seed
 *
 * Node 22 or later (fetch). No other dependencies.
 *
 * How a turn is made: the bot replays the game so far with the site's own
 * engine (game-review.js reconstructGameLog), which gives the true position
 * (repetition counts and Silence included, which an SFN alone does not
 * hold), then drives the site's GameController through one turn, answering
 * each prompt with a random choice among the options it offers. The tokens
 * the controller took are the turn: node names ('a2'), spell names
 * ('Fireblast'), 'dash', 'pass', 'skip_providence', 'submit'. A choice the
 * controller refuses (it asks the same again) is left out, so the turn holds
 * only clicks that did something, as the server requires.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE_FILES = ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'ai-player.js', 'game-controller.js', 'game-review.js', 'elo.js'];
const DEFAULT_API = 'https://us-central1-sigil-js.cloudfunctions.net/api';
const SITE_ENGINE = 'https://sigilbattle.com/static/scripts/engine/';

// ---- the engine ----

/** The site's engine, from a directory or a URL: { SigilBoard, GameController, reconstructGameLog, ... }. */
async function loadEngine(where) {
	const src = [];
	for (const f of ENGINE_FILES) {
		if (/^https?:/.test(where)) {
			const res = await fetch(where.replace(/\/?$/, '/') + f);
			if (!res.ok) throw new Error('engine file ' + f + ': HTTP ' + res.status);
			src.push(await res.text());
		} else {
			src.push(fs.readFileSync(path.join(where, f), 'utf8'));
		}
	}
	const ctx = { console: { log() {}, info() {}, debug() {}, warn() {}, error: console.error }, setTimeout, clearTimeout, Promise, Math, Date, JSON };
	vm.createContext(ctx);
	vm.runInContext(src.join('\n;\n') + `
;globalThis.__sigil = { SigilBoard, GameController, reconstructGameLog, boardToSfn, normalizeSpellNames, normalizeVariant };`,
	ctx, { filename: 'sigil-engine.js' });
	return ctx.__sigil;
}

function rng(seed) {
	let s = (seed >>> 0) || 1;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** The board after the game's moves (a gameFull / gameState body). */
async function boardOf(E, game) {
	const spellNames = E.normalizeSpellNames(game.spellNames || []);
	const variant = E.normalizeVariant(game.variant);
	const turns = (game.moves || []).map((m) => ({ color: m.color, turnNumber: m.n, kind: 'input', actions: m.actions }));
	if (!turns.length) {
		const b = new E.SigilBoard(spellNames, variant);
		if (game.startSfn) b.loadFromSfn(game.startSfn); else b.setupInitial();
		return { board: b, variant, next: b.turnCounter + 1, spellNames, turns };
	}
	let board = null;
	await E.reconstructGameLog(spellNames, variant, game.startSfn || null, turns, { onBoard: (b) => { board = b; } });
	return { board, variant, next: turns[turns.length - 1].turnNumber + 1, spellNames, turns };
}

/**
 * A random legal turn for `game.you`: the tokens, in the site's format.
 * Throws when no turn was found within the budget (try again).
 */
async function randomTurn(E, game, rand) {
	const { board, variant, next, spellNames, turns } = await boardOf(E, game);
	const color = game.you;
	// The game loop's turn preamble (MultiplayerController._runGameLoop).
	board.takeSnapshot();
	board.turnCounter = next;
	board.whoseTurn = color;
	board.update();
	board.crushedThisTurn = false;
	board.providenceOpen = board.providenceBank[color] > 0;
	const gc = new E.GameController(() => {}, { variant });
	gc.board = board;
	gc._currentTurnActions = [];
	const allNodes = Object.keys(board.stones);
	const pick = (xs) => xs[Math.floor(rand() * xs.length)];
	let prev = null;
	let tried = new Set();
	let budget = 0;
	gc._waitForInput = async (p) => {
		if (++budget > 300) throw new Error('no turn found');
		const sig = JSON.stringify([p.awaiting, p.message, p.actionlist || null, p.moveoptions || null]) + E.boardToSfn(board);
		if (prev && prev.sig === sig) {
			// Asked the same again: the last choice did nothing. Leave it out.
			const log = gc._currentTurnActions;
			if (log.length && log[log.length - 1] === prev.token) log.pop();
			tried.add(prev.token);
		} else {
			tried = new Set();
		}
		const acts = (p.actionlist || []).filter((a) => a !== 'move' && a !== 'providence');
		const opts = Object.keys(p.moveoptions || {});
		let choices;
		if (p.awaiting === 'node') {
			choices = acts.includes('submit') && rand() < 0.7 ? ['submit'] : (opts.length ? opts : allNodes).concat(acts);
		} else if ((p.actionlist || []).includes('move') && opts.length) {
			choices = opts; // the move: the UI answers it with a node
		} else if ((p.actionlist || []).includes('providence') && opts.length && rand() < 0.5) {
			choices = opts;
		} else {
			const nonPass = acts.filter((a) => a !== 'pass');
			choices = nonPass.length && rand() < 0.5 ? nonPass : (acts.includes('pass') ? ['pass'] : acts);
		}
		let left = choices.filter((c) => !tried.has(c));
		if (!left.length) left = (opts.length ? opts : allNodes).concat(acts).filter((c) => !tried.has(c));
		if (!left.length) throw new Error('no turn found');
		const token = pick(left);
		prev = { sig, token };
		return token;
	};
	await gc._takeTurn(color, true, true, true, true);
	const actions = gc._currentTurnActions.slice();
	// The server's own check, here first: the turn must take exactly these
	// tokens (game-review.js `strict`, where this engine has it).
	const turn = { color, turnNumber: next, kind: 'input', actions };
	await E.reconstructGameLog(spellNames, variant, game.startSfn || null, turns.concat([turn]), { strict: true });
	return actions;
}

// ---- the API ----

function client(api, token) {
	const base = api.replace(/\/+$/, '');
	const headers = { Authorization: 'Bearer ' + token };
	async function call(method, p, body) {
		const res = await fetch(base + p, {
			method,
			headers: Object.assign({}, headers, body ? { 'Content-Type': 'application/json' } : {}),
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
		if (!res.ok) {
			const err = new Error((json && json.message) || ('HTTP ' + res.status));
			err.status = res.status;
			err.code = json && json.error;
			throw err;
		}
		return json;
	}
	/**
	 * Follow an event stream: onEvent(name, data) per event. Reopens it when
	 * the server ends it (it does every few minutes) until stop() is called.
	 */
	function stream(p, onEvent) {
		let stopped = false;
		let controller = null;
		(async () => {
			while (!stopped) {
				controller = new AbortController();
				try {
					const res = await fetch(base + p, { headers, signal: controller.signal });
					if (!res.ok) {
						const t = await res.text();
						onEvent('error', { status: res.status, body: t });
						if (res.status === 401 || res.status === 403 || res.status === 404) return;
						await new Promise((r) => setTimeout(r, 3000));
						continue;
					}
					const dec = new TextDecoder();
					let buf = '';
					for await (const chunk of res.body) {
						buf += dec.decode(chunk, { stream: true });
						let i;
						while ((i = buf.indexOf('\n\n')) >= 0) {
							const block = buf.slice(0, i);
							buf = buf.slice(i + 2);
							let name = 'message';
							const data = [];
							for (const line of block.split('\n')) {
								if (line.startsWith('event:')) name = line.slice(6).trim();
								else if (line.startsWith('data:')) data.push(line.slice(5).trim());
							}
							if (!data.length) continue;
							let parsed = null;
							try { parsed = JSON.parse(data.join('\n')); } catch (e) { continue; }
							if (!stopped) await onEvent(name, parsed);
						}
					}
				} catch (e) {
					if (stopped) return;
					await new Promise((r) => setTimeout(r, 1000));
				}
			}
		})();
		return () => { stopped = true; if (controller) controller.abort(); };
	}
	return { call, stream };
}

/**
 * Run the bot until `opts.games` games are done (forever without it).
 * opts: { api, token, engine (a loaded engine), accept, challenge, timeControl,
 *         rated, games, seed, log }
 * Resolves { finished: [{ room, winner, you }] }.
 */
async function runBot(opts) {
	const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
	const E = opts.engine;
	const api = client(opts.api || DEFAULT_API, opts.token);
	const rand = rng(opts.seed || Date.now());
	const me = await api.call('GET', '/v1/account');
	if (!me.isBot || !me.scopes.includes('bot')) throw new Error('This token is not a bot token of a BOT account.');
	log('signed in as', me.name, '(' + me.uid + ')');
	const finished = [];
	const games = new Map();
	let stopEvents = null;
	let done;
	const allDone = new Promise((r) => { done = r; });

	async function play(code, state) {
		const g = games.get(code);
		if (!g || g.busy) { if (g) g.pending = state; return; }
		g.busy = true;
		try {
			let s = state;
			while (s) {
				Object.assign(g.game, s);
				g.pending = null;
				if (g.game.status === 'playing' && g.game.toMove === g.game.you && g.game.moves.length !== g.playedAt) {
					let sent = false;
					for (let attempt = 0; attempt < 5 && !sent; attempt++) {
						let actions;
						try {
							actions = await randomTurn(E, g.game, rand);
						} catch (e) {
							continue;
						}
						try {
							const r = await api.call('POST', '/v1/bot/games/' + code + '/turn', { actions });
							g.playedAt = g.game.moves.length;
							sent = true;
							log(code, 'played', actions.join(' '), r.gameOver ? '(game over: ' + r.winner + ' wins)' : '');
						} catch (e) {
							log(code, 'turn refused:', e.code, e.message);
							if (e.code === 'not-your-turn' || e.code === 'not-playing' || e.code === 'conflict') break;
						}
					}
					if (!sent && g.game.status === 'playing' && g.playedAt !== g.game.moves.length) {
						// Nothing found: resign rather than lose on time without a word.
						log(code, 'no turn found: resigning');
						await api.call('POST', '/v1/bot/games/' + code + '/resign').catch(() => {});
					}
				}
				s = g.pending;
			}
		} finally {
			g.busy = false;
		}
	}

	function follow(code, color) {
		if (games.has(code)) return;
		const g = { game: { you: color, moves: [] }, busy: false, pending: null, playedAt: -1, stop: null };
		games.set(code, g);
		g.stop = api.stream('/v1/bot/games/' + code + '/stream', async (ev, data) => {
			if (ev === 'gameFull' || ev === 'gameState') await play(code, data);
		});
	}

	function finish(code, data) {
		const g = games.get(code);
		if (g && g.stop) g.stop();
		games.delete(code);
		finished.push({ room: code, winner: data.winner, endReason: data.endReason, you: g ? g.game.you : null });
		log(code, 'finished:', data.status, data.winner ? data.winner + ' wins' : '', data.endReason || '');
		if (opts.games && finished.length >= opts.games) {
			if (stopEvents) stopEvents();
			for (const x of games.values()) if (x.stop) x.stop();
			done({ finished });
		}
	}

	stopEvents = api.stream('/v1/bot/events', async (ev, data) => {
		if (ev === 'challenge') {
			const timed = data.timeControl && (data.timeControl.type === 'realtime' || data.timeControl.type === 'correspondence');
			const ok = timed && (opts.accept === 'all' || (opts.accept === 'bots' && data.from && data.from.isBot));
			log(data.room, 'challenge from', data.from && data.from.name, ok ? '- accepting' : '- declining');
			try {
				await api.call('POST', '/v1/bot/challenges/' + data.room + '/' + (ok ? 'accept' : 'decline'));
			} catch (e) {
				log(data.room, 'could not answer the challenge:', e.message);
			}
		} else if (ev === 'gameStart') {
			log(data.room, 'game started, playing', data.color, 'against', data.opponent && data.opponent.name);
			follow(data.room, data.color);
		} else if (ev === 'gameFinish') {
			finish(data.room, data);
		} else if (ev === 'error') {
			log('event stream:', JSON.stringify(data));
		}
	});

	if (opts.challenge) {
		const r = await api.call('POST', '/v1/bot/challenge/' + encodeURIComponent(opts.challenge),
			{ timeControl: opts.timeControl, rated: !!opts.rated, color: 'random' });
		log(r.room, 'challenged', opts.challenge, 'playing', r.color, r.url);
	}
	return allDone;
}

// ---- command line ----

function parseArgs(argv) {
	const o = { accept: 'all' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const v = () => argv[++i];
		if (a === '--token') o.token = v();
		else if (a === '--api') o.api = v();
		else if (a === '--engine') o.engineFrom = v();
		else if (a === '--accept') o.accept = v();
		else if (a === '--challenge') o.challenge = v();
		else if (a === '--tc') o.tc = v();
		else if (a === '--rated') o.rated = true;
		else if (a === '--games') o.games = Number(v());
		else if (a === '--seed') o.seed = Number(v());
		else throw new Error('unknown option ' + a);
	}
	return o;
}

if (require.main === module) {
	(async () => {
		const o = parseArgs(process.argv.slice(2));
		o.token = o.token || process.env.SIGIL_BOT_TOKEN;
		if (!o.token) throw new Error('--token (or SIGIL_BOT_TOKEN): a bot token from your account page.');
		const local = path.resolve(__dirname, '..', 'docs', 'static', 'scripts', 'engine');
		const from = o.engineFrom || (fs.existsSync(path.join(local, ENGINE_FILES[0])) ? local : SITE_ENGINE);
		o.engine = await loadEngine(from);
		const [min, sec] = String(o.tc || '5+3').split('+').map(Number);
		o.timeControl = { type: 'realtime', initialTime: Math.round((min || 5) * 60000), increment: Math.round((sec || 0) * 1000) };
		const res = await runBot(o);
		console.log(JSON.stringify(res));
		process.exit(0);
	})().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { loadEngine, randomTurn, runBot, client, rng, ENGINE_FILES };
