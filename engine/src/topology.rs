// GENERATED from notation.py (NODE_ORDER / ADJACENCY / POSITIONS). Do not hand-edit.
// Asserted at generation: 39 nodes; adjacency symmetric, no duplicates, degrees 2-3;
// every ADJACENCY list index-ascending; sigils+MANA+VOID partition the board exactly.

pub const N: usize = 39;
pub const ALL: u64 = 0x7fffffffff;
pub const MANA: u64 = 0x4002001;   // a1, b1, c1
pub const VOID: u64 = 0x7003801c00;   // *11..*13, belong to no sigil

/// Union of all nine sigils: every node that "sits on a spell".
/// Seal of Autumn bars the enemy from sacrificing these to dash.
pub const SPELL_NODES: u64 = ALL & !MANA & !VOID;

/// Nodes on a 3-node (sorcery) or 5-node (ritual) sigil — positions 1..6.
/// Lurk may move onto any node EXCEPT these; singletons, mana and void stay legal.
pub const BIG_SPELL_NODES: u64 = SIGIL[0] | SIGIL[1] | SIGIL[2] | SIGIL[3] | SIGIL[4] | SIGIL[5];

/// Neighbour bitmask per node index 0..38.
pub const ADJ: [u64; N] = [
    0x00000000402, //  0 a1   deg 2
    0x00000000025, //  1 a2   deg 3
    0x0000000100a, //  2 a3   deg 3
    0x00000000054, //  3 a4   deg 3
    0x00000000828, //  4 a5   deg 3
    0x00000000412, //  5 a6   deg 3
    0x00001000088, //  6 a7   deg 3
    0x00000000340, //  7 a8   deg 3
    0x00000001280, //  8 a9   deg 3
    0x00000800180, //  9 a10  deg 3
    0x00800000021, // 10 a11  deg 3
    0x00100000010, // 11 a12  deg 2
    0x00000000104, // 12 a13  deg 2
    0x00000804000, // 13 b1   deg 2
    0x0000004a000, // 14 b2   deg 3
    0x00002014000, // 15 b3   deg 3
    0x000000a8000, // 16 b4   deg 3
    0x00001050000, // 17 b5   deg 3
    0x00000824000, // 18 b6   deg 3
    0x02000110000, // 19 b7   deg 3
    0x00000680000, // 20 b8   deg 3
    0x00002500000, // 21 b9   deg 3
    0x01000300000, // 22 b10  deg 3
    0x00000042200, // 23 b11  deg 3
    0x00000020040, // 24 b12  deg 2
    0x00000208000, // 25 b13  deg 2
    0x01008000000, // 26 c1   deg 2
    0x00094000000, // 27 c2   deg 3
    0x04028000000, // 28 c3   deg 3
    0x00150000000, // 29 c4   deg 3
    0x020a0000000, // 30 c5   deg 3
    0x01048000000, // 31 c6   deg 3
    0x00220000800, // 32 c7   deg 3
    0x00d00000000, // 33 c8   deg 3
    0x04a00000000, // 34 c9   deg 3
    0x00600000400, // 35 c10  deg 3
    0x00084400000, // 36 c11  deg 3
    0x00040080000, // 37 c12  deg 2
    0x00410000000, // 38 c13  deg 2
];

/// Node mask per sigil position 1..9. Sizes 5,5,5,3,3,3,1,1,1.
pub const SIGIL: [u64; 9] = [
    0x0000000003e, // pos 1: a2 a3 a4 a5 a6
    0x0000007c000, // pos 2: b2 b3 b4 b5 b6
    0x000f8000000, // pos 3: c2 c3 c4 c5 c6
    0x00000000380, // pos 4: a8 a9 a10
    0x00000700000, // pos 5: b8 b9 b10
    0x00e00000000, // pos 6: c8 c9 c10
    0x00000000040, // pos 7: a7
    0x00000080000, // pos 8: b7
    0x00100000000, // pos 9: c7
];

pub const NAMES: [&str; N] = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10", "b11", "b12", "b13", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13"];
