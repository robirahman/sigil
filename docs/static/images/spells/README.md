# Sigil Spell Card Rune Art Guide

This document outlines the procedure used to generate and process the spell rune artwork for Sigil's expansion packs. This procedure ensures a consistent, high-quality, hand-painted digital art style matching the base game spells.

---

## Workflow Overview

The artwork pipeline consists of three main steps:
1. **AI Image Generation**: Generating beautiful, detailed, painted rune designs on a parchment background.
2. **Image Processing and Compositing**: Cropping, masking, and overlaying the generated runes onto the card templates.
3. **Verification**: Running automated dimension and existence checks to ensure correctness.

---

## Step 1: AI Image Generation

Runes are generated using the `gemini-3.1-flash-image` generator tool. For consistency, each expansion pack follows a strict color theme and description pattern.

### The Base Generation Prompt

Use the following template prompt for generation:

> "A highly detailed, hand-painted digital illustration of a [Spell Name] rune. The rune is [Description of the rune/sigil], styled as an arcane sigil. Painted in a rich [Palette Style] ink style with soft gradients, shading, and organic textures, set on a warm, aged, textured parchment paper background. Clean, centered composition, circular framing. Matches medieval fantasy tabletop game card art."

### Pack-Specific Configurations

| Pack Name | Ink Palette / Style | Spells & Rune Descriptions |
| :--- | :--- | :--- |
| **Springtime** | rich green | **Blossom**: floral emblem / blooming bud<br>**Scatter**: wind gust carrying swirling petals<br>**Seal of Spring**: spiraling leaf cluster |
| **Celestial** | rich indigo | **Syzygy**: cosmic eclipse showing aligned planets<br>**Eclipse**: dark moon silhouette with bright crown/corona<br>**Azimuth**: beveled navigation compass star |
| **Inferno** | rich magma red | **Erupt**: erupting volcano peak with cascades of lava<br>**Fury**: three parallel fiery slashes or claw marks<br>**Charge**: speeding arrow/spearhead made of red energy |
| **Tempest** | rich teal / sea green | **Hurricane**: giant vortex of wind and clouds<br>**Storm Front**: dark storm clouds with sharp lightning strikes<br>**Gust**: wavy wind ribbons and swirls |
| **Tsunami** | rich sapphire blue | **Flood**: crashing ocean waves with whitecaps<br>**Torrent**: cascading waterfall splitting into splashes<br>**Splash**: liquid crown splash with droplets rising up |
| **Autumn** | rich amber and bronze | **Harvest**: curved scythe blade and wheat bundle<br>**Gather**: converging golden energy chevrons and central orb<br>**Seal of Autumn**: abstract five-lobed maple leaf |
| **Gloom** | rich dark violet and plum | **Corrupt**: a captured stone overtaken by spreading corruption, tendrils ensnaring the stones around it<br>**Decay**: broken stone ring crumbling to dust<br>**Lurk**: glowing eye framed by a crescent moon |
| **Covenant** | rich burnished gold and brown | **Seal of Destruction**: arcane triangle with diagonal X-slash<br>**Seal of Stone**: standing stone obelisk surrounded by orbiting runes<br>**Seal of Winter**: six-pointed snowflake with sharp crystal branches |
| **Tectonic** | rich earthy slate-brown | **Fissure**: jagged tectonic crack splitting the ground<br>**Rock Slide**: cluster of tumbling, jagged stone boulders<br>**Bulwark**: medieval heater shield with protective runes |
| **Providence** | rich royal purple and gold | **Endowment**: overflowing treasure chest radiating four orbiting coins<br>**Annuity**: twin hourglasses joined by a flowing ribbon of coins<br>**Dividend**: a single gold coin splitting in two above an open palm |

### Image Specs:
- **Aspect Ratio**: `1:1`
- **Output File Prefix**: `[lowercase_spell_name]_rune_raw` (e.g. `corrupt_rune_raw`)

---

## Step 2: Image Processing and Compositing

Once raw rune illustrations are generated and saved to the artifacts/scratch folder, they must be processed and overlayed onto their card templates.

The processing script [process_generated_runes.py](file:///mnt/chromeos/MyFiles/Documents/sigil/docs/static/images/spells/process_generated_runes.py) automates this pipeline.

### What the Script Does:
1. **Finds the Latest Raw Image**: Scans the generation directory for the most recently created raw file matching the spell's prefix.
2. **Crops Center Circle**:
   - First crops the image to a central square.
   - Then crops the inner 82% of that square (`crop_factor = 0.82`) to isolate the main rune illustration and exclude the outer frame borders of the generated image.
3. **Resizes**: Resizes the cropped circular area to match the target frame dimensions:
   - **Ritual Overlay**: Radius 86 ($172 \times 172$ pixels)
   - **Sorcery Overlay**: Radius 56 ($112 \times 112$ pixels)
   - **Charm Overlay**: Radius 23 ($46 \times 46$ pixels)
4. **Feathered Masking**: Applies a circular alpha mask with feathered edges (using a Gaussian blur) to blend the rune smoothly into the card template's circular frame.
5. **Compositing**: Pastes the masked circular rune onto the template card image centered at `(size/2 - radius)`.
6. **Double Export**: Saves the final cards as `.png` and `.webp` in both:
   - Live GitHub Pages directory: `docs/static/images/spells/`
   - Dev Flask server directory: `static/images/spells/`

### Running the Processing Script:
```bash
python3 docs/static/images/spells/process_generated_runes.py
```

---

## Step 3: Verification

After processing, run the verification script to check that all file outputs exist, are readable, and match the target card dimensions:

```bash
python3 /home/robirahman94/.gemini/antigravity-cli/brain/66cf6de8-e951-45cd-af1b-e65b833d2af2/scratch/verify_assets.py
```

- **Rituals Card Size**: $322 \times 322$ px
- **Sorceries Card Size**: $260 \times 260$ px
- **Charms Card Size**: $148 \times 148$ px
