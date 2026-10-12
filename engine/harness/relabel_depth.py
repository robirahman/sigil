"""Label-depth experiment (2026-10-12): re-score selfplay_v2 positions at a deeper depth.

    relabel_depth.py <chunk-list> <depth> <out_dir> <n_shards> [max_positions=0]

`chunk-list` is a text file (local or gs://) of selfplay_v2 chunk paths. This
shard (s = $SIGIL_SHARD_OFF // 1000 - its first shard number in the list header,
see below) takes chunks s, s + n_shards, s + 2 n_shards, ... For every position
it runs the SHIPPED search (eval, generator policy, exploration tail, adaptive
widening; `root_scores_and_play` with play=False) to exactly `depth` plies, with
no clock, and writes a chunk carrying only what `nn_eval.py prep` reads (sfn,
spells, is_red, y, game, ply, kind, full) with `score` replaced by the deeper
score. The original score is kept as `score_orig`. The game's earlier positions
in the chunk are passed as repetition history, as the generator had them.

The first line of the chunk list may be `# shard_base=<k>`: shard numbers
(off // 1000) start at k, so a fleet with SHARD_BASE k*... maps onto 0..n-1.
"""
import json, os, sys, time, urllib.parse, urllib.request
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

KEEP = ('sfn', 'spells', 'is_red', 'y', 'game', 'ply', 'kind', 'full')


def _fetch(path):
    if not path.startswith('gs://'):
        return open(path, 'rb').read()
    bucket, name = path[5:].split('/', 1)
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'}), timeout=15))['access_token']
    url = (f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
           f'{urllib.parse.quote(name, safe="")}?alt=media')
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={'Authorization': f'Bearer {tok}'}), timeout=300).read()


def main():
    a = sys.argv[1:]
    listing, depth, out_dir, n_shards = a[0], int(a[1]), a[2], int(a[3])
    max_pos = int(a[4]) if len(a) > 4 else 0
    lines = _fetch(listing).decode().split('\n')
    base = 0
    if lines and lines[0].startswith('# shard_base='):
        base = int(lines[0].split('=')[1]); lines = lines[1:]
    chunks = [l.strip() for l in lines if l.strip() and not l.startswith('#')]
    s = shard_offset() // 1000 - base
    mine = chunks[s::n_shards] if 0 <= s < n_shards else []
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_opening_book(False)
    ev = se.SHIPPED_EVAL
    os.makedirs(out_dir, exist_ok=True)
    print(f"  shard {s}/{n_shards}: {len(mine)} chunks, depth {depth}, eval {ev}", flush=True)
    t0 = time.time(); npos = 0
    for path in mine:
        name = os.path.basename(path).replace('.npz', f'_d{depth}.npz')
        dst = os.path.join(out_dir, name)
        if os.path.exists(dst):
            continue
        tmp = '/tmp/_relabel_in.npz'
        open(tmp, 'wb').write(_fetch(path))
        z = np.load(tmp)
        out = {k: z[k] for k in KEEP}
        scores = np.zeros(len(out['sfn']), np.int32)
        hist, last_game = [], None
        for i, sfn in enumerate(out['sfn']):
            g = int(out['game'][i])
            if g != last_game:
                hist, last_game = [], g
            b = se.Board.from_sfn(str(sfn))
            hist.append(b.key_js)
            _s, sc, *_ = b.root_scores_and_play(depth, ev, False, 1, list(hist), False)
            scores[i] = sc
        out['score'] = scores
        out['score_orig'] = z['score']
        out['meta'] = np.asarray(json.dumps({'relabel_depth': depth, 'eval': ev, 'src': path}))
        np.savez_compressed(dst + '.tmp.npz', **out)
        os.replace(dst + '.tmp.npz', dst)
        npos += len(scores)
        el = time.time() - t0
        print(f"  {name}: {len(scores)} positions; total {npos}, {el:.0f}s, {npos / el * 3600:.0f} pos/h", flush=True)
        if max_pos and npos >= max_pos:
            break
    print(f"WROTE {npos} positions at depth {depth} in {time.time() - t0:.0f}s", flush=True)


if __name__ == '__main__':
    main()
