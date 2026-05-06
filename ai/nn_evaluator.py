"""
Neural network position evaluator for Sigil, implemented in pure NumPy.

Architecture: Input(170) -> Dense(256, ReLU) -> Dense(128, ReLU) -> Dense(64, ReLU) -> Dense(1, Sigmoid)
Output: win probability for side to move.
"""

import numpy as np
import json
import os

from notation import NODE_ORDER, POSITIONS, sfn_to_dict


# Feature dimensions
NUM_NODES = 39
STONE_FEATURES = NUM_NODES * 3  # one-hot: own, enemy, empty
MANA_FEATURES = 3
CHARGE_FEATURES = 9 * 3  # one-hot: own, enemy, none
COUNTER_FEATURES = 2
LOCK_FEATURES = 9 * 2
STONE_DIFF_FEATURE = 1
TOTAL_STONE_FEATURES = 2

INPUT_SIZE = (STONE_FEATURES + MANA_FEATURES + CHARGE_FEATURES +
              COUNTER_FEATURES + LOCK_FEATURES + STONE_DIFF_FEATURE +
              TOTAL_STONE_FEATURES)  # = 170

MANA_NODES = ['a1', 'b1', 'c1']


def board_to_features(sfn_str, side_to_move=None):
    """Convert an SFN string to a feature vector.

    Returns numpy array of shape (INPUT_SIZE,).
    The features are relative to the side_to_move (own vs enemy).
    """
    d = sfn_to_dict(sfn_str)
    if side_to_move is None:
        side_to_move = d['turn']

    enemy = 'blue' if side_to_move == 'red' else 'red'
    features = []

    # Stone placement: 39 * 3 one-hot
    for node in NODE_ORDER:
        stone = d['stones'][node]
        features.append(1.0 if stone == side_to_move else 0.0)
        features.append(1.0 if stone == enemy else 0.0)
        features.append(1.0 if stone is None else 0.0)

    # Mana nodes: +1 own, -1 enemy, 0 empty
    for mn in MANA_NODES:
        stone = d['stones'][mn]
        if stone == side_to_move:
            features.append(1.0)
        elif stone == enemy:
            features.append(-1.0)
        else:
            features.append(0.0)

    # Spell charge status: 9 * 3 one-hot
    spell_names = d['spell_names']
    for i in range(9):
        pos_idx = i + 1
        nodes = POSITIONS[pos_idx]
        first = d['stones'][nodes[0]]
        if first is not None and all(d['stones'][n] == first for n in nodes[1:]):
            charged_for = first
        else:
            charged_for = None
        features.append(1.0 if charged_for == side_to_move else 0.0)
        features.append(1.0 if charged_for == enemy else 0.0)
        features.append(1.0 if charged_for is None else 0.0)

    # Spell counters (normalized)
    own_sc = d['red_spellcounter'] if side_to_move == 'red' else d['blue_spellcounter']
    enemy_sc = d['blue_spellcounter'] if side_to_move == 'red' else d['red_spellcounter']
    features.append(own_sc / 6.0)
    features.append(enemy_sc / 6.0)

    # Lock status: 9 * 2
    own_lock = d['red_lock'] if side_to_move == 'red' else d['blue_lock']
    enemy_lock = d['blue_lock'] if side_to_move == 'red' else d['red_lock']
    for i in range(9):
        sn = spell_names[i]
        features.append(1.0 if own_lock == sn else 0.0)
        features.append(1.0 if enemy_lock == sn else 0.0)

    # Stone differential (normalized)
    own_stones = sum(1 for s in d['stones'].values() if s == side_to_move)
    enemy_stones = sum(1 for s in d['stones'].values() if s == enemy)
    features.append((own_stones - enemy_stones) / 39.0)

    # Total stone counts (normalized)
    features.append(own_stones / 39.0)
    features.append(enemy_stones / 39.0)

    return np.array(features, dtype=np.float32)


def simboard_to_features(board, side_to_move=None):
    """Convert a SimBoard directly to features without going through SFN."""
    if side_to_move is None:
        side_to_move = board.whose_turn
    enemy = 'blue' if side_to_move == 'red' else 'red'

    features = []

    for node in NODE_ORDER:
        stone = board.stones[node]
        features.append(1.0 if stone == side_to_move else 0.0)
        features.append(1.0 if stone == enemy else 0.0)
        features.append(1.0 if stone is None else 0.0)

    for mn in MANA_NODES:
        stone = board.stones[mn]
        if stone == side_to_move:
            features.append(1.0)
        elif stone == enemy:
            features.append(-1.0)
        else:
            features.append(0.0)

    for i in range(9):
        spell_name = board.spell_names[i]
        charged = spell_name in board.charged_spells[side_to_move]
        enemy_charged = spell_name in board.charged_spells[enemy]
        features.append(1.0 if charged else 0.0)
        features.append(1.0 if enemy_charged else 0.0)
        features.append(1.0 if not charged and not enemy_charged else 0.0)

    own_sc = board.spell_counter[side_to_move]
    enemy_sc = board.spell_counter[enemy]
    features.append(own_sc / 6.0)
    features.append(enemy_sc / 6.0)

    own_lock = board.lock[side_to_move]
    enemy_lock = board.lock[enemy]
    for i in range(9):
        sn = board.spell_names[i]
        features.append(1.0 if own_lock == sn else 0.0)
        features.append(1.0 if enemy_lock == sn else 0.0)

    own_stones = board.totalstones[side_to_move]
    enemy_stones = board.totalstones[enemy]
    features.append((own_stones - enemy_stones) / 39.0)
    features.append(own_stones / 39.0)
    features.append(enemy_stones / 39.0)

    return np.array(features, dtype=np.float32)


class SigilEvalNet:
    """Simple feedforward neural network implemented in NumPy."""

    def __init__(self, layer_sizes=None):
        if layer_sizes is None:
            layer_sizes = [INPUT_SIZE, 256, 128, 64, 1]
        self.layer_sizes = layer_sizes
        self.weights = []
        self.biases = []

        # Xavier initialization
        for i in range(len(layer_sizes) - 1):
            fan_in = layer_sizes[i]
            fan_out = layer_sizes[i + 1]
            std = np.sqrt(2.0 / (fan_in + fan_out))
            w = np.random.randn(fan_in, fan_out).astype(np.float32) * std
            b = np.zeros(fan_out, dtype=np.float32)
            self.weights.append(w)
            self.biases.append(b)

    def forward(self, x):
        """Forward pass. x shape: (batch_size, input_size) or (input_size,)."""
        single = x.ndim == 1
        if single:
            x = x.reshape(1, -1)

        for i in range(len(self.weights) - 1):
            x = x @ self.weights[i] + self.biases[i]
            x = np.maximum(x, 0)  # ReLU

        # Last layer: sigmoid
        x = x @ self.weights[-1] + self.biases[-1]
        x = 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

        if single:
            return x[0, 0]
        return x.squeeze(-1)

    def _backward(self, x_batch, y_batch, lr=0.001):
        """Backward pass with gradient descent. Returns loss."""
        batch_size = x_batch.shape[0]

        # Forward pass with cached activations
        activations = [x_batch]
        z_values = []

        h = x_batch
        for i in range(len(self.weights) - 1):
            z = h @ self.weights[i] + self.biases[i]
            z_values.append(z)
            h = np.maximum(z, 0)  # ReLU
            activations.append(h)

        # Output layer
        z = h @ self.weights[-1] + self.biases[-1]
        z_values.append(z)
        pred = 1.0 / (1.0 + np.exp(-np.clip(z, -500, 500)))
        activations.append(pred)

        # BCE loss
        eps = 1e-7
        pred_clipped = np.clip(pred.squeeze(-1), eps, 1 - eps)
        loss = -np.mean(y_batch * np.log(pred_clipped) +
                       (1 - y_batch) * np.log(1 - pred_clipped))

        # Backward pass
        # Output gradient: d_loss/d_z = pred - y (for BCE + sigmoid)
        delta = (pred.squeeze(-1) - y_batch).reshape(-1, 1) / batch_size

        for i in range(len(self.weights) - 1, -1, -1):
            # Gradient for weights and biases
            dw = activations[i].T @ delta
            db = delta.sum(axis=0)

            # Update
            self.weights[i] -= lr * dw
            self.biases[i] -= lr * db

            if i > 0:
                # Propagate gradient
                delta = delta @ self.weights[i].T
                # ReLU derivative
                delta = delta * (z_values[i - 1] > 0).astype(np.float32)

        return loss

    def train(self, features, labels, epochs=50, batch_size=256, lr=0.001):
        """Train the network on (features, labels) data.

        features: np.array shape (N, INPUT_SIZE)
        labels: np.array shape (N,) with values in [0, 1]
        """
        n = len(features)
        indices = np.arange(n)

        for epoch in range(epochs):
            np.random.shuffle(indices)
            epoch_loss = 0
            batches = 0

            for start in range(0, n, batch_size):
                end = min(start + batch_size, n)
                batch_idx = indices[start:end]
                x_batch = features[batch_idx]
                y_batch = labels[batch_idx]
                loss = self._backward(x_batch, y_batch, lr)
                epoch_loss += loss
                batches += 1

            avg_loss = epoch_loss / batches
            if (epoch + 1) % 10 == 0:
                print(f"Epoch {epoch + 1}/{epochs}, Loss: {avg_loss:.4f}")

    def evaluate(self, board, color=None):
        """Evaluate a SimBoard position. Returns win probability for side_to_move."""
        features = simboard_to_features(board, color)
        return self.forward(features)

    def save(self, path):
        """Save model weights to a file."""
        data = {
            'layer_sizes': self.layer_sizes,
            'weights': [w.tolist() for w in self.weights],
            'biases': [b.tolist() for b in self.biases],
        }
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
        with open(path, 'w') as f:
            json.dump(data, f)

    @classmethod
    def load(cls, path):
        """Load model weights from a file."""
        with open(path) as f:
            data = json.load(f)
        net = cls(data['layer_sizes'])
        net.weights = [np.array(w, dtype=np.float32) for w in data['weights']]
        net.biases = [np.array(b, dtype=np.float32) for b in data['biases']]
        return net
