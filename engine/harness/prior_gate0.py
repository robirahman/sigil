"""§2 gate 0 and coverage report from `selfplay_prior.py` labels.

    prior_gate0.py <npz-glob> [cap=400]

For every label, regenerate the position's ordered candidate universe through
`PyBoard.prior_dataset` and locate the chosen turn. Reports:
  * coverage of the CURRENT ordering at w6/w12/w24/w40/w96 (the stream rank),
  * the STUB ORACLE: the fraction of chosen turns lying within the first k of their
    own stub under the heuristic within-stub order (k = 1, 2, 4) -- gate 0 needs
    >= 97% at k = 4, or the prior needs a within-stub scorer before it can help,
  * how many labels fall outside `cap` (dropped, and counted, never silent).
"""
import glob, sys, os
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se


def main():
    files = sorted(glob.glob(sys.argv[1]))
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 400
    ranks, within, nstubs, outside, n_cands = [], [], [], 0, []
    labels = 0
    for f in files:
        d = np.load(f, allow_pickle=False)
        for sfn, ch in zip(d['sfn'], d['chosen']):
            labels += 1
            want = [int(x) for x in ch if x != 0]
            b = se.Board.from_sfn(str(sfn))
            _x, _sp, _rows, stubs, wr, packed, _tr = b.prior_dataset(cap)
            idx = next((i for i, p in enumerate(packed) if list(p) == want), None)
            n_cands.append(len(packed))
            if idx is None:
                outside += 1
                continue
            ranks.append(idx); within.append(int(wr[idx])); nstubs.append(len(set(stubs)))
    r = np.asarray(ranks); w = np.asarray(within)
    print(f"labels {labels}  matched {len(r)}  outside cap {outside} ({100*outside/max(labels,1):.2f}%)")
    print(f"candidates per position: median {np.median(n_cands):.0f}  stubs per position: median {np.median(nstubs):.0f}")
    print("stream rank of the chosen turn: median %d  p75 %d  p90 %d  p95 %d  p99 %d" %
          tuple(np.percentile(r, [50, 75, 90, 95, 99])))
    print("coverage: " + "  ".join(f"w{k}={100*(r<k).mean():.1f}%" for k in (6, 12, 24, 40, 96)))
    print("stub oracle (chosen within first k of ITS stub): " +
          "  ".join(f"k{k}={100*(w<k).mean():.1f}%" for k in (1, 2, 4)))
    need = np.minimum(r + 1, 96)
    print(f"oracle average width for {100*(r<96).mean():.1f}% coverage: {need.mean():.1f}")
    ok = (w < 4).mean() >= 0.97
    print("GATE 0:", "PASS" if ok else "FAIL (add a within-stub scorer before training)")


if __name__ == "__main__":
    main()
