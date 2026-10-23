/**
 * Service worker for offline app-shell support.
 *
 * Caches everything a local game needs, so the menu, Local 1v1 and vs AI can
 * be started and played with no connection at all — opening a new game never
 * needs the site. Finished games are stored locally and uploaded to Firebase
 * when it is reachable again (offline-queue.js).
 *
 * Strategy:
 *   - HTML navigations: network-first with a short timeout, falling back to
 *     the cached page. Pages are cached by path, so game.html?ai=…&id=… is
 *     served from the one precached game.html whatever its query string.
 *   - Same-origin static (CSS/JS/images): stale-while-revalidate
 *   - Cross-origin (Firebase/Alpine/Popper/fonts): cache-first for what we
 *     cached, network otherwise
 */

// Spell lists (CORE_* and EXPANSIONS) for the spell-art precache below. The
// file is DOM-free (the AI worker loads it too). Browsers also re-check
// imported scripts for updates, so a new spell reinstalls the worker.
try {
	importScripts('static/scripts/engine/constants.js');
} catch (e) { /* precache falls back to the static list only */ }

const CACHE_VERSION = 'v84';
const CACHE_NAME = 'sigil-shell-' + CACHE_VERSION;

const SAME_ORIGIN_PRECACHE = [
	'./',
	'./index.html',
	'./game.html',
	'./multiplayer.html',
	'./account.html',
	'./leaderboard.html',
	'./active-games.html',
	'./profile.html',
	'./puzzles.html',
	'./annotate.html',
	'./spells.html',
	'./spells/index.html',
	'./packs/index.html',
	'./strategy-guide.html',
	'./static/data/spell-charts.json',
	'./static/data/spell-charts-engine.json',
	'./static/data/position-winprob.json',
	// The puzzle set (the page fetches it no-cache; this makes it work offline
	// from the first visit).
	'./static/puzzles/mate_puzzles.json',
	'./static/scripts/puzzle-rating.js',
	'./cataclysm.html',
	'./firebase-setup.html',
	'./static/css/global.css?v202305191',
	'./static/css/layout.css',
	'./static/css/styles.css',
	'./static/css/compendium.css',
	'./static/css/help.css',
	'./static/css/ladder.css',
	'./static/css/form.css',
	'./static/scripts/theme-manager.js',
	'./static/scripts/auth-status.js',
	'./static/scripts/sound-manager.js',
	'./static/scripts/spell-effects.js',
	'./static/scripts/board-geometry.js',
	'./static/scripts/game-board-local.js',
	'./static/scripts/game-board-local.js?v=34',
	'./static/scripts/engine/rust-ai.js?v=34',
	'./static/scripts/game-board-multiplayer.js',
	'./static/scripts/game-board-multiplayer.js?v=34',
	'./static/scripts/help.js',
	'./static/scripts/offline-queue.js',
	'./static/scripts/local-save-store.js',
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
	'./static/scripts/engine/rust-ai.js',
	// The Rust engine's wasm build. These three are fetched at RUNTIME with
	// ?v=<RUST_ENGINE_VERSION> (rust-ai.js), so the versioned URLs are what
	// must be precached — bump the ?v= here in lockstep with rust-ai.js and
	// CACHE_VERSION on every engine rebuild (engine/build-wasm.sh reminds).
	// The pages load rust-ai.js and game-review.js as ?v=<RUST_ENGINE_VERSION> too
	// (game.html, multiplayer.html, puzzles.html, annotate.html, dev/engine-disputes.html,
	// dev/enumeration-gaps.html),
	// so an old worker's cached copies are never served to a fresh page: bump those
	// script tags as well.
	'./static/scripts/engine/rust-worker.js?v=34',
	'./static/wasm/sigil_engine.js?v=34',
	'./static/wasm/sigil_engine_bg.wasm?v=34',
	'./static/scripts/engine/ai-player.js',
	'./static/scripts/engine/game-clock.js',
	'./static/scripts/engine/game-controller.js',
	'./static/scripts/engine/game-review.js?v=34',
	'./static/scripts/engine/auth-manager.js',
	'./static/scripts/engine/elo.js',
	'./static/scripts/engine/elo.js?v=34',
	'./static/scripts/engine/position-rating.js?v=34',
	'./static/scripts/engine/firebase-sync.js',
	'./static/scripts/engine/firebase-sync.js?v=34',
	'./static/scripts/engine/multiplayer-controller.js',
	'./static/scripts/engine/multiplayer-controller.js?v=34',
	'./static/scripts/engine/spectator-controller.js',
	'./static/images/game-board.webp',
	'./static/images/game-board.jpg',
	'./static/images/logo-icon.svg',
	'./static/images/sigil-online-logo.svg',
	'./static/images/blue-wins.svg',
	'./static/images/red-wins.svg',
	'./static/images/spacer.gif',
	'./static/images/tiled-background.webp',
	'./static/images/tiled-background.jpg',
	'./static/images/stones/red.png',
	'./static/images/stones/blue.png',
	'./static/images/stones/red.webp',
	'./static/images/stones/blue.webp',
	'./static/images/send-icon.svg',
	'./static/images/step-pointer.svg',
	'./static/images/swoosh-separator.svg',
	// Theme art (tools/themes/build_theme_assets.py), with the .jpg/.png
	// fallbacks browsers without WebP request, like the Arcane art above.
	'./static/images/themes/tiled-background-frost.jpg?v3',
	'./static/images/themes/tiled-background-parchment.jpg?v3',
	'./static/images/themes/tiled-background-forest.jpg?v3',
	'./static/images/themes/tiled-background-volcanic.jpg?v3',
	'./static/images/themes/game-board-frost.webp',
	'./static/images/themes/game-board-parchment.webp',
	'./static/images/themes/game-board-forest.webp',
	'./static/images/themes/game-board-volcanic.webp',
	'./static/images/themes/stones/frost-red.webp',
	'./static/images/themes/stones/frost-blue.webp',
	'./static/images/themes/stones/parchment-red.webp',
	'./static/images/themes/stones/parchment-blue.webp',
	'./static/images/themes/stones/forest-red.webp',
	'./static/images/themes/stones/forest-blue.webp',
	'./static/images/themes/stones/volcanic-red.webp',
	'./static/images/themes/stones/volcanic-blue.webp',
	'./static/images/themes/game-board-frost.jpg',
	'./static/images/themes/game-board-parchment.jpg',
	'./static/images/themes/game-board-forest.jpg',
	'./static/images/themes/game-board-volcanic.jpg',
	'./static/images/themes/stones/frost-red.png',
	'./static/images/themes/stones/frost-blue.png',
	'./static/images/themes/stones/parchment-red.png',
	'./static/images/themes/stones/parchment-blue.png',
	'./static/images/themes/stones/forest-red.png',
	'./static/images/themes/stones/forest-blue.png',
	'./static/images/themes/stones/volcanic-red.png',
	'./static/images/themes/stones/volcanic-blue.png',
	// Spell art is added by spellArtUrls() below.
];

// Spell tile art. The board draws 9 spells from the selected packs, and any
// of them could appear, so every spell's art is cached to keep every random
// layout playable offline: the .webp the board shows (normal and art-only),
// plus the .png fallback for browsers without WebP. Art that is missing
// (404) is skipped by the install loop.
function spellArtUrls() {
	const names = new Set();
	try {
		[CORE_RITUALS, CORE_SORCERIES, CORE_CHARMS].forEach((l) => l.forEach((n) => names.add(n)));
		// Panda has no art (the board shows names only).
		Object.keys(EXPANSIONS).filter((k) => k !== 'panda').forEach((k) => {
			const x = EXPANSIONS[k];
			[x.rituals, x.sorceries, x.charms].forEach((l) => l.forEach((n) => names.add(n)));
		});
	} catch (e) {
		// constants.js failed to load: at least the core set.
		['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning', 'Grow', 'Fireblast',
			'Hail_Storm', 'Meteor', 'Seal_of_Wind', 'Sprout', 'Slash', 'Surge', 'Comet',
			'Seal_of_Summer'].forEach((n) => names.add(n));
	}
	const urls = [];
	names.forEach((n) => {
		urls.push('./static/images/spells/' + n + '.webp');
		urls.push('./static/images/spells/art_only/' + n + '.webp');
		urls.push('./static/images/spells/' + n + '.png');
	});
	return urls;
}

// Cross-origin dependencies fetched as no-cors so the opaque responses can
// be stored in the cache and served back to <script>/<link> elements when
// the network is down.
const CROSS_ORIGIN_PRECACHE = [
	'https://unpkg.com/alpinejs@3.10.4/dist/cdn.min.js',
	'https://unpkg.com/@popperjs/core@2.11.6/dist/umd/popper.min.js',
	'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
	'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
	'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
	'https://use.typekit.net/rot4udi.css',
	'https://fonts.googleapis.com/css2?family=Arvo&family=Overlock&display=swap',
];

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		const sameOrigin = SAME_ORIGIN_PRECACHE.concat(spellArtUrls()).map((url) => ({ url, mode: 'cors' }));
		const crossOrigin = CROSS_ORIGIN_PRECACHE.map((url) => ({ url, mode: 'no-cors' }));
		await Promise.all([...sameOrigin, ...crossOrigin].map(async ({ url, mode }) => {
			try {
				const resp = await fetch(url, { mode, cache: 'reload' });
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

const NAV_TIMEOUT_MS = 3500;

// Pages are the same HTML whatever their query string (game.html?ai=…&id=…
// configures the game client-side), so they are cached under the bare path.
function pageCacheKey(url) {
	return url.origin + url.pathname;
}

async function cachedPage(url) {
	const cache = await caches.open(CACHE_NAME);
	let hit = await cache.match(pageCacheKey(url));
	if (!hit && url.pathname.endsWith('/')) hit = await cache.match(pageCacheKey(url) + 'index.html');
	if (!hit) hit = await cache.match(url.href, { ignoreSearch: true });
	return hit || null;
}

// Cross-origin isolation for the pages that run the threaded engine (2026-10-12).
// GitHub Pages cannot send headers, so this worker adds COOP/COEP to those pages
// (the coi-serviceworker pattern) and COEP to the engine's worker scripts.
// `credentialless` (not require-corp) keeps the CDN scripts, fonts and Firebase
// loading without CORP headers; browsers without it (Safari) simply stay
// un-isolated and the engine runs on one thread, as before. game.html has no
// sign-in (COOP same-origin would break the Google sign-in popup), so only the
// game page is isolated. The first visit, before this worker controls the page,
// is never isolated.
const ISOLATED_PAGES = ['/game.html'];
function isIsolatedPage(url) {
	return ISOLATED_PAGES.some((p) => url.pathname.endsWith(p));
}
function isEngineWorkerScript(url) {
	return url.pathname.endsWith('/static/scripts/engine/rust-worker.js')
		|| url.pathname.includes('/static/wasm-mt/');
}
function withHeaders(resp, extra) {
	if (!resp || resp.status === 0 || resp.type === 'opaqueredirect') return resp;
	const h = new Headers(resp.headers);
	for (const [k, v] of Object.entries(extra)) h.set(k, v);
	return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
const ISOLATION_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'credentialless',
};
const WORKER_ISOLATION_HEADERS = {
	'Cross-Origin-Embedder-Policy': 'credentialless',
	'Cross-Origin-Resource-Policy': 'same-origin',
};

async function handleNavigation(req, url, event) {
	const resp = await handleNavigationRaw(req, url, event);
	return isIsolatedPage(url) ? withHeaders(resp, ISOLATION_HEADERS) : resp;
}

async function handleNavigationRaw(req, url, event) {
	const network = fetch(req).then((resp) => {
		if (resp && resp.ok) {
			const copy = resp.clone();
			event.waitUntil(caches.open(CACHE_NAME)
				.then((c) => c.put(pageCacheKey(url), copy)).catch(() => {}));
		}
		return resp;
	});
	network.catch(() => {});

	const fallback = async () => {
		const cached = await cachedPage(url);
		if (cached) return cached;
		const home = await caches.match(new URL('./index.html', self.registration.scope).href);
		if (home) return home;
		return null;
	};

	if (self.navigator && self.navigator.onLine === false) {
		const cached = await fallback();
		if (cached) return cached;
	}

	let timer;
	const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), NAV_TIMEOUT_MS); });
	try {
		const first = await Promise.race([network, timeout]);
		if (first !== 'timeout') {
			clearTimeout(timer);
			return first;
		}
		// Network is slow: serve the cached page if there is one, else keep waiting.
		const cached = await cachedPage(url);
		if (cached) return cached;
		return await network;
	} catch (e) {
		clearTimeout(timer);
		const cached = await fallback();
		if (cached) return cached;
		return new Response('Offline and no cached page available.', {
			status: 503,
			headers: { 'Content-Type': 'text/plain' },
		});
	}
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	const sameOrigin = url.origin === self.location.origin;

	// HTML navigations: network-first so deploys propagate, cache fallback for
	// offline. A slow or dead connection falls back after NAV_TIMEOUT_MS
	// instead of hanging the game start.
	const isNavigation = req.mode === 'navigate' ||
		(req.destination === 'document') ||
		(req.headers.get('accept') || '').includes('text/html');
	if (isNavigation && sameOrigin) {
		event.respondWith(handleNavigation(req, url, event));
		return;
	}
	if (isNavigation) return;

	// Same-origin static: stale-while-revalidate. The engine's worker scripts
	// carry COEP so a worker started by an isolated page is isolated too.
	if (sameOrigin) {
		const workerHeaders = isEngineWorkerScript(url) ? WORKER_ISOLATION_HEADERS : null;
		event.respondWith((async () => {
			const resp = await staticResponse();
			return workerHeaders ? withHeaders(resp, workerHeaders) : resp;
		})());
		return;
	}
	// (declared after the early return above, hoisted)
	async function staticResponse() {
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
	}

	// Cross-origin: cache-first when the asset is one we precached (CDN
	// scripts, fonts) so an offline reload doesn't even attempt the network;
	// network-first otherwise (Firebase RTDB / Auth traffic that the SW also
	// sees a little of). Either way we cache successful or opaque responses.
	event.respondWith((async () => {
		const cache = await caches.open(CACHE_NAME);
		const cached = await cache.match(req);
		if (cached) {
			// Refresh in background; don't block the page.
			fetch(req).then((resp) => {
				if (resp && (resp.ok || resp.type === 'opaque')) {
					cache.put(req, resp.clone()).catch(() => {});
				}
			}).catch(() => {});
			return cached;
		}
		try {
			const resp = await fetch(req);
			if (resp && (resp.ok || resp.type === 'opaque')) {
				cache.put(req, resp.clone()).catch(() => {});
			}
			return resp;
		} catch (e) {
			throw e;
		}
	})());
});
