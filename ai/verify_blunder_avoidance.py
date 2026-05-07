"""Verify a model never prefers any human-flagged 'bad' move.

Two checks per bad-annotated position:
  1. Raw policy head: argmax over legal turns must not be the bad move.
  2. MCTS search (no inference-time mask): chosen turn must not be the bad move.

Usage:
    python -m ai.verify_blunder_avoidance --model ai/models/candidate_v16.pt
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch

from ai.forbidden_moves import position_key, turn_signature
from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.sigil_net_graph import SigilNetGraph
from ai.mcts import mcts_search
from ai.features import board_to_tensor, encode_all_turns
from notation import sfn_to_dict
from simboard import SimBoard


def _load_model(path):
    ckpt = torch.load(path, map_location='cpu', weights_only=False)
    arch = ckpt.get('arch')
    if arch == 'SigilNetHard':
        m = SigilNetHard.load(path)
    elif arch == 'SigilNetGraph':
        m = SigilNetGraph.load(path)
    else:
        m = SigilNet.load(path)
    m.eval()
    return m


def _model_policy(model, sim, color, blunder_lambda=0.0):
    """Return (scores_per_legal_turn, legal_turns).

    Scores are policy logits, optionally with blunder-head suppression
    applied: `policy_logits - blunder_lambda * sigmoid(blunder_logits)`.
    """
    legal = list(sim.get_legal_turns(color))
    if not legal:
        return None, legal
    raw_feat, spell_ids = board_to_tensor(sim, color)
    turn_feats = encode_all_turns(legal, sim, color)
    return_blunder = blunder_lambda > 0
    with torch.no_grad():
        out = model(
            raw_feat.unsqueeze(0),
            spell_ids.unsqueeze(0),
            turn_feats.unsqueeze(0),
            torch.tensor([len(legal)], dtype=torch.long),
            return_blunder=return_blunder,
        )
    if return_blunder:
        v, logits, blunder_logits = out
        adj = logits - blunder_lambda * torch.sigmoid(blunder_logits)
    else:
        v, logits = out
        adj = logits
    return adj[0, :len(legal)].cpu().numpy(), legal


def verify(model_path, data_path, sims=64, blunder_lambda=0.0):
    model = _load_model(model_path)

    raw_picks_bad = 0
    mcts_picks_bad = 0
    raw_total = 0
    mcts_total = 0

    with open(data_path) as f:
        for line in f:
            d = json.loads(line)
            if d.get('annotation') != 'bad':
                continue
            sfn = d.get('sfn')
            policy = d.get('policy') or []
            if not sfn or not policy:
                continue
            color = sfn_to_dict(sfn)['turn']
            board = SimBoard.from_sfn(sfn)
            legal = list(board.get_legal_turns(color))
            if not legal or len(legal) != len(policy):
                continue
            bad_idx = max(range(len(policy)), key=lambda i: policy[i])
            bad_sig = turn_signature(legal[bad_idx])

            # Raw policy check (with optional blunder-head suppression)
            p, _legal = _model_policy(model, board, color,
                                      blunder_lambda=blunder_lambda)
            if p is not None:
                argmax_idx = int(p.argmax())
                if turn_signature(legal[argmax_idx]) == bad_sig:
                    raw_picks_bad += 1
                raw_total += 1

            # MCTS check
            best_turn, _, _ = mcts_search(
                board, color, model,
                num_simulations=sims,
                time_limit=None,
                add_noise=False,
                temperature=None,
                blunder_lambda=blunder_lambda,
            )
            if best_turn is not None and turn_signature(best_turn) == bad_sig:
                mcts_picks_bad += 1
            mcts_total += 1

    name = os.path.basename(model_path)
    tag = f' (lambda={blunder_lambda})' if blunder_lambda > 0 else ''
    print(f'{name}{tag}: raw policy picks bad on {raw_picks_bad}/{raw_total}; '
          f'MCTS picks bad on {mcts_picks_bad}/{mcts_total}')
    return raw_picks_bad == 0 and mcts_picks_bad == 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--data', default='ai/data/human_games.jsonl')
    ap.add_argument('--sims', type=int, default=64)
    ap.add_argument('--blunder-lambda', type=float, default=0.0)
    args = ap.parse_args()
    ok = verify(args.model, args.data, sims=args.sims,
                blunder_lambda=args.blunder_lambda)
    sys.exit(0 if ok else 1)
