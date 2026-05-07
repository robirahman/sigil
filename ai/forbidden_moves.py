"""Hard inference-time mask for human-annotated 'bad' moves.

A position+turn marked 'bad' by a player in their game becomes a forbidden
edge: any time the AI faces the *same* (stones, spells, color-to-move) and
considers the *same* turn signature, its prior is zeroed and the action is
masked out of MCTS selection. This guarantees the AI never plays a move that
a human has marked as bad, regardless of what the policy network learned.

Position match key: (stones_string_39, spell_names_tuple, color).
Turn signature: '|'.join(f'{a.type}:{a.node}:{a.spell}' for a in actions).

The forbidden table is loaded once at startup from a JSONL of human games,
extracting positions whose `annotation == 'bad'`.
"""

import json
import os

import numpy as np


def turn_signature(turn):
    """Stable string identifier for a CompleteTurn."""
    return '|'.join(f'{a.type}:{a.node}:{a.spell}' for a in turn.actions)


def position_key(board, color):
    """Canonical (stones, spells, color) tuple.

    Stones is the 39-char SFN encoding ('r'/'b'/'.'). Spells is a 9-tuple of
    spell names. Color is 'red' or 'blue'.
    """
    from notation import NODE_ORDER

    def _ch(s):
        if s == 'red':
            return 'r'
        if s == 'blue':
            return 'b'
        return '.'

    stones = ''.join(_ch(board.stones[n]) for n in NODE_ORDER)
    spells = tuple(board.spell_names)
    return (stones, spells, color)


class ForbiddenMoves:
    """Lookup of (position_key) -> set of forbidden turn signatures."""

    def __init__(self):
        self._table = {}

    def __len__(self):
        return sum(len(v) for v in self._table.values())

    def add(self, position_key_tuple, turn_sig):
        self._table.setdefault(position_key_tuple, set()).add(turn_sig)

    def is_forbidden(self, board, color, turn):
        key = position_key(board, color)
        bucket = self._table.get(key)
        if not bucket:
            return False
        return turn_signature(turn) in bucket

    def legal_mask(self, board, color, legal_turns):
        """Boolean array of length len(legal_turns); True = forbidden."""
        mask = np.zeros(len(legal_turns), dtype=bool)
        key = position_key(board, color)
        bucket = self._table.get(key)
        if not bucket:
            return mask
        for i, t in enumerate(legal_turns):
            if turn_signature(t) in bucket:
                mask[i] = True
        return mask

    @classmethod
    def from_jsonl(cls, path):
        """Build from human_games JSONL by replaying each bad-annotated row.

        Bad rows are sparse, so this only does the SimBoard work for them.
        """
        from notation import sfn_to_dict
        from simboard import SimBoard

        fm = cls()
        if not os.path.exists(path):
            return fm

        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get('annotation') != 'bad':
                    continue
                sfn = d.get('sfn')
                policy = d.get('policy') or []
                if not sfn or not policy:
                    continue
                color = sfn_to_dict(sfn)['turn']
                board = SimBoard.from_sfn(sfn)
                legal_turns = list(board.get_legal_turns(color))
                if not legal_turns or len(legal_turns) != len(policy):
                    continue
                # Chosen turn = argmax of one-hot policy in the import.
                idx = max(range(len(policy)), key=lambda i: policy[i])
                fm.add(position_key(board, color),
                       turn_signature(legal_turns[idx]))
        return fm

    @classmethod
    def from_paths(cls, *paths):
        merged = cls()
        for p in paths:
            other = cls.from_jsonl(p)
            for key, sigs in other._table.items():
                for s in sigs:
                    merged.add(key, s)
        return merged

    def to_compact_json(self):
        """Serialize to a small JSON list (the format used at runtime)."""
        return [
            {
                'stones': k[0],
                'spells': list(k[1]),
                'color': k[2],
                'signatures': sorted(sigs),
            }
            for k, sigs in self._table.items()
        ]

    @classmethod
    def from_compact_json(cls, path):
        fm = cls()
        if not os.path.exists(path):
            return fm
        with open(path) as f:
            entries = json.load(f)
        for e in entries:
            key = (e['stones'], tuple(e['spells']), e['color'])
            for s in e.get('signatures', []):
                fm.add(key, s)
        return fm

    @classmethod
    def from_default(cls):
        """Load the production-shipped compact table; fall back to empty."""
        here = os.path.dirname(os.path.abspath(__file__))
        for name in ('forbidden_moves.json',
                     os.path.join('data', 'forbidden_moves.json')):
            p = os.path.join(here, name)
            if os.path.exists(p):
                return cls.from_compact_json(p)
        return cls()
