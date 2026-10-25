/**
 * auth-status.js — shows login status in the page header.
 *
 * Looks for an element with id="auth-status" and populates it
 * with the user's display name or a "Sign in" link.
 *
 * Requires Firebase App, Auth, and Database SDKs to be loaded.
 */
(function () {
	// The site root, from this script's own URL, so pages in subfolders
	// (packs/, spells/) reach the same files.
	const ROOT = document.currentScript && document.currentScript.src
		? new URL('../../', document.currentScript.src).href : '';

	// Register the offline service worker from any page that loads this
	// script — this is most pages, so any direct visit (bookmark to
	// leaderboard, profile, etc.) gets the SW installed for next time.
	if ('serviceWorker' in navigator) {
		window.addEventListener('load', function () {
			navigator.serviceWorker.register(ROOT + 'sw.js').catch(function (e) {
				console.warn('SW registration failed:', e);
			});
		});
	}

	// Global offline banner. Self-injects so individual pages don't need
	// HTML edits; visible only while navigator.onLine is false.
	(function setupOfflineBanner() {
		var banner = document.createElement('div');
		banner.id = 'global-offline-banner';
		banner.style.cssText = [
			'background:#b58c00', 'color:#fff', 'padding:8px 16px',
			'text-align:center', "font-family:'Overlock',sans-serif",
			'font-size:0.9em', 'position:fixed', 'top:0', 'left:0',
			'right:0', 'z-index:9999', 'display:none',
		].join(';');
		banner.textContent = "You're offline — sign-in, leaderboard, and online multiplayer are unavailable. Local play still works.";
		function update() {
			banner.style.display = navigator.onLine ? 'none' : 'block';
		}
		function inject() {
			if (banner.isConnected || !document.body) return;
			document.body.insertBefore(banner, document.body.firstChild);
			update();
		}
		if (document.body) inject();
		else document.addEventListener('DOMContentLoaded', inject);
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
	})();

	if (typeof firebase === 'undefined') return;

	// "Your move" badge and turn notifications (turn-notify.js), which need
	// the shared turn rule (engine/room-clock.js) first.
	(function loadTurnNotify() {
		const add = (src) => {
			const s = document.createElement('script');
			s.src = ROOT + src;
			s.async = false;
			document.head.appendChild(s);
		};
		if (typeof roomTimeLeft !== 'function') add('static/scripts/engine/room-clock.js');
		add('static/scripts/turn-notify.js');
	})();

	const el = document.getElementById('auth-status');
	if (!el) return;

	// Linking a guest to an email or Google account keeps the same user, so
	// onAuthStateChanged does not fire; AuthManager dispatches
	// 'sigil-auth-refresh' after an upgrade so the header catches up.
	firebase.auth().onAuthStateChanged(renderStatus);
	window.addEventListener('sigil-auth-refresh', function () {
		renderStatus(firebase.auth().currentUser);
	});

	async function renderStatus(user) {
		if (user && !user.isAnonymous) {
			const render = function (name) {
				el.innerHTML = '<a class="auth-status__name" href="' + ROOT + 'profile.html?uid=' + encodeURIComponent(user.uid) + '" style="color: inherit; text-decoration: none;">' + _escHtml(name) + '</a>';
				if (window.SigilTurns) window.SigilTurns.renderBadge();
			};
			// Show the Auth name at once (the read below never settles while
			// offline), then the RTDB profile name once it arrives.
			render(user.displayName || 'Player');
			try {
				const snap = await firebase.database().ref('users/' + user.uid + '/displayName').once('value');
				if (snap.exists() && firebase.auth().currentUser === user) render(snap.val());
			} catch (e) { /* ignore */ }
		} else {
			el.innerHTML = '<a class="auth-status__link" href="' + ROOT + 'account.html">Sign in</a>';
		}
	}

	function _escHtml(s) {
		var d = document.createElement('div');
		d.textContent = s;
		return d.innerHTML;
	}
})();
