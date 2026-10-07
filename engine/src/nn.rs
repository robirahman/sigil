//! Step 5 of the 2026-10 plan: a small spell-conditioned network eval.
//!
//! A residual on top of a hand eval (`nnue_spell` = `tfit_spell` + this), in
//! centistones, clamped to +-`cap`. Trained and quantised by
//! `harness/nn_eval.py`, which documents the architecture and the integer
//! arithmetic this file reproduces bit for bit (pinned by
//! `nn_matches_the_python_reference` against vectors that script wrote).
//!
//! The 9-spell draw never changes during a game, so the spell conditioning is
//! folded into the first layer ONCE per draw:
//!
//! ```text
//!   row(node, rel) = base[node, rel] + E[spell on node's sigil, place, rel]
//!   game_bias[c]   = pov[c] + sum_p G[spell_p, p]
//! ```
//!
//! and a leaf costs one row add per occupied node, then two small hidden layers.
//! The fold is cached per thread, keyed by the draw, so it is rebuilt only when a
//! search moves to another game. Recomputing the accumulator at the leaf (rather
//! than updating it through make/unmake) keeps `Board` small: the move generator
//! copies boards constantly, and that copy is most of a node's cost.
//!
//! Integer-only (i16/i8 weights, i32 sums, one i64 product at the output), so the
//! native and wasm builds agree by construction.

use crate::board::{Board, Color};
use crate::topology::SIGIL;
use std::cell::RefCell;
use std::sync::OnceLock;

const N_NODES: usize = 39;
const NSP: usize = crate::spells_meta::NUM_OFFICIAL_SPELLS;
const NPLACE: usize = 5;
const Q: i32 = 64;
const MAX_H: usize = 256;
const MAX_L: usize = 64;

/// A network file baked into the binary, parsed on first use.
pub struct NnSpec {
    pub name: &'static str,
    pub bytes: &'static [u8],
    net: OnceLock<Net>,
}

impl std::fmt::Debug for NnSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NnSpec({}, {} bytes)", self.name, self.bytes.len())
    }
}

impl NnSpec {
    pub const fn new(name: &'static str, bytes: &'static [u8]) -> Self {
        NnSpec { name, bytes, net: OnceLock::new() }
    }
    pub fn net(&self) -> &Net {
        self.net.get_or_init(|| Net::parse(self.bytes).unwrap_or_else(|e| panic!("{}: {e}", self.name)))
    }
}

/// `nets/nnue_spell.bin`, written by `nn_eval.py train` (see engine/reports/2026-10-step5.md).
pub static NNUE_SPELL: NnSpec = NnSpec::new("nnue_spell", include_bytes!("../nets/nnue_spell.bin"));

pub struct Net {
    pub h: usize,
    pub l2: usize,
    pub l3: usize,
    pub cap: i32,
    base: Vec<i16>,   // [78][h]
    e: Vec<i16>,      // [1 + NSP*NPLACE*2][h], row 0 = node on no sigil (zero)
    g: Vec<i16>,      // [NSP*9][h]
    pov: Vec<i16>,    // [2][h], 0 = red POV
    w2: Vec<i8>,      // [l2][h]
    b2: Vec<i32>,
    w3: Vec<i8>,      // [l3][l2]
    b3: Vec<i32>,
    w4: Vec<i16>,     // [l3]
    b4: i32,
}

struct Rd<'a> { b: &'a [u8], o: usize }
impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.o..self.o + n).ok_or("network file truncated")?;
        self.o += n;
        Ok(s)
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i16s(&mut self, n: usize) -> Result<Vec<i16>, String> {
        Ok(self.take(2 * n)?.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
    }
    fn i8s(&mut self, n: usize) -> Result<Vec<i8>, String> {
        Ok(self.take(n)?.iter().map(|&x| x as i8).collect())
    }
    fn i32s(&mut self, n: usize) -> Result<Vec<i32>, String> {
        (0..n).map(|_| self.i32()).collect()
    }
}

impl Net {
    pub fn parse(b: &[u8]) -> Result<Net, String> {
        let mut r = Rd { b, o: 0 };
        if r.take(4)? != b"SNN1" { return Err("bad magic".into()); }
        let h = r.i32()? as usize;
        let l2 = r.i32()? as usize;
        let l3 = r.i32()? as usize;
        let cap = r.i32()?;
        let ne = r.i32()? as usize;
        let ng = r.i32()? as usize;
        if h > MAX_H || l2 > MAX_L || l3 > MAX_L { return Err(format!("layer too wide ({h},{l2},{l3})")); }
        if ne != 1 + NSP * NPLACE * 2 || ng != NSP * 9 {
            return Err(format!("spell tables sized for another spell list ({ne}, {ng})"));
        }
        let net = Net {
            h, l2, l3, cap,
            base: r.i16s(2 * N_NODES * h)?, e: r.i16s(ne * h)?, g: r.i16s(ng * h)?,
            pov: r.i16s(2 * h)?,
            w2: r.i8s(l2 * h)?, b2: r.i32s(l2)?,
            w3: r.i8s(l3 * l2)?, b3: r.i32s(l3)?,
            w4: r.i16s(l3)?, b4: r.i32()?,
        };
        if r.o != b.len() { return Err(format!("{} trailing bytes", b.len() - r.o)); }
        Ok(net)
    }

    /// The per-draw fold: 78 first-layer rows and the two game biases.
    fn fold(&self, spells: &[u8; 9]) -> Folded {
        let h = self.h;
        let mut rows = vec![0i32; 2 * N_NODES * h];
        for (p, &m) in SIGIL.iter().enumerate() {
            let s = spells[p] as usize;
            let mut q = 0usize;
            for n in 0..N_NODES {
                if m >> n & 1 == 0 { continue; }
                if s < NSP {
                    for rel in 0..2 {
                        let er = (1 + (s * NPLACE + q) * 2 + rel) * h;
                        let dst = &mut rows[(2 * n + rel) * h..(2 * n + rel + 1) * h];
                        for (d, &w) in dst.iter_mut().zip(&self.e[er..er + h]) { *d += w as i32; }
                    }
                }
                q += 1;
            }
        }
        for (d, &w) in rows.iter_mut().zip(&self.base) { *d += w as i32; }
        let mut gb = [vec![0i32; h], vec![0i32; h]];
        for (pv, v) in gb.iter_mut().enumerate() {
            for (d, &w) in v.iter_mut().zip(&self.pov[pv * h..(pv + 1) * h]) { *d = w as i32; }
            for (p, &s) in spells.iter().enumerate() {
                let s = s as usize;
                if s >= NSP { continue; }
                let gr = (s * 9 + p) * h;
                for (d, &w) in v.iter_mut().zip(&self.g[gr..gr + h]) { *d += w as i32; }
            }
        }
        Folded { key: (self as *const Net as usize, *spells), rows, gb }
    }

    /// The network's output, in centistones, for side `c` (its own POV).
    fn forward(&self, f: &Folded, mine: u64, theirs: u64, c: Color) -> i32 {
        let h = self.h;
        let mut acc = [0i32; MAX_H];
        let acc = &mut acc[..h];
        acc.copy_from_slice(&f.gb[if c == Color::Red { 0 } else { 1 }]);
        for (bits, rel) in [(mine, 0usize), (theirs, 1usize)] {
            let mut m = bits;
            while m != 0 {
                let n = m.trailing_zeros() as usize;
                m &= m - 1;
                let r = &f.rows[(2 * n + rel) * h..(2 * n + rel + 1) * h];
                for (a, &w) in acc.iter_mut().zip(r) { *a += w; }
            }
        }
        for a in acc.iter_mut() { *a = (*a).clamp(0, Q); }
        let mut h2 = [0i32; MAX_L];
        for j in 0..self.l2 {
            let w = &self.w2[j * h..(j + 1) * h];
            let s: i32 = acc.iter().zip(w).map(|(&a, &w)| a * w as i32).sum::<i32>() + self.b2[j];
            h2[j] = (s >> 6).clamp(0, Q);
        }
        let mut h3 = [0i32; MAX_L];
        for j in 0..self.l3 {
            let w = &self.w3[j * self.l2..(j + 1) * self.l2];
            let s: i32 = h2[..self.l2].iter().zip(w).map(|(&a, &w)| a * w as i32).sum::<i32>() + self.b3[j];
            h3[j] = (s >> 6).clamp(0, Q);
        }
        let o: i64 = h3[..self.l3].iter().zip(&self.w4).map(|(&a, &w)| a as i64 * w as i64).sum::<i64>()
            + self.b4 as i64;
        (((o * 100) >> 12) as i32).clamp(-self.cap, self.cap)
    }

    /// Stateless entry point (folds every call): for tests and one-off callers.
    pub fn eval_raw(&self, spells: &[u8; 9], mine: u64, theirs: u64, c: Color) -> i32 {
        self.forward(&self.fold(spells), mine, theirs, c)
    }
}

struct Folded {
    key: (usize, [u8; 9]),
    rows: Vec<i32>,
    gb: [Vec<i32>; 2],
}

thread_local! {
    static FOLD: RefCell<Option<Folded>> = const { RefCell::new(None) };
}

/// The network term of `Board::evaluate` for side `c`.
pub fn eval(spec: &'static NnSpec, b: &Board, c: Color) -> i32 {
    let net = spec.net();
    let key = (net as *const Net as usize, b.spells);
    FOLD.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.as_ref().map_or(true, |f| f.key != key) {
            *slot = Some(net.fold(&b.spells));
        }
        net.forward(slot.as_ref().unwrap(), b.mine(c), b.theirs(c), c)
    })
}
