/**
 * tournament-client.js — what the tournament pages share (tournaments.html,
 * tournament.html, and the tournament bar of a game on multiplayer.html).
 *
 * Everything an event decides is the server's (functions/tournaments.js):
 * pairings, colours, scores, rounds, the start and the end. The pages only
 * ask through the `tournament` callable and show the database's view;
 * database.rules.json refuses any other write to the tournament nodes.
 *
 * window.SigilTournaments:
 *   call(action, data)       the callable; resolves to its data
 *   errorText(e)             a callable error in words
 *   tcLabel(tc), kindLabel(kind), variantLabel(v), when(ms), countdown(ms)
 *   performance(p), arenaCompare(a, b), swissRows(players, pairings)
 *                            the standings orders (as the server's)
 *   holdPresence(tid, uid)   the page is open (arena pairing waits for it)
 *   holdSeats(rooms)         a simul host's seats stay live on every board
 *   watchSimul(tid, uid, cb) the boards waiting for the host's move (game page)
 *   miniBoard(sfn)           a small board (core layout) for the simul page
 */
(function () {
	const KIND_LABEL = { arena: 'Arena', swiss: 'Swiss', simul: 'Simul' };

	function call(action, data) {
		const fn = firebase.functions().httpsCallable('tournament');
		return fn(Object.assign({ action }, data || {})).then((r) => r.data);
	}

	const ERRORS = {
		'invalid-kind': 'Choose an arena, a Swiss or a simul.',
		'invalid-name': 'Give the event a name of 3 to 50 characters.',
		'invalid-minutes': 'The clock must be between 1 and 60 minutes (admins: 180).',
		'invalid-increment': 'The increment must be 0 to 60 seconds.',
		'invalid-startsAt': 'The start must be within the next 7 days (admins: 60).',
		'invalid-durationMin': 'An arena lasts 10 to 180 minutes (admins: 720).',
		'invalid-rounds': 'A Swiss has 3 to 11 rounds (admins: 15).',
		'invalid-roundGapSec': 'The break between rounds is 0 to 600 seconds.',
		'invalid-maxPlayers': 'Too many players for this kind of event (64; a simul 20; admins more).',
		'invalid-hostExtraSec': 'Host extra time is 0 to 600 seconds per opponent.',
		'invalid-packs': 'Those spell packs cannot fill a board.',
		'invalid-id': 'No such event.',
		'too-many-events': 'You already run three events that are not over. Finish or cancel one first.',
		'suspended': 'You are suspended from rated play.',
		'full': 'This event is full.',
		'closed': 'This event takes no new players now.',
		'over': 'This event is over.',
		'started': 'It has already started.',
		'not-owner': 'Only the event’s creator (or an admin) can do that.',
		'not-enough-players': 'At least two players are needed to start.',
		'no-players': 'Nobody has joined yet.',
		'host': 'You are the host of this simul.',
		'removed': 'You were removed from this event.',
		'deleted': 'This account is being deleted.',
		'no-event': 'This event does not exist.',
		'no-player': 'That player is not in the event.',
		'busy': 'The server is busy. Try again in a moment.',
	};

	function errorText(e) {
		const msg = (e && e.message) || '';
		if (ERRORS[msg]) return ERRORS[msg];
		if (/unauthenticated/.test((e && e.code) || '')) return 'Sign in first.';
		if (/account first/.test(msg)) return 'Sign in with an account (not as a guest) to take part.';
		return 'Something went wrong (' + (msg || (e && e.code) || 'unknown error') + ').';
	}

	function tcLabel(tc) {
		if (!tc || tc.type === 'none') return 'Untimed';
		if (tc.type === 'realtime') {
			const min = (tc.initialTime || 0) / 60000;
			return (min === 0.5 ? '½' : min) + '+' + Math.round((tc.increment || 0) / 1000);
		}
		return 'Correspondence';
	}

	function kindLabel(kind) { return KIND_LABEL[kind] || 'Event'; }

	function variantLabel(v) {
		if (!v || v === 'standard') return 'Standard';
		return v.split('_').map((w) => (w === 'pentagon' ? 'Cataclysm' : w[0].toUpperCase() + w.slice(1))).join(' + ');
	}

	/** A date and time in the reader's locale. */
	function when(ms) {
		if (typeof ms !== 'number') return '';
		const d = new Date(ms);
		return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' '
			+ d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	/** "4:05", "1 h 12 min", "3 d 2 h" for a span of ms. */
	function countdown(ms) {
		const s = Math.max(0, Math.ceil(ms / 1000));
		if (s < 3600) return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
		if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
		return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
	}

	/* As functions/tournaments.js performance / arenaCompare / swissStandings. */
	function performance(p) {
		if (!p || !p.games) return null;
		return Math.round((p.oppRatingSum || 0) / p.games + 400 * ((p.wins || 0) - (p.losses || 0)) / p.games);
	}

	function arenaCompare(a, b) {
		return (b.score || 0) - (a.score || 0) || (performance(b) || 0) - (performance(a) || 0)
			|| (a.joinedAt || 0) - (b.joinedAt || 0) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
	}

	/** Swiss rows with Buchholz and Sonneborn-Berger, sorted. */
	function swissRows(players, pairings) {
		const score = {};
		const tb = {};
		for (const p of players) { score[p.uid] = p.score || 0; tb[p.uid] = { buchholz: 0, sb: 0 }; }
		for (const g of pairings) {
			if (!g || g.bye || g.status !== 'done' || !g.red || !g.blue) continue;
			for (const c of ['red', 'blue']) {
				const me = g[c], opp = g[c === 'red' ? 'blue' : 'red'];
				if (!tb[me]) continue;
				tb[me].buchholz += score[opp] || 0;
				if (g.winner === c) tb[me].sb += score[opp] || 0;
			}
		}
		const rows = players.map((p) => Object.assign({}, p, tb[p.uid]));
		rows.sort((a, b) => (b.score || 0) - (a.score || 0) || b.buchholz - a.buchholz || b.sb - a.sb
			|| (b.rating || 0) - (a.rating || 0) || (a.uid < b.uid ? -1 : 1));
		return rows;
	}

	/**
	 * Mark the event's page open for this account
	 * (tournament_presence/{tid}/{uid}/{tab}, removed when the tab goes):
	 * an arena pairs only players who are here or just back from a game.
	 * Returns a function that stops it.
	 */
	function holdPresence(tid, uid) {
		const db = firebase.database();
		const ref = db.ref('tournament_presence/' + tid + '/' + uid).push();
		const ts = firebase.database.ServerValue.TIMESTAMP;
		const on = (snap) => {
			if (snap.val() !== true) return;
			ref.onDisconnect().remove().then(() => ref.set(ts)).catch(() => {});
		};
		const conn = db.ref('.info/connected');
		conn.on('value', on);
		return () => {
			conn.off('value', on);
			ref.onDisconnect().cancel().catch(() => {});
			ref.remove().catch(() => {});
		};
	}

	/**
	 * A simul's host plays every board but has one open at a time: keep
	 * the host's seat live on all of them (as firebase-sync.js _goOnline
	 * does for one), so no opponent can claim an abandonment while the host
	 * is on another board. `rooms`: [{ code, color }]. Returns a stop().
	 */
	function holdSeats(rooms) {
		const db = firebase.database();
		const ts = firebase.database.ServerValue.TIMESTAMP;
		const held = [];
		for (const r of rooms || []) {
			if (!r || !r.code || (r.color !== 'red' && r.color !== 'blue')) continue;
			const seat = db.ref('rooms/' + r.code + '/' + r.color);
			const conn = seat.child('conns').push();
			held.push({ seat, conn });
		}
		const announce = async () => {
			for (const h of held) {
				try {
					await h.conn.onDisconnect().remove();
					await h.seat.child('disconnectedAt').onDisconnect().set(ts);
					// Once no conns are left, functions/rating.js abandoned() reads this flag.
					await h.seat.child('connected').onDisconnect().set(false);
					await h.conn.set(ts);
					await h.seat.update({ connected: true, disconnectedAt: null });
				} catch (e) { /* a finished room's seats are frozen */ }
			}
		};
		const info = db.ref('.info/connected');
		const on = (s) => { if (s.val() === true) announce(); };
		info.on('value', on);
		return () => {
			info.off('value', on);
			for (const h of held) {
				h.conn.onDisconnect().cancel().catch(() => {});
				h.conn.remove().catch(() => {});
			}
		};
	}

	/**
	 * A simul's boards as its host sees them: callback({ toMove: [code],
	 * rooms: [{ code, color }] }) on every change, the boards waiting for
	 * the host's move first in the order they were opened; the host's seat
	 * on every live board is held (holdSeats). Returns a stop().
	 */
	function watchSimul(tid, hostUid, callback) {
		const db = firebase.database();
		const boards = {};
		const subs = [];
		let seats = null, seatKey = '';
		const emit = () => {
			const live = Object.values(boards).filter((b) => b.playing && b.status !== 'finished' && b.status !== 'aborted');
			const rooms = live.map((b) => ({ code: b.code, color: b.color }));
			const key = rooms.map((r) => r.code).sort().join();
			if (key !== seatKey) {
				if (seats) seats();
				seats = rooms.length ? holdSeats(rooms) : null;
				seatKey = key;
			}
			const toMove = live.filter((b) => (b.last && b.last.color ? (b.last.color === 'red' ? 'blue' : 'red') : 'red') === b.color)
				.sort((a, b) => a.at - b.at).map((b) => b.code);
			callback({ toMove, rooms });
		};
		const pref = db.ref('tournament_pairings/' + tid);
		const onPairings = (snap) => {
			snap.forEach((c) => {
				const g = c.val() || {};
				if (!g.room) return;
				const b = boards[g.room] || (boards[g.room] = { code: g.room, at: g.at || 0, last: null, status: 'playing' });
				b.color = g.red === hostUid ? 'red' : 'blue';
				b.playing = g.status === 'playing';
				if (b.subscribed) return;
				b.subscribed = true;
				for (const k of ['last', 'status']) {
					const r = db.ref('rooms/' + g.room + '/' + k);
					const h = (s) => { b[k] = s.val(); emit(); };
					r.on('value', h);
					subs.push(() => r.off('value', h));
				}
			});
			emit();
		};
		pref.on('value', onPairings);
		return () => {
			pref.off('value', onPairings);
			subs.forEach((off) => off());
			if (seats) seats();
		};
	}

	// Core board node centres, % of the board image (styles.css .stone-node--*, + half a stone).
	const CORE_NODES = { a1: [6.62, 60.44], a2: [16.05, 69.59], a3: [23.11, 72.77], a4: [28.34, 66.96], a5: [24.46, 60.2], a6: [16.76, 61.96], a7: [45.51, 67.11], a8: [50.0, 78.18], a9: [46.01, 85.0], a10: [53.92, 85.0], a11: [14.83, 50.0], a12: [30.26, 49.99], a13: [32.43, 80.46], b1: [80.78, 82.36], b2: [83.95, 69.59], b3: [83.11, 61.82], b4: [75.47, 60.2], b5: [71.55, 66.96], b6: [76.89, 72.77], b7: [67.09, 45.34], b8: [74.46, 35.88], b9: [82.3, 35.88], b10: [78.38, 29.12], b11: [67.61, 80.46], b12: [59.91, 67.11], b13: [85.21, 50.0], c1: [62.68, 7.19], c2: [49.99, 10.71], c3: [43.68, 15.29], c4: [46.11, 22.74], c5: [53.89, 22.74], c6: [56.28, 15.2], c7: [37.46, 37.53], c8: [25.54, 35.82], c9: [21.64, 29.03], c10: [17.68, 35.82], c11: [67.61, 19.51], c12: [59.9, 32.87], c13: [32.43, 19.51] };
	const CORE_ORDER = Object.keys(CORE_NODES);

	/**
	 * A small picture of a position: the core board with its stones, from
	 * an SFN's stone field (one character per node, 'r' / 'b' / '-'), or
	 * the empty board. Other layouts get no picture ('').
	 */
	function miniBoard(sfn) {
		let stones = '';
		if (typeof sfn === 'string' && sfn) {
			stones = sfn.split(' ')[0].split('/')[0];
			if (stones.length !== CORE_ORDER.length) return '';
		}
		let dots = '';
		for (let i = 0; i < stones.length; i++) {
			const c = stones[i].toLowerCase();
			if (c !== 'r' && c !== 'b') continue;
			const [x, y] = CORE_NODES[CORE_ORDER[i]];
			dots += '<span class="mini-board__stone mini-board__stone--' + (c === 'r' ? 'red' : 'blue') + '" style="left:' + x + '%;top:' + y + '%"></span>';
		}
		return '<span class="mini-board" aria-hidden="true">' + dots + '</span>';
	}

	window.SigilTournaments = {
		call, errorText, tcLabel, kindLabel, variantLabel, when, countdown,
		performance, arenaCompare, swissRows, holdPresence, holdSeats, watchSimul, miniBoard,
	};
})();
