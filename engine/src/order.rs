//! Move ordering, from how strong human players actually think about Sigil.
//!
//! Robi's framing: a push is two decisions — which enemy stone you DEPORT, and
//! where you SEND it. Get those right and the plausible set is narrow, which is
//! why humans do not agonise over Gust turns even though the raw combinatorics
//! are in the tens of thousands.
//!
//!   DEPORT FROM: the best nodes the enemy holds — mana first (a1/b1/c1, which
//!   drive refill tempo) — and the most dangerous ones, i.e. stones that are
//!   constricting one of your groups.
//!
//!   SEND TO: the worst nodes for them. Which nodes are worst depends on what YOU
//!   are threatening:
//!     * nothing in particular -> void nodes (they belong to no sigil, so an enemy
//!       stone parked there charges nothing)
//!     * Hail Storm -> spread them across as MANY 3-/5-node sigils as possible,
//!       since Hail Storm kills one stone in each
//!     * Decay -> leave them FRAGMENTED, since Decay kills every enemy stone
//!       touching two or more empty nodes
//!     * Hurricane -> make them CONTIGUOUS, since Hurricane kills the smallest
//!       group and one big group means killing everything
//!
//! Ordering never removes options: it only decides what a search looks at first.

use crate::board::{Board, Color};
use crate::spells_meta::*;
use crate::topology::{ADJ, BIG_SPELL_NODES, MANA, SIGIL, VOID};

/// What we want the enemy's stones to look like after we move them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlacementGoal {
    /// Park them where they cannot help: void nodes.
    Voids,
    /// Spread across as many 3-/5-node sigils as possible (Hail Storm).
    SpreadSigils,
    /// Keep them fragmented and exposed (Decay).
    Fragment,
    /// Gather them into one contiguous mass (Hurricane).
    Coalesce,
}

impl Board {
    /// Is `c` threatening `spell_id`? Charged now, or one node short of charged —
    /// which is when a human already starts playing for it.
    pub fn is_threatening(&self, c: Color, spell_id: u8) -> bool {
        match self.position_of(spell_id) {
            None => false,
            Some(p) => self.is_charged(c, p) || self.uncontrolled_count(p, c) == 1,
        }
    }

    /// Which placement goal `c` should play for. Checked in the order a human would
    /// weigh them: Hurricane wipes a whole group, Hail Storm scales with sigil
    /// spread, Decay with exposure.
    pub fn placement_goal(&self, c: Color) -> PlacementGoal {
        if self.is_threatening(c, HURRICANE) { return PlacementGoal::Coalesce; }
        if self.is_threatening(c, HAIL_STORM) { return PlacementGoal::SpreadSigils; }
        if self.is_threatening(c, DECAY) { return PlacementGoal::Fragment; }
        PlacementGoal::Voids
    }

    /// How much `c` wants to deport the enemy stone standing on `node`.
    /// Higher is more urgent.
    pub fn deport_value(&self, node: u8, c: Color) -> i32 {
        let bit = 1u64 << node;
        let mut v = 0i32;
        // Mana is the prize: it drives every cast's refill count.
        if MANA & bit != 0 { v += 100; }
        // A stone inside a sigil the enemy is close to charging is dangerous.
        for p in 0..9 {
            if SIGIL[p] & bit == 0 { continue; }
            let gaps = self.uncontrolled_count(p, c.other());
            if gaps == 0 { v += 60; } else if gaps == 1 { v += 45; } else if gaps == 2 { v += 20; }
            // Conversely, a sigil WE are close to charging: clearing it helps us.
            let ours = self.uncontrolled_count(p, c);
            if ours == 1 { v += 40; } else if ours == 2 { v += 15; }
        }
        // "Most dangerous": the stone is constricting one of our groups. Measured as
        // the pressure it puts on our adjacent stones' escape routes.
        let ours_adj = ADJ[node as usize] & self.mine(c);
        let mut m = ours_adj;
        while m != 0 {
            let f = m.trailing_zeros() as u8;
            m &= m - 1;
            let esc = self.escape_distance(f, c, 6);
            // Short escape distance means that friendly stone is nearly crushable.
            v += match esc { 0 | 1 => 50, 2 => 25, 3 => 10, _ => 3 };
        }
        v
    }

    /// How much `c` wants an enemy stone to END UP on `node`, given the goal.
    /// This is the additive proxy; configuration-level goals are scored exactly
    /// afterwards by `configuration_value`.
    pub fn destination_value(&self, node: u8, c: Color, goal: PlacementGoal) -> i32 {
        let bit = 1u64 << node;
        let mut v = 0i32;
        // Never hand back a mana node, whatever the goal.
        if MANA & bit != 0 { v -= 120; }
        match goal {
            PlacementGoal::Voids => {
                if VOID & bit != 0 { v += 80; }
                if BIG_SPELL_NODES & bit != 0 { v -= 40; }
            }
            PlacementGoal::SpreadSigils => {
                // Reward a sigil that does not already hold an enemy stone, so Hail
                // Storm's one-kill-per-sigil covers more ground.
                for p in 0..6 {
                    if SIGIL[p] & bit == 0 { continue; }
                    if SIGIL[p] & self.theirs(c) == 0 { v += 90; } else { v += 5; }
                }
                if VOID & bit != 0 { v -= 20; }
            }
            PlacementGoal::Fragment => {
                // Exposed means two or more empty neighbours: that is exactly Decay's
                // trigger. Prefer somewhere isolated from their other stones.
                let empties = (ADJ[node as usize] & self.empty()).count_ones() as i32;
                v += 25 * empties;
                let friends = (ADJ[node as usize] & self.theirs(c)).count_ones() as i32;
                v -= 30 * friends;
            }
            PlacementGoal::Coalesce => {
                // Adjacent to their existing stones, so the groups merge into one.
                let friends = (ADJ[node as usize] & self.theirs(c)).count_ones() as i32;
                v += 60 * friends;
                if friends == 0 { v -= 40; }
            }
        }
        v
    }

    /// Exact objective on a RESULTING board — used to rank candidate outcomes after
    /// the additive proxy has narrowed them. Higher is better for `c`.
    pub fn configuration_value(&self, c: Color, goal: PlacementGoal) -> i32 {
        let theirs = self.theirs(c);
        match goal {
            PlacementGoal::Voids =>
                40 * (theirs & VOID).count_ones() as i32
                    - 60 * (theirs & MANA).count_ones() as i32
                    - 20 * (theirs & BIG_SPELL_NODES).count_ones() as i32,
            PlacementGoal::SpreadSigils => {
                // Hail Storm kills one per sigil, so the payoff IS the sigil count.
                let covered = (0..6).filter(|&p| SIGIL[p] & theirs != 0).count() as i32;
                100 * covered - 60 * (theirs & MANA).count_ones() as i32
            }
            PlacementGoal::Fragment => {
                // Decay kills every enemy stone with >= 2 empty neighbours.
                let empty = self.empty();
                let mut exposed = 0i32;
                let mut m = theirs;
                while m != 0 {
                    let i = m.trailing_zeros() as usize;
                    m &= m - 1;
                    if (ADJ[i] & empty).count_ones() >= 2 { exposed += 1; }
                }
                80 * exposed - 60 * (theirs & MANA).count_ones() as i32
            }
            PlacementGoal::Coalesce => {
                // Hurricane kills the SMALLEST group, so we want one big group:
                // reward the smallest group's size, penalise group count.
                let groups = self.enemy_groups(c);
                if groups.is_empty() { return 0; }
                let smallest = groups.iter().map(|g| g.count_ones()).min().unwrap() as i32;
                80 * smallest - 30 * groups.len() as i32
                    - 60 * (theirs & MANA).count_ones() as i32
            }
        }
    }

    /// Score one candidate move `(node, push_to)` for ordering purposes.
    pub fn move_score(&self, node: u8, push_to: Option<u8>, c: Color) -> i32 {
        let goal = self.placement_goal(c);
        let bit = 1u64 << node;
        let mut v = 0i32;
        if self.theirs(c) & bit != 0 {
            // A hard move: deporting value plus where we send them.
            v += self.deport_value(node, c);
            match push_to {
                None => v += 150,                        // a crush removes it entirely
                Some(d) => v += self.destination_value(d, c, goal),
            }
        } else {
            // A soft move. Taking mana, and progressing a sigil we nearly hold.
            if MANA & bit != 0 { v += 90; }
            for p in 0..9 {
                if SIGIL[p] & bit == 0 { continue; }
                match self.uncontrolled_count(p, c) {
                    1 => v += 70,                        // this move charges it
                    2 => v += 30,
                    _ => v += 5,
                }
            }
            if VOID & bit != 0 { v -= 10; }
        }
        v
    }

    /// All first-move options, best-first.
    pub fn ordered_first_moves(&self, c: Color) -> Vec<(u8, Option<u8>)> {
        let (targets, _wind) = self.first_move_targets(c);
        let mut v = self.move_variants_pub(targets, c);
        v.sort_by_key(|&(n, p)| -self.move_score(n, p, c));
        v
    }

    /// Gust placements, best-first, WITHOUT materialising C(empties, displaced).
    ///
    /// The displaced stones are interchangeable, so an outcome is a SET of landing
    /// nodes. Score is additive over nodes, so the best set is the top-`n` by
    /// `destination_value`; successive sets are reached by swapping one element for
    /// the next-best unused node. Enumerating in that order yields best-first and,
    /// continued far enough, still reaches every set — ordering, not pruning.
    ///
    /// Candidates are then re-ranked by the exact `configuration_value`, which is
    /// what the sigil-spread / fragment / coalesce goals actually care about.
    pub fn gust_placements_ordered(&self, c: Color, limit: usize) -> Vec<Board> {
        let picked = self.theirs(c) & Board::dilate(self.mine(c));
        if picked == 0 { return vec![*self]; }
        let n = picked.count_ones() as usize;
        let goal = self.placement_goal(c);

        let mut base = *self;
        base.stones[c.other().idx()] &= !picked;
        base.update();

        // Rank the empty nodes once.
        let mut ranked: Vec<(i32, u8)> = {
            let mut v = Vec::new();
            let mut m = base.empty();
            while m != 0 {
                let node = m.trailing_zeros() as u8;
                m &= m - 1;
                v.push((base.destination_value(node, c, goal), node));
            }
            v
        };
        ranked.sort_by_key(|&(s, node)| (-s, node));
        if ranked.len() < n {
            return vec![base];
        }

        // Best-first over sets via a "swap one element rightward" frontier. Seeded
        // with the top-n prefix; each expansion advances one chosen index to the
        // next unused rank. Deduped, and bounded by `limit` candidates.
        use std::collections::{BinaryHeap, HashSet};
        let m = ranked.len();
        let seed: Vec<usize> = (0..n).collect();
        let key = |idx: &Vec<usize>| -> i32 { idx.iter().map(|&i| ranked[i].0).sum() };
        let mut heap: BinaryHeap<(i32, Vec<usize>)> = BinaryHeap::new();
        let mut seen: HashSet<Vec<usize>> = HashSet::new();
        heap.push((key(&seed), seed.clone()));
        seen.insert(seed);

        let mut cands: Vec<(i32, Board)> = Vec::new();
        while let Some((_k, idx)) = heap.pop() {
            let mut b = base;
            for &i in &idx { b.stones[c.other().idx()] |= 1u64 << ranked[i].1; }
            b.update();
            cands.push((b.configuration_value(c, goal), b));
            if cands.len() >= limit { break; }
            // Expand: advance each position to the next unused rank.
            for slot in 0..n {
                let mut next = idx.clone();
                let mut cand = next[slot] + 1;
                while cand < m && next.contains(&cand) { cand += 1; }
                if cand >= m { continue; }
                next[slot] = cand;
                next.sort_unstable();
                if seen.insert(next.clone()) { heap.push((key(&next), next)); }
            }
        }
        // Exact re-rank of the shortlist by the configuration objective.
        cands.sort_by_key(|&(v, _)| -v);
        cands.into_iter().map(|(_, b)| b).collect()
    }
}

impl Board {
    /// Score a whole turn for ordering, WITHOUT simulating it.
    ///
    /// The first version walked the turn and resolved cast outcomes per candidate.
    /// That is called for every candidate at every node, and it cost **86-94% of
    /// node rate** (7-15x slowdown) — a measured 21.2% score over 80 games against
    /// the ordering it replaced, with depth falling 5.62 -> 4.31. Ordering must be
    /// near-free, so this version touches no board state:
    ///
    ///   * moves      `move_score` on the current board
    ///   * dash       the sacrifice cost, offset by a tempo credit, because a dash
    ///                buys a second placement in one turn — filling a sigil to cast
    ///                it, or clearing stones that were about to be crushed
    ///   * cast       a flat credit plus mana (refill scales with mana), rather
    ///                than resolving the spell
    pub fn turn_score(&self, t: &crate::turn::Turn, c: Color) -> i32 {
        use crate::turn::Action;
        let mut v = 0i32;
        for a in t.slice() {
            match *a {
                Action::Move { node, push_to } | Action::Blink { node, push_to } => {
                    v += self.move_score(node, push_to, c);
                }
                Action::Dash { sacs, n_sacs, node, .. } => {
                    for i in 0..n_sacs as usize {
                        v -= self.sacrifice_cost(sacs[i], c);
                        // A stone with no escape was going to be lost anyway, so
                        // spending it costs far less than its nominal value. Missing
                        // this is why the search over-valued surrounding a group.
                        if self.escape_distance(sacs[i], c, 3) >= 3 { v += 60; }
                    }
                    // Credit for the extra placement the dash buys.
                    v += 70;
                    for p in 0..9 {
                        if crate::topology::SIGIL[p] & (1u64 << node) == 0 { continue; }
                        // Landing the last stone of a sigil is the tempo play the
                        // search could not see: dash, fill, cast, all in one turn.
                        match self.uncontrolled_count(p, c) { 1 => v += 120, 2 => v += 40, _ => {} }
                    }
                }
                Action::Cast { .. } => { v += 150 + 30 * self.mana[c.idx()] as i32; }
                Action::Pass => {}
            }
        }
        v
    }
}
