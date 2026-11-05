"""Bake Natural Earth 2.0.0 SR_HR.tif into the atlas's equirectangular grid.

Optional asset-authoring tool (Pillow + NumPy). The static build uses the
committed tiles. Source: https://naturalearth.s3.amazonaws.com/10m_raster/SR_HR.zip
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = 240_000_000
out = Path(__file__).resolve().parents[1] / "public" / "relief"
out.mkdir(exist_ok=True)

def pigments(shade):
    # The source uses 206 for an unshaded surface (including open water).
    # Soft steps on slopes suggest cut paper. The flat paper shows through.
    delta = 206 - np.asarray(shade, dtype=np.float32)
    rounded = np.round(delta / 7) * 7
    tone = .76 * delta + .24 * rounded
    depth = np.clip(tone / 125, 0, 1)[..., None]
    amber, pine = np.array([139, 116, 69]), np.array([38, 62, 51])
    shadow = amber * (1 - depth) + pine * depth
    rgb = np.where(tone[..., None] >= 0, shadow, [255, 231, 174])
    alpha = np.where(tone >= 0, np.minimum(204, tone * 2.0), np.minimum(145, -tone * 3.4))
    # White is transparent under multiply; encoding a single opaque plate
    # avoids a lossless alpha plane for millions of relief samples.
    return Image.fromarray(np.rint(255 + (rgb - 255) * (alpha[..., None] / 255)).astype('uint8'))

def landscape_wash(source):
    """Paint broad slope shadows in pine and light-facing slopes in honey."""
    # Downsample sunlight and shade separately so opposing faces of a ridge
    # survive at regional scale. Filter across tile edges before slicing.
    size = (1536, 768)
    plate = source.resize((3072, 1536), Image.Resampling.LANCZOS)
    plate.paste(206, (0, 1280, plate.width, plate.height))
    def exposure(sign):
        mask = plate.point(lambda value: min(255, max(0, (206 - value) * sign * 4)))
        mask = mask.resize(size, Image.Resampling.LANCZOS)
        soft = mask.filter(ImageFilter.GaussianBlur(1.6))
        return np.asarray(Image.blend(mask, soft, .40), dtype=np.float32) / 255

    shadow, light = exposure(1), exposure(-1)
    paper = np.full((*shadow.shape, 3), 255, dtype=np.float32)
    for amount, pigment in [(light * .52, [255, 213, 138]), (shadow * .90, [61, 91, 73])]:
        paper += (np.array(pigment) - paper) * amount[..., None]
    return Image.fromarray(np.rint(paper).astype('uint8'))

def overview():
    """One small, continuous terrain plate for the world view and opening fold."""
    plate = Image.new('RGB', (1536, 768), 'white')
    for y in range(2):
        for x in range(4):
            tile = out / f'4-{x}-{y}.webp'
            if tile.exists():
                with Image.open(tile) as image:
                    plate.paste(image, (x * 384, y * 384))
    plate.resize((1024, 512), Image.Resampling.LANCZOS).save(out / 'overview.webp', quality=72, method=6)

if len(sys.argv) > 1 and sys.argv[1] == '--overview':
    overview()
    sys.exit(0)

with Image.open(sys.argv[1]) as source:
    if source.size != (21600, 10800) or source.mode != 'L':
        raise ValueError('Expected the 1 arc-minute SR_HR grayscale world plate')
    wash = landscape_wash(source)
    levels = []
    for cols, size in [(4, 384), (16, 1024)]:
        rows = cols // 2
        coverage = []
        for y in range(rows):
            mask = 0
            for x in range(cols):
                box = (x * source.width // cols, y * source.height // rows,
                       (x + 1) * source.width // cols, (y + 1) * source.height // rows)
                # The Antarctic inset has a separate, deliberately compressed projection.
                region = source.crop(box)
                cutoff = max(0, min(region.height, 9000 - box[1]))
                if cutoff < region.height:
                    region.paste(206, (0, cutoff, region.width, region.height))
                if cols == 4:
                    relief = wash.crop((x * size, y * size, (x + 1) * size, (y + 1) * size))
                else:
                    relief = pigments(region.resize((size, size), Image.Resampling.LANCZOS))
                if relief.getchannel('G').getextrema()[0] > 252:
                    continue
                relief.save(out / f'{cols}-{x}-{y}.webp', quality=68, method=5)
                mask |= 1 << x
            coverage.append(mask)
        levels.append(coverage)
    (out / 'index.js').write_text('/* Visible land in each row of the baked relief atlas. */\n'
                                  + 'window.REDLINE_RELIEF = ' + json.dumps(levels) + ';\n')

overview()
