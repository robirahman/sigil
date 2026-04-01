function stoneChar(stone) {
	if (stone === 'red') return 'r';
	if (stone === 'blue') return 'b';
	return '.';
}

function charToStone(ch) {
	if (ch === 'r') return 'red';
	if (ch === 'b') return 'blue';
	return null;
}

function boardToSfn(board) {
	const stonesStr = NODE_ORDER.map(n => stoneChar(board.stones[n])).join('');
	const spellsStr = board.spellNames.join(',');
	const turn = board.whoseTurn === 'red' ? 'r' : 'b';
	const tc = board.turnCounter;
	const rsc = board.spellCounter.red;
	const bsc = board.spellCounter.blue;
	const rlock = board.lock.red || '-';
	const block = board.lock.blue || '-';
	const rspring = board.springlock.red || '-';
	const bspring = board.springlock.blue || '-';
	const score = board.score || 'b1';
	return `${stonesStr}/${spellsStr} ${turn} ${tc} ${rsc}:${bsc} ${rlock}:${block} ${rspring}:${bspring} ${score}`;
}

function sfnToDict(sfnStr) {
	const parts = sfnStr.split(' ');
	const [stonesStr, spellsStr] = parts[0].split('/');

	const stones = {};
	for (let i = 0; i < NODE_ORDER.length; i++) {
		stones[NODE_ORDER[i]] = charToStone(stonesStr[i]);
	}

	const spellNames = spellsStr.split(',');
	const turn = parts[1] === 'r' ? 'red' : 'blue';
	const turncounter = parseInt(parts[2]);

	const scParts = parts[3].split(':');
	const redSc = parseInt(scParts[0]);
	const blueSc = parseInt(scParts[1]);

	const lockParts = parts[4].split(':');
	const redLock = lockParts[0] === '-' ? null : lockParts[0];
	const blueLock = lockParts[1] === '-' ? null : lockParts[1];

	const springParts = parts[5].split(':');
	const redSpring = springParts[0] === '-' ? null : springParts[0];
	const blueSpring = springParts[1] === '-' ? null : springParts[1];

	const score = parts[6];

	return {
		stones, spell_names: spellNames, turn, turncounter,
		red_spellcounter: redSc, blue_spellcounter: blueSc,
		red_lock: redLock, blue_lock: blueLock,
		red_springlock: redSpring, blue_springlock: blueSpring,
		score,
	};
}
