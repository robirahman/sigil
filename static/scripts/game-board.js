document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', ({ gameName = '', playerCount = 0 , username = '', elo = 0}) => ({
		actionList: [],
		// awaiting is the next action you're expected to take
		awaiting: '',
		blueSpellCounter: 0,
		blueLock: '',
		currentPlayer: '',
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
		playerToRefill: '',
		redSpellCounter: 0,
		redLock: '',
		reverseSpellDict: {},
		score: 'unset',
		showDone: false,
		showReset: false,
		spellDict: {},
		spells: {
			images: {},
			text: {},
		},
		validMoves: {},
		whoseTurn: '',
		winner: '',

		handleDash() {
			this.sendEvent('dash');
			this.actionList = [];
		},

		handleDone() {
			this.sendEvent('doneselecting');
			this.showDone = false;
		},

		handleEndTurn() {
			this.sendEvent('pass');
			this.actionList = [];
		},

		handleCharmClick(charm) {
			// This is ONLY triggered for charms, not spells
			// Takes a spell position, e.g., "charm1", "charm3"
			// and sends a spellName, e.g., 'Slash', 'Seal_of_Summer'
			const charmName = this.spellDict[charm];
			if (this.awaiting === 'action' && this.actionList.includes(charmName)) {
				this.sendEvent(charmName);
				awaiting = null;
			}
		},

		handleSpellClick(spell) {
			// This is ONLY triggered for spells, not charms
			// Takes a spell position, e.g., "ritual2", "sorcery3"
			// and sends a spellName, e.g., 'Fireblast', 'Flourish'
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
			this.lastPlay = '';
			this.nodesToRefill = {};
			this.playerToRefill = '';
			this.showDone = false;
			this.showReset = false;
			this.validMoves = {};
		},

		handleNodeClick(node) {
			console.log(`node, this.awaiting`, node, this.awaiting);
			this.currentPlayer = this.whoseTurn;

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

			const apiPath =
				playerCount === 1 ? 'singleplayergame' : gameName ? `privategame/${gameName}` : 'game';
			const apiProtocol = document.location.protocol === 'http:' ? 'ws:' : 'wss:';
			_this.events = new WebSocket(`${apiProtocol}//${location.host}/api/${apiPath}`);
			_this.events.onmessage = handleIncomingEvent;

			_this.sendEvent = function sendEvent(message) {
				_this.events.send(JSON.stringify({ message }));
			};

			function handleIncomingEvent(event) {
				const { type, ...payload } = JSON.parse(event.data);
				console.group(type);
				console.log(`payload`, payload);
				console.groupEnd(type);

				_this.$nextTick(() => {
					_this.$refs.messageHistory.scrollTop = _this.$refs.messageHistory.scrollHeight;
				});

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

				if (type === 'new_stone_animation') {
					handleNewStonePlacement(payload);
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

				if (type === 'selecting') {
					handleSelectingEvent();
					return;
				}

				if (type === 'pushingoptions') {
					handleValidMovesEvent(payload);
					return;
				}

				if (type === 'username_request') {
					handleUsernameRequestEvent();
					return;
				}

				if (type === 'ping') {
					return;
				}
			}

			function handleMessageEvent(payload) {
				_this.actionList = payload.actionlist || [];
				_this.awaiting = payload.awaiting;
				_this.message = payload.message;

				if (payload.moveoptions) {
					handleValidMovesEvent(payload.moveoptions);
				}

				if (_this.message.includes('Invalid move')) {
					_this.showReset = false;
				}

				if (_this.message === 'BLUE VICTORY') {
					_this.showReset = false;
					_this.winner = 'blue';
				} else if (_this.message === 'RED VICTORY') {
					_this.showReset = false;
					_this.winner = 'red';
				}

				// TODO: _this.message === 'Opponent disconnected. You Win!'
				// TODO: _this.message === 'Game over-- the winner is BLUE !!!'
				// TODO: _this.message === 'Game over-- the winner is RED !!!'

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
					_this.spells.images[key] = `/static/images/spells/${value}.png`;
				});

				// HACK: It won't scroll unless it's in an arbitrary timeout
				setTimeout(() => {
					_this.$refs.gameBoardContainer.scrollIntoView({
						behavior: 'smooth',
						block: 'center',
						inline: 'center',
					});
				}, 100);
			}

			function handleSpellTextSetupEvent(payload) {
				_this.spells.text = payload;
			}

			function handleBoardStateEvent(payload) {
				const {
					bluelock,
					bluespellcounter,
					// eslint-disable-next-line no-unused-vars
					last_play,
					// eslint-disable-next-line no-unused-vars
					last_player,
					redlock,
					redspellcounter,
					score,
					...nodes
				} = payload;
				_this.blueLock = bluelock;
				_this.blueSpellCounter = bluespellcounter;
				_this.nodes = nodes;
				_this.redLock = redlock;
				_this.redSpellCounter = redspellcounter;

				if (score) {
					_this.score = score;
				}
			}

			function handleWhoseTurnEvent(payload) {
				_this.showReset = false;
				_this.messageHistory.push(payload.message);
				_this.whoseTurn = payload.color;
			}

			function handleNewStonePlacement(payload) {
				_this.lastPlay = payload.node;

				if (payload.color !== _this.currentPlayer) {
					// HACK: Alpine doesn't support dynamic refs and
					// it won't scroll unless it's in an arbitrary timeout
					setTimeout(() => {
						document
							.getElementById(`stone-node--${payload.node}`)
							.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
					}, 50);
				} else {
					_this.showReset = true;
				}
			}

			function handleChooseRefillsEvent(payload) {
				const { playercolor, ...nodes } = payload;
				_this.nodesToRefill = nodes;
				_this.playerToRefill = playercolor;
			}

			function handleDoneRefillingEvent() {
				_this.nodesToRefill = {};
				_this.playerToRefill = '';
			}

			function handleSelectingEvent() {
				_this.showDone = true;
			}

			function handleValidMovesEvent(payload) {
				_this.validMoves = payload;
			}

			function handleUsernameRequestEvent() {
				_this.sendEvent(username);
			}
		},
	}));
});
