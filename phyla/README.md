# Phyla

**Phyla** is an evolution sandbox that runs in the browser. You begin as a speck
in a tidepool, crawl ashore, and then spend the rest of the game as a creature
you shaped yourself: bending its spine, hanging legs and mouths and crests on
it, painting it, and walking it through a small living island where every other
species was built by the same rules.

It is an original game, made as a love letter to the creature games a lot of us
grew up with, and to the early demos of them that promised more than ever
shipped. Nothing here is taken from those games: the creatures, parts, world,
interface, sound and name are all Phyla's own.

No build step. Three.js is vendored, everything else is plain ES modules.

## Run it

```bash
cd phyla
python3 -m http.server 8000
# then visit http://localhost:8000
```

It needs to be served over HTTP (ES modules do not load from `file://`).
Works with mouse and keyboard, and with touch on phones and tablets.

## How it plays

**The tidepool.** A short 2D prologue. Swim, eat, grow through four sizes and
pick a mutation at each. What you eat decides the mouth you take ashore:
graze and you land a herbivore, hunt and you land a carnivore.

**The editor.** Drag the beads along the back to bend the spine, change a
segment's girth, add neck or tail. Tap a part to hang it on the body, then drag
it anywhere on the skin; anything off the midline is mirrored. Parts cost
*helix*, which your lineage earns out in the world. The creature stands up and
walks while you work, however strange you make it.

**The island.** Seven other species live here, each with a nest, a temperament
and a diet. You have two ways to deal with any of them:

- **Friendly.** Call to a creature and it calls back in one of four voices:
  trill, sway, flare or glow. Answer in the same voice. Win over three of a
  nest and the whole species becomes your ally, and will walk in your pack.
- **Fierce.** Bite, ram and swipe. Drive a species off and it will keep its
  distance for good.

Either way you earn helix and discover parts those creatures carry. Old bones
scattered around the island hide more. Carry it all back to your nest, evolve,
and hatch as the next generation. The lineage screen keeps every form you have
been.

There is a day and a night. Most things sleep after dark. The hunters do not.

## Controls

| | Keyboard and mouse | Touch |
| --- | --- | --- |
| Walk | `WASD` / arrows | left stick |
| Run | `Shift` | push the stick to its edge |
| Leap (hold to glide, with wings) | `Space` | leap button |
| Look / zoom | drag / scroll | drag / pinch |
| Focus on a creature | click it | tap it |
| Friendly / fierce | `Tab` | stance button |
| Voices or attacks | `1` to `4` | action bar |
| Eat, dig, evolve, invite | `E` | use button |
| Menu | `Esc` | pause button |

## The workshop

*Creature workshop* on the title screen opens the editor with every part
unlocked and no cost. **Copy creature code** gives you a short string that
anyone can paste into their own workshop, so creatures can be shared.

## How it works

Everything is procedural; there are no models, textures or sound files.

- `src/genome.js` — a creature is a small JSON genome: spine nodes, parts
  placed by surface coordinates, and a skin. Also the random species generator.
- `src/creature.js` — turns a genome into a living thing. The body is a tube
  skinned along the spine on the CPU every frame; legs plant their feet in the
  world and step when they fall behind (two-bone IK), so any body plan walks.
- `src/parts.js` — the parts catalogue, each one modelled from primitives.
- `src/skin.js` — paints the skin texture onto a canvas.
- `src/editor.js` — the creature editor.
- `src/world.js` — the island: noise terrain, biomes, instanced flora, sky and
  the day and night cycle.
- `src/fauna.js` — the other species and their behaviour.
- `src/game.js`, `src/hud.js` — the creature stage and its interface.
- `src/cell.js` — the tidepool, on a 2D canvas.
- `src/audio.js` — every sound, synthesised with WebAudio.

Handy URL switches: `?start=land`, `?start=workshop`, `?start=cell`,
`?q=low|medium|high`, `?seed=1234`.

## Test

```bash
node smoke-test.mjs
```

Loads the game headlessly (needs Playwright), walks through title, editor and
world, and fails on any page error.

## Credits

[Three.js](https://threejs.org) (MIT) is vendored in `vendor/`.
