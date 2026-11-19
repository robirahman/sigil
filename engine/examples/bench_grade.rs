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
//! With BENCH_EXHAUSTIVE=1 the verdict is never "unproven" (it may be
//! "error": budget exceeded) -- see `mate::judge_turn_exhaustive`.
//!
//! `legal` = some legal turn reaches exactly that position (stones, walls,
//! spell counters, locks, springlocks, Providence banks). The verdict is a
//! proof except "unproven" (see `mate::judge_turn`).
//!
//! Winning-turn puzzles (SigilBench v3) use a second request form:
//!
//!     w\t<puzzle SFN>\t<claimed after-SFN>\t<depth>\t<eval name>
//!
//! which checks legality the same way and then searches the after-position to
//! exactly <depth> (no time limit; the shipped width and adaptive settings, the
//! same search bench/tools/win_puzzle.py's tables use) and prints, from the
//! MOVER's side, {"legal":true,"verdict":"eval","depth":D,"stones":S,"mate":M|null,"proven":bool}.
//! bench/sigilbench/grader.py turns that into a calibrated win chance.
//!
//!     cargo build --release --no-default-features --example bench_grade
use sigil_engine::board::Board;
use sigil_engine::mate::{judge_turn, judge_turn_exhaustive, legal_successor, MateError, TurnVerdict};
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
    // BENCH_EXHAUSTIVE=1: the resolver for answers left "unproven" -- every
    // inner mate-in-2 is decided exactly (mate::judge_turn_exhaustive).
    let exhaustive = std::env::var("BENCH_EXHAUSTIVE").map(|v| v == "1").unwrap_or(false);
    // Threads per exhaustive decision (default: all cores).
    let threads = std::env::var("BENCH_THREADS").ok().and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    sigil_engine::mate::set_resolve_threads(threads);
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() { continue; }
        let t0 = std::time::Instant::now();
        let parts: Vec<&str> = line.split('\t').collect();
        let out = (|| -> String {
            if parts.len() == 5 && parts[0].trim() == "w" { return eval_request(&parts, budget, time_ms); }
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
            let (r, st) = if exhaustive { judge_turn_exhaustive(&after, b.to_move, n, budget, time_ms) }
                          else { judge_turn(&after, b.to_move, n, budget, time_ms) };
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

/// `w` requests: legality, then a fixed-depth search of the after-position
/// from the mover's side (see the module comment).
fn eval_request(parts: &[&str], budget: u64, time_ms: u64) -> String {
    let b = match Board::from_sfn(parts[1].trim()) { Ok(b) => b, Err(e) => return format!("{{\"verdict\":\"error\",\"error\":{:?}}}", format!("puzzle sfn: {}", e)) };
    let claimed = match Board::from_sfn(parts[2].trim()) {
        Ok(b) => b,
        Err(e) => return format!("{{\"legal\":false,\"verdict\":\"illegal\",\"error\":{:?}}}", format!("after sfn: {}", e)),
    };
    let depth: i32 = match parts[3].trim().parse() { Ok(v) => v, Err(_) => return "{\"verdict\":\"error\",\"error\":\"bad depth\"}".into() };
    let weights = match sigil_engine::eval::weights_by_name(parts[4].trim()) {
        Ok(w) => w, Err(e) => return format!("{{\"verdict\":\"error\",\"error\":{:?}}}", format!("eval: {:?}", e)),
    };
    let after = match legal_successor(&b, &claimed, budget, time_ms) {
        Ok(Some(a)) => a,
        Ok(None) => return "{\"legal\":false,\"verdict\":\"illegal\"}".into(),
        Err(e) => return format!("{{\"verdict\":\"error\",\"error\":{:?}}}", err(e)),
    };
    let mover = b.to_move;
    match after.outcome {
        sigil_engine::board::Outcome::Ongoing => {}
        o => {
            let won = (o == sigil_engine::board::Outcome::RedWins) == (mover == sigil_engine::board::Color::Red);
            return format!("{{\"legal\":true,\"verdict\":\"eval\",\"over\":true,\"mover_wins\":{}}}", won);
        }
    }
    let mut s = sigil_engine::search::Search::new(20);
    s.weights = weights;
    s.set_width_scale(sigil_engine::search::DEFAULT_WIDTH_SCALE);
    let (p, e, h) = sigil_engine::search::SHIPPED_ADAPTIVE;
    s.set_adaptive(p, e, h);
    s.set_exact_clock(false);
    s.set_elastic(None);
    let (_, score, st) = s.go(&after, mover.other(), depth, 0);
    if st.depth_completed < depth {
        return format!("{{\"legal\":true,\"verdict\":\"error\",\"error\":\"depth {} not completed ({})\"}}", depth, st.depth_completed);
    }
    let r = sigil_engine::search::report(score, &st, mover.other(), &s.weights);
    format!("{{\"legal\":true,\"verdict\":\"eval\",\"depth\":{},\"stones\":{:.4},\"mate\":{},\"proven\":{}}}",
            st.depth_completed, -r.stones, r.mate_in.map(|m| (-(m as i64)).to_string()).unwrap_or("null".into()), r.proven)
}
