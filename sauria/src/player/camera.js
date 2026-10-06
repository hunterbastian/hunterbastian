// ThirdPersonCamera — the survival-mode follow camera (orbit around the
// player's dinosaur, terrain/water aware, trauma shake, sprint FOV kick, slow
// orbit over a dead body) and the title screen's attract-mode flight.
// Smoothness matters doubly here: in the "pixel" render style any camera
// jitter turns into crawling pixels, so every input is filtered.

import * as THREE from "three";
import { TAU, angleDiff, clamp, damp, lerp, smoothstep } from "../core/math.js";

/* --- Tuning ----------------------------------------------------------------- */

const LOOK_SENSITIVITY = 0.0025; // rad per pixel at sensitivity 1
const PITCH_MIN = -0.3;
const PITCH_MAX = 1.2;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.2;
const ZOOM_PER_PIXEL = 0.0014; // exp(100 · k) ≈ 15 % per wheel notch

const FOCUS_HEIGHT = 1.3; // × scaled hip height
const GROUND_CLEARANCE = 0.6; // m above terrain at the camera
const WATER_CLEARANCE = 0.4; // m above the water surface
const RAY_SAMPLES = 12;
const MAX_ELEVATION = 1.38; // rad — collision lift never pushes past near-overhead
const SPRINT_FOV_KICK = 6; // degrees
const TELEPORT_DIST = 30; // m jump between frames → snap instead of smoothing
const BLEND_MAX_TRAVEL = 700; // m — title flight → follow swoop only when closer than this
const COLLIDER_QUERY_RADIUS = 4; // m around the camera searched for trunks / boulders
const COLLIDER_CLEARANCE = 0.45; // m kept between the camera and a trunk

const DEAD_ORBIT_SPEED = 0.14; // rad/s
const DEAD_PITCH = 0.55;

// Attract mode.
const CINE_SPEED = 12.5; // m/s along the path
const CINE_LOOK_AHEAD = 72; // m
const CINE_MIN_AGL = 20; // m above ground, always
const CINE_ALT_LOW = 32; // m above sea level, before terrain lifting
const CINE_ALT_HIGH = 76;
const CINE_SPACING = 4; // m between baked path samples
const CINE_MAX_GRADE = 0.3; // climb/descent per metre, so ridges are anticipated
const CINE_MAX_TURN_RATE = 0.12; // rad/s — gentle, drone-like bends
const CINE_COARSE_STEP = 20; // m between vertices of the relaxed coarse loop

const _offset = new THREE.Vector3();
const _goal = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _q = new THREE.Quaternion();

const FALLBACK_SPECIES = { length: 4, height: 1.4, speed: { sprint: 10 } };

/* --- Smooth 1D noise for shake (sum of incommensurate sines, allocation-free) --- */

function wobble(t, seed) {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.31 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.79 + seed * 2.9) * 0.2
  );
}

/* --- ThirdPersonCamera ------------------------------------------------------- */

export class ThirdPersonCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import("../world/terrain.js").Terrain} terrain
   */
  constructor(camera, terrain) {
    this.camera = camera;
    this.terrain = terrain;
    /** Orbit heading (heading convention: 0 looks along +Z). */
    this.yaw = 0;
    /** Orbit elevation, radians; positive = camera above, looking down. */
    this.pitch = 0.32;
    /** Distance multiplier 0.6..2.2 (target; the applied value is smoothed). */
    this.zoom = 1;
    /** Look sensitivity multiplier (settings: 0.5..2). */
    this.sensitivity = 1;
    /** Invert vertical look. */
    this.invertY = false;
    /** Gently swing behind a moving creature when the player isn't steering the camera (touch). */
    this.autoFollow = false;
    /** FOV the camera returns to; main may change it (e.g. wider in portrait). */
    this.baseFov = camera.fov;
    /** "follow" | "cinematic" — whichever was driven last. */
    this.mode = "follow";
    /** Smoothed point the orbit is centred on (world). */
    this.focus = new THREE.Vector3();
    /**
     * Optional obstacle source with `collidersNear(x, z, radius, out)` →
     * [{ x, z, r }] (e.g. world.vegetation): the camera slides around them.
     */
    this.colliders = null;

    this._zoom = 1;
    this._lift = 0;
    this._pull = 1;
    this._fovKick = 0;
    this._trauma = 0;
    this._shakeT = 0;
    this._sinceLook = 99;
    this._deadT = 0;
    this._snap = true;
    this._lastPos = new THREE.Vector3();
    this._lead = new THREE.Vector3();
    this._blend = { t: 0, dur: 0, travel: 0, from: new THREE.Vector3(), fromQ: new THREE.Quaternion() };
    this._cine = null;
    this._colliderOut = [];
  }

  /* --- Input ----------------------------------------------------------------- */

  /**
   * Orbit by a pointer delta.
   * @param {number} dx pixels, + = turn right
   * @param {number} dy pixels, + = look down (camera rises)
   */
  addLook(dx, dy) {
    if (!dx && !dy) return;
    const k = LOOK_SENSITIVITY * this.sensitivity;
    // Right is −X when facing +Z, so turning right lowers the yaw.
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch + dy * k * (this.invertY ? -1 : 1), PITCH_MIN, PITCH_MAX);
    if (this.yaw > Math.PI || this.yaw < -Math.PI) this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    this._sinceLook = 0;
  }

  /**
   * Zoom by a wheel delta (≈100 per notch, + = farther). Multiplicative so
   * each notch feels the same near and far.
   */
  addZoom(delta) {
    if (!delta) return;
    this.zoom = clamp(this.zoom * Math.exp(delta * ZOOM_PER_PIXEL), ZOOM_MIN, ZOOM_MAX);
  }

  /**
   * Add trauma (0..1). Shake strength is trauma², so small hits barely
   * register and big ones rattle; it bleeds off over ~0.7 s.
   */
  shake(amount) {
    this._trauma = clamp(this._trauma + Math.max(0, amount), 0, 1);
  }

  /** Skip smoothing on the next update (spawn, respawn, teleport). */
  snap() {
    this._snap = true;
  }

  /**
   * Horizontal unit vector the camera looks along — what "forward" means for movement.
   * @param {THREE.Vector3} [target]
   */
  forward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /* --- Follow ------------------------------------------------------------------ */

  /**
   * Smooth orbit-follow of a creature: focus above its hips, distance from its
   * size and the zoom, kept clear of terrain and water; a slow orbit when dead.
   * @param {number} dt seconds
   * @param {object} creature a Creature (position, species, scale, alive, speed, gait, heading, velocity)
   */
  update(dt, creature) {
    if (!creature || !creature.position) return;
    const cam = this.camera;
    if (this.mode !== "follow") this._beginBlendFromCurrent();

    const sp = creature.species && typeof creature.species === "object" ? creature.species : FALLBACK_SPECIES;
    const scale = Number.isFinite(creature.scale) ? creature.scale : 1;
    const hip = (sp.height ?? FALLBACK_SPECIES.height) * scale;
    const length = (sp.length ?? FALLBACK_SPECIES.length) * scale;
    const p = creature.position;
    const dead = creature.alive === false;

    if (!this._snap && this._lastPos.distanceToSquared(p) > TELEPORT_DIST * TELEPORT_DIST) this._snap = true;
    this._lastPos.copy(p);
    const snap = this._snap;
    this._snap = false;
    this._sinceLook += dt;

    /* Dead: drift around the body. */
    if (dead) {
      this._deadT += dt;
      this.yaw += DEAD_ORBIT_SPEED * dt * smoothstep(0.5, 3, this._deadT);
      this.pitch = damp(this.pitch, DEAD_PITCH, 0.7, dt);
    } else {
      this._deadT = 0;
      this._autoFollow(dt, creature);
    }

    /* Zoom & distance. */
    const zoomGoal = dead ? Math.max(this.zoom, 1.35) : this.zoom;
    this._zoom = snap ? zoomGoal : damp(this._zoom, zoomGoal, 7, dt);
    const dist = (length * 0.9 + 2.5) * this._zoom;

    /* Focus point, with a small lead in the direction of travel. */
    const v = creature.velocity;
    if (!dead && v) {
      const lead = Math.min(0.18, 1.2 / Math.max(1, Math.hypot(v.x, v.z)));
      _goal.set(v.x * lead, 0, v.z * lead);
      const maxLead = length * 0.25 + 0.3;
      if (_goal.lengthSq() > maxLead * maxLead) _goal.setLength(maxLead);
    } else {
      _goal.set(0, 0, 0);
    }
    if (snap) this._lead.copy(_goal);
    else this._lead.lerp(_goal, 1 - Math.exp(-3 * dt));

    const focusH = dead ? hip * 0.55 : hip * FOCUS_HEIGHT;
    _goal.set(p.x + this._lead.x, p.y + focusH, p.z + this._lead.z);
    const f = this.focus;
    if (snap) {
      f.copy(_goal);
    } else {
      // Vertical is softer so gait bob and terrain steps don't jolt the view.
      f.x = damp(f.x, _goal.x, 11, dt);
      f.z = damp(f.z, _goal.z, 11, dt);
      f.y = damp(f.y, _goal.y, 6, dt);
    }

    /* Ideal orbit position. */
    const cp = Math.cos(this.pitch);
    _offset.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    /* Collision: lift over terrain between focus and camera, then pull in. */
    const liftGoal = this._requiredLift(f, _offset, dist);
    this._lift = snap ? liftGoal : damp(this._lift, liftGoal, liftGoal > this._lift ? 14 : 2.2, dt);
    _pos.copy(f).addScaledVector(_offset, dist);
    _pos.y += this._lift;
    const pullGoal = this._clearFraction(f, _pos);
    this._pull = snap ? pullGoal : damp(this._pull, pullGoal, pullGoal < this._pull ? 18 : 2.4, dt);
    _pos.sub(f).multiplyScalar(this._pull).add(f);

    this._avoidColliders(_pos);
    // Hard floor at the camera itself — never inside the ground or under water.
    const floor = this._surface(_pos.x, _pos.z) + GROUND_CLEARANCE;
    if (_pos.y < floor) _pos.y = floor;

    cam.position.copy(_pos);
    _look.set(f.x, f.y + dist * 0.07, f.z); // creature sits a touch below centre
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);

    this._applyBlend(dt);
    this._applyShake(dt, dist);

    /* Sprint FOV kick. */
    const sprintSpeed = (sp.speed?.sprint ?? 10) * Math.max(0.35, scale);
    const sprinting =
      !dead && (creature.gait === "sprint" || (creature.gait == null && creature.speed > sprintSpeed * 0.8));
    this._fovKick = damp(this._fovKick, sprinting ? SPRINT_FOV_KICK : 0, sprinting ? 2.5 : 3.5, dt);
    this._setFov(this.baseFov + this._fovKick);
    this.mode = "follow";
  }

  /** Touch: ease the orbit behind a creature that's running, unless the player steered recently. */
  _autoFollow(dt, creature) {
    if (!this.autoFollow || this._sinceLook < 1.4) return;
    const speed = creature.speed || 0;
    if (speed < 1.2 || !Number.isFinite(creature.heading)) return;
    const diff = angleDiff(this.yaw, creature.heading);
    // Don't whip around when running toward the camera.
    if (Math.abs(diff) > 2.2) return;
    const rate = 0.6 * Math.min(1, speed / 6);
    this.yaw += diff * (1 - Math.exp(-rate * dt));
  }

  /**
   * Keep the camera out of tree trunks and boulders by sliding it sideways
   * around them (a spring-arm pull-in would make it zip in and out of every
   * forest). Uses `this.colliders.collidersNear(x, z, r, out)` when set.
   */
  _avoidColliders(p) {
    const src = this.colliders;
    if (!src || typeof src.collidersNear !== "function") return;
    const out = this._colliderOut;
    out.length = 0;
    let list;
    try {
      list = src.collidersNear(p.x, p.z, COLLIDER_QUERY_RADIUS, out) || out;
    } catch {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const min = (o.r ?? 0.4) + COLLIDER_CLEARANCE;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-4) {
        // Dead centre: step out toward the focus side.
        p.x = o.x + (this.focus.x - o.x > 0 ? min : -min);
        continue;
      }
      p.x = o.x + (dx / d) * min;
      p.z = o.z + (dz / d) * min;
    }
    out.length = 0;
  }

  /** Ground or water surface height under a point (water counts as surface). */
  _surface(x, z) {
    const t = this.terrain;
    const sea = t?.seaLevel ?? 0;
    const h = t ? t.heightAt(x, z) : sea;
    // Water floor + 0.6 clearance lands exactly WATER_CLEARANCE above the surface.
    return Math.max(h, sea + WATER_CLEARANCE - GROUND_CLEARANCE);
  }

  /**
   * How far the camera must rise (m) so the focus→camera segment clears the
   * terrain over its outer part. Rising beats pulling in on a heightfield:
   * the view tilts down over the hill instead of jamming into the creature.
   */
  _requiredLift(f, dir, dist) {
    const camY = f.y + dir.y * dist;
    let need = 0;
    for (let i = 4; i <= RAY_SAMPLES; i++) {
      const t = i / RAY_SAMPLES;
      const x = f.x + dir.x * dist * t;
      const z = f.z + dir.z * dist * t;
      const req = this._surface(x, z) + lerp(0.3, GROUND_CLEARANCE, t);
      const rayY = f.y + dir.y * dist * t;
      if (rayY < req) {
        // Camera height that lifts this sample of the segment to `req`.
        const y = f.y + (req - f.y) / t;
        if (y - camY > need) need = y - camY;
      }
    }
    // Cap at a near-overhead view; anything beyond is solved by pulling in.
    const horiz = Math.hypot(dir.x, dir.z) * dist;
    const maxY = f.y + horiz * Math.tan(MAX_ELEVATION);
    return Math.max(0, Math.min(need, maxY - camY));
  }

  /** Fraction (0.15..1) of the focus→camera segment that is clear of terrain. */
  _clearFraction(f, c) {
    const dx = c.x - f.x;
    const dy = c.y - f.y;
    const dz = c.z - f.z;
    let prev = 0;
    for (let i = 1; i <= RAY_SAMPLES; i++) {
      const t = i / RAY_SAMPLES;
      const y = f.y + dy * t;
      const req = this._surface(f.x + dx * t, f.z + dz * t) + lerp(0.1, GROUND_CLEARANCE * 0.8, t);
      if (y < req) {
        // Refine between the last clear sample and this one.
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 4; k++) {
          const m = (lo + hi) * 0.5;
          const ym = f.y + dy * m;
          if (ym < this._surface(f.x + dx * m, f.z + dz * m) + lerp(0.1, GROUND_CLEARANCE * 0.8, m)) hi = m;
          else lo = m;
        }
        return Math.max(0.15, lo - 0.04);
      }
      prev = t;
    }
    return 1;
  }

  _beginBlendFromCurrent() {
    // Coming out of the attract flight: swoop from where the camera is now
    // down into the follow pose instead of cutting. Duration is decided on
    // the first follow frame, once the destination is known.
    const b = this._blend;
    b.from.copy(this.camera.position);
    b.fromQ.copy(this.camera.quaternion);
    b.t = 0;
    b.dur = -1;
    this._snap = true;
    this.camera.up.set(0, 1, 0);
  }

  _applyBlend(dt) {
    const b = this._blend;
    const cam = this.camera;
    if (b.dur < 0) {
      b.travel = b.from.distanceTo(cam.position);
      // Across half the island a swoop reads as a glitch — just cut.
      b.dur = b.travel > BLEND_MAX_TRAVEL ? 0 : clamp(1.4 + b.travel / 220, 1.4, 3.2);
      b.t = 0;
    }
    if (b.t >= b.dur) return;
    b.t = Math.min(b.dur, b.t + dt);
    const k = smoothstep(0, 1, b.t / b.dur);
    _pos.lerpVectors(b.from, cam.position, k);
    // Arc upward so the swoop clears hills between the two poses.
    _pos.y += Math.sin(Math.PI * k) * Math.min(50, b.travel * 0.2);
    const floor = this._surface(_pos.x, _pos.z) + GROUND_CLEARANCE;
    if (_pos.y < floor) _pos.y = floor;
    cam.position.copy(_pos);
    _q.copy(cam.quaternion);
    cam.quaternion.slerpQuaternions(b.fromQ, _q, k);
  }

  _applyShake(dt, dist) {
    if (this._trauma <= 0) return;
    this._trauma = Math.max(0, this._trauma - dt * 1.4);
    this._shakeT += dt;
    const s = this._trauma * this._trauma;
    const t = this._shakeT * 22;
    const cam = this.camera;
    // Mostly rotational (reads as impact without moving through geometry);
    // a little positional sway that scales with the camera distance.
    cam.rotateY(wobble(t, 1.3) * 0.045 * s);
    cam.rotateX(wobble(t, 4.1) * 0.035 * s);
    cam.rotateZ(wobble(t, 7.7) * 0.03 * s);
    const amp = (0.08 + dist * 0.012) * s;
    cam.translateX(wobble(t * 0.8, 2.2) * amp);
    cam.translateY(wobble(t * 0.8, 5.6) * amp);
  }

  _setFov(fov) {
    const cam = this.camera;
    if (Math.abs(cam.fov - fov) < 0.01) return;
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }

  /* --- Attract mode -------------------------------------------------------------- */

  /**
   * Title-screen flight: a slow looping glide along the coast and over the
   * lakes, 30–80 m up and always ≥ 20 m above the ground, looking ahead and
   * down, banking gently through turns. Call every frame while the menu shows;
   * a dt > 1 s jumps along the path without smoothing.
   * @param {number} dt seconds
   * @param {import("../world/terrain.js").Terrain} [terrain]
   */
  cinematic(dt, terrain = this.terrain) {
    if (!terrain) return;
    if (!this._cine || this._cine.terrain !== terrain) this._cine = buildCinePath(terrain);
    const c = this._cine;
    const cam = this.camera;
    const jump = this.mode !== "cinematic" || dt > 1;
    this.mode = "cinematic";
    this._blend.t = 0;
    this._blend.dur = 0;
    this._fovKick = 0;
    this._setFov(this.baseFov);

    c.s = (((c.s + CINE_SPEED * dt) % c.length) + c.length) % c.length;
    c.sample(c.s, _pos);
    // Safety net for terrain detail finer than the baked samples (rarely engages).
    const minY = Math.max(terrain.seaLevel ?? 0, terrain.heightAt(_pos.x, _pos.z)) + CINE_MIN_AGL;
    if (_pos.y < minY) _pos.y = minY;
    c.sample(c.s + CINE_LOOK_AHEAD, _look);
    // Aim between the ground and the flight line ahead → a slight downward gaze.
    const groundAhead = Math.max(terrain.seaLevel ?? 0, terrain.heightAt(_look.x, _look.z));
    _look.y = lerp(groundAhead, _look.y, 0.5);

    const ease = jump ? 1 : 1 - Math.exp(-1.1 * dt);
    if (jump) c.look.copy(_look);
    else c.look.lerp(_look, ease);

    // Bank into turns: heading change across ±18 m of path → turn rate.
    const turn = (angleDiff(c.headingAt(c.s - 18), c.headingAt(c.s + 18)) / 36) * CINE_SPEED;
    const rollGoal = clamp(turn * 0.8, -0.085, 0.085);
    c.roll = jump ? rollGoal : damp(c.roll, rollGoal, 0.9, dt);

    cam.position.copy(_pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(c.look);
    cam.rotateZ(c.roll);

    // Keep yaw/pitch meaningful for anything that reads them (HUD compass).
    this.yaw = Math.atan2(c.look.x - _pos.x, c.look.z - _pos.z);
    this._snap = true;
  }

  /**
   * The baked attract-mode path as a flat [x, y, z, …] array (debug / map overlay).
   * @returns {Float32Array | null}
   */
  get cinematicPath() {
    const c = this._cine;
    if (!c) return null;
    const out = new Float32Array(c.n * 3);
    for (let i = 0; i < c.n; i++) {
      out[i * 3] = c.px[i];
      out[i * 3 + 1] = c.alt[i];
      out[i * 3 + 2] = c.pz[i];
    }
    return out;
  }
}

/* --- Attract-mode path baking ------------------------------------------------------- */

/**
 * Build a closed flight path for a terrain: coast waypoints all round the
 * island plus every fresh lake, ordered by angle around the island's centre,
 * joined with a centripetal Catmull-Rom spline, resampled every few metres,
 * and given a terrain-following altitude profile (anticipating ridges,
 * smoothed, never below ground + 20 m).
 */
function buildCinePath(terrain) {
  const sea = terrain.seaLevel ?? 0;
  const half = terrain.half ?? (terrain.size ?? 1600) / 2;
  const H = (x, z) => terrain.heightAt(x, z);

  /* Island centre = centroid of land on a coarse grid. */
  let cx = 0;
  let cz = 0;
  let land = 0;
  const step = half / 24;
  for (let z = -half; z <= half; z += step) {
    for (let x = -half; x <= half; x += step) {
      if (H(x, z) > sea + 0.5) {
        cx += x;
        cz += z;
        land++;
      }
    }
  }
  if (land > 0) {
    cx /= land;
    cz /= land;
  }

  /* Coast radius per bearing (last land when marching outward). */
  const K = 14;
  const waypoints = [];
  for (let k = 0; k < K; k++) {
    const a = (k / K) * TAU + 0.21;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    let last = 0;
    for (let r = 0; r < half * 1.15; r += 6) {
      if (H(cx + sa * r, cz + ca * r) > sea + 0.3) last = r;
    }
    if (last < 40) continue;
    // Just inside the beach line: surf on one side, land on the other.
    const r = last - 18;
    waypoints.push({ a, x: cx + sa * r, z: cz + ca * r, lake: false });
  }

  /* Lakes: the terrain's authored list when present, else sampled fresh water. */
  const lakes = [];
  if (Array.isArray(terrain.lakes) && terrain.lakes.length) {
    for (const l of terrain.lakes) if (Number.isFinite(l.x) && Number.isFinite(l.z)) lakes.push({ x: l.x, z: l.z });
  } else if (typeof terrain.isFreshWater === "function") {
    const cell = 24;
    const buckets = [];
    for (let z = -half; z <= half; z += cell) {
      for (let x = -half; x <= half; x += cell) {
        if (!terrain.isFreshWater(x, z)) continue;
        let b = buckets.find((q) => (q.x / q.n - x) ** 2 + (q.z / q.n - z) ** 2 < 110 * 110);
        if (!b) buckets.push((b = { x: 0, z: 0, n: 0 }));
        b.x += x;
        b.z += z;
        b.n++;
      }
    }
    for (const b of buckets) if (b.n >= 3) lakes.push({ x: b.x / b.n, z: b.z / b.n });
  }
  for (const l of lakes) {
    waypoints.push({ a: Math.atan2(l.x - cx, l.z - cz), x: l.x, z: l.z, lake: true });
  }

  if (waypoints.length < 4) {
    // No usable island (tiny test terrain): a plain circle.
    waypoints.length = 0;
    const r = half * 0.45;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      waypoints.push({ a, x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r, lake: false });
    }
  }

  /* Order by bearing; coast points crowding a lake's bearing make hairpins — drop them. */
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  waypoints.sort((p, q) => norm(p.a) - norm(q.a));
  const lakeBearings = waypoints.filter((w) => w.lake).map((w) => w.a);
  let pts = waypoints.filter(
    (w) => w.lake || !lakeBearings.some((b) => Math.abs(angleDiff(w.a, b)) < (TAU / K) * 0.55)
  );
  pts = removeSharpCorners(pts, 2.0);

  // Coarse spline → relax until no bend is sharper than the turn-rate budget
  // (a hairpin diffuses into a wide sweep) → fine spline through the result.
  const coarseCurve = new THREE.CatmullRomCurve3(
    pts.map((w) => new THREE.Vector3(w.x, 0, w.z)),
    true,
    "centripetal"
  );
  const coarseN = Math.max(24, Math.round(coarseCurve.getLength() / CINE_COARSE_STEP));
  const coarse = coarseCurve.getSpacedPoints(coarseN);
  coarse.pop(); // closed: the last point repeats the first
  relaxTurns(coarse, (CINE_MAX_TURN_RATE * CINE_COARSE_STEP) / CINE_SPEED);

  const curve = new THREE.CatmullRomCurve3(coarse, true, "centripetal");
  const approxLen = curve.getLength();
  const n = Math.max(64, Math.ceil(approxLen / CINE_SPACING));
  const spaced = curve.getSpacedPoints(n);
  spaced.pop();
  const count = spaced.length;
  let px = new Float32Array(count);
  let pz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = spaced[i].x;
    pz[i] = spaced[i].z;
  }

  /* A few Laplacian passes iron out the spline's knots for steady banking. */
  for (let it = 0; it < 12; it++) {
    const nx = new Float32Array(count);
    const nz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      nx[i] = px[i] * 0.5 + (px[a] + px[b]) * 0.25;
      nz[i] = pz[i] * 0.5 + (pz[a] + pz[b]) * 0.25;
    }
    px = nx;
    pz = nz;
  }

  /* Re-measure (relaxing shortened it) for exact arc-length lookups. */
  const cum = new Float32Array(count + 1);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    cum[i + 1] = cum[i] + Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  const length = cum[count];

  /* Altitude: wandering 32–76 m, lifted to clear ground + 20 m (with a margin
     sampled around the path), slope-limited so climbs start before ridges. */
  const alt = new Float32Array(count);
  const floorAlt = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = px[i];
    const z = pz[i];
    // Two rings around the sample catch peaks between samples and beside the line.
    let g = Math.max(sea, H(x, z));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      g = Math.max(g, H(x + sa * 10, z + ca * 10), H(x + sa * 24, z + ca * 24));
    }
    floorAlt[i] = g + CINE_MIN_AGL + 2;
    const u = cum[i] / length;
    const wave = 0.5 + 0.5 * Math.sin(u * TAU * 3 + 1.1) * 0.75 + 0.5 * Math.sin(u * TAU * 7 + 0.4) * 0.25;
    alt[i] = Math.max(floorAlt[i], lerp(CINE_ALT_LOW, CINE_ALT_HIGH, wave));
  }
  const ds = length / count;
  const gradeLimit = (arr) => {
    const g = CINE_MAX_GRADE * ds;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < count * 2; i++) {
        const a = i % count;
        const b = (i - 1) % count;
        if (arr[a] < arr[b] - g) arr[a] = arr[b] - g;
      }
      for (let i = count * 2 - 2; i >= 0; i--) {
        const a = i % count;
        const b = (i + 1) % count;
        if (arr[a] < arr[b] - g) arr[a] = arr[b] - g;
      }
    }
  };
  gradeLimit(alt);
  // Box-blur for soft vertical motion, then re-assert the floor and grade.
  const tmp = new Float32Array(count);
  for (let pass = 0; pass < 3; pass++) {
    const w = 8;
    for (let i = 0; i < count; i++) {
      let s = 0;
      for (let k = -w; k <= w; k++) s += alt[(i + k + count) % count];
      tmp[i] = s / (2 * w + 1);
    }
    for (let i = 0; i < count; i++) alt[i] = Math.max(tmp[i], floorAlt[i]);
  }
  gradeLimit(alt);

  // Open the title on the approach to a lake — the most striking first frame.
  let startS = 0;
  const firstLake = lakes[0];
  if (firstLake) {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const d = (px[i] - firstLake.x) ** 2 + (pz[i] - firstLake.z) ** 2;
      if (d < best) {
        best = d;
        startS = cum[i];
      }
    }
    startS = (startS - 260 + length) % length;
  }

  const path = {
    terrain,
    n: count,
    px,
    pz,
    alt,
    length,
    s: startS,
    roll: 0,
    look: new THREE.Vector3(),
    /** Position at arc length s (wraps), into `out`. */
    sample(s, out) {
      s = ((s % length) + length) % length;
      // Uniform-ish spacing → index guess, then walk to the exact segment.
      let i = Math.min(count - 1, Math.floor((s / length) * count));
      while (i > 0 && cum[i] > s) i--;
      while (i < count - 1 && cum[i + 1] <= s) i++;
      const j = (i + 1) % count;
      const segLen = cum[i + 1] - cum[i] || 1;
      const t = (s - cum[i]) / segLen;
      return out.set(lerp(px[i], px[j], t), lerp(alt[i], alt[j], t), lerp(pz[i], pz[j], t));
    },
    /** Travel heading (heading convention) at arc length s. */
    headingAt(s) {
      s = ((s % length) + length) % length;
      const i = Math.min(count - 1, Math.floor((s / length) * count));
      const j = (i + 1) % count;
      return Math.atan2(px[j] - px[i], pz[j] - pz[i]);
    },
  };
  return path;
}

/**
 * Relax a closed polyline in place until every vertex turns by at most
 * `maxTurn` radians: offending vertices slide toward their neighbours'
 * midpoint, which spreads a sharp bend over more of the loop.
 */
function relaxTurns(pts, maxTurn) {
  const n = pts.length;
  for (let it = 0; it < 1500; it++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const turn = Math.abs(angleDiff(Math.atan2(b.x - a.x, b.z - a.z), Math.atan2(c.x - b.x, c.z - b.z)));
      if (turn <= maxTurn) continue;
      if (turn > worst) worst = turn;
      b.x += ((a.x + c.x) * 0.5 - b.x) * 0.5;
      b.z += ((a.z + c.z) * 0.5 - b.z) * 0.5;
    }
    if (worst === 0) return;
  }
}

/** Drop waypoints whose turn exceeds `maxTurn` (rad), coast points first. */
function removeSharpCorners(pts, maxTurn) {
  let changed = true;
  while (changed && pts.length > 5) {
    changed = false;
    let worst = -1;
    let worstTurn = maxTurn;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const h1 = Math.atan2(b.x - a.x, b.z - a.z);
      const h2 = Math.atan2(c.x - b.x, c.z - b.z);
      // Lakes are the point of the tour, so they need a sharper turn to be cut.
      const turn = Math.abs(angleDiff(h1, h2)) * (b.lake ? 0.8 : 1);
      if (turn > worstTurn) {
        worstTurn = turn;
        worst = i;
      }
    }
    if (worst >= 0) {
      pts = pts.filter((_, i) => i !== worst);
      changed = true;
    }
  }
  return pts;
}
