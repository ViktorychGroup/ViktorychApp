#!/usr/bin/env python3
"""Viktorych wordmarks and home-screen icons.

Same lockup as the previous wordmark: Inter Black for the V, Inter Regular
for the rest, currentColor so dark, dim, and light themes can invert it.
The home-screen icon is the V. Music mode uses the same V with an eighth note.
"""

from __future__ import annotations

import json
from pathlib import Path

try:
    import cairosvg
except Exception:  # raster regeneration needs cairo; BRAND_RASTER=0 skips it
    cairosvg = None

from wordmark import (
    GAP,
    HEAVY_SCALE,
    REGULAR,
    ROOT,
    black_font,
    ico_bytes,
    png_from_svg,
    round_path,
    run_path,
    shape,
    translate_commands,
    write,
)

NOTE = (
    "M34 118C34 132 14 136 10 124C6 112 22 104 34 112L38 114V36L92 18V86"
    "C92 100 72 104 68 92C64 80 80 72 92 80V8L38 28V114Z"
)


def lockup(heavy_text: str, light_text: str, title: str) -> str:
    black = black_font()
    heavy = shape(black, heavy_text)
    light = shape(REGULAR, light_text)
    _heavy_d, cursor, heavy_box = run_path(black, heavy, HEAVY_SCALE, 0)
    _light_d, _end, light_box = run_path(REGULAR, light, 1, cursor + GAP)
    box = (
        min(heavy_box[0], light_box[0]),
        min(heavy_box[1], light_box[1]),
        max(heavy_box[2], light_box[2]),
        max(heavy_box[3], light_box[3]),
    )
    x0, y0, x1, y1 = box
    heavy_d, cursor, _box = run_path(black, heavy, HEAVY_SCALE, -x0)
    light_d, _end, _box = run_path(REGULAR, light, 1, cursor + GAP)
    path = round_path(translate_commands(heavy_d + " " + light_d, 0, -y0))
    width, height = x1 - x0, y1 - y0
    return svg_current(width, height, f'<path d="{path}"/>', title)


def mark(title: str, body: str, width: float, height: float) -> str:
    return svg_current(width, height, body, title)


def v_mark() -> tuple[str, str, float, float]:
    black = black_font()
    placed = shape(black, "V")
    commands, _cursor, box = run_path(black, placed, HEAVY_SCALE, 0)
    path = round_path(translate_commands(commands, -box[0], -box[1]))
    width, height = box[2] - box[0], box[3] - box[1]
    return path, svg_current(width, height, f'<path d="{path}"/>', "V"), width, height


def music_mark(v_path: str, v_w: float, v_h: float) -> str:
    note_w, note_h = 100.0, 140.0
    note_scale = v_h * 0.42 / note_h
    gap = v_h * 0.06
    width = v_w + gap + note_w * note_scale
    note_x = v_w + gap
    note_y = v_h * 0.04
    body = (
        f'<path d="{v_path}"/>'
        f'<g transform="translate({note_x:.2f} {note_y:.2f}) scale({note_scale:.4f})"><path d="{NOTE}"/></g>'
    )
    return svg_current(width, v_h, body, "ViktorychMusic")


def svg_current(width: float, height: float, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.2f} {height:.2f}" '
        f'fill="currentColor" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>"
    )


def view_of(svg: str) -> tuple[float, float]:
    import re
    found = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg)
    return float(found.group(1)), float(found.group(2))


def inner(svg: str) -> str:
    start = svg.index(">", svg.index("<title>"))
    # title element ends, then the artwork
    start = svg.index("</title>") + len("</title>")
    end = svg.rindex("</svg>")
    return svg[start:end]


def icon_svg(size: int, kind: str, art: str, art_w: float, art_h: float, label: str) -> str:
    if kind == "maskable":
        ratio = 0.62
        radius = 0
        bg = f'<rect width="{size}" height="{size}" fill="#fff"/>'
    elif kind == "mono":
        ratio = 0.66
        radius = 0
        bg = ""
    elif kind == "apple":
        ratio = 0.72
        radius = 0
        bg = f'<rect width="{size}" height="{size}" fill="#fff"/>'
    elif kind == "si":
        ratio = 0.70 if size <= 16 else 0.74
        radius = max(2, round(size * 0.18))
        bg = f'<rect width="{size}" height="{size}" rx="{radius}" fill="#fff"/>'
    else:
        ratio = 0.70
        radius = max(3, round(size * 0.18))
        bg = f'<rect width="{size}" height="{size}" rx="{radius}" fill="#fff"/>'
    target = size * ratio
    scale = min(target / art_w, target / art_h)
    draw_w = art_w * scale
    draw_h = art_h * scale
    x = (size - draw_w) / 2
    y = (size - draw_h) / 2
    ink = art.replace('fill="currentColor"', 'fill="#000"')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f"<!-- {label} -->{bg}"
        f'<g transform="translate({x:.2f} {y:.2f}) scale({scale:.6f})" fill="#000">{ink}</g></svg>'
    )


def splash_svg(word: str, width: int, height: int) -> str:
    mark_w, mark_h = view_of(word)
    target = min(width * 0.78, height * 0.22)
    scale = target / mark_w
    draw_w = mark_w * scale
    draw_h = mark_h * scale
    x = (width - draw_w) / 2
    y = (height - draw_h) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<rect width="{width}" height="{height}" fill="#000"/>'
        f'<g transform="translate({x:.2f} {y:.2f}) scale({scale:.6f})" fill="#fff">{inner(word)}</g></svg>'
    )


def js_marks(items: dict[str, str]) -> str:
    payload = {}
    for name, svg in items.items():
        width, height = view_of(svg)
        payload[name] = {"box": f"0 0 {width:.2f} {height:.2f}", "body": inner(svg)}
    return (
        "/* Generated by scripts/brand_assets.py. Wordmarks and the V mark. */\n"
        "(function (root) {\n"
        "  root.ViktorychMarks = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
        "})(typeof globalThis !== \"undefined\" ? globalThis : this);\n"
    )


def raster(svg: str, size: int) -> bytes:
    return png_from_svg(svg, size, size)


def generate() -> None:
    app = lockup("V", "iktorychApp", "ViktorychApp")
    app_short = lockup("V", "iktorychApp", "ViktorychApp")
    music = lockup("V", "iktorychMusic", "ViktorychMusic")
    music_short = lockup("V", "iktorychMusic", "ViktorychMusic")
    v_path, v_svg, v_w, v_h = v_mark()
    music_svg = music_mark(v_path, v_w, v_h)
    logo = ROOT / "logo"
    write(logo / "viktorychapp.svg", app)
    write(logo / "viktorychapp-short.svg", app_short)
    write(logo / "viktorychmusic.svg", music)
    write(logo / "viktorychmusic-short.svg", music_short)
    write(logo / "v.svg", v_svg)
    write(logo / "v-music.svg", music_svg)
    for stale in ("wordmark.svg", "si.svg", "sintelmusic.svg", "preview.png", "si-preview.png"):
        path = logo / stale
        if path.exists():
            path.unlink()
    write(ROOT / "marks.js", js_marks({
        "app": app,
        "appShort": app_short,
        "music": music,
        "musicShort": music_short,
        "mark": v_svg,
        "musicMark": music_svg,
    }))
    v_art = inner(v_svg)
    m_art = inner(music_svg)
    mw, mh = view_of(music_svg)
    favicon = icon_svg(32, "any", v_art, v_w, v_h, "ViktorychApp")
    write(ROOT / "favicon.svg", favicon.replace(f'width="32" height="32" ', "", 1))
    # Rasters need cairo. BRAND_RASTER=0 regenerates only the vectors and
    # marks.js, for hosts without a cairo runtime (Windows dev boxes).
    skip_raster = __import__("os").environ.get("BRAND_RASTER", "") == "0"
    if not skip_raster and cairosvg is None:
        raise RuntimeError("cairo is unavailable; set BRAND_RASTER=0 for vectors only")
    rasters = {
        "icon-192.png": (icon_svg(192, "any", v_art, v_w, v_h, "ViktorychApp"), 192),
        "icon-512.png": (icon_svg(512, "any", v_art, v_w, v_h, "ViktorychApp"), 512),
        "icon-maskable-512.png": (icon_svg(512, "maskable", v_art, v_w, v_h, "ViktorychApp"), 512),
        "icon-monochrome-512.png": (icon_svg(512, "mono", v_art, v_w, v_h, "ViktorychApp"), 512),
        "apple-touch-icon.png": (icon_svg(180, "apple", v_art, v_w, v_h, "ViktorychApp"), 180),
        "music-192.png": (icon_svg(192, "any", m_art, mw, mh, "ViktorychMusic"), 192),
        "music-512.png": (icon_svg(512, "any", m_art, mw, mh, "ViktorychMusic"), 512),
        "music-maskable-512.png": (icon_svg(512, "maskable", m_art, mw, mh, "ViktorychMusic"), 512),
    }
    for name, (svg, size) in (rasters.items() if not skip_raster else []):
        write(ROOT / "icons" / name, raster(svg, size))
        print(name, f"{view_of(app)[0]/view_of(app)[1]:.2f}" if "icon-192" in name else "")
    if not skip_raster:
        frames = []
        for size, kind in ((16, "si"), (32, "si"), (48, "any"), (256, "any")):
            frames.append((size, raster(icon_svg(size, kind, v_art, v_w, v_h, "ViktorychApp"), size)))
        write(ROOT / "favicon.ico", ico_bytes(frames))
        # Richer-install shots are real UI frames (landing/*.webp), not splash marks.
        from richer_install_shots import generate as write_richer_shots
        write_richer_shots()
    splashes = [
        ("iphone-se", 640, 1136),
        ("iphone-8", 750, 1334),
        ("iphone-8-plus", 1242, 2208),
        ("iphone-x", 1125, 2436),
        ("iphone-xr", 828, 1792),
        ("iphone-xs-max", 1242, 2688),
        ("iphone-12", 1170, 2532),
        ("iphone-14-plus", 1284, 2778),
        ("iphone-14-pro", 1179, 2556),
        ("iphone-14-pro-max", 1290, 2796),
        ("iphone-16-pro-max", 1320, 2868),
        ("ipad", 1536, 2048),
        ("ipad-10", 1620, 2160),
        ("ipad-pro-11", 1668, 2388),
        ("ipad-pro-12", 2048, 2732),
    ]
    if not skip_raster:
        for name, w, h in splashes:
            write(ROOT / "splash" / f"{name}.png", png_from_svg(splash_svg(app, w, h), w, h))
    aw, ah = view_of(app)
    mw_, mh_ = view_of(music)
    print(f"app {aw:.0f}x{ah:.0f} at 28px -> {28*aw/ah:.0f}px")
    print(f"music {mw_:.0f}x{mh_:.0f} at 28px -> {28*mw_/mh_:.0f}px")
    print(f"short app at 22px -> {22*view_of(app_short)[0]/view_of(app_short)[1]:.0f}px")
    print(f"short music at 22px -> {22*view_of(music_short)[0]/view_of(music_short)[1]:.0f}px")


if __name__ == "__main__":
    generate()
