// Seeded 2D simplex noise plus the two fractal flavours the world is built
// from: fBm (soft rolling shapes) and ridged multifractal (mountain spines).
// Pure math, no allocations per sample, deterministic for a given seed.

import { makeRng } from "./rng.js";

/* --- Simplex constants ---------------------------------------------------- */

const F2 = 0.5 * (Math.sqrt(3) - 1); // skew into simplex space
const G2 = (3 - Math.sqrt(3)) / 6; // unskew back

// 16 unit gradients evenly spread around the circle (offset by half a step so
// none align with the axes). More, evenly spaced directions than the classic
// 12 "grad3" vectors means fewer axis-aligned artefacts in ridges and coasts.
const GRAD_COUNT = 16;
const GRAD_X = new Float64Array(GRAD_COUNT);
const GRAD_Y = new Float64Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  const a = ((i + 0.5) / GRAD_COUNT) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

// Scales the raw kernel sum into [-1, 1]. Measured empirically for the
// 16-direction unit gradient set above (raw peak ≈ 0.0101); the final clamp
// guards the rare overshoot.
const SCALE = 99;

/**
 * Create a seeded 2D simplex noise function.
 * @param {number} seed
 * @returns {(x: number, y: number) => number} noise in [-1, 1]
 */
export function createNoise2D(seed = 1) {
  const rng = makeRng(seed);
  // Fisher–Yates shuffle of 0..255, doubled so lookups never need wrapping.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permGrad = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permGrad[i] = perm[i] % GRAD_COUNT;
  }

  return function noise2D(x, y) {
    // Which simplex cell are we in?
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    // Upper or lower triangle of the skewed square.
    let i1;
    let j1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permGrad[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GRAD_X[g] * x0 + GRAD_Y[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permGrad[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GRAD_X[g] * x1 + GRAD_Y[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permGrad[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GRAD_X[g] * x2 + GRAD_Y[g] * y2);
    }
    const v = n * SCALE;
    return v > 1 ? 1 : v < -1 ? -1 : v;
  };
}

/* --- Fractal sums --------------------------------------------------------- */

// Each octave is shifted by an irrational-ish offset so the octaves don't all
// share a lattice origin (which shows up as a visible "knot" at 0,0).
const OCT_OX = 19.31;
const OCT_OY = -7.73;

/**
 * Fractal Brownian motion: a sum of octaves, normalised by total amplitude.
 * @returns {number} ≈ [-1, 1] (typically within ±0.6)
 */
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq + o * OCT_OX, y * freq + o * OCT_OY);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal (Musgrave): sharp crests where the noise crosses zero.
 * Each octave is weighted by the previous one so detail piles up on the
 * ridges and valleys stay smooth — reads like eroded mountain spines.
 * @returns {number} [0, 1]
 */
export function ridged2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * freq + o * OCT_OX, y * freq + o * OCT_OY));
    n *= n;
    n *= weight;
    weight = n * 2;
    if (weight > 1) weight = 1;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
