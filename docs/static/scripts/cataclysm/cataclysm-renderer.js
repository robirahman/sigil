/**
 * CataclysmRenderer — renders a game board using:
 * - SVG for edges (connections between nodes) and background
 * - HTML overlays for spell circle images and stone nodes (like the base game)
 *
 * All positioning uses percentages relative to the map's reference dimensions.
 */
class CataclysmRenderer {
	constructor(containerEl, mapDef) {
		this.container = containerEl;
		this.mapDef = mapDef;
		this.wrapper = null;
		this.svg = null;
		this.spellContainer = null;
		this.nodeContainer = null;
		this.nodeEls = {};
		this.spellEls = {};

		// Sizes in reference space (matching base game proportions)
		this.ritualSize = 322;
		this.sorcerySize = 258.9;
		this.charmSize = 148;
		this.nodeSize = 56;
	}

	build() {
		const mapDef = this.mapDef;
		const refW = mapDef.refWidth;
		const refH = mapDef.refHeight;

		// Create wrapper — sized to fill available height, width from aspect ratio
		const aspectRatio = refW / refH;
		this.wrapper = document.createElement('div');
		this.wrapper.className = 'cat-board-wrapper';
		this.wrapper.style.aspectRatio = aspectRatio;

		// Resize on window changes to fit within board area
		const _this = this;
		const fitBoard = () => {
			const area = _this.container;
			const areaW = area.clientWidth;
			const areaH = area.clientHeight;
			// Fit the board within the area, preserving aspect ratio
			let w = areaW;
			let h = w / aspectRatio;
			if (h > areaH) {
				h = areaH;
				w = h * aspectRatio;
			}
			_this.wrapper.style.width = Math.floor(w) + 'px';
			_this.wrapper.style.height = Math.floor(h) + 'px';
		};
		// Fit after DOM is ready
		requestAnimationFrame(() => { fitBoard(); });
		window.addEventListener('resize', fitBoard);

		// SVG layer for edges and background
		const ns = 'http://www.w3.org/2000/svg';
		this.svg = document.createElementNS(ns, 'svg');
		this.svg.setAttribute('viewBox', mapDef.viewBox);
		this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

		// Background
		const bgRect = document.createElementNS(ns, 'rect');
		bgRect.setAttribute('width', refW);
		bgRect.setAttribute('height', refH);
		bgRect.setAttribute('fill', '#0e0514');
		bgRect.setAttribute('rx', '12');
		this.svg.appendChild(bgRect);

		// Edge lines
		const drawn = new Set();
		for (const [from, neighbors] of Object.entries(mapDef.adjacency)) {
			for (const to of neighbors) {
				const key = [from, to].sort().join('-');
				if (drawn.has(key)) continue;
				drawn.add(key);
				const line = document.createElementNS(ns, 'line');
				line.setAttribute('x1', mapDef.nodes[from].x);
				line.setAttribute('y1', mapDef.nodes[from].y);
				line.setAttribute('x2', mapDef.nodes[to].x);
				line.setAttribute('y2', mapDef.nodes[to].y);
				line.setAttribute('class', 'board-edge');
				this.svg.appendChild(line);
			}
		}

		// Mana node indicators (drawn in SVG)
		for (const manaNode of mapDef.manaNodes) {
			const coord = mapDef.nodes[manaNode];
			const ring = document.createElementNS(ns, 'circle');
			ring.setAttribute('cx', coord.x);
			ring.setAttribute('cy', coord.y);
			ring.setAttribute('r', this.nodeSize / 2 + 8);
			ring.setAttribute('class', 'mana-ring');
			this.svg.appendChild(ring);
		}

		this.wrapper.appendChild(this.svg);

		// Spell images layer
		this.spellContainer = document.createElement('div');
		this.spellContainer.className = 'cat-spells';
		this.spellContainer.style.pointerEvents = 'none';

		this._buildSpellImages();
		this.wrapper.appendChild(this.spellContainer);

		// Stone nodes layer
		this.nodeContainer = document.createElement('div');
		this.nodeContainer.className = 'cat-stone-nodes';

		this._buildStoneNodes();
		this.wrapper.appendChild(this.nodeContainer);

		this.container.appendChild(this.wrapper);
	}

	_buildSpellImages() {
		const mapDef = this.mapDef;
		const layout = mapDef.spellLayout;
		const refW = mapDef.refWidth;
		const refH = mapDef.refHeight;
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];

		for (const posName of posNames) {
			const info = layout[posName];
			if (!info) continue;

			let rawSize;
			if (posName.startsWith('ritual')) rawSize = this.ritualSize;
			else if (posName.startsWith('sorcery')) rawSize = this.sorcerySize;
			else rawSize = this.charmSize;

			const sizePercW = (rawSize / refW * 100) + '%';
			const sizePercH = (rawSize / refH * 100) + '%';
			const leftPerc = ((info.cx - rawSize / 2) / refW * 100) + '%';
			const topPerc = ((info.cy - rawSize / 2) / refH * 100) + '%';

			const img = document.createElement('img');
			img.className = 'cat-spell-img';
			img.style.position = 'absolute';
			img.style.width = sizePercW;
			img.style.left = leftPerc;
			img.style.top = topPerc;
			img.style.borderRadius = '50%';
			img.style.opacity = '0';
			img.style.transition = 'opacity 1.5s';
			if (info.rotation) {
				img.style.transform = 'rotate(' + info.rotation + 'deg)';
			}
			img.dataset.pos = posName;
			img.alt = '';

			this.spellEls[posName] = img;
			this.spellContainer.appendChild(img);
		}
	}

	_buildStoneNodes() {
		const mapDef = this.mapDef;
		const refW = mapDef.refWidth;
		const refH = mapDef.refHeight;
		const nodeSize = this.nodeSize;
		// Use percentage of width for both dimensions so nodes stay circular
		const sizePerc = (nodeSize / refW * 100) + '%';

		for (const [name, coord] of Object.entries(mapDef.nodes)) {
			const leftPerc = ((coord.x - nodeSize / 2) / refW * 100) + '%';
			const topPerc = ((coord.y - nodeSize / 2) / refH * 100) + '%';

			const btn = document.createElement('button');
			btn.className = 'cat-node';
			btn.style.position = 'absolute';
			btn.style.width = sizePerc;
			btn.style.left = leftPerc;
			btn.style.top = topPerc;
			btn.dataset.node = name;
			btn.setAttribute('aria-label', name);

			this.nodeEls[name] = btn;
			this.nodeContainer.appendChild(btn);
		}
	}

	/** Set spell images after spellsetup event */
	setSpellImages(spellNames) {
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
		for (let i = 0; i < posNames.length; i++) {
			const el = this.spellEls[posNames[i]];
			if (!el) continue;
			const spellName = spellNames[i];
			if (spellName) {
				el.src = 'static/images/spells/' + spellName + '.png';
				// Delayed reveal animation
				setTimeout(() => { el.style.opacity = '1'; }, 500 + i * 250);
			}
		}
	}

	/** Update node visuals based on board state */
	updateBoard(board, validMoves, lastPlay) {
		const allColors = board.players;

		for (const [name, el] of Object.entries(this.nodeEls)) {
			const stone = board.stones[name];

			// Remove all color classes
			el.classList.remove('cat-node--red', 'cat-node--blue', 'cat-node--green', 'cat-node--yellow',
				'cat-node--valid-red', 'cat-node--valid-blue', 'cat-node--valid-green', 'cat-node--valid-yellow',
				'cat-node--last-play');

			if (stone) {
				el.classList.add('cat-node--' + stone);
			}

			if (validMoves && validMoves[name]) {
				el.classList.add('cat-node--valid-' + validMoves[name]);
			}

			if (lastPlay === name && !(validMoves && validMoves[name])) {
				el.classList.add('cat-node--last-play');
			}
		}
	}

	/** Update spell image lock/available states */
	updateSpellStates(board, actionList, locks) {
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
		for (let i = 0; i < posNames.length; i++) {
			const el = this.spellEls[posNames[i]];
			if (!el) continue;
			const spellName = board.spellNames[i];

			el.classList.remove('cat-spell--available', 'cat-spell--red-lock', 'cat-spell--blue-lock',
				'cat-spell--green-lock', 'cat-spell--yellow-lock');

			if (actionList.includes(spellName)) {
				el.classList.add('cat-spell--available');
				el.style.pointerEvents = 'auto';
			} else {
				el.style.pointerEvents = 'none';
			}

			// Show locks
			for (const color of board.players) {
				if (board.lock[color] === spellName) {
					el.classList.add('cat-spell--' + color + '-lock');
				}
			}
		}
	}

	/** Set up click handlers */
	onNodeClick(callback) {
		for (const [name, el] of Object.entries(this.nodeEls)) {
			el.addEventListener('click', () => callback(name));
		}
	}

	onSpellClick(callback) {
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
		for (const posName of posNames) {
			const el = this.spellEls[posName];
			if (!el) continue;
			el.addEventListener('click', () => callback(posName));
			el.style.cursor = 'pointer';
		}
	}
}
