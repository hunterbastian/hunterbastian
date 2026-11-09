# ember

A very small game about a small light walking north.

Long ago the first hearth kept the north warm. One winter it went out, and the
cold came down the mountain. You are its last ember, walking back up the road
to light it again.

Your ember walks on its own and gathers **warmth**, even while the page is
closed. Every so often something is waiting on the road ahead: a moth, a
firefly, an old frost dragon. Each one is a short turn-based encounter where
you dodge its attacks inside a box. You can fight it, or calm it down until you
can part ways.

- **Spare it** and it follows your light, adding warmth every second from then on.
- **Strike it down** and you get one burst of warmth, and it's gone.

Spend warmth at the **campfire** on upgrades. The road runs through five
regions to the hearth, and **runestones** along it tell what happened here.

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
| ASCII or pixel view | V | `@` icon, top right |

## How to play

**On the road:** `ahead` lights up when you reach whatever is waiting. `camp`
lists the campfire upgrades, `friends` shows who is following you and how much
warmth each one adds, and `saga` holds the runestones you've read.

**In an encounter**, pick one action each turn:

- **strike**: a line sweeps across the box. Stop it near the center to hit harder.
- **talk**: each creature has its own four options. Some calm it right away;
  others only work once it's already a little calm. Try `check` first.
- **mend**: heal half your hp. You get three per fight, plus campfire upgrades.
- **part**: leave. This only works once the creature doesn't want to fight
  anymore. When that happens, its name and `part` turn amber.

Under each creature's name, **five runes** show how calm it is. They light up
teal as it calms and all turn amber once it's ready to part ways.

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

## The world

The road north has five regions. Each lasts one night (three encounters) and
has its own scenery and weather, on the road and behind every fight.

| night | region | what's there |
| --- | --- | --- |
| 1 | the ashwood | snowy pines grown on the hearth's old ash |
| 2 | the cairnfield | standing stones and cairns, one for every torch that failed |
| 3 | the still fjord | a sea arm frozen in one night, ships still in it, under an aurora |
| 4 | hollow hall | the hearth-keepers' empty village, in a blizzard |
| 5 | the last stair | a thousand steps up the mountain, the aurora close overhead |

- **Runestones.** One stands halfway along every stretch of road. Walking past
  it reads it: its carvings light up, and its line goes into your **saga**.
  There are fifteen, three per region, and read in order they tell the story.
  The `saga` tablet glows when there's a new one. You still collect the ones
  you pass while the page is closed.
- **The first hearth.** After the fifth night the road ends at the hearth.
  Lighting it ends the winter. Everyone you spared is there to see it.
- **A new winter.** The road then starts over with tougher creatures. Each
  time you've lit the hearth, everything you gather is 25% warmer.
- While you walk, the region tells you small things about itself now and then.

All of the world's writing (the region names and descriptions, the runestones,
the weather) sits in one block near the middle of `ember.js`, under "The
world", so it's easy to rewrite.

Warmth keeps adding up while the page is closed, for up to 8 hours. Progress
is saved in your browser's local storage. To reset it, choose `start over` on
the title screen.

Respects `prefers-reduced-motion`: no screen shake, steadier flicker, and less
jitter.

## Look

The interface is carved runestone: stone slabs with a lit bevel and chipped
corners, engraved text, and stone tablets with an icon for every action. You
dodge inside a dark window cut into the stone. Battles play out in front of
snowy mountains, and the path runs through snowy pines under a moon.

### ASCII view

ember starts in an ASCII view: the world is drawn in glyphs while the stone
interface stays pixel art. Press V, or tap the `@` icon, to switch to plain
pixels and back. The game remembers your choice.

- Every 2 × 2 block of world pixels becomes one glyph, picked by what's
  there. Each material has its own symbols: snow `* = ~`, mountains `: ; .`
  with `/ \` slopes, stone `# = %`, creature bodies `% # &`, runes `F R Y X`,
  fire `@ * +`.
- Outlines turn into `/ | \ -` strokes that follow the edge's direction.
- Your glow tints what it touches with orange `: .`.
- An empty sky fills with a dim field of letters that drifts slowly down, and
  `o*o` motes and snow float over the world.
- The aurora hangs in teal `| !` strokes, and each region's snow and wind move
  the motes differently.
- Bullets and particles skip the grid and are drawn as glyphs at their exact
  positions, sized to match their hitboxes. In the dodge box you're a single
  bright `@`.

## How it works

Everything is laid out in 480 × 420 logical units and drawn straight onto a
240 × 210 pixel grid, which is then scaled up with hard edges. The pixel art
follows a few rules:

- **No anti-aliasing.** The moth, firefly and dragon are described as curves,
  then rasterized onto the pixel grid by a small built-in "pixel pen":
  one-pixel outlines with doubled corner pixels removed, flat fills, and
  mirrored halves that come out exactly symmetric. Each animation frame is
  baked once into a sprite (three wing frames, lantern on/off, the dragon's
  four moods) and reused.
- **One pixel size.** Large text and the big title ember are enlarged with
  Scale2x (EPX), which rounds off diagonals, so nothing turns into chunky
  blocks next to finer detail. Small sprites, bullets and the 5 × 7 font are
  hand-placed bitmaps in the code.
- **Stepped light.** Glows fall off in flat bands with a little Bayer dither
  only where two bands meet, and they move in whole pixels so they don't
  shimmer.
- **A 16-color palette.** A cold blue night, runestone greys, glowing teal
  runes and aurora, with your ember the only warm thing, plus a firefly green. Anything left over, such as fades, is snapped to
  the palette with 4 × 4 ordered dithering.

### Sprite sheet

`sprites/` holds the complete sprite sheet, 208 sprites, exported from the
game's own drawing code:

| file | what it is |
| --- | --- |
| `ember-sprites.png` | every sprite and frame packed together, 1 px = 1 game pixel, on transparency |
| `ember-sprites.json` | each frame's name, position and pivot (the point the game positions it by), in TexturePacker's JSON hash format |
| `ember-sprites-preview.png` | the same sprites labeled, with the palette, at 4× |
| `ember-palette.gpl` | the 16 colors, for Aseprite or GIMP |

Frames are named by group, like `moth/wings-open`, `firefly/wings-up-lit-hit`,
`dragon/wings-mid-drowsy`, `friends/dragon-b`, `attacks/feather-left` and `font/a`. Open
`index.html#sprites` to see the sheet in the browser. After changing any
sprite, re-export it with:

```bash
cd ember
node export-sprites.mjs
```


- `ember.js` — the font, sprites and pixel pen, the ASCII renderer, the save
  and offline-warmth logic, the world (regions, runestones, the hearth), the
  creatures and their attack patterns, a fixed-timestep loop
  (60 ticks/s), and all the drawing. Sound is synthesized with the Web Audio API.
- `style.css` — centers the canvas, keeps its pixels sharp, and turns off page
  scrolling while you drag.
- `index.html` — the canvas plus a screen-reader live region that mirrors the
  on-screen text.

`window.ember` exposes the game state (`ember.save` is your progress), if you
want to poke at it from the console.

## Smoke test

`smoke-test.mjs` plays through the loop with scripted key presses. It spares
the moth, buys an upgrade, strikes down the firefly, and loses to the dragon. It
also reads a runestone into the saga and lights the first hearth. Then
it checks that warmth built up while the page was closed. It saves screenshots
and fails on any page error. It needs Playwright with Chromium:

```bash
cd ember
node smoke-test.mjs
```
