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
    /// Mover nodes whose full enumeration hit a cap, where the hinted turn was
    /// found in the engine's ordered generator instead: legal by that
    /// generator only (tools/check-mate-cert.js confirms these independently).
    pub ordered_legality: u64,
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
        let hint = self.hints.get(&kb).copied();
        let turns = match (self.turns(b, c), hint) {
            (Ok(t), _) => t,
            (Err(e), Some(target)) if e.starts_with("enumeration capped") => {
                // Too wide to enumerate: look for the hinted turn in the ordered generator.
                let found = b.turns_ordered(c).take(1 << 20).map(|t| after(b, &t, c)).find(|n| fkey(n) == target);
                match found {
                    Some(n) => { self.stats.ordered_legality += 1; return self.finish_or(b, k, kb, n); }
                    None => return Err(e),
                }
            }
            (Err(e), _) => return Err(e),
        };
        if let Some(target) = hint {
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

    fn finish_or(&mut self, b: &Board, k: u8, kb: FKey, n: Board) -> Result<(), String> {
        let c = self.mover;
        self.stats.hints_used += 1;
        self.used.insert(kb);
        if !wins(n.outcome, c) {
            if n.outcome != Outcome::Ongoing { return Err(format!("hinted turn loses at {}", b.to_sfn())); }
            if k <= 1 { return Err(format!("hinted turn does not mate with 1 turn left at {}", b.to_sfn())); }
            self.and(&n, k - 1)?;
        }
        self.or_ok.insert(kb, k);
        Ok(())
    }

    pub fn unused_hints(&self) -> usize { self.hints.len() - self.used.len() }
}

/// Check that the mover's turn producing `after_sfn` forces a win within `n`
/// mover turns (counting it), given hint pairs of SFNs.
pub fn check(after_sfn: &str, n: u8, hints: &[(String, String)], budget: u64) -> Result<CheckStats, String> {
    let mut a = Board::from_sfn(after_sfn)?;
    let mover = a.to_move.other();
    // The defender holding a charged Seal of Destruction loses at the start of
    // its turn (mate::child applies this to every child; an SFN does not).
    a.destruction_start_of_turn(a.to_move);
    let mut hs = Vec::new();
    for (x, y) in hints { hs.push((Board::from_sfn(x)?, Board::from_sfn(y)?)); }
    let mut ch = Checker::new(mover, &hs, budget);
    if n == 0 { return Err("n = 0".into()); }
    ch.and(&a, n - 1)?;
    Ok(ch.stats)
}

/// Check "the side to move at `sfn` has no forced win within `k`" (k = 1 or
/// 2). k = 1: no legal turn wins outright (full enumeration). k = 2: every
/// legal turn either ends the game (a mover win fails the check) or has its
/// hinted refuting reply in `refutations` (first-turn position -> reply
/// position), which must be legal and either win for the defender or leave the
/// mover no winning turn (full enumeration).
pub fn check_no_mate(sfn: &str, k: u8, refutations: &[(String, String)], budget: u64) -> Result<CheckStats, String> {
    let b = Board::from_sfn(sfn)?;
    let c = b.to_move;
    let mut ch = Checker::new(c, &[], budget);
    let no_m1 = |ch: &mut Checker, x: &Board| -> Result<bool, String> {
        let turns = ch.turns(x, c)?;
        Ok(!turns.iter().any(|t| wins(after(x, t, c).outcome, c)))
    };
    match k {
        1 => { if !no_m1(&mut ch, &b)? { return Err("a mate-in-1 exists".into()); } }
        2 => {
            let mut refs = HashMap::new();
            for (n, r) in refutations { refs.insert(fkey(&Board::from_sfn(n)?), fkey(&Board::from_sfn(r)?)); }
            let firsts = ch.succ(&b, c)?;
            for n in firsts {
                if wins(n.outcome, c) { return Err(format!("first turn wins outright: {}", n.to_sfn())); }
                if n.outcome != Outcome::Ongoing { continue; }
                let target = *refs.get(&fkey(&n)).ok_or_else(|| format!("no refutation for {}", n.to_sfn()))?;
                let rturns = ch.turns(&n, c.other())?;
                let r = rturns.iter().map(|t| after(&n, t, c.other())).find(|r| fkey(r) == target)
                    .ok_or_else(|| format!("refuting reply not legal after {}", n.to_sfn()))?;
                ch.stats.and_nodes += 1;
                if wins(r.outcome, c) { return Err(format!("refuting reply loses on the spot after {}", n.to_sfn())); }
                if r.outcome == Outcome::Ongoing && !no_m1(&mut ch, &r)? {
                    return Err(format!("mover mates after the refuting reply {}", r.to_sfn()));
                }
            }
        }
        _ => return Err("k must be 1 or 2".into()),
    }
    Ok(ch.stats)
}
