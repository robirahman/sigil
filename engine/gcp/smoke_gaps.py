"""Where does the engine's nearest turn diverge from the one actually played?

61 turns survive every filter: their records are slim, their actions replay
cleanly through the browser engine, and the engine still cannot generate them.
Three hypotheses died to reading the Rust against the JS -- the dash's
intermediate game-over check (cannot fire, `total > 2`), Meteor's forced
destroy (the JS forces it too), and Meteor's blink targets (`ALL & !mine`
matches `getBlinkTargets` exactly). So stop reading and print, for each case,
the recorded action list beside the nearest turn enumeration DID produce.
"""
import collections, json, urllib.parse, urllib.request
import sigil_engine as se

BUCKET='focus-surfer-494820-g0-sigil'
CAP=250_000
NAMES=se.NODE_NAMES


def fetch(obj):
    tok=json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor":"Google"})))["access_token"]
    u=(f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
       + urllib.parse.quote(obj,safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization":"Bearer "+tok})).read()


def fmt(log):
    out=[]
    for kind,node,push_to,sacs,pos in log:
        n=NAMES[node] if 0<=node<len(NAMES) else str(node)
        p=NAMES[push_to] if 0<=push_to<len(NAMES) else None
        if kind=='cast': out.append(f'cast(pos={pos+1},out={node})')
        elif kind=='dash':
            out.append(f'dash({n}<-[{",".join(NAMES[s] for s in sacs)}]'
                       + (f',push {p}' if p else '') + ')')
        elif kind=='pass': out.append('pass')
        else: out.append(f'{kind}({n}' + (f',push {p}' if p else '') + ')')
    return ' '.join(out)


def rec_fmt(actions):
    out=[]
    for a in actions:
        if not isinstance(a,dict): continue
        t=a.get('type')
        bits=[t]
        for k in ('node','spell','pushed_to'):
            if a.get(k) is not None: bits.append(f'{k}={a[k]}')
        for k in ('sacrificed','kept','destroyed'):
            if a.get(k): bits.append(f'{k}={a[k]}')
        out.append('('+' '.join(bits)+')')
    return ' '.join(out)


cases=json.loads(fetch('data/gap_cases.json'))
print(f'{len(cases)} genuine-gap cases\n', flush=True)
dist=collections.Counter(); trunc=0
for i,c in enumerate(cases):
    b=se.Board.from_sfn(c['sfnBefore'])
    tgt=se.Board.from_sfn(c['sfnAfter']).stones
    d,br,bb,log,n,tt,tr=b.layout_nearest(c['mover'],tgt[0],tgt[1],CAP)
    dist[d]+=1
    if tr: trunc+=1
    print(f"[{i:2d}] dist={d:2d} enum={n:7d} res_trunc={int(tr)} "
          f"{c['game']} t{c['turnNumber']} by {c['playedBy']}", flush=True)
    print(f"     PLAYED : {rec_fmt(c['actions'])}")
    print(f"     NEAREST: {fmt(log)}")
print(f"\n=== distance histogram === {dict(sorted(dist.items()))}")
print(f"resolver_truncated: {trunc}/{len(cases)}")
