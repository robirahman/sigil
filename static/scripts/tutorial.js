document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		actionList: [],
		activeSpell: '',
		activeSpellIsCastable: false,
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
		previousBoardState: {},
		redSpellCounter: 0,
		redLock: '',
		score: 'unset',
		showReset: false,
		spellDict: {},
		spells: {
			images: {},
			text: {},
		},
		spellTooltip: {},
		validMoves: {},
		whoseTurn: '',
		winner: '',

		closeSpellTooltip() {
			this.activeSpell = '';
			if (this.spellTooltip.destroy) {
				this.spellTooltip.destroy();
			}
		},

		showSpellTooltip(spell) {
			this.activeSpell = spell;

			const anchor = document.querySelector(`.spell--tooltip-anchor-${spell}`);
			const tooltip = this.$refs.spellTooltip;

			this.$nextTick(() => {
				this.spellTooltip = Popper.createPopper(anchor, tooltip, {
					modifiers: [
						{
							name: 'offset',
							options: {
								offset: [0, 8],
							},
						},
					],
					placement: 'auto',
				});
				this.spellTooltip.forceUpdate();
			});
		},

		handleCastSpell(spell) {
			this.sendEvent(this.spellDict[spell]);
			this.closeSpellTooltip();
		},

		handleDash() {
			this.sendEvent('dash');
			this.actionList = [];
		},

		handleEndTurn() {
			this.sendEvent('pass');
			this.actionList = [];
		},

		handleCharmClick(spell) {
			// This is ONLY triggered for charms, not spells
			// Takes a spell position, e.g., "charm1", "charm3"
			// and sends a spellName, e.g., 'Slash', 'Seal_of_Summer'
			const charmName = this.spellDict[spell];
			if (this.awaiting === 'action' && this.actionList.includes(charmName)) {
				this.activeSpellIsCastable = true;

				if (this.hasTouchScreen) {
					this.showSpellTooltip(spell);
				} else {
					this.sendEvent(charmName);
				}
			} else {
				this.activeSpellIsCastable = false;

				if (this.hasTouchScreen) {
					this.showSpellTooltip(spell);
				}
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
				this.activeSpellIsCastable = true;

				if (this.hasTouchScreen) {
					this.showSpellTooltip(spell);
				} else {
					this.sendEvent(spellName);
				}
			} else {
				this.activeSpellIsCastable = false;

				if (this.hasTouchScreen) {
					this.showSpellTooltip(spell);
				}
			}
		},

		handleSpellMouseOut() {
			if (!this.hasTouchScreen) {
				this.activeSpell = '';
				this.spellTooltip.destroy();
			}
		},

		handleSpellMouseOver(spell) {
			if (!this.hasTouchScreen) {
				this.showSpellTooltip(spell);
			}
		},

		handleReset() {
			this.sendEvent('reset');
			this.actionList = [];
			this.lastPlay = '';
			this.nodesToRefill = {};
			this.playerToRefill = '';
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
		},

		init() {
			const _this = this;

			_this.hasTouchScreen = matchMedia('(any-pointer: coarse)').matches;

			_this.$watch('messageHistory', () => {
				_this.$nextTick(() => {
					_this.$refs.messageHistory.scrollTop = _this.$refs.messageHistory.scrollHeight;
				});
			});

			_this.sendEvent = function sendEvent(message) {
				_this.events.send(JSON.stringify({ message }));
				_this.awaiting = null;
			};

			function initTutorial() {
				_this.tooltipSelectors = [];
				_this.tooltipInstances = [];

				_this.tutorial = new Shepherd.Tour({
					defaultStepOptions: {
						attachTo: {
							element: '.logo',
							on: 'right',
						},
						classes: 'shepherd-tooltip',
						// scrollTo: true,
					},
					exitOnEsc: false,
					keyboardNavigation: false,
				});

				_this.tutorial.on('start', () => {
					document.addEventListener('keydown', (event) => {
						if (event.code === 'Space' && _this.tutorial.isActive()) {
							event.preventDefault();
							_this.tutorial.next();
						}
					});
				});
			}

			function createTutorialSteps(steps) {
				steps.forEach((step) => {
					_this.tutorial.addStep({
						buttons: [
							{
								text: 'Next',
								action: _this.tutorial.next,
							},
						],
						...step,
					});
				});
			}

			function startTutorial() {
				_this.tutorial.start();
			}

			initTutorial();

			createTutorialSteps([
				{
					text: '<h2>Welcome to Sigil Online!</h2><p>This is part 1 of a three-part tutorial.</p><p>Click “Next” or press Space to continue.',
				},
				{
					text: '<p>Sigil is a battle between the red and blue stones.</p><p>Each side is trying to expand their territory and their opponent’s territory.</p>',
				},
				{
					text: '<p>As your stones expand to different regions of the board, you gain access to special abilities called spells.</p>',
				},
				{
					text: '<p>The nine large dark circles on the board are locations for spells to be placed.</p><p>There are three small, three medium, and three large spell locations.</p>',
					when: {
						show() {
							_this.tooltipSelectors = [
								'.charm-spell--1.spell--tooltip-anchor',
								'.charm-spell--2.spell--tooltip-anchor',
								'.charm-spell--3.spell--tooltip-anchor',
								'.ritual-spell--1.spell--tooltip-anchor',
								'.ritual-spell--2.spell--tooltip-anchor',
								'.ritual-spell--3.spell--tooltip-anchor',
								'.sorcery-spell--1.spell--tooltip-anchor',
								'.sorcery-spell--2.spell--tooltip-anchor',
								'.sorcery-spell--3.spell--tooltip-anchor',
							];

							_this.tooltipSelectors.forEach((selector, index) => {
								const anchor = document.querySelector(selector);
								const tooltip = document.querySelector(`.step-pointer--${index + 1}`);
								const instance = Popper.createPopper(anchor, tooltip, {
									modifiers: [
										{
											name: 'offset',
											options: {
												offset: [0, 8],
											},
										},
									],
									placement: 'bottom',
								});
								_this.$nextTick(() => {
									instance.forceUpdate();
								});
								_this.tooltipInstances.push(instance);
							});
						},
					},
				},
				{
					text: '<p>Before the game starts, spells are placed at random into these nine locations.</p>',
				},
				{
					text: '<p>Let’s place spells onto the board now.</p>',
					when: {
						show() {
							_this.tooltipInstances.forEach((instance) => {
								instance.destroy();
							});
							_this.tooltipInstances = [];
							_this.tooltipSelectors = [];

							handleSpellSetupEvent({
								ritual1: 'Flourish',
								ritual2: 'Carnage',
								ritual3: 'Bewitch',
								sorcery1: 'Fireblast',
								sorcery2: 'Hail_Storm',
								sorcery3: 'Grow',
								charm1: 'Slash',
								charm2: 'Surge',
								charm3: 'Sprout',
							});
						},
					},
				},
			]);

			startTutorial();

			function handleIncomingEvent(event) {
				const { type, ...payload } = JSON.parse(event.data);
				console.group(type);
				console.log(`payload`, payload);
				console.groupEnd(type);

				if (type === 'ping') {
					return;
				}

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

				if (type === 'pushingoptions') {
					handleValidMovesEvent(payload);
					return;
				}

				if (type === 'game_over') {
					handleGameOverEvent(payload);
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

				if (_this.awaiting !== 'action' && payload.message !== '') {
					_this.messageHistory.push(payload.message);
				}
			}

			function handleSpellSetupEvent(payload) {
				_this.spellDict = payload;

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
				const isValidStateKey = (key) => typeof key !== 'undefined';
				const changedBoardState = Object.keys(payload).reduce((acc, curr) => {
					if (payload[curr] !== _this.previousBoardState[curr]) {
						acc[curr] = payload[curr];
					}
					return acc;
				}, {});

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
				} = changedBoardState;

				Object.keys(nodes).forEach((node) => {
					_this.nodes[node] = nodes[node];
				});

				if (isValidStateKey(bluelock)) {
					_this.blueLock = bluelock;
				}
				if (isValidStateKey(bluespellcounter)) {
					_this.blueSpellCounter = bluespellcounter;
				}
				if (isValidStateKey(redlock)) {
					_this.redLock = redlock;
				}
				if (isValidStateKey(redspellcounter)) {
					_this.redSpellCounter = redspellcounter;
				}
				if (isValidStateKey(score)) {
					_this.score = score;
				}

				_this.previousBoardState = payload;
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

			function handleValidMovesEvent(payload) {
				_this.validMoves = payload;
			}

			function handleGameOverEvent(payload) {
				_this.messageHistory.push(`Game over! ${payload.winner === 'blue' ? 'Blue' : 'Red'} wins`);
				_this.showReset = false;
				_this.winner = payload.winner;
			}
		},
	}));
});
