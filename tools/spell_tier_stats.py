import json,sys,math
from collections import Counter,defaultdict
import numpy as np
S=sys.argv[1]
d=json.load(open(S+'/completed_games_live.json'))
H=json.load(open(S+'/hydrated.json'))
CORE="Flourish Carnage Bewitch Starfall Seal_of_Lightning Grow Fireblast Hail_Storm Meteor Seal_of_Wind Sprout Slash Surge Comet Seal_of_Summer".split()
EXP="Blossom Scatter Seal_of_Spring Syzygy Eclipse Azimuth Erupt Fury Charge Hurricane Storm_Front Gust Tsunami Torrent Splash Harvest Gather Seal_of_Autumn Corrupt Decay Lurk Seal_of_Destruction Seal_of_Stone Seal_of_Winter".split()
OFFICIAL=CORE+EXP
STATIC={'Seal_of_Lightning','Seal_of_Wind','Seal_of_Summer','Seal_of_Spring','Seal_of_Autumn','Seal_of_Destruction','Seal_of_Stone','Seal_of_Winter','Bulwark','Lifesap','Seal_of_Autumn'}
RENAME={'Flood':'Tsunami'}
norm=lambda s:RENAME.get(s,s)
NODE_ORDER=[z+str(n) for z in 'abc' for n in range(1,14)]
POS={1:['a2','a3','a4','a5','a6'],2:['b2','b3','b4','b5','b6'],3:['c2','c3','c4','c5','c6'],4:['a8','a9','a10'],5:['b8','b9','b10'],6:['c8','c9','c10'],7:['a7'],8:['b7'],9:['c7']}
IDX={n:i for i,n in enumerate(NODE_ORDER)}
def parse(sfn):
    stones,rest=sfn.split('/',1); t=rest.split()
    lk=t[4].split(':'); return stones,t[3],lk[0],lk[1]
def uidclass(u):
    u=str(u or '')
    if u.startswith('__ai'): return u.strip('_').replace('ai_','')
    return 'human'
games=[]; nhyd=0
for k,v in d.items():
    if v.get('winner') not in ('red','blue'): continue
    spells=[norm(s) for s in v['spellNames']]
    casts={'red':Counter(),'blue':Counter()}; held={'red':Counter(),'blue':Counter()}
    # casts from actions
    for turn in v.get('turns') or []:
        if not isinstance(turn,dict): continue
        for a in turn.get('actions',[]) or []:
            if isinstance(a,dict) and a.get('type')=='cast' and a.get('spell'): casts[turn['color']][norm(a['spell'])]+=1
    hy=H.get(k)
    if hy and hy.get('ok'):
        nhyd+=1
        prev=v.get('setupSfn')
        turns_seen=set()
        for t in hy['turns']:
            sb=t.get('sfnBefore') or prev; sa=t.get('sfnAfter'); col=t.get('color')
            if sa:
                st,_,_,_=parse(sa)
                for i,s in enumerate(spells):
                    if s in STATIC:
                        nodes=POS[i+1]; c0=st[IDX[nodes[0]]]
                        if c0 in 'rb' and all(st[IDX[n]]==c0 for n in nodes):
                            held['red' if c0=='r' else 'blue'][s]+=1
                # cross-check casts via lock/counter for turns lacking cast actions (snapshot/fat)
                if sb and col in casts:
                    try:
                        _,cb,lrb,lbb=parse(sb); _,ca,lra,lba=parse(sa)
                        i=0 if col=='red' else 1
                        la=(lra,lba)[i]; lb=(lrb,lbb)[i]
                        if la!='-' and (la!=lb or ca!=cb):
                            # count only if the transcript had no cast action this turn
                            tn=t.get('turnNumber')
                            slim_turn=next((x for x in (v.get('turns') or []) if isinstance(x,dict) and x.get('turnNumber')==tn),None)
                            has_cast=slim_turn and any(isinstance(a,dict) and a.get('type')=='cast' for a in slim_turn.get('actions',[]) or [])
                            if not has_cast: casts[col][norm(la)]+=1
                    except Exception: pass
                prev=sa
    games.append(dict(key=k,winner=v['winner'],spells=spells,casts=casts,held=held,
        cls={'red':uidclass(v.get('redUid')),'blue':uidclass(v.get('blueUid'))},
        eloR=v.get('redEloBefore'),eloB=v.get('blueEloBefore')))
print('games',len(games),'hydrated ok',nhyd,file=sys.stderr)
CLASSES=sorted({g['cls'][c] for g in games for c in ('red','blue')})
print('classes',Counter(g['cls'][c] for g in games for c in ('red','blue')),file=sys.stderr)
def seg_ok(g,seg):
    ai=[g['cls'][c]!='human' for c in ('red','blue')]
    return seg=='all' or (seg=='noAIvAI' and not all(ai))
def usage(g,c,s):  # per-side usage measure
    return g['held'][c][s] if s in STATIC else g['casts'][c][s]
def fit(seg,indicator):
    allspells=sorted({s for g in games for s in g['spells']})
    feats=allspells+['cls:'+c for c in CLASSES if c!='human']+['elo']
    idx={f:i for i,f in enumerate(feats)}
    X=[];y=[]
    for g in games:
        if not seg_ok(g,seg): continue
        row=np.zeros(len(feats)+1)
        for s in g['spells']:
            r=usage(g,'red',s); b=usage(g,'blue',s)
            if indicator: r,b=min(r,1),min(b,1)
            row[idx[s]]+=r-b
        for c,sg in (('red',1),('blue',-1)):
            if g['cls'][c]!='human': row[idx['cls:'+g['cls'][c]]]+=sg
        if g['eloR'] is not None and g['eloB'] is not None: row[idx['elo']]=(g['eloR']-g['eloB'])/400
        row[-1]=1
        X.append(row); y.append(1.0 if g['winner']=='red' else 0.0)
    X=np.array(X);y=np.array(y); w=np.zeros(X.shape[1]); lam=1.0
    for _ in range(300):
        p=1/(1+np.exp(-X@w)); W=p*(1-p)+1e-9
        Hh=X.T@(X*W[:,None])+lam*np.eye(len(w)); gv=X.T@(y-p)-lam*w
        st=np.linalg.solve(Hh,gv); w+=st
        if np.abs(st).max()<1e-8: break
    p=1/(1+np.exp(-X@w)); se=np.sqrt(np.diag(np.linalg.inv(X.T@(X*(p*(1-p))[:,None])+lam*np.eye(len(w)))))
    ll=np.sum(y*np.log(p+1e-12)+(1-y)*np.log(1-p+1e-12))
    return {f:(w[idx[f]],se[idx[f]]) for f in feats},len(y),ll
raw={}
for s in OFFICIAL:
    a=cn=cw=nn=nw=tot=0
    for g in games:
        if s not in g['spells']: continue
        a+=1
        for c in ('red','blue'):
            u=usage(g,c,s); tot+=u; win=g['winner']==c
            if u: cn+=1; cw+=win
            else: nn+=1; nw+=win
    raw[s]=dict(avail=a,total=tot,users=cn,user_wr=cw/cn if cn else float('nan'),nonuser_wr=nw/nn if nn else float('nan'),per_game=tot/max(cn,1))
cnt,n1,ll1=fit('all',False); ind,n2,ll2=fit('all',True); cntH,n3,_=fit('noAIvAI',False)
print(f'n={n1}; per-count model ll={ll1:.1f}; indicator model ll={ll2:.1f}')
print('strength controls:',{f:round(cnt[f][0],2) for f in cnt if f.startswith('cls') or f=='elo'})
print(f"{'spell':20s}{'avail':>6}{'uses':>6}{'users':>6}{'perUsr':>7}{'useWR':>7}{'nonWR':>7}{'coef/use':>9}{'se':>6}{'coef/ind':>9}{'se':>6}{'noAIvAI':>8}")
for s in sorted(OFFICIAL,key=lambda s:-cnt[s][0]):
    r=raw[s]; tag='(held turns)' if s in STATIC else ''
    print(f"{s:20s}{r['avail']:6d}{r['total']:6d}{r['users']:6d}{r['per_game']:7.2f}{r['user_wr']:7.3f}{r['nonuser_wr']:7.3f}{cnt[s][0]:9.2f}{cnt[s][1]:6.2f}{ind[s][0]:9.2f}{ind[s][1]:6.2f}{cntH[s][0]:8.2f} {tag}")
json.dump(dict(raw=raw,coef_count={s:cnt[s] for s in OFFICIAL},coef_ind={s:ind[s] for s in OFFICIAL},coef_count_noAIvAI={s:cntH[s] for s in OFFICIAL},controls={f:cnt[f] for f in cnt if f.startswith('cls') or f=='elo'},n=n1),open(S+'/spell_stats2.json','w'),indent=1)
