"""Compare the model's value head against human position-eval annotations.

Loads a checkpoint and a human-game JSONL, evaluates each row that has a
`position_eval` annotation, and prints the cases where the model most
strongly disagrees with the human verdict on who's winning. Useful for
spotting positions the model misjudges — they're the natural seed set
for either (a) targeted re-annotation, or (b) hand-crafted positions to
add to the training set.

Usage:
    python -m ai.investigate_annotations \\
        --model ai/models/best_model.pt \\
        --data ai/data/human/human_games_<date>_aug3.jsonl \\
        --top 20

Output (one row per disagreement, sorted by |model_value - eval_value|):

    SFN     model_v   human_eval  human_v   delta   _gid
    ...

`model_v` is from the side-to-move's perspective in [-1, +1]. `human_v`
is the human eval translated to the same perspective (+1 = side wins,
-1 = opp wins, 0 = even). `delta` is the L1 disagreement; large negative
values mean the model is confident the side-to-move is winning when the
human said the opponent is winning (or vice versa).
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch

from ai.sigil_net import SigilNet


def _materialize(rec):
    """Return (raw, spell_ids) tensors for a single position record."""
    raw = torch.tensor(rec['raw_features'], dtype=torch.float32)
    spell_ids = torch.tensor(rec['spell_ids'], dtype=torch.long)
    return raw, spell_ids


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', default='ai/models/best_model.pt')
    p.add_argument('--data', required=True,
                   help='Human-game JSONL (must contain position_eval rows)')
    p.add_argument('--top', type=int, default=20,
                   help='Print the top-K disagreements')
    p.add_argument('--device', default='cpu',
                   help='cpu / cuda. Inference only.')
    p.add_argument('--batch-size', type=int, default=256)
    args = p.parse_args()

    model = SigilNet.load(args.model, device=args.device)
    model = model.to(args.device)
    model.eval()

    rows = []
    with open(args.data) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if 'eval_outcome' not in rec or 'position_eval' not in rec:
                continue
            rows.append(rec)
    if not rows:
        print(f"No rows with position_eval in {args.data}; nothing to compare.")
        return

    print(f"Comparing model vs {len(rows)} human-evaluated position(s).")

    # Batched value forward.
    model_v = []
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        raws = torch.stack([torch.tensor(b['raw_features'], dtype=torch.float32)
                            for b in batch]).to(args.device)
        sids = torch.stack([torch.tensor(b['spell_ids'], dtype=torch.long)
                            for b in batch]).to(args.device)
        with torch.no_grad():
            v, _ = model.forward(raws, sids)
        model_v.extend(v.squeeze(-1).cpu().tolist())

    enriched = []
    sign_disagree = 0
    for r, mv in zip(rows, model_v):
        hv = float(r['eval_outcome'])
        delta = abs(mv - hv)
        enriched.append((delta, mv, hv, r))
        if (mv > 0) != (hv > 0) and hv != 0 and mv != 0:
            sign_disagree += 1
    enriched.sort(reverse=True)

    print(f"Sign disagreements (model vs human, ignoring 'even'): "
          f"{sign_disagree}/{len(rows)}")
    print()
    fmt = "{:>6}  {:>+8.3f}  {:>10}  {:>+5.1f}  {:>6.3f}  {}"
    print(f"{'#':>6}  {'model_v':>8}  {'human_eval':>10}  "
          f"{'human_v':>5}  {'delta':>6}  game_id (sfn)")
    print("-" * 90)
    for rank, (delta, mv, hv, r) in enumerate(enriched[:args.top], start=1):
        eval_label = r.get('position_eval', '?')
        gid = r.get('_gid') or f"idx={r.get('game_index')}"
        sfn = r.get('sfn', '')
        # Truncate sfn for display
        if len(sfn) > 40:
            sfn = sfn[:37] + '...'
        print(fmt.format(rank, mv, eval_label, hv, delta, f"{gid}  {sfn}"))


if __name__ == '__main__':
    main()
