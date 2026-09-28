// Procedural height functions. Pure math (no three.js) so the physics,
// the mesh builders and the node tests all agree on the ground.

import { clamp, fbm, lerp, noise2, ridged, sdRoundBox, segmentProject, smoothstep } from '../core/math';
import {
  BRIDGE,
  CABINS,
  CabinSpec,
  ISLAND_A,
  ISLAND_B,
  KNOLL,
  NEAR_BOUNDS,
  OVERLOOK,
  TRAIL_HALF_WIDTH,
  TRAIL_XZ,
} from './layout';

/* ------------------------------------------------------------------ */
/* Islands                                                             */
/* ------------------------------------------------------------------ */

/** Signed distance to the nearest shoreline (negative = on land). */
export function shoreDistance(x: number, z: number) {
  const warp = fbm(x * 0.045, z * 0.045, 3, 11) * 3.2;
  const a = sdRoundBox(x, z, ISLAND_A.cx, ISLAND_A.cz, ISLAND_A.hx, ISLAND_A.hz, ISLAND_A.r);
  const b = sdRoundBox(x, z, ISLAND_B.cx, ISLAND_B.cz, ISLAND_B.hx, ISLAND_B.hz, ISLAND_B.r);
  return Math.min(a, b) + warp;
}

/** Island terrain before any path/plateau shaping. */
export function naturalHeight(x: number, z: number) {
  const sd = shoreDistance(x, z);
  if (sd > 0) {
    // Sea floor shelving away from the shore.
    return -Math.min(7, sd * 0.45) + noise2(x * 0.08, z * 0.08, 2) * 0.3;
  }
  const d = -sd;
  let h = 1.8 * (1 - Math.exp(-d / 4.5)) + d * 0.035;
  // Rocky lumps near the shoreline, calmer inland.
  const rocks = ridged(x * 0.09, z * 0.09, 3, 5);
  h += (rocks - 0.35) * 1.5 * smoothstep(0, 3, d) * (1 - 0.6 * smoothstep(8, 20, d));
  // Gentle rolling snowfields.
  h += fbm(x * 0.02, z * 0.02, 3, 3) * 1.4 * smoothstep(4, 20, d);
  // The village slope rises toward the south.
  h += smoothstep(12, 50, d) * 4 * smoothstep(-10, 30, z);
  // The knoll on the skerry.
  const kx = x - KNOLL.x;
  const kz = z - KNOLL.z;
  h += KNOLL.height * Math.exp(-(kx * kx + kz * kz) / (2 * KNOLL.sigma * KNOLL.sigma)) * smoothstep(0, 7, d);
  return h;
}

/* ------------------------------------------------------------------ */
/* Mountains                                                           */
/* ------------------------------------------------------------------ */

/** Jagged mountain ring around the fjord plus a peak behind the village.
 * Returns a large negative number where there are no mountains. */
export function mountainHeight(x: number, z: number) {
  const ex = (x + 20) / 560;
  const ez = (z - 30) / 430;
  const r = Math.hypot(ex, ez) + fbm(x * 0.0018, z * 0.0018, 3, 21) * 0.22;
  let env = smoothstep(1.0, 1.32, r);
  // An opening to the open sea in the north-west gives a far horizon.
  const a = Math.atan2(ez, ex);
  const gap = Math.exp(-((a + 2.25) * (a + 2.25)) / 0.06);
  env *= 1 - 0.95 * gap;

  let h = -60;
  if (env > 0) {
    const wx = x + fbm(x * 0.003, z * 0.003, 2, 41) * 120;
    const wz = z + fbm(x * 0.003, z * 0.003, 2, 43) * 120;
    const n = ridged(wx * 0.0034, wz * 0.0034, 5, 7);
    // Sharpen into distinct peaks: tall where ridges meet, lower saddles between.
    const peaks = Math.pow(n, 1.6);
    const far = smoothstep(1.3, 2.4, r); // back ranges rise a little higher
    h = env * (18 + peaks * (430 + far * 260) + fbm(x * 0.013, z * 0.013, 2, 9) * 22) - 14;
  }
  // Backdrop peak rising straight out of the water behind the village.
  const px = x - -60;
  const pz = z - 330;
  const pd = Math.hypot(px * 0.8, pz);
  if (pd < 190) {
    const cone = Math.pow(1 - pd / 190, 1.3);
    const jag = ridged(x * 0.012 + 3.1, z * 0.012, 4, 13);
    h = Math.max(h, cone * (300 + jag * 110) - 12 + (jag - 0.5) * 50 * cone);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Trail + plateau shaping                                             */
/* ------------------------------------------------------------------ */

interface TrailSample {
  x: number;
  z: number;
  y: number;
}

let trailCache: TrailSample[] | null = null;

/** Densified trail with smoothed heights that follow the natural ground. */
export function trailSamples(): TrailSample[] {
  if (trailCache) return trailCache;
  const pts: TrailSample[] = [];
  for (let i = 0; i < TRAIL_XZ.length - 1; i++) {
    const a = TRAIL_XZ[i];
    const b = TRAIL_XZ[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = lerp(a.x, b.x, t);
      const z = lerp(a.z, b.z, t);
      pts.push({ x, z, y: naturalHeight(x, z) });
    }
  }
  const last = TRAIL_XZ[TRAIL_XZ.length - 1];
  pts.push({ x: last.x, z: last.z, y: naturalHeight(last.x, last.z) });

  // Start flush with the bridge landing.
  pts[0].y = BRIDGE.endY - 0.05;
  // Smooth heights (moving average, several passes).
  for (let pass = 0; pass < 6; pass++) {
    const ys = pts.map((p) => p.y);
    for (let i = 1; i < pts.length - 1; i++) {
      let s = 0;
      let c = 0;
      for (let k = -4; k <= 4; k++) {
        const j = clamp(i + k, 0, pts.length - 1);
        s += ys[j];
        c++;
      }
      pts[i].y = s / c;
    }
    pts[0].y = BRIDGE.endY - 0.05;
  }
  // Keep the grade gentle (<= ~20 degrees) so it always stays walkable.
  const maxGrade = 0.36;
  for (let i = 1; i < pts.length; i++) {
    const run = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].y = clamp(pts[i].y, pts[i - 1].y - run * maxGrade, pts[i - 1].y + run * maxGrade);
  }
  trailCache = pts;
  return pts;
}

export function overlookHeight() {
  const t = trailSamples();
  return t[t.length - 1].y;
}

/** Nearest trail sample info (distance + interpolated height). */
export function trailQuery(x: number, z: number) {
  const pts = trailSamples();
  let best = Infinity;
  let y = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const q = segmentProject(x, z, a.x, a.z, b.x, b.z);
    if (q.dist < best) {
      best = q.dist;
      y = lerp(a.y, b.y, q.t);
    }
  }
  return { dist: best, y };
}

/* ------------------------------------------------------------------ */
/* Cabin pads                                                          */
/* ------------------------------------------------------------------ */

/** Resolved floor height for each cabin (ground cabins sit on a level pad). */
export const cabinFloors: number[] = CABINS.map((c) =>
  c.stilts ? c.floorY : naturalHeight(c.x, c.z) + 0.45,
);

function cabinLocal(c: CabinSpec, x: number, z: number) {
  const dx = x - c.x;
  const dz = z - c.z;
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  // Inverse rotation (three.js rotates +y counter-clockwise when viewed from above).
  return { lx: dx * cs - dz * sn, lz: dx * sn + dz * cs };
}

/* ------------------------------------------------------------------ */
/* Final terrain                                                       */
/* ------------------------------------------------------------------ */

export function inNearBounds(x: number, z: number) {
  return x >= NEAR_BOUNDS.minX && x <= NEAR_BOUNDS.maxX && z >= NEAR_BOUNDS.minZ && z <= NEAR_BOUNDS.maxZ;
}

/** Height of the walkable/near terrain. */
export function terrainHeight(x: number, z: number) {
  let h = naturalHeight(x, z);

  // Skerry trail + overlook plateau.
  if (x > 15 && x < 100 && z > -45 && z < 25) {
    const tq = trailQuery(x, z);
    const w = 1 - smoothstep(TRAIL_HALF_WIDTH, TRAIL_HALF_WIDTH + 3.5, tq.dist);
    if (w > 0) h = lerp(h, tq.y, w);
    const od = Math.hypot(x - OVERLOOK.x, z - OVERLOOK.z);
    const w2 = 1 - smoothstep(OVERLOOK.radius, OVERLOOK.radius + 4, od);
    if (w2 > 0) h = lerp(h, overlookHeight() + (noise2(x * 0.4, z * 0.4, 8) * 0.12), w2);
  }

  // Cabins: level pads for ground cabins, clearance under stilted ones.
  for (let i = 0; i < CABINS.length; i++) {
    const c = CABINS[i];
    const { lx, lz } = cabinLocal(c, x, z);
    const ex = Math.abs(lx) - c.w / 2;
    const ez = Math.abs(lz) - c.d / 2;
    const outside = Math.max(ex, ez);
    if (outside > 4) continue;
    if (c.stilts) {
      if (outside < 0.8) h = Math.min(h, cabinFloors[i] - 0.5);
    } else {
      const w = 1 - smoothstep(0.6, 4, outside);
      h = lerp(h, cabinFloors[i] - 0.45, w);
    }
  }

  return Math.max(h, mountainHeight(x, z));
}

/** Coarse height used for the far mountain mesh (hidden inside the near area). */
export function farHeight(x: number, z: number) {
  const pad = 6;
  if (
    x > NEAR_BOUNDS.minX + pad &&
    x < NEAR_BOUNDS.maxX - pad &&
    z > NEAR_BOUNDS.minZ + pad &&
    z < NEAR_BOUNDS.maxZ - pad
  ) {
    return -40;
  }
  return Math.max(mountainHeight(x, z), inNearBounds(x, z) ? -40 : -8);
}

/** Approximate terrain slope (rise over run) using central differences. */
export function terrainSlope(x: number, z: number) {
  const e = 0.35;
  const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}
