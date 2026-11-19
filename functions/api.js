'use strict';
/**
 * The HTTP API (index.js `api`, an onRequest function): JSON, CORS open to
 * any origin (no cookies: a caller is known by its token alone), rate limited
 * per token or per IP (rate-limit.js). docs/api.html documents it.
 *
 *   https://us-central1-sigil-js.cloudfunctions.net/api/v1/...
 *
 * Public reads (public-api.js) need no token; a token (api-tokens.js) with
 * the `read` scope gets the higher limit. The bot API (bot-api.js) needs a
 * token with the `bot` scope, of a BOT account.
 */

const { ApiError, userProfile, userByName, userGames, gameByRoom, waitForRoom, daily, leaderboard, intParam, WAIT_MAX_S, SITE } = require('./public-api');
const { resolveToken, TokenError } = require('./api-tokens');
const { botApi, STREAM_MS, PING_MS } = require('./bot-api');
const { hit, ipKey, LIMITS } = require('./rate-limit');

// Event streams one token may hold open on one instance.
const STREAMS_PER_TOKEN = 8;
const openStreams = new Map();

/** The caller's address: the last X-Forwarded-For hop, the one Google's front end adds. */
function clientIp(req) {
	const xff = req.get && req.get('x-forwarded-for');
	if (xff) {
		const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
		if (hops.length) return hops[hops.length - 1];
	}
	return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function cors(res) {
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.set('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After');
	res.set('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body, cacheSeconds) {
	res.set('Cache-Control', cacheSeconds ? 'public, max-age=' + cacheSeconds : 'no-store');
	res.status(status).json(body);
}

function sendError(res, e) {
	if (e instanceof ApiError) return sendJson(res, e.status, { error: e.code, message: e.message });
	if (e instanceof TokenError) {
		const status = e.code === 'unauthenticated' ? 401 : e.code === 'permission-denied' ? 403 : 400;
		if (status === 401) res.set('WWW-Authenticate', 'Bearer');
		return sendJson(res, status, { error: e.code, message: e.message });
	}
	console.error('api error', e);
	return sendJson(res, 500, { error: 'internal', message: 'Something went wrong.' });
}

/**
 * Open a Server-Sent Events response; `start(send)` begins the stream and
 * resolves a stop function. The stream ends after STREAM_MS with a
 * `reconnect` event (clients open it again), or when the client goes.
 */
async function sse(req, res, key, start) {
	const n = openStreams.get(key) || 0;
	if (n >= STREAMS_PER_TOKEN) throw new ApiError(429, 'too-many-streams', 'At most ' + STREAMS_PER_TOKEN + ' open streams per token.');
	openStreams.set(key, n + 1);
	res.status(200);
	res.set('Content-Type', 'text/event-stream; charset=utf-8');
	res.set('Cache-Control', 'no-cache, no-transform');
	res.set('X-Accel-Buffering', 'no');
	if (res.flushHeaders) res.flushHeaders();
	let open = true;
	const write = (s) => { if (open) { try { res.write(s); } catch (e) { /* gone */ } } };
	const send = (event, data) => write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
	write('retry: 3000\n\n');
	let stop = () => {};
	const ping = setInterval(() => write(': ping\n\n'), PING_MS);
	const end = () => {
		if (!open) return;
		clearInterval(ping);
		clearTimeout(timer);
		try { stop(); } catch (e) { /* listeners already gone */ }
		open = false;
		openStreams.set(key, Math.max(0, (openStreams.get(key) || 1) - 1));
		try { res.end(); } catch (e) { /* gone */ }
	};
	const timer = setTimeout(() => { send('reconnect', { after: STREAM_MS }); end(); }, STREAM_MS);
	req.on('close', end);
	try {
		stop = await start(send);
	} catch (e) {
		send('error', { error: (e && e.code) || 'internal', message: (e && e.message) || 'error' });
		end();
		return;
	}
	if (!open) { try { stop(); } catch (e) { /* ignore */ } }
	await new Promise((resolve) => { if (!open) resolve(); else req.on('close', resolve); setTimeout(resolve, STREAM_MS + 1000); });
}

/**
 * The request handler. deps: { db, engine, isFullAccount, isSuspended, now }.
 */
function createApiHandler(deps) {
	const { db } = deps;
	const now = () => (deps.now ? deps.now() : Date.now());
	const bot = botApi(deps);

	async function account(caller) {
		const [u, isBot] = await Promise.all([
			db.ref('users/' + caller.uid + '/displayName').once('value'),
			db.ref('bots/' + caller.uid).once('value'),
		]);
		return { uid: caller.uid, name: u.val() || null, isBot: isBot.exists(), scopes: caller.scopes, token: caller.id };
	}

	async function needBot(caller) {
		if (!caller) throw new ApiError(401, 'unauthenticated', 'The bot API needs a token: Authorization: Bearer <token>.');
		if (!caller.scopes.includes('bot')) throw new ApiError(403, 'missing-scope', 'This token has no bot scope.');
		if (!(await db.ref('bots/' + caller.uid).once('value')).exists()) throw new ApiError(403, 'not-a-bot', 'Only a BOT account can use the bot API.');
	}

	return async function handle(req, res) {
		cors(res);
		if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
		try {
			const path = String(req.path || '/').replace(/\/+$/, '') || '/';
			const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
			const q = req.query || {};
			const caller = await resolveToken(db, req.get('authorization'), now());
			const t = now();
			const key = caller ? 'tok_' + caller.id : ipKey(clientIp(req));
			const rl = await hit(db, key, caller ? LIMITS.token : LIMITS.anonymous, t);
			res.set('X-RateLimit-Limit', String(rl.limit));
			res.set('X-RateLimit-Remaining', String(rl.remaining));
			res.set('X-RateLimit-Reset', String(Math.ceil(rl.reset / 1000)));
			if (!rl.ok) {
				res.set('Retry-After', String(Math.max(1, Math.ceil((rl.reset - t) / 1000))));
				throw new ApiError(429, 'rate-limited', 'Too many requests: ' + rl.limit + ' a minute ' + (caller ? 'per token' : 'without a token') + '.');
			}
			if (parts[0] !== 'v1') throw new ApiError(404, 'not-found', 'See ' + SITE + '/api.html');
			const [, a, b, c, d] = parts;
			const GET = req.method === 'GET';
			const POST = req.method === 'POST';
			const body = (req.body && typeof req.body === 'object') ? req.body : {};

			if (GET && !a) {
				return sendJson(res, 200, { name: 'Sigil API', version: 1, docs: SITE + '/api.html' }, 3600);
			}
			if (GET && a === 'account' && !b) {
				if (!caller) throw new ApiError(401, 'unauthenticated', 'Authorization: Bearer <token>.');
				return sendJson(res, 200, await account(caller));
			}
			if (GET && a === 'users' && b === 'by-name' && c && !d) return sendJson(res, 200, await userByName(db, c), 60);
			if (GET && a === 'users' && b && !c) return sendJson(res, 200, await userProfile(db, b), 60);
			if (GET && a === 'users' && b && c === 'games' && !d) return sendJson(res, 200, await userGames(db, b, q, deps.engine), 30);
			if (GET && a === 'games' && b && !c) {
				const viewer = { viewerUid: caller ? caller.uid : null, now: t };
				if (q.wait !== undefined) {
					const wait = intParam(q, 'wait', 0, 0, WAIT_MAX_S);
					const after = intParam(q, 'after', 0, 0, 100000);
					return sendJson(res, 200, await waitForRoom(db, String(b).toUpperCase(), after, wait, deps.engine(), viewer));
				}
				const g = await gameByRoom(db, String(b).toUpperCase(), deps.engine(), viewer);
				return sendJson(res, 200, g, g.status === 'finished' ? 300 : 0);
			}
			if (GET && a === 'puzzles' && b === 'daily' && !c) return sendJson(res, 200, await daily(db, q, t), 300);
			if (GET && a === 'leaderboard' && !b) return sendJson(res, 200, await leaderboard(db, q), 60);

			if (a === 'bot') {
				await needBot(caller);
				const room = c ? String(c).toUpperCase() : null;
				if (GET && b === 'events' && !c) {
					const s = await hit(db, 'str_' + caller.id, LIMITS.stream, t);
					if (!s.ok) throw new ApiError(429, 'rate-limited', 'Too many streams opened: ' + LIMITS.stream + ' a minute.');
					return sse(req, res, caller.id, async (send) => bot.watchEvents(caller.uid, send));
				}
				if (GET && b === 'games' && room && d === 'stream') {
					const s = await hit(db, 'str_' + caller.id, LIMITS.stream, t);
					if (!s.ok) throw new ApiError(429, 'rate-limited', 'Too many streams opened: ' + LIMITS.stream + ' a minute.');
					return sse(req, res, caller.id, async (send) => bot.watchGame(caller.uid, room, send));
				}
				if (POST && b === 'games' && room && d === 'turn') return sendJson(res, 200, await bot.submitTurn(caller.uid, room, body));
				if (POST && b === 'games' && room && d === 'resign') return sendJson(res, 200, await bot.endGame(caller.uid, room, 'resign'));
				if (POST && b === 'games' && room && d === 'abort') return sendJson(res, 200, await bot.endGame(caller.uid, room, 'abort'));
				if (POST && b === 'challenges' && room && d === 'accept') return sendJson(res, 200, await bot.acceptChallenge(caller.uid, room));
				if (POST && b === 'challenges' && room && d === 'decline') return sendJson(res, 200, await bot.declineChallenge(caller.uid, room));
				if (POST && b === 'challenge' && c && !d) {
					const s = await hit(db, 'chl_' + caller.id, LIMITS.challenge, t);
					if (!s.ok) throw new ApiError(429, 'rate-limited', 'Too many challenges: ' + LIMITS.challenge + ' a minute.');
					return sendJson(res, 200, await bot.sendChallenge(caller.uid, c, body));
				}
			}
			throw new ApiError(GET || POST ? 404 : 405, GET || POST ? 'not-found' : 'method-not-allowed', 'See ' + SITE + '/api.html');
		} catch (e) {
			if (res.headersSent) { try { res.end(); } catch (x) { /* gone */ } return; }
			sendError(res, e);
		}
	};
}

module.exports = { createApiHandler, clientIp };
