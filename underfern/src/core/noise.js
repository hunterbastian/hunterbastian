// Seeded 2D simplex noise plus the fractal flavours the world is built from:
// fBm (soft rolling shapes), ridged multifractal (mountain spines) and an
// "eroded" fBm that uses the noise's analytic gradient to keep slopes smooth
// and pile detail onto flats and crests, the way weathering does.
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

/** Seeded permutation tables shared by both simplex flavours. */
function makePermutation(seed) {
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
  return { perm, permGrad };
}

/**
 * Create a seeded 2D simplex noise function.
 * @param {number} seed
 * @returns {(x: number, y: number) => number} noise in [-1, 1]
 */
export function createNoise2D(seed = 1) {
  const { perm, permGrad } = makePermutation(seed);

  function noise2D(x, y) {
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
  }
  // Exposed so the fractal sums below can run the kernel inline (see there).
  noise2D.perm = perm;
  noise2D.permGrad = permGrad;
  return noise2D;
}

/**
 * Seeded 2D simplex noise that also reports its analytic gradient. For the
 * same seed its value matches `createNoise2D` (minus the final clamp), so the
 * two can be mixed freely.
 * @param {number} seed
 * @returns {(x: number, y: number, out: Float64Array | number[]) => number}
 *   noise ≈ [-1, 1]; writes ∂n/∂x into out[0] and ∂n/∂y into out[1]
 */
export function createNoise2DGrad(seed = 1) {
  const { perm, permGrad } = makePermutation(seed);

  function noise2DGrad(x, y, out) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
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
    let dx = 0;
    let dy = 0;

    // Each corner contributes t⁴·(g·d) with t = ½ − |d|²; its gradient is
    // t⁴·g − 8·t³·(g·d)·d.
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permGrad[ii + perm[jj]];
      const gx = GRAD_X[g];
      const gy = GRAD_Y[g];
      const gd = gx * x0 + gy * y0;
      const t2 = t0 * t0;
      const t4 = t2 * t2;
      const k = -8 * t2 * t0 * gd;
      n += t4 * gd;
      dx += t4 * gx + k * x0;
      dy += t4 * gy + k * y0;
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permGrad[ii + i1 + perm[jj + j1]];
      const gx = GRAD_X[g];
      const gy = GRAD_Y[g];
      const gd = gx * x1 + gy * y1;
      const t2 = t1 * t1;
      const t4 = t2 * t2;
      const k = -8 * t2 * t1 * gd;
      n += t4 * gd;
      dx += t4 * gx + k * x1;
      dy += t4 * gy + k * y1;
    }
    let t2c = 0.5 - x2 * x2 - y2 * y2;
    if (t2c > 0) {
      const g = permGrad[ii + 1 + perm[jj + 1]];
      const gx = GRAD_X[g];
      const gy = GRAD_Y[g];
      const gd = gx * x2 + gy * y2;
      const t2 = t2c * t2c;
      const t4 = t2 * t2;
      const k = -8 * t2 * t2c * gd;
      n += t4 * gd;
      dx += t4 * gx + k * x2;
      dy += t4 * gy + k * y2;
    }
    out[0] = dx * SCALE;
    out[1] = dy * SCALE;
    return n * SCALE;
  }
  noise2DGrad.perm = perm;
  noise2DGrad.permGrad = permGrad;
  return noise2DGrad;
}

/* --- Fractal sums --------------------------------------------------------- */
// Performance note: the simplex kernel is too big for V8 to inline, and every
// non-inlined call boxes its double arguments and result on the heap. With
// tens of millions of samples per island that garbage dominated generation
// time, so the sums below run the kernel inline (same maths as noise2D) when
// the noise came from createNoise2D, and fall back to calling it otherwise.

// Each octave is shifted by an irrational-ish offset so the octaves don't all
// share a lattice origin (which shows up as a visible "knot" at 0,0).
const OCT_OX = 19.31;
const OCT_OY = -7.73;

/**
 * Fractal Brownian motion: a sum of octaves, normalised by total amplitude.
 * @returns {number} ≈ [-1, 1] (typically within ±0.6)
 */
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  const perm = noise.perm;
  const permGrad = noise.permGrad;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const px = x * freq + o * OCT_OX;
    const py = y * freq + o * OCT_OY;
    let v;
    if (perm === undefined) v = noise(px, py);
    else {
      const s = (px + py) * F2;
      const i = Math.floor(px + s);
      const j = Math.floor(py + s);
      const t = (i + j) * G2;
      const x0 = px - (i - t);
      const y0 = py - (j - t);
      const i1 = x0 > y0 ? 1 : 0;
      const j1 = 1 - i1;
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
      v = n * SCALE;
      v = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    sum += amp * v;
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
    // One octave at a time through fbm2D's inline kernel (1 octave = plain noise).
    let n = 1 - Math.abs(fbm2D(noise, x * freq + o * OCT_OX, y * freq + o * OCT_OY, 1));
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

const gradScratch = new Float64Array(2);

/**
 * "Eroded" fBm (after Iñigo Quilez): every octave is damped by the slope the
 * previous octaves already built, so steep flanks stay clean and smooth while
 * small detail settles on flats, crests and valley floors — a cheap stand-in
 * for weathering that never produces spiky noise on hillsides.
 * @param {(x: number, y: number, out: Float64Array) => number} noiseGrad from createNoise2DGrad
 * @param {number} erosion how strongly accumulated slope suppresses detail (≈ 0.5–2)
 * @returns {number} ≈ [-1, 1] (typically within ±0.6)
 */
export function erodedFbm2D(noiseGrad, x, y, octaves = 5, lacunarity = 2, gain = 0.5, erosion = 1) {
  const perm = noiseGrad.perm;
  const permGrad = noiseGrad.permGrad;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  let dx = 0;
  let dy = 0;
  for (let o = 0; o < octaves; o++) {
    const px = x * freq + o * OCT_OX;
    const py = y * freq + o * OCT_OY;
    let n;
    let gx;
    let gy;
    if (perm === undefined) {
      n = noiseGrad(px, py, gradScratch);
      gx = gradScratch[0];
      gy = gradScratch[1];
    } else {
      // Inline copy of noise2DGrad (see the performance note above).
      const s = (px + py) * F2;
      const i = Math.floor(px + s);
      const j = Math.floor(py + s);
      const t = (i + j) * G2;
      const x0 = px - (i - t);
      const y0 = py - (j - t);
      const i1 = x0 > y0 ? 1 : 0;
      const j1 = 1 - i1;
      const x1 = x0 - i1 + G2;
      const y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2;
      const y2 = y0 - 1 + 2 * G2;
      const ii = i & 255;
      const jj = j & 255;
      n = 0;
      gx = 0;
      gy = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) {
        const g = permGrad[ii + perm[jj]];
        const gd = GRAD_X[g] * x0 + GRAD_Y[g] * y0;
        const t2 = t0 * t0;
        const t4 = t2 * t2;
        const k = -8 * t2 * t0 * gd;
        n += t4 * gd;
        gx += t4 * GRAD_X[g] + k * x0;
        gy += t4 * GRAD_Y[g] + k * y0;
      }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) {
        const g = permGrad[ii + i1 + perm[jj + j1]];
        const gd = GRAD_X[g] * x1 + GRAD_Y[g] * y1;
        const t2 = t1 * t1;
        const t4 = t2 * t2;
        const k = -8 * t2 * t1 * gd;
        n += t4 * gd;
        gx += t4 * GRAD_X[g] + k * x1;
        gy += t4 * GRAD_Y[g] + k * y1;
      }
      let t2c = 0.5 - x2 * x2 - y2 * y2;
      if (t2c > 0) {
        const g = permGrad[ii + 1 + perm[jj + 1]];
        const gd = GRAD_X[g] * x2 + GRAD_Y[g] * y2;
        const t2 = t2c * t2c;
        const t4 = t2 * t2;
        const k = -8 * t2 * t2c * gd;
        n += t4 * gd;
        gx += t4 * GRAD_X[g] + k * x2;
        gy += t4 * GRAD_Y[g] + k * y2;
      }
      n *= SCALE;
      gx *= SCALE;
      gy *= SCALE;
    }
    // Slope of the sum so far, in the units of the first octave.
    dx += gx * amp * freq;
    dy += gy * amp * freq;
    sum += (amp * n) / (1 + erosion * (dx * dx + dy * dy));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
