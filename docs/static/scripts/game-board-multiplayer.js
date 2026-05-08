/**
 * game-board-multiplayer.js
 * Alpine.js component for online multiplayer.
 * Uses MultiplayerController + FirebaseSync instead of local GameController.
 */
document.addEventListener('alpine:init', () => {
	Alpine.data(
		'gameBoard',
		() => ({
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
					new Array(13).fill(true).forEach((_, index) => {
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
			spells: { images: {}, text: {} },
			spellTooltip: {},
			validMoves: {},
			whoseTurn: '',
			currentSfn: '',
			winner: '',

			// Player names and timer
			redName: '',
			blueName: '',
			redUid: '',
			blueUid: '',
			redTimer: 0,
			blueTimer: 0,
			timerType: 'none',
			isSpectator: false,

			// Game review state
			reviewMode: false,
			reviewIndex: 0,
			reviewSfns: [],
			reviewTurnLabels: [],

			// Share link
			shareUrl: '',
			linkCopied: false,
			copyGameLink() {
				if (!this.shareUrl) return;
				navigator.clipboard.writeText(this.shareUrl).then(() => {
					this.linkCopied = true;
					setTimeout(() => { this.linkCopied = false; }, 2000);
				});
			},

			// Export-game state
			gameExportCopied: false,
			_spellNamesForExport: [],
			_gameLogForExport: null,

			// Rematch state — populated at game start from window._multiplayerState
			// so the win-modal "Play Again" buttons can return to the lobby and
			// optionally re-create a room with the same nine spells / time control.
			_rematchSpells: [],
			_rematchTimeControl: null,
			_rematchVariant: 'standard',
			playAgain() {
				try {
					sessionStorage.setItem('sigil_rematch_create', '1');
					if (this._rematchTimeControl) {
						sessionStorage.setItem('sigil_rematch_time_control', JSON.stringify(this._rematchTimeControl));
					}
					if (this._rematchVariant && this._rematchVariant !== 'standard') {
						sessionStorage.setItem('sigil_rematch_variant', this._rematchVariant);
					} else {
						sessionStorage.removeItem('sigil_rematch_variant');
					}
					sessionStorage.removeItem('sigil_rematch_spells');
				} catch (e) { /* sessionStorage blocked */ }
				window.location.href = 'multiplayer.html';
			},
			playAgainSameLayout() {
				try {
					sessionStorage.setItem('sigil_rematch_create', '1');
					if (this._rematchTimeControl) {
						sessionStorage.setItem('sigil_rematch_time_control', JSON.stringify(this._rematchTimeControl));
					}
					if (this._rematchVariant && this._rematchVariant !== 'standard') {
						sessionStorage.setItem('sigil_rematch_variant', this._rematchVariant);
					} else {
						sessionStorage.removeItem('sigil_rematch_variant');
					}
					if (this._rematchSpells && this._rematchSpells.length === 9) {
						sessionStorage.setItem('sigil_rematch_spells', JSON.stringify(this._rematchSpells));
					}
				} catch (e) { /* sessionStorage blocked */ }
				window.location.href = 'multiplayer.html';
			},
			exportGame() {
				const log = this._gameLogForExport;
				if (!Array.isArray(log) || log.length === 0) return;
				const turns = log.map(entry => ({
					n: entry.turnNumber,
					color: entry.color,
					actions: Array.isArray(entry.actions) ? entry.actions.slice() : [],
				}));
				const lastEntry = log[log.length - 1];
				const nextToMove = this.winner
					? null
					: (lastEntry && lastEntry.color === 'red' ? 'blue' : 'red');
				const payload = {
					v: 2,
					type: 'sigil-game',
					spellNames: this._spellNamesForExport,
					winner: this.winner || null,
					nextToMove,
					redName: this.redName || 'Red',
					blueName: this.blueName || 'Blue',
					timestamp: Date.now(),
					turns,
					annotations: Object.assign({}, this.annotations || {}),
				};
				const text = JSON.stringify(payload);
				navigator.clipboard.writeText(text).then(() => {
					this.gameExportCopied = true;
					setTimeout(() => { this.gameExportCopied = false; }, 2000);
				});
			},

			// Rematch handshake state — driven by controller events. The button on the
			// win-modal cycles: Offer Rematch → Offering Rematch / Accept Rematch →
			// Starting Rematch… (or Opponent Disconnected if presence flips).
			selfOfferedRematch: false,
			opponentOfferedRematch: false,
			rematchOpponentDisconnected: false,
			rematchPending: false,
			offerOrAcceptRematch() {
				if (this.isSpectator || !this._engine) return;
				if (this.rematchOpponentDisconnected || this.rematchPending) return;
				if (typeof this._engine.offerRematch !== 'function') return;
				if (this.selfOfferedRematch) {
					this._engine.cancelRematch();
					this.selfOfferedRematch = false;
				} else {
					this._engine.offerRematch();
					this.selfOfferedRematch = true;
				}
			},

			// Annotation state
			myColor: '',
			annotationMode: false,
			lastOpponentTurn: null, // { turnNumber, color } or null
			annotations: {},        // { turnNumber: 'good' | 'bad' }
			evalAnnotations: {},    // { turnNumber: 'red' | 'blue' | 'even' }
			setAnnotation(value) {
				if (!this.annotationMode || !this.lastOpponentTurn) return;
				if (this.isSpectator) return;
				const tn = this.lastOpponentTurn.turnNumber;
				const current = this.annotations[tn];
				const next = current === value ? null : value;
				if (next === null) {
					delete this.annotations[tn];
				} else {
					this.annotations[tn] = next;
				}
				if (this._engine && typeof this._engine.setAnnotation === 'function') {
					this._engine.setAnnotation(tn, next);
				}
				if (next === 'good') this.messageHistory.push('You marked turn ' + tn + ' as a good move.');
				else if (next === 'bad') this.messageHistory.push('You marked turn ' + tn + ' as a bad move.');
				else this.messageHistory.push('Annotation cleared for turn ' + tn + '.');
			},
			setEvalAnnotation(value) {
				if (!this.annotationMode || !this.lastOpponentTurn) return;
				if (this.isSpectator) return;
				const tn = this.lastOpponentTurn.turnNumber;
				const current = this.evalAnnotations[tn];
				const next = current === value ? null : value;
				if (next === null) {
					delete this.evalAnnotations[tn];
				} else {
					this.evalAnnotations[tn] = next;
				}
				if (this._engine && typeof this._engine.setEvalAnnotation === 'function') {
					this._engine.setEvalAnnotation(tn, next);
				}
				if (next) this.messageHistory.push('You marked the position after turn ' + tn + ' as ' + (next === 'even' ? 'even' : next + ' ahead') + '.');
				else this.messageHistory.push('Position eval cleared for turn ' + tn + '.');
			},

			startReview() {
				if (this.reviewSfns.length === 0) return;
				this.reviewMode = true;
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},
			_initReviewMode(spellNames, gameLog, winner) {
				if (!gameLog || gameLog.length === 0) {
					this.messageHistory.push('No game log available for review.');
					return;
				}
				// Populate spell setup from spellNames (same mapping as engine)
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

				// Build reviewSfns/reviewTurnLabels from gameLog (same shape as live mode)
				const sfns = [gameLog[0].sfnBefore];
				const labels = ['Start'];
				for (const turn of gameLog) {
					sfns.push(turn.sfnAfter);
					const cn = turn.color[0].toUpperCase() + turn.color.slice(1);
					const tn = turn.color === 'red'
						? Math.floor(turn.turnNumber / 2) + 1
						: Math.floor(turn.turnNumber / 2);
					labels.push(cn + ' ' + tn);
				}
				this.reviewSfns = sfns;
				this.reviewTurnLabels = labels;
				this.winner = winner || '';
				this._gameLogForExport = gameLog;
				this._spellNamesForExport = (spellNames || []).slice();
				this.messageHistory.push('Reviewing game. Use the controls to navigate turns.');
				this.reviewMode = true;
				this.reviewIndex = sfns.length - 1;
				this._showReviewPosition();
			},
			reviewPrev() { if (this.reviewIndex > 0) { this.reviewIndex--; this._showReviewPosition(); } },
			reviewNext() { if (this.reviewIndex < this.reviewSfns.length - 1) { this.reviewIndex++; this._showReviewPosition(); } },
			reviewFirst() { this.reviewIndex = 0; this._showReviewPosition(); },
			reviewLast() { this.reviewIndex = this.reviewSfns.length - 1; this._showReviewPosition(); },
			exitReview() { this.reviewMode = false; this.reviewIndex = this.reviewSfns.length - 1; this._showReviewPosition(); },
			_showReviewPosition() {
				const sfn = this.reviewSfns[this.reviewIndex];
				if (!sfn) return;
				const state = sfnToDict(sfn);
				for (const node of Object.keys(this.nodes)) { this.nodes[node] = state.stones[node] || null; }
				this.redSpellCounter = state.red_spellcounter || 0;
				this.blueSpellCounter = state.blue_spellcounter || 0;
				this.redLock = state.red_lock || '';
				this.blueLock = state.blue_lock || '';
				this.score = state.score || 'unset';
				this.validMoves = {};
				this.lastPlay = '';
			},

			formatTimer(ms) {
				if (this.timerType === 'correspondence') {
					// Show as deadline date/time
					if (ms <= 0) return 'Expired';
					const d = new Date(ms);
					return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
				}
				// Real-time: show M:SS
				const totalSec = Math.max(0, Math.ceil(ms / 1000));
				const min = Math.floor(totalSec / 60);
				const sec = totalSec % 60;
				return min + ':' + String(sec).padStart(2, '0');
			},

			closeSpellTooltip() { this.activeSpell = ''; if (this.spellTooltip.destroy) this.spellTooltip.destroy(); },
			showSpellTooltip(spell) {
				this.activeSpell = spell;
				const anchor = document.querySelector(`.spell--tooltip-anchor-${spell}`);
				const tooltip = this.$refs.spellTooltip;
				this.$nextTick(() => {
					this.spellTooltip = Popper.createPopper(anchor, tooltip, { modifiers: [{ name: 'offset', options: { offset: [0, 8] } }], placement: 'auto' });
					this.spellTooltip.forceUpdate();
				});
			},
			handleCastSpell(spell) { if (this.isSpectator) return; this.sendEvent(this.spellDict[spell]); this.closeSpellTooltip(); },
			handleDash() { if (this.isSpectator) return; this.sendEvent('dash'); this.actionList = []; },
			handleEndTurn() { if (this.isSpectator) return; this.sendEvent('pass'); this.actionList = []; },
			handleCharmClick(spell) {
				const cn = this.spellDict[spell];
				if (this.awaiting === 'action' && this.actionList.includes(cn)) {
					this.activeSpellIsCastable = true;
					if (this.hasTouchScreen) this.showSpellTooltip(spell); else this.sendEvent(cn);
				} else { this.activeSpellIsCastable = false; if (this.hasTouchScreen) this.showSpellTooltip(spell); }
			},
			handleSpellClick(spell) {
				const sn = this.spellDict[spell];
				if (this.awaiting === 'spell' || (this.awaiting === 'action' && this.actionList.includes(sn))) {
					this.activeSpellIsCastable = true;
					if (this.hasTouchScreen) this.showSpellTooltip(spell); else this.sendEvent(sn);
				} else { this.activeSpellIsCastable = false; if (this.hasTouchScreen) this.showSpellTooltip(spell); }
			},
			handleSpellMouseOut() { if (!this.hasTouchScreen) { this.activeSpell = ''; if (this.spellTooltip.destroy) this.spellTooltip.destroy(); } },
			handleSpellMouseOver(spell) { if (!this.hasTouchScreen) this.showSpellTooltip(spell); },
			handleReset() { if (this.isSpectator) return; this.sendEvent('reset'); this.actionList = []; this.lastPlay = ''; this.nodesToRefill = {}; this.playerToRefill = ''; this.showReset = false; this.validMoves = {}; },
			handleNodeClick(node) {
				if (this.isSpectator) return;
				this.currentPlayer = this.whoseTurn;
				if (this.awaiting === 'node') this.sendEvent(node);
				else if (this.awaiting === 'action' && this.actionList.includes('move')) this.sendEvent(node);
			},

			init() {
				const _this = this;
				_this.hasTouchScreen = matchMedia('(any-pointer: coarse)').matches;
				_this.$watch('messageHistory', () => {
					_this.$nextTick(() => { if (_this.$refs.messageHistory) _this.$refs.messageHistory.scrollTop = _this.$refs.messageHistory.scrollHeight; });
				});

				// Wait for multiplayer state to be set by the lobby
				const waitForState = setInterval(() => {
					if (!window._multiplayerState) return;
					clearInterval(waitForState);
					const state = window._multiplayerState;
					const { sync, spellNames, myColor, reconnectSfn, isSpectator, timeControl, variant, redDisplayName, blueDisplayName, redUid, blueUid, annotationMode, reviewMode, gameLog, winner, shareUrl } = state;

					// Set player names and timer type
					_this.redName = redDisplayName || '';
					_this.blueName = blueDisplayName || '';
					_this.redUid = redUid || '';
					_this.blueUid = blueUid || '';
					_this.timerType = (timeControl && timeControl.type) || 'none';
					_this.isSpectator = isSpectator || false;
					_this.myColor = myColor || '';
					_this.annotationMode = !!annotationMode && !_this.isSpectator;
					_this.shareUrl = shareUrl || '';
					_this._rematchSpells = Array.isArray(spellNames) ? spellNames.slice() : [];
					_this._rematchTimeControl = timeControl ? Object.assign({}, timeControl) : null;
					_this._rematchVariant = variant === 'competitive' ? 'competitive' : 'standard';

					if (reviewMode) {
						// Skip engine entirely — render finished game in review mode
						_this.sendEvent = function() {};
						_this._initReviewMode(spellNames || [], gameLog || [], winner || null);
						return;
					}

					let engine;
					if (isSpectator) {
						engine = new SpectatorController(
							function emitEvent(eventObj) { handleIncomingEvent(eventObj); },
							sync, spellNames
						);
						// Spectators have no sendEvent
						_this.sendEvent = function() {};
					} else {
						engine = new MultiplayerController(
							function emitEvent(eventObj) { handleIncomingEvent(eventObj); },
							sync, myColor, spellNames
						);

						_this.sendEvent = function(message) {
							engine.handlePlayerAction(message);
							_this.awaiting = null;
						};
					}

					_this._engine = engine;
					engine.startGame(reconnectSfn);
				}, 100);

				// Keyboard shortcuts
				document.addEventListener('keydown', (e) => {
					if (_this.isSpectator) return;
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

				let _turnCount = 0;
				function handleIncomingEvent(payload) {
					const { type, ...rest } = payload;
					if (type === 'message') {
						_this.actionList = rest.actionlist || []; _this.awaiting = rest.awaiting; _this.message = rest.message; if (rest.moveoptions) _this.validMoves = rest.moveoptions;
						// Spell cast sound + visual effect
						if (_this.message && _this.message.includes(' casts ')) {
							if (typeof soundManager !== 'undefined') soundManager.play('spellCast');
							if (typeof playSpellEffect === 'function') {
								const spellName = _this.message.split(' casts ')[1]?.replace(/ /g, '_');
								if (spellName) playSpellEffect(_this.$refs.spellFxOverlay, _this.$refs.gameBoardContainer, spellName);
							}
						}
						if (_this.awaiting !== 'action' && rest.message) _this.messageHistory.push(rest.message);
					}
					else if (type === 'spellsetup') { _this.spellDict = rest; Object.entries(rest).forEach(([k, v]) => { _this.spells.images[k] = `static/images/spells/${v}.png`; }); }
					else if (type === 'spelltextsetup') { _this.spells.text = rest; }
					else if (type === 'sfn_update') { _this.currentSfn = rest.sfn; }
					else if (type === 'boardstate') {
						const changed = Object.keys(rest).reduce((acc, c) => { if (rest[c] !== _this.previousBoardState[c]) acc[c] = rest[c]; return acc; }, {});
						const { bluelock, bluespellcounter, last_play, last_player, redlock, redspellcounter, score, ...nodes } = changed;
						Object.keys(nodes).forEach(n => { _this.nodes[n] = nodes[n]; });
						if (bluelock !== undefined) _this.blueLock = bluelock;
						if (bluespellcounter !== undefined) _this.blueSpellCounter = bluespellcounter;
						if (redlock !== undefined) _this.redLock = redlock;
						if (redspellcounter !== undefined) _this.redSpellCounter = redspellcounter;
						if (score !== undefined) _this.score = score;
						_this.previousBoardState = rest;
					}
					else if (type === 'whoseturndisplay') { _this.showReset = false; _this.messageHistory.push(rest.message); _this.whoseTurn = rest.color; if (typeof soundManager !== 'undefined' && _turnCount === 0) soundManager.play('gameStart'); _turnCount++; }
					else if (type === 'turn_complete') {
						// Track the most recent opponent turn for annotation eligibility.
						const t = rest.turn;
						if (t && t.color && t.color !== _this.myColor) {
							_this.lastOpponentTurn = { turnNumber: t.turnNumber, color: t.color };
						}
					}
					else if (type === 'new_stone_animation') { if (typeof soundManager !== 'undefined') soundManager.play('stonePlaced'); _this.lastPlay = rest.node; if (rest.color !== _this.currentPlayer) { setTimeout(() => { const el = document.getElementById(`stone-node--${rest.node}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); }, 50); } else { _this.showReset = true; } }
					else if (type === 'push_animation') {
						if (typeof soundManager !== 'undefined') soundManager.play('stonePushed');
						const s = document.querySelector(`#stone-node--${rest.starting_node}`), e = document.querySelector(`#stone-node--${rest.ending_node}`);
						if (s && e) { const sr = s.getBoundingClientRect(), er = e.getBoundingClientRect(); e.style.transition = 'transform 0s'; e.style.transform = `translate(${sr.x-er.x}px, ${sr.y-er.y}px)`; setTimeout(() => { e.style.transition = 'transform 750ms ease-in-out'; e.style.transform = ''; }, 50); }
					}
					else if (type === 'crush_animation') { if (typeof soundManager !== 'undefined') soundManager.play('stoneCrushed'); const ne = document.querySelector(`#stone-node--${rest.node}`); if (ne) { const cs = document.createElement('button'); cs.setAttribute('class', `stone-node stone-node--crushed stone-node--${rest.node} stone-node--${rest.crushed_color}`); cs.addEventListener('animationend', () => cs.remove()); ne.parentNode.insertBefore(cs, ne); } }
					else if (type === 'chooserefills') { const { playercolor, ...n } = rest; _this.nodesToRefill = n; _this.playerToRefill = playercolor; }
					else if (type === 'donerefilling') { _this.nodesToRefill = {}; _this.playerToRefill = ''; }
					else if (type === 'pushingoptions') { _this.validMoves = rest; }
					else if (type === 'timer_tick') { _this.redTimer = rest.red; _this.blueTimer = rest.blue; }
					else if (type === 'rematch_state_changed') {
						const r = rest.rematch || {};
						const myColor = _this.myColor;
						const opponentColor = myColor === 'red' ? 'blue' : 'red';
						_this.selfOfferedRematch = r[myColor] === 'offered';
						_this.opponentOfferedRematch = r[opponentColor] === 'offered';
						_this.rematchPending = !!r.newRoomCode;
					}
					else if (type === 'rematch_room_ready') {
						window.location.href = 'multiplayer.html?id=' + encodeURIComponent(rest.newRoomCode);
					}
					else if (type === 'opponent_disconnect') {
						_this.rematchOpponentDisconnected = true;
					}
					else if (type === 'game_over') {
						if (typeof soundManager !== 'undefined') soundManager.play('gameOver');
						_this.messageHistory.push(`Game over! ${rest.winner === 'blue' ? 'Blue' : 'Red'} wins`);
						_this.showReset = false;
						_this.winner = rest.winner;
						if (rest.gameLog && rest.gameLog.length > 0) {
							const sfns = [rest.gameLog[0].sfnBefore];
							const labels = ['Start'];
							for (const turn of rest.gameLog) {
								sfns.push(turn.sfnAfter);
								const cn = turn.color[0].toUpperCase() + turn.color.slice(1);
								const tn = turn.color === 'red' ? Math.floor(turn.turnNumber / 2) + 1 : Math.floor(turn.turnNumber / 2);
								labels.push(cn + ' ' + tn);
							}
							_this.reviewSfns = sfns;
							_this.reviewTurnLabels = labels;
							_this._gameLogForExport = rest.gameLog;
							if (_this._engine && _this._engine.board && _this._engine.board.spellNames) {
								_this._spellNamesForExport = _this._engine.board.spellNames.slice();
							}
						}
					}
				}
			},
		})
	);
});
