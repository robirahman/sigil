"""Export SigilNet weights as a compact binary file + JSON manifest.

Binary format: concatenated float32 arrays
Manifest: JSON with tensor names, shapes, and byte offsets
"""

import json
import os
import sys
import struct

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from ai.sigil_net import SigilNet
from ai.config import (
    MODELS_DIR, NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS, SPELL_EMBED_DIM,
    RAW_FEATURE_DIM, TRUNK_DIM, NUM_RES_BLOCKS,
    POLICY_HIDDEN_DIM, VALUE_HIDDEN_DIM, TURN_FEATURE_DIM,
)


def export_binary(model_path, output_dir):
    model = SigilNet.load(model_path)
    model.eval()
    state = model.state_dict()

    os.makedirs(output_dir, exist_ok=True)

    manifest = {
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
        'tensors': {},
    }

    bin_path = os.path.join(output_dir, 'sigil_net.bin')
    manifest_path = os.path.join(output_dir, 'sigil_net.json')

    offset = 0
    with open(bin_path, 'wb') as f:
        for key, tensor in state.items():
            arr = tensor.cpu().numpy().astype(np.float32).flatten()
            shape = list(tensor.shape)
            byte_data = arr.tobytes()
            f.write(byte_data)
            manifest['tensors'][key] = {
                'shape': shape,
                'offset': offset,
                'length': len(arr),
            }
            offset += len(byte_data)

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f)

    bin_size = os.path.getsize(bin_path) / 1024 / 1024
    manifest_size = os.path.getsize(manifest_path) / 1024
    print(f"Binary weights: {bin_path} ({bin_size:.1f} MB)")
    print(f"Manifest: {manifest_path} ({manifest_size:.1f} KB)")
    print(f"Tensors: {len(manifest['tensors'])}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=os.path.join(MODELS_DIR, 'best_model.pt'))
    parser.add_argument('--output-dir', default='docs/static/models')
    args = parser.parse_args()
    export_binary(args.model, args.output_dir)
