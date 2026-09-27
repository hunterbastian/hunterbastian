# meadow

A cozy, tiny 3D building game for the web. Drag to lay dry-stone walls across a grassy hill, paint dirt paths, and walls grow arches where paths cross them. Rendered in chunky, dithered pixels. Seeded by `docs/inspiration/2026-09-27-tiny-building-game-walls.png`. Direction and phases: `ROADMAP.md`. Current state and open decisions: `HANDOFF.md`. Plain-language history: `CHANGELOG.md` (newest first).

## Stack
- **Build:** Vite 8 + TypeScript 7 (strict). `npm run dev` (local server; `server.host` is on so a phone on the same Wi-Fi can open it), `npm run build` (typecheck + build to `dist/`), `npm test` (Vitest unit tests, `src/**/*.test.ts`), `npm run test:ui` (build + headless UI checks, screenshots in `/tmp/meadow-ui`), `npm run typecheck`, `npm run check` (all three).
- **Three.js r186** from npm (`three@0.186`), `import * as THREE from 'three'`. Default colour management (sRGB output, ACES tone mapping applied in the pixel pass).
  - Terrain and grass patch Lambert internals via `onBeforeCompile` string `.replace()` (`#include <common>`, `<begin_vertex>`, `<project_vertex>`, `<color_fragment>`, `<normal_fragment_begin>`). On any Three.js upgrade, confirm those chunks still exist in `meshlambert.glsl.js` or the grass stops swaying and paths vanish silently.
- Fonts: Fraunces (wordmark, headings), Inter (UI), from Google Fonts.
- **Deploy:** Vercel (framework Vite, `npm run build`, `dist/`; see `vercel.json`), auto-deploys from GitHub `main`.
- **Analytics:** Vercel Web Analytics via `@vercel/analytics`; `inject()` runs only on `*.vercel.app` (bottom of `src/main.ts`), so local and headless runs aren't counted.
- **Home screen app:** `public/manifest.webmanifest` + `public/icons/` (pixel-art icon, source `public/favicon.svg`) + apple meta tags in `index.html`.

## Controls
- Mouse: left-drag builds with the current tool, Shift for a straight wall, right-drag or Space+drag orbits, middle-drag pans, scroll zooms. Keys: `1` wall, `2` path, `3` erase, `4` look, `[` `]` wall height, `W A S D` pan, `Q`/`E` spin, `Ctrl/⌘ Z` undo (+Shift redo), `P` pixels on/off, `F` FPS meter, `H` help.
- Touch: one finger builds, two fingers orbit/zoom, the Look tool makes one finger orbit.

## Code map (`src/`)
- `main.ts`: renderer, sky, lights, camera + OrbitControls, input and tools, UI wiring, frame loop, boot. Owns the `world` state and `History`.
- `config.ts`: world size, build radius, brick dimensions, brush sizes, quality (`?q=low|high`). Guarded so it imports in Node for tests.
- `terrain.ts`: `heightAt(x, z)` (pure; the single source of ground height for mesh, grass, walls, cursor and picking), the terrain mesh + dirt/pebble shader, `raycastTerrain` (ray-marches `heightAt`, no mesh raycasts).
- `pathMask.ts`: the path layer, a 1024² world-space greyscale canvas painted with soft stamps; uploaded as a texture for the terrain and grass shaders, and `sample()` for arch detection. Strokes are replayed on undo.
- `grass.ts`: ~400k instanced blades in 8 m chunks, wind in the vertex shader, blades shrink on paths. Chunks store blades in random order, so distance LOD is just `mesh.count`.
- `wall.ts`: stroke smoothing (`tidyStroke`: Chaikin + arc-length resample), `buildWall` (running-bond courses of jittered `RoundedBoxGeometry` bricks in one `InstancedMesh`, ragged/crenellated tops, arches where the path mask crosses, voussoir ring), `cutWalls` (the eraser splits walls).
- `pixelate.ts`: `Pixelator`, renders the scene to a low-res HalfFloat target, then tone maps, applies 4×4 Bayer dithering and snaps to `PALETTE_HEX` (or per-channel levels) with nearest-neighbour upscaling. This is the whole look; tune the palette there.
- `cursor.ts`: dashed ring that hugs the terrain.
- `world.ts`: `WorldState` (walls as polylines, path strokes), the demo scene, save/load (`localStorage` key `meadow:world:v1`), snapshot `History`.
- `noise.ts`: value noise, fbm, seeded `rng`, plus a GLSL twin.

## Debug hooks
- `window.__meadow`: `.world()` (walls, strokes), `.ui()` (tool, wall courses, canUndo/canRedo, pixel settings), `.setTool(t)`, `.undo()`, `.redo()`, plus `scene`, `camera`, `controls`.
- `?q=low` / `?q=high` forces grass quality. `F` shows the FPS meter.
- Clear saved state: `localStorage.removeItem('meadow:world:v1')` (and `meadow:seen-help` to see the help dialog again). The help dialog never opens under automation (`navigator.webdriver`).

## Verify
Logic: `npm test`. Anything visual or interactive: `npm run test:ui` (add a check when adding a feature), then look at the screenshots in `/tmp/meadow-ui`. On a Mac it uses the real GPU (Metal via ANGLE); elsewhere it falls back to SwiftShader (slow but works in the cloud). Playwright is found via `MEADOW_PLAYWRIGHT` or a normal/global install.
