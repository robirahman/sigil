#!/usr/bin/env python3
"""Contrast rules for the themes in tools/themes/palettes.json.

Measures every theme on the art build_theme_assets.py rendered for it (Arcane on
the original art) and fails when a theme is harder to read than both the
absolute floor and Arcane, the reference theme:

  stones      the two players differ (CIEDE2000), also under protanopia and
              deuteranopia (Machado et al. 2009, severity 1)
  stone/node  each stone against an empty node (WCAG contrast ratio)
  stone/board each stone against the board round every empty node (the
              darkest-contrast node counts)
  node/board  an empty node (or its rim) against the board round it
  wall        a Fissure wall against an empty node, and not a stone's colour
  outline     the last-play outline against both stones
  text        body text 4.5:1 and muted text 3:1 on the page and surfaces

    python3 tools/themes/check_themes.py    # exit 1 on any failure
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from build_theme_assets import (IMAGES, OUT, PALETTES, classify_nodes, disc, hex_rgb,  # noqa: E402
                                node_centres, theme_tokens)

# Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB.
CVD = {
    'protan': np.array([[0.152286, 1.052583, -0.204868],
                        [0.114503, 0.786281, 0.099216],
                        [-0.003882, -0.048116, 1.051998]]),
    'deutan': np.array([[0.367322, 0.860646, -0.227968],
                        [0.280085, 0.672501, 0.047413],
                        [-0.011820, 0.042940, 0.968881]]),
}
FLOOR = {'stones': 40, 'stones_cvd': 25, 'stone_node': 3.0, 'stone_board': 3.0,
         'node_board': 3.0, 'wall_node': 3.0, 'wall_stone': 15, 'outline': 3.0}
ROOT_DEFAULTS = {'--color-text': '#dddcdd', '--color-text-muted': '#999999',
                 '--color-surface': '#1a1a2e', '--color-bg': '#21122c', '--color-bg-dark': '#0d0513'}


def lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def unlin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def rel_lum(c):
    l = lin(c)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def ratio(a, b):
    la, lb = rel_lum(a), rel_lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def lab(c):
    l = lin(c)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = m @ l / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def de2000(c1, c2):
    L1, a1, b1 = lab(c1)
    L2, a2, b2 = lab(c2)
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = h2p - h1p
    dhp = dhp - 360 if dhp > 180 else dhp + 360 if dhp < -180 else dhp
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = (h1p + h2p) / 2 + (180 if abs(h1p - h2p) > 180 else 0)
    T = (1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp))
         + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63)))
    SL = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2)
    SC, SH = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    RT = (-2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
          * np.sin(np.radians(60 * np.exp(-((hbp - 275) / 25) ** 2))))
    return float(np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * dCp / SC * dHp / SH))


def simulate(c, kind):
    return unlin(CVD[kind] @ lin(c))


def stone_colour(path):
    """The stone's body colour: the mean of its mid-luminance opaque pixels."""
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    l = rel_lum(rgb)
    m = alpha > 0.9
    lo, hi = np.percentile(l[m], [30, 70])
    sel = m & (l >= lo) & (l <= hi)
    return rgb[sel].mean(axis=0)


def measure(tid, theme, centres):
    if theme.get('assets'):
        board = OUT / f'game-board-{tid}.jpg'
        stones = [OUT / 'stones' / f'{tid}-{c}.png' for c in ('red', 'blue')]
    else:
        board = IMAGES / 'game-board.jpg'
        stones = [IMAGES / 'stones' / f'{c}.png' for c in ('red', 'blue')]
    rgb = np.asarray(Image.open(board).convert('RGB')).astype(np.float64) / 255
    src = np.asarray(Image.open(IMAGES / 'game-board.jpg').convert('RGB'))
    white, _ = classify_nodes(src.astype(np.float64) / 255, centres)
    p1, p2 = (stone_colour(s) for s in stones)
    node = hex_rgb(theme['node'])
    rim = hex_rgb(theme['node_ring']) if theme.get('node_ring') else node
    rings = []
    for x, y in white:
        ann = (disc(rgb.shape, x, y, 46) > 0.5) & ~(disc(rgb.shape, x, y, 34) > 0.5)
        rings.append(np.median(rgb[ann], axis=0))
    wall = hex_rgb(theme['wall'])
    out = hex_rgb(theme['outline'])
    tok = {**ROOT_DEFAULTS, **theme_tokens(theme)} if tid != 'default' else ROOT_DEFAULTS
    text, muted = hex_rgb(tok['--color-text']), hex_rgb(tok['--color-text-muted'])
    surfaces = [hex_rgb(tok[k]) for k in ('--color-surface', '--color-bg', '--color-bg-dark')]
    return {
        'stones': de2000(p1, p2),
        'stones_cvd': min(de2000(simulate(p1, k), simulate(p2, k)) for k in CVD),
        'stone_node': min(ratio(p, node) for p in (p1, p2)),
        'stone_board': min(ratio(p, r) for p in (p1, p2) for r in rings),
        'node_board': min(max(ratio(node, r), ratio(rim, r)) for r in rings),
        'wall_node': ratio(wall, node),
        'wall_stone': min(de2000(wall, p) for p in (p1, p2)),
        'outline': min(ratio(out, p) for p in (p1, p2)),
        'text': min(ratio(text, s) for s in surfaces),
        'muted': min(ratio(muted, s) for s in surfaces),
    }


def main():
    palettes = {k: v for k, v in json.loads(PALETTES.read_text()).items() if not k.startswith('_')}
    centres = node_centres()
    res = {tid: measure(tid, t, centres) for tid, t in palettes.items()}
    ref = res['default']
    floor = {**FLOOR, 'text': 4.5, 'muted': 3.0}
    keys = list(floor)
    print('%-10s' % 'theme' + ''.join('%12s' % k for k in keys))
    fails = []
    for tid, r in res.items():
        cells = []
        for k in keys:
            need = min(floor[k], ref[k]) if tid != 'default' else 0
            bad = r[k] < need
            if bad:
                fails.append(f'{tid}: {k} {r[k]:.2f} < {need:.2f}')
            cells.append(('%.2f' % r[k]) + ('!' if bad else ' '))
        print('%-10s' % tid + ''.join('%12s' % c for c in cells))
    print('\nthreshold: min(floor, Arcane) per column; floors', floor)
    if fails:
        print('\nFAIL\n' + '\n'.join(fails))
        sys.exit(1)
    print('\nall themes pass')


if __name__ == '__main__':
    main()
