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
	}
}

class SimTurn {
	constructor(actions) {
		this.actions = actions || [];
	}
}

class SimBoard {
	constructor(spellNames) {
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
	}

	static fromSigilBoard(board) {
		const sb = new SimBoard(board.spellNames);
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
		return sb;
	}

	copy() {
		const b = new SimBoard(this.spellNames);
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

	checkGameOver(activeColor) {
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

	_pushEnemy(nodeName, color) {
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
		if (!options.length) return 'X';
		const dest = options[0];
		this.stones[dest] = enemy;
		return dest;
	}

	_doSoftMove(color, node) {
		this.stones[node] = color;
		return new SimAction('move', { node });
	}

	_doHardMove(color, node) {
		const dest = this._pushEnemy(node, color);
		return new SimAction('hard_move', { node, pushed_to: dest });
	}

	_doMove(color, node, isBlink) {
		if (this.stones[node] === null) {
			if (isBlink) { this.stones[node] = color; return new SimAction('blink', { node }); }
			return this._doSoftMove(color, node);
		} else if (this.stones[node] === this._enemy(color)) {
			const act = this._doHardMove(color, node);
			if (isBlink) act.type = 'blink';
			return act;
		}
		return null;
	}

	// --- Greedy spell resolution ---
	_resolveSpell(spellName, color, posNodes) {
		const info = CORE_SPELLS[spellName];
		if (!info || info.resolve === null) return [];
		const actions = [];
		const enemy = this._enemy(color);
		const rt = info.resolve;

		if (rt === 'soft_moves') {
			for (let i = 0; i < info.count; i++) {
				const targets = this._softMoveable(color);
				if (!targets.length) break;
				const chosen = targets.find(t => !posNodes.includes(t)) || targets[0];
				actions.push(this._doSoftMove(color, chosen));
				this.update();
			}
		} else if (rt === 'hard_moves') {
			for (let i = 0; i < info.count; i++) {
				const targets = this._hardMoveable(color);
				if (!targets.length) break;
				actions.push(this._doHardMove(color, targets[0]));
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
			if (destroyed.length) actions.push(new SimAction('fireblast', { destroyed }));
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
			let best = null, bestCount = 0;
			for (const name of NODE_ORDER) {
				if (this.stones[name] !== null) continue;
				for (const nb of ADJACENCY[name]) {
					if (this.stones[nb] !== null) continue;
					const union = new Set([...ADJACENCY[name], ...ADJACENCY[nb]]);
					const ec = [...union].filter(n => this.stones[n] === enemy).length;
					if (ec > bestCount) { bestCount = ec; best = [name, nb]; }
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
			for (const t of targets) {
				let ae = this.stones[t] === enemy ? 1 : 0;
				ae += ADJACENCY[t].filter(nb => this.stones[nb] === enemy).length;
				if (ae === 1) { chosen = t; break; }
			}
			if (!chosen && targets.length) chosen = targets[0];
			if (chosen) {
				if (this.stones[chosen] === enemy) {
					const dest = this._pushEnemy(chosen, color);
					actions.push(new SimAction('blink', { node: chosen, pushed_to: dest }));
				} else {
					this.stones[chosen] = color;
					actions.push(new SimAction('blink', { node: chosen }));
				}
				this.update();
				for (const nb of ADJACENCY[chosen]) {
					if (this.stones[nb] === enemy) {
						this.stones[nb] = null;
						actions.push(new SimAction('meteor_destroy', { node: nb }));
						break;
					}
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
					const dest = this._pushEnemy(target, color);
					actions.push(new SimAction('blink', { node: target, pushed_to: dest }));
				} else {
					this.stones[target] = color;
					actions.push(new SimAction('blink', { node: target }));
				}
				this.update();
				for (const name of [...NODE_ORDER].reverse()) {
					if (this.stones[name] === color) {
						this.stones[name] = null;
						actions.push(new SimAction('sacrifice', { node: name }));
						break;
					}
				}
				this.update();
			}
		} else if (rt === 'surge_move') {
			const targets = this._allMoveable(color);
			if (targets.length) {
				actions.push(this._doMove(color, targets[0], false));
				this.update();
			}
		}
		return actions;
	}

	_castSpell(spellName, color) {
		const idx = this.spellNames.indexOf(spellName);
		const posNodes = POSITIONS[idx + 1];
		const info = CORE_SPELLS[spellName];

		for (const n of posNodes) this.stones[n] = null;

		const kept = [];
		if (!info.ischarm) {
			let refills = this.mana[color];
			const priority = posNodes.length === 3
				? [posNodes[2], posNodes[1], posNodes[0]]
				: [posNodes[2], posNodes[3], posNodes[4], posNodes[0], posNodes[1]];
			for (const node of priority) {
				if (refills > 0) { this.stones[node] = color; kept.push(node); refills--; }
			}
		}
		this.update();
		const resolveActions = this._resolveSpell(spellName, color, posNodes);
		this.update();

		if (!info.ischarm) {
			if (this.lock[color] === spellName) this.springlock[color] = spellName;
			else { this.lock[color] = spellName; this.springlock[color] = null; }
			this.spellCounter[color]++;
		}

		return [new SimAction('cast', { spell: spellName, kept }), ...resolveActions];
	}

	// --- Legal turn enumeration ---
	_getCastableSpells(color, canSpell, canSummer) {
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
				if (canSpell || (!canSpell && hasSummer && canSummer)) castable.push(spellName);
			} else {
				if (this.lock[color] === spellName) {
					if (this.chargedSpells[color].includes('Spring') && this.springlock[color] !== spellName)
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
		const castable = this._getCastableSpells(color, canSpell, canSummer);
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

/** Apply a SimTurn's actions to a SimBoard (mutating). */
function applySimTurn(board, turn, color) {
	for (const action of turn.actions) {
		if (action.type === 'move') {
			board.stones[action.node] = color;
		} else if (action.type === 'hard_move') {
			board._pushEnemy(action.node, color);
		} else if (action.type === 'blink') {
			const enemy = board._enemy(color);
			if (board.stones[action.node] === enemy) {
				board._pushEnemy(action.node, color);
			} else {
				board.stones[action.node] = color;
			}
		} else if (action.type === 'cast') {
			board._castSpell(action.spell, color);
		} else if (action.type === 'dash' || action.type === 'dash_lightning') {
			if (action.sacrificed) {
				for (const sac of action.sacrificed) board.stones[sac] = null;
			}
		}
		board.update();
	}
}
