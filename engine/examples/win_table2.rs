//! SigilBench v3 winning-turn puzzles: the two-stage COMPLETE root table.
//!
//!   win_table2 < requests
//!   one request per line, tab-separated:
//!     sfn  screen_depth  screen_ms  deep_depths(csv)  deep_ms  evals(csv)  margin  min_top  sample  threads  [screen_keep]
//!   `screen_keep` (default all): how many screen entries to print, best first
//!   (a wide position has tens of thousands; mining keeps the top few).
//!   `alt_ideas` (default 3): the best-screened child of each of the next this
//!   many IDEAS after the best child's (an idea = the placement nodes of the
//!   regular move, dash moves and Providence plus the spells cast;
//!   bench/tools/win_puzzle.py solution_signature) joins the deep set, so the
//!   strongest other solutions are always searched deeply and can be played
//!   out, even when they fall outside the margin.
//!   `max_children` (default no limit): a position with more distinct children
//!   is reported as skipped without searching (mining keeps its cost bounded).
//!
//! Stage 1 (screen): every distinct position the mover can reach (full browser
//! rules) is searched once, from the opponent's side, with the shipped eval at
//! `screen_depth`. Stage 2 (deep): every child whose screen score is within
//! `margin` stones of the best (at least the `min_top` best) is searched with
//! each named evaluator at each depth in `deep_depths`, plus `sample` children
//! drawn at random from the rest, searched with the shipped eval at the first
//! deep depth only: the miss-rate check for the screen (a child the screen
//! ranked low that turns out to be good at depth).
//!
//! Output, one JSON line per request:
//!   {"sfn", "turns", "children", "best_screen", "screen": [[after, stones_or_null, over]...],
//!    "deep": [{"after", "actions", "screen", "sample", "evals": {name: {depth: {...}}}}],
//!    "seconds": {"enumerate", "screen", "deep"}}
//! Every score is from the MOVER's side (positive = good for the mover). A child
//! that ends the game scores +99 / -99 and is never searched.
//! bench/tools/win_puzzle.py turns this into calibrated win chances and verdicts.
use sigil_engine::board::{Board, Color, Outcome};
use sigil_engine::turn::Turn;
use std::collections::HashSet;
use std::io::BufRead;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Clone)]
struct Ev { depth: i32, stones: f64, mate: Option<i64>, proven: bool, secs: f64 }

fn search(n: &Board, mover: Color, eval: &str, depth: i32, ms: u64, tt_bits: u32) -> Option<Ev> {
    let t0 = std::time::Instant::now();
    let mut s = sigil_engine::search::Search::new(tt_bits);
    s.weights = sigil_engine::eval::weights_by_name(eval).expect("eval");
    s.set_width_scale(sigil_engine::search::DEFAULT_WIDTH_SCALE);
    let (p, e, h) = sigil_engine::search::SHIPPED_ADAPTIVE;
    s.set_adaptive(p, e, h);
    s.set_exact_clock(false);
    s.set_elastic(None);
    let (_, score, st) = s.go(n, mover.other(), depth, ms);
    if st.depth_completed <= 0 { return None; }
    let r = sigil_engine::search::report(score, &st, mover.other(), &s.weights);
    // report() is from the side to move (the opponent): negate for the mover.
    Some(Ev { depth: st.depth_completed, stones: -r.stones, mate: r.mate_in.map(|m| -(m as i64)),
              proven: r.proven, secs: t0.elapsed().as_secs_f64() })
}

/// One solution idea (bench/tools/win_puzzle.py solution_signature): the set
/// of nodes the regular move, any dash's move and any Providence placement
/// land on, and the spells cast. Moves after a cast are its resolution.
fn idea_signature(acts: &[sigil_engine::actions::JsAct]) -> (Vec<u8>, Vec<&'static str>) {
    let (mut places, mut spells, mut mode) = (Vec::new(), Vec::new(), 0u8);   // 0 move, 1 dash, 2 post, 3 resolve
    for a in acts {
        match a.t {
            "pass" => {}
            "cast" => { if let Some(sp) = a.spell { spells.push(sp); } mode = 3; }
            "dash" | "dash_lightning" => { mode = 1; }
            "move" | "hard_move" | "blink" => {
                if a.providence { if let Some(n) = a.node { places.push(n); } }
                else if mode <= 1 { if let Some(n) = a.node { places.push(n); } mode = 2; }
            }
            _ => {}
        }
    }
    places.sort();
    spells.sort();
    (places, spells)
}

fn ev_json(e: &Option<Ev>) -> String {
    match e {
        None => "null".into(),
        Some(e) => format!("{{\"depth\":{},\"stones\":{:.4},\"mate\":{},\"proven\":{},\"secs\":{:.2}}}", e.depth, e.stones,
                           e.mate.map(|m| m.to_string()).unwrap_or("null".into()), e.proven, e.secs),
    }
}

/// Run `n` jobs on `threads` workers; job i's result lands in slot i.
fn par<T: Send, F: Fn(usize) -> T + Sync>(n: usize, threads: usize, f: F) -> Vec<T> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<T>>> = Mutex::new((0..n).map(|_| None).collect());
    std::thread::scope(|sc| {
        for _ in 0..threads.max(1).min(n.max(1)) {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= n { break; }
                let r = f(i);
                out.lock().unwrap()[i] = Some(r);
            });
        }
    });
    out.into_inner().unwrap().into_iter().map(|x| x.expect("job result")).collect()
}

fn main() {
    sigil_engine::cast_enum::set_full_rules(true);
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.trim().split('\t').collect();
        if f.len() < 10 { continue; }
        let b = Board::from_sfn(f[0]).expect("sfn");
        let screen_depth: i32 = f[1].parse().expect("screen_depth");
        let screen_ms: u64 = f[2].parse().expect("screen_ms");
        let deep_depths: Vec<i32> = f[3].split(',').map(|x| x.parse().expect("depth")).collect();
        let deep_ms: u64 = f[4].parse().expect("deep_ms");
        let evals: Vec<String> = f[5].split(',').map(|x| x.to_string()).collect();
        let margin: f64 = f[6].parse().expect("margin");
        let min_top: usize = f[7].parse().expect("min_top");
        let sample: usize = f[8].parse().expect("sample");
        let threads: usize = f[9].parse().expect("threads");
        let screen_keep: usize = f.get(10).map(|x| x.parse().expect("screen_keep")).unwrap_or(usize::MAX);
        let alt_ideas: usize = f.get(11).map(|x| x.parse().expect("alt_ideas")).unwrap_or(3);
        let max_children: usize = f.get(12).map(|x| x.parse().expect("max_children")).unwrap_or(usize::MAX);
        let c = b.to_move;

        let t0 = std::time::Instant::now();
        let (turns, st) = b.enumerate_turns(c);
        let mut seen = HashSet::new();
        let mut kids: Vec<(Turn, Board)> = Vec::new();
        for t in &turns {
            let n = sigil_engine::mate::child(&b, t, c);
            if seen.insert(sigil_engine::mate::full_key(&n)) { kids.push((*t, n)); }
        }
        let t_enum = t0.elapsed().as_secs_f64();
        if kids.len() > max_children {
            // Too wide for a mining pass: say so, cheaply.
            println!("{{\"sfn\":{:?},\"turns\":{},\"children\":{},\"skipped\":\"more than {} children\",\"deep\":[],\"seconds\":{{\"enumerate\":{:.2},\"screen\":0,\"deep\":0}}}}",
                     f[0], turns.len(), kids.len(), max_children, t_enum);
            continue;
        }

        // Stage 1: screen every child with the shipped eval.
        let t1 = std::time::Instant::now();
        let shipped = sigil_engine::eval::SHIPPED_EVAL;
        let won = |n: &Board| match (n.outcome, c) {
            (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue) => Some(99.0),
            (Outcome::Ongoing, _) => None,
            _ => Some(-99.0),
        };
        let screen: Vec<Option<f64>> = par(kids.len(), threads, |i| {
            let n = &kids[i].1;
            if let Some(v) = won(n) { return Some(v); }
            search(n, c, shipped, screen_depth, screen_ms, 16).map(|e| match e.mate {
                Some(m) if m > 0 => 99.0, Some(_) => -99.0, None => e.stones })
        });
        let t_screen = t1.elapsed().as_secs_f64();
        let best = screen.iter().filter_map(|x| *x).fold(f64::NEG_INFINITY, f64::max);

        // The deep set: within `margin` of the best, at least `min_top` children.
        let mut order: Vec<usize> = (0..kids.len()).collect();
        order.sort_by(|&a, &bb| screen[bb].unwrap_or(-1e9).partial_cmp(&screen[a].unwrap_or(-1e9)).unwrap());
        let mut deep_set: Vec<usize> = order.iter().copied().enumerate()
            .filter(|&(rank, i)| rank < min_top || screen[i].map(|v| v >= best - margin).unwrap_or(false))
            .map(|(_, i)| i).collect();
        // The best child of each of the next `alt_ideas` ideas joins too.
        let sig_of = |i: usize| idea_signature(&b.emit_actions(&kids[i].0, c).0);
        if !order.is_empty() && alt_ideas > 0 {
            let mut seen_ideas = vec![sig_of(order[0])];
            for &i in &order {
                if won(&kids[i].1).is_some() { continue; }
                let sg = sig_of(i);
                if seen_ideas.contains(&sg) { continue; }
                seen_ideas.push(sg);
                if !deep_set.contains(&i) { deep_set.push(i); }
                if seen_ideas.len() > alt_ideas { break; }
            }
        }
        // Plus a reproducible random sample of the rest (the screen's miss-rate check).
        let in_deep: HashSet<usize> = deep_set.iter().copied().collect();
        let mut rest: Vec<usize> = (0..kids.len()).filter(|i| !in_deep.contains(i) && won(&kids[*i].1).is_none()).collect();
        let mut seed: u64 = sigil_engine::mate::full_key(&b).0 ^ 0x9E3779B97F4A7C15;
        let mut picked = Vec::new();
        while picked.len() < sample && !rest.is_empty() {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            let j = (seed % rest.len() as u64) as usize;
            picked.push(rest.swap_remove(j));
        }
        let n_deep = deep_set.len();
        deep_set.extend(picked.iter().copied());

        // Stage 2: deep searches, every (child, eval, depth) as one job; the
        // sample gets the shipped eval at the first deep depth only.
        let t2 = std::time::Instant::now();
        let mut jobs: Vec<(usize, usize, i32)> = Vec::new();   // (deep index, eval index, depth)
        for (di, &ci) in deep_set.iter().enumerate() {
            if won(&kids[ci].1).is_some() { continue; }
            if di < n_deep {
                for ei in 0..evals.len() { for &d in &deep_depths { jobs.push((di, ei, d)); } }
            } else {
                let ei = evals.iter().position(|e| e == shipped).unwrap_or(0);
                jobs.push((di, ei, deep_depths[0]));
            }
        }
        // Longest first, so the pool does not end on one depth-6 search.
        jobs.sort_by_key(|&(_, _, d)| -d);
        let res: Vec<Option<Ev>> = par(jobs.len(), threads, |j| {
            let (di, ei, d) = jobs[j];
            search(&kids[deep_set[di]].1, c, &evals[ei], d, deep_ms, 20)
        });
        let t_deep = t2.elapsed().as_secs_f64();

        let mut deep_json = Vec::new();
        for (di, &ci) in deep_set.iter().enumerate() {
            let (t, n) = &kids[ci];
            let (acts, _) = b.emit_actions(t, c);
            let mut per_eval = Vec::new();
            for (ei, name) in evals.iter().enumerate() {
                let mut per_d = Vec::new();
                for (j, &(dj, ej, d)) in jobs.iter().enumerate() {
                    if dj == di && ej == ei { per_d.push(format!("\"{}\":{}", d, ev_json(&res[j]))); }
                }
                if !per_d.is_empty() { per_eval.push(format!("{:?}:{{{}}}", name, per_d.join(","))); }
            }
            deep_json.push(format!("{{\"after\":{:?},\"actions\":{},\"screen\":{},\"over\":{},\"sample\":{},\"evals\":{{{}}}}}",
                n.to_sfn(), sigil_engine::actions::acts_to_json(&acts),
                screen[ci].map(|v| format!("{:.4}", v)).unwrap_or("null".into()),
                n.outcome != Outcome::Ongoing, di >= n_deep, per_eval.join(",")));
        }
        let screen_json: Vec<String> = order.iter().take(screen_keep).map(|&i| {
            let (n, s) = (&kids[i].1, &screen[i]);
            format!("[{:?},{},{}]", n.to_sfn(), s.map(|v| format!("{:.3}", v)).unwrap_or("null".into()),
                    n.outcome != Outcome::Ongoing) }).collect();
        println!("{{\"sfn\":{:?},\"turns\":{},\"truncated\":{},\"children\":{},\"best_screen\":{:.4},\"deep_count\":{},\"sample_count\":{},\"screen\":[{}],\"deep\":[{}],\"seconds\":{{\"enumerate\":{:.2},\"screen\":{:.2},\"deep\":{:.2}}}}}",
                 f[0], turns.len(), st.truncated || st.resolver_truncated, kids.len(), best, n_deep, picked.len(),
                 screen_json.join(","), deep_json.join(","), t_enum, t_screen, t_deep);
    }
}
