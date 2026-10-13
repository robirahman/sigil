"""Interpretability experiment 4: how the engine plays, against how humans play (2026-10).

    interp_behaviour.py extract-selfplay <chunk_dir> <out.pkl> [--jobs N]
    interp_behaviour.py extract-human <lines.json> <raw.json> <out.pkl>
    interp_behaviour.py analyse <selfplay.pkl> <human.pkl> <out.json> [--boot 400]

Behaviour statistics read straight from game logs, no search
(engine/reports/2026-10-interpretability-plan.md, experiment 4).

Sources
  selfplay  round-4 self-play chunks (the npz files listed under "chunks" in
            gs://focus-surfer-494820-g0-sigil/data/spell_values/plan_2026-10-12.json;
            fetch a sample with `gcloud storage cp -I <dir>`). Engine v29+s3
            (net nnue_spell3, the one before v30's nnue_spell4) at FIXED depth 4
            (selfplay_v2.py), opening book off, fresh draws only (kind 0 standard,
            kind 1 competitive, about 1:2). Round 4's spell schedule topped up the
            CUMULATIVE training set, so within round 4 alone the Tectonic and
            Providence spells appear in ~10k games each, core spells in ~1.5-2.5k
            and Hail Storm in none. 8% of plies are uniformly random turns
            (random_played == 1): those turns are dropped from every per-turn
            statistic, but they stay in the games, so raw game-level statistics
            (length, first-move advantage) are of games with ~8% random plies;
            `pure_play_km` estimates them for pure engine play (each game is
            pure up to its first random ply, censored there).
  human     eval_games.py output: lines.json (hydrated positions, one SFN per turn
            start plus the final position) and raw.json (the transcripts, for
            dash actions and Elo). Standard and competitive variants;
            competitive_deathmatch is dropped, and so is any game holding a
            retired or out-of-scope spell (Board.from_sfn raises) or played
            before a 2026-10 rule change to one of its spells
            (ai/data_filters.is_old_rules_game, as selfplay_v2.py). Only the
            HUMAN side's turns count as human behaviour; uids starting `__ai_`
            are AI opponents. Almost every recorded game is human vs AI.

Per turn (side to move) we record: whether the turn is measured (not random
in self-play; a human's turn in human games), the score lead from the
mover's point of view (the SFN's trailing token, which includes blue's +1
token), the spells castable at the START of the turn (`castable`, with and
without a dash, so locks, Seal of Winter, Surge/Splash timing are the
engine's rules), the statics held charged, the spells cast this turn
(self-play: the Cast actions of the played turn; human: the transcript's
cast actions, checked against the spell counter step -- charms do not step
the counter or set the lock, so positions alone cannot see them; a turn with
no usable transcript is left out),
whether it dashed (self-play: a Dash action; human: transcript actions, unknown
for turns recorded without actions), and the nodes the mover newly occupies.

Per spell (castable spells; the nine statics are reported as "held charged"):
  cast_rate      casts per measured own turn of a side whose draw holds it
  p_cast         share of side-games in which the side casts it at least once
  first_turn     game turn (1 = red's first turn) of a side's first cast
  avail_cast     share of turns starting with it castable on which it is cast
  same_turn      share of casts where it was not castable at turn start (the
                 sigil was completed and cast within one turn)
  hold           for casts castable at turn start: own turns it sat castable first
  lapsed/at_end  share of availability runs (consecutive own turns starting
                 castable) that ended without a cast: the charge or the right
                 to cast was lost / the game ended
A run interrupted by an unmeasured turn is dropped from hold and lapse
statistics. "Castable at turn start" is a proxy for "could have been cast":
a cast that becomes legal only after this turn's move is not counted as
declined, and a castable spell whose sigil the move itself broke is.

Also: game length, red's win rate, how games end (sixth spell or a score lead
of 3), casting and dashing by the score lead, human behaviour by Elo band,
human win rate as red vs blue against the same AI, and openings (the nodes
newly occupied on turns 1-4, the competitive turn-2 reply to turn 1, and how
the draw steers the first competitive placements).

Intervals: 95% bootstrap over GAMES (Poisson weights). Human games share
players (one player has ~300 games), so their intervals understate the
spread over players.
"""
import argparse, json, math, os, pickle, sys
from collections import Counter, defaultdict
from multiprocessing import Pool
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
sys.path.insert(0, os.path.join(_HERE, '..', '..', 'ai'))
from data_filters import is_old_rules_game

SPELL_NAMES = list(se.SPELL_NAMES)
NAME_ID = {n: i for i, n in enumerate(SPELL_NAMES)}
NODE_NAMES = list(se.NODE_NAMES)
N_SPELLS = 45
STATICS = {4, 9, 14, 17, 32, 36, 37, 38, 41}    # spells_meta.rs is_static
NO_SPELL = 255
# Round 4's run config (runs/*-sigil-r4d-3xx/smoke_ok.log CONFIG line).
ENGINE = ('round-4 self-play (runs 20261011T04*-sigil-r4d-300..315): engine v29+s3@7c1deea, eval '
          'nnue_spell3, policy 96, width_scale 4, fixed depth 4, opening book off, 8% random plies')
RANDOM_PCT = 0.08            # selfplay_v2.py random_ply_pct for round 4 (measured: 0.080 of plies)
SIGILS = [[n for n in range(39) if (m >> n) & 1] for m in se.SIGIL_MASKS]
# Charms: the 1-node sigils (spells_meta.rs is_charm). They do not step the counter.
CHARM = [False] * N_SPELLS
for _i in (10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 42):
    CHARM[_i] = True
NODE_SLOT = {n: p for p, ns in enumerate(SIGILS) for n in ns}


# ---------------------------------------------------------------- parsing

def lead_of(sfn, mover):
    """Score lead from `mover`'s POV, read from the SFN's lead token."""
    tok = [t for t in sfn.split(' ')[6:] if t != 'competitive' and not t.startswith('competitive')]
    tok = tok[0] if tok else 'tied'
    if tok == 'tied':
        return 0
    v = int(tok[1:])
    return v if (tok[0] == 'r') == (mover == 0) else -v


def side_of(sfn):
    return 0 if sfn.split(' ')[1] == 'r' else 1


def turn_start(b, c):
    """Castable spell ids (with or without a dash first) and charged statics."""
    col = 'red' if c == 0 else 'blue'
    cast = set(b.castable(col, True, True, False)) | set(b.castable(col, True, True, True))
    ids = b.spell_ids()
    statics = [ids[p - 1] for p in b.charged(col) if ids[p - 1] in STATICS]   # charged() is 1-based
    return sorted(cast), statics


def stones(b, c):
    return set(b.red if c == 0 else b.blue)


def decode_chosen(packed, spells):
    """Spell ids cast and dash sacrifices in a packed turn (search.rs pack_action)."""
    casts, dash = [], 0
    for v in packed:
        v = int(v)
        if v == 0:
            break
        tag = v & 7
        if tag == 4:
            casts.append(int(spells[(v >> 3) & 0xF]))
        elif tag == 3:
            dash = max(1, (v >> 28) & 3)
    return casts, dash


# ---------------------------------------------------------------- extraction

def extract_chunk(path):
    """One self-play chunk -> list of game records."""
    try:
        z = np.load(path)
        sfn, game, ply = z['sfn'], z['game'], z['ply']
        kind, y, isr, rnd, chosen, sp = (z['kind'], z['y'], z['is_red'], z['random_played'],
                                        z['chosen'], z['spells'])
        sply = z['start_ply']
    except Exception as e:  # noqa: BLE001
        return [], f'{os.path.basename(path)}: {e}'
    out = []
    order = np.lexsort((ply, game))
    rows_by_game = defaultdict(list)
    for i in order:
        rows_by_game[int(game[i])].append(int(i))
    for g, rows in rows_by_game.items():
        if int(sply[rows[0]]) != 0 or int(kind[rows[0]]) not in (0, 1):
            continue
        if [int(ply[i]) for i in rows] != list(range(len(rows))):
            continue
        r0 = rows[0]
        winner = None
        if int(y[r0]) != 255:
            winner = 0 if (int(y[r0]) == 1) == bool(isr[r0]) else 1
        spells = [int(s) for s in sp[r0]]
        boards = [se.Board.from_sfn(str(sfn[i])) for i in rows]
        turns = []
        for k, i in enumerate(rows):
            s = str(sfn[i]); c = side_of(s); b = boards[k]
            castable, statics = turn_start(b, c)
            measured = not bool(rnd[i])
            nxt = boards[k + 1] if k + 1 < len(rows) else None
            if measured:
                casts, dash = decode_chosen(chosen[i], spells)
            else:
                casts, dash = None, None      # `chosen` is the search's pick, not the turn played
            new = sorted(stones(nxt, c) - stones(b, c)) if nxt is not None else None
            turns.append((k + 1, c, measured, lead_of(s, c), castable, statics, casts, dash, new))
        last = turns[-1]
        fc = None
        if last[6] is not None:
            fc = list(boards[-1].spell_counter)
            fc[last[1]] += sum(1 for x in last[6] if not CHARM[x])
        out.append({'src': 'selfplay', 'id': g, 'final_counter': fc, 'variant': 'competitive' if int(kind[r0]) == 1 else 'standard',
                    'spells': spells, 'winner': winner, 'n_turns': len(rows),
                    'n_random': int(sum(int(rnd[i]) for i in rows)),
                    'players': ['engine', 'engine'], 'elo': [None, None], 'turns': turns})
    return out, None


def cmd_extract_selfplay(a):
    files = sorted(os.path.join(a.src, f) for f in os.listdir(a.src) if f.endswith('.npz'))
    games, errs = [], []
    with Pool(a.jobs) as pool:
        for k, (gs, err) in enumerate(pool.imap_unordered(extract_chunk, files, chunksize=4)):
            games += gs
            if err:
                errs.append(err)
            if (k + 1) % 500 == 0:
                print(f'  {k + 1}/{len(files)} chunks, {len(games)} games', flush=True)
    print(f'self-play: {len(files)} chunks -> {len(games)} games; {len(errs)} unreadable', flush=True)
    pickle.dump({'games': games, 'chunks': len(files), 'errors': errs}, open(a.out, 'wb'))


def _J(x):
    return json.loads(x.replace("'", '"')) if isinstance(x, str) else x


def is_ai(uid):
    return isinstance(uid, str) and uid.startswith('__ai_')


def raw_turn_info(t):
    """(cast spell ids or None, dashed 0/1/None) from one transcript turn."""
    acts = t.get('actions')
    if isinstance(acts, str):
        try:
            acts = _J(acts)
        except Exception:  # noqa: BLE001
            acts = None
    if not acts:
        return None, None
    if all(isinstance(x, dict) for x in acts):
        casts = [NAME_ID.get(x.get('spell'), -1) for x in acts if x.get('type') == 'cast']
        return casts, int(any(x.get('type') == 'dash' for x in acts))
    if all(isinstance(x, str) for x in acts):      # 'input' transcripts: node names, verbs, spell names
        return [NAME_ID[x] for x in acts if x in NAME_ID], int('dash' in acts)
    return None, None


def cmd_extract_human(a):
    lines = json.load(open(a.lines)); raw = json.load(open(a.raw))
    games, skipped = [], Counter()
    cast_mismatch = [0]
    for key, g in lines.items():
        var = g.get('variant', 'standard')
        if var not in ('standard', 'competitive'):
            skipped[f'variant {var}'] += 1; continue
        pos = _J(g['positions'])
        if is_old_rules_game(pos[0].split(' ')[0].split('/')[1].split(','), g.get('timestamp')):
            skipped['old rules (2026-10 rule changes)'] += 1; continue
        try:
            boards = [se.Board.from_sfn(s) for s in pos]
        except ValueError:
            skipped['retired or out-of-scope spell'] += 1; continue
        r = raw.get(key, {})
        rturns = r.get('turns') if isinstance(r.get('turns'), list) else []
        if len(rturns) != len(pos) - 1:
            rturns = [{}] * (len(pos) - 1)
        uids = [g.get('redUid'), g.get('blueUid')]
        players = ['ai:' + u.strip('_') if is_ai(u) else 'human' for u in uids]
        elo = []
        for c, col in enumerate(('red', 'blue')):
            e = r.get(f'{col}EloBefore')
            try:
                elo.append(float(e) if e is not None and players[c] == 'human' else None)
            except (TypeError, ValueError):
                elo.append(None)
        winner = {'red': 0, 'blue': 1}.get(g.get('winner'))
        spells = list(boards[0].spell_ids())
        turns = []
        for k in range(len(pos) - 1):
            s = pos[k]; c = side_of(s); b, nxt = boards[k], boards[k + 1]
            castable, statics = turn_start(b, c)
            d = nxt.spell_counter[c] - b.spell_counter[c]
            rc, dash = raw_turn_info(rturns[k]) if rturns[k].get('color', ('red', 'blue')[c]) == ('red', 'blue')[c] else (None, None)
            # Charms neither step the spell counter nor set the lock, so the casts come
            # from the transcript; a turn without one, or whose non-charm casts do not
            # match the counter step, is unknown (None) and left out.
            casts = None
            if rc is not None and all(x >= 0 for x in rc):
                if sum(1 for x in rc if not CHARM[x]) == max(d, 0):
                    casts = rc
                else:
                    cast_mismatch[0] += 1
            new = sorted(stones(nxt, c) - stones(b, c))
            turns.append((k + 1, c, players[c] == 'human', lead_of(s, c), castable, statics,
                          casts, dash, new))
        games.append({'src': 'human', 'id': key, 'final_counter': list(boards[-1].spell_counter), 'variant': var, 'spells': spells, 'winner': winner,
                      'n_turns': len(pos) - 1, 'n_random': 0, 'players': players, 'elo': elo,
                      'turns': turns})
    print(f'human: {len(games)} games kept; skipped {dict(skipped)}; '
          f'{cast_mismatch[0]} turns whose transcript casts disagree with the counter', flush=True)
    pickle.dump({'games': games, 'skipped': dict(skipped), 'cast_mismatch': cast_mismatch[0]},
                open(a.out, 'wb'))


# ---------------------------------------------------------------- bootstrap

class Boot:
    """Poisson game bootstrap: W[b, g] weights shared by every statistic of a source."""

    def __init__(self, n_games, reps, seed):
        self.W = np.random.default_rng(seed).poisson(1.0, (reps, n_games)).astype(np.float32)

    def ratio(self, num, den, scale=1.0):
        """num, den: [G] or [G, K] per-game sums -> (point, lo, hi) per column."""
        num = np.asarray(num, np.float64); den = np.asarray(den, np.float64)
        with np.errstate(invalid='ignore', divide='ignore'):
            pt = num.sum(0) / den.sum(0)
            bs = (self.W @ num) / (self.W @ den)
        lo, hi = np.nanpercentile(bs, [2.5, 97.5], axis=0)
        return pt * scale, lo * scale, hi * scale

    def median(self, vals, gidx, q=50, wts=None):
        """Quantile of `vals` (one per event; event i belongs to game gidx[i]),
        optionally with event weights `wts`."""
        vals = np.asarray(vals, float); gidx = np.asarray(gidx)
        if len(vals) == 0:
            return (float('nan'),) * 3
        wts = np.ones(len(vals)) if wts is None else np.asarray(wts, float)
        o = np.argsort(vals); cw = np.cumsum(wts[o])
        pt = vals[o][np.searchsorted(cw, q / 100 * cw[-1])]
        bs = []
        for w in self.W[:200]:
            ww = w[gidx] * wts
            if ww.sum() == 0:
                continue
            o = np.argsort(vals); cw = np.cumsum(ww[o])
            bs.append(vals[o][np.searchsorted(cw, q / 100 * cw[-1])])
        return pt, float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))


def fmt(t, nd=3):
    return [None if (x is None or (isinstance(x, float) and math.isnan(x))) else round(float(x), nd)
            for x in t]


# ---------------------------------------------------------------- analysis

def lead_bucket(v):
    # A score lead of 3 ends the game (board.rs check_game_over), so a turn starts at -2..+2.
    return f'{max(-2, min(2, v)):+d}' if v else '0'


LEADS = ['-2', '-1', '0', '+1', '+2']


def spell_stats(games, boot):
    """Per-spell per-game sums for the statistics in the module docstring."""
    G = len(games)
    keys = ['turns', 'casts', 'side_games', 'side_cast', 'avail', 'avail_cast', 'cast_known',
            'same_turn', 'hold_sum', 'hold_n', 'runs', 'lapsed', 'at_end', 'static_turns',
            'static_held']
    A = {k: np.zeros((G, N_SPELLS)) for k in keys}
    first = defaultdict(list)                  # spell -> [(turn, game index)]
    holds = defaultdict(list)
    for gi, g in enumerate(games):
        drawn = set(g['spells'])
        for c in (0, 1):
            tt = [t for t in g['turns'] if t[1] == c]
            mt = [t for t in tt if t[2]]
            if not mt:
                continue
            for s in drawn:
                if s >= N_SPELLS:
                    continue
                A['side_games'][gi, s] += 1
                A['turns'][gi, s] += len(mt)
            firsts = {}
            run = {s: 0 for s in drawn}        # None = run tainted by an unmeasured turn
            for t in tt:
                turn, _, meas, lead, castable, statics, casts, dash, new = t
                cs = set(casts or [])
                for s in drawn:
                    if s >= N_SPELLS:
                        continue
                    if s in STATICS:
                        if meas:
                            A['static_turns'][gi, s] += 1
                            A['static_held'][gi, s] += s in statics
                        continue
                    av = s in castable
                    if not meas or casts is None:
                        run[s] = None if av else 0
                        continue
                    if s in cs:
                        A['casts'][gi, s] += sum(1 for x in casts if x == s)
                        A['cast_known'][gi, s] += 1
                        firsts.setdefault(s, turn)
                        if av:
                            A['avail'][gi, s] += 1; A['avail_cast'][gi, s] += 1
                            if run[s] is not None:
                                A['hold_sum'][gi, s] += run[s]; A['hold_n'][gi, s] += 1
                                A['runs'][gi, s] += 1
                                holds[s].append((run[s], gi))
                        else:
                            A['same_turn'][gi, s] += 1
                        run[s] = 0
                    elif av:
                        A['avail'][gi, s] += 1
                        if run[s] is not None:
                            run[s] += 1
                    else:
                        if run[s]:
                            A['runs'][gi, s] += 1; A['lapsed'][gi, s] += 1
                        run[s] = 0
            for s in drawn:
                if s < N_SPELLS and s not in STATICS and run.get(s):
                    A['runs'][gi, s] += 1; A['at_end'][gi, s] += 1
            for s, tn in firsts.items():
                A['side_cast'][gi, s] += 1
                first[s].append((tn, gi))
    out = {}
    for s in range(N_SPELLS):
        n_games = int((A['side_games'][:, s] > 0).sum())
        row = {'spell': SPELL_NAMES[s], 'static': s in STATICS, 'games': n_games,
               'side_games': int(A['side_games'][:, s].sum())}
        if n_games == 0:
            out[SPELL_NAMES[s]] = row; continue
        if s in STATICS:
            row['held_share'] = fmt(boot.ratio(A['static_held'][:, s], A['static_turns'][:, s]))
            out[SPELL_NAMES[s]] = row; continue
        row['casts_per_10_turns'] = fmt(boot.ratio(A['casts'][:, s], A['turns'][:, s], 10))
        row['casts_per_side_game'] = fmt(boot.ratio(A['casts'][:, s], A['side_games'][:, s]))
        row['p_cast'] = fmt(boot.ratio(A['side_cast'][:, s], A['side_games'][:, s]))
        row['avail_turns'] = int(A['avail'][:, s].sum())
        row['avail_cast'] = fmt(boot.ratio(A['avail_cast'][:, s], A['avail'][:, s]))
        row['same_turn'] = fmt(boot.ratio(A['same_turn'][:, s], A['cast_known'][:, s]))
        row['hold_mean'] = fmt(boot.ratio(A['hold_sum'][:, s], A['hold_n'][:, s]))
        row['runs'] = int(A['runs'][:, s].sum())
        row['run_lapsed'] = fmt(boot.ratio(A['lapsed'][:, s], A['runs'][:, s]))
        row['run_at_end'] = fmt(boot.ratio(A['at_end'][:, s], A['runs'][:, s]))
        row['run_uncast'] = fmt(boot.ratio(A['lapsed'][:, s] + A['at_end'][:, s], A['runs'][:, s]))
        f = first.get(s, [])
        row['n_first'] = len(f)
        if f:
            v = [x for x, _ in f]; gi = [y for _, y in f]
            row['first_turn_median'] = fmt(boot.median(v, gi), 1)
            row['first_turn_mean'] = round(float(np.mean(v)), 2)
        h = holds.get(s, [])
        row['hold0_share'] = round(float(np.mean([x == 0 for x, _ in h])), 3) if h else None
        out[SPELL_NAMES[s]] = row
    return out


def pure_play_km(games, boot, T=160):
    """Pure engine play (no random plies) by Kaplan-Meier: a game is pure up to its
    first random ply and censored there (whether a ply is random is a coin flip
    independent of play), so every game's pure prefix counts, not just the
    games that never had one. Returns red's win share (cumulative incidence of
    red wins), mean and median length, with game-bootstrap intervals."""
    G = len(games)
    last = np.zeros(G, int); end = np.zeros(G, int); redw = np.zeros(G, bool)
    for gi, g in enumerate(games):
        L = g['n_turns']
        c = next((t[0] for t in g['turns'] if not t[2]), 10 ** 6)
        last[gi] = min(L, c - 1)
        end[gi] = L if (L <= c - 1 and g['winner'] is not None) else 0
        redw[gi] = g['winner'] == 0

    def est(w):
        n = np.zeros(T + 2); dr = np.zeros(T + 2); db = np.zeros(T + 2)
        np.add.at(n, np.minimum(last, T) , w)              # at risk at 1..last: cumulate below
        n = n[::-1].cumsum()[::-1]; n[0] = 0
        e = end > 0
        np.add.at(dr, end[e & redw], w[e & redw]); np.add.at(db, end[e & ~redw], w[e & ~redw])
        surv, red, mean, med = 1.0, 0.0, 0.0, None
        for t in range(1, T + 1):
            if n[t] <= 0:
                break
            red += surv * dr[t] / n[t]; mean += surv
            surv *= 1 - (dr[t] + db[t]) / n[t]
            if med is None and surv <= 0.5:
                med = t
        return red / max(1 - surv, 1e-9), mean, med or T

    pt = est(np.ones(G))
    bs = np.array([est(w.astype(float)) for w in boot.W[:200]])
    lo, hi = np.percentile(bs, [2.5, 97.5], axis=0)
    return {'red_win': fmt((pt[0], lo[0], hi[0])), 'length_mean': fmt((pt[1], lo[1], hi[1]), 2),
            'length_median': fmt((pt[2], lo[2], hi[2]), 1)}


def game_stats(games, boot, label):
    G = len(games)
    res = {'games': G}
    fin = np.array([g['winner'] is not None for g in games], float)
    redw = np.array([g['winner'] == 0 for g in games], float)
    res['unfinished'] = int(G - fin.sum())
    res['red_win'] = fmt(boot.ratio(redw, fin))
    for var in ('standard', 'competitive'):
        m = np.array([g['variant'] == var for g in games], float)
        res[f'red_win_{var}'] = fmt(boot.ratio(redw * m, fin * m)) + [int((fin * m).sum())]
    clean = np.array([g['n_random'] == 0 for g in games], float)
    if label == 'selfplay':
        res['red_win_no_random_plies'] = fmt(boot.ratio(redw * clean, fin * clean)) + [int((fin * clean).sum())]
        res['random_plies_per_game'] = round(float(np.mean([g['n_random'] for g in games])), 2)
        nr = np.array([sum(1 for t in g['turns'] if not t[2] and t[1] == 0) for g in games])
        nb = np.array([sum(1 for t in g['turns'] if not t[2] and t[1] == 1) for g in games])
        res['red_win_by_random_ply_diff'] = {
            int(k): fmt(boot.ratio(redw * (np.clip(nr - nb, -3, 3) == k), fin * (np.clip(nr - nb, -3, 3) == k)))
            + [int((np.clip(nr - nb, -3, 3) == k).sum())] for k in range(-3, 4)}
        # PURE engine play, estimated from the games with no random ply. Each ply is
        # random with probability RANDOM_PCT independently of play, so a game of L
        # plies has no random ply with probability (1 - RANDOM_PCT)^L: weighting the
        # clean games by its inverse undoes the selection towards short games.
        Ln = np.array([g['n_turns'] for g in games], float)
        ipw = clean * fin * (1 - RANDOM_PCT) ** (-Ln)
        res['pure_play_ipw'] = {
            'games': int((clean * fin).sum()),
            'effective_games': round(float(ipw.sum() ** 2 / (ipw ** 2).sum()), 1),
            'red_win': fmt(boot.ratio(redw * ipw, ipw)),
            'length_mean': fmt(boot.ratio(Ln * ipw, ipw), 2),
            'length_median': fmt(boot.median(Ln[ipw > 0], np.where(ipw > 0)[0], wts=ipw[ipw > 0]), 1),
        }
        res['pure_play_km'] = pure_play_km(games, boot)
        for var in ('standard', 'competitive'):
            sub = [g for g in games if g['variant'] == var]
            res['pure_play_km'][var] = pure_play_km(sub, Boot(len(sub), 200, 7))
        # The weights reach ~500 for the longest games, so a handful of them can move
        # the estimate: also report it over games that end by turn 50 (weights <= 65).
        t50 = ipw * (Ln <= 50)
        res['pure_play_ipw']['red_win_games_to_turn_50'] = fmt(boot.ratio(redw * t50, t50))
        res['pure_play_ipw']['max_weight_share'] = round(float(ipw.max() / ipw.sum()), 4)
        for var in ('standard', 'competitive'):
            m = np.array([g['variant'] == var for g in games], float)
            res['pure_play_ipw'][f'red_win_{var}'] = fmt(boot.ratio(redw * ipw * m, ipw * m))
            res['pure_play_ipw'][f'length_mean_{var}'] = fmt(boot.ratio(Ln * ipw * m, ipw * m), 2)
    # How games end: the winner's sixth spell, or a score lead of 3.
    known = np.array([g['winner'] is not None and g.get('final_counter') is not None for g in games], float)
    six = np.array([bool(g.get('final_counter')) and max(g['final_counter']) >= 6 for g in games], float)
    res['ended_by_sixth_spell'] = fmt(boot.ratio(six * known, known)) + [int(known.sum())]
    L = np.array([g['n_turns'] for g in games], float)
    res['length_mean'] = fmt(boot.ratio(L * fin, fin), 2)
    res['length_median'] = fmt(boot.median(L[fin > 0], np.where(fin > 0)[0]), 1)
    res['length_quantiles'] = {q: float(np.percentile(L[fin > 0], q)) for q in (10, 25, 50, 75, 90)}
    for var in ('standard', 'competitive'):
        m = np.array([g['variant'] == var for g in games], float) * fin
        res[f'length_mean_{var}'] = fmt(boot.ratio(L * m, m), 2)
    res['length_hist'] = {int(k): int(v) for k, v in sorted(Counter(L[fin > 0].astype(int)).items())}
    return res


def turn_stats(games, boot):
    """Per-turn behaviour on measured turns: casts and dashes by lead, totals."""
    G = len(games)
    nb = len(LEADS)
    T = np.zeros((G, nb)); C = np.zeros((G, nb)); AV = np.zeros((G, nb)); AVC = np.zeros((G, nb))
    DK = np.zeros((G, nb)); D = np.zeros((G, nb))
    win_c = np.zeros(G); lose_c = np.zeros(G); fin = np.zeros(G)
    for gi, g in enumerate(games):
        for t in g['turns']:
            turn, c, meas, lead, castable, statics, casts, dash, new = t
            if not meas or casts is None:
                continue
            k = LEADS.index(lead_bucket(lead))
            T[gi, k] += 1; C[gi, k] += len(casts)
            if castable:
                AV[gi, k] += 1
                AVC[gi, k] += any(x in castable for x in casts)
            if dash is not None:
                DK[gi, k] += 1; D[gi, k] += dash
        if g['winner'] is not None and all(t[2] for t in g['turns']):
            # weighted as in game_stats' pure_play_ipw (self-play only)
            w = (1 - RANDOM_PCT) ** (-g['n_turns']) if g['src'] == 'selfplay' else 1.0
            fin[gi] = w
            for t in g['turns']:
                if t[6]:
                    (win_c if t[1] == g['winner'] else lose_c)[gi] += w * len(t[6])
    res = {'by_lead': {}}
    for k, name in enumerate(LEADS):
        res['by_lead'][name] = {
            'turns': int(T[:, k].sum()),
            'casts_per_turn': fmt(boot.ratio(C[:, k], T[:, k])),
            'cast_when_castable': fmt(boot.ratio(AVC[:, k], AV[:, k])),
            'castable_turns': int(AV[:, k].sum()),
            'dash_rate': fmt(boot.ratio(D[:, k], DK[:, k])), 'dash_known_turns': int(DK[:, k].sum())}
    res['all'] = {'turns': int(T.sum()), 'casts_per_turn': fmt(boot.ratio(C.sum(1), T.sum(1))),
                  'cast_when_castable': fmt(boot.ratio(AVC.sum(1), AV.sum(1))),
                  'castable_share_of_turns': fmt(boot.ratio(AV.sum(1), T.sum(1))),
                  'dash_rate': fmt(boot.ratio(D.sum(1), DK.sum(1))), 'dash_known_turns': int(DK.sum())}
    if fin.sum():
        res['casts_winner_per_game'] = fmt(boot.ratio(win_c, fin), 2)
        res['casts_loser_per_game'] = fmt(boot.ratio(lose_c, fin), 2)
        res['fully_measured_games'] = int((fin > 0).sum())
    return res


def prior_ok(g, tn):
    """Turns before `tn` were all played as recorded behaviour: no random self-play
    turn (it would put the engine in a situation it did not choose). In human games
    the AI's earlier turns are fine: they are the situation the human answers."""
    return g['src'] != 'selfplay' or all(u[2] for u in g['turns'][:tn - 1])


def opening_stats(games, n_turns=4):
    """Distribution of the nodes the mover newly occupies on turns 1..n, per variant."""
    res = {}
    for var in ('standard', 'competitive'):
        vv = {}
        for tn in range(1, n_turns + 1):
            cnt = Counter(); n = 0
            for g in games:
                if g['variant'] != var or len(g['turns']) < tn:
                    continue
                t = g['turns'][tn - 1]
                if not t[2] or t[8] is None:
                    continue
                if not prior_ok(g, tn):
                    continue
                n += 1
                for node in t[8]:
                    cnt[node] += 1
            vv[tn] = {'n': n, 'nodes': {NODE_NAMES[k]: round(v / n, 4) for k, v in cnt.most_common()} if n else {}}
        res[var] = vv
    return res


def opening_reply(games, var='competitive', top=6):
    """Turn-2 reply given turn-1's node (both measured), for the commonest turn-1 nodes."""
    first = Counter(); reply = defaultdict(Counter)
    for g in games:
        if g['variant'] != var or len(g['turns']) < 2:
            continue
        a, b = g['turns'][0], g['turns'][1]
        if not prior_ok(g, 2) or not b[2] or not a[8] or not b[8]:
            continue
        k = NODE_NAMES[a[8][0]]
        first[k] += 1
        for node in b[8]:
            reply[k][NODE_NAMES[node]] += 1
    return {k: {'n': n, 'reply': {x: round(v / n, 3) for x, v in reply[k].most_common(6)}}
            for k, n in first.most_common(top)}


def opening_by_spell(games, var, turn_no, boot):
    """P(turn `turn_no`'s new stone lands on spell X's sigil | X drawn), against the
    same slot's base rate over all draws: does the draw steer the opening?"""
    G = len(games)
    hit = np.zeros((G, N_SPELLS)); den = np.zeros((G, N_SPELLS))
    slot_hit = np.zeros((G, 9)); slot_den = np.zeros((G, 9))
    for gi, g in enumerate(games):
        if g['variant'] != var or len(g['turns']) < turn_no:
            continue
        t = g['turns'][turn_no - 1]
        if not prior_ok(g, turn_no) or not t[2] or not t[8]:
            continue
        slots = {NODE_SLOT.get(n) for n in t[8]} - {None}
        for p, s in enumerate(g['spells']):
            if s >= N_SPELLS:
                continue
            den[gi, s] += 1; hit[gi, s] += p in slots
            slot_den[gi, p] += 1; slot_hit[gi, p] += p in slots
    sp = boot.ratio(hit, den); sl = boot.ratio(slot_hit, slot_den)
    rows = {}
    for s in range(N_SPELLS):
        n = int(den[:, s].sum())
        if n:
            rows[SPELL_NAMES[s]] = {'n': n, 'p': round(float(sp[0][s]), 4), 'lo': round(float(sp[1][s]), 4),
                                    'hi': round(float(sp[2][s]), 4)}
    return {'per_spell': rows, 'per_slot': [fmt((sl[0][p], sl[1][p], sl[2][p]), 4) for p in range(9)]}


def human_side_stats(games, boot):
    """Human win rate as red vs as blue against each AI family (human-vs-AI only)."""
    res = {}
    groups = defaultdict(list)
    for gi, g in enumerate(games):
        p = g['players']
        if (p[0] == 'human') == (p[1] == 'human') or g['winner'] is None:
            continue
        hs = 0 if p[0] == 'human' else 1
        groups[p[1 - hs]].append((gi, hs, g['winner'] == hs))
    G = len(games)
    for ai, lst in sorted(groups.items(), key=lambda x: -len(x[1])):
        r = {}
        for hs, nm in ((0, 'as_red'), (1, 'as_blue')):
            num = np.zeros(G); den = np.zeros(G)
            for gi, h, w in lst:
                if h == hs:
                    den[gi] = 1; num[gi] = w
            r[nm] = fmt(boot.ratio(num, den)) + [int(den.sum())]
        num_r = np.zeros(G); den_r = np.zeros(G); num_b = np.zeros(G); den_b = np.zeros(G)
        for gi, h, w in lst:
            if h == 0:
                den_r[gi] = 1; num_r[gi] = w
            else:
                den_b[gi] = 1; num_b[gi] = w
        with np.errstate(invalid='ignore', divide='ignore'):
            bs = (boot.W @ num_r) / (boot.W @ den_r) - (boot.W @ num_b) / (boot.W @ den_b)
        pt = num_r.sum() / max(den_r.sum(), 1) - num_b.sum() / max(den_b.sum(), 1)
        r['red_minus_blue'] = fmt((pt, np.nanpercentile(bs, 2.5), np.nanpercentile(bs, 97.5)))
        res[ai] = r
    # pooled, each AI family weighted by its games (a stratified red-minus-blue)
    tot = sum(len(v) for k, v in groups.items() if all(res[k]['as_' + c][3] for c in ('red', 'blue')))
    acc = np.zeros(boot.W.shape[0]); pt = 0.0
    for ai, lst in groups.items():
        if not (res[ai]['as_red'][3] and res[ai]['as_blue'][3]):
            continue
        w = len(lst) / tot
        num_r = np.zeros(G); den_r = np.zeros(G); num_b = np.zeros(G); den_b = np.zeros(G)
        for gi, h, ww in lst:
            if h == 0:
                den_r[gi] = 1; num_r[gi] = ww
            else:
                den_b[gi] = 1; num_b[gi] = ww
        with np.errstate(invalid='ignore', divide='ignore'):
            acc += w * np.nan_to_num((boot.W @ num_r) / (boot.W @ den_r) - (boot.W @ num_b) / (boot.W @ den_b))
        pt += w * (num_r.sum() / den_r.sum() - num_b.sum() / den_b.sum())
    res['pooled_red_minus_blue'] = fmt((pt, np.percentile(acc, 2.5), np.percentile(acc, 97.5)))
    return res


def cmd_analyse(a):
    sp = pickle.load(open(a.selfplay, 'rb')); hu = pickle.load(open(a.human, 'rb'))
    S = sp['games']; H = hu['games']
    hh = [g for g in H if g['players'][0] == 'human' and g['players'][1] == 'human']
    hai = [g for g in H if g not in hh]
    bS = Boot(len(S), a.boot, 1); bH = Boot(len(H), a.boot, 2)
    out = {'meta': {'selfplay_chunks': sp['chunks'], 'selfplay_games': len(S),
                    'selfplay_unreadable': len(sp['errors']),
                    'human_games': len(H), 'human_skipped': hu['skipped'],
                    'human_vs_human_games': len(hh), 'human_vs_ai_games': len(hai),
                    'human_variants': dict(Counter(g['variant'] for g in H)),
                    'selfplay_variants': dict(Counter(g['variant'] for g in S)),
                    'ai_opponents': dict(Counter(p for g in hai for p in g['players'] if p != 'human')),
                    'boot': a.boot, 'engine': ENGINE}}
    print('games', flush=True)
    out['games'] = {'selfplay': game_stats(S, bS, 'selfplay'), 'human_all': game_stats(H, bH, 'human')}
    if hh:
        bHH = Boot(len(hh), a.boot, 3)
        out['games']['human_vs_human'] = game_stats(hh, bHH, 'human')
    out['human_side'] = human_side_stats(H, bH)
    print('spells', flush=True)
    out['spells'] = {'selfplay': spell_stats(S, bS), 'human': spell_stats(H, bH)}
    print('turns', flush=True)
    out['turns'] = {'selfplay': turn_stats(S, bS), 'human': turn_stats(H, bH)}
    # human by Elo band (the human's Elo before the game)
    bands = [(0, 1300), (1300, 1450), (1450, 9999)]
    out['turns']['human_by_elo'] = {}
    for lo, hi in bands:
        sub = []
        for g in H:
            hs = [c for c in (0, 1) if g['players'][c] == 'human' and g['elo'][c] is not None
                  and lo <= g['elo'][c] < hi]
            if hs:
                gg = dict(g); gg['turns'] = [t[:2] + (t[2] and t[1] in hs,) + t[3:] for t in g['turns']]
                sub.append(gg)
        if sub:
            r = turn_stats(sub, Boot(len(sub), a.boot, 4))
            r['games'] = len(sub)
            out['turns']['human_by_elo'][f'{lo}-{hi}'] = r
    print('openings', flush=True)
    out['openings'] = {'selfplay': opening_stats(S), 'human': opening_stats(H),
                       'reply_selfplay': opening_reply(S), 'reply_human': opening_reply(H)}
    out['opening_by_spell'] = {
        'selfplay_comp_t1': opening_by_spell(S, 'competitive', 1, bS),
        'selfplay_comp_t2': opening_by_spell(S, 'competitive', 2, bS),
        'human_comp_t1': opening_by_spell(H, 'competitive', 1, bH),
        'human_comp_t2': opening_by_spell(H, 'competitive', 2, bH)}
    json.dump(out, open(a.out, 'w'), indent=1)
    print(f'wrote {a.out}', flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('extract-selfplay'); p.add_argument('src'); p.add_argument('out')
    p.add_argument('--jobs', type=int, default=os.cpu_count())
    p = sub.add_parser('extract-human'); p.add_argument('lines'); p.add_argument('raw'); p.add_argument('out')
    p = sub.add_parser('analyse'); p.add_argument('selfplay'); p.add_argument('human'); p.add_argument('out')
    p.add_argument('--boot', type=int, default=400)
    a = ap.parse_args()
    {'extract-selfplay': cmd_extract_selfplay, 'extract-human': cmd_extract_human,
     'analyse': cmd_analyse}[a.cmd](a)


if __name__ == '__main__':
    main()
