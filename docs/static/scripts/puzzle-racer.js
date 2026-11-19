/**
 * Puzzle Racer (puzzles.html?tab=racer): 2 to 10 players race through the
 * same puzzles. Puzzle Storm's run (bootStorm in puzzles.html) on a shared
 * clock: the same board switching puzzle in place, the same judging
 * (SIGIL_PUZZLE_ON_RESULT: a puzzle's first verdict counts), the same
 * score (puzzles solved), unrated like Storm. A miss or a skip moves on to
 * the next puzzle; there is no time penalty, as everyone stops together.
 *
 *   ?tab=racer             the Racer lobby: open a public or private race,
 *                          or join an open one
 *   ?tab=racer&race=<id>   one race: its lobby (joined on opening the link),
 *                          the countdown, the race, the results and rematch
 *
 * The server decides the race (functions/racer.js, the puzzleRace
 * callable): who is in it, the names, the puzzle sequence and the start.
 * This page writes only the player's own progress,
 * puzzle_races/<id>/players/<uid>/p = { n, score, at, st }, one puzzle per
 * write between startAt and endAt (database.rules.json), and `gone`, which
 * onDisconnect sets when the tab closes. Times are the server's: the page
 * runs on Date.now() plus .info/serverTimeOffset.
 *
 * Guests race too: opening or joining a race signs them in anonymously,
 * and the server names them "Guest XXXX".
 */

const RACER_MIN_TRACK = 10;           // the track's length in puzzles, until a racer nears it
const RACER_WRITE_GRACE_MS = 3000;    // database.rules.json: progress lands up to endAt + 3 s
const RACER_LOBBY_TTL_MS = 30 * 60000;    // functions/racer.js RACE_LOBBY_TTL_MS
const RACER_RACE_LABEL = 'two minutes';   // functions/racer.js RACE_MS

const RACER_ERRORS = {
	'not-found': 'This race does not exist any more.',
	closed: 'This race was closed.',
	started: 'This race has already started.',
	full: 'This race is full: ten racers at most.',
	'not-host': 'Only the host can start the race.',
	'too-few': 'A race needs at least two racers.',
	'not-a-racer': 'You are not in this race.',
	'not-finished': 'The race is not over yet.',
	'no-puzzles': 'No puzzles are available.',
	'bad-request': 'That is not a race link.',
};

function racerEsc(t) {
	return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function racerOrdinal(n) {
	const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function racerClock(ms) {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function racerErrorText(e) {
	const m = String((e && e.message) || e || '');
	return RACER_ERRORS[m] || ('Could not reach the server (' + m + ').');
}

/** The race's phase at server time `now`. */
function racerPhase(race, now) {
	if (!race || !race.status) return 'missing';
	if (race.status === 'closed') return 'closed';
	if (race.status === 'lobby') return 'lobby';
	if (now < race.startAt) return 'countdown';
	if (now < race.endAt) return 'racing';
	return 'done';
}

/** The racers (players with progress), in the order they joined: each keeps a lane. */
function racerLanes(race) {
	return Object.entries((race && race.players) || {}).filter(([, v]) => v && v.p)
		.map(([uid, v]) => ({ uid, name: v.name || 'Player', joinedAt: v.joinedAt || 0, gone: v.gone === true,
			score: v.p.score || 0, n: v.p.n || 0, st: v.p.st || 0 }))
		.sort((a, b) => a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : 1));
}

/** The racers ranked: most solved, then who got there first, then by name. */
function racerStandings(race) {
	return racerLanes(race).sort((a, b) => b.score - a.score || (a.score ? a.st - b.st : 0) || a.name.localeCompare(b.name));
}

async function bootRacer(all, params) {
	const byId = {};
	for (const p of all) byId[p.id] = p;
	const db = firebase.database();
	const root = document.getElementById('racer-root');
	const track = document.getElementById('racer-track');
	const $ = (id) => document.getElementById(id);
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	let offset = 0;
	db.ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; });
	const now = () => Date.now() + offset;
	const R = { id: params.get('race') || null, uid: null, race: null, loaded: false, phase: '', run: null, msg: '', busy: false, present: false };
	window.SIGIL_RACER = R;      // tools/browser/puzzle-racer-emulator-test.js
	document.getElementById('puzzle-loading').style.display = 'none';
	root.style.display = '';

	const call = (data) => firebase.functions().httpsCallable('puzzleRace')(data).then(r => r.data);
	const go = (id) => { location.href = 'puzzles.html?tab=racer' + (id ? '&race=' + encodeURIComponent(id) : ''); };
	/** The signed-in user; a guest gets an anonymous account, as online play does. */
	const signIn = async () => {
		const u = typeof firebaseAuthSettled === 'function' ? await firebaseAuthSettled() : firebase.auth().currentUser;
		return u || (await firebase.auth().signInAnonymously()).user;
	};
	const myEntry = () => (R.race && R.race.players && R.uid && R.race.players[R.uid]) || null;
	const setMsg = (t) => { R.msg = t || ''; const el = $('racer-msg'); if (el) el.textContent = R.msg; };

	// Buttons carry data-racer="<action>".
	const act = async (what) => {
		if (what === 'copy') {
			const input = $('racer-link');
			try { await navigator.clipboard.writeText(input.value); setMsg('Link copied.'); } catch (e) { input.select(); setMsg('Select the link and copy it.'); }
			return;
		}
		if (what === 'join-next') { go(R.race.next); return; }
		if (R.busy) return;
		R.busy = true;
		setMsg('');
		try {
			if (what === 'create-public' || what === 'create-private') {
				await signIn();
				const res = await call({ action: 'create', public: what === 'create-public' });
				go(res.id);
				return;
			}
			if (what === 'join') await call({ action: 'join', id: R.id });
			if (what === 'start') await call({ action: 'start', id: R.id });
			if (what === 'leave') { presence(false); await call({ action: 'leave', id: R.id }); go(null); return; }
			if (what === 'rematch') { const res = await call({ action: 'rematch', id: R.id }); go(res.id); return; }
		} catch (e) {
			setMsg(racerErrorText(e));
		} finally {
			R.busy = false;
		}
	};
	root.addEventListener('click', (ev) => {
		const b = ev.target.closest && ev.target.closest('[data-racer]');
		if (!b) return;
		ev.preventDefault();
		act(b.dataset.racer);
	});

	if (!R.id) return openLobby();
	return openRace();

	// -------------------------------------------------------------------
	// The Racer lobby: open a race, or join a public one.
	// -------------------------------------------------------------------
	async function openLobby() {
		const u = typeof firebaseAuthSettled === 'function' ? await firebaseAuthSettled() : null;
		const who = u && !u.isAnonymous ? ''
			: '<p class="racer-note">You will race as a guest. <a href="account.html">Sign in</a> to race under your name.</p>';
		root.innerHTML = '<h2>Puzzle Racer</h2>'
			+ '<p>Race up to nine others through the same puzzles for ' + RACER_RACE_LABEL + '. They start easy and get harder; '
			+ 'every puzzle you solve moves your car on, and a miss or a skip moves you to the next puzzle. '
			+ 'Most solved wins. Racer is practice: it does not change your puzzle rating.</p>' + who
			+ '<button class="action-button" type="button" data-racer="create-public">Open a public race</button>'
			+ '<button class="action-button" type="button" data-racer="create-private">Private race (by link)</button>'
			+ '<p class="racer-msg" id="racer-msg" role="status"></p>'
			+ '<h3>Open races</h3><div class="racer-list" id="racer-open"><p class="racer-note">Loading…</p></div>'
			+ '<p class="racer-note">Solo practice: <a href="puzzles.html?tab=storm">Puzzle Storm</a>.</p>';
		R.open = null;
		const renderOpen = () => {
			const el = $('racer-open');
			if (!el || !R.open) return;
			const t = now();
			const rows = R.open.filter(r => typeof r.createdAt === 'number' && t - r.createdAt < RACER_LOBBY_TTL_MS && (r.n || 0) > 0)
				.sort((a, b) => b.createdAt - a.createdAt);
			el.innerHTML = rows.length ? rows.map((r) => {
				const mins = Math.max(0, Math.floor((t - r.createdAt) / 60000));
				const full = (r.n || 0) >= (r.max || 10);
				return '<div class="racer-race" data-race="' + racerEsc(r.id) + '"><div><b>' + racerEsc(r.hostName || 'Player') + '</b>’s race'
					+ '<div class="racer-note">' + (r.n || 0) + ' of ' + (r.max || 10) + ' racers · opened ' + (mins ? mins + ' min ago' : 'just now') + '</div></div>'
					+ (full ? '<span class="racer-note">Full</span>' : '<a class="action-button" href="puzzles.html?tab=racer&amp;race=' + encodeURIComponent(r.id) + '">Join</a>') + '</div>';
			}).join('') : '<p class="racer-note">No open races right now. Open one and share its link; new races show up here as they open.</p>';
		};
		db.ref('puzzle_race_lobby').orderByChild('createdAt').limitToLast(50).on('value', (snap) => {
			const rows = [];
			snap.forEach((c) => { rows.push(Object.assign({ id: c.key }, c.val())); });
			R.open = rows;
			renderOpen();
		}, (e) => { $('racer-open').innerHTML = '<p class="racer-note">Could not load the open races (' + racerEsc(e.message || e) + ').</p>'; });
		setInterval(renderOpen, 20000);
	}

	// -------------------------------------------------------------------
	// One race.
	// -------------------------------------------------------------------
	async function openRace() {
		root.innerHTML = '<p class="racer-note">Loading the race…</p>';
		try {
			const u = await signIn();
			R.uid = u.uid;
			R.guest = !!u.isAnonymous;
		} catch (e) {
			R.msg = 'Could not sign in (' + (e.message || e) + '); you can watch, not race.';
		}
		// Back after a dropped connection: still here (onDisconnect said otherwise).
		db.ref('.info/connected').on('value', (s) => { if (s.val() === true && R.present) { R.present = false; presence(true); } });
		db.ref('puzzle_races/' + R.id).on('value', (snap) => {
			R.race = snap.val();
			R.loaded = true;
			update();
		}, (e) => { R.loaded = true; R.race = null; R.msg = 'Could not load the race (' + (e.message || e) + ').'; update(); });
		setInterval(tick, 250);
		const skip = $('storm-skip');
		if (skip) skip.addEventListener('click', () => { const run = R.run; if (run && !run.over && !run.resolved) result(false); });
	}

	function update() {
		if (!R.loaded) return;
		const phase = racerPhase(R.race, now());
		const me = myEntry();
		// Opening the link of an open race joins it (once; the button retries).
		if (phase === 'lobby' && !me && R.uid && !R.joinTried) {
			R.joinTried = true;
			act('join');
		}
		if (me && (phase === 'lobby' || phase === 'countdown' || phase === 'racing')) presence(true);
		else if (!me) presence(false);     // left, or given up a seat while away
		if (phase !== R.phase) enter(phase);
		render();
	}

	function tick() {
		if (!R.loaded) return;
		const phase = racerPhase(R.race, now());
		if (phase !== R.phase) { enter(phase); render(); return; }
		if (phase === 'countdown') {
			const el = $('racer-count');
			if (el) el.textContent = String(Math.max(1, Math.ceil((R.race.startAt - now()) / 1000)));
		}
		if (phase === 'racing') renderClock();
		if (phase === 'done' && !R.final && now() > R.race.endAt + RACER_WRITE_GRACE_MS) { R.final = true; render(); }
	}

	function enter(phase) {
		R.phase = phase;
		const me = myEntry();
		if (phase === 'racing' && me && me.p) runRace();
		if (phase === 'done' || phase === 'closed' || phase === 'missing') {
			stopRun();
			presence(false);
		}
	}

	/** `gone` is false while this tab is open; closing it sets it (onDisconnect). */
	function presence(on) {
		if (!R.uid || on === R.present) return;
		R.present = on;
		const ref = db.ref('puzzle_races/' + R.id + '/players/' + R.uid + '/gone');
		if (on) {
			ref.onDisconnect().set(true).catch(() => {});
			ref.set(false).catch(() => {});
		} else {
			ref.onDisconnect().cancel().catch(() => {});
		}
	}

	function render() {
		const race = R.race;
		const phase = R.phase;
		const me = myEntry();
		const racing = phase === 'racing' && R.run && !R.run.over && R.run.seq;
		root.style.display = racing ? 'none' : '';
		renderTrack();
		if (racing) { renderClock(); return; }
		const back = '<a class="action-button" href="puzzles.html?tab=racer">Racer lobby</a>';
		const msg = '<p class="racer-msg" id="racer-msg" role="status">' + racerEsc(R.msg) + '</p>';
		if (phase === 'missing') {
			root.innerHTML = '<h2>Puzzle Racer</h2><p>This race does not exist any more: a race is kept for two hours after it ends, and a lobby for half an hour.</p>' + msg + back;
			return;
		}
		if (phase === 'closed') {
			root.innerHTML = '<h2>Puzzle Racer</h2><p>This race was closed before it started.</p>' + msg + back;
			return;
		}
		const players = Object.entries(race.players || {}).map(([uid, v]) => Object.assign({ uid }, v))
			.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
		const here = players.filter(p => p.gone !== true);
		const host = race.players && race.players[race.host];
		const hostName = racerEsc((host && host.name) || 'the host');
		const tag = (p) => racerEsc(p.name || 'Player') + (p.uid === race.host ? ' <span class="racer-note">(host)</span>' : '')
			+ (p.uid === R.uid ? ' <span class="racer-note">(you)</span>' : '');
		if (phase === 'lobby') {
			const link = location.origin + location.pathname + '?tab=racer&race=' + encodeURIComponent(R.id);
			const canStart = me && me.gone !== true && (race.host === R.uid || !host || host.gone === true) && here.length >= 2;
			const wait = !me ? '' : here.length < 2 ? 'Waiting for at least one more racer.'
				: canStart ? 'Start when everyone is in.' : 'Waiting for ' + hostName + ' to start the race.';
			root.innerHTML = '<h2>Puzzle Racer</h2>'
				+ '<p>' + (race.public ? 'A public race (listed under Open races)' : 'A private race') + ', hosted by ' + hostName + '. Invite others with this link:</p>'
				+ '<div class="racer-link"><input id="racer-link" readonly aria-label="Race link" value="' + racerEsc(link) + '" />'
				+ '<button class="action-button" type="button" data-racer="copy">Copy link</button></div>'
				+ '<ol class="racer-players">' + players.map(p => '<li' + (p.gone === true ? ' class="is-gone" title="Left"' : '') + '>' + tag(p) + '</li>').join('') + '</ol>'
				+ '<p class="racer-note">' + here.length + ' of ' + (race.max || 10) + ' racers. ' + wait + '</p>'
				+ (R.guest && me ? '<p class="racer-note">You race as ' + racerEsc(me.name) + '. <a href="account.html">Sign in</a> to race under your name.</p>' : '')
				+ (me ? (canStart ? '<button class="action-button" type="button" data-racer="start">Start the race</button>' : '')
					+ '<button class="action-button" type="button" data-racer="leave">Leave</button>'
					: '<button class="action-button" type="button" data-racer="join">Join this race</button>')
				+ msg + back;
			return;
		}
		if (phase === 'countdown') {
			root.innerHTML = '<h2 class="racer-count" aria-live="polite">The race starts in <span id="racer-count">'
				+ Math.max(1, Math.ceil((race.startAt - now()) / 1000)) + '</span></h2>'
				+ '<p class="racer-center">' + (me && me.p ? 'Get ready: the first puzzle appears here. Solve as many as you can in ' + RACER_RACE_LABEL + '.'
					: 'You are watching this race.') + '</p>' + msg;
			return;
		}
		if (phase === 'racing') {
			// A spectator, a racer who has done every puzzle, or a racer whose puzzles did not load.
			const done = R.run && R.run.over;
			root.innerHTML = '<h2>' + (done ? 'Every puzzle done!' : me && me.p ? 'Loading the puzzles…' : 'Race in progress') + '</h2>'
				+ '<p>' + (done ? 'You finished all ' + R.run.seq.length + ' puzzles. The results come when the clock runs out: '
					: me && me.p ? '' : 'You are watching. ') + '<span id="racer-left">' + racerClock(race.endAt - now()) + '</span> left.</p>' + msg;
			return;
		}
		// The results.
		const rows = racerStandings(race);
		const mine = rows.findIndex(r => r.uid === R.uid) + 1;
		const run = R.run;
		const log = run && run.log.length ? '<p class="racer-note">Your puzzles (open one to review it):</p><ul class="storm-log">'
			+ run.log.map((e, i) => '<li><a class="' + (e.ok ? 'is-ok' : 'is-miss') + '" href="puzzles.html?id=' + encodeURIComponent(e.id) + '" title="'
				+ (e.ok ? 'Solved' : 'Missed') + '">' + (i + 1) + '</a></li>').join('') + '</ul>' : '';
		const next = typeof race.next === 'string'
			? '<button class="action-button" type="button" data-racer="join-next">Join the rematch</button>'
			: mine ? '<button class="action-button" type="button" data-racer="rematch">Rematch</button>' : '';
		root.innerHTML = '<h2>' + (mine ? 'You finished ' + racerOrdinal(mine) + ' of ' + rows.length : 'Race over') + '</h2>'
			+ (R.final ? '' : '<p class="racer-note">The last solves are still coming in…</p>')
			+ '<table class="racer-results"><thead><tr><th>#</th><th>Racer</th><th>Solved</th><th>Tried</th></tr></thead><tbody>'
			+ rows.map((r, i) => '<tr' + (r.uid === R.uid ? ' class="is-me"' : '') + '><td>' + (i + 1) + '</td><td>' + racerEsc(r.name)
				+ (r.gone ? ' <span class="racer-note">(left)</span>' : '') + '</td><td>' + r.score + '</td><td>' + r.n + '</td></tr>').join('')
			+ '</tbody></table>' + log
			+ (typeof race.next === 'string' ? '<p>A rematch is open.</p>' : '')
			+ next + '<a class="action-button" href="puzzles.html?tab=racer">New race</a>' + msg;
	}

	/** The lanes: one car per racer, moved on by each solve. */
	function renderTrack() {
		const lanes = racerLanes(R.race);
		if (!lanes.length || !['countdown', 'racing', 'done'].includes(R.phase)) { track.style.display = 'none'; return; }
		track.style.display = '';
		const top = Math.max(0, ...lanes.map(l => l.score));
		const len = Math.max(RACER_MIN_TRACK, Math.ceil((top + 1) / 5) * 5);
		const key = lanes.map(l => l.uid).join(',');
		if (track.dataset.key !== key) {
			track.dataset.key = key;
			track.innerHTML = '<div class="racer-track__head"><span>Race</span><span id="racer-finish"></span></div>'
				+ lanes.map((l, i) => '<div class="racer-lane" data-uid="' + racerEsc(l.uid) + '"><span class="racer-lane__name">' + racerEsc(l.name) + '</span>'
					+ '<span class="racer-lane__road"><span class="racer-car racer-car--' + (i % 10) + '"></span></span></div>').join('');
		}
		$('racer-finish').textContent = len + ' to the line';
		for (const l of lanes) {
			const lane = track.querySelector('.racer-lane[data-uid="' + CSS.escape(l.uid) + '"]');
			if (!lane) continue;
			lane.classList.toggle('is-me', l.uid === R.uid);
			lane.classList.toggle('is-gone', l.gone);
			const car = lane.querySelector('.racer-car');
			const pct = Math.min(100, 100 * l.score / len);
			car.style.left = pct + '%';
			car.style.transform = 'translateX(-' + pct + '%)';
			car.textContent = String(l.score);
			car.title = l.name + ': ' + l.score + ' solved of ' + l.n + ' tried';
		}
	}

	/** The sticky bar: time left, my score, my place. */
	function renderClock() {
		const race = R.race;
		const left = race.endAt - now();
		const run = R.run;
		const el = $('racer-left');
		if (el) el.textContent = racerClock(left);
		if (!run || !run.seq) return;
		$('storm-time').textContent = racerClock(left);
		$('storm-time').classList.toggle('is-low', left < 20000);
		$('storm-score').textContent = run.score;
		const others = racerLanes(race).filter(l => l.uid !== R.uid);
		const place = 1 + others.filter(l => l.score > run.score).length;
		$('storm-combo').textContent = racerOrdinal(place) + ' of ' + (others.length + 1) + (run.combo >= 3 ? ' · combo ' + run.combo : '');
	}

	// -------------------------------------------------------------------
	// Racing: Storm's run on the race's sequence.
	// -------------------------------------------------------------------
	const logKey = () => 'sigil_racer_log_' + R.id;

	async function runRace() {
		if (R.run) return;
		const me = myEntry();
		const run = R.run = { i: me.p.n || 0, score: me.p.score || 0, combo: 0, log: [], current: null, resolved: true, over: false, queue: Promise.resolve(), seq: null };
		try { run.log = JSON.parse(sessionStorage.getItem(logKey()) || '[]') || []; } catch (e) { run.log = []; }
		// The sequence is readable from startAt by the server's clock: a tab
		// whose estimate runs a little ahead is refused and tries again.
		for (let t = 0; t < 40 && !Array.isArray(run.seq); t++) {
			try { run.seq = (await db.ref('puzzle_race_seq/' + R.id).once('value')).val(); } catch (e) { /* not yet */ }
			if (!Array.isArray(run.seq)) await sleep(250);
		}
		if (!Array.isArray(run.seq)) { run.seq = null; run.over = true; setMsg('Could not load the race\'s puzzles.'); render(); return; }
		if (R.phase !== 'racing') return;
		window.SIGIL_PUZZLE_STORM = true;    // unrated, like Storm: the board leaves the solved list alone
		window.SIGIL_PUZZLE_NAV = { prev: '', next: '', rated: '', random: '' };
		window.SIGIL_PUZZLE_TITLE = window.SIGIL_PUZZLE_SOURCE = window.SIGIL_PUZZLE_TAGS = window.SIGIL_PUZZLE_PROGRESS = window.SIGIL_PUZZLE_FILTER_HTML = '';
		window.SIGIL_PUZZLE_ON_RESULT = function (p, status) {
			if (!run.current || p.id !== run.current.id) return;
			// A puzzle's first verdict only, as in Storm.
			if (status !== 'solved' && status !== 'failed' && status !== 'revealed') return;
			result(status === 'solved');
		};
		$('storm-end').style.display = 'none';
		document.body.classList.add('storm-mode');
		if (!load()) return;
		render();
		if (window.SIGIL_PUZZLE_BOARD) window.SIGIL_PUZZLE_BOARD.puzzleLoad(run.current);
		else startPuzzleBoard();     // Alpine, once: the board takes window.SIGIL_PUZZLE
		$('puzzle-root').style.display = '';
	}

	/** The current puzzle onto window.SIGIL_PUZZLE; false when the sequence is done. */
	function load() {
		const run = R.run;
		// A puzzle this page's set lacks (functions deployed ahead of the site) counts as a miss.
		while (run.i < run.seq.length && !byId[run.seq[run.i]]) { run.i += 1; enqueue(false); }
		if (run.i >= run.seq.length) { finish(); return false; }
		const p = byId[run.seq[run.i]];
		run.current = p;
		run.resolved = false;
		window.SIGIL_PUZZLE = p;
		$('storm-what').textContent = (p.kind === 'winning' ? 'Winning turn' : 'Mate in ' + p.mate) + ', ' + (p.mover === 'red' ? 'Red' : 'Blue') + ' to move';
		return true;
	}

	function advance() {
		const run = R.run;
		if (!run || run.over || R.phase !== 'racing') return;
		if (load() && window.SIGIL_PUZZLE_BOARD) window.SIGIL_PUZZLE_BOARD.puzzleLoad(run.current);
	}

	let flashTimer = 0;
	function flash(t) {
		$('storm-flash').textContent = t;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => { $('storm-flash').textContent = ''; }, 1500);
	}

	function result(ok) {
		const run = R.run;
		if (!run || run.over || run.resolved || R.phase !== 'racing') return;
		run.resolved = true;
		run.log.push({ id: run.current.id, ok });
		try { sessionStorage.setItem(logKey(), JSON.stringify(run.log)); } catch (e) { /* storage blocked */ }
		run.i += 1;
		if (ok) { run.score += 1; run.combo += 1; } else { run.combo = 0; }
		enqueue(ok);
		flash(ok ? 'Solved' : 'Missed');
		renderClock();
		setTimeout(advance, ok ? 700 : 1500);
	}

	/** Progress writes, one at a time, in order. */
	function enqueue(ok) {
		const run = R.run;
		run.queue = run.queue.then(() => writeProgress(ok)).catch(() => false);
	}

	/**
	 * One puzzle on (and the score up by one for a solve), as a transaction
	 * on the server's copy: the rules want n exactly one past it. A write
	 * within half a second of the last is refused; it waits and tries again
	 * while the race is on.
	 */
	async function writeProgress(ok) {
		const ref = db.ref('puzzle_races/' + R.id + '/players/' + R.uid + '/p');
		const TS = firebase.database.ServerValue.TIMESTAMP;
		for (let t = 0; t < 10; t++) {
			if (now() > R.race.endAt + RACER_WRITE_GRACE_MS) return false;
			try {
				const res = await ref.transaction((cur) => {
					cur = cur || {};
					return { n: (cur.n || 0) + 1, score: (cur.score || 0) + (ok ? 1 : 0), at: TS, st: ok ? TS : (cur.st || 0) };
				}, undefined, false);
				if (res.committed) return true;
			} catch (e) { /* refused: too soon after the last write, or outside the race */ }
			await sleep(600);
		}
		return false;
	}

	/** Every puzzle done before the clock: off the board, wait for the results. */
	function finish() {
		const run = R.run;
		run.over = true;
		hideBoard();
		render();
	}

	function stopRun() {
		const run = R.run;
		if (run) run.over = true;
		window.SIGIL_PUZZLE_ON_RESULT = null;
		hideBoard();
	}

	function hideBoard() {
		document.body.classList.remove('storm-mode');
		const pr = $('puzzle-root');
		if (pr) pr.style.display = 'none';
	}
}
