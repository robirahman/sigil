"""Procedural placeholder cards for the Experimental (playtest) pack.

Experimental spells are unreleased designs that may be cut or reworked, so
they get self-contained procedural art (no AI-generated rune, no external
texture) in the Flood palette, built with the same card geometry, fonts and
arc-text renderer as generate_providence_cards.py. When a spell
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
from generate_providence_cards import (  # noqa: E402
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


def silence_rune(diameter):
    """Muted bell: a resonance dome with radiating sound waves struck through
    by a heavy vertical sealing bar."""
    s = diameter * 4
    im = parchment(s, seed=41)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 16)

    # Central bell dome
    br = s * 0.22
    by = cy - s * 0.04
    d.arc((cx - br, by - br, cx + br, by + br), start=180, end=360, fill=ink, width=w)
    # Bell flare / rim
    d.line([(cx - br, by), (cx - br * 1.25, by + s * 0.22)], fill=ink, width=w)
    d.line([(cx + br, by), (cx + br * 1.25, by + s * 0.22)], fill=ink, width=w)
    d.arc((cx - br * 1.35, by + s * 0.14, cx + br * 1.35, by + s * 0.28), start=10, end=170, fill=ink, width=w)
    # Small clapper
    d.ellipse((cx - s * 0.04, by + s * 0.24, cx + s * 0.04, by + s * 0.32), fill=ink)

    # Radiating acoustic arcs (fading sound)
    for off, r_span in [(-s * 0.32, 0.16), (-s * 0.42, 0.25), (s * 0.32, 0.16), (s * 0.42, 0.25)]:
        sign = 1 if off > 0 else -1
        ang_start = 320 if sign > 0 else 140
        ang_end = 40 if sign > 0 else 220
        d.arc((cx + off - s * r_span, cy - s * r_span, cx + off + s * r_span, cy + s * r_span),
              start=ang_start, end=ang_end, fill=ink_soft, width=max(2, w // 2))

    # Heavy vertical sealing slash cutting through the bell and silence
    d.line([(cx, cy - s * 0.38), (cx, cy + s * 0.38)], fill=ink, width=int(w * 1.6))
    # Seal crossbars at the tips
    d.line([(cx - s * 0.08, cy - s * 0.38), (cx + s * 0.08, cy - s * 0.38)], fill=ink, width=w)
    d.line([(cx - s * 0.08, cy + s * 0.38), (cx + s * 0.08, cy + s * 0.38)], fill=ink, width=w)

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def vitrify_rune(diameter):
    """Vitrified lattice: sharp crystalline needles and a faceted diamond
    freezing motion into solid glass."""
    s = diameter * 4
    im = parchment(s, seed=53)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # Central faceted rhombus / diamond
    rx, ry = s * 0.22, s * 0.34
    d.polygon([(cx, cy - ry), (cx + rx, cy), (cx, cy + ry), (cx - rx, cy)], outline=ink, width=w)
    # Inner facet lines
    d.line([(cx, cy - ry), (cx, cy + ry)], fill=ink_soft, width=max(2, w // 2))
    d.line([(cx - rx, cy), (cx + rx, cy)], fill=ink_soft, width=max(2, w // 2))
    # Concentric inner crystal
    irx, iry = rx * 0.5, ry * 0.5
    d.polygon([(cx, cy - iry), (cx + irx, cy), (cx, cy + iry), (cx - irx, cy)], fill=ink_soft)

    # Radiating crystal shards & frozen lattice needles
    angles = [30, 60, 120, 150, 210, 240, 300, 330]
    for ang in angles:
        rad = math.radians(ang)
        x0 = cx + math.cos(rad) * s * 0.24
        y0 = cy + math.sin(rad) * s * 0.24
        x1 = cx + math.cos(rad) * s * 0.42
        y1 = cy + math.sin(rad) * s * 0.42
        d.line([(x0, y0), (x1, y1)], fill=ink, width=max(2, w - 2))
        # Needle barb
        bx = x1 + math.cos(rad + 0.5) * s * 0.05
        by = y1 + math.sin(rad + 0.5) * s * 0.05
        d.line([(x1, y1), (bx, by)], fill=ink, width=max(2, w // 2))

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def spellbreak_rune(diameter):
    """Broken sigil: a fractured seal ring cleaved apart by a sharp ray,
    with shattered shards dispersing."""
    s = diameter * 4
    im = parchment(s, seed=67)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # Outer split ring (left half shifted slightly up-left, right half down-right)
    r = s * 0.32
    d.arc((cx - r - s * 0.03, cy - r - s * 0.03, cx + r - s * 0.03, cy + r - s * 0.03),
          start=125, end=305, fill=ink, width=w)
    d.arc((cx - r + s * 0.03, cy - r + s * 0.03, cx + r + s * 0.03, cy + r + s * 0.03),
          start=305, end=125, fill=ink, width=w)

    # Inner concentric split ring
    ir = s * 0.20
    d.arc((cx - ir - s * 0.02, cy - ir - s * 0.02, cx + ir - s * 0.02, cy + ir - s * 0.02),
          start=130, end=300, fill=ink_soft, width=max(2, w - 2))
    d.arc((cx - ir + s * 0.02, cy - ir + s * 0.02, cx + ir + s * 0.02, cy + ir + s * 0.02),
          start=310, end=120, fill=ink_soft, width=max(2, w - 2))

    # Diagonal fracture cleaving line
    d.line([(cx - s * 0.40, cy + s * 0.38), (cx + s * 0.38, cy - s * 0.40)],
           fill=ink, width=int(w * 1.5))

    # Flying shards around the fracture
    shards = [
        [(cx - s * 0.12, cy - s * 0.05), (cx - s * 0.06, cy - s * 0.14), (cx - s * 0.16, cy - s * 0.18)],
        [(cx + s * 0.12, cy + s * 0.05), (cx + s * 0.06, cy + s * 0.14), (cx + s * 0.16, cy + s * 0.18)],
        [(cx - s * 0.22, cy + s * 0.10), (cx - s * 0.28, cy + s * 0.15), (cx - s * 0.26, cy + s * 0.05)],
        [(cx + s * 0.22, cy - s * 0.10), (cx + s * 0.28, cy - s * 0.15), (cx + s * 0.26, cy - s * 0.05)],
    ]
    for poly in shards:
        d.polygon(poly, fill=ink)

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def shatter_rune(diameter):
    """Shatter: a central stone violently collapsing and fragmenting into shards
    under inward compression from surrounding stones."""
    s = diameter * 4
    im = parchment(s, seed=79)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # 3 flanking stones pressing inward
    flank_r = s * 0.09
    for ang in (30, 150, 270):
        rad = math.radians(ang)
        fx = cx + math.cos(rad) * s * 0.32
        fy = cy + math.sin(rad) * s * 0.32
        d.ellipse((fx - flank_r, fy - flank_r, fx + flank_r, fy + flank_r), fill=ink)
        # Pressure line pushing into center
        d.line([(fx, fy), (cx + math.cos(rad) * s * 0.18, cy + math.sin(rad) * s * 0.18)],
               fill=ink, width=w)

    # Shattered core shards
    shards = [
        [(cx - s * 0.12, cy - s * 0.12), (cx - s * 0.02, cy - s * 0.16), (cx - s * 0.04, cy - s * 0.04)],
        [(cx + s * 0.12, cy - s * 0.10), (cx + s * 0.15, cy + s * 0.02), (cx + s * 0.03, cy - s * 0.02)],
        [(cx - s * 0.14, cy + s * 0.08), (cx - s * 0.02, cy + s * 0.15), (cx - s * 0.04, cy + s * 0.02)],
        [(cx + s * 0.05, cy + s * 0.14), (cx + s * 0.13, cy + s * 0.09), (cx + s * 0.04, cy + s * 0.04)],
        [(cx - s * 0.06, cy - s * 0.02), (cx + s * 0.02, cy - s * 0.05), (cx - s * 0.01, cy + s * 0.03)],
    ]
    for poly in shards:
        d.polygon(poly, fill=ink)

    # Shockwave / fracture cracks bursting out
    for ang in (0, 75, 120, 195, 240, 315):
        rad = math.radians(ang)
        pts = [(cx + math.cos(rad) * s * 0.12, cy + math.sin(rad) * s * 0.12)]
        pts.append((cx + math.cos(rad + 0.1) * s * 0.22, cy + math.sin(rad + 0.1) * s * 0.22))
        pts.append((cx + math.cos(rad - 0.1) * s * 0.35, cy + math.sin(rad - 0.1) * s * 0.35))
        d.line(pts, fill=ink_soft, width=max(2, w // 2))

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def petrify_rune(diameter):
    """Petrify: an unyielding stone monolith and concentric masonry warding
    freezing motion into immovable basalt."""
    s = diameter * 4
    im = parchment(s, seed=89)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # Heavy stone stele / monolith
    mw = s * 0.26
    mh = s * 0.36
    d.rectangle((cx - mw, cy - mh, cx + mw, cy + mh), outline=ink, width=w)
    # Masonry courses (horizontal mortar joints)
    for frac in (-0.18, 0.0, 0.18):
        y = cy + s * frac
        d.line([(cx - mw, y), (cx + mw, y)], fill=ink, width=max(2, w - 2))
    # Vertical mortar staggered joints
    d.line([(cx - mw * 0.4, cy - mh), (cx - mw * 0.4, cy - s * 0.18)], fill=ink, width=max(2, w - 2))
    d.line([(cx + mw * 0.4, cy - mh), (cx + mw * 0.4, cy - s * 0.18)], fill=ink, width=max(2, w - 2))
    d.line([(cx, cy - s * 0.18), (cx, cy)], fill=ink, width=max(2, w - 2))
    d.line([(cx - mw * 0.4, cy), (cx - mw * 0.4, cy + s * 0.18)], fill=ink, width=max(2, w - 2))
    d.line([(cx + mw * 0.4, cy), (cx + mw * 0.4, cy + s * 0.18)], fill=ink, width=max(2, w - 2))
    d.line([(cx, cy + s * 0.18), (cx, cy + mh)], fill=ink, width=max(2, w - 2))

    # Outer concentric square ward
    ow = mw + s * 0.08
    oh = mh + s * 0.06
    d.rectangle((cx - ow, cy - oh, cx + ow, cy + oh), outline=ink_soft, width=max(2, w // 2))

    # Heavy corner rivets / stone corner studs
    for dx in (-1, 1):
        for dy in (-1, 1):
            px = cx + dx * (ow + s * 0.03)
            py = cy + dy * (oh + s * 0.03)
            d.ellipse((px - s * 0.03, py - s * 0.03, px + s * 0.03, py + s * 0.03), fill=ink)

    return im.resize((diameter, diameter), Image.Resampling.LANCZOS)


def fulgurite_rune(diameter):
    """Fulgurite: a lightning bolt descending into earth, fusing sand into
    intricate branching root-like glass conduits."""
    s = diameter * 4
    im = parchment(s, seed=97)
    d = ImageDraw.Draw(im, 'RGBA')
    ink = (12, 38, 96, 255)
    ink_soft = (24, 76, 140, 235)
    cx, cy = s / 2, s / 2
    w = max(6, s // 18)

    # Ground horizon line
    gy = cy + s * 0.02
    d.line([(cx - s * 0.36, gy), (cx + s * 0.36, gy)], fill=ink_soft, width=w)

    # Jagged lightning bolt striking downward from top-right to center
    bolt = [
        (cx + s * 0.15, cy - s * 0.38),
        (cx + s * 0.04, cy - s * 0.22),
        (cx + s * 0.10, cy - s * 0.20),
        (cx - s * 0.02, cy - s * 0.06),
        (cx + s * 0.04, cy - s * 0.04),
        (cx - s * 0.01, gy),
    ]
    d.line(bolt, fill=ink, width=int(w * 1.4), joint='miter')

    # Branching subterranean fulgurite roots (fused glass dendrites)
    branches = [
        # Main trunk continuing down
        [(cx - s * 0.01, gy), (cx - s * 0.03, cy + s * 0.14), (cx - s * 0.02, cy + s * 0.26), (cx - s * 0.05, cy + s * 0.36)],
        # Left main branch
        [(cx - s * 0.03, cy + s * 0.14), (cx - s * 0.14, cy + s * 0.22), (cx - s * 0.22, cy + s * 0.30)],
        # Sub-branch off left
        [(cx - s * 0.14, cy + s * 0.22), (cx - s * 0.16, cy + s * 0.34)],
        # Right main branch
        [(cx - s * 0.02, cy + s * 0.18), (cx + s * 0.12, cy + s * 0.24), (cx + s * 0.18, cy + s * 0.32)],
        # Sub-branch off right
        [(cx + s * 0.12, cy + s * 0.24), (cx + s * 0.08, cy + s * 0.35)],
        # Secondary shallow roots
        [(cx - s * 0.01, gy), (cx - s * 0.10, cy + s * 0.08), (cx - s * 0.20, cy + s * 0.12)],
        [(cx - s * 0.01, gy), (cx + s * 0.10, cy + s * 0.08), (cx + s * 0.18, cy + s * 0.11)],
    ]
    for path in branches:
        d.line(path, fill=ink, width=max(2, w - 2), joint='curve')

    # Vitrified sand nodules at branch tips
    for (nx, ny) in [
        (cx - s * 0.05, cy + s * 0.36),
        (cx - s * 0.22, cy + s * 0.30),
        (cx - s * 0.16, cy + s * 0.34),
        (cx + s * 0.18, cy + s * 0.32),
        (cx + s * 0.08, cy + s * 0.35),
        (cx - s * 0.20, cy + s * 0.12),
        (cx + s * 0.18, cy + s * 0.11),
    ]:
        d.ellipse((nx - s * 0.02, ny - s * 0.02, nx + s * 0.02, ny + s * 0.02), fill=ink)

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
    r = cfg.get('spot_radius', 0)
    for sx, sy in cfg.get('spots', []):
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
        # Sorcery geometry: identical to Torrent (260px, 3 spots).
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
    {
        'name': 'Silence',
        'size': 148,
        'inner_r': 23,
        'outer_r': 73,
        'bottom_bg': (12, 20, 38, 255),
        'border_color': (140, 180, 220, 255),
        'rune': silence_rune,
        'spots': [],
        'title': 'SILENCE',
        'name_radius': 58,
        'name_center_deg': 135,
        'name_font_size': 9.5,
        'desc_lines': [
            {'text': 'Opponent may not cast spells', 'radius': 58,
             'center_deg': 45, 'font_size': 4.3, 'spacing': 0.88},
            {'text': 'on their next turn.', 'radius': 46,
             'center_deg': 45, 'font_size': 4.3, 'spacing': 0.88},
        ],
    },
    {
        'name': 'Vitrify',
        'size': 260,
        'inner_r': 56,
        'outer_r': 128,
        'bottom_bg': (8, 24, 44, 255),
        'border_color': (120, 200, 240, 255),
        'rune': vitrify_rune,
        'spot_radius': 31,
        'spots': [(130.0, 196.3), (72.5, 97.0), (187.5, 97.0)],
        'title': 'VITRIFY',
        'name_radius': 105,
        'name_center_deg': 138,
        'name_font_size': 11.5,
        'desc_lines': [
            {'text': 'STATIC: The enemy cannot dash as', 'radius': 106,
             'center_deg': 45, 'font_size': 5.8, 'spacing': 0.88},
            {'text': 'long as you have this seal filled.', 'radius': 90,
             'center_deg': 45, 'font_size': 5.8, 'spacing': 0.88},
        ],
    },
    {
        'name': 'Spellbreak',
        'size': 260,
        'inner_r': 56,
        'outer_r': 128,
        'bottom_bg': (28, 14, 36, 255),
        'border_color': (220, 140, 190, 255),
        'rune': spellbreak_rune,
        'spot_radius': 31,
        'spots': [(130.0, 196.3), (72.5, 97.0), (187.5, 97.0)],
        'title': 'SPELLBREAK',
        'name_radius': 105,
        'name_center_deg': 138,
        'name_font_size': 11.5,
        'desc_lines': [
            {'text': "Unlock the opponent's locked spell and", 'radius': 112,
             'center_deg': 45, 'font_size': 5.1, 'spacing': 0.86},
            {'text': 'destroy 1 stone on that sigil.', 'radius': 99,
             'center_deg': 45, 'font_size': 5.1, 'spacing': 0.86},
            {'text': 'Then make 1 soft move.', 'radius': 86,
             'center_deg': 45, 'font_size': 5.1, 'spacing': 0.86},
        ],
    },
    {
        'name': 'Shatter',
        'size': 322,
        'inner_r': 86,
        'outer_r': 160,
        'bottom_bg': (18, 26, 36, 255),
        'border_color': (180, 220, 245, 255),
        'rune': shatter_rune,
        'spot_radius': 32,
        'spots': [(161.0, 258.6), (68.3, 191.3), (253.7, 191.3), (103.7, 82.1), (218.3, 82.1)],
        'title': 'SHATTER',
        'name_radius': 136,
        'name_center_deg': 126,
        'name_font_size': 10.5,
        'desc_lines': [
            {'text': 'Make 1 hard move, then destroy all enemy', 'radius': 138,
             'center_deg': 54, 'font_size': 5.8, 'spacing': 0.88},
            {'text': 'stones touching 2 or more of your stones.', 'radius': 120,
             'center_deg': 54, 'font_size': 5.8, 'spacing': 0.88},
        ],
    },
    {
        'name': 'Petrify',
        'size': 322,
        'inner_r': 86,
        'outer_r': 160,
        'bottom_bg': (24, 28, 26, 255),
        'border_color': (160, 180, 160, 255),
        'rune': petrify_rune,
        'spot_radius': 32,
        'spots': [(161.0, 258.6), (68.3, 191.3), (253.7, 191.3), (103.7, 82.1), (218.3, 82.1)],
        'title': 'PETRIFY',
        'name_radius': 136,
        'name_center_deg': 126,
        'name_font_size': 10.5,
        'desc_lines': [
            {'text': 'STATIC: Opponent cannot', 'radius': 138,
             'center_deg': 54, 'font_size': 6.2, 'spacing': 0.88},
            {'text': 'make hard moves.', 'radius': 120,
             'center_deg': 54, 'font_size': 6.2, 'spacing': 0.88},
        ],
    },
    {
        'name': 'Fulgurite',
        'size': 322,
        'inner_r': 86,
        'outer_r': 160,
        'bottom_bg': (28, 24, 16, 255),
        'border_color': (245, 215, 110, 255),
        'rune': fulgurite_rune,
        'spot_radius': 32,
        'spots': [(161.0, 258.6), (68.3, 191.3), (253.7, 191.3), (103.7, 82.1), (218.3, 82.1)],
        'title': 'FULGURITE',
        'name_radius': 136,
        'name_center_deg': 126,
        'name_font_size': 10.5,
        'desc_lines': [
            {'text': 'Make 1 blink move,', 'radius': 138,
             'center_deg': 54, 'font_size': 6.4, 'spacing': 0.88},
            {'text': 'then 2 hard moves.', 'radius': 120,
             'center_deg': 54, 'font_size': 6.4, 'spacing': 0.88},
        ],
    },
]


if __name__ == '__main__':
    for cfg in CARDS:
        build_card(cfg)
