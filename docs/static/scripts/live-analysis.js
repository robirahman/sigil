/**
 * Live engine analysis: the Rust wasm engine searches the position on the
 * board for as long as the panel is on, and its eval, depth, best turn and
 * expected reply update as the search deepens -- the "engine on" switch of a
 * chess site's analysis view, on the game pages.
 *
 * Who may switch it on (liveAnalysisAccess):
 *   - anyone, in the review of a FINISHED game (multiplayer.html, game.html);
 *     nothing is at stake, and the review's Analyse button already opens the
 *     same position on the analysis board;
 *   - accounts with the developer flag (users/<uid>/isDeveloper, set by
 *     ai/set_developer.py), while SPECTATING an online game in progress, as
 *     long as they are not one of its players.
 * Never a seated player during their own game, and never a spectator without
 * the flag: anyone could watch their own game from a second tab, so live
 * analysis there would be an engine on tap. The gate is the page's (the
 * engine runs in the viewer's browser, so nothing server-side can enforce
 * it), as for the other developer-only readouts.
 *
 * The search: one dedicated engine worker (its own table, apart from the AI
 * review's) searches the side-to-move form of the position in growing
 * slices (LIVE_ANALYSIS_STEPS_MS). A wasm search cannot be interrupted, so
 * each slice is one call; the table carries over, so every slice starts
 * where the last one stopped (the analysis board's scheme), and the depth
 * ticks between slices come from the per-depth progress messages. After each
 * slice the best turn is replayed (the replay gate rustActionsToTurn uses,
 * with the end-of-turn Seal of Destruction burn) and the position after it
 * searched briefly for the expected reply. A new position terminates the
 * worker mid-slice (the only way to stop a wasm call) and starts afresh.
 *
 * Hosts (game-board-multiplayer.js, game-board-local.js) spread
 * liveAnalysisMixin() into their component and provide:
 *   canLiveAnalyse            getter: true when the viewer may switch it on
 *   _liveAnalysisTarget()     { sfn, earlier, winner, label } or null, where
 *                             sfn is the position as the board records it (a
 *                             loadable / after-turn SFN), earlier the game's
 *                             positions before it (repetition), winner the
 *                             result when the game ended there
 * and call liveAnalysisRefresh() when the position or the access changes.
 */

// Search slices (ms) per position: ~2 minutes in all, then "Go deeper" adds
// LIVE_ANALYSIS_MORE_STEPS_MS. Short first slices so a new turn reads at
// once; each later slice only reports at its end (the depth meter ticks).
const LIVE_ANALYSIS_STEPS_MS = [250, 600, 1200, 2500, 5000, 8000, 12000, 16000, 20000, 25000, 30000];
const LIVE_ANALYSIS_MORE_STEPS_MS = [30000, 30000, 30000, 30000];
const LIVE_ANALYSIS_TT_BITS = 20;
// The expected-reply probe after each slice: a fraction of the slice, as
// the reply position is mostly in the table already.
const LIVE_ANALYSIS_REPLY_FRACTION = 0.1;
const LIVE_ANALYSIS_REPLY_MIN_MS = 150;
const LIVE_ANALYSIS_REPLY_MAX_MS = 2000;
// Rows kept in the "how the assessment changed" list.
const LIVE_ANALYSIS_MAX_LINES = 8;

/**
 * May this viewer switch live analysis on?
 *   reviewMode   reviewing a finished game
 *   isSpectator  watching an online game without a seat
 *   isDeveloper  the account's developer flag
 *   viewerUid    the signed-in uid (null for none)
 *   playerUids   the game's seated uids
 */
function liveAnalysisAccess(o) {
	o = o || {};
	if (o.reviewMode) return true;
	if (!o.isSpectator || !o.isDeveloper) return false;
	return !(o.viewerUid && (o.playerUids || []).includes(o.viewerUid));
}

/** "Red 3" / "Blue 5": whose turn a side-to-move SFN is, numbered as the
 *  review labels them. */
function liveAnalysisTurnLabel(searchSfn) {
	const p = String(searchSfn || '').trim().split(/\s+/);
	const tc = parseInt(p[2], 10) || 0;
	const red = p[1] === 'r';
	return red ? 'Red ' + (Math.floor(tc / 2) + 1) : 'Blue ' + Math.floor(tc / 2);
}

/** Why the engine cannot search this (loadable) position, or null. The
 *  variants and packs the engine does not implement, as on the analysis
 *  board. */
function liveAnalysisBlocker(sfn) {
	let d;
	try { d = sfnToDict(sfn); } catch (e) { return 'the position could not be read'; }
	if (typeof variantHasPentagon === 'function' && variantHasPentagon(d.variant)) return 'the engine does not play the Cataclysm board';
	if (typeof variantHasDuplicates === 'function' && variantHasDuplicates(d.variant)) return 'the engine does not play the Allow Duplicates variant';
	if (typeof variantHasScramble === 'function' && variantHasScramble(d.variant)) return 'the engine does not play the Scramble variant';
	if ((d.spell_names || []).some(n => typeof isUnratedSpell === 'function' && isUnratedSpell(n))) return 'the engine does not play the Panda or Experimental spells';
	if (typeof rustReviewAvailable === 'function' && !rustReviewAvailable()) return 'this browser cannot run the engine';
	if (typeof RustEngineWorker !== 'function') return 'the engine is not loaded on this page';
	return null;
}

/** Human-readable rendering of an engine (applyAITurn) action list. Shared
 *  by the puzzles page, the analysis board, SigilBench and live analysis. */
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

/** The nodes an engine turn plays on (where it moves, blinks, pushes to),
 *  for the board highlight: { node: true }. */
function liveAnalysisHintNodes(actions) {
	const out = {};
	for (const a of (Array.isArray(actions) ? actions : [])) {
		if (!a) continue;
		if (a.type === 'move' || a.type === 'blink' || a.type === 'hard_move') {
			if (a.node) out[a.node] = true;
		}
	}
	return out;
}

/**
 * Replay an engine turn on the position it was found in and return the
 * position after it as the next search's input: { sfn, winner }. The same
 * replay as rustActionsToTurn's gate (it throws when the actions do not
 * reproduce `expectedSfn`), plus the end-of-turn Seal of Destruction burn
 * the controller applies next.
 */
async function liveAnalysisAfter(searchSfn, mover, actions, expectedSfn) {
	const sim = sfnToSimBoard(searchSfn);
	await rustActionsToTurn(sim, mover, actions, expectedSfn);
	const probe = sim.copy();
	probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
	probe.getBoardStatePayload = () => ({});
	await applyAITurn(probe, { actions: actions }, mover, () => {});
	probe.update();
	if (typeof sealOfDestructionBurn === 'function') sealOfDestructionBurn(probe, mover);
	probe.checkGameOver(mover);
	if (probe.gameover) return { sfn: null, winner: probe.winner || mover };
	probe.turnCounter++;
	probe.whoseTurn = mover === 'red' ? 'blue' : 'red';
	probe.update();
	return { sfn: boardToSfn(probe), winner: null };
}

/** The winner when a loadable SFN is already decided, else null (as the
 *  analysis board judges it). */
function liveAnalysisDecided(sfn) {
	try {
		const d = sfnToDict(sfn);
		const b = new SigilBoard(d.spell_names, normalizeVariant(d.variant));
		b.loadFromSfn(sfn);
		b.variant = normalizeVariant(d.variant);
		if (!b.gameover) {
			const tc = b.turnCounter;
			if (tc > 0) b.checkGameOver(tc % 2 === 1 ? 'red' : 'blue');
		}
		return b.gameover ? (b.winner || null) : null;
	} catch (e) {
		return null;
	}
}

/** An engine result's eval in red's view, the shape describePositionEval
 *  and positionRedWinProb read; null when no depth completed. */
function liveAnalysisInfo(res, mover) {
	if (!res || (typeof res.stones !== 'number' && typeof res.mate_in !== 'number')) return null;
	const sign = mover === 'red' ? 1 : -1;
	return {
		depth: res.depth || 0,
		stones: typeof res.stones === 'number' ? res.stones * sign : null,
		mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
		proven: res.mate_in == null ? true : !!res.mate_proven,
	};
}

/** "1.2M" style node count. */
function liveAnalysisNodes(n) {
	if (!(n > 0)) return '0';
	if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
	return String(Math.round(n));
}

// The page's live-analysis engine: its own worker, so the AI review and the
// analysis board's shared worker keep theirs. Module-level rather than on the
// component: Alpine would wrap it in a reactive proxy, and a Worker's methods
// refuse a proxied `this`.
let _liveAnalysisEngine = null;
function liveAnalysisEngine() {
	if (!_liveAnalysisEngine) _liveAnalysisEngine = new RustEngineWorker();
	return _liveAnalysisEngine;
}

function liveAnalysisIdleState() {
	return {
		status: 'off',      // off | waiting | searching | done | decided | unavailable | error
		label: '',          // "Blue 5": the turn being analysed
		text: '',           // "+1.2" / "Red wins in 3"
		side: '',           // 'red' | 'blue' | '' (who the eval favours)
		odds: '',           // "Red wins 64%"
		pRed: null,         // P(red wins), for the bar
		depth: 0,           // last completed depth with a result
		liveDepth: 0,       // depth of the slice running now
		nodes: 0,           // all nodes searched for this position
		timeMs: 0,
		best: null,         // the best turn's actions
		bestText: '',
		replyText: '',
		lines: [],          // [{ depth, text, side, bestText }], newest first
		note: '',
		searchSfn: '',
	};
}

function liveAnalysisMixin() {
	return {
		liveAnaOn: false,
		liveAna: liveAnalysisIdleState(),
		liveAnaHintNodes: {},
		_liveAnaGen: 0,
		_liveAnaTimer: null,
		_liveAnaSearching: false,
		_liveAnaKey: '',

		/** The panel's switch. */
		toggleLiveAnalysis() {
			if (!this.liveAnaOn && !this.canLiveAnalyse) return;
			this.liveAnaOn = !this.liveAnaOn;
			if (this.liveAnaOn && typeof loadPositionModel === 'function') loadPositionModel();
			this.liveAnalysisRefresh(true);
		},

		/** (Re)start for the position on the board, unless it is the one
		 *  already being analysed (`force` restarts anyway). */
		liveAnalysisRefresh(force) {
			if (!this.liveAnaOn || !this.canLiveAnalyse) {
				if (this.liveAnaOn && !this.canLiveAnalyse) this.liveAnaOn = false;
				this._liveAnaStop();
				// Off: let the worker (and its table) go; switching on again
				// starts a fresh one.
				if (_liveAnalysisEngine) _liveAnalysisEngine.cancel();
				this.liveAna = liveAnalysisIdleState();
				this.liveAnaHintNodes = {};
				return;
			}
			const t = typeof this._liveAnalysisTarget === 'function' ? this._liveAnalysisTarget() : null;
			const key = t && t.sfn ? (t.sfn + '|' + (t.winner || '') + '|' + (t.earlier || []).length) : '';
			if (!force && key && key === this._liveAnaKey) return;
			this._liveAnaKey = key;
			this._liveAnaStart(t);
		},

		/** Another round of slices on the same position (the table is kept). */
		liveAnalysisDeeper() {
			if (!this.liveAnaOn || this.liveAna.status !== 'done' || !this.liveAna.searchSfn) return;
			const t = typeof this._liveAnalysisTarget === 'function' ? this._liveAnalysisTarget() : null;
			if (!t || !t.sfn) return;
			this._liveAnaStart(t, LIVE_ANALYSIS_MORE_STEPS_MS, this.liveAna);
		},

		_liveAnaStop() {
			++this._liveAnaGen;
			clearTimeout(this._liveAnaTimer);
			if (this._liveAnaSearching && _liveAnalysisEngine) {
				_liveAnalysisEngine.cancel();      // the only way to stop a wasm call
			}
			this._liveAnaSearching = false;
		},

		_liveAnaStart(t, steps, carry) {
			this._liveAnaStop();
			const gen = this._liveAnaGen;
			const st = liveAnalysisIdleState();
			this.liveAnaHintNodes = {};
			if (!t || !t.sfn) {
				st.status = 'waiting';
				st.note = 'Waiting for the position…';
				this.liveAna = st;
				return;
			}
			const winner = t.winner || liveAnalysisDecided(t.sfn);
			if (winner) {
				st.status = 'decided';
				st.text = (winner === 'red' ? 'Red' : 'Blue') + ' won';
				st.side = winner;
				st.pRed = winner === 'red' ? 1 : 0;
				st.label = t.label || '';
				this.liveAna = st;
				return;
			}
			const blocker = liveAnalysisBlocker(t.sfn);
			if (blocker) {
				st.status = 'unavailable';
				st.note = 'No engine analysis: ' + blocker + '.';
				this.liveAna = st;
				return;
			}
			let searchSfn;
			let history;
			try {
				searchSfn = positionTurnSfn(t.sfn);
				// Threefold repetition: the game's earlier positions count, and
				// the position itself is one occurrence (as RustAI sends it).
				history = (t.earlier || []).map(positionTurnSfn).concat([searchSfn]).slice(-64);
			} catch (e) {
				st.status = 'unavailable';
				st.note = 'No engine analysis: the position could not be read.';
				this.liveAna = st;
				return;
			}
			if (carry && carry.searchSfn === searchSfn) {
				Object.assign(st, carry, { status: 'searching', note: '' });
			}
			st.status = 'searching';
			st.searchSfn = searchSfn;
			st.label = t.label || liveAnalysisTurnLabel(searchSfn);
			this.liveAna = st;
			if (carry && carry.best) this.liveAnaHintNodes = liveAnalysisHintNodes(carry.best);
			// A short pause, so stepping through a review does not start (and
			// kill) a search per keypress.
			this._liveAnaTimer = setTimeout(() => {
				this._liveAnaRun(gen, searchSfn, history, steps || LIVE_ANALYSIS_STEPS_MS).catch((e) => {
					if (gen !== this._liveAnaGen) return;
					this._liveAnaSearching = false;
					this.liveAna = Object.assign({}, this.liveAna, {
						status: 'error', note: 'The engine failed: ' + ((e && e.message) || e),
					});
				});
			}, carry ? 0 : 150);
		},

		async _liveAnaRun(gen, searchSfn, history, steps) {
			const engine = liveAnalysisEngine();
			const mover = String(searchSfn).split(' ')[1] === 'r' ? 'red' : 'blue';
			const threads = typeof rustThreadCount === 'function' ? rustThreadCount() : 1;
			const model = typeof loadPositionModel === 'function' ? await loadPositionModel() : null;
			if (gen !== this._liveAnaGen) return;
			const t0 = Date.now() - (this.liveAna.timeMs || 0);
			let nodesBefore = this.liveAna.nodes || 0;
			const search = async (sfn, timeMs, hist, onDepth) => {
				this._liveAnaSearching = true;
				let res;
				try {
					res = await engine.search(Object.assign({
						sfn, timeMs, ttBits: LIVE_ANALYSIS_TT_BITS, historySfns: hist, threads,
					}, RUST_REVIEW_SEARCH), onDepth);
				} finally {
					if (gen === this._liveAnaGen) this._liveAnaSearching = false;
				}
				if (!res || res.ok === false) throw new Error((res && res.error) || 'no result');
				return res;
			};
			for (let k = 0; k < steps.length; k++) {
				let res;
				try {
					res = await search(searchSfn, steps[k], history, (msg) => {
						if (gen !== this._liveAnaGen || typeof msg.depth !== 'number') return;
						this.liveAna.liveDepth = msg.depth;
						if (typeof msg.nodes === 'number') this.liveAna.nodes = nodesBefore + msg.nodes;
					});
				} catch (e) {
					if (gen !== this._liveAnaGen) return;   // cancelled for a newer position
					throw e;
				}
				if (gen !== this._liveAnaGen) return;
				nodesBefore += res.all_nodes || res.nodes || 0;
				const info = liveAnalysisInfo(res, mover);
				if (!info) continue;                      // no depth completed yet
				const best = Array.isArray(res.actions) && res.actions.length ? res.actions : null;
				const bestText = best ? describePuzzleActions(best) : '';
				const text = describePositionEval(info);
				const pRed = model && typeof positionRedWinProb === 'function' ? positionRedWinProb(model, info, searchSfn) : null;
				const side = info.mateIn ? (info.mateIn > 0 ? 'red' : 'blue')
					: (Math.abs(info.stones) < 0.05 ? '' : (info.stones > 0 ? 'red' : 'blue'));
				const lines = this.liveAna.lines.slice();
				const top = lines[0];
				if (!top || top.depth !== info.depth || top.bestText !== bestText || top.text !== text) {
					lines.unshift({ depth: info.depth, text, side, bestText });
					if (lines.length > LIVE_ANALYSIS_MAX_LINES) lines.length = LIVE_ANALYSIS_MAX_LINES;
				}
				const final = k === steps.length - 1 || (info.mateIn && info.proven);
				this.liveAna = Object.assign({}, this.liveAna, {
					status: final ? 'done' : 'searching',
					text, side, pRed,
					odds: (pRed !== null && typeof describePositionOdds === 'function') ? describePositionOdds(pRed) : '',
					depth: info.depth, liveDepth: info.depth,
					nodes: nodesBefore,
					timeMs: Date.now() - t0,
					best, bestText,
					replyText: top && top.bestText === bestText ? this.liveAna.replyText : '',
					lines, note: '',
				});
				this.liveAnaHintNodes = liveAnalysisHintNodes(best);
				// The expected reply: the position after the best turn, briefly.
				if (best) {
					let after = null;
					try { after = await liveAnalysisAfter(searchSfn, mover, best, res.expected_sfn); }
					catch (e) { after = null; }
					if (gen !== this._liveAnaGen) return;
					if (after && after.winner) {
						this.liveAna.replyText = '(the game is over)';
					} else if (after && after.sfn) {
						const ms = Math.round(Math.min(LIVE_ANALYSIS_REPLY_MAX_MS,
							Math.max(LIVE_ANALYSIS_REPLY_MIN_MS, steps[k] * LIVE_ANALYSIS_REPLY_FRACTION)));
						let reply = null;
						try { reply = await search(after.sfn, ms, history.concat([after.sfn]).slice(-64), null); }
						catch (e) { if (gen !== this._liveAnaGen) return; reply = null; }
						if (gen !== this._liveAnaGen) return;
						if (reply) nodesBefore += reply.all_nodes || reply.nodes || 0;
						if (reply && Array.isArray(reply.actions) && reply.actions.length) {
							this.liveAna.replyText = describePuzzleActions(reply.actions);
						}
						this.liveAna.nodes = nodesBefore;
						this.liveAna.timeMs = Date.now() - t0;
					}
				}
				if (final) {
					this.liveAna.status = 'done';
					return;
				}
			}
			if (gen === this._liveAnaGen && this.liveAna.status === 'searching') {
				this.liveAna.status = this.liveAna.text ? 'done' : 'error';
				if (!this.liveAna.text) this.liveAna.note = 'The engine completed no depth.';
			}
		},

		/** "depth 12 · 3.4M nodes · 18.2 s" (the live depth while a slice runs). */
		liveAnalysisDetail() {
			const e = this.liveAna;
			if (e.status !== 'searching' && e.status !== 'done') return '';
			const parts = [];
			if (e.status === 'searching') {
				parts.push(e.liveDepth > e.depth ? 'depth ' + e.depth + ' → ' + e.liveDepth : (e.depth ? 'depth ' + e.depth : 'searching…'));
			} else {
				parts.push('depth ' + e.depth);
			}
			if (e.nodes) parts.push(liveAnalysisNodes(e.nodes) + ' nodes');
			if (e.timeMs) parts.push((e.timeMs / 1000).toFixed(1) + ' s');
			return parts.join(' · ');
		},

		/** The eval bar's red share, in percent (50 when unknown). */
		liveAnalysisBarRed() {
			const p = this.liveAna.pRed;
			return typeof p === 'number' ? Math.round(Math.max(0, Math.min(1, p)) * 100) : 50;
		},

		/** Board highlight for a node: on, while the panel shows a best turn. */
		liveAnalysisHint(node) {
			return this.liveAnaOn && !!this.liveAnaHintNodes[node];
		},
	};
}
