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
			importGameText: '',
			exportCopied: false,
			gameExportCopied: false,
			winner: '',

			// Game review state
			reviewMode: false,
			reviewIndex: 0,
			reviewSfns: [],
			reviewTurnLabels: [],
			_spellNamesForExport: [],
			_redNameForExport: 'Red',
			_blueNameForExport: 'Blue',
			_gameLogForExport: null,

			importGame() {
				const text = (this.importGameText || '').trim();
				if (!text) return;
				let payload;
				try {
					payload = JSON.parse(text);
				} catch (e) {
					alert('Could not parse game data: ' + e.message);
					return;
				}
				if (!payload || payload.type !== 'sigil-game' || !Array.isArray(payload.sfns)) {
					alert('Not a Sigil game export.');
					return;
				}
				try {
					sessionStorage.setItem('sigil_import_game', text);
					window.location.href = window.location.pathname + '?review=session';
				} catch (e) {
					// sessionStorage unavailable — load in-place as fallback
					this._loadReviewFromPayload(payload);
				}
			},

			_loadReviewFromPayload(payload) {
				const spellNames = payload.spellNames || [];
				const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
				const dict = {};
				const images = {};
				const text = {};
				for (let i = 0; i < 9 && i < spellNames.length; i++) {
					const name = spellNames[i];
					dict[posNames[i]] = name;
					images[posNames[i]] = 'static/images/spells/' + name + '.png';
					text[posNames[i]] = {
						name: name.replace(/_/g, ' '),
						text: (typeof SPELL_TEXTS !== 'undefined' && SPELL_TEXTS[name]) || '',
					};
				}
				this.spellDict = dict;
				this.spells.images = images;
				this.spells.text = text;
				this.reviewSfns = payload.sfns.slice();
				this.reviewTurnLabels = (payload.turnLabels || []).slice();
				this.winner = payload.winner || '';
				this._spellNamesForExport = spellNames.slice();
				this._redNameForExport = payload.redName || 'Red';
				this._blueNameForExport = payload.blueName || 'Blue';
				this.annotations = Object.assign({}, payload.annotations || {});
				this.reviewMode = true;
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
				this.messageHistory.push('Loaded imported game for review.');
			},

			exportGame() {
				if (this.reviewSfns.length === 0) return;
				const payload = {
					v: 1,
					type: 'sigil-game',
					spellNames: this._spellNamesForExport,
					winner: this.winner,
					redName: this._redNameForExport,
					blueName: this._blueNameForExport,
					timestamp: Date.now(),
					sfns: this.reviewSfns.slice(),
					turnLabels: this.reviewTurnLabels.slice(),
					annotations: Object.assign({}, this.annotations || {}),
					gameLog: this._gameLogForExport || null,
				};
				const text = JSON.stringify(payload);
				navigator.clipboard.writeText(text).then(() => {
					this.gameExportCopied = true;
					setTimeout(() => { this.gameExportCopied = false; }, 2000);
				});
			},

			// Annotation state (only used in vs-AI mode with mode enabled)
			myColor: '',
			annotationMode: false,
			lastOpponentTurn: null,
			annotations: {},
			setAnnotation(value) {
				if (!this.annotationMode || !this.lastOpponentTurn) return;
				const tn = this.lastOpponentTurn.turnNumber;
				const current = this.annotations[tn];
				const next = current === value ? null : value;
				if (next === null) {
					delete this.annotations[tn];
				} else {
					this.annotations[tn] = next;
				}
				if (next === 'good') this.messageHistory.push('You marked turn ' + tn + ' as a good move.');
				else if (next === 'bad') this.messageHistory.push('You marked turn ' + tn + ' as a bad move.');
				else this.messageHistory.push('Annotation cleared for turn ' + tn + '.');
			},

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

				// Direct review-mode entry from import flow:
				//   ?review=session  → JSON stashed in sessionStorage by importGame()
				//   ?review=<json>   → inline JSON (fallback for short payloads / shared URLs)
				const reviewBlob = new URLSearchParams(window.location.search).get('review');
				if (reviewBlob) {
					let raw = null;
					if (reviewBlob === 'session') {
						try {
							raw = sessionStorage.getItem('sigil_import_game');
							sessionStorage.removeItem('sigil_import_game');
						} catch (e) { /* sessionStorage blocked */ }
					} else {
						try { raw = decodeURIComponent(reviewBlob); } catch (e) { raw = null; }
					}
					if (raw) {
						try {
							const payload = JSON.parse(raw);
							if (payload && payload.type === 'sigil-game') {
								warnBeforeUnload = false;
								_this._loadReviewFromPayload(payload);
								_this.sendEvent = function() {};
								return;
							}
						} catch (e) {
							console.error('Bad review payload:', e);
						}
					}
				}

				// --- Local engine instead of WebSocket ---
				const aiMode = new URLSearchParams(window.location.search).get('ai');
				let _engineRef = null;

				// Auth manager for rated AI games
				let _aiAuthManager = null;
				if (aiMode && typeof AuthManager !== 'undefined' && typeof firebase !== 'undefined') {
					_aiAuthManager = new AuthManager();
					_aiAuthManager.onAuthChanged(async (user) => {
						if (user && !user.isAnonymous) {
							try {
								await _aiAuthManager.loadProfile(firebase.database());
								_this.annotationMode = !!_aiAuthManager.annotationMode;
							} catch (e) {
								// Non-fatal; just leave annotation mode off
								console.warn('Could not load annotation preference:', e);
							}
						}
					});
				}

				// Randomize which color the AI plays
				const _aiColor = Math.random() < 0.5 ? 'red' : 'blue';
				const _humanColor = _aiColor === 'red' ? 'blue' : 'red';
				_this.myColor = _humanColor;

				async function initEngine() {
					let options = {};

					if (aiMode === 'easy') {
						options.aiColor = _aiColor;
						options.ai = new GreedyAI();
					} else if (aiMode === 'medium' || aiMode === 'aux' || aiMode === 'graph') {
						// Each mode loads a different experimental model so I
						// can A/B them against each other on rated games. The
						// strategic-eval search-time guardrail is on by default
						// for all neural variants — it costs nothing per move
						// and consistently suppresses naked dashes / lets-the-
						// enemy-Fireblast-grow turns regardless of model.
						const variant = {
							medium: { name: 'sigil_net',       loader: SigilNetJS },
							aux:    { name: 'sigil_net_aux',   loader: SigilNetJS },
							graph:  { name: 'sigil_net_graph', loader: SigilNetGraphJS },
						}[aiMode];
						try {
							const model = await variant.loader.load(
								`static/models/${variant.name}.json`,
								`static/models/${variant.name}.bin`,
							);
							options.aiColor = _aiColor;
							options.ai = new NeuralAI(model, 100, 1.0);
						} catch (e) {
							console.error('Failed to load AI model, falling back to greedy:', e);
							options.aiColor = _aiColor;
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

				// Keyboard shortcuts
				document.addEventListener('keydown', (e) => {
					const tag = document.activeElement?.tagName;
					if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
					if (e.key === 'Enter' && _this.actionList.includes('pass')) {
						e.preventDefault();
						_this.handleEndTurn();
					}
					if (e.key === 'd' && _this.actionList.includes('dash')) {
						e.preventDefault();
						_this.handleDash();
					}
				});

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

					if (type === 'turn_complete') {
						const t = rest.turn;
						if (t && t.color && t.color !== _this.myColor) {
							_this.lastOpponentTurn = { turnNumber: t.turnNumber, color: t.color };
						}
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

					// Spell cast sound + visual effect
					if (_this.message && _this.message.includes(' casts ')) {
						if (typeof soundManager !== 'undefined') soundManager.play('spellCast');
						if (typeof playSpellEffect === 'function') {
							const spellName = _this.message.split(' casts ')[1]?.replace(/ /g, '_');
							if (spellName) playSpellEffect(_this.$refs.spellFxOverlay, _this.$refs.gameBoardContainer, spellName);
						}
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

				let _turnCount = 0;
				function handleWhoseTurnEvent(payload) {
					_this.showReset = false;
					_this.messageHistory.push(payload.message);
					_this.whoseTurn = payload.color;
					if (typeof soundManager !== 'undefined' && _turnCount === 0) soundManager.play('gameStart');
					_turnCount++;
				}

				function handleNewStonePlacement(payload) {
					_this.lastPlay = payload.node;
					if (typeof soundManager !== 'undefined') soundManager.play('stonePlaced');

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
					if (typeof soundManager !== 'undefined') soundManager.play('stonePushed');
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
					if (typeof soundManager !== 'undefined') soundManager.play('stoneCrushed');
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
					if (typeof soundManager !== 'undefined') soundManager.play('gameOver');
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
						_this._gameLogForExport = payload.gameLog;
						if (_engineRef && _engineRef.board && _engineRef.board.spellNames) {
							_this._spellNamesForExport = _engineRef.board.spellNames.slice();
						}
						if (aiMode) {
							_this._redNameForExport = _aiColor === 'red' ? ('AI (' + aiMode + ')') : 'You';
							_this._blueNameForExport = _aiColor === 'blue' ? ('AI (' + aiMode + ')') : 'You';
						} else {
							_this._redNameForExport = 'Red';
							_this._blueNameForExport = 'Blue';
						}
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

						// Ensure AI user exists
						await _ensureAiUser(db, aiUid, difficulty);
						// Ensure human profile is loaded
						await _aiAuthManager.ensureUserProfile(db);

						const spellNamesArr = _engineRef && _engineRef.board ? _engineRef.board.spellNames : ['none'];
						const gameTurns = _engineRef ? _engineRef._gameLog : [];
						const aiLabel = _aiAuthManager && _aiAuthManager.userProfile && _aiAuthManager.userProfile.displayName;
						const humanName = aiLabel || _aiAuthManager.displayName || 'You';
						const aiName = _aiNameFor(difficulty);

						// Create a /rooms entry so the game is replayable from the
						// profile page via multiplayer.html?id=CODE. AI games don't
						// have a real room during play, but we synthesize one here
						// purely as a replay record.
						const roomCode = _generateLocalRoomCode();
						try {
							await db.ref('rooms/' + roomCode).set({
								spellNames: spellNamesArr,
								status: 'finished',
								created: Date.now(),
								finishedAt: Date.now(),
								red: { connected: false, uid: _humanColor === 'red' ? humanUid : aiUid, displayName: _humanColor === 'red' ? humanName : aiName },
								blue: { connected: false, uid: _humanColor === 'blue' ? humanUid : aiUid, displayName: _humanColor === 'blue' ? humanName : aiName },
								ranked: true,
								winner: winner,
								gameLog: gameTurns,
								allowSpectators: true,
								timeControl: { type: 'none' },
							});
						} catch (e) {
							console.warn('Could not save AI replay room:', e.message);
						}

						const gameRecord = {
							spellNames: spellNamesArr,
							winner: winner,
							turns: gameTurns,
							timestamp: Date.now(),
							roomCode: roomCode,
							redUid: _humanColor === 'red' ? humanUid : aiUid,
							blueUid: _humanColor === 'blue' ? humanUid : aiUid,
							ranked: true,
						};

						// Attach any annotations the human made during the game.
						if (_this.annotations && Object.keys(_this.annotations).length > 0) {
							gameRecord.annotations = Object.assign({}, _this.annotations);
						}

						const ref = await db.ref('completed_games').push(gameRecord);
						const result = await processEloClientSide(db, ref.key, gameRecord);
						if (result) {
							const youWon = winner === _humanColor;
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

				function _aiNameFor(difficulty) {
					const labels = {
						easy: 'AI (Easy)',
						medium: 'AI (Medium)',
						aux: 'AI (Tactical Aux)',
						graph: 'AI (Graph Trunk)',
					};
					return labels[difficulty] || ('AI (' + difficulty + ')');
				}

				function _generateLocalRoomCode() {
					const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
					let code = '';
					for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
					return code;
				}

				async function _ensureAiUser(db, aiUid, difficulty) {
					const ref = db.ref('users/' + aiUid);
					const snap = await ref.once('value');
					if (!snap.exists()) {
						const labels = {
							easy: 'AI (Easy)',
							medium: 'AI (Medium)',
							aux: 'AI (Tactical Aux)',
							graph: 'AI (Graph Trunk)',
						};
						const name = labels[difficulty] || `AI (${difficulty})`;
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
