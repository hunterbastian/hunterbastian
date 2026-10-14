# Underfern

**Underfern** is a 3D dinosaur survival game that runs in your browser. You hatch
on a misty island out of time, where animals some eighty million years apart share
one coast, and have to eat, drink, hide, fight and grow from a fragile juvenile
into a full-grown adult, while carnivores and herbivores driven by their own AI
hunt, graze, herd and sleep around you.

The look is a mysterious, painterly island somewhere between *Breath of the Wild*
and *Skyrim*. Warm sunlight falls on cool blue-violet shadows, and a rim of light
picks the dinosaurs out against the land. Lush grass ripples as gusts roll across
it, and the hills fade into blue-green haze. Painted clouds drift overhead and the
light turns gold at either end of the day. The peaks are snow-capped, mist lies in
the valleys at dawn and cloud clings to the summits. Every day has its own weather,
and some clear nights end under green and violet auroras. Nothing on the island
was ever built. Its wonders are colossal fossils half-buried in the grass, sea
stacks, a stone arch, basalt columns, glowing fungi in the caves and fireflies in
the woods at dusk.

You play as one of eight dinosaurs, in third person.

The default look is **Pixel**: the 3D scene is drawn at a few hundred pixels tall
and scaled up with crisp nearest-neighbour edges (a late-'90s look), while the
interface stays sharp. You can set the pixel size, or switch to **Detailed** for
full resolution.

There's no build step and there are no npm dependencies. It's plain ES modules plus
a vendored copy of three.js. Everything is procedural: the island, the forests,
the dinosaurs' bodies and skins, the textures, and every sound (Web Audio, no
files). The UI loads three web fonts from Google Fonts (Fraunces, Archivo and
IBM Plex Mono). Offline, it falls back to system fonts and still works.

## Run it

Browsers won't load ES modules or import maps from `file://`, so serve the folder
with any static server:

```bash
cd underfern
python3 -m http.server 8000
# then visit http://localhost:8000
```

or `npx serve underfern`. It runs best in a current Chrome, Edge, Firefox or Safari
(desktop or iOS/Android) with WebGL 2. The layout uses CSS container queries, so
it needs Safari 16 / iOS 16 or newer (Chrome 105+, Firefox 110+).

## Deploy (Vercel)

Underfern is a self-contained static site, so it needs no build.

**Dashboard (recommended):** import the repo at [vercel.com/new](https://vercel.com/new),
then set **Root Directory → `underfern`** and **Framework Preset → Other**. Deploy.
Once the repo is connected, Vercel publishes a preview URL for every branch/PR and
a production URL from `main` (the same setup as `../aria`).

**CLI:**

```bash
cd underfern
npx vercel        # preview deploy
npx vercel --prod # production deploy
```

The included `vercel.json` turns on clean URLs and sets caching: `vendor/` (three.js)
is cached for a year as immutable, and everything else revalidates on every load,
so a new deploy reaches players right away. If you upgrade three.js, rename its
folder (for example `vendor/three-r181/`) and update the import map in
`index.html`. Otherwise returning players keep the old copy.

**GitHub Pages / any static host:** every path in the game is relative, so it also
works from a sub-path (`https://<user>.github.io/<repo>/underfern/`). Publish the repo,
or just the `underfern/` folder, as is.

**On iPhone / Android:** open the site in Safari or Chrome and use *Add to Home
Screen*. It launches full-screen like a native game (web manifest + apple-touch
icon).

Underfern always plays in **landscape**. iOS can't lock a web page's orientation,
so on a phone held upright the game turns itself sideways: turn the phone
counter-clockwise (home indicator on the right) to play. This works with
Portrait Orientation Lock on, and if rotation is unlocked the phone simply
switches to landscape and the game lays out normally. On Android, starting a
game also asks Chrome to lock landscape when it's full-screen or installed.

## Survival

Pick a species on the title screen and you hatch as a **juvenile** somewhere calm,
usually near a freshwater lake. Then:

- **Eat and drink.** Food and water drain all the time, twice as fast while
  sprinting and half as fast while resting. Carnivores eat carcasses and herbivores
  graze ferns, cycads, horsetails and shrubs. To eat or drink, hold the action with
  your head at the food or at the water's edge. Lakes and rivers are fresh. The
  sea is salt and doesn't help.
- **Grow.** You grow only while food and water stay above 25%. Juvenile → sub-adult
  (40%) → adult takes 20–50 real minutes depending on the species. Bigger means
  more health, harder bites and fewer things that see you as lunch.
- **Stay alive.** At 0 food you starve, at 0 water you dehydrate, and in deep water
  with no stamina you drown. Bites cause **bleeding** that slowly clots. Resting
  clots it faster and triples health regeneration (regeneration needs food and water
  above 30%). Big falls can break a leg.
- **Fight or flee.** Each species attacks its own way: a bite, a kick or a tail
  swipe, softened by the target's armour. A Tyrannosaurus bite crushes through
  half of it.
- **Run with your own kind.** Herd and pack species (Dryosaurus, Stegosaurus,
  Brontosaurus, Utahraptor) hatch among adults of their kind. The herd keeps
  watch, waits for you and wades in when you're attacked, and a raptor pack
  joins whatever you bite. Wander off for too long and you lose them. **Call**
  brings your group back to you, and calling near another group of your kind
  joins it. The HUD badge and a compass pin show where they are.
- **Use your senses.** **Sniff** marks nearby food, the nearest fresh water and
  other creatures for a few seconds. **Call** lets others of your species answer
  from the distance. Herbivores get nervous when they hear a carnivore. **Crouch**
  to be harder to notice.
- **Day and night.** A full day lasts 16 minutes. Nights are dark but moonlit.
  Carnivores roam more after dark and herbivores bed down.

Death leaves your body on the island as a carcass and shows a field record (time
survived, growth, kills, cause). *Hatch again* to try another life. Progress
autosaves on the device, and **Continue** on the title screen picks up a living
character where you left it.

### The dinosaurs

Playable, in menu order:

| Species | Diet | Adult size | Plays like |
| --- | --- | --- | --- |
| **Dryosaurus** | herbivore | 3.5 m · 90 kg | Tiny and fragile but the fastest thing on the island. Stay with the herd. |
| **Utahraptor** | carnivore | 6 m · 500 kg | Agile pack hunter; feathered, with a sickle claw and bleeding bites. |
| **Ceratosaurus** | carnivore | 7 m · 900 kg | Horned ambusher of the wet woods and riverbanks, and an excellent swimmer. |
| **Stegosaurus** | herbivore | 9 m · 4.5 t | Slow and steady; its tail spikes cause terrible bleeding. |
| **Allosaurus** | carnivore | 9.5 m · 2.3 t | Utah's state fossil, and the Jurassic's apex predator. |
| **Brontosaurus** | herbivore | 22 m · 15 t | Hatches the size of a dog and grows into a mountain. |
| **Tyrannosaurus rex** | carnivore | 12 m · 8 t | The hardest bite on the island, crushing through armour, and a nose for carrion at a distance. A fleet hatchling that grows into a slow, quickly tiring crusher (the slowest to grow up). |
| **Spinosaurus** | carnivore | 14 m · 7 t | The longest hunter: sail-backed, short-legged and slow on land, the best swimmer on the island. Ambushes at the water's edge. |

NPC-only: **Camptosaurus** (6 m, the common herding prey everything eats) and
**Diplodocus** (a rare, gentle 26 m giant with a whip of a tail). Tyrannosaurus
and Spinosaurus also roam wild, rarely and almost always alone.

An island out of time: its animals never shared a coast. Allosaurus, Stegosaurus,
Dryosaurus, Ceratosaurus, Camptosaurus and the two sauropods roamed the Late
Jurassic Morrison Formation, about 150 million years ago. Utahraptor hunted Utah's
Cedar Mountain Formation early in the Cretaceous. Spinosaurus waded the rivers of
North Africa (Kem Kem and Bahariya) 99–93 million years ago, and Tyrannosaurus rex
was among the very last dinosaurs, in the Hell Creek Formation 68–66 million years
ago. Allosaurus is still Utah's state fossil.

### The island

The island has three living biomes around a central **massif**:
- **Coast**: a wide belt of beach, dunes held by marram grass, and salt grass with
  palms, cycads and driftwood.
- **Plains**: open grassland, mostly green with golden patches, rising to upland
  meadows on the massif's lower slopes.
- **Forest**: dark conifer and araucaria woods, wet and fern-filled in the lowlands.

Freshwater lakes and rivers run between them. The massif has three or four horn
peaks up to about 190 m, snow-capped and joined by a jagged ridge. Its sides are
bands of layered rock, and the cliffs are too steep to climb. One or two pass
valleys cut right through the range, and switchback trails climb to **lookouts**
high on the ridge, with the whole island below.

The island's **landmarks** are all from deep time, older and far bigger than
anything alive on it:
- the bones of colossal animals: a ribcage you can walk through, a great
  half-buried skull and a buried neck arching out of the grass;
- a natural stone arch, sea stacks standing in the shallows and a basalt causeway.

Creatures walk around the landmarks, and nothing spawns inside one.

There are **caves** to find: a great cavern with a skylight, a tunnel with a mouth at
each end and a few small dens. A den's mouth is barely 3 m high, so a raptor can rest
inside but an adult Allosaurus can't follow it in, and nothing the size of a
Brontosaurus gets into any of them. Inside it's dark and echoing. Light falls in
shafts through the skylight, and deep in, glowing lichen and pale fungi are the only
light. Nothing spawns there.

The map (M) marks:
- the summits, with their heights;
- the passes and the trails to the lookouts;
- the cave mouths;
- the landmarks, by name.

Every island comes from its seed (`?seed=N`), and so does each day's weather:
clear, fair, overcast or misty.

## Controls

The in-game **Field notes** (H, or from the pause menu) show the same list.

**Keyboard & mouse**

| Action | Keys |
| --- | --- |
| Move | WASD / arrows |
| Look | Mouse (click the island to capture it) |
| Sprint · crouch | Shift · C (toggle) or hold Ctrl |
| Attack | Left click or F (bite / kick / tail) |
| Eat · drink | Hold E |
| Call | Q |
| Sniff | R |
| Rest | Z |
| Map · zoom | M · mouse wheel |
| Pause · field notes | Esc or P · H |

**Touch** (phones and tablets, always landscape)

- **Move:** put your thumb anywhere on the left half. The stick appears where you
  touch.
- **Look:** drag across the right half.
- **Buttons:** a big **Bite** button bottom right, ringed by **Eat/Drink**
  (hold near food or fresh water), **Sprint** (tap, then lift the stick to stop),
  **Crouch**, **Sniff**, **Call** and **Rest**. **Map** and **Pause** sit top
  right.

## Graphics & settings

Open **Settings** from the title screen or the pause menu. Settings are saved on the
device.

- **Graphics style:**
  - **Pixel** (default): low-resolution render with a crisp nearest-neighbour
    upscale.
  - **Detailed**: full resolution (antialiased on High quality), with soft light
    and fine surface detail.
- **Pixel size:** *Fine*, *In between* (default) or *Chunky*, applied live.
  Pixels stay square and even on any screen.
- Both styles have the same lighting, mist, haze and colour grade. They are
  computed in each surface's own shader rather than in a post-processing pass, so
  they cost nothing extra on a phone.
- **Quality:**
  - *Auto* picks *Low* on phones, small screens and ≤ 4-core machines (lighter
    terrain, sparser vegetation, no grass or shadows, fewer dinosaurs) and *High*
    elsewhere.
  - Quality changes apply the next time the game loads.
- **Sound** on/off, and **Look sensitivity**.

### Deep links

URL parameters, handy for sharing a moment or testing:

| Param | Effect |
| --- | --- |
| `?species=<id>` | skip the menu and hatch as that species (`dryosaurus`, `utahraptor`, `ceratosaurus`, `stegosaurus`, `allosaurus`, `brontosaurus`, `tyrannosaurus`, `spinosaurus`) |
| `?growth=0..1` | starting growth for `?species` |
| `?pos=x,z` | spawn position in metres |
| `?t=0..1` | time of day (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset); pauses the clock |
| `?style=pixel\|detailed` · `?pixel=0..1` | render style · pixel size |
| `?quality=low\|high` | force a quality profile |
| `?seed=N` | a different island |
| `?weather=clear\|fair\|overcast\|misty` | hold one weather instead of the day's own |
| `?aurora=0\|1` | force tonight's aurora off or on |
| `?mute=1` · `?debug=1` | start muted · fps / draw-call overlay |
| `?rotate=0\|1` | never turn the game sideways on a phone held upright · turn it for any portrait window (testing on desktop) |

For example, `index.html?species=allosaurus&growth=1&t=0.27` drops you in as an
adult Allosaurus at dawn, and `?species=dryosaurus&t=0.27&weather=misty` shows a
dawn in thick valley mist.

## Tests

```bash
cd underfern
node tests/run-tests.mjs            # everything (a few minutes)
node tests/run-tests.mjs --unit     # unit tests only (seconds)
node tests/run-tests.mjs --smoke    # smoke tests only
node tests/run-tests.mjs --only touch
```

It needs Node 18+ and Playwright with Chromium (`npm i -g playwright && npx
playwright install chromium`). The runner uses a local `playwright` package if
there is one and otherwise falls back to the global install.

- The runner starts a small static server on a free port and launches headless
  Chromium with software WebGL (SwiftShader).
- **Unit tests** (`tests/unit.html`, also viewable in a browser) cover:
  - the seeded RNG and noise
  - terrain determinism and its queries (height, normals, the three living
    biomes and the coastal belt, fresh water, spawn points)
  - landmark placement: same seed, same places, always on dry ground and clear of
    caves, lakes, rivers, passes and trails, with colliders that creatures bump
    into and keep-outs that spawns respect
  - the weather schedule: one deterministic state per day, every kind turns up,
    and auroras only follow clear or fair days
  - every species definition
  - wind/scent
  - creature metabolism, damage, armour and death, the ecosystem's carcass flow
    and its caps on rare species, on a real low-resolution world
- **Smoke tests** play the real game:
  - the title screen: Survival → choose a species → Hatch, and a saved life
    (Continue) whose species has left the island
  - survival in both render styles, keyboard movement, pause, and death → death
    screen → hatch again
  - an iPhone-sized touch run (joystick, pause button, Pixel-size slider)
  - an upright iPhone: the game turns sideways, the drawing buffer stays
    landscape, and pushing the stick toward the phone's right edge (the app's
    top) walks forward
- Screenshots land in `tests/out/` (gitignored). The run prints a PASS/FAIL summary
  and exits non-zero on failure. Any console error counts as a failure.

Software rendering is slow (about 1–3 fps), so the smoke tests fast-forward game
time through the `window.__underfern` test hook instead of waiting on frames.

## How it works

Plain ES modules under `src/`, loaded by `index.html` through an import map:

- `main.js`: boot, the game state machine (menu → playing ⇄ paused → dead), the
  render-style pipeline, saves and the `window.__underfern` test hook
- `core/screen.js`: the app frame (`#app`). On a phone held upright it lays the
  game out at landscape size and rotates it 90°; everything that reads pointer
  positions or the screen size goes through it
- `world/`:
  - terrain: a heightfield island with a mountain massif, passes, trails, lakes
    and rivers, and a procedural surface shader with painted rock, strata and
    snow
  - caves: carved floors under rock vaults, with a clearance and darkness query
  - water
  - sky: day and night, the weather and auroras
  - vegetation: instanced forests and food plants
  - wind
  - `look.js`: the painterly lighting, mist, haze and grade shared by every
    material
  - `landmarks.js`: the fossils and stone wonders
  - `atmosphere.js`: fireflies, light shafts, peak wisps and cave fungi
- `creatures/`:
  - species data and the procedural skinned dinosaur models
  - the shared survival simulation (`creature.js`)
  - AI brains with sight, hearing and smell
  - the ecosystem that spawns herds and packs around you and turns the dead into
    carcasses
- `player/`: input (keyboard, mouse, touch), the third-person camera, the player
  controller
- `ui/`: HUD, title menu and settings, map. `audio/` synthesises every sound with
  Web Audio.

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the full module map and the contract
between modules: exported APIs, units, conventions, events and the game-design
numbers.

## Credits

- [three.js](https://threejs.org) r180 (MIT), vendored in `vendor/three/` with its
  `LICENSE`.
- Fonts: Fraunces, Archivo and IBM Plex Mono via Google Fonts (SIL Open Font
  License).
- Inspired by *The Isle* (Afterthought). Underfern is an independent fan project,
  not affiliated with it.
- The art direction nods to *The Legend of Zelda: Breath of the Wild* and *The
  Elder Scrolls V: Skyrim*. All of Underfern's art is procedural, and none of it
  comes from either game.
