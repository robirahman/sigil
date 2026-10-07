"""Rewrite the rules text on the shipped Providence cards (2026-10 bank rules).

The shipped Endowment/Annuity/Dividend art (commit 5a3ce007) was produced
outside the repo's generator scripts, so this patches the PNGs in place
instead of regenerating them: it repaints the description sector (the
bottom-right quarter of the navy lower half, between the art circle and
the gold ring) with the solid background, leaving the white node spots
alone, then draws the new text with generate_providence_cards' arc
renderer. Idempotent: re-running repaints the same sector.

Writes docs/static/images/spells/<Name>.{png,webp} and the static/ mirror.
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_providence_cards as g  # noqa: E402

OUT_DIRS = [HERE, os.path.join(HERE, '..', '..', '..', '..', 'static', 'images', 'spells')]
BG = np.array([15, 20, 35])

# name: [(text, baseline radius, center angle in degrees, font size)]
NEW_TEXT = {
    'Endowment': [("Add 4 stones to your", 138, 50, 7.4), ("Providence bank.", 118, 50, 7.4)],
    'Annuity':   [("Add 2 stones to your", 106, 48, 7.4), ("Providence bank.", 90, 48, 7.4)],
    'Dividend':  [("Add 1 stone to your", 58, 46, 5.4), ("Providence bank.", 46, 46, 5.4)],
}


def _art_radius(navy, cx, cy, w):
    """First radius along the 50-degree ray where the navy band starts."""
    s, c = math.sin(math.radians(50)), math.cos(math.radians(50))
    for rr in range(5, w // 2):
        if all(navy[int(cy + (rr + k) * s), int(cx + (rr + k) * c)] for k in range(4)):
            return rr
    raise RuntimeError('art circle edge not found')


def retext(name):
    src = os.path.join(HERE, name + '.png')
    im = np.array(Image.open(src).convert('RGBA')).astype(int)
    h, w = im.shape[:2]
    cx, cy = w / 2, h / 2
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx + .5 - cx, yy + .5 - cy)
    ang = np.degrees(np.arctan2(yy + .5 - cy, xx + .5 - cx))
    rgb = im[:, :, :3]
    navy = np.abs(rgb - BG).sum(2) < 25
    white = (rgb.min(2) >= 250) & (im[:, :, 3] == 255)
    spot = np.array(Image.fromarray((white * 255).astype(np.uint8))
                    .filter(ImageFilter.MaxFilter(3))) > 0
    art_r = _art_radius(navy, cx, cy, w)
    sector = ((yy > cy + 2) & (ang > -2) & (ang < 108)
              & (r > art_r + 1) & (r < w / 2 - 6) & ~spot)
    im[sector, :3] = BG
    card = Image.fromarray(im.astype(np.uint8), 'RGBA')
    for text, radius, deg, size in NEW_TEXT[name]:
        g.render_centered_arc_text(card, text, (w // 2, h // 2), radius=radius,
                                   target_center_angle_deg=deg, direction=1,
                                   font_path=g.font_reg_path, font_size=size,
                                   color=(245, 245, 245, 255), spacing_mult=0.95,
                                   face_in=True)
    for d in OUT_DIRS:
        card.save(os.path.join(d, name + '.png'), 'PNG')
        card.save(os.path.join(d, name + '.webp'), 'WEBP')
    print('retexted', name)


if __name__ == '__main__':
    for n in NEW_TEXT:
        retext(n)
