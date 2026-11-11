// The island: terrain from seeded noise, biomes, instanced flora, a sky that
// turns through day and night, water, and the places things live.

import * as THREE from './three.js';
import { Noise, makeRng, clamp, lerp, smoothstep } from './util.js';
import { mergeGeo, bladeGeo } from './geo.js';
import { haloTexture } from './skin.js';

export const SIZE = 400;
const HALF = SIZE / 2;
const CELL = 2;
const N = SIZE / CELL + 1;
const LAND_R = 172;
export const SEA = 0;
const DAY_FRAC = 0.7; // share of the clock that is daytime

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

const C = (hex) => new THREE.Color(hex);
const PAL = {
  deep: C('#4f7477'), shallow: C('#a9b48a'), wet: C('#cdbd8c'), sand: C('#e6d8a8'),
  meadow: C('#9dc566'), lush: C('#6ea757'), heath: C('#c3b56e'), rock: C('#9a988a'),
};
const SKY = {
  nightTop: C('#070b1e'), dayTop: C('#3f8ed4'), duskTop: C('#4b4a86'),
  nightHor: C('#16203c'), dayHor: C('#cfe7f2'), duskHor: C('#ffad77'),
  sunWarm: C('#ffc890'), sunDay: C('#fff3dc'), moon: C('#9fb6ea'),
  hemiNight: C('#3b4c80'), hemiDay: C('#e2f1ff'), gndNight: C('#222a3c'), gndDay: C('#7d8b5c'),
  waterDay: C('#4b97aa'), waterNight: C('#12283c'),
};

export class World {
  constructor(seed, quality = 'high', speciesCount = 7) {
    this.seed = seed;
    this.quality = quality;
    this.group = new THREE.Group();
    this.noise = new Noise(seed);
    this.noiseM = new Noise(seed + 77);
    this.rnd = makeRng(seed + 5);
    this.colliders = new Map();
    this.bushes = [];
    this.bones = [];
    this.night = 0;
    this.uTime = { value: 0 };
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
    this.moonDir = new THREE.Vector3(-0.4, 0.8, -0.3);
    this.disposables = [];

    this._heights();
    this._spots(speciesCount);
    this._terrain();
    this._flora();
    this._sky();
  }

  /* -------------------------------- terrain ------------------------------ */

  _raw(x, z) {
    const n = this.noise;
    const d = Math.hypot(x, z) / LAND_R + n.n2(x * 0.011 + 31, z * 0.011) * 0.09;
    const base = n.fbm(x * 0.0082, z * 0.0082, 4);
    const detail = n.fbm(x * 0.045 + 40, z * 0.045 + 11, 2) * 0.55;
    const ridge = Math.pow(Math.max(0, this.noiseM.fbm(x * 0.0062 + 9, z * 0.0062 + 3, 3)), 1.4) * 22;
    const land = 2.7 + base * 8.5 + detail + ridge;
    const mask = smoothstep(1.02, 0.6, d);
    return lerp(-5.5, land, mask);
  }

  _heights() {
    const h = (this.h = new Float32Array(N * N));
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) h[iz * N + ix] = this._raw(-HALF + ix * CELL, -HALF + iz * CELL);
  }

  // Exact height of the rendered triangles.
  heightAt(x, z) {
    const fx = clamp((x + HALF) / CELL, 0, N - 1.001);
    const fz = clamp((z + HALF) / CELL, 0, N - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.h;
    const i = iz * N + ix;
    const h00 = h[i];
    const h10 = h[i + 1];
    const h01 = h[i + N];
    const h11 = h[i + N + 1];
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  moisture(x, z) {
    return this.noiseM.fbm(x * 0.006 + 100, z * 0.006 + 50, 3);
  }

  biomeAt(x, z) {
    const h = this.heightAt(x, z);
    if (h < 0.15) return 'sea';
    if (h < 1.25) return 'shore';
    if (h > 10.5) return 'high';
    const m = this.moisture(x, z);
    if (m > 0.1) return 'forest';
    if (m < -0.16) return 'heath';
    return 'meadow';
  }

  _groundColor(x, z, h, out) {
    if (h < -0.2) return out.copy(PAL.shallow).lerp(PAL.deep, clamp(-h / 3.5, 0, 1));
    if (h < 0.45) return out.copy(PAL.wet);
    const m = this.moisture(x, z);
    out.copy(PAL.heath).lerp(PAL.meadow, smoothstep(-0.26, -0.06, m)).lerp(PAL.lush, smoothstep(0.04, 0.22, m));
    out.lerp(PAL.rock, smoothstep(9.5, 14, h));
    return out.lerp(PAL.sand, 1 - smoothstep(0.7, 1.7, h));
  }

  _terrain() {
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const rnd = makeRng(this.seed + 9);
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = -HALF + ix * CELL;
        const z = -HALF + iz * CELL;
        const h = this.h[i];
        pos[i * 3] = x;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z;
        this._groundColor(x, z, h, _c);
        const j = 0.94 + rnd() * 0.12;
        col[i * 3] = _c.r * j;
        col[i * 3 + 1] = _c.g * j;
        col[i * 3 + 2] = _c.b * j;
      }
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let o = 0;
    for (let iz = 0; iz < N - 1; iz++) {
      for (let ix = 0; ix < N - 1; ix++) {
        const a = iz * N + ix;
        idx[o++] = a;
        idx[o++] = a + N;
        idx[o++] = a + 1;
        idx[o++] = a + 1;
        idx[o++] = a + N;
        idx[o++] = a + N + 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.terrain = mesh;

    const wmat = new THREE.MeshLambertMaterial({ color: SKY.waterDay.clone(), transparent: true, opacity: 0.8 });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), wmat);
    water.position.y = SEA;
    this.group.add(water);
    this.water = water;
  }

  /* --------------------------------- spots ------------------------------- */

  _flat(x, z) {
    const h = this.heightAt(x, z);
    const s = Math.max(Math.abs(this.heightAt(x + 4, z) - h), Math.abs(this.heightAt(x, z + 4) - h), Math.abs(this.heightAt(x - 4, z) - h), Math.abs(this.heightAt(x, z - 4) - h));
    return s;
  }

  // Choose a home nest near the water and spread the other species' nests.
  _spots(count) {
    const rnd = makeRng(this.seed + 21);
    const cands = [];
    for (let i = 0; i < 2600; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 150;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = this.heightAt(x, z);
      if (h < 1.7 || h > 9 || this._flat(x, z) > 1.1) continue;
      cands.push({ x, z, h, r });
    }
    let home = null;
    for (const c of cands) if (c.r > 70 && c.r < 125 && c.h < 3.6 && (!home || c.h < home.h)) home = c;
    if (!home) home = cands[0] || { x: 0, z: 0, h: this.heightAt(0, 0) };
    this.home = { x: home.x, z: home.z };
    const chosen = [home];
    const spots = [];
    for (let k = 0; k < count; k++) {
      let best = null;
      let bestD = -1;
      for (const c of cands) {
        let d = Infinity;
        for (const s of chosen) d = Math.min(d, Math.hypot(c.x - s.x, c.z - s.z));
        // the first neighbours should be close enough to meet early
        const score = k < 2 ? -Math.abs(d - 52) : Math.min(d, 95);
        if (d > 44 && (best === null || score > bestD)) {
          best = c;
          bestD = score;
        }
      }
      if (!best) break;
      chosen.push(best);
      spots.push({ x: best.x, z: best.z });
    }
    this.spots = spots;
    // old bones to dig up
    this.bones = [];
    for (let tries = 0; tries < 400 && this.bones.length < 8; tries++) {
      const c = cands[Math.floor(rnd() * cands.length)];
      if (!c) break;
      let ok = true;
      for (const s of chosen) if (Math.hypot(c.x - s.x, c.z - s.z) < 26) ok = false;
      for (const b of this.bones) if (Math.hypot(c.x - b.x, c.z - b.z) < 40) ok = false;
      if (ok) this.bones.push({ id: this.bones.length, x: c.x, z: c.z, found: false });
    }
    this.clear = chosen.map((c) => ({ x: c.x, z: c.z, r: 8 })).concat(this.bones.map((b) => ({ x: b.x, z: b.z, r: 3 })));
  }

  _isClear(x, z) {
    for (const c of this.clear) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < c.r * c.r) return false;
    return true;
  }

  /* --------------------------------- flora ------------------------------- */

  _addCollider(x, z, r) {
    const k = Math.floor(x / 8) + ',' + Math.floor(z / 8);
    let list = this.colliders.get(k);
    if (!list) this.colliders.set(k, (list = []));
    list.push({ x, z, r });
  }

  // Push a circle out of trees and rocks. Mutates pos, returns true if moved.
  collide(pos, radius) {
    const cx = Math.floor(pos.x / 8);
    const cz = Math.floor(pos.z / 8);
    let hit = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.colliders.get(cx + dx + ',' + (cz + dz));
        if (!list) continue;
        for (const c of list) {
          const ox = pos.x - c.x;
          const oz = pos.z - c.z;
          const min = c.r + radius;
          const d2 = ox * ox + oz * oz;
          if (d2 < min * min && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            pos.x = c.x + (ox / d) * min;
            pos.z = c.z + (oz / d) * min;
            hit = true;
          }
        }
      }
    }
    return hit;
  }

  _instanced(geo, mat, items, opts = {}) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => {
      _e.set(it.rx || 0, it.ry || 0, it.rz || 0);
      const s = it.s || 1;
      _m.compose(_p.set(it.x, it.y, it.z), _q.setFromEuler(_e), typeof s === 'number' ? _s.set(s, s * (it.sy || 1), s) : _s.set(s[0], s[1], s[2]));
      mesh.setMatrixAt(i, _m);
      if (it.c) mesh.setColorAt(i, it.c);
    });
    mesh.castShadow = !!opts.cast;
    mesh.receiveShadow = !!opts.receive;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  _sway(mat, amount) {
    const uTime = this.uTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.35 + instanceMatrix[3][2] * 0.27;
          float bend = position.y * ${amount.toFixed(3)};
          transformed.x += sin(uTime * 1.6 + ph) * bend;
          transformed.z += cos(uTime * 1.25 + ph * 1.3) * bend * 0.7;
        #endif`,
      );
    };
    return mat;
  }

  _flora() {
    const rnd = makeRng(this.seed + 33);
    const q = this.quality;
    const flat = (o) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...o });
    const ico = (r, d = 1) => new THREE.IcosahedronGeometry(r, d);
    const cyl = (rt, rb, h, s = 6) => new THREE.CylinderGeometry(rt, rb, h, s).translate(0, h / 2, 0);
    const cone = (r, h, s = 7) => new THREE.ConeGeometry(r, h, s).translate(0, h / 2, 0);

    const puffGeo = mergeGeo([
      { geo: cyl(0.16, 0.27, 2.3), color: '#7a5a3e' },
      { geo: ico(1.3), color: '#5fa052', p: [0, 3.1, 0] },
      { geo: ico(0.98), color: '#6cb15c', p: [0.85, 2.5, 0.3] },
      { geo: ico(0.88), color: '#54994c', p: [-0.75, 2.65, -0.4] },
    ]);
    const parasolGeo = mergeGeo([
      { geo: cyl(0.09, 0.17, 4.2, 5), color: '#d3c4a3' },
      { geo: cone(2.05, 0.75, 9), color: '#e07a5f', p: [0, 4.05, 0] },
      { geo: cyl(1.95, 1.2, 0.18, 9), color: '#f0d9b5', p: [0, 3.9, 0] },
      { geo: cone(0.8, 0.32, 7), color: '#e8936f', p: [0.22, 2.5, 0.1] },
    ]);
    const reedPieces = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.283;
      const h = 1.5 + ((i * 37) % 10) * 0.14;
      reedPieces.push({ geo: cone(0.08, h, 5), color: '#5f9c86', p: [Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3], r: [Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12] });
      reedPieces.push({ geo: ico(0.1, 0), color: '#f2d16b', p: [Math.cos(a) * (0.3 + 0.12 * h), h, Math.sin(a) * (0.3 + 0.12 * h)] });
    }
    const reedGeo = mergeGeo(reedPieces);
    const bulbGeo = mergeGeo([
      { geo: cyl(0.04, 0.07, 0.75, 5), color: '#6f7d62' },
      { geo: ico(0.24), color: '#bba6ea', p: [0, 0.92, 0] },
      { geo: ico(0.13), color: '#cdbcf2', p: [0.2, 0.55, 0.05] },
    ]);
    const rockGeo = mergeGeo([{ geo: new THREE.DodecahedronGeometry(0.7), color: '#9d998c' }]);
    const bushGeo = mergeGeo([
      { geo: ico(0.72), color: '#4f8f4a', p: [0, 0.42, 0], s: [1, 0.7, 1] },
      { geo: ico(0.5), color: '#5b9c52', p: [0.5, 0.33, 0.2], s: [1, 0.7, 1] },
      { geo: ico(0.46), color: '#478544', p: [-0.42, 0.3, -0.3], s: [1, 0.7, 1] },
    ]);

    const trees = { puff: [], parasol: [], reed: [], bulb: [], rock: [] };
    const tint = (v) => new THREE.Color().setScalar(v);
    const tries = q === 'low' ? 2200 : 3800;
    for (let i = 0; i < tries; i++) {
      const x = rnd.range(-185, 185);
      const z = rnd.range(-185, 185);
      const h = this.heightAt(x, z);
      if (h < 0.5 || !this._isClear(x, z)) continue;
      const b = this.biomeAt(x, z);
      const roll = rnd();
      const ry = rnd() * 6.283;
      const lean = () => rnd.range(-0.07, 0.07);
      if (b === 'forest' && roll < 0.62) {
        const s = rnd.range(0.8, 1.7);
        trees.puff.push({ x, y: h - 0.1, z, ry, rx: lean(), rz: lean(), s, c: tint(rnd.range(0.82, 1.08)) });
        this._addCollider(x, z, 0.3 * s);
      } else if (b === 'meadow' && roll < 0.07) {
        const s = rnd.range(0.75, 1.5);
        trees.parasol.push({ x, y: h - 0.1, z, ry, rx: lean(), rz: lean(), s, c: tint(rnd.range(0.88, 1.06)) });
        this._addCollider(x, z, 0.24 * s);
      } else if (b === 'meadow' && roll < 0.1) {
        const s = rnd.range(0.7, 1.2);
        trees.puff.push({ x, y: h - 0.1, z, ry, s, c: tint(rnd.range(0.9, 1.1)) });
        this._addCollider(x, z, 0.3 * s);
      } else if (b === 'shore' && h > 0.6 && roll < 0.3) {
        trees.reed.push({ x, y: h - 0.05, z, ry, s: rnd.range(0.8, 1.5) });
      } else if (b === 'heath' && roll < 0.2) {
        trees.bulb.push({ x, y: h - 0.03, z, ry, s: rnd.range(0.8, 1.8) });
      } else if ((b === 'heath' || b === 'high') && roll < 0.36) {
        const s = rnd.range(0.6, 2.4);
        trees.rock.push({ x, y: h - 0.15 * s, z, ry, rx: rnd() * 3, s: [s * rnd.range(0.8, 1.3), s * rnd.range(0.55, 0.95), s * rnd.range(0.8, 1.3)], c: tint(rnd.range(0.85, 1.1)) });
        this._addCollider(x, z, 0.6 * s);
      } else if (roll > 0.985) {
        const s = rnd.range(0.5, 1.3);
        trees.rock.push({ x, y: h - 0.15 * s, z, ry, rx: rnd() * 3, s: [s, s * 0.7, s * 1.1], c: tint(rnd.range(0.85, 1.1)) });
        this._addCollider(x, z, 0.6 * s);
      }
    }
    this._instanced(puffGeo, flat(), trees.puff, { cast: true });
    this._instanced(parasolGeo, flat(), trees.parasol, { cast: true });
    this._instanced(reedGeo, this._sway(flat(), 0.05), trees.reed);
    this.bulbMat = flat({ emissive: new THREE.Color('#7b5cff'), emissiveIntensity: 0 });
    this._instanced(bulbGeo, this.bulbMat, trees.bulb);
    this._instanced(rockGeo, flat(), trees.rock, { cast: true, receive: true });

    // berry bushes: a few are guaranteed near home so nobody starves at once
    const bushItems = [];
    const addBush = (x, z) => {
      const h = this.heightAt(x, z);
      if (h < 1.1 || !this._isClear(x, z)) return false;
      const s = rnd.range(0.9, 1.3);
      bushItems.push({ x, y: h - 0.05, z, ry: rnd() * 6.283, s });
      this.bushes.push({ x, z, y: h, s, berries: 4, regrow: 0, first: 0 });
      this._addCollider(x, z, 0.45 * s);
      return true;
    };
    for (let i = 0, made = 0; i < 60 && made < 4; i++) {
      const a = rnd() * 6.283;
      const r = rnd.range(11, 26);
      if (addBush(this.home.x + Math.cos(a) * r, this.home.z + Math.sin(a) * r)) made++;
    }
    for (let i = 0; i < 900 && this.bushes.length < 78; i++) {
      const x = rnd.range(-170, 170);
      const z = rnd.range(-170, 170);
      const b = this.biomeAt(x, z);
      if (b !== 'meadow' && b !== 'forest') continue;
      let near = false;
      for (const o of this.bushes) if (Math.hypot(o.x - x, o.z - z) < 9) near = true;
      if (!near) addBush(x, z);
    }
    this._instanced(bushGeo, flat(), bushItems, { cast: true });
    const berryGeo = new THREE.SphereGeometry(0.12, 8, 6);
    this.berryMesh = new THREE.InstancedMesh(berryGeo, new THREE.MeshLambertMaterial({ color: '#e8503a', emissive: '#5a1206', emissiveIntensity: 0.5 }), this.bushes.length * 4);
    this.bushes.forEach((b, i) => {
      b.first = i * 4;
      for (let k = 0; k < 4; k++) this._placeBerry(b, k, true);
    });
    this.berryMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.berryMesh);

    // grass and flowers
    const grassN = q === 'high' ? 22000 : q === 'medium' ? 11000 : 4500;
    const tuft = mergeGeo([
      { geo: bladeGeo(0.07, 0.3, 0.05), color: '#ffffff', up: true },
      { geo: bladeGeo(0.07, 0.25, -0.04), color: '#f6f6f6', r: [0, 1.05, 0], up: true },
      { geo: bladeGeo(0.06, 0.2, 0.03), color: '#efefef', r: [0, 2.1, 0], up: true },
      { geo: bladeGeo(0.06, 0.22, 0.03), color: '#f8f8f8', r: [0, 0.5, 0], p: [0.12, 0, 0.07], up: true },
      { geo: bladeGeo(0.06, 0.18, -0.03), color: '#f0f0f0', r: [0, 1.9, 0], p: [-0.1, 0, -0.08], up: true },
    ]);
    const grass = [];
    for (let i = 0; i < grassN * 2 && grass.length < grassN; i++) {
      const x = rnd.range(-180, 180);
      const z = rnd.range(-180, 180);
      const h = this.heightAt(x, z);
      if (h < 1.25 || h > 12) continue;
      this._groundColor(x, z, h, _c);
      _c.multiplyScalar(rnd.range(0.9, 1.12));
      grass.push({ x, y: h - 0.02, z, ry: rnd() * 6.283, s: rnd.range(0.8, 1.7), c: _c.clone() });
    }
    const gmat = this._sway(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.3);
    const gm = this._instanced(tuft, gmat, grass, { receive: true });
    if (gm) gm.frustumCulled = false;

    const flowerGeo = mergeGeo([
      { geo: bladeGeo(0.03, 0.34), color: '#6f9a52', up: true },
      { geo: new THREE.OctahedronGeometry(0.075), color: '#ffffff', p: [0, 0.36, 0], s: [1, 0.55, 1], up: true },
    ]);
    const hues = ['#fff3c4', '#f6c9d8', '#ffd76e', '#d5c2f5', '#ffffff', '#f4a48a'];
    const flowers = [];
    const flowerN = q === 'low' ? 500 : 1600;
    for (let i = 0; i < flowerN * 3 && flowers.length < flowerN; i++) {
      const x = rnd.range(-175, 175);
      const z = rnd.range(-175, 175);
      const h = this.heightAt(x, z);
      if (h < 1.4 || h > 10) continue;
      if (this.noise.n2(x * 0.05 + 7, z * 0.05) < 0.12) continue; // drifts and patches
      flowers.push({ x, y: h - 0.02, z, ry: rnd() * 6.283, s: rnd.range(0.8, 1.5), c: new THREE.Color(hues[Math.floor(rnd() * hues.length)]) });
    }
    const fm = this._instanced(flowerGeo, this._sway(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.25), flowers);
    if (fm) fm.frustumCulled = false;

    // old bones
    const boneGeo = mergeGeo([
      { geo: new THREE.TorusGeometry(0.5, 0.05, 5, 10, Math.PI), color: '#efe6d0', p: [0, 0, -0.35] },
      { geo: new THREE.TorusGeometry(0.58, 0.055, 5, 10, Math.PI), color: '#efe6d0', p: [0, 0, 0] },
      { geo: new THREE.TorusGeometry(0.5, 0.05, 5, 10, Math.PI), color: '#efe6d0', p: [0, 0, 0.35] },
      { geo: cyl(0.06, 0.06, 1.3, 5), color: '#e6dcc2', p: [0, 0.04, -0.65], r: [Math.PI / 2, 0, 0] },
      { geo: ico(0.2, 0), color: '#efe6d0', p: [0, 0.14, 0.82], s: [1, 0.8, 1.2] },
    ]);
    this.boneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.boneGroup = new THREE.Group();
    for (const b of this.bones) {
      const m = new THREE.Mesh(boneGeo, this.boneMat);
      const h = this.heightAt(b.x, b.z);
      m.position.set(b.x, h - 0.04, b.z);
      m.rotation.y = rnd() * 6.283;
      m.castShadow = true;
      const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color: '#fff3c0', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      glint.position.set(0, 1.5, 0);
      glint.scale.setScalar(0.7);
      m.add(glint);
      b.mesh = m;
      b.glint = glint;
      b.y = h;
      this.boneGroup.add(m);
    }
    this.group.add(this.boneGroup);
  }

  _placeBerry(b, k, on) {
    const a = k * 1.7 + b.x;
    const r = 0.5 * b.s;
    _s.setScalar(on ? b.s : 0.0001);
    _m.compose(_p.set(b.x + Math.cos(a) * r, b.y + 0.52 * b.s + (k % 2) * 0.12, b.z + Math.sin(a) * r), _q.identity(), _s);
    this.berryMesh.setMatrixAt(b.first + k, _m);
  }

  // Take one berry from a bush. Returns false if it is bare.
  eatBerry(b) {
    if (b.berries <= 0) return false;
    b.berries--;
    this._placeBerry(b, b.berries, false);
    this.berryMesh.instanceMatrix.needsUpdate = true;
    if (b.regrow <= 0) b.regrow = 34;
    return true;
  }

  // A nest: ring of stones around a bed, with a couple of eggs.
  addNest(x, z, color, home) {
    const y = this.heightAt(x, z);
    const pieces = [{ geo: new THREE.CylinderGeometry(2.3, 2.5, 0.16, 18).translate(0, 0.02, 0), color: home ? '#c9b684' : '#a8946a' }];
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * 6.283;
      const s = 0.3 + ((i * 53) % 7) * 0.04;
      pieces.push({ geo: new THREE.DodecahedronGeometry(s), color: '#9d998c', p: [Math.cos(a) * 2.45, 0.12, Math.sin(a) * 2.45], r: [i, i * 2, 0], s: [1, 0.75, 1] });
    }
    for (const [ex, ez] of [[0.35, 0.2], [-0.3, -0.25], [0.05, -0.55]]) pieces.push({ geo: new THREE.SphereGeometry(0.2, 10, 8), color, p: [ex, 0.24, ez], s: [0.82, 1.1, 0.82] });
    const mesh = new THREE.Mesh(mergeGeo(pieces), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.group.add(mesh);
    if (home) {
      // a soft column of light so home can be found from far away
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.75, 60, 12, 1, true).translate(0, 30, 0),
        new THREE.MeshBasicMaterial({ color: '#fff0c0', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }),
      );
      beam.position.set(x, y, z);
      this.group.add(beam);
      this.beam = beam;
    }
    return mesh;
  }

  /* ---------------------------------- sky -------------------------------- */

  _sky() {
    const g = this.group;
    this.hemi = new THREE.HemisphereLight('#e2f1ff', '#7d8b5c', 1.1);
    g.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight('#fff3dc', 2.4));
    const hi = this.quality === 'high';
    sun.castShadow = this.quality !== 'low';
    sun.shadow.mapSize.set(hi ? 2048 : 1024, hi ? 2048 : 1024);
    const R = hi ? 34 : 26;
    Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 180 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    g.add(sun, sun.target);

    this.skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, sunCol: { value: new THREE.Color() } };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 24, 14),
      new THREE.ShaderMaterial({
        uniforms: this.skyU,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir;
          void main(){
            vec3 d = normalize(vDir);
            float h = max(d.y, 0.0);
            vec3 col = mix(hor, top, pow(h, 0.5));
            float s = max(dot(d, sunDir), 0.0);
            col += sunCol * (pow(s, 420.0) * 2.2 + pow(s, 9.0) * 0.22);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    g.add(dome);
    this.dome = dome;

    const sp = new Float32Array(700 * 3);
    const rnd = makeRng(this.seed + 3);
    for (let i = 0; i < 700; i++) {
      const a = rnd() * 6.283;
      const e = Math.asin(rnd() * 0.96 + 0.03);
      sp[i * 3] = Math.cos(a) * Math.cos(e) * 800;
      sp[i * 3 + 1] = Math.sin(e) * 800;
      sp[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 800;
    }
    const sg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    g.add(this.stars);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color: '#e6eeff', transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.moon.scale.setScalar(120);
    g.add(this.moon);

    // clouds
    const cg = new THREE.IcosahedronGeometry(1, 1);
    const cm = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, transparent: true, opacity: 0.94 });
    const puffs = [];
    this.clouds = [];
    for (let i = 0; i < 16; i++) {
      const cx = rnd.range(-420, 420);
      const cz = rnd.range(-420, 420);
      const cy = rnd.range(70, 105);
      const n = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) puffs.push({ cx, x: rnd.range(-16, 16), y: cy + rnd.range(-2, 3), z: cz + rnd.range(-7, 7), s: [rnd.range(11, 20), rnd.range(4.5, 7), rnd.range(8, 13)] });
    }
    this.cloudMesh = new THREE.InstancedMesh(cg, cm, puffs.length);
    this.cloudMesh.frustumCulled = false;
    this.cloudPuffs = puffs;
    g.add(this.cloudMesh);

    // drifting motes by day, fireflies by night
    const mN = this.quality === 'low' ? 120 : 320;
    const mp = new Float32Array(mN * 3);
    this.moteSeed = new Float32Array(mN * 3);
    for (let i = 0; i < mN * 3; i++) this.moteSeed[i] = rnd();
    const mg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(mp, 3));
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({ map: haloTexture(), color: '#fffbe0', size: 0.2, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.motes.frustumCulled = false;
    g.add(this.motes);
  }

  // clock: 0..1 across a full day. Sets lights, sky, fog; returns night 0..1.
  setTime(clock, scene) {
    const t = clock % 1;
    const ang = t < DAY_FRAC ? (t / DAY_FRAC) * Math.PI : Math.PI + ((t - DAY_FRAC) / (1 - DAY_FRAC)) * Math.PI;
    const el = Math.sin(ang);
    this.sunDir.set(Math.cos(ang) * 0.86, el, 0.42).normalize();
    const day = smoothstep(-0.14, 0.2, el);
    const gold = (1 - smoothstep(0.0, 0.5, Math.abs(el))) * smoothstep(-0.3, 0.02, el);
    this.night = 1 - day;

    const U = this.skyU;
    U.top.value.copy(SKY.nightTop).lerp(SKY.dayTop, day).lerp(SKY.duskTop, gold * 0.55);
    U.hor.value.copy(SKY.nightHor).lerp(SKY.dayHor, day).lerp(SKY.duskHor, gold * 0.8);
    U.sunDir.value.copy(this.sunDir);
    U.sunCol.value.copy(SKY.sunWarm).lerp(SKY.sunDay, smoothstep(0.1, 0.5, el)).multiplyScalar(smoothstep(-0.08, 0.05, el));
    if (scene.fog) {
      scene.fog.color.copy(U.hor.value);
      scene.background = scene.fog.color;
    }
    const sunUp = el > -0.04;
    const sun = this.sun;
    if (sunUp) {
      sun.color.copy(SKY.sunWarm).lerp(SKY.sunDay, smoothstep(0.08, 0.5, el));
      sun.intensity = 2.5 * smoothstep(-0.04, 0.22, el);
      this.lightDir = this.sunDir;
    } else {
      sun.color.copy(SKY.moon);
      sun.intensity = 1.0 * smoothstep(0.04, 0.3, -el);
      this.lightDir = this.moonDir.copy(this.sunDir).multiplyScalar(-1);
      this.lightDir.y = Math.max(this.lightDir.y, 0.25);
      this.lightDir.normalize();
    }
    this.hemi.color.copy(SKY.hemiNight).lerp(SKY.hemiDay, day);
    this.hemi.groundColor.copy(SKY.gndNight).lerp(SKY.gndDay, day);
    this.hemi.intensity = lerp(0.95, 1.12, day);
    this.water.material.color.copy(SKY.waterNight).lerp(SKY.waterDay, day);
    this.stars.material.opacity = (1 - day) * 0.9;
    this.moon.material.opacity = (1 - day) * 0.9;
    this.moon.position.copy(this.sunDir).multiplyScalar(-700);
    this.bulbMat.emissiveIntensity = (1 - day) * 1.5;
    this.motes.material.color.set(day > 0.5 ? '#fffbe0' : '#d8ff7a');
    this.motes.material.opacity = lerp(0.95, 0.35, day);
    this.motes.material.size = lerp(0.36, 0.16, day);
    this.beamBase = lerp(0.34, 0.16, day);
    return this.night;
  }

  update(dt, focus, camPos) {
    this.uTime.value += dt;
    const t = this.uTime.value;
    // shadow frustum follows the player
    const sun = this.sun;
    sun.target.position.set(focus.x, focus.y, focus.z);
    sun.position.copy(sun.target.position).addScaledVector(this.lightDir || this.sunDir, 90);
    // the home beacon is for finding your way back, so it fades up close
    if (this.beam) this.beam.material.opacity = (this.beamBase || 0.2) * smoothstep(9, 34, Math.hypot(focus.x - this.home.x, focus.z - this.home.z));
    this.dome.position.copy(camPos);
    this.stars.position.copy(camPos);
    this.water.position.y = SEA + Math.sin(t * 0.6) * 0.04;

    for (let i = 0; i < this.cloudPuffs.length; i++) {
      const c = this.cloudPuffs[i];
      c.cx += dt * 1.4;
      if (c.cx > 460) c.cx -= 920;
      _m.compose(_p.set(c.cx + c.x, c.y, c.z), _q.identity(), _s.set(c.s[0], c.s[1], c.s[2]));
      this.cloudMesh.setMatrixAt(i, _m);
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;

    // motes wrap around the camera in a 36 m box
    const mp = this.motes.geometry.attributes.position;
    const sd = this.moteSeed;
    const B = 36;
    const nightly = this.night > 0.5;
    for (let i = 0; i < mp.count; i++) {
      const sx = sd[i * 3];
      const sy = sd[i * 3 + 1];
      const sz = sd[i * 3 + 2];
      let x = sx * B + t * (0.5 + sy * 0.4) + Math.sin(t * 0.7 + sz * 30) * 0.8;
      let z = sz * B + Math.cos(t * 0.5 + sx * 30) * 0.8;
      x = ((((x - camPos.x) % B) + B) % B) - B / 2 + camPos.x;
      z = ((((z - camPos.z) % B) + B) % B) - B / 2 + camPos.z;
      const gy = Math.max(this.heightAt(x, z), SEA);
      const blinkOff = nightly && Math.sin(t * (1.5 + sx * 2) + sy * 40) < 0.2;
      mp.setXYZ(i, x, blinkOff ? -50 : gy + 0.4 + sy * 3.2 + Math.sin(t * 0.9 + sx * 20) * 0.3, z);
    }
    mp.needsUpdate = true;

    // berries grow back
    let dirty = false;
    for (const b of this.bushes) {
      if (b.berries >= 4) continue;
      b.regrow -= dt;
      if (b.regrow <= 0) {
        this._placeBerry(b, b.berries, true);
        b.berries++;
        b.regrow = b.berries < 4 ? 34 : 0;
        dirty = true;
      }
    }
    if (dirty) this.berryMesh.instanceMatrix.needsUpdate = true;
    for (const b of this.bones) if (!b.found) b.glint.scale.setScalar(0.6 + Math.sin(t * 3 + b.id) * 0.2);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map && o.material.map !== haloTexture()) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}
