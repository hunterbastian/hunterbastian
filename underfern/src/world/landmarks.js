// Landmarks — the island's ancient wonders. Dinosaurs only: no ruins, nothing
// made. Three colossal fossils, older and far larger than anything alive —
// a ribcage you can walk through, a great half-buried skull, a buried neck
// arching out of the ground in vertebrae — and three works of the sea and the
// fire: a natural stone arch, a cluster of sea stacks, a basalt causeway.
//
// Placement is a pure function of the terrain and the seed (`planLandmarks`,
// its own seed stream "underfern-landmarks"): each kind tries seeded spots in
// its biomes and takes the first that is valid — dry, gentle and roomy
// ground (the sea stacks: shallow sea off a shore), clear of caves, lakes and
// rivers, the pass valleys, trails and lookouts, and the other landmarks.
// Same seed and terrain, same places.
//
// Rendering: one mesh per site (frustum culled, and hidden past the haze),
// built from lofted tubes, deformed blobs and hexagonal prisms, sharing one
// bone and one stone material — vertex colour for the broad paint, world-space
// grain, strata, lichen and buried-soil staining in the shader, and the
// painterly look (look.js). About 22k triangles for all six (15k on low).
//
// Gameplay: every site is a set of collider circles (r ≤ 4.5 m) that World
// hands to Vegetation, so creatures and the camera bump into bone and stone
// through the existing collider path, and plants keep clear; each footprint
// is also a keep-out for terrain.findSpawnPoint.

import * as THREE from "three";
import { makeRng, rand, randInt, hash } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep } from "../core/math.js";
import { patchLook } from "./look.js";

export const LANDMARK_KINDS = ["ribcage", "skull", "vertebrae", "arch", "stacks", "basalt"];

// r: footprint radius (m); fossil sites use the bone material.
const DEFS = {
  ribcage: { label: "Fossil ribcage", biomes: ["plains", "coast"], r: 27, maxSlope: 0.14, rise: 4, fossil: true },
  skull: { label: "Great skull", biomes: ["plains"], r: 13, maxSlope: 0.18, rise: 4, fossil: true },
  vertebrae: { label: "Bone arches", biomes: ["plains", "forest"], r: 22, maxSlope: 0.16, rise: 4, fossil: true },
  arch: { label: "Stone arch", biomes: ["coast", "plains"], r: 20, maxSlope: 0.3, rise: 6 },
  stacks: { label: "Sea stacks", sea: true, r: 34 },
  basalt: { label: "Basalt columns", biomes: ["coast", "plains"], r: 15, maxSlope: 0.28, rise: 6 },
};

const MIN_SPACING = 170; // metres between any two landmarks
const ROUTE_CLEAR = 28; // metres kept between a footprint and any pass valley, trail or lookout
const COLLIDER_MAX_R = 4.5;

/* --- Placement --------------------------------------------------------------- */

/**
 * Where the landmarks stand on this island. Pure and deterministic.
 * @param {object} terrain a Terrain
 * @param {number} seed
 * @returns {{ id: number, kind: string, label: string, fossil: boolean, x: number, z: number,
 *   y: number, yaw: number, r: number, seed: number }[]}
 */
export function planLandmarks(terrain, seed) {
  const T = terrain;
  const sea = T.seaLevel ?? 0;
  const half = T.half;
  const sites = [];
  // Everything the landmarks must keep clear of, as circles.
  const avoid = [];
  for (const p of T.passes || []) avoid.push({ x: p.x, z: p.z, r: 70 });
  for (const o of T.lookouts || []) avoid.push({ x: o.x, z: o.z, r: 45 });
  for (const rt of T.routes || []) for (let i = 0; i < rt.points.length; i += 2) avoid.push({ x: rt.points[i].x, z: rt.points[i].z, r: rt.width * 0.5 + 6 });
  for (const c of T.caves || []) {
    for (const e of c.entrances) avoid.push({ x: e.x, z: e.z, r: 40 });
    for (const p of c.path) avoid.push({ x: p.x, z: p.z, r: 18 });
  }
  const clearOf = (x, z, r) => {
    for (const a of avoid) if (Math.hypot(x - a.x, z - a.z) < a.r + r + ROUTE_CLEAR * 0.25) return false;
    for (const s of sites) if (Math.hypot(x - s.x, z - s.z) < MIN_SPACING) return false;
    return true;
  };

  for (const kind of LANDMARK_KINDS) {
    const def = DEFS[kind];
    const rng = makeRng(hash("underfern-landmarks", seed >>> 0, kind));
    let found = null;
    for (let t = 0; t < 900 && !found; t++) {
      const x = (rng() * 2 - 1) * (half - 60);
      const z = (rng() * 2 - 1) * (half - 60);
      const yaw = rng() * TAU;
      const s = rng();
      if (!T.inBounds(x, z, def.r + 10)) continue;
      if (def.sea ? !seaSpot(T, x, z, def.r) : !landSpot(T, x, z, def)) continue;
      if (!clearOf(x, z, def.r)) continue;
      found = { x, z, yaw, s };
    }
    if (!found) continue;
    const { x, z, yaw } = found;
    let y;
    if (def.sea) y = sea;
    else {
      // Sit on the lowest ground under the footprint; the shapes sink into it.
      y = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        y = Math.min(y, T.heightAt(x + Math.cos(a) * def.r * 0.6, z + Math.sin(a) * def.r * 0.6));
      }
      y = Math.min(y, T.heightAt(x, z));
    }
    sites.push({
      id: sites.length,
      kind,
      label: def.label,
      fossil: !!def.fossil,
      x,
      z,
      y,
      yaw,
      r: def.r,
      seed: hash("underfern-landmarks", seed >>> 0, kind, "shape"),
    });
  }
  return sites;
}

/** Dry, gentle, roomy ground in the kind's biomes, clear of caves and fresh water. */
function landSpot(T, x, z, def) {
  const sea = T.seaLevel ?? 0;
  if (T.heightAt(x, z) < sea + 2) return false;
  if (!def.biomes.includes(T.biomeAt(x, z))) return false;
  if (T.slopeAt(x, z) > def.maxSlope) return false;
  if (T.nearCave && T.nearCave(x, z)) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (let ring = 0; ring < 2; ring++) {
    const rr = def.r * (ring ? 1 : 0.55);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + ring * 0.26;
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      const h = T.heightAt(px, pz);
      if (h < sea + 0.8) return false;
      if (T.nearCave && T.nearCave(px, pz)) return false;
      const b = T.biomeAt(px, pz);
      if (b === "rock" || b === "lake" || b === "ocean") return false;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  if (hi - lo > def.rise) return false;
  // No lakes or rivers near (the shapes sink a little; banks stay clear).
  if (T.nearestFreshWater && T.nearestFreshWater(x, z, def.r + 30)) return false;
  return true;
}

/** Shallow open sea (not a lake or river) a short swim off a shore. */
function seaSpot(T, x, z, r) {
  const sea = T.seaLevel ?? 0;
  const d = sea - T.heightAt(x, z);
  if (d < 2 || d > 7) return false;
  if (T.biomeAt(x, z) !== "ocean") return false;
  let land = false;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    // The cluster itself stands in water…
    const h = T.heightAt(x + Math.cos(a) * r * 0.5, z + Math.sin(a) * r * 0.5);
    if (h > sea - 1.2) return false;
    // …with a shore in sight.
    for (const dd of [60, 90, 120]) if (T.heightAt(x + Math.cos(a) * dd, z + Math.sin(a) * dd) > sea + 1) land = true;
  }
  if (!land) return false;
  // Not off a river mouth.
  if (T.nearestFreshWater && T.nearestFreshWater(x, z, r + 50)) return false;
  return true;
}

/* --- Geometry ---------------------------------------------------------------- */

const V3 = THREE.Vector3;

/** Accumulates positions, colours and a burial term (0 at the ground … 1 above ~2.5 m), and triangles. */
class Geo {
  constructor() {
    this.p = [];
    this.c = [];
    this.l = [];
    this.i = [];
    this.n = 0;
  }
  vert(p, c) {
    this.p.push(p.x, p.y, p.z);
    this.c.push(c[0], c[1], c[2]);
    this.l.push(clamp(p.y / 2.5, 0, 1));
    return this.n++;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  build(flat = false) {
    let g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute("aLow", new THREE.Float32BufferAttribute(this.l, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    if (flat) g = g.toNonIndexed(); // hard-edged prisms: one normal per face
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function hash3(ix, iy, iz, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440662683) + s) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [-1, 1] (build time only). */
function noise3(x, y, z, s) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const c = (a, b, d) => hash3(ix + a, iy + b, iz + d, s);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

/** Two octaves of noise3 — craggy stone, knobbly bone. */
const crag = (p, f, s) => noise3(p.x * f, p.y * f, p.z * f, s) * 0.65 + noise3(p.x * f * 2.7, p.y * f * 2.7, p.z * f * 2.7, s + 7) * 0.35;

/**
 * Lofted tube through `pts` with per-point radii (parallel-transport frames,
 * so curves don't twist). `o.bump(p, s, a)` → relative radius change, `o.ex`
 * stretches the section along the binormal, `o.caps` closes the ends.
 */
function tube(g, pts, radii, sides, col, o = {}) {
  const n = pts.length;
  const T = [];
  const N = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const t = new V3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    let nn;
    if (i === 0) nn = Math.abs(t.y) < 0.9 ? new V3(0, 1, 0).cross(t) : new V3(1, 0, 0).cross(t);
    else nn = N[i - 1].clone().addScaledVector(t, -N[i - 1].dot(t));
    nn.normalize();
    T.push(t);
    N.push(nn);
    B.push(new V3().crossVectors(t, nn).normalize());
  }
  const start = g.n;
  const p = new V3();
  for (let i = 0; i < n; i++) {
    const s = n > 1 ? i / (n - 1) : 0;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      p.copy(pts[i]).addScaledVector(N[i], ca * radii[i]).addScaledVector(B[i], sa * radii[i] * (o.ex || 1));
      if (o.bump) p.addScaledVector(N[i], ca * radii[i] * o.bump(p, s, a)).addScaledVector(B[i], sa * radii[i] * o.bump(p, s, a + 1.7));
      g.vert(p, col(s, a, p));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = start + i * sides + j;
      const b = start + i * sides + ((j + 1) % sides);
      g.tri(a, b, a + sides);
      g.tri(b, b + sides, a + sides);
    }
  }
  if (o.caps) {
    for (const [i, end] of [[0, false], [n - 1, true]]) {
      const c = g.vert(pts[i].clone().addScaledVector(T[i], (end ? 1 : -1) * radii[i] * 0.45), col(end ? 1 : 0, 0, pts[i]));
      const r0 = start + i * sides;
      for (let j = 0; j < sides; j++) {
        const a = r0 + j;
        const b = r0 + ((j + 1) % sides);
        if (end) g.tri(c, a, b);
        else g.tri(c, b, a);
      }
    }
  }
}

/**
 * A deformed blob (lat-long sphere) at `c` with radii (rx, ry, rz), rotated by
 * `q`; deform(dir) → radius scale; warp(p) reshapes the local point in place.
 */
function blob(g, c, rx, ry, rz, segU, segV, col, deform = null, q = null, warp = null) {
  const start = g.n;
  const d = new V3();
  const p = new V3();
  for (let iv = 0; iv <= segV; iv++) {
    const th = (iv / segV) * Math.PI;
    for (let iu = 0; iu <= segU; iu++) {
      const ph = (iu / segU) * TAU;
      d.set(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      const k = deform ? deform(d) : 1;
      p.set(d.x * rx * k, d.y * ry * k, d.z * rz * k);
      if (warp) warp(p);
      if (q) p.applyQuaternion(q);
      p.add(c);
      g.vert(p, col(d, p));
    }
  }
  const W = segU + 1;
  for (let iv = 0; iv < segV; iv++) {
    for (let iu = 0; iu < segU; iu++) {
      const a = start + iv * W + iu;
      g.tri(a, a + 1, a + W);
      g.tri(a + 1, a + W + 1, a + W);
    }
  }
}

/* --- Palettes (linear-ish vertex colours; the shader adds the grain) --- */

const BONE = [0.53, 0.46, 0.34];
const BONE_DARK = [0.3, 0.25, 0.18];
const BASALT = [0.075, 0.08, 0.09];
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Fossil bone: ivory, stained toward the ends and the ground, with mottling. */
function boneCol(seed) {
  return (s, a, p) => {
    const m = crag(p, 0.35, seed) * 0.5 + 0.5;
    const stain = smoothstep(0.2, 0.9, m) * 0.45 + (1 - smoothstep(0, 2.5, p.y)) * 0.35;
    return mixc(BONE, BONE_DARK, clamp(stain, 0, 0.85));
  };
}

/* --- Builders (local space: origin on the ground at the site's centre) --- */

/** A colossal ribcage, upright and buried to the belly: a spine arching overhead, ribs down to the ground. */
function buildRibcage(rng, detail) {
  const g = new Geo();
  const col = boneCol(randInt(rng, 1, 1e6));
  const L = rand(rng, 40, 48);
  const H = rand(rng, 12, 14.5);
  const W = rand(rng, 9, 11);
  const spineAt = (x) => {
    const t = clamp((x + L / 2) / L, 0, 1);
    return new V3(x, H * Math.pow(Math.sin(Math.PI * t), 0.55) - 2.5, Math.sin(t * 5.3) * 0.6);
  };
  const sides = detail > 0.7 ? 8 : 6;
  // Vertebrae: centrum + a tall neural spine, every ~2 m along the arch.
  const nV = Math.round(L / 2);
  for (let k = 1; k < nV; k++) {
    const x = -L / 2 + (k / nV) * L;
    const c = spineAt(x);
    if (c.y < -0.6) continue;
    const t = spineAt(x + 0.5).sub(spineAt(x - 0.5)).normalize();
    const rr = 0.85 * (1 - 0.35 * Math.abs(x / L) * 2);
    tube(g, [c.clone().addScaledVector(t, -0.7), c.clone(), c.clone().addScaledVector(t, 0.7)], [rr * 0.9, rr, rr * 0.9], sides, col, { caps: true });
    const up = new V3(-t.y, t.x, 0).normalize();
    const len = rand(rng, 1.6, 2.8) * (1 - 0.4 * Math.abs(x / L) * 2);
    tube(g, [c.clone().addScaledVector(up, rr * 0.6), c.clone().addScaledVector(up, rr + len * 0.5).addScaledVector(t, -0.3), c.clone().addScaledVector(up, rr + len).addScaledVector(t, -0.7)], [0.42, 0.3, 0.12], 5, col, { caps: true });
  }
  // Ribs: pairs from the spine down to the ground, bowing out; some broken off.
  const nR = 11;
  for (let k = 0; k < nR; k++) {
    const x0 = -L * 0.3 + (k / (nR - 1)) * L * 0.62;
    const span = W * (0.7 + 0.3 * Math.sin(Math.PI * (k + 0.5) / nR));
    for (const side of [-1, 1]) {
      const top = spineAt(x0);
      const broken = rng() < 0.22 ? rand(rng, 0.5, 0.8) : 1;
      const pts = [];
      const radii = [];
      const segs = detail > 0.7 ? 10 : 7;
      for (let i = 0; i <= segs; i++) {
        const s = (i / segs) * broken;
        const out = span * Math.pow(Math.sin(s * Math.PI * 0.62), 0.8) * 1.12;
        const y = lerp(top.y, -1.4, Math.pow(s, 1.35)) + Math.sin(s * Math.PI) * 1.2;
        pts.push(new V3(x0 - s * 2.2 + Math.sin(s * 4 + k) * 0.2, y, top.z + side * out));
        radii.push(lerp(0.62, 0.36, s) * (1 + 0.15 * Math.sin(s * 9 + k)));
      }
      tube(g, pts, radii, sides, col, { caps: true, ex: 1.35 });
    }
  }
  // A pelvis at the tail end and a loose thigh bone in the grass.
  const hip = spineAt(L * 0.36);
  for (const side of [-1, 1]) {
    blob(g, hip.clone().add(new V3(0, -1.2, side * 2.4)), 3.2, 2.2, 0.9, 12, 8, (d, p) => col(0, 0, p), (d) => 1 + 0.12 * Math.sin(d.x * 6) * d.y);
  }
  const fx = rand(rng, -6, 6);
  const fz = (rng() < 0.5 ? -1 : 1) * (W + rand(rng, 5, 9));
  const femur = [new V3(fx - 4, 0.3, fz), new V3(fx, 0.55, fz + 0.6), new V3(fx + 4, 0.25, fz + 0.2)];
  tube(g, femur, [0.75, 0.55, 0.75], sides, col);
  blob(g, femur[0], 1.25, 1.0, 1.1, 10, 7, (d, p) => col(0, 0, p));
  blob(g, femur[2], 1.1, 0.95, 1.25, 10, 7, (d, p) => col(0, 0, p));
  // Colliders: rib feet, the spine's buried ends, pelvis, femur.
  const cols = [];
  for (let k = 0; k < nR; k++) {
    const x0 = -L * 0.3 + (k / (nR - 1)) * L * 0.62;
    const span = W * (0.7 + 0.3 * Math.sin(Math.PI * (k + 0.5) / nR)) * 1.12 * Math.pow(Math.sin(Math.PI * 0.62), 0.8);
    for (const side of [-1, 1]) cols.push({ x: x0 - 2.2, z: spineAt(x0).z + side * span, r: 0.9, height: 3 });
  }
  cols.push({ x: -L / 2 + 2, z: 0, r: 2.2, height: 2 }, { x: L / 2 - 2, z: 0, r: 2.2, height: 2 });
  cols.push({ x: hip.x, z: 2.4, r: 2.6, height: 3 }, { x: hip.x, z: -2.4, r: 2.6, height: 3 });
  cols.push({ x: fx, z: fz, r: 2.6, height: 1.5 });
  return { geo: g.build(), cols };
}

/**
 * A great theropod skull, half-buried and rolled onto one cheek: a long,
 * tall, narrow head (snout tapering forward, a deep cheek, horned brows and a
 * knobbly nasal ridge), dark orbits and fenestrae, a row of teeth above the
 * ground, the lower jaw lying apart.
 */
function buildSkull(rng, detail) {
  const g = new Geo();
  const col = boneCol(randInt(rng, 1, 1e6));
  const Ls = rand(rng, 7.5, 9); // half-length
  const RY = 3.6; // half-height
  const RZ = 2.3; // half-width
  const CY = 2.3; // centre above the ground: the jaw line shows
  const roll = rand(rng, 0.22, 0.34) * (rng() < 0.5 ? -1 : 1);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, 0, rand(rng, -0.14, -0.05)));
  const segU = detail > 0.7 ? 44 : 30;
  const segV = detail > 0.7 ? 24 : 16;
  // Sockets (local unit-sphere directions): orbit, antorbital fenestra, nostril, temporal opening.
  const holes = [
    { d: new V3(-0.25, 0.42, 0.86), r: 0.3, depth: 0.22 },
    { d: new V3(0.3, 0.2, 0.93), r: 0.32, depth: 0.18 },
    { d: new V3(0.82, 0.25, 0.5), r: 0.14, depth: 0.12 },
    { d: new V3(-0.62, 0.55, 0.55), r: 0.24, depth: 0.15 },
  ];
  for (const h of [...holes]) holes.push({ d: new V3(h.d.x, h.d.y, -h.d.z), r: h.r, depth: h.depth });
  for (const h of holes) h.d.normalize();
  const depthAt = (d) => {
    let k = 0;
    for (const h of holes) k = Math.max(k, (1 - smoothstep(h.r * 0.55, h.r, d.distanceTo(h.d))) * h.depth);
    return k;
  };
  // A wedge: tall at the back, the snout's roof sloping down to a low tip
  // over a nearly straight jaw line; narrower toward the front.
  const warp = (p) => {
    const f = smoothstep(-0.35 * Ls, Ls, p.x);
    p.y *= p.y > 0 ? 1 - 0.58 * f : 1 - 0.15 * f;
    p.z *= 1 - 0.42 * f;
    return p;
  };
  const C = new V3(0, CY, 0);
  blob(
    g, C, Ls, RY, RZ, segU, segV,
    (d, p) => {
      const sock = depthAt(d) > 0.02 ? smoothstep(0.02, 0.14, depthAt(d)) : 0;
      return mixc(col(0, 0, p), [0.06, 0.05, 0.045], sock * 0.95);
    },
    (d) => {
      // A deep cheek at the back, a flat-ish palate.
      let k = 1 + 0.1 * smoothstep(0.2, 0.9, d.y) * (1 - smoothstep(-0.2, 0.6, d.x));
      if (d.y < -0.2) k *= 1 - 0.12 * smoothstep(-0.2, -0.9, d.y);
      // Horned brows over the orbits, a knobbly ridge down the snout.
      for (const s of [-1, 1]) k += 0.16 * (1 - smoothstep(0, 0.28, Math.hypot(d.x + 0.3, d.y - 0.78, d.z - s * 0.5)));
      k *= 1 + 0.045 * Math.sin(d.x * 26) * smoothstep(0.78, 0.97, d.y);
      k *= 1 + 0.03 * Math.sin(d.x * 21) * Math.sin(d.z * 17);
      return k * (1 - depthAt(d));
    },
    q,
    warp,
  );
  // Teeth along the upper jaw's edge: blunted cones pointing down.
  const at = (v) => warp(v).applyQuaternion(q).add(C);
  for (const side of [-1, 1]) {
    for (let k = 0; k < 9; k++) {
      const t = k / 8;
      const x = lerp(-Ls * 0.25, Ls * 0.82, t);
      const local = new V3(x, -RY * 0.42, side * RZ * 0.86 * Math.sqrt(Math.max(0, 1 - (x / Ls) * (x / Ls))));
      const base = at(local.clone());
      const len = rand(rng, 0.9, 1.7) * (1 - 0.3 * t);
      const tip = at(local.clone().add(new V3(rand(rng, -0.1, 0.25), -len, -side * 0.15)));
      tube(g, [base, base.clone().lerp(tip, 0.5), tip], [0.28, 0.18, 0.03], 5, (s) => mixc([0.64, 0.6, 0.5], BONE_DARK, 0.25 + 0.3 * s));
    }
  }
  // The lower jaw lies apart on the side the skull rolled away from, half in the ground.
  const jy = rand(rng, -0.4, 0.2);
  const jz = rand(rng, 4.5, 6) * -Math.sign(roll);
  const jaw = [new V3(-Ls * 0.7, jy + 0.6, jz), new V3(0, jy + 0.9, jz * 1.08), new V3(Ls * 0.8, jy + 0.4, jz * 1.2)];
  tube(g, jaw, [1.15, 0.95, 0.55], detail > 0.7 ? 9 : 7, col, { caps: true, ex: 0.55 });
  const cols = [];
  for (let k = -2; k <= 2; k++) {
    const p = new V3(k * Ls * 0.38, 0, 0).applyQuaternion(q);
    cols.push({ x: p.x, z: p.z, r: k === 2 ? 2.2 : 3.2, height: 5.5 });
  }
  cols.push({ x: jaw[1].x, z: jaw[1].z, r: 1.6, height: 1.5 });
  return { geo: g.build(), cols };
}

/** A buried giant's neck arching out of the ground three times, vertebra by vertebra. */
function buildVertebrae(rng, detail) {
  const g = new Geo();
  const col = boneCol(randInt(rng, 1, 1e6));
  const arcs = [
    { x: -12, R: rand(rng, 7.5, 9) },
    { x: 4, R: rand(rng, 6, 7) },
    { x: 16, R: rand(rng, 4.2, 5) },
  ];
  const cols = [];
  let size = 1.15;
  const sides = detail > 0.7 ? 8 : 6;
  for (const [ai, A] of arcs.entries()) {
    const n = Math.round(A.R * 2.2);
    const lean = rand(rng, -0.12, 0.12);
    const drop = 1.2;
    for (let k = 0; k <= n; k++) {
      const th = Math.PI * (k / n);
      const c = new V3(A.x - Math.cos(th) * A.R, Math.sin(th) * (A.R + 1.5) - drop, Math.sin(th) * A.R * lean);
      if (c.y < -0.8) continue;
      const t = new V3(Math.sin(th), Math.cos(th), 0).normalize();
      const out = new V3(-Math.cos(th), Math.sin(th), 0).normalize();
      const s = size * (1 - 0.18 * ai) * (1 - 0.15 * (k / n));
      tube(g, [c.clone().addScaledVector(t, -0.55 * s), c, c.clone().addScaledVector(t, 0.55 * s)], [0.72 * s, 0.82 * s, 0.72 * s], sides, col, { caps: true });
      // Neural spine radiating outward, and stubby side processes.
      tube(g, [c.clone().addScaledVector(out, 0.6 * s), c.clone().addScaledVector(out, 1.5 * s).addScaledVector(t, -0.2), c.clone().addScaledVector(out, 2.3 * s).addScaledVector(t, -0.45)], [0.34 * s, 0.24 * s, 0.08 * s], 5, col, { caps: true });
      for (const side of [-1, 1]) {
        tube(g, [c.clone().add(new V3(0, 0, side * 0.5 * s)), c.clone().add(new V3(0, -0.2 * s, side * 1.5 * s))], [0.24 * s, 0.1 * s], 4, col, { caps: true });
      }
    }
    for (const side of [-1, 1]) cols.push({ x: A.x + side * A.R, z: 0, r: Math.min(COLLIDER_MAX_R, 1.6 * size), height: 2.5 });
    size *= 0.86;
  }
  return { geo: g.build(), cols };
}

const SEA_STONE = [0.55, 0.44, 0.31];
const SEA_STONE_GREY = [0.43, 0.41, 0.38];
const BED = 2.4; // sandstone bed thickness on land (m)
const fract = (v) => ((v % 1) + 1) % 1;

/** Arch paint: the stacks' bedded sandstone (ochre and grey beds, mottled), damp where it meets the soil. */
function stoneCol(seed) {
  return (s, a, p) => {
    const bi = Math.floor((p.y + 0.8 * noise3(p.x * 0.05, 0, p.z * 0.05, seed)) / BED);
    const c = mixc(SEA_STONE, SEA_STONE_GREY, hash3(bi, 0, 0, seed) * 0.8);
    const shade = 0.84 + 0.26 * hash3(bi, 1, 0, seed) + 0.12 * crag(p, 0.3, seed + 5);
    return mixc([c[0] * shade, c[1] * shade, c[2] * shade], [0.16, 0.14, 0.11], (1 - smoothstep(0.2, 1.6, p.y)) * 0.5);
  };
}

/** Sea-stack paint: beds of ochre and grey sandstone, dark fissures, pale crowns, a dark weedy waterline. */
function stackCol(seed, y, Hs, f, fis, th, bedI) {
  const h = hash3(bedI, 0, 0, seed);
  let c = mixc(SEA_STONE, SEA_STONE_GREY, h * 0.8);
  const shade = 0.86 + 0.24 * hash3(bedI, 1, 0, seed) + 0.1 * smoothstep(0.6, 0.85, f);
  c = [c[0] * shade, c[1] * shade, c[2] * shade];
  c = mixc(c, [0.16, 0.14, 0.12], clamp(fis * 2.5, 0, 0.7));
  // Streaks of droppings run down from the crown.
  const streak = 0.5 + 0.5 * Math.sin(th * 7 + Math.sin(th * 3) * 2);
  c = mixc(c, [0.74, 0.72, 0.66], smoothstep(Hs * 0.72, Hs, y) * (0.35 + 0.5 * streak));
  // Wet stone and weed at the waterline (the sea sits at y = 0).
  c = mixc(c, [0.13, 0.16, 0.1], (1 - smoothstep(0.4, 1.6, y)) * smoothstep(-1.5, -0.2, y) * 0.75);
  return mixc(c, [0.08, 0.09, 0.08], (1 - smoothstep(-1.5, 0.5, y)) * 0.6);
}

/** A natural arch: two heavy legs and a craggy span. */
function buildArch(rng, detail) {
  const g = new Geo();
  const seed = randInt(rng, 1, 1e6);
  const col = stoneCol(seed);
  const span = rand(rng, 27, 33);
  const H = rand(rng, 15, 19);
  const pts = [];
  const radii = [];
  // Rings close enough (≈ 1 m along the legs) for the beds' ledges to show.
  const n = detail > 0.7 ? 40 : 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lerp(-span / 2, span / 2, t);
    const y = H * (1 - Math.pow(2 * t - 1, 2)) * 0.95 - 3;
    pts.push(new V3(x, y + Math.sin(t * 7) * 0.4, Math.sin(t * 3.1) * 1.4));
    radii.push(lerp(4.4, 2.3, Math.sin(Math.PI * t)) * (1 + 0.1 * Math.sin(t * 11)));
  }
  // Crags, and a harder lip at the top of each bed.
  const bump = (p) => 0.3 * crag(p, 0.12, seed) + 0.06 * smoothstep(0.62, 0.86, fract(p.y / BED)) * (1 - smoothstep(0.86, 0.98, fract(p.y / BED)));
  tube(g, pts, radii, detail > 0.7 ? 16 : 11, col, { ex: 1.45, caps: true, bump });
  // Rubble at the feet.
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const c = new V3(side * (span / 2 + rand(rng, -1, 4)), rand(rng, -1, 0.5), rand(rng, -6, 6));
      const r = rand(rng, 1.5, 3.2);
      blob(g, c, r * 1.2, r * 0.75, r, 10, 7, (d, p) => col(0, 0, p), (d) => 1 + 0.25 * crag(d.clone().multiplyScalar(2), 1, seed + k));
    }
  }
  const cols = [];
  for (const side of [-1, 1]) {
    cols.push({ x: side * (span / 2 - 1), z: 0, r: COLLIDER_MAX_R, height: H });
    cols.push({ x: side * (span / 2 + 2), z: side * 3, r: 3, height: 3 });
  }
  return { geo: g.build(), cols };
}

/**
 * Sea stacks: tall, leaning pillars of bedded sandstone standing in the
 * shallows. Each bed weathers back under a harder lip, so the flanks step in
 * ledges (lichen greens their tops); vertical fissures and crags break the
 * outline; the crowns are pale with old droppings, the feet dark and weedy.
 */
function buildStacks(rng, detail) {
  const g = new Geo();
  const seed = randInt(rng, 1, 1e6);
  const count = randInt(rng, 3, 5);
  const sides = detail > 0.7 ? 16 : 11;
  const step = detail > 0.7 ? 0.6 : 1.05; // ring spacing (m) — fine enough for the ledges
  const bed = rand(rng, 2.2, 2.9); // bed thickness (m)
  const cols = [];
  const p = new V3();
  const q = new V3();
  for (let k = 0; k < count; k++) {
    const a = rng() * TAU;
    const d = k === 0 ? 0 : rand(rng, 12, 26);
    const cx = Math.cos(a) * d;
    const cz = Math.sin(a) * d;
    const Hs = k === 0 ? rand(rng, 26, 36) : rand(rng, 12, 24);
    const R = k === 0 ? rand(rng, 5, 6.5) : rand(rng, 3, 5);
    const lx = rand(rng, -0.12, 0.12);
    const lz = rand(rng, -0.12, 0.12);
    const ks = seed + k * 101;
    const rings = Math.ceil((Hs + 6) / step);
    const start = g.n;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const y = lerp(-6, Hs, t);
      // Taper, and a rounded crown.
      const crown = t > 0.9 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.9) / 0.1, 2) * 0.75)) : 1;
      const Rt = R * (1.22 - 0.42 * t) * (1 + 0.1 * Math.sin(t * 11 + k)) * crown;
      for (let j = 0; j < sides; j++) {
        const th = (j / sides) * TAU;
        const ca = Math.cos(th);
        const sa = Math.sin(th);
        q.set(cx + ca * R, y, cz + sa * R);
        // Beds, uneven in thickness and dipping a little: a lip at the top of
        // each (some stand well out, some barely), the softer rock under it
        // undercut.
        const yb = y + 1.5 * noise3(0, y * 0.11, k * 3.1, ks + 9) + noise3(ca * 1.3, 0, sa * 1.3, ks) * 0.7;
        const bi = Math.floor(yb / bed);
        const f = yb / bed - bi;
        // A lip runs only part way round; elsewhere the bed has fallen away.
        const lipA = (0.02 + 0.07 * hash3(bi, k, 0, ks)) * smoothstep(-0.3, 0.5, noise3(ca * 1.6, bi * 0.9, sa * 1.6, ks + 13));
        // Jointed, blocky in plan (a few broad lobes that turn slowly with height).
        const lobe = 1 + 0.12 * Math.cos(3 * th + k + y * 0.02) + 0.07 * Math.cos(5 * th + 2 * k - y * 0.03);
        const lip = smoothstep(0.62, 0.86, f) * (1 - smoothstep(0.86, 0.98, f));
        const under = smoothstep(0.0, 0.2, f) * (1 - smoothstep(0.2, 0.5, f));
        // Fissures: narrow vertical grooves at a few angles; crags everywhere.
        const fis = Math.pow(Math.max(0, noise3(ca * 2.2, y * 0.05, sa * 2.2, ks + 5)), 3);
        const r = Rt * lobe * (1 + 0.28 * crag(q, 0.16, ks) + lipA * (lip - 0.4 * under) * (1 - 0.6 * (1 - crown)) - 0.4 * fis);
        p.set(cx + lx * y + ca * r, y, cz + lz * y + sa * r);
        g.vert(p, stackCol(ks, y, Hs, f, fis, th, bi));
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < sides; j++) {
        const a0 = start + i * sides + j;
        const b0 = start + i * sides + ((j + 1) % sides);
        g.tri(a0, b0, a0 + sides);
        g.tri(b0, b0 + sides, a0 + sides);
      }
    }
    // A low dome closes the crown.
    const top = g.vert(p.set(cx + lx * Hs, Hs + R * 0.12, cz + lz * Hs), stackCol(ks, Hs + 1, Hs, 0.5, 0, 0, Math.floor(Hs / bed)));
    const r0 = start + rings * sides;
    for (let j = 0; j < sides; j++) g.tri(top, r0 + ((j + 1) % sides), r0 + j);
    for (let c = 0; c < Math.ceil(R / 3.5); c++) {
      const aa = (c / Math.ceil(R / 3.5)) * TAU;
      const off = Math.ceil(R / 3.5) > 1 ? R * 0.45 : 0;
      cols.push({ x: cx + Math.cos(aa) * off, z: cz + Math.sin(aa) * off, r: Math.min(COLLIDER_MAX_R, R * 0.8), height: Hs });
    }
  }
  return { geo: g.build(), cols };
}

/** A basalt causeway: hexagonal columns stepping up out of the ground. */
function buildBasalt(rng, detail) {
  const g = new Geo();
  const seed = randInt(rng, 1, 1e6);
  const rC = 0.95; // column circumradius
  const dx = rC * Math.sqrt(3);
  const dz = rC * 1.5;
  const R = 13;
  const cols = [];
  const corners = [];
  for (let k = 0; k < 6; k++) corners.push([Math.cos((k / 6) * TAU + Math.PI / 6) * rC * 0.97, Math.sin((k / 6) * TAU + Math.PI / 6) * rC * 0.97]);
  const p = new V3();
  for (let iz = -10; iz <= 10; iz++) {
    for (let ix = -10; ix <= 10; ix++) {
      const x = ix * dx + (iz & 1 ? dx / 2 : 0);
      const z = iz * dz;
      const r = Math.hypot(x, z * 1.3);
      const edge = 1 - smoothstep(R * 0.55, R, r + noise3(x * 0.2, 0, z * 0.2, seed) * 3);
      if (edge <= 0.02) continue;
      if (detail < 0.7 && (ix + iz) % 3 === 0 && edge < 0.4) continue;
      // Stepped heights: a broad mound, quantised into irregular treads.
      const mound = edge * (4 + 7 * (0.5 + 0.5 * noise3(x * 0.09, 0, z * 0.09, seed + 5)));
      const top = Math.round(mound / 0.7) * 0.7 + noise3(x * 0.7, 0, z * 0.7, seed + 9) * 0.25 - 0.4;
      if (top < 0.2) continue;
      const shade = 0.85 + 0.3 * hash3(ix, 0, iz, seed);
      const c = [BASALT[0] * shade, BASALT[1] * shade, BASALT[2] * shade];
      const cTop = mixc(c, [0.2, 0.21, 0.2], 0.35);
      const b = g.n;
      for (const [cx2, cz2] of corners) {
        g.vert(p.set(x + cx2, -1.5, z + cz2), c);
        g.vert(p.set(x + cx2, top, z + cz2), cTop);
      }
      for (let k = 0; k < 6; k++) {
        const a0 = b + k * 2;
        const a1 = b + ((k + 1) % 6) * 2;
        g.tri(a0, a0 + 1, a1);
        g.tri(a1, a0 + 1, a1 + 1);
      }
      // Top: a fan over the six upper corners.
      for (let k = 1; k < 5; k++) g.tri(b + 1, b + (k + 1) * 2 + 1, b + k * 2 + 1);
    }
  }
  // Colliders over the cluster (the treads are climbable steps visually, solid in play).
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * TAU;
    cols.push({ x: Math.cos(a) * R * 0.5, z: (Math.sin(a) * R * 0.5) / 1.3, r: 3.6, height: 6 });
  }
  cols.push({ x: 0, z: 0, r: 4.2, height: 8 });
  return { geo: g.build(true), cols };
}

const BUILDERS = { ribcage: buildRibcage, skull: buildSkull, vertebrae: buildVertebrae, arch: buildArch, stacks: buildStacks, basalt: buildBasalt };

/* --- Materials ---------------------------------------------------------------- */

const LM_VERT_PARS = /* glsl */ `
attribute float aLow;
varying float vLmLow;
varying vec3 vLmPos;
varying vec3 vLmNrm;
`;
const LM_VERT_MAIN = /* glsl */ `
vLmLow = aLow;
vLmPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vLmNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;
const LM_FRAG_PARS = /* glsl */ `
varying float vLmLow;
varying vec3 vLmPos;
varying vec3 vLmNrm;
`;
// After <color_fragment>: world-space grain (triplanar value noise), lichen on
// what faces up, soil staining where it meets the ground; bone gets fine
// cracks, stone soft strata.
const LM_FRAG_COLOR = /* glsl */ `
{
  vec3 lmN = normalize( vLmNrm );
  vec3 lmW = pow( abs( lmN ), vec3( 4.0 ) );
  lmW /= lmW.x + lmW.y + lmW.z;
  vec3 lmP = vLmPos;
  float lmG = lookNoise( lmP.zy * 2.1 ) * lmW.x + lookNoise( lmP.xz * 2.1 ) * lmW.y + lookNoise( lmP.xy * 2.1 ) * lmW.z;
  float lmM = lookNoise( lmP.zy * 0.35 + 3.1 ) * lmW.x + lookNoise( lmP.xz * 0.35 + 3.1 ) * lmW.y + lookNoise( lmP.xy * 0.35 + 3.1 ) * lmW.z;
  float lmFade = 1.0 - smoothstep( 40.0, 160.0, length( vViewPosition ) );
  diffuseColor.rgb *= mix( 1.0, 0.82 + 0.34 * lmG, lmFade );
  #ifdef LM_STONE
    float lmBand = sin( lmP.y * 2.3 + lmM * 4.0 ) * 0.5 + 0.5;
    diffuseColor.rgb *= 0.9 + 0.16 * lmBand;
  #else
    float lmCrack = smoothstep( 0.46, 0.5, abs( lookNoise( lmP.xz * 0.9 + lmP.y * 0.7 ) - 0.5 ) * -1.0 + 0.5 );
    diffuseColor.rgb *= 1.0 - 0.25 * lmCrack * lmFade;
  #endif
  float lmUp = smoothstep( 0.45, 0.85, lmN.y + ( lmM - 0.5 ) * 0.6 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.36, 0.4, 0.2 ) * ( 0.75 + 0.5 * lmG ), lmUp * LM_LICHEN );
  diffuseColor.rgb *= mix( 0.55, 1.0, vLmLow );
}
`;

function makeMaterial(stone) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: stone ? 0.92 : 0.78, metalness: 0 });
  m.name = stone ? "LandmarkStone" : "LandmarkBone";
  m.defines = stone ? { LM_STONE: "", LM_LICHEN: "0.5" } : { LM_LICHEN: "0.28" };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${LM_VERT_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${LM_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${LM_FRAG_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${LM_FRAG_COLOR}`);
    // A soft rim (more on bone), so the old giants and the stacks catch a low
    // sun at their edges instead of standing as flat cool silhouettes.
    patchLook(shader, { wrap: 0.5, rim: stone ? 0.3 : 0.45, fill: 0.7 });
  };
  m.customProgramCacheKey = () => (stone ? "underfern-landmark-stone" : "underfern-landmark-bone");
  return m;
}

/* --- Landmarks ------------------------------------------------------------------ */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Landmarks {
  /**
   * Plan and build the island's landmarks (deterministic for a seed).
   * @param {object} terrain Terrain
   * @param {{ seed?: number, shadows?: boolean, detail?: number }} [opts] detail 0..1 (low quality ~0.5)
   */
  constructor(terrain, { seed = 1, shadows = false, detail = 1 } = {}) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.terrain = terrain;
    /** The planned sites (see planLandmarks), each with `colliders` in world metres. */
    this.sites = planLandmarks(terrain, seed);
    /** Every collider circle of every site: [{ x, z, r, height, kind: "landmark" }]. */
    this.colliders = [];
    this.group = new THREE.Group();
    this.group.name = "landmarks";
    this._bone = makeMaterial(false);
    this._stone = makeMaterial(true);
    this.meshes = [];
    let tris = 0;
    for (const s of this.sites) {
      const rng = makeRng(s.seed);
      const { geo, cols } = BUILDERS[s.kind](rng, detail);
      const mesh = new THREE.Mesh(geo, s.fossil ? this._bone : this._stone);
      mesh.name = `landmark-${s.kind}`;
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.yaw;
      mesh.castShadow = !!shadows;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.meshes.push(mesh);
      tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      // Colliders into world space.
      _q.setFromAxisAngle(UP, s.yaw);
      s.colliders = cols.map((c) => {
        _v.set(c.x, 0, c.z).applyQuaternion(_q);
        return { x: s.x + _v.x, z: s.z + _v.z, r: Math.min(COLLIDER_MAX_R, c.r), height: c.height, kind: "landmark" };
      });
      this.colliders.push(...s.colliders);
      terrain.addKeepOut?.(s.x, s.z, s.r);
    }
    this.stats = { sites: this.sites.length, triangles: tris, genMs: (typeof performance !== "undefined" ? performance.now() : 0) - t0 };
  }

  /**
   * Hide sites lost in the haze (cheaper than drawing fog-coloured bones).
   * @param {THREE.Camera} camera
   * @param {number} fogFar metres
   */
  update(camera, fogFar = Infinity) {
    if (!camera) return;
    const p = camera.position;
    for (let i = 0; i < this.meshes.length; i++) {
      const s = this.sites[i];
      // Altitude thins the haze (look.js), so tall landmarks stay a while longer.
      this.meshes[i].visible = Math.hypot(s.x - p.x, s.z - p.z) - s.r < fogFar * 1.25 + 60;
    }
  }

  /** The landmark whose footprint covers (x, z), or null. */
  siteAt(x, z) {
    for (const s of this.sites) if (Math.hypot(x - s.x, z - s.z) < s.r) return s;
    return null;
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this._bone.dispose();
    this._stone.dispose();
    this.group.removeFromParent();
  }
}
