# Underfern — architecture & module contract

Underfern is a single-player, third-person **dinosaur survival** game for the browser,
in the spirit of *The Isle*: you hatch as a juvenile dinosaur on a misty,
overgrown island and have to eat, drink, hide, fight and grow to adulthood while
other dinosaurs (carnivores and herbivores, driven by AI) live their own lives
around you.

This file is the **contract** between modules. If you implement a module, match
the exported names, constructor signatures, fields and units below exactly — other
modules are written against them. If you must deviate, keep the documented API
working (add, don't rename) and note it in your report.

---

## Ground rules

- **No build step, no npm dependencies.** Plain ES modules loaded by the browser.
  The only library is three.js, vendored at `vendor/three/` and imported as
  `import * as THREE from "three";` (resolved by the import map in `index.html`).
  three.js version: **r180** — use current APIs (`outputColorSpace`,
  `THREE.SRGBColorSpace`, `BufferGeometry`, `InstancedMesh`, etc.).
- Code style matches the rest of the repo (see `../aria/aria.js`): 2-space indent,
  double quotes, semicolons, `const`/`let`, small banner comments
  (`/* --- Section --- */`) for sections, concise JSDoc on public methods.
  Comment the *why*, not the obvious.
- Shared helpers live in `src/core/` (`rng.js`, `math.js`, `events.js`) and global
  tuning in `src/config.js`. Use them instead of re-implementing.
- Don't allocate in hot paths (per-frame, per-creature): reuse module-level temp
  vectors.
- Every module must be safe to construct and update without a DOM other than what
  it is handed (no `document.getElementById` reaching into other modules' DOM).
- **Art direction — naturalistic & detailed, NOT low-poly.** The user explicitly
  rejected the faceted low-poly look. Build **smooth-shaded, higher-poly** geometry
  with organic silhouettes (never `flatShading: true`; the only exception is rock that
  should read as hard-edged stone), plus **procedural surface detail in shaders**:
  noise-blended grass/dirt/rock/sand/mud on the terrain, bark, leaf/frond cards with
  alpha cut-outs, scaled/banded dinosaur skin with countershading, roughness
  variation, small normal perturbations. Generate textures procedurally at load
  (canvas / DataTexture, mip-mapped, `SRGBColorSpace` for colour maps) — no image
  files. Keep it fast: instancing, LOD where it pays, shared materials, texture
  atlases.
- **Mood — mysterious, painterly, northern.** *Breath of the Wild*'s luminous
  painterly light (warm key light, cool blue-violet shadows, wrap lighting, a rim on
  silhouettes, lush grass with sun-bleached tips and gusts rolling across it, strong
  blue-green aerial perspective, puffy painted clouds, golden hours) crossed with
  *Skyrim*'s moody north (snow on the peaks, valley mist at dawn, wisps on the
  summits, a weather of its own each day, auroras on some clear nights). Mysterious,
  but **dinosaurs only**: no ruins, buildings or artefacts — the island's wonders are
  colossal fossils, sea stacks, a stone arch, basalt columns, glowing fungi and
  fireflies. The look lives **in the materials** (`world/look.js`), never in a
  post-processing pass, so it costs the same in every render style.
- **Three render styles, same assets.** `"retro"` (default — "Retro HD", a
  late-2000s console look: `world/retro.js` draws the scene into a sub-HD target,
  720 rows on high and 540 on low at most, then one short post pass adds a bright-pass
  bloom at ¼ and ⅛ size, a quincunx-style soften, lens fringe, a desaturated bronze /
  teal grade with crushed blacks and per-frame film grain; the browser stretches the
  canvas smoothly). The scene target is flagged `isXRRenderTarget` so three still
  tone-maps and sRGB-encodes into it — every material's look (grade, haze, vignette)
  runs after those, exactly as on screen. `"pixel"` (retro, late-'90s: the 3D
  scene is drawn straight into a small canvas, ≈ 230–300 rows at "Chunky" and
  geometrically between that and full resolution at the default "In between", then
  upscaled by the browser with nearest-neighbour `image-rendering`; the DOM UI stays
  crisp on top) and `"detailed"` (full resolution, MSAA on high). `main.js` owns this
  (settings + `?style=`). Neither of those two has a post pass: anything screen-wide
  (the grade, the vignette) is done at the end of each material's fragment shader. Assets
  must look good in both: avoid high-frequency detail that shimmers when pixelated
  (mip-mapped textures, smooth shader noise, alpha-to-coverage or alphaTest with
  mips for foliage, derivative-aware fades).

## Conventions

| Thing | Convention |
| --- | --- |
| Axes | Y up. World XZ in **metres**, island centred on the origin, extent `[-size/2, size/2]` (`WORLD.size` = 1600). |
| Sea level | `WORLD.seaLevel` = 0. **All** water (ocean, lakes, rivers) is at this one level. Lakes/rivers are basins carved below it. |
| Heading | `yaw` radians. `yaw = 0` faces **+Z**; forward = `(sin(yaw), 0, cos(yaw))`; `object.rotation.y = yaw`. Helpers in `core/math.js`. |
| Time | `dt` in seconds, clamped by main to ≤ 0.05. Day phase `0..1`: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. |
| Stats | `food`, `water`, `stamina` are **percent 0..100** (100 = full). `health` is absolute HP, `maxHealth` scales with growth. `growth` is 0..1 (1 = adult). |
| Mass / size | Species values are **adult**. Current `scale = growthScale(species, growth)`; current mass = `species.mass * scale³`. Models are built at adult size in metres and scaled by `scale`. |
| Randomness | Always seeded: `makeRng(seed)` from `core/rng.js`. Never `Math.random()` in world generation (fine for cosmetic jitter). |

## File layout & ownership

```
underfern/
  index.html            UI      import map, <div id="app"> › <canvas id="game">, <div id="ui">, loads src/main.js
  style.css             UI      all CSS (HUD, menu, map, touch controls, overlays)
  icon.svg              UI
  src/config.js         (shared, done)
  src/core/rng.js       (shared, done)
  src/core/math.js      (shared, done)
  src/core/events.js    (shared, done)
  src/core/screen.js    (shared)   the app frame: forced landscape on phones held upright (see below)
  src/core/noise.js     TERRAIN
  src/world/terrain.js  TERRAIN
  src/world/caves.js    TERRAIN     caves: planning, carving, rock vault meshes, the clearance index
  src/world/water.js    ATMOSPHERE
  src/world/sky.js      ATMOSPHERE
  src/world/vegetation.js VEGETATION
  src/world/wind.js     ATMOSPHERE  wind field: scent drift for the AI's sense of smell, vegetation sway
  src/world/look.js     ATMOSPHERE  the painterly look: shared uniforms + shader hooks patched into every lit material
  src/world/retro.js    INTEGRATION the Retro HD render style's post pass: bloom, soften, fringe, grade, grain
  src/world/landmarks.js TERRAIN    colossal fossils and stone wonders: placement, meshes, colliders
  src/world/atmosphere.js ATMOSPHERE fireflies and motes, light shafts, peak wisps and spindrift, cave fungi
  src/world/world.js    INTEGRATION
  src/creatures/species.js  DINO-ART
  src/creatures/dinoModel.js DINO-ART
  src/creatures/creature.js  SIMULATION
  src/creatures/ecosystem.js SIMULATION
  src/creatures/ai.js        AI
  src/player/input.js   PLAYER
  src/player/camera.js  PLAYER
  src/player/player.js  PLAYER
  src/ui/hud.js         UI
  src/ui/menu.js        UI
  src/ui/map.js         UI
  src/audio/audio.js    AUDIO
  src/main.js           INTEGRATION
  tests/                INTEGRATION (run-tests.mjs, unit.html, smoke)
  README.md             INTEGRATION
```

---

## Game design (what we're building)

**Loop.** Title screen with a slow cinematic flight over the island (live world
behind the menu) → pick one of eight playable species → spawn as a **juvenile** in a
safe-ish spot → survive. Keep `food` and `water` up, avoid or fight predators,
**grow** (≈20–50 real minutes to adulthood when fed and watered). Getting bigger
makes you stronger and lets you take bigger prey (carnivores) or shrug off
predators (herbivores). Death leaves your carcass in the world and shows a summary
(time survived, growth reached, kills, cause); respawn as a new juvenile. Progress
autosaves to `localStorage` so "Continue" resumes a living character.

**Survival rules** (implemented in `creature.js`; numbers are starting points):
- Metabolism drains food/water continuously (species `metabolism`, %/minute);
  sprinting ×2, resting ×0.5. NPCs drain at ×0.35 so the world stays alive.
- At 0 food → starve damage (1% maxHealth/s). At 0 water → dehydrate (1.5%/s).
- Health regenerates (0.4% maxHealth/s, ×3 resting) while food > 30, water > 30,
  and not bleeding.
- **Bleeding** (hp/s) is added by bites, decays over time (faster when resting).
- **Stamina** drains while sprinting, swimming (unless a good swimmer) and on each
  attack; regenerates otherwise (×2 resting). Can't sprint/attack when empty.
  Swimming with 0 stamina → drowning damage.
- **Growth** advances only while food > 25 and water > 25 (player only; NPCs spawn
  at a fixed growth). Stages: juvenile `[0, 0.4)`, sub-adult `[0.4, 1)`, adult `1`.
  `maxHealth` scales with growth; keep the health *fraction* when growing.
- **Eating**: carnivores eat carcasses, herbivores eat plants (ferns, cycads,
  horsetails, shrubs). Hold to eat while nearly stationary near the food with your
  head. Food gain: eating removes `max(0.5, mass·0.006)` kg/s from the source and
  restores `removed / (mass·0.08) · 100` percent food (so ~8% of body mass fills you).
- **Drinking**: hold to drink with your head at **fresh** water (lakes/rivers);
  ocean water is salty and doesn't help. +10% water/s.
- **Combat**: bite (or tail swipe / kick, per species `attack`) has a cooldown and
  costs 8 stamina (`attackStamina`). Damage = `bite · lerp(0.12, 1, growth)`, reduced
  by the target's `armor` (less the attacker's `pierce` share: T. rex crushes through
  half), plus bleeding = `bleed · lerp(0.12, 1, growth)`. A water hunter
  (`waterAffinity`) hits swimming or wading prey harder (×1 + 0.3·affinity), and good
  swimmers can still lunge from the water. Front cone ~70° for bite/kick; rear/side
  arc for tail attacks.
- **Sniff** (player ability): reveals nearby food (diet-appropriate), the nearest
  fresh water, and creatures within ~120 m (× the species' `smell`) as on-screen
  markers for a few seconds; cooldown ~12 s.
- **Call**: species-specific vocalisation. NPCs of the same species may call back
  from the distance; herbivores near a carnivore's call get nervous.
- **Crouch** = slower and harder for AI to notice. **Rest** = lie down to regen
  faster (vulnerable).
- **Swimming**: water deeper than ~0.8× hip height → swim. Good swimmers
  (Ceratosaurus, Spinosaurus) are fast in water.
- **Day/night**: a full day is `TIME.dayLengthSec` (16 min). Nights are dark but
  moonlit; carnivores roam more at night, herbivores rest more.

**Species** (`species.js`). Playable, in menu order:

| id | name | diet | adult length/mass | role |
| --- | --- | --- | --- | --- |
| `dryosaurus` | Dryosaurus | herbivore | 3.5 m / 90 kg | tiny, very fast, fragile; herds |
| `utahraptor` | Utahraptor | carnivore | 6 m / 500 kg | agile pack hunter, bleed bites |
| `ceratosaurus` | Ceratosaurus | carnivore | 7 m / 900 kg | ambusher, excellent swimmer |
| `stegosaurus` | Stegosaurus | herbivore | 9 m / 4.5 t | slow, tail-spike swipes cause heavy bleed |
| `allosaurus` | Allosaurus | carnivore | 9.5 m / 2.3 t | Jurassic apex predator |
| `brontosaurus` | Brontosaurus | herbivore | 22 m / 15 t | hatches tiny, grows into the biggest thing on the island |
| `tyrannosaurus` | Tyrannosaurus rex | carnivore | 12 m / 8 t | hardest bite (pierces armour), best nose; slow, tires fast; slowest to grow |
| `spinosaurus` | Spinosaurus | carnivore | 14 m / 7 t | sail-backed water's-edge ambusher; best swimmer, slow on land |

NPC-only: `camptosaurus` (common herding prey, 6 m / 700 kg) and `diplodocus`
(gentle 26 m giant, rare, tail whip when threatened). The two apex newcomers also
spawn wild: rare (`spawnWeight` 0.07 / 0.12), solitary, capped by `maxAlive` (T. rex 2,
occasionally a pair; Spinosaurus 1, near fresh water and the shore).

The island is out of time: the Morrison Formation animals (Allosaurus,
Stegosaurus, Dryosaurus, Ceratosaurus, Camptosaurus, the sauropods; Late
Jurassic, ~150 Ma) share it with Utahraptor (Cedar Mountain Formation, Utah,
Early Cretaceous), Spinosaurus (Kem Kem / Bahariya, North Africa, 99–93 Ma) and
Tyrannosaurus rex (Hell Creek Formation, 68–66 Ma). Allosaurus is Utah's state
fossil.

---

## Module contracts

### `core/screen.js` (shared) — the app frame

Everything the game draws lives in `#app`. On a touch phone (coarse pointer, shorter
screen side < 600 CSS px) whose visual viewport is portrait, `#app` is laid out at
landscape size (width = viewport height) and turned 90° clockwise
(`html.is-rotated`), because iOS can't lock orientation; the player turns the phone
counter-clockwise. Rules for modules:

```js
export function isRotated()                  // → boolean
export function appSize(out = {w, h})        // the app's own (landscape-oriented) size, CSS px
export function toApp(clientX, clientY, out = {x, y}) // client point → app-local point
export function onAppResize(fn)              // fn({ w, h, rotated }); also window "app-resize"; → unsubscribe
export function tryLockLandscape()           // Android fullscreen: screen.orientation.lock, errors ignored
```
- JS never sizes from `innerWidth`/`visualViewport` or positions from raw
  `clientX`/`getBoundingClientRect()` (the rotated box in client space): use
  `appSize()`, `toApp()` or layout sizes (`clientWidth`/`offsetWidth`).
- CSS inside `#app` uses container units (`cqw`/`cqh`/`cqmin`/`cqmax`, never
  `vw`/`vh`) and `@container app (…)` for width/height/orientation queries (nest
  them in `@media` for pointer/hover). Safe areas come from `--sa-t/r/b/l` (or the
  derived `--safe-*`), defined on `#app` and remapped while rotated — never `env()`
  directly. `position: fixed` inside `#app` is relative to `#app`.
- Browsers pan in screen axes (Chrome won't touch-scroll a rotated scroller at all),
  so while rotated `touch-action` is `none` throughout `#app` and `screen.js` scrolls
  `overflow: auto` containers (axis picked by the drag, fling, scroll-snap honoured)
  and drags `<input type=range>` along the app's axes. New scrollable UI needs
  nothing special; a drag never also fires a click.

### `core/noise.js` (TERRAIN)

```js
export function createNoise2D(seed)            // → (x, y) => number in [-1, 1] (simplex)
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) // ≈ [-1, 1]
export function ridged2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) // [0, 1]
```

### `world/terrain.js` (TERRAIN)

```js
export const BIOMES = ["ocean", "lake", "coast", "plains", "forest", "rock"];
export const LIVING_BIOMES = ["coast", "plains", "forest"]; // the three living biomes; "rock" is the massif's bare stone
export const SNOW_LINE = 145;  // metres above the sea where the snow caps begin (a dusting reaches lower)

export class Terrain {
  constructor({ size, resolution, seed, seaLevel, maxHeight })
  size; half; resolution; cellSize; seaLevel; maxHeight;
  heights;            // Float32Array, (resolution+1)², index = iz*(resolution+1) + ix, x = -half + ix*cellSize
  mesh;               // THREE.Mesh — SMOOTH normals, receiveShadow; MeshStandardMaterial extended via
                      //   onBeforeCompile with procedural detail (see "Terrain look" below)
  heightTexture;      // THREE.DataTexture (RedFormat, FloatType, LinearFilter) of `heights`, for the water shader
  heightAt(x, z)      // bilinear; outside the tile → deep ocean (≈ -30)
  normalAt(x, z, target = new THREE.Vector3())
  slopeAt(x, z)       // 0 flat .. 1 vertical  (1 - normal.y)
  biomeAt(x, z)       // one of BIOMES ("ocean"/"lake" for water; "lake" includes rivers)
  isWater(x, z)       // heightAt < seaLevel
  isFreshWater(x, z)  // water that is a lake or river (not the open ocean)
  waterDepthAt(x, z)  // max(0, seaLevel - heightAt)
  inBounds(x, z, margin = 0)
  findSpawnPoint(rng, { biomes, minHeight = 1, maxSlope = 0.35, near, tries = 300 } = {}) // → {x, z} | null
                      // near = { x, z, minR, maxR } restricts to a ring; never inside a keep-out
  coastAt(x, z)       // 0..1 how far into the coastal belt: 1 on the open sand, ~0.5 in the dunes, 0 inland
  addKeepOut(x, z, r) // keep spawns out of a circle (Landmarks adds every footprint)
  keptOut(x, z)       // inside any keep-out circle
  nearestFreshWater(x, z, maxRadius = 400) // → { x, z, dist } | null — a LAND point on the shore
                      // of fresh water (stand there, face the water, drink). Precompute & bucket.
  mapCanvas(px = 512) // → HTMLCanvasElement: shaded-relief overview map (water, biomes, hillshade,
                      //   summits, passes, trails, lookouts, cave mouths)

  // The massif (see "Mountains & caves" below) — all world metres, decided on the layout grid.
  peaks;              // [{ x, z, h, main }] highest first
  passes;             // [{ x, z, h }] saddles a pass valley crosses
  lookouts;           // [{ x, z, h }] flat pads high on the ridge, each reached by a trail
  routes;             // [{ kind: "valley" | "trail" | "pad", width, points: [{ x, z }] }]
  trails;             // routes of kind "trail", as point lists

  // Caves.
  caves;              // [{ id, kind: "den" | "tunnel" | "cavern", label, entrances: [{ x, z, y,
                      //   outsideX, outsideZ, heading /* outward */, width, height }], height /* lowest
                      //   mouth clearance */, maxHeight, maxWidth, length, deep: { x, z, y } /* resting spot */,
                      //   skylights: [{ x, z, r }], path: [{ x, z }] }]
  ceilingAt(x, z)     // world y of the rock overhead; Infinity in the open (≤ floor inside the rock beside a vault)
  clearanceAt(x, z)   // ceilingAt − heightAt: headroom; Infinity in the open, ≤ 0 in the rock
  shelterAt(x, z)     // 0 in the open … 1 deep in a cave where no daylight reaches
  inCave(x, z)        // under a cave's roof
  caveAt(x, z)        // the `caves` entry whose roof covers (x, z), or null
  nearCave(x, z)      // in, at the mouth of, or just around a cave — keep spawns/plants/props out
  surfaceAt(x, z)     // the highest walkable surface: the hillside on top of a cave, else heightAt
  groundAt(x, z, y)   // ground under something at height y: the cave floor below the middle of
                      //   its roof, the hillside above it, heightAt elsewhere
}
```
`heights` (and `heightAt`, `slopeAt`, `isWater`, …) is the **physics floor**: inside a
cave it is the cave's floor, under the hillside that roofs it (under a roof `heightAt`
reads the floor from the cave index, so it is the same at any mesh resolution and
matches the floor mesh). Anything that stands on
the ground and may be on top of a cave uses `groundAt(x, z, y)` (creatures, the camera)
or `surfaceAt` (props, flyover); spawning code uses `findSpawnPoint`, which skips
`nearCave`. `biomeAt` is `"rock"` on a cave floor.

Island shape: one main landmass (~0.42 × size radius) with a noisy coastline; a
central massif (below) with bare rock on its steep faces and high ground; **3–5
freshwater lakes** and **1–2 rivers** carved below sea level (fresh). A few small
offshore islets are welcome. **Three living biomes**:
- *coast* — a wide belt (`COAST_W` ≈ 100 m) around the shore: open sand at the sea's
  edge (`BEACH_W` ≈ 26 m), then low dunes (raised after classification, `_raiseDunes`)
  held by marram grass, then sandy coastal grass and scrub with palms and cycads,
  driftwood on the sand;
- *forest* — dense conifer / araucaria / broadleaf stands, darker floors; its wettest
  lowlands (moisture > 0.7) are wet forest with mud, horsetails and snags (there is no
  separate swamp biome);
- *plains* — everything else on land: open grassland, lush green with golden
  swathes where it is dry, and upland meadows on the massif's lower slopes.

`biomeAt` returns one of `ocean`, `lake`, `coast`, `plains`, `forest` or `rock`.

**Mountains & caves.** Layout decisions are made on the fixed coarse layout grid
(256², 6.25 m) from their own seed streams (`"underfern-massif"`, `"underfern-caves"`),
so the same seed gives the same island at any mesh resolution.
- *Massif* (`_mountain`, `_peak`): 3–4 horn peaks (main ≈ `maxHeight` 190 m) — concave
  pyramids with arêtes and cirque hollows — joined by a serrated ridge (smooth max),
  with softened cliff bands on the faces and, on the sheer rock, per-vertex crags plus
  rounded, noise-broken ribs and gullies (`nRib`: across the ridge's spine, radiating
  on the horns) so big planar facets read as buttresses and chutes. Steep rock takes
  its vertex normals from a wider difference, so light flows across ribs and bands
  instead of breaking at every edge (no stair-step stripes); the shader adds the fine
  crags back.
  Cliffs (slope > the creature's block grade 0.39) are barriers; the way up is elsewhere.
- *Passes* (`_planPassValleys`): 1–2 notches in the ridge; a U-shaped, meandering valley
  runs from the saddle down both sides to the foot of the range (cut-and-fill floor,
  cut-only banks), graded so every animal can cross.
- *Lookouts* (`_planLookouts`, after the rivers): up to two flat pads high on the ridge,
  each reached from walkable ground by a switchback trail found by a direction-aware
  A* on the layout grid (grade-limited, turn-penalised; the heuristic is the plain
  distance to walkable ground) and carved as a ledge.
  Trails paint as worn dirt, valley floors stay grassy.
- *Caves* (`caves.js`): `planCaves` scores candidate mouths (gentle ground under a
  rise, reachable, clear of passes/trails/lookouts) and designs a **cavern** (a great
  chamber, ≈ 7.5 m mouth, a skylight when its roof is thin), a U-shaped **tunnel** with
  two mouths and up to three small **dens** (≈ 3.2 m mouths: raptors yes, an adult
  Allosaurus no). `carveCaves` sinks the floor into `heights`, keeps the original
  hillside (plus a skin over the vault) as the render surface with holes at the mouths
  and skylights, and fills a `CaveIndex` (1 m grids: ceiling, darkness, zone).
  `buildCaveMeshes` makes one mesh per cave (floor + superellipse vault tube, mouth
  aprons/faces/skirts, skylight shaft) — children of `terrain.mesh`, one shared
  material (the terrain shader with `TER_CAVE` and per-vertex baked cave light,
  cache key `"underfern-cave-v1"`); after lighting, the baked light scales the colour
  and a dim fill from the hemisphere light keeps deep walls readable.
  ≈ 20–25k triangles for all caves.
- Who fits: a creature's `standHeight` (hip height × a species factor) must fit under
  `clearanceAt`; the AI treats a too-low ceiling as a hazard and never picks a
  destination `nearCave`; the ecosystem never spawns there; vegetation skips them.

**Terrain look.** Resolution comes from the constructor (`WORLD.resolution` = 512 on
high ≈ 3.1 m cells; `quality.terrainResolution` may lower it on phones) — heights come
from a continuous function so gameplay is identical at any resolution. Smooth
normals. Per-vertex attributes carry material weights (e.g. grass / dirt / rock / sand
/ mud / snow-free) and a cavity/AO term; the fragment shader blends tiling procedural
detail textures (generated once at load, mip-mapped) sampled in world space
(tri-planar or slope-aware for cliffs so rock doesn't stretch), with macro colour
variation from low-frequency noise so it never looks tiled. It must hold up both
at the player's feet (a juvenile is < 1 m tall) and from 300 m away.
On top of that (all in the one terrain shader, `patchLook` for the light):
- *Painted rock*: a warm-grey base (cooler up high) under the rock texture's grain;
  ~8 m strata bands of grey, buff, pale and rust with ~2.5 m beds inside them
  (blends widen with the screen footprint, so nothing stripes or shimmers); tri-planar
  crag ribs as a normal perturbation and albedo shading on steep faces, rain streaks,
  and warmer, lighter crust on ledges that face up.
- *Snow* above `SNOW_LINE` (patchy below it on ledges): it settles on what faces up,
  slides off sheer faces except down couloirs, and averages out with distance.
- *Gusts*: the wind field's travelling bands (look.js `lookGust`) lighten and warm the
  turf, in step with the grass blades bending.
- *Caves*: deep in, where no daylight reaches, sparse colonies of glowing blue-green
  lichen specks.

### `world/water.js` (ATMOSPHERE)

```js
export class Water {
  constructor(terrain)      // reads terrain.heightTexture, terrain.size, terrain.seaLevel
  mesh;                     // plane at seaLevel, ~3× terrain size so the horizon is ocean
  update(dt, sky)           // animate; pull colours from sky (sunDirection, sunColor, fogColor, skyColor, daylight)
}
```
Depth-tinted (shallow murky green-teal → deep blue-teal) via the height texture,
soft shoreline foam, gentle animated waves/ripples, sun glint, respects scene fog.
It shares the look's mist, aerial haze, grade and vignette (the LOOK uniforms are
merged into its own).

### `world/sky.js` (ATMOSPHERE)

```js
export const WEATHER_KINDS = ["clear", "fair", "overcast", "misty"];
export function weatherForDay(seed, day) // → { kind, aurora } — deterministic; day 1 is fair with an aurora;
                          //   auroras only ever follow clear or fair days
export class Sky {
  constructor(scene, { startPhase, dayLengthSec, viewDistance, shadows, shadowMapSize, seed })
  phase; day;               // day = whole days elapsed (starts at 1)
  seed; seaLevel;           // seed picks the weather (World passes hash(seed, "sky")); the valley mist settles on seaLevel
  weather;                  // { kind, next, blend 0..1 (today → tomorrow across the night), aurora 0..1 (tonight, by darkness) }
  forceWeather;             // null (follow the schedule) | one of WEATHER_KINDS — `?weather=`
  forceAurora;              // null | true | false — `?aurora=`
  weatherLabel()            // the weather now: today's, or tomorrow's once the night has turned
  paused;                   // freeze time
  sunLight;                 // THREE.DirectionalLight — sun by day, moon (cool, dim) by night; castShadow per option;
                            // shadow camera ≈ ±60 m box following the focus; its .target is added to the scene
  hemiLight;                // THREE.HemisphereLight
  sunDirection;             // THREE.Vector3 unit vector toward the sun (may be below horizon)
  sunColor; skyColor; fogColor; // THREE.Color
  daylight;                 // 0 (night) .. 1 (full day)
  shelter;                  // 0..1 set each frame by World from terrain.shelterAt at the camera when under
                            // a cave roof (damped): dims sun ×(1 − 0.5·sh) and hemi light, pushes fog back
  update(dt, focus, camera) // advance time, move lights/shadow box to focus, dome follows camera, set scene.fog
  setPhase(p)
  isNight()                 // daylight < 0.25
  timeLabel()               // "dawn" | "morning" | "midday" | "afternoon" | "dusk" | "night"
  clockString()             // "06:30"
}
```
Owns `scene.fog` (`THREE.Fog`, far ≈ viewDistance, thicker mist at dawn/night) and a
sky dome (gradient, sun disc with a soft bloom, moon, stars at night, painted puffy
clouds from a Worley-puff texture, aurora curtains — green with violet hems,
ray-marched as a few ribbons — on aurora nights; `fog: false`, `depthWrite: false`,
`toneMapped: false`, radius ≤ 1500 — camera far is 2000). The fog colour **is** the
dome's horizon (see the colour-pipeline note at the top of `sky.js`).

**Weather.** Each day's weather comes from `weatherForDay(seed, day)` (its own stream,
`"underfern-weather"`): clear, fair, overcast or misty, blended into the next day's
across the night. It scales cloud cover and greyness, the sun and hemisphere light,
shadow strength, fog distance, the valley mist (how much lingers all day, how deep)
and how pale the grade is. Each frame the Sky also writes the look's shared uniforms
(`LOOK` in `look.js`): mist density, depth and colour, the sun's direction and the
haze's glow toward it, the aerial blue, the cool fill (× the key light), the grade
(vibrance, split tone — eased at night, rim strength — eased at night).

### `world/vegetation.js` (VEGETATION)

```js
export class Vegetation {
  constructor(terrain, { seed, density = 1, grass = true, renderer, landmarks })
                            // landmarks: their colliders join collidersNear; no tree, rock or log on their footprints
  group;                    // THREE.Group of InstancedMeshes (add to scene)
  plants;                   // FoodPlant[] — { id, kind, x, y, z, food, maxFood, regrow }
                            //   kind: "fern" | "cycad" | "horsetail" | "shrub"
  update(dt, focus)         // regrowth (eaten plants visibly shrink, regrow), grass follows focus, wind sway
  collidersNear(x, z, radius, out = [])  // → [{ x, z, r }] tree trunks / boulders
  nearestPlant(x, z, radius, minFood = 1) // → FoodPlant | null
  plantsNear(x, z, radius, out = [])      // → FoodPlant[]
  eatPlant(plant, amount)   // → kg actually removed
}
```
Default `maxFood` (kg): fern 40, horsetail 60, shrub 80, cycad 140; regrow ≈ 1–2% of
max per second after eaten. Biome-driven placement over the three living biomes:
dense conifer / araucaria / ginkgo forest (tree ferns, horsetails and the odd dead
snag where it runs wet); scattered groves, trees and ferns on the plains, thinning to
sparse conifers and boulders on the upland meadows (plains above ~40 m); on the
coast nothing on the open sand, marram grass on the dunes, then palms, cycads, tree
ferns and salt scrub in clumps behind them, and bleached driftwood on the beach.
Grass: dark, cool roots rising to sun-bleached tips, bent and lightened by the gust
bands (look.js) as they roll across; mostly lush green, golden where the ground runs
dry. Foliage keeps little specular, and its alpha test is custom (alpha-to-coverage
up close, plain on/off far away) so distant canopies never glitter. Spatial hashing
for queries. Respect `density`.

### `world/wind.js` (ATMOSPHERE)

```js
export class Wind {
  constructor(seed)
  yaw;        // direction the wind blows TOWARD (heading convention)
  strength;   // 0..1 (gusts)
  vector;     // THREE.Vector3 unit (x, 0, z) toward which it blows
  update(dt)  // slow drift of direction (minutes), gusty strength (seconds)
  scentFactor(fromX, fromZ, toX, toZ) // scent from → to: ≈1.6 straight downwind, ≈1 crosswind, ≈0.15 upwind (blend with strength)
}
```

### `world/look.js` (ATMOSPHERE) — the painterly look

```js
export const LOOK;                 // shared uniform objects (uLookMist, uLookMistColor, uLookMistSun, uLookSun,
                                   //   uLookHazeGlow, uLookAerial, uLookFill, uLookGrade, uLookShadowTint,
                                   //   uLookHighTint, uLookScreen, uLookWind) — Sky and Vegetation write them
export const LOOK_PARS, LOOK_NOISE_GLSL, LOOK_ATMOS_GLSL, LOOK_GRADE_GLSL; // GLSL for ShaderMaterials (dome, water, atmosphere)
export function patchLook(shader, { wrap = 0.45, rim = 0, fill = 1 } = {}) // inside a MeshStandardMaterial's onBeforeCompile
export function setLookScreen(w, h) // drawing-buffer size, for the vignette (main.js on resize)
```
Every lit material in the world (terrain and caves, vegetation, rocks, landmarks,
dinosaurs) calls `patchLook` after its own patches. It changes three.js's standard
lighting and fog chunks:
- **wrap lighting** — the key light bleeds `wrap` past the terminator, so forms turn
  softly;
- **cool fill** — where the key light is shadowed or turned away, `uLookFill` (a
  blue-violet sky bounce, × the key light) fills in: shadows are airy, never black;
- **rim** (`rim > 0`; dinosaurs 1, feathered 0.8, bone 0.45, plants 0) — a thin edge of
  the key light's colour when it is behind the subject, of the sky's otherwise;
- **grade** right after tone mapping: vibrance, split tone (cool shadows, warm
  highlights — warmest at golden hour), a soft S-curve;
- **atmosphere** in place of three's fog: exponential height mist (closed-form
  integral along the view ray, drifting banks, lit from behind toward the sun),
  then the sky's haze — two-tone aerial perspective (blue in the middle distance,
  the horizon's colour far away, warmer toward the sun's azimuth) and thinned with
  altitude, so ridges stack in layers. It still reaches exactly `scene.fog.color` at
  the far plane, so land melts into the dome;
- **vignette** as the last multiply.

All of it runs in the materials' own fragment shaders: no extra pass, the same cost
in both render styles. Shader cache keys stay what they were (`"sauria-…"` keys
included) — every program of a key gets the same patch.

### `world/landmarks.js` (TERRAIN) — the island's wonders

```js
export const LANDMARK_KINDS = ["ribcage", "skull", "vertebrae", "arch", "stacks", "basalt"];
export function planLandmarks(terrain, seed) // → [{ id, kind, label, fossil, x, z, y, yaw, r, seed }] — pure, deterministic
export class Landmarks {
  constructor(terrain, { seed, shadows, detail /* 0.5 low … 1 */ })
  sites;          // planLandmarks' sites, each with colliders: [{ x, z, r ≤ 4.5, height, kind: "landmark" }]
  colliders;      // all of them; World hands the Landmarks to Vegetation, whose collidersNear reports them
  group; meshes;  // one mesh per site (bone or stone material); hidden past the haze
  stats;          // { sites, triangles, genMs }
  update(camera, fogFar)
  siteAt(x, z)    // the site whose footprint covers (x, z), or null
  dispose()
}
```
Dinosaurs only — nothing made: a colossal **ribcage** to walk through (plains or
coast), a great half-buried theropod **skull** rolled on its cheek (plains), a buried
neck arching out of the ground in **vertebrae** (plains or forest), a natural stone
**arch** (coast or plains), a cluster of bedded **sea stacks** in the shallows off a
shore, and a **basalt** causeway of hexagonal columns (coast or plains). Placement
(`"underfern-landmarks"` stream, per kind) takes the first seeded spot that is dry,
gentle and roomy ground in the kind's biomes (the stacks: 2–7 m of open sea a short
swim off a shore), clear of caves and their mouths, lakes, rivers and river mouths,
the pass valleys, trails and lookouts, and ≥ 170 m from the other landmarks.
Footprints become `terrain.addKeepOut` circles (no spawns) and clearings for trees,
rocks and logs. Geometry is lofted tubes, deformed blobs and hexagonal prisms with
vertex paint; the shader adds world-space grain, strata (stone) or fine cracks
(bone), lichen on what faces up and soil staining at the ground. Shader cache keys
`"underfern-landmark-bone"` / `"underfern-landmark-stone"`.

### `world/atmosphere.js` (ATMOSPHERE) — small lights and airs

```js
export class Atmosphere {
  constructor(terrain, { seed, landmarks, low })
  group; motes; beams; wisps; fungi; stats;
  update(dt, focus, sky, camera, bufferHeight)
  dispose()
}
```
Four draw calls, no passes, everything faded by time of day, weather and cave
shelter from the Sky:
- **motes** — fireflies (dusk and night, in forest, by wet ground and around the old
  bones) and pale drifting motes (night, aurora nights): one `Points` cloud on a
  torus wrapped around the focus, glow and blink in the shaders;
- **beams** — god rays: additive camera-facing quads along the key light through the
  forest canopy around the focus (strongest with a low sun, in mist, looking toward
  the light), and fixed shafts down each cave skylight;
- **wisps** — painted cloud puffs clinging to the peaks and plumes of spindrift off the
  summits, alpha-blended and fogged;
- **fungi** — instanced glowing mushroom clusters on cave floors where no daylight
  reaches.

### `creatures/species.js` (DINO-ART)

```js
export const SPECIES;            // { [id]: SpeciesDef }
export const PLAYABLE;           // ["dryosaurus","utahraptor","ceratosaurus","stegosaurus","allosaurus","brontosaurus","tyrannosaurus","spinosaurus"]
export function getSpecies(id)   // → SpeciesDef (throws on unknown id)
export function growthScale(species, growth) // → juvenileScale..1 (eased)
export function growthStage(growth)          // → "juvenile" | "subadult" | "adult"
```
`SpeciesDef` fields other modules rely on (adult values):
```js
{
  id, name, diet: "carnivore" | "herbivore", playable,
  tagline, description, era,            // menu copy
  length, height /* hip height m */, mass /* kg */,
  health, bite, biteCooldown /* s */, biteRange /* m past the snout (or tail tip) */,
  attack: "bite" | "tail" | "kick",
  armor /* 0..0.7 */, bleed /* hp/s per hit */,
  speed: { walk, trot, sprint, crouch, swim },   // m/s
  turnRate /* rad/s */,
  stamina: { regen /* %/s */, sprintDrain /* %/s */ },
  metabolism: { hunger /* food %/min */, thirst /* water %/min */ },
  growthMinutes, juvenileScale,
  swim /* 0..1 ability */,
  social: "solo" | "pair" | "pack" | "herd", groupSize: [min, max],
  aggression /* 0..1 */, perception /* m */,
  spawnWeight, biomes: [..preferred] /* of LIVING_BIOMES: "coast" | "plains" | "forest" */,
  call: { kind: "roar" | "bellow" | "honk" | "chirp" | "shriek" | "hoot" | "rumble" | "rattle",
          pitch /* Hz */, duration /* s, pose ≤ 3.5 */, open?, lift?, swell? /* call-pose shaping, model-only */ },
  colors: { ... }, body: { ... }         // model-only, free-form (DINO-ART decides)

  // Optional knobs (default):
  pierce /* 0..1 share of the victim's armour an attack ignores (0) */,
  attackStamina /* stamina per attack (8) */,
  juvenileSpeed /* hatchling speed × (0.85), blends to 1 with growth */,
  smell /* scent-range multiplier for AI smell, carcass finding and the player's sniff (1) */,
  swimDepth /* hip depth while floating, in hip heights, 0.3..1.3 (0.6 quadrupeds / 0.75 bipeds) */,
  waterAffinity /* 0..1 (0): spawn weight ×(1 + 2.5a) by fresh water / on the coast and ×(1 − 0.8a) inland,
                   patrols banks, prefers drinking/wading/swimming prey, hits wet prey harder */,
  maxAlive /* never more than this many wild NPCs at once (no cap); a player of the kind doesn't count */,
  pairChance /* 0..1 (0): a "solo" species spawns as a pair (shared group, sometimes parent + young) */,
}
```
`body` keys the two newcomers add for `dinoModel.js` (all optional, neutral defaults): `head.cheek`
(jaw-muscle bulge), `head.eye.fwd` (gaze turned forward), `head.teeth.thick` (round crowns),
`features.bosses` / `features.nasalBumps` (skull knobs) and `body.juvenile` (`{ legs, head: [length,
depth, width] }` hatchling proportions, fading linearly with growth) on the T. rex;
`head.teeth.conical / rosette / size`, `arms.fingers[].claw / r`, `swimNeck` (neck pitch while
swimming) and `features.sail` (`{ profile: [[z, height]], spines, thick, rake, bones }`: a skinned
membrane on its own bones that sways, leans out of turns, folds over in death and grows from 45 %
height) on the Spinosaurus; `colors.pupil` ("slit" | "round").

### `creatures/dinoModel.js` (DINO-ART)

```js
export function createDinoModel(species, { seed = 1, variant = 0 } = {}) // → DinoModel
export class DinoModel {
  object;                 // THREE.Group; origin on the ground under the hips; faces +Z; built at ADULT size (m)
  setScale(s)
  getHeadPosition(target) // world position of the mouth/snout tip (after scale & parent transforms)
  getTailPosition(target) // world position near the tail tip
  setTint(color, amount)  // e.g. darken a rotting carcass
  setShade(v)             // 0..1 light multiplier (1 in the open; darker deep in a cave)
  getHitSpheres(out = []) // → [{ x, y, z, r, part }] WORLD-space spheres approximating the body, following the
                          //   current animation (bone world positions); melee strikes measure their reach against them.
                          //   part: "head" | "neck" | "body" | "tail" | "leg". ~8–14 spheres; head sphere(s) tight.
  update(dt, anim)        // anim = {
                          //   speed,          // planar m/s (drives gait cycle; stride matched to scaled leg length)
                          //   crouch,         // 0..1
                          //   swim,           // 0..1 submerged factor (paddling pose)
                          //   turn,           // signed rad/s (body/tail bend)
                          //   action,         // null | "bite" | "tail" | "kick" | "eat" | "drink" | "call" | "rest" | "dead"
                          //   actionT,        // 0..1 progress for one-shots (bite/tail/kick/call)
                          //   lookYaw,        // head turn, radians (±1)
                          //   hurt            // 0..1 red flash
                          // }
  dispose()
}
```
Procedural, **smooth, organic** meshes on a joint hierarchy (hips → spine → chest →
neck → head/jaw; tail chain; 2 or 4 legs with thigh/shin/foot; arms). Recommended:
loft the body/neck/tail as one continuous skin along a spine curve from varying
elliptical cross-sections (plus lofted limbs and a sculpted head/jaw), smooth normals,
**smooth skin weights** blended across neighbouring bones (organic bending, no
cracks), one `SkinnedMesh` per dinosaur (one draw call); roughly 6–15k triangles
(diplodocus up to ~20k). Skin detail via a shared procedural texture/shader (scales,
bands/stripes/spots, countershading, darker dorsal, slight sheen on wet), eyes with
a highlight, teeth on carnivores, claws. Procedural animation:
gait cycles by distance travelled, tail sway, breathing, head bob, jaw open on
bite/call, lie down on rest, fall on side when dead. Each species must read
clearly from a third-person camera (stego plates & thagomizer, the spinosaur sail
and croc snout, the rex's deep skull, cerato nasal horn, allo brow crests, raptor
feathers + sickle claw, diplodocus neck). Colour variants per individual (seeded).

### `creatures/creature.js` (SIMULATION)

```js
export class Creature {
  constructor(world, { species /* def or id */, growth = 0, x, z, heading = 0, isPlayer = false, seed })
  id; world; species; isPlayer; alive; brain /* set by ecosystem; null for player */;
  growth; health; food; water; stamina; bleeding; legBroken /* s left */;
  resting; crouching; swimming; eating; drinking;   // booleans reflecting current state
  position;  /* THREE.Vector3 (y = ground or swim height) */  velocity; /* THREE.Vector3 */
  heading; speed /* planar m/s */; gait /* "idle"|"walk"|"trot"|"sprint"|"swim" */;
  age /* s */; kills; lastAttacker /* Creature|null */; lastDamageTime; causeOfDeath;
  biteCooldown /* s left */; hurt /* 0..1 flash */;
  intent;  // { moveX, moveZ, sprint, crouch, bite, eat, drink, call, rest }
           //   moveX/moveZ: desired WORLD direction, length 0..1 (≤0.5 walk, >0.5 trot; sprint flag → sprint)
           //   bite, call: one-shot (consumed by update) ; eat, drink, crouch, sprint: held ; rest: desired state
  model;   // DinoModel ; model.object is added to world.scene by the ecosystem
  get scale(); get mass(); get maxHealth(); get radius(); get stage(); get diet();
  forward(target)            // unit facing vector
  headPosition(target)       // mouth position (for eat/drink/bite reach)
  findFood()                 // → { kind: "carcass" | "plant", target } | null  (within reach of the head)
  canDrink()                 // → "fresh" | "salt" | null
  update(dt)                 // full sim step (movement, terrain follow, swimming, collisions, metabolism,
                             //  growth, regen, bleeding, actions, model animation)
  takeDamage(amount, source /* Creature|null */, type, pierce = 0) // → damage dealt after armor (× (1 − pierce)); emits "damage"
  invulnerable        // Creative mode: takeDamage/die/damage-over-time do nothing; vitals stay full
  scent; noise; visibility;  // 0..1 stealth signals the AI senses read for ANY target (scent 1,
                             //   noise from gait (idle 0.05 … sprint 1, crouch ×0.4), visibility 1 (×0.6 crouched))
  heal(amount)
  die(cause, killer = null)  // emits "death"
  dispose()
}
```
Movement: creatures turn toward the desired direction at `turnRate` (juveniles
turn faster) and move along their heading (no strafing); acceleration is smoothed;
snapped to `terrain.groundAt(x, z, y)` (a cave floor or the hillside above it); uphill
slows, slope > ~0.39 (`BLOCK_GRADE`) blocks; circle collisions
against `vegetation.collidersNear` and other creatures; clamped inside the island
tile. NPC metabolism ×0.35.
Caves: `standHeight` (hip height × 1.35; sail 1.9, plates 1.75, sauropods 1.28) is the
headroom a creature needs — it can't walk where `terrain.clearanceAt` is lower (it can
always back out). Under a roof `model.setShade(1 − 0.7 · shelterAt)` darkens it.

### `creatures/ecosystem.js` (SIMULATION)

```js
export class Ecosystem {
  constructor(world, { seed, npcCap })
  creatures;   // Creature[] (alive ones, including the player)
  carcasses;   // Carcass[] — { id, species, x, y, z, heading, meat /* kg */, maxMeat, age, scale, model }
  player;      // Creature | null
  spawn(speciesId, x, z, { growth = 1, heading = 0, isPlayer = false, group = null } = {}) // → Creature
  spawnGroup(speciesId, x, z, count, { growth }) // → Creature[]  (shares a group object for herds/packs)
  remove(creature)
  setPlayer(creature) ; clearPlayer()
  formPlayerGroup(player, { resumed = false }) // → group | null — a herd/pack species hatches among 2+ NPCs of
                      // its kind (an NPC adult leads until the player is full grown, then the player
                      // does and the group follows it); loners get null
  joinGroupNear(player, range = 60)            // → group | null — also runs on the player's own "call"
  joinGroup(creature, group)
  update(dt, focus)   // population upkeep around focus (spawn ring GAME.npcSpawnMin..Max, despawn > npcDespawn,
                      // species weights × biome (and shore, for waterAffinity) preference, maxAlive caps,
                      // groups), brains → creatures, carcass rot, and the player's group: no mate
                      // within 90 m for 25 s and it has left (groupStray warns as it starts)
  query(x, z, radius, filter = null, out = []) // → alive Creature[] within radius
  nearestCarcass(x, z, radius, minMeat = 0.5)  // → Carcass | null
  eatCarcass(carcass, amount)                  // → kg removed
  clear()             // remove all NPCs + carcasses (new game)
}
```
When a creature dies its model stays in the world as a carcass (lying on its
side), `meat = mass · 0.5`, darkening/sinking as it's eaten or rots
(`GAME.carcassLifetime`). The ecosystem creates a `Brain` for every NPC
(`creature.brain = new Brain(creature, world, rng, group)`).

### `creatures/ai.js` (AI)

```js
export class Brain {
  constructor(creature, world, rng, group = null) // group = { id, species, members: Creature[], leader }
  state;   // "idle" | "wander" | "graze" | "drink" | "flee" | "hunt" | "attack" | "eat" | "rest" | "follow" | "investigate"
  target;  // Creature | Carcass | {x,z} | null
  update(dt) // perceive (staggered ~4 Hz), decide, steer → writes creature.intent
}
```
Herbivores keep a daily round when leading a herd (fresh water at dawn, open plains by day,
the forest edge at evening, once each per day), graze, drink, herd (cohesion around the leader,
which may be a full-grown player; defenders with young in the herd form a ring between them
and a predator, tails out, while the young huddle inside it), rest at night, flee
from threatening carnivores (bigger ones flee less; Stegosaurus/Diplodocus/Brontosaurus
turn and fight when attacked or cornered). Carnivores roam, hunt when hungry
(prefer prey they can handle, avoid big herds), eat carcasses, attack the player
based on aggression/relative size, packs coordinate loosely. Everyone avoids
steep slopes, the island edge and (unless good swimmers or chasing) deep water.
Perception shrinks for a crouching player and at night. Listen to `"call"` events
(answer same-species calls, herbivores get alert near carnivore calls) and react
to being damaged (`lastAttacker`).

**Senses.** Detection of any target combines three senses: **sight**
(`perception × target.visibility`, needs rough line of sight — forest/night cut it),
**hearing** (`target.noise × ~60 m`), and **smell** (`perception × 1.4 × target.scent ×
world.wind.scentFactor(target.x, target.z, me.x, me.z)` — downwind of a target you smell it
from far away; upwind barely; guard with `world.wind ? … : 1`). A species' `smell`
multiplies its smell range and how far it follows its nose to a carcass (T. rex ×1.5).

**Hunting styles** (`HUNT_STYLE` per carnivore: stalk → chase distance, creep distance,
roar odds, chase time, ambush freeze). Allosaurus yields to anything over 1.8× its
mass, so both newcomers send it off its kill. Water hunters (`style.water`,
Spinosaurus) prefer quarry that is drinking, wading or swimming, lose interest in
anything over half their mass (`style.bigPrey`) and back away rather than trade
blows when a herbivore that big turns on them, and patrol river and lake banks
(`waterAffinity`): most roams end at a bank, and destinations near fresh water win.

### `player/input.js` (PLAYER)

```js
export class Input {
  constructor(canvas, uiRoot)
  isTouch; enabled /* false while menus are open */; pointerLocked;
  moveAxis()          // → { x, y } — x right, y forward, length ≤ 1
  isDown(action)      // held:   "sprint" | "crouch" | "interact" | "bite"
  pressed(action)     // edge:   "bite" | "call" | "sniff" | "rest" | "map" | "pause" | "help" | "interact" | "crouch"
  consumeLook()       // → { dx, dy } pixels since last call (pointer-locked mouse or touch drag)
  consumeZoom()       // → wheel delta since last call
  lookHeld            // a touch look is under way (thumb on the look pad, or sliding from Bite)
  requestPointerLock()
  endFrame()          // clear edge state
}
```
Bindings: WASD/arrows move · Shift sprint · C toggle crouch (Ctrl hold) · LMB/F
bite · E (hold) eat/drink · Q call · R sniff · Z rest · M map · Esc/P pause ·
H help · wheel zoom · click canvas to lock the pointer.
Touch (`isTouch`): Input builds its own controls in `uiRoot` —
`<div class="touch">` containing a left-side joystick
(`.touch-stick` › `.touch-stick__knob`), right-side drag-to-look area, and buttons
`<button class="touch-btn" data-action="bite|interact|sprint|call|sniff|rest|map|pause|crouch">`.
Bite doubles as a look pad: a thumb that slides more than 10 px from the press turns
the view like the look area (the press still bites).
CSS for these classes lives in `style.css` (UI).

### `player/camera.js` (PLAYER)

```js
export class ThirdPersonCamera {
  constructor(camera /* THREE.PerspectiveCamera */, terrain)
  yaw; pitch; zoom;            // zoom 0.6..2.2 multiplier
  addLook(dx, dy, held)        // pixels → radians; held: a touch thumb rests on the look pad
                               // (holds off the touch auto-follow even without movement)
  addZoom(delta)
  update(dt, creature)         // smooth orbit-follow at head height; distance scales with creature size;
                               // never below terrain/water surface; slow orbit when dead
  forward(target)              // horizontal unit vector the camera looks along (for movement)
  cinematic(dt, terrain)       // attract-mode flight over the island for the title screen
  shake(amount)
}
```
In a cave the follow camera never rises above the focus, pulls in at once when rock
blocks the view, and is clamped `CEILING_CLEARANCE` (0.75 m) under `terrain.ceilingAt`:
it never shows the outside through the roof. On top of a cave it rides the hillside.

### `player/player.js` (PLAYER)

```js
export class PlayerController {
  constructor({ world, input, camera /* ThirdPersonCamera */, audio = null })
  creature;                    // possessed Creature
  prompt;                      // string | null — context hint for the HUD ("Hold E to drink", "Salt water", ...)
  sniff;                       // { active, cooldown, timeLeft, markers: [{ x, y, z, kind: "water"|"plant"|"carcass"|"creature", threat, label }] }
  possess(creature)
  update(dt)                   // input → camera look/zoom + creature.intent (camera-relative), actions, sniff, prompt
}
```

### `ui/hud.js`, `ui/menu.js`, `ui/map.js` (UI)

```js
export class Hud {
  constructor(root, { events, isTouch })
  show(); hide();
  update(dt, { player, controller, world, camera })  // bars, growth, status chips, compass, prompt, sniff markers, vignette
  toast(text, kind = "info")                           // "info" | "good" | "warn" | "danger"
  showDeath(summary, onRespawn, onMenu); hideDeath();  // summary = { speciesName, growth, survivedSec, kills, cause }
  showPause(onResume, onQuit, onSettings); hidePause(); // onSettings (optional) adds a Settings item
  toggleHelp(force);                                   // field notes: open (true), close (false), or toggle
}
export class Menu {
  constructor(root, { species /* SpeciesDef[] (playable, in order) */ })
  show({ save = null } = {}); hide();                  // save = { speciesId, speciesName, growth, day } | null
  onStart = (speciesId, { creative }) => {};  onContinue = () => {};  // creative: the title's Creative card
  showChangelog()     // the title's Changelog link: ui/changelog.js CHANGELOG ({ v, date, title, notes[] }, newest first)
  setLoading(progress /* 0..1 */, label)               // loading state before the world is ready
  settings;                                            // { style: "retro"|"detailed"|"pixel", quality: "auto"|"high"|"low",
                                                       //   muted: bool, sensitivity: 0.5..2, styleVersion: 2 } — a Settings panel on the title
  onSettingsChange = (settings) => {};                 //   screen (and reachable from pause) edits these; main applies + saves
}
export class MapView {
  constructor(root, terrain, { landmarks } = {}) // landmarks: drawn as named glyphs (bones / stone)
  open; toggle(); close();
  update(dt, { player, cameraYaw, markers })
}
```
The map's terrain readout names the biomes *Coast*, *Plains* (*Upland meadow* above
45 m), *Forest* and *Bare rock*; the legend lists the old bones and the stone wonders.
**Design tokens** (UI defines them on `:root` in `style.css` — the safe areas and gutters on
`#app`, since they're measured in the app frame):
`--font-display`, `--font-ui`, `--font-mono`, `--c-bone`, `--c-paper`, `--c-ink`, `--c-moss`,
`--c-ochre`, `--c-rust`, `--c-blood`, `--c-panel` (translucent dark panel bg), `--c-line`
(hairline colour), `--radius`, `--shadow`, `--blur`, `--ease`, `--safe-b` (bottom safe area).

The HUD subscribes to `events` for toasts (growth stages, new day, kills, low
stats, leg break) and the damage vignette.

### `audio/audio.js` (AUDIO)

```js
export class AudioEngine {
  constructor(events)
  start()                 // call from a user gesture; creates/resumes the AudioContext
  muted; setMuted(bool);
  update(dt, { listener /* THREE.Camera */, player /* Creature|null */, world })
}
```
Everything synthesised with Web Audio (no files): ambient beds crossfaded by
`sky.daylight` (wind, birds by day, insects/frogs by night, surf near the coast,
water near lakes), player footsteps scaled by mass and gait, spatialised species
calls (distance attenuation + stereo pan vs. listener yaw; smaller = higher
pitch), bites/hits, eating/drinking, growth chime, low-health heartbeat.
Under a cave roof (listener below `terrain.ceilingAt`) the outdoor beds fade (× 1 − 0.82·cave),
effects are sent into a short multi-tap cave echo and water drips fall now and then.

### `world/world.js` & `main.js` (INTEGRATION)

```js
export class World {
  constructor({ scene, camera, renderer, seed, quality })
  scene; camera; renderer; quality; seed; events /* EventBus */; rng; time;
  terrain; water; vegetation; sky; ecosystem;
  wind;                   // Wind (world/wind.js) — scent drift for the AI's smell; AI guards for null
  landmarks;              // Landmarks (world/landmarks.js), built before the vegetation
  atmosphere;             // Atmosphere (world/atmosphere.js), built after it
  get player()            // ecosystem.player
  update(dt, focus)       // sky → landmarks → vegetation → atmosphere → ecosystem → water
}
```
`main.js` boots the renderer (ACES tone mapping, sRGB, PCF soft shadows when
enabled), owns the render style (`"retro"`, the default: a sub-HD drawing buffer
drawn through `RetroPass` and upscaled smoothly by CSS; `"pixel"`: a small drawing
buffer upscaled by CSS nearest-neighbour; `"detailed"`: full resolution — those two
draw straight to the canvas, no post pass), keeps the look's screen size current
(`setLookScreen`), picks quality, builds the world, runs the state machine
(`menu` → `playing` ⇄ `paused` → `dead`), saves/loads, handles resize/visibility,
and exposes a test hook `window.__underfern`.

URL params: `?species=<id>` autostart · `?growth=0..1` · `?t=0..1` time of day
(pauses the clock) · `?seed=N` · `?quality=low|high` · `?style=retro|detailed|pixel` · `?pixel=0..1` ·
`?debug=1` (fps/overlay) · `?pos=x,z` spawn position · `?mute=1` ·
`?weather=clear|fair|overcast|misty` (hold one weather) · `?aurora=0|1` (force tonight's aurora off / on).

---

## Events (`world.events`)

| name | payload |
| --- | --- |
| `damage` | `{ target, source, amount, type }` — type: `"bite" \| "tail" \| "kick" \| "starve" \| "dehydrate" \| "drown" \| "bleed" \| "fall"` |
| `death` | `{ creature, cause, killer }` |
| `attack` | `{ attacker, target /* Creature or null on whiff */, damage, kind /* "bite"\|"tail"\|"kick" */ }` |
| `call` | `{ creature, x, z }` |
| `eat` | `{ creature, kind: "meat" \| "plant", amount }` — throttled (≤ 2/s per creature) |
| `drink` | `{ creature, amount }` — throttled |
| `grow` | `{ creature, stage }` — when crossing into subadult / adult |
| `legBreak` | `{ creature }` |
| `notify` | `{ text, kind }` — anything that should toast on the HUD |
| `newDay` | `{ day }` |
| `groupJoined` | `{ creature, group, formed, resumed }` — the player hatched into (`formed`) or called its way into a herd / pack |
| `groupStray` | `{ creature, group }` — the player has drifted out of reach of every mate |
| `groupLeft` | `{ creature, group, reason: "strayed" \| "lost" }` — strayed too long, or every mate is gone |
| `groupLead` | `{ creature, group }` — the full-grown player has taken the lead of its herd / pack |
| `herdAlarm` | `{ group, threat, by }` — a mate sensed danger; sent for a group the player is in (one at a time, the same danger not again for 20 s) |
| `herdRoute` | `{ group, leg: "water" \| "graze" \| "shelter" }` — the NPC leader of the player's herd sets off on a leg of its daily round |
| `spawn` | `{ creature }` |
| `sniff` | `{ creature }` |

Large per-frame things (footsteps, gait) are polled, not evented.

---

## Additions after integration

- `Menu.settingsOpen` — true from the moment the settings panel opens.
- `Menu.settings.pixelSize` (0 fine … 1 chunky, default 0.5) — the pixel render style
  blends the render resolution between full and chunky; `?pixel=0..1` overrides it.
- Test hook: `window.__underfern.advance(seconds, dt = 0.05)` runs the state machine
  without drawing. `node tests/run-tests.mjs` runs unit + smoke tests headlessly.
  `window.__underfern.retro` is the Retro HD post pass (null in the other styles);
  its `stats()` reads back mean colours of the scene target and the wide bloom.
- `core/migrate.js` `migrateSettings(s)`: settings saved before Retro HD became the
  default (no `styleVersion`) move from Pixel to Retro HD once; a Pixel choice made
  after that sticks.
- **Three living biomes.** `beach`, `swamp` and `highland` are gone: the beach widened
  into the `coast` belt, swamps became wet forest (still `forest`; mud, horsetails and
  frogs by moisture), highland plateaus became upland meadow (`plains`). Everything
  that names biomes uses the new set — species `biomes`, the ecosystem's shore
  weighting (`coast`), the AI's cover (`forest` hides; `plains` and `coast` are open),
  vegetation tables, audio (footsteps by `coastAt`, slope and moisture), the map.
- **The painterly look, landmarks and atmosphere** (`look.js`, `landmarks.js`,
  `atmosphere.js`; see their contracts above) — in-material lighting and haze, six
  deterministic wonders with colliders, and the small lights and airs; plus the Sky's
  daily weather and auroras.
