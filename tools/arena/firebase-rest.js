'use strict';
/**
 * Minimal Firebase Realtime Database REST client (no SDK, no deps).
 *
 * The production DB's `rooms/{code}` path is world-writable
 * (database.rules.json: rooms/$roomId ".write": true), so the arena can
 * publish a live game over plain HTTPS with no auth token / service account.
 * We only ever touch `rooms/{code}` with a random code and ranked:false — never
 * users / leaderboard / completed_games — so this can't affect real players.
 *
 * RTDB REST verbs: PUT = set, PATCH = update, POST = push (server key),
 * DELETE = remove. Append `.json` to the path.
 */

const https = require('https');

const DEFAULT_DB = 'https://sigil-js-default-rtdb.firebaseio.com';

function _request(method, url, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const req = https.request(url, {
			method,
			headers: data
				? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
				: {},
		}, (res) => {
			let buf = '';
			res.on('data', (c) => { buf += c; });
			res.on('end', () => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					resolve(buf ? JSON.parse(buf) : null);
				} else {
					reject(new Error(`${method} ${url} -> ${res.statusCode}: ${buf}`));
				}
			});
		});
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

class FirebaseRoom {
	constructor(code, dbUrl) {
		this.code = code;
		this.dbUrl = dbUrl || DEFAULT_DB;
	}

	_url(path) { return `${this.dbUrl}/${path}.json`; }

	/** Create the room in 'playing' state so spectators can join immediately. */
	async create({ spellNames, variant, redName, blueName, currentSfn, allowSpectators = true }) {
		const roomData = {
			spellNames,
			status: 'playing',
			created: Date.now(),
			red: { connected: true, uid: null, displayName: redName || 'Red AI' },
			blue: { connected: true, uid: null, displayName: blueName || 'Blue AI' },
			ranked: false,
			timeControl: { type: 'none' },
			allowSpectators,
			variant: variant === 'competitive' ? 'competitive' : 'standard',
			currentSfn: currentSfn || null,
		};
		await _request('PUT', this._url('rooms/' + this.code), roomData);
		return this.code;
	}

	/** Push one completed turn's action stream (spectator replays these). */
	async pushTurn(color, actions) {
		await _request('POST', this._url('rooms/' + this.code + '/turns'),
			{ color, actions, timestamp: Date.now() });
	}

	/** Update the canonical board SFN (used by spectators who join mid-game). */
	async setSfn(sfn) {
		await _request('PUT', this._url('rooms/' + this.code + '/currentSfn'), sfn);
	}

	/** Mark finished + persist gameLog so the room stays reviewable. */
	async finish(winner, gameLog) {
		await _request('PATCH', this._url('rooms/' + this.code),
			{ status: 'finished', winner, gameLog: gameLog || null });
	}

	async remove() {
		await _request('DELETE', this._url('rooms/' + this.code));
	}
}

/** Room codes: 4 uppercase letters, matching the app's _generateRoomCode style. */
function generateRoomCode() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	let s = '';
	for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
	return s;
}

module.exports = { FirebaseRoom, generateRoomCode, DEFAULT_DB };
