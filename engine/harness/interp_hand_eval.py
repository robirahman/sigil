"""Interpretability experiment 1: the hand evaluation in plain units (2026-10).

    interp_hand_eval.py <chunk-dir> <human-lines.json> <out.json> [--per-chunk 12] [--per-game 6]

The shipped eval is `tfit_spell_v2 + clamp(net, +-cap)` (engine/reports/
2026-10-interpretability-plan.md). This splits the value of real positions into
the hand evaluation's named terms and the net's correction, from the side to
move's point of view, in centistones (100 = one stone), using the SHIPPED weights
(`se.weights_json`), never restated ones:

    material   lead x weight                                   (never scaled)
    positional each named term x weight x pos_num / pos_den    (one scaled sum)
    spell      per-spell sigil terms, also inside the scaled sum
    tempo      +-tempo for the side to move
    net        evaluate(nnue_spell4) - evaluate(tfit_spell_v2)

For each part it reports the value of one unit, the mean |contribution|, its sd,
its share of the shipped eval's variance (cov(part, total) / var(total), which
sums to 1 over the parts), and how well it alone predicts the game result.
The rebuilt hand eval is checked against `Board.evaluate` on every position.

Positions: round-4 self-play chunks (exploration and opening-blink plies
excluded) and the recorded human games (standard and competitive-opening variants), reported separately.
"""
import argparse, glob, json, os, random, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se

HAND_NAMES = ['lead', 'near_threshold', 'own_zero_liberty', 'own_one_liberty',
              'enemy_zero_liberty', 'enemy_one_liberty', 'sigil_stone', 'sigil_charged',
              'mana', 'sixth_spell_danger', 'control', 'void_penalty', 'tempo',
              'cast_pace', 'mobility']
POSITIONAL = HAND_NAMES[1:12]
UNSCALED = ['cast_pace', 'mobility']
# topology::SIGIL, slot order (as nn_eval.py).
SIGIL = [0x0000000003e, 0x0000007c000, 0x000f8000000, 0x00000000380, 0x00000700000,
         0x00e00000000, 0x00000000040, 0x00000080000, 0x00100000000]
NAMES = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning', 'Grow',
         'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind', 'Sprout', 'Slash', 'Surge',
         'Comet', 'Seal_of_Summer', 'Blossom', 'Scatter', 'Seal_of_Spring', 'Syzygy',
         'Eclipse', 'Azimuth', 'Erupt', 'Fury', 'Charge', 'Hurricane', 'Storm_Front',
         'Gust', 'Tsunami', 'Torrent', 'Splash', 'Harvest', 'Gather', 'Seal_of_Autumn',
         'Corrupt', 'Decay', 'Lurk', 'Seal_of_Destruction', 'Seal_of_Stone',
         'Seal_of_Winter', 'Fissure', 'Rock_Slide', 'Bulwark', 'Dividend', 'Annuity',
         'Endowment']


def mask(nodes):
    m = 0
    for n in nodes:
        m |= 1 << n
    return m


def decompose(b, c, W):
    """Contribution of every part of the shipped eval, centistones, c's POV."""
    f = dict(zip(HAND_NAMES, b.hand_features(c)))
    scale = W['pos_num'] / W['pos_den']
    out = {'lead': W['lead'] * f['lead']}
    pos_raw = 0
    for k in POSITIONAL:
        raw = W[k] * f[k]
        pos_raw += raw
        out[k] = raw * scale
    mine = mask(b.red if c == 'red' else b.blue)
    theirs = mask(b.blue if c == 'red' else b.red)
    t = W['spell_sigil']
    sp_raw = 0
    for p, s in enumerate(b.spell_ids()):
        m = SIGIL[p]; n = bin(m).count('1')
        a, o = bin(m & mine).count('1'), bin(m & theirs).count('1')
        sp_raw += t['stone'][s] * (a * a // n - o * o // n) + t['charged'][s] * ((a == n) - (o == n))
    pos_raw += t['mult'] * sp_raw
    out['spell_sigil'] = t['mult'] * sp_raw * scale
    out['tempo'] = W['tempo'] * f['tempo']
    for k in UNSCALED:
        out[k] = W[k] * f[k]
    # The engine scales the positional SUM once, with integer truncation.
    rebuilt = out['lead'] + int(pos_raw * W['pos_num'] / W['pos_den']) + out['tempo'] \
        + sum(out[k] for k in UNSCALED)
    hand = b.evaluate(c, 'tfit_spell_v2')
    full = b.evaluate(c, se.SHIPPED_EVAL)
    out['net'] = full - hand
    return out, f, hand, full, rebuilt


def selfplay_rows(chunk_dir, per_chunk, rng):
    for path in sorted(glob.glob(os.path.join(chunk_dir, '*.npz'))):
        z = np.load(path)
        rows = [i for i in range(len(z['sfn']))
                if int(z['ply'][i]) >= 2 and not (int(z['kind'][i]) == 1 and int(z['ply'][i]) <= 2)]
        for r in rng.sample(rows, min(per_chunk, len(rows))):
            yield str(z['sfn'][r]), int(z['y'][r]), f"sp{int(z['game'][r])}"


def human_rows(path, per_game, rng):
    lines = json.load(open(path))
    for code in sorted(lines):
        g = lines[code]
        if g.get('variant', 'standard') not in ('standard', 'competitive') or g.get('winner') not in ('red', 'blue'):
            continue
        pos = g['positions']
        if isinstance(pos, str):
            pos = json.loads(pos.replace("'", '"'))
        idx = list(range(2, len(pos)))
        for i in rng.sample(idx, min(per_game, len(idx))):
            mover = 'red' if pos[i].split()[1] == 'r' else 'blue'
            yield pos[i], int(g['winner'] == mover), code


def logloss_of(x, y):
    """Held-in log-loss of a 1-parameter logistic fit of y on x (plus intercept)."""
    from scipy.optimize import minimize
    x = np.asarray(x, float) / 100.0
    def nll(p):
        z = p[0] * x + p[1]
        return np.mean(np.logaddexp(0, z) - y * z)
    r = minimize(nll, [0.5, 0.0], method='Nelder-Mead')
    return float(r.fun), float(r.x[0])


def summarise(rows, W, label):
    parts = ['lead', *POSITIONAL, 'spell_sigil', 'tempo', 'net']
    C = {k: [] for k in parts}; y = []; games = []
    full_l, mismatch = [], 0
    feats = {k: [] for k in HAND_NAMES}
    for sfn, yy, g in rows:
        try:
            b = se.Board.from_sfn(sfn)
        except ValueError:                     # a retired or out-of-scope spell
            continue
        if b.gameover:
            continue
        c = 'red' if sfn.split()[1] == 'r' else 'blue'
        out, f, hand, full, rebuilt = decompose(b, c, W)
        if abs(rebuilt - hand) > 1:
            mismatch += 1
        for k in parts:
            C[k].append(out[k])
        for k in HAND_NAMES:
            feats[k].append(f[k])
        full_l.append(full); y.append(yy); games.append(g)
    y = np.array(y, float); tot = np.array(full_l, float)
    var = tot.var()
    scale = W['pos_num'] / W['pos_den']
    res = {'label': label, 'positions': len(y), 'games': len(set(games)),
           'rebuild_mismatches_over_1cs': mismatch, 'win_rate_side_to_move': float(y.mean()),
           'full_eval_sd_cs': float(tot.std()), 'parts': {}}
    ll_full, _ = logloss_of(tot, y)
    res['logloss_full'] = ll_full
    res['logloss_constant'] = float(-(y.mean() * np.log(y.mean()) + (1 - y.mean()) * np.log(1 - y.mean())))
    for k in parts:
        v = np.array(C[k], float)
        unit = None
        if k == 'lead': unit = W['lead']
        elif k in POSITIONAL: unit = W[k] * scale
        elif k == 'tempo': unit = W['tempo']
        d = {'cs_per_unit': unit, 'mean_abs_cs': float(np.abs(v).mean()), 'sd_cs': float(v.std()),
             'share_of_variance': float(np.cov(v, tot)[0, 1] / var) if var else 0.0,
             'nonzero_frac': float(np.mean(v != 0))}
        if v.std() > 0:
            d['logloss_alone'] = logloss_of(v, y)[0]
        if k in feats:
            fv = np.array(feats[k], float)
            d['feature_mean'] = float(fv.mean()); d['feature_sd'] = float(fv.std())
        res['parts'][k] = d
    net = np.array(C['net'], float)
    res['net_at_cap_frac'] = float(np.mean(np.abs(net) >= 255))
    # What the net corrects: correlation of its residual with each hand feature.
    res['net_corr_with_feature'] = {k: float(np.corrcoef(net, np.array(feats[k], float))[0, 1])
                                    for k in HAND_NAMES if np.std(feats[k]) > 0}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('chunks'); ap.add_argument('human'); ap.add_argument('out')
    ap.add_argument('--per-chunk', type=int, default=12)
    ap.add_argument('--per-game', type=int, default=6)
    a = ap.parse_args()
    W = json.loads(se.weights_json('tfit_spell_v2'))
    rng = random.Random(1)
    out = {'eval': se.SHIPPED_EVAL, 'hand': 'tfit_spell_v2', 'weights': W,
           'spell_table_cs': {NAMES[s]: {'stone_per_unit_cs': W['spell_sigil']['stone'][s] * W['spell_sigil']['mult'] * W['pos_num'] / W['pos_den'],
                                         'charged_cs': W['spell_sigil']['charged'][s] * W['spell_sigil']['mult'] * W['pos_num'] / W['pos_den']}
                              for s in range(len(NAMES))},
           'selfplay': summarise(list(selfplay_rows(a.chunks, a.per_chunk, rng)), W, 'selfplay'),
           'human': summarise(list(human_rows(a.human, a.per_game, rng)), W, 'human')}
    json.dump(out, open(a.out, 'w'), indent=1)
    for src in ('selfplay', 'human'):
        r = out[src]
        print(f"\n{src}: {r['positions']} positions, {r['games']} games, rebuild mismatches {r['rebuild_mismatches_over_1cs']}, "
              f"full-eval sd {r['full_eval_sd_cs']:.0f} cs, logloss full {r['logloss_full']:.4f} vs constant {r['logloss_constant']:.4f}, net at cap {r['net_at_cap_frac']:.1%}")
        print(f"{'part':20s} {'cs/unit':>8s} {'mean|c|':>8s} {'sd':>7s} {'var share':>9s} {'nonzero':>8s} {'ll alone':>8s}")
        for k, d in r['parts'].items():
            u = '' if d['cs_per_unit'] is None else f"{d['cs_per_unit']:.2f}"
            print(f"{k:20s} {u:>8s} {d['mean_abs_cs']:8.1f} {d['sd_cs']:7.1f} {d['share_of_variance']:9.3f} "
                  f"{d['nonzero_frac']:8.2f} {d.get('logloss_alone', float('nan')):8.4f}")
        print('net residual corr with features:', {k: round(v, 2) for k, v in r['net_corr_with_feature'].items()})


if __name__ == '__main__':
    main()
