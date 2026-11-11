// The parts catalogue. Every part is modelled procedurally from primitives
// with colours baked into the vertices, so a species needs no assets at all.
//
// Part space: +Y points out of the skin, +Z runs along the surface toward the
// head (at the very tip of the face, +Y is "forward" and +Z is "up"), X is
// lateral. Every part is symmetric about its own YZ plane, so the same mesh
// works on both flanks.

import * as THREE from './three.js';
import { partMaterial, haloTexture } from './skin.js';

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

// Geometry builder that merges primitives and bakes a colour role per piece.
class Builder {
  constructor(colors) {
    this.colors = colors;
    this.P = [];
    this.N = [];
    this.C = [];
    this.I = [];
  }

  get empty() {
    return this.P.length === 0;
  }

  // opts: p [x,y,z], r [x,y,z] euler, s number | [x,y,z]
  add(geo, role, opts = {}) {
    const p = opts.p || [0, 0, 0];
    const r = opts.r || [0, 0, 0];
    const s = opts.s === undefined ? [1, 1, 1] : typeof opts.s === 'number' ? [opts.s, opts.s, opts.s] : opts.s;
    _m.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(s[0], s[1], s[2]));
    _n.getNormalMatrix(_m);
    const col = this.colors[role] || this.colors.base;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const base = this.P.length / 3;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      this.P.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
      this.N.push(_v.x, _v.y, _v.z);
      this.C.push(col.r, col.g, col.b);
    }
    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i++) this.I.push(base + idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.I.push(base + i);
    }
    geo.dispose();
    return this;
  }

  done() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setIndex(this.I);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------ primitives ------------------------------ */

const sph = (r = 1, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const cone = (r, h, seg = 7) => new THREE.ConeGeometry(r, h, seg).translate(0, h / 2, 0);
const cyl = (rTop, rBot, h, seg = 8) => new THREE.CylinderGeometry(rTop, rBot, h, seg).translate(0, h / 2, 0);
const torus = (r, t) => new THREE.TorusGeometry(r, t, 6, 12);

// Curved, tapered tube through a few control points (horns, stalks, claws).
function tube(points, radii, seg = 6, steps = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const P = [];
  const N = [];
  const I = [];
  const X = new THREE.Vector3(1, 0, 0);
  const T = new THREE.Vector3();
  const B = new THREE.Vector3();
  const Nn = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let j = 0; j <= steps; j++) {
    const t = j / steps;
    curve.getPoint(t, c);
    curve.getTangent(t, T);
    const f = t * (radii.length - 1);
    const i0 = Math.min(Math.floor(f), radii.length - 2);
    const rad = radii[i0] + (radii[i0 + 1] - radii[i0]) * (f - i0);
    B.copy(X).addScaledVector(T, -X.dot(T));
    if (B.lengthSq() < 1e-6) B.set(0, 0, 1);
    B.normalize();
    Nn.crossVectors(T, B);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = ca * Nn.x + sa * B.x;
      const ry = ca * Nn.y + sa * B.y;
      const rz = ca * Nn.z + sa * B.z;
      P.push(c.x + rx * rad, c.y + ry * rad, c.z + rz * rad);
      N.push(rx, ry, rz);
    }
  }
  const row = seg + 1;
  for (let j = 0; j < steps; j++) {
    for (let k = 0; k < seg; k++) {
      const a = j * row + k;
      const b = a + row;
      I.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(I);
  return g;
}

// Flat fan of triangles in the YZ plane (membranes).
function membrane(pts) {
  const P = [];
  const N = [];
  const I = [];
  for (const p of pts) {
    P.push(0, p[0], p[1]);
    N.push(1, 0, 0);
  }
  for (let i = 1; i < pts.length - 1; i++) I.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(I);
  return g;
}

const UP = -Math.PI / 2; // rotate a +Y cone to point toward -Z
const DOWN = Math.PI / 2; // ...or toward +Z

/* -------------------------------- mouths -------------------------------- */

function jawMouth(P, o) {
  const { len, wid, teeth = 0, tooth = 0.06, tusk = 0, nose = 0 } = o;
  P.main.add(sph(1), 'base', { p: [0, len * 0.48, 0.04], s: [wid, len, wid * 0.62] });
  P.main.add(sph(1), 'dark', { p: [0, len * 0.38, 0], s: [wid * 0.74, len * 0.72, wid * 0.3] });
  if (nose) P.main.add(sph(nose), 'nose', { p: [0, len * 1.38, 0.075] });
  else {
    P.main.add(sph(0.016), 'nose', { p: [wid * 0.34, len * 1.3, 0.07] });
    P.main.add(sph(0.016), 'nose', { p: [-wid * 0.34, len * 1.3, 0.07] });
  }
  P.jaw.add(sph(1), 'belly', { p: [0, len * 0.44, -0.045], s: [wid * 0.86, len * 0.88, wid * 0.42] });
  for (let i = 0; i < teeth; i++) {
    const y = len * (0.5 + (i / Math.max(teeth - 1, 1)) * 0.75);
    const x = wid * (0.62 - i * 0.04);
    for (const sx of [-1, 1]) {
      P.main.add(cone(tooth * 0.34, tooth, 5), 'bone', { p: [sx * x, y, 0.005], r: [DOWN, 0, 0] });
      P.jaw.add(cone(tooth * 0.3, tooth * 0.8, 5), 'bone', { p: [sx * x * 0.9, y - len * 0.08, -0.03], r: [UP, 0, 0] });
    }
  }
  if (tusk) {
    for (const sx of [-1, 1]) P.jaw.add(cone(tusk * 0.24, tusk, 6), 'bone', { p: [sx * wid * 0.7, len * 0.7, -0.03], r: [UP - 0.2, 0, sx * -0.25] });
  }
}

/* --------------------------------- defs --------------------------------- */

// stats keys: bite ram swipe (fierce) · trill sway flare glow (social)
//             speed jump glide · health armor sight sense
export const PART_LIST = [
  /* mouths */
  {
    id: 'nibbler', name: 'Nibbler', cat: 'mouth', cost: 15, tier: 0, diet: 'herb',
    stats: { bite: 1, trill: 1 }, blurb: 'A soft muzzle for leaves and berries.',
    make(P) { jawMouth(P, { len: 0.19, wid: 0.15 }); },
  },
  {
    id: 'gnasher', name: 'Gnasher', cat: 'mouth', cost: 15, tier: 0, diet: 'carn',
    stats: { bite: 2 }, blurb: 'Hooked teeth. Meat only.',
    make(P) { jawMouth(P, { len: 0.25, wid: 0.14, teeth: 4, tooth: 0.06 }); },
  },
  {
    id: 'snuffler', name: 'Snuffler', cat: 'mouth', cost: 20, tier: 0, diet: 'omni',
    stats: { bite: 1 }, blurb: 'Eats whatever it finds.',
    make(P) { jawMouth(P, { len: 0.21, wid: 0.135, tusk: 0.09, nose: 0.045 }); },
  },
  {
    id: 'fluter', name: 'Fluter', cat: 'mouth', cost: 30, tier: 1, diet: 'herb',
    stats: { bite: 1, trill: 3 }, blurb: 'A horn of a mouth, made for song.',
    make(P) {
      P.main.add(cyl(0.062, 0.07, 0.2, 8), 'base');
      P.jaw.add(cyl(0.1, 0.062, 0.1, 10), 'accent', { p: [0, 0.19, 0] });
      P.jaw.add(sph(1), 'dark', { p: [0, 0.285, 0], s: [0.088, 0.02, 0.088] });
      P.pulse = true;
    },
  },
  {
    id: 'cragbeak', name: 'Cragbeak', cat: 'mouth', cost: 40, tier: 2, diet: 'omni',
    stats: { bite: 3, trill: 1 }, blurb: 'A heavy beak that cracks anything.',
    make(P) {
      P.main.add(sph(1), 'base', { p: [0, 0.03, 0.02], s: [0.15, 0.09, 0.12] });
      P.main.add(cone(0.13, 0.34, 8), 'horn', { p: [0, 0, 0.03], s: [1, 1, 0.72], r: [0.12, 0, 0] });
      P.main.add(sph(1), 'dark', { p: [0, 0.1, 0], s: [0.09, 0.12, 0.03] });
      P.jaw.add(cone(0.105, 0.25, 8), 'horn', { p: [0, 0, -0.04], s: [1, 1, 0.45] });
    },
  },
  {
    id: 'shearjaw', name: 'Shearjaw', cat: 'mouth', cost: 45, tier: 2, diet: 'carn',
    stats: { bite: 4 }, blurb: 'Long jaws lined with blades.',
    make(P) {
      jawMouth(P, { len: 0.34, wid: 0.165, teeth: 6, tooth: 0.085 });
      for (const sx of [-1, 1]) P.main.add(cone(0.03, 0.09, 5), 'accent', { p: [sx * 0.1, 0.1, 0.1], r: [DOWN + 0.5, 0, 0] });
    },
  },

  /* eyes */
  {
    id: 'beadeye', name: 'Bead Eye', cat: 'eye', cost: 5, tier: 0,
    stats: { sight: 1 }, blurb: 'Small, bright, watchful.',
    make(P) {
      P.main.add(sph(1), 'base', { s: [0.085, 0.035, 0.085] });
      P.eye = { r: 0.064, y: 0.042 };
    },
  },
  {
    id: 'mooneye', name: 'Moon Eye', cat: 'eye', cost: 10, tier: 0,
    stats: { sight: 1, flare: 1 }, blurb: 'Wide and hard to say no to.',
    make(P) {
      P.main.add(sph(1), 'base', { s: [0.125, 0.045, 0.125] });
      P.eye = { r: 0.1, y: 0.058 };
    },
  },
  {
    id: 'stalkeye', name: 'Stalk Eye', cat: 'eye', cost: 15, tier: 1,
    stats: { sight: 2 }, blurb: 'Sees over the tall grass.',
    make(P) {
      P.main.add(tube([[0, 0, 0], [0, 0.12, 0.025], [0, 0.23, 0]], [0.042, 0.028, 0.032], 6, 6), 'base');
      P.eye = { r: 0.07, y: 0.27 };
    },
  },
  {
    id: 'sliteye', name: 'Slit Eye', cat: 'eye', cost: 10, tier: 1,
    stats: { sight: 1, bite: 0 }, blurb: 'A hunter’s narrow stare.',
    make(P) {
      P.main.add(sph(1), 'accent', { s: [0.1, 0.04, 0.1] });
      P.eye = { r: 0.078, y: 0.046, slit: true, white: 'amber' };
    },
  },

  /* legs — placed in mirrored pairs */
  {
    id: 'stumper', name: 'Stumper', cat: 'leg', cost: 15, tier: 0,
    stats: { speed: 1, health: 10 }, blurb: 'Short, sturdy, dependable.',
    upper: 0.27, lower: 0.25, r: [0.11, 0.09, 0.082], stance: 0.9, splay: 0.12, pole: [0.5, 0.1, 1], ankle: 0.07,
    foot(P) {
      P.main.add(sph(1), 'sock', { p: [0, 0.05, 0.03], s: [0.11, 0.062, 0.13] });
      for (const x of [-0.06, 0, 0.06]) P.main.add(sph(0.026, 6, 5), 'bone', { p: [x, 0.03, 0.145 - Math.abs(x) * 0.3] });
    },
  },
  {
    id: 'strider', name: 'Strider', cat: 'leg', cost: 20, tier: 0,
    stats: { speed: 2 }, blurb: 'An easy, ground-covering walk.',
    upper: 0.4, lower: 0.4, r: [0.09, 0.064, 0.05], stance: 0.88, splay: 0.12, pole: [0.4, 0.1, 1], ankle: 0.05,
    foot(P) {
      P.main.add(sph(0.046, 7, 6), 'sock', { p: [0, 0.042, 0] });
      for (const [x, z] of [[-0.05, 0.085], [0, 0.11], [0.05, 0.085]]) P.main.add(sph(1, 7, 5), 'sock', { p: [x, 0.025, z], s: [0.03, 0.026, 0.095], r: [0, x * 5, 0] });
    },
  },
  {
    id: 'skitter', name: 'Skitter', cat: 'leg', cost: 25, tier: 1,
    stats: { speed: 2, sway: 1 }, blurb: 'High knees, quick little steps.',
    upper: 0.48, lower: 0.66, r: [0.06, 0.042, 0.026], stance: 0.42, splay: 0.72, pole: [1, 1.6, 0.1], ankle: 0.09,
    foot(P) {
      P.main.add(cone(0.03, 0.1, 6), 'sock', { p: [0, 0.1, 0], r: [Math.PI, 0, 0] });
    },
  },
  {
    id: 'sprinter', name: 'Sprinter', cat: 'leg', cost: 35, tier: 1,
    stats: { speed: 3, sway: 1 }, blurb: 'Built to run things down, or get away.',
    upper: 0.45, lower: 0.56, r: [0.105, 0.06, 0.04], stance: 0.82, splay: 0.1, pole: [0.3, 0.2, -1], ankle: 0.05,
    foot(P) {
      for (const x of [-0.036, 0.036]) {
        P.main.add(sph(1, 7, 5), 'sock', { p: [x, 0.026, 0.1], s: [0.03, 0.026, 0.135] });
        P.main.add(cone(0.018, 0.06, 5), 'bone', { p: [x, 0.02, 0.21], r: [DOWN, 0, 0] });
      }
    },
  },
  {
    id: 'springer', name: 'Springer', cat: 'leg', cost: 35, tier: 2,
    stats: { speed: 2, jump: 2 }, blurb: 'Folded like a spring. Leaps.',
    upper: 0.36, lower: 0.6, r: [0.125, 0.06, 0.045], stance: 0.6, splay: 0.14, pole: [0.3, 0.2, -1], ankle: 0.05,
    foot(P) {
      P.main.add(sph(1), 'sock', { p: [0, 0.032, 0.1], s: [0.068, 0.036, 0.2] });
    },
  },
  {
    id: 'talon', name: 'Talon', cat: 'leg', cost: 40, tier: 2,
    stats: { speed: 2, swipe: 2 }, blurb: 'Every step ends in a hook.',
    upper: 0.4, lower: 0.44, r: [0.1, 0.07, 0.052], stance: 0.86, splay: 0.12, pole: [0.4, 0.1, 1], ankle: 0.065,
    foot(P) {
      P.main.add(sph(0.055, 7, 6), 'sock', { p: [0, 0.05, 0] });
      for (const x of [-0.055, 0, 0.055]) P.main.add(tube([[x, 0.05, 0.02], [x * 1.4, 0.06, 0.13], [x * 1.6, 0.0, 0.21]], [0.034, 0.024, 0.006], 5, 5), 'bone');
    },
  },

  /* arms — placed in mirrored pairs */
  {
    id: 'nubarm', name: 'Nub Arm', cat: 'arm', cost: 15, tier: 0,
    stats: { swipe: 1 }, blurb: 'Small hands for small jobs.',
    upper: 0.24, lower: 0.22, r: [0.06, 0.05, 0.04],
    hand(P) {
      P.main.add(sph(1, 8, 6), 'sock', { p: [0, 0.04, 0], s: [0.055, 0.06, 0.05] });
      for (const x of [-0.035, 0, 0.035]) P.main.add(sph(1, 6, 5), 'sock', { p: [x, 0.105 - Math.abs(x) * 0.3, 0], s: [0.018, 0.04, 0.018] });
    },
  },
  {
    id: 'raker', name: 'Raker', cat: 'arm', cost: 35, tier: 1,
    stats: { swipe: 3 }, blurb: 'Three long claws on a strong wrist.',
    upper: 0.32, lower: 0.3, r: [0.072, 0.056, 0.046],
    hand(P) {
      P.main.add(sph(1, 8, 6), 'sock', { p: [0, 0.04, 0], s: [0.062, 0.06, 0.052] });
      for (const x of [-0.04, 0, 0.04]) P.main.add(cone(0.02, 0.17, 5), 'bone', { p: [x, 0.07, 0], r: [0.25, 0, -x * 7] });
    },
  },
  {
    id: 'beckoner', name: 'Beckoner', cat: 'arm', cost: 30, tier: 1,
    stats: { flare: 2, swipe: 1 }, blurb: 'Long, expressive, hard to ignore.',
    upper: 0.4, lower: 0.42, r: [0.046, 0.036, 0.03],
    hand(P) {
      P.main.add(sph(0.04, 7, 6), 'sock', { p: [0, 0.03, 0] });
      for (const x of [-0.035, 0, 0.035]) {
        P.main.add(tube([[x * 0.6, 0.04, 0], [x * 1.4, 0.13, 0.01], [x * 2.2, 0.2, 0]], [0.016, 0.012, 0.008], 5, 4), 'sock');
        P.main.add(sph(0.02, 6, 5), 'accent', { p: [x * 2.2, 0.205, 0] });
      }
    },
  },

  /* flourishes */
  {
    id: 'nubhorn', name: 'Nub Horn', cat: 'detail', cost: 10, tier: 0,
    stats: { ram: 1 }, blurb: 'A first, hopeful horn.',
    make(P) { P.main.add(cone(0.05, 0.17, 7), 'bone', { r: [-0.15, 0, 0] }); },
  },
  {
    id: 'backspike', name: 'Back Spike', cat: 'detail', cost: 10, tier: 0,
    stats: { armor: 1 }, blurb: 'Makes you awkward to swallow.',
    make(P) { P.main.add(cone(0.05, 0.22, 6), 'accent', { r: [-0.35, 0, 0] }); },
  },
  {
    id: 'sailfin', name: 'Sail Fin', cat: 'detail', cost: 15, tier: 0,
    stats: { flare: 1 }, blurb: 'Catches the light, and attention.',
    make(P) {
      P.main.add(sph(1, 10, 8), 'accent', { p: [0, 0.07, 0], s: [0.02, 0.29, 0.34] });
      for (const z of [-0.2, 0, 0.2]) P.main.add(cone(0.016, 0.34 - Math.abs(z) * 0.5, 4), 'sock', { p: [0, 0, z], r: [z * 1.2, 0, 0] });
      P.flare = true;
    },
  },
  {
    id: 'glowspot', name: 'Glow Spot', cat: 'detail', cost: 10, tier: 0,
    stats: { glow: 1 }, blurb: 'A soft light under the skin.',
    make(P) {
      P.glow.add(sph(1, 8, 6), 'glow', { p: [0, 0.004, 0], s: [0.07, 0.028, 0.07] });
      P.halo = 0.3;
    },
  },
  {
    id: 'whisker', name: 'Feelers', cat: 'detail', cost: 10, tier: 0,
    stats: { sense: 1 }, blurb: 'Taste the air. Find food from farther off.',
    make(P) {
      for (const sx of [-1, 1]) P.main.add(tube([[sx * 0.02, 0, 0], [sx * 0.09, 0.11, 0.03], [sx * 0.2, 0.17, 0.0], [sx * 0.26, 0.15, -0.06]], [0.013, 0.01, 0.006, 0.003], 4, 7), 'sock');
    },
  },
  {
    id: 'tuft', name: 'Tuft', cat: 'detail', cost: 5, tier: 0,
    stats: { flare: 0 }, blurb: 'Purely for looks. No shame in that.',
    make(P) {
      const tilt = [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.35, 0.4], [-0.35, -0.4]];
      for (const [a, b] of tilt) P.main.add(cone(0.022, 0.13, 4), 'belly', { p: [b * 0.06, 0, a * 0.06], r: [a, 0, -b] });
    },
  },
  {
    id: 'crest', name: 'Crest', cat: 'detail', cost: 20, tier: 1,
    stats: { flare: 2 }, blurb: 'A fan of quills that snaps open.',
    make(P) {
      for (let k = -2; k <= 2; k++) P.main.add(cone(0.034, 0.27 - Math.abs(k) * 0.045, 5), k === 0 ? 'glow' : 'accent', { r: [k * 0.4, 0, 0], s: [0.5, 1, 1] });
      P.main.add(sph(1, 8, 6), 'base', { p: [0, 0.07, 0], s: [0.012, 0.13, 0.2] });
      P.flare = true;
    },
  },
  {
    id: 'tailfan', name: 'Tail Fan', cat: 'detail', cost: 20, tier: 1,
    stats: { sway: 2 }, blurb: 'Made to be shaken at someone.',
    make(P) {
      for (let k = -2; k <= 2; k++) {
        const a = k * 0.42;
        P.main.add(sph(1, 8, 6), k % 2 === 0 ? 'accent' : 'glow', { p: [Math.sin(a) * 0.2, Math.cos(a) * 0.2, 0], r: [0, 0, -a], s: [0.05, 0.22, 0.014] });
      }
      P.flare = true;
    },
  },
  {
    id: 'lantern', name: 'Lantern', cat: 'detail', cost: 25, tier: 1,
    stats: { glow: 2 }, blurb: 'A lure that burns blue after dark.',
    make(P) {
      P.main.add(tube([[0, 0, 0], [0, 0.18, 0.06], [0, 0.3, 0.2], [0, 0.27, 0.34]], [0.03, 0.02, 0.015, 0.012], 5, 8), 'base');
      P.glow.add(sph(0.06, 10, 8), 'glow', { p: [0, 0.25, 0.38] });
      P.halo = 0.55;
      P.haloAt = [0, 0.25, 0.38];
    },
  },
  {
    id: 'shellplate', name: 'Shell Plate', cat: 'detail', cost: 25, tier: 1,
    stats: { armor: 2, health: 10 }, blurb: 'Heavy. Worth it when things bite.',
    make(P) {
      P.main.add(sph(1, 10, 6), 'sock', { s: [0.215, 0.03, 0.255] });
      P.main.add(sph(1, 10, 6), 'accent', { p: [0, 0.012, 0], s: [0.195, 0.065, 0.235] });
    },
  },
  {
    id: 'longhorn', name: 'Long Horn', cat: 'detail', cost: 30, tier: 2,
    stats: { ram: 3 }, blurb: 'Swept back, and meant.',
    make(P) {
      P.main.add(tube([[0, 0, 0], [0, 0.16, -0.02], [0, 0.3, -0.1], [0, 0.38, -0.24]], [0.06, 0.046, 0.03, 0.006], 6, 8), 'horn');
    },
  },
  {
    id: 'wingfin', name: 'Wing Fin', cat: 'detail', cost: 50, tier: 2,
    stats: { glide: 2, flare: 1 }, blurb: 'Not flight. But a very long jump.',
    make(P) {
      P.main.add(tube([[0, 0, 0], [0, 0.36, -0.04], [0, 0.72, -0.24]], [0.042, 0.03, 0.01], 5, 6), 'base');
      P.main.add(membrane([[0, 0], [0.36, -0.04], [0.72, -0.24], [0.42, -0.56], [0.03, -0.46]]), 'accent');
      P.flare = true;
    },
  },
];

export const PARTS = Object.fromEntries(PART_LIST.map((d) => [d.id, d]));
export const CATEGORIES = [
  { id: 'mouth', name: 'Mouths' },
  { id: 'eye', name: 'Eyes' },
  { id: 'leg', name: 'Legs' },
  { id: 'arm', name: 'Arms' },
  { id: 'detail', name: 'Flourishes' },
];
export const STARTER_PARTS = PART_LIST.filter((d) => d.tier === 0).map((d) => d.id);

/* ----------------------------- part objects ----------------------------- */

let pupilGeoRound = null;
let pupilGeoSlit = null;
function pupilGeometry(slit) {
  if (slit ? pupilGeoSlit : pupilGeoRound) return slit ? pupilGeoSlit : pupilGeoRound;
  const b = new Builder({ pupil: new THREE.Color('#15151a'), white: new THREE.Color('#ffffff'), base: new THREE.Color('#15151a') });
  // part X is "up" for an eye on the flank, so a slit pupil is narrow in Z
  b.add(sph(1, 10, 8), 'pupil', { s: slit ? [1, 1, 0.34] : [1, 1, 1] });
  b.add(sph(0.26, 6, 5), 'white', { p: [0.34, 0.74, slit ? 0.14 : 0.4] });
  const g = b.done();
  if (slit) pupilGeoSlit = g;
  else pupilGeoRound = g;
  return g;
}

function geometryFor(def, kit, which) {
  const key = def.id + ':' + which;
  let entry = kit.geo.get(key);
  if (entry) return entry;
  const P = {
    main: new Builder(kit.colors),
    jaw: new Builder(kit.colors),
    glow: new Builder(kit.colors),
    ball: new Builder(kit.colors),
    eye: null,
    flare: false,
    pulse: false,
    halo: 0,
    haloAt: null,
  };
  def[which](P);
  if (P.eye) P.ball.add(sph(P.eye.r, 12, 10), P.eye.white || 'white');
  entry = {
    main: P.main.empty ? null : P.main.done(),
    jaw: P.jaw.empty ? null : P.jaw.done(),
    glow: P.glow.empty ? null : P.glow.done(),
    ball: P.ball.empty ? null : P.ball.done(),
  };
  entry.meta = { eye: P.eye, flare: P.flare, pulse: P.pulse, halo: P.halo, haloAt: P.haloAt };
  kit.geo.set(key, entry);
  return entry;
}

// Build the scene object for a surface part ("make"), a foot or a hand.
export function buildPartObject(def, kit, which = 'make') {
  const { main, jaw, glow, ball, meta } = geometryFor(def, kit, which);
  const mat = partMaterial();
  const group = new THREE.Group();
  const ud = group.userData;
  ud.def = def;
  if (main) {
    const m = new THREE.Mesh(main, mat);
    m.castShadow = true;
    group.add(m);
  }
  if (jaw) {
    const m = new THREE.Mesh(jaw, mat);
    group.add(m);
    ud.jaw = m;
    ud.pulse = meta.pulse;
  }
  if (glow) {
    const m = new THREE.Mesh(glow, kit.glowMat);
    group.add(m);
    ud.glow = m;
  }
  if (meta.halo) {
    const sm = new THREE.SpriteMaterial({ map: haloTexture(), color: kit.glowMat.color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
    const sp = new THREE.Sprite(sm);
    sp.scale.setScalar(meta.halo);
    if (meta.haloAt) sp.position.set(meta.haloAt[0], meta.haloAt[1], meta.haloAt[2]);
    else sp.position.set(0, 0.03, 0);
    group.add(sp);
    ud.halo = sp;
    ud.haloSize = meta.halo;
  }
  if (meta.eye) {
    const ballGroup = new THREE.Group();
    ballGroup.position.set(0, meta.eye.y, 0);
    ballGroup.add(new THREE.Mesh(ball, mat));
    const pupil = new THREE.Mesh(pupilGeometry(!!meta.eye.slit), mat);
    const pr = meta.eye.r * 0.56;
    pupil.scale.setScalar(pr);
    ballGroup.add(pupil);
    group.add(ballGroup);
    ud.eye = { ball: ballGroup, pupil, r: meta.eye.r };
  }
  ud.flare = meta.flare;
  return group;
}

export function disposePartObject(obj) {
  obj.traverse((o) => {
    if (o.isSprite) o.material.dispose();
  });
}
