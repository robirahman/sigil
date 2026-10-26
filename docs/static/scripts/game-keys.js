/**
 * Keyboard and screen-reader helpers shared by the two game components,
 * game-board-local.js (game.html) and game-board-multiplayer.js
 * (multiplayer.html). The `?` overlay, Escape on dialogs and the settings
 * themselves are in settings-panel.js.
 */

// Was the focused element focused by a pointer press? Chrome focuses a button
// on click, so after clicking a node the node holds focus; Enter then means
// "end turn", not "click that node again". A control reached from the
// keyboard (Tab, or focus moved by script) takes Enter as a click instead.
let _gameKeysPointerAt = 0;
let _gameKeysFocusByPointer = false;
document.addEventListener('pointerdown', () => { _gameKeysPointerAt = Date.now(); }, true);
document.addEventListener('focusin', () => {
	_gameKeysFocusByPointer = Date.now() - _gameKeysPointerAt < 500;
}, true);

function keyboardFocusedControl() {
	const el = document.activeElement;
	if (!el || el === document.body || el === document.documentElement) return null;
	if (_gameKeysFocusByPointer) return null;
	return el.matches('button, a[href], [role="button"], summary, [tabindex]:not([tabindex="-1"])') ? el : null;
}

/**
 * The game's keyboard shortcuts: Enter ends the turn (or submits), D dashes,
 * Escape closes the spell tooltip and disarms End Turn / Forfeit. Enter on a
 * keyboard-focused control is left to the browser, which clicks it; doing
 * both used to click the button AND pass the turn. `opts.disabled()` turns
 * the keys off (multiplayer spectators).
 */
function bindGameKeys(c, opts) {
	document.addEventListener('keydown', (e) => {
		if (opts && opts.disabled && opts.disabled()) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (typeof SigilDialog !== 'undefined' && SigilDialog.isOpen()) return;
		const tag = document.activeElement?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (e.key === 'Escape') {
			c.closeSpellTooltip();
			c.forfeitArmed = false;
			c.endTurnArmed = false;
			return;
		}
		if (e.key === 'Enter') {
			if (keyboardFocusedControl()) return;
			if (c.actionList.includes('pass')) {
				e.preventDefault();
				c.handleEndTurn();
			} else if (c.actionList.includes('submit')) {
				e.preventDefault();
				c.handleSubmit();
			}
			return;
		}
		if ((e.key === 'd' || e.key === 'D') && c.actionList.includes('dash')) {
			e.preventDefault();
			c.handleDash();
		}
	});
}

/**
 * With "Confirm before ending a turn" on, the first End Turn (button or
 * Enter) only arms it: the button asks again and the second press passes.
 * Arming decays like Forfeit's. Returns true when the turn should end now.
 */
function confirmEndTurn(c) {
	const wanted = typeof SigilSettings !== 'undefined' && SigilSettings.get('confirmEndTurn');
	clearTimeout(c._endTurnTimer);
	if (!wanted || c.endTurnArmed) {
		c.endTurnArmed = false;
		return true;
	}
	c.endTurnArmed = true;
	c._endTurnTimer = setTimeout(() => { c.endTurnArmed = false; }, 5000);
	return false;
}

/** A board node's accessible name: "c4, blue stone, legal move, last play". */
function nodeAriaLabel(c, node) {
	const v = c.nodes[node];
	const parts = [node, v === 'red' ? 'red stone' : v === 'blue' ? 'blue stone' : v === 'X' ? 'wall' : 'empty'];
	if (c.validMoves[node]) parts.push('legal move');
	if (c.nodesToRefill && c.nodesToRefill[node]) parts.push('refill choice');
	if (c.pushSourceNode === node) parts.push('being pushed');
	if (c.lastPlay === node) parts.push('last play');
	return parts.join(', ');
}

/** Smooth scrolling is motion too: jump instead when animations are cut. */
function sigilScrollBehavior() {
	return typeof sigilMotionLevel === 'function' && sigilMotionLevel() !== 'full' ? 'auto' : 'smooth';
}
