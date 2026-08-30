//! SFN (Sigil FEN) read/write, matching `notation.py::board_to_sfn` / `sfn_to_board`.
//!
//! Format:
//!   `<39 stone chars>/<spell1,..,spell9> <r|b> <turncounter> <rsc>:<bsc>
//!    <rlock>:<block> <rspring>:<bspring> <score> [variant] [pm:..] [ab:..] [sn:..]`
//!
//! Stone chars are `r` / `b` / `.` and — for Tectonic, which is out of scope — `x`
//! for a node destroyed by Fissure. Locks and springlocks are spell NAMES or `-`.
//! `score` is derived state (`tied` / `r1..r3` / `b1..b3`), so it is written but
//! ignored on read.
//!
//! The optional trailing `pm:` / `ab:` / `sn:` tokens carry Providence, Aftershock
//! and Ambush state. All three are deferred packs, so this reader REFUSES an SFN
//! that contains them rather than silently dropping state — a position we cannot
//! represent must not be mistaken for one we can.

use crate::board::{Board, Color, Variant, NO_SPELL};
use crate::spells_meta::{SPELLS, NUM_OFFICIAL_SPELLS};
use crate::topology::{N, NAMES};

fn spell_id(name: &str) -> Option<u8> {
    SPELLS.iter().position(|s| s.name == name).map(|i| i as u8)
}

fn spell_name(id: u8) -> &'static str {
    if (id as usize) < NUM_OFFICIAL_SPELLS { SPELLS[id as usize].name } else { "-" }
}

impl Board {
    pub fn to_sfn(&self) -> String {
        let mut stones = String::with_capacity(N);
        for i in 0..N {
            let bit = 1u64 << i;
            stones.push(if self.stones[0] & bit != 0 { 'r' }
                        else if self.stones[1] & bit != 0 { 'b' }
                        else { '.' });
        }
        let spells: Vec<&str> = self.spells.iter().map(|&id| spell_name(id)).collect();
        let turn = if self.to_move == Color::Red { 'r' } else { 'b' };
        let lock = |i: usize| if self.lock[i] == NO_SPELL { "-" } else { spell_name(self.lock[i]) };
        let spring = |i: usize| if self.springlock[i] == NO_SPELL { "-" }
                                else { spell_name(self.springlock[i]) };
        // Score mirrors update(): blue carries a +1 phantom counter token.
        let red = self.total[0] as i32;
        let blue = self.total[1] as i32 + 1;
        let score = if red == blue { "tied".to_string() }
            else if red > blue { format!("r{}", (red - blue).min(3)) }
            else { format!("b{}", (blue - red).min(3)) };
        let mut out = format!("{}/{} {} {} {}:{} {}:{} {}:{} {}",
            stones, spells.join(","), turn, self.turn_counter,
            self.spell_counter[0], self.spell_counter[1],
            lock(0), lock(1), spring(0), spring(1), score);
        let v = match self.variant {
            Variant::Standard => "",
            Variant::Competitive => "competitive",
            Variant::Deathmatch => "deathmatch",
            Variant::CompetitiveDeathmatch => "competitive_deathmatch",
        };
        if !v.is_empty() { out.push(' '); out.push_str(v); }
        out
    }

    pub fn from_sfn(s: &str) -> Result<Board, String> {
        let toks: Vec<&str> = s.split_whitespace().collect();
        if toks.len() < 7 {
            return Err(format!("SFN needs at least 7 tokens, got {}", toks.len()));
        }
        // Deferred-pack state must not be silently dropped.
        for t in &toks {
            if t.starts_with("pm:") { return Err("SFN carries Providence state (pm:), out of scope".into()); }
            if t.starts_with("ab:") { return Err("SFN carries Aftershock state (ab:), out of scope".into()); }
            if t.starts_with("sn:") { return Err("SFN carries Ambush state (sn:), out of scope".into()); }
        }
        let (stones_s, spells_s) = toks[0].split_once('/')
            .ok_or("first token must be <stones>/<spells>")?;
        if stones_s.chars().count() != N {
            return Err(format!("expected {} stone chars, got {}", N, stones_s.chars().count()));
        }
        let mut red = 0u64;
        let mut blue = 0u64;
        for (i, ch) in stones_s.chars().enumerate() {
            match ch {
                'r' => red |= 1u64 << i,
                'b' => blue |= 1u64 << i,
                '.' => {}
                'x' => return Err(format!("node {} destroyed by Fissure (Tectonic), out of scope",
                                          NAMES[i])),
                other => return Err(format!("bad stone char {:?} at {}", other, NAMES[i])),
            }
        }
        let names: Vec<&str> = spells_s.split(',').collect();
        if names.len() != 9 { return Err(format!("expected 9 spells, got {}", names.len())); }
        let mut spells = [NO_SPELL; 9];
        for (i, nm) in names.iter().enumerate() {
            spells[i] = spell_id(nm)
                .ok_or_else(|| format!("unknown or out-of-scope spell {:?}", nm))?;
        }
        let variant = match toks.get(7).copied().unwrap_or("standard") {
            "competitive" => Variant::Competitive,
            "deathmatch" => Variant::Deathmatch,
            "competitive_deathmatch" => Variant::CompetitiveDeathmatch,
            _ => Variant::Standard,
        };
        let mut b = Board::new(spells, variant);
        b.stones = [red, blue];
        b.to_move = if toks[1] == "b" { Color::Blue } else { Color::Red };
        b.turn_counter = toks[2].parse().map_err(|_| "bad turn counter")?;
        let (rsc, bsc) = toks[3].split_once(':').ok_or("bad spell counters")?;
        b.spell_counter = [rsc.parse().map_err(|_| "bad red counter")?,
                           bsc.parse().map_err(|_| "bad blue counter")?];
        let parse_lock = |t: &str| -> Result<u8, String> {
            if t == "-" { Ok(NO_SPELL) }
            else { spell_id(t).ok_or_else(|| format!("unknown lock spell {:?}", t)) }
        };
        let (rl, bl) = toks[4].split_once(':').ok_or("bad locks")?;
        b.lock = [parse_lock(rl)?, parse_lock(bl)?];
        let (rs, bs) = toks[5].split_once(':').ok_or("bad springlocks")?;
        b.springlock = [parse_lock(rs)?, parse_lock(bs)?];
        // toks[6] is `score`, which is derived; update() recomputes it.
        b.update();
        Ok(b)
    }
}
