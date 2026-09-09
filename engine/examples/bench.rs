//! Fixed-depth, clockless bench over a positions file. Deterministic by construction:
//! no deadline is set, so the tree depends only on the position and the knobs, and
//! the per-position `(nodes, score, best)` hash is a byte-identical-tree gate for
//! node-rate work. Wall time is reported separately and is the thing being optimised.
//!
//!     cargo run --release --no-default-features --example bench -- \
//!         harness/positions_midgame.txt 5 [--tt 20] [--no-adaptive] [--scale 4] [--eval tfit]
//!
//! Prints one line per position and a footer with total nodes, total ms, us/node and
//! the combined hash. Two runs whose combined hash agree searched the SAME tree.
use sigil_engine::board::Board;
use sigil_engine::eval::weights_by_name;
use sigil_engine::search::{Search, DEFAULT_WIDTH_SCALE, SHIPPED_ADAPTIVE};
use std::time::Instant;

fn fnv(h: &mut u64, s: &str) {
    for b in s.bytes() {
        *h ^= b as u64;
        *h = h.wrapping_mul(0x100000001b3);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: bench POSITIONS_FILE DEPTH [--tt BITS] [--no-adaptive] [--scale N] [--eval NAME]");
        std::process::exit(2);
    }
    let path = &args[1];
    let depth: i32 = args[2].parse().expect("depth");
    let mut tt_bits = 20u32;
    let mut adaptive = true;
    let mut scale = DEFAULT_WIDTH_SCALE;
    let mut eval = "tfit".to_string();
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--tt" => { tt_bits = args[i + 1].parse().unwrap(); i += 2; }
            "--no-adaptive" => { adaptive = false; i += 1; }
            "--scale" => { scale = args[i + 1].parse().unwrap(); i += 2; }
            "--eval" => { eval = args[i + 1].clone(); i += 2; }
            a => { eprintln!("unknown arg {a}"); std::process::exit(2); }
        }
    }
    let text = std::fs::read_to_string(path).expect("positions file");
    let mut total_nodes = 0u64;
    let mut total_ms = 0.0f64;
    let mut combined = 0xcbf29ce484222325u64;
    let mut n = 0;
    for (li, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let b = match Board::from_sfn(line) {
            Ok(b) => b,
            Err(e) => { eprintln!("line {}: bad SFN: {e}", li + 1); continue; }
        };
        let c = b.to_move;
        let mut s = Search::new(tt_bits);
        s.set_width_scale(scale);
        s.weights = weights_by_name(&eval).expect("eval name");
        if adaptive {
            let (p, e, h) = SHIPPED_ADAPTIVE;
            s.set_adaptive(p, e, h);
        }
        let t0 = Instant::now();
        let (best, score, st) = s.go(&b, c, depth, 0);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let best_s = match best { Some(t) => format!("{:?}", t.slice()), None => "none".into() };
        let mut h = 0xcbf29ce484222325u64;
        fnv(&mut h, &format!("{}|{}|{}", st.nodes, score, best_s));
        fnv(&mut combined, &format!("{h:016x}"));
        println!("{:3} nodes {:9} score {:7} depth {} ms {:8.1} us/node {:6.2} hash {:016x}",
                 n, st.nodes, score, st.depth_completed, ms,
                 if st.nodes > 0 { ms * 1000.0 / st.nodes as f64 } else { 0.0 }, h);
        total_nodes += st.nodes;
        total_ms += ms;
        n += 1;
    }
    println!("TOTAL positions {} depth {} nodes {} ms {:.0} us/node {:.3} HASH {:016x}",
             n, depth, total_nodes, total_ms,
             if total_nodes > 0 { total_ms * 1000.0 / total_nodes as f64 } else { 0.0 }, combined);
}
