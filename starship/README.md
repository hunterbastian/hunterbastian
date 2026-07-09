# Starship

A small controllable deep-space flight simulation that lives in your browser.
Pilot a starship with inertia physics through a parallax starfield, dodge and
blast asteroids, and keep an eye on shields and fuel.

No build step, no dependencies — just open it. It pulls two web fonts (Syne +
IBM Plex Mono) from Google Fonts and falls back to system fonts when offline.

## Run it

Open `index.html` directly, or serve the folder:

```bash
cd starship
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Fly

| Input | Action |
| --- | --- |
| **W / ↑** | Thrust |
| **S / ↓** | Brake (with flight assist) |
| **A/D · ←/→** | Turn |
| **Shift** | Boost (burns more fuel) |
| **Space** | Fire |
| **Touch** | Virtual stick + FIRE / BOOST |

On phones, a left stick and right action buttons appear automatically.

## Flight deck

- **Thrust** — how hard the main engines push
- **Drag** — how quickly you bleed speed in the void
- **Flight assist** — damps spin and adds a bit of natural drag
- **Engine trails** — cyan wake behind the ship
- **Refuel & repair** — top off fuel and shields
- **Reset** — new starfield and asteroid field

## What's inside

- **Inertia flight** — accelerate, coast, and turn with angular momentum
- **Parallax starfield** — near/far stars with gentle camera sway
- **Nebula haze** — soft color washes drifting in the background
- **Asteroids** — jagged rocks that split when destroyed
- **HUD** — speed, heading, shields, fuel
- **Minimap** — bottom-left tactical overview

Respects `prefers-reduced-motion`: exhaust and twinkle calm down when asked.

## How it works

Everything renders to a single `<canvas>`:

- `starship.js` — ship physics, combat, starfield, and the render loop
- `style.css` — HUD, flight-deck panel, splash, and touch controls
- `index.html` — markup
