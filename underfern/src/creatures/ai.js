// NPC brains. Each Brain is a utility-scored state machine for one creature:
//   senses  — sight / hearing / smell, staggered at ~4 Hz per brain (offset by id)
//   decide  — prioritised needs with hysteresis (fight > flee > drink > sleep > herd > graze/roam)
//   act     — per-frame behaviour for the current state (stalk, chase, graze, drink, …)
//   steer   — feelers (deep water, steep ground, island edge, tree trunks) + unstick
// Brains only ever READ the documented world / creature fields and WRITE
// `creature.intent` (plus the optional `creature.lookTarget` for head turns), so
// the same code drives every NPC.

import { clamp, lerp, smoothstep, angleDiff, yawFromDir, dist2 } from "../core/math.js";
import { rand } from "../core/rng.js";

/* --- Tuning ------------------------------------------------------------- */

const SENSE_INTERVAL = 0.25; // s — perception + decision tick (~4 Hz)
const STEER_INTERVAL = 0.1; // s — feeler probes (~10 Hz)
const MAX_QUERY = 240; // m — widest ecosystem query a brain makes
const EDGE_MARGIN = 60; // m — stay this far inside the island tile
// terrain.slopeAt is 1 − normal.y: 0.22 ≈ 39°, 0.3 ≈ 46°. Creatures stall near
// 52°, so brains treat anything past ~46° (or a 1:1 rise/drop along a feeler)
// as a wall and keep the 30–40° plains banks walkable.
const SLOPE_SOFT = 0.22;
const SLOPE_HARD = 0.3;
const GRADE_HARD = 1; // rise (or drop) per metre along a feeler
const HEAR_RANGE = 60; // m at noise 1
const SMELL_MUL = 1.4; // smell range = perception × this × scent × wind factor
const MEMORY_TIME = 6; // s a lost threat / quarry stays "known" at its last position
const CALL_ANSWER_RANGE = 250;
const CALL_ALERT_RANGE = 100;
const SPAWN_GRACE = 45; // s a freshly spawned player is not hunted (unless provoked)
const JUVENILE = 0.4; // growth below this is a juvenile
const ALERT_DECAY = 0.04; // per second

// Intent magnitudes: ≤ 0.5 walks, 1 trots, the sprint flag sprints.
const AMBLE = 0.28;
const WALK = 0.45;
const JOG = 0.8;
const TROT = 1;

const DEFENDERS = new Set(["stegosaurus", "gastonia", "diplodocus", "brontosaurus"]);

// Hunting style per carnivore: chase = distance at which a stalk turns into a
// sprint, crouch = distance inside which it creeps, callP = chance of a roar
// when a hunt begins, chaseTime = seconds before a chase is abandoned.
const HUNT_STYLE = {
  utahraptor: { chase: 38, crouch: 55, callP: 0.55, chaseTime: 22, ambush: false },
  ceratosaurus: { chase: 22, crouch: 60, callP: 0.4, chaseTime: 14, ambush: true },
  allosaurus: { chase: 30, crouch: 50, callP: 0.8, chaseTime: 17, ambush: false },
};
const DEFAULT_STYLE = { chase: 30, crouch: 50, callP: 0.5, chaseTime: 16, ambush: false };

// Feeler fan, relative to the desired direction (radians). The first three are
// the probe triple; the rest widen the search once the way ahead is blocked.
const FEELERS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.6, -2.6, Math.PI];

/* --- Scratch (no per-frame allocation) ---------------------------------- */

const _near = [];
const _cols = [];
const EMPTY = [];

/* --- Helpers ------------------------------------------------------------ */

const num = (v, d) => (Number.isFinite(v) ? v : d);

function massOf(o) {
  if (!o) return 100;
  const m = o.mass;
  if (Number.isFinite(m)) return m;
  return num(o.species && o.species.mass, 100);
}

function hipOf(o) {
  const sp = o && o.species;
  return num(sp && sp.height, 1) * num(o && o.scale, 1);
}

const radiusOf = (o) => num(o && o.radius, 0.5);

// Plain coordinates for Creatures (position), Carcasses / plants / points (x, z).
const xOf = (o) => (o.position ? o.position.x : o.x);
const zOf = (o) => (o.position ? o.position.z : o.z);

function aliveMembers(g) {
  const m = g && g.members;
  if (!m) return 1;
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] && m[i].alive) n++;
  return Math.max(1, n);
}

// Herd mates of `o` (excluding itself) within `r` metres of it.
function matesNear(o, r) {
  const m = o.group && o.group.members;
  if (!m) return 0;
  const ox = o.position.x;
  const oz = o.position.z;
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    const k = m[i];
    if (k === o || !k || !k.alive || !k.position) continue;
    if (dist2(ox, oz, k.position.x, k.position.z) < r * r) n++;
  }
  return n;
}

// How far one sees into a biome (forest and swamp hide things).
function coverOf(biome) {
  if (biome === "forest") return 0.55;
  if (biome === "swamp") return 0.8;
  return 1;
}

/* --- Group memory (shared by a herd / pack, kept off the ecosystem's object) */

const GROUPS = new WeakMap();

function groupMemo(g) {
  let m = GROUPS.get(g);
  if (!m) {
    m = {
      target: null, // pack quarry
      targetT: -1e9,
      seenT: -1e9, // last time any member sensed the quarry
      seenX: 0,
      seenZ: 0,
      alarmT: -1e9, // herd panic
      alarmX: 0,
      alarmZ: 0,
      alarmFrom: null,
    };
    GROUPS.set(g, m);
  }
  return m;
}

/* --- Event fan-out -------------------------------------------------------- */
// One listener per event per bus dispatches to every registered brain, instead
// of 40 brains × 4 subscriptions. Handlers only set fields; decisions happen
// in the brains' own update.

const REGISTRY = new WeakMap(); // EventBus → { brains, offs, lastCall }

function attach(brain) {
  const bus = brain.world && brain.world.events;
  if (!bus || typeof bus.on !== "function") return;
  let reg = REGISTRY.get(bus);
  if (!reg) {
    reg = { brains: [], offs: [], lastCall: Object.create(null) };
    const fanOut = (method) => (e) => {
      if (!e) return;
      const list = reg.brains;
      for (let i = 0; i < list.length; i++) list[i][method](e);
    };
    const sub = (name, fn) => {
      const off = bus.on(name, fn);
      reg.offs.push(typeof off === "function" ? off : () => bus.off && bus.off(name, fn));
    };
    sub("call", fanOut("_hearCall"));
    sub("damage", (e) => {
      const b = e && e.target && e.target.brain;
      if (b && b._reg === reg) b._onDamage(e);
    });
    REGISTRY.set(bus, reg);
  }
  reg.brains.push(brain);
  brain._reg = reg;
  brain._bus = bus;
}

function detach(brain) {
  const reg = brain._reg;
  if (!reg) return;
  const i = reg.brains.indexOf(brain);
  if (i >= 0) reg.brains.splice(i, 1);
  if (!reg.brains.length) {
    for (const off of reg.offs) off();
    REGISTRY.delete(brain._bus);
  }
  brain._reg = null;
  brain._bus = null;
}

/* --- Brain ---------------------------------------------------------------- */

export class Brain {
  /**
   * @param {object} creature the Creature to drive
   * @param {object} world World — terrain, vegetation, ecosystem, sky, wind (may be null), events
   * @param {() => number} rng seeded random in [0, 1)
   * @param {{ id, species, members: object[], leader: object } | null} group herd / pack shared with mates
   */
  constructor(creature, world, rng, group = null) {
    this.creature = creature;
    this.world = world;
    this.rng = typeof rng === "function" ? rng : Math.random;
    this.group = group || creature.group || null;

    /** "idle" | "wander" | "graze" | "drink" | "flee" | "hunt" | "attack" | "eat" | "rest" | "follow" | "investigate" */
    this.state = "idle";
    /** Creature | Carcass | FoodPlant | { x, z } | null */
    this.target = null;
    /** Finer phase within the state: "stalk" | "chase" | "bite" | "defend" | "guard" | "retreat" | "yield" | "wary" | "search" | "" */
    this.mode = "";
    /** 0..1 nervousness: sharper senses, more glances, wider flight distance. */
    this.alert = 0;
    /** 0..1 how close this animal is to noticing the player — its stealth meter. */
    this.awareness = 0;

    const sp = creature.species || {};
    this._carn = sp.diet === "carnivore";
    this._style = HUNT_STYLE[sp.id] || DEFAULT_STYLE;
    this._defender = DEFENDERS.has(sp.id);
    this._tail = sp.attack === "tail";
    this._fovCos = this._carn ? -0.35 : -0.85; // ~220° vs ~300° field of view
    this._swimmer = num(sp.swim, 0) >= 0.7;
    this._small = num(sp.mass, 500) < 150;
    this._aggr = clamp(num(sp.aggression, 0.3), 0, 1);
    this._walkSpeed = num(sp.speed && sp.speed.walk, 1.5);

    // Stagger the ~4 Hz thinking so a crowd doesn't all think on one frame.
    const id = Number(creature.id) || Math.floor(this.rng() * 1000);
    this._senseT = ((id * 0.618034) % 1) * SENSE_INTERVAL;
    this._steerT = ((id * 0.381966) % 1) * STEER_INTERVAL;
    this._clock = 0;
    this._now = 0;
    this._stateT = 0;
    this._restBias = this.rng() * 0.1; // individuals lie down / wake at slightly different times

    // Perception results.
    this._daylight = 1;
    this._night = false;
    this._sightRange = num(sp.perception, 80);
    this._coverMul = 1;
    this._threat = null;
    this._threatT = -1e9;
    this._threatX = 0;
    this._threatZ = 0;
    this._threatD = 1e9;
    this._threatDanger = 0;
    this._prey = null;
    this._preyScore = 0;
    this._preyBestD = 1e9;
    this._preyT = -1e9; // last time the current quarry was sensed
    this._preyX = 0;
    this._preyZ = 0;
    this._preyD = 1e9;
    this._rival = null;
    this._herdN = 0;
    this._herdCX = 0;
    this._herdCZ = 0;
    this._sepX = 0;
    this._sepZ = 0;
    this._mateFleeN = 0;
    this._mateFleeX = 0;
    this._mateFleeZ = 0;
    this._leaderD = 0;
    this._herdR = 10;
    this._herdFood = 100;

    // Memory of events.
    this._attacker = null;
    this._attackedAt = -1e9;
    this._defendRoll = 1;
    this._side = this.rng() < 0.5 ? -1 : 1; // ±1: the way it favours when circling or swinging
    this._ignoreObj = null;
    this._ignoreUntil = -1e9;
    this._oppPrey = null;
    this._oppUntil = -1e9;
    this._oppYes = false;
    this._tiredUntil = -1e9;
    this._restUntil = -1e9;
    this._guardUntil = 0;
    this._guardCarcass = null;
    this._noWaterUntil = -1e9;
    this._lastAnswerAt = -1e9;
    this._lastCallAt = -1e9;
    this._callAt = 0;
    this._callIsAnswer = false;
    this._answering = false;

    // Flee bookkeeping.
    this._fleeFrom = null;
    this._fleeX = 0;
    this._fleeZ = 0;
    this._fleeStart = -1e9;
    this._fleeUntil = -1e9;
    this._fleeSafe = 60;
    this._fleeUrgent = false;
    this._sprintOK = true;
    this._cornered = false;

    // Hunting / fighting.
    this._chaseT = 0;
    this._chaseBest = 1e9;
    this._flank = 0;
    this._eatTry = 0;
    this._aidUntil = -1e9;

    // Routine.
    this._activityUntil = 0;
    this._arrived = true;
    this._gatherT = 0;
    this._glanceT = rand(this.rng, 3, 8);
    this._glancing = 0;
    this._lookT = 0;
    this._tryT = 0;
    this._foodCheckT = 0;
    this._canEat = false;
    this._waterFails = 0;
    this._atWater = false;
    this._approachT = 0;

    // Investigation (a prey animal's call).
    this._invActive = false;
    this._invUntil = 0;
    this._invSearchT = 0;

    // Reused point objects (targets that are just places).
    this._destPt = { x: creature.position.x, z: creature.position.z };
    this._fleePt = { x: 0, z: 0 };
    this._invPt = { x: 0, z: 0 };
    this._waterPt = { x: 0, z: 0, wx: 0, wz: 0, ok: false };
    this._lookPt = { x: 0, z: 0 };
    this._searchPt = { x: 0, z: 0 };

    // Goal written by act(), turned into intent by steer().
    this._gx = 0;
    this._gz = 0;
    this._gmag = 0;
    this._gsprint = false;
    this._gcrouch = false;
    this._geat = false;
    this._gdrink = false;
    this._grest = false;
    this._gbite = false;
    this._gcall = false;
    this._direct = false;
    this._allowWater = false;
    this._goalD = Infinity;

    // Steering memory.
    this._avoidAngle = 0;
    this._avoidSide = this.rng() < 0.5 ? -1 : 1;
    this._avoidHold = 0;
    this._stuckT = 0;
    this._stuckCount = 0;
    this._detourUntil = -1e9;
    this._detourX = 0;
    this._detourZ = 0;
    this._progT = 0;
    this._progD = Infinity;
    this._shoreOn = false;
    this._shoreX = 0;
    this._shoreZ = 0;

    this._computeSlot();
    attach(this);
  }

  /** Unsubscribe from world events (the ecosystem calls this when the creature leaves). */
  dispose() {
    detach(this);
    this.target = null;
    this._threat = null;
    this._attacker = null;
    this._fleeFrom = null;
    this._rival = null;
    this._prey = null;
  }

  /** One-line human-readable summary for debug overlays. */
  get debug() {
    const c = this.creature;
    const sp = c.species || {};
    let t = "";
    const tg = this.target;
    if (tg) {
      let label = "point";
      if (tg.position && tg.species) label = `${tg.species.id}#${tg.id}`;
      else if (tg.meat !== undefined) label = "carcass";
      else if (tg.kind) label = tg.kind;
      const d = Math.sqrt(dist2(c.position.x, c.position.z, xOf(tg), zOf(tg)));
      t = ` → ${label} ${d.toFixed(0)}m`;
    }
    const hp = Math.round((100 * num(c.health, 0)) / Math.max(1, num(c.maxHealth, 1)));
    return (
      `${sp.id}#${c.id} ${this.state}${this.mode ? "/" + this.mode : ""}${t}` +
      ` · f${num(c.food, 0) | 0} w${num(c.water, 0) | 0} st${num(c.stamina, 0) | 0} hp${hp}%` +
      ` · alert ${this.alert.toFixed(2)}`
    );
  }

  /**
   * Think (staggered ~4 Hz) and steer (every frame) — writes `creature.intent`.
   * @param {number} dt seconds
   */
  update(dt) {
    const c = this.creature;
    if (!c || !c.alive) {
      if (c && c.intent) this._clearIntent(c.intent);
      this.state = "idle";
      this.target = null;
      return;
    }
    if (!(dt > 0)) return;
    this._clock += dt;
    const wt = this.world.time;
    this._now = Number.isFinite(wt) ? wt : this._clock;
    this._stateT += dt;
    this.alert = Math.max(0, this.alert - dt * ALERT_DECAY);
    // The flag only needs to survive until our creature emitted its call (same frame).
    this._answering = false;

    this._senseT -= dt;
    if (this._senseT <= 0) {
      this._senseT = Math.max(0.02, this._senseT + SENSE_INTERVAL * (0.9 + this.rng() * 0.2));
      this._perceive();
      this._decide();
    }

    this._resetGoal();
    this._act(dt);
    this._vocalise();
    this._steer(dt);
  }

  /* --- Perception ----------------------------------------------------- */

  _perceive() {
    const c = this.creature;
    const w = this.world;
    const sp = c.species;
    const now = this._now;
    const px = c.position.x;
    const pz = c.position.z;
    const terrain = w.terrain;
    const sky = w.sky;

    const daylight = sky ? clamp(num(sky.daylight, 1), 0, 1) : 1;
    this._daylight = daylight;
    this._night = sky && typeof sky.isNight === "function" ? !!sky.isNight() : daylight < 0.25;
    const per = num(sp.perception, 80);
    // Night: herbivores see ×0.7, carnivores ×1.1 (they're built for it).
    const nightMul = this._carn ? 1.1 : 0.7;
    this._sightRange = per * (1 + 0.25 * this.alert) * lerp(nightMul, 1, smoothstep(0.1, 0.45, daylight));
    this._coverMul = terrain ? 0.8 + 0.2 * coverOf(terrain.biomeAt(px, pz)) : 1;
    // Head down in the ferns: grazing trades vigilance for food (the stalker's window).
    if (c.eating && this._glancing <= 0) this._sightRange *= 0.6;

    let herdN = 0;
    let hcx = 0;
    let hcz = 0;
    let sepX = 0;
    let sepZ = 0;
    let mateFlee = 0;
    let hungriest = num(c.food, 100);
    let mfx = 0;
    let mfz = 0;
    let threat = null;
    let threatScore = 0;
    let threatD = 0;
    let threatDanger = 0;
    let prey = null;
    let preyScore = 0;
    let preyD = 1e9;
    let rival = null;
    let rivalD = 1e9;
    let sawPlayer = false;
    const target = this.target && this.target.position && this.target !== c ? this.target : null;
    const guarding = this._carn && (this.state === "eat" || this.mode === "guard");

    const eco = w.ecosystem;
    const range = Math.min(MAX_QUERY, Math.max(this._sightRange * 1.3, per * SMELL_MUL * 1.7, HEAR_RANGE * 1.3));
    const list = eco && typeof eco.query === "function" ? eco.query(px, pz, range, null, _near) : EMPTY;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === c || !o || !o.alive || !o.position) continue;
      const ox = o.position.x;
      const oz = o.position.z;
      const dx = ox - px;
      const dz = oz - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const osp = o.species;
      const mate = !!this.group && o.group === this.group;

      // Conspecifics are never prey or threat: herd statistics + personal space.
      if (mate || (osp && osp.id === sp.id)) {
        if (mate && d < 50) {
          herdN++;
          hcx += ox;
          hcz += oz;
          hungriest = Math.min(hungriest, num(o.food, 100));
          const ob = o.brain;
          if (ob && ob.state === "flee" && d < 60 && o.velocity) {
            mateFlee++;
            mfx += o.velocity.x;
            mfz += o.velocity.z;
          }
        }
        const minD = (radiusOf(c) + radiusOf(o)) * 1.5 + 1;
        if (d < minD && d > 1e-3) {
          const k = (minD - d) / minD;
          sepX -= (dx / d) * k;
          sepZ -= (dz / d) * k;
        }
        continue;
      }

      const danger = this._dangerOf(o);
      const preyKind = this._carn && this._isPreyKind(o);
      const rivalKind = guarding && osp && osp.diet === "carnivore" && d < 24;
      if (danger <= 0 && !preyKind && !rivalKind && o !== target) continue;

      let s = this._detect(o, d);
      if (o.isPlayer) {
        sawPlayer = true;
        s = this._noticePlayer(o, s);
      }
      if (s <= 0) continue;

      if (o === target) {
        this._preyT = now;
        this._preyX = ox;
        this._preyZ = oz;
        this._preyD = d;
      }
      if (danger > 0) {
        const score = danger / Math.max(6, d);
        if (score > threatScore) {
          threatScore = score;
          threat = o;
          threatD = d;
          threatDanger = danger;
        }
      }
      if (preyKind) {
        const ps = this._scorePrey(o, d);
        if (ps > preyScore) {
          preyScore = ps;
          prey = o;
          preyD = d;
        }
      }
      if (rivalKind && d < rivalD) {
        rival = o;
        rivalD = d;
      }
    }
    if (list !== EMPTY) list.length = 0;
    if (!sawPlayer) this.awareness = Math.max(0, this.awareness - SENSE_INTERVAL * 0.15);

    // Herd.
    this._herdN = herdN;
    if (herdN) {
      this._herdCX = hcx / herdN;
      this._herdCZ = hcz / herdN;
    }
    this._sepX = sepX;
    this._sepZ = sepZ;
    this._herdFood = hungriest;
    this._mateFleeN = mateFlee;
    this._mateFleeX = mfx;
    this._mateFleeZ = mfz;
    const L = this._leader();
    this._leaderD = L ? Math.sqrt(dist2(px, pz, L.position.x, L.position.z)) : 0;
    const n = this.group ? aliveMembers(this.group) : 1;
    this._herdR = 6 + 2.5 * Math.sqrt(n) + (L ? radiusOf(L) * 2 : radiusOf(c) * 2);

    // Threat memory: track the live threat, else remember where it was.
    if (threat) {
      this._threat = threat;
      this._threatT = now;
      this._threatX = threat.position.x;
      this._threatZ = threat.position.z;
      this._threatD = threatD;
      this._threatDanger = threatDanger;
      if (!this._carn) {
        // Nervousness scales with how close the danger is relative to our flight distance.
        const near = 1 - threatD / (this._fleeDist(threat) * 2.5);
        this.alert = Math.max(this.alert, clamp(0.3 + 0.7 * near, 0.3, 1) * Math.min(1, 0.5 + threatDanger * 0.5));
      }
    } else if (this._threat) {
      if (!this._threat.alive || now - this._threatT > MEMORY_TIME) this._threat = null;
      else this._threatD = Math.sqrt(dist2(px, pz, this._threatX, this._threatZ));
    }

    // Pack mates share what they sense about the quarry.
    if (this._carn && this.group && target) {
      const m = groupMemo(this.group);
      if (m.target === target) {
        if (this._preyT === now) {
          m.seenT = now;
          m.seenX = this._preyX;
          m.seenZ = this._preyZ;
        } else if (m.seenT > this._preyT) {
          this._preyT = m.seenT;
          this._preyX = m.seenX;
          this._preyZ = m.seenZ;
          this._preyD = Math.sqrt(dist2(px, pz, m.seenX, m.seenZ));
        }
      }
    }

    this._prey = prey;
    this._preyScore = preyScore;
    this._preyBestD = preyD;
    this._rival = rival;
  }

  // Detection strength 0..1 of `o` at distance d (best of the three senses).
  _detect(o, d) {
    const c = this.creature;
    const w = this.world;
    let s = 0;

    // Sight: perception × visibility, narrowed behind us, cut by cover and terrain.
    let sight = this._sightRange * clamp(num(o.visibility, 1), 0, 1.5);
    if (sight > 0 && d < sight) {
      if (d > 0.5) {
        const cos =
          ((o.position.x - c.position.x) * Math.sin(c.heading) + (o.position.z - c.position.z) * Math.cos(c.heading)) / d;
        if (cos < this._fovCos) sight *= 0.3;
      }
      if (d < sight) {
        const t = w.terrain;
        if (t) sight *= this._coverMul * coverOf(t.biomeAt(o.position.x, o.position.z));
        if (d < sight && this._lineOfSight(o, d)) s = 1 - d / sight;
      }
    }

    // Hearing: footfalls, crashing through brush, calls (creature.noise).
    const noise = Number.isFinite(o.noise) ? o.noise : clamp(num(o.speed, 0) / 9, 0.05, 1);
    const hear = noise * HEAR_RANGE * (1 + 0.3 * this.alert);
    if (d < hear) s = Math.max(s, 1 - d / hear);

    // Smell: carried by the wind — downwind of a target you smell it from afar.
    const wind = w.wind;
    const wf =
      wind && typeof wind.scentFactor === "function"
        ? num(wind.scentFactor(o.position.x, o.position.z, c.position.x, c.position.z), 1)
        : 1;
    const smell = num(c.species.perception, 80) * SMELL_MUL * clamp(num(o.scent, 1), 0, 2) * wf;
    if (d < smell) s = Math.max(s, (1 - d / smell) * 0.75);
    return s;
  }

  // Rough line of sight: does the terrain rise above the eye line in between?
  _lineOfSight(o, d) {
    const t = this.world.terrain;
    if (!t || d < 10) return true;
    const c = this.creature;
    const ax = c.position.x;
    const az = c.position.z;
    const ay = c.position.y + hipOf(c) * 1.15;
    const bx = o.position.x;
    const bz = o.position.z;
    const by = o.position.y + hipOf(o) * 0.9;
    for (let i = 1; i <= 3; i++) {
      const f = i * 0.25;
      if (t.heightAt(ax + (bx - ax) * f, az + (bz - az) * f) > ay + (by - ay) * f + 0.25) return false;
    }
    return true;
  }

  // The player gets a fair stealth meter: awareness builds while sensed (fast
  // when close or loud) and the animal only reacts once it is full.
  _noticePlayer(o, s) {
    if (this._attacker === o && this._now - this._attackedAt < 20) {
      this.awareness = 1;
      return Math.max(s, 0.4);
    }
    if (s > 0) this.awareness = Math.min(1, this.awareness + SENSE_INTERVAL * (0.7 + 4 * s));
    else this.awareness = Math.max(0, this.awareness - SENSE_INTERVAL * 0.15);
    return this.awareness >= 1 ? s : 0;
  }

  /* --- Threat & prey assessment -------------------------------------- */

  // 0 = harmless; otherwise roughly "how many of me it could eat".
  _dangerOf(o) {
    const c = this.creature;
    const osp = o.species;
    if (!osp || osp.diet !== "carnivore") return 0;
    const om = massOf(o);
    const my = Math.max(1, massOf(c));
    const pack = o.group ? Math.min(4, aliveMembers(o.group)) : 1;
    let d = ((om * (1 + 0.7 * (pack - 1))) / my) * (0.6 + num(osp.aggression, 0.5) * 0.6);
    if (this._carn) return om > my * 1.8 ? d * 0.5 : 0; // only much bigger carnivores worry a carnivore
    if (c.growth < JUVENILE) d = Math.max(d, 0.8); // juveniles flee from almost everything
    return d >= 0.2 ? d : 0;
  }

  _isPreyKind(o) {
    const osp = o.species;
    if (!osp || osp.id === this.creature.species.id) return false;
    if (osp.diet === "herbivore") return true;
    return osp.diet === "carnivore" && massOf(o) < massOf(this.creature) * 0.35;
  }

  _scorePrey(o, d) {
    const c = this.creature;
    const now = this._now;
    if (this._ignoreObj === o && now < this._ignoreUntil) return 0;
    if (o.isPlayer && !this._provokedBy(o) && num(o.age, 1e9) < SPAWN_GRACE) return 0;
    const my = Math.max(1, massOf(c));
    const pm = massOf(o);
    const pack = this.group ? Math.min(4, aliveMembers(this.group)) : 1;
    if (pm > my * 1.6 * (1 + 0.6 * (pack - 1))) return 0; // more than we can handle
    const r = pm / my;
    let s = r < 0.015 ? 0.15 : r < 0.06 ? 0.5 : r <= 1 ? 1 : Math.max(0.2, 1 - (r - 1) * 0.5);
    const osp = o.species;
    if (num(o.growth, 1) < JUVENILE) s *= 1.5;
    const hpF = num(o.health, 1) / Math.max(1, num(o.maxHealth, 1));
    if (hpF < 0.6) s *= 1.4;
    if (num(o.bleeding, 0) > 0) s *= 1.15;
    // Isolated animals get taken; big herds of big animals are trouble.
    const herd = matesNear(o, 25);
    s *= herd === 0 ? 1.5 : 1 / (1 + 0.22 * herd);
    if (herd >= 3 && r > 0.6 && pack < 2) s *= 0.5;
    if (num(osp.armor, 0) >= 0.4 && my < pm * 2) s *= 0.15; // Gastonia's spikes aren't worth it
    if (DEFENDERS.has(osp.id) && r > 0.5) s *= 0.4;
    if (o.isPlayer) s *= 0.5 + this._aggr;
    if (o === this.target) s *= 1.5; // stick with the current quarry
    if (this.group) {
      const m = groupMemo(this.group);
      if (m.target === o && now - m.targetT < 30) s *= 1.6;
    }
    return s / (1 + d / 50);
  }

  _provokedBy(o) {
    return this._attacker === o && this._now - this._attackedAt < 60;
  }

  _recentAttacker(window, maxD = 45) {
    const a = this._attacker;
    if (!a || !a.alive || !a.position || this._now - this._attackedAt > window) return null;
    if (dist2(this.creature.position.x, this.creature.position.z, a.position.x, a.position.z) > maxD * maxD) return null;
    return a;
  }

  _leader() {
    const g = this.group;
    if (!g) return null;
    const L = g.leader;
    if (!L || L === this.creature || !L.alive || !L.position) return null;
    return L;
  }

  // Flight initiation distance: bigger danger, smaller/younger self, a threat
  // that's actually coming at us → run sooner. A predator ambling past or
  // eating is tolerated much closer (prey watch it instead).
  _fleeDist(th) {
    const c = this.creature;
    let base = 20 + 24 * Math.sqrt(Math.min(4, num(this._threatDanger, 1)));
    if (this._small) base *= 1.25;
    if (c.growth < JUVENILE) base *= 1.3;
    base *= 1 + 0.35 * this.alert;
    base *= this._isUrgent(th) ? 1.25 : 0.45;
    return clamp(base, 10, 95);
  }

  _isUrgent(th) {
    const c = this.creature;
    const tb = th.brain;
    if (tb && (tb.state === "hunt" || tb.state === "attack") && tb.mode !== "stalk") {
      const tt = tb.target;
      if (tt === c || (tt && this.group && tt.group === this.group)) return true;
    }
    // Coming straight at us at a trot or faster (its own velocity, not ours).
    const v = th.velocity;
    if (v && th.position) {
      const dx = c.position.x - th.position.x;
      const dz = c.position.z - th.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.1 && (v.x * dx + v.z * dz) / d > 3) return true;
    }
    return !!th.isPlayer && num(th.speed, 0) > 4.5;
  }

  _defendDist(t) {
    const c = this.creature;
    return 10 + c.species.length * num(c.scale, 1) * 0.6 + radiusOf(t);
  }

  // The carnivore currently mauling a herd mate near us, if any.
  _mateAttacker() {
    const g = this.group;
    const m = g && g.members;
    if (!m) return null;
    const c = this.creature;
    for (let i = 0; i < m.length; i++) {
      const k = m[i];
      if (k === c || !k || !k.alive || !k.brain || !k.position) continue;
      const kb = k.brain;
      const a = kb._attacker;
      if (!a || !a.alive || !a.position || this._now - kb._attackedAt > 5) continue;
      if (!a.species || a.species.diet !== "carnivore") continue;
      if (dist2(c.position.x, c.position.z, k.position.x, k.position.z) > 45 * 45) continue;
      return a;
    }
    return null;
  }

  _willDefend(atk) {
    const c = this.creature;
    if (c.growth < JUVENILE) return false;
    const hpF = num(c.health, 1) / Math.max(1, num(c.maxHealth, 1));
    if (this._defender) return hpF > 0.25 || massOf(atk) < massOf(c) * 0.5;
    if (hpF < 0.35) return false;
    // Cornered, exhausted, or with enough of the herd around: kick back.
    if (this._cornered || num(c.stamina, 100) < 8) return true;
    if (c.species.id === "camptosaurus" && this._herdN >= 3 && massOf(atk) < massOf(c) * 1.6) return this._defendRoll < 0.55;
    return false;
  }

  /* --- Decisions ------------------------------------------------------ */

  _decide() {
    if (this._carn) this._decideCarnivore();
    else this._decideHerbivore();
    this._maybeContactCall();
  }

  // Herds and packs keep in touch with the odd contact call; loners roar now
  // and then. The bus-wide per-species log keeps a valley from turning into a choir.
  _maybeContactCall() {
    const st = this.state;
    if (st !== "idle" && st !== "graze" && st !== "wander" && st !== "follow") return;
    if (this.mode === "wary" || this._callAt > 0) return;
    const social = this.creature.species.social;
    const every = social === "herd" || social === "pack" ? 70 : 220;
    if (this.rng() >= SENSE_INTERVAL / every) return;
    const reg = this._reg;
    const sid = this.creature.species.id;
    if (reg && this._now - num(reg.lastCall[sid], -1e9) < 8) return;
    this._queueCall(rand(this.rng, 0, 1), false);
  }

  _enter(state, target = null, mode = "") {
    if (state !== this.state) {
      this.state = state;
      this._stateT = 0;
      this._tryT = 0;
      this._atWater = false;
      this._glancing = 0;
      this._progD = Infinity;
      this._progT = 0;
    }
    this.target = target;
    this.mode = mode;
  }

  _decideHerbivore() {
    const c = this.creature;
    const now = this._now;
    const adultish = c.growth >= JUVENILE;

    // 1. Mid-fight (defending): keep at it while it makes sense.
    if (this.state === "attack" && this._keepFighting()) return;

    // 2. Hurt by someone: turn and fight (defenders, cornered herds) or bolt.
    const atk = this._recentAttacker(6);
    if (atk) {
      if (this._willDefend(atk)) return this._startFight(atk, "defend");
      if (this.state !== "flee" || this._fleeFrom !== atk) {
        return this._startFlee(atk, atk.position.x, atk.position.z, rand(this.rng, 8, 12), true);
      }
    }

    // 2b. Defenders wade in when a herd mate is being mauled.
    if (this._defender && adultish && this.group) {
      const foe = this._mateAttacker();
      if (foe) {
        this._aidUntil = now + 8;
        return this._startFight(foe, "defend");
      }
    }

    // 3. A threat in mind (sensed now or remembered).
    const th = this._threat;
    if (th) {
      const d = this._threatD;
      const fd = this._fleeDist(th);
      const hpF = num(c.health, 1) / Math.max(1, num(c.maxHealth, 1));
      if (this._defender && adultish && hpF > 0.25) {
        // Armour and tail spikes: stand ground, swing when it comes close.
        if (d < this._defendDist(th) && this._threatDanger > 0.15) return this._startFight(th, "defend");
        if (this.state === "flee" && this._keepFleeing()) return;
        // Otherwise carry on, heads up (see _watchLook) — no running.
      } else {
        if (d < fd) {
          if (this.state !== "flee" || this._fleeFrom !== th) {
            return this._startFlee(th, this._threatX, this._threatZ, rand(this.rng, 5, 9), d < fd * 0.7 || this._isUrgent(th));
          }
          this._fleeX = this._threatX;
          this._fleeZ = this._threatZ;
          this._fleeUntil = Math.max(this._fleeUntil, now + 3);
          return;
        }
        if (this.state === "flee" && this._keepFleeing()) return;
        if (d < fd * 2.4 && this.alert > 0.3 && this._beWary(th)) return;
      }
    }

    // 4. A timed flight (a close roar, a bite) runs its course.
    if (this.state === "flee" && this._keepFleeing()) return;

    // 5. The herd panics together.
    if (this.group) {
      const m = groupMemo(this.group);
      if (now - m.alarmT < 3 && dist2(c.position.x, c.position.z, m.alarmX, m.alarmZ) < 95 * 95) {
        const from = m.alarmFrom && m.alarmFrom.alive ? m.alarmFrom : null;
        return this._startFlee(from, m.alarmX, m.alarmZ, rand(this.rng, 5, 8), true, "", false);
      }
    }

    this._routineHerbivore();
  }

  _routineHerbivore() {
    const c = this.creature;
    const now = this._now;
    const L = this._leader();
    const lb = L && L.brain;

    // Thirst — and herd mates drink when their leader does.
    const herdDrinks = lb && lb.state === "drink" && c.water < 85 && this._leaderD < this._herdR * 2.5;
    if (now > this._noWaterUntil && (c.water < 40 || (this.state === "drink" && c.water < 97) || herdDrinks)) {
      return this._startDrink();
    }

    // Night: gather, then lie down together.
    if (this._wantsSleep()) {
      if (L && this._leaderD > this._herdR) return this._enter("follow", L);
      if (!L && this.group && this._herdN > 0 && this.state !== "rest") {
        // Leader waits for stragglers (up to ~25 s) before settling.
        const spread = Math.sqrt(dist2(c.position.x, c.position.z, this._herdCX, this._herdCZ));
        this._gatherT += SENSE_INTERVAL;
        if (spread > this._herdR && this._gatherT < 25) return this._enter("idle", null, "gather");
      }
      return this._enter("rest", null);
    }
    this._gatherT = 0;

    // Keep up with the herd.
    if (L) {
      // Follow while the leader is travelling; settle (graze) once it stops.
      const moving = num(L.speed, 0) > 0.6 && lb && lb.state !== "graze" && lb.state !== "idle";
      const enter = this._herdR + 8;
      const exit = this._herdR * 0.8;
      if (this.state === "follow" ? this._leaderD > exit || moving : this._leaderD > enter || (moving && this._leaderD > this._herdR * 0.6)) {
        return this._enter("follow", L);
      }
    }

    // Grazing / ambling / standing about.
    if (this.state === "graze" && this._plantOk(this.target) && Math.min(c.food, L ? 100 : this._herdFood) < 99 && now < this._activityUntil) return;
    if (!L) {
      const busy =
        (this.state === "wander" && !this._arrived && now < this._activityUntil) ||
        (this.state === "idle" && this.mode === "" && now < this._activityUntil);
      if (!busy) this._pickHerbivoreActivity();
      return;
    }
    // Herd members graze near the leader, or stand by.
    if (c.food < 97) {
      const p = this._findPlant(L.position.x, L.position.z, this._herdR + 4);
      if (p) {
        this._activityUntil = now + rand(this.rng, 20, 50);
        return this._enter("graze", p);
      }
    }
    if (this.state !== "idle") this._enter("idle", null);
  }

  // Leaders and loners: mostly browse and stand about, now and then move on.
  _pickHerbivoreActivity() {
    const c = this.creature;
    const now = this._now;
    const r = this.rng();
    // A leader settles the herd where there's browse while any of it is hungry.
    const hungry = Math.min(c.food, this._herdFood) < 97;
    if (r < (hungry ? 0.6 : 0.2)) {
      const p = this._findPlant(c.position.x, c.position.z, 35);
      if (p) {
        this._activityUntil = now + rand(this.rng, 25, 70);
        return this._enter("graze", p);
      }
      // Nothing here: head for the nearest browse further out.
      const veg = this.world.vegetation;
      const far = veg && typeof veg.nearestPlant === "function" ? veg.nearestPlant(c.position.x, c.position.z, 140, 10) : null;
      if (far && this._setDest(far.x, far.z)) {
        this._activityUntil = now + 60;
        return this._enter("wander", this._destPt);
      }
    }
    if (r < (hungry ? 0.85 : 0.55) && this._pickDestination(30, this.group ? 80 : 110)) {
      this._activityUntil = now + 60;
      return this._enter("wander", this._destPt);
    }
    this._activityUntil = now + rand(this.rng, 8, 20);
    this._enter("idle", null);
  }

  _wantsSleep() {
    const c = this.creature;
    const sky = this.world.sky;
    if (!sky) return false;
    if (this.state === "rest") {
      return this._daylight < 0.3 + this._restBias && this.alert < 0.45 && c.food > 12 && c.water > 12;
    }
    return this._night && this._daylight < 0.24 - this._restBias && this.alert < 0.25 && c.food > 25 && c.water > 25;
  }

  _decideCarnivore() {
    const c = this.creature;
    const now = this._now;
    const hpF = num(c.health, 1) / Math.max(1, num(c.maxHealth, 1));
    // A hurt carnivore comes for its attacker from a long way off.
    const atk = this._recentAttacker(8, 160);

    // 1. Badly hurt: retreat from whoever is around.
    if (hpF < 0.3) {
      const t = this.target && this.target.position && this.target.alive ? this.target : null;
      const src = atk || this._threat || (this.state === "attack" || this.state === "hunt" ? t : null);
      // Whoever just hurt us is worth running from at a much longer range.
      if (src && this._distTo(src) < (src === atk ? 160 : 70)) {
        if (this.state !== "flee") return this._startFlee(src, src.position.x, src.position.z, rand(this.rng, 15, 25), true, "retreat");
        return;
      }
    }
    if (this.state === "flee" && this._keepFleeing()) return;

    // 2. Give way to a much bigger carnivore.
    const th = this._threat;
    if (th) {
      const hunted = th.brain && th.brain.target === c;
      if (this._threatD < (hunted ? 60 : 32)) {
        return this._startFlee(th, this._threatX, this._threatZ, rand(this.rng, 6, 10), hunted || this._threatD < 18, "yield");
      }
    }

    // 3. Retaliate (or bolt if it's far too big).
    if (atk && atk !== this.target) {
      if (massOf(atk) < massOf(c) * 2.5 || (hpF > 0.75 && this.rng() < this._aggr)) {
        return this._startHunt(atk, "chase", true);
      }
      return this._startFlee(atk, atk.position.x, atk.position.z, rand(this.rng, 8, 12), true, "retreat");
    }

    // 4. Seeing off a rival at our kill.
    if (this.mode === "guard" && this.state === "attack" && this._keepGuarding()) return;
    if (this._rival && (this.state === "eat") && this.target) {
      const rv = this._rival;
      if (massOf(rv) < massOf(c) * 1.3) {
        this._guardCarcass = this.target;
        this._guardUntil = now + rand(this.rng, 6, 10);
        if (this.rng() < 0.7) this._queueCall(0.1, false);
        return this._enter("attack", rv, "guard");
      }
      return this._startFlee(rv, rv.position.x, rv.position.z, rand(this.rng, 6, 9), false, "yield");
    }

    // 5. An ongoing hunt.
    if ((this.state === "hunt" || this.state === "attack") && this._keepHunting()) return;

    // 6. Eating / guarding a carcass.
    if (this.state === "eat" && this._keepEating()) return;

    // 7. Thirst.
    if (now > this._noWaterUntil && (c.water < 30 || (this.state === "drink" && c.water < 97))) return this._startDrink();

    // 8. Follow the nose to a carcass.
    if (c.food < 75) {
      const k = this._smellCarcass();
      if (k) return this._startEat(k);
    }

    // 9. Hunt.
    const prey = this._prey;
    if (prey && this._wantsHunt(prey)) return this._startHunt(prey, "stalk", false);

    // 10. Join the pack's hunt.
    if (this.group) {
      const m = groupMemo(this.group);
      const t = m.target;
      if (t && t.alive && t.position && now - m.targetT < 30 && !(this._ignoreObj === t && now < this._ignoreUntil) && c.stamina > 20) {
        if (this._distTo(t) < 220) {
          this._preyT = m.seenT;
          this._preyX = m.seenX;
          this._preyZ = m.seenZ;
          return this._startHunt(t, "stalk", false);
        }
      }
    }

    // 11. Investigate a call (prey giving itself away, see _hearCall).
    if (this._invActive) {
      if (now < this._invUntil) return this._enter("investigate", this._invPt, this.mode === "search" ? "search" : "");
      this._invActive = false;
    }

    // 12. Pack: stay with the leader.
    const L = this._leader();
    const lb = L && L.brain;
    if (L) {
      if (lb && lb.state === "rest" && this._leaderD < this._herdR * 1.5 && c.food > 30 && c.water > 25) return this._enter("rest", null);
      const moving = num(L.speed, 0) > 0.6;
      if (this._leaderD > this._herdR + 10 || (this.state === "follow" && this._leaderD > this._herdR * 0.8) || (moving && this._leaderD > this._herdR * 0.6)) {
        return this._enter("follow", L);
      }
    }

    // 13. Rest: sometimes by day, after a big meal; rarely at night.
    if (this._wantsCarnRest()) return this._enter("rest", null);

    // 14. Roam / patrol.
    if (L) {
      if (this.state !== "idle") this._enter("idle", null);
      return;
    }
    if (this.state === "wander" && !this._arrived && now < this._activityUntil) return;
    if (this.state === "idle" && now < this._activityUntil) return;
    if (this.state === "wander" || this.rng() < 0.25) {
      this._activityUntil = now + rand(this.rng, 4, 10);
      return this._enter("idle", null);
    }
    const hungry = c.food < 65;
    if (this._pickDestination(hungry ? 100 : 60, this._night || hungry ? 240 : 170)) {
      this._activityUntil = now + 90;
      return this._enter("wander", this._destPt, hungry ? "patrol" : "");
    }
    this._activityUntil = now + 5;
    this._enter("idle", null);
  }

  _wantsHunt(prey) {
    const c = this.creature;
    const now = this._now;
    if (c.stamina < 25) return false;
    const investigating = this._invActive && now < this._invUntil;
    if (now < this._tiredUntil && !investigating) return false;
    if (investigating) return this._preyScore > 0.05;
    if (c.food < (this._night ? 78 : 65)) return this._preyScore >= 0.12;
    // Opportunism: decide once per animal (re-rolled every ~45 s).
    if (this._oppPrey !== prey || now > this._oppUntil) {
      this._oppPrey = prey;
      this._oppUntil = now + 45;
      const appetite = c.food < 90 ? 1.2 : 0.6;
      this._oppYes = this.rng() < this._aggr * (prey.isPlayer ? 0.7 : 0.3) * appetite;
    }
    return this._oppYes && this._preyBestD < 70 && this._preyScore > 0.2;
  }

  _wantsCarnRest() {
    const c = this.creature;
    const now = this._now;
    if (this.state === "rest") {
      return now < this._restUntil && this.alert < 0.5 && c.food > 20 && c.water > 20 && !this._prey;
    }
    if (now < this._restUntil && c.food > 30) return true; // sleeping off a meal
    if (this._night || this._daylight < 0.5) return false; // the night belongs to the predators
    if (c.food > 60 && c.water > 45 && this.rng() < SENSE_INTERVAL / 150) {
      this._restUntil = now + rand(this.rng, 40, 110);
      return true;
    }
    return false;
  }

  /* --- Starting behaviours ------------------------------------------- */

  _startFlee(src, x, z, dur, urgent, mode = "", broadcast = true) {
    const c = this.creature;
    const now = this._now;
    const fresh = this.state !== "flee";
    this._fleeFrom = src && src.position ? src : null;
    this._fleeX = x;
    this._fleeZ = z;
    if (fresh) {
      this._fleeStart = now;
      this._fleeUntil = now + dur;
      this._fleeUrgent = !!urgent;
    } else {
      this._fleeUntil = Math.max(this._fleeUntil, now + dur);
      this._fleeUrgent = this._fleeUrgent || !!urgent;
    }
    this._fleeSafe = this._fleeFrom && !this._carn ? Math.max(40, this._fleeDist(this._fleeFrom) * 1.7) : 70;
    this._fleePt.x = x;
    this._fleePt.z = z;
    this._enter("flee", this._fleeFrom || this._fleePt, mode);
    if (!fresh) return;
    this.alert = 1;
    this._cornered = false;
    if (!this._carn) {
      if (this.group && broadcast) {
        const m = groupMemo(this.group);
        m.alarmT = now;
        m.alarmX = x;
        m.alarmZ = z;
        m.alarmFrom = this._fleeFrom;
      }
      // An alarm honk now and then — it warns the herd and tells the player something's up.
      if (broadcast && this.rng() < 0.35 && c.growth >= JUVENILE) this._queueCall(rand(this.rng, 0.1, 0.5), false);
    }
  }

  _keepFleeing() {
    const now = this._now;
    if (now - this._fleeStart > 45) return false;
    const src = this._fleeFrom;
    let d;
    if (src && src.alive && src === this._threat) d = this._threatD;
    else d = this._distToXZ(this._fleeX, this._fleeZ);
    return now < this._fleeUntil || d < this._fleeSafe;
  }

  _beWary(th) {
    // Members follow their leader and keep their heads up; leaders (and
    // loners) walk the group away from the danger.
    if (this._leader()) return false;
    if (this.state === "wander" && this.mode === "wary" && !this._arrived) return true;
    const c = this.creature;
    let ax = c.position.x - this._threatX;
    let az = c.position.z - this._threatZ;
    const l = Math.hypot(ax, az) || 1;
    ax /= l;
    az /= l;
    if (!this._pickDestToward(ax, az, rand(this.rng, 40, 70))) return false;
    this._activityUntil = this._now + 40;
    this._enter("wander", this._destPt, "wary");
    return true;
  }

  _startFight(t, mode) {
    const fresh = this.state !== "attack" || this.target !== t;
    this._enter("attack", t, mode);
    if (!fresh) return;
    this.alert = 1;
    this._side = this.rng() < 0.5 ? -1 : 1;
    // A bellow / hoot as a threat display.
    if (this.rng() < 0.5) this._queueCall(rand(this.rng, 0.1, 0.6), false);
  }

  _keepFighting() {
    const c = this.creature;
    const t = this.target;
    const now = this._now;
    if (!t || !t.alive || !t.position) return false;
    const d = this._distTo(t);
    const hpF = num(c.health, 1) / Math.max(1, num(c.maxHealth, 1));
    if (hpF < 0.22) {
      this._startFlee(t, t.position.x, t.position.z, rand(this.rng, 12, 18), true);
      return true;
    }
    const recentlyHit = this._attacker === t && now - this._attackedAt < 10;
    const dd = this._defendDist(t);
    if (d < dd * 1.6 && (recentlyHit || d < dd)) return true;
    if (now < this._aidUntil && d < 50) {
      if (this._mateAttacker() === t) this._aidUntil = now + 4;
      return true;
    }
    return this._stateT < 3;
  }

  _startHunt(prey, mode, provoked) {
    const now = this._now;
    const fresh = this.target !== prey || (this.state !== "hunt" && this.state !== "attack");
    this._enter("hunt", prey, mode);
    if (!fresh) return;
    this._chaseT = 0;
    this._chaseBest = 1e9;
    if (this._preyT < now - 1) {
      this._preyT = now;
      this._preyX = prey.position.x;
      this._preyZ = prey.position.z;
    }
    this._preyD = this._distTo(prey);
    this._flank = this._flankSlot();
    // Carnivores often announce a hunt — fair warning for a player, drama for everyone.
    const p = prey.isPlayer ? Math.max(this._style.callP, 0.6) : this._style.callP * 0.5;
    if (!provoked && this.rng() < p) this._queueCall(rand(this.rng, 0.2, 1.2), false);
    if (this.group) {
      const m = groupMemo(this.group);
      m.target = prey;
      m.targetT = now;
      m.seenT = this._preyT;
      m.seenX = this._preyX;
      m.seenZ = this._preyZ;
    }
    if (provoked) this.alert = 1;
  }

  _keepHunting() {
    const c = this.creature;
    const now = this._now;
    const t = this.target;
    if (!t || !t.position) return false;
    if (!t.alive) {
      // Kill (or someone else's): find the body.
      const eco = this.world.ecosystem;
      const k = eco && typeof eco.nearestCarcass === "function" ? eco.nearestCarcass(t.position.x, t.position.z, 12 + radiusOf(t), 1) : null;
      if (k) {
        this._startEat(k);
        return true;
      }
      return false;
    }
    const provoked = this._provokedBy(t);
    if (t.isPlayer && !provoked && num(t.age, 1e9) < SPAWN_GRACE) return false;
    const lost = now - this._preyT;
    if (lost > MEMORY_TIME + (this.mode === "chase" ? 2 : 5)) return this._giveUp(t, 30, 0);
    if (this.mode === "chase") {
      if (this._chaseT > this._style.chaseTime * (provoked ? 1.6 : 1)) return this._giveUp(t, 40, 25);
      // Spent and not gaining any more: let it go.
      if (c.stamina < 4 && this._preyD > 12 && this._preyD > this._chaseBest + 4) return this._giveUp(t, 30, 20);
    }
    if (!provoked && c.food > 97 && !t.isPlayer) return this._giveUp(t, 60, 0);
    const swimOK = this._swimmer || num(c.species.swim, 0) >= 0.5;
    if (t.swimming && !swimOK && this._preyD > 6) return this._giveUp(t, 25, 0);
    return true;
  }

  _giveUp(t, ignoreFor, restFor) {
    this._ignoreObj = t;
    this._ignoreUntil = this._now + ignoreFor;
    if (restFor > 0) this._tiredUntil = this._now + restFor;
    if (this.group) {
      const m = groupMemo(this.group);
      if (m.target === t) m.target = null;
    }
    return false;
  }

  _startEat(k) {
    this._enter("eat", k, "");
    this._eatTry = 0;
  }

  _keepEating() {
    const c = this.creature;
    const now = this._now;
    const k = this.target;
    if (!k || !(num(k.meat, 0) >= 0.5) || k.fading) return false;
    // Hysteresis: a full animal stands guard and only tucks in again once peckish.
    if (c.food < (this.mode === "guard" ? 88 : 99)) {
      if (this.mode === "guard") this.mode = "";
      return true;
    }
    if (this.mode !== "guard") {
      this.mode = "guard";
      this._guardUntil = now + rand(this.rng, 12, 25);
    }
    if (now < this._guardUntil) return true;
    this._restUntil = now + rand(this.rng, 50, 120); // sleep it off
    return false;
  }

  _keepGuarding() {
    const rv = this.target;
    const k = this._guardCarcass;
    if (!rv || !rv.alive || !rv.position || this._distTo(rv) > 26 || this._now > this._guardUntil) {
      if (k && num(k.meat, 0) >= 0.5 && !k.fading) {
        this._startEat(k);
        return true;
      }
      return false;
    }
    return true;
  }

  _smellCarcass() {
    const c = this.creature;
    const eco = this.world.ecosystem;
    if (!eco || typeof eco.nearestCarcass !== "function") return null;
    const k = eco.nearestCarcass(c.position.x, c.position.z, 160, 3);
    if (!k) return null;
    const d = this._distToXZ(k.x, k.z);
    const wind = this.world.wind;
    const wf = wind && typeof wind.scentFactor === "function" ? num(wind.scentFactor(k.x, k.z, c.position.x, c.position.z), 1) : 1;
    if (d > 100 * wf) return null;
    // Don't walk into a bigger predator's meal.
    if (this._threat && dist2(this._threatX, this._threatZ, k.x, k.z) < 30 * 30) return null;
    return k;
  }

  _startDrink() {
    if (this.state !== "drink") {
      this._enter("drink", this._waterPt);
      this._waterFails = 0;
      if (!this._findWater(this.creature.position.x, this.creature.position.z)) {
        this._noWaterUntil = this._now + 60;
        this._enter("idle", null);
        return;
      }
    }
    this.target = this._waterPt;
  }

  _findWater(x, z) {
    const t = this.world.terrain;
    let w = t && typeof t.nearestFreshWater === "function" ? t.nearestFreshWater(x, z, 400) : null;
    const p = this._waterPt;
    if (!w) {
      p.ok = false;
      return false;
    }
    // Herd mates spread out along the bank instead of queueing for one spot.
    const g = this.group;
    const idx = g && g.members ? g.members.indexOf(this.creature) : 0;
    if (idx > 0 && typeof t.nearestFreshWater === "function") {
      const c = this.creature;
      const dx = w.x - c.position.x;
      const dz = w.z - c.position.z;
      const l = Math.hypot(dx, dz) || 1;
      const off = (idx % 2 ? 1 : -1) * Math.ceil(idx / 2) * (radiusOf(c) * 2.5 + 2.5);
      const w2 = t.nearestFreshWater(w.x - (dz / l) * off, w.z + (dx / l) * off, 60);
      if (w2) w = w2;
    }
    p.x = w.x;
    p.z = w.z;
    if (Number.isFinite(w.waterX)) {
      p.wx = w.waterX;
      p.wz = w.waterZ;
    } else {
      // Older terrain without a water point: face onward from where we came.
      const c = this.creature;
      const dx = w.x - c.position.x;
      const dz = w.z - c.position.z;
      const l = Math.hypot(dx, dz) || 1;
      p.wx = w.x + (dx / l) * 3;
      p.wz = w.z + (dz / l) * 3;
    }
    p.ok = true;
    return true;
  }

  _plantOk(p) {
    return !!p && p.kind !== undefined && num(p.food, 0) >= 1;
  }

  _findPlant(x, z, radius) {
    const veg = this.world.vegetation;
    if (!veg || typeof veg.nearestPlant !== "function") return null;
    const c = this.creature;
    // Search around a point between us and the herd centre so mates spread over the browse.
    const p = veg.nearestPlant((x + c.position.x) * 0.5, (z + c.position.z) * 0.5, radius, 4);
    return p && this._plantOk(p) ? p : null;
  }

  /** Go and look at (x, z), arriving ready to hunt. */
  _investigate(x, z, dur) {
    this._invActive = true;
    this._invUntil = this._now + dur;
    this._invPt.x = x;
    this._invPt.z = z;
    this._invSearchT = 0;
    this._senseT = Math.min(this._senseT, 0.05);
  }

  /* --- Destinations --------------------------------------------------- */

  // Sample a few candidate points and keep the best: dry, gentle, in bounds,
  // preferably in this species' biomes and roughly ahead (no zig-zagging).
  _pickDestination(minR, maxR) {
    const c = this.creature;
    const t = this.world.terrain;
    const px = c.position.x;
    const pz = c.position.z;
    let best = -1;
    let bx = 0;
    let bz = 0;
    const biomes = c.species.biomes || EMPTY;
    for (let i = 0; i < 8; i++) {
      const a = i < 5 ? c.heading + rand(this.rng, -1.3, 1.3) : rand(this.rng, -Math.PI, Math.PI);
      const r = rand(this.rng, minR, maxR);
      const x = px + Math.sin(a) * r;
      const z = pz + Math.cos(a) * r;
      let score = this.rng() * 0.3;
      if (t) {
        if (!t.inBounds(x, z, EDGE_MARGIN + 30)) continue;
        if (t.heightAt(x, z) < num(t.seaLevel, 0) + 0.3) continue;
        const slope = t.slopeAt(x, z);
        if (slope > SLOPE_SOFT) continue;
        if (biomes.includes(t.biomeAt(x, z))) score += 1;
        score -= slope * 2;
      }
      if (score > best) {
        best = score;
        bx = x;
        bz = z;
      }
    }
    if (best < 0) {
      // Nothing good around: head back toward the island's heart.
      const l = Math.hypot(px, pz) || 1;
      return this._setDest(px - (px / l) * 60, pz - (pz / l) * 60);
    }
    return this._setDest(bx, bz);
  }

  _pickDestToward(ux, uz, r) {
    const c = this.creature;
    const t = this.world.terrain;
    const base = yawFromDir(ux, uz);
    for (let i = 0; i < 6; i++) {
      const a = base + (i === 0 ? 0 : (i % 2 ? 1 : -1) * 0.45 * Math.ceil(i / 2));
      const x = c.position.x + Math.sin(a) * r;
      const z = c.position.z + Math.cos(a) * r;
      if (t && (!t.inBounds(x, z, EDGE_MARGIN + 20) || t.heightAt(x, z) < num(t.seaLevel, 0) + 0.3 || t.slopeAt(x, z) > SLOPE_HARD)) continue;
      return this._setDest(x, z);
    }
    return false;
  }

  _setDest(x, z) {
    this._destPt.x = x;
    this._destPt.z = z;
    this._arrived = false;
    this._progD = Infinity;
    this._stuckCount = 0;
    return true;
  }

  _computeSlot() {
    const g = this.group;
    const idx = g && g.members ? Math.max(0, g.members.indexOf(this.creature)) : 0;
    const row = Math.floor((idx + 1) / 2);
    const side = idx % 2 ? 1 : -1;
    // Behind the leader in a loose chevron.
    this._slotA = Math.PI + side * (0.35 + 0.25 * row);
    this._slotR = radiusOf(this.creature) * 3 + 3 + 2.2 * row;
  }

  _flankSlot() {
    const g = this.group;
    if (!g || !g.members || g.leader === this.creature) return 0;
    const idx = Math.max(0, g.members.indexOf(this.creature));
    return (idx % 2 ? 1 : -1) * (0.7 + 0.3 * Math.floor(idx / 2));
  }

  /* --- Events --------------------------------------------------------- */

  _hearCall(e) {
    const c = this.creature;
    const caller = e.creature;
    if (!caller || caller === c || !c.alive) return;
    const osp = caller.species;
    if (!osp) return;
    const x = num(e.x, caller.position ? caller.position.x : 0);
    const z = num(e.z, caller.position ? caller.position.z : 0);
    const d2 = dist2(c.position.x, c.position.z, x, z);
    const now = this._now;

    if (osp.id === c.species.id) {
      if (d2 > CALL_ANSWER_RANGE * CALL_ANSWER_RANGE) return;
      const isAnswer = !!(caller.brain && caller.brain._answering);
      if (isAnswer || now - this._lastAnswerAt < 25) return;
      if (this.state === "flee" || this.state === "attack" || (this.state === "hunt" && this.mode === "stalk") || this.state === "rest") return;
      const reg = this._reg;
      if (reg && now - num(reg.lastCall[osp.id], -1e9) < 2) return;
      const p = this.group && this.group.leader === c ? 0.6 : 0.4;
      if (this.rng() < p) {
        this._lastAnswerAt = now;
        this._queueCall(rand(this.rng, 1, 4), true);
      }
      return;
    }

    if (osp.diet !== "carnivore") {
      // A hungry carnivore homes in on prey that gives itself away.
      if (this._carn && c.food < 75 && d2 < 220 * 220 && !this._invActive && (this.state === "idle" || this.state === "wander" || this.state === "follow" || this.state === "rest")) {
        if (!this.group || !this._leader()) this._investigate(x, z, rand(this.rng, 35, 50));
      }
      return;
    }
    if (this._carn) {
      // A much bigger carnivore announcing itself nearby: keep clear.
      if (d2 < 90 * 90 && massOf(caller) > massOf(c) * 1.8) {
        this.alert = Math.min(1, this.alert + 0.4);
        if (d2 < 50 * 50 && this.state !== "attack" && this.state !== "eat") this._startFlee(caller, x, z, rand(this.rng, 5, 8), false, "yield");
      }
      return;
    }
    if (d2 > CALL_ALERT_RANGE * CALL_ALERT_RANGE) return;
    const danger = this._dangerOf(caller);
    this.alert = Math.min(1, this.alert + (danger > 0 ? 0.6 : 0.25));
    if (danger <= 0) return;
    // We now know roughly where it is.
    if (!this._threat || this._threat === caller || now - this._threatT > 2) {
      this._threat = caller;
      this._threatT = now;
      this._threatX = x;
      this._threatZ = z;
      this._threatD = Math.sqrt(d2);
      this._threatDanger = danger;
    }
    const close = c.growth < JUVENILE ? 70 : this._small ? 60 : 45;
    const stands = this._defender && c.growth >= JUVENILE;
    if (d2 < close * close && !stands && this.state !== "attack") {
      this._startFlee(caller, x, z, rand(this.rng, 6, 10), d2 < 25 * 25);
    }
  }

  _onDamage(e) {
    const c = this.creature;
    const src = e.source;
    if (!src || src === c || !c.alive || src.alive === false || !src.position) return;
    if (this.group && src.group === this.group) return; // shoved by a mate
    this._attacker = src;
    this._attackedAt = this._now;
    this._defendRoll = this.rng();
    this.alert = 1;
    if (src.isPlayer) this.awareness = 1;
    this._senseT = 0; // think about it this frame
  }

  _queueCall(delay, answer) {
    const now = this._now;
    if (now - this._lastCallAt < 6 || this._callAt > 0) return;
    this._callAt = now + delay;
    this._callIsAnswer = !!answer;
  }

  _vocalise() {
    if (this._callAt <= 0 || this._now < this._callAt) return;
    this._callAt = 0;
    const c = this.creature;
    if (this.state === "rest" || (this.state === "hunt" && this.mode === "stalk" && !this._callIsAnswer && this._stateT > 3)) return;
    this._gcall = true;
    this._answering = this._callIsAnswer;
    this._lastCallAt = this._now;
    if (this._reg) this._reg.lastCall[c.species.id] = this._now;
  }

  /* --- Acting --------------------------------------------------------- */

  _resetGoal() {
    this._gx = 0;
    this._gz = 0;
    this._gmag = 0;
    this._gsprint = false;
    this._gcrouch = false;
    this._geat = false;
    this._gdrink = false;
    this._grest = false;
    this._gbite = false;
    this._gcall = false;
    this._direct = false;
    this._allowWater = this._swimmer;
    this._goalD = Infinity;
  }

  _act(dt) {
    const c = this.creature;
    let look = null;
    switch (this.state) {
      case "flee":
        this._actFlee();
        look = this._fleeFrom;
        break;
      case "hunt":
        this._actHunt(dt);
        look = this.target;
        break;
      case "attack":
        if (this._carn) this._actBite();
        else this._actDefend();
        look = this.target;
        break;
      case "eat":
        this._actEat(dt);
        look = this._watchLook();
        break;
      case "graze":
        look = this._actGraze(dt);
        break;
      case "drink":
        this._actDrink(dt);
        look = this._watchLook();
        break;
      case "follow":
        this._actFollow();
        look = this._watchLook();
        break;
      case "wander":
        this._actWander();
        look = this.mode === "wary" ? this._threat : this._watchLook();
        break;
      case "investigate":
        look = this._actInvestigate(dt);
        break;
      case "rest":
        this._grest = true;
        break;
      default:
        look = this._actIdle(dt);
    }
    // Separation from herd mates while on the move.
    if (this._gmag > 0.05 && (this._sepX || this._sepZ) && !this._direct) {
      this._gx += this._sepX * 0.9;
      this._gz += this._sepZ * 0.9;
    }
    c.lookTarget = look;
  }

  // Heads come up toward a remembered threat.
  _watchLook() {
    const th = this._threat;
    if (th && this._now - this._threatT < MEMORY_TIME && this.alert > 0.3) return th;
    return null;
  }

  _goDir(dx, dz, mag, sprint = false, crouch = false) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-6 || mag <= 0) return;
    this._gx = dx / l;
    this._gz = dz / l;
    this._gmag = mag;
    this._gsprint = sprint;
    this._gcrouch = crouch;
  }

  _goTo(x, z, mag, sprint = false, crouch = false, arrive = 0) {
    const c = this.creature;
    const dx = x - c.position.x;
    const dz = z - c.position.z;
    const d = Math.hypot(dx, dz);
    this._goalD = d;
    if (arrive > 0 && d < arrive * 2.5) mag *= clamp(d / (arrive * 2.5), 0.35, 1); // ease in
    this._goDir(dx, dz, mag, sprint, crouch);
    return d;
  }

  _actFlee() {
    const c = this.creature;
    const now = this._now;
    const src = this._fleeFrom;
    let sx = this._fleeX;
    let sz = this._fleeZ;
    // A threat this close is tracked by sound alone.
    if (src && src.alive && src.position && (now - this._threatT < 1 && src === this._threat || this._distTo(src) < 25)) {
      sx = src.position.x;
      sz = src.position.z;
      this._fleeX = sx;
      this._fleeZ = sz;
    }
    let ax = c.position.x - sx;
    let az = c.position.z - sz;
    const d = Math.hypot(ax, az);
    if (d < 1e-3) {
      ax = Math.sin(c.heading);
      az = Math.cos(c.heading);
    } else {
      ax /= d;
      az /= d;
    }
    // Run with the herd, not into the threat.
    if (this._herdN > 0 && !this._carn) {
      const hx = this._herdCX - c.position.x;
      const hz = this._herdCZ - c.position.z;
      const hl = Math.hypot(hx, hz);
      if (hl > 6 && (hx * ax + hz * az) / hl > -0.2) {
        ax += (hx / hl) * 0.35;
        az += (hz / hl) * 0.35;
      }
    }
    if (this._mateFleeN > 0) {
      const ml = Math.hypot(this._mateFleeX, this._mateFleeZ);
      if (ml > 1e-3 && (this._mateFleeX * ax + this._mateFleeZ * az) / ml > -0.3) {
        ax += (this._mateFleeX / ml) * 0.4;
        az += (this._mateFleeZ / ml) * 0.4;
      }
    }
    const chased = !!(src && src.brain && src.brain.target === c && src.brain.mode === "chase");
    const urgent = (this._fleeUrgent && now - this._fleeStart < 7) || d < this._fleeSafe * 0.45 || chased;
    // Stamina-aware sprinting with hysteresis: save some for when it counts.
    if (this._sprintOK) {
      if (c.stamina < 6) this._sprintOK = false;
    } else if (c.stamina > 25) this._sprintOK = true;
    const sprint = urgent && (this._sprintOK || d < 12);
    const mag = (this.mode === "retreat" || this.mode === "yield") && !urgent ? JOG : TROT;
    this._goDir(ax, az, mag, sprint);
    // Water is worth it when something is right behind us and can't swim as well.
    const theirSwim = src && src.species ? num(src.species.swim, 0) : 1;
    if (d < 20 && num(c.species.swim, 0) >= theirSwim) this._allowWater = true;
  }

  _actHunt(dt) {
    const c = this.creature;
    const t = this.target;
    const now = this._now;
    if (!t || !t.position) return;
    const live = now - this._preyT < 0.6 && t.alive;
    const tx = live ? t.position.x : this._preyX;
    const tz = live ? t.position.z : this._preyZ;
    const d = this._distToXZ(tx, tz);
    if (live) this._preyD = d;
    const reach = this._biteReach(t);
    if (live && d <= reach * 1.05) {
      this._enter("attack", t, "bite");
      this._actBite();
      return;
    }
    const st = this._style;
    if (this.mode === "stalk") {
      const tb = t.brain;
      const bolting = (tb && tb.state === "flee") || num(t.speed, 0) > 5;
      // Spotted: the quarry (or its herd) is staring right at us — go now.
      const spotted = !!tb && tb._threat === c && tb.alert > 0.55;
      if (d < st.chase || (bolting && d < st.chase * 2.5) || (spotted && d < st.chase * 1.8) || (this._provokedBy(t) && d < st.chase * 1.5)) {
        this.mode = "chase";
        this._chaseT = 0;
        this._chaseBest = d;
      }
    }
    if (this.mode === "stalk") {
      let ax = tx;
      let az = tz;
      const ux = (tx - c.position.x) / Math.max(d, 1e-3);
      const uz = (tz - c.position.z) / Math.max(d, 1e-3);
      if (this._flank !== 0 && d > 16) {
        // Pack mates fan out to the sides so the prey bolts into someone.
        const off = this._flank * clamp(d * 0.35, 6, 22);
        ax += -uz * off;
        az += ux * off;
      } else if (d > 45) {
        // Circle round to come in from downwind, where the prey can't smell us.
        const wind = this.world.wind;
        const wv = wind && wind.vector;
        if (wv) {
          const upwind = clamp((ux * wv.x + uz * wv.z) * num(wind.strength, 0.5) * 1.6, 0, 1);
          if (upwind > 0.15) {
            const r = Math.min(d, 70) * 0.8;
            ax = lerp(tx, tx + wv.x * r - uz * r * 0.5 * this._side, upwind);
            az = lerp(tz, tz + wv.z * r + ux * r * 0.5 * this._side, upwind);
          }
        }
      }
      // Creep once inside what the prey can see (its perception), or our own habit.
      const preyEyes = num(t.species && t.species.perception, 0) * 0.95;
      const crouchD = Math.max(st.crouch, preyEyes * 0.8);
      const crouch = d < crouchD;
      let mag = d > crouchD + 40 ? (this._night ? TROT : JOG) : crouch ? 0.5 : WALK;
      // Ambushers freeze in cover while the prey drifts closer.
      if (st.ambush && crouch && live && d < st.chase * 2 && num(t.speed, 0) > 0.3) {
        const tvx = t.velocity ? t.velocity.x : 0;
        const tvz = t.velocity ? t.velocity.z : 0;
        if ((c.position.x - tx) * tvx + (c.position.z - tz) * tvz > 0) mag = 0;
      }
      if (mag > 0) this._goTo(ax, az, mag, false, crouch);
      else this._gcrouch = true;
      return;
    }
    // Chase: lead the target, pincer from the flank.
    this._chaseT += dt;
    if (live && d < this._chaseBest) this._chaseBest = d;
    const lead = clamp(d / Math.max(4, num(c.speed, 0) + 1), 0, 1.4);
    let ax = tx + (live && t.velocity ? t.velocity.x * lead : 0);
    let az = tz + (live && t.velocity ? t.velocity.z * lead : 0);
    if (this._flank !== 0 && d > 14) {
      const ux = (tx - c.position.x) / d;
      const uz = (tz - c.position.z) / d;
      const off = this._flank * clamp(d * 0.25, 3, 10);
      ax += -uz * off;
      az += ux * off;
    }
    const sprint = c.stamina > 3 || d < 10;
    this._goTo(ax, az, TROT, sprint, false);
    if (t.swimming && num(c.species.swim, 0) >= 0.3) this._allowWater = true;
  }

  _biteReach(t) {
    const c = this.creature;
    const s = num(c.scale, 1);
    return c.species.length * 0.42 * s + num(c.species.biteRange, 1) * s + radiusOf(t) * 0.9 + 0.3;
  }

  // Carnivore at close quarters (also used to see off a rival at a kill).
  _actBite() {
    const c = this.creature;
    const t = this.target;
    if (!t || !t.position || !t.alive) return;
    const dx = t.position.x - c.position.x;
    const dz = t.position.z - c.position.z;
    const d = Math.hypot(dx, dz);
    const reach = this._biteReach(t);
    if (this.mode !== "guard" && d > reach * 1.6) {
      this._enter("hunt", t, "chase");
      this._actHunt(0);
      return;
    }
    const err = Math.abs(angleDiff(c.heading, yawFromDir(dx, dz)));
    this._direct = true;
    let mag = 0;
    if (d > reach * 0.85) mag = this.mode === "guard" ? JOG : TROT;
    else if (err > 0.25) mag = 0.14; // shuffle round to face it
    if (mag > 0) this._goDir(dx, dz, mag, d > reach * 1.3 && this.mode !== "guard", false);
    if (err < 0.5 && d <= reach && c.biteCooldown <= 0) this._gbite = true;
  }

  // Herbivore fighting back: tail swingers present their tail, kickers face it.
  _actDefend() {
    const c = this.creature;
    const t = this.target;
    if (!t || !t.position || !t.alive) return;
    const sp = c.species;
    const s = num(c.scale, 1);
    const cx = c.position.x;
    const cz = c.position.z;
    const tx = t.position.x;
    const tz = t.position.z;
    const dx = tx - cx;
    const dz = tz - cz;
    const d = Math.hypot(dx, dz) || 1e-3;
    const toT = Math.abs(angleDiff(c.heading, yawFromDir(dx, dz)));
    this._direct = true;

    if (this._tail) {
      const reach = sp.length * 0.5 * s + num(sp.biteRange, 1.5) * s + radiusOf(t);
      if (d > reach * 1.3) {
        // Close in on it (defending a mate, or it backed off a little).
        this._goTo(tx, tz, d > 20 ? TROT : WALK, false, false);
      } else {
        // Keep the threat in the rear quarter, swinging toward the side we already favour.
        const away = yawFromDir(-dx, -dz);
        const side = Math.sign(angleDiff(away, c.heading)) || this._side;
        const want = away + side * 0.75;
        const err = Math.abs(angleDiff(c.heading, want));
        if (err > 0.3) this._goDir(Math.sin(want), Math.cos(want), 0.14);
      }
      if (toT > 1.3 && d <= reach && c.biteCooldown <= 0) this._gbite = true;
      return;
    }
    const reach = sp.length * 0.42 * s + num(sp.biteRange, 1) * s + radiusOf(t);
    let mag = 0;
    if (d > reach * 0.8) mag = d > reach * 2 ? JOG : WALK;
    else if (toT > 0.3) mag = 0.14;
    if (mag > 0) this._goDir(dx, dz, mag);
    if (toT < 0.5 && d <= reach && c.biteCooldown <= 0) this._gbite = true;
  }

  _actEat(dt) {
    const c = this.creature;
    const k = this.target;
    if (!k || !Number.isFinite(k.x)) return;
    const d = this._distToXZ(k.x, k.z);
    const reach = num(k.radius, 1) + c.species.length * 0.42 * num(c.scale, 1) + 0.6;
    if (this.mode === "guard") {
      // Full: loiter by the carcass, facing out.
      if (d > reach + 6) this._goTo(k.x, k.z, WALK, false, false, 3);
      return;
    }
    if (c.eating) {
      this._geat = true;
      this._eatTry = 0;
      return;
    }
    if (d > reach) {
      this._goTo(k.x, k.z, d > 30 ? JOG : WALK, false, false, 2);
      this._direct = d < reach + 6;
      return;
    }
    this._geat = true;
    this._eatTry = num(this._eatTry, 0) + dt;
    if (this._eatTry > 1.2) {
      this._direct = true;
      this._goTo(k.x, k.z, 0.16); // nose in
    }
    if (this._eatTry > 9) {
      // Can't get the jaws in from here: back off, re-decide (maybe from a new angle).
      this._eatTry = 0;
      this._activityUntil = this._now + 3;
      this._enter("idle", null);
    }
  }

  _actGraze(dt) {
    const c = this.creature;
    const p = this.target;
    if (!this._plantOk(p)) return null;
    const d = this._distToXZ(p.x, p.z);
    const s = num(c.scale, 1);
    const near = c.species.length * 0.45 * s + 1.5;

    // Head-up glances: shorter, more often when nervous.
    this._glanceT -= dt;
    if (this._glancing > 0) {
      this._glancing -= dt;
      if (this._glancing <= 0) this._glanceT = lerp(10, 3, this.alert) * (0.7 + this.rng() * 0.6);
      return this._threat && this._now - this._threatT < MEMORY_TIME ? this._threat : this._lookAround();
    }
    if (this._glanceT <= 0 && (c.eating || d < near)) {
      this._glancing = rand(this.rng, 1, 2.2);
      this._lookPt.x = c.position.x + rand(this.rng, -30, 30);
      this._lookPt.z = c.position.z + rand(this.rng, -30, 30);
      return null;
    }
    if (this.alert > 0.6) return this._watchLook(); // too nervous to put the head down

    if (c.eating) {
      this._geat = true;
      this._tryT = 0;
      return null;
    }
    if (d > near + 1) {
      this._goTo(p.x, p.z, WALK, false, false, 2);
      return null;
    }
    this._foodCheckT -= dt;
    if (this._foodCheckT <= 0) {
      this._foodCheckT = 0.3;
      this._canEat = typeof c.findFood === "function" ? !!c.findFood() : d < near;
    }
    this._geat = true;
    if (!this._canEat) {
      this._tryT += dt;
      this._direct = true;
      this._goTo(p.x, p.z, 0.2);
      if (this._tryT > 5) {
        this._tryT = 0;
        const q = this._findPlant(c.position.x + rand(this.rng, -15, 15), c.position.z + rand(this.rng, -15, 15), 30);
        if (q && q !== p) this.target = q;
        else this._enter("idle", null);
      }
    }
    return null;
  }

  _lookAround() {
    return this._lookPt;
  }

  _actDrink(dt) {
    const c = this.creature;
    const w = this._waterPt;
    if (!w.ok) return;
    if (c.drinking) {
      this._gdrink = true;
      return;
    }
    const d = this._distToXZ(w.x, w.z);
    const arrive = 1.2 + radiusOf(c);
    if (!this._atWater && d > arrive) {
      // Jostled by mates at a crowded bank: close enough is close enough.
      if (d < arrive * 4) this._approachT += dt;
      if (this._approachT < 4 || d > arrive * 4) {
        // Parched animals hurry; mildly thirsty ones amble down to the water.
        this._goTo(w.x, w.z, c.water < 12 ? TROT : c.water < 28 ? JOG : WALK, false, false, arrive);
        if (d < arrive * 4) this._direct = true;
        this._tryT = 0;
        return;
      }
    }
    this._atWater = true;
    this._approachT = 0;
    this._tryT += dt;
    this._gdrink = true;
    this._direct = true;
    this._allowWater = true;
    const dx = w.wx - c.position.x;
    const dz = w.wz - c.position.z;
    const err = Math.abs(angleDiff(c.heading, yawFromDir(dx, dz)));
    if (err > 0.3) this._goDir(dx, dz, 0.14); // turn to face the water
    else if (this._tryT > 1.5) this._goDir(dx, dz, 0.16); // edge closer
    if (this._tryT > 10) {
      // Bad spot (reeds, a steep bank): try further along the shore.
      this._tryT = 0;
      this._atWater = false;
      if (++this._waterFails >= 3 || !this._findWater(w.x + rand(this.rng, -30, 30), w.z + rand(this.rng, -30, 30))) {
        this._noWaterUntil = this._now + 60;
        this._enter("idle", null);
      }
    }
  }

  _actFollow() {
    const c = this.creature;
    const L = this._leader();
    if (!L) return;
    const lx = L.position.x;
    const lz = L.position.z;
    let gx = lx;
    let gz = lz;
    const lspeed = num(L.speed, 0);
    if (lspeed > 0.5) {
      const a = L.heading + this._slotA;
      gx = lx + Math.sin(a) * this._slotR;
      gz = lz + Math.cos(a) * this._slotR;
    }
    const dd = this._distToXZ(gx, gz);
    const ld = this._distToXZ(lx, lz);
    let mag;
    if (dd > 16) mag = TROT;
    else if (dd > 7) mag = lspeed > this._walkSpeed * 1.25 ? TROT : JOG * 0.75;
    else mag = lspeed > 0.5 ? clamp(lspeed / Math.max(0.5, this._walkSpeed) * 0.4, 0.2, 0.5) : 0;
    if (lspeed <= 0.5 && ld < this._herdR * 0.7) mag = 0;
    const sprint = !!(L.intent && L.intent.sprint) && dd > 10;
    if (mag > 0) this._goTo(gx, gz, mag, sprint, !!(L.crouching && this._carn));
    // Alignment with a moving leader keeps the herd flowing together.
    if (mag > 0 && lspeed > 0.5) {
      this._gx += Math.sin(L.heading) * 0.3;
      this._gz += Math.cos(L.heading) * 0.3;
    }
  }

  _actWander() {
    const c = this.creature;
    const p = this._destPt;
    const d = this._distToXZ(p.x, p.z);
    const arrive = 4 + radiusOf(c);
    if (d < arrive) {
      this._arrived = true;
      return;
    }
    let mag = this.mode === "patrol" || (this._carn && this._night) ? JOG : WALK;
    // Leaders wait for stragglers.
    if (this.group && this._herdN > 0 && !this._leader()) {
      const behind = this._distToXZ(this._herdCX, this._herdCZ);
      if (behind > this._herdR * 1.6) mag = AMBLE;
    }
    this._goTo(p.x, p.z, mag, false, false, arrive);
  }

  _actInvestigate(dt) {
    const p = this._invPt;
    const d = this._distToXZ(p.x, p.z);
    const stop = this._carn ? 6 : 14;
    if (this.mode !== "search") {
      if (d > stop) {
        const crouch = this._carn && d < 40 && this._style.ambush;
        this._goTo(p.x, p.z, JOG, false, crouch, stop);
        return null;
      }
      this.mode = "search";
      this._invSearchT = 0;
      this._invUntil = Math.min(this._invUntil, this._now + rand(this.rng, 8, 14));
    }
    // Nose around the spot.
    this._invSearchT -= dt;
    if (this._invSearchT <= 0) {
      this._invSearchT = rand(this.rng, 3, 5);
      const a = rand(this.rng, -Math.PI, Math.PI);
      const r = rand(this.rng, 4, 14);
      this._searchPt.x = p.x + Math.sin(a) * r;
      this._searchPt.z = p.z + Math.cos(a) * r;
    }
    const sd = this._distToXZ(this._searchPt.x, this._searchPt.z);
    if (sd > 2.5) this._goTo(this._searchPt.x, this._searchPt.z, AMBLE, false, false, 2);
    return this._searchPt;
  }

  _actIdle(dt) {
    const c = this.creature;
    // Idle animals look about; herd members drift back toward the leader.
    this._lookT -= dt;
    if (this._lookT <= 0) {
      this._lookT = rand(this.rng, 2.5, 6);
      const a = c.heading + rand(this.rng, -1.4, 1.4);
      this._lookPt.x = c.position.x + Math.sin(a) * 25;
      this._lookPt.z = c.position.z + Math.cos(a) * 25;
    }
    const L = this._leader();
    if (L && this._leaderD > this._herdR * 0.8) this._goTo(L.position.x, L.position.z, AMBLE);
    return this._watchLook() || this._lookPt;
  }

  /* --- Steering ------------------------------------------------------- */

  _steer(dt) {
    const c = this.creature;
    const it = c.intent;
    if (!it) return;
    const now = this._now;
    it.sprint = this._gsprint;
    it.crouch = this._gcrouch;
    it.eat = this._geat;
    it.drink = this._gdrink;
    it.rest = this._grest;
    if (this._gbite) it.bite = true;
    if (this._gcall) it.call = true;

    let gx = this._gx;
    let gz = this._gz;
    let mag = this._gmag;
    const terrain = this.world.terrain;

    // Pushed out of bounds or into water we shouldn't be in: get back first.
    if (terrain && mag < 0.05 && !this._geat && !this._gdrink && (!terrain.inBounds(c.position.x, c.position.z, EDGE_MARGIN * 0.5) || (c.swimming && !this._allowWater))) {
      gx = Math.sin(c.heading);
      gz = Math.cos(c.heading);
      mag = WALK;
    }
    if (mag < 0.02) {
      it.moveX = 0;
      it.moveZ = 0;
      this._stuckT = 0;
      return;
    }
    let l = Math.hypot(gx, gz);
    if (l < 1e-6) {
      gx = Math.sin(c.heading);
      gz = Math.cos(c.heading);
      l = 1;
    }
    gx /= l;
    gz /= l;

    if (terrain) {
      // Out past the margin: home in on the island's centre.
      if (!terrain.inBounds(c.position.x, c.position.z, EDGE_MARGIN)) {
        const cl = Math.hypot(c.position.x, c.position.z) || 1;
        gx = gx * 0.3 - (c.position.x / cl) * 0.7;
        gz = gz * 0.3 - (c.position.z / cl) * 0.7;
        const nl = Math.hypot(gx, gz) || 1;
        gx /= nl;
        gz /= nl;
      }
      // A detour (unsticking) overrides the goal for a moment.
      if (now < this._detourUntil) {
        gx = gx * 0.25 + this._detourX * 0.75;
        gz = gz * 0.25 + this._detourZ * 0.75;
        const nl = Math.hypot(gx, gz) || 1;
        gx /= nl;
        gz /= nl;
      }
      if (!this._direct) {
        this._steerT -= dt;
        if (this._steerT <= 0) {
          this._steerT += STEER_INTERVAL;
          if (this._steerT < 0) this._steerT = STEER_INTERVAL;
          this._computeAvoid(gx, gz);
          this._shoreOn = c.swimming && !this._allowWater;
          if (this._shoreOn) this._towardShore();
        }
        if (this._avoidAngle !== 0) {
          const a = yawFromDir(gx, gz) + this._avoidAngle;
          gx = Math.sin(a);
          gz = Math.cos(a);
        }
        if (this._shoreOn && c.swimming) {
          gx = gx * 0.3 + this._shoreX * 0.7;
          gz = gz * 0.3 + this._shoreZ * 0.7;
        }
      } else this._avoidAngle = 0;
    }
    it.moveX = gx * mag;
    it.moveZ = gz * mag;
    this._checkStuck(dt, mag);
  }

  // Probe the 3-feeler fan at two distances; if the way ahead is blocked,
  // swing the fan toward the clearer side (sticky, so it doesn't flicker).
  _computeAvoid(gx, gz) {
    const c = this.creature;
    const veg = this.world.vegetation;
    const px = c.position.x;
    const pz = c.position.z;
    const r = radiusOf(c);
    const near = clamp(r * 2 + num(c.speed, 0) * 0.9, 3, 14);
    const far = near * 2.2;
    let cols = EMPTY;
    if (veg && typeof veg.collidersNear === "function") cols = veg.collidersNear(px, pz, near + r + 2, _cols) || EMPTY;
    const yaw0 = yawFromDir(gx, gz);
    const h0 = this.world.terrain.heightAt(px, pz);

    // Probe triple first.
    const cCenter = this._feelerCost(yaw0, near, far, h0, cols);
    if (cCenter < 0.3) {
      this._avoidHold -= STEER_INTERVAL;
      // Ease back to the straight line once it's been clear for a moment.
      if (this._avoidHold <= 0) this._avoidAngle = 0;
      else if (this._feelerCost(yaw0 + this._avoidAngle, near, far, h0, cols) >= 0.3) this._avoidAngle = 0;
      this._cornered = false;
      cols.length = 0;
      return;
    }
    const cL = this._feelerCost(yaw0 + 0.6, near, far, h0, cols);
    const cR = this._feelerCost(yaw0 - 0.6, near, far, h0, cols);
    if (this._avoidHold <= 0 || Math.abs(cL - cR) > 0.4) this._avoidSide = cL < cR ? 1 : cL > cR ? -1 : this._avoidSide;
    let bestA = 0;
    let bestC = cCenter;
    for (let i = 1; i < FEELERS.length; i += 2) {
      const a = FEELERS[i] * this._avoidSide;
      const cost = i === 1 ? (this._avoidSide > 0 ? cL : cR) : this._feelerCost(yaw0 + a, near, far, h0, cols);
      if (cost < bestC) {
        bestC = cost;
        bestA = a;
      }
      if (cost < 0.3) break;
      // Try the other side at the same spread before widening further.
      const b = -a;
      const cost2 = i === 1 ? (this._avoidSide > 0 ? cR : cL) : this._feelerCost(yaw0 + b, near, far, h0, cols);
      if (cost2 < bestC) {
        bestC = cost2;
        bestA = b;
      }
      if (cost2 < 0.3) break;
    }
    this._avoidAngle = bestA;
    this._avoidHold = 1.2;
    this._cornered = bestC >= 0.6 && this.state === "flee";
    cols.length = 0;
  }

  _feelerCost(yaw, near, far, h0, cols) {
    const c = this.creature;
    const px = c.position.x;
    const pz = c.position.z;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const nx = px + fx * near;
    const nz = pz + fz * near;
    let cost = this._hazard(nx, nz, h0, near) + 0.6 * this._hazard(px + fx * far, pz + fz * far, h0, far);
    // Tree trunks / boulders across the near segment.
    const r = radiusOf(c) * 0.9;
    for (let i = 0; i < cols.length; i++) {
      const k = cols[i];
      const t = clamp((k.x - px) * fx + (k.z - pz) * fz, 0, near);
      const qx = px + fx * t - k.x;
      const qz = pz + fz * t - k.z;
      const rr = num(k.r, 0.5) + r;
      if (qx * qx + qz * qz < rr * rr) {
        cost += 0.7;
        break;
      }
    }
    return cost;
  }

  _hazard(x, z, h0, dist) {
    const t = this.world.terrain;
    if (!t.inBounds(x, z, EDGE_MARGIN)) return 1;
    const h = t.heightAt(x, z);
    const depth = num(t.seaLevel, 0) - h;
    if (depth > 0) {
      const hip = hipOf(this.creature);
      if (!this._allowWater) {
        if (depth > hip * 0.7) return 1;
      } else if (!this._swimmer && depth > hip * 1.5 && typeof t.isFreshWater === "function" && !t.isFreshWater(x, z)) {
        return 0.8; // the open sea is never worth it for a poor swimmer
      }
    }
    if (Math.abs(h - h0) / Math.max(1, dist) > GRADE_HARD) return 0.9;
    const slope = t.slopeAt(x, z);
    if (slope > SLOPE_HARD) return 0.9;
    if (slope > SLOPE_SOFT) return ((slope - SLOPE_SOFT) / (SLOPE_HARD - SLOPE_SOFT)) * 0.4;
    return 0;
  }

  // Swimming where we shouldn't: head for the shallowest of 8 directions.
  _towardShore() {
    const c = this.creature;
    const t = this.world.terrain;
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      const depth = t.waterDepthAt(c.position.x + sx * 10, c.position.z + sz * 10);
      if (depth < best) {
        best = depth;
        bx = sx;
        bz = sz;
      }
    }
    this._shoreX = bx;
    this._shoreZ = bz;
  }

  // No progress for a few seconds → take a detour; repeated → new destination.
  _checkStuck(dt, mag) {
    const c = this.creature;
    const now = this._now;
    const busy = this._geat || this._gdrink || this.state === "attack" || mag < 0.15 || this._direct;
    if (busy) {
      this._stuckT = Math.max(0, this._stuckT - dt);
      return;
    }
    const expect = this._walkSpeed * Math.min(1, mag / 0.5) * 0.3;
    if (num(c.speed, 0) < expect) this._stuckT += dt;
    else this._stuckT = Math.max(0, this._stuckT - dt * 2);

    // Orbiting a goal it can't reach also counts as stuck.
    if (Number.isFinite(this._goalD)) {
      this._progT += dt;
      if (this._progT > 4) {
        if (this._goalD > this._progD - 1.5 && this._goalD > 6) this._stuckT = Math.max(this._stuckT, 2.6);
        this._progD = this._goalD;
        this._progT = 0;
      }
    }

    if (this._stuckT > 2.5) {
      this._stuckT = 0;
      this._stuckCount++;
      const a = c.heading + this._avoidSide * rand(this.rng, 1.6, 2.6);
      this._detourX = Math.sin(a);
      this._detourZ = Math.cos(a);
      this._detourUntil = now + rand(this.rng, 2, 3.2);
      this._avoidSide = -this._avoidSide;
      if (this._stuckCount >= 3 && (this.state === "wander" || this.state === "investigate" || this.state === "graze")) {
        this._stuckCount = 0;
        this._arrived = true; // give up on this destination
        this._activityUntil = now;
        if (this.state === "graze") this.target = null;
      }
    }
  }

  _clearIntent(it) {
    it.moveX = 0;
    it.moveZ = 0;
    it.sprint = false;
    it.crouch = false;
    it.eat = false;
    it.drink = false;
    it.rest = false;
  }

  /* --- Small utilities ------------------------------------------------- */

  _distTo(o) {
    const p = this.creature.position;
    return Math.sqrt(dist2(p.x, p.z, xOf(o), zOf(o)));
  }

  _distToXZ(x, z) {
    const p = this.creature.position;
    return Math.sqrt(dist2(p.x, p.z, x, z));
  }
}
