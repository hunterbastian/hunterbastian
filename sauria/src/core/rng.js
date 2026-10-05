// Seeded randomness. Everything procedural in Sauria (terrain, vegetation,
// spawns, patterns) draws from these so a seed reproduces the same island.

/** mulberry32 — tiny, fast, good-enough PRNG. Returns floats in [0, 1). */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [lo, hi). */
export const rand = (rng, lo, hi) => lo + rng() * (hi - lo);

/** Uniform integer in [lo, hi] (inclusive). */
export const randInt = (rng, lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));

/** Pick one element of an array. */
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Pick a key from { key: weight } proportionally to weight. */
export function weightedPick(rng, weights) {
  let total = 0;
  for (const k in weights) total += weights[k];
  let r = rng() * total;
  for (const k in weights) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}

/** Stable 32-bit hash of integers / strings — for per-cell or per-id seeds. */
export function hash(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}
