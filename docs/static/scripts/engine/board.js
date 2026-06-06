// Recognized game variants and the variant helpers (variantHasCompetitive /
// variantHasDeathmatch / composeVariant / normalizeVariant) live in
// constants.js so the AI worker — which loads constants.js but not board.js —
// can use them too.

class SigilBoard {
	constructor(spellNames, variant = 'standard') {
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
		// Turn-local: set true when a push crushes an enemy stone this turn
		// (read by Blood Saplings). Reset by the controller at each turn's start.
		this.crushedThisTurn = false;
		this.snapshot = null;
		this.allLoopingSnapshotCounts = {};
		this.variant = normalizeVariant(variant);
	}

	setupInitial() {
		// Standard: red on a1, blue on b1.
		// Competitive: empty board; first two turns place stones via blink.
		if (!variantHasCompetitive(this.variant)) {
			this.stones.a1 = 'red';
			this.stones.b1 = 'blue';
		}
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

		// Immediate-loss (latest-edition rules): a player with zero
		// stones on playable nodes loses right away. Blue's +1 phantom
		// counter token doesn't count for survival. The competitive
		// variant suspends this check until BOTH opening blinks have
		// landed. The live game-controller increments turnCounter
		// before each turn runs, so red's opening is turn 1 and
		// blue's is turn 2 — checking `<= 2` covers both.
		const openingPass = (variantHasCompetitive(this.variant) && this.turnCounter <= 2);
		if (!this.gameover && !openingPass) {
			if (redCount === 0 && blueCount === 0) {
				this.gameover = true;
				this.winner = this.whoseTurn === 'red' ? 'blue' : 'red';
			} else if (redCount === 0) {
				this.gameover = true;
				this.winner = 'blue';
			} else if (blueCount === 0) {
				this.gameover = true;
				this.winner = 'red';
			}
		}

		// Score: blue gets +1 phantom stone (counter token off the
		// playable board — counts toward score only).
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

		// Looping detection (threefold repetition → Blue wins on the 3rd
		// occurrence, both modes). A position is "the same" when stones, side to
		// move (turnCounter parity), and both players' lock AND springlock match
		// — a different locked spell, or a Seal-of-Spring spell still reusable
		// vs. already used twice, means different options are available (real
		// progress), so it is NOT the same position. The ONLY mode difference:
		// non-Deathmatch ALSO factors in the spell counts (Deathmatch has none).
		let loopKey = 'p' + (this.turnCounter % 2);
		for (const n of NODE_ORDER) {
			loopKey += String(this.stones[n]);
		}
		loopKey += '|' + String(this.lock.red) + String(this.lock.blue)
			+ '|' + String(this.springlock.red) + String(this.springlock.blue);
		if (!variantHasDeathmatch(this.variant)) {
			loopKey += '|' + this.spellCounter.red + ',' + this.spellCounter.blue;
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
		// update() may already have flagged immediate-loss (zero stones).
		if (this.gameover) return true;

		// Deathmatch: the only win is elimination (handled in update()). The
		// +3-lead and 6th-spell terminal conditions below are disabled here;
		// threefold repetition is enforced by the controllers.
		if (variantHasDeathmatch(this.variant)) return false;

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
