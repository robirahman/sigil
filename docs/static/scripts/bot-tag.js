/**
 * bot-tag.js — BOT accounts are tagged BOT wherever the site shows a name.
 *
 * An account becomes a bot on the account page (functions/bot-api.js
 * upgradeToBot), for good: bots/{uid} (public, server-written) marks it, and
 * users/{uid}/isBot mirrors it. A bot plays only through the bot API
 * (api.html); it is never on the players' leaderboard, and a game against a
 * human is rated only when the human chose it (rooms/{code}/rateBot).
 *
 *   SigilBots.isBot(uid) -> Promise<boolean>, one read per uid per page.
 *   SigilBots.tag()      -> a <span class="bot-tag">BOT</span> element.
 * The tag's look is .bot-tag in styles.css.
 */
(function () {
	'use strict';
	const cache = new Map();

	function isBot(uid) {
		if (typeof uid !== 'string' || !uid || uid === 'deleted' || /^__ai_/.test(uid) || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
			return Promise.resolve(false);
		}
		if (!cache.has(uid)) {
			let p = Promise.resolve(false);
			try {
				if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
					p = firebase.database().ref('bots/' + uid).once('value').then((s) => s.exists(), () => false);
				}
			} catch (e) { /* no database on this page */ }
			cache.set(uid, p);
		}
		return cache.get(uid);
	}

	function tag() {
		const s = document.createElement('span');
		s.className = 'bot-tag';
		s.textContent = 'BOT';
		s.title = 'A bot: an engine playing through the Sigil bot API';
		return s;
	}

	window.SigilBots = { isBot, tag };
})();
