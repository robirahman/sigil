"""Build the model-facing prompt for one puzzle."""
import json
import os

from .common import CANARY, PROMPT_DIR, load_json
from .render import COLOR, parse_sfn, render

TOOL_NAME = 'submit_answer'
TOOL_DESCRIPTION = (
    'Submit your final answer: ONE complete turn for the side to move, as an ordered list of actions '
    '(the regular placement first, then an optional dash, then optional cast(s) with their resolution '
    'actions), in the action format described in the instructions. Call this exactly once; your first '
    'call is final and cannot be changed.')
TOOL_SCHEMA = {
    'type': 'object',
    'properties': {
        'actions': {
            'type': 'array',
            'description': 'The turn, in order. Each item is an action object such as '
                           '{"type": "hard_move", "node": "a3", "pushed_to": "a13"}.',
            'items': {'type': 'object'},
        },
    },
    'required': ['actions'],
}


def _read(name):
    path = os.path.join(PROMPT_DIR, name)
    with open(path) as f:
        return f.read().strip()


def system_prompt():
    return '\n\n'.join([
        CANARY,
        'You are solving a puzzle from the board game Sigil. The complete rules follow, then the format '
        'for writing a turn. Read them carefully: Sigil is not a well-known game, and every detail '
        'matters.',
        '# Sigil rules\n\n' + _read('rules.md'),
        '# Writing a turn as actions\n\n' + _read('actions.md'),
        '# Your task\n\nEach puzzle gives a position and a number N. Find ONE turn for the side to move '
        'that forces a win: whatever the opponent does, you can win within N of your own turns, counting '
        'the turn you submit (N = 1 means your turn wins the game immediately). A turn that wins faster '
        'than N also counts. There may be several correct turns; any one is enough. Think as long as you '
        f'need, then call the `{TOOL_NAME}` tool exactly once with your turn. Your first call is final. '
        'Do not ask questions; no further information will be given.',
    ])


def spells_section(spells):
    meta = load_json(os.path.join(PROMPT_DIR, 'spells.json'))
    out = []
    for s in spells:
        m = meta.get(s)
        if not m:
            raise KeyError(f'spell {s} missing from bench/prompt/spells.json')
        parts = [f"## {m.get('display', s.replace('_', ' '))} (`{s}`, {m['size']}-node{', static' if m.get('static') else ''})",
                 f"Text: {m['text']}"]
        if m.get('clarifications'):
            parts.append(f"Rules notes: {m['clarifications']}")
        if m.get('actions'):
            parts.append(f"How to write it: {m['actions']}")
        if m.get('example'):
            ex = m['example'] if isinstance(m['example'], str) else json.dumps(m['example'])
            parts.append(f"Example: {ex}")
        if m.get('example_note'):
            parts.append(f"Example note: {m['example_note']}")
        out.append('\n'.join(parts))
    return '\n\n'.join(out)


def user_prompt(puzzle):
    d = parse_sfn(puzzle['sfn'])
    mover = COLOR[d['to_move']]
    n = puzzle['n']
    goal = ('win the game with this turn' if n == 1 else
            f'force a win within {n} of your own turns (this one included), whatever {COLOR["b" if d["to_move"] == "r" else "r"]} replies')
    return '\n\n'.join([
        f"Puzzle {puzzle['id']}: {mover} to move. Find a turn that lets {mover} {goal}. "
        f"(Mate in {n}.)",
        '# Position\n\n' + render(puzzle['sfn']),
        '# The spells on this board\n\n' + spells_section(d['spells']),
        f'Submit your turn with the `{TOOL_NAME}` tool.',
    ])
