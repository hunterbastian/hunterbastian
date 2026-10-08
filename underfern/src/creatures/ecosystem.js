// Ecosystem — owns every creature and carcass on the island. It spawns single
// animals, herds and packs, keeps a living population in a ring around the
// focus point (player or menu camera), runs the brains and creature updates,
// and turns the dead into carcasses that darken, sink and rot as they're eaten.
//
// Balance goals: the island should never feel empty, herbivores outnumber
// predators, and a freshly hatched juvenile gets a quiet first minute.

import * as THREE from "three";
import { Creature } from "./creature.js";
import { SPECIES, getSpecies } from "./species.js";
import { Brain } from "./ai.js";
import { GAME, WORLD } from "../config.js";
import { makeRng, hash, rand, randInt } from "../core/rng.js";
import { dist2, smoothstep, TAU } from "../core/math.js";

/* --- Tuning ------------------------------------------------------------- */

const UPKEEP_INTERVAL = 1.4; // seconds between population passes
const MAX_SPAWNS_PER_TICK = 2; // spawn calls (single animals or whole groups) per pass
const MAX_CARCASSES = 14; // beyond this the oldest start to rot away early
const CARCASS_ANIM_TIME = 5; // seconds the death pose keeps animating before the model freezes
const CARCASS_FADE_TIME = 4; // seconds a spent carcass takes to sink out of sight
const CARNIVORE_SHARE = 0.4; // predators never exceed this share of the NPC cap
// Share of the cap herbivores may not take, so predators can still arrive once a
// fresh player's safe minute is over (otherwise herds fill every slot first).
const CARNIVORE_RESERVE = 0.2;
const JUVENILE_SAFE_RADIUS = 150; // no big carnivores this close to a fresh juvenile player…
const JUVENILE_SAFE_TIME = 60; // …during its first minute
const PLAYER_CLEARANCE = 45; // NPCs never pop into existence closer than this to the player
const POPULATE_MIN_R = 50; // the initial population may stand closer than the upkeep ring
const OFF_BIOME_WEIGHT = 0.2; // spawn weight outside a species' preferred biomes
const ANIM_LOD_NEAR = 75; // full-rate animation inside this distance from the focus
const ANIM_LOD_MID = 170; // half-rate inside this, third-rate beyond
const ROT_COLOR = new THREE.Color(0x2a2119);

/* --- Ecosystem ----------------------------------------------------------- */

export class Ecosystem {
  /**
   * @param {object} world World (scene, terrain, vegetation, events, …)
   * @param {{ seed?: number, npcCap?: number }} opts
   */
  constructor(world, { seed = WORLD.seed, npcCap = GAME.npcCap } = {}) {
    this.world = world;
    this.seed = seed >>> 0;
    this.rng = makeRng(hash(this.seed, "ecosystem"));
    this.npcCap = Math.max(0, Math.round(npcCap ?? GAME.npcCap));
    /** Alive creatures, including the player. */
    this.creatures = [];
    /** { id, species, speciesId, x, y, z, heading, meat, maxMeat, age, scale, model, radius, … } */
    this.carcasses = [];
    /** Herds / packs: { id, species, members: Creature[], leader }. */
    this.groups = [];
    this.player = null;
    /** Largest creature radius present — lets collision queries stay tight. */
    this.maxRadius = 1;
    /** True once the area around the focus has been given its initial population. */
    this.populated = false;

    this._spawnable = Object.values(SPECIES).filter((s) => s && (s.spawnWeight ?? 0) > 0);
    this._weights = new Float64Array(this._spawnable.length);
    this._focus = { x: 0, z: 0 };
    this._lastFocusX = NaN;
    this._lastFocusZ = NaN;
    this._upkeepTimer = 0;
    this._playerTime = 0;
    this._spawnSerial = 0;
    this._groupSerial = 0;
    this._carcassSerial = 0;
    this._brainErrors = 0;
    this._spawnErrors = 0;
  }

  /* --- Spawning ---------------------------------------------------------- */

  /**
   * Create a creature, give NPCs a Brain, add its model to the scene and emit
   * "spawn". `isPlayer: true` also makes it the ecosystem's player.
   * @returns {Creature}
   */
  spawn(speciesId, x, z, { growth = 1, heading = 0, isPlayer = false, group = null } = {}) {
    const species = typeof speciesId === "string" ? getSpecies(speciesId) : speciesId;
    const seed = hash(this.seed, "creature", this._spawnSerial++);
    const c = new Creature(this.world, { species, growth, x, z, heading, isPlayer, seed });
    if (group) {
      c.group = group;
      if (!group.members.includes(c)) group.members.push(c);
      if (!group.leader || !group.leader.alive) group.leader = c;
    }
    if (!isPlayer) {
      try {
        c.brain = new Brain(c, this.world, makeRng(hash(seed, "brain")), group);
      } catch (err) {
        console.error(`[ecosystem] Brain for ${species.id} failed to construct`, err);
        c.brain = null;
      }
    }
    this.creatures.push(c);
    this.maxRadius = Math.max(this.maxRadius, c.radius);
    if (c.model && c.model.object && this.world.scene) this.world.scene.add(c.model.object);
    this.world.events?.emit("spawn", { creature: c });
    if (isPlayer) this.setPlayer(c);
    return c;
  }

  /**
   * Spawn a herd / pack around (x, z) sharing one group object. Without an
   * explicit growth the members are mostly grown, with the odd juvenile.
   * @returns {Creature[]}
   */
  spawnGroup(speciesId, x, z, count, { growth } = {}) {
    const species = typeof speciesId === "string" ? getSpecies(speciesId) : speciesId;
    const n = Math.max(1, count | 0);
    const group = { id: ++this._groupSerial, species: species.id, members: [], leader: null };
    this.groups.push(group);
    const rng = this.rng;
    const heading = rng() * TAU;
    const spacing = Math.max(2.5, species.length * 0.6);
    for (let i = 0; i < n; i++) {
      let px = x;
      let pz = z;
      if (i > 0) {
        for (let tries = 0; tries < 8; tries++) {
          const a = rng() * TAU;
          const d = spacing * (0.6 + rng() * 0.8) * Math.sqrt(i);
          const cx = x + Math.sin(a) * d;
          const cz = z + Math.cos(a) * d;
          if (this._validGround(cx, cz)) {
            px = cx;
            pz = cz;
            break;
          }
        }
      }
      const g = growth ?? this._npcGrowth(i === 0);
      this.spawn(species.id, px, pz, { growth: g, heading: heading + rand(rng, -0.6, 0.6), group });
    }
    this._electLeader(group);
    return group.members.slice();
  }

  /**
   * Remove a creature from the world: leaves its group, model out of the
   * scene and disposed. A despawned NPC is flagged `alive = false` so brains
   * holding it as a target let go.
   */
  remove(creature) {
    const c = creature;
    if (!c) return;
    const i = this.creatures.indexOf(c);
    if (i >= 0) this.creatures.splice(i, 1);
    this._leaveGroup(c);
    if (c.brain && typeof c.brain.dispose === "function") {
      try {
        c.brain.dispose();
      } catch (err) {
        console.error("[ecosystem] brain.dispose failed", err);
      }
    }
    c.despawned = true;
    if (c.alive) c.alive = false;
    if (!c._carcass && c.model && c.model.object && c.model.object.parent) {
      c.model.object.parent.remove(c.model.object);
    }
    if (typeof c.dispose === "function") c.dispose();
    if (this.player === c) this.player = null;
  }

  /**
   * Make the dinosaur `actor` the player. A fresh juvenile gets predators
   * cleared from around it.
   */
  setPlayer(actor) {
    if (!actor) {
      this.clearPlayer();
      return;
    }
    if (this.player === actor) return;
    if (this.player) this.clearPlayer();
    this.player = actor;
    if (!actor.isPlayer) actor.isPlayer = true;
    if (actor.brain) {
      if (typeof actor.brain.dispose === "function") actor.brain.dispose();
      actor.brain = null;
    }
    this._leaveGroup(actor);
    if (actor.alive !== false && !this.creatures.includes(actor)) this.creatures.push(actor);
    if (actor.model && actor.model.object && !actor.model.object.parent && this.world.scene) {
      this.world.scene.add(actor.model.object);
    }
    if (typeof actor.radius === "number") this.maxRadius = Math.max(this.maxRadius, actor.radius);
    this._playerTime = 0;
    this._clearThreatsNear(actor);
  }

  /**
   * Forget the player. A living player is removed from the world; a dead one
   * already lies there as a carcass.
   */
  clearPlayer() {
    const p = this.player;
    if (!p) return;
    this.player = null;
    if (p.alive) this.remove(p);
  }

  /* --- Per-frame --------------------------------------------------------- */

  /**
   * Population upkeep around `focus` (throttled), brains → creature updates,
   * deaths → carcasses, carcass rot.
   * @param {number} dt seconds
   * @param {{x:number,z:number}|THREE.Vector3|{position:THREE.Vector3}|null} focus
   */
  update(dt, focus) {
    if (!(dt > 0)) return;
    const f = this._resolveFocus(focus);
    this._playerTime += dt;

    // A big jump of the focus (menu → spawn point, new game, teleport) would
    // leave the new area empty for a while: drop the old area, repopulate.
    if (this.populated && Number.isFinite(this._lastFocusX)) {
      const jump = GAME.npcSpawnMax;
      if (dist2(f.x, f.z, this._lastFocusX, this._lastFocusZ) > jump * jump) {
        this._despawnFar(f);
        this.populated = false;
      }
    }
    this._lastFocusX = f.x;
    this._lastFocusZ = f.z;
    if (!this.populated) {
      this.populate(f);
      this._upkeepTimer = UPKEEP_INTERVAL;
    }
    this._upkeepTimer -= dt;
    if (this._upkeepTimer <= 0) {
      this._upkeepTimer = UPKEEP_INTERVAL;
      this._upkeep(f);
    }

    const list = this.creatures;
    // Brains first so every creature moves on this frame's intent.
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive || !c.brain) continue;
      try {
        c.brain.update(dt);
      } catch (err) {
        if (this._brainErrors++ < 3) console.error(`[ecosystem] brain update failed (${c.species?.id})`, err);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      if (c.model && !c.isPlayer) {
        const d2 = dist2(f.x, f.z, c.position.x, c.position.z);
        c.animLod = d2 < ANIM_LOD_NEAR * ANIM_LOD_NEAR ? 1 : d2 < ANIM_LOD_MID * ANIM_LOD_MID ? 2 : 3;
      }
      c.update(dt);
    }
    // Deaths this frame (from bites, bleeding, starvation, …) become carcasses.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.alive) continue;
      list.splice(i, 1);
      this._leaveGroup(c);
      if (c.brain && typeof c.brain.dispose === "function") c.brain.dispose();
      c.brain = null;
      this._toCarcass(c);
    }
    this._updateCarcasses(dt);
  }

  /**
   * Fill the area around `focus` up to the NPC cap at once, starting with a
   * herbivore herd in plain view so the world feels alive immediately.
   * Called automatically on the first update and after a big focus jump.
   */
  populate(focus) {
    const f = this._resolveFocus(focus);
    this.populated = true;
    let npcs = this._npcCount();
    for (let tries = 0; tries < 6 && npcs < this.npcCap; tries++) {
      const n = this._safeSpawnAt(f, 55, 115, this.npcCap - npcs, "herbivore");
      npcs += n;
      if (n > 0) break;
    }
    let guard = 0;
    while (npcs < this.npcCap && guard++ < this.npcCap * 4) {
      npcs += this._safeSpawnAt(f, POPULATE_MIN_R, GAME.npcSpawnMax, this.npcCap - npcs, null);
    }
  }

  /* --- Queries ------------------------------------------------------------ */

  /**
   * Alive creatures (player included) within `radius` of (x, z).
   * Clears and fills `out`.
   * @returns {Creature[]}
   */
  query(x, z, radius, filter = null, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    const list = this.creatures;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      const dx = c.position.x - x;
      const dz = c.position.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (filter && !filter(c)) continue;
      out.push(c);
    }
    return out;
  }

  /** Nearest carcass with at least `minMeat` kg within `radius`, or null. */
  nearestCarcass(x, z, radius, minMeat = 0.5) {
    let best = null;
    let bestD = radius * radius;
    const list = this.carcasses;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.fading || k.meat < minMeat) continue;
      const d = dist2(x, z, k.x, k.z);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /** Tear `amount` kg off a carcass. @returns {number} kg actually removed */
  eatCarcass(carcass, amount) {
    if (!carcass || carcass.fading || !(amount > 0)) return 0;
    const removed = Math.min(amount, carcass.meat);
    carcass.meat -= removed;
    return removed;
  }

  /** Remove every NPC and carcass (new game). The player is kept. */
  clear() {
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (this._isPlayerActor(c)) continue;
      this.remove(c);
    }
    for (let i = this.carcasses.length - 1; i >= 0; i--) this._removeCarcass(i);
    this.groups = this.groups.filter((g) => g.members.length > 0);
    this.populated = false;
    this._upkeepTimer = 0;
  }

  /* --- Population internals ------------------------------------------------ */

  _resolveFocus(focus) {
    const f = this._focus;
    const p = focus && focus.position ? focus.position : focus;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      f.x = p.x;
      f.z = p.z;
    } else if (this.player && this.player.position) {
      f.x = this.player.position.x;
      f.z = this.player.position.z;
    }
    return f;
  }

  _upkeep(f) {
    // Despawn what wandered (or was left) far behind.
    this._despawnFar(f);
    let radius = 1;
    for (let i = 0; i < this.creatures.length; i++) radius = Math.max(radius, this.creatures[i].radius || 0);
    this.maxRadius = radius;

    // Too many carcasses: let the oldest one start rotting away.
    let active = 0;
    let oldest = null;
    for (let i = 0; i < this.carcasses.length; i++) {
      const k = this.carcasses[i];
      if (k.fading) continue;
      active++;
      if (!k.isPlayer && (!oldest || k.age > oldest.age)) oldest = k;
    }
    if (active > MAX_CARCASSES && oldest) oldest.fading = 1e-6;

    // Top up the population in the ring around the focus.
    let npcs = this._npcCount();
    for (let spawned = 0; npcs < this.npcCap && spawned < MAX_SPAWNS_PER_TICK; spawned++) {
      const n = this._safeSpawnAt(f, GAME.npcSpawnMin, GAME.npcSpawnMax, this.npcCap - npcs, null);
      if (n <= 0) break;
      npcs += n;
    }
  }

  _despawnFar(f) {
    const far = GAME.npcDespawn;
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (this._isPlayerActor(c)) continue;
      if (dist2(f.x, f.z, c.position.x, c.position.z) > far * far && !this._engagedWithPlayer(c)) this.remove(c);
    }
    const carcFar = far * 1.25;
    for (let i = this.carcasses.length - 1; i >= 0; i--) {
      const k = this.carcasses[i];
      if (!k.isPlayer && dist2(f.x, f.z, k.x, k.z) > carcFar * carcFar) this._removeCarcass(i);
    }
  }

  // Never despawn something that's in a fight with (or chasing) the player.
  _engagedWithPlayer(c) {
    const p = this.player;
    if (!p || !p.alive) return false;
    if (c.brain && c.brain.target === p) return true;
    if (c.lastAttacker === p && c.age - c.lastDamageTime < 30) return true;
    if (p.lastAttacker === c && p.age - p.lastDamageTime < 30) return true;
    return false;
  }

  // Automatic spawns run inside the frame loop: a species whose model fails to
  // build must not take the whole game down, so log (a few times) and move on.
  // Explicit spawn() calls (the player) still throw to their caller.
  _safeSpawnAt(f, minR, maxR, room, diet) {
    try {
      return this._spawnAt(f, minR, maxR, room, diet);
    } catch (err) {
      if (this._spawnErrors++ < 3) console.error("[ecosystem] automatic spawn failed", err);
      return 0;
    }
  }

  // Spawn one animal or one group on dry land in the ring [minR, maxR] around f.
  // Returns how many creatures were created.
  _spawnAt(f, minR, maxR, room, diet) {
    const terrain = this.world.terrain;
    if (!terrain || room <= 0 || !this._spawnable.length) return 0;
    const pt = terrain.findSpawnPoint(this.rng, {
      minHeight: 0.8,
      maxSlope: 0.3,
      near: { x: f.x, z: f.z, minR, maxR },
      tries: 40,
    });
    if (!pt) return 0;
    const p = this._livePlayer();
    const dP = p ? Math.sqrt(dist2(pt.x, pt.z, p.position.x, p.position.z)) : Infinity;
    if (dP < PLAYER_CLEARANCE) return 0;
    const species = this._pickSpecies(terrain.biomeAt(pt.x, pt.z), dP, diet, pt);
    if (!species) return 0;

    const social = species.social || "solo";
    const [gMin = 1, gMax = gMin] = species.groupSize || [];
    let size = social === "solo" ? 1 : randInt(this.rng, Math.max(1, gMin), Math.max(1, gMin, gMax));
    // A loner now and then turns up as a pair (sometimes a parent and its young).
    if (social === "solo" && species.pairChance > 0 && this.rng() < species.pairChance) size = 2;
    size = Math.min(size, room);
    if (species.maxAlive != null) size = Math.min(size, species.maxAlive - this._npcCountOf(species.id));
    if (size < 1) return 0;
    if (size === 1) {
      this.spawn(species.id, pt.x, pt.z, { growth: this._npcGrowth(true), heading: this.rng() * TAU });
      return 1;
    }
    return this.spawnGroup(species.id, pt.x, pt.z, size).length;
  }

  // spawnWeight × biome (and, for water lovers, shore) preference, minus
  // predators the balance rules don't allow right now and rare species that
  // are already about.
  _pickSpecies(biome, distToPlayer, diet, pt = null) {
    const list = this._spawnable;
    const w = this._weights;
    const p = this._livePlayer();
    const safeR = this._safeRadius();
    const carnivores = this._carnivoreCount();
    const herbivores = this._npcCount() - carnivores;
    const carnFull = carnivores >= Math.max(1, Math.ceil(this.npcCap * CARNIVORE_SHARE));
    const reserve = this.npcCap >= 5 ? Math.round(this.npcCap * CARNIVORE_RESERVE) : 0;
    const herbFull = herbivores >= this.npcCap - reserve;
    let wet = null; // is the spawn point on the shore or by fresh water? (asked once, if needed)
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let wgt = s.spawnWeight;
      if (diet && s.diet !== diet) wgt = 0;
      if (s.biomes && s.biomes.length && !s.biomes.includes(biome)) wgt *= OFF_BIOME_WEIGHT;
      if (s.waterAffinity > 0 && pt && wgt > 0) {
        if (wet === null) wet = biome === "beach" || !!this.world.terrain?.nearestFreshWater?.(pt.x, pt.z, 60);
        wgt *= wet ? 1 + 2.5 * s.waterAffinity : 1 - 0.8 * s.waterAffinity;
      }
      if (s.maxAlive != null && wgt > 0 && this._npcCountOf(s.id) >= s.maxAlive) wgt = 0; // rare: never more at once
      if (s.diet !== "carnivore" && herbFull) wgt = 0;
      if (s.diet === "carnivore") {
        if (carnFull) wgt = 0;
        // Group members spread out a little, hence the margin.
        else if (safeR > 0 && distToPlayer < safeR + 40 && this._threatens(s, p)) wgt = 0;
      }
      w[i] = wgt > 0 && Number.isFinite(wgt) ? wgt : 0;
      total += w[i];
    }
    if (total <= 0) return null;
    let r = this.rng() * total;
    let last = null;
    for (let i = 0; i < list.length; i++) {
      if (w[i] <= 0) continue;
      last = list[i];
      r -= w[i];
      if (r <= 0) return last;
    }
    return last;
  }

  // NPC growth: mostly grown (45 % full adults), juveniles only tag along in groups.
  _npcGrowth(isLeader) {
    const rng = this.rng;
    if (!isLeader && rng() < 0.22) return rand(rng, 0.12, 0.38);
    if (rng() < 0.45) return 1;
    return rand(rng, 0.55, 0.98);
  }

  _electLeader(group) {
    let leader = null;
    for (const m of group.members) {
      if (m.alive && (!leader || m.growth > leader.growth)) leader = m;
    }
    group.leader = leader;
  }

  _leaveGroup(c) {
    const g = c.group;
    if (!g) return;
    c.group = null;
    const i = g.members.indexOf(c);
    if (i >= 0) g.members.splice(i, 1);
    if (g.leader === c) this._electLeader(g);
    if (!g.members.length) {
      const gi = this.groups.indexOf(g);
      if (gi >= 0) this.groups.splice(gi, 1);
    }
  }

  _validGround(x, z) {
    const t = this.world.terrain;
    return (
      t.inBounds(x, z, 40) && t.heightAt(x, z) - (t.seaLevel ?? 0) >= 0.6 && t.slopeAt(x, z) <= 0.4
    );
  }

  _isPlayerActor(c) {
    return c === this.player || !!c.isPlayer;
  }

  _npcCount() {
    let n = 0;
    for (let i = 0; i < this.creatures.length; i++) if (!this._isPlayerActor(this.creatures[i])) n++;
    return n;
  }

  // Living NPCs of one species (a player of that species doesn't count).
  _npcCountOf(id) {
    let n = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (!this._isPlayerActor(c) && c.species && c.species.id === id) n++;
    }
    return n;
  }

  _carnivoreCount() {
    let n = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (!this._isPlayerActor(c) && c.species && c.species.diet === "carnivore") n++;
    }
    return n;
  }

  _livePlayer() {
    const p = this.player;
    return p && p.alive && p.position ? p : null;
  }

  // Protection radius around a fresh player (0 when none applies).
  _safeRadius() {
    const p = this._livePlayer();
    if (!p) return 0;
    return p.growth < 0.4 && this._playerTime < JUVENILE_SAFE_TIME ? JUVENILE_SAFE_RADIUS : 0;
  }

  // Would an (adult) member of this species be a serious threat to the player?
  _threatens(species, p) {
    if (!p || species.diet !== "carnivore") return false;
    return species.mass > Math.max(60, 3 * (p.mass || 1));
  }

  // A fresh juvenile appears: predators already standing nearby leave
  // (this happens before the first frame of play is drawn).
  _clearThreatsNear(p) {
    const r = this._safeRadius();
    if (r <= 0) return;
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (this._isPlayerActor(c) || c.species.diet !== "carnivore") continue;
      if (c.mass <= Math.max(60, 3 * (p.mass || 1))) continue;
      if (dist2(c.position.x, c.position.z, p.position.x, p.position.z) < r * r) this.remove(c);
    }
  }

  /* --- Carcasses --------------------------------------------------------- */

  _toCarcass(c) {
    if (!c.model || c._carcass) return null;
    const s = c.scale;
    const meat = c.mass * 0.5;
    const carcass = {
      id: ++this._carcassSerial,
      species: c.species,
      speciesId: c.species.id,
      x: c.position.x,
      y: c.position.y,
      z: c.position.z,
      heading: c.heading,
      meat,
      maxMeat: meat,
      age: 0,
      scale: s,
      model: c.model,
      /** Body radius (m) for reach tests — the torso is much bigger than the collision circle's hips. */
      radius: Math.max(0.5, c.species.length * 0.3 * s),
      creature: c,
      isPlayer: !!c.isPlayer,
      cause: c.causeOfDeath,
      fading: 0,
      baseY: c.position.y, // settled ground height under the body; y = baseY − sink
      _eaten: 0, // stripped fraction frozen when it starts to fade
      _tint: -1,
    };
    c._carcass = carcass;
    this.carcasses.push(carcass);
    return carcass;
  }

  _updateCarcasses(dt) {
    const life = GAME.carcassLifetime;
    for (let i = this.carcasses.length - 1; i >= 0; i--) {
      const k = this.carcasses[i];
      k.age += dt;
      const c = k.creature;
      // Let the death pose play out and the body settle, then freeze the model.
      if (c && k.age < CARCASS_ANIM_TIME) {
        c.update(dt);
        k.x = c.position.x;
        k.z = c.position.z;
        k.baseY = c.position.y;
      }
      if (!k.fading && (k.meat < 0.5 || k.age > life)) {
        // Spent or rotten: nothing left worth eating (code reading `carcasses`
        // directly sees meat 0), keep its look and let it slip away.
        k._eaten = k.maxMeat > 0 ? 1 - k.meat / k.maxMeat : 1;
        k.meat = 0;
        k.fading = 1e-6;
      }
      if (k.fading) {
        k.fading += dt / CARCASS_FADE_TIME;
        if (k.fading >= 1) {
          this._removeCarcass(i);
          continue;
        }
      }
      const m = k.model;
      if (!m || !m.object) continue;
      // Sinks a little as it's stripped and as it rots; a spent carcass slips
      // under the ground instead of popping out of existence.
      const hip = k.species.height * k.scale;
      const eaten = k.fading ? k._eaten : k.maxMeat > 0 ? 1 - k.meat / k.maxMeat : 1;
      const ageF = Math.min(1, k.age / life);
      const sink = hip * (0.16 * eaten + 0.08 * ageF + 1.1 * smoothstep(0, 1, k.fading));
      k.y = k.baseY - sink;
      m.object.position.y = k.y;
      const tint = Math.min(0.85, 0.12 + 0.45 * eaten + 0.35 * ageF);
      if (Math.abs(tint - k._tint) > 0.01 && typeof m.setTint === "function") {
        k._tint = tint;
        m.setTint(ROT_COLOR, tint);
      }
    }
  }

  _removeCarcass(i) {
    const k = this.carcasses[i];
    this.carcasses.splice(i, 1);
    const m = k.model;
    if (m) {
      if (m.object && m.object.parent) m.object.parent.remove(m.object);
      m.dispose();
    }
    k.model = null;
    k.meat = 0;
    k.fading = 1;
  }
}
