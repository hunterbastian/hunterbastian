#!/usr/bin/env python3

from pathlib import Path
import math

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "fjord.gif"

WIDTH = 240
HEIGHT = 88
SCALE = 4
FRAMES = 16
HORIZON = 50

PALETTE = [
    (10, 14, 20),
    (18, 26, 36),
    (30, 42, 56),
    (46, 60, 76),
    (68, 82, 98),
    (96, 110, 124),
    (128, 142, 156),
    (166, 178, 190),
    (204, 214, 222),
    (236, 240, 244),
]


def clamp(value, low, high):
    return max(low, min(high, value))


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(a, b, t):
    t = clamp(t, 0.0, 1.0)
    return tuple(int(lerp(a[i], b[i], t)) for i in range(3))


def unit_random(index, seed):
    n = (int(index) * 374761393 + seed * 668265263) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return (n & 0xFFFFFF) / float(0xFFFFFF)


def value_noise(x, seed):
    i = math.floor(x)
    f = x - i
    u = f * f * (3.0 - 2.0 * f)
    return lerp(unit_random(i, seed), unit_random(i + 1, seed), u)


def fbm(x, seed):
    total = 0.0
    amplitude = 0.5
    frequency = 1.0
    norm = 0.0
    for _ in range(5):
        total += amplitude * value_noise(x * frequency, seed)
        norm += amplitude
        amplitude *= 0.5
        frequency *= 2.07
    return total / norm


def put(buf, x, y, color):
    if 0 <= x < WIDTH and 0 <= y < HEIGHT:
        i = (y * WIDTH + x) * 3
        buf[i] = color[0]
        buf[i + 1] = color[1]
        buf[i + 2] = color[2]


def get(buf, x, y):
    x = clamp(x, 0, WIDTH - 1)
    y = clamp(y, 0, HEIGHT - 1)
    i = (y * WIDTH + x) * 3
    return (buf[i], buf[i + 1], buf[i + 2])


def mix(buf, x, y, color, alpha):
    if 0 <= x < WIDTH and 0 <= y < HEIGHT:
        put(buf, x, y, lerp_color(get(buf, x, y), color, alpha))


def sky_color(y):
    t = y / float(HORIZON)
    if t < 0.55:
        return lerp_color((52, 60, 72), (118, 130, 144), t / 0.55)
    return lerp_color((118, 130, 144), (198, 208, 216), (t - 0.55) / 0.45)


def near_top(x):
    jag = (fbm(x * 0.17, 4) - 0.5) * 5.5 + (fbm(x * 0.46, 9) - 0.5) * 2.2
    if x < 86:
        t = x / 86.0
        drop = 0.0 if t < 0.78 else ((t - 0.78) / 0.22) ** 1.15
        return 4 + t * 6 + drop * 36 + jag
    if x > 154:
        t = (x - 154) / float(WIDTH - 154)
        if t < 0.24:
            return 8 + (1.0 - t / 0.24) * 34 + jag
        return 7 + (fbm(x * 0.18, 4) - 0.5) * 5
    return HORIZON + 12


def far_top(x):
    span = abs(x - 120) / 42.0
    if span >= 1.0:
        return HORIZON + 8
    ridge = (fbm(x * 0.21, 17) - 0.5) * 6
    return 18 + (span**1.2) * 26 + ridge


def shore_x(y, side):
    t = (y - HORIZON) / float(HEIGHT - 1 - HORIZON)
    jag = (fbm(y * 0.45, 6 if side < 0 else 13) - 0.5) * 3.2
    if side < 0:
        return lerp(84, 10, t) + jag
    return lerp(156, 230, t) + jag


def in_water(x, y):
    if y < HORIZON:
        return False
    return shore_x(y, -1) < x < shore_x(y, 1)


def draw_sky(buf):
    for y in range(HEIGHT):
        color = sky_color(min(y, HORIZON))
        for x in range(WIDTH):
            vignette = abs(x - WIDTH / 2) / (WIDTH / 2)
            put(buf, x, y, lerp_color(color, (36, 42, 52), vignette * 0.18))


def draw_cloud(buf, cx, cy, rx, ry, color, frame, loops):
    travel = (cx + loops * WIDTH * frame / FRAMES) % WIDTH
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for dx in range(int(-rx) - 1, int(rx) + 2):
            x = int(travel + dx) % WIDTH
            nx = dx / rx
            ny = (y - cy) / ry
            dist = nx * nx + ny * ny
            if dist > 1.0:
                continue
            if dist > 0.5 and unit_random(x * 19 + y * 7, 5) > 0.62:
                continue
            mix(buf, x, y, color, 0.42 + 0.4 * (1.0 - dist))


def draw_high_clouds(buf, frame):
    specs = (
        (24, 10, 20, 4.2, (228, 234, 238), 1),
        (70, 15, 12, 3.2, (210, 218, 226), 1),
        (132, 8, 16, 3.6, (232, 236, 240), 1),
        (188, 13, 22, 4.0, (220, 228, 234), 1),
    )
    for cx, cy, rx, ry, color, loops in specs:
        draw_cloud(buf, cx, cy, rx, ry, color, frame, loops)


def draw_valley_clouds(buf, frame):
    specs = (
        (104, 28, 14, 3.0, (186, 196, 206), 2),
        (138, 32, 18, 3.4, (176, 186, 198), 2),
    )
    for cx, cy, rx, ry, color, loops in specs:
        draw_cloud(buf, cx, cy, rx, ry, color, frame, loops)


def rock_color(x, y, top, kind):
    column = 0.78 + 0.22 * fbm(x * 0.13, 30)
    if kind == "near":
        shadow = (26, 34, 46)
        body = (58, 72, 86)
        lit = (104, 118, 132)
        snow_limit = 14
    else:
        shadow = (86, 100, 114)
        body = (132, 146, 158)
        lit = (176, 188, 198)
        snow_limit = 24
    light = clamp(column, 0.0, 1.0)
    if light < 0.5:
        color = lerp_color(shadow, body, light / 0.5)
    else:
        color = lerp_color(body, lit, (light - 0.5) / 0.5)
    if y % 6 == 0:
        color = lerp_color(color, shadow, 0.16)
    ridge = int(math.floor(top))
    if top < snow_limit and ridge <= y <= ridge + 1:
        color = (232, 236, 240)
    return color


def fill_range(buf, top_fn, kind, x0, x1, y_stop):
    for x in range(x0, x1):
        top = top_fn(x)
        start = int(math.floor(top))
        if start >= y_stop:
            continue
        for y in range(max(0, start), y_stop):
            put(buf, x, y, rock_color(x, y, start, kind))


def draw_horizon_mist(buf, frame):
    phase = 2 * math.pi * frame / FRAMES
    for y in range(HORIZON - 6, HORIZON + 1):
        band = 1.0 - abs(y - (HORIZON - 2)) / 6.0
        for x in range(WIDTH):
            wave = 0.5 + 0.5 * math.sin(x * 0.05 + phase)
            mix(buf, x, y, (206, 214, 220), 0.22 * band * wave)


def draw_foreground(buf):
    for y in range(HORIZON, HEIGHT):
        left = shore_x(y, -1)
        right = shore_x(y, 1)
        for x in range(WIDTH):
            if left < x < right:
                continue
            edge = min(abs(x - left), abs(x - right))
            t = clamp(edge / 34.0, 0.0, 1.0)
            color = lerp_color((18, 24, 32), (64, 78, 92), 1.0 - t * 0.65)
            if y % 4 == 0:
                color = lerp_color(color, (92, 104, 116), 0.28)
            tone = 0.92 + 0.08 * math.sin(x * 0.5)
            put(buf, x, y, tuple(clamp(int(c * tone), 0, 255) for c in color))


def draw_water(buf, frame):
    phase = 2 * math.pi * frame / FRAMES
    for y in range(HORIZON, HEIGHT):
        dy = y - HORIZON
        wave = math.sin(y * 0.55 + phase * 2.0) * 1.4
        for x in range(WIDTH):
            if not in_water(x, y):
                continue
            src_y = HORIZON - 1 - int(dy * 0.8)
            src = get(buf, int(x + wave), src_y)
            depth = dy / float(HEIGHT - HORIZON)
            reflected = (
                int(src[0] * 0.22 + 14),
                int(src[1] * 0.26 + 22),
                int(src[2] * 0.38 + 36),
            )
            color = lerp_color((8, 14, 22), reflected, 0.75 - 0.25 * depth)
            glint = math.sin(y * 1.15 + phase * 2.0)
            spark = math.sin(x * 0.21 + phase)
            if glint > 0.82 and spark > 0.15 and unit_random(x + y * 3, 21) > 0.35:
                color = lerp_color(color, (158, 176, 192), 0.7)
            put(buf, x, y, color)


def dither(buf):
    bayer = (
        (0, 8, 2, 10),
        (12, 4, 14, 6),
        (3, 11, 1, 9),
        (15, 7, 13, 5),
    )
    image = Image.new("P", (WIDTH, HEIGHT))
    image.putpalette([channel for color in PALETTE for channel in color] + [0] * (768 - len(PALETTE) * 3))
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            color = get(buf, x, y)
            ranked = []
            for index, swatch in enumerate(PALETTE):
                dist = (
                    (color[0] - swatch[0]) ** 2
                    + (color[1] - swatch[1]) ** 2
                    + (color[2] - swatch[2]) ** 2
                )
                ranked.append((dist, index))
            ranked.sort()
            nearest, second = ranked[0], ranked[1]
            mix_amount = nearest[0] / float(nearest[0] + second[0] + 1e-6)
            threshold = (bayer[y & 3][x & 3] + 0.5) / 16.0
            pixels[x, y] = second[1] if mix_amount > threshold else nearest[1]
    return image


def paint(pixels, x, y, color):
    if 0 <= x < WIDTH and 0 <= y < HEIGHT:
        pixels[x, y] = color


def stamp_boat(image, frame):
    pixels = image.load()
    bob = int(round(math.sin(2 * math.pi * frame / FRAMES)))
    ox = 98
    oy = 56 + bob
    mast = ox + 18
    for y in range(oy - 2, oy + 10):
        paint(pixels, mast, y, 8)
    for x in range(mast - 7, mast + 8):
        paint(pixels, x, oy + 1, 9)
    for y in range(oy + 2, oy + 7):
        for x in range(mast - 6, mast + 7):
            paint(pixels, x, y, 9 if x <= mast else 7)
        paint(pixels, mast - 7, y, 8)
        paint(pixels, mast + 7, y, 8)
    flick = 1 if math.sin(2 * math.pi * frame / FRAMES) >= 0 else -1
    paint(pixels, mast + flick, oy - 2, 9)
    paint(pixels, mast + 2 * flick, oy - 2, 8)
    for x in range(ox + 4, ox + 40):
        paint(pixels, x, oy + 9, 8)
    for x in range(ox + 5, ox + 39):
        paint(pixels, x, oy + 10, 6)
        paint(pixels, x, oy + 11, 5)
    for x in range(ox + 7, ox + 37):
        paint(pixels, x, oy + 12, 4)
    for index, x in enumerate(range(ox + 8, ox + 36, 3)):
        paint(pixels, x, oy + 10, 9 if index % 2 == 0 else 7)
    for dx, dy, color in (
        (3, 8, 8),
        (2, 7, 9),
        (2, 6, 8),
        (3, 6, 7),
        (40, 8, 8),
        (41, 7, 9),
        (42, 6, 9),
        (42, 5, 9),
        (41, 4, 8),
        (40, 4, 7),
    ):
        paint(pixels, ox + dx, oy + dy, color)
    for x in range(ox + 8, ox + 36):
        if (x + frame) % 2 == 0:
            paint(pixels, x, oy + 13, 3)


def render_frame(frame):
    buf = bytearray(WIDTH * HEIGHT * 3)
    draw_sky(buf)
    draw_high_clouds(buf, frame)
    fill_range(buf, far_top, "far", 78, 164, HORIZON)
    draw_valley_clouds(buf, frame)
    fill_range(buf, near_top, "near", 0, WIDTH, HORIZON)
    draw_horizon_mist(buf, frame)
    draw_foreground(buf)
    draw_water(buf, frame)
    image = dither(buf)
    stamp_boat(image, frame)
    return image.resize((WIDTH * SCALE, HEIGHT * SCALE), Image.Resampling.NEAREST)


def main():
    frames = [render_frame(index) for index in range(FRAMES)]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=130,
        loop=0,
        optimize=True,
        disposal=2,
    )


if __name__ == "__main__":
    main()
