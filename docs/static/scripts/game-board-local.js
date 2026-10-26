document.addEventListener('alpine:init', () => {
	const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
	let warnBeforeUnload = !isSafari;
	window.onbeforeunload = () => (warnBeforeUnload ? true : null);

	Alpine.data(
		'gameBoard',
		({ importSfn: initialImportSfn = '', puzzle = null, tutorial = null, analysis = false }) => ({
			actionList: [],
			// Tutorial page (tutorial.html): { lessons: [...] }, each lesson a
			// start position and the expected input tokens. See _tutorialAccept.
			tutorial: tutorial,
			tutorialIndex: (tutorial && tutorial.start) || 0,
			tutorialStep: 0,
			tutorialStatus: tutorial ? 'playing' : '', // playing | done
			tutorialHint: '',                        // shown after a wrong move
			tutorialTargets: {},                     // nodes the current step wants (gold rings)
			tutorialTargetAction: '',                // spell / 'dash' / 'pass' the current step wants
			tutorialDone: {},                        // lesson id -> timestamp (localStorage)
			get tutorialLesson() {
				return this.tutorial ? this.tutorial.lessons[this.tutorialIndex] : null;
			},
			// Puzzles page (puzzles.html): the position, the set of winning
			// first turns (by resulting position) and, for mate-in-2, the
			// scripted defence per winning first turn. See _puzzleOnTurn.
			puzzle: puzzle,
			puzzleStatus: puzzle ? 'playing' : '',   // playing | solved | failed | revealed
			puzzleStep: 0,                           // solver turns completed
			puzzleMessage: '',
			puzzleDiagnostic: '',                    // engine/live-rules disagreement, if any
			puzzleJudge: '',                         // last engine verdict on an off-line move
			puzzleSolutionNodes: {},                 // nodes of the revealed solution's first turn (gold rings)
			puzzleMoves: 0,                          // mover turns played so far
			puzzleSolutionText: [],
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
			aiThinkingBudgetMs: 0,
			aiClockMs: null,

			// Game clock (GameClock): both sides' remaining ms, the running side.
			hasClock: false,
			clockLabel: '',
			redClockMs: 0,
			blueClockMs: 0,
			clockActive: '',

			nodes: Object.fromEntries(boardLayoutDef('core').nodeOrder.map(n => [n, null])),
			// Board layout state + applyBoardLayout / nodeStyle / slotStyle /
			// scoreStyle (board-geometry.js).
			...boardLayoutMixin(),
			nodesToRefill: {},
			playerToRefill: '',
			previousBoardState: {},
			redSpellCounter: 0,
			redLock: '',
			// Providence bank sizes (badge beside the dice).
			redBank: 0,
			blueBank: 0,
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
			// Import Position's opponent: '' = Local 1v1, an AI tier, or 'online'.
			importOpponent: '',
			// The side picker of a game vs AI from a position (position-rating.js):
			// { loading, evalText, oddsText, payoffs: {red, blue} | null, note }.
			sideOffer: null,
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
				// Legacy v1 JSON export (SFN-per-turn blob).
				let payload = null;
				try { payload = JSON.parse(text); } catch (e) { payload = null; }
				const isLegacy = payload && payload.type === 'sigil-game' && Array.isArray(payload.sfns);
				const isSgn = !isLegacy && typeof isSgnText === 'function' && isSgnText(text);
				if (!isLegacy && !isSgn) {
					alert('Not a Sigil game export.');
					return;
				}
				try {
					sessionStorage.setItem('sigil_import_game', text);
					window.location.href = window.location.pathname + '?review=session';
				} catch (e) {
					// sessionStorage unavailable — load in-place as fallback
					if (isLegacy) this._loadReviewFromPayload(payload);
					else this._loadSgnForReview(text);
				}
			},

			/**
			 * Import an SGN-T transcript: replay it through the engine to
			 * rebuild per-ply positions, then hand the same payload shape to
			 * _loadReviewFromPayload. Providence schedules and every other
			 * derived state fall out of the replay — nothing is stored.
			 * Falls back to a final-position-only view when the transcript
			 * can't be replayed by the current engine version.
			 */
			async _loadSgnForReview(text) {
				const parsed = parseSgn(text);
				const h = parsed.headers || {};
				if (h.Format !== 'transcript-v1') {
					alert('This SGN file is not a replayable transcript export.');
					return;
				}
				const spellNames = normalizeSpellNames((h.Spells || '').split(','));
				const variant = normalizeVariant(h.Variant || 'standard');
				let fatLog = null;
				try {
					fatLog = await reconstructGameLog(spellNames, variant, h.Setup || null, parsed.turns);
					const last = fatLog.length ? fatLog[fatLog.length - 1].sfnAfter : (h.Setup || null);
					if (h.FinalSfn && last !== normalizeSfnString(h.FinalSfn)) {
						throw new Error('replayed final position does not match FinalSfn');
					}
				} catch (e) {
					console.warn('Transcript replay failed:', e);
					if (h.FinalSfn) {
						this._loadReviewFromPayload({
							spellNames,
							winner: h.Result && h.Result !== '*' ? h.Result : '',
							redName: h.Red || 'Red', blueName: h.Blue || 'Blue',
							sfns: [h.FinalSfn], turnLabels: ['Final position'],
							annotations: _sgnHeaderToAnnotations(h.Annotations),
						});
						this.messageHistory.push("Couldn't replay this game with the current engine version — showing the final position only.");
					} else {
						alert('Could not replay this game export.');
					}
					return;
				}
				const sfns = [fatLog.length ? fatLog[0].sfnBefore : (h.Setup || '')];
				const labels = ['Start'];
				for (const turn of fatLog) {
					sfns.push(turn.sfnAfter);
					const colorName = turn.color[0].toUpperCase() + turn.color.slice(1);
					const turnNum = turn.color === 'red'
						? Math.floor(turn.turnNumber / 2) + 1
						: Math.floor(turn.turnNumber / 2);
					labels.push(colorName + ' ' + turnNum);
				}
				this._gameLogForExport = fatLog;
				this.evalAnnotations = _sgnHeaderToAnnotations(h.Evals);
				this._loadReviewFromPayload({
					spellNames,
					winner: h.Result && h.Result !== '*' ? h.Result : '',
					redName: h.Red || 'Red', blueName: h.Blue || 'Blue',
					sfns, turnLabels: labels,
					annotations: _sgnHeaderToAnnotations(h.Annotations),
				});
			},

			_loadReviewFromPayload(payload) {
				const spellNames = payload.spellNames || [];
				// The board layout follows the recorded position (a pentagon
				// SFN names its layout), else the spell count.
				let layout = boardLayoutForSpellCount(spellNames.length);
				try { if (payload.sfns && payload.sfns[0]) layout = sfnToDict(payload.sfns[0]).layout; } catch (e) { /* keep */ }
				this.applyBoardLayout(layout);
				const posNames = spellSlotNames();
				const dict = {};
				const images = {};
				const text = {};
				for (let i = 0; i < posNames.length && i < spellNames.length; i++) {
					const name = spellNames[i];
					dict[posNames[i]] = name;
					images[posNames[i]] = 'static/images/spells/' + baseSpellName(name) + '.png';
					text[posNames[i]] = {
						name: displaySpellName(name),
						text: (typeof SPELL_TEXTS !== 'undefined' && SPELL_TEXTS[name]) || '',
					};
				}
				this.spellDict = dict;
				this.spells.images = images;
				this.spells.text = text;
				this.reviewSfns = payload.sfns.slice();
				this.reviewTurnLabels = (payload.turnLabels || []).slice();
				// A legacy v1 export carries its per-turn log (`gameLog`): keep it so
				// the AI review can run (it needs each turn's sfnBefore/sfnAfter).
				if (Array.isArray(payload.gameLog) && payload.gameLog.length
					&& payload.gameLog.every(t => t && t.sfnBefore && t.sfnAfter)) {
					this._gameLogForExport = payload.gameLog;
				}
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
				const log = this._gameLogForExport || [];
				// SGN-T needs a replayable transcript: every turn carries its
				// action list. Games imported from legacy v1 blobs (no
				// actions) re-export in the legacy JSON format instead.
				const replayable = log.length > 0
					&& log.every(t => Array.isArray(t.actions));
				let text;
				if (replayable) {
					const spellNames = this._spellNamesForExport || [];
					const finalSfn = log[log.length - 1].sfnAfter;
					let variant = 'standard';
					try { variant = sfnToDict(finalSfn).variant || 'standard'; } catch (e) { /* default */ }
					// Emit [Setup] only when the game did NOT start from the
					// standard initial position (i.e. an imported-SFN game).
					let setupSfn = null;
					try {
						const fresh = new SigilBoard(spellNames.slice(), variant);
						fresh.setupInitial();
						if (log[0].sfnBefore && log[0].sfnBefore !== boardToSfn(fresh)) {
							setupSfn = log[0].sfnBefore;
						}
					} catch (e) { setupSfn = log[0].sfnBefore || null; }
					text = gameToSgn({
						red: this._redNameForExport,
						blue: this._blueNameForExport,
						result: this.winner || '*',
						spellNames,
						variant,
						setupSfn,
						finalSfn,
						annotations: this.annotations || {},
						evalAnnotations: this.evalAnnotations || {},
					}, log);
				} else {
					// Legacy fallback (v1 JSON blob).
					text = JSON.stringify({
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
					});
				}
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

			// AI evaluation overlay (available to developers and to anyone who
			// enables the showAiEval account setting). Runs the same Caveman
			// search the live AI and game review use (via the shared Web
			// Worker, ~1s/position) and shows its score from red's POV.
			// Superseded searches are cancelled so rapid board changes don't
			// pile up; the forced-win sentinel (±CAVEMAN_WIN) is clamped to the
			// display band.
			// Engine handle for the debug readouts below. Assigned in
			// initEngine() alongside the init()-local _engineRef, which object
			// methods cannot see (it lives in init()'s scope).
			_engine: null,
			isDeveloper: false,
			showAiEval: false,
			get canSeeAiEval() {
				return this.isDeveloper || this.showAiEval;
			},
			devEvalEnabled: false,
			devEvalValue: null,
			devEvalLoading: false,
			_devEvalSeq: 0,
			_devEvalSearchId: null,
			async toggleDevEval() {
				if (!this.canSeeAiEval) return;
				this.devEvalEnabled = !this.devEvalEnabled;
				if (this.devEvalEnabled) {
					await this._recomputeDevEval();
				} else {
					this.devEvalValue = null;
				}
			},
			async _recomputeDevEval() {
				if (!this.devEvalEnabled || !this.canSeeAiEval) return;
				if (!this._engine || !this._engine.board) return;
				if (typeof boardToSfn !== 'function') return;
				const board = this._engine.board;
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

			// Map-control readout: how many nodes each side's stones are
			// strictly closer to (multi-source BFS; Fissure walls impassable
			// and excluded — see features.js mapControl). Cheap and
			// synchronous, so it recomputes on every board change and on
			// review navigation, with no toggle or worker. Available to
			// developers and to anyone with the showMapControl account
			// setting.
			showMapControl: false,
			get canSeeMapControl() {
				return this.isDeveloper || this.showMapControl;
			},
			mapControl: null,
			_recomputeMapControl(stonesOverride) {
				if (!this.canSeeMapControl) { this.mapControl = null; return; }
				if (typeof mapControl !== 'function') return;
				let stones = stonesOverride;
				if (!stones) {
					if (!this._engine || !this._engine.board) return;
					stones = this._engine.board.stones;
				}
				this.mapControl = mapControl(stones);
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
				if (this.spellTooltip && this.spellTooltip.destroy) this.spellTooltip.destroy();
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
				// Each rematch is a new game: drop the persistence id so it
				// mints a fresh one instead of reusing the finished game's slot.
				params.delete('id');
				if (this.aiMode) {
					params.set('ai', this.aiMode);
				}
				if (this.gameVariant && this.gameVariant !== 'standard') {
					params.set('variant', this.gameVariant);
				}
				if (this.clockOpt && typeof GameClock !== 'undefined') {
					const lbl = GameClock.label(this.clockOpt);
					if (lbl) params.set('clock', lbl);
				}
				const qs = params.toString();
				window.location.href = window.location.pathname + (qs ? '?' + qs : '');
			},

			playAgainSameLayout() {
				this._rematchWithHumanColor(this.myColor);
			},

			playAgainSameLayoutSwap() {
				// Same spell layout, but human swaps sides with the AI.
				this._rematchWithHumanColor(this.myColor === 'red' ? 'blue' : 'red');
			},

			// Pin the human's side for the next game (relative to the game
			// just finished — otherwise it falls back to a random draw) and
			// reload with the same nine spells.
			_rematchWithHumanColor(color) {
				if (this.isAiGame && (color === 'red' || color === 'blue')) {
					try {
						sessionStorage.setItem('sigil_rematch_human_color', color);
					} catch (e) { /* sessionStorage blocked */ }
				}
				const spells = this._spellNamesForExport;
				if (spells && spells.length === BOARD.positionCount) {
					try {
						sessionStorage.setItem('sigil_rematch_spells', JSON.stringify(spells));
					} catch (e) { /* sessionStorage blocked */ }
				}
				this.playAgain();
			},

			// Rematch from the reviewed position: a fresh game seeded with the
			// cursored ply's SFN (which carries the spells, side to move and
			// variant), same opponent tier and clock, human on the same side.
			// The final position of a decided game has nothing left to play.
			get canRematchFromPosition() {
				if (!this.reviewMode || this.puzzle) return false;
				if (!this.reviewSfns[this.reviewIndex]) return false;
				return !(this.winner && this.reviewIndex >= this.reviewSfns.length - 1);
			},

			rematchFromPosition() {
				if (!this.canRematchFromPosition || this.reviewReplaying) return;
				this.reviewAutoplay = false;
				// Position 0 is a pre-turn SFN; the rest are after-turn SFNs.
				const sfn = typeof rematchSfnAt === 'function'
					? rematchSfnAt(this.reviewSfns, this.reviewIndex) : this.reviewSfns[this.reviewIndex];
				// The side is chosen in the next game's side picker, priced
				// from the engine's eval; hand over the review's eval of this
				// position when it is deep enough to use, and the history
				// (threefold repetition counts earlier positions).
				try {
					// The review's eval saw the game's earlier positions (repetition);
					// the new game starts without them, so a repeated position is
					// re-searched fresh instead.
					const earlier = this.reviewSfns.slice(0, this.reviewIndex);
					const info = (typeof reviewPositionEval === 'function' && !positionRepeats(sfn, earlier))
						? reviewPositionEval(this.aiReview, this.reviewIndex) : null;
					sessionStorage.setItem('sigil_rematch_startpos', JSON.stringify({
						sfn, info: info,
					}));
				} catch (e) { /* sessionStorage blocked */ }
				warnBeforeUnload = false;
				const params = new URLSearchParams(window.location.search);
				params.delete('review');
				// A new game: mint a fresh persistence id (see playAgain).
				params.delete('id');
				params.set('sfn', sfn);
				// The SFN's variant is authoritative (an imported game's URL
				// may not name one); the page reads its rules from ?variant.
				let variant = 'standard';
				try { variant = sfnToDict(sfn).variant || 'standard'; } catch (e) { /* default */ }
				if (variant === 'standard') params.delete('variant');
				else params.set('variant', variant);
				window.location.href = window.location.pathname + '?' + params.toString();
			},

			// The side picker's buttons ('red' | 'blue' | 'random').
			chooseSide(side) {
				if (!this.sideOffer || this.sideOffer.loading || !this._sideOfferResolve) return;
				const resolve = this._sideOfferResolve;
				this._sideOfferResolve = null;
				resolve(side);
			},

			// Import Position: start the pasted SFN against the chosen
			// opponent (Local 1v1, an AI tier, or a new online room).
			importPosition() {
				const sfn = this.importSfn.trim();
				if (!sfn) return;
				if (this.importOpponent === 'online') {
					window.location.href = 'multiplayer.html?sfn=' + encodeURIComponent(sfn);
					return;
				}
				const ai = this.importOpponent ? '&ai=' + encodeURIComponent(this.importOpponent) : '';
				window.location.href = '?sfn=' + encodeURIComponent(sfn) + ai;
			},

			// Review: open an online room from the reviewed position.
			playOnlineFromPosition() {
				if (!this.canRematchFromPosition || this.reviewReplaying) return;
				// Position 0 is a pre-turn SFN; the rest are after-turn SFNs.
				const sfn = typeof rematchSfnAt === 'function'
					? rematchSfnAt(this.reviewSfns, this.reviewIndex) : this.reviewSfns[this.reviewIndex];
				try {
					// The review's eval saw the game's earlier positions (repetition);
					// the new game starts without them, so a repeated position is
					// re-searched fresh instead.
					const earlier = this.reviewSfns.slice(0, this.reviewIndex);
					const info = (typeof reviewPositionEval === 'function' && !positionRepeats(sfn, earlier))
						? reviewPositionEval(this.aiReview, this.reviewIndex) : null;
					sessionStorage.setItem('sigil_rematch_startpos', JSON.stringify({
						sfn, info: info,
					}));
				} catch (e) { /* sessionStorage blocked */ }
				warnBeforeUnload = false;
				window.location.href = 'multiplayer.html?sfn=' + encodeURIComponent(sfn);
			},

			rematchStage: 'idle',  // 'idle' | 'rematch'
			isAiGame: !!new URLSearchParams(window.location.search).get('ai'),
			aiMode: new URLSearchParams(window.location.search).get('ai') || null,
			gameVariant: 'standard',
			clockOpt: null,

			openRematchMenu() {
				this.rematchStage = this.rematchStage === 'rematch' ? 'idle' : 'rematch';
			},

			// True while one turn's animated replay is in flight. Guards every
			// navigation entry point (buttons are also disabled, but arrow keys
			// and the eval-chart click bypass the disabled attribute).
			reviewReplaying: false,
			// True while the whole-game playthrough is running; clearing it
			// stops the playthrough after the turn currently animating.
			reviewAutoplay: false,

			// Animated replay needs the action transcripts; legacy v1 imports
			// carry only per-turn SFNs and fall back to instant state flips.
			get reviewCanReplay() {
				const log = this._gameLogForExport;
				return !!(log && log.length && typeof this._animateReviewTurn === 'function');
			},

			reviewPrev() {
				if (this.reviewReplaying) return;
				this.reviewAutoplay = false;
				if (this.reviewIndex > 0) {
					this.reviewIndex--;
					this._showReviewPosition();
				}
			},

			// Stepping FORWARD animates the turn exactly as it played live —
			// the transcript replays through the real engine, emitting the same
			// animation events — then snaps to the stored after-state. Falls
			// back to the instant flip when no transcript exists for the turn.
			async reviewNext() {
				if (this.reviewReplaying) return;
				if (this.reviewIndex >= this.reviewSfns.length - 1) return;
				const i = this.reviewIndex;
				if (this.reviewCanReplay) {
					this.reviewReplaying = true;
					try {
						await this._animateReviewTurn(i);
					} catch (e) {
						console.warn('Animated replay failed; showing stored position:', e);
					} finally {
						this.reviewReplaying = false;
					}
				}
				this.reviewIndex = i + 1;
				this._showReviewPosition();
			},

			// Whole-game playthrough: animate turn after turn from the current
			// position (from the start when already at the end). Toggling again
			// pauses after the turn currently animating.
			async toggleReviewAutoplay() {
				if (this.reviewAutoplay) { this.reviewAutoplay = false; return; }
				if (this.reviewReplaying) return;
				if (this.reviewIndex >= this.reviewSfns.length - 1) {
					this.reviewIndex = 0;
					this._showReviewPosition();
				}
				this.reviewAutoplay = true;
				try {
					while (this.reviewAutoplay && this.reviewIndex < this.reviewSfns.length - 1) {
						await this.reviewNext();
						// A beat between turns, mirroring the live game's rhythm.
						if (this.reviewAutoplay) await new Promise(r => setTimeout(r, 700));
					}
				} finally {
					this.reviewAutoplay = false;
				}
			},

			reviewFirst() {
				if (this.reviewReplaying) return;
				this.reviewAutoplay = false;
				this.reviewIndex = 0;
				this._showReviewPosition();
			},

			reviewLast() {
				if (this.reviewReplaying) return;
				this.reviewAutoplay = false;
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},

			exitReview() {
				if (this.reviewReplaying) return;
				this.reviewAutoplay = false;
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
				this.redBank = state.red_bank || 0;
				this.blueBank = state.blue_bank || 0;
				this.redLock = state.red_lock || '';
				this.blueLock = state.blue_lock || '';
				this.score = state.score || 'unset';
				this.validMoves = {};
				this.pushSourceNode = '';
				this.lastPlay = '';
				// Review navigation bypasses boardstate events, so refresh the
				// map-control readout from the displayed position directly.
				this._recomputeMapControl(state.stones);
			},

			handleCastSpell(spell) {
				this.sendEvent(this.spellDict[spell]);
				this.closeSpellTooltip();
			},

			handleDash() {
				this.sendEvent('dash');
				this.actionList = [];
			},

			handleSkipProvidence() {
				this.sendEvent('skip_providence');
				this.actionList = [];
			},

			// Armed by a first End Turn when "Confirm before ending a turn"
			// is on (confirmEndTurn, game-keys.js).
			endTurnArmed: false,
			_endTurnTimer: null,
			handleEndTurn() {
				if (!confirmEndTurn(this)) return;
				this.sendEvent('pass');
				this.actionList = [];
			},

			nodeLabel(node) {
				return nodeAriaLabel(this, node);
			},

			handleSubmit() {
				this.sendEvent('submit');
				this.actionList = [];
			},

			// Two-click forfeit: the first click arms the button (it relabels to
			// ask for confirmation), the second concedes. Arming decays on its
			// own so a stray first click can't leave a live one-click forfeit
			// sitting under the cursor.
			forfeitArmed: false,
			_forfeitTimer: null,
			handleForfeit() {
				if (!this.forfeitArmed) {
					this.forfeitArmed = true;
					clearTimeout(this._forfeitTimer);
					this._forfeitTimer = setTimeout(() => { this.forfeitArmed = false; }, 5000);
					return;
				}
				clearTimeout(this._forfeitTimer);
				this.forfeitArmed = false;
				this.sendEvent('forfeit');
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
					// A short grace lets the pointer reach the tooltip's
					// "More about this spell" link (holdSpellTooltip).
					clearTimeout(this._spellTooltipTimer);
					this._spellTooltipTimer = setTimeout(() => {
						this.activeSpell = '';
						if (this.spellTooltip.destroy) {
							this.spellTooltip.destroy();
						}
					}, 250);
				}
			},

			handleSpellMouseOver(spell) {
				if (!this.hasTouchScreen) {
					clearTimeout(this._spellTooltipTimer);
					this.showSpellTooltip(spell);
				}
			},

			holdSpellTooltip() {
				clearTimeout(this._spellTooltipTimer);
			},

			// Keyboard: the tooltip stays open while focus moves from the spell
			// into it (its "More about this spell" link), and closes when focus
			// leaves both. A mouse press on the link moves focus there too, so
			// the tooltip is still open when the click lands.
			handleSpellBlur(e) {
				const tip = this.$refs.spellTooltip;
				if (e && e.relatedTarget && tip && tip.contains(e.relatedTarget)) return;
				this.closeSpellTooltip();
			},
			handleTooltipFocusOut(e) {
				const to = e && e.relatedTarget;
				const tip = this.$refs.spellTooltip;
				if (to && ((tip && tip.contains(to)) || (to.closest && to.closest('img.spell')))) return;
				this.closeSpellTooltip();
			},

			handleReset() {
				this.endTurnArmed = false;
				this.sendEvent('reset');
				this.actionList = [];
				this.lastPlay = '';
				this.nodesToRefill = {};
				this.playerToRefill = '';
				this.showReset = false;
				this.validMoves = {};
				this.pushSourceNode = '';
				drawPushArrows(this.$refs.pushArrows, []);
			},

			handleNodeClick(node) {
				this.currentPlayer = this.whoseTurn;

				if (this.awaiting === 'node') {
					this.sendEvent(node);
				} else if (this.awaiting === 'action') {
					if (this.actionList.includes('move') || this.actionList.includes('providence')) {
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

				// A new prompt (Reset Turn, a cast) cancels an armed End Turn.
				_this.$watch('actionList', () => { _this.endTurnArmed = false; });

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
						} catch (e) { /* not JSON — try SGN-T below */ }
						if (typeof isSgnText === 'function' && isSgnText(raw)) {
							warnBeforeUnload = false;
							_this._loadSgnForReview(raw);
							_this.sendEvent = function() {};
							return;
						}
						console.error('Bad review payload (neither v1 JSON nor SGN).');
					}
				}

				// --- Local engine instead of WebSocket ---
				// Puzzle mode: no AI tier (so no rating, no completed_games
				// record, no offline queue), no local save, the human plays
				// the puzzle's mover and a scripted opponent plays the stored
				// defence. `aiMode` stays null on purpose: every persistence
				// path below is keyed on it. The tutorial (tutorial.html) is
				// scripted the same way: see the Tutorial section below. The analysis
				// board (analysis.html) is the same no-AI, no-save local game,
				// restarted at whichever tree node is selected (analysis-board.js).
				const scripted = puzzle || tutorial;
				let aiMode = (scripted || analysis) ? null : new URLSearchParams(window.location.search).get('ai');
				// Game clock, any mode: ?clock=M+S (minutes + seconds per move).
				// A saved clocked game restores its remaining times below.
				let clockOpt = (scripted || analysis || typeof GameClock === 'undefined') ? null
					: GameClock.parse(new URLSearchParams(window.location.search).get('clock'));
				let _savedClockState = null;
				// Game-rule variant (separate concept from `aiMode`'s "model
				// variant" naming below): 'standard' or 'competitive'.
				const gameVariantParam = scripted ? (scripted.variant || 'standard')
					: new URLSearchParams(window.location.search).get('variant');
				let gameVariant = normalizeVariant(gameVariantParam);
				// The position this page was opened on (?sfn=). Captured now:
				// importSfn is bound to the Import Position box.
				const _startSfnAtLoad = (scripted || analysis) ? '' : (_this.importSfn || '');
				// An imported SFN names its own layout (a pentagon stone field).
				// An imported position names its own variant and spells; the AI
				// hand-off below reads them (a pasted SFN's URL names neither).
				let _importUnsupported = false;
				if (_this.importSfn) {
					try {
						const _imp = sfnToDict(_this.importSfn);
						if (_imp.variant && _imp.variant !== 'standard') gameVariant = normalizeVariant(_imp.variant);
						if (_imp.layout === 'pentagon' && !variantHasPentagon(gameVariant)) {
							gameVariant = normalizeVariant(gameVariant + '_pentagon');
						}
						// Spells the Rust engine does not play (Panda, Experimental).
						_importUnsupported = (_imp.spell_names || []).some(n => isUnratedSpell(n));
					} catch (e) { /* bad SFN: the engine reports it */ }
				}
				let _engineRef = null;
				if (scripted || analysis) warnBeforeUnload = false;

				// Persistence: pin a game-id to the URL (mint one if missing)
				// so a reload returns to the same game. If a save exists for
				// the id, hydrate aiMode / variant / humanColor / SFN from it
				// — these win over the URL so resume works even if the user
				// lands on /game.html?id=X without other params.
				if (!scripted && !analysis && typeof LocalSaveStore !== 'undefined') LocalSaveStore.purgeExpired();
				let _gameId = (scripted || analysis) ? null : new URLSearchParams(window.location.search).get('id');
				if (!scripted && !analysis && !_gameId && typeof LocalSaveStore !== 'undefined') {
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
				// First turn's pre-turn SFN — persisted so slim saved logs of
				// games that began from an imported position can be replayed.
				let _savedSetupSfn = null;
				// A game from a position (?sfn=, kept across resumes) and, when
				// it is rated, its priced start (position-rating.js).
				let _fromPosition = !!_startSfnAtLoad;
				let _startPos = null;
				// A turn was taken back (handleTakeBack): the game is unrated.
				let _tookBack = false;
				// The position the game began from (empty for a standard start),
				// kept in the save: a resumed game's URL carries only its id.
				let _startSfnForUndo = _startSfnAtLoad;
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
								// Saves may predate spell renames; normalize
								// tokens so the finished record is written
								// with current names.
								_savedGameLog = _save.gameLog.map(t => Object.assign({}, t, {
									actions: Array.isArray(t.actions)
										? t.actions.map(a => (a && a.spell)
											? Object.assign({}, a, { spell: normalizeSpellName(a.spell) })
											: (typeof a === 'string' ? normalizeSpellName(a) : a))
										: t.actions,
								}));
							}
							if (_save.clock && _save.clock.baseMs > 0 && typeof GameClock !== 'undefined') {
								clockOpt = { baseMs: _save.clock.baseMs, incMs: _save.clock.incMs | 0 };
								_savedClockState = { red: _save.clock.red, blue: _save.clock.blue };
							}
							if (_save.setupSfn) {
								_savedSetupSfn = _save.setupSfn;
							}
							if (_save.fromPosition) _fromPosition = true;
							if (_save.tookBack) _tookBack = true;
							if (typeof _save.startSfn === 'string') _startSfnForUndo = _save.startSfn;
							if (_save.startPos && typeof _save.startPos.redWinProb === 'number') {
								_startPos = _save.startPos;
							}
						} else {
							LocalSaveStore.remove(_gameId);
						}
					}
				}

				_this.aiMode = aiMode || null;
				_this.isAiGame = !scripted && !!aiMode;
				_this.gameVariant = gameVariant;
				_this.clockOpt = clockOpt;

				if (!scripted && !analysis) {
					try {
						const u = new URL(window.location.href);
						if (_gameId) u.searchParams.set('id', _gameId);
						if (aiMode) u.searchParams.set('ai', aiMode);
						if (gameVariant && gameVariant !== 'standard') u.searchParams.set('variant', gameVariant);
						if (clockOpt && typeof GameClock !== 'undefined') {
							const lbl = GameClock.label(clockOpt);
							if (lbl) u.searchParams.set('clock', lbl);
						}
						history.replaceState(null, '', u.toString());
					} catch (e) { /* ignore */ }
				}

				// Auth manager for rated AI games, the finished-game upload (vs AI
				// and local 1v1) and community annotations from AI review.
				let _aiAuthManager = null;
				if (!scripted && !analysis && typeof AuthManager !== 'undefined' && typeof firebase !== 'undefined') {
					_aiAuthManager = new AuthManager();
					_aiAuthManager.onAuthChanged(async (user) => {
						if (aiMode && user && !user.isAnonymous) {
							try {
								await _aiAuthManager.loadProfile(firebase.database());
								_this.annotationMode = !!_aiAuthManager.annotationMode;
								_this.isDeveloper = !!_aiAuthManager.isDeveloper;
								_this.showAiEval = !!_aiAuthManager.showAiEval;
								_this.showMapControl = !!_aiAuthManager.showMapControl;
								// Boardstate may have fired before auth resolved;
								// populate the readout now that gating is known.
								_this._recomputeMapControl();
								if (_engineRef && _engineRef.ai) {
									_engineRef.ai.pondering =
										(typeof _engineRef.ai.ponderEnabledFor === 'function')
											? _engineRef.ai.ponderEnabledFor(_aiAuthManager)
											: _aiAuthManager.enablePondering;
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
				if (!scripted && !analysis && typeof OfflineGameQueue !== 'undefined') {
					OfflineGameQueue.installAutoflush({
						onFlush: (result) => {
							// Filter out any game currently being finished on this board,
							// as _recordFinishedGame handles its own rating/post-game message.
							const nonLocalResults = (result.results || []).filter((r) => r.id !== _this._activeFinishingQueuedId && r.ok);
							if (nonLocalResults.length > 0) {
								const rated = nonLocalResults.filter((r) => r.eloResult && typeof r.eloResult.delta === 'number');
								if (rated.length > 0) {
									const totalDelta = rated.reduce((sum, r) => sum + r.eloResult.delta, 0);
									const sign = totalDelta >= 0 ? '+' : '';
									const latestElo = rated[rated.length - 1].eloResult.newElo;
									_this.messageHistory.push('Synced ' + nonLocalResults.length + ' offline game' + (nonLocalResults.length === 1 ? '' : 's') + '. Rating: ' + sign + totalDelta + ' (' + latestElo + ').');
								} else {
									_this.messageHistory.push('Synced ' + nonLocalResults.length + ' offline game' + (nonLocalResults.length === 1 ? '' : 's') + '.');
								}
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
				let _humanColor = puzzle ? puzzle.mover : tutorial ? 'blue'
					: (_forcedHumanColor || _savedHumanColor || (Math.random() < 0.5 ? 'blue' : 'red'));
				let _aiColor = _humanColor === 'red' ? 'blue' : 'red';
				_this.myColor = _humanColor;
				// A new game vs AI from a position: the player picks a side in
				// the side picker (below) before the engine starts.
				const _offerSides = !!(aiMode && _startSfnAtLoad && !_saveLoadedSfn);

				// "Play Again (Same Layout)" stashes the spell list in sessionStorage; pick it
				// up here on next page load and feed it into the engine so the new match
				// uses the same nine spells.
				let _rematchSpells = null;
				try {
					const raw = sessionStorage.getItem('sigil_rematch_spells');
					if (raw) {
						sessionStorage.removeItem('sigil_rematch_spells');
						const parsed = JSON.parse(raw);
						if (Array.isArray(parsed) && parsed.length === boardLayoutDef(variantBoardLayout(gameVariant)).positionCount) {
							_rematchSpells = parsed;
						}
					}
				} catch (e) { /* sessionStorage blocked or bad payload */ }

				// Activate the variant's board layout before anything draws or
				// generates spells (a resumed save's variant has been read).
				_this.applyBoardLayout(variantBoardLayout(gameVariant));

				async function initEngine() {
					let options = {};
					if (_rematchSpells) options.spellNames = _rematchSpells;
					options.variant = gameVariant;
					_this.isDeathmatch = variantHasDeathmatch(gameVariant);
					if (variantHasScramble(gameVariant) && !scripted) {
						_this.messageHistory.push('Scramble: there is no stone-lead win. The first player to cast ' + BOARD.spellTarget + ' spells wins.');
					}
					if (tutorial) {
						// The lesson is one turn of the mover's; the other side never
						// moves (its turn is dropped once the lesson is over).
						_humanColor = _tutorialLesson().mover || 'blue';
						_aiColor = _humanColor === 'red' ? 'blue' : 'red';
						_this.myColor = _humanColor;
						options.aiColor = _aiColor;
						options.ai = { pickTurn: () => new Promise(() => {}) };
					}
					if (puzzle) {
						options.aiColor = _aiColor;
						options.ai = new PuzzleOpponent(puzzle, _this, { timeMs: 6000 });
						if (typeof RustAI !== 'undefined' && RustAI.preload) RustAI.preload();
					}

					// Rust engine tiers (the wasm build in a Web Worker): per-move
					// seconds and TT size. tt_bits is memory-bound in a tab (2^20
					// entries is ~34 MB; 2^21 is ~67 MB and silently kills low-RAM
					// iOS Safari), so only the long tiers size up, and only on
					// machines that report >= 8 GB.
					//
					// rust_easy..rust_very_hard are the PICKER's Easy/Medium/Hard/
					// Very Hard: same budgets as the retired Caveman tiers they
					// replaced, distinct aiMode strings so their Elo posts to the
					// new "(Rust)" records (__ai_rust_easy__ etc.) instead of the
					// frozen "(JS)" ones. rust_quick/rust/rust_deep predate the
					// tier swap and stay reachable for old links and saved games.
					const _bigTT = (navigator.deviceMemory || 4) >= 8 ? 21 : 20;
					const _RUST_TIERS = {
						rust_easy: { time: 0.1, ttBits: 16 },
						rust_medium: { time: 1, ttBits: 18 },
						rust_hard: { time: 10, ttBits: 20 },
						rust_very_hard: { time: 60, ttBits: _bigTT },
						rust_quick: { time: 3, ttBits: 18 },
						rust: { time: 10, ttBits: 20 },
						rust_deep: { time: 30, ttBits: _bigTT },
						// (rust_anchor, a frozen 2026-09 reference tier, was removed
						// 2026-09-21: never played, and every engine change needed a
						// clause to keep it frozen.)
					};
					// RETIRED from the picker (replaced by the rust_* tiers above),
					// but still playable via direct URL and resumed saved games.
					// Their Elo keeps posting to the __ai_easy__-style records,
					// which are renamed "(JS)" in Firebase — the history stays
					// attached to the AIs that earned it.
					const _CAVEMAN_TIER_BUDGETS = {
						easy: 0.1,
						medium: 1.0,
						hard: 5.0,
						very_hard: 60.0,
					};
					// Rust tiers: decide the draw (and whether the Rust engine can host
					// it) BEFORE tier dispatch, so a hand-off to the JS engine tier
					// carries through to the AI record, saves and labels.
					//
					// The engine implements the 39 core spells plus Tectonic and
					// Providence, and keys casts and locks by spell id, resolving a
					// cast at the FIRST slot holding that id (engine/src/cast.rs). So
					// it cannot play the unofficial packs (Panda / Experimental) and
					// cannot hold two copies of one spell. Rules:
					//   1. Allow Duplicates variant -> the JS tier with the same time
					//      budget plays; the normal draw applies (repeats from the
					//      player's packs).
					//   2. Otherwise drop the unsupported packs. If what remains fills
					//      the board, the Rust engine plays it.
					//   3. If it cannot (too few packs, or nothing playable), the JS
					//      tier plays and the board is filled by REPEATING spells from
					//      the player's packs — never by switching to Core.
					const _RUST_TO_JS_TIER = {
						rust_easy: 'easy', rust_medium: 'medium', rust_hard: 'hard',
						rust_very_hard: 'very_hard', rust_quick: 'medium', rust: 'hard',
						rust_deep: 'very_hard', rust_native: 'very_hard',
					};
					const _RUST_PACKS = ['core', ...CORE_SUBPACK_KEYS, 'springtime', 'celestial', 'fury',
					                     'tempest', 'flood', 'autumn', 'gloom', 'covenant',
					                     'tectonic', 'providence'];
					// The Cataclysm pentagon board (65 nodes) is JS-engine only: the
					// Rust engine's bitboards are 64-bit and the NN models are
					// trained on the 39-node core board. Hand its Rust / NN tiers to
					// the Caveman tier with the same time budget.
					if (variantHasPentagon(gameVariant)) {
						const jsTier = _RUST_TO_JS_TIER[aiMode] || (aiMode === 'minimax' ? 'hard' : null);
						if (jsTier) {
							_this.messageHistory.push('The Cataclysm board is played by the JS engine; using the '
								+ jsTier.replace('_', ' ') + ' JS engine tier (same time budget).');
							aiMode = jsTier;
						}
					}
					if (_RUST_TO_JS_TIER[aiMode]) {
						const jsTier = _RUST_TO_JS_TIER[aiMode];
						const jsLabel = jsTier.replace('_', ' ');
						const packName = packDisplayName;
						if (variantHasDuplicates(gameVariant) || variantHasScramble(gameVariant)) {
							const vName = variantHasDuplicates(gameVariant) ? 'Allow Duplicates' : 'Scramble';
							_this.messageHistory.push('The Rust engine does not support the ' + vName + ' variant yet; '
								+ 'playing the ' + jsLabel + ' JS engine tier (same time budget) instead.');
							aiMode = jsTier;
						} else if (_importUnsupported) {
							_this.messageHistory.push('The Rust engine does not support this position\'s spells; '
								+ 'playing the ' + jsLabel + ' JS engine tier (same time budget) instead.');
							aiMode = jsTier;
						} else if (!_rematchSpells && typeof generateSpellList === 'function') {
							const chosen = readStoredExpansions();
							const playable = chosen.filter(k => _RUST_PACKS.includes(k));
							const dropped = chosen.filter(k => !_RUST_PACKS.includes(k));
							let drawn = null;
							if (playable.length) {
								try { drawn = generateSpellList(playable); } catch (e) { drawn = null; }
							}
							if (drawn) {
								options.spellNames = drawn;
								if (dropped.length) {
									_this.messageHistory.push('The Rust engine does not support ' + dropped.map(packName).join(', ')
										+ ' yet; drew from ' + playable.map(packName).join(', ') + ' only.');
								}
							} else {
								// The Rust engine cannot host this board: either nothing it
								// plays was selected, or too few playable spells remain for a
								// full board. The JS tier plays instead, from the player's own
								// packs — repeating spells (the duplicate-copy aliases) only
								// when a repeat-free draw is impossible. Never Core.
								const source = playable.length ? playable : chosen;
								let repeats = false;
								try {
									options.spellNames = generateSpellList(source);
								} catch (e) {
									options.spellNames = generateSpellList(source, true);
									repeats = true;
								}
								const minus = (playable.length && dropped.length)
									? ' (minus ' + dropped.map(packName).join(', ') + ', which the Rust engine does not support)'
									: '';
								if (repeats) {
									_this.messageHistory.push('Your selected packs' + minus
										+ ' have too few spells to fill the board without repeats; repeating spells from '
										+ source.map(packName).join(', ') + ' and playing the ' + jsLabel
										+ ' JS engine tier (same time budget) instead of the Rust engine.');
								} else {
									_this.messageHistory.push('The Rust engine does not support ' + dropped.map(packName).join(', ')
										+ ' yet; playing the ' + jsLabel + ' JS engine tier (same time budget) with your selected packs instead.');
								}
								aiMode = jsTier;
							}
						}
					}
					if (Object.prototype.hasOwnProperty.call(_CAVEMAN_TIER_BUDGETS, aiMode)) {
						options.aiColor = _aiColor;
						options.ai = new CavemanAI({
							// No depth cap — these tiers are bounded only by their
							// per-move time budget. 64 is the codebase's "time-limited
							// only" sentinel (iterative deepening never reaches it at
							// real branching factors).
							maxDepth: 64,
							timeLimit: _CAVEMAN_TIER_BUDGETS[aiMode],
						});
						options.ai.pondering = _aiAuthManager
							? _aiAuthManager.enablePondering : false;
					} else if (_RUST_TIERS[aiMode] || aiMode === 'rust_native') {
						// The Rust engine. The public tiers run its WebAssembly build in
						// a Web Worker - fully client-side, so they work on the static
						// GitHub Pages deployment. ?ai=rust_native is the unlisted dev
						// tier: the native engine through the localhost helper
						// (engine/server/serve.py) at full playtest strength. The draw
						// (and the hand-off rules) were settled above.
						options.aiColor = _aiColor;
						if (aiMode === 'rust_native') {
							options.ai = new RustAI({ transport: 'fetch', timeLimit: 60 });
						} else {
							const t = _RUST_TIERS[aiMode];
							// ?clock=5+0 / ?clock=10+1 (minutes + seconds per move):
							// the AI plays on a whole-game clock instead of the
							// tier's per-move budget (rust-ai.js allocates each move).
							const clock = clockOpt;
							options.ai = new RustAI({
								transport: 'worker', timeLimit: t.time, ttBits: t.ttBits,
								clock: clock,
								// Hard and Very Hard search on every thread the page
								// can give them (1 unless cross-origin isolated).
								threads: (t.time >= 10 || clock) ? rustThreadCount() : 1,
								// The two top tiers ponder unless the account setting
								// is explicitly off; the quick tiers follow the setting.
								ponderPolicy: (t.time >= 10 || clock) ? 'default-on' : 'setting',
							});
							// Fetch+compile the wasm during the human's first think,
							// not the AI's.
							RustAI.preload();
						}
						options.ai.pondering = (typeof options.ai.ponderEnabledFor === 'function')
							? options.ai.ponderEnabledFor(_aiAuthManager) : false;
					} else if (aiMode === 'positional') {
						// Unlisted experimental tier (?ai=positional): Hard-class
						// time budget plus the capped map-control tiebreaker from
						// the 2026-08 arena campaign (ai/ARENA_POSITIONAL_WEIGHTS.md;
						// sub-material influence, worst case 0.96 stones). Fielded
						// live to gather human-game data the arena can't provide.
						options.aiColor = _aiColor;
						options.ai = new CavemanAI({
							maxDepth: 64,
							timeLimit: 10.0,
							evalWeights: { mana: 0.0, voidPenalty: 0.0, mapControl: 0.0246 },
						});
						// Pondering stays off for this tier: ponder primes the
						// shared TT with default-weight entries (see ai-worker.js
						// caveat), which this tier's weighted searches never read.
						options.ai.pondering = false;
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
							? _aiAuthManager.enablePondering : false;
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

					options.clock = clockOpt;
					options.clockState = _savedClockState;
					const engine = new GameController(function emitEvent(eventObj) {
						// A retried puzzle abandons its previous controller
						// mid-loop (its scripted opponent never answers), so
						// events from a superseded engine are dropped.
						if (scripted && _engineRef !== engine) return;
						handleIncomingEvent(eventObj);
					}, options);
					_engineRef = engine;
					// The controller's clock is the authority; the AI only allocates from it.
					if (engine.clock && options.ai) {
						options.ai.clockSource = () => engine.clock.remainingOf(_aiColor, Date.now());
					}
					_this._engine = engine;

					_this.sendEvent = function sendEvent(message) {
						if (tutorial && !_tutorialAccept(message)) return;
						engine.handlePlayerAction(message);
						_this.awaiting = null;
					};

					const sfnToLoad = puzzle ? puzzleImportSfn(puzzle.sfn)
						: tutorial ? puzzleImportSfn(tutorialLessonSfn(_tutorialLesson()))
						: (_saveLoadedSfn || _this.importSfn || null);
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

				// Mirrors engine._gameLog locally (SLIM entries: color,
				// turnNumber, kind, actions — no per-turn SFNs) so each
				// persisted save stays small. The engine's gameLog is appended
				// to from inside its game loop; we listen for turn_complete to
				// stay in sync. Legacy fat saved entries pass through as-is.
				let _persistedGameLog = _savedGameLog ? _savedGameLog.slice() : [];
				let _setupSfn = _savedSetupSfn;

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
						setupSfn: _setupSfn,
						fromPosition: _fromPosition,
						startPos: _startPos,
						tookBack: _tookBack,
						startSfn: _startSfnForUndo,
						// Game clock: remaining ms per side at this turn boundary.
						clock: (_engineRef && _engineRef.clock) ? _engineRef.clock.snapshot(Date.now()) : null,
					});
				}

				/**
				 * Take back the player's last turn (and the AI's reply to it):
				 * rewrite the save to the position before it and reload, which
				 * resumes from there through the normal resume path. A rated
				 * game vs the AI becomes unrated.
				 */
				_this.canTakeBack = function () {
					const log = _engineRef && _engineRef._gameLog;
					if (puzzle || !_gameId || _this.winner || !log || !log.length) return false;
					if (typeof LocalSaveStore === 'undefined' || typeof reconstructGameLog !== 'function') return false;
					// Vs the AI: only on the player's own turn (the AI is not thinking).
					if (aiMode && _this.whoseTurn !== _humanColor) return false;
					return !aiMode || log.some(t => t.color === _humanColor);
				};
				_this.handleTakeBack = async function () {
					if (!_this.canTakeBack()) return;
					const log = _engineRef._gameLog;
					let h = log.length - 1;
					if (aiMode) while (h >= 0 && log[h].color !== _humanColor) h--;
					if (h < 0) return;
					const board = _engineRef.board;
					let sfn;
					try {
						if (h === 0) {
							// Back to the start: the loaded position, or a fresh
							// board with the same spells.
							if (_startSfnForUndo) {
								sfn = _startSfnForUndo;
							} else if (_fromPosition) {
								// A save from before startSfn was kept: the start is unknown.
								_this.messageHistory.push('Cannot take back the first turn of this game.');
								return;
							} else {
								const fresh = new SigilBoard(board.spellNames, board.variant || gameVariant);
								fresh.setupInitial();
								sfn = boardToSfn(fresh);
							}
						} else {
							const rebuilt = await reconstructGameLog(board.spellNames, normalizeVariant(board.variant || gameVariant),
								_setupSfn, slimGameLog(log.slice(0, h)));
							sfn = rebuilt[rebuilt.length - 1].sfnAfter;
						}
					} catch (e) {
						_this.messageHistory.push('Could not take back: ' + e.message);
						return;
					}
					_tookBack = !!aiMode;
					_humanHasMoved = true;
					_persistedGameLog = slimGameLog(log.slice(0, h));
					_persistCurrentGame(sfn);
					warnBeforeUnload = false;
					window.location.reload();
				};

				/**
				 * The side picker of a game vs AI from a position: evaluate the
				 * start (or take the review's eval), price both sides at the
				 * current ratings, and wait for the player's choice.
				 */
				async function _pickSideFromPosition() {
					// The position as the game will start its first turn (the
					// side to move and turn counter the engine searches).
					let sfn;
					try { sfn = positionTurnSfn(_startSfnAtLoad); } catch (e) { sfn = null; }
					_this.sideOffer = { loading: true, evalText: 'Evaluating the position\u2026', oddsText: '', payoffs: null, note: '' };
					let handed = null;
					try {
						const raw = sessionStorage.getItem('sigil_rematch_startpos');
						sessionStorage.removeItem('sigil_rematch_startpos');
						const h = raw ? JSON.parse(raw) : null;
						if (h && h.sfn === _startSfnAtLoad) handed = h;
					} catch (e) { /* sessionStorage blocked or bad payload */ }
					const model = typeof loadPositionModel === 'function' ? await loadPositionModel() : null;
					let info = handed && handed.info, source = 'review', failed = sfn ? '' : 'unreadable position';
					if (!info && sfn) {
						source = 'live';
						try {
							info = (typeof evaluateStartPosition === 'function' && typeof getRustEngineWorker === 'function')
								? await evaluateStartPosition(sfn) : null;
						} catch (e) { failed = e.message || String(e); info = null; }
					}
					_startPos = (model && info && sfn) ? makeStartPos(model, sfn, info, source) : null;
					const offer = { loading: false, evalText: '', oddsText: '', payoffs: null, note: '' };
					if (info) offer.evalText = 'Engine: ' + describePositionEval(info);
					if (_startPos) {
						offer.oddsText = describePositionOdds(_startPos.redWinProb) + ' with Very Hard AI play on both sides.';
					}
					// Ratings: wait for Firebase to restore the session, then read both records.
					const _user = await firebaseAuthSettled();
					const signedIn = !!(_user && !_user.isAnonymous);
					if (!_startPos) {
						offer.note = 'Unrated: ' + (failed ? 'the engine could not evaluate this position (' + failed + ').'
							: 'this position could not be priced.');
					} else if (!signedIn) {
						offer.note = 'Sign in to play this position rated.';
					} else {
						try {
							const db = firebase.database();
							const read = (uid) => Promise.race([
								db.ref('users/' + uid + '/elo').once('value').then(v => v.val() || 1000),
								new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
							]);
							const [me, ai] = await Promise.all([read(_user.uid), read('__ai_' + aiMode + '__')]);
							offer.payoffs = {
								red: positionPayoffs(_startPos.redWinProb, me, ai).red,
								blue: positionPayoffs(_startPos.redWinProb, ai, me).blue,
								me, ai,
							};
						} catch (e) {
							offer.note = 'Ratings are unavailable offline; the game is still rated when it syncs.';
						}
					}
					_this.sideOffer = offer;
					const side = await new Promise(resolve => { _this._sideOfferResolve = resolve; });
					_this.sideOffer = null;
					_humanColor = side === 'random' ? (Math.random() < 0.5 ? 'blue' : 'red') : side;
					_aiColor = _humanColor === 'red' ? 'blue' : 'red';
					_this.myColor = _humanColor;
				}

				/**
				 * Analysis board: (re)start a local 1v1 controller on `sfn`, a
				 * loadable SFN (the form Export Position and after-turn records
				 * use; the controller advances it to the side to move). The
				 * previous controller is abandoned mid-prompt, as a puzzle retry
				 * does; its events are dropped by the identity check in emit.
				 * opts.history: the SFNs of the positions before this one on the
				 * analysed line, so threefold repetition counts them as a game
				 * that reached this node would. opts.turn: {color, turn} plays
				 * that turn (a SimTurn, e.g. the engine's best) for the side to
				 * move through the AI path, with its animations. opts.silenced:
				 * { red, blue } Silence flags, which SFN does not carry;
				 * opts.historySilenced: the same per opts.history entry.
				 */
				function _analysisStart(sfn, opts) {
					opts = opts || {};
					_this.winner = '';
					_this.messageHistory = [];
					_this.validMoves = {};
					_this.pushSourceNode = '';
					_this.lastPlay = '';
					_this.nodesToRefill = {};
					_this.playerToRefill = '';
					_this.actionList = [];
					_this.awaiting = null;
					_this.showReset = false;
					_this.currentSfn = '';
					_this.whoseTurn = '';
					_this.previousBoardState = {};
					drawPushArrows(_this.$refs.pushArrows, []);
					// Past the first turn: no game-start sound on every navigation.
					_turnCount = 1;
					_turnMsgMark = -1;
					_turnMsgText = null;
					let variant = 'standard';
					try { variant = normalizeVariant(sfnToDict(sfn).variant); } catch (e) { /* the engine reports it */ }
					gameVariant = variant;
					_this.gameVariant = variant;
					_this.isDeathmatch = variantHasDeathmatch(variant);
					_this.applyBoardLayout(variantBoardLayout(variant));
					const options = { variant };
					if (opts.turn) {
						const planned = opts.turn;
						options.aiColor = planned.color;
						options.ai = { lastMeta: null, pickTurn: async () => planned.turn };
					}
					const engine = new GameController(function emitEvent(eventObj) {
						if (_engineRef !== engine) return;
						handleIncomingEvent(eventObj);
						if (eventObj.type === 'turn_complete' && _this._analysisOnTurn) {
							_this._analysisOnTurn(eventObj.turn, engine.board, !!opts.turn);
						} else if (eventObj.type === 'game_over' && _this._analysisOnGameOver) {
							_this._analysisOnGameOver(eventObj);
						}
					}, options);
					_engineRef = engine;
					_this._engine = engine;
					_this.sendEvent = function sendEvent(message) {
						engine.handlePlayerAction(message);
						_this.awaiting = null;
					};
					// startGame builds its board before its first await, so the
					// repetition counts can be seeded before the loop snapshots.
					const started = engine.startGame(sfn);
					// SFN does not record Silence: opts.silenced carries it
					// from the turn that led here (analysisSilencedAfter).
					if (engine.board && opts.silenced) {
						engine.board.silenced = { red: !!opts.silenced.red, blue: !!opts.silenced.blue };
					}
					if (engine.board && Array.isArray(opts.history)) {
						const counts = {};
						opts.history.forEach((prev, k) => {
							try {
								const b = new SigilBoard(sfnToDict(prev).spell_names, variant);
								b.loadFromSfn(prev);
								// Silence is part of the snapshot key (opts.historySilenced).
								const sil = Array.isArray(opts.historySilenced) && opts.historySilenced[k];
								if (sil) b.silenced = { red: !!sil.red, blue: !!sil.blue };
								b.allLoopingSnapshotCounts = counts;
								b.takeSnapshot();
							} catch (e) { /* an unreadable ancestor just isn't counted */ }
						});
						engine.board.allLoopingSnapshotCounts = counts;
					}
					return started;
				}

				// Analysis board: show a position without a live controller
				// (editor mode, and decided positions where nothing can be played).
				function _analysisStop() {
					_engineRef = null;
					_this._engine = null;
					_this.sendEvent = function () {};
					_this.actionList = [];
					_this.awaiting = null;
					_this.validMoves = {};
					_this.pushSourceNode = '';
					_this.showReset = false;
					_this.whoseTurn = '';
					_this.previousBoardState = {};
					drawPushArrows(_this.$refs.pushArrows, []);
				}

				if (analysis) {
					// Deferred: the handlers' turn bookkeeping (declared below)
					// must be initialized before the first controller starts.
					setTimeout(() => _this._analysisInit({ start: _analysisStart, stop: _analysisStop }), 0);
				} else if (_offerSides) _pickSideFromPosition().then(initEngine);
				else initEngine();

				// Keyboard shortcuts (game-keys.js, shared with multiplayer)
				bindGameKeys(_this);

				function handleIncomingEvent(payload) {
					const { type, ...rest } = payload;

					if (type === 'ping') return;
					// A finished lesson keeps its final board: the idle opponent's
					// turn (and anything after it) is not shown.
					if (tutorial && _this.tutorialStatus === 'done') return;
					// Every lesson starts from a set-up position; the game log need
					// not announce it.
					if (tutorial && type === 'message' && /^Imported position/.test(rest.message || '')) return;


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
						_this._recomputeMapControl();
						if (_this.devEvalEnabled) {
							_this._recomputeDevEval().catch(() => {});
						}
						return;
					}

					if (type === 'whoseturndisplay') {
						handleWhoseTurnEvent(rest);
						if (puzzle) _puzzleOnWhoseTurn(rest);
						return;
					}

					if (type === 'turn_complete') {
						drawPushArrows(_this.$refs.pushArrows, []);
						const t = rest.turn;
						if (puzzle && t) _puzzleOnTurn(t);
						if (tutorial && t) _tutorialOnTurn(t);
						if (t && t.color && t.color !== _this.myColor) {
							_this.lastOpponentTurn = { turnNumber: t.turnNumber, color: t.color };
						}
						if (t) {
							// Capture the game's starting position once (needed
							// to replay slim logs of imported-position games).
							if (_setupSfn === null && _persistedGameLog.length === 0 && t.sfnBefore) {
								_setupSfn = t.sfnBefore;
							}
							// Persist the SLIM shape — SFNs are reconstructed by
							// replay when the log is loaded again.
							_persistedGameLog.push(slimGameLog([t])[0]);
						}
						// First human turn unlocks persistence. In local 1v1
						// both colors are human; vs AI only the human's color
						// counts.
						if (t && !_humanHasMoved && (!aiMode || t.color === _this.myColor)) {
							_humanHasMoved = true;
						}
						// sfn_update fires before turn_complete, so the save it
						// wrote holds this turn's position but not this turn:
						// write it again with the turn. Without this, a reload
						// resumed from that save and the finished record lost
						// the last turn before the reload.
						if (t) _persistCurrentGame(_this.currentSfn);
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

					if (type === 'push_arrows') {
						drawPushArrows(_this.$refs.pushArrows, rest.arrows);
						return;
					}

					if (type === 'pushingoptions') {
						const { sourceNode, ...targets } = rest;
						_this.pushSourceNode = sourceNode || '';
						handleValidMovesEvent(targets);
						return;
					}

					if (type === 'game_over') {
						drawPushArrows(_this.$refs.pushArrows, []);
						if (_gameId && typeof LocalSaveStore !== 'undefined') {
							LocalSaveStore.remove(_gameId);
						}
						handleGameOverEvent(rest);
						if (puzzle) _puzzleOnGameOver(rest);
						if (tutorial) _tutorialOnGameOver(rest);
						return;
					}

					if (type === 'ai_think_report') {
						handleAiThinkReportEvent(rest);
						return;
					}

					if (type === 'clock_tick') {
						_this.hasClock = true;
						_this.redClockMs = rest.red;
						_this.blueClockMs = rest.blue;
						_this.clockActive = rest.active || '';
						if (rest.label) _this.clockLabel = rest.label;
						return;
					}

					if (type === 'ai_thinking_start') {
						_this.aiThinking = true;
						_this.aiThinkingColor = rest.color || '';
						_this.aiThinkingDepth = 0;
						_this.aiThinkingTimeMs = 0;
						_this.aiThinkingNodes = 0;
						_this.aiThinkingBudgetMs = 0;
						_this.aiClockMs = null;
						return;
					}

					if (type === 'ai_thinking_progress') {
						_this.aiThinking = true;
						if (rest.color) _this.aiThinkingColor = rest.color;
						if (typeof rest.depth === 'number') _this.aiThinkingDepth = rest.depth;
						if (typeof rest.timeMs === 'number') _this.aiThinkingTimeMs = rest.timeMs;
						if (typeof rest.nodes === 'number') _this.aiThinkingNodes = rest.nodes;
						// Game clock (rust-ai.js): this move's budget and the clock it came from.
						if (typeof rest.budgetMs === 'number') _this.aiThinkingBudgetMs = rest.budgetMs;
						if (typeof rest.clockMs === 'number') _this.aiClockMs = rest.clockMs;
						return;
					}

					if (type === 'ai_thinking_end') {
						_this.aiThinking = false;
						return;
					}
				}

				// ---------------------------------------------------------------
				// Puzzles (puzzles.html). The live GameController is the rules
				// oracle: the human's turn is legal because the engine accepted
				// every click, and it is judged by the POSITION it produced
				// (`puzzleSfnKey`), never by the tokens typed. Anything the
				// precomputed solution promised that the live game does not
				// deliver -- a "mate" that leaves the game running, a stored
				// reply the replayer rejects -- is surfaced as a diagnostic,
				// because it is evidence of a rules disagreement between the
				// Rust solver and the browser engine.
				// ---------------------------------------------------------------
				let _puzzleExpectGameOver = false;

				// The page's hook for results (daily streak): solved, failed or
				// revealed, once per attempt.
				function _puzzleReport(status) {
					if (typeof window !== 'undefined' && typeof window.SIGIL_PUZZLE_ON_RESULT === 'function') {
						try { window.SIGIL_PUZZLE_ON_RESULT(puzzle, status); } catch (e) { /* page hook */ }
					}
				}

				function _puzzleFail(msg) {
					if (_this.puzzleStatus !== 'playing') return;
					_this.puzzleStatus = 'failed';
					_this.puzzleMessage = msg;
					_puzzleReport('failed');
					if (typeof soundManager !== 'undefined') { try { soundManager.play('crush'); } catch (e) { /* */ } }
				}
				_this._puzzleFail = _puzzleFail;

				function _puzzleSolve(msg) {
					if (_this.puzzleStatus !== 'playing') return;
					_this.puzzleStatus = 'solved';
					_this.puzzleMessage = msg || 'Solved!';
					try {
						const raw = localStorage.getItem('sigil_puzzles_solved');
						const solved = raw ? JSON.parse(raw) : {};
						solved[puzzle.id] = Date.now();
						localStorage.setItem('sigil_puzzles_solved', JSON.stringify(solved));
					} catch (e) { /* storage blocked */ }
					_puzzleReport('solved');
				}
				_this._puzzleSolve = _puzzleSolve;

				function _puzzleOnTurn(t) {
					if (t.color === puzzle.mover) _this.puzzleMoves += 1;
					if (_this.puzzleStatus !== 'playing') return;
					if (t.color !== puzzle.mover) {
						// The scripted defence just replayed: it must land on the
						// position the solver computed for it.
						const want = _this._puzzleLastDefence && _this._puzzleLastDefence.after;
						if (want && puzzleSfnKey(t.sfnAfter) !== puzzleSfnKey(want)) {
							_this.puzzleDiagnostic = 'Replay mismatch: the browser engine applied the stored reply and reached a different position than the solver predicted. Expected ' + want + ' but got ' + t.sfnAfter;
						}
						return;
					}
					const key = puzzleSfnKey(t.sfnAfter);
					const over = !!(_engineRef && _engineRef.board && _engineRef.board.gameover);
					const step = _this.puzzleStep;
					_this.puzzleStep = step + 1;
					if (puzzle.kind === 'winning') {
						// One turn to find. A stored solution (or a win on the
						// spot) solves it; anything else is judged by the engine
						// when it picks its reply (PuzzleOpponent._winningReply).
						if (step > 0) return;
						const sol = (puzzle.solutions || []).find(x => x.key === key);
						if (sol || puzzleKeys(puzzle).indexOf(key) >= 0 || (over && _engineRef.board.winner === puzzle.mover)) {
							_puzzleSolve(sol && sol.p ? 'Solved! That turn keeps a ' + puzzlePct(sol.p) + ' chance to win.' : 'Solved!');
							return;
						}
						_this._puzzleJudgePending = true;
						_this.puzzleMessage = 'Not the stored solution — the engine is judging your turn…';
						return;
					}
					// Which turns are "correct" at this step: the puzzle's first
					// turns, then the proven continuations of the line the
					// player is on (mate-in-3). The last step is judged by the
					// live rules alone: the game must be over.
					const lastStep = puzzle.mate - 1;
					if (step < lastStep) {
						const accepted = step === 0 ? (puzzle.solutions || [])
							: ((_this._puzzleLine && _this._puzzleLine.continuations) || []);
						const hitLine = accepted.find(sol => sol.key === key)
							|| (step === 0 && puzzleKeys(puzzle).indexOf(key) >= 0 ? { key } : null);
						if (!hitLine) {
							if (over && _engineRef.board.winner === puzzle.mover) {
								// The live rules ended the game in the mover's favour on
								// a turn the solver did NOT list as winning.
								_this.puzzleDiagnostic = 'The game ended in your favour on a turn the solver did not consider a forced win. Position after your turn: ' + t.sfnAfter;
								_puzzleSolve();
								return;
							}
							// Not a stored line: the engine judges it when it picks its
							// reply (PuzzleOpponent.pickTurn), searching the position to
							// the depth the puzzle still needs.
							_this._puzzleLine = null;
							_this._puzzleLastDefence = null;
							_this._puzzleJudgePending = true;
							_this.puzzleMessage = 'Not a stored solution — the engine is checking whether it still forces the win…';
							return;
						}
						_this._puzzleLine = hitLine;
						_this._puzzleLastDefence = hitLine.defence || null;
						_this._puzzleJudgePending = false;
						if (over) {
							// Won faster than the puzzle needed; the live rules decide.
							_puzzleExpectGameOver = true;
							return;
						}
						_this.puzzleMessage = step === 0 && puzzle.mate === 3
							? 'Correct! Two more to go.' : 'Correct! Now find the finishing move.';
						return;
					}
					// Final solver turn: the game must be over now.
					if (!over) {
						_puzzleFail('That was not the finishing move: the mate was in ' + puzzle.mate + ' and this is your turn ' + puzzle.mate + '. Play on, or Retry.');
					} else {
						_puzzleExpectGameOver = true;
					}
				}

				function _puzzleOnWhoseTurn(payload) {
					if (_this.puzzleStatus !== 'playing') return;
					if (_puzzleExpectGameOver && payload.color !== puzzle.mover) {
						_puzzleExpectGameOver = false;
						_this.puzzleDiagnostic = 'The solver counted your turn as a win, but the live game continued. Position: ' + _this.currentSfn;
						_puzzleFail('The engine believed that wins, but the game went on. Please report this position.');
					}
				}

				function _puzzleOnGameOver(payload) {
					_puzzleExpectGameOver = false;
					if (puzzle.kind !== 'winning' && _this.puzzleStatus === 'failed' && payload.winner === puzzle.mover
						&& _this.puzzleMoves <= puzzle.mate) {
						// The engine judged an earlier move as an escape, yet the mover
						// won within the puzzle's count: the JUDGE was wrong. Worth a report.
						_this.puzzleDiagnostic = 'Engine misjudgement: it ruled that a move let it escape, but you still won within ' + puzzle.mate + ' turns. ' + (_this.puzzleJudge || '');
						_this.puzzleStatus = 'solved';
						_this.puzzleMessage = 'Solved (despite the engine\'s verdict) — please report this position.';
						return;
					}
					if (_this.puzzleStatus !== 'playing') return;
					if (payload.winner === puzzle.mover) _puzzleSolve();
					else _puzzleFail('The opponent won. Retry, or show the solution.');
				}

				_this.puzzleRetry = function () {
					_this.puzzleStatus = 'playing';
					_this.puzzleStep = 0;
					_this.puzzleMessage = '';
					_this.puzzleSolutionText = [];
					_this.puzzleSolutionNodes = {};
					_this.puzzleJudge = '';
					_this.puzzleMoves = 0;
					_this._puzzleLastDefence = null;
					_this._puzzleLine = null;
					_this._puzzleJudgePending = false;
					_puzzleExpectGameOver = false;
					_this.winner = '';
					_this.messageHistory = [];
					_this.validMoves = {};
					_this.pushSourceNode = '';
					_this.lastPlay = '';
					_this.nodesToRefill = {};
					_this.playerToRefill = '';
					_this.actionList = [];
					_this.awaiting = null;
					_this.showReset = false;
					_this.currentSfn = '';
					_this.whoseTurn = '';
					_turnCount = 0;
					initEngine();
				};

				_this.puzzleShowSolution = function () {
					if (_this.puzzleStatus === 'solved') return;
					if (_this.puzzleStatus === 'playing') {
						_this.puzzleStatus = 'revealed';
						_puzzleReport('revealed');
					}
					const lines = [];
					const sols = puzzle.solutions || [];
					const shown = sols.slice(0, 3);
					const them = puzzle.mover === 'red' ? 'Blue' : 'Red';
					const render = (sol) => {
						let text = describePuzzleActions(sol.actions);
						if (typeof sol.p === 'number') text += ' (keeps a ' + puzzlePct(sol.p) + ' chance to win)';
						if (sol.defence) text += '  \u2192  ' + them + ' replies ' + describePuzzleActions(sol.defence.actions);
						if (sol.continuations && sol.continuations.length) {
							text += '  \u2192  ' + render(sol.continuations[0]);
						} else if (sol.finish) {
							text += '  \u2192  ' + describePuzzleActions(sol.finish.actions);
						}
						return text;
					};
					shown.forEach((sol, i) => {
						const prefix = shown.length > 1 ? ('Line ' + (i + 1) + ': ') : '';
						lines.push(prefix + render(sol));
					});
					const extra = puzzleKeys(puzzle).length - shown.length;
					if (extra > 0) lines.push(extra + ' more winning first turn' + (extra === 1 ? '' : 's') + ' not shown.');
					if (puzzle.kind === 'winning' && typeof puzzle.p_second === 'number') {
						lines.push('Every other turn the engine tried keeps at most ' + puzzlePct(puzzle.p_second) + '.');
					}
					_this.puzzleSolutionText = lines;
					// Also into the game log, which is always in view, and ring every
					// node the first solution turn touches (gold, distinct from the
					// game's own red/blue legal-move rings).
					lines.forEach(l => _this.messageHistory.push('Solution: ' + l));
					const ring = {};
					const first = sols[0];
					if (first && Array.isArray(first.actions)) {
						first.actions.forEach(a => {
							if (!a) return;
							['node', 'node2', 'pushed_to'].forEach(k => { if (a[k]) ring[a[k]] = true; });
							['sacrificed', 'destroyed', 'kept', 'converted'].forEach(k => (a[k] || []).forEach(n => { ring[n] = true; }));
						});
					}
					_this.puzzleSolutionNodes = ring;
				};

				// ---------------------------------------------------------------
				// Tutorial (tutorial.html). A lesson is a start position and the
				// input tokens it expects, in order. Every click reaches the
				// controller as a token (a node, 'dash', 'pass', a spell name)
				// through sendEvent, so _tutorialAccept vets it first: a wrong
				// one shows the lesson's hint and restarts the lesson. The live
				// GameController still applies every accepted token, so the
				// board always follows the real rules.
				//
				// A step's `do` is a token; { oneOf: [...] } any one of them;
				// { all: [...] } each of them once, in any order; or { any: true }
				// any node the controller is offering (legal moves or stones to
				// keep). `mark` lists extra nodes to ring for an { any } step.
				// ---------------------------------------------------------------
				function _tutorialLesson() {
					return tutorial.lessons[_this.tutorialIndex];
				}

				function _tutorialStep() {
					return _tutorialLesson().steps[_this.tutorialStep] || null;
				}

				// Nodes the controller is offering right now, or null when the
				// prompt names none (dash sacrifices, push choices).
				function _tutorialOffered() {
					const offered = Object.assign({}, _this.validMoves || {}, _this.nodesToRefill || {});
					return Object.keys(offered).length ? offered : null;
				}

				function _tutorialShowStep() {
					const step = _tutorialStep();
					const targets = {};
					let action = '';
					if (step && _this.tutorialStatus === 'playing') {
						const d = step.do;
						const tokens = typeof d === 'string' ? [d]
							: d.all ? (_this._tutRemaining || d.all)
							: d.oneOf ? d.oneOf : (step.mark || []);
						for (const tok of tokens) {
							if (NODE_ORDER.includes(tok)) targets[tok] = true;
							else action = tok;
						}
					}
					_this.tutorialTargets = targets;
					_this.tutorialTargetAction = action;
				}

				function _tutorialAccept(message) {
					if (message === 'reset') {
						_tutorialRestart('');
						return false;
					}
					if (_this.tutorialStatus !== 'playing') return false;
					const step = _tutorialStep();
					if (!step) return true;
					const d = step.do;
					const isNode = NODE_ORDER.includes(message);
					const offered = isNode ? _tutorialOffered() : null;
					// A node the controller is not offering would be refused (and
					// re-prompted) by it, which would put the script out of step.
					const legal = !offered || !!offered[message];
					let ok = false;
					if (typeof d === 'string') ok = message === d;
					else if (d.oneOf) ok = d.oneOf.includes(message) && legal;
					else if (d.all) ok = (_this._tutRemaining || d.all).includes(message) && legal;
					else if (d.any) ok = isNode && legal;
					if (!ok) {
						_tutorialWrong();
						return false;
					}
					if (d.all) {
						const rest = (_this._tutRemaining || d.all).filter(t => t !== message);
						_this._tutRemaining = rest.length ? rest : null;
						if (rest.length) {
							_tutorialShowStep();
							return true;
						}
					}
					_this.tutorialStep += 1;
					_tutorialShowStep();
					return true;
				}

				function _tutorialWrong() {
					_tutorialRestart(_tutorialLesson().hint || 'Not quite. Try again.');
				}
				_this._tutorialWrong = _tutorialWrong;

				function _tutorialSucceed() {
					_this.tutorialStatus = 'done';
					_this.tutorialHint = '';
					_this.tutorialTargets = {};
					_this.tutorialTargetAction = '';
					_this.actionList = [];
					_this.validMoves = {};
					_this.awaiting = null;
					const id = _tutorialLesson().id;
					_this.tutorialDone = Object.assign({}, _this.tutorialDone, { [id]: Date.now() });
					try {
						localStorage.setItem('sigil_tutorial_done', JSON.stringify(_this.tutorialDone));
					} catch (e) { /* storage blocked */ }
				}

				function _tutorialOnTurn(t) {
					const lesson = _tutorialLesson();
					if (t.color !== (lesson.mover || 'blue') || _this.tutorialStatus !== 'playing') return;
					if (_tutorialStep()) {
						// The turn ended before the script did.
						_tutorialWrong();
						return;
					}
					// A winning lesson finishes on the game_over that follows.
					if (!lesson.win) _tutorialSucceed();
				}

				function _tutorialOnGameOver(payload) {
					if (_this.tutorialStatus !== 'playing') return;
					if (!_tutorialStep() && payload.winner === (_tutorialLesson().mover || 'blue')) _tutorialSucceed();
					else _tutorialWrong();
				}

				function _tutorialRestart(hint) {
					_this.tutorialStatus = 'playing';
					_this.tutorialStep = 0;
					_this.tutorialHint = hint;
					_this._tutRemaining = null;
					_this.winner = '';
					_this.messageHistory = [];
					_this.validMoves = {};
					_this.pushSourceNode = '';
					_this.lastPlay = '';
					_this.nodesToRefill = {};
					_this.playerToRefill = '';
					_this.actionList = [];
					_this.awaiting = null;
					_this.showReset = false;
					_this.currentSfn = '';
					_this.whoseTurn = '';
					_turnCount = 0;
					_tutorialShowStep();
					initEngine();
				}

				if (tutorial) {
					try {
						_this.tutorialDone = JSON.parse(localStorage.getItem('sigil_tutorial_done') || '{}') || {};
					} catch (e) {
						_this.tutorialDone = {};
					}
					_tutorialShowStep();
					_this.tutorialRestart = function () {
						_tutorialRestart('');
					};
					_this.tutorialGo = function (i) {
						if (i < 0 || i >= tutorial.lessons.length) return;
						_this.tutorialIndex = i;
						try {
							const u = new URL(window.location.href);
							u.searchParams.set('lesson', String(i + 1));
							history.replaceState(null, '', u.toString());
						} catch (e) { /* ignore */ }
						_tutorialRestart('');
						window.scrollTo({ top: 0, behavior: 'smooth' });
					};
				}

				function handleAiThinkReportEvent(payload) {
					if (!_aiAuthManager || !_aiAuthManager.showAiThinkReport) return;
					const c = payload.color ? payload.color[0].toUpperCase() + payload.color.slice(1) : 'AI';
					const seconds = ((payload.timeMs || 0) / 1000).toFixed(1);
					// The evaluation is from the moving AI's perspective
					// (positive = the AI is favored); see formatEngineEval for
					// the units and the "win in N" / "likely win in N" forms.
					const shown = formatEngineEval(payload);
					let evalStr = shown ? `, eval ${shown}` : '';
					if (payload.opening && payload.opening.spell) {
						evalStr += `, opening: ${payload.opening.spell} (${payload.opening.node})`
							+ (payload.opening.reply
								? (payload.opening.syzygy_threat ? ` crushing the ${payload.opening.reply} start` : ` vs ${payload.opening.reply}`)
								: '');
					}
					// Trappiness pass ran (proven loss): show how deep it got
					// and what fraction of opponent replies dodge the win.
					let trapStr = '';
					if (typeof payload.trapDepth === 'number' && payload.trapDepth > 0) {
						trapStr = `, trap d${payload.trapDepth}`;
						if (typeof payload.trapFrac === 'number') {
							trapStr += ` (${Math.round(payload.trapFrac * 100)}% slip)`;
						}
					}
					// "depth 5/9": 5 plies completed everywhere, 9 the deepest
					// line; "reply read to depth N" when a decided root spent
					// the rest of its clock on the opponent's position.
					const selStr = (payload.seldepth && payload.seldepth > (payload.depth || 0))
						? `/${payload.seldepth}` : '';
					const overStr = payload.overflowDepth ? `, reply read to depth ${payload.overflowDepth}` : '';
					// Game clock: what is left after this move (increment included).
					const clockStr = (payload.clock && typeof payload.clockMs === 'number')
						? `, ${_this.formatTimer(Math.round(payload.clockMs / 1000))} left` : '';
					_this.messageHistory.push(`${c} AI: depth ${payload.depth || 0}${selStr}, ${seconds}s${clockStr}, ${payload.nodes || 0} nodes${overStr}${evalStr}${trapStr}`);
				}

				// Shared by live messages and animated replay narration.
				function maybeSpellFx(message) {
					if (message && message.includes(' casts ')) {
						if (typeof soundManager !== 'undefined') soundManager.play('spellCast');
						if (typeof playSpellEffect === 'function') {
							const spellName = message.split(' casts ')[1]?.replace(/ /g, '_');
							if (spellName) playSpellEffect(_this.$refs.spellFxOverlay, _this.$refs.gameBoardContainer, spellName);
						}
					}
				}

				/**
				 * Animated replay of review turn `i` (reviewSfns[i] -> [i+1]):
				 * rebuild the turn from its stored action transcript through the
				 * real engine (reconstructGameLog) on a throwaway board, and
				 * forward its animation/boardstate events to the same handlers a
				 * live game drives. Replay narration goes to the prompt line, NOT
				 * messageHistory — the console stays a clean record of the real
				 * game. sfn_update / turn_complete / game_over stay ours: the
				 * replay must never touch persistence or the live game record.
				 */
				_this._animateReviewTurn = async function (i) {
					const log = _this._gameLogForExport;
					const t = log && log[i];
					const sfnBefore = _this.reviewSfns[i];
					if (!t || !sfnBefore || !Array.isArray(t.actions)) return false;
					if (typeof reconstructGameLog !== 'function') return false;
					const spellNames = (_this._spellNamesForExport || []).slice();
					if (spellNames.length !== BOARD.positionCount) return false;
					let variant = 'standard';
					try { variant = sfnToDict(sfnBefore).variant || 'standard'; } catch (e) { /* default */ }
					// The boardstate diff baseline belongs to the live game; reset
					// it so the replay's first snapshot applies in full against
					// whatever position is currently displayed.
					_this.previousBoardState = {};
					// Replayed stone placements must follow the action on screen,
					// never re-arm the Reset button (handleNewStonePlacement keys
					// off currentPlayer for that).
					_this.currentPlayer = '';
					const label = _this.reviewTurnLabels[i + 1] || '';
					if (label) _this.message = 'Replaying ' + label;
					const emit = (ev) => {
						if (!ev || !ev.type) return;
						const { type, ...rest } = ev;
						if (type === 'boardstate') {
							handleBoardStateEvent(rest);
							_this._recomputeMapControl();
						} else if (type === 'new_stone_animation') {
							handleNewStonePlacement(rest);
						} else if (type === 'push_animation') {
							handlePushAnimation(rest);
						} else if (type === 'crush_animation') {
							handleCrushAnimation(rest);
						} else if (type === 'push_arrows') {
							drawPushArrows(_this.$refs.pushArrows, rest.arrows);
						} else if (type === 'message' && rest.message) {
							_this.message = rest.message;
							maybeSpellFx(rest.message);
						}
					};
					await reconstructGameLog(spellNames, variant, sfnBefore, [t], { emit, paceMs: 450 });
					// Let the last animation land before the caller snaps to the
					// stored after-state (which also corrects any drift).
					await new Promise(r => setTimeout(r, 450));
					if (label) _this.message = label;
					return true;
				};

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
					maybeSpellFx(_this.message);

					if (_this.awaiting !== 'action' && payload.message !== '' && payload.message) {
						_this.messageHistory.push(payload.message);
					}
				}

				function handleSpellSetupEvent(payload) {
					_this.spellDict = payload;
					// The help popover's "This game's rules" (help.js).
					if (typeof sigilPublishGameRules === 'function') sigilPublishGameRules(_this.gameVariant, Object.values(payload));

					Object.entries(_this.spellDict).forEach(([key, value]) => {
						_this.spells.images[key] = `static/images/spells/${baseSpellName(value)}.png`;
					});

					// The analysis board restarts on every navigation: no jump.
					if (analysis) return;
					setTimeout(() => {
						if (_this.$refs.gameBoardContainer) {
							_this.$refs.gameBoardContainer.scrollIntoView({
								behavior: sigilScrollBehavior(),
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
						// Non-node payload fields must be destructured OUT
						// here or the ...nodes rest treats them as node names.
						redbank,
						bluebank,
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
					if (isValidStateKey(redbank)) {
						_this.redBank = redbank;
					}
					if (isValidStateKey(bluebank)) {
						_this.blueBank = bluebank;
					}

					_this.previousBoardState = payload;
				}

				let _turnCount = 0;
				// Where in messageHistory the current turn's header sits, and its
				// text. After a Reset Turn the controller re-announces the SAME
				// header ("Red Turn N"), so a repeat is the reset replay: drop
				// everything from the aborted attempt (its prompts, casts and the
				// "Resetting Turn" notice) so the transcript only keeps final,
				// submitted moves — that's what makes it paste-able as a log.
				let _turnMsgMark = -1;
				let _turnMsgText = null;
				function handleWhoseTurnEvent(payload) {
					_this.showReset = false;
					if (payload.message === _turnMsgText
						&& _turnMsgMark >= 0 && _turnMsgMark <= _this.messageHistory.length) {
						_this.messageHistory.splice(_turnMsgMark);
					}
					_turnMsgMark = _this.messageHistory.length;
					_turnMsgText = payload.message;
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
								el.scrollIntoView({ behavior: sigilScrollBehavior(), block: 'center', inline: 'center' });
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
					crushStone.style.cssText = nodeElem.style.cssText;
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
					_this._lastEndReason = payload.endReason || null;
					_this.messageHistory.push(
						`Game over! ${payload.winner === 'blue' ? 'Blue' : 'Red'} wins${payload.endReason === 'time' ? ' on time' : ''}`
					);
					_this.showReset = false;
					_this.winner = payload.winner;
					warnBeforeUnload = false;

					// Cache the spell list for "Play Again (Same Layout)" regardless of
					// whether a game log was produced.
					if (_engineRef && _engineRef.board && _engineRef.board.spellNames) {
						_this._spellNamesForExport = _engineRef.board.spellNames.slice();
					}

					// Build review data from game log. Entries recorded this
					// session are fat (sfnBefore/sfnAfter); entries re-seeded
					// from a slim persisted save lack SFNs and are rebuilt by
					// replaying their action transcripts through the engine.
					if (payload.gameLog && payload.gameLog.length > 0) {
						const finishReview = (fatLog) => {
							if (!fatLog || !fatLog.length || !fatLog[0].sfnBefore) return;
							const sfns = [fatLog[0].sfnBefore];
							const labels = ['Start'];
							for (const turn of fatLog) {
								sfns.push(turn.sfnAfter);
								const colorName = turn.color[0].toUpperCase() + turn.color.slice(1);
								const turnNum = turn.color === 'red'
									? Math.floor(turn.turnNumber / 2) + 1
									: Math.floor(turn.turnNumber / 2);
								labels.push(colorName + ' ' + turnNum);
							}
							_this.reviewSfns = sfns;
							_this.reviewTurnLabels = labels;
							_this._gameLogForExport = fatLog;
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
						};
						if (typeof hydrateGameLog === 'function' && _engineRef && _engineRef.board) {
							// Fat entries pass through untouched; slim ones are
							// rebuilt by replay. No finalSfn check here — a
							// resumed game's history has no stored anchor.
							hydrateGameLog(
								_engineRef.board.spellNames.slice(),
								_engineRef.board.variant,
								_setupSfn,
								null,
								payload.gameLog,
							).then(finishReview).catch((e) => {
								console.warn('Could not rebuild resumed-game history for review:', e);
								// Degrade to whatever fat entries exist (post-resume turns).
								const fat = payload.gameLog.filter(t => t.sfnBefore && t.sfnAfter);
								finishReview(fat);
							});
						} else if (!payload.gameLog.some(t => !t.sfnAfter)) {
							finishReview(payload.gameLog);
						}
					}

					// Save the finished game (and rate it, for AI games). Puzzles
					// and analysis-board lines are never recorded.
					if (!scripted && !analysis) {
						_recordFinishedGame(payload.winner, aiMode);
					}
				}

				/**
				 * Queue the finished game for upload to Firebase, then try to
				 * upload it. The record goes to localStorage before anything
				 * touches the network, so a game finished offline (or a tab
				 * closed mid-upload) syncs the next time the site is reachable.
				 * `difficulty` is the AI tier, or null for a local 1v1 game
				 * (stored unranked under the player for both colors). With no
				 * one signed in it is saved as an unranked guest game under this
				 * device's guest id.
				 */
				async function _recordFinishedGame(winner, difficulty) {
					// Wait for auth state to resolve if needed
					if (_aiAuthManager && !_aiAuthManager.currentUser) {
						await new Promise(resolve => {
							const timeout = setTimeout(resolve, 3000); // max 3s wait
							_aiAuthManager.onAuthChanged(() => { clearTimeout(timeout); resolve(); });
						});
					}

					if (typeof OfflineGameQueue === 'undefined' || typeof firebase === 'undefined') {
						if (difficulty) _this.messageHistory.push('Rating update unavailable.');
						return;
					}
					const isGuest = !_aiAuthManager || !_aiAuthManager.isAuthenticated;
					if (isGuest && difficulty) {
						_this.messageHistory.push('Sign in to track your rating. This game is saved as a guest game.');
					}

					const _spellNames = _engineRef && _engineRef.board ? _engineRef.board.spellNames : [];

					try {
						const db = firebase.database();
						const humanUid = isGuest ? OfflineGameQueue.guestId() : _aiAuthManager.uid;
						// Local 1v1: the signed-in player sits on both sides.
						const aiUid = difficulty ? '__ai_' + difficulty + '__' : humanUid;
						// (The human's /users profile is bootstrapped by the queue
						// at upload time, so nothing here waits on the network.)

						const spellNamesArr = _engineRef && _engineRef.board ? _engineRef.board.spellNames : ['none'];
						const gameTurns = _engineRef ? _engineRef._gameLog : [];
						// ALL stored records — rooms AND completed_games — carry
						// the SLIM transcript (marginal moves) + finalSfn/setupSfn
						// anchors; readers rebuild positions by replay
						// (reconstructGameLog), and the Python training importer
						// hydrates through tools/replay-transcripts.js.
						const slimTurns = slimGameLog(gameTurns);
						const finalSfnForRecord = (_engineRef && _engineRef.board)
							? boardToSfn(_engineRef.board) : null;
						const aiLabel = _aiAuthManager && _aiAuthManager.userProfile && _aiAuthManager.userProfile.displayName;
						const humanName = isGuest ? 'Guest' : (aiLabel || _aiAuthManager.displayName || 'You');
						const aiName = difficulty ? _aiNameFor(difficulty) : humanName;
						// Variant the engine actually played under (read from the
						// live board so we don't drift from the URL query param
						// in edge cases like rematch/reconnect).
						const recordVariant = normalizeVariant(_engineRef && _engineRef.board && _engineRef.board.variant);
						// A game from a position is rated only when its start was
						// priced (position-rating.js); the Elo update then uses it.
						const _recordSetup = _setupSfn || (gameTurns.length ? gameTurns[0].sfnBefore : null);
						const _priced = !!(_startPos && _recordSetup && _startPos.sfn === _recordSetup);
						const _unratedWhy = unratedReason(_spellNames, recordVariant,
							_fromPosition ? _recordSetup : null, _priced ? _startPos : null);
						const _unrated = isGuest || !difficulty || !!_unratedWhy || _tookBack;

						// Synthesize a /rooms entry so the game is replayable from the
						// profile page via multiplayer.html?id=CODE.
						const roomCode = _generateLocalRoomCode();
						_this._roomCodeForReview = roomCode;
						const roomRecord = {
							spellNames: spellNamesArr,
							// An archive of a game played on this device, not an
							// online room: the rules let it be created finished.
							local: true,
							status: 'finished',
							created: Date.now(),
							finishedAt: Date.now(),
							red: { connected: false, uid: _humanColor === 'red' ? humanUid : aiUid, displayName: _humanColor === 'red' ? humanName : aiName },
							blue: { connected: false, uid: _humanColor === 'blue' ? humanUid : aiUid, displayName: _humanColor === 'blue' ? humanName : aiName },
							ranked: !_unrated,
							winner: winner,
							gameLog: slimTurns,
							finalSfn: finalSfnForRecord,
							setupSfn: _setupSfn,
							allowSpectators: true,
							timeControl: (typeof GameClock !== 'undefined') ? GameClock.toTimeControl(clockOpt) : { type: 'none' },
							variant: recordVariant,
						};

						const gameRecord = {
							spellNames: spellNamesArr,
							winner: winner,
							turns: slimTurns,
							setupSfn: _setupSfn || (gameTurns.length ? gameTurns[0].sfnBefore : null),
							finalSfn: finalSfnForRecord,
							timestamp: Date.now(),
							roomCode: roomCode,
							redUid: _humanColor === 'red' ? humanUid : aiUid,
							blueUid: _humanColor === 'blue' ? humanUid : aiUid,
							ranked: !_unrated,
							variant: recordVariant,
							// Clock games rate in the same pool; the control and the way
							// the game ended are recorded so pools can be split later.
							timeControl: (typeof GameClock !== 'undefined') ? GameClock.toTimeControl(clockOpt) : { type: 'none' },
							endReason: _this._lastEndReason || 'play',
						};
						if (!difficulty) gameRecord.mode = 'local_1v1';
						if (isGuest) gameRecord.guest = true;
						if (_priced) {
							gameRecord.startPos = _startPos;
							roomRecord.startPos = _startPos;
						}

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
						const queuedId = OfflineGameQueue.enqueue(Object.assign({
							uid: humanUid,
							guest: isGuest,
							roomCode: roomCode,
							roomRecord: roomRecord,
							gameRecord: gameRecord,
						}, difficulty ? {
							aiUid: aiUid,
							aiName: aiName,
							difficulty: difficulty,
						} : {}));
						if (!queuedId) {
							_this.messageHistory.push('Could not save this game: browser storage is full.');
							return;
						}

						// Local 1v1 and guest games are never rated; no notice needed.
						if (difficulty && !isGuest && _tookBack && !_unratedWhy) {
							_this.messageHistory.push('Unrated: a turn was taken back.');
						} else if (difficulty && !isGuest && _unratedWhy) {
							_this.messageHistory.push(describeUnratedReason(_unratedWhy));
						}

						_this._activeFinishingQueuedId = queuedId;
						let flushResult;
						try {
							flushResult = await OfflineGameQueue.flushAll(db,
								typeof awaitGameRating === 'function' ? awaitGameRating : null);
						} finally {
							_this._activeFinishingQueuedId = null;
						}
						const mine = flushResult.results.find((r) => r.id === queuedId);
						const stillQueued = OfflineGameQueue.peek().some((it) => it.id === queuedId);
						if (stillQueued) {
							// No result for it: the flush did not reach it (nothing
							// attempted), same as offline from the player's view.
							const offline = !mine || mine.error === 'offline' || mine.error === 'unreachable';
							if (offline) {
								_this.messageHistory.push(difficulty && !isGuest
									? 'Offline — game saved. It will upload and your rating will sync when you reconnect.'
									: 'Offline — game saved. It will upload when you reconnect.');
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
						const olderResults = flushResult.results.filter((r) => r.id !== queuedId && r.ok);
						const olderUploaded = olderResults.length;
						if (olderUploaded > 0) {
							const olderRated = olderResults.filter((r) => r.eloResult && typeof r.eloResult.delta === 'number');
							if (olderRated.length > 0) {
								const olderDelta = olderRated.reduce((sum, r) => sum + r.eloResult.delta, 0);
								const olderSign = olderDelta >= 0 ? '+' : '';
								const olderLatestElo = olderRated[olderRated.length - 1].eloResult.newElo;
								_this.messageHistory.push('Synced ' + olderUploaded + ' earlier offline game' + (olderUploaded === 1 ? '' : 's') + '. Rating: ' + olderSign + olderDelta + ' (' + olderLatestElo + ').');
							} else {
								_this.messageHistory.push('Synced ' + olderUploaded + ' earlier offline game' + (olderUploaded === 1 ? '' : 's') + '.');
							}
						}
					} catch (e) {
						console.error('Failed to process AI Elo:', e);
						_this.messageHistory.push('Rating error: ' + e.message);
					}
				}

				function _aiNameFor(difficulty) {
					const labels = {
						// Retired JS Caveman tiers — records renamed "(JS)" when the
						// Rust tiers took their picker slots (2026-08).
						easy: 'AI (Easy) (JS)',
						medium: 'AI (Medium) (JS)',
						hard: 'AI (Hard) (JS)',
						very_hard: 'AI (Very Hard) (JS)',
						// The Rust engine tiers that replaced them, same budgets.
						rust_easy: 'AI (Easy) (Rust)',
						rust_medium: 'AI (Medium) (Rust)',
						rust_hard: 'AI (Hard) (Rust)',
						rust_very_hard: 'AI (Very Hard) (Rust)',
						rust_quick: 'AI (Rust Quick)',
						rust: 'AI (Rust)',
						rust_deep: 'AI (Rust Deep)',
						minimax: 'AI (Minimax 3-ply)',
						positional: 'AI (Positional)',
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

			// Analysis board state and methods (analysis-board.js), spread
			// last so its handleNodeClick (the editor) overrides the game's.
			...((analysis && typeof analysisMixin === 'function') ? analysisMixin() : {}),
		})
	);
});


// ---------------------------------------------------------------------------
// Puzzles page helpers (docs/puzzles.html). Kept here because game-board-local.js
// is the only place that knows the GameController's import contract.
// ---------------------------------------------------------------------------

/**
 * Position identity used to match a player's turn against the precomputed
 * winning set: stones + spells, spell counters, locks, springlocks. The turn
 * counter and the side-to-move token are excluded because the browser records
 * a turn's after-state with the mover still marked to move while the solver
 * marks the opponent, and the counter differs by one between them.
 */
/** The puzzle's winning-first-turn keys (the generator writes snake_case). */
/**
 * The one place an engine evaluation becomes text. Returns null when the
 * payload carries nothing printable.
 *
 * Rust engine (`stones` / `mateIn` / `mateProven` from search::report):
 *   * a forced result prints in the WINNER's own turns -- "win in 2" / "loss
 *     in 1" -- prefixed "likely " when the search was width- or window-limited
 *     (mateProven false), so the number is never hidden behind a ±50;
 *   * otherwise `stones`, already offset so an even game reads 0.0 for either
 *     side (the raw eval carries blue's +1 token and the mover's tempo).
 * Caveman-unit fallback (JS tiers, whose lastMeta.score flows through the same
 * event): mate scores are ±(100 − plies) with |s| >= CAVEMAN_PROVEN_MIN proven;
 * plies are converted to turns the same way. Its stones are `s * 39`, left
 * un-normalised: the Caveman leaf has neither the +1 token nor a tempo term.
 */
function formatEngineEval(meta) {
	if (!meta) return null;
	if (typeof meta.mateIn === 'number' && isFinite(meta.mateIn) && meta.mateIn !== 0) {
		return (meta.mateProven === false ? 'likely ' : '')
			+ (meta.mateIn > 0 ? 'win' : 'loss') + ' in ' + Math.abs(meta.mateIn);
	}
	if (typeof meta.stones === 'number' && isFinite(meta.stones)) {
		return (meta.stones > 0 ? '+' : '') + meta.stones.toFixed(1);
	}
	const s = meta.score;
	if (typeof s !== 'number' || !isFinite(s)) return null;
	const proven = (typeof CAVEMAN_PROVEN_MIN === 'number') ? CAVEMAN_PROVEN_MIN : 37;
	if (Math.abs(s) >= proven) {
		const plies = Math.max(1, Math.round(100 - Math.abs(s)));
		return (s > 0 ? 'win' : 'loss') + ' in ' + Math.ceil(plies / 2);
	}
	const stones = s * 39;
	return (stones > 0 ? '+' : '') + stones.toFixed(1);
}

/** "84%" for a win probability. */
function puzzlePct(p) {
	return Math.round(100 * Math.max(0, Math.min(1, p))) + '%';
}

function puzzleKeys(puzzle) {
	return (puzzle && (puzzle.solution_keys || puzzle.solutionKeys)) || [];
}

function puzzleSfnKey(sfn) {
	const p = String(sfn || '').trim().split(/\s+/);
	// The spell list after '/' is constant within a puzzle, so it is dropped
	// to keep the stored key lists small (39 stone chars + counters + locks).
	// Providence banks (`pm:r:b`) are state the stone field does not show.
	const key = [String(p[0]).split('/')[0], p[3], p[4], p[5]].join(' ');
	const pm = p.slice(6).find(t => t.startsWith('pm:'));
	return pm ? key + ' ' + pm : key;
}

/**
 * A tutorial lesson's start position as SFN (tutorial.html). A lesson names
 * its stones as space-separated node lists, `red` and `blue`, plus the nine
 * spells, the side to move and turn number (`turn`, Blue's turns even), and
 * optionally the spell counters `spellCounts` [red, blue] and `locks`
 * [red, blue]. A lesson may give `sfn` directly instead.
 */
function tutorialLessonSfn(lesson) {
	if (lesson.sfn) return lesson.sfn;
	const order = boardLayoutDef('core').nodeOrder;
	const red = String(lesson.red || '').split(/\s+/).filter(Boolean);
	const blue = String(lesson.blue || '').split(/\s+/).filter(Boolean);
	const stones = order.map(n => (red.includes(n) ? 'r' : blue.includes(n) ? 'b' : '.')).join('');
	const tc = lesson.turn || 2;
	const counts = lesson.spellCounts || [0, 0];
	const locks = lesson.locks || ['-', '-'];
	// Blue's phantom score stone counts toward the lead.
	const lead = (blue.length + 1) - red.length;
	const score = lead === 0 ? 'tied' : (lead > 0 ? 'b' : 'r') + Math.min(3, Math.abs(lead));
	return stones + '/' + lesson.spells.join(',') + ' ' + (tc % 2 === 0 ? 'b' : 'r') + ' ' + tc
		+ ' ' + counts[0] + ':' + counts[1] + ' ' + locks[0] + ':' + locks[1] + ' -:- ' + score;
}

/**
 * The SFN to hand `GameController.startGame` so that the FIRST turn played is
 * the puzzle's mover. The game loop increments the turn counter and derives
 * the side to move from its parity BEFORE each turn, so the imported counter
 * must be one less than the puzzle position's.
 */
function puzzleImportSfn(sfn) {
	const p = String(sfn).trim().split(/\s+/);
	const tc = parseInt(p[2], 10);
	if (!isNaN(tc) && tc > 0) p[2] = String(tc - 1);
	return p.join(' ');
}

/** Human-readable rendering of an applyAITurn action list. */
function describePuzzleActions(actions) {
	if (!Array.isArray(actions)) return '';
	const disp = (n) => (typeof displaySpellName === 'function' ? displaySpellName(n) : String(n || '').replace(/_/g, ' '));
	const out = [];
	for (const a of actions) {
		if (!a || a.type === 'pass') continue;
		switch (a.type) {
			case 'move': out.push('move to ' + a.node); break;
			case 'blink': out.push('blink to ' + a.node); break;
			case 'hard_move':
				out.push('move to ' + a.node + (a.pushed_to ? ' pushing to ' + a.pushed_to : ' crushing'));
				break;
			case 'dash':
			case 'dash_lightning':
				out.push('dash sacrificing ' + (a.sacrificed || []).join(', '));
				break;
			case 'cast':
				out.push('cast ' + disp(a.spell) + ((a.kept && a.kept.length) ? ' keeping ' + a.kept.join(', ') : ''));
				break;
			case 'sacrifice': out.push('sacrifice ' + a.node); break;
			case 'bewitch': out.push('bewitch ' + a.node + (a.node2 ? ', ' + a.node2 : '')); break;
			case 'corrupt': out.push('corrupt ' + (a.converted || []).join(', ')); break;
			case 'starfall': out.push('starfall ' + [a.node, a.node2].filter(Boolean).join(', ') + ((a.destroyed && a.destroyed.length) ? ' destroying ' + a.destroyed.join(', ') : '')); break;
			case 'gust': out.push('gust' + ((a.kept && a.kept.length) ? ' placing at ' + a.kept.join(', ') : '') + ((a.destroyed && a.destroyed.length) ? ' destroying ' + a.destroyed.join(', ') : '')); break;
			case 'meteor_destroy': out.push('destroy ' + a.node); break;
			default:
				out.push(String(a.type).replace(/_/g, ' ') + ((a.destroyed && a.destroyed.length) ? ' destroying ' + a.destroyed.join(', ') : (a.node ? ' ' + a.node : '')));
		}
	}
	return out.join(', ');
}

/**
 * The puzzle's opponent. On a stored line it plays the precomputed defence.
 * Off the stored lines it asks the engine (`RustAI.judgeMove`) to judge the
 * position the mover just produced -- exhaustively when only the finishing
 * mate is left, otherwise by a search to the depth the puzzle still needs --
 * and plays the engine's best reply. After a failed puzzle it simply keeps
 * playing the engine's replies so the game can be finished.
 */
class PuzzleOpponent {
	constructor(puzzle, component, opts) {
		this.puzzle = puzzle;
		this.component = component;
		this.timeMs = (opts && opts.timeMs) || 6000;
		this.lastMeta = null;
		this._byKey = {};
		const index = (sol) => {
			if (!sol) return;
			if (sol.key && sol.defence) this._byKey[sol.key] = sol.defence;
			for (const c of (sol.continuations || [])) index(c);
		};
		for (const sol of (puzzle.solutions || [])) index(sol);
	}

	async pickTurn(board /* SigilBoard */, color, onProgress) {
		const comp = this.component;
		const key = puzzleSfnKey(boardToSfn(board));
		const stored = this._byKey[key];
		if (stored && comp && comp.puzzleStatus === 'playing' && !comp._puzzleJudgePending) {
			comp._puzzleLastDefence = stored;
			const sim = SimBoard.fromSigilBoard(board);
			// Stored puzzle positions are taken after the end-of-turn effects.
			return rustActionsToTurn(sim, color, stored.actions, stored.after, { endOfTurn: true });
		}
		if (this.puzzle.kind === 'winning') return this._winningReply(board, color, onProgress);
		if (typeof RustAI === 'undefined' || !RustAI.judgeMove) {
			throw new Error('The engine is not available to judge this move.');
		}
		// How many half-moves the mover still has to force the win from here
		// (the opponent is to move): 2 when the mover's next turn must mate.
		const left = Math.max(1, this.puzzle.mate - ((comp && comp.puzzleMoves) || 0));
		const plies = 2 * left;
		const judging = comp && comp.puzzleStatus === 'playing' && comp._puzzleJudgePending;
		const t0 = Date.now();
		const res = await RustAI.judgeMove(board, plies, this.timeMs);
		this.lastMeta = { depth: res.depth, nodes: res.nodes, score: res.score_ui,
			stones: (typeof res.stones === 'number') ? res.stones : null, timeMs: Date.now() - t0 };
		if (onProgress) onProgress(this.lastMeta);
		if (judging) {
			comp._puzzleJudgePending = false;
			const how = res.exhaustive ? 'exhaustively' : ('at depth ' + res.depth);
			// The judge reports plies from ITS root (the opponent to move);
			// players count the mover's own turns, as the puzzle titles do.
			const turns = (typeof res.mate_in_turns === 'number') ? res.mate_in_turns
				: (typeof res.mate_in === 'number' ? Math.ceil(res.mate_in / 2) : null);
			const turnsText = (n) => n + ' more turn' + (n === 1 ? '' : 's');
			if (res.verdict === 'mate') {
				comp.puzzleJudge = 'Engine: your move still forces the win (' + how + (turns ? ', mate in ' + turnsText(turns) : '') + ').';
				comp.puzzleMessage = 'Correct — not the stored line, but the engine confirms it still forces the win. Keep going.';
			} else if (res.verdict === 'likely_mate') {
				comp.puzzleJudge = 'Engine: sees a forced win but could not prove it within its budget (' + how + ').';
				comp.puzzleMessage = 'Probably correct — the engine sees a forced win but could not prove it in time. Keep going.';
			} else if (res.verdict === 'mate_slow') {
				comp.puzzleJudge = 'Engine: a forced win exists but needs ' + (turns ? turnsText(turns) : res.mate_in + ' plies') + ', more than the puzzle allows (' + how + ').';
				comp._puzzleFail('That wins eventually, but not within ' + this.puzzle.mate + ' turns. The engine replies ' + describePuzzleActions(res.actions) + '. Play on, or Retry.');
			} else {
				const evalStones = (typeof res.stones === 'number') ? res.stones : res.score_ui * 39;
				comp.puzzleJudge = 'Engine: escapes the mate with ' + describePuzzleActions(res.actions) + ' (' + how + ', eval ' + evalStones.toFixed(1) + ' stones for it).';
				comp._puzzleFail('That lets the AI escape: it replies ' + describePuzzleActions(res.actions) + '. Puzzle failed — play on, or Retry.');
			}
		}
		return res.turn;
	}

	/**
	 * Winning-turn puzzles: the reply is the review search's best turn, and a
	 * turn off the stored solutions is judged by the same search -- its eval
	 * of the position after the turn, turned into the mover's win chance by
	 * the calibrated curves (position-rating.js) the puzzle was generated
	 * with. The turn counts if it keeps at least the puzzle's `accept_p`
	 * (midway between the solution and the best other turn).
	 */
	async _winningReply(board, color, onProgress) {
		const comp = this.component;
		const judging = comp && comp.puzzleStatus === 'playing' && comp._puzzleJudgePending;
		const sim = SimBoard.fromSigilBoard(board);
		const sfn = boardToSfn(sim);
		const worker = getRustEngineWorker();
		worker.post({ type: 'new_game', ttBits: 20 });
		const t0 = Date.now();
		let res = null;
		// A judgement needs a fitted curve (depth >= 4): retry longer, as
		// evaluateStartPosition does. A plain reply takes what it gets.
		for (let tms = this.timeMs, k = 0; k < (judging ? 3 : 1); k++, tms *= 2) {
			res = await worker.search(Object.assign({
				sfn, timeMs: tms, ttBits: 20, historySfns: [sfn],
				threads: typeof rustThreadCount === 'function' ? rustThreadCount() : 1,
			}, RUST_REVIEW_SEARCH));
			if (!res || res.ok === false) throw new Error('Rust engine error: ' + ((res && res.error) || 'unknown'));
			const proven = typeof res.mate_in === 'number' && res.mate_in !== 0 && res.mate_proven;
			if ((res.depth || 0) >= 4 || proven) break;
		}
		this.lastMeta = { depth: res.depth, stones: (typeof res.stones === 'number') ? res.stones : null,
			mateIn: res.mate_in, mateProven: res.mate_proven, timeMs: Date.now() - t0 };
		if (onProgress) onProgress(this.lastMeta);
		if (judging) {
			comp._puzzleJudgePending = false;
			const sign = sfn.split(' ')[1] === 'r' ? 1 : -1;      // searcher's POV -> red's
			const info = {
				depth: res.depth || 0,
				stones: typeof res.stones === 'number' ? res.stones * sign : null,
				mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
				proven: !!res.mate_proven,
			};
			const model = typeof loadPositionModel === 'function' ? await loadPositionModel() : null;
			const pRed = model ? positionRedWinProb(model, info, sfn) : null;
			const p = pRed === null ? null : (this.puzzle.mover === 'red' ? pRed : 1 - pRed);
			const need = typeof this.puzzle.accept_p === 'number' ? this.puzzle.accept_p : 0.7;
			const best = typeof this.puzzle.p_best === 'number' ? puzzlePct(this.puzzle.p_best) : null;
			if (p === null) {
				comp.puzzleJudge = 'Engine: could not search deep enough to judge (depth ' + (res.depth || 0) + ').';
				comp._puzzleFail('The engine could not judge that turn on this device. Retry, or show the solution.');
			} else if (p >= need) {
				comp.puzzleJudge = 'Engine: after your turn you win ' + puzzlePct(p) + ' of the time (depth ' + info.depth + ').';
				comp._puzzleSolve('Correct — not the stored solution, but the engine rates it as winning too.');
			} else {
				comp.puzzleJudge = 'Engine: after your turn you win ' + puzzlePct(p) + ' of the time (depth ' + info.depth + ')'
					+ (best ? '; the best turn keeps ' + best : '') + '. It replies ' + describePuzzleActions(res.actions) + '.';
				comp._puzzleFail('That lets the advantage slip. Play on, or Retry.');
			}
		}
		return rustActionsToTurn(sim, color, res.actions, res.expected_sfn);
	}
}
