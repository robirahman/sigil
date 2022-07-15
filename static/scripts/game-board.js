document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		init() {
			const _this = this;
			// TODO
			// let awaiting;
			// let actionList;
			let spellDict = {};
			let reverseSpellDict = {};
			let auxLockDict = {
				ritual1: 'a1',
				ritual2: 'b1',
				ritual3: 'c1',
				sorcery1: 'a2',
				sorcery2: 'b2',
				sorcery3: 'c2',
			};
			let lockDict = {};

			// This needs to be "ws://" for HTTP and "wss://" for HTTPS. Might need to change this later.
			const events = new WebSocket('ws://' + location.host + '/api/singleplayergame');
			events.onmessage = handleIncomingEvent;

			function handleIncomingEvent(event) {
				const { type, ...payload } = JSON.parse(event.data);
				console.log(`event`, event);
				console.log(`payload`, payload);

				if (type === 'spellsetup') {
					handleSpellSetup(payload);
				}
			}

			function handleSpellSetup(spellObj) {
				spellDict = spellObj;
				for (let key in spellDict) {
					reverseSpellDict[spellDict[key]] = key;
				}

				for (let key in reverseSpellDict) {
					lockDict[key] = auxLockDict[reverseSpellDict[key]];
				}

				Object.entries(spellDict).forEach(([key, value]) => {
					_this.$refs[key].src = `/static/images/v2/spells/${value}.png`;
					_this.$refs[key].classList.add('visible');
				});
			}
		},
	}));
});
