// The lakeside: an island with a spit of land, one big autumn tree, a cove,
// a standing stone in the shallows, a lantern islet, and a far shore with a town.
// Everything is generated from a seed; no textures or models are loaded.

import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm, v3 } from "./math.js";
import { applyRelief, BLUFF, ellipseR, PHI_FALL } from "./relief.js";

// --- The hero view -----------------------------------------------------------
// You start on a knoll looking across the cove at the tree, the way the
// reference painting is framed. "Hero-local" coordinates use that view:
// u = screen right, w = away from you, y = up, with the tree base at u = w = 0.
export const TREE = [0, 0];
export const HERO = { x: 12.4, z: 20.6, yaw: -0.542, pitch: 0.15 };
export const HERO_F = [Math.sin(HERO.yaw), -Math.cos(HERO.yaw)];
export const HERO_R = [Math.cos(HERO.yaw), Math.sin(HERO.yaw)];
export const heroLocal = (u, y, w) => [
  TREE[0] + u * HERO_R[0] + w * HERO_F[0],
  y,
  TREE[1] + u * HERO_R[1] + w * HERO_F[1],
];
const HERO_AZ = Math.atan2(HERO_F[1], HERO_F[0]); // world azimuth of the view, atan2(z, x)
const SHORE_R = 580; // distance to the far shore with the town

export const PALETTE = {
  navy: [0.027, 0.055, 0.114],
  char: [0.11, 0.114, 0.153],
  slate: [0.227, 0.239, 0.31],
  slateL: [0.345, 0.353, 0.435],
  rustD: [0.306, 0.204, 0.192],
  rust: [0.478, 0.29, 0.18],
  rustL: [0.647, 0.376, 0.173],
  tan: [0.784, 0.604, 0.384],
  purp: [0.235, 0.239, 0.431],
  blue: [0.298, 0.341, 0.69],
  peri: [0.376, 0.502, 0.816],
  periL: [0.541, 0.635, 0.925],
  sky: [0.62, 0.678, 0.718],
  skyL: [0.714, 0.765, 0.839],
  cloud: [0.808, 0.859, 0.969],
  white: [1, 1, 1],
};

// --- Geometry accumulator ----------------------------------------------------
// Every mesh carries position, normal, colour and a free vec4 ("ext") whose
// meaning depends on the material (uv, seeds, ids, emissive flags).
export class Geo {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.ext = [];
    this.idx = [];
    this.n = 0;
  }
  v(p, n, c, e) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.ext.push(e[0], e[1], e[2], e[3]);
    return this.n++;
  }
  t(a, b, c) {
    this.idx.push(a, b, c);
  }
  q(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }
  // Flat-shaded triangle (own vertices, face normal).
  flat(a, b, c, col, ext = [0, 0, 0, 0]) {
    const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    const i = this.v(a, n, col, ext);
    this.v(b, n, col, ext);
    this.v(c, n, col, ext);
    this.t(i, i + 1, i + 2);
  }
  // Recompute smooth normals for vertices from `from` onward.
  smoothNormals(from = 0, idxFrom = 0) {
    for (let i = from * 3; i < this.nrm.length; i++) this.nrm[i] = 0;
    const P = this.pos;
    for (let k = idxFrom; k < this.idx.length; k += 3) {
      const a = this.idx[k], b = this.idx[k + 1], c = this.idx[k + 2];
      if (a < from) continue;
      const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
      const pb = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
      const pc = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
      const fn = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
      for (const i of [a, b, c]) {
        this.nrm[i * 3] += fn[0];
        this.nrm[i * 3 + 1] += fn[1];
        this.nrm[i * 3 + 2] += fn[2];
      }
    }
    for (let i = from; i < this.n; i++) {
      const n = v3.norm([this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]]);
      this.nrm[i * 3] = n[0];
      this.nrm[i * 3 + 1] = n[1];
      this.nrm[i * 3 + 2] = n[2];
    }
  }
  arrays() {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Float32Array(this.nrm),
      col: new Float32Array(this.col),
      ext: new Float32Array(this.ext),
      idx: new Uint32Array(this.idx),
    };
  }
}

// --- Land shape --------------------------------------------------------------
function segDist(px, pz, ax, az, bx, bz) {
  const pax = px - ax, paz = pz - az, bax = bx - ax, baz = bz - az;
  const h = clamp((pax * bax + paz * baz) / (bax * bax + baz * baz), 0, 1);
  return Math.hypot(pax - bax * h, paz - baz * h);
}
function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

const SPIT = [-27, 2.5, 20, -1];
const SANDBAR = [-30, 2, -46, -11.5];
export const ISLET = [-49, -13];

// Signed distance to the shoreline in metres (negative on land).
export function landSDF(x, z) {
  let d = segDist(x, z, ...SPIT) - 7.5;
  d = smin(d, (Math.hypot((x - 46) / 38, (z - 46) / 46) - 1) * 38, 12);
  d = smin(d, Math.hypot(x - 13.5, z - 21) - 10, 7);
  d = smin(d, Math.hypot(x - ISLET[0], z - ISLET[1]) - 6.5, 2.5);
  d += fbm(x * 0.035, z * 0.035, 3, 7) * 4 + fbm(x * 0.13, z * 0.13, 2, 11) * 1.2;
  return d;
}

function rawHeight(x, z) {
  const d = -landSDF(x, z);
  // gentle wading shelf a few metres wide, then the lake bed drops away
  let h = d > 0 ? 1.6 * Math.tanh(d / 5) + 0.12 : 0.12 + 0.6 * Math.tanh(d / 4) - Math.max(0, -d - 4) * 0.12;
  if (d > 0) {
    const spitD = segDist(x, z, ...SPIT);
    const inland = smoothstep(2, 18, d) * smoothstep(6, 22, spitD);
    const n = fbm(x * 0.025, z * 0.025, 4, 3) * 0.5 + 0.5;
    const rise = smoothstep(10, 90, z + x * 0.35);
    h += inland * (n * 3.2 + rise * 5.5);
    h += fbm(x * 0.2, z * 0.2, 2, 5) * 0.22 * smoothstep(0, 3, d);
  }
  h += 1.4 * Math.exp(-((x - 13.5) ** 2 + (z - 21) ** 2) / 45) * smoothstep(-2, 2, d);
  h += 0.85 * Math.exp(-(x * x + z * z) / 30);
  const sb = segDist(x, z, ...SANDBAR);
  h = Math.max(h, -0.26 - 0.5 * smoothstep(1, 3, sb) - 9 * smoothstep(3, 6, sb));
  return Math.max(h, -8);
}

export class Terrain {
  constructor() {
    this.x0 = -110;
    this.z0 = -95;
    this.size = 240;
    this.n = 241;
    this.step = this.size / (this.n - 1);
    const n = this.n;
    this.h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        this.h[j * n + i] = rawHeight(this.x0 + i * this.step, this.z0 + j * this.step);
      }
    }
    // per-vertex masks: worn trail, cliff rock
    this.mask = new Float32Array(n * n * 3);
    this.relief = applyRelief(this, ISLET);
  }
  maskAt(x, z, c = 0) {
    const i = Math.round((x - this.x0) / this.step), j = Math.round((z - this.z0) / this.step);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return 0;
    return this.mask[(j * this.n + i) * 3 + c];
  }
  heightAt(x, z) {
    const fx = (x - this.x0) / this.step;
    const fz = (z - this.z0) / this.step;
    if (fx < 0 || fz < 0 || fx >= this.n - 1 || fz >= this.n - 1) return -8;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const n = this.n, H = this.h;
    const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }
  normalAt(x, z) {
    const e = 0.6;
    return v3.norm([
      this.heightAt(x - e, z) - this.heightAt(x + e, z),
      2 * e,
      this.heightAt(x, z - e) - this.heightAt(x, z + e),
    ]);
  }
  arrays() {
    const n = this.n, H = this.h, s = this.step;
    const pos = new Float32Array(n * n * 3);
    const nrm = new Float32Array(n * n * 3);
    const col = this.mask.slice();
    const ext = new Float32Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos[k * 3] = this.x0 + i * s;
        pos[k * 3 + 1] = H[k];
        pos[k * 3 + 2] = this.z0 + j * s;
        const hl = H[j * n + Math.max(i - 1, 0)], hr = H[j * n + Math.min(i + 1, n - 1)];
        const hd = H[Math.max(j - 1, 0) * n + i], hu = H[Math.min(j + 1, n - 1) * n + i];
        const nn = v3.norm([hl - hr, 2 * s, hd - hu]);
        nrm.set(nn, k * 3);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let o = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    return { pos, nrm, col, ext, idx };
  }
  // Height grid for the water shader (how deep the lake is under each point).
  get mapInfo() {
    return [this.x0, this.z0, this.size, this.size];
  }
}

// --- Branches and foliage ----------------------------------------------------
function catmull(ctrl, perSeg) {
  const out = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(i - 1, 0)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(i + 2, n - 1)];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const pt = [];
      for (let k = 0; k < 4; k++) {
        pt.push(
          0.5 *
            (2 * p1[k] +
              (-p0[k] + p2[k]) * t +
              (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
              (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
        );
      }
      pt[3] = Math.max(pt[3], 0.02);
      out.push(pt);
    }
  }
  out.push(ctrl[n - 1].slice());
  return out;
}

// Generalised cylinder along a curve. pts: [x, y, z, radius].
function tube(geo, pts, sides, tint = [1, 1, 1]) {
  let prevN = null;
  let along = 0;
  const base = geo.n;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const tan = v3.norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let nrm;
    if (!prevN) nrm = v3.norm(v3.cross(tan, Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    else nrm = v3.norm(v3.sub(prevN, v3.scale(tan, v3.dot(prevN, tan))));
    prevN = nrm;
    const bin = v3.cross(tan, nrm);
    if (i > 0) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
    for (let s = 0; s <= sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const dir = v3.add(v3.scale(nrm, Math.cos(ang)), v3.scale(bin, Math.sin(ang)));
      geo.v([p[0] + dir[0] * p[3], p[1] + dir[1] * p[3], p[2] + dir[2] * p[3]], dir, tint, [s / sides, along, p[3], 0]);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = base + i * ring + s;
      geo.q(a, a + 1, a + ring + 1, a + ring);
    }
  }
}

const LEAF_COLORS = [
  [0.478, 0.29, 0.18],
  [0.647, 0.376, 0.173],
  [0.56, 0.32, 0.17],
  [0.4, 0.24, 0.17],
  [0.6, 0.35, 0.16],
  [0.74, 0.47, 0.22],
];

// A flat tier of leaf cards, the way the painting's canopy reads as stacked pads.
function foliagePad(geo, c, R, rng, opts = {}) {
  const { density = 12, size = [0.45, 0.72], colors = LEAF_COLORS, spots = null, dim = 1 } = opts;
  const count = Math.max(6, Math.round(R[0] * R[2] * density));
  for (let i = 0; i < count; i++) {
    let x, y, z;
    do {
      x = rng() * 2 - 1;
      y = rng() * 2 - 1;
      z = rng() * 2 - 1;
    } while (x * x + y * y + z * z > 1 || x * x + y * y + z * z < 0.01);
    const len = Math.hypot(x, y, z);
    const target = 0.45 + 0.55 * Math.sqrt(rng());
    x *= target / len;
    y *= target / len;
    z *= target / len;
    if (y < 0) y *= 0.55;
    const p = [c[0] + x * R[0], c[1] + y * R[1], c[2] + z * R[2]];
    const n = v3.norm([x / R[0], (y / R[1]) * 0.85 + 0.15, z / R[2]]);
    const ao = (0.5 + 0.5 * target) * (0.72 + 0.28 * (y * 0.5 + 0.5)) * dim;
    const base = colors[Math.floor(rng() * colors.length)];
    const k = ao * (0.88 + 0.24 * rng());
    const col = [base[0] * k, base[1] * k, base[2] * k];
    const s = lerp(size[0], size[1], rng());
    const th = rng() * Math.PI * 2;
    const ph = rng() < 0.16 ? (rng() < 0.5 ? 1 : -1) * lerp(1.0, 1.5, rng()) : (rng() - 0.5) * 0.7;
    const a1 = [Math.cos(th) * s, 0, Math.sin(th) * s];
    const a2 = [-Math.sin(th) * Math.cos(ph) * s, Math.sin(ph) * s, Math.cos(th) * Math.cos(ph) * s];
    const seed = rng();
    const i0 = geo.v(v3.sub(v3.sub(p, a1), a2), n, col, [0, 0, seed, 0]);
    geo.v(v3.sub(v3.add(p, a1), a2), n, col, [1, 0, seed, 0]);
    geo.v(v3.add(v3.add(p, a1), a2), n, col, [1, 1, seed, 0]);
    geo.v(v3.add(v3.sub(p, a1), a2), n, col, [0, 1, seed, 0]);
    geo.q(i0, i0 + 1, i0 + 2, i0 + 3);
    if (spots) spots.push(p);
  }
}

function branchTo(bark, leaves, rng, start, pad, r0, spots) {
  const [c, R] = pad;
  const mid = v3.add(v3.lerp(start, c, 0.55), [0, 0.45 + rng() * 0.3, 0]);
  const end = [c[0], c[1] - R[1] * 0.35, c[2]];
  tube(bark, catmull([[...start, r0], [...mid, r0 * 0.62], [...end, r0 * 0.3]], 4), 5);
  // twigs fanning out inside the pad
  const twigs = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < twigs; i++) {
    const a = rng() * Math.PI * 2;
    const tip = [c[0] + Math.cos(a) * R[0] * 0.65, c[1] - R[1] * 0.1 + rng() * 0.3, c[2] + Math.sin(a) * R[2] * 0.65];
    tube(bark, catmull([[...end, r0 * 0.3], [...v3.lerp(end, tip, 0.5), r0 * 0.18], [...tip, 0.025]], 2), 4);
  }
  foliagePad(leaves, c, R, rng, { spots });
}

function nearestOn(points, target, maxY) {
  let best = points[0];
  let bd = Infinity;
  for (const p of points) {
    if (p[1] > maxY) continue;
    const d = Math.hypot(p[0] - target[0], (p[1] - target[1]) * 0.6, p[2] - target[2]);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best.slice(0, 3);
}

// The tree from the painting: a thick dark trunk forking into a tall leader
// that leans left and a lower limb reaching right, under flat rust-orange tiers.
function heroTree(terrain, bark, leaves, rng, spots) {
  const baseY = terrain.heightAt(TREE[0], TREE[1]);
  const K = 1.3; // the painting's tree is an old giant
  const L = (u, y, w, r) => [...heroLocal(u * K, baseY + y * K, w * K), r * K];

  const trunk = catmull([L(0.1, -0.7, 0, 1.3), L(0, 1.0, 0.05, 0.86), L(-0.2, 2.6, 0, 0.7), L(-0.35, 4.3, -0.05, 0.6)], 5);
  const leader = catmull(
    [L(-0.35, 4.1, -0.05, 0.6), L(-0.85, 6.6, -0.2, 0.5), L(-1.5, 9.6, -0.4, 0.38), L(-1.9, 12.4, -0.45, 0.25), L(-1.8, 14.7, -0.35, 0.1)],
    5
  );
  const limb = catmull(
    [L(-0.15, 4.0, 0.0, 0.56), L(1.0, 5.5, 0.2, 0.45), L(2.5, 7.0, 0.35, 0.34), L(4.1, 8.4, 0.3, 0.22), L(5.6, 9.5, 0.1, 0.1)],
    5
  );
  // a few smaller limbs out of the leader so the canopy has structure from behind
  const back = catmull([L(-1.2, 8.2, -0.3, 0.22), L(-1.0, 9.6, -1.6, 0.16), L(-0.6, 10.8, -2.8, 0.09)], 3);
  const front = catmull([L(-1.6, 9.9, -0.3, 0.2), L(-2.6, 10.6, 1.2, 0.14), L(-3.2, 10.9, 2.4, 0.08)], 3);
  for (const t of [trunk, leader, limb, back, front]) tube(bark, t, 9);

  // Roots spreading over the mound, as in the painting.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng() * 0.5;
    const dx = Math.cos(a), dz = Math.sin(a);
    const pts = [];
    const reach = 2.6 + rng() * 2.2;
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      const r = 0.7 + t * reach * 1.2;
      const x = TREE[0] + dx * r, z = TREE[1] + dz * r;
      const g = terrain.heightAt(x, z);
      const y = lerp(baseY + 0.75, g - 0.12, Math.pow(t, 0.55)) + Math.sin(t * 9 + i) * 0.04;
      pts.push([x, y, z, lerp(0.55, 0.06, t)]);
    }
    tube(bark, pts, 6);
  }

  const skeleton = [...leader, ...limb, ...back, ...front];
  const P = (u, y, w, rx, ry, rz) => [heroLocal(u * K, baseY + y * K, w * K), [rx * K, ry * 0.8, rz * K]];
  const pads = [
    P(-2.0, 14.6, 0, 3.2, 0.8, 2.6),
    P(-5.0, 13.2, 0.5, 3.0, 0.7, 2.4),
    P(0.8, 13.6, -0.5, 3.2, 0.7, 2.5),
    P(3.6, 12.6, 0.3, 3.0, 0.7, 2.4),
    P(-3.5, 11.6, -1.5, 2.8, 0.7, 2.2),
    P(6.1, 11.4, 0.0, 2.4, 0.6, 2.0),
    P(-7.6, 11.0, 0.8, 2.4, 0.6, 2.0),
    P(-6.6, 9.4, 1.2, 3.0, 0.7, 2.2),
    P(-9.2, 8.6, 0.4, 2.2, 0.6, 1.8),
    P(-4.0, 9.9, 2.0, 2.2, 0.6, 1.8),
    P(5.5, 9.8, 0.2, 2.0, 0.6, 1.8),
    P(3.0, 10.5, -1.5, 2.4, 0.6, 2.0),
    P(1.2, 11.2, 1.8, 2.2, 0.6, 1.8),
    P(-1.0, 12.4, 2.4, 2.4, 0.7, 2.0),
    P(-1.8, 12.0, -3.2, 2.8, 0.7, 2.2),
    P(1.8, 11.4, -3.0, 2.4, 0.6, 2.0),
    P(-5.0, 10.4, -2.6, 2.4, 0.6, 2.0),
    P(0.2, 9.4, 3.2, 2.0, 0.6, 1.8),
    P(-2.6, 15.6, 0.6, 2.0, 0.6, 1.8),
  ];
  for (const pad of pads) {
    const s = nearestOn(skeleton, pad[0], pad[0][1] - 0.6);
    branchTo(bark, leaves, rng, s, pad, 0.1 + rng() * 0.04, spots);
  }

  // Canopy footprint for the analytic shadow in the shaders.
  let cx = 0, cz = 0, cy = 0;
  for (const p of pads) {
    cx += p[0][0];
    cy += p[0][1];
    cz += p[0][2];
  }
  cx /= pads.length;
  cy /= pads.length;
  cz /= pads.length;
  let rad = 0;
  for (const p of pads) rad = Math.max(rad, Math.hypot(p[0][0] - cx, p[0][2] - cz) + p[1][0] * 0.6);
  return { canopy: [cx, cz, rad, cy], baseY };
}

function youngTree(terrain, bark, leaves, rng, x, z, scale) {
  const g = terrain.heightAt(x, z);
  const H = (3.6 + rng() * 2.2) * scale;
  const lean = [(rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8];
  const trunk = catmull(
    [
      [x, g - 0.4, z, 0.26 * scale],
      [x + lean[0] * 0.3, g + H * 0.4, z + lean[1] * 0.3, 0.19 * scale],
      [x + lean[0], g + H, z + lean[1], 0.07 * scale],
    ],
    4
  );
  tube(bark, trunk, 6);
  const pads = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < pads; i++) {
    const a = rng() * Math.PI * 2;
    const t = 0.55 + rng() * 0.5;
    const r = (0.6 + rng() * 1.4) * scale;
    const c = [x + lean[0] * t + Math.cos(a) * r, g + H * t + 0.3, z + lean[1] * t + Math.sin(a) * r];
    const R = [(1.1 + rng() * 0.8) * scale, 0.45 * scale, (1.0 + rng() * 0.7) * scale];
    branchTo(bark, leaves, rng, nearestOn(trunk, c, c[1] - 0.3), [c, R], 0.07 * scale, null);
  }
}

// --- Props -------------------------------------------------------------------
function box(geo, c, size, rotY, col, faceExt = null) {
  const [sx, sy, sz] = size.map((s) => s / 2);
  const cs = Math.cos(rotY), sn = Math.sin(rotY);
  const tr = (x, y, z) => [c[0] + x * cs - z * sn, c[1] + y, c[2] + x * sn + z * cs];
  const rot = (x, y, z) => [x * cs - z * sn, y, x * sn + z * cs];
  const faces = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], d: sz, us: sx, vs: sy, id: 1 },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], d: sz, us: sx, vs: sy, id: 2 },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], d: sx, us: sz, vs: sy, id: 3 },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], d: sx, us: sz, vs: sy, id: 4 },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], d: sy, us: sx, vs: sz, id: 5 },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], d: sy, us: sx, vs: sz, id: 6 },
  ];
  for (const f of faces) {
    const corner = (a, b) =>
      tr(
        f.n[0] * f.d + f.u[0] * a * f.us + f.v[0] * b * f.vs,
        f.n[1] * f.d + f.u[1] * a * f.us + f.v[1] * b * f.vs,
        f.n[2] * f.d + f.u[2] * a * f.us + f.v[2] * b * f.vs
      );
    const n = rot(...f.n);
    const e = (u, v) => (faceExt ? faceExt(f.id, u, v) : [u, v, f.id, 0]);
    const i = geo.v(corner(-1, -1), n, col, e(0, 0));
    geo.v(corner(1, -1), n, col, e(1, 0));
    geo.v(corner(1, 1), n, col, e(1, 1));
    geo.v(corner(-1, 1), n, col, e(0, 1));
    geo.q(i, i + 1, i + 2, i + 3);
  }
}

// n-sided prism or frustum, flat shaded, with caps.
function prism(geo, c, r0, r1, h, sides, rot, col, ext = [0, 0, 0, 0]) {
  const ring = (r, y) => {
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2;
      out.push([c[0] + Math.cos(a) * r, c[1] + y, c[2] + Math.sin(a) * r]);
    }
    return out;
  };
  const lo = ring(r0, 0), hi = ring(r1, h);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    geo.flat(lo[i], hi[j], lo[j], col, ext);
    geo.flat(lo[i], hi[i], hi[j], col, ext);
    if (r1 > 0.001) geo.flat([c[0], c[1] + h, c[2]], hi[j], hi[i], col, ext);
    geo.flat([c[0], c[1], c[2]], lo[i], lo[j], col, ext);
  }
}

function icoRock(geo, rng, c, scale, col) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(v3.norm);
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? a + "_" + b : b + "_" + a;
    if (!mid.has(key)) {
      verts.push(v3.norm(v3.scale(v3.add(verts[a], verts[b]), 0.5)));
      mid.set(key, verts.length - 1);
    }
    return mid.get(key);
  };
  const nf = [];
  for (const [a, b, cc] of faces) {
    const ab = midpoint(a, b), bc = midpoint(b, cc), ca = midpoint(cc, a);
    nf.push([a, ab, ca], [b, bc, ab], [cc, ca, bc], [ab, bc, ca]);
  }
  faces = nf;
  const seed = Math.floor(rng() * 1000);
  const rotY = rng() * Math.PI * 2;
  const cs = Math.cos(rotY), sn = Math.sin(rotY);
  const pts = verts.map((v) => {
    const k = 0.75 + 0.45 * vnoise(v[0] * 1.7 + 3, v[2] * 1.7 + v[1] * 1.3, seed);
    const x = v[0] * k * scale[0], y = v[1] * k * scale[1], z = v[2] * k * scale[2];
    return [c[0] + x * cs - z * sn, c[1] + y, c[2] + x * sn + z * cs];
  });
  for (const [a, b, cc] of faces) geo.flat(pts[a], pts[cc], pts[b], col);
}

// Long low shore or hill band around the view, used for everything past the lake.
function band(geo, center, R, az0, az1, segs, heightFn, col) {
  const prof = [[0, -1], [35, 0.78], [80, 1.0], [300, 0.9], [520, -1]];
  const base = geo.n;
  const idxFrom = geo.idx.length;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const az = lerp(az0, az1, t);
    const H = heightFn(t, az);
    const dx = Math.cos(az), dz = Math.sin(az);
    for (const [off, f] of prof) {
      const r = R + off;
      const y = f < 0 ? -10 : H * f;
      geo.v([center[0] + dx * r, y, center[1] + dz * r], [0, 1, 0], col, [t, f, 0, 0]);
    }
  }
  const k = prof.length;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < k - 1; j++) {
      const a = base + i * k + j;
      geo.q(a, a + k, a + k + 1, a + 1);
    }
  }
  geo.smoothNormals(base, idxFrom);
}

// --- Assemble the world ------------------------------------------------------
export function buildWorld(opts = {}) {
  const { mobile = false } = opts;
  const rng = mulberry32(20261106);
  const terrain = new Terrain();

  const bark = new Geo();
  const leaves = new Geo();
  const spots = [];
  const { canopy, baseY } = heroTree(terrain, bark, leaves, rng, spots);

  // A handful of young trees and rust shrubs further inland.
  const young = [
    [38, 30, 0.9], [55, 20, 1.1], [62, 52, 1.0], [30, 62, 0.85], [74, 36, 0.95], [46, 74, 1.05],
  ];
  const colliders = [{ x: TREE[0], z: TREE[1], r: 1.5 }];
  for (const [x, z, s] of young) {
    if (terrain.heightAt(x, z) < 0.6) continue;
    youngTree(terrain, bark, leaves, rng, x, z, s);
    colliders.push({ x, z, r: 0.35 * s });
  }
  for (let i = 0; i < 26; i++) {
    const x = lerp(18, 80, rng()), z = lerp(8, 85, rng());
    const g = terrain.heightAt(x, z);
    if (g < 0.8 || Math.hypot(x - HERO.x, z - HERO.z) < 6) continue;
    const s = 0.6 + rng() * 0.7;
    foliagePad(leaves, [x, g + 0.35 * s, z], [1.0 * s, 0.5 * s, 0.9 * s], rng, { density: 14, size: [0.35, 0.55], dim: 0.85 });
  }

  // Grass tufts and shoreline reeds.
  const grass = new Geo();
  const grassCount = mobile ? 3400 : 6500;
  let placed = 0;
  for (let tries = 0; tries < grassCount * 5 && placed < grassCount; tries++) {
    const x = lerp(-45, 85, rng()), z = lerp(-25, 95, rng());
    const g = terrain.heightAt(x, z);
    const reed = g > -0.35 && g < 0.1 && rng() < 0.16;
    if (!reed && g < 0.32) continue;
    if (Math.hypot(x - TREE[0], z - TREE[1]) < 1.7) continue;
    if (Math.hypot(x - HERO.x, z - HERO.z) < 2.2 && !reed) continue;
    if (terrain.normalAt(x, z)[1] < 0.82 && !reed) continue;
    if (terrain.maskAt(x, z, 0) > 0.25) continue;
    const patch = fbm(x * 0.07, z * 0.07, 3, 21);
    const nearTree = Math.hypot(x - TREE[0], z - TREE[1]) < 26;
    if (!reed && patch < (nearTree ? -0.35 : -0.05)) continue;
    const spitTip = -(x * HERO_R[0] + z * HERO_R[1]); // further screen-left = taller, paler tufts
    const H = reed ? 0.9 + rng() * 0.8 : 0.32 + rng() * 0.38 + smoothstep(10, 28, spitTip) * 0.35;
    const W = reed ? 0.35 + rng() * 0.2 : 0.45 + rng() * 0.45;
    const tones = reed
      ? [[0.36, 0.25, 0.2], [0.44, 0.3, 0.21], [0.3, 0.22, 0.22]]
      : [PALETTE.tan, [0.62, 0.42, 0.26], [0.7, 0.55, 0.38], [0.52, 0.31, 0.19]];
    const col = tones[Math.floor(rng() * tones.length)];
    const seed = rng();
    const y0 = reed ? Math.max(g, -0.6) - 0.05 : g - 0.06;
    for (let k = 0; k < 2; k++) {
      const a = rng() * Math.PI + k * (Math.PI / 2);
      const dx = Math.cos(a) * W * 0.5, dz = Math.sin(a) * W * 0.5;
      const n = [0, 1, 0];
      const i0 = grass.v([x - dx, y0, z - dz], n, col, [0, 0, seed, reed ? 1.5 : 1]);
      grass.v([x + dx, y0, z + dz], n, col, [1, 0, seed, reed ? 1.5 : 1]);
      grass.v([x + dx, y0 + H, z + dz], n, col, [1, 1, seed, reed ? 1.5 : 1]);
      grass.v([x - dx, y0 + H, z - dz], n, col, [0, 1, seed, reed ? 1.5 : 1]);
      grass.q(i0, i0 + 1, i0 + 2, i0 + 3);
    }
    placed++;
  }

  // Stone: shoreline rocks, the stepping stones, the lantern.
  const stone = new Geo();
  const rockTones = [PALETTE.slate, [0.28, 0.27, 0.33], [0.2, 0.2, 0.26], [0.33, 0.32, 0.38]];
  let rocks = 0;
  for (let tries = 0; tries < 900 && rocks < 30; tries++) {
    const x = lerp(-40, 80, rng()), z = lerp(-20, 90, rng());
    const g = terrain.heightAt(x, z);
    if (g < -0.35 || g > 0.6) continue;
    if (Math.hypot(x - TREE[0], z - TREE[1]) < 5) continue;
    const s = 0.35 + Math.pow(rng(), 2) * 1.1;
    icoRock(stone, rng, [x, g - s * 0.25, z], [s * 1.2, s * 0.75, s], rockTones[rocks % 4]);
    if (s > 0.55) colliders.push({ x, z, r: s * 0.9 });
    rocks++;
  }
  const boulders = [[24, 14, 1.6], [58, 34, 2.1], [40, 58, 1.8], [-36, 4, 1.2]];
  for (const [x, z, s] of boulders) {
    const g = terrain.heightAt(x, z);
    icoRock(stone, rng, [x, g - s * 0.2, z], [s * 1.25, s * 0.85, s], rockTones[1]);
    colliders.push({ x, z, r: s * 1.05 });
  }

  // Things you can stand on that aren't terrain: stepping stones, stairs, the bridge.
  const supports = [];
  for (let i = 0; i < 7; i++) {
    const t = (i + 0.5) / 7;
    const x = lerp(-31.5, -41.2, t) + (rng() - 0.5) * 0.6;
    const z = lerp(2.2, -6.4, t) + (rng() - 0.5) * 0.6;
    const r = 0.62 + rng() * 0.18;
    const top = 0.14 + rng() * 0.06;
    prism(stone, [x, -0.7, z], r, r * 0.88, 0.7 + top, 7, rng() * 6, [0.36, 0.36, 0.42]);
    supports.push({ type: "circle", x, z, r: r * 0.9, top });
  }

  // Stone lantern on the islet. Its firebox window can be lit.
  const lx = ISLET[0], lz = ISLET[1];
  const lg = terrain.heightAt(lx, lz);
  const lc = [0.62, 0.64, 0.7];
  prism(stone, [lx, lg - 0.1, lz], 0.6, 0.55, 0.32, 6, 0, lc);
  prism(stone, [lx, lg + 0.22, lz], 0.2, 0.17, 0.95, 8, 0, lc);
  prism(stone, [lx, lg + 1.17, lz], 0.5, 0.45, 0.16, 6, 0, lc);
  const fb = lg + 1.33;
  for (const [ox, oz] of [[0.21, 0.21], [-0.21, 0.21], [0.21, -0.21], [-0.21, -0.21]]) {
    box(stone, [lx + ox, fb + 0.22, lz + oz], [0.12, 0.44, 0.12], 0, lc);
  }
  box(stone, [lx, fb + 0.22, lz], [0.34, 0.4, 0.34], 0, [1.0, 0.72, 0.4], () => [0, 0, 2, 1]);
  prism(stone, [lx, fb + 0.44, lz], 0.82, 0.12, 0.42, 6, Math.PI / 6, lc);
  prism(stone, [lx, fb + 0.86, lz], 0.1, 0.0, 0.22, 6, 0, lc);
  colliders.push({ x: lx, z: lz, r: 0.75 });

  // --- Relief props ------------------------------------------------------------
  const relief = terrain.relief;

  // A stone stair up the islet crag, facing the sandbar.
  {
    const ax = 0.764, az = 0.645;
    const N = 16, tread = 0.45, rIn = 2.5;
    const rOut = rIn + N * tread;
    const g0 = Math.max(terrain.heightAt(lx + ax * rOut, lz + az * rOut), -0.25);
    const gTop = lg;
    const rot = Math.atan2(-ax, az);
    for (let k = 0; k < N; k++) {
      const top = g0 + ((gTop - g0) * (k + 1)) / N;
      const rm = rOut - (k + 0.5) * tread;
      const cx = lx + ax * rm, cz = lz + az * rm;
      box(stone, [cx, (top - 0.9) / 2, cz], [1.8, top + 0.9, tread + 0.02], rot, k % 2 ? [0.4, 0.4, 0.46] : [0.36, 0.36, 0.42]);
      supports.push({ type: "box", x: cx, z: cz, ax, az, hl: tread / 2 + 0.01, hw: 0.9, topA: top, topB: top, minY: -Infinity });
    }
  }

  // A plank footbridge over the creek ravine.
  {
    const c = [20, 36.6];
    const ax = 0.184, az = -0.983;
    const px = -az, pz = ax;
    const hl = 6.8;
    const hA = terrain.heightAt(c[0] - ax * hl, c[1] - az * hl) + 0.12;
    const hB = terrain.heightAt(c[0] + ax * hl, c[1] + az * hl) + 0.12;
    const rot = Math.atan2(-ax, az);
    const planks = 14;
    for (let k = 0; k < planks; k++) {
      const t = (k + 0.5) / planks;
      const a = lerp(-hl, hl, t);
      box(stone, [c[0] + ax * a, lerp(hA, hB, t) - 0.09, c[1] + az * a], [2.2, 0.18, (2 * hl) / planks - 0.05], rot, k % 2 ? [0.36, 0.27, 0.22] : [0.42, 0.31, 0.24]);
    }
    const postAt = (t, side) => {
      const a = lerp(-hl, hl, t);
      return [c[0] + ax * a + px * side * 1.05, lerp(hA, hB, t), c[1] + az * a + pz * side * 1.05];
    };
    for (const side of [-1, 1]) {
      for (let k = 0; k <= 4; k++) {
        const p = postAt(k / 4, side);
        box(stone, [p[0], p[1] + 0.35, p[2]], [0.14, 1.1, 0.14], rot, [0.26, 0.2, 0.17]);
        if (k < 4) {
          const q = postAt((k + 0.5) / 4, side);
          box(stone, [q[0], q[1] + 0.86, q[2]], [0.09, 0.09, (2 * hl) / 4], rot, [0.3, 0.23, 0.19]);
        }
      }
    }
    for (const t of [0.38, 0.62]) {
      const a = lerp(-hl, hl, t);
      const top = lerp(hA, hB, t);
      box(stone, [c[0] + ax * a, (top - 0.7) / 2, c[1] + az * a], [0.3, top + 0.7, 0.3], rot, [0.24, 0.18, 0.16]);
    }
    supports.push({ type: "box", x: c[0], z: c[1], ax, az, hl, hw: 1.1, topA: hA, topB: hB, minY: Math.min(hA, hB) - 1.6 });
  }

  // The waterfall: a stream across the bluff top, then the drop into the plunge pool.
  const falls = new Geo();
  {
    const fd = relief.fallDir;
    const tn = [-fd[1], fd[0]];
    const ribbon = (pts, width, speed) => {
      let along = 0;
      const b0 = falls.n;
      pts.forEach((p, i) => {
        if (i) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
        const w = width(i / (pts.length - 1));
        for (const u of [0, 1]) {
          const off = (u - 0.5) * w;
          falls.v([p[0] + tn[0] * off, p[1], p[2] + tn[1] * off], [fd[0], 0.4, fd[1]], [1, 1, 1], [u, along, speed, 0]);
        }
      });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = b0 + i * 2;
        falls.q(a, a + 1, a + 3, a + 2);
      }
    };
    const S = relief.spring, Lp = relief.lip;
    const chan = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const x = lerp(S[0], Lp[0], t), z = lerp(S[1], Lp[1], t);
      chan.push([x, terrain.heightAt(x, z) + 0.4, z]);
    }
    ribbon(chan, (t) => lerp(0.8, 1.3, t), 1.6);
    const topY = chan[chan.length - 1][1];
    const drop = [];
    let d = 0.2;
    const N = 30;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const y = lerp(topY, 0.06, Math.pow(t, 0.9));
      d = Math.max(d, 0.2 + 2.2 * Math.sqrt(t));
      // keep the water just outside the rock face
      for (let guard = 0; guard < 200; guard++) {
        const x = Lp[0] + fd[0] * d, z = Lp[1] + fd[1] * d;
        if (terrain.heightAt(x, z) < y - 0.7 || (k === N && terrain.heightAt(x, z) < -0.3)) break;
        d += 0.15;
      }
      drop.push([Lp[0] + fd[0] * d, y, Lp[1] + fd[1] * d]);
    }
    drop.unshift(chan[chan.length - 1]);
    ribbon(drop, (t) => lerp(1.8, 4.2, t), 8);
    const B = drop[drop.length - 1];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const ex = Math.cos(a) * 2.4, ez = Math.sin(a) * 2.4;
      const i0 = falls.v([B[0] - ex, B[1] - 0.2, B[2] - ez], [0, 1, 0], [1, 1, 1], [0, 0, -2.5, 0]);
      falls.v([B[0] + ex, B[1] - 0.2, B[2] + ez], [0, 1, 0], [1, 1, 1], [1, 0, -2.5, 0]);
      falls.v([B[0] + ex, B[1] + 2.4, B[2] + ez], [0, 1, 0], [1, 1, 1], [1, 2.6, -2.5, 0]);
      falls.v([B[0] - ex, B[1] + 2.4, B[2] - ez], [0, 1, 0], [1, 1, 1], [0, 2.6, -2.5, 0]);
      falls.q(i0, i0 + 1, i0 + 2, i0 + 3);
    }

    // A cairn at the bluff edge, looking back at the tree.
    const cx = Lp[0] - fd[0] * 2.2 + tn[0] * 4.5, cz = Lp[1] - fd[1] * 2.2 + tn[1] * 4.5;
    let cy = terrain.heightAt(cx, cz) - 0.05;
    let cr = 0.75;
    for (let k = 0; k < 6; k++) {
      const hgt = 0.2 + rng() * 0.08;
      prism(stone, [cx + (rng() - 0.5) * 0.12, cy, cz + (rng() - 0.5) * 0.12], cr, cr * 0.85, hgt, 6, rng() * 6, k % 2 ? [0.5, 0.5, 0.56] : [0.42, 0.42, 0.48]);
      cy += hgt;
      cr *= 0.8;
    }
    colliders.push({ x: cx, z: cz, r: 0.8 });
  }

  // A young tree on the bluff top, boulders fallen at the foot of the cliffs.
  youngTree(terrain, bark, leaves, rng, BLUFF.x - 4, BLUFF.z + 3, 1.2);
  colliders.push({ x: BLUFF.x - 4, z: BLUFF.z + 3, r: 0.45 });
  for (let k = 0, placed = 0; k < 200 && placed < 12; k++) {
    const phi = rng() * Math.PI * 2;
    const re = 1 / Math.hypot(Math.cos(phi) / BLUFF.rx, Math.sin(phi) / BLUFF.rz);
    const r = re + BLUFF.W + 0.5 + rng() * 3;
    const x = BLUFF.x + Math.cos(phi) * r, z = BLUFF.z + Math.sin(phi) * r;
    if (terrain.maskAt(x, z, 0) > 0.05 || Math.hypot(x - relief.pool[0], z - relief.pool[1]) < 9) continue;
    const g = terrain.heightAt(x, z);
    if (g < 0.3) continue;
    const s = 0.7 + rng() * 1.3;
    icoRock(stone, rng, [x, g - s * 0.2, z], [s * 1.2, s * 0.8, s], rockTones[placed % 4]);
    colliders.push({ x, z, r: s * 1.05 });
    placed++;
  }

  // Rust shrubs clinging to ledges on the cliff faces.
  for (let k = 0, placed = 0; k < 400 && placed < 26; k++) {
    const phi = rng() * Math.PI * 2;
    let dphi = Math.abs(phi - PHI_FALL) % (Math.PI * 2);
    if (dphi > Math.PI) dphi = Math.PI * 2 - dphi;
    if (dphi < 0.35) continue;
    const r = ellipseR(phi) + 1 + rng() * (BLUFF.W - 2);
    const x = BLUFF.x + Math.cos(phi) * r, z = BLUFF.z + Math.sin(phi) * r;
    if (terrain.maskAt(x, z, 0) > 0.05) continue;
    const g = terrain.heightAt(x, z);
    const s = 0.6 + rng() * 0.6;
    foliagePad(leaves, [x, g + 0.2, z], [1.0 * s, 0.45 * s, 0.9 * s], rng, { density: 14, size: [0.35, 0.55], dim: 0.8 });
    placed++;
  }

  // Sea stacks standing in the lake.
  for (const [x, z, H] of [[98, 30, 16], [93, 72, 22], [68, 108, 13], [60, -30, 18]]) {
    let y = -6;
    let w = 3.4 + rng() * 1.2;
    while (y < H) {
      const segH = 3 + rng() * 2;
      icoRock(stone, rng, [x + (rng() - 0.5) * 0.9, y + segH * 0.5, z + (rng() - 0.5) * 0.9], [w, segH * 0.75, w * 0.9], rockTones[Math.floor(rng() * 4)]);
      y += segH * 0.8;
      w *= 0.94;
    }
    foliagePad(leaves, [x, y + 0.6, z], [w * 0.75, 0.5, w * 0.65], rng, { density: 10, dim: 0.9 });
  }

  // The standing stone in the shallows of the cove, inscription facing the knoll.
  const stele = new Geo();
  const sx = -8.2, sz = 12.4;
  const sg = terrain.heightAt(sx, sz);
  // box() turns local +z toward (-sin r, cos r); point the carved face at the knoll
  const face = Math.atan2(-(HERO.x - sx), HERO.z - sz);
  box(stele, [sx, Math.min(sg, -0.2) + 1.9, sz], [1.0, 4.8, 0.36], face, PALETTE.cloud);
  colliders.push({ x: sx, z: sz, r: 0.75 });

  // Far shore, hills and the town on the headland.
  const far = new Geo();
  const nearShore = (t) => {
    const taper = smoothstep(0, 0.12, t) * smoothstep(1, 0.85, t);
    const n = vnoise(t * 7, 0.5, 41) * 0.65 + vnoise(t * 19, 0.5, 42) * 0.35;
    return (12 + 22 * n + 10 * Math.exp(-(((t - 0.27) / 0.08) ** 2))) * taper - (1 - taper) * 9;
  };
  const deg = Math.PI / 180;
  const nsA0 = HERO_AZ - 5 * deg, nsA1 = HERO_AZ + 95 * deg;
  band(far, [HERO.x, HERO.z], SHORE_R, nsA0, nsA1, 120, nearShore, [0.15, 0.15, 0.28]);
  band(
    far,
    [HERO.x, HERO.z],
    2000,
    HERO_AZ - 35 * deg,
    HERO_AZ + 150 * deg,
    140,
    (t) => {
      const taper = smoothstep(0, 0.1, t) * smoothstep(1, 0.9, t);
      const n = vnoise(t * 9, 0.5, 51) * 0.6 + vnoise(t * 23, 0.5, 52) * 0.4;
      return (30 + 120 * n * smoothstep(0.05, 0.35, t)) * taper - (1 - taper) * 12;
    },
    [0.2, 0.2, 0.36]
  );
  band(
    far,
    [HERO.x, HERO.z],
    3300,
    HERO_AZ + 110 * deg,
    HERO_AZ + 330 * deg,
    120,
    (t) => {
      const taper = smoothstep(0, 0.1, t) * smoothstep(1, 0.88, t);
      const n = vnoise(t * 8, 0.5, 61) * 0.6 + vnoise(t * 21, 0.5, 62) * 0.4;
      return (30 + 110 * n) * taper - (1 - taper) * 12;
    },
    [0.24, 0.24, 0.4]
  );

  const townT = 0.27;
  const townAz = lerp(nsA0, nsA1, townT);
  const shoreH = (az) => nearShore((az - nsA0) / (nsA1 - nsA0));
  const bCol = [[0.16, 0.16, 0.3], [0.19, 0.18, 0.32], [0.14, 0.15, 0.27]];
  const roofCol = [0.24, 0.18, 0.3];
  const windowCol = [1.0, 0.72, 0.42];
  const placeOnShore = (az, r) => [HERO.x + Math.cos(az) * r, HERO.z + Math.sin(az) * r];
  for (let i = 0; i < 30; i++) {
    const az = townAz + (rng() - 0.5) * 9 * deg;
    const r = SHORE_R + 45 + rng() * 140;
    const [x, z] = placeOnShore(az, r);
    const g = shoreH(az) * 0.96 - 1.5;
    const w = 7 + rng() * 9, d = 7 + rng() * 9, h = 6 + rng() * 10;
    const rot = -az + (rng() - 0.5) * 0.5;
    box(far, [x, g + h / 2, z], [w, h, d], rot, bCol[i % 3]);
    // gable roof as a stretched triangular prism (rotated 3-sided frustum)
    prism(far, [x, g + h, z], Math.max(w, d) * 0.62, 0.0, 3 + rng() * 3, 4, rot + Math.PI / 4, roofCol);
    if (rng() < 0.45) {
      const toHero = [HERO.x - x, HERO.z - z];
      const L = Math.hypot(...toHero);
      const nx = toHero[0] / L, nz = toHero[1] / L;
      const wx = x + nx * (Math.max(w, d) * 0.55), wz = z + nz * (Math.max(w, d) * 0.55);
      box(far, [wx, g + h * (0.35 + rng() * 0.3), wz], [2.4, 2.6, 0.4], Math.atan2(-nx, nz), windowCol, () => [0, 0, 1, 1]);
    }
  }
  {
    const az = townAz + 1.5 * deg;
    const [x, z] = placeOnShore(az, SHORE_R + 110);
    const g = shoreH(az) * 0.96 - 1;
    box(far, [x, g + 19, z], [10, 38, 10], -az, bCol[2]);
    prism(far, [x, g + 38, z], 7.6, 0.0, 24, 4, -az + Math.PI / 4, bCol[1]);
    box(far, [x, g + 63, z], [0.8, 4, 0.8], -az, bCol[1]);
    box(far, [x + 11, g + 12, z + 4], [8, 24, 8], -az, bCol[0]);
    prism(far, [x + 11, g + 24, z + 4], 6, 0.0, 9, 4, -az + Math.PI / 4, roofCol);
  }

  const eyeGround = terrain.heightAt(HERO.x, HERO.z);
  const target = heroLocal(-0.7, baseY + 8.9, 0);
  const sun = v3.norm([target[0] - HERO.x, target[1] - (eyeGround + 1.65), target[2] - HERO.z]);
  const sunDir = v3.norm([sun[0], Math.max(sun[1], 0.12) + 0.03, sun[2]]);
  const windDir = v3.norm([-HERO_R[0] - HERO_F[0] * 0.25, 0, -HERO_R[1] - HERO_F[1] * 0.25]);

  return {
    terrain,
    meshes: {
      bark: bark.arrays(),
      leaves: leaves.arrays(),
      grass: grass.arrays(),
      stone: stone.arrays(),
      stele: stele.arrays(),
      far: far.arrays(),
      falls: falls.arrays(),
    },
    spots,
    canopy,
    colliders,
    supports,
    sunDir,
    windDir,
    poi: {
      stele: { x: sx, z: sz },
      lantern: { x: lx, z: lz },
    },
  };
}
