"""Pool the SHARD lines of a fleet arena into ONE estimate with an interval.

    pool_shards.py <dir_of_shard_logs>

Each shard runs its own SPRT and prints its own verdict, which is the right thing
per shard and the wrong thing to read as a result: 264 independent SPRTs at
alpha=0.05 will produce ~13 spurious "accepts H1" by construction. Pool first.

Reports a point estimate and a 95% interval, because for a change that alters the
search's decision on only ~6% of nodes the verdict is a foregone conclusion and the
INTERVAL is the whole answer -- "+2 +- 5" and "+20 +- 5" both "accept H0" against
H1 = +25, and they mean completely different things.

Draw-free Bernoulli, so Elo = -400 * log10(1/p - 1) and the interval comes from the
Wilson interval on p, which behaves near p = 0 or 1 where the normal one does not.
"""
import glob, math, os, re, sys


def elo(p):
    if p <= 0:
        return float('-inf')
    if p >= 1:
        return float('inf')
    return -400.0 * math.log10(1.0 / p - 1.0)


def wilson(w, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def main():
    d = sys.argv[1]
    files = glob.glob(os.path.join(d, '*.log'))
    W = L = U = 0
    shards = complete = 0
    verdicts = {}
    cfg = set()
    for f in files:
        t = open(f, errors='ignore').read()
        # Count from the GAME lines, NOT the SHARD summary. ab_search prints SHARD
        # only after its loop finishes, so a shard the VM watchdog kills mid-run
        # contributes nothing to a SHARD-based pool and its games vanish silently --
        # the games are right there in the log, already uploaded, being thrown away.
        games = re.findall(r'^GAME seed=\d+ arm=(\w+) winner=(\w+)', t, re.M)
        if not games:
            continue
        shards += 1
        for arm_c, win_c in games:
            if win_c == 'None':
                U += 1
            elif win_c == arm_c:
                W += 1
            else:
                L += 1
        m = re.search(r'^SHARD .*?n=(\d+) armwins=(\d+) basewins=(\d+) unf=(\d+)',
                      t, re.M)
        if m:
            complete += 1
            # cross-check: the shard's own tally must match what we counted
            if int(m.group(2)) != sum(1 for a, w in games if w == a):
                print(f"  WARNING {os.path.basename(f)}: SHARD armwins={m.group(2)} "
                      f"but {sum(1 for a, w in games if w == a)} GAME lines say otherwise")
        v = re.search(r'^SPRT.*?(H0|H1|continue)', t, re.M)
        if v:
            verdicts[v.group(1)] = verdicts.get(v.group(1), 0) + 1
        c = re.search(r'ENGINE CONFIG\s+(.*)', t)
        if c:
            cfg.add(c.group(1).strip())

    n = W + L
    print(f"{shards} shards with games, {complete} reached their own SPRT verdict, "
          f"{len(files)} logs seen")
    if len(cfg) == 1:
        print(f"config: {next(iter(cfg))}")
    elif len(cfg) > 1:
        print(f"WARNING: {len(cfg)} DIFFERENT engine configs pooled - refusing to")
        print("         average over arms that were not the same experiment:")
        for c in sorted(cfg):
            print(f"  {c}")
        sys.exit(1)
    print(f"per-shard verdicts (NOT the result, see docstring): {verdicts}")
    if n == 0:
        sys.exit("no decisive games")
    p = W / n
    lo, hi = wilson(W, n)
    print(f"\npooled: {n} decisive games ({U} unfinished), arm {W} / base {L}")
    print(f"score  {p*100:.2f}%   [{lo*100:.2f}%, {hi*100:.2f}%]")
    print(f"ELO   {elo(p):+.1f}   [{elo(lo):+.1f}, {elo(hi):+.1f}]")
    se = 347.0 / math.sqrt(n)
    print(f"       (+-{1.96*0.5/math.sqrt(n)*100:.2f} pp, ~{se*1.96:.1f} Elo at 95%)")
    if lo > 0.5:
        print("VERDICT: positive, interval excludes zero")
    elif hi < 0.5:
        print("VERDICT: NEGATIVE, interval excludes zero")
    else:
        print("VERDICT: indistinguishable from zero at this sample size")


if __name__ == '__main__':
    main()
