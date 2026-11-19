/**
 * site-events.js — scheduled site events and announcements: the banner on
 * every page that loads auth-status.js (which loads this), and SigilEvents for
 * events.html.
 *
 *   site_events/{id}: { kind: 'announcement'|'event', title, body?, link?,
 *                       startsAt, endsAt, by, at }
 *
 * Posted by admins on admin.html (the rules let only admins/{uid} write).
 * An announcement shows from startsAt to endsAt; an event from a day before
 * it starts ("starts in 3 h") until it ends ("happening now"). Each can be
 * dismissed (per browser). The banner stays off game screens (game.html, a
 * game in multiplayer.html, Sigil TV's embedded game) so it never moves a
 * board.
 */
(function () {
	const script = document.currentScript;
	const ROOT = script && script.src ? new URL('../../', script.src).href : '';
	const DISMISS_KEY = 'sigil_dismissed_events';
	// Events are announced in the banner from this long before they start.
	const SOON_MS = 24 * 60 * 60 * 1000;
	// Items read for the banner: those not yet ended, soonest end first.
	const BANNER_READ = 20;

	function status(e, now) {
		const t = now || Date.now();
		if (!e || typeof e.startsAt !== 'number' || typeof e.endsAt !== 'number') return 'over';
		if (t >= e.endsAt) return 'over';
		if (t >= e.startsAt) return 'live';
		return t >= e.startsAt - SOON_MS ? 'soon' : 'upcoming';
	}

	function untilText(ms) {
		const m = Math.max(1, Math.round(ms / 60000));
		if (m < 60) return m + ' min';
		const h = Math.round(m / 60);
		if (h < 48) return h + ' h';
		return Math.round(h / 24) + ' days';
	}

	/** One line of status: "Happening now", "Starts in 3 h", or the date. */
	function statusText(e, now) {
		const t = now || Date.now();
		const s = status(e, t);
		if (e.kind === 'announcement') return s === 'over' ? 'Ended ' + new Date(e.endsAt).toLocaleDateString() : '';
		if (s === 'live') return 'Happening now';
		if (s === 'soon') return 'Starts in ' + untilText(e.startsAt - t);
		if (s === 'upcoming') return new Date(e.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
		return 'Ended ' + new Date(e.endsAt).toLocaleDateString();
	}

	/** An admin's link, only https:// or a page of this site (the rules check the same). */
	function safeLink(link) {
		if (typeof link !== 'string' || !link) return null;
		if (/^https:\/\/[^\s]+$/.test(link)) return link;
		if (/^[a-z0-9-]+\.html([?#][^\s]*)?$/.test(link)) return ROOT + link;
		return null;
	}

	function bannerItems(list, now) {
		const t = now || Date.now();
		return list.filter((e) => {
			const s = status(e, t);
			return e.kind === 'announcement' ? s === 'live' : (s === 'live' || s === 'soon');
		}).sort((a, b) => {
			// Announcements first (newest), then events happening now, then
			// the soonest to start.
			const rank = (e) => (e.kind === 'announcement' ? 0 : status(e, t) === 'live' ? 1 : 2);
			return (rank(a) - rank(b)) || (rank(a) === 0 ? b.startsAt - a.startsAt : a.startsAt - b.startsAt);
		});
	}

	function dismissed() {
		try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {}; } catch (e) { return {}; }
	}

	function dismiss(id, endsAt) {
		try {
			const d = dismissed();
			d[id] = endsAt || 1;
			// Forget ones long over.
			for (const k of Object.keys(d)) if (typeof d[k] === 'number' && d[k] > 1 && d[k] < Date.now() - 86400000) delete d[k];
			localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
		} catch (e) { /* storage blocked: dismissed for this page only */ }
	}

	window.SigilEvents = { status, statusText, untilText, safeLink, bannerItems, SOON_MS };

	if (typeof firebase === 'undefined') return;

	let items = [];
	const hiddenNow = {};

	function offGameScreen() {
		if (window.top !== window) return false;
		const b = document.body;
		return !!b && !b.classList.contains('game-page') && !b.classList.contains('zen-page') && !b.classList.contains('tv-embed');
	}

	function injectStyle() {
		if (document.getElementById('site-event-style')) return;
		const st = document.createElement('style');
		st.id = 'site-event-style';
		st.textContent = [
			'.site-event-banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 12px;margin:0 auto;padding:8px 44px 8px 16px;position:relative;box-sizing:border-box;width:100%;background:var(--color-surface-raised,#2b2b2b);border-bottom:2px solid var(--color-accent,#c9a227);color:var(--color-text-warm,#eee);font-family:\'Overlock\',sans-serif;font-size:.95em;text-align:center;}',
			'.site-event-banner__kind{font-family:\'Arvo\',serif;color:var(--color-accent,#c9a227);text-transform:uppercase;font-size:.8em;letter-spacing:.06em;}',
			'.site-event-banner__title{color:var(--color-text-bright,#fff);font-weight:bold;}',
			'.site-event-banner a{color:var(--color-accent,#c9a227);}',
			'.site-event-banner__close{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:inherit;font-size:1.1em;cursor:pointer;padding:4px 8px;}',
		].join('\n');
		document.head.appendChild(st);
	}

	function render() {
		if (!document.body) {
			document.addEventListener('DOMContentLoaded', render, { once: true });
			return;
		}
		let box = document.getElementById('site-event-banner');
		const d = dismissed();
		const shown = bannerItems(items).filter((e) => !d[e.id] && !hiddenNow[e.id]);
		if (!shown.length || !offGameScreen()) {
			if (box) box.remove();
			return;
		}
		injectStyle();
		if (!box) {
			box = document.createElement('div');
			box.id = 'site-event-banner';
			box.className = 'site-event-banner';
			box.setAttribute('role', 'region');
			box.setAttribute('aria-label', 'Site announcements');
			const header = document.querySelector('body > header');
			if (header) header.insertAdjacentElement('afterend', box);
			else document.body.insertBefore(box, document.body.firstChild);
		}
		const e = shown[0];
		box.dataset.event = e.id;
		box.textContent = '';
		const kind = document.createElement('span');
		kind.className = 'site-event-banner__kind';
		kind.textContent = e.kind === 'announcement' ? 'Announcement' : 'Event';
		const title = document.createElement('span');
		title.className = 'site-event-banner__title';
		title.textContent = e.title;
		box.append(kind, title);
		const st = statusText(e);
		if (st) {
			const s = document.createElement('span');
			s.className = 'site-event-banner__when';
			s.textContent = st;
			box.append(s);
		}
		const href = safeLink(e.link);
		const more = document.createElement('a');
		more.href = href || (ROOT + 'events.html#' + encodeURIComponent(e.id));
		more.textContent = href ? 'Details' : (e.body ? 'Read more' : 'All events');
		if (href && /^https:/.test(href)) { more.target = '_blank'; more.rel = 'noopener'; }
		box.append(more);
		if (shown.length > 1) {
			const all = document.createElement('a');
			all.href = ROOT + 'events.html';
			all.textContent = '(+' + (shown.length - 1) + ' more)';
			box.append(all);
		}
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'site-event-banner__close';
		close.setAttribute('aria-label', 'Dismiss');
		close.title = 'Dismiss';
		close.textContent = '✕';
		close.addEventListener('click', () => {
			dismiss(e.id, e.endsAt);
			hiddenNow[e.id] = true;
			render();
		});
		box.append(close);
	}

	function start() {
		try {
			firebase.database().ref('site_events').orderByChild('endsAt').startAt(Date.now()).limitToFirst(BANNER_READ)
				.on('value', (snap) => {
					const list = [];
					snap.forEach((c) => { const v = c.val(); if (v && typeof v.title === 'string') list.push(Object.assign({ id: c.key }, v)); });
					items = list;
					render();
				}, () => {});
		} catch (e) { return; }
		// The countdown, and items starting or ending while the page is open.
		setInterval(render, 60000);
		// A game starting or ending in multiplayer.html toggles zen-page.
		const watchBody = () => new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['class'] });
		if (document.body) watchBody(); else document.addEventListener('DOMContentLoaded', watchBody, { once: true });
	}

	// Inside an iframe (Sigil TV's game) there is never a banner.
	if (window.top === window) start();
})();
