#!/usr/bin/env python3
"""Serve the real Sigil web UI locally, with the Rust engine as the opponent.

    python engine/server/serve.py --docs docs --port 8000 --time 60
    open http://localhost:8000/game.html?ai=rust

HOW IT AVOIDS A TRANSLATION LAYER
The browser already knows how to enumerate its own legal turns, apply them, and
animate them. So it does exactly that: it enumerates, applies each candidate with
its OWN rules, and POSTs the resulting positions here as SFN. This process searches
from each and returns the index of the best one. The browser then applies that turn
through the normal `applyAITurn` path, so animations, the action log, and the
recorded game history all behave like any other AI.

Nothing about the engine's turn representation crosses the wire, which matters:
a `Cast` action carries an outcome index into the engine's own enumeration that the
JS side could not apply.

HONEST LIMITATION
The engine can only choose among the turns the browser offered. The browser's
enumerator is capped (ENUM_CAPS), whereas the standalone engine generates ~4,000x
more turns per position, so this is a weaker configuration than the arena numbers.
The response includes `candidates` so the UI can show how wide the choice was.
"""
import argparse, json, os, sys, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
import sigil_engine as se

ARGS = None
STATS = {'moves': 0, 'nodes': 0, 'seconds': 0.0}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ARGS.docs, **kw)

    def log_message(self, fmt, *a):
        if ARGS.verbose: super().log_message(fmt, *a)

    def end_headers(self):
        # Local dev only: the page and the API share an origin, but be explicit.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        route = self.path.rstrip('/')
        if route == '/api/move': return self._do_move()
        if route != '/api/pick':
            self.send_error(404, 'unknown endpoint'); return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
            sfns = req.get('sfns') or []
            us = req.get('us') or 'blue'
            # The browser tracks repetition as its own snapshot strings, which are
            # not our Zobrist keys, so it sends the prior POSITIONS and we derive
            # keys ourselves. Threefold repetition is a blue win, so the search
            # needs this to see rep-forced results.
            hist = []
            for h in (req.get('history_sfns') or []):
                try: hist.append(se.Board.from_sfn(h).key_js)
                except Exception: pass          # out-of-scope history is skippable
            hist += [int(x) for x in (req.get('history') or [])]
            budget = int(req.get('time_ms') or ARGS.time * 1000)
            if not sfns:
                self._json({'ok': False, 'error': 'no candidates supplied'}); return
            t0 = time.perf_counter()
            idx, score, depth, nodes, secs, parsed = se.pick_successor(
                sfns, us, budget, 64, 21, ARGS.width_scale, hist)
            STATS['moves'] += 1; STATS['nodes'] += nodes; STATS['seconds'] += secs
            print(f"  move {STATS['moves']:3d}  {parsed:5d} candidates  "
                  f"depth {depth:2d}  {nodes:>10,} nodes  {secs:5.1f}s  "
                  f"eval {score/100:+.2f} stones  -> #{idx}", flush=True)
            self._json({'ok': True, 'index': idx, 'score': score, 'depth': depth,
                        'nodes': nodes, 'seconds': round(secs, 2),
                        'candidates': parsed})
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json({'ok': False, 'error': f'{type(e).__name__}: {e}'}, code=500)

    def _do_move(self):
        """The engine chooses from its OWN full enumeration and returns a JS action
        list plus the position that list must produce, so the browser is not capped
        by its own ENUM_CAPS."""
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
            sfn = req.get('sfn')
            if not sfn: self._json({'ok': False, 'error': 'no sfn'}); return
            budget = int(req.get('time_ms') or ARGS.time * 1000)
            hist = list(req.get('history_sfns') or [])
            aj, expected, depth, nodes, score, secs, score_ui = se.pick_move_actions(
                sfn, budget, 64, 21, ARGS.width_scale, hist, ARGS.eval)
            acts = json.loads(aj)
            STATS['moves'] += 1; STATS['nodes'] += nodes; STATS['seconds'] += secs
            kinds = ','.join(a['type'] for a in acts)
            print(f"  move {STATS['moves']:3d}  depth {depth:2d}  {nodes:>10,} nodes  "
                  f"{secs:5.1f}s  eval {score/100:+.2f}  [{kinds}]", flush=True)
            # `score` stays in centistones for our own logs; `score_ui` is in the
            # units game-board-local.js renders (see search::ui_score).
            self._json({'ok': True, 'actions': acts, 'expected_sfn': expected,
                        'depth': depth, 'nodes': nodes, 'score': score,
                        'score_ui': score_ui, 'seconds': round(secs, 2)})
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json({'ok': False, 'error': f'{type(e).__name__}: {e}'}, code=500)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument('--docs', default=None, help="path to the repo's docs/ directory")
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--time', type=int, default=60, help='seconds per move')
    ap.add_argument('--width-scale', type=int, default=1)
    ap.add_argument('--eval', default='material',
                    choices=['material', 'classic', 'mc', 'manavoid', 'mix', 'default'],
                    help="leaf eval; 'material' is the only one that beat the "
                         "shipped engine in the arenas")
    ap.add_argument('--verbose', action='store_true')
    ARGS = ap.parse_args()
    if ARGS.docs is None:
        guess = os.path.join(os.path.dirname(os.path.dirname(_HERE)), 'docs')
        ARGS.docs = guess
    if not os.path.isdir(ARGS.docs):
        sys.exit(f"--docs not found: {ARGS.docs}\n"
                 f"Point it at the repo's docs/ directory.")
    if not os.path.isfile(os.path.join(ARGS.docs, 'game.html')):
        sys.exit(f"{ARGS.docs} has no game.html — is that the docs/ directory?")
    print(f"serving {ARGS.docs} on http://localhost:{ARGS.port}")
    print(f"engine: {ARGS.time}s/move, width_scale {ARGS.width_scale}, eval {ARGS.eval}")
    print(f"\n  open  http://localhost:{ARGS.port}/game.html?ai=rust\n")
    print("  the engine chooses from its full enumeration; the browser verifies")
    print("  each action list reproduces the engine's position before playing it\n")
    ThreadingHTTPServer(('127.0.0.1', ARGS.port), Handler).serve_forever()

if __name__ == '__main__':
    main()
