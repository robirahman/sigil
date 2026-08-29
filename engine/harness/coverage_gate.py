"""Coverage gate: is "the search's best move lies beyond width k" PREDICTABLE from
the position alone?

    coverage_gate.py <data_dir> [narrow] [wide]

WHAT THIS CAN AND CANNOT TEST. The generated data carries POSITION features and the
RANK of the search's chosen turn, but not per-turn features -- so it cannot train a
re-ranker, which is what a policy network ultimately is. Training that needs a
generation pass that dumps candidate-turn features, which is a bigger job.

What it can settle, cheaply and now, is the question sitting immediately underneath:
the search currently pays a UNIFORM width everywhere, and the measured coverage curve
(w24 = 86.9%, w96 = 98.2% over 1.39M labels) says most positions are resolved at rank
0-1 while a minority need 100+. If a cheap classifier can tell those apart, the engine
can spend width only where it is needed -- ADAPTIVE WIDENING -- and buy back most of
the ~2.2 plies that uniform widening costs, with no network in the hot path.

That is worth having on its own, and it de-risks the policy net: if position features
cannot even predict WHETHER the ordering fails, a per-turn ranker trained on the same
signal is a much longer shot.

Splits are by GAME, never by position: positions from one game share a trajectory,
and a position-level split would leak.
"""
import glob, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score


def load(d):
    H=[];F=[];R=[];G=[];P=[]
    bad=0
    for f in sorted(glob.glob(os.path.join(d,'*.npz'))):
        try: z=np.load(f, allow_pickle=True)
        except Exception: bad+=1; continue
        if 'best_rank' not in z.files: continue
        r=z['best_rank']; m=r>=0                 # only policy-labelled rows
        if not m.any(): continue
        H.append(z['hand'][m]); F.append(z['full'][m]); R.append(r[m])
        G.append(z['game'][m]); P.append(z['ply'][m])
    print(f"shards loaded (skipped {bad} corrupt)")
    return (np.concatenate(H), np.concatenate(F), np.concatenate(R),
            np.concatenate(G), np.concatenate(P))


def game_split(g, frac=0.25, seed=0):
    u=np.unique(g); rng=np.random.default_rng(seed); rng.shuffle(u)
    te=set(u[:max(1,int(len(u)*frac))].tolist())
    m=np.fromiter((x in te for x in g), bool, len(g))
    return ~m, m


if __name__=="__main__":
    d=sys.argv[1]
    NARROW=int(sys.argv[2]) if len(sys.argv)>2 else 24     # shipped frontier width
    WIDE=int(sys.argv[3]) if len(sys.argv)>3 else 96       # width for ~98% coverage
    hand,full,rank,game,ply=load(d)
    n=len(rank)
    print(f"policy-labelled positions {n:,} from {len(np.unique(game)):,} games")
    print(f"base coverage:  w{NARROW} = {100*(rank<NARROW).mean():.1f}%   "
          f"w{WIDE} = {100*(rank<WIDE).mean():.1f}%   "
          f"P(needs > w{NARROW}) = {100*(rank>=NARROW).mean():.1f}%")

    y=(rank>=NARROW).astype(int)
    tr,te=game_split(game)
    X=np.hstack([full, ply.reshape(-1,1).astype(np.float32)])
    sc=StandardScaler().fit(X[tr])
    Xtr,Xte=sc.transform(X[tr]),sc.transform(X[te])

    print("\nCan a model predict that the ordering will fail at this position?")
    for name,mdl in (("logistic", LogisticRegression(max_iter=1000)),
                     ("grad-boost", HistGradientBoostingClassifier(max_iter=200,
                                                                   random_state=0))):
        mdl.fit(Xtr,y[tr])
        p=mdl.predict_proba(Xte)[:,1]
        auc=roc_auc_score(y[te],p)
        print(f"  {name:>11}  AUC {auc:.4f}")
        if name=="grad-boost": best_p=p

    # The actionable number: spend WIDE on the riskiest q of positions and NARROW on
    # the rest. What average width buys the coverage that uniform WIDE buys today?
    rte=rank[te]
    uniform_cov=100*(rte<WIDE).mean()
    print(f"\nuniform w{WIDE} everywhere: coverage {uniform_cov:.1f}%, average width {WIDE}")
    print(f"{'top-q widened':>14} {'avg width':>10} {'coverage':>9}")
    order=np.argsort(-best_p)
    for q in (0.05,0.10,0.15,0.20,0.30,0.50):
        k=int(len(rte)*q)
        wide=np.zeros(len(rte),bool); wide[order[:k]]=True
        cov=100*np.mean(np.where(wide, rte<WIDE, rte<NARROW))
        aw=q*WIDE+(1-q)*NARROW
        print(f"{100*q:>13.0f}% {aw:>10.1f} {cov:>8.1f}%")
    # floor: an oracle that knows each position's exact requirement
    need=np.minimum(rte+1, WIDE)
    print(f"\noracle (knows each position's requirement): average width "
          f"{need.mean():.1f} for {100*(rte<WIDE).mean():.1f}% coverage")
