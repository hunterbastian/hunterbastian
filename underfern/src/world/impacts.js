// Impacts — what a blow throws off: a spray of blood from a bite or a heavy
// (more from a critical or a haemorrhage), pale grit where a parry turns a
// blow, and a scuff of dust under a dodge or a stagger.
//
// One Points cloud, one draw call: a fixed pool of particles simulated on the
// CPU (ballistic, with drag), reused oldest-first. Blood that reaches the
// ground stays there a moment as a splash before it fades. Particles step with
// the sim's dt, so a hit-stop freezes the spray mid-air with the blow.
// Fights far from the camera throw nothing.

import * as THREE from "three";
import { clamp, lerp } from "../core/math.js";

const GRAVITY = 15; // m/s²: a touch heavier than real, so it reads at game scale
const FAR = 90; // m from the camera beyond which nothing is spawned

const VERT = /* glsl */ `
attribute vec4 aCol;   // rgb, alpha
attribute float aSize; // metres across
attribute float aSoft; // 0 a droplet, 1 a dust puff
uniform float uScale;  // pixels per metre at 1 m
varying vec4 vCol;
varying float vSoft;

void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vCol = aCol;
  vSoft = aSoft;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.3), 1.0, 64.0);
  if (aCol.a < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec4 vCol;
varying float vSoft;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Droplets are hard-edged and darker at the rim; dust is a soft puff.
  float drop = 1.0 - smoothstep(0.55, 1.0, r2);
  float puff = exp(-r2 * 3.0) * (1.0 - r2);
  float a = mix(drop, puff, vSoft) * vCol.a;
  vec3 c = vCol.rgb * mix(1.0 - 0.35 * r2, 1.0, vSoft);
  gl_FragColor = vec4(c, a);
}
`;

// Display-referred colours (the cloud isn't tone mapped).
const BLOOD = [
  [0.42, 0.04, 0.03],
  [0.55, 0.07, 0.05],
  [0.3, 0.02, 0.02],
];
const GRIT = [0.86, 0.8, 0.66];
const DUST = [0.55, 0.49, 0.38];

const _v = new THREE.Vector3();

export class Impacts {
  /**
   * @param {import("../core/events.js").EventBus} events
   * @param {{ low?: boolean }} [opts]
   */
  constructor(events, { low = false } = {}) {
    const n = low ? 96 : 192;
    this.max = n;
    this.camera = null;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.soft = new Float32Array(n);
    this.life = new Float32Array(n); // s left
    this.life0 = new Float32Array(n);
    this.ground = new Float32Array(n); // y it lands at
    this.grow = new Float32Array(n); // size growth per second (dust spreads)
    this.alpha0 = new Float32Array(n);
    this._next = 0;
    this._live = 0;
    this._seed = 1;

    const geo = new THREE.BufferGeometry();
    this._aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this._aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this._aSoft = new THREE.BufferAttribute(this.soft, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this._aPos);
    geo.setAttribute("aCol", this._aCol);
    geo.setAttribute("aSize", this._aSize);
    geo.setAttribute("aSoft", this._aSoft);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = { uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({
      name: "Impacts",
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.name = "impacts";
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;

    this._off = [];
    if (events) {
      this._off.push(
        events.on("attack", (e) => this._onAttack(e)),
        events.on("haemorrhage", (e) => this._blood(e.creature, e.by, 20, 1.2)),
        events.on("dodge", (e) => this._dust(e.creature, 8, 0.9)),
        events.on("stagger", (e) => this._dust(e.creature, 10, 1)),
        events.on("crush", (e) => this._dust(e.creature, 14, 1.3)),
      );
    }
  }

  _rand() {
    // A tiny LCG: cosmetic, no need for the seeded world RNG.
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  _near(c) {
    const cam = this.camera;
    if (!c || !c.position) return false;
    if (!cam) return true;
    const dx = c.position.x - cam.position.x;
    const dz = c.position.z - cam.position.z;
    return dx * dx + dz * dz < FAR * FAR;
  }

  _onAttack(e) {
    const t = e.target;
    if (!t || !this._near(t)) return;
    if (e.parried) {
      this._grit(t, e.attacker);
      return;
    }
    if (e.dodged || !(e.damage > 0)) return;
    const heavy = e.heavy || 0;
    const n = e.critical ? 26 : heavy > 0 ? Math.round(12 + 10 * heavy) : 8;
    this._blood(t, e.attacker, n, e.critical ? 1.3 : heavy > 0 ? 1 + 0.2 * heavy : 0.75);
    if (heavy > 0 || e.staggered) this._dust(t, 5, 0.8);
  }

  /** Size of an animal, in metres-ish, for scaling sprays. */
  _k(c) {
    const h = (c.species?.height ?? 1) * (c.scale ?? 1);
    return clamp(h / 1.6, 0.45, 2.6);
  }

  /** Where a blow lands: on the victim's chest, on the attacker's side. */
  _hitPoint(c, by, out) {
    const h = (c.species?.height ?? 1) * (c.scale ?? 1);
    out.set(c.position.x, c.position.y + h * 0.72, c.position.z);
    if (by && by.position) {
      const dx = by.position.x - c.position.x;
      const dz = by.position.z - c.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const r = Math.min(c.radius ?? 0.5, d * 0.5);
      out.x += (dx / d) * r * 0.8;
      out.z += (dz / d) * r * 0.8;
    }
    return out;
  }

  _blood(c, by, n, force) {
    if (!c || !this._near(c)) return;
    const k = this._k(c);
    this._hitPoint(c, by, _v);
    // Spray away from the biter, and up.
    let ax = 0;
    let az = 0;
    if (by && by.position) {
      const dx = c.position.x - by.position.x;
      const dz = c.position.z - by.position.z;
      const d = Math.hypot(dx, dz) || 1;
      ax = dx / d;
      az = dz / d;
    }
    for (let i = 0; i < n; i++) {
      const sp = (2 + this._rand() * 4.5) * force * Math.sqrt(k);
      const a = this._rand() * Math.PI * 2;
      const sx = Math.cos(a) * 0.8;
      const sz = Math.sin(a) * 0.8;
      const col = BLOOD[(this._rand() * BLOOD.length) | 0];
      this._spawn(
        _v.x + (this._rand() - 0.5) * 0.35 * k,
        _v.y + (this._rand() - 0.5) * 0.35 * k,
        _v.z + (this._rand() - 0.5) * 0.35 * k,
        (ax * 0.7 + sx) * sp,
        (0.35 + this._rand() * 0.75) * sp,
        (az * 0.7 + sz) * sp,
        col,
        lerp(0.08, 0.2, this._rand()) * k,
        0,
        0.7 + this._rand() * 0.6,
        c.position.y,
        0.95,
      );
    }
    // A puff of red mist at the wound: it reads at once, even held in a hit-stop.
    const puffs = Math.min(4, 1 + Math.round(n / 8));
    for (let i = 0; i < puffs; i++) {
      const col = BLOOD[1];
      this._spawn(
        _v.x + (this._rand() - 0.5) * 0.3 * k,
        _v.y + (this._rand() - 0.5) * 0.3 * k,
        _v.z + (this._rand() - 0.5) * 0.3 * k,
        ax * 1.2 + (this._rand() - 0.5),
        0.3 + this._rand() * 0.5,
        az * 1.2 + (this._rand() - 0.5),
        col,
        lerp(0.35, 0.55, this._rand()) * k * Math.sqrt(force),
        1,
        0.35 + this._rand() * 0.2,
        c.position.y - 10,
        0.55,
        0.9 * k,
      );
    }
  }

  _grit(c, by) {
    if (!c) return;
    const k = this._k(c);
    this._hitPoint(c, by, _v);
    for (let i = 0; i < 12; i++) {
      const sp = (3 + this._rand() * 4) * Math.sqrt(k);
      const a = this._rand() * Math.PI * 2;
      this._spawn(_v.x, _v.y, _v.z, Math.cos(a) * sp, (0.2 + this._rand() * 0.9) * sp, Math.sin(a) * sp, GRIT, lerp(0.04, 0.08, this._rand()) * k, 0.2, 0.3 + this._rand() * 0.25, c.position.y - 10, 0.9);
    }
    for (let i = 0; i < 4; i++) {
      this._spawn(_v.x, _v.y, _v.z, (this._rand() - 0.5) * 1.5, this._rand(), (this._rand() - 0.5) * 1.5, GRIT, 0.35 * k, 1, 0.45, c.position.y - 10, 0.35, 1.6 * k);
    }
  }

  _dust(c, n, force) {
    if (!c || !this._near(c) || c.swimming) return;
    const k = this._k(c);
    const r = (c.radius ?? 0.5) * 0.9;
    for (let i = 0; i < n; i++) {
      const a = this._rand() * Math.PI * 2;
      const sp = (0.8 + this._rand() * 1.6) * force * Math.sqrt(k);
      this._spawn(
        c.position.x + Math.cos(a) * r,
        c.position.y + 0.1,
        c.position.z + Math.sin(a) * r,
        Math.cos(a) * sp,
        0.4 + this._rand() * 0.9,
        Math.sin(a) * sp,
        DUST,
        lerp(0.3, 0.6, this._rand()) * k,
        1,
        0.7 + this._rand() * 0.6,
        c.position.y - 10,
        0.32,
        lerp(0.6, 1.2, this._rand()) * k,
      );
    }
  }

  _spawn(x, y, z, vx, vy, vz, rgb, size, soft, life, ground, alpha, grow = 0) {
    const i = this._next;
    this._next = (i + 1) % this.max;
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i4] = rgb[0];
    this.col[i4 + 1] = rgb[1];
    this.col[i4 + 2] = rgb[2];
    this.col[i4 + 3] = alpha;
    this.alpha0[i] = alpha;
    this.size[i] = size;
    this.soft[i] = soft;
    this.life[i] = life;
    this.life0[i] = life;
    this.ground[i] = ground;
    this.grow[i] = grow;
    this._live = Math.max(this._live, 1);
  }

  /**
   * @param {number} dt sim seconds (slowed by hit-stop)
   * @param {THREE.PerspectiveCamera} [camera]
   * @param {number} [bufferHeight] drawing-buffer height in pixels
   */
  update(dt, camera, bufferHeight = 720) {
    if (camera) {
      this.camera = camera;
      this.uniforms.uScale.value = bufferHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    }
    if (!this._live) return;
    let live = 0;
    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      const i4 = i * 4;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.col[i4 + 3] = 0;
        continue;
      }
      live++;
      const soft = this.soft[i] > 0.5;
      const landed = this.vel[i3 + 1] === 0 && this.pos[i3 + 1] <= this.ground[i] + 0.03;
      if (!landed) {
        this.vel[i3] *= drag;
        this.vel[i3 + 2] *= drag;
        // Dust drifts and settles; droplets fall.
        this.vel[i3 + 1] = soft ? this.vel[i3 + 1] * drag - 0.6 * dt : this.vel[i3 + 1] * drag - GRAVITY * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (this.pos[i3 + 1] < this.ground[i] + 0.02) {
          // A droplet that lands stays as a splash a little longer.
          this.pos[i3 + 1] = this.ground[i] + 0.02;
          this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
          this.size[i] *= 1.6;
          this.life[i] = Math.max(this.life[i], 1.4);
          this.life0[i] = Math.max(this.life0[i], this.life[i]);
        }
      }
      if (this.grow[i]) this.size[i] += this.grow[i] * dt;
      const f = this.life[i] / this.life0[i];
      this.col[i4 + 3] = this.alpha0[i] * (soft ? f * f : Math.min(1, f * 3));
    }
    this._live = live;
    this.points.visible = live > 0;
    this._aPos.needsUpdate = true;
    this._aCol.needsUpdate = true;
    this._aSize.needsUpdate = true;
    this._aSoft.needsUpdate = true;
  }

  /** How many particles are in flight (tests). */
  get live() {
    return this._live;
  }

  dispose() {
    for (const off of this._off) off?.();
    this._off.length = 0;
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
