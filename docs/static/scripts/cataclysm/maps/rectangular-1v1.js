/**
 * Rectangular Arena — 1v1 map (35 nodes)
 * Red starts left, Blue starts right, neutral mana in center.
 *
 * Layout designed around spell circle images:
 * - 3 rituals (5-node circles): left, right, bottom-center
 * - 3 sorceries (3-node circles): left-center, right-center, bottom-right
 * - 3 charms (1-node circles): scattered in gaps
 *
 * All coordinates are in a 1480x1000 reference space.
 * Positions are converted to percentages for responsive layout.
 */
const RECTANGULAR_1V1 = (() => {
	const REF_W = 1480;
	const REF_H = 1000;

	// Spell circle centers and rotations (visual placement)
	const spellLayout = {
		// Rituals (322px diameter in 1480-space)
		ritual1: { cx: 220, cy: 620, rotation: 30 },    // left
		ritual2: { cx: 1260, cy: 620, rotation: -30 },   // right
		ritual3: { cx: 740, cy: 780, rotation: 0 },      // bottom-center

		// Sorceries (258.9px diameter)
		sorcery1: { cx: 440, cy: 340, rotation: 0 },     // left-center
		sorcery2: { cx: 1040, cy: 340, rotation: 0 },    // right-center
		sorcery3: { cx: 1100, cy: 780, rotation: -60 },  // bottom-right

		// Charms (148px diameter)
		charm1: { cx: 220, cy: 340, rotation: 0 },       // far left
		charm2: { cx: 1260, cy: 340, rotation: 0 },      // far right
		charm3: { cx: 380, cy: 780, rotation: 0 },       // bottom-left
	};

	// Node positions — placed at the node slots on each spell circle image
	// Ritual circles: 5 nodes arranged in a pentagon around the center
	// Sorcery circles: 3 nodes in a triangle
	// Charm circles: 1 node at center
	const R_RITUAL = 120;  // radius of node ring on ritual circle
	const R_SORCERY = 90;  // radius of node ring on sorcery circle

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

	// Generate spell node positions
	const r1 = pentagonNodes(spellLayout.ritual1.cx, spellLayout.ritual1.cy, R_RITUAL, spellLayout.ritual1.rotation);
	const r2 = pentagonNodes(spellLayout.ritual2.cx, spellLayout.ritual2.cy, R_RITUAL, spellLayout.ritual2.rotation);
	const r3 = pentagonNodes(spellLayout.ritual3.cx, spellLayout.ritual3.cy, R_RITUAL, spellLayout.ritual3.rotation);
	const s1 = triangleNodes(spellLayout.sorcery1.cx, spellLayout.sorcery1.cy, R_SORCERY, spellLayout.sorcery1.rotation);
	const s2 = triangleNodes(spellLayout.sorcery2.cx, spellLayout.sorcery2.cy, R_SORCERY, spellLayout.sorcery2.rotation);
	const s3 = triangleNodes(spellLayout.sorcery3.cx, spellLayout.sorcery3.cy, R_SORCERY, spellLayout.sorcery3.rotation);

	const nodes = {};
	const nameR1 = [], nameR2 = [], nameR3 = [];
	const nameS1 = [], nameS2 = [], nameS3 = [];

	r1.forEach((p, i) => { const n = 'A' + (i+1); nodes[n] = p; nameR1.push(n); });
	r2.forEach((p, i) => { const n = 'B' + (i+1); nodes[n] = p; nameR2.push(n); });
	r3.forEach((p, i) => { const n = 'C' + (i+1); nodes[n] = p; nameR3.push(n); });
	s1.forEach((p, i) => { const n = 'D' + (i+1); nodes[n] = p; nameS1.push(n); });
	s2.forEach((p, i) => { const n = 'E' + (i+1); nodes[n] = p; nameS2.push(n); });
	s3.forEach((p, i) => { const n = 'F' + (i+1); nodes[n] = p; nameS3.push(n); });

	// Charm nodes (single node at center of each charm circle)
	nodes['G1'] = { x: spellLayout.charm1.cx, y: spellLayout.charm1.cy };
	nodes['G2'] = { x: spellLayout.charm2.cx, y: spellLayout.charm2.cy };
	nodes['G3'] = { x: spellLayout.charm3.cx, y: spellLayout.charm3.cy };

	// Mana nodes — 3 neutral nodes in the center
	nodes['M1'] = { x: 640, y: 500 };
	nodes['M2'] = { x: 740, y: 500 };
	nodes['M3'] = { x: 840, y: 500 };

	// Bridge/connector nodes for inter-spell connectivity
	nodes['X1'] = { x: 340, y: 480 };  // between charm1/sorcery1 and ritual1
	nodes['X2'] = { x: 1140, y: 480 }; // between charm2/sorcery2 and ritual2
	nodes['X3'] = { x: 540, y: 640 };  // between ritual1 and ritual3
	nodes['X4'] = { x: 940, y: 640 };  // between ritual2 and ritual3
	nodes['X5'] = { x: 740, y: 340 };  // center top, between sorceries

	// Build adjacency
	const adjacency = {};
	for (const n of Object.keys(nodes)) adjacency[n] = [];

	function connect(a, b) {
		if (!adjacency[a].includes(b)) adjacency[a].push(b);
		if (!adjacency[b].includes(a)) adjacency[b].push(a);
	}

	// Intra-spell connections (nodes within each spell circle connect to neighbors)
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

	// Mana chain
	connect('M1', 'M2');
	connect('M2', 'M3');

	// Connect spells to bridge nodes
	// Ritual 1 (left) to X1 and X3
	connect('A1', 'X1'); connect('A2', 'X1');
	connect('A4', 'X3'); connect('A5', 'X3');

	// Ritual 2 (right) to X2 and X4
	connect('B1', 'X2'); connect('B5', 'X2');
	connect('B3', 'X4'); connect('B4', 'X4');

	// Ritual 3 (bottom) to X3 and X4
	connect('C1', 'X3'); connect('C2', 'X4');
	connect('C5', 'X4');

	// Sorcery 1 to X1 and X5
	connect('D2', 'X1'); connect('D3', 'X1');
	connect('D1', 'X5');

	// Sorcery 2 to X2 and X5
	connect('E2', 'X2'); connect('E3', 'X2');
	connect('E1', 'X5');

	// Sorcery 3 to X4
	connect('F1', 'X4'); connect('F3', 'X4');

	// Charms to nearby nodes
	connect('G1', 'D3'); connect('G1', 'A1');
	connect('G2', 'E2'); connect('G2', 'B1');
	connect('G3', 'X3'); connect('G3', 'C5');

	// Mana connections
	connect('M1', 'X3'); connect('M1', 'X5');
	connect('M2', 'X5');
	connect('M3', 'X4'); connect('M3', 'X2');

	// Bridge interconnections
	connect('X1', 'X5'); connect('X2', 'X5');
	connect('X1', 'X3'); connect('X2', 'X4');
	connect('X3', 'X4');

	return {
		id: 'rectangular-1v1',
		name: 'Rectangular Arena',
		refWidth: REF_W,
		refHeight: REF_H,
		players: [
			{ color: 'red', team: 0 },
			{ color: 'blue', team: 1 },
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
			7: ['G1'],
			8: ['G2'],
			9: ['G3'],
		},
		spellLayout,
		manaNodes: ['M1', 'M2', 'M3'],
		initialStones: { 'A3': 'red', 'B3': 'blue' },
		viewBox: '0 0 ' + REF_W + ' ' + REF_H,
		winConditions: {
			spellCountTarget: 6,
			stoneWinMargin: 3,
			eliminateAtZero: false,
			teamMode: false,
		},
	};
})();
