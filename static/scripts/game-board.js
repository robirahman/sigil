document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		// available in template
		awaiting: '',
		actionList: [],
		blueCountdown: '',
		redCountdown: '',
		lastPlay: '',
		whoseTurn: '',
		message: '',
		nodes: {
			...['a', 'b', 'c'].reduce((acc, curr) => {
				new Array(13).fill(true).forEach((node, index) => {
					acc[`${curr}${index + 1}`] = null;
				});
				return acc;
			}, {}),
		},
		spells: {
			images: {},
			text: {},
		},

		handleDash() {
			this.sendEvent('dash');
			this.actionList = [];
		},

		handleEndTurn() {
			this.sendEvent('pass');
			this.actionList = [];
		},

		handleReset() {
			this.sendEvent('reset');
			this.actionList = null;
			this.awaiting = null;
		},

		handleNodeClick(node) {
			console.log(`node, this.awaiting`, node, this.awaiting);
			if (this.awaiting === 'node') {
				this.sendEvent(node);
			} else if (this.awaiting === 'action') {
				if (this.actionList.includes('move')) {
					this.sendEvent(node);
				}
			}
			this.awaiting = null;
		},

		init() {
			const _this = this;
			// awaiting is the next action you're expected to take
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
			_this.events = new WebSocket('ws://' + location.host + '/api/singleplayergame');
			_this.events.onmessage = handleIncomingEvent;

			_this.sendEvent = function sendEvent(message) {
				_this.events.send(JSON.stringify({ message }));
			};

			function handleIncomingEvent(event) {
				const { type, ...payload } = JSON.parse(event.data);
				console.group(type);
				console.log(`payload`, payload);
				console.groupEnd(type);

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

				if (type === 'whoseturndisplay') {
					handleWhoseTurnEvent(payload);
					return;
				}
			}

			function handleMessageEvent(payload) {
				_this.actionList = payload.actionlist;
				_this.awaiting = payload.awaiting;
				_this.message = payload.message;
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
				// eslint-disable-next-line no-unused-vars
				const { bluecountdown, last_play, last_player, redcountdown, ...nodes } = payload;
				_this.blueCountdown = bluecountdown;
				_this.lastPlay = last_play;
				_this.nodes = nodes;
				_this.redCountdown = redcountdown;
			}

			function handleWhoseTurnEvent(payload) {
				_this.whoseTurn = payload.message;
			}
		},
	}));
});
