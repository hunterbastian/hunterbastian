// Hunter mode, first person: the HUMAN pseudo-species, the Hunter actor (a
// creature-compatible body the AI, ecosystem, HUD and audio treat like any
// other animal) and the HunterController that turns mouse / keys / touch into
// a weighty, grounded first-person view.
//
// Division of labour:
//   Hunter            physics + vitals + stealth signals. Moved by its own
//                     update(dt), which the ecosystem calls like any creature's
//                     (the controller calls it itself when no ecosystem manages it).
//   HunterController  look, intent, weapons, zoom and every purely cosmetic
//                     camera motion (bob, breathing, lean, dips, shake, death slump).
//                     Cosmetic offsets never feed back into hunter.heading / pitch,
//                     so aim and stealth math stay clean.

import * as THREE from "three";
import { WORLD } from "../config.js";
import { clamp, lerp, damp, smoothstep, wrapAngle, TAU } from "../core/math.js";
import { allocateActorId } from "../creatures/creature.js";

/* --- HUMAN pseudo-species ------------------------------------------------ */

/**
 * The hunter as a SpeciesDef, so code that reads `actor.species.*` (AI threat
 * maths, audio footsteps, HUD labels) works unchanged. Adult values; growth is
 * always 1. Model-only fields (colors/body) are empty: the hunter has no body mesh.
 */
export const HUMAN = {
  id: "human",
  name: "Hunter",
  diet: "human",
  playable: false,
  tagline: "Two legs, one rifle, a long way from the chopper.",
  description: "A lone hunter on foot. Quiet when crouched, loud when running, edible always.",
  era: "Present day",
  length: 0.6,
  height: 1.0,
  mass: 85,
  health: 100,
  bite: 0,
  biteCooldown: 1,
  biteRange: 0,
  attack: "none",
  armor: 0,
  bleed: 0,
  speed: { walk: 1.6, trot: 3.4, sprint: 6.2, crouch: 1.1, swim: 1.2 },
  turnRate: 10,
  stamina: { regen: 9, sprintDrain: 11 },
  metabolism: { hunger: 0, thirst: 0 },
  growthMinutes: 1,
  juvenileScale: 1,
  swim: 0.3,
  social: "solo",
  groupSize: [1, 1],
  aggression: 0,
  perception: 0,
  spawnWeight: 0,
  biomes: [],
  call: { kind: "hoot", pitch: 300, duration: 0.5 },
  colors: {},
  body: {},
  radius: 0.35, // collision circle (m); Creature.radius honours species.radius too
};

/* --- Tuning ---------------------------------------------------------------- */

const GRAVITY = 9.81;
const RADIUS = HUMAN.radius;

/** Eye heights above the feet (m). */
export const EYE_STAND = 1.65;
export const EYE_CROUCH = 1.0;
const EYE_DEAD = 0.28;
const SWIM_EYE_ABOVE = 0.18; // eye height above the water surface while swimming

// Water: deeper than ~chest height and you swim; hysteresis stops flicker at the edge.
const SWIM_ENTER = 1.38;
const SWIM_EXIT = 1.15;
const WADE_FULL = 1.2; // depth at which wading is at its slowest

// Slopes are measured as directional grade (rise / run along the step).
const SLOW_GRADE = 0.15; // uphill starts to slow you here …
const BLOCK_GRADE = 0.9; // … and above ~42° you can't climb (you slide along the contour)
const STICK_GRADE = 1.6; // steeper drops than this per metre moved become a fall
const SLIDE_SLOPE = 0.34; // terrain.slopeAt above this (≈49°) can't be stood on
const FALL_SAFE = 6; // m of drop before it hurts
const FALL_BREAK = 9.5; // … and before it breaks a leg
const LEG_HEAL_TIME = 45;

// Stamina (%/s). Sprint drain and regen come from HUMAN.stamina.
const SWIM_DRAIN_IDLE = 1.0;
const SWIM_DRAIN_MOVE = 2.2;
const SWIM_DRAIN_SPRINT = 4.5;
const REGEN_DELAY = 0.8; // s after exertion before stamina starts coming back
const WIND_RECOVER = 25; // after emptying stamina, sprinting is locked until this

// Health.
const DROWN_DPS = 7;
const REGEN_HPS = 0.5;
const REGEN_AFTER = 8; // s since the last hit before health regenerates
const DOT_EVENT_INTERVAL = 1; // bleed / drown "damage" events once a second

// Stealth (see ARCHITECTURE "Senses"). Noise is interpolated by actual speed.
const NOISE_IDLE = 0.03;
const NOISE_CROUCH = 0.12;
const NOISE_WALK = 0.35;
const NOISE_JOG = 0.6;
const NOISE_SPRINT = 1;
const NOISE_SWIM = 0.5;
const SPLASH_MUL = 1.2;
const VIS_CROUCH = 0.55;
const VIS_CAMO = 0.6;
const VIS_FOREST = 0.75;
const VIS_NIGHT = 0.45;
const SCENT_COVER = 0.35;
const SCENT_SPRINT = 1.3;
const SCENT_BLEED = 1.5;
const ENV_INTERVAL = 0.25; // s between biome / canopy samples

const ATTACK_TYPES = { bite: true, tail: true, kick: true };
const CAUSES = {
  bleed: "Blood loss",
  drown: "Drowned",
  fall: "A fatal fall",
  shot: "Shot",
  bite: "Mauled",
  tail: "Crushed",
  kick: "Trampled",
};

const article = (name) => (/^[aeiou]/i.test(name) ? "an" : "a");

/* --- Scratch (no allocations in hot paths) --------------------------------- */

const _near = [];
const _cols = [];
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/* --- Hunter actor ------------------------------------------------------------ */

export class Hunter {
  /**
   * @param {object} world  World (terrain, vegetation, ecosystem, events, sky — all optional)
   * @param {{ x?: number, z?: number, heading?: number,
   *           equipment?: { camo?: boolean, coverScent?: boolean, radar?: boolean, lure?: boolean } }} opts
   */
  constructor(world, { x = 0, z = 0, heading = 0, equipment = {} } = {}) {
    this.id = allocateActorId();
    this.world = world || {};
    this.species = HUMAN;
    this.isHunter = true;
    this.isPlayer = true;
    this.alive = true;
    this.brain = null;
    this.model = null;
    this.group = null;
    this.lookTarget = null;

    /* Creature-compatible state */
    this.growth = 1;
    this.health = HUMAN.health;
    this.food = 100;
    this.water = 100;
    this.stamina = 100;
    this.bleeding = 0; // hp/s
    this.legBroken = 0; // s left
    this.resting = false;
    this.crouching = false;
    this.swimming = false;
    this.eating = false;
    this.drinking = false;
    this.submerged = 0; // 0..1, like Creature (AI / audio)
    this.position = new THREE.Vector3(x, 0, z);
    this.velocity = new THREE.Vector3();
    this.heading = heading;
    this.speed = 0; // planar m/s
    this.gait = "idle";
    this.age = 0;
    this.kills = 0;
    this.lastAttacker = null;
    this.lastDamageTime = -Infinity;
    this.causeOfDeath = null;
    this.biteCooldown = 0;
    this.hurt = 0;
    this.intent = { moveX: 0, moveZ: 0, sprint: false, crouch: false, bite: false, eat: false, drink: false, call: false, rest: false };

    /** Look pitch in radians (+ up). Written by the controller. */
    this.pitch = 0;
    /** Hunt equipment toggles (affect scent / visibility). */
    this.equipment = {
      camo: !!equipment.camo,
      coverScent: !!equipment.coverScent,
      radar: !!equipment.radar,
      lure: !!equipment.lure,
    };

    /* Stealth signals (AI senses read these every perception tick) */
    this.scent = 1;
    this.noise = NOISE_IDLE;
    this.visibility = 1;

    /* Extras for the controller / HUD / audio */
    this.crouchAmount = 0; // smoothed 0..1 (eye height blends with it)
    this.wading = 0; // 0..1 how deep you're wading (1 = swimming)
    this.airborne = false;
    this.sprinting = false;
    this.winded = false; // emptied stamina; sprint locked until it recovers a little
    this.landCount = 0; // increments on every landing (controller dips the camera)
    this.landSpeed = 0; // m/s vertical speed of the last landing
    this.biome = null; // sampled ~4×/s
    this.cover = 0; // canopy cover 0..1 (vegetation.coverAt when available)

    const t = this.world.terrain;
    this.position.y = t ? t.heightAt(x, z) : 0;
    this._vy = 0;
    this._fallStartY = this.position.y;
    this._feetY = this.position.y; // smoothed feet height for the eye
    this._feetVel = 0;
    this._prevGround = this.position.y;
    this._lastX = x;
    this._lastY = this.position.y;
    this._lastZ = z;
    this._snap = true;
    this._regenDelay = 0;
    this._noiseSpike = 0;
    this._envT = 0;
    this._dotAcc = { bleed: 0, drown: 0 };
    this._dotT = 0;
    this._deadT = 0;
    this._warnedDrown = false;
    this._disposed = false;
  }

  /* --- Getters (Creature contract) ------------------------------------------ */

  get scale() {
    return 1;
  }
  get mass() {
    return HUMAN.mass;
  }
  get maxHealth() {
    return HUMAN.health;
  }
  get radius() {
    return RADIUS;
  }
  get stage() {
    return "adult";
  }
  get diet() {
    return HUMAN.diet;
  }
  get hipHeight() {
    return HUMAN.height;
  }
  // Plain coordinate accessors so AI can treat actors, carcasses and points alike.
  get x() {
    return this.position.x;
  }
  get y() {
    return this.position.y;
  }
  get z() {
    return this.position.z;
  }

  /* --- Geometry helpers ------------------------------------------------------- */

  /**
   * World-space eye position: smoothed over terrain kinks and steps, blended
   * between standing and crouched height, at the surface when swimming, and
   * slumping to the ground on death.
   * @param {THREE.Vector3} [target]
   */
  eyePosition(target = new THREE.Vector3()) {
    return target.set(this.position.x, this._eyeY(), this.position.z);
  }

  /** Mouth position for reach checks — for a hunter that's simply the eye. */
  headPosition(target = new THREE.Vector3()) {
    return this.eyePosition(target);
  }

  /** Horizontal unit facing vector (heading convention). */
  forward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Unit look vector including pitch (where the eyes — and gun — point). */
  lookDirection(target = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return target.set(Math.sin(this.heading) * cp, Math.sin(this.pitch), Math.cos(this.heading) * cp);
  }

  _eyeY() {
    const sea = this._sea();
    if (!this.alive) {
      // Knees give out, then you hit the ground (ease-in like a fall).
      const k = smoothstep(0, 1, this._deadT / 0.95);
      const base = this.swimming ? sea - 0.05 : this._feetY;
      const from = this.swimming ? sea + SWIM_EYE_ABOVE : this._feetY + lerp(EYE_STAND, EYE_CROUCH, this.crouchAmount);
      return lerp(from, base + (this.swimming ? 0 : EYE_DEAD), k * k);
    }
    if (this.swimming) return Math.max(this._feetY + EYE_STAND, sea + 0.1);
    const y = this._feetY + lerp(EYE_STAND, EYE_CROUCH, this.crouchAmount);
    // Wading deep while crouched would put the eye under water: hold it just above.
    return this.wading > 0 ? Math.max(y, Math.min(sea + 0.14, this._feetY + EYE_STAND)) : y;
  }

  _sea() {
    const t = this.world.terrain;
    return t && Number.isFinite(t.seaLevel) ? t.seaLevel : WORLD.seaLevel;
  }

  _ground(x, z) {
    const t = this.world.terrain;
    return t ? t.heightAt(x, z) : 0;
  }

  /* --- Simulation -------------------------------------------------------------- */

  /**
   * Full step: movement (accel, slopes, wading/swimming, falls, collisions,
   * bounds), stamina, bleeding, regen, drowning and the stealth signals.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!(dt > 0) || this._disposed) return;
    dt = Math.min(dt, 0.1);
    this.age += dt;
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    this.biteCooldown = 0;
    this._detectTeleport();

    if (!this.alive) {
      this._deadT += dt;
      this._settleDead(dt);
      this._remember();
      return;
    }

    this._move(dt);
    this._vitals(dt);
    this._stealth(dt);
    this._dotT += dt;
    if (this._dotT >= DOT_EVENT_INTERVAL) {
      this._dotT = 0;
      this._flushDot();
    }
    this._remember();
  }

  _remember() {
    this._lastX = this.position.x;
    this._lastY = this.position.y;
    this._lastZ = this.position.z;
  }

  // Someone else moved us (the hunt placing us at the landing zone, a dino
  // knockback). Small shoves stay physical; big jumps re-seat all smoothing.
  _detectTeleport() {
    const p = this.position;
    const dx = p.x - this._lastX;
    const dz = p.z - this._lastZ;
    const dy = p.y - this._lastY;
    if (this._snap || dx * dx + dz * dz > 9 || Math.abs(dy) > 4) {
      this._snap = false;
      const g = this._ground(p.x, p.z);
      const sea = this._sea();
      this.swimming = sea - g > SWIM_ENTER;
      p.y = this.swimming ? sea - (EYE_STAND - SWIM_EYE_ABOVE) : g;
      this.airborne = false;
      this._vy = 0;
      this._fallStartY = p.y;
      this._feetY = p.y;
      this._feetVel = 0;
      this._prevGround = p.y;
      this._envT = 0;
    }
  }

  _move(dt) {
    const p = this.position;
    const v = this.velocity;
    const it = this.intent;
    const sp = HUMAN.speed;
    const sea = this._sea();

    let mx = Number.isFinite(it.moveX) ? it.moveX : 0;
    let mz = Number.isFinite(it.moveZ) ? it.moveZ : 0;
    let mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
      mag = 1;
    }
    const dirX = mag > 1e-4 ? mx / mag : 0;
    const dirZ = mag > 1e-4 ? mz / mag : 0;

    const ground = this._ground(p.x, p.z);
    const depth = Math.max(0, sea - ground);
    if (!this.airborne) {
      if (!this.swimming && depth > SWIM_ENTER) this.swimming = true;
      else if (this.swimming && depth < SWIM_EXIT) this.swimming = false;
    }
    this.wading = this.swimming ? 1 : smoothstep(0.12, WADE_FULL, depth);

    const crouch = !!it.crouch && !this.swimming;
    this.crouching = crouch;
    this.crouchAmount = damp(this.crouchAmount, crouch ? 1 : 0, 7, dt);

    // Sprint needs stamina; emptying it locks sprint until you've caught your breath.
    if (this.stamina <= 0.01) this.winded = true;
    else if (this.winded && this.stamina >= WIND_RECOVER) this.winded = false;
    const sprint = !!it.sprint && mag > 0.1 && !crouch && this.legBroken <= 0 && !this.winded && !this.airborne;
    this.sprinting = sprint;

    // Target speed: ≤ 0.5 stick = walk, beyond blends to a jog; sprint flag sprints.
    let target = 0;
    if (mag >= 0.02) {
      if (this.swimming) target = sp.swim * mag * (sprint ? 1.35 : 1);
      else if (sprint) target = sp.sprint;
      else if (crouch) target = sp.crouch * Math.min(1, mag / 0.5);
      else if (mag <= 0.5) target = sp.walk * (mag / 0.5);
      else target = lerp(sp.walk, sp.trot, (mag - 0.5) / 0.5);
    }
    if (!this.swimming && target > 0) {
      target *= lerp(1, 0.42, this.wading);
      if (this.legBroken > 0) target *= 0.55;
      // Uphill costs speed, a steep descent makes you careful.
      const ahead = this._ground(p.x + dirX * 0.6, p.z + dirZ * 0.6);
      const grade = (ahead - ground) / 0.6;
      if (grade > SLOW_GRADE) target *= lerp(1, 0.5, smoothstep(SLOW_GRADE, BLOCK_GRADE, grade));
      else if (grade < -0.55) target *= lerp(1, 0.8, smoothstep(0.55, 1.2, -grade));
    }

    // Weighty-but-responsive: quick to start and stop, slower to wind up a sprint,
    // little air control, sluggish in water.
    let lambda;
    const cur = this.speed;
    if (this.airborne) lambda = 0.6;
    else if (this.swimming) lambda = 2.2;
    else if (target > cur) lambda = target > sp.trot + 0.1 && cur > sp.walk ? 3.2 : 7.5;
    else lambda = 9.5;
    if (!this.swimming && this.wading > 0) lambda *= lerp(1, 0.55, this.wading);
    v.x = damp(v.x, dirX * target, lambda, dt);
    v.z = damp(v.z, dirZ * target, lambda, dt);

    // Standing on a face too steep to hold: slide down it.
    const t = this.world.terrain;
    if (t && !this.swimming && !this.airborne && typeof t.slopeAt === "function" && t.slopeAt(p.x, p.z) > SLIDE_SLOPE) {
      this._gradient(p.x, p.z);
      v.x -= _grad.x * 2.4 * dt * 3;
      v.z -= _grad.z * 2.4 * dt * 3;
    }

    let nx = p.x + v.x * dt;
    let nz = p.z + v.z * dt;

    // Slope limit: too steep uphill → slide along the contour instead.
    if (!this.swimming && !this.airborne) {
      const step = Math.hypot(nx - p.x, nz - p.z);
      if (step > 1e-5) {
        const rise = this._ground(nx, nz) - ground;
        if (rise / step > BLOCK_GRADE) {
          this._gradient(p.x, p.z);
          const along = v.x * _grad.x + v.z * _grad.z;
          if (along > 0) {
            v.x -= _grad.x * along;
            v.z -= _grad.z * along;
          }
          nx = p.x + v.x * dt;
          nz = p.z + v.z * dt;
          const s2 = Math.hypot(nx - p.x, nz - p.z);
          if (s2 > 1e-5 && (this._ground(nx, nz) - ground) / s2 > BLOCK_GRADE) {
            nx = p.x;
            nz = p.z;
            v.x *= 0.2;
            v.z *= 0.2;
          }
        }
      }
    }

    p.x = nx;
    p.z = nz;
    this._collide();
    this._bounds();

    this.speed = Math.hypot(v.x, v.z);
    this._vertical(dt, ground);

    // Gait for audio / AI / HUD.
    if (this.swimming) this.gait = "swim";
    else if (this.speed < 0.25) this.gait = "idle";
    else if (sprint && this.speed > sp.trot + 0.3) this.gait = "sprint";
    else if (this.speed > (sp.walk + sp.trot) * 0.5) this.gait = "trot";
    else this.gait = "walk";
    this.submerged = this.swimming ? 0.85 : this.wading * 0.6;
  }

  // Uphill unit gradient of the terrain at (x, z) into _grad (x, z); zero on flats.
  _gradient(x, z) {
    const e = 0.5;
    const gx = (this._ground(x + e, z) - this._ground(x - e, z)) / (2 * e);
    const gz = (this._ground(x, z + e) - this._ground(x, z - e)) / (2 * e);
    const len = Math.hypot(gx, gz);
    if (len < 1e-6) _grad.set(0, 0, 0);
    else _grad.set(gx / len, 0, gz / len);
    return _grad;
  }

  // Circle collisions: tree trunks / boulders, then other bodies (heavier ones
  // shove you; a moving dinosaur carries you along a little).
  _collide() {
    const p = this.position;
    const v = this.velocity;
    const veg = this.world.vegetation;
    if (veg && typeof veg.collidersNear === "function") {
      const list = veg.collidersNear(p.x, p.z, RADIUS + 0.2, _cols);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const min = RADIUS + (c.r || 0);
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-4;
        const nx = d2 > 1e-8 ? dx / d : 1;
        const nz = d2 > 1e-8 ? dz / d : 0;
        p.x = c.x + nx * min;
        p.z = c.z + nz * min;
        const into = v.x * nx + v.z * nz;
        if (into < 0) {
          v.x -= nx * into;
          v.z -= nz * into;
        }
      }
    }

    const eco = this.world.ecosystem;
    if (eco && typeof eco.query === "function") {
      const reach = RADIUS + (Number.isFinite(eco.maxRadius) ? eco.maxRadius : 4);
      const list = eco.query(p.x, p.z, reach, null, _near);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === this || !o || o.alive === false || !o.position) continue;
        const or = Number.isFinite(o.radius) ? o.radius : 0.5;
        const min = RADIUS + or;
        const dx = p.x - o.position.x;
        const dz = p.z - o.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const om = Number.isFinite(o.mass) ? o.mass : 80;
        const share = om / (HUMAN.mass + om); // the lighter body yields more
        let nx = 1;
        let nz = 0;
        let d = 0;
        if (d2 > 1e-8) {
          d = Math.sqrt(d2);
          nx = dx / d;
          nz = dz / d;
        } else {
          const a = (this.id * 2.39996) % TAU;
          nx = Math.sin(a);
          nz = Math.cos(a);
        }
        const push = (min - d) * share;
        p.x += nx * push;
        p.z += nz * push;
        const into = v.x * nx + v.z * nz;
        if (into < 0) {
          v.x -= nx * into * share;
          v.z -= nz * into * share;
        }
        // A walking 2-tonne animal doesn't stop for you: its motion carries you.
        const ov = o.velocity;
        if (ov) {
          const carry = ov.x * nx + ov.z * nz;
          if (carry > 0) {
            v.x += nx * carry * share * 0.6;
            v.z += nz * carry * share * 0.6;
          }
        }
      }
    }
  }

  _bounds() {
    const t = this.world.terrain;
    const half = t ? (Number.isFinite(t.half) ? t.half : (t.size || WORLD.size) / 2) : WORLD.size / 2;
    const lim = half - 4;
    const p = this.position;
    const v = this.velocity;
    if (p.x > lim || p.x < -lim) {
      p.x = clamp(p.x, -lim, lim);
      v.x = 0;
    }
    if (p.z > lim || p.z < -lim) {
      p.z = clamp(p.z, -lim, lim);
      v.z = 0;
    }
  }

  // Ground contact, falls (with damage), floating; then the eye's smoothed feet.
  _vertical(dt, prevGround) {
    const p = this.position;
    const sea = this._sea();
    const g = this._ground(p.x, p.z);
    const swimY = sea - (EYE_STAND - SWIM_EYE_ABOVE);

    if (this.airborne) {
      this._vy -= GRAVITY * dt;
      p.y += this._vy * dt;
      const depth = sea - g;
      if (depth > SWIM_ENTER && p.y <= swimY) {
        // Splash down: water breaks the fall.
        this._land(-this._vy, 0, true);
        this.swimming = true;
        p.y = swimY;
      } else if (p.y <= g) {
        const drop = this._fallStartY - g;
        p.y = g;
        this._land(-this._vy, drop, false);
      }
    } else if (this.swimming) {
      p.y = damp(p.y, Math.max(g, swimY), 5, dt);
      this._vy = 0;
    } else {
      const moved = Math.hypot(p.x - this._lastX, p.z - this._lastZ);
      const drop = p.y - g;
      if (drop > 0.3 && drop > moved * STICK_GRADE + 0.04) {
        // Walked off an edge: keep the vertical speed we had while following the ground.
        this.airborne = true;
        this._fallStartY = p.y;
        this._vy = Math.min(0, (g - prevGround) / dt, this._feetVel);
        this._vy = Math.max(this._vy, -4);
        p.y += this._vy * dt;
      } else {
        p.y = g;
      }
    }
    this.velocity.y = this.airborne ? this._vy : 0;

    // Eye smoothing: a spatially averaged ground (kills cell-edge kinks) tracked
    // with a velocity feed-forward (no lag on long slopes) plus a soft spring
    // (soaks up steps and knockback). Falls and swimming follow the body directly.
    if (this.airborne) {
      this._feetY = p.y;
      this._feetVel = this._vy;
      this._prevGround = p.y;
    } else if (this.swimming) {
      this._feetVel = damp(this._feetVel, 0, 6, dt);
      this._feetY = damp(this._feetY, p.y, 6, dt);
      this._prevGround = p.y;
    } else {
      const r = 0.32;
      const avg =
        g * 0.4 +
        (this._ground(p.x + r, p.z) + this._ground(p.x - r, p.z) + this._ground(p.x, p.z + r) + this._ground(p.x, p.z - r)) * 0.15;
      const tv = clamp((avg - this._prevGround) / dt, -12, 12);
      this._prevGround = avg;
      this._feetVel = damp(this._feetVel, tv, 11, dt);
      this._feetY += this._feetVel * dt;
      this._feetY = damp(this._feetY, avg, 9, dt);
      if (Math.abs(this._feetY - avg) > 1.2) this._feetY = avg + Math.sign(this._feetY - avg) * 1.2;
    }
  }

  _land(impact, drop, water) {
    this.airborne = false;
    this._vy = 0;
    this.landSpeed = Math.max(0, impact);
    this.landCount++;
    this._noiseSpike = Math.max(this._noiseSpike, clamp(impact / 8, 0.25, 1) * (water ? 1.2 : 1));
    if (water || drop <= FALL_SAFE) return;
    const over = drop - FALL_SAFE;
    this.takeDamage(10 + over * 12, null, "fall");
    if (this.alive && drop > FALL_BREAK && this.legBroken <= 0) {
      this.legBroken = LEG_HEAL_TIME + over * 3;
      this.world.events?.emit("legBreak", { creature: this });
    }
  }

  _vitals(dt) {
    const sta = HUMAN.stamina;
    const moving = this.speed > 0.3;
    if (this.swimming) {
      const drain = this.sprinting ? SWIM_DRAIN_SPRINT : moving ? SWIM_DRAIN_MOVE : SWIM_DRAIN_IDLE;
      this.stamina -= drain * dt;
      this._regenDelay = REGEN_DELAY;
    } else if (this.sprinting && moving) {
      this.stamina -= sta.sprintDrain * dt;
      this._regenDelay = REGEN_DELAY;
    } else {
      this._regenDelay -= dt;
      if (this._regenDelay <= 0) {
        let rate = sta.regen * (moving ? 0.75 : 1.15);
        rate *= lerp(1, 0.6, this.wading);
        if (this.legBroken > 0) rate *= 0.7;
        this.stamina += rate * dt;
      }
    }
    this.stamina = clamp(this.stamina, 0, 100);

    // Drowning only once you're completely spent.
    if (this.swimming && this.stamina <= 0) {
      if (!this._warnedDrown) {
        this._warnedDrown = true;
        this.world.events?.emit("notify", { text: "You're exhausted — get to shore!", kind: "danger" });
      }
      this._dot("drown", DROWN_DPS * dt);
    } else if (!this.swimming) this._warnedDrown = false;
    if (!this.alive) return;

    // Bleeding slows on its own, faster when you keep still and low.
    if (this.bleeding > 0) {
      this._dot("bleed", this.bleeding * dt);
      const still = !moving || this.crouching;
      this.bleeding = Math.max(0, this.bleeding - dt * (0.05 + this.bleeding * 0.07) * (still ? 1.6 : 1));
      if (this.bleeding < 0.02) this.bleeding = 0;
    } else if (this.age - this.lastDamageTime > REGEN_AFTER && this.health < HUMAN.health) {
      this.health = Math.min(HUMAN.health, this.health + REGEN_HPS * dt);
    }
    if (!this.alive) return;

    if (this.legBroken > 0) {
      this.legBroken = Math.max(0, this.legBroken - dt);
      if (this.legBroken === 0) this.world.events?.emit("notify", { text: "Your leg feels steadier.", kind: "good" });
    }
  }

  _stealth(dt) {
    const sp = HUMAN.speed;
    const s = this.speed;

    // Noise from how fast you're actually moving (blocked by a tree = quiet).
    let n;
    if (this.swimming) n = NOISE_SWIM * (s > 0.3 ? SPLASH_MUL : 1);
    else if (s < 0.25) n = NOISE_IDLE;
    else if (this.crouching) n = lerp(NOISE_IDLE, NOISE_CROUCH, smoothstep(0.25, sp.crouch, s));
    else if (s <= sp.walk) n = lerp(NOISE_IDLE, NOISE_WALK, smoothstep(0.25, sp.walk, s));
    else if (s <= sp.trot) n = lerp(NOISE_WALK, NOISE_JOG, (s - sp.walk) / (sp.trot - sp.walk));
    else n = lerp(NOISE_JOG, NOISE_SPRINT, clamp((s - sp.trot) / (sp.sprint - sp.trot), 0, 1));
    if (!this.swimming && this.wading > 0.05 && s > 0.3) n *= lerp(1, SPLASH_MUL, smoothstep(0.05, 0.4, this.wading));
    this._noiseSpike = Math.max(0, this._noiseSpike - dt * 0.8);
    n = Math.max(n, this._noiseSpike);
    this.noise = clamp(damp(this.noise, n, 6, dt), 0, 1);

    // Scent: cover scent masks it; exertion and blood make it worse. 1 = a plain human.
    let sc = this.equipment.coverScent ? SCENT_COVER : 1;
    if (this.sprinting && s > sp.trot) sc *= SCENT_SPRINT;
    if (this.bleeding > 0) sc *= SCENT_BLEED;
    this.scent = clamp(damp(this.scent, sc, 1.5, dt), 0, 2);

    // Environment is sampled a few times a second (biome lookups aren't free).
    this._envT -= dt;
    if (this._envT <= 0) {
      this._envT = ENV_INTERVAL;
      const t = this.world.terrain;
      const p = this.position;
      this.biome = t && typeof t.biomeAt === "function" ? t.biomeAt(p.x, p.z) : null;
      const veg = this.world.vegetation;
      this.cover = veg && typeof veg.coverAt === "function" ? clamp(veg.coverAt(p.x, p.z, 8) || 0, 0, 1) : 0;
    }

    let vis = lerp(1, VIS_CROUCH, this.crouchAmount);
    if (this.equipment.camo) vis *= VIS_CAMO;
    // Forest biome, or a stand of trees anywhere, breaks up your outline.
    const forest = Math.min(this.biome === "forest" ? VIS_FOREST : 1, lerp(1, VIS_FOREST, this.cover));
    vis *= forest;
    if (this.swimming) vis *= 0.5; // just a head in the water
    const daylight = this.world.sky && Number.isFinite(this.world.sky.daylight) ? this.world.sky.daylight : 1;
    vis *= lerp(VIS_NIGHT, 1, clamp(daylight, 0, 1));
    this.visibility = clamp(damp(this.visibility, vis, 4, dt), 0, 1);
  }

  _settleDead(dt) {
    const p = this.position;
    const v = this.velocity;
    v.x = damp(v.x, 0, 4, dt);
    v.z = damp(v.z, 0, 4, dt);
    p.x += v.x * dt;
    p.z += v.z * dt;
    this.speed = Math.hypot(v.x, v.z);
    const g = this._ground(p.x, p.z);
    const sea = this._sea();
    if (this.swimming) p.y = damp(p.y, Math.max(g, sea - 0.9), 1.5, dt);
    else {
      p.y = this.airborne ? Math.max(g, p.y + (this._vy -= GRAVITY * dt) * dt) : g;
      if (p.y <= g) this.airborne = false;
      this._feetY = damp(this._feetY, p.y, 10, dt);
    }
    this.noise = damp(this.noise, 0, 4, dt);
  }

  /* --- Health ------------------------------------------------------------------ */

  /**
   * Apply damage (armor 0 — a jacket stops nothing). Emits "damage"; kills at 0 HP.
   * @param {number} amount HP
   * @param {object|null} source attacking actor
   * @param {string} type "bite" | "tail" | "kick" | "shot" | "fall" | "drown" | "bleed" | …
   * @returns {number} damage actually dealt
   */
  takeDamage(amount, source = null, type = "bite") {
    if (!this.alive || !(amount > 0)) return 0;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this.hurt = Math.max(this.hurt, clamp(0.35 + dealt / 25, 0.35, 1));
    this.lastDamageTime = this.age;
    if (source && source !== this) this.lastAttacker = source;
    if (ATTACK_TYPES[type]) this._noiseSpike = Math.max(this._noiseSpike, 0.7); // you yell
    this.world.events?.emit("damage", { target: this, source, amount: dealt, type });
    if (this.health <= 1e-6) {
      const killer = source && source !== this ? source : null;
      this.die(this._causeFor(type, killer), killer);
    }
    return dealt;
  }

  /** Restore HP (clamped to maxHealth). */
  heal(amount) {
    if (!this.alive || !(amount > 0)) return;
    this.health = Math.min(HUMAN.health, this.health + amount);
  }

  /**
   * Kill the hunter: alive = false, emits "death". The killer (any actor with a
   * numeric `kills`) is credited. The camera slump is the controller's job.
   * @param {string} cause human-readable cause
   * @param {object|null} killer
   */
  die(cause = "Unknown causes", killer = null) {
    if (!this.alive) return;
    this._flushDot();
    this.alive = false;
    this.health = 0;
    this.causeOfDeath = cause;
    this.crouching = this.sprinting = false;
    this.bleeding = 0;
    this.gait = "idle";
    this._deadT = 0;
    const it = this.intent;
    it.moveX = it.moveZ = 0;
    it.sprint = it.crouch = it.bite = it.eat = it.drink = it.call = it.rest = false;
    if (killer && killer !== this && typeof killer.kills === "number") killer.kills++;
    this.world.events?.emit("death", { creature: this, cause, killer });
  }

  /** Drop references (the hunter owns no meshes). */
  dispose() {
    this._disposed = true;
    this.lastAttacker = null;
    this.lookTarget = null;
    this.group = null;
  }

  _causeFor(type, killer) {
    const name = killer && killer.species && killer.species.name;
    if (name && !killer.isHunter) return `Killed by ${article(name)} ${name}`;
    return CAUSES[type] || "Unknown causes";
  }

  // Continuous damage: applied every frame, evented once a second.
  _dot(type, amount) {
    if (!this.alive || !(amount > 0)) return;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this._dotAcc[type] += dealt;
    if (this.health > 1e-6) return;
    const recent = this.lastAttacker && this.age - this.lastDamageTime < 120;
    if (type === "bleed" && recent && this.lastAttacker.species?.name) {
      const name = this.lastAttacker.species.name;
      this.die(`Bled out after ${article(name)} ${name} attack`, this.lastAttacker);
    } else this.die(CAUSES[type] || "Unknown causes", null);
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
}

const _grad = new THREE.Vector3();

/* --- First-person controller --------------------------------------------- */

const LOOK_SENSITIVITY = 0.0024; // rad per pixel at sensitivity 1
const PITCH_LIMIT = 1.45;
const BINOCULAR_ZOOM = 0.2; // fov multiplier (≈5×)
const SPRINT_FOV_KICK = 0.075;
const MOVE_EPS = 0.08;

const _right = new THREE.Vector3();

export class HunterController {
  /**
   * @param {{ world: object, input: object, camera: THREE.PerspectiveCamera,
   *           weapons?: object|null, audio?: object|null }} opts
   */
  constructor({ world, input, camera, weapons = null, audio = null }) {
    this.world = world || {};
    this.input = input;
    this.camera = camera;
    this.weapons = weapons;
    this.audio = audio;

    /** Possessed Hunter (null before possess). */
    this.hunter = null;
    /** Binoculars up (B toggles). */
    this.binoculars = false;
    /** Current fov multiplier (1 = base fov; aim / scope / binoculars lower it). */
    this.zoom = 1;
    /** Look sensitivity multiplier (settings 0.5..2). */
    this.sensitivity = 1;
    /** Base vertical fov in degrees — captured from the camera on possess(). */
    this.baseFov = camera && Number.isFinite(camera.fov) ? camera.fov : 70;
    /** Aim angles (radians). heading convention: yaw 0 looks along +Z. */
    this.yaw = 0;
    this.pitch = 0;
    /** Crouch latch (C / touch button); Ctrl holds crouch on top. */
    this.crouchToggled = false;
    /** One-frame edge flags for main / the hunt session (true on the frame Q / X was pressed). */
    this.wantsLure = false;
    this.wantsExtract = false;
    /** Context hint for the HUD, or null. */
    this.prompt = null;

    this._time = 0;
    this._writtenYaw = null;
    this._writtenPitch = null;
    this._sprintAmt = 0;
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._lean = 0;
    this._exertion = 0;
    this._dip = 0;
    this._dipVel = 0;
    this._flinchP = 0;
    this._flinchPVel = 0;
    this._flinchR = 0;
    this._flinchRVel = 0;
    this._shake = 0;
    this._landCount = 0;
    this._lastHurt = 0;
    this._fireBlocked = false;
    this._deadRoll = 0;
    this._deadSide = 1;
    this._swimBob = 0;
  }

  /**
   * Take control of a hunter: look angles sync to its heading/pitch, the
   * camera's current fov becomes the base fov, transient camera motion resets.
   * @param {Hunter|null} hunter
   */
  possess(hunter) {
    this.hunter = hunter || null;
    const cam = this.camera;
    if (cam && Number.isFinite(cam.fov) && !this.hunter) {
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
    } else if (cam && Number.isFinite(cam.fov)) this.baseFov = cam.fov;
    this.binoculars = false;
    this.zoom = 1;
    this.crouchToggled = false;
    this.wantsLure = this.wantsExtract = false;
    this.prompt = null;
    this._sprintAmt = this._bobAmp = this._lean = this._dip = this._dipVel = 0;
    this._flinchP = this._flinchPVel = this._flinchR = this._flinchRVel = this._shake = 0;
    this._deadRoll = 0;
    this._fireBlocked = false;
    if (this.weapons && hunter && "owner" in this.weapons && !this.weapons.owner) this.weapons.owner = hunter;
    if (hunter) {
      this.yaw = Number.isFinite(hunter.heading) ? hunter.heading : 0;
      this.pitch = Number.isFinite(hunter.pitch) ? hunter.pitch : 0;
      this._writtenYaw = hunter.heading;
      this._writtenPitch = hunter.pitch;
      this._landCount = hunter.landCount || 0;
      this._lastHurt = hunter.hurt || 0;
      this._deadSide = (hunter.id || 1) % 2 ? 1 : -1;
      this._placeCamera(0);
    }
  }

  /** Point the view somewhere explicitly (e.g. after a cutscene). */
  setLook(yaw, pitch = 0) {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (this.hunter) {
      this.hunter.heading = this.yaw;
      this.hunter.pitch = this.pitch;
      this._writtenYaw = this.yaw;
      this._writtenPitch = this.pitch;
    }
  }

  /** Settings hook (main calls `setSensitivity` on settings change). */
  setSensitivity(v) {
    this.sensitivity = clamp(Number(v) || 1, 0.2, 3);
  }

  /**
   * Camera trauma 0..1 (big footfalls, roars, nearby shots). Decays by itself.
   * @param {number} amount
   */
  shake(amount) {
    this._shake = clamp(this._shake + (amount || 0), 0, 1);
  }

  /**
   * Per frame: look, movement intent, crouch/sprint, binoculars, lure/extract
   * edges, weapons, zoom and the first-person camera. Call it before or after
   * world.update — the camera reads the hunter's current state either way.
   * @param {number} dt seconds
   */
  update(dt) {
    this.wantsLure = false;
    this.wantsExtract = false;
    const h = this.hunter;
    if (!h || !(dt >= 0)) return;
    dt = Math.min(dt, 0.1);
    this._time += dt;
    const input = this.input;
    const weapons = this.weapons;

    // Someone else re-aimed the hunter (the hunt's touchdown): adopt it.
    if (h.heading !== this._writtenYaw) this.yaw = Number.isFinite(h.heading) ? h.heading : this.yaw;
    if (h.pitch !== this._writtenPitch) this.pitch = Number.isFinite(h.pitch) ? h.pitch : this.pitch;

    // Drive the body ourselves if no ecosystem manages it (dropoff edge cases, tools).
    const eco = this.world.ecosystem;
    const managed = !!eco && Array.isArray(eco.creatures) && eco.creatures.includes(h);
    if (!managed) h.update(dt);

    let fire = false;
    let aim = false;
    let reload = false;
    let switchTo = null;
    const lowered = !h.alive || h.swimming;

    if (h.alive && input) {
      this._look(input);
      const sprinting = this._drive(h, input);

      // Binoculars: B toggles; sprinting, swimming or reaching for the gun puts them away.
      if (input.pressed("binoculars") && !h.swimming) this.binoculars = !this.binoculars;
      const firePressed = input.pressed("bite");
      const fireHeld = input.isDown("bite") || firePressed;
      const aimHeld = input.isDown("aim");
      reload = input.pressed("reload");
      if (input.pressed("weapon1")) switchTo = this._loadoutId(0);
      else if (input.pressed("weapon2")) switchTo = this._loadoutId(1);
      if (this.binoculars && (sprinting || h.swimming || firePressed || input.pressed("aim") || reload || switchTo !== null)) {
        this.binoculars = false;
        if (firePressed) this._fireBlocked = true; // that click lowered the glasses; don't also shoot
      }
      if (!fireHeld) this._fireBlocked = false;

      fire = fireHeld && !sprinting && !this.binoculars && !lowered && !this._fireBlocked;
      aim = aimHeld && !sprinting && !this.binoculars && !lowered;

      if (input.pressed("call")) this.wantsLure = true;
      if (input.pressed("extract")) this.wantsExtract = true;

      if (typeof input.setActive === "function") {
        input.setActive("crouch", this.crouchToggled);
        input.setActive("binoculars", this.binoculars);
      }
    } else {
      this.binoculars = false;
    }
    if (h.swimming) this.binoculars = false;

    // Weapons: the gun goes down (and away) in binoculars, while swimming and in death.
    if (weapons && typeof weapons.update === "function") {
      weapons.update(dt, {
        fire,
        aim,
        reload,
        switchTo,
        moving: h.speed > 0.5,
        sprinting: h.alive && h.gait === "sprint",
        binoculars: this.binoculars || lowered,
        crouching: h.crouching,
      });
      // Recoil arrives as per-frame deltas that already include the settle-back.
      const k = weapons.recoilKick;
      if (k && h.alive) {
        const kp = Number.isFinite(k.pitch) ? k.pitch : 0;
        const ky = Number.isFinite(k.yaw) ? k.yaw : 0;
        this.pitch = clamp(this.pitch + kp, -PITCH_LIMIT, PITCH_LIMIT);
        this.yaw = wrapAngle(this.yaw - ky);
        // A little cosmetic punch rides on top of the real kick.
        if (kp > 0) {
          this._flinchPVel += kp * 9;
          this._flinchRVel += ky * 14 + (Math.sin(this._time * 91) > 0 ? 1 : -1) * kp * 2.5;
        }
      }
    }

    this._zoom(dt, aim);
    this.prompt = this._promptFor(h);

    // Hand the aim back to the actor (AI facing, audio listener, weapons owner).
    if (h.alive) {
      h.heading = this.yaw;
      h.pitch = this.pitch;
    }
    this._writtenYaw = h.heading;
    this._writtenPitch = h.pitch;

    this._placeCamera(dt);
  }

  /* --- Input → look / intent ----------------------------------------------------- */

  _look(input) {
    const look = input.consumeLook ? input.consumeLook() : null;
    if (!look) return;
    // Lower sensitivity while zoomed so the reticle crosses the screen at a similar rate.
    const w = this.weapons;
    const aimingK = w && Number.isFinite(w.aiming) ? lerp(1, 0.85, w.aiming) : 1;
    const k = LOOK_SENSITIVITY * this.sensitivity * (0.1 + 0.9 * this.zoom) * aimingK;
    this.yaw = wrapAngle(this.yaw - (look.dx || 0) * k);
    this.pitch = clamp(this.pitch - (look.dy || 0) * k, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // Camera-relative intent; returns whether the hunter is trying to sprint.
  _drive(h, input) {
    const it = h.intent;
    const axis = input.moveAxis();
    let ax = axis.x || 0;
    let ay = axis.y || 0;
    let mag = Math.min(1, Math.hypot(ax, ay));
    const moving = mag > MOVE_EPS;

    if (input.pressed("crouch")) this.crouchToggled = !this.crouchToggled;
    const crouchHeld = input.isDown("crouch");
    // Sprint (forward-ish only) stands you up from a toggled crouch, not a held one.
    const sprintHeld = input.isDown("sprint") && moving && ay > 0.25 && !crouchHeld && !h.winded;
    if (sprintHeld && this.crouchToggled) this.crouchToggled = false;
    const aimSlow = input.isDown("aim") || this.binoculars || (this.weapons && this.weapons.aiming > 0.5);
    const sprint = sprintHeld && !input.isDown("aim");
    const crouch = (this.crouchToggled || crouchHeld) && !sprint;

    // Aiming down sights or glassing: walk pace at most.
    if (moving && aimSlow && !sprint && mag > 0.5) {
      ax *= 0.5 / mag;
      ay *= 0.5 / mag;
      mag = 0.5;
    }
    if (!moving) {
      ax = 0;
      ay = 0;
    }

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // forward = (sin, 0, cos), right = (−cos, 0, sin)
    it.moveX = sy * ay - cy * ax;
    it.moveZ = cy * ay + sy * ax;
    it.sprint = sprint;
    it.crouch = crouch;
    return sprint && h.speed > HUMAN.speed.trot * 0.8;
  }

  _loadoutId(i) {
    const w = this.weapons;
    if (!w) return null;
    if (Array.isArray(w.loadout) && w.loadout[i] !== undefined) return w.loadout[i];
    return i;
  }

  _zoom(dt, aim) {
    const w = this.weapons;
    let target = 1;
    if (this.binoculars) target = BINOCULAR_ZOOM;
    else if (w && Number.isFinite(w.zoom)) target = w.zoom; // already eased with w.aiming
    else if (aim && w) {
      const def = w.def || (w.WEAPONS && w.WEAPONS[w.current]);
      if (def && Number.isFinite(def.zoom)) target = def.zoom;
    }
    // Zooming in is quick, the glasses coming down slightly softer.
    this.zoom = damp(this.zoom, clamp(target, 0.05, 1.5), target < this.zoom ? 16 : 12, dt);
    if (Math.abs(this.zoom - target) < 1e-4) this.zoom = target;
  }

  _promptFor(h) {
    if (!h.alive) return null;
    if (h.swimming) return h.stamina < 30 ? "Exhausted — swim for shore" : "Swimming — weapon stowed";
    if (h.legBroken > 0) return "Leg injured — can't sprint";
    if (h.winded) return "Out of breath";
    return null;
  }

  /* --- Camera ---------------------------------------------------------------------- */

  _placeCamera(dt) {
    const cam = this.camera;
    const h = this.hunter;
    if (!cam || !h) return;
    const t = this._time;
    const zoomed = this.zoom < 0.95;
    const w = this.weapons;
    const aiming = w && Number.isFinite(w.aiming) ? w.aiming : 0;

    // Sprint fov kick and exertion (breathing gets deeper as stamina falls).
    this._sprintAmt = damp(this._sprintAmt, h.alive && h.gait === "sprint" ? 1 : 0, 4, dt);
    this._exertion = damp(this._exertion, clamp(1 - h.stamina / 100, 0, 1), 1.5, dt);

    // Head bob paced by distance (one dip per footfall, sway every other step —
    // the same stride the audio uses for footsteps, so they line up).
    const onFoot = h.alive && !h.swimming && !h.airborne;
    const s = h.speed;
    const stride = lerp(0.72, 1.55, smoothstep(1.6, 6.2, s));
    this._bobPhase += (s * dt) / stride;
    if (this._bobPhase > 1e4) this._bobPhase -= 1e4;
    let ampT = onFoot && s > 0.3 ? lerp(0.014, 0.05, smoothstep(1, 6.2, s)) : 0;
    ampT *= lerp(1, 0.6, h.crouchAmount) * lerp(1, 0.35, aiming) * (zoomed ? 0.25 : 1);
    this._bobAmp = damp(this._bobAmp, ampT, 6, dt);
    const ph = this._bobPhase * TAU;
    const bobY = -this._bobAmp * (0.5 + 0.5 * Math.cos(ph)); // lowest at the footfall
    const bobX = this._bobAmp * 0.55 * Math.sin(ph * 0.5);
    const bobPitch = -this._bobAmp * 0.12 * Math.cos(ph);
    const bobRoll = this._bobAmp * 0.25 * Math.sin(ph * 0.5);

    // Breathing: slow, deeper and faster when winded; tiny when zoomed.
    const ex = this._exertion;
    const bf = lerp(0.24, 0.7, ex) * TAU;
    const zk = clamp(this.zoom, 0.15, 1);
    const breath = lerp(0.0016, 0.0065, ex) * zk * lerp(1, 0.6, aiming);
    const breathPitch = Math.sin(t * bf) * breath;
    const breathYaw = Math.sin(t * bf * 0.5 + 1.1) * breath * 0.6;
    const breathY = Math.sin(t * bf) * lerp(0.004, 0.012, ex);

    // Swimming: the swell lifts and rolls you.
    let swimY = 0;
    let swimRoll = 0;
    if (h.swimming) {
      swimY = Math.sin(t * 1.25) * 0.045 + Math.sin(t * 2.1 + 0.7) * 0.02;
      swimRoll = Math.sin(t * 0.9 + 0.3) * 0.02;
    }

    // Lean a touch into strafes.
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const lateral = h.velocity.x * _right.x + h.velocity.z * _right.z;
    this._lean = damp(this._lean, h.alive ? clamp(-lateral * 0.0055, -0.025, 0.025) : 0, 5, dt);

    // Landings: a dip with a springy recovery.
    if ((h.landCount || 0) !== this._landCount) {
      this._landCount = h.landCount || 0;
      const imp = h.landSpeed || 0;
      this._dipVel -= clamp(imp * 0.13, 0.06, 1.7);
      this._flinchPVel -= clamp(imp * 0.03, 0.01, 0.35);
      if (imp > 6) this.shake(clamp((imp - 6) * 0.06, 0, 0.5));
    }
    // Getting hurt: flinch + shake.
    const hurt = h.hurt || 0;
    if (hurt > this._lastHurt + 0.05) {
      const k = hurt - this._lastHurt;
      this._flinchPVel += 1.2 * k;
      this._flinchRVel += (Math.sin(t * 13.7) > 0 ? 1 : -1) * 1.6 * k;
      this.shake(0.25 + k * 0.45);
    }
    this._lastHurt = hurt;

    // Springs (slightly under-damped so they settle with life).
    if (dt > 0) {
      const sub = Math.max(1, Math.ceil(dt / 0.012));
      const sdt = dt / sub;
      for (let i = 0; i < sub; i++) {
        this._dipVel += (-140 * this._dip - 17 * this._dipVel) * sdt;
        this._dip += this._dipVel * sdt;
        this._flinchPVel += (-120 * this._flinchP - 15 * this._flinchPVel) * sdt;
        this._flinchP += this._flinchPVel * sdt;
        this._flinchRVel += (-110 * this._flinchR - 14 * this._flinchRVel) * sdt;
        this._flinchR += this._flinchRVel * sdt;
      }
      this._shake = Math.max(0, this._shake - dt * 1.4);
    }
    const tr = this._shake * this._shake;
    const shakeP = tr * 0.03 * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.3 + 1.7) * 0.4);
    const shakeY = tr * 0.03 * (Math.sin(t * 29.7 + 0.4) * 0.6 + Math.sin(t * 19.1 + 2.3) * 0.4);
    const shakeR = tr * 0.04 * Math.sin(t * 31.9 + 0.9);

    // Death: slump to the ground and roll onto a side.
    let pitch = this.pitch;
    let yaw = this.yaw;
    if (!h.alive) {
      const k = smoothstep(0, 1, (h._deadT || 0) / 1.3);
      this._deadRoll = this._deadSide * 1.2 * k * k;
      pitch = lerp(this.pitch, 0.12, k);
      yaw = this.yaw + this._deadSide * 0.25 * k;
    } else this._deadRoll = 0;

    // Compose.
    h.eyePosition(_eye);
    _eye.x += _right.x * bobX;
    _eye.z += _right.z * bobX;
    _eye.y += bobY + breathY + swimY + this._dip;
    const t2 = this.world.terrain;
    if (t2 && h.alive) _eye.y = Math.max(_eye.y, t2.heightAt(_eye.x, _eye.z) + 0.25);
    cam.position.copy(_eye);
    cam.rotation.order = "YXZ";
    cam.rotation.set(
      clamp(pitch + bobPitch + breathPitch + this._flinchP * 0.1 + shakeP, -1.55, 1.55),
      yaw + Math.PI + breathYaw + shakeY,
      this._lean + bobRoll * 0.4 + swimRoll + this._flinchR * 0.06 + shakeR + this._deadRoll
    );

    const fov = this.baseFov * this.zoom * (1 + SPRINT_FOV_KICK * this._sprintAmt * (zoomed ? 0 : 1));
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  /** Horizontal unit vector the view looks along (heading convention). */
  forward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Full look direction including pitch (without cosmetic sway). */
  lookDirection(target = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return target.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  /** Release the camera fov back to its base. */
  dispose() {
    if (this.camera && Number.isFinite(this.baseFov)) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
    this.hunter = null;
  }
}

// Exported for tests / the HUD (e.g. a stealth meter legend).
export const HUNTER_TUNING = {
  eyeStand: EYE_STAND,
  eyeCrouch: EYE_CROUCH,
  binocularZoom: BINOCULAR_ZOOM,
  swimEnter: SWIM_ENTER,
  fallSafe: FALL_SAFE,
};

// Keep a reference so bundlers / linters don't flag the shared scratch as unused.
void _fwd;
