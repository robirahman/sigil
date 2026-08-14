import os
import glob
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageOps

# Directory paths
spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells"
static_spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/static/images/spells"
art_only_dir = os.path.join(spells_dir, "art_only")
brain_dir = "/home/robirahman94/.gemini/antigravity-cli/brain/bf90eaae-ebf7-4a11-8ee9-6146c7139282"

font_path_bold = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
font_path_reg = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"

def apply_circular_mask(im, radius):
    width, height = im.size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    cx, cy = width // 2, height // 2
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=255)
    
    r, g, b, a = im.convert("RGBA").split()
    new_alpha = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, new_alpha))

def render_curved_text_top(draw_target, text, cx, cy, radius, font, fill=(255, 255, 255, 255), stroke_width=2, stroke_color=(0, 0, 0, 255)):
    """
    Renders text curving along the top arc of a circle centered at (cx, cy) with given radius.
    Text runs left-to-right along top arc, upright, centered at top (-90 degrees).
    """
    char_widths = [font.getlength(ch) if hasattr(font, "getlength") else font.getsize(ch)[0] for ch in text]
    total_width = sum(char_widths)
    if total_width == 0:
        return
    total_angle = total_width / radius
    
    start_angle = -math.pi / 2 - total_angle / 2
    current_angle = start_angle
    
    for i, ch in enumerate(text):
        cw = char_widths[i]
        char_angle = current_angle + (cw / 2) / radius
        
        x = cx + radius * math.cos(char_angle)
        y = cy + radius * math.sin(char_angle)
        
        bbox = font.getbbox(ch)
        w = max(1, bbox[2] - bbox[0] + 6)
        h = max(1, bbox[3] - bbox[1] + 6)
        
        char_im = Image.new("RGBA", (w + 12, h + 12), (0, 0, 0, 0))
        char_draw = ImageDraw.Draw(char_im)
        char_draw.text((6, 6), ch, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_color)
        
        # Tangent rotation angle for top arc
        rot_deg = -(math.degrees(char_angle) + 90)
        rotated_char = char_im.rotate(rot_deg, resample=Image.Resampling.BICUBIC, expand=True)
        
        rw, rh = rotated_char.size
        draw_target.paste(rotated_char, (int(x - rw / 2), int(y - rh / 2)), mask=rotated_char)
        current_angle += cw / radius

def render_curved_text_bottom(draw_target, text, cx, cy, radius, font, fill=(255, 255, 255, 255), stroke_width=2, stroke_color=(0, 0, 0, 255)):
    """
    Renders text curving along the bottom arc of a circle centered at (cx, cy) with given radius.
    Text runs left-to-right along bottom arc, upright, centered at bottom (+90 degrees).
    """
    char_widths = [font.getlength(ch) if hasattr(font, "getlength") else font.getsize(ch)[0] for ch in text]
    total_width = sum(char_widths)
    if total_width == 0:
        return
    total_angle = total_width / radius
    
    start_angle = math.pi / 2 + total_angle / 2
    current_angle = start_angle
    
    for i, ch in enumerate(text):
        cw = char_widths[i]
        char_angle = current_angle - (cw / 2) / radius
        
        x = cx + radius * math.cos(char_angle)
        y = cy + radius * math.sin(char_angle)
        
        bbox = font.getbbox(ch)
        w = max(1, bbox[2] - bbox[0] + 6)
        h = max(1, bbox[3] - bbox[1] + 6)
        
        char_im = Image.new("RGBA", (w + 12, h + 12), (0, 0, 0, 0))
        char_draw = ImageDraw.Draw(char_im)
        char_draw.text((6, 6), ch, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_color)
        
        # Tangent rotation angle for bottom arc
        rot_deg = -(math.degrees(char_angle) - 90)
        rotated_char = char_im.rotate(rot_deg, resample=Image.Resampling.BICUBIC, expand=True)
        
        rw, rh = rotated_char.size
        draw_target.paste(rotated_char, (int(x - rw / 2), int(y - rh / 2)), mask=rotated_char)
        current_angle -= cw / radius

def tint_top_half(img, target_tint, cy):
    r, g, b, a = img.split()
    rgb = Image.merge("RGB", (r, g, b))
    gray = rgb.convert("L")
    
    tinted = ImageOps.colorize(gray, black="black", white=target_tint)
    tinted = tinted.convert("RGBA")
    
    arr_orig = np.array(img)
    arr_tinted = np.array(tinted)
    
    arr_orig[:cy, :, :3] = arr_tinted[:cy, :, :3]
    return Image.fromarray(arr_orig)

def find_latest_raw(prefix):
    pattern = os.path.join(brain_dir, f"{prefix}_*.jpg")
    matches = glob.glob(pattern)
    if matches:
        matches.sort()
        return matches[-1]
    return None

def generate_cards():
    spells_data = [
        {
            "name": "Corrupt",
            "type": "ritual",
            "size": 322,
            "inner_r": 86,
            "outer_r": 160,
            "base_image": "Decay.png",
            "raw_prefix": "corrupt_rune_raw",
            "title": "CORRUPT",
            "description": "Choose up to 3 enemy stones touching your stones. Convert them to your color, then sacrifice a stone.",
            "text_r": 130,
            "name_font_size": 20,
            "desc_font_size": 8.0,
            "bottom_bg_color": (28, 16, 38, 255),
            "texture_tint": (140, 90, 170),
            "ring_color": (215, 185, 240, 255),
            "spots": [
                (161, 259), # bottom spot
                (68, 191),  # middle-left spot
                (254, 191), # middle-right spot
                (104, 82),  # top-left spot
                (218, 82)   # top-right spot
            ]
        },
        {
            "name": "Endowment",
            "type": "ritual",
            "size": 322,
            "inner_r": 86,
            "outer_r": 160,
            "base_image": "Seal_of_Destruction.png",
            "raw_prefix": "endowment_rune_raw",
            "title": "ENDOWMENT",
            "description": "Make 1 extra move at the beginning of each of your next 4 turns.",
            "text_r": 130,
            "name_font_size": 20,
            "desc_font_size": 9.0,
            "bottom_bg_color": (38, 12, 58, 255),
            "texture_tint": (180, 130, 220),
            "ring_color": (235, 200, 90, 255),
            "spots": [
                (161, 259),
                (68, 191),
                (254, 191),
                (104, 82),
                (218, 82)
            ]
        },
        {
            "name": "Annuity",
            "type": "sorcery",
            "size": 260,
            "inner_r": 56,
            "outer_r": 128,
            "base_image": "Seal_of_Stone.png",
            "raw_prefix": "annuity_rune_raw",
            "title": "ANNUITY",
            "description": "Make 1 extra move at the beginning of each of your next 2 turns.",
            "text_r": 100,
            "name_font_size": 16,
            "desc_font_size": 7.8,
            "bottom_bg_color": (38, 12, 58, 255),
            "texture_tint": (180, 130, 220),
            "ring_color": (235, 200, 90, 255),
            "spots": [
                (130, 196),
                (73, 97),
                (187, 97)
            ]
        },
        {
            "name": "Dividend",
            "type": "charm",
            "size": 148,
            "inner_r": 23,
            "outer_r": 73,
            "base_image": "Seal_of_Winter.png",
            "raw_prefix": "dividend_rune_raw",
            "title": "DIVIDEND",
            "description": "Make 1 extra move at the beginning of your next turn.",
            "text_r": 54,
            "name_font_size": 11,
            "desc_font_size": 6.8,
            "bottom_bg_color": (38, 12, 58, 255),
            "texture_tint": (180, 130, 220),
            "ring_color": (235, 200, 90, 255),
            "spots": []
        }
    ]

    for spell in spells_data:
        name = spell["name"]
        size = spell["size"]
        cx, cy = size // 2, size // 2
        inner_r = spell["inner_r"]
        outer_r = spell["outer_r"]
        base_path = os.path.join(art_only_dir, spell["base_image"])
        
        print(f"\n--- Building Card Graphic for {name} ({size}x{size}) ---")
        if os.path.exists(base_path):
            img_raw = Image.open(base_path).convert("RGBA")
            img = img_raw.resize((size, size), Image.Resampling.LANCZOS)
        else:
            img = Image.new("RGBA", (size, size), (40, 20, 50, 255))
            
        # 1. Color-tint top half of background texture
        img = tint_top_half(img, spell["texture_tint"], cy)
        
        # 2. Fill bottom half with solid theme color masked to border region
        mask = Image.new("L", (size, size), 0)
        draw_mask = ImageDraw.Draw(mask)
        draw_mask.ellipse((cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r), fill=255)
        draw_mask.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), fill=0)
        
        split_mask = Image.new("L", (size, size), 0)
        draw_split = ImageDraw.Draw(split_mask)
        draw_split.rectangle((0, cy, size, size), fill=255)
        
        bottom_mask = ImageChops.multiply(mask, split_mask)
        solid_bg = Image.new("RGBA", (size, size), spell["bottom_bg_color"])
        img.paste(solid_bg, (0, 0), mask=bottom_mask)
        
        # 3. Draw inner and outer rings & horizontal dividing lines
        draw = ImageDraw.Draw(img)
        ring_col = spell["ring_color"]
        draw.ellipse((cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r), outline=ring_col, width=2)
        draw.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), outline=ring_col, width=2)
        draw.line((cx - outer_r, cy, cx - inner_r, cy), fill=ring_col, width=2)
        draw.line((cx + inner_r, cy, cx + outer_r, cy), fill=ring_col, width=2)
        
        # 4. Mask and overlay central raw rune illustration
        raw_path = find_latest_raw(spell["raw_prefix"])
        if raw_path and os.path.exists(raw_path):
            print(f"  Pasting rune art from {os.path.basename(raw_path)}")
            raw_im = Image.open(raw_path).convert("RGBA")
            w, h = raw_im.size
            min_dim = min(w, h)
            left = (w - min_dim) // 2
            top = (h - min_dim) // 2
            raw_square = raw_im.crop((left, top, left + min_dim, top + min_dim))
            
            crop_size = int(min_dim * 0.82)
            cl = (min_dim - crop_size) // 2
            ct = (min_dim - crop_size) // 2
            raw_cropped = raw_square.crop((cl, ct, cl + crop_size, ct + crop_size))
            
            illustration_dim = inner_r * 2
            resized_rune = raw_cropped.resize((illustration_dim, illustration_dim), Image.Resampling.LANCZOS)
            masked_rune = apply_circular_mask(resized_rune, inner_r)
            
            paste_pos = (cx - inner_r, cy - inner_r)
            img.paste(masked_rune, paste_pos, mask=masked_rune)
        else:
            print(f"  Warning: Raw image prefix {spell['raw_prefix']} not found!")

        # 5. Draw white node spots BEFORE drawing text
        draw_spots = ImageDraw.Draw(img)
        spot_r = 15 if spell["type"] == "charm" else (31 if spell["type"] == "sorcery" else 32)
        for sx, sy in spell["spots"]:
            draw_spots.ellipse((sx - spot_r, sy - spot_r, sx + spot_r, sy + spot_r), fill=(255, 255, 255, 255), outline=ring_col, width=1)
            
        # 6. Render curved name (top arc) and description text (bottom arc)
        font_name = ImageFont.truetype(font_path_bold, int(spell["name_font_size"]))
        font_desc = ImageFont.truetype(font_path_reg, int(spell["desc_font_size"]))
        
        render_curved_text_top(img, spell["title"], cx, cy, spell["text_r"], font_name, fill=(255, 223, 118, 255) if spell["name"] != "Corrupt" else (240, 220, 255, 255), stroke_width=2, stroke_color=(0, 0, 0, 255))
        render_curved_text_bottom(img, spell["description"], cx, cy, spell["text_r"], font_desc, fill=(255, 255, 255, 255), stroke_width=2, stroke_color=(0, 0, 0, 255))
        
        # 7. Apply outer circular mask
        final_card = apply_circular_mask(img, cx)
        
        # Save to docs spells/
        dest_png_docs = os.path.join(spells_dir, f"{name}.png")
        dest_webp_docs = os.path.join(spells_dir, f"{name}.webp")
        final_card.save(dest_png_docs, "PNG")
        final_card.save(dest_webp_docs, "WEBP")
        
        # Save to static spells/
        dest_png_static = os.path.join(static_spells_dir, f"{name}.png")
        dest_webp_static = os.path.join(static_spells_dir, f"{name}.webp")
        os.makedirs(os.path.dirname(dest_png_static), exist_ok=True)
        final_card.save(dest_png_static, "PNG")
        final_card.save(dest_webp_static, "WEBP")
        
        print(f"  Successfully created card images for {name}!")

if __name__ == "__main__":
    generate_cards()
