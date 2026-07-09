# Starship

A Star Trek–inspired bridge flight simulation that lives in your browser.
Choose one of three vessels, then pilot it through a parallax starfield with
inertia physics, phasers/disruptors, and a living asteroid field.

No build step, no dependencies — just open it. It pulls two web fonts (Antonio +
IBM Plex Mono) from Google Fonts and falls back to system fonts when offline.

## Run it

```bash
cd starship
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Choose your ship

| Vessel | Class | Feel |
| --- | --- | --- |
| **Constitution** · NCC-1701 | Heavy Cruiser | Balanced explorer — saucer & nacelles, steady impulse, strong shields |
| **Defiant** · NX-74205 | Escort | Compact warship — twin pulse phasers, high agility, lighter shields |
| **Raptor** · IKS-447 | Bird of Prey | Predatory raider — heavy disruptors, thick armor, slower turn |

On the splash screen: click a card, or use **← / →** and **Enter** to engage.
In-flight, open the ops console and hit **change ship** to return to selection.

## Fly

| Input | Action |
| --- | --- |
| **W / ↑** | Impulse thrust |
| **S / ↓** | Brake (with flight assist) |
| **A/D · ←/→** | Turn |
| **Shift** | Boost |
| **Space** | Fire phasers / disruptors |
| **Touch** | Virtual stick + PHASER / BOOST |

## Ops console

- **Impulse** — how hard the engines push
- **Inertial dampers** — how quickly you bleed speed
- **Flight assist** — damps spin and adds natural drag
- **Warp trail** — engine wake
- **Recharge** — top off power and shields
- **Change ship** — return to vessel select
- **Reset sector** — new starfield and asteroids

## What's inside

- LCARS-inspired orange / lilac / peach UI
- Distinct silhouettes and weapon profiles per ship
- Parallax starfield + drifting nebulae
- Asteroids that split when destroyed
- Bridge HUD — impulse, heading, shields, power
- Tactical minimap

Respects `prefers-reduced-motion`.

## How it works

- `starship.js` — ship classes, physics, combat, render loop
- `style.css` — LCARS chrome, ship select, HUD
- `index.html` — markup
