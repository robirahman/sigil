//! Which dashes are worth showing the search, and when.
//!
//! `TurnIter` yields in stages — Moves, MoveCast, Dash, DashCast — so under
//! progressive widening (6 successors near the leaves, 40 deep) dashes were
//! unreachable: measured over 120 legal midgame positions the first dash turn sat
//! at median index 40 and p90 284, so at width 10 a dash was absent in 118/120.
//! The search was structurally blind to a whole move class.
//!
//! The first two fixes tried to buy dashes a QUOTA of the width budget and score
//! the merged stream. Both lost badly (21.2% and 16.2% over 80 games), and the
//! second held depth level, so the cost was not the problem — the ordering was.
//! Reserving budget for dashes displaces better moves, because most dashes are
//! junk: you pay two stones for one placement.
//!
//! So take the approach that made Gust tractable, per Robi: don't rank the whole
//! class, GENERATE only the part a human would consider. A dash is worth a slot
//! when it does one of the things a player actually dashes for:
//!
//!   * CRUSH        the dash's move crushes an enemy stone outright
//!   * SPELL_CRUSH  it leaves MORE enemy stones crushable by a spell ALREADY
//!                  CHARGED than the same turn would without dashing. Two parts,
//!                  both from Robi: the test is what you hold charged, not the
//!                  spell's size — Carnage, Torrent, Tsunami and Fury all pay for
//!                  a dash that encircles a group first, and a one-node crusher
//!                  only helps if it happens to be charged already — and the gain
//!                  must be MARGINAL. A dash that seals a stone you could already
//!                  crush without it has just spent two stones for nothing, so the
//!                  count is compared against the no-dash baseline, not zero.
//!   * FILLS        it lands the last stone of a sigil — dash, fill, cast, all in
//!                  one turn, which is the tempo play the search could not see
//!   * MANA         it claims a mana node, which drives every later refill
//!   * DOOMED       the stones it spends had no escape and were lost anyway.
//!                  This is the "trapped player sacrifices the trapped group"
//!                  resource Robi flagged from the playtest.
//!
//! Everything else stays exactly where it was, reachable by widening. The filter
//! is a GENERATION heuristic, never a legality claim: `enumerate_turns_exhaustive`
//! is untouched and still enumerates every dash.
//!
//! Cost discipline: no board is copied to decide interest. Interesting landing
//! nodes are built as a bitmask and handed to `move_variants_pub`, so push options
//! are resolved only for the handful of targets that already qualified.
//! Two monotonicity facts make the precomputed supersets sound:
//!   * sacrificing our own stones only makes an enemy stone HARDER to crush (it
//!     removes attackers), so crush candidates computed before the sacrifice are a
//!     superset of those after it;
//!   * likewise it can only shorten an enemy escape, so `nearly_sealed` computed
//!     before the sacrifice is a superset too.

use crate::board::{Board, Color, Outcome};
use crate::spells_meta::{Resolve, NUM_OFFICIAL_SPELLS, SPELLS};
use crate::topology::{MANA, SIGIL, SPELL_NODES};
use crate::turn::{Action, Turn};

pub const REASON_CRUSH: u8 = 1;
pub const REASON_SPELL_CRUSH: u8 = 2;
pub const REASON_FILLS: u8 = 4;
pub const REASON_MANA: u8 = 8;
pub const REASON_DOOMED: u8 = 16;
pub const REASONS_ALL: u8 = 31;

/// How many first moves get a key-dash scan. The scan is per post-move board, so
/// this multiplies the whole cost; 4 covers the moves a search realistically plays.
pub const KEY_DASH_MOVES: usize = 4;
/// Sacrifice stones considered, cheapest first (doomed stones sort to the front).
const SAC_CANDS: usize = 5;
/// Sacrifice combinations tried per post-move board.
const SAC_COMBOS: usize = 3;
/// Key dashes kept per position after ranking.
pub const KEY_DASH_KEEP: usize = 4;

/// A dash may occupy one slot in every `KEY_DASH_EVERY` of the stream, so a search
/// with width >= 4 always sees one and never gives up more than a quarter of its
/// budget. The failed merge handed dashes up to two thirds of it.
pub const KEY_DASH_EVERY: usize = 4;



impl Board {
    /// Bounded escape check: our stone on `node` has nowhere to run.
    #[inline]
    fn is_doomed(&self, node: u8, c: Color) -> bool {
        self.escape_distance(node, c, 3) >= 3
    }

    /// Nodes whose sigil `c` would CHARGE by landing there — the single
    /// uncontrolled node of every sigil that is one stone short.
    fn fill_targets(&self, c: Color) -> u64 {
        let mut m = 0u64;
        for p in 0..9 {
            if self.uncontrolled_count(p, c) == 1 { m |= SIGIL[p] & !self.mine(c); }
        }
        m
    }

    /// Enemy stones a spell `c` has ALREADY CHARGED could hard-move onto, and so
    /// crush. Empty when no charged spell makes a hard move — the common case,
    /// which short-circuits the whole SPELL_CRUSH branch for free.
    ///
    /// Classified off the resolver, not the spell's sigil size, so Carnage's four
    /// hard moves and Tsunami's and Torrent's chains count alongside the one-node
    /// crushers. Soft-only resolvers (Flourish, Grow, Sprout) never crush, and the
    /// direct-destruction spells (Fireblast, Hail Storm, Decay, Hurricane, Corrupt,
    /// Storm Front) kill without needing the stone sealed, so neither belongs here.
    fn spell_crush_reach(&self, c: Color) -> u64 {
        let theirs = self.theirs(c);
        if theirs == 0 { return 0; }
        let mut m = 0u64;
        for id in self.castable(c, true, true, true) {
            if id as usize >= NUM_OFFICIAL_SPELLS { continue; }
            m |= match SPELLS[id as usize].resolve {
                // Free hard moves: Carnage, Slash, Tsunami, Torrent, Surge, Splash,
                // Fury. Any sealed stone is adjacent to us by definition, so
                // `hard_moveable` already covers a multi-step chain's reach.
                Resolve::HardMoves | Resolve::SoftHardChain | Resolve::SurgeMove
                | Resolve::Fury => self.hard_moveable(c),
                Resolve::RestrictedMove => self.lurk_targets(c) & theirs,
                Resolve::Meteor | Resolve::Comet => self.blinkable(c) & theirs,
                Resolve::Azimuth => {
                    let mut t = 0u64;
                    for p in 0..9 {
                        if self.uncontrolled_count(p, c) == 1 { t |= SIGIL[p] & !self.mine(c); }
                    }
                    t & theirs
                }
                // Sigil-restricted steppers: Charge, Erupt, Eclipse, Syzygy.
                Resolve::Charge | Resolve::Erupt | Resolve::Eclipse | Resolve::Syzygy =>
                    self.hard_moveable(c) & SPELL_NODES,
                _ => 0,
            };
        }
        m
    }

    /// Enemy stones a charged spell could actually kill right now: inside that
    /// spell's reach, and with no escape.
    fn spell_crushable_now(&self, c: Color) -> u64 {
        let reach = self.spell_crush_reach(c);
        if reach == 0 { return 0; }
        let mut out = 0u64;
        let mut m = reach & self.theirs(c);
        while m != 0 {
            let e = m.trailing_zeros() as u8;
            m &= m - 1;
            if self.is_crushable(e, c) { out |= 1u64 << e; }
        }
        out
    }

    /// Key dash branches from a POST-MOVE board, best-first, at most `cap`.
    /// Returns the dash action, the board after it, and why it qualified.
    pub fn key_dash_branches(&self, c: Color, reasons: u8, cap: usize)
        -> Vec<(Turn, Board, u8)>
    {
        if cap == 0 || reasons == 0 { return Vec::new(); }
        if self.total[c.idx()] <= 2 { return Vec::new(); }
        let cost = self.dash_cost(c) as usize;

        let mut cands: Vec<u8> = Vec::new();
        let mut m = self.dash_sacrificeable(c);
        while m != 0 { cands.push(m.trailing_zeros() as u8); m &= m - 1; }
        if cands.len() < cost { return Vec::new(); }
        // Cheapest stones first, and a stone with no escape was lost anyway — that
        // discount is what surfaces the sacrifice-the-trapped-group resource.
        cands.sort_by_key(|&n| {
            self.sacrifice_cost(n, c) - if self.is_doomed(n, c) { 80 } else { 0 }
        });
        cands.truncate(SAC_CANDS.max(cost));

        let combos: Vec<Vec<u8>> = if cost == 1 {
            cands.iter().take(SAC_COMBOS).map(|&s| vec![s]).collect()
        } else {
            let mut v = Vec::new();
            'outer: for i in 0..cands.len() {
                for j in (i + 1)..cands.len() {
                    v.push(vec![cands[i], cands[j]]);
                    if v.len() >= SAC_COMBOS { break 'outer; }
                }
            }
            v
        };

        // Supersets computed once, before any sacrifice — see the monotonicity
        // note in the module docs. Both shrink under sacrifice, never grow.
        let crush_super: u64 = {
            let mut out = 0u64;
            let mut m = self.hard_moveable(c);
            while m != 0 {
                let e = m.trailing_zeros() as u8;
                m &= m - 1;
                if self.is_crushable(e, c) { out |= 1u64 << e; }
            }
            out
        };
        // Superset only: sacrificing can BREAK a charged sigil, so the charged set
        // here covers the post-dash one. The reverse gap — the dash's own stone
        // charging a NEW spell — is already caught by REASON_FILLS.
        let crush_reach = if reasons & REASON_SPELL_CRUSH != 0 {
            self.spell_crush_reach(c)
        } else { 0 };
        // Landing next to an enemy stone that is already nearly sealed is what can
        // newly complete a spell kill; confirmed exactly below.
        let spell_super: u64 = if crush_reach == 0 { 0 } else {
            let mut nearly = 0u64;
            let mut m = Board::dilate(self.all_moveable(c)) & self.theirs(c);
            while m != 0 {
                let e = m.trailing_zeros() as u8;
                m &= m - 1;
                if self.escape_distance(e, c.other(), 3) <= 3 { nearly |= 1u64 << e; }
            }
            Board::dilate(nearly)
        };

        let goal = self.placement_goal(c);
        // What this turn could already crush by casting WITHOUT dashing. A dash
        // only earns SPELL_CRUSH by beating this.
        let base_crushable = if crush_reach == 0 { 0 }
                             else { self.spell_crushable_now(c).count_ones() };
        let mut out: Vec<(i32, Turn, Board, u8)> = Vec::new();
        for combo in combos {
            let doomed = reasons & REASON_DOOMED != 0
                && combo.iter().all(|&s| self.is_doomed(s, c));
            let mut bd = *self;
            for &s in &combo { bd.stones[c.idx()] &= !(1u64 << s); }
            bd.update();
            if bd.outcome != Outcome::Ongoing { continue; }
            let moveable = bd.all_moveable(c);
            if moveable == 0 { continue; }

            let mut interesting = 0u64;
            if reasons & REASON_CRUSH != 0 { interesting |= crush_super; }
            if reasons & REASON_MANA != 0 { interesting |= MANA; }
            if reasons & REASON_FILLS != 0 { interesting |= bd.fill_targets(c); }
            interesting |= spell_super;
            // A dash that only spends doomed stones is worth a look wherever it
            // lands, but bound that to the moves ordering already likes.
            let mut targets = interesting & moveable;
            if doomed && targets == 0 {
                let mut best = bd.move_variants_pub(moveable, c);
                best.sort_by_key(|&(n, p)| -bd.move_score(n, p, c));
                best.truncate(1);
                for (n, _) in best { targets |= 1u64 << n; }
            }
            if targets == 0 { continue; }

            let sac_cost: i32 = combo.iter()
                .map(|&s| self.sacrifice_cost(s, c) - if self.is_doomed(s, c) { 80 } else { 0 })
                .sum();
            // Ascending node order, matching `enumerate_post_move`: the sacrifice
            // SET is what matters, but `Action::Dash` compares the array, and the
            // TT, killers and the emit gate all key off action equality.
            let mut ordered = combo.clone();
            ordered.sort_unstable();
            let mut sacs = [0u8; 2];
            for (i, &s) in ordered.iter().enumerate() { sacs[i] = s; }

            for (node, push_to) in bd.move_variants_pub(targets, c) {
                let bit = 1u64 << node;
                let hard = bd.theirs(c) & bit != 0;
                let mut why = 0u8;
                if reasons & REASON_CRUSH != 0 && hard && push_to.is_none() {
                    why |= REASON_CRUSH;
                }
                if reasons & REASON_MANA != 0 && MANA & bit != 0 { why |= REASON_MANA; }
                if reasons & REASON_FILLS != 0 {
                    for p in 0..9 {
                        if SIGIL[p] & bit != 0 && bd.uncontrolled_count(p, c) == 1 {
                            why |= REASON_FILLS;
                            break;
                        }
                    }
                }
                if doomed { why |= REASON_DOOMED; }

                let mut b2 = bd;
                b2.do_move_with_pub(node, push_to, c);
                if crush_reach != 0 && spell_super & bit != 0 && why & REASON_CRUSH == 0
                    && b2.spell_crushable_now(c).count_ones() > base_crushable {
                    why |= REASON_SPELL_CRUSH;
                }
                if why == 0 { continue; }
                if b2.outcome != Outcome::Ongoing && b2.total[c.idx()] == 0 { continue; }

                // Ordering only decides which key dash takes the reserved slot, so
                // this stays a cheap sum over the reasons it qualified.
                let mut score = bd.move_score(node, push_to, c) - sac_cost;
                if why & REASON_CRUSH != 0 { score += 200; }
                if why & REASON_SPELL_CRUSH != 0 { score += 160; }
                if why & REASON_FILLS != 0 { score += 120; }
                if why & REASON_MANA != 0 { score += 90; }
                if why & REASON_DOOMED != 0 { score += 60; }
                if hard { if let Some(d) = push_to { score += b2.destination_value(d, c, goal) / 4; } }

                out.push((score, Turn::single(Action::Dash {
                    sacs, n_sacs: combo.len() as u8, node, push_to,
                }), b2, why));
            }
        }
        out.sort_by(|a, b| b.0.cmp(&a.0));
        out.truncate(cap);
        out.into_iter().map(|(_, t, b, w)| (t, b, w)).collect()
    }
}
