// Rules reference text shared by spell.html, variants.html and the in-game
// help popover (help.js, "This game's rules"). Plain text, escaped on render.
//
// Every statement here was checked against the browser rules engine, which
// referees every game: engine/game-controller.js (turn, dash, casting, locks,
// Providence), engine/moves.js (move kinds, pushes, the seals that change
// them), engine/spells.js (each spell's resolver), engine/board.js (win
// conditions, filled spells, repetition) and engine/constants.js (variants,
// Fissure, Rock Slide, Bulwark, Seal of Destruction). The card text itself is
// SPELL_TEXTS in constants.js. Change a rule there, change it here.

// How casting works, for every spell page.
const SIGIL_CASTING_RULES = [
	'A spell is filled when your stones occupy every node of its sigil.',
	'You may cast a filled spell after your regular move (and after a dash, if you dash). You may cast one spell a turn; Seal of Summer allows two.',
	'Casting removes all your stones from the sigil. For a 3- or 5-node spell you then keep one stone on it for each mana node you hold. A charm (1-node spell) keeps none.',
	'Then the spell takes effect. A move a spell gives you is never your regular move, so Seal of Wind and the enemy\'s Seal of Stone do not change it.',
	'After a 3- or 5-node spell resolves, your lock moves onto it and your spell count goes up by one. You cannot cast the spell your lock is on. Charms never take your lock and do not count.',
	'If an effect has no legal target, that part of it is skipped. The cast still happens.',
];

// How static spells work.
const SIGIL_STATIC_RULES = [
	'A static spell is never cast. Its effect is on for as long as your stones fill its sigil, and off as soon as one of them leaves.',
	'Statics do not take your lock and do not add to your spell count.',
];

// Move words used throughout (as in the tutorial and the help glossary).
const SIGIL_MOVE_TERMS = [
	['Soft move', 'Place a stone on an empty node touching one of your stones.'],
	['Hard move', 'Place a stone on an enemy stone touching one of your stones. The enemy stone is pushed to the nearest empty node; it may pass through stones of its own colour but never through yours or through a void. If several empty nodes are equally near, the mover chooses. If none can be reached, the stone is crushed (destroyed).'],
	['Blink move', 'A move that need not touch your stones. A soft blink goes onto an empty node; a blink onto an enemy stone pushes it like a hard move.'],
	['Sacrifice', 'Remove one of your own stones from the board.'],
];

// Clarifications beyond the card text, per official spell.
const SIGIL_SPELL_NOTES = {
	Flourish: [
		'Each of the 4 moves is a soft move, made one at a time, so a later move may touch a stone placed by an earlier one.',
		'When no soft move is left, the remaining moves are lost.',
	],
	Grow: [
		'Each of the 2 moves is a soft move, made one at a time, so the second may touch the first.',
		'When no soft move is left, the remaining move is lost.',
	],
	Sprout: [
		'One soft move: an empty node touching one of your stones.',
	],
	Carnage: [
		'Each of the 4 moves is a hard move onto an enemy stone touching one of yours, made one at a time. Each pushes or crushes that stone.',
		'When no hard move is left, the remaining moves are lost.',
	],
	Slash: [
		'One hard move onto an enemy stone touching one of yours: the stone is pushed to the nearest empty node, or crushed if none can be reached.',
	],
	Fireblast: [
		'Every enemy stone touching at least one of your stones is destroyed at once, including stones touching the ones you kept on Fireblast\'s sigil.',
		'Then you sacrifice one of your stones (any one). If the blast destroyed the opponent\'s last stone, the game is over and there is no sacrifice.',
		'Stones protected by the opponent\'s Bulwark are not destroyed.',
	],
	Starfall: [
		'Place a stone on any empty node that touches another empty node, then a second stone on an empty node touching the first. Neither needs to touch your other stones.',
		'Then every enemy stone touching either new stone is destroyed. There is no sacrifice.',
		'Stones protected by the opponent\'s Bulwark are not destroyed.',
	],
	Meteor: [
		'The blink may land on any empty node or on an enemy stone, which is pushed (or crushed) as in a hard move. It cannot land on your own stone or a void.',
		'Then you destroy one enemy stone touching the stone you placed; you choose if there are several. If none touches it, nothing more happens.',
	],
	Comet: [
		'The blink may land on any empty node or on an enemy stone, which is pushed (or crushed) as in a hard move. It cannot land on your own stone or a void.',
		'Then you sacrifice one of your stones; it may be the one you just placed.',
	],
	Seal_of_Lightning: [
		'While you fill it, a dash costs you 1 sacrifice instead of 2.',
		'You still need more than 2 stones on the board to dash.',
	],
	Seal_of_Wind: [
		'While you fill it, your regular move each turn may go anywhere: onto any empty node, or onto any enemy stone (pushing it).',
		'Only the regular move blinks. Dash moves, Providence placements and the moves spells give you follow their own rules.',
		'If your opponent fills Seal of Stone, your regular move must be soft, but it may still go onto any empty node.',
	],
	Seal_of_Summer: [
		'While you fill it, you may cast a second spell after your first in the same turn.',
		'Locks still apply, and a dash must come before your first cast.',
	],
	Bewitch: [
		'Choose an enemy stone that touches another enemy stone and convert it, then convert an enemy stone touching the first.',
		'If no two enemy stones touch, the cast has no effect.',
		'Stones protected by the opponent\'s Bulwark cannot be converted.',
	],
	Hail_Storm: [
		'In every 3-node and 5-node spell on the board (whoever holds it) that has an enemy stone in it, you destroy one enemy stone of your choice. Charms are not hit.',
		'One stone per spell, and every such spell is hit.',
		'Stones protected by the opponent\'s Bulwark are not destroyed.',
	],
	Surge: [
		'You can cast Surge only in a turn in which you dashed.',
		'The move is a regular-kind move: soft or hard, touching one of your stones.',
	],
	Blossom: [
		'For each 3-node and 5-node spell other than Blossom, place one stone on an empty node of it. The stones need not touch yours.',
		'One stone per spell; you choose the order. A spell with no empty node is skipped. Charms are not included.',
	],
	Scatter: [
		'Place one stone on an empty node of one spell, then one on an empty node of a different spell. The stones need not touch yours.',
		'Any spell counts, including charms and Scatter\'s own sigil.',
	],
	Seal_of_Spring: [
		'While you fill it, you may cast the 3- or 5-node spell your lock is on one more time.',
		'That second cast counts toward your spell count. The spell is then used up until your lock moves to a different spell.',
	],
	Syzygy: [
		'The spells opposite Syzygy are the 1-node and 3-node spells straight across the board from it.',
		'First, if the opposite charm node is not yours, you blink onto it (pushing an enemy stone there). Then you blink up to 3 times onto nodes of the opposite 3-node spell that are not yours, pushing any enemy stones, stopping once all of it is yours.',
		'Voids and stones protected by Bulwark cannot be blinked onto.',
	],
	Eclipse: [
		'Choose a spell (of any size) in which exactly 2 nodes are not yours, and make 2 moves into it.',
		'The moves are ordinary soft or hard moves: each must touch one of your stones. Both go into the same spell, and if the second has no legal target it is lost.',
	],
	Azimuth: [
		'Choose a spell (of any size) in which exactly 1 node is not yours, and make 1 move into it.',
		'The move is an ordinary soft or hard move: it must touch one of your stones.',
	],
	Erupt: [
		'Every 3- or 5-node spell other than Erupt that holds at least one of your stones when Erupt resolves gets up to 2 moves.',
		'The moves are ordinary soft or hard moves touching your stones, made in any order you like across those spells. You keep moving while any legal move remains.',
		'Charms never qualify: a charm with your stone in it is already full.',
	],
	Fury: [
		'First sacrifice one of your stones, then make up to 3 hard moves, one at a time.',
		'When no hard move is left, the remaining moves are lost.',
	],
	Charge: [
		'One ordinary soft or hard move (touching one of your stones) onto a node of any 3- or 5-node spell.',
	],
	Hurricane: [
		'A group is a set of enemy stones connected through touching nodes; a lone stone is a group of 1. Every stone of the smallest group is destroyed.',
		'If several groups tie for smallest, you choose which one.',
		'Stones protected by the opponent\'s Bulwark are left out of the groups and survive.',
	],
	Storm_Front: [
		'Destroy any 2 enemy stones anywhere on the board, one at a time.',
		'Stones protected by the opponent\'s Bulwark cannot be chosen, but destroying the Bulwark stone first removes the protection for the second.',
	],
	Gust: [
		'Every enemy stone touching one of your stones is picked up, then you place each one on any empty node, one at a time (nodes just emptied included).',
		'You choose where they go. Stones protected by the opponent\'s Bulwark stay put.',
		'If every enemy stone is picked up, the opponent has no stones on the board and loses at once.',
	],
	Tsunami: [
		'Make 2 soft moves, then 2 hard moves, each one at a time.',
		'Moves with no legal target are lost.',
	],
	Torrent: [
		'Make 1 soft move, then 1 hard move.',
		'A move with no legal target is lost.',
	],
	Splash: [
		'You can cast Splash only in a turn in which you have not dashed.',
		'The move is an ordinary soft or hard move touching one of your stones.',
	],
	Harvest: [
		'Each of the 5 moves is an ordinary soft or hard move touching your stones, onto a node of Harvest itself or of your locked spell (the spell your lock was on before this cast).',
		'When no such move is left, Harvest ends early.',
	],
	Gather: [
		'Each of the 3 moves is an ordinary soft or hard move touching your stones, onto a node of Gather itself or of your locked spell (the spell your lock was on before this cast).',
		'When no such move is left, Gather ends early.',
	],
	Seal_of_Autumn: [
		'While you fill it, your opponent may not sacrifice stones that sit on any spell\'s sigil to pay for a dash. They may still dash with stones elsewhere.',
		'It affects only dash sacrifices, not the sacrifices spells ask for.',
	],
	Corrupt: [
		'The stones you may convert are the enemy stones touching your stones when Corrupt resolves. A stone touching only a stone you just converted is not eligible.',
		'Convert them one at a time, up to 3; you may stop early.',
		'Then sacrifice one of your stones, even if you converted none, unless the game is already over.',
		'Stones protected by the opponent\'s Bulwark cannot be converted.',
	],
	Decay: [
		'Every enemy stone touching 2 or more empty nodes is destroyed, all at once. Voids are not empty nodes.',
		'Stones protected by the opponent\'s Bulwark survive.',
	],
	Lurk: [
		'One ordinary soft or hard move (touching one of your stones) onto a node that is not part of a 3- or 5-node spell: a charm, a mana node or any other node outside a sigil.',
	],
	Seal_of_Destruction: [
		'At the end of each of your turns in which you fill it, every enemy stone touching one of your stones is destroyed. This happens before the win check, so a burn that puts you 3 ahead wins.',
		'If it is still filled at the start of your next turn, you lose.',
		'Stones protected by the opponent\'s Bulwark are not destroyed.',
	],
	Seal_of_Stone: [
		'While you fill it, your opponent\'s regular move each turn must be a soft move onto an empty node.',
		'An opponent holding Seal of Wind may still place it on any empty node. Their dash moves, Providence placements and spell moves are not affected.',
	],
	Seal_of_Winter: [
		'While you fill it, your opponent cannot cast any charm, Surge and Splash included.',
		'Their static charms (such as Seal of Summer) are never cast, so they still work.',
	],
	Fissure: [
		'Choose any node that is not already a void, empty or not. Every stone on the nodes touching it, of either colour, yours included, is destroyed.',
		'The chosen node\'s stone is destroyed too, and the node becomes a permanent void: no stone may be placed on it, pushed onto it or pushed through it.',
		'A spell with a void in its sigil can never be filled again, so it can never be cast and a static there stops working. A void mana node gives mana to nobody.',
		'Stones protected by Bulwark survive. If the chosen node holds one, it stays and no void forms.',
	],
	Rock_Slide: [
		'Every enemy stone touching one of your stones when Rock Slide resolves must be pushed one step, onto a touching node you choose: empty, occupied by either colour, or a void.',
		'All pushes happen at once. A stone pushed alone onto a stone that is not itself moving destroys that stone, yours or theirs, and takes its place.',
		'Two or more stones pushed into the same node are all destroyed, and a stone already standing there survives. Two stones pushed onto each other\'s nodes are both destroyed.',
		'A stone pushed into a void is destroyed. A line of pushes slides along, and a loop of 3 or more rotates.',
		'Stones protected by the opponent\'s Bulwark are not pushed, and a stone pushed onto one is destroyed.',
	],
	Bulwark: [
		'While you fill it, your stones on the sigil of the spell your lock is on are protected: the opponent cannot hard-move onto them, blink onto them, convert them or destroy them.',
		'Fissure and Rock Slide cannot destroy them either, even your own. Your own sacrifices are not affected.',
		'It does nothing while you have no lock. Storm Front, Corrupt and repeated hard moves check again after each stone, so removing the Bulwark stone first ends the protection.',
	],
	Endowment: [
		'Add 4 stones to your Providence bank. See the Providence rules: banked stones count toward your stone total and can be placed later, one per turn.',
	],
	Annuity: [
		'Add 2 stones to your Providence bank. See the Providence rules: banked stones count toward your stone total and can be placed later, one per turn.',
	],
	Dividend: [
		'Add 1 stone to your Providence bank. See the Providence rules: banked stones count toward your stone total and can be placed later, one per turn.',
	],
};

// One entry per variant (and per pack with rules of its own), anchored on
// variants.html as #<id>. `flag` names the variant test for the in-game
// summary; `pack` the spells whose presence brings the rules into play.
const SIGIL_VARIANT_RULES = [
	{
		id: 'standard', name: 'Standard rules', rated: true,
		summary: 'Red starts on a1 and Blue on b1. Win by a 3-stone lead, by casting the sixth spell while ahead, or by elimination.',
		rules: [
			'Red moves first. Blue\'s score stone counts as one extra Blue stone.',
			'A player 3 ahead on the score track at the end of a turn wins: Blue needs 2 more stones on the board than Red, Red needs 4 more than Blue.',
			'The game also ends at the end of the turn in which a player casts their sixth 3- or 5-node spell. The player with more stones wins; on a tie, the player who would move next wins.',
			'A player with no stones left on the board loses at once.',
			'If the same position (stones, side to move, locks and spell counts) comes up for the third time, Blue wins.',
		],
	},
	{
		id: 'competitive', name: 'Competitive', rated: true, flag: 'competitive',
		summary: 'Empty-board start: each player\'s first turn places one stone on any empty node.',
		rules: [
			'The board starts empty instead of with stones on a1 and b1.',
			'Each player\'s first turn is a single stone placed on any empty node, and nothing else: no dash and no spell.',
			'The no-stones-left loss does not apply until both opening stones are down. From then on every rule is standard.',
			'Competitive games are rated, and Competitive combines with every other variant.',
		],
	},
	{
		id: 'deathmatch', name: 'Deathmatch', rated: false, flag: 'deathmatch',
		summary: 'Win only by eliminating every enemy stone. Unrated.',
		rules: [
			'The only way to win is to leave your opponent with no stones on the board.',
			'The 3-stone lead does not win, and there are no spell counts, so the sixth spell does not end the game.',
			'Threefold repetition still ends the game as a Blue win, so every game finishes.',
			'Deathmatch cannot be combined with Scramble. Deathmatch games are unrated.',
		],
	},
	{
		id: 'scramble', name: 'Scramble', rated: false, flag: 'scramble',
		summary: 'No stone-lead win: the first player to cast their sixth spell wins. Unrated.',
		rules: [
			'The 3-stone lead does not win.',
			'The first player to cast their sixth 3- or 5-node spell wins at the end of that turn, whatever the stone count.',
			'Elimination and threefold repetition (a Blue win) still apply.',
			'Scramble cannot be combined with Deathmatch. Scramble games are unrated.',
		],
	},
	{
		id: 'duplicates', name: 'Allow duplicates', rated: false, flag: 'duplicates',
		summary: 'The spell draw may repeat a spell, up to three copies. Unrated.',
		rules: [
			'The nine spells are drawn as if with replacement: the same spell may appear up to three times. Play is otherwise standard.',
			'Each copy is a separate spell with its own sigil. Your lock sits on one copy, so you may cast another copy of the spell you just cast.',
			'Filling any copy of a static gives its effect; filling two copies does not double it.',
			'Games that allow duplicates are unrated.',
		],
	},
	{
		id: 'cataclysm', name: 'Cataclysm', rated: false, flag: 'pentagon',
		summary: 'The expanded board: five zones, 65 nodes, five spells of each size. Win by a 4-stone lead or when a player has cast 8 spells. Unrated.',
		rules: [
			'The board has five zones instead of three: 65 nodes, five mana nodes and 15 spells, five of each size.',
			'Red starts on a1 and Blue on b1, as on the standard board.',
			'A 4-stone lead wins (Blue\'s score stone still counts), and the game ends at the end of the turn in which a player casts their eighth 3- or 5-node spell.',
			'Spells that reach across the board scale with it: Hail Storm and Blossom cover all ten 3- and 5-node spells, and Syzygy\'s opposite spells are two zones away.',
			'Cataclysm combines with the other variants. Cataclysm games are unrated.',
		],
	},
	{
		id: 'tectonic', name: 'Tectonic pack rules', rated: true, pack: ['Fissure', 'Rock_Slide', 'Bulwark'],
		summary: 'Fissure leaves permanent voids; Rock Slide pushes stones all at once; Bulwark protects your locked spell.',
		rules: [
			'A void left by Fissure is permanent. No stone may be placed on it, pushed onto it or pushed through it, and a pushed stone cannot use it to escape a crush.',
			'A spell with a void in its sigil can never be filled again, so it cannot be cast and a static there stops working. A void mana node gives mana to nobody.',
			'Voids are written x in a position string (SFN).',
			'Rock Slide\'s pushes all happen at once and can destroy stones of either colour; Bulwark protects the stones on its owner\'s locked spell. See each spell\'s page.',
			'Tectonic is an official pack: its games are rated.',
		],
	},
	{
		id: 'providence', name: 'Providence pack rules', rated: true, pack: ['Dividend', 'Annuity', 'Endowment'],
		summary: 'Dividend, Annuity and Endowment bank 1, 2 and 4 stones. Banked stones count toward your total and can be placed one per turn.',
		rules: [
			'Dividend, Annuity and Endowment add 1, 2 and 4 stones to the caster\'s Providence bank.',
			'Banked stones count toward your stone total for the 3-stone lead and for who is ahead when the sixth spell is cast. They do not keep you alive: a player with no stones on the board still loses.',
			'At the start of a turn with a non-empty bank, you may place one banked stone after your regular move (or instead of it, if you have no legal move) and before dashing. It is an ordinary soft or hard move touching your stones; Seal of Wind and the enemy\'s Seal of Stone do not apply to it.',
			'Skipping the placement keeps the stone banked.',
			'Providence is an official pack: its games are rated.',
		],
	},
];

// The variant rules that apply to a game, for the in-game help popover: the
// standard win rules unless an end-condition variant or the Cataclysm board
// replaces them, then each variant flag, then the packs on the board that
// bring rules of their own.
function sigilGameRulesSections(variant, spellNames) {
	const v = typeof normalizeVariant === 'function' ? normalizeVariant(variant || 'standard') : (variant || 'standard');
	const has = flag => v.split('_').includes(flag);
	const bases = (spellNames || []).map(n => (typeof baseSpellName === 'function' ? baseSpellName(n) : n));
	const out = [];
	for (const r of SIGIL_VARIANT_RULES) {
		if (r.id === 'standard') {
			if (!has('deathmatch') && !has('scramble') && !has('pentagon')) out.push(r);
		} else if (r.flag) {
			if (has(r.flag)) out.push(r);
		} else if (r.pack && r.pack.some(n => bases.includes(n))) {
			out.push(r);
		}
	}
	return out;
}

// Spell page URL (spell.html?name=Hail_Storm) for any spell name or alias.
function sigilSpellPageUrl(name, prefix) {
	const base = typeof baseSpellName === 'function' ? baseSpellName(name) : name;
	return (prefix || '') + 'spell.html?name=' + encodeURIComponent(base);
}

// The game on this page, as the help popover reads it: the board scripts
// (game-board-local.js, game-board-multiplayer.js, analysis-board.js) call
// this once the variant and the spells are known.
function sigilPublishGameRules(variant, spellNames) {
	window.sigilGameRules = { variant: variant || 'standard', spellNames: (spellNames || []).slice() };
}
