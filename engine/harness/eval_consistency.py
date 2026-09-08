"""Does the engine's OWN announced eval ever collapse against its OWN play?

This is the property stated directly, with nothing else in the way.

Every earlier measurement has an attribution hole. Check A over recorded games
re-scores a position after the ACTUAL continuation, but that continuation was
played by somebody else -- a human, an older AI tier, or the deployed WASM
build -- so a collapse can mean "the mover blundered" or "a different engine
moved", neither of which is this engine's eval being wrong. That is why 94.8%
of Check A's flags had someone else to move, and why 52% of the mate flips are
invisible even at depth 8: the engine is not claiming it can hold the line that
was actually played, it is claiming it can hold ITS OWN line.

So: let the engine play BOTH sides from a position and watch its own
announcements. Robi's bound applies without qualification here -- every move
places a stone, so a horizon effect costs at most ~0.5 stones per half-move,
and the engine's own eval for one side declining faster than that against its
own play is the engine contradicting itself. No opponent model, no record
artifacts, no unreachable turns, nobody else to blame.

    eval_consistency.py --positions <gcs obj or 'selfplay'> --plies 12 \
                        --depth 4 --limit 0.5
"""
import argparse, json, os, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
MERGE_OFF = 1 << 62
STONE = 4096
MATE = 1_000_000


def shipped_adaptive():
    a = getattr(se, 'SHIPPED_ADAPTIVE', None)
    return tuple(a) if a else None


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


def play_one(b, depth, ms, hist):
    """One move at the shipped config. Returns the announced score, from the
    perspective of the side that just moved, plus whether the game ended."""
    r = b.play_best(ms, depth, 20, 16, se.DEFAULT_WIDTH_SCALE, list(hist),
                    'tfit', False, MERGE_OFF, adaptive=shipped_adaptive())
    # (depth_completed, nodes, secs, over, winner, score, widened)
    return int(r[5]), bool(r[3]), r[4]


def run(sfn, plies, depth, ms, limit, tag):
    b = se.Board.from_sfn(sfn)
    hist = []
    # Announced score per side, in the order that side announced it.
    seq = {'red': [], 'blue': []}
    flags = []
    for k in range(plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        hist.append(b.key_js)
        try:
            sc, over, winner = play_one(b, depth, ms, hist)
        except Exception as e:
            return flags, f'play failed at ply {k}: {str(e)[:100]}'
        seq[side].append((k, sc, b.to_sfn()))
        # Compare this side's announcement with its PREVIOUS announcement. Two
        # of its own announcements are two half-moves apart in game terms, so
        # the envelope is 2 * limit over that gap.
        s = seq[side]
        if len(s) >= 2:
            (k0, s0, sfn0), (k1, s1, sfn1) = s[-2], s[-1]
            gap = k1 - k0
            c0 = max(-20 * STONE, min(20 * STONE, s0))
            c1 = max(-20 * STONE, min(20 * STONE, s1))
            per_ply = (c0 - c1) / gap / STONE
            mate_flip = s1 <= -MATE and s0 >= -0.5 * STONE
            if per_ply > limit or mate_flip:
                flags.append({'tag': tag, 'side': side, 'ply_from': k0,
                              'ply_to': k1, 'score_from': s0, 'score_to': s1,
                              'perPly': round(per_ply, 3),
                              'mateFlip': mate_flip, 'sfn_from': sfn0,
                              'sfn_to': sfn1})
        if over:
            break
    return flags, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--positions', default='selfplay')
    ap.add_argument('--games', type=int, default=40)
    ap.add_argument('--plies', type=int, default=14)
    ap.add_argument('--depth', type=int, default=4)
    ap.add_argument('--ms', type=int, default=0,
                    help='0 = fixed DEPTH, which is what makes this repeatable')
    ap.add_argument('--limit', type=float, default=0.5)
    ap.add_argument('--shards', type=int, default=1)
    args = ap.parse_args()

    off = int(os.environ.get('SIGIL_SHARD_OFF', '0'))
    shard = (off // 1000) % max(1, args.shards)

    starts = []
    if args.positions == 'selfplay':
        # Fresh games from the shipped opening, so nothing about the corpus can
        # contaminate it.
        for g in range(args.games):
            seed = 9_000_000 + off + g
            b = se.Board(se.Board.legal_draw(seed), 'standard')
            b.setup_initial()
            starts.append((f'seed{seed}', b.to_sfn()))
    else:
        cases = json.loads(fetch(args.positions))
        for i, c in enumerate(cases):
            if i % args.shards != shard:
                continue
            starts.append((f"{c['game']}@{c['ply']}", c.get('sfn_i') or c['sfnBefore']))

    print(f"shard {shard}/{args.shards}: {len(starts)} starts, "
          f"{args.plies} plies at depth {args.depth}, envelope {args.limit}"
          f"/half-move", flush=True)
    n_flag = 0
    for tag, sfn in starts:
        flags, err = run(sfn, args.plies, args.depth, args.ms, args.limit, tag)
        if err:
            print(f"  SKIP {tag}: {err}", flush=True)
            continue
        for f in flags:
            n_flag += 1
            print("SELFFLAG " + json.dumps(f), flush=True)
    print(f"DONE starts={len(starts)} self-inconsistencies={n_flag}", flush=True)


if __name__ == '__main__':
    main()
