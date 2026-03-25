"""
Training script for the Sigil neural network evaluator.

Usage:
    python train.py --data training_data/training_data.jsonl --output models/eval_v1.json --epochs 50
"""

import argparse
import json
import os
import time

import numpy as np

from nn_evaluator import SigilEvalNet, board_to_features, INPUT_SIZE


def load_training_data(data_path):
    """Load training data from a JSONL file."""
    features_list = []
    labels_list = []

    with open(data_path) as f:
        for line in f:
            entry = json.loads(line.strip())
            feat = board_to_features(entry['sfn'])
            features_list.append(feat)
            labels_list.append(entry['label'])

    features = np.array(features_list, dtype=np.float32)
    labels = np.array(labels_list, dtype=np.float32)

    return features, labels


def train_model(data_path, output_path, epochs=50, batch_size=256, lr=0.001):
    """Train the model and save it."""
    print(f"Loading training data from {data_path}...")
    features, labels = load_training_data(data_path)
    print(f"Loaded {len(features)} samples, feature size: {features.shape[1]}")
    print(f"Label distribution: {np.mean(labels):.3f} mean (0.5 = balanced)")

    # Split into train/val
    n = len(features)
    indices = np.random.permutation(n)
    val_size = max(100, n // 10)
    val_idx = indices[:val_size]
    train_idx = indices[val_size:]

    train_features = features[train_idx]
    train_labels = labels[train_idx]
    val_features = features[val_idx]
    val_labels = labels[val_idx]

    print(f"Train: {len(train_features)}, Validation: {len(val_features)}")

    # Create and train model
    model = SigilEvalNet()
    print(f"\nTraining for {epochs} epochs...")
    start = time.time()

    model.train(train_features, train_labels, epochs=epochs,
                batch_size=batch_size, lr=lr)

    elapsed = time.time() - start
    print(f"Training completed in {elapsed:.1f}s")

    # Validate
    val_preds = model.forward(val_features)
    val_loss = -np.mean(val_labels * np.log(np.clip(val_preds, 1e-7, 1)) +
                       (1 - val_labels) * np.log(np.clip(1 - val_preds, 1e-7, 1)))
    val_acc = np.mean((val_preds > 0.5) == (val_labels > 0.5))
    print(f"Validation loss: {val_loss:.4f}, Accuracy: {val_acc:.3f}")

    # Check sanity: winning positions should score high
    winning_mask = val_labels > 0.5
    losing_mask = val_labels < 0.5
    if winning_mask.any():
        print(f"Mean pred for winning positions: {val_preds[winning_mask].mean():.3f}")
    if losing_mask.any():
        print(f"Mean pred for losing positions: {val_preds[losing_mask].mean():.3f}")

    # Save model
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)
    model.save(output_path)
    print(f"\nModel saved to {output_path}")

    return model


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train Sigil evaluator')
    parser.add_argument('--data', type=str, default='training_data/training_data.jsonl')
    parser.add_argument('--output', type=str, default='models/eval_v1.json')
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--batch-size', type=int, default=256)
    parser.add_argument('--lr', type=float, default=0.001)
    args = parser.parse_args()

    train_model(args.data, args.output, args.epochs, args.batch_size, args.lr)
