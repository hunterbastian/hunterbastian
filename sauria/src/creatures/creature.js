// Creature — one simulated dinosaur. The same class drives the player and every
// NPC: controllers (PlayerController, the ai.js Brain) only ever write
// `creature.intent`, and update() turns that into locomotion, terrain following,
// swimming, collisions, metabolism, growth, combat, feeding and animation.
//
// The ecosystem owns the scene graph: a Creature builds its DinoModel but never
// adds it to the scene. Everything here is allocation-free per frame (module
// temps + per-creature scratch) because ~30 of these update every frame.

import * as THREE from "three";
import { getSpecies, growthScale, growthStage } from "./species.js";
import { createDinoModel } from "./dinoModel.js";
import { clamp, lerp, damp, smoothstep, wrapAngle, angleDiff, yawFromDir } from "../core/math.js";
import { makeRng, hash } from "../core/rng.js";

/* --- Tuning ------------------------------------------------------------- */

const GRAVITY = 9.81;
const NPC_METABOLISM = 0.35; // NPCs burn food/water slower so the world stays alive
// Uphill: rise/run along the heading. Slowing starts on gentle grades; walls
// steeper than BLOCK_GRADE (~52°, ≈0.39 in terrain.slopeAt's 1 − n.y units)
// stop the animal. The island's plains carry 30–40° terrace banks a few metres
// high, which must stay climbable; real rock faces don't.
const SLOW_GRADE = 0.08;
const BLOCK_GRADE = 1.3;
const STICK_GRADE = 1.3; // steeper descents than this (per metre moved) become a fall
const BITE_CONE = (35 * Math.PI) / 180; // half-angle in front for bite / kick
const TAIL_ARC_MIN = Math.PI - (110 * Math.PI) / 180; // tail hits ±110° around "behind"
const ATTACK_STAMINA = 8;
const EVENT_INTERVAL = 0.5; // eat / drink events at most 2 per second
const DOT_EVENT_INTERVAL = 1; // starvation / bleeding "damage" events once a second
const REST_LOCK = 2; // seconds a hit keeps a creature from lying back down
const GOOD_SWIMMER = 0.7; // swim ability at which swimming costs no stamina
const LEG_HEAL_TIME = 70; // seconds a broken leg takes to heal (resting heals ×2)
const QUADRUPEDS = new Set(["stegosaurus", "gastonia", "diplodocus", "brontosaurus", "camptosaurus"]); // fallback when body.plan is absent
const ATTACK_TYPES = { bite: true, tail: true, kick: true };

// One-shot attack timing: total duration and the moment (0..1) the blow lands.
const ATTACK_TIMING = {
  bite: { dur: 0.55, strike: 0.42, lunge: 1.6 },
  kick: { dur: 0.6, strike: 0.45, lunge: 0.9 },
  tail: { dur: 0.85, strike: 0.5, lunge: 0 },
};

// Noise by gait — the [hunter] hearing sense reads creature.noise.
const GAIT_NOISE = { idle: 0.05, walk: 0.25, trot: 0.5, sprint: 1, swim: 0.3 };

const CAUSES = {
  starve: "Starvation",
  dehydrate: "Dehydration",
  bleed: "Blood loss",
  drown: "Drowned",
  fall: "A fatal fall",
  shot: "Shot",
};

/* --- Scratch (module-level so hot paths never allocate) ----------------- */

const _head = new THREE.Vector3();
const _segA = new THREE.Vector3(); // strike sweep: chest (or hips) …
const _segB = new THREE.Vector3(); // … to snout (or tail tip)
const _near = [];
const _targets = [];
const _colliders = [];
const _spheres = [];

let nextId = 1;

/**
 * Allocate a unique actor id. Creatures use it; creature-compatible actors
 * (e.g. the [hunter] Hunter) may call it too so ids never collide.
 * @returns {number}
 */
export function allocateActorId() {
  return nextId++;
}

const article = (name) => (/^[aeiou]/i.test(name) ? "an" : "a");

/* --- Creature ------------------------------------------------------------ */

export class Creature {
  /**
   * @param {object} world  World (terrain, vegetation, ecosystem, events, …)
   * @param {{ species: object|string, growth?: number, x?: number, z?: number, heading?: number,
   *           isPlayer?: boolean, seed?: number }} opts
   */
  constructor(world, { species, growth = 0, x = 0, z = 0, heading = 0, isPlayer = false, seed } = {}) {
    this.id = allocateActorId();
    this.world = world;
    this.species = typeof species === "string" ? getSpecies(species) : species;
    if (!this.species || !this.species.id) throw new Error("Creature: a species def or id is required");
    this.isPlayer = !!isPlayer;
    this.isHunter = false;
    this.alive = true;
    this.brain = null;
    /** Herd / pack this creature belongs to ({ id, species, members, leader }) — set by the ecosystem. */
    this.group = null;
    this.seed = (seed ?? hash(this.id, this.species.id)) >>> 0;

    const rng = makeRng(hash(this.seed, "stats"));
    this.growth = clamp(+growth || 0, 0, 1);
    this.food = 70 + rng() * 20;
    this.water = 70 + rng() * 20;
    this.stamina = 100;
    this.bleeding = 0; // hp/s
    this.legBroken = 0; // seconds left

    this.resting = false;
    this.crouching = false;
    this.swimming = false;
    this.eating = false;
    this.drinking = false;
    /** True while falling (walked off a drop steeper than the creature can follow). */
    this.airborne = false;
    /** True after stamina hit 0, until it recovers to 15 % — no sprinting meanwhile. */
    this.exhausted = false;
    /** 0..1 how deep the body sits in water (1 = swimming depth). */
    this.submerged = 0;

    this.position = new THREE.Vector3(x, 0, z);
    this.velocity = new THREE.Vector3();
    this.heading = wrapAngle(heading);
    this.speed = 0;
    this.gait = "idle";
    /** Signed yaw rate (rad/s) — drives the model's body/tail bend. */
    this.turnSpeed = 0;

    this.age = 0;
    this.kills = 0;
    this.lastAttacker = null;
    /** `age` (s) at the most recent damage; -Infinity if never hurt. Compare with `creature.age`. */
    this.lastDamageTime = -Infinity;
    this.causeOfDeath = null;
    this.biteCooldown = 0;
    this.callCooldown = 0;
    this.hurt = 0;

    this.intent = {
      moveX: 0,
      moveZ: 0,
      sprint: false,
      crouch: false,
      bite: false,
      eat: false,
      drink: false,
      call: false,
      rest: false,
    };

    // [hunter] stealth signals read by the AI senses for any target.
    this.scent = 1;
    this.noise = GAIT_NOISE.idle;
    this.visibility = 1;

    /** Optional look target ({x,z} | Creature | Carcass) for the head; falls back to brain.target. */
    this.lookTarget = null;
    this.lookYaw = 0;
    /** Animation level of detail set by the ecosystem: 1 = every frame, 2 = every other … */
    this.animLod = 1;

    // Derived tuning with defensive defaults, resolved once.
    const sp = this.species;
    const spd = sp.speed || {};
    const plan = sp.body && sp.body.plan;
    const quadruped = !!(sp.quadruped ?? (plan ? plan === "quadruped" : QUADRUPEDS.has(sp.id)));
    this._t = {
      walk: spd.walk ?? 1.5,
      trot: spd.trot ?? 4,
      sprint: spd.sprint ?? 8,
      crouch: spd.crouch ?? 1,
      swim: spd.swim ?? 1.5,
      turnRate: sp.turnRate ?? 2,
      regen: sp.stamina?.regen ?? 8,
      sprintDrain: sp.stamina?.sprintDrain ?? 10,
      hunger: sp.metabolism?.hunger ?? 3,
      thirst: sp.metabolism?.thirst ?? 4,
      swimAbility: clamp(sp.swim ?? 0.3, 0, 1),
      bite: sp.bite ?? 10,
      bleed: sp.bleed ?? 0,
      biteRange: sp.biteRange ?? 0.6,
      biteCooldown: sp.biteCooldown ?? 1,
      armor: clamp(sp.armor ?? 0, 0, 0.9),
      // Spiky armour bites back: share of a biter's raw damage reflected to it.
      // Heavily plated species (Gastonia) get a default unless the def sets one.
      thorns: clamp(sp.thorns ?? ((sp.armor ?? 0) >= 0.5 ? 0.15 : 0), 0, 1),
      growthSec: Math.max(1, (sp.growthMinutes ?? 25) * 60),
      quadruped,
      callDur: clamp(sp.call?.duration ?? 1.2, 0.5, 2.5),
      // Swimming float: the hip joint this many hip-heights below the surface
      // sits the torso low in the water with back and head clear. Low-headed
      // quadrupeds float higher so their heads stay above water.
      swimDepth: clamp(sp.swimDepth ?? (quadruped ? 0.6 : 0.75), 0.3, 1),
    };

    // Private state.
    this._scale = 1;
    this._scaleFor = NaN;
    this._stage = growthStage(this.growth);
    this._sprinting = false;
    this._desiredYaw = this.heading;
    this._restBlend = 0;
    this._restLock = 0;
    this._crouchBlend = 0;
    this._pitch = 0;
    this._roll = 0;
    this._vy = 0;
    this._prevGround = 0;
    this._lastX = x;
    this._lastZ = z;
    this._kx = 0; // knockback / lunge velocity (m/s), decays
    this._kz = 0;
    this._grade = 0;
    this._animSpeed = 0;
    this._staminaDelay = 0;
    this._attackKind = sp.attack || "bite";
    this._attackT = -1; // < 0 = no attack in progress
    this._attackDur = 0.6;
    this._attackStrikeAt = 0.45;
    this._attackStruck = false;
    this._callT = -1;
    this._noiseSpike = 0;
    this._headroom = 0;
    this._eatAcc = 0;
    this._eatTimer = 0;
    this._eatKind = "plant";
    this._foodKind = null;
    this._drinkAcc = 0;
    this._drinkTimer = 0;
    this._dotAcc = { starve: 0, dehydrate: 0, bleed: 0, drown: 0 };
    this._dotTimer = DOT_EVENT_INTERVAL;
    this._deadT = 0;
    this._animAcc = 0;
    this._animTick = 0;
    this._modelScale = NaN;
    this._carcass = null; // set when the ecosystem turns this body into a carcass
    this._disposed = false;
    this._anim = { speed: 0, crouch: 0, swim: 0, turn: 0, action: null, actionT: 0, lookYaw: 0, hurt: 0 };

    this.health = this.maxHealth;

    this.model = createDinoModel(this.species, { seed: this.seed });
    if (this.model && this.model.object) {
      this.model.object.rotation.order = "YXZ"; // yaw, then pitch/roll in the body frame
      this.model.object.userData.creature = this;
    }

    this._snapToGround();
    this._orient(0, true);
    this._syncModel();
    if (this.model) this.model.update(0, this._fillAnim());
  }

  /* --- Derived values --------------------------------------------------- */

  /** Current size multiplier (juvenileScale..1) — cached per growth value. */
  get scale() {
    if (this._scaleFor !== this.growth) {
      this._scaleFor = this.growth;
      this._scale = growthScale(this.species, this.growth);
    }
    return this._scale;
  }

  /** Current mass in kg (species mass × scale³). */
  get mass() {
    const s = this.scale;
    return this.species.mass * s * s * s;
  }

  /** Max HP — 15 % of the adult value at hatching, 100 % as an adult. */
  get maxHealth() {
    return this.species.health * lerp(0.15, 1, this.growth);
  }

  /** Collision circle radius (m) around the hips. */
  get radius() {
    const sp = this.species;
    const adult = sp.radius ?? Math.max(sp.length * 0.11, sp.height * 0.35, Math.cbrt(sp.mass) * 0.06);
    return adult * this.scale;
  }

  /** "juvenile" | "subadult" | "adult" */
  get stage() {
    return growthStage(this.growth);
  }

  /** "carnivore" | "herbivore" */
  get diet() {
    return this.species.diet;
  }

  /** Hip height in metres at the current size. */
  get hipHeight() {
    return this.species.height * this.scale;
  }

  // Plain coordinate accessors so AI code can treat Creatures, Carcasses and
  // {x, z} points alike (e.g. wind.scentFactor(target.x, target.z, …)).
  get x() {
    return this.position.x;
  }
  get y() {
    return this.position.y;
  }
  get z() {
    return this.position.z;
  }

  /** Unit facing vector. */
  forward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * World position of the mouth (eat / drink / bite reach). Uses the animated
   * model when it has one, else an estimate from the body proportions.
   */
  headPosition(target = new THREE.Vector3()) {
    const m = this.model;
    if (m && typeof m.getHeadPosition === "function" && this._modelPointOk(m.getHeadPosition(target) || target)) {
      return target;
    }
    const s = this.scale;
    const reach = this.species.length * 0.42 * s;
    return target.set(
      this.position.x + Math.sin(this.heading) * reach,
      this.position.y + this.species.height * 0.85 * s,
      this.position.z + Math.cos(this.heading) * reach
    );
  }

  /** World position near the tail tip (tail-swipe origin). */
  tailPosition(target = new THREE.Vector3()) {
    const m = this.model;
    if (m && typeof m.getTailPosition === "function" && this._modelPointOk(m.getTailPosition(target) || target)) {
      return target;
    }
    const s = this.scale;
    const reach = this.species.length * 0.5 * s;
    return target.set(
      this.position.x - Math.sin(this.heading) * reach,
      this.position.y + this.species.height * 0.6 * s,
      this.position.z - Math.cos(this.heading) * reach
    );
  }

  // Guards against a model whose matrices haven't been composed yet.
  _modelPointOk(p) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
    const lim = this.species.length * this.scale + 2;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    return dx * dx + dz * dz < lim * lim && Math.abs(p.y - this.position.y) < lim;
  }

  /**
   * Diet-appropriate food within reach of the head: carcasses for carnivores,
   * plants for herbivores. While already eating, the reach is a little longer
   * so the lowered feeding pose doesn't break contact.
   * @returns {{ kind: "carcass" | "plant", target: object } | null}
   */
  findFood() {
    const target = this._findFoodTarget();
    return target ? { kind: this._foodKind, target } : null;
  }

  // Allocation-free core of findFood(); sets this._foodKind.
  _findFoodTarget() {
    if (!this.alive) return null;
    const head = this.headPosition(_head);
    const s = this.scale;
    const reach = 0.9 + 0.8 * s + (this.eating ? 0.8 + 0.6 * s : 0);
    if (this.species.diet === "carnivore") {
      const eco = this.world.ecosystem;
      if (!eco || typeof eco.nearestCarcass !== "function") return null;
      // Carcasses are big: query wide, then test against the body's own radius.
      const c = eco.nearestCarcass(head.x, head.z, reach + 7, 0.5);
      if (!c) return null;
      const r = reach + (c.radius ?? 1);
      const dx = c.x - head.x;
      const dz = c.z - head.z;
      if (dx * dx + dz * dz > r * r) return null;
      this._foodKind = "carcass";
      return c;
    }
    const veg = this.world.vegetation;
    if (!veg || typeof veg.nearestPlant !== "function") return null;
    const p = veg.nearestPlant(head.x, head.z, reach, 1);
    if (!p) return null;
    this._foodKind = "plant";
    return p;
  }

  /**
   * What the mouth is over: fresh water (lake / river), salt water (ocean) or
   * nothing. Checks the head and ~1 m beyond it (a little further while
   * already drinking, since the drinking pose pulls the snout back).
   * @returns {"fresh" | "salt" | null}
   */
  canDrink() {
    const t = this.world.terrain;
    if (!t || !this.alive) return null;
    const head = this.headPosition(_head);
    const s = this.scale;
    const ahead = 1 + 0.5 * s + (this.drinking ? 1 + 0.6 * s : 0);
    const ax = head.x + Math.sin(this.heading) * ahead;
    const az = head.z + Math.cos(this.heading) * ahead;
    if (t.isFreshWater(head.x, head.z) || t.isFreshWater(ax, az)) return "fresh";
    if (t.isWater(head.x, head.z) || t.isWater(ax, az)) return "salt";
    return null;
  }

  /* --- Simulation step -------------------------------------------------- */

  /**
   * Full simulation step: actions, movement, terrain following, swimming,
   * collisions, feeding, metabolism, growth, regen, bleeding, stealth signals
   * and model animation. Consumes the one-shot intents (bite, call).
   * @param {number} dt seconds
   */
  update(dt) {
    if (!(dt > 0)) return;
    this.age += dt;
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    if (!this.alive) {
      this._updateDead(dt);
      return;
    }
    this._timers(dt);
    this._actions(dt);
    this._locomotion(dt);
    this._feeding(dt);
    this._physiology(dt);
    if (!this.alive) {
      this._updateDead(dt);
      return;
    }
    this._stealth(dt);
    this._orient(dt, false);
    this._animate(dt);
  }

  _timers(dt) {
    this.biteCooldown = Math.max(0, this.biteCooldown - dt);
    this.callCooldown = Math.max(0, this.callCooldown - dt);
    this._restLock = Math.max(0, this._restLock - dt);
    this._noiseSpike = Math.max(0, this._noiseSpike - dt * 0.8);
  }

  /* --- Movement --------------------------------------------------------- */

  _locomotion(dt) {
    const t = this._t;
    const intent = this.intent;
    const terrain = this.world.terrain;
    const pos = this.position;

    // Teleported since last frame (spawn, ?pos=, respawn): re-seat, no fall.
    if (Math.abs(pos.x - this._lastX) + Math.abs(pos.z - this._lastZ) > 8) this._snapToGround();

    let mx = +intent.moveX || 0;
    let mz = +intent.moveZ || 0;
    let mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
      mag = 1;
    }
    const moving = mag > 0.05;
    const s = this.scale;
    const hip = Math.max(0.05, this.species.height * s);
    const growthSpeed = lerp(0.85, 1, this.growth);

    // Water: hysteresis so the swim state doesn't flicker at the threshold.
    const depth = terrain ? terrain.waterDepthAt(pos.x, pos.z) : 0;
    if (!this.swimming && depth > 0.8 * hip) this.swimming = true;
    else if (this.swimming && depth < 0.65 * hip) this.swimming = false;
    this.submerged = clamp((depth - 0.3 * hip) / (0.5 * hip), 0, 1);

    // Posture states.
    const attacking = this._attackT >= 0;
    this.resting =
      !!intent.rest &&
      !moving &&
      !intent.eat &&
      !intent.drink &&
      !this.swimming &&
      !this.airborne &&
      !attacking &&
      this._restLock <= 0 &&
      this.speed < 0.8;
    // Lying down is slow, getting up is quicker; movement waits for it.
    this._restBlend = damp(this._restBlend, this.resting ? 1 : 0, this.resting ? 1.8 : 3.5, dt);
    if (this._restBlend < 0.002) this._restBlend = 0;

    if (this.stamina <= 0.01) this.exhausted = true;
    else if (this.exhausted && this.stamina >= 15) this.exhausted = false;
    const sprinting =
      !!intent.sprint &&
      moving &&
      mag > 0.3 &&
      !this.exhausted &&
      this.legBroken <= 0 &&
      !this.swimming &&
      !this.airborne;
    this._sprinting = sprinting;
    this.crouching = !!intent.crouch && !sprinting && !this.swimming && !this.resting;
    this._crouchBlend = damp(this._crouchBlend, this.crouching ? 1 : 0, 8, dt);

    // Turning: a damped P-controller on yaw rate gives smooth starts and stops.
    let aligned = 1;
    let turnTarget = 0;
    if (moving) {
      this._desiredYaw = yawFromDir(mx, mz);
      const err = angleDiff(this.heading, this._desiredYaw);
      aligned = Math.cos(err);
      let rate = t.turnRate * lerp(1.4, 1, smoothstep(0, 0.6, this.growth)); // juveniles are nimble
      if (sprinting) rate *= 0.6;
      if (this.swimming) rate *= 0.75;
      if (this.legBroken > 0) rate *= 0.7;
      rate *= 1 - this._restBlend * 0.9;
      turnTarget = clamp(err * 5, -rate, rate);
    }
    this.turnSpeed = damp(this.turnSpeed, turnTarget, 12, dt);
    if (!this.airborne) this.heading = wrapAngle(this.heading + this.turnSpeed * dt);

    // Target ground speed.
    let target = 0;
    if (moving && !this.airborne) {
      if (this.swimming) {
        target = t.swim * (0.4 + 0.6 * t.swimAbility) * growthSpeed * Math.min(1, mag * 1.6);
        if (this.stamina <= 0) target *= 0.55;
      } else if (sprinting) target = t.sprint * growthSpeed;
      else if (this.crouching) target = t.crouch * growthSpeed * clamp(mag / 0.5, 0.35, 1);
      else if (mag <= 0.5) target = t.walk * growthSpeed * Math.max(0.35, mag / 0.5);
      else target = lerp(t.walk, t.trot, (mag - 0.5) / 0.5) * growthSpeed;
      if (this.legBroken > 0) target *= 0.5;
      // Facing away from the goal: slow down and turn instead of carving a huge arc.
      target *= clamp((aligned + 0.35) / 1.35, 0.12, 1);
      if (!this.swimming && depth > 0) target *= 1 - 0.45 * clamp(depth / hip, 0, 1); // wading
      if (attacking) target *= 0.6;
      target *= 1 - this._restBlend;
    }

    // Uphill slows by the grade along the heading; too steep blocks.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    let blocked = false;
    this._grade = 0;
    if (terrain && !this.swimming) {
      // Look further ahead for bigger animals so small bumps don't stop them.
      const probe = clamp(hip * 1.2, 1, 4);
      const grade = (terrain.heightAt(pos.x + fx * probe, pos.z + fz * probe) - terrain.heightAt(pos.x, pos.z)) / probe;
      this._grade = grade;
      if (grade > 0) {
        blocked = grade >= BLOCK_GRADE;
        target *= blocked ? 0 : 1 - 0.7 * clamp((grade - SLOW_GRADE) / (BLOCK_GRADE - SLOW_GRADE), 0, 1);
      }
    }

    // Exponential accel/decel; heavy animals take longer to get going.
    if (!this.airborne) {
      const rate = clamp(5 / (1 + this.mass / 1500), 1.2, 5);
      this.speed = damp(this.speed, target, target > this.speed ? rate : rate * 1.6, dt);
      if (target === 0 && this.speed < 0.02) this.speed = 0;
    }

    // Integrate: along the heading (no strafing) + knockback/lunge impulse.
    const step = blocked ? 0 : this.speed * dt;
    const prevY = pos.y;
    pos.x += fx * step + this._kx * dt;
    pos.z += fz * step + this._kz * dt;
    const kDecay = Math.exp(-6 * dt);
    this._kx *= kDecay;
    this._kz *= kDecay;
    if (Math.abs(this._kx) + Math.abs(this._kz) < 0.01) this._kx = this._kz = 0;

    this._collide();

    if (terrain) {
      const lim = (terrain.half ?? terrain.size / 2) - 30;
      if (!terrain.inBounds(pos.x, pos.z, 30)) {
        pos.x = clamp(pos.x, -lim, lim);
        pos.z = clamp(pos.z, -lim, lim);
      }
    }

    // Vertical: smoothed ground follow, swimming float, or a ballistic fall.
    const ground = this._groundHeight(pos.x, pos.z, hip);
    const sea = terrain ? terrain.seaLevel ?? 0 : 0;
    const targetY = this.swimming ? Math.max(ground, sea - this._t.swimDepth * hip) : ground;
    const groundRate = (ground - this._prevGround) / dt;
    if (this.airborne) {
      this._vy -= GRAVITY * dt;
      pos.y += this._vy * dt;
      if (pos.y <= targetY) {
        // Landing on ground that itself falls away (a slope) cushions the impact.
        const impact = -this._vy - Math.max(0, -groundRate);
        pos.y = targetY;
        this.airborne = false;
        this._vy = 0;
        if (!this.swimming && (terrain ? terrain.waterDepthAt(pos.x, pos.z) : 0) < 0.5 * hip) this._land(impact);
      }
    } else {
      const moved = Math.hypot(pos.x - this._lastX, pos.z - this._lastZ);
      const drop = this._prevGround - ground;
      const follow = 0.06 + moved * STICK_GRADE;
      if (!this.swimming && drop > follow) {
        // The ground fell away faster than legs can follow: start falling at
        // the descent rate we had, then gravity takes over.
        this.airborne = true;
        this._vy = -follow / dt;
        pos.y += this._vy * dt;
      } else {
        // Light temporal smoothing hides the terrain's cell creases; in water
        // a slower settle reads as buoyancy.
        pos.y = damp(pos.y, targetY, this.swimming ? 5 : 22, dt);
        if (pos.y < targetY - 0.12) pos.y = targetY - 0.12;
        else if (pos.y > targetY + 0.5 && !this.swimming) pos.y = targetY + 0.5;
      }
    }
    this._prevGround = ground;

    // Velocity = actual displacement (includes collisions and knockback).
    this.velocity.set((pos.x - this._lastX) / dt, this.airborne ? this._vy : (pos.y - prevY) / dt, (pos.z - this._lastZ) / dt);
    this._lastX = pos.x;
    this._lastZ = pos.z;
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    this._animSpeed = damp(this._animSpeed, planar, 10, dt);

    // Gait label from the actual locomotion speed.
    const walk = t.walk * growthSpeed;
    const trot = t.trot * growthSpeed;
    const sprint = t.sprint * growthSpeed;
    if (this.swimming) this.gait = "swim";
    else if (this.speed < 0.15) this.gait = "idle";
    else if (sprinting && this.speed > lerp(trot, sprint, 0.3)) this.gait = "sprint";
    else if (this.speed > (walk + trot) * 0.5) this.gait = "trot";
    else this.gait = "walk";
  }

  // Ground height averaged over a small cross under the hips: smooths the
  // kinks between terrain triangles so the body doesn't jitter.
  _groundHeight(x, z, hip) {
    const t = this.world.terrain;
    if (!t) return 0;
    const r = clamp(hip * 0.35, 0.3, 1.5);
    return (
      t.heightAt(x, z) * 0.4 +
      (t.heightAt(x + r, z) + t.heightAt(x - r, z) + t.heightAt(x, z + r) + t.heightAt(x, z - r)) * 0.15
    );
  }

  _snapToGround() {
    const pos = this.position;
    const t = this.world.terrain;
    const hip = Math.max(0.05, this.species.height * this.scale);
    const ground = this._groundHeight(pos.x, pos.z, hip);
    const depth = t ? t.waterDepthAt(pos.x, pos.z) : 0;
    this.swimming = depth > 0.8 * hip;
    this.submerged = clamp((depth - 0.3 * hip) / (0.5 * hip), 0, 1);
    pos.y = this.swimming ? Math.max(ground, (t?.seaLevel ?? 0) - this._t.swimDepth * hip) : ground;
    this._prevGround = ground;
    this.airborne = false;
    this._vy = 0;
    this._lastX = pos.x;
    this._lastZ = pos.z;
    this.velocity.set(0, 0, 0);
  }

  // Mass-weighted circle collisions vs tree trunks / boulders and creatures.
  _collide() {
    const pos = this.position;
    const r = this.radius;
    const veg = this.world.vegetation;
    if (veg && typeof veg.collidersNear === "function") {
      // Trunks fit between legs and under bellies: use a slimmer body circle.
      const rr = r * 0.7;
      _colliders.length = 0;
      const list = veg.collidersNear(pos.x, pos.z, rr + 3, _colliders) || _colliders;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const min = rr + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        if (d2 < 1e-8) {
          pos.x += min;
          continue;
        }
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
    const eco = this.world.ecosystem;
    if (eco && typeof eco.query === "function") {
      const list = eco.query(pos.x, pos.z, r + (eco.maxRadius ?? 3.5), null, _near);
      const m = this.mass;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === this || !o.alive || !o.position) continue;
        const dx = pos.x - o.position.x;
        const dz = pos.z - o.position.z;
        const min = r + (o.radius ?? 0.4);
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const om = o.mass ?? 80;
        const share = om / (m + om); // the lighter body yields more
        if (d2 < 1e-8) {
          // Exactly stacked (spawned on the same spot): separate along a stable axis.
          const a = (this.id * 2.39996) % (Math.PI * 2);
          pos.x += Math.sin(a) * min * share;
          pos.z += Math.cos(a) * min * share;
          continue;
        }
        const d = Math.sqrt(d2);
        const push = ((min - d) * share) / d;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  }

  // Ballistic landing: big, fast drops hurt and can break a leg.
  _land(impact) {
    // Small animals shrug off drops that would cripple a 2-tonne adult.
    const safe = lerp(11, 7.5, clamp(this.mass / 2000, 0, 1));
    if (impact <= safe) return;
    const over = impact - safe;
    this.takeDamage(this.maxHealth * 0.07 * over, null, "fall");
    if (this.alive && over > 2.5 && this.legBroken <= 0) {
      this.legBroken = LEG_HEAL_TIME + over * 4;
      this.world.events?.emit("legBreak", { creature: this });
    }
  }

  // Pitch/roll the body to the terrain under it (quadrupeds follow the ground
  // more than bipeds, which keep their spine level).
  _orient(dt, instant) {
    const t = this.world.terrain;
    let pitchT = 0;
    let rollT = 0;
    if (t && (!this.alive || (!this.swimming && !this.airborne))) {
      const x = this.position.x;
      const z = this.position.z;
      const fx = Math.sin(this.heading);
      const fz = Math.cos(this.heading);
      const s = this.scale;
      const half = Math.max(0.35, this.species.length * 0.3 * s);
      const pitch = Math.atan2(t.heightAt(x - fx * half, z - fz * half) - t.heightAt(x + fx * half, z + fz * half), 2 * half);
      // Right-hand side of a body facing +Z is −X: right = (−cos, 0, sin).
      const w = Math.max(0.3, this.radius);
      const roll = Math.atan2(t.heightAt(x + fz * w, z - fx * w) - t.heightAt(x - fz * w, z + fx * w), 2 * w);
      const dead = !this.alive;
      const quad = this._t.quadruped;
      pitchT = pitch * (dead ? 1 : quad ? 0.85 : 0.45);
      rollT = roll * (dead ? 1 : quad ? 0.5 : 0.2);
    }
    if (instant) {
      this._pitch = pitchT;
      this._roll = rollT;
    } else {
      this._pitch = damp(this._pitch, pitchT, 6, dt);
      this._roll = damp(this._roll, rollT, 6, dt);
    }
  }

  /* --- Actions ---------------------------------------------------------- */

  _actions(dt) {
    const intent = this.intent;
    if (intent.bite) {
      intent.bite = false;
      if (this._attackT < 0 && this.biteCooldown <= 0 && this.stamina > 2 && !this.airborne) this._startAttack();
    }
    if (intent.call) {
      intent.call = false;
      if (this.callCooldown <= 0) this._startCall();
    }
    if (this._attackT >= 0) {
      this._attackT += dt / this._attackDur;
      if (!this._attackStruck && this._attackT >= this._attackStrikeAt) {
        this._attackStruck = true;
        this._strike();
      }
      if (this._attackT >= 1) this._attackT = -1;
    }
    if (this._callT >= 0) {
      this._callT += dt / this._t.callDur;
      if (this._callT >= 1) this._callT = -1;
    }
  }

  _startAttack() {
    const t = this._t;
    const kind = ATTACK_TIMING[this._attackKind] ? this._attackKind : "bite";
    const timing = ATTACK_TIMING[kind];
    // Bigger animals wind up a touch slower; never longer than the cooldown.
    const heft = clamp(0.85 + Math.log10(Math.max(1, this.mass) / 100) * 0.12, 0.8, 1.3);
    this._attackKind = kind;
    this._attackDur = Math.min(timing.dur * heft, t.biteCooldown * 0.9 || timing.dur);
    this._attackStrikeAt = timing.strike;
    this._attackT = 0;
    this._attackStruck = false;
    this._callT = -1;
    this.biteCooldown = t.biteCooldown;
    this.stamina = Math.max(0, this.stamina - ATTACK_STAMINA);
    this._staminaDelay = 0.8;
    this._restLock = Math.max(this._restLock, 1);
    if (timing.lunge > 0 && !this.swimming) {
      const l = timing.lunge * lerp(0.5, 1, this.scale);
      this._kx += Math.sin(this.heading) * l;
      this._kz += Math.cos(this.heading) * l;
    }
  }

  _startCall() {
    this.callCooldown = 3;
    if (this._attackT < 0) this._callT = 0;
    this._noiseSpike = 1;
    this.world.events?.emit("call", { creature: this, x: this.position.x, z: this.position.z });
  }

  // The moment the blow lands: pick the nearest valid target in reach & arc.
  // Reach is measured from the whole sweep of the strike — chest → snout for
  // bites/kicks, hips → tail tip for swipes — so prey standing right under a
  // big predator's chin can still be bitten.
  _strike() {
    const kind = this._attackKind;
    const s = this.scale;
    const reach = this._t.biteRange * s;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const r = this.radius;
    const hip = this.species.height * s;
    if (kind === "tail") {
      this.tailPosition(_segB);
      _segA.set(this.position.x - fx * r, this.position.y + hip * 0.7, this.position.z - fz * r);
    } else {
      this.headPosition(_segB);
      _segA.set(this.position.x + fx * r, this.position.y + hip * 0.85, this.position.z + fz * r);
    }
    // How far the head (or tail) can dip or rise to meet a target.
    this._headroom = hip * 0.8;
    const eco = this.world.ecosystem;
    const preferred = this.brain && this.brain.target;
    let best = null;
    let bestScore = Infinity;
    if (eco && typeof eco.query === "function") {
      const searchR = this.species.length * s + reach + (eco.maxRadius ?? 3.5) + 2;
      const list = eco.query(this.position.x, this.position.z, searchR, null, _targets);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === this || !o.alive || typeof o.takeDamage !== "function") continue;
        if (this.group && o.group === this.group) continue; // pack-mates don't maul each other
        const d = this._reachDistance(o, kind, reach);
        if (d > reach) continue;
        const score = o === preferred ? d - 0.75 : d;
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      }
      _targets.length = 0;
    }

    const growthMul = lerp(0.12, 1, this.growth);
    const raw = this._t.bite * growthMul;
    let dealt = 0;
    if (best) {
      const victim = best;
      dealt = victim.takeDamage(raw, this, kind);
      const armor = clamp(victim.species?.armor ?? 0, 0, 0.9);
      const bleed = this._t.bleed * growthMul * (1 - armor * 0.5);
      if (victim.alive && bleed > 0 && typeof victim.bleeding === "number") {
        const cap = (victim.maxHealth ?? 100) * 0.06; // never an instant bleed-out
        victim.bleeding = Math.min(cap, victim.bleeding + bleed);
      }
      this._knockback(victim, kind);
      // Spiky armour ("thorns"): biting it hurts the biter.
      const thorns = victim._t ? victim._t.thorns : victim.species?.thorns ?? 0;
      if (kind === "bite" && thorns > 0 && this.alive) this.takeDamage(raw * thorns, victim, "tail");
    }
    this._noiseSpike = Math.max(this._noiseSpike, 0.8);
    this.world.events?.emit("attack", { attacker: this, target: best, damage: dealt, kind });
  }

  // Surface distance (m) from the strike sweep to the target's body, or
  // Infinity when the target is outside the attack's arc.
  _reachDistance(o, kind, reach) {
    const m = o.model;
    if (m && typeof m.getHitSpheres === "function") {
      _spheres.length = 0;
      let spheres = null;
      try {
        spheres = m.getHitSpheres(_spheres) || _spheres;
      } catch (err) {
        spheres = null;
      }
      if (spheres && spheres.length) {
        let best = Infinity;
        for (let i = 0; i < spheres.length; i++) {
          const sp = spheres[i];
          const d = this._sweepDist(sp.x, sp.y, sp.z) - sp.r;
          if (d >= best || d > reach) continue;
          // Jaws already inside the body always connect; otherwise check the arc.
          if (d > 0 && !this._inArc(sp.x, sp.z, kind)) continue;
          best = d;
        }
        _spheres.length = 0;
        return best;
      }
    }
    // Circle fallback (actors without a model, e.g. the [hunter] Hunter):
    // aim at the middle of the body.
    const op = o.position;
    const mid = (o.species?.height ?? 1) * (o.scale ?? 1) * 0.8;
    const d = this._sweepDist(op.x, op.y + mid, op.z) - (o.radius ?? 0.4);
    if (d > reach) return Infinity;
    if (d > 0 && !this._inArc(op.x, op.z, kind)) return Infinity;
    return Math.max(0, d);
  }

  // Distance from a point to the strike segment _segA→_segB, with the vertical
  // gap discounted by how far the head/tail can dip or rise.
  _sweepDist(px, py, pz) {
    const ax = _segA.x;
    const ay = _segA.y;
    const az = _segA.z;
    const abx = _segB.x - ax;
    const aby = _segB.y - ay;
    const abz = _segB.z - az;
    const len2 = abx * abx + aby * aby + abz * abz;
    const t = len2 > 1e-8 ? clamp(((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2, 0, 1) : 0;
    const dx = px - (ax + abx * t);
    const dz = pz - (az + abz * t);
    const dy = Math.max(0, Math.abs(py - (ay + aby * t)) - this._headroom);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _inArc(x, z, kind) {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < this.radius * 0.5) return true;
    const cos = (dx * Math.sin(this.heading) + dz * Math.cos(this.heading)) / d;
    const ang = Math.acos(clamp(cos, -1, 1));
    return kind === "tail" ? ang >= TAIL_ARC_MIN : ang <= BITE_CONE;
  }

  _knockback(victim, kind) {
    const vp = victim.position;
    let dx = vp.x - this.position.x;
    let dz = vp.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) {
      dx = Math.sin(this.heading);
      dz = Math.cos(this.heading);
    } else {
      dx /= d;
      dz /= d;
    }
    const m = this.mass;
    const vm = victim.mass ?? 80;
    const kb = clamp((3.2 * m) / (m + vm), 0.15, 3.2) * (kind === "tail" ? 1.5 : 1);
    if (victim instanceof Creature) {
      victim._kx += dx * kb;
      victim._kz += dz * kb;
      victim._restLock = Math.max(victim._restLock, REST_LOCK);
    } else {
      // Foreign actors (the Hunter) get a small direct shove; their own
      // update re-seats them on the ground and resolves collisions.
      vp.x += dx * kb * 0.12;
      vp.z += dz * kb * 0.12;
    }
  }

  /* --- Feeding ---------------------------------------------------------- */

  _feeding(dt) {
    const intent = this.intent;
    let eating = false;
    let drinking = false;
    const still = this.speed < 1 && !this.airborne && this._attackT < 0;
    // Start below 99.5 %, continue to 100 %: a full animal holding "drink" stops
    // instead of flickering in and out of the pose as metabolism ticks.
    if (intent.drink && still) {
      if (this.water < (this.drinking ? 100 : 99.5) && this.canDrink() === "fresh") {
        const gain = Math.min(100 - this.water, 10 * dt);
        this.water += gain;
        this._drinkAcc += gain;
        drinking = this.water < 100; // topped off → stop until it drops below 99.5
      }
    } else if (intent.eat && still && !this.swimming && this.food < (this.eating ? 100 : 99.5)) {
      const target = this._findFoodTarget();
      if (target) {
        const mass = this.mass;
        const fill = mass * 0.08; // kg that fill the stomach from 0 to 100 %
        const want = Math.min(Math.max(0.5, mass * 0.006) * dt, ((100 - this.food) / 100) * fill + 1e-4);
        const removed =
          this._foodKind === "carcass"
            ? this.world.ecosystem.eatCarcass(target, want)
            : this.world.vegetation.eatPlant(target, want);
        if (removed > 0) {
          this.food = Math.min(100, this.food + (removed / fill) * 100);
          this._eatAcc += removed;
          this._eatKind = this._foodKind === "carcass" ? "meat" : "plant";
          eating = this.food < 100;
        }
      }
    }
    this.eating = eating;
    this.drinking = drinking;

    // Throttled events (≤ 2/s): amount = kg eaten / % water drunk since the last one.
    const events = this.world.events;
    this._eatTimer -= dt;
    if (this._eatAcc > 0 && this._eatTimer <= 0) {
      events?.emit("eat", { creature: this, kind: this._eatKind, amount: this._eatAcc });
      this._eatAcc = 0;
      this._eatTimer = EVENT_INTERVAL;
    }
    this._drinkTimer -= dt;
    if (this._drinkAcc > 0 && this._drinkTimer <= 0) {
      events?.emit("drink", { creature: this, amount: this._drinkAcc });
      this._drinkAcc = 0;
      this._drinkTimer = EVENT_INTERVAL;
    }
  }

  /* --- Physiology ------------------------------------------------------- */

  _physiology(dt) {
    const t = this._t;
    const moving = this.speed > 0.2;

    // Metabolism (%/min → %/s).
    const mul =
      (this.isPlayer ? 1 : NPC_METABOLISM) *
      (this._sprinting && moving ? 2 : this.resting ? 0.5 : 1) *
      (this.swimming ? 1.25 : 1);
    this.food = Math.max(0, this.food - (t.hunger / 60) * mul * dt);
    this.water = Math.max(0, this.water - (t.thirst / 60) * mul * dt);

    // Stamina.
    let drain = 0;
    if (this._sprinting && moving) drain += t.sprintDrain;
    // Weak swimmers tire in water; the cost fades to nothing at GOOD_SWIMMER.
    if (this.swimming && t.swimAbility < GOOD_SWIMMER) {
      drain += 2.2 * (1 - t.swimAbility / GOOD_SWIMMER) * (moving ? 1 : 0.5);
    }
    if (drain > 0) {
      this.stamina = Math.max(0, this.stamina - drain * dt);
      this._staminaDelay = 0.6;
    } else if (this._staminaDelay > 0) {
      this._staminaDelay -= dt;
    } else if (this.stamina < 100) {
      let regen = t.regen * (this.resting ? 2 : 1);
      if (this.gait === "trot") regen *= 0.5;
      if (this.swimming) regen *= 0.5;
      this.stamina = Math.min(100, this.stamina + regen * dt);
    }

    // Damage over time.
    const maxH = this.maxHealth;
    if (this.food <= 0) this._dot("starve", maxH * 0.01 * dt);
    if (this.water <= 0) this._dot("dehydrate", maxH * 0.015 * dt);
    if (this.swimming && this.stamina <= 0) this._dot("drown", maxH * 0.05 * dt);
    if (this.bleeding > 0) {
      this._dot("bleed", this.bleeding * dt);
      // Exponential clotting plus a floor so small wounds close; resting helps.
      const k = this.resting ? 0.2 : 0.08;
      this.bleeding = Math.max(0, this.bleeding * Math.exp(-k * dt) - 0.02 * dt);
      if (this.bleeding < 0.01) this.bleeding = 0;
    }
    this._dotTimer -= dt;
    if (this._dotTimer <= 0) {
      this._dotTimer = DOT_EVENT_INTERVAL;
      this._flushDot();
    }
    if (!this.alive) return;

    // Regeneration when fed, watered and not bleeding.
    if (this.food > 30 && this.water > 30 && this.bleeding <= 0 && this.health < maxH) {
      this.health = Math.min(maxH, this.health + maxH * 0.004 * (this.resting ? 3 : 1) * dt);
    }

    // Broken leg heals with time (twice as fast lying down).
    if (this.legBroken > 0) {
      this.legBroken -= dt * (this.resting ? 2 : 1);
      if (this.legBroken <= 0) {
        this.legBroken = 0;
        if (this.isPlayer) this.world.events?.emit("notify", { text: "Your leg has healed", kind: "good" });
      }
    }

    // Growth (player only — NPCs keep the growth they spawned with).
    if (this.isPlayer && this.growth < 1 && this.food > 25 && this.water > 25) {
      const frac = maxH > 0 ? this.health / maxH : 1;
      this.growth = Math.min(1, this.growth + dt / t.growthSec);
      this.health = frac * this.maxHealth; // keep the health fraction
      const stage = growthStage(this.growth);
      if (stage !== this._stage) {
        this._stage = stage;
        this.world.events?.emit("grow", { creature: this, stage });
      }
    } else {
      this._stage = growthStage(this.growth);
    }
  }

  // Continuous damage: applied every frame, evented once a second.
  _dot(type, amount) {
    if (!this.alive || !(amount > 0)) return;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this._dotAcc[type] += dealt;
    if (this.health > 1e-6) return;
    this._flushDot();
    // Bleeding out after a fight credits the attacker (kills, [hunter] trophies).
    const recent = this.lastAttacker && this.age - this.lastDamageTime < 120;
    if (type === "bleed" && recent && this.lastAttacker.species) {
      const name = this.lastAttacker.species.name;
      const by = this.lastAttacker.isHunter ? "a hunter" : `${article(name)} ${name}`;
      this.die(`Bled out after ${by} attack`, this.lastAttacker);
    } else {
      this.die(CAUSES[type] || "Unknown causes", null);
    }
  }

  _flushDot() {
    const acc = this._dotAcc;
    for (const type in acc) {
      const amount = acc[type];
      if (amount <= 0) continue;
      acc[type] = 0;
      this.hurt = Math.max(this.hurt, 0.25); // a soft pulse, not a full hit flash
      this.world.events?.emit("damage", { target: this, source: null, amount, type });
    }
  }

  /* --- Stealth signals ([hunter]) --------------------------------------- */

  _stealth(dt) {
    let n = GAIT_NOISE[this.gait] ?? 0.25;
    if (this.crouching) n *= 0.4;
    n = Math.max(n, this._noiseSpike);
    this.noise = clamp(damp(this.noise, n, 6, dt), 0, 1);
    this.scent = 1;
    let v = 1;
    if (this.crouching) v *= 0.6;
    if (this.resting) v *= 0.75;
    if (this.swimming) v *= lerp(1, 0.7, this.submerged);
    this.visibility = v;
  }

  /* --- Animation -------------------------------------------------------- */

  _fillAnim() {
    const a = this._anim;
    let action = null;
    let actionT = 0;
    if (!this.alive) {
      action = "dead";
      actionT = Math.min(1, this._deadT / 1.2);
    } else if (this._attackT >= 0) {
      action = this._attackKind;
      actionT = this._attackT;
    } else if (this._callT >= 0) {
      action = "call";
      actionT = this._callT;
    } else if (this.eating) action = "eat";
    else if (this.drinking) action = "drink";
    else if (this.resting) action = "rest";
    a.speed = this.alive ? this._animSpeed : 0;
    a.crouch = this._crouchBlend;
    a.swim = this.submerged;
    a.turn = this.alive ? this.turnSpeed : 0;
    a.action = action;
    a.actionT = actionT;
    a.lookYaw = this.alive ? this.lookYaw : 0;
    a.hurt = this.hurt;
    return a;
  }

  _animate(dt) {
    // Head turn: toward a look target, the brain's target, or into the turn.
    let look = 0;
    const lt = this.lookTarget || (this.brain && this.brain.target);
    if (lt && lt !== this) {
      const lx = lt.position ? lt.position.x : lt.x;
      const lz = lt.position ? lt.position.z : lt.z;
      const dx = lx - this.position.x;
      const dz = lz - this.position.z;
      if (Number.isFinite(dx) && Number.isFinite(dz) && dx * dx + dz * dz < 3600 && dx * dx + dz * dz > 0.01) {
        look = angleDiff(this.heading, yawFromDir(dx, dz));
      }
    } else if (Math.abs(this.intent.moveX) + Math.abs(this.intent.moveZ) > 0.05) {
      look = angleDiff(this.heading, this._desiredYaw) * 0.7;
    }
    this.lookYaw = damp(this.lookYaw, clamp(look, -1, 1), 5, dt);
    this._syncModel();
    this._stepModel(dt);
  }

  _stepModel(dt) {
    if (!this.model) return;
    this._animAcc += dt;
    this._animTick++;
    if (this._animTick < Math.max(1, this.animLod | 0)) return;
    this.model.update(this._animAcc, this._fillAnim());
    this._animAcc = 0;
    this._animTick = 0;
  }

  _syncModel() {
    const m = this.model;
    if (!m || !m.object) return;
    const o = m.object;
    o.position.copy(this.position);
    o.rotation.set(this._pitch, this.heading, this._roll);
    const s = this.scale;
    if (s !== this._modelScale) {
      this._modelScale = s;
      m.setScale(s);
    }
  }

  // A dead body settles onto the ground (or floats) and plays its death pose.
  _updateDead(dt) {
    this._deadT += dt;
    this.speed = 0;
    this.velocity.set(0, 0, 0);
    this.turnSpeed = 0;
    this._attackT = -1;
    this._callT = -1;
    const pos = this.position;
    const t = this.world.terrain;
    const hip = Math.max(0.05, this.species.height * this.scale);
    const ground = this._groundHeight(pos.x, pos.z, hip);
    const depth = t ? t.waterDepthAt(pos.x, pos.z) : 0;
    this.submerged = clamp((depth - 0.3 * hip) / (0.5 * hip), 0, 1);
    const floatY = (t?.seaLevel ?? 0) - 0.35 * hip;
    const targetY = depth > 0.6 * hip ? Math.max(ground, floatY) : ground;
    pos.y = damp(pos.y, targetY, 5, dt);
    this._orient(dt, false);
    this._syncModel();
    this._stepModel(dt);
  }

  /* --- Health ----------------------------------------------------------- */

  /**
   * Apply damage. Attack types ("bite" | "tail" | "kick") are reduced by the
   * species' armor, [hunter] "shot" by half the armor, everything else
   * ("starve", "dehydrate", "drown", "bleed", "fall") ignores it.
   * Emits "damage"; kills at 0 HP.
   * @returns {number} damage actually dealt
   */
  takeDamage(amount, source = null, type = "bite") {
    if (!this.alive || !(amount > 0)) return 0;
    const armor = this._t.armor;
    const mul = ATTACK_TYPES[type] ? 1 - armor : type === "shot" ? 1 - armor * 0.5 : 1;
    const dealt = Math.min(this.health, amount * mul);
    this.health -= dealt;
    const maxH = this.maxHealth;
    this.hurt = Math.max(this.hurt, clamp(0.35 + dealt / (maxH * 0.25), 0.35, 1));
    this.lastDamageTime = this.age;
    if (source && source !== this) this.lastAttacker = source;
    if (ATTACK_TYPES[type] || type === "shot") this._restLock = Math.max(this._restLock, REST_LOCK);
    this.world.events?.emit("damage", { target: this, source, amount: dealt, type });
    if (this.health <= 1e-6) {
      const killer = source && source !== this ? source : null;
      this.die(this._causeFor(type, killer), killer);
    }
    return dealt;
  }

  _causeFor(type, killer) {
    if (killer && (killer.isHunter || type === "shot")) return "Shot by a hunter";
    if (killer && killer.species && killer.species.name) {
      return `Killed by ${article(killer.species.name)} ${killer.species.name}`;
    }
    return CAUSES[type] || "Unknown causes";
  }

  /** Restore HP (clamped to maxHealth). */
  heal(amount) {
    if (!this.alive || !(amount > 0)) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Kill the creature: alive = false, death pose, emits "death". The killer
   * (any actor with a numeric `kills`, including the Hunter) is credited.
   * @param {string} cause human-readable cause, e.g. "Starvation", "Killed by an Allosaurus"
   * @param {object|null} killer
   */
  die(cause = "Unknown causes", killer = null) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.causeOfDeath = cause;
    this.eating = this.drinking = this.resting = this.crouching = false;
    this._sprinting = false;
    this.bleeding = 0;
    this.speed = 0;
    this.gait = "idle";
    this._attackT = -1;
    this._callT = -1;
    this._deadT = 0;
    this.noise = 0;
    const it = this.intent;
    it.moveX = it.moveZ = 0;
    it.sprint = it.crouch = it.bite = it.eat = it.drink = it.call = it.rest = false;
    if (killer && killer !== this && typeof killer.kills === "number") killer.kills++;
    this.world.events?.emit("death", { creature: this, cause, killer });
  }

  /** Release the model (unless the ecosystem handed it to a carcass). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.brain = null;
    this.lookTarget = null;
    this.group = null;
    if (this.model && !this._carcass) {
      const o = this.model.object;
      if (o && o.parent) o.parent.remove(o);
      this.model.dispose();
    }
  }
}
