// Hunter mode — the Carnivores-style expedition, loaded on demand by main.js.
//
// Owns the hunter-specific pieces (loadout menu, Hunter actor + first-person
// controller, weapons, HuntSession, hunter HUD) and runs while main's state is
// "hunter": main forwards update(dt) and render() and otherwise stays out of
// the way. Flow: loadout → helicopter drop-off (door-seat camera) → hunt →
// extraction or death → summary → again / menu.

import * as THREE from "three";
import { clamp } from "../core/math.js";
import { SPECIES } from "../creatures/species.js";
import { Hunter, HunterController } from "./hunter.js";
import { WeaponSystem, WEAPONS } from "./weapons.js";
import { HuntSession, TROPHY_VALUES } from "./hunt.js";
import { HunterHud } from "../ui/hunterHud.js";
import { HunterMenu } from "../ui/hunterMenu.js";

/** First-person field of view (wider than the survival follow camera). */
const HUNTER_FOV = 70;
/** Seconds between the hunter's death and the expedition report. */
const DEATH_DELAY = 2.4;
/** How far you can look around from the helicopter's door seat. */
const RIDE_LOOK = { yaw: 1.1, pitchMin: -0.7, pitchMax: 0.35, sens: 0.0022 };

/**
 * @param {object} deps
 * @param {import("../world/world.js").World} deps.world
 * @param {THREE.WebGLRenderer} deps.renderer
 * @param {THREE.PerspectiveCamera} deps.camera
 * @param {import("../player/input.js").Input} deps.input
 * @param {object|null} deps.audio
 * @param {import("../ui/menu.js").Menu} deps.menu   survival menu (settings panel is shared)
 * @param {import("../ui/hud.js").Hud} deps.hud       survival HUD (its pause overlay is shared)
 * @param {import("../ui/map.js").MapView|null} deps.map
 * @param {HTMLElement} deps.uiRoot
 * @param {boolean} deps.isTouch
 * @param {() => object} deps.settings              current settings getter
 * @param {() => void} deps.onExit                  back to the title screen
 * @param {(api: object) => void} deps.onSessionStart main switches its state to "hunter"
 * @param {() => void} [deps.onPlanner]             main resumes the title flight behind the planner
 */
export function createHunterMode({ world, renderer, camera, input, audio, menu, hud, map = null, uiRoot, isTouch, settings, onExit, onSessionStart, onPlanner = () => {} }) {
  const huntable = Object.values(SPECIES).filter((s) => s && s.id !== "human");
  const hunterMenu = new HunterMenu(uiRoot, { species: huntable, weapons: WEAPONS, trophyValues: TROPHY_VALUES, isTouch });
  const hunterHud = new HunterHud(uiRoot, { events: world.events, isTouch });
  const survivalFov = camera.fov;

  let weapons = null; // built on the first expedition (procedural textures take a moment)
  let controller = null;
  let hunter = null;
  let session = null;
  let paused = false;
  let deathT = -1;
  let reported = false;
  let rideYaw = 0;
  let ridePitch = -0.18;
  let offDeath = null;

  /* --- Menu wiring ------------------------------------------------------- */

  hunterMenu.onBack = () => {
    hunterMenu.hide();
    onExit();
  };
  hunterMenu.onStart = (loadout) => begin(loadout);

  /** Show the expedition planner (loadout, targets, time of day, trophy room). */
  function open() {
    input.enabled = false;
    hunterMenu.show(HuntSession.loadProfile());
  }

  /* --- Expedition lifecycle ---------------------------------------------- */

  /**
   * Start an expedition from the planner's choices. Runs inside the click
   * handler, so audio unlock and pointer lock are allowed.
   */
  function begin({ weapons: loadout = ["rifle", "revolver"], equipment = {}, targets = [], phase = 0.5 } = {}) {
    audio?.start();
    hunterMenu.hide();
    hunterHud.hideSummary?.();
    hunterHud.hideDeath?.();
    teardownSession();

    world.mode = "hunter";
    input.setMode?.("hunter");
    world.sky.paused = false;
    world.sky.setPhase(clamp(Number(phase) || 0.5, 0, 1));
    world.ecosystem.clearPlayer();

    hunter = new Hunter(world, { x: 0, z: 0, heading: 0, equipment });
    if (!weapons) weapons = new WeaponSystem({ world, camera, loadout });
    else weapons.setLoadout(loadout);
    weapons.owner = hunter;
    if (weapons.fx) weapons.fx.visible = true;

    if (!controller) controller = new HunterController({ world, input, camera, weapons, audio });
    controller.setSensitivity?.(settings().sensitivity);
    camera.fov = HUNTER_FOV;
    camera.updateProjectionMatrix();
    controller.possess(hunter);

    session = new HuntSession({ world, events: world.events });
    session.onEnd = (summary) => report(summary);
    // start() picks the landing zone and parks the hunter there; only then does
    // the ecosystem adopt him, so its predator-free bubble lands in the right place.
    session.start({ hunter, weapons, equipment, targets });
    world.ecosystem.setPlayer(hunter);

    offDeath = world.events.on("death", (e) => {
      if (e.creature === hunter && deathT < 0) deathT = 0;
    });

    paused = false;
    deathT = -1;
    reported = false;
    rideYaw = 0;
    ridePitch = -0.18;
    hud.hide();
    map?.clearTrail?.();
    hunterHud.show();
    input.enabled = true;
    input.requestPointerLock();
    onSessionStart(api);
  }

  /** The expedition is over (extracted, died or quit): show the report. */
  function report(summary) {
    if (reported) return;
    reported = true;
    input.enabled = false;
    map?.close?.();
    hud.toggleHelp(false); // field notes opened from pause stay up after resuming
    if (summary?.result === "died") {
      hunterHud.showDeath(summary, () => leave());
    } else if (summary?.result === "extracted") {
      hunterHud.showSummary(
        summary,
        () => again(),
        () => leave(),
      );
    } else {
      leave();
    }
  }

  /** Back to the planner for another expedition. */
  function again() {
    hunterHud.hideSummary?.();
    hunterHud.hideDeath?.();
    teardownSession();
    hunterHud.hide();
    camera.fov = survivalFov;
    camera.updateProjectionMatrix();
    onPlanner();
    open();
  }

  /** Abandon or finish and return to the title screen. */
  function leave() {
    hunterHud.hideSummary?.();
    hunterHud.hideDeath?.();
    hud.hidePause();
    teardownSession();
    hunterHud.hide();
    world.mode = "survival";
    input.setMode?.("dino");
    camera.fov = survivalFov;
    camera.updateProjectionMatrix();
    onExit();
  }

  /** Release this expedition's actors and helicopter; keep shared systems alive. */
  function teardownSession() {
    if (offDeath) {
      offDeath();
      offDeath = null;
    }
    // Detach first: ending an active session fires onEnd → report → leave(),
    // which would re-enter here and dispose the session out from under us.
    const s = session;
    session = null;
    if (s) {
      s.onEnd = null;
      if (s.active) s.end("quit");
      s.dispose();
    }
    if (controller) controller.possess(null);
    if (hunter) {
      if (world.ecosystem.player === hunter) world.ecosystem.clearPlayer();
      hunter.dispose?.();
      hunter = null;
    }
    world.helicopter = null;
    // The survival HUD is hidden during a hunt, so its hide() won't close these.
    hud.hidePause();
    hud.toggleHelp(false);
    // The weapon effects (tracers, stuck bolts, the muzzle point light on
    // high) live in the world scene: hide them so survival doesn't pay for them.
    if (weapons?.fx) weapons.fx.visible = false;
    paused = false;
    deathT = -1;
  }

  /* --- Pause ------------------------------------------------------------- */

  function pause() {
    if (paused || !session || reported) return;
    paused = true;
    input.enabled = false;
    map?.close?.();
    hud.showPause(resume, quit, () => menu.showSettings(), { hunter: true, notes: pauseNotes() });
  }

  /** One line for the shared pause overlay: time out, bag, clock. */
  function pauseNotes() {
    const bits = [];
    const min = Math.floor((session?.elapsed || 0) / 60);
    bits.push(min < 1 ? "Just landed" : `${min} min in the field`);
    const n = session?.trophies?.length || 0;
    bits.push(n ? `${n} ${n === 1 ? "trophy" : "trophies"} bagged` : "No trophies yet");
    const clock = world.sky?.clockString?.();
    if (clock) bits.push(clock);
    return bits.join("  ·  ");
  }

  function resume() {
    if (!paused) return;
    paused = false;
    hud.hidePause();
    menu.hideSettings?.();
    input.enabled = true;
    input.requestPointerLock();
  }

  /** Quit from the pause menu: the hunt ends without banking anything. */
  function quit() {
    paused = false;
    hud.hidePause();
    leave();
  }

  /* --- Frame ------------------------------------------------------------- */

  const _focus = new THREE.Vector3();

  function update(dt) {
    if (!session) return;
    if (paused) {
      if (input.pressed("pause") && !menu.visible && !menu.settingsOpen) resume();
      return;
    }
    if (!reported && input.pressed("pause")) {
      if (map?.open) map.close();
      else {
        pause();
        return;
      }
    }
    if (!reported && map && input.pressed("map")) map.toggle();
    if (!reported && input.pressed("help")) hud.toggleHelp(undefined, { hunter: true });

    const riding = session.state === "dropoff";
    if (riding) {
      // Free-look from the door seat while the chopper flies in.
      const look = input.consumeLook();
      rideYaw = clamp(rideYaw - look.dx * RIDE_LOOK.sens, -RIDE_LOOK.yaw, RIDE_LOOK.yaw);
      ridePitch = clamp(ridePitch - look.dy * RIDE_LOOK.sens, RIDE_LOOK.pitchMin, RIDE_LOOK.pitchMax);
      if (input.pressed("interact") || input.pressed("extract")) session.skipDropoff();
    } else if (!reported || hunter?.alive === false) {
      controller.update(dt);
      if (!reported && hunter?.alive) {
        if (controller.wantsLure) {
          const called = session.lure();
          if (!called) hunterHud.toast(session.equipment?.lure ? "The call device needs a moment" : "No call device in your kit", "info");
        }
        if (controller.wantsExtract) session.requestExtraction();
      }
    }

    _focus.copy(hunter ? hunter.position : camera.position);
    world.update(dt, _focus);
    session.update(dt);
    if (riding && session.state === "dropoff") session.applyRideCamera(camera, rideYaw, ridePitch);

    if (deathT >= 0 && !reported) {
      deathT += dt;
      if (deathT > DEATH_DELAY) session.end("died");
    }

    hunterHud.update(dt, { hunter, controller, weapons, hunt: session, world, camera });
    // Every frame, like survival: the map records the trail while closed.
    if (map && hunter) map.update(dt, { player: hunter, cameraYaw: controller?.yaw ?? 0, markers: null });
  }

  /** World, then the first-person gun on top (same target, so pixel style matches). */
  function render(r) {
    r.render(world.scene, camera);
    if (weapons && session && session.state !== "dropoff" && hunter?.alive && !reported) {
      weapons.renderViewmodel(r, camera);
    }
  }

  const api = {
    open,
    begin,
    update,
    render: (r) => render(r || renderer),
    pause,
    resume,
    quit,
    setSensitivity: (v) => controller?.setSensitivity?.(v),
    /** Toast on the hunter HUD (the survival HUD is hidden during a hunt). */
    toast: (text, kind = "info") => hunterHud.toast(text, kind),
    get session() {
      return session;
    },
    get hunter() {
      return hunter;
    },
    get weapons() {
      return weapons;
    },
  };
  return api;
}
