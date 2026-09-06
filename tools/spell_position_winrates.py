"""Three win-rate views per spell (Robi's request, 2026-09-06):
 (a) win rate of the side that CAST the spell (conditional on casting);
 (b) win rate of the side that STARTS CLOSER to the spell once both players have
     their first stone down (standard: the fixed a1/b1 setup; competitive: after turn 2);
 (c) win rate of the side with MORE STONES in the spell after blue's 5th turn (turn 10).
usage: python3 tools/spell_position_winrates.py <dir with completed_games_live.json + hydrated.json>
"""
import json, re, sys, os
from collections import deque, defaultdict
S = sys.argv[1]
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(S, 'completed_games_live.json')))
H = json.load(open(os.path.join(S, 'hydrated.json')))
src = open(os.path.join(REPO, 'docs/static/scripts/engine/constants.js')).read()
adj_txt = src.split('const ADJACENCY = {', 1)[1].split('};', 1)[0]
ADJ = {m.group(1): re.findall(r"'([abc]\d+)'", m.group(2)) for m in re.finditer(r"(\w+): \[([^\]]*)\]", adj_txt)}
NODE_ORDER = [z + str(n) for z in 'abc' for n in range(1, 14)]
IDX = {n: i for i, n in enumerate(NODE_ORDER)}
POS = {1: ['a2','a3','a4','a5','a6'], 2: ['b2','b3','b4','b5','b6'], 3: ['c2','c3','c4','c5','c6'],
       4: ['a8','a9','a10'], 5: ['b8','b9','b10'], 6: ['c8','c9','c10'], 7: ['a7'], 8: ['b7'], 9: ['c7']}
OFFICIAL = ("Flourish Carnage Bewitch Starfall Seal_of_Lightning Grow Fireblast Hail_Storm Meteor Seal_of_Wind Sprout Slash Surge Comet Seal_of_Summer "
            "Blossom Scatter Seal_of_Spring Syzygy Eclipse Azimuth Erupt Fury Charge Hurricane Storm_Front Gust Tsunami Torrent Splash Harvest Gather "
            "Seal_of_Autumn Corrupt Decay Lurk Seal_of_Destruction Seal_of_Stone Seal_of_Winter").split()
RENAME = {'Flood': 'Tsunami'}
def dist_from(nodes):
    """BFS distance from a set of nodes to every node."""
    dist = {n: 0 for n in nodes}; q = deque(nodes)
    while q:
        u = q.popleft()
        for w in ADJ[u]:
            if w not in dist: dist[w] = dist[u] + 1; q.append(w)
    return dist
def stones(sfn, color):
    b = sfn.split('/', 1)[0]; return [NODE_ORDER[i] for i, ch in enumerate(b) if ch == color]
acc = {s: {'cast': [0, 0], 'closer': [0, 0], 'closer_std': [0, 0], 'closer_comp': [0, 0], 'more10': [0, 0]} for s in OFFICIAL}  # [wins, n]
def tally(bucket, s, side_color, winner):
    if s not in acc: return
    acc[s][bucket][1] += 1; acc[s][bucket][0] += (winner == side_color)
for k, v in d.items():
    if v.get('winner') not in ('red', 'blue'): continue
    win = v['winner']; spells = [RENAME.get(x, x) for x in v['spellNames']]
    var = str(v.get('variant') or 'standard')
    # (a) casts from transcript actions
    casters = defaultdict(set)
    for t in v.get('turns') or []:
        if isinstance(t, dict):
            for a in t.get('actions', []) or []:
                if isinstance(a, dict) and a.get('type') == 'cast' and a.get('spell'): casters[RENAME.get(a['spell'], a['spell'])].add(t['color'])
    for s in spells:
        for c in casters.get(s, ()): tally('cast', s, c, win)
    h = H.get(k)
    if not (h and h.get('ok')): continue
    turns = h['turns']
    # (b) starting proximity
    if var.startswith('competitive'):
        pos = turns[1]['sfnAfter'] if len(turns) >= 2 else None
    else:
        pos = v.get('setupSfn')
    if pos:
        r, b = stones(pos, 'r'), stones(pos, 'b')
        if r and b:
            dr, db = dist_from(r), dist_from(b)
            for i, s in enumerate(spells):
                nodes = POS[i + 1]
                mr, mb = min(dr.get(n, 99) for n in nodes), min(db.get(n, 99) for n in nodes)
                sub = 'closer_comp' if var.startswith('competitive') else 'closer_std'
                if mr < mb: tally('closer', s, 'red', win); tally(sub, s, 'red', win)
                elif mb < mr: tally('closer', s, 'blue', win); tally(sub, s, 'blue', win)
    # (c) occupancy after blue's 5th turn (turnNumber 10)
    t10 = next((t for t in turns if t.get('turnNumber') == 10), None)
    if t10 and t10.get('sfnAfter'):
        board = t10['sfnAfter'].split('/', 1)[0]
        for i, s in enumerate(spells):
            cr = sum(board[IDX[n]] == 'r' for n in POS[i + 1]); cb = sum(board[IDX[n]] == 'b' for n in POS[i + 1])
            if cr > cb: tally('more10', s, 'red', win)
            elif cb > cr: tally('more10', s, 'blue', win)
def wr(x): return x[0] / x[1] if x[1] else float('nan')
out = {s: {b: {'wr': wr(acc[s][b]), 'n': acc[s][b][1]} for b in acc[s]} for s in OFFICIAL}
json.dump(out, open(os.path.join(REPO, 'tools', 'spell_position_winrates.json'), 'w'), indent=1)
for b, title in (('cast', '(a) side that cast it'), ('closer', '(b) side starting closer'), ('closer_std', '(b-std) standard games only: closer under the RANDOM layout'), ('closer_comp', '(b-comp) competitive games only: closer after each side chose its first stone'), ('more10', '(c) side with more stones in it after turn 10')):
    print(f"\n== {title} ==")
    for s in sorted(OFFICIAL, key=lambda s: -(out[s][b]['wr'] if out[s][b]['n'] else -1)):
        print(f"  {s:20s} {100*out[s][b]['wr']:5.1f}%  n={out[s][b]['n']}")
