/**
 * glicko.js — Glicko-2 ratings, one per pool (time control and variant).
 *
 * One copy for the site and the server: the rateGame function, the matchmaker
 * and the backfill script require() it (functions/rating.js,
 * functions/matchmaking.js, functions/scripts/backfill-glicko.js), and the
 * lobby, leaderboard, profile and game pages load it as a classic script, so
 * a pool shown on the site is the pool the server rates in.
 *
 * Pools. A rated game counts in exactly one pool. Standard games are split by
 * time control: bullet, blitz and rapid by the estimated game length
 * (initial time + 40 increments, as on Lichess; a Sigil game is about 40
 * turns a side), correspondence (time per move) and untimed (no clock).
 * Every other rated variant has one pool for all time controls (Competitive
 * today: Deathmatch, Scramble, Duplicates and Cataclysm are never rated).
 *
 * Ratings. Glicko-2 (Glickman 2012), updated after every game as a rating
 * period of its own, with the rating deviation growing between games by the
 * time elapsed (Lichess's 0.21436 periods a day). A rating is provisional
 * ("?") while its deviation is above 110. A new pool rating starts from the
 * player's Elo with a deviation of 250 (350 with no rated game at all), so
 * the switch from one Elo carries what the Elo knew. A game from a priced
 * position (position-rating.js) adds the position's logit to the expected
 * score, as elo.js positionExpectedScore does.
 *
 * AI tier accounts (__ai_*__) are anchors: their rating in every pool is
 * their Elo (users/{ai}/elo, which the operator pins with a service account)
 * at a fixed deviation; their games move the players' ratings, never theirs.
 *
 * Records: ratings/{uid}/{pool} = { r, rd, vol, n, w, l, at, ai? }
 * (rating, deviation, volatility, games, wins, losses, last game, server ms).
 * The site shows them instead of the Elo only when site_config/ratingDisplay
 * is 'glicko' (rating-display.js); the Elo is still written either way.
 */
var SigilGlicko = (function () {
	'use strict';

	// Glicko-2 units per rating point (400 / ln 10 = 173.7178).
	const SCALE = 400 / Math.LN10;
	const C = {
		// The site's starting Elo (functions/rating.js DEFAULT_ELO).
		DEFAULT_RATING: 1000,
		// Deviation of a rating seeded from an Elo the player earned in rated
		// games, and of one with nothing behind it.
		SEED_RD: 250,
		NEW_RD: 350,
		MAX_RD: 350,
		// Lichess's floor: a rating never stops moving.
		MIN_RD: 45,
		DEFAULT_VOL: 0.06,
		MAX_VOL: 0.1,
		// System constant (Lichess uses 0.75; Glickman suggests 0.3 to 1.2).
		TAU: 0.75,
		// Rating periods per day of inactivity (Lichess).
		PERIODS_PER_DAY: 0.21436,
		// Above this deviation a rating is provisional ("?"), as on Lichess.
		PROVISIONAL_RD: 110,
		// An AI anchor's fixed deviation.
		AI_RD: 50,
		// No game moves a rating further than this (Lichess's cap).
		MAX_CHANGE: 700,
	};
	const DAY_MS = 86400000;
	// Expected scores are kept off 0 and 1 (a 1000-point gap is 0.3%).
	const EPS = 1e-4;

	const POOLS = ['bullet', 'blitz', 'rapid', 'correspondence', 'untimed', 'competitive'];
	const POOL_LABELS = {
		bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', correspondence: 'Correspondence',
		untimed: 'Untimed', competitive: 'Competitive',
	};
	const POOL_HINTS = {
		bullet: 'Standard, under 3 minutes (initial time + 40 increments)',
		blitz: 'Standard, 3 to 8 minutes (initial time + 40 increments)',
		rapid: 'Standard, 8 minutes or more (initial time + 40 increments)',
		correspondence: 'Standard, a time limit per move',
		untimed: 'Standard, no clock',
		competitive: 'Competitive variant, any time control',
	};

	/** The time-control class of a room or game timeControl. */
	function timeClass(tc) {
		const type = tc && tc.type;
		if (type === 'realtime') {
			const est = (Number(tc.initialTime) || 0) / 1000 + 40 * (Number(tc.increment) || 0) / 1000;
			if (est < 180) return 'bullet';
			if (est < 480) return 'blitz';
			return 'rapid';
		}
		if (type === 'correspondence') return 'correspondence';
		return 'untimed';
	}

	/**
	 * The pool of a game: `variant` as normalizeVariant (constants.js) gives
	 * it ('standard', 'competitive', 'competitive_deathmatch', ...).
	 */
	function poolOf(variant, tc) {
		const v = String(variant || 'standard');
		if (v === 'standard') return timeClass(tc);
		return v.replace(/[^a-z_]/g, '').slice(0, 40) || 'standard';
	}

	function poolLabel(pool) {
		if (POOL_LABELS[pool]) return POOL_LABELS[pool];
		return String(pool || '').split('_').map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' + ');
	}

	const isAiUid = (uid) => typeof uid === 'string' && /^__ai_[a-z0-9_]+__$/.test(uid);

	/** A new pool rating, from the player's Elo (and whether they have played rated games). */
	function seed(elo, gamesPlayed, now) {
		const has = typeof elo === 'number' && isFinite(elo);
		return {
			r: has ? elo : C.DEFAULT_RATING,
			rd: has && gamesPlayed > 0 ? C.SEED_RD : C.NEW_RD,
			vol: C.DEFAULT_VOL, n: 0, w: 0, l: 0, at: now,
		};
	}

	/** An AI tier's pool record: its Elo at the anchor's deviation, its counters kept. */
	function anchor(prev, elo, now) {
		const p = prev || {};
		const r = typeof elo === 'number' && isFinite(elo) ? elo : (typeof p.r === 'number' ? p.r : C.DEFAULT_RATING);
		return { r, rd: C.AI_RD, vol: C.DEFAULT_VOL, n: p.n || 0, w: p.w || 0, l: p.l || 0, at: typeof p.at === 'number' ? p.at : now, ai: true };
	}

	/** A stored record as rated: fields checked, missing ones defaulted. */
	function normalize(rec) {
		if (!rec || typeof rec !== 'object' || typeof rec.r !== 'number' || !isFinite(rec.r)) return null;
		const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
		const out = {
			r: rec.r,
			rd: Math.min(C.MAX_RD, Math.max(1, num(rec.rd, C.NEW_RD))),
			vol: Math.min(C.MAX_VOL, Math.max(1e-4, num(rec.vol, C.DEFAULT_VOL))),
			n: num(rec.n, 0), w: num(rec.w, 0), l: num(rec.l, 0), at: num(rec.at, 0),
		};
		if (rec.ai === true) out.ai = true;
		return out;
	}

	function _g(phi) {
		return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
	}

	/** New volatility (step 5, the Illinois algorithm). */
	function _volatility(sigma, phi, v, delta, tau) {
		const a = Math.log(sigma * sigma);
		const p2 = phi * phi;
		const f = (x) => {
			const ex = Math.exp(x);
			const d = p2 + v + ex;
			return ex * (delta * delta - p2 - v - ex) / (2 * d * d) - (x - a) / (tau * tau);
		};
		let A = a;
		let B;
		if (delta * delta > p2 + v) {
			B = Math.log(delta * delta - p2 - v);
		} else {
			let k = 1;
			while (f(a - k * tau) < 0 && k < 1000) k++;
			B = a - k * tau;
		}
		let fA = f(A);
		let fB = f(B);
		for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
			const Cx = A + (A - B) * fA / (fB - fA);
			const fC = f(Cx);
			if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
			B = Cx; fB = fC;
		}
		return Math.exp(A / 2);
	}

	/**
	 * One rating period for one player (Glickman, "Example of the Glicko-2
	 * system", steps 2 to 8).
	 * @param {{r, rd, vol}} player
	 * @param {Array<{r, rd, score, h?}>} results - the opponents as they stood,
	 *   the player's score (1 or 0) and `h`, the logit of the player's side's
	 *   P(win) from a priced start (0 for a standard start)
	 * @param {object} [opts] - { periods: rating periods the deviation grows
	 *   by (1 in the paper; the time since the last game here), tau }
	 * @returns {{r, rd, vol}}
	 */
	function ratePeriod(player, results, opts) {
		const periods = opts && typeof opts.periods === 'number' ? Math.max(0, opts.periods) : 1;
		const tau = opts && typeof opts.tau === 'number' ? opts.tau : C.TAU;
		const mu = player.r / SCALE;
		const phi = player.rd / SCALE;
		const sigma = player.vol;
		if (!results.length) {
			return { r: player.r, rd: SCALE * Math.sqrt(phi * phi + periods * sigma * sigma), vol: sigma };
		}
		let vInv = 0;
		let sum = 0;
		for (const o of results) {
			const gj = _g(o.rd / SCALE);
			let e = 1 / (1 + Math.exp(-(gj * (mu - o.r / SCALE) + (o.h || 0))));
			e = Math.min(1 - EPS, Math.max(EPS, e));
			vInv += gj * gj * e * (1 - e);
			sum += gj * (o.score - e);
		}
		const v = 1 / vInv;
		const delta = v * sum;
		const sigmaNew = _volatility(sigma, phi, v, delta, tau);
		const phiStar = Math.sqrt(phi * phi + periods * sigmaNew * sigmaNew);
		const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
		return { r: SCALE * (mu + phiNew * phiNew * sum), rd: SCALE * phiNew, vol: sigmaNew };
	}

	/** Rating periods between two server times (none backwards). */
	function periodsBetween(from, to) {
		if (typeof from !== 'number' || typeof to !== 'number' || !(to > from)) return 0;
		return (to - from) / DAY_MS * C.PERIODS_PER_DAY;
	}

	/** A record's deviation as of `now`: grown by the time since its last game. */
	function currentRd(rec, now) {
		if (!rec) return C.NEW_RD;
		if (rec.ai) return C.AI_RD;
		const phi = rec.rd / SCALE;
		const rd = SCALE * Math.sqrt(phi * phi + periodsBetween(rec.at, now) * rec.vol * rec.vol);
		return Math.min(C.MAX_RD, rd);
	}

	const round2 = (x) => Math.round(x * 100) / 100;

	/** P(the side with rating a wins), Glicko-2, with a position's logit `h` for that side. */
	function expectedScore(a, b, now, h) {
		const gj = _g(currentRd(b, now) / SCALE);
		return 1 / (1 + Math.exp(-(gj * (a.r - b.r) / SCALE + (h || 0))));
	}

	/**
	 * Rate one game between two pool records (normalized, seeded or anchored
	 * as they stand before it).
	 * @param {object} a - red's record
	 * @param {object} b - blue's record
	 * @param {number} scoreA - 1 when `a` won, 0 when it lost
	 * @param {object} opts - { now (server ms), posPA: P(a's side wins | the
	 *   start position) for a game from a priced position, else null }
	 *   Records marked `ai` are anchors: only their counters change. A
	 *   proven start (posPA exactly 0 or 1) tells nothing about the players
	 *   whatever happens, so it changes only the counters too: the Elo pays
	 *   nothing for converting one, and a blown one is not farmed here.
	 * @returns {{ a, b, expectedA }} the records after the game
	 */
	function rateGame(a, b, scoreA, opts) {
		const now = opts.now;
		let hA = 0;
		const proven = opts.posPA === 0 || opts.posPA === 1;
		if (typeof opts.posPA === 'number') {
			const p = Math.min(1 - EPS, Math.max(EPS, opts.posPA));
			hA = Math.log(p / (1 - p));
		}
		const view = (x) => ({ r: x.r, rd: currentRd(x, now) });
		const step = (me, opp, score, h) => {
			const out = Object.assign({}, me, {
				n: (me.n || 0) + 1,
				w: (me.w || 0) + (score === 1 ? 1 : 0),
				l: (me.l || 0) + (score === 1 ? 0 : 1),
				at: Math.max(typeof me.at === 'number' ? me.at : 0, now),
			});
			if (me.ai || proven) return out;
			const res = ratePeriod(me, [{ r: opp.r, rd: opp.rd, score, h }], { periods: periodsBetween(me.at, now) });
			const change = Math.max(-C.MAX_CHANGE, Math.min(C.MAX_CHANGE, res.r - me.r));
			out.r = round2(me.r + change);
			out.rd = round2(Math.min(C.MAX_RD, Math.max(C.MIN_RD, res.rd)));
			out.vol = Math.round(Math.min(C.MAX_VOL, res.vol) * 1e6) / 1e6;
			return out;
		};
		const aView = view(a);
		const bView = view(b);
		return {
			a: step(a, bView, scoreA, hA),
			b: step(b, aView, 1 - scoreA, -hA),
			expectedA: Math.round(expectedScore(a, b, now, hA) * 1e4) / 1e4,
		};
	}

	// ----- display -----

	function isProvisional(rec) {
		return !rec || typeof rec.rd !== 'number' || rec.rd > C.PROVISIONAL_RD;
	}

	/** "1480" or "1480?" (provisional). */
	function format(rec) {
		if (!rec || typeof rec.r !== 'number') return '?';
		return String(Math.round(rec.r)) + (isProvisional(rec) ? '?' : '');
	}

	/** The 95% range of a rating, [r - 2 rd, r + 2 rd], rounded. */
	function range(rec) {
		if (!rec || typeof rec.r !== 'number') return null;
		const rd = typeof rec.rd === 'number' ? rec.rd : C.NEW_RD;
		return [Math.round(rec.r - 2 * rd), Math.round(rec.r + 2 * rd)];
	}

	/** "1240–1720" */
	function formatRange(rec) {
		const x = range(rec);
		return x ? x[0] + '–' + x[1] : '';
	}

	return {
		C, SCALE, POOLS, POOL_LABELS, POOL_HINTS,
		timeClass, poolOf, poolLabel, isAiUid,
		seed, anchor, normalize, ratePeriod, rateGame, periodsBetween, currentRd, expectedScore,
		isProvisional, format, range, formatRange,
	};
})();

if (typeof module !== 'undefined' && module.exports) {
	module.exports = SigilGlicko;
}
