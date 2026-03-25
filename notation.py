"""
Sigil game notation formats:
- SFN (Sigil FEN Notation): compact board state serialization
- SGN (Sigil Game Notation): game transcripts

Usage:
    from notation import board_to_sfn, sfn_to_dict, GameRecorder
"""

from datetime import date

# Canonical node order for SFN strings (39 nodes)
NODE_ORDER = [f"{zone}{num}" for zone in "abc" for num in range(1, 14)]

# Spell position mapping: position_index -> [node_names]
POSITIONS = {
    1: ['a2', 'a3', 'a4', 'a5', 'a6'],
    2: ['b2', 'b3', 'b4', 'b5', 'b6'],
    3: ['c2', 'c3', 'c4', 'c5', 'c6'],
    4: ['a8', 'a9', 'a10'],
    5: ['b8', 'b9', 'b10'],
    6: ['c8', 'c9', 'c10'],
    7: ['a7'],
    8: ['b7'],
    9: ['c7'],
}

ADJACENCY = {
    'a1': ['a2', 'a11'], 'a2': ['a1', 'a3', 'a6'], 'a3': ['a2', 'a4', 'a13'],
    'a4': ['a3', 'a5', 'a7'], 'a5': ['a4', 'a6', 'a12'], 'a6': ['a2', 'a5', 'a11'],
    'a7': ['a4', 'a8', 'b12'], 'a8': ['a7', 'a9', 'a10'], 'a9': ['a8', 'a10', 'a13'],
    'a10': ['a8', 'a9', 'b11'], 'a11': ['a1', 'a6', 'c10'], 'a12': ['a5', 'c7'],
    'a13': ['a3', 'a9'],
    'b1': ['b2', 'b11'], 'b2': ['b1', 'b3', 'b6'], 'b3': ['b2', 'b4', 'b13'],
    'b4': ['b3', 'b5', 'b7'], 'b5': ['b4', 'b6', 'b12'], 'b6': ['b2', 'b5', 'b11'],
    'b7': ['b4', 'b8', 'c12'], 'b8': ['b7', 'b9', 'b10'], 'b9': ['b8', 'b10', 'b13'],
    'b10': ['b8', 'b9', 'c11'], 'b11': ['a10', 'b1', 'b6'], 'b12': ['a7', 'b5'],
    'b13': ['b3', 'b9'],
    'c1': ['c2', 'c11'], 'c2': ['c1', 'c3', 'c6'], 'c3': ['c2', 'c4', 'c13'],
    'c4': ['c3', 'c5', 'c7'], 'c5': ['c4', 'c6', 'c12'], 'c6': ['c2', 'c5', 'c11'],
    'c7': ['a12', 'c4', 'c8'], 'c8': ['c7', 'c9', 'c10'], 'c9': ['c8', 'c10', 'c13'],
    'c10': ['a11', 'c8', 'c9'], 'c11': ['b10', 'c1', 'c6'], 'c12': ['b7', 'c5'],
    'c13': ['c3', 'c9'],
}


def _stone_char(stone):
    if stone == 'red':
        return 'r'
    elif stone == 'blue':
        return 'b'
    return '.'


def _char_to_stone(ch):
    if ch == 'r':
        return 'red'
    elif ch == 'b':
        return 'blue'
    return None


def board_to_sfn(board):
    """Serialize a Board or SPBoard to an SFN string.

    Format: <stones>/<spells> <turn> <turncount> <rsc>:<bsc> <rlock>:<block> <rspring>:<bspring> <score>
    """
    stones = ''.join(_stone_char(board.nodes[n].stone) for n in NODE_ORDER)

    spell_names = [board.spells[i].name for i in range(9)]
    spells_str = ','.join(spell_names)

    turn = 'r' if board.whoseturn == 'red' else 'b'
    tc = board.turncounter

    rsc = board.redplayer.spellcounter
    bsc = board.blueplayer.spellcounter

    rlock = board.redplayer.lock.name if board.redplayer.lock else '-'
    block = board.blueplayer.lock.name if board.blueplayer.lock else '-'

    rspring = board.redplayer.springlock.name if board.redplayer.springlock else '-'
    bspring = board.blueplayer.springlock.name if board.blueplayer.springlock else '-'

    score = board.score or 'b1'

    return f"{stones}/{spells_str} {turn} {tc} {rsc}:{bsc} {rlock}:{block} {rspring}:{bspring} {score}"


def sfn_to_dict(sfn_str):
    """Parse an SFN string into a dictionary of game state values.

    Returns dict with keys: stones (dict), spell_names (list of 9),
    turn, turncounter, red_spellcounter, blue_spellcounter,
    red_lock, blue_lock, red_springlock, blue_springlock, score.
    """
    parts = sfn_str.split(' ')
    stones_spells = parts[0]
    stones_str, spells_str = stones_spells.split('/')

    stones = {}
    for i, node_name in enumerate(NODE_ORDER):
        stones[node_name] = _char_to_stone(stones_str[i])

    spell_names = spells_str.split(',')
    turn = 'red' if parts[1] == 'r' else 'blue'
    turncounter = int(parts[2])

    sc_parts = parts[3].split(':')
    red_sc = int(sc_parts[0])
    blue_sc = int(sc_parts[1])

    lock_parts = parts[4].split(':')
    red_lock = None if lock_parts[0] == '-' else lock_parts[0]
    blue_lock = None if lock_parts[1] == '-' else lock_parts[1]

    spring_parts = parts[5].split(':')
    red_spring = None if spring_parts[0] == '-' else spring_parts[0]
    blue_spring = None if spring_parts[1] == '-' else spring_parts[1]

    score = parts[6]

    return {
        'stones': stones,
        'spell_names': spell_names,
        'turn': turn,
        'turncounter': turncounter,
        'red_spellcounter': red_sc,
        'blue_spellcounter': blue_sc,
        'red_lock': red_lock,
        'blue_lock': blue_lock,
        'red_springlock': red_spring,
        'blue_springlock': blue_spring,
        'score': score,
    }


class GameRecorder:
    """Records game actions and produces SGN transcripts.

    Attach to a board at game start. Call record() from game logic
    at each action. Call to_sgn() after the game ends.
    """

    def __init__(self, spell_names, red_name='Red', blue_name='Blue'):
        self.spell_names = spell_names
        self.red_name = red_name
        self.blue_name = blue_name
        self.result = None
        self.turns = []       # list of (color, turn_number, [action_strings])
        self._current_turn = None
        self._current_color = None
        self._current_num = None

    def start_turn(self, color, turn_number):
        """Call at the beginning of each player's turn."""
        if self._current_turn is not None:
            self._end_current_turn()
        self._current_color = color
        self._current_num = turn_number
        self._current_turn = []

    def _end_current_turn(self):
        if self._current_turn is not None:
            self._current_turn.append('P')
            self.turns.append((self._current_color, self._current_num, self._current_turn))
            self._current_turn = None

    def record(self, action_type, **kwargs):
        """Record a single action within the current turn.

        Action types and expected kwargs:
            'move': node=<target_node>
            'hard_move': node=<target_node>, pushed_to=<dest_node_or_'X'>
            'blink': node=<target_node>
            'dash': sacrificed=[node1, node2], dest=<move_target>
            'dash_lightning': sacrificed=[node1], dest=<move_target>
            'cast': spell=<name>, kept=[node1, ...]  (kept nodes after refill, optional)
            'pass': (no kwargs needed, added automatically)
        """
        if self._current_turn is None:
            return

        if action_type == 'move':
            self._current_turn.append(f"M:{kwargs['node']}")
        elif action_type == 'hard_move':
            pushed_to = kwargs.get('pushed_to', 'X')
            self._current_turn.append(f"H:{kwargs['node']}>{pushed_to}")
        elif action_type == 'blink':
            self._current_turn.append(f"B:{kwargs['node']}")
        elif action_type == 'dash':
            sac = ','.join(kwargs['sacrificed'])
            self._current_turn.append(f"D:{sac}:{kwargs['dest']}")
        elif action_type == 'dash_lightning':
            sac = ','.join(kwargs['sacrificed'])
            self._current_turn.append(f"DL:{sac}:{kwargs['dest']}")
        elif action_type == 'cast':
            spell = kwargs['spell']
            kept = kwargs.get('kept', [])
            if kept:
                kept_str = ','.join(kept)
                self._current_turn.append(f"C:{spell}[{kept_str}]")
            else:
                self._current_turn.append(f"C:{spell}")

    def end_game(self, winner):
        """Call when the game ends."""
        self._end_current_turn()
        self.result = winner

    def to_sgn(self):
        """Produce the full SGN transcript string."""
        self._end_current_turn()

        lines = []
        lines.append(f'[Date "{date.today().isoformat()}"]')
        lines.append(f'[Red "{self.red_name}"]')
        lines.append(f'[Blue "{self.blue_name}"]')
        result_str = self.result if self.result else '*'
        lines.append(f'[Result "{result_str}"]')
        lines.append(f'[Spells "{",".join(self.spell_names)}"]')
        lines.append('')

        for color, num, actions in self.turns:
            prefix = f"R{num}" if color == 'red' else f"B{num}"
            actions_str = ' '.join(actions)
            lines.append(f"{prefix}. {actions_str}")

        lines.append('')
        return '\n'.join(lines)


def parse_sgn(sgn_str):
    """Parse an SGN string into structured data.

    Returns dict with keys: date, red, blue, result, spell_names, turns.
    turns is a list of (color, turn_number, [action_strings]).
    """
    headers = {}
    turns = []

    for line in sgn_str.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('['):
            key = line[1:line.index(' ')]
            value = line[line.index('"') + 1:line.rindex('"')]
            headers[key] = value
        elif line[0] in ('R', 'B') and '.' in line[:6]:
            dot_idx = line.index('.')
            prefix = line[:dot_idx]
            color = 'red' if prefix[0] == 'R' else 'blue'
            num = int(prefix[1:])
            actions = line[dot_idx + 2:].split(' ')
            turns.append((color, num, actions))

    spell_names = headers.get('Spells', '').split(',')

    return {
        'date': headers.get('Date'),
        'red': headers.get('Red'),
        'blue': headers.get('Blue'),
        'result': headers.get('Result'),
        'spell_names': spell_names,
        'turns': turns,
    }
