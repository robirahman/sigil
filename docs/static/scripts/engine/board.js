class SigilBoard {
	constructor(spellNames) {
		this.stones = {};
		for (const n of NODE_ORDER) {
			this.stones[n] = null;
		}
		this.spellNames = spellNames || generateSpellList();
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
		this.lastPlay = null;
		this.lastPlayer = null;
		this.snapshot = null;
		this.allLoopingSnapshotCounts = {};
	}

	setupInitial() {
		this.stones.a1 = 'red';
		this.stones.b1 = 'blue';
		this.update();
	}

	enemy(color) {
		return color === 'red' ? 'blue' : 'red';
	}

	update() {
		let redCount = 0, blueCount = 0;
		for (const n of NODE_ORDER) {
			if (this.stones[n] === 'red') redCount++;
			else if (this.stones[n] === 'blue') blueCount++;
		}
		this.totalStones.red = redCount;
		this.totalStones.blue = blueCount;

		// Score: blue gets +1 phantom stone
		const redscore = redCount;
		const bluescore = blueCount + 1;
		if (redscore === bluescore) {
			this.score = 'tied';
		} else if (redscore > bluescore) {
			this.score = 'r' + Math.min(3, redscore - bluescore);
		} else {
			this.score = 'b' + Math.min(3, bluescore - redscore);
		}

		// Mana
		for (const color of ['red', 'blue']) {
			this.mana[color] = MANA_NODES.filter(n => this.stones[n] === color).length;
		}

		// Charged spells
		this.chargedSpells.red = [];
		this.chargedSpells.blue = [];
		for (let i = 0; i < this.spellNames.length; i++) {
			const posIdx = i + 1;
			const nodes = POSITIONS[posIdx];
			if (!nodes || nodes.length === 0) continue;
			const first = this.stones[nodes[0]];
			if (first === null) continue;
			const allSame = nodes.every(n => this.stones[n] === first);
			if (allSame) {
				this.chargedSpells[first].push(this.spellNames[i]);
			}
		}
	}

	getBoardStatePayload() {
		const payload = { type: 'boardstate' };
		for (const n of NODE_ORDER) {
			payload[n] = this.stones[n];
		}
		payload.redlock = this.lock.red;
		payload.bluelock = this.lock.blue;
		payload.redspellcounter = this.spellCounter.red;
		payload.bluespellcounter = this.spellCounter.blue;
		payload.score = this.score;
		payload.last_player = this.lastPlayer;
		payload.last_play = this.lastPlay;
		return payload;
	}

	takeSnapshot() {
		const snap = {
			turnCounter: this.turnCounter,
			gameover: this.gameover,
			winner: this.winner,
			score: this.score,
			redSpellCounter: this.spellCounter.red,
			blueSpellCounter: this.spellCounter.blue,
			redLock: this.lock.red,
			blueLock: this.lock.blue,
			lastPlay: this.lastPlay,
			lastPlayer: this.lastPlayer,
			stones: {},
		};
		for (const n of NODE_ORDER) {
			snap.stones[n] = this.stones[n];
		}
		this.snapshot = snap;

		// Looping detection
		let loopKey = '' + this.spellCounter.red + this.spellCounter.blue;
		for (const n of NODE_ORDER) {
			loopKey += String(this.stones[n]);
		}
		loopKey += String(this.lock.red) + String(this.lock.blue);

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
		this.gameover = snap.gameover;
		this.winner = snap.winner;
		this.score = snap.score;
		this.spellCounter.red = snap.redSpellCounter;
		this.spellCounter.blue = snap.blueSpellCounter;
		this.lock.red = snap.redLock;
		this.lock.blue = snap.blueLock;
		this.lastPlay = snap.lastPlay;
		this.lastPlayer = snap.lastPlayer;
		for (const n of NODE_ORDER) {
			this.stones[n] = snap.stones[n];
		}
		this.update();
	}

	checkGameOver(activeColor) {
		const redTotal = this.totalStones.red;
		const blueTotal = this.totalStones.blue + 1; // phantom stone

		if (redTotal > blueTotal + 2) {
			this.gameover = true;
			this.winner = 'red';
			return true;
		}
		if (blueTotal > redTotal + 2) {
			this.gameover = true;
			this.winner = 'blue';
			return true;
		}

		if (this.spellCounter[activeColor] >= 6) {
			this.gameover = true;
			if (redTotal > blueTotal) this.winner = 'red';
			else if (blueTotal > redTotal) this.winner = 'blue';
			else this.winner = this.enemy(activeColor);
			return true;
		}

		return false;
	}

	loadFromSfn(sfnStr) {
		const state = sfnToDict(sfnStr);
		this.spellNames = state.spell_names;
		for (const n of NODE_ORDER) {
			this.stones[n] = state.stones[n];
		}
		this.turnCounter = state.turncounter;
		this.whoseTurn = state.turn;
		this.score = state.score;
		this.spellCounter.red = state.red_spellcounter;
		this.spellCounter.blue = state.blue_spellcounter;
		this.lock.red = state.red_lock;
		this.lock.blue = state.blue_lock;
		this.springlock.red = state.red_springlock;
		this.springlock.blue = state.blue_springlock;
		this.update();
	}
}
