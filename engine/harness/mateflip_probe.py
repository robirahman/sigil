"""Why does the engine announce +0.5 and then get mated?

Three candidate causes, and they need different fixes, so guessing between
them is the expensive mistake:

  ENUMERATION  the mating reply cannot be generated. Check B now says this is
               ZERO for rust-to-move positions, so it should not appear here.
  WIDTH        the reply CAN be generated but `move_score` ranks it past the
               progressive-widening budget -- 24 turns near the frontier
               against a median branching of 316 -- so the search never
               expands it. Not an enumeration gap and not an eval error.
  EVALUATION   the reply is inside the budget and searched, and the engine
               still scores the position wrongly. Only this one is fixed by
               touching weights.

For each case: score position i at depths 4, 6 and 8 (does deepening reveal
the loss?), and measure the RANK of the opponent's actual reply in the
ordered stream from position i+1 (was it ever visible?).

Reference widths: `width_for_depth` at width_scale 4 runs 24 near the
frontier up to 160 at the root, so a rank above ~160 is invisible everywhere
and a rank under 24 is always seen.
"""
import json, os, sys, time, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
MERGE_OFF = 1 << 62


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


def score(sfn, depth, ms):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(ms, depth, 20, 16, se.DEFAULT_WIDTH_SCALE, [], 'tfit',
                    False, MERGE_OFF, adaptive=shipped_adaptive())
    # (depth_completed, nodes, secs, over, winner, score, widened)
    return int(r[5]), int(r[0])


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', default='data/mateflip_cases.json')
    ap.add_argument('--shards', type=int, default=1)
    ap.add_argument('--depths', default='4:6:8')
    ap.add_argument('--ms', type=int, default=900_000,
                    help='per-search time cap; depth 8 is unmeasured, so cap '
                         'it and report depth_completed rather than hanging')
    ap.add_argument('--rank-cap', type=int, default=4096)
    args = ap.parse_args()
    depths = [int(x) for x in args.depths.replace(':', ',').split(',') if x]

    cases = json.loads(fetch(args.cases))
    off = int(os.environ.get('SIGIL_SHARD_OFF', '0'))
    shard = (off // 1000) % max(1, args.shards)
    mine = [c for i, c in enumerate(cases) if i % args.shards == shard]
    print(f"shard {shard}/{args.shards}: {len(mine)} of {len(cases)} cases, "
          f"depths {depths}", flush=True)

    for c in mine:
        out = {'game': c['game'], 'ply': c['ply'],
               'score0_at_flag': c['score0'], 'window': c['window'],
               'flag_depth': c['depth']}
        # 1. WIDTH: rank of the opponent's actual reply from position i+1.
        try:
            b1 = se.Board.from_sfn(c['sfn_i1'])
            mover1 = 'red' if c['sfn_i1'].split()[1] == 'r' else 'blue'
            tgt = se.Board.from_sfn(c['sfn_i2']).stones
            rank, scanned, found = b1.layout_rank(
                mover1, tgt[0], tgt[1], 24, 0, args.rank_cap)
            out['reply_rank'] = rank
            out['reply_found'] = found
            out['ranked_scanned'] = scanned
        except Exception as e:
            out['rank_error'] = str(e)[:120]
        # 2. DEEPENING: does a deeper search see the loss from position i?
        for d in depths:
            t0 = time.perf_counter()
            try:
                sc, done = score(c['sfn_i'], d, args.ms)
                out[f'score_d{d}'] = sc
                out[f'depth_done_d{d}'] = done
                out[f'secs_d{d}'] = round(time.perf_counter() - t0, 1)
            except Exception as e:
                out[f'error_d{d}'] = str(e)[:120]
                break
        print("PROBE " + json.dumps(out), flush=True)


if __name__ == '__main__':
    main()
