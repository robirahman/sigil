document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		// available in template
		message: '',
		nodes: {},
		spells: {
			images: {},
			text: {},
		},

		init() {
			const _this = this;
			// TODO
			// awaiting is the next action you're expected to take
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

				if (type === 'message') {
					handleMessageEvent(payload);
					return;
				}

				if (type === 'spellsetup') {
					handleSpellSetupEvent(payload);
					return;
				}

				if (type === 'spelltextsetup') {
					handleSpellTextSetupEvent(payload);
					return;
				}

				if (type === 'boardstate') {
					handleBoardStateEvent(payload);
					return;
				}
			}

			function handleMessageEvent(payload) {
				_this.message = payload.message;
				// TODO: payload.awaiting?
			}

			function handleSpellSetupEvent(payload) {
				spellDict = payload;
				for (let key in spellDict) {
					reverseSpellDict[spellDict[key]] = key;
				}

				for (let key in reverseSpellDict) {
					lockDict[key] = auxLockDict[reverseSpellDict[key]];
				}

				Object.entries(spellDict).forEach(([key, value]) => {
					_this.spells.images[key] = `/static/images/v2/spells/${value}.png`;
				});
			}

			function handleSpellTextSetupEvent(payload) {
				_this.spells.text = payload;
			}

			function handleBoardStateEvent(payload) {
				const { bluecountdown, last_play, last_player, redcountdown, ...nodes } = payload;
				_this.nodes = nodes;
			}
		},
	}));
});
