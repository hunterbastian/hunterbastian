// Hunter-mode weapons: the five gun definitions, the WeaponSystem that runs a
// two-weapon loadout (switching, ammo, reloads, aiming, sway, recoil), the
// ballistics (hitscan rays and simulated crossbow bolts tested against the
// terrain heightfield, tree trunks, the water surface and dinosaur hit spheres)
// and the pooled impact effects: muzzle light, tracers, dust, splashes, wood
// chips and blood. Nothing allocates per shot; every effect comes from a pool.
//
// The first-person gun is drawn in its own little scene (see renderViewmodel)
// so it never clips into the world, and it pixelates with the world in the
// "pixel" render style because it is drawn into the same target.

import * as THREE from "three";
import { clamp, lerp, smoothstep, damp, angleDiff, TAU } from "../core/math.js";
import { createViewmodel, createBoltMesh, createViewmodelEnvironment, viewmodelUniforms } from "./viewmodel.js";

/* --- Weapon definitions --- */

// Units: damage in HP per pellet; spread values are cone half-angles in
// radians (hip / aimed / per-pellet pattern); range = metres of full damage,
// maxRange = where hitscan stops and damage has fallen to `falloff` (fraction);
// times in seconds; loudness = hearing radius in metres for the "shot" event;
// projectile = muzzle speed m/s (0 = hitscan); gravity m/s²; recoil = camera
// kick in radians; sway = aim-drift multiplier; zoom = FOV multiplier when aimed;
// scope = magnification (0 = iron sights).
export const WEAPONS = {
  revolver: {
    id: "revolver",
    name: ".44 Revolver",
    description: "Six rounds of heavy .44 — quick in the hand, honest out to forty metres.",
    kind: "pistol",
    damage: 45,
    pellets: 1,
    spread: 0.028,
    aimSpread: 0.006,
    pelletSpread: 0,
    range: 40,
    maxRange: 180,
    falloff: 0.35,
    magazine: 6,
    reserve: 36,
    fireInterval: 0.36,
    cycleTime: 0.3,
    reloadTime: 2.6,
    reloadCommit: 0.58,
    aimTime: 0.16,
    zoom: 0.85,
    scope: 0,
    reticle: null,
    loudness: 260,
    projectile: 0,
    gravity: 0,
    recoil: 0.055,
    sway: 0.35,
    tracer: false,
    unlockPoints: 0,
  },
  shotgun: {
    id: "shotgun",
    name: "Double-Barrel 12ga",
    description: "Two barrels of buckshot. Inside twenty metres, nothing on two legs argues.",
    kind: "shotgun",
    damage: 16,
    pellets: 9,
    spread: 0.03,
    aimSpread: 0.012,
    pelletSpread: 0.05,
    range: 18,
    maxRange: 80,
    falloff: 0.12,
    magazine: 2,
    reserve: 24,
    fireInterval: 0.3,
    cycleTime: 0,
    reloadTime: 2.4,
    reloadCommit: 0.66,
    aimTime: 0.2,
    zoom: 0.9,
    scope: 0,
    reticle: null,
    loudness: 320,
    projectile: 0,
    gravity: 0,
    recoil: 0.1,
    sway: 0.3,
    tracer: false,
    unlockPoints: 0,
  },
  crossbow: {
    id: "crossbow",
    name: "Crossbow",
    description: "A whisper and a broadhead. The herd never hears it — mind the drop past fifty.",
    kind: "crossbow",
    damage: 110,
    pellets: 1,
    spread: 0.022,
    aimSpread: 0.002,
    pelletSpread: 0,
    range: 60,
    maxRange: 260,
    falloff: 0.6,
    magazine: 1,
    reserve: 15,
    fireInterval: 0.5,
    cycleTime: 0,
    reloadTime: 3.4,
    reloadCommit: 0.8,
    aimTime: 0.22,
    zoom: 0.7,
    scope: 0,
    reticle: null,
    loudness: 25,
    projectile: 75,
    gravity: 9.8,
    recoil: 0.02,
    sway: 0.4,
    tracer: false,
    unlockPoints: 150,
  },
  rifle: {
    id: "rifle",
    name: "Bolt-Action Rifle",
    description: "Walnut, blued steel and a 2.5× scope. Loud, flat-shooting and patient.",
    kind: "rifle",
    damage: 140,
    pellets: 1,
    spread: 0.025,
    aimSpread: 0.0012,
    pelletSpread: 0,
    range: 220,
    maxRange: 700,
    falloff: 0.5,
    magazine: 5,
    reserve: 25,
    fireInterval: 1.15,
    cycleTime: 1.0,
    reloadTime: 3.1,
    reloadCommit: 0.7,
    aimTime: 0.26,
    zoom: 0.4,
    scope: 2.5,
    reticle: "duplex",
    loudness: 420,
    projectile: 0,
    gravity: 0,
    recoil: 0.075,
    sway: 0.45,
    tracer: true,
    unlockPoints: 0,
  },
  sniper: {
    id: "sniper",
    name: ".50 Sniper Rifle",
    description: "Half an inch of bad news at six power. Every animal for a mile hears it.",
    kind: "rifle",
    damage: 320,
    pellets: 1,
    spread: 0.04,
    aimSpread: 0.0005,
    pelletSpread: 0,
    range: 450,
    maxRange: 1100,
    falloff: 0.6,
    magazine: 3,
    reserve: 12,
    fireInterval: 1.55,
    cycleTime: 1.35,
    reloadTime: 4.2,
    reloadCommit: 0.62,
    aimTime: 0.34,
    zoom: 1 / 6,
    scope: 6,
    reticle: "mildot",
    loudness: 600,
    projectile: 0,
    gravity: 0,
    recoil: 0.14,
    sway: 1.0,
    tracer: true,
    unlockPoints: 400,
  },
};

/** Weapons in menu order. */
export const WEAPON_ORDER = ["revolver", "shotgun", "crossbow", "rifle", "sniper"];

export const HEADSHOT_MULTIPLIER = 2.5;
export const LIMB_MULTIPLIER = 0.6; // legs and tail

/** Damage multiplier for a hit at `distance` metres: 1 up to `range`, easing to `falloff` at `maxRange`. */
export function damageFalloff(def, distance) {
  if (distance <= def.range) return 1;
  return lerp(1, def.falloff, smoothstep(def.range, def.maxRange, distance));
}

/** Damage multiplier for the body part that was hit. */
export function partMultiplier(part) {
  if (part === "head") return HEADSHOT_MULTIPLIER;
  if (part === "leg" || part === "tail") return LIMB_MULTIPLIER;
  return 1;
}

/* --- Tuning --- */

const VIEW_FOV = 52; // viewmodel camera vertical FOV (independent of world zoom)
const SWITCH_LOWER = 0.18; // s to lower the old weapon
const SWITCH_RAISE = 0.24; // s to raise the new one
const SWAY_BASE = 0.0055; // rad of aim drift at sway 1, aimed, standing
const TREE_HEIGHT = 12; // m — trunks are hit-tested as cylinders this tall
const TREE_STEP = 14; // m between collider queries along a ray
const TREE_QUERY = 9; // m query radius (covers the gaps between steps + trunk radius)
const MAX_RAY = 1200;
const WALK_SPEED = 1.6; // HUMAN walk speed, for the viewmodel bob rate
const BOLT_POOL = 8;
const BOLT_STICK_TIME = 30;
const PARTICLES_HIGH = 480;
const PARTICLES_LOW = 220;
const TRACER_POOL = 6;
const TRACER_SPEED = 900;

const PART_RANK = { head: 5, neck: 4, body: 3, tail: 2, leg: 1 };

/* --- Scratch --- */

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _back = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const NEG_Z = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

/** Point `out` along `dir` deflected by angles (radians) toward `right` and `up`. */
function deflect(dir, right, up, ax, ay, out) {
  return out.copy(dir).addScaledVector(right, Math.tan(ax)).addScaledVector(up, Math.tan(ay)).normalize();
}

/** Uniform random point in a disc of radius `cone` → [ax, ay]. */
function coneSample(cone, out) {
  const r = cone * Math.sqrt(Math.random());
  const a = Math.random() * TAU;
  out[0] = Math.cos(a) * r;
  out[1] = Math.sin(a) * r;
  return out;
}

/* --- Particles: one instanced draw for every dust puff, chip, droplet and splash ring --- */

function particleAtlas() {
  const S = 128;
  const C = 64;
  const data = new Uint8Array(S * S * 4);
  let seed = 1234567;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  // Value-noise lattice for the soft puff.
  const lat = new Float32Array(17 * 17);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const s = (t) => t * t * (3 - 2 * t);
    const at = (i, j) => lat[(j & 15) * 17 + (i & 15)];
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * s(fx);
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * s(fx);
    return a + (b - a) * s(fy);
  };
  // Chip silhouette: a jittered quadrilateral.
  const chip = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + rnd() * 0.6;
    chip.push([Math.cos(a) * (0.25 + rnd() * 0.18), Math.sin(a) * (0.12 + rnd() * 0.12)]);
  }
  const inPoly = (x, y) => {
    let inside = false;
    for (let i = 0, j = chip.length - 1; i < chip.length; j = i++) {
      const [xi, yi] = chip[i];
      const [xj, yj] = chip[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const cell = (j >= C ? 2 : 0) + (i >= C ? 1 : 0);
      const x = ((i % C) + 0.5) / C - 0.5;
      const y = ((j % C) + 0.5) / C - 0.5;
      const r = Math.hypot(x, y) * 2; // 0 centre .. 1 at the cell edge
      let a = 0;
      let lum = 1;
      if (cell === 0) {
        // Full-bodied, soft-edged puff with a lumpy rim.
        const n = noise(x * 6 + 8, y * 6 + 8) * 0.6 + noise(x * 13 + 3, y * 13 + 5) * 0.4;
        a = clamp(1 - r / (0.8 + n * 0.2), 0, 1);
        a = a * (1.6 - 0.6 * a) * (0.7 + n * 0.45);
        lum = 0.82 + n * 0.25 - r * 0.15;
      } else if (cell === 1) {
        a = clamp((0.8 - r) * 6, 0, 1);
        lum = 1 - r * 0.25;
      } else if (cell === 2) {
        const inside = inPoly(x, y) ? 1 : 0;
        a = inside;
        lum = 0.75 + (x + y) * 0.6;
      } else {
        a = clamp(1 - Math.abs(r - 0.7) / 0.12, 0, 1);
        a *= a * 0.9;
        lum = 1;
      }
      const o = (j * S + i) * 4;
      const l = clamp(lum, 0, 1) * 255;
      data[o] = l;
      data[o + 1] = l;
      data[o + 2] = l;
      data[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const PARTICLE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPos;
attribute vec4 iData;   // size, rotation, alpha, atlas cell
attribute vec4 iColor;  // rgb, flat (1 = lies on the XZ plane, e.g. a ripple ring)
uniform vec3 uLight;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float cell = iData.w;
  vec2 cellOff = vec2( mod( cell, 2.0 ), floor( cell / 2.0 ) ) * 0.5;
  vUv = cellOff + ( position.xy + 0.5 ) * 0.5;
  float c = cos( iData.y );
  float s = sin( iData.y );
  vec2 q = vec2( c * position.x - s * position.y, s * position.x + c * position.y ) * iData.x;
  vec4 mvPosition;
  if ( iColor.a > 0.5 ) {
    mvPosition = modelViewMatrix * vec4( iPos + vec3( q.x, 0.0, q.y ), 1.0 );
  } else {
    mvPosition = modelViewMatrix * vec4( iPos, 1.0 );
    mvPosition.xy += q;
  }
  gl_Position = projectionMatrix * mvPosition;
  vColor = vec4( iColor.rgb * uLight, iData.z );
  #include <fog_vertex>
}`;

const PARTICLE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D( uMap, vUv );
  gl_FragColor = vec4( vColor.rgb * t.rgb, t.a * vColor.a );
  if ( gl_FragColor.a < 0.004 ) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

class ParticleField {
  constructor(cap) {
    this.cap = cap;
    this.count = 0;
    this.next = 0;
    const f = () => new Float32Array(cap);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.life = f();
    this.max = f();
    this.s0 = f();
    this.s1 = f();
    this.rot = f();
    this.spin = f();
    this.a0 = f();
    this.drag = f();
    this.grav = f();
    this.cell = f();
    this.flat = f();
    this.r = f();
    this.g = f();
    this.b = f();

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iPos", this.iPos);
    geo.setAttribute("iData", this.iData);
    geo.setAttribute("iColor", this.iColor);
    geo.instanceCount = 0;
    this.texture = particleAtlas();
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.uniforms.uMap.value = this.texture;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.geometry = geo;
  }

  /** Spawn one particle; overwrites the oldest slot when full. Colours are linear RGB. */
  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, alpha, cell, drag = 1, grav = 0, flat = 0) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else {
      i = this.next;
      this.next = (this.next + 1) % this.cap;
    }
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = 0;
    this.max[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.rot[i] = Math.random() * TAU;
    this.spin[i] = (Math.random() - 0.5) * (cell === 2 ? 14 : 1.2);
    this.a0[i] = alpha;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.cell[i] = cell;
    this.flat[i] = flat;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
  }

  _copy(dst, src) {
    for (const k of ["px", "py", "pz", "vx", "vy", "vz", "life", "max", "s0", "s1", "rot", "spin", "a0", "drag", "grav", "cell", "flat", "r", "g", "b"]) this[k][dst] = this[k][src];
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) {
        n--;
        if (i !== n) this._copy(i, n);
        i--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vz[i] *= k;
      this.vy[i] = this.vy[i] * k - this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
    this.count = n;
    if (this.next >= n) this.next = 0;
    const P = this.iPos.array;
    const D = this.iData.array;
    const C = this.iColor.array;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.max[i];
      P[i * 3] = this.px[i];
      P[i * 3 + 1] = this.py[i];
      P[i * 3 + 2] = this.pz[i];
      const g = 1 - t;
      D[i * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - g * g * g);
      D[i * 4 + 1] = this.rot[i];
      // Quick fade-in, long ease-out.
      D[i * 4 + 2] = this.a0[i] * Math.min(1, t * 12) * (1 - t) * (1 - t * 0.35);
      D[i * 4 + 3] = this.cell[i];
      C[i * 4] = this.r[i];
      C[i * 4 + 1] = this.g[i];
      C[i * 4 + 2] = this.b[i];
      C[i * 4 + 3] = this.flat[i];
    }
    for (const a of [this.iPos, this.iData, this.iColor]) {
      a.clearUpdateRanges();
      if (n > 0) {
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/* --- Tracers: faint streaks that run from the muzzle to the impact --- */

const TRACER_VERT = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform float uHead;
uniform float uLen;
uniform float uWidth;
varying float vAlong;
varying float vSide;
void main() {
  float t = clamp( uHead - ( 1.0 - position.x ) * uLen, 0.0, 1.0 );
  vec3 p = mix( uA, uB, t );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vec3 dv = normalize( ( modelViewMatrix * vec4( uB - uA, 0.0 ) ).xyz );
  vec3 sideV = normalize( cross( dv, normalize( mv.xyz ) ) );
  // Never thinner than about a pixel in the distance.
  float w = uWidth * max( 1.0, -mv.z * 0.004 );
  mv.xyz += sideV * position.y * w;
  gl_Position = projectionMatrix * mv;
  vAlong = position.x;
  vSide = position.y;
}`;

const TRACER_FRAG = /* glsl */ `
uniform float uAlpha;
uniform vec3 uColor;
varying float vAlong;
varying float vSide;
void main() {
  float a = uAlpha * pow( vAlong, 1.6 ) * ( 1.0 - vSide * vSide );
  gl_FragColor = vec4( uColor * a, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Tracers {
  constructor(n) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry = geo;
    this.items = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uA: { value: new THREE.Vector3() },
          uB: { value: new THREE.Vector3() },
          uHead: { value: 0 },
          uLen: { value: 0.1 },
          uWidth: { value: 0.012 },
          uAlpha: { value: 0 },
          uColor: { value: new THREE.Color(1.0, 0.85, 0.6) },
        },
        vertexShader: TRACER_VERT,
        fragmentShader: TRACER_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.items.push({ mesh, t: 0, dur: 0, len: 0 });
    }
    this.next = 0;
  }

  fire(a, b) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    const u = it.mesh.material.uniforms;
    u.uA.value.copy(a);
    u.uB.value.copy(b);
    const dist = a.distanceTo(b);
    it.t = 0;
    it.dur = dist / TRACER_SPEED;
    // Streak ~25 m long (as a fraction of the path), at least a short dash.
    it.len = clamp(25 / Math.max(dist, 1), 0.06, 1);
    u.uLen.value = it.len;
    it.mesh.visible = true;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.t += dt;
      const head = it.dur > 0 ? it.t / it.dur : 1;
      const u = it.mesh.material.uniforms;
      u.uHead.value = Math.min(head, 1 + it.len);
      u.uAlpha.value = 0.55 * (1 - smoothstep(1, 1 + it.len, head));
      if (head > 1 + it.len) it.mesh.visible = false;
    }
  }

  dispose() {
    this.geometry.dispose();
    for (const it of this.items) it.mesh.material.dispose();
  }
}

/* --- Impact palettes (linear RGB) --- */

const lin = (hex) => new THREE.Color(hex);
const DUST = {
  sand: lin(0xd8c8a2),
  beach: lin(0xd8c8a2),
  plains: lin(0xae9d7c),
  forest: lin(0x8a7a62),
  swamp: lin(0x7a6e56),
  highland: lin(0xa89f88),
  rock: lin(0xa8a198),
  default: lin(0xa89878),
};
const WOOD = lin(0xb8976a);
const SAWDUST = lin(0x9c8462);
const ROCK = lin(0x9a948a);
const BLOOD = lin(0x5a0606);
const BLOOD_MIST = lin(0x8a1610);
const WATER = lin(0xdfe9ec);
const SMOKE = lin(0xb9b6ae);

/* --- WeaponSystem --- */

export class WeaponSystem {
  /**
   * @param {{ world: object, camera: THREE.PerspectiveCamera, loadout?: string[] }} opts
   * `world` needs (all optional, guarded): scene, terrain, vegetation, ecosystem, events, sky, wind, player, quality.
   */
  constructor({ world, camera, loadout = ["rifle", "revolver"] }) {
    this.world = world || {};
    this.camera = camera;
    /** Actor credited with shots (defaults to world.player); set explicitly if needed. */
    this.owner = null;

    const q = this.world.quality;
    this.low = q === "low" || (q && typeof q === "object" && (q.shadows === false || q.antialias === false));
    this.detail = this.low ? 0.65 : 1;

    /* State (contract fields) */
    this.loadout = [];
    this.current = null;
    this.ammo = {};
    this.aiming = 0; // eased 0..1
    this.reloading = false;
    /* Extras for HUD / controller */
    this.reloadProgress = 0;
    this.switching = false;
    this.lowered = 0;
    this.scoped = false;
    this.zoom = 1;
    this.spread = 0;
    this.sway = { x: 0, y: 0 };
    /**
     * Camera kick for the controller, in radians, for THIS frame only (reset at the
     * start of every update): add `pitch` to the look pitch (positive = muzzle climbs)
     * and `yaw` to the look yaw (positive = to the right, i.e. subtract from a heading
     * that grows to the left). The kick arrives over ~70 ms and ~60% of the climb
     * recovers over ~0.4 s, so summing the deltas gives a natural snap-and-settle.
     */
    this.recoilKick = { pitch: 0, yaw: 0 };
    this.hint = null;
    this.lastShotTime = -Infinity;

    this._time = 0;
    this._aimLin = 0;
    this._cooldown = 0;
    this._cycle = -1;
    this._reloadT = 0;
    this._reloadCommitted = false;
    this._pending = null;
    this._fireHeld = false;
    this._reloadHeld = false;
    this._fireBuffer = 0;
    this._bloom = 0;
    this._swayAmp = 0;
    this._kickPitch = 0;
    this._kickYaw = 0;
    this._recover = 0;
    this._sprint = 0;
    this._lagX = 0;
    this._lagY = 0;
    this._prevYaw = null;
    this._prevPitch = 0;
    this._flashT = 1;
    this._cone = [0, 0];
    this._cone2 = [0, 0];

    /* Viewmodel scene: its own camera mirrors the world camera each frame. */
    this.viewScene = new THREE.Scene();
    this.viewScene.name = "viewmodel-scene";
    this.viewCamera = new THREE.PerspectiveCamera(VIEW_FOV, camera?.aspect || 16 / 9, 0.01, 20);
    this.viewScene.add(this.viewCamera);
    /** Root of the first-person gun + hands. Rendered by renderViewmodel(). */
    this.viewmodel = new THREE.Group();
    this.viewmodel.name = "hunter-viewmodel";
    this.viewCamera.add(this.viewmodel);
    this._sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this._sunTarget = new THREE.Object3D();
    this._sun.target = this._sunTarget;
    this._hemi = new THREE.HemisphereLight(0xb0c6dc, 0x5e5844, 1.4);
    this._vmFlash = new THREE.PointLight(0xffb36b, 0, 3, 2);
    this.viewScene.add(this._sun, this._sunTarget, this._hemi);
    this.viewCamera.add(this._vmFlash);
    this._envRT = null;
    this._state = {
      aim: 0, move: 0, sprint: 0, crouch: 0, lower: 0, reload: -1, cycle: -1,
      fired: false, mag: 0, swayX: 0, swayY: 0, lagX: 0, lagY: 0, scoped: false, ejectCount: 0,
    };

    /* World effects */
    this.fx = new THREE.Group();
    this.fx.name = "weapon-fx";
    this._particles = new ParticleField(this.low ? PARTICLES_LOW : PARTICLES_HIGH);
    this._tracers = new Tracers(TRACER_POOL);
    this.fx.add(this._particles.mesh);
    for (const it of this._tracers.items) this.fx.add(it.mesh);
    // One shared muzzle light for the world (skipped on low: every point light
    // costs a little in every world fragment).
    this._worldFlash = null;
    if (!this.low) {
      this._worldFlash = new THREE.PointLight(0xffb070, 0, 24, 2);
      this.fx.add(this._worldFlash);
    }
    this._boltProto = null;
    this._bolts = [];
    this.world.scene?.add(this.fx);

    /* Ray-query scratch */
    this._hit = { creature: null, part: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, terrain: false, water: false, tree: null };
    this._colliders = [];
    this._creatures = [];
    this._sphereCache = new WeakMap();
    this._hitRecords = [];
    for (let i = 0; i < 12; i++) this._hitRecords.push({ creature: null, damage: 0, part: null, headshot: false, point: new THREE.Vector3(), distance: 0 });
    this._treeHit = null;
    this._rcCreature = null;
    this._rcPart = null;
    this._rcNormal = new THREE.Vector3();

    this._models = {};
    this.setLoadout(loadout);
  }

  /* --- Loadout & state --- */

  /** Replace the loadout (rebuilds viewmodels, refills ammo). */
  setLoadout(loadout) {
    const ids = [];
    for (const id of loadout || []) if (WEAPONS[id] && !ids.includes(id)) ids.push(id);
    if (!ids.length) ids.push("rifle");
    for (const id in this._models) {
      if (!ids.includes(id)) {
        this._models[id].dispose();
        delete this._models[id];
      }
    }
    this.loadout = ids.slice(0, 2);
    this.ammo = {};
    for (const id of this.loadout) {
      this.ammo[id] = { mag: WEAPONS[id].magazine, reserve: WEAPONS[id].reserve };
      if (!this._models[id]) {
        const m = createViewmodel(id, { detail: this.detail });
        this._models[id] = m;
        this.viewmodel.add(m.object);
      }
    }
    if (this.loadout.includes("crossbow") && !this._boltProto) this._initBolts();
    this.current = this.loadout[0];
    for (const id in this._models) this._models[id].object.visible = id === this.current;
    this._cancelReload();
    this._pending = null;
    this._cooldown = 0;
    this._cycle = -1;
    this._aimLin = 0;
    this.aiming = 0;
    this.lowered = 1; // raise into view
  }

  /** Top up every weapon in the loadout. */
  refill() {
    for (const id of this.loadout) {
      this.ammo[id].mag = WEAPONS[id].magazine;
      this.ammo[id].reserve = WEAPONS[id].reserve;
    }
  }

  /** Definition of the current weapon. */
  get def() {
    return WEAPONS[this.current];
  }

  /** True when a trigger pull right now would fire. */
  get canFire() {
    const a = this.ammo[this.current];
    return !!a && a.mag > 0 && !this.reloading && this._cooldown <= 0 && this.lowered < 0.05 && !this._pending && this._sprint < 0.5 && !this._binoculars;
  }

  _owner() {
    return this.owner || this.world.player || this.world.ecosystem?.player || null;
  }

  _beginSwitch(id) {
    if (!this.loadout.includes(id) || id === this.current) {
      if (id === this.current) this._pending = null;
      return;
    }
    this._pending = id;
    this._cancelReload();
  }

  _startReload() {
    const def = this.def;
    const a = this.ammo[this.current];
    if (this.reloading || !a || a.mag >= def.magazine || a.reserve <= 0 || this._pending) return false;
    this.reloading = true;
    this._reloadT = 0;
    this._reloadCommitted = false;
    this._cycle = -1;
    this.world.events?.emit("reload", { weapon: def.id });
    return true;
  }

  _cancelReload() {
    // Interrupted before the rounds went in: nothing changes.
    this.reloading = false;
    this._reloadT = 0;
    this.reloadProgress = 0;
    this._reloadCommitted = false;
  }

  /* --- Per-frame --- */

  /**
   * Advance the weapon state, fire, simulate bolts and effects, animate the viewmodel.
   * @param {number} dt
   * @param {{ fire?: boolean, aim?: boolean, reload?: boolean, switchTo?: string|number|null,
   *           moving?: boolean, sprinting?: boolean, binoculars?: boolean, crouching?: boolean }} input
   *   `fire` / `reload` may be held states or one-frame edges (both work: rising edges trigger,
   *   with a short fire buffer). `switchTo` is a weapon id (or loadout index).
   */
  update(dt, input = {}) {
    const owner = this._owner();
    this._time += dt;
    this.recoilKick.pitch = 0;
    this.recoilKick.yaw = 0;
    const st = this._state;
    st.fired = false;

    const camera = this.camera;
    if (camera) camera.updateMatrixWorld();
    this._syncViewCamera();

    // Inputs (edge detection makes held and one-shot inputs both work).
    const fireDown = !!input.fire;
    const firePressed = fireDown && !this._fireHeld;
    this._fireHeld = fireDown;
    this._fireBuffer = firePressed ? 0.18 : Math.max(0, this._fireBuffer - dt);
    const reloadDown = !!input.reload;
    const reloadPressed = reloadDown && !this._reloadHeld;
    this._reloadHeld = reloadDown;
    let switchTo = input.switchTo;
    if (typeof switchTo === "number") switchTo = this.loadout[switchTo];
    if (switchTo) this._beginSwitch(switchTo);
    this._binoculars = !!input.binoculars;
    const sprinting = !!input.sprinting;
    this._sprint = damp(this._sprint, sprinting ? 1 : 0, 9, dt);
    const crouch = input.crouching ?? owner?.crouching ?? false;

    // Lower / raise for switching and binoculars.
    const wantLow = !!this._pending || this._binoculars;
    if (wantLow) this.lowered = Math.min(1, this.lowered + dt / SWITCH_LOWER);
    else this.lowered = Math.max(0, this.lowered - dt / SWITCH_RAISE);
    if (this._pending && this.lowered >= 1) {
      this._models[this.current].object.visible = false;
      this.current = this._pending;
      this._pending = null;
      this._models[this.current].object.visible = true;
      this._cooldown = 0;
      this._cycle = -1;
      this._aimLin = 0;
    }
    this.switching = !!this._pending || (this.lowered > 0 && !this._binoculars);

    // Reload progress; ammo moves in at the commit point of the animation.
    const d = this.def;
    const am = this.ammo[this.current];
    if (reloadPressed) this._startReload();
    if (this.reloading) {
      this._reloadT += dt / d.reloadTime;
      if (!this._reloadCommitted && this._reloadT >= d.reloadCommit) {
        const need = d.magazine - am.mag;
        const take = Math.min(need, am.reserve);
        am.mag += take;
        am.reserve -= take;
        this._reloadCommitted = true;
      }
      if (this._reloadT >= 1) this._cancelReload();
    }
    this.reloadProgress = this.reloading ? clamp(this._reloadT, 0, 1) : 0;

    // Aim: linear in time, exposed eased (the controller can blend FOV with it).
    const aimWanted = !!input.aim && this._sprint < 0.5 && !this._binoculars && !this.reloading && this.lowered < 0.5 && !this._pending;
    this._aimLin = clamp(this._aimLin + (aimWanted ? dt : -dt) / d.aimTime, 0, 1);
    const a = this._aimLin;
    this.aiming = a * a * (3 - 2 * a);
    this.zoom = lerp(1, d.zoom, this.aiming);
    this.scoped = d.scope > 0 && this.aiming > 0.9 && this.lowered < 0.05;

    // Cooldown / action cycle.
    this._cooldown = Math.max(0, this._cooldown - dt);
    if (this._cycle >= 0) {
      this._cycle += dt / Math.max(0.05, d.cycleTime);
      if (this._cycle >= 1) this._cycle = -1;
    }

    // Fire.
    if (this._fireBuffer > 0 && this.lowered < 0.05 && !this._pending && this._sprint < 0.5 && !this._binoculars && !this.reloading) {
      if (am.mag <= 0) {
        if (firePressed) {
          this.world.events?.emit("dryfire", { weapon: d.id });
          if (!this._startReload()) this.hint = "Out of ammo";
        }
        this._fireBuffer = 0;
      } else if (this._cooldown <= 0) {
        this._fire(d, owner);
        this._fireBuffer = 0;
      }
    }
    // Auto-reload once the action has cycled on an empty magazine.
    if (am.mag === 0 && am.reserve > 0 && !this.reloading && this._cooldown <= 0 && this.lowered < 0.05 && !this._pending && this._sprint < 0.5 && !this._binoculars) {
      this._startReload();
    }
    this.hint = am.mag === 0 && am.reserve === 0 && !this.reloading ? "Out of ammo" : am.mag === 0 && !this.reloading ? "Reload (R)" : null;

    // Aim drift: a slow Lissajous wander. Less when aimed or crouched, more when moving.
    const moving = !!input.moving;
    const ampT = d.sway * SWAY_BASE * lerp(1.7, 1, this.aiming) * (crouch ? 0.55 : 1) * (moving ? 1.7 : 1) * (1 + this._sprint);
    this._swayAmp = damp(this._swayAmp, ampT, 3, dt);
    const t = this._time;
    this.sway.x = this._swayAmp * (Math.sin(t * 0.83) * 0.7 + Math.sin(t * 0.37 + 1.3) * 0.3);
    this.sway.y = this._swayAmp * 0.75 * (Math.sin(t * 1.27 + 0.6) * 0.62 + Math.sin(t * 0.51 + 2.1) * 0.38);

    // Spread (cone half-angle) for the crosshair and the shots.
    this._bloom = Math.max(0, this._bloom - dt * d.spread * 2.5);
    const spreadT = lerp(d.spread, d.aimSpread, this.aiming) * (moving ? 1.5 : 1) * (1 + this._sprint * 1.2) * (crouch ? 0.8 : 1) + this._bloom;
    this.spread = damp(this.spread || spreadT, spreadT, 12, dt);

    // Recoil → camera deltas for the controller.
    if (this._kickPitch !== 0 || this._kickYaw !== 0 || this._recover !== 0) {
      const k = 1 - Math.exp(-dt * 30);
      const dp = this._kickPitch * k;
      const dy = this._kickYaw * k;
      this._kickPitch -= dp;
      this._kickYaw -= dy;
      this._recover += dp * 0.6;
      const r = this._recover * (1 - Math.exp(-dt * 5));
      this._recover -= r;
      this.recoilKick.pitch = dp - r;
      this.recoilKick.yaw = dy;
      if (Math.abs(this._kickPitch) < 1e-6 && Math.abs(this._recover) < 1e-6 && Math.abs(this._kickYaw) < 1e-6) {
        this._kickPitch = this._kickYaw = this._recover = 0;
      }
    }

    // Look inertia: the gun trails fast turns a little.
    if (camera) {
      camera.getWorldDirection(_fwd);
      const yaw = Math.atan2(_fwd.x, _fwd.z);
      const pitch = Math.asin(clamp(_fwd.y, -1, 1));
      if (this._prevYaw !== null && dt > 0) {
        const wy = angleDiff(this._prevYaw, yaw) / dt;
        const wp = (pitch - this._prevPitch) / dt;
        const k = 0.012 * lerp(1, 0.3, this.aiming);
        this._lagX = damp(this._lagX, clamp(-wy * k, -0.06, 0.06), 10, dt);
        this._lagY = damp(this._lagY, clamp(-wp * k, -0.05, 0.05), 10, dt);
      }
      this._prevYaw = yaw;
      this._prevPitch = pitch;
    }

    // Viewmodel.
    st.aim = this.aiming;
    st.move = owner && typeof owner.speed === "number" ? owner.speed / WALK_SPEED : moving ? 1 : 0;
    st.sprint = this._sprint;
    st.crouch = crouch ? 1 : 0;
    st.lower = this.lowered;
    st.reload = this.reloading ? clamp(this._reloadT, 0, 1) : -1;
    st.cycle = this._cycle;
    st.mag = this.ammo[this.current].mag;
    st.swayX = this.sway.x;
    st.swayY = this.sway.y;
    st.lagX = this._lagX;
    st.lagY = this._lagY;
    st.scoped = this.scoped;
    const model = this._models[this.current];
    model.update(dt, st);
    this.viewCamera.updateMatrixWorld(true);

    // Muzzle lights.
    this._flashT += dt;
    const fl = this._flashT < 0.07 ? 1 - this._flashT / 0.07 : 0;
    if (this._worldFlash) {
      this._worldFlash.intensity = fl * 60 * (d.projectile > 0 ? 0 : 1);
      if (fl > 0) {
        this._muzzleWorld(_muzzle);
        this._worldFlash.position.copy(_muzzle);
      }
    }
    this._vmFlash.intensity = fl * 2.2 * (d.projectile > 0 ? 0 : 1);
    if (fl > 0) {
      model.muzzle.getWorldPosition(_v);
      this.viewCamera.worldToLocal(_v);
      this._vmFlash.position.copy(_v);
    }

    this._updateBolts(dt);
    this._particles.material.uniforms.uLight.value.copy(this._ambient());
    this._particles.update(dt);
    this._tracers.update(dt);
  }

  /* --- Firing --- */

  _fire(def, owner) {
    const ammo = this.ammo[def.id];
    ammo.mag--;
    this._cooldown = def.fireInterval;
    this._cycle = def.cycleTime > 0 ? 0 : -1;
    this._state.fired = true;
    this._flashT = 0;
    this.lastShotTime = this._time;
    this._bloom = Math.min(this._bloom + def.spread * 0.6, def.spread * 2);
    this._kickPitch += def.recoil * (0.85 + Math.random() * 0.3);
    this._kickYaw += (Math.random() - 0.5) * def.recoil * 0.5;

    const cam = this.camera;
    cam.getWorldPosition(_o);
    cam.matrixWorld.extractBasis(_right, _up, _back);
    _right.normalize();
    _up.normalize();
    _fwd.copy(_back).normalize().negate();
    // Where the shot goes: sway + aim error (spread).
    coneSample(this.spread, this._cone);
    deflect(_fwd, _right, _up, this.sway.x + this._cone[0], this.sway.y + this._cone[1], _aim);

    this.world.events?.emit("shot", { shooter: owner, weapon: def.id, x: _o.x, y: _o.y, z: _o.z, loudness: def.loudness });

    this._muzzleWorld(_muzzle);
    this._muzzleSmoke(def, _muzzle);

    if (def.projectile > 0) {
      this._spawnBolt(def, owner, _o, _aim, _muzzle);
      return;
    }

    // Hitscan: one ray per pellet; damage is pooled per creature so a shotgun
    // blast is one "hit" (and one takeDamage) per animal.
    let records = 0;
    for (let p = 0; p < def.pellets; p++) {
      if (def.pelletSpread > 0) {
        coneSample(def.pelletSpread, this._cone2);
        deflect(_aim, _right, _up, this._cone2[0], this._cone2[1], _d);
      } else _d.copy(_aim);
      const hit = this.raycast(_o, _d, def.maxRange, owner);
      if (def.tracer && p === 0) {
        _w.copy(_o).addScaledVector(_d, hit ? hit.distance : def.maxRange);
        this._tracers.fire(_muzzle, _w);
      }
      if (!hit) continue;
      this._impact(hit, _d, def.pellets > 1 ? 0.55 : 1);
      if (!hit.creature) continue;
      const dmg = def.damage * damageFalloff(def, hit.distance) * partMultiplier(hit.part);
      let rec = null;
      for (let i = 0; i < records; i++) if (this._hitRecords[i].creature === hit.creature) rec = this._hitRecords[i];
      if (!rec) {
        rec = this._hitRecords[records++];
        rec.creature = hit.creature;
        rec.damage = 0;
        rec.part = hit.part;
        rec.headshot = false;
        rec.point.copy(hit.point);
        rec.distance = hit.distance;
      }
      rec.damage += dmg;
      if ((PART_RANK[hit.part] || 0) > (PART_RANK[rec.part] || 0)) {
        rec.part = hit.part;
        rec.point.copy(hit.point);
      }
      if (hit.part === "head") rec.headshot = true;
    }
    for (let i = 0; i < records; i++) {
      const r = this._hitRecords[i];
      this._applyHit(r.creature, owner, r.damage, r.part, r.headshot, r.point, r.distance, def.id);
      r.creature = null;
    }
  }

  /** Emit "hit" (before damage, so listeners see it ahead of any "death") and apply the damage. */
  _applyHit(creature, owner, damage, part, headshot, point, distance, weapon) {
    const armor = creature.species?.armor ?? 0;
    const est = damage * (1 - armor * 0.5);
    this.world.events?.emit("hit", {
      target: creature,
      shooter: owner,
      damage,
      part: part || "body",
      headshot: !!headshot,
      x: point.x,
      y: point.y,
      z: point.z,
      weapon,
      distance,
      lethal: typeof creature.health === "number" ? creature.health - est <= 0 : false,
    });
    if (typeof creature.takeDamage === "function") creature.takeDamage(damage, owner, "shot");
  }

  /* --- Ballistics --- */

  /**
   * Cast a ray against terrain, water, tree trunks and creature hit spheres.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir  unit direction
   * @param {number} [maxDist]
   * @param {object|null} [ignore]  actor to skip (defaults to the shooter)
   * @returns {null | { creature, part, point, normal, distance, terrain, water, tree }}
   *   The nearest hit. Exactly one of creature / terrain / water / tree is set. The
   *   object is reused between calls — copy what you need to keep.
   */
  raycast(origin, dir, maxDist = MAX_RAY, ignore = undefined) {
    const shooter = ignore === undefined ? this._owner() : ignore;
    let best = maxDist;
    let kind = 0; // 1 terrain, 2 water, 3 tree, 4 creature
    let creature = null;
    let part = null;
    const terrain = this.world.terrain;
    const H = this._hit;

    if (terrain && typeof terrain.heightAt === "function") {
      const t = this._marchTerrain(terrain, origin, dir, best);
      if (t >= 0) {
        best = t;
        kind = 1;
      }
      const sea = terrain.seaLevel ?? 0;
      if (dir.y < -1e-6 && origin.y > sea) {
        const tw = (sea - origin.y) / dir.y;
        if (tw < best) {
          best = tw;
          kind = 2;
        }
      }
    }

    const veg = this.world.vegetation;
    if (veg && typeof veg.collidersNear === "function") {
      const t = this._raycastTrees(veg, terrain, origin, dir, best);
      if (t >= 0) {
        best = t;
        kind = 3;
      }
    }

    const eco = this.world.ecosystem;
    if (eco) {
      const t = this._raycastCreatures(eco, origin, dir, best, shooter);
      if (t >= 0) {
        best = t;
        kind = 4;
        creature = this._rcCreature;
        part = this._rcPart;
      }
    }

    if (!kind) return null;
    H.distance = best;
    H.point.copy(origin).addScaledVector(dir, best);
    H.creature = kind === 4 ? creature : null;
    H.part = kind === 4 ? part : null;
    H.terrain = kind === 1;
    H.water = kind === 2;
    H.tree = kind === 3 ? this._treeHit : null;
    if (kind === 1) {
      if (typeof terrain.normalAt === "function") terrain.normalAt(H.point.x, H.point.z, H.normal);
      else H.normal.copy(UP);
    } else if (kind === 2) H.normal.copy(UP);
    else if (kind === 3) H.normal.set(H.point.x - this._treeHit.x, 0, H.point.z - this._treeHit.z).normalize();
    else H.normal.copy(this._rcNormal);
    return H;
  }

  /** Heightfield march: coarse steps (finer up close, bigger high above ground), then bisection. */
  _marchTerrain(T, o, d, maxDist) {
    const h0 = T.heightAt(o.x, o.z);
    if (o.y < h0 - 0.05) return 0;
    const top = (T.maxHeight ?? 220) + 2;
    let tPrev = 0;
    let t = 0;
    while (t < maxDist) {
      const yPrev = o.y + d.y * t;
      const clear = yPrev - T.heightAt(o.x + d.x * t, o.z + d.z * t);
      const step = Math.max(Math.min(0.5 + t * 0.012, 4), clear * 0.4);
      t = Math.min(maxDist, t + step);
      const y = o.y + d.y * t;
      if (y > top && d.y >= 0) return -1;
      if (y - T.heightAt(o.x + d.x * t, o.z + d.z * t) < 0) {
        let lo = tPrev;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          if (o.y + d.y * mid - T.heightAt(o.x + d.x * mid, o.z + d.z * mid) < 0) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      tPrev = t;
    }
    return -1;
  }

  /** Trunks (and boulders) as vertical cylinders, gathered along the ray. */
  _raycastTrees(veg, terrain, o, d, maxDist) {
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-8) return -1;
    let best = maxDist;
    let found = null;
    for (let s = 0; s <= maxDist + TREE_STEP * 0.5; s += TREE_STEP) {
      if (s - TREE_QUERY > best) break;
      const t = Math.min(s, maxDist);
      const out = this._colliders;
      out.length = 0;
      const list = veg.collidersNear(o.x + d.x * t, o.z + d.z * t, TREE_QUERY, out) || out;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const fx = o.x - c.x;
        const fz = o.z - c.z;
        const b = 2 * (fx * d.x + fz * d.z);
        const cc = fx * fx + fz * fz - c.r * c.r;
        if (cc < 0) continue; // standing inside it
        const disc = b * b - 4 * a * cc;
        if (disc < 0) continue;
        const th = (-b - Math.sqrt(disc)) / (2 * a);
        if (th < 0 || th >= best) continue;
        const y = o.y + d.y * th;
        const ground = terrain ? terrain.heightAt(c.x, c.z) : -Infinity;
        const rocky = c.kind === "boulder" || c.kind === "rock" || c.type === "boulder" || c.type === "rock";
        const height = c.height ?? c.h ?? (rocky ? c.r * 1.3 : TREE_HEIGHT);
        if (y < ground - 0.6 || y > ground + height) continue;
        best = th;
        found = c;
      }
    }
    this._treeHit = found;
    return found ? best : -1;
  }

  /** Creature hit spheres: broad phase via ecosystem.query, narrow via model.getHitSpheres. */
  _raycastCreatures(eco, o, d, maxDist, ignore) {
    const half = maxDist * 0.5;
    const mx = o.x + d.x * half;
    const mz = o.z + d.z * half;
    let list;
    if (typeof eco.query === "function") {
      this._creatures.length = 0;
      list = eco.query(mx, mz, half + 16, null, this._creatures) || this._creatures;
    } else list = eco.creatures || [];
    let best = maxDist;
    let found = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c === ignore || c.alive === false || !c.position) continue;
      const sp = c.species || {};
      const sc = c.scale ?? 1;
      // Bounding-sphere reject before asking for the detailed spheres.
      const br = ((sp.length ?? 4) * 0.6 + 1.5) * sc;
      _v.set(c.position.x, c.position.y + (sp.height ?? 1.5) * sc, c.position.z).sub(o);
      const along = clamp(_v.dot(d), 0, maxDist);
      _w.copy(d).multiplyScalar(along).sub(_v);
      if (_w.lengthSq() > br * br) continue;
      const spheres = this._spheresFor(c);
      for (let k = 0; k < spheres.length; k++) {
        const s = spheres[k];
        if (!s) continue;
        const ox = o.x - s.x;
        const oy = o.y - s.y;
        const oz = o.z - s.z;
        const b = ox * d.x + oy * d.y + oz * d.z;
        const cq = ox * ox + oy * oy + oz * oz - s.r * s.r;
        if (cq < 0) continue; // ray starts inside this sphere
        const disc = b * b - cq;
        if (disc < 0) continue;
        const th = -b - Math.sqrt(disc);
        if (th < 0 || th >= best) continue;
        best = th;
        found = true;
        this._rcCreature = c;
        this._rcPart = s.part || "body";
        this._rcNormal.set(o.x + d.x * th - s.x, o.y + d.y * th - s.y, o.z + d.z * th - s.z).divideScalar(s.r);
      }
    }
    return found ? best : -1;
  }

  _spheresFor(c) {
    let arr = this._sphereCache.get(c);
    if (!arr) {
      arr = [];
      this._sphereCache.set(c, arr);
    }
    const m = c.model;
    if (m && typeof m.getHitSpheres === "function") {
      const out = m.getHitSpheres(arr);
      return out || arr;
    }
    return fallbackSpheres(c, arr);
  }

  /* --- Crossbow bolts --- */

  _initBolts() {
    this._boltProto = createBoltMesh();
    for (let i = 0; i < BOLT_POOL; i++) {
      const mesh = i === 0 ? this._boltProto : this._boltProto.clone();
      mesh.visible = false;
      this.fx.add(mesh);
      this._bolts.push({
        mesh, active: false, flying: false, age: 0, travelled: 0, stuckT: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), offset: new THREE.Vector3(),
        target: null, local: new THREE.Vector3(), localDir: new THREE.Vector3(), localScale: 1,
        def: null, owner: null, gravity: 9.8,
      });
    }
  }

  _spawnBolt(def, owner, origin, dir, muzzle) {
    if (!this._bolts.length) this._initBolts();
    let b = this._bolts.find((x) => !x.active);
    if (!b) {
      // Recycle the stuck bolt that has been sitting longest.
      b = this._bolts.reduce((m, x) => (!x.flying && x.stuckT > (m?.stuckT ?? -1) ? x : m), null) || this._bolts[0];
    }
    b.active = true;
    b.flying = true;
    b.age = 0;
    b.travelled = 0;
    b.stuckT = 0;
    b.target = null;
    b.def = def;
    b.owner = owner;
    b.gravity = def.gravity;
    b.pos.copy(origin);
    b.vel.copy(dir).multiplyScalar(def.projectile);
    // Drawn from the crossbow, simulated from the eye: blend the visual offset out.
    b.offset.copy(muzzle).sub(origin);
    b.mesh.visible = true;
    b.mesh.scale.setScalar(1);
    b.mesh.position.copy(muzzle);
    b.mesh.quaternion.setFromUnitVectors(NEG_Z, dir);
  }

  _updateBolts(dt) {
    for (const b of this._bolts) {
      if (!b.active) continue;
      if (b.flying) {
        b.age += dt;
        _p0.copy(b.pos);
        b.vel.y -= b.gravity * dt;
        _p1.copy(b.pos).addScaledVector(b.vel, dt);
        _seg.subVectors(_p1, _p0);
        const len = _seg.length();
        if (len > 1e-6) {
          _seg.divideScalar(len);
          const hit = this.raycast(_p0, _seg, len, b.owner);
          if (hit) {
            this._boltImpact(b, hit, _seg);
            continue;
          }
        }
        b.pos.copy(_p1);
        b.travelled += len;
        if (b.age > 6 || b.travelled > b.def.maxRange * 1.5) {
          b.active = false;
          b.mesh.visible = false;
          continue;
        }
        const k = Math.max(0, 1 - b.age / 0.12);
        b.mesh.position.copy(b.pos).addScaledVector(b.offset, k * k);
        _v.copy(b.vel).normalize();
        b.mesh.quaternion.setFromUnitVectors(NEG_Z, _v);
        continue;
      }
      // Stuck: ride along with a creature (in its heading frame), then fade.
      b.stuckT += dt;
      const c = b.target;
      let fade = smoothstep(BOLT_STICK_TIME, BOLT_STICK_TIME + 1, b.stuckT);
      if (c) {
        if (c.alive === false || !c.position) {
          b.target = null;
          b.stuckT = Math.max(b.stuckT, BOLT_STICK_TIME);
        } else {
          const sc = (c.scale ?? 1) / b.localScale;
          _q.setFromAxisAngle(UP, c.heading ?? 0);
          b.mesh.position.copy(b.local).multiplyScalar(sc).applyQuaternion(_q).add(c.position);
          _v.copy(b.localDir).applyQuaternion(_q);
          b.mesh.quaternion.setFromUnitVectors(NEG_Z, _v);
        }
      }
      if (fade >= 1) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }
      b.mesh.scale.setScalar(1 - fade);
    }
  }

  _boltImpact(b, hit, dir) {
    const dist = b.travelled + hit.distance;
    this._impact(hit, dir, 0.8);
    b.flying = false;
    b.stuckT = 0;
    if (hit.water) {
      b.active = false;
      b.mesh.visible = false;
      return;
    }
    const depth = hit.creature ? 0.12 : hit.tree ? 0.07 : 0.1;
    b.mesh.position.copy(hit.point).addScaledVector(dir, depth);
    b.mesh.quaternion.setFromUnitVectors(NEG_Z, dir);
    if (hit.creature) {
      const c = hit.creature;
      b.target = c;
      b.localScale = c.scale ?? 1;
      _q.setFromAxisAngle(UP, -(c.heading ?? 0));
      b.local.copy(b.mesh.position).sub(c.position).applyQuaternion(_q);
      b.localDir.copy(dir).applyQuaternion(_q);
      const dmg = b.def.damage * damageFalloff(b.def, dist) * partMultiplier(hit.part);
      this._applyHit(c, b.owner, dmg, hit.part, hit.part === "head", hit.point, dist, b.def.id);
    }
  }

  /* --- Effects --- */

  /** Light level for the unlit effect particles: bright by day, dim and cool by night. */
  _ambient() {
    const sky = this.world.sky;
    const day = sky ? (sky.daylight ?? 1) : 1;
    const k = lerp(0.13, 1, day);
    _col.setRGB(k, k, k);
    if (sky?.hemiLight) {
      _col2.copy(sky.hemiLight.color).multiplyScalar(k);
      _col.lerp(_col2, 0.3 * (1 - day));
    }
    return _col;
  }

  _impact(hit, dir, scale) {
    const P = this._particles;
    const p = hit.point;
    const n = hit.normal;
    const rnd = Math.random;
    // Puffs grow with distance so a hit still reads at 100 m (where a true-size
    // puff would be a couple of pixels); debris grows more gently.
    const far = clamp(hit.distance / 12, 1, 6);
    const farS = Math.sqrt(far);
    const puff = far * 1.5;
    if (hit.creature) {
      const sz = clamp((hit.creature.scale ?? 1) * 0.7, 0.5, 1.4) * scale;
      for (let i = 0; i < 5; i++) {
        P.spawn(p.x, p.y, p.z, n.x * 0.9 + (rnd() - 0.5) * 0.8, n.y * 0.6 + rnd() * 0.5, n.z * 0.9 + (rnd() - 0.5) * 0.8, 0.6 + rnd() * 0.3, 0.3 * sz * puff, (0.9 + rnd() * 0.5) * sz * puff, BLOOD_MIST.r, BLOOD_MIST.g, BLOOD_MIST.b, 0.92, 0, 3.2, 0.5);
      }
      for (let i = 0; i < 12; i++) {
        // Exit spray along the shot plus a little back-spatter.
        const back = i < 4 ? -0.5 : 1;
        const sp = 2.5 + rnd() * 4.5;
        P.spawn(p.x, p.y, p.z, (dir.x * back + (rnd() - 0.5) * 0.8) * sp, (dir.y * back + rnd() * 0.6) * sp, (dir.z * back + (rnd() - 0.5) * 0.8) * sp, 0.45 + rnd() * 0.35, 0.045 * sz * farS, 0.06 * sz * farS, BLOOD.r, BLOOD.g, BLOOD.b, 1, 1, 0.6, 9.8);
      }
      return;
    }
    if (hit.water) {
      for (let i = 0; i < 14; i++) {
        const a = rnd() * TAU;
        const sp = 0.6 + rnd() * 1.5;
        P.spawn(p.x, p.y + 0.02, p.z, Math.cos(a) * sp, 2.8 + rnd() * 3.8, Math.sin(a) * sp, 0.7 + rnd() * 0.35, 0.07 * farS, 0.05 * farS, WATER.r, WATER.g, WATER.b, 0.9, 1, 0.3, 9.8);
      }
      // Spray column and the mist it leaves.
      for (let i = 0; i < 5; i++) {
        P.spawn(p.x + (rnd() - 0.5) * 0.2, p.y + 0.2, p.z + (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.4, 1.4 + rnd() * 1.8, (rnd() - 0.5) * 0.4, 0.9 + rnd() * 0.4, 0.35 * puff * scale, (1.2 + rnd() * 0.6) * puff * scale, WATER.r, WATER.g, WATER.b, 0.75, 0, 2.2, 1.2);
      }
      P.spawn(p.x, p.y + 0.01, p.z, 0, 0, 0, 1.5, 0.3, 2.8 * scale * farS, WATER.r, WATER.g, WATER.b, 0.6, 3, 0, 0, 1);
      P.spawn(p.x, p.y + 0.01, p.z, 0, 0, 0, 1.1, 0.2, 1.5 * scale * farS, WATER.r, WATER.g, WATER.b, 0.55, 3, 0, 0, 1);
      return;
    }
    if (hit.tree) {
      const c = hit.tree;
      const rocky = c.kind === "boulder" || c.kind === "rock" || c.type === "boulder" || c.type === "rock";
      const chip = rocky ? ROCK : WOOD;
      for (let i = 0; i < 11; i++) {
        const sp = 2 + rnd() * 4;
        P.spawn(p.x, p.y, p.z, (n.x - dir.x * 0.4 + (rnd() - 0.5) * 0.9) * sp, (0.3 + rnd() * 0.9) * sp, (n.z - dir.z * 0.4 + (rnd() - 0.5) * 0.9) * sp, 0.7 + rnd() * 0.5, (0.04 + rnd() * 0.035) * farS, 0.035 * farS, chip.r, chip.g, chip.b, 1, 2, 0.5, 9.8);
      }
      const dust = rocky ? ROCK : SAWDUST;
      for (let i = 0; i < 5; i++) P.spawn(p.x + n.x * 0.1, p.y, p.z + n.z * 0.1, n.x * 0.9 + (rnd() - 0.5) * 0.5, 0.2 + rnd() * 0.3, n.z * 0.9 + (rnd() - 0.5) * 0.5, 1.0 + rnd() * 0.5, 0.25 * puff * scale, (0.8 + rnd() * 0.4) * scale * puff, dust.r, dust.g, dust.b, 0.8, 0, 2.2, -0.05);
      return;
    }
    // Terrain: a dust puff tinted by the ground (airborne dust reads lighter
    // than the soil it came from), plus clods.
    let biome = "default";
    const T = this.world.terrain;
    if (T && typeof T.biomeAt === "function") biome = T.biomeAt(p.x, p.z) || "default";
    const c = DUST[biome] || DUST.default;
    for (let i = 0; i < 7; i++) {
      const sp = 0.4 + rnd() * 1.2;
      P.spawn(p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05, (n.x + (rnd() - 0.5) * 0.8) * sp, (n.y * 0.8 + rnd() * 0.6) * sp, (n.z + (rnd() - 0.5) * 0.8) * sp, 1.2 + rnd() * 0.8, 0.35 * scale * puff, (1.3 + rnd() * 0.9) * scale * puff, c.r, c.g, c.b, 0.9, 0, 2.6, -0.08);
    }
    for (let i = 0; i < 8; i++) {
      const sp = 2 + rnd() * 3;
      P.spawn(p.x, p.y + 0.03, p.z, (n.x + (rnd() - 0.5) * 1.2) * sp, (n.y + rnd() * 0.6) * sp, (n.z + (rnd() - 0.5) * 1.2) * sp, 0.6 + rnd() * 0.4, (0.045 + rnd() * 0.03) * farS, 0.04 * farS, c.r * 0.55, c.g * 0.55, c.b * 0.55, 1, 2, 0.4, 9.8);
    }
  }

  _muzzleSmoke(def, m) {
    if (def.projectile > 0) return;
    const P = this._particles;
    const wind = this.world.wind;
    const wx = wind?.vector ? wind.vector.x * (0.3 + (wind.strength ?? 0.5) * 0.6) : 0.15;
    const wz = wind?.vector ? wind.vector.z * (0.3 + (wind.strength ?? 0.5) * 0.6) : 0.1;
    const big = def.id === "sniper" || def.id === "shotgun" ? 1.4 : 1;
    for (let i = 0; i < 3; i++) {
      const s = 0.5 + Math.random() * 0.8;
      P.spawn(m.x + _fwd.x * 0.25, m.y + _fwd.y * 0.25, m.z + _fwd.z * 0.25, _fwd.x * s + wx, _fwd.y * s + 0.15, _fwd.z * s + wz, 1.6 + Math.random() * 0.8, 0.12 * big, 0.9 * big, SMOKE.r, SMOKE.g, SMOKE.b, 0.16, 0, 1.6, -0.06);
    }
  }

  /**
   * World-space muzzle position: the viewmodel muzzle projected through the
   * viewmodel camera and un-projected through the world camera at the same depth,
   * so tracers and smoke leave the barrel you see despite the different FOVs.
   */
  _muzzleWorld(out) {
    const model = this._models[this.current];
    model.muzzle.getWorldPosition(out);
    out.applyMatrix4(this.viewCamera.matrixWorldInverse);
    const cam = this.camera;
    const k = cam?.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.viewCamera.fov) * 0.5) : 1;
    out.x *= k;
    out.y *= k;
    return out.applyMatrix4(cam.matrixWorld);
  }

  /* --- Viewmodel rendering --- */

  _syncViewCamera() {
    const cam = this.camera;
    if (!cam) return;
    cam.matrixWorld.decompose(this.viewCamera.position, this.viewCamera.quaternion, _s);
    const aspect = cam.aspect || 16 / 9;
    // A touch of push-in while aiming iron sights; the world FOV handles real zoom.
    const fov = VIEW_FOV * lerp(1, 0.9, this.aiming);
    if (this.viewCamera.aspect !== aspect || Math.abs(this.viewCamera.fov - fov) > 1e-4) {
      this.viewCamera.aspect = aspect;
      this.viewCamera.fov = fov;
      this.viewCamera.updateProjectionMatrix();
    }
    this.viewCamera.updateMatrixWorld(true);
  }

  _syncLights() {
    const sky = this.world.sky;
    const sun = this._sun;
    if (sky?.sunLight) {
      sun.color.copy(sky.sunLight.color);
      sun.intensity = sky.sunLight.intensity;
      _v.copy(sky.sunLight.position).sub(sky.sunLight.target.position);
      if (_v.lengthSq() < 1e-8) _v.copy(sky.sunDirection || UP);
      _v.normalize();
    } else {
      _v.set(0.4, 0.8, 0.3).normalize();
    }
    sun.position.copy(this.viewCamera.position).addScaledVector(_v, 10);
    this._sunTarget.position.copy(this.viewCamera.position);
    this._sunTarget.updateMatrixWorld();
    if (sky?.hemiLight) {
      this._hemi.color.copy(sky.hemiLight.color);
      this._hemi.groundColor.copy(sky.hemiLight.groundColor);
      this._hemi.intensity = sky.hemiLight.intensity;
    }
    // Reflections: the neutral baked environment tinted toward the live sky.
    const tint = viewmodelUniforms.envTint.value;
    if (sky?.fogColor && sky?.skyColor) {
      tint.copy(sky.fogColor).multiplyScalar(0.65).add(_col.copy(sky.skyColor).multiplyScalar(0.35));
      const lum = tint.r * 0.3 + tint.g * 0.55 + tint.b * 0.15;
      // Keep some colour, mostly brightness; boost because the baked env is mid-grey.
      tint.lerp(_col.setRGB(lum, lum, lum), 0.45).multiplyScalar(1.45);
    } else tint.setRGB(1, 1, 1);
  }

  /**
   * Draw the viewmodel on top of the already-rendered world, into whatever render
   * target is currently bound (the screen, or the low-res target of the "pixel"
   * style). Clears depth only, so it never clips into the world. Call once per
   * frame, right after `renderer.render(scene, camera)`, with the same target bound.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} [camera]  the world camera (defaults to the one given at construction)
   */
  renderViewmodel(renderer, camera = this.camera) {
    if (!renderer) return;
    if (camera && camera !== this.camera) this.camera = camera;
    // Contract fallback: if main parented the viewmodel to its camera, take it back.
    if (this.viewmodel.parent !== this.viewCamera) this.viewCamera.add(this.viewmodel);
    if (!this._envRT) {
      this._envRT = createViewmodelEnvironment(renderer);
      this.viewScene.environment = this._envRT.texture;
    }
    this._syncViewCamera();
    this._syncLights();
    if (this.lowered >= 0.999 || this.scoped) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.viewScene, this.viewCamera);
    renderer.autoClear = autoClear;
  }

  /** Remove everything from the world and free GPU resources (shared materials persist). */
  dispose() {
    this.fx.removeFromParent();
    this._particles.dispose();
    this._tracers.dispose();
    if (this._boltProto) {
      this._boltProto.traverse((o) => {
        if (o.isMesh) o.geometry.dispose();
      });
    }
    this._bolts.length = 0;
    for (const id in this._models) this._models[id].dispose();
    this._models = {};
    if (this._envRT) this._envRT.dispose();
    this._envRT = null;
    this._sun.dispose();
    this._hemi.dispose();
    this._vmFlash.dispose();
    this._worldFlash?.dispose();
  }
}

/* --- Fallback hit spheres --- */

const FALLBACK = [
  // [forward (×length), up (×hip height), side (×hip height), radius (×hip height), part]
  [-0.38, 0.72, 0, 0.16, "tail"],
  [-0.2, 0.88, 0, 0.27, "tail"],
  [0.0, 0.98, 0, 0.42, "body"],
  [0.14, 1.02, 0, 0.38, "body"],
  [0.28, 1.12, 0, 0.2, "neck"],
  [0.4, 1.18, 0, 0.16, "head"],
  [0.02, 0.45, 0.22, 0.2, "leg"],
  [0.02, 0.45, -0.22, 0.2, "leg"],
];

/** Approximate spheres from position / heading / species size when a model has none. */
function fallbackSpheres(c, out) {
  const sp = c.species || {};
  const sc = c.scale ?? 1;
  const L = (sp.length ?? 4) * sc;
  const H = (sp.height ?? 1.4) * sc;
  const hd = c.heading ?? 0;
  const fx = Math.sin(hd);
  const fz = Math.cos(hd);
  for (let i = 0; i < FALLBACK.length; i++) {
    const [f, u, s, r, part] = FALLBACK[i];
    const o = out[i] || (out[i] = { x: 0, y: 0, z: 0, r: 0, part: "body" });
    o.x = c.position.x + fx * f * L + fz * s * H;
    o.y = c.position.y + u * H;
    o.z = c.position.z + fz * f * L - fx * s * H;
    o.r = Math.max(part === "head" ? 0.12 : 0.1, r * H);
    o.part = part;
  }
  out.length = FALLBACK.length;
  return out;
}
