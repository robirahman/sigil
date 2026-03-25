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

# ---- Network architecture (medium — 2.17M params) ----
SPELL_EMBED_DIM = 16        # Embedding dimension per spell
RAW_FEATURE_DIM = 250       # Non-spell raw features
TRUNK_DIM = 400             # ResNet trunk width
NUM_RES_BLOCKS = 6          # Residual blocks in trunk
POLICY_HIDDEN_DIM = 256     # Policy head hidden dimension
VALUE_HIDDEN_DIM = 128      # Value head hidden dimension
TURN_FEATURE_DIM = 64       # Per-turn encoding size

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
