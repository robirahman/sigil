/**
 * Screen geometry for board layouts other than the printed core board.
 *
 * The core board is a raster image (game-board.jpg) with node and spell-slot
 * positions in styles.css. Every other layout (constants.js BOARD_LAYOUT_RULES)
 * is drawn here: each zone is a rigid copy of core zone A — the same node
 * coordinates and spell-slot centres/rotations as styles.css, so the spell
 * art's baked node spots stay under their stones — spun in place by
 * ZONE_SPIN, tilted by ZONE_TILT,
 * pushed ZONE_PUSH units out from the centre, then rotated round the ring
 * (360/zones degrees per zone, counter-clockwise like core A -> B -> C).
 *
 * boardGeometry(id) returns null for 'core' (the page keeps its CSS
 * positions), else:
 *   ref            side of the square reference frame (units ~ core px)
 *   nodes[name]    {x, y} node centre
 *   slots[key]     {x, y, rot, type} spell slot centre + rotation (deg);
 *                  keys as spellSlotNames() ('ritual1', 'charm5', ...)
 *   score[key]     {x, y} score-marker spots ('tied', 'r1'.., 'b1'..)
 *   svg            background markup (links, node rings, mana, score track)
 */

// Core zone A in styles.css units (1480 frame, centre 740,740): node centres
// (CSS left/top + 28) and spell-slot centres (left/top + size/2) + rotation.
const _ZONE_A_NODES = {
	1: [98.0, 894.5], 2: [237.5, 1030.0], 3: [342.0, 1077.0], 4: [419.5, 991.0],
	5: [362.0, 891.0], 6: [248.0, 917.0], 7: [673.6, 993.2], 8: [740.0, 1157.0],
	9: [681.0, 1258.0], 10: [798.0, 1258.0], 11: [219.5, 740.0], 12: [447.8, 739.8],
	13: [479.9, 1190.8],
};
const _ZONE_A_SLOTS = {
	ritual: [321.0, 981.0, 60],
	sorcery: [739.45, 1225.45, 180],
	charm: [673.0, 993.0, 0],
};
const SPELL_SLOT_SIZES = { ritual: 322, sorcery: 258.9, charm: 148 };
const STONE_NODE_SIZE = 56;

// Exit points of the white connector stubs printed on the spell art, as
// angles (degrees, image frame: 0 = right, 90 = down) on the card rim,
// measured on every core card of each type (0.96 of the radius). A link
// that leaves a spell node leaves the disc at its stub, so the board's
// lines continue the art's lines as on the printed board.
const SPELL_STUB_ANGLES = {
	ritual: [5.8, 107.4, 174.2, 235.9, 304.1],
	sorcery: [81.2, 190.3, 349.7],
	charm: [-0.4, 70.2, 180.4],
};

// Fitted (see the Cataclysm plan) so neighbouring zones keep >= 70 units of
// clearance between every stone and spell disc while the ring stays compact.
const ZONE_TILT = 28;
// Each zone turned rigidly about its own centre (degrees; negative is
// counter-clockwise on screen). Straightens the dashed zone-to-zone links
// and swings the mana nodes away from the lead counter.
const ZONE_SPIN = -30;
const ZONE_PUSH = 360;
// Mana nodes sit this much further out from the board centre than their
// core-zone position, clear of the neighbouring zone and the lead counter.
const MANA_PUSH = 120;
const _ZONE_BISECTOR = 120;   // direction of zone A's centre from the board centre

const _boardGeometryCache = {};

function boardGeometry(layoutId) {
	if (!layoutId || layoutId === 'core') return null;
	if (!_boardGeometryCache[layoutId]) {
		_boardGeometryCache[layoutId] = _buildBoardGeometry(layoutId, {
			spin: ZONE_SPIN, tilt: ZONE_TILT, push: ZONE_PUSH, manaPush: MANA_PUSH, frame: true,
		});
	}
	return _boardGeometryCache[layoutId];
}

// `opts` = { tilt, push, manaPush, frame }. With tilt/push/manaPush 0 and no
// frame, a 3-zone build lands exactly on the printed core board (1480
// frame) — how the stub routing is checked against game-board.jpg.
function _buildBoardGeometry(layoutId, opts) {
	const def = boardLayoutDef(layoutId);
	const Z = def.perType;
	const C = 740;
	const rotAbout = (p, deg) => {
		const a = deg * Math.PI / 180;
		const x = p[0] - C, y = p[1] - C;
		return [C + x * Math.cos(a) - y * Math.sin(a), C + x * Math.sin(a) + y * Math.cos(a)];
	};
	const u = [Math.cos(_ZONE_BISECTOR * Math.PI / 180), Math.sin(_ZONE_BISECTOR * Math.PI / 180)];
	// Spin: rotate the zone rigidly about its own centroid (the mean of its
	// 13 nodes) before tilting and pushing it out, so the zone turns in place.
	const zc = [0, 0];
	for (let n = 1; n <= 13; n++) { zc[0] += _ZONE_A_NODES[n][0] / 13; zc[1] += _ZONE_A_NODES[n][1] / 13; }
	const spin = (p) => {
		const a = (opts.spin || 0) * Math.PI / 180;
		const x = p[0] - zc[0], y = p[1] - zc[1];
		return [zc[0] + x * Math.cos(a) - y * Math.sin(a), zc[1] + x * Math.sin(a) + y * Math.cos(a)];
	};
	const place = (p, k) => {
		const q = rotAbout(spin(p), opts.tilt);
		return rotAbout([q[0] + opts.push * u[0], q[1] + opts.push * u[1]], -360 / Z * k);
	};

	const nodes = {};
	const slots = {};
	def.zones.forEach((z, k) => {
		for (let n = 1; n <= 13; n++) {
			let [x, y] = place(_ZONE_A_NODES[n], k);
			if (n === 1 && opts.manaPush) {
				const d = Math.hypot(x - C, y - C) || 1;
				x += (x - C) / d * opts.manaPush;
				y += (y - C) / d * opts.manaPush;
			}
			nodes[z + n] = { x, y };
		}
		for (const type of ['ritual', 'sorcery', 'charm']) {
			const [sx, sy, srot] = _ZONE_A_SLOTS[type];
			const [x, y] = place([sx, sy], k);
			slots[type + (k + 1)] = { x, y, rot: srot + (opts.spin || 0) + opts.tilt - 360 / Z * k, type };
		}
	});

	let side = 1480, cx = C, cy = C;
	if (opts.frame) {
		// Square frame round everything, with a margin; shift to the origin.
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const grow = (x, y, r) => {
			minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
			minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
		};
		for (const p of Object.values(nodes)) grow(p.x, p.y, STONE_NODE_SIZE / 2 + 40);
		for (const s of Object.values(slots)) grow(s.x, s.y, SPELL_SLOT_SIZES[s.type] / 2);
		const margin = 40;
		side = Math.max(maxX - minX, maxY - minY) + 2 * margin;
		const dx = (side - (maxX - minX)) / 2 - minX;
		const dy = (side - (maxY - minY)) / 2 - minY;
		for (const p of Object.values(nodes)) { p.x += dx; p.y += dy; }
		for (const s of Object.values(slots)) { s.x += dx; s.y += dy; }
		cx = C + dx; cy = C + dy;
	}

	// Which slot each spell node sits in (spellNames[i] is slot i).
	const slotNames = [];
	for (const type of ['ritual', 'sorcery', 'charm']) {
		for (let k = 1; k <= Z; k++) slotNames.push(type + k);
	}
	const slotOf = {};
	for (let p = 1; p <= def.positionCount; p++) {
		for (const n of def.positions[p]) slotOf[n] = slotNames[p - 1];
	}
	// Stub rim points of a slot, in board coordinates.
	const stubsOf = (key) => {
		const s = slots[key];
		const R = SPELL_SLOT_SIZES[s.type] / 2 * 0.96;
		return SPELL_STUB_ANGLES[s.type].map((a) => {
			const t = (a + s.rot) * Math.PI / 180;
			return { x: s.x + R * Math.cos(t), y: s.y + R * Math.sin(t) };
		});
	};
	// Each link end on a spell leaves by a stub: a ritual/sorcery node owns
	// the stub nearest to it; a charm's single node spreads its links over
	// the three stubs, choosing the assignment that best points each stub
	// at its neighbour.
	const exitFor = {};   // `${node}>${neighbour}` -> {x, y, tx, ty}
	const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };
	for (const n of def.nodeOrder) {
		const key = slotOf[n];
		if (!key) continue;
		const out = def.adjacency[n].filter((m) => slotOf[m] !== key);
		const stubs = stubsOf(key);
		const p = nodes[n];
		const exit = (st, m) => {
			const [tx, ty] = unit(st.x - p.x, st.y - p.y);
			exitFor[n + '>' + m] = { x: st.x, y: st.y, tx, ty };
		};
		if (slots[key].type !== 'charm') {
			let best = stubs[0], bd = Infinity;
			for (const st of stubs) {
				const d = Math.hypot(st.x - p.x, st.y - p.y);
				if (d < bd) { bd = d; best = st; }
			}
			for (const m of out) exit(best, m);
		} else {
			// Brute-force the (at most 3! = 6) stub permutations.
			let bestPerm = null, bestScore = -Infinity;
			const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) =>
				perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((r) => [x, ...r]));
			for (const perm of perms(stubs.map((_, i) => i))) {
				let score = 0;
				out.forEach((m, j) => {
					const st = stubs[perm[j]];
					const [ax, ay] = unit(st.x - p.x, st.y - p.y);
					const [bx, by] = unit(nodes[m].x - st.x, nodes[m].y - st.y);
					score += ax * bx + ay * by;
				});
				if (score > bestScore) { bestScore = score; bestPerm = perm; }
			}
			out.forEach((m, j) => exit(stubs[bestPerm[j]], m));
		}
	}

	// Links: a cubic from end to end, leaving each spell end along its stub
	// so the line continues the art's connector; plain nodes are met at
	// their centre. Links inside one spell are the art's own business.
	const links = [];
	const seen = new Set();
	for (const n of def.nodeOrder) {
		for (const m of def.adjacency[n]) {
			const key = n < m ? n + '|' + m : m + '|' + n;
			if (seen.has(key)) continue;
			seen.add(key);
			if (slotOf[n] && slotOf[n] === slotOf[m]) continue;
			const a = exitFor[n + '>' + m] || { x: nodes[n].x, y: nodes[n].y };
			const b = exitFor[m + '>' + n] || { x: nodes[m].x, y: nodes[m].y };
			const L = Math.hypot(b.x - a.x, b.y - a.y) * 0.4;
			const c1 = a.tx !== undefined ? [a.x + a.tx * L, a.y + a.ty * L] : [a.x, a.y];
			const c2 = b.tx !== undefined ? [b.x + b.tx * L, b.y + b.ty * L] : [b.x, b.y];
			links.push({ a: n, b: m, cross: n[0] !== m[0], d: [a.x, a.y, c1[0], c1[1], c2[0], c2[1], b.x, b.y] });
		}
	}

	// Score track: a ring of spots round the centre, 'tied' at the top,
	// red steps clockwise and blue counter-clockwise up to the win lead.
	const score = {};
	const lead = def.winLead;
	const R = 110;
	score.tied = { x: cx, y: cy - R };
	for (let i = 1; i <= lead; i++) {
		const a = (-90 + i * (150 / lead)) * Math.PI / 180;
		const b = (-90 - i * (150 / lead)) * Math.PI / 180;
		score['r' + i] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
		score['b' + i] = { x: cx + R * Math.cos(b), y: cy + R * Math.sin(b) };
	}

	const f = (v) => v.toFixed(1);
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="game-board game-board--svg" viewBox="0 0 ${f(side)} ${f(side)}" aria-hidden="true">`);
	parts.push(`<defs><radialGradient id="bg-glow" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#2d2a45"/><stop offset="100%" stop-color="#12111c"/></radialGradient></defs>`);
	parts.push(`<rect width="${f(side)}" height="${f(side)}" fill="url(#bg-glow)"/>`);
	parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(side / 2 - 20)}" fill="none" stroke="#3b3656" stroke-width="3"/>`);
	// Links: within a zone solid, between zones dashed.
	for (const l of links) {
		const d = l.d.map(f);
		parts.push(`<path d="M${d[0]} ${d[1]}C${d[2]} ${d[3]} ${d[4]} ${d[5]} ${d[6]} ${d[7]}" fill="none" stroke="${l.cross ? '#b9a8e6' : '#ece6f5'}" stroke-width="${l.cross ? 6 : 5}"${l.cross ? ' stroke-dasharray="16 10"' : ''} stroke-linecap="round"/>`);
	}
	// Spell-slot backdrops (the art sits on top as <img> elements).
	for (const s of Object.values(slots)) {
		parts.push(`<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(SPELL_SLOT_SIZES[s.type] / 2 + 6)}" fill="#1c1a2b" stroke="#6d6390" stroke-width="4"/>`);
	}
	// Node discs for the nodes off the spells; mana nodes get a gold ring.
	// (Spell nodes are the white spots printed on the art.)
	for (const n of def.nodeOrder) {
		if (slotOf[n]) continue;
		const p = nodes[n];
		const mana = def.manaNodes.includes(n);
		// Empty nodes read as white discs, like the printed board's.
		parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${mana ? 33 : 28}" fill="#f6f3ec" stroke="${mana ? '#e8c35a' : '#cfc6de'}" stroke-width="${mana ? 9 : 3}"/>`);
	}
	// Zone letters just outside each mana node.
	def.zones.forEach((z) => {
		const p = nodes[z + '1'];
		const vx = p.x - cx, vy = p.y - cy, len = Math.hypot(vx, vy) || 1;
		parts.push(`<text x="${f(p.x + vx / len * 62)}" y="${f(p.y + vy / len * 62 + 14)}" font-size="42" font-family="Georgia, serif" fill="#8c83aa" text-anchor="middle">${z.toUpperCase()}</text>`);
	});
	// Score track.
	parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${R + 44}" fill="#1c1a2b" stroke="#6d6390" stroke-width="4"/>`);
	for (const [key, p] of Object.entries(score)) {
		const col = key === 'tied' ? '#d9d2bd' : key[0] === 'r' ? '#e0605a' : '#6f8ce0';
		parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="24" fill="none" stroke="${col}" stroke-width="5"/>`);
		if (key !== 'tied') {
			parts.push(`<text x="${f(cx + (p.x - cx) * 0.62)}" y="${f(cy + (p.y - cy) * 0.62 + 9)}" font-size="26" font-family="Georgia, serif" fill="${col}" text-anchor="middle">${key.slice(1)}</text>`);
		}
	}
	parts.push('</svg>');

	return { id: layoutId, ref: side, nodes, slots, score, links, center: { x: cx, y: cy }, svg: parts.join('') };
}

// Alpine component mixin shared by the local and multiplayer boards: the
// board-layout state and the inline-position helpers the templates bind.
// The component must also own `nodes` (node -> stone) and `score`.
function boardLayoutMixin() {
	return {
		boardLayout: 'core',
		perType: 3,
		boardGeo: null,

		// Switch the page (engine bindings, node map, slot count, drawn
		// geometry) to a board layout. Core keeps its CSS positions;
		// other layouts position everything inline from boardGeometry().
		applyBoardLayout(id) {
			setBoardLayout(id);
			this.boardLayout = BOARD.id;
			this.perType = BOARD.perType;
			this.boardGeo = typeof boardGeometry === 'function' ? boardGeometry(BOARD.id) : null;
			for (const n of Object.keys(this.nodes)) {
				if (!NODE_ORDER.includes(n)) delete this.nodes[n];
			}
			for (const n of NODE_ORDER) {
				if (!(n in this.nodes)) this.nodes[n] = null;
			}
		},

		_pct(v) {
			return (v / this.boardGeo.ref * 100).toFixed(3) + '%';
		},

		nodeStyle(node) {
			const g = this.boardGeo;
			const p = g && g.nodes[node];
			if (!p) return '';
			return `left:${this._pct(p.x - STONE_NODE_SIZE / 2)};top:${this._pct(p.y - STONE_NODE_SIZE / 2)}`;
		},

		slotStyle(type, i) {
			const g = this.boardGeo;
			const s = g && g.slots[type + i];
			if (!s) return '';
			const r = SPELL_SLOT_SIZES[type] / 2;
			return `left:${this._pct(s.x - r)};top:${this._pct(s.y - r)};transform:rotate(${s.rot.toFixed(1)}deg)`;
		},

		scoreStyle() {
			const g = this.boardGeo;
			if (!g) return '';
			const p = g.score[this.score];
			if (!p) return 'display:none';
			return `left:${this._pct(p.x - STONE_NODE_SIZE / 2)};top:${this._pct(p.y - STONE_NODE_SIZE / 2)}`;
		},
	};
}
