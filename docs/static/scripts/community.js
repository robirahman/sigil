/**
 * community.js — what the community pages share (inbox.html, forum.html,
 * blog.html, teams.html; admin.html's content reports):
 *
 *   - the signed-in account (guests read, only accounts write: the rules),
 *     with its admin / forum moderator / mute status;
 *   - display names (users/{uid}/displayName, "Deleted player" once gone);
 *   - writes under a rate limit: rate_limits/{uid}/{kind} = {at, n, since}
 *     goes in the same update as the post, as database.rules.json requires
 *     (LIMITS below mirror it);
 *   - rendering what people write: markdown-lite.js (no HTML, ever) through
 *     text-filter.js (profanity masked);
 *   - "Report" for a message, post, comment or team (content_reports/, read
 *     by admins on admin.html).
 *
 * Load after the Firebase SDK, markdown-lite.js and text-filter.js.
 */
(function () {
	const script = document.currentScript;
	const ROOT = script && script.src ? new URL('../../', script.src).href : '';
	if (typeof firebase === 'undefined') return;

	const db = () => firebase.database();
	const TS = () => firebase.database.ServerValue.TIMESTAMP;

	const HOUR = 3600000, DAY = 86400000;
	// database.rules.json rate_limits: ms between two writes, the window and
	// how many writes it allows.
	const LIMITS = {
		dm: { gap: 1000, window: HOUR, max: 200, what: 'messages' },
		dmnew: { gap: 10000, window: DAY, max: 30, what: 'new conversations' },
		forum: { gap: 10000, window: HOUR, max: 30, what: 'forum posts' },
		blog: { gap: 30000, window: DAY, max: 10, what: 'blog posts' },
		comment: { gap: 5000, window: HOUR, max: 60, what: 'comments' },
		team: { gap: 3000, window: DAY, max: 30, what: 'team actions' },
	};

	let offset = 0;
	try { db().ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; }); } catch (e) { /* offline */ }
	const serverNow = () => Date.now() + offset;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// ---- The account ----

	let account = null;
	let resolved = false;
	const userListeners = [];
	const roleCache = {};

	function setUser(u) {
		account = u && !u.isAnonymous ? u : null;
		resolved = true;
		userListeners.forEach((fn) => { try { fn(account); } catch (e) { console.error(e); } });
	}
	firebase.auth().onAuthStateChanged(setUser);
	// A guest who links an account keeps the uid (auth-status.js).
	window.addEventListener('sigil-auth-refresh', () => setUser(firebase.auth().currentUser));

	/** fn(account or null) now (once known) and on every sign-in change. */
	function onUser(fn) {
		userListeners.push(fn);
		if (resolved) fn(account);
	}

	/** { admin, forumMod, mutedUntil } of the signed-in account (cached). */
	function roles() {
		if (!account) return Promise.resolve({ admin: false, forumMod: false, mutedUntil: 0 });
		const uid = account.uid;
		if (!roleCache[uid]) {
			const val = (p) => db().ref(p).once('value').then((s) => s.val(), () => null);
			roleCache[uid] = Promise.all([val('admins/' + uid), val('forum_mods/' + uid), val('community_mutes/' + uid + '/until')])
				.then(([a, m, until]) => ({ admin: a === true, forumMod: a === true || m === true, mutedUntil: typeof until === 'number' ? until : 0 }));
		}
		return roleCache[uid];
	}

	// ---- Names and times ----

	const names = {};
	function name(uid) {
		if (!uid) return Promise.resolve('Player');
		if (!names[uid]) {
			names[uid] = db().ref('users/' + uid + '/displayName').once('value')
				.then((s) => (typeof s.val() === 'string' && s.val() ? s.val() : 'Deleted player'), () => 'Player');
		}
		return names[uid];
	}

	/** Fill `into[uid]` for each uid (an Alpine-reactive object works). */
	async function fillNames(uids, into) {
		await Promise.all([...new Set(uids.filter(Boolean))].map(async (u) => { into[u] = await name(u); }));
		return into;
	}

	function when(ts) {
		if (typeof ts !== 'number' || !ts) return '';
		const d = serverNow() - ts;
		if (d < 60000) return 'just now';
		if (d < HOUR) return Math.floor(d / 60000) + ' min ago';
		if (d < DAY) return Math.floor(d / HOUR) + ' h ago';
		if (d < 7 * DAY) return Math.floor(d / DAY) + ' d ago';
		return new Date(ts).toLocaleDateString();
	}

	const fullTime = (ts) => (typeof ts === 'number' && ts ? new Date(ts).toLocaleString() : '');

	function span(ms) {
		if (ms >= DAY) return Math.round(ms / DAY) + (ms >= 2 * DAY ? ' days' : ' day');
		if (ms >= HOUR) return Math.round(ms / HOUR) + (ms >= 2 * HOUR ? ' hours' : ' hour');
		return Math.max(1, Math.round(ms / 60000)) + ' min';
	}

	// ---- Writing under a rate limit ----

	class LimitError extends Error {}

	/**
	 * One multi-path update with the rate limit of `kind` (or of each of
	 * several kinds) in it. A wait of a few seconds is waited out; a longer
	 * one, or the window's allowance used up, throws a LimitError that says
	 * when to come back.
	 */
	async function commit(kinds, updates) {
		if (!account) throw new Error('Sign in with an account first.');
		const list = Array.isArray(kinds) ? kinds : [kinds];
		const uid = account.uid;
		let flip = {};
		for (let attempt = 0; attempt < 2; attempt++) {
			const curs = await Promise.all(list.map((k) => db().ref('rate_limits/' + uid + '/' + k).once('value').then((s) => s.val())));
			let wait = 0;
			list.forEach((k, i) => {
				const cur = curs[i];
				if (cur && cur.at > serverNow() - LIMITS[k].gap) wait = Math.max(wait, cur.at + LIMITS[k].gap - serverNow() + 100);
			});
			if (wait > 3000) throw new LimitError('Please wait ' + Math.ceil(wait / 1000) + ' seconds before the next one.');
			if (wait) await sleep(wait);
			const now = serverNow();
			const limits = {};
			let edge = false;
			list.forEach((k, i) => {
				const L = LIMITS[k];
				const cur = curs[i];
				let fresh = !cur || cur.since <= now - L.window;
				if (flip[k]) fresh = !fresh;
				if (!fresh && cur.n >= L.max) {
					throw new LimitError('That is the most ' + L.what + ' allowed in ' + span(L.window) + '; try again in ' + span(cur.since + L.window - now) + '.');
				}
				if (cur && Math.abs(cur.since + L.window - now) < 15000) { edge = true; flip[k] = true; }
				limits['rate_limits/' + uid + '/' + k] = fresh ? { at: TS(), n: 1, since: TS() } : { at: TS(), n: cur.n + 1, since: cur.since };
			});
			try {
				await db().ref().update(Object.assign({}, updates, limits));
				return;
			} catch (e) {
				// At a window's edge the server may judge it the other way.
				if (attempt === 0 && edge) continue;
				throw e;
			}
		}
	}

	/** A message for a failed write. */
	function errorText(e) {
		if (e instanceof LimitError) return e.message;
		const code = String((e && (e.code || e.message)) || '');
		if (/permission/i.test(code)) {
			return 'That was refused. You may be posting too fast, muted, blocked by this player, or no longer allowed here.';
		}
		return 'Something went wrong: ' + ((e && e.message) || e);
	}

	const newKey = (path) => db().ref(path || 'x').push().key;

	/** A team id from its name: "The Red Stones!" -> "the-red-stones". */
	function slugify(s) {
		return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
			.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
	}

	// ---- Rendering ----

	const mask = (s) => (window.SigilTextFilter ? SigilTextFilter.mask(s) : String(s === null || s === undefined ? '' : s));

	/** Render Markdown `text` into `el` (Alpine: x-effect="SigilCommunity.md($el, post.text)"). */
	function md(el, text) {
		if (!el) return;
		if (!window.SigilMarkdown) { el.textContent = mask(text); return; }
		SigilMarkdown.renderInto(el, text || '', { mask });
	}

	const excerpt = (text, max) => mask(window.SigilMarkdown ? SigilMarkdown.toPlain(text, max || 160) : String(text || '').slice(0, max || 160));

	// ---- Reporting content ----

	const REASONS = [
		['spam', 'Spam or advertising'],
		['abuse', 'Harassment or abuse'],
		['offensive', 'Offensive content'],
		['other', 'Something else'],
	];
	let dialog = null;
	let pending = null;

	function el(tag, attrs, text) {
		const e = document.createElement(tag);
		for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
		if (text) e.textContent = text;
		return e;
	}

	function buildDialog() {
		// The report-a-player dialog's look (styles.css .report-dialog).
		dialog = el('div', { class: 'report-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'content-report-title', 'data-testid': 'content-report' });
		const box = el('div', { class: 'report-dialog__box' });
		box.appendChild(el('h2', { class: 'report-dialog__title', id: 'content-report-title' }));
		const form = el('div', { class: 'report-dialog__form' });
		form.appendChild(el('label', { for: 'content-report-reason' }, 'Reason'));
		const sel = el('select', { id: 'content-report-reason', class: 'report-dialog__reason' });
		for (const [v, t] of REASONS) sel.appendChild(el('option', { value: v }, t));
		form.appendChild(sel);
		form.appendChild(el('label', { for: 'content-report-note' }, 'Anything the admins should know? (optional)'));
		form.appendChild(el('textarea', { id: 'content-report-note', class: 'report-dialog__note', rows: '3', maxlength: '500' }));
		box.appendChild(form);
		box.appendChild(el('p', { class: 'report-dialog__msg', 'aria-live': 'polite' }));
		const actions = el('div', { class: 'report-dialog__actions' });
		const send = el('button', { class: 'report-dialog__btn report-dialog__btn--send', type: 'button' }, 'Send report');
		const cancel = el('button', { class: 'report-dialog__btn', type: 'button' }, 'Cancel');
		send.addEventListener('click', sendReport);
		cancel.addEventListener('click', closeReport);
		actions.append(send, cancel);
		box.appendChild(actions);
		dialog.appendChild(box);
		dialog.addEventListener('click', (e) => { if (e.target === dialog) closeReport(); });
		dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); });
		document.body.appendChild(dialog);
	}

	const part = (sel) => dialog.querySelector(sel);
	function setMsg(text, ok) {
		const m = part('.report-dialog__msg');
		m.textContent = text || '';
		m.classList.toggle('report-dialog__msg--ok', !!ok);
	}

	/**
	 * Open the report dialog for one piece of content:
	 *   { kind: 'dm', target, conv, msg }       a message sent to you
	 *   { kind: 'forum', target, cat, thread, post }
	 *   { kind: 'blog', target, post }  { kind: 'comment', target, post, comment }
	 *   { kind: 'team', target (its leader), team }
	 * plus `what` ("this post") for the title.
	 */
	function report(opts) {
		if (!opts || !opts.kind || !opts.target) return;
		if (!dialog) buildDialog();
		pending = opts;
		part('.report-dialog__title').textContent = 'Report ' + (opts.what || 'this');
		part('.report-dialog__reason').value = 'spam';
		part('.report-dialog__note').value = '';
		const form = part('.report-dialog__form');
		const sendBtn = part('.report-dialog__btn--send');
		const ok = !!account && account.uid !== opts.target;
		form.hidden = !ok;
		sendBtn.hidden = !ok;
		sendBtn.disabled = false;
		setMsg(!account ? 'Sign in with an account to report.' : !ok ? 'You cannot report your own.' : 'Reports go to the site admins only; the writer is not told who reported them.');
		dialog.classList.add('is-visible');
		(ok ? part('.report-dialog__reason') : part('.report-dialog__btn:not(.report-dialog__btn--send)')).focus();
	}

	function closeReport() {
		if (dialog) dialog.classList.remove('is-visible');
		pending = null;
	}

	async function sendReport() {
		if (!pending || !account) return;
		const o = pending;
		const sendBtn = part('.report-dialog__btn--send');
		sendBtn.disabled = true;
		const r = { by: account.uid, kind: o.kind, target: o.target, reason: part('.report-dialog__reason').value, at: TS() };
		const note = part('.report-dialog__note').value.trim().slice(0, 500);
		if (note) r.note = note;
		for (const k of ['conv', 'msg', 'cat', 'thread', 'post', 'comment', 'team']) if (o[k]) r[k] = String(o[k]);
		// One report a minute per account (report_limits/, shared with
		// reports of players); a message's report lets the admins read
		// that conversation (dm_flags/).
		const u = { ['content_reports/' + newKey('content_reports')]: r, ['report_limits/' + account.uid]: TS() };
		if (o.kind === 'dm') u['dm_flags/' + o.conv + '/' + o.msg] = TS();
		try {
			await db().ref().update(u);
			part('.report-dialog__form').hidden = true;
			sendBtn.hidden = true;
			setMsg('Thank you. An admin will look at it.', true);
		} catch (e) {
			console.error('[Report] failed:', e);
			sendBtn.disabled = false;
			setMsg('The report could not be sent. Please wait a minute and try again (one report a minute).');
		}
	}

	window.SigilCommunity = {
		ROOT,
		LIMITS,
		get user() { return account; },
		onUser,
		roles,
		name,
		fillNames,
		when,
		fullTime,
		serverNow,
		commit,
		LimitError,
		errorText,
		newKey,
		slugify,
		mask,
		md,
		excerpt,
		report,
		REASONS,
		TS,
	};
})();
