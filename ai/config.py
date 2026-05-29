"""Hyperparameters and constants for the Sigil AI system."""

import os

# ---- Paths ----
AI_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(AI_DIR)
MODELS_DIR = os.path.join(AI_DIR, 'models')
DATA_DIR = os.path.join(AI_DIR, 'data')

# ---- Board constants ----
NUM_NODES = 39
NUM_SPELL_SLOTS = 9
NUM_POSSIBLE_SPELLS = 15

# Spell name -> integer ID (fixed mapping for embedding layer)
SPELL_TO_ID = {
    'Flourish': 0, 'Carnage': 1, 'Bewitch': 2, 'Starfall': 3,
    'Seal_of_Lightning': 4, 'Grow': 5, 'Fireblast': 6, 'Hail_Storm': 7,
    'Meteor': 8, 'Seal_of_Wind': 9, 'Sprout': 10, 'Slash': 11,
    'Surge': 12, 'Comet': 13, 'Seal_of_Summer': 14,
}

# ---- Network architecture (medium) ----
SPELL_EMBED_DIM = 16        # Embedding dimension per spell
# Raw feature breakdown (must match features.board_to_tensor):
#   250 — base block (stones, neighborhood, charges, mana, counters, lock, ...)
#         (note: includes the side-to-move stone differential at index 244)
#   156 — per-stone life-status (own/enemy escape_distance and crushable_now)
#    18 — spell-position fill (own/enemy stone counts in each of 9 spell positions)
#    18 — threat-of-activation (own/enemy net stones if each spell is cast now)
#     6 — mana-pressure (own + enemy adjacency-graph distance to a1/b1/c1)
#     8 — tempo scalars (min castable, count castable, mana diff, escape sums, ...)
RAW_FEATURE_DIM = 250 + 156 + 18 + 18 + 6 + 8  # 456
TRUNK_DIM = 400             # ResNet trunk width
NUM_RES_BLOCKS = 6          # Residual blocks in trunk
POLICY_HIDDEN_DIM = 256     # Policy head hidden dimension
VALUE_HIDDEN_DIM = 128      # Value head hidden dimension
# Per-turn encoding: 64 base + 16 tactical (v22) + 4 lookahead (v27) = 84
TURN_FEATURE_DIM = 84

# ---- Network architecture (hard — ~44M params, NNUE-style shallow+wide) ----
HARD_SPELL_EMBED_DIM = 32   # Wider spell embedding
HARD_WIDE_DIM = 4096        # Width of hidden layers
HARD_SQUEEZE_DIM = 2048     # Squeeze before heads
HARD_POLICY_DIM = 256       # Policy head projection
HARD_VALUE_DIM = 256        # Value head hidden

# ---- Enumeration ----
# When True, MCTS + self-play enumerate every legal turn fully exhaustively
# (every keep-set, push destination, multi-move target-set and effect target),
# instead of the engine's greedy get_legal_turns. This makes the action space
# the AI learns over honest, but pushes branching from ~14 to ~hundreds (p99
# ~10k), so self-play is far slower and sims-per-move must rise to compensate.
# Set False to fall back to the greedy enumerator (fast, but blind to the
# keep-set/push/effect choices). See ai/enumerator.get_legal_turns_exhaustive.
EXHAUSTIVE_ENUM = True

# ---- MCTS ----
C_PUCT = 2.0               # Exploration constant
# Sims raised for the exhaustive action space (branching ~hundreds): at the
# old 400/800 most moves got <1 visit. Tune on GPU — higher is better play but
# linearly slower self-play.
NUM_SIMS_TRAIN = 1200       # Simulations per move during self-play
NUM_SIMS_PLAY = 2400        # Simulations per move in production
DIRICHLET_ALPHA = 0.5       # Noise parameter (higher = more uniform)
DIRICHLET_EPSILON = 0.25    # Fraction of noise mixed into root prior
TEMP_THRESHOLD = 30         # Turn after which temperature drops
TEMP_PLAY = 0.01            # Temperature in production (near-greedy)
MCTS_BATCH_SIZE = 8         # Leaf evaluations batched together per NN call

# Progressive widening: cap the actions considered at each MCTS node to
# top-K by prior, where K = max(MCTS_WIDENING_MIN_K, ceil(C * N^alpha))
# and N is that node's total visits. With Sigil's exhaustive-enum
# branching (up to ~10k legal turns at mid-game), the raw action space
# is too large for MCTS to meaningfully sample — even 1600 sims / 4000
# actions = a tenth of a visit per action, so selection collapses to
# "trust the network prior, sample noise." Widening recovers actual
# search: at N=1 only the top 4 actions are visible, at N=100 the top
# 20, at N=1600 the top 80. Each top-K action accumulates real visits
# before expansion considers more options. Set MCTS_WIDENING_C=0 to
# disable widening entirely.
MCTS_WIDENING_C = 2.0
MCTS_WIDENING_ALPHA = 0.5
MCTS_WIDENING_MIN_K = 4

# ---- Training ----
BATCH_SIZE = 512
LR_INIT = 0.001
LR_FINAL = 0.0001
WEIGHT_DECAY = 1e-4
POLICY_LOSS_WEIGHT = 0.5    # Balance between value and policy loss
TRAINING_EPOCHS = 10        # Epochs per generation over the data window
DATA_WINDOW = 500_000       # Rolling window of positions to train on
GAMES_PER_ITERATION = 10_000
GATE_THRESHOLD = 0.55       # New model must win this fraction to be accepted
GATE_GAMES = 400            # Games played for gating evaluation
MAX_TURNS = 200             # Safety limit per game

# ---- Resignation ----
RESIGN_THRESHOLD = 0.85     # Resign if value < -threshold
RESIGN_CONSECUTIVE = 3      # Must be this many turns in a row
RESIGN_DISABLE_PROB = 0.1   # 10% of games play out to verify
