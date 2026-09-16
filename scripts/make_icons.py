#!/usr/bin/env python3
"""Generate the Parley PWA icon set (PIL only, no network).

The mark is "the voice": an asymmetric ink-blot form (never a perfect
circle, never orbited by anything) filled with the Afterglow gradient
(gold -> ember -> violet) with a brighter core near the highlight and a
soft ember halo, on the dusk background. Matches the live hero in
public/orb.js. Writes public/icons/{icon-192,icon-512,icon-maskable-512,
apple-touch-icon,favicon.svg}.
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "icons")

BG = (24, 19, 32)          # --bg
GOLD = (240, 184, 96)       # --gold
EMBER = (226, 99, 122)      # --ember
VIOLET = (133, 113, 196)    # --violet
CORE_LIGHT = (255, 239, 217)

# Same uneven lobe multipliers as the live orb's BASE_LOBES, frozen at a
# single flattering phase — the icon is a still frame of the same character.
LOBES = [1.0, 0.7, 1.16, 0.82, 1.05, 0.62, 0.93]
N_LOBES = len(LOBES)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def mix(c1, c2, t):
    return lerp(c1, c2, max(0.0, min(1.0, t)))


def shape_radius(angle: float, r0: float) -> float:
    """Smoothly interpolated radius at a given angle across the uneven lobes."""
    a = angle % (2 * math.pi)
    seg = a / (2 * math.pi) * N_LOBES
    i0 = int(math.floor(seg)) % N_LOBES
    i1 = (i0 + 1) % N_LOBES
    t = seg - math.floor(seg)
    t_smooth = t * t * (3 - 2 * t)  # smoothstep, keeps the outline organic
    lobe = LOBES[i0] * (1 - t_smooth) + LOBES[i1] * t_smooth
    return r0 * lobe


def render(size: int, rounded: bool = True) -> Image.Image:
    ss = 4  # supersample
    S = size * ss
    img = Image.new("RGBA", (S, S), BG + (255,))

    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255
        )
        base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        base.paste(img, (0, 0), mask)
        img = base

    cx, cy = S * 0.5, S * 0.5
    r0 = S * 0.30
    hx, hy = cx - r0 * 0.30, cy - r0 * 0.42  # highlight sits up and to the left

    # --- soft halo behind, fading well inside its own radius --------------
    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hr = r0 * 1.35
    hd.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=EMBER + (40,))
    halo = halo.filter(ImageFilter.GaussianBlur(radius=S * 0.05))
    img.alpha_composite(halo)

    # --- the voice: an asymmetric ink-blot body ----------------------------
    orb = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = orb.load()
    max_r = r0 * max(LOBES)
    y0, y1 = max(0, int(cy - max_r) - 2), min(S, int(cy + max_r) + 3)
    x0, x1 = max(0, int(cx - max_r) - 2), min(S, int(cx + max_r) + 3)
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)
            r_here = shape_radius(math.atan2(dy, dx), r0)
            if d > r_here:
                continue
            t = d / r_here
            dh = math.hypot(x - hx, y - hy)
            t_h = max(0.0, 1.0 - dh / (r0 * 1.1))

            col = mix(GOLD, EMBER, min(1.0, t * 1.3))
            col = mix(col, VIOLET, max(0.0, (t - 0.55)) * 1.6)
            col = mix(col, CORE_LIGHT, (t_h ** 2) * 0.6)

            a = 255
            edge = r_here - d
            if edge < 2 * ss:
                a = int(255 * max(0.0, edge / (2 * ss)))
            px[x, y] = col + (a,)
    img.alpha_composite(orb)

    return img.resize((size, size), Image.LANCZOS)


def write_favicon_svg() -> None:
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="g" cx="34%" cy="30%" r="80%">
      <stop offset="0%" stop-color="rgb{GOLD}"/>
      <stop offset="55%" stop-color="rgb{EMBER}"/>
      <stop offset="100%" stop-color="rgb{VIOLET}"/>
    </radialGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="rgb{BG}"/>
  <path fill="url(#g)" d="M16 5.2c3.3 3 5.6 5.7 5.6 8.9a5.6 5.6 0 0 1-6.3 5.6 5.2 5.2 0 0 1-4.8-6c.3-2.7 2.3-5.7 5.5-8.5Z"/>
</svg>
"""
    with open(os.path.join(OUT, "favicon.svg"), "w") as f:
        f.write(svg)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    render(192).convert("RGB").save(os.path.join(OUT, "icon-192.png"))
    render(512).convert("RGB").save(os.path.join(OUT, "icon-512.png"))
    # maskable: same art, the lobes already sit well inside the ~80% safe zone
    render(512).convert("RGB").save(os.path.join(OUT, "icon-maskable-512.png"))
    render(180).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    write_favicon_svg()
    print("icons written to", os.path.realpath(OUT))


if __name__ == "__main__":
    main()
