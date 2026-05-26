/**
 * auth-status.js — shows login status in the page header.
 *
 * Looks for an element with id="auth-status" and populates it
 * with the user's display name or a "Sign in" link.
 *
 * Requires Firebase App, Auth, and Database SDKs to be loaded.
 */
(function () {
	// Register the offline service worker from any page that loads this
	// script — this is most pages, so any direct visit (bookmark to
	// leaderboard, profile, etc.) gets the SW installed for next time.
	if ('serviceWorker' in navigator) {
		window.addEventListener('load', function () {
			navigator.serviceWorker.register('sw.js').catch(function (e) {
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

	const el = document.getElementById('auth-status');
	if (!el) return;

	firebase.auth().onAuthStateChanged(async function (user) {
		if (user && !user.isAnonymous) {
			let name = user.displayName || 'Player';
			// Try to load display name from RTDB profile
			try {
				const snap = await firebase.database().ref('users/' + user.uid + '/displayName').once('value');
				if (snap.exists()) name = snap.val();
			} catch (e) { /* ignore */ }
			el.innerHTML = '<a class="auth-status__name" href="profile.html?uid=' + encodeURIComponent(user.uid) + '" style="color: inherit; text-decoration: none;">' + _escHtml(name) + '</a>';
		} else {
			el.innerHTML = '<a class="auth-status__link" href="account.html">Sign in</a>';
		}
	});

	function _escHtml(s) {
		var d = document.createElement('div');
		d.textContent = s;
		return d.innerHTML;
	}
})();
