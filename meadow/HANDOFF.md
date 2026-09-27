# Handoff: meadow v0.1 (playable foundation)

Last updated: 2026-09-27.

## Where things are
- Built from scratch on 2026-09-27 from Hunter's reference image (`docs/inspiration/`). Hunter asked for the dithered, pixel look the same day; it's now the default (`src/pixelate.ts`).
- **Repo:** started as `meadow/` inside `hunterbastian/hunterbastian` (PR #9) because the session couldn't create a new repo. It's set up to move to its own private repo `hunterbastian/meadow` like VARA: Vercel project `meadow`, auto-deploy from `main`, alias to `meadow-game.vercel.app` (check the plain `meadow.vercel.app` isn't someone else's first).
- Everything in `ROADMAP.md` "Done" works and is covered by `npm run check`.

## Open decisions
- Which "Next" item to build first (towers, houses, nature brushes and water are the strongest candidates).
- Default pixel size (4 today) and whether the palette should shift with the sun slider.
- Whether the hill should be one fixed world or seeded/generated (a world list like VARA's is possible later).

## Known rough edges
- Straight wall segments on tight curves leave small wedge gaps on the outside of the curve.
- Arches only form where a path already exists when the wall is built or when a path stroke ends (walls are rebuilt then), not while painting.
- Grass is heavy on older phones; `?q=low` halves it (touch devices get low automatically).
