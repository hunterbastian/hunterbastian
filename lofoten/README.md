# Nordlys — a Lofoten night walk

A small, playable 3D scene of a Nordic fishing village at midnight, inspired by
Lofoten: red timber rorbuer on stilts with warm windows, a snowy rocky shore,
wooden waterfront boardwalk, a lit footbridge, jagged snow-streaked peaks, dark
rippling water with reflections, and slowly flowing green aurora curtains.

Everything is procedural — no textures or models are loaded.

Built with **Three.js + Vite + TypeScript**.

## Run it

```bash
cd lofoten
npm install
npm run dev        # http://localhost:5173
```

**Desktop:** click to enter · **WASD** walk · **Mouse** look · **Shift** longer stride · **Esc** release.

**iPhone / iPad (and other touch devices):** tap to enter · **left thumb**
drags a floating joystick to walk (push it to the rim for a longer stride) ·
**right thumb** drags to look · **II** button pauses. An iPad with a keyboard
can also walk with WASD. Add it to the Home Screen from Safari's share menu
to run it full screen.

Touch devices automatically get a lighter rendering profile (lower pixel ratio,
smaller shadow map and reflection buffer, 2× MSAA); add `?mobile` on desktop to
preview it.

To try it on a phone during development, run `npm run dev` and open the
**Network** URL Vite prints (same Wi-Fi), or deploy `dist/` anywhere static.

The route is one continuous stroll of roughly two minutes:

**Cabin porch → Waterfront → Bridge → Rocky overlook**

The four steps along the bottom-left light up as you reach them.

### Useful URL flags

| Flag | What it does |
| --- | --- |
| `?stage=1` | Stage 1 only: terrain, walkways, controls |
| `?stage=2` | Adds cabins, bridge details, mountains, lights and shadows |
| _(none)_ | Stage 3, the full scene: reflective water, aurora and the dither pass |
| `?autowalk` | The autopilot walks the full route (handy for demos) |
| `?mobile` | Use the touch-device rendering profile on desktop |

## How it's put together

```
src/
  core/math.ts          seeded RNG, value/fbm/ridged noise, SDF helpers
  world/layout.ts       single source of truth: islands, cabins, walkways, route
  world/heightfield.ts  terrain + mountain height functions (pure, testable)
  world/walkables.ts    decks + colliders built from the layout
  world/terrain.ts      low-poly near terrain + far mountain ring
  world/cabins.ts       rorbu cabins, porches, stilts, windows
  world/walkways.ts     boardwalk, stair spurs, footbridge, trail, view deck
  world/props.ts        boulders, lamps, fish racks, bench, boats
  player/walkworld.ts   ground queries, shoreline boundary, collider push-out
  player/player.ts      grounded first-person movement (gravity, steps, slopes)
  player/input.ts       pointer lock, keyboard, mouse look
  player/touch.ts       floating joystick + drag-to-look for touch screens
  player/autopilot.ts   drives the player along the route (tests + ?autowalk)
  render/water.ts       Reflector-based water with animated ripple normals
  render/aurora.ts      folded, ray-streaked aurora curtain shader
  render/sky.ts         gradient sky, twinkling stars, moon
  render/glow.ts        additive halos for windows and lamps (one draw call)
  render/post.ts        tone map → 8×8 Bayer ordered dither + cold lift
  ui/hud.ts             entry card, route progress, place-name toast
```

Movement is grounded and constrained, not just mouse-look:

- **Ground**: the player stands on the highest walkable surface within a step
  (terrain or a deck) and falls with gravity off ledges.
- **Shoreline boundary**: terrain below the tide line is not walkable, so you
  can walk the rocks but never into the sea.
- **Solid bridge and decks**: boardwalk, bridge, porches and the view deck are
  walkable polylines/pads with railings as colliders.
- **Building collisions**: cabins, lamp posts, boulders, racks and the bench
  push the player out; movement slides along them.
- **Slopes**: terrain steeper than ~40° can't be climbed.

The physics, layout and height functions have no three.js dependency, so the
same code runs in node for tests.

## Verification

```bash
npm test              # node: autopilot walks the whole route; boundary checks
npm run dev           # then, in another terminal:
npm run walk          # real browser: ?autowalk run, asserts zone order, saves screenshots
npm run check:controls  # real browser: click-to-lock, W walks, mouse looks, release pauses
npm run check:touch   # emulated iPhone: tap to enter, joystick walks, drag looks, pause, landscape
npm run shots         # screenshots of eight viewpoints along the route
```

The browser scripts use `playwright-core` with a local Chromium
(`CHROME_PATH` overrides the path). The touch check emulates an iPhone in
Chromium; it is not a substitute for a pass on real iOS Safari.
