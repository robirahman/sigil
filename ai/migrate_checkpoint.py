"""Grow an old SigilNet checkpoint to the current architecture constants.

Architecture growth history (each block APPENDED so old columns keep
their indices):
  - Fissure:    NUM_POSSIBLE_SPELLS  15 -> 42, RAW_FEATURE_DIM 456 -> 495
                (39-dim destroyed-node channel)
  - Providence: NUM_POSSIBLE_SPELLS  42 -> 45, RAW_FEATURE_DIM 495 -> 505
                (10-dim pending-move block), TURN_FEATURE_DIM 84 -> 116
                (30-dim expansion-cast one-hot + 2 Providence scalars)
  - Aftershock+Ambush: NUM_POSSIBLE_SPELLS 45 -> 51,
                RAW_FEATURE_DIM 505 -> 593 (10-dim pending-burn block +
                78-dim own/enemy snare channels), TURN_FEATURE_DIM
                116 -> 124 (6-dim playtest-pack cast one-hot at [116:122]
                + burns-resolved and snares-placed scalars)

A checkpoint trained under the old constants can't be loaded straight into
the new network (shape mismatch on spell_embed.weight and raw_proj.weight).
This script copies every overlapping weight into a fresh new-architecture
network so training can WARM-START instead of starting from scratch:

  - spell_embed.weight: old 15 rows (IDs 0-14, the core spells, whose IDs
    were deliberately kept fixed) copy in place; the 27 new expansion rows
    keep their fresh init and are learned during fine-tuning.
  - raw_proj.weight: the old 456 input columns copy in place; the 39 new
    destroyed-channel columns are ZEROED, so the migrated model scores any
    board WITHOUT a destroyed node bit-identically to the original — the
    destroyed channel only starts to matter once Fissure creates a wall and
    fine-tuning has taught those columns.
  - Every other layer (trunk, value/policy/blunder/tactical heads) copies
    directly; turn_proj / blunder_turn_proj copy their overlapping slice if
    the old checkpoint used a smaller TURN_FEATURE_DIM.

Usage:
    python -m ai.migrate_checkpoint \\
        --in  ai/models/best_model.pt \\
        --out ai/models/best_model_fissure_init.pt

Then warm-start training from the migrated checkpoint:
    python -m ai.train_sigil_v2 --model ai/models/best_model_fissure_init.pt ...
"""
import argparse
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai.config import NUM_POSSIBLE_SPELLS, RAW_FEATURE_DIM


def _new_net(arch):
    if arch == 'SigilNet':
        from ai.sigil_net import SigilNet
        return SigilNet()
    if arch == 'SigilNetHard':
        from ai.sigil_net_hard import SigilNetHard
        return SigilNetHard()
    raise ValueError(f'Unsupported arch: {arch!r} (expected SigilNet or SigilNetHard)')


def migrate(in_path, out_path, arch='SigilNet'):
    ckpt = torch.load(in_path, map_location='cpu', weights_only=True)
    old_sd = ckpt['model_state_dict']
    if ckpt.get('storage') == 'float16':
        old_sd = {k: v.float() for k, v in old_sd.items()}

    net = _new_net(arch)
    new_sd = net.state_dict()

    copied, grown, skipped = [], [], []
    for key, new_t in new_sd.items():
        if key not in old_sd:
            skipped.append(key)  # e.g. a head added after the old checkpoint
            continue
        old_t = old_sd[key]
        if old_t.shape == new_t.shape:
            new_t.copy_(old_t)
            copied.append(key)
        else:
            # Copy the overlapping sub-tensor; the rest keeps fresh init.
            region = tuple(slice(0, min(o, n)) for o, n in zip(old_t.shape, new_t.shape))
            new_t[region].copy_(old_t[region])
            grown.append(f'{key} {tuple(old_t.shape)}->{tuple(new_t.shape)}')

    # Zero the appended input columns of the projection layers so the
    # migrated model is behaviorally identical to the original whenever the
    # new features are zero (wall-free boards for the destroyed channel,
    # schedule-free boards for the Providence block, core-spell casts for
    # the widened turn one-hot).
    for proj_key in ('raw_proj.weight', 'turn_proj.weight',
                     'blunder_turn_proj.weight'):
        if proj_key not in new_sd or proj_key not in old_sd:
            continue
        pt = new_sd[proj_key]
        old_in = old_sd[proj_key].shape[1]
        if pt.shape[1] > old_in:
            pt[:, old_in:].zero_()

    net.load_state_dict(new_sd)
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    net.save(out_path)

    print(f'Migrated {arch}: {in_path} -> {out_path}')
    print(f'  spell vocab : {NUM_POSSIBLE_SPELLS}, raw feature dim: {RAW_FEATURE_DIM}')
    print(f'  copied {len(copied)} tensors verbatim')
    for g in grown:
        print(f'  grew   {g}')
    if skipped:
        print(f'  fresh-init (not in old ckpt): {len(skipped)} tensors')


def main():
    parser = argparse.ArgumentParser(description='Grow a checkpoint to the post-Fissure arch')
    parser.add_argument('--in', dest='in_path', required=True)
    parser.add_argument('--out', dest='out_path', required=True)
    parser.add_argument('--arch', default='SigilNet',
                        choices=['SigilNet', 'SigilNetHard'])
    args = parser.parse_args()
    migrate(args.in_path, args.out_path, arch=args.arch)


if __name__ == '__main__':
    main()
