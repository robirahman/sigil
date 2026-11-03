//! `mate::mate4_line_json` from the command line: the full "show solution"
//! line of a mate-in-4 puzzle from its proven first turn.
//!
//!     <budget>\t<time_ms>\t<probe>\t<sfn>\t<after-SFN of the first turn>
//!
//! one request per stdin line, one JSON line out. Cast resolution is
//! rules-complete, as in solve_mates.
//!
//!     cargo build --release --no-default-features --example mate4_lines
use std::io::{BufRead, Write};

fn main() {
    sigil_engine::cast_enum::set_full_rules(std::env::var("SIGIL_NARROW_RULES").is_err());
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() { continue; }
        let f: Vec<&str> = line.split('\t').collect();
        let out = if f.len() < 5 {
            "{\"ok\":false,\"error\":\"expected budget, time_ms, probe, sfn, after\"}".to_string()
        } else {
            sigil_engine::mate::mate4_line_json(f[3], f[4], f[0].parse().unwrap_or(4_000_000_000),
                                                f[1].parse().unwrap_or(120_000), f[2].parse().unwrap_or(64))
        };
        let mut h = stdout.lock();
        writeln!(h, "{}", out).unwrap();
        h.flush().unwrap();
    }
}
