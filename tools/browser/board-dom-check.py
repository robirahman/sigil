#!/usr/bin/env python3
"""Check that every board page nests its stone layer inside the board frame.

Stones are absolutely positioned with left/top/width/height in percent, so they
must sit inside the square board frame (the `position:relative` div that carries
--board-ref). multiplayer.html once lost its `<div class="spells">` opener; the
orphaned `</div>` closed the frame early, the stones resolved against the page
container instead, and they stretched and drifted with the window size.

    python3 tools/browser/board-dom-check.py [docs-dir]
"""
import sys
from html.parser import HTMLParser
from pathlib import Path

PAGES = ['game.html', 'multiplayer.html', 'puzzles.html', 'annotate.html']
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'source', 'track', 'wbr', 'path', 'circle', 'line', 'rect',
        'polyline', 'polygon', 'use', 'ellipse'}
FRAME = 'position:relative'


class Nesting(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []      # (tag, classes)
        self.found = []      # ancestor class lists of each .stone-nodes

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        classes = (dict(attrs).get('class') or '').split()
        if 'stone-nodes' in classes:
            self.found.append([c for _, c in self.stack])
        self.stack.append((tag, classes))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        while self.stack and self.stack[-1][0] != tag:
            self.stack.pop()
        if self.stack:
            self.stack.pop()


def main():
    docs = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'docs')
    bad = 0
    for name in PAGES:
        p = Nesting()
        p.feed((docs / name).read_text())
        if not p.found:
            print(f'FAIL {name}: no .stone-nodes')
            bad += 1
            continue
        for ancestors in p.found:
            if ancestors and FRAME in ancestors[-1]:
                print(f'ok   {name}')
            else:
                parent = ' '.join(ancestors[-1]) if ancestors else '(root)'
                print(f'FAIL {name}: .stone-nodes is inside "{parent}", not the board frame')
                bad += 1
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
