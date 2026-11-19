'use strict';
/**
 * Personal API tokens: made and revoked on the account page (index.js
 * createApiToken / revokeApiToken), sent as `Authorization: Bearer <token>`
 * to the public API and the bot API (api.js).
 *
 * A token is 32 random bytes ('sgl_' + base64url) and is shown once, when it
 * is made. The database keeps only its SHA-256 (a token has 256 bits of
 * entropy, so a fast hash is enough: there is nothing to brute-force):
 *   api_tokens/{sha256}          { uid, id, scopes: { read?, bot? }, created }   server-only
 *   api_token_hashes/{uid}/{id}  sha256, to revoke by id                          server-only
 *   user_api_tokens/{uid}/{id}   { name, scopes, created, lastUsed }               the owner reads it
 * Scopes:
 *   read - the public read endpoints at the token's rate limit, which is
 *          higher than an anonymous caller's. Nothing a token reads is not
 *          already public.
 *   bot  - play as the account through the bot API. Only a BOT account
 *          (bots/{uid}, index.js upgradeToBot) may make one.
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'sgl_';
const TOKEN_RE = /^sgl_[A-Za-z0-9_-]{43}$/;
const SCOPES = ['read', 'bot'];
const MAX_TOKENS = 10;
const NAME_MAX = 40;
// lastUsed is written at most this often per token.
const LAST_USED_EVERY_MS = 10 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

class TokenError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/**
 * Make a token for `uid`: { id, token, name, scopes, created }. The token
 * itself is in this answer only. Throws TokenError ('invalid-argument',
 * 'permission-denied', 'resource-exhausted').
 */
async function createToken(db, uid, request, now) {
	const name = typeof (request && request.name) === 'string' ? request.name.trim() : '';
	if (!name || name.length > NAME_MAX || /[\u0000-\u001f]/.test(name)) {
		throw new TokenError('invalid-argument', 'A name of 1 to ' + NAME_MAX + ' characters.');
	}
	const asked = Array.isArray(request && request.scopes) ? request.scopes : [];
	if (!asked.length || asked.some((s) => !SCOPES.includes(s))) {
		throw new TokenError('invalid-argument', 'Scopes: one or more of ' + SCOPES.join(', ') + '.');
	}
	const scopes = {};
	for (const s of asked) scopes[s] = true;
	if (scopes.bot && !(await db.ref('bots/' + uid).once('value')).exists()) {
		throw new TokenError('permission-denied', 'Only a BOT account can make a bot token.');
	}
	const mine = (await db.ref('user_api_tokens/' + uid).once('value')).val() || {};
	if (Object.keys(mine).length >= MAX_TOKENS) {
		throw new TokenError('resource-exhausted', 'At most ' + MAX_TOKENS + ' tokens: revoke one first.');
	}
	const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
	const hash = hashToken(token);
	const id = crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
	await db.ref().update({
		['api_tokens/' + hash]: { uid, id, scopes, created: now },
		['api_token_hashes/' + uid + '/' + id]: hash,
		['user_api_tokens/' + uid + '/' + id]: { name, scopes, created: now },
	});
	return { id, token, name, scopes: Object.keys(scopes), created: now };
}

/** The writes that remove `uid`'s token `id` (all of them without an id). */
async function revokeUpdates(db, uid, id) {
	const updates = {};
	const hashes = (await db.ref('api_token_hashes/' + uid + (id ? '/' + id : '')).once('value')).val();
	const pairs = id ? (hashes ? [[id, hashes]] : []) : Object.entries(hashes || {});
	for (const [tid, hash] of pairs) {
		if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) updates['api_tokens/' + hash] = null;
		// One token by id; all of them below by their parents (an update may
		// not name a path and its parent both).
		if (id) {
			updates['api_token_hashes/' + uid + '/' + tid] = null;
			updates['user_api_tokens/' + uid + '/' + tid] = null;
		}
	}
	if (!id) {
		updates['api_token_hashes/' + uid] = null;
		updates['user_api_tokens/' + uid] = null;
	}
	return updates;
}

/** Revoke one token; resolves to whether there was one. */
async function revokeToken(db, uid, id) {
	if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,24}$/.test(id)) throw new TokenError('invalid-argument', 'No such token.');
	const updates = await revokeUpdates(db, uid, id);
	if (!Object.keys(updates).length) return false;
	await db.ref().update(updates);
	return true;
}

/**
 * The account behind an Authorization header: { uid, id, scopes } or null
 * (no token). Throws TokenError('unauthenticated') for a token that is not
 * one, was revoked, or whose account is gone.
 */
async function resolveToken(db, header, now) {
	if (!header) return null;
	const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header));
	if (!m || !TOKEN_RE.test(m[1])) throw new TokenError('unauthenticated', 'Authorization: Bearer <token>, a token from your account page.');
	const hash = hashToken(m[1]);
	const rec = (await db.ref('api_tokens/' + hash).once('value')).val();
	if (!rec || typeof rec.uid !== 'string') throw new TokenError('unauthenticated', 'This token was revoked or never existed.');
	if ((await db.ref('deleted_users/' + rec.uid).once('value')).exists()) {
		throw new TokenError('unauthenticated', 'This token\'s account was deleted.');
	}
	const scopes = Object.keys(rec.scopes || {}).filter((s) => SCOPES.includes(s) && rec.scopes[s] === true);
	// Seen recently: written now and then, not on every call.
	const seenRef = db.ref('user_api_tokens/' + rec.uid + '/' + rec.id + '/lastUsed');
	const seen = (await seenRef.once('value')).val();
	if (typeof seen !== 'number' || now - seen >= LAST_USED_EVERY_MS) {
		// Not when the token was revoked meanwhile (the entry would come back as a stub).
		await db.ref('user_api_tokens/' + rec.uid + '/' + rec.id).transaction((cur) => {
			if (cur === null) return null;
			if (!cur.created) return undefined;
			return Object.assign({}, cur, { lastUsed: now });
		}).catch(() => {});
	}
	return { uid: rec.uid, id: rec.id, scopes };
}

module.exports = { createToken, revokeToken, revokeUpdates, resolveToken, hashToken, TokenError, SCOPES, MAX_TOKENS, TOKEN_RE };
