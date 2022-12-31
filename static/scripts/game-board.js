document.addEventListener('alpine:init', () => {
	let warnBeforeUnload = true;
	window.onbeforeunload = () => (warnBeforeUnload ? true : null);

	Alpine.data(
		'gameBoard',
		// eslint-disable-next-line no-unused-vars
		({ check = '', elo = 0, gameName = '', playerCount = 0, username = '' }) => ({
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
			redName: '',
			blueName: '',
			redElo: 0,
			blueElo: 0,
			redTimer: 0,
			blueTimer: 0,
			isLadder: false,

			formatTimer(timerSeconds) {
				const sec = timerSeconds % 60;
				const min = (timerSeconds - sec) / 60;
				return `${min}:${sec.toString().padStart(2, '0')}`;
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

				const apiPath =
					playerCount === 1 ? 'singleplayergame' : gameName ? `privategame/${gameName}` : 'game';
				const apiProtocol = document.location.protocol === 'http:' ? 'ws:' : 'wss:';
				_this.events = new WebSocket(`${apiProtocol}//${location.host}/api/${apiPath}`);
				_this.events.onmessage = handleIncomingEvent;

				_this.sendEvent = function sendEvent(message) {
					_this.events.send(JSON.stringify({ message }));
					_this.awaiting = null;
				};

				//HACK: this is just to make testing event handlers easier during development
				window.debug_spoofEvent = (data) => {
					handleIncomingEvent({
						data: JSON.stringify(data),
					});
				};

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

					if (type === 'laddersetup') {
						handleLadderSetupEvent(payload);
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

					if (type === 'push_animation') {
						handlePushAnimation(payload);
						return;
					}

					if (type === 'crush_animation') {
						handleCrushAnimation(payload);
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

					if (type === 'username_request') {
						handleUsernameRequestEvent();
						return;
					}

					if (type === 'check_request') {
						handleCheckRequestEvent();
						return;
					}

					if (type === 'red_timer') {
						handleColorTimerEvent(payload, 'red');
						return;
					}

					if (type === 'blue_timer') {
						handleColorTimerEvent(payload, 'blue');
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
					const isValidStateKey = (key) => key !== undefined;
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

				//debug_spoofEvent({type: 'push_animation', pushed_color: 'red', starting_node: 'a12', ending_node: 'a1'})
				function handlePushAnimation(payload) {
					const startNodeElem = document.querySelector(`#stone-node--${payload.starting_node}`);
					const endNodeElem = document.querySelector(`#stone-node--${payload.ending_node}`);

					const { x: xStart, y: yStart } = startNodeElem.getBoundingClientRect();
					const { x: xEnd, y: yEnd } = endNodeElem.getBoundingClientRect();
					const xDiff = xStart - xEnd;
					const yDiff = yStart - yEnd;

					//move stone to start node (instant)
					endNodeElem.style.transition = 'transform 0s';
					endNodeElem.style.transform = `translate(${xDiff}px, ${yDiff}px)`;
					setTimeout(() => {
						//move stone back again (animated)
						endNodeElem.style.transition = `transform 750ms ease-in-out`;
						endNodeElem.style.transform = '';
					}, 50);
				}

				//debug_spoofEvent({type: 'new_stone_animation', color: 'blue', node: 'b1'}); debug_spoofEvent({type: 'crush_animation', crushed_color: 'red', node: 'b1'})
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

				function handleGameOverEvent(payload) {
					_this.messageHistory.push(
						`Game over! ${payload.winner === 'blue' ? 'Blue' : 'Red'} wins`
					);
					_this.showReset = false;
					_this.winner = payload.winner;
					warnBeforeUnload = false;
				}

				function handleUsernameRequestEvent() {
					_this.sendEvent(username);
				}

				function handleCheckRequestEvent() {
					_this.sendEvent(check);
				}

				//debug_spoofEvent({ type: 'red_timer', seconds: 9 });
				function handleColorTimerEvent(payload, color) {
					const timerSeconds = payload.seconds;
					if (color === 'red') {
						_this.redTimer = timerSeconds;
					} else {
						_this.blueTimer = timerSeconds;
					}
				}

				//debug_spoofEvent({ type: 'laddersetup', red_name: 'Rachel', blue_name: 'Basil', red_elo: 1001, blue_elo: 999, red_timer: 900, blue_timer: 900 });
				function handleLadderSetupEvent(payload) {
					_this.redName = payload.red_name;
					_this.blueName = payload.blue_name;
					_this.redElo = payload.red_elo;
					_this.blueElo = payload.blue_elo;
					_this.redTimer = payload.red_timer;
					_this.blueTimer = payload.blue_timer;
					_this.isLadder = true;
				}
			},
		})
	);
});
