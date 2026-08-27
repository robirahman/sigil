"""C2 + C3: is there positional signal a material eval cannot see, and does it
generalise to unseen spells?

    fit_learnability.py <data_dir_or_npz> [holdout_spells]

This is the cheap gate that can kill the learned-eval programme before a line of
Rust NNUE code is written. Three models predict **who eventually won** from a
single position:

    (a) logistic on `lead` alone            -- what the shipped engine can express
    (b) logistic on the 12 hand features    -- the TEXEL FIT, and the control that
                                               this project never ran: three arena
                                               campaigns rejected hand-CHOSEN
                                               weights, which says nothing about
                                               fitted ones
    (c) MLP on the 132 full features        -- can a model see more than (b)?

**Kill criterion (C2):** if (c) does not beat (a) by >= 0.05 nats over plies 10-25,
there is no learnable positional signal worth a network, and the plan changes.

**C3:** the same fit with a held-out SPELL split -- train on games whose 9-spell
draw avoids a set of spells entirely, test on games that use them. That is the real
generalisation question, because Sigil draws 9 of 39 spells per game so the
evaluation is conditional on a per-game rule set. Splitting by game would not test
it; splitting by spell does.

METHOD NOTE, and it is the difference between a real answer and a flattering one:
splits are by GAME, never by position. Every position in a game shares that game's
outcome label, so a position-level split leaks the label into the test set and
inflates every model -- most of all the flexible one, which is exactly the
comparison this test turns on.

Harness-only dependency: scikit-learn (see requirements-dev.txt). Nothing in the
engine or the game needs it.
"""
import os, sys, glob
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import log_loss

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)


def load(path):
    files = ([path] if path.endswith('.npz')
             else sorted(glob.glob(os.path.join(path, '*.npz'))))
    if not files:
        sys.exit(f"no .npz found under {path}")
    parts = [np.load(f, allow_pickle=True) for f in files]
    out = {}
    for k in ('hand', 'full', 'spells', 'ply', 'is_red', 'y'):
        out[k] = np.concatenate([p[k] for p in parts])
    # game ids: use the recorded field when present, else reconstruct from ply
    # resetting to 0, which marks a game boundary because rows are appended in
    # play order. Offset per file so ids never collide across shards.
    gids = []
    base = 0
    for p in parts:
        if 'game' in p.files:
            g = p['game'].astype(np.int64)
        else:
            g = np.cumsum(p['ply'] == 0) - 1
        gids.append(g + base)
        base = gids[-1].max() + 1
    out['game'] = np.concatenate(gids)
    out['names'] = list(parts[0]['hand_names'])
    print(f"loaded {len(files)} shard(s): {len(out['y'])} positions, "
          f"{len(np.unique(out['game']))} games, label mean {out['y'].mean():.3f}")
    return out


def game_split(game, frac=0.25, seed=0):
    """Split by GAME. See the method note in the module docstring."""
    g = np.unique(game)
    rng = np.random.default_rng(seed)
    rng.shuffle(g)
    test_g = set(g[:max(1, int(len(g) * frac))].tolist())
    is_test = np.fromiter((x in test_g for x in game), bool, len(game))
    return ~is_test, is_test


def spell_split(spells, holdout):
    """Train on games whose draw avoids `holdout` entirely; test on games using it."""
    hold = np.zeros(64, bool)
    for s in holdout:
        hold[s] = True
    uses = hold[spells].any(axis=1)
    return ~uses, uses


def evaluate(name, model, Xtr, ytr, Xte, yte, ply_te, scale=True):
    if scale:
        sc = StandardScaler().fit(Xtr)
        Xtr, Xte = sc.transform(Xtr), sc.transform(Xte)
    model.fit(Xtr, ytr)
    p = model.predict_proba(Xte)[:, 1]
    p = np.clip(p, 1e-6, 1 - 1e-6)
    overall = log_loss(yte, p, labels=[0, 1])
    mid = (ply_te >= 10) & (ply_te <= 25)
    midloss = log_loss(yte[mid], p[mid], labels=[0, 1]) if mid.sum() > 20 else float('nan')
    return overall, midloss, model


def run(d, tr, te, tag):
    yt, ye = d['y'][tr], d['y'][te]
    plyte = d['ply'][te]
    if len(np.unique(ye)) < 2 or te.sum() < 100:
        print(f"  [{tag}] test set too small or single-class; skipped")
        return None
    names = d['names']
    li = names.index('lead')
    # (a) material only
    a_all, a_mid, _ = evaluate('a', LogisticRegression(max_iter=2000),
                               d['hand'][tr][:, [li]], yt,
                               d['hand'][te][:, [li]], ye, plyte)
    # (b) the 12 hand features. `tempo` is constant (positions are recorded from
    # the side-to-move's POV) so it is dropped -- keeping it would just add a
    # collinear intercept.
    keep = [i for i, n in enumerate(names) if n != 'tempo']
    b_all, b_mid, bmodel = evaluate('b', LogisticRegression(max_iter=4000),
                                    d['hand'][tr][:, keep], yt,
                                    d['hand'][te][:, keep], ye, plyte)
    # (c) MLP on the full board features
    c_all, c_mid, _ = evaluate('c', MLPClassifier(hidden_layer_sizes=(64, 32),
                                                  max_iter=400, early_stopping=True,
                                                  n_iter_no_change=15, random_state=0),
                               d['full'][tr], yt, d['full'][te], ye, plyte)
    print(f"\n  [{tag}] log-loss (lower is better); test = "
          f"{te.sum()} positions / {len(np.unique(d['game'][te]))} games")
    print(f"    (a) lead only          all {a_all:.4f}   plies 10-25 {a_mid:.4f}")
    print(f"    (b) 12 hand features   all {b_all:.4f}   plies 10-25 {b_mid:.4f}"
          f"   (vs a: {a_mid-b_mid:+.4f} nats)")
    print(f"    (c) MLP, 132 features  all {c_all:.4f}   plies 10-25 {c_mid:.4f}"
          f"   (vs a: {a_mid-c_mid:+.4f} nats)")
    gain = a_mid - c_mid
    print(f"\n    C2 GATE: MLP beats material by {gain:+.4f} nats over plies 10-25 "
          f"-> {'PASS' if gain >= 0.05 else 'FAIL'} (threshold 0.05)")
    return dict(a_mid=a_mid, b_mid=b_mid, c_mid=c_mid, gain=gain, bmodel=bmodel,
                keep=keep, names=names)


if __name__ == "__main__":
    path = sys.argv[1]
    holdout = [int(x) for x in sys.argv[2].split(',')] if len(sys.argv) > 2 else []
    d = load(path)

    tr, te = game_split(d['game'], frac=0.25, seed=0)
    res = run(d, tr, te, "C2 game-split")

    if res:
        # The texel fit, in centistones, ready to drop into eval.rs. Scaled so the
        # `lead` coefficient is 100, matching the Weights convention.
        coef = res['bmodel'].coef_[0]
        names = [res['names'][i] for i in res['keep']]
        li = names.index('lead')
        if abs(coef[li]) > 1e-9:
            cs = coef * (100.0 / coef[li])
            print("\n  TEXEL FIT (centistones, normalised so lead = 100):")
            for n, v in zip(names, cs):
                print(f"    {n:<22} {v:+8.1f}")
            print("    NOTE: these are logistic coefficients on a STANDARDISED"
                  " design matrix,")
            print("    so they are a starting point for an arena sweep, not a"
                  " drop-in weight set.")

    if holdout:
        tr2, te2 = spell_split(d['spells'], holdout)
        spell_names = None
        try:
            import sigil_engine as se
            spell_names = [se.SPELL_NAMES[i] for i in holdout]
        except Exception:
            pass
        print(f"\n  C3 held-out spells {holdout}"
              + (f" = {spell_names}" if spell_names else ""))
        print(f"    train games avoid them: {len(np.unique(d['game'][tr2]))}; "
              f"test games use them: {len(np.unique(d['game'][te2]))}")
        r2 = run(d, tr2, te2, "C3 spell-split")
        if r2 and res:
            gap = r2['c_mid'] - res['c_mid']
            print(f"\n    C3 GATE: held-out-spell log-loss is {gap:+.4f} nats worse "
                  f"than the game-split baseline")
            print(f"    -> {'conditioning works (<0.02)' if gap < 0.02 else ('marginal' if gap < 0.06 else 'conditioning FAILS (>0.06)')}")
