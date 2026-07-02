# High Seas

A little endless sailing game, built to feel great on an iPhone: drag your
thumb to steer a small sailboat across an open, living sea — dodge rocks and
mines, scoop up coins, bottles, and leaping fish, and try to outlast the next
storm.

No build step, no dependencies, no images — just open it. Everything (boat,
waves, rocks, coins, rain) is drawn on a single `<canvas>`.

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
- **Rocks** and **mines** end the run on contact — but a close, unscathed pass
  earns a "close call" bonus.
- **Coins**, **message bottles**, and **leaping fish** add to your score.
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
  system, procedural WebAudio sound effects, and the render loop.
- `style.css` — the HUD, menu, and game-over cards.
- `index.html` — markup, the canvas, and the mobile/iPhone meta tags (safe
  areas, home-screen icon, full-screen web-app mode).
