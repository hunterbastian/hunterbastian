# meadow

A cozy, tiny building game for the web. Drag to lay dry-stone walls across a grassy
hill, paint dirt paths, and watch the walls grow arches wherever a path runs through.
Everything is rendered in chunky, dithered pixels.

Inspired by the soft, toy-like feel of games like *Tiny Glade*. Built with
**Three.js + TypeScript + Vite**, with no game engine and no art assets: every brick, blade
of grass and pebble is procedural.

## Play

| Action | Mouse / keys | Touch |
| --- | --- | --- |
| Build with the current tool | Left-drag | One finger |
| Straight wall | Hold <kbd>Shift</kbd> while drawing | — |
| Orbit | Right-drag, or <kbd>Space</kbd> + drag, or the **Look** tool | Two fingers |
| Pan | Middle-drag, <kbd>W A S D</kbd> / arrows, <kbd>Q</kbd>/<kbd>E</kbd> to spin | — |
| Zoom | Scroll | Pinch |
| Tools | <kbd>1</kbd> wall · <kbd>2</kbd> path · <kbd>3</kbd> erase · <kbd>4</kbd> look | Toolbar |
| Wall height | <kbd>[</kbd> <kbd>]</kbd> | − / + in the toolbar |
| Undo / redo | <kbd>Ctrl/⌘ Z</kbd> · <kbd>Shift Ctrl/⌘ Z</kbd> | Toolbar |
| Pixels on/off | <kbd>P</kbd> | ☀ panel |
| FPS meter | <kbd>F</kbd> | — |

Your meadow is saved to `localStorage` as you build. Add `?q=low` (or `?q=high`) to the
URL to force the grass quality.

## Develop

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check + production build into dist/
npm run preview   # serve the build
```

## How it works

- **Terrain** (`src/terrain.ts`): a heightfield from a pure `heightAt(x, z)` function
  (a big hill plus fractal noise). The same function drives the mesh, grass placement,
  wall footings and a cheap ray-marched picker, so nothing needs mesh raycasts.
- **Paths** (`src/pathMask.ts`): painted as soft stamps into a 1024² world-space canvas.
  The terrain shader blends grass-ground into dirt and pebbles using it, and the grass
  shader shrinks blades to nothing on the path.
- **Grass** (`src/grass.ts`): about 400k instanced blades split into chunks. Wind sway
  runs in the vertex shader. Each chunk stores its blades in random order, so distance LOD
  is just lowering `mesh.count`. Far blades widen to keep the lawn looking full.
- **Walls** (`src/wall.ts`): your stroke is smoothed (Chaikin) and resampled by arc
  length, then filled with running-bond courses of jittered rounded bricks as one
  `InstancedMesh` per wall. The tops are ragged and crenellated. Where the wall crosses a
  path, it cuts an elliptical opening and fans voussoir bricks around it to make an arch.
  The eraser splits walls rather than deleting them whole.
- **Pixels** (`src/pixelate.ts`): the scene renders into a low-res HalfFloat target,
  then a fullscreen pass tone-maps it, applies 4×4 Bayer ordered dithering and snaps
  colours to a small cozy palette, upscaling with nearest-neighbour filtering.
- **State** (`src/world.ts`): the whole world is just wall polylines and path strokes,
  so undo/redo are JSON snapshots and save/load is one `localStorage` key.

## Deploy

It's a static Vite app. On Vercel, set the project's root directory to `meadow`. The
framework preset (Vite) is detected automatically and the output goes to `dist/`.
