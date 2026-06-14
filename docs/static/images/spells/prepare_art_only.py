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
    "Lurk", "Decay", "Wither",
    "Seal_of_Winter", "Seal_of_Stone", "Seal_of_Destruction"
]

source_dir = "docs/static/images/spells"
raw_dir = "/home/robirahman94/.gemini/antigravity-cli/brain/0bd17edc-a270-4632-b418-a0a94c75b514"
exp_raw_dir = "/home/robirahman94/.gemini/antigravity-cli/brain/0bd17edc-a270-4632-b418-a0a94c75b514/scratch/raw_illustrations"
dest_dir = "docs/static/images/spells/art_only"

os.makedirs(dest_dir, exist_ok=True)

# Mapping to locate the newly generated *_raw_*.png files
def find_generated_raw(name):
    # E.g., for Flourish, find flourish_raw_*.png in the brain folder
    pattern = os.path.join(raw_dir, f"{name.lower()}_raw_*.png")
    matches = glob.glob(pattern)
    if matches:
        # Sort to find the latest
        matches.sort()
        return matches[-1]
    return None

def apply_circular_mask(im):
    width, height = im.size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, width, height), fill=255)
    
    r, g, b, a = im.convert("RGBA").split()
    new_alpha = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, new_alpha))

def process_base_spell_new(name, target_size):
    raw_path = find_generated_raw(name)
    if not raw_path:
        print(f"No generated raw found for {name}, trying fallback processing...")
        process_fallback(name, target_size)
        return
        
    print(f"Processing {name} using generated raw art: {os.path.basename(raw_path)}")
    im = Image.open(raw_path).convert("RGBA")
    
    # Crop to a circle filling the image (in case it is square)
    w, h = im.size
    min_dim = min(w, h)
    left = (w - min_dim) // 2
    top = (h - min_dim) // 2
    im_square = im.crop((left, top, left + min_dim, top + min_dim))
    
    # Resize using Lanczos to target_size
    resized = im_square.resize((target_size, target_size), Image.Resampling.LANCZOS)
    
    # Apply circular mask
    masked = apply_circular_mask(resized)
    
    # Save as PNG and WebP
    masked.save(os.path.join(dest_dir, f"{name}.png"), "PNG")
    masked.save(os.path.join(dest_dir, f"{name}.webp"), "WEBP")
    print(f"Successfully processed {name} (size {target_size})")

def process_fallback(name, target_size):
    src_path = os.path.join(source_dir, f"{name}.png")
    if not os.path.exists(src_path):
        print(f"Error: Fallback source not found: {src_path}")
        return
        
    im = Image.open(src_path).convert("RGBA")
    w, h = im.size
    
    # Sample background color from the outer dark ring
    bg_color = im.getpixel((74, 15))
    print(f"  Sampled background color for {name}: {bg_color}")
    
    # Create solid background of the sampled color
    bg = Image.new("RGBA", (w, h), bg_color)
    
    # Extract the center 52x52 region
    cx, cy, r = w // 2, h // 2, 26
    region = im.crop((cx - r, cy - r, cx + r, cy + r)).convert("RGBA")
    
    # Remove the white background from the region
    data = region.getdata()
    new_data = []
    for item in data:
        # Check if pixel is white or near-white (sum of RGB > 600 or R,G,B > 200)
        if item[0] > 190 and item[1] > 190 and item[2] > 190:
            new_data.append((0, 0, 0, 0)) # transparent
        else:
            new_data.append(item)
    region.putdata(new_data)
    
    # Paste the transparent-keyed region onto our solid bg in the center
    bg.paste(region, (cx - r, cy - r), mask=region)
    
    # Apply circular mask to the entire card
    masked = apply_circular_mask(bg)
    
    # Resize using Lanczos to target_size
    resized = masked.resize((target_size, target_size), Image.Resampling.LANCZOS)
    
    # Save
    resized.save(os.path.join(dest_dir, f"{name}.png"), "PNG")
    resized.save(os.path.join(dest_dir, f"{name}.webp"), "WEBP")
    print(f"Successfully processed fallback for {name} (size {target_size})")

# Process Base Game Spells
for name in RITUALS:
    process_base_spell_new(name, 322)

for name in SORCERIES:
    process_base_spell_new(name, 260)

for name in CHARMS:
    process_base_spell_new(name, 148)

# Process Expansion Spells
for name in EXPANSION_SPELLS:
    raw_path = os.path.join(exp_raw_dir, f"{name}.png")
    if not os.path.exists(raw_path):
        print(f"Error: raw illustration not found {raw_path}")
        continue
    
    im = Image.open(raw_path).convert("RGBA")
    # Save directly to destination as PNG and WebP
    im.save(os.path.join(dest_dir, f"{name}.png"), "PNG")
    im.save(os.path.join(dest_dir, f"{name}.webp"), "WEBP")
    print(f"Processed expansion spell: {name}")

print("All base game and expansion spell art assets re-generated successfully!")
