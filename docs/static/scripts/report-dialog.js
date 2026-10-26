/**
 * "Report a player": a small dialog that files reports/{pushId}
 * ({ by, target, room, reason, note, at }). The rules make reports
 * create-only and readable by admins only (admin.html); the reporter needs a
 * signed-in, non-guest account. Used by profile.html and the online
 * game-over modal (multiplayer.html).
 *
 *   SigilReport.open({ target: uid, name: 'Bob', room: 'ABC234' })
 */
(function () {
	const REASONS = [
		['cheating', 'Cheating (engine help, a modified client)'],
		['abandon', 'Leaves games instead of finishing them'],
		['stalling', 'Stalls to run down the clock'],
		['abuse', 'Abusive or offensive behaviour'],
		['name', 'Offensive display name'],
		['other', 'Something else'],
	];
	const NOTE_MAX = 500;
	let root = null;
	let current = null;

	function el(tag, attrs, text) {
		const e = document.createElement(tag);
		for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
		if (text) e.textContent = text;
		return e;
	}

	function build() {
		root = el('div', { class: 'report-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'report-dialog-title' });
		const box = el('div', { class: 'report-dialog__box' });
		box.appendChild(el('h2', { class: 'report-dialog__title', id: 'report-dialog-title' }));
		const form = el('div', { class: 'report-dialog__form' });
		form.appendChild(el('label', { for: 'report-reason' }, 'Reason'));
		const sel = el('select', { id: 'report-reason', class: 'report-dialog__reason' });
		for (const [v, t] of REASONS) sel.appendChild(el('option', { value: v }, t));
		form.appendChild(sel);
		form.appendChild(el('label', { for: 'report-note' }, 'What happened? (optional)'));
		const note = el('textarea', { id: 'report-note', class: 'report-dialog__note', rows: '4', maxlength: String(NOTE_MAX) });
		form.appendChild(note);
		box.appendChild(form);
		box.appendChild(el('p', { class: 'report-dialog__msg', 'aria-live': 'polite' }));
		const actions = el('div', { class: 'report-dialog__actions' });
		const send = el('button', { class: 'report-dialog__btn report-dialog__btn--send', type: 'button' }, 'Send report');
		const cancel = el('button', { class: 'report-dialog__btn', type: 'button' }, 'Cancel');
		send.addEventListener('click', submit);
		cancel.addEventListener('click', close);
		actions.appendChild(send);
		actions.appendChild(cancel);
		box.appendChild(actions);
		root.appendChild(box);
		root.addEventListener('click', (e) => { if (e.target === root) close(); });
		root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
		document.body.appendChild(root);
	}

	function part(sel) { return root.querySelector(sel); }

	function setMsg(text, ok) {
		const m = part('.report-dialog__msg');
		m.textContent = text || '';
		m.classList.toggle('report-dialog__msg--ok', !!ok);
	}

	function signedInUser() {
		try {
			const u = firebase.auth().currentUser;
			return u && !u.isAnonymous ? u : null;
		} catch (e) {
			return null;
		}
	}

	function open(opts) {
		if (!opts || !opts.target) return;
		if (!root) build();
		current = { target: String(opts.target), name: opts.name || 'this player', room: opts.room || null };
		part('.report-dialog__title').textContent = 'Report ' + current.name;
		part('.report-dialog__reason').value = 'cheating';
		part('.report-dialog__note').value = '';
		const user = signedInUser();
		const sendBtn = part('.report-dialog__btn--send');
		const form = part('.report-dialog__form');
		if (!user) {
			form.hidden = true;
			sendBtn.hidden = true;
			setMsg('Sign in with an account to report a player.');
		} else if (user.uid === current.target) {
			form.hidden = true;
			sendBtn.hidden = true;
			setMsg('You cannot report yourself.');
		} else {
			form.hidden = false;
			sendBtn.hidden = false;
			sendBtn.disabled = false;
			setMsg('Reports go to the site admins only. The player is not told who reported them.');
		}
		root.classList.add('is-visible');
		(form.hidden ? part('.report-dialog__btn:not(.report-dialog__btn--send)') : part('.report-dialog__reason')).focus();
	}

	function close() {
		if (root) root.classList.remove('is-visible');
		current = null;
	}

	async function submit() {
		const user = signedInUser();
		if (!current || !user) return;
		const sendBtn = part('.report-dialog__btn--send');
		sendBtn.disabled = true;
		const report = {
			by: user.uid,
			target: current.target,
			reason: part('.report-dialog__reason').value,
			note: part('.report-dialog__note').value.trim().slice(0, NOTE_MAX),
			at: firebase.database.ServerValue.TIMESTAMP,
		};
		if (current.room) report.room = String(current.room).slice(0, 32);
		try {
			await firebase.database().ref('reports').push(report);
			part('.report-dialog__form').hidden = true;
			sendBtn.hidden = true;
			setMsg('Thank you. An admin will look at it.', true);
		} catch (e) {
			console.error('[Report] failed:', e);
			sendBtn.disabled = false;
			setMsg('The report could not be sent. Please try again.');
		}
	}

	window.SigilReport = { open, close, REASONS };
})();
