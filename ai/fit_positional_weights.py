"""Fit positional evaluation weights from completed game records.

Downloads completed_games from Firebase (service-account REST, cached
locally), reconstructs every position from the per-turn SFN snapshots,
and fits a logistic regression of game outcome on red-POV feature
differentials:

    P(red wins) = sigma(b0 + b_stone*stone_diff + b_mana*mana_diff
                        + b_void*void_diff + b_mc*mc_diff + b_stm*stm)

The deliverable is each feature's ratio to the stone coefficient — its
worth in stones — which becomes CAVEMAN_EVAL_WEIGHTS in
docs/static/scripts/engine/caveman-ai.js after arena validation.

Statistical notes:
  - Positions within one game share an outcome label and are serially
    correlated, so plain SEs are overconfident. We report CR1
    cluster-robust (sandwich) SEs clustered by game, and ratio CIs from
    a cluster bootstrap (resampling games, not positions).
  - stone_diff and mc_diff are collinear (more stones => closer to more
    nodes); the correlation matrix and VIFs are printed so the reader
    knows how much to trust individual coefficients. The arena is the
    final arbiter either way.
  - Fits run separately per cohort: human-vs-human, human-vs-AI
    (AI uid prefix '__ai_'), pooled (with is_ai_game indicator), and
    the local selfplay dataset as an out-of-population comparison.

Usage:
    python -m ai.fit_positional_weights --service-account firebase-service-account.json
    python -m ai.fit_positional_weights            # reuse cached download
    python -m ai.fit_positional_weights --selfplay-only   # no network needed

No sklearn/scipy on this box — the IRLS fit and sandwich algebra are
plain numpy.
"""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import NODE_ORDER, POSITIONS, sfn_to_dict
from simboard import MANA_NODES
from ai.features import map_control
from ai.data_filters import (
    FIREBLAST_RULE_CHANGE_CUTOFF, COMPETITIVE_FIX_CUTOFF,
    sfn_has_fireblast, sfn_variant,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
CACHE_PATH = os.path.join(REPO, 'ai', 'data', 'completed_games_raw.json')
SELFPLAY_PATH = os.path.join(REPO, 'ai', 'data', 'selfplay_v22b_2026-05-03.jsonl')
OUTPUT_PATH = os.path.join(REPO, 'ai', 'data', 'positional_weights_fit.json')

# Same 9 nodes as ai/minimax_ai.py _VOID_NODES: on no spell sigil, not mana.
_SPELL_NODE_SET = frozenset(n for nodes in POSITIONS.values() for n in nodes)
VOID_NODES = tuple(n for n in NODE_ORDER
                   if n not in _SPELL_NODE_SET and n not in MANA_NODES)

FEATURE_NAMES = ['intercept', 'stone_diff', 'mana_diff', 'void_diff',
                 'mc_diff', 'stm']
# Column indices into X (pooled fits append is_ai_game as a 7th column).
_I_STONE, _I_MANA, _I_VOID, _I_MC = 1, 2, 3, 4

MIN_GAMES_FOR_FIT = 30
HEADLINE_MIN_GAMES = 150


# ---------------------------------------------------------------------------
# Download + cache
# ---------------------------------------------------------------------------

def auth_token(service_account_path):
    import google.auth.transport.requests
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_file(
        service_account_path,
        scopes=['https://www.googleapis.com/auth/firebase.database',
                'https://www.googleapis.com/auth/userinfo.email'],
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def download_completed_games(service_account_path, db_url=DB_URL,
                             cache_path=CACHE_PATH, refresh=False):
    if os.path.exists(cache_path) and not refresh:
        print(f'Using cached download: {cache_path}')
        with open(cache_path) as f:
            return json.load(f)
    if not service_account_path:
        raise SystemExit(
            f'No cache at {cache_path} and no --service-account given.')
    import requests
    token = auth_token(service_account_path)
    print(f'Fetching {db_url}/completed_games.json ...')
    resp = requests.get(db_url.rstrip('/') + '/completed_games.json',
                        params={'access_token': token}, timeout=300)
    resp.raise_for_status()
    games = resp.json() or {}
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, 'w') as f:
        json.dump(games, f)
    print(f'Cached {len(games)} games at {cache_path}')
    return games


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------

def _normalize_turns(turns):
    """Firebase can deliver arrays as dicts keyed by stringified index,
    and lists can contain None holes. Return a clean list or None."""
    if isinstance(turns, dict):
        try:
            items = sorted(turns.items(), key=lambda kv: int(kv[0]))
        except ValueError:
            return None
        turns = [v for _k, v in items]
    if not isinstance(turns, list):
        return None
    if any(t is None for t in turns):
        return None
    return turns


def _record_date(game):
    ts = game.get('timestamp')
    if not isinstance(ts, (int, float)) or ts <= 0:
        return None
    try:
        return datetime.fromtimestamp(ts / 1000).date()
    except (OverflowError, OSError, ValueError):
        return None


def is_ai_game(game):
    return (str(game.get('redUid') or '').startswith('__ai_')
            or str(game.get('blueUid') or '').startswith('__ai_'))


def filter_games(games):
    """Return (kept, funnel) where kept is a list of (key, game, turns)
    and funnel counts every drop by reason."""
    funnel = Counter()
    kept = []
    for key, game in sorted(games.items()):
        funnel['total'] += 1
        if not isinstance(game, dict):
            funnel['drop_malformed_record'] += 1
            continue
        if game.get('winner') not in ('red', 'blue'):
            funnel['drop_no_winner'] += 1
            continue
        turns = _normalize_turns(game.get('turns'))
        if not turns:
            funnel['drop_no_turns'] += 1
            continue
        if any(not isinstance(t, dict) or not t.get('sfnBefore')
               or not t.get('sfnAfter') for t in turns):
            funnel['drop_missing_sfn'] += 1
            continue
        # Consecutive snapshots differ legitimately in the whose-turn
        # token and turn counter (the advance happens between the two
        # captures) — compare only the stones+spells token for hygiene.
        if any(turns[i + 1]['sfnBefore'].split(' ', 1)[0]
               != turns[i]['sfnAfter'].split(' ', 1)[0]
               for i in range(len(turns) - 1)):
            funnel['drop_chain_broken'] += 1
            continue
        if not game.get('ranked'):
            funnel['drop_unranked'] += 1
            continue
        first_sfn = turns[0]['sfnBefore']
        variant = sfn_variant(first_sfn)
        rec_date = _record_date(game)
        if variant == 'competitive':
            if rec_date is None or rec_date < COMPETITIVE_FIX_CUTOFF:
                funnel['drop_competitive_prefix'] += 1
                continue
        elif variant != 'standard':
            funnel['drop_variant_other'] += 1
            continue
        if sfn_has_fireblast(first_sfn) and (
                rec_date is None or rec_date < FIREBLAST_RULE_CHANGE_CUTOFF):
            funnel['drop_fireblast_prenerf'] += 1
            continue
        funnel['kept'] += 1
        kept.append((key, game, turns))
    return kept, funnel


# ---------------------------------------------------------------------------
# Position extraction + features
# ---------------------------------------------------------------------------

def game_positions(turns):
    """Non-terminal positions with correct side-to-move metadata.

    Each turn's sfnBefore was captured at that turn's start, so its
    whose-turn token and counter are accurate (sfnAfter is captured
    before the turn advance, so its token is the mover, not the side
    to move). The terminal position (last sfnAfter) is excluded by
    construction — it perfectly predicts the outcome and would blow up
    the logistic fit."""
    return [t['sfnBefore'] for t in turns]


def position_features(sfn):
    """Red-POV features for one position, or None to skip it.

    Returns (x_vector_without_indicator, turncounter)."""
    d = sfn_to_dict(sfn)
    if d['turncounter'] <= 2:
        return None
    stones = d['stones']
    stone_diff = mana_diff = void_diff = 0
    for n in NODE_ORDER:
        s = stones[n]
        if s == 'red':
            stone_diff += 1
        elif s == 'blue':
            stone_diff -= 1
    for n in MANA_NODES:
        s = stones[n]
        if s == 'red':
            mana_diff += 1
        elif s == 'blue':
            mana_diff -= 1
    for n in VOID_NODES:
        s = stones[n]
        if s == 'red':
            void_diff += 1
        elif s == 'blue':
            void_diff -= 1
    mc_diff = map_control(stones)['diff']
    stm = 1.0 if d['turn'] == 'red' else -1.0
    x = [1.0, float(stone_diff), float(mana_diff), float(void_diff),
         float(mc_diff), stm]
    return x, d['turncounter']


def build_dataset(kept):
    """Rows for every kept game. Returns dict of numpy arrays plus
    per-row metadata (cluster index, turncounter, is_ai flag) and
    eval-annotation rows."""
    X, y, cluster, tcs, ai_flags = [], [], [], [], []
    human_red, tiers = [], []
    ann_X, ann_y, ann_cluster = [], [], []
    cluster_ids = {}
    for key, game, turns in kept:
        positions = game_positions(turns)
        y_red = 1.0 if game['winner'] == 'red' else 0.0
        ai = 1.0 if is_ai_game(game) else 0.0
        red_uid = str(game.get('redUid') or '')
        blue_uid = str(game.get('blueUid') or '')
        if red_uid.startswith('__ai_'):
            hr, tier = -1.0, red_uid.strip('_')[3:] or 'unknown'
        elif blue_uid.startswith('__ai_'):
            hr, tier = 1.0, blue_uid.strip('_')[3:] or 'unknown'
        else:
            hr, tier = 0.0, ''
        gi = cluster_ids.setdefault(key, len(cluster_ids))
        # Annotations label the position AFTER turnNumber tn, which is
        # the NEXT turn's sfnBefore (positions[i+1]); an annotation on
        # the final turn labels the terminal position and is skipped.
        annotations = game.get('eval_annotations') or {}
        ann_by_index = {}
        for i, t in enumerate(turns[:-1]):
            tn = t.get('turnNumber')
            if tn is not None and str(tn) in annotations:
                ann_by_index[i + 1] = annotations[str(tn)]
        for idx in range(len(positions)):
            feats = position_features(positions[idx])
            if feats is None:
                continue
            x, tc = feats
            X.append(x)
            y.append(y_red)
            cluster.append(gi)
            tcs.append(tc)
            ai_flags.append(ai)
            human_red.append(hr)
            tiers.append(tier)
            label = ann_by_index.get(idx)
            if label in ('red', 'blue', 'even'):
                ann_X.append(x)
                ann_y.append({'red': 1.0, 'blue': 0.0, 'even': 0.5}[label])
                ann_cluster.append(gi)
    return {
        'X': np.array(X), 'y': np.array(y),
        'cluster': np.array(cluster), 'tc': np.array(tcs),
        'ai': np.array(ai_flags), 'n_games': len(cluster_ids),
        'human_red': np.array(human_red), 'tier': np.array(tiers),
        'ann_X': np.array(ann_X) if ann_X else None,
        'ann_y': np.array(ann_y) if ann_y else None,
        'ann_cluster': np.array(ann_cluster) if ann_cluster else None,
    }


# ---------------------------------------------------------------------------
# Selfplay dataset
# ---------------------------------------------------------------------------

def load_selfplay(path):
    """Rows from the selfplay jsonl (sfn + outcome from mover's POV).
    Game boundaries inferred from turncounter resets; the file predates
    the Fireblast nerf so Fireblast boards are dropped per-record."""
    X, y, cluster, tcs = [], [], [], []
    funnel = Counter()
    game_idx = -1
    prev_tc = None
    with open(path) as f:
        for line in f:
            funnel['total'] += 1
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                funnel['drop_bad_json'] += 1
                continue
            sfn = d.get('sfn')
            outcome = d.get('outcome')
            if not sfn or outcome is None:
                funnel['drop_missing_fields'] += 1
                continue
            # Boundary detection must run on every record (before any
            # drop below) so cluster ids stay aligned with real games.
            try:
                tc = int(sfn.split(' ')[2])
            except (IndexError, ValueError):
                funnel['drop_bad_sfn'] += 1
                continue
            if prev_tc is None or tc < prev_tc:
                game_idx += 1
            prev_tc = tc
            if sfn_has_fireblast(sfn):
                funnel['drop_fireblast_prenerf'] += 1
                continue
            feats = position_features(sfn)
            if feats is None:
                funnel['drop_opening'] += 1
                continue
            x, tc2 = feats
            turn_is_red = x[5] > 0
            if outcome > 0:
                y_red = 1.0 if turn_is_red else 0.0
            elif outcome < 0:
                y_red = 0.0 if turn_is_red else 1.0
            else:
                y_red = 0.5
            funnel['kept'] += 1
            X.append(x)
            y.append(y_red)
            cluster.append(game_idx)
            tcs.append(tc2)
    return {
        'X': np.array(X), 'y': np.array(y),
        'cluster': np.array(cluster), 'tc': np.array(tcs),
        'n_games': len(set(cluster)),
    }, funnel


# ---------------------------------------------------------------------------
# Regression machinery (numpy only)
# ---------------------------------------------------------------------------

def irls_fit(X, y, ridge=1e-6, max_iter=100, tol=1e-8):
    """Logistic MLE via IRLS/Newton. Supports fractional targets
    (cross-entropy with y in [0,1])."""
    n, k = X.shape
    beta = np.zeros(k)
    for _ in range(max_iter):
        p = 1.0 / (1.0 + np.exp(-X @ beta))
        W = p * (1.0 - p)
        A = X.T @ (X * W[:, None]) + ridge * np.eye(k)
        g = X.T @ (y - p)
        delta = np.linalg.solve(A, g)
        beta = beta + delta
        if np.linalg.norm(delta) < tol:
            break
    return beta


def cr1_se(X, y, beta, cluster):
    """CR1 cluster-robust sandwich standard errors."""
    n, k = X.shape
    p = 1.0 / (1.0 + np.exp(-X @ beta))
    W = p * (1.0 - p)
    A = X.T @ (X * W[:, None])
    resid = y - p
    groups = np.unique(cluster)
    G = len(groups)
    B = np.zeros((k, k))
    for g in groups:
        m = cluster == g
        s = X[m].T @ resid[m]
        B += np.outer(s, s)
    c = (G / max(G - 1, 1)) * ((n - 1) / max(n - k, 1))
    A_inv = np.linalg.inv(A + 1e-10 * np.eye(k))
    V = c * A_inv @ B @ A_inv
    return np.sqrt(np.maximum(np.diag(V), 0.0)), V


def ratios_from_beta(beta):
    """Stone-equivalent weights. Sign convention: mana and mapControl
    ship as positive-good, voidPenalty as positive-bad (negated)."""
    b_stone = beta[_I_STONE]
    return {
        'mana': beta[_I_MANA] / b_stone,
        'voidPenalty': -beta[_I_VOID] / b_stone,
        'mapControl': beta[_I_MC] / b_stone,
    }


def cluster_bootstrap(X, y, cluster, B, seed, progress_label=''):
    """Percentile CIs for the stone-equivalent ratios by resampling
    whole games."""
    rng = np.random.default_rng(seed)
    groups = np.unique(cluster)
    rows_by_group = {g: np.flatnonzero(cluster == g) for g in groups}
    samples = {'mana': [], 'voidPenalty': [], 'mapControl': []}
    for b in range(B):
        pick = rng.choice(groups, size=len(groups), replace=True)
        rows = np.concatenate([rows_by_group[g] for g in pick])
        try:
            beta = irls_fit(X[rows], y[rows])
        except np.linalg.LinAlgError:
            continue
        if abs(beta[_I_STONE]) < 1e-9:
            continue
        r = ratios_from_beta(beta)
        for name in samples:
            samples[name].append(r[name])
        if progress_label and (b + 1) % 200 == 0:
            print(f'  bootstrap {progress_label}: {b + 1}/{B}', flush=True)
    ci = {}
    for name, vals in samples.items():
        if len(vals) >= 100:
            lo, hi = np.percentile(vals, [2.5, 97.5])
            ci[name] = [float(lo), float(hi)]
        else:
            ci[name] = None
    return ci


def vif_and_corr(X, feat_names):
    """Correlation matrix + VIFs for the non-intercept, non-constant
    columns."""
    keep = [j for j in range(1, X.shape[1]) if np.std(X[:, j]) > 0]
    cols = X[:, keep]
    names = [feat_names[j] for j in keep]
    corr = np.corrcoef(cols, rowvar=False)
    vifs = {}
    for j in range(cols.shape[1]):
        others = np.delete(cols, j, axis=1)
        A = np.column_stack([np.ones(len(cols)), others])
        coef, _res, _rank, _sv = np.linalg.lstsq(A, cols[:, j], rcond=None)
        pred = A @ coef
        ss_res = np.sum((cols[:, j] - pred) ** 2)
        ss_tot = np.sum((cols[:, j] - cols[:, j].mean()) ** 2)
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
        vifs[names[j]] = float(1.0 / max(1.0 - r2, 1e-9))
    return corr, names, vifs


# ---------------------------------------------------------------------------
# Fits + reporting
# ---------------------------------------------------------------------------

def fit_cohort(name, X, y, cluster, tc=None, bootstrap_B=1000, seed=7,
               extra_names=None):
    n_games = len(np.unique(cluster))
    if n_games < MIN_GAMES_FOR_FIT:
        print(f'\n== {name}: only {n_games} games — skipping fit ==')
        return None
    beta = irls_fit(X, y)
    se, _V = cr1_se(X, y, beta, cluster)
    ratios = ratios_from_beta(beta)
    ci = cluster_bootstrap(X, y, cluster, bootstrap_B, seed, name)

    k = X.shape[1]
    feat_names = extra_names if extra_names is not None \
        else FEATURE_NAMES[:k]
    corr, corr_names, vifs = vif_and_corr(X, feat_names)
    print(f'\n== {name}: {n_games} games, {len(y)} positions ==')
    print(f'  {"feature":<12} {"beta":>10} {"CR1 SE":>10} {"z":>8}')
    for j in range(k):
        z = beta[j] / se[j] if se[j] > 0 else float('nan')
        print(f'  {feat_names[j]:<12} {beta[j]:>10.5f} {se[j]:>10.5f} {z:>8.2f}')
    print('  stone-equivalent ratios (95% cluster-bootstrap CI):')
    for fname in ('mana', 'voidPenalty', 'mapControl'):
        c = ci.get(fname)
        ci_str = f'[{c[0]:+.3f}, {c[1]:+.3f}]' if c else '(n/a)'
        print(f'    {fname:<12} {ratios[fname]:+.3f} stones  {ci_str}')
    print('  VIFs: ' + ', '.join(f'{n}={v:.1f}' for n, v in vifs.items()))
    high_vif = [n for n, v in vifs.items() if v > 10]
    if high_vif:
        print(f'  WARNING: high collinearity ({", ".join(high_vif)}) — '
              f'individual coefficients jointly unstable; arena decides.')

    result = {
        'n_games': int(n_games), 'n_positions': int(len(y)),
        'beta': {feat_names[j]: float(beta[j]) for j in range(k)},
        'cr1_se': {feat_names[j]: float(se[j]) for j in range(k)},
        'ratios': {kk: float(vv) for kk, vv in ratios.items()},
        'ratio_ci95': ci,
        'corr': {'names': corr_names, 'matrix': corr.tolist()},
        'vif': vifs,
    }
    # Phase refits (diagnostic only)
    if tc is not None:
        result['phases'] = {}
        for label, lo, hi in (('early_3_10', 3, 10), ('mid_11_25', 11, 25),
                              ('late_26_plus', 26, 10 ** 9)):
            m = (tc >= lo) & (tc <= hi)
            if m.sum() < 200 or len(np.unique(cluster[m])) < MIN_GAMES_FOR_FIT:
                continue
            b_ph = irls_fit(X[m], y[m])
            if abs(b_ph[_I_STONE]) < 1e-9:
                continue
            r_ph = ratios_from_beta(b_ph)
            result['phases'][label] = {kk: float(vv) for kk, vv in r_ph.items()}
            print(f'  phase {label:<13} mana {r_ph["mana"]:+.3f}  '
                  f'void {r_ph["voidPenalty"]:+.3f}  mc {r_ph["mapControl"]:+.3f}'
                  f'  (n={int(m.sum())})')
    return result


def capped_weights(ratios, budget=0.96):
    """Clamp wrong-signed ratios to 0, then scale uniformly so the
    worst-case positional total stays <= budget stones."""
    w = {k: max(0.0, v) for k, v in ratios.items()}
    worst = 3 * w['mana'] + 9 * w['voidPenalty'] + 39 * w['mapControl']
    if worst > budget and worst > 0:
        s = budget / worst
        w = {k: v * s for k, v in w.items()}
    return {k: round(v, 4) for k, v in w.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--service-account', default=None)
    ap.add_argument('--db-url', default=DB_URL)
    ap.add_argument('--cache', default=CACHE_PATH)
    ap.add_argument('--refresh', action='store_true')
    ap.add_argument('--selfplay', default=SELFPLAY_PATH)
    ap.add_argument('--selfplay-only', action='store_true')
    ap.add_argument('--output', default=OUTPUT_PATH)
    ap.add_argument('--bootstrap', type=int, default=1000)
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()

    out = {'seed': args.seed, 'bootstrap_B': args.bootstrap, 'cohorts': {}}

    headline = None
    if not args.selfplay_only:
        games = download_completed_games(args.service_account, args.db_url,
                                         args.cache, args.refresh)
        # Slim records (post-2026-08 refactor) store SGN-T transcripts
        # instead of per-turn SFNs — replay them through the canonical
        # JS engine so the SFN-based filters and position extraction
        # below work unchanged. Replay failures keep transcript-only
        # turns and fall out at drop_missing_sfn.
        from ai.replay_bridge import hydrate_games_in_place
        hydrate_games_in_place(
            [g for g in games.values() if isinstance(g, dict)])
        kept, funnel = filter_games(games)
        print('\nFilter funnel:')
        for reason, count in sorted(funnel.items()):
            print(f'  {reason:<28} {count}')
        out['filter_funnel'] = dict(funnel)

        data = build_dataset(kept)
        hh = data['ai'] == 0.0
        ha = data['ai'] == 1.0

        r_hh = fit_cohort('human-vs-human', data['X'][hh], data['y'][hh],
                          data['cluster'][hh], data['tc'][hh],
                          args.bootstrap, args.seed)
        r_ha = fit_cohort('human-vs-AI', data['X'][ha], data['y'][ha],
                          data['cluster'][ha], data['tc'][ha],
                          args.bootstrap, args.seed)
        # Adjusted human-vs-AI fit: control for which side the human
        # played and which AI tier they faced — game composition (weak
        # tiers get crushed, humans pick a side) otherwise leaks into
        # the positional coefficients.
        r_adj = None
        if ha.sum() > 0:
            tiers_ha = data['tier'][ha]
            tier_levels = sorted(set(tiers_ha))
            extra_cols = [data['human_red'][ha]]
            extra_names = list(FEATURE_NAMES) + ['human_is_red']
            for t in tier_levels[1:]:  # drop-first dummy coding
                extra_cols.append((tiers_ha == t).astype(float))
                extra_names.append(f'tier_{t}')
            X_adj = np.column_stack([data['X'][ha]] + extra_cols)
            r_adj = fit_cohort('human-vs-AI adjusted(+side,+tier)',
                               X_adj, data['y'][ha], data['cluster'][ha],
                               data['tc'][ha], args.bootstrap, args.seed,
                               extra_names=extra_names)
        # Pooled fit is only meaningful when both cohorts have games.
        r_pool = None
        if hh.sum() > 0 and ha.sum() > 0:
            X_pool = np.column_stack([data['X'], data['ai']])
            r_pool = fit_cohort('pooled(+is_ai_game)', X_pool, data['y'],
                                data['cluster'], data['tc'],
                                args.bootstrap, args.seed,
                                extra_names=list(FEATURE_NAMES) + ['is_ai_game'])
        out['cohorts']['human_vs_human'] = r_hh
        out['cohorts']['human_vs_ai'] = r_ha
        out['cohorts']['human_vs_ai_adjusted'] = r_adj
        out['cohorts']['pooled'] = r_pool

        if (data['ann_X'] is not None and len(data['ann_y']) >= 50):
            r_ann = fit_cohort('eval_annotations', data['ann_X'],
                               data['ann_y'], data['ann_cluster'],
                               None, min(args.bootstrap, 200), args.seed)
            out['cohorts']['eval_annotations'] = r_ann
        else:
            n_ann = 0 if data['ann_X'] is None else len(data['ann_y'])
            print(f'\neval_annotations: only {n_ann} labeled positions — '
                  f'skipping supervised fit.')

        if r_hh and r_hh['n_games'] >= HEADLINE_MIN_GAMES:
            headline, headline_name = r_hh, 'human_vs_human'
        elif r_pool:
            headline, headline_name = r_pool, 'pooled'
        elif r_adj:
            headline, headline_name = r_adj, 'human_vs_ai_adjusted'
        elif r_hh:
            headline, headline_name = r_hh, 'human_vs_human'
        elif r_ha:
            headline, headline_name = r_ha, 'human_vs_ai'

    if args.selfplay and os.path.exists(args.selfplay):
        sp, sp_funnel = load_selfplay(args.selfplay)
        print('\nSelfplay funnel:')
        for reason, count in sorted(sp_funnel.items()):
            print(f'  {reason:<28} {count}')
        r_sp = fit_cohort('selfplay', sp['X'], sp['y'], sp['cluster'],
                          sp['tc'], args.bootstrap, args.seed)
        out['cohorts']['selfplay'] = r_sp
        if headline is None and r_sp:
            headline, headline_name = r_sp, 'selfplay'

    if headline:
        raw = {k: round(float(v), 4) for k, v in headline['ratios'].items()}
        capped = capped_weights(headline['ratios'])
        worst_raw = 3 * max(0, raw['mana']) + 9 * max(0, raw['voidPenalty']) \
            + 39 * max(0, raw['mapControl'])
        out['recommended'] = {
            'source_cohort': headline_name,
            'raw': raw,
            'raw_worst_case_stones': round(worst_raw, 3),
            'capped': capped,
            'cap_budget_stones': 0.96,
        }
        print(f'\n=== Recommended weights (from {headline_name}) ===')
        print(f'  raw:    {raw}  (worst-case {worst_raw:.2f} stones)')
        print(f'  capped: {capped}')
    else:
        print('\nNo cohort produced a usable fit.')

    with open(args.output, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'\nWrote {args.output}')


if __name__ == '__main__':
    main()
