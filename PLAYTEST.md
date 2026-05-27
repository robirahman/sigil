# Playtesting the self-play-trained AI locally

This lets a human play the **medium `SigilNet`** (the AlphaZero-style net the
self-play loop trains) in the browser, on any machine, without touching the
self-play workstation. Every game is recorded to an SGN transcript for review.

## Setup (one time)

Requires Python 3.10–3.14. From the repo root:

```bash
python3 -m venv .venv
. .venv/bin/activate

# PyTorch — CPU build is fine for playtesting (MCTS NN evals are small):
pip install torch --index-url https://download.pytorch.org/whl/cpu
#   (AMD ROCm GPU instead? use e.g. --index-url https://download.pytorch.org/whl/rocm6.4)

# Web + runtime deps (modern versions; the pinned requirements.txt is legacy):
pip install numpy Flask flask-sock Flask-Login Flask-SQLAlchemy simple-websocket pytz
```

## Run

```bash
. .venv/bin/activate
FLASK_APP=app.py flask run --host 127.0.0.1 --port 5000
```

Then open: **http://127.0.0.1:5000/single-player?difficulty=medium**

The AI opponent is the medium MCTS net. On a fresh checkout it plays the
committed `ai/models/best_model.pt`. To play a specific checkpoint, drop a `.pt`
in `ai/models/` and pass it; the route resolves these query params:

| Param | Default | Meaning |
|-------|---------|---------|
| `ckpt` | `snapshot` | `snapshot`→`eval_medium_current.pt`, `baseline`→`best_model_preloop_*.pt`, `live`→`best_model.pt`. Missing files fall back to `best_model.pt`. |
| `sims` | `1600` | MCTS simulations per move (more = stronger, slower) |
| `tlimit` | `60` | hard cap seconds/move (whichever limit hits first) |

Example: `…/single-player?difficulty=medium&sims=2400&tlimit=90`

To play the stronger production net instead, use `?difficulty=hard` (the 44M
`SigilNetHard`; its checkpoint reassembles from `ai/models/best_model_hard_part_*`).

## Transcripts

Completed (and disconnected) games auto-save to `games/game_<timestamp>.sgn`.
Send those back for move-by-move review. The AI's MCTS positions also save to
`ai/data/human_game_<timestamp>.jsonl` (not used for training unless you choose).

## Notes
- The dev server is single-user; `flask run` is threaded so the long-lived game
  websocket doesn't block asset loads. Don't expose it publicly.
- Per-move think time scales with `sims`/`tlimit` and your CPU; lower `sims` for
  snappier play, raise it for a stronger opponent.
