import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

def render_curved_text_top(draw_target, text, cx, cy, radius, font, fill, shadow_fill=None):
    """
    Renders text curving along the top arc of a circle centered at (cx, cy) with given radius.
    Text runs left-to-right along top arc, centered at angle -pi/2 (270 deg / top).
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
        
        if shadow_fill:
            char_draw.text((6 + 1, 6 + 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 - 1, 6 - 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 + 1, 6 - 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 - 1, 6 + 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6, 6 + 2), ch, font=font, fill=shadow_fill)
            
        char_draw.text((6, 6), ch, font=font, fill=fill)
        
        # Tangent rotation angle for top arc
        rot_deg = -(math.degrees(char_angle) + 90)
        rotated_char = char_im.rotate(rot_deg, resample=Image.BICUBIC, expand=True)
        
        rw, rh = rotated_char.size
        draw_target.paste(rotated_char, (int(x - rw / 2), int(y - rh / 2)), mask=rotated_char)
        
        current_angle += cw / radius

def render_curved_text_bottom(draw_target, text, cx, cy, radius, font, fill, shadow_fill=None):
    """
    Renders text curving along the bottom arc of a circle centered at (cx, cy) with given radius.
    Text runs left-to-right along bottom arc, upright, centered at angle +pi/2 (90 deg / bottom).
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
        
        if shadow_fill:
            char_draw.text((6 + 1, 6 + 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 - 1, 6 - 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 + 1, 6 - 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6 - 1, 6 + 1), ch, font=font, fill=shadow_fill)
            char_draw.text((6, 6 + 2), ch, font=font, fill=shadow_fill)
            
        char_draw.text((6, 6), ch, font=font, fill=fill)
        
        # Tangent rotation angle for bottom arc
        rot_deg = -(math.degrees(char_angle) - 90)
        rotated_char = char_im.rotate(rot_deg, resample=Image.BICUBIC, expand=True)
        
        rw, rh = rotated_char.size
        draw_target.paste(rotated_char, (int(x - rw / 2), int(y - rh / 2)), mask=rotated_char)
        
        current_angle -= cw / radius

def create_providence_border_template(name, size, overlay_radius, header_text, footer_text):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    cx, cy = size / 2, size / 2
    r_outer = size / 2
    
    # 1. Circular disc background (Royal Purple radial gradient)
    for r in range(int(r_outer), 0, -1):
        t = r / r_outer
        cr = int(38 * (1 - t) + 78 * t)
        cg = int(8 * (1 - t) + 22 * t)
        cb = int(68 * (1 - t) + 130 * t)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(cr, cg, cb, 255))
        
    # 2. Concentric Gold Rings & Filigree
    gold_primary = (212, 175, 55, 255)
    gold_light = (255, 223, 118, 255)
    gold_dark = (130, 95, 25, 255)
    purple_shadow = (20, 4, 32, 255)
    
    # Outer gold border rings
    draw.ellipse((cx - r_outer + 1, cy - r_outer + 1, cx + r_outer - 1, cy + r_outer - 1), outline=gold_dark, width=2)
    draw.ellipse((cx - r_outer + 4, cy - r_outer + 4, cx + r_outer - 4, cy + r_outer - 4), outline=gold_primary, width=3)
    draw.ellipse((cx - r_outer + 7, cy - r_outer + 7, cx + r_outer - 7, cy + r_outer - 7), outline=gold_light, width=2)
    
    # Inner gold border rings (around central rune window)
    draw.ellipse((cx - overlay_radius - 2, cy - overlay_radius - 2, cx + overlay_radius + 2, cy + overlay_radius + 2), outline=gold_light, width=2)
    draw.ellipse((cx - overlay_radius - 5, cy - overlay_radius - 5, cx + overlay_radius + 5, cy + overlay_radius + 5), outline=gold_primary, width=3)
    draw.ellipse((cx - overlay_radius - 8, cy - overlay_radius - 8, cx + overlay_radius + 8, cy + overlay_radius + 8), outline=gold_dark, width=2)
    
    # Fill central rune window area with parchment tint initially
    draw.ellipse((cx - overlay_radius, cy - overlay_radius, cx + overlay_radius, cy + overlay_radius), fill=(245, 235, 220, 255))

    # Radial spokes / filigree accent marks between inner and outer rings
    num_accents = 16
    for i in range(num_accents):
        ang = i * (2 * math.pi / num_accents)
        ax1 = cx + (r_outer - 12) * math.cos(ang)
        ay1 = cy + (r_outer - 12) * math.sin(ang)
        ax2 = cx + (overlay_radius + 10) * math.cos(ang)
        ay2 = cy + (overlay_radius + 10) * math.sin(ang)
        draw.line([(ax1, ay1), (ax2, ay2)], fill=(150, 115, 35, 140), width=1)
        
        # Small decorative gold diamonds near outer border
        dot_r = max(1.5, size * 0.012)
        dot_x = cx + (r_outer - 16) * math.cos(ang + math.pi / num_accents)
        dot_y = cy + (r_outer - 16) * math.sin(ang + math.pi / num_accents)
        draw.polygon([
            (dot_x, dot_y - dot_r),
            (dot_x + dot_r, dot_y),
            (dot_x, dot_y + dot_r),
            (dot_x - dot_r, dot_y)
        ], fill=gold_light)

    # 3. Typography (Curved Arc Text Header & Footer)
    try:
        font_size_head = max(10, int(size * 0.082))
        font_size_foot = max(7, int(size * 0.045))
        font_head = ImageFont.truetype("/usr/share/fonts/chromeos/roboto/Roboto-Bold.ttf", font_size_head)
        font_foot = ImageFont.truetype("/usr/share/fonts/chromeos/roboto/Roboto-Medium.ttf", font_size_foot)
    except Exception:
        font_head = ImageFont.load_default()
        font_foot = ImageFont.load_default()

    # Radius for top and bottom curved text
    text_r_head = r_outer - (r_outer - overlay_radius) * 0.42
    text_r_foot = r_outer - (r_outer - overlay_radius) * 0.38

    # Render top curved text (Spell Name)
    render_curved_text_top(im, header_text, cx, cy, text_r_head, font_head, gold_light, purple_shadow)

    # Render bottom curved text (Spell Pack / Type)
    render_curved_text_bottom(im, footer_text, cx, cy, text_r_foot, font_foot, (240, 220, 255, 255), purple_shadow)

    # Apply outer circular mask for clean transparency outside radius
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse((0, 0, size, size), fill=255)
    r, g, b, a = im.split()
    a = ImageChops.darker(a, mask)
    return Image.merge("RGBA", (r, g, b, a))

if __name__ == "__main__":
    spells_dir = "docs/static/images/spells"
    providence_spells = [
        ("Endowment", 322, 86, "ENDOWMENT", "PROVIDENCE • RITUAL"),
        ("Annuity", 260, 56, "ANNUITY", "PROVIDENCE • SORCERY"),
        ("Dividend", 148, 23, "DIVIDEND", "PROVIDENCE • CHARM")
    ]
    for name, size, overlay_r, head, foot in providence_spells:
        im = create_providence_border_template(name, size, overlay_r, head, foot)
        dest = os.path.join(spells_dir, f"{name}.png")
        im.save(dest, "PNG")
        print(f"Generated clean curved-text Providence border template for {name} ({size}x{size}).")
