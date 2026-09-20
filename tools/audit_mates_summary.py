#!/usr/bin/env python3
"""Tables for audit_mates.py output (audit.jsonl + hydrated.json in the working directory)."""
import json, collections, sys, datetime
R=[json.loads(l) for l in open('audit.jsonl')]
def tier(u):
    if not isinstance(u,str): return 'human'
    if u.startswith('__ai_rust'): return 'rust:'+u.strip('_')[3:]
    if u.startswith('__ai_'): return 'js:'+u.strip('_')[3:]
    return 'human'
def rankbucket(r):
    if r is None: return 'not generated (<=4096)'
    if r<24: return 'rank <24 (expanded)'
    return 'rank 24..4096 (generated, not expanded)'
skips=collections.Counter(r.get('skip','ok').split(':')[0] for r in R)
print('games audited:',len(R),'skips:',dict(skips))
A=[r for r in R if 'skip' not in r and 'F_mate1' in r]
print('fully audited (board win, consistent, solver ok):',len(A))
print('F_mate1==0 (recorded winning move not a mate per engine?):',sum(1 for r in A if r['F_mate1']==0))
A=[r for r in A if r['F_mate1']>0]
def pct(n,d): return f'{n}/{d} ({100*n/d:.0f}%)' if d else '0/0'
groups=collections.defaultdict(list)
for r in A: groups[tier(r['loser_uid'])].append(r)
print('\n=== Per loser tier: does the search see the mate-in-1 reply? ===')
print(f"{'loser':22} {'games':>5} {'d1 finds mate':>16} {'rank<24':>8} {'24..4096':>9} {'notgen':>7} | {'d2off sees loss':>15} {'d2off move allows mate':>22} {'MISS off':>9} {'MISS on':>8}")
for t,rs in sorted(groups.items(), key=lambda kv:-len(kv[1])):
    n=len(rs)
    d1=sum(1 for r in rs if r['F_d1_off_wins'])
    rb=collections.Counter(rankbucket(r.get('F_mate_rank_min')) for r in rs)
    off=[r['P_d2_off'] for r in rs]; on=[r['P_d2_on'] for r in rs]
    sees=sum(1 for x in off if x['sees_loss'])
    allows=sum(1 for x in off if (x.get('reply_mate1') or 0)>0)
    miss_off=sum(1 for x in off if (x.get('reply_mate1') or 0)>0 and not x['sees_loss'])
    miss_on=sum(1 for x in on if (x.get('reply_mate1') or 0)>0 and not x['sees_loss'])
    print(f"{t:22} {n:5} {pct(d1,n):>16} {rb['rank <24 (expanded)']:8} {rb['rank 24..4096 (generated, not expanded)']:9} {rb['not generated (<=4096)']:7} | {sees:15} {allows:22} {miss_off:9} {miss_on:8}")
print('\n=== Blind spots: mate-in-1 not found by depth-1 ordered search (F_d1_off_wins=False), by cause ===')
B=[r for r in A if not r['F_d1_off_wins']]
print('total',len(B),'of',len(A))
c=collections.Counter()
for r in B:
    sp=r.get('F_mate_spells') or []
    cause=('all mates need Gust' if r.get('F_mates_all_need_gust') else 'all mates need a cast (non-Gust: %s)'%','.join(s for s in sp if s!='Gust') if r.get('F_mates_all_need_cast') else 'some mate needs no cast')
    c[(rankbucket(r.get('F_mate_rank_min')), cause)]+=1
for k,v in sorted(c.items(), key=lambda kv:-kv[1]): print(f'{v:4}  {k[0]:40} {k[1]}')
print('\nGust in draw among blind spots:',sum(1 for r in B if r['gust_in_draw']),'; Gust charged by winner at F:',sum(1 for r in B if any(x.startswith('Gust') for x in r['winner_charged'])))
print('Gust in draw among all audited:',sum(1 for r in A if r['gust_in_draw']),'; blind rate with Gust in draw:',pct(sum(1 for r in B if r['gust_in_draw']),sum(1 for r in A if r['gust_in_draw'])),'; without:',pct(sum(1 for r in B if not r['gust_in_draw']),sum(1 for r in A if not r['gust_in_draw'])))
print('\n=== Spells required by ALL mates in blind-spot games (cast spell histogram) ===')
h=collections.Counter()
for r in B:
    for s in (r.get('F_mate_spells') or []): h[s]+=1
print(dict(h.most_common()))
print('\n=== Rust-tier losses (AI lost): details ===')
for r in sorted([r for r in A if tier(r['loser_uid']).startswith('rust')], key=lambda r:r['ts']):
    d=datetime.datetime.utcfromtimestamp(r['ts']/1000).strftime('%Y-%m-%d')
    off=r['P_d2_off']; on=r['P_d2_on']
    print(f"{d} {r['gid']} {tier(r['loser_uid']):18} T{r['turn']:>3} {r['variant']:12} mates={r['F_mate1']:>5}/{r['F_succ']:>6} rank={r.get('F_mate_rank_min')} d1wins={r['F_d1_off_wins']} mateSpells={r.get('F_mate_spells')} winnerCharged={r['winner_charged']} | d2off={off['ui']} allows={off.get('reply_mate1')} d2on={on['ui']} allows={on.get('reply_mate1')} gustDraw={r['gust_in_draw']}")

# ---------------- cause classification of blind spots (uses recorded winning turn) ----------------
H=json.load(open('hydrated.json'))
def turn_shape(actions):
    if not isinstance(actions,list): return 'unknown'
    kinds=[]; 
    for a in actions:
        if isinstance(a,dict):
            t=a.get('type')
            if t=='dash': kinds.append('dash')
            elif t=='cast': kinds.append('cast:'+str(a.get('spell')))
            elif t in ('move','hard_move','blink','soft_move'): kinds.append('move')
        elif isinstance(a,str) and a in ('dash',): kinds.append('dash')
        elif isinstance(a,str) and a[0].isupper() and '_' in a or (isinstance(a,str) and a in ('Gust','Meteor','Fireblast','Harvest','Erupt','Slash','Sprout','Surge','Comet','Grow','Bewitch','Starfall','Carnage','Flourish','Lurk','Scatter','Blossom','Charge','Fury','Decay','Corrupt','Hurricane','Tsunami','Torrent','Splash','Syzygy','Azimuth','Eclipse','Gather')): kinds.append('cast:'+a)
    has_dash='dash' in kinds; casts=[k[5:] for k in kinds if k.startswith('cast:')]
    return ('dash+' if has_dash else '')+('cast('+'+'.join(casts)+')' if casts else 'move-only')
print('\n=== Blind spots by shape of the RECORDED winning turn (was it generated? rank in ordered stream) ===')
c=collections.Counter(); c2=collections.Counter()
for r in B:
    acts=H[r['gid']]['turns'][-1]['actions']
    shape=turn_shape(acts)
    rk=r.get('F_played_rank'); rk2=r.get('F_played_rank_200k')
    gen=('rank<24' if rk is not None and rk<24 else 'rank 24..4096' if rk is not None else f'rank 4096..200k' if rk2 is not None else 'NOT generated in 200k' if r.get('F_played_reachable') else 'enumeration too large to check' if r.get('F_enum_truncated') else 'NOT enumerable (rules/recorder)')
    c[(gen,shape)]+=1; c2[gen]+=1
for k,v in sorted(c.items(), key=lambda kv:-kv[1]): print(f'{v:4}  {k[0]:32} {k[1]}')
print('totals by generation status:',dict(c2))
print('\n=== Same for ALL audited games (played mate visibility to the ordered generator) ===')
c3=collections.Counter()
for r in A:
    rk=r.get('F_played_rank'); rk2=r.get('F_played_rank_200k')
    gen=('rank<24' if rk is not None and rk<24 else 'rank 24..4096' if rk is not None else f'rank 4096..200k' if rk2 is not None else 'NOT generated in 200k' if r.get('F_played_reachable') else 'enumeration too large to check' if r.get('F_enum_truncated') else 'NOT enumerable (rules/recorder)')
    c3[gen]+=1
print(dict(c3))
Z=[r for r in R if 'skip' not in r and r.get('F_mate1')==0]
print('\nzero-mate (recorded win not a mate under current engine rules):',len(Z), 'dates:',sorted({datetime.datetime.utcfromtimestamp(r['ts']/1000).strftime('%Y-%m') for r in Z}), 'shapes:',collections.Counter(turn_shape(H[r['gid']]['turns'][-1]['actions']) for r in Z).most_common(6))
INC=[r for r in R if 'skip' not in r and r.get('F_solve_err')]
print('solver-incomplete winner positions:',len(INC),'; of these d1 finds mate:',sum(1 for r in INC if r['F_d1_off_wins']),'; played mate rank<24:',sum(1 for r in INC if (r.get('F_played_rank') or 99)<24), '; not generated in 200k:',sum(1 for r in INC if r.get('F_played_rank') is None and r.get('F_played_rank_200k') is None))
