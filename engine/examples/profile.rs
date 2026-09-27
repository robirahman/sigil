//! Where the search spends its time: `bench`'s fixed-depth, clockless loop under
//! an in-process sampling profiler (pprof, SIGPROF at 997 Hz), printing the
//! functions with the most self and inclusive samples.
//!
//!     cargo run --release --no-default-features --features profile --example profile -- \
//!         harness/positions_midgame.txt 5 [top]
use sigil_engine::board::Board;
use sigil_engine::eval::weights_by_name;
use sigil_engine::search::{Search, SHIPPED_ADAPTIVE};
use std::collections::HashMap;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let depth: i32 = args[2].parse().expect("depth");
    let top: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(40);
    let text = std::fs::read_to_string(path).expect("positions file");
    let guard = pprof::ProfilerGuardBuilder::default().frequency(997).build().expect("profiler");
    let mut nodes = 0u64;
    let t0 = std::time::Instant::now();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Ok(b) = Board::from_sfn(line) else { continue };
        let mut s = Search::new(20);
        s.weights = weights_by_name("tfit").unwrap();
        let (p, e, h) = SHIPPED_ADAPTIVE;
        s.set_adaptive(p, e, h);
        let (_best, _score, st) = s.go(&b, b.to_move, depth, 0);
        nodes += st.nodes;
    }
    let secs = t0.elapsed().as_secs_f64();
    let report = guard.report().build().expect("report");
    let mut selfc: HashMap<String, usize> = HashMap::new();
    let mut incl: HashMap<String, usize> = HashMap::new();
    let mut total = 0usize;
    // Allocator samples attributed to the first engine frame above them.
    let mut alloc_parent: HashMap<String, usize> = HashMap::new();
    let is_alloc = |n: &str| n.contains("alloc") || n.contains("malloc") || n.contains("cfree")
        || n.contains("realloc") || n.contains("raw_vec") || n.contains("memcpy") || n.contains("copy_nonoverlapping")
        || n.starts_with("core::") || n.starts_with("<core::") || n.starts_with("<alloc::") || n.starts_with("_int_")
        || n.contains("hashbrown");
    for (frames, count) in report.data.iter() {
        let count = *count as usize;
        total += count;
        let names: Vec<String> = frames.frames.iter()
            .map(|f| f.first().map(|s| s.name()).unwrap_or_default()).collect();
        if let Some(n) = names.first() { *selfc.entry(n.clone()).or_default() += count; }
        if names.first().map_or(false, |n| is_alloc(n)) {
            if let Some(p) = names.iter().find(|n| !is_alloc(n)) {
                *alloc_parent.entry(p.clone()).or_default() += count;
            }
        }
        let mut seen = std::collections::HashSet::new();
        for n in names { if seen.insert(n.clone()) { *incl.entry(n).or_default() += count; } }
    }
    println!("{nodes} nodes in {secs:.1} s = {:.2} us/node; {total} samples", secs * 1e6 / nodes as f64);
    let short = |s: &str| -> String {
        let s = s.replace("sigil_engine::", "");
        if s.len() > 90 { s[..90].to_string() } else { s }
    };
    let mut v: Vec<_> = selfc.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    println!("--- self ---");
    for (n, c) in v.iter().take(top) { println!("{:5.1}%  {}", 100.0 * *c as f64 / total as f64, short(n)); }
    let mut v: Vec<_> = alloc_parent.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    println!("--- library/allocator time by engine caller ---");
    for (n, c) in v.iter().take(top) { println!("{:5.1}%  {}", 100.0 * *c as f64 / total as f64, short(n)); }
    let mut v: Vec<_> = incl.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    println!("--- inclusive ---");
    for (n, c) in v.iter().take(top) { println!("{:5.1}%  {}", 100.0 * *c as f64 / total as f64, short(n)); }
}
