# Sauria

**Sauria** is a 3D dinosaur survival game that runs in your browser. You hatch
on a misty Late Jurassic island and have to eat, drink, hide, fight and grow from
a fragile juvenile into a full-grown adult, while carnivores and herbivores driven
by their own AI hunt, graze, herd and sleep around you. It leans on the moody
naturalism of *The Isle*: ochre grasslands, dark conifer forests, golden dawn mist
and deep blue moonlit nights, with the fog and light doing much of the work.

There are **two ways to play on the same island**:

- **Survival** (*The Isle*-style): play as one of seven dinosaurs, in third person.
- **Hunter** (*Carnivores: Dinosaur Hunter*-style): drop in by helicopter as a
  first-person human hunter, stalk trophies using wind, scent, camouflage and
  calls, and get out before something bigger finds you.

The default look is **Pixel**: the 3D scene is drawn at a few hundred pixels tall
and scaled up with crisp nearest-neighbour edges (a '98 expedition), while the
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
cd sauria
python3 -m http.server 8000
# then visit http://localhost:8000
```

or `npx serve sauria`. It runs best in a current Chrome, Edge, Firefox or Safari
(desktop or iOS/Android) with WebGL 2. The layout uses CSS container queries, so
it needs Safari 16 / iOS 16 or newer (Chrome 105+, Firefox 110+).

## Deploy (Vercel)

Sauria is a self-contained static site, so it needs no build.

**Dashboard (recommended):** import the repo at [vercel.com/new](https://vercel.com/new),
then set **Root Directory → `sauria`** and **Framework Preset → Other**. Deploy.
Once the repo is connected, Vercel publishes a preview URL for every branch/PR and
a production URL from `main` (the same setup as `../aria`).

**CLI:**

```bash
cd sauria
npx vercel        # preview deploy
npx vercel --prod # production deploy
```

The included `vercel.json` turns on clean URLs and sets caching: `vendor/` (three.js)
is cached for a year as immutable, and everything else revalidates on every load,
so a new deploy reaches players right away. If you upgrade three.js, rename its
folder (for example `vendor/three-r181/`) and update the import map in
`index.html`. Otherwise returning players keep the old copy.

**GitHub Pages / any static host:** every path in the game is relative, so it also
works from a sub-path (`https://<user>.github.io/<repo>/sauria/`). Publish the repo,
or just the `sauria/` folder, as is.

**On iPhone / Android:** open the site in Safari or Chrome and use *Add to Home
Screen*. It launches full-screen like a native game (web manifest + apple-touch
icon).

Sauria always plays in **landscape**. iOS can't lock a web page's orientation,
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
  (40%) → adult takes 20–45 real minutes depending on the species. Bigger means
  more health, harder bites and fewer things that see you as lunch.
- **Stay alive.** At 0 food you starve, at 0 water you dehydrate, and in deep water
  with no stamina you drown. Bites cause **bleeding** that slowly clots. Resting
  clots it faster and triples health regeneration (regeneration needs food and water
  above 30%). Big falls can break a leg.
- **Fight or flee.** Each species attacks its own way: a bite, a kick or a tail
  swipe, softened by the target's armour. Gastonia's spikes even hurt whoever bites
  it.
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
| **Gastonia** | herbivore | 5 m · 1.5 t | A walking fortress: heavy armour, spikes that bite back, tail swipe. |
| **Ceratosaurus** | carnivore | 7 m · 900 kg | Horned ambusher of swamps and riverbanks, and an excellent swimmer. |
| **Stegosaurus** | herbivore | 9 m · 4.5 t | Slow and steady; its tail spikes cause terrible bleeding. |
| **Allosaurus** | carnivore | 9.5 m · 2.3 t | Utah's state fossil, and the island's apex predator. |
| **Brontosaurus** | herbivore | 22 m · 15 t | Hatches the size of a dog and grows into a mountain (the slowest to grow up). |

NPC-only: **Camptosaurus** (6 m, the common herding prey everything eats) and
**Diplodocus** (a rare, gentle 26 m giant with a whip of a tail).

A Utah touch: Allosaurus is Utah's state fossil, and Utahraptor and Gastonia come
from Utah's Cedar Mountain Formation. The rest roamed the Morrison Formation.

## Hunter mode

Choose **Hunter mode** on the title screen to plan an expedition:

1. **Loadout:** pick two weapons from those you've unlocked.
2. **Equipment:** each item is optional and lowers the hunt's score multiplier by 10%.
   *Camouflage* (eyes spot you at 60% of the range), *Cover scent* (noses at a
   third), *Radar locator* (pings your quarry within 600 m every ~10 s) and
   *Call device* (mimics your quarry's call to draw it in).
3. **Quarry:** 1–3 target species, which turn up more often and score ×1.5.
4. **Time of day:** dawn, day, dusk or night.

A helicopter flies you in and drops you at a landing zone. You can look around from
the door seat, or skip the ride with E or X. Then it's slow, tense stalking in first
person. **Wind** carries your scent downwind (check the arrow on the compass), so
approach from downwind. Crouching is quiet and sprinting is loud. Gunshots send
herbivores running and draw carnivores in, and the big carnivores will hunt you.

| Weapon | Damage | Magazine | Notes | Unlock |
| --- | --- | --- | --- | --- |
| .44 Revolver | 45 | 6 | Quick in the hand, short range | free |
| Double-Barrel 12ga | 16 × 9 pellets | 2 | Huge spread, devastating up close | free |
| Bolt-Action Rifle | 140 | 5 | 2.5× scope, loud | free |
| Crossbow | 110 | 1 | Near-silent bolts that drop with distance, slow reload | 150 pts |
| .50 Sniper Rifle | 320 | 3 | 6× scope, very loud, heavy sway | 400 pts |

Headshots deal ×2.5 damage, legs and tail ×0.6, and damage falls off past each
weapon's effective range. Armour counts for half against bullets.

**Scoring.** Every kill is a trophy. Its score is the species' trophy value ×
√(its mass ÷ adult mass) × 1.5 for a headshot × 1.5 for a declared target × the
equipment multiplier. **Binoculars** (B) give range and species with an estimated
weight, which helps you choose your shot.

**Extraction.** Press **X** to call the chopper. It arrives after a short flight and
hovers low over the spot you called it to. Walk under it (within 8 m) to get out.
Extracting banks the hunt's score as points, which unlock weapons, and adds every
trophy to the **trophy room** (species, weight, distance, headshot, date). If you
die, you lose that hunt's trophies.

## Controls

The in-game **Field notes** (H, or from the pause menu) show the same list.

**Keyboard & mouse**

| Action | Survival | Hunter |
| --- | --- | --- |
| Move | WASD / arrows | WASD / arrows |
| Look | Mouse (click the island to capture it) | Mouse |
| Sprint · crouch | Shift · C (toggle) or hold Ctrl | Shift · C or hold Ctrl |
| Attack | Left click or F (bite / kick / tail) | Left click or F (fire) |
| Aim · scope | n/a | Right click |
| Eat · drink | Hold E | n/a |
| Call | Q | Q (lure, with the call device) |
| Sniff · reload | R (sniff) | R (reload) |
| Rest | Z | n/a |
| Weapons · binoculars | n/a | 1 / 2 · B |
| Call extraction | n/a | X |
| Map · zoom | M · mouse wheel | M |
| Pause · field notes | Esc or P · H | Esc or P · H |

**Touch** (phones and tablets, always landscape)

- **Move:** put your thumb anywhere on the left half. The stick appears where you
  touch.
- **Look:** drag across the right half.
- **Survival buttons:** a big **Bite** button bottom right, ringed by **Eat/Drink**
  (hold near food or fresh water), **Sprint** (tap, then lift the stick to stop),
  **Crouch**, **Sniff**, **Call** and **Rest**. **Map** and **Pause** sit top
  right.
- **Hunter buttons:** the ring swaps to **Fire**, **Aim**, **Reload**,
  **Binoculars**, **Lure**, **Extract**, **Crouch** and **Sprint**.

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
| `?species=<id>` | skip the menu and hatch as that species (`dryosaurus`, `utahraptor`, `gastonia`, `ceratosaurus`, `stegosaurus`, `allosaurus`, `brontosaurus`) |
| `?growth=0..1` | starting growth for `?species` |
| `?pos=x,z` | spawn position in metres |
| `?hunter=1` | open the Hunter-mode planner |
| `?t=0..1` | time of day (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset); pauses the clock |
| `?style=pixel\|detailed` · `?pixel=0..1` | render style · pixel size |
| `?quality=low\|high` | force a quality profile |
| `?seed=N` | a different island |
| `?mute=1` · `?debug=1` | start muted · fps / draw-call overlay |
| `?rotate=0\|1` | never turn the game sideways on a phone held upright · turn it for any portrait window (testing on desktop) |

For example, `index.html?species=allosaurus&growth=1&t=0.27` drops you in as an
adult Allosaurus at dawn.

## Tests

```bash
cd sauria
node tests/run-tests.mjs            # everything (a few minutes)
node tests/run-tests.mjs --unit     # unit tests only (seconds)
node tests/run-tests.mjs --smoke    # smoke tests only
node tests/run-tests.mjs --only hunter
```

It needs Node 18+ and Playwright with Chromium (`npm i -g playwright && npx
playwright install chromium`). The runner uses a local `playwright` package if
there is one and otherwise falls back to the global install.

- The runner starts a small static server on a free port and launches headless
  Chromium with software WebGL (SwiftShader).
- **Unit tests** (`tests/unit.html`, also viewable in a browser) cover:
  - the seeded RNG and noise
  - terrain determinism and its queries (height, normals, biomes, fresh water,
    spawn points)
  - every species definition
  - wind/scent
  - weapon falloff and hit multipliers
  - creature metabolism, damage, armour and death, and the ecosystem's carcass
    flow, on a real low-resolution world
- **Smoke tests** play the real game:
  - survival in both render styles, keyboard movement, pause, and death → death
    screen → hatch again
  - an iPhone-sized touch run (joystick, pause button, Pixel-size slider)
  - an upright iPhone: the game turns sideways, the drawing buffer stays
    landscape, and pushing the stick toward the phone's right edge (the app's
    top) walks forward
  - a hunt: planner → helicopter drop-off → hunting → fire → quit
- Screenshots land in `tests/out/` (gitignored). The run prints a PASS/FAIL summary
  and exits non-zero on failure. Any console error counts as a failure.

Software rendering is slow (about 1–3 fps), so the smoke tests fast-forward game
time through the `window.__sauria` test hook instead of waiting on frames.

## How it works

Plain ES modules under `src/`, loaded by `index.html` through an import map:

- `main.js`: boot, the game state machine (menu → playing ⇄ paused → dead, plus
  hunter mode), the render-style pipeline, saves and the `window.__sauria` test
  hook
- `core/screen.js`: the app frame (`#app`). On a phone held upright it lays the
  game out at landscape size and rotates it 90°; everything that reads pointer
  positions or the screen size goes through it
- `world/`: terrain (heightfield island with lakes and rivers, procedural surface
  shader), water, sky and day/night, vegetation (instanced forests and food
  plants), wind
- `creatures/`:
  - species data and the procedural skinned dinosaur models
  - the shared survival simulation (`creature.js`)
  - AI brains with sight, hearing and smell
  - the ecosystem that spawns herds and packs around you and turns the dead into
    carcasses
- `player/`: input (keyboard, mouse, touch), the third-person camera, the player
  controller
- `hunter/`: hunter mode (the first-person hunter, weapons and ballistics, gun
  viewmodels, hunt session and scoring, helicopter)
- `ui/`: HUD, title menu and settings, map, hunter HUD and planner. `audio/`
  synthesises every sound with Web Audio.

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the full module map and the contract
between modules: exported APIs, units, conventions, events and the game-design
numbers.

## Credits

- [three.js](https://threejs.org) r180 (MIT), vendored in `vendor/three/` with its
  `LICENSE`.
- Fonts: Fraunces, Archivo and IBM Plex Mono via Google Fonts (SIL Open Font
  License).
- Inspired by *The Isle* (Afterthought) and *Carnivores: Dinosaur Hunter* (Action
  Forms, 1998). Sauria is an independent fan project, not affiliated with either.
