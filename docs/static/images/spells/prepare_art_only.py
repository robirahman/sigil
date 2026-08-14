import os
import glob
from PIL import Image, ImageDraw, ImageChops

# Define spelling names to categories for base game
RITUALS = ["Seal_of_Lightning", "Starfall", "Bewitch", "Carnage", "Flourish"]
SORCERIES = ["Seal_of_Wind", "Meteor", "Hail_Storm", "Fireblast", "Grow"]
CHARMS = ["Seal_of_Summer", "Comet", "Surge", "Slash", "Sprout"]

# Define expansion spells
EXPANSION_SPELLS = [
    "Seal_of_Spring", "Scatter", "Blossom",
    "Azimuth", "Eclipse", "Syzygy",
    "Charge", "Fury", "Erupt",
    "Gust", "Storm_Front", "Hurricane",
    "Splash", "Torrent", "Flood",
    "Seal_of_Autumn", "Gather", "Harvest",
    "Lurk", "Decay", "Corrupt",
    "Seal_of_Winter", "Seal_of_Stone", "Seal_of_Destruction",
    "Fissure", "Rock_Slide", "Bulwark",
    "Endowment", "Annuity", "Dividend",
    "Conflagration", "Smolder", "Ember",
    "Minefield", "Deadfall", "Tripwire"
]

source_dir = "docs/static/images/spells"
static_source_dir = "static/images/spells"
dest_dir = "docs/static/images/spells/art_only"
static_dest_dir = "static/images/spells/art_only"

os.makedirs(dest_dir, exist_ok=True)
os.makedirs(static_dest_dir, exist_ok=True)

def apply_circular_mask(im):
    width, height = im.size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, width, height), fill=255)
    
    r, g, b, a = im.convert("RGBA").split()
    new_alpha = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, new_alpha))

def process_spell_art_only(name):
    src_path = os.path.join(source_dir, f"{name}.png")
    if not os.path.exists(src_path):
        print(f"Error: Source not found {src_path}")
        return
        
    im = Image.open(src_path).convert("RGBA")
    w, h = im.size
    cx, cy = w // 2, h // 2
    
    # Target radii based on card size
    if w == 322:
        r = 86
    elif w == 260:
        r = 56
    else:
        r = 23
        
    cropped = im.crop((cx - r, cy - r, cx + r, cy + r))
    masked = apply_circular_mask(cropped)
    
    # Save to docs art_only
    masked.save(os.path.join(dest_dir, f"{name}.png"), "PNG")
    masked.save(os.path.join(dest_dir, f"{name}.webp"), "WEBP")
    
    # Save to static art_only
    masked.save(os.path.join(static_dest_dir, f"{name}.png"), "PNG")
    masked.save(os.path.join(static_dest_dir, f"{name}.webp"), "WEBP")
    print(f"Processed art_only for {name}")

for name in RITUALS + SORCERIES + CHARMS + EXPANSION_SPELLS:
    process_spell_art_only(name)

print("All spell art_only assets processed successfully!")
