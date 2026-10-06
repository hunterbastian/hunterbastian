// The island. A seeded heightfield shaped into one main landmass (noisy coast,
// bays, sandy beaches and rocky headlands, an off-centre ridged mountain range
// carved by erosion gullies, terraced highland plateaus, rolling plains,
// forest belts, swampy lowlands), a few offshore islets, freshwater lakes and
// rivers carved below sea level. Rendered as one smooth, indexed mesh whose
// material blends procedural grass / dry grass / dirt / rock / sand / mud
// detail textures, and queried by everything that walks on it.
//
// Heights come from a continuous function of world position, sampled at the
// mesh vertices. Layout decisions (lake sites, river routes, how tall the
// mountains get) are made on a fixed coarse grid, so the island is the same at
// every mesh resolution — only the sampling density changes.

import * as THREE from "three";
import { WORLD } from "../config.js";
import { makeRng, rand, randInt, hash } from "../core/rng.js";
import { clamp, lerp, smoothstep, TAU } from "../core/math.js";
import { createNoise2D, createNoise2DGrad, fbm2D, ridged2D, erodedFbm2D } from "../core/noise.js";

export const BIOMES = ["ocean", "lake", "beach", "plains", "forest", "swamp", "highland", "rock"];

const B_OCEAN = 0;
const B_LAKE = 1;
const B_BEACH = 2;
const B_PLAINS = 3;
const B_FOREST = 4;
const B_SWAMP = 5;
const B_HIGHLAND = 6;
const B_ROCK = 7;

// Per-vertex water classification.
const W_LAND = 0;
const W_OCEAN = 1;
const W_FRESH = 2;

const OUTSIDE_HEIGHT = -30; // what heightAt reports off the tile: deep ocean
const DESIGN_SIZE = 1600; // shapes below are authored in metres for this tile
const LAYOUT_RES = 256; // fixed layout grid (6.25 design m) — resolution independent decisions
const SHORE_BUCKET = 48; // metres per spatial-hash cell for shore queries
const RIVER_REACH = 230; // design metres a river valley may influence
const RIVER_HEAD = 95; // design metres over which a spring's gully deepens into a channel

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Draw-time culling: the mesh's index buffer is laid out in CULL_CHUNKS² chunks
// and, per frame, rewritten (only when the set changes) to hold just the chunks
// inside the camera frustum — full detail where the fog hasn't swallowed them,
// every COARSE_STEP-th vertex beyond (fog colour there anyway, but the
// silhouettes still cut the sky glow). One draw call either way.
const CULL_CHUNKS = 16;
const COARSE_STEP = 4;
const CULL_MARGIN = 45; // metres: draw a little beyond the frustum / fog so turning doesn't rebuild every frame
const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _camFwd = new THREE.Vector3();

/* --- Small helpers ------------------------------------------------------- */

/** AABB (6 floats at `o` in `box`) vs the module frustum, planes pushed out by `margin` m. */
function boxInFrustum(box, o, margin) {
  const planes = _frustum.planes;
  for (let i = 0; i < 6; i++) {
    const pl = planes[i];
    const nx = pl.normal.x;
    const ny = pl.normal.y;
    const nz = pl.normal.z;
    const d =
      nx * (nx > 0 ? box[o + 3] : box[o]) + ny * (ny > 0 ? box[o + 4] : box[o + 1]) + nz * (nz > 0 ? box[o + 5] : box[o + 2]) + pl.constant;
    if (d < -margin) return false;
  }
  return true;
}

/** Polynomial smooth minimum — blends carved basins into the land without creases. */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// sRGB byte → linear, for averaging packed texels without a pow per pixel.
const SRGB_BYTE_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_BYTE_TO_LINEAR[i] = srgbToLinear(i / 255);

/** Fast integer hash → [0, 1). */
function hash01(a, b, c) {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Two-pass chamfer distance transform (metres) from every seed vertex. */
function chamfer(n, cell, seed) {
  const d = new Float32Array(n * n);
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let i = 0; i < n * n; i++) d[i] = seed[i] ? 0 : 1e9;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (z > 0) {
        v = Math.min(v, d[i - n] + a);
        if (x > 0) v = Math.min(v, d[i - n - 1] + b);
        if (x < n - 1) v = Math.min(v, d[i - n + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let z = n - 1; z >= 0; z--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = z * n + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < n - 1) v = Math.min(v, d[i + 1] + a);
      if (z < n - 1) {
        v = Math.min(v, d[i + n] + a);
        if (x < n - 1) v = Math.min(v, d[i + n + 1] + b);
        if (x > 0) v = Math.min(v, d[i + n - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Box blur of an n×n field with radius r (cells) via a summed-area table. */
function boxBlur(field, n, r) {
  const w = n + 1;
  const sat = new Float64Array(w * w);
  for (let z = 0; z < n; z++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += field[z * n + x];
      sat[(z + 1) * w + x + 1] = sat[z * w + x + 1] + row;
    }
  }
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    const z0 = Math.max(0, z - r);
    const z1 = Math.min(n, z + r + 1);
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(n, x + r + 1);
      const s = sat[z1 * w + x1] - sat[z0 * w + x1] - sat[z1 * w + x0] + sat[z0 * w + x0];
      out[z * n + x] = s / ((z1 - z0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * Height of a carved bank `out` metres from the waterline: a gentle,
 * walkable shore shelf of `shelf` metres, then a valley side that steepens
 * until it is above any terrain — so a carve never ends in a wall.
 */
function bankProfile(out, shelf) {
  const o2 = Math.max(0, out - 60);
  return out * 0.075 + Math.max(0, out - shelf) * 0.2 + o2 * o2 * 0.0045;
}

/** Chaikin corner cutting on an [x0, z0, x1, z1, …] polyline (keeps endpoints). */
function chaikin(pts, iterations) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const out = [p[0], p[1]];
    for (let i = 0; i < p.length - 2; i += 2) {
      const x0 = p[i];
      const z0 = p[i + 1];
      const x1 = p[i + 2];
      const z1 = p[i + 3];
      out.push(x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25, x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75);
    }
    out.push(p[p.length - 2], p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Resample a polyline at a fixed spacing. */
function resample(pts, spacing) {
  const out = [pts[0], pts[1]];
  let carry = 0;
  for (let i = 0; i < pts.length - 2; i += 2) {
    const x0 = pts[i];
    const z0 = pts[i + 1];
    const dx = pts[i + 2] - x0;
    const dz = pts[i + 3] - z0;
    const len = Math.hypot(dx, dz);
    let s = spacing - carry;
    while (s <= len) {
      out.push(x0 + (dx * s) / len, z0 + (dz * s) / len);
      s += spacing;
    }
    carry = len - (s - spacing);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 2; i += 2) len += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  return len;
}

/**
 * Rasterise distance-to-polyline into `dist` on a grid { n, origin, step }
 * (all in design metres), keeping the normalised arc length of the nearest
 * point in `param`. Only touches grid points within `radius` of a segment, and
 * the distance is exact, so the result doesn't depend on the grid spacing.
 * `side` (optional) receives ±1: which side of the line each point lies on.
 */
function rasterPolyline(pts, radius, grid, dist, param, side = null) {
  const { n, origin, step } = grid;
  const segs = pts.length / 2 - 1;
  const cum = new Float64Array(segs + 1);
  for (let s = 0; s < segs; s++) {
    cum[s + 1] = cum[s] + Math.hypot(pts[s * 2 + 2] - pts[s * 2], pts[s * 2 + 3] - pts[s * 2 + 1]);
  }
  const total = cum[segs] || 1;
  for (let s = 0; s < segs; s++) {
    const x0 = pts[s * 2];
    const z0 = pts[s * 2 + 1];
    const vx = pts[s * 2 + 2] - x0;
    const vz = pts[s * 2 + 3] - z0;
    const len2 = vx * vx + vz * vz;
    const segLen = Math.sqrt(len2);
    const ix0 = Math.max(0, Math.floor((Math.min(x0, x0 + vx) - radius - origin) / step));
    const ix1 = Math.min(n - 1, Math.ceil((Math.max(x0, x0 + vx) + radius - origin) / step));
    const iz0 = Math.max(0, Math.floor((Math.min(z0, z0 + vz) - radius - origin) / step));
    const iz1 = Math.min(n - 1, Math.ceil((Math.max(z0, z0 + vz) + radius - origin) / step));
    for (let iz = iz0; iz <= iz1; iz++) {
      const pz = origin + iz * step;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = origin + ix * step;
        let u = len2 > 0 ? ((px - x0) * vx + (pz - z0) * vz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = px - (x0 + vx * u);
        const dz = pz - (z0 + vz * u);
        const d = Math.sqrt(dx * dx + dz * dz);
        const i = iz * n + ix;
        if (d < radius && d < dist[i]) {
          dist[i] = d;
          if (param) param[i] = (cum[s] + u * segLen) / total;
          if (side) side[i] = vx * (pz - z0) - vz * (px - x0) >= 0 ? 1 : -1;
        }
      }
    }
  }
  return total;
}

/** Minimal binary min-heap of (key, value) pairs for the river path search. */
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

/* --- Erosion gullies ------------------------------------------------------ */
// A directional noise in the spirit of Clay John's / Rune Skovbo Johansen's
// erosion filters: every lattice cell owns a jittered point that radiates a
// cosine wave varying ACROSS the slope, so the crests and troughs run straight
// downhill. Overlapping cells blend into braided gullies and spurs; stacking
// octaves whose direction is bent by the slope of the previous ones makes them
// branch like real drainage. Kernel radius 1.3 cells with jitter in [0.3, 0.7]
// guarantees a 3×3 neighbourhood sees every contributing point.

const GULLY_R2 = 1.3 * 1.3;
const gullyGrad = new Float64Array(2);

/**
 * @param {number} px position in cells
 * @param {number} pz
 * @param {number} dirX unit vector ALONG the contour (perpendicular to the slope)
 * @param {number} dirZ
 * @param {Float64Array} out receives d/dx, d/dz (per cell)
 * @returns {number} ≈ [-1, 1]
 */
function gullyNoise(px, pz, dirX, dirZ, out) {
  const ix = Math.floor(px);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fz = pz - iz;
  let va = 0;
  let vdx = 0;
  let vdz = 0;
  let wt = 0;
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      let h = Math.imul(ix + ox, 0x27d4eb2d) ^ Math.imul(iz + oz, 0x165667b1);
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      h ^= h >>> 13;
      const jx = 0.3 + 0.4 * ((h & 0xffff) / 65535);
      const jz = 0.3 + 0.4 * ((h >>> 16) / 65535);
      const qx = fx - ox - jx;
      const qz = fz - oz - jz;
      const d2 = qx * qx + qz * qz;
      if (d2 >= GULLY_R2) continue;
      let w = 1 - d2 / GULLY_R2;
      w *= w;
      const ph = (qx * dirX + qz * dirZ) * TAU;
      va += Math.cos(ph) * w;
      const s = -Math.sin(ph) * w * TAU;
      vdx += s * dirX;
      vdz += s * dirZ;
      wt += w;
    }
  }
  const inv = wt > 0 ? 1 / wt : 0;
  out[0] = vdx * inv;
  out[1] = vdz * inv;
  return va * inv;
}

/**
 * Three octaves of gullies (wavelength 46 → 11.5 m) on a slope whose uphill
 * gradient is (gx, gz). Returns metres of relief to add (≈ ±amp). Octaves
 * shorter than `minL` (≈ 2.6 grid cells) fade out: the mesh can't hold them
 * and they would alias into a checkered corduroy instead of gullies.
 */
function gullies(x, z, gx, gz, amp, minL = 0) {
  const s = Math.hypot(gx, gz) || 1;
  const ux = gx / s;
  const uz = gz / s;
  let sum = 0;
  let dX = 0;
  let dZ = 0;
  let a = amp;
  let L = 46;
  for (let o = 0; o < 3; o++) {
    // Bend the flow toward the gullies already carved, so they branch.
    let bx = ux + dX * 1.6;
    let bz = uz + dZ * 1.6;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl;
    bz /= bl;
    const v = gullyNoise(x / L + o * 17.31, z / L - o * 9.17, -bz, bx, gullyGrad);
    // Sharpen troughs, round the spurs between them (V-shaped incisions).
    const shaped = v - 0.28 * (1 - v * v);
    const keep = smoothstep(minL, minL * 1.5, L);
    sum += a * keep * shaped;
    dX += (a * keep * gullyGrad[0]) / L;
    dZ += (a * keep * gullyGrad[1]) / L;
    a *= 0.42;
    L *= 0.5;
  }
  return sum;
}

/* --- Procedural surface textures ----------------------------------------- */
// Six tiling detail textures, synthesised once per size and shared by every
// Terrain: grass, dry grass, dirt / forest litter, rock, sand, mud. Albedo
// (sRGB) carries a height in alpha for height-based blending; a second array
// holds the detail normal (RG) and roughness (B). Everything is tileable
// value / cellular noise plus hand-placed strokes (blades, needles, twigs),
// and the GPU builds full mip chains so nothing shimmers when minified — in
// the "pixel" style most of the ground is drawn from the small mips.

const L_GRASS = 0;
const L_DRY = 1;
const L_DIRT = 2;
const L_ROCK = 3;
const L_SAND = 4;
const L_MUD = 5;
const LAYERS = 6;
// World metres covered by one repeat of each layer (near scale).
const LAYER_TILE = [2.6, 2.8, 3.0, 6.5, 3.6, 4.2];
// Detail normal strength per layer (height units → slope).
const LAYER_BUMP = [5, 5, 5, 8, 4, 3];

const surfaceCache = new Map();

/** Tileable texture synthesis on S×S float buffers (S a power of two). */
class Synth {
  constructor(size, seed) {
    this.S = size;
    this.mask = size - 1;
    this.rng = makeRng(seed);
    const N = size * size;
    this.col = new Float32Array(N * 3); // sRGB 0..1
    this.hgt = new Float32Array(N); // 0..1
    this.rough = new Float32Array(N); // 0..1
  }

  /**
   * One octave of tileable value noise with `f` lattice cells per tile
   * (≈ [-1, 1]), added into `out` scaled by `amp` (a fresh array if omitted).
   */
  octave(f, out = null, amp = 1) {
    const S = this.S;
    const rng = this.rng;
    const lat = new Float32Array(f * f);
    for (let i = 0; i < f * f; i++) lat[i] = rng() * 2 - 1;
    const i0 = new Int32Array(S);
    const i1 = new Int32Array(S);
    const w = new Float32Array(S);
    for (let u = 0; u < S; u++) {
      const x = ((u + 0.5) * f) / S;
      const ix = Math.floor(x);
      const t = x - ix;
      i0[u] = ix % f;
      i1[u] = (ix + 1) % f;
      w[u] = t * t * t * (t * (t * 6 - 15) + 10); // quintic: C2, no grid creases in the normals
    }
    if (!out) out = new Float32Array(S * S);
    for (let v = 0; v < S; v++) {
      const r0 = i0[v] * f;
      const r1 = i1[v] * f;
      const wy = w[v] * amp;
      const row = v * S;
      for (let u = 0; u < S; u++) {
        const a = lat[r0 + i0[u]];
        const b = lat[r0 + i1[u]];
        const c = lat[r1 + i0[u]];
        const d = lat[r1 + i1[u]];
        const wx = w[u];
        const top = a + (b - a) * wx;
        out[row + u] += top * amp + (c + (d - c) * wx - top) * wy;
      }
    }
    return out;
  }

  /**
   * Tileable fBm of value noise starting at `f0` cells per tile, ≈ [-1, 1].
   * Octave frequencies stay integers (tileable) but are deliberately not
   * multiples of each other: with plain doubling every lattice line of an
   * octave coincides with the next one's and the sum shows a faint grid.
   */
  fbm(f0, octaves, gain = 0.5) {
    const S = this.S;
    const out = new Float32Array(S * S);
    let amp = 1;
    let norm = 0;
    let f = f0;
    for (let o = 0; o < octaves && f <= S / 2; o++) {
      this.octave(f, out, amp);
      norm += amp;
      amp *= gain;
      f = Math.round(f * 1.93) + 1;
    }
    // Interpolated value noise rarely leaves ±0.6; stretch it toward ±1.
    const k = 1.7 / norm;
    for (let i = 0; i < out.length; i++) {
      const v = out[i] * k;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  /**
   * Domain-warp a field: resample `src` at (u + amp·wx, v + amp·wy) with
   * bilinear filtering and wrap-around (stays tileable). Turns lattice-shaped
   * blobs into the flowing, irregular forms of weathered stone.
   */
  warp(src, wx, wy, amp) {
    const S = this.S;
    const m = this.mask;
    const out = new Float32Array(S * S);
    for (let v = 0; v < S; v++) {
      for (let u = 0; u < S; u++) {
        const i = v * S + u;
        const x = u + wx[i] * amp + S;
        const y = v + wy[i] * amp + S;
        const x0 = x | 0;
        const y0 = y | 0;
        const tx = x - x0;
        const ty = y - y0;
        const r0 = (y0 & m) * S;
        const r1 = ((y0 + 1) & m) * S;
        const c0 = x0 & m;
        const c1 = (x0 + 1) & m;
        const a = src[r0 + c0] + (src[r0 + c1] - src[r0 + c0]) * tx;
        const b = src[r1 + c0] + (src[r1 + c1] - src[r1 + c0]) * tx;
        out[i] = a + (b - a) * ty;
      }
    }
    return out;
  }

  /**
   * Tileable cellular noise: distance (cell units) to the nearest and second
   * nearest jittered points, a random id for the nearest cell and the vector
   * from the pixel to that point.
   */
  worley(cells, jitter = 0.9) {
    const S = this.S;
    const rng = this.rng;
    const C = cells * cells;
    const fx0 = new Float32Array(C);
    const fy0 = new Float32Array(C);
    const rid = new Float32Array(C);
    for (let i = 0; i < C; i++) {
      fx0[i] = 0.5 + (rng() - 0.5) * jitter;
      fy0[i] = 0.5 + (rng() - 0.5) * jitter;
      rid[i] = rng();
    }
    const N = S * S;
    const f1 = new Float32Array(N);
    const f2 = new Float32Array(N);
    const id = new Float32Array(N);
    const ox = new Float32Array(N);
    const oy = new Float32Array(N);
    const sc = cells / S;
    // Wrapped neighbour cell indices per pixel column / row (no modulo inside the loop).
    const cIdx = new Int32Array(S * 3);
    const cFrac = new Float32Array(S);
    for (let u = 0; u < S; u++) {
      const x = (u + 0.5) * sc;
      const ix = Math.floor(x);
      cFrac[u] = x - ix;
      for (let k = 0; k < 3; k++) cIdx[u * 3 + k] = (ix + k - 1 + cells) % cells;
    }
    for (let v = 0; v < S; v++) {
      const fy = cFrac[v];
      for (let u = 0; u < S; u++) {
        const fx = cFrac[u];
        let d1 = 9;
        let d2 = 9;
        let best = 0;
        let bx = 0;
        let by = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = cIdx[v * 3 + dy + 1] * cells;
          for (let dx = -1; dx <= 1; dx++) {
            const c = row + cIdx[u * 3 + dx + 1];
            const qx = dx + fx0[c] - fx;
            const qy = dy + fy0[c] - fy;
            const d = qx * qx + qy * qy;
            if (d < d1) {
              d2 = d1;
              d1 = d;
              best = c;
              bx = qx;
              by = qy;
            } else if (d < d2) d2 = d;
          }
        }
        const i = v * S + u;
        f1[i] = Math.sqrt(d1);
        f2[i] = Math.sqrt(d2);
        id[i] = rid[best];
        ox[i] = bx;
        oy[i] = by;
      }
    }
    return { f1, f2, id, ox, oy };
  }

  /**
   * Paint a soft, tapering stroke (blade, needle, twig) with wrap-around:
   * colour fades from (r0,g0,b0) at the root to (r1,g1,b1) at the tip and the
   * stroke lies on top of the existing height.
   */
  stroke(x0, y0, x1, y1, width, r0, g0, b0, r1, g1, b1, h0, h1, opacity = 1, taperTip = 0.6) {
    const S = this.S;
    const m = this.mask;
    const col = this.col;
    const hgt = this.hgt;
    const vx = x1 - x0;
    const vy = y1 - y0;
    const len2 = vx * vx + vy * vy || 1e-6;
    const hw = width * 0.5;
    const minX = Math.floor(Math.min(x0, x1) - hw - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + hw + 1);
    const minY = Math.floor(Math.min(y0, y1) - hw - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + hw + 1);
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      const row = (y & m) * S;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = ((px - x0) * vx + (py - y0) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (x0 + vx * t);
        const dy = py - (y0 + vy * t);
        const d = Math.sqrt(dx * dx + dy * dy);
        let a = hw * (1 - taperTip * t) + 0.5 - d;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        a *= opacity;
        const i = row + (x & m);
        const j = i * 3;
        col[j] += (r0 + (r1 - r0) * t - col[j]) * a;
        col[j + 1] += (g0 + (g1 - g0) * t - col[j + 1]) * a;
        col[j + 2] += (b0 + (b1 - b0) * t - col[j + 2]) * a;
        const h = h0 + (h1 - h0) * t;
        if (h > hgt[i]) hgt[i] += (h - hgt[i]) * a;
      }
    }
  }

  /** Darken low points: cheap micro-occlusion baked into the albedo. */
  occlude(strength) {
    const col = this.col;
    const hgt = this.hgt;
    for (let i = 0; i < hgt.length; i++) {
      const h = hgt[i] < 0 ? 0 : hgt[i] > 1 ? 1 : hgt[i];
      // ≈ h^0.8: lifts the mid-tones so only real crevices go dark.
      const k = 1 - strength + strength * h * (1.3 - 0.3 * h);
      col[i * 3] *= k;
      col[i * 3 + 1] *= k;
      col[i * 3 + 2] *= k;
    }
  }

  /**
   * Write this layer into the packed RGBA8 arrays: albedo (sRGB) + height,
   * and tangent-space normal (from the height) + roughness. Returns the mean
   * linear albedo, which the shader uses to normalise the far-scale tint.
   */
  pack(albedoBytes, normalBytes, layer, bump) {
    const S = this.S;
    const m = this.mask;
    const N = S * S;
    const col = this.col;
    const hgt = this.hgt;
    const rough = this.rough;
    const base = layer * N * 4;
    // Clamped views round and saturate on store — no per-channel clamp calls.
    const albedo = new Uint8ClampedArray(albedoBytes.buffer, albedoBytes.byteOffset, albedoBytes.length);
    const normal = new Uint8ClampedArray(normalBytes.buffer, normalBytes.byteOffset, normalBytes.length);
    const lin = SRGB_BYTE_TO_LINEAR;
    // Same physical bump at any texture size: slopes per pixel shrink as S grows.
    const K = (bump * S) / 512;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let v = 0; v < S; v++) {
      const up = ((v - 1) & m) * S;
      const dn = ((v + 1) & m) * S;
      const row = v * S;
      for (let u = 0; u < S; u++) {
        const i = row + u;
        const o = base + i * 4;
        albedo[o] = col[i * 3] * 255;
        albedo[o + 1] = col[i * 3 + 1] * 255;
        albedo[o + 2] = col[i * 3 + 2] * 255;
        albedo[o + 3] = hgt[i] * 255;
        sr += lin[albedo[o]];
        sg += lin[albedo[o + 1]];
        sb += lin[albedo[o + 2]];
        const nx = (hgt[row + ((u - 1) & m)] - hgt[row + ((u + 1) & m)]) * 0.5 * K;
        const ny = (hgt[up + u] - hgt[dn + u]) * 0.5 * K;
        const inv = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
        normal[o] = nx * inv + 127.5;
        normal[o + 1] = ny * inv + 127.5;
        normal[o + 2] = rough[i] * 255;
        normal[o + 3] = 255;
      }
    }
    return [sr / N, sg / N, sb / N];
  }

  /** Reset the working buffers for the next layer. */
  clear() {
    this.col.fill(0);
    this.hgt.fill(0);
    this.rough.fill(0.9);
  }
}

const mixInto = (out, a, b, t) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

/** Lush grass: clumpy turf of fine blades over dark soil. */
function synthGrass(T) {
  const S = T.S;
  const N = S * S;
  const m = T.mask;
  const rng = T.rng;
  const { col, hgt, rough } = T;
  const broad = T.fbm(2, 5, 0.55);
  const tone = T.fbm(6, 3, 0.5);
  const cl = T.worley(14, 0.9);
  const soil = [0.15, 0.14, 0.085];
  const deep = [0.19, 0.25, 0.1];
  const mid = [0.28, 0.35, 0.14];
  const yel = [0.4, 0.42, 0.19];
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    mixInto(c, deep, mid, 0.5 + 0.5 * broad[i]);
    mixInto(c, c, yel, smoothstep(0.2, 0.95, 0.5 + 0.5 * tone[i]) * 0.35);
    const clump = 1 - smoothstep(0.2, 0.95, cl.f1[i]);
    mixInto(c, soil, c, 0.45 + 0.55 * clump);
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    hgt[i] = 0.2 + 0.28 * clump + 0.05 * tone[i];
    rough[i] = 0.88 + 0.06 * tone[i];
  }
  const w0 = Math.max(0.85, S / 430);
  for (let n = 0; n < 11000; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const idx = ((y | 0) & m) * S + ((x | 0) & m);
    const clump = 1 - smoothstep(0.2, 0.95, cl.f1[idx]);
    if (rng() > 0.3 + 0.7 * clump) continue;
    const a = rng() * TAU;
    const len = (0.012 + 0.024 * rng()) * S;
    const t = Math.pow(rng(), 1.6);
    const v = 0.8 + 0.32 * rng() + broad[idx] * 0.08;
    if (rng() < 0.05) {
      c[0] = 0.46;
      c[1] = 0.42;
      c[2] = 0.25;
    } else mixInto(c, deep, yel, t);
    c[0] *= v;
    c[1] *= v;
    c[2] *= v;
    const h0 = 0.4 + 0.15 * clump;
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w0 * (1 + 0.6 * rng()),
      c[0] * 0.85, c[1] * 0.85, c[2] * 0.85, Math.min(1, c[0] * 1.1 + 0.015), Math.min(1, c[1] * 1.1 + 0.015), Math.min(1, c[2] * 1.05),
      h0, h0 + 0.25 + 0.15 * rng());
  }
  T.occlude(0.4);
}

/** Dry grass / ochre grassland: matted straw combed by a wind-like flow field. */
function synthDryGrass(T) {
  const S = T.S;
  const N = S * S;
  const m = T.mask;
  const rng = T.rng;
  const { col, hgt, rough } = T;
  const broad = T.fbm(2, 5, 0.55);
  const flow = T.fbm(2, 2, 0.5);
  const tone = T.fbm(8, 3, 0.5);
  const soil = [0.3, 0.25, 0.15];
  const soilD = [0.21, 0.17, 0.1];
  const straw = [0.52, 0.45, 0.27];
  const pale = [0.63, 0.56, 0.37];
  const olive = [0.37, 0.37, 0.19];
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    mixInto(c, soilD, soil, 0.5 + 0.5 * broad[i]);
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    hgt[i] = 0.2 + 0.08 * tone[i];
    rough[i] = 0.92;
  }
  const w0 = Math.max(0.85, S / 440);
  for (let n = 0; n < 9000; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const idx = ((y | 0) & m) * S + ((x | 0) & m);
    const a = flow[idx] * 3.2 + (rng() - 0.5) * 1.3;
    const len = (0.02 + 0.028 * rng()) * S;
    if (rng() < 0.2) mixInto(c, olive, straw, rng() * 0.5);
    else mixInto(c, straw, pale, rng() * rng());
    const v = 0.78 + 0.36 * rng() + broad[idx] * 0.08;
    c[0] *= v;
    c[1] *= v;
    c[2] *= v;
    const h0 = 0.38 + 0.15 * rng();
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w0 * (1 + 0.5 * rng()),
      c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, Math.min(1, c[0] * 1.08), Math.min(1, c[1] * 1.08), Math.min(1, c[2] * 1.06),
      h0, h0 + 0.2 + 0.15 * rng(), 1, 0.45);
  }
  T.occlude(0.38);
}

/** Bare earth and forest litter: humus, a few half-buried stones, needles, twigs, leaves. */
function synthDirt(T) {
  const S = T.S;
  const N = S * S;
  const rng = T.rng;
  const { col, hgt, rough } = T;
  const broad = T.fbm(2, 6, 0.55);
  const fine = T.fbm(16, 3, 0.5);
  const peb = T.worley(20, 0.85);
  const dark = [0.16, 0.12, 0.085];
  const mid = [0.26, 0.2, 0.14];
  const light = [0.35, 0.28, 0.2];
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = 0.5 + 0.5 * broad[i];
    if (t < 0.5) mixInto(c, dark, mid, t * 2);
    else mixInto(c, mid, light, (t - 0.5) * 2);
    const f = 1 + 0.12 * fine[i];
    let h = 0.35 + 0.16 * broad[i] + 0.05 * fine[i];
    // Small stones in one cell in eight, half sunk in the soil; the outline
    // is roughened by fine noise so they read as gravel, not coins.
    const pid = peb.id[i];
    if (pid < 0.125) {
      const r = 0.08 + 0.18 * (pid / 0.125);
      const e = (peb.f1[i] / r) * (1 + 0.3 * fine[i]);
      if (e < 1) {
        const dome = Math.sqrt(1 - e * e);
        const a = smoothstep(1, 0.7, e) * 0.75;
        const g = (0.24 + 0.1 * ((pid * 57.31) % 1) + 0.04 * dome) * (1 + 0.2 * fine[i]);
        c[0] += (g + 0.02 - c[0]) * a;
        c[1] += (g - c[1]) * a;
        c[2] += (g - 0.03 - c[2]) * a;
        h = Math.max(h, 0.4 + 0.14 * dome);
      }
    }
    col[i * 3] = c[0] * f;
    col[i * 3 + 1] = c[1] * f;
    col[i * 3 + 2] = c[2] * f;
    hgt[i] = h;
    rough[i] = 0.9;
  }
  const w0 = Math.max(0.8, S / 540);
  // Conifer needles: short, thin, rust and brown, lying flat.
  for (let n = 0; n < 3400; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const a = rng() * TAU;
    const len = (0.01 + 0.014 * rng()) * S;
    const rust = rng() < 0.5;
    const v = 0.75 + 0.4 * rng();
    const r0 = (rust ? 0.4 : 0.24) * v;
    const g0 = (rust ? 0.26 : 0.18) * v;
    const b0 = (rust ? 0.15 : 0.11) * v;
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w0, r0, g0, b0, r0, g0, b0, 0.46, 0.48, 0.9, 0.2);
  }
  // Twigs: longer, darker, with a bend.
  for (let n = 0; n < 70; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const a = rng() * TAU;
    const len = (0.04 + 0.07 * rng()) * S;
    const mx = x + Math.cos(a) * len * 0.5;
    const my = y + Math.sin(a) * len * 0.5;
    const a2 = a + (rng() - 0.5) * 0.7;
    const w = w0 * (1.5 + 1.3 * rng());
    T.stroke(x, y, mx, my, w, 0.19, 0.14, 0.09, 0.23, 0.17, 0.11, 0.52, 0.55, 1, 0.1);
    T.stroke(mx, my, mx + Math.cos(a2) * len * 0.5, my + Math.sin(a2) * len * 0.5, w, 0.23, 0.17, 0.11, 0.21, 0.15, 0.1, 0.55, 0.52, 1, 0.3);
  }
  // Fallen leaves: short and broad, ochre and olive.
  for (let n = 0; n < 140; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const a = rng() * TAU;
    const len = (0.01 + 0.01 * rng()) * S;
    const w = len * (0.7 + 0.3 * rng());
    const ol = rng() < 0.45;
    const v = 0.8 + 0.3 * rng();
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w,
      (ol ? 0.3 : 0.4) * v, (ol ? 0.29 : 0.28) * v, (ol ? 0.15 : 0.13) * v,
      (ol ? 0.34 : 0.45) * v, (ol ? 0.32 : 0.32) * v, (ol ? 0.17 : 0.15) * v, 0.48, 0.5, 0.85, 0.7);
  }
  T.occlude(0.42);
}

/**
 * Weathered rock: broad tonal variation, sparse meandering fractures (the
 * zero crossings of smooth noise read far more like real cracks than cells
 * do), faint bedding lines, a fine grain and pale lichen on the exposed highs.
 */
function synthRock(T) {
  const S = T.S;
  const { col, hgt, rough } = T;
  // Everything broad is domain-warped so no tone ever lines up with the tile.
  const wx = T.fbm(3, 2, 0.5);
  const wy = T.fbm(3, 2, 0.5);
  const broad = T.warp(T.fbm(2, 4, 0.5), wx, wy, S * 0.07);
  const detail = T.warp(T.fbm(5, 6, 0.55), wx, wy, S * 0.05);
  const grain = T.fbm(64, 2, 0.5);
  const crackA = T.warp(T.fbm(3, 4, 0.42), wy, wx, S * 0.04);
  const crackB = T.fbm(5, 3, 0.42);
  const warp = T.fbm(2, 3, 0.5);
  const lichenN = T.fbm(5, 3, 0.55);
  // Jointing: the rock face splits into irregular plates (~1.3 m), each a
  // slightly different shade and height, so faces read as hard stone.
  const blocks = T.worley(5, 0.85);
  const gap = new Float32Array(S * S);
  for (let i = 0; i < gap.length; i++) gap[i] = blocks.f2[i] - blocks.f1[i];
  const joint = T.warp(gap, wx, wy, S * 0.035);
  const plate = T.warp(blocks.id, wx, wy, S * 0.035);
  const grey = [0.36, 0.345, 0.325];
  const warm = [0.43, 0.385, 0.325];
  const dark = [0.25, 0.235, 0.215];
  const lichen = [0.54, 0.54, 0.42];
  const ochre = [0.52, 0.44, 0.27];
  const moss = [0.24, 0.28, 0.14];
  const c = [0, 0, 0];
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const i = v * S + u;
      const cr = Math.max(
        smoothstep(0.955, 0.995, 1 - Math.abs(crackA[i])),
        smoothstep(0.965, 0.997, 1 - Math.abs(crackB[i])) * 0.6
      );
      // Bedding: thin, slightly wavy partings across the tile (integer
      // frequency keeps it tileable); on cliffs they run horizontally.
      const bed = Math.sin(TAU * ((v * 7) / S + warp[i] * 0.35));
      const parting = smoothstep(0.9, 0.99, bed) * (0.5 + 0.5 * broad[i]);
      const relief = detail[i];
      const jt = 1 - smoothstep(0.0, 0.07, joint[i]);
      const pl = plate[i] - 0.5;
      mixInto(c, grey, warm, clamp(0.5 + 0.6 * broad[i], 0, 1));
      mixInto(c, c, dark, smoothstep(0.1, -0.8, relief) * 0.32);
      const g = 1 + 0.07 * grain[i] + 0.08 * relief + 0.16 * pl;
      c[0] *= g;
      c[1] *= g;
      c[2] *= g;
      const lm = smoothstep(0.28, 0.55, lichenN[i]) * (1 - cr) * (1 - jt) * smoothstep(-0.2, 0.35, relief);
      mixInto(c, c, broad[i] > 0.3 ? ochre : lichen, lm * 0.45);
      mixInto(c, c, moss, Math.max(cr, jt * 0.6) * smoothstep(-0.2, 0.3, lichenN[i]) * 0.35);
      mixInto(c, c, dark, Math.max(cr * 0.6, jt * 0.42, parting * 0.3));
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
      hgt[i] = clamp(
        0.5 + 0.24 * relief + 0.1 * broad[i] + 0.1 * pl + 0.03 * grain[i] - 0.26 * cr - 0.16 * jt - 0.07 * parting,
        0,
        1
      );
      rough[i] = 0.8 + 0.1 * lm - 0.05 * cr;
    }
  }
  T.occlude(0.22);
}

/** Sand: fine grain, wind ripples, the odd shell fleck and dark mineral grain. */
function synthSand(T) {
  const S = T.S;
  const N = S * S;
  const rng = T.rng;
  const { col, hgt, rough } = T;
  const broad = T.fbm(2, 4, 0.5);
  const warp = T.fbm(2, 3, 0.5);
  const warp2 = T.fbm(3, 3, 0.5);
  const grainA = T.octave(Math.min(S / 2, 256));
  const grainB = T.octave(Math.min(S / 4, 128));
  const light = [0.82, 0.75, 0.59];
  const mid = [0.74, 0.66, 0.5];
  const c = [0, 0, 0];
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const i = v * S + u;
      // Wind ripples: two crossing trains (integer wave vectors keep them
      // tileable), strongly warped and only in patches — regular, straight
      // ripples read as stripes converging on the horizon.
      const ph = TAU * ((13 * u + 5 * v) / S) + warp[i] * 7;
      const ph2 = TAU * ((4 * u - 11 * v) / S) + warp2[i] * 6;
      const s1 = 0.5 + 0.5 * Math.sin(ph);
      const s2 = 0.5 + 0.5 * Math.sin(ph2);
      const patch = smoothstep(-0.25, 0.45, warp2[i] + 0.4 * broad[i]);
      const rip = (s1 * s1 * patch + s2 * s2 * (1 - patch) * 0.6) * (0.5 + 0.5 * smoothstep(-0.6, 0.6, warp[i]));
      const gr = grainA[i] * 0.6 + grainB[i] * 0.4;
      mixInto(c, mid, light, clamp(0.5 + 0.5 * broad[i] + 0.06 * rip, 0, 1));
      const f = 1 + 0.08 * gr - 0.025 * (1 - rip);
      col[i * 3] = c[0] * f;
      col[i * 3 + 1] = c[1] * f;
      col[i * 3 + 2] = c[2] * f;
      hgt[i] = 0.42 + 0.11 * rip + 0.06 * broad[i] + 0.05 * gr;
      rough[i] = 0.9;
    }
  }
  // Specks: dark mineral grains and the odd small, sun-bleached shell chip.
  for (let n = 0; n < 420; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const shell = rng() < 0.22;
    const a = rng() * TAU;
    const len = (shell ? 0.004 + 0.005 * rng() : 0.002 + 0.003 * rng()) * S;
    const w = Math.max(0.8, len * (shell ? 0.7 : 1));
    const k = shell ? 0.76 + 0.08 * rng() : 0.4 + 0.15 * rng();
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w,
      k, k * (shell ? 0.97 : 0.93), k * (shell ? 0.9 : 0.85), k, k * 0.96, k * 0.88, 0.55, 0.58, 0.9, 0.3);
  }
}

/** Mud: dark silt with wet, glossy hollows and faint drying cracks. */
function synthMud(T) {
  const S = T.S;
  const N = S * S;
  const rng = T.rng;
  const { col, hgt, rough } = T;
  const broad = T.fbm(2, 5, 0.55);
  const detail = T.fbm(10, 3, 0.5);
  const cracks = T.worley(9, 0.9);
  const dry = [0.39, 0.32, 0.23];
  const mid = [0.3, 0.25, 0.18];
  const wet = [0.19, 0.16, 0.12];
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const puddle = smoothstep(-0.05, -0.4, broad[i]);
    const dryness = smoothstep(0.05, 0.5, broad[i]);
    const cr = (1 - smoothstep(0.0, 0.05, cracks.f2[i] - cracks.f1[i])) * dryness;
    mixInto(c, mid, dry, dryness);
    mixInto(c, c, wet, puddle);
    const f = 1 + 0.07 * detail[i];
    col[i * 3] = c[0] * f * (1 - 0.35 * cr);
    col[i * 3 + 1] = c[1] * f * (1 - 0.35 * cr);
    col[i * 3 + 2] = c[2] * f * (1 - 0.35 * cr);
    hgt[i] = clamp(0.45 + 0.22 * broad[i] + 0.04 * detail[i] - 0.07 * cr, 0, 1);
    rough[i] = lerp(0.86, 0.58, puddle);
  }
  // Dead reed stems and bits of plant matter trodden into the silt.
  const w0 = Math.max(0.8, S / 480);
  for (let n = 0; n < 220; n++) {
    const x = rng() * S;
    const y = rng() * S;
    const a = rng() * TAU;
    const len = (0.015 + 0.035 * rng()) * S;
    const pale = rng() < 0.35;
    const v = 0.8 + 0.3 * rng();
    const r0 = (pale ? 0.38 : 0.17) * v;
    const g0 = (pale ? 0.34 : 0.15) * v;
    const b0 = (pale ? 0.23 : 0.1) * v;
    T.stroke(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, w0 * (1 + rng()), r0, g0, b0, r0, g0, b0, 0.5, 0.52, 0.6, 0.2);
  }
}

const SYNTH = [synthGrass, synthDryGrass, synthDirt, synthRock, synthSand, synthMud];

/**
 * The shared detail texture arrays for a given size (cached).
 * @param {number} size texels per side (power of two)
 * @returns {{ albedo: THREE.DataArrayTexture, normal: THREE.DataArrayTexture, avg: THREE.Vector3[], ms: number }}
 */
function getSurfaceTextures(size) {
  const cached = surfaceCache.get(size);
  if (cached) return cached;
  const job = createSurfaceJob(size);
  for (let l = 0; l < LAYERS; l++) job.step();
  return job.finish();
}

/**
 * Incremental synthesis of one texture set: `step()` builds the next layer,
 * `finish()` uploads and caches. Lets the high-resolution set be spread over
 * idle slices instead of one long blocking task.
 */
function createSurfaceJob(size) {
  const N = size * size;
  const albedoData = new Uint8Array(N * 4 * LAYERS);
  const normalData = new Uint8Array(N * 4 * LAYERS);
  const avg = [];
  const T = new Synth(size, 0x5a017a);
  let layer = 0;
  let ms = 0;
  return {
    get done() {
      return layer >= LAYERS;
    },
    step() {
      if (layer >= LAYERS) return;
      const t0 = now();
      T.clear();
      T.rng = makeRng(hash("sauria-surface", layer));
      SYNTH[layer](T);
      const a = T.pack(albedoData, normalData, layer, LAYER_BUMP[layer]);
      avg.push(new THREE.Vector3(a[0], a[1], a[2]));
      layer++;
      ms += now() - t0;
    },
    finish() {
      return uploadSurface(size, albedoData, normalData, avg, ms);
    },
  };
}

const pendingSurface = new Map(); // size → [callback]
const idle =
  typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 150 })
    : (fn) => setTimeout(fn, 16);

/**
 * Build the `size` texture set in the background (one layer per idle slice)
 * and hand it to `onReady` once uploaded. Concurrent requests share one job.
 */
function upgradeSurfaceTextures(size, onReady) {
  const cached = surfaceCache.get(size);
  if (cached) {
    onReady(cached);
    return;
  }
  const waiting = pendingSurface.get(size);
  if (waiting) {
    waiting.push(onReady);
    return;
  }
  const callbacks = [onReady];
  pendingSurface.set(size, callbacks);
  const job = createSurfaceJob(size);
  const tick = () => {
    job.step();
    if (!job.done) {
      idle(tick);
      return;
    }
    const entry = job.finish();
    pendingSurface.delete(size);
    for (const cb of callbacks) cb(entry);
  };
  idle(tick);
}

function uploadSurface(size, albedoData, normalData, avg, ms) {
  const make = (data, colorSpace) => {
    const tex = new THREE.DataArrayTexture(data, size, size, LAYERS);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = colorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  };
  const entry = {
    albedo: make(albedoData, THREE.SRGBColorSpace),
    normal: make(normalData, THREE.NoColorSpace),
    avg,
    ms,
  };
  surfaceCache.set(size, entry);
  return entry;
}

/* --- Terrain material ----------------------------------------------------- */

const VERT_PARS = /* glsl */ `
attribute vec4 aMatA;
attribute vec4 aMatB;
varying vec3 vTerPos;
varying vec3 vTerNrm;
varying vec4 vTerA;
varying vec4 vTerB;
`;

const VERT_MAIN = /* glsl */ `
vTerPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTerNrm = normalize(mat3(modelMatrix) * objectNormal);
vTerA = aMatA;
vTerB = aMatB;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2DArray terAlbedo;
uniform sampler2DArray terNormal;
uniform vec3 terAvg[6];
uniform float terScale[6];
uniform float terSea;
uniform vec3 terDeep;
varying vec3 vTerPos;
varying vec3 vTerNrm;
varying vec4 vTerA;
varying vec4 vTerB;

// The far-scale lookup is rotated, ~4.3x larger and pre-blurred: it adds the
// texture's own broad mottling at a period that never lines up with the near
// tiling, so the repeat disappears without stretched blades or pebbles.
const mat2 TER_ROT = mat2(0.8, 0.6, -0.6, 0.8);
const float TER_FAR = 0.23;
const float TER_FAR_BLUR = 5.0;
const float TER_CONTRAST = 0.55; // how much texture height sways the blend
const float TER_DEPTH = 0.18;    // blend softness (height units)

vec3 terStrataTint(float layer) {
  float h = fract(sin(layer * 12.9898 + 4.1) * 43758.5453);
  vec3 t = mix(vec3(0.84, 0.84, 0.86), vec3(1.06, 1.0, 0.88), h);
  return mix(t, vec3(1.04, 0.85, 0.76), step(0.8, h));
}
`;

const FRAG_MAP = /* glsl */ `
vec3 terN = normalize(vTerNrm);
vec3 terDx = dFdx(vTerPos);
vec3 terDy = dFdy(vTerPos);
float terDist = length(vViewPosition);
// Past ~50 m the near tile (2.6–6.5 m) repeats every few pixels and its broad
// blotches line up into a visible grid. Fade it toward the layer's mean colour
// with distance; the rotated far sample and the per-vertex macro tint carry
// the variation from there.
float terNearFade = smoothstep(45.0, 190.0, terDist) * 0.8;
// Strata bands in world height (~4.8 m thick), wavering gently; each band
// gets its own tint and the switch between bands is filtered by its screen
// footprint so distant cliffs don't shimmer (especially in the pixel style).
float terSy = vTerPos.y * 0.21 + vTerB.w * 1.6 + sin(vTerPos.x * 0.031 + vTerPos.z * 0.023) * 0.35;
float terSyW = max(fwidth(terSy) * 1.5, 0.08);
float terLayer = floor(terSy);
float terLf = terSy - terLayer;
vec3 terStrata = mix(terStrataTint(terLayer), terStrataTint(terLayer + 1.0), smoothstep(1.0 - terSyW, 1.0, terLf));
terStrata *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, terSyW, terLf)) * (1.0 - smoothstep(0.3, 1.2, terSyW * 4.0));
float terW[6];
terW[0] = vTerA.x; terW[1] = vTerA.y; terW[2] = vTerA.z; terW[3] = vTerA.w; terW[4] = vTerB.x; terW[5] = vTerB.y;
vec3 terCol[6];
vec2 terNm[6];
float terRg[6];
float terVal[6];
float terMax = 0.0;
vec3 terRockN = terN;
for (int i = 0; i < 6; i++) {
  terVal[i] = -10.0;
  terCol[i] = vec3(0.0);
  terNm[i] = vec2(0.0);
  terRg[i] = 0.9;
  if (terW[i] < 0.004) continue;
  float sc = terScale[i];
  float layer = float(i);
  vec2 uv = vTerPos.xz * sc;
  vec2 gx = terDx.xz * sc;
  vec2 gy = terDy.xz * sc;
  float farK = sc * TER_FAR;
  float farG = farK * TER_FAR_BLUR;
  vec4 far;
  vec4 alb;
  if (i == 3) {
    // Rock is tri-planar so cliffs never smear; normals use a UDN blend per
    // axis, and the far-scale mottling is projected the same way.
    vec3 bl = pow(abs(terN), vec3(4.0));
    bl /= (bl.x + bl.y + bl.z);
    alb = vec4(0.0);
    far = vec4(0.0);
    vec3 nW = vec3(0.0);
    float rg = 0.0;
    if (bl.y > 0.02) {
      vec4 a = textureGrad(terAlbedo, vec3(uv, layer), gx, gy);
      vec4 n = textureGrad(terNormal, vec3(uv, layer), gx, gy);
      far += textureGrad(terAlbedo, vec3(TER_ROT * vTerPos.xz * farK + 0.37, layer), TER_ROT * terDx.xz * farG, TER_ROT * terDy.xz * farG) * bl.y;
      vec2 t = n.xy * 2.0 - 1.0;
      alb += a * bl.y;
      nW += vec3(t.x + terN.x, terN.y, t.y + terN.z) * bl.y;
      rg += n.z * bl.y;
    }
    if (bl.x > 0.02) {
      vec2 uvX = vTerPos.zy * sc;
      vec4 a = textureGrad(terAlbedo, vec3(uvX, layer), terDx.zy * sc, terDy.zy * sc);
      vec4 n = textureGrad(terNormal, vec3(uvX, layer), terDx.zy * sc, terDy.zy * sc);
      far += textureGrad(terAlbedo, vec3(TER_ROT * vTerPos.zy * farK + 0.61, layer), TER_ROT * terDx.zy * farG, TER_ROT * terDy.zy * farG) * bl.x;
      vec2 t = n.xy * 2.0 - 1.0;
      alb += a * bl.x;
      nW += vec3(terN.x, t.y + terN.y, t.x + terN.z) * bl.x;
      rg += n.z * bl.x;
    }
    if (bl.z > 0.02) {
      vec2 uvZ = vTerPos.xy * sc;
      vec4 a = textureGrad(terAlbedo, vec3(uvZ, layer), terDx.xy * sc, terDy.xy * sc);
      vec4 n = textureGrad(terNormal, vec3(uvZ, layer), terDx.xy * sc, terDy.xy * sc);
      far += textureGrad(terAlbedo, vec3(TER_ROT * vTerPos.xy * farK + 0.13, layer), TER_ROT * terDx.xy * farG, TER_ROT * terDy.xy * farG) * bl.z;
      vec2 t = n.xy * 2.0 - 1.0;
      alb += a * bl.z;
      nW += vec3(t.x + terN.x, t.y + terN.y, terN.z) * bl.z;
      rg += n.z * bl.z;
    }
    float bs = bl.x * step(0.02, bl.x) + bl.y * step(0.02, bl.y) + bl.z * step(0.02, bl.z);
    alb /= bs;
    far /= bs;
    terRg[i] = rg / bs;
    terRockN = normalize(nW);
    // Sedimentary strata on steep faces: grey, buff and the odd rust band.
    alb.rgb *= mix(vec3(1.0), terStrata, (1.0 - bl.y) * 0.9);
    alb.rgb = mix(alb.rgb, terAvg[i], terNearFade * 0.7);
    alb.rgb *= mix(vec3(1.0), far.rgb / terAvg[i], 0.6);
  } else {
    far = textureGrad(terAlbedo, vec3(TER_ROT * vTerPos.xz * farK + 0.37, layer), TER_ROT * gx * (TER_FAR * TER_FAR_BLUR), TER_ROT * gy * (TER_FAR * TER_FAR_BLUR));
    alb = textureGrad(terAlbedo, vec3(uv, layer), gx, gy);
    vec4 n = textureGrad(terNormal, vec3(uv, layer), gx, gy);
    terNm[i] = n.xy * 2.0 - 1.0;
    terRg[i] = n.z;
    alb.rgb = mix(alb.rgb, terAvg[i], terNearFade);
    alb.rgb *= mix(vec3(1.0), far.rgb / terAvg[i], 0.7);
  }
  terCol[i] = alb.rgb;
  terVal[i] = terW[i] + (alb.a * 0.75 + far.a * 0.25) * TER_CONTRAST;
  terMax = max(terMax, terVal[i]);
}
float terSum = 0.0;
float terB[6];
for (int i = 0; i < 6; i++) {
  terB[i] = max(terVal[i] - terMax + TER_DEPTH, 0.0);
  terSum += terB[i];
}
vec3 terAlb = vec3(0.0);
vec2 terTopN = vec2(0.0);
float terRough = 0.0;
for (int i = 0; i < 6; i++) {
  float b = terB[i] / terSum;
  terAlb += terCol[i] * b;
  terRough += terRg[i] * b;
  terTopN += terNm[i] * b;
}
float terRockB = terB[3] / terSum;
terTopN /= max(1.0 - terRockB, 0.001);

// Detail normals: full strength underfoot, softer far away (mips average them
// anyway; this keeps distant grazing slopes from glittering).
float terNs = mix(1.0, 0.45, smoothstep(30.0, 180.0, terDist));
vec3 terTopW = normalize(vec3(terTopN.x * terNs + terN.x, terN.y, terTopN.y * terNs + terN.z));
vec3 terNormW = normalize(mix(terTopW, normalize(mix(terN, terRockN, terNs)), terRockB));

// Macro variation (per-vertex low-frequency noise) and cavity occlusion.
float terAO = vTerB.z;
terAlb *= (0.86 + 0.28 * vTerB.w) * mix(1.0, terAO, 0.45);

// Wet band at the waterline: darker, glossier.
float terAbove = vTerPos.y - terSea;
float terWet = 1.0 - smoothstep(0.04, 0.6 + 0.5 * vTerB.w, terAbove);
terAlb *= 1.0 - 0.42 * terWet;
terRough = mix(terRough, 0.3, terWet * 0.85);
// Under water: absorb red first, then sink toward deep teal.
float terDepth = max(-terAbove, 0.0);
terAlb = mix(terAlb, terAlb * vec3(0.6, 0.84, 0.82), smoothstep(0.0, 1.2, terDepth));
terAlb = mix(terAlb, terDeep, smoothstep(0.3, 7.0, terDepth) * 0.85);

diffuseColor.rgb *= terAlb;
`;

/**
 * MeshStandardMaterial extended with the splatted procedural surface.
 * Lighting, shadows and fog stay three.js's own.
 */
function createTerrainMaterial(textures, seaLevel) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.name = "TerrainMaterial";
  const scales = LAYER_TILE.map((m) => 1 / m);
  mat.userData.uniforms = {
    terAlbedo: { value: textures.albedo },
    terNormal: { value: textures.normal },
    terAvg: { value: textures.avg },
    terScale: { value: scales },
    terSea: { value: seaLevel },
    terDeep: { value: new THREE.Color("#0f3a3c") },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <map_fragment>", FRAG_MAP)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = terRough;")
      .replace("#include <normal_fragment_maps>", "normal = normalize((viewMatrix * vec4(terNormW, 0.0)).xyz);")
      .replace(
        "#include <aomap_fragment>",
        "reflectedLight.indirectDiffuse *= terAO;\nreflectedLight.indirectSpecular *= mix(1.0, terAO, 0.7);"
      );
  };
  mat.customProgramCacheKey = () => "sauria-terrain-v3";
  return mat;
}

/* --- Map palette (sRGB 0..255) -------------------------------------------- */

const MAP = {
  paper: [233, 225, 204],
  ink: [52, 58, 50],
  oceanShallow: [158, 186, 178],
  oceanDeep: [78, 112, 124],
  freshShallow: [128, 176, 174],
  freshDeep: [58, 108, 118],
  contour: [86, 70, 48],
  shadowTint: [70, 78, 96],
  lightTint: [255, 244, 214],
  forest: [72, 92, 60],
  swamp: [104, 112, 82],
  // Per material layer: grass, dry grass, dirt, rock, sand, mud.
  layers: [
    [124, 136, 82],
    [184, 164, 108],
    [140, 118, 88],
    [158, 150, 138],
    [222, 206, 166],
    [112, 104, 80],
  ],
};

/* --- Terrain -------------------------------------------------------------- */

export class Terrain {
  /**
   * Generate the island. Deterministic for a seed; ~0.5–1 s at resolution 512.
   * @param {{ size?: number, resolution?: number, seed?: number, seaLevel?: number, maxHeight?: number }} opts
   */
  constructor({
    size = WORLD.size,
    resolution = WORLD.resolution,
    seed = WORLD.seed,
    seaLevel = WORLD.seaLevel,
    maxHeight = WORLD.maxHeight,
  } = {}) {
    const t0 = now();
    this.size = size;
    this.half = size / 2;
    this.resolution = Math.max(16, Math.round(resolution));
    this.cellSize = size / this.resolution;
    this.seaLevel = seaLevel;
    this.maxHeight = maxHeight;
    this.seed = seed;

    const n = this.resolution + 1;
    this._n = n;
    this.heights = new Float32Array(n * n);
    /** Lakes as authored: [{ x, z, r }] in world metres (r ≈ mean radius). */
    this.lakes = [];
    /** River centrelines: [[{ x, z }, …], …] in world metres, source → mouth. */
    this.rivers = [];
    /** Generation statistics (timings, land fraction, counts) for debugging. */
    this.stats = {};

    const g = this._createContext();
    const timings = {};
    let t = now();
    this._layout(g);
    this._placeLakes(g);
    this._placeRivers(g);
    timings.layout = now() - t;
    t = now();
    this._shapeVertices(g);
    timings.shape = now() - t;
    t = now();
    this._carveWater(g);
    this._classifyWater(g);
    timings.water = now() - t;
    t = now();
    this._paint(g);
    timings.paint = now() - t;

    // Everything above works relative to the sea; store absolute heights.
    if (seaLevel !== 0) for (let i = 0; i < n * n; i++) this.heights[i] += seaLevel;

    t = now();
    this._collectShore();
    timings.shore = now() - t;
    t = now();
    // High quality wants 512² detail textures, which take a few hundred ms to
    // synthesise. Unless they are cached already, start on the 256² set (4×
    // cheaper) and build the full set in idle slices, swapping it in when done.
    const surfaceSize = this.resolution >= 400 ? 512 : 256;
    const textures = surfaceCache.get(surfaceSize) || getSurfaceTextures(256);
    timings.textures = now() - t;
    t = now();
    this.mesh = this._buildMesh(textures);
    this.heightTexture = this._buildHeightTexture();
    timings.mesh = now() - t;

    this._disposed = false;
    /**
     * Resolves once the full-resolution surface textures are in place (at
     * once when they were cached). Optional — the mesh is usable right away.
     * @type {Promise<void>}
     */
    this.ready =
      textures.albedo.image.width >= surfaceSize
        ? Promise.resolve()
        : new Promise((resolve) => {
            upgradeSurfaceTextures(surfaceSize, (hi) => {
              if (!this._disposed) this._setSurface(hi);
              resolve();
            });
          });

    this.stats.timings = timings;
    this.stats.genMs = now() - t0;
  }

  /* --- Queries ----------------------------------------------------------- */

  /**
   * Ground height at a world position. Interpolates over the same two
   * triangles per cell the mesh is drawn with, so feet sit exactly on the
   * visible surface. Off the tile → deep ocean.
   */
  heightAt(x, z) {
    const res = this.resolution;
    const fx = (x + this.half) / this.cellSize;
    const fz = (z + this.half) / this.cellSize;
    if (!(fx >= 0 && fz >= 0 && fx <= res && fz <= res)) return OUTSIDE_HEIGHT + this.seaLevel;
    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= res) ix = res - 1;
    if (iz >= res) iz = res - 1;
    const tx = fx - ix;
    const tz = fz - iz;
    const n = this._n;
    const H = this.heights;
    const a = iz * n + ix;
    const ha = H[a];
    const hb = H[a + 1];
    const hc = H[a + n];
    const hd = H[a + n + 1];
    if (((ix + iz) & 1) === 0) {
      // Diagonal a–d.
      return tz > tx ? ha + (hd - hc) * tx + (hc - ha) * tz : ha + (hb - ha) * tx + (hd - hb) * tz;
    }
    // Diagonal b–c.
    return tx + tz <= 1
      ? ha + (hb - ha) * tx + (hc - ha) * tz
      : hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz);
  }

  /** Smoothed surface normal (central differences over one cell). */
  normalAt(x, z, target = new THREE.Vector3()) {
    const e = this.cellSize;
    const dx = this.heightAt(x - e, z) - this.heightAt(x + e, z);
    const dz = this.heightAt(x, z - e) - this.heightAt(x, z + e);
    return target.set(dx, 2 * e, dz).normalize();
  }

  /** 0 = flat … 1 = vertical (1 − normal.y). Allocation-free. */
  slopeAt(x, z) {
    const e = this.cellSize;
    const dx = this.heightAt(x - e, z) - this.heightAt(x + e, z);
    const dz = this.heightAt(x, z - e) - this.heightAt(x, z + e);
    const ny = (2 * e) / Math.sqrt(dx * dx + 4 * e * e + dz * dz);
    return 1 - ny;
  }

  /** One of BIOMES. Water → "ocean" | "lake" (rivers count as "lake"). */
  biomeAt(x, z) {
    if (this.heightAt(x, z) < this.seaLevel) return this.isFreshWater(x, z) ? "lake" : "ocean";
    const res = this.resolution;
    const ix = clamp(Math.round((x + this.half) / this.cellSize), 0, res);
    const iz = clamp(Math.round((z + this.half) / this.cellSize), 0, res);
    return BIOMES[this._biome[iz * this._n + ix]];
  }

  /** True where the ground is below sea level (any water). */
  isWater(x, z) {
    return this.heightAt(x, z) < this.seaLevel;
  }

  /** Water that belongs to a lake, river or enclosed pond — drinkable. */
  isFreshWater(x, z) {
    if (this.heightAt(x, z) >= this.seaLevel) return false;
    return this._waterClassNear(x, z) === W_FRESH;
  }

  /** Metres of water above the ground (0 on land). */
  waterDepthAt(x, z) {
    return Math.max(0, this.seaLevel - this.heightAt(x, z));
  }

  /** Inside the tile, optionally keeping `margin` metres from its edge. */
  inBounds(x, z, margin = 0) {
    const h = this.half - margin;
    return x >= -h && x <= h && z >= -h && z <= h;
  }

  /**
   * Local wetness 0..1 (noise + proximity to fresh water + lowland bonus).
   * Not in the core contract — handy for vegetation density tweaks.
   */
  moistureAt(x, z) {
    return this._sampleField(this._moisture, x, z);
  }

  /**
   * Random dry-land point that satisfies the filters, or null.
   * @param {() => number} rng seeded generator from makeRng
   * @param {{ biomes?: string[], minHeight?: number, maxSlope?: number,
   *           near?: { x: number, z: number, minR?: number, maxR?: number }, tries?: number }} opts
   * @returns {{ x: number, z: number } | null}
   */
  findSpawnPoint(rng, { biomes = null, minHeight = 1, maxSlope = 0.35, near = null, tries = 300 } = {}) {
    const r = typeof rng === "function" ? rng : Math.random;
    const margin = 40;
    const span = this.half - margin;
    for (let i = 0; i < tries; i++) {
      let x;
      let z;
      if (near) {
        const minR = near.minR ?? 0;
        const maxR = near.maxR ?? 200;
        const a = r() * TAU;
        // Uniform over the ring's area, not its radius.
        const d = Math.sqrt(lerp(minR * minR, maxR * maxR, r()));
        x = near.x + Math.sin(a) * d;
        z = near.z + Math.cos(a) * d;
        if (!this.inBounds(x, z, margin)) continue;
      } else {
        x = (r() * 2 - 1) * span;
        z = (r() * 2 - 1) * span;
      }
      if (this.heightAt(x, z) - this.seaLevel < minHeight) continue;
      if (this.slopeAt(x, z) > maxSlope) continue;
      if (biomes && biomes.length && !biomes.includes(this.biomeAt(x, z))) continue;
      return { x, z };
    }
    return null;
  }

  /**
   * Nearest place to stand and drink: a land point ~1 m from the edge of a
   * lake or river. `waterX/waterZ` is a point just inside the water to face.
   * @returns {{ x: number, z: number, dist: number, waterX: number, waterZ: number } | null}
   */
  nearestFreshWater(x, z, maxRadius = 400) {
    const sx = this._shoreX;
    const sz = this._shoreZ;
    const start = this._shoreStart;
    const items = this._shoreItems;
    const gw = this._shoreGrid;
    const B = SHORE_BUCKET;
    const bx = Math.floor((x + this.half) / B);
    const bz = Math.floor((z + this.half) / B);
    const maxRing = Math.ceil(maxRadius / B) + 1;
    let best = -1;
    let bestD2 = maxRadius * maxRadius;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Anything in this ring is at least (ring − 1) buckets away.
      const minD = (ring - 1) * B;
      if (minD > 0 && minD * minD > bestD2) break;
      for (let gz = bz - ring; gz <= bz + ring; gz++) {
        if (gz < 0 || gz >= gw) continue;
        const edgeRow = gz === bz - ring || gz === bz + ring;
        for (let gx = bx - ring; gx <= bx + ring; gx += edgeRow ? 1 : ring * 2 || 1) {
          if (gx < 0 || gx >= gw) continue;
          const cell = gz * gw + gx;
          for (let k = start[cell]; k < start[cell + 1]; k++) {
            const p = items[k];
            const dx = sx[p] - x;
            const dz = sz[p] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = p;
            }
          }
        }
      }
    }
    if (best < 0) return null;
    return {
      x: sx[best],
      z: sz[best],
      dist: Math.sqrt(bestD2),
      waterX: this._shoreWX[best],
      waterZ: this._shoreWZ[best],
    };
  }

  /* --- Overview map ------------------------------------------------------ */

  /**
   * A shaded-relief field-guide map of the whole tile.
   * Pixel (u, v) ↔ world: x = −half + u/px·size (east → right),
   * z = −half + v/px·size (+Z down the canvas, so north = −Z is up).
   * @param {number} px canvas width/height in pixels
   * @returns {HTMLCanvasElement}
   */
  mapCanvas(px = 512) {
    px = Math.max(64, Math.round(px));
    const canvas =
      typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(px, px);
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(px, px);
    const out = img.data;

    const half = this.half;
    const mpp = this.size / px; // metres per pixel
    const sea = this.seaLevel;
    const H = new Float32Array(px * px);
    const fresh = new Float32Array(px * px);
    const shoreDist = new Float32Array(px * px);
    for (let v = 0; v < px; v++) {
      const z = -half + (v + 0.5) * mpp;
      for (let u = 0; u < px; u++) {
        const x = -half + (u + 0.5) * mpp;
        const i = v * px + u;
        H[i] = this._sampleField(this.heights, x, z) - sea;
        fresh[i] = this._sampleField(this._freshField, x, z);
        shoreDist[i] = this._sampleField(this._landDist, x, z);
      }
    }

    const noise = createNoise2D(hash("map", this.seed));
    // Sun from the north-west (top-left), the cartographic convention.
    const lx = -0.55;
    const ly = 0.62;
    const lz = -0.55;
    const lLen = Math.hypot(lx, ly, lz);
    const Lx = lx / lLen;
    const Ly = ly / lLen;
    const Lz = lz / lLen;
    const exaggerate = 2.4;
    const col = [0, 0, 0];
    const paper = MAP.paper;

    for (let v = 0; v < px; v++) {
      const z = -half + (v + 0.5) * mpp;
      const v0 = Math.max(0, v - 1);
      const v1 = Math.min(px - 1, v + 1);
      for (let u = 0; u < px; u++) {
        const x = -half + (u + 0.5) * mpp;
        const i = v * px + u;
        const u0 = Math.max(0, u - 1);
        const u1 = Math.min(px - 1, u + 1);
        const h = H[i];
        const gx = (H[v * px + u1] - H[v * px + u0]) / ((u1 - u0) * mpp);
        const gz = (H[v1 * px + u] - H[v0 * px + u]) / ((v1 - v0) * mpp);
        const gradPx = Math.hypot(gx, gz) * mpp + 1e-4; // metres of rise per pixel

        // Paper grain: fine speckle + soft mottling.
        const grain = (hash01(u, v, 7) - 0.5) * 0.05 + noise(x * 0.004, z * 0.004) * 0.025;

        if (h < 0) {
          // Water: depth-tinted, ocean vs fresh.
          const depth = -h;
          const fw = fresh[i];
          const tO = Math.pow(smoothstep(0, 26, depth), 0.7);
          const tF = Math.pow(smoothstep(0, 7, depth), 0.8);
          for (let c = 0; c < 3; c++) {
            const o = lerp(MAP.oceanShallow[c], MAP.oceanDeep[c], tO);
            const f = lerp(MAP.freshShallow[c], MAP.freshDeep[c], tF);
            col[c] = lerp(o, f, fw);
          }
          // Coastline echo lines in the open sea — the classic engraved-map look.
          if (fw < 0.5) {
            const sd = shoreDist[i];
            let ink = 0;
            const rings = [9, 21, 37, 58, 86];
            for (let r = 0; r < rings.length; r++) {
              const w = 1 - smoothstep(0.35 * mpp, 1.1 * mpp, Math.abs(sd - rings[r]));
              ink = Math.max(ink, w * (0.32 - r * 0.055));
            }
            for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.ink[c] + 30, ink);
          }
        } else {
          // Land: material tint lifted toward paper, then hillshade.
          this._mapColor(x, z, col);
          for (let c = 0; c < 3; c++) col[c] = lerp(col[c], paper[c], 0.2);
          // Gentle hypsometric lift so the high country reads lighter.
          const lift = smoothstep(30, 140, h) * 0.28;
          for (let c = 0; c < 3; c++) col[c] = lerp(col[c], paper[c] + 10, lift);

          const nx = -gx * exaggerate;
          const nz = -gz * exaggerate;
          const nLen = Math.hypot(nx, 1, nz);
          const lam = (nx * Lx + Ly + nz * Lz) / nLen;
          const rel = lam / Ly; // 1 on flat ground
          if (rel < 1) {
            const s = clamp((1 - rel) * 0.95, 0, 0.75);
            for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.shadowTint[c], s);
          } else {
            const s = clamp((rel - 1) * 0.9, 0, 0.45);
            for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.lightTint[c], s);
          }

          // Contours: 10 m, with a stronger index line every 50 m.
          if (h > 2) {
            const d10 = Math.abs(h - Math.round(h / 10) * 10) / gradPx;
            const d50 = Math.abs(h - Math.round(h / 50) * 50) / gradPx;
            const a10 = (1 - smoothstep(0.25, 0.9, d10)) * 0.13;
            const a50 = (1 - smoothstep(0.35, 1.1, d50)) * 0.3;
            const a = Math.max(a10, a50) * (1 - smoothstep(0.9, 2.2, gradPx)); // fade where lines bunch up
            for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.contour[c], a);
          }
        }

        // Shoreline ink (coast, lakes and rivers alike).
        const dShore = Math.abs(h) / gradPx;
        const shoreInk = (1 - smoothstep(0.3, 1.05, dShore)) * 0.85;
        for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.ink[c], shoreInk);

        // Faint graticule every 200 m.
        const gxl = Math.abs(((x + half) % 200) - 100);
        const gzl = Math.abs(((z + half) % 200) - 100);
        const onGrid = Math.max(smoothstep(100 - mpp * 0.55, 100, gxl), smoothstep(100 - mpp * 0.55, 100, gzl));
        for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.ink[c], onGrid * 0.07);

        // Vignette + grain.
        const ex = (u + 0.5) / px - 0.5;
        const ey = (v + 0.5) / px - 0.5;
        const vig = 1 - smoothstep(0.3, 0.75, Math.hypot(ex, ey)) * 0.22;
        const k = vig * (1 + grain);
        const o = i * 4;
        out[o] = clamp(col[0] * k, 0, 255);
        out[o + 1] = clamp(col[1] * k, 0, 255);
        out[o + 2] = clamp(col[2] * k, 0, 255);
        out[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this._mapSymbols(ctx, px);

    // Neat-line frame, like a printed plate.
    const inset = Math.round(px * 0.022) + 0.5;
    ctx.strokeStyle = "rgba(52, 58, 50, 0.55)";
    ctx.lineWidth = Math.max(1, px / 512);
    ctx.strokeRect(inset, inset, px - inset * 2, px - inset * 2);
    ctx.strokeStyle = "rgba(52, 58, 50, 0.25)";
    const inset2 = inset + Math.max(3, px * 0.008);
    ctx.strokeRect(inset2, inset2, px - inset2 * 2, px - inset2 * 2);
    return canvas;
  }

  /** Free GPU resources (the shared detail textures stay cached for reuse). */
  dispose() {
    this._disposed = true;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.heightTexture.dispose();
  }

  /** Point the material at another detail texture set (progressive upgrade). */
  _setSurface(textures) {
    const u = this.mesh.material.userData.uniforms;
    u.terAlbedo.value = textures.albedo;
    u.terNormal.value = textures.normal;
    u.terAvg.value = textures.avg;
  }

  /* --- Generation: layout ------------------------------------------------ */

  _createContext() {
    const tag = (name) => createNoise2D(hash("sauria-terrain", name, this.seed));
    const tagG = (name) => createNoise2DGrad(hash("sauria-terrain", name, this.seed));
    const k = this.size / DESIGN_SIZE;
    return {
      rng: makeRng(hash("sauria-terrain-layout", this.seed)),
      k,
      R: 0.42 * DESIGN_SIZE,
      dHalf: DESIGN_SIZE / 2,
      nWarpA: tag("warpA"),
      nWarpB: tag("warpB"),
      nCoast: tag("coast"),
      nCove: tag("cove"),
      nCliff: tag("cliff"),
      nHills: tagG("hills"),
      nFine: tagG("fine"),
      nDetail: tag("detail"),
      nRidge: tag("ridge"),
      nSpur: tag("spur"),
      nCrag: tag("crag"),
      nRangeWarp: tag("rangeWarp"),
      nPlateau: tag("plateau"),
      nMesa: tag("mesa"),
      nSwamp: tag("swamp"),
      nLake: tag("lake"),
      nMeander: tag("meander"),
      nMoist: tag("moist"),
      nForest: tag("forest"),
      nPatch: tag("patch"),
      nMacro: tag("macro"),
      nOutcrop: tag("outcrop"),
      nMid: tag("mid"),
      // The vertex grid in design metres.
      vgrid: { n: this._n, origin: -this.half / k, step: this.cellSize / k },
      lgrid: { n: LAYOUT_RES + 1, origin: -DESIGN_SIZE / 2, step: DESIGN_SIZE / LAYOUT_RES },
      field: {
        c: 0.5, m: 0.5, wa: 0.5, wb: 0.5, cb: 0.5, mtn: 0.5, hm: 0.5, mm: 0.5, sw: 0.5, cliff: 0.5,
        cliffN: 0.5, swN: 0.5, pn: 0.5, mesaN: 0.5,
        preWa: 0.5, preWb: 0.5, preCb: 0.5, preCliffN: 0.5, preSwN: 0.5, prePn: 0.5, preMesaN: 0.5,
      },
    };
  }

  /**
   * Roll the island's layout (orientation, bays, mountain spine, islets) and
   * sample the large-scale height on the fixed layout grid. Everything that
   * decides WHERE things go reads this grid, never the mesh vertices.
   */
  _layout(g) {
    const { rng, R } = g;
    g.rot = rng() * TAU;
    g.cr = Math.cos(g.rot);
    g.sr = Math.sin(g.rot);
    g.stretch = rand(rng, 1.04, 1.13);

    g.bays = [];
    const bayCount = randInt(rng, 2, 3);
    const bayStart = rng() * TAU;
    for (let b = 0; b < bayCount; b++) {
      const a = bayStart + (b / bayCount) * TAU + rand(rng, -0.45, 0.45);
      const d = R * rand(rng, 0.9, 1.0);
      g.bays.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: R * rand(rng, 0.13, 0.2), depth: rand(rng, 0.16, 0.26) });
    }

    // Mountain spine: a bent quadratic Bézier off to one side of the island.
    const ra = rng() * TAU;
    const rc = R * rand(rng, 0.2, 0.3);
    const cx = Math.cos(ra) * rc;
    const cz = Math.sin(ra) * rc;
    const dirA = ra + Math.PI / 2 + rand(rng, -0.4, 0.4);
    const halfLen = R * rand(rng, 0.44, 0.56);
    const bend = R * rand(rng, -0.22, 0.22);
    const ax = cx - Math.cos(dirA) * halfLen;
    const az = cz - Math.sin(dirA) * halfLen;
    const bx = cx + Math.cos(dirA) * halfLen;
    const bz = cz + Math.sin(dirA) * halfLen;
    const qx = cx + Math.cos(ra) * bend * 2;
    const qz = cz + Math.sin(ra) * bend * 2;
    const spine = [];
    const SPINE_PTS = 28;
    for (let i = 0; i <= SPINE_PTS; i++) {
      const t = i / SPINE_PTS;
      const a0 = (1 - t) * (1 - t);
      const a1 = 2 * (1 - t) * t;
      const a2 = t * t;
      spine.push(a0 * ax + a1 * qx + a2 * bx, a0 * az + a1 * qz + a2 * bz);
    }
    g.spine = spine;
    g.spineLen = polylineLength(spine);
    g.rangeWidth = rand(rng, 100, 125);
    g.spineReach = g.rangeWidth * 3.4 + 90;
    // One flank of the range is a steep escarpment, the other a long slope.
    g.steepSide = rng() < 0.5 ? 1 : -1;

    // Islets: small rocky outcrops in open water, placed on the bare coast field.
    g.islets = [];
    const isletCount = randInt(rng, 2, 4);
    for (let tries = 0; tries < 400 && g.islets.length < isletCount; tries++) {
      const a = rng() * TAU;
      const d = rand(rng, R * 0.95, g.dHalf * 1.25);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (Math.max(Math.abs(x), Math.abs(z)) > g.dHalf - 120) continue;
      const c = this._coast(g, x, z);
      if (c > -0.2 || c < -0.5) continue;
      if (g.islets.some((o) => Math.hypot(o.x - x, o.z - z) < 260)) continue;
      g.islets.push({ x, z, r: rand(rng, 34, 66), peak: rand(rng, 6, 22) });
    }

    // Large-scale height on the layout grid.
    const L = g.lgrid;
    const LN = L.n;
    const sd = new Float32Array(LN * LN).fill(1e9);
    const st = new Float32Array(LN * LN);
    const sg = new Float32Array(LN * LN);
    rasterPolyline(spine, g.spineReach, L, sd, st, sg);
    const rest = new Float32Array(LN * LN);
    const mtn = new Float32Array(LN * LN);
    g.lC = new Float32Array(LN * LN);
    g.lHm = new Float32Array(LN * LN);
    g.lMm = new Float32Array(LN * LN);
    g.lSw = new Float32Array(LN * LN);
    // Low-frequency inputs of the height function, kept so the vertices can
    // interpolate them (Catmull-Rom, C1 — no shading creases) instead of
    // re-evaluating a dozen noise octaves each.
    const pre = ["lWa", "lWb", "lCb", "lCliffN", "lSwN", "lPn", "lMesaN"];
    for (const k of pre) g[k] = new Float32Array(LN * LN);
    g.usePre = false;
    const f = g.field;
    let maxTotal = -Infinity;
    let maxIdx = 0;
    for (let iz = 0; iz < LN; iz++) {
      const z = L.origin + iz * L.step;
      for (let ix = 0; ix < LN; ix++) {
        const x = L.origin + ix * L.step;
        const i = iz * LN + ix;
        rest[i] = this._macro(g, x, z, sd[i], st[i], sg[i]);
        mtn[i] = f.mtn;
        g.lC[i] = f.c;
        g.lHm[i] = f.hm;
        g.lMm[i] = f.mm;
        g.lSw[i] = f.sw;
        g.lWa[i] = f.wa;
        g.lWb[i] = f.wb;
        g.lCb[i] = f.cb;
        g.lCliffN[i] = f.cliffN;
        g.lSwN[i] = f.swN;
        g.lPn[i] = f.pn;
        g.lMesaN[i] = f.mesaN;
        if (rest[i] + mtn[i] > maxTotal) {
          maxTotal = rest[i] + mtn[i];
          maxIdx = i;
        }
      }
    }
    // Scale the mountain layer so the tallest peak lands on maxHeight (the
    // gullies and fine detail added later move it by only a metre or two).
    g.mtnScale = mtn[maxIdx] > 1 ? clamp((this.maxHeight - rest[maxIdx]) / mtn[maxIdx], 0.4, 2) : 1;
    const lH = new Float32Array(LN * LN);
    for (let i = 0; i < LN * LN; i++) lH[i] = rest[i] + mtn[i] * g.mtnScale;
    g.lH = lH;

    // Smoothed slope of the large-scale surface (m/m) — steers the gullies.
    const lGx = new Float32Array(LN * LN);
    const lGz = new Float32Array(LN * LN);
    const s2 = 2 * L.step * 2;
    for (let iz = 0; iz < LN; iz++) {
      for (let ix = 0; ix < LN; ix++) {
        const i = iz * LN + ix;
        const xl = Math.max(0, ix - 2);
        const xr = Math.min(LN - 1, ix + 2);
        const zu = Math.max(0, iz - 2);
        const zd = Math.min(LN - 1, iz + 2);
        lGx[i] = (lH[iz * LN + xr] - lH[iz * LN + xl]) / (((xr - xl) / 4) * s2);
        lGz[i] = (lH[zd * LN + ix] - lH[zu * LN + ix]) / (((zd - zu) / 4) * s2);
      }
    }
    g.lGx = lGx;
    g.lGz = lGz;

    // Low-frequency fields that only steer painting (biomes, materials, tint).
    // Sampled on the layout grid and interpolated, so they cost nothing per
    // vertex and the biome layout is identical at every mesh resolution.
    g.lPatch = new Float32Array(LN * LN);
    g.lMacro = new Float32Array(LN * LN);
    g.lMoist = new Float32Array(LN * LN);
    g.lForest = new Float32Array(LN * LN);
    g.lOutcrop = new Float32Array(LN * LN);
    g.lMid = new Float32Array(LN * LN);
    for (let iz = 0; iz < LN; iz++) {
      const z = L.origin + iz * L.step;
      for (let ix = 0; ix < LN; ix++) {
        const x = L.origin + ix * L.step;
        const i = iz * LN + ix;
        g.lPatch[i] = fbm2D(g.nPatch, x * 0.012, z * 0.012, 2);
        g.lMacro[i] = clamp(0.5 + 0.9 * fbm2D(g.nMacro, x * 0.0045, z * 0.0045, 2), 0, 1);
        g.lMid[i] = fbm2D(g.nMid, x * 0.028, z * 0.028, 2);
        if (lH[i] < -6) continue; // open sea: only patch & tint are ever read
        g.lMoist[i] = fbm2D(g.nMoist, x * 0.0026, z * 0.0026, 3);
        g.lForest[i] = fbm2D(g.nForest, x * 0.0058, z * 0.0058, 3);
        g.lOutcrop[i] = g.lHm[i] + g.lMm[i] > 0 ? ridged2D(g.nOutcrop, x * 0.018, z * 0.018, 2) : 0;
      }
    }
  }

  /**
   * Per-vertex bilinear lookup tables into the layout grid: for vertex column
   * (or row) k, cell index j[k] and weight t[k].
   */
  _layoutLookup(g) {
    const V = g.vgrid;
    const L = g.lgrid;
    const n = V.n;
    const last = L.n - 1;
    const j = new Int32Array(n);
    const t = new Float32Array(n);
    // Catmull-Rom: four clamped taps and weights per vertex column / row.
    const cj = new Int32Array(n * 4);
    const cw = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const l = clamp((V.origin + k * V.step - L.origin) / L.step, 0, last - 0.0001);
      const jj = l | 0;
      const u = l - jj;
      j[k] = jj;
      t[k] = u;
      for (let q = 0; q < 4; q++) cj[k * 4 + q] = clamp(jj + q - 1, 0, last);
      const u2 = u * u;
      const u3 = u2 * u;
      cw[k * 4] = -0.5 * u3 + u2 - 0.5 * u;
      cw[k * 4 + 1] = 1.5 * u3 - 2.5 * u2 + 1;
      cw[k * 4 + 2] = -1.5 * u3 + 2 * u2 + 0.5 * u;
      cw[k * 4 + 3] = 0.5 * u3 - 0.5 * u2;
    }
    return { j, t, cj, cw };
  }

  /** The coast field ("inland-ness": > 0 land, ≈ metres / R), before islets. */
  _coast(g, x, z) {
    return this._coastFine(g, x, z, this._coastBase(g, x, z));
  }

  /**
   * Low-frequency part of the coast field. Also leaves the shared domain
   * warp (g.field.wa/wb) behind for the other layers.
   */
  _coastBase(g, x, z) {
    const R = g.R;
    // One domain warp shared by coast, hills and ridges so landforms flow together.
    const wa = fbm2D(g.nWarpA, x * 0.0013, z * 0.0013, 3);
    const wb = fbm2D(g.nWarpB, x * 0.0013, z * 0.0013, 3);
    const wx = x + 150 * wa;
    const wz = z + 150 * wb;
    g.field.wa = wa;
    g.field.wb = wb;
    const rx = (wx * g.cr + wz * g.sr) / g.stretch;
    const rz = (-wx * g.sr + wz * g.cr) * g.stretch;
    let c = 1 - Math.sqrt(rx * rx + rz * rz) / R;
    c += 0.19 * fbm2D(g.nCoast, x * 0.0029, z * 0.0029, 3);
    for (let b = 0; b < g.bays.length; b++) {
      const bay = g.bays[b];
      const dx = x - bay.x;
      const dz = z - bay.z;
      c -= bay.depth * Math.exp(-(dx * dx + dz * dz) / (bay.r * bay.r));
    }
    // Pull the land in near the tile edge so the margin is always open sea.
    const e = Math.max(Math.abs(x), Math.abs(z));
    c -= 0.55 * smoothstep(g.dHalf - 200, g.dHalf - 30, e);
    return c;
  }

  /**
   * Fine coast detail (coves, ragged headlands), worth ≤ ±0.05, faded in
   * only around the shoreline so it costs nothing inland or far out at sea.
   */
  _coastFine(g, x, z, c) {
    const w = smoothstep(-0.3, -0.2, c) * (1 - smoothstep(0.2, 0.3, c));
    if (w <= 0) return c;
    return (
      c +
      w *
        (0.0135 * g.nCoast(x * 0.0232 + 57.9, z * 0.0232 - 23.2) +
          0.0068 * g.nCoast(x * 0.0464 - 31.3, z * 0.0464 + 77.1) +
          0.035 * g.nCove(x * 0.011, z * 0.011))
    );
  }

  /**
   * The large-scale island surface at a design-space point (metres, sea = 0),
   * excluding the mountain layer, which is returned in `g.field.mtn` along
   * with the masks. `sd`/`st`/`side` are the distance to the mountain spine,
   * the normalised position along it and which side of it the point is on.
   * Shared by the layout grid and the vertices.
   */
  _macro(g, x, z, sd, st, side) {
    const f = g.field;
    const R = g.R;
    const usePre = g.usePre;
    // Low-frequency inputs: evaluated exactly on the layout grid, interpolated
    // from it (g.field.pre*) at the vertices.
    let cb;
    if (usePre) {
      cb = f.preCb;
      f.wa = f.preWa;
      f.wb = f.preWb;
    } else cb = this._coastBase(g, x, z);
    f.cb = cb;
    let c = this._coastFine(g, x, z, cb);
    const wa = f.wa;
    const wb = f.wb;
    const wx = x + 150 * wa;
    const wz = z + 150 * wb;

    // Islets raise the coast field locally and add a rocky crown.
    let crown = 0;
    for (let s = 0; s < g.islets.length; s++) {
      const o = g.islets[s];
      const dx = x - o.x;
      const dz = z - o.z;
      const dd = Math.sqrt(dx * dx + dz * dz);
      if (dd > o.r * 2.5) continue;
      const rr = o.r * (1 + 0.35 * g.nCove(x * 0.02 + s * 7, z * 0.02));
      const ci = ((rr - dd) / R) * 1.4;
      if (ci > c) c = ci;
      const t = 1 - dd / rr;
      if (t > 0) crown = Math.max(crown, o.peak * Math.pow(t, 1.3));
    }

    const m = c * R; // ≈ metres inland (negative offshore)
    // Rocky headlands: stretches of coast that rise in a cliff instead of a beach.
    const cliffN = usePre ? f.preCliffN : fbm2D(g.nCliff, x * 0.0024, z * 0.0024, 2);
    const cliff = smoothstep(0.12, 0.38, cliffN);
    let swN = 0;
    let pn = 0;
    let mesaN = 0;
    let h;
    let mtn = 0;
    let hm = 0;
    let mm = 0;
    let sw = 0;
    if (m < 0) {
      // Sea floor: a shallow shelf off the beaches, then a drop to the deep.
      const mo = -m;
      h = -(0.06 * mo + 28 * smoothstep(12, 170, mo));
      h -= cliff * 5 * smoothstep(0, 30, mo);
      h += 1.4 * g.nDetail(x * 0.01, z * 0.01) * smoothstep(20, 90, mo);
      if (h < -30) h = -30;
      if (crown > 0) h = Math.max(h, crown - 2);
    } else {
      const inland = smoothstep(15, 260, m);
      const fall = smoothstep(0, 48, m); // keeps relief off the beach
      // Beach ramp (never flat at the waterline, so no stray puddles).
      h = 0.04 * m * (1 - inland) + 2.4 * smoothstep(0, 70, m);
      // Rolling country: domain-warped, slope-damped fBm.
      const hills = erodedFbm2D(g.nHills, wx * 0.0034, wz * 0.0034, 5, 2, 0.5, 0.9);
      h += fall * (2.5 + 9 * inland + (5 + 13 * inland) * hills);
      h += cliff * 12 * smoothstep(1, 22, m) * (1 - inland * 0.6);

      // Highlands and mountains along the spine.
      if (sd < 1e8) {
        const w = g.rangeWidth * (0.55 + 0.45 * Math.sin(Math.PI * st));
        const dd = sd + 55 * fbm2D(g.nRangeWarp, x * 0.004, z * 0.004, 2);
        hm = smoothstep(w * 2.6, w * 1.0, dd) * fall;
        if (usePre) {
          pn = f.prePn;
          mesaN = f.preMesaN;
        } else {
          pn = fbm2D(g.nPlateau, x * 0.003, z * 0.003, 3);
          mesaN = fbm2D(g.nMesa, x * 0.0042, z * 0.0042, 2);
        }
        if (hm > 0) {
          // Tableland stepped into plateaus: gentle swells in most places,
          // mesa-like escarpments where the mesa noise says so.
          const mesa = smoothstep(0.1, 0.38, mesaN);
          const hb = h + (22 + 12 * pn) * hm;
          const step = 13;
          // A little mid-frequency wander in the step level keeps escarpment
          // rims from running in straight, machined lines.
          const wander = pn * 12 + 3.5 * g.nDetail(x * 0.017 - 41.7, z * 0.017 + 8.3);
          const tq = (hb + wander) / step;
          const fl = Math.floor(tq);
          const sharp = lerp(0.42, 0.17, mesa);
          const terr = (fl + smoothstep(0.5 - sharp, 0.5 + sharp, tq - fl)) * step - wander;
          h = lerp(hb, terr, hm * (0.3 + 0.62 * mesa));
        }
        if (dd < w * 1.8) {
          // A coherent massif rather than a field of spikes: one crest line
          // with peaks and saddles, spurs running down the flanks (gullies
          // between them come later), one flank steeper than the other.
          const ws = w * (side === g.steepSide ? 0.78 : 1.18);
          mm = smoothstep(ws * 1.5, ws * 0.1, dd);
          if (mm > 0) {
            const along = st * g.spineLen;
            const crest = 0.5 + 0.5 * fbm2D(g.nRidge, along * 0.0048 + 3.1, 7.7, 3);
            const ends = Math.sqrt(Math.sin(Math.PI * clamp(st, 0, 1)));
            const spur = 1 - Math.abs(g.nSpur((along + 30 * wa) / 95, (dd + 30 * wb) / 170));
            const flank = Math.sin(Math.PI * clamp(dd / (ws * 1.5), 0, 1));
            let prof = Math.pow(mm, 1.25);
            prof *= 1 - 0.38 * flank * (1 - spur * spur);
            // Rough crags along the top.
            const crag = mm * mm * mm * ridged2D(g.nCrag, wx * 0.0075, wz * 0.0075, 2);
            mtn = (prof * (18 + 118 * (0.3 + 0.7 * crest) * ends) + 4.5 * crag) * smoothstep(0, 14, m);
          }
        }
      }

      // Swampy lowlands: flatten toward just above sea level. Only ground
      // that is already low sinks, so no trenches through hills.
      swN = usePre ? f.preSwN : fbm2D(g.nSwamp, x * 0.0019, z * 0.0019, 2);
      sw = smoothstep(0.08, 0.34, swN) * (1 - hm) * smoothstep(15, 80, m) * (1 - smoothstep(7, 15, h)) * (1 - cliff);
      if (sw > 0) h = lerp(h, 0.9 + 0.5 * g.nDetail(x * 0.03, z * 0.03), sw * 0.9);
      h += crown;
    }

    // The last stretch to the tile edge sinks to the off-tile depth.
    const e = Math.max(Math.abs(x), Math.abs(z));
    const edge = smoothstep(g.dHalf - 70, g.dHalf - 1, e);
    h = lerp(h, OUTSIDE_HEIGHT, edge);
    f.c = c;
    f.m = m;
    f.mtn = mtn * (1 - edge);
    f.hm = hm;
    f.mm = mm;
    f.sw = sw;
    f.cliff = cliff;
    f.cliffN = cliffN;
    f.swN = swN;
    f.pn = pn;
    f.mesaN = mesaN;
    return h;
  }

  /** Normalised lake distance: < 1 inside the basin (lobed, noise-warped ellipses). */
  _lakeD(g, L, x, z) {
    let d = Infinity;
    for (let q = 0; q < L.lobes.length; q++) {
      const lobe = L.lobes[q];
      const dx = x - lobe.x;
      const dz = z - lobe.z;
      const lx = dx * lobe.ca + dz * lobe.sa;
      const lz = (-dx * lobe.sa + dz * lobe.ca) / lobe.aspect;
      const dd = Math.sqrt(lx * lx + lz * lz) / lobe.r;
      d = d === Infinity ? dd : smin(d, dd, 0.35);
    }
    // The shoreline wobble only matters near the basin; far out the bank is
    // well above the ground anyway, so fade it out instead of paying for it.
    const near = 1 - smoothstep(2.2, 2.7, d);
    if (near <= 0) return d;
    return d / (1 + 0.24 * near * fbm2D(g.nLake, x * 0.011 + L.id * 13, z * 0.011, 3));
  }

  /** Lake basin target height at normalised distance d (metres, sea = 0). */
  _lakeProfile(g, L, x, z, d) {
    if (d < 1) return -L.depth * (1 - d * d) - 0.35 * (1 - d) + 0.4 * g.nDetail(x * 0.05, z * 0.05) * d;
    const out = (d - 1) * L.r;
    return bankProfile(out, 24) + 0.25 * g.nDetail(x * 0.06, z * 0.06);
  }

  /** Pick 3–5 lake sites in the lowlands (on the layout grid). */
  _placeLakes(g) {
    const { rng } = g;
    const L = g.lgrid;
    const LN = L.n;
    const H = g.lH;
    const target = randInt(rng, 3, 5);

    // Candidate sites: well inland, out of the mountains, low ground preferred.
    const pickSites = (minCoast, maxHigh, maxH) => {
      const cands = [];
      for (let t = 0; t < 2500; t++) {
        const ix = randInt(rng, 2, LN - 3);
        const iz = randInt(rng, 2, LN - 3);
        const i = iz * LN + ix;
        if (g.lC[i] < minCoast || g.lHm[i] > maxHigh || g.lMm[i] > 0.02) continue;
        if (H[i] < 0.5 || H[i] > maxH) continue;
        cands.push({ x: L.origin + ix * L.step, z: L.origin + iz * L.step, score: H[i] - g.lSw[i] * 5 + rng() * 7 });
      }
      cands.sort((a, b) => a.score - b.score);
      return cands;
    };

    const lakes = [];
    const tryFill = (cands) => {
      for (const c of cands) {
        if (lakes.length >= target) break;
        const r = lakes.length === 0 ? rand(rng, 70, 92) : rand(rng, 40, 66);
        if (lakes.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < o.r + r + 190)) continue;
        // Keep basins out of the range's footprint.
        let nearSpine = false;
        for (let s = 0; s < g.spine.length; s += 2) {
          if (Math.hypot(g.spine[s] - c.x, g.spine[s + 1] - c.z) < g.rangeWidth * 2.2 + r) {
            nearSpine = true;
            break;
          }
        }
        if (nearSpine) continue;
        // A main ellipse plus one or two overlapping lobes for an irregular shore.
        const angle = rng() * Math.PI;
        const lobes = [{ x: c.x, z: c.z, r, aspect: rand(rng, 0.6, 0.95), angle }];
        const extra = randInt(rng, 1, 2);
        for (let q = 0; q < extra; q++) {
          const a = rng() * TAU;
          const d = r * rand(rng, 0.45, 0.8);
          lobes.push({ x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, r: r * rand(rng, 0.42, 0.66), aspect: rand(rng, 0.55, 0.95), angle: rng() * Math.PI });
        }
        for (const lobe of lobes) {
          lobe.ca = Math.cos(lobe.angle);
          lobe.sa = Math.sin(lobe.angle);
        }
        let reach = 0;
        for (const lobe of lobes) reach = Math.max(reach, Math.hypot(lobe.x - c.x, lobe.z - c.z) + lobe.r / lobe.aspect);
        lakes.push({ id: lakes.length, x: c.x, z: c.z, r, depth: rand(rng, 3.5, 7), lobes, reach: reach * 1.3 + 170 });
      }
    };
    tryFill(pickSites(0.24, 0.25, 22));
    if (lakes.length < 3) tryFill(pickSites(0.16, 0.5, 34));
    g.lakes = lakes;

    // Carve the basins into a copy of the layout heights (for river routing)
    // and mark lake membership on the layout grid.
    const lHc = H.slice();
    const lakeId = new Int8Array(LN * LN).fill(-1);
    for (const lk of lakes) {
      const [ix0, ix1, iz0, iz1] = this._gridBox(L, lk.x, lk.z, lk.reach);
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = L.origin + iz * L.step;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = L.origin + ix * L.step;
          const i = iz * LN + ix;
          const d = this._lakeD(g, lk, x, z);
          lHc[i] = smin(lHc[i], this._lakeProfile(g, lk, x, z, d), 1.4);
          if (d < 0.75) lakeId[i] = lk.id;
        }
      }
    }
    g.lHc = lHc;
    g.lLakeId = lakeId;

    const k = g.k;
    this.lakes = lakes.map((lk) => {
      let area = 0;
      for (const lobe of lk.lobes) area = Math.max(area, lobe.r * lobe.r * lobe.aspect);
      return { x: lk.x * k, z: lk.z * k, r: Math.sqrt(area) * k * 1.15 };
    });
  }

  /** Index box [ix0, ix1, iz0, iz1] of grid points within `reach` of (x, z). */
  _gridBox(grid, x, z, reach) {
    const { n, origin, step } = grid;
    return [
      Math.max(0, Math.floor((x - reach - origin) / step)),
      Math.min(n - 1, Math.ceil((x + reach - origin) / step)),
      Math.max(0, Math.floor((z - reach - origin) / step)),
      Math.min(n - 1, Math.ceil((z + reach - origin) / step)),
    ];
  }

  /** Route 1–2 rivers from the highlands through a lake and/or to the sea (layout grid). */
  _placeRivers(g) {
    const { rng } = g;
    const L = g.lgrid;
    const LN = L.n;
    const H = g.lHc;
    const step = 2; // search on every 2nd layout point (12.5 m)
    const cw = Math.floor((LN - 1) / step) + 1;
    const cellM = L.step * step;
    const lIdx = (node) => ((node / cw) | 0) * step * LN + (node % cw) * step;
    const isOcean = (node) => {
      const v = lIdx(node);
      return H[v] < -0.4 && g.lC[v] < 0;
    };

    // Dijkstra on the coarse grid; low, descending ground is cheap.
    const search = (startNodes, isGoal, blocked) => {
      const dist = new Float64Array(cw * cw).fill(Infinity);
      const prev = new Int32Array(cw * cw).fill(-1);
      const heap = new MinHeap();
      for (const s of startNodes) {
        dist[s] = 0;
        heap.push(0, s);
      }
      while (heap.size) {
        const node = heap.pop();
        if (isGoal(node)) {
          const path = [];
          for (let p = node; p >= 0; p = prev[p]) path.push(p);
          return path.reverse();
        }
        const d0 = dist[node];
        const nx = node % cw;
        const nz = (node / cw) | 0;
        const ha = Math.max(H[lIdx(node)], 0);
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oz) continue;
            const mx = nx + ox;
            const mz = nz + oz;
            if (mx < 1 || mz < 1 || mx >= cw - 1 || mz >= cw - 1) continue;
            const m = mz * cw + mx;
            if (blocked && blocked(m)) continue;
            const hb = Math.max(H[lIdx(m)], 0);
            const len = ox && oz ? cellM * Math.SQRT2 : cellM;
            const cost = len * (1 + Math.pow(hb / 7, 1.5) + 40 * Math.max(0, (hb - ha) / len));
            const nd = d0 + cost;
            if (nd < dist[m]) {
              dist[m] = nd;
              prev[m] = node;
              heap.push(nd, m);
            }
          }
        }
      }
      return null;
    };

    const nodeAt = (x, z) => {
      const ix = Math.round((x - L.origin) / L.step / step);
      const iz = Math.round((z - L.origin) / L.step / step);
      return clamp(iz, 1, cw - 2) * cw + clamp(ix, 1, cw - 2);
    };
    const toDesign = (path) => {
      const pts = [];
      for (const node of path) pts.push(L.origin + (node % cw) * step * L.step, L.origin + ((node / cw) | 0) * step * L.step);
      return pts;
    };
    const lakeNode = (id) => (node) => g.lLakeId[lIdx(node)] === id;

    // Spring candidates on the foothills of the range, relaxed in steps so
    // every seed ends up with its rivers.
    const findSprings = (minHm, maxHm, minH, maxH, maxMtn) => {
      const out = [];
      for (let t = 0; t < 2500; t++) {
        const ix = randInt(rng, 4, LN - 5);
        const iz = randInt(rng, 4, LN - 5);
        const i = iz * LN + ix;
        const hm = g.lHm[i];
        if (hm < minHm || hm > maxHm || g.lMm[i] > maxMtn || g.lC[i] < 0.12) continue;
        if (H[i] < minH || H[i] > maxH) continue;
        out.push({ x: L.origin + ix * L.step, z: L.origin + iz * L.step, h: H[i] });
      }
      return out;
    };
    let springs = findSprings(0.15, 0.8, 7, 20, 0.05);
    if (springs.length < 60) springs = springs.concat(findSprings(0.02, 1, 5, 26, 0.12));
    if (springs.length < 60) springs = springs.concat(findSprings(0, 1, 4, 30, 0.2));

    const segments = []; // { pts (design), w0, w1, d0, d1, mouth, spring }
    const used = [];
    const rejected = [];
    let riverCount = 0;
    const farFromUsed = (s, min) =>
      used.every((u) => Math.hypot(u.x - s.x, u.z - s.z) > min) &&
      rejected.every((u) => Math.hypot(u.x - s.x, u.z - s.z) > 70);
    const endsNearExisting = (pts) =>
      segments.some(
        (sg) => Math.hypot(sg.pts[sg.pts.length - 2] - pts[pts.length - 2], sg.pts[sg.pts.length - 1] - pts[pts.length - 1]) < 60
      );

    // River 1: spring → a lake → out to the sea.
    for (let li = 0; li < g.lakes.length && riverCount === 0; li++) {
      const lk = g.lakes[li];
      const cands = springs
        .map((s) => ({ s, d: Math.hypot(s.x - lk.x, s.z - lk.z) }))
        .filter((o) => o.d > 200 && o.d < 600)
        .sort((a, b) => a.d - b.d);
      for (let c = 0; c < Math.min(3, cands.length); c++) {
        const s = cands[Math.min(cands.length - 1, c * 2 + randInt(rng, 0, 1))].s;
        const inlet = search([nodeAt(s.x, s.z)], lakeNode(li), isOcean);
        if (!inlet || inlet.length < 12) continue;
        const outlet = search([nodeAt(lk.x, lk.z)], isOcean, null);
        segments.push({ pts: toDesign(inlet), w0: 10, w1: 16, d0: 1.5, d1: 2.4, spring: s.h });
        if (outlet && outlet.length > 4) segments.push({ pts: toDesign(outlet), w0: 17, w1: 24, d0: 2.2, d1: 2.8, mouth: true });
        used.push(s);
        riverCount++;
        break;
      }
    }

    // Further rivers: a spring straight to the sea, or into any lake on the way.
    const anyLake = (node) => g.lLakeId[lIdx(node)] >= 0 || isOcean(node);
    for (let attempt = 0; attempt < 18 && riverCount < 2; attempt++) {
      const pool = springs.filter((s) => farFromUsed(s, 380));
      if (!pool.length) break;
      const s = pool[randInt(rng, 0, pool.length - 1)];
      const path = search([nodeAt(s.x, s.z)], anyLake, null);
      const pts = path && toDesign(path);
      // Long enough to read as a river, and not sharing another river's mouth.
      if (!path || polylineLength(pts) < 230 || endsNearExisting(pts)) {
        rejected.push(s);
        continue;
      }
      segments.push({ pts, w0: 11, w1: 21, d0: 1.5, d1: 2.7, mouth: isOcean(path[path.length - 1]), spring: s.h });
      used.push(s);
      riverCount++;
    }
    g.riverCount = riverCount;

    // Smooth, meander and keep the final centrelines (design metres).
    g.riverSegs = segments.map((seg, si) => {
      let pts = chaikin(seg.pts, 3);
      pts = resample(pts, 6);
      // Extend the mouth into open water so the channel meets the sea cleanly.
      if (seg.mouth && pts.length >= 4) {
        const n = pts.length;
        const dx = pts[n - 2] - pts[n - 4];
        const dz = pts[n - 1] - pts[n - 3];
        const len = Math.hypot(dx, dz) || 1;
        pts.push(pts[n - 2] + (dx / len) * 30, pts[n - 1] + (dz / len) * 30);
      }
      // Lateral meander, tapered to zero at both ends so they stay anchored.
      const total = polylineLength(pts);
      const meandered = [pts[0], pts[1]];
      let s = 0;
      for (let i = 2; i < pts.length - 2; i += 2) {
        s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
        const tx = pts[i + 2] - pts[i - 2];
        const tz = pts[i + 3] - pts[i - 1];
        const tl = Math.hypot(tx, tz) || 1;
        const taper = smoothstep(0, 70, s) * smoothstep(0, 70, total - s);
        const off = 16 * g.nMeander(s / 85, si * 9.7) * taper;
        meandered.push(pts[i] - (tz / tl) * off, pts[i + 1] + (tx / tl) * off);
      }
      meandered.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = resample(chaikin(meandered, 1), 10);
      return { ...seg, pts, length: polylineLength(pts) };
    });
    const k = g.k;
    this.rivers = g.riverSegs.map((seg) => {
      const line = [];
      for (let i = 0; i < seg.pts.length; i += 2) line.push({ x: seg.pts[i] * k, z: seg.pts[i + 1] * k });
      return line;
    });
  }

  /* --- Generation: vertices ---------------------------------------------- */

  /** Sample the continuous height function at every mesh vertex. */
  _shapeVertices(g) {
    const n = this._n;
    const N = n * n;
    const H = this.heights;
    const V = g.vgrid;
    const L = g.lgrid;
    const LN = L.n;
    const f = g.field;
    const sd = new Float32Array(N).fill(1e9);
    const st = new Float32Array(N);
    const sg = new Float32Array(N);
    rasterPolyline(g.spine, g.spineReach, V, sd, st, sg);
    g.coast = new Float32Array(N);
    g.highland = new Float32Array(N);
    g.mountain = new Float32Array(N);
    g.swamp = new Float32Array(N);
    g.cliff = new Float32Array(N);
    const lGx = g.lGx;
    const lGz = g.lGz;
    const lC = g.lC;
    const look = this._layoutLookup(g);
    g.look = look;
    const { cj, cw } = look;
    const { lWa, lWb, lCb, lCliffN, lSwN, lPn, lMesaN } = g;
    g.usePre = true;
    // Open sea more than ~190 m out is a flat floor at OUTSIDE_HEIGHT (the
    // shelf formula clamps there); skip the full evaluation unless an islet is near.
    const deepC = -190 / g.R;
    const isletNear = (x, z) => g.islets.some((o) => Math.hypot(x - o.x, z - o.z) < o.r * 2.5 + 40);
    const gullyMinL = 2.6 * V.step;

    for (let iz = 0; iz < n; iz++) {
      const z = V.origin + iz * V.step;
      const jz = look.j[iz];
      const tz = look.t[iz];
      for (let ix = 0; ix < n; ix++) {
        const x = V.origin + ix * V.step;
        const i = iz * n + ix;
        const jx = look.j[ix];
        const tx = look.t[ix];
        const a = jz * LN + jx;
        const cL = (lC[a] + (lC[a + 1] - lC[a]) * tx) * (1 - tz) + (lC[a + LN] + (lC[a + LN + 1] - lC[a + LN]) * tx) * tz;
        if (cL < deepC && sd[i] > 1e8 && !isletNear(x, z)) {
          H[i] = OUTSIDE_HEIGHT;
          g.coast[i] = cL;
          continue;
        }
        // Catmull-Rom interpolation of the low-frequency inputs.
        let pWa = 0;
        let pWb = 0;
        let pCb = 0;
        let pCl = 0;
        let pSw = 0;
        let pPn = 0;
        let pMe = 0;
        for (let r = 0; r < 4; r++) {
          const rb = cj[iz * 4 + r] * LN;
          const wr = cw[iz * 4 + r];
          for (let q = 0; q < 4; q++) {
            const k = rb + cj[ix * 4 + q];
            const wq = wr * cw[ix * 4 + q];
            pWa += wq * lWa[k];
            pWb += wq * lWb[k];
            pCb += wq * lCb[k];
            pCl += wq * lCliffN[k];
            pSw += wq * lSwN[k];
            pPn += wq * lPn[k];
            pMe += wq * lMesaN[k];
          }
        }
        f.preWa = pWa;
        f.preWb = pWb;
        f.preCb = pCb;
        f.preCliffN = pCl;
        f.preSwN = pSw;
        f.prePn = pPn;
        f.preMesaN = pMe;
        let h = this._macro(g, x, z, sd[i], st[i], sg[i]) + f.mtn * g.mtnScale;
        g.coast[i] = f.c;
        g.highland[i] = f.hm;
        g.mountain[i] = f.mm;
        g.swamp[i] = f.sw;
        g.cliff[i] = f.cliff;
        if (f.m > 0) {
          const fall = smoothstep(0, 48, f.m);
          // Fine relief: slope-damped so it settles in hollows and on flats.
          h += fall * (0.55 - 0.35 * f.sw) * erodedFbm2D(g.nFine, x * 0.03, z * 0.03, 3, 2, 0.5, 1.6);
          // Erosion gullies down every real slope, deepest in the mountains.
          const gx =
            (lGx[a] + (lGx[a + 1] - lGx[a]) * tx) * (1 - tz) + (lGx[a + LN] + (lGx[a + LN + 1] - lGx[a + LN]) * tx) * tz;
          const gz =
            (lGz[a] + (lGz[a + 1] - lGz[a]) * tx) * (1 - tz) + (lGz[a + LN] + (lGz[a + LN + 1] - lGz[a + LN]) * tx) * tz;
          const slope = Math.sqrt(gx * gx + gz * gz);
          // Some flanks are deeply furrowed, others smooth.
          const region = 0.2 + 0.8 * smoothstep(-0.25, 0.45, g.nDetail(x * 0.0055 + 17.3, z * 0.0055 - 4.1));
          // Deep gullies belong to the high massif; foothills only get soft rills.
          const zone = 0.4 + 6.5 * f.mm * f.mm + 1.6 * f.hm + 1.3 * f.cliff;
          const amp = zone * region * smoothstep(0.15, 0.7, slope) * fall * smoothstep(1.5, 9, h);
          if (amp > 0.04) h += gullies(x, z, gx, gz, amp, gullyMinL);
        }
        H[i] = h;
      }
    }
    g.usePre = false;
    g.base = H.slice();
  }

  /** Carve lake basins and river valleys into the vertex heights. */
  _carveWater(g) {
    const n = this._n;
    const N = n * n;
    const H = this.heights;
    const V = g.vgrid;

    for (const lk of g.lakes) {
      const [ix0, ix1, iz0, iz1] = this._gridBox(V, lk.x, lk.z, lk.reach);
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = V.origin + iz * V.step;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = V.origin + ix * V.step;
          const i = iz * n + ix;
          const d = this._lakeD(g, lk, x, z);
          let T = this._lakeProfile(g, lk, x, z, d);
          // Fade out at the edge of the influence box (the bank is far above ground there anyway).
          const edgeD = Math.max(Math.abs(x - lk.x), Math.abs(z - lk.z));
          if (edgeD > lk.reach - 20) T = lerp(T, 1e4, smoothstep(lk.reach - 20, lk.reach, edgeD));
          H[i] = smin(H[i], T, 1.4);
        }
      }
    }

    // Rivers: a channel below sea level inside a smooth valley. A spring-fed
    // river starts as a shallow dry gully that deepens over RIVER_HEAD metres,
    // so its head never ends in a carved bowl.
    const dist = new Float32Array(N);
    const param = new Float32Array(N);
    g.channel = new Float32Array(N); // 1 on a centreline … 0 at the channel edge
    for (const seg of g.riverSegs) {
      dist.fill(1e9);
      rasterPolyline(seg.pts, RIVER_REACH, V, dist, param);
      const total = seg.length;
      for (let i = 0; i < N; i++) {
        const d = dist[i];
        if (d >= RIVER_REACH) continue;
        const t = param[i];
        const head = seg.spring !== undefined ? smoothstep(0, RIVER_HEAD, t * total) : 1;
        const hw = lerp(seg.w0, seg.w1, t) * 0.5 * lerp(0.3, 1, head);
        const depth = lerp(seg.d0, seg.d1, t);
        const lift = seg.spring !== undefined ? (1 - head) * (seg.spring + 1.2) : 0;
        let T;
        if (d < hw) {
          T = -depth * (1 - (d / hw) * (d / hw)) - 0.15 + lift;
          g.channel[i] = Math.max(g.channel[i], 1 - d / hw);
        } else {
          // Wobble the bank distance so valley sides aren't perfect offsets of the channel.
          const ix = i % n;
          const iz = (i / n) | 0;
          const wob = g.nDetail((V.origin + ix * V.step) * 0.012 + 91, (V.origin + iz * V.step) * 0.012);
          T = bankProfile((d - hw) * (1 + 0.25 * wob), 20) + lift;
        }
        if (d > RIVER_REACH - 25) T = lerp(T, 1e4, smoothstep(RIVER_REACH - 25, RIVER_REACH, d));
        H[i] = smin(H[i], T, 1.1);
      }
    }
  }

  /** Ocean vs fresh water, plus the distance fields biomes and the map use. */
  _classifyWater(g) {
    const n = this._n;
    const H = this.heights;
    const base = g.base;
    const N = n * n;

    // Carved fresh: was land before lakes/rivers, is water now. Acts as a
    // wall for the ocean flood so river mouths don't salt the whole river.
    const freshCarved = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (H[i] < 0 && base[i] >= 0) freshCarved[i] = 1;

    const wc = new Uint8Array(N);
    const queue = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    const seedOcean = (i) => {
      if (wc[i] === 0 && H[i] < 0 && !freshCarved[i]) {
        wc[i] = W_OCEAN;
        queue[qt++] = i;
      }
    };
    for (let j = 0; j < n; j++) {
      seedOcean(j);
      seedOcean((n - 1) * n + j);
      seedOcean(j * n);
      seedOcean(j * n + n - 1);
    }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % n;
      if (x > 0) seedOcean(i - 1);
      if (x < n - 1) seedOcean(i + 1);
      if (i >= n) seedOcean(i - n);
      if (i < N - n) seedOcean(i + n);
    }
    // Any other water is enclosed: a lake, river or pond.
    let freshCells = 0;
    let land = 0;
    for (let i = 0; i < N; i++) {
      if (H[i] >= 0) {
        wc[i] = W_LAND;
        land++;
      } else if (wc[i] !== W_OCEAN) {
        wc[i] = W_FRESH;
        freshCells++;
      }
    }
    this._waterClass = wc;

    // Count separate bodies of fresh water (lakes joined by rivers count once)
    // and fill stray puddles (< ~60 m²) left by surface noise.
    const minCells = Math.max(3, Math.round(60 / (this.cellSize * this.cellSize)));
    const seen = new Uint8Array(N);
    let bodies = 0;
    let bigBodies = 0;
    for (let i = 0; i < N; i++) {
      if (wc[i] !== W_FRESH || seen[i]) continue;
      qh = 0;
      qt = 0;
      queue[qt++] = i;
      seen[i] = 1;
      let carved = false;
      while (qh < qt) {
        const j = queue[qh++];
        if (freshCarved[j]) carved = true;
        const x = j % n;
        if (x > 0 && wc[j - 1] === W_FRESH && !seen[j - 1]) (seen[j - 1] = 1), (queue[qt++] = j - 1);
        if (x < n - 1 && wc[j + 1] === W_FRESH && !seen[j + 1]) (seen[j + 1] = 1), (queue[qt++] = j + 1);
        if (j >= n && wc[j - n] === W_FRESH && !seen[j - n]) (seen[j - n] = 1), (queue[qt++] = j - n);
        if (j < N - n && wc[j + n] === W_FRESH && !seen[j + n]) (seen[j + n] = 1), (queue[qt++] = j + n);
      }
      if (qt < minCells && !carved) {
        for (let q = 0; q < qt; q++) {
          H[queue[q]] = 0.12;
          wc[queue[q]] = W_LAND;
        }
        freshCells -= qt;
        land += qt;
        continue;
      }
      bodies++;
      if (qt * this.cellSize * this.cellSize >= 400) bigBodies++;
    }

    const cs = this.cellSize;
    const seed = new Uint8Array(N);
    for (let i = 0; i < N; i++) seed[i] = wc[i] === W_OCEAN ? 1 : 0;
    g.oceanDist = chamfer(n, cs, seed);
    for (let i = 0; i < N; i++) seed[i] = wc[i] === W_FRESH ? 1 : 0;
    g.freshDist = chamfer(n, cs, seed);
    for (let i = 0; i < N; i++) seed[i] = wc[i] === W_LAND ? 1 : 0;
    this._landDist = chamfer(n, cs, seed); // kept for the map's coastline echoes

    // Fresh-water weight per vertex, smoothed into the shore so the map can
    // tint lakes/rivers distinctly from the sea with bilinear sampling.
    const freshField = new Float32Array(N);
    for (let i = 0; i < N; i++) freshField[i] = wc[i] === W_FRESH || (wc[i] === W_LAND && g.freshDist[i] < g.oceanDist[i]) ? 1 : 0;
    this._freshField = freshField;

    this.stats.landFraction = land / N;
    this.stats.freshCells = freshCells;
    this.stats.freshArea = Math.round(freshCells * cs * cs);
    this.stats.freshBodies = bigBodies;
    this.stats.ponds = bodies - bigBodies;
    this.stats.lakes = this.lakes.length;
    this.stats.rivers = g.riverCount;
    this.stats.islets = g.islets.length;
  }

  /**
   * Biome per vertex, plus what the mesh needs: six material weights
   * (grass, dry grass, dirt, rock, sand, mud), a cavity/AO term and a
   * macro brightness, all as normalised bytes.
   */
  _paint(g) {
    const n = this._n;
    const N = n * n;
    const H = this.heights;
    const cs = this.cellSize;
    const V = g.vgrid;
    const wc = this._waterClass;
    const biome = new Uint8Array(N);
    const moisture = new Float32Array(N);
    const matA = new Uint8Array(N * 4);
    const matB = new Uint8Array(N * 4);
    const counts = new Uint32Array(BIOMES.length);
    const w = new Float32Array(LAYERS);

    // Cavity at two scales (in metres, so it reads the same at any resolution).
    const blurS = boxBlur(H, n, Math.max(1, Math.round(5 / cs)));
    const blurL = boxBlur(H, n, Math.max(2, Math.round(22 / cs)));
    const look = g.look;
    const LN = g.lgrid.n;
    let a00 = 0;
    let tx = 0;
    let tz = 0;
    const lerpL = (arr) =>
      (arr[a00] + (arr[a00 + 1] - arr[a00]) * tx) * (1 - tz) + (arr[a00 + LN] + (arr[a00 + LN + 1] - arr[a00 + LN]) * tx) * tz;

    for (let iz = 0; iz < n; iz++) {
      tz = look.t[iz];
      const rowL = look.j[iz] * LN;
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const h = H[i];
        a00 = rowL + look.j[ix];
        tx = look.t[ix];

        // Smoothed vertex slope (central differences), 0 flat … 1 vertical.
        const hl = H[ix > 0 ? i - 1 : i];
        const hr = H[ix < n - 1 ? i + 1 : i];
        const hu = H[iz > 0 ? i - n : i];
        const hd = H[iz < n - 1 ? i + n : i];
        const gx = (hr - hl) / ((ix > 0 && ix < n - 1 ? 2 : 1) * cs);
        const gz = (hd - hu) / ((iz > 0 && iz < n - 1 ? 2 : 1) * cs);
        const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
        // Steepest one-sided slope: a sharp break (escarpment, sea cliff) can
        // sit between two vertices whose central difference looks gentle, and
        // top-projected grass or dirt stretched across it reads as streaks.
        // Materials that must not stretch key off this one instead.
        const sx = Math.max(Math.abs(hr - h), Math.abs(h - hl)) / cs;
        const sz = Math.max(Math.abs(hd - h), Math.abs(h - hu)) / cs;
        const steep = 1 - 1 / Math.sqrt(1 + sx * sx + sz * sz);

        const patch = lerpL(g.lPatch); // ±
        const macro = lerpL(g.lMacro);
        const cav = (blurS[i] - h) * 0.08 + (blurL[i] - h) * 0.028;
        let ao = 1 - clamp(cav, 0, 0.5);
        w.fill(0);

        if (h < 0) {
          // Under water: sand and rock on the sea floor, silt in lakes,
          // sand and gravel along river beds.
          const fresh = wc[i] === W_FRESH;
          const depth = -h;
          if (fresh) {
            const ch = g.channel[i];
            w[L_MUD] = 0.6 - 0.4 * ch + 0.2 * patch;
            w[L_SAND] = 0.25 + 0.35 * ch;
            w[L_DIRT] = 0.15 + 0.25 * ch * (0.5 + patch);
          } else {
            w[L_SAND] = 1;
            w[L_ROCK] = smoothstep(0.05, 0.4, patch) * smoothstep(3, 12, depth) * 0.7 + smoothstep(0.15, 0.3, slope);
            w[L_MUD] = smoothstep(-0.1, -0.4, patch) * smoothstep(6, 16, depth) * 0.5;
          }
          biome[i] = fresh ? B_LAKE : B_OCEAN;
          moisture[i] = 1;
        } else {
          const moistN = lerpL(g.lMoist);
          const forestN = lerpL(g.lForest);
          const hm = g.highland[i];
          const freshD = g.freshDist[i];
          const oceanD = g.oceanDist[i];

          let moist =
            0.5 +
            0.8 * moistN +
            0.32 * Math.exp(-freshD / 80) +
            0.35 * g.swamp[i] +
            0.1 * (1 - smoothstep(1, 8, h)) -
            0.25 * smoothstep(28, 60, h);
          moist = clamp(moist, 0, 1);
          moisture[i] = moist;

          // Biome weights.
          const wForest =
            smoothstep(0.5, 0.58, 0.5 + 0.7 * forestN + 0.45 * (moist - 0.5) + 0.22 * Math.sin(Math.PI * clamp(hm * 1.6, 0, 1))) *
            (1 - smoothstep(40, 52, h)) *
            (1 - smoothstep(0.2, 0.32, slope));
          const wSwamp = smoothstep(0.66, 0.74, moist) * (1 - smoothstep(4.5, 7, h)) * (1 - smoothstep(0.03, 0.08, slope));
          const wHigh = smoothstep(36, 46, h + patch * 10);
          const wBeach =
            wc[i] !== W_FRESH && freshD > 25
              ? (1 - smoothstep(2.4, 4, h + patch * 0.8)) * (1 - smoothstep(24, 56, oceanD + patch * 14)) * (1 - smoothstep(0.1, 0.22, slope))
              : 0;
          const outcrop = (hm * 0.8 + g.mountain[i]) * smoothstep(0.62, 0.8, lerpL(g.lOutcrop));
          // High ground is bare rock except on ledges and saddles, which
          // hold thin, dry alpine turf.
          const ledge = 0.45 + 0.55 * smoothstep(0.06, 0.18, steep);
          const wRock = Math.max(
            smoothstep(0.22, 0.36, steep + patch * 0.05),
            g.mountain[i] * smoothstep(75, 120, h + patch * 18) * ledge,
            smoothstep(98, 118, h + patch * 10) * ledge,
            outcrop * 0.85
          );

          // Materials. Rock wins on steep faces; dirt on banks, in forests and
          // along the dry heads of creeks; sand on beaches and some lake
          // shores; mud in swamps and at the fresh-water edge; the rest is
          // grass, drier where the ground is dry, high or near the sea.
          const rock = wRock;
          const midN = lerpL(g.lMid);
          const creek = g.channel[i] * smoothstep(0.3, 1.2, h);
          const freshShore = (1 - smoothstep(2.5, 8, freshD)) * (1 - smoothstep(0.8, 2.4, h));
          const sandyShore = smoothstep(0.05, 0.3, patch);
          const sand = Math.max(wBeach, freshShore * sandyShore * 0.7, creek * 0.25);
          const mud = Math.max(wSwamp * (0.4 + 0.25 * patch + 0.15 * midN), freshShore * (1 - sandyShore) * 0.85, creek * 0.35);
          const dirt = Math.max(
            smoothstep(0.13, 0.26, slope) * 0.7,
            wForest * (0.62 + 0.25 * patch + 0.15 * midN),
            creek * 0.6,
            rock > 0.25 && rock < 0.9 ? 0.3 * (1 - Math.abs(rock - 0.55) * 3) : 0
          ) * (1 - rock * 0.6);
          const used = rock + dirt + sand + mud;
          const veg = Math.max(0, 1 - used);
          // Grassland goes from lush to ochre mostly with moisture (broad
          // regions), with gentler patch / mid-scale variation on top.
          const dry = clamp(
            0.38 - (moist - 0.5) * 1.35 + patch * 0.35 + midN * 0.28 + hm * 0.25 +
              (1 - smoothstep(10, 60, oceanD)) * 0.3 - wForest * 0.4,
            0,
            1
          );
          w[L_ROCK] = rock;
          w[L_DIRT] = dirt;
          w[L_SAND] = sand;
          w[L_MUD] = mud;
          w[L_GRASS] = veg * (1 - dry) + 0.02;
          w[L_DRY] = veg * dry;

          // Forest floors sit in shade; folds and hollows hold it too.
          ao *= 1 - 0.26 * wForest;

          let b = B_PLAINS;
          if (wForest > 0.5) b = B_FOREST;
          if (wSwamp > 0.5) b = B_SWAMP;
          if (wHigh > 0.5) b = B_HIGHLAND;
          if (wBeach > 0.5) b = B_BEACH;
          if (wRock > 0.5) b = B_ROCK;
          biome[i] = b;
          counts[b]++;
        }

        // Normalise and quantise.
        let sum = 0;
        for (let l = 0; l < LAYERS; l++) sum += w[l] = Math.max(0, w[l]);
        const inv = 255 / (sum || 1);
        const o = i * 4;
        matA[o] = Math.round(w[0] * inv);
        matA[o + 1] = Math.round(w[1] * inv);
        matA[o + 2] = Math.round(w[2] * inv);
        matA[o + 3] = Math.round(w[3] * inv);
        matB[o] = Math.round(w[4] * inv);
        matB[o + 1] = Math.round(w[5] * inv);
        matB[o + 2] = Math.round(clamp(ao, 0, 1) * 255);
        matB[o + 3] = Math.round(macro * 255);
      }
    }

    let landN = 0;
    for (let b = B_BEACH; b < BIOMES.length; b++) landN += counts[b];
    const share = {};
    for (let b = B_BEACH; b < BIOMES.length; b++) share[BIOMES[b]] = +(counts[b] / Math.max(1, landN)).toFixed(3);
    this.stats.biomeShare = share;

    this._biome = biome;
    this._moisture = moisture;
    this._matA = matA;
    this._matB = matB;
  }

  /** Land points along every fresh shoreline, bucketed for nearest queries. */
  _collectShore() {
    const n = this._n;
    const H = this.heights;
    const wc = this._waterClass;
    const cs = this.cellSize;
    const sea = this.seaLevel;
    const xs = [];
    const zs = [];
    const wxs = [];
    const wzs = [];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        const h = H[i] - sea;
        if (wc[i] !== W_LAND || h < 0.03) continue;
        let bestJ = -1;
        let bestDir = null;
        for (const d of dirs) {
          const j = i + d[0] + d[1] * n;
          if (wc[j] === W_FRESH && (bestJ < 0 || H[j] < H[bestJ])) {
            bestJ = j;
            bestDir = d;
          }
        }
        if (bestJ < 0) continue;
        const hj = H[bestJ] - sea;
        const edge = (h / (h - hj)) * cs; // metres from this vertex to the waterline
        const back = Math.max(0, edge - 1.0); // stand ~1 m back from the edge
        const px = -this.half + ix * cs;
        const pz = -this.half + iz * cs;
        const sx = px + bestDir[0] * back;
        const sz = pz + bestDir[1] * back;
        if (this.slopeAt(sx, sz) > 0.45 || this.heightAt(sx, sz) < sea + 0.02) continue;
        xs.push(sx);
        zs.push(sz);
        wxs.push(px + bestDir[0] * (edge + 1.5));
        wzs.push(pz + bestDir[1] * (edge + 1.5));
      }
    }
    const count = xs.length;
    this._shoreX = Float32Array.from(xs);
    this._shoreZ = Float32Array.from(zs);
    this._shoreWX = Float32Array.from(wxs);
    this._shoreWZ = Float32Array.from(wzs);

    // Counting-sort into a flat bucket grid → allocation-free queries.
    const gw = Math.ceil(this.size / SHORE_BUCKET);
    const cellOf = new Int32Array(count);
    const start = new Int32Array(gw * gw + 1);
    for (let p = 0; p < count; p++) {
      const bx = clamp(Math.floor((xs[p] + this.half) / SHORE_BUCKET), 0, gw - 1);
      const bz = clamp(Math.floor((zs[p] + this.half) / SHORE_BUCKET), 0, gw - 1);
      cellOf[p] = bz * gw + bx;
      start[cellOf[p] + 1]++;
    }
    for (let c = 0; c < gw * gw; c++) start[c + 1] += start[c];
    const fill = start.slice(0, gw * gw);
    const items = new Int32Array(count);
    for (let p = 0; p < count; p++) items[fill[cellOf[p]]++] = p;
    this._shoreGrid = gw;
    this._shoreStart = start;
    this._shoreItems = items;
    this.stats.shorePoints = count;
  }

  /* --- Rendering --------------------------------------------------------- */

  /**
   * One indexed mesh with smooth (central-difference) normals and the
   * material weights as compact normalised byte attributes.
   */
  _buildMesh(textures) {
    const n = this._n;
    const res = this.resolution;
    const N = n * n;
    const H = this.heights;
    const cs = this.cellSize;
    const half = this.half;
    const pos = new Float32Array(N * 3);
    const nrm = new Int16Array(N * 3);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const h = H[i];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        pos[i * 3] = -half + ix * cs;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = -half + iz * cs;
        const hl = H[ix > 0 ? i - 1 : i];
        const hr = H[ix < n - 1 ? i + 1 : i];
        const hu = H[iz > 0 ? i - n : i];
        const hd = H[iz < n - 1 ? i + n : i];
        const nx = (hl - hr) / ((ix > 0 && ix < n - 1 ? 2 : 1) * cs);
        const nz = (hu - hd) / ((iz > 0 && iz < n - 1 ? 2 : 1) * cs);
        const inv = 32767 / Math.sqrt(nx * nx + 1 + nz * nz);
        nrm[i * 3] = Math.round(nx * inv);
        nrm[i * 3 + 1] = Math.round(inv);
        nrm[i * 3 + 2] = Math.round(nz * inv);
      }
    }
    // Alternate the split diagonal (heightAt mirrors this) so long slopes
    // don't all lean the same way. Cells are emitted chunk by chunk (see
    // CULL_CHUNKS), with a coarse twin of every chunk for beyond the fog.
    const cc = Math.ceil(res / CULL_CHUNKS);
    const nch = Math.ceil(res / cc);
    const index = new Uint32Array(res * res * 6);
    const fineStart = new Int32Array(nch * nch + 1);
    const coarse = [];
    const coarseStart = new Int32Array(nch * nch + 1);
    const box = new Float32Array(nch * nch * 6); // minX, minY, minZ, maxX, maxY, maxZ
    let p = 0;
    for (let cz = 0; cz < nch; cz++) {
      for (let cx = 0; cx < nch; cx++) {
        const ch = cz * nch + cx;
        const x0 = cx * cc;
        const z0 = cz * cc;
        const x1 = Math.min(res, x0 + cc);
        const z1 = Math.min(res, z0 + cc);
        fineStart[ch] = p;
        for (let iz = z0; iz < z1; iz++) {
          for (let ix = x0; ix < x1; ix++) {
            const a = iz * n + ix;
            const b = a + 1;
            const c = a + n;
            const d = c + 1;
            if (((ix + iz) & 1) === 0) {
              index[p++] = a;
              index[p++] = c;
              index[p++] = d;
              index[p++] = a;
              index[p++] = d;
              index[p++] = b;
            } else {
              index[p++] = a;
              index[p++] = c;
              index[p++] = b;
              index[p++] = b;
              index[p++] = c;
              index[p++] = d;
            }
          }
        }
        coarseStart[ch] = coarse.length;
        for (let iz = z0; iz < z1; iz += COARSE_STEP) {
          const jz = Math.min(z1, iz + COARSE_STEP);
          for (let ix = x0; ix < x1; ix += COARSE_STEP) {
            const jx = Math.min(x1, ix + COARSE_STEP);
            const a = iz * n + ix;
            const b = iz * n + jx;
            const c = jz * n + ix;
            const d = jz * n + jx;
            coarse.push(a, c, d, a, d, b);
          }
        }
        let lo = Infinity;
        let hi = -Infinity;
        for (let iz = z0; iz <= z1; iz++) {
          for (let ix = x0; ix <= x1; ix++) {
            const h = H[iz * n + ix];
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        box.set([-half + x0 * cs, lo, -half + z0 * cs, -half + x1 * cs, hi, -half + z1 * cs], ch * 6);
      }
    }
    fineStart[nch * nch] = p;
    coarseStart[nch * nch] = coarse.length;
    this._cull = {
      n: nch,
      fine: index.slice(),
      fineStart,
      coarse: Uint32Array.from(coarse),
      coarseStart,
      box,
      state: new Uint8Array(nch * nch), // what is in the GPU index now: 0 none, 1 coarse, 2 fine
      want: new Uint8Array(nch * nch),
      key: "",
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3, true));
    geo.setAttribute("aMatA", new THREE.BufferAttribute(this._matA, 4, true));
    geo.setAttribute("aMatB", new THREE.BufferAttribute(this._matB, 4, true));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    // Bounds are known; skip scanning the vertices again.
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-half, minH, -half), new THREE.Vector3(half, maxH, half));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.stats.minHeight = minH;
    this.stats.maxHeight = maxH;
    this.stats.triangles = res * res * 2;
    this.stats.vertices = N;

    const mesh = new THREE.Mesh(geo, createTerrainMaterial(textures, this.seaLevel));
    mesh.name = "terrain";
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    geo.index.setUsage(THREE.DynamicDrawUsage);
    this._cull.state.fill(2); // starts with every chunk at full detail
    mesh.onBeforeRender = (renderer, scene, camera) => this._cullChunks(scene, camera);
    return mesh;
  }

  /**
   * Before the terrain draws: keep only frustum chunks in the index buffer
   * (coarse ones where the view depth is past the fog). The buffer is only
   * rewritten when a needed chunk is missing or a lot of what is drawn is no
   * longer needed; the rebuild then keeps a margin so small turns are free.
   */
  _cullChunks(scene, camera) {
    const C = this._cull;
    // Perspective (view) cameras only: a shadow pass would thrash the buffer if the terrain ever cast.
    if (!C || !camera || !camera.isPerspectiveCamera) return;
    _frustum.setFromProjectionMatrix(_projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    camera.getWorldDirection(_camFwd);
    const e = camera.matrixWorld.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    const fogFar = scene && scene.fog && scene.fog.isFog ? scene.fog.far : Infinity;
    const { n, box, state, want, fineStart, coarseStart } = C;
    const tris = (ch, w) => (w === 2 ? fineStart[ch + 1] - fineStart[ch] : w === 1 ? coarseStart[ch + 1] - coarseStart[ch] : 0);
    // `want` gets the set with a margin (what a rebuild would draw); the strict
    // set only decides whether something on screen is missing from the buffer.
    let missing = false;
    let haveTris = 0;
    let wantTris = 0;
    for (let ch = 0; ch < n * n; ch++) {
      const o = ch * 6;
      let strict = 0;
      let wide = 0;
      if (boxInFrustum(box, o, CULL_MARGIN)) {
        // Smallest view depth over the box corners decides fine vs coarse.
        let dmin = Infinity;
        for (let q = 0; q < 8; q++) {
          const d =
            ((q & 1 ? box[o + 3] : box[o]) - px) * _camFwd.x +
            ((q & 2 ? box[o + 4] : box[o + 1]) - py) * _camFwd.y +
            ((q & 4 ? box[o + 5] : box[o + 2]) - pz) * _camFwd.z;
          if (d < dmin) dmin = d;
        }
        wide = dmin < fogFar + CULL_MARGIN ? 2 : 1;
        if (boxInFrustum(box, o, 0)) strict = dmin < fogFar ? 2 : 1;
      }
      want[ch] = wide;
      const s = state[ch];
      if (strict > s) missing = true;
      haveTris += tris(ch, s);
      wantTris += tris(ch, wide);
    }
    if (!missing && haveTris <= wantTris * 1.3 + 6000) return;
    const geo = this.mesh.geometry;
    const dst = geo.index.array;
    let off = 0;
    for (let ch = 0; ch < n * n; ch++) {
      const w = want[ch];
      state[ch] = w;
      if (w === 2) {
        dst.set(C.fine.subarray(fineStart[ch], fineStart[ch + 1]), off);
        off += fineStart[ch + 1] - fineStart[ch];
      } else if (w === 1) {
        dst.set(C.coarse.subarray(coarseStart[ch], coarseStart[ch + 1]), off);
        off += coarseStart[ch + 1] - coarseStart[ch];
      }
    }
    geo.setDrawRange(0, off);
    geo.index.clearUpdateRanges();
    geo.index.addUpdateRange(0, Math.max(3, off));
    geo.index.needsUpdate = true;
    this.stats.drawnTriangles = off / 3;
    this.stats.cullRebuilds = (this.stats.cullRebuilds || 0) + 1;
  }

  /**
   * Heights as a single-channel float texture for the water shader. Texel
   * (ix, iz) holds vertex (ix, iz); sample at uv = ((x + half)/size·res + 0.5)/(res + 1).
   * Shares the `heights` array (no copy).
   */
  _buildHeightTexture() {
    const n = this._n;
    const tex = new THREE.DataTexture(this.heights, n, n, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /* --- Internal sampling ------------------------------------------------- */

  /** Bilinear sample of any per-vertex Float32 field. */
  _sampleField(field, x, z) {
    const res = this.resolution;
    const fx = clamp((x + this.half) / this.cellSize, 0, res);
    const fz = clamp((z + this.half) / this.cellSize, 0, res);
    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= res) ix = res - 1;
    if (iz >= res) iz = res - 1;
    const tx = fx - ix;
    const tz = fz - iz;
    const n = this._n;
    const a = iz * n + ix;
    const top = field[a] + (field[a + 1] - field[a]) * tx;
    const bot = field[a + n] + (field[a + n + 1] - field[a + n]) * tx;
    return top + (bot - top) * tz;
  }

  /** Map colour (sRGB 0..255) at a world point, from the material weights. */
  _mapColor(x, z, out) {
    const res = this.resolution;
    const ix = clamp(Math.round((x + this.half) / this.cellSize), 0, res);
    const iz = clamp(Math.round((z + this.half) / this.cellSize), 0, res);
    const i = iz * this._n + ix;
    const A = this._matA;
    const B = this._matB;
    const o = i * 4;
    const ws = [A[o], A[o + 1], A[o + 2], A[o + 3], B[o], B[o + 1]];
    let sum = 0;
    out[0] = out[1] = out[2] = 0;
    for (let l = 0; l < LAYERS; l++) {
      const wl = ws[l];
      sum += wl;
      out[0] += MAP.layers[l][0] * wl;
      out[1] += MAP.layers[l][1] * wl;
      out[2] += MAP.layers[l][2] * wl;
    }
    const inv = 1 / (sum || 1);
    const shade = 0.88 + 0.24 * (B[o + 3] / 255);
    for (let c = 0; c < 3; c++) out[c] *= inv * shade;
    const b = this._biome[i];
    if (b === B_FOREST) for (let c = 0; c < 3; c++) out[c] = lerp(out[c], MAP.forest[c], 0.62);
    else if (b === B_SWAMP) for (let c = 0; c < 3; c++) out[c] = lerp(out[c], MAP.swamp[c], 0.4);
    return out;
  }

  /** Field-guide symbols: stippled trees in forests, reed tufts in swamps. */
  _mapSymbols(ctx, px) {
    const step = Math.max(4, px / 120);
    const r = Math.max(0.8, px / 640);
    const rng = makeRng(hash("map-symbols", this.seed));
    const mpp = this.size / px;
    ctx.save();
    for (let v = step * 0.5; v < px; v += step) {
      for (let u = step * 0.5; u < px; u += step) {
        const su = u + (rng() - 0.5) * step * 0.8;
        const sv = v + (rng() - 0.5) * step * 0.8;
        const x = -this.half + su * mpp;
        const z = -this.half + sv * mpp;
        if (this.heightAt(x, z) < this.seaLevel + 0.3) continue;
        const b = this.biomeAt(x, z);
        if (b === "forest") {
          if (rng() < 0.25) continue;
          ctx.fillStyle = "rgba(36, 52, 34, 0.55)";
          ctx.beginPath();
          ctx.arc(su, sv, r * (1.1 + rng() * 0.5), 0, TAU);
          ctx.fill();
          ctx.fillStyle = "rgba(170, 186, 140, 0.35)";
          ctx.beginPath();
          ctx.arc(su - r * 0.4, sv - r * 0.4, r * 0.45, 0, TAU);
          ctx.fill();
        } else if (b === "swamp") {
          if (rng() < 0.45) continue;
          ctx.strokeStyle = "rgba(48, 62, 52, 0.55)";
          ctx.lineWidth = Math.max(0.6, r * 0.6);
          ctx.beginPath();
          for (let k = -1; k <= 1; k++) {
            ctx.moveTo(su + k * r * 1.2, sv + r);
            ctx.lineTo(su + k * r * 1.6, sv - r * (k === 0 ? 1.8 : 1.1));
          }
          ctx.moveTo(su - r * 2.2, sv + r * 1.1);
          ctx.lineTo(su + r * 2.2, sv + r * 1.1);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** Water class of the nearest underwater corner of the cell containing (x, z). */
  _waterClassNear(x, z) {
    const res = this.resolution;
    const fx = clamp((x + this.half) / this.cellSize, 0, res);
    const fz = clamp((z + this.half) / this.cellSize, 0, res);
    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= res) ix = res - 1;
    if (iz >= res) iz = res - 1;
    const tx = fx - ix;
    const tz = fz - iz;
    const n = this._n;
    const wc = this._waterClass;
    const a = iz * n + ix;
    let best = W_OCEAN;
    let bestD = Infinity;
    // Corners in (dx, dz) order: a, b, c, d.
    for (let q = 0; q < 4; q++) {
      const ox = q & 1;
      const oz = q >> 1;
      const cls = wc[a + ox + oz * n];
      if (cls === W_LAND) continue;
      const dx = tx - ox;
      const dz = tz - oz;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = cls;
      }
    }
    return best;
  }
}
