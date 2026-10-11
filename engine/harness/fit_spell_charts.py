"""Engine spell charts: tier list, matchups and synergies from spell_access_arena.py.

    fit_spell_charts.py <out.json> <log file or dir>... [--sd-int 0.25]
    fit_spell_charts.py --simulate <n_games>        # recovery check on synthetic data

One logistic model of P(red wins) over every game (capped games count 1/2), with
r_s / b_s = spell s is red-only / blue-only in that game:

    logit = alpha[variant]
          + sum_s  beta_s  (r_s - b_s)              value of exclusive access (tier list)
          + sum_s  nu_s    shared_s                 nuisance: s on the board for both
          + sum_st gamma_st (r_s r_t - b_s b_t)      same player holds both (synergy)
          + sum_st delta_st (r_s b_t - b_s r_t)      A-only vs B-only beyond the mains (matchup)

fitted by penalised maximum likelihood (Gaussian priors: sd 1 logit on the main
effects, `--sd-int` on the pair terms, which shrinks pairs the data cannot
resolve towards 0), with Laplace intervals from the penalised Hessian: 95% for
the spell values, 99% for the 990 synergy and 990 matchup terms (so few of the
null pairs get flagged). Elo = 400/ln 10 x logit.

Output: the docs/static/data/spell-charts.json schema (spells, tiers, matchups,
synergies) plus per-spell Elo and 95% intervals, so the Spells page can show it
next to the players' charts. Categories (documented in the file's `method`):
  matchup A vs B (Elo m = beta_A - beta_B + delta_AB): even unless the 99%
    interval excludes 0 and |m| >= MATCH_MIN; strongly favoured when |m| >= MATCH_STRONG;
  synergy (Elo gamma): 0 unless the interval excludes 0 and |gamma| >= SYN_MIN;
    ++ / -- when |gamma| >= SYN_STRONG;
  tiers: the beta order cut into the players' tier sizes scaled to 45 spells.
"""
import argparse, glob, json, math, os, sys
import numpy as np
from scipy import sparse
from scipy.optimize import minimize

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from count_spell_games import NAMES

NS = 45
ELO = 400 / math.log(10)
PAIRS = [(s, t) for s in range(NS) for t in range(s + 1, NS)]
PAIR_IX = {p: i for i, p in enumerate(PAIRS)}
NP = len(PAIRS)
# columns: alpha std, alpha comp | beta 45 | nu 45 | gamma NP | delta NP
C_BETA, C_NU = 2, 2 + NS
C_GAM = 2 + 2 * NS
C_DEL = C_GAM + NP
NCOL = C_DEL + NP
TIERS = [('S', 'Top', 5), ('A', 'Strong', 12), ('B', 'Solid', 6), ('C', 'Middling', 6),
         ('D', 'Weak', 10), ('F', 'Bottom', None)]
MATCH_MIN, MATCH_STRONG = 25.0, 100.0     # Elo
SYN_MIN, SYN_STRONG = 15.0, 60.0          # Elo
NEW_SPELLS = {'Fissure': ('ritual', 'tectonic'), 'Rock_Slide': ('sorcery', 'tectonic'),
              'Bulwark': ('charm', 'tectonic'), 'Endowment': ('ritual', 'providence'),
              'Annuity': ('sorcery', 'providence'), 'Dividend': ('charm', 'providence')}


def read_records(srcs):
    recs = []
    for s in srcs:
        files = sorted(glob.glob(os.path.join(s, '**', '*.log'), recursive=True)) if os.path.isdir(s) else [s]
        for f in files:
            for line in open(f, errors='replace'):
                if line.startswith('RECORD '):
                    recs.append(json.loads(line[7:]))
    seen, out = set(), []
    for r in recs:                      # a re-run shard replays the same seeds
        if r['seed'] not in seen:
            seen.add(r['seed']); out.append(r)
    return out


def design(recs):
    rows, cols, vals = [], [], []
    y = np.zeros(len(recs))
    for i, r in enumerate(recs):
        y[i] = {'red': 1.0, 'blue': 0.0}.get(r['winner'], 0.5)
        own = {s: o for s, o in zip(r['spells'], r['owner'])}
        ent = {1 if r['variant'] == 'competitive' else 0: 1.0}
        red = sorted(s for s, o in own.items() if o == 1)
        blue = sorted(s for s, o in own.items() if o == 2)
        for s, o in own.items():
            if o == 1: ent[C_BETA + s] = 1.0
            elif o == 2: ent[C_BETA + s] = -1.0
            else: ent[C_NU + s] = 1.0
        for side, sign in ((red, 1.0), (blue, -1.0)):
            for a in range(len(side)):
                for b in range(a + 1, len(side)):
                    ent[C_GAM + PAIR_IX[(side[a], side[b])]] = sign
        for s in red:
            for t in blue:
                k = C_DEL + PAIR_IX[(min(s, t), max(s, t))]
                ent[k] = ent.get(k, 0.0) + (1.0 if s < t else -1.0)
        for c, v in ent.items():
            if v:
                rows.append(i); cols.append(c); vals.append(v)
    X = sparse.csr_matrix((vals, (rows, cols)), shape=(len(recs), NCOL))
    return X, y


def prior_prec(sd_main, sd_int):
    p = np.zeros(NCOL)
    p[:2] = 1e-4
    p[C_BETA:C_GAM] = 1 / sd_main ** 2
    p[C_GAM:] = 1 / sd_int ** 2
    return p


def fit(X, y, prec, w=None, x0=None):
    w = np.ones(len(y)) if w is None else w

    def f(th):
        z = X @ th
        ll = np.sum(w * (np.logaddexp(0, z) - y * z))
        g = X.T @ (w * (1 / (1 + np.exp(-z)) - y))
        return ll + 0.5 * np.sum(prec * th * th), g + prec * th
    r = minimize(f, np.zeros(NCOL) if x0 is None else x0, jac=True, method='L-BFGS-B',
                 options={'maxiter': 2000})
    return r.x


Z_MAIN, Z_PAIR = 1.96, 2.576   # 95% for spell values; 99% for the 990+990 pair terms


def summarize(th, X, y, prec):
    """Estimates and Laplace intervals (inverse penalised Hessian at the mode)."""
    z = X @ th
    pz = 1 / (1 + np.exp(-z))
    H = (X.T @ sparse.diags(pz * (1 - pz)) @ X).toarray() + np.diag(prec)
    cov = np.linalg.inv(H) * ELO ** 2
    t = th * ELO
    sd = np.sqrt(np.diag(cov))
    B = slice(C_BETA, C_BETA + NS)
    beta, bsd = t[B], sd[B]
    gam, gsd = t[C_GAM:C_DEL], sd[C_GAM:C_DEL]
    s_ix = np.array([u for u, _ in PAIRS]); t_ix = np.array([v for _, v in PAIRS])
    bs, bt, dl = C_BETA + s_ix, C_BETA + t_ix, C_DEL + np.arange(NP)
    m = t[bs] - t[bt] + t[dl]
    mvar = (cov[bs, bs] + cov[bt, bt] + cov[dl, dl]
            - 2 * cov[bs, bt] + 2 * cov[bs, dl] - 2 * cov[bt, dl])
    msd = np.sqrt(mvar)
    return dict(beta=beta, beta_lo=beta - Z_MAIN * bsd, beta_hi=beta + Z_MAIN * bsd,
                gam=gam, gam_lo=gam - Z_PAIR * gsd, gam_hi=gam + Z_PAIR * gsd,
                m=m, m_lo=m - Z_PAIR * msd, m_hi=m + Z_PAIR * msd)


def charts(S, n_games, base):
    order = sorted(range(NS), key=lambda s: -S['beta'][s])
    spells = {}
    for rank, s in enumerate(order, 1):
        n = NAMES[s]
        info = dict(base.get(n, {}))
        if n in NEW_SPELLS:
            info.setdefault('type', NEW_SPELLS[n][0]); info.setdefault('pack', NEW_SPELLS[n][1])
        info.update(rank=rank, elo=round(float(S['beta'][s]), 1),
                    elo95=[round(float(S['beta_lo'][s]), 1), round(float(S['beta_hi'][s]), 1)])
        spells[n] = info
    tiers, i = [], 0
    for key, name, size in TIERS:
        part = order[i:] if size is None else order[i:i + size]
        tiers.append({'key': key, 'name': name, 'spells': [NAMES[s] for s in part]})
        i += len(part)
    matchups, synergies = [], []
    for k, (s, t) in enumerate(PAIRS):
        m, lo, hi = S['m'][k], S['m_lo'][k], S['m_hi'][k]
        sig = lo > 0 or hi < 0
        if sig and abs(m) >= MATCH_MIN:
            fav, oth = (s, t) if m > 0 else (t, s)
            matchups.append([NAMES[fav], NAMES[oth], 2 if abs(m) >= MATCH_STRONG else 1, round(float(abs(m)), 1)])
        else:
            matchups.append([NAMES[s], NAMES[t], 0, round(float(m), 1)])
        g, glo, ghi = S['gam'][k], S['gam_lo'][k], S['gam_hi'][k]
        lvl = 0
        if (glo > 0 or ghi < 0) and abs(g) >= SYN_MIN:
            lvl = (2 if abs(g) >= SYN_STRONG else 1) * (1 if g > 0 else -1)
        synergies.append([NAMES[s], NAMES[t], lvl, round(float(g), 1)])
    return dict(
        about='Generated by engine/harness/fit_spell_charts.py from spell_access_arena.py self-play; do not hand-edit.',
        source='engine', games=n_games,
        method=(f'Engine self-play with each drawn spell randomly given to red only, blue only or both. '
                f'Tier value = Elo of exclusive access; matchup = red-only A vs blue-only B; synergy = one '
                f'player holding both, beyond the two values. Matchup even unless the 99% interval excludes 0 '
                f'and |Elo| >= {MATCH_MIN:g} (strong >= {MATCH_STRONG:g}); synergy 0 unless the interval excludes '
                f'0 and |Elo| >= {SYN_MIN:g} (strong >= {SYN_STRONG:g}).'),
        spells=spells, tiers=tiers, matchups=matchups, synergies=synergies)


def simulate(n, seed=3):
    """Synthetic records from known parameters: checks the fit recovers them."""
    import random
    sys.path.insert(0, _HERE)
    from spell_access_arena import draw_game
    rng = np.random.default_rng(seed)
    th = np.zeros(NCOL)
    th[0], th[1] = 0.1, -0.05
    th[C_BETA:C_BETA + NS] = rng.normal(0, 0.4, NS)
    th[C_NU:C_NU + NS] = rng.normal(0, 0.1, NS)
    big = rng.choice(NP, 40, replace=False)
    th[C_GAM + big[:20]] = rng.choice([-0.6, 0.6], 20)
    th[C_DEL + big[20:]] = rng.choice([-0.6, 0.6], 20)
    recs = []
    for g in range(n):
        sp, ow, comp = draw_game(random.Random(g), 0.67, 1 / 3)
        recs.append(dict(seed=g, spells=sp, owner=ow, variant='competitive' if comp else 'standard', winner=None))
    X, _ = design(recs)
    p = 1 / (1 + np.exp(-(X @ th)))
    u = rng.random(n)
    for r, pi, ui in zip(recs, p, u):
        r['winner'] = 'red' if ui < pi else 'blue'
    return recs, th, big


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out', nargs='?'); ap.add_argument('src', nargs='*')
    ap.add_argument('--sd-int', type=float, default=0.25)
    ap.add_argument('--simulate', type=int, default=0)
    ap.add_argument('--base', default=os.path.join(_HERE, '..', '..', 'docs', 'static', 'data', 'spell-charts.json'))
    a = ap.parse_args()
    if a.simulate:
        recs, truth, big = simulate(a.simulate)
    else:
        recs = read_records(a.src)
    X, y = design(recs)
    prec = prior_prec(1.0, a.sd_int)
    th = fit(X, y, prec)
    S = summarize(th, X, y, prec)
    print(f'{len(recs)} games; red score {y.mean():.3f}; capped {(y == 0.5).sum()}')
    if a.simulate:
        b_err = (th - truth)[C_BETA:C_BETA + NS] * ELO
        print(f'beta recovery: rmse {np.sqrt(np.mean(b_err ** 2)):.1f} Elo, '
              f'rank corr {np.corrcoef(np.argsort(np.argsort(th[C_BETA:C_BETA+NS])), np.argsort(np.argsort(truth[C_BETA:C_BETA+NS])))[0, 1]:.3f}')
        gt = truth[C_GAM:C_DEL] != 0
        print(f'synergy: true +/-104 Elo pairs recovered with the right sign at 99%: '
              f'{int(np.sum(((S["gam_lo"] > 0) & (truth[C_GAM:C_DEL] > 0)) | ((S["gam_hi"] < 0) & (truth[C_GAM:C_DEL] < 0))))}/{int(gt.sum())}; '
              f'false flags among the {int((~gt).sum())} null pairs: {int(np.sum(((S["gam_lo"] > 0) | (S["gam_hi"] < 0)) & ~gt))}')
        out = charts(S, len(recs), {})
        syn = np.array([x[2] for x in out['synergies']]); mt = np.array([x[2] for x in out['matchups']])
        print(f'charted synergies non-zero: {int((syn != 0)[gt].sum())}/{int(gt.sum())} true, '
              f'{int((syn != 0)[~gt].sum())}/{int((~gt).sum())} null')
        dt = truth[C_DEL:] != 0
        print(f'charted matchups non-even: {int((mt != 0).sum())}/{NP} (true delta pairs {int(dt.sum())})')
        return
    base = json.load(open(a.base))['spells'] if os.path.exists(a.base) else {}
    out = charts(S, len(recs), base)
    json.dump(out, open(a.out, 'w'), indent=1)
    print('tiers:', ' | '.join(f"{t['key']}: {', '.join(t['spells'])}" for t in out['tiers']))
    print(f"matchups non-even: {sum(1 for m in out['matchups'] if m[2])}/{NP}; "
          f"synergies non-zero: {sum(1 for s in out['synergies'] if s[2])}/{NP}")


if __name__ == '__main__':
    main()
