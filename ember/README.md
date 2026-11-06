# ember

A very small, very minimal turn-based game. You are a small light on a dark
path, and a moth called **dusk** won't stop flying at you. You can fight it, or
you can calm it down and let it go.

Each turn you pick an action. Then the moth attacks, and you steer your ember
around a box to dodge the dust it throws.

No build step and no JavaScript dependencies. Just open it. It loads IBM Plex
Mono from Google Fonts and falls back to the system monospace font when offline.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd ember
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

| | keyboard | touch |
| --- | --- | --- |
| choose | arrow keys / WASD | tap an option |
| confirm, advance text | Z / Enter / Space | tap |
| back | X / Shift / Esc | tap another option |
| move while dodging | arrow keys / WASD | drag anywhere |
| move carefully | hold X or Shift | — |
| sound on / off | M | speaker icon, top right |

## How to play

- **strike**: a line sweeps across the box. Stop it near the center to hit harder.
- **talk**: `check`, `dim`, `hum`, and `hold still`. Some of these calm the moth,
  and some only work once it's already a little calm.
- **mend**: heal up to 10 hp. You get three.
- **part**: leave. It only works once dusk doesn't want to fight anymore.
  When that happens, its name and the `part` option turn amber.

Each attack pattern in turn: falling dust, sideways gusts with a gap, little
moths that chase your light, a spinning spiral, and closing rings. The calmer
dusk gets, the gentler it attacks. Hitting it makes it angrier.

There are two endings. The title screen remembers which ones you've found.

Respects `prefers-reduced-motion`: no screen shake, and the moth jitters less.

## How it works

Everything renders to one `<canvas>` at a fixed 480 × 420 logical size, scaled
to fit the window.

- `ember.js` — game state, a fixed-timestep loop (60 ticks/s), the typewriter
  text, the attack patterns, and all the drawing. Sound is synthesized with
  the Web Audio API, so there are no audio files.
- `style.css` — centers the canvas and turns off page scrolling while you drag.
- `index.html` — the canvas plus a screen-reader live region that mirrors the
  on-screen text.

`window.ember` exposes the game state, if you want to poke at it from the console.

## Smoke test

`smoke-test.mjs` plays through both endings with scripted key presses, saves
screenshots, and fails on any page error. It needs Playwright with Chromium:

```bash
cd ember
node smoke-test.mjs
```
