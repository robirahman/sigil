"""Head-to-head: the Rust engine vs the DEPLOYED JS Caveman.

Every arena before this one pitted the Rust engine against ITSELF with different
settings, which can rank our own configs but cannot say whether any of it is
stronger than what ships. This plays the two engines directly.

Design: positions cross the boundary as explicit state (39-char stone string plus
counters and locks) and EACH ENGINE APPLIES ITS OWN MOVES, so no turn/action
representation has to be translated. The Rust side reconstructs an SFN from that
state, which is safe because SFN round-trip and derived state are verified against
simboard.py over all 4,202 corpus positions.
"""
import json, os, subprocess, sys, statistics, itertools
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
from ai.config import SPELL_TO_ID
import sigil_engine as se

ID2S = {i: s for s, i in SPELL_TO_ID.items()}
ENGINE_DIR = os.path.join(os.environ['SCRATCH'], 'ref', 'docs', 'static', 'scripts', 'engine')
SERVER = os.path.join(os.environ['SCRATCH'], 'bridge', 'caveman_server.js')

class Caveman:
    def __init__(self):
        self.p = subprocess.Popen(['node', SERVER, ENGINE_DIR],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, bufsize=1)
    def rpc(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n"); self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line: raise RuntimeError("caveman server died")
        d = json.loads(line)
        if 'error' in d: raise RuntimeError("caveman: " + d['error'][:200])
        return d
    def close(self):
        try: self.p.stdin.close(); self.p.wait(timeout=5)
        except Exception: self.p.kill()

def state_to_sfn(st, names):
    lk = lambda x: x if x else '-'
    return (f"{st['stones']}/{','.join(names)} {'r' if st['turn']=='red' else 'b'} "
            f"{st['turnCounter']} {st['spellCounter'][0]}:{st['spellCounter'][1]} "
            f"{lk(st['lock'][0])}:{lk(st['lock'][1])} "
            f"{lk(st['springlock'][0])}:{lk(st['springlock'][1])} tied")

def board_to_state(b):
    sfn = b.to_sfn(); toks = sfn.split()
    stones = toks[0].split('/')[0]
    rsc, bsc = toks[3].split(':'); rl, bl = toks[4].split(':'); rs, bs = toks[5].split(':')
    n = lambda x: None if x == '-' else x
    return dict(stones=stones, turn='red' if toks[1]=='r' else 'blue',
                turnCounter=int(toks[2]), spellCounter=[int(rsc), int(bsc)],
                lock=[n(rl), n(bl)], springlock=[n(rs), n(bs)])

# The deployed tiers, verbatim from docs/static/scripts/game-board-local.js:825-853.
# Very Hard is a 60 s pure-stone-count Caveman (default weights are all zeros);
# Positional is a 10 s Caveman plus the capped map-control tiebreaker from the
# 2026-08 campaign (worst case 0.96 stones, i.e. strictly sub-material).
OPPONENTS = {
    'very_hard':  dict(timeLimit=60.0, evalWeights=None),
    'hard':       dict(timeLimit=5.0,  evalWeights=None),
    'medium':     dict(timeLimit=1.0,  evalWeights=None),
    'easy':       dict(timeLimit=0.1,  evalWeights=None),
    'positional': dict(timeLimit=10.0,
                       evalWeights={'mana': 0.0, 'voidPenalty': 0.0, 'mapControl': 0.0246}),
}

def game(seed, rust_color, ms, cav, width_scale=1, eval_name="material",
         max_plies=140, opp='very_hard'):
    draw = se.Board.legal_draw(seed)
    names = [ID2S[i] for i in draw]
    b = se.Board(draw, "standard"); b.setup_initial()
    st = board_to_state(b)
    cav.rpc(dict(cmd='set', spells=names, variant='standard', resetHistory=True, **st))
    hist = []
    rd, cd = [], []
    for ply in range(max_plies):
        side = st['turn']
        if side == rust_color:
            rb = se.Board.from_sfn(state_to_sfn(st, names))
            hist.append(rb.key_js)
            d, nodes, dt, over, w, sc, wd = rb.play_best(ms, 64, 20, 16, width_scale,
                                                         hist, eval_name)
            rd.append(d)
            st = board_to_state(rb)
            if over: return (w, ply+1, rd, cd)
            cav.rpc(dict(cmd='set', spells=names, variant='standard', **st))
        else:
            oc = OPPONENTS[opp]
            r = cav.rpc(dict(cmd='move', timeLimit=oc['timeLimit'],
                             evalWeights=oc['evalWeights']))
            cd.append(r.get('depth', 0))
            st = {k: r[k] for k in ('stones','turn','turnCounter','spellCounter','lock','springlock')}
            if r.get('gameover'): return (r.get('winner'), ply+1, rd, cd)
    return (None, max_plies, rd, cd)

if __name__ == "__main__":
    pairs = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    ms    = int(sys.argv[2]) if len(sys.argv) > 2 else 150   # OUR time budget, ms
    ev    = sys.argv[3] if len(sys.argv) > 3 else "material"
    off   = int(sys.argv[4]) if len(sys.argv) > 4 else 0     # seed offset, for sharding
    opp   = sys.argv[5] if len(sys.argv) > 5 else "very_hard"
    if opp not in OPPONENTS:
        sys.exit(f"unknown opponent {opp!r}; choose from {sorted(OPPONENTS)}")
    cav = Caveman()
    wins = {'rust': 0, 'caveman': 0}; unfinished = 0
    plies = []; rdepth = []; cdepth = []
    try:
        for i in range(pairs):
            for rust_color in ('red', 'blue'):
                w, n, rd, cd = game(9000+off+i, rust_color, ms, cav, eval_name=ev, opp=opp)
                plies.append(n); rdepth += rd; cdepth += cd
                if w is None: unfinished += 1
                elif w == rust_color: wins['rust'] += 1
                else: wins['caveman'] += 1
    finally:
        cav.close()
    tot = wins['rust'] + wins['caveman'] + unfinished
    print(f"SHARD opp={opp} off={off} n={tot} rust={wins['rust']} caveman={wins['caveman']} "
          f"unfinished={unfinished} plies={statistics.mean(plies):.1f} "
          f"rdepth={statistics.mean(rdepth) if rdepth else 0:.2f} "
          f"cdepth={statistics.mean(cdepth) if cdepth else 0:.2f}")
    print(f"Rust({ev}, {ms} ms) vs deployed JS '{opp}' "
          f"({OPPONENTS[opp]['timeLimit']} s"
          f"{', mc=0.0246' if OPPONENTS[opp]['evalWeights'] else ', pure stone-count'})"
          f"   {tot} games, colour-swapped")
    print(f"  rust {wins['rust']}   caveman {wins['caveman']}   unfinished {unfinished}")
    if tot: print(f"  RUST SCORE: {100*wins['rust']/tot:.1f}%")
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if rdepth: print(f"  rust mean completed depth    {statistics.mean(rdepth):.2f}")
    if cdepth: print(f"  caveman mean completed depth {statistics.mean(cdepth):.2f}")
