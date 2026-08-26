//! Spell casting: the shared framework, statics, and the Autumn resolvers.
//!
//! Reference is the LIVE JS engine (`docs/static/scripts/engine/`), which is what
//! sigilbattle.com runs and which Robi confirms is authoritative. For Autumn it is
//! the ONLY implementation — simboard.py never implemented Harvest/Gather.

use crate::board::{Board, Color, Outcome, NO_SPELL};
use crate::spells_meta::*;
use crate::topology::{SIGIL, SPELL_NODES};

impl Board {
    /// Sigil position (0-based) holding `spell_id`, if drawn this game.
    #[inline]
    pub fn position_of(&self, spell_id: u8) -> Option<usize> {
        self.spells.iter().position(|&s| s == spell_id)
    }

    #[inline]
    pub fn is_charged(&self, c: Color, pos: usize) -> bool {
        self.charged[c.idx()] & (1 << pos) != 0
    }

    /// Does `c` hold a CHARGED copy of `spell_id`? Every static (the eight Seals)
    /// takes effect from being charged, not from being cast.
    pub fn holds_charged(&self, c: Color, spell_id: u8) -> bool {
        match self.position_of(spell_id) {
            Some(p) => self.is_charged(c, p),
            None => false,
        }
    }

    /// Stones `c` may sacrifice to dash. Seal of Autumn (static, held charged by
    /// the ENEMY) bars sacrificing any stone standing on a sigil node, leaving
    /// only mana and void stones. Mirrors `canSac`, sim-board.js:1716.
    pub fn dash_sacrificeable(&self, c: Color) -> u64 {
        let mut m = self.mine(c);
        if self.holds_charged(c.other(), SEAL_OF_AUTUMN) { m &= !SPELL_NODES; }
        m
    }

    /// 2 stones normally, 1 while `c` holds Seal of Lightning charged.
    #[inline]
    pub fn dash_cost(&self, c: Color) -> u32 {
        if self.holds_charged(c, SEAL_OF_LIGHTNING) { 1 } else { 2 }
    }

    #[inline]
    pub fn can_dash(&self, c: Color) -> bool {
        self.dash_sacrificeable(c).count_ones() >= self.dash_cost(c)
    }

    /// Spell ids `c` could legally cast now. Mirrors `_getCastableSpells`.
    pub fn castable(&self, c: Color, can_spell: bool, can_summer: bool, post_dash: bool)
        -> Vec<u8>
    {
        let has_winter = self.holds_charged(c.other(), SEAL_OF_WINTER);
        let has_summer = self.holds_charged(c, SEAL_OF_SUMMER);
        let has_spring = self.holds_charged(c, SEAL_OF_SPRING);
        let mut out = Vec::new();
        for pos in 0..9 {
            if !self.is_charged(c, pos) { continue; }
            let id = self.spells[pos];
            if id == NO_SPELL || id as usize >= NUM_OFFICIAL_SPELLS { continue; }
            let info = &SPELLS[id as usize];
            if info.is_static { continue; }
            if info.is_charm {
                if has_winter { continue; }               // enemy Seal of Winter
                if id == SURGE { continue; }              // never via this path
                if id == SPLASH && post_dash { continue; }
                if can_spell || (has_summer && can_summer) { out.push(id); }
            } else if self.lock[c.idx()] == id {
                // Re-casting the locked spell needs Seal of Spring, once only.
                if has_spring && self.springlock[c.idx()] != id { out.push(id); }
            } else {
                out.push(id);
            }
        }
        out
    }

    /// Clear the cast sigil, then (non-charms) refill up to `mana` of its nodes in
    /// the engine's fixed priority order. Mirrors `_castClearAndRefill`
    /// (sim-board.js:1633) minus the Lifesap branch, which is Panda.
    pub fn cast_clear_and_refill(&mut self, pos: usize, c: Color) {
        let mask = SIGIL[pos];
        self.stones[0] &= !mask;
        self.stones[1] &= !mask;
        let id = self.spells[pos];
        let is_charm = (id as usize) < NUM_OFFICIAL_SPELLS && SPELLS[id as usize].is_charm;
        if !is_charm {
            let mut nodes = [0u8; 5];
            let mut n = 0;
            let mut m = mask;
            while m != 0 { nodes[n] = m.trailing_zeros() as u8; n += 1; m &= m - 1; }
            // JS priority: 5-node -> [2,3,4,0,1]; 3-node -> [2,1,0]; singleton -> [0].
            let order: &[usize] = match n { 5 => &[2, 3, 4, 0, 1], 3 => &[2, 1, 0], _ => &[0] };
            let mut refills = self.mana[c.idx()];
            for &k in order {
                if refills == 0 { break; }
                self.stones[c.idx()] |= 1u64 << nodes[k];
                refills -= 1;
            }
        }
        self.update();
    }

    /// Post-resolve bookkeeping: lock, springlock, spell counter.
    pub fn finish_cast(&mut self, id: u8, c: Color) {
        if (id as usize) >= NUM_OFFICIAL_SPELLS { return; }
        if SPELLS[id as usize].is_charm { return; }
        let i = c.idx();
        if self.lock[i] == id { self.springlock[i] = id; }
        else { self.lock[i] = id; self.springlock[i] = NO_SPELL; }
        if !self.variant.has_deathmatch() {
            self.spell_counter[i] = self.spell_counter[i].saturating_add(1);
        }
    }

    /// Landing zone for Harvest / Gather: this spell's own nodes plus the nodes of
    /// the spell `c` was locked into BEFORE this cast.
    ///
    /// `finish_cast` reassigns the lock only AFTER the resolver runs, so reading
    /// `self.lock` here yields the pre-cast lock — exactly what spells.js:854
    /// documents. Charms never lock, so the locked spell is always a non-charm.
    pub fn autumn_allowed_zone(&self, pos: usize, c: Color) -> u64 {
        let mut zone = SIGIL[pos];
        let locked = self.lock[c.idx()];
        if locked != NO_SPELL {
            if let Some(lp) = self.position_of(locked) { zone |= SIGIL[lp]; }
        }
        zone
    }

    /// Legal Harvest/Gather steps: any ordinary move target (soft or hard — never
    /// a blink) landing inside the allowed zone.
    #[inline]
    pub fn autumn_targets(&self, pos: usize, c: Color) -> u64 {
        self.all_moveable(c) & self.autumn_allowed_zone(pos, c)
    }

    /// Resolve `locked_or_self_moves` greedily. Returns how many of `count` steps
    /// were taken; fewer means the effect ended early, which is legal — spells.js
    /// returns as soon as the target set is empty (no bordering stones, or the zone
    /// already full), and also stops if the game ends mid-resolution.
    pub fn resolve_autumn_moves(&mut self, pos: usize, c: Color, count: u8) -> u8 {
        let mut done = 0u8;
        for _ in 0..count {
            if self.outcome != Outcome::Ongoing { break; }
            let targets = self.autumn_targets(pos, c);
            if targets == 0 { break; }
            let node = targets.trailing_zeros() as u8;
            if self.theirs(c) & (1u64 << node) != 0 { let _ = self.push_enemy(node, c); }
            else { self.stones[c.idx()] |= 1u64 << node; }
            self.update();
            done += 1;
        }
        done
    }

    /// Every legal single Harvest/Gather step for the enumerator: each target, and
    /// for pushes each destination — the live game asks the player to choose it
    /// (`doPushEnemy`) rather than taking options[0].
    pub fn autumn_step_options(&self, pos: usize, c: Color) -> Vec<(u8, Option<u8>)> {
        let mut out = Vec::new();
        let mut m = self.autumn_targets(pos, c);
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            if self.theirs(c) & (1u64 << node) != 0 {
                let (opts, k) = self.push_options(node, c);
                if k == 0 { out.push((node, None)); }
                else { for &d in &opts[..k] { out.push((node, Some(d))); } }
            } else { out.push((node, None)); }
        }
        out
    }
}

impl Board {
    /// Is this a structurally legal draw? Rituals must sit in positions 1-3
    /// (5 nodes), sorceries in 4-6 (3 nodes), charms in 7-9 (1 node), and every id
    /// must be in scope and distinct.
    ///
    /// Worth enforcing in tests: a non-charm in a 1-node slot drives
    /// `_cast_spell`'s refill past the end of `position_nodes` (IndexError in
    /// simboard.py; a write to an undefined key in the JS). Legal draws cannot
    /// reach that, because non-charm and charm partition the 39 spells exactly.
    pub fn draw_is_legal(&self) -> bool {
        let mut seen = [false; NUM_OFFICIAL_SPELLS];
        for (pos, &id) in self.spells.iter().enumerate() {
            let i = id as usize;
            if i >= NUM_OFFICIAL_SPELLS { return false; }
            if seen[i] { return false; }
            seen[i] = true;
            let want = match pos { 0..=2 => Role::Ritual, 3..=5 => Role::Sorcery, _ => Role::Charm };
            if SPELLS[i].role != want { return false; }
        }
        true
    }

    /// Build a legal draw from a seed: 3 distinct rituals, 3 sorceries, 3 charms.
    pub fn legal_draw(seed: u64) -> [u8; 9] {
        let mut s = seed | 1;
        let mut next = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let mut out = [0u8; 9];
        for (slot, pool) in [(0usize, &RITUALS[..]), (3, &SORCERIES[..]), (6, &CHARMS[..])] {
            let mut p: Vec<u8> = pool.to_vec();
            for i in (1..p.len()).rev() {
                let j = (next() % (i as u64 + 1)) as usize;
                p.swap(i, j);
            }
            out[slot..slot + 3].copy_from_slice(&p[..3]);
        }
        out
    }
}
