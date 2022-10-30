document.addEventListener('alpine:init', () => {
	Alpine.data('gameBoard', () => ({
		actionList: [],
		activeSpell: '',
		activeSpellIsCastable: false,
		activeTutorialStep: '',
		// awaiting is the next action you're expected to take
		awaiting: '',
		awaitingTutorialActions: [],
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

		get tutorialCanProgress() {
			return this.awaitingTutorialActions.length === 0;
		},

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
			this.handleRequiredTutorialActions(this.spellDict[spell]);
			this.closeSpellTooltip();
		},

		handleDash() {
			this.sendEvent('dash');
			this.handleRequiredTutorialActions('dash');
			this.actionList = [];
		},

		handleEndTurn() {
			this.sendEvent('pass');
			this.handleRequiredTutorialActions('pass');
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
			this.handleRequiredTutorialActions('reset');
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

			// if (node === this.awaitingTutorialActions) {
			this.handleRequiredTutorialActions(node);
			// }

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

			_this.$watch('awaitingTutorialActions', (value, oldValue) => {
				if (value.length === 0 && oldValue.length > 0) {
					_this.$nextTick(() => {
						_this.advanceTour();
					});
				}
			});

			_this.sendEvent = function sendEvent(message) {
				// _this.events.send(JSON.stringify({ message }));
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
							advanceTour();
						}
					});
				});
			}

			function createTutorialSteps(steps) {
				steps.forEach((step, index) => {
					const { text, when, ...restOptions } = step;
					_this.tutorial.addStep({
						buttons: [
							{
								action: advanceTour,
								text: 'Next',
							},
						],
						id: `tutorial-${index + 1}`,
						text: text,
						when: {
							hide() {
								if (when && when.hide) {
									when.hide();
								}
							},
							show() {
								_this.activeTutorialStep = `tutorial-${index + 1}`;
								if (when && when.show) {
									when.show();
								}
							},
						},
						...restOptions,
					});
				});
			}

			function startTutorial() {
				_this.tutorial.start();
			}

			initTutorial();

			createTutorialSteps([
				// Section 1
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
							showTutorialStepPointers([
								'.charm-spell--1.spell--tooltip-anchor',
								'.charm-spell--2.spell--tooltip-anchor',
								'.charm-spell--3.spell--tooltip-anchor',
								'.ritual-spell--1.spell--tooltip-anchor',
								'.ritual-spell--2.spell--tooltip-anchor',
								'.ritual-spell--3.spell--tooltip-anchor',
								'.sorcery-spell--1.spell--tooltip-anchor',
								'.sorcery-spell--2.spell--tooltip-anchor',
								'.sorcery-spell--3.spell--tooltip-anchor',
							]);
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
							hideTutorialStepPointers();

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

							handleSpellTextSetupEvent({
								ritual1: {
									name: 'Flourish',
									text: 'Make 4 soft moves.',
								},
								ritual2: {
									name: 'Carnage',
									text: 'Make 4 hard moves.',
								},
								ritual3: {
									name: 'Bewitch',
									text: 'Choose 2 enemy stones touching each other. Convert them to your color.',
								},
								sorcery1: {
									name: 'Fireblast',
									text: 'Destroy all enemy stones which are touching you.',
								},
								sorcery2: {
									name: 'Hail_Storm',
									text: 'Destroy 1 enemy stone in each spell.',
								},
								sorcery3: {
									name: 'Grow',
									text: 'Make 2 soft moves.',
								},
								charm1: {
									name: 'Slash',
									text: 'Make 1 hard move.',
								},
								charm2: {
									name: 'Surge',
									text: 'If you dashed this turn, make 1 move.',
								},
								charm3: {
									name: 'Sprout',
									text: 'Make 1 soft move.',
								},
							});
						},
					},
				},
				{
					text: '<p>Now we’re ready to begin.</p>',
				},
				{
					text: '<p>Each side starts with just one stone on the board.</p><p>The red circle in the bottom left is Red’s starting location.</p><p>Blue starts with a stone in the bottom right.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'red', node: 'a1' });
							placeTutorialStone({ color: 'blue', delay: 750, node: 'b1' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--a1', '.stone-node--b1']);
						},
					},
				},
				{
					text: '<p>You are the Blue player.</p><p>Red always goes first, and Blue always goes second.</p>',
				},
				// Section 2.a
				{
					text: '<p>On each player’s turn, they place one new stone of their color onto the board. This is called a Regular Move.</p><p>Stones must be placed adjacent to where a player already has a stone on the board.</p>',
				},
				{
					text: '<p>Red placed a stone and ended their turn.</p>',
					when: {
						show() {
							placeTutorialStone({ color: 'red', node: 'a2' });
						},
					},
				},
				{
					text: '<p>Now it’s your turn.</p><p>Go ahead and make your move by placing a stone in the left node adjacent to where you already have a stone.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'b11' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--b11']);
							setRequiredTutorialActions('b11');
							handleValidMovesEvent({
								b2: 'blue',
								b11: 'blue',
							});
						},
					},
				},
				{
					text: '<p>Well done!</p><p>Now end your turn by pressing the End Turn button.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							setRequiredTutorialActions('pass');
							showTutorialStepPointers(['.action-button--end-turn'], {
								placement: 'right',
							});
							handleMessageEvent({
								actionlist: ['pass'],
								awaiting: 'action',
								message: '',
							});
						},
					},
				},
				{
					text: '<p>Red placed a stone and ended their the turn.</p>',
					when: {
						show() {
							placeTutorialStone({ color: 'red', node: 'a3' });
						},
					},
				},
				{
					text: '<p>Let’s fast forward the game so we can learn about pushing.</p>',
					when: {
						show() {
							setRequiredTutorialActions('delay');
							placeTutorialStone({ color: 'blue', delay: 750, node: 'b2' });
							placeTutorialStone({ color: 'red', delay: 1500, node: 'a13' });
							placeTutorialStone({ color: 'blue', delay: 2250, node: 'a10' });
							placeTutorialStone({ color: 'red', delay: 3000, node: 'a9' });
							placeTutorialStone({ color: 'blue', delay: 3750, node: 'a8' });
							placeTutorialStone(
								{ color: 'red', delay: 4500, node: 'a11' },
								resetRequiredTutorialActions
							);
						},
					},
				},
				// Section 2.b
				{
					text: '<p>Let’s see what happens when you place a stone onto a node occupied by your opponent.</p><p>Try placing a stone here.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'a9' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--a9']);
							setRequiredTutorialActions('a9');
							handleValidMovesEvent({
								a7: 'blue',
								a9: 'blue',
								b3: 'blue',
								b6: 'blue',
							});
						},
					},
				},
				{
					text: '<p>When you place a stone onto an opposing piece, their stone gets pushed to the nearest empty node.</p><p>It can get pushed through pieces of its own color, but not through your stones.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							// TODO: Handle pushing properly
							// FIXME: This stone doesn't animate in (also an issue in the main game)
							placeTutorialStone({ color: 'red', delay: 500, node: 'a4', push: true }, () =>
								showTutorialStepPointers(['.stone-node--a4'], {
									placement: 'right',
								})
							);
						},
					},
				},
				{
					text: '<p>Looks like it’s going to be a fight, your stone got pushed to the closest empty node.</p>',
					when: {
						show() {
							handleValidMovesEvent({
								a5: 'red',
								a6: 'red',
								a7: 'red',
								a9: 'red',
								c10: 'red',
							});
							placeTutorialStone({ color: 'red', node: 'a9' });
							placeTutorialStone({ color: 'blue', delay: 750, node: 'a7', push: true }, () =>
								showTutorialStepPointers(['.stone-node--a7'], {
									placement: 'top',
								})
							);
						},
					},
				},
				{
					text: '<p>Go ahead and place another stone on the contested node.</p>',
					when: {
						hide() {
							placeTutorialStone({ color: 'blue', node: 'a9' });
						},
						show() {
							hideTutorialStepPointers();
							setRequiredTutorialActions('a9');
							handleValidMovesEvent({
								a4: 'blue',
								a9: 'blue',
								b3: 'blue',
								b6: 'blue',
								b12: 'blue',
							});
						},
					},
				},
				{
					text: '<p>There are two equally distant empty nodes.</p><p>When it is your turn, you make all the decisions. That means that you get to choose where your opponent’s stone gets pushed.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							handleValidMovesEvent({
								a5: 'red',
								a6: 'red',
							});
							showTutorialStepPointers(['.stone-node--a5', '.stone-node--a6'], {
								placement: 'top',
							});
						},
					},
				},
				{
					text: '<p>Go ahead and select the legal node on the left.</p>',
					when: {
						hide() {
							placeTutorialStone({ color: 'red', node: 'a6', push: true });
						},
						show() {
							setRequiredTutorialActions('a6');
						},
					},
				},
				{
					text: '<p>Nicely played!</p><p>Next up, learn about crushing.</p>',
				},
				// Section 2.c
				{
					text: '<p>Let’s take a look at this new board state.</p><p>Some of Red’s stones are surrounded.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								a1: 'red',
								a2: 'red',
								a3: 'blue',
								a4: 'blue',
								a6: 'red',
								a7: 'blue',
								a8: 'blue',
								a9: 'red',
								a10: 'blue',
								a11: 'red',
								a13: 'red',
								b1: 'blue',
								b2: 'blue',
								b11: 'blue',
								c9: 'red',
								c10: 'red',
								c13: 'red',
							});
							_this.lastPlay = '';
						},
					},
				},
				{
					text: '<p>Go ahead and place a stone onto the indicated surrounded Red stone.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'a9' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--a9']);
							setRequiredTutorialActions('a9');
						},
					},
				},
				{
					text: '<p>When a stone is placed onto an opposing stone, if the stone has no empty nodes to get pushed onto, it is crushed and removed from the game!</p><p>This is the first way that you can start to get an advantage in a game of Sigil.</p>',
				},
				{
					text: '<p>We’ll learn about casting spells in a moment, but first let’s learn about the next turn action: Dashing.</p>',
				},
				// Section 3
				{
					text: '<p>To make a dash move after taking your regular move, but before passing the turn, press the Dash button.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							setRequiredTutorialActions('dash');
							showTutorialStepPointers(['.action-button--dash'], {
								placement: 'right',
							});
							handleMessageEvent({
								actionlist: ['dash'],
								awaiting: 'action',
								message: '',
							});
						},
					},
				},
				{
					text: '<p>To dash you first sacrifice 2 stones. Let’s sacrifice these two.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							['.stone-node--a7', '.stone-node--b11'].forEach((selector) => {
								document
									.querySelector(selector)
									.removeEventListener('click', _this.handleCustomNodeClick);
							});
							_this.handleCustomNodeClick = undefined;
						},
						show() {
							showTutorialStepPointers(['.stone-node--a7', '.stone-node--b11'], {
								placement: 'top',
							});
							setRequiredTutorialActions(['a7', 'b11']);

							_this.handleCustomNodeClick = (event) => {
								handleBoardStateEvent({
									[event.target.ariaLabel]: null,
								});
							};

							['.stone-node--a7', '.stone-node--b11'].forEach((selector) => {
								document
									.querySelector(selector)
									.addEventListener('click', _this.handleCustomNodeClick);
							});
						},
					},
				},
				{
					text: '<p>Now you get to make a second Regular Move.</p><p>Let’s place our stone here.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'a13' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--a13']);
							setRequiredTutorialActions('a13');
							handleValidMovesEvent({
								a2: 'blue',
								a5: 'blue',
								a7: 'blue',
								a13: 'blue',
								b3: 'blue',
								b6: 'blue',
								b11: 'blue',
							});
						},
					},
				},
				{
					text: '<p>Well done!</p><p>Remember since you must sacrifice 2 stones in order to dash, dashing puts you down a stone. So, make sure you are dashing for a tactical advantage.</p>',
				},
				{
					text: '<p>Next let’s cast some spells!</p>',
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

			function handleNewStonePlacement(payload, showReset = true) {
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
					_this.showReset = showReset;
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

			function advanceTour() {
				if (_this.tutorialCanProgress) {
					resetRequiredTutorialActions();
					_this.tutorial.next();
				}
			}

			_this.advanceTour = advanceTour;

			function showTutorialStepPointers(selectors, options) {
				_this.tooltipSelectors = selectors;

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
							{
								name: 'flip',
								options: {
									fallbackPlacements: ['left'],
								},
							},
						],
						placement: 'left',
						...options,
					});
					_this.$nextTick(() => {
						instance.forceUpdate();
					});
					_this.tooltipInstances.push(instance);
				});
			}

			function hideTutorialStepPointers() {
				_this.tooltipInstances.forEach((instance) => {
					instance.destroy();
				});
				_this.tooltipInstances = [];
				_this.tooltipSelectors = [];
			}

			function setRequiredTutorialActions(actions) {
				if (Array.isArray(actions)) {
					_this.awaitingTutorialActions.push(...actions);
				} else {
					_this.awaitingTutorialActions.push(actions);
				}
				document.querySelector(
					`[data-shepherd-step-id="${_this.activeTutorialStep}"] .shepherd-button`
				).disabled = true;
			}

			function handleRequiredTutorialActions(action) {
				this.awaitingTutorialActions = this.awaitingTutorialActions.filter(
					(reqAction) => reqAction !== action
				);
			}

			_this.handleRequiredTutorialActions = handleRequiredTutorialActions;

			function resetRequiredTutorialActions() {
				_this.awaitingTutorialActions = [];
				document.querySelector(
					`[data-shepherd-step-id="${_this.activeTutorialStep}"] .shepherd-button`
				).disabled = false;
			}

			function placeTutorialStone(
				{ color, delay = 0, node, push = false, showReset = false },
				callback
			) {
				const handler = () => {
					_this.currentPlayer = color;

					if (!push) {
						handleNewStonePlacement(
							{
								color,
								node: node,
							},
							showReset
						);
					}

					handleBoardStateEvent({
						[node]: color,
					});

					handleValidMovesEvent({});

					if (callback) {
						callback();
					}
				};
				if (delay) {
					setTimeout(handler, delay);
				} else {
					handler();
				}
			}
		},
	}));
});
