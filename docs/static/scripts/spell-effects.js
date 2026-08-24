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
	// Springtime expansion (greens + pinks)
	Seal_of_Spring:   { type: 'burst', color: '#aaee88', shake: false },
	Scatter:          { type: 'burst', color: '#ff88cc', shake: false },
	Blossom:          { type: 'burst', color: '#ffaadd', shake: false },
	// Celestial expansion (blues + purples)
	Azimuth:          { type: 'pulse', color: '#7744cc', shake: false },
	Eclipse:          { type: 'flash', color: '#2233aa', shake: true  },
	Syzygy:           { type: 'burst', color: '#5544bb', shake: true  },
	// Inferno expansion (deep reds + embers)
	Charge:           { type: 'pulse', color: '#ff6622', shake: false },
	Fury:             { type: 'flash', color: '#aa0000', shake: true  },
	Erupt:            { type: 'flash', color: '#cc2200', shake: true  },
	// Tempest expansion (yellows + steel blues)
	Gust:             { type: 'flash', color: '#ffdd22', shake: true  },
	Storm_Front:      { type: 'pulse', color: '#6688aa', shake: true  },
	Hurricane:        { type: 'burst', color: '#3366aa', shake: true  },
	// Flood expansion (blues + teals)
	Splash:             { type: 'pulse', color: '#22aaee', shake: false },
	Torrent:          { type: 'burst', color: '#22bbcc', shake: false },
	Tsunami:          { type: 'flash', color: '#1188bb', shake: true  },
	// Gloom expansion (sickly greens + shadow purples)
	Lurk:             { type: 'pulse', color: '#553377', shake: false },
	Decay:            { type: 'flash', color: '#6b8e23', shake: false },
	Corrupt:          { type: 'pulse', color: '#7a2f9e', shake: true  },
	// Covenant expansion (cold grays + doom)
	Seal_of_Winter:        { type: 'pulse', color: '#bbddee', shake: false },
	Seal_of_Stone:         { type: 'pulse', color: '#998877', shake: false },
	Seal_of_Destruction:  { type: 'flash', color: '#660022', shake: true  },
	// Tectonic expansion (earthy browns + shakiness)
	Fissure:              { type: 'burst', color: '#8b5a2b', shake: true  },
	Rock_Slide:           { type: 'flash', color: '#cd853f', shake: true  },
	Bulwark:              { type: 'pulse', color: '#deb887', shake: false },
	// Providence expansion (royal purple + gold)
	Dividend:             { type: 'pulse', color: '#d4af37', shake: false },
	Annuity:              { type: 'burst', color: '#b8912f', shake: false },
	Endowment:            { type: 'burst', color: '#6a0dad', shake: true  },
	// Aftershock expansion (smoldering fire, darkening with size)
	Ember:                { type: 'pulse', color: '#ff6b35', shake: false },
	Smolder:              { type: 'burst', color: '#d64518', shake: false },
	Conflagration:        { type: 'burst', color: '#8f1d0e', shake: true  },
	// Ambush expansion (camouflage greens, darkening with size)
	Tripwire:             { type: 'pulse', color: '#556b2f', shake: false },
	Deadfall:             { type: 'flash', color: '#6e7f5a', shake: false },
	Minefield:            { type: 'burst', color: '#3f5d2a', shake: true  },
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
