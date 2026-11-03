#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = Path("/usr/share/fonts/truetype/jetbrains-mono")
SCALE = 2

BG = (14, 16, 22)
PANEL = (22, 28, 36)
LINE = (54, 62, 74)
TEXT = (236, 240, 244)
MUTED = (176, 186, 196)
FAINT = (122, 140, 156)
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


def new_canvas(width, height):
    image = Image.new("RGB", (px(width), px(height)), BG)
    draw = ImageDraw.Draw(image)
    return image, draw


def border(draw, width, height):
    draw.rectangle((0, 0, px(width) - 1, px(height) - 1), outline=LINE)


def profile_card():
    width, height = 880, 228
    image, draw = new_canvas(width, height)
    draw.rectangle((0, 0, px(width), px(40)), fill=PANEL)
    draw.line((0, px(40), px(width), px(40)), fill=LINE, width=SCALE)
    draw.text((px(16), px(26)), "hunter", font=font("Medium", 15), fill=SILVER, anchor="ls")
    draw.rectangle((px(92), px(16), px(98), px(22)), fill=SILVER)
    draw.text((px(108), px(26)), "studio cala", font=font("Regular", 13), fill=MUTED, anchor="ls")
    draw.text((px(width - 16), px(26)), "github.com/hunterbastian", font=font("Regular", 12), fill=FAINT, anchor="rs")

    draw.line((px(560), px(40), px(560), px(height)), fill=LINE, width=SCALE)
    draw.text((px(24), px(86)), "Hunter Bastian", font=font("SemiBold", 28), fill=TEXT, anchor="ls")
    draw.text((px(24), px(116)), "design engineer", font=font("Regular", 16), fill=MUTED, anchor="ls")

    links = (
        ("site", "hunterbastian.com"),
        ("x", "x.com/hunterbastianux"),
        ("email", "hunterbastianux@gmail.com"),
        ("linkedin", "linkedin.com/in/hunterbastian"),
    )
    label_font = font("Regular", 12)
    value_font = font("Regular", 14)
    for index, (label, value) in enumerate(links):
        y = 156 + index * 16
        draw.text((px(24), px(y)), label, font=label_font, fill=FAINT, anchor="ls")
        draw.text((px(104), px(y)), value, font=value_font, fill=TEXT, anchor="ls")

    facts = (("location", "Lehi, UT"), ("studio", "Cala"))
    for index, (label, value) in enumerate(facts):
        top = 40 + index * 94
        if index:
            draw.line((px(560), px(top), px(width), px(top)), fill=LINE, width=SCALE)
        draw.text((px(584), px(top + 28)), label, font=font("Regular", 12), fill=FAINT, anchor="ls")
        draw.text((px(584), px(top + 58)), value, font=font("Medium", 20), fill=TEXT, anchor="ls")

    border(draw, width, height)
    return image


def project_card(project):
    width, height = 300, 248
    image, draw = new_canvas(width, height)
    draw.rectangle((0, 0, px(width), px(36)), fill=PANEL)
    draw.line((0, px(36), px(width), px(36)), fill=LINE, width=SCALE)
    draw.text((px(14), px(24)), project["name"], font=font("Medium", 14), fill=TEXT, anchor="ls")
    draw.text(
        (px(width - 12), px(24)),
        f"updated {project['updated']}",
        font=font("Regular", 11),
        fill=FAINT,
        anchor="rs",
    )

    body = font("Regular", 13)
    lines = wrap_lines(project["description"], body, px(272), 3)
    for index, line in enumerate(lines):
        draw.text((px(14), px(64 + index * 20)), line, font=body, fill=MUTED, anchor="ls")

    draw.line((0, px(132), px(width), px(132)), fill=LINE, width=SCALE)
    columns = (
        (14, "Language", project["language"]),
        (118, "Stars", project["stars"]),
        (196, "Updated", project["updated"]),
    )
    for x, label, value in columns:
        draw.text((px(x), px(154)), label, font=font("Regular", 11), fill=FAINT, anchor="ls")
        draw.text((px(x), px(176)), value, font=font("Medium", 13), fill=TEXT, anchor="ls")
    draw.line((px(106), px(132), px(106), px(196)), fill=LINE, width=SCALE)
    draw.line((px(184), px(132), px(184), px(196)), fill=LINE, width=SCALE)
    draw.line((0, px(196), px(width), px(196)), fill=LINE, width=SCALE)

    label = font("Medium", 12)
    button = project["button"]
    button_width = int(label.getlength(button) / SCALE) + 28
    button_x = width - 12 - button_width
    button_y = 210
    draw.rectangle(
        (px(button_x), px(button_y), px(button_x + button_width), px(button_y + 26)),
        fill=SILVER,
    )
    draw.text(
        (px(button_x + button_width / 2), px(button_y + 13)),
        button,
        font=label,
        fill=INK,
        anchor="mm",
    )
    border(draw, width, height)
    return image


def link_button(label):
    width, height = 220, 56
    image, draw = new_canvas(width, height)
    draw.text((px(16), px(34)), f"{label} ↗", font=font("Medium", 15), fill=SILVER, anchor="ls")
    border(draw, width, height)
    return image


def main():
    cards = ROOT / "assets" / "cards"
    cards.mkdir(parents=True, exist_ok=True)
    profile_card().save(ROOT / "assets" / "profile-card.png", optimize=True)
    for project in PROJECTS:
        project_card(project).save(cards / project["file"], optimize=True)
    for label in ("site", "x", "email", "linkedin"):
        link_button(label).save(cards / f"link-{label}.png", optimize=True)


if __name__ == "__main__":
    main()
