#!/usr/bin/env python3
"""A/B the turn ordering: best-first-with-quotas vs the old stage ordering.

Both live in one binary (`legacy_order`), so this isolates the ordering change from
everything else. Colour-swapped and seeded, since the spell draw carries enough
variance that short matches are worthless.
"""
import math, os, statistics, sys
_HERE=os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
import sigil_engine as se
MERGE = int(os.environ.get('MERGE_MIN_DEPTH', '5'))

def game(seed, new_color, ms, max_plies=140):
    b=se.Board(se.Board.legal_draw(seed),"standard"); b.setup_initial()
    hist=[]; dep={'new':[], 'old':[]}
    for ply in range(max_plies):
        side='red' if b.to_sfn().split()[1]=='r' else 'blue'
        legacy = (side != new_color)
        hist.append(b.key_js)
        d,n,dt,over,w,sc,wd = b.play_best(ms,64,20,16,1,hist,"material",legacy,MERGE)
        dep['old' if legacy else 'new'].append(d)
        if over: return w, ply+1, dep
    return None, max_plies, dep

if __name__=="__main__":
    pairs=int(sys.argv[1]) if len(sys.argv)>1 else 20
    ms=int(sys.argv[2]) if len(sys.argv)>2 else 300
    wins={'new':0,'old':0}; unf=0; plies=[]; dep={'new':[],'old':[]}
    for i in range(pairs):
        for nc in ('red','blue'):
            w,n,d=game(7000+i,nc,ms)
            plies.append(n); dep['new']+=d['new']; dep['old']+=d['old']
            if w is None: unf+=1
            elif w==nc: wins['new']+=1
            else: wins['old']+=1
    tot=sum(wins.values())+unf
    p=wins['new']/tot if tot else 0
    se_=math.sqrt(p*(1-p)/tot) if 0<p<1 else 0
    elo=400*math.log10(p/(1-p)) if 0<p<1 else float('nan')
    print(f"best-first+quota vs stage-order   {tot} games, {ms} ms/move, colour-swapped")
    print(f"  new {wins['new']}   old {wins['old']}   unfinished {unf}")
    print(f"  NEW SCORE {100*p:.1f}%  (SE {100*se_:.1f}%)   Elo diff {elo:+.0f}")
    print(f"  mean plies {statistics.mean(plies):.1f}")
    print(f"  depth: new {statistics.mean(dep['new']):.2f}  old {statistics.mean(dep['old']):.2f}")
