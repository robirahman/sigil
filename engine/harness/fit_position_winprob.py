"""Fit eval -> P(red wins) for rated games from a position.

    fit_position_winprob.py <out.json> <log> [<log> ...] [--v31 'glob'] [--report report.md]

Each <log> is a position_selfplay.py shard log (local path or gs:// URL); its
`POSRESULT {json}` lines hold the start, the start's eval at each depth and the
winner of Very Hard vs Very Hard from there. Per depth d the model is

    logit P(red wins) = a + b * s + c * [red to move] + (aPhase + bPhase * s) * phase

with s the depth-d eval in stones from red's side (the even-game offset
applied, so 0 is even) and phase = min(turn counter, 60) / 60 of the start
SFN (the side to move's SFN, as the site prices it). The phase terms were
kept because they won held-out log-loss in every one of five folds at each
depth (2026-10 fit: a stone is worth less late in the game). A proven mate is a certainty and is left out of the
fit (a proven mate that LOST is counted and reported: it is an engine bug); a
"likely" mate gets the observed win rate of the side it favours
(`likelyMateWin`, with one win and one loss of prior). Games that hit the ply
cap are dropped.

Held-out check: positions whose index i % 5 == 0 are held out of a second
fit, and the report gives held-out log-loss against a constant, a reliability
table (predicted vs observed red wins by bucket), and the mean of
(score - expected score) for each side and bucket -- the quantity the rated
payoffs need to be zero. CIs on a, b, c come from 300 bootstrap resamples of
starts. --v31 adds the cheap cross-check: the same slope fitted on depth-5
self-play chunks (selfplay_v2 npz, score from the side to move, no offset).

Writes docs/static/data/position-winprob.json's shape: {version, target,
evalName, depths: {"4": {a, b, c, likelyMateWin, n}, ...}, ...}.
"""
import glob, json, subprocess, sys, time
import numpy as np


def read(path):
    if path.startswith('gs://'):
        return subprocess.run(['gcloud', 'storage', 'cat', path], capture_output=True,
                              text=True, check=True).stdout
    return open(path).read()


def load(paths):
    recs, seen = [], set()
    for p in paths:
        for line in read(p).splitlines():
            if line.startswith('POSRESULT '):
                r = json.loads(line[10:])
                if r['i'] in seen:
                    continue
                seen.add(r['i'])
                recs.append(r)
    return recs


def rows(recs, d):
    """(i, s_red, red_to_move, y_red, kind, phase) per start; kind 'eval' | 'proven' | 'likely'."""
    out = []
    for r in recs:
        e = r['evals'].get(str(d))
        if not e or r['winner'] not in ('red', 'blue'):
            continue
        sign = 1 if e['mover'] == 'red' else -1
        y = 1 if r['winner'] == 'red' else 0
        rtm = 1 if e['mover'] == 'red' else 0
        ph = min(int(r['sfn'].split()[2]), 60) / 60
        if e.get('mate'):
            out.append((r['i'], (1 if e['mate'] * sign > 0 else -1), rtm, y,
                        'proven' if e.get('proven') else 'likely', ph))
        elif e.get('stones') is not None:
            out.append((r['i'], e['stones'] * sign, rtm, y, 'eval', ph))
    return out


def fit_logistic(X, y, iters=50, ridge=1e-6):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + ridge * w
        H = (X * (p * (1 - p))[:, None]).T @ X + ridge * np.eye(X.shape[1])
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-10:
            break
    return w


def logloss(p, y):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def design(R):
    s = np.array([r[1] for r in R], float)
    rtm = np.array([r[2] for r in R], float)
    ph = np.array([r[5] for r in R], float)
    return np.column_stack([np.ones(len(R)), s, rtm, ph, s * ph]), np.array([r[3] for r in R], float)


def fit_depth(recs, d, rng):
    R = rows(recs, d)
    ev = [r for r in R if r[4] == 'eval']
    likely = [r for r in R if r[4] == 'likely']
    proven = [r for r in R if r[4] == 'proven']
    X, y = design(ev)
    w = fit_logistic(X, y)
    # bootstrap over starts
    boots = []
    for _ in range(300):
        idx = rng.integers(0, len(ev), len(ev))
        boots.append(fit_logistic(X[idx], y[idx]))
    lo, hi = np.percentile(boots, [2.5, 97.5], axis=0)
    # held-out
    test = np.array([r[0] % 5 == 0 for r in ev])
    wt = fit_logistic(X[~test], y[~test])
    pt = 1 / (1 + np.exp(-X[test] @ wt))
    base = np.full(test.sum(), y[~test].mean())
    # likely mates: win rate of the favoured side, one win + one loss of prior
    fav_wins = sum(1 for r in likely if (r[1] > 0) == (r[3] == 1))
    lmw = (fav_wins + 1) / (len(likely) + 2)
    proven_lost = sum(1 for r in proven if (r[1] > 0) != (r[3] == 1))
    # reliability + E[S - E] per side on held-out positions
    rel = []
    for a_, b_ in [(0, .1), (.1, .3), (.3, .5), (.5, .7), (.7, .9), (.9, 1.01)]:
        m = (pt >= a_) & (pt < b_)
        if m.sum():
            rel.append(dict(bucket=f'{a_:.1f}-{min(b_, 1):.1f}', n=int(m.sum()),
                            pred=float(pt[m].mean()), obs=float(y[test][m].mean()),
                            red_s_minus_e=float((y[test][m] - pt[m]).mean())))
    names = ('a', 'b', 'c', 'aPhase', 'bPhase')
    # held-out side check: mean (score - expected) for red and for blue
    side = dict(red=float((y[test] - pt).mean()), blue=float(((1 - y[test]) - (1 - pt)).mean()))
    return dict(
        **{k: float(w[j]) for j, k in enumerate(names)},
        ci={k: [float(lo[j]), float(hi[j])] for j, k in enumerate(names)},
        heldout_side_s_minus_e=side,
        likelyMateWin=lmw, n=len(ev), n_likely=len(likely), n_proven=len(proven), proven_lost=proven_lost,
        heldout=dict(n=int(test.sum()), logloss=logloss(pt, y[test]), const=logloss(base, y[test]),
                     red_rate=float(y.mean())),
        reliability=rel,
    )


def v31_slope(pattern):
    s, y = [], []
    for f in sorted(glob.glob(pattern)):
        z = np.load(f, allow_pickle=True)
        keep = z['y'] != 255
        s.append(z['score'][keep] / 100.0)
        y.append(z['y'][keep].astype(float))
    s, y = np.concatenate(s), np.concatenate(y)
    keep = np.abs(s) < 40          # mates and unproven-mate clamps
    X = np.column_stack([np.ones(keep.sum()), s[keep]])
    w = fit_logistic(X, y[keep])
    return dict(n=int(keep.sum()), a=float(w[0]), b=float(w[1]))


def main():
    a = sys.argv[1:]
    out = a[0]
    v31 = report = None
    logs = []
    i = 1
    while i < len(a):
        if a[i] == '--v31':
            v31 = a[i + 1]; i += 2
        elif a[i] == '--report':
            report = a[i + 1]; i += 2
        else:
            logs.append(a[i]); i += 1
    recs = load(logs)
    rng = np.random.default_rng(1)
    depths = sorted({int(k) for r in recs for k in r['evals']})
    fits = {str(d): fit_depth(recs, d, rng) for d in depths}
    capped = sum(1 for r in recs if r['winner'] not in ('red', 'blue'))
    model = dict(
        version=time.strftime('%Y-%m-%d'),
        target='P(red wins) with the Very Hard AI (60 s a move) playing both sides from the position',
        evalName=recs[0]['eval'] if recs else None,
        msPerMove=recs[0]['ms'] if recs else None,
        games=len(recs), capped=capped,
        phase='min(turn counter, 60) / 60',
        depths={d: dict(a=f['a'], b=f['b'], c=f['c'], aPhase=f['aPhase'], bPhase=f['bPhase'],
                        likelyMateWin=f['likelyMateWin'], n=f['n'])
                for d, f in fits.items()},
    )
    json.dump(model, open(out, 'w'), indent=1)
    full = dict(model=model, fits=fits)
    if v31:
        full['v31_depth5_selfplay'] = v31_slope(v31)
    print(json.dumps(full, indent=1))
    if report:
        json.dump(full, open(report, 'w'), indent=1)


if __name__ == '__main__':
    main()
