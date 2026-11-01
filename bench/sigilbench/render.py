"""Human-readable rendering of a Sigil position (SFN) for the prompt."""
from .common import REPO  # noqa: F401  (puts the repo root on sys.path)
from notation import NODE_ORDER, ADJACENCY, POSITIONS

MANA = ('a1', 'b1', 'c1')
SIZE_NAME = {5: '5-node', 3: '3-node', 1: '1-node'}
COLOR = {'r': 'Red', 'b': 'Blue'}


def parse_sfn(sfn):
    t = sfn.split()
    stones_s, spells_s = t[0].split('/')
    d = {
        'stones': dict(zip(NODE_ORDER, stones_s)),
        'spells': spells_s.split(','),
        'to_move': t[1],
        'turn': int(t[2]),
        'counters': [int(x) for x in t[3].split(':')],
        'locks': t[4].split(':'),
        'springlocks': t[5].split(':'),
        'score_token': t[6] if len(t) > 6 else '',
        'variant': 'standard',
        'bank': [0, 0],
    }
    for tok in t[7:]:
        if tok.startswith('pm:'):
            _, r, b = tok.split(':')
            d['bank'] = [int(r), int(b)]
        elif ':' not in tok:
            d['variant'] = tok
    return d


def _occ(ch):
    return {'r': 'Red', 'b': 'Blue', '.': 'empty', 'x': 'WALL (destroyed node)'}[ch]


def spells_in_play(sfn):
    return parse_sfn(sfn)['spells']


def render(sfn):
    d = parse_sfn(sfn)
    st = d['stones']
    nr = sum(1 for c in st.values() if c == 'r')
    nb = sum(1 for c in st.values() if c == 'b')
    red_total = nr + d['bank'][0]
    blue_total = nb + d['bank'][1] + 1
    lead = red_total - blue_total
    lead_s = 'tied' if lead == 0 else (f'Red leads by {lead}' if lead > 0 else f'Blue leads by {-lead}')
    mover = COLOR[d['to_move']]
    lines = []
    lines.append(f"Position (SFN): {sfn}")
    lines.append(f"Side to move: {mover} (turn {d['turn']}). Variant: {d['variant']}.")
    lines.append(f"Stones on the board: Red {nr}, Blue {nb}. Providence banks: Red {d['bank'][0]}, Blue {d['bank'][1]}.")
    lines.append(f"Stone totals for scoring: Red {red_total}, Blue {blue_total} (Blue's includes the score-keeping stone): {lead_s}.")
    lines.append(f"3-node/5-node spells cast so far: Red {d['counters'][0]}, Blue {d['counters'][1]}.")
    lk = lambda s: '-' if s == '-' else s.replace('_', ' ')
    lines.append(f"Locks: Red {lk(d['locks'][0])}, Blue {lk(d['locks'][1])}. "
                 f"Springlocks: Red {lk(d['springlocks'][0])}, Blue {lk(d['springlocks'][1])}.")
    mana = ', '.join(f"{n} {_occ(st[n])}" for n in MANA)
    lines.append(f"Mana nodes: {mana}. Red controls {sum(st[n]=='r' for n in MANA)}, Blue controls {sum(st[n]=='b' for n in MANA)}.")
    lines.append('')
    lines.append('Spells (position: name, size, nodes):')
    for p in range(1, 10):
        nodes = POSITIONS[p]
        name = d['spells'][p - 1]
        occ = ' '.join(f"{n}={st[n].upper() if st[n] in 'rb' else st[n]}" for n in nodes)
        filled = ''
        if all(st[n] == 'r' for n in nodes):
            filled = ' -- completely filled by Red'
        elif all(st[n] == 'b' for n in nodes):
            filled = ' -- completely filled by Blue'
        lines.append(f"  {p}. {name.replace('_', ' ')} ({SIZE_NAME[len(nodes)]}): {occ}{filled}")
    lines.append('')
    lines.append('Board (R = Red, B = Blue, . = empty, x = wall):')
    for arm in 'abc':
        row = ' '.join(f"{arm}{i}={st[f'{arm}{i}'].upper() if st[f'{arm}{i}'] in 'rb' else st[f'{arm}{i}']}"
                       for i in range(1, 14))
        lines.append('  ' + row)
    return '\n'.join(lines)


def adjacency_text():
    return '\n'.join(f"  {n}: {', '.join(ADJACENCY[n])}" for n in NODE_ORDER)
