document.addEventListener('DOMContentLoaded', () => {
	const containerElem = document.querySelector('.help-menu-container');
	if (!containerElem) return;
	const submenuElem = document.querySelector('.help-menu-container .submenu');
	const contentElem = document.querySelector('.help-menu-container .content');
	const glossaryElem = document.querySelector('.help-menu-container .glossary');
	const turnStructureElem = document.querySelector('.help-menu-container .turn-structure');
	const whatsNewElem = document.querySelector('.help-menu-container .whats-new');
	const gameRulesElem = document.querySelector('.help-menu-container .game-rules');

	const showContent = () => {
		submenuElem.classList.remove('show');
		contentElem.classList.add('show');
		contentElem.addEventListener('transitionend', () => {
			contentElem.classList.add('after-open-transition');
		});
	};

	// multiplayer.html's menu has no glossary or turn structure.
	const glossaryBtn = document.querySelector('.help-menu-container .glossary-btn');
	if (glossaryBtn && glossaryElem) {
		glossaryBtn.addEventListener('click', () => {
			glossaryElem.classList.add('show');
			showContent();
		});
	}

	const turnStructureBtn = document.querySelector('.help-menu-container .turn-structure-btn');
	if (turnStructureBtn && turnStructureElem) {
		turnStructureBtn.addEventListener('click', () => {
			turnStructureElem.classList.add('show');
			showContent();
		});
	}

	const whatsNewBtn = document.querySelector('.help-menu-container .whats-new-btn');
	if (whatsNewBtn && whatsNewElem) {
		whatsNewBtn.addEventListener('click', () => {
			whatsNewElem.classList.add('show');
			showContent();
		});
	}

	// "This game's rules": the variant (and pack) rules of the game on the
	// page, from rules-reference.js. The board scripts publish the game's
	// variant and spells (sigilPublishGameRules); it is read on each open.
	const gameRulesBtn = document.querySelector('.help-menu-container .game-rules-btn');
	if (gameRulesBtn && gameRulesElem) {
		gameRulesBtn.addEventListener('click', () => {
			renderGameRules(gameRulesElem, window.sigilGameRules || null);
			gameRulesElem.classList.add('show');
			showContent();
		});
	}

	const labelElem = document.querySelector('.help-menu-container label');
	const submenuContainerElem = document.querySelector('.help-menu-container .submenu-container');
	const helpMenuCheckbox = document.querySelector('.help-menu-container #help-menu');
	helpMenuCheckbox.addEventListener('change', () => {
		const isOpening = helpMenuCheckbox.checked;
		if (isOpening) {
			submenuElem.classList.add('show');
			contentElem.classList.remove('show');
			if (glossaryElem) glossaryElem.classList.remove('show');
			if (turnStructureElem) turnStructureElem.classList.remove('show');
			if (whatsNewElem) whatsNewElem.classList.remove('show');
			if (gameRulesElem) gameRulesElem.classList.remove('show');
			contentElem.classList.remove('after-open-transition');

			containerElem.classList.add('open');

			//close on click away
			const onAnyClick = (event) => {
				if (!submenuContainerElem.contains(event.target) && !labelElem.contains(event.target)) {
					helpMenuCheckbox.checked = false; //close
					document.removeEventListener('click', onAnyClick);
				}
			};
			document.addEventListener('click', onAnyClick);
		} else {
			containerElem.classList.remove('open');
		}
	});
});

function renderGameRules(elem, game) {
	const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	if (typeof sigilGameRulesSections !== 'function') {
		elem.innerHTML = '<p><a class="link" href="variants.html" target="_blank" rel="noopener">Variant rules</a></p>';
		return;
	}
	const variant = (game && game.variant) || 'standard';
	const names = { competitive: 'Competitive', deathmatch: 'Deathmatch', scramble: 'Scramble', duplicates: 'Allow duplicates', pentagon: 'Cataclysm' };
	const flags = normalizeVariant(variant).split('_').filter((f) => names[f]).map((f) => names[f]);
	let html = '<p><strong>This game: ' + esc(flags.length ? flags.join(' + ') : 'Standard') + '</strong></p>';
	for (const r of sigilGameRulesSections(variant, game ? game.spellNames : [])) {
		html += '<br /><p><strong>' + esc(r.name) + '</strong>' + (r.rated ? '' : ' (unrated)') + '</p><ul class="game-rules__list">'
			+ r.rules.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>'
			+ '<p><a class="link" href="variants.html#' + r.id + '" target="_blank" rel="noopener">More</a></p>';
	}
	const spells = game ? game.spellNames.filter(Boolean) : [];
	if (spells.length) {
		html += '<br /><p><strong>Spells in this game</strong></p><p>' + spells.map((n) =>
			'<a class="link" href="' + sigilSpellPageUrl(n) + '" target="_blank" rel="noopener">' + esc(displaySpellName(n)) + '</a>').join(' &middot; ') + '</p>';
	}
	elem.innerHTML = html;
}
