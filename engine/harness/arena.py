"""Head-to-head between two engine configurations, colour-swapped and seeded so
each pairing plays the same spell draws from both sides. Depth is not strength;
this is the only measurement that settles a tuning question."""
import sys, os, statistics
sys.path.insert(0, os.path.join(os.environ['SCRATCH'],'ref'))
import sigil_engine as se

def game(seed, cfg_red, cfg_blue, max_plies=120):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist=[]; depths={'red':[], 'blue':[]}
    for ply in range(max_plies):
        side = 'red' if ply % 2 == 0 else 'blue'
        cfg = cfg_red if side == 'red' else cfg_blue
        hist.append(b.key_js)
        d,n,dt,over,w,sc,wd = b.play_best(cfg['ms'], 64, 20, 16, cfg['scale'], hist,
                                          cfg.get('eval', 'default'))
        depths[side].append(d)
        if over: return w, ply+1, depths
    return None, max_plies, depths

def match(name_a, cfg_a, name_b, cfg_b, pairs):
    wins={name_a:0, name_b:0}; draws=0; plies=[]; dep={name_a:[], name_b:[]}
    for i in range(pairs):
        for swap in (False, True):
            red_name, red_cfg = (name_b, cfg_b) if swap else (name_a, cfg_a)
            blue_name, blue_cfg = (name_a, cfg_a) if swap else (name_b, cfg_b)
            w, n, d = game(5000+i, red_cfg, blue_cfg)
            plies.append(n)
            dep[red_name] += d['red']; dep[blue_name] += d['blue']
            if w == 'red': wins[red_name] += 1
            elif w == 'blue': wins[blue_name] += 1
            else: draws += 1
    tot = wins[name_a] + wins[name_b] + draws
    print(f"{name_a} vs {name_b}   games {tot} (colour-swapped pairs)")
    print(f"  {name_a}: {wins[name_a]}   {name_b}: {wins[name_b]}   unfinished: {draws}")
    if tot: print(f"  {name_a} score: {100*wins[name_a]/tot:.1f}%")
    print(f"  mean plies {statistics.mean(plies):.1f}")
    for k in (name_a, name_b):
        if dep[k]: print(f"  {k} mean completed depth {statistics.mean(dep[k]):.2f}")

if __name__ == "__main__":
    pairs = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    ms    = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    match("narrow-deep", {'ms':ms,'scale':1}, "wide-shallow", {'ms':ms,'scale':4}, pairs)
