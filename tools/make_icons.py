#!/usr/bin/env python3
"""Generate the Cessna Live app icons (PNG) with Pillow. Run from the repo root."""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (11, 15, 20, 255)        # #0b0f14
ACCENT = (76, 201, 240, 255)  # #4cc9f0

# Top-down airplane silhouette in a 100 x 100 box (matches the SVG marker in app.js).
FUSELAGE = [(45, 20), (55, 20), (55, 84), (45, 84)]
NOSE_BOX = (45, 8, 55, 32)
WINGS = [(45, 40), (55, 40), (92, 56), (92, 63), (55, 54), (45, 54), (8, 63), (8, 56)]
TAIL = [(46, 78), (54, 78), (69, 89), (69, 93), (54, 87), (46, 87), (31, 93), (31, 89)]


def scale(points, size, inset):
    span = size - 2 * inset
    return [(inset + x / 100 * span, inset + y / 100 * span) for x, y in points]


def make(size, radius_ratio=0.22, inset_ratio=0.18):
    ss = 4  # supersample for smooth edges
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=BG)
    inset = int(big * inset_ratio)
    span = big - 2 * inset
    d.polygon(scale(FUSELAGE, big, inset), fill=ACCENT)
    x0, y0, x1, y1 = NOSE_BOX
    d.ellipse((inset + x0 / 100 * span, inset + y0 / 100 * span,
               inset + x1 / 100 * span, inset + y1 / 100 * span), fill=ACCENT)
    d.polygon(scale(WINGS, big, inset), fill=ACCENT)
    d.polygon(scale(TAIL, big, inset), fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    # Apple wants an opaque square; iOS rounds the corners itself.
    apple = make(180, radius_ratio=0.0)
    apple.save(out / "apple-touch-icon.png", optimize=True)
    make(192).save(out / "icon-192.png", optimize=True)
    make(512).save(out / "icon-512.png", optimize=True)
    print("icons written to", out)


if __name__ == "__main__":
    main()
