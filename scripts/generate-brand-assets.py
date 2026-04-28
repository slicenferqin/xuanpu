#!/usr/bin/env python3
"""
Generate Xuanpu brand assets from the current product icon.

The app icon itself is selected through the design workflow and stored as
resources/icon-source.png. This script derives repository-facing assets from
that source: README banner, social preview, web/docs icons, vector lockups, and
the canonical palette metadata. Platform icons are still produced separately by
scripts/generate-icon.py.
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    raise SystemExit('Pillow is required. Install with: pip3 install Pillow')


PALETTE = {
    'porcelain': '#F7F3EA',
    'porcelain_warm': '#EFE7D5',
    'porcelain_shadow': '#CFC8B8',
    'jade_mist': '#DCEBE2',
    'field_jade': '#7FB69A',
    'field_jade_deep': '#30463D',
    'field_jade_dark': '#1E2B27',
    'ink': '#111827',
    'ink_soft': '#27302C',
    'muted': '#66766F',
    'line': '#C8D0C5',
    'signal_gold': '#D7B96C',
}

CATPPUCCIN_LATTE = {
    'base': '#EFF1F5',
    'mantle': '#E6E9EF',
    'crust': '#DCE0E8',
    'surface0': '#CCD0DA',
    'surface1': '#BCC0CC',
    'overlay0': '#9CA0B0',
    'text': '#4C4F69',
    'lavender': '#7287FD',
    'teal': '#179299',
    'sapphire': '#209FB5',
}

CATPPUCCIN_MOCHA = {
    'base': '#1E1E2E',
    'mantle': '#181825',
    'crust': '#11111B',
    'surface0': '#313244',
    'surface1': '#45475A',
    'overlay0': '#6C7086',
    'text': '#CDD6F4',
    'lavender': '#B4BEFE',
    'teal': '#94E2D5',
    'sapphire': '#74C7EC',
}


ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / 'resources'
BRAND = RESOURCES / 'brand'
DOCS = ROOT / 'docs'
MOBILE_PUBLIC = ROOT / 'mobile' / 'public'
RENDERER_ASSETS = ROOT / 'src' / 'renderer' / 'src' / 'assets'

FINAL_SOURCE = BRAND / 'v11' / 'final' / 'icon-source.png'
ACTIVE_SOURCE = RESOURCES / 'icon-source.png'
BANNER_SOURCE = BRAND / 'banner-v11' / 'final' / 'banner.png'
ONBOARDING_SOURCE = BRAND / 'onboarding-v11' / 'final' / 'onboarding-bg.png'
ONBOARDING_DARK_SOURCE = BRAND / 'onboarding-v11' / 'final' / 'onboarding-bg-dark.png'
SOCIAL_SOURCE = BRAND / 'social-v11' / 'final' / 'social-preview.png'
DMG_BASE_SOURCE = BRAND / 'dmg-v11' / 'final' / 'background-base.png'
CANVAS_SIZE = 1024
ICON_INSET = 100
ART_SIZE = CANVAS_SIZE - (ICON_INSET * 2)
SUPERELLIPSE_N = 5


def rgb(hex_value: str) -> tuple[int, int, int]:
    value = hex_value.lstrip('#')
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def rgba(hex_value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    return (*rgb(hex_value), alpha)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sign(value: float) -> float:
    if value > 0:
        return 1.0
    if value < 0:
        return -1.0
    return 0.0


def superellipse_mask(size: int, n: float = SUPERELLIPSE_N) -> Image.Image:
    scale = 4
    hi_size = size * scale
    mask = Image.new('L', (hi_size, hi_size), 0)
    draw = ImageDraw.Draw(mask)

    center = hi_size / 2
    half_axis = hi_size / 2
    points = []
    for index in range(1000):
        angle = 2 * math.pi * index / 1000
        cos_value = math.cos(angle)
        sin_value = math.sin(angle)
        x = half_axis * sign(cos_value) * abs(cos_value) ** (2 / n)
        y = half_axis * sign(sin_value) * abs(sin_value) ** (2 / n)
        points.append((center + x, center + y))

    draw.polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def apply_icon_mask(source: Image.Image) -> Image.Image:
    canvas = Image.new('RGBA', (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    art = source.convert('RGBA').resize((ART_SIZE, ART_SIZE), Image.LANCZOS)
    art.putalpha(superellipse_mask(ART_SIZE))
    canvas.paste(art, (ICON_INSET, ICON_INSET), art)
    return canvas


def apply_final_icon_mask(source: Image.Image) -> Image.Image:
    icon = source.convert('RGBA').resize((CANVAS_SIZE, CANVAS_SIZE), Image.LANCZOS)
    alpha = icon.getchannel('A')
    alpha = Image.composite(alpha, Image.new('L', icon.size, 0), superellipse_mask(CANVAS_SIZE))
    icon.putalpha(alpha)
    return icon


def font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    candidates = []
    if mono:
        candidates.extend(
            [
                '/System/Library/Fonts/SFNSMono.ttf',
                '/System/Library/Fonts/Menlo.ttc',
            ]
        )
    if bold:
        candidates.extend(
            [
                '/System/Library/Fonts/STHeiti Medium.ttc',
                '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                '/System/Library/Fonts/SFNS.ttf',
            ]
        )
    candidates.extend(
        [
            '/System/Library/Fonts/STHeiti Light.ttc',
            '/System/Library/Fonts/Supplemental/Arial.ttf',
            '/System/Library/Fonts/SFNS.ttf',
        ]
    )

    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue

    return ImageFont.load_default()


def linear_gradient(size: tuple[int, int], left: str, right: str) -> Image.Image:
    width, height = size
    start = rgb(left)
    end = rgb(right)
    image = Image.new('RGBA', size)
    pixels = image.load()
    for x in range(width):
        t = x / max(width - 1, 1)
        color = mix(start, end, t)
        for y in range(height):
            pixels[x, y] = (*color, 255)
    return image


def radial_glow(
    size: tuple[int, int],
    center: tuple[float, float],
    color: str,
    max_alpha: int,
    radius: float,
) -> Image.Image:
    width, height = size
    cx, cy = center
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    pixels = layer.load()
    cr, cg, cb = rgb(color)
    for y in range(height):
        for x in range(width):
            distance = math.hypot((x - cx) / radius, (y - cy) / radius)
            if distance < 1:
                alpha = round(max_alpha * (1 - distance) ** 2)
                pixels[x, y] = (cr, cg, cb, alpha)
    return layer


def draw_rounded_shadow(
    base: Image.Image,
    box: tuple[int, int, int, int],
    radius: int,
    offset: tuple[int, int],
    blur: int,
    color: tuple[int, int, int, int],
) -> None:
    shadow = Image.new('RGBA', base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    x0, y0, x1, y1 = box
    dx, dy = offset
    draw.rounded_rectangle((x0 + dx, y0 + dy, x1 + dx, y1 + dy), radius=radius, fill=color)
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(blur)))


def draw_icon(
    base: Image.Image,
    icon: Image.Image,
    box: tuple[int, int, int, int],
    shadow: bool = True,
) -> None:
    x0, y0, x1, y1 = box
    width = x1 - x0
    height = y1 - y0
    size = min(width, height)
    if shadow:
        draw_rounded_shadow(
            base,
            (x0, y0, x0 + size, y0 + size),
            round(size * 0.22),
            (0, round(size * 0.07)),
            round(size * 0.08),
            (44, 54, 48, 54),
        )
    rendered = icon.resize((size, size), Image.LANCZOS)
    base.alpha_composite(rendered, (x0, y0))


def draw_badge(
    draw: ImageDraw.ImageDraw,
    text: str,
    origin: tuple[int, int],
    font_obj: ImageFont.FreeTypeFont,
    scale: int,
) -> int:
    x, y = origin
    bbox = draw.textbbox((0, 0), text, font=font_obj)
    width = bbox[2] - bbox[0] + 34 * scale
    height = 42 * scale
    draw.rounded_rectangle(
        [x, y, x + width, y + height],
        radius=18 * scale,
        fill=rgba(PALETTE['field_jade'], 30),
        outline=rgba(PALETTE['field_jade_deep'], 62),
        width=max(1, scale),
    )
    draw.text(
        (x + 17 * scale, y + 11 * scale),
        text,
        font=font_obj,
        fill=rgba(PALETTE['field_jade_deep'], 222),
    )
    return width


def draw_arrow(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    color: tuple[int, int, int, int],
    width: int,
    scale: int,
) -> None:
    draw.line([start, end], fill=color, width=width)
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    angle = math.atan2(dy, dx)
    head_length = 13 * scale
    head_angle = math.radians(28)
    left = (
        end[0] - head_length * math.cos(angle - head_angle),
        end[1] - head_length * math.sin(angle - head_angle),
    )
    right = (
        end[0] - head_length * math.cos(angle + head_angle),
        end[1] - head_length * math.sin(angle + head_angle),
    )
    draw.polygon([end, left, right], fill=color)


def draw_rounded_segment(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    width: int,
    fill: tuple[int, int, int, int],
) -> None:
    x0, y0 = start
    x1, y1 = end
    radius = width // 2
    if y0 == y1:
        left, right = sorted((x0, x1))
        draw.rounded_rectangle(
            [left, y0 - radius, right, y0 + radius],
            radius=radius,
            fill=fill,
        )
        return
    if x0 == x1:
        top, bottom = sorted((y0, y1))
        draw.rounded_rectangle(
            [x0 - radius, top, x0 + radius, bottom],
            radius=radius,
            fill=fill,
        )
        return
    draw.line([start, end], width=width, fill=fill, joint='curve')


def draw_crop_mark(
    draw: ImageDraw.ImageDraw,
    corner: tuple[int, int],
    direction: tuple[int, int],
    length: int,
    width: int,
    color: tuple[int, int, int, int],
) -> None:
    x, y = corner
    dx, dy = direction
    draw_rounded_segment(draw, (x, y), (x + dx * length, y), width, color)
    draw_rounded_segment(draw, (x, y), (x, y + dy * length), width, color)


def draw_field_mesh(
    draw: ImageDraw.ImageDraw,
    scale: int,
    size: tuple[int, int],
    dark: bool = False,
    quiet_center: bool = False,
) -> None:
    width, height = size
    line = rgba(PALETTE['jade_mist'] if dark else PALETTE['field_jade_deep'], 58 if dark else 26)
    line_soft = rgba(PALETTE['jade_mist'] if dark else PALETTE['field_jade_deep'], 34 if dark else 18)
    node = rgba(PALETTE['field_jade'], 118 if dark else 82)
    gold = rgba(PALETTE['signal_gold'], 94 if dark else 64)

    columns = [0.12, 0.31, 0.58, 0.79, 0.91]
    rows = [0.18, 0.34, 0.58, 0.76]
    for x_ratio in columns:
        x = round(width * x_ratio)
        draw.line([(x, round(height * 0.08)), (x, round(height * 0.92))], fill=line_soft, width=scale)
    for y_ratio in rows:
        y = round(height * y_ratio)
        draw.line([(round(width * 0.06), y), (round(width * 0.94), y)], fill=line_soft, width=scale)

    if quiet_center:
        paths = [
            [(0.09, 0.25), (0.23, 0.25), (0.32, 0.33), (0.43, 0.33)],
            [(0.62, 0.25), (0.76, 0.25), (0.84, 0.34), (0.94, 0.34)],
            [(0.10, 0.72), (0.24, 0.72), (0.34, 0.64), (0.44, 0.64)],
            [(0.61, 0.66), (0.74, 0.66), (0.83, 0.74), (0.94, 0.74)],
        ]
    else:
        paths = [
            [(0.10, 0.25), (0.24, 0.25), (0.33, 0.34), (0.46, 0.34)],
            [(0.56, 0.24), (0.72, 0.24), (0.82, 0.35), (0.92, 0.35)],
            [(0.14, 0.72), (0.28, 0.72), (0.38, 0.62), (0.50, 0.62)],
            [(0.55, 0.68), (0.70, 0.68), (0.80, 0.78), (0.92, 0.78)],
        ]

    for index, path in enumerate(paths):
        points = [(round(width * x), round(height * y)) for x, y in path]
        draw.line(points, fill=line, width=max(1, 2 * scale), joint='curve')
        for point in points:
            radius = 5 * scale
            color = gold if index == 2 and point == points[0] else node
            x, y = point
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)

    for box in [
        (0.06, 0.08, 0.23, 0.18),
        (0.76, 0.10, 0.94, 0.22),
        (0.06, 0.76, 0.25, 0.88),
        (0.76, 0.74, 0.95, 0.88),
    ]:
        draw.rounded_rectangle(
            [round(width * box[0]), round(height * box[1]), round(width * box[2]), round(height * box[3])],
            radius=24 * scale,
            outline=line_soft,
            width=max(1, scale),
        )


def draw_xuan_glyph(
    canvas: Image.Image,
    text_box: tuple[int, int, int, int],
    fill: tuple[int, int, int, int],
    shadow: bool = True,
) -> None:
    x0, y0, x1, y1 = text_box
    target_width = x1 - x0
    target_height = y1 - y0
    glyph_font = font(target_height, bold=True)
    bbox = glyph_font.getbbox('玄')
    glyph_width = bbox[2] - bbox[0]
    glyph_height = bbox[3] - bbox[1]
    scale_factor = min(target_width / glyph_width, target_height / glyph_height)
    glyph_font = font(max(1, round(target_height * scale_factor)), bold=True)
    bbox = glyph_font.getbbox('玄')
    glyph_width = bbox[2] - bbox[0]
    glyph_height = bbox[3] - bbox[1]
    tx = x0 + (target_width - glyph_width) // 2 - bbox[0]
    ty = y0 + (target_height - glyph_height) // 2 - bbox[1]

    if shadow:
        shadow_layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer)
        shadow_draw.text((tx, ty + round(target_height * 0.035)), '玄', font=glyph_font, fill=rgba('#06110E', 72))
        canvas.alpha_composite(shadow_layer.filter(ImageFilter.GaussianBlur(round(target_height * 0.022))))

    glyph_layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    glyph_draw = ImageDraw.Draw(glyph_layer)
    glyph_draw.text((tx, ty), '玄', font=glyph_font, fill=fill)
    canvas.alpha_composite(glyph_layer)

    highlight = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    highlight_draw = ImageDraw.Draw(highlight)
    highlight_draw.text(
        (tx + 1, ty - round(target_height * 0.012)),
        '玄',
        font=glyph_font,
        fill=rgba('#FFFFFF', 34),
    )
    canvas.alpha_composite(highlight)


def make_icon_source_art() -> Image.Image:
    size = (1024, 1024)
    scale = 3
    canvas = linear_gradient(
        (size[0] * scale, size[1] * scale),
        '#F8F4EA',
        '#DCEBE2',
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (760 * scale, 170 * scale), PALETTE['field_jade'], 92, 540 * scale)
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (190 * scale, 860 * scale), PALETTE['signal_gold'], 42, 460 * scale)
    )
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(
        [18 * scale, 18 * scale, 1006 * scale, 1006 * scale],
        radius=238 * scale,
        fill=rgba('#FFFDF8', 204),
        outline=rgba(PALETTE['porcelain_shadow'], 120),
        width=2 * scale,
    )

    mesh = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    draw_field_mesh(ImageDraw.Draw(mesh), scale, canvas.size, dark=False, quiet_center=True)
    canvas.alpha_composite(mesh.filter(ImageFilter.GaussianBlur(0.25 * scale)))

    field_shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    field_shadow_draw = ImageDraw.Draw(field_shadow)
    field_shadow_draw.rounded_rectangle(
        [236 * scale, 216 * scale, 788 * scale, 808 * scale],
        radius=88 * scale,
        fill=rgba('#06110E', 78),
    )
    canvas.alpha_composite(field_shadow.filter(ImageFilter.GaussianBlur(24 * scale)))

    draw.rounded_rectangle(
        [244 * scale, 214 * scale, 780 * scale, 786 * scale],
        radius=88 * scale,
        fill=rgba(PALETTE['field_jade_deep'], 38),
        outline=rgba(PALETTE['field_jade_dark'], 246),
        width=42 * scale,
    )
    draw.rounded_rectangle(
        [286 * scale, 256 * scale, 738 * scale, 744 * scale],
        radius=54 * scale,
        outline=rgba('#FFFFFF', 58),
        width=3 * scale,
    )

    furrow = rgba(PALETTE['field_jade_dark'], 236)
    for y in [374, 512, 650]:
        draw_rounded_segment(
            draw,
            (326 * scale, y * scale),
            (698 * scale, y * scale),
            26 * scale,
            furrow,
        )
    draw_rounded_segment(
        draw,
        (512 * scale, 312 * scale),
        (512 * scale, 704 * scale),
        28 * scale,
        furrow,
    )
    draw_rounded_segment(
        draw,
        (330 * scale, 300 * scale),
        (694 * scale, 300 * scale),
        18 * scale,
        rgba(PALETTE['signal_gold'], 190),
    )

    for x, y, color in [
        (326, 374, PALETTE['field_jade']),
        (698, 374, PALETTE['field_jade']),
        (512, 512, PALETTE['field_jade']),
        (326, 650, PALETTE['field_jade']),
        (698, 650, PALETTE['field_jade']),
        (330, 300, PALETTE['signal_gold']),
    ]:
        radius = 13 * scale
        draw.ellipse(
            [(x * scale) - radius, (y * scale) - radius, (x * scale) + radius, (y * scale) + radius],
            fill=(*rgb(color), 224),
        )

    rim = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.rounded_rectangle(
        [24 * scale, 24 * scale, 1000 * scale, 1000 * scale],
        radius=232 * scale,
        outline=rgba('#FFFFFF', 132),
        width=5 * scale,
    )
    canvas.alpha_composite(rim.filter(ImageFilter.GaussianBlur(0.6 * scale)))
    return canvas.resize(size, Image.LANCZOS).convert('RGBA')


def crop_to_aspect(image: Image.Image, aspect: float, y_bias: float = 0.5) -> Image.Image:
    width, height = image.size
    source_aspect = width / height

    if source_aspect > aspect:
        crop_width = round(height * aspect)
        x0 = (width - crop_width) // 2
        return image.crop((x0, 0, x0 + crop_width, height))

    crop_height = round(width / aspect)
    y0 = round((height - crop_height) * y_bias)
    y0 = max(0, min(y0, height - crop_height))
    return image.crop((0, y0, width, y0 + crop_height))


def draw_catppuccin_edge_field(
    canvas: Image.Image,
    scale: int,
    colors: dict[str, str],
    dark: bool,
) -> None:
    width, height = canvas.size
    draw = ImageDraw.Draw(canvas)
    line_alpha = 32 if dark else 40
    soft_alpha = 18 if dark else 28
    node_alpha = 54 if dark else 48
    line = rgba(colors['lavender'], line_alpha)
    line_soft = rgba(colors['overlay0'], soft_alpha)
    teal = rgba(colors['teal'], node_alpha)

    edge_paths = [
        [(0.055, 0.18), (0.185, 0.18), (0.265, 0.285), (0.355, 0.285)],
        [(0.065, 0.68), (0.205, 0.68), (0.285, 0.575), (0.365, 0.575)],
        [(0.645, 0.245), (0.742, 0.245), (0.815, 0.34), (0.945, 0.34)],
        [(0.635, 0.66), (0.735, 0.66), (0.825, 0.755), (0.95, 0.755)],
    ]
    for path in edge_paths:
        points = [(round(width * x), round(height * y)) for x, y in path]
        draw.line(points, fill=line, width=max(1, round(1.6 * scale)), joint='curve')
        for x, y in points[1:-1]:
            radius = max(2, round(3.2 * scale))
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=teal)

    for x_ratio in [0.16, 0.26, 0.74, 0.84]:
        x = round(width * x_ratio)
        draw.line(
            [(x, round(height * 0.09)), (x, round(height * 0.91))],
            fill=line_soft,
            width=max(1, scale),
        )

    for y_ratio in [0.22, 0.5, 0.78]:
        y = round(height * y_ratio)
        draw.line(
            [(round(width * 0.04), y), (round(width * 0.28), y)],
            fill=line_soft,
            width=max(1, scale),
        )
        draw.line(
            [(round(width * 0.72), y), (round(width * 0.96), y)],
            fill=line_soft,
            width=max(1, scale),
        )


def make_catppuccin_onboarding_background(dark: bool = False) -> Image.Image:
    size = (1200, 896)
    scale = 2
    colors = CATPPUCCIN_MOCHA if dark else CATPPUCCIN_LATTE
    canvas = linear_gradient(
        (size[0] * scale, size[1] * scale),
        colors['base'],
        colors['mantle'] if dark else colors['base'],
    )

    canvas.alpha_composite(
        radial_glow(
            canvas.size,
            (960 * scale, 120 * scale),
            colors['lavender'],
            70 if dark else 54,
            470 * scale,
        )
    )
    canvas.alpha_composite(
        radial_glow(
            canvas.size,
            (128 * scale, 820 * scale),
            colors['teal'],
            54 if dark else 42,
            430 * scale,
        )
    )
    canvas.alpha_composite(
        radial_glow(
            canvas.size,
            (1040 * scale, 770 * scale),
            colors['sapphire'],
            28 if dark else 24,
            360 * scale,
        )
    )

    panels = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    panel_draw = ImageDraw.Draw(panels)
    panel_fill = rgba(colors['surface0'], 58 if dark else 84)
    panel_fill_soft = rgba(colors['surface1'], 34 if dark else 48)
    panel_line = rgba(colors['overlay0'], 40 if dark else 48)

    left_outer = [
        (0, 72 * scale),
        (210 * scale, 12 * scale),
        (306 * scale, 884 * scale),
        (0, 824 * scale),
    ]
    left_inner = [
        (92 * scale, 0),
        (324 * scale, 58 * scale),
        (378 * scale, 808 * scale),
        (144 * scale, 896 * scale),
    ]
    right_outer = [
        (1200 * scale, 54 * scale),
        (988 * scale, 0),
        (890 * scale, 896 * scale),
        (1200 * scale, 828 * scale),
    ]
    right_inner = [
        (1084 * scale, 0),
        (848 * scale, 62 * scale),
        (814 * scale, 812 * scale),
        (1062 * scale, 896 * scale),
    ]
    for polygon, fill in [
        (left_outer, panel_fill),
        (left_inner, panel_fill_soft),
        (right_outer, panel_fill),
        (right_inner, panel_fill_soft),
    ]:
        panel_draw.polygon(polygon, fill=fill)
        panel_draw.line(polygon + [polygon[0]], fill=panel_line, width=max(1, scale))

    panels = panels.filter(ImageFilter.GaussianBlur(0.45 * scale))
    canvas.alpha_composite(panels)

    draw_catppuccin_edge_field(canvas, scale, colors, dark)

    center_veil = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    veil_draw = ImageDraw.Draw(center_veil)
    if dark:
        veil_draw.rounded_rectangle(
            [332 * scale, 210 * scale, 868 * scale, 686 * scale],
            radius=118 * scale,
            fill=rgba(colors['base'], 126),
        )
        veil_draw.rectangle(
            [250 * scale, 300 * scale, 950 * scale, 610 * scale],
            fill=rgba(colors['base'], 72),
        )
    else:
        veil_draw.rounded_rectangle(
            [320 * scale, 198 * scale, 880 * scale, 698 * scale],
            radius=128 * scale,
            fill=rgba(colors['base'], 176),
        )
        veil_draw.rectangle(
            [230 * scale, 292 * scale, 970 * scale, 618 * scale],
            fill=rgba(colors['base'], 94),
        )
    canvas.alpha_composite(center_veil.filter(ImageFilter.GaussianBlur(58 * scale)))

    quiet = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    quiet_draw = ImageDraw.Draw(quiet)
    quiet_draw.rounded_rectangle(
        [392 * scale, 284 * scale, 808 * scale, 612 * scale],
        radius=88 * scale,
        fill=rgba(colors['base'], 84 if dark else 126),
    )
    canvas.alpha_composite(quiet.filter(ImageFilter.GaussianBlur(42 * scale)))

    return canvas.resize(size, Image.LANCZOS).convert('RGBA')


def sync_icon_source() -> Image.Image:
    RESOURCES.mkdir(parents=True, exist_ok=True)
    if not FINAL_SOURCE.exists():
        raise SystemExit(f'missing final icon source: {FINAL_SOURCE}')
    shutil.copy2(FINAL_SOURCE, ACTIVE_SOURCE)
    if not ACTIVE_SOURCE.exists():
        raise SystemExit(f'missing icon source: {ACTIVE_SOURCE}')
    return Image.open(ACTIVE_SOURCE).convert('RGBA')


def make_banner(icon: Image.Image) -> None:
    if BANNER_SOURCE.exists():
        shutil.copy2(BANNER_SOURCE, RESOURCES / 'banner.png')
        return

    size = (2064, 512)
    scale = 2
    canvas = linear_gradient(
        (size[0] * scale, size[1] * scale),
        '#F8F4EA',
        '#DCEBE2',
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (1680 * scale, 96 * scale), PALETTE['field_jade'], 72, 560 * scale)
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (190 * scale, 450 * scale), PALETTE['signal_gold'], 42, 520 * scale)
    )

    mesh = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    draw_field_mesh(ImageDraw.Draw(mesh), scale, canvas.size, dark=False, quiet_center=False)
    canvas.alpha_composite(mesh)

    veil = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    veil_draw = ImageDraw.Draw(veil)
    veil_draw.rounded_rectangle(
        [42 * scale, 42 * scale, 1280 * scale, 470 * scale],
        radius=54 * scale,
        fill=rgba('#FFFDF7', 182),
        outline=rgba(PALETTE['field_jade_deep'], 32),
        width=scale,
    )
    veil_draw.rectangle(
        [1220 * scale, 0, canvas.size[0], canvas.size[1]],
        fill=rgba('#FFFDF7', 48),
    )
    canvas.alpha_composite(veil.filter(ImageFilter.GaussianBlur(0.35 * scale)))

    draw = ImageDraw.Draw(canvas)
    draw_icon(canvas, icon, (112 * scale, 104 * scale, 390 * scale, 382 * scale), shadow=True)
    text_x = 452 * scale
    draw.text(
        (text_x, 104 * scale),
        '玄圃',
        font=font(78 * scale, bold=True),
        fill=rgba(PALETTE['field_jade_dark']),
    )
    draw.text(
        (text_x + 4 * scale, 202 * scale),
        'Xuanpu Workbench',
        font=font(34 * scale, mono=True),
        fill=rgba(PALETTE['field_jade_deep'], 238),
    )
    draw.text(
        (text_x + 6 * scale, 282 * scale),
        'AI-native field context for coding agents',
        font=font(28 * scale),
        fill=rgba(PALETTE['muted'], 238),
    )

    badge_font = font(18 * scale, mono=True)
    x = text_x + 8 * scale
    for label in ['PROJECT', 'WORKTREE', 'SESSION', 'MEMORY']:
        x += draw_badge(draw, label, (x, 368 * scale), badge_font, scale)
        x += 12 * scale

    panel = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    panel_draw = ImageDraw.Draw(panel)
    for index, box in enumerate(
        [
            (1430, 124, 1818, 208),
            (1512, 238, 1946, 322),
            (1398, 352, 1748, 430),
        ]
    ):
        alpha = 82 - index * 12
        panel_draw.rounded_rectangle(
            [value * scale for value in box],
            radius=26 * scale,
            fill=rgba('#FFFDF7', alpha),
            outline=rgba(PALETTE['field_jade_deep'], 30),
            width=scale,
        )
    panel_draw.line(
        [(1500 * scale, 208 * scale), (1614 * scale, 238 * scale), (1614 * scale, 352 * scale)],
        fill=rgba(PALETTE['field_jade_deep'], 62),
        width=2 * scale,
    )
    for point in [(1500, 208), (1614, 238), (1614, 352)]:
        x0, y0 = point
        panel_draw.ellipse(
            [(x0 - 7) * scale, (y0 - 7) * scale, (x0 + 7) * scale, (y0 + 7) * scale],
            fill=rgba(PALETTE['field_jade'], 130),
        )
    canvas.alpha_composite(panel)

    canvas = canvas.resize(size, Image.LANCZOS)
    canvas.convert('RGB').save(RESOURCES / 'banner.png')


def make_dmg_background(icon: Image.Image) -> None:
    if DMG_BASE_SOURCE.exists():
        source = Image.open(DMG_BASE_SOURCE).convert('RGB').resize((1080, 840), Image.LANCZOS)
        canvas = source.convert('RGBA')
        scale = 2

        veil = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        veil_draw = ImageDraw.Draw(veil)
        veil_draw.rounded_rectangle(
            [28 * scale, 28 * scale, 512 * scale, 130 * scale],
            radius=28 * scale,
            fill=rgba('#FFFDF6', 118),
            outline=rgba(PALETTE['field_jade_deep'], 16),
            width=scale,
        )
        veil_draw.rounded_rectangle(
            [72 * scale, 286 * scale, 468 * scale, 366 * scale],
            radius=24 * scale,
            fill=rgba('#FFFDF6', 62),
            outline=rgba(PALETTE['field_jade_deep'], 12),
            width=scale,
        )
        canvas.alpha_composite(veil.filter(ImageFilter.GaussianBlur(0.25 * scale)))

        draw = ImageDraw.Draw(canvas)
        draw_icon(canvas, icon, (50 * scale, 42 * scale, 106 * scale, 98 * scale), shadow=True)
        draw.text(
            (126 * scale, 38 * scale),
            '安装玄圃',
            font=font(27 * scale, bold=True),
            fill=rgba(PALETTE['field_jade_dark']),
        )
        draw.text(
            (128 * scale, 76 * scale),
            'Drag app to Applications,',
            font=font(13 * scale),
            fill=rgba(PALETTE['field_jade_deep'], 226),
        )
        draw.text(
            (128 * scale, 96 * scale),
            'or double-click Install Xuanpu.command.',
            font=font(13 * scale),
            fill=rgba(PALETTE['field_jade_deep'], 226),
        )
        draw_arrow(
            draw,
            (222 * scale, 190 * scale),
            (314 * scale, 190 * scale),
            rgba(PALETTE['field_jade_deep'], 88),
            max(1, round(1.4 * scale)),
            scale,
        )
        draw_arrow(
            draw,
            (270 * scale, 248 * scale),
            (270 * scale, 284 * scale),
            rgba(PALETTE['field_jade_deep'], 70),
            max(1, round(1.4 * scale)),
            scale,
        )
        canvas.convert('RGB').save(RESOURCES / 'dmg-background@2x.png')
        canvas.resize((540, 420), Image.LANCZOS).convert('RGB').save(RESOURCES / 'dmg-background.png')
        return

    size = (540, 420)
    scale = 2
    canvas = linear_gradient(
        (size[0] * scale, size[1] * scale),
        '#F9F6EF',
        '#DDEAE1',
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (456 * scale, 62 * scale), PALETTE['field_jade'], 74, 250 * scale)
    )
    canvas.alpha_composite(
        radial_glow(canvas.size, (72 * scale, 386 * scale), PALETTE['signal_gold'], 36, 230 * scale)
    )

    mesh = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    draw_field_mesh(ImageDraw.Draw(mesh), scale, canvas.size, dark=False, quiet_center=True)
    canvas.alpha_composite(mesh.filter(ImageFilter.GaussianBlur(0.2 * scale)))

    draw = ImageDraw.Draw(canvas)
    header = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    header_draw = ImageDraw.Draw(header)
    header_draw.rounded_rectangle(
        [34 * scale, 28 * scale, 506 * scale, 124 * scale],
        radius=24 * scale,
        fill=rgba('#FFFDF6', 94),
        outline=rgba(PALETTE['field_jade_deep'], 14),
        width=scale,
    )
    canvas.alpha_composite(header.filter(ImageFilter.GaussianBlur(0.35 * scale)))

    helper_band = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    band_draw = ImageDraw.Draw(helper_band)
    band_draw.rounded_rectangle(
        [60 * scale, 286 * scale, 480 * scale, 368 * scale],
        radius=26 * scale,
        fill=rgba('#FFFDF6', 64),
        outline=rgba(PALETTE['field_jade_deep'], 12),
        width=scale,
    )
    canvas.alpha_composite(helper_band.filter(ImageFilter.GaussianBlur(0.25 * scale)))

    draw_icon(canvas, icon, (50 * scale, 38 * scale, 110 * scale, 98 * scale), shadow=True)
    draw.text(
        (128 * scale, 38 * scale),
        '安装玄圃',
        font=font(27 * scale, bold=True),
        fill=rgba(PALETTE['field_jade_dark']),
    )
    draw.text(
        (130 * scale, 76 * scale),
        'Drag app to Applications,',
        font=font(13 * scale),
        fill=rgba(PALETTE['field_jade_deep'], 224),
    )
    draw.text(
        (130 * scale, 96 * scale),
        'or double-click Install Xuanpu.command.',
        font=font(13 * scale),
        fill=rgba(PALETTE['field_jade_deep'], 224),
    )

    guide_color = rgba(PALETTE['field_jade_deep'], 74)
    draw_arrow(
        draw,
        (222 * scale, 190 * scale),
        (314 * scale, 190 * scale),
        guide_color,
        max(1, round(1.4 * scale)),
        scale,
    )
    draw_arrow(
        draw,
        (270 * scale, 250 * scale),
        (270 * scale, 284 * scale),
        rgba(PALETTE['signal_gold'], 106),
        max(1, round(1.4 * scale)),
        scale,
    )

    wells = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    wells_draw = ImageDraw.Draw(wells)
    for center_x, center_y, radius, alpha in [
        (130, 190, 54, 28),
        (410, 190, 54, 28),
        (270, 320, 46, 24),
    ]:
        wells_draw.ellipse(
            [
                (center_x - radius) * scale,
                (center_y - radius) * scale,
                (center_x + radius) * scale,
                (center_y + radius) * scale,
            ],
            fill=rgba('#FFFDF6', alpha),
        )
    canvas.alpha_composite(wells.filter(ImageFilter.GaussianBlur(12 * scale)))

    canvas.convert('RGB').save(RESOURCES / 'dmg-background@2x.png')
    canvas.resize(size, Image.LANCZOS).convert('RGB').save(RESOURCES / 'dmg-background.png')


def make_onboarding_backgrounds() -> None:
    size = (1200, 896)
    RENDERER_ASSETS.mkdir(parents=True, exist_ok=True)

    if ONBOARDING_SOURCE.exists():
        light = Image.open(ONBOARDING_SOURCE).convert('RGBA').resize(size, Image.LANCZOS)
    else:
        ONBOARDING_SOURCE.parent.mkdir(parents=True, exist_ok=True)
        light = make_catppuccin_onboarding_background(dark=False)
        light.convert('RGB').save(ONBOARDING_SOURCE)

    if ONBOARDING_DARK_SOURCE.exists():
        dark = Image.open(ONBOARDING_DARK_SOURCE).convert('RGBA').resize(size, Image.LANCZOS)
    else:
        ONBOARDING_DARK_SOURCE.parent.mkdir(parents=True, exist_ok=True)
        dark = make_catppuccin_onboarding_background(dark=True)
        dark.convert('RGB').save(ONBOARDING_DARK_SOURCE)

    light.save(RENDERER_ASSETS / 'onboarding-bg.png')
    dark.save(RENDERER_ASSETS / 'onboarding-bg-dark.png')


def make_social_preview(icon: Image.Image) -> None:
    if SOCIAL_SOURCE.exists():
        DOCS.mkdir(parents=True, exist_ok=True)
        Image.open(SOCIAL_SOURCE).convert('RGB').resize((1280, 640), Image.LANCZOS).save(
            DOCS / 'social-preview.png'
        )
        return

    size = (1280, 640)
    scale = 2
    canvas = linear_gradient(
        (size[0] * scale, size[1] * scale),
        '#F9F6EF',
        PALETTE['jade_mist'],
    )
    canvas.alpha_composite(
        radial_glow(
            canvas.size,
            (1030 * scale, 118 * scale),
            PALETTE['field_jade'],
            84,
            420 * scale,
        )
    )
    canvas.alpha_composite(
        radial_glow(
            canvas.size,
            (128 * scale, 570 * scale),
            PALETTE['signal_gold'],
            42,
            420 * scale,
        )
    )
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(
        [54 * scale, 48 * scale, 1226 * scale, 592 * scale],
        radius=64 * scale,
        fill=rgba('#FFFFFF', 122),
        outline=rgba(PALETTE['field_jade_deep'], 42),
        width=1 * scale,
    )
    draw_icon(canvas, icon, (806 * scale, 132 * scale, 1126 * scale, 452 * scale), shadow=True)

    draw.text(
        (92 * scale, 108 * scale),
        '玄圃',
        font=font(98 * scale, bold=True),
        fill=rgba(PALETTE['field_jade_dark']),
    )
    draw.text(
        (98 * scale, 222 * scale),
        'Xuanpu Workbench',
        font=font(40 * scale, mono=True),
        fill=rgba(PALETTE['field_jade_deep'], 238),
    )
    draw.text(
        (100 * scale, 322 * scale),
        'Agent 的现场提供者',
        font=font(42 * scale, bold=True),
        fill=rgba(PALETTE['ink_soft'], 238),
    )
    draw.text(
        (102 * scale, 392 * scale),
        'Project, worktree, session, context, memory and changes',
        font=font(24 * scale),
        fill=rgba(PALETTE['muted'], 236),
    )
    draw.text(
        (102 * scale, 434 * scale),
        'in one desktop workbench.',
        font=font(24 * scale),
        fill=rgba(PALETTE['muted'], 236),
    )
    draw.text(
        (104 * scale, 528 * scale),
        'FIELD CONTEXT / WORKTREE / MEMORY',
        font=font(17 * scale, mono=True),
        fill=rgba(PALETTE['field_jade_deep'], 190),
    )

    canvas = canvas.resize(size, Image.LANCZOS)
    DOCS.mkdir(parents=True, exist_ok=True)
    canvas.convert('RGB').save(DOCS / 'social-preview.png')


def make_docs_icons(icon: Image.Image) -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(DOCS / 'icon.png')
    icon.resize((180, 180), Image.LANCZOS).save(DOCS / 'apple-touch-icon.png')
    icon.resize((256, 256), Image.LANCZOS).save(
        DOCS / 'favicon.ico',
        format='ICO',
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def make_svg_assets() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    MOBILE_PUBLIC.mkdir(parents=True, exist_ok=True)

    icon_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{PALETTE['porcelain']}"/>
      <stop offset=".58" stop-color="#FFFDF7"/>
      <stop offset="1" stop-color="{PALETTE['jade_mist']}"/>
    </linearGradient>
    <linearGradient id="rightPanel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#647D70"/>
      <stop offset="1" stop-color="{PALETTE['field_jade_deep']}"/>
    </linearGradient>
    <filter id="objectShadow" x="-24%" y="-16%" width="148%" height="144%">
      <feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="{PALETTE['field_jade_dark']}" flood-opacity=".22"/>
    </filter>
  </defs>
  <rect x="22" y="22" width="980" height="980" rx="228" fill="url(#tile)"/>
  <rect x="27" y="27" width="970" height="970" rx="224" fill="none" stroke="{PALETTE['porcelain_shadow']}" stroke-opacity=".5" stroke-width="2"/>
  <g filter="url(#objectShadow)">
    <path d="M296 302L514 210V342L396 400V634L514 692V814L296 720Z" fill="{PALETTE['field_jade_dark']}"/>
    <path d="M514 210L732 326V706L514 814V692L624 634V400L514 342Z" fill="url(#rightPanel)"/>
    <path d="M396 400L514 342L624 400V634L514 692L396 634Z" fill="#F7FAF3"/>
    <path d="M514 210V342M514 692V814" stroke="#DCEBE2" stroke-opacity=".32" stroke-width="3"/>
    <path d="M444 492L514 422L596 520L536 586" fill="none" stroke="{PALETTE['field_jade_deep']}" stroke-width="38" stroke-linecap="square" stroke-linejoin="round"/>
    <path d="M732 326V706L514 814" fill="none" stroke="#FFFFFF" stroke-opacity=".2" stroke-width="5"/>
  </g>
</svg>
'''
    (BRAND / 'icon-mark.svg').write_text(icon_svg, encoding='utf-8')
    (MOBILE_PUBLIC / 'icon.svg').write_text(icon_svg, encoding='utf-8')

    lockup = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 240">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{PALETTE['porcelain']}"/>
      <stop offset="1" stop-color="{PALETTE['jade_mist']}"/>
    </linearGradient>
    <linearGradient id="rightPanel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#647D70"/>
      <stop offset="1" stop-color="{PALETTE['field_jade_deep']}"/>
    </linearGradient>
  </defs>
  <rect width="880" height="240" rx="36" fill="url(#bg)"/>
  <rect x="28" y="28" width="184" height="184" rx="44" fill="#FFFDF6" stroke="{PALETTE['porcelain_shadow']}"/>
  <path d="M74 74L120 54V84L96 96V144L120 156V184L74 164Z" fill="{PALETTE['field_jade_dark']}"/>
  <path d="M120 54L166 78V160L120 184V156L144 144V96L120 84Z" fill="url(#rightPanel)"/>
  <path d="M96 96L120 84L144 96V144L120 156L96 144Z" fill="#F7FAF3"/>
  <path d="M106 116L120 102L138 123L125 136" fill="none" stroke="{PALETTE['field_jade_deep']}" stroke-width="8" stroke-linejoin="round"/>
  <text x="252" y="98" fill="{PALETTE['field_jade_dark']}" font-family="system-ui, sans-serif" font-size="58" font-weight="700">玄圃</text>
  <text x="254" y="147" fill="{PALETTE['field_jade_deep']}" font-family="SFMono-Regular, Menlo, monospace" font-size="25">Xuanpu Workbench</text>
  <text x="254" y="184" fill="{PALETTE['muted']}" font-family="system-ui, sans-serif" font-size="22">AI-native field context for coding agents</text>
</svg>
'''
    (BRAND / 'lockup-horizontal.svg').write_text(lockup, encoding='utf-8')


def write_metadata() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    (BRAND / 'palette.json').write_text(json.dumps(PALETTE, indent=2) + '\n', encoding='utf-8')


def main() -> None:
    source_icon = sync_icon_source()
    icon = apply_final_icon_mask(source_icon)
    make_svg_assets()
    make_banner(icon)
    make_dmg_background(icon)
    make_onboarding_backgrounds()
    make_social_preview(icon)
    make_docs_icons(icon)
    write_metadata()
    print('Generated Xuanpu brand assets:')
    print('  - resources/icon-source.png')
    print('  - resources/brand/v11/final/icon-source.png')
    print('  - resources/banner.png')
    print('  - resources/dmg-background.png')
    print('  - resources/dmg-background@2x.png')
    print('  - src/renderer/src/assets/onboarding-bg.png')
    print('  - src/renderer/src/assets/onboarding-bg-dark.png')
    print('  - docs/social-preview.png')
    print('  - docs/icon.png')
    print('  - docs/apple-touch-icon.png')
    print('  - docs/favicon.ico')
    print('  - mobile/public/icon.svg')
    print('  - resources/brand/icon-mark.svg')
    print('  - resources/brand/lockup-horizontal.svg')
    print('  - resources/brand/palette.json')


if __name__ == '__main__':
    main()
