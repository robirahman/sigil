//! Exhaustive spell resolution: every DISTINCT board a legal resolution can reach.
//!
//! Rationale. A search does not care which action script it used, only which
//! successor states exist. Enumerating outcome BOARDS rather than choice tuples
//! (a) composes cleanly across multi-step resolvers, (b) lets us dedupe after each
//! step so the frontier stays small instead of exploding as targets^count, and
//! (c) makes "did we hide an option?" a question about states, which is the thing
//! that actually loses games.
//!
//! Mid-resolution nothing outside `stones` changes (locks, counters and side to
//! move are touched only by `finish_cast`), so `stones` alone identifies a state
//! and is a sound dedupe key.
//!
//! Every resolver here branches over EVERY choice the live game offers, including
//! push destinations, which the greedy engine collapses to `options[0]`.

use std::collections::HashSet;
use crate::board::{Board, Color, Outcome};
use crate::spells_meta::*;
use crate::topology::{ADJ, BIG_SPELL_NODES, SIGIL};

/// A working set of distinct boards, deduped by stone masks.
struct Frontier {
    seen: HashSet<(u64, u64)>,
    boards: Vec<Board>,
    cap: usize,
    truncated: bool,
}

impl Frontier {
    fn new(cap: usize) -> Self {
        Frontier { seen: HashSet::new(), boards: Vec::new(), cap, truncated: false }
    }
    fn from_one(b: Board, cap: usize) -> Self {
        let mut f = Frontier::new(cap);
        f.push(b);
        f
    }
    fn push(&mut self, b: Board) {
        if self.boards.len() >= self.cap { self.truncated = true; return; }
        if self.seen.insert((b.stones[0], b.stones[1])) { self.boards.push(b); }
    }
    fn take(&mut self) -> Vec<Board> {
        self.seen.clear();
        std::mem::take(&mut self.boards)
    }
}

impl Board {
    /// Apply one move step to `self` in every legal way, pushing results into `f`.
    /// `targets` is the permitted landing set; push destinations are all enumerated.
    fn branch_move(&self, targets: u64, c: Color, f: &mut Frontier) {
        let mut m = targets;
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            if self.theirs(c) & (1u64 << node) != 0 {
                let (opts, k) = self.push_options(node, c);
                if k == 0 {
                    let mut b = *self;
                    let bit = 1u64 << node;
                    b.stones[c.other().idx()] &= !bit;
                    b.stones[c.idx()] |= bit;
                    b.update();
                    f.push(b);
                } else {
                    for &d in &opts[..k] {
                        let mut b = *self;
                        let bit = 1u64 << node;
                        b.stones[c.other().idx()] &= !bit;
                        b.stones[c.idx()] |= bit;
                        b.stones[c.other().idx()] |= 1u64 << d;
                        b.update();
                        f.push(b);
                    }
                }
            } else {
                let mut b = *self;
                b.stones[c.idx()] |= 1u64 << node;
                b.update();
                f.push(b);
            }
        }
    }

    /// Repeat `branch_move` `count` times over a per-board target selector.
    fn branch_move_n<F>(start: Vec<Board>, count: u8, c: Color, cap: usize, sel: F)
        -> (Vec<Board>, bool)
    where F: Fn(&Board) -> u64 + Copy
    {
        let mut cur = start;
        let mut trunc = false;
        for _ in 0..count {
            let mut f = Frontier::new(cap);
            let mut any = false;
            for b in &cur {
                let t = sel(b);
                if t == 0 {
                    f.push(*b);            // step unavailable: effect ends early here
                } else {
                    any = true;
                    b.branch_move(t, c, &mut f);
                }
            }
            trunc |= f.truncated;
            cur = f.take();
            if !any { break; }
        }
        (cur, trunc)
    }

    /// Every board reachable by legally resolving the spell in sigil `pos`,
    /// starting AFTER `cast_clear_and_refill`. Returns (boards, truncated).
    pub fn resolve_outcomes(&self, pos: usize, c: Color, cap: usize) -> (Vec<Board>, bool) {
        let id = self.spells[pos];
        if (id as usize) >= NUM_OFFICIAL_SPELLS { return (vec![*self], false); }
        let info = &SPELLS[id as usize];
        let start = vec![*self];

        match info.resolve {
            // ---- no internal choice at all ----
            Resolve::None_ => (start, false),
            Resolve::DestroyExposed => {
                let mut b = *self; b.resolve_destroy_exposed(c); (vec![b], false)
            }
            Resolve::Gust => {
                // Pickup is forced; placement order is a choice, but every stone
                // lands on some empty node and the enemy set is what matters.
                // Enumerate placements as unordered subsets of empties of the
                // right size, which is exactly the set of distinct outcomes.
                let picked = self.theirs(c) & Board::dilate(self.mine(c));
                if picked == 0 { return (start, false); }
                let n = picked.count_ones() as usize;
                let mut b0 = *self;
                b0.stones[c.other().idx()] &= !picked;
                b0.update();
                let empties: Vec<u8> = {
                    let mut v = Vec::new(); let mut m = b0.empty();
                    while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
                    v
                };
                let mut f = Frontier::new(cap);
                // choose n of the empties
                let mut idx = vec![0usize; n];
                fn rec(depth: usize, startpos: usize, n: usize, empties: &[u8], idx: &mut Vec<usize>,
                       b0: &Board, c: Color, f: &mut Frontier) {
                    if depth == n {
                        let mut b = *b0;
                        for &i in idx.iter() { b.stones[c.other().idx()] |= 1u64 << empties[i]; }
                        b.update();
                        f.push(b);
                        return;
                    }
                    for i in startpos..empties.len() {
                        if f.truncated { return; }
                        idx[depth] = i;
                        rec(depth + 1, i + 1, n, empties, idx, b0, c, f);
                    }
                }
                if n <= empties.len() {
                    rec(0, 0, n, &empties, &mut idx, &b0, c, &mut f);
                } else { f.push(b0); }
                let tr = f.truncated;
                (f.take(), tr)
            }

            // ---- move-family: branch every step over every target and push dest ----
            Resolve::SoftMoves =>
                Board::branch_move_n(start, info.count, c, cap, |b| b.soft_moveable(c)),
            Resolve::HardMoves =>
                Board::branch_move_n(start, info.count, c, cap, |b| b.hard_moveable(c)),
            Resolve::SoftHardChain => {
                let (mid, t1) = Board::branch_move_n(start, info.counts.0, c, cap,
                                                     |b| b.soft_moveable(c));
                let (end, t2) = Board::branch_move_n(mid, info.counts.1, c, cap,
                                                     |b| b.hard_moveable(c));
                (end, t1 || t2)
            }
            Resolve::SurgeMove =>
                Board::branch_move_n(start, 1, c, cap, |b| b.all_moveable(c)),
            Resolve::RestrictedMove =>
                Board::branch_move_n(start, 1, c, cap, |b| b.lurk_targets(c)),
            Resolve::Charge =>
                Board::branch_move_n(start, 1, c, cap, |b| b.all_moveable(c) & BIG_SPELL_NODES),
            Resolve::LockedOrSelfMoves => {
                let zone = self.autumn_allowed_zone(pos, c);
                Board::branch_move_n(start, info.count, c, cap,
                                     move |b| b.all_moveable(c) & zone)
            }
            Resolve::Azimuth => {
                // Any sigil at exactly one uncontrolled node is a legal target set,
                // not only the first such sigil in scan order.
                let mut t = 0u64;
                for p in 0..9 { if self.uncontrolled_count(p, c) == 1 { t |= SIGIL[p]; } }
                Board::branch_move_n(start, 1, c, cap, move |b| b.all_moveable(c) & t)
            }
            Resolve::Eclipse => {
                // Commit to a sigil at exactly two uncontrolled nodes, then two moves
                // inside it. Every qualifying sigil is a branch.
                let mut f = Frontier::new(cap);
                let mut trunc = false;
                for p in 0..9 {
                    if self.uncontrolled_count(p, c) != 2 { continue; }
                    let m = SIGIL[p];
                    let (res, t) = Board::branch_move_n(vec![*self], 2, c, cap,
                                                        move |b| b.all_moveable(c) & m);
                    trunc |= t;
                    for b in res { f.push(b); }
                }
                if f.boards.is_empty() { return (start, trunc); }
                trunc |= f.truncated;
                (f.take(), trunc)
            }
            Resolve::Erupt => {
                // Up to two moves into each qualifying sigil, in sigil order.
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if p == pos { continue; }
                    let m = SIGIL[p];
                    let mut next = Frontier::new(cap);
                    for b in &cur {
                        if m & b.mine(c) == 0 { next.push(*b); continue; }
                        let (res, t) = Board::branch_move_n(vec![*b], 2, c, cap,
                                                            move |x| x.all_moveable(c) & m);
                        trunc |= t;
                        for r in res { next.push(r); }
                    }
                    trunc |= next.truncated;
                    cur = next.take();
                }
                (cur, trunc)
            }
            Resolve::Syzygy => {
                let Some((charm, sorcery)) = crate::resolvers::syzygy_opposite(pos)
                    else { return (start, false) };
                let charm_node = SIGIL[charm].trailing_zeros() as u8;
                let mut f = Frontier::new(cap);
                if self.mine(c) & (1u64 << charm_node) == 0 {
                    self.branch_move(1u64 << charm_node, c, &mut f);
                } else { f.push(*self); }
                let mid = f.take();
                let m = SIGIL[sorcery];
                let (end, t) = Board::branch_move_n(mid, 3, c, cap,
                                                    move |b| m & !b.mine(c));
                (end, t)
            }
            Resolve::Scatter => {
                // One blink into each of two DIFFERENT sigils: branch over which
                // sigils and which node inside each.
                let mut f = Frontier::new(cap);
                for p1 in 0..9 {
                    let e1 = SIGIL[p1] & self.empty();
                    if e1 == 0 { continue; }
                    let mut m1 = e1;
                    while m1 != 0 {
                        let n1 = m1.trailing_zeros() as u8; m1 &= m1 - 1;
                        let mut b1 = *self;
                        b1.stones[c.idx()] |= 1u64 << n1;
                        b1.update();
                        let mut any2 = false;
                        for p2 in 0..9 {
                            if p2 == p1 { continue; }
                            let mut m2 = SIGIL[p2] & b1.empty();
                            while m2 != 0 {
                                let n2 = m2.trailing_zeros() as u8; m2 &= m2 - 1;
                                let mut b2 = b1;
                                b2.stones[c.idx()] |= 1u64 << n2;
                                b2.update();
                                f.push(b2);
                                any2 = true;
                            }
                        }
                        if !any2 { f.push(b1); }   // only one sigil available
                    }
                }
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated;
                (f.take(), tr)
            }
            Resolve::Blossom => {
                // One blink into each OTHER 3-/5-node sigil; WHICH node in each is a
                // choice. A full sigil is skipped, never a stop.
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if p == pos { continue; }
                    let mut next = Frontier::new(cap);
                    for b in &cur {
                        let e = SIGIL[p] & b.empty();
                        if e == 0 { next.push(*b); continue; }
                        let mut m = e;
                        while m != 0 {
                            let nd = m.trailing_zeros() as u8; m &= m - 1;
                            let mut nb = *b;
                            nb.stones[c.idx()] |= 1u64 << nd;
                            nb.update();
                            next.push(nb);
                        }
                    }
                    trunc |= next.truncated;
                    cur = next.take();
                }
                (cur, trunc)
            }

            Resolve::HailStorm => {
                // The live game PROMPTS for which enemy stone to destroy in each
                // qualifying 3-/5-node sigil (spells.js:190), so the victim is a
                // real choice per sigil - the greedy engine collapses it to node
                // order. The qualifying list is frozen up front, and sigils are
                // disjoint, so the choices are independent: one branching stage each.
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if SIGIL[p] & self.theirs(c) == 0 { continue; }  // frozen: not hailable
                    let mut next = Frontier::new(cap);
                    for b in &cur {
                        let victims = SIGIL[p] & b.theirs(c);
                        if victims == 0 { next.push(*b); continue; }
                        let mut m = victims;
                        while m != 0 {
                            let v = m.trailing_zeros(); m &= m - 1;
                            let mut nb = *b;
                            nb.stones[c.other().idx()] &= !(1u64 << v);
                            nb.update();
                            next.push(nb);
                        }
                    }
                    trunc |= next.truncated;
                    cur = next.take();
                }
                (cur, trunc)
            }

            // ---- pair / set selection ----
            Resolve::Bewitch => {
                let mut f = Frontier::new(cap);
                for (a, b_) in self.bewitch_pairs(c) {
                    let bits = (1u64 << a) | (1u64 << b_);
                    let mut b = *self;
                    b.stones[c.other().idx()] &= !bits;
                    b.stones[c.idx()] |= bits;
                    b.update();
                    f.push(b);
                }
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Starfall => {
                let mut f = Frontier::new(cap);
                for (a, b_) in self.starfall_pairs(c) {
                    let mut b = *self;
                    b.stones[c.idx()] |= (1u64 << a) | (1u64 << b_);
                    let kills = (ADJ[a as usize] | ADJ[b_ as usize]) & b.theirs(c);
                    b.stones[c.other().idx()] &= !kills;
                    b.update();
                    f.push(b);
                }
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Hurricane => {
                // Ties between equally smallest groups are the caster's choice.
                let groups = self.enemy_groups(c);
                if groups.is_empty() { return (start, false); }
                let min = groups.iter().map(|g| g.count_ones()).min().unwrap();
                let mut f = Frontier::new(cap);
                for g in groups.iter().filter(|g| g.count_ones() == min) {
                    let mut b = *self;
                    b.stones[c.other().idx()] &= !*g;
                    b.update();
                    f.push(b);
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::StormFront => {
                // Any two enemy stones, in any combination.
                let mut f = Frontier::new(cap);
                let mut ea = self.theirs(c);
                if ea == 0 { return (start, false); }
                while ea != 0 {
                    let a = ea.trailing_zeros() as u8; ea &= ea - 1;
                    let mut b1 = *self;
                    b1.stones[c.other().idx()] &= !(1u64 << a);
                    b1.update();
                    if b1.outcome != Outcome::Ongoing { f.push(b1); continue; }
                    let mut eb = b1.theirs(c);
                    if eb == 0 { f.push(b1); continue; }
                    while eb != 0 {
                        let b_ = eb.trailing_zeros() as u8; eb &= eb - 1;
                        let mut b2 = b1;
                        b2.stones[c.other().idx()] &= !(1u64 << b_);
                        b2.update();
                        f.push(b2);
                    }
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Corrupt => {
                // Any up-to-three of the eligible (frozen pre-conversion) set, then
                // any own stone sacrificed.
                let eligible = self.theirs(c) & Board::dilate(self.mine(c));
                let el: Vec<u8> = { let mut v = Vec::new(); let mut m = eligible;
                                    while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; } v };
                let mut f = Frontier::new(cap);
                let k = el.len().min(3);
                // all subsets of size exactly k (fewer only if fewer eligible)
                fn subsets(el: &[u8], k: usize, start: usize, acc: &mut Vec<u8>,
                           base: &Board, c: Color, f: &mut Frontier) {
                    if acc.len() == k {
                        let mut b = *base;
                        let mut bits = 0u64;
                        for &n in acc.iter() { bits |= 1u64 << n; }
                        b.stones[c.other().idx()] &= !bits;
                        b.stones[c.idx()] |= bits;
                        b.update();
                        if b.outcome != Outcome::Ongoing { f.push(b); return; }
                        let mut own = b.mine(c);
                        if own == 0 { f.push(b); return; }
                        while own != 0 {
                            let s = own.trailing_zeros(); own &= own - 1;
                            let mut b2 = b;
                            b2.stones[c.idx()] &= !(1u64 << s);
                            b2.update();
                            f.push(b2);
                        }
                        return;
                    }
                    for i in start..el.len() {
                        if f.truncated { return; }
                        acc.push(el[i]);
                        subsets(el, k, i + 1, acc, base, c, f);
                        acc.pop();
                    }
                }
                let mut acc = Vec::new();
                subsets(&el, k, 0, &mut acc, self, c, &mut f);
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Fireblast => {
                // Destruction is forced; the sacrifice is a free choice.
                let mine = self.mine(c);
                let doomed = self.theirs(c) & Board::dilate(mine);
                let mut b0 = *self;
                b0.stones[c.other().idx()] &= !doomed;
                b0.update();
                if b0.outcome != Outcome::Ongoing { return (vec![b0], false); }
                let mut f = Frontier::new(cap);
                let mut own = b0.mine(c);
                if own == 0 { return (vec![b0], false); }
                while own != 0 {
                    let s = own.trailing_zeros(); own &= own - 1;
                    let mut b = b0;
                    b.stones[c.idx()] &= !(1u64 << s);
                    b.update();
                    f.push(b);
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Fury => {
                // Any sacrifice, then three hard moves branching fully.
                let mut f = Frontier::new(cap);
                let mut own = self.mine(c);
                if own == 0 { return (start, false); }
                let mut trunc = false;
                while own != 0 {
                    let s = own.trailing_zeros(); own &= own - 1;
                    let mut b = *self;
                    b.stones[c.idx()] &= !(1u64 << s);
                    b.update();
                    if b.outcome != Outcome::Ongoing { f.push(b); continue; }
                    let (res, t) = Board::branch_move_n(vec![b], 3, c, cap,
                                                        |x| x.hard_moveable(c));
                    trunc |= t;
                    for r in res { f.push(r); }
                }
                trunc |= f.truncated;
                (f.take(), trunc)
            }
            Resolve::Meteor => {
                // Blink anywhere not yours (push destinations enumerated), then
                // destroy ANY one adjacent enemy - the greedy engine forces a mana
                // preference, which hides the other victims.
                let mut f = Frontier::new(cap);
                let mut t = self.blinkable(c);
                while t != 0 {
                    let node = t.trailing_zeros() as u8; t &= t - 1;
                    let mut lands = Frontier::new(cap);
                    self.branch_move(1u64 << node, c, &mut lands);
                    for b in lands.take() {
                        let adj = ADJ[node as usize] & b.theirs(c);
                        if adj == 0 { f.push(b); continue; }
                        let mut a = adj;
                        while a != 0 {
                            let v = a.trailing_zeros(); a &= a - 1;
                            let mut b2 = b;
                            b2.stones[c.other().idx()] &= !(1u64 << v);
                            b2.update();
                            f.push(b2);
                        }
                    }
                }
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Comet => {
                // Blink anywhere not yours, then sacrifice any own stone EXCEPT the
                // one just placed.
                let mut f = Frontier::new(cap);
                let mut t = self.blinkable(c);
                while t != 0 {
                    let node = t.trailing_zeros() as u8; t &= t - 1;
                    let mut lands = Frontier::new(cap);
                    self.branch_move(1u64 << node, c, &mut lands);
                    for b in lands.take() {
                        let mut own = b.mine(c) & !(1u64 << node);
                        if own == 0 { f.push(b); continue; }
                        while own != 0 {
                            let s = own.trailing_zeros(); own &= own - 1;
                            let mut b2 = b;
                            b2.stones[c.idx()] &= !(1u64 << s);
                            b2.update();
                            f.push(b2);
                        }
                    }
                }
                if f.boards.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
        }
    }

}
