"""Export a PyTorch SigilNet model to NumPy JSON for CPU-only deployment.

The exported model can run inference without PyTorch installed,
using only NumPy for matrix operations.

Usage:
    python -m ai.export_numpy --model ai/models/best_model.pt --output ai/models/best_model_numpy.json
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from ai.sigil_net import SigilNet
from ai.config import (
    MODELS_DIR, NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS, SPELL_EMBED_DIM,
    RAW_FEATURE_DIM, TRUNK_DIM, NUM_RES_BLOCKS,
    POLICY_HIDDEN_DIM, VALUE_HIDDEN_DIM, TURN_FEATURE_DIM,
)


def export_to_numpy(model_path, output_path):
    """Export PyTorch SigilNet to NumPy-compatible JSON."""
    model = SigilNet.load(model_path)
    model.eval()

    state = model.state_dict()
    exported = {
        'config': {
            'num_possible_spells': NUM_POSSIBLE_SPELLS,
            'num_spell_slots': NUM_SPELL_SLOTS,
            'spell_embed_dim': SPELL_EMBED_DIM,
            'raw_feature_dim': RAW_FEATURE_DIM,
            'trunk_dim': TRUNK_DIM,
            'num_res_blocks': NUM_RES_BLOCKS,
            'policy_hidden_dim': POLICY_HIDDEN_DIM,
            'value_hidden_dim': VALUE_HIDDEN_DIM,
            'turn_feature_dim': TURN_FEATURE_DIM,
        },
        'weights': {},
    }

    for key, tensor in state.items():
        exported['weights'][key] = tensor.cpu().numpy().tolist()

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.',
                exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(exported, f)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"Exported to {output_path} ({size_mb:.1f} MB)")
    print(f"Weights: {len(exported['weights'])} tensors")


class SigilNetNumPy:
    """Pure NumPy inference for SigilNet (no PyTorch required).

    Mirrors the PyTorch SigilNet architecture for CPU-only deployment.
    """

    def __init__(self, data):
        self.config = data['config']
        self.w = {}
        for key, val in data['weights'].items():
            self.w[key] = np.array(val, dtype=np.float32)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            data = json.load(f)
        return cls(data)

    def _layer_norm(self, x, weight_key, bias_key):
        """Apply layer normalization."""
        w = self.w[weight_key]
        b = self.w[bias_key]
        mean = x.mean(axis=-1, keepdims=True)
        var = x.var(axis=-1, keepdims=True)
        return w * (x - mean) / np.sqrt(var + 1e-5) + b

    def _res_block(self, x, block_idx):
        """Apply one residual block."""
        prefix = f'trunk.{block_idx}'
        residual = x

        out = x @ self.w[f'{prefix}.fc1.weight'].T + self.w[f'{prefix}.fc1.bias']
        out = self._layer_norm(out, f'{prefix}.ln1.weight', f'{prefix}.ln1.bias')
        out = np.maximum(out, 0)  # ReLU

        out = out @ self.w[f'{prefix}.fc2.weight'].T + self.w[f'{prefix}.fc2.bias']
        out = self._layer_norm(out, f'{prefix}.ln2.weight', f'{prefix}.ln2.bias')

        return np.maximum(out + residual, 0)  # ReLU

    def forward(self, raw_features, spell_ids, turn_features=None):
        """Forward pass using NumPy.

        Args:
            raw_features: (250,) or (B, 250)
            spell_ids: (9,) or (B, 9) integer array
            turn_features: optional (N, 64) for single sample

        Returns: (value, policy_logits or None)
        """
        single = raw_features.ndim == 1
        if single:
            raw_features = raw_features.reshape(1, -1)
            spell_ids = spell_ids.reshape(1, -1)

        B = raw_features.shape[0]

        # Spell embedding lookup
        embed_table = self.w['spell_embed.weight']  # (15, 16)
        spell_emb = embed_table[spell_ids]           # (B, 9, 16)
        spell_flat = spell_emb.reshape(B, -1)        # (B, 144)

        # Raw projection
        raw = raw_features @ self.w['raw_proj.weight'].T + self.w['raw_proj.bias']
        raw = np.maximum(raw, 0)  # ReLU

        # Concat
        x = np.concatenate([spell_flat, raw], axis=1)  # (B, 400)

        # Trunk (residual blocks)
        n_blocks = self.config['num_res_blocks']
        for i in range(n_blocks):
            x = self._res_block(x, i)

        # Value head
        v = x @ self.w['value_fc1.weight'].T + self.w['value_fc1.bias']
        v = np.maximum(v, 0)
        v = v @ self.w['value_fc2.weight'].T + self.w['value_fc2.bias']
        v = np.tanh(v)  # (B, 1)

        # Policy head
        policy_logits = None
        if turn_features is not None and single:
            board_proj = x @ self.w['policy_proj.weight'].T + self.w['policy_proj.bias']  # (1, 256)
            turn_proj = turn_features @ self.w['turn_proj.weight'].T + self.w['turn_proj.bias']  # (N, 256)
            logits = turn_proj @ board_proj.T  # (N, 1)
            policy_logits = logits.squeeze(-1)  # (N,)

        if single:
            return float(v[0, 0]), policy_logits
        return v.squeeze(-1), policy_logits

    def evaluate_with_policy(self, raw_features, spell_ids, turn_features):
        """Match SigilNet.evaluate_with_policy interface for MCTS compatibility."""
        if hasattr(raw_features, 'numpy'):
            raw_features = raw_features.numpy()
        if hasattr(spell_ids, 'numpy'):
            spell_ids = spell_ids.numpy()
        if hasattr(turn_features, 'numpy'):
            turn_features = turn_features.numpy()

        value, logits = self.forward(raw_features, spell_ids, turn_features)

        if logits is not None:
            # Softmax
            exp_logits = np.exp(logits - logits.max())
            policy = exp_logits / exp_logits.sum()
        else:
            policy = np.array([1.0])

        return value, policy

    def evaluate(self, raw_features, spell_ids):
        """Value-only evaluation."""
        if hasattr(raw_features, 'numpy'):
            raw_features = raw_features.numpy()
        if hasattr(spell_ids, 'numpy'):
            spell_ids = spell_ids.numpy()
        value, _ = self.forward(raw_features, spell_ids)
        return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Export SigilNet to NumPy JSON')
    parser.add_argument('--model', type=str,
                        default=os.path.join(MODELS_DIR, 'best_model.pt'))
    parser.add_argument('--output', type=str,
                        default=os.path.join(MODELS_DIR, 'best_model_numpy.json'))
    args = parser.parse_args()

    export_to_numpy(args.model, args.output)

    # Verify
    print("\nVerifying NumPy export...")
    np_model = SigilNetNumPy.load(args.output)
    test_raw = np.random.randn(RAW_FEATURE_DIM).astype(np.float32)
    test_ids = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8])
    test_turns = np.random.randn(3, TURN_FEATURE_DIM).astype(np.float32)

    value, policy = np_model.evaluate_with_policy(test_raw, test_ids, test_turns)
    print(f"Value: {value:.4f}, Policy: {policy}")
    print("Export verified!")
