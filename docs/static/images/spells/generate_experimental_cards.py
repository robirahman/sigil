"""Procedural placeholder cards for the Experimental (playtest) pack.

Experimental spells are unreleased designs that may be cut or reworked, so
they get self-contained procedural art (no AI-generated rune, no external
texture) in the Flood palette, built with the same card geometry, fonts and
arc-text renderer as generate_aftershock_and_ambush_cards.py. When a spell
graduates into a real pack, regenerate its card through the full pipeline
described in README.md.

Run from the repo root:
    python3 docs/static/images/spells/generate_experimental_cards.py
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from generate_aftershock_and_ambush_cards import (  # noqa: E402
    apply_circular_mask, render_centered_arc_text, font_bold_path, font_reg_path,
)

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
SPELLS_DIR = os.path.join(REPO, 'docs', 'static', 'images', 'spells')
STATIC_SPELLS_DIR = os.path.join(REPO, 'static', 'images', 'spells')
OUT_DIRS = [SPELLS_DIR, STATIC_SPELLS_DIR]


def _rng(seed):
    return np.random.default_rng(seed)


def ocean_texture(size, seed=7):
    """Deep sapphire water with layered sinusoidal swells and foam flecks."""
    rng = _rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    swell = np.zeros_like(x)
    for k in range(1, 6):
        ph = rng.uniform(0, 2 * math.pi)
        amp = 1.0 / k
        swell += amp * np.sin(2 * math.pi * (k * 1.7 * y + 0.9 * k * x) + ph
                              + 1.5 * np.sin(2 * math.pi * k * x + ph))
    swell = (swell - swell.min()) / (swell.max() - swell.min())
    noise = rng.normal(0, 1, (size, size)).astype(np.float32)
    noise = np.clip((noise - noise.min()) / (noise.max() - noise.min()), 0, 1)
    v = 0.75 * swell + 0.25 * noise
    deep = np.array([8, 34, 68], dtype=np.float32)
    mid = np.array([26, 92, 150], dtype=np.float32)
    foam = np.array([190, 225, 240], dtype=np.float32)
    rgb = deep[None, None, :] * (1 - v[..., None]) + mid[None, None, :] * v[..., None]
    crest = np.clip((v - 0.78) / 0.22, 0, 1) ** 2
    rgb = rgb * (1 - crest[..., None]) + foam[None, None, :] * crest[..., None]
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')
    return im.filter(ImageFilter.GaussianBlur(0.6))


def parchment(size, seed=11):
    rng = _rng(seed)
    base = np.array([228, 212, 176], dtype=np.float32)
    n = rng.normal(0, 1, (size, size)).astype(np.float32)
    n = (n - n.min()) / (n.max() - n.min())
    rgb = base[None, None, :] * (0.88 + 0.16 * n[..., None])
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')
    return im.filter(ImageFilter.GaussianBlur(1.2))


def spring_tide_rune(diameter):
    """A rising tide: a crescent moon pulling three stacked swells upward,
    with two droplets (the two sacrificed stones) falling away below."""
    s = diameter * 4  # draw at 4x, downsample for smooth painterly strokes
    im = parchment(s, seed=23)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 16)

    # Crescent moon, upper left.
    mr = s * 0.15
    mx, my = cx - s * 0.13, cy - s * 0.21
    d.ellipse((mx - mr, my - mr, mx + mr, my + mr), fill=ink)
    bite = mr * 0.86
    d.ellipse((mx - bite + mr * 0.42, my - bite - mr * 0.12,
               mx + bite + mr * 0.42, my + bite - mr * 0.12), fill=(0, 0, 0, 0))
    # Re-fill the bite with parchment so it reads as a crescent.
    pm = parchment(s, seed=23)
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).ellipse((mx - bite + mr * 0.42, my - bite - mr * 0.12,
                                  mx + bite + mr * 0.42, my + bite - mr * 0.12), fill=255)
    im.paste(pm, (0, 0), mask)
    d = ImageDraw.Draw(im, 'RGBA')

    # Three stacked swells, each a pair of arcs, rising to the right.
    for i, (yy, span, col) in enumerate([(0.06, 0.50, ink), (0.20, 0.58, ink), (0.34, 0.62, ink_soft)]):
        y0 = cy + s * yy
        x0 = cx - s * span / 2
        x1 = cx + s * span / 2
        h = s * 0.14
        # Main swell arc (crest to the right), then a curling lip.
        d.arc((x0, y0 - h, x1, y0 + h), start=200, end=345, fill=col, width=w)
        lip_r = h * 0.55
        lx = x1 - lip_r * 1.1
        d.arc((lx - lip_r, y0 - h - lip_r * 0.4, lx + lip_r, y0 - h + lip_r * 1.6),
              start=180, end=400, fill=col, width=max(2, w - 1))
        # Undercurrent line beneath each swell.
        d.arc((x0 + s * 0.06, y0 - h * 0.35, x1 - s * 0.10, y0 + h * 1.1),
              start=200, end=330, fill=col, width=max(2, w // 2))

    # Two droplets, lower right, falling away from the tide.
    for k, (dx, dy, r) in enumerate([(0.16, 0.30, 0.045), (0.27, 0.20, 0.035)]):
        px, py = cx + s * dx, cy + s * dy
        rr = s * r
        d.ellipse((px - rr, py - rr * 0.8, px + rr, py + rr * 1.2), fill=ink)
        d.polygon([(px - rr * 0.9, py), (px + rr * 0.9, py), (px, py - rr * 2.1)], fill=ink)

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def rapids_rune(diameter):
    """White water: three rushing diagonal channels splitting around a rock,
    with a second, smaller sigil ring beside the main one — the extra cast."""
    s = diameter * 4
    im = parchment(s, seed=31)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # Three sinuous channels running top-left to bottom-right.
    for i, (off, col) in enumerate([(-0.20, ink_soft), (0.0, ink), (0.20, ink_soft)]):
        pts = []
        for k in range(0, 41):
            t = k / 40.0
            x = cx + s * (-0.42 + 0.84 * t) + s * off * 0.35
            y = cy + s * (-0.42 + 0.84 * t) * 0.55 + s * off + s * 0.07 * math.sin(6.0 * t + i)
            pts.append((x, y))
        d.line(pts, fill=col, width=w, joint='curve')
        # White-water chevrons along the channel.
        for k in (10, 22, 32):
            x, y = pts[k]
            d.line([(x - w * 1.2, y - w * 0.9), (x, y + w * 0.4), (x + w * 1.2, y - w * 0.9)],
                   fill=(236, 226, 200, 255), width=max(2, w // 3))

    # The rock the current splits around.
    rx, ry, rr = cx + s * 0.05, cy - s * 0.02, s * 0.075
    d.ellipse((rx - rr, ry - rr * 0.8, rx + rr, ry + rr * 0.8), fill=ink)

    # Twin sigil rings (the second cast), lower right.
    for (dx, dy, r, wd) in [(0.24, 0.26, 0.085, w // 2), (0.33, 0.14, 0.05, max(2, w // 3))]:
        px, py, pr = cx + s * dx, cy + s * dy, s * r
        d.ellipse((px - pr, py - pr, px + pr, py + pr), outline=ink, width=wd)

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def build_card(cfg):
    name, size = cfg['name'], cfg['size']
    cx, cy = size // 2, size // 2
    inner_r, outer_r = cfg['inner_r'], cfg['outer_r']
    print(f"Building card: {name} ({size}x{size})")

    tex = ocean_texture(size)
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    top_mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(top_mask).rectangle((0, 0, size, cy), fill=255)
    im.paste(tex, (0, 0), mask=top_mask)
    bot_mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(bot_mask).rectangle((0, cy, size, size), fill=255)
    im.paste(Image.new('RGBA', (size, size), cfg['bottom_bg']), (0, 0), mask=bot_mask)

    draw = ImageDraw.Draw(im)
    border = cfg['border_color']
    draw.ellipse((cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r), outline=border, width=2)
    draw.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), outline=border, width=2)
    draw.line([(0, cy), (cx - inner_r, cy)], fill=(255, 255, 255, 255), width=2)
    draw.line([(cx + inner_r, cy), (size, cy)], fill=(255, 255, 255, 255), width=2)

    rune = apply_circular_mask(cfg['rune'](inner_r * 2), inner_r)
    im.paste(rune, (cx - inner_r, cy - inner_r), mask=rune)
    for out_dir in OUT_DIRS:
        art_dir = os.path.join(out_dir, 'art_only')
        os.makedirs(art_dir, exist_ok=True)
        rune.save(os.path.join(art_dir, f'{name}.png'), 'PNG')
        rune.save(os.path.join(art_dir, f'{name}.webp'), 'WEBP')

    spots = ImageDraw.Draw(im)
    r = cfg['spot_radius']
    for sx, sy in cfg['spots']:
        spots.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(255, 255, 255, 255))

    render_centered_arc_text(im, cfg['title'], (cx, cy), radius=cfg['name_radius'],
                             target_center_angle_deg=cfg['name_center_deg'], direction=-1,
                             font_path=font_bold_path, font_size=cfg['name_font_size'],
                             color=(255, 255, 255, 255), spacing_mult=cfg.get('name_spacing', 0.98),
                             face_in=True)
    for line in cfg['desc_lines']:
        render_centered_arc_text(im, line['text'], (cx, cy), radius=line['radius'],
                                 target_center_angle_deg=line['center_deg'], direction=1,
                                 font_path=font_reg_path, font_size=line['font_size'],
                                 color=(245, 245, 245, 255), spacing_mult=line.get('spacing', 0.90),
                                 face_in=True)

    final = apply_circular_mask(im, cx)
    for out_dir in OUT_DIRS:
        os.makedirs(out_dir, exist_ok=True)
        final.save(os.path.join(out_dir, f'{name}.png'), 'PNG')
        final.save(os.path.join(out_dir, f'{name}.webp'), 'WEBP')
    print(f"  Exported {name}.png/.webp + art_only to {len(OUT_DIRS)} dirs")


CARDS = [
    {
        # Sorcery geometry: identical to Smolder/Torrent (260px, 3 spots).
        'name': 'Spring_Tide',
        'size': 260,
        'inner_r': 56,
        'outer_r': 128,
        'bottom_bg': (8, 24, 44, 255),
        'border_color': (120, 200, 240, 255),
        'rune': spring_tide_rune,
        'spot_radius': 31,
        'spots': [(130.0, 196.3), (72.5, 97.0), (187.5, 97.0)],
        'title': 'SPRING TIDE',
        'name_radius': 105,
        'name_center_deg': 138,
        'name_font_size': 11.5,
        'desc_lines': [
            {'text': 'Make 2 hard moves, then 2 soft moves,', 'radius': 106,
             'center_deg': 45, 'font_size': 6.2, 'spacing': 0.88},
            {'text': 'then sacrifice 2 stones.', 'radius': 90,
             'center_deg': 45, 'font_size': 6.0, 'spacing': 0.88},
        ],
    },
    {
        'name': 'Rapids',
        'size': 260,
        'inner_r': 56,
        'outer_r': 128,
        'bottom_bg': (8, 24, 44, 255),
        'border_color': (120, 200, 240, 255),
        'rune': rapids_rune,
        'spot_radius': 31,
        'spots': [(130.0, 196.3), (72.5, 97.0), (187.5, 97.0)],
        'title': 'RAPIDS',
        'name_radius': 105,
        'name_center_deg': 138,
        'name_font_size': 11.5,
        'desc_lines': [
            {'text': 'Make 1 soft move, then 1 hard move.', 'radius': 106,
             'center_deg': 45, 'font_size': 6.2, 'spacing': 0.88},
            {'text': 'You may cast 1 additional spell this turn.', 'radius': 90,
             'center_deg': 45, 'font_size': 6.0, 'spacing': 0.88},
        ],
    },
]


if __name__ == '__main__':
    for cfg in CARDS:
        build_card(cfg)
