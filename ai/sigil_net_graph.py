"""SigilNet with a graph-convolutional trunk over the 39-node board.

The board is a sparse, fixed graph (39 nodes, max degree 4). A flat MLP
trunk has to learn this topology from scratch; here we wire it in
directly using a precomputed normalized adjacency matrix and a stack of
GCN-style message-passing layers. The graph-derived board summary is
then concatenated with the existing global features (spell embeddings,
tempo, threat, etc.) before passing through dense ResBlocks and the
value / policy / blunder heads.

Per-node features are extracted by slicing the 450-dim flat raw vector
that ai/features.py:board_to_tensor produces, so the data format is
unchanged. Adding a new model class (rather than mutating SigilNet)
keeps v22 loadable and gives us a clean A/B baseline.
"""

import os
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from notation import NODE_ORDER, ADJACENCY, POSITIONS

from ai.config import (
    NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS, SPELL_EMBED_DIM, NUM_NODES,
    RAW_FEATURE_DIM, TURN_FEATURE_DIM, POLICY_HIDDEN_DIM, VALUE_HIDDEN_DIM,
    MODELS_DIR,
)
from ai.sigil_net import BLUNDER_HIDDEN_DIM


# Slice indices into the 450-dim raw vector. Must match
# ai/features.py:board_to_tensor layout.
_STONES_START = 0
_STONES_LEN = NUM_NODES * 3                 # 117
_NBHD_START = _STONES_START + _STONES_LEN
_NBHD_LEN = NUM_NODES * 2                   # 78
_GLOBAL_BLOCK_END = _NBHD_START + _NBHD_LEN + 27 + 3 + 2 + 18 + 1 + 2 + 2  # = 250
_LIFE_START = _GLOBAL_BLOCK_END             # 250
_LIFE_LEN = NUM_NODES * 4                   # 156
_SPELL_FILL_START = _LIFE_START + _LIFE_LEN  # 406
_SPELL_FILL_LEN = 18
_THREAT_START = _SPELL_FILL_START + _SPELL_FILL_LEN  # 424
_THREAT_LEN = 18
_TEMPO_START = _THREAT_START + _THREAT_LEN  # 442
_TEMPO_LEN = 8

# Static per-node indicator features (constants — the same for every position).
_IS_MANA = np.zeros(NUM_NODES, dtype=np.float32)
_IS_SPELL_POS = np.zeros(NUM_NODES, dtype=np.float32)
_IDX = {n: i for i, n in enumerate(NODE_ORDER)}
for n in ('a1', 'b1', 'c1'):
    _IS_MANA[_IDX[n]] = 1.0
for slot in range(1, NUM_SPELL_SLOTS + 1):
    for n in POSITIONS.get(slot, []):
        _IS_SPELL_POS[_IDX[n]] = 1.0

# Channels assembled per-node: 3 stones + 2 nbhd + 4 life + 2 indicators = 11
NODE_FEATURE_DIM = 11

# Non-spatial features (everything in the raw vector except stones, nbhd, life):
# spell_charges(27) + mana(3) + counters(2) + lock(18) + diff(1) + counts(2)
# + turn(2) + fill(18) + threat(18) + tempo(8) = 99.
GLOBAL_FEATURE_DIM = (
    RAW_FEATURE_DIM - _STONES_LEN - _NBHD_LEN - _LIFE_LEN
)  # 450 - 117 - 78 - 156 = 99


def _build_normalized_adjacency():
    """Return (NUM_NODES, NUM_NODES) tensor: D^{-1/2} (A + I) D^{-1/2}."""
    A = np.zeros((NUM_NODES, NUM_NODES), dtype=np.float32)
    for n in NODE_ORDER:
        i = _IDX[n]
        A[i, i] = 1.0  # self-loop
        for nb in ADJACENCY.get(n, []):
            A[i, _IDX[nb]] = 1.0
    deg = A.sum(axis=1)
    d_inv_sqrt = np.where(deg > 0, 1.0 / np.sqrt(deg), 0.0)
    A_norm = (A * d_inv_sqrt).T * d_inv_sqrt    # D^-1/2 A D^-1/2
    return torch.tensor(A_norm, dtype=torch.float32)


class GraphConv(nn.Module):
    """Single GCN-style message-passing layer with LayerNorm + ReLU."""

    def __init__(self, in_dim, out_dim):
        super().__init__()
        self.lin = nn.Linear(in_dim, out_dim)
        self.ln = nn.LayerNorm(out_dim)

    def forward(self, x, A_norm):
        # x: (B, N, in_dim);  A_norm: (N, N)
        h = torch.einsum('ij,bjc->bic', A_norm, x)
        h = self.lin(h)
        h = self.ln(h)
        return F.relu(h)


class GraphResBlock(nn.Module):
    """Residual block: two GraphConv layers, summed with the input."""

    def __init__(self, dim):
        super().__init__()
        self.g1 = GraphConv(dim, dim)
        self.g2 = GraphConv(dim, dim)

    def forward(self, x, A_norm):
        h = self.g1(x, A_norm)
        h = self.g2(h, A_norm)
        return F.relu(h + x)


class SigilNetGraph(nn.Module):
    """SigilNet with a graph-conv trunk and the same heads as SigilNet."""

    GRAPH_HIDDEN_DIM = 128
    NUM_GRAPH_BLOCKS = 4   # one initial proj + this many residual blocks
    DENSE_TRUNK_DIM = 512
    NUM_DENSE_RES_BLOCKS = 3

    def __init__(self):
        super().__init__()

        # Static, non-trainable adjacency.
        self.register_buffer('A_norm', _build_normalized_adjacency())
        # Static node-type indicator broadcast per batch element.
        node_static = np.stack([_IS_MANA, _IS_SPELL_POS], axis=1)  # (39, 2)
        self.register_buffer(
            'node_static', torch.tensor(node_static, dtype=torch.float32))

        # Graph trunk.
        self.node_proj = GraphConv(NODE_FEATURE_DIM, self.GRAPH_HIDDEN_DIM)
        self.graph_blocks = nn.ModuleList([
            GraphResBlock(self.GRAPH_HIDDEN_DIM)
            for _ in range(self.NUM_GRAPH_BLOCKS)
        ])

        # Spell embedding (same as SigilNet).
        self.spell_embed = nn.Embedding(NUM_POSSIBLE_SPELLS, SPELL_EMBED_DIM)

        # Dense trunk consumes [pooled_graph (mean+max) | spell_emb_flat | globals].
        spell_flat_dim = NUM_SPELL_SLOTS * SPELL_EMBED_DIM            # 144
        pooled_dim = self.GRAPH_HIDDEN_DIM * 2                        # 192
        dense_in = pooled_dim + spell_flat_dim + GLOBAL_FEATURE_DIM   # 192+144+99=435
        self.dense_in = nn.Linear(dense_in, self.DENSE_TRUNK_DIM)
        self.dense_in_ln = nn.LayerNorm(self.DENSE_TRUNK_DIM)
        self.dense_blocks = nn.ModuleList([
            _DenseResBlock(self.DENSE_TRUNK_DIM)
            for _ in range(self.NUM_DENSE_RES_BLOCKS)
        ])

        # Heads (mirror SigilNet).
        self.value_fc1 = nn.Linear(self.DENSE_TRUNK_DIM, VALUE_HIDDEN_DIM)
        self.value_fc2 = nn.Linear(VALUE_HIDDEN_DIM, 1)
        self.policy_proj = nn.Linear(self.DENSE_TRUNK_DIM, POLICY_HIDDEN_DIM)
        self.turn_proj = nn.Linear(TURN_FEATURE_DIM, POLICY_HIDDEN_DIM)
        self.blunder_board_proj = nn.Linear(self.DENSE_TRUNK_DIM, BLUNDER_HIDDEN_DIM)
        self.blunder_turn_proj = nn.Linear(TURN_FEATURE_DIM, BLUNDER_HIDDEN_DIM)
        self.blunder_bias = nn.Parameter(torch.zeros(1))

    # --- Slicing helpers ---

    def _node_features(self, raw):
        """Extract (B, 39, NODE_FEATURE_DIM) per-node features from raw."""
        B = raw.size(0)
        # Stones: 3 channels per node, layout = own_all_nodes | enemy_all | empty_all.
        stones = raw[:, _STONES_START:_STONES_START + _STONES_LEN]
        stones = stones.view(B, 3, NUM_NODES).permute(0, 2, 1)        # (B, 39, 3)
        # Neighborhood frac: 2 per node, but layout is interleaved (own, enemy)
        # per node — see board_to_tensor.
        nbhd = raw[:, _NBHD_START:_NBHD_START + _NBHD_LEN]
        nbhd = nbhd.view(B, NUM_NODES, 2)                             # (B, 39, 2)
        # Life status: 4 per node, layout = own_escape_all | enemy_escape_all
        # | own_crush_all | enemy_crush_all  (each contiguous over 39 nodes).
        life = raw[:, _LIFE_START:_LIFE_START + _LIFE_LEN]
        life = life.view(B, 4, NUM_NODES).permute(0, 2, 1)            # (B, 39, 4)
        static = self.node_static.unsqueeze(0).expand(B, -1, -1)      # (B, 39, 2)
        return torch.cat([stones, nbhd, life, static], dim=-1)        # (B, 39, 11)

    def _global_features(self, raw):
        """Concat the parts of raw not absorbed into per-node features."""
        # Globals = bytes [195..250) ∪ [406..450).
        # Layout from board_to_tensor (after life-status block was inserted at 250):
        #   195..222  spell charges (27)
        #   222..225  mana (3)
        #   225..227  spell counters (2)
        #   227..245  lock (18)
        #   245..246  stone diff (1)
        #   246..248  total stones (2)
        #   248..250  turn progress (2)
        #   250..406  LIFE (extracted into per-node) ← skip
        #   406..424  spell fill (18)
        #   424..442  threat (18)
        #   442..450  tempo (8)
        head = raw[:, _NBHD_START + _NBHD_LEN:_LIFE_START]
        tail = raw[:, _SPELL_FILL_START:]
        return torch.cat([head, tail], dim=-1)

    def forward(self, raw_features, spell_ids, turn_features=None,
                turn_counts=None, return_blunder=False):
        node_feat = self._node_features(raw_features)                 # (B, 39, 11)
        h = self.node_proj(node_feat, self.A_norm)                    # (B, 39, H)
        for block in self.graph_blocks:
            h = block(h, self.A_norm)
        # Pool over the 39 nodes.
        pooled = torch.cat([h.mean(dim=1), h.amax(dim=1)], dim=-1)    # (B, 2H)

        spell_emb = self.spell_embed(spell_ids).reshape(spell_ids.size(0), -1)
        globals_ = self._global_features(raw_features)
        x = torch.cat([pooled, spell_emb, globals_], dim=-1)
        x = F.relu(self.dense_in_ln(self.dense_in(x)))
        for block in self.dense_blocks:
            x = block(x)

        v = F.relu(self.value_fc1(x))
        v = torch.tanh(self.value_fc2(v))

        policy_logits = None
        blunder_logits = None
        if turn_features is not None:
            expected = self.turn_proj.in_features
            if turn_features.size(-1) > expected:
                turn_features = turn_features[..., :expected]
            board_proj = self.policy_proj(x)
            turn_proj = self.turn_proj(turn_features)
            logits = torch.bmm(turn_proj, board_proj.unsqueeze(-1)).squeeze(-1)
            if turn_counts is not None:
                max_t = turn_features.size(1)
                mask = (
                    torch.arange(max_t, device=logits.device).unsqueeze(0)
                    >= turn_counts.unsqueeze(1)
                )
                logits = logits.masked_fill(mask, float('-inf'))
            policy_logits = logits

            if return_blunder:
                bb = self.blunder_board_proj(x.detach())
                tb = self.blunder_turn_proj(turn_features)
                bl = torch.bmm(tb, bb.unsqueeze(-1)).squeeze(-1) + self.blunder_bias
                if turn_counts is not None:
                    bl = bl.masked_fill(mask, 0.0)
                blunder_logits = bl

        if return_blunder:
            return v, policy_logits, blunder_logits
        return v, policy_logits

    def evaluate_with_policy(self, raw_features, spell_ids, turn_features,
                             blunder_lambda=0.0):
        raw_features = raw_features.unsqueeze(0)
        spell_ids = spell_ids.unsqueeze(0)
        turn_features = turn_features.unsqueeze(0)
        turn_counts = torch.tensor([turn_features.size(1)], dtype=torch.long)
        return_blunder = blunder_lambda > 0
        with torch.no_grad():
            out = self.forward(raw_features, spell_ids, turn_features,
                               turn_counts, return_blunder=return_blunder)
        if return_blunder:
            v, logits, b = out
            adj = logits - blunder_lambda * torch.sigmoid(b)
        else:
            v, logits = out
            adj = logits
        return v.item(), F.softmax(adj.squeeze(0), dim=0).cpu().numpy()

    def save(self, path):
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.',
                    exist_ok=True)
        torch.save({
            'model_state_dict': self.state_dict(),
            'arch': 'SigilNetGraph',
        }, path)

    @classmethod
    def load(cls, path, device='cpu'):
        net = cls()
        ckpt = torch.load(path, map_location=device, weights_only=True)
        state = ckpt['model_state_dict']
        # Resize turn-feature-keyed projections to match an older
        # checkpoint's TURN_FEATURE_DIM if it differs from the current
        # constant — same approach as SigilNet.load.
        if 'turn_proj.weight' in state:
            d = state['turn_proj.weight'].shape[1]
            if d != net.turn_proj.in_features:
                net.turn_proj = nn.Linear(d, POLICY_HIDDEN_DIM)
        if 'blunder_turn_proj.weight' in state:
            d = state['blunder_turn_proj.weight'].shape[1]
            if d != net.blunder_turn_proj.in_features:
                from ai.sigil_net import BLUNDER_HIDDEN_DIM
                net.blunder_turn_proj = nn.Linear(d, BLUNDER_HIDDEN_DIM)
        net.load_state_dict(state, strict=False)
        net.eval()
        return net


class _DenseResBlock(nn.Module):
    """Pre-activation residual block, mirrors ai/sigil_net.py:ResBlock."""

    def __init__(self, dim):
        super().__init__()
        self.fc1 = nn.Linear(dim, dim)
        self.ln1 = nn.LayerNorm(dim)
        self.fc2 = nn.Linear(dim, dim)
        self.ln2 = nn.LayerNorm(dim)

    def forward(self, x):
        out = self.ln1(self.fc1(x))
        out = F.relu(out)
        out = self.ln2(self.fc2(out))
        return F.relu(out + x)
