"""SigilNetHard — 40M-parameter shallow+wide network for hard difficulty.

Architecture inspired by Stockfish NNUE SFNNv10: wide input transformation
with few hidden layers instead of deep residual blocks.

  Spell IDs (9) → Embedding(15, 32) → flatten(288)
  Raw features (250) → Linear(250, 3808) → ClippedReLU
  Concat [288 + 3808] = 4096 →
    Linear(4096, 4096) → LN → ClippedReLU →
    Linear(4096, 4096) → LN → ClippedReLU →
    Linear(4096, 2048) → LN → ClippedReLU →
      Value head:  Linear(2048, 256) → ReLU → Linear(256, 1) → Tanh
      Policy head: Linear(2048, 256) · TurnEncoder(64→256) → per-turn logits

Total: ~44M parameters
"""

import os
import torch
import torch.nn as nn
import torch.nn.functional as F

from ai.config import (
    NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS,
    RAW_FEATURE_DIM, TURN_FEATURE_DIM, MODELS_DIR,
    HARD_SPELL_EMBED_DIM, HARD_WIDE_DIM, HARD_SQUEEZE_DIM,
    HARD_POLICY_DIM, HARD_VALUE_DIM,
)


def _clipped_relu(x, cap=1.0):
    """ClippedReLU as used in NNUE: clamp(relu(x), 0, cap)."""
    return torch.clamp(F.relu(x), max=cap)


class SigilNetHard(nn.Module):
    """Shallow+wide dual-head network: value + policy.

    NNUE-style: one wide input transform, three wide hidden layers,
    then narrow value/policy heads.
    """

    def __init__(self):
        super().__init__()

        # Spell embedding: wider than the 2M model
        self.spell_embed = nn.Embedding(NUM_POSSIBLE_SPELLS, HARD_SPELL_EMBED_DIM)
        spell_flat_dim = NUM_SPELL_SLOTS * HARD_SPELL_EMBED_DIM  # 288

        # Raw feature projection to fill the rest of WIDE_DIM
        self.raw_proj = nn.Linear(RAW_FEATURE_DIM, HARD_WIDE_DIM - spell_flat_dim)

        # Wide hidden layers (shallow depth, high width)
        self.wide1 = nn.Linear(HARD_WIDE_DIM, HARD_WIDE_DIM)
        self.ln1 = nn.LayerNorm(HARD_WIDE_DIM)

        self.wide2 = nn.Linear(HARD_WIDE_DIM, HARD_WIDE_DIM)
        self.ln2 = nn.LayerNorm(HARD_WIDE_DIM)

        self.wide3 = nn.Linear(HARD_WIDE_DIM, HARD_SQUEEZE_DIM)
        self.ln3 = nn.LayerNorm(HARD_SQUEEZE_DIM)

        # Value head
        self.value_fc1 = nn.Linear(HARD_SQUEEZE_DIM, HARD_VALUE_DIM)
        self.value_fc2 = nn.Linear(HARD_VALUE_DIM, 1)

        # Policy head: dot-product between board projection and turn encoding
        self.policy_proj = nn.Linear(HARD_SQUEEZE_DIM, HARD_POLICY_DIM)
        self.turn_proj = nn.Linear(TURN_FEATURE_DIM, HARD_POLICY_DIM)

    def _trunk_forward(self, raw_features, spell_ids):
        """Shared trunk: wide input transform → 3 wide layers → squeeze.

        Args:
            raw_features: (B, RAW_FEATURE_DIM)
            spell_ids: (B, 9) LongTensor

        Returns: (B, HARD_SQUEEZE_DIM)
        """
        spell_emb = self.spell_embed(spell_ids)                    # (B, 9, 32)
        spell_flat = spell_emb.view(spell_emb.size(0), -1)         # (B, 288)
        raw = _clipped_relu(self.raw_proj(raw_features))            # (B, 3808)
        x = torch.cat([spell_flat, raw], dim=1)                     # (B, 4096)

        x = _clipped_relu(self.ln1(self.wide1(x)))                  # (B, 4096)
        x = _clipped_relu(self.ln2(self.wide2(x)))                  # (B, 4096)
        x = _clipped_relu(self.ln3(self.wide3(x)))                  # (B, 2048)
        return x

    def forward(self, raw_features, spell_ids, turn_features=None, turn_counts=None):
        """Forward pass — same interface as SigilNet for drop-in use.

        Args:
            raw_features: (B, RAW_FEATURE_DIM)
            spell_ids: (B, 9) LongTensor
            turn_features: optional (B, max_turns, TURN_FEATURE_DIM)
            turn_counts: optional (B,) LongTensor

        Returns:
            value: (B, 1) in [-1, 1]
            policy_logits: (B, max_turns) or None
        """
        x = self._trunk_forward(raw_features, spell_ids)

        # Value head
        v = F.relu(self.value_fc1(x))
        v = torch.tanh(self.value_fc2(v))

        # Policy head
        policy_logits = None
        if turn_features is not None:
            board_proj = self.policy_proj(x)                         # (B, 256)
            turn_proj = self.turn_proj(turn_features)                # (B, T, 256)
            logits = torch.bmm(turn_proj, board_proj.unsqueeze(-1)).squeeze(-1)

            if turn_counts is not None:
                max_t = turn_features.size(1)
                mask = torch.arange(max_t, device=logits.device).unsqueeze(0) >= turn_counts.unsqueeze(1)
                logits = logits.masked_fill(mask, float('-inf'))

            policy_logits = logits

        return v, policy_logits

    def evaluate(self, raw_features, spell_ids):
        """Value-only evaluation (no policy). For use in search."""
        single = raw_features.dim() == 1
        if single:
            raw_features = raw_features.unsqueeze(0)
            spell_ids = spell_ids.unsqueeze(0)

        with torch.no_grad():
            v, _ = self.forward(raw_features, spell_ids)

        if single:
            return v.item()
        return v.squeeze(-1)

    def evaluate_with_policy(self, raw_features, spell_ids, turn_features):
        """Full evaluation: value + policy priors for MCTS."""
        raw_features = raw_features.unsqueeze(0)
        spell_ids = spell_ids.unsqueeze(0)
        turn_features = turn_features.unsqueeze(0)
        turn_counts = torch.tensor([turn_features.size(1)], dtype=torch.long)

        with torch.no_grad():
            v, logits = self.forward(raw_features, spell_ids, turn_features, turn_counts)

        value = v.item()
        policy = F.softmax(logits.squeeze(0), dim=0).cpu().numpy()
        return value, policy

    def save(self, path, half=False):
        """Save model checkpoint. Use half=True for smaller files (~88MB vs 176MB)."""
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
        sd = self.state_dict()
        if half:
            sd = {k: v.half() for k, v in sd.items()}
        torch.save({
            'model_state_dict': sd,
            'arch': 'SigilNetHard',
            'storage': 'float16' if half else 'float32',
        }, path)

    @classmethod
    def load(cls, path, device='cpu'):
        """Load model from checkpoint. Auto-casts float16 weights to float32."""
        net = cls()
        checkpoint = torch.load(path, map_location=device, weights_only=True)
        sd = checkpoint['model_state_dict']
        if checkpoint.get('storage') == 'float16':
            sd = {k: v.float() for k, v in sd.items()}
        net.load_state_dict(sd)
        net.eval()
        return net

    @classmethod
    def load_or_create(cls, path=None, device='cpu'):
        """Load from path if it exists, otherwise create new."""
        if path is None:
            path = os.path.join(MODELS_DIR, 'best_model_hard.pt')
        if os.path.exists(path):
            return cls.load(path, device)
        return cls()
