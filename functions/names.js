'use strict';
/**
 * The offensive-name filter on the server: names written anyway (a client
 * that skips the page's check, or a page from before the filter) are put
 * back to 'Player', and a refused usernames/ claim is dropped. The word list
 * and its matching are the site's own (docs/static/scripts/engine/
 * name-filter.js, copied into functions/engine/ at deploy).
 *
 * Where names live (index.js wires each to a trigger):
 *   users/{uid}/displayName, leaderboard/{uid}/displayName,
 *   storm_leaderboard/{uid}/displayName, puzzle_leaderboard/{uid}/displayName
 *   rooms/{code}/{red|blue}/displayName
 *   usernames/{key}                       (the key is the lower-cased name)
 * A reset name makes account.html ask the player to choose a new one.
 */

const { requireShared } = require('./engine-loader');
const NameFilter = requireShared('name-filter.js');

const PLACEHOLDER = 'Player';
const NAME_LISTS = ['users', 'leaderboard', 'storm_leaderboard', 'puzzle_leaderboard'];

/**
 * A written displayName: `ref` is where it was written, `name` the new
 * value. Resets a refused name; returns true when it did.
 */
async function enforceName(ref, name) {
	if (typeof name !== 'string' || NameFilter.allowed(name)) return false;
	await ref.set(PLACEHOLDER);
	return true;
}

/** A usernames/{key} claim: drops a refused one. Returns true when it did. */
async function enforceUsername(ref, key, owner) {
	if (owner === null || owner === undefined || NameFilter.allowed(key)) return false;
	await ref.remove();
	return true;
}

module.exports = { NameFilter, PLACEHOLDER, NAME_LISTS, enforceName, enforceUsername };
