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
# Embedding vocabulary: every spell EXCEPT the unofficial Panda expansion.
# IDs 0-14 are the original core spells and MUST keep these values so older
# checkpoints' first 15 embedding rows stay aligned when the table is grown
# (see ai/migrate_checkpoint.py). IDs 15-44 are the official expansion
# spells; IDs 45-50 are reserved (retired spells — never reassign them).
# Panda and Experimental spells are deliberately absent (they fall back to ID 0 via
# .get(name, 0)) — an Experimental design only earns an embedding row, and
# the checkpoint migration that comes with it, once it graduates.
NUM_POSSIBLE_SPELLS = 51

# Spell name -> integer ID (fixed mapping for embedding layer).
SPELL_TO_ID = {
    # --- Core (15) ---
    'Flourish': 0, 'Carnage': 1, 'Bewitch': 2, 'Starfall': 3,
    'Seal_of_Lightning': 4, 'Grow': 5, 'Fireblast': 6, 'Hail_Storm': 7,
    'Meteor': 8, 'Seal_of_Wind': 9, 'Sprout': 10, 'Slash': 11,
    'Surge': 12, 'Comet': 13, 'Seal_of_Summer': 14,
    # --- Springtime ---
    'Blossom': 15, 'Scatter': 16, 'Seal_of_Spring': 17,
    # --- Celestial ---
    'Syzygy': 18, 'Eclipse': 19, 'Azimuth': 20,
    # --- Inferno ---
    'Erupt': 21, 'Fury': 22, 'Charge': 23,
    # --- Tempest ---
    'Hurricane': 24, 'Storm_Front': 25, 'Gust': 26,
    # --- Flood pack (Tsunami keeps id 27 from its pre-swap name "Flood" —
    #     the id is an embedding index baked into every trained checkpoint) ---
    'Tsunami': 27, 'Torrent': 28, 'Splash': 29,
    # --- Autumn (live game only; not yet in the Python simulator, so it
    #     cannot be trained until simboard.py implements Harvest/Gather) ---
    'Harvest': 30, 'Gather': 31, 'Seal_of_Autumn': 32,
    # --- Gloom ---
    'Corrupt': 33, 'Decay': 34, 'Lurk': 35,
    # --- Covenant ---
    'Seal_of_Destruction': 36, 'Seal_of_Stone': 37, 'Seal_of_Winter': 38,
    # --- Tectonic ---
    'Fissure': 39, 'Rock_Slide': 40, 'Bulwark': 41,
    # --- Providence ---
    'Dividend': 42, 'Annuity': 43, 'Endowment': 44,
    # IDs 45-50: reserved for retired spells (embedding rows stay in the
    # checkpoint; do not reassign).
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
#    39 — destroyed-node channel (1.0 per node permanently destroyed by Fissure).
#         APPENDED LAST so the older 456-dim feature columns keep their indices,
#         which lets ai/migrate_checkpoint.py warm-start by zero-padding raw_proj.
#    10 — Providence bank block (own/enemy bank min(x,8)/8 in slots 0 and 4,
#         slots 1-3 and 5-7 zero, plus own/enemy placement-available flags).
#         Appended last, same migration convention as the destroyed-node
#         channel.
#    10 — reserved block [505:515] (retired spells; always zero).
#    78 — reserved channels [515:593] (retired spells; always zero).
#         Kept so trained checkpoints' raw_proj columns stay aligned.
RAW_FEATURE_DIM = 250 + 156 + 18 + 18 + 6 + 8 + 39 + 10 + 10 + 78  # 593
TRUNK_DIM = 400             # ResNet trunk width
NUM_RES_BLOCKS = 6          # Residual blocks in trunk
POLICY_HIDDEN_DIM = 256     # Policy head hidden dimension
VALUE_HIDDEN_DIM = 128      # Value head hidden dimension
# Per-turn encoding: 64 base + 16 tactical (v22) + 4 lookahead (v27)
#   + 30 spell-ID one-hot extension for IDs 15-44 at [84:114] (v29 — the
#     legacy [43:58] one-hot only covers core IDs 0-14; expansion casts
#     previously overflowed into the tactical columns)
#   + 2 Providence scalars ([114] banked stone placed this turn, [115]
#     stones banked by this turn's cast /4)
#   + 6 spell-ID one-hot extension for reserved IDs 45-50 at [116:122]
#     (retired spells; always zero)
#   + 2 reserved scalars [122], [123] (retired spells; always zero) = 124
TURN_FEATURE_DIM = 124

# ---- Network architecture (hard — ~44M params, NNUE-style shallow+wide) ----
HARD_SPELL_EMBED_DIM = 32   # Wider spell embedding
HARD_WIDE_DIM = 4096        # Width of hidden layers
HARD_SQUEEZE_DIM = 2048     # Squeeze before heads
HARD_POLICY_DIM = 256       # Policy head projection
HARD_VALUE_DIM = 256        # Value head hidden

# ---- MCTS ----
C_PUCT = 2.0               # Exploration constant
NUM_SIMS_TRAIN = 400        # Simulations per move during self-play
NUM_SIMS_PLAY = 800         # Simulations per move in production
DIRICHLET_ALPHA = 0.5       # Noise parameter (higher = more uniform)
DIRICHLET_EPSILON = 0.25    # Fraction of noise mixed into root prior
TEMP_THRESHOLD = 30         # Turn after which temperature drops
TEMP_PLAY = 0.01            # Temperature in production (near-greedy)
MCTS_BATCH_SIZE = 8         # Leaf evaluations batched together per NN call

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
