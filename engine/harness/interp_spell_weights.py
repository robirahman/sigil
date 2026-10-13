"""Interpretability experiment 3: what the net knows about each spell (2026-10).

    interp_spell_weights.py <net.bin> <chunk-dir> <out.json> [--per-chunk 60]

The net's spell knowledge sits in its first layer: E[spell, place in sigil,
mine/theirs] (one 128-vector per sigil node and side) and G[spell, slot] (a
per-game bias). Rows for slots outside a spell's role are never trained (a legal
draw puts rituals in the three 5-node sigils, sorceries in the 3-node ones and
charms in the 1-node ones), so every comparison here stays inside a role.

Two readings:

1. Weights. Spells of one role compared by the cosine similarity of their
   trained E rows (all places, both sides), and clustered (average linkage).
   G rows compared across the three legal slots of the spell's role.

2. Function (the check the plan asks for: later layers are nonlinear, so weights
   alone can mislead). On real round-4 positions, the net is evaluated once as
   shipped and once with ONE slot's spell rows (its E rows and G row) zeroed,
   i.e. as if the net did not know which spell sits there. The difference is the
   spell-specific part of the net's correction in that position, side to move's
   POV, centistones. It is tabulated by how many of the sigil's nodes the side to
   move and its opponent hold, by slot, and averaged per spell.

The integer forward pass is nn_eval.qforward (bit-for-bit src/nn.rs); it is
checked against the engine's own evaluate(nnue_spell4) - evaluate(tfit_spell_v2)
on the sampled positions.
"""
import argparse, glob, json, os, random, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
import nn_eval as nn
from interp_hand_eval import NAMES, SIGIL

SIZES = [5, 5, 5, 3, 3, 3, 1, 1, 1]
ROLE_SLOTS = {'ritual': [0, 1, 2], 'sorcery': [3, 4, 5], 'charm': [6, 7, 8]}
ROLE_SIZE = {'ritual': 5, 'sorcery': 3, 'charm': 1}


def load_positions(chunk_dir, per_chunk, rng):
    sp, mine, theirs, is_red, check = [], [], [], [], []
    for path in sorted(glob.glob(os.path.join(chunk_dir, '*.npz'))):
        z = np.load(path)
        rows = [i for i in range(len(z['sfn'])) if int(z['ply'][i]) >= 2]
        for r in rng.sample(rows, min(per_chunk, len(rows))):
            sfn = str(z['sfn'][r])
            b = se.Board.from_sfn(sfn)
            if b.gameover:
                continue
            c = 'red' if sfn.split()[1] == 'r' else 'blue'
            red, blue = b.stones
            mine.append(red if c == 'red' else blue)
            theirs.append(blue if c == 'red' else red)
            is_red.append(1 if c == 'red' else 0)
            sp.append(list(b.spell_ids()))
            check.append(b.evaluate(c, se.SHIPPED_EVAL) - b.evaluate(c, 'tfit_spell_v2'))
    return (np.array(sp, np.uint8), np.array(mine, np.uint64), np.array(theirs, np.uint64),
            np.array(is_red, np.uint8), np.array(check, np.int64))


def role_of(s, spells):
    """The role of spell s, from the slot it occupies in the sampled draws."""
    p = int(np.argmax((spells == s).any(axis=0)))
    return 'ritual' if p < 3 else 'sorcery' if p < 6 else 'charm'


def e_rows(s, size):
    return [1 + (s * nn.NPLACE + q) * 2 + rel for q in range(size) for rel in (0, 1)]


def cosine(a, b):
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('net'); ap.add_argument('chunks'); ap.add_argument('out')
    ap.add_argument('--per-chunk', type=int, default=60)
    a = ap.parse_args()
    q = nn.read_bin(a.net)
    rng = random.Random(3)
    spells, mine, theirs, is_red, check = load_positions(a.chunks, a.per_chunk, rng)
    base = nn.qforward(q, mine, theirs, spells, is_red).astype(np.int64)
    mism = int(np.sum(base != check))
    print(f'{len(base)} positions; qforward vs engine mismatches: {mism}', flush=True)
    out = {'net': os.path.basename(a.net), 'positions': int(len(base)), 'qforward_mismatches': mism,
           'spells': {}, 'roles': {}}
    roles = {}
    for s in range(len(NAMES)):
        if (spells == s).any():
            roles.setdefault(role_of(s, spells), []).append(s)
    E = q['E'].astype(np.float64); G = q['G'].astype(np.float64)

    # ---- 1. weights: within-role similarity + clustering
    from scipy.cluster.hierarchy import linkage, fcluster
    for role, ss in roles.items():
        size = ROLE_SIZE[role]
        V = np.array([E[e_rows(s, size)].ravel() for s in ss])
        sim = [[cosine(V[i], V[j]) for j in range(len(ss))] for i in range(len(ss))]
        D = 1 - np.array(sim)
        iu = np.triu_indices(len(ss), 1)
        Z = linkage(D[iu], 'average')
        cl = fcluster(Z, t=4, criterion='maxclust')
        pairs = sorted(((sim[i][j], NAMES[ss[i]], NAMES[ss[j]]) for i, j in zip(*iu)), reverse=True)
        out['roles'][role] = {'spells': [NAMES[s] for s in ss], 'clusters_k4': {NAMES[s]: int(c) for s, c in zip(ss, cl)},
                              'most_similar': pairs[:8], 'least_similar': pairs[-5:]}
        for s in ss:
            g = {str(p): float(np.linalg.norm(G[s * 9 + p])) for p in ROLE_SLOTS[role]}
            gv = [G[s * 9 + p] for p in ROLE_SLOTS[role]]
            gsim = [cosine(gv[i], gv[j]) for i in range(3) for j in range(i + 1, 3)]
            out['spells'][NAMES[s]] = {'role': role, 'E_norm': float(np.linalg.norm(E[e_rows(s, size)])),
                                       'G_norm_by_slot': g, 'G_slot_cosines': gsim}

    # ---- 2. function: the spell-specific part of the net's correction
    nodes_of = [[n for n in range(39) if SIGIL[p] >> n & 1] for p in range(9)]
    for role, ss in roles.items():
        size = ROLE_SIZE[role]
        for s in ss:
            q0 = dict(q)
            q0['E'] = q['E'].copy(); q0['G'] = q['G'].copy()
            q0['E'][e_rows(s, size)] = 0
            q0['G'][[s * 9 + p for p in range(9)]] = 0
            hold = (spells == s).any(axis=1)
            idx = np.flatnonzero(hold)
            d = base[idx] - nn.qforward(q0, mine[idx], theirs[idx], spells[idx], is_red[idx]).astype(np.int64)
            slot = np.argmax(spells[idx] == s, axis=1)
            km = np.array([bin(int(mine[i]) & SIGIL[p]).count('1') for i, p in zip(idx, slot)])
            kt = np.array([bin(int(theirs[i]) & SIGIL[p]).count('1') for i, p in zip(idx, slot)])
            tab = {}
            for m in range(size + 1):
                for t in range(size + 1 - m):
                    sel = (km == m) & (kt == t)
                    if sel.sum() >= 30:
                        tab[f'{m}-{t}'] = [float(d[sel].mean()), int(sel.sum())]
            by_slot = {str(p): [float(d[slot == p].mean()), int((slot == p).sum())] for p in ROLE_SLOTS[role]
                       if (slot == p).sum() >= 30}
            full_m = d[km == size]; full_t = d[kt == size]
            rec = out['spells'][NAMES[s]]
            rec.update({'n': int(len(idx)), 'mean_cs': float(d.mean()), 'mean_abs_cs': float(np.abs(d).mean()),
                        'own_full_cs': float(full_m.mean()) if len(full_m) >= 30 else None,
                        'opp_full_cs': float(full_t.mean()) if len(full_t) >= 30 else None,
                        'by_mine_theirs': tab, 'by_slot': by_slot})
            print(f"{NAMES[s]:20s} {role:8s} n={len(idx):6d} mean {d.mean():+6.1f} |d| {np.abs(d).mean():5.1f} "
                  f"own-full {rec['own_full_cs'] if rec['own_full_cs'] is None else round(rec['own_full_cs'],1)} "
                  f"opp-full {rec['opp_full_cs'] if rec['opp_full_cs'] is None else round(rec['opp_full_cs'],1)} "
                  f"by slot {[(p, round(v[0],1)) for p, v in by_slot.items()]}", flush=True)
    json.dump(out, open(a.out, 'w'), indent=1)
    for role, r in out['roles'].items():
        print(role, 'clusters', r['clusters_k4'])
        print('  most similar', [(round(x, 2), u, v) for x, u, v in r['most_similar'][:5]])


if __name__ == '__main__':
    main()
