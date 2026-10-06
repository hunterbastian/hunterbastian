// Sauria — boot, game state machine and the frame loop.
//
// States: "loading" → "menu" (cinematic flight over the live island) →
// "playing" ⇄ "paused" → "dead" → (respawn | menu). Hunter mode is loaded on
// demand from ./hunter/hunterMode.js and takes over the loop while it runs.

import * as THREE from "three";
import { WORLD, TIME, GAME, QUALITY, STYLE } from "./config.js";
import { clamp } from "./core/math.js";
import { makeRng, hash } from "./core/rng.js";
import { World } from "./world/world.js";
import { PLAYABLE, getSpecies } from "./creatures/species.js";
import { Input } from "./player/input.js";
import { ThirdPersonCamera } from "./player/camera.js";
import { PlayerController } from "./player/player.js";
import { Hud } from "./ui/hud.js";
import { Menu, DEFAULT_SETTINGS, normalizeSettings } from "./ui/menu.js";
import { MapView } from "./ui/map.js";
import { AudioEngine } from "./audio/audio.js";

/* ----------------------------------------------------------------------- */
/* Params, settings, storage                                                 */
/* ----------------------------------------------------------------------- */

const params = new URLSearchParams(location.search);
const num = (key) => {
  const v = params.get(key);
  return v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
};
const DEBUG = params.get("debug") === "1";
const SETTINGS_KEY = "sauria.settings.v1";

const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — the game still works, it just won't remember */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

let settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(store.get(SETTINGS_KEY) || {}) });
if (params.get("mute") === "1") settings = normalizeSettings({ ...settings, muted: true });

const isTouch =
  (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
  ("ontouchstart" in window && navigator.maxTouchPoints > 0);

/** "high" | "low" from the setting, the URL, or the device. */
function resolveQuality() {
  const forced = params.get("quality");
  if (forced === "high" || forced === "low") return forced;
  if (settings.quality === "high" || settings.quality === "low") return settings.quality;
  const small = Math.min(screen.width, screen.height) < 700;
  const weak = (navigator.hardwareConcurrency || 8) <= 4;
  return isTouch || small || weak ? "low" : "high";
}
const qualityName = resolveQuality();
const quality = QUALITY[qualityName];

function resolveStyle() {
  const forced = params.get("style");
  if (forced === "pixel" || forced === "detailed") return forced;
  return settings.style === "pixel" ? "pixel" : STYLE.default;
}
let style = resolveStyle();

/* ----------------------------------------------------------------------- */
/* Renderer, scene, camera                                                   */
/* ----------------------------------------------------------------------- */

const canvas = document.getElementById("game");
const uiRoot = document.getElementById("ui");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: Boolean(quality.antialias),
  powerPreference: "high-performance",
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = Boolean(quality.shadows);
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
camera.position.set(0, 120, 0);
scene.add(camera); // hunter viewmodels hang off the camera

/**
 * Size the drawing buffer. "pixel" draws the 3D scene at a few hundred pixels
 * tall straight into the canvas and lets CSS upscale it with nearest-neighbour
 * filtering — identical colours/tone mapping to "detailed", zero extra passes,
 * and the DOM UI stays crisp on top.
 */
function resize() {
  const vv = window.visualViewport;
  const w = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
  const h = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
  if (style === "pixel") {
    const targetH = STYLE.pixelHeight[qualityName] || 300;
    const scale = Math.min(1, targetH / h);
    renderer.setPixelRatio(1);
    renderer.setSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), false);
    canvas.style.imageRendering = "pixelated";
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    renderer.setSize(w, h, false);
    canvas.style.imageRendering = "";
  }
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.dataset.style = style;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener("resize", resize);
window.visualViewport?.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 120));

/* ----------------------------------------------------------------------- */
/* UI + systems that don't depend on the world                              */
/* ----------------------------------------------------------------------- */

const menu = new Menu(uiRoot, { species: PLAYABLE.map(getSpecies), isTouch });
menu.settings = settings;
menu.setLoading(0, "Raising the island");

const hud = new Hud(uiRoot, { events: null, isTouch });
/** Created once the world (and its event bus) exists. */
let audio = null;

const input = new Input(canvas, uiRoot);
input.enabled = false;
// Browsers (iOS especially) only allow audio to start inside a user gesture.
// Returning false asks Input to call again on the next gesture.
input.onFirstGesture = () => {
  if (!audio) return false;
  audio.start();
  return true;
};

/* ----------------------------------------------------------------------- */
/* Game state                                                                */
/* ----------------------------------------------------------------------- */

const game = {
  state: "loading",
  world: null,
  tpc: null,
  controller: null,
  map: null,
  speciesId: null,
  survived: 0,
  saveTimer: 0,
  deathTimer: 0,
  deathShown: false,
  hunter: null, // active hunter-mode session (from hunterMode.js)
  fps: 0,
  errors: [],
};

const attractFocus = new THREE.Vector3();

/* ----------------------------------------------------------------------- */
/* Save / load                                                               */
/* ----------------------------------------------------------------------- */

function saveGame() {
  const p = game.world?.player;
  if (game.state === "dead" || !p || !p.alive || p.isHunter) return;
  const sky = game.world.sky;
  store.set(GAME.saveKey, {
    v: 1,
    seed: game.world.seed,
    speciesId: p.species.id,
    speciesName: p.species.name,
    growth: p.growth,
    health: p.health / Math.max(1, p.maxHealth),
    food: p.food,
    water: p.water,
    stamina: p.stamina,
    bleeding: p.bleeding,
    x: p.position.x,
    z: p.position.z,
    heading: p.heading,
    phase: sky.phase,
    day: sky.day,
    survived: game.survived,
    kills: p.kills || 0,
    savedAt: Date.now(),
  });
}

function loadSave() {
  const s = store.get(GAME.saveKey);
  if (!s || s.v !== 1 || !s.speciesId) return null;
  try {
    getSpecies(s.speciesId);
  } catch {
    return null;
  }
  return s;
}

const clearSave = () => store.remove(GAME.saveKey);

function menuSaveSummary() {
  const s = loadSave();
  return s ? { speciesId: s.speciesId, speciesName: s.speciesName, growth: s.growth, day: s.day } : null;
}

/* ----------------------------------------------------------------------- */
/* Spawning                                                                  */
/* ----------------------------------------------------------------------- */

/** A calm spot for a new juvenile: dry land in its biomes, near a fresh lake. */
function pickSpawn(species) {
  const t = game.world.terrain;
  const rng = makeRng(hash(Date.now() >>> 0, species.id));
  const biomes = species.biomes && species.biomes.length ? species.biomes : null;
  const lakes = (t.lakes || []).slice();
  for (let attempt = 0; attempt < 6 && lakes.length; attempt++) {
    const lake = lakes[Math.floor(rng() * lakes.length)];
    const p = t.findSpawnPoint(rng, {
      biomes,
      maxSlope: 0.3,
      near: { x: lake.x, z: lake.z, minR: (lake.r || 30) + 25, maxR: (lake.r || 30) + 140 },
      tries: 200,
    });
    if (p) return p;
  }
  return t.findSpawnPoint(rng, { biomes, maxSlope: 0.3 }) || t.findSpawnPoint(rng, {}) || { x: 0, z: 0 };
}

/**
 * Begin (or resume) a survival life.
 * @param {string} speciesId
 * @param {{ growth?: number, from?: object, pos?: {x:number,z:number} }} [opts]
 */
function startSurvival(speciesId, { growth = 0, from = null, pos = null } = {}) {
  const world = game.world;
  const species = getSpecies(speciesId);
  audio?.start();
  world.mode = "survival";
  input.setMode?.("dino");

  const eco = world.ecosystem;
  eco.clearPlayer();

  const spot = pos || (from ? { x: from.x, z: from.z } : pickSpawn(species));
  const heading = from ? from.heading : Math.random() * Math.PI * 2;
  const creature = eco.spawn(species.id, spot.x, spot.z, {
    growth: from ? from.growth : growth,
    heading,
    isPlayer: true,
  });
  if (eco.player !== creature) eco.setPlayer(creature);

  if (from) {
    creature.health = clamp(from.health ?? 1, 0.05, 1) * creature.maxHealth;
    creature.food = from.food ?? creature.food;
    creature.water = from.water ?? creature.water;
    creature.stamina = from.stamina ?? creature.stamina;
    creature.bleeding = from.bleeding ?? 0;
    creature.kills = from.kills ?? 0;
    if (from.phase != null && params.get("t") === null) world.sky.setPhase(from.phase);
    if (from.day) world.sky.day = from.day;
    game.survived = from.survived || 0;
  } else {
    game.survived = 0;
  }

  game.speciesId = species.id;
  game.deathShown = false;
  game.deathTimer = 0;
  game.saveTimer = 0;
  eco.populate?.(creature.position);

  game.controller.possess(creature);
  game.map?.clearTrail?.();
  hud.hideDeath();
  hud.hidePause();
  menu.hide();
  hud.show();
  game.state = "playing";
  input.enabled = true;
  input.requestPointerLock();
  saveGame();
}

/* ----------------------------------------------------------------------- */
/* State transitions                                                         */
/* ----------------------------------------------------------------------- */

function pauseGame() {
  if (game.state !== "playing") return;
  game.state = "paused";
  saveGame();
  input.enabled = false;
  game.map?.close();
  hud.showPause(resumeGame, quitToMenu, () => menu.showSettings());
}

function resumeGame() {
  if (game.state !== "paused") return;
  hud.hidePause();
  menu.hideSettings?.();
  game.state = "playing";
  input.enabled = true;
  input.requestPointerLock();
}

function quitToMenu() {
  if (game.hunter) {
    game.hunter.quit?.();
    return;
  }
  saveGame();
  showMenu();
}

/** Back to the title screen with the cinematic flight. */
function showMenu() {
  const world = game.world;
  world.ecosystem.clearPlayer();
  world.mode = "survival";
  hud.hideDeath();
  hud.hidePause();
  hud.hide();
  game.map?.close();
  input.enabled = false;
  input.setMode?.("dino");
  game.state = "menu";
  menu.show({ save: menuSaveSummary() });
}

function onPlayerDeath() {
  game.state = "dead";
  game.deathTimer = 0;
  game.deathShown = false;
  clearSave();
}

function showDeathScreen() {
  const p = game.world.player;
  game.deathShown = true;
  input.enabled = false;
  game.map?.close();
  hud.showDeath(
    {
      speciesName: p?.species?.name,
      growth: p?.growth ?? 0,
      survivedSec: game.survived,
      kills: p?.kills ?? 0,
      cause: p?.causeOfDeath,
    },
    () => startSurvival(game.speciesId),
    () => showMenu(),
  );
}

/* ----------------------------------------------------------------------- */
/* Settings                                                                  */
/* ----------------------------------------------------------------------- */

menu.onSettingsChange = (next) => {
  const prev = settings;
  settings = normalizeSettings(next);
  store.set(SETTINGS_KEY, settings);
  audio?.setMuted(settings.muted);
  if (game.tpc) game.tpc.sensitivity = settings.sensitivity;
  game.hunter?.setSensitivity?.(settings.sensitivity);
  if (params.get("style") === null && settings.style !== style) {
    style = settings.style === "pixel" ? "pixel" : "detailed";
    resize();
  }
  if (settings.quality !== prev.quality && params.get("quality") === null) {
    const next = resolveQuality();
    if (next !== qualityName) {
      if (game.state === "menu" || game.state === "loading") {
        location.reload(); // terrain resolution / density / shadows are baked at load
      } else {
        hud.toast("Quality changes apply the next time Sauria loads", "info");
      }
    }
  }
};
menu.onSettingsClose = () => {
  if (game.state === "paused") hud.showPause(resumeGame, quitToMenu, () => menu.showSettings());
};

/* ----------------------------------------------------------------------- */
/* Menu wiring                                                               */
/* ----------------------------------------------------------------------- */

menu.onStart = (speciesId) => startSurvival(speciesId);
menu.onContinue = () => {
  const s = loadSave();
  if (s) startSurvival(s.speciesId, { from: s });
};
menu.onHunter = () => startHunterMode();

/** Hunter mode lives in its own module; load it on first use. */
async function startHunterMode() {
  audio?.start();
  try {
    const mod = await import("./hunter/hunterMode.js");
    if (!game.hunterMode) {
      game.hunterMode = mod.createHunterMode({
        world: game.world,
        renderer,
        scene,
        camera,
        input,
        audio,
        menu,
        hud,
        uiRoot,
        isTouch,
        settings: () => settings,
        onExit: () => {
          game.hunter = null;
          showMenu();
        },
        onSessionStart: (session) => {
          game.hunter = session;
          game.state = "hunter";
        },
      });
    }
    menu.hide();
    game.state = "hunter-menu";
    game.hunterMode.open();
  } catch (err) {
    console.warn("[sauria] hunter mode unavailable", err);
    game.state = "menu";
    menu.show({ save: menuSaveSummary() });
  }
}

/* ----------------------------------------------------------------------- */
/* Frame loop                                                                */
/* ----------------------------------------------------------------------- */

let last = performance.now();
let fpsAcc = 0;
let fpsFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    game.fps = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0;
    fpsFrames = 0;
  }

  const world = game.world;
  if (!world) {
    input.endFrame();
    return;
  }

  switch (game.state) {
    case "menu":
    case "hunter-menu": {
      game.tpc.cinematic(dt, world.terrain);
      attractFocus.set(camera.position.x, 0, camera.position.z);
      world.update(dt, attractFocus);
      break;
    }
    case "playing": {
      if (input.pressed("pause")) {
        if (game.map.open) game.map.close();
        else {
          pauseGame();
          break;
        }
      }
      if (input.pressed("map")) game.map.toggle();
      if (input.pressed("help")) hud.toggleHelp();
      game.controller.update(dt);
      const p = world.player;
      world.update(dt, p ? p.position : attractFocus);
      game.survived += dt;
      game.saveTimer += dt;
      if (game.saveTimer > 10) {
        game.saveTimer = 0;
        saveGame();
      }
      break;
    }
    case "paused": {
      // Frozen world; the HUD's pause overlay handles its own buttons/keys.
      if (input.pressed("pause") && !menu.visible) resumeGame();
      break;
    }
    case "dead": {
      game.controller.update(dt);
      const p = world.player;
      world.update(dt, p ? p.position : attractFocus);
      game.deathTimer += dt;
      if (!game.deathShown && game.deathTimer > 2.6) showDeathScreen();
      break;
    }
    case "hunter": {
      game.hunter?.update(dt);
      break;
    }
    default:
      break;
  }

  const player = world.player;
  if (game.state === "playing" || game.state === "dead" || game.state === "paused") {
    hud.update(dt, { player, controller: game.controller, world, camera });
    // Every frame: the map records the trail while closed and redraws only when open.
    game.map.update(dt, { player, cameraYaw: game.tpc.yaw, markers: game.controller.sniff?.markers });
  }
  audio?.update(dt, { listener: camera, player, world });

  if (game.hunter?.render) game.hunter.render(renderer, scene, camera);
  else renderer.render(scene, camera);

  if (DEBUG) updateDebug();
  input.endFrame();
}

/* ----------------------------------------------------------------------- */
/* Boot                                                                      */
/* ----------------------------------------------------------------------- */

async function boot() {
  const seed = num("seed") ?? WORLD.seed;
  const tParam = num("t");
  const world = await World.create(
    { scene, camera, renderer, seed, quality, startPhase: tParam ?? TIME.startPhase },
    (progress, label) => menu.setLoading(progress, label),
  );
  game.world = world;
  if (tParam !== null) {
    world.sky.setPhase(clamp(tParam, 0, 1));
    world.sky.paused = true;
  }

  hud.bindEvents(world.events);
  audio = new AudioEngine(world.events);
  audio.setMuted(settings.muted);

  game.tpc = new ThirdPersonCamera(camera, world.terrain);
  game.tpc.sensitivity = settings.sensitivity;
  game.controller = new PlayerController({ world, input, camera: game.tpc, audio });
  game.map = new MapView(uiRoot, world.terrain);

  world.events.on("death", (e) => {
    if (e.creature && e.creature === world.ecosystem.player && !e.creature.isHunter && game.state === "playing") {
      onPlayerDeath();
    }
  });

  // First frames of the attract flight + an initial population around it.
  game.tpc.cinematic(0.016, world.terrain);
  attractFocus.set(camera.position.x, 0, camera.position.z);
  world.ecosystem.populate?.(attractFocus);
  world.update(0.016, attractFocus);
  renderer.compile?.(scene, camera);

  game.state = "menu";
  menu.setLoading(1, "Ready");

  const autostart = params.get("species");
  // Don't show() the menu when auto-starting: show() then hide() within one
  // frame would race the menu's next-frame open transition.
  if (!autostart) menu.show({ save: menuSaveSummary() });
  if (autostart) {
    try {
      const pos = params.get("pos");
      const [px, pz] = pos ? pos.split(",").map(Number) : [];
      startSurvival(getSpecies(autostart).id, {
        growth: clamp(num("growth") ?? 0, 0, 1),
        pos: Number.isFinite(px) && Number.isFinite(pz) ? { x: px, z: pz } : null,
      });
    } catch (err) {
      console.warn("[sauria] unknown ?species", autostart, err);
    }
  } else if (params.get("hunter") === "1") {
    startHunterMode();
  }
}

/* ----------------------------------------------------------------------- */
/* Page lifecycle                                                            */
/* ----------------------------------------------------------------------- */

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    saveGame();
    if (game.state === "playing") pauseGame();
    game.hunter?.pause?.();
  }
  last = performance.now();
});
window.addEventListener("pagehide", saveGame);
window.addEventListener("beforeunload", (e) => {
  // Ctrl+W while holding Ctrl to crouch would otherwise close the tab mid-game.
  if (game.state === "playing" && !isTouch && !DEBUG) {
    saveGame();
    e.preventDefault();
    e.returnValue = "";
  }
});

canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  game.state = game.state === "playing" ? "paused" : game.state;
});
canvas.addEventListener("webglcontextrestored", () => location.reload());

function recordError(msg) {
  game.errors.push(String(msg));
  if (game.errors.length > 50) game.errors.shift();
  if (DEBUG) hud.toast(`Error: ${String(msg).slice(0, 140)}`, "danger");
}
window.addEventListener("error", (e) => recordError(e.message || e.error));
window.addEventListener("unhandledrejection", (e) => recordError(e.reason?.message || e.reason));

/* ----------------------------------------------------------------------- */
/* Debug overlay + test hook                                                 */
/* ----------------------------------------------------------------------- */

let debugEl = null;
let debugTimer = 0;
function updateDebug() {
  if (!debugEl) {
    debugEl = document.createElement("pre");
    debugEl.className = "debug-overlay";
    debugEl.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:99;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,monospace;" +
      "color:#e8e2d4;background:rgba(10,12,10,.62);border-radius:4px;pointer-events:none;white-space:pre";
    document.body.appendChild(debugEl);
  }
  if ((debugTimer += 1) % 15) return;
  const info = renderer.info.render;
  const p = game.world?.player;
  const w = game.world;
  debugEl.textContent = [
    `${game.fps} fps · ${game.state} · ${qualityName}/${style}`,
    `draws ${info.calls} · tris ${(info.triangles / 1000).toFixed(0)}k`,
    w ? `npc ${w.ecosystem.creatures.length} · carcass ${w.ecosystem.carcasses.length} · ${w.sky.clockString()} day ${w.sky.day}` : "",
    p ? `${p.species.id} g${(p.growth * 100).toFixed(0)}% hp${Math.round(p.health)} f${Math.round(p.food)} w${Math.round(p.water)} @${p.position.x.toFixed(0)},${p.position.z.toFixed(0)}` : "",
    game.errors.length ? `errors ${game.errors.length}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

window.__sauria = {
  get state() {
    return game.state;
  },
  get world() {
    return game.world;
  },
  get player() {
    return game.world?.player ?? null;
  },
  get controller() {
    return game.controller;
  },
  get fps() {
    return game.fps;
  },
  get errors() {
    return game.errors;
  },
  get style() {
    return style;
  },
  get quality() {
    return qualityName;
  },
  get audio() {
    return audio;
  },
  input,
  renderer,
  camera,
  startGame: (speciesId, opts) => startSurvival(speciesId, opts),
  startHunter: () => startHunterMode(),
  setPhase: (p) => game.world?.sky.setPhase(p),
  pause: () => pauseGame(),
  resume: () => resumeGame(),
  menu: () => showMenu(),
};

requestAnimationFrame(frame);
boot().catch((err) => {
  console.error("[sauria] failed to start", err);
  recordError(err?.message || err);
  menu.setLoading(0, "Sauria couldn't start on this device. Try reloading, or a different browser.");
});
