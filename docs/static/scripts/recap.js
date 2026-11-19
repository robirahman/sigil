/**
 * recap.js — the numbers behind recap.html ("Year in Sigil"): pure
 * functions over one player's own records, which the page reads in the
 * browser (nothing is computed or stored on the server):
 *
 *   games    user_games/{uid} entries (profile-stats.js describes them),
 *            each with its id: { id, timestamp, roomCode, opponent,
 *            opponentUid, opponentIsAI, color, result, rated, eloBefore,
 *            eloAfter, eloChange, opponentEloBefore }
 *   rooms    roomCode -> { spellNames, casts } from rooms/{code}: the
 *            spells on the board and how many times this player cast each
 *            (from the transcript; only the most recent games are read)
 *   puzzle   { rating, attempts: users/{uid}/puzzleAttempts ({ pid: { solved,
 *            at, delta } }), progress: users/{uid}/puzzleProgress, storm:
 *            users/{uid}/puzzleStorm }
 *
 * Loaded as a classic script by recap.html, and require()-able in node.
 * Uses ProfileStats (profile-stats.js) for streaks and the best win.
 */

const SigilRecap = (() => {
	const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

	/** [start, end) of a calendar year, local time. */
	function yearBounds(year) {
		return [new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()];
	}

	function inYear(ts, year) {
		const [a, b] = yearBounds(year);
		return typeof ts === 'number' && ts >= a && ts < b;
	}

	/** The years with games, newest first. */
	function yearsWithGames(games) {
		const ys = new Set();
		for (const g of games || []) if (g && g.timestamp) ys.add(new Date(g.timestamp).getFullYear());
		return Array.from(ys).sort((a, b) => b - a);
	}

	function spellLabel(s) {
		if (typeof displaySpellName === 'function') return displaySpellName(typeof normalizeSpellName === 'function' ? normalizeSpellName(s) : s);
		return String(s).split('~')[0].replace(/_/g, ' ');
	}

	/**
	 * How many times `color` cast each spell in a transcript (ProfileStats
	 * roomTranscript turns): an input turn lists a cast as the spell's name,
	 * an engine turn as { type: 'cast', spell }. Only names on the board count.
	 */
	function countCasts(turns, color, spellNames) {
		const onBoard = new Set((spellNames || []).filter((s) => typeof s === 'string'));
		const out = {};
		for (const t of turns || []) {
			if (!t || t.color !== color || !Array.isArray(t.actions)) continue;
			for (const a of t.actions) {
				const name = typeof a === 'string' ? a : (a && a.type === 'cast' ? a.spell : null);
				if (name && onBoard.has(name)) out[name] = (out[name] || 0) + 1;
			}
		}
		return out;
	}

	/** The rating line through the year: [{ at, elo }], from the first rated
	 *  game's rating before it to each rated game's rating after. */
	function ratingPoints(games) {
		const rated = games.filter((g) => g.rated !== false && typeof g.eloAfter === 'number')
			.sort((a, b) => a.timestamp - b.timestamp);
		if (!rated.length) return [];
		const pts = [];
		if (typeof rated[0].eloBefore === 'number') pts.push({ at: rated[0].timestamp, elo: rated[0].eloBefore });
		for (const g of rated) pts.push({ at: g.timestamp, elo: g.eloAfter });
		return pts;
	}

	/**
	 * The puzzle year: solves (first solve in the year), first results in the
	 * year (and how many were solved first time), rated attempts, and the
	 * puzzle rating at the year's start and end (the current rating less the
	 * rated attempts' changes after each).
	 */
	function puzzleYear(puzzle, year) {
		const [a, b] = yearBounds(year);
		const p = puzzle || {};
		const progress = p.progress || {};
		const solved = Object.values(progress.solved || {}).filter((ms) => ms >= a && ms < b).length;
		const results = Object.values(progress.results || {}).filter((r) => r && r.at >= a && r.at < b);
		const attempts = Object.values(p.attempts || {}).filter((x) => x && typeof x.at === 'number');
		const rated = attempts.filter((x) => x.at >= a && x.at < b);
		let ratingStart = null, ratingEnd = null;
		if (typeof p.rating === 'number' && rated.length) {
			const after = (t) => attempts.filter((x) => x.at >= t).reduce((s, x) => s + (Number(x.delta) || 0), 0);
			ratingEnd = Math.round(p.rating - after(b));
			ratingStart = Math.round(p.rating - after(a));
		}
		const storm = p.storm && p.storm.runs && inYear(p.storm.at, year) ? p.storm.best : null;
		return {
			solved,
			tried: results.length,
			firstTry: results.filter((r) => r.r === 's').length,
			rated: rated.length,
			ratedSolved: rated.filter((x) => x.solved).length,
			ratingStart, ratingEnd,
			stormBest: typeof storm === 'number' ? storm : null,
		};
	}

	/** Everything the page shows for `year`. `rooms` may be partial. */
	function summarize(allGames, year, rooms, puzzle) {
		const games = (allGames || []).filter((g) => inYear(g.timestamp, year)).sort((x, y) => x.timestamp - y.timestamp);
		const wins = games.filter((g) => g.result === 'win').length;
		const out = {
			year,
			games: games.length,
			wins,
			losses: games.length - wins,
			winRate: games.length ? Math.round(100 * wins / games.length) : 0,
			vsPlayers: games.filter((g) => !g.opponentIsAI).length,
			vsAI: games.filter((g) => g.opponentIsAI).length,
			asRed: games.filter((g) => g.color !== 'blue').length,
		};
		// Opponents: how many, and the one met most (players before AIs).
		const opp = new Map();
		for (const g of games) {
			const key = g.opponentUid || ('name:' + (g.opponent || '?'));
			if (!opp.has(key)) opp.set(key, { name: g.opponent || 'Unknown', uid: g.opponentUid || null, ai: !!g.opponentIsAI, games: 0, wins: 0 });
			const o = opp.get(key);
			o.games++;
			if (g.result === 'win') o.wins++;
		}
		out.opponents = opp.size;
		out.topOpponent = Array.from(opp.values()).sort((x, y) => (x.ai - y.ai) || (y.games - x.games))[0] || null;
		// Busiest month.
		const months = new Array(12).fill(0);
		for (const g of games) months[new Date(g.timestamp).getMonth()]++;
		const bm = months.indexOf(Math.max.apply(null, months));
		out.months = months;
		out.busiestMonth = games.length ? { name: MONTHS[bm], games: months[bm] } : null;
		// Streaks, the best win (by the opponent's rating before the game).
		const PS = typeof ProfileStats !== 'undefined' ? ProfileStats : null;
		out.longestWinStreak = PS ? PS.streaks(games).longestWin : 0;
		const best = PS ? PS.bestWorst(games).bestWin : null;
		out.bestWin = best ? { opponent: best.game.opponent || 'Unknown', oppElo: Math.round(best.oppElo), at: best.game.timestamp, roomCode: best.game.roomCode || null } : null;
		// Rating.
		const pts = ratingPoints(games);
		out.ratingPoints = pts;
		if (pts.length) {
			const peak = pts.reduce((m, p) => (p.elo > m.elo ? p : m), pts[0]);
			out.rating = { start: Math.round(pts[0].elo), end: Math.round(pts[pts.length - 1].elo), peak: Math.round(peak.elo), peakAt: peak.at };
		} else {
			out.rating = null;
		}
		// Spells: on the board in the year's games (with the win rate), and cast.
		const board = new Map();
		const casts = {};
		let castGames = 0;
		for (const g of games) {
			const r = rooms && g.roomCode ? rooms[g.roomCode] : null;
			if (!r) continue;
			const seen = new Set();
			for (const s of r.spellNames || []) {
				if (typeof s !== 'string' || !s || s === 'none') continue;
				const name = spellLabel(s);
				if (seen.has(name)) continue;
				seen.add(name);
				if (!board.has(name)) board.set(name, { name, games: 0, wins: 0 });
				const row = board.get(name);
				row.games++;
				if (g.result === 'win') row.wins++;
			}
			if (r.casts) {
				castGames++;
				for (const [s, n] of Object.entries(r.casts)) {
					const name = spellLabel(s);
					casts[name] = (casts[name] || 0) + n;
				}
			}
		}
		const boardRows = Array.from(board.values());
		out.spellGames = boardRows.length ? games.filter((g) => rooms && g.roomCode && rooms[g.roomCode]).length : 0;
		out.mostCast = Object.entries(casts).map(([name, n]) => ({ name, casts: n })).filter((x) => x.casts > 0).sort((x, y) => (y.casts - x.casts) || (x.name < y.name ? -1 : 1)).slice(0, 3);
		out.castGames = castGames;
		const minGames = Math.max(3, Math.ceil(out.spellGames / 10));
		out.bestSpell = boardRows.filter((r) => r.games >= minGames)
			.map((r) => Object.assign({ rate: Math.round(100 * r.wins / r.games) }, r))
			.sort((x, y) => (y.rate - x.rate) || (y.games - x.games))[0] || null;
		out.puzzles = puzzleYear(puzzle, year);
		return out;
	}

	/** The recap as plain text, for sharing. */
	function shareText(r, name, url) {
		const lines = [(name ? name + '\'s ' : 'My ') + r.year + ' in Sigil'];
		if (r.games) {
			lines.push(r.games + (r.games === 1 ? ' game, ' : ' games, ') + r.wins + (r.wins === 1 ? ' win' : ' wins') + ' (' + r.winRate + '%)');
			if (r.rating) lines.push('Rating ' + r.rating.start + ' → ' + r.rating.end + ' (peak ' + r.rating.peak + ')');
			if (r.bestWin) lines.push('Best win: against ' + r.bestWin.opponent + ' (' + r.bestWin.oppElo + ')');
			if (r.longestWinStreak > 1) lines.push('Longest winning streak: ' + r.longestWinStreak);
			if (r.mostCast.length) lines.push('Most cast: ' + r.mostCast.map((s) => s.name).join(', '));
		} else {
			lines.push('No games this year');
		}
		if (r.puzzles && r.puzzles.solved) lines.push(r.puzzles.solved + (r.puzzles.solved === 1 ? ' puzzle' : ' puzzles') + ' solved');
		if (url) lines.push(url);
		return lines.join('\n');
	}

	/**
	 * The rating line as an inline SVG string: one series (the accent), a
	 * recessive frame, the low and high ratings on the left, the months along
	 * the bottom. Points carry their data for the page's hover tooltip.
	 */
	function ratingSvg(pts, year, width) {
		const W = Math.max(280, Math.round(width || 600)), H = 180;
		const left = 44, right = 10, top = 10, bottom = 24;
		const [a, b] = yearBounds(year);
		let lo = Math.min.apply(null, pts.map((p) => p.elo)), hi = Math.max.apply(null, pts.map((p) => p.elo));
		if (hi - lo < 40) { const m = (hi + lo) / 2; lo = m - 20; hi = m + 20; }
		const sx = (t) => left + (W - left - right) * (t - a) / (b - a);
		const sy = (e) => top + (H - top - bottom) * (hi - e) / (hi - lo);
		const parts = ['<svg class="recap-chart" role="img" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">'];
		parts.push('<title>Rating through ' + year + ', from ' + Math.round(pts[0].elo) + ' to ' + Math.round(pts[pts.length - 1].elo) + '</title>');
		for (const e of [lo, hi]) {
			parts.push('<line class="recap-grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + sy(e).toFixed(1) + '" y2="' + sy(e).toFixed(1) + '"></line>');
			parts.push('<text class="recap-tick" x="' + (left - 6) + '" y="' + (sy(e) + 4).toFixed(1) + '" text-anchor="end">' + Math.round(e) + '</text>');
		}
		for (let m = 0; m < 12; m += 3) {
			const x = sx(new Date(year, m, 1).getTime());
			parts.push('<text class="recap-tick" x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="start">' + MONTHS[m].slice(0, 3) + '</text>');
		}
		const line = pts.map((p) => sx(p.at).toFixed(1) + ',' + sy(p.elo).toFixed(1)).join(' ');
		parts.push('<polyline class="recap-line" points="' + line + '"></polyline>');
		const last = pts[pts.length - 1];
		parts.push('<circle class="recap-end" cx="' + sx(last.at).toFixed(1) + '" cy="' + sy(last.elo).toFixed(1) + '" r="4"></circle>');
		parts.push('<g class="recap-pts">' + pts.map((p) => '<circle cx="' + sx(p.at).toFixed(1) + '" cy="' + sy(p.elo).toFixed(1)
			+ '" r="0" data-at="' + p.at + '" data-elo="' + Math.round(p.elo) + '"></circle>').join('') + '</g>');
		parts.push('</svg>');
		return parts.join('');
	}

	return { MONTHS, yearBounds, inYear, yearsWithGames, countCasts, ratingPoints, puzzleYear, summarize, shareText, ratingSvg };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SigilRecap;
