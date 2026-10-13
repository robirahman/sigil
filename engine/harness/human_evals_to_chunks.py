"""Recorded human games + their engine evaluations -> training chunks (round 5, 2026-10).

    human_evals_to_chunks.py <lines.json> <out-dir> <evals.jsonl> [<evals.jsonl> ...]
                             [--depth 5] [--per-chunk 2000]

Interpretability experiment 9 scored every position of every recorded human game
with the shipped v31 search (eval_games.py eval --walk backward, fixed depth 5).
Robi (2026-10-13) added those positions to the round-5 training data. This writes
them in the chunk format `nn_eval.py prep` reads (the fields relabel_depth.py
keeps: sfn, spells, is_red, y, game, ply, kind, full, plus score):

  score  the depth-D search score from the side to move, centistones (the row's
         raw `score`, the same scale selfplay_v2.py records)
  y      1 if the side to move went on to win, 0 if it lost, 255 if unknown
  game   950,000,000 + a stable hash of the room code, so every human game has
         its own id (prep splits by game) outside the self-play seed ranges
  kind   0 standard, 1 competitive opening (as selfplay_v2.py)

Kept: standard and competitive games whose spells the engine plays and whose
rules have not changed since (ai/data_filters.is_old_rules_game, as
selfplay_v2.py filters its human starts); positions the search scored at the
requested depth with the backward walk; not the final position.
"""
import argparse, hashlib, json, os, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(_HERE, '..', '..'))
import sigil_engine as se
from ai.data_filters import is_old_rules_game

GAME_BASE = 950_000_000


def game_id(code):
    return GAME_BASE + int(hashlib.sha1(code.encode()).hexdigest()[:8], 16) % 10_000_000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('lines'); ap.add_argument('out'); ap.add_argument('evals', nargs='+')
    ap.add_argument('--depth', type=int, default=5)
    ap.add_argument('--per-chunk', type=int, default=2000)
    a = ap.parse_args()
    rows = {}
    for path in a.evals:
        for line in open(path):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get('walk') != 'backward' or r.get('d') != a.depth or r.get('over'):
                continue
            rows[(r['g'], r['i'])] = r
    lines = json.load(open(a.lines))
    os.makedirs(a.out, exist_ok=True)
    buf = {k: [] for k in ('sfn', 'spells', 'is_red', 'y', 'game', 'ply', 'kind', 'full', 'score')}
    stats = {'games': 0, 'positions': 0, 'skipped_games': {}}
    n_chunk = 0

    def flush():
        nonlocal n_chunk
        if not buf['sfn']:
            return
        out = {'sfn': np.array(buf['sfn']), 'spells': np.array(buf['spells'], np.uint8),
               'is_red': np.array(buf['is_red'], np.uint8), 'y': np.array(buf['y'], np.uint8),
               'game': np.array(buf['game'], np.int64), 'ply': np.array(buf['ply'], np.int16),
               'kind': np.array(buf['kind'], np.uint8), 'full': np.array(buf['full'], np.float32),
               'score': np.array(buf['score'], np.int32)}
        np.savez_compressed(os.path.join(a.out, f'human_e9_d{a.depth}_{n_chunk:04d}.npz'), **out)
        n_chunk += 1
        for v in buf.values():
            v.clear()

    def skip(why):
        stats['skipped_games'][why] = stats['skipped_games'].get(why, 0) + 1

    for code in sorted(lines):
        g = lines[code]
        var = g.get('variant', 'standard')
        if var not in ('standard', 'competitive'):
            skip(f'variant {var}'); continue
        pos = g['positions']
        if isinstance(pos, str):
            pos = json.loads(pos.replace("'", '"'))
        if is_old_rules_game(pos[0].split(' ')[0].split('/')[1].split(','), g.get('timestamp')):
            skip('old rules'); continue
        try:
            boards = [se.Board.from_sfn(s) for s in pos[:-1]]
        except ValueError:
            skip('retired or out-of-scope spell'); continue
        w = g.get('winner')
        kept = 0
        for i, b in enumerate(boards):
            r = rows.get((code, i))
            if r is None or b.gameover:
                continue
            mover = 'red' if pos[i].split()[1] == 'r' else 'blue'
            buf['sfn'].append(pos[i]); buf['spells'].append(list(b.spell_ids()))
            buf['is_red'].append(int(mover == 'red'))
            buf['y'].append(255 if w not in ('red', 'blue') else int(w == mover))
            buf['game'].append(game_id(code)); buf['ply'].append(i)
            buf['kind'].append(int(var == 'competitive'))
            buf['full'].append(b.full_features(mover)); buf['score'].append(int(r['score']))
            kept += 1
            if len(buf['sfn']) >= a.per_chunk:
                flush()
        if kept:
            stats['games'] += 1; stats['positions'] += kept
        else:
            skip('no scored position')
    flush()
    stats['chunks'] = n_chunk
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
