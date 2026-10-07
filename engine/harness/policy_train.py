"""Step 4 (2026-10 plan): train the learned generator policy (`engine/src/policy.rs`).

    policy_train.py extract <out.npz> <chunk.npz>... [--workers 8] [--max-pos N]
    policy_train.py train   <examples.npz> <weights.npy> [--epochs 30] [--l2 1e-4] [--holdout 0.1]
    policy_train.py gate0   <weights.npy|zero|compiled> <chunk.npz>... [--n 3000] [--cap 600]
    policy_train.py export  <weights.npy>          # writes engine/src/policy_weights.rs
    policy_train.py lse-table                     # writes engine/src/policy_lse.rs

`extract` walks every labelled position of Step 3 chunks (`selfplay_v2.py`)
through `sigil_engine.policy_example`, i.e. through the SAME Rust expansions the
policy stream serves, so train and serve inputs cannot drift. The target is the
search's chosen turn (the exact-bound root row). Levels whose target lies
outside the generated options are recorded with target -1 and skipped by the
loss: the policy cannot build them, and counting them is part of the report.

The model (see policy.rs): option logit = sum over its features f of
W[f] . [1, z], one softmax per level instance. Fitted by full-batch L-BFGS-free
Adam on the summed cross-entropy with L2 on W, split by GAME so positions of one
game never straddle train and held-out.

`gate0` reports, on held-out chunks, the rank of the chosen turn's result in the
policy stream and in the shipped stream at the SAME generator budgets (window
16, keep window 2, as the search uses), as coverage at w6/w12/w24/w40/w96.
"""
import argparse
import glob
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)


def _se():
    import sigil_engine
    return sigil_engine


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------

def _chosen_rows(z):
    """(position index, packed chosen turn) for every position with a target."""
    out = []
    for i in range(len(z['sfn'])):
        ch = [int(x) for x in z['chosen'][i]]
        if not any(ch):
            continue
        out.append((i, ch))
    return out


def _extract_file(args):
    path, max_pos = args
    se = _se()
    try:
        z = np.load(path)
    except Exception as e:  # truncated download
        return path, None, str(e)
    zs, lv, tg, lex, no, nf, ff, games, plies = [], [], [], [], [], [], [], [], []
    rows = _chosen_rows(z)
    if max_pos:
        rows = rows[:max_pos]
    tag = os.path.basename(path)
    for i, ch in rows:
        ex = se.policy_example(str(z['sfn'][i]), ch)
        if ex is None:
            continue
        zz, l, t, n_o, n_f, f = ex
        e = len(zs)
        zs.append(zz)
        lv.extend(l); tg.extend(t); lex.extend([e] * len(l)); no.extend(n_o)
        nf.extend(n_f); ff.extend(f)
        games.append(int(z['game'][i])); plies.append(int(z['ply'][i]))
    if not zs:
        return path, None, 'empty'
    return path, dict(
        z=np.asarray(zs, np.float32), level=np.asarray(lv, np.uint8), target=np.asarray(tg, np.int32),
        lex=np.asarray(lex, np.int64), nopt=np.asarray(no, np.int32), nfeat=np.asarray(nf, np.uint8),
        feats=np.asarray(ff, np.uint16), game=np.asarray(games, np.int64), ply=np.asarray(plies, np.int16),
        src=np.asarray([tag] * len(zs))), None


def cmd_extract(a):
    from multiprocessing import Pool
    paths = []
    for p in a.chunks:
        paths.extend(sorted(glob.glob(p)) if any(ch in p for ch in '*?[') else [p])
    t0 = time.time()
    parts = []
    with Pool(a.workers) as pool:
        for k, (path, d, err) in enumerate(pool.imap_unordered(_extract_file, [(p, a.max_pos) for p in paths])):
            if d is None:
                print('skip', path, err, file=sys.stderr)
                continue
            parts.append(d)
            if (k + 1) % 200 == 0:
                print(f'{k + 1}/{len(paths)} files, {sum(len(x["z"]) for x in parts)} examples, '
                      f'{time.time() - t0:.0f}s', flush=True)
    out = _concat(parts)
    tmp = a.out + '.tmp.npz'
    np.savez_compressed(tmp, **out)
    os.replace(tmp, a.out)
    print(f'WROTE {a.out}: {len(out["z"])} examples, {len(out["level"])} levels, '
          f'{len(out["nfeat"])} options, {time.time() - t0:.0f}s')


def _concat(parts):
    out = {k: [] for k in parts[0]}
    e_base = 0
    for d in parts:
        for k, v in d.items():
            out[k].append(v + e_base if k == 'lex' else v)
        e_base += len(d['z'])
    return {k: np.concatenate(v) for k, v in out.items()}


# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------

def _tensors(d, keep_ex):
    """Flatten the levels of the examples in `keep_ex` into torch tensors."""
    import torch
    nlev = len(d['level'])
    lvl_ok = keep_ex[d['lex']] & (d['target'] >= 0)
    nopt = d['nopt'].astype(np.int64)
    opt_lvl = np.repeat(np.arange(nlev), nopt)              # option -> level
    opt_start = np.concatenate([[0], np.cumsum(nopt)[:-1]])
    nfeat = d['nfeat'].astype(np.int64)
    feat_opt = np.repeat(np.arange(len(nfeat)), nfeat)      # feature -> option
    keep_opt = lvl_ok[opt_lvl]
    o_idx = np.nonzero(keep_opt)[0]
    new_opt = np.full(len(nfeat), -1, np.int64); new_opt[o_idx] = np.arange(len(o_idx))
    L = np.nonzero(lvl_ok)[0]
    new_lvl = np.full(nlev, -1, np.int64); new_lvl[L] = np.arange(len(L))
    keep_f = keep_opt[feat_opt]
    feats = d['feats'][keep_f].astype(np.int64)
    f_opt = new_opt[feat_opt[keep_f]]
    o_grp = new_lvl[opt_lvl[o_idx]]
    tgt = new_opt[opt_start[L] + d['target'][L]]
    ex_of_opt = d['lex'][opt_lvl[o_idx]]
    return dict(
        feats=torch.from_numpy(feats), f_opt=torch.from_numpy(f_opt),
        o_grp=torch.from_numpy(o_grp), tgt=torch.from_numpy(tgt),
        z=torch.from_numpy(d['z'][ex_of_opt].astype(np.float32)),
        level=torch.from_numpy(d['level'][L].astype(np.int64)),
        n_opts=len(o_idx), n_grp=len(L))


def _logits(W, T):
    import torch
    rows = W[T['feats']]                                   # F x PW
    opt = torch.zeros(T['n_opts'], W.shape[1], dtype=W.dtype).index_add_(0, T['f_opt'], rows)
    zz = torch.cat([torch.ones(T['n_opts'], 1), T['z']], 1)
    return (opt * zz).sum(1)                               # options


def _group_logsoftmax(lg, grp, n_grp):
    import torch
    mx = torch.full((n_grp,), -1e30).scatter_reduce(0, grp, lg, reduce='amax', include_self=True)
    ex = torch.exp(lg - mx[grp])
    s = torch.zeros(n_grp).index_add_(0, grp, ex)
    return lg - (mx + torch.log(s))[grp]


def _nll(W, T):
    import torch
    lg = _logits(W, T)
    ls = _group_logsoftmax(lg, T['o_grp'], T['n_grp'])
    return -ls[T['tgt']]                                   # per level instance


def _split(d, holdout, seed=0):
    games = np.unique(d['game'])
    rng = np.random.default_rng(seed)
    held = set(rng.choice(games, size=max(1, int(len(games) * holdout)), replace=False).tolist())
    is_held = np.array([g in held for g in d['game']])
    return ~is_held, is_held


def _batches(d, mask, nb, seed=0):
    ex = np.nonzero(mask)[0]
    rng = np.random.default_rng(seed)
    rng.shuffle(ex)
    out = []
    for part in np.array_split(ex, nb):
        m = np.zeros(len(mask), bool); m[part] = True
        out.append(_tensors(d, m))
    return out


def _eval(W, Ts):
    import torch
    names = ['M', 'P', 'S', 'D', 'P2', 'S2', 'C', 'Z', 'S3']
    tot = torch.zeros(9); cnt = torch.zeros(9)
    with torch.no_grad():
        for T in Ts:
            nll = _nll(W, T)
            tot.index_add_(0, T['level'], nll); cnt.index_add_(0, T['level'], torch.ones_like(nll))
    per = {names[k]: round(float(tot[k] / cnt[k]), 4) for k in range(9) if cnt[k] > 0}
    return round(float(tot.sum() / cnt.sum()), 4), per, {names[k]: int(cnt[k]) for k in range(9) if cnt[k] > 0}


def cmd_train(a):
    import torch
    torch.manual_seed(0)
    torch.set_num_threads(os.cpu_count())
    se = _se()
    NF, PW, _groups = se.policy_layout()
    d = dict(np.load(a.examples))
    tr, ho = _split(d, a.holdout)
    Btr = _batches(d, tr, a.batches)
    Bho = _batches(d, ho, max(1, a.batches // 8))
    n_tr = sum(T['n_grp'] for T in Btr)
    print(f'train: {tr.sum()} examples, {n_tr} levels in {len(Btr)} batches; held-out {ho.sum()} examples')
    Wc = torch.tensor(compiled_weights())
    shipped = _eval(Wc, Bho) if tuple(Wc.shape) == (NF, PW) else None
    print('shipped held', json.dumps(shipped))
    W = torch.tensor(load_weights(a.init), requires_grad=True)
    opt = torch.optim.Adam([W], lr=a.lr)
    base = _eval(W, Bho)
    print(f'{a.init} held', json.dumps(base))
    hist = []
    for ep in range(a.epochs):
        for T in Btr:
            opt.zero_grad()
            loss = _nll(W, T).sum() / T['n_grp'] + a.l2 * (W ** 2).sum()
            loss.backward()
            opt.step()
        if a.lr_decay < 1:
            for g in opt.param_groups: g['lr'] *= a.lr_decay
        h = _eval(W, Bho)
        hist.append(h[0])
        print(f'ep{ep + 1} held', json.dumps(h), flush=True)
    final_tr = _eval(W, Btr)
    final = _eval(W, Bho)
    print('final train', json.dumps(final_tr))
    np.save(a.weights, W.detach().numpy().astype(np.float32))
    meta = dict(examples=a.examples, epochs=a.epochs, l2=a.l2, lr=a.lr, holdout=a.holdout,
                batches=a.batches, init=a.init, init_held=base, shipped_held=shipped,
                final_held=final, final_train=final_tr, hist=hist)
    with open(a.weights + '.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('WROTE', a.weights)


# ---------------------------------------------------------------------------
# gate 0
# ---------------------------------------------------------------------------

def compiled_weights():
    """The shipped weights, parsed from the generated `policy_weights.rs`."""
    rows = []
    for line in open(os.path.join(ENGINE, 'src', 'policy_weights.rs')):
        line = line.strip()
        if line.startswith('[') and line.endswith('],'):
            rows.append([float(x) for x in line[1:-2].split(',')])
    return np.asarray(rows, np.float32)


def load_weights(wpath):
    """`zero`, `compiled` (the shipped weights) or a .npy path."""
    if wpath == 'compiled':
        return compiled_weights()
    if wpath == 'zero':
        NF, PW, _ = _se().policy_layout()
        return np.zeros((NF, PW), np.float32)
    return np.load(wpath).astype(np.float32)


def _gate_file(args):
    path, wpath, n, cap = args
    se = _se()
    se.set_policy_weights(load_weights(wpath).ravel().tolist())
    z = np.load(path)
    out = []
    for i, ch in _chosen_rows(z)[:n]:
        rp, rs = se.policy_vs_stream_rank(str(z['sfn'][i]), ch, cap)
        out.append((rp, rs, int(z['ply'][i])))
    return out


def coverage(r, ks=(6, 12, 24, 40, 96)):
    v = np.where(np.asarray(r) < 0, 10 ** 9, np.asarray(r))
    return {f'w{k}': round(float((v < k).mean()), 4) for k in ks}


def cmd_gate0(a):
    from multiprocessing import Pool
    paths = []
    for p in a.chunks:
        paths.extend(sorted(glob.glob(p)) if any(ch in p for ch in '*?[') else [p])
    per = max(1, a.n // max(1, len(paths)))
    with Pool(a.workers) as pool:
        res = [x for part in pool.map(_gate_file, [(p, a.weights, per, a.cap) for p in paths]) for x in part]
    rp = [x[0] for x in res]; rs = [x[1] for x in res]
    rep = dict(n=len(res), policy=coverage(rp), stream=coverage(rs))
    print(json.dumps(rep))
    if a.out:
        with open(a.out, 'w') as f:
            json.dump(rep, f, indent=1)


# ---------------------------------------------------------------------------
# export / tables
# ---------------------------------------------------------------------------

def cmd_export(a):
    W = np.load(a.weights).astype(np.float32)
    NF, PW = W.shape
    rows = []
    for r in W:
        rows.append('    [' + ', '.join(repr(float(x)) if x != 0 else '0.0' for x in r) + '],')
    src = ('//! GENERATED by engine/harness/policy_train.py `export` from\n'
           f'//! `{os.path.basename(a.weights)}`: the learned generator policy\'s weights\n'
           '//! (`policy.rs`), `NF` rows of `[bias, z...]`. Do not edit by hand.\n'
           'use crate::policy::{NF, PW};\n\n'
           '#[allow(clippy::excessive_precision)]\n'
           'pub const POLICY_W: [[f32; PW]; NF] = [\n' + '\n'.join(rows) + '\n];\n')
    out = os.path.join(ENGINE, 'src', 'policy_weights.rs')
    with open(out, 'w') as f:
        f.write(src)
    print('WROTE', out, W.shape)


def cmd_lse(_a):
    Q, N = 256, 4096
    t = [round(Q * math.log1p(math.exp(-d / Q))) for d in range(N)]
    t = t[:max(i for i, v in enumerate(t) if v > 0) + 1]
    lines = ['    ' + ', '.join(str(v) for v in t[i:i + 16]) + ',' for i in range(0, len(t), 16)]
    src = ('//! Fixed-point log-sum-exp table for the learned generator policy (`policy.rs`).\n'
           '//! GENERATED (engine/harness/policy_train.py `lse-table`): `LSE_T[d]` is\n'
           '//! `round(256 * ln(1 + exp(-d / 256)))`, zero past the end. Integer, so the\n'
           '//! policy\'s priorities are bit-identical in the native and wasm builds, which\n'
           '//! would not hold for `f32::exp` / `ln` (platform libm).\n'
           'pub const LSE_Q: i32 = 256;\n'
           f'pub const LSE_T: [i16; {len(t)}] = [\n' + '\n'.join(lines) + '\n];\n')
    with open(os.path.join(ENGINE, 'src', 'policy_lse.rs'), 'w') as f:
        f.write(src)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('extract'); p.add_argument('out'); p.add_argument('chunks', nargs='+')
    p.add_argument('--workers', type=int, default=os.cpu_count()); p.add_argument('--max-pos', type=int, default=0)
    p = sub.add_parser('train'); p.add_argument('examples'); p.add_argument('weights')
    p.add_argument('--epochs', type=int, default=12); p.add_argument('--l2', type=float, default=1e-5)
    p.add_argument('--lr', type=float, default=0.05); p.add_argument('--holdout', type=float, default=0.1)
    p.add_argument('--batches', type=int, default=20); p.add_argument('--lr-decay', type=float, default=0.85)
    p.add_argument('--init', default='zero', help="zero | compiled (warm-start from the shipped weights) | .npy")
    p = sub.add_parser('gate0'); p.add_argument('weights'); p.add_argument('chunks', nargs='+')
    p.add_argument('--n', type=int, default=3000); p.add_argument('--cap', type=int, default=600)
    p.add_argument('--workers', type=int, default=os.cpu_count()); p.add_argument('--out', default='')
    p = sub.add_parser('export'); p.add_argument('weights')
    sub.add_parser('lse-table')
    a = ap.parse_args()
    {'extract': cmd_extract, 'train': cmd_train, 'gate0': cmd_gate0, 'export': cmd_export,
     'lse-table': cmd_lse}[a.cmd](a)


if __name__ == '__main__':
    main()
