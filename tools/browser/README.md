# Headless browser checks for the Puzzles page

Real Chrome via puppeteer (the wasm engine runs in its worker), against a
`python3 -m http.server` of `docs/`. Not part of `npm install`; set up once,
with caches off `$HOME` on Cloud Shell:

```sh
mkdir -p /tmp/pup && cd /tmp/pup
export npm_config_cache=/tmp/npmcache PUPPETEER_CACHE_DIR=/tmp/pup/cache
npm init -y >/dev/null && npm install puppeteer@23
node <repo>/tools/browser/puzzle-page-test.js <repo>/docs 0            # load + Show solution
node <repo>/tools/browser/puzzle-flow-test.js <repo>/docs 0 correct    # play the stored mate-in-1
node <repo>/tools/browser/puzzle-flow-test.js <repo>/docs 595 wrong    # off-line move: engine judge + reply
```

Both print the Alpine component state and every console / page error. The
`solution_keys` regression (Show solution threw) was found this way.

```sh
node <repo>/tools/browser/review-evals-test.js https://sigilbattle.com <roomCode>   # stored Rust evals in the review panel
```

`review-evals-test.js` needs Firebase, so it runs against the live site: it
opens `multiplayer.html?id=<roomCode>`, starts the review and checks it came
from `game_evals/<roomCode>` (source `rust`) rather than the Caveman search.

Two Cloud Shell gotchas (2026-09-21): Chrome refuses to launch when `TMPDIR`
points under the scratchpad -- unset it and let it use `/tmp`; and it needs
`--disable-dev-shm-usage` (all three scripts pass it).

```sh
node <repo>/tools/browser/resume-log-test.js http://localhost:8765   # reload mid-game: no turn lost
```

`resume-log-test.js` plays three turns against the Easy AI, reloads, plays
one more and checks that the turn log has no gap (the 2026-09 missing-turn
records). Any Chrome works: `PUPPETEER_EXECUTABLE_PATH=<chrome>`.

## Board nesting check

```sh
python3 tools/browser/board-dom-check.py docs
```

No dependencies. Fails if a board page's `.stone-nodes` layer is not inside the square board
frame (`position:relative`). Stones are sized and placed in percent of their containing block, so
outside the frame they stretch and drift with the window (multiplayer.html, fixed 2026-10-22).

## Analysis board

```sh
node tools/browser/analysis-test.js docs [port] [--coi]   # editor round trip, move tree, keys, engine eval
```

Checks `analysis.html`: the editor exports an SFN that reloads identically (URL and
Load box), a turn played from an earlier node adds a variation, the arrow keys
navigate the tree, the wasm engine evaluates the node and its best turn plays, and
`openAnalysis()` (the review "Analyse" button) opens the game line. `--coi` serves
with COOP/COEP for the threaded engine.
