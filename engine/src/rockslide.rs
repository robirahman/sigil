//! Rock Slide (Tectonic): every enemy stone bordering the caster is pushed into
//! an adjacent node, and all pushes resolve at once. Port of `simboard.py`'s
//! `rock_slide_sources` / `resolve_rock_slide` / `rock_slide_optimal_pushes`
//! (mirrored by `constants.js`), including Bulwark: shielded stones are never
//! pushed, and a stone pushed onto one dies as if pushed into a wall.
//!
//! Resolution rules (simultaneous):
//!   * a node whose stone is pushed away counts as vacated, so chains slide and
//!     closed loops of 3+ rotate;
//!   * a stationary stone on a destination is destroyed;
//!   * two or more stones pushed into the same node all die;
//!   * a swap (two stones pushed onto each other's nodes) kills both;
//!   * a stone pushed into a wall, or onto a shielded stone, dies and the
//!     wall / shielded stone stays.
//!
//! The search only ever sees the MAXIMUM-net outcomes (enemy stones destroyed
//! minus own), one per distinct resolved board -- the same set the JS and
//! Python enumerators offer. The solver is the exact frontier DP of the
//! Python reference: sources split into independent interaction components,
//! each solved by dynamic programming with an exact tie walk.

use std::collections::HashMap;
use crate::board::{Board, Color};
use crate::topology::{ADJ, N};

const NONE: u8 = u8::MAX;

/// One push: the stone on `from` goes to `to`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Push { pub from: u8, pub to: u8 }

fn adj_list(n: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity(3);
    let mut m = ADJ[n as usize];
    while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
    v
}

impl Board {
    /// Rock Slide's pushed set: every unshielded enemy stone touching a `c`
    /// stone. Fixed at cast time; every one must be pushed.
    pub fn rock_slide_sources(&self, c: Color) -> u64 {
        Board::dilate(self.mine(c)) & self.theirs(c) & !self.shielded()
    }

    /// Resolve `pushes` simultaneously on this board (mutating). `shield` is the
    /// set of Bulwark-shielded nodes read when the spell was cast. Returns the
    /// destroyed nodes (deduplicated, in first-death order) and, per color, the
    /// number of stones lost.
    pub fn apply_rock_slide(&mut self, pushes: &[Push], shield: u64) -> (Vec<u8>, [u32; 2]) {
        let color_at = |b: &Board, n: u8| -> Option<usize> {
            let bit = 1u64 << n;
            if b.stones[0] & bit != 0 { Some(0) } else if b.stones[1] & bit != 0 { Some(1) } else { None }
        };
        let before = *self;
        let mut dest_of = [NONE; N];
        let mut arrivals: Vec<(u8, Vec<u8>)> = Vec::new();
        for p in pushes {
            dest_of[p.from as usize] = p.to;
            match arrivals.iter_mut().find(|(d, _)| *d == p.to) {
                Some((_, v)) => v.push(p.from),
                None => arrivals.push((p.to, vec![p.from])),
            }
        }
        // Every source is vacated first; arrivals then land or die.
        for p in pushes {
            let bit = 1u64 << p.from;
            self.stones[0] &= !bit;
            self.stones[1] &= !bit;
        }
        let mut lost_nodes: Vec<u8> = Vec::new();
        let mut lost = [0u32; 2];
        for (dest, srcs) in &arrivals {
            let d = *dest;
            let dbit = 1u64 << d;
            let occ = color_at(&before, d);
            let is_src = dest_of[d as usize] != NONE;
            let shielded = shield & dbit != 0 && !is_src;
            if !is_src && !shielded {
                if let Some(oc) = occ {
                    lost[oc] += 1;
                    if !lost_nodes.contains(&d) { lost_nodes.push(d); }
                    self.stones[oc] &= !dbit;
                }
            }
            let wall = before.walls & dbit != 0;
            if wall || shielded || srcs.len() >= 2 || dest_of[d as usize] == srcs[0] {
                for &s in srcs {
                    if let Some(sc) = color_at(&before, s) { lost[sc] += 1; }
                    if !lost_nodes.contains(&d) { lost_nodes.push(d); }
                }
            } else if let Some(sc) = color_at(&before, srcs[0]) {
                self.stones[sc] |= dbit;
            }
        }
        self.update();
        (lost_nodes, lost)
    }

    /// Every Rock Slide push set with the maximum net gain for `c` (enemy stones
    /// destroyed minus own), one per distinct resolved board, at most `limit`.
    /// Returns (best_net, options); option 0 is the greedy pick.
    pub fn rock_slide_optimal_pushes(&self, c: Color, limit: usize) -> (i32, Vec<Vec<Push>>) {
        let shield = self.shielded();
        let src_mask = self.rock_slide_sources(c);
        let mut sources: Vec<u8> = Vec::new();
        let mut m = src_mask;
        while m != 0 { sources.push(m.trailing_zeros() as u8); m &= m - 1; }
        if sources.is_empty() { return (0, vec![Vec::new()]); }
        let opts: HashMap<u8, Vec<u8>> = sources.iter().map(|&s| (s, adj_list(s))).collect();

        // Union-find over sources sharing a destination or able to swap.
        let mut parent: HashMap<u8, u8> = sources.iter().map(|&s| (s, s)).collect();
        fn find(p: &mut HashMap<u8, u8>, x: u8) -> u8 {
            let mut x = x;
            while p[&x] != x { let gp = p[&p[&x]]; p.insert(x, gp); x = gp; }
            x
        }
        let mut by_dest: Vec<(u8, Vec<u8>)> = Vec::new();
        for &s in &sources {
            for &d in &opts[&s] {
                match by_dest.iter_mut().find(|(x, _)| *x == d) {
                    Some((_, v)) => v.push(s),
                    None => by_dest.push((d, vec![s])),
                }
            }
        }
        for (_, ss) in &by_dest {
            for &t in &ss[1..] {
                let (ra, rb) = (find(&mut parent, ss[0]), find(&mut parent, t));
                if ra != rb { parent.insert(rb, ra); }
            }
        }
        for &s in &sources {
            for &d in &opts[&s] {
                if src_mask & (1u64 << d) != 0 && opts[&d].contains(&s) {
                    let (ra, rb) = (find(&mut parent, s), find(&mut parent, d));
                    if ra != rb { parent.insert(rb, ra); }
                }
            }
        }
        let mut comps: Vec<Vec<u8>> = Vec::new();
        let mut index: HashMap<u8, usize> = HashMap::new();
        for &s in &sources {
            let r = find(&mut parent, s);
            let i = *index.entry(r).or_insert_with(|| { comps.push(Vec::new()); comps.len() - 1 });
            comps[i].push(s);
        }
        let mut total = 0i32;
        let mut per_comp: Vec<Vec<HashMap<u8, u8>>> = Vec::new();
        for comp in &comps {
            let (net, assigns) = self.rock_slide_component(c, comp, &opts, src_mask, shield, limit);
            total += net;
            per_comp.push(assigns);
        }
        // Lazy product over components, last component fastest.
        let mut out: Vec<Vec<Push>> = Vec::new();
        if per_comp.iter().any(|v| v.is_empty()) { return (total, out); }
        let mut idx = vec![0usize; per_comp.len()];
        loop {
            let mut merged: HashMap<u8, u8> = HashMap::new();
            for (i, v) in per_comp.iter().enumerate() {
                for (&k, &d) in &v[idx[i]] { merged.insert(k, d); }
            }
            out.push(sources.iter().map(|&s| Push { from: s, to: merged[&s] }).collect());
            if out.len() >= limit { break; }
            let mut k = idx.len() as isize - 1;
            while k >= 0 {
                idx[k as usize] += 1;
                if idx[k as usize] == per_comp[k as usize].len() { idx[k as usize] = 0; k -= 1; }
                else { break; }
            }
            if k < 0 { break; }
        }
        (total, out)
    }

    fn rock_slide_component(&self, c: Color, comp: &[u8], opts: &HashMap<u8, Vec<u8>>,
                            src_mask: u64, shield: u64, limit: usize)
        -> (i32, Vec<HashMap<u8, u8>>)
    {
        #[derive(Clone, Copy, PartialEq, Eq)]
        enum Kind { Mover, Wall, Shield, Enemy, Own, Empty }
        let enemy = c.other().idx();
        let me = c.idx();
        let mut kind: HashMap<u8, Kind> = HashMap::new();
        for &src in comp {
            for &d in opts[&src].iter().chain(std::iter::once(&src)) {
                let bit = 1u64 << d;
                let k = if src_mask & bit != 0 { Kind::Mover }
                    else if self.walls & bit != 0 { Kind::Wall }
                    else if shield & bit != 0 { Kind::Shield }
                    else if self.stones[enemy] & bit != 0 { Kind::Enemy }
                    else if self.stones[me] & bit != 0 { Kind::Own }
                    else { Kind::Empty };
                kind.insert(d, k);
            }
        }
        let in_comp: Vec<u8> = comp.to_vec();
        // Variable order: BFS over interacting sources, seeded in node order.
        let touches = |s: u8| -> u64 {
            let mut t = 1u64 << s;
            for &d in &opts[&s] { t |= 1u64 << d; }
            t
        };
        let mut seq: Vec<u8> = Vec::new();
        let mut seen: Vec<u8> = Vec::new();
        for &root in comp {
            if seen.contains(&root) { continue; }
            seen.push(root);
            let mut queue = std::collections::VecDeque::from(vec![root]);
            while let Some(cur) = queue.pop_front() {
                seq.push(cur);
                for &nb in comp {
                    if !seen.contains(&nb) && touches(cur) & touches(nb) != 0 {
                        seen.push(nb);
                        queue.push_back(nb);
                    }
                }
            }
        }
        // close_at[d]: index of the last source whose choice can affect d.
        let mut close_at: HashMap<u8, usize> = HashMap::new();
        for (i, &src) in seq.iter().enumerate() {
            for &d in &opts[&src] { close_at.insert(d, i); }
            let v = close_at.get(&src).copied().unwrap_or(i).max(i);
            close_at.insert(src, v);
        }
        let mut closing: Vec<Vec<u8>> = vec![Vec::new(); seq.len()];
        for (&d, &i) in &close_at {
            if kind[&d] == Kind::Mover && in_comp.contains(&d) { closing[i].push(d); }
        }
        for v in closing.iter_mut() { v.sort(); }

        // Frontier: node -> (count, arriver, dest-of-node-if-it-is-a-source).
        type Front = Vec<(u8, (u8, u8, u8))>;
        let step = |frontier: &Front, i: usize, d: u8| -> (i32, Front) {
            let src = seq[i];
            let mut f: Front = frontier.clone();
            let get = |f: &Front, n: u8| f.iter().find(|(k, _)| *k == n).map(|(_, v)| *v)
                .unwrap_or((0, NONE, NONE));
            let set = |f: &mut Front, n: u8, v: (u8, u8, u8)| {
                match f.iter_mut().find(|(k, _)| *k == n) {
                    Some(e) => e.1 = v,
                    None => f.push((n, v)),
                }
            };
            let kd = kind[&d];
            let mut gain: i32;
            if kd == Kind::Wall || kd == Kind::Shield {
                gain = 1;
            } else {
                let (cnt, _arr, dst) = get(&f, d);
                if cnt == 0 {
                    gain = match kd { Kind::Enemy => 1, Kind::Own => -1, _ => 0 };
                    set(&mut f, d, (1, src, dst));
                } else {
                    gain = if cnt == 1 { 2 } else { 1 };
                    set(&mut f, d, (2, NONE, dst));
                }
            }
            if close_at.contains_key(&src) && kind.get(&src) == Some(&Kind::Mover) {
                let (cnt, arr, _) = get(&f, src);
                set(&mut f, src, (cnt, arr, d));
            }
            for &node in &closing[i] {
                let (cnt, arr, dst) = get(&f, node);
                f.retain(|(k, _)| *k != node);
                if cnt == 1 && dst == arr { gain += 1; }   // swap: the lone arrival dies
            }
            f.retain(|(k, _)| close_at[k] > i);
            f.sort();
            (gain, f)
        };

        let mut memo: HashMap<(usize, Front), i32> = HashMap::new();
        fn dp(i: usize, key: &Front, seq: &[u8], opts: &HashMap<u8, Vec<u8>>,
              step: &dyn Fn(&Front, usize, u8) -> (i32, Front),
              memo: &mut HashMap<(usize, Front), i32>) -> i32 {
            if i == seq.len() { return 0; }
            if let Some(&v) = memo.get(&(i, key.clone())) { return v; }
            let mut best: Option<i32> = None;
            for &d in &opts[&seq[i]] {
                let (gain, nkey) = step(key, i, d);
                let val = gain + dp(i + 1, &nkey, seq, opts, step, memo);
                if best.map_or(true, |b| val > b) { best = Some(val); }
            }
            let b = best.unwrap_or(0);
            memo.insert((i, key.clone()), b);
            b
        }
        let best = dp(0, &Vec::new(), &seq, opts, &step, &mut memo);

        // Tie walk: every optimal assignment, one per distinct outcome.
        let mut dest: HashMap<u8, u8> = HashMap::new();
        let mut out: Vec<HashMap<u8, u8>> = Vec::new();
        let mut keys: Vec<Vec<(u8, u8)>> = Vec::new();
        let outcome_key = |dest: &HashMap<u8, u8>| -> Vec<(u8, u8)> {
            // value per touched node: 0 empty, 1 red, 2 blue, 3 wall
            let mut arrivals: Vec<(u8, Vec<u8>)> = Vec::new();
            for &s in &seq {
                let d = dest[&s];
                match arrivals.iter_mut().find(|(x, _)| *x == d) {
                    Some((_, v)) => v.push(s),
                    None => arrivals.push((d, vec![s])),
                }
            }
            let val_of = |b: &Board, n: u8| -> u8 {
                let bit = 1u64 << n;
                if b.stones[0] & bit != 0 { 1 } else if b.stones[1] & bit != 0 { 2 }
                else if b.walls & bit != 0 { 3 } else { 0 }
            };
            let mut vals: Vec<(u8, u8)> = kind.keys()
                .map(|&d| (d, if src_mask & (1u64 << d) != 0 { 0 } else { val_of(self, d) }))
                .collect();
            for (d, srcs) in &arrivals {
                let v = match kind[d] {
                    Kind::Wall => 3,
                    Kind::Shield => val_of(self, *d),
                    _ if srcs.len() >= 2 || (kind[d] == Kind::Mover && dest.get(d) == Some(&srcs[0])) => 0,
                    _ => (enemy + 1) as u8,
                };
                if let Some(e) = vals.iter_mut().find(|(n, _)| n == d) { e.1 = v; }
            }
            vals.sort();
            vals
        };
        fn walk(i: usize, key: &Front, acc: i32, best: i32, seq: &[u8],
                opts: &HashMap<u8, Vec<u8>>,
                step: &dyn Fn(&Front, usize, u8) -> (i32, Front),
                memo: &mut HashMap<(usize, Front), i32>,
                dest: &mut HashMap<u8, u8>, out: &mut Vec<HashMap<u8, u8>>,
                keys: &mut Vec<Vec<(u8, u8)>>,
                outcome_key: &dyn Fn(&HashMap<u8, u8>) -> Vec<(u8, u8)>, limit: usize) {
            if out.len() >= limit { return; }
            if i == seq.len() {
                let k = outcome_key(dest);
                if !keys.contains(&k) { keys.push(k); out.push(dest.clone()); }
                return;
            }
            for &d in &opts[&seq[i]] {
                let (gain, nkey) = step(key, i, d);
                if acc + gain + dp(i + 1, &nkey, seq, opts, step, memo) == best {
                    dest.insert(seq[i], d);
                    walk(i + 1, &nkey, acc + gain, best, seq, opts, step, memo, dest, out,
                         keys, outcome_key, limit);
                    dest.remove(&seq[i]);
                }
            }
        }
        walk(0, &Vec::new(), 0, best, &seq, opts, &step, &mut memo, &mut dest, &mut out,
             &mut keys, &outcome_key, limit);
        (best, out)
    }
}
