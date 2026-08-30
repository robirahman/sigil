"""Play real games with the engine and measure completed depth per move, the way
the committed JS arena runs measured it (1,846 nodes/s, mean completed depth 3.65
at 10 s/move). Random independent stone placement is NOT a valid benchmark: 52% of
such positions are already decided, because red needs a real lead of 4 and blue
only 2."""
import sys, os, random, statistics, time
sys.path.insert(0, os.path.join(os.environ['SCRATCH'],'ref'))
import sigil_engine as se

def play(seed, time_ms, width_scale=1, max_plies=200, variant="standard"):
    b = se.Board(se.Board.legal_draw(seed), variant)
    b.setup_initial()
    hist = []
    depths=[]; nodes=0; plies=0; widened=0
    while plies < max_plies:
        hist.append(b.key_js)
        d, n, dt, over, w, sc, wd = b.play_best(time_ms, 64, 20, 16, width_scale, hist)
        depths.append(d); nodes += n; plies += 1
        if wd: widened += 1
        if over:
            return dict(plies=plies, winner=w, depths=depths, nodes=nodes, widened=widened)
    return dict(plies=plies, winner=None, depths=depths, nodes=nodes, widened=widened)

if __name__ == "__main__":
    tms   = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    games = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    scale = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    t0=time.perf_counter()
    res=[play(1000+i, tms, scale) for i in range(games)]
    dt=time.perf_counter()-t0
    alld=[d for r in res for d in r['depths']]
    print(f"games {games}  time/move {tms} ms  width_scale {scale}  wall {dt:.0f}s")
    print(f"  game length : mean {statistics.mean(r['plies'] for r in res):.1f} plies "
          f"(min {min(r['plies'] for r in res)}, max {max(r['plies'] for r in res)})")
    print(f"  finished    : {sum(1 for r in res if r['winner'])}/{games}"
          f"   winners={[r['winner'] for r in res]}")
    print(f"  COMPLETED DEPTH: mean {statistics.mean(alld):.2f}  median {statistics.median(alld)}  max {max(alld)}")
    print(f"  nodes/game  : mean {statistics.mean(r['nodes'] for r in res):,.0f}")
