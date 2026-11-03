//! SigilBench v3 winning-turn puzzles: the COMPLETE root table. Every distinct
//! position the mover can reach (full browser rules) is searched to a fixed
//! depth with each named evaluator, from the opponent's side.
//!
//!   win_table < requests   one per line: sfn \t depth \t time_ms_per_child \t eval[,eval...]
//!   -> one JSON line: {"sfn", "turns", "children": [{"after", "actions", "over", "winner",
//!                      "evals": {name: {"depth", "stones", "mate", "proven"}}}], "seconds"}
//!   `stones` is from the MOVER's side (positive = good for the mover).
//!
//! bench/tools/win_table.py turns this into calibrated win chances.
use sigil_engine::board::{Board, Color, Outcome};
use std::collections::HashSet;
use std::io::BufRead;

fn main() {
    sigil_engine::cast_enum::set_full_rules(true);
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.trim().split('\t').collect();
        if f.len() < 4 { continue; }
        let t0 = std::time::Instant::now();
        let b = Board::from_sfn(f[0]).expect("sfn");
        let depth: i32 = f[1].parse().expect("depth");
        let ms: u64 = f[2].parse().expect("time");
        let evals: Vec<&str> = f[3].split(',').collect();
        let c = b.to_move;
        let (turns, st) = b.enumerate_turns(c);
        let mut seen = HashSet::new();
        let mut kids = Vec::new();
        for t in &turns {
            let n = sigil_engine::mate::child(&b, t, c);
            if !seen.insert(sigil_engine::mate::full_key(&n)) { continue; }
            let (acts, _) = b.emit_actions(t, c);
            let mut ev = Vec::new();
            if n.outcome == Outcome::Ongoing {
                for name in &evals {
                    let mut s = sigil_engine::search::Search::new(16);
                    s.weights = sigil_engine::eval::weights_by_name(name).expect("eval");
                    s.set_width_scale(sigil_engine::search::DEFAULT_WIDTH_SCALE);
                    let (p, e, h) = sigil_engine::search::SHIPPED_ADAPTIVE;
                    s.set_adaptive(p, e, h);
                    s.set_exact_clock(false);
                    s.set_elastic(None);
                    let (_, score, stt) = s.go(&n, c.other(), depth, ms);
                    if stt.depth_completed > 0 {
                        let r = sigil_engine::search::report(score, &stt, c.other(), &s.weights);
                        // report() is from the side to move (the opponent): negate for the mover.
                        ev.push(format!("{:?}:{{\"depth\":{},\"stones\":{:.4},\"mate\":{},\"proven\":{}}}", name,
                                        stt.depth_completed, -r.stones,
                                        r.mate_in.map(|m| (-(m as i64)).to_string()).unwrap_or("null".into()), r.proven));
                    } else {
                        ev.push(format!("{:?}:null", name));
                    }
                }
            }
            let winner = match n.outcome { Outcome::RedWins => "\"red\"", Outcome::BlueWins => "\"blue\"", _ => "null" };
            kids.push(format!("{{\"after\":{:?},\"actions\":{},\"over\":{},\"winner\":{},\"evals\":{{{}}}}}",
                              n.to_sfn(), sigil_engine::actions::acts_to_json(&acts), n.outcome != Outcome::Ongoing,
                              winner, ev.join(",")));
        }
        let _ = Color::Red;
        println!("{{\"sfn\":{:?},\"turns\":{},\"truncated\":{},\"children\":[{}],\"seconds\":{:.3}}}",
                 f[0], turns.len(), st.truncated || st.resolver_truncated, kids.join(","), t0.elapsed().as_secs_f64());
    }
}
