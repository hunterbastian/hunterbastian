// The island. A seeded heightfield shaped into one main landmass (noisy coast,
// bays, beaches, an off-centre ridged mountain range with terraced highland
// plateaus, rolling plains, forest belts, swampy lowlands), a few offshore
// islets, freshwater lakes and rivers carved below sea level. Rendered as one
// faceted, vertex-coloured mesh, and queried by everything that walks on it.

import * as THREE from "three";
import { WORLD } from "../config.js";
import { makeRng, rand, randInt, hash } from "../core/rng.js";
import { clamp, lerp, smoothstep, TAU } from "../core/math.js";
import { createNoise2D, fbm2D, ridged2D } from "../core/noise.js";

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
const SHORE_BUCKET = 48; // metres per spatial-hash cell for shore queries
const RIVER_REACH = 230; // design metres a river valley may influence

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/* --- Palette (sRGB, 0..1) ----------------------------------------------- */
// Muted and moody: olive/ochre grass, dark moss under forests, pale sand,
// murky swamps, sage highlands, warm grey rock.

const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const C = {
  sand: hexRgb(0xc9b48a),
  sandDry: hexRgb(0xd6c49c),
  sandWet: hexRgb(0x8c7b5c),
  grassOlive: hexRgb(0x77783c),
  grassOchre: hexRgb(0xa48a4a),
  grassGreen: hexRgb(0x5d6c34),
  forestA: hexRgb(0x37421f),
  forestB: hexRgb(0x4a4f27),
  swampA: hexRgb(0x4b4a2a),
  swampB: hexRgb(0x5f5633),
  highA: hexRgb(0x7c8564),
  highB: hexRgb(0x958f6b),
  rockA: hexRgb(0x7f766c),
  rockB: hexRgb(0x9c9182),
  rockDark: hexRgb(0x5a534c),
  mud: hexRgb(0x4a4130),
  seabedShallow: hexRgb(0x9a8c64),
  seabedDeep: hexRgb(0x1b3a40),
  lakebedDeep: hexRgb(0x22382f),
};

// Field-guide map palette (sRGB 0..255).
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
};

/* --- Small helpers ------------------------------------------------------- */

/** Polynomial smooth minimum — blends carved basins into the land without creases. */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// sRGB → linear lookup, scaled straight to 16-bit attribute values.
const LIN_LUT_SIZE = 1024;
const LIN_LUT = new Uint16Array(LIN_LUT_SIZE + 1);
for (let i = 0; i <= LIN_LUT_SIZE; i++) {
  const c = i / LIN_LUT_SIZE;
  const l = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  LIN_LUT[i] = Math.round(l * 65535);
}
const toLinear16 = (c) => LIN_LUT[(clamp(c, 0, 1) * LIN_LUT_SIZE + 0.5) | 0];

/** Fast integer hash → [0, 1) for per-face colour jitter. */
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

/* --- Terrain -------------------------------------------------------------- */

export class Terrain {
  /**
   * Generate the island. Deterministic for a seed; ~150–300 ms in a browser.
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
    this.resolution = resolution;
    this.cellSize = size / resolution;
    this.seaLevel = seaLevel;
    this.maxHeight = maxHeight;
    this.seed = seed;

    const n = resolution + 1;
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
    this._shapeIsland(g);
    timings.shape = now() - t;
    t = now();
    this._placeLakes(g);
    this._placeRivers(g);
    timings.water = now() - t;
    t = now();
    this._classifyWater(g);
    this._paintBiomes(g);
    timings.biomes = now() - t;

    // Everything above works relative to the sea; store absolute heights.
    if (seaLevel !== 0) for (let i = 0; i < n * n; i++) this.heights[i] += seaLevel;

    t = now();
    this._collectShore();
    this.mesh = this._buildMesh();
    this.heightTexture = this._buildHeightTexture();
    timings.mesh = now() - t;

    this.stats.timings = timings;
    this.stats.genMs = now() - t0;
  }

  /* --- Queries ----------------------------------------------------------- */

  /**
   * Ground height at a world position. Interpolates over the same two
   * triangles per cell the mesh is drawn with, so feet sit exactly on the
   * visible facets. Off the tile → deep ocean.
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
    const fx = (x + this.half) / this.cellSize;
    const fz = (z + this.half) / this.cellSize;
    const res = this.resolution;
    const ix = clamp(Math.round(fx), 0, res);
    const iz = clamp(Math.round(fz), 0, res);
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
          // Land: biome tint lifted toward paper, then hillshade.
          this._sampleColor(x, z, col);
          for (let c = 0; c < 3; c++) col[c] = lerp(col[c] * 255, paper[c], 0.22);
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
        const grid = Math.max(1 - smoothstep(99.2 - mpp * 0.6, 100, gxl) * 0, 0);
        const onGrid = Math.max(smoothstep(100 - mpp * 0.55, 100, gxl), smoothstep(100 - mpp * 0.55, 100, gzl));
        const gridA = onGrid * 0.07 * (grid || 1);
        for (let c = 0; c < 3; c++) col[c] = lerp(col[c], MAP.ink[c], gridA);

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

  /** Free GPU resources. */
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.heightTexture.dispose();
  }

  /* --- Generation -------------------------------------------------------- */

  _createContext() {
    const n = this._n;
    const tag = (name) => createNoise2D(hash("sauria-terrain", name, this.seed));
    return {
      rng: makeRng(hash("sauria-terrain-layout", this.seed)),
      k: this.size / DESIGN_SIZE,
      R: 0.42 * DESIGN_SIZE,
      nWarpA: tag("warpA"),
      nWarpB: tag("warpB"),
      nCoast: tag("coast"),
      nCove: tag("cove"),
      nHills: tag("hills"),
      nDetail: tag("detail"),
      nRidge: tag("ridge"),
      nRangeWarp: tag("rangeWarp"),
      nPlateau: tag("plateau"),
      nSwamp: tag("swamp"),
      nLake: tag("lake"),
      nMeander: tag("meander"),
      nMoist: tag("moist"),
      nForest: tag("forest"),
      nPatch: tag("patch"),
      coast: new Float32Array(n * n), // signed "inland-ness": >0 land, ≈ metres/R
      highland: new Float32Array(n * n), // 0..1 highland/foothill mask
      mountain: new Float32Array(n * n), // 0..1 mountain core mask
      swamp: new Float32Array(n * n), // 0..1 flattened lowland mask
      base: null, // heights before lakes/rivers were carved
      lakeId: new Int8Array(n * n).fill(-1),
    };
  }

  /** Vertex position in design metres (tile authored at 1600 m). */
  _designX(ix, k) {
    return (-this.half + ix * this.cellSize) / k;
  }

  /**
   * Rasterise distance-to-polyline (design metres) into `dist`, keeping the
   * normalised arc length of the nearest point in `param`. Only touches
   * vertices within `radius` of a segment.
   */
  _rasterPolyline(pts, radius, k, dist, param) {
    const n = this._n;
    const cs = this.cellSize;
    const half = this.half;
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
      const ix0 = Math.max(0, Math.floor(((Math.min(x0, x0 + vx) - radius) * k + half) / cs));
      const ix1 = Math.min(n - 1, Math.ceil(((Math.max(x0, x0 + vx) + radius) * k + half) / cs));
      const iz0 = Math.max(0, Math.floor(((Math.min(z0, z0 + vz) - radius) * k + half) / cs));
      const iz1 = Math.min(n - 1, Math.ceil(((Math.max(z0, z0 + vz) + radius) * k + half) / cs));
      for (let iz = iz0; iz <= iz1; iz++) {
        const pz = (-half + iz * cs) / k;
        for (let ix = ix0; ix <= ix1; ix++) {
          const px = (-half + ix * cs) / k;
          let u = len2 > 0 ? ((px - x0) * vx + (pz - z0) * vz) / len2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = px - (x0 + vx * u);
          const dz = pz - (z0 + vz * u);
          const d = Math.sqrt(dx * dx + dz * dz);
          const i = iz * n + ix;
          if (d < radius && d < dist[i]) {
            dist[i] = d;
            if (param) param[i] = (cum[s] + u * segLen) / total;
          }
        }
      }
    }
  }

  /** Coastline, mountains, highlands, plains, swamps and islets. */
  _shapeIsland(g) {
    const { rng, k, R } = g;
    const n = this._n;
    const H = this.heights;
    const dHalf = this.half / k;

    /* Layout dice — all from the seeded rng so the island is reproducible. */
    const rot = rng() * TAU;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const stretch = rand(rng, 1.04, 1.13);

    const bays = [];
    const bayCount = randInt(rng, 2, 3);
    const bayStart = rng() * TAU;
    for (let b = 0; b < bayCount; b++) {
      const a = bayStart + (b / bayCount) * TAU + rand(rng, -0.45, 0.45);
      const d = R * rand(rng, 0.9, 1.0);
      bays.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: R * rand(rng, 0.13, 0.2), depth: rand(rng, 0.16, 0.26) });
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
    const rangeWidth = rand(rng, 100, 125);
    g.spine = spine;
    g.rangeWidth = rangeWidth;

    // Base coast field (before islets) — reused to place the islets.
    const coastAt = (x, z) => {
      const wx = x + 165 * fbm2D(g.nWarpA, x * 0.0012, z * 0.0012, 3);
      const wz = z + 165 * fbm2D(g.nWarpB, x * 0.0012, z * 0.0012, 3);
      const rx = (wx * cr + wz * sr) / stretch;
      const rz = (-wx * sr + wz * cr) * stretch;
      let c = 1 - Math.sqrt(rx * rx + rz * rz) / R;
      // A 5-octave fBm split in two: the coarse octaves everywhere, the fine
      // ones (worth ≤ ±0.05) only near the shoreline where they carve coves.
      c += 0.19 * fbm2D(g.nCoast, x * 0.0029, z * 0.0029, 3);
      if (c > -0.22 && c < 0.25) {
        c += 0.0135 * g.nCoast(x * 0.0232 + 57.9, z * 0.0232 - 23.2);
        c += 0.0068 * g.nCoast(x * 0.0464 - 31.3, z * 0.0464 + 77.1);
        c += 0.035 * g.nCove(x * 0.011, z * 0.011);
      }
      for (let b = 0; b < bays.length; b++) {
        const bay = bays[b];
        const dx = x - bay.x;
        const dz = z - bay.z;
        c -= bay.depth * Math.exp(-(dx * dx + dz * dz) / (bay.r * bay.r));
      }
      // Pull the land in near the tile edge so the margin is always open sea.
      const e = Math.max(Math.abs(x), Math.abs(z));
      c -= 0.55 * smoothstep(dHalf - 200, dHalf - 30, e);
      return c;
    };

    // Islets: small rocky outcrops in the open water.
    const islets = [];
    const isletCount = randInt(rng, 2, 4);
    for (let tries = 0; tries < 400 && islets.length < isletCount; tries++) {
      const a = rng() * TAU;
      const d = rand(rng, R * 0.95, dHalf * 1.25);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (Math.max(Math.abs(x), Math.abs(z)) > dHalf - 120) continue;
      const c = coastAt(x, z);
      if (c > -0.2 || c < -0.5) continue;
      if (islets.some((o) => Math.hypot(o.x - x, o.z - z) < 260)) continue;
      islets.push({ x, z, r: rand(rng, 34, 66), peak: rand(rng, 6, 22) });
    }
    g.islets = islets;

    // Spine distance field (design metres) for the mountain & highland masks.
    const spineDist = new Float32Array(n * n).fill(1e9);
    const spineT = new Float32Array(n * n);
    this._rasterPolyline(spine, rangeWidth * 3.4 + 90, k, spineDist, spineT);

    const mtnPart = new Float32Array(n * n);
    let maxRest = 0;
    let maxTotal = 0;
    let maxIdx = 0;

    for (let iz = 0; iz < n; iz++) {
      const z = this._designX(iz, k);
      for (let ix = 0; ix < n; ix++) {
        const x = this._designX(ix, k);
        const i = iz * n + ix;
        let c = coastAt(x, z);

        // Islets raise the coast field locally and add a rocky crown.
        let isletCrown = 0;
        for (let s = 0; s < islets.length; s++) {
          const o = islets[s];
          const dx = x - o.x;
          const dz = z - o.z;
          const dd = Math.sqrt(dx * dx + dz * dz);
          if (dd > o.r * 2.5) continue;
          const rr = o.r * (1 + 0.35 * g.nCove(x * 0.02 + s * 7, z * 0.02));
          const ci = ((rr - dd) / R) * 1.4;
          if (ci > c) c = ci;
          const t = 1 - dd / rr;
          if (t > 0) isletCrown = Math.max(isletCrown, o.peak * Math.pow(t, 1.3));
        }
        g.coast[i] = c;

        const m = c * R; // ≈ metres inland (negative offshore)
        let h;
        let mtn = 0;
        if (m < 0) {
          // Sea floor: a shallow shelf off the beaches, then a drop to the deep.
          const mo = -m;
          h = -(0.06 * mo + 28 * smoothstep(12, 170, mo));
          h += 1.4 * g.nDetail(x * 0.01, z * 0.01) * smoothstep(20, 90, mo);
          if (h < -30) h = -30;
        } else {
          const inland = smoothstep(20, 240, m);
          const fall = smoothstep(0, 55, m); // keeps relief off the beach
          // Beach ramp (never flat at the waterline, so no stray puddles).
          h = 0.05 * m + 2.0 * smoothstep(0, 60, m);
          const hills = fbm2D(g.nHills, x * 0.0042, z * 0.0042, 4);
          h += fall * (3 + 8 * inland + 10 * hills * (0.4 + 0.6 * inland));

          // Highlands and mountains along the spine.
          const sd = spineDist[i];
          if (sd < 1e8) {
            const st = spineT[i];
            const w = rangeWidth * (0.55 + 0.45 * Math.sin(Math.PI * st));
            const dd = sd + 60 * fbm2D(g.nRangeWarp, x * 0.004, z * 0.004, 2);
            const hm = smoothstep(w * 2.5, w * 0.95, dd) * fall;
            const mm = smoothstep(w * 1.1, w * 0.1, dd);
            g.highland[i] = hm;
            g.mountain[i] = mm;
            if (hm > 0) {
              // Tableland, softly terraced into plateaus with steeper risers.
              const pn = fbm2D(g.nPlateau, x * 0.0032, z * 0.0032, 3);
              const plateau = (24 + 12 * pn) * hm;
              const hb = h + plateau;
              // Noise-shifted steps so the risers wander instead of striping.
              const step = 12;
              const tq = (hb + pn * 14) / step;
              const fl = Math.floor(tq);
              const terr = (fl + smoothstep(0.2, 0.8, tq - fl)) * step - pn * 14;
              h = lerp(hb, terr, hm * 0.55);
            }
            if (mm > 0) {
              // Ridged crests; cliff-steep where the range meets the sea.
              const r = ridged2D(g.nRidge, x * 0.0042, z * 0.0042, 5);
              mtn = mm * mm * (26 + 105 * Math.pow(r, 1.25)) * smoothstep(0, 14, m);
              mtn += mm * 5 * g.nDetail(x * 0.024, z * 0.024);
            }
          }

          // Swampy lowlands: flatten toward just above sea level.
          // Only ground that is already low sinks, so no trenches through hills.
          const sw = fbm2D(g.nSwamp, x * 0.0019, z * 0.0019, 2);
          const S = smoothstep(0.08, 0.34, sw) * (1 - g.highland[i]) * smoothstep(15, 80, m) * (1 - smoothstep(7, 15, h));
          g.swamp[i] = S;
          if (S > 0) h = lerp(h, 0.9 + 0.5 * g.nDetail(x * 0.03, z * 0.03), S * 0.9);

          // Faceted surface detail.
          h += fall * 0.7 * g.nDetail(x * 0.035 + 40, z * 0.035);
          h += isletCrown;
        }
        if (isletCrown > 0 && m < 0) h = Math.max(h, isletCrown - 2);

        // The last stretch to the tile edge sinks to the off-tile depth.
        const e = Math.max(Math.abs(x), Math.abs(z));
        const edge = smoothstep(dHalf - 70, dHalf - 1, e);
        h = lerp(h, OUTSIDE_HEIGHT, edge);
        mtn *= 1 - edge;

        H[i] = h;
        mtnPart[i] = mtn;
        const total = h + mtn;
        if (total > maxTotal) {
          maxTotal = total;
          maxIdx = i;
          maxRest = h;
        }
      }
    }

    // Scale the mountain layer so the tallest peak lands on maxHeight.
    const mtnScale = mtnPart[maxIdx] > 1 ? clamp((this.maxHeight - maxRest) / mtnPart[maxIdx], 0.4, 2) : 1;
    for (let i = 0; i < n * n; i++) H[i] += mtnPart[i] * mtnScale;
    g.base = H.slice();
  }

  /** Pick 3–5 lake sites in the lowlands and carve their basins. */
  _placeLakes(g) {
    const { rng, k } = g;
    const n = this._n;
    const H = this.heights;
    const target = randInt(rng, 3, 5);

    // Candidate sites: well inland, out of the mountains, low ground preferred.
    const pickSites = (minCoast, maxHigh, maxH) => {
      const cands = [];
      for (let t = 0; t < 2500; t++) {
        const ix = randInt(rng, 2, n - 3);
        const iz = randInt(rng, 2, n - 3);
        const i = iz * n + ix;
        if (g.coast[i] < minCoast || g.highland[i] > maxHigh || g.mountain[i] > 0.02) continue;
        if (H[i] < 0.5 || H[i] > maxH) continue;
        cands.push({ x: this._designX(ix, k), z: this._designX(iz, k), score: H[i] - g.swamp[i] * 5 + rng() * 7 });
      }
      cands.sort((a, b) => a.score - b.score);
      return cands;
    };

    const lakes = [];
    const tryFill = (cands) => {
      for (const c of cands) {
        if (lakes.length >= target) break;
        const r = lakes.length === 0 ? rand(rng, 72, 95) : rand(rng, 40, 68);
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
        lakes.push({
          x: c.x,
          z: c.z,
          r,
          depth: rand(rng, 3.5, 7),
          angle: rng() * Math.PI,
          aspect: rand(rng, 0.55, 0.95),
        });
      }
    };
    tryFill(pickSites(0.24, 0.25, 22));
    if (lakes.length < 3) tryFill(pickSites(0.16, 0.5, 34));

    // Carve: a basin below sea level with gently rising banks.
    lakes.forEach((L, id) => {
      const ca = Math.cos(L.angle);
      const sa = Math.sin(L.angle);
      const reach = L.r * 1.4 / L.aspect + 170;
      const ix0 = Math.max(0, Math.floor(((L.x - reach) * k + this.half) / this.cellSize));
      const ix1 = Math.min(n - 1, Math.ceil(((L.x + reach) * k + this.half) / this.cellSize));
      const iz0 = Math.max(0, Math.floor(((L.z - reach) * k + this.half) / this.cellSize));
      const iz1 = Math.min(n - 1, Math.ceil(((L.z + reach) * k + this.half) / this.cellSize));
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = this._designX(iz, k);
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = this._designX(ix, k);
          const i = iz * n + ix;
          const dx = x - L.x;
          const dz = z - L.z;
          const lx = dx * ca + dz * sa;
          const lz = (-dx * sa + dz * ca) / L.aspect;
          const rr = L.r * (1 + 0.3 * fbm2D(g.nLake, x * 0.011 + id * 13, z * 0.011, 3));
          const d = Math.sqrt(lx * lx + lz * lz) / rr;
          let T;
          if (d < 1) {
            T = -L.depth * (1 - d * d) - 0.35 * (1 - d);
            T += 0.4 * g.nDetail(x * 0.05, z * 0.05) * d;
            if (d < 0.75) g.lakeId[i] = id;
          } else {
            const out = (d - 1) * rr;
            T = bankProfile(out, 26) + 0.25 * g.nDetail(x * 0.06, z * 0.06);
            // Fade out at the edge of the influence square (bank is far above ground there anyway).
            const edgeD = Math.max(Math.abs(dx), Math.abs(dz));
            if (edgeD > reach - 20) T = lerp(T, 1e4, smoothstep(reach - 20, reach, edgeD));
          }
          H[i] = smin(H[i], T, 1.4);
        }
      }
    });

    this.lakes = lakes.map((L) => ({ x: L.x * k, z: L.z * k, r: L.r * k * (1 + L.aspect) * 0.5 }));
    g.lakes = lakes;
  }

  /** Route 1–2 rivers from the highlands through a lake and/or to the sea, then carve. */
  _placeRivers(g) {
    const { rng, k } = g;
    const n = this._n;
    const H = this.heights;
    const step = 2; // coarse search grid: every 2nd vertex (10 m)
    const cw = Math.floor((n - 1) / step) + 1;
    const cellM = this.cellSize * step;
    const vIdx = (node) => ((node / cw) | 0) * step * n + (node % cw) * step;
    const isOcean = (node) => {
      const v = vIdx(node);
      return H[v] < -0.4 && g.coast[v] < 0;
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
        const ha = Math.max(H[vIdx(node)], 0);
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oz) continue;
            const mx = nx + ox;
            const mz = nz + oz;
            if (mx < 1 || mz < 1 || mx >= cw - 1 || mz >= cw - 1) continue;
            const m = mz * cw + mx;
            if (blocked && blocked(m)) continue;
            const hb = Math.max(H[vIdx(m)], 0);
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
      const ix = Math.round(((x * k + this.half) / this.cellSize) / step);
      const iz = Math.round(((z * k + this.half) / this.cellSize) / step);
      return clamp(iz, 1, cw - 2) * cw + clamp(ix, 1, cw - 2);
    };
    const toDesign = (path) => {
      const pts = [];
      for (const node of path) {
        pts.push(this._designX((node % cw) * step, k), this._designX(((node / cw) | 0) * step, k));
      }
      return pts;
    };
    const lakeNode = (id) => (node) => g.lakeId[vIdx(node)] === id;

    // Spring candidates on the foothills of the range, relaxed in steps so
    // every seed ends up with its rivers.
    const findSprings = (minHm, maxHm, minH, maxH, maxMtn) => {
      const out = [];
      for (let t = 0; t < 2500; t++) {
        const ix = randInt(rng, 4, n - 5);
        const iz = randInt(rng, 4, n - 5);
        const i = iz * n + ix;
        const hm = g.highland[i];
        if (hm < minHm || hm > maxHm || g.mountain[i] > maxMtn || g.coast[i] < 0.12) continue;
        if (H[i] < minH || H[i] > maxH) continue;
        out.push({ x: this._designX(ix, k), z: this._designX(iz, k) });
      }
      return out;
    };
    let springs = findSprings(0.15, 0.8, 7, 20, 0.05);
    if (springs.length < 60) springs = springs.concat(findSprings(0.02, 1, 5, 26, 0.12));
    if (springs.length < 60) springs = springs.concat(findSprings(0, 1, 4, 30, 0.2));

    const segments = []; // { pts (design), w0, w1, mouth }
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
      const L = g.lakes[li];
      const cands = springs
        .map((s) => ({ s, d: Math.hypot(s.x - L.x, s.z - L.z) }))
        .filter((o) => o.d > 200 && o.d < 600)
        .sort((a, b) => a.d - b.d);
      for (let c = 0; c < Math.min(3, cands.length); c++) {
        const s = cands[Math.min(cands.length - 1, c * 2 + randInt(rng, 0, 1))].s;
        const inlet = search([nodeAt(s.x, s.z)], lakeNode(li), isOcean);
        if (!inlet || inlet.length < 12) continue;
        const outlet = search([nodeAt(L.x, L.z)], isOcean, null);
        segments.push({ pts: toDesign(inlet), w0: 10, w1: 16 });
        if (outlet && outlet.length > 4) segments.push({ pts: toDesign(outlet), w0: 17, w1: 24, mouth: true });
        used.push(s);
        riverCount++;
        break;
      }
    }

    // Further rivers: a spring straight to the sea, or into any lake on the way.
    const anyLake = (node) => g.lakeId[vIdx(node)] >= 0 || isOcean(node);
    for (let attempt = 0; attempt < 18 && riverCount < 2; attempt++) {
      const pool = springs.filter((s) => farFromUsed(s, 380));
      if (!pool.length) break;
      const s = pool[randInt(rng, 0, pool.length - 1)];
      const path = search([nodeAt(s.x, s.z)], anyLake, null);
      const pts = path && toDesign(path);
      // Long enough to read as a river, and not sharing another river's mouth.
      if (!path || polylineLength(pts) < 230 || endsNearExisting(pts)) {
        if (globalThis.DBG) console.log("reject", !!path, path && polylineLength(pts).toFixed(0), path && endsNearExisting(pts), pool.length);
        rejected.push(s);
        continue;
      }
      segments.push({ pts, w0: 11, w1: 21, mouth: isOcean(path[path.length - 1]) });
      used.push(s);
      riverCount++;
    }
    g.riverCount = riverCount;
    if (globalThis.DBG) console.log("springs", springs.length, "rivers", riverCount);

    // Smooth, meander and carve.
    const dist = new Float32Array(n * n);
    const param = new Float32Array(n * n);
    const rivers = [];
    segments.forEach((seg, si) => {
      let pts = chaikin(seg.pts, 3);
      pts = resample(pts, 6);
      // Extend the mouth into open water so the channel meets the sea cleanly.
      if (seg.mouth && pts.length >= 4) {
        const L = pts.length;
        const dx = pts[L - 2] - pts[L - 4];
        const dz = pts[L - 1] - pts[L - 3];
        const len = Math.hypot(dx, dz) || 1;
        pts.push(pts[L - 2] + (dx / len) * 30, pts[L - 1] + (dz / len) * 30);
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
      pts = chaikin(meandered, 1);

      dist.fill(1e9);
      this._rasterPolyline(resample(pts, 12), RIVER_REACH, k, dist, param);

      for (let i = 0; i < n * n; i++) {
        const d = dist[i];
        if (d >= RIVER_REACH) continue;
        const t = param[i];
        const hw = lerp(seg.w0, seg.w1, t) * 0.5;
        const depth = lerp(1.5, 2.7, t);
        let T;
        if (d < hw) T = -depth * (1 - (d / hw) * (d / hw)) - 0.15;
        else {
          // Wobble the bank distance so valley sides aren't perfect offsets of the channel.
          const wob = g.nDetail(this._designX(i % n, k) * 0.012 + 91, this._designX((i / n) | 0, k) * 0.012);
          T = bankProfile((d - hw) * (1 + 0.25 * wob), 22);
        }
        if (d > RIVER_REACH - 25) T = lerp(T, 1e4, smoothstep(RIVER_REACH - 25, RIVER_REACH, d));
        H[i] = smin(H[i], T, 1.1);
      }
      const line = [];
      for (let i = 0; i < pts.length; i += 2) line.push({ x: pts[i] * k, z: pts[i + 1] * k });
      rivers.push(line);
    });
    this.rivers = rivers;
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
    // and fill stray 1–5 vertex puddles left by surface noise.
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
      if (qt < 6 && !carved) {
        for (let q = 0; q < qt; q++) {
          H[queue[q]] = 0.12;
          wc[queue[q]] = W_LAND;
        }
        freshCells -= qt;
        land += qt;
        continue;
      }
      bodies++;
      if (qt >= 20) bigBodies++;
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
    this.stats.freshBodies = bigBodies;
    this.stats.ponds = bodies - bigBodies;
    this.stats.lakes = this.lakes.length;
    this.stats.rivers = g.riverCount;
    this.stats.islets = g.islets.length;
  }

  /** Biome per vertex and the base (sRGB) vertex colours. */
  _paintBiomes(g) {
    const n = this._n;
    const H = this.heights;
    const N = n * n;
    const cs = this.cellSize;
    const k = g.k;
    const wc = this._waterClass;
    const biome = new Uint8Array(N);
    const vcol = new Float32Array(N * 3);
    const moisture = new Float32Array(N);
    const counts = new Uint32Array(BIOMES.length);
    let col0;
    let col1;
    let col2;
    const paint = (c, t) => {
      col0 += (c[0] - col0) * t;
      col1 += (c[1] - col1) * t;
      col2 += (c[2] - col2) * t;
    };

    for (let iz = 0; iz < n; iz++) {
      const z = this._designX(iz, k);
      for (let ix = 0; ix < n; ix++) {
        const x = this._designX(ix, k);
        const i = iz * n + ix;
        const h = H[i];

        // Smoothed vertex slope (central differences).
        const hl = H[ix > 0 ? i - 1 : i];
        const hr = H[ix < n - 1 ? i + 1 : i];
        const hu = H[iz > 0 ? i - n : i];
        const hd = H[iz < n - 1 ? i + n : i];
        const gx = (hr - hl) / (2 * cs);
        const gz = (hd - hu) / (2 * cs);
        const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
        // Curvature: valleys a touch darker, crests lighter — reads the form.
        const lap = hl + hr + hu + hd - 4 * h;

        if (h < -2.5) {
          // Deep enough that only the water tint matters.
          const fresh = wc[i] === W_FRESH;
          const c = fresh ? C.mud : C.seabedShallow;
          vcol[i * 3] = c[0];
          vcol[i * 3 + 1] = c[1];
          vcol[i * 3 + 2] = c[2];
          biome[i] = fresh ? B_LAKE : B_OCEAN;
          moisture[i] = 1;
          continue;
        }

        const patch = fbm2D(g.nPatch, x * 0.012, z * 0.012, 2); // ±
        const moistN = fbm2D(g.nMoist, x * 0.0026, z * 0.0026, 3);
        const forestN = fbm2D(g.nForest, x * 0.0058, z * 0.0058, 3);
        const hm = g.highland[i];

        let moist =
          0.5 +
          0.8 * moistN +
          0.32 * Math.exp(-g.freshDist[i] / 80) +
          0.35 * g.swamp[i] +
          0.1 * (1 - smoothstep(1, 8, h)) -
          0.25 * smoothstep(28, 60, h);
        moist = clamp(moist, 0, 1);
        moisture[i] = moist;

        // Biome weights, painted in priority order (last wins).
        const wForest =
          smoothstep(0.5, 0.58, 0.5 + 0.7 * forestN + 0.45 * (moist - 0.5) + 0.22 * Math.sin(Math.PI * clamp(hm * 1.6, 0, 1))) *
          (1 - smoothstep(40, 52, h));
        const wSwamp = smoothstep(0.66, 0.74, moist) * (1 - smoothstep(4.5, 7, h)) * (1 - smoothstep(0.03, 0.08, slope));
        const wHigh = smoothstep(36, 46, h + patch * 10);
        const wBeach =
          wc[i] !== W_FRESH && g.freshDist[i] > 25
            ? (1 - smoothstep(1.8, 3.4, h + patch * 0.8)) * (1 - smoothstep(18, 44, g.oceanDist[i] + patch * 14))
            : 0;
        const wRock = Math.max(smoothstep(0.17, 0.27, slope + patch * 0.03), smoothstep(98, 118, h + patch * 10));

        // Plains: olive ↔ ochre ↔ greener patches.
        const pt = clamp(0.5 + patch * 1.6, 0, 1);
        col0 = lerp(C.grassOlive[0], C.grassOchre[0], pt);
        col1 = lerp(C.grassOlive[1], C.grassOchre[1], pt);
        col2 = lerp(C.grassOlive[2], C.grassOchre[2], pt);
        paint(C.grassGreen, clamp(moist - 0.45, 0, 0.6));
        let b = B_PLAINS;
        if (wForest > 0) {
          const f = clamp(0.5 + patch * 2, 0, 1);
          paint(f < 0.5 ? C.forestA : C.forestB, wForest * 0.8);
          paint(C.forestA, wForest * (1 - f) * 0.5);
          if (wForest > 0.5) b = B_FOREST;
        }
        if (wSwamp > 0) {
          paint(patch > 0 ? C.swampB : C.swampA, wSwamp * 0.9);
          if (wSwamp > 0.5) b = B_SWAMP;
        }
        if (wHigh > 0) {
          paint(patch > 0 ? C.highB : C.highA, wHigh * 0.9);
          if (wHigh > 0.5) b = B_HIGHLAND;
        }
        if (wBeach > 0) {
          paint(h > 1.2 ? C.sandDry : C.sand, wBeach);
          if (wBeach > 0.5) b = B_BEACH;
        }
        if (wRock > 0) {
          const strata = 0.5 + 0.5 * Math.sin(h * 0.55 + patch * 4);
          col0 = lerp(col0, lerp(C.rockA[0], C.rockB[0], strata), wRock);
          col1 = lerp(col1, lerp(C.rockA[1], C.rockB[1], strata), wRock);
          col2 = lerp(col2, lerp(C.rockA[2], C.rockB[2], strata), wRock);
          if (wRock > 0.5) b = B_ROCK;
        }

        const shade = 1 - clamp(lap * 0.035, -0.07, 0.1);
        vcol[i * 3] = col0 * shade;
        vcol[i * 3 + 1] = col1 * shade;
        vcol[i * 3 + 2] = col2 * shade;
        biome[i] = h < 0 ? (wc[i] === W_FRESH ? B_LAKE : B_OCEAN) : b;
      }
    }

    // Land biome census (by vertex) for stats.
    let landN = 0;
    for (let i = 0; i < N; i++) {
      if (H[i] >= 0) {
        counts[biome[i]]++;
        landN++;
      }
    }
    const share = {};
    for (let b = B_BEACH; b < BIOMES.length; b++) share[BIOMES[b]] = +(counts[b] / Math.max(1, landN)).toFixed(3);
    this.stats.biomeShare = share;

    // Wet/salt flavour of each vertex's nearest water, for the waterline band.
    const salty = new Uint8Array(N);
    for (let i = 0; i < N; i++) salty[i] = g.oceanDist[i] <= g.freshDist[i] ? 1 : 0;

    this._biome = biome;
    this._vcol = vcol;
    this._moisture = moisture;
    this._salty = salty;
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
   * Non-indexed mesh: every triangle gets its own flat colour, which reads
   * as crisp hand-made low-poly facets. Normals and colours use compact
   * normalised integer attributes to keep the ~600k vertices light.
   */
  _buildMesh() {
    const n = this._n;
    const res = this.resolution;
    const H = this.heights;
    const cs = this.cellSize;
    const half = this.half;
    const sea = this.seaLevel;
    const vcol = this._vcol;
    const salty = this._salty;
    const wc = this._waterClass;
    const triCount = res * res * 2;
    const pos = new Float32Array(triCount * 9);
    const nrm = new Int8Array(triCount * 9);
    const col = new Uint16Array(triCount * 9);
    let p = 0;
    const tri = [0, 0, 0];

    const emit = (ix, iz, t, a, b, c) => {
      const n0x = -half + (a % n) * cs;
      const n0z = -half + ((a / n) | 0) * cs;
      const n1x = -half + (b % n) * cs;
      const n1z = -half + ((b / n) | 0) * cs;
      const n2x = -half + (c % n) * cs;
      const n2z = -half + ((c / n) | 0) * cs;
      const h0 = H[a];
      const h1 = H[b];
      const h2 = H[c];

      // Face normal (a→b, a→c winding is counter-clockwise from above).
      const e1x = n1x - n0x;
      const e1y = h1 - h0;
      const e1z = n1z - n0z;
      const e2x = n2x - n0x;
      const e2y = h2 - h0;
      const e2z = n2z - n0z;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      // Base colour = average of the three vertex colours.
      let r = (vcol[a * 3] + vcol[b * 3] + vcol[c * 3]) / 3;
      let gg = (vcol[a * 3 + 1] + vcol[b * 3 + 1] + vcol[c * 3 + 1]) / 3;
      let bb = (vcol[a * 3 + 2] + vcol[b * 3 + 2] + vcol[c * 3 + 2]) / 3;
      const hc = (h0 + h1 + h2) / 3 - sea;

      // Steep facets read as bare rock regardless of biome.
      const rockT = smoothstep(0.84, 0.66, ny) * (hc > 0.4 ? 1 : 0.35);
      if (rockT > 0) {
        const strata = 0.5 + 0.5 * Math.sin(hc * 0.6 + ix * 0.05);
        const dark = smoothstep(0.66, 0.45, ny) * 0.5;
        const rr = lerp(lerp(C.rockA[0], C.rockB[0], strata), C.rockDark[0], dark);
        const rg = lerp(lerp(C.rockA[1], C.rockB[1], strata), C.rockDark[1], dark);
        const rb = lerp(lerp(C.rockA[2], C.rockB[2], strata), C.rockDark[2], dark);
        r = lerp(r, rr, rockT);
        gg = lerp(gg, rg, rockT);
        bb = lerp(bb, rb, rockT);
      }

      // Waterline band and underwater tint. Use the lowest vertex to decide
      // whether this facet belongs to the sea or to fresh water.
      if (hc < 0.9) {
        const low = h0 <= h1 && h0 <= h2 ? a : h1 <= h2 ? b : c;
        const salt = wc[low] === W_OCEAN || (wc[low] === W_LAND && salty[low]);
        const wet = salt ? C.sandWet : C.mud;
        const tw = smoothstep(0.9, -0.3, hc) * 0.85;
        r = lerp(r, wet[0], tw);
        gg = lerp(gg, wet[1], tw);
        bb = lerp(bb, wet[2], tw);
        if (hc < 0) {
          const deep = salt ? C.seabedDeep : C.lakebedDeep;
          const td = Math.pow(smoothstep(0, salt ? 16 : 6, -hc), 0.75);
          if (salt) {
            // Pale submerged sand in the shallows so the sea reads turquoise.
            const ts = smoothstep(0.2, 2.5, -hc) * (1 - td);
            r = lerp(r, C.seabedShallow[0], ts);
            gg = lerp(gg, C.seabedShallow[1], ts);
            bb = lerp(bb, C.seabedShallow[2], ts);
          }
          r = lerp(r, deep[0], td);
          gg = lerp(gg, deep[1], td);
          bb = lerp(bb, deep[2], td);
        }
      }

      // Per-facet jitter: value and a whisper of warmth, for richness.
      const j = hash01(ix, iz, t);
      const v = 1 + (j - 0.5) * 0.09;
      const warm = (hash01(iz, ix, t + 7) - 0.5) * 0.025;
      r = r * v + warm;
      gg = gg * v;
      bb = bb * v - warm;

      const cr = toLinear16(r);
      const cg = toLinear16(gg);
      const cb = toLinear16(bb);
      const inx = Math.round(nx * 127);
      const iny = Math.round(ny * 127);
      const inz = Math.round(nz * 127);
      tri[0] = a;
      tri[1] = b;
      tri[2] = c;
      const xs0 = n0x;
      pos[p] = xs0;
      pos[p + 1] = h0;
      pos[p + 2] = n0z;
      pos[p + 3] = n1x;
      pos[p + 4] = h1;
      pos[p + 5] = n1z;
      pos[p + 6] = n2x;
      pos[p + 7] = h2;
      pos[p + 8] = n2z;
      for (let q = 0; q < 9; q += 3) {
        nrm[p + q] = inx;
        nrm[p + q + 1] = iny;
        nrm[p + q + 2] = inz;
        col[p + q] = cr;
        col[p + q + 1] = cg;
        col[p + q + 2] = cb;
      }
      p += 9;
    };

    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const a = iz * n + ix;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if (((ix + iz) & 1) === 0) {
          emit(ix, iz, 0, a, c, d);
          emit(ix, iz, 1, a, d, b);
        } else {
          emit(ix, iz, 0, a, c, b);
          emit(ix, iz, 1, b, c, d);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3, true));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
    // Bounds are known analytically; skip scanning 600k vertices.
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < H.length; i++) {
      if (H[i] < minH) minH = H[i];
      if (H[i] > maxH) maxH = H[i];
    }
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-half, minH, -half), new THREE.Vector3(half, maxH, half));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.stats.minHeight = minH;
    this.stats.maxHeight = maxH;
    this.stats.triangles = triCount;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "terrain";
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /**
   * Heights as a single-channel texture for the water shader. Texel (ix, iz)
   * holds vertex (ix, iz); sample at uv = ((x + half)/size·res + 0.5)/(res + 1)
   * (plain (x + half)/size is within half a cell). Half-float so linear
   * filtering works on every WebGL2 device (full float needs an extension
   * many phones lack); precision is ~1 cm near the shoreline.
   */
  _buildHeightTexture() {
    const n = this._n;
    const data = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(this.heights[i]);
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
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

  /** Bilinear base colour (sRGB 0..1) into `out`. */
  _sampleColor(x, z, out) {
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
    const v = this._vcol;
    const a = (iz * n + ix) * 3;
    const b = a + 3;
    const c = a + n * 3;
    const d = c + 3;
    for (let k = 0; k < 3; k++) {
      const top = v[a + k] + (v[b + k] - v[a + k]) * tx;
      const bot = v[c + k] + (v[d + k] - v[c + k]) * tx;
      out[k] = top + (bot - top) * tz;
    }
    return out;
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
