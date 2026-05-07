/**
 * Hexagonal Arena — 2v2 map (~54 nodes)
 * Red+Green (team 0) on left, Blue+Yellow (team 1) on right.
 * Neutral mana at top and bottom.
 *
 * Spell circles placed at hexagon vertices:
 * - Each player vertex gets a sorcery
 * - Ritual circles at top and bottom (neutral) + one shared center
 * - Charms scattered in contested zones
 *
 * All coordinates in 1480x1480 reference space.
 */
const HEXAGONAL_2V2 = (() => {
	const REF = 1480;
	const cx = 740, cy = 740;
	const R = 480; // hex radius

	const R_RITUAL = 120;
	const R_SORCERY = 90;

	function pentagonNodes(pcx, pcy, r, rotation) {
		const nodes = [];
		const rotRad = rotation * Math.PI / 180;
		for (let i = 0; i < 5; i++) {
			const angle = rotRad + (i * 2 * Math.PI / 5) - Math.PI / 2;
			nodes.push({
				x: Math.round(pcx + r * Math.cos(angle)),
				y: Math.round(pcy + r * Math.sin(angle)),
			});
		}
		return nodes;
	}

	function triNodes(pcx, pcy, r, rotation) {
		const nodes = [];
		const rotRad = rotation * Math.PI / 180;
		for (let i = 0; i < 3; i++) {
			const angle = rotRad + (i * 2 * Math.PI / 3) - Math.PI / 2;
			nodes.push({
				x: Math.round(pcx + r * Math.cos(angle)),
				y: Math.round(pcy + r * Math.sin(angle)),
			});
		}
		return nodes;
	}

	// Hex vertex positions (starting top, clockwise)
	const hexVerts = [];
	for (let i = 0; i < 6; i++) {
		const angle = -Math.PI / 2 + i * Math.PI / 3;
		hexVerts.push({
			x: Math.round(cx + R * Math.cos(angle)),
			y: Math.round(cy + R * Math.sin(angle)),
		});
	}
	// 0=Top, 1=Top-Right(Blue), 2=Bottom-Right(Yellow), 3=Bottom, 4=Bottom-Left(Green), 5=Top-Left(Red)

	const spellLayout = {
		// Rituals at top, bottom, and center
		ritual1:  { cx: hexVerts[0].x, cy: hexVerts[0].y, rotation: 180 },      // top neutral
		ritual2:  { cx: hexVerts[3].x, cy: hexVerts[3].y, rotation: 0 },         // bottom neutral
		ritual3:  { cx: cx, cy: cy, rotation: 0 },                               // center

		// Sorceries at player vertices
		sorcery1: { cx: hexVerts[5].x, cy: hexVerts[5].y, rotation: -60 },      // Red (top-left)
		sorcery2: { cx: hexVerts[1].x, cy: hexVerts[1].y, rotation: 60 },       // Blue (top-right)
		sorcery3: { cx: hexVerts[4].x, cy: hexVerts[4].y, rotation: 60 },       // Green (bottom-left)

		// Charms — in the gaps between spells
		charm1: { cx: hexVerts[2].x, cy: hexVerts[2].y, rotation: 0 },          // Yellow (bottom-right)
		charm2: { cx: Math.round((hexVerts[0].x + hexVerts[5].x) / 2),
		          cy: Math.round((hexVerts[0].y + hexVerts[5].y) / 2 - 40), rotation: 0 }, // top-left gap
		charm3: { cx: Math.round((hexVerts[0].x + hexVerts[1].x) / 2),
		          cy: Math.round((hexVerts[0].y + hexVerts[1].y) / 2 - 40), rotation: 0 }, // top-right gap
	};

	const nodes = {};
	const adjacency = {};
	const nameR1 = [], nameR2 = [], nameR3 = [];
	const nameS1 = [], nameS2 = [], nameS3 = [];

	// Ritual nodes
	pentagonNodes(spellLayout.ritual1.cx, spellLayout.ritual1.cy, R_RITUAL, spellLayout.ritual1.rotation)
		.forEach((p, i) => { const n = 'T' + (i+1); nodes[n] = p; nameR1.push(n); });
	pentagonNodes(spellLayout.ritual2.cx, spellLayout.ritual2.cy, R_RITUAL, spellLayout.ritual2.rotation)
		.forEach((p, i) => { const n = 'Bo' + (i+1); nodes[n] = p; nameR2.push(n); });
	pentagonNodes(spellLayout.ritual3.cx, spellLayout.ritual3.cy, R_RITUAL, spellLayout.ritual3.rotation)
		.forEach((p, i) => { const n = 'Ce' + (i+1); nodes[n] = p; nameR3.push(n); });

	// Sorcery nodes
	triNodes(spellLayout.sorcery1.cx, spellLayout.sorcery1.cy, R_SORCERY, spellLayout.sorcery1.rotation)
		.forEach((p, i) => { const n = 'Re' + (i+1); nodes[n] = p; nameS1.push(n); });
	triNodes(spellLayout.sorcery2.cx, spellLayout.sorcery2.cy, R_SORCERY, spellLayout.sorcery2.rotation)
		.forEach((p, i) => { const n = 'Bl' + (i+1); nodes[n] = p; nameS2.push(n); });
	triNodes(spellLayout.sorcery3.cx, spellLayout.sorcery3.cy, R_SORCERY, spellLayout.sorcery3.rotation)
		.forEach((p, i) => { const n = 'Gr' + (i+1); nodes[n] = p; nameS3.push(n); });

	// Charm nodes
	nodes['Y1'] = { x: spellLayout.charm1.cx, y: spellLayout.charm1.cy };
	nodes['Q1'] = { x: spellLayout.charm2.cx, y: spellLayout.charm2.cy };
	nodes['Q2'] = { x: spellLayout.charm3.cx, y: spellLayout.charm3.cy };

	// Bridge/connector nodes
	// Between top ritual and player sorceries
	nodes['X1'] = { x: Math.round((hexVerts[5].x + hexVerts[0].x) / 2), y: Math.round((hexVerts[5].y + hexVerts[0].y) / 2 + 60) }; // top-left bridge
	nodes['X2'] = { x: Math.round((hexVerts[0].x + hexVerts[1].x) / 2), y: Math.round((hexVerts[0].y + hexVerts[1].y) / 2 + 60) }; // top-right bridge

	// Between bottom ritual and player sorceries/charm
	nodes['X3'] = { x: Math.round((hexVerts[4].x + hexVerts[3].x) / 2), y: Math.round((hexVerts[4].y + hexVerts[3].y) / 2 - 60) }; // bottom-left bridge
	nodes['X4'] = { x: Math.round((hexVerts[3].x + hexVerts[2].x) / 2), y: Math.round((hexVerts[3].y + hexVerts[2].y) / 2 - 60) }; // bottom-right bridge

	// Between side players and center
	nodes['X5'] = { x: Math.round((hexVerts[5].x + cx) / 2), y: Math.round((hexVerts[5].y + cy) / 2) }; // Red to center
	nodes['X6'] = { x: Math.round((hexVerts[1].x + cx) / 2), y: Math.round((hexVerts[1].y + cy) / 2) }; // Blue to center
	nodes['X7'] = { x: Math.round((hexVerts[4].x + cx) / 2), y: Math.round((hexVerts[4].y + cy) / 2) }; // Green to center
	nodes['X8'] = { x: Math.round((hexVerts[2].x + cx) / 2), y: Math.round((hexVerts[2].y + cy) / 2) }; // Yellow to center

	for (const n of Object.keys(nodes)) adjacency[n] = [];

	function connect(a, b) {
		if (!adjacency[a].includes(b)) adjacency[a].push(b);
		if (!adjacency[b].includes(a)) adjacency[b].push(a);
	}

	function connectRing(names) {
		for (let i = 0; i < names.length; i++) {
			connect(names[i], names[(i + 1) % names.length]);
		}
	}

	// Intra-spell connections
	connectRing(nameR1);
	connectRing(nameR2);
	connectRing(nameR3);
	connectRing(nameS1);
	connectRing(nameS2);
	connectRing(nameS3);

	// Top ritual to bridges
	connect('T4', 'X1'); connect('T5', 'X1');
	connect('T2', 'X2'); connect('T3', 'X2');

	// Bridges to charms near top
	connect('X1', 'Q1'); connect('X2', 'Q2');

	// Red sorcery to bridges
	connect('Re2', 'X1'); connect('Re3', 'X5');
	connect('Re1', 'Q1');

	// Blue sorcery to bridges
	connect('Bl3', 'X2'); connect('Bl2', 'X6');
	connect('Bl1', 'Q2');

	// Green sorcery to bridges
	connect('Gr1', 'X3'); connect('Gr2', 'X7');
	connect('Gr3', 'X3');

	// Bottom ritual to bridges
	connect('Bo4', 'X3'); connect('Bo5', 'X3');
	connect('Bo2', 'X4'); connect('Bo3', 'X4');

	// Yellow charm to bridges
	connect('Y1', 'X4'); connect('Y1', 'X8');

	// Center ritual to side bridges
	connect('Ce1', 'X6'); connect('Ce2', 'X8');
	connect('Ce3', 'X8'); connect('Ce4', 'X7');
	connect('Ce5', 'X5');

	// Bridge interconnections
	connect('X5', 'X1'); connect('X5', 'X7');
	connect('X6', 'X2'); connect('X6', 'X8');
	connect('X7', 'X3');
	connect('X8', 'X4');

	return {
		id: 'hexagonal-2v2',
		name: 'Hexagonal Arena',
		refWidth: REF,
		refHeight: REF,
		players: [
			{ color: 'red', team: 0 },
			{ color: 'blue', team: 1 },
			{ color: 'green', team: 0 },
			{ color: 'yellow', team: 1 },
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
			7: ['Y1'],
			8: ['Q1'],
			9: ['Q2'],
		},
		spellLayout,
		manaNodes: ['T1', 'Bo1', 'Ce1', 'Ce3'],
		initialStones: { 'Re1': 'red', 'Bl1': 'blue', 'Gr1': 'green', 'Y1': 'yellow' },
		viewBox: '0 0 ' + REF + ' ' + REF,
		winConditions: {
			spellCountTarget: 6,
			stoneWinMargin: 5,
			eliminateAtZero: false,
			teamMode: true,
		},
	};
})();
