//! SigilBench mate certificates.
//!
//!   cert_tool make  < requests   one per line: n \t after_sfn [\t budget \t time_ms [\t leaves]]
//!                                prints mate::cert_json per line
//!   cert_tool check < certs      one per line: n \t after_sfn (\t at_sfn \t to_sfn)*
//!                                (a certificate's `internal` entries; bench/tools/certs.py converts)
//!                                prints {"ok", "error"?, "and_nodes", "or_nodes", "turns", "hints_used", "seconds"}
//!
//! Both run the full browser rules (cast_enum::set_full_rules). `check` uses
//! sigil_engine::cert (no search) and the certificate's `internal` entries as
//! hints; leaves are re-found by exhaustive mate-in-1 scans.
use std::io::BufRead;

fn main() {
    sigil_engine::cast_enum::set_full_rules(true);
    let mode = std::env::args().nth(1).unwrap_or_default();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let line = line.trim();
        if line.is_empty() { continue; }
        match mode.as_str() {
            "make" => {
                let f: Vec<&str> = line.split('\t').collect();
                let n: u8 = f[0].parse().expect("n");
                let budget: u64 = f.get(2).map(|x| x.parse().expect("budget")).unwrap_or(20_000_000_000);
                let time_ms: u64 = f.get(3).map(|x| x.parse().expect("time")).unwrap_or(600_000);
                let leaves = f.get(4).map(|x| *x == "1").unwrap_or(false);
                println!("{}", sigil_engine::mate::cert_json(f[1], n, budget, time_ms, leaves));
            }
            "check" => {
                let t0 = std::time::Instant::now();
                let f: Vec<&str> = line.split('\t').collect();
                let n: u8 = f[0].parse().expect("n");
                let hints: Vec<(String, String)> = f[2..].chunks(2).map(|p| (p[0].to_string(), p[1].to_string())).collect();
                let r = sigil_engine::cert::check(f[1], n, &hints, 200_000_000_000);
                let secs = t0.elapsed().as_secs_f64();
                match r {
                    Ok(s) => println!("{{\"ok\":true,\"and_nodes\":{},\"or_nodes\":{},\"turns\":{},\"hints_used\":{},\"hints\":{},\"seconds\":{:.3}}}",
                                      s.and_nodes, s.or_nodes, s.turns, s.hints_used, hints.len(), secs),
                    Err(e) => println!("{{\"ok\":false,\"error\":{:?},\"seconds\":{:.3}}}", e, secs),
                }
            }
            _ => { eprintln!("usage: cert_tool make|check"); std::process::exit(2); }
        }
    }
}
