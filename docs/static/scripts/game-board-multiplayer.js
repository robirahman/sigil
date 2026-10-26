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
			// Providence bank sizes (badge beside the dice).
			redBank: 0,
			blueBank: 0,
			activeSpell: '',
			activeSpellIsCastable: false,
			awaiting: '',
			blueSpellCounter: 0,
			blueLock: '',
			currentPlayer: '',
			lastPlay: '',
			message: '',
			messageHistory: [],
			nodes: Object.fromEntries(boardLayoutDef('core').nodeOrder.map(n => [n, null])),
			// Board layout state + position helpers (board-geometry.js).
			...boardLayoutMixin(),
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
			spells: { images: {}, text: {} },
			spellTooltip: {},
			validMoves: {},
			pushSourceNode: '',
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
			// Each side's vacation end (correspondence), from timer_tick.
			pausedUntil: { red: null, blue: null },
			isSpectator: false,
			// Rated / Casual badge, and why a casual room is unrated.
			ranked: false,
			unratedText: '',
			// Spectators watching, shown to the players.
			spectatorCount: 0,
			// This player's rating line once the server has rated the game.
			ratingText: '',

			// Game review state
			reviewMode: false,
			reviewIndex: 0,
			reviewSfns: [],
			reviewTurnLabels: [],

			// Auth manager bridged from the lobby script so the AI-review mixin
			// can fetch the current uid for community annotation writes.
			_authManager: null,

			// Share link
			shareUrl: '',
			linkCopied: false,

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
					if (this._rematchSpells && this._rematchSpells.length === BOARD.positionCount) {
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
			// A room from a position the opponent opened from this game's
			// review (rooms/<code>/rematch/positionRoom).
			opponentPositionRoom: '',

			// Connection state (controller 'sync_status' / 'opponent_presence'):
			// our own unsent moves, and since when the opponent has been gone
			// (server time, from their seat's disconnectedAt).
			syncConnected: true,
			syncPending: 0,
			syncError: null,
			opponentGoneSince: null,
			opponentOffline: false,
			gameAborted: false,
			_presenceTick: 0,
			_presenceTimer: null,
			get syncBanner() {
				if (this.isSpectator || this.winner || this.gameAborted) return '';
				if (this.syncError) return 'The server refused a move (' + this.syncError + '). Reload the page to resync.';
				if (!this.syncConnected) return this.syncPending
					? 'Connection lost. Reconnecting… your move will be sent when you are back online.'
					: 'Connection lost. Reconnecting…';
				return '';
			},
			// Completed turns so far (abort is offered until both players moved).
			turnsPlayed() {
				// The room's turns, not the controller's log: after a reload the
				// log holds only the turns since.
				const sync = this._engine && this._engine.sync;
				if (sync && sync._turnKeys) return sync._turnKeys.length;
				return (this._engine && this._engine._gameLog) ? this._engine._gameLog.length : 0;
			},
			get opponentAwayText() {
				void this._presenceTick;
				if (this.isSpectator || this.winner || this.gameAborted) return '';
				if (this.opponentGoneSince === null) return this.opponentOffline ? 'Your opponent is offline.' : '';
				if (this.timerType === 'correspondence') return 'Your opponent is offline.';
				const left = this.claimSecondsLeft();
				return left > 0
					? 'Your opponent disconnected. You can claim the game in ' + left + ' s if they do not come back.'
					: 'Your opponent has been gone for over a minute.';
			},
			claimSecondsLeft() {
				if (this.opponentGoneSince === null || !this._engine || !this._engine.sync) return Infinity;
				const gone = this._engine.sync.serverNow() - this.opponentGoneSince;
				return Math.max(0, Math.ceil((ABANDON_GRACE_MS - gone) / 1000));
			},
			get canClaimWin() {
				void this._presenceTick;
				return !this.isSpectator && !this.winner && !this.gameAborted && this.timerType !== 'correspondence'
					&& this.opponentGoneSince !== null && this.claimSecondsLeft() === 0 && this.turnsPlayed() >= 2;
			},
			get canAbort() {
				void this._presenceTick;
				return !this.isSpectator && !this.winner && !this.gameAborted && !this.reviewMode && !!this.whoseTurn
					&& this.turnsPlayed() < 2;
			},
			handleClaimWin() { if (this.canClaimWin) this.sendEvent('claim_win'); },
			// Takebacks by agreement ('takeback_state' from the controller).
			takebackRequest: null,
			takebackMine: false,
			get canRequestTakeback() {
				void this._presenceTick;
				const log = this._engine && this._engine._gameLog;
				// Not in correspondence games, nor a timed game's opening turns
				// (firebase-sync.js requestTakeback says why).
				const sync = this._engine && this._engine.sync;
				const tc = (sync && sync.timeControl) || {};
				if (tc.type === 'correspondence') return false;
				if (tc.type === 'realtime' && sync && sync._turnKeys && sync._turnKeys.length <= 2) return false;
				return !this.isSpectator && !this.winner && !this.gameAborted && !this.reviewMode && !this.takebackRequest
					&& !!log && log.some((t) => t.color === this.myColor);
			},
			handleTakebackRequest() { if (this.canRequestTakeback) this.sendEvent('takeback_request'); },
			handleTakebackCancel() { this.sendEvent('takeback_cancel'); },
			handleTakebackAccept() { this.sendEvent('takeback_accept'); },
			handleTakebackDecline() { this.sendEvent('takeback_decline'); },
			handleAbort() { if (this.canAbort) this.sendEvent('abort'); },
			// "On vacation until …" for each side on vacation (its clock is
			// stopped: room-clock.js pauses).
			get vacationText() {
				if (this.timerType !== 'correspondence' || this.winner || this.gameAborted) return '';
				const lines = [];
				for (const c of ['red', 'blue']) {
					const until = this.pausedUntil && this.pausedUntil[c];
					if (!until) continue;
					const d = new Date(until);
					const when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
					const who = !this.isSpectator && c === this.myColor ? 'You are'
						: ((c === 'red' ? this.redName : this.blueName) || (c === 'red' ? 'Red' : 'Blue')) + ' is';
					lines.push(who + ' on vacation until ' + when + '.');
				}
				return lines.join(' ');
			},
			// Give the opponent 15 s (live timed games).
			get canGiveTime() {
				return !this.isSpectator && this.timerType === 'realtime' && !this.winner && !this.gameAborted
					&& !this.reviewMode && !!this.whoseTurn;
			},
			handleGiveTime() { if (this.canGiveTime) this.sendEvent('give_time'); },

			// Preset emotes (SIGIL_EMOTES in firebase-sync.js): a picker beside
			// the clocks for the seated players, a bubble under the sender's
			// name for SIGIL_EMOTE_BUBBLE_MS, and a polite live-region line.
			// "Mute emotes" (settings panel) hides them all, picker included.
			emoteList: typeof SIGIL_EMOTES !== 'undefined' ? SIGIL_EMOTES : [],
			emotesMuted: typeof SigilSettings !== 'undefined' && !!SigilSettings.get('muteEmotes'),
			emoteMenuOpen: false,
			emoteCooling: false,
			emoteBubble: { red: '', blue: '' },
			emoteAnnounce: '',
			// After the game: "Well played" / "Thanks" for a while (the rules allow a minute).
			emoteAfterOpen: false,
			_emoteTimers: {},
			// Set once the game's controller exists (_engine is not declared
			// data, so a getter reading it would not update).
			emoteReady: false,
			get canEmote() {
				if (this.isSpectator || this.emotesMuted || this.reviewMode || this.gameAborted || !this.emoteReady) return false;
				if (this.myColor !== 'red' && this.myColor !== 'blue') return false;
				return !this.winner || this.emoteAfterOpen;
			},
			get availableEmotes() {
				return this.winner ? this.emoteList.filter((em) => em.after) : this.emoteList;
			},
			async sendEmote(id) {
				this.emoteMenuOpen = false;
				// The sync object as the lobby built it: through Alpine's proxy
				// (this._engine.sync) the SDK's references misbehave.
				const sync = window._multiplayerState && window._multiplayerState.sync;
				if (!this.canEmote || this.emoteCooling || !sync || typeof sync.sendEmote !== 'function') return;
				// The rules hold each seat to one emote per SIGIL_EMOTE_GAP_MS.
				this.emoteCooling = true;
				setTimeout(() => { this.emoteCooling = false; }, SIGIL_EMOTE_GAP_MS + 200);
				await sync.sendEmote(this.myColor, id);
			},
			_showEmote(v) {
				if (this.emotesMuted || !v || (v.color !== 'red' && v.color !== 'blue')) return;
				const em = this.emoteList.find((x) => x.id === v.e);
				if (!em) return;
				this.emoteBubble[v.color] = em.text;
				const side = v.color === 'red' ? 'Red' : 'Blue';
				const name = v.color === 'red' ? this.redName : this.blueName;
				const who = v.color === this.myColor ? 'You' : (name ? name + ' (' + side + ')' : side);
				// Empty the live region first, so a repeat of the same line is
				// still a change and is read out again.
				const line = who + ': ' + em.text;
				this.emoteAnnounce = '';
				setTimeout(() => { if (!this.emotesMuted) this.emoteAnnounce = line; }, 100);
				clearTimeout(this._emoteTimers[v.color]);
				this._emoteTimers[v.color] = setTimeout(() => {
					this.emoteBubble[v.color] = '';
					if (this.emoteAnnounce === line) this.emoteAnnounce = '';
				}, SIGIL_EMOTE_BUBBLE_MS);
			},
			// The rules take "Well played" / "Thanks" until a minute after the
			// room's closedAt (server time): offer them for what is left of
			// that, less a margin, however late this page heard of the end.
			async _openAfterGameEmotes() {
				const sync = window._multiplayerState && window._multiplayerState.sync;
				if (!sync || !sync.roomRef || this.isSpectator) return;
				let closedAt = null;
				for (let i = 0; i < 10 && typeof closedAt !== 'number'; i++) {
					try { closedAt = (await sync.roomRef.child('closedAt').once('value')).val(); } catch (e) { return; }
					if (typeof closedAt !== 'number') await new Promise((r) => setTimeout(r, 1000));
				}
				if (typeof closedAt !== 'number') return;
				const left = closedAt + SIGIL_EMOTE_AFTER_MS - 5000 - sync.serverNow();
				if (left <= 0) return;
				this.emoteAfterOpen = true;
				clearTimeout(this._emoteAfterTimer);
				this._emoteAfterTimer = setTimeout(() => { this.emoteAfterOpen = false; this.emoteMenuOpen = false; }, left);
			},
			setEmotesMuted(on) {
				this.emotesMuted = !!on;
				if (!on) return;
				this.emoteMenuOpen = false;
				this.emoteBubble.red = '';
				this.emoteBubble.blue = '';
				this.emoteAnnounce = '';
			},

			// Review: open an online room from the reviewed position. The new
			// room is offered to the opponent through this room's rematch node.
			get canPlayFromPosition() {
				if (!this.reviewMode || !this.reviewSfns[this.reviewIndex]) return false;
				return !(this.winner && this.reviewIndex >= this.reviewSfns.length - 1);
			},
			playFromPosition() {
				if (!this.canPlayFromPosition || this.reviewReplaying) return;
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
					if (this._roomCodeForReview && !this.isSpectator) {
						sessionStorage.setItem('sigil_position_from_room',
							JSON.stringify({ code: this._roomCodeForReview, color: this.myColor }));
					}
				} catch (e) { /* sessionStorage blocked */ }
				window.location.href = 'multiplayer.html?sfn=' + encodeURIComponent(sfn);
			},

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

			// AI evaluation overlay (gated on the isDeveloper/showAiEval flags
			// passed in via window._multiplayerState). Same pattern as
			// game-board-local; see that file for the design rationale.
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
						if (this._devEvalSearchId != null) { try { worker.cancel(this._devEvalSearchId); } catch (e) {} }
						const promise = worker.search(boardToSfn(board), stm, opts, null);
						if (!promise) { if (seq === this._devEvalSeq) this.devEvalLoading = false; return; }
						this._devEvalSearchId = promise.searchId;
						const msg = await promise;
						if (seq !== this._devEvalSeq) return;  // superseded by a newer recompute
						this._devEvalSearchId = null;
						score = msg.score;
					} else {
						const result = await cavemanSearch(SimBoard.fromSigilBoard(board), stm, opts);
						if (seq !== this._devEvalSeq) return;
						score = result.score;
					}
					this.devEvalLoading = false;
					// Mover-POV score → red POV; clamp the forced-win sentinel.
					let v = (stm === 'red') ? score : -score;
					if (v > 1) v = 1; else if (v < -1) v = -1;
					this.devEvalValue = v;
				} catch (e) {
					if (seq === this._devEvalSeq) this.devEvalLoading = false;
				}
			},

			// Map-control readout: how many nodes each side's stones are
			// strictly closer to (multi-source BFS; Fissure walls impassable
			// and excluded — see features.js mapControl). Same pattern as
			// game-board-local; cheap and synchronous, no toggle or worker.
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

			startReview() {
				if (this.reviewSfns.length === 0) return;
				this.reviewMode = true;
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},
			// Populate spell setup from spellNames (same mapping as engine).
			_applyReviewSpellSetup(spellNames) {
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
			},
			// Degraded review for records whose transcript can't be replayed
			// by the current engine version: show the final position only.
			_initReviewFinalOnly(spellNames, finalSfn, winner) {
				spellNames = normalizeSpellNames(spellNames);
				this._applyReviewSpellSetup(spellNames);
				this.reviewSfns = [finalSfn];
				this.reviewTurnLabels = ['Final position'];
				this.winner = winner || '';
				this._spellNamesForExport = (spellNames || []).slice();
				this.messageHistory.push("Couldn't replay this game with the current engine version — showing the final position only.");
				this.reviewMode = true;
				this.reviewIndex = 0;
				this._showReviewPosition();
			},
			async _initReviewMode(spellNames, gameLog, winner, variant, finalSfn, setupSfn) {
				spellNames = normalizeSpellNames(spellNames);
				if (!gameLog || gameLog.length === 0) {
					this.messageHistory.push('No game log available for review.');
					return;
				}
				// Slim (post-refactor) records carry action transcripts only —
				// hydrateGameLog rebuilds the per-ply positions by replay;
				// legacy fat records pass through it untouched.
				try {
					gameLog = await hydrateGameLog(
						spellNames, variant, setupSfn, finalSfn, gameLog);
				} catch (e) {
					console.warn('Room transcript replay failed:', e);
					if (finalSfn) {
						gameLog = [];
						this._initReviewFinalOnly(spellNames, finalSfn, winner);
					} else {
						this.messageHistory.push('Could not rebuild this game for review.');
					}
					return;
				}
				this._applyReviewSpellSetup(spellNames);

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
			// Animated replay state + navigation, mirroring game-board-local.js.
			// reviewReplaying guards every entry point while one turn's animation
			// is in flight (buttons are disabled too, but arrow keys and the
			// eval-chart click bypass the disabled attribute); clearing
			// reviewAutoplay stops the playthrough after the animating turn.
			reviewReplaying: false,
			reviewAutoplay: false,
			get reviewCanReplay() {
				const log = this._gameLogForExport;
				return !!(log && log.length && typeof this._animateReviewTurn === 'function');
			},
			reviewPrev() {
				if (this.reviewReplaying) return;
				this.reviewAutoplay = false;
				if (this.reviewIndex > 0) { this.reviewIndex--; this._showReviewPosition(); }
			},
			// Stepping FORWARD animates the turn exactly as it played live, then
			// snaps to the stored after-state; instant flip when no transcript.
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
			// Whole-game playthrough from the current position (from the start
			// when already at the end); toggling again pauses after the turn
			// currently animating.
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
				this.reviewIndex = this.reviewSfns.length - 1;
				this._showReviewPosition();
			},
			_showReviewPosition() {
				const sfn = this.reviewSfns[this.reviewIndex];
				if (!sfn) return;
				const state = sfnToDict(sfn);
				for (const node of Object.keys(this.nodes)) { this.nodes[node] = state.stones[node] || null; }
				this.redSpellCounter = state.red_spellcounter || 0;
				this.redBank = state.red_bank || 0;
				this.blueBank = state.blue_bank || 0;
				this.blueSpellCounter = state.blue_spellcounter || 0;
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
				if (this.spellTooltip && this.spellTooltip.destroy) this.spellTooltip.destroy();
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
			handleSkipProvidence() { if (this.isSpectator) return; this.sendEvent('skip_providence'); this.actionList = []; },
			// Armed by a first End Turn when "Confirm before ending a turn" is on (confirmEndTurn, game-keys.js).
			endTurnArmed: false,
			_endTurnTimer: null,
			handleEndTurn() { if (this.isSpectator) return; if (!confirmEndTurn(this)) return; this.sendEvent('pass'); this.actionList = []; },
			nodeLabel(node) { return nodeAriaLabel(this, node); },
			handleSubmit() { if (this.isSpectator) return; this.sendEvent('submit'); this.actionList = []; },
			// Two-click forfeit, mirroring game-board-local.js: first click arms
			// (relabels to confirm), second concedes; arming decays on its own so
			// a stray click can't leave a live one-click forfeit sitting around.
			forfeitArmed: false,
			_forfeitTimer: null,
			handleForfeit() {
				if (this.isSpectator) return;
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
			// A short grace lets the pointer reach the tooltip's "More about this spell" link (holdSpellTooltip).
			handleSpellMouseOut() { if (!this.hasTouchScreen) { clearTimeout(this._spellTooltipTimer); this._spellTooltipTimer = setTimeout(() => { this.activeSpell = ''; if (this.spellTooltip.destroy) this.spellTooltip.destroy(); }, 250); } },
			handleSpellMouseOver(spell) { if (!this.hasTouchScreen) { clearTimeout(this._spellTooltipTimer); this.showSpellTooltip(spell); } },
			holdSpellTooltip() { clearTimeout(this._spellTooltipTimer); },

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
			handleReset() { if (this.isSpectator) return; this.endTurnArmed = false; this.sendEvent('reset'); this.actionList = []; this.lastPlay = ''; this.nodesToRefill = {}; this.playerToRefill = ''; this.showReset = false; this.validMoves = {}; this.pushSourceNode = ''; drawPushArrows(this.$refs.pushArrows, []); },
			handleNodeClick(node) {
				if (this.isSpectator) return;
				this.currentPlayer = this.whoseTurn;
				if (this.awaiting === 'node') this.sendEvent(node);
				else if (this.awaiting === 'action' && (this.actionList.includes('move') || this.actionList.includes('providence'))) this.sendEvent(node);
			},

			// Spread the shared AI-review behaviour (game-review.js), then
			// override the uid hook to point at this page's auth manager.
			...aiReviewMixin(),
			_aiReviewGetUid() {
				return this._authManager && this._authManager.uid;
			},

			init() {
				const _this = this;
				_this.hasTouchScreen = matchMedia('(any-pointer: coarse)').matches;
				// A new prompt (Reset Turn, a cast) cancels an armed End Turn.
				_this.$watch('actionList', () => { _this.endTurnArmed = false; });
				_this.$watch('messageHistory', () => {
					_this.$nextTick(() => { if (_this.$refs.messageHistory) _this.$refs.messageHistory.scrollTop = _this.$refs.messageHistory.scrollHeight; });
				});

				// Wait for multiplayer state to be set by the lobby
				const waitForState = setInterval(() => {
					if (!window._multiplayerState) return;
					clearInterval(waitForState);
					const state = window._multiplayerState;
					const { sync, spellNames, myColor, reconnectSfn, isSpectator, timeControl, variant, redDisplayName, blueDisplayName, redUid, blueUid, annotationMode, reviewMode, gameLog, winner, shareUrl, roomCode, authManager } = state;

					// Set player names and timer type
					_this.redName = redDisplayName || '';
					_this.blueName = blueDisplayName || '';
					_this.redUid = redUid || '';
					_this.blueUid = blueUid || '';
					_this.timerType = (timeControl && timeControl.type) || 'none';
					_this.isSpectator = isSpectator || false;
					_this.myColor = myColor || '';
					_this.ranked = !!state.ranked;
					_this.unratedText = state.ranked ? '' : describeUnratedReason(state.unratedWhy);
					_this.annotationMode = !!annotationMode && !_this.isSpectator;
					_this.isDeveloper = !!state.isDeveloper;
					_this.showAiEval = !!state.showAiEval;
					_this.showMapControl = !!state.showMapControl;
					_this.shareUrl = shareUrl || '';
					_this._rematchSpells = Array.isArray(spellNames) ? spellNames.slice() : [];
					_this._rematchTimeControl = timeControl ? Object.assign({}, timeControl) : null;
					_this._rematchVariant = normalizeVariant(variant);
					// The help popover's "This game's rules" (help.js).
					if (typeof sigilPublishGameRules === 'function') sigilPublishGameRules(variant, spellNames);
				_this.isDeathmatch = variantHasDeathmatch(variant);
					// The room's variant names its board layout; switch before
					// the engine or the review draws anything.
					_this.applyBoardLayout(variantBoardLayout(variant));
					if (variantHasScramble(variant) && !reviewMode) {
						_this.messageHistory.push('Scramble: there is no stone-lead win. The first player to cast ' + BOARD.spellTarget + ' spells wins.');
					}
					// AI-review wiring: roomCode is the gameId used for the shared
					// Firebase review cache, and authManager exposes the uid for
					// community-annotation writes.
					_this._roomCodeForReview = roomCode || '';
					_this._authManager = authManager || null;

					if (reviewMode) {
						// Skip engine entirely — render finished game in review mode
						_this.sendEvent = function() {};
						_this._initReviewMode(spellNames || [], gameLog || [], winner || null,
							normalizeVariant(variant), state.finalSfn || null, state.setupSfn || null);
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
					if (sync && typeof sync.listenForEmotes === 'function') sync.listenForEmotes((v) => _this._showEmote(v));
					_this.emoteReady = true;
					if (!isSpectator && sync) sync.listenToSpectators((n) => { _this.spectatorCount = n; });
					// A spectator who arrives before the first move of a room
					// from a position replays from its start.
					engine.startGame(reconnectSfn || (isSpectator && sync && sync.startSfn) || null);
				}, 100);

				// Keyboard shortcuts (game-keys.js, shared with game.html)
				bindGameKeys(_this, { disabled: () => _this.isSpectator });
				// Leaving a live game asks first (game-keys.js). Correspondence
				// games are left between moves by design, so they don't ask.
				// typeof: a stale cached game-keys.js must not break the game.
				if (typeof guardLeavingGame === 'function') guardLeavingGame(
					() => !_this.isSpectator && !_this.winner && !_this.gameAborted && !_this.reviewMode
						&& !!_this.whoseTurn && _this.timerType !== 'correspondence',
					() => 'The game goes on without you: ' + (_this.timerType === 'none' ? '' : 'your clock keeps running, and ')
						+ 'after ' + Math.round(ABANDON_GRACE_MS / 1000) + ' s away your opponent can claim the win.');

				// Arrows and circles (board-marks.js), never sent to the
				// opponent. Play keeps one set, cleared at the end of each
				// turn; review keeps one per move. Spectators draw too.
				const _marksStones = _this.$el.querySelector('.stone-nodes');
				_this.boardMarks = (typeof attachBoardMarks === 'function' && _marksStones)
					? attachBoardMarks(_marksStones.parentElement) : null;
				if (_this.boardMarks) {
					const follow = () => _this.boardMarks.setKey(_this.reviewMode ? 'review:' + _this.reviewIndex : 'play');
					_this.$watch('reviewMode', follow);
					_this.$watch('reviewIndex', follow);
					follow();
				}

				let _turnCount = 0;
				// A repeated turn header is a Reset Turn replay (the controller
				// re-announces "Red Turn N" after restoring the snapshot): drop the
				// aborted attempt's messages so the transcript only keeps final,
				// submitted moves. Mirrors game-board-local.js.
				let _turnMsgMark = -1;
				let _turnMsgText = null;

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
				 * Animated replay of review turn `i`, mirroring game-board-local.js:
				 * rebuild the turn from its stored transcript through the real engine
				 * (reconstructGameLog) on a throwaway board. Board/animation events
				 * are forwarded through handleIncomingEvent; replay narration goes to
				 * the prompt line, NOT messageHistory. sfn_update / turn_complete /
				 * game_over / timer and rematch events stay ours — the replay must
				 * never touch the live game record or room state.
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
					// The boardstate diff baseline belongs to the live game; reset it
					// so the replay's first snapshot applies in full against whatever
					// position is currently displayed.
					_this.previousBoardState = {};
					// Replayed placements must never re-arm the Reset button
					// (the new_stone branch keys off currentPlayer for that).
					_this.currentPlayer = '';
					const label = _this.reviewTurnLabels[i + 1] || '';
					if (label) _this.message = 'Replaying ' + label;
					const emit = (ev) => {
						if (!ev || !ev.type) return;
						if (ev.type === 'boardstate' || ev.type === 'new_stone_animation'
							|| ev.type === 'push_animation' || ev.type === 'crush_animation'
							|| ev.type === 'push_arrows') {
							handleIncomingEvent(ev);
						} else if (ev.type === 'message' && ev.message) {
							_this.message = ev.message;
							maybeSpellFx(ev.message);
						}
					};
					await reconstructGameLog(spellNames, variant, sfnBefore, [t], { emit, paceMs: 450 });
					// Let the last animation land before the caller snaps to the
					// stored after-state (which also corrects any drift).
					await new Promise(r => setTimeout(r, 450));
					if (label) _this.message = label;
					return true;
				};

				function handleIncomingEvent(payload) {
					const { type, ...rest } = payload;
					if (type === 'message') {
						_this.actionList = rest.actionlist || []; _this.awaiting = rest.awaiting; _this.message = rest.message; if (rest.moveoptions) _this.validMoves = rest.moveoptions;
						// Spell cast sound + visual effect
						maybeSpellFx(_this.message);
						if (_this.awaiting !== 'action' && rest.message) _this.messageHistory.push(rest.message);
					}
					else if (type === 'spellsetup') { _this.spellDict = rest; Object.entries(rest).forEach(([k, v]) => { _this.spells.images[k] = `static/images/spells/${baseSpellName(v)}.png`; }); }
					else if (type === 'spelltextsetup') { _this.spells.text = rest; }
					else if (type === 'sfn_update') { _this.currentSfn = rest.sfn; }
					else if (type === 'boardstate') {
						const changed = Object.keys(rest).reduce((acc, c) => { if (rest[c] !== _this.previousBoardState[c]) acc[c] = rest[c]; return acc; }, {});
						// Non-node payload fields must be destructured out or the
					// ...nodes rest treats them as node names.
					const { bluelock, bluespellcounter, last_play, last_player, redlock, redspellcounter, score, redbank, bluebank, ...nodes } = changed;
						Object.keys(nodes).forEach(n => { _this.nodes[n] = nodes[n]; });
						if (bluelock !== undefined) _this.blueLock = bluelock;
						if (bluespellcounter !== undefined) _this.blueSpellCounter = bluespellcounter;
						if (redlock !== undefined) _this.redLock = redlock;
						if (redspellcounter !== undefined) _this.redSpellCounter = redspellcounter;
						if (score !== undefined) _this.score = score;
						if (redbank !== undefined) _this.redBank = redbank;
						if (bluebank !== undefined) _this.blueBank = bluebank;
						_this.previousBoardState = rest;
						_this._recomputeMapControl();
						if (_this.devEvalEnabled) {
							_this._recomputeDevEval().catch(() => {});
						}
					}
					else if (type === 'whoseturndisplay') {
						_this.showReset = false;
						if (rest.message === _turnMsgText
							&& _turnMsgMark >= 0 && _turnMsgMark <= _this.messageHistory.length) {
							_this.messageHistory.splice(_turnMsgMark);
						}
						_turnMsgMark = _this.messageHistory.length;
						_turnMsgText = rest.message;
						_this.messageHistory.push(rest.message);
						_this.whoseTurn = rest.color;
						if (typeof soundManager !== 'undefined' && _turnCount === 0) soundManager.play('gameStart');
						_turnCount++;
					}
					else if (type === 'turn_complete') {
						drawPushArrows(_this.$refs.pushArrows, []);
						if (_this.boardMarks && !_this.reviewMode) _this.boardMarks.clear();
						// Track the most recent opponent turn for annotation eligibility.
						const t = rest.turn;
						if (t && t.color && t.color !== _this.myColor) {
							_this.lastOpponentTurn = { turnNumber: t.turnNumber, color: t.color };
						}
					}
					else if (type === 'new_stone_animation') { if (typeof soundManager !== 'undefined') soundManager.play('stonePlaced'); _this.lastPlay = rest.node; if (rest.color !== _this.currentPlayer) { setTimeout(() => { const el = document.getElementById(`stone-node--${rest.node}`); if (el) el.scrollIntoView({ behavior: sigilScrollBehavior(), block: 'center', inline: 'center' }); }, 50); } else { _this.showReset = true; } }
					else if (type === 'push_animation') {
						_this.pushSourceNode = '';
						if (typeof soundManager !== 'undefined') soundManager.play('stonePushed');
						const s = document.querySelector(`#stone-node--${rest.starting_node}`), e = document.querySelector(`#stone-node--${rest.ending_node}`);
						if (s && e) { const sr = s.getBoundingClientRect(), er = e.getBoundingClientRect(); e.style.transition = 'transform 0s'; e.style.transform = `translate(${sr.x-er.x}px, ${sr.y-er.y}px)`; setTimeout(() => { e.style.transition = 'transform 750ms ease-in-out'; e.style.transform = ''; }, 50); }
					}
					else if (type === 'crush_animation') { if (typeof soundManager !== 'undefined') soundManager.play('stoneCrushed'); const ne = document.querySelector(`#stone-node--${rest.node}`); if (ne) { const cs = document.createElement('button'); cs.setAttribute('class', `stone-node stone-node--crushed stone-node--${rest.node} stone-node--${rest.crushed_color}`); cs.style.cssText = ne.style.cssText; cs.addEventListener('animationend', () => cs.remove()); ne.parentNode.insertBefore(cs, ne); } }
					else if (type === 'chooserefills') { const { playercolor, ...n } = rest; _this.nodesToRefill = n; _this.playerToRefill = playercolor; }
					else if (type === 'donerefilling') { _this.nodesToRefill = {}; _this.playerToRefill = ''; }
					else if (type === 'push_arrows') { drawPushArrows(_this.$refs.pushArrows, rest.arrows); }
					else if (type === 'pushingoptions') { const { sourceNode, ...targets } = rest; _this.pushSourceNode = sourceNode || ''; _this.validMoves = targets; }
					else if (type === 'timer_tick') {
						_this.redTimer = rest.red; _this.blueTimer = rest.blue;
						const p = rest.paused || {};
						if (p.red !== _this.pausedUntil.red || p.blue !== _this.pausedUntil.blue) _this.pausedUntil = { red: p.red || null, blue: p.blue || null };
					}
					else if (type === 'time_gift') { _this.messageHistory.push(rest.mine ? 'You gave your opponent 15 seconds.' : 'Your opponent gave you 15 seconds.'); }
					else if (type === 'rematch_state_changed') {
						const r = rest.rematch || {};
						const myColor = _this.myColor;
						const opponentColor = myColor === 'red' ? 'blue' : 'red';
						_this.selfOfferedRematch = r[myColor] === 'offered';
						_this.opponentOfferedRematch = r[opponentColor] === 'offered';
						_this.rematchPending = !!r.newRoomCode;
						const pr = r.positionRoom;
						_this.opponentPositionRoom = (pr && pr.code && pr.by !== myColor) ? pr.code : '';
					}
					else if (type === 'rematch_room_ready') {
						window.location.href = 'multiplayer.html?id=' + encodeURIComponent(rest.newRoomCode);
					}
					else if (type === 'rating_result') {
						_this.ratingText = rest.text;
						_this.messageHistory.push(rest.text);
					}
					else if (type === 'opponent_disconnect') {
						_this.rematchOpponentDisconnected = true;
					}
					else if (type === 'sync_status') {
						_this.syncConnected = rest.connected;
						_this.syncPending = rest.pending;
						_this.syncError = rest.error || null;
					}
					else if (type === 'opponent_presence') {
						const wasGone = _this.opponentGoneSince !== null;
						// Only the server's stamp counts (the rating function judges a
						// claim by it): an older client's seat without one shows as
						// offline but never offers Claim win.
						_this.opponentGoneSince = rest.connected ? null : (rest.disconnectedAt || null);
						_this.opponentOffline = !rest.connected;
						if (wasGone && rest.connected && !_this.winner) _this.messageHistory.push('Your opponent reconnected.');
						// A one-second tick while they are gone drives the countdown.
						clearInterval(_this._presenceTimer);
						if (_this.opponentGoneSince !== null) {
							_this._presenceTimer = setInterval(() => { _this._presenceTick++; }, 1000);
						}
					}
					else if (type === 'takeback_state') {
						_this.takebackRequest = rest.request || null;
						_this.takebackMine = !!rest.mine;
					}
					else if (type === 'takeback_done') {
						// The room lost its last turns: rebuild from it (by its
						// link: the creator's page may not carry it yet).
						window.onbeforeunload = null;
						if (_this._roomCodeForReview) {
							window.location.href = 'multiplayer.html?id=' + encodeURIComponent(_this._roomCodeForReview);
						} else {
							window.location.reload();
						}
					}
					else if (type === 'game_aborted') {
						_this.gameAborted = true;
						_this.actionList = [];
						clearInterval(_this._presenceTimer);
					}
					else if (type === 'game_over') {
						// A settled result replaces a provisional abort.
						_this.gameAborted = false;
						drawPushArrows(_this.$refs.pushArrows, []);
						if (typeof soundManager !== 'undefined') soundManager.play('gameOver');
						_this.messageHistory.push(`Game over! ${rest.winner === 'blue' ? 'Blue' : 'Red'} wins${rest.endReason === 'time' ? ' on time' : ''}`);
						_this.showReset = false;
						_this.winner = rest.winner;
						_this._openAfterGameEmotes();
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
