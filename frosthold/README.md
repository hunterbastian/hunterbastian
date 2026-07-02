# Frosthold

A little open-world RPG for your phone — inspired by the "wander a frozen
province, fight wolves and draugr, shout like a dragonborn" fantasy of games
like *Skyrim*, shrunk down to something you can play in a mobile browser tab
in a few minutes.

No build step, no app store, no dependencies beyond a vendored copy of
[three.js](https://threejs.org) — just open it.

## Run it

Open `index.html` directly, or serve the folder (WebGL needs `http(s)://`,
not `file://`, in most mobile browsers):

```bash
cd frosthold
python3 -m http.server 8000
# then visit http://localhost:8000 on your phone or desktop
```

On an iPhone, open that URL in Safari, then **Share → Add to Home Screen**
for a fullscreen, app-like experience (no address bar, custom icon).

## What's inside

- **A tiny open world** — rolling procedurally-generated hills, a snowy
  mountain ring around the edge of the map, a lake, a forest, scattered
  rocks, a village with a well and a few huts, and a ruined keep guarded by
  a draugr.
- **Day/night cycle** — a moving sun and moon, drifting stars, and a sky
  that shifts from dawn to noon to dusk to night, all lighting the world in
  real time.
- **Third-person controls built for touch** — a virtual joystick to move,
  drag anywhere on screen to look around, and dedicated buttons to jump,
  attack, and shout. Keyboard + mouse also work for testing on desktop
  (WASD, drag to look, Space to jump, F to attack, Q to shout, E to
  interact, Esc to pause).
- **Simple combat** — swing your sword at nearby enemies, or unleash a
  Thu'um-style shout that knocks back and damages everything in a cone in
  front of you once your magicka is full.
- **Wolves and a boss** — dire wolves wander the vale and will chase and
  attack if you get close; a draugr guardian stands watch over a treasure
  chest at the keep.
- **Leveling** — defeating enemies grants XP and gold; leveling up raises
  your health, stamina, magicka, and damage.
- **A short quest line** — find the village Elder, clear out the wolves,
  then defeat the guardian and open the chest at the Ruined Keep.
- **A mobile HUD** — health/stamina/magicka bars, a scrolling compass, a
  rotating minimap, quest tracker, and toast notifications for loot, XP,
  and level-ups.

## How it works

Everything renders with WebGL via three.js:

- `game.js` — world generation (a hand-rolled value-noise heightmap),
  the day/night sky shader, low-poly characters and enemy AI, the
  third-person camera and touch input, combat, quests, and the render loop.
- `style.css` — the mobile HUD, joystick, action buttons, and menus.
- `index.html` — markup, boot/title screens, and the manifest for
  "Add to Home Screen".
- `vendor/three.module.js` — a vendored copy of three.js so the game works
  without a build step or network access to a CDN.

### Deep links

Append `?t=0..1` to the URL to start at a specific time of day (`?t=0` is
midnight, `?t=0.5` is noon), the same way `forest` supports its own `?t=`
parameter.
