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
					this.handleRequiredTutorialActions(charmName);
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
					this.handleRequiredTutorialActions(spellName);
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
						advanceTour();
					});
				}
			});

			_this.sendEvent = function sendEvent() {
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
					text: '<h2>Welcome to Sigil Online!</h2><p>This tutorial will tell you everything you need to know to play a game of Sigil.</p><p>Press the Next button or Space to continue.',
				},
				{
					text: '<p>Sigil is a battle between the red and blue stones.</p><p>Each side is trying to expand their territory and constrain their opponent’s territory.</p>',
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
									name: 'Hail Storm',
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
					text: '<p>On each player’s turn, they place one new stone of their color onto the board. This is called a regular move.</p><p>Stones must be placed adjacent to where a player already has a stone on the board.</p>',
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
					text: '<p>Let’s fast-forward the game so we can learn about pushing.</p>',
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
					text: '<p>Let’s see what happens when you place a stone onto a node occupied by your opponent.</p><p>Try placing a stone where indicated.</p>',
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
					text: '<p>When you place a stone onto an opposing piece, their stone gets pushed to the nearest empty node.</p><p>It can get pushed through stones of its own color, but not through your stones.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							placeTutorialStone({ color: 'red', node: 'a4', push: true }, () => {
								handlePushAnimation({starting_node: 'a9', ending_node: 'a4'});
								showTutorialStepPointers(['.stone-node--a4'], {
									placement: 'right',
								});
							});
						},
					},
				},
				{
					text: '<p>Looks like it’s going to be a fight for territory! Your stone got pushed to the closest empty node.</p>',
					when: {
						show() {
							handleValidMovesEvent({
								a5: 'red',
								a6: 'red',
								a7: 'red',
								a9: 'red',
								c10: 'red',
							});
							placeTutorialStone({ color: 'red', delay: 50, node: 'a9' });
							placeTutorialStone({ color: 'blue', delay: 50, node: 'a7', push: true }, () => {
								handlePushAnimation({starting_node: 'a9', ending_node: 'a7'});
								showTutorialStepPointers(['.stone-node--a7'], {
									placement: 'top',
								});
							});
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
							showTutorialStepPointers(['.stone-node--a9']);
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
					text: '<p>Go ahead and push their stone to the node indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'red', node: 'a6', push: true }, () => {
								handlePushAnimation({starting_node: 'a9', ending_node: 'a6'});
							});
						},
						show() {
							showTutorialStepPointers(['.stone-node--a6'], {
								placement: 'top',
							});
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
							_this.lastPlay = '';

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
						},
					},
				},
				{
					text: '<p>Go ahead and place a stone onto the surrounded Red stone that’s indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'a9' }, () => {
								handleCrushAnimation({crushed_color: 'red', node: 'a9'});
							});
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
					text: '<p>To make a dash move after taking your regular move, but before ending your the turn, press the Dash button.</p>',
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
					text: '<p>To dash, you first sacrifice 2 stones. Let’s sacrifice the 2 indicated.</p>',
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
					text: '<p>Now you get to make a second, regular move.</p><p>Let’s place our stone on the red stone indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'a13' }, () => {
								handleCrushAnimation({crushed_color: 'red', node: 'a13'});
							});
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
					text: '<p>Well done, you crushed Red’s stone!</p><p>Remember, since you must sacrifice 2 stones in order to dash, dashing puts you down a stone. So, make sure you are dashing for a tactical advantage.</p>',
				},
				{
					text: '<p>Next let’s cast some spells!</p>',
				},
				// Section 4.a
				{
					text: '<p>First, let’s set up a new board.</p>',
					when: {
						show() {
							_this.lastPlay = '';

							handleSpellSetupEvent({
								ritual1: 'Starfall',
								ritual2: 'Flourish',
								ritual3: 'Carnage',
								sorcery1: 'Fireblast',
								sorcery2: 'Hail_Storm',
								sorcery3: 'Meteor',
								charm1: 'Slash',
								charm2: 'Comet',
								charm3: 'Sprout',
							});

							handleSpellTextSetupEvent({
								ritual1: {
									name: 'Starfall',
									text: 'Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them.',
								},
								ritual2: {
									name: 'Flourish',
									text: 'Make 4 soft moves.',
								},
								ritual3: {
									name: 'Carnage',
									text: 'Make 4 hard moves.',
								},
								sorcery1: {
									name: 'Fireblast',
									text: 'Destroy all enemy stones which are touching you.',
								},
								sorcery2: {
									name: 'Hail Storm',
									text: 'Destroy 1 enemy stone in each spell.',
								},
								sorcery3: {
									name: 'Meteor',
									text: 'Make 1 blink move, then destroy 1 enemy stone touching it.',
								},
								charm1: {
									name: 'Slash',
									text: 'Make 1 hard move.',
								},
								charm2: {
									name: 'Comet',
									text: 'Make 1 blink move, then sacrifice a stone.',
								},
								charm3: {
									name: 'Sprout',
									text: 'Make 1 soft move.',
								},
							});

							handleBoardStateEvent({
								a1: 'red',
								a2: null,
								a3: null,
								a4: null,
								a6: null,
								a8: null,
								a9: null,
								a10: null,
								a11: null,
								a13: null,
								b1: 'blue',
								b2: null,
								c9: null,
								c10: null,
								c13: null,
							});
						},
					},
				},
				{
					text: '<p>As mentioned earlier, a game of Sigil is played with 9 random spells.</p>',
				},
				{
					text: '<p>There are three 5-node spells,</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers([
								'.spell--tooltip-anchor-ritual1',
								'.spell--tooltip-anchor-ritual2',
								'.spell--tooltip-anchor-ritual3',
							]);
						},
					},
				},
				{
					text: '<p>Three 3-node spells,</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers([
								'.spell--tooltip-anchor-sorcery1',
								'.spell--tooltip-anchor-sorcery2',
								'.spell--tooltip-anchor-sorcery3',
							]);
						},
					},
				},
				{
					text: '<p>And three 1-node spells.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers([
								'.spell--tooltip-anchor-charm1',
								'.spell--tooltip-anchor-charm2',
								'.spell--tooltip-anchor-charm3',
							]);
						},
					},
				},
				{
					text: '<p>On phones and tablets, you can tap a spell to see what it does. On a laptop or desktop computer, you can hover over a spell to see its effect.</p>',
				},
				{
					text: '<p>After your regular move and your optional dash move, you’ll have the option to cast 1 spell on your turn.</p>',
				},
				{
					text: '<p>To cast a spell you must first fully occupy it with your stones.</p>',
				},
				{
					text: '<p>Let’s take a look at this board state.</p><p>You’re only 1 stone away from casting Flourish.',
					when: {
						show() {
							handleBoardStateEvent({
								a2: 'red',
								a6: 'red',
								a11: 'red',
								b2: 'blue',
								b4: 'blue',
								b5: 'blue',
								b6: 'blue',
								c8: 'red',
								c1: 'blue',
								c9: 'red',
								c10: 'red',
								c13: 'red',
							});
						},
					},
				},
				{
					text: '<p>Place a stone in Flourish to fully occupy it.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'b3' });
						},
						show() {
							setRequiredTutorialActions('b3');
							showTutorialStepPointers(['.stone-node--b3'], {
								placement: 'right',
							});
						},
					},
				},
				{
					text: '<p>Excellent!</p><p>Now you can cast Flourish.</p><p>Spells that can be cast are highlighted.</p><p>To cast Flourish, click on it.</p>',
					when: {
						show() {
							handleMessageEvent({
								actionlist: ['Flourish'],
								awaiting: 'action',
								message: '',
							});
							setRequiredTutorialActions('Flourish');
						},
					},
				},
				{
					text: '<p>When casting a spell you must first sacrifice all of your stones that are on it.</p><p>However, when casting 3- and 5-node spells, you get a discount for each mana that you control.</p>',
					when: {
						show() {
							handleChooseRefillsEvent({
								b2: 'True',
								b3: 'True',
								b4: 'True',
								b5: 'True',
								b6: 'True',
								playercolor: 'blue',
							});
						},
					},
				},
				{
					text: '<p>There are 3 mana nodes on the board: the Red and Blue starting locations, and a third node at the top of the board.</p><p>Right now you control 2 mana nodes, which means you get to leave 2 stones in Flourish.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers(['.stone-node--a1', '.stone-node--b1', '.stone-node--c1']);
						},
					},
				},
				{
					text: '<p>Let’s select these 2 stones to leave on Flourish.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							['.stone-node--b3', '.stone-node--b6'].forEach((selector) => {
								document
									.querySelector(selector)
									.removeEventListener('click', _this.handleCustomNodeClick);
							});
							_this.handleCustomNodeClick = undefined;
						},
						show() {
							showTutorialStepPointers(['.stone-node--b3', '.stone-node--b6']);
							setRequiredTutorialActions(['b3', 'b6']);

							_this.handleCustomNodeClick = (event) => {
								const node = event.target.ariaLabel;
								handleBoardStateEvent({
									[node]: 'blue',
								});

								if (_this.awaitingTutorialActions.length === 1) {
									handleChooseRefillsEvent({
										b2: 'True',
										b4: 'True',
										b5: 'True',
										...(node === 'b3' ? { b6: 'True' } : { b3: 'True' }),
										playercolor: 'blue',
									});
								} else {
									handleDoneRefillingEvent();
									handleBoardStateEvent({
										b2: null,
										b4: null,
										b5: null,
									});
								}
							};

							['.stone-node--b3', '.stone-node--b6'].forEach((selector) => {
								document
									.querySelector(selector)
									.addEventListener('click', _this.handleCustomNodeClick);
							});
						},
					},
				},
				{
					text: '<p>After sacrificing your stones on Flourish, you can now resolve its effect.</p><p>Flourish states: “Make 4 soft moves.”</p>',
				},
				{
					text: '<p>Many spell effects let you place extra stones, aka "make moves", but with restrictions on where they can be placed.</p> A soft move is a move that must be played onto an unoccupied (empty) node. Regular rules on adjacency still apply (that is, it must be touching one of your existing stones).</p>',
				},
				{
					text: '<p>Go ahead and resolve Flourish by making 4 soft moves into the indicated nodes. (In a real game, each soft move must be adjacent to one of your existing stones, so the order you place them matters.)</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							['.stone-node--c2', '.stone-node--c3', '.stone-node--c4', '.stone-node--c6'].forEach(
								(selector) => {
									document
										.querySelector(selector)
										.removeEventListener('click', _this.handleCustomNodeClick);
								}
							);
							_this.handleCustomNodeClick = undefined;
						},
						show() {
							showTutorialStepPointers([
								'.stone-node--c2',
								'.stone-node--c3',
								'.stone-node--c4',
								'.stone-node--c6',
							]);
							setRequiredTutorialActions(['c2', 'c3', 'c4', 'c6']);

							_this.handleCustomNodeClick = (event) => {
								handleBoardStateEvent({
									[event.target.ariaLabel]: 'blue',
								});
							};

							['.stone-node--c2', '.stone-node--c3', '.stone-node--c4', '.stone-node--c6'].forEach(
								(selector) => {
									document
										.querySelector(selector)
										.addEventListener('click', _this.handleCustomNodeClick);
								}
							);
						},
					},
				},
				{
					text: '<p>Well done!</p>',
				},
				{
					text: '<p>After you cast a 3- or 5-node spell, the spell becomes locked.</p><p>You can tell a spell is locked by the colored ring around it.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								bluelock: 'Flourish',
							});
						},
					},
				},
				{
					text: "<p>When a spell is locked, you cannot cast it again until after you cast a different 3- or 5-node spell. This will move your lock to the new spell, and the original spell will become unlocked.</p><p>Each player has a separate lock; you can still cast your opponent's locked spell, and vice versa.</p>",
				},
				{
					text: '<p>Let’s fast-forward 2 turns so you can cast some more spells.</p>',
					when: {
						show() {
							setRequiredTutorialActions('delay');
							placeTutorialStone({ color: 'red', delay: 1750, node: 'a5' });
							placeTutorialStone(
								{ color: 'blue', delay: 2500, node: 'c5' },
								resetRequiredTutorialActions
							);
						},
					},
				},
				{
					text: '<p>Now you can cast Carnage.</p>',
					when: {
						show() {
							handleMessageEvent({
								actionlist: ['Carnage'],
								awaiting: 'action',
								message: '',
							});
							setRequiredTutorialActions('Carnage');
						},
					},
				},
				{
					text: '<p>Keep the 2 stones indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							['.stone-node--c3', '.stone-node--c4'].forEach((selector) => {
								document
									.querySelector(selector)
									.removeEventListener('click', _this.handleCustomNodeClick);
							});
							_this.handleCustomNodeClick = undefined;
						},
						show() {
							handleChooseRefillsEvent({
								c2: 'True',
								c3: 'True',
								c4: 'True',
								c5: 'True',
								c6: 'True',
								playercolor: 'blue',
							});

							showTutorialStepPointers(['.stone-node--c3', '.stone-node--c4']);
							setRequiredTutorialActions(['c3', 'c4']);

							_this.handleCustomNodeClick = (event) => {
								const node = event.target.ariaLabel;
								handleBoardStateEvent({
									[node]: 'blue',
								});

								if (_this.awaitingTutorialActions.length === 1) {
									handleChooseRefillsEvent({
										c2: 'True',
										c5: 'True',
										c6: 'True',
										...(node === 'c3' ? { c4: 'True' } : { c3: 'True' }),
										playercolor: 'blue',
									});
								} else {
									handleDoneRefillingEvent();
									handleBoardStateEvent({
										c2: null,
										c5: null,
										c6: null,
									});
								}
							};

							['.stone-node--c3', '.stone-node--c4'].forEach((selector) => {
								document
									.querySelector(selector)
									.addEventListener('click', _this.handleCustomNodeClick);
							});
						},
					},
				},
				{
					text: '<p>Carnage states: “Make 4 hard moves.”</p><p>Hard moves MUST be onto nodes occupied by enemy stones.</p>',
				},
				{
					text: '<p>Let’s resolve Carnage by making 4 hard moves where indicated.</p>',
					when: {
						hide() {
							[
								'.stone-node--c7',
								'.stone-node--c8',
								'.stone-node--c10',
								'.stone-node--c13',
							].forEach((selector) => {
								document
									.querySelector(selector)
									.removeEventListener('click', _this.handleCustomNodeClick);
							});
							_this.handleCustomNodeClick = undefined;

							handleDoneRefillingEvent();
							handleBoardStateEvent({
								bluelock: 'Carnage',
							});
						},
						show() {
							showTutorialStepPointers(['.stone-node--c13']);
							setRequiredTutorialActions(['dummy']);
							let awaitingNode = 'c13';

							_this.handleCustomNodeClick = (event) => {
								const node = event.target.ariaLabel;

								if (awaitingNode === node) {
									handleBoardStateEvent({
										[node]: 'blue',
									});

									if (node === 'c13') {
										placeTutorialStone({ color: 'blue', node });
										placeTutorialStone({ color: 'red', push: true, node: 'c7' }, () => {
											handlePushAnimation({starting_node: 'c13', ending_node: 'c7'});
										});
										hideTutorialStepPointers();
										showTutorialStepPointers(['.stone-node--c7']);
										awaitingNode = 'c7';
									} else if (node === 'c7') {
										placeTutorialStone({ color: 'red', push: true, node: 'a12' }, () => {
											handlePushAnimation({starting_node: 'c7', ending_node: 'a12'});
										});
										hideTutorialStepPointers();
										showTutorialStepPointers(['.stone-node--c8']);
										awaitingNode = 'c8';
									} else if (node === 'c8') {
										placeTutorialStone({ color: 'red', push: true, node: 'a4' }, () => {
											handlePushAnimation({starting_node: 'c8', ending_node: 'a4'});
										});
										hideTutorialStepPointers();
										showTutorialStepPointers(['.stone-node--c10']);
										awaitingNode = 'c10';
									} else {
										placeTutorialStone({ color: 'red', push: true, node: 'a3' }, () => {
											handlePushAnimation({starting_node: 'c10', ending_node: 'a3'});
										});
										hideTutorialStepPointers();
										resetRequiredTutorialActions();
									}
								}
							};

							[
								'.stone-node--c7',
								'.stone-node--c8',
								'.stone-node--c10',
								'.stone-node--c13',
							].forEach((selector) => {
								document
									.querySelector(selector)
									.addEventListener('click', _this.handleCustomNodeClick);
							});
						},
					},
				},
				{
					text: '<p>Nicely played!</p>',
				},
				{
					text: '<p>Let’s fast-forward the game a bit.</p><p>Red has cast Starfall and you can now cast Meteor.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								a3: 'null',
								a4: 'null',
								a5: 'null',
								a7: 'red',
								c1: 'null',
								c2: 'red',
								c3: 'null',
								c6: 'red',
								c9: 'blue',
								redlock: 'Starfall',
							});
							handleMessageEvent({
								actionlist: ['Meteor'],
								awaiting: 'action',
								message: '',
							});
							_this.lastPlay = '';
							setRequiredTutorialActions('Meteor');
						},
					},
				},
				{
					text: '<p>You now only control 1 mana, so choose the 1 stone indicated to keep on Meteor.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							handleDoneRefillingEvent();
							handleBoardStateEvent({
								c8: null,
								c9: null,
								c10: 'blue',
							});
							placeTutorialStone({ color: 'blue', node: 'c10' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--c10']);
							setRequiredTutorialActions('c10');
							handleChooseRefillsEvent({
								c8: 'True',
								c9: 'True',
								c10: 'True',
								playercolor: 'blue',
							});
						},
					},
				},
				{
					text: '<p>Meteor states: “Make 1 blink move, then destroy 1 enemy stone touching it.”</p><p>A blink move is a move that does not have to be adjacent to a stone you already have on the board.</p><p>Unless otherwise specified, it can be either a hard or soft move.</p>',
				},
				{
					text: '<p>Let’s reclaim the top mana.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							handleBoardStateEvent({
								c1: 'blue',
							});
						},
						show() {
							showTutorialStepPointers(['.stone-node--c1']);
							setRequiredTutorialActions('c1');
						},
					},
				},
				{
					text: '<p>Now destroy the Red stone adjacent to your newly placed stone.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							handleBoardStateEvent({
								c2: null,
								bluelock: 'Meteor',
							});
						},
						show() {
							showTutorialStepPointers(['.stone-node--c2']);
							setRequiredTutorialActions('c2');
						},
					},
				},
				{
					text: '<p>Well done!</p>',
				},
				{
					text: '<p>Now let’s fast-forward a bit more and see how to cast a 1-node spell.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								c3: 'blue',
								c11: 'red',
							});
							_this.lastPlay = 'c3';
						},
					},
				},
				{
					text: '<p>1-node spells do not get a discount for controlling mana. You always have to sacrifice the 1 stone on the spell to cast it.</p>',
				},
				{
					text: '<p>Click on Sprout to cast it.</p><p>Sprout states: “Make 1 soft move.”',
					when: {
						hide() {
							hideTutorialStepPointers();
							handleBoardStateEvent({
								c7: null,
							});
							handleMessageEvent({
								actionlist: null,
								message: '',
							});
						},
						show() {
							showTutorialStepPointers(['.spell--tooltip-anchor-charm3'], {
								position: 'right',
							});
							handleMessageEvent({
								actionlist: ['Sprout'],
								awaiting: 'action',
								message: '',
							});
							setRequiredTutorialActions('Sprout');
						},
					},
				},
				{
					text: '<p>Now resolve Sprout by soft moving where indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'c5' });
						},
						show() {
							showTutorialStepPointers(['.stone-node--c5'], {
								position: 'right',
							});
							setRequiredTutorialActions('c5');
						},
					},
				},
				{
					text: '<p>Well played!</p><p>Next we’ll learn about static spells.</p>',
				},
				// Section 4.b
				{
					text: '<p>Static spells are denoted by the word “STATIC” before their effect text.</p>',
				},
				{
					text: '<p>They function differently from non-static spells in that they are not cast.</p><p>Instead, they give you a permanent effect while you fully occupy them with your stones.</p>',
				},
				{
					text: '<p>Let’s set up a new board and take a closer look at Seal of Wind.</p>',
					when: {
						show() {
							_this.lastPlay = '';

							handleSpellSetupEvent({
								ritual1: 'Starfall',
								ritual2: 'Seal_of_Lightning',
								ritual3: 'Carnage',
								sorcery1: 'Seal_of_Wind',
								sorcery2: 'Fireblast',
								sorcery3: 'Meteor',
								charm1: 'Seal_of_Summer',
								charm2: 'Comet',
								charm3: 'Surge',
							});

							handleSpellTextSetupEvent({
								ritual1: {
									name: 'Starfall',
									text: 'Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them.',
								},
								ritual2: {
									name: 'Seal of Lightning',
									text: 'STATIC: Your dash only requires 1 sacrifice.',
								},
								ritual3: {
									name: 'Carnage',
									text: 'Make 4 hard moves.',
								},
								sorcery1: {
									name: 'Seal of Wind',
									text: 'STATIC: Your first move each turn is a blink move.',
								},
								sorcery2: {
									name: 'Fireblast',
									text: 'Destroy all enemy stones which are touching you.',
								},
								sorcery3: {
									name: 'Meteor',
									text: 'Make 1 blink move, then destroy 1 enemy stone touching it.',
								},
								charm1: {
									name: 'Seal of Summer',
									text: 'STATIC: You may cast 2 spells on your turn.',
								},
								charm2: {
									name: 'Comet',
									text: 'Make 1 blink move, then sacrifice a stone.',
								},
								charm3: {
									name: 'Surge',
									text: 'If you dashed this turn, make 1 move.',
								},
							});

							handleBoardStateEvent({
								a1: 'red',
								a2: null,
								a3: null,
								a4: null,
								a5: null,
								a6: null,
								a7: null,
								a8: null,
								a9: null,
								a10: null,
								a11: null,
								a12: null,
								a13: null,
								b1: 'blue',
								b2: null,
								b3: null,
								b6: null,
								b11: null,
								bluelock: null,
								c1: null,
								c3: null,
								c4: null,
								c5: null,
								c6: null,
								c7: null,
								c9: null,
								c10: null,
								c11: null,
								c13: null,
								redlock: null,
							});

							showTutorialStepPointers(['.spell--tooltip-anchor-sorcery1']);
						},
					},
				},
				{
					text: '<p>Seal of Wind states: “STATIC: Your first move each turn is a blink move.”</p><p>That means that if you fully occupy Seal of Wind, then the first stone you place on your turn can be anywhere on the board!</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
					},
				},
				{
					text: '<p>Let’s fast-forward the game so we can see how it works.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								a1: 'red',
								a2: 'red',
								a3: 'red',
								a4: 'red',
								a5: 'red',
								a6: 'red',
								a7: 'red',
								a8: 'blue',
								a9: 'blue',
								a10: 'blue',
								b1: 'blue',
								b2: 'blue',
								b11: 'blue',
							});
						},
					},
				},
				{
					text: '<p>Because you fully occupy Seal of Wind, your first move does not need to be adjacent to stones you already have on the board.</p><p>Let’s go ahead and claim the mana indicated.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
							placeTutorialStone({ color: 'blue', node: 'c1' });
						},
						show() {
							setRequiredTutorialActions('c1');
							showTutorialStepPointers(['.stone-node--c1']);
						},
					},
				},
				{
					text: '<p>Nicely done!</p><p>Now that we know how to play Sigil, let’s learn how to win!</p>',
				},
				// Section 5
				{
					text: '<p>A game of Sigil ends under two conditions.</p><p>Let’s reset the board to find out how.',
					when: {
						show() {
							_this.lastPlay = '';

							handleBoardStateEvent({
								a1: 'red',
								a2: null,
								a3: null,
								a4: null,
								a5: null,
								a6: null,
								a7: null,
								a8: null,
								a9: null,
								a10: null,
								b1: 'blue',
								b2: null,
								b11: null,
								c1: null,
							});
						},
					},
				},
				{
					text: '<p>Most games end when one player has a <strong>3-Stone advantage</strong> at the end of a turn.</p>',
				},
				{
					text: '<p>The track in the center of the board is the Score Keeping Track.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers(['.score-track']);
						},
					},
				},
				{
					text: '<p>A Blue stone is used as the Score Keeping stone. It counts the difference between the number of Red stones and Blue stones.</p><p>When it indicates that one player has a 3-stone advantage at the end of a turn, that player wins.',
					when: {
						show() {
							handleBoardStateEvent({
								score: 'b1',
							});
						},
					},
				},
				{
					text: '<p>Since Red always goes first, Blue gets an advantage to offset this. The Score Keeping stone is a Blue stone and it counts towards Blue’s score.</p><p>Other than counting for points, it does not interact with the game in any way, and it cannot be sacrificed or destroyed.</p><p>Notice that at the start of the game, Red has 1 stone and Blue has 2 (including the Score Keeping stone), so Blue has a 1-stone advantage and the Score Keeping stone is on Blue +1.</p>',
				},
				{
					text: '<p>Let’s look at another example.</p><p>Red has 5 stones.</p><p>Blue has 7 stones: 6 on the board plus the Score Keeping stone.</p><p>Therefore, Blue has a 2-stone advantage.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								a3: 'red',
								a7: 'red',
								a8: 'blue',
								a9: 'blue',
								a10: 'blue',
								b1: 'blue',
								b3: 'blue',
								b5: 'red',
								b6: 'red',
								c1: 'blue',
								score: 'b2',
							});
						},
					},
				},
				{
					text: '<p>The second, and less common, way that a game ends is when either player casts their 6<sup>th</sup> 3- and/or 5-node spell.</p>',
					when: {
						show() {
							handleBoardStateEvent({
								a3: null,
								a7: null,
								a8: null,
								a9: null,
								a10: null,
								b1: null,
								b3: null,
								b5: null,
								b6: null,
								score: 'b1',
							});
						},
					},
				},
				{
					text: '<p>When a player casts a 3- or 5-node spell, their Spell die’s value increases by 1.</p>',
					when: {
						hide() {
							hideTutorialStepPointers();
						},
						show() {
							showTutorialStepPointers(['.dice'], {
								placement: 'right',
							});
							handleBoardStateEvent({
								bluespellcounter: 1,
							});
						},
					},
				},
				{
					text: '<p>At the end of the turn in which either player casts their 6<sup>th</sup> 3- or 5-node spell, the game ends.</p><p>Whoever has a stone advantage at that time wins!</p><p>If the number of stones is tied, then whoever is about to take the next turn wins (because they would have a stone advantage if the game continued).</p>',
					when: {
						show() {
							handleBoardStateEvent({
								bluespellcounter: 6,
							});
						},
					},
				},
				{
					buttons: [
						{
							action() {
								window.location = '/';
							},
							text: 'Play Now',
						},
					],
					text: '<p>And that wraps up our tutorial!</p><p>Do you have what it takes to control the Sigil?</p>',
				},
			]);

			startTutorial();

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

			function handleNewStonePlacement(payload, { lastPlay = true, showReset = true }) {
				if (lastPlay) {
					_this.lastPlay = payload.node;
				}

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

			function handlePushAnimation(payload) {
				const startNodeElem = document.querySelector(`#stone-node--${payload.starting_node}`);
				const endNodeElem = document.querySelector(`#stone-node--${payload.ending_node}`);

				const { x: xStart, y: yStart } = startNodeElem.getBoundingClientRect();
				const { x: xEnd, y: yEnd } = endNodeElem.getBoundingClientRect();
				const xDiff = xStart - xEnd;
				const yDiff = yStart - yEnd;

				//tutorial push animation need to wait a tick before moving stone to start node
				//	otherwise telling the tutorial step pointer to point at the end node can wind up pointing at where
				//	the end node is when the push animation begins (instead of where it'll be when push animation ends)
				setTimeout(() => {
					//move stone to start node (instant)
					endNodeElem.style.transition = 'transform 0s';
					endNodeElem.style.transform = `translate(${xDiff}px, ${yDiff}px)`;

					setTimeout(() => {
						//move stone back again (animated)
						endNodeElem.style.transition = `transform 750ms ease-in-out`;
						endNodeElem.style.transform = '';
					}, 50);
				}, 25);
			}

			function handleCrushAnimation(payload) {
				const { node, crushed_color } = payload;
				const nodeElem = document.querySelector(`#stone-node--${node}`);

				//create temporary stone element, use it for crush animation, and then remove it
				const crushStone = document.createElement('button');
				crushStone.setAttribute(
					'class',
					`stone-node stone-node--crushed stone-node--${node} stone-node--${crushed_color}`
				);
				crushStone.addEventListener('animationend', () => {
					crushStone.remove();
				});
				nodeElem.parentNode.insertBefore(crushStone, nodeElem);
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

			function advanceTour() {
				if (_this.tutorialCanProgress) {
					resetRequiredTutorialActions();
					_this.tutorial.next();
				}
			}

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
				{ color, delay = 0, lastPlay = true, node, push = false, showReset = false },
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
							{
								lastPlay,
								showReset,
							}
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
