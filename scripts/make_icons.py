#!/usr/bin/env python3
"""Generate the Parley PWA icon set (PIL only, no network).

The mark is the orb: a warm orange radial blob with a lavender bleed on the
right, sitting on a soft cream rounded square, with two faint orbit rings and
two satellite dots. Writes public/icons/{icon-192,icon-512,apple-touch-icon}.png
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "icons")

CREAM = (247, 240, 228)
ACCENT = (232, 121, 61)
ACCENT_DEEP = (217, 102, 47)
PEACH = (255, 158, 94)
HILIGHT = (255, 227, 190)
LAVENDER = (201, 167, 224)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def mix(c1, c2, t):
    return lerp(c1, c2, t)


def render(size: int, rounded: bool = True) -> Image.Image:
    ss = 4  # supersample
    S = size * ss
    img = Image.new("RGBA", (S, S), CREAM + (255,))

    if rounded:
        # rounded-square mask
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255
        )
        base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        base.paste(img, (0, 0), mask)
        img = base

    # --- orb body: radial gradient, offset towards top-left highlight -------
    cx, cy = S * 0.5, S * 0.5
    r0 = S * 0.325            # orb radius
    orb = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = orb.load()
    hx, hy = cx - r0 * 0.42, cy - r0 * 0.48
    for y in range(int(cy - r0) - 2, int(cy + r0) + 4):
        if y < 0 or y >= S:
            continue
        for x in range(int(cx - r0) - 2, int(cx + r0) + 4):
            if x < 0 or x >= S:
                continue
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)
            if d > r0:
                continue
            # highlight falloff
            dh = math.hypot(x - hx, y - hy)
            t_h = max(0.0, 1.0 - dh / (r0 * 1.25))
            col = mix(PEACH, ACCENT, min(1.0, d / r0 * 1.15))
            col = mix(col, ACCENT_DEEP, max(0.0, (d / r0 - 0.55)) * 1.4)
            # lavender bleed on the right half
            tx = (x - (cx - r0)) / (2 * r0)
            fade = max(0.0, (tx - 0.55)) * 2.1
            col = mix(col, LAVENDER, min(0.55, fade * (0.35 + 0.65 * d / r0)))
            # warm highlight
            col = mix(col, HILIGHT, t_h ** 2 * 0.72)
            a = 255
            edge = r0 - d
            if edge < 2 * ss:
                a = int(255 * max(0.0, edge / (2 * ss)))
            px[x, y] = col + (a,)

    # --- soft halo behind ---------------------------------------------------
    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hr = r0 * 1.30
    hd.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=ACCENT + (46,))
    halo = halo.filter(ImageFilter.GaussianBlur(radius=S * 0.055))
    img.alpha_composite(halo)

    # --- orbit rings + satellites ------------------------------------------
    rings = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for i, rr in enumerate((r0 * 1.14, r0 * 1.33)):
        w = max(1, int(S * 0.006))
        rd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=ACCENT + (74,), width=w)
        ang = math.radians(-52 if i == 0 else 208)
        dx_, dy_ = cx + rr * math.cos(ang), cy + rr * math.sin(ang)
        dot = S * (0.030 if i == 0 else 0.020)
        rd.ellipse([dx_ - dot, dy_ - dot, dx_ + dot, dy_ + dot], fill=ACCENT + (235,))
        if i == 0:
            ang2 = math.radians(148)
            dx2, dy2 = cx + rr * math.cos(ang2), cy + rr * math.sin(ang2)
            rd.ellipse([dx2 - dot * 0.62, dy2 - dot * 0.62, dx2 + dot * 0.62, dy2 + dot * 0.62],
                       fill=(255, 200, 158, 235))
    img.alpha_composite(rings)
    img.alpha_composite(orb)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    # Rounded-square app icons on cream, plus a transparent apple touch icon.
    render(192).convert("RGB").save(os.path.join(OUT, "icon-192.png"))
    render(512).convert("RGB").save(os.path.join(OUT, "icon-512.png"))
    # maskable: same art, more padding (safe zone 80%)
    render(512).convert("RGB").save(os.path.join(OUT, "icon-maskable-512.png"))
    render(180).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    print("icons written to", os.path.realpath(OUT))


if __name__ == "__main__":
    main()
