/**
 * CataclysmBoard — game board parameterized by a map definition.
 * Supports 2-4 players with configurable topology and win conditions.
 */
class CataclysmBoard {
	constructor(mapDef, spellNames) {
		this.mapDef = mapDef;
		this.nodeOrder = Object.keys(mapDef.nodes);
		this.players = mapDef.players.map(p => p.color);

		// Build team lookup: color -> team number
		this.teams = {};
		for (const p of mapDef.players) {
			this.teams[p.color] = p.team;
		}

		this.stones = {};
		for (const n of this.nodeOrder) {
			this.stones[n] = null;
		}

		this.spellNames = spellNames || generateSpellList();
		this.turnCounter = 0;
		this.whoseTurn = this.players[0];
		this.currentPlayerIndex = -1; // advanced to 0 on first nextTurn()
		this.gameover = false;
		this.winner = null;
		this.eliminated = new Set();

		// Per-player state
		this.spellCounter = {};
		this.lock = {};
		this.springlock = {};
		this.totalStones = {};
		this.mana = {};
		this.chargedSpells = {};
		for (const color of this.players) {
			this.spellCounter[color] = 0;
			this.lock[color] = null;
			this.springlock[color] = null;
			this.totalStones[color] = 0;
			this.mana[color] = 0;
			this.chargedSpells[color] = [];
		}

		this.lastPlay = null;
		this.lastPlayer = null;
		this.snapshot = null;
		this.allLoopingSnapshotCounts = {};
		this.dashed = false;
	}

	setupInitial() {
		for (const [node, color] of Object.entries(this.mapDef.initialStones)) {
			this.stones[node] = color;
		}
		this.update();
	}

	enemies(color) {
		return this.players.filter(c =>
			c !== color && !this.eliminated.has(c) && this.teams[c] !== this.teams[color]
		);
	}

	allies(color) {
		return this.players.filter(c =>
			c !== color && this.teams[c] === this.teams[color]
		);
	}

	isEnemy(nodeColor, actingColor) {
		if (!nodeColor || nodeColor === actingColor) return false;
		return this.teams[nodeColor] !== this.teams[actingColor];
	}

	isAlly(colorA, colorB) {
		return colorA !== colorB && this.teams[colorA] === this.teams[colorB];
	}

	update() {
		// Count stones per player
		for (const color of this.players) {
			this.totalStones[color] = 0;
			this.mana[color] = 0;
			this.chargedSpells[color] = [];
		}
		for (const n of this.nodeOrder) {
			const c = this.stones[n];
			if (c && this.totalStones[c] !== undefined) {
				this.totalStones[c]++;
			}
		}

		// Mana
		for (const manaNode of this.mapDef.manaNodes) {
			const c = this.stones[manaNode];
			if (c && this.mana[c] !== undefined) {
				this.mana[c]++;
			}
		}

		// Charged spells
		for (let i = 0; i < this.spellNames.length; i++) {
			const posIdx = i + 1;
			const nodes = this.mapDef.spellPositions[posIdx];
			if (!nodes || nodes.length === 0) continue;
			const first = this.stones[nodes[0]];
			if (first === null) continue;

			if (this.mapDef.winConditions.teamMode) {
				// In team mode, spell is charged if all nodes belong to the same team
				const team = this.teams[first];
				const allSameTeam = nodes.every(n => {
					const s = this.stones[n];
					return s !== null && this.teams[s] === team;
				});
				if (allSameTeam) {
					// Credit it to the player with the most stones in the position
					const counts = {};
					for (const n of nodes) {
						const s = this.stones[n];
						counts[s] = (counts[s] || 0) + 1;
					}
					let best = first;
					let bestCount = 0;
					for (const [c, cnt] of Object.entries(counts)) {
						if (cnt > bestCount) { best = c; bestCount = cnt; }
					}
					this.chargedSpells[best].push(this.spellNames[i]);
				}
			} else {
				const allSame = nodes.every(n => this.stones[n] === first);
				if (allSame) {
					this.chargedSpells[first].push(this.spellNames[i]);
				}
			}
		}
	}

	getBoardStatePayload() {
		const payload = { type: 'boardstate' };
		for (const n of this.nodeOrder) {
			payload[n] = this.stones[n];
		}
		for (const color of this.players) {
			payload[color + '_lock'] = this.lock[color];
			payload[color + '_spellcounter'] = this.spellCounter[color];
			payload[color + '_stones'] = this.totalStones[color];
		}
		payload.last_player = this.lastPlayer;
		payload.last_play = this.lastPlay;
		payload.eliminated = [...this.eliminated];
		return payload;
	}

	takeSnapshot() {
		const snap = {
			turnCounter: this.turnCounter,
			currentPlayerIndex: this.currentPlayerIndex,
			gameover: this.gameover,
			winner: this.winner,
			lastPlay: this.lastPlay,
			lastPlayer: this.lastPlayer,
			dashed: this.dashed,
			eliminated: new Set(this.eliminated),
			spellCounter: {},
			lock: {},
			springlock: {},
			stones: {},
		};
		for (const color of this.players) {
			snap.spellCounter[color] = this.spellCounter[color];
			snap.lock[color] = this.lock[color];
			snap.springlock[color] = this.springlock[color];
		}
		for (const n of this.nodeOrder) {
			snap.stones[n] = this.stones[n];
		}
		this.snapshot = snap;

		// Looping detection
		let loopKey = '';
		for (const color of this.players) {
			loopKey += this.spellCounter[color] + ',';
		}
		for (const n of this.nodeOrder) {
			loopKey += String(this.stones[n]);
		}
		for (const color of this.players) {
			loopKey += String(this.lock[color]);
		}

		if (this.allLoopingSnapshotCounts[loopKey]) {
			this.allLoopingSnapshotCounts[loopKey]++;
		} else {
			this.allLoopingSnapshotCounts[loopKey] = 1;
		}
		return this.allLoopingSnapshotCounts[loopKey];
	}

	restoreSnapshot() {
		const snap = this.snapshot;
		if (!snap) return;
		this.turnCounter = snap.turnCounter;
		this.currentPlayerIndex = snap.currentPlayerIndex;
		this.gameover = snap.gameover;
		this.winner = snap.winner;
		this.lastPlay = snap.lastPlay;
		this.lastPlayer = snap.lastPlayer;
		this.dashed = snap.dashed;
		this.eliminated = new Set(snap.eliminated);
		for (const color of this.players) {
			this.spellCounter[color] = snap.spellCounter[color];
			this.lock[color] = snap.lock[color];
			this.springlock[color] = snap.springlock[color];
		}
		for (const n of this.nodeOrder) {
			this.stones[n] = snap.stones[n];
		}
		this.update();
	}

	checkGameOver(activeColor) {
		const wc = this.mapDef.winConditions;

		// FFA elimination: remove players with 0 stones
		if (wc.eliminateAtZero) {
			for (const color of this.players) {
				if (this.eliminated.has(color)) continue;
				if (this.totalStones[color] === 0 && this.turnCounter > this.players.length) {
					this.eliminated.add(color);
					// Remove their stones (already 0, but clear any edge cases)
					for (const n of this.nodeOrder) {
						if (this.stones[n] === color) this.stones[n] = null;
					}
				}
			}
			// Check if only one player remains
			const alive = this.players.filter(c => !this.eliminated.has(c));
			if (alive.length === 1) {
				this.gameover = true;
				this.winner = alive[0];
				return true;
			}
		}

		if (wc.teamMode) {
			// 2v2: compare team stone totals
			const teamTotals = {};
			for (const p of this.mapDef.players) {
				teamTotals[p.team] = (teamTotals[p.team] || 0) + this.totalStones[p.color];
			}
			const teams = Object.keys(teamTotals).map(Number);
			if (teams.length === 2) {
				const diff = teamTotals[teams[0]] - teamTotals[teams[1]];
				if (Math.abs(diff) >= wc.stoneWinMargin) {
					this.gameover = true;
					const winningTeam = diff > 0 ? teams[0] : teams[1];
					this.winner = this.mapDef.players.find(p => p.team === winningTeam).color;
					return true;
				}
			}
		} else {
			// FFA or 1v1: check stone dominance
			const alive = this.players.filter(c => !this.eliminated.has(c));
			for (const color of alive) {
				const others = alive.filter(c => c !== color);
				const maxOther = Math.max(...others.map(c => this.totalStones[c]));
				if (this.totalStones[color] - maxOther >= wc.stoneWinMargin) {
					this.gameover = true;
					this.winner = color;
					return true;
				}
			}
		}

		// Spell count trigger
		if (this.spellCounter[activeColor] >= wc.spellCountTarget) {
			this.gameover = true;
			// Most stones wins
			const alive = this.players.filter(c => !this.eliminated.has(c));
			let bestColor = alive[0];
			let bestCount = this.totalStones[alive[0]];
			for (const c of alive) {
				if (this.totalStones[c] > bestCount) {
					bestColor = c;
					bestCount = this.totalStones[c];
				}
			}
			this.winner = bestColor;
			return true;
		}

		return false;
	}
}
