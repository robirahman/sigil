"""Round 3 (2026-10): policy-stream rank of the guest-suite replies.

    guest_policy_rank.py <weights.npy|compiled> [...] [--cases ai/data/benchmarks/guest_2026-10_cases.json]
                         [--cap 5000] [--json out.json]

For every case of the guest suite (`surprise_audit.py` cases from the
2026-10-06/07 guest games), the rank of the human's reply (`sfn_after`) in the
generator POLICY stream (`policy_rank_of_result`, cap 5,000; -1 = not
generated within the cap), as `final_blow_probe` / `surprise_audit` record it
(`policy_rank`). One row per weight set; counts covered at w6/w12/w24/w40/w96
and w500, overall and on casts / dash+casts.
"""
import argparse, json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sigil_engine as se
from policy_train import load_weights

KS = (6, 12, 24, 40, 96, 500)


def cov(r):
    v = np.where(np.asarray(r) < 0, 10 ** 9, np.asarray(r))
    return {f'w{k}': int((v < k).sum()) for k in KS} | {'n': len(r)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('weights', nargs='+')
    ap.add_argument('--cases', default=os.path.join(HERE, '..', '..', 'ai', 'data', 'benchmarks',
                                                    'guest_2026-10_cases.json'))
    ap.add_argument('--cap', type=int, default=5000)
    ap.add_argument('--json', default='')
    ap.add_argument('--explore', default='', help='set_policy_explore args, comma-separated (r3-gen; '
                    'ab_search preset 3 = 3,64,128,8,48,512,16)')
    a = ap.parse_args()
    cases = json.load(open(a.cases))
    se.set_policy(True, 96)
    if a.explore:
        se.set_policy_explore(*[int(x) for x in a.explore.split(',')])
    out = {}
    for w in a.weights:
        se.set_policy_weights(load_weights(w).ravel().tolist())
        ranks = []
        for c in cases:
            try:
                r = se.policy_rank_of_result(c['sfn'], c['sfn_after'], a.cap)[0]
            except Exception:  # noqa: BLE001 -- refused position = not covered
                r = -1
            ranks.append(int(r))
        sl = [r for r, c in zip(ranks, cases) if c.get('kind') in ('cast', 'dash+cast')]
        out[w] = dict(ranks=ranks, all=cov(ranks), cast_slice=cov(sl))
        print(w, json.dumps(out[w]['all']), 'casts', json.dumps(out[w]['cast_slice']), flush=True)
    print('kinds', [c.get('kind') for c in cases])
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
