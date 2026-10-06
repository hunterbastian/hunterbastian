// HuntSession — one Hunter-mode outing, from the helicopter drop-off to the
// extraction (or the hunter's death): landing-zone choice, target-species
// spawn bias, trophies and scoring, radar pings, the lure call, the pickup
// flow, and the persistent hunter profile (points, unlocked weapons, trophy
// room) in localStorage.
//
// Main's side of the deal, per state:
//   "dropoff"     the hunter rides the left cargo door. Keep input locked, don't
//                 update the HunterController, and put the camera on the door
//                 seat each frame with `applyRideCamera(camera, lookYaw, lookPitch)`
//                 (or read `hunterAnchor` yourself). The hunter actor is parked
//                 on the landing zone meanwhile. `skipDropoff()` cuts to final.
//   "hunting"     entered at touchdown: the hunter has been placed beside the
//                 door facing out (`hunter.heading`); sync the controller's yaw
//                 to it and hand control back.
//   "extracting"  after `requestExtraction()`; watch `extraction` for the HUD.
//   "ended"       `end()` ran (by you, or by us when the hunter reached the
//                 hovering chopper). `summary` holds the results; on "extracted"
//                 `riding` is true again and the chopper flies the hunter out —
//                 keep calling `update(dt)` until you leave the scene.

import * as THREE from "three";
import { Helicopter } from "./helicopter.js";
import { makeRng, hash } from "../core/rng.js";
import { TAU, clamp } from "../core/math.js";

/* --- Profile ----------------------------------------------------------------- */

const PROFILE_KEY = "sauria.hunter.v1";
const PROFILE_VERSION = 1;
const DEFAULT_WEAPONS = ["revolver", "shotgun", "rifle"];
const MAX_STORED_TROPHIES = 500; // keeps the localStorage entry well under quota

/* --- Scoring ----------------------------------------------------------------- */

/** Base trophy value per species (adult, body shot, not a declared target, no equipment). */
export const TROPHY_VALUES = {
  dryosaurus: 10,
  camptosaurus: 16,
  gastonia: 30,
  utahraptor: 34,
  ceratosaurus: 42,
  stegosaurus: 48,
  allosaurus: 60,
  diplodocus: 75,
};
const HEADSHOT_BONUS = 1.5;
const TARGET_BONUS = 1.5;
const EQUIPMENT_PENALTY = 0.1; // per equipment item carried
const TARGET_SPAWN_BIAS = 3;

/* --- Tuning ------------------------------------------------------------------ */

const RADAR_INTERVAL = 10; // s between pings
const RADAR_FIRST = 1.5; // s after touchdown for the first ping
const RADAR_RANGE = 600; // m
const LURE_COOLDOWN = 20; // s
const EXTRACT_RADIUS = 8; // m, horizontal, from the hovering chopper
const BOARD_DELAY = 1.2; // s the chopper hovers before a hunter already beneath it climbs aboard
const INBOUND_ETA = 12; // s: report "inbound" from here (or when on final)
const LOW_HOVER_CLEAR = 11; // m of tree-free radius a low hover needs (rotor + canopy)
const CANOPY_HOVER = 34; // m: over trees the chopper hovers high and lowers the hoist
const LZ_CANDIDATES = 36;
const LZ_HABITAT_RINGS = [220, 300, 380]; // m: where we'd like the targets to be

// Unlock thresholds and species habitats: the real tables load in the
// background; these mirror ARCHITECTURE.md so the session never waits on them.
let UNLOCK_POINTS = { revolver: 0, shotgun: 0, rifle: 0, crossbow: 150, sniper: 400 };
let SPECIES_DEFS = null;
const FALLBACK_BIOMES = {
  dryosaurus: ["plains", "forest", "beach"],
  utahraptor: ["forest", "plains", "swamp"],
  gastonia: ["plains", "forest", "highland"],
  ceratosaurus: ["swamp", "forest", "beach"],
  stegosaurus: ["plains", "forest", "swamp"],
  allosaurus: ["plains", "forest", "highland"],
  camptosaurus: ["plains", "forest", "swamp"],
  diplodocus: ["plains", "swamp", "beach"],
};
import("./weapons.js")
  .then((m) => {
    if (!m || !m.WEAPONS) return;
    const table = {};
    for (const id in m.WEAPONS) {
      const n = Number(m.WEAPONS[id]?.unlockPoints);
      table[id] = Number.isFinite(n) ? n : 0;
    }
    UNLOCK_POINTS = table;
  })
  .catch(() => {});
import("../creatures/species.js")
  .then((m) => {
    if (m && m.SPECIES) SPECIES_DEFS = m.SPECIES;
  })
  .catch(() => {});

/* --- Helpers ----------------------------------------------------------------- */

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
let trophySerial = 0;

const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

function cleanTrophy(t) {
  return {
    id: String(t.id ?? `t${++trophySerial}`),
    speciesId: String(t.speciesId ?? "unknown"),
    speciesName: String(t.speciesName ?? t.speciesId ?? "Unknown"),
    mass: finite(Number(t.mass)),
    score: finite(Number(t.score)),
    headshot: !!t.headshot,
    distance: finite(Number(t.distance)),
    weapon: t.weapon == null ? null : String(t.weapon),
    time: finite(Number(t.time)),
    target: !!t.target,
    date: t.date == null ? null : String(t.date),
    ...(t.clock ? { clock: String(t.clock) } : {}),
  };
}

function normalizeProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const listed = Array.isArray(p.unlocked?.weapons) ? p.unlocked.weapons.filter((w) => typeof w === "string") : [];
  const trophies = Array.isArray(p.trophies)
    ? p.trophies.filter((t) => t && typeof t === "object").map(cleanTrophy).slice(-MAX_STORED_TROPHIES)
    : [];
  return {
    version: PROFILE_VERSION,
    points: Math.max(0, Math.round(finite(Number(p.points)))),
    unlocked: { weapons: [...new Set([...DEFAULT_WEAPONS, ...listed])] },
    trophies,
    hunts: Math.max(0, Math.floor(finite(Number(p.hunts)))),
  };
}

/** Fallback value for a species missing from the table: grows slowly with adult mass. */
function valueFromMass(mass) {
  return Math.round(clamp(10 + 15 * Math.log10(Math.max(1, mass / 90)), 5, 90));
}

/* --- HuntSession ---------------------------------------------------------------- */

export class HuntSession {
  /**
   * @param {{ world: object, events?: object }} opts world (scene, terrain, ecosystem, sky, …);
   *   events defaults to world.events
   */
  constructor({ world, events = null } = {}) {
    this.world = world;
    this.events = events || world?.events || null;
    /** Persistent profile (refreshed on start / end). */
    this.profile = HuntSession.loadProfile();
    /** True between start() and end(). */
    this.active = false;
    /** "idle" (not started) | "dropoff" | "hunting" | "extracting" | "ended" */
    this.state = "idle";
    /** This hunt's trophies (see _makeTrophy for the shape). */
    this.trophies = [];
    /** Sum of this hunt's trophy scores. */
    this.score = 0;
    /** Seconds since start(). */
    this.elapsed = 0;
    /** Results of the last end(), or null. */
    this.summary = null;
    /** True while the hunter is aboard (drop-off flight, or flying out after extraction). */
    this.riding = false;
    /** The hunter died this hunt (nothing will be banked). */
    this.hunterDead = false;
    /** { x, z, clearR } chosen in start(). */
    this.landingZone = null;
    /** null | { state: "called"|"inbound"|"landed"|"departed", eta, x, z, hover } — poll for the HUD. */
    this.extraction = null;
    /** Seconds until lure() works again. */
    this.lureCooldown = 0;
    /** Seconds until the next radar ping (when equipped). */
    this.radarTimer = 0;
    /** Last radar result { blips, time } or null. */
    this.radar = null;
    /** Score multiplier from equipment carried (1 − 0.1 per item). */
    this.equipmentMultiplier = 1;
    this.equipment = { camo: false, coverScent: false, radar: false, lure: false };
    this.targets = [];
    this.hunter = null;
    this.weapons = null;
    /** Helicopter for this hunt (also published as world.helicopter). */
    this.helicopter = null;
    /** Optional hooks: onStateChange(state, prev), onEnd(summary). */
    this.onStateChange = null;
    this.onEnd = null;

    this._offs = [];
    this._hits = new Map();
    this._trophied = new WeakSet();
    this._lastShot = null;
    this._lureIndex = 0;
    this._radarOut = [];
    this._colliders = [];
    this._radarFilter = (c) =>
      c && c !== this.hunter && !c.isHunter && c.alive !== false &&
      (this.targets.length === 0 || this.targets.includes(c.species?.id));
  }

  /* --- Profile ------------------------------------------------------------------ */

  /**
   * Read the hunter profile from localStorage (defaults when missing, corrupt or blocked).
   * @returns {{ version: number, points: number, unlocked: { weapons: string[] }, trophies: object[], hunts: number }}
   */
  static loadProfile() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    } catch {
      raw = null;
    }
    return normalizeProfile(raw);
  }

  /**
   * Persist a profile (normalised, schema-versioned). Never throws.
   * @returns {boolean} false if storage is unavailable
   */
  static saveProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(normalizeProfile(profile)));
      return true;
    } catch {
      return false;
    }
  }

  /* --- Lifecycle ------------------------------------------------------------------- */

  /**
   * Begin a hunt: pick a landing zone, bias spawns toward the targets, launch the
   * helicopter drop-off (world.helicopter). State → "dropoff", then "hunting" at touchdown.
   * @param {{ hunter: object, weapons?: object, equipment?: { camo?, coverScent?, radar?, lure? }, targets?: string[] }} opts
   * @returns {{ x: number, z: number, clearR: number }} the landing zone
   */
  start({ hunter, weapons = null, equipment = {}, targets = [] } = {}) {
    if (this.active) this.end("quit");
    this._unsubscribe();
    this._releaseHelicopter();
    const w = this.world;

    this.hunter = hunter || null;
    this.weapons = weapons;
    this.equipment = {
      camo: !!equipment?.camo,
      coverScent: !!equipment?.coverScent,
      radar: !!equipment?.radar,
      lure: !!equipment?.lure,
    };
    const items = Object.values(this.equipment).filter(Boolean).length;
    this.equipmentMultiplier = Math.max(0, 1 - EQUIPMENT_PENALTY * items);
    this.targets = [...new Set((Array.isArray(targets) ? targets : []).filter((t) => typeof t === "string"))];

    this.profile = HuntSession.loadProfile();
    this.trophies = [];
    this.score = 0;
    this.elapsed = 0;
    this.summary = null;
    this.extraction = null;
    this.hunterDead = false;
    this.lureCooldown = 0;
    this.radarTimer = RADAR_FIRST;
    this.radar = null;
    this._lureIndex = 0;
    this._hits = new Map();
    this._trophied = new WeakSet();
    this._lastShot = null;

    const bias = {};
    for (const t of this.targets) bias[t] = TARGET_SPAWN_BIAS;
    w?.ecosystem?.setSpawnBias?.(bias);

    this.landingZone = this._chooseLandingZone();
    this._parkHunter();

    if (w?.scene) {
      this.helicopter = new Helicopter(w.scene, {
        terrain: w.terrain || null,
        sky: w.sky || null,
        vegetation: w.vegetation || null,
        wind: w.wind || null,
        quality: w.quality || null,
      });
      w.helicopter = this.helicopter;
      const lz = this.landingZone;
      this.helicopter.dropOff(lz, () => this._touchdown(), { clearR: lz.clearR });
    }
    this._subscribe();
    this.active = true;
    this.riding = !!this.helicopter;
    this._setState("dropoff");
    if (!this.helicopter) this._touchdown(); // headless (no scene): start on the ground
    return this.landingZone;
  }

  /**
   * Per-frame: helicopter flight, radar pings, lure cooldown, extraction flow.
   * Keep calling after end() while the chopper flies off (it is released when gone).
   * @param {number} dt seconds
   */
  update(dt) {
    const h = this.helicopter;
    if (h) {
      h.update(dt);
      if (!this.active && !h.active) this._releaseHelicopter();
    }
    if (!this.active) return;
    this.elapsed += dt;
    const hunter = this.hunter;
    if (hunter && hunter.alive === false) this.hunterDead = true;

    if (this.state === "dropoff") {
      this._parkHunter();
      return;
    }
    if (this.lureCooldown > 0) this.lureCooldown = Math.max(0, this.lureCooldown - dt);
    if (this.equipment.radar && !this.hunterDead) {
      this.radarTimer -= dt;
      if (this.radarTimer <= 0) {
        this.radarTimer += RADAR_INTERVAL;
        this._radarPing();
      }
    }
    if (this.state === "extracting") this._updateExtraction();
  }

  /**
   * Blow the call device: emits "lure" at the hunter for a target species (cycling
   * through the targets), with a ~20 s cooldown. Needs the "lure" equipment.
   * @param {string} [speciesId] call a specific species instead
   * @returns {string|null} the species called, or null if unavailable
   */
  lure(speciesId = null) {
    if (!this.active || this.hunterDead || !this.equipment.lure) return null;
    if (this.state !== "hunting" && this.state !== "extracting") return null;
    if (this.lureCooldown > 0 || !this.hunter) return null;
    let species = typeof speciesId === "string" ? speciesId : null;
    if (!species && this.targets.length) {
      species = this.targets[this._lureIndex % this.targets.length];
      this._lureIndex++;
    }
    if (!species) species = this._nearestSpecies();
    if (!species) return null;
    const p = this.hunter.position;
    this.lureCooldown = LURE_COOLDOWN;
    this._emit("lure", { species, x: p.x, z: p.z, shooter: this.hunter });
    return species;
  }

  /**
   * Call the helicopter: it comes in from the nearest coast (~25 s), hovers low at
   * the hunter (or the nearest flat, tree-free spot within 30 m — high with a hoist
   * line if there is none) and waits; walk within 8 m to extract.
   * @returns {boolean} false if not currently hunting
   */
  requestExtraction() {
    if (!this.active || this.state !== "hunting" || this.hunterDead || !this.hunter) return false;
    const hp = this.hunter.position;
    const p = this._findPickupPoint(hp.x, hp.z);
    this.extraction = { state: "called", eta: 0, x: p.x, z: p.z, hover: p.hover };
    if (this.helicopter) {
      this.helicopter.pickUp(p, () => this._chopperArrived(), { hover: p.hover, clearR: p.clearR });
      this.extraction.eta = Math.round(this.helicopter.eta);
    }
    this._setState("extracting");
    this._emit("extraction", { state: "called", eta: this.extraction.eta });
    if (!this.helicopter) this._chopperArrived();
    return true;
  }

  /**
   * Finish the hunt. "extracted" banks the score as points plus the trophies (dated)
   * and unlocks weapons; "died" / "quit" bank nothing. Idempotent.
   * @param {"extracted"|"died"|"quit"} result
   * @returns {{ result, trophies, score, points, unlocked: string[], duration, totalPoints }}
   */
  end(result = "quit") {
    if (this.summary && !this.active) return this.summary;
    let r = result === "extracted" || result === "died" ? result : "quit";
    if (r === "extracted" && (this.hunterDead || this.hunter?.alive === false)) r = "died";
    const banked = r === "extracted";
    const points = banked ? this.score : 0;
    const unlocked = [];

    // Re-read before writing so a profile saved elsewhere (another tab) isn't clobbered.
    const profile = HuntSession.loadProfile();
    if (this.state !== "idle") profile.hunts += 1;
    if (banked) {
      profile.points += points;
      const date = new Date().toISOString();
      for (const t of this.trophies) profile.trophies.push({ ...t, date });
      if (profile.trophies.length > MAX_STORED_TROPHIES) profile.trophies.splice(0, profile.trophies.length - MAX_STORED_TROPHIES);
      const entries = Object.entries(UNLOCK_POINTS).sort((a, b) => a[1] - b[1]);
      for (const [id, need] of entries) {
        if (profile.points >= need && !profile.unlocked.weapons.includes(id)) {
          profile.unlocked.weapons.push(id);
          unlocked.push(id);
        }
      }
    }
    HuntSession.saveProfile(profile);
    this.profile = profile;

    this.world?.ecosystem?.setSpawnBias?.({});
    const h = this.helicopter;
    if (h && h.active && h.phase !== "departing" && h.phase !== "outbound") h.depart();
    if (this.extraction && banked) this.extraction.state = "departed";
    if (banked) this._emit("extraction", { state: "departed", eta: 0 });
    this._unsubscribe();

    this.active = false;
    this.riding = banked && !!h;
    this.summary = {
      result: r,
      trophies: this.trophies.slice(),
      score: this.score,
      points,
      unlocked,
      duration: this.elapsed,
      totalPoints: profile.points,
    };
    this._setState("ended");
    this.onEnd?.(this.summary);
    return this.summary;
  }

  /** Tear everything down now (helicopter, listeners, spawn bias) — e.g. quitting to the menu. */
  dispose() {
    if (this.active) this.world?.ecosystem?.setSpawnBias?.({});
    this.active = false;
    this.riding = false;
    this._unsubscribe();
    this._releaseHelicopter();
  }

  /* --- Ride-along camera --------------------------------------------------------- */

  /** The hunter's seat in the helicopter's left door (THREE.Object3D) or null. */
  get hunterAnchor() {
    return this.helicopter && this.helicopter.active ? this.helicopter.anchor : null;
  }

  /**
   * Put a camera on the door seat, looking out (plus optional free-look offsets).
   * @param {THREE.Camera} camera
   * @param {number} [lookYaw] radians, positive = left
   * @param {number} [lookPitch] radians, positive = up
   * @returns {boolean} false when there is no active helicopter to ride
   */
  applyRideCamera(camera, lookYaw = 0, lookPitch = 0) {
    const a = this.hunterAnchor;
    if (!a || !camera) return false;
    a.getWorldPosition(camera.position);
    a.getWorldQuaternion(camera.quaternion);
    if (lookYaw || lookPitch) {
      _q.setFromEuler(_e.set(lookPitch, lookYaw, 0, "YXZ"));
      camera.quaternion.multiply(_q);
    }
    return true;
  }

  /** Cut the drop-off flight to its short final (a "skip intro" button). */
  skipDropoff() {
    if (this.state === "dropoff") this.helicopter?.skipToFinal();
  }

  /* --- Internals: events ---------------------------------------------------------- */

  _emit(name, payload) {
    this.events?.emit?.(name, payload);
  }

  _setState(s) {
    const prev = this.state;
    this.state = s;
    if (prev !== s) this.onStateChange?.(s, prev);
  }

  _subscribe() {
    const ev = this.events;
    if (!ev || typeof ev.on !== "function") return;
    const on = (name, fn) => {
      const off = ev.on(name, fn);
      this._offs.push(typeof off === "function" ? off : () => ev.off?.(name, fn));
    };
    on("shot", (e) => this._onShot(e));
    on("hit", (e) => this._onHit(e));
    on("death", (e) => this._onDeath(e));
  }

  _unsubscribe() {
    for (const off of this._offs) off();
    this._offs.length = 0;
  }

  _onShot(e) {
    if (!e || e.shooter !== this.hunter || !this.hunter) return;
    this._lastShot = { weapon: e.weapon ?? null, x: e.x, y: e.y, z: e.z, time: this.elapsed };
  }

  _onHit(e) {
    if (!e || !e.target || e.shooter !== this.hunter || !this.hunter) return;
    const shot = this._lastShot && this.elapsed - this._lastShot.time < 4 ? this._lastShot : null;
    let distance;
    if (shot && Number.isFinite(e.x) && Number.isFinite(shot.x)) {
      distance = Math.hypot(e.x - shot.x, finite(e.y) - finite(shot.y), e.z - shot.z);
    } else {
      const a = this.hunter.position;
      const b = e.target.position || { x: e.x, z: e.z };
      distance = Math.hypot(finite(b.x) - a.x, finite(b.z) - a.z);
    }
    this._hits.set(e.target, {
      headshot: !!e.headshot,
      part: e.part ?? null,
      weapon: shot?.weapon ?? this.weapons?.current ?? null,
      distance,
      time: this.elapsed,
    });
  }

  _onDeath(e) {
    const c = e?.creature;
    if (!c) return;
    if (c === this.hunter) {
      this.hunterDead = true;
      return;
    }
    if (!this.active || !this.hunter || this._trophied.has(c)) return;
    const hit = this._hits.get(c);
    // A clean kill, or a bleed-out from the hunter's wound that nobody else finished.
    const byHunter = e.killer === this.hunter ||
      (!e.killer && hit && (c.lastAttacker === this.hunter || c.lastAttacker == null));
    if (!byHunter) return;
    this._trophied.add(c);
    this._hits.delete(c);
    const trophy = this._makeTrophy(c, hit);
    this.trophies.push(trophy);
    this.score += trophy.score;
    this._emit("trophy", { trophy });
  }

  /**
   * Trophy for a kill: value(species) × √(mass / adult mass) × headshot 1.5 × target 1.5 ×
   * equipment multiplier, rounded.
   */
  _makeTrophy(c, hit) {
    const sp = c.species || {};
    const id = sp.id ?? "unknown";
    const adult = finite(sp.mass, finite(c.mass, 1)) || 1;
    const mass = Number.isFinite(c.mass) ? c.mass : adult * Math.pow(finite(c.scale, 1), 3);
    const value = TROPHY_VALUES[id] ?? valueFromMass(adult);
    const size = Math.sqrt(clamp(mass / adult, 0.01, 4));
    const headshot = !!hit?.headshot;
    const target = this.targets.includes(id);
    const raw = value * size * (headshot ? HEADSHOT_BONUS : 1) * (target ? TARGET_BONUS : 1) * this.equipmentMultiplier;
    let distance = hit?.distance;
    if (!Number.isFinite(distance)) {
      const a = this.hunter.position;
      distance = c.position ? Math.hypot(c.position.x - a.x, c.position.z - a.z) : 0;
    }
    const clock = this.world?.sky?.clockString?.();
    return {
      id: `${Date.now().toString(36)}-${(++trophySerial).toString(36)}`,
      speciesId: id,
      speciesName: sp.name ?? id,
      mass: Math.round(mass),
      score: Math.max(1, Math.round(raw)),
      headshot,
      distance: Math.round(distance * 10) / 10,
      weapon: hit?.weapon ?? this._lastShot?.weapon ?? this.weapons?.current ?? null,
      time: Math.round(this.elapsed * 10) / 10,
      target,
      ...(clock ? { clock } : {}),
    };
  }

  /* --- Internals: radar, lure, extraction ------------------------------------------- */

  _radarPing() {
    const eco = this.world?.ecosystem;
    const hunter = this.hunter;
    if (!eco?.query || !hunter) return;
    const out = this._radarOut;
    out.length = 0;
    const p = hunter.position;
    const list = eco.query(p.x, p.z, RADAR_RANGE, this._radarFilter, out) || out;
    const blips = [];
    for (const c of list) {
      if (!this._radarFilter(c) || !c.position) continue;
      blips.push({ x: c.position.x, z: c.position.z, species: c.species?.id ?? "unknown" });
    }
    this.radar = { blips, time: this.elapsed };
    this._emit("radar", { blips });
  }

  _nearestSpecies() {
    const eco = this.world?.ecosystem;
    if (!eco?.query || !this.hunter) return null;
    const p = this.hunter.position;
    const out = this._radarOut;
    out.length = 0;
    const list = eco.query(p.x, p.z, 450, (c) => c && !c.isHunter && c.alive !== false, out) || out;
    let best = null;
    let bestD = Infinity;
    for (const c of list) {
      if (!c.position || c.isHunter) continue;
      const d = (c.position.x - p.x) ** 2 + (c.position.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c.species?.id ?? null;
      }
    }
    return best;
  }

  _chopperArrived() {
    if (!this.extraction) return;
    this.extraction.state = "landed";
    this.extraction.eta = 0;
    this.extraction.landedAt = this.elapsed;
    this._emit("extraction", { state: "landed", eta: 0 });
  }

  _updateExtraction() {
    const ex = this.extraction;
    const h = this.helicopter;
    if (!ex) return;
    if (ex.state === "called" || ex.state === "inbound") ex.eta = h ? Math.max(0, Math.round(h.eta)) : 0;
    if (ex.state === "called" && h && (h.phase === "approach" || h.eta <= INBOUND_ETA)) {
      ex.state = "inbound";
      this._emit("extraction", { state: "inbound", eta: ex.eta });
    }
    if (ex.state !== "landed" || this.hunterDead || !this.hunter) return;
    if (this.elapsed - (ex.landedAt ?? 0) < BOARD_DELAY) return;
    const p = this.hunter.position;
    const cx = h ? h.position.x : ex.x;
    const cz = h ? h.position.z : ex.z;
    if ((p.x - cx) ** 2 + (p.z - cz) ** 2 <= EXTRACT_RADIUS * EXTRACT_RADIUS) this.end("extracted");
  }

  /* --- Internals: landing zone & pickup point ---------------------------------------- */

  _touchdown() {
    const hunter = this.hunter;
    const h = this.helicopter;
    const t = this.world?.terrain;
    const lz = this.landingZone;
    if (hunter?.position) {
      let x = lz.x;
      let z = lz.z;
      let heading = hunter.heading ?? 0;
      if (h) {
        // Step out of the left door (model +X), clear of the skid, facing away from the chopper.
        const ox = Math.cos(h.yaw);
        const oz = -Math.sin(h.yaw);
        const px = h.position.x + ox * 3.4;
        const pz = h.position.z + oz * 3.4;
        const ok = !t || (!t.isWater?.(px, pz) && (t.slopeAt?.(px, pz) ?? 0) < 0.35 && (t.inBounds?.(px, pz, 5) ?? true));
        if (ok) {
          x = px;
          z = pz;
        }
        heading = h.yaw + Math.PI / 2;
      }
      hunter.position.set(x, t ? t.heightAt(x, z) : hunter.position.y, z);
      hunter.velocity?.set?.(0, 0, 0);
      hunter.heading = heading;
      if ("pitch" in hunter) hunter.pitch = 0;
    }
    this.riding = false;
    if (this.state === "dropoff") {
      this._setState("hunting");
      this._emit("notify", { text: "Touchdown. Good hunting.", kind: "info" });
    }
  }

  _parkHunter() {
    const p = this.hunter?.position;
    const lz = this.landingZone;
    if (!p || !lz) return;
    const t = this.world?.terrain;
    p.x = lz.x;
    p.z = lz.z;
    if (t) p.y = t.heightAt(lz.x, lz.z);
    this.hunter.velocity?.set?.(0, 0, 0);
  }

  _targetBiomes() {
    const set = new Set();
    for (const id of this.targets) {
      const list = SPECIES_DEFS?.[id]?.biomes || FALLBACK_BIOMES[id] || [];
      for (const b of list) set.add(b);
    }
    if (!set.size) ["plains", "forest"].forEach((b) => set.add(b));
    return set;
  }

  /** Trees (anything taller than a boulder) within r. */
  _treesNear(x, z, r) {
    const v = this.world?.vegetation;
    if (!v?.collidersNear) return 0;
    const out = this._colliders;
    out.length = 0;
    const list = v.collidersNear(x, z, r, out) || out;
    let n = 0;
    for (const c of list) {
      const h = c.height ?? c.h;
      if (h === undefined || h > 4) n++;
    }
    return n;
  }

  /** Worst slope under a ~10 m rotor footprint. */
  _footprintSlope(x, z) {
    const t = this.world?.terrain;
    if (!t?.slopeAt) return 0;
    let s = t.slopeAt(x, z);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      s = Math.max(s, t.slopeAt(x + Math.sin(a) * 5, z + Math.cos(a) * 5));
    }
    return s;
  }

  _clearRadius(x, z) {
    for (const r of [28, 20, 14]) if (this._treesNear(x, z, r) === 0) return r;
    return 8;
  }

  /**
   * A flat, dry, open spot on plains/highland, scored by how much target habitat
   * lies 200–400 m around it (where the hunt should happen) and how much of that
   * ring is land rather than sea.
   */
  _chooseLandingZone() {
    const w = this.world;
    const t = w?.terrain;
    const hp = this.hunter?.position;
    const fallback = { x: hp?.x ?? 0, z: hp?.z ?? 0, clearR: 14 };
    if (!t?.findSpawnPoint) return fallback;
    const rng = typeof w.rng === "function" ? w.rng : makeRng(hash("lz", Date.now()));
    const habitat = this._targetBiomes();
    let best = null;
    for (let i = 0; i < LZ_CANDIDATES; i++) {
      const p = t.findSpawnPoint(rng, { biomes: ["plains", "highland"], minHeight: 3, maxSlope: 0.08, tries: 80 });
      if (!p) continue;
      const s = this._scoreLandingZone(p.x, p.z, habitat);
      if (!best || s > best.score) best = { x: p.x, z: p.z, score: s };
    }
    if (!best) {
      const p = t.findSpawnPoint(rng, { minHeight: 2, maxSlope: 0.2, tries: 400 });
      if (p) best = p;
    }
    if (!best) return fallback;
    return { x: best.x, z: best.z, clearR: this._clearRadius(best.x, best.z) };
  }

  _scoreLandingZone(x, z, habitat) {
    const t = this.world.terrain;
    let s = -this._footprintSlope(x, z) * 200;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      if (t.isWater(x + Math.sin(a) * 15, z + Math.cos(a) * 15)) s -= 60;
      else if (t.isWater(x + Math.sin(a) * 35, z + Math.cos(a) * 35)) s -= 25;
    }
    s -= this._treesNear(x, z, 16) * 30;
    let hab = 0;
    let land = 0;
    let n = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      for (const r of LZ_HABITAT_RINGS) {
        const px = x + Math.sin(a) * r;
        const pz = z + Math.cos(a) * r;
        n++;
        if (t.inBounds(px, pz, 10) && !t.isWater(px, pz)) {
          land++;
          if (habitat.has(t.biomeAt(px, pz))) hab++;
        }
      }
    }
    return s + (hab / n) * 80 + (land / n) * 30;
  }

  /** The hunter's spot or the closest flat, dry, tree-free one within 30 m. */
  _findPickupPoint(x, z) {
    const t = this.world?.terrain;
    let best = null;
    const consider = (px, pz, r) => {
      if (t?.inBounds && !t.inBounds(px, pz, 20)) return;
      const wet = t ? t.heightAt(px, pz) < (t.seaLevel ?? 0) + 0.2 : false;
      const slope = this._footprintSlope(px, pz);
      const trees = this._treesNear(px, pz, LOW_HOVER_CLEAR);
      const score = -r * 0.6 - slope * 120 - (wet ? 30 : 0) - trees * 40;
      if (!best || score > best.score) best = { x: px, z: pz, score, slope, trees, wet };
    };
    consider(x, z, 0);
    for (let ring = 1; ring <= 6; ring++) {
      const r = ring * 5;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU + ring * 0.4;
        consider(x + Math.sin(a) * r, z + Math.cos(a) * r, r);
      }
    }
    if (!best) best = { x, z, slope: 0, trees: 0, wet: false };
    const clear = best.trees === 0 && best.slope < 0.2;
    return {
      x: best.x,
      z: best.z,
      hover: clear ? 2.6 : best.trees > 0 ? CANOPY_HOVER : 3.4,
      clearR: clear ? this._clearRadius(best.x, best.z) : 6,
    };
  }

  _releaseHelicopter() {
    const h = this.helicopter;
    if (!h) return;
    if (this.world && this.world.helicopter === h) this.world.helicopter = null;
    h.dispose();
    this.helicopter = null;
  }
}
