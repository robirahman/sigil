/**
 * inbox.js — the "Inbox (N)" link in the header of every page that loads
 * auth-status.js (which loads this): unread notifications
 * (notifications/{uid}, written by the server, functions/community.js) plus
 * conversations with a message not yet read (dm_index/{uid}). Signed-in
 * accounts only; nothing shows while there is nothing unread.
 */
(function () {
	const script = document.currentScript;
	const ROOT = script && script.src ? new URL('../../', script.src).href : '';
	if (typeof firebase === 'undefined') return;

	// How much of each list is watched: the inbox page shows as many.
	const WATCH = 50;
	let uid = null;
	let notes = 0;
	let convos = 0;
	let refs = [];
	const listeners = [];

	function render() {
		const el = document.getElementById('auth-status');
		if (!el) return;
		let a = el.querySelector('.auth-status__inbox');
		const n = notes + convos;
		if (!uid || !n) {
			if (a) a.remove();
			return;
		}
		if (!a) {
			a = document.createElement('a');
			a.className = 'auth-status__inbox';
			a.style.cssText = 'margin-left:12px;color:var(--color-accent, #8af);font-weight:bold;text-decoration:none;white-space:nowrap';
			el.appendChild(a);
		}
		// Straight to the messages when that is all there is.
		a.href = ROOT + 'inbox.html' + (convos && !notes ? '?tab=messages' : '');
		a.textContent = 'Inbox (' + n + ')';
		a.title = notes + ' notification' + (notes === 1 ? '' : 's') + ', ' + convos + ' unread conversation' + (convos === 1 ? '' : 's');
	}

	function emit() {
		render();
		listeners.forEach((fn) => { try { fn({ notes, convos }); } catch (e) { /* ignore */ } });
	}

	/** Is this conversation index entry unread by its owner `me`? */
	function unread(entry, me) {
		return !!entry && typeof entry.lastFrom === 'string' && entry.lastFrom !== me && !(entry.read >= entry.last);
	}

	function start(user) {
		uid = user.uid;
		const db = firebase.database();
		const nref = db.ref('notifications/' + uid).orderByChild('at').limitToLast(WATCH);
		nref.on('value', (s) => {
			let n = 0;
			s.forEach((c) => { if (!(c.val() || {}).read) n++; });
			notes = n;
			emit();
		}, () => {});
		const dref = db.ref('dm_index/' + uid).orderByChild('last').limitToLast(WATCH);
		dref.on('value', (s) => {
			let n = 0;
			s.forEach((c) => { if (unread(c.val(), uid)) n++; });
			convos = n;
			emit();
		}, () => {});
		refs = [nref, dref];
	}

	function stop() {
		refs.forEach((r) => r.off());
		refs = [];
		uid = null;
		notes = 0;
		convos = 0;
		emit();
	}

	firebase.auth().onAuthStateChanged((user) => {
		stop();
		if (user && !user.isAnonymous) start(user);
	});
	window.addEventListener('sigil-auth-refresh', () => {
		const user = firebase.auth().currentUser;
		if (user && !user.isAnonymous && uid !== user.uid) { stop(); start(user); }
	});

	window.SigilInbox = {
		get unread() { return { notes, convos }; },
		onChange(fn) { listeners.push(fn); fn({ notes, convos }); },
		isUnread: unread,
		render,
	};
})();
