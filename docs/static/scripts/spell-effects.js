/**
 * Spell visual effects — CSS-based animations triggered on spell cast.
 */
const SPELL_FX = {
	Fireblast:        { type: 'flash', color: '#ff4400', shake: true },
	Hail_Storm:       { type: 'flash', color: '#88ccff', shake: false },
	Carnage:          { type: 'flash', color: '#cc0000', shake: true },
	Meteor:           { type: 'pulse', color: '#ff6600', shake: true },
	Starfall:         { type: 'burst', color: '#ffee44', shake: true },
	Bewitch:          { type: 'burst', color: '#aa44ff', shake: false },
	Flourish:         { type: 'burst', color: '#44ff66', shake: false },
	Grow:             { type: 'burst', color: '#66cc44', shake: false },
	Comet:            { type: 'pulse', color: '#4488ff', shake: false },
	Sprout:           { type: 'burst', color: '#88ee66', shake: false },
	Slash:            { type: 'flash', color: '#ee2222', shake: false },
	Surge:            { type: 'pulse', color: '#22bbee', shake: false },
};

function playSpellEffect(overlayEl, containerEl, spellName) {
	const fx = SPELL_FX[spellName];
	if (!fx || !overlayEl) return;

	// Create overlay element for the color effect
	const el = document.createElement('div');
	el.className = 'spell-fx spell-fx--' + fx.type;
	el.style.setProperty('--fx-color', fx.color);
	el.addEventListener('animationend', () => el.remove());
	overlayEl.appendChild(el);

	// Board shake for impactful spells
	if (fx.shake && containerEl) {
		containerEl.classList.add('spell-fx--shake');
		containerEl.addEventListener('animationend', function handler(e) {
			if (e.target === containerEl) {
				containerEl.classList.remove('spell-fx--shake');
				containerEl.removeEventListener('animationend', handler);
			}
		});
	}
}
