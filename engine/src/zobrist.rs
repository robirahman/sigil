//! Incremental Zobrist hashing, replacing `looping_snapshot()`'s `+=` string
//! concatenation (a 39-iteration Python loop run once per search node).
//!
//! REPETITION KEY — RESOLVED (Robi, 2026-08-26). `key_js` is CORRECT and is the
//! rule this engine implements. Side-to-move AND springlock state both count: a
//! repetition only counts when the board and the full game state are exactly the
//! same. If a position recurs with the springlock advanced, that does NOT count
//! toward threefold repetition, because the player whose springlock moved can no
//! longer keep repeating it.
//!
//! `key_py` reproduces `simboard.looping_snapshot()`, which omits side-to-move and
//! springlock and is therefore **a known bug in the Python simulator**. It is kept
//! only so we can reproduce legacy behaviour when auditing old data.
//!
//! !!! TODO(upstream): fix `simboard.looping_snapshot()` in the sigil repo to
//! !!! include side-to-move and both players' springlock, matching
//! !!! `sim-board.js loopingSnapshot()`. Robi has deferred this; it is NOT fixed
//! !!! yet. Until it is, any repetition-sensitive result produced by the Python
//! !!! stack (including self-play data) is suspect: threefold repetition is a blue
//! !!! win, so an over-broad key can end games that should have continued.

use crate::board::{Board, Color, NO_SPELL};
use crate::topology::N;

const NUM_SLOTS: usize = 52; // 51 spell ids + NO_SPELL

pub struct Zobrist {
    stone: [[u64; N]; 2],
    to_move: u64,
    lock: [[u64; NUM_SLOTS]; 2],
    springlock: [[u64; NUM_SLOTS]; 2],
    counter: [[u64; 8]; 2],
}

/// SplitMix64: deterministic, so tables are identical across builds and machines.
const fn splitmix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

impl Zobrist {
    pub const fn new() -> Self {
        let mut s = 0x5157_1131_0000_0001u64;
        let mut stone = [[0u64; N]; 2];
        let mut c = 0;
        while c < 2 { let mut i = 0; while i < N { s = splitmix(s); stone[c][i] = s; i += 1; } c += 1; }
        s = splitmix(s);
        let to_move = s;
        let mut lock = [[0u64; NUM_SLOTS]; 2];
        let mut c = 0;
        while c < 2 { let mut i = 0; while i < NUM_SLOTS { s = splitmix(s); lock[c][i] = s; i += 1; } c += 1; }
        let mut springlock = [[0u64; NUM_SLOTS]; 2];
        let mut c = 0;
        while c < 2 { let mut i = 0; while i < NUM_SLOTS { s = splitmix(s); springlock[c][i] = s; i += 1; } c += 1; }
        let mut counter = [[0u64; 8]; 2];
        let mut c = 0;
        while c < 2 { let mut i = 0; while i < 8 { s = splitmix(s); counter[c][i] = s; i += 1; } c += 1; }
        Zobrist { stone, to_move, lock, springlock, counter }
    }

    #[inline] fn slot(id: u8) -> usize { if id == NO_SPELL { 51 } else { id as usize } }

    #[inline]
    fn stones_hash(&self, b: &Board) -> u64 {
        let mut h = 0u64;
        for c in 0..2 {
            let mut m = b.stones[c];
            while m != 0 { h ^= self.stone[c][m.trailing_zeros() as usize]; m &= m - 1; }
        }
        h
    }

    /// JS `loopingSnapshot` equivalent (the live game's rule).
    pub fn key_js(&self, b: &Board) -> u64 {
        let mut h = self.stones_hash(b);
        if b.to_move == Color::Blue { h ^= self.to_move; }
        for c in 0..2 {
            h ^= self.lock[c][Self::slot(b.lock[c])];
            h ^= self.springlock[c][Self::slot(b.springlock[c])];
        }
        if !b.variant.has_deathmatch() {
            for c in 0..2 { h ^= self.counter[c][(b.spell_counter[c] as usize).min(7)]; }
        }
        h
    }

    /// Python `looping_snapshot` equivalent.
    pub fn key_py(&self, b: &Board) -> u64 {
        let mut h = self.stones_hash(b);
        for c in 0..2 {
            h ^= self.lock[c][Self::slot(b.lock[c])];
            h ^= self.counter[c][(b.spell_counter[c] as usize).min(7)];
        }
        h
    }

    #[inline]
    pub fn toggle_stone(&self, h: u64, c: Color, node: u8) -> u64 {
        h ^ self.stone[c.idx()][node as usize]
    }
}

pub static ZOBRIST: Zobrist = Zobrist::new();
