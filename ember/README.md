# ember

A very small pixel game about a small light walking a dark path.

Your ember walks the path on its own and gathers **warmth**, even while the page
is closed. Every so often something is waiting on the path ahead: a moth, a
firefly, an owl. Each one is a short turn-based encounter where you dodge its
attacks inside a box. You can fight it, or calm it down until you can part ways.

- **Spare it** and it follows your light, adding warmth every second from then on.
- **Strike it down** and you get one burst of warmth, and it's gone.

Spend warmth at the **campfire** on upgrades. After the owl, the path loops
into the next night with tougher creatures that give more warmth.

No build step and no dependencies, not even a web font. Just open it.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd ember
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

| | keyboard | touch |
| --- | --- | --- |
| choose | arrow keys / WASD | tap an option |
| confirm, advance text | Z / Enter / Space | tap |
| back | X / Shift / Esc | tap the open option again |
| move while dodging | arrow keys / WASD | drag anywhere |
| move carefully | hold X or Shift | — |
| sound on / off | M | speaker icon, top right |

## How to play

**On the path:** `approach` lights up when you reach the next creature.
`campfire` lists the upgrades, and `friends` shows who is following you and how
much warmth each one adds.

**In an encounter**, pick one action each turn:

- **strike**: a line sweeps across the box. Stop it near the center to hit harder.
- **talk**: each creature has its own four options. Some calm it right away;
  others only work once it's already a little calm. Try `check` first.
- **mend**: heal half your hp. You get three per fight, plus campfire upgrades.
- **part**: leave. This only works once the creature doesn't want to fight
  anymore. When that happens, its name and `part` turn amber.

If your light goes out, you wake up at the campfire. You keep your warmth and
friends, and the creature is still waiting.

**Campfire upgrades:**

| upgrade | effect |
| --- | --- |
| hearth | +0.5 warmth / s |
| kindling | +4 max hp |
| spare wick | +1 mend each fight |
| soft glow | talking calms more |
| steady hand | slower strike line |
| long stride | walk faster |

Warmth keeps adding up while the page is closed, for up to 8 hours. Progress
is saved in your browser's local storage. To reset it, choose `start over` on
the title screen.

Respects `prefers-reduced-motion`: no screen shake, steadier flicker, and less
jitter.

## How it works

Everything is laid out in 480 × 420 logical units and drawn straight onto a
240 × 210 pixel grid, which is then scaled up with hard edges. The pixel art
follows a few rules:

- **No anti-aliasing.** The moth, firefly and owl are described as curves,
  then rasterized onto the pixel grid by a small built-in "pixel pen":
  one-pixel outlines with doubled corner pixels removed, flat fills, and
  mirrored halves that come out exactly symmetric. Each animation frame is
  baked once into a sprite (three wing frames, lantern on/off, four owl
  moods) and reused.
- **One pixel size.** Large text and the big title ember are enlarged with
  Scale2x (EPX), which rounds off diagonals, so nothing turns into chunky
  blocks next to finer detail. Small sprites, bullets and the 5 × 7 font are
  hand-placed bitmaps in the code.
- **Stepped light.** Glows fall off in flat bands with a little Bayer dither
  only where two bands meet, and they move in whole pixels so they don't
  shimmer.
- **An 11-color palette.** Shadows lean cool, the ember is warm, and the
  firefly has its own green. Anything left over, such as fades, is snapped to
  the palette with 4 × 4 ordered dithering.

Open `index.html#sprites` to see every sprite and frame on one screen.

- `ember.js` — the font, sprites and pixel pen, the save and offline-warmth
  logic, the creatures and their attack patterns, a fixed-timestep loop
  (60 ticks/s), and all the drawing. Sound is synthesized with the Web Audio API.
- `style.css` — centers the canvas, keeps its pixels sharp, and turns off page
  scrolling while you drag.
- `index.html` — the canvas plus a screen-reader live region that mirrors the
  on-screen text.

`window.ember` exposes the game state (`ember.save` is your progress), if you
want to poke at it from the console.

## Smoke test

`smoke-test.mjs` plays through the loop with scripted key presses. It spares
the moth, buys an upgrade, strikes down the firefly, and loses to the owl. Then
it checks that warmth built up while the page was closed. It saves screenshots
and fails on any page error. It needs Playwright with Chromium:

```bash
cd ember
node smoke-test.mjs
```
