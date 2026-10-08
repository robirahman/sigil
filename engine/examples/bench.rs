//! Fixed-depth, clockless bench over a positions file. Deterministic by construction:
//! no deadline is set, so the tree depends only on the position and the knobs, and
//! the per-position `(nodes, score, best)` hash is a byte-identical-tree gate for
//! node-rate work. Wall time is reported separately and is the thing being optimised.
//!
//!     cargo run --release --no-default-features --example bench -- \
//!         harness/positions_midgame.txt 5 [--tt 20] [--no-adaptive] [--scale 4] [--eval tfit] [--policy MIN_WIDTH]
//!         [--threads N] [--mode 0|1] [--ms BUDGET]   (Lazy SMP; --ms makes it timed, so not a hash gate)
//!         [--explore off|shipped|LIST] [--shipped]
//!
//! `--shipped` = the engine exactly as the site plays it: SHIPPED_EVAL, SHIPPED_POLICY and
//! (v28) SHIPPED_EXPLORE; later flags override. Its HASH is what
//! `node tools/policy-wasm-parity.js HASH DEPTH <SHIPPED_EVAL>` checks with the wasm defaults.
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
    let mut threads = 1usize;
    let mut ms_budget = 0u64;
    let mut smp_mode = 0u8;
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--tt" => { tt_bits = args[i + 1].parse().unwrap(); i += 2; }
            "--no-adaptive" => { adaptive = false; i += 1; }
            "--scale" => { scale = args[i + 1].parse().unwrap(); i += 2; }
            "--eval" => { eval = args[i + 1].clone(); i += 2; }
            "--pcost" => {
                // --pcost PENALTY FREE_WIDTH
                sigil_engine::policy::set_policy_cost(args[i + 1].parse().unwrap(), args[i + 2].parse().unwrap());
                i += 3;
            }
            "--policy" => {
                sigil_engine::policy::set_policy(true, args[i + 1].parse().unwrap());
                i += 2;
            }
            "--shipped" => {
                eval = sigil_engine::eval::SHIPPED_EVAL.to_string();
                let (on, w) = sigil_engine::policy::SHIPPED_POLICY;
                sigil_engine::policy::set_policy(on, w);
                sigil_engine::policy::set_policy_explore(sigil_engine::policy::SHIPPED_EXPLORE);
                i += 1;
            }
            "--explore" if args[i + 1] == "shipped" || args[i + 1] == "off" => {
                sigil_engine::policy::set_policy_explore(if args[i + 1] == "off" {
                    sigil_engine::policy::Explore::OFF } else { sigil_engine::policy::SHIPPED_EXPLORE });
                i += 2;
            }
            "--explore" => {
                // round 3 exploration tail: mode,cast_window,dash_limit,dash_per,dash_tried,base,step[,slot_first,slot_every]
                let v: Vec<i64> = args[i + 1].split(',').map(|x| x.parse().unwrap()).collect();
                let g = |k: usize| v.get(k).copied().unwrap_or(0);
                sigil_engine::policy::set_policy_explore(sigil_engine::policy::Explore {
                    mode: g(0) as u8, cast_window: g(1) as usize, dash_limit: g(2) as usize,
                    dash_per: g(3) as usize, dash_tried: g(4) as usize, base: g(5) as i32, step: g(6) as i32,
                    slot_first: g(7) as usize, slot_every: g(8) as usize });
                i += 2;
            }
            "--threads" => { threads = args[i + 1].parse().unwrap(); i += 2; }
            "--ms" => { ms_budget = args[i + 1].parse().unwrap(); i += 2; }
            "--mode" => { smp_mode = args[i + 1].parse().unwrap(); i += 2; }
            a => { eprintln!("unknown arg {a}"); std::process::exit(2); }
        }
    }
    let text = std::fs::read_to_string(path).expect("positions file");
    let mut total_nodes = 0u64;
    let mut total_smp = 0u64;
    let mut total_depth = 0i64;
    let mut helper_won = 0u32;
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
        s.set_threads(threads);
        s.set_smp_mode(smp_mode);
        if adaptive {
            let (p, e, h) = SHIPPED_ADAPTIVE;
            s.set_adaptive(p, e, h);
        }
        let t0 = Instant::now();
        let (best, score, st) = s.go(&b, c, depth, ms_budget);
        total_depth += st.depth_completed as i64;
        helper_won += st.smp_helper_won as u32;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let best_s = match best { Some(t) => format!("{:?}", t.slice()), None => "none".into() };
        let mut h = 0xcbf29ce484222325u64;
        fnv(&mut h, &format!("{}|{}|{}", st.nodes, score, best_s));
        fnv(&mut combined, &format!("{h:016x}"));
        println!("{:3} nodes {:9} score {:7} depth {} ms {:8.1} us/node {:6.2} hash {:016x}",
                 n, st.nodes, score, st.depth_completed, ms,
                 if st.nodes > 0 { ms * 1000.0 / st.nodes as f64 } else { 0.0 }, h);
        total_nodes += st.nodes;
        total_smp += st.smp_nodes.max(st.nodes);
        total_ms += ms;
        n += 1;
    }
    println!("TOTAL positions {} depth {} nodes {} ms {:.0} us/node {:.3} HASH {:016x}",
             n, depth, total_nodes, total_ms,
             if total_nodes > 0 { total_ms * 1000.0 / total_nodes as f64 } else { 0.0 }, combined);
    // Lazy SMP: the main thread's nodes are what the hash covers; all threads'
    // nodes per second is the throughput, and `ms` itself is the time to depth.
    println!("SMP threads {} all_nodes {} knps {:.0} mean_depth {:.2} helper_won {}", threads, total_smp,
             if total_ms > 0.0 { total_smp as f64 / total_ms } else { 0.0 },
             total_depth as f64 / n.max(1) as f64, helper_won);
}
