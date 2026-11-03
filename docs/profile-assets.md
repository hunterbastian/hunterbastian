# Profile assets

The GitHub profile README is a silver, near-black layout: an animated fjord banner, a terminal card, and three project cards. Regenerate the images from the repo root.

## Banner

`assets/fjord.gif` is original dithered pixel art of a Norwegian fjord: cliff walls, a distant peak, drifting clouds, shimmering water, and a small longship. It is 960×352, 16 frames, ordered Bayer dither, in a cool silver and blue-gray palette.

```bash
pip install pillow
python3 scripts/render_fjord.py
```

## Cards

`assets/profile-card.png` is the terminal card. `assets/cards/` holds one card per featured repository, plus the site, X, email, and LinkedIn buttons. The card script is the source for the labels.

Repository language, star count, and `updated_at` were read from the GitHub API on 2026-11-03:

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
