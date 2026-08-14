/**
 * Lightweight simulation board for AI search.
 * Supports copy(), getLegalTurns(), applyTurn(), and greedy spell resolution.
 * Ported from simboard.py.
 */

class SimAction {
	constructor(type, opts = {}) {
		this.type = type;
		this.node = opts.node || null;
		this.pushed_to = opts.pushed_to || null;
		this.spell = opts.spell || null;
		this.sacrificed = opts.sacrificed || null;
		this.kept = opts.kept || null;
		this.node2 = opts.node2 || null;
		this.destroyed = opts.destroyed || null;
		// Panda expansion fields.
		this.target = opts.target || null;   // lock_bump: which color's counter
		this.val = opts.val || null;         // shiver: post-swap value at node
		this.val2 = opts.val2 || null;       // shiver: post-swap value at node2
		this.placed = opts.placed || null;   // perfect_heist: occupied nodes
		this.converted = opts.converted || null; // corrupt: enemy stones turned to caster's color
		this.wall = opts.wall || null;       // fissure: node permanently destroyed
		this.pushes = opts.pushes || null;   // rock_slide: [{from, to, crushed}]
		this.turns = opts.turns || null;     // schedule_moves/schedule_burns: turns scheduled
		this.nodes = opts.nodes || null;     // place_snares: nodes placed; fissure: snares cleared
	}
}

class SimTurn {
	constructor(actions) {
		this.actions = actions || [];
	}
}

class SimBoard {
	constructor(spellNames, variant = 'standard') {
		this.stones = {};
		for (const n of NODE_ORDER) this.stones[n] = null;
		this.spellNames = spellNames || [];
		this.turnCounter = 0;
		this.whoseTurn = 'red';
		this.gameover = false;
		this.winner = null;
		this.score = 'b1';
		this.spellCounter = { red: 0, blue: 0 };
		this.lock = { red: null, blue: null };
		this.springlock = { red: null, blue: null };
		this.totalStones = { red: 0, blue: 0 };
		this.mana = { red: 0, blue: 0 };
		this.chargedSpells = { red: [], blue: [] };
		this.variant = normalizeVariant(variant);
		// Turn-local: set true when a push crushes an enemy stone this turn.
		// Read by Blood Saplings; reset at each turn's start by the enumerator.
		this.crushedThisTurn = false;
		// Providence: pendingMoves[color][i] = extra moves granted at the
		// start of that player's i-th upcoming turn. extraMovesThisTurn =
		// extras popped for the current side-to-move by advanceTurn().
		this.pendingMoves = { red: [], blue: [] };
		this.extraMovesThisTurn = 0;
		// Aftershock: same shape for scheduled burns (destroy 1 adjacent
		// enemy stone at the start of each affected turn, caster's choice).
		this.pendingBurns = { red: [], blue: [] };
		this.burnsThisTurn = 0;
		// Ambush: snare markers, {node: ownerColor}. Consumed ONLY when an
		// enemy-of-owner stone rests on the node (resolved in update()) or
		// cleared by a Fissure blast. Count defensively like phantoms.
		this.snares = {};
	}

	static fromSigilBoard(board) {
		const sb = new SimBoard(board.spellNames, board.variant || 'standard');
		for (const n of NODE_ORDER) sb.stones[n] = board.stones[n];
		sb.turnCounter = board.turnCounter;
		sb.whoseTurn = board.whoseTurn;
		sb.gameover = board.gameover;
		sb.winner = board.winner;
		sb.score = board.score;
		sb.spellCounter = { ...board.spellCounter };
		sb.lock = { ...board.lock };
		sb.springlock = { ...board.springlock };
		sb.totalStones = { ...board.totalStones };
		sb.mana = { ...board.mana };
		sb.chargedSpells = { red: [...board.chargedSpells.red], blue: [...board.chargedSpells.blue] };
		sb.crushedThisTurn = !!board.crushedThisTurn;
		sb.pendingMoves = {
			red: [...((board.pendingMoves && board.pendingMoves.red) || [])],
			blue: [...((board.pendingMoves && board.pendingMoves.blue) || [])],
		};
		// The live board tracks a granted-move countdown (movesLeftThisTurn =
		// 1 + extras at turn start); the sim tracks just the extras. The AI
		// picks its whole turn at turn start, when no moves are spent yet,
		// so remaining extras = movesLeft - 1.
		sb.extraMovesThisTurn = Math.max(0, (board.movesLeftThisTurn || 1) - 1);
		sb.pendingBurns = {
			red: [...((board.pendingBurns && board.pendingBurns.red) || [])],
			blue: [...((board.pendingBurns && board.pendingBurns.blue) || [])],
		};
		// Live burn counter maps 1:1 (no +1 baseline, unlike movesLeft).
		sb.burnsThisTurn = board.burnsThisTurn || 0;
		sb.snares = { ...(board.snares || {}) };
		return sb;
	}

	copy() {
		const b = new SimBoard(this.spellNames, this.variant);
		for (const n of NODE_ORDER) b.stones[n] = this.stones[n];
		b.turnCounter = this.turnCounter;
		b.whoseTurn = this.whoseTurn;
		b.gameover = this.gameover;
		b.winner = this.winner;
		b.score = this.score;
		b.spellCounter = { ...this.spellCounter };
		b.lock = { ...this.lock };
		b.springlock = { ...this.springlock };
		b.totalStones = { ...this.totalStones };
		b.mana = { ...this.mana };
		b.chargedSpells = { red: [...this.chargedSpells.red], blue: [...this.chargedSpells.blue] };
		b.crushedThisTurn = this.crushedThisTurn;
		b.pendingMoves = { red: [...this.pendingMoves.red], blue: [...this.pendingMoves.blue] };
		b.extraMovesThisTurn = this.extraMovesThisTurn;
		b.pendingBurns = { red: [...this.pendingBurns.red], blue: [...this.pendingBurns.blue] };
		b.burnsThisTurn = this.burnsThisTurn;
		b.snares = { ...this.snares };
		return b;
	}

	_enemy(color) { return color === 'red' ? 'blue' : 'red'; }

	// Providence/Ambush helpers.
	pendingSum(color) {
		let s = 0;
		for (const v of this.pendingMoves[color]) s += v;
		return s;
	}
	snareCount(color) {
		// Live snares owned by color — count defensively toward their
		// stone total, like Providence phantoms.
		let s = 0;
		for (const n in this.snares) if (this.snares[n] === color) s++;
		return s;
	}
	pendingStones(color) {
		// Providence scheduled extras (plus, for the side to move, extras
		// granted this turn but not yet placed) and Ambush snares.
		return this.pendingSum(color) + this.snareCount(color)
			+ (this.whoseTurn === color ? this.extraMovesThisTurn : 0);
	}
	effectiveStones(color) {
		// Real stones plus Providence phantoms (no blue +1 token).
		return this.totalStones[color] + this.pendingStones(color);
	}

	update() {
		// Ambush: resolve snares FIRST so the totals/elimination/score/
		// charge math below sees the post-consumption board. A snare fires
		// ONLY when an enemy-of-owner stone rests on its node (stone
		// destroyed, snare consumed). Owner's stones coexist on top; walls
		// coexist underneath; nothing else removes a snare (except
		// Fissure's blast, handled in its resolver). Idempotent, so every
		// replayer that calls update() reproduces it exactly.
		for (const n of Object.keys(this.snares)) {
			const s = this.stones[n];
			if (s === null || s === undefined || s === DESTROYED) continue;
			if (s !== this.snares[n]) {
				this.stones[n] = null;
				delete this.snares[n];
			}
		}
		let rc = 0, bc = 0;
		for (const n of NODE_ORDER) {
			if (this.stones[n] === 'red') rc++;
			else if (this.stones[n] === 'blue') bc++;
		}
		this.totalStones.red = rc;
		this.totalStones.blue = bc;

		// Immediate-loss (latest-edition rules): zero stones on playable
		// nodes loses immediately. Blue's +1 phantom counter doesn't count.
		// Suspended during the competitive variant's empty-board opening.
		// The live game-controller increments turnCounter before each
		// turn runs (red=1, blue=2), so `<= 2` covers both opening
		// turns; it's also safe under the 0-indexed test convention
		// because by the time turn 2 starts, both players already have
		// at least one stone from their opening blinks.
		const openingPass = (variantHasCompetitive(this.variant) && this.turnCounter <= 2);
		if (!this.gameover && !openingPass) {
			if (rc === 0 && bc === 0) {
				this.gameover = true;
				this.winner = this.whoseTurn === 'red' ? 'blue' : 'red';
			} else if (rc === 0) {
				this.gameover = true;
				this.winner = 'blue';
			} else if (bc === 0) {
				this.gameover = true;
				this.winner = 'red';
			}
		}

		// Providence pending stones display in the score for both sides; the
		// side to move also shows extras granted this turn (correct at turn
		// boundaries, which is when score is read — mid-replay transient).
		const rs = rc + this.pendingStones('red');
		const bs = bc + 1 + this.pendingStones('blue');
		if (rs === bs) this.score = 'tied';
		else if (rs > bs) this.score = 'r' + Math.min(3, rs - bs);
		else this.score = 'b' + Math.min(3, bs - rs);

		for (const color of ['red', 'blue'])
			this.mana[color] = MANA_NODES.filter(n => this.stones[n] === color).length;

		this.chargedSpells.red = [];
		this.chargedSpells.blue = [];
		for (let i = 0; i < this.spellNames.length; i++) {
			const nodes = POSITIONS[i + 1];
			if (!nodes || !nodes.length) continue;
			// A spell whose position contains a permanently destroyed node
			// can never be charged or cast again.
			if (nodes.some(n => this.stones[n] === DESTROYED)) continue;
			const first = this.stones[nodes[0]];
			if (first === null) continue;
			if (nodes.every(n => this.stones[n] === first))
				this.chargedSpells[first].push(this.spellNames[i]);
		}
	}

	/**
	 * Build a string identifier for repetition detection. Mirrors
	 * game-controller.js / board.js takeSnapshot loopKey: spell
	 * counters, every node's stone, each player's lock. Two boards
	 * with the same snapshot are treated as the "same position" by
	 * the threefold-repetition rule (5x occurrences -> blue wins).
	 */
	loopingSnapshot() {
		// A position is "the same" when stones, side to move, and both players'
		// lock AND springlock match (springlock distinguishes a Seal-of-Spring
		// spell still reusable once more from one already used twice). The ONLY
		// mode difference: non-Deathmatch ALSO factors in the spell counts.
		// Mirrors board.js takeSnapshot; the rule ends the game on the 3rd
		// occurrence in both modes.
		let key = 'p' + (this.turnCounter % 2) + '|';
		for (const n of NODE_ORDER) {
			const s = this.stones[n];
			key += s === null ? '-' : s[0];
		}
		key += '|' + (this.lock.red || 'None') + '|' + (this.lock.blue || 'None')
			+ '|' + (this.springlock.red || 'None') + '|' + (this.springlock.blue || 'None');
		if (!variantHasDeathmatch(this.variant)) {
			key += '|' + this.spellCounter.red + '|' + this.spellCounter.blue;
		}
		// Providence: positions with different pending schedules are NOT the
		// same position. Suffix only when non-empty so legacy keys stay
		// byte-identical. Canonical form is the PRE-SHIFT schedule (matching
		// board.js takeSnapshot, which runs before the controller's shift):
		// re-prepend the popped extras counter to the mover's list.
		const schedRed = [...this.pendingMoves.red];
		const schedBlue = [...this.pendingMoves.blue];
		if (this.extraMovesThisTurn) {
			(this.whoseTurn === 'red' ? schedRed : schedBlue)
				.unshift(this.extraMovesThisTurn);
		}
		if (schedRed.length || schedBlue.length) {
			key += '|P' + schedRed.join(',') + '/' + schedBlue.join(',');
		}
		// Aftershock: same canonical pre-shift convention for burn schedules.
		const burnRed = [...this.pendingBurns.red];
		const burnBlue = [...this.pendingBurns.blue];
		if (this.burnsThisTurn) {
			(this.whoseTurn === 'red' ? burnRed : burnBlue)
				.unshift(this.burnsThisTurn);
		}
		if (burnRed.length || burnBlue.length) {
			key += '|B' + burnRed.join(',') + '/' + burnBlue.join(',');
		}
		// Ambush: snares are position state. NODE_ORDER-canonical, only
		// when non-empty. No pre/post-shift reconciliation needed.
		const snareKeys = Object.keys(this.snares);
		if (snareKeys.length) {
			key += '|S';
			for (const n of NODE_ORDER) {
				if (this.snares[n]) key += n + ':' + this.snares[n][0] + ',';
			}
		}
		return key;
	}

	checkGameOver(activeColor) {
		// update() may already have flagged immediate-loss (zero stones).
		if (this.gameover) return true;

		// Deathmatch: only elimination wins (handled in update()); the
		// +3-lead and 6th-spell conditions below are disabled.
		if (variantHasDeathmatch(this.variant)) return false;

		// Providence phantoms count ASYMMETRICALLY (defense only): a player's
		// win claim uses their real placed stones, checked against the
		// opponent's real+pending total. The mover's extras-this-turn are NOT
		// counted anywhere here: placed ones are already real, unused ones
		// forfeit at end of turn.
		const rt = this.totalStones.red, bt = this.totalStones.blue + 1;
		const rp = this.pendingSum('red') + this.snareCount('red');
		const bp = this.pendingSum('blue') + this.snareCount('blue');
		if (rt > bt + bp + 2) { this.gameover = true; this.winner = 'red'; return true; }
		if (bt > rt + rp + 2) { this.gameover = true; this.winner = 'blue'; return true; }
		if (this.spellCounter[activeColor] >= 6) {
			this.gameover = true;
			if (rt > bt + bp) this.winner = 'red';
			else if (bt > rt + rp) this.winner = 'blue';
			else this.winner = this._enemy(activeColor);
			return true;
		}
		return false;
	}

	advanceTurn() {
		// The Providence shift lives here so every turn driver (search,
		// arena, replay) is correct without per-driver edits, and end-of-turn
		// forfeit is implicit: the pop overwrites whatever the previous mover
		// left unused.
		this.turnCounter++;
		this.whoseTurn = this.whoseTurn === 'red' ? 'blue' : 'red';
		const sched = this.pendingMoves[this.whoseTurn];
		this.extraMovesThisTurn = sched.length ? sched.shift() : 0;
		// Aftershock: second pop. Forfeit of unresolved burns is implicit,
		// exactly like unused extras — the pop overwrites the leftover.
		const bsched = this.pendingBurns[this.whoseTurn];
		this.burnsThisTurn = bsched.length ? bsched.shift() : 0;
	}

	// --- Move helpers ---
	_softMoveable(color) {
		const result = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] === null) {
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] === color) { result.push(name); break; }
				}
			}
		}
		return result;
	}

	_isBulwarkProtected(color, nodeName) {
		if (this.stones[nodeName] !== color) return false;
		if (!this.chargedSpells[color].includes('Bulwark')) return false;
		const lockSpell = this.lock[color];
		if (!lockSpell) return false;
		const lockIdx = this.spellNames.indexOf(lockSpell);
		if (lockIdx < 0) return false;
		const lockNodes = POSITIONS[lockIdx + 1];
		return lockNodes && lockNodes.includes(nodeName);
	}

	_hardMoveable(color) {
		const enemy = this._enemy(color);
		const result = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] === enemy && !this._isBulwarkProtected(enemy, name)) {
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] === color) { result.push(name); break; }
				}
			}
		}
		return result;
	}

	_allMoveable(color) {
		const enemy = this._enemy(color);
		const result = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] === DESTROYED) continue; // walls are impassable
			if (this.stones[name] !== color) {
				if (this.stones[name] === enemy && this._isBulwarkProtected(enemy, name)) {
					continue;
				}
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] === color) { result.push(name); break; }
				}
			}
		}
		return result;
	}

	_blinkable(color) {
		const enemy = this._enemy(color);
		return NODE_ORDER.filter(n => {
			if (this.stones[n] === color) return false;
			if (this.stones[n] === DESTROYED) return false; // walls are impassable
			if (this.stones[n] === enemy && this._isBulwarkProtected(enemy, n)) return false;
			return true;
		});
	}

	/**
	 * Minimum BFS distance from nodeName through defenderColor stones to
	 * the nearest empty cell. Mirrors the push-chain logic of _pushEnemy
	 * but does not mutate. Used by feature engineering as a Go-style
	 * "liberty" analogue. Returns maxDist if no escape route exists.
	 */
	escapeDistance(nodeName, defenderColor, maxDist) {
		if (maxDist === undefined) maxDist = 6;
		const attacker = defenderColor === 'red' ? 'blue' : 'red';
		const queue = [];
		for (const nb of (ADJACENCY[nodeName] || [])) queue.push([nb, 1]);
		const visited = new Set([nodeName]);
		while (queue.length > 0) {
			const [nn, dist] = queue.shift();
			if (visited.has(nn)) continue;
			visited.add(nn);
			if (dist > maxDist) break;
			const s = this.stones[nn];
			if (s === attacker) continue;
			else if (s === DESTROYED) continue; // walls block the chain, not an escape cell
			else if (s === defenderColor) {
				for (const nb of (ADJACENCY[nn] || [])) {
					if (!visited.has(nb)) queue.push([nb, dist + 1]);
				}
			} else {
				return dist;
			}
		}
		return maxDist;
	}

	/**
	 * True iff a hard-move into nodeName by attackerColor would crush
	 * the defender stone (no empty cell reachable through the push chain).
	 * Returns false if nodeName isn't occupied by the defender. Non-mutating.
	 */
	isCrushable(nodeName, attackerColor) {
		const defender = attackerColor === 'red' ? 'blue' : 'red';
		if (this.stones[nodeName] !== defender) return false;
		return this.escapeDistance(nodeName, defender, 39) >= 39;
	}

	/**
	 * Non-mutating: the candidate push destinations (nearest reachable
	 * empty cells, tie-broken in BFS order) for a hard-move onto nodeName.
	 * Same chain logic as _pushEnemy but writes nothing. Empty array means
	 * the defender would be crushed. The caller (enumerator) uses this to
	 * branch over *which* empty cell the pushed stone lands on — a choice
	 * the live engine offers the player (spells.js doPushEnemy) but the AI
	 * previously collapsed to options[0].
	 */
	_pushDestinations(nodeName, color) {
		const enemy = this._enemy(color);
		const queue = [];
		for (const nb of ADJACENCY[nodeName]) queue.push([nb, 1]);
		const visited = new Set([nodeName]);
		const options = [];
		let shortest = null;
		while (queue.length > 0) {
			const [nn, dist] = queue.shift();
			if (visited.has(nn)) continue;
			visited.add(nn);
			if (shortest !== null && dist > shortest) break;
			const s = this.stones[nn];
			if (s === color) continue;
			else if (s === DESTROYED) continue; // walls block the chain, not a destination
			else if (s === enemy) {
				for (const nb of ADJACENCY[nn]) {
					if (!visited.has(nb)) queue.push([nb, dist + 1]);
				}
			} else {
				options.push(nn);
				shortest = dist;
			}
		}
		return options;
	}

	/**
	 * Push the enemy stone at nodeName. `destOverride`, when it names one of
	 * the legal destinations, sends the stone there instead of the default
	 * options[0] — letting the search model the player's push-destination
	 * choice. Returns the chosen destination, or 'X' on crush.
	 */
	_pushEnemy(nodeName, color, destOverride) {
		const enemy = this._enemy(color);
		this.stones[nodeName] = color;
		const queue = [];
		for (const nb of ADJACENCY[nodeName]) queue.push([nb, 1]);
		const visited = new Set([nodeName]);
		const options = [];
		let shortest = null;

		while (queue.length > 0) {
			const [nn, dist] = queue.shift();
			if (visited.has(nn)) continue;
			visited.add(nn);
			if (shortest !== null && dist > shortest) break;
			const s = this.stones[nn];
			if (s === color) continue;
			else if (s === DESTROYED) continue; // walls block the chain, not a destination
			else if (s === enemy) {
				for (const nb of ADJACENCY[nn]) {
					if (!visited.has(nb)) queue.push([nb, dist + 1]);
				}
			} else {
				options.push(nn);
				shortest = dist;
			}
		}
		if (!options.length) {
			this.crushedThisTurn = true;
			return 'X';
		}
		const dest = (destOverride != null && options.includes(destOverride))
			? destOverride : options[0];
		this.stones[dest] = enemy;
		return dest;
	}

	/**
	 * Ranked eligible Aftershock burn targets: enemy stones adjacent to
	 * `color`'s stones. Bulwark does NOT protect (destruction convention,
	 * like Fireblast/Storm Front). Spell-position nodes rank first,
	 * NODE_ORDER within each class — shared by the greedy engine and the
	 * exhaustive enumerator so greedy == top-1.
	 */
	_burnTargets(color) {
		const enemy = this._enemy(color);
		const inSpell = [];
		const outside = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] !== enemy) continue;
			if ((ADJACENCY[name] || []).some(nb => this.stones[nb] === color)) {
				(SPELL_POSITION_NODES.has(name) ? inSpell : outside).push(name);
			}
		}
		return inSpell.concat(outside);
	}

	/**
	 * Ambush placement heuristic: empty, snare-free, non-wall nodes ranked
	 * by likelihood an ENEMY stone comes to rest there — 2 per adjacent
	 * enemy stone, +2 inside a sigil the enemy is charging (their stones
	 * present, none of ours), +1 on a mana node. Descending score,
	 * NODE_ORDER tiebreak (stable sort). Scores read only stones, so one
	 * ranking pass serves multi-placement exactly.
	 */
	_snareCandidates(color) {
		const enemy = this._enemy(color);
		const out = [];
		for (const n of NODE_ORDER) {
			if (this.stones[n] !== null || this.snares[n]) continue;
			let score = 0;
			for (const nb of (ADJACENCY[n] || [])) {
				if (this.stones[nb] === enemy) score += 2;
			}
			if (MANA_NODES.includes(n)) score += 1;
			const pos = POSITION_OF_NODE[n];
			if (pos !== undefined) {
				const pnodes = POSITIONS[pos];
				if (pnodes.some(x => this.stones[x] === enemy)
						&& !pnodes.some(x => this.stones[x] === color)) {
					score += 2;
				}
			}
			out.push([score, n]);
		}
		out.sort((a, b) => b[0] - a[0]);   // stable => NODE_ORDER tiebreak
		return out;
	}

	_doSoftMove(color, node) {
		this.stones[node] = color;
		return new SimAction('move', { node });
	}

	_doHardMove(color, node, destOverride) {
		const dest = this._pushEnemy(node, color, destOverride);
		return new SimAction('hard_move', { node, pushed_to: dest });
	}

	_doMove(color, node, isBlink, destOverride) {
		if (this.stones[node] === null) {
			if (isBlink) { this.stones[node] = color; return new SimAction('blink', { node }); }
			return this._doSoftMove(color, node);
		} else if (this.stones[node] === this._enemy(color)) {
			const act = this._doHardMove(color, node, destOverride);
			if (isBlink) act.type = 'blink';
			return act;
		}
		return null;
	}

	// --- Spell resolution: greedy by default, branching via overrides ---
	// Gloom (Decay): destroy every enemy stone touching 2+ empty nodes.
	// Membership is computed against the pre-destruction board so removals don't
	// cascade, then applied simultaneously. Pushes a 'decay' SimAction and updates.
	_destroyExposed(color, actions) {
		const enemy = this._enemy(color);
		const doomed = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] !== enemy) continue;
			let empties = 0;
			for (const nb of ADJACENCY[name]) {
				if (this.stones[nb] === null) empties++;
			}
			if (empties >= 2) doomed.push(name);
		}
		for (const name of doomed) this.stones[name] = null;
		actions.push(new SimAction('decay', { destroyed: doomed }));
		this.update();
		return doomed;
	}

	// Destroy up to `count` enemy stones of the caster's choice (Storm_Front).
	// `chosen` is an optional ordered list of
	// preferred enemy nodes; invalid entries are skipped, falling back to the
	// first enemy stone in NODE_ORDER.
	_destroyChosen(color, actions, count, chosen) {
		const enemy = this._enemy(color);
		const queue = (chosen || []).slice();
		const destroyed = [];
		for (let k = 0; k < count; k++) {
			let target = null;
			while (queue.length && target === null) {
				const cand = queue.shift();
				if (this.stones[cand] === enemy) target = cand;
			}
			if (target === null) {
				for (const name of NODE_ORDER) {
					if (this.stones[name] === enemy) { target = name; break; }
				}
			}
			if (target === null) break;
			this.stones[target] = null;
			destroyed.push(target);
			this.update();
			if (this.gameover) break;
		}
		if (destroyed.length) actions.push(new SimAction('storm_front', { destroyed }));
		return destroyed;
	}

	_resolveSpell(spellName, color, posNodes, targetOverrides) {
		const info = CORE_SPELLS[spellName];
		if (!info || info.resolve === null) return [];
		const actions = [];
		const enemy = this._enemy(color);
		const rt = info.resolve;
		const overrides = targetOverrides || {};
		// Ordered queue of push destinations, consumed (in resolution order)
		// one per push this spell performs. Empty entries fall back to the
		// default nearest-empty cell. Lets the enumerator branch a spell's
		// push onto a chosen cell (e.g. pushing into a gap to merge enemy
		// groups), the same choice the live engine offers the player.
		const pushDests = (overrides.push_dests || []).slice();

		if (rt === 'soft_moves') {
			const overrideTargets = (overrides.soft_move_targets || []).slice();
			for (let i = 0; i < info.count; i++) {
				const targets = this._softMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (overrideTargets.length && chosen === null) {
					const cand = overrideTargets.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets.find(t => !posNodes.includes(t)) || targets[0];
				actions.push(this._doSoftMove(color, chosen));
				this.update();
			}
		} else if (rt === 'hard_moves') {
			const overrideTargets = (overrides.hard_move_targets || []).slice();
			for (let i = 0; i < info.count; i++) {
				const targets = this._hardMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (overrideTargets.length && chosen === null) {
					const cand = overrideTargets.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets[0];
				actions.push(this._doHardMove(color, chosen, pushDests.shift()));
				this.update();
			}
		} else if (rt === 'fireblast') {
			const destroyed = [];
			for (const name of NODE_ORDER) {
				if (this.stones[name] === enemy) {
					for (const nb of ADJACENCY[name]) {
						if (this.stones[nb] === color) {
							this.stones[name] = null;
							destroyed.push(name);
							break;
						}
					}
				}
			}
			actions.push(new SimAction('fireblast', { destroyed }));
			this.update();
			// If destruction wiped out the opponent's last stone, the
			// game ends immediately — no sacrifice happens.
			if (this.gameover) return actions;
			// Sacrifice cost (latest-edition rules): pick lowest-priority
			// own stone by reverse NODE_ORDER, mirroring Comet's heuristic.
			const sacOverride = overrides.fireblast_sacrifice;
			let sacDone = false;
			if (sacOverride && this.stones[sacOverride] === color) {
				this.stones[sacOverride] = null;
				actions.push(new SimAction('sacrifice', { node: sacOverride }));
				sacDone = true;
			}
			if (!sacDone) {
				for (const name of [...NODE_ORDER].reverse()) {
					if (this.stones[name] === color) {
						this.stones[name] = null;
						actions.push(new SimAction('sacrifice', { node: name }));
						break;
					}
				}
			}
			this.update();
		} else if (rt === 'hail_storm') {
			const destroyed = [];
			for (let pos = 1; pos <= 6; pos++) {
				for (const n of POSITIONS[pos]) {
					if (this.stones[n] === enemy) {
						this.stones[n] = null;
						destroyed.push(n);
						this.update();
						break;
					}
				}
			}
			if (destroyed.length) actions.push(new SimAction('hail_storm', { destroyed }));
		} else if (rt === 'fissure') {
			let target = overrides.fissure_target;
			if (!target || !NODE_ORDER.includes(target)) {
				// Greedy default: pick the target with the greatest net
				// stone-count advantage. Target term: +1 enemy / 0 empty /
				// -1 own. Blast term: +1 per adjacent enemy stone.
				let bestScore = null;
				let bestTarget = NODE_ORDER[0];
				for (const node of NODE_ORDER) {
					let score = this.stones[node] === enemy ? 1
						: (this.stones[node] === color ? -1 : 0);
					for (const nb of ADJACENCY[node]) {
						if (this.stones[nb] === enemy) score++;
					}
					if (bestScore === null || score > bestScore) {
						bestScore = score;
						bestTarget = node;
					}
				}
				target = bestTarget;
			}
			const destroyed = [];
			// Adjacent nodes: destroy enemy stones only (revert to normal empty).
			for (const n of ADJACENCY[target]) {
				if (this.stones[n] === enemy) {
					this.stones[n] = null;
					destroyed.push(n);
				}
			}
			// Target node: permanently destroyed (a wall), regardless of occupant.
			if (this.stones[target] === color || this.stones[target] === enemy) {
				destroyed.push(target);
			}
			this.stones[target] = DESTROYED;
			// Ambush interaction: the blast also destroys enemy-of-caster
			// SNARES on the target + adjacent nodes (the caster's own
			// snares survive). Recorded on `nodes` so replayers reproduce
			// it (this removal does not flow through update()).
			const snaresCleared = [];
			for (const n of [target].concat(ADJACENCY[target] || [])) {
				if (this.snares[n] === enemy) {
					delete this.snares[n];
					snaresCleared.push(n);
				}
			}
			actions.push(new SimAction('fissure', { node: target, destroyed, wall: target,
				nodes: snaresCleared.length ? snaresCleared : null }));
			this.update();
		} else if (rt === 'rock_slide') {
			const pushes = [];
			const overridePushes = overrides.rock_slide_pushes || [];
			let safety = 0;
			while (safety < 50) {
				safety++;
				const adjacentEnemyNodes = [];
				for (const name of NODE_ORDER) {
					if (this.stones[name] === enemy) {
						const hasCasterNb = ADJACENCY[name].some(nb => this.stones[nb] === color);
						if (hasCasterNb) {
							adjacentEnemyNodes.push(name);
						}
					}
				}

				if (adjacentEnemyNodes.length === 0) {
					break;
				}

				let fromNode = null;
				let toNode = null;

				if (pushes.length < overridePushes.length) {
					const ovr = overridePushes[pushes.length];
					if (adjacentEnemyNodes.includes(ovr.from) && ADJACENCY[ovr.from].includes(ovr.to)) {
						fromNode = ovr.from;
						toNode = ovr.to;
					}
				}

				if (fromNode === null) {
					let bestFrom = null;
					let bestTo = null;
					let bestScore = -9999;
					for (const source of adjacentEnemyNodes) {
						const stoneColor = this.stones[source];
						for (const nb of ADJACENCY[source]) {
							const occ = this.stones[nb];
							let score = 0;
							if (occ === null) {
								score = 10;
							} else if (occ === enemy) {
								if (stoneColor === color) {
									score = 5;
								} else {
									score = 20;
								}
							} else if (occ === color) {
								if (stoneColor === color) {
									score = -50;
								} else {
									score = -100;
								}
							}
							if (score > bestScore) {
								bestScore = score;
								bestFrom = source;
								bestTo = nb;
							}
						}
					}
					if (bestFrom !== null) {
						fromNode = bestFrom;
						toNode = bestTo;
					} else {
						fromNode = adjacentEnemyNodes[0];
						toNode = ADJACENCY[fromNode][0];
					}
				}

				const stoneColor = this.stones[fromNode];
				const occupant = this.stones[toNode];
				this.stones[fromNode] = null;
				if (occupant !== null) {
					this.crushedThisTurn = true;
				}
				this.stones[toNode] = stoneColor;
				pushes.push({ from: fromNode, to: toNode, crushed: occupant });
				this.update();

				if (this.gameover) break;
			}
			actions.push(new SimAction('rock_slide', { pushes }));
		} else if (rt === 'schedule_moves') {
			// Providence: schedule 1 extra move at the start of each of the
			// caster's next `turns` turns (additive stacking).
			const turns = info.turns || 1;
			const sched = this.pendingMoves[color];
			while (sched.length < turns) sched.push(0);
			for (let i = 0; i < turns; i++) sched[i] += 1;
			actions.push(new SimAction('schedule_moves', { spell: spellName, turns }));
			this.update();
		} else if (rt === 'place_snares') {
			// Ambush: place up to `count` snares on empty, snare-free,
			// non-wall nodes.
			const count = info.count || 1;
			const placed = [];
			if (overrides.snare_targets) {
				// The exhaustive enumerator supplies the whole SET; use
				// exactly it (skipping now-illegal entries).
				for (const cand of overrides.snare_targets.slice(0, count)) {
					if (this.stones[cand] === null && !this.snares[cand]) {
						this.snares[cand] = color;
						placed.push(cand);
					}
				}
			} else {
				// Greedy: top-scored candidates; stop early at zero score.
				for (const [score, n] of this._snareCandidates(color)) {
					if (placed.length >= count || score <= 0) break;
					this.snares[n] = color;
					placed.push(n);
				}
			}
			actions.push(new SimAction('place_snares', { spell: spellName, nodes: placed }));
			this.update();
		} else if (rt === 'schedule_burns') {
			// Aftershock: schedule 1 burn at the start of each of the
			// caster's next `turns` turns (additive stacking). The burn
			// itself resolves at start of turn, not here.
			const turns = info.turns || 1;
			const sched = this.pendingBurns[color];
			while (sched.length < turns) sched.push(0);
			for (let i = 0; i < turns; i++) sched[i] += 1;
			actions.push(new SimAction('schedule_burns', { spell: spellName, turns }));
			this.update();
		} else if (rt === 'bewitch') {
			const ovr = overrides.bewitch_pair;
			if (ovr) {
				const [n1, n2] = ovr;
				if (this.stones[n1] === enemy && this.stones[n2] === enemy
				    && ADJACENCY[n1].includes(n2)) {
					this.stones[n1] = color;
					this.stones[n2] = color;
					actions.push(new SimAction('bewitch', { node: n1, node2: n2 }));
					this.update();
					return actions;
				}
			}
			for (const name of NODE_ORDER) {
				if (this.stones[name] === enemy) {
					for (const nb of ADJACENCY[name]) {
						if (this.stones[nb] === enemy) {
							this.stones[name] = color;
							this.stones[nb] = color;
							actions.push(new SimAction('bewitch', { node: name, node2: nb }));
							this.update();
							return actions;
						}
					}
				}
			}
		} else if (rt === 'starfall') {
			const ovr = overrides.starfall_pair;
			let best = null;
			if (ovr) {
				const [a, b] = ovr;
				if (this.stones[a] === null && this.stones[b] === null && ADJACENCY[a].includes(b)) {
					best = [a, b];
				}
			}
			if (!best) {
				// Heuristic: max enemy stones destroyed; ties broken by
				// destroying an enemy on a mana node (a1/b1/c1).
				let bestScore = [-1, -1];
				for (const name of NODE_ORDER) {
					if (this.stones[name] !== null) continue;
					for (const nb of ADJACENCY[name]) {
						if (this.stones[nb] !== null) continue;
						const union = new Set([...ADJACENCY[name], ...ADJACENCY[nb]]);
						const enemies = [...union].filter(n => this.stones[n] === enemy);
						const ec = enemies.length;
						const mana = enemies.filter(n => MANA_NODES.includes(n)).length;
						if (ec > bestScore[0] || (ec === bestScore[0] && mana > bestScore[1])) {
							bestScore = [ec, mana];
							best = [name, nb];
						}
					}
				}
			}
			if (best) {
				const [n1, n2] = best;
				this.stones[n1] = color;
				this.stones[n2] = color;
				const destroyed = [];
				const union = new Set([...ADJACENCY[n1], ...ADJACENCY[n2]]);
				for (const n of union) {
					if (this.stones[n] === enemy) { this.stones[n] = null; destroyed.push(n); }
				}
				actions.push(new SimAction('starfall', { node: n1, node2: n2, destroyed }));
				this.update();
			}
		} else if (rt === 'meteor') {
			const targets = this._blinkable(color);
			let chosen = null;
			const ovr = overrides.meteor_target;
			if (ovr && targets.includes(ovr)) {
				chosen = ovr;
			} else {
				// Heuristic: max enemies destroyed (push-crush + the one
				// adjacent kill); ties broken in favor of eliminating
				// enemy mana stones.
				let bestScore = [-1, -1];
				for (const t of targets) {
					const crush = (this.stones[t] === enemy
					               && this.isCrushable(t, color));
					const crushKills = crush ? 1 : 0;
					const crushMana = (crush && MANA_NODES.includes(t)) ? 1 : 0;
					const adjEnemies = ADJACENCY[t].filter(nb => this.stones[nb] === enemy);
					const kill = adjEnemies.length > 0 ? 1 : 0;
					const killMana = adjEnemies.some(n => MANA_NODES.includes(n)) ? 1 : 0;
					const score = [crushKills + kill, crushMana + killMana];
					if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
						bestScore = score;
						chosen = t;
					}
				}
				if (chosen === null && targets.length) chosen = targets[0];
			}
			if (chosen) {
				if (this.stones[chosen] === enemy) {
					const dest = this._pushEnemy(chosen, color, pushDests.shift());
					actions.push(new SimAction('blink', { node: chosen, pushed_to: dest }));
				} else {
					this.stones[chosen] = color;
					actions.push(new SimAction('blink', { node: chosen }));
				}
				this.update();
				// Destroy 1 adjacent enemy — prefer one on a mana node.
				const adjEnemies = ADJACENCY[chosen].filter(nb => this.stones[nb] === enemy);
				let killTarget = adjEnemies.find(n => MANA_NODES.includes(n));
				if (!killTarget && adjEnemies.length) killTarget = adjEnemies[0];
				if (killTarget) {
					this.stones[killTarget] = null;
					actions.push(new SimAction('meteor_destroy', { node: killTarget }));
				}
				this.update();
			}
		} else if (rt === 'comet') {
			const targets = this._blinkable(color);
			let target = null;
			for (const mn of [...MANA_NODES].reverse()) {
				if (this.stones[mn] === color || this.stones[mn] === DESTROYED) continue;
				const ae = ADJACENCY[mn].filter(nb => this.stones[nb] === enemy).length;
				const touching = this.stones[mn] === color || ADJACENCY[mn].some(nb => this.stones[nb] === color);
				if (!touching && ae < 2) { target = mn; break; }
			}
			if (!target && targets.length) target = targets[0];
			if (target) {
				if (this.stones[target] === enemy) {
					const dest = this._pushEnemy(target, color, pushDests.shift());
					actions.push(new SimAction('blink', { node: target, pushed_to: dest }));
				} else {
					this.stones[target] = color;
					actions.push(new SimAction('blink', { node: target }));
				}
				this.update();
				for (const name of [...NODE_ORDER].reverse()) {
					if (this.stones[name] === color && name !== target) {
						this.stones[name] = null;
						actions.push(new SimAction('sacrifice', { node: name }));
						break;
					}
				}
				this.update();
			}
		} else if (rt === 'surge_move') {
			const targets = this._allMoveable(color);
			let chosen = null;
			const ovr = overrides.surge_target;
			if (ovr && targets.includes(ovr)) chosen = ovr;
			else if (targets.length) chosen = targets[0];
			if (chosen) {
				actions.push(this._doMove(color, chosen, false));
				this.update();
			}
		} else if (rt === 'fury') {
			// Sacrifice 1 stone, then 3 hard moves.
			const sacOverride = overrides.fury_sacrifice;
			let sacrificed = null;
			if (sacOverride && this.stones[sacOverride] === color) {
				this.stones[sacOverride] = null;
				sacrificed = sacOverride;
			} else {
				for (const name of [...NODE_ORDER].reverse()) {
					if (this.stones[name] === color) {
						this.stones[name] = null;
						sacrificed = name;
						break;
					}
				}
			}
			if (sacrificed) actions.push(new SimAction('sacrifice', { node: sacrificed }));
			this.update();
			if (this.gameover) return actions;
			const overrideTargets = (overrides.hard_move_targets || []).slice();
			for (let i = 0; i < 3; i++) {
				const targets = this._hardMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (overrideTargets.length && chosen === null) {
					const cand = overrideTargets.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets[0];
				actions.push(this._doHardMove(color, chosen, pushDests.shift()));
				this.update();
			}
		} else if (rt === 'gust') {
			// Pick up every enemy stone touching any of our remaining stones.
			const picked = [];
			for (const n of NODE_ORDER) {
				if (this.stones[n] !== enemy) continue;
				for (const nb of ADJACENCY[n]) {
					if (this.stones[nb] === color) { picked.push(n); break; }
				}
			}
			if (!picked.length) return actions;
			for (const n of picked) this.stones[n] = null;
			this.update();
			// Place them. Override placements list (parallel to picked order),
			// otherwise fill empty nodes in NODE_ORDER.
			const placeOverrides = (overrides.gust_placements || []).slice();
			const placed = [];
			for (let i = 0; i < picked.length; i++) {
				let dest = null;
				if (placeOverrides[i] && this.stones[placeOverrides[i]] === null) {
					dest = placeOverrides[i];
				} else {
					for (const n of NODE_ORDER) {
						if (this.stones[n] === null) { dest = n; break; }
					}
				}
				if (!dest) break;
				this.stones[dest] = enemy;
				placed.push(dest);
				this.update();
			}
			actions.push(new SimAction('gust', { destroyed: picked, kept: placed }));
		} else if (rt === 'storm_front') {
			// Destroy 2 enemy stones of caster's choice.
			this._destroyChosen(color, actions, 2, overrides.storm_front_pair);
			this.update();
		} else if (rt === 'hurricane') {
			// Destroy the smallest contiguous enemy group.
			const visited = new Set();
			const groups = [];
			for (const start of NODE_ORDER) {
				if (visited.has(start) || this.stones[start] !== enemy) continue;
				const group = [];
				const queue = [start];
				visited.add(start);
				while (queue.length > 0) {
					const n = queue.shift();
					group.push(n);
					for (const nb of (ADJACENCY[n] || [])) {
						if (!visited.has(nb) && this.stones[nb] === enemy) {
							visited.add(nb);
							queue.push(nb);
						}
					}
				}
				groups.push(group);
			}
			if (!groups.length) return actions;
			const minSize = Math.min(...groups.map(g => g.length));
			const smallest = groups.filter(g => g.length === minSize);
			let chosen = smallest[0];
			const ovr = overrides.hurricane_group;
			if (ovr) {
				const match = smallest.find(g => ovr.every(n => g.includes(n)) && g.length === ovr.length);
				if (match) chosen = match;
			}
			for (const n of chosen) this.stones[n] = null;
			actions.push(new SimAction('hurricane', { destroyed: chosen.slice() }));
			this.update();
		} else if (rt === 'soft_hard_chain') {
			const [softCount, hardCount] = info.counts;
			const softOverrides = (overrides.soft_move_targets || []).slice();
			const hardOverrides = (overrides.hard_move_targets || []).slice();
			for (let i = 0; i < softCount; i++) {
				const targets = this._softMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (softOverrides.length && chosen === null) {
					const cand = softOverrides.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets.find(t => !posNodes.includes(t)) || targets[0];
				actions.push(this._doSoftMove(color, chosen));
				this.update();
			}
			for (let i = 0; i < hardCount; i++) {
				const targets = this._hardMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (hardOverrides.length && chosen === null) {
					const cand = hardOverrides.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets[0];
				actions.push(this._doHardMove(color, chosen, pushDests.shift()));
				this.update();
			}
		} else if (rt === 'azimuth') {
			// 1 move into a spell where this color controls all but 1 node.
			const qualifying = [];
			for (let i = 1; i <= 9; i++) {
				let unc = 0;
				for (const n of POSITIONS[i]) if (this.stones[n] !== color) unc++;
				if (unc === 1) qualifying.push(i);
			}
			const moves = this._allMoveable(color);
			let chosen = null;
			for (const idx of qualifying) {
				for (const n of POSITIONS[idx]) {
					if (moves.includes(n)) { chosen = n; break; }
				}
				if (chosen) break;
			}
			if (chosen) {
				actions.push(this._doMove(color, chosen, false));
				this.update();
			}
		} else if (rt === 'eclipse') {
			// 2 moves into a spell where this color controls all but 2 nodes.
			const candidates = [];
			for (let i = 1; i <= 9; i++) {
				let unc = 0;
				for (const n of POSITIONS[i]) if (this.stones[n] !== color) unc++;
				if (unc === 2) candidates.push(i);
			}
			let chosenSpell = null;
			let firstNode = null;
			outer: for (const idx of candidates) {
				const moves = this._allMoveable(color);
				for (const n of POSITIONS[idx]) {
					if (moves.includes(n)) { chosenSpell = idx; firstNode = n; break outer; }
				}
			}
			if (firstNode) {
				actions.push(this._doMove(color, firstNode, false));
				this.update();
				const moves2 = this._allMoveable(color);
				for (const n of POSITIONS[chosenSpell]) {
					if (moves2.includes(n)) {
						actions.push(this._doMove(color, n, false));
						this.update();
						break;
					}
				}
			}
		} else if (rt === 'charge') {
			// 1 move into any 3- or 5-node spell (positions 1..6). No
			// "control all but N" constraint, unlike Azimuth. (spellPositionOfNode
			// lives in spells.js, which the worker doesn't load, so inline the
			// position lookups like the Eclipse/Azimuth branches do.)
			const _posOf = (node) => {
				for (let i = 1; i <= 9; i++) if (POSITIONS[i].includes(node)) return i;
				return null;
			};
			const moves = this._allMoveable(color);
			let chosen = null;
			const ovr = overrides.charge_target;
			if (ovr && moves.includes(ovr) && _posOf(ovr) !== null && _posOf(ovr) <= 6) {
				chosen = ovr;
			} else {
				for (let i = 1; i <= 6; i++) {
					for (const n of POSITIONS[i]) {
						if (moves.includes(n)) { chosen = n; break; }
					}
					if (chosen) break;
				}
			}
			if (chosen) {
				actions.push(this._doMove(color, chosen, false));
				this.update();
			}
		} else if (rt === 'erupt') {
			// Up to 2 non-blink moves into every 3- or 5-node spell (positions
			// 1..6) in which `color` already has a stone, EXCEPT Erupt's own
			// slot. A spell where you hold k of N nodes allows min(2, N-k)
			// moves, further limited by reachability. Greedy target choice.
			const own = new Set(posNodes);
			for (let i = 1; i <= 6; i++) {
				const nodesI = POSITIONS[i];
				if (nodesI.length === own.size && nodesI.every(n => own.has(n))) continue; // skip Erupt's own slot
				if (!nodesI.some(n => this.stones[n] === color)) continue; // need an existing stone
				for (let m = 0; m < 2; m++) {
					const moves = this._allMoveable(color);
					let chosen = null;
					for (const n of nodesI) {
						if (moves.includes(n)) { chosen = n; break; }
					}
					if (chosen === null) break;
					actions.push(this._doMove(color, chosen, false));
					this.update();
					if (this.gameover) return actions;
				}
			}
		} else if (rt === 'locked_or_self_moves') {
			// Gather/Harvest: `count` moves into your locked spell or this
			// spell's own slot. The lock is assigned after resolution, so
			// this.lock[color] still names the previously locked spell.
			const selfIdx = this.spellNames.indexOf(spellName) + 1;
			const lockName = this.lock[color];
			const lockIdx = lockName ? this.spellNames.indexOf(lockName) + 1 : 0;
			const allowed = new Set(POSITIONS[selfIdx]);
			if (lockIdx >= 1) for (const n of POSITIONS[lockIdx]) allowed.add(n);
			for (let i = 0; i < info.count; i++) {
				const moves = this._allMoveable(color).filter(n => allowed.has(n));
				if (!moves.length) break;
				actions.push(this._doMove(color, moves[0], false, pushDests.shift()));
				this.update();
				if (this.gameover) return actions;
			}
		} else if (rt === 'scatter') {
			// 1 soft blink into each of 2 different spells (any empty node).
			const usedSpells = new Set();
			for (let move = 0; move < 2; move++) {
				let placed = null;
				for (let i = 1; i <= 9; i++) {
					if (usedSpells.has(i)) continue;
					for (const n of POSITIONS[i]) {
						if (this.stones[n] === null) { placed = { n, idx: i }; break; }
					}
					if (placed) break;
				}
				if (!placed) break;
				this.stones[placed.n] = color;
				usedSpells.add(placed.idx);
				actions.push(new SimAction('blink', { node: placed.n }));
				this.update();
			}
		} else if (rt === 'blossom') {
			// 1 soft blink into each other 3-node and 5-node spell.
			const selfIdx = this.spellNames.indexOf(spellName) + 1;
			for (let i = 1; i <= 6; i++) {
				if (i === selfIdx) continue;
				let placed = null;
				for (const n of POSITIONS[i]) {
					if (this.stones[n] === null) { placed = n; break; }
				}
				if (!placed) break; // ends early
				this.stones[placed] = color;
				actions.push(new SimAction('blink', { node: placed }));
				this.update();
			}
		} else if (rt === 'syzygy') {
			// 1 blink into the opposite 1-node spell, then up to 3 into the opposite 3-node spell.
			const SYZ_OPP = { 1: { charm: 8, sorcery: 5 }, 2: { charm: 9, sorcery: 6 }, 3: { charm: 7, sorcery: 4 } };
			const spellIdx = this.spellNames.indexOf(spellName) + 1;
			const opp = SYZ_OPP[spellIdx];
			if (opp) {
				const charmNode = POSITIONS[opp.charm][0];
				if (this.stones[charmNode] !== color && this.stones[charmNode] !== DESTROYED) {
					if (this.stones[charmNode] === enemy) {
						const dest = this._pushEnemy(charmNode, color, pushDests.shift());
						actions.push(new SimAction('blink', { node: charmNode, pushed_to: dest }));
					} else {
						this.stones[charmNode] = color;
						actions.push(new SimAction('blink', { node: charmNode }));
					}
					this.update();
				}
				for (let move = 0; move < 3; move++) {
					let target = null;
					for (const n of POSITIONS[opp.sorcery]) {
						if (this.stones[n] !== color && this.stones[n] !== DESTROYED) { target = n; break; }
					}
					if (!target) break;
					if (this.stones[target] === enemy) {
						const dest = this._pushEnemy(target, color, pushDests.shift());
						actions.push(new SimAction('blink', { node: target, pushed_to: dest }));
					} else {
						this.stones[target] = color;
						actions.push(new SimAction('blink', { node: target }));
					}
					this.update();
				}
			}
		} else if (rt === 'destroy_exposed') {
			this._destroyExposed(color, actions);
		} else if (rt === 'corrupt') {
			// Convert up to 3 enemy stones touching the caster, then sacrifice
			// one own stone. Eligibility is frozen against the pre-conversion
			// board so conversions can't chain. Greedy converts the first 3
			// eligible by NODE_ORDER; 'corrupt_targets' override picks specific
			// ones, 'corrupt_sacrifice' picks the stone to give up.
			const eligible = [];
			for (const name of NODE_ORDER) {
				if (this.stones[name] !== enemy) continue;
				if (ADJACENCY[name].some(nb => this.stones[nb] === color)) eligible.push(name);
			}
			const chosenTargets = [];
			for (const cand of (overrides.corrupt_targets || [])) {
				if (eligible.includes(cand) && !chosenTargets.includes(cand)) chosenTargets.push(cand);
			}
			for (const cand of eligible) {
				if (chosenTargets.length >= 3) break;
				if (!chosenTargets.includes(cand)) chosenTargets.push(cand);
			}
			const converted = [];
			for (const name of chosenTargets.slice(0, 3)) {
				if (this.stones[name] === enemy) { this.stones[name] = color; converted.push(name); }
			}
			if (converted.length) actions.push(new SimAction('corrupt', { converted }));
			this.update();
			// Converting the enemy's last stone ends the game — no sacrifice.
			if (this.gameover) return actions;
			const sacOverride = overrides.corrupt_sacrifice;
			let sacDone = false;
			if (sacOverride && this.stones[sacOverride] === color) {
				this.stones[sacOverride] = null;
				actions.push(new SimAction('sacrifice', { node: sacOverride }));
				sacDone = true;
			}
			if (!sacDone) {
				for (const name of [...NODE_ORDER].reverse()) {
					if (this.stones[name] === color) {
						this.stones[name] = null;
						actions.push(new SimAction('sacrifice', { node: name }));
						break;
					}
				}
			}
			this.update();
		} else if (rt === 'restricted_move') {
			// Lurk: 1 move onto any moveable node that is NOT part of a 3- or
			// 5-node spell (1-node spells and non-spell nodes are allowed).
			const targets = this._allMoveable(color).filter(n => !isBigSpellNode(n));
			let chosen = null;
			const ovr = overrides.restricted_target;
			if (ovr && targets.includes(ovr)) chosen = ovr;
			else if (targets.length) chosen = targets[0];
			if (chosen) {
				actions.push(this._doMove(color, chosen, false));
				this.update();
			}
		}
		// --- Panda expansion (greedy default; overrides for choice points) ---
		if (rt === 'bear_trap') {
			const destroyed = [];
			for (const pos of [7, 8, 9]) {
				for (const n of POSITIONS[pos]) {
					if (this.stones[n] === enemy) { this.stones[n] = null; destroyed.push(n); }
				}
			}
			if (destroyed.length) actions.push(new SimAction('bear_trap', { destroyed }));
			this.update();
		} else if (rt === 'shiver') {
			// No useful default swap; rely on enumerated overrides.
			const ovr = overrides.shiver_pair;
			if (ovr && ovr.length === 2 && ovr[0] !== ovr[1]
			    && this.stones[ovr[0]] !== null && this.stones[ovr[1]] !== null) {
				const [a, b] = ovr;
				const tmp = this.stones[a];
				this.stones[a] = this.stones[b];
				this.stones[b] = tmp;
				actions.push(new SimAction('shiver', { node: a, node2: b, val: this.stones[a], val2: this.stones[b] }));
				this.update();
			}
		} else if (rt === 'blood_saplings') {
			if (this.crushedThisTurn) {
				const overrideTargets = (overrides.soft_move_targets || []).slice();
				for (let i = 0; i < 2; i++) {
					const targets = this._softMoveable(color);
					if (!targets.length) break;
					let chosen = null;
					while (overrideTargets.length && chosen === null) {
						const cand = overrideTargets.shift();
						if (targets.includes(cand)) chosen = cand;
					}
					if (chosen === null) chosen = targets.find(t => !posNodes.includes(t)) || targets[0];
					actions.push(this._doSoftMove(color, chosen));
					this.update();
				}
			}
		} else if (rt === 'itch') {
			const targets = this._allMoveable(color);
			let chosen = null;
			const ovr = overrides.itch_target;
			if (ovr && targets.includes(ovr)) chosen = ovr;
			else if (targets.length) chosen = targets[0];
			if (chosen !== null) {
				actions.push(this._doMove(color, chosen, false));
				this.update();
			}
			if (!variantHasDeathmatch(this.variant)) this.spellCounter[enemy] = Math.min(6, this.spellCounter[enemy] + 1);
			actions.push(new SimAction('lock_bump', { target: enemy }));
			this.update();
		} else if (rt === 'free_spirit') {
			if (this.spellCounter[color] <= 1) {
				const targets = this._softMoveable(color);
				if (targets.length) {
					const ovr = overrides.free_spirit_target;
					const chosen = (ovr && targets.includes(ovr))
						? ovr : (targets.find(t => !posNodes.includes(t)) || targets[0]);
					actions.push(this._doSoftMove(color, chosen));
					this.update();
				}
			}
		} else if (rt === 'residue_mixture') {
			if (this.spellCounter[color] > this.spellCounter[enemy]) {
				const ovr = overrides.residue_target;
				let target = (ovr && this.stones[ovr] === enemy)
					? ovr : (NODE_ORDER.find(n => this.stones[n] === enemy) || null);
				if (target) {
					this.stones[target] = color;
					actions.push(new SimAction('bewitch', { node: target }));
					this.update();
				}
				if (!variantHasDeathmatch(this.variant)) this.spellCounter[enemy] = Math.min(6, this.spellCounter[enemy] + 1);
				actions.push(new SimAction('lock_bump', { target: enemy }));
				this.update();
			}
		} else if (rt === 'stampede') {
			const count = Math.min(5, this.spellCounter[color]);
			const overrideTargets = (overrides.hard_move_targets || []).slice();
			for (let i = 0; i < count; i++) {
				const targets = this._hardMoveable(color);
				if (!targets.length) break;
				let chosen = null;
				while (overrideTargets.length && chosen === null) {
					const cand = overrideTargets.shift();
					if (targets.includes(cand)) chosen = cand;
				}
				if (chosen === null) chosen = targets[0];
				actions.push(this._doHardMove(color, chosen, pushDests.shift()));
				this.update();
			}
		} else if (rt === 'choke') {
			const enemies = NODE_ORDER.filter(n => this.stones[n] === enemy);
			if (enemies.length) {
				const ovr = overrides.choke_target;
				const chosen = (ovr && this.stones[ovr] === enemy) ? ovr : enemies[0];
				for (const nb of ADJACENCY[chosen]) {
					if (this.stones[nb] === null) {
						this.stones[nb] = color;
						actions.push(new SimAction('move', { node: nb }));
					}
				}
				this.update();
			}
		} else if (rt === 'perfect_heist') {
			const destroyed = [];
			const placed = [];
			for (const n of MANA_NODES) {
				if (this.stones[n] === DESTROYED) continue; // walls are permanent
				if (this.stones[n] === enemy) destroyed.push(n);
				this.stones[n] = color;
				placed.push(n);
			}
			actions.push(new SimAction('perfect_heist', { destroyed, placed }));
			this.update();
		} else if (rt === 'moth_plague') {
			const overrideTargets = (overrides.moth_targets || []).slice();
			for (let i = 0; i < 3; i++) {
				const enemies = NODE_ORDER.filter(n => this.stones[n] === enemy);
				if (!enemies.length) break;
				let chosen = null;
				while (overrideTargets.length && chosen === null) {
					const cand = overrideTargets.shift();
					if (this.stones[cand] === enemy) chosen = cand;
				}
				if (chosen === null) chosen = enemies[0];
				const dest = this._pushEnemy(chosen, color, pushDests.shift());
				actions.push(new SimAction('blink', { node: chosen, pushed_to: dest }));
				this.update();
			}
		} else if (rt === 'ripples') {
			// Apply the first (up to) two charged 1-node spells' effects twice
			// each. Sub-resolvers emit standard actions, so replay needs nothing new.
			const cands = [];
			for (const pos of [7, 8, 9]) {
				const sn = this.spellNames[pos - 1];
				const sinfo = CORE_SPELLS[sn];
				if (!sinfo || sinfo.static || !sinfo.resolve) continue;
				if (this.stones[POSITIONS[pos][0]] !== color) continue;
				cands.push(sn);
			}
			for (const sn of cands.slice(0, 2)) {
				const subPos = POSITIONS[this.spellNames.indexOf(sn) + 1];
				for (let rep = 0; rep < 2; rep++) {
					const sub = this._resolveSpell(sn, color, subPos, {});
					for (const a of sub) actions.push(a);
					this.update();
				}
			}
		}
		return actions;
	}

	/**
	 * The board mutation `_castSpell` performs *before* the spell resolves:
	 * clear the spell's own position nodes, then (non-charms only) refill up
	 * to `mana` of them by stone-priority. Returns { posNodes, kept }.
	 * Extracted so the enumerator can reproduce the exact board the resolver
	 * will see — push-target enumeration for Carnage/Fury must run on the
	 * post-clear board, since clearing the caster's spell stones changes
	 * which enemies are hard-moveable.
	 */
	_castClearAndRefill(spellName, color) {
		const idx = this.spellNames.indexOf(spellName);
		const posNodes = POSITIONS[idx + 1];
		const info = CORE_SPELLS[spellName];

		for (const n of posNodes) this.stones[n] = null;

		const kept = [];
		if (!info.ischarm) {
			let refills = this.mana[color];
			// Lifesap (static): casting a 5-node spell grants a 2-stone refill.
			if (posNodes.length === 5 && this.chargedSpells[color].includes('Lifesap')) {
				refills = Math.max(refills, 2);
			}
			const priority = posNodes.length === 3
				? [posNodes[2], posNodes[1], posNodes[0]]
				: [posNodes[2], posNodes[3], posNodes[4], posNodes[0], posNodes[1]];
			for (const node of priority) {
				if (refills > 0) { this.stones[node] = color; kept.push(node); refills--; }
			}
		}
		this.update();
		return { posNodes, kept };
	}

	_castSpell(spellName, color, targetOverrides) {
		const info = CORE_SPELLS[spellName];
		const { posNodes, kept } = this._castClearAndRefill(spellName, color);
		const resolveActions = this._resolveSpell(spellName, color, posNodes, targetOverrides);
		this.update();

		if (!info.ischarm) {
			if (this.lock[color] === spellName) this.springlock[color] = spellName;
			else { this.lock[color] = spellName; this.springlock[color] = null; }
			if (!variantHasDeathmatch(this.variant)) this.spellCounter[color]++;
		}

		return [new SimAction('cast', { spell: spellName, kept }), ...resolveActions];
	}

	// --- Legal turn enumeration ---
	_getCastableSpells(color, canSpell, canSummer, postDash) {
		const enemy = this._enemy(color);
		const hasWinter = this.chargedSpells[enemy].includes('Seal_of_Winter');
		const hasSummer = this.chargedSpells[color].includes('Seal_of_Summer');
		const castable = [];
		for (const spellName of this.chargedSpells[color]) {
			const info = CORE_SPELLS[spellName];
			if (!info || info.static) continue;
			if (info.ischarm) {
				if (hasWinter) continue;
				if (spellName === 'Surge') continue;
				if (spellName === 'Splash' && postDash) continue;
				if (canSpell || (!canSpell && hasSummer && canSummer)) castable.push(spellName);
			} else {
				if (this.lock[color] === spellName) {
					if (this.chargedSpells[color].includes('Seal_of_Spring') && this.springlock[color] !== spellName)
						castable.push(spellName);
				} else {
					castable.push(spellName);
				}
			}
		}
		return castable;
	}

	* _enumeratePostDash(color, actionsSoFar, canSpell, canSummer) {
		yield new SimTurn([...actionsSoFar, new SimAction('pass')]);
		const castable = this._getCastableSpells(color, canSpell, canSummer, true);
		for (const spellName of castable) {
			const bs = this.copy();
			const sa = bs._castSpell(spellName, color);
			bs.update();
			yield new SimTurn([...actionsSoFar, ...sa, new SimAction('pass')]);
		}
	}

	* _enumeratePostMove(color, actionsSoFar, canDash, canSpell, canSummer) {
		const enemy = this._enemy(color);
		const hasLightning = this.chargedSpells[color].includes('Seal_of_Lightning');
		const hasSummer = this.chargedSpells[color].includes('Seal_of_Summer');
		// Seal of Autumn (held by the enemy) bars sacrificing in-sigil stones.
		const hasAutumnSeal = this.chargedSpells[enemy].includes('Seal_of_Autumn');
		const canSac = (b, name) => b.stones[name] === color && (!hasAutumnSeal || !isSpellNode(name));

		yield new SimTurn([...actionsSoFar, new SimAction('pass')]);

		// Dash
		if (canDash && canSpell && this.totalStones[color] > 2) {
			const dashTargets = this._allMoveable(color);
			if (dashTargets.length) {
				const bd = this.copy();
				const dashActions = [];

				if (hasLightning) {
					let sac = null;
					for (const name of [...NODE_ORDER].reverse()) {
						if (canSac(bd, name)) { sac = name; break; }
					}
					if (sac) {
						bd.stones[sac] = null;
						bd.update();
						const targets = bd._allMoveable(color);
						if (targets.length) {
							const chosen = targets[0];
							const moveAct = bd._doMove(color, chosen, false);
							if (moveAct) {
								dashActions.push(new SimAction('dash_lightning', { sacrificed: [sac], node: chosen }));
								dashActions.push(moveAct);
								bd.update();
								yield* bd._enumeratePostDash(color, [...actionsSoFar, ...dashActions], canSpell, canSummer);
							}
						}
					}
				} else {
					const sacs = [];
					for (const name of [...NODE_ORDER].reverse()) {
						if (canSac(bd, name) && sacs.length < 2) {
							sacs.push(name);
							bd.stones[name] = null;
						}
					}
					if (sacs.length === 2) {
						bd.update();
						const targets = bd._allMoveable(color);
						if (targets.length) {
							const chosen = targets[0];
							const moveAct = bd._doMove(color, chosen, false);
							if (moveAct) {
								dashActions.push(new SimAction('dash', { sacrificed: sacs, node: chosen }));
								dashActions.push(moveAct);
								bd.update();
								yield* bd._enumeratePostDash(color, [...actionsSoFar, ...dashActions], canSpell, canSummer);
							}
						}
					}
				}
			}
		}

		// Spell casting
		if (canSpell || (!canSpell && hasSummer && canSummer)) {
			const castable = this._getCastableSpells(color, canSpell, canSummer);
			for (const spellName of castable) {
				const bs = this.copy();
				const sa = bs._castSpell(spellName, color);
				bs.update();
				if (canSpell) {
					yield* bs._enumeratePostMove(color, [...actionsSoFar, ...sa], canDash, false, canSummer);
				} else {
					yield* bs._enumeratePostMove(color, [...actionsSoFar, ...sa], canDash, false, false);
				}
			}
		}
	}

	* getLegalTurns(color) {
		this.update();

		// Competitive variant opening: red and blue each get a free
		// blink onto any empty node on their first turn. No spells,
		// no dash. The bound matches the openingPass gate in update():
		// `<= 2` covers turns 1+2 under the 1-indexed live convention
		// and turns 0+1+2 under the 0-indexed test convention.
		if (variantHasCompetitive(this.variant) && this.turnCounter <= 2) {
			for (const n of NODE_ORDER) {
				if (this.stones[n] !== null) continue;
				yield new SimTurn([
					new SimAction('blink', { node: n }),
					new SimAction('pass'),
				]);
			}
			return;
		}

		// Aftershock burn phase (mandatory, before the move phase). Greedy
		// engine: one ranked target per burn; the exhaustive enumerator
		// branches over top-K instead. After the first fizzle the rest
		// fizzle too (burning only shrinks the eligible set).
		const burnActions = [];
		let base = this;
		if (this.burnsThisTurn) {
			base = this.copy();
			for (let i = 0; i < this.burnsThisTurn; i++) {
				const targets = base._burnTargets(color);
				if (!targets.length) break;
				const t = targets[0];
				base.stones[t] = null;
				burnActions.push(new SimAction('burn', { node: t }));
				base.update();
				if (base.gameover) {
					// Burned the enemy's last stone.
					yield new SimTurn(burnActions.concat([new SimAction('pass')]));
					return;
				}
			}
		}

		const hasWind = base.chargedSpells[color].includes('Seal_of_Wind');
		// Seal of Stone (held by the enemy): this color's opening move must be soft.
		// Soft takes precedence over Wind's blink privilege.
		const enemyHasStone = base.chargedSpells[base._enemy(color)].includes('Seal_of_Stone');
		const moveTargets = enemyHasStone ? base._softMoveable(color)
			: (hasWind ? base._blinkable(color) : base._allMoveable(color));

		if (!moveTargets.length) {
			yield new SimTurn(burnActions.concat([new SimAction('pass')]));
			return;
		}

		for (const target of moveTargets) {
			const bam = base.copy();
			const isBlink = hasWind && !ADJACENCY[target].some(nb => bam.stones[nb] === color);
			const moveAction = bam._doMove(color, target, isBlink);
			if (!moveAction) continue;
			bam.update();
			yield* bam._enumerateMovePhase(color, burnActions.concat([moveAction]), this.extraMovesThisTurn);
		}
	}

	/**
	 * Providence move phase: at each step, either stop taking base moves
	 * (proceed to dash/cast/pass — remaining extras forfeit at end of turn)
	 * or take one more. Greedy engine: a single target per extra step
	 * (matching the greedy dash convention); the exhaustive enumerator
	 * branches over top-K targets instead. With extrasLeft === 0 this is
	 * exactly the pre-Providence flow. Wind's blink privilege and Stone's
	 * soft-move restriction apply only to the turn's FIRST move, so extra
	 * steps use _allMoveable.
	 */
	* _enumerateMovePhase(color, actionsSoFar, extrasLeft) {
		yield* this._enumeratePostMove(color, actionsSoFar, true, true, true);
		if (extrasLeft <= 0 || this.gameover) return;
		const targets = this._allMoveable(color);
		if (!targets.length) return;
		const b = this.copy();
		const act = b._doMove(color, targets[0], false);
		if (!act) return;
		b.update();
		yield* b._enumerateMovePhase(color, actionsSoFar.concat([act]), extrasLeft - 1);
	}
}

/**
 * Seal of Destruction (Covenant ritual), END of `color`'s turn: if `color`
 * controls the seal, destroy every enemy stone touching one of `color`'s stones
 * (Fireblast-style). Mutates `board`, updates, and returns the destroyed nodes.
 */
function destructionEndOfTurn(board, color) {
	if (!board.chargedSpells[color].includes('Seal_of_Destruction')) return [];
	const enemy = board._enemy(color);
	const destroyed = [];
	for (const name of NODE_ORDER) {
		if (board.stones[name] !== enemy) continue;
		for (const nb of ADJACENCY[name]) {
			if (board.stones[nb] === color) { board.stones[name] = null; destroyed.push(name); break; }
		}
	}
	if (destroyed.length) board.update();
	return destroyed;
}

/**
 * Seal of Destruction, START of `color`'s turn: if `color` still controls the
 * seal, they lose immediately. Sets gameover/winner; returns true if lost.
 */
function destructionStartOfTurnLoss(board, color) {
	if (board.gameover) return true;
	if (board.chargedSpells[color].includes('Seal_of_Destruction')) {
		board.gameover = true;
		board.winner = board._enemy(color);
		return true;
	}
	return false;
}

/** Apply a SimTurn's actions to a SimBoard (mutating).
 *
 * 'cast' here is bookkeeping only (sacrifice spell-position stones, refill
 * from action.kept, advance lock/counter). The actions that follow it in
 * the turn — emitted by the spell's resolver during enumeration — carry
 * the resolution outcome. Calling _castSpell here would re-run resolution
 * and double-apply on top of those recorded actions.
 */
function applySimTurn(board, turn, color) {
	const enemy = board._enemy(color);
	board.crushedThisTurn = false;
	for (const action of turn.actions) {
		if (action.type === 'move') {
			board.stones[action.node] = color;
		} else if (action.type === 'hard_move') {
			board._pushEnemy(action.node, color, action.pushed_to);
		} else if (action.type === 'blink') {
			if (board.stones[action.node] === enemy) {
				board._pushEnemy(action.node, color, action.pushed_to);
			} else {
				board.stones[action.node] = color;
			}
		} else if (action.type === 'cast') {
			const info = CORE_SPELLS[action.spell];
			const spellIdx = board.spellNames.indexOf(action.spell);
			const posNodes = POSITIONS[spellIdx + 1] || [];
			for (const n of posNodes) board.stones[n] = null;
			if (info && !info.ischarm && action.kept) {
				for (const n of action.kept) board.stones[n] = color;
			}
			if (info && !info.ischarm) {
				if (board.lock[color] === action.spell) board.springlock[color] = action.spell;
				else { board.lock[color] = action.spell; board.springlock[color] = null; }
				if (!variantHasDeathmatch(board.variant)) board.spellCounter[color]++;
			}
		} else if (action.type === 'dash' || action.type === 'dash_lightning') {
			if (action.sacrificed) {
				for (const sac of action.sacrificed) board.stones[sac] = null;
			}
		}
		// Resolver-emitted outcomes — apply the recorded result directly.
		else if (action.type === 'sacrifice') {
			if (action.node) board.stones[action.node] = null;
		}
		else if (action.type === 'fireblast' || action.type === 'hail_storm'
		         || action.type === 'storm_front' || action.type === 'hurricane'
		         || action.type === 'bear_trap' || action.type === 'decay') {
			if (action.destroyed) for (const n of action.destroyed) board.stones[n] = null;
		}
		else if (action.type === 'perfect_heist') {
			if (action.placed) for (const n of action.placed) board.stones[n] = color;
		}
		else if (action.type === 'shiver') {
			if (action.node) board.stones[action.node] = action.val;
			if (action.node2) board.stones[action.node2] = action.val2;
		}
		else if (action.type === 'lock_bump') {
			if (action.target && !variantHasDeathmatch(board.variant)) board.spellCounter[action.target] = Math.min(6, board.spellCounter[action.target] + 1);
		}
		else if (action.type === 'bewitch') {
			if (action.node) board.stones[action.node] = color;
			if (action.node2) board.stones[action.node2] = color;
		}
		else if (action.type === 'starfall') {
			if (action.node) board.stones[action.node] = color;
			if (action.node2) board.stones[action.node2] = color;
			if (action.destroyed) for (const n of action.destroyed) board.stones[n] = null;
		}
		else if (action.type === 'meteor_destroy') {
			if (action.node) board.stones[action.node] = null;
		}
		else if (action.type === 'gust') {
			if (action.destroyed) for (const n of action.destroyed) board.stones[n] = null;
			if (action.kept) for (const n of action.kept) board.stones[n] = enemy;
		}
		else if (action.type === 'corrupt') {
			if (action.converted) for (const n of action.converted) board.stones[n] = color;
		}
		else if (action.type === 'fissure') {
			if (action.destroyed) for (const n of action.destroyed) board.stones[n] = null;
			if (action.wall) board.stones[action.wall] = DESTROYED;
			// Ambush: the blast also cleared these enemy snares.
			if (action.nodes) for (const n of action.nodes) delete board.snares[n];
		}
		else if (action.type === 'rock_slide') {
			if (action.pushes) {
				for (const p of action.pushes) {
					const moved = board.stones[p.from];
					board.stones[p.from] = null;
					if (board.stones[p.to] !== null) board.crushedThisTurn = true;
					board.stones[p.to] = moved;
				}
			}
		}
		else if (action.type === 'schedule_moves') {
			const sched = board.pendingMoves[color];
			const n = action.turns || 0;
			while (sched.length < n) sched.push(0);
			for (let i = 0; i < n; i++) sched[i] += 1;
		}
		else if (action.type === 'burn') {
			if (action.node) board.stones[action.node] = null;
		}
		else if (action.type === 'schedule_burns') {
			const sched = board.pendingBurns[color];
			const n = action.turns || 0;
			while (sched.length < n) sched.push(0);
			for (let i = 0; i < n; i++) sched[i] += 1;
		}
		else if (action.type === 'place_snares') {
			if (action.nodes) for (const n of action.nodes) board.snares[n] = color;
		}
		board.update();
	}
	// Seal of Destruction end-of-turn trigger (the start-of-turn loss is applied
	// by the turn driver, e.g. _minimaxApplyTurn / the live controllers).
	destructionEndOfTurn(board, color);
}
