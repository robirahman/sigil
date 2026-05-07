"""Verify the trained blunder head's predictions on annotated positions.

For each annotated row in human_games.jsonl, computes the per-turn
blunder logits and ranks the played turn. If the blunder head is
useful, the played turn should rank near the top for 'bad' rows
(meaning the head correctly elevates its blunder probability vs the
other legal turns at the same position).

Usage:
    python -m ai.verify_blunder_v2
"""

import json
import sys
import torch
import torch.nn.functional as F

import numpy as np

sys.path.insert(0, '.')

from simboard import SimBoard
from ai.sigil_net import SigilNet
from ai.features import board_to_tensor, encode_all_turns
from notation import sfn_to_dict


def main():
    model = SigilNet.load_or_create('ai/models/candidate_blunder.pt', device='cpu')
    model.eval()

    bad_ranks = []
    good_ranks = []
    bad_logits = []
    good_logits = []
    other_logits = []
    unannot_max_sigmoids = []

    with open('ai/data/human_games.jsonl') as f:
        lines = f.readlines()
    import random
    random.Random(42).shuffle(lines)
    for line in lines:
        d = json.loads(line)
        ann = d.get('annotation')
        # For unannotated rows, also check the head's max sigmoid value
        # to see how often it spuriously flags any move as a blunder.
        if ann not in ('good', 'bad'):
            if len(unannot_max_sigmoids) >= 200:
                continue
        sfn = d['sfn']
        try:
            b = SimBoard.from_sfn(sfn)
        except Exception:
            continue
        color = b.whose_turn

        legal = list(b.get_legal_turns(color))
        if len(legal) <= 1:
            continue

        policy = d['policy']
        played_idx = int(np.argmax(policy))
        if played_idx >= len(legal):
            continue

        raw, spell_ids = board_to_tensor(b, color)
        tf = encode_all_turns(legal, b, color)
        raw = raw.unsqueeze(0); spell_ids = spell_ids.unsqueeze(0)
        tf = tf.unsqueeze(0)
        counts = torch.tensor([tf.size(1)], dtype=torch.long)

        with torch.no_grad():
            v, logits, blunder_logits = model.forward(
                raw, spell_ids, tf, counts, return_blunder=True)
        bl = blunder_logits.squeeze(0).cpu().numpy()
        if ann is None or ann == '':
            # Unannotated: track the max sigmoid to detect spurious flags
            sigmoids = 1 / (1 + np.exp(-bl))
            unannot_max_sigmoids.append(float(sigmoids.max()))
            continue
        played_logit = float(bl[played_idx])
        other = bl[np.arange(len(bl)) != played_idx]
        rank = int((bl > played_logit).sum())
        if ann == 'bad':
            bad_ranks.append(rank)
            bad_logits.append(played_logit)
            other_logits.extend(other.tolist())
        else:
            good_ranks.append(rank)
            good_logits.append(played_logit)

    print(f'Bad annotations: {len(bad_ranks)}')
    print(f'  Played turn rank (lower = better): mean={np.mean(bad_ranks):.2f}, '
          f'median={np.median(bad_ranks):.1f}')
    print(f'  Played-turn blunder logit: mean={np.mean(bad_logits):+.3f}')
    print(f'  Other-turn blunder logit:  mean={np.mean(other_logits):+.3f}')
    print(f'  Sigmoid(played-bad mean):  {1 / (1 + np.exp(-np.mean(bad_logits))):.3f}')
    print(f'  Sigmoid(other mean):       {1 / (1 + np.exp(-np.mean(other_logits))):.3f}')
    print(f'  Fraction where played is rank 0: '
          f'{sum(r == 0 for r in bad_ranks) / max(1,len(bad_ranks)):.2%}')
    print(f'  Fraction where played is in top 3: '
          f'{sum(r <= 2 for r in bad_ranks) / max(1,len(bad_ranks)):.2%}')

    print(f'\nGood annotations: {len(good_ranks)}')
    if good_ranks:
        print(f'  Played turn rank: mean={np.mean(good_ranks):.2f}, median={np.median(good_ranks):.1f}')
        print(f'  Played-turn blunder logit mean: {np.mean(good_logits):+.3f}')

    print(f'\nUnannotated positions sampled: {len(unannot_max_sigmoids)}')
    if unannot_max_sigmoids:
        arr = np.array(unannot_max_sigmoids)
        print(f'  Max blunder sigmoid per position:')
        print(f'    median: {np.median(arr):.3f}')
        print(f'    p90:    {np.percentile(arr, 90):.3f}')
        print(f'    p99:    {np.percentile(arr, 99):.3f}')
        print(f'    max:    {arr.max():.3f}')
        # How often does the head fire >0.5 on a non-annotated position?
        n_high = (arr > 0.5).sum()
        print(f'  Positions with any move at sigmoid > 0.5: {n_high}/{len(arr)} '
              f'({n_high/len(arr):.1%})')


if __name__ == '__main__':
    main()
