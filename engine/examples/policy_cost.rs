//! Generation cost of the learned-policy stream against the shipped stream:
//! time to pull the first `w` turns, per position, over a positions file.
//!
//!     cargo run --release --no-default-features --example policy_cost -- \
//!         harness/positions_midgame.txt [reps]
use sigil_engine::board::Board;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).expect("positions file");
    let reps: usize = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(20);
    let boards: Vec<Board> = text.lines().map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| Board::from_sfn(l).ok()).collect();
    {
        let (mut t0, mut t1, mut t2, mut steps) = (0f64, 0f64, 0f64, 0usize);
        for _ in 0..reps {
            for b in &boards {
                let c = b.to_move;
                let t = Instant::now();
                steps += b.ordered_first_steps_scored(c).len();
                t0 += t.elapsed().as_secs_f64();
                let t = Instant::now();
                let it = b.turns_policy(c, 16, 2);
                t1 += t.elapsed().as_secs_f64();
                drop(it);
                let t = Instant::now();
                let it = b.turns_ordered_keeps(c, 16, 0, 2);
                t2 += t.elapsed().as_secs_f64();
                drop(it);
            }
        }
        let n = (reps * boards.len()) as f64;
        let (mut a0, mut a1, mut a2) = (0f64, 0f64, 0f64);
        for _ in 0..reps {
            for b in &boards {
                let c = b.to_move;
                let mut bb = *b; bb.update();
                let t = Instant::now();
                let ri = sigil_engine::policy::root_info(&bb, c);
                a0 += t.elapsed().as_secs_f64();
                let sc = b.ordered_first_steps_scored(c);
                let t = Instant::now();
                let w = sigil_engine::policy::policy_weights();
                let mut acc = 0f32;
                for (r, (st, s)) in sc.iter().enumerate() {
                    let (fm, fp, _) = sigil_engine::policy::step_feats(&bb, c, st, *s, r, &ri);
                    acc += w.logit(&fm, &ri.z) + w.logit(&fp, &ri.z);
                }
                a1 += t.elapsed().as_secs_f64();
                let t = Instant::now();
                let steps: Vec<_> = sc.iter().map(|x| x.0).collect();
                let _f = sigil_engine::turn_iter::front_prepass_pub(b, &bb, c, &steps);
                a2 += t.elapsed().as_secs_f64();
                if acc == 12345.0 { println!(); }
            }
        }
        let n = (reps * boards.len()) as f64;
        println!("root_info {:.1} us, step feats+logits {:.1} us, prepass {:.1} us", a0 / n * 1e6, a1 / n * 1e6, a2 / n * 1e6);
        println!("first steps {:.1}/pos: scoring {:.1} us; policy root {:.1} us; stream ctor {:.1} us",
                 steps as f64 / n, t0 / n * 1e6, t1 / n * 1e6, t2 / n * 1e6);
    }
    for w in [12usize, 24, 40, 64, 96, 288] {
        let (mut ts, mut tp, mut exp) = (0f64, 0f64, 0usize);
        let mut sink = 0usize;
        for _ in 0..reps {
            for b in &boards {
                let c = b.to_move;
                let t = Instant::now();
                sink += b.turns_ordered_keeps(c, 16, 0, 2).take(w).count();
                ts += t.elapsed().as_secs_f64();
                let t = Instant::now();
                let pen: i32 = std::env::var("PEN").ok().map(|s| s.parse().unwrap()).unwrap_or(0);
                let mut it = b.turns_policy_pen(c, 16, 2, pen);
                sink += it.by_ref().take(w).count();
                tp += t.elapsed().as_secs_f64();
                exp += it.expanded;
            }
        }
        let n = (reps * boards.len()) as f64;
        println!("w{w:4}: stream {:7.1} us  policy {:7.1} us  ({:.1} expansions)  [{sink}]",
                 ts / n * 1e6, tp / n * 1e6, exp as f64 / n);
    }
}
