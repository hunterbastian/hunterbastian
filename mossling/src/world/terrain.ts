import * as THREE from "three";
import { COLORS } from "../palette";
import { lambert } from "../ps1";
import { fbm, valueNoise } from "./noise";
import { groundTexture } from "./textures";

// A little glen: a soft meadow bowl ringed by hills, with a pond and a few
// winding dirt paths. Everything here is analytic so props and the creature
// can ask "how high is the ground here?" and get the same answer as the mesh.

export const WORLD_SIZE = 150;
export const PLAY_RADIUS = 44;
export const WATER_LEVEL = -0.35;

export const POND = { x: 13, z: -5, r: 7.5 };

export const PATHS: [number, number][][] = [
  // spawn → cottage
  [[0, 12], [-2, 5], [-7, -1], [-12, -6], [-16, -9]],
  // spawn → pond shore → standing stones
  [[0, 12], [4, 7], [6, 1], [5, -8], [3, -16], [1, -24]],
  // cottage → old tree knoll
  [[-16, -9], [-21, -2], [-23, 6], [-20, 13]],
  // stones → east meadow
  [[1, -24], [11, -21], [20, -15], [25, -4]],
];

const STEP = 1.25;
const CELLS = Math.round(WORLD_SIZE / STEP);
const HALF = WORLD_SIZE / 2;

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function pathDistance(x: number, z: number): number {
  // Wobble the lookup a touch so paths meander instead of running dead straight.
  const wx = x + (valueNoise(x * 0.3, z * 0.3) - 0.5) * 1.2;
  const wz = z + (valueNoise(x * 0.3 + 40, z * 0.3) - 0.5) * 1.2;
  let d = Infinity;
  for (const p of PATHS)
    for (let i = 0; i < p.length - 1; i++)
      d = Math.min(d, distToSegment(wx, wz, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]));
  return d;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0 outside the pond, rising to 1 at its deepest point (irregular shoreline). */
export function pondMask(x: number, z: number): number {
  const dx = x - POND.x;
  const dz = z - POND.z;
  const a = Math.atan2(dz, dx);
  const wobble = 1 + 0.16 * Math.sin(a * 3 + 0.7) + 0.08 * Math.sin(a * 5 - 1.3);
  const d = Math.hypot(dx, dz) / wobble;
  return 1 - smoothstep(POND.r * 0.2, POND.r, d);
}

function rawHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let h = fbm(x * 0.035, z * 0.035, 3) * 1.8;
  h += fbm(x * 0.13 + 7, z * 0.13 - 3, 2) * 0.35 * (1 - smoothstep(2.6, 0.8, pathDistance(x, z)) * 0.8);
  // Hills ringing the glen so the world feels tucked-in.
  const rim = smoothstep(PLAY_RADIUS - 8, HALF - 6, r);
  h += rim * rim * (16 + fbm(x * 0.05 + 3, z * 0.05, 3) * 8);
  // A soft knoll for the old tree.
  h += Math.exp(-((x + 20) ** 2 + (z - 14) ** 2) / 40) * 1.6;
  // Level ground around the cottage.
  const cottage = Math.exp(-((x + 17) ** 2 + (z + 13) ** 2) / 30);
  h = h * (1 - cottage) + 0.4 * cottage;
  return h;
}

export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z);
  const dx = x - POND.x;
  const dz = z - POND.z;
  const near = smoothstep(POND.r + 7, POND.r, Math.hypot(dx, dz));
  h = h * (1 - near) + (WATER_LEVEL + 0.4) * near;
  h -= pondMask(x, z) * 1.6;
  return h;
}

// Heights baked on the render grid; groundAt() interpolates the exact same
// triangles the player sees, so feet never float or sink.
const grid = new Float32Array((CELLS + 1) * (CELLS + 1));
for (let iz = 0; iz <= CELLS; iz++)
  for (let ix = 0; ix <= CELLS; ix++) grid[iz * (CELLS + 1) + ix] = heightAt(-HALF + ix * STEP, -HALF + iz * STEP);

const g = (ix: number, iz: number) => grid[iz * (CELLS + 1) + ix];

export function groundAt(x: number, z: number): number {
  const gx = Math.max(0, Math.min(CELLS - 1e-4, (x + HALF) / STEP));
  const gz = Math.max(0, Math.min(CELLS - 1e-4, (z + HALF) / STEP));
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const h00 = g(ix, iz);
  const h10 = g(ix + 1, iz);
  const h01 = g(ix, iz + 1);
  const h11 = g(ix + 1, iz + 1);
  if (fx + fz < 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

export function groundNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 0.4;
  return out.set(groundAt(x - e, z) - groundAt(x + e, z), 2 * e, groundAt(x, z - e) - groundAt(x, z + e)).normalize();
}

function faceColor(x: number, z: number, y: number, slope: number, out: THREE.Color) {
  const c = new THREE.Color();
  const n = fbm(x * 0.09 + 11, z * 0.09 - 5, 2) * 0.5 + 0.5;
  out.set(COLORS.grassDark).lerp(c.set(COLORS.grass), smoothstep(0.25, 0.6, n));
  out.lerp(c.set(COLORS.moss), smoothstep(0.62, 0.85, n) * 0.8);
  // Sun-bleached meadow patches.
  const meadow = valueNoise(x * 0.05 - 20, z * 0.05 + 9);
  out.lerp(c.set(0xa3a852), smoothstep(0.6, 0.85, meadow) * 0.55);
  // Dirt paths.
  const pd = pathDistance(x, z);
  out.lerp(c.set(COLORS.dirt), smoothstep(1.35, 0.7, pd));
  // Sandy pond edge and dark wet bottom (only around the pond itself).
  const shore = smoothstep(POND.r + 3.5, POND.r + 1, Math.hypot(x - POND.x, z - POND.z));
  out.lerp(c.set(COLORS.sand), shore * smoothstep(WATER_LEVEL + 0.45, WATER_LEVEL + 0.1, y));
  out.lerp(c.set(0x3f5a4a), shore * smoothstep(WATER_LEVEL - 0.1, WATER_LEVEL - 0.4, y) * 0.75);
  // Rocky slopes on the rim.
  out.lerp(c.set(COLORS.rock), smoothstep(0.55, 0.8, slope) * 0.85);
  // Distant hills go deep and cool.
  out.lerp(c.set(COLORS.pine), smoothstep(6, 16, y) * 0.5);
}

export function createTerrain(): THREE.Mesh {
  const tris = CELLS * CELLS * 2;
  const pos = new Float32Array(tris * 9);
  const uv = new Float32Array(tris * 6);
  const col = new Float32Array(tris * 9);
  const color = new THREE.Color();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let t = 0;

  // Colors live on grid vertices so paths, shores and meadows blend across
  // each triangle — the dither pass turns those blends into soft stipple.
  const W = CELLS + 1;
  const vcol = new Float32Array(W * W * 3);
  for (let iz = 0; iz < W; iz++)
    for (let ix = 0; ix < W; ix++) {
      const x = -HALF + ix * STEP;
      const z = -HALF + iz * STEP;
      const y = g(ix, iz);
      const dx = g(Math.min(ix + 1, CELLS), iz) - g(Math.max(ix - 1, 0), iz);
      const dz = g(ix, Math.min(iz + 1, CELLS)) - g(ix, Math.max(iz - 1, 0));
      n.set(-dx, 4 * STEP, -dz).normalize();
      faceColor(x, z, y, 1 - n.y, color);
      vcol.set([color.r, color.g, color.b], (iz * W + ix) * 3);
    }

  const pushTri = (ia: number[], ib: number[], ic: number[]) => {
    const ids = [ia, ib, ic];
    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) verts[k].set(-HALF + ids[k][0] * STEP, g(ids[k][0], ids[k][1]), -HALF + ids[k][1] * STEP);
    // A whisper of per-face shading keeps the facets readable.
    const mx = (a.x + b.x + c.x) / 3;
    const mz = (a.z + b.z + c.z) / 3;
    const j = 1 + (valueNoise(mx * 3.1, mz * 3.1) - 0.5) * 0.08;
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      const ci = (ids[k][1] * W + ids[k][0]) * 3;
      pos.set([v.x, v.y, v.z], t * 9 + k * 3);
      uv.set([v.x / 3, v.z / 3], t * 6 + k * 2);
      col.set([vcol[ci] * j, vcol[ci + 1] * j, vcol[ci + 2] * j], t * 9 + k * 3);
    }
    t++;
  };

  for (let iz = 0; iz < CELLS; iz++)
    for (let ix = 0; ix < CELLS; ix++) {
      pushTri([ix, iz], [ix, iz + 1], [ix + 1, iz]);
      pushTri([ix, iz + 1], [ix + 1, iz + 1], [ix + 1, iz]);
    }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, lambert({ vertexColors: true, map: groundTexture() }));
  mesh.name = "terrain";
  return mesh;
}
