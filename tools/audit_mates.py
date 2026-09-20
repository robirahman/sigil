#!/usr/bin/env python3
"""Audit every recorded game's final two positions against the Rust engine.

Inputs: hydrated.json (per-turn SFNs from ai.replay_bridge; see tools/gen_mate_puzzles.py
--download/--hydrated for how to produce it) in the working directory. Output: audit.jsonl,
one record per game, summarised by audit_mates_summary.py.

For each game that ended by a board win:
  F (winner to move): exhaustive mate-in-1 set (sigil_engine.solve_mates), rank of the
     recorded winning layout in the ordered stream (layout_rank), depth-1 search verdict;
  P (loser to move): depth-2 search with the mate bookends off (shipped v5) and on (v6),
     its chosen move, and whether that move allows an exhaustive mate-in-1 reply.
Run with the venv that has sigil_engine built from engine/ (maturin develop --release).
"""
import json, sys, os, time, re, traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
import sigil_engine as E
S=os.path.dirname(os.path.abspath(__file__))
CFG=dict(tt_bits=20, width_scale=4, eval_name='tfit', adaptive=(0.10,2,6))
WIN=10_000_000

def sfn_key(sfn):
    p=sfn.split(' ')
    # board/spells, counters, locks, springlocks (drop side-to-move + turn counter + trailing tokens)
    return ' '.join([p[0]]+p[3:6]) if len(p)>=6 else sfn

def masks(sfn):
    b=sfn.split(' ')[0].split('/')[0]
    r=sum(1<<i for i,ch in enumerate(b) if ch=='r'); bl=sum(1<<i for i,ch in enumerate(b) if ch=='b')
    return r,bl

def is_ai(u): return isinstance(u,str) and u.startswith('__ai_')

def search(sfn, depth, bookends, time_ms=0):
    r=E.pick_move_actions(sfn, time_ms=time_ms, max_depth=depth, mate_bookends=bookends, **CFG)
    acts, after, d, nodes, score, dt, ui = r
    return dict(score=score, ui=round(ui,2), depth=d, nodes=nodes, dt=round(dt,3), actions=json.loads(acts), after=after)

def spells_in(actions):
    return sorted({a.get('spell') for a in actions if a.get('type')=='cast' and a.get('spell')})

def audit(gid, g):
    out=dict(gid=gid, red=g.get('redUid'), blue=g.get('blueUid'), winner=g.get('winner'), ts=g.get('timestamp'),
             variant=g.get('variant') or 'standard', spells=g.get('spellNames'), gust_in_draw='Gust' in (g.get('spellNames') or []))
    T=g['turns']
    if len(T)<2: out['skip']='too short'; return out
    last,pen=T[-1],T[-2]
    try:
        bf=E.Board.from_sfn(last['sfnAfter'])
    except Exception as e:
        out['skip']='unsupported: '+str(e)[:80]; return out
    over=bf.check_game_over(last['color'])
    if not over: out['skip']='final position not terminal (timeout/resign/repetition?)'; return out
    if last['color']!=g.get('winner'): out['skip']=f"last mover {last['color']} != winner"; return out
    if sfn_key(pen['sfnAfter'])!=sfn_key(last['sfnBefore']): out['skip']='pen.after != last.before'; return out
    if pen['color']==last['color']: out['skip']='same color consecutive'; return out
    F=last['sfnBefore']; P=pen['sfnBefore']
    out.update(F=F, P=P, loser=pen['color'], loser_uid=g.get(pen['color']+'Uid'), winner_uid=g.get(last['color']+'Uid'),
               turn=last['turnNumber'], pen_fat=pen.get('fat'), last_fat=last.get('fat'))
    bF=E.Board.from_sfn(F); bP=E.Board.from_sfn(P)
    out['winner_charged']=bF.charged_names(last['color']); out['loser_charged']=bP.charged_names(pen['color'])
    # exhaustive mates at F
    # the recorded winning turn itself: is its layout in the ordered stream (what the search sees), and enumerable at all?
    pr,pb=masks(last['sfnAfter'])
    rk,gen,found=bF.layout_rank(last['color'], pr, pb, 24, 0, 4096)
    out['F_played_rank']=rk if found else None; out['F_played_gen4096']=gen
    if not found:
        rk2,gen2,found2=bF.layout_rank(last['color'], pr, pb, 24, 0, 200_000)
        out['F_played_rank_200k']=rk2 if found2 else None
    if found or out.get('F_played_rank_200k') is not None:
        out['F_played_reachable']=True
    else:
        reach,ntu,trunc=bF.layout_reachable(last['color'], pr, pb, 150_000)
        out['F_played_reachable']=reach; out['F_enum_turns']=ntu; out['F_enum_truncated']=trunc
    s=json.loads(E.solve_mates(F, max_mate=1))
    if not s.get('ok'):
        out['F_solve_err']=s.get('error'); out['F_solve_caps']=(s.get('turn_cap'),s.get('resolver_cap')); m1=[]
    else:
        m1=s['mate1']; out['F_mate1']=s['mate1_total']; out['F_succ']=s['root_successors']
        out['F_mate_spells']=sorted({sp for m in m1 for sp in spells_in(m['actions'])})
        out['F_mates_all_need_cast']=all(spells_in(m['actions']) for m in m1) if m1 else None
        out['F_mates_all_need_gust']=all('Gust' in spells_in(m['actions']) for m in m1) if m1 else None
        # rank of the best-placed mate in the ordered generator (what the search sees at ply 2)
        best=None; tot=0
        for m in m1[:64]:
            r,b=masks(m['after'])
            rk,gen,found=bF.layout_rank(last['color'], r, b, 24, 0, 4096)
            tot=max(tot,gen)
            if found and (best is None or rk<best): best=rk
        out['F_mate_rank_min']=best; out['F_rank_generated']=tot
    # played mate: did the recorded winning move actually mate (sanity)
    # depth-1 search at F: does the engine find a win
    s1=search(F,1,False); out['F_d1_off']=dict(score=s1['score'],ui=s1['ui'],nodes=s1['nodes'])
    out['F_d1_off_wins']=s1['score']>4000
    # depth-2 at P, both bookend settings
    for be,tag in ((False,'off'),(True,'on')):
        r=search(P,2,be)
        rec=dict(score=r['score'],ui=r['ui'],nodes=r['nodes'],dt=r['dt'],spells=spells_in(r['actions']),actions=r['actions'])
        rec['sees_loss']=r['score']<-4000
        # does the chosen move allow an exhaustive mate-in-1 reply?
        try:
            ba=E.Board.from_sfn(r['after']); ba.check_game_over(pen['color'])
            if ba.check_game_over(pen['color']):
                rec['after_over']=True; rec['reply_mate1']=None
            else:
                s2=json.loads(E.solve_mates(r['after'], max_mate=1))
                rec['reply_mate1']=s2.get('mate1_total') if s2.get('ok') else None
                rec['reply_err']=None if s2.get('ok') else s2.get('error')
                rec['reply_mate_spells']=sorted({sp for m in s2.get('mate1',[]) for sp in spells_in(m['actions'])}) if s2.get('ok') else None
                rec['reply_all_need_gust']=all('Gust' in spells_in(m['actions']) for m in s2.get('mate1',[])) if s2.get('ok') and s2.get('mate1') else None
        except Exception as e:
            rec['reply_err']=str(e)[:100]
        out['P_d2_'+tag]=rec
    return out

def work(item):
    gid,g=item
    try: return audit(gid,g)
    except Exception as e:
        return dict(gid=gid, skip='exception: '+str(e)[:200], tb=traceback.format_exc()[-400:])

if __name__=='__main__':
    H=json.load(open(S+'/hydrated.json'))
    outp=S+'/audit.jsonl'
    done=set()
    if os.path.exists(outp):
        for line in open(outp): 
            try: done.add(json.loads(line)['gid'])
            except: pass
    items=[(k,g) for k,g in H.items() if k not in done]
    print('todo',len(items),'done',len(done),flush=True)
    t0=time.time(); n=0
    with ProcessPoolExecutor(max_workers=int(sys.argv[1]) if len(sys.argv)>1 else 6) as ex, open(outp,'a') as fh:
        futs=[ex.submit(work,it) for it in items]
        for f in as_completed(futs):
            fh.write(json.dumps(f.result())+'\n'); fh.flush(); n+=1
            if n%100==0: print(n,'/',len(items),f'{time.time()-t0:.0f}s',flush=True)
    print('done',n,f'{time.time()-t0:.0f}s',flush=True)
