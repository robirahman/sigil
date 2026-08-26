//! Exhaustive spell resolution: every DISTINCT board a legal resolution can reach,
//! each paired with the action sequence that produced it.
//!
//! Rationale. A search only cares which successor states exist, so enumerating
//! outcome BOARDS rather than choice tuples (a) composes across multi-step
//! resolvers, (b) lets us dedupe after each step so the frontier stays small
//! instead of exploding as targets^count, and (c) makes "did we hide an option?"
//! a question about states.
//!
//! Each outcome also carries a `JsAct` log, so the chosen resolution can be handed
//! to the browser and replayed by `applyAITurn`. Reconstructing actions from a
//! before/after delta is NOT safe here: `applyAITurn` recomputes push options for
//! `hard_move`, and it calls `update()` between actions, which can trip the
//! zero-stones immediate-loss rule on an intermediate state. Recording what the
//! resolver actually did avoids both hazards.
//!
//! Mid-resolution nothing outside `stones` changes, so `stones` alone identifies a
//! state and is a sound dedupe key.

use std::collections::HashSet;
use crate::actions::JsAct;
use crate::board::{Board, Color, Outcome};
use crate::spells_meta::*;
use crate::topology::{ADJ, BIG_SPELL_NODES, SIGIL};

/// Board + the actions that produced it.
type Step = (Board, Vec<JsAct>);

struct Frontier {
    seen: HashSet<(u64, u64)>,
    items: Vec<Step>,
    cap: usize,
    truncated: bool,
}

impl Frontier {
    fn new(cap: usize) -> Self {
        Frontier { seen: HashSet::new(), items: Vec::new(), cap, truncated: false }
    }
    fn push(&mut self, b: Board, log: Vec<JsAct>) {
        if self.items.len() >= self.cap { self.truncated = true; return; }
        if self.seen.insert((b.stones[0], b.stones[1])) { self.items.push((b, log)); }
    }
    fn take(&mut self) -> Vec<Step> { self.seen.clear(); std::mem::take(&mut self.items) }
    fn is_empty(&self) -> bool { self.items.is_empty() }
}

fn plus(base: &[JsAct], a: JsAct) -> Vec<JsAct> {
    let mut v = base.to_vec(); v.push(a); v
}

impl Board {
    /// One move step, every legal way, recording a `move` / `hard_move` action.
    fn branch_move(&self, log: &[JsAct], targets: u64, c: Color, f: &mut Frontier) {
        let mut m = targets;
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            let is_enemy = self.theirs(c) & (1u64 << node) != 0;
            if is_enemy {
                let (opts, k) = self.push_options(node, c);
                if k == 0 {
                    let mut b = *self;
                    let bit = 1u64 << node;
                    b.stones[c.other().idx()] &= !bit;
                    b.stones[c.idx()] |= bit;
                    b.update();
                    f.push(b, plus(log, JsAct::mv(node, None, true, false)));
                } else {
                    for &d in &opts[..k] {
                        let mut b = *self;
                        let bit = 1u64 << node;
                        b.stones[c.other().idx()] &= !bit;
                        b.stones[c.idx()] |= bit;
                        b.stones[c.other().idx()] |= 1u64 << d;
                        b.update();
                        f.push(b, plus(log, JsAct::mv(node, Some(d), true, false)));
                    }
                }
            } else {
                let mut b = *self;
                b.stones[c.idx()] |= 1u64 << node;
                b.update();
                f.push(b, plus(log, JsAct::mv(node, None, false, false)));
            }
        }
    }

    /// A soft BLINK (place on an empty node, no adjacency needed).
    fn branch_blink(&self, log: &[JsAct], targets: u64, c: Color, f: &mut Frontier) {
        let mut m = targets;
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            let mut b = *self;
            b.stones[c.idx()] |= 1u64 << node;
            b.update();
            f.push(b, plus(log, JsAct::mv(node, None, false, true)));
        }
    }

    /// Repeat `branch_move` `count` times over a per-board target selector.
    fn branch_move_n<F>(start: Vec<Step>, count: u8, c: Color, cap: usize, sel: F)
        -> (Vec<Step>, bool)
    where F: Fn(&Board) -> u64 + Copy
    {
        let mut cur = start;
        let mut trunc = false;
        for _ in 0..count {
            let mut f = Frontier::new(cap);
            let mut any = false;
            for (b, log) in &cur {
                let t = sel(b);
                if t == 0 { f.push(*b, log.clone()); }      // step unavailable: ends early
                else { any = true; b.branch_move(log, t, c, &mut f); }
            }
            trunc |= f.truncated;
            cur = f.take();
            if !any { break; }
        }
        (cur, trunc)
    }

    /// Every board reachable by legally resolving the spell in sigil `pos`, starting
    /// AFTER `cast_clear_and_refill`, each with its action log.
    pub fn resolve_outcomes_logged(&self, pos: usize, c: Color, cap: usize)
        -> (Vec<Step>, bool)
    {
        let id = self.spells[pos];
        if (id as usize) >= NUM_OFFICIAL_SPELLS { return (vec![(*self, vec![])], false); }
        let info = &SPELLS[id as usize];
        let start = vec![(*self, Vec::<JsAct>::new())];
        let enemy_of = |b: &Board| b.theirs(c);

        match info.resolve {
            Resolve::None_ => (start, false),

            Resolve::DestroyExposed => {
                let empty = self.empty();
                let mut doomed = 0u64;
                let mut m = enemy_of(self);
                while m != 0 {
                    let i = m.trailing_zeros() as usize; m &= m - 1;
                    if (ADJ[i] & empty).count_ones() >= 2 { doomed |= 1u64 << i; }
                }
                let mut b = *self;
                b.stones[c.other().idx()] &= !doomed;
                b.update();
                let log = if doomed == 0 { vec![] }
                          else { vec![JsAct::list("decay", mask_vec(doomed))] };
                (vec![(b, log)], false)
            }

            Resolve::Gust => {
                // Pickup is forced; where each lands is the caster's choice, and the
                // outcome depends only on the SET of landing nodes.
                let picked = enemy_of(self) & Board::dilate(self.mine(c));
                if picked == 0 { return (start, false); }
                let n = picked.count_ones() as usize;
                let mut b0 = *self;
                b0.stones[c.other().idx()] &= !picked;
                b0.update();
                let empties = mask_vec(b0.empty());
                let mut f = Frontier::new(cap);
                if n <= empties.len() {
                    let mut idx = vec![0usize; n];
                    fn rec(d: usize, s: usize, n: usize, e: &[u8], idx: &mut Vec<usize>,
                           b0: &Board, picked: u64, c: Color, f: &mut Frontier) {
                        if d == n {
                            let mut b = *b0;
                            let mut kept = Vec::with_capacity(n);
                            for &i in idx.iter() {
                                b.stones[c.other().idx()] |= 1u64 << e[i];
                                kept.push(e[i]);
                            }
                            b.update();
                            f.push(b, vec![JsAct::gust(mask_vec(picked), kept)]);
                            return;
                        }
                        for i in s..e.len() {
                            if f.truncated { return; }
                            idx[d] = i;
                            rec(d + 1, i + 1, n, e, idx, b0, picked, c, f);
                        }
                    }
                    rec(0, 0, n, &empties, &mut idx, &b0, picked, c, &mut f);
                } else {
                    f.push(b0, vec![JsAct::gust(mask_vec(picked), vec![])]);
                }
                let tr = f.truncated; (f.take(), tr)
            }

            // ---- move families ----
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
                let mut t = 0u64;
                for p in 0..9 { if self.uncontrolled_count(p, c) == 1 { t |= SIGIL[p]; } }
                Board::branch_move_n(start, 1, c, cap, move |b| b.all_moveable(c) & t)
            }
            Resolve::Eclipse => {
                let mut f = Frontier::new(cap);
                let mut trunc = false;
                for p in 0..9 {
                    if self.uncontrolled_count(p, c) != 2 { continue; }
                    let m = SIGIL[p];
                    let (res, t) = Board::branch_move_n(start.clone(), 2, c, cap,
                                                        move |b| b.all_moveable(c) & m);
                    trunc |= t;
                    for (b, l) in res { f.push(b, l); }
                }
                if f.is_empty() { return (start, trunc); }
                trunc |= f.truncated; (f.take(), trunc)
            }
            Resolve::Erupt => {
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if p == pos { continue; }
                    let m = SIGIL[p];
                    let mut next = Frontier::new(cap);
                    for (b, log) in &cur {
                        if m & b.mine(c) == 0 { next.push(*b, log.clone()); continue; }
                        let (res, t) = Board::branch_move_n(vec![(*b, log.clone())], 2, c, cap,
                                                            move |x| x.all_moveable(c) & m);
                        trunc |= t;
                        for (rb, rl) in res { next.push(rb, rl); }
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
                    self.branch_move(&[], 1u64 << charm_node, c, &mut f);
                } else { f.push(*self, vec![]); }
                let mid = f.take();
                let m = SIGIL[sorcery];
                Board::branch_move_n(mid, 3, c, cap, move |b| m & !b.mine(c))
            }
            Resolve::Scatter => {
                let mut f = Frontier::new(cap);
                for p1 in 0..9 {
                    let e1 = SIGIL[p1] & self.empty();
                    if e1 == 0 { continue; }
                    let mut g = Frontier::new(cap);
                    self.branch_blink(&[], e1, c, &mut g);
                    for (b1, l1) in g.take() {
                        let mut any2 = false;
                        for p2 in 0..9 {
                            if p2 == p1 { continue; }
                            let e2 = SIGIL[p2] & b1.empty();
                            if e2 == 0 { continue; }
                            b1.branch_blink(&l1, e2, c, &mut f);
                            any2 = true;
                        }
                        if !any2 { f.push(b1, l1); }
                    }
                }
                if f.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Blossom => {
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if p == pos { continue; }
                    let mut next = Frontier::new(cap);
                    for (b, log) in &cur {
                        let e = SIGIL[p] & b.empty();
                        if e == 0 { next.push(*b, log.clone()); continue; }
                        b.branch_blink(log, e, c, &mut next);
                    }
                    trunc |= next.truncated;
                    cur = next.take();
                }
                (cur, trunc)
            }

            Resolve::HailStorm => {
                let mut cur = start;
                let mut trunc = false;
                for p in 0..6 {
                    if SIGIL[p] & enemy_of(self) == 0 { continue; }
                    let mut next = Frontier::new(cap);
                    for (b, log) in &cur {
                        let victims = SIGIL[p] & b.theirs(c);
                        if victims == 0 { next.push(*b, log.clone()); continue; }
                        let mut m = victims;
                        while m != 0 {
                            let v = m.trailing_zeros() as u8; m &= m - 1;
                            let mut nb = *b;
                            nb.stones[c.other().idx()] &= !(1u64 << v);
                            nb.update();
                            next.push(nb, plus(log, JsAct::list("hail_storm", vec![v])));
                        }
                    }
                    trunc |= next.truncated;
                    cur = next.take();
                }
                (cur, trunc)
            }

            Resolve::Bewitch => {
                let mut f = Frontier::new(cap);
                for (a, b_) in self.bewitch_pairs(c) {
                    let bits = (1u64 << a) | (1u64 << b_);
                    let mut b = *self;
                    b.stones[c.other().idx()] &= !bits;
                    b.stones[c.idx()] |= bits;
                    b.update();
                    f.push(b, vec![JsAct::pair("bewitch", a, Some(b_), vec![])]);
                }
                if f.is_empty() { return (start, false); }
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
                    f.push(b, vec![JsAct::pair("starfall", a, Some(b_), mask_vec(kills))]);
                }
                if f.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Hurricane => {
                let groups = self.enemy_groups(c);
                if groups.is_empty() { return (start, false); }
                let min = groups.iter().map(|g| g.count_ones()).min().unwrap();
                let mut f = Frontier::new(cap);
                for g in groups.iter().filter(|g| g.count_ones() == min) {
                    let mut b = *self;
                    b.stones[c.other().idx()] &= !*g;
                    b.update();
                    f.push(b, vec![JsAct::list("hurricane", mask_vec(*g))]);
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::StormFront => {
                let mut f = Frontier::new(cap);
                let mut ea = enemy_of(self);
                if ea == 0 { return (start, false); }
                while ea != 0 {
                    let a = ea.trailing_zeros() as u8; ea &= ea - 1;
                    let mut b1 = *self;
                    b1.stones[c.other().idx()] &= !(1u64 << a);
                    b1.update();
                    if b1.outcome != Outcome::Ongoing {
                        f.push(b1, vec![JsAct::list("storm_front", vec![a])]); continue;
                    }
                    let mut eb = b1.theirs(c);
                    if eb == 0 { f.push(b1, vec![JsAct::list("storm_front", vec![a])]); continue; }
                    while eb != 0 {
                        let b_ = eb.trailing_zeros() as u8; eb &= eb - 1;
                        let mut b2 = b1;
                        b2.stones[c.other().idx()] &= !(1u64 << b_);
                        b2.update();
                        f.push(b2, vec![JsAct::list("storm_front", vec![a, b_])]);
                    }
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Corrupt => {
                let eligible = enemy_of(self) & Board::dilate(self.mine(c));
                let el = mask_vec(eligible);
                let k = el.len().min(3);
                let mut f = Frontier::new(cap);
                let mut acc: Vec<u8> = Vec::new();
                fn rec(el: &[u8], k: usize, s: usize, acc: &mut Vec<u8>,
                       base: &Board, c: Color, f: &mut Frontier) {
                    if acc.len() == k {
                        let mut b = *base;
                        let mut bits = 0u64;
                        for &n in acc.iter() { bits |= 1u64 << n; }
                        b.stones[c.other().idx()] &= !bits;
                        b.stones[c.idx()] |= bits;
                        b.update();
                        let log0 = vec![JsAct::list("corrupt", acc.clone())];
                        if b.outcome != Outcome::Ongoing { f.push(b, log0); return; }
                        let mut own = b.mine(c);
                        if own == 0 { f.push(b, log0); return; }
                        while own != 0 {
                            let s2 = own.trailing_zeros() as u8; own &= own - 1;
                            let mut b2 = b;
                            b2.stones[c.idx()] &= !(1u64 << s2);
                            b2.update();
                            f.push(b2, plus(&log0, JsAct::simple("sacrifice", s2)));
                        }
                        return;
                    }
                    for i in s..el.len() {
                        if f.truncated { return; }
                        acc.push(el[i]);
                        rec(el, k, i + 1, acc, base, c, f);
                        acc.pop();
                    }
                }
                rec(&el, k, 0, &mut acc, self, c, &mut f);
                if f.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Fireblast => {
                let doomed = enemy_of(self) & Board::dilate(self.mine(c));
                let mut b0 = *self;
                b0.stones[c.other().idx()] &= !doomed;
                b0.update();
                let log0 = if doomed == 0 { vec![] }
                           else { vec![JsAct::list("fireblast", mask_vec(doomed))] };
                if b0.outcome != Outcome::Ongoing { return (vec![(b0, log0)], false); }
                let mut own = b0.mine(c);
                if own == 0 { return (vec![(b0, log0)], false); }
                let mut f = Frontier::new(cap);
                while own != 0 {
                    let s = own.trailing_zeros() as u8; own &= own - 1;
                    let mut b = b0;
                    b.stones[c.idx()] &= !(1u64 << s);
                    b.update();
                    f.push(b, plus(&log0, JsAct::simple("sacrifice", s)));
                }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Fury => {
                let mut own = self.mine(c);
                if own == 0 { return (start, false); }
                let mut f = Frontier::new(cap);
                let mut trunc = false;
                while own != 0 {
                    let s = own.trailing_zeros() as u8; own &= own - 1;
                    let mut b = *self;
                    b.stones[c.idx()] &= !(1u64 << s);
                    b.update();
                    let log0 = vec![JsAct::simple("sacrifice", s)];
                    if b.outcome != Outcome::Ongoing { f.push(b, log0); continue; }
                    let (res, t) = Board::branch_move_n(vec![(b, log0)], 3, c, cap,
                                                        |x| x.hard_moveable(c));
                    trunc |= t;
                    for (rb, rl) in res { f.push(rb, rl); }
                }
                trunc |= f.truncated; (f.take(), trunc)
            }
            Resolve::Meteor => {
                let mut f = Frontier::new(cap);
                let mut t = self.blinkable(c);
                while t != 0 {
                    let node = t.trailing_zeros() as u8; t &= t - 1;
                    let mut lands = Frontier::new(cap);
                    self.branch_move(&[], 1u64 << node, c, &mut lands);
                    for (b, l) in lands.take() {
                        let adj = ADJ[node as usize] & b.theirs(c);
                        if adj == 0 { f.push(b, l); continue; }
                        let mut a = adj;
                        while a != 0 {
                            let v = a.trailing_zeros() as u8; a &= a - 1;
                            let mut b2 = b;
                            b2.stones[c.other().idx()] &= !(1u64 << v);
                            b2.update();
                            f.push(b2, plus(&l, JsAct::simple("meteor_destroy", v)));
                        }
                    }
                }
                if f.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
            Resolve::Comet => {
                let mut f = Frontier::new(cap);
                let mut t = self.blinkable(c);
                while t != 0 {
                    let node = t.trailing_zeros() as u8; t &= t - 1;
                    let mut lands = Frontier::new(cap);
                    self.branch_move(&[], 1u64 << node, c, &mut lands);
                    for (b, l) in lands.take() {
                        let mut own = b.mine(c) & !(1u64 << node);
                        if own == 0 { f.push(b, l); continue; }
                        while own != 0 {
                            let s = own.trailing_zeros() as u8; own &= own - 1;
                            let mut b2 = b;
                            b2.stones[c.idx()] &= !(1u64 << s);
                            b2.update();
                            f.push(b2, plus(&l, JsAct::simple("sacrifice", s)));
                        }
                    }
                }
                if f.is_empty() { return (start, false); }
                let tr = f.truncated; (f.take(), tr)
            }
        }
    }

    /// Boards only, for the search (which does not need the logs).
    pub fn resolve_outcomes(&self, pos: usize, c: Color, cap: usize) -> (Vec<Board>, bool) {
        let (v, t) = self.resolve_outcomes_logged(pos, c, cap);
        (v.into_iter().map(|(b, _)| b).collect(), t)
    }
}

fn mask_vec(mut m: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(m.count_ones() as usize);
    while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
    v
}
