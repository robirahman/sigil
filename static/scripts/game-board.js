document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		actionList: [],
		// awaiting is the next action you're expected to take
		awaiting: '',
		blueCountdown: '',
		blueLock: '',
		lastPlay: '',
		message: '',
		messageHistory: [],
		nodes: {
			...['a', 'b', 'c'].reduce((acc, curr) => {
				new Array(13).fill(true).forEach((node, index) => {
					acc[`${curr}${index + 1}`] = null;
				});
				return acc;
			}, {}),
		},
		nodesToRefill: {},
		redCountdown: '',
		redLock: '',
		reverseSpellDict: {},
		showReset: false,
		spellDict: {},
		spells: {
			images: {},
			text: {},
		},
		whoseTurn: '',

		handleDash() {
			this.sendEvent('dash');
			this.actionList = [];
		},

		handleEndTurn() {
			this.sendEvent('pass');
			this.actionList = [];
		},

		handleCharmClick(charm) {
			// This is ONLY triggered for charms, not spells
			// Takes a spell position, e.g., "charm1", "charm3"
			// and sends a spellName, e.g., 'Spark', 'Summer'
			const charmName = this.spellDict[charm];
			if (this.awaiting === 'action' && this.actionList.includes(charmName)) {
				this.sendEvent(charmName);
				awaiting = null;
			}
		},

		handleSpellClick(spell) {
			// This is ONLY triggered for spells, not charms
			// Takes a spell position, e.g., "ritual2", "sorcery3"
			// and sends a spellName, e.g., 'Searing_Wind', 'Creeping_Vines'
			const spellName = this.spellDict[spell];
			if (
				this.awaiting == 'spell' ||
				(this.awaiting === 'action' && this.actionList.includes(spellName))
			) {
				this.sendEvent(spellName);
				awaiting = null;
			}
		},

		handleReset() {
			this.sendEvent('reset');
			this.actionList = [];
			this.awaiting = null;
			this.showReset = false;
		},

		handleNodeClick(node) {
			console.log(`node, this.awaiting`, node, this.awaiting);
			this.showReset = true;

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
			_this.auxLockDict = {
				ritual1: 'a1',
				ritual2: 'b1',
				ritual3: 'c1',
				sorcery1: 'a2',
				sorcery2: 'b2',
				sorcery3: 'c2',
			};
			_this.lockDict = {};

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

				if (type === 'chooserefills') {
					handleChooseRefillsEvent(payload);
					return;
				}

				if (type === 'donerefilling') {
					handleDoneRefillingEvent();
					return;
				}
			}

			function handleMessageEvent(payload) {
				_this.actionList = payload.actionlist || [];
				_this.awaiting = payload.awaiting;
				_this.message = payload.message;

				if (_this.message.includes('Invalid move')) {
					_this.showReset = false;
				}
				if (_this.awaiting !== 'action') {
					_this.messageHistory.push(payload.message);
				}
			}

			function handleSpellSetupEvent(payload) {
				_this.spellDict = payload;
				for (let key in _this.spellDict) {
					_this.reverseSpellDict[_this.spellDict[key]] = key;
				}

				for (let key in _this.reverseSpellDict) {
					_this.lockDict[key] = _this.auxLockDict[_this.reverseSpellDict[key]];
				}

				Object.entries(_this.spellDict).forEach(([key, value]) => {
					_this.spells.images[key] = `/static/images/v2/spells/${value}.png`;
				});
			}

			function handleSpellTextSetupEvent(payload) {
				_this.spells.text = payload;
			}

			function handleBoardStateEvent(payload) {
				// eslint-disable-next-line no-unused-vars
				const { bluecountdown, bluelock, last_play, last_player, redcountdown, redlock, ...nodes } =
					payload;
				_this.blueCountdown = bluecountdown;
				_this.blueLock = bluelock;
				_this.lastPlay = last_play;
				_this.nodes = nodes;
				_this.redCountdown = redcountdown;
				_this.redLock = redlock;
			}

			function handleWhoseTurnEvent(payload) {
				_this.showReset = false;
				_this.messageHistory.push(payload.message);
				_this.whoseTurn = payload.message;
			}

			function handleChooseRefillsEvent(payload) {
				_this.nodesToRefill = payload;
			}

			function handleDoneRefillingEvent() {
				_this.nodesToRefill = {};
			}
		},
	}));
});
