// Small, dependency-free math + noise helpers shared by world generation,
// physics and tests. Everything is deterministic so the world is identical
// on every load.

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Mulberry32 — tiny seeded PRNG. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number, seed: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1]. */
export function noise2(x: number, z: number, seed = 0) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz) * 2 - 1;
}

/** Fractal value noise, roughly in [-1, 1]. */
export function fbm(x: number, z: number, octaves = 4, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f, z * f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1] — sharp crests, used for jagged peaks. */
export function ridged(x: number, z: number, octaves = 5, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x * f, z * f, seed + i * 31));
    n *= n;
    n *= weight;
    weight = clamp(n * 1.6, 0, 1);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum / norm;
}

/** Signed distance to a rounded box on the XZ plane (negative inside). */
export function sdRoundBox(px: number, pz: number, cx: number, cz: number, hx: number, hz: number, r: number) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qz = Math.abs(pz - cz) - (hz - r);
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - r;
}

export interface Vec2 {
  x: number;
  z: number;
}

/** Closest point on segment AB to P, returned as parameter t in [0,1] and distance. */
export function segmentProject(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return { t, dist: Math.hypot(px - cx, pz - cz) };
}
