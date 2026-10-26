/**
 * Arrows and circles drawn on the board, for analysis and teaching.
 *
 * Mouse: right-drag from one node to another draws an arrow, right-click on
 * a node draws a circle; doing it again removes it. Modifier keys pick the
 * colour: none green, Shift red, Alt blue, Ctrl (or Shift+Alt) yellow.
 * Touch: the pencil button on the board turns on draw mode, where a drag
 * draws an arrow and a tap a circle; node clicks do not reach the game
 * while it is on. Escape (game-keys.js) and the Clear button remove them.
 *
 * The marks are local only: nothing is sent to the opponent or saved. They
 * are kept per key, which the page sets: the play view clears its key at
 * the end of every turn, review keys by move, analysis.html by tree node.
 *
 * Drawn in pixel space from the live node buttons, like drawPushArrows
 * (spell-effects.js), so they fit every board layout and size.
 */
const BOARD_MARK_COLOURS = {
	green: '#3fb950',
	red: '#f0503c',
	blue: '#3d8bfd',
	yellow: '#f5c518',
};

function boardMarkColour(e) {
	if (e.ctrlKey || e.metaKey || (e.shiftKey && e.altKey)) return 'yellow';
	if (e.shiftKey) return 'red';
	if (e.altKey) return 'blue';
	return 'green';
}

/**
 * Attach the marks layer to the board wrapper (the element holding the
 * board picture and `.stone-nodes`). Returns the controller:
 *   setKey(k)  show the marks kept under k
 *   clear()    remove the marks of the current key
 *   clearAll() forget every key
 *   list()     the current key's marks [{from, to, colour}] (to === from: circle)
 */
function attachBoardMarks(wrapper, opts) {
	if (!wrapper) return null;
	if (wrapper._boardMarks) return wrapper._boardMarks;
	opts = opts || {};
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('class', 'board-marks');
	svg.setAttribute('aria-hidden', 'true');
	wrapper.appendChild(svg);

	const store = new Map();
	let key = 'play';
	let drag = null;   // {from, colour, pointerId}
	let preview = null;

	const nodeButtons = () => wrapper.querySelectorAll('.stone-node[id^="stone-node--"]');
	const centreOf = (el, box) => {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top, r: r.width / 2 };
	};
	// The node under a viewport point: the nearest centre within 1.4 radii,
	// so a press on a spell's art still finds the spot it covers.
	const nodeAt = (clientX, clientY) => {
		let best = null, bestD = Infinity;
		for (const el of nodeButtons()) {
			const r = el.getBoundingClientRect();
			if (!r.width) continue;
			const d = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
			if (d < r.width / 2 * 1.4 && d < bestD) { bestD = d; best = el.id.slice('stone-node--'.length); }
		}
		return best;
	};

	const marks = () => store.get(key) || [];

	const add = (parent, tag, attrs) => {
		const el = document.createElementNS(NS, tag);
		for (const k in attrs) el.setAttribute(k, attrs[k]);
		parent.appendChild(el);
		return el;
	};

	function drawOne(m, box, extraClass) {
		const a = document.getElementById('stone-node--' + m.from);
		const b = document.getElementById('stone-node--' + m.to);
		if (!a || !b || !wrapper.contains(a)) return;
		const pa = centreOf(a, box), pb = centreOf(b, box);
		const colour = BOARD_MARK_COLOURS[m.colour] || BOARD_MARK_COLOURS.green;
		const g = add(svg, 'g', { class: 'board-mark board-mark--' + m.colour + (extraClass ? ' ' + extraClass : ''), 'data-from': m.from, 'data-to': m.to });
		const w = Math.max(3, pa.r * 0.3);
		if (m.from === m.to) {
			add(g, 'circle', { cx: pa.x, cy: pa.y, r: pa.r * 1.25, fill: 'none', stroke: colour, 'stroke-width': w });
			return;
		}
		const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy);
		if (len < 1) return;
		const ux = dx / len, uy = dy / len;
		const headLen = Math.max(12, pb.r * 1.1), headHalf = headLen * 0.6;
		const tipX = pb.x - ux * pb.r * 0.5, tipY = pb.y - uy * pb.r * 0.5;
		const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;
		const head = [
			[tipX, tipY],
			[baseX - uy * headHalf, baseY + ux * headHalf],
			[baseX + uy * headHalf, baseY - ux * headHalf],
		].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
		add(g, 'line', { x1: pa.x + ux * pa.r * 0.5, y1: pa.y + uy * pa.r * 0.5, x2: baseX + ux, y2: baseY + uy, stroke: colour, 'stroke-width': w, 'stroke-linecap': 'round' });
		add(g, 'polygon', { points: head, fill: colour });
	}

	function draw() {
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		const box = svg.getBoundingClientRect();
		for (const m of marks()) drawOne(m, box);
		if (preview) drawOne(preview, box, 'board-mark--preview');
		wrapper.classList.toggle('board-marks--has', marks().length > 0);
	}

	function toggle(from, to, colour) {
		const list = marks().slice();
		const i = list.findIndex(m => m.from === from && m.to === to);
		if (i >= 0 && list[i].colour === colour) list.splice(i, 1);
		else if (i >= 0) list[i] = { from, to, colour };
		else list.push({ from, to, colour });
		if (list.length) store.set(key, list);
		else store.delete(key);
		draw();
	}

	// --- Draw mode (touch): a pencil toggle and a Clear button on the board.
	let drawMode = false;
	const tools = document.createElement('div');
	tools.className = 'board-marks-tools';
	const pencil = document.createElement('button');
	pencil.type = 'button';
	pencil.className = 'board-marks-tools__btn board-marks-tools__draw';
	pencil.setAttribute('aria-pressed', 'false');
	pencil.setAttribute('aria-label', 'Draw arrows and circles');
	pencil.title = 'Draw arrows and circles (drag for an arrow, tap for a circle)';
	pencil.textContent = '✎';
	const clearBtn = document.createElement('button');
	clearBtn.type = 'button';
	clearBtn.className = 'board-marks-tools__btn board-marks-tools__clear';
	clearBtn.setAttribute('aria-label', 'Clear arrows and circles');
	clearBtn.title = 'Clear arrows and circles';
	clearBtn.textContent = '✕';
	tools.appendChild(pencil);
	tools.appendChild(clearBtn);
	if (opts.toggle !== false) wrapper.appendChild(tools);

	const setDrawMode = (on) => {
		drawMode = !!on;
		pencil.setAttribute('aria-pressed', drawMode ? 'true' : 'false');
		wrapper.classList.toggle('board-marks--drawing', drawMode);
	};
	pencil.addEventListener('click', (e) => { e.stopPropagation(); setDrawMode(!drawMode); });
	clearBtn.addEventListener('click', (e) => { e.stopPropagation(); api.clear(); });

	// In draw mode a tap on a node must not play it: swallow the click in
	// the capture phase, before the node button's own handler.
	wrapper.addEventListener('click', (e) => {
		if (!drawMode || tools.contains(e.target)) return;
		if (e.target.closest && e.target.closest('.stone-node, .spell')) {
			e.stopPropagation();
			e.preventDefault();
		}
	}, true);

	// The board's context menu would cover the drag; right-click is ours.
	wrapper.addEventListener('contextmenu', (e) => {
		if (tools.contains(e.target)) return;
		e.preventDefault();
	});

	wrapper.addEventListener('pointerdown', (e) => {
		if (tools.contains(e.target)) return;
		const right = e.pointerType === 'mouse' && e.button === 2;
		const drawing = drawMode && e.isPrimary && e.button === 0;
		if (!right && !drawing) return;
		const from = nodeAt(e.clientX, e.clientY);
		if (!from) return;
		drag = { from, colour: right ? boardMarkColour(e) : 'green', pointerId: e.pointerId };
		try { wrapper.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
		if (drawing) e.preventDefault();
	});

	wrapper.addEventListener('pointermove', (e) => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const to = nodeAt(e.clientX, e.clientY);
		const next = to && to !== drag.from ? { from: drag.from, to, colour: drag.colour } : null;
		if ((next && preview && next.to === preview.to) || (!next && !preview)) return;
		preview = next;
		draw();
	});

	const finish = (e, cancelled) => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const d = drag;
		drag = null;
		preview = null;
		try { wrapper.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
		const to = cancelled ? null : nodeAt(e.clientX, e.clientY);
		if (to) toggle(d.from, to, d.colour);
		else draw();
	};
	wrapper.addEventListener('pointerup', (e) => finish(e, false));
	wrapper.addEventListener('pointercancel', (e) => finish(e, true));

	if (typeof ResizeObserver === 'function') new ResizeObserver(() => draw()).observe(wrapper);
	else window.addEventListener('resize', draw);

	const api = {
		setKey(k) {
			key = String(k);
			draw();
		},
		clear() {
			store.delete(key);
			draw();
		},
		clearAll() {
			store.clear();
			draw();
		},
		list() {
			return marks().map(m => Object.assign({}, m));
		},
		redraw: draw,
		setDrawMode,
		get drawMode() { return drawMode; },
	};
	wrapper._boardMarks = api;
	return api;
}
