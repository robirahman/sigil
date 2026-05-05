/**
 * Triangular Arena — 3-player FFA (39 nodes)
 * Red at top, Blue at bottom-left, Green at bottom-right.
 * Each vertex has a ritual + sorcery spell circle.
 * Charms in the center contested area.
 *
 * All coordinates in 1480x1480 reference space.
 */
const TRIANGULAR_3P = (() => {
	const REF = 1480;

	// Triangle vertex centers (equilateral triangle)
	const topX = 740, topY = 160;
	const blX = 200, blY = 1100;
	const brX = 1280, brY = 1100;
	const centerX = 740, centerY = 780;

	const R_RITUAL = 120;
	const R_SORCERY = 90;

	function pentagonNodes(cx, cy, r, rotation) {
		const nodes = [];
		const rotRad = rotation * Math.PI / 180;
		for (let i = 0; i < 5; i++) {
			const angle = rotRad + (i * 2 * Math.PI / 5) - Math.PI / 2;
			nodes.push({
				x: Math.round(cx + r * Math.cos(angle)),
				y: Math.round(cy + r * Math.sin(angle)),
			});
		}
		return nodes;
	}

	function triangleNodes(cx, cy, r, rotation) {
		const nodes = [];
		const rotRad = rotation * Math.PI / 180;
		for (let i = 0; i < 3; i++) {
			const angle = rotRad + (i * 2 * Math.PI / 3) - Math.PI / 2;
			nodes.push({
				x: Math.round(cx + r * Math.cos(angle)),
				y: Math.round(cy + r * Math.sin(angle)),
			});
		}
		return nodes;
	}

	// Spell circles positioned around each vertex
	// Each vertex gets a ritual (farther out) + sorcery (closer to center)
	const spellLayout = {
		// Red vertex (top) — ritual above, sorcery below
		ritual1:  { cx: topX, cy: topY + 20, rotation: 180 },
		sorcery1: { cx: topX, cy: topY + 300, rotation: 180 },

		// Blue vertex (bottom-left) — ritual left, sorcery right
		ritual2:  { cx: blX + 20, cy: blY, rotation: 60 },
		sorcery2: { cx: blX + 260, cy: blY - 160, rotation: 60 },

		// Green vertex (bottom-right) — ritual right, sorcery left
		ritual3:  { cx: brX - 20, cy: brY, rotation: -60 },
		sorcery3: { cx: brX - 260, cy: brY - 160, rotation: -60 },

		// Charms in center area
		charm1: { cx: centerX, cy: centerY - 120, rotation: 0 },    // top of center
		charm2: { cx: centerX - 140, cy: centerY + 80, rotation: 0 }, // bottom-left of center
		charm3: { cx: centerX + 140, cy: centerY + 80, rotation: 0 }, // bottom-right of center
	};

	const nodes = {};
	const adjacency = {};

	// Generate spell nodes
	const nameR1 = [], nameR2 = [], nameR3 = [];
	const nameS1 = [], nameS2 = [], nameS3 = [];

	pentagonNodes(spellLayout.ritual1.cx, spellLayout.ritual1.cy, R_RITUAL, spellLayout.ritual1.rotation)
		.forEach((p, i) => { const n = 'R' + (i+1); nodes[n] = p; nameR1.push(n); });
	pentagonNodes(spellLayout.ritual2.cx, spellLayout.ritual2.cy, R_RITUAL, spellLayout.ritual2.rotation)
		.forEach((p, i) => { const n = 'B' + (i+1); nodes[n] = p; nameR2.push(n); });
	pentagonNodes(spellLayout.ritual3.cx, spellLayout.ritual3.cy, R_RITUAL, spellLayout.ritual3.rotation)
		.forEach((p, i) => { const n = 'G' + (i+1); nodes[n] = p; nameR3.push(n); });

	triangleNodes(spellLayout.sorcery1.cx, spellLayout.sorcery1.cy, R_SORCERY, spellLayout.sorcery1.rotation)
		.forEach((p, i) => { const n = 'RS' + (i+1); nodes[n] = p; nameS1.push(n); });
	triangleNodes(spellLayout.sorcery2.cx, spellLayout.sorcery2.cy, R_SORCERY, spellLayout.sorcery2.rotation)
		.forEach((p, i) => { const n = 'BS' + (i+1); nodes[n] = p; nameS2.push(n); });
	triangleNodes(spellLayout.sorcery3.cx, spellLayout.sorcery3.cy, R_SORCERY, spellLayout.sorcery3.rotation)
		.forEach((p, i) => { const n = 'GS' + (i+1); nodes[n] = p; nameS3.push(n); });

	// Charm nodes
	nodes['C1'] = { x: spellLayout.charm1.cx, y: spellLayout.charm1.cy };
	nodes['C2'] = { x: spellLayout.charm2.cx, y: spellLayout.charm2.cy };
	nodes['C3'] = { x: spellLayout.charm3.cx, y: spellLayout.charm3.cy };

	// Bridge nodes connecting the three vertex areas
	// Red-Blue edge (top to bottom-left)
	nodes['E1'] = { x: 380, y: 500 };
	nodes['E2'] = { x: 300, y: 720 };

	// Red-Green edge (top to bottom-right)
	nodes['E3'] = { x: 1100, y: 500 };
	nodes['E4'] = { x: 1180, y: 720 };

	// Blue-Green edge (bottom)
	nodes['E5'] = { x: 540, y: 1200 };
	nodes['E6'] = { x: 940, y: 1200 };

	for (const n of Object.keys(nodes)) adjacency[n] = [];

	function connect(a, b) {
		if (!adjacency[a].includes(b)) adjacency[a].push(b);
		if (!adjacency[b].includes(a)) adjacency[b].push(a);
	}

	// Intra-spell ring connections
	function connectRing(names) {
		for (let i = 0; i < names.length; i++) {
			connect(names[i], names[(i + 1) % names.length]);
		}
	}
	connectRing(nameR1);
	connectRing(nameR2);
	connectRing(nameR3);
	connectRing(nameS1);
	connectRing(nameS2);
	connectRing(nameS3);

	// Connect ritual to sorcery within each vertex
	connect('R4', 'RS1'); connect('R5', 'RS1');
	connect('R3', 'RS2'); connect('R3', 'RS3');

	connect('B4', 'BS1'); connect('B5', 'BS1');
	connect('B3', 'BS2'); connect('B3', 'BS3');

	connect('G4', 'GS1'); connect('G5', 'GS1');
	connect('G3', 'GS2'); connect('G3', 'GS3');

	// Connect sorceries to bridge nodes
	connect('RS2', 'E1'); connect('RS3', 'E3');
	connect('BS2', 'E2'); connect('BS3', 'E5');
	connect('GS2', 'E4'); connect('GS3', 'E6');

	// Bridge chains
	connect('E1', 'E2');
	connect('E3', 'E4');
	connect('E5', 'E6');

	// Connect bridges to center charms
	connect('E1', 'C1'); connect('E3', 'C1');
	connect('E2', 'C2'); connect('E5', 'C2');
	connect('E4', 'C3'); connect('E6', 'C3');

	// Charm interconnections
	connect('C1', 'C2'); connect('C1', 'C3'); connect('C2', 'C3');

	return {
		id: 'triangular-3p',
		name: 'Triangular Arena',
		refWidth: REF,
		refHeight: REF,
		players: [
			{ color: 'red', team: 0 },
			{ color: 'blue', team: 1 },
			{ color: 'green', team: 2 },
		],
		nodes,
		adjacency,
		spellPositions: {
			1: nameR1,
			2: nameR2,
			3: nameR3,
			4: nameS1,
			5: nameS2,
			6: nameS3,
			7: ['C1'],
			8: ['C2'],
			9: ['C3'],
		},
		spellLayout,
		manaNodes: ['C1', 'C2', 'C3'],
		initialStones: { 'R1': 'red', 'B1': 'blue', 'G1': 'green' },
		viewBox: '0 0 ' + REF + ' ' + REF,
		winConditions: {
			spellCountTarget: 6,
			stoneWinMargin: 4,
			eliminateAtZero: true,
			teamMode: false,
		},
	};
})();
