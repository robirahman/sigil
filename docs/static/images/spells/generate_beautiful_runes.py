import os
import math
import random
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageChops

# Setup directories
spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells"
static_spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/static/images/spells"
parchment_path = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/themes/tiled-background-parchment.jpg"

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

# Themed pastel tinted backgrounds for Sorceries/Rituals
TINT_COLORS = {
    "springtime": (205, 235, 205, 255),    # Muted light green
    "celestial": (205, 215, 235, 255),     # Muted light steel blue
    "fury": (240, 210, 200, 255),          # Muted warm orange-red
    "tempest": (200, 230, 230, 255),       # Muted light teal
    "tsunami": (200, 220, 240, 255),       # Muted light sky blue
    "autumn": (235, 215, 195, 255),        # Muted light bronze/amber
    "gloom": (225, 210, 235, 255),         # Muted light purple/lavender
    "covenant": (240, 230, 195, 255),      # Muted light gold
    "tectonic": (220, 215, 205, 255),      # Muted light earth grey-brown
    "providence": (235, 215, 245, 255),    # Muted royal purple/gold
}

# Rich palettes for drawing the artistic symbols
PALETTES = {
    "springtime": {
        "primary": (35, 110, 56),
        "secondary": (76, 175, 80),
        "light": (165, 214, 167),
        "dark": (20, 70, 35)
    },
    "celestial": {
        "primary": (33, 44, 110),
        "secondary": (91, 103, 204),
        "light": (197, 202, 233),
        "dark": (12, 16, 45)
    },
    "fury": {
        "primary": (180, 40, 30),
        "secondary": (244, 110, 50),
        "light": (255, 180, 100),
        "dark": (70, 15, 10)
    },
    "tempest": {
        "primary": (25, 95, 112),
        "secondary": (0, 172, 193),
        "light": (178, 235, 242),
        "dark": (10, 35, 45)
    },
    "tsunami": {
        "primary": (25, 75, 140),
        "secondary": (33, 150, 243),
        "light": (187, 222, 251),
        "dark": (10, 30, 60)
    },
    "autumn": {
        "primary": (135, 70, 25),
        "secondary": (210, 105, 30),
        "light": (244, 164, 96),
        "dark": (75, 35, 10)
    },
    "gloom": {
        "primary": (75, 35, 95),
        "secondary": (142, 68, 173),
        "light": (210, 180, 222),
        "dark": (35, 15, 45)
    },
    "covenant": {
        "primary": (140, 110, 35),
        "secondary": (215, 175, 55),
        "light": (255, 235, 150),
        "dark": (70, 55, 15)
    },
    "tectonic": {
        "primary": (95, 75, 60),
        "secondary": (160, 130, 110),
        "light": (215, 200, 185),
        "dark": (50, 40, 30)
    },
    "providence": {
        "primary": (106, 27, 154),
        "secondary": (212, 175, 55),
        "light": (255, 223, 118),
        "dark": (48, 10, 72)
    }
}

PACK_MAPPING = {
    "Blossom": "springtime", "Scatter": "springtime", "Seal_of_Spring": "springtime",
    "Syzygy": "celestial", "Eclipse": "celestial", "Azimuth": "celestial",
    "Erupt": "fury", "Fury": "fury", "Charge": "fury",
    "Hurricane": "tempest", "Storm_Front": "tempest", "Gust": "tempest",
    "Flood": "tsunami", "Torrent": "tsunami", "Splash": "tsunami",
    "Harvest": "autumn", "Gather": "autumn", "Seal_of_Autumn": "autumn",
    "Corrupt": "gloom", "Decay": "gloom", "Lurk": "gloom",
    "Seal_of_Destruction": "covenant", "Seal_of_Stone": "covenant", "Seal_of_Winter": "covenant",
    "Fissure": "tectonic", "Rock_Slide": "tectonic", "Bulwark": "tectonic",
    "Endowment": "providence", "Annuity": "providence", "Dividend": "providence"
}

# --- Detailed Drawing Helpers ---

def get_wobbly_points_line(p1, p2, jitter=2.0):
    x1, y1 = p1
    x2, y2 = p2
    dx = x2 - x1
    dy = y2 - y1
    dist = math.hypot(dx, dy)
    if dist < 2:
        return [p1, p2]
    
    num_pts = max(3, int(dist / 4))
    points = [p1]
    
    nx = -dy / dist
    ny = dx / dist
    for i in range(1, num_pts):
        t = i / num_pts
        bx = x1 + dx * t
        by = y1 + dy * t
        scale = math.sin(t * math.pi) * jitter
        offset = (random.random() - 0.5) * 2 * scale
        points.append((bx + nx * offset, by + ny * offset))
    points.append(p2)
    return points

def get_wobbly_points_ellipse(cx, cy, rx, ry, jitter=2.5):
    num_pts = 72
    points = []
    phase = random.random() * 2 * math.pi
    freq = random.choice([2, 3, 4])
    for i in range(num_pts):
        theta = i * (2 * math.pi / num_pts)
        wobble = math.sin(theta * freq + phase) * jitter * 0.7
        noise = (random.random() - 0.5) * jitter * 0.6
        r_offset = wobble + noise
        px = cx + (rx + r_offset) * math.cos(theta)
        py = cy + (ry + r_offset) * math.sin(theta)
        points.append((px, py))
    points.append(points[0])
    return points

def get_wobbly_points_arc(cx, cy, rx, ry, start_angle, end_angle, jitter=2.5):
    diff = (end_angle - start_angle) % (2 * math.pi)
    if diff == 0:
        diff = 2 * math.pi
    num_pts = max(5, int(diff * 36 / math.pi))
    points = []
    phase = random.random() * 2 * math.pi
    for i in range(num_pts + 1):
        t = i / num_pts
        theta = start_angle + diff * t
        scale = math.sin(t * math.pi) * jitter
        wobble = math.sin(t * 3 + phase) * scale * 0.7
        noise = (random.random() - 0.5) * scale * 0.6
        r_offset = wobble + noise
        px = cx + (rx + r_offset) * math.cos(theta)
        py = cy + (ry + r_offset) * math.sin(theta)
        points.append((px, py))
    return points

def draw_textured_path(draw, points, color, base_width):
    interpolated = []
    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i+1]
        dist = math.hypot(x2 - x1, y2 - y1)
        steps = max(1, int(dist * 2.0))
        for s in range(steps):
            t = s / steps
            interpolated.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    interpolated.append(points[-1])
    
    r, g, b = color[:3]
    current_width = base_width
    for p in interpolated:
        current_width += (random.random() - 0.5) * 0.4
        current_width = max(base_width * 0.7, min(base_width * 1.3, current_width))
        
        op_factor = 0.82 + 0.18 * random.random()
        cr = int(r * op_factor + 255 * (1.0 - op_factor))
        cg = int(g * op_factor + 255 * (1.0 - op_factor))
        cb = int(b * op_factor + 255 * (1.0 - op_factor))
        
        w_half = current_width / 2
        draw.ellipse((p[0] - w_half, p[1] - w_half, p[0] + w_half, p[1] + w_half), fill=(cr, cg, cb))

def draw_radial_gradient(draw, cx, cy, radius, inner_color, outer_color):
    r1, g1, b1 = inner_color[:3]
    r2, g2, b2 = outer_color[:3]
    a1 = inner_color[3] if len(inner_color) > 3 else 255
    a2 = outer_color[3] if len(outer_color) > 3 else 255
    for r in range(radius, 0, -1):
        t = r / radius
        cr = int(r1 * (1 - t) + r2 * t)
        cg = int(g1 * (1 - t) + g2 * t)
        cb = int(b1 * (1 - t) + b2 * t)
        ca = int(a1 * (1 - t) + a2 * t)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(cr, cg, cb, ca))

def draw_leaf(draw, cx, cy, length, width, angle, color, vein_color=None):
    num_pts = 20
    points_left = []
    points_right = []
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    
    for i in range(num_pts + 1):
        t = i / num_pts
        x_local = t * length - length / 2
        w_local = width * math.sin(t * math.pi)
        
        xl_rot = x_local * cos_a - w_local * sin_a
        yl_rot = x_local * sin_a + w_local * cos_a
        points_left.append((cx + xl_rot, cy + yl_rot))
        
        xr_rot = x_local * cos_a + w_local * sin_a
        yr_rot = x_local * sin_a - w_local * cos_a
        points_right.append((cx + xr_rot, cy + yr_rot))
        
    leaf_poly = points_left + points_right[::-1]
    draw.polygon(leaf_poly, fill=color)
    if vein_color:
        p1 = (cx - length/2 * cos_a, cy - length/2 * sin_a)
        p2 = (cx + length/2 * cos_a, cy + length/2 * sin_a)
        draw.line([p1, p2], fill=vein_color, width=2)

def draw_rock(draw, cx, cy, radius, color_base, color_light, color_shadow):
    num_sides = random.randint(5, 7)
    points = []
    for i in range(num_sides):
        angle = i * (2 * math.pi / num_sides)
        r = radius * (0.85 + 0.3 * random.random())
        points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    
    draw.polygon(points, fill=color_base)
    center_pt = (cx + (random.random()-0.5)*radius*0.1, cy + (random.random()-0.5)*radius*0.1)
    
    for i in range(num_sides):
        p1 = points[i]
        p2 = points[(i + 1) % num_sides]
        facet = [p1, p2, center_pt]
        
        # Shade based on face angle
        mx = (p1[0] + p2[0]) / 2 - cx
        my = (p1[1] + p2[1]) / 2 - cy
        if mx < 0 or my < 0:
            face_color = color_light
        else:
            face_color = color_shadow
        draw.polygon(facet, fill=face_color)

def draw_star(draw, cx, cy, r_outer, r_inner, points, color_light, color_shadow):
    angle_step = math.pi / points
    for i in range(points):
        angle_outer = i * 2 * angle_step
        x_out = cx + r_outer * math.cos(angle_outer)
        y_out = cy + r_outer * math.sin(angle_outer)
        
        angle_inner_l = angle_outer - angle_step
        x_in_l = cx + r_inner * math.cos(angle_inner_l)
        y_in_l = cy + r_inner * math.sin(angle_inner_l)
        
        angle_inner_r = angle_outer + angle_step
        x_in_r = cx + r_inner * math.cos(angle_inner_r)
        y_in_r = cy + r_inner * math.sin(angle_inner_r)
        
        draw.polygon([(cx, cy), (x_in_l, y_in_l), (x_out, y_out)], fill=color_light)
        draw.polygon([(cx, cy), (x_out, y_out), (x_in_r, y_in_r)], fill=color_shadow)

# --- Procedural Art Generators ---

def render_artistic_rune(name, draw, pal):
    cx, cy = 256, 256
    
    if name == "Blossom":
        # 8 beautiful radiating petals
        for i in range(8):
            angle = i * (math.pi / 4)
            px = cx + 80 * math.cos(angle)
            py = cy + 80 * math.sin(angle)
            draw_leaf(draw, px, py, length=110, width=40, angle=angle, color=pal["primary"], vein_color=pal["light"])
        # Inner petals
        for i in range(8):
            angle = i * (math.pi / 4) + (math.pi / 8)
            px = cx + 50 * math.cos(angle)
            py = cy + 50 * math.sin(angle)
            draw_leaf(draw, px, py, length=70, width=24, angle=angle, color=pal["secondary"], vein_color=pal["light"])
        # Glowing center
        draw_radial_gradient(draw, cx, cy, radius=35, inner_color=(255, 235, 120), outer_color=pal["primary"])
        # Spiral vines decoration
        draw.arc((cx-120, cy-120, cx+120, cy+120), start=0, end=270, fill=pal["dark"], width=4)
        
    elif name == "Scatter":
        # Swirling wind backdrop
        for r in range(120, 20, -10):
            t = r / 120
            color = (pal["secondary"][0], pal["secondary"][1], pal["secondary"][2], int(40 * (1-t)))
            draw.ellipse((cx-r, cy-r, cx+r, cy+r), outline=color, width=8)
        # Scattered leaves
        for i in range(10):
            angle = i * (2 * math.pi / 10) + 0.5
            dist = 60 + 50 * math.sin(i * 3)
            lx = cx + dist * math.cos(angle)
            ly = cy + dist * math.sin(angle)
            draw_leaf(draw, lx, ly, length=45, width=18, angle=angle + 1.2, color=pal["primary"], vein_color=pal["light"])
        # Seeds
        for i in range(12):
            angle = i * (2 * math.pi / 12)
            sx = cx + 110 * math.cos(angle)
            sy = cy + 110 * math.sin(angle)
            draw.ellipse((sx-6, sy-6, sx+6, sy+6), fill=pal["light"])
            
    elif name == "Seal_of_Spring":
        # Large central spiraling leaf and glowing seed
        draw_leaf(draw, cx, cy+15, length=160, width=70, angle=math.radians(-30), color=pal["primary"], vein_color=pal["light"])
        draw_leaf(draw, cx-40, cy-30, length=110, width=45, angle=math.radians(-75), color=pal["secondary"], vein_color=pal["light"])
        # Swirling stalk
        draw.arc((cx-90, cy-90, cx+90, cy+90), start=90, end=360, fill=pal["dark"], width=8)
        draw_radial_gradient(draw, cx+40, cy-40, radius=20, inner_color=(255, 240, 180), outer_color=pal["secondary"])
        
    elif name == "Syzygy":
        # Glowing orbit connector line
        draw.line([(80, cy), (432, cy)], fill=pal["primary"], width=6)
        # Central Earth
        draw.ellipse((cx-35, cy-35, cx+35, cy+35), fill=(40, 110, 180)) # Blue
        # Continents on earth
        draw.ellipse((cx-15, cy-15, cx+5, cy+10), fill=pal["primary"])
        draw.ellipse((cx+10, cy+5, cx+25, cy+20), fill=pal["primary"])
        # Sun (left)
        draw_radial_gradient(draw, cx-120, cy, radius=45, inner_color=(255, 235, 120), outer_color=pal["primary"])
        # Sun rays
        for i in range(8):
            angle = i * (math.pi / 4)
            x1 = cx - 120 + 40 * math.cos(angle)
            y1 = cy + 40 * math.sin(angle)
            x2 = cx - 120 + 60 * math.cos(angle)
            y2 = cy + 60 * math.sin(angle)
            draw.line([(x1, y1), (x2, y2)], fill=pal["secondary"], width=4)
        # Moon (right)
        draw.ellipse((cx+120-25, cy-25, cx+120+25, cy+25), fill=pal["light"])
        # Moon shadow crescent overlay
        draw.ellipse((cx+120-15, cy-30, cx+120+35, cy+20), fill=pal["dark"])
        
    elif name == "Eclipse":
        # Sun corona rays behind eclipse
        for i in range(36):
            angle = i * (math.pi / 180 * 10)
            x = cx + 130 * math.cos(angle)
            y = cy + 130 * math.sin(angle)
            draw.line([(cx, cy), (x, y)], fill=pal["secondary"], width=5)
        # Black sun silhouette
        draw.ellipse((cx-90, cy-90, cx+90, cy+90), fill=pal["dark"])
        # Glowing diamond ring effect
        draw_radial_gradient(draw, cx+70, cy-50, radius=30, inner_color=(255, 255, 255), outer_color=pal["primary"])
        
    elif name == "Azimuth":
        # 3D Beveled Navigational Star
        draw.ellipse((cx-120, cy-120, cx+120, cy+120), outline=pal["primary"], width=6)
        draw_star(draw, cx, cy, r_outer=110, r_inner=35, points=4, color_light=pal["light"], color_shadow=pal["primary"])
        draw_star(draw, cx, cy, r_outer=65, r_inner=20, points=8, color_light=pal["secondary"], color_shadow=pal["dark"])
        # Gem center
        draw_radial_gradient(draw, cx, cy, radius=14, inner_color=(255, 255, 255), outer_color=(33, 150, 243))
        
    elif name == "Erupt":
        # Charcoal Volcano Peak
        volcano = [(140, 390), (220, 220), (292, 220), (372, 390)]
        draw.polygon(volcano, fill=pal["dark"])
        # Glowing crater
        draw_radial_gradient(draw, cx, 220, radius=35, inner_color=(255, 230, 100), outer_color=pal["primary"])
        # Lava flows cascading down
        draw.line([(240, 225), (200, 300), (170, 385)], fill=pal["secondary"], width=6)
        draw.line([(240, 225), (210, 320), (185, 385)], fill=pal["light"], width=3)
        draw.line([(272, 225), (312, 310), (342, 385)], fill=pal["secondary"], width=6)
        # Smoke clouds
        smoke_centers = [(220, 170, 45), (256, 140, 55), (292, 170, 45)]
        for sx, sy, sr in smoke_centers:
            draw.ellipse((sx-sr, sy-sr, sx+sr, sy+sr), fill=(100, 95, 95))
        for sx, sy, sr in smoke_centers:
            draw.ellipse((sx-sr+5, sy-sr+5, sx+sr-5, sy+sr-5), fill=(140, 135, 135))
        # Lava sparks
        for _ in range(15):
            sx = random.randint(180, 332)
            sy = random.randint(110, 210)
            draw.ellipse((sx-4, sy-4, sx+4, sy+4), fill=pal["light"])
            
    elif name == "Fury":
        # Charred background cracks
        for _ in range(8):
            x1 = random.randint(100, 412)
            y1 = random.randint(100, 412)
            x2 = x1 + random.randint(-40, 40)
            y2 = y1 + random.randint(-40, 40)
            draw.line([(x1, y1), (x2, y2)], fill=pal["dark"], width=4)
        # Three fiery slashes
        offsets = [-85, 0, 85]
        for offset in offsets:
            slash_poly = [(cx+offset-25, 90), (cx+offset+25, 210), (cx+offset-35, 310), (cx+offset+15, 420),
                          (cx+offset-5, 420), (cx+offset-45, 310), (cx+offset+5, 210), (cx+offset-45, 90)]
            draw.polygon(slash_poly, fill=pal["primary"])
            # Core bright flame
            slash_core = [(cx+offset-15, 100), (cx+offset+15, 210), (cx+offset-25, 310), (cx+offset+5, 410),
                          (cx+offset-35, 310), (cx+offset+5, 210), (cx+offset-35, 100)]
            draw.polygon(slash_core, fill=pal["light"])
            
    elif name == "Charge":
        # 3D Beveled speed arrow
        arrow_head = [(370, 140), (220, 180), (270, 250), (140, 380), (130, 390), (250, 270), (320, 320)]
        draw.polygon(arrow_head, fill=pal["primary"])
        # Bevel highlights
        draw.polygon([(370, 140), (220, 180), (270, 250), (cx+20, cy+20)], fill=pal["light"])
        draw.polygon([(370, 140), (cx+20, cy+20), (250, 270), (320, 320)], fill=pal["secondary"])
        # Action lines
        draw.line([(80, 390), (140, 450)], fill=pal["secondary"], width=5)
        draw.line([(120, 350), (180, 410)], fill=pal["secondary"], width=5)
        draw.line([(60, 410), (100, 450)], fill=pal["light"], width=3)
        
    elif name == "Hurricane":
        # Outer wind ring
        draw.ellipse((cx-120, cy-120, cx+120, cy+120), outline=pal["primary"], width=6)
        # Giant spiral vortex
        for i in range(2):
            phase = i * math.pi
            pts = []
            for deg in range(0, 900, 10):
                theta = math.radians(deg) + phase
                r = 4 + 0.13 * deg
                pts.append((cx + r * math.cos(theta), cy + r * math.sin(theta)))
            draw.line(pts, fill=pal["secondary"], width=8, joint="round")
            draw.line(pts, fill=pal["light"], width=3, joint="round")
        # Debris leaves caught in storm
        for i in range(6):
            angle = i * (math.pi / 3) + 0.2
            lx = cx + 80 * math.cos(angle)
            ly = cy + 80 * math.sin(angle)
            draw_leaf(draw, lx, ly, length=25, width=10, angle=angle+1.5, color=(46, 125, 50))
            
    elif name == "Storm_Front":
        # Heavy dark storm cloud base
        clouds = [(180, 140, 45), (230, 120, 55), (282, 120, 55), (332, 140, 45)]
        for sx, sy, sr in clouds:
            draw.ellipse((sx-sr, sy-sr, sx+sr, sy+sr), fill=pal["dark"])
        for sx, sy, sr in clouds:
            draw.ellipse((sx-sr+6, sy-sr+6, sx+sr-6, sy+sr-6), fill=pal["primary"])
        # Three sharp jagged lightning bolts striking down
        offsets_x = [180, 256, 332]
        for lx in offsets_x:
            bolt = [(lx, 150), (lx-35, 230), (lx, 230), (lx-25, 320), (lx-25, 330), (lx+10, 220), (lx-20, 220), (lx+15, 150)]
            draw.polygon(bolt, fill=pal["light"])
            
    elif name == "Gust":
        # Wavy wind ribbons
        for offset_y in [-50, 0, 50]:
            pts = []
            for x in range(100, 413, 8):
                y = cy + offset_y + 20 * math.sin(0.025 * x + offset_y)
                pts.append((x, y))
            draw.line(pts, fill=pal["primary"], width=10, joint="round")
            draw.line(pts, fill=pal["light"], width=4, joint="round")
        # Wind swirl loops at ends
        draw.arc((360, cy-80, 410, cy-30), start=0, end=270, fill=pal["secondary"], width=4)
        draw.arc((90, cy+30, 140, cy+80), start=180, end=90, fill=pal["secondary"], width=4)
        
    elif name == "Flood":
        # Three layers of deep blue waves
        wave_layers = [
            {"cy": cy + 40, "color": pal["dark"], "amp": 20},
            {"cy": cy + 70, "color": pal["primary"], "amp": 16},
            {"cy": cy + 100, "color": pal["secondary"], "amp": 12}
        ]
        # Background water filler
        draw.rectangle([(100, cy + 30), (412, 412)], fill=pal["dark"])
        for layer in wave_layers:
            pts = [(100, 412)]
            for x in range(100, 413, 6):
                y = layer["cy"] + layer["amp"] * math.sin(0.03 * x)
                pts.append((x, y))
            pts.append((412, 412))
            draw.polygon(pts, fill=layer["color"])
            # Wave whitecaps
            for x in range(120, 412, 60):
                wx = x + random.randint(-10, 10)
                wy = layer["cy"] + layer["amp"] * math.sin(0.03 * wx) - 2
                draw.ellipse((wx-10, wy-3, wx+10, wy+3), fill=pal["light"])
                
    elif name == "Torrent":
        # Central waterfall body
        draw.rectangle([(220, 100), (292, 320)], fill=pal["dark"])
        # Water streams
        for ox in range(225, 290, 8):
            draw.line([(ox, 100), (ox, 300)], fill=pal["primary"], width=4)
            draw.line([(ox+2, 100), (ox+2, 280)], fill=pal["light"], width=2)
        # Splash splits
        pts_left = get_wobbly_points_arc(178, 300, 78, 80, math.radians(270), math.radians(360))
        pts_right = get_wobbly_points_arc(334, 300, 78, 80, math.radians(180), math.radians(270))
        draw_textured_path(draw, pts_left, pal["secondary"], base_width=10)
        draw_textured_path(draw, pts_right, pal["secondary"], base_width=10)
        # White foam at top and bottom
        draw_radial_gradient(draw, cx, 105, radius=30, inner_color=(255, 255, 255), outer_color=pal["primary"])
        # Splashes
        for _ in range(25):
            sx = random.randint(120, 392)
            sy = random.randint(280, 370)
            draw.ellipse((sx-5, sy-5, sx+5, sy+5), fill=pal["light"])
            
    elif name == "Splash":
        # Water pool ripple
        draw.ellipse((cx-110, cy+60, cx+110, cy+100), outline=pal["primary"], width=6)
        # Leaping water jets
        angles = [-120, -90, -60, -150, -30]
        for angle_deg in angles:
            angle = math.radians(angle_deg)
            x_end = cx + 110 * math.cos(angle)
            y_end = cy + 110 * math.sin(angle)
            draw.line([(cx, cy+70), (x_end, y_end)], fill=pal["secondary"], width=8, joint="round")
            draw.line([(cx, cy+70), (x_end, y_end)], fill=pal["light"], width=3, joint="round")
            # Droplet peaks
            draw.ellipse((x_end-10, y_end-10, x_end+10, y_end+10), fill=pal["light"])
        # Splash bubbles
        for _ in range(12):
            bx = random.randint(180, 332)
            by = random.randint(160, 300)
            draw.ellipse((bx-6, by-6, bx+6, by+6), outline=pal["light"], width=2)
            
    elif name == "Harvest":
        # Scythe wooden pole
        draw.line([(100, 400), (330, 130)], fill=(100, 60, 20), width=10) # brown handle
        draw.ellipse((330-8, 130-8, 330+8, 130+8), fill=pal["primary"]) # gold cap
        # Curved metal scythe blade
        blade_pts = []
        for deg in range(160, 290, 5):
            theta = math.radians(deg)
            r1 = 120
            r2 = 140
            x1 = 200 + r1 * math.cos(theta)
            y1 = 250 + r1 * math.sin(theta)
            blade_pts.append((x1, y1))
        # Draw blade body
        draw.polygon(blade_pts + [(300, 130)], fill=pal["light"])
        # Blade sharp edge highlight
        draw.line(blade_pts, fill=(255, 255, 255), width=3)
        # Bundle of wheat
        for i in range(3):
            angle = math.radians(-30 + i * 30)
            draw_leaf(draw, cx-60, cy+65, length=60, width=15, angle=angle, color=pal["secondary"])
            
    elif name == "Gather":
        # Central glowing orange/bronze orb
        draw_radial_gradient(draw, cx, cy, radius=45, inner_color=(255, 230, 150), outer_color=pal["primary"])
        # Multiple gold energy rings
        draw.ellipse((cx-60, cy-60, cx+60, cy+60), outline=pal["secondary"], width=4)
        draw.ellipse((cx-85, cy-85, cx+85, cy+85), outline=pal["primary"], width=2)
        # Converging chevrons pointing to center
        offsets = [-120, 120]
        for offset in offsets:
            chev1 = [(cx+offset, cy-40), (cx+offset//2, cy), (cx+offset, cy+40)]
            chev2 = [(cx+offset+offset//5, cy-50), (cx+offset//2+offset//5, cy), (cx+offset+offset//5, cy+50)]
            draw.line(chev1, fill=pal["secondary"], width=6, joint="round")
            draw.line(chev2, fill=pal["primary"], width=4, joint="round")
            
    elif name == "Seal_of_Autumn":
        # Stylized 5-pointed maple leaf
        leaf_pts = [(cx, cy-110), (cx-45, cy-45), (cx-100, cy-65), (cx-70, cy), (cx-110, cy+35),
                    (cx-35, cy+35), (cx, cy+95), (cx+35, cy+35), (cx+110, cy+35), (cx+70, cy),
                    (cx+100, cy-65), (cx+45, cy-45)]
        draw.polygon(leaf_pts, fill=pal["primary"])
        # Inner warm gradient leaf
        inner_leaf = [(cx, cy-90), (cx-35, cy-35), (cx-80, cy-50), (cx-55, cy), (cx-90, cy+25),
                      (cx-25, cy+25), (cx, cy+75), (cx+25, cy+25), (cx+90, cy+25), (cx+55, cy),
                      (cx+80, cy-50), (cx+35, cy-35)]
        draw.polygon(inner_leaf, fill=pal["secondary"])
        # Leaf veins
        draw.line([(cx, cy-90), (cx, cy+75)], fill=pal["light"], width=3)
        draw.line([(cx, cy), (cx-70, cy-35)], fill=pal["light"], width=2)
        draw.line([(cx, cy), (cx+70, cy-35)], fill=pal["light"], width=2)
        draw.line([(cx, cy+30), (cx-60, cy+25)], fill=pal["light"], width=2)
        draw.line([(cx, cy+30), (cx+60, cy+25)], fill=pal["light"], width=2)
        # Woody stem
        draw.line([(cx, cy+75), (cx, cy+130)], fill=pal["dark"], width=5)
        
    elif name == "Corrupt":
        # A captured stone overtaken by spreading corruption, its tendrils
        # ensnaring and converting the enemy stones around it.
        # Central converted stone
        draw.ellipse((cx-55, cy-55, cx+55, cy+55), fill=pal["primary"], outline=pal["dark"], width=5)
        draw.ellipse((cx-30, cy-30, cx+30, cy+30), fill=pal["secondary"])
        # Corrupting tendrils radiating outward to nearby stones
        for i in range(6):
            ang = math.radians(i * 60)
            ex = cx + int(150 * math.cos(ang))
            ey = cy + int(150 * math.sin(ang))
            mx = cx + int(85 * math.cos(ang + 0.45))
            my = cy + int(85 * math.sin(ang + 0.45))
            draw.line([(cx, cy), (mx, my), (ex, ey)], fill=pal["dark"], width=5, joint="round")
            # A smaller stone being converted at each tendril tip
            draw.ellipse((ex-18, ey-18, ex+18, ey+18), fill=pal["secondary"], outline=pal["dark"], width=3)
        # Corruption motes
        for _ in range(10):
            px = random.randint(cx-120, cx+120)
            py = random.randint(cy-120, cy+120)
            draw.ellipse((px-3, py-3, px+3, py+3), fill=pal["light"])

    elif name == "Decay":
        # Thick cracked stone ring
        draw.ellipse((cx-110, cy-110, cx+110, cy+110), outline=pal["primary"], width=24)
        # Remove a chunk to represent decay
        draw.pieslice((cx-120, cy-120, cx+120, cy+120), start=-45, end=15, fill=(255, 255, 255))
        # Stone crack details
        draw.line([(cx-100, cy), (cx-80, cy-20), (cx-95, cy-40)], fill=pal["dark"], width=3)
        draw.line([(cx, cy+100), (cx+20, cy+80), (cx+10, cy+95)], fill=pal["dark"], width=3)
        # Purple decay fumes leaking
        for _ in range(12):
            fx = cx + 80 * math.cos(math.radians(-15 + random.randint(-20, 20)))
            fy = cy + 80 * math.sin(math.radians(-15 + random.randint(-20, 20)))
            fr = random.randint(10, 25)
            draw.ellipse((fx-fr, fy-fr, fx+fr, fy+fr), fill=(156, 39, 176, 80)) # semi-trans purple
            
    elif name == "Lurk":
        # Crescent shadow
        draw.ellipse((cx-120, cy-120, cx+120, cy+120), fill=pal["dark"])
        draw.ellipse((cx-80, cy-120, cx+140, cy+120), fill=(255, 255, 255)) # mask out crescent
        # Glowing eye inside shadow
        eye_cx, eye_cy = cx-40, cy
        draw.ellipse((eye_cx-60, eye_cy-35, eye_cx+60, eye_cy+35), fill=(245, 240, 245)) # white
        # Iris & Pupil
        draw.ellipse((eye_cx-25, eye_cy-25, eye_cx+25, eye_cy+25), fill=pal["primary"])
        draw.ellipse((eye_cx-12, eye_cy-12, eye_cx+12, eye_cy+12), fill=(10, 5, 15)) # pupil
        # Catchlight
        draw.ellipse((eye_cx-6, eye_cy-8, eye_cx, eye_cy-2), fill=(255, 255, 255))
        
    elif name == "Seal_of_Destruction":
        # Heavy red inverted triangle
        tri = [(cx, 380), (120, 140), (392, 140)]
        draw.polygon(tri, fill=pal["dark"])
        # Glowing inner border
        draw.polygon([(cx, 350), (145, 160), (367, 160)], outline=pal["primary"], width=6)
        # Destructive glowing X-slash
        draw.line([(90, 110), (422, 410)], fill=pal["secondary"], width=12)
        draw.line([(90, 110), (422, 410)], fill=pal["light"], width=5)
        draw.line([(422, 110), (90, 410)], fill=pal["secondary"], width=12)
        draw.line([(422, 110), (90, 410)], fill=pal["light"], width=5)
        
    elif name == "Seal_of_Stone":
        # Ground base
        draw.rectangle([(80, 370), (432, 410)], fill=pal["dark"])
        # Beveled stone obelisk
        obelisk = [(190, 120), (322, 120), (332, 370), (180, 370)]
        draw.polygon(obelisk, fill=pal["primary"])
        # Light side (left)
        draw.polygon([(190, 120), (256, 120), (256, 370), (180, 370)], fill=pal["light"])
        # Shadow side (right)
        draw.polygon([(256, 120), (322, 120), (332, 370), (256, 370)], fill=pal["primary"])
        # Glowing gold runes on obelisk
        draw.line([(220, 200), (292, 200)], fill=(255, 220, 80), width=4)
        draw.line([(220, 280), (292, 280)], fill=(255, 220, 80), width=4)
        draw.line([(256, 160), (256, 320)], fill=(255, 220, 80), width=4)
        
    elif name == "Seal_of_Winter":
        # 3D Snowflake Star
        draw_star(draw, cx, cy, r_outer=130, r_inner=40, points=6, color_light=pal["light"], color_shadow=pal["primary"])
        # Snowflake branch twigs
        for i in range(6):
            angle = i * (math.pi / 3)
            bx = cx + 85 * math.cos(angle)
            by = cy + 85 * math.sin(angle)
            # Twig lines
            t1_end = (bx + 35 * math.cos(angle + math.pi/4), by + 35 * math.sin(angle + math.pi/4))
            t2_end = (bx + 35 * math.cos(angle - math.pi/4), by + 35 * math.sin(angle - math.pi/4))
            draw.line([(bx, by), t1_end], fill=pal["light"], width=4)
            draw.line([(bx, by), t2_end], fill=pal["light"], width=4)
        # Center gemstone
        draw_radial_gradient(draw, cx, cy, radius=18, inner_color=(255, 255, 255), outer_color=pal["secondary"])
        
    elif name == "Fissure":
        # Ground slabs (left & right)
        draw.rectangle([(100, 100), (412, 412)], fill=pal["dark"])
        # Chasm cut
        chasm_poly = [(256, 60), (220, 160), (280, 240), (200, 330), (256, 432),
                      (276, 432), (220, 330), (300, 240), (240, 160), (276, 60)]
        draw.polygon(chasm_poly, fill=(20, 15, 15)) # dark bottom chasm
        # Lava glow at bottom
        draw.line([(238, 110), (250, 410)], fill=pal["primary"], width=4)
        # Surface cracks
        draw.line([(220, 160), (140, 140), (110, 180)], fill=pal["primary"], width=3)
        draw.line([(300, 240), (380, 260), (400, 220)], fill=pal["primary"], width=3)
        
    elif name == "Rock_Slide":
        # Dust background
        for _ in range(6):
            dx = random.randint(180, 332)
            dy = random.randint(180, 332)
            dr = random.randint(30, 60)
            draw.ellipse((dx-dr, dy-dr, dx+dr, dy+dr), fill=(160, 150, 140, 100))
        # 3 detailed rocks sliding down
        draw_rock(draw, cx-80, cy-70, radius=55, color_base=pal["primary"], color_light=pal["light"], color_shadow=pal["dark"])
        draw_rock(draw, cx+10, cy+10, radius=65, color_base=pal["primary"], color_light=pal["light"], color_shadow=pal["dark"])
        draw_rock(draw, cx+85, cy+85, radius=45, color_base=pal["secondary"], color_light=pal["light"], color_shadow=pal["dark"])
        
    elif name == "Bulwark":
        # Detailed shield
        shield = [(150, 130), (362, 130), (382, 240), (256, 390), (130, 240)]
        draw.polygon(shield, fill=pal["dark"])
        # Metal frame
        draw.polygon(shield, outline=pal["light"], width=8)
        # Inner shield quarters
        draw.polygon([(154, 134), (256, 134), (256, 250), (134, 238)], fill=pal["primary"]) # top-left
        draw.polygon([(256, 134), (358, 134), (378, 238), (256, 250)], fill=pal["secondary"]) # top-right
        draw.polygon([(134, 242), (256, 250), (256, 382), (134, 242)], fill=pal["secondary"]) # bottom-left
        draw.polygon([(256, 250), (378, 242), (256, 382)], fill=pal["primary"]) # bottom-right
        # Central crest star
        draw_star(draw, cx, cy-10, r_outer=35, r_inner=12, points=4, color_light=(255, 235, 150), color_shadow=(200, 160, 50))

def apply_feathered_circular_mask(im, radius, feather_radius=3):
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

def process_expansion_runes():
    print("Generating detailed, artistic expansion runes to match base game digital art (faceted rocks, beveled stars, wave meshes)...")
    
    if not os.path.exists(parchment_path):
        print(f"Error: Parchment template {parchment_path} not found!")
        return
        
    parchment_base = Image.open(parchment_path).convert("RGBA")
    if parchment_base.width < 300 or parchment_base.height < 300:
        parchment_base = parchment_base.resize((500, 500), Image.Resampling.LANCZOS)
    
    for name, config in SPELL_CONFIGS.items():
        card_size = config["card_size"]
        overlay_radius = config["overlay_radius"]
        overlay_dim = 2 * overlay_radius
        
        card_path = os.path.join(spells_dir, f"{name}.png")
        if not os.path.exists(card_path):
            print(f"Error: Card {card_path} not found!")
            continue
            
        card_im = Image.open(card_path).convert("RGBA")
        
        # 1. Prepare parchment
        px = (parchment_base.width - overlay_dim) // 2
        py = (parchment_base.height - overlay_dim) // 2
        parchment_crop = parchment_base.crop((px, py, px + overlay_dim, py + overlay_dim)).convert("RGBA")
        
        # 2. Tint parchment for Sorceries/Rituals; off-white for Charms
        if name in CHARMS:
            tint_color = (253, 252, 249, 255)
        else:
            pack_key = PACK_MAPPING[name]
            tint_color = TINT_COLORS[pack_key]
            
        tint_im = Image.new("RGBA", (overlay_dim, overlay_dim), tint_color)
        tinted_parchment = ImageChops.multiply(parchment_crop, tint_im)
        
        # Enhance brightness of textured background for contrast
        enhancer = ImageEnhance.Brightness(tinted_parchment)
        tinted_parchment = enhancer.enhance(1.18)
        
        # 3. Draw detailed, artistic vector illustration on a white canvas
        rune_canvas = Image.new("RGB", (512, 512), (255, 255, 255))
        draw = ImageDraw.Draw(rune_canvas)
        
        pack_key = PACK_MAPPING[name]
        pal = PALETTES[pack_key]
        
        # Render the rich 3D / shaded representation
        render_artistic_rune(name, draw, pal)
        
        # Apply minor Gaussian blur to smooth render aliasing
        rune_canvas = rune_canvas.filter(ImageFilter.GaussianBlur(0.8))
        
        # Resize to overlay circle dimension
        resized_rune = rune_canvas.resize((overlay_dim, overlay_dim), Image.Resampling.LANCZOS)
        
        # 4. Blend via Multiply mode to blend paper grain with illustrations
        final_circle = ImageChops.multiply(tinted_parchment.convert("RGB"), resized_rune)
        final_circle_rgba = final_circle.convert("RGBA")
        
        # Apply circular feathered mask
        masked_circle = apply_feathered_circular_mask(final_circle_rgba, overlay_radius, feather_radius=2)
        
        # 5. Paste onto card template
        cx, cy = card_size // 2, card_size // 2
        paste_pos = (cx - overlay_radius, cy - overlay_radius)
        card_im.paste(masked_circle, paste_pos, mask=masked_circle)
        
        # Save to docs spells/
        dest_png_docs = os.path.join(spells_dir, f"{name}.png")
        dest_webp_docs = os.path.join(spells_dir, f"{name}.webp")
        card_im.save(dest_png_docs, "PNG")
        card_im.save(dest_webp_docs, "WEBP")
        
        # Save to static spells/
        dest_png_static = os.path.join(static_spells_dir, f"{name}.png")
        dest_webp_static = os.path.join(static_spells_dir, f"{name}.webp")
        os.makedirs(os.path.dirname(dest_png_static), exist_ok=True)
        card_im.save(dest_png_static, "PNG")
        card_im.save(dest_webp_static, "WEBP")
        
        print(f"  Processed card {name} with detailed, shaded artwork.")

if __name__ == "__main__":
    process_expansion_runes()
