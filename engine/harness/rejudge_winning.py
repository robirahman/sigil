"""Re-judge winning-turn puzzle positions with the current tools/winning_turns.py.

    rejudge_winning.py <positions.json | gs://bucket/object> <n_shards>

`positions.json` is a list of [key, sfn, played_after_sfn_or_null] (the work-file
key gen_mate_puzzles.py uses, "<gameId>:t<turn>"). Shard i ($SIGIL_SHARD_OFF / 1000)
takes the entries at positions i mod n_shards. Each verdict is printed as
`WORK {"key": ..., "result": ...}`, the line format of the generator's
--winning-work file, so the lines drop straight into one.

Used when the winning-turn rule tightens: a stricter rule can only remove
puzzles, so re-judging the current puzzles is enough.
"""
import json, os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(_REPO, 'tools'))
import winning_turns


def load(src):
    if src.startswith('gs://'):
        import urllib.parse, urllib.request          # the VM venv has no requests
        bucket, name = src[5:].split('/', 1)
        req = urllib.request.Request(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            headers={'Metadata-Flavor': 'Google'})
        tok = json.load(urllib.request.urlopen(req, timeout=10))['access_token']
        req = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
                                     + urllib.parse.quote(name, safe='') + '?alt=media',
                                     headers={'Authorization': 'Bearer ' + tok})
        return json.load(urllib.request.urlopen(req, timeout=120))
    if not os.path.isabs(src) and not os.path.exists(src):
        src = os.path.join(_REPO, src)
    with open(src, encoding='utf-8') as fh:
        return json.load(fh)


def main():
    items, n = load(sys.argv[1]), int(sys.argv[2])
    shard = int(os.environ.get('SIGIL_SHARD_OFF', '0')) // 1000
    mine = [x for i, x in enumerate(items) if i % n == shard % n]
    print(f'  CONFIG shard={shard}/{n} positions={len(mine)}', flush=True)
    for key, sfn, after in mine:
        res = winning_turns.analyze_position(sfn, after)
        print('WORK ' + json.dumps({'key': key, 'result': res}, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
