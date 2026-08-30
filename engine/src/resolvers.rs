//! Spell effect resolvers. Reference: the live JS engine's `spells.js`.
//!
//! Each resolver comes in two forms:
//!   * `resolve_*`   — greedy, taking the lowest-indexed legal target at each
//!                     choice point, matching the engine's own AI convention.
//!   * `*_options`   — every legal choice at one step, for the Phase 1 enumerator.
//!
//! The greedy form is what a search plays; the options form is what stops the
//! search from being blind to its own legal moves.

use crate::board::{Board, Color};
use crate::spells_meta::*;
use crate::topology::{ADJ, BIG_SPELL_NODES};

impl Board {
    /// Place one stone on `node` (a soft move / blink landing).
    #[inline]
    fn place(&mut self, node: u8, c: Color) {
        self.stones[c.idx()] |= 1u64 << node;
    }

    /// Take one step of a move-like effect: push if the target holds an enemy,
    /// otherwise place. Shared by every resolver that "makes a move".
    fn step_move(&mut self, node: u8, c: Color) {
        if self.theirs(c) & (1u64 << node) != 0 { let _ = self.push_enemy(node, c); }
        else { self.place(node, c); }
        self.update();
    }

    /// `soft_moves` — Flourish 4, Grow 2, Sprout 1. Ends early when no soft
    /// target exists.
    ///
    /// GREEDY CONVENTION: simboard.py prefers a target OUTSIDE the casting sigil
    /// and only falls back to the lowest-indexed target when every option is
    /// inside it — an AI heuristic that avoids immediately refilling the sigil it
    /// just cleared. `avoid` is that sigil's mask. The JS resolver has no such
    /// rule because it is interactive (the player chooses), so simboard.py is the
    /// reference for greedy play here. `hard_moves` and `surge_move` have NO
    /// preference — they take targets[0] flat.
    pub fn resolve_soft_moves_avoiding(&mut self, c: Color, count: u8, avoid: u64) -> u8 {
        let mut done = 0;
        for _ in 0..count {
            // NOTE: deliberately NO gameover guard here. Neither simboard.py's
            // soft_moves nor spells.js's checks `gameover` mid-effect - only
            // `locked_or_self_moves` does. Adding one diverges: a cast that
            // eliminates the opponent still completes its remaining moves.
            let t = self.soft_moveable(c);
            if t == 0 { break; }
            let outside = t & !avoid;
            let pick = if outside != 0 { outside } else { t };
            self.place(pick.trailing_zeros() as u8, c);
            self.update();
            done += 1;
        }
        done
    }

    #[inline]
    pub fn resolve_soft_moves(&mut self, c: Color, count: u8) -> u8 {
        self.resolve_soft_moves_avoiding(c, count, 0)
    }

    /// `hard_moves` — Carnage 4, Slash 1.
    pub fn resolve_hard_moves(&mut self, c: Color, count: u8) -> u8 {
        let mut done = 0;
        for _ in 0..count {
            // No gameover guard - see resolve_soft_moves_avoiding.
            let t = self.hard_moveable(c);
            if t == 0 { break; }
            let _ = self.push_enemy(t.trailing_zeros() as u8, c);
            self.update();
            done += 1;
        }
        done
    }

    /// `soft_hard_chain` — Tsunami (2,2), Torrent (1,1).
    /// All soft moves first, then all hard moves; each phase breaks independently,
    /// so an exhausted soft phase does NOT skip the hard phase.
    pub fn resolve_soft_hard_chain_avoiding(&mut self, c: Color, counts: (u8, u8), avoid: u64)
        -> (u8, u8)
    {
        let s = self.resolve_soft_moves_avoiding(c, counts.0, avoid);
        let h = self.resolve_hard_moves(c, counts.1);
        (s, h)
    }

    #[inline]
    pub fn resolve_soft_hard_chain(&mut self, c: Color, counts: (u8, u8)) -> (u8, u8) {
        self.resolve_soft_hard_chain_avoiding(c, counts, 0)
    }

    /// `surge_move` — Surge, Splash. Exactly one ordinary move (soft or hard).
    pub fn resolve_surge_move(&mut self, c: Color) -> bool {
        let t = self.all_moveable(c);
        if t == 0 { return false; }
        self.step_move(t.trailing_zeros() as u8, c);
        true
    }

    /// `restricted_move` — Lurk. One ordinary move onto any node that is NOT part
    /// of a 3- or 5-node sigil; singletons, mana and void nodes stay legal.
    #[inline]
    pub fn lurk_targets(&self, c: Color) -> u64 {
        self.all_moveable(c) & !BIG_SPELL_NODES
    }

    pub fn resolve_restricted_move(&mut self, c: Color) -> bool {
        let t = self.lurk_targets(c);
        if t == 0 { return false; }
        self.step_move(t.trailing_zeros() as u8, c);
        true
    }

    /// `destroy_exposed` — Decay. Destroy every ENEMY stone touching 2 or more
    /// EMPTY nodes. Deterministic: no choice point, so no options variant.
    ///
    /// Note the emptiness test reads the board as it stands when the resolver
    /// runs, i.e. AFTER the caster's own sigil has been cleared and refilled, and
    /// all doomed stones are chosen before any is removed (the JS builds `doomed`
    /// fully, then deletes), so removals cannot cascade within one cast.
    pub fn resolve_destroy_exposed(&mut self, c: Color) -> u32 {
        let enemy = self.theirs(c);
        let empty = self.empty();
        let mut doomed = 0u64;
        let mut m = enemy;
        while m != 0 {
            let i = m.trailing_zeros() as usize;
            m &= m - 1;
            if (ADJ[i] & empty).count_ones() >= 2 { doomed |= 1u64 << i; }
        }
        self.stones[c.other().idx()] &= !doomed;
        self.update();
        doomed.count_ones()
    }

    // ---- enumerator surfaces: every legal choice at one step ----

    /// Targets for one step of the named resolver kind, as a bitmask.
    pub fn step_targets(&self, kind: Resolve, c: Color) -> u64 {
        match kind {
            Resolve::SoftMoves => self.soft_moveable(c),
            Resolve::HardMoves => self.hard_moveable(c),
            Resolve::SurgeMove => self.all_moveable(c),
            Resolve::RestrictedMove => self.lurk_targets(c),
            _ => 0,
        }
    }

    /// Every (target, push-destination) pair for one step. `None` destination means
    /// either a soft landing or a crush. The live game asks the player to choose the
    /// push destination (`doPushEnemy`), so destinations are real choice points.
    pub fn step_options(&self, kind: Resolve, c: Color) -> Vec<(u8, Option<u8>)> {
        let mut out = Vec::new();
        let mut m = self.step_targets(kind, c);
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            if self.theirs(c) & (1u64 << node) != 0 {
                let (opts, k) = self.push_options(node, c);
                if k == 0 { out.push((node, None)); }
                else { for &d in &opts[..k] { out.push((node, Some(d))); } }
            } else {
                out.push((node, None));
            }
        }
        out
    }

    /// Dispatch the greedy resolver for the spell sitting at sigil `pos`.
    ///
    /// Takes the POSITION, not the spell id: `position_of(id)` returns the first
    /// match, so an id appearing in two sigils would resolve against the wrong
    /// one. Real draws are distinct, but the caller always knows the position and
    /// several resolvers (soft-move avoidance, Autumn's zone) depend on it being
    /// the right one. Returns false for ids whose resolver is not yet ported, so
    /// callers refuse rather than silently mis-resolve.
    pub fn resolve_spell_at(&mut self, pos: usize, c: Color) -> bool {
        let id = self.spells[pos];
        if (id as usize) >= NUM_OFFICIAL_SPELLS { return false; }  // deferred pack
        let info = &SPELLS[id as usize];
        let own = crate::topology::SIGIL[pos];
        match info.resolve {
            Resolve::None_ => true,                       // statics: nothing to do
            Resolve::SoftMoves => {
                self.resolve_soft_moves_avoiding(c, info.count, own); true
            }
            Resolve::HardMoves => { self.resolve_hard_moves(c, info.count); true }
            Resolve::SoftHardChain => {
                self.resolve_soft_hard_chain_avoiding(c, info.counts, own); true
            }
            Resolve::SurgeMove => { self.resolve_surge_move(c); true }
            Resolve::RestrictedMove => { self.resolve_restricted_move(c); true }
            Resolve::DestroyExposed => { self.resolve_destroy_exposed(c); true }
            Resolve::Fireblast => { self.resolve_fireblast(c); true }
            Resolve::HailStorm => { self.resolve_hail_storm(c); true }
            Resolve::Bewitch => { self.resolve_bewitch(c); true }
            Resolve::Starfall => { self.resolve_starfall(c); true }
            Resolve::Meteor => { self.resolve_meteor(c); true }
            Resolve::Comet => { self.resolve_comet(c); true }
            Resolve::Azimuth => { self.resolve_azimuth(c); true }
            Resolve::Eclipse => { self.resolve_eclipse(c); true }
            Resolve::Scatter => { self.resolve_scatter(c); true }
            Resolve::Blossom => { self.resolve_blossom(pos, c); true }
            Resolve::Syzygy => { self.resolve_syzygy(pos, c); true }
            Resolve::Charge => { self.resolve_charge(c); true }
            Resolve::Fury => { self.resolve_fury(c); true }
            Resolve::Erupt => { self.resolve_erupt(pos, c); true }
            Resolve::Gust => { self.resolve_gust(c); true }
            Resolve::StormFront => { self.resolve_storm_front(c); true }
            Resolve::Hurricane => { self.resolve_hurricane(c); true }
            Resolve::Corrupt => { self.resolve_corrupt(c); true }
            Resolve::LockedOrSelfMoves => {
                self.resolve_autumn_moves(pos, c, info.count); true
            }
            _ => false,                                   // not yet ported
        }
    }

    /// Convenience for callers that only have an id. Uses the first sigil holding
    /// it; prefer `resolve_spell_at` wherever the position is known.
    pub fn resolve_spell(&mut self, id: u8, c: Color) -> bool {
        match self.position_of(id) {
            Some(pos) => self.resolve_spell_at(pos, c),
            None => false,
        }
    }

    /// Is `id`'s resolver implemented? Lets the turn generator and the corpus
    /// replay gate skip positions we cannot yet reproduce exactly.
    pub fn resolver_ready(&self, id: u8) -> bool {
        if (id as usize) >= NUM_OFFICIAL_SPELLS { return false; }
        matches!(SPELLS[id as usize].resolve,
            Resolve::None_ | Resolve::SoftMoves | Resolve::HardMoves
            | Resolve::SoftHardChain | Resolve::SurgeMove | Resolve::RestrictedMove
            | Resolve::DestroyExposed | Resolve::LockedOrSelfMoves
            | Resolve::Fireblast | Resolve::HailStorm | Resolve::Bewitch
            | Resolve::Starfall | Resolve::Meteor | Resolve::Comet
            | Resolve::Azimuth | Resolve::Eclipse | Resolve::Scatter
            | Resolve::Blossom | Resolve::Syzygy | Resolve::Charge
            | Resolve::Fury | Resolve::Erupt | Resolve::Gust
            | Resolve::StormFront | Resolve::Hurricane | Resolve::Corrupt)
    }
}

// ============================ destruction / blink batch ============================
// Reference: simboard.py `_resolve_spell` for greedy choice, spells.js for the rule.
// MANA node indices, in notation.py's MANA_NODES order: a1=0, b1=13, c1=26.
const MANA_ORDER: [u8; 3] = [0, 13, 26];

impl Board {
    /// Nodes `c` may blink onto: anything not already `c`'s. Includes enemy-held
    /// nodes (a blink onto one pushes). Bulwark is Tectonic, so no protection test.
    #[inline]
    pub fn blinkable(&self, c: Color) -> u64 {
        crate::topology::ALL & !self.mine(c)
    }

    /// Highest-index own stone, matching simboard's `for name in reversed(NODE_ORDER)`
    /// sacrifice heuristic. `except_node` supports Comet, which must not sacrifice
    /// the stone it just blinked onto.
    fn sacrifice_pick(&self, c: Color, except_node: Option<u8>) -> Option<u8> {
        let mut m = self.mine(c);
        if let Some(x) = except_node { m &= !(1u64 << x); }
        if m == 0 { None } else { Some(63 - m.leading_zeros() as u8) }
    }

    /// `fireblast` — destroy every enemy stone adjacent to one of yours, then pay a
    /// one-stone sacrifice. If the destruction ends the game, the sacrifice is
    /// SKIPPED (both engines return early on gameover).
    pub fn resolve_fireblast(&mut self, c: Color) -> (u32, Option<u8>) {
        let mine = self.mine(c);
        let doomed = self.theirs(c) & Self::dilate(mine);
        self.stones[c.other().idx()] &= !doomed;
        self.update();
        if self.outcome != crate::board::Outcome::Ongoing {
            return (doomed.count_ones(), None);
        }
        let sac = self.sacrifice_pick(c, None);
        if let Some(s) = sac {
            self.stones[c.idx()] &= !(1u64 << s);
            self.update();
        }
        (doomed.count_ones(), sac)
    }

    /// `hail_storm` — in each of the six 3- and 5-node sigils (positions 1..6),
    /// destroy the FIRST enemy stone in node order. At most one per sigil, so at
    /// most six stones.
    pub fn resolve_hail_storm(&mut self, c: Color) -> u32 {
        let mut killed = 0;
        for pos in 0..6 {
            let m = crate::topology::SIGIL[pos] & self.theirs(c);
            if m != 0 {
                let node = m.trailing_zeros() as u8;
                self.stones[c.other().idx()] &= !(1u64 << node);
                self.update();
                killed += 1;
            }
        }
        killed
    }

    /// `bewitch` — convert one pair of ADJACENT enemy stones to your colour.
    /// Greedy takes the first such pair in (node order, neighbour order).
    pub fn bewitch_pairs(&self, c: Color) -> Vec<(u8, u8)> {
        let theirs = self.theirs(c);
        let mut out = Vec::new();
        let mut m = theirs;
        while m != 0 {
            let a = m.trailing_zeros() as usize;
            m &= m - 1;
            let mut nb = ADJ[a] & theirs;
            while nb != 0 {
                let b = nb.trailing_zeros() as u8;
                nb &= nb - 1;
                out.push((a as u8, b));
            }
        }
        out
    }

    pub fn resolve_bewitch(&mut self, c: Color) -> Option<(u8, u8)> {
        let theirs = self.theirs(c);
        let mut m = theirs;
        while m != 0 {
            let a = m.trailing_zeros() as usize;
            m &= m - 1;
            let nb = ADJ[a] & theirs;
            if nb != 0 {
                let b = nb.trailing_zeros() as u8;
                let bits = (1u64 << a) | (1u64 << b);
                self.stones[c.other().idx()] &= !bits;
                self.stones[c.idx()] |= bits;
                self.update();
                return Some((a as u8, b));
            }
        }
        None
    }

    /// `starfall` — place stones on two ADJACENT EMPTY nodes, then destroy every
    /// enemy stone adjacent to either. Greedy maximises (enemies destroyed, of
    /// which on a mana node), first-best-wins in (node order, neighbour order).
    pub fn starfall_pairs(&self, _c: Color) -> Vec<(u8, u8)> {
        let empty = self.empty();
        let mut out = Vec::new();
        let mut m = empty;
        while m != 0 {
            let a = m.trailing_zeros() as usize;
            m &= m - 1;
            let mut nb = ADJ[a] & empty;
            while nb != 0 {
                let b = nb.trailing_zeros() as u8;
                nb &= nb - 1;
                out.push((a as u8, b));
            }
        }
        out
    }

    fn starfall_score(&self, a: u8, b: u8, c: Color) -> (u32, u32) {
        let union = ADJ[a as usize] | ADJ[b as usize];
        let kills = union & self.theirs(c);
        (kills.count_ones(), (kills & crate::topology::MANA).count_ones())
    }

    pub fn resolve_starfall(&mut self, c: Color) -> Option<(u8, u8, u32)> {
        let empty = self.empty();
        let mut best: Option<(u8, u8)> = None;
        let mut best_score = (0u32, 0u32);
        let mut have = false;
        let mut m = empty;
        while m != 0 {
            let a = m.trailing_zeros() as usize;
            m &= m - 1;
            let mut nb = ADJ[a] & empty;
            while nb != 0 {
                let b = nb.trailing_zeros() as u8;
                nb &= nb - 1;
                let s = self.starfall_score(a as u8, b, c);
                if !have || s > best_score {   // strict >: first maximum wins
                    have = true; best_score = s; best = Some((a as u8, b));
                }
            }
        }
        let (a, b) = best?;
        self.stones[c.idx()] |= (1u64 << a) | (1u64 << b);
        let union = ADJ[a as usize] | ADJ[b as usize];
        let kills = union & self.theirs(c);
        self.stones[c.other().idx()] &= !kills;
        self.update();
        Some((a, b, kills.count_ones()))
    }

    /// `meteor` — blink anywhere not already yours (pushing if occupied), then
    /// destroy one adjacent enemy, preferring one on a mana node.
    /// Greedy maximises (crush + kill, of which on mana).
    fn meteor_score(&self, t: u8, c: Color) -> (u32, u32) {
        let theirs = self.theirs(c);
        let tb = 1u64 << t;
        let crush = theirs & tb != 0 && self.is_crushable(t, c);
        let crush_kills = crush as u32;
        let crush_mana = (crush && (crate::topology::MANA & tb != 0)) as u32;
        let adj_enemies = ADJ[t as usize] & theirs;
        let kill = (adj_enemies != 0) as u32;
        let kill_mana = (adj_enemies & crate::topology::MANA != 0) as u32;
        (crush_kills + kill, crush_mana + kill_mana)
    }

    pub fn resolve_meteor(&mut self, c: Color) -> Option<u8> {
        let targets = self.blinkable(c);
        if targets == 0 { return None; }
        let mut best: Option<u8> = None;
        let mut best_score = (0u32, 0u32);
        let mut have = false;
        let mut m = targets;
        while m != 0 {
            let t = m.trailing_zeros() as u8;
            m &= m - 1;
            let s = self.meteor_score(t, c);
            if !have || s > best_score { have = true; best_score = s; best = Some(t); }
        }
        let chosen = best.unwrap_or(targets.trailing_zeros() as u8);
        if self.theirs(c) & (1u64 << chosen) != 0 { let _ = self.push_enemy(chosen, c); }
        else { self.place(chosen, c); }
        self.update();
        // Destroy one adjacent enemy, mana first, else lowest node order.
        let adj_enemies = ADJ[chosen as usize] & self.theirs(c);
        if adj_enemies != 0 {
            let mana_hits = adj_enemies & crate::topology::MANA;
            let victim = if mana_hits != 0 { mana_hits.trailing_zeros() }
                         else { adj_enemies.trailing_zeros() } as u8;
            self.stones[c.other().idx()] &= !(1u64 << victim);
            self.update();
        }
        Some(chosen)
    }

    /// `comet` — blink (preferring an uncontested mana node), then sacrifice a
    /// stone that is NOT the one just placed.
    ///
    /// Greedy target: scan MANA_NODES in REVERSE order (c1, b1, a1) for a node that
    /// is not ours, that we are not already touching, and that has fewer than two
    /// adjacent enemies; else the lowest-index blinkable node.
    pub fn resolve_comet(&mut self, c: Color) -> Option<u8> {
        let mine = self.mine(c);
        let theirs = self.theirs(c);
        let mut target: Option<u8> = None;
        for &mn in MANA_ORDER.iter().rev() {
            let bit = 1u64 << mn;
            if mine & bit != 0 { continue; }
            let adj_enemy = (ADJ[mn as usize] & theirs).count_ones();
            let already_touching = (ADJ[mn as usize] & mine) != 0;
            if !already_touching && adj_enemy < 2 { target = Some(mn); break; }
        }
        if target.is_none() {
            let t = self.blinkable(c);
            if t == 0 { return None; }
            target = Some(t.trailing_zeros() as u8);
        }
        let t = target?;
        if self.theirs(c) & (1u64 << t) != 0 { let _ = self.push_enemy(t, c); }
        else { self.place(t, c); }
        self.update();
        if let Some(s) = self.sacrifice_pick(c, Some(t)) {
            self.stones[c.idx()] &= !(1u64 << s);
            self.update();
        }
        Some(t)
    }
}

// ============================ sigil-targeting / control batch ============================
/// Syzygy maps a 5-node ritual position to its "opposite" charm (1-node) and
/// sorcery (3-node) positions, rotating zones A->B->C->A. 1-based in the source
/// tables (`SYZYGY_OPPOSITE = {1:(8,5), 2:(9,6), 3:(7,4)}`); stored 0-based here.
pub fn syzygy_opposite(pos: usize) -> Option<(usize, usize)> { SYZYGY_OPPOSITE[pos] }

const SYZYGY_OPPOSITE: [Option<(usize, usize)>; 9] = [
    Some((7, 4)), Some((8, 5)), Some((6, 3)),
    None, None, None, None, None, None,
];

impl Board {
    /// Nodes of sigil `pos` that `c` does not own — the "uncontrolled" set that
    /// Azimuth and Eclipse count.
    #[inline]
    pub fn uncontrolled_count(&self, pos: usize, c: Color) -> u32 { self.uncontrolled(pos, c) }

    #[inline]
    fn uncontrolled(&self, pos: usize, c: Color) -> u32 {
        (crate::topology::SIGIL[pos] & !self.mine(c)).count_ones()
    }

    /// `azimuth` — one ordinary move into a sigil where `c` controls all but
    /// exactly ONE node. Scans positions 1..9 in order, nodes in node order.
    pub fn resolve_azimuth(&mut self, c: Color) -> Option<u8> {
        let moves = self.all_moveable(c);
        for pos in 0..9 {
            if self.uncontrolled(pos, c) != 1 { continue; }
            let t = crate::topology::SIGIL[pos] & moves;
            if t != 0 {
                let node = t.trailing_zeros() as u8;
                self.step_move(node, c);
                return Some(node);
            }
        }
        None
    }

    /// `eclipse` — TWO ordinary moves into a sigil where `c` controls all but
    /// exactly TWO nodes. The sigil is committed by the first move; the second
    /// move must land in that same sigil, and is skipped if nothing is reachable.
    pub fn resolve_eclipse(&mut self, c: Color) -> u8 {
        let mut chosen_pos = None;
        for pos in 0..9 {
            if self.uncontrolled(pos, c) != 2 { continue; }
            let t = crate::topology::SIGIL[pos] & self.all_moveable(c);
            if t != 0 {
                self.step_move(t.trailing_zeros() as u8, c);
                chosen_pos = Some(pos);
                break;
            }
        }
        let Some(pos) = chosen_pos else { return 0 };
        let t2 = crate::topology::SIGIL[pos] & self.all_moveable(c);
        if t2 != 0 {
            self.step_move(t2.trailing_zeros() as u8, c);
            return 2;
        }
        1
    }

    /// `scatter` — one soft BLINK (place on an empty node, no adjacency needed)
    /// into each of TWO DIFFERENT sigils. Stops early if no unused sigil has an
    /// empty node.
    pub fn resolve_scatter(&mut self, c: Color) -> u8 {
        let mut used = [false; 9];
        let mut placed = 0u8;
        for _ in 0..2 {
            let mut found = None;
            for pos in 0..9 {
                if used[pos] { continue; }
                let e = crate::topology::SIGIL[pos] & self.empty();
                if e != 0 { found = Some((pos, e.trailing_zeros() as u8)); break; }
            }
            let Some((pos, node)) = found else { break };
            self.place(node, c);
            used[pos] = true;
            self.update();
            placed += 1;
        }
        placed
    }

    /// `blossom` — one soft blink into each OTHER 3- or 5-node sigil (positions
    /// 1..6). A full sigil is SKIPPED, not a stop condition: simboard's comment
    /// notes the old `break` made the whole spread fizzle whenever the first other
    /// sigil happened to be full.
    pub fn resolve_blossom(&mut self, pos_self: usize, c: Color) -> u8 {
        let mut placed = 0u8;
        for pos in 0..6 {
            if pos == pos_self { continue; }
            let e = crate::topology::SIGIL[pos] & self.empty();
            if e == 0 { continue; }          // skip, do not stop
            self.place(e.trailing_zeros() as u8, c);
            self.update();
            placed += 1;
        }
        placed
    }

    /// `syzygy` — one blink into the opposite 1-node sigil, then up to three into
    /// the opposite 3-node sigil. Only defined for ritual positions 1..3; a Syzygy
    /// drawn elsewhere does nothing.
    pub fn resolve_syzygy(&mut self, pos_self: usize, c: Color) -> u8 {
        let Some((charm, sorcery)) = SYZYGY_OPPOSITE[pos_self] else { return 0 };
        let mut acted = 0u8;
        let charm_node = crate::topology::SIGIL[charm].trailing_zeros() as u8;
        if self.mine(c) & (1u64 << charm_node) == 0 {
            self.step_move(charm_node, c);   // blink: pushes if enemy-held
            acted += 1;
        }
        for _ in 0..3 {
            let t = crate::topology::SIGIL[sorcery] & !self.mine(c);
            if t == 0 { break; }
            self.step_move(t.trailing_zeros() as u8, c);
            acted += 1;
        }
        acted
    }

    /// `charge` — one ordinary move into ANY 3- or 5-node sigil (positions 1..6),
    /// with no control precondition, unlike Azimuth.
    pub fn resolve_charge(&mut self, c: Color) -> Option<u8> {
        let moves = self.all_moveable(c);
        for pos in 0..6 {
            let t = crate::topology::SIGIL[pos] & moves;
            if t != 0 {
                let node = t.trailing_zeros() as u8;
                self.step_move(node, c);
                return Some(node);
            }
        }
        None
    }

    /// `fury` — sacrifice one stone, then three hard moves. If the sacrifice ends
    /// the game (it was your last stone) the hard moves are skipped.
    pub fn resolve_fury(&mut self, c: Color) -> (Option<u8>, u8) {
        let sac = self.sacrifice_pick(c, None);
        if let Some(s) = sac { self.stones[c.idx()] &= !(1u64 << s); }
        self.update();
        if self.outcome != crate::board::Outcome::Ongoing { return (sac, 0); }
        (sac, self.resolve_hard_moves(c, 3))
    }

    /// `erupt` — up to TWO ordinary moves into every 3- or 5-node sigil (positions
    /// 1..6) in which `c` already holds a stone, EXCEPT Erupt's own slot.
    /// Stops entirely if the game ends mid-effect.
    pub fn resolve_erupt(&mut self, pos_self: usize, c: Color) -> u8 {
        let mut acted = 0u8;
        for pos in 0..6 {
            if pos == pos_self { continue; }
            if crate::topology::SIGIL[pos] & self.mine(c) == 0 { continue; }
            for _ in 0..2 {
                let t = crate::topology::SIGIL[pos] & self.all_moveable(c);
                if t == 0 { break; }
                self.step_move(t.trailing_zeros() as u8, c);
                acted += 1;
                if self.outcome != crate::board::Outcome::Ongoing { return acted; }
            }
        }
        acted
    }

    /// `gust` — pick up every enemy stone touching one of yours, then drop them one
    /// at a time onto the lowest-index empty node. Note the enemy KEEPS the stones:
    /// they are relocated, not destroyed, so a Gust never changes stone counts
    /// unless the board runs out of empty nodes.
    pub fn resolve_gust(&mut self, c: Color) -> u32 {
        let picked = self.theirs(c) & Self::dilate(self.mine(c));
        if picked == 0 { return 0; }
        let n = picked.count_ones();
        self.stones[c.other().idx()] &= !picked;
        self.update();
        for _ in 0..n {
            let e = self.empty();
            if e == 0 { break; }
            self.stones[c.other().idx()] |= 1u64 << e.trailing_zeros();
            self.update();
        }
        n
    }

    /// `storm_front` — destroy any two enemy stones (greedy: lowest node order).
    /// Stops if the first destruction ends the game.
    pub fn resolve_storm_front(&mut self, c: Color) -> u32 {
        let mut destroyed = 0;
        for _ in 0..2 {
            let t = self.theirs(c);
            if t == 0 { break; }
            self.stones[c.other().idx()] &= !(1u64 << t.trailing_zeros());
            destroyed += 1;
            self.update();
            if self.outcome != crate::board::Outcome::Ongoing { break; }
        }
        destroyed
    }

    /// Contiguous enemy groups, discovered in node order (matching the Python BFS
    /// scan) so that "the first smallest group" is well defined.
    pub fn enemy_groups(&self, c: Color) -> Vec<u64> {
        let theirs = self.theirs(c);
        let mut seen = 0u64;
        let mut groups = Vec::new();
        let mut scan = theirs;
        while scan != 0 {
            let start = scan.trailing_zeros();
            scan &= scan - 1;
            if seen & (1u64 << start) != 0 { continue; }
            let mut group = 1u64 << start;
            loop {
                let grown = group | (Self::dilate(group) & theirs);
                if grown == group { break; }
                group = grown;
            }
            seen |= group;
            groups.push(group);
        }
        groups
    }

    /// `hurricane` — destroy the smallest contiguous enemy group; ties go to the
    /// one found first in node order.
    pub fn resolve_hurricane(&mut self, c: Color) -> u32 {
        let groups = self.enemy_groups(c);
        let Some(best) = groups.iter().min_by_key(|g| g.count_ones()) else { return 0 };
        let n = best.count_ones();
        self.stones[c.other().idx()] &= !*best;
        self.update();
        n
    }

    /// `corrupt` — convert up to THREE enemy stones touching you, then sacrifice
    /// one of your own. Eligibility is frozen against the PRE-conversion board so
    /// conversions cannot chain. If converting ends the game, no sacrifice.
    pub fn resolve_corrupt(&mut self, c: Color) -> (u32, Option<u8>) {
        let eligible = self.theirs(c) & Self::dilate(self.mine(c));
        let mut take = 0u64;
        let mut m = eligible;
        let mut n = 0;
        while m != 0 && n < 3 {
            take |= 1u64 << m.trailing_zeros();
            m &= m - 1;
            n += 1;
        }
        self.stones[c.other().idx()] &= !take;
        self.stones[c.idx()] |= take;
        self.update();
        if self.outcome != crate::board::Outcome::Ongoing { return (n, None); }
        let sac = self.sacrifice_pick(c, None);
        if let Some(s) = sac {
            self.stones[c.idx()] &= !(1u64 << s);
            self.update();
        }
        (n, sac)
    }
}
