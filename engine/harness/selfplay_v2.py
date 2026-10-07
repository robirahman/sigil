"""Step 3 (2026-10 training plan): self-play data with value AND policy targets.

    selfplay_v2.py <games> <depth> <out_dir> [explore_pct=0.10] [random_ply_pct=0.08]
                   [human_frac=0.5] [lines=-] [stop_after_s=0] [explore_k=8]

The shard offset comes from $SIGIL_SHARD_OFF (never argv), so the argument list
composes with `gcp/runner.sh`. Every position of every game is searched at the
FIXED depth `depth` with the SHIPPED config -- `se.SHIPPED_EVAL` and the generator
policy `se.SHIPPED_POLICY` (nnue_spell + policy 96 since engine v25), engine-default
width, `SHIPPED_ADAPTIVE`, engine-default keep window -- so labels do not depend on
the VM's speed and track what the site plays; the searched turn is then played.
(Round 1, 2026-10-06, ran with eval tfit and no policy.)

Per position we record (`load_v2` below reads it back):
  * the position: SFN, spell ids (slot order), `full_features` and
    `hand_features` from the side to move, side, ply, the game's start kind;
  * the depth-D score and nodes, the chosen turn (packed actions);
  * EVERY root candidate the final iteration completed, via
    `PyBoard.root_scores_and_play`: packed actions, `turn_parts`, score, bound
    (0 exact / 1 upper / 2 lower) and its index in the generator's ordered
    stream (`urank`; -1 = reached another way). The root is alpha-beta, so only
    the PV (and anything that raised alpha) is exact; the rest are UPPER
    bounds: "at most this good". Universe turns (the ordered stream drained to
    600, `n_universe`) with no candidate row were NOT searched -- they sit past
    the root width, and that is not evidence that they are bad. (Exact scores
    for every root move cost ~10x the nodes at depth 4, measured; available as
    `exact=True` in the binding, not used here.)
  * at `explore_pct` of positions, up to `explore_k` EXPLORATION turns from
    `PyBoard.explore_unemitted`: turns of the full enumeration whose result the
    ordered stream (drained to 5,000) never produces, drawn round-robin over
    dash-with-sacrifice / cast / other, each scored by a depth D-1 search of its
    resulting position (kind 1 rows, same score scale as the root rows);
  * the eventual winner of the continuation (`y`, from the side to move;
    255 if the game hit the 140-ply cap).

Start positions: `human_frac` of games start from a position of a recorded
human game (`lines`, an eval_games.py `hydrate` file, local path or gs:// URL),
weighted 4:1 towards turn 20 and later, with the game's earlier positions as
repetition history. The rest are fresh draws: a quarter competitive, and half
drawn from all 45 spells the engine plays (core + Tectonic + Providence), half
from the 39 core spells. A share `random_ply_pct` of plies plays a uniformly
random legal turn instead of the searched one (the position is still labelled).

Human games holding Fissure, Rock Slide, Bulwark or a Providence spell are
excluded if played before the rule change went live
(`data_filters.OCT2026_RULE_CHANGE_LIVE`, the 2026-10-07 deploy): those lines
encode the old rules. Later games with them are used. Fresh draws use the
current rules.

Output: one npz per CHUNK_GAMES games, `<out_dir>/v2d<depth>_<off>_<chunk>.npz`, written
atomically (temp + rename), so a shard killed by the watchdog or a Spot
preemption loses at most one chunk, and the runner ships each as it lands.
"""
import json, os, random, subprocess, sys, time, urllib.parse, urllib.request
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset
sys.path.insert(0, os.path.join(_HERE, '..', '..', 'ai'))
from data_filters import OCT2026_RULE_CHANGE_LIVE_MS

SEED_BASE = 20_000_000
CHUNK_GAMES = 10
MAX_PLIES = 140
MAX_ACTS = 8                 # packed actions per turn (longest seen is 5)
UNIVERSE_CAP = 600          # > the widest depth-4 root (432 measured), so every searched root move gets a urank
EVAL = se.SHIPPED_EVAL
POLICY = tuple(se.SHIPPED_POLICY)
AD = tuple(se.SHIPPED_ADAPTIVE)
# Slot pools by role, from spells_meta.rs (RITUALS/SORCERIES/CHARMS are the 39
# core ids; Tectonic and Providence add one spell of each role apiece).
CORE = ([0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36],
        [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37],
        [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38])
NEW_PACKS = ([39, 44], [40, 43], [41, 42])
OLD_RULES = {'Fissure', 'Rock_Slide', 'Bulwark', 'Dividend', 'Annuity', 'Endowment'}
KIND_FRESH_STD, KIND_FRESH_COMP, KIND_HUMAN = 0, 1, 2


def engine_version():
    js = os.path.join(_HERE, '..', '..', 'docs', 'static', 'scripts', 'engine', 'rust-ai.js')
    v = 'unknown'
    try:
        for line in open(js):
            if 'const RUST_ENGINE_VERSION' in line:
                v = line.split('=')[1].strip().rstrip(';')
                break
    except OSError:
        pass
    try:
        c = subprocess.run(['git', '-C', _HERE, 'rev-parse', '--short', 'HEAD'],
                           capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        c = ''
    return f"v{v}+s3{('@' + c) if c else ''}"


def fresh_draw(rng, all45):
    out = []
    for role in range(3):
        pool = CORE[role] + (NEW_PACKS[role] if all45 else [])
        out += rng.sample(pool, 3)
    return out


def _fetch(path):
    if not path.startswith('gs://'):
        return open(path, 'rb').read()
    bucket, name = path[5:].split('/', 1)
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'}), timeout=15))['access_token']
    url = (f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
           f'{urllib.parse.quote(name, safe="")}?alt=media')
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={'Authorization': f'Bearer {tok}'}), timeout=120).read()


def load_starts(path):
    """[(sfns of the game, weights per index)] for the human-start sampler."""
    d = json.loads(_fetch(path))
    games = list(d.values()) if isinstance(d, dict) else d
    starts, skipped = [], 0
    for g in games:
        pos = g.get('positions') or []
        if len(pos) < 8:
            skipped += 1; continue
        names = pos[0].split(' ', 1)[0].split('/', 1)[1].split(',')
        if OLD_RULES & set(names) and (g.get('timestamp') or 0) < OCT2026_RULE_CHANGE_LIVE_MS:
            skipped += 1; continue
        try:
            se.Board.from_sfn(pos[0])
        except Exception:
            skipped += 1; continue
        # the last recorded position may be terminal; never start there
        w = [0 if i < 6 else (4 if i >= 20 else 1) for i in range(len(pos) - 1)]
        starts.append((pos, w))
    return starts, skipped


def pick_human(rng, starts, cum):
    gi = rng.choices(range(len(starts)), cum_weights=cum)[0]
    pos, w = starts[gi]
    i = rng.choices(range(len(w)), weights=w)[0]
    b = se.Board.from_sfn(pos[i])
    if b.gameover:
        return None
    hist = [se.Board.from_sfn(p).key_js for p in pos[:i]]
    return b, hist, i


def pad_packed(p):
    a = np.zeros(MAX_ACTS, dtype=np.uint32)
    a[:min(len(p), MAX_ACTS)] = p[:MAX_ACTS]
    return a, len(p) > MAX_ACTS


class Chunk:
    def __init__(self):
        self.pos = {k: [] for k in (
            'sfn', 'spells', 'full', 'hand', 'is_red', 'ply', 'game', 'kind', 'start_ply',
            'score', 'nodes', 'depth', 'chosen', 'n_universe', 'universe_trunc',
            'random_played', 'cand_off', 'n_cand', 'x_enum', 'x_stream', 'x_missing',
            'x_suicide', 'x_trunc', 'y')}
        self.cand = {k: [] for k in ('packed', 'parts', 'score', 'bound', 'nodes',
                                     'urank', 'kind', 'xclass')}
        self.overlong = 0

    def __len__(self):
        return len(self.pos['sfn'])

    def add_cand(self, packed, parts, score, bound, nodes, urank, kind, xclass):
        p, over = pad_packed(packed)
        self.overlong += over
        c = self.cand
        c['packed'].append(p); c['parts'].append(parts); c['score'].append(score)
        c['bound'].append(bound); c['nodes'].append(min(nodes, 2**32 - 1))
        c['urank'].append(urank); c['kind'].append(kind); c['xclass'].append(xclass)

    def write(self, path, meta):
        P, C = self.pos, self.cand
        tmp = path + '.tmp.npz'
        np.savez_compressed(
            tmp,
            sfn=np.asarray(P['sfn']), spells=np.asarray(P['spells'], np.uint8),
            full=np.asarray(P['full'], np.float32), hand=np.asarray(P['hand'], np.int32),
            is_red=np.asarray(P['is_red'], np.uint8), ply=np.asarray(P['ply'], np.int16),
            game=np.asarray(P['game'], np.int64), kind=np.asarray(P['kind'], np.uint8),
            start_ply=np.asarray(P['start_ply'], np.int16),
            score=np.asarray(P['score'], np.int32), nodes=np.asarray(P['nodes'], np.int64),
            depth=np.asarray(P['depth'], np.int8),
            chosen=np.asarray(P['chosen'], np.uint32).reshape(-1, MAX_ACTS),
            n_universe=np.asarray(P['n_universe'], np.int16),
            universe_trunc=np.asarray(P['universe_trunc'], np.uint8),
            random_played=np.asarray(P['random_played'], np.uint8),
            cand_off=np.asarray(P['cand_off'], np.int64), n_cand=np.asarray(P['n_cand'], np.int32),
            x_enum=np.asarray(P['x_enum'], np.int32), x_stream=np.asarray(P['x_stream'], np.int32),
            x_missing=np.asarray(P['x_missing'], np.int32),
            x_suicide=np.asarray(P['x_suicide'], np.int32),
            x_trunc=np.asarray(P['x_trunc'], np.int8), y=np.asarray(P['y'], np.uint8),
            c_packed=np.asarray(C['packed'], np.uint32).reshape(-1, MAX_ACTS),
            c_parts=np.asarray(C['parts'], np.uint16).reshape(-1, se.PRIOR_MAX_PARTS),
            c_score=np.asarray(C['score'], np.int32), c_bound=np.asarray(C['bound'], np.uint8),
            c_nodes=np.asarray(C['nodes'], np.uint32), c_urank=np.asarray(C['urank'], np.int16),
            c_kind=np.asarray(C['kind'], np.uint8), c_xclass=np.asarray(C['xclass'], np.uint8),
            meta=np.asarray(json.dumps(meta)))
        os.replace(tmp, path)


def play_game(seed, depth, rng, explore_pct, explore_k, random_pct, start, ch):
    """Play one game into `ch`; returns (plies, winner)."""
    b, hist, kind, start_ply = start
    first = len(ch)
    for k in range(MAX_PLIES):
        ply = start_ply + k
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        hist.append(b.key_js)
        full = b.full_features(side); hand = b.hand_features(side)
        spells = b.spell_ids()
        xs = (-1, -1, -1, -1, -1)
        xrows = []
        if rng.random() < explore_pct:
            picks, ne, ns, nm, nsu, tr = b.explore_unemitted(
                depth, explore_k, seed * 1000 + ply, 20000, 5000, EVAL, hist)
            xs = (ne, ns, nm, nsu, int(tr))
            xrows = picks
        rand = rng.random() < random_pct
        sfn, sc, nodes, dc, chosen, cands, nu, utr = b.root_scores_and_play(
            depth, EVAL, False, UNIVERSE_CAP, hist, not rand)
        P = ch.pos
        P['cand_off'].append(len(ch.cand['score']))
        for packed, parts, v, bound, n, ur in cands:
            ch.add_cand(packed, parts, v, bound, n, ur, 0, 255)
        for packed, parts, v, n, cl in xrows:
            ch.add_cand(packed, parts, v, 0, n, -1, 1, cl)
        P['n_cand'].append(len(cands) + len(xrows))
        P['sfn'].append(sfn); P['spells'].append(spells); P['full'].append(full)
        P['hand'].append(hand); P['is_red'].append(side == 'red'); P['ply'].append(ply)
        P['game'].append(seed); P['kind'].append(kind); P['start_ply'].append(start_ply)
        P['score'].append(sc); P['nodes'].append(nodes); P['depth'].append(dc)
        P['chosen'].append(pad_packed(chosen)[0]); P['n_universe'].append(nu)
        P['universe_trunc'].append(int(utr)); P['random_played'].append(int(rand))
        for key, v in zip(('x_enum', 'x_stream', 'x_missing', 'x_suicide', 'x_trunc'), xs):
            P[key].append(v)
        P['y'].append(255)
        if rand:
            turns = b.enumerate_turns()
            if turns:
                b.apply_turn_tuples(turns[rng.randrange(len(turns))], side)
            if not b.gameover:
                b.advance_turn()
        if b.gameover or (not chosen and not rand):
            break
    w = b.winner
    if w in ('red', 'blue'):
        for i in range(first, len(ch)):
            ch.pos['y'][i] = 1 if (w == 'red') == bool(ch.pos['is_red'][i]) else 0
    return k + 1, w


def main():
    a = sys.argv[1:]
    games = int(a[0]); depth = int(a[1]); out_dir = a[2]
    explore_pct = float(a[3]) if len(a) > 3 else 0.10
    random_pct = float(a[4]) if len(a) > 4 else 0.08
    human_frac = float(a[5]) if len(a) > 5 else 0.5
    lines = a[6] if len(a) > 6 and a[6] != '-' else None
    stop_after = float(a[7]) if len(a) > 7 else 0.0
    explore_k = int(a[8]) if len(a) > 8 else 8
    off = shard_offset()
    # Thread-local and off by default in Python: set it explicitly, every run.
    se.set_policy(*POLICY)
    assert games <= 1000, "seeds are SEED_BASE + off + i with off stepping by 1000"
    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(SEED_BASE + off)
    starts, cum = [], []
    if lines and human_frac > 0:
        starts, skipped = load_starts(lines)
        tot = 0
        for _pos, w in starts:
            tot += sum(w); cum.append(tot)
        print(f"  human starts: {len(starts)} games usable, {skipped} skipped", flush=True)
    if not starts:
        human_frac = 0.0
    meta = dict(engine=engine_version(), depth=depth, eval=EVAL, policy=list(POLICY), adaptive=list(AD),
                width_scale=int(se.DEFAULT_WIDTH_SCALE), universe_cap=UNIVERSE_CAP,
                explore_pct=explore_pct, explore_k=explore_k, random_pct=random_pct,
                human_frac=human_frac, lines=lines, shard_off=off)
    print(f"  CONFIG {json.dumps(meta)}", flush=True)
    t0 = time.time()
    ch = Chunk(); chunk_i = 0; npos = ncand = nx = 0; kinds = [0, 0, 0]; unfinished = 0
    for g in range(games):
        if stop_after and time.time() - t0 > stop_after:
            print(f"  stop_after {stop_after:.0f}s reached", flush=True)
            break
        seed = SEED_BASE + off + g
        grng = random.Random(seed)
        start = None
        if rng.random() < human_frac:
            r = pick_human(grng, starts, cum)
            if r:
                b, hist, i = r
                start = (b, hist, KIND_HUMAN, i)
        if start is None:
            comp = grng.random() < 0.25
            b = se.Board(fresh_draw(grng, grng.random() < 0.5),
                         'competitive' if comp else 'standard')
            b.setup_initial()
            start = (b, [], KIND_FRESH_COMP if comp else KIND_FRESH_STD, 0)
        kinds[start[2]] += 1
        plies, w = play_game(seed, depth, grng, explore_pct, explore_k, random_pct, start, ch)
        unfinished += w not in ('red', 'blue')
        if (g + 1) % CHUNK_GAMES == 0:
            npos += len(ch); ncand += len(ch.cand['score'])
            nx += sum(ch.cand['kind'])
            ch.write(os.path.join(out_dir, f"v2d{depth}_{off}_{chunk_i:04d}.npz"), meta)
            chunk_i += 1; ch = Chunk()
            el = time.time() - t0
            print(f"  game {g+1}: {npos} positions, {ncand} cands ({nx} exploration), "
                  f"{el:.0f}s, {npos / el * 3600:.0f} pos/h", flush=True)
    if len(ch):
        npos += len(ch); ncand += len(ch.cand['score']); nx += sum(ch.cand['kind'])
        ch.write(os.path.join(out_dir, f"v2d{depth}_{off}_{chunk_i:04d}.npz"), meta)
    el = time.time() - t0
    print(f"WROTE {out_dir}/v2d{depth}_{off}_*.npz: {npos} positions, {ncand} candidates "
          f"({nx} exploration), games fresh/comp/human {kinds}, {unfinished} unfinished, "
          f"{el:.0f}s, {npos / max(el, 1e-9) * 3600:.0f} pos/h", flush=True)


def load_v2(paths):
    """Concatenate v2 chunks. Returns (positions dict, candidates dict, metas);
    candidate rows of position i are cand[cand_off[i] : cand_off[i] + n_cand[i]]
    with offsets rebased onto the concatenation."""
    pos, cand, metas = {}, {}, []
    base = 0
    for p in paths:
        z = np.load(p)
        metas.append(json.loads(str(z['meta'])))
        for k in z.files:
            if k == 'meta':
                continue
            v = z[k]
            if k == 'cand_off':
                v = v + base
            (cand if k.startswith('c_') else pos).setdefault(k, []).append(v)
        base += len(z['c_score'])
    pos = {k: np.concatenate(v) for k, v in pos.items()}
    cand = {k[2:]: np.concatenate(v) for k, v in cand.items()}
    return pos, cand, metas


if __name__ == '__main__':
    main()
