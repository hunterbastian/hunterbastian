# Profile assets

The profile README is a banner, one line, three project cards, and a row of links. Regenerate the images from the repo root.

## Banner

`assets/fjord.gif` is original dithered pixel art of a quiet fjord: open sky, two cliff walls, a low distant peak, two drifting clouds, and a slow shimmer on the water. It is 960×288, 16 frames, ordered Bayer dither, in a cool silver and blue-gray palette.

```bash
pip install pillow
python3 scripts/render_fjord.py
```

## Cards

`assets/cards/` holds one card per featured repository. Language, star count, and `updated_at` were read from the GitHub API on 2026-11-03:

| Repository | Language | Stars | Updated |
| --- | --- | --- | --- |
| [akari-online](https://github.com/hunterbastian/akari-online) | GDScript | 1 | 2026-11-03 |
| [portfolio](https://github.com/hunterbastian/portfolio) | TypeScript | 1 | 2026-11-03 |
| [mountain-render](https://github.com/hunterbastian/mountain-render) | Python | 0 | 2026-08-21 |

`portfolio` has no GitHub description. Its card uses the opening line of that repository's README. `akari-online` and `mountain-render` use their GitHub descriptions. The portfolio card links to [hunterbastian.com](https://hunterbastian.com). The other cards link to their repositories.

```bash
python3 scripts/render_cards.py
```

Cards use JetBrains Mono, which the script expects at `/usr/share/fonts/truetype/jetbrains-mono/`.

## Earlier headers

Older ASCII Magic headers are still in `assets/` and credited in `CREDITS.md`. The profile README no longer uses them.
