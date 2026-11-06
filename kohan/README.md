# Kohan

**Kohan** (湖畔, "lakeside") is a pixel-art painting of a lone autumn tree on a
spit of land, turned into a place you can walk around in first person. You start
on a knoll looking across the cove at the tree, framed the way the painting is.
From there you can walk the spit, wade out to a standing stone in the shallows,
cross a sandbar of stepping stones to a lantern on the islet, or climb the main
island and look back.

The look comes from a post-processing stack in the order gsimone
([@ggsimm](https://x.com/ggsimm)) laid out for getting a modern renderer to look
like a PS2 or GameCube game. Every pass can be switched on and off live, so you
can watch each one change the frame.

No build step and no JavaScript dependencies. It is plain WebGL2 and ES modules.
The only things fetched are two Google Fonts for the interface.

## Run it

ES modules need a server, so serve the folder:

```bash
cd kohan
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Walk around

| Desktop | Touch |
| --- | --- |
| `W A S D` or arrows: walk | Left thumb: walk (push far to run) |
| Mouse: look (click to lock the pointer, or drag) | Right thumb: look |
| `Shift`: run | |
| `Space`: hop | Hop button |
| `E`: read the stone, light the lantern | Tap the prompt |
| `Tab`: show or hide the post stack | Post stack button |
| `1` to `7`: toggle a pass | Switches in the panel |
| `P`: cycle presets | Preset buttons |

The lake turns you back once the water gets deeper than about 60 cm. You can
wade the shallows; you move slower there.

## The post stack

Each pass runs as its own full-screen shader in `src/post.js`, in this order:

1. **Low resolution.** The scene renders at 180 to 480 lines and is scaled up
   at the end. Every pass after this one works on that small image, so dither
   and blur land on the real pixel grid.
2. **Bloom.** The bright parts of the frame are shrunk four times and blurred
   with a dual Kawase filter, then added back.
3. **Depth of field.** A second Kawase blur of the whole frame is mixed in by
   distance: nothing within about 45 m, most of it by 420 m.
4. **Sun shafts.** Bright sky pixels near the sun are blurred radially toward
   the sun's position on screen, then added in warm white.
5. **Color depth and dither.** Five modes:
   - *PS2 15-bit*: 5 bits per channel, using the GS dither matrix most PS2
     games loaded into the `DIMX` register.
   - *GameCube 18-bit*: 6 bits per channel, the EFB's color depth, with a 4×4
     Bayer dither.
   - *12-bit*: 4 bits per channel, Bayer dither.
   - *Painting palette*: the 16 colors of the reference painting, Bayer
     dithered.
   - *Banding*: posterised with no dither, for when banding is the point.

   Film grain is added here too.
6. **Deflicker.** The GameCube copy filter: each output line blends the line
   above and below it with weights 14/64, 36/64 and 14/64 (the default vertical
   filter coefficients summed per source line). It is a big part of why
   GameCube games look soft.
7. **Composite and CRT.** Each line is encoded as one composite signal (luma
   plus chroma on a subcarrier at four samples per cycle), then decoded with
   simple filters. Fine detail and dither smear into soft color the way they
   did over a real cable. The last pass draws it on a CRT: Gaussian
   scanlines whose width follows brightness, an aperture grille and a slight
   curve.

Presets:

| Preset | Lines | Passes |
| --- | --- | --- |
| Painting | 200 | 1, 2, 4, 5 (painting palette) |
| PS2 | 224 | 1, 2, 3, 4, 5 (15-bit), 7 |
| GameCube | 240 | 1, 2, 3, 4, 5 (18-bit), 6, 7 |
| Raw | native | none |

Your last stack is remembered in `localStorage`.

## How the world is made

Everything is generated from a seed in `src/world.js`. Nothing is loaded.

- **Island.** A signed-distance shoreline (the spit, the main island, the
  viewpoint knoll, the islet) shaped into a 1 m height grid with a wading shelf
  around every shore.
- **The tree.** A hand-placed skeleton that follows the painting: a heavy trunk
  forking into a tall leader that leans left and a limb that reaches right, with
  roots spread over a mound. Nineteen flat foliage tiers hang off it, each built
  from alpha-tested leaf cards whose shapes come from noise in the shader.
- **Light.** Shadows fall toward navy, not black. A low sun sits behind the
  tree from the starting view and rims the trunk. The tree's shadow and the
  darkness under its canopy are computed analytically in the shaders.
- **Water.** A planar reflection rendered from a mirrored camera, rippled by
  noise, tinted toward the painting's blue, and made shallower near the shore by
  sampling the height grid.
- **Sky.** Overcast mottling, cumulus banks along the horizon and long streaks
  that converge on the sun, all from 3D value noise.
- **Far shore.** Low hill bands around the lake and a town with a spire and a
  few lit windows on a headland.
- **Leaves.** About 140 leaves fall from the canopy, drift on the wind, then
  rest on the ground or float on the cove.

## Files

- `index.html`: markup and controls.
- `style.css`: the interface.
- `src/main.js`: boot, render loop, presets, interaction.
- `src/world.js`: terrain, tree, props and the far shore.
- `src/shaders.js`: all GLSL, for the scene and the post stack.
- `src/post.js`: the post stack.
- `src/player.js`: the first-person walker, keyboard, mouse and touch input.
- `src/leaves.js`: falling and floating leaves.
- `src/gl.js`, `src/math.js`: WebGL2 and math helpers.
- `smoke-test.mjs`: loads the page headlessly, renders every preset and fails
  on any console error. Run `node smoke-test.mjs` with Playwright installed.

Respects `prefers-reduced-motion`: no head bob, still grain, steady lantern.
