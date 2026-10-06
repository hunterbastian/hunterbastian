// PlayerController — turns Input into the possessed dinosaur's intent
// (camera-relative movement, crouch/sprint/rest, bite, eat/drink, call),
// runs the sniff ability, drives the follow camera, writes the HUD's context
// prompt and drops sparse first-time hints as "notify" toasts.

import * as THREE from "three";
import { clamp, dist2 } from "../core/math.js";

/* --- Tuning -------------------------------------------------------------------- */

const SNIFF_COOLDOWN = 12; // s between sniffs
const SNIFF_DURATION = 8; // s the markers stay up
const SNIFF_FADE_IN = 0.35;
const SNIFF_FADE_OUT = 1.6;
const SNIFF_FOOD_RADIUS = 90;
const SNIFF_CREATURE_RADIUS = 120;
const SNIFF_WATER_RADIUS = 700;
const SNIFF_MAX_PLANTS = 6;
const SNIFF_MAX_CARCASSES = 4;
const SNIFF_MAX_CREATURES = 10;

const WALK_MAGNITUDE = 0.5; // intent length that means "walk" (creature: ≤0.5 walk, >0.5 trot)
const MOVE_EPS = 0.12; // stick/key magnitude that counts as "moving"
const CONTEXT_INTERVAL = 0.1; // s between findFood / canDrink probes
const HINT_INTERVAL = 0.5; // s between hint checks
const HINT_SPACING = 9; // s minimum between two hint toasts
const HINT_KEY = "sauria.hints.v1";
const FLASH_TIME = 1.6; // s a transient prompt ("Sniff ready in 4 s") stays

// Damage types that are impacts (worth a camera shake), not slow attrition.
const IMPACT_TYPES = new Set(["bite", "tail", "kick", "fall", "shot"]);

const PLANT_LABELS = { fern: "Ferns", cycad: "Cycad", horsetail: "Horsetails", shrub: "Shrub" };

/* --- Small helpers ------------------------------------------------------------------ */

const _fwd = new THREE.Vector3();

function speciesOf(c) {
  return c && typeof c.species === "object" && c.species ? c.species : null;
}

function speciesName(s) {
  if (!s) return "Unknown";
  if (typeof s === "object") return s.name || speciesName(s.id);
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function dietOf(c) {
  return c?.diet ?? speciesOf(c)?.diet ?? "herbivore";
}

function massOf(c) {
  if (Number.isFinite(c?.mass)) return c.mass;
  const sp = speciesOf(c);
  const s = Number.isFinite(c?.scale) ? c.scale : 1;
  return (sp?.mass ?? 100) * s * s * s;
}

/**
 * Query helpers fill `out` per the contract; if one returns a different
 * array instead, copy it so we never mutate another module's buffer.
 */
function adopt(result, out) {
  if (result && result !== out && typeof result.length === "number") {
    out.length = 0;
    for (let i = 0; i < result.length; i++) out.push(result[i]);
  }
  return out;
}

function loadHints() {
  try {
    const raw = globalThis.localStorage?.getItem(HINT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveHints(seen) {
  try {
    globalThis.localStorage?.setItem(HINT_KEY, JSON.stringify(seen));
  } catch {
    /* private mode / quota — hints just repeat next session */
  }
}

/**
 * Would `other` be dangerous to `me`? Bigger carnivores (and a hunter with a
 * gun) always; same-species adults only when much larger (cannibalism);
 * armoured or tail-swinging giants only matter to a carnivore that might
 * provoke them.
 */
function isThreat(me, other) {
  if (!other || other.alive === false) return false;
  if (other.isHunter) return true;
  const myMass = massOf(me);
  const theirMass = massOf(other);
  const theirSp = speciesOf(other);
  if (dietOf(other) === "carnivore") {
    if (theirSp && theirSp.id === speciesOf(me)?.id) return theirMass > myMass * 1.6;
    return theirMass > myMass * 0.5;
  }
  if (dietOf(me) !== "carnivore" || !theirSp) return false;
  const dangerous = theirSp.attack === "tail" || (theirSp.armor ?? 0) > 0.4;
  return dangerous && theirMass > myMass * 2.5;
}

/* --- PlayerController ------------------------------------------------------------- */

export class PlayerController {
  /**
   * @param {{ world: object, input: import("./input.js").Input,
   *           camera: import("./camera.js").ThirdPersonCamera, audio?: object | null }} opts
   */
  constructor({ world, input, camera, audio = null }) {
    this.world = world;
    this.input = input;
    this.camera = camera;
    this.audio = audio;
    /** Possessed Creature (null before spawn). */
    this.creature = null;
    /** Context hint for the HUD, or null. */
    this.prompt = null;
    /**
     * Sniff ability state. `cooldown` counts down to 0 (ready), `timeLeft`
     * counts down while markers show. Markers also carry `alpha` (fade) and
     * `dist` (m from the player), updated every frame; creature markers
     * track their creature.
     */
    this.sniff = {
      active: false,
      cooldown: 0,
      timeLeft: 0,
      duration: SNIFF_DURATION,
      cooldownMax: SNIFF_COOLDOWN,
      markers: [],
    };
    /** Crouch latch from C / the touch button (Ctrl holds crouch on top). */
    this.crouchToggled = false;
    /** Player wants to rest (Z toggles; moving, biting or sprinting cancels). */
    this.restWanted = false;

    if (camera && input) camera.autoFollow = !!input.isTouch;
    // Let the camera slide around trunks and boulders (vegetation may load later; see update()).
    if (camera && world?.vegetation) camera.colliders = world.vegetation;

    this._markerPool = [];
    this._scratch = [];
    this._sniffT = 0;
    this._contextT = 0;
    this._food = null;
    this._drink = null;
    this._hintT = 0;
    this._sinceHint = HINT_SPACING;
    this._aliveT = 0;
    this._hintsSeen = loadHints();
    this._flashText = null;
    this._flashT = 0;
    this._sprintHeld = false;
    this._unsubs = [];
    this._subscribe();
  }

  /**
   * Take control of a creature: camera swings in behind it, latches reset.
   * @param {object | null} creature
   */
  possess(creature) {
    this.creature = creature || null;
    this.prompt = null;
    this.crouchToggled = false;
    this.restWanted = false;
    this._food = null;
    this._drink = null;
    this._contextT = 0;
    this._aliveT = 0;
    this._clearSniff();
    this.sniff.cooldown = 0;
    if (creature && this.camera) {
      if (Number.isFinite(creature.heading)) this.camera.yaw = creature.heading;
      this.camera.pitch = 0.32;
      this.camera.snap();
    }
  }

  /**
   * Per-frame: input → camera look/zoom and creature.intent (camera-relative),
   * actions, sniff, prompt, hints, camera follow.
   * @param {number} dt seconds
   */
  update(dt) {
    const c = this.creature;
    const input = this.input;
    const cam = this.camera;
    if (!c) {
      this.prompt = null;
      return;
    }

    if (!cam.colliders && this.world?.vegetation) cam.colliders = this.world.vegetation;
    const look = input.consumeLook();
    cam.addLook(look.dx, look.dy);
    cam.addZoom(input.consumeZoom());

    this.sniff.cooldown = Math.max(0, this.sniff.cooldown - dt);
    if (this._flashT > 0) this._flashT -= dt;

    if (c.alive === false) {
      this._clearIntent(c);
      this.prompt = null;
      this._updateSniff(dt);
      cam.update(dt, c);
      return;
    }

    this._aliveT += dt;
    this._drive(c, input, cam);
    this._actions(c, input);
    this._updateContext(dt, c);
    this._updateSniff(dt);
    this.prompt = this._promptFor(c, input);
    this._touchFeedback(input);
    this._hints(dt, c);
    cam.update(dt, c);
  }

  /** Unsubscribe from world events. */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }

  /* --- Movement ------------------------------------------------------------------- */

  _drive(c, input, cam) {
    const intent = c.intent || (c.intent = {});
    const axis = input.moveAxis();
    const mag = Math.min(1, Math.hypot(axis.x, axis.y));
    const moving = mag > MOVE_EPS;

    // Crouch: C toggles, Ctrl holds.
    if (input.pressed("crouch")) this.crouchToggled = !this.crouchToggled;
    const crouchHeld = input.isDown("crouch");

    // Sprint wins over a *toggled* crouch (stand up and run), not a held one.
    const sprintHeld = input.isDown("sprint");
    if (sprintHeld && moving && !this._sprintHeld && !crouchHeld) this.crouchToggled = false;
    this._sprintHeld = sprintHeld && moving;
    const crouch = this.crouchToggled || crouchHeld;
    const sprint = sprintHeld && moving && !crouch;

    // Camera-relative: stick-up / W runs where the camera looks.
    cam.forward(_fwd);
    let wx = _fwd.x * axis.y - _fwd.z * axis.x; // right = (−fwd.z, 0, fwd.x)
    let wz = _fwd.z * axis.y + _fwd.x * axis.x;
    if (mag < MOVE_EPS) {
      wx = 0;
      wz = 0;
    } else if (crouch && mag > WALK_MAGNITUDE) {
      // Crouched = always a walk-level intent.
      const k = WALK_MAGNITUDE / mag;
      wx *= k;
      wz *= k;
    }

    if (moving || sprint) this.restWanted = false;

    intent.moveX = wx;
    intent.moveZ = wz;
    intent.sprint = sprint;
    intent.crouch = crouch;
  }

  _actions(c, input) {
    const intent = c.intent;

    if (input.pressed("rest")) this.restWanted = !this.restWanted;

    // Bite: tap, or hold to keep attacking as the cooldown allows.
    const biteHeld = input.isDown("bite") && (c.biteCooldown ?? 0) <= 0;
    if (input.pressed("bite") || biteHeld) {
      intent.bite = true;
      this.restWanted = false;
    }

    if (input.pressed("call")) intent.call = true;

    // Eat beats drink when both are in reach (the food is right under the snout).
    const interact = input.isDown("interact");
    intent.eat = interact && !!this._food;
    intent.drink = interact && !this._food && this._drink === "fresh";
    if (intent.eat || intent.drink) this.restWanted = false;

    intent.rest = this.restWanted;

    if (input.pressed("sniff")) {
      if (this.sniff.cooldown <= 0) this._startSniff(c);
      else this._flash(`Sniff ready in ${Math.ceil(this.sniff.cooldown)} s`);
    }
  }

  _clearIntent(c) {
    const intent = c.intent;
    if (!intent) return;
    intent.moveX = 0;
    intent.moveZ = 0;
    intent.sprint = false;
    intent.crouch = false;
    intent.bite = false;
    intent.eat = false;
    intent.drink = false;
    intent.call = false;
    intent.rest = false;
  }

  /* --- Context (what's in reach of the head) ---------------------------------------------- */

  _updateContext(dt, c) {
    this._contextT -= dt;
    // Probe immediately when E goes down so the first held frame already eats.
    if (this._contextT > 0 && !this.input.pressed("interact")) return;
    this._contextT = CONTEXT_INTERVAL;
    try {
      this._food = typeof c.findFood === "function" ? c.findFood() : null;
    } catch {
      this._food = null;
    }
    try {
      this._drink = typeof c.canDrink === "function" ? c.canDrink() : null;
    } catch {
      this._drink = null;
    }
  }

  _promptFor(c, input) {
    if (this._flashT > 0 && this._flashText) return this._flashText;
    const touch = input.isTouch;
    const busy = c.eating || c.drinking;
    if (this._food) {
      if (busy && input.isDown("interact")) return null;
      return touch ? "Hold Eat/Drink to eat" : "Hold E to eat";
    }
    if (this._drink === "fresh") {
      if (busy && input.isDown("interact")) return null;
      return touch ? "Hold Eat/Drink to drink" : "Hold E to drink";
    }
    if (this._drink === "salt") return "Salt water — find a lake or river";

    const wantsSprint = input.isDown("sprint") && Math.hypot(c.intent.moveX, c.intent.moveZ) > 0;
    if (wantsSprint && (c.legBroken ?? 0) > 0) return "Leg broken";
    if (wantsSprint && (c.exhausted === true || (c.stamina ?? 100) < 2)) return "Too exhausted to sprint";
    if ((c.legBroken ?? 0) > 0 && (c.speed ?? 0) > 0.3) return "Leg broken";
    if (c.swimming && (c.stamina ?? 100) < 15 && (speciesOf(c)?.swim ?? 0) < 0.6) {
      return "Exhausted — get to the shore";
    }
    return null;
  }

  _flash(text) {
    this._flashText = text;
    this._flashT = FLASH_TIME;
  }

  _touchFeedback(input) {
    if (!input.isTouch || typeof input.setActive !== "function") return;
    input.setActive("crouch", this.crouchToggled);
    input.setActive("rest", this.restWanted);
    input.setHint?.("interact", !!this._food || this._drink === "fresh");
    input.setCooldown?.("sniff", this.sniff.cooldown / SNIFF_COOLDOWN);
  }

  /* --- Sniff ---------------------------------------------------------------------- */

  _startSniff(c) {
    const s = this.sniff;
    const world = this.world;
    const x = c.position.x;
    const z = c.position.z;
    this._clearSniff();
    s.cooldown = SNIFF_COOLDOWN;
    s.timeLeft = SNIFF_DURATION;
    s.active = true;
    this._sniffT = 0;

    /* Nearest fresh water (marker over the water itself, not the shore). */
    const terrain = world?.terrain;
    const sea = terrain?.seaLevel ?? 0;
    const water = terrain?.nearestFreshWater?.(x, z, SNIFF_WATER_RADIUS);
    if (water) {
      const wx = Number.isFinite(water.waterX) ? water.waterX : water.x;
      const wz = Number.isFinite(water.waterZ) ? water.waterZ : water.z;
      this._addMarker(wx, sea + 0.4, wz, "water", false, "Fresh water", null);
    }

    /* Diet-appropriate food. */
    const scratch = this._scratch;
    scratch.length = 0;
    if (dietOf(c) === "carnivore") {
      const list = world?.ecosystem?.carcasses;
      if (Array.isArray(list)) {
        const r2 = SNIFF_FOOD_RADIUS * SNIFF_FOOD_RADIUS;
        for (const k of list) {
          if ((k.meat ?? 1) >= 0.5 && dist2(x, z, k.x, k.z) <= r2) scratch.push(k);
        }
        this._sortByDistance(scratch, x, z);
        for (let i = 0; i < scratch.length && i < SNIFF_MAX_CARCASSES; i++) {
          const k = scratch[i];
          this._addMarker(k.x, (k.y ?? 0) + 0.6, k.z, "carcass", false, `${speciesName(k.species)} carcass`, null);
        }
      }
    } else {
      const veg = world?.vegetation;
      if (veg && typeof veg.plantsNear === "function") {
        const plants = adopt(veg.plantsNear(x, z, SNIFF_FOOD_RADIUS, scratch), scratch);
        for (let i = plants.length - 1; i >= 0; i--) if ((plants[i].food ?? 1) < 1) plants.splice(i, 1);
        this._sortByDistance(plants, x, z);
        for (let i = 0; i < plants.length && i < SNIFF_MAX_PLANTS; i++) {
          const p = plants[i];
          this._addMarker(p.x, (p.y ?? 0) + 0.8, p.z, "plant", false, PLANT_LABELS[p.kind] || "Plants", null);
        }
      }
    }

    /* Creatures (tracked while the markers last). */
    scratch.length = 0;
    const eco = world?.ecosystem;
    if (eco && typeof eco.query === "function") {
      const found = adopt(eco.query(x, z, SNIFF_CREATURE_RADIUS, null, scratch), scratch);
      for (let i = found.length - 1; i >= 0; i--) {
        if (found[i] === c || found[i].alive === false || !found[i].position) found.splice(i, 1);
      }
      this._sortByDistance(found, x, z, true);
      for (let i = 0; i < found.length && i < SNIFF_MAX_CREATURES; i++) {
        const o = found[i];
        const label = o.isHunter ? "Hunter" : speciesName(speciesOf(o) || o.species);
        const m = this._addMarker(o.position.x, o.position.y, o.position.z, "creature", isThreat(c, o), label, o);
        this._trackCreature(m);
      }
    }
    scratch.length = 0;

    this._updateSniff(0);
    world?.events?.emit("sniff", { creature: c });
  }

  _sortByDistance(arr, x, z, positions = false) {
    arr.sort((a, b) => {
      const pa = positions ? a.position : a;
      const pb = positions ? b.position : b;
      return dist2(x, z, pa.x, pa.z) - dist2(x, z, pb.x, pb.z);
    });
  }

  _addMarker(x, y, z, kind, threat, label, ref) {
    const m = this._markerPool.pop() || {};
    m.x = x;
    m.y = y;
    m.z = z;
    m.kind = kind;
    m.threat = threat;
    m.label = label;
    m.alpha = 0;
    m.dist = 0;
    m.ref = ref;
    m.species = ref ? speciesOf(ref)?.id ?? null : null;
    this.sniff.markers.push(m);
    return m;
  }

  /** Marker sits above the creature's back (scaled hip height). */
  _trackCreature(m) {
    const o = m.ref;
    const sp = speciesOf(o);
    const h = (sp?.height ?? 1) * (Number.isFinite(o.scale) ? o.scale : 1);
    m.x = o.position.x;
    m.y = o.position.y + h * 1.25;
    m.z = o.position.z;
  }

  _updateSniff(dt) {
    const s = this.sniff;
    if (!s.active) return;
    s.timeLeft = Math.max(0, s.timeLeft - dt);
    this._sniffT += dt;
    if (s.timeLeft <= 0) {
      this._clearSniff();
      return;
    }
    const fade = Math.min(1, this._sniffT / SNIFF_FADE_IN) * Math.min(1, s.timeLeft / SNIFF_FADE_OUT);
    const c = this.creature;
    const px = c?.position.x ?? 0;
    const pz = c?.position.z ?? 0;
    for (const m of s.markers) {
      if (m.ref) {
        // Creatures that died or despawned stay put and fade with the rest.
        if (m.ref.alive !== false && m.ref.position) this._trackCreature(m);
      }
      m.alpha = fade;
      m.dist = Math.sqrt(dist2(px, pz, m.x, m.z));
    }
  }

  _clearSniff() {
    const s = this.sniff;
    for (const m of s.markers) {
      m.ref = null;
      this._markerPool.push(m);
    }
    s.markers.length = 0;
    s.active = false;
    s.timeLeft = 0;
  }

  /* --- Feedback: camera shake & hints ------------------------------------------------------- */

  _subscribe() {
    const events = this.world?.events;
    if (!events || typeof events.on !== "function") return;
    this._unsubs.push(
      events.on("damage", (e) => {
        if (!e || e.target !== this.creature || !this.creature) return;
        if (!IMPACT_TYPES.has(e.type)) return;
        const max = this.creature.maxHealth || 100;
        this.camera.shake(clamp((e.amount / max) * 3.2, 0.22, 0.85));
      })
    );
    this._unsubs.push(
      events.on("attack", (e) => {
        // A landed hit of our own gets a small kick too — weight, not chaos.
        if (e && e.attacker === this.creature && e.target) this.camera.shake(0.16);
      })
    );
    this._unsubs.push(
      events.on("legBreak", (e) => {
        if (e && e.creature === this.creature) this.camera.shake(0.5);
      })
    );
  }

  _hints(dt, c) {
    this._hintT -= dt;
    this._sinceHint += dt;
    // One hint at a time, spaced out, so they never stack on screen.
    if (this._hintT > 0 || this._sinceHint < HINT_SPACING) return;
    this._hintT = HINT_INTERVAL;
    const seen = this._hintsSeen;
    const touch = this.input.isTouch;
    const herb = dietOf(c) !== "carnivore";
    const eat = touch ? "hold Eat/Drink" : "hold E";

    if (!seen.controls && this._aliveT > 1.5) {
      this._hint(
        "controls",
        touch
          ? "Left thumb moves, drag the right side to look around."
          : "Click to look around · WASD to move · Shift to sprint · H for help"
      );
    } else if (!seen.hungry && (c.food ?? 100) < 30) {
      this._hint(
        "hungry",
        herb
          ? `Hungry — find ferns, cycads or horsetails and ${eat}. Sniff${touch ? "" : " (R)"} reveals food nearby.`
          : `Hungry — find a carcass or make a kill, then ${eat} to feed.`,
        "warn"
      );
    } else if (!seen.thirsty && (c.water ?? 100) < 30) {
      this._hint("thirsty", "Thirsty — drink from a lake or river; the sea is salt. Sniff points to fresh water.", "warn");
    } else if (!seen.night && this._aliveT > 4 && this.world?.sky?.isNight?.()) {
      this._hint("night", `Night falls and predators roam. Rest${touch ? "" : " (Z)"} somewhere hidden to heal faster.`);
    } else if (!seen.bleeding && (c.bleeding ?? 0) > 0.05) {
      this._hint("bleeding", "You're bleeding. Resting slows it — find cover first.", "danger");
    } else if (!seen.stamina && (c.stamina ?? 100) < 3 && this._aliveT > 2) {
      this._hint("stamina", "Out of stamina — slow down to catch your breath.");
    } else if (!seen.swim && c.swimming && (speciesOf(c)?.swim ?? 0) < 0.6) {
      this._hint("swim", "Swimming drains stamina. Don't run out in deep water.");
    }
  }

  _hint(id, text, kind = "info") {
    if (this._hintsSeen[id]) return;
    this._hintsSeen[id] = true;
    this._sinceHint = 0;
    saveHints(this._hintsSeen);
    this.world?.events?.emit("notify", { text, kind });
  }
}
