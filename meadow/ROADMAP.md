# meadow Roadmap

A small, cozy toy first; maybe a game later. **Building should feel like doodling.** Principle: every new thing is one gesture (drag, paint, click) and builds itself procedurally. No menus of parts.

Last updated: 2026-09-27.

## Direction (decided)
- **A tiny building toy on a grassy hill**, seeded by `docs/inspiration/2026-09-27-tiny-building-game-walls.png`: dry-stone walls you draw, dirt paths you paint, arches where they meet.
- **Web first:** Three.js + TypeScript + Vite, plays in the browser and as a home-screen app. Desktop and phone both matter.
- **The pixel look is the style** (decided 2026-09-27): low-res render, Bayer dithering, a small cozy palette. Everything else (lighting, colours, new objects) is tuned *through* that pass, so check new work with pixels on.
- **Procedural, no art assets.** Bricks, grass, pebbles, icons are all generated or drawn in code.

## Done
- **v0.1 foundation** (2026-09-27): terrain hill, instanced wind-swept grass with LOD, wall drawing with running-bond bricks and ragged tops, path painting, automatic arches, eraser that splits walls, undo/redo, autosave, sun and wind sliders, pixel/dither pass with palette, toolbar + help + phone layout, unit tests, UI tests, home-screen app, Vercel Analytics.

## Next (ideas, not yet ordered; pick with Hunter)
- **Towers:** click a wall (or its end) to grow a round tower; crenellated top.
- **Gates and doors:** a gap tool that leaves an arched doorway without needing a path.
- **Little houses:** drag a rectangle → walls with a pitched roof (thatch or slate).
- **Nature brushes:** trees, bushes, flowers, tall grass, stones.
- **Water:** a pond/stream brush that carves the terrain, with a pixel shimmer.
- **Time of day:** a slow sun cycle, warm dusk, lanterns on walls at night.
- **Life:** sheep or birds wandering the meadow; leaves blowing in the wind.
- **Sound:** soft stone clacks as bricks land, wind through grass, birdsong.
- **Photo mode:** hide UI, frame the shot, save a PNG in the pixel style.
- **Terrain shaping:** raise/lower the ground with a brush.
- **Share a meadow:** encode the world (it's just polylines) into a URL.

## Parked
- Multiplayer, accounts, and cloud saves: not until the toy is fun alone.
