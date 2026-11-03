#!/usr/bin/env python3

from pathlib import Path
import math

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "fjord.gif"

WIDTH = 240
HEIGHT = 72
SCALE = 4
FRAMES = 16
HORIZON = 42

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
    for _ in range(4):
        total += amplitude * value_noise(x * frequency, seed)
        norm += amplitude
        amplitude *= 0.5
        frequency *= 2.05
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
    if t < 0.7:
        return lerp_color((42, 48, 58), (108, 118, 130), t / 0.7)
    return lerp_color((108, 118, 130), (186, 196, 206), (t - 0.7) / 0.3)


def near_top(x):
    jag = (fbm(x * 0.12, 4) - 0.5) * 3.0
    if x < 72:
        t = x / 72.0
        drop = 0.0 if t < 0.7 else ((t - 0.7) / 0.3) ** 1.2
        return 14 + t * 4 + drop * 22 + jag
    if x > 168:
        t = (x - 168) / float(WIDTH - 168)
        if t < 0.28:
            return 16 + (1.0 - t / 0.28) * 22 + jag
        return 15 + (fbm(x * 0.14, 8) - 0.5) * 3
    return HORIZON + 8


def far_top(x):
    span = abs(x - 120) / 28.0
    if span >= 1.0:
        return HORIZON + 6
    ridge = (fbm(x * 0.16, 17) - 0.5) * 3
    return 26 + (span**1.35) * 14 + ridge


def shore_x(y, side):
    t = (y - HORIZON) / float(HEIGHT - 1 - HORIZON)
    if side < 0:
        return lerp(78, 28, t)
    return lerp(162, 212, t)


def in_water(x, y):
    if y < HORIZON:
        return False
    return shore_x(y, -1) < x < shore_x(y, 1)


def draw_sky(buf):
    for y in range(HEIGHT):
        color = sky_color(min(y, HORIZON))
        for x in range(WIDTH):
            put(buf, x, y, color)


def draw_cloud(buf, cx, cy, rx, ry, color, frame):
    travel = (cx + WIDTH * frame / FRAMES) % WIDTH
    for y in range(int(cy - ry), int(cy + ry) + 1):
        for dx in range(int(-rx), int(rx) + 1):
            x = int(travel + dx) % WIDTH
            nx = dx / rx
            ny = (y - cy) / ry
            dist = nx * nx + ny * ny
            if dist > 1.0:
                continue
            mix(buf, x, y, color, 0.28 + 0.35 * (1.0 - dist))


def draw_clouds(buf, frame):
    draw_cloud(buf, 46, 10, 16, 3.2, (214, 220, 226), frame)
    draw_cloud(buf, 168, 14, 12, 2.6, (200, 208, 216), frame)


def rock_color(x, y, top, kind):
    shade = 0.86 + 0.14 * fbm(x * 0.08, 30)
    if kind == "near":
        shadow = (28, 36, 48)
        body = (62, 74, 88)
    else:
        shadow = (96, 108, 122)
        body = (148, 160, 172)
    color = lerp_color(shadow, body, shade)
    if y == int(math.floor(top)) and top < (22 if kind == "near" else 30):
        color = lerp_color(color, (210, 216, 222), 0.55)
    return color


def fill_range(buf, top_fn, kind, x0, x1):
    for x in range(x0, x1):
        top = top_fn(x)
        start = int(math.floor(top))
        if start >= HORIZON:
            continue
        for y in range(max(0, start), HORIZON):
            put(buf, x, y, rock_color(x, y, start, kind))


def draw_foreground(buf):
    for y in range(HORIZON, HEIGHT):
        left = shore_x(y, -1)
        right = shore_x(y, 1)
        for x in range(WIDTH):
            if left < x < right:
                continue
            edge = min(abs(x - left), abs(x - right))
            t = clamp(edge / 40.0, 0.0, 1.0)
            put(buf, x, y, lerp_color((16, 22, 30), (52, 64, 78), 1.0 - t * 0.45))


def draw_water(buf, frame):
    phase = 2 * math.pi * frame / FRAMES
    for y in range(HORIZON, HEIGHT):
        dy = y - HORIZON
        wave = math.sin(y * 0.45 + phase) * 0.8
        for x in range(WIDTH):
            if not in_water(x, y):
                continue
            src_y = HORIZON - 1 - int(dy * 0.55)
            src = get(buf, int(x + wave), src_y)
            depth = dy / float(HEIGHT - HORIZON)
            reflected = (
                int(src[0] * 0.16 + 12),
                int(src[1] * 0.18 + 18),
                int(src[2] * 0.28 + 30),
            )
            color = lerp_color((8, 12, 18), reflected, 0.55 - 0.2 * depth)
            glint = math.sin(y * 0.9 + phase)
            if glint > 0.93 and unit_random(x // 3 + y, 21) > 0.72:
                color = lerp_color(color, (120, 136, 150), 0.45)
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


def render_frame(frame):
    buf = bytearray(WIDTH * HEIGHT * 3)
    draw_sky(buf)
    draw_clouds(buf, frame)
    fill_range(buf, far_top, "far", 92, 148)
    fill_range(buf, near_top, "near", 0, WIDTH)
    draw_foreground(buf)
    draw_water(buf, frame)
    image = dither(buf)
    return image.resize((WIDTH * SCALE, HEIGHT * SCALE), Image.Resampling.NEAREST)


def main():
    frames = [render_frame(index) for index in range(FRAMES)]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=140,
        loop=0,
        optimize=True,
        disposal=2,
    )


if __name__ == "__main__":
    main()
