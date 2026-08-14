import os
import glob
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageFilter, ImageOps

spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells"
static_spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/static/images/spells"
art_only_dir = os.path.join(spells_dir, "art_only")
static_art_only_dir = os.path.join(static_spells_dir, "art_only")
brain_dir = "/home/robirahman94/.gemini/antigravity-cli/brain/8329cbca-5b02-42da-a449-9091923cd0ee"

font_bold_path = "/usr/share/fonts/chromeos/croscore/Tinos-Bold.ttf"
font_reg_path = "/usr/share/fonts/chromeos/croscore/Tinos-Regular.ttf"

def apply_circular_mask(im, radius):
    width, height = im.size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    cx, cy = width // 2, height // 2
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=255)
    
    r, g, b, a = im.convert("RGBA").split()
    new_alpha = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, new_alpha))

def render_centered_arc_text(im, text, center, radius, target_center_angle_deg, direction=1, font_path=font_reg_path, font_size=9, color=(255, 255, 255, 255), spacing_mult=1.0, face_in=True):
    font = ImageFont.truetype(font_path, int(font_size) if isinstance(font_size, int) else font_size)
    cx, cy = center
    
    total_angle_deg = 0
    char_angles = []
    
    for char in text:
        if char == " ":
            step = (1.8 * font_size / radius) * (180 / math.pi) * spacing_mult
        else:
            char_w = font.getlength(char)
            step = (char_w / radius) * (180 / math.pi) * spacing_mult
        char_angles.append(step)
        total_angle_deg += step
        
    start_angle_deg = target_center_angle_deg - direction * (total_angle_deg / 2)
    
    ascent, descent = font.getmetrics()
    current_angle_deg = start_angle_deg
    
    for i, char in enumerate(text):
        step = char_angles[i]
        if char == " ":
            current_angle_deg += direction * step
            continue
            
        char_w = font.getlength(char)
        pad = 24
        w = int(char_w + pad * 2)
        h = int(ascent + descent + pad * 2)
        
        char_im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        char_draw = ImageDraw.Draw(char_im)
        
        pivot_x = pad + char_w / 2
        pivot_y = pad + ascent
        char_draw.text((pivot_x, pivot_y), char, font=font, fill=color, anchor="ms")
        
        slot_center_angle = current_angle_deg + direction * (step / 2)
        rad = math.radians(slot_center_angle)
        px = cx + radius * math.cos(rad)
        py = cy + radius * math.sin(rad)
        
        if face_in:
            rot_deg = 90 - slot_center_angle
        else:
            rot_deg = -slot_center_angle - 90
            
        rotated_char = char_im.rotate(rot_deg, center=(pivot_x, pivot_y), resample=Image.Resampling.BICUBIC, expand=False)
        im.paste(rotated_char, (int(px - pivot_x), int(py - pivot_y)), mask=rotated_char)
        
        current_angle_deg += direction * step
        
    return start_angle_deg, current_angle_deg

def find_latest_file(pattern_str):
    matches = glob.glob(pattern_str)
    if matches:
        matches.sort()
        return matches[-1]
    return None

def build_card(config):
    name = config["name"]
    size = config["size"]
    cx, cy = size // 2, size // 2
    inner_r = config["inner_r"]
    outer_r = config["outer_r"]
    
    print(f"\nBuilding card: {name} ({size}x{size})")
    
    # 1. Background Texture
    bg_texture_path = find_latest_file(os.path.join(brain_dir, config["bg_texture_prefix"] + "_*.jpg"))
    if bg_texture_path and os.path.exists(bg_texture_path):
        tex_raw = Image.open(bg_texture_path).convert("RGBA")
        tex = tex_raw.resize((size, size), Image.Resampling.LANCZOS)
    else:
        tex = Image.new("RGBA", (size, size), (30, 20, 20, 255))
        
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Top half: Texture
    top_mask = Image.new("L", (size, size), 0)
    draw_top = ImageDraw.Draw(top_mask)
    draw_top.rectangle((0, 0, size, cy), fill=255)
    im.paste(tex, (0, 0), mask=top_mask)
    
    # Bottom half: Solid Theme Background
    bot_mask = Image.new("L", (size, size), 0)
    draw_bot = ImageDraw.Draw(bot_mask)
    draw_bot.rectangle((0, cy, size, size), fill=255)
    solid_bot = Image.new("RGBA", (size, size), config["bottom_bg"])
    im.paste(solid_bot, (0, 0), mask=bot_mask)
    
    # 2. Draw outer and inner border ring lines & horizontal dividers
    draw = ImageDraw.Draw(im)
    border_col = config.get("border_color", (255, 255, 255, 255))
    draw.ellipse((cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r), outline=border_col, width=2)
    draw.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), outline=border_col, width=2)
    draw.line([(0, cy), (cx - inner_r, cy)], fill=(255, 255, 255, 255), width=2)
    draw.line([(cx + inner_r, cy), (size, cy)], fill=(255, 255, 255, 255), width=2)
    
    # 3. Paste central circular masked rune
    raw_path = find_latest_file(os.path.join(brain_dir, config["raw_prefix"] + "_*.jpg"))
    if raw_path and os.path.exists(raw_path):
        print(f"  Using raw rune: {os.path.basename(raw_path)}")
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
        
        im.paste(masked_rune, (cx - inner_r, cy - inner_r), mask=masked_rune)
        
        # Save art_only assets
        masked_rune.save(os.path.join(art_only_dir, f"{name}.png"), "PNG")
        masked_rune.save(os.path.join(art_only_dir, f"{name}.webp"), "WEBP")
        masked_rune.save(os.path.join(static_art_only_dir, f"{name}.png"), "PNG")
        masked_rune.save(os.path.join(static_art_only_dir, f"{name}.webp"), "WEBP")
        print(f"  Exported art_only for {name} ({illustration_dim}x{illustration_dim})")
        
    # 4. Stamp white node circles matching the exact board template positions!
    spots = config.get("spots", [])
    spot_r = config.get("spot_radius", 32)
    if spots:
        draw_spots = ImageDraw.Draw(im)
        for sx, sy in spots:
            # Draw solid opaque white node circle (identical to base game cards)
            draw_spots.ellipse((sx - spot_r, sy - spot_r, sx + spot_r, sy + spot_r), fill=(255, 255, 255, 255))
            
    # 5. Render Name text on bottom-left arc (centered between nodes!)
    render_centered_arc_text(
        im,
        config["title"],
        (cx, cy),
        radius=config["name_radius"],
        target_center_angle_deg=config["name_center_deg"],
        direction=-1,
        font_path=font_bold_path,
        font_size=config["name_font_size"],
        color=(255, 255, 255, 255),
        spacing_mult=config.get("name_spacing", 0.98),
        face_in=True
    )
    
    # 6. Render Description text on bottom-right arc (centered in open space!)
    for line_info in config["desc_lines"]:
        render_centered_arc_text(
            im,
            line_info["text"],
            (cx, cy),
            radius=line_info["radius"],
            target_center_angle_deg=line_info["center_deg"],
            direction=1,
            font_path=font_reg_path,
            font_size=line_info["font_size"],
            color=(245, 245, 245, 255),
            spacing_mult=line_info.get("spacing", 0.90),
            face_in=True
        )
        
    # 7. Apply outer circular card mask
    final_card = apply_circular_mask(im, cx)
    
    # Save card to docs/ and static/
    final_card.save(os.path.join(spells_dir, f"{name}.png"), "PNG")
    final_card.save(os.path.join(spells_dir, f"{name}.webp"), "WEBP")
    final_card.save(os.path.join(static_spells_dir, f"{name}.png"), "PNG")
    final_card.save(os.path.join(static_spells_dir, f"{name}.webp"), "WEBP")
    print(f"  Exported card {name}.png and .webp")

def main():
    # Exact Board Node Coordinates:
    # Ritual (322x322):
    #   [0.500*322, 0.803*322] = (161.0, 258.6)
    #   [0.212*322, 0.594*322] = (68.3, 191.3)
    #   [0.788*322, 0.594*322] = (253.7, 191.3)
    #   [0.322*322, 0.255*322] = (103.7, 82.1)
    #   [0.678*322, 0.255*322] = (218.3, 82.1)
    #
    # Sorcery (260x260):
    #   [0.500*260, 0.755*260] = (130.0, 196.3)
    #   [0.279*260, 0.373*260] = (72.5, 97.0)
    #   [0.721*260, 0.373*260] = (187.5, 97.0)

    spells = [
        # --- Aftershock Pack ---
        {
            "name": "Conflagration",
            "size": 322,
            "inner_r": 86,
            "outer_r": 160,
            "bg_texture_prefix": "aftershock_bg_texture",
            "bottom_bg": (18, 10, 12, 255),
            "border_color": (255, 170, 60, 255),
            "raw_prefix": "conflagration_rune_raw",
            "spot_radius": 32,
            "spots": [
                (161.0, 258.6),
                (68.3, 191.3),
                (253.7, 191.3),
                (103.7, 82.1),
                (218.3, 82.1)
            ],
            "title": "CONFLAGRATION",
            "name_radius": 136,
            "name_center_deg": 126,
            "name_font_size": 9.5,
            "desc_lines": [
                {
                    "text": "Destroy 1 enemy stone touching your stones",
                    "radius": 138,
                    "center_deg": 54,
                    "font_size": 6.0,
                    "spacing": 0.88
                },
                {
                    "text": "at the beginning of each of your next 4 turns.",
                    "radius": 118,
                    "center_deg": 54,
                    "font_size": 5.8,
                    "spacing": 0.88
                }
            ]
        },
        {
            "name": "Smolder",
            "size": 260,
            "inner_r": 56,
            "outer_r": 128,
            "bg_texture_prefix": "aftershock_bg_texture",
            "bottom_bg": (18, 10, 12, 255),
            "border_color": (255, 170, 60, 255),
            "raw_prefix": "smolder_rune_raw",
            "spot_radius": 31,
            "spots": [
                (130.0, 196.3),
                (72.5, 97.0),
                (187.5, 97.0)
            ],
            "title": "SMOLDER",
            "name_radius": 105,
            "name_center_deg": 138,
            "name_font_size": 11.5,
            "desc_lines": [
                {
                    "text": "Destroy 1 enemy stone touching your stones",
                    "radius": 106,
                    "center_deg": 45,
                    "font_size": 6.2,
                    "spacing": 0.88
                },
                {
                    "text": "at the beginning of each of your next 2 turns.",
                    "radius": 90,
                    "center_deg": 45,
                    "font_size": 6.0,
                    "spacing": 0.88
                }
            ]
        },
        {
            "name": "Ember",
            "size": 148,
            "inner_r": 23,
            "outer_r": 73,
            "bg_texture_prefix": "aftershock_bg_texture",
            "bottom_bg": (18, 10, 12, 255),
            "border_color": (255, 170, 60, 255),
            "raw_prefix": "ember_rune_raw",
            "spots": [],
            "title": "EMBER",
            "name_radius": 58,
            "name_center_deg": 135,
            "name_font_size": 9.5,
            "desc_lines": [
                {
                    "text": "Destroy 1 enemy stone touching your stones",
                    "radius": 58,
                    "center_deg": 45,
                    "font_size": 4.6,
                    "spacing": 0.88
                },
                {
                    "text": "at the beginning of your next turn.",
                    "radius": 46,
                    "center_deg": 45,
                    "font_size": 4.6,
                    "spacing": 0.88
                }
            ]
        },
        # --- Ambush Pack ---
        {
            "name": "Minefield",
            "size": 322,
            "inner_r": 86,
            "outer_r": 160,
            "bg_texture_prefix": "ambush_bg_texture",
            "bottom_bg": (12, 20, 12, 255),
            "border_color": (180, 215, 130, 255),
            "raw_prefix": "minefield_rune_raw",
            "spot_radius": 32,
            "spots": [
                (161.0, 258.6),
                (68.3, 191.3),
                (253.7, 191.3),
                (103.7, 82.1),
                (218.3, 82.1)
            ],
            "title": "MINEFIELD",
            "name_radius": 136,
            "name_center_deg": 126,
            "name_font_size": 10.5,
            "desc_lines": [
                {
                    "text": "Place snares on up to 4 empty nodes. The first",
                    "radius": 140,
                    "center_deg": 54,
                    "font_size": 5.8,
                    "spacing": 0.86
                },
                {
                    "text": "enemy stone that stops on a snare is destroyed.",
                    "radius": 126,
                    "center_deg": 54,
                    "font_size": 5.6,
                    "spacing": 0.86
                },
                {
                    "text": "Snares count toward defense.",
                    "radius": 112,
                    "center_deg": 54,
                    "font_size": 5.6,
                    "spacing": 0.86
                }
            ]
        },
        {
            "name": "Deadfall",
            "size": 260,
            "inner_r": 56,
            "outer_r": 128,
            "bg_texture_prefix": "ambush_bg_texture",
            "bottom_bg": (12, 20, 12, 255),
            "border_color": (180, 215, 130, 255),
            "raw_prefix": "deadfall_rune_raw",
            "spot_radius": 31,
            "spots": [
                (130.0, 196.3),
                (72.5, 97.0),
                (187.5, 97.0)
            ],
            "title": "DEADFALL",
            "name_radius": 105,
            "name_center_deg": 138,
            "name_font_size": 11.5,
            "desc_lines": [
                {
                    "text": "Place snares on up to 2 empty nodes. The first enemy",
                    "radius": 106,
                    "center_deg": 45,
                    "font_size": 5.6,
                    "spacing": 0.86
                },
                {
                    "text": "stone that stops on a snare is destroyed. Snares count for defense.",
                    "radius": 90,
                    "center_deg": 45,
                    "font_size": 5.4,
                    "spacing": 0.86
                }
            ]
        },
        {
            "name": "Tripwire",
            "size": 148,
            "inner_r": 23,
            "outer_r": 73,
            "bg_texture_prefix": "ambush_bg_texture",
            "bottom_bg": (12, 20, 12, 255),
            "border_color": (180, 215, 130, 255),
            "raw_prefix": "tripwire_rune_raw",
            "spots": [],
            "title": "TRIPWIRE",
            "name_radius": 58,
            "name_center_deg": 135,
            "name_font_size": 9.5,
            "desc_lines": [
                {
                    "text": "Place a snare on 1 empty node. The first",
                    "radius": 58,
                    "center_deg": 45,
                    "font_size": 4.6,
                    "spacing": 0.86
                },
                {
                    "text": "enemy stone that stops there is destroyed.",
                    "radius": 46,
                    "center_deg": 45,
                    "font_size": 4.6,
                    "spacing": 0.86
                }
            ]
        }
    ]
    
    for s in spells:
        build_card(s)
        
    print("\nAll 6 cards regenerated with exact board node alignments!")

if __name__ == "__main__":
    main()
