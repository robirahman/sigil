//! Core Sigil board: bitboard state, derived-state update, win conditions,
//! move-generation primitives and push resolution.
//!
//! SCOPE: the 39 official spells only. The deferred playtest packs are why there
//! is no `destroyed` mask, no pending-move/burn schedule and no snare map — so the
//! graph is STATIC and `topology::ADJ` is a true constant.
//!
//! Two parity facts, both established by differential testing against simboard.py:
//!  * A move PLACES a stone; it never relocates one. `_do_soft_move` and
//!    `_do_hard_move` only assign `stones[node] = color` and never clear an origin,
//!    so every move grows the mover's count by one and a crush is +1/-1.
//!  * Push/escape BFS must be a single global FIFO — see `push_options`.

use crate::topology::{ADJ, ALL, MANA, N, SIGIL};

pub const NO_SPELL: u8 = 255;
/// Spell ids at or above this belong to the deferred playtest packs.
pub const DEFERRED_SPELL_FLOOR: u8 = 39;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Color { Red = 0, Blue = 1 }

impl Color {
    #[inline] pub fn other(self) -> Color {
        match self { Color::Red => Color::Blue, Color::Blue => Color::Red }
    }
    #[inline] pub fn idx(self) -> usize { self as usize }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant { Standard, Competitive, Deathmatch, CompetitiveDeathmatch }

impl Variant {
    #[inline] pub fn has_competitive(self) -> bool {
        matches!(self, Variant::Competitive | Variant::CompetitiveDeathmatch)
    }
    #[inline] pub fn has_deathmatch(self) -> bool {
        matches!(self, Variant::Deathmatch | Variant::CompetitiveDeathmatch)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Push { To(u8), Crush }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome { Ongoing, RedWins, BlueWins }

/// A full position: `Copy`, ~48 bytes, no heap and no allocation on any path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Board {
    pub stones: [u64; 2],
    pub spells: [u8; 9],
    pub spell_counter: [u8; 2],
    pub lock: [u8; 2],
    pub springlock: [u8; 2],
    pub turn_counter: u32,
    pub to_move: Color,
    pub variant: Variant,
    pub outcome: Outcome,
    // derived by update()
    pub total: [u32; 2],
    pub mana: [u32; 2],
    pub charged: [u16; 2],
}

impl Board {
    pub fn new(spells: [u8; 9], variant: Variant) -> Self {
        Board {
            stones: [0, 0], spells, spell_counter: [0, 0],
            lock: [NO_SPELL, NO_SPELL], springlock: [NO_SPELL, NO_SPELL],
            turn_counter: 0, to_move: Color::Red, variant, outcome: Outcome::Ongoing,
            total: [0, 0], mana: [0, 0], charged: [0, 0],
        }
    }

    /// Standard: red a1 (index 0), blue b1 (index 13). Competitive starts empty.
    pub fn setup_initial(&mut self) {
        if !self.variant.has_competitive() {
            self.stones[0] = 1u64 << 0;
            self.stones[1] = 1u64 << 13;
        }
        self.update();
    }

    #[inline] pub fn occupied(&self) -> u64 { self.stones[0] | self.stones[1] }
    #[inline] pub fn empty(&self) -> u64 { ALL & !self.occupied() }
    #[inline] pub fn mine(&self, c: Color) -> u64 { self.stones[c.idx()] }
    #[inline] pub fn theirs(&self, c: Color) -> u64 { self.stones[c.other().idx()] }

    /// Union of the neighbours of every set bit. Replaces the per-node Python loop.
    #[inline]
    pub fn dilate(set: u64) -> u64 {
        let mut out = 0u64;
        let mut m = set;
        while m != 0 {
            out |= ADJ[m.trailing_zeros() as usize];
            m &= m - 1;
        }
        out
    }

    #[inline] pub fn soft_moveable(&self, c: Color) -> u64 {
        Self::dilate(self.mine(c)) & self.empty()
    }
    /// Bulwark is Tectonic (deferred), so there is no protection check.
    #[inline] pub fn hard_moveable(&self, c: Color) -> u64 {
        Self::dilate(self.mine(c)) & self.theirs(c)
    }
    #[inline] pub fn all_moveable(&self, c: Color) -> u64 {
        Self::dilate(self.mine(c)) & !self.mine(c) & ALL
    }

    /// Recompute totals, elimination, mana and charges. Mirrors `simboard.update()`
    /// with the deferred-pack branches removed.
    pub fn update(&mut self) {
        self.total[0] = self.stones[0].count_ones();
        self.total[1] = self.stones[1].count_ones();
        self.mana[0] = (self.stones[0] & MANA).count_ones();
        self.mana[1] = (self.stones[1] & MANA).count_ones();

        // In the competitive opening both sides legitimately hold nothing.
        let opening_pass = self.variant.has_competitive() && self.turn_counter <= 2;
        if self.outcome == Outcome::Ongoing && !opening_pass {
            let (r, b) = (self.total[0], self.total[1]);
            if r == 0 && b == 0 {
                self.outcome = if self.to_move == Color::Red { Outcome::BlueWins }
                               else { Outcome::RedWins };
            } else if r == 0 { self.outcome = Outcome::BlueWins; }
            else if b == 0 { self.outcome = Outcome::RedWins; }
        }

        // One AND + one compare per sigil, replacing the re-read of all nine
        // positions that update() previously did per board copy.
        self.charged = [0, 0];
        for p in 0..9 {
            let m = SIGIL[p];
            for c in 0..2 {
                if self.stones[c] & m == m { self.charged[c] |= 1 << p; }
            }
        }
    }

    /// `check_game_over`. Every phantom-stone term (Providence/Ambush/Aftershock)
    /// is zero in this scope, so it reduces to real stones plus blue's +1 token.
    /// ALWAYS STATE THE UNIT. The rule is the "+/-3 lead" and it is SYMMETRIC IN
    /// SCORE: each side wins on a score lead of 3, where blue's score is its real
    /// stones PLUS the token. Converting to real stones is what makes it look
    /// asymmetric -- red needs +4 real, blue +2 real -- and quoting only that half
    /// reads as an off-by-one to anyone thinking in score. Verified against the live
    /// `sim-board.js` (`rt > bt + 2` with `bt = blue + 1`) and empirically: red 5 vs
    /// blue 1 wins, red 5 vs blue 2 and red 4 vs blue 1 do not.
    pub fn check_game_over(&mut self, active: Color) -> bool {
        if self.outcome != Outcome::Ongoing { return true; }
        if self.variant.has_deathmatch() { return false; }
        let red = self.total[0];
        let blue = self.total[1] + 1;
        if red > blue + 2 { self.outcome = Outcome::RedWins; return true; }
        if blue > red + 2 { self.outcome = Outcome::BlueWins; return true; }
        if self.spell_counter[active.idx()] >= 6 {
            self.outcome = if red > blue { Outcome::RedWins }
                else if blue > red { Outcome::BlueWins }
                else if active == Color::Red { Outcome::BlueWins }  // tie: not-to-move
                else { Outcome::RedWins };
            return true;
        }
        false
    }

    /// Every legal destination for the stone pushed out of `node` by `c`, in
    /// `_push_enemy` order. Empty result means the push crushes. Non-mutating.
    ///
    /// PARITY: this MUST be a single global FIFO, not a level-synchronised bitmask
    /// sweep. Python enqueues each popped node's neighbours onto one deque, so the
    /// children of an earlier-popped parent precede lower-indexed children of a
    /// later parent: pushing into a5 with a4 and a6 both enemy-held gives
    /// options[0] == a3 (a child of a4), NOT a2. Since options[0] IS the greedy
    /// push destination, a bitmask version silently changes played moves — it
    /// failed differential testing on roughly 1 position in 30.
    pub fn push_options(&self, node: u8, c: Color) -> ([u8; 8], usize) {
        let mine = self.mine(c);
        let theirs = self.theirs(c);
        let mut opts = [0u8; 8];
        let mut n_opts = 0usize;
        let mut q: [(u8, u8); 128] = [(0, 0); 128];   // sum of degrees is ~100
        let (mut head, mut tail) = (0usize, 0usize);
        let mut visited = 1u64 << node;
        let mut m = ADJ[node as usize];
        while m != 0 {
            q[tail] = (m.trailing_zeros() as u8, 1); tail += 1; m &= m - 1;
        }
        let mut shortest: Option<u8> = None;
        while head < tail {
            let (nd, dist) = q[head];
            head += 1;
            let bit = 1u64 << nd;
            if visited & bit != 0 { continue; }
            visited |= bit;
            if let Some(sh) = shortest { if dist > sh { break; } }
            if mine & bit != 0 {
                continue;                       // pusher's stones block the chain
            } else if theirs & bit != 0 {
                let mut mm = ADJ[nd as usize];
                while mm != 0 {
                    let j = mm.trailing_zeros() as u8; mm &= mm - 1;
                    if visited & (1u64 << j) == 0 && tail < q.len() {
                        q[tail] = (j, dist + 1); tail += 1;
                    }
                }
            } else {
                if n_opts < opts.len() { opts[n_opts] = nd; }
                n_opts += 1;
                shortest = Some(dist);
            }
        }
        (opts, n_opts.min(opts.len()))
    }

    /// Greedy push, matching the engine's `options[0]`. Places `c` on `node` and
    /// relocates (or destroys) the displaced stone. The pusher does NOT vacate.
    pub fn push_enemy(&mut self, node: u8, c: Color) -> Push {
        let (opts, n) = self.push_options(node, c);
        let enemy = c.other().idx();
        let bit = 1u64 << node;
        self.stones[enemy] &= !bit;
        self.stones[c.idx()] |= bit;
        if n == 0 { Push::Crush } else {
            self.stones[enemy] |= 1u64 << opts[0];
            Push::To(opts[0])
        }
    }

    /// Distance from `node` through defender stones to the nearest empty cell;
    /// `max_dist` if unreachable. Same global-FIFO shape as `push_options`.
    pub fn escape_distance(&self, node: u8, defender: Color, max_dist: u32) -> u32 {
        let attacker = self.mine(defender.other());
        let def = self.mine(defender);
        let mut q: [(u8, u32); 128] = [(0, 0); 128];
        let (mut head, mut tail) = (0usize, 0usize);
        let mut visited = 1u64 << node;
        let mut m = ADJ[node as usize];
        while m != 0 {
            q[tail] = (m.trailing_zeros() as u8, 1); tail += 1; m &= m - 1;
        }
        while head < tail {
            let (nd, dist) = q[head];
            head += 1;
            let bit = 1u64 << nd;
            if visited & bit != 0 { continue; }
            visited |= bit;
            if dist > max_dist { break; }
            if attacker & bit != 0 {
                continue;
            } else if def & bit != 0 {
                let mut mm = ADJ[nd as usize];
                while mm != 0 {
                    let j = mm.trailing_zeros() as u8; mm &= mm - 1;
                    if visited & (1u64 << j) == 0 && tail < q.len() {
                        q[tail] = (j, dist + 1); tail += 1;
                    }
                }
            } else { return dist; }
        }
        max_dist
    }

    #[inline]
    pub fn is_crushable(&self, node: u8, attacker: Color) -> bool {
        if self.theirs(attacker) & (1u64 << node) == 0 { return false; }
        self.escape_distance(node, attacker.other(), N as u32) >= N as u32
    }

    /// True if any drawn sigil holds a deferred-pack spell — position out of scope.
    pub fn has_deferred_spell(&self) -> bool {
        self.spells.iter().any(|&s| s != NO_SPELL && s >= DEFERRED_SPELL_FLOOR)
    }
}
