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
	// Experimental expansion (unreleased playtest spells)
	Spring_Tide:          { type: 'burst', color: '#3fa7d6', shake: true  },
	Rapids:               { type: 'flash', color: '#2fc4c9', shake: false },
	Silence:              { type: 'pulse', color: '#8899cc', shake: false },
	Vitrify:              { type: 'pulse', color: '#88ddee', shake: false },
	Spellbreak:           { type: 'flash', color: '#ff66aa', shake: true  },
	Shatter:              { type: 'burst', color: '#eef8ff', shake: true  },
	Petrify:              { type: 'pulse', color: '#778877', shake: false },
	Fulgurite:            { type: 'burst', color: '#ffe066', shake: true  },
};

function playSpellEffect(overlayEl, containerEl, spellName) {
	const fx = SPELL_FX[typeof baseSpellName === 'function' ? baseSpellName(spellName) : spellName];
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

// Push-target arrows (Rock Slide): a heavy yellow arrow per planned push,
// drawn into the board's `.push-arrows` SVG in pixel space from the live
// node buttons, so it fits every board layout and size. The arrows are
// kept on the element and redrawn on resize. `arrows`: [{from, to}].
const PUSH_ARROW_STROKE = 4;   // same band as the locked-spell highlight

function drawPushArrows(svgEl, arrows) {
	if (!svgEl) return;
	svgEl._pushArrows = arrows || [];
	while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
	if (!svgEl._pushArrows.length) return;
	const NS = 'http://www.w3.org/2000/svg';
	const box = svgEl.getBoundingClientRect();
	const centre = (node) => {
		const el = document.getElementById('stone-node--' + node);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top, r: r.width / 2 };
	};
	const add = (parent, tag, attrs) => {
		const el = document.createElementNS(NS, tag);
		for (const k in attrs) el.setAttribute(k, attrs[k]);
		parent.appendChild(el);
		return el;
	};
	for (const { from, to } of svgEl._pushArrows) {
		const a = centre(from), b = centre(to);
		if (!a || !b) continue;
		const dx = b.x - a.x, dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len < 1) continue;
		const ux = dx / len, uy = dy / len;
		const headLen = Math.max(12, b.r * 0.95);
		const headHalf = headLen * 0.62;
		// Tip stops just inside the destination node; the shaft ends at the
		// head's base so its cap never pokes past the point.
		const tipX = b.x - ux * b.r * 0.35, tipY = b.y - uy * b.r * 0.35;
		const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;
		const head = [
			[tipX, tipY],
			[baseX - uy * headHalf, baseY + ux * headHalf],
			[baseX + uy * headHalf, baseY - ux * headHalf],
		].map(p => p.join(',')).join(' ');
		const shaft = { x1: a.x, y1: a.y, x2: baseX + ux, y2: baseY + uy };
		const g = add(svgEl, 'g', { class: 'push-arrow' });
		// Dark halo underneath keeps the yellow legible on any board theme.
		add(g, 'line', Object.assign({ class: 'push-arrow__halo', 'stroke-width': PUSH_ARROW_STROKE + 3 }, shaft));
		add(g, 'polygon', { class: 'push-arrow__halo', points: head, 'stroke-width': 3 });
		add(g, 'line', Object.assign({ class: 'push-arrow__shaft', 'stroke-width': PUSH_ARROW_STROKE }, shaft));
		add(g, 'polygon', { class: 'push-arrow__head', points: head });
	}
}

if (typeof window !== 'undefined') {
	window.addEventListener('resize', () => {
		document.querySelectorAll('.push-arrows').forEach(el => {
			if (el._pushArrows && el._pushArrows.length) drawPushArrows(el, el._pushArrows);
		});
	});
}
