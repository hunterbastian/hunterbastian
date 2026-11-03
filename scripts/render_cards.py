#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = Path("/usr/share/fonts/truetype/jetbrains-mono")
SCALE = 2

BG = (14, 16, 22)
LINE = (54, 62, 74)
TEXT = (232, 236, 240)
MUTED = (168, 178, 188)
FAINT = (122, 134, 146)
SILVER = (214, 220, 228)
INK = (14, 16, 22)

PROJECTS = (
    {
        "name": "akari-online",
        "description": "MMO space exploration and trading sim. Built with React · Three.js",
        "language": "GDScript",
        "stars": "1",
        "updated": "Nov 03",
        "button": "View source",
        "file": "akari-online.png",
    },
    {
        "name": "portfolio",
        "description": "Minimal personal portfolio site built with Next.js, React, and TypeScript.",
        "language": "TypeScript",
        "stars": "1",
        "updated": "Nov 03",
        "button": "Visit site",
        "file": "portfolio.png",
    },
    {
        "name": "mountain-render",
        "description": "An Alpine Silver PS2-era procedural mountain study.",
        "language": "Python",
        "stars": "0",
        "updated": "Aug 21",
        "button": "View source",
        "file": "mountain-render.png",
    },
)


def font(weight, size):
    return ImageFont.truetype(str(FONT_DIR / f"JetBrainsMono-{weight}.ttf"), size * SCALE)


def px(value):
    return value * SCALE


def wrap_lines(text, face, max_width, max_lines):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if face.getlength(trial) <= max_width:
            current = trial
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    if len(lines) <= max_lines:
        return lines
    kept = lines[:max_lines]
    last = kept[-1]
    while last and face.getlength(f"{last}…") > max_width:
        last = last[:-1]
    kept[-1] = f"{last.rstrip()}…"
    return kept


def project_card(project):
    width, height = 280, 172
    image = Image.new("RGB", (px(width), px(height)), BG)
    draw = ImageDraw.Draw(image)
    draw.text((px(16), px(28)), project["name"], font=font("Medium", 14), fill=TEXT, anchor="ls")
    body = font("Regular", 12)
    lines = wrap_lines(project["description"], body, px(248), 3)
    for index, line in enumerate(lines):
        draw.text((px(16), px(52 + index * 18)), line, font=body, fill=MUTED, anchor="ls")
    star_label = "star" if project["stars"] == "1" else "stars"
    meta = f"{project['language']}  ·  {project['stars']} {star_label}  ·  {project['updated']}"
    draw.text((px(16), px(116)), meta, font=font("Regular", 11), fill=FAINT, anchor="ls")
    label = font("Medium", 11)
    button = project["button"]
    button_width = int(label.getlength(button) / SCALE) + 22
    button_x = width - 16 - button_width
    button_y = 132
    draw.rectangle(
        (px(button_x), px(button_y), px(button_x + button_width), px(button_y + 24)),
        fill=SILVER,
    )
    draw.text(
        (px(button_x + button_width / 2), px(button_y + 12)),
        button,
        font=label,
        fill=INK,
        anchor="mm",
    )
    draw.rectangle((0, 0, px(width) - 1, px(height) - 1), outline=LINE)
    return image


def main():
    cards = ROOT / "assets" / "cards"
    cards.mkdir(parents=True, exist_ok=True)
    for project in PROJECTS:
        project_card(project).save(cards / project["file"], optimize=True)


if __name__ == "__main__":
    main()
