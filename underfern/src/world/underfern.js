// The Underfern — the island's namesake: one colossal golden tree fern, older
// than anything alive or buried here, standing in a forest valley as near the
// island's heart as the ground allows. In the spirit of Elden Ring's Erdtree:
// so tall that its crown stands above the haze from every shore, and it gives
// off a light of its own.
//
//   - A trunk some 140 m tall, braided from several trunks twisting round one
//     another; between them, where they part, a golden light shows from the
//     core. Pale ash-gold bark with glowing veins; buttress roots arch out over
//     the ground, a few high enough to walk beneath.
//   - A crown of golden fronds 90–110 m long: the young ones climb, the old
//     ones droop. Each is a rachis lined with pinnae, their serrated outline cut
//     in the shader, nodding slowly in the wind. They glow softly by day (more
//     with the sun behind them) and blaze at night; a few fiddleheads, still
//     curled, crown the top.
//   - A golden halo round the crown, and golden leaves drifting down from it.
//   - The haze takes it a third as fast as anything else, so it reads as a
//     glowing silhouette across the island.
//
// Placement is a pure function of the terrain, the seed and the other
// landmarks (its own seed stream "underfern-tree"); it is planned after them,
// so they keep their places. Landmarks owns it: its site joins theirs (map,
// vegetation clearing, spawn keep-out) and its collider circles join theirs.

import * as THREE from "three";
import { makeRng, rand, hash } from "../core/rng.js";
import { TAU, clamp, lerp, smoothstep } from "../core/math.js";
import { patchLook, LOOK } from "./look.js";
import { Geo, tube, crag } from "./landmarks.js";

const R = 44; // footprint (roots) radius, m
const TRUNK_H = 140; // trunk top, m above the ground
const COLLIDER_MAX_R = 4.5;
// How fast the haze takes it, relative to everything else (its crown is a beacon).
const HAZE = 0.35;

/* --- Placement --------------------------------------------------------------- */

/**
 * Where the Underfern stands on this island, or null. Pure and deterministic.
 * @param {object} terrain a Terrain
 * @param {number} seed
 * @param {{ x: number, z: number }[]} [others] landmark sites already placed (kept ≥ 160 m away)
 * @returns {{ kind: "underfern", label: string, fossil: false, x: number, z: number, y: number,
 *   yaw: number, r: number, seed: number } | null}
 */
export function planUnderfern(terrain, seed, others = []) {
  const T = terrain;
  const sea = T.seaLevel ?? 0;
  const half = T.half;
  // The island's heart: the centroid of its land.
  let cx = 0;
  let cz = 0;
  let n = 0;
  const step = half / 20;
  for (let z = -half; z <= half; z += step) {
    for (let x = -half; x <= half; x += step) {
      if (T.heightAt(x, z) > sea + 0.5) {
        cx += x;
        cz += z;
        n++;
      }
    }
  }
  if (n) {
    cx /= n;
    cz /= n;
  }
  const avoid = [];
  for (const p of T.passes || []) avoid.push({ x: p.x, z: p.z, r: 70 });
  for (const o of T.lookouts || []) avoid.push({ x: o.x, z: o.z, r: 45 });
  for (const rt of T.routes || []) for (let i = 0; i < rt.points.length; i += 2) avoid.push({ x: rt.points[i].x, z: rt.points[i].z, r: rt.width * 0.5 + 6 });
  for (const c of T.caves || []) {
    for (const e of c.entrances) avoid.push({ x: e.x, z: e.z, r: 40 });
    for (const p of c.path) avoid.push({ x: p.x, z: p.z, r: 18 });
  }
  // Mesas and buttes with their scree, and a mesa's ramp.
  for (const m of T.mesas || []) {
    avoid.push({ x: m.x, z: m.z, r: m.reach + 8 });
    const R = m.ramp;
    if (R) for (let t = 0; t <= 1.001; t += 0.125) avoid.push({ x: R.x0 + (R.x1 - R.x0) * t, z: R.z0 + (R.z1 - R.z0) * t, r: R.width * 0.5 + 12 });
  }
  const clearOf = (x, z) => {
    for (const a of avoid) if (Math.hypot(x - a.x, z - a.z) < a.r + R * 0.7) return false;
    for (const s of others) if (Math.hypot(x - s.x, z - s.z) < 160) return false;
    return true;
  };

  // The forest first; failing that, any gentle ground in the living biomes.
  for (const biomes of [["forest"], ["forest", "plains"]]) {
    const rng = makeRng(hash("underfern-tree", seed >>> 0, biomes.length));
    let best = null;
    for (let t = 0; t < 2400; t++) {
      const x = (rng() * 2 - 1) * (half - 110);
      const z = (rng() * 2 - 1) * (half - 110);
      const yaw = rng() * TAU;
      const score = Math.hypot(x - cx, z - cz) + rng() * 70;
      if (best && score >= best.score) continue;
      if (!T.inBounds(x, z, R + 80)) continue;
      if (!biomes.includes(T.biomeAt(x, z))) continue;
      if (!clearOf(x, z)) continue;
      const y = groundUnder(T, x, z);
      if (y === null) continue;
      best = { x, z, y, yaw, score };
    }
    if (best) {
      return {
        kind: "underfern",
        label: "The Underfern",
        fossil: false,
        tree: true,
        x: best.x,
        z: best.z,
        y: best.y,
        yaw: best.yaw,
        r: R,
        seed: hash("underfern-tree", seed >>> 0, "shape"),
      };
    }
  }
  return null;
}

/**
 * The height to plant the tree at, if (x, z) is fit for it: dry, gentle, roomy
 * ground, clear of caves and fresh water, and no hillside close enough to run
 * into the crown. Null if not.
 */
function groundUnder(T, x, z) {
  const sea = T.seaLevel ?? 0;
  const h0 = T.heightAt(x, z);
  if (h0 < sea + 4 || T.slopeAt(x, z) > 0.2) return null;
  if (T.nearCave && T.nearCave(x, z)) return null;
  let lo = h0;
  let hi = h0;
  for (const rr of [R * 0.5, R]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      const h = T.heightAt(px, pz);
      if (h < sea + 1.5) return null;
      if (T.nearCave && T.nearCave(px, pz)) return null;
      const b = T.biomeAt(px, pz);
      if (b === "rock" || b === "lake" || b === "ocean") return null;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  if (hi - lo > 12) return null;
  if (T.nearestFreshWater && T.nearestFreshWater(x, z, R + 15)) return null;
  // Room for the crown: nothing under it rises within ~70 m of its lowest fronds.
  for (const rr of [65, 90]) {
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * TAU;
      if (T.heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr) > lo + 55) return null;
    }
  }
  return lo;
}

/* --- Geometry ------------------------------------------------------------------ */

const V3 = THREE.Vector3;
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Pale ash-gold bark, darker in its creases; the fronds gold from deep amber to pale tips.
const BARK = [0.34, 0.28, 0.19];
const BARK_DARK = [0.12, 0.095, 0.065];
const BARK_WOOL = [0.36, 0.25, 0.1]; // the hair round a tree fern's crown, gilded
const FROND_BASE = [0.3, 0.17, 0.03];
const FROND_MID = [0.6, 0.4, 0.08];
const FROND_TIP = [0.85, 0.66, 0.22];
const RACHIS = [0.38, 0.26, 0.08];
const FIDDLE = [0.9, 0.72, 0.3];
const CORE = [0.9, 0.62, 0.2];

/** Frond geometry: positions, colours, a uv (x < 0: no leaf outline), sway 0..1, a phase and a glow. */
class FrondGeo {
  constructor() {
    this.p = [];
    this.c = [];
    this.uv = [];
    this.sw = [];
    this.ph = [];
    this.gl = [];
    this.i = [];
    this.n = 0;
  }
  vert(p, c, u, v, sway, phase, glow) {
    this.p.push(p.x, p.y, p.z);
    this.c.push(c[0], c[1], c[2]);
    this.uv.push(u, v);
    this.sw.push(sway);
    this.ph.push(phase);
    this.gl.push(glow);
    return this.n++;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute("aUv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aSway", new THREE.Float32BufferAttribute(this.sw, 1));
    g.setAttribute("aPhase", new THREE.Float32BufferAttribute(this.ph, 1));
    g.setAttribute("aGlow", new THREE.Float32BufferAttribute(this.gl, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** A tube in frond geometry (no leaf outline), swaying with `swayAt(s)`. */
function frondTube(fg, pts, radii, sides, col, swayAt, phase, glow) {
  const n = pts.length;
  const start = fg.n;
  let prevN = null;
  const t = new V3();
  const nn = new V3();
  const b = new V3();
  const p = new V3();
  for (let i = 0; i < n; i++) {
    t.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    if (!prevN) nn.copy(Math.abs(t.y) < 0.9 ? new V3(0, 1, 0).cross(t) : new V3(1, 0, 0).cross(t));
    else nn.copy(prevN).addScaledVector(t, -prevN.dot(t));
    nn.normalize();
    prevN = nn.clone();
    b.crossVectors(t, nn).normalize();
    const s = n > 1 ? i / (n - 1) : 0;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      p.copy(pts[i]).addScaledVector(nn, Math.cos(a) * radii[i]).addScaledVector(b, Math.sin(a) * radii[i]);
      fg.vert(p, col(s), -1, 0, swayAt(s), phase, glow(s));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = start + i * sides + j;
      const c = start + i * sides + ((j + 1) % sides);
      fg.tri(a, c, a + sides);
      fg.tri(c, c + sides, a + sides);
    }
  }
}

/**
 * Build the tree in local space (origin on the ground at its centre).
 * @returns {{ bark: THREE.BufferGeometry, fronds: THREE.BufferGeometry, cols: { x: number, z: number, r: number, height: number }[], top: THREE.Vector3 }}
 */
export function buildUnderfern(rng, detail = 1) {
  const low = detail < 1;
  const g = new Geo();
  const fg = new FrondGeo();
  const sd = Math.floor(rng() * 1e6);

  /* Trunk: several trunks braided round a glowing core. */
  const rings = low ? 26 : 40;
  const lean = rand(rng, 3, 7);
  const leanA = rng() * TAU;
  const wob = rng() * TAU;
  const axis = (s) => {
    const off = lean * s * s + 2.2 * Math.sin(s * 5 + wob) * s;
    return new V3(Math.cos(leanA) * off, s * (TRUNK_H + 4) - 4, Math.sin(leanA) * off);
  };
  // The braid's outer radius: flared at the foot, a swelling under the crown.
  const env = (s) => lerp(17, 8.5, Math.pow(smoothstep(0, 1, s), 0.7)) + 9 * (1 - smoothstep(0, 0.1, s)) + 3 * smoothstep(0.86, 1, s);
  // The core, a little inside the strands, so their gaps show its light.
  const cPts = [];
  const cRad = [];
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    cPts.push(axis(s));
    cRad.push(env(s) * 0.5);
  }
  frondTube(fg, cPts, cRad, low ? 10 : 16, () => CORE, () => 0, 0, (s) => 0.75 + 0.25 * s);
  const strands = low ? 5 : 7;
  const twist = rand(rng, 1.3, 1.8) * Math.PI;
  const strandSides = low ? 9 : 13;
  for (let k = 0; k < strands; k++) {
    const ph = (k / strands) * TAU + rand(rng, -0.12, 0.12);
    const thick = rand(rng, 0.85, 1.15);
    const pts = [];
    const rad = [];
    for (let i = 0; i < rings; i++) {
      const s = i / (rings - 1);
      const a = ph + twist * s + 0.25 * Math.sin(s * 9 + k * 1.7);
      const e = env(s);
      // Strands drift apart and together up the trunk, opening and closing the gaps.
      const swell = 0.78 + 0.22 * Math.sin(s * 13 + k * 2.3);
      pts.push(axis(s).add(new V3(Math.cos(a) * e * 0.62, 0, Math.sin(a) * e * 0.62)));
      rad.push(e * 0.3 * thick * swell * (s > 0.92 ? lerp(1, 0.55, (s - 0.92) / 0.08) : 1));
    }
    tube(
      g,
      pts,
      rad,
      strandSides,
      (s, a, p) => {
        const m = crag(p, 0.12, sd + k) * 0.5 + 0.5;
        let c = mixc(BARK_DARK, BARK, clamp(0.45 + (m - 0.5) * 1.1 + 0.25 * Math.cos(a), 0, 1));
        c = mixc(c, BARK_WOOL, smoothstep(0.85, 0.99, s) * 0.8);
        return c;
      },
      { caps: true, bump: (p, s, a) => 0.04 * Math.sin(a * 9 + crag(p, 0.05, sd + 3) * 6) + crag(p, 0.1, sd + k) * 0.06 },
    );
  }

  /* Buttress roots: out from the foot, arching over the ground into it. */
  const cols = [];
  const roots = low ? 7 : 11;
  for (let k = 0; k < roots; k++) {
    const a = (k / roots) * TAU + rand(rng, -0.2, 0.2);
    const hs = rand(rng, 7, 22);
    const d = rand(rng, 28, 43);
    const high = rng() < 0.4;
    const archUp = high ? rand(rng, 9, 15) : rand(rng, 1, 5);
    const r0 = env((hs + 4) / (TRUNK_H + 4)) * 0.75;
    const tw = rand(rng, -0.25, 0.25);
    const p0 = new V3(Math.cos(a) * r0, hs, Math.sin(a) * r0);
    const p1 = new V3(Math.cos(a + tw * 0.5) * (r0 + d * 0.45), hs * 0.5 + archUp, Math.sin(a + tw * 0.5) * (r0 + d * 0.45));
    const p2 = new V3(Math.cos(a + tw) * d, -2, Math.sin(a + tw) * d);
    const pts = [];
    const rad = [];
    const n = low ? 10 : 15;
    const rBase = rand(rng, 3.2, 5);
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      pts.push(
        new V3()
          .copy(p0)
          .multiplyScalar((1 - s) * (1 - s))
          .addScaledVector(p1, 2 * s * (1 - s))
          .addScaledVector(p2, s * s),
      );
      rad.push(lerp(rBase, 0.9, Math.pow(s, 0.8)));
    }
    tube(g, pts, rad, low ? 8 : 11, (s, aa, p) => {
      const m = crag(p, 0.3, sd + k) * 0.5 + 0.5;
      return mixc(BARK_DARK, BARK, clamp(0.5 + (m - 0.5) * 1.2 - s * 0.25, 0, 1));
    }, { bump: (p) => crag(p, 0.3, sd + 11) * 0.12 });
    // Where a root is down near the ground it blocks the way; arches are open.
    let last = null;
    for (let i = 0; i < n; i++) {
      const q = pts[i];
      if (q.y - rad[i] > 3.2) continue;
      if (Math.hypot(q.x, q.z) < 20) continue; // inside the trunk's own circles
      if (last && Math.hypot(q.x - last.x, q.z - last.z) < 3.5) continue;
      cols.push({ x: q.x, z: q.z, r: Math.min(COLLIDER_MAX_R, rad[i] + 0.6), height: q.y + rad[i] });
      last = q;
    }
  }
  // The trunk's foot (~22 m across its flare): a centre circle and three rings.
  cols.push({ x: 0, z: 0, r: COLLIDER_MAX_R, height: TRUNK_H });
  for (const [ring, count] of [[7, 6], [13, 11], [18.5, 16]]) {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU;
      cols.push({ x: Math.cos(a) * ring, z: Math.sin(a) * ring, r: COLLIDER_MAX_R, height: TRUNK_H });
    }
  }

  /* Crown: golden fronds, young and old, and a few fiddleheads still curled. */
  const top = axis(1);
  const fronds = low ? 18 : 28;
  const segs = low ? 15 : 22;
  for (let f = 0; f < fronds; f++) {
    const th = (f / fronds) * TAU + rand(rng, -0.12, 0.12);
    const age = Math.sqrt(rng()); // 0 young … 1 old (most of a crown is old fronds)
    const L = rand(rng, 92, 112) * lerp(1, 0.9, age);
    const e0 = lerp(1.2, 0.4, age) + rand(rng, -0.1, 0.1);
    const droop = lerp(0.85, 1.55, age) + rand(rng, -0.15, 0.15);
    const curl = rand(rng, -0.18, 0.18);
    const phase = rng() * TAU;
    const pts = [new V3(top.x + Math.cos(th) * 6, top.y - rand(rng, 0, 4), top.z + Math.sin(th) * 6)];
    for (let i = 1; i <= segs; i++) {
      const s = i / segs;
      const e = e0 - droop * Math.pow(s, 1.4);
      const h = th + curl * s;
      pts.push(pts[i - 1].clone().add(new V3(Math.cos(e) * Math.cos(h), Math.sin(e), Math.cos(e) * Math.sin(h)).multiplyScalar(L / segs)));
    }
    frondTube(
      fg,
      pts,
      pts.map((_, i) => lerp(1.6, 0.25, i / segs)),
      low ? 5 : 6,
      (s) => mixc(RACHIS, FROND_MID, s * 0.6),
      (s) => s,
      phase,
      () => 0.5,
    );
    // Pinnae down both sides: longest mid-frond, sweeping toward the tip and drooping.
    const s0 = 0.12;
    const maxP = L * 0.24;
    const t = new V3();
    const side = new V3();
    const d = new V3();
    const w = new V3();
    const q = new V3();
    for (let i = Math.max(1, Math.round(segs * s0)); i < segs; i++) {
      const s = i / segs;
      const prof = Math.pow(Math.sin(Math.PI * clamp((s - s0) / (1 - s0), 0, 1)), 0.75) * (1 - 0.3 * s);
      const plen = maxP * prof;
      if (plen < 1) continue;
      t.subVectors(pts[i + 1], pts[i - 1]).normalize();
      side.set(-Math.sin(th), 0, Math.cos(th)).addScaledVector(t, -side.dot(t)).normalize();
      const width = (L / segs) * 1.3 * (1 - 0.4 * s);
      for (const sg of [-1, 1]) {
        d.copy(side).multiplyScalar(sg).addScaledVector(t, 0.5).normalize();
        d.y -= 0.22 + 0.35 * s;
        d.normalize();
        w.copy(t).addScaledVector(d, -t.dot(d)).normalize();
        const start = fg.n;
        for (let j = 0; j <= 3; j++) {
          const u = j / 3;
          q.copy(pts[i]).addScaledVector(d, plen * u);
          q.y -= plen * 0.14 * u * u; // the tip curls down
          const c = mixc(FROND_BASE, s < 0.5 ? FROND_MID : FROND_TIP, clamp(0.35 + u * 0.4 + s * 0.4, 0, 1));
          const sw = s + 0.18 * u * s;
          fg.vert(q.clone().addScaledVector(w, -width * 0.5), c, u, 0, sw, phase, 0);
          fg.vert(q.clone().addScaledVector(w, width * 0.5), c, u, 1, sw, phase, 0);
        }
        for (let j = 0; j < 3; j++) {
          const a = start + j * 2;
          fg.tri(a, a + 1, a + 2);
          fg.tri(a + 1, a + 3, a + 2);
        }
      }
    }
  }
  const fiddles = low ? 2 : 3;
  for (let f = 0; f < fiddles; f++) {
    const phi = (f / fiddles) * TAU + rand(rng, -0.4, 0.4);
    const out = new V3(Math.cos(phi), 0, Math.sin(phi));
    const base = top.clone().addScaledVector(out, 2.4);
    const stalk = rand(rng, 10, 15);
    const R0 = rand(rng, 3.6, 5);
    const turns = rand(rng, 1.5, 1.9);
    const pts = [];
    const n = low ? 26 : 40;
    const nStalk = Math.round(n * 0.3);
    for (let i = 0; i < nStalk; i++) pts.push(base.clone().addScaledVector(new V3(0, 1, 0), (i / nStalk) * stalk).addScaledVector(out, Math.sin((i / nStalk) * 1.2) * 1.3));
    const C = pts[pts.length - 1].clone().addScaledVector(out, R0);
    for (let i = 1; i < n - nStalk; i++) {
      const k = (i / (n - nStalk - 1)) * turns * TAU;
      const psi = Math.PI - k;
      const rho = R0 * Math.exp(-0.32 * k);
      pts.push(C.clone().addScaledVector(out, Math.cos(psi) * rho).add(new V3(0, Math.sin(psi) * rho, 0)));
    }
    frondTube(
      fg,
      pts,
      pts.map((_, i) => lerp(1.3, 0.45, i / (pts.length - 1))),
      low ? 6 : 8,
      (s) => mixc(FIDDLE, BARK_WOOL, smoothstep(0.35, 0.9, s) * 0.4),
      (s) => 0.12 * s,
      rng() * TAU,
      (s) => 0.8 + 0.2 * s,
    );
  }

  return { bark: g.build(), fronds: fg.build(), cols, top };
}

/* --- Materials -------------------------------------------------------------------- */

/** Shared per-frame state: how much the tree glows, how sunlit it is (day), its glow colour. */
export const TREE = {
  uTreeGlow: { value: 0.4 },
  uTreeDay: { value: 1 },
  uTreeGlowCol: { value: new THREE.Color(1.0, 0.68, 0.24) },
};

const TREE_PARS = /* glsl */ `
uniform float uTreeGlow;
uniform float uTreeDay;
uniform vec3 uTreeGlowCol;
`;

/** The haze takes the tree more slowly than the rest of the island (see HAZE). */
function lessHaze(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "float lookDepth = lookHazeDepth( vFogDepth, vLookWorld.y );",
    `float lookDepth = lookHazeDepth( vFogDepth, vLookWorld.y ) * ${HAZE.toFixed(3)};`,
  );
}

function makeBark() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.name = "UnderfernBark";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, TREE);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vUfNrm;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvUfNrm = normalize( mat3( modelMatrix ) * objectNormal );");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${TREE_PARS}\nvarying vec3 vUfNrm;`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
{
  // Fibres running up the strands, and moss on whatever faces the sky.
  vec3 p = vLookWorld;
  float fib = lookNoise( vec2( p.x * 1.4 + p.z * 1.2, p.y * 0.1 ) );
  float coarse = lookNoise( vec2( p.x * 0.35 + p.z * 0.3, p.y * 0.03 ) );
  float fade = 1.0 - smoothstep( 150.0, 700.0, length( vViewPosition ) );
  diffuseColor.rgb *= mix( 1.0, ( 0.62 + 0.6 * fib ) * ( 0.72 + 0.56 * coarse ), fade );
  float up = smoothstep( 0.55, 0.92, normalize( vUfNrm ).y + ( lookNoise( p.xz * 0.3 ) - 0.5 ) * 0.5 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.2, 0.22, 0.08 ), up * 0.5 );
}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
{
  // Golden veins running up the bark.
  vec3 p = vLookWorld;
  float vein = smoothstep( 0.83, 0.9, lookNoise( vec2( p.x * 0.9 + p.z * 0.8, p.y * 0.05 ) ) );
  vein *= smoothstep( 0.35, 0.7, lookNoise( p.xy * 0.21 + p.z * 0.13 + 7.0 ) );
  totalEmissiveRadiance += uTreeGlowCol * vein * 1.2 * uTreeGlow;
}`,
      );
    patchLook(shader, { wrap: 0.5, rim: 0.45, fill: 0.75 });
    lessHaze(shader);
  };
  m.customProgramCacheKey = () => "underfern-tree-bark-gold";
  return m;
}

function makeFronds() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  m.name = "UnderfernFronds";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, TREE, { uLookScreen: LOOK.uLookScreen, uLookWind: LOOK.uLookWind });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute vec2 aUv;
attribute float aSway;
attribute float aPhase;
attribute float aGlow;
varying vec2 vFrUv;
varying float vFrGlow;
uniform vec4 uLookScreen;
uniform vec4 uLookWind;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
vFrUv = aUv;
vFrGlow = aGlow;
{
  // A slow nod and a quicker shiver, out of step frond to frond, more in a wind.
  float t = uLookScreen.w;
  float w = 0.35 + 0.65 * uLookWind.z;
  float sw = aSway * aSway;
  float nod = sin( t * 0.45 + aPhase ) * 0.7 + sin( t * 1.1 + aPhase * 2.3 ) * 0.3;
  transformed.y += sw * nod * 2.6 * w;
  transformed.xz += sw * vec2( cos( aPhase ), sin( aPhase ) ) * sin( t * 0.7 + aPhase * 1.7 ) * 1.8 * w;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${TREE_PARS}\nvarying vec2 vFrUv;\nvarying float vFrGlow;`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
if ( vFrUv.x >= 0.0 ) {
  // A pinna: a long blade tapering to its tip, its edge cut into pinnules.
  float u = vFrUv.x;
  float v = abs( vFrUv.y - 0.5 ) * 2.0;
  float outline = ( 1.0 - pow( u, 1.6 ) ) * ( 0.7 + 0.3 * smoothstep( 0.0, 0.12, u ) );
  float lobe = 1.0 - fract( u * 11.0 );
  if ( v > outline * ( 0.5 + 0.5 * pow( lobe, 0.6 ) ) ) discard;
  diffuseColor.rgb *= 0.8 + 0.35 * ( 1.0 - v );
}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
{
  // Its own light: the leaves softly, their midribs, the stems and the core more.
  float g = vFrGlow;
  if ( vFrUv.x >= 0.0 ) g = ( 1.0 - smoothstep( 0.0, 0.16, abs( vFrUv.y - 0.5 ) * 2.0 ) ) * 0.55 + 0.3;
  totalEmissiveRadiance += uTreeGlowCol * diffuseColor.rgb * g * uTreeGlow * ( 1.2 + 1.8 * uTreeGlow );
  // Sunlight through the leaves: they flare gold when you look up into the sun.
  float back = pow( max( dot( normalize( vLookWorld - cameraPosition ), normalize( uLookSun.xyz ) ), 0.0 ), 5.0 );
  totalEmissiveRadiance += diffuseColor.rgb * vec3( 1.0, 0.85, 0.5 ) * back * uTreeDay * 1.1;
}`,
      );
    patchLook(shader, { wrap: 0.6, rim: 0.3, fill: 0.85 });
    lessHaze(shader);
  };
  m.customProgramCacheKey = () => "underfern-tree-fronds-gold";
  return m;
}

/* --- Halo and falling leaves ---------------------------------------------------------- */

// A camera-facing disc of golden light behind the crown (display-referred,
// additive): set back from it along the view, so the fronds stand against the
// glow rather than cutting through a disc.
const HALO_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  vP = position.xy * 2.0;
  vec4 c = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  c.z -= uSize * 0.45;
  c.xy += position.xy * uSize;
  gl_Position = projectionMatrix * c;
}
`;
const HALO_FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uStrength;
varying vec2 vP;
void main() {
  float r2 = dot( vP, vP );
  float a = exp( -r2 * 3.2 ) * ( 1.0 - smoothstep( 0.7, 1.0, r2 ) );
  gl_FragColor = vec4( uCol * a * uStrength, 1.0 );
}
`;

// Golden leaves: specks drifting down from the crown, fluttering as they go.
const LEAF_VERT = /* glsl */ `
uniform float uTime;
uniform float uFogFar;
uniform float uPx;
attribute vec4 aLeaf; // x phase, y fall speed (m/s), z size (m), w flutter radius (m)
varying float vA;
void main() {
  vec3 p = position;
  float h = mod( p.y - uTime * aLeaf.y, 170.0 );
  p.y = h + 1.0;
  float a = aLeaf.x * 6.2831853 + uTime * ( 0.6 + aLeaf.y * 0.4 );
  p.x += cos( a ) * aLeaf.w;
  p.z += sin( a * 0.8 ) * aLeaf.w;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float d = max( -mv.z, 1.0 );
  gl_PointSize = clamp( aLeaf.z * projectionMatrix[1][1] * uPx * 0.5 / d, 1.0, 22.0 );
  float flicker = 0.55 + 0.45 * sin( uTime * ( 2.0 + aLeaf.x * 3.0 ) + aLeaf.x * 40.0 );
  vA = flicker * ( 1.0 - smoothstep( uFogFar * 0.9, uFogFar * 1.8, d ) ) * smoothstep( 0.0, 6.0, h ) * ( 1.0 - smoothstep( 150.0, 170.0, h ) );
}
`;
const LEAF_FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uGlow;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float core = exp( -r2 * 4.0 );
  gl_FragColor = vec4( uCol * core * vA * uGlow, 1.0 );
}
`;

/* --- The tree ------------------------------------------------------------------------ */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const GOLD = new THREE.Color("#ffd27a");
const GOLD_NIGHT = new THREE.Color("#ffbf55");

export class UnderfernTree {
  /**
   * @param {ReturnType<typeof planUnderfern>} site
   * @param {{ shadows?: boolean, detail?: number }} [opts]
   */
  constructor(site, { shadows = false, detail = 1 } = {}) {
    this.site = site;
    const rng = makeRng(site.seed);
    const { bark, fronds, cols, top } = buildUnderfern(rng, detail);
    this.group = new THREE.Group();
    this.group.name = "underfern";
    this.group.position.set(site.x, site.y, site.z);
    this.group.rotation.y = site.yaw;
    this._barkMat = makeBark();
    this._frondMat = makeFronds();
    this.bark = new THREE.Mesh(bark, this._barkMat);
    this.bark.name = "underfern-trunk";
    this.bark.castShadow = !!shadows;
    this.bark.receiveShadow = true;
    this.fronds = new THREE.Mesh(fronds, this._frondMat);
    this.fronds.name = "underfern-fronds";
    this.fronds.receiveShadow = true;
    // Swaying fronds reach past their resting bounds a little.
    fronds.boundingSphere.radius += 4;
    this.group.add(this.bark, this.fronds);

    // The halo, centred in the crown.
    this._haloU = { uSize: { value: 300 }, uCol: { value: GOLD.clone() }, uStrength: { value: 0.1 } };
    this.halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        name: "UnderfernHalo",
        uniforms: this._haloU,
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.halo.name = "underfern-halo";
    this.halo.position.set(top.x, top.y + 8, top.z);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 3;
    this.group.add(this.halo);

    // Golden leaves drifting down under the crown.
    const count = detail < 1 ? 160 : 320;
    const lrng = makeRng(hash(site.seed, "leaves"));
    const pos = new Float32Array(count * 3);
    const leaf = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = lrng() * TAU;
      const r = 12 + Math.pow(lrng(), 0.6) * 95;
      pos[i * 3] = top.x + Math.cos(a) * r;
      pos[i * 3 + 1] = lrng() * 170;
      pos[i * 3 + 2] = top.z + Math.sin(a) * r;
      leaf[i * 4] = lrng();
      leaf[i * 4 + 1] = rand(lrng, 0.6, 1.8);
      leaf[i * 4 + 2] = rand(lrng, 0.5, 1.1);
      leaf[i * 4 + 3] = rand(lrng, 1.5, 5);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    lg.setAttribute("aLeaf", new THREE.BufferAttribute(leaf, 4));
    lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(top.x, 85, top.z), 140);
    this._leafU = {
      uTime: { value: 0 },
      uFogFar: { value: 500 },
      uPx: { value: 720 },
      uCol: { value: GOLD.clone() },
      uGlow: { value: 0.5 },
    };
    this.leaves = new THREE.Points(
      lg,
      new THREE.ShaderMaterial({
        name: "UnderfernLeaves",
        uniforms: this._leafU,
        vertexShader: LEAF_VERT,
        fragmentShader: LEAF_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.leaves.name = "underfern-leaves";
    this.leaves.renderOrder = 2;
    this.group.add(this.leaves);
    this.group.updateMatrixWorld(true);

    /** Height of the crown's top above the ground (m). */
    this.height = top.y + 20;
    this.triangles = (bark.index.count + fronds.index.count) / 3;
    // Colliders into world space.
    _q.setFromAxisAngle(UP, site.yaw);
    this.colliders = cols.map((c) => {
      _v.set(c.x, 0, c.z).applyQuaternion(_q);
      return { x: site.x + _v.x, z: site.z + _v.z, r: Math.min(COLLIDER_MAX_R, c.r), height: c.height, kind: "landmark" };
    });
  }

  /**
   * Set its glow, halo and leaves for the hour. It is never hidden: its crown
   * stands above the haze from anywhere on the island.
   * @param {THREE.Camera} camera
   * @param {number} fogFar metres
   * @param {{ daylight?: number } | null} sky
   */
  update(camera, fogFar = Infinity, sky = null) {
    const day = sky?.daylight ?? 1;
    const night = 1 - smoothstep(0.0, 0.35, day);
    TREE.uTreeGlow.value = 0.35 + 0.65 * night;
    TREE.uTreeDay.value = smoothstep(0.1, 0.5, day);
    const far = Number.isFinite(fogFar) ? fogFar : 2000;
    const h = this._haloU;
    h.uCol.value.copy(GOLD).lerp(GOLD_NIGHT, night);
    h.uStrength.value = 0.1 + 0.45 * night;
    const u = this._leafU;
    u.uTime.value = LOOK.uLookScreen.value.w;
    u.uFogFar.value = far;
    u.uPx.value = 1 / Math.max(1e-6, LOOK.uLookScreen.value.y);
    u.uCol.value.copy(GOLD).lerp(GOLD_NIGHT, night);
    u.uGlow.value = 0.45 + 0.55 * night;
  }

  dispose() {
    this.bark.geometry.dispose();
    this.fronds.geometry.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    this.leaves.geometry.dispose();
    this.leaves.material.dispose();
    this._barkMat.dispose();
    this._frondMat.dispose();
    this.group.removeFromParent();
  }
}
