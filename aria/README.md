# Aria

**Aria** is an interactive, procedurally generated little world that lives in your
browser, with a soft, Studio Ghibli–influenced aesthetic. It's **one little world
you can scroll around in**: drag, scroll, or use the arrow keys to wander across a
diorama that's wider than your screen, with depth parallax across every layer.
Every tree is grown from a recursive branching algorithm, big fluffy clouds drift
over lush rolling hills, the sky moves through a full day/night cycle, and the
world breathes with wind, swaying grass, drifting leaves, fireflies, and little
kodama spirits. The interface leans warm and editorial — a Bodoni wordmark,
cream "paper" controls, and terracotta/olive accents (a Mediterranean palette to
match the name).

No build step and no JavaScript dependencies — just open it. It does pull two web
fonts (Bodoni Moda + Inter) from Google Fonts for the lettering, and falls back to
system serif/sans gracefully when offline.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd aria
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy (Vercel)

Aria is a self-contained static site, so no build step is needed.

**Dashboard (recommended):** import the repo at [vercel.com/new](https://vercel.com/new),
then set **Root Directory → `aria`** and **Framework Preset → Other**. Deploy.
Once the repo is connected, Vercel publishes a preview URL for every branch/PR and
a production URL from `main`.

**CLI:**

```bash
cd aria
npx vercel        # preview deploy
npx vercel --prod # production deploy
```

The included `vercel.json` enables clean URLs and sensible caching.

## What's inside

- **Procedural trees** — each tree is a recursive branch structure with its own
  seed, scale, hue, and wind phase, with soft sun-side canopy highlights. No two
  are alike.
- **Ghibli skies** — vivid cerulean days and warm peach golden hours, with big
  billowing cumulus clouds that drift on the wind and catch warm light at sunset.
- **Lush rolling hills** — layered green hills, hazier toward the horizon, over a
  soft meadow ground plane.
- **Living day/night cycle** — an interpolated sky palette with sun, moon, stars,
  drifting mist, sun bloom, and atmospheric haze on distant trees.
- **Depth & parallax** — trees are placed across depth layers; far ones sit near
  the horizon, fade into the sky, and shift gently as you move the pointer.
- **Life everywhere** — swaying foreground grass, falling leaves, fireflies after
  dark, and **kodama** forest spirits that bob, turn their heads, and glow softly
  in low light.

## Play with it

- **Drag / scroll / arrow keys** to roam the little world. It pans with momentum,
  parallax gives it depth, and soft shadows hint when you reach the edges.
- **Tap (or click)** to grow a new tree at that spot. Aim high (near the horizon)
  for distant trees, low for big foreground ones.
- **Time of day** slider scrubs through dawn → midday → dusk → night, or let
  *auto day / night* run the cycle for you.
- **Wind**, **density**, **falling leaves**, and **forest spirits** are all live.
- **Plant a grove** drops a burst of saplings; **reset** regenerates the whole
  world from a fresh seed.

Respects `prefers-reduced-motion`: animation calms down for those who ask for it.

## Mobile

Aria is built to feel native on phones, not just shrunk down:

- **Touch-first** — tap to grow trees; bigger, easier-to-hit sliders and toggles
  on touch devices.
- **Bottom-sheet controls** — on phones the panel docks to the bottom and starts
  collapsed (tap *controls* to open), respecting the safe-area inset.
- **Lighter render profile** — on small screens it caps the pixel ratio, thins out
  grass, clouds, leaves, fireflies, and spirits, and trims tree branch depth so
  the scene stays smooth on mobile GPUs.
- **Viewport-aware** — handles orientation changes, the iOS/Android URL-bar resize
  (via `visualViewport`), and pauses rendering when the tab is backgrounded to
  save battery.

### Deep links

Share a specific moment by appending `?t=` (a value from `0` to `1`) to the URL,
e.g. `index.html?t=0.5` opens at midday, `?t=0.27` at dawn. This pauses the
auto cycle so the scene holds still.

Share a specific spot in the world with `?cam=` (`0` = far left, `1` = far right),
and combine them: `index.html?t=0.73&cam=0.4`.

## How it works

Everything renders to a single `<canvas>`:

- `aria.js` — world state, a seeded RNG (mulberry32), tree generation, the
  camera/parallax, the celestial model, and the render loop.
- `style.css` — the glass control panel and overlays.
- `index.html` — markup and controls.
