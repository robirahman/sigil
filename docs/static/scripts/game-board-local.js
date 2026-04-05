document.addEventListener('alpine:init', () => {
	const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
	let warnBeforeUnload = !isSafari;
	window.onbeforeunload = () => (warnBeforeUnload ? true : null);

	Alpine.data(
		'gameBoard',
		({ importSfn: initialImportSfn = '' }) => ({
			actionList: [],
			activeSpell: '',
			activeSpellIsCastable: false,
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
			currentSfn: '',
			importSfn: initialImportSfn,
			exportCopied: false,
			winner: '',

			// Game review state
			reviewMode: false,
			reviewIndex: 0,
			reviewSfns: [],
			reviewTurnLabels: [],

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

			exportPosition() {
				if (this.currentSfn) {
					navigator.clipboard.writeText(this.currentSfn).then(() => {
						this.exportCopied = true;
						setTimeout(() => { this.exportCopied = false; }, 2000);
					});
				}
			},

			startReview() {
				if (this.reviewSfns.length === 0) return;
				this.reviewMode = true;
				this.reviewIndex = this.reviewSfns.length - 1; // start at final position
				this._showReviewPosition();
			},

			reviewPrev() {
				if (this.reviewIndex > 0) {
					this.reviewIndex--;
					this._showReviewPosition();
				}
			},

			reviewNext() {
				if (this.reviewIndex < this.reviewSfns.length - 1) {
					this.reviewIndex++;
					this._showReviewPosition();
				}
			},

			reviewFirst() {
				this.reviewIndex = 0;
				this._showReviewPosition();
			},

			reviewLast() {
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},

			exitReview() {
				this.reviewMode = false;
				// Restore final board state
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},

			_showReviewPosition() {
				const sfn = this.reviewSfns[this.reviewIndex];
				if (!sfn) return;
				const state = sfnToDict(sfn);
				for (const node of Object.keys(this.nodes)) {
					this.nodes[node] = state.stones[node] || null;
				}
				this.redSpellCounter = state.red_spellcounter || 0;
				this.blueSpellCounter = state.blue_spellcounter || 0;
				this.redLock = state.red_lock || '';
				this.blueLock = state.blue_lock || '';
				this.score = state.score || 'unset';
				this.validMoves = {};
				this.lastPlay = '';
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
					if (this.spellTooltip.destroy) {
						this.spellTooltip.destroy();
					}
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
						if (_this.$refs.messageHistory) {
							_this.$refs.messageHistory.scrollTop = _this.$refs.messageHistory.scrollHeight;
						}
					});
				});

				// --- Local engine instead of WebSocket ---
				const aiMode = new URLSearchParams(window.location.search).get('ai');
				let _engineRef = null;

				// Auth manager for rated AI games
				let _aiAuthManager = null;
				if (aiMode && typeof AuthManager !== 'undefined' && typeof firebase !== 'undefined') {
					_aiAuthManager = new AuthManager();
				}

				async function initEngine() {
					let options = {};

					if (aiMode === 'easy') {
						options.aiColor = 'blue';
						options.ai = new GreedyAI();
					} else if (aiMode === 'medium') {
						// Load neural network model
						try {
							const model = await SigilNetJS.load(
								'static/models/sigil_net.json',
								'static/models/sigil_net.bin'
							);
							options.aiColor = 'blue';
							options.ai = new NeuralAI(model, 100);
						} catch (e) {
							console.error('Failed to load AI model, falling back to greedy:', e);
							options.aiColor = 'blue';
							options.ai = new GreedyAI();
						}
					}

					const engine = new GameController(function emitEvent(eventObj) {
						handleIncomingEvent(eventObj);
					}, options);
					_engineRef = engine;

					_this.sendEvent = function sendEvent(message) {
						engine.handlePlayerAction(message);
						_this.awaiting = null;
					};

					const sfnToLoad = _this.importSfn || null;
					engine.startGame(sfnToLoad);
				}

				initEngine();

				function handleIncomingEvent(payload) {
					const { type, ...rest } = payload;

					if (type === 'ping') return;

					if (type === 'message') {
						handleMessageEvent(rest);
						return;
					}

					if (type === 'spellsetup') {
						handleSpellSetupEvent(rest);
						return;
					}

					if (type === 'spelltextsetup') {
						handleSpellTextSetupEvent(rest);
						return;
					}

					if (type === 'sfn_update') {
						_this.currentSfn = rest.sfn;
						return;
					}

					if (type === 'boardstate') {
						handleBoardStateEvent(rest);
						return;
					}

					if (type === 'whoseturndisplay') {
						handleWhoseTurnEvent(rest);
						return;
					}

					if (type === 'new_stone_animation') {
						handleNewStonePlacement(rest);
						return;
					}

					if (type === 'push_animation') {
						handlePushAnimation(rest);
						return;
					}

					if (type === 'crush_animation') {
						handleCrushAnimation(rest);
						return;
					}

					if (type === 'chooserefills') {
						handleChooseRefillsEvent(rest);
						return;
					}

					if (type === 'donerefilling') {
						handleDoneRefillingEvent();
						return;
					}

					if (type === 'pushingoptions') {
						handleValidMovesEvent(rest);
						return;
					}

					if (type === 'game_over') {
						handleGameOverEvent(rest);
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

					if (_this.message && _this.message.includes('Invalid move')) {
						_this.showReset = false;
					}

					if (_this.awaiting !== 'action' && payload.message !== '' && payload.message) {
						_this.messageHistory.push(payload.message);
					}
				}

				function handleSpellSetupEvent(payload) {
					_this.spellDict = payload;

					Object.entries(_this.spellDict).forEach(([key, value]) => {
						_this.spells.images[key] = `static/images/spells/${value}.png`;
					});

					setTimeout(() => {
						if (_this.$refs.gameBoardContainer) {
							_this.$refs.gameBoardContainer.scrollIntoView({
								behavior: 'smooth',
								block: 'center',
								inline: 'center',
							});
						}
					}, 100);
				}

				function handleSpellTextSetupEvent(payload) {
					_this.spells.text = payload;
				}

				function handleBoardStateEvent(payload) {
					const changedBoardState = Object.keys(payload).reduce((acc, curr) => {
						if (payload[curr] !== _this.previousBoardState[curr]) {
							acc[curr] = payload[curr];
						}
						return acc;
					}, {});

					const {
						bluelock,
						bluespellcounter,
						last_play,
						last_player,
						redlock,
						redspellcounter,
						score,
						...nodes
					} = changedBoardState;

					const isValidStateKey = (key) => key !== undefined;

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
						setTimeout(() => {
							const el = document.getElementById(`stone-node--${payload.node}`);
							if (el) {
								el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
							}
						}, 50);
					} else {
						_this.showReset = true;
					}
				}

				function handlePushAnimation(payload) {
					const startNodeElem = document.querySelector(`#stone-node--${payload.starting_node}`);
					const endNodeElem = document.querySelector(`#stone-node--${payload.ending_node}`);
					if (!startNodeElem || !endNodeElem) return;

					const { x: xStart, y: yStart } = startNodeElem.getBoundingClientRect();
					const { x: xEnd, y: yEnd } = endNodeElem.getBoundingClientRect();
					const xDiff = xStart - xEnd;
					const yDiff = yStart - yEnd;

					endNodeElem.style.transition = 'transform 0s';
					endNodeElem.style.transform = `translate(${xDiff}px, ${yDiff}px)`;
					setTimeout(() => {
						endNodeElem.style.transition = `transform 750ms ease-in-out`;
						endNodeElem.style.transform = '';
					}, 50);
				}

				function handleCrushAnimation(payload) {
					const { node, crushed_color } = payload;
					const nodeElem = document.querySelector(`#stone-node--${node}`);
					if (!nodeElem) return;

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

					// Build review data from game log
					if (payload.gameLog && payload.gameLog.length > 0) {
						const sfns = [payload.gameLog[0].sfnBefore];
						const labels = ['Start'];
						for (const turn of payload.gameLog) {
							sfns.push(turn.sfnAfter);
							const colorName = turn.color[0].toUpperCase() + turn.color.slice(1);
							const turnNum = turn.color === 'red'
								? Math.floor(turn.turnNumber / 2) + 1
								: Math.floor(turn.turnNumber / 2);
							labels.push(colorName + ' ' + turnNum);
						}
						_this.reviewSfns = sfns;
						_this.reviewTurnLabels = labels;
					}

					// Process Elo for rated AI games
					if (aiMode) {
						_processAiElo(payload.winner, aiMode);
					}
				}

				async function _processAiElo(winner, difficulty) {
					// Wait for auth state to resolve if needed
					if (_aiAuthManager && !_aiAuthManager.currentUser) {
						await new Promise(resolve => {
							const timeout = setTimeout(resolve, 3000); // max 3s wait
							_aiAuthManager.onAuthChanged(() => { clearTimeout(timeout); resolve(); });
						});
					}

					if (!_aiAuthManager || !_aiAuthManager.isAuthenticated) {
						_this.messageHistory.push('Sign in to track your rating.');
						return;
					}

					if (typeof processEloClientSide !== 'function') {
						_this.messageHistory.push('Rating update unavailable.');
						return;
					}

					try {
						const db = firebase.database();
						const aiUid = '__ai_' + difficulty + '__';
						const humanUid = _aiAuthManager.uid;
						const humanColor = 'red'; // human is always red vs AI

						// Ensure AI user exists
						await _ensureAiUser(db, aiUid, difficulty);
						// Ensure human profile is loaded
						await _aiAuthManager.ensureUserProfile(db);

						const gameRecord = {
							spellNames: _engineRef && _engineRef.board ? _engineRef.board.spellNames : ['none'],
							winner: winner,
							turns: _engineRef ? _engineRef._gameLog : ['none'],
							timestamp: Date.now(),
							redUid: humanUid,
							blueUid: aiUid,
							ranked: true,
						};

						const ref = await db.ref('completed_games').push(gameRecord);
						const result = await processEloClientSide(db, ref.key, gameRecord);
						if (result) {
							const youWon = winner === humanColor;
							const sign = youWon ? '+' : '-';
							_this.messageHistory.push('Rating: ' + sign + result.points + ' (' + (youWon ? result.newWinnerElo : result.newLoserElo) + ')');
						} else {
							_this.messageHistory.push('Rating update failed.');
						}
					} catch (e) {
						console.error('Failed to process AI Elo:', e);
						_this.messageHistory.push('Rating error: ' + e.message);
					}
				}

				async function _ensureAiUser(db, aiUid, difficulty) {
					const ref = db.ref('users/' + aiUid);
					const snap = await ref.once('value');
					if (!snap.exists()) {
						const name = difficulty === 'easy' ? 'AI (Easy)' : 'AI (Medium)';
						await ref.set({
							displayName: name,
							elo: 1000,
							gamesPlayed: 0,
							wins: 0,
							losses: 0,
							created: Date.now(),
							isAI: true,
						});
						// Also seed leaderboard entry
						await db.ref('leaderboard/' + aiUid).set({
							displayName: name,
							elo: 1000,
							gamesPlayed: 0,
							isAI: true,
						});
					}
				}
			},
		})
	);
});
