"""Step 5 of the 2026-10 plan: a small spell-conditioned network eval (`nnue_spell`).

    nn_eval.py prep  <chunk-dir|list-file> <out.npz> [--workers N] [--evals tfit,tfit_spell]
    nn_eval.py train <prep.npz> <out-dir> [--lam 0.5] [--hidden 128] [--epochs 6]
                     [--split game|fold0|fold1|fold2] [--cap 96] [--device cuda]
    nn_eval.py golden <net.bin> <prep.npz> <out.txt> [--n 64]

WHAT IS LEARNED. A residual on top of the `tfit_spell` eval (Step 2), in
centistones, clamped to +-`cap`:

    eval(pos, c) = tfit_spell(pos, c) + clamp(net(pos, c), -cap, cap)

Inputs are the 78 occupancy bits (39 nodes x {mine, theirs}, from `c`'s POV) and
the side `c` itself (red/blue asymmetry: blue holds the +1 token). Spell
conditioning is folded into the FIRST layer once per game, because the 9-spell draw
never changes during a game:

    row(node, rel) = base[node, rel] + E[spell on node's sigil, place in sigil, rel]
    game_bias[c]   = pov[c] + sum_p G[spell_p, p]

so per leaf the network is a plain sparse accumulator (one row per occupied node)
followed by two small hidden layers:

    h1 = clamp(game_bias[c] + sum rows, 0, 1)          (H = 128)
    h2 = clamp(L2 h1, 0, 1)   h3 = clamp(L3 h2, 0, 1)  (32, 32)
    out = L4 h3  (stones)  ->  centistones, clamped to +-cap

E and G start at zero and are L2-regularised towards zero, so a spell the training
set never saw (the spell-held-out folds; ids absent from the data) contributes
nothing and falls back to the spell-blind base rows.

QUANTISATION (exactly what `src/nn.rs` computes; `golden` writes test vectors):
first-layer rows int16 at scale 64 (1.0 == 64), the accumulator int32 clamped to
[0, 64]; L2/L3 weights int8 at scale 64, biases int32 at 64*64, each layer's sum
shifted right by 6 (floor) and clamped to [0, 64]; L4 weights int16 at scale 64,
bias int32 at 64*64, output o in 1/4096 stone, centistones = (o * 100) >> 12
(floor, 64-bit), clamped to +-cap. Integer-only, so native and wasm agree by
construction; the golden test pins Python == Rust.

TARGET. A blend of the depth-D search score and the outcome, as the plan asks:
    t = lam * sigmoid(k * score / 100) + (1 - lam) * y
with k, b the texel scale fitted on `tfit_spell` alone over the training games
(the same k for the score target as `fit_spell_eval.py` uses); a mate score maps
to 1/0 by its sign. lam is chosen on held-out OUTCOME log-loss.

Splits are by GAME (hash of the game id, 80/20), never by position, and the
spell-held-out folds are `fit_spell_eval.py`'s three (train on games whose draw
avoids the six spells, test on games holding any of them).
"""
import argparse
import glob
import json
import os
import struct
import sys
import time

import numpy as np

N_NODES = 39
NSP = 45            # spells_meta::NUM_OFFICIAL_SPELLS
NPLACE = 5          # largest sigil
MATE = 5_000_000
Q = 64
# topology::SIGIL, slot order (sizes 5,5,5,3,3,3,1,1,1). Cross-checked against the
# engine's own sigil fill in `prep` (a mismatch aborts).
SIGIL = [0x0000000003e, 0x0000007c000, 0x000f8000000, 0x00000000380, 0x00000700000,
         0x00e00000000, 0x00000000040, 0x00000080000, 0x00100000000]
NODE_P = np.full(N_NODES, -1, np.int64)      # sigil slot of each node, -1 = none
NODE_Q = np.zeros(N_NODES, np.int64)         # place within the sigil (ascending bit)
for _p, _m in enumerate(SIGIL):
    _q = 0
    for _n in range(N_NODES):
        if _m >> _n & 1:
            NODE_P[_n], NODE_Q[_n] = _p, _q
            _q += 1
N_E = 1 + NSP * NPLACE * 2       # row 0 = "node is on no sigil" (always zero)
N_G = NSP * 9
FOLDS = [[0, 15, 5, 16, 10, 17], [1, 18, 6, 19, 11, 20], [2, 21, 7, 22, 12, 23]]


# --------------------------------------------------------------------------- prep
def _prep_file(args):
    path, evals = args
    import sigil_engine as se
    z = np.load(path)
    sfn = z['sfn']
    n = len(sfn)
    if n == 0:
        return None
    mine = np.zeros(n, np.uint64)
    theirs = np.zeros(n, np.uint64)
    ev = {e: np.zeros(n, np.int32) for e in evals}
    is_red = z['is_red'].astype(bool)
    for i, s in enumerate(sfn):
        board = s.split('/', 1)[0]
        r = b = 0
        for j, ch in enumerate(board):
            if ch == 'r':
                r |= 1 << j
            elif ch == 'b':
                b |= 1 << j
        mine[i], theirs[i] = (r, b) if is_red[i] else (b, r)
        pb = se.Board.from_sfn(str(s))
        c = 'red' if is_red[i] else 'blue'
        for e in evals:
            ev[e][i] = pb.evaluate(c, e)
    out = dict(mine=mine, theirs=theirs, spells=z['spells'].astype(np.uint8),
               is_red=is_red.astype(np.uint8), score=z['score'].astype(np.int32),
               y=z['y'].astype(np.uint8), game=z['game'].astype(np.int64),
               ply=z['ply'].astype(np.int16), kind=z['kind'].astype(np.uint8))
    for e in evals:
        out['ev_' + e] = ev[e]
    # sanity: the sigil table must match the engine's notion of a sigil
    f = z['full'][:1]
    if len(f):
        m = int(mine[0])
        fill = [bin(m & SIGIL[p]).count('1') / bin(SIGIL[p]).count('1') for p in range(9)]
        if not np.allclose(fill, f[0, 78:87], atol=1e-4):
            raise SystemExit(f"SIGIL table disagrees with full_features in {path}")
    return out


def cmd_prep(a):
    if os.path.isdir(a.src):
        files = sorted(glob.glob(os.path.join(a.src, '*.npz')))
    else:
        files = [l.strip() for l in open(a.src) if l.strip()]
    evals = a.evals.split(',')
    from multiprocessing import Pool
    t0 = time.time()
    parts = []
    with Pool(a.workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_prep_file, [(f, evals) for f in files],
                                                  chunksize=8)):
            if r is not None:
                parts.append(r)
            if i % 2000 == 0:
                print(f"prep {i}/{len(files)} {time.time() - t0:.0f}s", flush=True)
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    tmp = a.out + '.tmp.npz'
    np.savez(tmp, **out)
    os.replace(tmp, a.out)
    print(f"WROTE {a.out}: {len(out['y'])} positions from {len(parts)} chunks, "
          f"{len(np.unique(out['game']))} games, {time.time() - t0:.0f}s", flush=True)


# --------------------------------------------------------------------------- data
def load_prep(path):
    z = np.load(path)
    return {k: z[k] for k in z.files}


def split_masks(D, split):
    g = D['game'].astype(np.uint64)
    h = (g * np.uint64(0x9E3779B97F4A7C15)) >> np.uint64(59)      # 0..31
    if split == 'game':
        te = h < np.uint64(7)          # ~22% of games
        return ~te, te
    hold = FOLDS[int(split[-1])]
    has = np.isin(D['spells'], hold).any(axis=1)
    return ~has, has


def occupancy(mine, theirs):
    """(n,) uint64 x2 -> (n, 78) uint8, column 2*node + rel."""
    bits = np.arange(N_NODES, dtype=np.uint64)
    m = ((mine[:, None] >> bits) & np.uint64(1)).astype(np.uint8)
    t = ((theirs[:, None] >> bits) & np.uint64(1)).astype(np.uint8)
    return np.stack([m, t], axis=2).reshape(len(mine), 2 * N_NODES)


def e_index(spells):
    """(n, 9) spell ids -> (n, 78) E-row per (node, rel); 0 for nodes on no sigil."""
    n = len(spells)
    out = np.zeros((n, N_NODES, 2), np.int64)
    on = NODE_P >= 0
    sp = spells[:, NODE_P[on]].astype(np.int64)                  # (n, nodes on sigils)
    base = 1 + (sp * NPLACE + NODE_Q[on][None, :]) * 2
    out[:, on, 0] = base
    out[:, on, 1] = base + 1
    return out.reshape(n, 2 * N_NODES)


def g_index(spells):
    return spells.astype(np.int64) * 9 + np.arange(9)[None, :]


def xent(logit, t):
    return float(np.mean(np.logaddexp(0, logit) - t * logit))


def fit_kb(e0, y):
    from scipy.optimize import minimize
    def f(p):
        z = p[0] * e0 / 100.0 + p[1]
        s = 1 / (1 + np.exp(-z))
        g = s - y
        return xent(z, y), np.array([np.mean(g * e0 / 100.0), np.mean(g)])
    return minimize(f, [0.5, 0.0], jac=True, method='L-BFGS-B').x


def score_target(score, k):
    sc = score.astype(np.float64)
    mate = np.abs(sc) >= MATE
    t = 1 / (1 + np.exp(-k * np.clip(sc, -1e5, 1e5) / 100))
    t[mate] = (sc[mate] > 0).astype(np.float64)
    return t, ~mate


# --------------------------------------------------------------------------- model
def build_model(H, L2, L3, cap):
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            g = torch.Generator().manual_seed(0)
            self.base = nn.Parameter(torch.randn(2 * N_NODES, H, generator=g) * 0.1)
            self.E = nn.Parameter(torch.zeros(N_E, H))
            self.G = nn.Parameter(torch.zeros(N_G, H))
            self.pov = nn.Parameter(torch.full((2, H), 0.25))
            self.l2 = nn.Linear(H, L2)
            self.l3 = nn.Linear(L2, L3)
            self.l4 = nn.Linear(L3, 1)
            nn.init.zeros_(self.l4.weight)
            nn.init.zeros_(self.l4.bias)
            self.cap = cap

        def forward(self, x, eidx, gidx, pov):
            acc = x @ self.base
            acc = acc + F.embedding_bag(eidx, self.E, per_sample_weights=x, mode='sum')
            acc = acc + F.embedding_bag(gidx, self.G, mode='sum')
            acc = acc + self.pov[pov]
            h = acc.clamp(0, 1)
            h = self.l2(h).clamp(0, 1)
            h = self.l3(h).clamp(0, 1)
            return (100 * self.l4(h).squeeze(1)).clamp(-self.cap, self.cap)

        def clamp_(self):
            with torch.no_grad():
                lim = 127 / Q
                self.l2.weight.clamp_(-lim, lim)
                self.l3.weight.clamp_(-lim, lim)
                self.l4.weight.clamp_(-32767 / Q, 32767 / Q)
                self.E[0].zero_()
    return Net()


def quantize(net):
    import torch
    with torch.no_grad():
        r = lambda t, s: np.rint(t.detach().cpu().numpy().astype(np.float64) * s)
        q = {
            'base': r(net.base, Q).astype(np.int16), 'E': r(net.E, Q).astype(np.int16),
            'G': r(net.G, Q).astype(np.int16), 'pov': r(net.pov, Q).astype(np.int16),
            'w2': np.clip(r(net.l2.weight, Q), -127, 127).astype(np.int8),
            'b2': r(net.l2.bias, Q * Q).astype(np.int32),
            'w3': np.clip(r(net.l3.weight, Q), -127, 127).astype(np.int8),
            'b3': r(net.l3.bias, Q * Q).astype(np.int32),
            'w4': np.clip(r(net.l4.weight[0], Q), -32767, 32767).astype(np.int16),
            'b4': np.int32(r(net.l4.bias, Q * Q)[0]),
            'cap': int(net.cap),
        }
    q['E'][0] = 0
    return q


def qforward(q, mine, theirs, spells, is_red, chunk=200_000):
    """Integer forward pass, bit-for-bit what src/nn.rs computes. Returns centistones."""
    if len(mine) > chunk:
        return np.concatenate([qforward(q, mine[s:s + chunk], theirs[s:s + chunk],
                                        spells[s:s + chunk], is_red[s:s + chunk], chunk)
                               for s in range(0, len(mine), chunk)])
    x = occupancy(mine, theirs).astype(np.int32)                          # (n, 78)
    e = e_index(spells)
    E = q['E'].astype(np.int32)
    acc = x @ q['base'].astype(np.int32)
    for f in range(2 * N_NODES):
        on = x[:, f] != 0
        if on.any():
            acc[on] += E[e[on, f]]
    acc += q['G'].astype(np.int32)[g_index(spells)].sum(axis=1)
    acc += q['pov'].astype(np.int32)[1 - is_red.astype(np.int64)]       # 0 = red POV
    h = np.clip(acc, 0, Q).astype(np.int64)
    h = np.clip((h @ q['w2'].astype(np.int64).T + q['b2']) >> 6, 0, Q)
    h = np.clip((h @ q['w3'].astype(np.int64).T + q['b3']) >> 6, 0, Q)
    o = h @ q['w4'].astype(np.int64) + np.int64(q['b4'])
    return np.clip((o * 100) >> 12, -q['cap'], q['cap']).astype(np.int32)


MAGIC = b'SNN1'


def write_bin(q, path):
    H = q['base'].shape[1]
    L2, L3 = q['w2'].shape[0], q['w3'].shape[0]
    with open(path + '.tmp', 'wb') as f:
        f.write(MAGIC)
        f.write(struct.pack('<6i', H, L2, L3, q['cap'], N_E, N_G))
        for k in ('base', 'E', 'G', 'pov'):
            f.write(q[k].astype('<i2').tobytes())
        f.write(q['w2'].astype('i1').tobytes()); f.write(q['b2'].astype('<i4').tobytes())
        f.write(q['w3'].astype('i1').tobytes()); f.write(q['b3'].astype('<i4').tobytes())
        f.write(q['w4'].astype('<i2').tobytes()); f.write(struct.pack('<i', int(q['b4'])))
    os.replace(path + '.tmp', path)


def read_bin(path):
    b = open(path, 'rb').read()
    assert b[:4] == MAGIC
    H, L2, L3, cap, ne, ng = struct.unpack('<6i', b[4:28])
    o = 28
    def take(dt, n, shape):
        nonlocal o
        a = np.frombuffer(b, dt, n, o).reshape(shape)
        o += a.nbytes
        return a.copy()
    q = {'base': take('<i2', 78 * H, (78, H)), 'E': take('<i2', ne * H, (ne, H)),
         'G': take('<i2', ng * H, (ng, H)), 'pov': take('<i2', 2 * H, (2, H)),
         'w2': take('i1', L2 * H, (L2, H)), 'b2': take('<i4', L2, (L2,)),
         'w3': take('i1', L3 * L2, (L3, L2)), 'b3': take('<i4', L3, (L3,)),
         'w4': take('<i2', L3, (L3,))}
    q['b4'] = np.int32(struct.unpack('<i', b[o:o + 4])[0]); o += 4
    q['cap'] = cap
    assert o == len(b), (o, len(b))
    return q


# --------------------------------------------------------------------------- train
def cmd_train(a):
    import torch
    torch.manual_seed(0)
    dev = a.device if (a.device != 'cuda' or torch.cuda.is_available()) else 'cpu'
    D = load_prep(a.prep)
    ok = D['y'] != 255
    D = {k: v[ok] for k, v in D.items()}
    tr, te = split_masks(D, a.split)
    base_name = 'ev_' + a.base
    e0 = D[base_name].astype(np.float64)
    y = D['y'].astype(np.float64)
    k, b = fit_kb(e0[tr], y[tr])
    ts, nonmate = score_target(D['score'], k)
    lam = a.lam
    t = lam * ts + (1 - lam) * y
    print(f"split={a.split} train={tr.sum()} test={te.sum()} k={k:.4f} b={b:.4f} "
          f"lam={lam} base={a.base} device={dev}", flush=True)

    net = build_model(a.hidden, a.l2, a.l3, a.cap).to(dev)
    first = [net.base, net.E, net.G, net.pov]
    rest = list(net.l2.parameters()) + list(net.l3.parameters()) + list(net.l4.parameters())
    opt = torch.optim.Adam([{'params': first, 'lr': a.lr},
                            {'params': rest, 'lr': a.lr}])
    idx_tr = np.flatnonzero(tr)
    T = lambda arr, dt: torch.as_tensor(arr, dtype=dt, device=dev)
    # Stage the training arrays on the device once (compact: two u64 per row).
    mine = T(D['mine'].view(np.int64), torch.int64)
    theirs = T(D['theirs'].view(np.int64), torch.int64)
    spells = T(D['spells'].astype(np.int64), torch.int64)
    povt = T(1 - D['is_red'].astype(np.int64), torch.int64)
    e0t = T(e0, torch.float32)
    tt = T(t, torch.float32)
    bits = torch.arange(N_NODES, device=dev, dtype=torch.int64)
    node_p = T(NODE_P, torch.int64); node_q = T(NODE_Q, torch.int64)
    onm = node_p >= 0

    def batch(ix):
        m = (mine[ix, None] >> bits) & 1
        th = (theirs[ix, None] >> bits) & 1
        x = torch.stack([m, th], 2).reshape(len(ix), 78).float()
        sp = spells[ix]
        e = torch.zeros(len(ix), N_NODES, 2, dtype=torch.int64, device=dev)
        bse = 1 + (sp[:, node_p[onm]] * NPLACE + node_q[onm][None, :]) * 2
        e[:, onm, 0] = bse
        e[:, onm, 1] = bse + 1
        g = sp * 9 + torch.arange(9, device=dev)[None, :]
        return x, e.reshape(len(ix), 78), g, povt[ix]

    def predict(ix_all, bs=65536):
        out = []
        net.eval()
        with torch.no_grad():
            for s in range(0, len(ix_all), bs):
                ix = T(ix_all[s:s + bs], torch.int64)
                out.append(net(*batch(ix)).cpu().numpy())
        net.train()
        return np.concatenate(out) if out else np.zeros(0)

    t0 = time.time()
    rng = np.random.default_rng(0)
    steps_per_epoch = len(idx_tr) // a.batch
    hist = []
    for ep in range(a.epochs):
        perm = rng.permutation(idx_tr)
        lr = a.lr * (0.5 ** max(0, ep - a.epochs // 2))
        for gp in opt.param_groups:
            gp['lr'] = lr
        tot = 0.0
        for s in range(steps_per_epoch):
            ix = T(perm[s * a.batch:(s + 1) * a.batch], torch.int64)
            nnv = net(*batch(ix))
            logit = k * (e0t[ix] + nnv) / 100 + b
            loss = torch.nn.functional.binary_cross_entropy_with_logits(logit, tt[ix])
            reg = a.l2reg * (net.E.pow(2).sum() + net.G.pow(2).sum()) / len(idx_tr)
            opt.zero_grad()
            (loss + reg).backward()
            opt.step()
            net.clamp_()
            tot += float(loss.detach())
        pte = predict(np.flatnonzero(te))
        zte = k * (e0[te] + pte) / 100 + b
        m = nonmate[te]
        r = {'epoch': ep, 'train_loss': tot / max(1, steps_per_epoch),
             'test_outcome_ll': xent(zte, y[te]),
             'test_score_xent': xent(zte[m], ts[te][m]), 's': time.time() - t0}
        hist.append(r)
        print(json.dumps(r), flush=True)

    os.makedirs(a.out, exist_ok=True)
    torch.save(net.state_dict(), os.path.join(a.out, 'net.pt'))
    q = quantize(net)
    write_bin(q, os.path.join(a.out, 'net.bin'))

    # ---- held-out report: baselines (k, b refitted on their own train rows) vs net
    res = {'split': a.split, 'lam': lam, 'k': k, 'b': b, 'base': a.base, 'hidden': a.hidden,
           'cap': a.cap, 'n_train': int(tr.sum()), 'n_test': int(te.sum()),
           'n_test_games': int(len(np.unique(D['game'][te]))), 'history': hist}
    m = nonmate[te]
    for name in [kk for kk in D if kk.startswith('ev_')]:
        ee = D[name].astype(np.float64)
        kk_, bb_ = fit_kb(ee[tr], y[tr])
        z = kk_ * ee[te] / 100 + bb_
        tsn, _ = score_target(D['score'][te], kk_)
        res[name[3:]] = {'outcome_ll': xent(z, y[te]), 'score_xent': xent(z[m], tsn[m]),
                         'k': kk_}
    qte = qforward(q, D['mine'][te], D['theirs'][te], D['spells'][te], D['is_red'][te])
    fte = predict(np.flatnonzero(te))
    for tag, v in (('net_float', fte), ('net_quant', qte.astype(np.float64))):
        z = k * (e0[te] + v) / 100 + b
        res[tag] = {'outcome_ll': xent(z, y[te]), 'score_xent': xent(z[m], ts[te][m]),
                    'mean_abs_cs': float(np.mean(np.abs(v))),
                    'at_cap': float(np.mean(np.abs(v) >= a.cap))}
    res['quant_vs_float_max_abs_cs'] = float(np.max(np.abs(qte - fte))) if len(qte) else 0.0
    with open(os.path.join(a.out, 'result.json'), 'w') as f:
        json.dump(res, f, indent=1)
    print('RESULT ' + json.dumps({kk: v for kk, v in res.items() if kk != 'history'}),
          flush=True)


# --------------------------------------------------------------------------- golden
def cmd_golden(a):
    """Test vectors for src/nn.rs: SFNs and the centistones the integer net gives."""
    q = read_bin(a.net)
    D = load_prep(a.prep)
    import sigil_engine  # noqa: F401  (only to fail early if the module is absent)
    rng = np.random.default_rng(1)
    ix = rng.choice(len(D['y']), size=min(a.n, len(D['y'])), replace=False)
    v = qforward(q, D['mine'][ix], D['theirs'][ix], D['spells'][ix], D['is_red'][ix])
    # one line per vector: mine theirs s0,..,s8 red cs  (read by src/tests.rs)
    with open(a.out, 'w') as f:
        for i, cs in zip(ix, v):
            f.write(f"{int(D['mine'][i])} {int(D['theirs'][i])} "
                    f"{','.join(str(int(x)) for x in D['spells'][i])} "
                    f"{int(D['is_red'][i])} {int(cs)}\n")
    print(f"WROTE {a.out}: {len(ix)} vectors, |cs| mean {np.mean(np.abs(v)):.1f}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prep')
    p.add_argument('src'); p.add_argument('out')
    p.add_argument('--workers', type=int, default=os.cpu_count())
    p.add_argument('--evals', default='tfit,tfit_spell')
    p = sub.add_parser('train')
    p.add_argument('prep'); p.add_argument('out')
    p.add_argument('--lam', type=float, default=0.5)
    p.add_argument('--hidden', type=int, default=128)
    p.add_argument('--l2', type=int, default=32)
    p.add_argument('--l3', type=int, default=32)
    p.add_argument('--cap', type=int, default=96)
    p.add_argument('--epochs', type=int, default=6)
    p.add_argument('--batch', type=int, default=16384)
    p.add_argument('--lr', type=float, default=2e-3)
    p.add_argument('--l2reg', type=float, default=1.0)
    p.add_argument('--split', default='game')
    p.add_argument('--base', default='tfit_spell')
    p.add_argument('--device', default='cuda')
    p = sub.add_parser('golden')
    p.add_argument('net'); p.add_argument('prep'); p.add_argument('out')
    p.add_argument('--n', type=int, default=64)
    a = ap.parse_args()
    {'prep': cmd_prep, 'train': cmd_train, 'golden': cmd_golden}[a.cmd](a)


if __name__ == '__main__':
    main()
