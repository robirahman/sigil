// Lessons of the interactive tutorial (tutorial.html), played on the real
// board by game-board-local.js in tutorial mode. Ported from the legacy Flask
// tutorial (templates/tutorial.html, static/scripts/tutorial.js), with every
// rule checked against the current engine (board.js, moves.js, spells.js,
// game-controller.js).
//
// A lesson is one Blue turn from a start position:
//   red / blue    the stones, as space-separated node lists
//   spells        the nine spells: three rituals (a2-a6, b2-b6, c2-c6), three
//                 sorceries (a8-a10, b8-b10, c8-c10), three charms (a7, b7, c7)
//   turn          the turn number (even: Blue to move)
//   spellCounts   [red, blue] spells cast; locks [red, blue] locked spells
//   steps         the input tokens the lesson expects, in order, each with the
//                 prompt shown while it is awaited (`say`). `do` is a node, a
//                 spell name, 'dash' or 'pass'; { oneOf: [...] } any one of
//                 them; { all: [...] } each of them, in any order; or
//                 { any: true } any node the game offers.
//   hint          shown when the player does something else (the lesson restarts)
//   win           the lesson ends with Blue winning the game
// tools/browser/tutorial-test.js plays every lesson with these steps.

(function () {
	// One spell layout for every lesson but the Seal of Wind one, so the board
	// stays familiar: Flourish and Grow on Blue's side, Slash on its charm.
	const SPELLS = ['Bewitch', 'Flourish', 'Carnage', 'Fireblast', 'Grow', 'Hail_Storm', 'Surge', 'Slash', 'Sprout'];

	window.SIGIL_TUTORIAL_LESSONS = [
		{
			id: 'placing',
			title: 'Placing stones',
			intro: '<p>Sigil is a fight between red and blue stones for the board and the spells on it. Red always moves first; in these lessons you play <strong>Blue</strong>, whose first stone starts on the mana node at the bottom right.</p>'
				+ '<p>Every turn starts with a <strong>regular move</strong>: place one stone on a node that touches one of your stones. Placing onto an empty node is a <em>soft move</em>.</p>',
			red: 'a1 a2',
			blue: 'b1',
			turn: 2,
			spells: SPELLS,
			steps: [
				{ do: { oneOf: ['b2', 'b11'] }, say: 'Place a stone on one of the gold-ringed nodes next to your stone.' },
				{ do: 'pass', say: 'Now press <strong>End Turn</strong>.' },
			],
			hint: 'A new stone must touch one of your own stones. Click a gold-ringed node, then press End Turn.',
			success: '<p>That is a whole turn. Between the regular move and End Turn you may also dash and cast a spell; the next lessons show how.</p>',
		},
		{
			id: 'pushing',
			title: 'Pushing',
			intro: '<p>You may also place a stone onto an enemy stone. That is a <em>hard move</em>, and the enemy stone is <strong>pushed</strong> to the nearest empty node.</p>'
				+ '<p>A pushed stone can travel through stones of its own colour, but never through yours.</p>',
			red: 'a1 a2 a3 a9 a10',
			blue: 'b1 b2 b11 a8',
			turn: 8,
			spells: SPELLS,
			steps: [
				{ do: 'a10', say: 'Place a stone on the red stone in the gold ring.' },
				{ do: 'pass', say: 'See where the red stone went, then press <strong>End Turn</strong>.' },
			],
			hint: 'Place your stone on the red stone in the gold ring, then press End Turn.',
			success: '<p>The red stone could not retreat onto your stone, so it was pushed through its red neighbour to the nearest empty node beyond it.</p>',
		},
		{
			id: 'push-choice',
			title: 'Choosing the push',
			intro: '<p>Sometimes two or more empty nodes are equally close to a pushed stone. On your turn you make every decision, including where your opponent\'s stone goes.</p>',
			red: 'a1 a2 a3 a10',
			blue: 'b1 b2 b11',
			turn: 6,
			spells: SPELLS,
			steps: [
				{ do: 'a10', say: 'Place a stone on the red stone in the gold ring.' },
				{ do: { oneOf: ['a8', 'a9'] }, say: 'Two empty nodes are equally close. Choose where the red stone goes: click one of the gold rings.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Push the ringed red stone, pick one of the two empty nodes for it, then press End Turn.',
			success: '<p>When a push has a single nearest empty node the game moves the stone there for you; when there are several, you choose.</p>',
		},
		{
			id: 'crushing',
			title: 'Crushing',
			intro: '<p>If a pushed stone has no empty node to reach, because it is boxed in by your stones, it is <strong>crushed</strong> and removed from the game.</p>'
				+ '<p>Crushing is the first way to get ahead on stones.</p>',
			red: 'a1 a2 a4 a5 a6 a13 c1 c2',
			blue: 'b1 b11 a10 a9 a3',
			turn: 10,
			spells: SPELLS,
			steps: [
				{ do: 'a13', say: 'The ringed red stone touches only your stones. Place a stone on it.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Place your stone on the surrounded red stone in the gold ring, then press End Turn.',
			success: '<p>Crushed! Red lost a stone and you gained one: a two-stone swing.</p>',
		},
		{
			id: 'dashing',
			title: 'Dashing',
			intro: '<p>After your regular move you may <strong>dash</strong>: sacrifice two of your stones, then make one more move, soft or hard, touching your stones. You can dash once per turn, before casting a spell.</p>'
				+ '<p>A dash leaves you a stone down unless the move wins something back, so dash for a reason.</p>',
			red: 'a1 a2 a4 a5 a6 a8 a13 c1 c2 c3 c4',
			blue: 'b1 b2 b3 b6 b11 a3 a9 a10',
			turn: 12,
			spells: SPELLS,
			steps: [
				{ do: 'a13', say: 'First the regular move: crush the ringed red stone.' },
				{ do: 'dash', say: 'Now press <strong>Dash</strong>.' },
				{ do: { all: ['b3', 'b6'] }, say: 'Sacrifice the two ringed stones: click each of them.' },
				{ do: 'a8', say: 'Your dash move: push the ringed red stone off the Fireblast sigil.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Crush the ringed stone, press Dash, sacrifice the two ringed stones, then push the ringed red stone and End Turn.',
			success: '<p>You now hold all three nodes of Fireblast. Holding every node of a spell is what lets you cast it, which is next.</p>',
		},
		{
			id: 'charging',
			title: 'Sigils and casting a charm',
			intro: '<p>The nine spells sit on <strong>sigils</strong>: three of five nodes, three of three nodes and three single-node <em>charms</em>. Hover over a spell (or tap it on a phone) to read what it does.</p>'
				+ '<p>When your stones fill every node of a sigil, the spell is <strong>charged</strong>: it lights up, and after your regular move (and dash, if any) you may cast it. Casting sacrifices your stones on the sigil, then you carry out the spell\'s effect. Normally you may cast one spell per turn.</p>',
			red: 'a1 a2 a3 a4 b5 c1 c2 c3',
			blue: 'b1 b2 b3 b4 b6 b12',
			turn: 14,
			spells: SPELLS,
			steps: [
				{ do: 'b7', say: 'Place a stone on the Slash charm to charge it.' },
				{ do: 'Slash', say: 'Slash lights up. Click it to cast it (on a phone, tap it, then <strong>Cast Spell</strong>).' },
				{ do: 'b5', say: 'Slash says &ldquo;Make 1 hard move.&rdquo; Move onto the ringed red stone.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Fill the Slash charm, cast Slash, use its hard move on the ringed red stone, then press End Turn.',
			success: '<p>The red stone was boxed in, so Slash\'s hard move crushed it. A hard move must go onto an enemy stone; a soft move must go onto an empty node.</p>',
		},
		{
			id: 'casting',
			title: 'Mana and casting a big spell',
			intro: '<p>Three nodes are <strong>mana</strong>: the two starting nodes and the one at the top of the board. When you cast a 3- or 5-node spell you keep one stone on its sigil for each mana you hold. Charms get no discount.</p>'
				+ '<p>You hold two mana here, and Flourish (&ldquo;Make 4 soft moves&rdquo;) is one stone from charged.</p>',
			red: 'a1 a2 a3 a4 a6 c2 c3 c6',
			blue: 'b1 c1 b2 b3 b4 b5',
			turn: 16,
			spells: SPELLS,
			steps: [
				{ do: 'b6', say: 'Fill the last node of Flourish.' },
				{ do: 'Flourish', say: 'Cast Flourish.' },
				{ do: { any: true }, say: 'You hold two mana, so you keep two stones on Flourish. Click the first one to keep.' },
				{ do: { any: true }, say: 'Click the second one to keep.' },
				{ do: { any: true }, say: 'Flourish: make 4 soft moves. Each must go onto an empty node touching your stones. Soft move 1 of 4.' },
				{ do: { any: true }, say: 'Soft move 2 of 4.' },
				{ do: { any: true }, say: 'Soft move 3 of 4.' },
				{ do: { any: true }, say: 'Soft move 4 of 4.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Fill Flourish, cast it, keep two stones on it, make four soft moves onto highlighted nodes, then press End Turn.',
			success: '<p>Flourish now has your <strong>lock</strong> on it (the coloured ring). You cannot cast your locked spell again until you cast a different 3- or 5-node spell, which moves the lock there. Each player has their own lock, so your opponent may still cast Flourish.</p>'
				+ '<p>Your spell die also went up by one: it counts the 3- and 5-node spells you have cast.</p>',
		},
		{
			id: 'static',
			title: 'Static spells',
			intro: '<p>Spells whose text starts with <strong>STATIC</strong> are never cast. Instead, their effect is on for as long as your stones fill the sigil.</p>'
				+ '<p>You fill Seal of Wind: &ldquo;Your first move each turn is a blink move.&rdquo; A <em>blink move</em> does not have to touch your stones.</p>',
			red: 'a1 a2 a3 a4 c2 c3',
			blue: 'b1 b2 b8 b9 b10 b11',
			turn: 18,
			spells: ['Bewitch', 'Flourish', 'Carnage', 'Fireblast', 'Seal_of_Wind', 'Hail_Storm', 'Surge', 'Slash', 'Sprout'],
			steps: [
				{ do: 'c1', say: 'Blink onto the empty mana node at the top of the board.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'With Seal of Wind your regular move can go anywhere: place it on the ringed mana node, then press End Turn.',
			success: '<p>You now hold two mana, far from your other stones. Only your regular move blinks: dash moves and the moves spells give you follow their own rules.</p>',
		},
		{
			id: 'win-lead',
			title: 'Winning on stones',
			intro: '<p>The track in the middle of the board counts the difference in stones. Blue\'s score stone sits on it and counts as one Blue stone, to make up for Red moving first.</p>'
				+ '<p>A player who is <strong>3 ahead</strong> on the track at the end of a turn wins. So Blue wins with two more stones on the board than Red, and Red needs four more than Blue. You are 1 ahead now.</p>',
			red: 'a1 a2 a5 a13 c1',
			blue: 'b1 b11 a10 a9 a3',
			turn: 20,
			spells: SPELLS,
			win: true,
			steps: [
				{ do: 'a13', say: 'Crush the ringed red stone: a two-stone swing.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong> to finish the turn 3 ahead.' },
			],
			hint: 'Crush the ringed red stone, then press End Turn.',
			success: '<p>You won by going 3 ahead. A player left with no stones on the board also loses at once.</p>',
		},
		{
			id: 'win-spells',
			title: 'Winning with the sixth spell',
			intro: '<p>The other way a game ends: at the end of the turn in which either player casts their <strong>sixth</strong> 3- or 5-node spell. The player with more stones then wins; on a tie, the player who would move next wins.</p>'
				+ '<p>Your spell die shows five. Grow (&ldquo;Make 2 soft moves&rdquo;) is one stone from charged, and the stones are level.</p>',
			red: 'a1 a2 a3 a4 c1 c2',
			blue: 'b1 b2 b8 b9 b11',
			turn: 22,
			spellCounts: [4, 5],
			locks: ['Carnage', 'Flourish'],
			spells: SPELLS,
			win: true,
			steps: [
				{ do: 'b10', say: 'Fill the last node of Grow.' },
				{ do: 'Grow', say: 'Cast Grow, your sixth spell.' },
				{ do: { any: true }, say: 'You hold one mana: keep one stone on Grow.' },
				{ do: { any: true }, say: 'Grow: soft move 1 of 2.' },
				{ do: { any: true }, say: 'Soft move 2 of 2.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>. You are one stone ahead.' },
			],
			hint: 'Fill Grow, cast it, keep one stone, make two soft moves, then press End Turn.',
			success: '<p>Six spells cast, and you were ahead: Blue wins. That is everything you need to play. Good luck!</p>',
		},
	];
})();
