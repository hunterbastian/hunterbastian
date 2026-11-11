// A living creature built from a genome.
//
// Nothing here is pre-authored: the body is a tube skinned along the spine on
// the CPU every frame, legs plant their feet in the world and step when they
// fall behind (two-bone IK), and the head, jaw, eyes and tail are driven by a
// handful of procedural rules. Any genome the editor can produce will stand
// up and walk.

import * as THREE from './three.js';
import { PARTS, buildPartObject, disposePartObject } from './parts.js';
import { computeStats, isMirrored } from './genome.js';
import { makeKit, V_BODY, V_LIMB0, V_LIMB1, haloTexture } from './skin.js';
import { clamp, damp, angDiff, TAU, HALF_PI } from './util.js';

const SEG = 14; // quads around the body
const RPS = 5; // rings per spine span
const CAP = 4; // rings per end cap
const LSEG = 7; // quads around a limb
const LRING = 6; // rings along a limb
const ROW = SEG + 1;
const LROW = LSEG + 1;

const COS = new Float32Array(ROW);
const SIN = new Float32Array(ROW);
for (let k = 0; k < ROW; k++) {
  const a = -Math.PI + (TAU * k) / SEG;
  COS[k] = Math.cos(a);
  SIN[k] = Math.sin(a);
}
const LCOS = new Float32Array(LROW);
const LSIN = new Float32Array(LROW);
for (let k = 0; k < LROW; k++) {
  LCOS[k] = Math.cos((TAU * k) / LSEG);
  LSIN[k] = Math.sin((TAU * k) / LSEG);
}

// Scratch state shared by every creature (single-threaded, never re-entrant).
const F = { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 1, nx: 0, ny: 1, nz: 0, bx: 1, by: 0, bz: 0, R: 0.1, nr: 1, nt: 0, ft: 1, fr: 0 };
const SP = new THREE.Vector3();
const SN = new THREE.Vector3();
const SF = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const K = new THREE.Vector3();
const FT = new THREE.Vector3();
const H = new THREE.Vector3();

let shadowMat = null;
let shadowGeo = null;

export class Creature {
  constructor(genome, opts = {}) {
    this.genome = genome;
    this.kit = opts.kit || makeKit(genome.skin, opts.seed || 1);
    this.ownKit = !opts.kit;
    this.ground = opts.ground || (() => 0);
    this.scale = opts.scale || 1;
    this.shadow = opts.shadow !== false;

    this.root = new THREE.Group();
    this.root.userData.creature = this;
    this.root.scale.setScalar(this.scale);

    this.heading = 0;
    this.prevHeading = 0;
    this.vel = new THREE.Vector3();
    this.speedSm = 0;
    this.angVel = 0;
    this.time = Math.random() * 20;
    this.walkPhase = Math.random() * 6;
    this.look = null; // world-space point to look at, or null
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.action = null;
    this.sleeping = false;
    this.sleepAmt = 0;
    this.dead = false;
    this.free = false; // airborne / swimming: feet don't plant
    this.paddle = 0;
    this.treadmill = false;
    this.flash = 0;
    this.bob = 0;
    this.blink = 0;
    this.blinkT = 1 + Math.random() * 4;
    this.grow = 1;
    this.onStep = null;
    this.M = new THREE.Matrix4();
    this.xr = new THREE.Vector3(1, 0, 0);
    this.mat = new THREE.MeshStandardMaterial({ map: this.kit.tex, roughness: 0.7, metalness: 0 });
    this.mesh = null;
    this.surf = [];
    this.limbs = [];
    this.build();
  }

  /* ------------------------------ building ------------------------------ */

  build() {
    this._clear();
    const g = this.genome;
    const n = (this.n = g.spine.length);
    this.stats = computeStats(g);
    this.nodes = g.spine.map(() => ({ x: 0, y: 0, z: 0, r: 0.1 }));
    this.ex = [];
    for (let i = 0; i < n + 2; i++) this.ex.push({ x: 0, y: 0, z: 0, r: 0.1 });

    for (const pg of g.parts) {
      const def = PARTS[pg.id];
      if (!def) continue;
      const sides = isMirrored(pg.a) ? [1, -1] : [0];
      for (const side of sides) {
        if (def.cat === 'leg' || def.cat === 'arm') {
          const end = buildPartObject(def, this.kit, def.cat === 'leg' ? 'foot' : 'hand');
          end.userData.part = pg;
          this.root.add(end);
          this.limbs.push({
            g: pg, def, side, isLeg: def.cat === 'leg', end,
            home: new THREE.Vector3(), foot: new THREE.Vector3(), from: new THREE.Vector3(),
            t: -1, dur: 0.2, group: 0, stepLen: 0.3, lift: 0.1, L: 0.5, init: false, phase: Math.random() * 6,
          });
        } else {
          const obj = buildPartObject(def, this.kit, 'make');
          obj.userData.part = pg;
          this.root.add(obj);
          this.surf.push({ g: pg, def, side, obj });
        }
      }
    }

    // ring layout: tail cap, body, head cap
    const ringU = [];
    for (let c = CAP; c >= 1; c--) ringU.push(-c / CAP);
    for (let i = 0; i <= (n - 1) * RPS; i++) ringU.push(i / RPS);
    for (let c = 1; c <= CAP; c++) ringU.push(n - 1 + c / CAP);
    this.ringU = ringU;
    const nR = ringU.length;
    const bodyVerts = nR * ROW;
    const limbVerts = this.limbs.length * LRING * LROW;
    const total = bodyVerts + limbVerts;
    this.bodyVerts = bodyVerts;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const idx = [];
    for (let j = 0; j < nR; j++) {
      for (let k = 0; k < ROW; k++) {
        const o = (j * ROW + k) * 2;
        uv[o] = k / SEG;
        uv[o + 1] = (j / (nR - 1)) * V_BODY;
      }
    }
    for (let j = 0; j < nR - 1; j++) {
      for (let k = 0; k < SEG; k++) {
        const a = j * ROW + k;
        const b = a + ROW;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.bodyTris = idx.length / 3;
    this.limbs.forEach((L, li) => {
      const base = bodyVerts + li * LRING * LROW;
      L.vbase = base;
      for (let j = 0; j < LRING; j++) {
        for (let k = 0; k < LROW; k++) {
          const o = (base + j * LROW + k) * 2;
          uv[o] = 0.3;
          uv[o + 1] = V_LIMB0 + (V_LIMB1 - V_LIMB0) * (j / (LRING - 1));
        }
      }
      for (let j = 0; j < LRING - 1; j++) {
        for (let k = 0; k < LSEG; k++) {
          const a = base + j * LROW + k;
          const b = a + LROW;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.norAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 3);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.userData.creature = this;
    this.root.add(this.mesh);

    if (this.shadow) {
      if (!shadowMat) {
        shadowMat = new THREE.MeshBasicMaterial({ map: haloTexture(), color: 0x000000, transparent: true, opacity: 0.36, depthWrite: false });
        shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      }
      this.blob = new THREE.Mesh(shadowGeo, shadowMat);
      this.blob.renderOrder = 1;
      this.root.add(this.blob);
    }

    this.restDirty = true;
    this._computeStance();
    this.curY = this.stY;
    this.curPitch = this.stPitch;
    this.update(0);
  }

  _clear() {
    if (this.mesh) {
      this.root.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    for (const s of this.surf) {
      this.root.remove(s.obj);
      disposePartObject(s.obj);
    }
    for (const l of this.limbs) {
      this.root.remove(l.end);
      disposePartObject(l.end);
    }
    if (this.blob) this.root.remove(this.blob);
    this.blob = null;
    this.surf = [];
    this.limbs = [];
  }

  dispose() {
    this._clear();
    this.mat.dispose();
    if (this.ownKit) this.kit.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  setScale(s) {
    this.scale = s;
  }

  /* ------------------------------- surface ------------------------------ */

  // Evaluate the body frame at spine parameter u into F.
  _frame(u) {
    const last = this.n - 1;
    let cap = 0;
    let phi = 0;
    let ub = u;
    if (u < 0) {
      cap = -1;
      phi = Math.min(-u, 1) * HALF_PI;
      ub = 0;
    } else if (u > last) {
      cap = 1;
      phi = Math.min(u - last, 1) * HALF_PI;
      ub = last;
    }
    let i = Math.floor(ub);
    if (i > last - 1) i = last - 1;
    if (i < 0) i = 0;
    const t = ub - i;
    const t2 = t * t;
    const t3 = t2 * t;
    const w0 = 0.5 * (-t + 2 * t2 - t3);
    const w1 = 0.5 * (2 - 5 * t2 + 3 * t3);
    const w2 = 0.5 * (t + 4 * t2 - 3 * t3);
    const w3 = 0.5 * (-t2 + t3);
    const d0 = 0.5 * (-1 + 4 * t - 3 * t2);
    const d1 = 0.5 * (-10 * t + 9 * t2);
    const d2 = 0.5 * (1 + 8 * t - 9 * t2);
    const d3 = 0.5 * (-2 * t + 3 * t2);
    const e = this.ex;
    const a = e[i];
    const b = e[i + 1];
    const c = e[i + 2];
    const d = e[i + 3];
    let cx = w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x;
    let cy = w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y;
    let cz = w0 * a.z + w1 * b.z + w2 * c.z + w3 * d.z;
    let r = w0 * a.r + w1 * b.r + w2 * c.r + w3 * d.r;
    if (r < 0.015) r = 0.015;
    let tx = d0 * a.x + d1 * b.x + d2 * c.x + d3 * d.x;
    let ty = d0 * a.y + d1 * b.y + d2 * c.y + d3 * d.y;
    let tz = d0 * a.z + d1 * b.z + d2 * c.z + d3 * d.z;
    const dr = d0 * a.r + d1 * b.r + d2 * c.r + d3 * d.r;
    const len = Math.hypot(tx, ty, tz) || 1e-6;
    tx /= len;
    ty /= len;
    tz /= len;
    const X = this.xr;
    const dot = X.x * tx + X.y * ty + X.z * tz;
    let bx = X.x - dot * tx;
    let by = X.y - dot * ty;
    let bz = X.z - dot * tz;
    const bl = Math.hypot(bx, by, bz) || 1e-6;
    bx /= bl;
    by /= bl;
    bz /= bl;
    F.nx = ty * bz - tz * by;
    F.ny = tz * bx - tx * bz;
    F.nz = tx * by - ty * bx;
    if (cap === 0) {
      const slope = dr / len;
      const k = 1 / Math.sqrt(1 + slope * slope);
      F.R = r;
      F.nr = k;
      F.nt = -slope * k;
      F.ft = 1;
      F.fr = 0;
    } else {
      const s = Math.sin(phi);
      const co = Math.cos(phi);
      cx += tx * cap * r * s;
      cy += ty * cap * r * s;
      cz += tz * cap * r * s;
      F.R = r * co;
      F.nr = co;
      F.nt = cap * s;
      F.ft = co;
      F.fr = -cap * s;
    }
    F.cx = cx;
    F.cy = cy;
    F.cz = cz;
    F.tx = tx;
    F.ty = ty;
    F.tz = tz;
    F.bx = bx;
    F.by = by;
    F.bz = bz;
  }

  // Point, normal and "toward the head" direction on the skin (root space).
  surface(u, a, pos = SP, nrm = SN, fwd = SF) {
    this._frame(u);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rx = ca * F.nx + sa * F.bx;
    const ry = ca * F.ny + sa * F.by;
    const rz = ca * F.nz + sa * F.bz;
    pos.set(F.cx + rx * F.R, F.cy + ry * F.R, F.cz + rz * F.R);
    nrm.set(F.nr * rx + F.nt * F.tx, F.nr * ry + F.nt * F.ty, F.nr * rz + F.nt * F.tz).normalize();
    fwd.set(F.ft * F.tx + F.fr * rx, F.ft * F.ty + F.fr * ry, F.ft * F.tz + F.fr * rz);
    return pos;
  }

  /* -------------------------------- stance ------------------------------ */

  _restEx(M) {
    const sp = this.genome.spine;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const e = this.ex[i + 1];
      _v.set(0, sp[i].y, sp[i].z);
      if (M) _v.applyMatrix4(M);
      e.x = _v.x;
      e.y = _v.y;
      e.z = _v.z;
      e.r = sp[i].r;
    }
    this._phantoms();
  }

  _phantoms() {
    const e = this.ex;
    const n = this.n;
    const a = e[1];
    const b = e[Math.min(2, n)];
    e[0].x = 2 * a.x - b.x;
    e[0].y = 2 * a.y - b.y;
    e[0].z = 2 * a.z - b.z;
    e[0].r = a.r;
    const c = e[n];
    const d = e[Math.max(n - 1, 1)];
    e[n + 1].x = 2 * c.x - d.x;
    e[n + 1].y = 2 * c.y - d.y;
    e[n + 1].z = 2 * c.z - d.z;
    e[n + 1].r = c.r;
  }

  // Work out how high the body rides and how it pitches so that every leg
  // can reach the ground comfortably, then where each foot wants to rest.
  _computeStance() {
    this.restDirty = false;
    this.stats = computeStats(this.genome);
    const sp = this.genome.spine;
    this.xr.set(1, 0, 0);
    this._restEx(null);
    const legs = this.limbs.filter((l) => l.isLeg);
    let pitch = 0;
    let y0 = 0;
    const info = [];
    for (const L of legs) {
      const s = L.g.s || 1;
      this.surface(L.g.u, (L.side < 0 ? -L.g.a : L.g.a));
      const len = (L.def.upper + L.def.lower) * s;
      L.L = len;
      info.push({ L, hx: SP.x, hy: SP.y, hz: SP.z, h: L.def.stance * len + L.def.ankle * s });
    }
    if (info.length) {
      let mz = 0;
      let md = 0;
      for (const o of info) {
        mz += o.hz;
        md += o.h - o.hy;
      }
      mz /= info.length;
      md /= info.length;
      let vz = 0;
      let cov = 0;
      for (const o of info) {
        vz += (o.hz - mz) * (o.hz - mz);
        cov += (o.hz - mz) * (o.h - o.hy - md);
      }
      if (vz > 0.02) pitch = clamp(Math.atan(cov / vz), -0.5, 0.5);
      const cp = Math.cos(pitch);
      const sn = Math.sin(pitch);
      for (const o of info) y0 += o.h - (o.hy * cp + o.hz * sn);
      y0 /= info.length;
    }
    const cp = Math.cos(pitch);
    const sn = Math.sin(pitch);
    let belly = Infinity;
    let top = 0;
    let zMax = 0;
    let rMax = 0;
    for (const p of sp) {
      const yy = p.y * cp + p.z * sn;
      const zz = -p.y * sn + p.z * cp;
      belly = Math.min(belly, yy - p.r);
      top = Math.max(top, yy + p.r);
      zMax = Math.max(zMax, Math.abs(zz) + p.r);
      rMax = Math.max(rMax, p.r);
    }
    if (!info.length) y0 = -belly;
    y0 = Math.max(y0, 0.02 - belly);
    this.stY = y0;
    this.stPitch = pitch;
    this.restBelly = -belly; // ride height when lying down
    this.height = top + y0;
    this.halfLen = zMax;
    this.len = Math.max(this.stats.length, 0.4);
    this.radius = clamp(Math.max(zMax * 0.5, rMax * 1.3), 0.25, 1.6);
    this.noLegs = legs.length === 0;

    // foot homes, step sizes and gait groups
    info.sort((p, q) => q.hz - p.hz);
    let pair = -1;
    let lastG = null;
    for (const o of info) {
      const L = o.L;
      if (L.g !== lastG) {
        pair++;
        lastG = L.g;
      }
      const hipY = o.hy * cp + o.hz * sn + y0;
      const hipZ = -o.hy * sn + o.hz * cp;
      const reach = Math.sqrt(Math.max((0.95 * L.L) ** 2 - hipY * hipY, 0));
      const splay = Math.min((L.def.splay || 0.12) * L.L, reach);
      L.home.set(o.hx + L.side * splay, 0, hipZ + L.L * 0.03);
      L.stepLen = clamp(L.L * 0.5, 0.12, 0.7);
      L.lift = L.L * 0.2;
      L.group = (pair + (L.side > 0 ? 1 : 0)) % 2;
      if (!L.init) {
        this._toWorld(L.home, L.foot);
        L.foot.y = this.ground(L.foot.x, L.foot.z);
        L.init = true;
      }
    }
    let avg = 0;
    for (const L of legs) avg += L.L;
    this.cadence = legs.length ? 2.6 / (avg / legs.length) : 3.2 / this.len;
    if (this.mesh) {
      const bs = this.mesh.geometry.boundingSphere;
      bs.center.set(0, this.height * 0.5, 0);
      bs.radius = Math.max(this.height, zMax * 1.2) + 1.2;
    }
  }

  _toWorld(local, out) {
    const p = this.root.position;
    const sc = this.root.scale.x;
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const lx = local.x;
    const lz = local.z;
    out.set(p.x + (lx * ch + lz * sh) * sc, p.y + local.y * sc, p.z + (-lx * sh + lz * ch) * sc);
    return out;
  }

  _toLocal(world, out) {
    const p = this.root.position;
    const sc = this.root.scale.x;
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const dx = (world.x - p.x) / sc;
    const dz = (world.z - p.z) / sc;
    out.set(dx * ch - dz * sh, (world.y - p.y) / sc, dx * sh + dz * ch);
    return out;
  }

  // Drop every foot straight under its hip (after a teleport or spawn).
  resetFeet() {
    for (const L of this.limbs) {
      if (!L.isLeg) continue;
      this._toWorld(L.home, L.foot);
      L.foot.y = this.ground(L.foot.x, L.foot.z);
      L.t = -1;
    }
  }

  // Map a raycast hit on the skin mesh back to surface coordinates, or to
  // the limb whose tube was hit.
  hitInfo(hit) {
    if (hit.faceIndex >= this.bodyTris) {
      const li = Math.floor((hit.faceIndex - this.bodyTris) / ((LRING - 1) * LSEG * 2));
      return { limb: this.limbs[li] };
    }
    const nR = this.ringU.length;
    const f = clamp(hit.uv.y / V_BODY, 0, 1) * (nR - 1);
    const j = Math.min(Math.floor(f), nR - 2);
    return { u: this.ringU[j] + (this.ringU[j + 1] - this.ringU[j]) * (f - j), a: (hit.uv.x - 0.5) * TAU };
  }

  /* ------------------------------- actions ------------------------------ */

  play(name, dur) {
    if (this.dead) return;
    const D = { bite: 0.42, ram: 0.6, swipe: 0.4, trill: 1.25, sway: 1.4, flare: 1.25, glow: 1.25, eat: 1.0, hurt: 0.32, happy: 0.9, no: 0.7, die: 1.1, hatch: 0.9 };
    this.action = { name, t: 0, dur: dur || D[name] || 0.6 };
    if (name === 'hatch') this.grow = 0;
  }

  get busy() {
    return !!this.action && this.action.name !== 'hurt';
  }

  headPos(out) {
    const e = this.ex[this.n];
    return this._toWorld(_v2.set(e.x, e.y, e.z), out);
  }

  /* -------------------------------- update ------------------------------ */

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const root = this.root;
    const g = this.genome;
    const n = this.n;
    if (this.restDirty) this._computeStance();

    let sc = this.scale;
    // pose channels
    let pitchAdd = 0;
    let yawAdd = 0;
    let rollAdd = 0;
    let yAdd = 0;
    let lunge = 0;
    let headPitch = 0;
    let headYaw = 0;
    let jaw = 0;
    let flare = 0;
    let glow = 0;
    let reach = 0;
    let puff = 1;
    const A = this.action;
    if (A) {
      A.t += dt;
      const p = clamp(A.t / A.dur, 0, 1);
      const bell = Math.sin(Math.PI * p);
      switch (A.name) {
        case 'bite': lunge = bell * 0.3; jaw = Math.sin(Math.PI * Math.min(p * 1.7, 1)); break;
        case 'ram': pitchAdd = -bell * 0.3; lunge = bell * 0.16; break;
        case 'swipe': yawAdd = Math.sin(p * TAU) * 0.4; reach = bell; break;
        case 'trill': headPitch = bell * 0.5; jaw = bell * (0.55 + 0.45 * Math.sin(A.t * 38)); puff = 1 + bell * 0.04 * Math.sin(A.t * 30); break;
        case 'sway': yawAdd = Math.sin(p * TAU * 2) * 0.5 * bell; yAdd = Math.abs(Math.sin(p * TAU * 2)) * 0.1; rollAdd = Math.sin(p * TAU * 2 + 1) * 0.14 * bell; break;
        case 'flare': pitchAdd = bell * 0.36; flare = Math.min(bell * 1.6, 1); puff = 1 + bell * 0.07; break;
        case 'glow': glow = bell; puff = 1 + bell * 0.03; break;
        case 'eat': headPitch = -0.55 * Math.min(1, p * 5) * Math.min(1, (1 - p) * 6); jaw = 0.5 + 0.5 * Math.sin(A.t * 19); break;
        case 'hurt': this.flash = 1 - p; pitchAdd = -bell * 0.1; puff = 1 - bell * 0.05; break;
        case 'happy': yAdd = Math.abs(Math.sin(p * TAU)) * 0.22; headPitch = bell * 0.3; yawAdd = Math.sin(p * TAU) * 0.3; break;
        case 'no': headYaw = Math.sin(p * TAU * 2) * 0.55; break;
        case 'hatch': { const k = 1 - p; this.grow = 1 - k * k * k + Math.sin(p * Math.PI) * 0.12; yawAdd = (1 - p) * 0.8 * Math.sin(p * 14); break; }
        case 'die': rollAdd = Math.min(1, p * 1.4) * 1.4; jaw = bell * 0.6; break;
        default: break;
      }
      if (p >= 1) {
        if (A.name === 'die') {
          this.dead = true;
          A.t = A.dur;
        } else {
          if (A.name === 'hatch') this.grow = 1;
          this.action = null;
        }
      }
    } else this.flash = Math.max(0, this.flash - dt * 4);
    sc = Math.max(sc * this.grow, 0.001);
    root.scale.setScalar(sc);
    root.rotation.y = this.heading;

    // motion in root space
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const lvx = (this.vel.x * ch - this.vel.z * sh) / sc;
    const lvz = (this.vel.x * sh + this.vel.z * ch) / sc;
    const spd = Math.hypot(lvx, lvz);
    this.speedSm = damp(this.speedSm, spd, 8, dt);
    if (dt > 0) {
      const av = angDiff(this.prevHeading, this.heading) / dt;
      this.angVel = damp(this.angVel, clamp(av, -6, 6), 6, dt);
    }
    this.prevHeading = this.heading;
    this.walkPhase += spd * dt * this.cadence;
    const gait = Math.min(this.speedSm / 2.2, 1.5);

    // sleep / death lower the body onto its belly
    this.sleepAmt = damp(this.sleepAmt, this.sleeping || this.dead || (A && A.name === 'die') ? 1 : 0, 3, dt);
    const lie = this.sleepAmt;
    const targetY = this.stY + (this.restBelly - this.stY) * lie;
    this.curY = damp(this.curY, targetY, 9, dt);
    this.curPitch = damp(this.curPitch, this.stPitch * (1 - lie), 9, dt);
    if (lie > 0.02) headPitch -= 0.35 * lie;

    // where to look
    let ly = Math.sin(this.time * 0.37 + this.walkPhase * 0.01) * 0.28 + Math.sin(this.time * 0.13 + 1.7) * 0.2;
    let lp = Math.sin(this.time * 0.23) * 0.08;
    const head = this.ex[n];
    let lookLocal = null;
    if (this.look && !lie) {
      lookLocal = this._toLocal(this.look, _z);
      const dx = lookLocal.x - head.x;
      const dy = lookLocal.y - head.y;
      const dz = lookLocal.z - head.z;
      const yaw = Math.atan2(dx, dz);
      if (Math.abs(yaw) < 2.3) {
        ly = clamp(yaw, -1.1, 1.1);
        lp = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.7, 0.7);
      }
    }
    if (lie > 0.5) ly = lp = 0;
    this.lookYaw = damp(this.lookYaw, ly, 6, dt);
    this.lookPitch = damp(this.lookPitch, lp, 6, dt);

    // animate the spine in body space
    const sp = g.spine;
    const noLegs = this.noLegs;
    const len = this.len;
    const waveAmp = (noLegs ? 0.1 : 0.022) * len * Math.min(gait, 1.2);
    const tailSwing = clamp(-this.angVel * 0.04, -0.22, 0.22) * len;
    const breath = Math.sin(this.time * (lie > 0.5 ? 1.0 : 1.7));
    const pv = Math.max(0, Math.min(n - 2, Math.round((n - 1) * 0.6)));
    const pvn = sp[pv];
    const hYaw = this.lookYaw + headYaw;
    const hPit = this.lookPitch + headPitch;
    for (let i = 0; i < n; i++) {
      const s = n > 1 ? i / (n - 1) : 0;
      const rest = sp[i];
      const tail = (1 - s) * (1 - s);
      let x = Math.sin(this.walkPhase * (noLegs ? 1.5 : 1) - s * (noLegs ? 5.5 : 2.6)) * waveAmp * (0.35 + tail * 1.3);
      x += tailSwing * tail + Math.sin(this.time * 1.1 + 2) * 0.02 * tail * len * (1 - lie);
      let y = rest.y;
      let z = rest.z;
      if (i > pv) {
        const w = (i - pv) / (n - 1 - pv);
        const oy = rest.y - pvn.y;
        const oz = rest.z - pvn.z;
        const pc = Math.cos(hPit * w);
        const ps = Math.sin(hPit * w);
        const y1 = oy * pc + oz * ps;
        const z1 = -oy * ps + oz * pc;
        const yc = Math.cos(hYaw * w);
        const ys = Math.sin(hYaw * w);
        x += z1 * ys;
        y = pvn.y + y1;
        z = pvn.z + z1 * yc + lunge * w * len;
      }
      const torso = Math.sin(Math.PI * s);
      const nd = this.nodes[i];
      nd.x = x;
      nd.y = y;
      nd.z = z;
      nd.r = rest.r * (1 + breath * 0.02 * torso) * (1 + (puff - 1) * torso);
    }

    // stance transform -> root space
    _e.set(-(this.curPitch + pitchAdd), yawAdd, rollAdd, 'YZX');
    _q.setFromEuler(_e);
    _v.set(0, this.curY + yAdd * len + this.bob, 0);
    this.M.compose(_v, _q, _one);
    this.xr.set(1, 0, 0).applyQuaternion(_q);
    for (let i = 0; i < n; i++) {
      const nd = this.nodes[i];
      const e = this.ex[i + 1];
      _v.set(nd.x, nd.y, nd.z).applyMatrix4(this.M);
      e.x = _v.x;
      e.y = _v.y;
      e.z = _v.z;
      e.r = nd.r;
    }
    this._phantoms();

    // body rings
    const P = this.posAttr.array;
    const N = this.norAttr.array;
    const rings = this.ringU;
    let o = 0;
    for (let j = 0; j < rings.length; j++) {
      this._frame(rings[j]);
      const { cx, cy, cz, tx, ty, tz, nx, ny, nz, bx, by, bz, R, nr, nt } = F;
      for (let k = 0; k < ROW; k++) {
        const ca = COS[k];
        const sa = SIN[k];
        const rx = ca * nx + sa * bx;
        const ry = ca * ny + sa * by;
        const rz = ca * nz + sa * bz;
        P[o] = cx + rx * R;
        P[o + 1] = cy + ry * R;
        P[o + 2] = cz + rz * R;
        N[o] = nr * rx + nt * tx;
        N[o + 1] = nr * ry + nt * ty;
        N[o + 2] = nr * rz + nt * tz;
        o += 3;
      }
    }

    // limbs
    const free = this.free || this.dead || lie > 0.6;
    const moving = spd > 0.15;
    let liftSum = 0;
    for (const L of this.limbs) {
      const s = L.g.s || 1;
      const def = L.def;
      const l1 = def.upper * s;
      const l2 = def.lower * s;
      this.surface(L.g.u, (L.side < 0 ? -L.g.a : L.g.a));
      H.copy(SP).addScaledVector(SN, -Math.min(F.R * 0.35, 0.08));
      let px;
      let py;
      let pz;
      if (L.isLeg) {
        const ankle = def.ankle * s;
        if (free) {
          const pad = Math.sin(this.time * 7 + L.phase) * this.paddle;
          FT.set(H.x + L.side * 0.1 * L.L, H.y - L.L * (lie > 0.6 ? 0.45 : 0.74), H.z + L.L * (0.08 + pad * 0.3));
          this._toWorld(FT, L.foot);
          L.t = -1;
        } else {
          if (this.treadmill) {
            L.foot.x -= this.vel.x * dt;
            L.foot.z -= this.vel.z * dt;
            L.from.x -= this.vel.x * dt;
            L.from.z -= this.vel.z * dt;
          }
          const lead = moving ? L.stepLen * 0.62 : 0;
          _v.set(L.home.x + (moving ? (lvx / spd) * lead : 0), 0, L.home.z + (moving ? (lvz / spd) * lead : 0));
          this._toWorld(_v, _v2); // landing target (world)
          _v2.y = this.ground(_v2.x, _v2.z);
          this._toLocal(L.foot, FT);
          const dist = Math.hypot(FT.x - L.home.x, FT.z - L.home.z);
          if (L.t < 0) {
            if (dist > L.stepLen * 2.6) L.foot.copy(_v2);
            else if (dist > L.stepLen * (moving ? 0.7 : 0.22) && (this._groupFree(L) || dist > L.stepLen * 1.5)) {
              L.t = 0;
              L.from.copy(L.foot);
              L.dur = clamp((L.stepLen * 1.15) / (spd + 0.8), 0.09, 0.3);
            } else L.foot.y = this.ground(L.foot.x, L.foot.z);
          }
          if (L.t >= 0) {
            L.t += dt / L.dur;
            const k = Math.min(L.t, 1);
            const e = k * k * (3 - 2 * k);
            const lift = Math.sin(Math.PI * k);
            L.foot.lerpVectors(L.from, _v2, e);
            L.foot.y += lift * L.lift * sc;
            liftSum += lift;
            if (L.t >= 1) {
              L.t = -1;
              L.foot.copy(_v2);
              if (this.onStep) this.onStep(L);
            }
          }
          this._toLocal(L.foot, FT);
        }
        FT.y += ankle;
        px = L.side * def.pole[0];
        py = def.pole[1];
        pz = def.pole[2];
      } else {
        const len2 = l1 + l2;
        const swing = Math.sin(this.walkPhase + (L.side > 0 ? 0 : Math.PI)) * 0.2 * len2 * Math.min(gait, 1);
        FT.set(H.x + L.side * 0.1 * len2, H.y - 0.62 * len2, H.z + 0.4 * len2 + swing);
        if (reach > 0) {
          const k = reach * (L.side > 0 ? 1 : 0.8);
          FT.x += (H.x + L.side * 0.02 - FT.x) * k;
          FT.y += (H.y + 0.08 * len2 - FT.y) * k;
          FT.z += (H.z + 0.95 * len2 - FT.z) * k;
        }
        if (flare > 0) {
          FT.x += (H.x + L.side * 0.82 * len2 - FT.x) * flare;
          FT.y += (H.y + 0.45 * len2 - FT.y) * flare;
          FT.z += (H.z + 0.1 * len2 - FT.z) * flare;
        }
        if (lie > 0.3) FT.y = Math.max(FT.y, 0.05);
        px = L.side * 0.5;
        py = -0.4;
        pz = -1;
      }
      solveIK(H, FT, l1, l2, px, py, pz);
      const r = def.r;
      this._fillLimb(L.vbase, H, K, FT, r[0] * s, r[1] * s, r[2] * s);
      const end = L.end;
      if (L.isLeg) {
        end.position.set(FT.x, FT.y - def.ankle * s, FT.z);
        end.rotation.set(0, L.side * 0.22, 0);
      } else {
        end.position.copy(FT);
        _v.subVectors(FT, K).normalize();
        end.quaternion.setFromUnitVectors(_up, _v);
      }
      end.scale.setScalar(s);
    }
    this.bob = damp(this.bob, this.limbs.length ? (-liftSum / this.limbs.length) * 0.05 * len : 0, 14, dt);

    this.posAttr.needsUpdate = true;
    this.norAttr.needsUpdate = true;

    // surface parts
    this.blinkT -= dt;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    const blink = lie > 0.5 ? 1 : this.blinkT < 0.14 ? Math.sin((this.blinkT / 0.14) * Math.PI) : 0;
    const jawOpen = jaw;
    for (const S of this.surf) {
      const s = S.g.s || 1;
      this.surface(S.g.u, (S.side < 0 ? -S.g.a : S.g.a));
      const obj = S.obj;
      const ud = obj.userData;
      _z.copy(SF).addScaledVector(SN, -SF.dot(SN));
      if (_z.lengthSq() < 1e-8) _z.set(0, 1, 0);
      _z.normalize();
      _x.crossVectors(SN, _z);
      _m.makeBasis(_x, SN, _z);
      obj.quaternion.setFromRotationMatrix(_m);
      obj.position.copy(SP).addScaledVector(SN, -0.012 * s);
      obj.scale.setScalar(ud.flare ? s * (1 + flare * 0.45) : s);
      if (ud.jaw) {
        if (ud.pulse) ud.jaw.scale.setScalar(1 + jawOpen * 0.3);
        else ud.jaw.rotation.x = -jawOpen * 0.8;
      }
      if (ud.halo) ud.halo.scale.setScalar(ud.haloSize * (1 + glow * 1.6));
      if (ud.eye) {
        // gaze direction in part space
        let gx;
        let gy;
        let gz;
        if (lookLocal) {
          _v.copy(lookLocal).sub(SP).normalize();
          gx = _v.dot(_x);
          gy = _v.dot(SN);
          gz = _v.dot(_z);
        } else {
          gx = 0;
          gy = 1;
          gz = 0.35;
        }
        if (gy < 0.45) gy = 0.45;
        const gl = Math.hypot(gx, gy, gz);
        _v.set(gx / gl, gy / gl, gz / gl);
        ud.eye.pupil.position.copy(_v).multiplyScalar(ud.eye.r * 0.6);
        ud.eye.pupil.quaternion.setFromUnitVectors(_up, _v);
        ud.eye.ball.scale.set(1 - 0.9 * blink, 1, 1);
      }
    }

    // glow / hurt tint
    const em = this.mat.emissive;
    em.copy(this.kit.colors.glow).multiplyScalar(glow * 0.75);
    if (this.flash > 0) {
      em.r += this.flash * 0.9;
      em.g += this.flash * 0.1;
      em.b += this.flash * 0.08;
    }

    if (this.blob) {
      const p = root.position;
      const gy = this.ground(p.x, p.z);
      const size = (this.halfLen * 1.5 + this.radius) * 1.35;
      this.blob.position.set(0, (gy - p.y) / sc + 0.035, 0);
      this.blob.scale.set(size * 0.8, 1, size);
    }
  }

  _groupFree(L) {
    for (const M of this.limbs) if (M.isLeg && M.group !== L.group && M.t >= 0 && M.t < 0.72) return false;
    return true;
  }

  // Skin a bent tube from hip (H) through knee (Kn) to ankle (A).
  _fillLimb(base, Hp, Kn, Ap, r0, r1, r2) {
    const P = this.posAttr.array;
    const N = this.norAttr.array;
    let d1x = Kn.x - Hp.x;
    let d1y = Kn.y - Hp.y;
    let d1z = Kn.z - Hp.z;
    const l1 = Math.hypot(d1x, d1y, d1z) || 1e-6;
    d1x /= l1;
    d1y /= l1;
    d1z /= l1;
    let d2x = Ap.x - Kn.x;
    let d2y = Ap.y - Kn.y;
    let d2z = Ap.z - Kn.z;
    const l2 = Math.hypot(d2x, d2y, d2z) || 1e-6;
    d2x /= l2;
    d2y /= l2;
    d2z /= l2;
    let mx = d1x + d2x;
    let my = d1y + d2y;
    let mz = d1z + d2z;
    const ml = Math.hypot(mx, my, mz) || 1e-6;
    mx /= ml;
    my /= ml;
    mz /= ml;
    let o = base * 3;
    for (let j = 0; j < LRING; j++) {
      let cx;
      let cy;
      let cz;
      let tx;
      let ty;
      let tz;
      let r;
      switch (j) {
        case 0: cx = Hp.x; cy = Hp.y; cz = Hp.z; tx = d1x; ty = d1y; tz = d1z; r = r0 * 1.12; break;
        case 1: cx = (Hp.x + Kn.x) / 2; cy = (Hp.y + Kn.y) / 2; cz = (Hp.z + Kn.z) / 2; tx = d1x; ty = d1y; tz = d1z; r = (r0 + r1) * 0.52; break;
        case 2: cx = Kn.x; cy = Kn.y; cz = Kn.z; tx = mx; ty = my; tz = mz; r = r1 * 1.08; break;
        case 3: cx = (Kn.x + Ap.x) / 2; cy = (Kn.y + Ap.y) / 2; cz = (Kn.z + Ap.z) / 2; tx = d2x; ty = d2y; tz = d2z; r = (r1 + r2) * 0.5; break;
        case 4: cx = Ap.x; cy = Ap.y; cz = Ap.z; tx = d2x; ty = d2y; tz = d2z; r = r2; break;
        default: cx = Ap.x + d2x * r2 * 0.6; cy = Ap.y + d2y * r2 * 0.6; cz = Ap.z + d2z * r2 * 0.6; tx = d2x; ty = d2y; tz = d2z; r = r2 * 0.45; break;
      }
      // frame: reference forward unless the limb points that way
      let rx = 0;
      let ry = 0;
      let rz = 1;
      if (Math.abs(tz) > 0.92) {
        rx = 1;
        rz = 0;
      }
      const dt = rx * tx + ry * ty + rz * tz;
      let nx = rx - dt * tx;
      let ny = ry - dt * ty;
      let nz = rz - dt * tz;
      const nl = Math.hypot(nx, ny, nz) || 1e-6;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const bx = ny * tz - nz * ty;
      const by = nz * tx - nx * tz;
      const bz = nx * ty - ny * tx;
      for (let k = 0; k < LROW; k++) {
        const ca = LCOS[k];
        const sa = LSIN[k];
        const qx = ca * nx + sa * bx;
        const qy = ca * ny + sa * by;
        const qz = ca * nz + sa * bz;
        P[o] = cx + qx * r;
        P[o + 1] = cy + qy * r;
        P[o + 2] = cz + qz * r;
        N[o] = qx;
        N[o + 1] = qy;
        N[o + 2] = qz;
        o += 3;
      }
    }
  }
}

// Two-bone IK. Clamps the target (FT) into reach and writes the joint to K.
function solveIK(Hp, Tg, l1, l2, px, py, pz) {
  let dx = Tg.x - Hp.x;
  let dy = Tg.y - Hp.y;
  let dz = Tg.z - Hp.z;
  let d = Math.hypot(dx, dy, dz) || 1e-6;
  dx /= d;
  dy /= d;
  dz /= d;
  const maxD = (l1 + l2) * 0.985;
  const minD = Math.abs(l1 - l2) + 0.02;
  if (d > maxD || d < minD) {
    d = clamp(d, minD, maxD);
    Tg.set(Hp.x + dx * d, Hp.y + dy * d, Hp.z + dz * d);
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const pd = px * dx + py * dy + pz * dz;
  let qx = px - pd * dx;
  let qy = py - pd * dy;
  let qz = pz - pd * dz;
  let ql = Math.hypot(qx, qy, qz);
  if (ql < 1e-4) {
    qx = 0;
    qy = 0;
    qz = 1;
    ql = 1;
  }
  K.set(Hp.x + dx * a + (qx / ql) * h, Hp.y + dy * a + (qy / ql) * h, Hp.z + dz * a + (qz / ql) * h);
}
