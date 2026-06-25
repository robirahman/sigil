import os
import math
import random
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageChops

# Setup directories
spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells"
static_spells_dir = "/mnt/chromeos/MyFiles/Documents/sigil/static/images/spells"
parchment_path = "/mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/themes/tiled-background-parchment.jpg"

RITUALS = ["Blossom", "Syzygy", "Erupt", "Hurricane", "Flood", "Harvest", "Wither", "Seal_of_Destruction", "Fissure"]
SORCERIES = ["Scatter", "Eclipse", "Fury", "Storm_Front", "Torrent", "Gather", "Decay", "Seal_of_Stone", "Rock_Slide"]
CHARMS = ["Seal_of_Spring", "Azimuth", "Charge", "Gust", "Splash", "Seal_of_Autumn", "Lurk", "Seal_of_Winter", "Bulwark"]

SPELL_CONFIGS = {}
for name in RITUALS:
    SPELL_CONFIGS[name] = {"card_size": 322, "overlay_radius": 86}
for name in SORCERIES:
    SPELL_CONFIGS[name] = {"card_size": 260, "overlay_radius": 56}
for name in CHARMS:
    SPELL_CONFIGS[name] = {"card_size": 148, "overlay_radius": 23}

# Warm pastel tinted background colors for Sorceries and Rituals
TINT_COLORS = {
    "springtime": (212, 238, 212, 255),    # Warm light green
    "celestial": (215, 222, 242, 255),     # Warm light blue-grey
    "fury": (245, 218, 208, 255),          # Warm light orange-red
    "tempest": (210, 238, 238, 255),       # Warm light cyan-teal
    "tsunami": (210, 228, 245, 255),       # Warm light sky blue
    "autumn": (242, 226, 208, 255),        # Warm light amber-brown
    "gloom": (232, 218, 242, 255),         # Warm light lavender-purple
    "covenant": (245, 238, 212, 255),      # Warm light gold-yellow
    "tectonic": (228, 222, 212, 255),      # Warm light slate-brown
}

# Rich dark ink colors for the rune strokes
INK_COLORS = {
    "springtime": (32, 72, 42),            # Dark forest green
    "celestial": (28, 38, 85),             # Dark navy
    "fury": (102, 32, 26),                 # Dark blood red
    "tempest": (26, 78, 88),               # Dark deep teal
    "tsunami": (22, 48, 92),               # Dark marine blue
    "autumn": (88, 52, 26),                # Dark warm brown
    "gloom": (56, 28, 72),                 # Dark plum purple
    "covenant": (92, 72, 32),              # Dark golden bronze
    "tectonic": (72, 58, 48),              # Dark earthy slate brown
}

PACK_MAPPING = {
    "Blossom": "springtime", "Scatter": "springtime", "Seal_of_Spring": "springtime",
    "Syzygy": "celestial", "Eclipse": "celestial", "Azimuth": "celestial",
    "Erupt": "fury", "Fury": "fury", "Charge": "fury",
    "Hurricane": "tempest", "Storm_Front": "tempest", "Gust": "tempest",
    "Flood": "tsunami", "Torrent": "tsunami", "Splash": "tsunami",
    "Harvest": "autumn", "Gather": "autumn", "Seal_of_Autumn": "autumn",
    "Wither": "gloom", "Decay": "gloom", "Lurk": "gloom",
    "Seal_of_Destruction": "covenant", "Seal_of_Stone": "covenant", "Seal_of_Winter": "covenant",
    "Fissure": "tectonic", "Rock_Slide": "tectonic", "Bulwark": "tectonic"
}

# --- Drawing Utilities with Jitter & Texture (Hand-painted emulation) ---

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
    
    r, g, b = color
    current_width = base_width
    for p in interpolated:
        current_width += (random.random() - 0.5) * 0.4
        current_width = max(base_width * 0.7, min(base_width * 1.3, current_width))
        
        op_factor = 0.82 + 0.18 * random.random()
        # Multiply blending simulation: draw color blended with white (255, 255, 255)
        cr = int(r * op_factor + 255 * (1.0 - op_factor))
        cg = int(g * op_factor + 255 * (1.0 - op_factor))
        cb = int(b * op_factor + 255 * (1.0 - op_factor))
        
        w_half = current_width / 2
        draw.ellipse((p[0] - w_half, p[1] - w_half, p[0] + w_half, p[1] + w_half), fill=(cr, cg, cb))

# --- Custom geometries ---

def draw_wobbly_rune(name, draw, color, base_w):
    cx, cy = 256, 256
    
    if name == "Blossom":
        pts = get_wobbly_points_ellipse(cx, cy, 35, 35)
        draw_textured_path(draw, pts, color, base_w)
        for i in range(8):
            angle = i * (math.pi / 4)
            lx = cx + 95 * math.cos(angle)
            ly = cy + 95 * math.sin(angle)
            pts_l = get_wobbly_points_ellipse(lx, ly, 35, 35)
            draw_textured_path(draw, pts_l, color, base_w - 4)
            
    elif name == "Scatter":
        draw_textured_path(draw, get_wobbly_points_line((cx, 380), (cx, 280)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 280), (140, 160)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 280), (372, 160)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 280), (cx, 140)), color, base_w)
        for dx, dy in [(120, 140), (200, 110), (312, 110), (392, 140)]:
            pts = get_wobbly_points_ellipse(dx, dy, 12, 12)
            draw_textured_path(draw, pts, color, base_w - 2)
            
    elif name == "Seal_of_Spring":
        pts_leaf = get_wobbly_points_arc(256, 350, 156, 50, math.radians(30), math.radians(150))
        draw_textured_path(draw, pts_leaf, color, base_w)
        spiral_points = []
        for theta_deg in range(0, 1080, 5):
            theta = theta_deg * (math.pi / 180)
            r = 180 - 0.15 * theta_deg
            if r < 10:
                break
            px = cx + r * math.cos(theta)
            py = cy + r * math.sin(theta)
            spiral_points.append((px, py))
        jittered_spiral = [(p[0] + (random.random()-0.5)*3.0, p[1] + (random.random()-0.5)*3.0) for p in spiral_points]
        draw_textured_path(draw, jittered_spiral, color, base_w - 4)
        
    elif name == "Syzygy":
        draw_textured_path(draw, get_wobbly_points_line((80, cy), (432, cy)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx-120, cy, 30, 30), color, base_w)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx, cy, 30, 30), color, base_w)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx+120, cy, 30, 30), color, base_w)
        
    elif name == "Eclipse":
        draw_textured_path(draw, get_wobbly_points_ellipse(cx, cy, 110, 110), color, base_w + 4)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx+40, cy+40, 90, 90), color, base_w - 2)
        
    elif name == "Azimuth":
        draw_textured_path(draw, get_wobbly_points_line((cx, 80), (cx, 432)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((80, cy), (432, cy)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((140, 140), (372, 372)), color, base_w - 6)
        draw_textured_path(draw, get_wobbly_points_line((372, 140), (140, 372)), color, base_w - 6)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx, cy, 45, 45), color, base_w)
        
    elif name == "Erupt":
        tri_pts = get_wobbly_points_line((cx, 200), (120, 380)) + \
                  get_wobbly_points_line((120, 380), (392, 380)) + \
                  get_wobbly_points_line((392, 380), (cx, 200))
        draw_textured_path(draw, tri_pts, color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 200), (cx-60, 90)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 200), (cx, 70)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 200), (cx+60, 90)), color, base_w)
        
    elif name == "Fury":
        for offset in [-100, 0, 100]:
            claw_pts = get_wobbly_points_line((cx+offset-20, 100), (cx+offset+20, 220)) + \
                       get_wobbly_points_line((cx+offset+20, 220), (cx+offset-30, 320)) + \
                       get_wobbly_points_line((cx+offset-30, 320), (cx+offset+10, 412))
            draw_textured_path(draw, claw_pts, color, base_w)
            
    elif name == "Charge":
        draw_textured_path(draw, get_wobbly_points_line((120, 392), (360, 152)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((360, 152), (280, 152)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((360, 152), (360, 232)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((80, 392), (120, 432)), color, base_w - 6)
        draw_textured_path(draw, get_wobbly_points_line((120, 352), (160, 392)), color, base_w - 6)
        
    elif name == "Hurricane":
        for start_angle in [0, math.pi]:
            points = []
            for deg in range(0, 720, 5):
                theta = deg * (math.pi / 180) + start_angle
                r = 0.3 * deg
                px = cx + r * math.cos(theta)
                py = cy + r * math.sin(theta)
                points.append((px, py))
            jittered_pts = [(p[0] + (random.random()-0.5)*3.0, p[1] + (random.random()-0.5)*3.0) for p in points]
            draw_textured_path(draw, jittered_pts, color, base_w - 4)
            
    elif name == "Storm_Front":
        draw_textured_path(draw, get_wobbly_points_line((80, 160), (432, 160)), color, base_w)
        for lx in [150, 256, 362]:
            lightning_pts = get_wobbly_points_line((lx, 160), (lx-30, 240)) + \
                            get_wobbly_points_line((lx-30, 240), (lx+10, 240)) + \
                            get_wobbly_points_line((lx+10, 240), (lx-20, 340))
            draw_textured_path(draw, lightning_pts, color, base_w - 4)
            
    elif name == "Gust":
        for offset in [-40, 40]:
            points = []
            for x in range(100, 413, 5):
                y = cy + offset + 20 * math.sin(0.03 * x)
                points.append((x, y))
            jittered_pts = [(p[0] + (random.random()-0.5)*3.0, p[1] + (random.random()-0.5)*3.0) for p in points]
            draw_textured_path(draw, jittered_pts, color, base_w)
            
    elif name == "Flood":
        for offset in [-80, 0, 80]:
            points = []
            for x in range(100, 413, 5):
                y = cy + offset + 15 * math.sin(0.04 * x)
                points.append((x, y))
            jittered_pts = [(p[0] + (random.random()-0.5)*3.0, p[1] + (random.random()-0.5)*3.0) for p in points]
            draw_textured_path(draw, jittered_pts, color, base_w - 2)
            
    elif name == "Torrent":
        draw_textured_path(draw, get_wobbly_points_line((cx, 100), (cx, 220)), color, base_w)
        pts_l = get_wobbly_points_arc(178, 320, 78, 100, math.radians(270), math.radians(360))
        draw_textured_path(draw, pts_l, color, base_w)
        pts_r = get_wobbly_points_arc(334, 320, 78, 100, math.radians(180), math.radians(270))
        draw_textured_path(draw, pts_r, color, base_w)
        
    elif name == "Splash":
        pts_base = get_wobbly_points_arc(256, 350, 136, 30, math.radians(0), math.radians(180))
        draw_textured_path(draw, pts_base, color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 350), (140, 180)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 350), (cx, 140)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 350), (372, 180)), color, base_w)
        for dx, dy in [(140, 180), (cx, 140), (372, 180)]:
            pts = get_wobbly_points_ellipse(dx, dy, 12, 12)
            draw_textured_path(draw, pts, color, base_w - 2)
            
    elif name == "Harvest":
        draw_textured_path(draw, get_wobbly_points_line((120, 392), (340, 140)), color, base_w)
        pts_blade = get_wobbly_points_arc(230, 210, 110, 110, math.radians(180), math.radians(300))
        draw_textured_path(draw, pts_blade, color, base_w + 4)
        
    elif name == "Gather":
        pts_c = get_wobbly_points_ellipse(cx, cy, 20, 20)
        draw_textured_path(draw, pts_c, color, base_w)
        for offset in [-120, 120]:
            chev_pts = get_wobbly_points_line((cx+offset, cy-60), (cx+offset//2, cy)) + \
                       get_wobbly_points_line((cx+offset//2, cy), (cx+offset, cy+60))
            draw_textured_path(draw, chev_pts, color, base_w)
            
    elif name == "Seal_of_Autumn":
        draw_textured_path(draw, get_wobbly_points_line((140, 372), (372, 140)), color, base_w)
        draw_textured_path(draw, get_wobbly_points_ellipse(cx, cy, 60, 60), color, base_w - 4)
        draw_textured_path(draw, get_wobbly_points_line((cx-60, cy+60), (cx-90, cy+30)), color, base_w - 4)
        draw_textured_path(draw, get_wobbly_points_line((cx+60, cy-60), (cx+90, cy-30)), color, base_w - 4)
        
    elif name == "Wither":
        branch_pts_1 = get_wobbly_points_line((120, 380), (220, 200)) + get_wobbly_points_line((220, 200), (372, 230))
        branch_pts_2 = get_wobbly_points_line((220, 200), (280, 140)) + get_wobbly_points_line((280, 140), (350, 160))
        draw_textured_path(draw, branch_pts_1, color, base_w)
        draw_textured_path(draw, branch_pts_2, color, base_w - 4)
        
    elif name == "Decay":
        pts_ring = get_wobbly_points_arc(cx, cy, 110, 110, math.radians(20), math.radians(340))
        draw_textured_path(draw, pts_ring, color, base_w + 2)
        crack_pts = get_wobbly_points_line((340, 210), (380, 250)) + get_wobbly_points_line((380, 250), (330, 290))
        draw_textured_path(draw, crack_pts, color, base_w - 6)
        
    elif name == "Lurk":
        pts_cres = get_wobbly_points_arc(cx, cy, 120, 120, math.radians(90), math.radians(270))
        draw_textured_path(draw, pts_cres, color, base_w)
        pts_eye_top = get_wobbly_points_arc(cx+60, cy, 80, 60, math.radians(150), math.radians(210))
        pts_eye_bot = get_wobbly_points_arc(cx+60, cy, 80, 60, math.radians(330), math.radians(390))
        draw_textured_path(draw, pts_eye_top, color, base_w - 6)
        draw_textured_path(draw, pts_eye_bot, color, base_w - 6)
        pts_pupil = get_wobbly_points_ellipse(cx+60, cy, 12, 12)
        draw_textured_path(draw, pts_pupil, color, base_w)
        
    elif name == "Seal_of_Destruction":
        tri_pts = get_wobbly_points_line((cx, 360), (130, 140)) + \
                  get_wobbly_points_line((130, 140), (382, 140)) + \
                  get_wobbly_points_line((382, 140), (cx, 360))
        draw_textured_path(draw, tri_pts, color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((100, 100), (412, 412)), color, base_w + 4)
        draw_textured_path(draw, get_wobbly_points_line((412, 100), (100, 412)), color, base_w + 4)
        
    elif name == "Seal_of_Stone":
        draw_textured_path(draw, get_wobbly_points_line((80, 380), (432, 380)), color, base_w)
        pillar_pts = get_wobbly_points_line((190, 120), (322, 120)) + \
                     get_wobbly_points_line((322, 120), (322, 380)) + \
                     get_wobbly_points_line((322, 380), (190, 380)) + \
                     get_wobbly_points_line((190, 380), (190, 120))
        draw_textured_path(draw, pillar_pts, color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((220, 200), (292, 200)), color, base_w - 4)
        draw_textured_path(draw, get_wobbly_points_line((220, 280), (292, 280)), color, base_w - 4)
        
    elif name == "Seal_of_Winter":
        for i in range(6):
            angle = i * (math.pi / 3)
            ex = cx + 160 * math.cos(angle)
            ey = cy + 160 * math.sin(angle)
            draw_textured_path(draw, get_wobbly_points_line((cx, cy), (ex, ey)), color, base_w)
            bx = cx + 100 * math.cos(angle)
            by = cy + 100 * math.sin(angle)
            t1 = get_wobbly_points_line((bx, by), (bx + 40 * math.cos(angle + math.pi/4), by + 40 * math.sin(angle + math.pi/4)))
            t2 = get_wobbly_points_line((bx, by), (bx + 40 * math.cos(angle - math.pi/4), by + 40 * math.sin(angle - math.pi/4)))
            draw_textured_path(draw, t1, color, base_w - 6)
            draw_textured_path(draw, t2, color, base_w - 6)
            
    elif name == "Fissure":
        crack_pts = get_wobbly_points_line((cx, 60), (cx-40, 150)) + \
                    get_wobbly_points_line((cx-40, 150), (cx+40, 240)) + \
                    get_wobbly_points_line((cx+40, 240), (cx-50, 330)) + \
                    get_wobbly_points_line((cx-50, 330), (cx, 432))
        draw_textured_path(draw, crack_pts, color, base_w + 6)
        branch_pts = get_wobbly_points_line((cx+40, 240), (cx+110, 200)) + get_wobbly_points_line((cx+110, 200), (cx+130, 140))
        draw_textured_path(draw, branch_pts, color, base_w - 4)
        
    elif name == "Rock_Slide":
        for offset_x, offset_y in [(-90, -90), (0, 0), (90, 90)]:
            dcx, dcy = cx + offset_x, cy + offset_y
            diamond_pts = get_wobbly_points_line((dcx, dcy-45), (dcx+45, dcy)) + \
                          get_wobbly_points_line((dcx+45, dcy), (dcx, dcy+45)) + \
                          get_wobbly_points_line((dcx, dcy+45), (dcx-45, dcy)) + \
                          get_wobbly_points_line((dcx-45, dcy), (dcx, dcy-45))
            draw_textured_path(draw, diamond_pts, color, base_w)
            
    elif name == "Bulwark":
        draw_textured_path(draw, get_wobbly_points_line((150, 140), (362, 140)), color, base_w)
        left_pts = get_wobbly_points_line((150, 140), (130, 240)) + get_wobbly_points_line((130, 240), (cx, 380))
        right_pts = get_wobbly_points_line((362, 140), (382, 240)) + get_wobbly_points_line((382, 240), (cx, 380))
        draw_textured_path(draw, left_pts, color, base_w)
        draw_textured_path(draw, right_pts, color, base_w)
        draw_textured_path(draw, get_wobbly_points_line((cx, 140), (cx, 350)), color, base_w - 4)

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
    print("Generating expansion runes to match base game art style (Multiply blend, themed textured parchment, dark wobbly ink)...")
    
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
        
        # 1. Crop parchment
        px = (parchment_base.width - overlay_dim) // 2
        py = (parchment_base.height - overlay_dim) // 2
        parchment_crop = parchment_base.crop((px, py, px + overlay_dim, py + overlay_dim)).convert("RGBA")
        
        # 2. Tint parchment for Sorceries/Rituals; keep white/pale-cream for Charms
        if name in CHARMS:
            tint_color = (252, 251, 248, 255)
        else:
            pack_key = PACK_MAPPING[name]
            tint_color = TINT_COLORS[pack_key]
            
        tint_im = Image.new("RGBA", (overlay_dim, overlay_dim), tint_color)
        tinted_parchment = ImageChops.multiply(parchment_crop, tint_im)
        
        # Brighten back up to ensure good text/symbol contrast
        enhancer = ImageEnhance.Brightness(tinted_parchment)
        tinted_parchment = enhancer.enhance(1.15)
        
        # 3. Draw the wobbly organic rune on a white canvas
        rune_canvas = Image.new("RGB", (512, 512), (255, 255, 255))
        draw = ImageDraw.Draw(rune_canvas)
        
        pack_key = PACK_MAPPING[name]
        ink_color = INK_COLORS[pack_key]
        
        # Draw geometry
        draw_wobbly_rune(name, draw, ink_color, base_w=20)
        
        # Blur the wobbly rune slightly to simulate ink bleed/absorption
        rune_canvas = rune_canvas.filter(ImageFilter.GaussianBlur(1.0))
        
        # Resize the rune canvas to fit overlay dimension
        resized_rune = rune_canvas.resize((overlay_dim, overlay_dim), Image.Resampling.LANCZOS)
        
        # 4. Combine via MULTIPLY so paper texture naturally shows through the ink strokes
        final_circle = ImageChops.multiply(tinted_parchment.convert("RGB"), resized_rune)
        final_circle_rgba = final_circle.convert("RGBA")
        
        # Apply circular feathered mask to the final combined circle
        masked_circle = apply_feathered_circular_mask(final_circle_rgba, overlay_radius, feather_radius=2)
        
        # 5. Paste the final circle centered back onto the card border template
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
        
        print(f"  Successfully processed {name} ({pack_key} pack)")

if __name__ == "__main__":
    process_expansion_runes()
