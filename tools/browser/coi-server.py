#!/usr/bin/env python3
"""Static server for docs/ that sends COOP/COEP, i.e. a cross-origin-isolated
origin like the one docs/sw.js gives the game pages (threaded engine tests).

    python3 tools/browser/coi-server.py [port] [root]
"""
import http.server, socketserver, sys, functools

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
root = sys.argv[2] if len(sys.argv) > 2 else 'docs'
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', port), functools.partial(H, directory=root)) as srv:
    srv.serve_forever()
