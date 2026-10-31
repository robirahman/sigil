//! SigilBench grader core (`bench/`). One request per stdin line, TAB-separated:
//!
//!     <n>\t<puzzle SFN, mover to move>\t<claimed after-SFN>
//!
//! `claimed` is the position the submitted action list produced when replayed
//! by the browser rules (bench/grader/apply.js). Prints one JSON line:
//!
//!     {"legal":true|false,"verdict":"mate"|"not_mate"|"unproven"|"illegal"|"error",
//!      "immediate":bool,"nodes":N,"seconds":S,"error":...}
//!
//! `legal` = some legal turn reaches exactly that position (stones, walls,
//! spell counters, locks, springlocks, Providence banks). The verdict is a
//! proof except "unproven" (see `mate::judge_turn`).
//!
//!     cargo build --release --no-default-features --example bench_grade
use sigil_engine::board::Board;
use sigil_engine::mate::{judge_turn, legal_successor, MateError, TurnVerdict};
use std::io::{BufRead, Write};

fn err(e: MateError) -> String {
    match e {
        MateError::Budget => "budget exceeded".into(),
        MateError::Incomplete(t, r) => format!("enumeration incomplete (turn cap {}, resolver cap {})", t, r),
    }
}

fn main() {
    // Grade under the full browser rules (see cast_enum::set_full_rules);
    // SIGIL_NARROW_RULES=1 restores the strength engine's enumeration.
    sigil_engine::cast_enum::set_full_rules(std::env::var("SIGIL_NARROW_RULES").is_err());
    let budget: u64 = std::env::var("BENCH_BUDGET").ok().and_then(|v| v.parse().ok()).unwrap_or(400_000_000);
    let time_ms: u64 = std::env::var("BENCH_TIME_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300_000);
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() { continue; }
        let t0 = std::time::Instant::now();
        let parts: Vec<&str> = line.split('\t').collect();
        let out = (|| -> String {
            if parts.len() != 3 { return "{\"verdict\":\"error\",\"error\":\"expected 3 tab-separated fields\"}".into(); }
            let n: u8 = match parts[0].trim().parse() { Ok(v) => v, Err(_) => return "{\"verdict\":\"error\",\"error\":\"bad n\"}".into() };
            let b = match Board::from_sfn(parts[1].trim()) { Ok(b) => b, Err(e) => return format!("{{\"verdict\":\"error\",\"error\":{:?}}}", format!("puzzle sfn: {}", e)) };
            let claimed = match Board::from_sfn(parts[2].trim()) {
                Ok(b) => b,
                Err(e) => return format!("{{\"legal\":false,\"verdict\":\"illegal\",\"error\":{:?}}}", format!("after sfn: {}", e)),
            };
            let after = match legal_successor(&b, &claimed, budget, time_ms) {
                Ok(Some(a)) => a,
                Ok(None) => return "{\"legal\":false,\"verdict\":\"illegal\"}".into(),
                Err(e) => return format!("{{\"verdict\":\"error\",\"error\":{:?}}}", err(e)),
            };
            let (r, st) = judge_turn(&after, b.to_move, n, budget, time_ms);
            let secs = t0.elapsed().as_secs_f64();
            match r {
                Ok(TurnVerdict::Mate { immediate }) => format!("{{\"legal\":true,\"verdict\":\"mate\",\"immediate\":{},\"nodes\":{},\"seconds\":{:.3}}}", immediate, st.nodes, secs),
                Ok(TurnVerdict::NotMate) => format!("{{\"legal\":true,\"verdict\":\"not_mate\",\"nodes\":{},\"seconds\":{:.3}}}", st.nodes, secs),
                Ok(TurnVerdict::Unproven) => format!("{{\"legal\":true,\"verdict\":\"unproven\",\"nodes\":{},\"seconds\":{:.3}}}", st.nodes, secs),
                Err(e) => format!("{{\"legal\":true,\"verdict\":\"error\",\"error\":{:?},\"nodes\":{},\"seconds\":{:.3}}}", err(e), st.nodes, secs),
            }
        })();
        let mut h = stdout.lock();
        writeln!(h, "{}", out).unwrap();
        h.flush().unwrap();
    }
}
