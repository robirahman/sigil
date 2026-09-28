/**
 * Screen geometry for board layouts other than the printed core board.
 *
 * The core board is a raster image (game-board.jpg) with node and spell-slot
 * positions in styles.css. Every other layout (constants.js BOARD_LAYOUT_RULES)
 * is drawn here: each zone is a rigid copy of core zone A — the same node
 * coordinates and spell-slot centres/rotations as styles.css, so the spell
 * art's baked node spots stay under their stones — tilted by ZONE_TILT,
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

// Fitted (see the Cataclysm plan) so neighbouring zones keep >= 70 units of
// clearance between every stone and spell disc while the ring stays compact.
const ZONE_TILT = 28;
const ZONE_PUSH = 300;
const _ZONE_BISECTOR = 120;   // direction of zone A's centre from the board centre

const _boardGeometryCache = {};

function boardGeometry(layoutId) {
	if (!layoutId || layoutId === 'core') return null;
	if (_boardGeometryCache[layoutId]) return _boardGeometryCache[layoutId];
	const def = boardLayoutDef(layoutId);
	const Z = def.perType;
	const C = 740;
	const rotAbout = (p, deg) => {
		const a = deg * Math.PI / 180;
		const x = p[0] - C, y = p[1] - C;
		return [C + x * Math.cos(a) - y * Math.sin(a), C + x * Math.sin(a) + y * Math.cos(a)];
	};
	const u = [Math.cos(_ZONE_BISECTOR * Math.PI / 180), Math.sin(_ZONE_BISECTOR * Math.PI / 180)];
	const place = (p, k) => {
		const q = rotAbout(p, ZONE_TILT);
		return rotAbout([q[0] + ZONE_PUSH * u[0], q[1] + ZONE_PUSH * u[1]], -360 / Z * k);
	};

	const nodes = {};
	const slots = {};
	def.zones.forEach((z, k) => {
		for (let n = 1; n <= 13; n++) {
			const [x, y] = place(_ZONE_A_NODES[n], k);
			nodes[z + n] = { x, y };
		}
		for (const type of ['ritual', 'sorcery', 'charm']) {
			const [sx, sy, srot] = _ZONE_A_SLOTS[type];
			const [x, y] = place([sx, sy], k);
			slots[type + (k + 1)] = { x, y, rot: srot + ZONE_TILT - 360 / Z * k, type };
		}
	});

	// Square frame round everything, with a margin; shift to the origin.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const grow = (x, y, r) => {
		minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
		minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
	};
	for (const p of Object.values(nodes)) grow(p.x, p.y, STONE_NODE_SIZE / 2);
	for (const s of Object.values(slots)) grow(s.x, s.y, SPELL_SLOT_SIZES[s.type] / 2);
	const margin = 60;
	const side = Math.max(maxX - minX, maxY - minY) + 2 * margin;
	const dx = (side - (maxX - minX)) / 2 - minX;
	const dy = (side - (maxY - minY)) / 2 - minY;
	for (const p of Object.values(nodes)) { p.x += dx; p.y += dy; }
	for (const s of Object.values(slots)) { s.x += dx; s.y += dy; }
	const cx = C + dx, cy = C + dy;

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
	// Zone sectors: a faint wedge per zone.
	parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(side / 2 - 20)}" fill="none" stroke="#3b3656" stroke-width="3"/>`);
	// Links: intra-zone in one tone, ring links (between zones) dashed.
	const seen = new Set();
	for (const n of def.nodeOrder) {
		for (const m of def.adjacency[n]) {
			const key = n < m ? n + m : m + n;
			if (seen.has(key)) continue;
			seen.add(key);
			const p = nodes[n], q = nodes[m];
			const cross = n[0] !== m[0];
			parts.push(`<line x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}" stroke="${cross ? '#b9a8e6' : '#ece6f5'}" stroke-width="${cross ? 6 : 5}"${cross ? ' stroke-dasharray="16 10"' : ''} stroke-linecap="round"/>`);
		}
	}
	// Spell-slot backdrops (the art sits on top as <img> elements).
	for (const s of Object.values(slots)) {
		parts.push(`<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(SPELL_SLOT_SIZES[s.type] / 2 + 6)}" fill="#1c1a2b" stroke="#6d6390" stroke-width="4"/>`);
	}
	// Node rings; mana nodes get a gold ring.
	for (const n of def.nodeOrder) {
		const p = nodes[n];
		const mana = def.manaNodes.includes(n);
		// Empty nodes read as white discs, like the printed board's.
		parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${mana ? 33 : 28}" fill="#f6f3ec" stroke="${mana ? '#e8c35a' : '#cfc6de'}" stroke-width="${mana ? 9 : 3}"/>`);
	}
	// Zone letters near each mana node.
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

	const geo = { id: layoutId, ref: side, nodes, slots, score, center: { x: cx, y: cy }, svg: parts.join('') };
	_boardGeometryCache[layoutId] = geo;
	return geo;
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
