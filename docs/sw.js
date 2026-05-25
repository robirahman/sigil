/**
 * Service worker for offline app-shell support.
 *
 * Caches the static assets so the menu and single-player flows work without
 * a network connection. Firebase RTDB / Auth still need a live connection at
 * write time — the offline-queue.js module handles that.
 *
 * Strategy:
 *   - HTML navigations: network-first, fall back to cache, then to /index.html
 *   - Same-origin static (CSS/JS/images): stale-while-revalidate
 *   - Cross-origin (Firebase/Alpine/Popper/fonts): network-first, cache fallback
 */
const CACHE_VERSION = 'v8';
const CACHE_NAME = 'sigil-shell-' + CACHE_VERSION;

const PRECACHE_URLS = [
	'./',
	'./index.html',
	'./game.html',
	'./multiplayer.html',
	'./account.html',
	'./leaderboard.html',
	'./active-games.html',
	'./profile.html',
	'./puzzles.html',
	'./cataclysm.html',
	'./cataclysm-game.html',
	'./firebase-setup.html',
	'./static/css/global.css?v202305191',
	'./static/css/layout.css',
	'./static/css/styles.css',
	'./static/css/help.css',
	'./static/scripts/theme-manager.js',
	'./static/scripts/auth-status.js',
	'./static/scripts/sound-manager.js',
	'./static/scripts/spell-effects.js',
	'./static/scripts/game-board-local.js',
	'./static/scripts/game-board-multiplayer.js',
	'./static/scripts/help.js',
	'./static/scripts/offline-queue.js',
	'./static/scripts/engine/constants.js',
	'./static/scripts/engine/notation.js',
	'./static/scripts/engine/board.js',
	'./static/scripts/engine/moves.js',
	'./static/scripts/engine/spells.js',
	'./static/scripts/engine/sim-board.js',
	'./static/scripts/engine/features.js',
	'./static/scripts/engine/sigil-net.js',
	'./static/scripts/engine/sigil-net-graph.js',
	'./static/scripts/engine/strategic-eval.js',
	'./static/scripts/engine/enumerator.js',
	'./static/scripts/engine/mcts.js',
	'./static/scripts/engine/minimax-ai.js',
	'./static/scripts/engine/caveman-ai.js',
	'./static/scripts/engine/ai-worker.js',
	'./static/scripts/engine/ai-player.js',
	'./static/scripts/engine/game-controller.js',
	'./static/scripts/engine/game-review.js',
	'./static/scripts/engine/auth-manager.js',
	'./static/scripts/engine/elo.js',
	'./static/images/game-board.webp',
	'./static/images/game-board.jpg',
	'./static/images/logo-icon.svg',
	'./static/images/sigil-online-logo.svg',
	'./static/images/blue-wins.svg',
	'./static/images/red-wins.svg',
	'./static/images/spacer.gif',
	'./static/images/tiled-background.webp',
	'./static/images/tiled-background.jpg',
];

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		// addAll is atomic; if one fails, none are cached. Add individually
		// so a missing or renamed asset doesn't block the whole install.
		await Promise.all(PRECACHE_URLS.map(async (url) => {
			try {
				const resp = await fetch(url, { cache: 'reload' });
				if (resp.ok || resp.type === 'opaque') {
					await cache.put(url, resp);
				}
			} catch (e) { /* offline at install time — ignore */ }
		}));
		self.skipWaiting();
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		const keys = await caches.keys();
		await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	const sameOrigin = url.origin === self.location.origin;

	// HTML navigations: network-first so deploys propagate, cache fallback for offline.
	const isNavigation = req.mode === 'navigate' ||
		(req.destination === 'document') ||
		(req.headers.get('accept') || '').includes('text/html');
	if (isNavigation) {
		event.respondWith((async () => {
			try {
				const resp = await fetch(req);
				if (resp && resp.ok && sameOrigin) {
					const copy = resp.clone();
					caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
				}
				return resp;
			} catch (e) {
				const cached = await caches.match(req);
				if (cached) return cached;
				const fallback = await caches.match('./index.html');
				if (fallback) return fallback;
				return new Response('Offline and no cached page available.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain' },
				});
			}
		})());
		return;
	}

	// Same-origin static: stale-while-revalidate.
	if (sameOrigin) {
		event.respondWith((async () => {
			const cache = await caches.open(CACHE_NAME);
			const cached = await cache.match(req);
			const networkPromise = fetch(req).then((resp) => {
				if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
				return resp;
			}).catch(() => null);
			if (cached) {
				// Kick off background revalidation but return cached immediately.
				networkPromise.catch(() => {});
				return cached;
			}
			const network = await networkPromise;
			if (network) return network;
			return new Response('Offline', { status: 504, headers: { 'Content-Type': 'text/plain' } });
		})());
		return;
	}

	// Cross-origin: network-first, fall back to cache (for Firebase/Alpine/Popper/fonts).
	// Firebase live database traffic uses long-polling/websockets and won't pass through
	// here, so we're really just covering the static SDK script downloads.
	event.respondWith((async () => {
		const cache = await caches.open(CACHE_NAME);
		try {
			const resp = await fetch(req);
			if (resp && (resp.ok || resp.type === 'opaque')) {
				cache.put(req, resp.clone()).catch(() => {});
			}
			return resp;
		} catch (e) {
			const cached = await cache.match(req);
			if (cached) return cached;
			throw e;
		}
	})());
});
