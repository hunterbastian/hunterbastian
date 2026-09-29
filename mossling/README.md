# Mossling

A tiny, cozy 3D walking game. You're a small four-legged forest creature with a
mossy saddle and a sprout on its head, pottering around a quiet glen at golden
hour. Nothing to fight and nothing to collect. You just walk around.

Built with **Three.js + TypeScript + Vite**.

## Run it

```bash
cd mossling
npm install
npm run dev        # http://localhost:5173
```

`npm run build` writes a static site to `dist/`. It uses relative paths, so the
build runs from any folder or static host.

## Controls

| Input            | Action                                         |
| ---------------- | ---------------------------------------------- |
| `W A S D` / arrows | wander (camera-relative)                     |
| `Shift`          | trot                                           |
| drag · scroll    | orbit the camera · zoom                        |
| `T`              | cycle dither: `palette` → `posterize` → `off`  |
| `[` `]`          | pixel size down / up                           |
| `H`              | hide the controls card                         |

**On iPhone / iPad / touch screens:**

| Touch              | Action                                          |
| ------------------ | ----------------------------------------------- |
| left thumb         | floating joystick: wander, push to the edge to trot |
| right thumb drag   | look around                                     |
| pinch              | zoom                                            |
| ◐ / ?              | cycle dither · show or hide help                |

**Mossling always plays in landscape.** Web pages can't lock orientation on iOS,
so when a phone is held upright the whole game turns 90° and a hint asks you to
tip the phone onto its left side. Touch input is remapped to match. If your
phone's rotation lock is off, the browser goes landscape on its own and nothing
extra is rotated. Add `?rotate=0` to the URL to turn this off.

Page zoom, bounce-scrolling and long-press menus are turned off, and the UI
respects the notch and home-indicator safe areas, including when rotated. Use
Safari → Share → *Add to Home Screen* to play full-screen.

Stand still for a few seconds and the mossling looks around, sniffs the
ground and eventually sits down.

URL options: `?dither=posterize` and `?px=3` (a fixed pixel size).

## The look

- **Real low resolution.** The canvas is rendered at about 250px tall and scaled
  up with `image-rendering: pixelated`, so every pixel is a crisp square.
- **Dithering is part of the art.** A post pass (`src/post.ts`) adds a 4×4
  Bayer threshold to each pixel and snaps it to a hand-picked 32-colour palette
  of warm, mossy colours (`src/palette.ts`). Fog, sky gradients, lantern glows,
  path edges and shading all turn into visible stipple.
- **PS1 touches.** Vertices snap to the low-res grid (a subtle wobble), shading
  is flat, textures are tiny nearest-filtered canvases, shadows are blobs, and
  the fog is thick and warm.

## How it works

```
src/
  main.ts              renderer, lights, fog, loop, resolution
  post.ts              Bayer + palette dither pass
  palette.ts           the 32-colour palette + named scene colours
  ps1.ts               material patch: vertex snapping + wind sway
  camera.ts            floaty third-person follow/orbit camera
  input.ts             keyboard + drag + wheel
  creature/
    creature.ts        body build, locomotion, gait, idle life
    ik.ts              two-bone IK + stable segment orientation
  world/
    terrain.ts         analytic heightfield, paths, pond, vertex colours
    world.ts           trees, bushes, cottage, standing stones, lanterns,
                       grass/flowers/reeds, motes, butterflies
    sky.ts             gradient dome, sun, drifting low-poly clouds
    batch.ts           merges props into a few meshes with baked face colours
    textures.ts        procedural pixel textures
    noise.ts           seeded RNG + value noise
```

### Procedural walking

The creature has no animation clips. Each frame:

1. **Body.** WASD sets a target direction relative to the camera. The creature
   turns toward it at a limited rate, eases its speed up and down, and slows
   into an arc on sharp turns.
2. **Feet.** Each paw has a rest spot under its hip, pushed forward by the
   current velocity. When a planted paw drifts too far from that spot, it steps
   there along an eased arc.
3. **Gait.** Diagonal pairs (front-left with back-right) step together. A pair
   can only lift while the other pair is planted, which gives a natural trot.
   Step length, duration and height scale with speed.
4. **IK.** Hip-to-paw legs are solved with analytic two-bone IK. Front wrists
   bend forward and hind hocks bend back.
5. **Secondary motion.** Body height, pitch and roll follow the planted feet, so
   it tilts on slopes. It leans into turns and accelerations. The head, ears,
   sprout and tail react to speed and turning, and it blinks, breathes, and
   flicks its ears.

Terrain height comes from the same triangles that are drawn
(`groundAt()`), so paws land exactly on the ground.

## Smoke test

```bash
npm run build && npm run smoke
```

This serves the build in headless Chromium, walks and trots the creature around
on a desktop viewport, then on an emulated iPhone held upright (checking the
stage is rotated to landscape) and held sideways, using the touch joystick. It writes `smoke-*.png` screenshots and fails on any page error. It uses a
Playwright install from the project or the global one.
