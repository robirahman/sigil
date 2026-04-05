/**
 * auth-status.js — shows login status in the page header.
 *
 * Looks for an element with id="auth-status" and populates it
 * with the user's display name or a "Sign in" link.
 *
 * Requires Firebase App, Auth, and Database SDKs to be loaded.
 */
(function () {
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
			el.innerHTML = '<span class="auth-status__name">' + _escHtml(name) + '</span>';
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
