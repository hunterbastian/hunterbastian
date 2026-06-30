# Digital Forest

An interactive, procedurally generated forest that lives in your browser. Every
tree is grown from a recursive branching algorithm, the sky moves through a full
day/night cycle, and the world breathes with wind, drifting leaves, and fireflies
at dusk.

No build step, no dependencies — just open it.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd forest
python3 -m http.server 8000
# then visit http://localhost:8000
```

## What's inside

- **Procedural trees** — each tree is a recursive branch structure with its own
  seed, scale, hue, and wind phase. No two are alike.
- **Living day/night cycle** — an interpolated sky palette with sun, moon, stars,
  drifting mist, and atmospheric haze on distant trees.
- **Depth & parallax** — trees are placed across depth layers; far ones sit near
  the horizon, fade into the sky, and shift gently as you move the pointer.
- **Weather** — falling leaves and fireflies that wake up after dark.

## Play with it

- **Click anywhere** to grow a new tree. Click high (near the horizon) for distant
  trees, low for big foreground ones.
- **Time of day** slider scrubs through dawn → midday → dusk → night, or let
  *auto day / night* run the cycle for you.
- **Wind**, **density**, and **falling leaves** are all live.
- **Plant a grove** drops a burst of saplings; **reset** regenerates the whole
  world from a fresh seed.

Respects `prefers-reduced-motion`: animation calms down for those who ask for it.

### Deep links

Share a specific moment by appending `?t=` (a value from `0` to `1`) to the URL,
e.g. `index.html?t=0.5` opens at midday, `?t=0.27` at dawn. This pauses the
auto cycle so the scene holds still.

## How it works

Everything renders to a single `<canvas>`:

- `forest.js` — world state, a seeded RNG (mulberry32), tree generation, the
  celestial model, and the render loop.
- `style.css` — the glass control panel and overlays.
- `index.html` — markup and controls.
