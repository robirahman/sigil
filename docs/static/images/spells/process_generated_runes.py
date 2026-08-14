import os
import glob
from PIL import Image, ImageDraw, ImageFilter, ImageChops

# Paths
artifacts_dir = "/home/robirahman94/.gemini/antigravity-cli/brain/73f7fe8f-0d73-421e-8dda-dc8bddbecc32"
spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells"
static_spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/static/images/spells"

RITUALS = ["Blossom", "Syzygy", "Erupt", "Hurricane", "Flood", "Harvest", "Corrupt", "Seal_of_Destruction", "Fissure", "Endowment"]
SORCERIES = ["Scatter", "Eclipse", "Fury", "Storm_Front", "Torrent", "Gather", "Decay", "Seal_of_Stone", "Rock_Slide", "Annuity"]
CHARMS = ["Seal_of_Spring", "Azimuth", "Charge", "Gust", "Splash", "Seal_of_Autumn", "Lurk", "Seal_of_Winter", "Bulwark", "Dividend"]

SPELL_CONFIGS = {}
for name in RITUALS:
    SPELL_CONFIGS[name] = {"card_size": 322, "overlay_radius": 86}
for name in SORCERIES:
    SPELL_CONFIGS[name] = {"card_size": 260, "overlay_radius": 56}
for name in CHARMS:
    SPELL_CONFIGS[name] = {"card_size": 148, "overlay_radius": 23}

# Mapping spell name to raw image name prefix
RAW_MAPPING = {
    "Blossom": "blossom_rune_raw",
    "Scatter": "scatter_rune_raw",
    "Seal_of_Spring": "seal_of_spring_rune_raw",
    "Syzygy": "syzygy_rune_raw",
    "Eclipse": "eclipse_rune_raw",
    "Azimuth": "azimuth_rune_raw",
    "Erupt": "erupt_rune_raw",
    "Fury": "fury_rune_raw",
    "Charge": "charge_rune_raw",
    "Hurricane": "hurricane_rune_raw",
    "Storm_Front": "storm_front_rune_raw",
    "Gust": "gust_rune_raw",
    "Flood": "flood_rune_raw",
    "Torrent": "torrent_rune_raw",
    "Splash": "splash_rune_raw",
    "Harvest": "harvest_rune_raw",
    "Gather": "gather_rune_raw",
    "Seal_of_Autumn": "seal_of_autumn_rune_raw",
    "Corrupt": "corrupt_rune_raw",
    "Decay": "decay_rune_raw",
    "Lurk": "lurk_rune_raw",
    "Seal_of_Destruction": "seal_of_destruction_rune_raw",
    "Seal_of_Stone": "seal_of_stone_rune_raw",
    "Seal_of_Winter": "seal_of_winter_rune_raw",
    "Fissure": "fissure_rune_raw",
    "Rock_Slide": "rock_slide_rune_raw",
    "Bulwark": "bulwark_rune_raw",
    "Endowment": "endowment_rune_raw",
    "Annuity": "annuity_rune_raw",
    "Dividend": "dividend_rune_raw"
}

def find_latest_raw(prefix):
    pattern = os.path.join(artifacts_dir, f"{prefix}_*.jpg")
    matches = glob.glob(pattern)
    if matches:
        matches.sort()
        return matches[-1]
    return None

def apply_feathered_circular_mask(im, radius, feather_radius=2):
    width, height = im.size
    cx, cy = width // 2, height // 2
    
    mask = Image.new("L", (width, height), 0)
    mask_draw = ImageDraw.Draw(mask)
    r_draw = radius - 1
    mask_draw.ellipse((cx - r_draw, cy - r_draw, cx + r_draw, cy + r_draw), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather_radius))
    
    r, g, b, a = im.convert("RGBA").split()
    new_alpha = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, new_alpha))

def process_spells():
    print("Processing generated raw rune illustrations...")
    processed_count = 0
    
    for name, prefix in RAW_MAPPING.items():
        raw_path = find_latest_raw(prefix)
        if not raw_path:
            print(f"Skipping {name}: raw image not found.")
            continue
            
        print(f"Processing {name} from {os.path.basename(raw_path)}...")
        
        # Load raw generated image
        raw_im = Image.open(raw_path).convert("RGBA")
        
        # Crop to center square
        w, h = raw_im.size
        min_dim = min(w, h)
        left = (w - min_dim) // 2
        top = (h - min_dim) // 2
        raw_square = raw_im.crop((left, top, left + min_dim, top + min_dim))
        
        # Get target dimensions
        config = SPELL_CONFIGS[name]
        card_size = config["card_size"]
        overlay_radius = config["overlay_radius"]
        overlay_dim = 2 * overlay_radius
        
        # Resize raw square to the overlay dimension
        # Since the generated image has a circular frame inside, we want to crop just the inner circle.
        # Most of our generated images have a circle filling about 85% of the square.
        # Let's adjust the crop to capture the inner circle perfectly.
        # We will crop the central 82% of the image (this leaves out the outer square borders).
        crop_factor = 0.82
        crop_size = int(min_dim * crop_factor)
        cl = (min_dim - crop_size) // 2
        ct = (min_dim - crop_size) // 2
        raw_circle_area = raw_square.crop((cl, ct, cl + crop_size, ct + crop_size))
        
        # Resize to overlay dimensions
        resized_circle = raw_circle_area.resize((overlay_dim, overlay_dim), Image.Resampling.LANCZOS)
        
        # Apply circular feathered mask
        masked_circle = apply_feathered_circular_mask(resized_circle, overlay_radius, feather_radius=2)
        
        # Load template card
        card_path = os.path.join(spells_dir, f"{name}.png")
        if not os.path.exists(card_path):
            print(f"Error: Template card {card_path} not found!")
            continue
            
        card_im = Image.open(card_path).convert("RGBA")
        
        # Paste the circular rune onto the template card (centered)
        cx, cy = card_size // 2, card_size // 2
        paste_pos = (cx - overlay_radius, cy - overlay_radius)
        card_im.paste(masked_circle, paste_pos, mask=masked_circle)
        
        # Save to docs spells/
        dest_png_docs = os.path.join(spells_dir, f"{name}.png")
        dest_webp_docs = os.path.join(spells_dir, f"{name}.webp")
        card_im.save(dest_png_docs, "PNG")
        card_im.save(dest_webp_docs, "WEBP")
        
        # Save to static spells/ (Flask server)
        dest_png_static = os.path.join(static_spells_dir, f"{name}.png")
        dest_webp_static = os.path.join(static_spells_dir, f"{name}.webp")
        os.makedirs(os.path.dirname(dest_png_static), exist_ok=True)
        card_im.save(dest_png_static, "PNG")
        card_im.save(dest_webp_static, "WEBP")
        
        print(f"  Successfully processed and updated card for {name}.")
        processed_count += 1
        
    print(f"Processing complete. Updated {processed_count} cards.")

if __name__ == "__main__":
    process_spells()
