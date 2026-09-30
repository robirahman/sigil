#!/usr/bin/env python3
"""Local dev server for the spell-survey harness and the spell charts page.

Serves docs/ like `python3 -m http.server`, plus two endpoints:
  POST /dev/save-survey    write the posted export to <save-dir>/spell-survey-<date>.json
                           (overwrites that day's file; the pattern is gitignored)
  GET  /dev/latest-survey  the newest export (by exportedAt) among <save-dir>/spell-survey-*.json
                           and docs/strategy/survey_exports/*.json

usage: python3 tools/survey_server.py [port] [save-dir]
       port defaults to 8000 (binds 127.0.0.1 only); save-dir defaults to the repo root
"""
import datetime, functools, glob, http.server, json, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(REPO, 'docs')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
SAVE_DIR = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else REPO


def latest_export():
    best = None
    saved = glob.glob(os.path.join(SAVE_DIR, 'spell-survey-*.json'))
    for path in saved + glob.glob(os.path.join(DOCS, 'strategy', 'survey_exports', '*.json')):
        try:
            with open(path) as f: data = json.load(f)
        except (OSError, ValueError):
            continue
        key = (data.get('exportedAt', ''), path in saved, os.path.getmtime(path))  # ties: prefer the saved copy
        if best is None or key > best[0]: best = (key, path, data)
    return best


class Handler(http.server.SimpleHTTPRequestHandler):
    def _json(self, obj, extra_headers=()):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        for k, v in extra_headers: self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] != '/dev/latest-survey':
            return super().do_GET()
        best = latest_export()
        if best is None:
            return self.send_error(404, 'no survey exports found')
        self._json(best[2], [('X-Survey-File', os.path.basename(best[1]))])

    def do_POST(self):
        if self.path != '/dev/save-survey':
            return self.send_error(404)
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n > 20_000_000: raise ValueError('too large')
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or 'spells' not in data or 'pairs' not in data:
                raise ValueError('not a survey export')
        except Exception as e:
            return self.send_error(400, str(e))
        path = os.path.join(SAVE_DIR, f'spell-survey-{datetime.date.today().isoformat()}.json')
        with open(path, 'w') as f:
            json.dump(data, f, indent=1); f.write('\n')
        self._json({'path': path})


if __name__ == '__main__':
    print(f'serving {DOCS} on http://localhost:{PORT}/dev/spell-survey.html; saves go to {SAVE_DIR}')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=DOCS)).serve_forever()
