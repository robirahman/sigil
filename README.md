# Sigil Online

Sigil is an abstract two-player strategy game. The repo hosts two builds:

- **`docs/` — the static GitHub Pages build** that's deployed to the live site. The board, AI engine ("Caveman" minimax), and Firebase-backed online multiplayer all run in the browser. This is what `gh-pages-static` deploys.
- **Root Flask app (`app.py`, `game.py`, `simboard.py`, `ai/…`)** — the legacy server stack used for local development, AI training, and offline tooling.

To work on the static build, serve `docs/` over any static file server (e.g. `python3 -m http.server -d docs 8080`) and open `http://localhost:8080/`.

## What's New (2026-05-21)

- **AI game review.** Win modal now offers "AI Review". The engine evaluates every position with reverse-order alpha-beta + shared transposition table, plots a win-rate graph (red top / blue bottom) with classification dots (inaccuracy / mistake / blunder), shows per-player accuracy, and displays a stone-difference eval (`+1.2`, `-M`, etc.) for the cursored ply.
- **Keyboard review navigation.** In any review mode: ← prev, → next, ↑ first, ↓ last. Inputs are ignored when focused.
- **Position-annotation surfaces.** The AI review panel now exposes per-ply move (👍 / 👎) and position (red / even / blue) annotation, highlighted when the engine considers the position ambiguous. A new `docs/puzzles.html` page (linked from the main menu) samples random recent finished games and asks signed-in players to label positions; contributions go to a separate `/community_annotations/{gameId}/{turn}/{kind}/{uid}` Firebase path so post-hoc input never overwrites the game owner's live-game marks.
- **Push retreat highlight.** When pushing presents multiple retreat options, the displaced enemy stone pulses with a yellow ring while the retreat targets glow as before — easier to follow if you glance away.
- **Mana auto-fill.** Casting a spell with mana ≥ empty spell nodes no longer prompts you to click each stone; it fills them all at once.
- **AI think report (optional).** New checkbox on `account.html`: when on, each AI move appends `"Red AI: depth N, X.Xs, M nodes"` to the game log. Persisted on the user profile.

## How to run Sigil Online locally:

1. Install python3 and pip3 (the standard python3 package manager) on your machine. They may already be there; try running `which pip3`, if it returns anything then you already have python3 and pip3. If not, `brew install python3` will install both python3 and pip3 using Homebrew on Mac. On Linux, `apt install python3-pip python3-dev build-essential libssl-dev libffi-dev python3-setuptools` should do it.

2. Clone this Github repo and `cd` into the top-level directory (where the `requirements.txt` file is).

3. Run `pip3 install -r requirements.txt`. This will install all the necessary python3 packages for running Sigil Online locally.

4. From the same directory, run `flask run`. This will launch a lightweight development version of the full Sigil Online server. It should be running at `http://127.0.0.1:5000/`.

5. Visit the above URL in a web browser.

## Installing front-end dependencies

### Node

You should use the same version of Node as set in `.nvmrc`. You can run [`nvm use`](https://github.com/nvm-sh/nvm) or use [shell integration](https://github.com/nvm-sh/nvm#deeper-shell-integration) to automatically install and switch to the correct version.

Then run `npm install`.

### Linting and formatting

[Prettier](https://prettier.io/), [ESLint](https://eslint.org/) and [StyleLint](https://stylelint.io/) are used to format, find and fix errors in HTML, JS and CSS files.

Running `npm run format` will try to format and fix all files (first CSS, then HTML and JS), however, errors occurred by 1 process will prevent the others from continuing.

If you run in to errors, please correct them and re-`format`.

Alternatively, you can set up editor plugins for each to get realtime feedback on code issues.
