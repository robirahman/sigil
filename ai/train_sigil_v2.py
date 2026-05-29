"""Redesigned SigilNet training.

Differences from train_sigil.py:

1. **Standard supervised losses.** Drops the negative-reinforcement on loser
   positions and the -0.01 anti-greedy term on winner unchosen moves. Both
   added noise without clear signal: the loser's "chosen move" was usually
   the best of bad options, not a move to push away from; the -0.01 trick
   prematurely collapses the policy distribution.

2. **Train policy only on winner positions** (for human data with one-hot
   targets). The behavioral-cloning signal is "imitate winners". Self-play
   data (MCTS visit-count targets) trains policy on every position.

3. **Game-level train/val split.** Positions from the same game stay on the
   same side of the split. The position-level split in train_sigil.py let
   val_acc reach 0.9+ purely via leakage — masking real overfitting.

4. **Rating-aware sample weights.** Per-position weight =
   clip((player_elo - 800) / 400, 0.5, 2.0) — strong play counts up to 4×
   weak play. Self-play positions get a fixed weight (default 0.3) so the
   network gets new signal from human play instead of re-fitting old data.

5. **Lower fine-tune LR** (default 1e-4 → 1e-5). Continuing from an existing
   best_model with LR=1e-3 disrupts learned weights.

6. **Early stopping + best-model save.** Train up to --epochs but stop after
   --patience epochs without val-loss improvement. The saved checkpoint is
   the epoch with lowest weighted val loss, not the last epoch.

Usage:
    python -m ai.train_sigil_v2 \\
        --human ai/data/human_games_v3.jsonl \\
        --self-play ai/data/selfplay_clean.jsonl ai/data/selfplay_synthetic_clean.jsonl \\
        --model ai/models/best_model_baseline_2026-05-01.pt \\
        --output ai/models/candidate_v4.pt \\
        --epochs 30 --patience 4 --device cuda
"""

import argparse
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.sigil_net_graph import SigilNetGraph
from ai.config import (
    BATCH_SIZE, WEIGHT_DECAY, MODELS_DIR, TURN_FEATURE_DIM, RAW_FEATURE_DIM,
)
from notation import sfn_to_dict
from simboard import SimBoard
from ai.features import board_to_tensor, encode_all_turns
from ai.enumerator import get_legal_turns_exhaustive
from ai.config import EXHAUSTIVE_ENUM
from ai.data_filters import (
    is_pre_cutoff_fireblast_record,
    is_pre_competitive_fix_record,
)


def _legal_for_training(sb, side):
    """Enumerate turns the same way self-play did, so re-materialized turn
    encodings stay aligned (same count + order) with the stored policy."""
    if EXHAUSTIVE_ENUM:
        return list(get_legal_turns_exhaustive(sb, side, exhaustive=True))
    return list(sb.get_legal_turns(side))


def _materialize_features(d):
    """Compute raw_features / spell_ids / turn_encodings on the record.

    Re-computes if cached values exist but have stale dimensionality
    (e.g. JSONLs produced under an older RAW_FEATURE_DIM /
    TURN_FEATURE_DIM). The current feature schema is the source of
    truth; cached values are an optimization, not the contract.
    """
    raw_cached = d.get('raw_features')
    if raw_cached is None or len(raw_cached) != RAW_FEATURE_DIM:
        sb = SimBoard.from_sfn(d['sfn'])
        side = sfn_to_dict(d['sfn'])['turn']
        raw, spell_ids = board_to_tensor(sb, side)
        d['raw_features'] = raw.numpy().tolist()
        d['spell_ids'] = spell_ids.numpy().tolist()
        # Turn encodings are tied to feature schema too — recompute.
        legal = _legal_for_training(sb, side)
        if legal:
            tf = encode_all_turns(legal, sb, side)
            d['turn_encodings'] = tf.numpy().tolist()
        else:
            d['turn_encodings'] = []
    elif d.get('turn_encodings'):
        first_row = d['turn_encodings'][0] if d['turn_encodings'] else None
        if first_row is None or len(first_row) != TURN_FEATURE_DIM:
            sb = SimBoard.from_sfn(d['sfn'])
            side = sfn_to_dict(d['sfn'])['turn']
            legal = _legal_for_training(sb, side)
            if legal:
                tf = encode_all_turns(legal, sb, side)
                d['turn_encodings'] = tf.numpy().tolist()
            else:
                d['turn_encodings'] = []


def rating_weight(elo):
    """Map Elo to per-sample weight in [0.5, 2.0]."""
    if elo is None:
        return 1.0
    return float(np.clip((elo - 800) / 400, 0.5, 2.0))


def load_jsonl(path, source, default_weight=1.0, min_elo=0,
               bad_oversample=1):
    """Load a JSONL into list of records, tagged with source / weight / game_id.

    source: 'human' or 'selfplay' — drives policy-loss eligibility.
    default_weight: applied to every position from this file before rating boost.
    min_elo: skip human positions whose player_elo is below this threshold.
    bad_oversample: replicate each annotation=='bad' record this many times.
        With only a handful of bad annotations in 7K positions, replication is
        the simplest way to ensure the negative signal is seen often enough
        per epoch to drive the loss.
    """
    records = []
    bad = 0
    skipped_fireblast = 0
    skipped_competitive = 0
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue

            sfn = d.get('sfn')
            # Skip records that pre-date the Fireblast rule change
            # and contain Fireblast (see ai/data_filters.py).
            if is_pre_cutoff_fireblast_record(path, sfn):
                skipped_fireblast += 1
                continue
            # Skip records from the buggy Competitive variant opening
            # (off-by-one fix landed 2026-05-08).
            if is_pre_competitive_fix_record(path, sfn):
                skipped_competitive += 1
                continue

            policy = d.get('policy', [])
            if not policy:
                continue

            if source == 'human':
                player_elo = d.get('player_elo')
                if player_elo is not None and player_elo < min_elo:
                    continue
                w = default_weight * rating_weight(player_elo)
                # Per-position game grouping. Fall back to a unique id so
                # missing-game-id rows don't all collapse into one group.
                gid = d.get('game_index')
                if gid is None:
                    gid = ('h_uniq', len(records))
                else:
                    gid = ('h', gid)
            else:
                w = default_weight
                # Self-play files have no game_index; treat each position as
                # its own group so they distribute uniformly into train/val.
                gid = ('sp', path, len(records))

            _materialize_features(d)

            # Defensive consistency check: the engine's legal-turn
            # enumeration sometimes drifts after rule fixes (e.g., the
            # Comet sacrifice patch), leaving cached `policy` longer
            # than the regenerated `turn_encodings`. Drop the row in
            # that case rather than crash the collate.
            te = d.get('turn_encodings') or []
            if len(te) < len(policy):
                bad += 1
                continue

            rec = {
                'raw_features': d['raw_features'],
                'spell_ids': d['spell_ids'],
                'turn_encodings': te,
                'policy': policy,
                'outcome': d['outcome'],
                'num_turns': len(policy),
                'source': source,
                'weight': w,
                'game_id': gid,
                'annotation': d.get('annotation'),
            }
            records.append(rec)
            if rec['annotation'] == 'bad' and bad_oversample > 1:
                for _ in range(bad_oversample - 1):
                    records.append(rec)
    if bad:
        print(f"  {path}: skipped {bad} malformed line(s)")
    if skipped_fireblast:
        print(f"  {path}: skipped {skipped_fireblast} pre-2026-05-07 "
              f"Fireblast position(s)")
    if skipped_competitive:
        print(f"  {path}: skipped {skipped_competitive} pre-2026-05-08 "
              f"Competitive-variant position(s) (opening-pass bug)")
    print(f"  {path}: loaded {len(records)} records (source={source})")
    return records


class SigilDataset(Dataset):
    def __init__(self, records):
        self.records = records

    def __len__(self):
        return len(self.records)

    def __getitem__(self, idx):
        r = self.records[idx]
        return r


def collate_fn(batch):
    raw_features = torch.stack([
        torch.tensor(b['raw_features'], dtype=torch.float32) for b in batch
    ])
    spell_ids = torch.stack([
        torch.tensor(b['spell_ids'], dtype=torch.long) for b in batch
    ])
    outcomes = torch.tensor([b['outcome'] for b in batch], dtype=torch.float32)
    weights = torch.tensor([b['weight'] for b in batch], dtype=torch.float32)
    # 'human' positions: only winners contribute to policy loss.
    # 'selfplay' positions: all contribute (targets are MCTS visits).
    policy_eligible = torch.tensor([
        (b['source'] == 'selfplay') or (b['outcome'] > 0)
        for b in batch
    ], dtype=torch.float32)
    # Encode annotation: +1 = 'good' (override into policy loss with extra
    # weight), -1 = 'bad' (negative weight, push prob away from chosen move),
    # 0 = no annotation.
    annotation_code = torch.tensor([
        {'good': 1.0, 'bad': -1.0}.get(b.get('annotation'), 0.0)
        for b in batch
    ], dtype=torch.float32)

    max_turns = max(b['num_turns'] for b in batch)
    B = len(batch)
    turn_encodings = torch.zeros(B, max_turns, TURN_FEATURE_DIM)
    policies = torch.zeros(B, max_turns)
    turn_counts = torch.zeros(B, dtype=torch.long)

    for i, b in enumerate(batch):
        n = b['num_turns']
        turn_encodings[i, :n] = torch.tensor(
            b['turn_encodings'], dtype=torch.float32)[:n]
        policies[i, :n] = torch.tensor(b['policy'], dtype=torch.float32)[:n]
        turn_counts[i] = n

    return {
        'raw_features': raw_features,
        'spell_ids': spell_ids,
        'turn_encodings': turn_encodings,
        'policies': policies,
        'turn_counts': turn_counts,
        'outcomes': outcomes,
        'weights': weights,
        'policy_eligible': policy_eligible,
        'annotation_code': annotation_code,
    }


def split_by_game(records, val_fraction=0.1, seed=0):
    """Hold out val_fraction of distinct game_ids for validation."""
    rng = np.random.default_rng(seed)
    by_game = {}
    for i, r in enumerate(records):
        by_game.setdefault(r['game_id'], []).append(i)
    games = list(by_game.keys())
    rng.shuffle(games)
    n_val = max(1, int(len(games) * val_fraction))
    val_games = set(games[:n_val])
    train_idx, val_idx = [], []
    for gid, idxs in by_game.items():
        target = val_idx if gid in val_games else train_idx
        target.extend(idxs)
    return train_idx, val_idx


def compute_losses(model, batch, device, label_smoothing=0.0,
                   annotation_good_weight=3.0, annotation_bad_weight=2.0,
                   blunder_weight=0.0, blunder_pos_weight=1.0,
                   tactical_weight=0.0):
    raw = batch['raw_features'].to(device)
    spell_ids = batch['spell_ids'].to(device)
    turn_enc = batch['turn_encodings'].to(device)
    target_policy = batch['policies'].to(device)
    turn_counts = batch['turn_counts'].to(device)
    target_outcome = batch['outcomes'].to(device)
    weights = batch['weights'].to(device)
    pol_elig = batch['policy_eligible'].to(device)
    ann_code = batch.get('annotation_code')
    if ann_code is not None:
        ann_code = ann_code.to(device)

    return_blunder = blunder_weight > 0
    return_tactical = tactical_weight > 0
    out = model(raw, spell_ids, turn_enc, turn_counts,
                return_blunder=return_blunder,
                return_tactical=return_tactical)
    blunder_logits = None
    tactical_logits = None
    if return_blunder and return_tactical:
        value, logits, blunder_logits, tactical_logits = out
    elif return_blunder:
        value, logits, blunder_logits = out
    elif return_tactical:
        value, logits, tactical_logits = out
    else:
        value, logits = out

    # Value: weighted MSE over all samples.
    v_per = (value.squeeze(-1) - target_outcome) ** 2
    v_loss = (v_per * weights).sum() / weights.sum().clamp(min=1e-6)

    # Policy: weighted cross-entropy on policy-eligible samples only.
    max_t = logits.size(1)
    mask = (torch.arange(max_t, device=device).unsqueeze(0)
            < turn_counts.unsqueeze(1))
    logits_masked = logits.masked_fill(~mask, float('-inf'))
    log_probs = F.log_softmax(logits_masked, dim=1).clamp(min=-30.0)

    # Optional label smoothing: blend target with uniform-over-legal.
    # Reduces overconfidence on the chosen move, which helps generalization
    # when targets are one-hot (human BC) or noisy MCTS visit counts.
    if label_smoothing > 0:
        legal_count = mask.float().sum(dim=1, keepdim=True).clamp(min=1)
        uniform_legal = mask.float() / legal_count
        target_policy = (target_policy * (1 - label_smoothing)
                         + uniform_legal * label_smoothing)

    p_per = -(target_policy * log_probs).sum(dim=1)  # CE per sample
    pol_w = weights * pol_elig
    # Apply human-curated annotation overrides. 'good' moves get policy
    # eligibility (regardless of outcome) with extra positive weight.
    # 'bad' moves get a negative weight, which flips the CE gradient and
    # pushes prob away from the chosen move — high-precision because the
    # signal is human-curated rather than aggregate game outcome.
    if ann_code is not None:
        good_mask = (ann_code > 0).float()
        bad_mask = (ann_code < 0).float()
        pol_w = pol_w * (1 - good_mask - bad_mask) \
                + good_mask * (weights * annotation_good_weight) \
                + bad_mask * (weights * -annotation_bad_weight)
    # Normalize by total absolute weight so the loss magnitude stays
    # comparable to the unannotated case.
    denom = pol_w.abs().sum().clamp(min=1e-6)
    p_loss = (p_per * pol_w).sum() / denom

    # Auxiliary blunder head — BCE over ALL legal turns at annotated
    # positions. The played turn carries the annotation label (1 if 'bad',
    # 0 if 'good'); every other legal turn at the same position is
    # labeled 0. This teaches the head to discriminate "this specific
    # turn is a blunder here" from "this turn is fine here," instead of
    # learning a per-position constant that uniformly offsets all moves.
    # Trunk gradient is detached inside the model (see SigilNet.forward),
    # so this loss only updates the blunder projections.
    b_loss = torch.tensor(0.0, device=device)
    if blunder_logits is not None and ann_code is not None:
        played_idx = target_policy.argmax(dim=1)
        max_t = blunder_logits.size(1)
        ar = torch.arange(max_t, device=device).unsqueeze(0)  # (1, max_t)
        # Per-row target: 1.0 only at played_idx for bad rows; 0.0 elsewhere.
        is_bad = (ann_code < 0).float().unsqueeze(1)          # (B, 1)
        played_one_hot = (ar == played_idx.unsqueeze(1)).float()  # (B, max_t)
        target_b = is_bad * played_one_hot                       # (B, max_t)

        # Loss is averaged only over (annotated row, legal turn) pairs.
        ann_mask_row = (ann_code != 0).float().unsqueeze(1)      # (B, 1)
        legal_mask = (ar < turn_counts.unsqueeze(1)).float()     # (B, max_t)
        loss_mask = ann_mask_row * legal_mask                    # (B, max_t)

        pw = torch.tensor(blunder_pos_weight, device=device)
        bce = F.binary_cross_entropy_with_logits(
            blunder_logits, target_b, reduction='none', pos_weight=pw)
        denom_b = loss_mask.sum().clamp(min=1.0)
        b_loss = (bce * loss_mask).sum() / denom_b

    # Auxiliary tactical head — predicts (best_own_attack, current_own_threat)
    # for the current side to move, both normalized to [0, 1]. Provides a
    # supervised signal aligned with the tactical concepts that would
    # otherwise have to be inferred indirectly through value/policy targets.
    t_loss = torch.tensor(0.0, device=device)
    if tactical_logits is not None:
        # Target a — max over legal turns of the per-turn 'enemy crushed'
        # field (TURN_FEATURE_DIM index 64, already normalized by 3).
        max_t = turn_enc.size(1)
        legal_mask = (
            torch.arange(max_t, device=device).unsqueeze(0)
            < turn_counts.unsqueeze(1)
        ).float()
        crushed_per_turn = turn_enc[:, :, 64] * legal_mask
        target_attack = crushed_per_turn.amax(dim=1)            # (B,)
        # Target b — current count of own-crushable stones, normalized
        # by 3. Located at raw_features index 250 + 2*39 .. 250 + 3*39.
        own_crush = raw[:, 250 + 2 * 39:250 + 3 * 39].sum(dim=1)
        target_threat = (own_crush / 3.0).clamp(max=1.0)
        target_t = torch.stack([target_attack, target_threat], dim=1)
        t_loss = F.mse_loss(tactical_logits, target_t)

    # Value accuracy on val (sign-match), unweighted.
    pred_sign = (value.squeeze(-1) > 0)
    target_sign = (target_outcome > 0)
    v_correct = (pred_sign == target_sign).float().sum()

    return v_loss, p_loss, b_loss, t_loss, v_correct, target_outcome.numel()


def train(args):
    # Load data
    print('Loading data ...')
    records = []
    for path in args.human or []:
        records.extend(load_jsonl(path, 'human',
                                  default_weight=1.0,
                                  min_elo=args.min_elo,
                                  bad_oversample=args.bad_oversample))
    for path in args.self_play or []:
        records.extend(load_jsonl(path, 'selfplay',
                                  default_weight=args.self_play_weight))

    if not records:
        print('No data. Aborting.')
        sys.exit(1)
    print(f'Total records: {len(records)}')

    # Split by game
    train_idx, val_idx = split_by_game(records,
                                       val_fraction=args.val_fraction,
                                       seed=args.seed)
    print(f'Train: {len(train_idx)} positions, Val: {len(val_idx)} positions')

    train_ds = SigilDataset([records[i] for i in train_idx])
    val_ds = SigilDataset([records[i] for i in val_idx])

    train_loader = DataLoader(train_ds, batch_size=args.batch_size,
                              shuffle=True, collate_fn=collate_fn,
                              drop_last=False)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size,
                            shuffle=False, collate_fn=collate_fn)

    # Model
    if args.net == 'hard':
        net_class = SigilNetHard
    elif args.net == 'graph':
        net_class = SigilNetGraph
    else:
        net_class = SigilNet
    if args.model and os.path.exists(args.model):
        model = net_class.load(args.model, device=args.device)
        print(f'Loaded model from {args.model}')
    else:
        model = net_class()
        print(f'Created new {net_class.__name__}')
    model = model.to(args.device)
    print(f'Parameters: {sum(p.numel() for p in model.parameters()):,}')

    # Optional: freeze the policy head so only the value head + trunk update.
    # Useful for fine-tuning value estimation when the policy is already good.
    if args.freeze_policy:
        for name, p in model.named_parameters():
            if 'policy_proj' in name or 'turn_proj' in name:
                p.requires_grad = False
        n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
        print(f'Policy head frozen. Trainable params: {n_train:,}')

    # Optional: freeze EVERYTHING except the blunder head. Use this to
    # bolt the blunder head onto a frozen production checkpoint so
    # playing strength is preserved by construction.
    if args.blunder_only:
        for name, p in model.named_parameters():
            if 'blunder' not in name:
                p.requires_grad = False
        n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
        print(f'Trunk/policy/value frozen. Trainable params: {n_train:,}')

    trainable = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.Adam(trainable, lr=args.lr,
                                 weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=args.epochs, eta_min=args.lr * 0.1)

    best_val = float('inf')
    best_state = copy.deepcopy(model.state_dict())
    bad_epochs = 0

    for epoch in range(args.epochs):
        # Train
        model.train()
        t_v_sum = t_p_sum = t_b_sum = t_t_sum = 0.0
        n_batches = 0
        for batch in train_loader:
            v_loss, p_loss, b_loss, t_loss, _, _ = compute_losses(
                model, batch, args.device,
                label_smoothing=args.label_smoothing,
                annotation_good_weight=args.annotation_good_weight,
                annotation_bad_weight=args.annotation_bad_weight,
                blunder_weight=args.blunder_weight,
                blunder_pos_weight=args.blunder_pos_weight,
                tactical_weight=args.tactical_weight)
            loss = (args.value_weight * v_loss
                    + args.policy_weight * p_loss
                    + args.blunder_weight * b_loss
                    + args.tactical_weight * t_loss)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            t_v_sum += v_loss.item()
            t_p_sum += p_loss.item()
            t_b_sum += b_loss.item()
            t_t_sum += t_loss.item()
            n_batches += 1
        scheduler.step()
        train_v = t_v_sum / max(n_batches, 1)
        train_p = t_p_sum / max(n_batches, 1)
        train_b = t_b_sum / max(n_batches, 1)
        train_t = t_t_sum / max(n_batches, 1)

        # Val
        model.eval()
        v_v_sum = v_p_sum = v_b_sum = v_t_sum = 0.0
        v_correct = v_n = 0
        n_val_batches = 0
        with torch.no_grad():
            for batch in val_loader:
                v_loss, p_loss, b_loss, t_loss, vc, vn = compute_losses(
                    model, batch, args.device,
                    label_smoothing=args.label_smoothing,
                    annotation_good_weight=args.annotation_good_weight,
                    annotation_bad_weight=args.annotation_bad_weight,
                    blunder_weight=args.blunder_weight,
                    blunder_pos_weight=args.blunder_pos_weight,
                    tactical_weight=args.tactical_weight)
                v_v_sum += v_loss.item()
                v_p_sum += p_loss.item()
                v_b_sum += b_loss.item()
                v_t_sum += t_loss.item()
                v_correct += vc.item()
                v_n += vn
                n_val_batches += 1
        val_v = v_v_sum / max(n_val_batches, 1)
        val_p = v_p_sum / max(n_val_batches, 1)
        val_b = v_b_sum / max(n_val_batches, 1)
        val_t = v_t_sum / max(n_val_batches, 1)
        val_loss = (args.value_weight * val_v
                    + args.policy_weight * val_p
                    + args.blunder_weight * val_b
                    + args.tactical_weight * val_t)
        val_acc = v_correct / max(v_n, 1)

        improved = val_loss < best_val - 1e-4
        marker = ' *' if improved else ''
        print(f'Epoch {epoch+1}/{args.epochs}: '
              f'train v={train_v:.4f} p={train_p:.4f} b={train_b:.4f} t={train_t:.4f} | '
              f'val v={val_v:.4f} p={val_p:.4f} b={val_b:.4f} t={val_t:.4f} '
              f'acc={val_acc:.3f} lr={scheduler.get_last_lr()[0]:.6f}{marker}',
              flush=True)

        if improved:
            best_val = val_loss
            best_state = copy.deepcopy(model.state_dict())
            bad_epochs = 0
        else:
            bad_epochs += 1
            if bad_epochs >= args.patience:
                print(f'Early stop after {epoch+1} epochs (patience={args.patience}).')
                break

    # Save the best (lowest-val-loss) model. Write to a tempfile in the
    # same directory and atomic-rename so a kill mid-save can't leave a
    # half-written .pt that downstream `torch.load` would accept silently.
    model.load_state_dict(best_state)
    model.eval()
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    tmp_out = args.output + '.tmp'
    model.save(tmp_out)
    os.replace(tmp_out, args.output)
    print(f'Best val loss: {best_val:.4f}')
    print(f'Saved best model to {args.output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Redesigned SigilNet training')
    parser.add_argument('--human', nargs='*', default=[],
                        help='Human-game JSONL files (with player_elo)')
    parser.add_argument('--self-play', nargs='*', default=[],
                        help='Self-play JSONL files (MCTS targets)')
    parser.add_argument('--model', default=None,
                        help='Starting checkpoint to fine-tune')
    parser.add_argument('--output', required=True,
                        help='Output checkpoint path')
    parser.add_argument('--net', default='medium', choices=['medium', 'hard', 'graph'])
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--patience', type=int, default=4)
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--val-fraction', type=float, default=0.1)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--min-elo', type=int, default=0)
    parser.add_argument('--self-play-weight', type=float, default=0.3)
    parser.add_argument('--label-smoothing', type=float, default=0.0,
                        help='Smoothing factor for policy targets in [0, 1)')
    parser.add_argument('--value-weight', type=float, default=0.5)
    parser.add_argument('--policy-weight', type=float, default=0.5)
    parser.add_argument('--freeze-policy', action='store_true',
                        help='Freeze policy head; only update value head + trunk')
    parser.add_argument('--annotation-good-weight', type=float, default=3.0,
                        help='Per-sample policy weight for human-marked "good" moves')
    parser.add_argument('--annotation-bad-weight', type=float, default=2.0,
                        help='Magnitude of negative policy weight for human-marked "bad" moves')
    parser.add_argument('--bad-oversample', type=int, default=1,
                        help='Replicate annotation=="bad" records this many times in the dataset')
    parser.add_argument('--blunder-weight', type=float, default=0.0,
                        help='Loss weight for the auxiliary blunder head '
                             '(BCE on annotated rows). 0 disables it.')
    parser.add_argument('--blunder-pos-weight', type=float, default=1.0,
                        help='pos_weight passed to BCEWithLogitsLoss for the '
                             'blunder head, to compensate for the heavy '
                             'class imbalance (~1 bad turn per ~25 legal).')
    parser.add_argument('--blunder-only', action='store_true',
                        help='Freeze everything except the blunder head. '
                             'Use to bolt the head onto a frozen checkpoint.')
    parser.add_argument('--tactical-weight', type=float, default=0.0,
                        help='Loss weight for the auxiliary tactical head '
                             '(predicts best_own_attack and current_own_threat). '
                             '0 disables it.')
    parser.add_argument('--device', default='cpu')
    args = parser.parse_args()

    train(args)
