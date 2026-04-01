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
			handleCastSpell(spell) { this.sendEvent(this.spellDict[spell]); this.closeSpellTooltip(); },
			handleDash() { this.sendEvent('dash'); this.actionList = []; },
			handleEndTurn() { this.sendEvent('pass'); this.actionList = []; },
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
			handleReset() { this.sendEvent('reset'); this.actionList = []; this.lastPlay = ''; this.nodesToRefill = {}; this.playerToRefill = ''; this.showReset = false; this.validMoves = {}; },
			handleNodeClick(node) {
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
					const { sync, spellNames, myColor } = window._multiplayerState;

					const engine = new MultiplayerController(
						function emitEvent(eventObj) { handleIncomingEvent(eventObj); },
						sync, myColor, spellNames
					);

					_this.sendEvent = function(message) {
						engine.handlePlayerAction(message);
						_this.awaiting = null;
					};

					engine.startGame();
				}, 100);

				function handleIncomingEvent(payload) {
					const { type, ...rest } = payload;
					if (type === 'message') { _this.actionList = rest.actionlist || []; _this.awaiting = rest.awaiting; _this.message = rest.message; if (rest.moveoptions) _this.validMoves = rest.moveoptions; if (_this.awaiting !== 'action' && rest.message) _this.messageHistory.push(rest.message); }
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
					else if (type === 'whoseturndisplay') { _this.showReset = false; _this.messageHistory.push(rest.message); _this.whoseTurn = rest.color; }
					else if (type === 'new_stone_animation') { _this.lastPlay = rest.node; if (rest.color !== _this.currentPlayer) { setTimeout(() => { const el = document.getElementById(`stone-node--${rest.node}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); }, 50); } else { _this.showReset = true; } }
					else if (type === 'push_animation') {
						const s = document.querySelector(`#stone-node--${rest.starting_node}`), e = document.querySelector(`#stone-node--${rest.ending_node}`);
						if (s && e) { const sr = s.getBoundingClientRect(), er = e.getBoundingClientRect(); e.style.transition = 'transform 0s'; e.style.transform = `translate(${sr.x-er.x}px, ${sr.y-er.y}px)`; setTimeout(() => { e.style.transition = 'transform 750ms ease-in-out'; e.style.transform = ''; }, 50); }
					}
					else if (type === 'crush_animation') { const ne = document.querySelector(`#stone-node--${rest.node}`); if (ne) { const cs = document.createElement('button'); cs.setAttribute('class', `stone-node stone-node--crushed stone-node--${rest.node} stone-node--${rest.crushed_color}`); cs.addEventListener('animationend', () => cs.remove()); ne.parentNode.insertBefore(cs, ne); } }
					else if (type === 'chooserefills') { const { playercolor, ...n } = rest; _this.nodesToRefill = n; _this.playerToRefill = playercolor; }
					else if (type === 'donerefilling') { _this.nodesToRefill = {}; _this.playerToRefill = ''; }
					else if (type === 'pushingoptions') { _this.validMoves = rest; }
					else if (type === 'game_over') { _this.messageHistory.push(`Game over! ${rest.winner === 'blue' ? 'Blue' : 'Red'} wins`); _this.showReset = false; _this.winner = rest.winner; }
				}
			},
		})
	);
});
