//! `mate::solve_json` from the command line, for mining puzzles on machines
//! without the Python extension (SigilBench dev set v2: mate-in-4).
//!
//!     <max_mate>\t<budget>\t<time_ms>\t<sfn>[\t<hint after-SFN>...]
//!
//! one request per stdin line, one JSON line out (prefixed by nothing). Cast
//! resolution is rules-complete (`cast_enum::set_full_rules`) unless
//! SIGIL_NARROW_RULES is set.
//!
//!     cargo build --release --no-default-features --example solve_mates
use std::io::{BufRead, Write};

fn main() {
    sigil_engine::cast_enum::set_full_rules(std::env::var("SIGIL_NARROW_RULES").is_err());
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() { continue; }
        let f: Vec<&str> = line.split('\t').collect();
        let out = if f.len() < 4 {
            "{\"ok\":false,\"error\":\"expected max_mate, budget, time_ms, sfn[, hints]\"}".to_string()
        } else {
            let max_mate: u8 = f[0].parse().unwrap_or(3);
            let budget: u64 = f[1].parse().unwrap_or(400_000_000);
            let time_ms: u64 = f[2].parse().unwrap_or(0);
            let hints: Vec<String> = f[4..].iter().map(|s| s.to_string()).collect();
            sigil_engine::mate::solve_json(f[3], budget, time_ms, &hints, max_mate)
        };
        let mut h = stdout.lock();
        writeln!(h, "{}", out).unwrap();
        h.flush().unwrap();
    }
}
