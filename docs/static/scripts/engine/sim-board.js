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
		return b;
	}

	_enemy(color) { return color === 'red' ? 'blue' : 'red'; }

	update() {
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

		const rs = rc, bs = bc + 1;
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
		return key;
	}

	checkGameOver(activeColor) {
		// update() may already have flagged immediate-loss (zero stones).
		if (this.gameover) return true;

		// Deathmatch: only elimination wins (handled in update()); the
		// +3-lead and 6th-spell conditions below are disabled.
		if (variantHasDeathmatch(this.variant)) return false;

		const rt = this.totalStones.red, bt = this.totalStones.blue + 1;
		if (rt > bt + 2) { this.gameover = true; this.winner = 'red'; return true; }
		if (bt > rt + 2) { this.gameover = true; this.winner = 'blue'; return true; }
		if (this.spellCounter[activeColor] >= 6) {
			this.gameover = true;
			if (rt > bt) this.winner = 'red';
			else if (bt > rt) this.winner = 'blue';
			else this.winner = this._enemy(activeColor);
			return true;
		}
		return false;
	}

	advanceTurn() {
		this.turnCounter++;
		this.whoseTurn = this.whoseTurn === 'red' ? 'blue' : 'red';
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

	_hardMoveable(color) {
		const enemy = this._enemy(color);
		const result = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] === enemy) {
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] === color) { result.push(name); break; }
				}
			}
		}
		return result;
	}

	_allMoveable(color) {
		const result = [];
		for (const name of NODE_ORDER) {
			if (this.stones[name] !== color) {
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] === color) { result.push(name); break; }
				}
			}
		}
		return result;
	}

	_blinkable(color) {
		return NODE_ORDER.filter(n => this.stones[n] !== color);
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
				if (this.stones[mn] === color) continue;
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
			const ovr = overrides.storm_front_pair;
			const destroyed = [];
			if (ovr && ovr.length === 2
			    && this.stones[ovr[0]] === enemy && this.stones[ovr[1]] === enemy
			    && ovr[0] !== ovr[1]) {
				for (const n of ovr) { this.stones[n] = null; destroyed.push(n); }
			} else {
				for (const name of NODE_ORDER) {
					if (destroyed.length >= 2) break;
					if (this.stones[name] === enemy) {
						this.stones[name] = null;
						destroyed.push(name);
					}
				}
			}
			if (destroyed.length) actions.push(new SimAction('storm_front', { destroyed }));
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
			// 1 non-blink move into each 3- and 5-node spell (positions 1..6,
			// including Erupt's own slot), where a legal target exists. Greedy
			// target choice, mirroring Blossom.
			for (let i = 1; i <= 6; i++) {
				const moves = this._allMoveable(color);
				for (const n of POSITIONS[i]) {
					if (moves.includes(n)) {
						actions.push(this._doMove(color, n, false));
						this.update();
						break;
					}
				}
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
				if (this.stones[charmNode] !== color) {
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
						if (this.stones[n] !== color) { target = n; break; }
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
			for (const n of MANA_NODES) {
				if (this.stones[n] === enemy) destroyed.push(n);
				this.stones[n] = color;
			}
			actions.push(new SimAction('perfect_heist', { destroyed, placed: MANA_NODES.slice() }));
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

	_castSpell(spellName, color, targetOverrides) {
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
		const hasWinter = this.chargedSpells[enemy].includes('Winter');
		const hasSummer = this.chargedSpells[color].includes('Seal_of_Summer');
		const castable = [];
		for (const spellName of this.chargedSpells[color]) {
			const info = CORE_SPELLS[spellName];
			if (!info || info.static) continue;
			if (info.ischarm) {
				if (hasWinter) continue;
				if (spellName === 'Surge') continue;
				if (spellName === 'Gush' && postDash) continue;
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
		const hasAutumn = this.chargedSpells[enemy].includes('Autumn');

		yield new SimTurn([...actionsSoFar, new SimAction('pass')]);

		// Dash
		if (canDash && canSpell && this.totalStones[color] > 2 && !hasAutumn) {
			const dashTargets = this._allMoveable(color);
			if (dashTargets.length) {
				const bd = this.copy();
				const dashActions = [];

				if (hasLightning) {
					let sac = null;
					for (const name of [...NODE_ORDER].reverse()) {
						if (bd.stones[name] === color) { sac = name; break; }
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
						if (bd.stones[name] === color && sacs.length < 2) {
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

		const hasWind = this.chargedSpells[color].includes('Seal_of_Wind');
		const moveTargets = hasWind ? this._blinkable(color) : this._allMoveable(color);

		if (!moveTargets.length) {
			yield new SimTurn([new SimAction('pass')]);
			return;
		}

		for (const target of moveTargets) {
			const bam = this.copy();
			const isBlink = hasWind && !ADJACENCY[target].some(nb => bam.stones[nb] === color);
			const moveAction = bam._doMove(color, target, isBlink);
			if (!moveAction) continue;
			bam.update();
			yield* bam._enumeratePostMove(color, [moveAction], true, true, true);
		}
	}
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
		         || action.type === 'bear_trap') {
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
		// 'thunder' is the legacy type for Gust (renamed); accept both so
		// game logs recorded before the rename still replay.
		else if (action.type === 'gust' || action.type === 'thunder') {
			if (action.destroyed) for (const n of action.destroyed) board.stones[n] = null;
			if (action.kept) for (const n of action.kept) board.stones[n] = enemy;
		}
		board.update();
	}
}
