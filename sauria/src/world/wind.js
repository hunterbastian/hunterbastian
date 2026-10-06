// Wind — a slowly veering, gusty island breeze.
//
// Scent drifts downwind, so every brain's sense of smell (both modes) asks
// `scentFactor()` how well a smell carries from one point to another; the
// hunter HUD shows the arrow; the helicopter leans into gusts. The direction
// wanders over minutes (two slow oscillators plus an occasional real shift),
// the strength breathes over seconds (flutter plus discrete gusts). Seeded
// and allocation-free: `update` and `scentFactor` only touch numbers.

import * as THREE from "three";
import { makeRng, rand } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep, damp, wrapAngle } from "../core/math.js";

/* --- Tuning --- */

const MAX_SPEED = 14; // m/s at strength 1 (a stiff breeze) — for readouts only

// scentFactor shape: straight downwind / crosswind / straight upwind, and the
// value everything relaxes toward in still air (scent pools, carries poorly).
const SCENT_DOWNWIND = 1.6;
const SCENT_CROSSWIND = 1.0;
const SCENT_UPWIND = 0.15;
const SCENT_STILL = 0.8;

// Below this strength the plume stops being directional.
const CALM_LO = 0.04;
const CALM_HI = 0.4;

/* --- Wind --- */

export class Wind {
  /**
   * @param {number} seed any integer; the same seed (and dt sequence) gives the same weather
   */
  constructor(seed = 1) {
    const rng = makeRng((seed ^ 0x5eed17) >>> 0);
    this._rng = rng;

    /** Seconds simulated so far. */
    this.time = 0;
    /** Direction the wind blows TOWARD (heading convention: 0 = +Z). */
    this.yaw = 0;
    /** 0..1, gusty. */
    this.strength = 0;
    /** Approximate wind speed in m/s (strength × 14) — handy for HUD copy. */
    this.speed = 0;
    /** Unit (x, 0, z) the wind blows toward. Updated in place. */
    this.vector = new THREE.Vector3(0, 0, 1);

    // Prevailing direction plus two slow veering oscillators (minutes).
    this._baseYaw = rng() * TAU;
    this._veerAmpA = rand(rng, 0.35, 0.6);
    this._veerWA = TAU / rand(rng, 240, 420);
    this._veerPA = rng() * TAU;
    this._veerAmpB = rand(rng, 0.12, 0.22);
    this._veerWB = TAU / rand(rng, 70, 140);
    this._veerPB = rng() * TAU;

    // Occasional frontal shifts: every few minutes the wind swings to a new
    // quarter, easing in and out over about a minute (S-curve, so the
    // change builds noticeably rather than snapping).
    this._shift = 0;
    this._shiftFrom = 0;
    this._shiftTarget = 0;
    this._shiftAge = 0;
    this._shiftDur = 1;
    this._shiftTimer = rand(rng, 120, 300);

    // Strength: a slowly breathing mean (minutes) …
    this._meanBase = rand(rng, 0.36, 0.5);
    this._meanWA = TAU / rand(rng, 180, 360);
    this._meanPA = rng() * TAU;
    this._meanWB = TAU / rand(rng, 50, 90);
    this._meanPB = rng() * TAU;
    // … seconds-scale flutter …
    this._flutterP1 = rng() * TAU;
    this._flutterP2 = rng() * TAU;
    this._flutterP3 = rng() * TAU;
    // … and discrete gusts with a soft attack and a long tail.
    this._gustTimer = rand(rng, 3, 10);
    this._gustAge = 1e3;
    this._gustAmp = 0;
    this._gustAttack = 1.5;
    this._gustDecay = 4;
    this._gustYaw = 0;
    // What is left of the previous gust when a new one starts; it keeps decaying
    // so overlapping gusts never make strength or direction jump.
    this._gustResid = 0;
    this._gustResidYaw = 0;
    this._gustYawOff = 0;
    /** Current gust contribution 0..~0.4 (0 between gusts). */
    this.gust = 0;

    this.update(0);
  }

  /**
   * Advance the weather. Direction drifts over minutes, strength gusts over seconds.
   * @param {number} dt seconds
   */
  update(dt) {
    const rng = this._rng;
    const t = (this.time += dt);

    /* Direction */
    this._shiftTimer -= dt;
    if (this._shiftTimer <= 0) {
      this._shiftTimer = rand(rng, 150, 360);
      const swing = rand(rng, 0.45, 1.15) * (rng() < 0.5 ? -1 : 1);
      // Keep the accumulated shift bounded so the prevailing wind stays recognisable.
      this._shiftFrom = this._shift;
      this._shiftTarget = clamp(this._shift + swing, -1.6, 1.6);
      this._shiftAge = 0;
      this._shiftDur = rand(rng, 40, 70);
    }
    this._shiftAge += dt;
    this._shift = lerp(this._shiftFrom, this._shiftTarget, smoothstep(0, this._shiftDur, this._shiftAge));

    /* Gusts */
    this._gustTimer -= dt;
    if (this._gustTimer <= 0) {
      this._gustTimer = rand(rng, 6, 20);
      this._gustResid = this.gust;
      this._gustResidYaw = this._gustYawOff;
      this._gustAge = 0;
      this._gustAmp = rand(rng, 0.12, 0.38);
      this._gustAttack = rand(rng, 1.2, 2.2);
      this._gustDecay = rand(rng, 2.5, 5.5);
      this._gustYaw = rand(rng, -0.14, 0.14); // gusts come in a little off-axis
    }
    this._gustAge += dt;
    const ga = this._gustAge;
    const envelope = ga < this._gustAttack
      ? smoothstep(0, this._gustAttack, ga)
      : Math.exp(-(ga - this._gustAttack) / this._gustDecay);
    const residK = Math.exp(-dt / 3);
    this._gustResid *= residK;
    this._gustResidYaw *= residK;
    this.gust = this._gustResid + this._gustAmp * envelope;
    this._gustYawOff = this._gustResidYaw + this._gustYaw * envelope;

    const flutter =
      0.05 * Math.sin(t * 2.1 + this._flutterP1) +
      0.035 * Math.sin(t * 3.7 + this._flutterP2) +
      0.02 * Math.sin(t * 6.3 + this._flutterP3);
    const mean =
      this._meanBase +
      0.17 * Math.sin(t * this._meanWA + this._meanPA) +
      0.07 * Math.sin(t * this._meanWB + this._meanPB);
    this.strength = clamp(mean + this.gust + flutter, 0.02, 1);
    this.speed = this.strength * MAX_SPEED;

    // Gusty air also jitters the direction a little; calm air wanders more.
    const jitter =
      (0.05 * Math.sin(t * 0.9 + this._flutterP2) + 0.03 * Math.sin(t * 2.3 + this._flutterP3)) *
      (1.4 - this.strength);
    const yaw =
      this._baseYaw +
      this._veerAmpA * Math.sin(t * this._veerWA + this._veerPA) +
      this._veerAmpB * Math.sin(t * this._veerWB + this._veerPB) +
      this._shift +
      this._gustYawOff +
      jitter;
    this.yaw = wrapAngle(yaw);
    this.vector.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /**
   * How well scent carries from a source to a receiver, as a multiplier on smell range:
   * ≈1.6 when the receiver is straight downwind of the source, ≈1 crosswind, ≈0.15 straight
   * upwind; in light air everything relaxes toward ~0.8 (scent pools and carries poorly).
   * @param {number} fromX source (the creature being smelled)
   * @param {number} fromZ
   * @param {number} toX receiver (the creature smelling)
   * @param {number} toZ
   * @returns {number}
   */
  scentFactor(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const d2 = dx * dx + dz * dz;
    const calm = smoothstep(CALM_LO, CALM_HI, this.strength);
    if (d2 < 1e-6) return lerp(SCENT_STILL, SCENT_CROSSWIND, calm);
    // c = +1: the receiver lies straight down the plume; −1: straight upwind.
    const c = (dx * this.vector.x + dz * this.vector.z) / Math.sqrt(d2);
    const directional = c >= 0
      ? lerp(SCENT_CROSSWIND, SCENT_DOWNWIND, smoothstep(0, 1, c))
      : lerp(SCENT_CROSSWIND, SCENT_UPWIND, smoothstep(0, 1, -c));
    return lerp(SCENT_STILL, directional, calm);
  }
}
