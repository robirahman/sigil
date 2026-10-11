# Sigil Online

Sigil is an abstract two-player strategy game. The repo's main parts:

- **`docs/` — the static GitHub Pages build** that's deployed to the live site. The board, the AI and Firebase-backed online multiplayer all run in the browser. Every vs-AI tier is the Rust engine compiled to WebAssembly (`docs/static/wasm/`); the JS "Caveman" tiers are retired.
- **`engine/` — the Rust engine** (rules kernel, turn enumerator, alpha-beta search), its test and arena harnesses, and the Google Cloud fleet scripts. Start with `engine/README.md`; `engine/STATUS.md` is the current state and `engine/FINDINGS.md` the experiment log.
- **Root Flask app (`app.py`, `game.py`, `simboard.py`, `ai/…`)** — the legacy Python stack from before the Rust engine. `simboard.py` and `notation.py` remain the reference implementations for the engine's parity harnesses; the Python AI in `ai/` (SigilNet / MCTS / AlphaZero self-play) is historical and is not what the site plays.

To work on the static build, serve `docs/` over any static file server (e.g. `python3 -m http.server -d docs 8080`) and open `http://localhost:8080/`.

Engine strength work: the current plan is [`2026-10-training-plan.md`](2026-10-training-plan.md).

## What's New (2026-10-05)

- **Fully offline local play.** After one online visit, the menu, Local 1v1 and vs AI (all Rust
  tiers) start and play with no connection: the service worker (`docs/sw.js`) serves the cached
  `game.html` whatever its query string, gives up on a slow network after 3.5s, and precaches
  every spell's art (derived from `constants.js`), the clock, theme backgrounds and stone sprites.
- **Finished games sync later.** Every finished local game, vs AI *and* Local 1v1 (stored unranked
  with `mode: 'local_1v1'`, the signed-in player on both sides), is written to localStorage before
  any network call (`offline-queue.js`) and uploaded when the Realtime Database connection comes up
  (`.info/connected`), from the game page or the main menu. Each game's `completed_games` key is
  fixed when it is queued and a rated game whose `user_games` entry exists is not rated again, so a
  retried or interrupted upload never duplicates a record or double-counts Elo.
- **Guest games are saved too.** A game finished with nobody signed in is queued as an unranked
  guest record (`guest: true`, the human side a per-device `guest_…` id) and uploads without an
  account; `database.rules.json` lets unauthenticated clients write only such records to
  `completed_games` (deploy with `python -m ai.deploy_db_rules … --apply`).

## What's New (2026-09-17)

- **Puzzles page.** `docs/puzzles.html` (main menu: *Puzzles*) shows a position from a real
  recorded game and asks you to find the forced win, Lichess-style: mate-in-1 (win this turn),
  mate-in-2 (win next turn against any reply) and mate-in-3. The board is the real `GameController`
  driven from the puzzle SFN, so every click is validated by the live rules; your turn is
  judged by the position it produces, and for mate-in-2 a scripted opponent plays the stored
  best defence. The set is a static JSON (`docs/static/puzzles/mate_puzzles.json`) generated
  offline by `tools/gen_mate_puzzles.py` with the Rust engine's new solver (`engine/src/mate.rs`):
  mate-in-1 fully exhaustive at the root; mate-in-2 and mate-in-3 nominated by the strength engine
  (and by the recorded line) then proven against every legal reply at each level. The set is
  generated on a GCE VM by `engine/gcp/launch_puzzles.sh`. A puzzle the opponent can escape on the
  live page therefore points at a rules disagreement between the Rust engine and the browser
  engine -- the page shows a yellow "engine disagreement" box with the SFN when that happens.
  A move off the stored solution is judged live by the wasm engine (exhaustively when only the
  finishing mate is left, else by a search to the puzzle's remaining depth), the AI always replies,
  and play continues after a miss.
  `node tools/puzzle-smoke.js` replays the whole set headlessly through the browser engine.
  The former `puzzles.html` (community position labeling) is now `annotate.html`.

## What's New (2026-05-21)

- **AI game review.** Win modal now offers "AI Review". The engine evaluates every position with reverse-order alpha-beta + shared transposition table, plots a win-rate graph (red top / blue bottom) with classification dots (inaccuracy / mistake / blunder), shows per-player accuracy, and displays a stone-difference eval (`+1.2`, `-M`, etc.) for the cursored ply.
- **Keyboard review navigation.** In any review mode: ← prev, → next, ↑ first, ↓ last. Inputs are ignored when focused.
- **Position-annotation surfaces.** The AI review panel now exposes per-ply move (👍 / 👎) and position (red / even / blue) annotation, highlighted when the engine considers the position ambiguous. A new `docs/puzzles.html` page (linked from the main menu) samples random recent finished games and asks signed-in players to label positions; contributions go to a separate `/community_annotations/{gameId}/{turn}/{kind}/{uid}` Firebase path so post-hoc input never overwrites the game owner's live-game marks.
- **Push retreat highlight.** When pushing presents multiple retreat options, the displaced enemy stone pulses with a yellow ring while the retreat targets glow as before — easier to follow if you glance away.
- **Mana auto-fill.** Casting a spell with mana ≥ empty spell nodes no longer prompts you to click each stone; it fills them all at once.
- **AI think report (optional).** New checkbox on `account.html`: when on, each AI move appends `"Red AI: depth N, X.Xs, M nodes"` to the game log. Persisted on the user profile.

## How to run Sigil Online locally

- **The site:** `python3 -m http.server -d docs 8080`, then open `http://localhost:8080/`. The wasm engine runs in the page, so no build step is needed.
- **The native Rust engine behind the real UI:** see "Playing it in the real web UI" in `engine/README.md` (`engine/server/serve.py`, `game.html?ai=rust_native`).
- **The legacy Flask server** (`flask run` after `pip install -r requirements.txt`) is not maintained: its AI is the pre-Rust Python stack; don't use it to judge the AI.

## Installing front-end dependencies

### Node

You should use the same version of Node as set in `.nvmrc`. You can run [`nvm use`](https://github.com/nvm-sh/nvm) or use [shell integration](https://github.com/nvm-sh/nvm#deeper-shell-integration) to automatically install and switch to the correct version.

Then run `npm install`.

### Linting and formatting

[Prettier](https://prettier.io/), [ESLint](https://eslint.org/) and [StyleLint](https://stylelint.io/) are used to format, find and fix errors in HTML, JS and CSS files.

Running `npm run format` will try to format and fix all files (first CSS, then HTML and JS), however, errors occurred by 1 process will prevent the others from continuing.

If you run in to errors, please correct them and re-`format`.

Alternatively, you can set up editor plugins for each to get realtime feedback on code issues.
