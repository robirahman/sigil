#!/usr/bin/env python3
"""Build the theme art from tools/themes/palettes.json.

For every theme with "assets": true this writes, under docs/static/images/themes/:

  game-board-<id>.{jpg,webp}         the Arcane board, gradient-mapped by luminance
  stones/<id>-{red,blue}.{png,webp}  the stones recoloured to the theme's p1/p2
  tiled-background-<id>.jpg          the page tile, same gradient map

Nothing is recoloured by CSS filters at runtime any more: a filter on the board
container also recoloured the stones, spell cards, lock rings and glows, which
is what made the old themes hard to read.

The board has red and blue art painted in (the score track and the two start
nodes); those discs are recoloured to p1/p2 like the stones, so the board and
the stones always agree. The empty-node discs get the theme's node colour.
Node centres come from the .stone-node--* rules in styles.css.

    python3 tools/themes/build_theme_assets.py            # art + tokens
    python3 tools/themes/build_theme_assets.py --tokens   # tokens only
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
STATIC = REPO / 'docs' / 'static'
IMAGES = STATIC / 'images'
OUT = IMAGES / 'themes'
PALETTES = Path(__file__).with_name('palettes.json')
THEME_MANAGER = STATIC / 'scripts' / 'theme-manager.js'

STONE = 56          # .stone-node --raw-size, in the board's 1480 frame
FRAME = 1480


def hex_rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255


def rgb_hex(c):
    c = np.clip(np.round(np.asarray(c) * 255), 0, 255).astype(int)
    return '#%02x%02x%02x' % tuple(c)


def luma(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def gradient_map(lum, stops):
    """Map luminance (0..1) through [[pos, '#hex'], ...] stops."""
    pos = np.array([s[0] for s in stops])
    cols = np.array([hex_rgb(s[1]) for s in stops])
    return np.stack([np.interp(lum, pos, cols[:, k]) for k in range(3)], axis=-1)


def shade(lum, mid, target):
    """Recolour shaded art to `target`: pixels at the art's mid luminance get
    `target`, darker ones scale toward black, lighter ones blend to white."""
    s = lum / max(mid, 1e-6)
    t = hex_rgb(target)
    dark = t[None] * np.clip(s, 0, 1)[..., None]
    hi = np.clip((s - 1) / max(1 / max(mid, 1e-6) - 1, 1e-6), 0, 1)[..., None]
    return dark * (1 - hi) + (t * (1 - 0.85) + 0.85) * hi


def hsv(rgb):
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    sat = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    return np.where(d > 0, h, 0), sat, mx


def node_centres():
    """Board-pixel centres of every .stone-node--<node> and score spot."""
    css = (STATIC / 'css' / 'styles.css').read_text()
    pat = re.compile(r'\.stone-node--((?:score-)?(?:[a-z]+\d+|tied))\s*\{\s*left:\s*calc\(([\d.]+) / 1480 \* 100%\);'
                     r'\s*top:\s*calc\(([\d.]+) / 1480')
    return {m.group(1): (float(m.group(2)) + STONE / 2, float(m.group(3)) + STONE / 2) for m in pat.finditer(css)}


def disc(shape, cx, cy, r, soft=1.5):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    d = np.hypot(xx + 0.5 - cx, yy + 0.5 - cy)
    return np.clip((r - d) / soft + 0.5, 0, 1)


def classify_nodes(rgb, centres):
    """Split node centres into white empty-node discs and red/blue painted discs."""
    lum = luma(rgb)
    h, s, v = hsv(rgb)
    white, painted = [], []
    for name, (x, y) in centres.items():
        m = disc(lum.shape, x, y, 10) > 0.5
        if lum[m].mean() > 0.85 and s[m].mean() < 0.15:
            white.append((x, y))
        elif s[m].mean() > 0.45 and v[m].mean() > 0.35:
            hue = np.median(h[m])
            painted.append((x, y, 'red' if (hue < 40 or hue > 320) else 'blue', name.startswith('score')))
    return white, painted


def build_board(theme, src, centres):
    rgb = src.astype(np.float64) / 255
    lum = luma(rgb)
    out = gradient_map(lum, theme['board'])
    white, painted = classify_nodes(rgb, centres)

    # Empty nodes: the theme's node colour, with an optional rim.
    for x, y in white:
        if theme.get('node_ring'):
            ring = disc(lum.shape, x, y, 30.5)
            out = out * (1 - ring[..., None]) + hex_rgb(theme['node_ring'])[None, None] * ring[..., None]
            fill = disc(lum.shape, x, y, 26.5)
        else:
            fill = disc(lum.shape, x, y, 28.5)
        out = out * (1 - fill[..., None]) + hex_rgb(theme['node'])[None, None] * fill[..., None]

    # Painted red/blue discs: recolour the saturated pixels to p1/p2, keep the
    # light glyphs and rims (weighted by saturation) as the gradient map has them.
    h, s, v = hsv(rgb)
    for x, y, colour, score in painted:
        r = 31 if score else 40
        m = disc(lum.shape, x, y, r)
        sel = (m > 0.5) & (s > 0.45)
        mid = float(np.median(lum[sel])) if sel.any() else 0.3
        target = theme['p1'] if colour == 'red' else theme['p2']
        rec = shade(lum, mid, target)
        w = (m * np.clip((s - 0.25) / 0.3, 0, 1))[..., None]
        out = out * (1 - w) + rec * w
    return Image.fromarray(np.clip(np.round(out * 255), 0, 255).astype(np.uint8))


def build_stone(src_rgba, target):
    a = np.asarray(src_rgba).astype(np.float64) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    lum = luma(rgb)
    mid = float(np.median(lum[alpha > 0.9]))
    out = shade(lum, mid, target)
    rgba = np.concatenate([out, alpha[..., None]], axis=-1)
    return Image.fromarray(np.clip(np.round(rgba * 255), 0, 255).astype(np.uint8), 'RGBA')


def lighten(hexc, t):
    c = hex_rgb(hexc)
    return rgb_hex(c + (1 - c) * t)


def theme_tokens(theme):
    """CSS custom properties for one theme: its UI tokens plus everything the
    palette decides (players, glows, outline, wall, node, drawn board)."""
    v = dict(theme.get('vars', {}))
    v.update({
        '--color-red-player': theme['p1'],
        '--color-blue-player': theme['p2'],
        '--color-red-glow': lighten(theme['p1'], 0.15),
        '--color-blue-glow': lighten(theme['p2'], 0.15),
        '--color-red-lock': theme['p1'],
        '--color-blue-lock': theme['p2'],
        '--color-last-play-outline': theme['outline'],
        '--color-wall': theme['wall'],
        '--color-node-empty': theme['node'],
    })
    if theme.get('board'):
        stops = theme['board']
        at = lambda p: rgb_hex(gradient_map(np.array([p]), stops)[0])
        v.update({
            '--color-board-bg-inner': at(0.16),
            '--color-board-bg-outer': at(0.04),
            '--color-board-ring': at(0.22),
            '--color-board-line': at(0.92),
            '--color-board-line-cross': at(0.65),
            '--color-board-slot': at(0.1),
            '--color-board-slot-stroke': at(0.38),
            '--color-board-text': at(0.5),
            '--color-board-node-stroke': theme.get('node_ring') or at(0.8),
            '--color-board-node': theme['node'],
            '--color-board-red': lighten(theme['p1'], 0.15),
            '--color-board-blue': lighten(theme['p2'], 0.15),
        })
    return v


def write_tokens(palettes):
    """Regenerate the THEMES table in theme-manager.js from the palettes."""
    lines = ['const THEMES = {']
    for tid, theme in palettes.items():
        if tid.startswith('_'):
            continue
        vars_ = theme_tokens(theme) if tid != 'default' else {}
        lines.append(f'\t{tid}: {{')
        lines.append(f"\t\tname: '{theme['name']}',")
        lines.append(f"\t\tboard: {'true' if theme.get('assets') else 'false'},")
        if vars_:
            lines.append('\t\tvars: {')
            lines += [f"\t\t\t'{k}': '{val}'," for k, val in vars_.items()]
            lines.append('\t\t}')
        else:
            lines.append('\t\tvars: {}')
        lines.append('\t},')
    lines[-1] = '\t}'
    lines.append('};')
    table = '\n'.join(lines)
    js = THEME_MANAGER.read_text()
    begin, end = '// <themes> generated by tools/themes/build_theme_assets.py from palettes.json', '// </themes>'
    i, j = js.index(begin) + len(begin), js.index(end)
    THEME_MANAGER.write_text(js[:i] + '\n' + table + '\n' + js[j:])


def main():
    palettes = json.loads(PALETTES.read_text())
    write_tokens(palettes)
    if '--tokens' in sys.argv:
        return
    board = np.asarray(Image.open(IMAGES / 'game-board.jpg').convert('RGB'))
    tile = np.asarray(Image.open(IMAGES / 'tiled-background.jpg').convert('RGB')).astype(np.float64) / 255
    red = Image.open(IMAGES / 'stones' / 'red.png').convert('RGBA')
    blue = Image.open(IMAGES / 'stones' / 'blue.png').convert('RGBA')
    centres = node_centres()
    (OUT / 'stones').mkdir(parents=True, exist_ok=True)
    for tid, theme in palettes.items():
        if tid.startswith('_') or not theme.get('assets'):
            continue
        img = build_board(theme, board, centres)
        img.save(OUT / f'game-board-{tid}.jpg', quality=88, optimize=True, progressive=True)
        img.save(OUT / f'game-board-{tid}.webp', quality=82, method=6)
        for colour, src, target in (('red', red, theme['p1']), ('blue', blue, theme['p2'])):
            st = build_stone(src, target)
            st.save(OUT / 'stones' / f'{tid}-{colour}.png', optimize=True)
            st.save(OUT / 'stones' / f'{tid}-{colour}.webp', quality=90, method=6)
        t = gradient_map(luma(tile), theme['board'])
        Image.fromarray(np.clip(np.round(t * 255), 0, 255).astype(np.uint8)).save(
            OUT / f'tiled-background-{tid}.jpg', quality=88, optimize=True)
        print(tid, 'ok')


if __name__ == '__main__':
    main()
