"""SigilNet — dual-head (policy + value) neural network for Sigil.

Architecture:
  Spell IDs (9) → Embedding(15, 16) → flatten(144)
  Raw features (250) → Linear(250, 256) → ReLU
  Concat [144 + 256] = 400 → 6× ResBlock(400) →
    Value head:  Linear(400,128) → ReLU → Linear(128,1) → Tanh
    Policy head: Linear(400,256) · TurnEncoder(64→256) → per-turn logits
"""

import os
import torch
import torch.nn as nn
import torch.nn.functional as F

from ai.config import (
    NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS, SPELL_EMBED_DIM,
    RAW_FEATURE_DIM, TRUNK_DIM, NUM_RES_BLOCKS,
    POLICY_HIDDEN_DIM, VALUE_HIDDEN_DIM, TURN_FEATURE_DIM,
    MODELS_DIR,
)


class ResBlock(nn.Module):
    """Pre-activation residual block with LayerNorm."""

    def __init__(self, dim):
        super().__init__()
        self.fc1 = nn.Linear(dim, dim)
        self.ln1 = nn.LayerNorm(dim)
        self.fc2 = nn.Linear(dim, dim)
        self.ln2 = nn.LayerNorm(dim)

    def forward(self, x):
        residual = x
        out = self.ln1(self.fc1(x))
        out = F.relu(out)
        out = self.ln2(self.fc2(out))
        return F.relu(out + residual)


class SigilNet(nn.Module):
    """Dual-head network: value (win probability) + policy (turn scoring)."""

    def __init__(self):
        super().__init__()

        # Spell embedding: 15 possible spells → 16-dim each, 9 slots
        self.spell_embed = nn.Embedding(NUM_POSSIBLE_SPELLS, SPELL_EMBED_DIM)
        spell_flat_dim = NUM_SPELL_SLOTS * SPELL_EMBED_DIM  # 144

        # Raw feature projection
        self.raw_proj = nn.Linear(RAW_FEATURE_DIM, TRUNK_DIM - spell_flat_dim)  # 256

        # Residual trunk
        self.trunk = nn.Sequential(*[ResBlock(TRUNK_DIM) for _ in range(NUM_RES_BLOCKS)])

        # Value head: board → scalar in [-1, 1]
        self.value_fc1 = nn.Linear(TRUNK_DIM, VALUE_HIDDEN_DIM)
        self.value_fc2 = nn.Linear(VALUE_HIDDEN_DIM, 1)

        # Policy head: board → projection for dot-product with turn features
        self.policy_proj = nn.Linear(TRUNK_DIM, POLICY_HIDDEN_DIM)
        self.turn_proj = nn.Linear(TURN_FEATURE_DIM, POLICY_HIDDEN_DIM)

    def _trunk_forward(self, raw_features, spell_ids):
        """Shared trunk computation.

        Args:
            raw_features: (B, RAW_FEATURE_DIM)
            spell_ids: (B, 9) LongTensor

        Returns: (B, TRUNK_DIM)
        """
        spell_emb = self.spell_embed(spell_ids)       # (B, 9, 16)
        spell_flat = spell_emb.view(spell_emb.size(0), -1)  # (B, 144)
        raw = F.relu(self.raw_proj(raw_features))      # (B, 256)
        x = torch.cat([spell_flat, raw], dim=1)        # (B, 400)
        x = self.trunk(x)                              # (B, 400)
        return x

    def forward(self, raw_features, spell_ids, turn_features=None, turn_counts=None):
        """Forward pass.

        Args:
            raw_features: (B, RAW_FEATURE_DIM)
            spell_ids: (B, 9) LongTensor
            turn_features: optional (B, max_turns, TURN_FEATURE_DIM) — padded turn encodings
            turn_counts: optional (B,) LongTensor — number of valid turns per sample

        Returns:
            value: (B, 1) in [-1, 1]
            policy_logits: (B, max_turns) or None if turn_features not provided
        """
        x = self._trunk_forward(raw_features, spell_ids)

        # Value head
        v = F.relu(self.value_fc1(x))
        v = torch.tanh(self.value_fc2(v))  # (B, 1)

        # Policy head
        policy_logits = None
        if turn_features is not None:
            board_proj = self.policy_proj(x)              # (B, 256)
            turn_proj = self.turn_proj(turn_features)     # (B, max_turns, 256)
            # Dot product: (B, max_turns, 256) @ (B, 256, 1) -> (B, max_turns)
            logits = torch.bmm(turn_proj, board_proj.unsqueeze(-1)).squeeze(-1)

            # Mask invalid turns (beyond turn_counts) with -inf
            if turn_counts is not None:
                max_t = turn_features.size(1)
                mask = torch.arange(max_t, device=logits.device).unsqueeze(0) >= turn_counts.unsqueeze(1)
                logits = logits.masked_fill(mask, float('-inf'))

            policy_logits = logits

        return v, policy_logits

    def evaluate(self, raw_features, spell_ids):
        """Value-only evaluation (no policy). For use in search.

        Args:
            raw_features: (RAW_FEATURE_DIM,) or (B, RAW_FEATURE_DIM)
            spell_ids: (9,) or (B, 9) LongTensor

        Returns: value float or (B,) tensor
        """
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
        """Full evaluation: value + policy priors for MCTS.

        Args:
            raw_features: (RAW_FEATURE_DIM,) single position
            spell_ids: (9,) single position
            turn_features: (N, TURN_FEATURE_DIM) all legal turns

        Returns: (value: float, policy: np.array of shape (N,))
        """
        raw_features = raw_features.unsqueeze(0)      # (1, 250)
        spell_ids = spell_ids.unsqueeze(0)             # (1, 9)
        turn_features = turn_features.unsqueeze(0)     # (1, N, 64)
        turn_counts = torch.tensor([turn_features.size(1)], dtype=torch.long)

        with torch.no_grad():
            v, logits = self.forward(raw_features, spell_ids, turn_features, turn_counts)

        value = v.item()
        policy = F.softmax(logits.squeeze(0), dim=0).cpu().numpy()
        return value, policy

    def save(self, path):
        """Save model checkpoint."""
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
        torch.save({
            'model_state_dict': self.state_dict(),
        }, path)

    @classmethod
    def load(cls, path, device='cpu'):
        """Load model from checkpoint."""
        net = cls()
        checkpoint = torch.load(path, map_location=device, weights_only=True)
        net.load_state_dict(checkpoint['model_state_dict'])
        net.eval()
        return net

    @classmethod
    def load_or_create(cls, path=None, device='cpu'):
        """Load from path if it exists, otherwise create new."""
        if path is None:
            path = os.path.join(MODELS_DIR, 'best_model.pt')
        if os.path.exists(path):
            return cls.load(path, device)
        return cls()
