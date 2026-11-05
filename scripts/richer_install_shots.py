#!/usr/bin/env python3
"""Build richer-install screenshots Chrome shows in the install dialog.

Landing feature shots (landing/*.webp) are real UI frames. The old brand
pipeline wrote splash marks into screenshots/, so Chrome fell back to the
tiny install prompt instead of the richer dialog. This keeps sizes and
aspect ratios that Chrome accepts and fills the form_factor carousels.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LAND = ROOT / "landing"
OUT = ROOT / "screenshots"
BG = (0, 0, 0)
LINE = (47, 51, 54)
BLUE = (29, 155, 240)


def cover(src: Path | Image.Image, size: tuple[int, int], top_bias: bool = False) -> Image.Image:
    im = src.convert("RGB") if isinstance(src, Image.Image) else Image.open(src).convert("RGB")
    tw, th = size
    sw, sh = im.size
    scale = max(tw / sw, th / sh)
    nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (nw - tw) // 2
    if top_bias:
        y = max(0, (nh - th) // 5)
        if y + th > nh:
            y = nh - th
    else:
        y = (nh - th) // 2
    return im.crop((x, y, x + tw, y + th))


def desktop_shell(center: Image.Image, right: Image.Image) -> Image.Image:
    """Three-column desktop mock at 1920x1080 for wide form_factor shots."""
    width, height = 1920, 1080
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    nav_w, main_w, side_w = 88, 680, 420
    gap = 24
    total = nav_w + gap + main_w + gap + side_w
    x0 = (width - total) // 2
    y0 = 40
    col_h = height - 80
    draw.rounded_rectangle([x0, y0, x0 + nav_w, y0 + col_h], radius=28, fill=(22, 24, 28))
    draw.ellipse([x0 + 28, y0 + 36, x0 + 60, y0 + 68], fill=BLUE)
    for index, cy in enumerate((140, 210, 280, 350, 420)):
        draw.rounded_rectangle(
            [x0 + 28, y0 + cy, x0 + 60, y0 + cy + 28],
            radius=8,
            fill=BLUE if index == 0 else (47, 51, 54),
        )
    mx = x0 + nav_w + gap
    main = cover(center, (main_w, col_h), top_bias=True)
    mask = Image.new("L", (main_w, col_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, main_w, col_h], radius=28, fill=255)
    canvas.paste(main, (mx, y0), mask)
    sx = mx + main_w + gap
    side = cover(right, (side_w, col_h), top_bias=True)
    mask2 = Image.new("L", (side_w, col_h), 0)
    ImageDraw.Draw(mask2).rounded_rectangle([0, 0, side_w, col_h], radius=28, fill=255)
    canvas.paste(side, (sx, y0), mask2)
    draw.rectangle([0, 0, width, 1], fill=LINE)
    return canvas


def write(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def generate() -> None:
    if not (LAND / "timeline.webp").exists():
        raise SystemExit("landing/timeline.webp is missing; richer install shots need it")
    write(OUT / "narrow.png", cover(LAND / "timeline.webp", (1080, 1920), top_bias=True))
    write(OUT / "narrow-search.png", cover(LAND / "sidebar.webp", (1080, 1920), top_bias=True))
    write(OUT / "narrow-notes.png", cover(LAND / "notes.webp", (1080, 1920), top_bias=True))
    timeline = Image.open(LAND / "timeline.webp").convert("RGB")
    lists = Image.open(LAND / "lists.webp").convert("RGB")
    details = Image.open(LAND / "details.webp").convert("RGB")
    write(OUT / "wide.png", desktop_shell(timeline, lists))
    write(OUT / "wide-profile.png", desktop_shell(details, lists))


if __name__ == "__main__":
    generate()
    for path in sorted(OUT.glob("*.png")):
        image = Image.open(path)
        print(path.name, image.size, path.stat().st_size)
