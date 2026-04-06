"""Training loop for SigilNet.

Combined value + policy loss, following AlphaZero's approach.

Usage:
    python -m ai.train_sigil --data ai/data/selfplay_001.jsonl --epochs 10
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.features import board_to_tensor
from ai.config import (
    BATCH_SIZE, LR_INIT, LR_FINAL, WEIGHT_DECAY,
    POLICY_LOSS_WEIGHT, TRAINING_EPOCHS, DATA_WINDOW,
    MODELS_DIR, RAW_FEATURE_DIM, TURN_FEATURE_DIM,
)
from notation import sfn_to_dict, NODE_ORDER, POSITIONS
from simboard import SimBoard, MANA_NODES


class SigilDataset(Dataset):
    """Dataset of (raw_features, spell_ids, turn_encodings, policy, outcome)."""

    def __init__(self, records):
        self.records = records

    def __len__(self):
        return len(self.records)

    def __getitem__(self, idx):
        r = self.records[idx]
        return {
            'raw_features': torch.tensor(r['raw_features'], dtype=torch.float32),
            'spell_ids': torch.tensor(r['spell_ids'], dtype=torch.long),
            'turn_encodings': torch.tensor(r['turn_encodings'], dtype=torch.float32),
            'policy': torch.tensor(r['policy'], dtype=torch.float32),
            'outcome': torch.tensor(r['outcome'], dtype=torch.float32),
            'num_turns': r['num_turns'],
        }


def collate_fn(batch):
    """Custom collation to handle variable-length turn encodings."""
    raw_features = torch.stack([b['raw_features'] for b in batch])
    spell_ids = torch.stack([b['spell_ids'] for b in batch])
    outcomes = torch.stack([b['outcome'] for b in batch])

    # Pad turn encodings to max length in batch
    max_turns = max(b['num_turns'] for b in batch)
    B = len(batch)
    turn_encodings = torch.zeros(B, max_turns, TURN_FEATURE_DIM)
    policies = torch.zeros(B, max_turns)
    turn_counts = torch.zeros(B, dtype=torch.long)

    for i, b in enumerate(batch):
        n = b['num_turns']
        turn_encodings[i, :n] = b['turn_encodings'][:n]
        policies[i, :n] = b['policy'][:n]
        turn_counts[i] = n

    return {
        'raw_features': raw_features,
        'spell_ids': spell_ids,
        'turn_encodings': turn_encodings,
        'policies': policies,
        'turn_counts': turn_counts,
        'outcomes': outcomes,
    }


def load_training_data(data_paths, max_records=None):
    """Load training data from JSONL files.

    Each line has: sfn, spell_ids, policy, turn_encodings, outcome
    """
    if isinstance(data_paths, str):
        data_paths = [data_paths]

    records = []
    for path in data_paths:
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                d = json.loads(line)

                # Convert SFN to features if raw_features not cached
                if 'raw_features' not in d:
                    sfn = d['sfn']
                    parsed = sfn_to_dict(sfn)
                    side = parsed['turn']
                    # Reconstruct a minimal SimBoard for feature extraction
                    sb = SimBoard.from_sfn(sfn)
                    from ai.features import board_to_tensor as _b2t
                    raw, spell_ids = _b2t(sb, side)
                    d['raw_features'] = raw.numpy().tolist()
                    d['spell_ids'] = spell_ids.numpy().tolist()

                turn_encs = d.get('turn_encodings', [])
                policy = d.get('policy', [])
                n_turns = len(policy)

                if n_turns == 0:
                    continue

                records.append({
                    'raw_features': d['raw_features'],
                    'spell_ids': d['spell_ids'],
                    'turn_encodings': turn_encs,
                    'policy': policy,
                    'outcome': d['outcome'],
                    'num_turns': n_turns,
                })

                if max_records and len(records) >= max_records:
                    break
        if max_records and len(records) >= max_records:
            break

    print(f"Loaded {len(records)} training positions")
    return records


def train(model, records, epochs=None, batch_size=None, lr=None,
          device='cpu', val_fraction=0.1):
    """Train SigilNet on self-play data.

    Returns: (trained_model, train_losses, val_losses)
    """
    if epochs is None:
        epochs = TRAINING_EPOCHS
    if batch_size is None:
        batch_size = BATCH_SIZE
    if lr is None:
        lr = LR_INIT

    # Split train/val
    n = len(records)
    val_size = min(max(1, int(n * val_fraction)), n - 1)
    indices = np.random.permutation(n)
    val_indices = indices[:val_size]
    train_indices = indices[val_size:]

    train_data = SigilDataset([records[i] for i in train_indices])
    val_data = SigilDataset([records[i] for i in val_indices])

    effective_batch = min(batch_size, max(1, len(train_data)))
    train_loader = DataLoader(train_data, batch_size=effective_batch, shuffle=True,
                              collate_fn=collate_fn, drop_last=False)
    val_loader = DataLoader(val_data, batch_size=batch_size, shuffle=False,
                            collate_fn=collate_fn)

    model = model.to(device)
    model.train()

    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs,
                                                            eta_min=LR_FINAL)

    train_losses = []
    val_losses = []

    for epoch in range(epochs):
        model.train()
        epoch_loss = 0.0
        epoch_v_loss = 0.0
        epoch_p_loss = 0.0
        n_batches = 0

        for batch in train_loader:
            raw = batch['raw_features'].to(device)
            spell_ids = batch['spell_ids'].to(device)
            turn_enc = batch['turn_encodings'].to(device)
            target_policy = batch['policies'].to(device)
            turn_counts = batch['turn_counts'].to(device)
            target_outcome = batch['outcomes'].to(device)

            value, logits = model(raw, spell_ids, turn_enc, turn_counts)

            # Value loss: MSE
            v_loss = F.mse_loss(value.squeeze(-1), target_outcome)

            # Policy loss: cross-entropy between predicted and target policy
            # Mask invalid turns
            max_t = logits.size(1)
            mask = torch.arange(max_t, device=device).unsqueeze(0) < turn_counts.unsqueeze(1)

            # Log-softmax over valid turns only
            logits_masked = logits.masked_fill(~mask, float('-inf'))
            log_probs = F.log_softmax(logits_masked + 1e-8, dim=1)
            # Clamp log_probs to avoid NaN from -inf * 0
            log_probs = log_probs.clamp(min=-30.0)
            # For winner positions: lightly penalize unchosen legal moves
            # by setting their target to -0.03 (pushes probability down).
            # target_policy is 1.0 for chosen, 0.0 for others.
            adjusted_policy = target_policy.clone()
            is_winner = (target_outcome > 0).unsqueeze(1)  # (B, 1)
            unchosen_legal = mask & (target_policy == 0)    # legal but not chosen
            adjusted_policy[is_winner.expand_as(adjusted_policy) & unchosen_legal] = -0.01

            # Per-sample cross-entropy (with adjusted targets)
            p_loss_per_sample = -(adjusted_policy * log_probs).sum(dim=1)

            # Outcome-weighted policy: positive reinforcement for winner,
            # negative reinforcement for loser.
            # Winner (outcome=+1): minimize cross-entropy (imitate move),
            #   plus small penalty on unchosen moves.
            # Loser (outcome=-1): maximize cross-entropy (avoid move).
            # Draw (outcome=0): no policy gradient.
            # Scale loser weight by 0.5 to keep training stable.
            policy_weight = torch.where(
                target_outcome > 0, torch.ones_like(target_outcome),
                torch.where(target_outcome < 0,
                            -0.5 * torch.ones_like(target_outcome),
                            torch.zeros_like(target_outcome)))
            denom = policy_weight.abs().sum()
            if denom > 0:
                p_loss = (p_loss_per_sample * policy_weight).sum() / denom
            else:
                p_loss = p_loss_per_sample.mean()

            loss = (1 - POLICY_LOSS_WEIGHT) * v_loss + POLICY_LOSS_WEIGHT * p_loss

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

            epoch_loss += loss.item()
            epoch_v_loss += v_loss.item()
            epoch_p_loss += p_loss.item()
            n_batches += 1

        scheduler.step()

        avg_loss = epoch_loss / max(n_batches, 1)
        avg_v = epoch_v_loss / max(n_batches, 1)
        avg_p = epoch_p_loss / max(n_batches, 1)
        train_losses.append(avg_loss)

        # Validation
        model.eval()
        val_loss = 0.0
        val_v_acc = 0.0
        val_n = 0

        with torch.no_grad():
            for batch in val_loader:
                raw = batch['raw_features'].to(device)
                spell_ids = batch['spell_ids'].to(device)
                turn_enc = batch['turn_encodings'].to(device)
                target_policy = batch['policies'].to(device)
                turn_counts = batch['turn_counts'].to(device)
                target_outcome = batch['outcomes'].to(device)

                value, logits = model(raw, spell_ids, turn_enc, turn_counts)
                v_loss = F.mse_loss(value.squeeze(-1), target_outcome)

                max_t = logits.size(1)
                mask = torch.arange(max_t, device=device).unsqueeze(0) < turn_counts.unsqueeze(1)
                logits_masked = logits.masked_fill(~mask, float('-inf'))
                log_probs = F.log_softmax(logits_masked + 1e-8, dim=1).clamp(min=-30.0)
                adjusted_policy = target_policy.clone()
                is_winner = (target_outcome > 0).unsqueeze(1)
                unchosen_legal = mask & (target_policy == 0)
                adjusted_policy[is_winner.expand_as(adjusted_policy) & unchosen_legal] = -0.01
                p_loss_per_sample = -(adjusted_policy * log_probs).sum(dim=1)
                policy_weight = torch.where(
                    target_outcome > 0, torch.ones_like(target_outcome),
                    torch.where(target_outcome < 0,
                                -0.5 * torch.ones_like(target_outcome),
                                torch.zeros_like(target_outcome)))
                denom = policy_weight.abs().sum()
                if denom > 0:
                    p_loss = (p_loss_per_sample * policy_weight).sum() / denom
                else:
                    p_loss = p_loss_per_sample.mean()

                loss = (1 - POLICY_LOSS_WEIGHT) * v_loss + POLICY_LOSS_WEIGHT * p_loss
                val_loss += loss.item()

                # Value accuracy: did we predict the right sign?
                pred_sign = (value.squeeze(-1) > 0).float()
                target_sign = (target_outcome > 0).float()
                val_v_acc += (pred_sign == target_sign).float().sum().item()
                val_n += len(target_outcome)

        avg_val = val_loss / max(len(val_loader), 1)
        val_acc = val_v_acc / max(val_n, 1)
        val_losses.append(avg_val)

        print(f"Epoch {epoch+1}/{epochs}: "
              f"loss={avg_loss:.4f} (v={avg_v:.4f}, p={avg_p:.4f}) "
              f"val={avg_val:.4f} val_acc={val_acc:.3f} "
              f"lr={scheduler.get_last_lr()[0]:.6f}",
              flush=True)

    model.eval()
    return model, train_losses, val_losses


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train SigilNet')
    parser.add_argument('--data', type=str, nargs='+', required=True,
                        help='Path(s) to JSONL training data')
    parser.add_argument('--model', type=str, default=None,
                        help='Path to existing model to continue training')
    parser.add_argument('--output', type=str, default=None,
                        help='Path to save trained model')
    parser.add_argument('--epochs', type=int, default=TRAINING_EPOCHS)
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE)
    parser.add_argument('--lr', type=float, default=LR_INIT)
    parser.add_argument('--max-records', type=int, default=DATA_WINDOW)
    parser.add_argument('--device', type=str, default='cpu')
    parser.add_argument('--net', type=str, default='medium',
                        choices=['medium', 'hard'],
                        help='Network architecture: medium (2M) or hard (44M)')
    args = parser.parse_args()

    # Select network class
    net_class = SigilNetHard if args.net == 'hard' else SigilNet

    # Load or create model
    if args.model and os.path.exists(args.model):
        model = net_class.load(args.model, device=args.device)
        print(f"Loaded model from {args.model}")
    else:
        model = net_class()
        print(f"Created new {net_class.__name__}")

    print(f"Parameters: {sum(p.numel() for p in model.parameters()):,}")

    # Load data
    records = load_training_data(args.data, max_records=args.max_records)

    # Train
    model, train_losses, val_losses = train(
        model, records, epochs=args.epochs,
        batch_size=args.batch_size, lr=args.lr,
        device=args.device,
    )

    # Save
    if args.output is None:
        os.makedirs(MODELS_DIR, exist_ok=True)
        args.output = os.path.join(MODELS_DIR, 'best_model.pt')
    model.save(args.output)
    print(f"Model saved to {args.output}")
