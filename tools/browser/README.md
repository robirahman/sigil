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
