# High Seas

A little retro-fantasy sailing game, built to feel great on an iPhone: drag
your thumb to steer a pixel sailboat across an enchanted, living sea — dodge
cursed reefs and sea serpents, plunder gold and treasure chests, and try to
outlast the next conjured storm.

No build step, no dependencies, no images — just open it. Everything (boat,
waves, reefs, serpents, gold) is drawn on a single `<canvas>`, then rendered
through a real pixelation pipeline for a chunky, 16-bit-console look. Two
self-hosted, open-licensed fonts round out the retro-RPG feel — see
[Fonts](#fonts) below.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd boat
python3 -m http.server 8000
# then visit http://localhost:8000
```

### On an iPhone

Visit the page in Safari, tap the Share icon, and choose **Add to Home
Screen**. It launches full-screen with no browser chrome, just like a real
app icon.

## Play with it

- **Drag anywhere** on the sea to steer — the boat follows your finger,
  offset from wherever you first touched so it never jumps.
- Arrow keys (or `A` / `D`) work too, for testing on a desktop.
- **Reefs** and **sea serpents** end the run on contact — but a close,
  unscathed pass earns a "close call" bonus.
- **Gold doubloons**, **treasure chests**, and **leaping fish** add to your
  score.
- The sea gets faster the longer you survive, and **storms** roll through
  periodically: darker skies, rain, a rockier sea, and a crosswind that
  nudges your heading.
- Your best distance is saved on-device and shown in the HUD.

## Deep links

Handy for development and screenshots:

- `?seed=1234` — reproduce the exact same run (obstacle and pickup layout).
- `?autostart=1` — skip the "Set Sail" screen and start immediately.
- `?demo=1` — a simple autopilot steers the boat, useful for hands-free demos.

Combine them, e.g. `index.html?seed=1&autostart=1&demo=1`.

## How it works

- `boat.js` — a seeded RNG (mulberry32), the boat's steering and physics,
  wave rendering, obstacle/pickup spawning and collision, a tiny particle
  system, procedural WebAudio sound effects, and the render loop. Everything
  draws to a small offscreen canvas which is then blown back up onto the
  visible canvas with smoothing disabled — that's the whole trick behind the
  chunky retro-pixel look (see `PIXEL_SCALE` in `boat.js`).
- `style.css` — the HUD, menu, and game-over cards, styled as stepped-corner
  "cut corner" pixel-art dialog boxes (parchment, wood, and gold) with a
  faint CRT scanline overlay.
- `index.html` — markup, the canvas, and the mobile/iPhone meta tags (safe
  areas, home-screen icon, full-screen web-app mode).

## Fonts

Two self-hosted, offline-friendly fonts live in `fonts/`, both licensed under
the [SIL Open Font License](https://scripts.sil.org/OFL):

- **Press Start 2P** — the pixel-arcade font used for the HUD, buttons, and
  score pop-ups.
- **Pirata One** — the fantasy display font used for the title and body copy.

See `fonts/OFL-PressStart2P.txt` and `fonts/OFL-PirataOne.txt` for the full
license text and attribution.
