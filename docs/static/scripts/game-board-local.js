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

			// Spinner / live progress while the AI is searching off-thread.
			aiThinking: false,
			aiThinkingColor: '',
			aiThinkingDepth: 0,
			aiThinkingTimeMs: 0,
			aiThinkingNodes: 0,

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
			// Deathmatch removes spell counters; hides the dice in the UI.
			isDeathmatch: false,
			useArtOnlySpells: localStorage.getItem('sigilArtOnlySpellCircles') === 'true',
			showReset: false,
			spellDict: {},
			spells: {
				images: {},
				text: {},
			},
			spellTooltip: {},
			validMoves: {},
			pushSourceNode: '',
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

			// AI review state + methods come from aiReviewMixin() (game-review.js),
			// spread in below. We stash the auth manager on `this` during init so
			// the mixin can read uid via the _aiReviewGetUid override.
			_aiAuthManager: null,

			getSpellImg(key) {
				const base = this.spells.images[key];
				if (!base) return 'static/images/spacer.gif';
				if (this.useArtOnlySpells) {
					return base.replace('static/images/spells/', 'static/images/spells/art_only/');
				}
				return base;
			},

			getSpellImgWebp(key) {
				const img = this.getSpellImg(key);
				return img ? img.replace('.png', '.webp') : '';
			},

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
			evalAnnotations: {},
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
			setEvalAnnotation(value) {
				if (!this.annotationMode || !this.lastOpponentTurn) return;
				const tn = this.lastOpponentTurn.turnNumber;
				const current = this.evalAnnotations[tn];
				const next = current === value ? null : value;
				if (next === null) {
					delete this.evalAnnotations[tn];
				} else {
					this.evalAnnotations[tn] = next;
				}
				if (next) this.messageHistory.push('You marked the position after turn ' + tn + ' as ' + (next === 'even' ? 'even' : next + ' ahead') + '.');
				else this.messageHistory.push('Position eval cleared for turn ' + tn + '.');
			},

			// Dev-only AI evaluation overlay (gated on auth-manager.isDeveloper).
			// Runs the same Caveman search the live AI and game review use (via
			// the shared Web Worker, ~1s/position) and shows its score from red's
			// POV. Superseded searches are cancelled so rapid board changes don't
			// pile up; the forced-win sentinel (±CAVEMAN_WIN) is clamped to the
			// display band.
			isDeveloper: false,
			devEvalEnabled: false,
			devEvalValue: null,
			devEvalLoading: false,
			_devEvalSeq: 0,
			_devEvalSearchId: null,
			async toggleDevEval() {
				if (!this.isDeveloper) return;
				this.devEvalEnabled = !this.devEvalEnabled;
				if (this.devEvalEnabled) {
					await this._recomputeDevEval();
				} else {
					this.devEvalValue = null;
				}
			},
			async _recomputeDevEval() {
				if (!this.devEvalEnabled || !this.isDeveloper) return;
				if (!_engineRef || !_engineRef.board) return;
				if (typeof boardToSfn !== 'function') return;
				const board = _engineRef.board;
				const stm = board.whoseTurn || 'red';
				const seq = ++this._devEvalSeq;
				if (this.devEvalValue === null) this.devEvalLoading = true;
				const opts = { timeLimit: 1.0, maxDepth: 64, useSharedTt: true, resetSharedTt: false };
				try {
					let score;
					const worker = (typeof getSharedAiWorker === 'function') ? getSharedAiWorker() : null;
					if (worker && typeof Worker !== 'undefined') {
						// Supersede any in-flight dev-eval search before starting a new one.
						if (this._devEvalSearchId != null) { try { worker.cancel(this._devEvalSearchId); } catch (e) {} }
						const promise = worker.search(boardToSfn(board), stm, opts, null);
						if (!promise) { if (seq === this._devEvalSeq) this.devEvalLoading = false; return; }
						this._devEvalSearchId = promise.searchId;
						const msg = await promise;
						if (seq !== this._devEvalSeq) return;  // a newer recompute superseded us
						this._devEvalSearchId = null;
						score = msg.score;
					} else {
						const result = await cavemanSearch(SimBoard.fromSigilBoard(board), stm, opts);
						if (seq !== this._devEvalSeq) return;
						score = result.score;
					}
					this.devEvalLoading = false;
					// Search score is from the mover's POV; convert to red POV and
					// clamp the forced-win sentinel into the [-1, 1] display band.
					let v = (stm === 'red') ? score : -score;
					if (v > 1) v = 1; else if (v < -1) v = -1;
					this.devEvalValue = v;
				} catch (e) {
					if (seq === this._devEvalSeq) this.devEvalLoading = false;
					// aborted (superseded) or failed — keep the previous value
				}
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

			playAgain() {
				warnBeforeUnload = false;
				const params = new URLSearchParams(window.location.search);
				params.delete('sfn');
				params.delete('review');
				const qs = params.toString();
				window.location.href = window.location.pathname + (qs ? '?' + qs : '');
			},

			playAgainSameLayout() {
				const spells = this._spellNamesForExport;
				if (spells && spells.length === 9) {
					try {
						sessionStorage.setItem('sigil_rematch_spells', JSON.stringify(spells));
					} catch (e) { /* sessionStorage blocked */ }
				}
				this.playAgain();
			},

			playAgainSameLayoutSwap() {
				// Same spell layout, but human swaps sides with the AI.
				const swapped = this.myColor === 'red' ? 'blue' : 'red';
				try {
					sessionStorage.setItem('sigil_rematch_human_color', swapped);
				} catch (e) { /* sessionStorage blocked */ }
				this.playAgainSameLayout();
			},

			rematchStage: 'idle',  // 'idle' | 'rematch'
			isAiGame: !!new URLSearchParams(window.location.search).get('ai'),

			openRematchMenu() {
				this.rematchStage = this.rematchStage === 'rematch' ? 'idle' : 'rematch';
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
				this.pushSourceNode = '';
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
				this.pushSourceNode = '';
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

			// Spread the AI-review behaviour shared with multiplayer.html,
			// then override the uid hook to point at this page's auth manager.
			...aiReviewMixin(),
			_aiReviewGetUid() {
				return this._aiAuthManager && this._aiAuthManager.uid;
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
				let aiMode = new URLSearchParams(window.location.search).get('ai');
				// Game-rule variant (separate concept from `aiMode`'s "model
				// variant" naming below): 'standard' or 'competitive'.
				const gameVariantParam = new URLSearchParams(window.location.search).get('variant');
				let gameVariant = normalizeVariant(gameVariantParam);
				let _engineRef = null;

				// Persistence: pin a game-id to the URL (mint one if missing)
				// so a reload returns to the same game. If a save exists for
				// the id, hydrate aiMode / variant / humanColor / SFN from it
				// — these win over the URL so resume works even if the user
				// lands on /game.html?id=X without other params.
				if (typeof LocalSaveStore !== 'undefined') LocalSaveStore.purgeExpired();
				let _gameId = new URLSearchParams(window.location.search).get('id');
				if (!_gameId && typeof LocalSaveStore !== 'undefined') {
					_gameId = LocalSaveStore.mintId();
					try {
						const u = new URL(window.location.href);
						u.searchParams.set('id', _gameId);
						history.replaceState(null, '', u.toString());
					} catch (e) { /* ignore */ }
				}
				let _saveLoadedSfn = null;
				let _savedHumanColor = null;
				let _savedGameLog = null;
				if (_gameId && typeof LocalSaveStore !== 'undefined') {
					const _save = LocalSaveStore.get(_gameId);
					if (_save && _save.sfn) {
						let _validSfn = false;
						try {
							const _parsed = sfnToDict(_save.sfn);
							if (_parsed && _parsed.stones) _validSfn = true;
						} catch (e) { /* corrupted SFN — drop the save below */ }
						if (_validSfn) {
							_saveLoadedSfn = _save.sfn;
							if (_save.aiMode) aiMode = _save.aiMode;
							if (_save.variant) {
								gameVariant = normalizeVariant(_save.variant);
							}
							if (_save.humanColor === 'red' || _save.humanColor === 'blue') {
								_savedHumanColor = _save.humanColor;
							}
							if (Array.isArray(_save.gameLog)) {
								_savedGameLog = _save.gameLog;
							}
						} else {
							LocalSaveStore.remove(_gameId);
						}
					}
				}

				// Auth manager for rated AI games + community annotations from AI review.
				let _aiAuthManager = null;
				if (aiMode && typeof AuthManager !== 'undefined' && typeof firebase !== 'undefined') {
					_aiAuthManager = new AuthManager();
					_aiAuthManager.onAuthChanged(async (user) => {
						if (user && !user.isAnonymous) {
							try {
								await _aiAuthManager.loadProfile(firebase.database());
								_this.annotationMode = !!_aiAuthManager.annotationMode;
								_this.isDeveloper = !!_aiAuthManager.isDeveloper;
								if (_engineRef && _engineRef.ai) {
									_engineRef.ai.pondering = _aiAuthManager.enablePondering;
								}
							} catch (e) {
								// Non-fatal; just leave annotation mode off
								console.warn('Could not load annotation preference:', e);
							}
						}
					});
				}
				// Bridge into Alpine state so the aiReviewMixin (game-review.js)
				// can find the current uid for community annotations.
				_this._aiAuthManager = _aiAuthManager;

				// Sync any games that were completed offline on a previous visit.
				// Triggers on page load, on the `online` event, and when auth resolves.
				if (typeof OfflineGameQueue !== 'undefined') {
					OfflineGameQueue.installAutoflush({
						onFlush: (result) => {
							if (result.uploaded > 0) {
								_this.messageHistory.push('Synced ' + result.uploaded + ' offline game' + (result.uploaded === 1 ? '' : 's') + '.');
							}
						},
					});
				}

				// Pick which color the human plays. Default random, but a
				// rematch with "Swap Colors" pins the human to a specific
				// side via sessionStorage.
				let _forcedHumanColor = null;
				try {
					const raw = sessionStorage.getItem('sigil_rematch_human_color');
					if (raw === 'red' || raw === 'blue') {
						_forcedHumanColor = raw;
						sessionStorage.removeItem('sigil_rematch_human_color');
					}
				} catch (e) { /* sessionStorage blocked */ }
				const _humanColor = _forcedHumanColor || _savedHumanColor || (Math.random() < 0.5 ? 'blue' : 'red');
				const _aiColor = _humanColor === 'red' ? 'blue' : 'red';
				_this.myColor = _humanColor;

				// "Play Again (Same Layout)" stashes the spell list in sessionStorage; pick it
				// up here on next page load and feed it into the engine so the new match
				// uses the same nine spells.
				let _rematchSpells = null;
				try {
					const raw = sessionStorage.getItem('sigil_rematch_spells');
					if (raw) {
						sessionStorage.removeItem('sigil_rematch_spells');
						const parsed = JSON.parse(raw);
						if (Array.isArray(parsed) && parsed.length === 9) {
							_rematchSpells = parsed;
						}
					}
				} catch (e) { /* sessionStorage blocked or bad payload */ }

				async function initEngine() {
					let options = {};
					if (_rematchSpells) options.spellNames = _rematchSpells;
					options.variant = gameVariant;
					_this.isDeathmatch = variantHasDeathmatch(gameVariant);

					// Easy / Medium / Hard / Very Hard are now all time-budgeted
					// Caveman variants. The previous NN-based tiers were retired
					// after a sweep showed Caveman <=2-ply beats every one of them
					// 4/4. Same Firebase UIDs (__ai_easy__, etc.) for URL/bookmark
					// stability — the AIs got replaced, the slots stayed.
					const _CAVEMAN_TIER_BUDGETS = {
						easy: 0.1,
						medium: 1.0,
						hard: 5.0,
						very_hard: 60.0,
					};
					if (Object.prototype.hasOwnProperty.call(_CAVEMAN_TIER_BUDGETS, aiMode)) {
						options.aiColor = _aiColor;
						options.ai = new CavemanAI({
							maxDepth: 10,
							timeLimit: _CAVEMAN_TIER_BUDGETS[aiMode],
						});
						options.ai.pondering = _aiAuthManager
							? _aiAuthManager.enablePondering : true;
					} else if (aiMode === 'caveman' || /^caveman_[1-6]$/.test(aiMode || '')) {
						// Pure stone-count minimax — no model load. The
						// suffixed variants (caveman_1..6) each play with
						// that many plies of lookahead and have their own
						// Firebase user record (__ai_caveman_N__) so the
						// leaderboard tracks each independently.
						// Time budgets are per-move caps; iterative
						// deepening returns the deepest completed depth.
						const depth = aiMode === 'caveman'
							? 6
							: parseInt(aiMode.slice('caveman_'.length), 10);
						const timeLimits = { 1: 2.0, 2: 2.0, 3: 5.0,
						                     4: 10.0, 5: 30.0, 6: 60.0 };
						options.aiColor = _aiColor;
						options.ai = new CavemanAI({
							maxDepth: depth,
							timeLimit: timeLimits[depth] || 60.0,
						});
						options.ai.pondering = _aiAuthManager
							? _aiAuthManager.enablePondering : true;
					} else if (aiMode === 'minimax') {
						// Power-user hidden option (not linked from index.html):
						// runs the legacy NN-backed minimax at 3-ply. Retained
						// so the orchestrator / arena scripts can A/B against
						// any future Caveman variant by URL.
						try {
							const model = await SigilNetJS.load(
								'static/models/sigil_net.json',
								'static/models/sigil_net.bin',
							);
							options.aiColor = _aiColor;
							options.ai = new MinimaxAI(model, {
								maxDepth: 3, timeLimit: 12.0, orderingAlpha: 1.0,
								exhaustiveRoot: true,
							});
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

					const sfnToLoad = _saveLoadedSfn || _this.importSfn || null;
					try {
						await engine.startGame(sfnToLoad);
					} catch (e) {
						alert("Failed to start game: " + e.message);
						window.location.href = './';
						return;
					}
					// Re-seed the engine's gameLog from the save so review /
					// SGN export covers the whole match, not just post-resume.
					if (_savedGameLog && Array.isArray(_savedGameLog)) {
						engine._gameLog = _savedGameLog.slice();
					}
				}

				// Mirrors engine._gameLog locally so we can include it in
				// each persisted save. The engine's gameLog is appended to
				// from inside its game loop; we listen for turn_complete to
				// stay in sync.
				let _persistedGameLog = _savedGameLog ? _savedGameLog.slice() : [];

				// Don't persist a game until the human has actually played a
				// turn — otherwise merely opening a match (or letting the AI
				// move first) would clutter the Resume list with games the
				// player never engaged with. A resumed save already cleared
				// this bar in its prior session.
				let _humanHasMoved = !!_saveLoadedSfn;

				/**
				 * Write the current game state to localStorage under _gameId
				 * so a reload returns to this position. Called from the
				 * sfn_update handler (after every turn boundary).
				 */
				function _persistCurrentGame(sfn) {
					if (!_humanHasMoved) return;
					if (!_gameId || typeof LocalSaveStore === 'undefined' || !sfn) return;
					LocalSaveStore.put(_gameId, {
						mode: aiMode ? 'single_player' : 'local_1v1',
						sfn: sfn,
						aiMode: aiMode || null,
						variant: gameVariant,
						humanColor: aiMode ? _humanColor : null,
						gameLog: _persistedGameLog,
					});
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
						_persistCurrentGame(rest.sfn);
						return;
					}

					if (type === 'boardstate') {
						handleBoardStateEvent(rest);
						if (_this.devEvalEnabled) {
							_this._recomputeDevEval().catch(() => {});
						}
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
						if (t) _persistedGameLog.push(t);
						// First human turn unlocks persistence. In local 1v1
						// both colors are human; vs AI only the human's color
						// counts. sfn_update fires before turn_complete, so the
						// human's own move wasn't saved yet — persist it now.
						if (t && !_humanHasMoved && (!aiMode || t.color === _this.myColor)) {
							_humanHasMoved = true;
							_persistCurrentGame(_this.currentSfn);
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
						const { sourceNode, ...targets } = rest;
						_this.pushSourceNode = sourceNode || '';
						handleValidMovesEvent(targets);
						return;
					}

					if (type === 'game_over') {
						if (_gameId && typeof LocalSaveStore !== 'undefined') {
							LocalSaveStore.remove(_gameId);
						}
						handleGameOverEvent(rest);
						return;
					}

					if (type === 'ai_think_report') {
						handleAiThinkReportEvent(rest);
						return;
					}

					if (type === 'ai_thinking_start') {
						_this.aiThinking = true;
						_this.aiThinkingColor = rest.color || '';
						_this.aiThinkingDepth = 0;
						_this.aiThinkingTimeMs = 0;
						_this.aiThinkingNodes = 0;
						return;
					}

					if (type === 'ai_thinking_progress') {
						_this.aiThinking = true;
						if (rest.color) _this.aiThinkingColor = rest.color;
						if (typeof rest.depth === 'number') _this.aiThinkingDepth = rest.depth;
						if (typeof rest.timeMs === 'number') _this.aiThinkingTimeMs = rest.timeMs;
						if (typeof rest.nodes === 'number') _this.aiThinkingNodes = rest.nodes;
						return;
					}

					if (type === 'ai_thinking_end') {
						_this.aiThinking = false;
						return;
					}
				}

				function handleAiThinkReportEvent(payload) {
					if (!_aiAuthManager || !_aiAuthManager.showAiThinkReport) return;
					const c = payload.color ? payload.color[0].toUpperCase() + payload.color.slice(1) : 'AI';
					const seconds = ((payload.timeMs || 0) / 1000).toFixed(1);
					// The search returns its evaluation from the moving AI's
					// perspective (positive = the AI is favored). Large magnitudes
					// (±100) are the forced win/loss sentinels. The leaf eval is
					// (stone difference)/39, so multiplying by 39 recovers the raw
					// stone-count lead: +1 = ahead by one stone, matching the
					// game-review scale (…-2, -1, 0, +1, +2, win/loss).
					let evalStr = '';
					if (typeof payload.score === 'number' && isFinite(payload.score)) {
						const s = payload.score;
						let shown;
						if (Math.abs(s) >= 99) {
							shown = s > 0 ? 'win' : 'loss';
						} else {
							const stones = Math.round(s * 39);
							shown = (stones > 0 ? '+' : '') + stones;
						}
						evalStr = `, eval ${shown}`;
					}
					_this.messageHistory.push(`${c} AI: depth ${payload.depth || 0}, ${seconds}s, ${payload.nodes || 0} nodes${evalStr}`);
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
					_this.pushSourceNode = '';
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

					// Cache the spell list for "Play Again (Same Layout)" regardless of
					// whether a game log was produced.
					if (_engineRef && _engineRef.board && _engineRef.board.spellNames) {
						_this._spellNamesForExport = _engineRef.board.spellNames.slice();
					}

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

					if (typeof processEloClientSide !== 'function' || typeof OfflineGameQueue === 'undefined') {
						_this.messageHistory.push('Rating update unavailable.');
						return;
					}

					// Only the unofficial Panda expansion is unrated; every other
					// expansion (and core) is rated.
					const _spellNames = _engineRef && _engineRef.board ? _engineRef.board.spellNames : [];
					const _isPandaGame = _spellNames.some(s => isPandaSpell(s));

					try {
						const db = firebase.database();
						const aiUid = '__ai_' + difficulty + '__';
						const humanUid = _aiAuthManager.uid;

						// Try to bootstrap the human's profile, but don't block on it —
						// if we're offline, the queue will retry later.
						if (navigator.onLine !== false) {
							try { await _aiAuthManager.ensureUserProfile(db); } catch (e) { /* offline; flush later */ }
						}

						const spellNamesArr = _engineRef && _engineRef.board ? _engineRef.board.spellNames : ['none'];
						const gameTurns = _engineRef ? _engineRef._gameLog : [];
						const aiLabel = _aiAuthManager && _aiAuthManager.userProfile && _aiAuthManager.userProfile.displayName;
						const humanName = aiLabel || _aiAuthManager.displayName || 'You';
						const aiName = _aiNameFor(difficulty);
						// Variant the engine actually played under (read from the
						// live board so we don't drift from the URL query param
						// in edge cases like rematch/reconnect).
						const recordVariant = normalizeVariant(_engineRef && _engineRef.board && _engineRef.board.variant);
						const _isDeathmatch = variantHasDeathmatch(recordVariant);
						const _unrated = _isPandaGame || _isDeathmatch;

						// Synthesize a /rooms entry so the game is replayable from the
						// profile page via multiplayer.html?id=CODE.
						const roomCode = _generateLocalRoomCode();
						_this._roomCodeForReview = roomCode;
						const roomRecord = {
							spellNames: spellNamesArr,
							status: 'finished',
							created: Date.now(),
							finishedAt: Date.now(),
							red: { connected: false, uid: _humanColor === 'red' ? humanUid : aiUid, displayName: _humanColor === 'red' ? humanName : aiName },
							blue: { connected: false, uid: _humanColor === 'blue' ? humanUid : aiUid, displayName: _humanColor === 'blue' ? humanName : aiName },
							ranked: !_unrated,
							winner: winner,
							gameLog: gameTurns,
							allowSpectators: true,
							timeControl: { type: 'none' },
							variant: recordVariant,
						};

						const gameRecord = {
							spellNames: spellNamesArr,
							winner: winner,
							turns: gameTurns,
							timestamp: Date.now(),
							roomCode: roomCode,
							redUid: _humanColor === 'red' ? humanUid : aiUid,
							blueUid: _humanColor === 'blue' ? humanUid : aiUid,
							ranked: !_unrated,
							variant: recordVariant,
						};

						// Attach any annotations the human made during the game.
						if (_this.annotations && Object.keys(_this.annotations).length > 0) {
							gameRecord.annotations = Object.assign({}, _this.annotations);
						}
						if (_this.evalAnnotations && Object.keys(_this.evalAnnotations).length > 0) {
							gameRecord.eval_annotations = Object.assign({}, _this.evalAnnotations);
						}

						// Persist the game to localStorage first so a crash or close
						// during upload never loses the result. The flush is then
						// best-effort: if we're offline, it just stays queued.
						const queuedId = OfflineGameQueue.enqueue({
							roomCode: roomCode,
							roomRecord: roomRecord,
							gameRecord: gameRecord,
							aiUid: aiUid,
							aiName: aiName,
							difficulty: difficulty,
						});

						if (_isDeathmatch) {
							_this.messageHistory.push('Unrated: Deathmatch games do not affect rating.');
						} else if (_isPandaGame) {
							_this.messageHistory.push('Unrated: Panda expansion games do not affect rating.');
						}

						const flushResult = await OfflineGameQueue.flushAll(db, processEloClientSide);
						const mine = flushResult.results.find((r) => r.id === queuedId);
						const stillQueued = OfflineGameQueue.peek().some((it) => it.id === queuedId);
						if (stillQueued) {
							if (navigator.onLine === false) {
								_this.messageHistory.push('Offline — game saved. Rating will sync when you reconnect.');
							} else {
								_this.messageHistory.push('Upload failed; will retry automatically.');
							}
							return;
						}

						if (!_unrated && mine && mine.eloResult) {
							const result = mine.eloResult;
							const youWon = winner === _humanColor;
							const sign = youWon ? '+' : '-';
							_this.messageHistory.push('Rating: ' + sign + result.points + ' (' + (youWon ? result.newWinnerElo : result.newLoserElo) + ')');
						}

						// If older offline games rode along on this flush, note that.
						const olderUploaded = flushResult.results.filter((r) => r.id !== queuedId && r.ok).length;
						if (olderUploaded > 0) {
							_this.messageHistory.push('Synced ' + olderUploaded + ' earlier offline game' + (olderUploaded === 1 ? '' : 's') + '.');
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
						hard: 'AI (Hard)',
						very_hard: 'AI (Very Hard)',
						minimax: 'AI (Minimax 3-ply)',
						caveman: 'AI (Caveman)',
						caveman_1: 'Caveman 1',
						caveman_2: 'Caveman 2',
						caveman_3: 'Caveman 3',
						caveman_4: 'Caveman 4',
						caveman_5: 'Caveman 5',
						caveman_6: 'Caveman 6',
					};
					return labels[difficulty] || ('AI (' + difficulty + ')');
				}

				function _generateLocalRoomCode() {
					const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
					let code = '';
					for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
					return code;
				}

			},
		})
	);
});
