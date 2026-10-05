# Sauria — architecture & module contract

Sauria is a single-player, third-person **dinosaur survival** game for the browser,
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
- **Art direction:** stylised low-poly, flat-shaded, vertex-coloured. Moody and
  atmospheric — muted greens, ochre grasslands, dark conifer forests, soft golden
  fog at dawn, deep blue moonlit nights. Think *The Isle* mood with a clean,
  designed, slightly painterly low-poly look. Fog does a lot of the work.

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
sauria/
  index.html            UI      import map, <canvas id="game">, <div id="ui">, loads src/main.js
  style.css             UI      all CSS (HUD, menu, map, touch controls, overlays)
  icon.svg              UI
  src/config.js         (shared, done)
  src/core/rng.js       (shared, done)
  src/core/math.js      (shared, done)
  src/core/events.js    (shared, done)
  src/core/noise.js     TERRAIN
  src/world/terrain.js  TERRAIN
  src/world/water.js    ATMOSPHERE
  src/world/sky.js      ATMOSPHERE
  src/world/vegetation.js VEGETATION
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
behind the menu) → pick one of six playable species → spawn as a **juvenile** in a
safe-ish spot → survive. Keep `food` and `water` up, avoid or fight predators,
**grow** (≈20–35 real minutes to adulthood when fed and watered). Getting bigger
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
  costs 8 stamina. Damage = `bite · lerp(0.12, 1, growth)`, reduced by the target's
  `armor`, plus bleeding = `bleed · lerp(0.12, 1, growth)`. Front cone ~70° for
  bite/kick; rear/side arc for tail attacks.
- **Sniff** (player ability): reveals nearby food (diet-appropriate), the nearest
  fresh water, and creatures within ~120 m as on-screen markers for a few seconds;
  cooldown ~12 s.
- **Call**: species-specific vocalisation. NPCs of the same species may call back
  from the distance; herbivores near a carnivore's call get nervous.
- **Crouch** = slower and harder for AI to notice. **Rest** = lie down to regen
  faster (vulnerable).
- **Swimming**: water deeper than ~0.8× hip height → swim. Good swimmers
  (Ceratosaurus) are fast in water.
- **Day/night**: a full day is `TIME.dayLengthSec` (16 min). Nights are dark but
  moonlit; carnivores roam more at night, herbivores rest more.

**Species** (`species.js`). Playable, in menu order:

| id | name | diet | adult length/mass | role |
| --- | --- | --- | --- | --- |
| `dryosaurus` | Dryosaurus | herbivore | 3.5 m / 90 kg | tiny, very fast, fragile; herds |
| `utahraptor` | Utahraptor | carnivore | 6 m / 500 kg | agile pack hunter, bleed bites |
| `gastonia` | Gastonia | herbivore | 5 m / 1.5 t | armoured tank (armor 0.55), spiky counter |
| `ceratosaurus` | Ceratosaurus | carnivore | 7 m / 900 kg | ambusher, excellent swimmer |
| `stegosaurus` | Stegosaurus | herbivore | 9 m / 4.5 t | slow, tail-spike swipes cause heavy bleed |
| `allosaurus` | Allosaurus | carnivore | 9.5 m / 2.3 t | apex predator |

NPC-only: `camptosaurus` (common herding prey, 6 m / 700 kg) and `diplodocus`
(gentle 26 m giant, rare, tail whip when threatened).
(A Utah touch: Allosaurus is Utah's state fossil; Utahraptor and Gastonia come
from Utah's Cedar Mountain Formation; the rest roamed the Morrison Formation.)

---

## Module contracts

### `core/noise.js` (TERRAIN)

```js
export function createNoise2D(seed)            // → (x, y) => number in [-1, 1] (simplex)
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) // ≈ [-1, 1]
export function ridged2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) // [0, 1]
```

### `world/terrain.js` (TERRAIN)

```js
export const BIOMES = ["ocean", "lake", "beach", "plains", "forest", "swamp", "highland", "rock"];

export class Terrain {
  constructor({ size, resolution, seed, seaLevel, maxHeight })
  size; half; resolution; cellSize; seaLevel; maxHeight;
  heights;            // Float32Array, (resolution+1)², index = iz*(resolution+1) + ix, x = -half + ix*cellSize
  mesh;               // THREE.Mesh — vertex coloured, flatShading, receiveShadow
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
                      // near = { x, z, minR, maxR } restricts to a ring
  nearestFreshWater(x, z, maxRadius = 400) // → { x, z, dist } | null — a LAND point on the shore
                      // of fresh water (stand there, face the water, drink). Precompute & bucket.
  mapCanvas(px = 512) // → HTMLCanvasElement: shaded-relief overview map (water, biomes, hillshade)
}
```

Island shape: one main landmass (~0.42 × size radius) with a noisy coastline and
beaches; a ridged mountain range with highlands and rock on steep faces; rolling
plains; forest bands; swampy lowlands; **3–5 freshwater lakes** and **1–2 rivers**
carved below sea level (fresh). A few small offshore islets are welcome.

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

### `world/sky.js` (ATMOSPHERE)

```js
export class Sky {
  constructor(scene, { startPhase, dayLengthSec, viewDistance, shadows, shadowMapSize })
  phase; day;               // day = whole days elapsed (starts at 1)
  paused;                   // freeze time
  sunLight;                 // THREE.DirectionalLight — sun by day, moon (cool, dim) by night; castShadow per option;
                            // shadow camera ≈ ±60 m box following the focus; its .target is added to the scene
  hemiLight;                // THREE.HemisphereLight
  sunDirection;             // THREE.Vector3 unit vector toward the sun (may be below horizon)
  sunColor; skyColor; fogColor; // THREE.Color
  daylight;                 // 0 (night) .. 1 (full day)
  update(dt, focus, camera) // advance time, move lights/shadow box to focus, dome follows camera, set scene.fog
  setPhase(p)
  isNight()                 // daylight < 0.25
  timeLabel()               // "dawn" | "morning" | "midday" | "afternoon" | "dusk" | "night"
  clockString()             // "06:30"
}
```
Owns `scene.fog` (`THREE.Fog`, far ≈ viewDistance, thicker mist at dawn/night) and a
sky dome (gradient, sun disc + glow, moon, stars at night, optional soft clouds;
`fog: false`, `depthWrite: false`, radius ≤ 1500 — camera far is 2000).

### `world/vegetation.js` (VEGETATION)

```js
export class Vegetation {
  constructor(terrain, { seed, density = 1, grass = true })
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
max per second after eaten. Biome-driven placement (dense conifer/araucaria forest,
scattered trees + ferns on plains, horsetails & dead snags in swamps, sparse
conifers + boulders on highlands, cycads/palms near beaches). Spatial hashing for
queries. Respect `density`.

### `creatures/species.js` (DINO-ART)

```js
export const SPECIES;            // { [id]: SpeciesDef }
export const PLAYABLE;           // ["dryosaurus","utahraptor","gastonia","ceratosaurus","stegosaurus","allosaurus"]
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
  spawnWeight, biomes: [..preferred],
  call: { kind: "roar" | "bellow" | "honk" | "chirp" | "shriek" | "hoot", pitch /* Hz */, duration /* s */ },
  colors: { ... }, body: { ... }         // model-only, free-form (DINO-ART decides)
}
```

### `creatures/dinoModel.js` (DINO-ART)

```js
export function createDinoModel(species, { seed = 1, variant = 0 } = {}) // → DinoModel
export class DinoModel {
  object;                 // THREE.Group; origin on the ground under the hips; faces +Z; built at ADULT size (m)
  setScale(s)
  getHeadPosition(target) // world position of the mouth/snout tip (after scale & parent transforms)
  getTailPosition(target) // world position near the tail tip
  setTint(color, amount)  // e.g. darken a rotting carcass
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
Procedural low-poly meshes from a joint hierarchy (hips → spine → chest → neck →
head/jaw; tail chain; 2 or 4 legs with thigh/shin/foot; arms). Procedural animation:
gait cycles by distance travelled, tail sway, breathing, head bob, jaw open on
bite/call, lie down on rest, fall on side when dead. Each species must read
clearly from a third-person camera (stego plates & thagomizer, gastonia spikes/
armour, cerato nasal horn, allo brow crests, raptor feathers + sickle claw,
diplodocus neck). Colour variants per individual (seeded).

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
  takeDamage(amount, source /* Creature|null */, type) // → damage dealt after armor; emits "damage"
  heal(amount)
  die(cause, killer = null)  // emits "death"
  dispose()
}
```
Movement: creatures turn toward the desired direction at `turnRate` (juveniles
turn faster) and move along their heading (no strafing); acceleration is smoothed;
snapped to `terrain.heightAt`; uphill slows, slope > ~0.7 blocks; circle collisions
against `vegetation.collidersNear` and other creatures; clamped inside the island
tile. NPC metabolism ×0.35.

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
  update(dt, focus)   // population upkeep around focus (spawn ring GAME.npcSpawnMin..Max, despawn > npcDespawn,
                      // species weights × biome preference, groups), brains → creatures, carcass rot
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
Herbivores graze, drink, herd (cohesion around the leader), rest at night, flee
from threatening carnivores (bigger ones flee less; Stegosaurus/Gastonia/Diplodocus
turn and fight when attacked or cornered). Carnivores roam, hunt when hungry
(prefer prey they can handle, avoid big herds), eat carcasses, attack the player
based on aggression/relative size, packs coordinate loosely. Everyone avoids
steep slopes, the island edge and (unless good swimmers or chasing) deep water.
Perception shrinks for a crouching player and at night. Listen to `"call"` events
(answer same-species calls, herbivores get alert near carnivore calls) and react
to being damaged (`lastAttacker`).

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
CSS for these classes lives in `style.css` (UI).

### `player/camera.js` (PLAYER)

```js
export class ThirdPersonCamera {
  constructor(camera /* THREE.PerspectiveCamera */, terrain)
  yaw; pitch; zoom;            // zoom 0.6..2.2 multiplier
  addLook(dx, dy)              // pixels → radians
  addZoom(delta)
  update(dt, creature)         // smooth orbit-follow at head height; distance scales with creature size;
                               // never below terrain/water surface; slow orbit when dead
  forward(target)              // horizontal unit vector the camera looks along (for movement)
  cinematic(dt, terrain)       // attract-mode flight over the island for the title screen
  shake(amount)
}
```

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
  showPause(onResume, onQuit); hidePause();
  toggleHelp();
}
export class Menu {
  constructor(root, { species /* SpeciesDef[] (playable, in order) */ })
  show({ save = null } = {}); hide();                  // save = { speciesId, speciesName, growth, day } | null
  onStart = (speciesId) => {};  onContinue = () => {};
  setLoading(progress /* 0..1 */, label)               // loading state before the world is ready
}
export class MapView {
  constructor(root, terrain)
  open; toggle(); close();
  update(dt, { player, cameraYaw, markers })
}
```
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

### `world/world.js` & `main.js` (INTEGRATION)

```js
export class World {
  constructor({ scene, camera, renderer, seed, quality })
  scene; camera; renderer; quality; seed; events /* EventBus */; rng; time;
  terrain; water; vegetation; sky; ecosystem;
  get player()            // ecosystem.player
  update(dt, focus)       // sky → vegetation → ecosystem → water
}
```
`main.js` boots the renderer (ACES tone mapping, sRGB, PCF soft shadows when
enabled), picks quality, builds the world, runs the state machine
(`menu` → `playing` ⇄ `paused` → `dead`), saves/loads, handles resize/visibility,
and exposes a test hook `window.__sauria`.

URL params: `?species=<id>` autostart · `?growth=0..1` · `?t=0..1` time of day
(pauses the clock) · `?seed=N` · `?quality=low|high` · `?debug=1` (fps/overlay) ·
`?pos=x,z` spawn position · `?mute=1`.

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
| `spawn` | `{ creature }` |
| `sniff` | `{ creature }` |

Large per-frame things (footsteps, gait) are polled, not evented.
