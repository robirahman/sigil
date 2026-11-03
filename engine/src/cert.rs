//! Independent checker for SigilBench mate certificates (`mate::cert_json`).
//!
//! Deliberately small and separate from `mate.rs`: no search, no killers, no
//! memo of unproven results, no nominations. It trusts the certificate only as
//! a list of hints -- "at this position the mover plays to that one" -- and
//! verifies everything else itself:
//!
//! * at a defender node, EVERY legal reply is enumerated (full browser rules,
//!   `cast_enum::set_full_rules` must be on) and each one must lose on the spot
//!   or reach a verified mover node;
//! * at a mover node with k turns left, the hinted position must be a legal
//!   successor and either win outright or (k > 1) be a verified defender node
//!   with k-1; without a hint, some legal successor must win outright (an
//!   exhaustive mate-in-1 scan).
//!
//! An enumeration that hits a cap fails the check. The remaining shared
//! dependency is the enumerator itself, which tools/rules-diff.py tests against
//! the browser's interactive rules, and tools/check-mate-cert.js re-checks
//! certificates against directly.
use crate::board::{Board, Color, Outcome};
use crate::turn::Turn;
use std::collections::HashMap;

type FKey = (u64, u64, u64, [u8; 2], [u8; 2], [u8; 2], [u8; 2]);

fn fkey(b: &Board) -> FKey {
    (b.stones[0], b.stones[1], b.walls, b.spell_counter, b.lock, b.springlock, b.bank)
}

fn after(b: &Board, t: &Turn, c: Color) -> Board {
    let mut n = *b;
    n.apply_turn(t, c);
    n.turn_counter += 1;
    n.to_move = c.other();
    n
}

fn wins(o: Outcome, c: Color) -> bool {
    matches!((o, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue))
}

#[derive(Default, Debug, Clone, Copy)]
pub struct CheckStats {
    pub and_nodes: u64,
    pub or_nodes: u64,
    pub turns: u64,
    pub hints_used: u64,
}

pub struct Checker {
    mover: Color,
    hints: HashMap<FKey, FKey>,
    or_ok: HashMap<FKey, u8>,
    used: std::collections::HashSet<FKey>,
    pub stats: CheckStats,
    budget: u64,
}

impl Checker {
    /// `hints`: (mover-to-move position, position after the mover's turn).
    pub fn new(mover: Color, hints: &[(Board, Board)], budget: u64) -> Self {
        let mut h = HashMap::new();
        for (a, t) in hints { h.insert(fkey(a), fkey(t)); }
        Checker { mover, hints: h, or_ok: HashMap::new(), used: Default::default(), stats: CheckStats::default(), budget }
    }

    fn succ(&mut self, b: &Board, c: Color) -> Result<Vec<Board>, String> {
        let (turns, st) = b.enumerate_turns(c);
        if st.truncated || st.resolver_truncated { return Err(format!("enumeration capped at {}", b.to_sfn())); }
        self.stats.turns += turns.len() as u64;
        if self.stats.turns > self.budget { return Err("check budget exhausted".into()); }
        let mut seen = std::collections::HashSet::new();
        Ok(turns.iter().map(|t| after(b, t, c)).filter(|n| seen.insert((fkey(n), n.outcome as u8))).collect())
    }

    /// Defender to move at `b`; the mover must win within `j` more turns.
    pub fn and(&mut self, b: &Board, j: u8) -> Result<(), String> {
        let c = self.mover;
        if wins(b.outcome, c) { return Ok(()); }
        if b.outcome != Outcome::Ongoing { return Err(format!("game over, mover lost: {}", b.to_sfn())); }
        self.stats.and_nodes += 1;
        for r in self.succ(b, c.other())? {
            if wins(r.outcome, c) { continue; }
            if r.outcome != Outcome::Ongoing { return Err(format!("reply wins for the defender: {}", r.to_sfn())); }
            if j == 0 { return Err(format!("no turns left after reply {}", r.to_sfn())); }
            self.or(&r, j)?;
        }
        Ok(())
    }

    /// Every legal turn at `b` (capped enumeration fails the check).
    fn turns(&mut self, b: &Board, c: Color) -> Result<Vec<Turn>, String> {
        let (turns, st) = b.enumerate_turns(c);
        if st.truncated || st.resolver_truncated { return Err(format!("enumeration capped at {}", b.to_sfn())); }
        self.stats.turns += turns.len() as u64;
        if self.stats.turns > self.budget { return Err("check budget exhausted".into()); }
        Ok(turns)
    }

    /// Mover to move at `b` with `k` turns left. Turns are applied lazily: the
    /// scan stops at the hinted position (legal: it came from the full
    /// enumeration) or, without a hint, at the first outright win.
    pub fn or(&mut self, b: &Board, k: u8) -> Result<(), String> {
        let c = self.mover;
        let kb = fkey(b);
        if let Some(&kk) = self.or_ok.get(&kb) { if kk <= k { return Ok(()); } }
        self.stats.or_nodes += 1;
        let turns = self.turns(b, c)?;
        if let Some(target) = self.hints.get(&kb).copied() {
            let n = turns.iter().map(|t| after(b, t, c)).find(|n| fkey(n) == target)
                .ok_or_else(|| format!("hinted turn is not legal at {}", b.to_sfn()))?;
            self.stats.hints_used += 1;
            self.used.insert(kb);
            if !wins(n.outcome, c) {
                if n.outcome != Outcome::Ongoing { return Err(format!("hinted turn loses at {}", b.to_sfn())); }
                if k <= 1 { return Err(format!("hinted turn does not mate with 1 turn left at {}", b.to_sfn())); }
                self.and(&n, k - 1)?;
            }
        } else if !turns.iter().any(|t| wins(after(b, t, c).outcome, c)) {
            return Err(format!("no hint and no mate-in-1 at {}", b.to_sfn()));
        }
        self.or_ok.insert(kb, k);
        Ok(())
    }

    pub fn unused_hints(&self) -> usize { self.hints.len() - self.used.len() }
}

/// Check that the mover's turn producing `after_sfn` forces a win within `n`
/// mover turns (counting it), given hint pairs of SFNs.
pub fn check(after_sfn: &str, n: u8, hints: &[(String, String)], budget: u64) -> Result<CheckStats, String> {
    let a = Board::from_sfn(after_sfn)?;
    let mover = a.to_move.other();
    let mut hs = Vec::new();
    for (x, y) in hints { hs.push((Board::from_sfn(x)?, Board::from_sfn(y)?)); }
    let mut ch = Checker::new(mover, &hs, budget);
    if n == 0 { return Err("n = 0".into()); }
    ch.and(&a, n - 1)?;
    Ok(ch.stats)
}
