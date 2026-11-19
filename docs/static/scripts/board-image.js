/**
 * board-image.js — the board as a picture: "Download image" (PNG) of the
 * position on the game, review, analysis and puzzle pages, an animated GIF
 * of a whole game from its review, the embeddable board (embed.html), and
 * "Copy embed code".
 *
 * The picture is drawn on a canvas from the site's own art, in the active
 * theme: the printed board (game-board.jpg, or the theme's pre-rendered
 * copy), the spell cards, the theme's stones, walls, locks, the last play
 * and the score marker, at the positions the page uses (styles.css for the
 * core board, which board-geometry.js reproduces with every offset zero;
 * boardGeometry() for the drawn layouts). Nothing leaves the browser.
 *
 *   BoardImage.stateFromSfn(sfn)          -> drawable state
 *   BoardImage.render(state, opts)        -> Promise<canvas>
 *   BoardImage.gameGif(sfns, opts)        -> Promise<Blob> (image/gif)
 *   boardExportMixin()                    -> Alpine mixin for the board pages
 *
 * A state is { layout, spells: [name per slot, spellSlotNames() order],
 * stones: {node: 'red'|'blue'|'X'|null}, redLock, blueLock, redSpringlock,
 * blueSpringlock, score, lastPlay: [nodes], redSpells, blueSpells,
 * redBank, blueBank (Providence) }.
 *
 * Needs engine/constants.js, engine/notation.js (sfnToDict) and
 * board-geometry.js; theme-manager.js (THEMES) when loaded; gif-encoder.js
 * for GIFs.
 */

const BoardImage = (() => {
	const FRAME = 1480;
	// Score-marker centres on the printed board: styles.css
	// .stone-node--score-* left/top plus half a stone.
	const CORE_SCORE = {
		tied: [740, 740], b1: [807, 778], b2: [739, 818.5], b3: [671.5, 780],
		r1: [671.8, 701.8], r2: [739.7, 661.8], r3: [807.5, 700.3],
	};
	// styles.css :root values (Arcane), for pages that do not load it.
	const DEFAULT_VARS = {
		'--color-red-lock': '#e84c3c',
		'--color-blue-lock': '#3250ba',
		'--color-last-play-outline': '#f3ec4e',
		'--color-wall': '#0a0a0a',
		'--color-bg': '#21122c',
		'--color-bg-dark': '#0d0513',
		'--color-text': '#dddcdd',
		'--color-text-muted': '#999',
		'--color-red-player': '#e84c3b',
		'--color-blue-player': '#3b41e8',
	};

	const _geo = {};
	function geometry(layout) {
		layout = layout || 'core';
		if (_geo[layout]) return _geo[layout];
		let g;
		if (layout === 'core') {
			g = _buildBoardGeometry('core', { tilt: 0, push: 0, spin: 0, manaPush: 0, frame: false });
			g = Object.assign({}, g, { ref: FRAME, score: {} });
			for (const [k, p] of Object.entries(CORE_SCORE)) g.score[k] = { x: p[0], y: p[1] };
		} else {
			g = boardGeometry(layout);
		}
		_geo[layout] = g;
		return g;
	}

	function themeId() {
		const t = document.documentElement.getAttribute('data-theme');
		return t && typeof THEMES !== 'undefined' && THEMES[t] ? t : 'default';
	}

	function cssVar(name) {
		let v = '';
		try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { /* no style */ }
		if (v) return v;
		const t = themeId();
		if (t !== 'default' && THEMES[t].vars[name]) return THEMES[t].vars[name];
		return DEFAULT_VARS[name] || '#000';
	}

	const _images = new Map();
	function loadImage(src) {
		if (!_images.has(src)) {
			_images.set(src, new Promise((resolve) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => resolve(null);
				img.src = src;
			}));
		}
		return _images.get(src);
	}

	// Pages live at the site root, so asset paths are relative to it.
	function boardSrc(theme) {
		const t = typeof THEMES !== 'undefined' && THEMES[theme];
		return t && t.board ? 'static/images/themes/game-board-' + theme + '.jpg' : 'static/images/game-board.jpg';
	}
	function stoneSrc(theme, color) {
		return theme && theme !== 'default'
			? 'static/images/themes/stones/' + theme + '-' + color + '.png'
			: 'static/images/stones/' + color + '.png';
	}
	function spellSrc(name, artOnly) {
		return 'static/images/spells/' + (artOnly ? 'art_only/' : '') + baseSpellName(name) + '.png';
	}

	/** The drawn layout's SVG background with its CSS variables resolved
	 *  (an <img> of an SVG cannot see the page's custom properties). */
	function svgSrc(g) {
		let svg = g.svg.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (m, name, fb) => {
			let v = '';
			try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { /* */ }
			if (!v && themeId() !== 'default') v = THEMES[themeId()].vars[name] || '';
			return v || (fb || '#000').trim();
		});
		svg = svg.replace('<svg ', `<svg width="${g.ref}" height="${g.ref}" `);
		return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	}

	/** A drawable state from an SFN. */
	function stateFromSfn(sfn) {
		const d = sfnToDict(sfn);
		return {
			layout: d.layout || 'core',
			spells: d.spell_names || [],
			stones: d.stones,
			redLock: d.red_lock || '', blueLock: d.blue_lock || '',
			redSpringlock: d.red_springlock || '', blueSpringlock: d.blue_springlock || '',
			score: d.score || 'unset',
			redSpells: d.red_spellcounter || 0, blueSpells: d.blue_spellcounter || 0,
			redBank: d.red_bank || 0, blueBank: d.blue_bank || 0,
			variant: d.variant || 'standard',
			lastPlay: [],
		};
	}

	/** Nodes that took the mover's stone between two positions (a GIF frame's
	 *  "last play" rings). */
	function newStones(before, after) {
		if (!before || !after) return [];
		const out = [];
		for (const [n, s] of Object.entries(after.stones)) {
			if ((s === 'red' || s === 'blue') && before.stones[n] !== s) out.push(n);
		}
		return out;
	}

	function slotKeys(layout) {
		const Z = boardLayoutDef(layout).perType;
		const out = [];
		for (const type of ['ritual', 'sorcery', 'charm']) for (let k = 1; k <= Z; k++) out.push(type + k);
		return out;
	}

	function ring(ctx, x, y, r, width, colour, from, to) {
		ctx.beginPath();
		ctx.arc(x, y, r, from === undefined ? 0 : from, to === undefined ? Math.PI * 2 : to);
		ctx.lineWidth = width;
		ctx.strokeStyle = colour;
		ctx.stroke();
	}

	/**
	 * Draw a state. opts: { size: board side in px (default 1000),
	 * caption: { left, right, centre } or null, artOnly, theme }.
	 * Resolves to a canvas of size x (size + caption bar).
	 */
	async function render(state, opts) {
		opts = opts || {};
		const size = Math.max(64, Math.round(opts.size || 1000));
		const theme = opts.theme || themeId();
		const layout = state.layout || 'core';
		const g = geometry(layout);
		const k = size / g.ref;
		const capH = opts.caption ? Math.round(size * 0.075) : 0;
		const canvas = opts.canvas || document.createElement('canvas');
		canvas.width = size;
		canvas.height = size + capH;
		const ctx = canvas.getContext('2d');
		ctx.save();
		ctx.fillStyle = cssVar('--color-bg-dark');
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const keys = slotKeys(layout);
		const spells = state.spells || [];
		const [bg, red, blue, ...spellImgs] = await Promise.all([
			loadImage(layout === 'core' ? boardSrc(theme) : svgSrc(g)),
			loadImage(stoneSrc(theme, 'red')),
			loadImage(stoneSrc(theme, 'blue')),
			...keys.map((key, i) => (spells[i] ? loadImage(spellSrc(spells[i], opts.artOnly)) : Promise.resolve(null))),
		]);
		if (bg) ctx.drawImage(bg, 0, 0, size, size);
		ctx.scale(k, k);

		// Spells, clipped round like .spell, with the lock rings.
		const redLock = cssVar('--color-red-lock'), blueLock = cssVar('--color-blue-lock');
		keys.forEach((key, i) => {
			const s = g.slots[key];
			const name = spells[i];
			if (!s || !name) return;
			const r = SPELL_SLOT_SIZES[s.type] / 2;
			const img = spellImgs[i];
			ctx.save();
			ctx.translate(s.x, s.y);
			ctx.rotate(s.rot * Math.PI / 180);
			ctx.beginPath();
			ctx.arc(0, 0, r, 0, Math.PI * 2);
			ctx.clip();
			if (img) ctx.drawImage(img, -r, -r, 2 * r, 2 * r);
			if (opts.artOnly) {
				const dot = { charm: 0.30, ritual: 0.20, sorcery: 0.24 }[s.type] * r;
				ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
				for (const [fx, fy] of spellSpotTemplate(s.type)) {
					ctx.beginPath();
					ctx.arc(-r + fx * 2 * r, -r + fy * 2 * r, dot, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			ctx.restore();
			const spring = (side) => !!(side === 'red' ? state.redSpringlock : state.blueSpringlock)
				&& baseSpellName(name) === 'Seal_of_Spring';
			const isRed = state.redLock === name || spring('red');
			const isBlue = state.blueLock === name || spring('blue');
			// .spell--*-lock: a 4px box-shadow, red above and blue below when both.
			if (isRed && isBlue) {
				ring(ctx, s.x, s.y, r + 4, 8, blueLock, 0, Math.PI);
				ring(ctx, s.x, s.y, r + 4, 8, redLock, Math.PI, Math.PI * 2);
			} else if (isRed || isBlue) {
				ring(ctx, s.x, s.y, r + 4, 8, isRed ? redLock : blueLock);
			}
		});

		const R = STONE_NODE_SIZE / 2;
		// Score marker (always the blue stone art, as .stone-node--score).
		const sp = state.score && state.score !== 'unset' ? g.score[state.score] : null;
		if (sp && blue) ctx.drawImage(blue, sp.x - R, sp.y - R, 2 * R, 2 * R);

		const last = new Set(state.lastPlay || []);
		const lastColour = cssVar('--color-last-play-outline');
		for (const [node, stone] of Object.entries(state.stones || {})) {
			const p = g.nodes[node];
			if (!p || !stone) continue;
			if (stone === 'X') {
				// .stone-node--destroyed: a hatched dark disc.
				ctx.save();
				ctx.globalAlpha = 0.85;
				ctx.beginPath();
				ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
				ctx.fillStyle = cssVar('--color-wall');
				ctx.fill();
				ctx.clip();
				ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
				ctx.lineWidth = 3;
				for (let d = -2 * R; d <= 2 * R; d += 8) {
					ctx.beginPath();
					ctx.moveTo(p.x + d - R, p.y + R);
					ctx.lineTo(p.x + d + R, p.y - R);
					ctx.stroke();
				}
				ctx.restore();
				ring(ctx, p.x, p.y, R - 1, 2, 'rgba(40, 40, 40, 0.6)');
				continue;
			}
			const img = stone === 'red' ? red : blue;
			if (img) ctx.drawImage(img, p.x - R, p.y - R, 2 * R, 2 * R);
			if (last.has(node)) ring(ctx, p.x, p.y, R + 4, 7, lastColour);
		}
		ctx.restore();

		if (capH) {
			const c = opts.caption;
			ctx.fillStyle = cssVar('--color-bg');
			ctx.fillRect(0, size, size, capH);
			const font = Math.round(capH * 0.42);
			ctx.font = `${font}px Georgia, "Times New Roman", serif`;
			ctx.textBaseline = 'middle';
			const y = size + capH / 2;
			const pad = Math.round(capH * 0.3);
			if (c.left) {
				ctx.fillStyle = cssVar('--color-red-player');
				ctx.textAlign = 'left';
				ctx.fillText(c.left, pad, y, size * 0.36);
			}
			if (c.right) {
				ctx.fillStyle = cssVar('--color-blue-player');
				ctx.textAlign = 'right';
				ctx.fillText(c.right, size - pad, y, size * 0.36);
			}
			if (c.centre) {
				ctx.fillStyle = cssVar('--color-text');
				ctx.textAlign = 'center';
				ctx.fillText(c.centre, size / 2, y, size * 0.26);
			}
		}
		return canvas;
	}

	/** "Name · 3 spells · bank 2" for a caption side (the spell counter is
	 *  left out in Deathmatch, which has none; the Providence bank only
	 *  while it holds stones, as the page's Bank badge). */
	function sideText(name, spellsCast, variant, bank) {
		const parts = [name || ''];
		const deathmatch = variant && typeof variantHasDeathmatch === 'function' && variantHasDeathmatch(variant);
		if (!deathmatch && typeof spellsCast === 'number') parts.push(spellsCast + (spellsCast === 1 ? ' spell' : ' spells'));
		if (bank) parts.push('bank ' + bank);
		return parts.filter(Boolean).join(' · ');
	}

	/**
	 * Animated GIF of a game: one frame per position.
	 * opts: { size (default 480), labels: [per position], redName, blueName,
	 *         delayMs (default 1000), lastDelayMs (default 3000), artOnly,
	 *         onProgress(done, total) }.
	 */
	async function gameGif(sfns, opts) {
		opts = opts || {};
		if (typeof SigilGifEncoder === 'undefined') throw new Error('gif-encoder.js is not loaded');
		const size = opts.size || 480;
		const states = sfns.map(stateFromSfn);
		const canvas = document.createElement('canvas');
		const frameAt = async (i) => {
			const st = Object.assign({}, states[i], { lastPlay: i > 0 ? newStones(states[i - 1], states[i]) : [] });
			await render(st, {
				size, canvas, artOnly: opts.artOnly,
				caption: {
					left: sideText(opts.redName || 'Red', st.redSpells, st.variant, st.redBank),
					right: sideText(opts.blueName || 'Blue', st.blueSpells, st.variant, st.blueBank),
					centre: (opts.labels && opts.labels[i]) || (i + 1) + '/' + sfns.length,
				},
			});
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		};
		// One palette for the game, from its first and last positions.
		const first = await frameAt(0);
		const lastFrame = sfns.length > 1 ? await frameAt(sfns.length - 1) : first;
		const enc = new SigilGifEncoder(canvas.width, canvas.height, { loop: 0 });
		enc.setPalette(SigilGifEncoder.buildPalette([first, lastFrame]));
		for (let i = 0; i < sfns.length; i++) {
			const px = i === 0 ? first : await frameAt(i);
			const last = i === sfns.length - 1;
			enc.addFrame(px, last ? (opts.lastDelayMs || 3000) : (opts.delayMs || 1000));
			if (opts.onProgress) opts.onProgress(i + 1, sfns.length);
			// Let the page paint the progress between frames.
			await new Promise((r) => setTimeout(r, 0));
		}
		return new Blob([enc.finish()], { type: 'image/gif' });
	}

	function download(blob, filename) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	}

	function canvasBlob(canvas) {
		return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the image'))), 'image/png'));
	}

	/** The site's address for embeds: this page's directory. */
	function siteBase() {
		return window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
	}

	/** <iframe> code for embed.html?<query>. */
	function embedCode(query, title) {
		const src = siteBase() + 'embed.html?' + query;
		const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		return '<iframe src="' + esc(src) + '" width="420" height="520" style="border:0;max-width:100%"'
			+ ' title="' + esc(title || 'Sigil board') + '" loading="lazy"></iframe>';
	}

	function fileStamp() {
		return new Date().toISOString().slice(0, 10);
	}

	return { FRAME, geometry, stateFromSfn, newStones, render, gameGif, download, canvasBlob, embedCode, siteBase, sideText, fileStamp, slotKeys };
})();

/**
 * Alpine mixin for the board components (game-board-local.js on game.html,
 * analysis.html and puzzles.html; game-board-multiplayer.js): image export
 * of the position shown, a GIF of the reviewed game, and embed codes.
 */
function boardExportMixin() {
	return {
		exportBusy: '',          // '' | 'png' | 'gif'
		exportProgress: '',
		exportError: '',
		embedCopied: false,

		/** The position on screen, as BoardImage draws it. */
		boardExportState() {
			const keys = BoardImage.slotKeys(this.boardLayout || 'core');
			const reviewing = !!this.reviewMode;
			return {
				layout: this.boardLayout || 'core',
				spells: keys.map((k) => (this.spellDict && this.spellDict[k]) || ''),
				stones: Object.assign({}, this.nodes),
				redLock: this.redLock || '', blueLock: this.blueLock || '',
				redSpringlock: this.redSpringlock || '', blueSpringlock: this.blueSpringlock || '',
				score: this.score || 'unset',
				redSpells: this.redSpellCounter || 0, blueSpells: this.blueSpellCounter || 0,
				redBank: this.redBank || 0, blueBank: this.blueBank || 0,
				variant: this.gameVariant || (this.isDeathmatch ? 'deathmatch' : 'standard'),
				lastPlay: !reviewing && this.lastPlay ? [this.lastPlay] : [],
			};
		},

		_exportNames() {
			return {
				red: this.redName || (this._redNameForExport && this._redNameForExport !== 'Red' ? this._redNameForExport : '') || 'Red',
				blue: this.blueName || (this._blueNameForExport && this._blueNameForExport !== 'Blue' ? this._blueNameForExport : '') || 'Blue',
			};
		},

		// Plain methods, not getters: a spread mixin would freeze a getter's value.
		canExportImage() {
			return !!(this.spellDict && Object.keys(this.spellDict).length);
		},

		async downloadBoardImage() {
			if (this.exportBusy) return;
			this.exportBusy = 'png';
			this.exportError = '';
			try {
				const st = this.boardExportState();
				const names = this._exportNames();
				const label = this.reviewMode ? (this.reviewTurnLabels || [])[this.reviewIndex] || '' : '';
				const canvas = await BoardImage.render(st, {
					size: 1200, artOnly: !!this.useArtOnlySpells,
					caption: {
						left: BoardImage.sideText(names.red, st.redSpells, st.variant, st.redBank),
						right: BoardImage.sideText(names.blue, st.blueSpells, st.variant, st.blueBank),
						centre: label,
					},
				});
				BoardImage.download(await BoardImage.canvasBlob(canvas), 'sigil-position-' + BoardImage.fileStamp() + '.png');
			} catch (e) {
				console.error('Image export failed:', e);
				this.exportError = 'Could not make the image: ' + (e.message || e);
			} finally {
				this.exportBusy = '';
			}
		},

		canExportGif() {
			return !!(this.reviewSfns && this.reviewSfns.length > 1);
		},

		async downloadReviewGif() {
			if (this.exportBusy || !this.canExportGif()) return;
			this.exportBusy = 'gif';
			this.exportError = '';
			this.exportProgress = '';
			try {
				const names = this._exportNames();
				const blob = await BoardImage.gameGif(this.reviewSfns, {
					labels: this.reviewTurnLabels, redName: names.red, blueName: names.blue,
					artOnly: !!this.useArtOnlySpells,
					onProgress: (done, total) => { this.exportProgress = done + '/' + total; },
				});
				const code = this._roomCodeForReview || this.roomCode || '';
				BoardImage.download(blob, 'sigil-game-' + (code || BoardImage.fileStamp()) + '.gif');
			} catch (e) {
				console.error('GIF export failed:', e);
				this.exportError = 'Could not make the GIF: ' + (e.message || e);
			} finally {
				this.exportBusy = '';
				this.exportProgress = '';
			}
		},

		/** embed.html query for what is on screen: the room's game at the
		 *  reviewed position, the puzzle, or the position itself. */
		embedQuery() {
			if (this.puzzle && this.puzzle.id && !this.puzzle.learn && !this.puzzle.bench) {
				return 'puzzle=' + encodeURIComponent(this.puzzle.id);
			}
			const code = this._roomCodeForReview || '';
			if (code && this.reviewMode && this.reviewSfns && this.reviewSfns.length > 1) {
				return 'game=' + encodeURIComponent(code) + (this.reviewIndex < this.reviewSfns.length - 1 ? '&ply=' + this.reviewIndex : '');
			}
			let sfn;
			if (this.reviewMode) {
				// The loadable form, as openAnalysis() hands positions on: a
				// turn line's first entry is a pre-turn SFN.
				const sfns = this.reviewSfns || [], i = this.reviewIndex || 0;
				const preTurn0 = sfns.length > 1 || (this.reviewTurnLabels || [])[0] === 'Start';
				sfn = (i > 0 || preTurn0) && typeof rematchSfnAt === 'function' ? rematchSfnAt(sfns, i) : sfns[i];
			} else {
				sfn = (typeof this.anaCurrentSfn === 'function' ? this.anaCurrentSfn() : '') || this.currentSfn;
			}
			return sfn ? 'sfn=' + encodeURIComponent(sfn) : '';
		},

		async copyEmbedCode() {
			const q = this.embedQuery();
			if (!q) return;
			const title = q.startsWith('puzzle=') ? 'Sigil puzzle' : q.startsWith('game=') ? 'Sigil game' : 'Sigil position';
			const code = BoardImage.embedCode(q, title);
			try {
				await navigator.clipboard.writeText(code);
				this.embedCopied = true;
				setTimeout(() => { this.embedCopied = false; }, 2000);
			} catch (e) {
				// No clipboard (insecure context, denied): show it to copy by hand.
				window.prompt('Copy this embed code:', code);
			}
		},
	};
}
