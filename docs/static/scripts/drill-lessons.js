// Practice drills (drills.html): short exercises on pushing, dashing and when
// to cast, played on the real board by game-board-local.js in tutorial mode
// (the lesson format is documented in tutorial-lessons.js and at
// drillStepAccepts). A drill adds:
//   group      'pushes' | 'dashing' | 'casting' (the page's sections)
//   goal       what a correct turn achieves, checked by tools/drills-verify.js
//              on EVERY turn the position allows: win (the mover wins),
//              notLose, crush: n (enemy stones lost), uncharged: spell (the
//              enemy's spell is not filled at the end), holds: [nodes],
//              notTheirs: [nodes], minStones: n (the mover's stones at the end)
//   steps[].why    an explanation per wrong token at that step ('*': any other)
//   steps[].ask    a prediction: the node a push will land on (the click is
//                  answered on the page and never played); `right` is shown
//                  after a correct guess
// tools/drills-verify.js proves each drill against the browser rules: every
// turn the script accepts meets the goal, every turn that meets the goal is
// accepted, and every `why` is attached to a move that cannot meet it.
// tools/browser/drills-test.js plays each one on the page.

(function () {
	// The tutorial's spell layout, so the board stays familiar: Bewitch
	// a2-a6, Flourish b2-b6, Carnage c2-c6, Fireblast a8-a10, Grow b8-b10,
	// Hail Storm c8-c10, Surge a7, Slash b7, Sprout c7.
	const SPELLS = ['Bewitch', 'Flourish', 'Carnage', 'Fireblast', 'Grow', 'Hail_Storm', 'Surge', 'Slash', 'Sprout'];

	window.SIGIL_DRILLS = [
		// ------------------------------------------------------------ pushes
		{
			id: 'push-land',
			group: 'pushes',
			title: 'Where will it land?',
			intro: '<p>Red fills all three nodes of <strong>Fireblast</strong> (a8, a9, a10) and can cast it next turn. Your stone on b11 touches a10: a hard move there breaks the sigil.</p>'
				+ '<p>A pushed stone goes to the <em>nearest</em> empty node. It may pass through stones of its own colour, never through yours.</p>',
			red: 'a1 a8 a9 a10 a13',
			blue: 'b1 b2 b6 b11',
			turn: 14,
			spells: SPELLS,
			goal: { uncharged: 'Fireblast', minStones: 5 },
			steps: [
				{
					ask: 'a7',
					say: 'Before you push: where will the red stone on a10 end up? Click that node.',
					right: 'Right: it passes through a8, a red stone, to a7, two steps from a10. Every other empty node is further away.',
					why: {
						a8: 'a8 already holds a red stone. The pushed stone can pass through it, but it has to stop on an empty node.',
						a9: 'a9 already holds a red stone. The pushed stone can pass through it, but it has to stop on an empty node.',
						a13: 'a13 holds a red stone too, so the pushed stone could only pass through it.',
						a3: 'a3 can be reached (through a9 and a13), but it is three steps from a10. a7 is only two: through a8.',
						b11: 'b11 is your stone: a pushed stone never passes through or onto your stones.',
						'*': 'Count the steps from a10: the stone may pass through red stones, never through yours, and stops on the nearest empty node.',
					},
				},
				{ do: 'a10', say: 'Now push it: place your stone on a10.' },
				{ do: 'pass', say: 'Red\'s Fireblast is broken. Press <strong>End Turn</strong>.', why: { dash: 'A dash costs two stones and buys one move. The sigil is already broken: keep the stones.' } },
			],
			hint: 'Push the red stone on a10 (a hard move from b11), then end the turn.',
			success: '<p>The stone went through its red neighbour on a8 to a7, the nearest empty node. Red no longer fills Fireblast.</p>',
		},
		{
			id: 'push-or-crush',
			group: 'pushes',
			title: 'Push or crush?',
			intro: '<p>Three red stones touch yours. A hard move onto any of them pushes it, but a stone with nowhere to go is <strong>crushed</strong>: removed from the game.</p>'
				+ '<p>Find the stone you can crush.</p>',
			red: 'a1 a2 c1 b4 b10 b13',
			blue: 'b1 b2 b3 b9 b11',
			turn: 16,
			spells: SPELLS,
			goal: { crush: 1, minStones: 6 },
			steps: [
				{
					do: 'b13',
					say: 'Make the hard move that crushes a red stone.',
					why: {
						b4: 'The stone on b4 was pushed, not crushed: b5 and b7 next to it were empty, so it had somewhere to go.',
						b10: 'The stone on b10 was pushed, not crushed: b8 and c11 next to it were empty, so it had somewhere to go.',
						'*': 'That is a soft move. Look for a red stone whose neighbours are all your stones.',
					},
				},
				{ do: 'pass', say: 'Crushed. Press <strong>End Turn</strong>.', why: { dash: 'A dash costs two stones and buys one move: here no second crush is on offer, so it only loses a stone.' } },
			],
			hint: 'b13 touches only b3 and b9, both yours: a hard move there crushes the stone.',
			success: '<p>b13 touches only b3 and b9, both yours, so the stone had nowhere to go. A crush is a two-stone swing: you gain a stone and Red loses one.</p>',
		},
		{
			id: 'push-choice',
			group: 'pushes',
			title: 'Choose where it goes',
			intro: '<p>The red stone on c11 stands between your stones and the top of the board. Push it out.</p>'
				+ '<p>When two empty nodes are equally near, <strong>you</strong> choose where your opponent\'s stone goes. Choose well: c1 is a <em>mana</em> node.</p>',
			red: 'a1 a2 a5 a6 c11',
			blue: 'b1 b2 b9 b10 b11',
			turn: 18,
			spells: SPELLS,
			goal: { holds: ['c11'], notTheirs: ['c1'], minStones: 6 },
			steps: [
				{ do: 'c11', say: 'Push the red stone off c11: place your stone on it.' },
				{
					do: 'c6',
					say: 'It can go to c1 or c6, both one step away. Click where it goes.',
					why: { c1: 'You pushed the stone onto c1, a mana node. Every 3- or 5-node spell Red casts while holding it keeps one more stone on its sigil. Send it to c6 instead.' },
				},
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Move onto c11, send the stone to c6 (not the mana node c1), and end the turn.',
			success: '<p>Mana matters: each mana node a player holds lets them keep one stone on the sigil of every 3- or 5-node spell they cast. Never hand one over in a push.</p>',
		},
		{
			id: 'crush-group',
			group: 'pushes',
			title: 'Crush a boxed-in group',
			intro: '<p>A pushed stone can travel through its own colour, so a stone with red neighbours usually escapes. But if the whole <strong>group</strong> is boxed in by your stones, there is nowhere to go.</p>'
				+ '<p>Find a crush.</p>',
			red: 'a1 a5 a11 b4 c1 c2',
			blue: 'a2 a6 b1 b11 c10',
			turn: 20,
			spells: SPELLS,
			goal: { crush: 1, minStones: 6 },
			steps: [
				{
					do: { oneOf: ['a1', 'a11'] },
					say: 'Make a hard move that crushes a red stone.',
					why: {
						a5: 'The stone on a5 was pushed, not crushed: a4 and a12 next to it were empty.',
						'*': 'That is a soft move. Look at the two red stones on a1 and a11: what do they touch?',
					},
				},
				{ do: 'pass', say: 'Crushed. Press <strong>End Turn</strong>.', why: { dash: 'A dash costs two of your stones for one move. Even if that move crushes the other red stone too, it only trades one of your stones for one of Red\'s.' } },
			],
			hint: 'The red stones on a1 and a11 touch only each other and your stones on a2, a6 and c10. Move onto either of them.',
			success: '<p>The pair a1, a11 touched only your stones, so the push found no empty node anywhere: either stone was crushed. (Crushing the stone on a1 also takes Red\'s mana node.)</p>',
		},

		// ----------------------------------------------------------- dashing
		{
			id: 'dash-not',
			group: 'dashing',
			title: 'When not to dash',
			intro: '<p>You are <strong>2 ahead</strong> on the score track; 3 ahead at the end of your turn wins.</p>'
				+ '<p>A <strong>dash</strong> sacrifices two of your stones for one extra move. Win this turn.</p>',
			red: 'a1 a2 a3 c1 c2',
			blue: 'b1 b2 b6 b11 b13 b9',
			turn: 22,
			spells: SPELLS,
			win: true,
			goal: { win: true },
			steps: [
				{ do: { any: true }, say: 'Make your regular move.' },
				{
					do: 'pass',
					say: 'Dash, or end the turn?',
					why: { dash: 'A dash costs two stones and gives one move back, so unless that move crushes a stone you finish a stone worse off: 2 ahead, not 3, and no win. You were already 3 ahead after your move.' },
				},
			],
			hint: 'Any move puts you 3 ahead. Then end the turn: a dash would cost a stone.',
			success: '<p>A dash is never free: two stones for one move. It pays only when the extra move crushes, completes a sigil you cast at once, or stops something worse.</p>',
		},
		{
			id: 'dash-finish',
			group: 'dashing',
			title: 'Dash to finish',
			intro: '<p>You have cast <strong>five</strong> spells. Casting a sixth ends the game at the end of your turn, and the player with more stones wins (a tie goes to the player who moves next).</p>'
				+ '<p>You hold b8 of <strong>Grow</strong> (&ldquo;Make 2 soft moves&rdquo;) and are one stone ahead. One move cannot fill Grow, but a move and a dash can. Win this turn.</p>',
			red: 'a1 a2 c1 c2 c3',
			blue: 'b1 b2 b6 b8 b11',
			turn: 24,
			spellCounts: [4, 5],
			locks: ['Carnage', 'Flourish'],
			spells: SPELLS,
			win: true,
			goal: { win: true },
			steps: [
				{ do: { oneOf: ['b9', 'b10'] }, say: 'Make your regular move.', why: { '*': 'Grow needs b9 and b10: make one of them your regular move.' } },
				{ do: 'dash', say: 'Now dash.', why: { pass: 'Grow is not filled yet: without the dash you cannot cast your sixth spell this turn.' } },
				{
					do: { pick: 2, from: ['b2', 'b6', 'b11'] },
					say: 'Sacrifice two stones.',
					why: {
						b1: 'b1 is your mana node. Without it you keep no stone on Grow when you cast: the cast then costs three stones, Grow gives back two, the stones end level, and Red, who moves next, wins.',
						b8: 'That stone is on Grow\'s sigil: you need it to fill the spell.',
						b9: 'That stone is on Grow\'s sigil: you need it to fill the spell.',
						b10: 'That stone is on Grow\'s sigil: you need it to fill the spell.',
					},
				},
				{ do: { oneOf: ['b9', 'b10'] }, say: 'Your dash move: fill Grow\'s last node.' },
				{ do: 'Grow', say: 'Cast Grow, your sixth spell.' },
				{ do: { any: true }, say: 'Your mana lets you keep one stone on Grow. Choose it.' },
				{ do: { any: true }, say: 'Grow: soft move 1 of 2.' },
				{ do: { any: true }, say: 'Soft move 2 of 2.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Fill b9 and b10 (one with your move, one with the dash), sacrificing two stones that are neither on Grow nor your mana b1, then cast Grow.',
			success: '<p>The dash cost a stone, Grow cost none (three off the sigil, one kept for your mana, two soft moves), and you ended a stone ahead with your sixth spell cast.</p>',
		},
		{
			id: 'dash-break',
			group: 'dashing',
			title: 'Dash to break a spell',
			intro: '<p>Red fills <strong>Fireblast</strong> (a8, a9, a10) and will cast it next turn. None of your stones touches it yet, so one move cannot break it.</p>'
				+ '<p>Break the sigil this turn.</p>',
			red: 'a1 a2 a8 a9 a10',
			blue: 'b1 b2 b3 b6',
			turn: 26,
			spells: SPELLS,
			goal: { uncharged: 'Fireblast' },
			steps: [
				{ do: 'b11', say: 'Make your regular move: get next to the sigil.', why: { '*': 'From there your stones cannot reach a Fireblast node this turn. b11 touches a10.' } },
				{ do: 'dash', say: 'Now dash.', why: { pass: 'Red still fills Fireblast and casts it next turn.' } },
				{
					do: { pick: 2, from: ['b1', 'b2', 'b3', 'b6'] },
					say: 'Sacrifice two stones.',
					why: { b11: 'b11 is the stone that touches a10: without it your dash move cannot reach the sigil.' },
				},
				{ do: 'a10', say: 'Your dash move: push the red stone off a10.' },
				{ do: { oneOf: ['a7', 'a13'] }, say: 'Two empty nodes are equally near: choose where the red stone goes.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Move to b11, dash (keep b11), and use the dash move on a10.',
			success: '<p>The dash cost you a stone, but Red\'s Fireblast is broken. A dash is a second move in one turn: use it when one move is not enough.</p>',
		},

		// ----------------------------------------------------------- casting
		{
			id: 'cast-ahead-first',
			group: 'casting',
			title: 'Get ahead, then cast',
			intro: '<p>You have cast five spells and <strong>Grow</strong> is filled: casting it ends the game at the end of your turn. The player with more stones wins; on a tie, the player who moves next.</p>'
				+ '<p>You are one stone behind. Win this turn.</p>',
			red: 'a1 a2 a3 c1 c2 c3 b13',
			blue: 'b1 b3 b8 b9 b10',
			turn: 28,
			spellCounts: [4, 5],
			locks: ['Carnage', 'Flourish'],
			spells: SPELLS,
			win: true,
			goal: { win: true },
			steps: [
				{ do: 'b13', say: 'Make your regular move.', why: { '*': 'That move leaves the stones level at best, and Grow does not change the count (three off the sigil, one kept for your mana, two soft moves). On a tie Red, who moves next, wins. Find a crush first.' } },
				{ do: 'Grow', say: 'Now you are one ahead. Cast Grow, your sixth spell.', why: { pass: 'You are ahead now: casting your sixth spell ends the game in your favour.' } },
				{ do: { any: true }, say: 'Keep one stone on Grow (you hold one mana).' },
				{ do: { any: true }, say: 'Grow: soft move 1 of 2.' },
				{ do: { any: true }, say: 'Soft move 2 of 2.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Crush the red stone on b13 first (it touches only your stones), then cast Grow.',
			success: '<p>The crush swung the count by two, from one behind to one ahead, and then the sixth spell ended the game.</p>',
		},
		{
			id: 'cast-not-yet',
			group: 'casting',
			title: 'Count before you cast',
			intro: '<p>You have cast five spells and <strong>Flourish</strong> is filled. A sixth spell ends the game at the end of your turn.</p>'
				+ '<p>Casting Flourish takes all five stones off its sigil, you keep one per mana node you hold, and Flourish gives back four soft moves. Make your move, then decide whether to cast.</p>',
			red: 'a1 a2 a3 a4 c1 c2 c3',
			blue: 'b2 b3 b4 b5 b6',
			turn: 30,
			spellCounts: [4, 5],
			locks: ['Carnage', 'Grow'],
			spells: SPELLS,
			goal: { notLose: true, noCast: true, minStones: 6 },
			steps: [
				{ do: { any: true }, say: 'Make your regular move.' },
				{
					do: 'pass',
					say: 'Cast Flourish, dash, or end the turn?',
					why: {
						Flourish: 'Count it: the cast takes five stones off Flourish, you keep one per mana node, and Flourish gives back four. Even with the mana on b1 you end level, and on a tie Red, who moves next, wins. Do not end the game unless you will be ahead.',
						dash: 'A dash costs two stones for one move. It would leave you behind.',
					},
				},
			],
			hint: 'Move, then end the turn: casting Flourish now ends the game level, and Red wins ties after your turn.',
			success: '<p>Before casting a sixth spell, count the stones at the end of the turn: sigil stones lost, stones kept for your mana, and what the spell gives back.</p>',
		},
		{
			id: 'cast-mana-first',
			group: 'casting',
			title: 'Mana first',
			intro: '<p>You have cast five spells and <strong>Grow</strong> is filled. You are level on stones and hold no mana.</p>'
				+ '<p>Casting keeps one stone on the sigil for each mana node you hold. Win this turn.</p>',
			red: 'a1 a2 a3 c2 a6',
			blue: 'b8 b9 b10 c11',
			turn: 32,
			spellCounts: [4, 5],
			locks: ['Carnage', 'Flourish'],
			spells: SPELLS,
			win: true,
			goal: { win: true },
			steps: [
				{ do: 'c1', say: 'Make your regular move.', why: { '*': 'Without a mana you keep no stone on Grow: the cast costs three stones and Grow gives back two, so you finish level and Red, who moves next, wins. Take the mana node first.' } },
				{ do: 'Grow', say: 'Cast Grow, your sixth spell.' },
				{ do: { any: true }, say: 'Your new mana lets you keep one stone on Grow. Choose it.' },
				{ do: { any: true }, say: 'Grow: soft move 1 of 2.' },
				{ do: { any: true }, say: 'Soft move 2 of 2.' },
				{ do: 'pass', say: 'Press <strong>End Turn</strong>.' },
			],
			hint: 'Move onto the mana node c1 first, then cast Grow.',
			success: '<p>The mana node came first, so the cast kept a stone on Grow and you finished a stone ahead.</p>',
		},
	];
})();
