/**
 * profile-stats.js — the numbers, charts and export behind profile.html's
 * Stats, Insights and Games tabs. Pure functions over a player's games:
 *
 *   game  - one user_games/{uid}/{gameId} entry, as the rateGame Cloud
 *           Function writes it (functions/rating.js ratingUpdates):
 *           { timestamp, roomCode, gameId, opponent, opponentUid,
 *           opponentIsAI, color, result, fromPosition, rated, and either
 *           eloBefore/eloAfter/eloChange or unratedReason }.
 *   meta  - what the page reads from the game's public room record,
 *           rooms/{roomCode} (completed_games is not readable by clients):
 *           { spellNames, variant, timeControl, finalSfn, startSfn,
 *           setupSfn } plus oppElo, the opponent's rating before the game
 *           (their own user_games entry; an AI's current rating).
 *
 * Loaded as a classic script by profile.html, and require()-able in node.
 * Uses normalizeVariant / displaySpellName from engine/constants.js and
 * gameToSgn from engine/notation.js when they are loaded.
 */

const ProfileStats = (() => {
	const DAY = 86400000;

	/** Time-control bucket of a room's timeControl. */
	function tcBucket(tc) {
		if (!tc || !tc.type || tc.type === 'none') return 'Untimed';
		if (tc.type === 'correspondence') return 'Correspondence';
		if (tc.type === 'realtime') return (tc.initialTime || 0) < 10 * 60000 ? 'Live, under 10 min' : 'Live, 10 min or more';
		return 'Other';
	}
	const TC_ORDER = ['Live, under 10 min', 'Live, 10 min or more', 'Correspondence', 'Untimed', 'Other'];

	/** Variant label (the lobby's names); 'From a position' for a game from a position. */
	function variantLabel(variant, fromPosition) {
		if (fromPosition) return 'From a position';
		const n = typeof normalizeVariant === 'function' ? normalizeVariant(variant) : (variant || 'standard');
		if (!n || n === 'standard') return 'Standard';
		const names = { competitive: 'Competitive', deathmatch: 'Deathmatch', scramble: 'Scramble', duplicates: 'Duplicates', pentagon: 'Cataclysm' };
		return n.split('_').map((t) => names[t] || t).join(' + ');
	}

	function sfnCounter(sfn) {
		if (typeof sfn !== 'string') return null;
		const c = parseInt(sfn.split(' ')[2], 10);
		return Number.isFinite(c) ? c : null;
	}

	/**
	 * Turns played (both colours), from the final position's turn counter
	 * less the start's; null when the room has no finalSfn.
	 */
	function gameLength(meta) {
		if (!meta) return null;
		const end = sfnCounter(meta.finalSfn);
		if (end === null) return null;
		const start = sfnCounter(meta.startSfn || meta.setupSfn) || 0;
		return Math.max(0, end - start);
	}
	const LENGTH_BUCKETS = [[1, 10], [11, 20], [21, 30], [31, 40], [41, Infinity]];
	function lengthBucket(n) {
		if (n === null || n === undefined) return null;
		for (const [lo, hi] of LENGTH_BUCKETS) {
			if (n <= hi) return hi === Infinity ? lo + '+ turns' : lo + '–' + hi + ' turns';
		}
		return null;
	}
	const LENGTH_ORDER = LENGTH_BUCKETS.map(([lo, hi]) => (hi === Infinity ? lo + '+ turns' : lo + '–' + hi + ' turns'));

	function spellName(s) {
		if (typeof displaySpellName === 'function') return displaySpellName(typeof normalizeSpellName === 'function' ? normalizeSpellName(s) : s);
		return String(s).split('~')[0].replace(/_/g, ' ');
	}

	/** The distinct spells on a game's board, display names. */
	function gameSpells(meta) {
		const names = (meta && Array.isArray(meta.spellNames)) ? meta.spellNames : [];
		const out = [];
		for (const s of names) {
			if (typeof s !== 'string' || !s || s === 'none') continue;
			const n = spellName(s);
			if (out.indexOf(n) === -1) out.push(n);
		}
		return out;
	}

	function emptyRow(label) {
		return { label, games: 0, wins: 0, losses: 0, rated: 0, net: 0 };
	}
	function add(row, g) {
		row.games++;
		if (g.result === 'win') row.wins++; else row.losses++;
		if (g.rated && typeof g.eloChange === 'number') { row.rated++; row.net += g.eloChange; }
	}
	/** Rows grouped by keyOf(game) (null keys skipped), in `order` then by games. */
	function groupBy(games, keyOf, order) {
		const map = new Map();
		for (const g of games) {
			const keys = [].concat(keyOf(g));
			for (const k of keys) {
				if (k === null || k === undefined) continue;
				if (!map.has(k)) map.set(k, emptyRow(k));
				add(map.get(k), g);
			}
		}
		const rows = Array.from(map.values());
		const rank = (r) => { const i = order ? order.indexOf(r.label) : -1; return i === -1 ? 1e9 : i; };
		rows.sort((a, b) => (rank(a) - rank(b)) || (b.games - a.games) || (a.label < b.label ? -1 : 1));
		return rows;
	}

	/**
	 * Streaks over games in time order: { current: {result, n}, bestWin, worstLoss }
	 * where bestWin / worstLoss are the longest runs of wins / losses.
	 */
	function streaks(games) {
		const chron = games.slice().sort((a, b) => a.timestamp - b.timestamp);
		let best = 0, worst = 0, run = 0, last = null;
		for (const g of chron) {
			run = g.result === last ? run + 1 : 1;
			last = g.result;
			if (last === 'win') best = Math.max(best, run); else worst = Math.max(worst, run);
		}
		return { current: { result: last, n: last ? run : 0 }, longestWin: best, longestLoss: worst };
	}

	/**
	 * Best win: the win over the highest-rated opponent; worst loss: the loss
	 * to the lowest-rated one. By the opponent's rating before the game
	 * (meta.oppElo), so games without one are skipped.
	 */
	function bestWorst(games, metaOf) {
		let bestWin = null, worstLoss = null;
		for (const g of games) {
			const m = metaOf(g);
			const r = m && typeof m.oppElo === 'number' ? m.oppElo : null;
			if (r === null) continue;
			if (g.result === 'win' && (!bestWin || r > bestWin.oppElo)) bestWin = { game: g, oppElo: r };
			if (g.result !== 'win' && (!worstLoss || r < worstLoss.oppElo)) worstLoss = { game: g, oppElo: r };
		}
		return { bestWin, worstLoss };
	}

	/** The meta of a game whose room was found, else null. */
	function roomMeta(m) {
		return m && (m.spellNames || m.variant || m.timeControl || m.finalSfn) ? m : null;
	}

	/** Everything the Stats tab shows. */
	function summarize(games, metaOf) {
		const meta = (g) => roomMeta(metaOf(g));
		return {
			byKind: groupBy(games, (g) => (g.opponentIsAI ? 'vs AI' : 'vs players'), ['vs players', 'vs AI']),
			byTc: groupBy(games, (g) => (meta(g) ? tcBucket(meta(g).timeControl) : null), TC_ORDER),
			byVariant: groupBy(games, (g) => (meta(g) ? variantLabel(meta(g).variant, g.fromPosition || !!(meta(g).startSfn || meta(g).setupSfn)) : null), ['Standard']),
			streaks: streaks(games),
			bests: bestWorst(games, metaOf),
		};
	}

	/** What the Insights tab charts. */
	function insights(games, metaOf) {
		return {
			byColor: groupBy(games, (g) => (g.color === 'blue' ? 'Blue' : 'Red'), ['Red', 'Blue']),
			byLength: groupBy(games, (g) => lengthBucket(gameLength(metaOf(g))), LENGTH_ORDER),
			bySpell: groupBy(games, (g) => gameSpells(metaOf(g))),
		};
	}

	/**
	 * Games matching the search filters:
	 * { opponent (substring), result ('all'|'win'|'loss'), rated ('all'|'rated'|'unrated'),
	 *   spell (display name, '' for any), from / to ('YYYY-MM-DD', local dates, inclusive) }.
	 */
	function filterGames(games, f, metaOf) {
		const q = (f.opponent || '').trim().toLowerCase();
		const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : null;
		const to = f.to ? new Date(f.to + 'T00:00:00').getTime() + DAY : null;
		return games.filter((g) => {
			if (q && String(g.opponent || '').toLowerCase().indexOf(q) === -1) return false;
			if (f.result === 'win' && g.result !== 'win') return false;
			if (f.result === 'loss' && g.result === 'win') return false;
			if (f.rated === 'rated' && !g.rated) return false;
			if (f.rated === 'unrated' && g.rated) return false;
			if (f.spell && gameSpells(metaOf(g)).indexOf(f.spell) === -1) return false;
			if (from !== null && g.timestamp < from) return false;
			if (to !== null && g.timestamp >= to) return false;
			return true;
		});
	}

	function esc(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}
	function pct(r) {
		return r.games ? Math.round(100 * r.wins / r.games) : 0;
	}

	/**
	 * A horizontal bar chart of win rate per row, as an inline SVG string.
	 * One series (the accent), so no legend; a 50% hairline; the value at
	 * each bar's tip; each row is a hover target carrying its numbers in
	 * data-tip (and a <title> for screen readers).
	 */
	function winRateBars(rows, width) {
		const W = Math.max(280, Math.round(width || 600));
		const rowH = 30, barH = 16, top = 6, bottom = 22;
		const labelW = Math.min(150, Math.round(W * 0.34));
		const valueW = 92;
		const x0 = labelW, x1 = W - valueW;
		const H = top + rows.length * rowH + bottom;
		const sx = (p) => x0 + (x1 - x0) * p / 100;
		const parts = [];
		parts.push('<svg class="ins-chart" role="img" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">');
		for (const t of [0, 50, 100]) {
			parts.push('<line class="ins-grid' + (t === 50 ? ' ins-grid--mid' : '') + '" x1="' + sx(t) + '" x2="' + sx(t) + '" y1="' + top + '" y2="' + (H - bottom + 4) + '"></line>');
			parts.push('<text class="ins-tick" x="' + sx(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + t + '%</text>');
		}
		rows.forEach((r, i) => {
			const y = top + i * rowH;
			const p = pct(r);
			const tip = r.label + ': ' + p + '% won, ' + r.wins + '–' + r.losses + ' in ' + r.games + (r.games === 1 ? ' game' : ' games');
			parts.push('<g class="ins-row" data-tip="' + esc(tip) + '"><title>' + esc(tip) + '</title>');
			parts.push('<rect class="ins-hit" x="0" y="' + y + '" width="' + W + '" height="' + rowH + '"></rect>');
			parts.push('<text class="ins-label" x="' + (labelW - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end">' + esc(r.label) + '</text>');
			const bw = sx(p) - x0;
			const by = y + (rowH - barH) / 2;
			if (bw > 0) {
				// Square at the baseline, a 4 px rounded data end.
				const rad = Math.min(4, bw);
				parts.push('<path class="ins-bar" d="M' + x0 + ' ' + by + 'h' + (bw - rad) + 'a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' ' + rad
					+ 'v' + (barH - 2 * rad) + 'a' + rad + ' ' + rad + ' 0 0 1 ' + (-rad) + ' ' + rad + 'h' + (rad - bw) + 'z"></path>');
			}
			parts.push('<text class="ins-value" x="' + (sx(p) + 6) + '" y="' + (y + rowH / 2 + 4) + '">' + p + '% <tspan class="ins-value-sub">' + r.wins + '–' + r.losses + '</tspan></text>');
			parts.push('</g>');
		});
		parts.push('</svg>');
		return parts.join('');
	}

	/** The first turn's number for an online room (functions/rating.js firstTurnNumber). */
	function firstTurnNumber(startSfn, firstColor) {
		const c = sfnCounter(startSfn) || 0;
		return (c % 2 === 1) === (firstColor === 'red') ? c : c + 1;
	}

	/**
	 * The stored transcript of a room: slim turns { color, turnNumber, kind,
	 * actions } (notation.js slimGameLog). Online rooms keep their turns
	 * under turns/ (by server timestamp); AI-game archives under gameLog.
	 */
	function roomTranscript(room) {
		if (!room) return [];
		if (room.turns && typeof room.turns === 'object') {
			const t = room.turns;
			const list = Object.keys(t)
				.sort((a, b) => ((t[a].timestamp || 0) - (t[b].timestamp || 0)) || (a < b ? -1 : a > b ? 1 : 0))
				.map((k) => t[k]);
			if (!list.length) return [];
			const first = firstTurnNumber(room.startSfn, list[0].color);
			return list.map((x, i) => ({ color: x.color, turnNumber: first + i, kind: 'input', actions: x.actions || [] }));
		}
		const log = Array.isArray(room.gameLog) ? room.gameLog : (room.gameLog ? Object.values(room.gameLog) : []);
		return log.map((x) => {
			const out = { color: x.color, turnNumber: x.turnNumber, kind: x.kind || 'input' };
			if (x.kind === 'snapshot') out.sfnAfter = x.sfnAfter; else out.actions = x.actions || [];
			return out;
		});
	}

	/**
	 * One JSON-lines record: the stored user_games entry (as stored), its id,
	 * and from the room: spells, variant, clock, ending, the start and final
	 * SFNs, the transcript and its SGN-T text (notation.js). `room` null:
	 * the room is gone, the record says so.
	 */
	function exportRecord(gameId, entry, room, playerName) {
		const rec = Object.assign({ gameId }, entry);
		rec.date = entry && entry.timestamp ? new Date(entry.timestamp).toISOString() : null;
		if (!room) {
			rec.transcript = null;
			rec.transcriptMissing = entry && entry.roomCode ? 'room-not-found' : 'no-room';
			return rec;
		}
		const turns = roomTranscript(room);
		const startSfn = room.startSfn || room.setupSfn || null;
		Object.assign(rec, {
			spellNames: room.spellNames || [],
			variant: room.variant || 'standard',
			timeControl: room.timeControl || { type: 'none' },
			winner: room.winner || null,
			endReason: room.forfeitedBy ? 'forfeit' : (room.endReason || 'play'),
			startSfn,
			finalSfn: room.finalSfn || null,
			transcript: turns,
		});
		if (typeof gameToSgn === 'function' && turns.length) {
			const me = playerName || 'Player';
			const opp = (entry && entry.opponent) || 'Opponent';
			rec.sgn = gameToSgn({
				red: entry && entry.color === 'blue' ? opp : me,
				blue: entry && entry.color === 'blue' ? me : opp,
				result: room.winner || '*',
				spellNames: room.spellNames || [],
				variant: room.variant || 'standard',
				setupSfn: startSfn,
				finalSfn: room.finalSfn || null,
				date: rec.date ? rec.date.slice(0, 10) : undefined,
			}, turns);
		}
		return rec;
	}

	return {
		tcBucket, variantLabel, roomMeta, gameLength, lengthBucket, gameSpells, groupBy, streaks, bestWorst,
		summarize, insights, filterGames, winRateBars, roomTranscript, exportRecord, esc, pct,
	};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProfileStats;
