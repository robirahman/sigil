"""Export model weights as a compact binary file + JSON manifest.

Binary format: concatenated float32 arrays.
Manifest: JSON with config (architecture details) plus tensor name →
shape/offset/length entries.

Supports SigilNet (flat trunk), SigilNet with auxiliary heads, and
SigilNetGraph (graph-conv trunk). The ``arch`` field in the manifest
tells the JS loader which inference path to take.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from ai.sigil_net import SigilNet
from ai.sigil_net_graph import (
    SigilNetGraph, NODE_FEATURE_DIM, GLOBAL_FEATURE_DIM,
)
from ai.config import (
    MODELS_DIR, NUM_POSSIBLE_SPELLS, NUM_SPELL_SLOTS, SPELL_EMBED_DIM,
    RAW_FEATURE_DIM, TRUNK_DIM, NUM_RES_BLOCKS,
    POLICY_HIDDEN_DIM, VALUE_HIDDEN_DIM, TURN_FEATURE_DIM,
)


def _load_model(model_path):
    """Detect arch from the checkpoint and load the right class."""
    ckpt = torch.load(model_path, map_location='cpu', weights_only=True)
    arch = ckpt.get('arch', 'SigilNet')
    if arch == 'SigilNetGraph':
        return SigilNetGraph.load(model_path), arch
    return SigilNet.load(model_path), arch


def _config_for(arch, model):
    common = {
        'num_possible_spells': NUM_POSSIBLE_SPELLS,
        'num_spell_slots': NUM_SPELL_SLOTS,
        'spell_embed_dim': SPELL_EMBED_DIM,
        'raw_feature_dim': RAW_FEATURE_DIM,
        'policy_hidden_dim': POLICY_HIDDEN_DIM,
        'value_hidden_dim': VALUE_HIDDEN_DIM,
        'turn_feature_dim': TURN_FEATURE_DIM,
    }
    if arch == 'SigilNetGraph':
        return {
            **common,
            'arch': 'SigilNetGraph',
            'graph_hidden_dim': model.GRAPH_HIDDEN_DIM,
            'num_graph_blocks': model.NUM_GRAPH_BLOCKS,
            'dense_trunk_dim': model.DENSE_TRUNK_DIM,
            'num_dense_res_blocks': model.NUM_DENSE_RES_BLOCKS,
            'node_feature_dim': NODE_FEATURE_DIM,
            'global_feature_dim': GLOBAL_FEATURE_DIM,
        }
    return {
        **common,
        'arch': 'SigilNet',
        'trunk_dim': TRUNK_DIM,
        'num_res_blocks': NUM_RES_BLOCKS,
    }


def export_binary(model_path, output_dir, name='sigil_net'):
    model, arch = _load_model(model_path)
    model.eval()
    state = model.state_dict()

    os.makedirs(output_dir, exist_ok=True)

    manifest = {
        'config': _config_for(arch, model),
        'tensors': {},
    }

    bin_path = os.path.join(output_dir, f'{name}.bin')
    manifest_path = os.path.join(output_dir, f'{name}.json')

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
    print(f"Architecture: {arch}, Tensors: {len(manifest['tensors'])}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=os.path.join(MODELS_DIR, 'best_model.pt'))
    parser.add_argument('--output-dir', default='docs/static/models')
    parser.add_argument('--name', default='sigil_net',
                        help="Base name for output files (e.g. 'sigil_net_graph')")
    args = parser.parse_args()
    export_binary(args.model, args.output_dir, name=args.name)
