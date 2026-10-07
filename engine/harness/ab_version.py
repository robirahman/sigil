"""Engine VERSION A/B: this checkout's engine vs another build, shipped config.

    ab_version.py <pairs> <ms>

The arm is `sigil_engine` as imported normally (this checkout). The base is a
second build of the extension module loaded from $SIGIL_BASE_MODULE (a
`libsigil_engine.so` built from the base commit; runner.sh builds it when the
VM's `base-commit` metadata is set). Both play their OWN shipped
config (`PyBoard.play_best` with the module's SHIPPED_EVAL and SHIPPED_POLICY when
it exports them -- v25+ -- else eval tfit, policy off; engine-default width_scale,
SHIPPED_ADAPTIVE), colour-swapped over legal draws (ab_search.draw_for, so
$SIGIL_REQUIRE_SPELL selects expansion draws). This makes it a RELEASE A/B.

The two engines never share a Board object: the game is carried as an SFN, and
each move is searched on that engine's own `Board.from_sfn`. Repetition history
is each engine's own `key_js` of every earlier position.

The shard's seed offset comes from $SIGIL_SHARD_OFF.
"""
import importlib.machinery
import importlib.util
import os
import statistics
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as arm_se
from sprt import Sprt, shard_offset


def load_base(path):
    """Load a second copy of the extension from `path`. PyO3 resolves the init
    symbol from the module NAME, so it must stay `sigil_engine`; the copy is
    simply not registered in sys.modules."""
    loader = importlib.machinery.ExtensionFileLoader('sigil_engine', path)
    spec = importlib.util.spec_from_file_location('sigil_engine', path, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


base_se = load_base(os.environ['SIGIL_BASE_MODULE'])
TT_BITS = 20
from ab_search import draw_for, REQUIRE_SPELL   # noqa: E402  (draws honour $SIGIL_REQUIRE_SPELL)


def shipped_eval(se):
    return getattr(se, 'SHIPPED_EVAL', 'tfit')


def apply_shipped_policy(se):
    # Thread-local in each module's own statics; set before every search.
    if hasattr(se, 'SHIPPED_POLICY') and hasattr(se, 'set_policy'):
        se.set_policy(*se.SHIPPED_POLICY)


def adaptive(se):
    return tuple(se.SHIPPED_ADAPTIVE) if hasattr(se, 'SHIPPED_ADAPTIVE') else (0.10, 2, 6)


def game(seed, arm_color, ms, max_plies=140):
    b = arm_se.Board(draw_for(seed), "standard")
    b.setup_initial()
    sfn = b.to_sfn()
    history = []                 # SFNs of every position so far
    dep = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if sfn.split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        se = arm_se if is_arm else base_se
        history.append(sfn)
        hist = [se.Board.from_sfn(h).key_js for h in history]
        bd = se.Board.from_sfn(sfn)
        apply_shipped_policy(se)
        r = bd.play_best(ms, 64, TT_BITS, 16, None, hist, shipped_eval(se), False,
                         adaptive=adaptive(se))
        dep['arm' if is_arm else 'base'].append(r[0])
        sfn = bd.to_sfn()
        if r[3]:
            return r[4], ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2])
    off = shard_offset()
    print(f"  VERSION A/B  arm={arm_se.__file__}  base={base_se.__file__}  ms={ms}  "
          f"arm_eval={shipped_eval(arm_se)} arm_policy={getattr(arm_se, 'SHIPPED_POLICY', None)}  "
          f"base_eval={shipped_eval(base_se)} base_policy={getattr(base_se, 'SHIPPED_POLICY', None)}  "
          f"require_spell={REQUIRE_SPELL}", flush=True)
    print(f"  SEEDS  {6_000_000+off}..{6_000_000+off+pairs-1} (shard offset {off})", flush=True)
    s = Sprt(elo0=-25.0, elo1=0.0)
    plies = []; dep = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d = game(6_000_000 + off + i, arm, ms)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={6_000_000+off+i} arm={arm} winner={w} plies={n} "
                  f"draw={','.join(map(str, draw_for(6_000_000 + off + i)))}", flush=True)
    print(f"SHARD arm=new base=old ms={ms} off={off} n={s.n} "
          f"armwins={s.wins} basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"new vs old @{ms}ms"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
