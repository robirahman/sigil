"""Step 2b of the 2026-10 plan: refit the per-spell sigil table on the Step 3 data.

    fit_spell_eval_v2.py <keep_frac> [--smoke] [--src gs://.../v2_2026-10-06] [--out FILE] [--engine DIR]

Same model and method as `fit_spell_eval.py` (step 2), on the v2 self-play data
(`selfplay_v2.py`, engine v23, depth-4 and depth-5 tfit scores) instead of the
2026-08-31 positions, so the Tectonic and Providence spells (ids 39-44) get their
own weights and the core ones are refitted on current-engine games:

    eval'(pos) = tfit(pos) + sum_p ds[spell_p] * stone_p + dc[spell_p] * charged_p

fitted against the depth-4 SEARCH SCORE (soft target sigmoid(k * score)) and, for
the sign check, against the OUTCOME; L2-regularised towards 0, i.e. towards the
shared tfit weights. Charms sit in one-node sigils where stone == charged, so a
charm has a stone column only.

Data handling. The pooled d4 set is ~29 GB of chunks (10 games each, mostly
candidate rows this fit does not read), so chunks are streamed: a `keep_frac`
sample of d4 chunks is downloaded in batches, the few columns needed are extracted
in a process pool, and the files are deleted. Chunks hold whole games, so the
train/test split is by chunk (hash of the name, 20% test). All d5 chunks are kept
as a second held-out set (deeper labels, never trained on).

Offline comparison of the SHIPPED presets, each computed exactly as `eval.rs` does
(integer, truncating, checked against `Board.evaluate` on sampled positions):
`tfit`, `tfit_spell` (the step-2 table) and the candidate `tfit_spell_v2` (this
fit's score table, scaled like step 2 so its worst case is FIT_SHAPE's 1,887 raw,
x3 inside one 96 cs budget). Each gets its own texel scale fitted on train
outcomes; reported on test outcome log-loss and score cross-entropy, overall, on
positions whose draw holds an expansion spell, and on d5.

Writes everything to `--out` (default /opt/sigil/out/fit_spell_v2.txt, which the
cloud runner ships) and prints the new table as Rust arrays.
"""
import hashlib, json, os, subprocess, sys, tempfile, time
from multiprocessing import Pool
import numpy as np

try:
    import scipy  # noqa: F401
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', '-q', 'install', 'scipy'], check=True)
from scipy import sparse
from scipy.optimize import minimize

NSP = 45
SIZES = np.array([5, 5, 5, 3, 3, 3, 1, 1, 1])
# spells_meta.rs roles: 0 ritual, 1 sorcery, 2 charm.
ROLE = np.array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2,
                 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 2, 1, 0])
NAMES = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning', 'Grow',
         'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind', 'Sprout', 'Slash', 'Surge',
         'Comet', 'Seal_of_Summer', 'Blossom', 'Scatter', 'Seal_of_Spring', 'Syzygy',
         'Eclipse', 'Azimuth', 'Erupt', 'Fury', 'Charge', 'Hurricane', 'Storm_Front',
         'Gust', 'Tsunami', 'Torrent', 'Splash', 'Harvest', 'Gather', 'Seal_of_Autumn',
         'Corrupt', 'Decay', 'Lurk', 'Seal_of_Destruction', 'Seal_of_Stone',
         'Seal_of_Winter', 'Fissure', 'Rock_Slide', 'Bulwark', 'Dividend', 'Annuity',
         'Endowment']
EXPANSION = [39, 40, 41, 42, 43, 44]
HAND = ['lead', 'near_threshold', 'own_zero_liberty', 'own_one_liberty',
        'enemy_zero_liberty', 'enemy_one_liberty', 'sigil_stone', 'sigil_charged',
        'mana', 'sixth_spell_danger', 'control', 'void_penalty', 'tempo',
        'cast_pace', 'mobility']
FIT_POS = {'near_threshold': 56, 'own_zero_liberty': 1, 'own_one_liberty': 15,
           'enemy_zero_liberty': 3, 'enemy_one_liberty': -17, 'sigil_stone': 36,
           'sigil_charged': 2, 'mana': 82, 'sixth_spell_danger': 64, 'control': 3,
           'void_penalty': -22}
FIT_WORST = 1887          # unscaled_worst_case(FIT_SHAPE)
BUDGET = 96
MATE = 5000               # search::UNPROVEN_MATE; scores at or past it are not targets
# Step 2's table (eval.rs SPELL_SIGIL_FIT), mult 1.
OLD_STONE = [9, 87, 50, 23, 22, 3, 21, 61, 4, 1, -22, 40, -53, -57, -44, -27, -7, -17, 81,
             28, -10, -3, 73, 19, -10, 21, -44, 50, 24, 31, 54, -2, -33, 36, -4, 10, -52,
             48, -9, 0, 0, 0, 0, 0, 0]
OLD_CHARGED = [-3, 8, 3, 0, 7, -4, 6, 16, -3, -1, 0, 0, 0, 0, 0, -7, -5, 0, 6, 7, 0, 0,
               22, 0, -4, -3, 0, 2, 7, 0, 3, -4, 0, 4, -4, 0, -9, 20, 0, 0, 0, 0, 0, 0, 0]
NONCHARM = [s for s in range(NSP) if ROLE[s] != 2]
NCOL = NSP + len(NONCHARM)
COL_CHARGED = {s: NSP + i for i, s in enumerate(NONCHARM)}

OUT_LINES = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    OUT_LINES.append(s)


# ----------------------------------------------------------------------------- data

def extract(path):
    try:
        z = np.load(path)
        full = z['full']
        if len(full) == 0:
            return None
        fm = np.rint(full[:, 78:87] * SIZES).astype(np.int16)
        ft = np.rint(full[:, 87:96] * SIZES).astype(np.int16)
        r = {
            'stone': (fm * fm // SIZES - ft * ft // SIZES).astype(np.int8),
            'charged': ((fm == SIZES).astype(np.int8) - (ft == SIZES)).astype(np.int8),
            'hand': z['hand'].astype(np.int16),
            'spells': z['spells'].astype(np.uint8),
            'y': z['y'].astype(np.uint8),
            'score': z['score'].astype(np.int32),
            'kind': z['kind'].astype(np.uint8),
            'is_red': z['is_red'].astype(np.uint8),
        }
        sfn = z['sfn']
        k = min(3, len(sfn))
        r['sample'] = [(str(sfn[i]), int(z['is_red'][i]), i) for i in range(k)]
        os.remove(path)
        return os.path.basename(path), r
    except Exception as e:  # a truncated chunk is skipped, and counted
        try:
            os.remove(path)
        except OSError:
            pass
        return os.path.basename(path), {'error': repr(e)}


def is_test(name):
    return int(hashlib.md5(name.encode()).hexdigest(), 16) % 5 == 0


def keep(name, frac):
    return (int(hashlib.sha1(name.encode()).hexdigest(), 16) % 10_000) < frac * 10_000


def gather(prefix, frac, tmp, workers, max_files=None):
    ls = subprocess.run(['gcloud', 'storage', 'ls', prefix + '/*.npz'],
                        capture_output=True, text=True, check=True).stdout.split()
    names = [u for u in ls if keep(os.path.basename(u), frac)]
    if max_files:
        names = names[:max_files]
    log(f'{prefix}: {len(ls)} chunks, keeping {len(names)}')
    parts, samples, errors = [], [], 0
    B = 2000
    with Pool(workers) as pool:
        for i in range(0, len(names), B):
            batch = names[i:i + B]
            # One gcloud process manages ~3 small objects a second; run many.
            P = 24
            procs = [subprocess.Popen(['gcloud', 'storage', 'cp', '-q', '-I', tmp],
                                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, text=True)
                     for _ in range(P)]
            for j, pr in enumerate(procs):
                pr.stdin.write('\n'.join(batch[j::P]))
                pr.stdin.close()
            for pr in procs:
                pr.wait()
            paths = [os.path.join(tmp, os.path.basename(u)) for u in batch]
            for name, r in pool.imap_unordered(extract, paths, chunksize=8):
                if r is None:
                    continue
                if 'error' in r:
                    errors += 1
                    continue
                r['test'] = np.full(len(r['y']), is_test(name), bool)
                samples += [(s, red) for s, red, _ in r.pop('sample')]
                parts.append(r)
            log(f'  {min(i + B, len(names))}/{len(names)} chunks, '
                f'{sum(len(p["y"]) for p in parts)} positions, {errors} unreadable')
    D = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    return D, samples, errors


# ----------------------------------------------------------------------------- evals

def worst_case(stone, charged):
    tot = 0
    for g, n in ((0, 5), (1, 3), (2, 1)):
        v = sorted((abs(stone[s]) * n + abs(charged[s]) for s in range(NSP) if ROLE[s] == g),
                   reverse=True)
        tot += sum(v[:3])
    return tot


def preset(table_stone=None, table_charged=None, mult=3):
    """(num, den, stone, charged, mult) for at_budget(FIT_SHAPE + table x mult)."""
    if table_stone is None:
        return (BUDGET, FIT_WORST, None, None, 0)
    return (BUDGET, FIT_WORST + mult * worst_case(table_stone, table_charged),
            np.asarray(table_stone, np.int64), np.asarray(table_charged, np.int64), mult)


def tdiv(a, d):
    return np.sign(a) * (np.abs(a) // d)


def evaluate(D, idx, p):
    num, den, ts, tc, mult = p
    h = D['hand'][idx].astype(np.int64)
    pos = np.zeros(len(idx), np.int64)
    for k, w in FIT_POS.items():
        pos += w * h[:, HAND.index(k)]
    if ts is not None:
        sp = D['spells'][idx].astype(np.int64)
        st = D['stone'][idx].astype(np.int64)
        ch = D['charged'][idx].astype(np.int64)
        acc = (ts[sp] * st + tc[sp] * ch).sum(axis=1)
        pos += mult * acc
    return 100 * h[:, HAND.index('lead')] + tdiv(pos * num, den) + 50 * h[:, HAND.index('tempo')]


# ----------------------------------------------------------------------------- fit

def design(D, idx):
    sp = D['spells'][idx].astype(np.int64)
    n = len(idx)
    rows = np.repeat(np.arange(n), 9)
    st = D['stone'][idx].astype(np.float64).ravel()
    ch = D['charged'][idx].astype(np.float64).ravel()
    spr = sp.ravel()
    ccol = np.array([COL_CHARGED.get(s, -1) for s in range(NSP)])[spr]
    m = ccol >= 0
    data = np.concatenate([st, ch[m]])
    r = np.concatenate([rows, rows[m]])
    c = np.concatenate([spr, ccol[m]])
    return sparse.csr_matrix((data, (r, c)), shape=(n, NCOL))


def xent(z, t):
    return float(np.mean(np.logaddexp(0, z) - t * z))


def fit_scale(e, t):
    e = e / 100.0
    def f(p):
        z = p[0] * e + p[1]
        g = 1 / (1 + np.exp(-z)) - t
        return xent(z, t), np.array([np.mean(g * e), np.mean(g)])
    return minimize(f, [0.5, 0.0], jac=True, method='L-BFGS-B').x


def fit_deltas(X, e0, t, k, b, lam=1e-6):
    n = X.shape[0]
    base = k * e0 / 100.0 + b
    def f(d):
        z = base + k * (X @ d) / 100.0
        g = X.T @ (1 / (1 + np.exp(-z)) - t) * (k / 100.0) / n
        return xent(z, t) + lam * float(d @ d), g + 2 * lam * d
    return minimize(f, np.zeros(X.shape[1]), jac=True, method='L-BFGS-B',
                    options={'maxiter': 3000, 'gtol': 1e-12, 'ftol': 1e-15}).x


def masks(D, idx):
    sc = D['score'][idx]
    ms = np.abs(sc) < MATE
    my = D['y'][idx] != 255
    return ms, my


def split_fit(D, tr, te, k_ref, tag):
    """Step-2 style: deltas on top of tfit, outcome fit and score fit, held-out metrics."""
    e_tr = evaluate(D, tr, preset()).astype(np.float64)
    e_te = evaluate(D, te, preset()).astype(np.float64)
    ms_tr, my_tr = masks(D, tr)
    ms_te, my_te = masks(D, te)
    k, b = fit_scale(e_tr[my_tr], D['y'][tr][my_tr].astype(np.float64))
    Xtr, Xte = design(D, tr), design(D, te)
    ts_tr = 1 / (1 + np.exp(-k_ref * D['score'][tr][ms_tr] / 100))
    ts_te = 1 / (1 + np.exp(-k_ref * D['score'][te][ms_te] / 100))
    d_out = fit_deltas(Xtr[my_tr], e_tr[my_tr], D['y'][tr][my_tr].astype(np.float64), k, b)
    d_sc = fit_deltas(Xtr[ms_tr], e_tr[ms_tr], ts_tr, k, b)
    res = {'tag': tag, 'k': float(k), 'b': float(b), 'n_train': int(len(tr)), 'n_test': int(len(te))}
    z0 = k * e_te / 100 + b
    yte = D['y'][te].astype(np.float64)
    res['base'] = {'outcome_ll': xent(z0[my_te], yte[my_te]), 'score_xent': xent(z0[ms_te], ts_te)}
    for name, d in (('outcome_fit', d_out), ('score_fit', d_sc)):
        z1 = z0 + k * (Xte @ d) / 100
        res[name] = {'outcome_ll': xent(z1[my_te], yte[my_te]), 'score_xent': xent(z1[ms_te], ts_te)}
    res['d_outcome'] = d_out.tolist()
    res['d_score'] = d_sc.tolist()
    log(f"{tag}: n={len(tr)}/{len(te)}  base {res['base']}\n"
        f"{tag}:   outcome-fit {res['outcome_fit']}\n{tag}:   score-fit   {res['score_fit']}")
    return res


def per_spell(d):
    """Column vector -> (stone[45], charged[45]) in centistones."""
    st = np.array(d[:NSP])
    ch = np.zeros(NSP)
    for s, c in COL_CHARGED.items():
        ch[s] = d[c]
    return st, ch


def to_table(d):
    st, ch = per_spell(d)
    lo, hi = 0.0, 1000.0
    for _ in range(60):          # largest scale whose rounded table fits in FIT_WORST
        c = (lo + hi) / 2
        if worst_case(np.rint(c * st).astype(int), np.rint(c * ch).astype(int)) <= FIT_WORST:
            lo = c
        else:
            hi = c
    return (np.rint(lo * st).astype(int).tolist(), np.rint(lo * ch).astype(int).tolist(), lo)


def compare_presets(D, tr, te, presets, k_ref, subsets):
    out = {}
    ms_tr, my_tr = masks(D, tr)
    for name, p in presets.items():
        e_tr = evaluate(D, tr, p).astype(np.float64)
        k, b = fit_scale(e_tr[my_tr], D['y'][tr][my_tr].astype(np.float64))
        out[name] = {'k': float(k)}
        for sname, sidx in subsets.items():
            e = evaluate(D, sidx, p).astype(np.float64)
            z = k * e / 100 + b
            ms, my = masks(D, sidx)
            ts = 1 / (1 + np.exp(-k_ref * D['score'][sidx][ms] / 100))
            out[name][sname] = {'n': int(len(sidx)),
                                'outcome_ll': xent(z[my], D['y'][sidx][my].astype(np.float64)),
                                'score_xent': xent(z[ms], ts)}
        log(f'preset {name}: ' + json.dumps(out[name]))
    return out


def check_exact(samples, D_eval_fn):
    """Compare the numpy evals against Board.evaluate on sampled positions."""
    try:
        import sigil_engine as se
    except ImportError:
        log('check_exact: sigil_engine not importable, SKIPPED')
        return None
    bad = 0
    for (sfn, red), vals in D_eval_fn(samples):
        b = se.Board.from_sfn(sfn)
        side = 'red' if red else 'blue'
        for ev, v in vals.items():
            if b.evaluate(side, ev) != v:
                bad += 1
    log(f'check_exact: {len(samples)} positions, {bad} mismatches')
    return bad


def sample_rows(samples):
    """Recompute hand/stone/charged/spells for sample SFNs through the binding."""
    import sigil_engine as se
    rows = {'hand': [], 'stone': [], 'charged': [], 'spells': []}
    for sfn, red in samples:
        b = se.Board.from_sfn(sfn)
        side = 'red' if red else 'blue'
        full = np.asarray(b.full_features(side), np.float32)[None]
        fm = np.rint(full[:, 78:87] * SIZES).astype(np.int16)
        ft = np.rint(full[:, 87:96] * SIZES).astype(np.int16)
        rows['stone'].append((fm * fm // SIZES - ft * ft // SIZES)[0])
        rows['charged'].append(((fm == SIZES).astype(np.int8) - (ft == SIZES))[0])
        rows['hand'].append(np.asarray(b.hand_features(side)))
        rows['spells'].append(np.asarray(b.spell_ids()))
    return {k: np.asarray(v) for k, v in rows.items()}


# ----------------------------------------------------------------------------- main

def main():
    a = sys.argv[1:]
    frac = float(a[0])
    smoke = '--smoke' in a
    src = a[a.index('--src') + 1] if '--src' in a else 'gs://focus-surfer-494820-g0-sigil/data/s3/v2_2026-10-06'
    out = a[a.index('--out') + 1] if '--out' in a else '/opt/sigil/out/fit_spell_v2.txt'
    if '--engine' in a:   # a directory holding a locally built sigil_engine.so
        sys.path.insert(0, a[a.index('--engine') + 1])
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    workers = max(1, (os.cpu_count() or 2) - 1)
    tmp = tempfile.mkdtemp(prefix='s2b_')
    t0 = time.time()
    D, samples, err4 = gather(src + '/d4', frac, tmp, workers, max_files=40 if smoke else None)
    D5, s5, err5 = gather(src + '/d5', 1.0 if not smoke else frac, tmp, workers,
                          max_files=20 if smoke else None)
    log(f'loaded in {time.time() - t0:.0f}s: d4 {len(D["y"])} positions ({err4} bad chunks), '
        f'd5 {len(D5["y"])} ({err5} bad)')

    # Row counts per spell (positions whose draw holds it), d4 and d5.
    counts = {}
    for s in range(NSP):
        counts[NAMES[s]] = [int((D['spells'] == s).any(axis=1).sum()),
                            int((D5['spells'] == s).any(axis=1).sum())]
    log('rows per spell [d4, d5]: ' + json.dumps(counts))
    kinds = np.bincount(D['kind'], minlength=3).tolist()
    log(f'kinds fresh/comp/human: {kinds};  y=255 (ply cap) {int((D["y"] == 255).sum())};  '
        f'mate-scored {int((np.abs(D["score"]) >= MATE).sum())}')

    # Exactness of the numpy evals against the engine (tfit, tfit_spell).
    try:
        R = sample_rows(samples[:600])
        n = len(R['hand'])
        Rd = {'hand': R['hand'], 'stone': R['stone'], 'charged': R['charged'], 'spells': R['spells']}
        idx = np.arange(n)
        vt = evaluate(Rd, idx, preset())
        vs = evaluate(Rd, idx, preset(OLD_STONE, OLD_CHARGED))
        check_exact(samples[:600], lambda smp: [(smp[i], {'tfit': int(vt[i]), 'tfit_spell': int(vs[i])})
                                                for i in range(len(smp))])
    except Exception as e:
        log(f'check_exact failed: {e!r}')

    allidx = np.arange(len(D['y']))
    te_m = D['test']
    tr, te = allidx[~te_m], allidx[te_m]
    # k_ref: tfit's texel scale on train outcomes, used for every score target.
    _, my = masks(D, tr)
    k_ref, _ = fit_scale(evaluate(D, tr, preset()).astype(np.float64)[my],
                         D['y'][tr][my].astype(np.float64))
    log(f'k_ref = {k_ref:.4f} per stone; '
        f'corr(tfit, d4 score) = {np.corrcoef(evaluate(D, allidx, preset())[np.abs(D["score"]) < MATE], D["score"][np.abs(D["score"]) < MATE])[0, 1]:.4f}')

    result = {'counts': counts, 'kinds': kinds, 'k_ref': float(k_ref)}
    result['game_split'] = split_fit(D, tr, te, k_ref, 'game')
    folds = [[0, 15, 5, 16, 10, 17], [1, 18, 6, 19, 11, 20], [2, 21, 7, 22, 12, 23], EXPANSION]
    result['spell_split'] = []
    for hold in folds:
        h = np.zeros(256, bool); h[hold] = True
        uses = h[D['spells']].any(axis=1)
        r = split_fit(D, allidx[~uses], allidx[uses], k_ref, f'hold{[NAMES[s] for s in hold]}')
        r['holdout'] = hold
        result['spell_split'].append(r)

    # Signs: score fit vs outcome fit, per spell.
    sst, sch = per_spell(result['game_split']['d_score'])
    ost, och = per_spell(result['game_split']['d_outcome'])
    signs = []
    for s in range(NSP):
        for kind, a_, b_ in (('stone', sst[s], ost[s]), ('charged', sch[s], och[s])):
            if kind == 'charged' and ROLE[s] == 2:
                continue
            signs.append({'spell': NAMES[s], 'term': kind, 'score_fit': round(float(a_), 2),
                          'outcome_fit': round(float(b_), 2),
                          'agree': bool(np.sign(a_) == np.sign(b_) or abs(a_) < 0.5)})
    dis = [x for x in signs if not x['agree']]
    log(f'sign disagreements with |score delta| >= 0.5 cs: {len(dis)} {dis}')
    result['signs'] = signs

    stone, charged, scale = to_table(result['game_split']['d_score'])
    result['table'] = {'stone': stone, 'charged': charged, 'scale': scale,
                       'worst_case': worst_case(stone, charged)}
    log(f'NEW TABLE (scale {scale:.3f}, worst case {worst_case(stone, charged)} raw)')
    log('    stone: [' + ', '.join(map(str, stone)) + '],')
    log('    charged: [' + ', '.join(map(str, charged)) + '],')

    presets = {'tfit': preset(), 'tfit_spell': preset(OLD_STONE, OLD_CHARGED),
               'tfit_spell_v2': preset(stone, charged)}
    hx = np.zeros(256, bool); hx[EXPANSION] = True
    exp_te = te[hx[D['spells'][te]].any(axis=1)]
    core_te = te[~hx[D['spells'][te]].any(axis=1)]
    subsets = {'test': te, 'test_expansion': exp_te, 'test_core_only': core_te}
    result['presets'] = compare_presets(D, tr, te, presets, k_ref, subsets)
    # d5: separate arrays; scales from d4 train.
    d5 = {}
    i5 = np.arange(len(D5['y']))
    hx5 = hx[D5['spells']].any(axis=1)
    for name, p in presets.items():
        _, my = masks(D, tr)
        k, b = fit_scale(evaluate(D, tr, p).astype(np.float64)[my], D['y'][tr][my].astype(np.float64))
        e = evaluate(D5, i5, p).astype(np.float64)
        z = k * e / 100 + b
        ms, my5 = masks(D5, i5)
        ts = 1 / (1 + np.exp(-k_ref * D5['score'][ms] / 100))
        d5[name] = {'outcome_ll': xent(z[my5], D5['y'][my5].astype(np.float64)),
                    'score_xent': xent(z[ms], ts),
                    'expansion_outcome_ll': xent(z[my5 & hx5], D5['y'][my5 & hx5].astype(np.float64)),
                    'expansion_score_xent': xent(z[ms & hx5], 1 / (1 + np.exp(-k_ref * D5['score'][ms & hx5] / 100)))}
        log(f'd5 {name}: {json.dumps(d5[name])}')
    result['d5'] = d5

    with open(out[:-4] + '_json.txt', 'w') as f:
        json.dump(result, f, default=float)
    with open(out, 'w') as f:
        f.write('\n'.join(OUT_LINES) + '\n')
    log(f'WROTE {out} (+ _json.txt) in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
