// Caves. A heightfield can't overhang, so every cave is built from three parts:
//
//  1. A trench carved into the PHYSICS heightfield (terrain.heights): the cave
//     floor, flat a little past the foot of the vault, with steep walls that
//     stay hidden in rock. Everything that walks keeps using heightAt.
//  2. The RENDER surface (terrain._surfH) keeps the original hillside over the
//     roofed part, so from outside the mountain looks untouched; the terrain
//     mesh leaves out the few grid cells around each mouth and skylight.
//  3. Its own small mesh: the floor and the vaulted rock of the interior, and at
//     each mouth an apron, a rock face with the arched opening and a skirt that
//     re-draw the hillside over the left-out cells — so the opening is clean at
//     any mesh resolution. A skylight is a shaft up to the surface with a lip.
//
// Layout decisions (where caves go, how big, their floors) are made on the
// fixed layout grid, so a seed gives the same caves at every resolution. All
// planning maths is in design metres (the terrain's 1600 m authoring tile).

import * as THREE from "three";
import { makeRng, rand, hash } from "../core/rng.js";
import { clamp, lerp, smoothstep, TAU } from "../core/math.js";
import { createNoise2D } from "../core/noise.js";

/* --- Tuning ------------------------------------------------------------------ */

export const CAVE_STEP = 1.5; // design metres between centreline samples
const APPROACH = 8; // open cut in front of a mouth
const ROCK_MIN = 3.5; // rock left over the vault at a mouth (m)
const FLOOR_MARGIN = 3; // the physics floor stays flat this far past the vault's foot
const WALL_SLOPE = 2.5; // physics trench walls (always hidden in rock)
const FACE_A = 0.6; // the portal face starts this far in front of the roof line
const VAULT_Q = 2.6; // superellipse exponent of the vault cross-section (flatter crown, steeper walls)
const FIELD_STEP = 1; // metres per cell of the runtime query grid
const MIN_LIGHT = 0.15; // baked light in the darkest depths (dim, never pitch black by day)

/**
 * Cave kinds. Mouth sizes decide who can get in: a den admits raptors and
 * smaller (an adult Allosaurus is too tall), a tunnel admits Stegosaurus and
 * Allosaurus but not a Tyrannosaurus, the cavern admits anything but the
 * sauropods. W = floor half-width where the vault meets it, C = clearance at
 * the crown. Interior widths/heights grow a little, with noise.
 */
const KINDS = {
  den: { len: [18, 28], mouthW: 3.9, mouthC: 3.2, cap: 4.5, slope: [-0.03, 0.04], bend: 0.35, label: "Den" },
  tunnel: { len: [36, 115], mouthW: 5.0, mouthC: 4.4, cap: 0, slope: [0, 0], bend: 0.3, label: "Tunnel" },
  cavern: { len: [84, 100], mouthW: 7.5, mouthC: 7.5, cap: 5, slope: [-0.06, -0.025], bend: 0.12, label: "Cavern" },
};

/** Floor half-width and clearance at `s` metres past the (first) mouth. */
function kindProfile(kind, s, L, sB) {
  if (kind === "den") {
    const k = smoothstep(0, 7, s);
    const back = smoothstep(L - 11, L - 4, s);
    return [lerp(3.9, 4.6, k) + 1.0 * back, lerp(3.2, 3.8, k) + 0.7 * back];
  }
  if (kind === "tunnel") {
    const k = smoothstep(0, 14, Math.min(s, sB - s));
    return [lerp(5.0, 6.4, k), lerp(4.4, 5.5, k)];
  }
  // Cavern: entrance passage → great chamber → narrow back passage.
  const open = smoothstep(14, 32, s);
  const close = smoothstep(L - 34, L - 18, s);
  const W = lerp(lerp(7.5, 7.0, smoothstep(0, 14, s)), 20, open * (1 - close)) * (1 - close) + lerp(10, 5, smoothstep(L - 24, L - 10, s)) * close;
  const C = lerp(7.5, 15.5, open * (1 - close)) * (1 - close) + lerp(9, 4.4, smoothstep(L - 24, L - 10, s)) * close;
  return [W, C];
}

/* --- Small polyline helpers (design metres) --------------------------------- */

/**
 * Distance from every grid point within `radius` of a polyline, the arc
 * length (metres) of the nearest point and which side (±1) of the line it is.
 */
function rasterLine(pts, cum, radius, grid, dist, sOut, side) {
  const { n, origin, step } = grid;
  const segs = pts.length / 2 - 1;
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
          sOut[i] = cum[s] + u * segLen;
          side[i] = vx * (pz - z0) - vz * (px - x0) >= 0 ? 1 : -1;
        }
      }
    }
  }
}

/* --- Planning ------------------------------------------------------------------ */

/**
 * Pick cave sites on the layout grid: one great cavern (with a skylight), one
 * tunnel with two mouths, and 2–3 dens, each at the foot of a cliff or steep
 * hillside, roofed by enough rock, reachable on foot, clear of water, routes
 * and each other.
 * @param {object} ctx { seed, ground(x,z), mountain(x,z), coast(x,z), reach(x,z) → bool,
 *                       avoid: [{ x, z, r }], half } — all design metres
 * @returns {object[]} cave designs
 */
export function planCaves(ctx) {
  const rng = makeRng(hash("underfern-caves", "layout", ctx.seed));
  const noise = createNoise2D(hash("underfern-caves", "bend", ctx.seed));
  const G = ctx.ground;
  const caves = [];

  // Candidate mouths: walkable ground at the foot of something steep.
  const cands = [];
  const lim = ctx.half - 140;
  for (let t = 0; t < 7000; t++) {
    const x = rand(rng, -lim, lim);
    const z = rand(rng, -lim, lim);
    const h = G(x, z);
    if (h < 3 || h > 150 || ctx.coast(x, z) < 0.08) continue;
    // Gentle where the animal stands…
    const gx = (G(x + 4, z) - G(x - 4, z)) / 8;
    const gz = (G(x, z + 4) - G(x, z - 4)) / 8;
    if (Math.hypot(gx, gz) > 0.3) continue;
    // …and a big rise a little way off in some direction (the face to dig into).
    let bestRise = 0;
    let bestA = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      const rise = G(x + Math.cos(a) * 18, z + Math.sin(a) * 18) - h;
      if (rise > bestRise) {
        bestRise = rise;
        bestA = a;
      }
    }
    if (bestRise < 8) continue;
    if (!ctx.reach(x, z)) continue;
    if (ctx.avoid.some((o) => Math.hypot(o.x - x, o.z - z) < o.r)) continue;
    cands.push({ x, z, h, a: bestA, rise: bestRise, mtn: ctx.mountain(x, z) });
  }

  // The cavern and the tunnel first (they need the most rock), then dens; a
  // tunnel that found no room is tried once more at the end, packed closer.
  const order = ["cavern", "tunnel", "den", "den", "den", "tunnel?"];
  for (const want of order) {
    const retry = want.endsWith("?");
    const kind = retry ? want.slice(0, -1) : want;
    if (retry && caves.some((o) => o.kind === kind)) continue;
    if (kind === "den" && caves.length >= 5) break;
    const spacing = retry ? 110 : kind === "den" ? 150 : 200;
    let best = null;
    let tries = 0;
    for (const c of cands) {
      if (tries > 900) break;
      if (caves.some((o) => Math.hypot(o.mx - c.x, o.mz - c.z) < spacing)) continue;
      tries++;
      const turns = kind === "tunnel" ? [1, -1] : [0];
      for (const da of [0, -0.35, 0.35, -0.7, 0.7]) for (const turn of turns) {
        const cave = designCave(ctx, noise, kind, c, c.a + da, rng, turn);
        if (!cave) continue;
        if (caves.some((o) => pathsClose(o, cave, 45))) continue;
        let score = cave.score;
        if (kind === "cavern") score += c.mtn * 30;
        if (kind === "tunnel") score += c.mtn * 12;
        if (!best || score > best.score) best = { ...cave, score };
      }
    }
    if (best) {
      best.id = caves.length;
      caves.push(best);
    }
  }
  return caves;
}

/** True if two caves' centrelines pass within `d` metres. */
function pathsClose(a, b, d) {
  const pa = a.pts;
  const pb = b.pts;
  for (let i = 0; i < pa.length; i += 6) {
    for (let j = 0; j < pb.length; j += 6) {
      if (Math.hypot(pa[i] - pb[j], pa[i + 1] - pb[j + 1]) < d) return true;
    }
  }
  return false;
}

/**
 * Lay one cave out from candidate mouth `c` heading into the hill along `theta`
 * (radians, design x/z), or return null if the rock won't hold it.
 */
function designCave(ctx, noise, kind, c, theta, rng, turnDir = 1) {
  const spec = KINDS[kind];
  const G = ctx.ground;
  const seed = rng() * 60;
  const Lin = rand(rng, spec.len[0], spec.len[1]);
  const cx = Math.cos(theta);
  const cz = Math.sin(theta);
  const Fm = G(c.x, c.z) - 0.2;
  if (Fm < 1.4) return null;
  // The mouth: probing straight in from 12 m in front of the candidate, where
  // the hillside first stands a vault plus a roof above the floor.
  let sM = -1;
  for (let s = 6; s < 30; s += CAVE_STEP) {
    if (G(c.x + cx * (s - 12), c.z + cz * (s - 12)) >= Fm + spec.mouthC + ROCK_MIN) {
      sM = s;
      break;
    }
  }
  if (sM < 10) return null;
  // The approach: dry, and no wall to climb before the mouth.
  let prevG = G(c.x + cx * (sM - 12 - APPROACH), c.z + cz * (sM - 12 - APPROACH));
  for (let s = sM - APPROACH - 3; s < sM; s += CAVE_STEP) {
    const h = G(c.x + cx * (s - 12), c.z + cz * (s - 12));
    if (h < 1) return null;
    if (s > sM - APPROACH && Math.abs(h - prevG) / CAVE_STEP > 0.55 && h < Fm + 1.5) return null;
    prevG = h;
  }

  // Centreline from APPROACH metres before the mouth: straight through the
  // mouth, then wandering gently in (a closed cave), or a U-bend that comes
  // back out of the same cliff a few dozen metres along (a tunnel with two mouths).
  const sA = APPROACH;
  const pts = [];
  {
    let x = c.x + cx * (sM - 12 - APPROACH);
    let z = c.z + cz * (sM - 12 - APPROACH);
    if (kind === "tunnel") {
      const L1 = rand(rng, 18, 30);
      const R = rand(rng, 10, 14);
      const turn = turnDir;
      const legs = sA + L1;
      const arc = Math.PI * R;
      const totalLen = legs + arc + L1 + APPROACH + 0.5;
      let a = theta;
      for (let s = 0; s <= totalLen + 1e-6; s += CAVE_STEP) {
        pts.push(x, z);
        if (s >= legs && s < legs + arc) a += (turn * CAVE_STEP) / R;
        x += Math.cos(a) * CAVE_STEP;
        z += Math.sin(a) * CAVE_STEP;
      }
    } else {
      const totalLen = sA + Lin + spec.cap;
      for (let s = 0; s <= totalLen + 1e-6; s += CAVE_STEP) {
        pts.push(x, z);
        const a = theta + spec.bend * noise(s / 38 + seed, 4.2) * 1.6 * smoothstep(sA + 4, sA + 18, s);
        x += Math.cos(a) * CAVE_STEP;
        z += Math.sin(a) * CAVE_STEP;
      }
    }
  }
  let n = pts.length / 2;
  const gr = new Float32Array(n);
  for (let i = 0; i < n; i++) gr[i] = G(pts[i * 2], pts[i * 2 + 1]);
  let sB = -1; // second mouth (tunnels)
  let FB = 0;
  const slope = rand(rng, spec.slope[0], spec.slope[1]);

  if (kind === "tunnel") {
    // Mouth B: the last point of the return leg still under a full roof.
    const total0 = (n - 1) * CAVE_STEP;
    for (let i = n - 1; i >= 0; i--) {
      const s = i * CAVE_STEP;
      if (s < total0 - APPROACH - 14) break;
      if (gr[i] >= Fm + spec.mouthC + ROCK_MIN - 1) {
        sB = s;
        break;
      }
    }
    if (sB < 0 || sB - sA < spec.len[0] || sB - sA > spec.len[1]) return null;
    // Outside B the ground opens out, at about the same level as A.
    const iB = Math.round(sB / CAVE_STEP);
    FB = Math.min(...Array.from(gr.slice(iB + 2, Math.min(n, iB + 5)))) - 0.2;
    if (!(FB > 1.4) || Math.abs(FB - Fm) / (sB - sA) > 0.1 || Math.abs(FB - Fm) > 7) return null;
    for (let i = iB + 3; i < n; i++) if (gr[i] < 1 || gr[i] > FB + 2.5) return null;
  }
  const total = (n - 1) * CAVE_STEP;
  const sEnd = kind === "tunnel" ? sB : total;
  // A closed cave's dome starts `cap` metres before the end of its path, so
  // the last sample closes it exactly.
  const capStart = total - spec.cap;
  const L = (kind === "tunnel" ? sB : capStart) - sA;

  // Profiles per sample.
  const F = new Float32Array(n);
  const W = new Float32Array(n);
  const C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * CAVE_STEP;
    const si = Math.max(0, s - sA);
    F[i] = kind === "tunnel" ? lerp(Fm, FB, clamp((s - sA) / (sB - sA), 0, 1)) : Fm + slope * si;
    let [w, h] = kindProfile(kind, si, L, sB - sA);
    // Breathing walls and ceiling inside, exact sizes at the mouths.
    const inner = smoothstep(0, 5, si) * (kind === "tunnel" ? smoothstep(0, 5, sB - s) : 1);
    w *= 1 + 0.1 * noise(s / 11 + seed, 7.3) * inner;
    h *= 1 + 0.07 * noise(s / 8 + seed, 1.9) * inner;
    // A closed end rounds off into a dome.
    if (kind !== "tunnel" && s > capStart) {
      const u = clamp((s - capStart) / spec.cap, 0, 1);
      const k = Math.sqrt(Math.max(0, 1 - u * u));
      w *= k;
      h *= k;
    }
    W[i] = w;
    C[i] = h;
  }
  // The rock has to hold: over the crown and both shoulders, mouth to end.
  let over = 0;
  let overN = 0;
  let deficit = 0;
  for (let i = Math.round(sA / CAVE_STEP); i < n; i++) {
    const s = i * CAVE_STEP;
    if (s > sEnd + 1e-6) break;
    if (F[i] < 1.2) return null;
    const need = F[i] + C[i] + ROCK_MIN;
    const d = gr[i] - need;
    if (d < -1.5) return null;
    if (d < 0) deficit -= d;
    over += Math.min(d, 30);
    overN++;
    if (i % 2 === 0 && W[i] > 1) {
      const t = tangentAt(pts, i);
      for (const sd of [-1, 1]) {
        const lx = pts[i * 2] - t[1] * (W[i] + 2.5) * sd;
        const lz = pts[i * 2 + 1] + t[0] * (W[i] + 2.5) * sd;
        if (G(lx, lz) < F[i] + 0.45 * C[i] + 1) return null;
      }
    }
  }
  if (deficit > 6) return null;
  // Clear of water, routes and landmarks all along.
  for (let i = 0; i < n; i += 2) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];
    if (ctx.avoid.some((o) => Math.hypot(o.x - x, o.z - z) < o.r * 0.7)) return null;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + 0.4;
      if (G(x + Math.cos(a) * (W[i] + 14), z + Math.sin(a) * (W[i] + 14)) < 0.8) return null;
    }
  }
  const mouths = [{ s: sA, dir: 1 }];
  if (kind === "tunnel") mouths.push({ s: sB, dir: -1 });
  // Skylight in the middle of the cavern's chamber, if the roof isn't absurdly thick.
  const skylights = [];
  if (kind === "cavern") {
    const s = sA + L * 0.5;
    const i = Math.round(s / CAVE_STEP);
    const thick = gr[i] - F[i] - C[i];
    if (thick < 75) skylights.push({ s, r: rand(rng, 3.4, 4.4), x: pts[i * 2], z: pts[i * 2 + 1] });
  }
  const cliff = gr[Math.min(n - 1, Math.round((sA + 6) / CAVE_STEP))] - Fm;
  const score = Math.min(over / Math.max(1, overN), 25) + Math.min(cliff, 30) * 0.8 - deficit * 2 + rng() * 6;
  return {
    kind,
    pts: Float32Array.from(pts),
    n,
    total,
    F,
    W,
    C,
    mouths,
    skylights,
    sEnd,
    score,
    mx: c.x,
    mz: c.z,
  };
}

/** Unit tangent [tx, tz] at centreline sample i. */
function tangentAt(pts, i) {
  const n = pts.length / 2;
  const a = Math.max(0, i - 1);
  const b = Math.min(n - 1, i + 1);
  const tx = pts[b * 2] - pts[a * 2];
  const tz = pts[b * 2 + 1] - pts[a * 2 + 1];
  const l = Math.hypot(tx, tz) || 1;
  return [tx / l, tz / l];
}

/* --- Per-cave profile lookups -------------------------------------------------- */

/** Linear sample of a per-centreline-sample array at arc length s. */
function at(arr, s) {
  const f = clamp(s / CAVE_STEP, 0, arr.length - 1);
  const i = Math.min(arr.length - 2, f | 0);
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

/** Is arc length s under the roof? (between the mouths; past a closed end too) */
function roofedAt(cave, s) {
  const m = cave.mouths;
  if (m.length === 2) return s >= m[0].s && s <= m[1].s;
  return s >= m[0].s;
}

/** Height of the vault above the floor at lateral offset d (negative past the wall: rock). */
function vaultHeight(W, C, d) {
  const u = Math.abs(d) / Math.max(W, 1e-3);
  if (u >= 1) return -(Math.abs(d) - W) * 1.6;
  return C * Math.pow(1 - Math.pow(u, VAULT_Q), 1 / VAULT_Q);
}

/** 0 (open) … 1 (deepest dark) along the cave: distance from the light. */
function caveDark(cave, s) {
  let depth = Infinity;
  for (const m of cave.mouths) {
    const reach = 6 + 2.2 * at(cave.W, m.s);
    depth = Math.min(depth, Math.max(0, (s - m.s) * m.dir) / reach);
  }
  return smoothstep(0.05, 1.25, depth);
}

/** Light pooling under a skylight (0..1) at plan distance r from its axis. */
function skyPool(sky, r) {
  const k = r / (sky.r * 2.6);
  return Math.exp(-k * k);
}

/* --- Carving -------------------------------------------------------------------- */

/**
 * Cut the caves into the vertex heights. Leaves on `out`:
 *   surf  — render surface (Float32Array): original hillside over roofs, carved elsewhere
 *   top   — top surface everywhere near caves (what you'd walk on above them)
 *   hole  — Uint8Array per CELL (res²): grid cells the terrain mesh must leave out
 *   zone  — Uint8Array per vertex: 1 near a cave (approach/trench), 2 under a roof
 * @param {object} T terrain internals: { heights, n, grid (design), cell (design m), k }
 */
export function carveCaves(caves, T) {
  const { heights: H, n, grid } = T;
  const N = n * n;
  const H0 = H.slice(); // the island before the caves
  const surf = H.slice();
  const top = H.slice();
  const zone = new Uint8Array(N);
  const vCave = new Int8Array(N).fill(-1);
  const vS = new Float32Array(N);
  const vD = new Float32Array(N);
  const dist = new Float32Array(N);
  const sArr = new Float32Array(N);
  const side = new Int8Array(N);
  for (const cave of caves) {
    let wMax = 0;
    for (let i = 0; i < cave.n; i++) wMax = Math.max(wMax, cave.W[i]);
    const R = wMax + FLOOR_MARGIN + 34;
    const cum = new Float64Array(cave.n);
    for (let i = 0; i < cave.n; i++) cum[i] = i * CAVE_STEP;
    dist.fill(1e9);
    rasterLine(cave.pts, cum, R, grid, dist, sArr, side);
    cave.reach = R;
    for (let i = 0; i < N; i++) {
      const d = dist[i];
      if (d >= R) continue;
      const s = sArr[i];
      const F = at(cave.F, s);
      const W = at(cave.W, s);
      const C = at(cave.C, s);
      const T0 = F + Math.max(0, d - (W + FLOOR_MARGIN)) * WALL_SLOPE;
      const roofed = roofedAt(cave, s);
      const h0 = H0[i];
      const cut = Math.min(h0, T0);
      if (cut < H[i]) H[i] = cut;
      if (roofed) {
        // Keep the hillside, with at least a skin of rock over the vault.
        const crown = F + vaultHeight(W, C, d) + 1.3;
        const t = Math.max(h0, d < W + 1.5 ? crown : -Infinity);
        top[i] = Math.max(top[i], t);
        surf[i] = top[i];
        zone[i] = 2;
      } else {
        surf[i] = Math.min(surf[i], cut);
        if (d < W + FLOOR_MARGIN + 6 && zone[i] < 1) zone[i] = 1;
      }
      if (d < (vCave[i] >= 0 ? Math.abs(vD[i]) : Infinity) || vCave[i] < 0) {
        vCave[i] = cave.id;
        vS[i] = s;
        vD[i] = d * side[i];
      }
    }
  }

  // Cells the terrain mesh leaves out: those straddling a roof line near a
  // mouth (the cave's own apron / face / skirt redraw them), and those around
  // a skylight shaft.
  const res = n - 1;
  const hole = new Uint8Array(res * res);
  const cell = T.cell;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = iz * n + ix;
      const corners = [a, a + 1, a + n, a + n + 1];
      let id = -1;
      for (const v of corners) if (vCave[v] >= 0) id = vCave[v];
      if (id < 0) continue;
      const cave = caves[id];
      let roofed = 0;
      let open = 0;
      let dMin = Infinity;
      let sMin = Infinity;
      let sMax = -Infinity;
      for (const v of corners) {
        if (vCave[v] !== id) {
          open++;
          continue;
        }
        if (zone[v] === 2) roofed++;
        else open++;
        dMin = Math.min(dMin, Math.abs(vD[v]));
        sMin = Math.min(sMin, vS[v]);
        sMax = Math.max(sMax, vS[v]);
      }
      if (roofed && open) {
        for (const m of cave.mouths) {
          if (sMax < m.s - cell * 1.6 || sMin > m.s + cell * 1.6) continue;
          if (dMin < mouthHalfWidth(cave, m, H0, T)) hole[iz * res + ix] = 1;
        }
      }
      for (const sk of cave.skylights) {
        for (const v of corners) {
          const x = grid.origin + (v % n) * grid.step;
          const z = grid.origin + ((v / n) | 0) * grid.step;
          if (Math.hypot(x - sk.x, z - sk.z) < sk.r + 1.2) hole[iz * res + ix] = 1;
        }
      }
    }
  }
  return { surf, top, hole, zone, H0 };
}

/**
 * Half-width of a mouth's face/skirts: the vault, the flat floor margin and
 * the trench walls up to the hillside, plus a cell of slack.
 */
function mouthHalfWidth(cave, m, H0, T) {
  if (m.hw) return m.hw;
  const W = at(cave.W, m.s);
  const F = at(cave.F, m.s);
  // Walk out from the vault on both sides, a cell in front of and behind the
  // roof line, until the trench's wall has climbed out onto the hillside:
  // the end wall the terrain mesh would draw ends there.
  const i = Math.round(m.s / CAVE_STEP);
  const t = tangentAt(cave.pts, i);
  const cx = cave.pts[i * 2];
  const cz = cave.pts[i * 2 + 1];
  let edge = W + FLOOR_MARGIN;
  for (const ds of [-T.cell, 0, T.cell]) {
    for (const side of [-1, 1]) {
      for (let d = W + FLOOR_MARGIN; d < W + FLOOR_MARGIN + 60; d += 0.75) {
        const x = cx + t[0] * ds * m.dir - t[1] * d * side;
        const z = cz + t[1] * ds * m.dir + t[0] * d * side;
        if (F + (d - W - FLOOR_MARGIN) * WALL_SLOPE >= T.sample(H0, x, z) - 0.05) break;
        edge = Math.max(edge, d);
      }
    }
  }
  m.hw = edge + 1;
  return m.hw;
}

/* --- Runtime queries ----------------------------------------------------------------- */

/**
 * Fast lookups for gameplay: one small world-space grid per cave (1 m cells)
 * holding the ceiling height, whether the point is roofed and how dark it is.
 */
export class CaveIndex {
  /**
   * @param {object[]} caves designs (design metres)
   * @param {number} k world metres per design metre
   * @param {(x: number, z: number) => number} topAt world-space top surface (over roofs)
   */
  constructor(caves, k, topAt) {
    this.k = k;
    this.items = [];
    for (const cave of caves) {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      let wMax = 0;
      for (let i = 0; i < cave.n; i++) {
        x0 = Math.min(x0, cave.pts[i * 2]);
        x1 = Math.max(x1, cave.pts[i * 2]);
        z0 = Math.min(z0, cave.pts[i * 2 + 1]);
        z1 = Math.max(z1, cave.pts[i * 2 + 1]);
        wMax = Math.max(wMax, cave.W[i]);
      }
      const pad = wMax + FLOOR_MARGIN + 8;
      x0 -= pad;
      z0 -= pad;
      x1 += pad;
      z1 += pad;
      const nx = Math.ceil((x1 - x0) / FIELD_STEP) + 1;
      const nz = Math.ceil((z1 - z0) / FIELD_STEP) + 1;
      const nn = Math.max(nx, nz);
      // rasterLine wants a square grid: use the bigger side, ignore the overflow.
      const grid = { n: nn, origin: 0, step: FIELD_STEP };
      const dist = new Float32Array(nn * nn).fill(1e9);
      const sA = new Float32Array(nn * nn);
      const side = new Int8Array(nn * nn);
      // Shift the line into grid space (origin 0) per axis.
      const local = new Float32Array(cave.pts.length);
      for (let i = 0; i < cave.n; i++) {
        local[i * 2] = cave.pts[i * 2] - x0;
        local[i * 2 + 1] = cave.pts[i * 2 + 1] - z0;
      }
      const cum = new Float64Array(cave.n);
      for (let i = 0; i < cave.n; i++) cum[i] = i * CAVE_STEP;
      rasterLine(local, cum, pad, grid, dist, sA, side);
      const ceil = new Float32Array(nx * nz).fill(1e6);
      const floor = new Float32Array(nx * nz);
      const roof = new Uint8Array(nx * nz);
      const dark = new Float32Array(nx * nz);
      const zoneM = new Uint8Array(nx * nz);
      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          const g = iz * nn + ix;
          const o = iz * nx + ix;
          const d = dist[g];
          if (d >= pad) continue;
          const s = sA[g];
          const W = at(cave.W, s);
          const C = at(cave.C, s);
          const F = at(cave.F, s);
          floor[o] = F;
          if (d < W + FLOOR_MARGIN + 6) zoneM[o] = 1;
          if (!roofedAt(cave, s)) continue;
          zoneM[o] = 2;
          roof[o] = 1;
          ceil[o] = F + vaultHeight(W, C, d);
          let dk = caveDark(cave, s);
          const px = x0 + ix * FIELD_STEP;
          const pz = z0 + iz * FIELD_STEP;
          for (const sk of cave.skylights) {
            const r = Math.hypot(px - sk.x, pz - sk.z);
            dk *= 1 - 0.85 * skyPool(sk, r);
            // Under the shaft itself the "ceiling" is the sky.
            if (r < sk.r) ceil[o] = Math.max(ceil[o], topAt(px * k, pz * k) + 2);
          }
          dark[o] = dk;
        }
      }
      this.items.push({ cave, x0, z0, x1, z1, nx, nz, ceil, floor, roof, dark, zone: zoneM });
    }
  }

  /** The cave grid entry containing world (x, z), or null. */
  _find(x, z) {
    const k = this.k;
    const dx = x / k;
    const dz = z / k;
    const it = this.items;
    for (let i = 0; i < it.length; i++) {
      const c = it[i];
      if (dx > c.x0 && dx < c.x1 && dz > c.z0 && dz < c.z1) return c;
    }
    return null;
  }

  /** Bilinear sample of a cave grid field at world (x, z) (c from _find). */
  _sample(c, field, x, z) {
    const fx = clamp((x / this.k - c.x0) / FIELD_STEP, 0, c.nx - 1.001);
    const fz = clamp((z / this.k - c.z0) / FIELD_STEP, 0, c.nz - 1.001);
    const ix = fx | 0;
    const iz = fz | 0;
    const tx = fx - ix;
    const tz = fz - iz;
    const a = iz * c.nx + ix;
    const top = field[a] + (field[a + 1] - field[a]) * tx;
    const bot = field[a + c.nx] + (field[a + c.nx + 1] - field[a + c.nx]) * tx;
    return top + (bot - top) * tz;
  }

  _nearest(c, field, x, z) {
    const ix = clamp(Math.round((x / this.k - c.x0) / FIELD_STEP), 0, c.nx - 1);
    const iz = clamp(Math.round((z / this.k - c.z0) / FIELD_STEP), 0, c.nz - 1);
    return field[iz * c.nx + ix];
  }

  /** World y of the cave ceiling over (x, z), or Infinity in the open. */
  ceilingAt(x, z) {
    const c = this._find(x, z);
    if (!c || !this._nearest(c, c.roof, x, z)) return Infinity;
    return this._sample(c, c.ceil, x, z);
  }

  /** 0 in the open … 1 in the darkest depths of a cave. */
  shelterAt(x, z) {
    const c = this._find(x, z);
    if (!c) return 0;
    const v = this._sample(c, c.dark, x, z);
    return v > 0 ? v : 0;
  }

  /** 0 none, 1 approach / near a cave, 2 under a cave roof. */
  zoneAt(x, z) {
    const c = this._find(x, z);
    return c ? this._nearest(c, c.zone, x, z) : 0;
  }

  /** Cave design under (x, z) (roofed or near), or null. */
  caveAt(x, z) {
    const c = this._find(x, z);
    return c && this._nearest(c, c.zone, x, z) ? c.cave : null;
  }
}

/* --- Meshes -------------------------------------------------------------------------- */

/** Growable typed buffers for one cave's geometry. */
class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.matA = [];
    this.matB = [];
    this.cave = [];
    this.index = [];
    this.count = 0;
    this.explicitNormals = [];
  }
  /** Add a vertex; returns its index. n: [nx,ny,nz] or null (computed later). */
  v(x, y, z, a, b, shade, n = null) {
    this.pos.push(x, y, z);
    this.matA.push(a[0], a[1], a[2], a[3]);
    this.matB.push(b[0], b[1], b[2], b[3]);
    this.cave.push(shade);
    this.nrm.push(n ? n[0] : 0, n ? n[1] : 0, n ? n[2] : 0);
    this.explicitNormals.push(!!n);
    return this.count++;
  }
  /** Quad grid of `rows`×`cols` vertex indices (row-major), wound so its front faces +side. */
  grid(ids, rows, cols, flip = false) {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = ids[r * cols + c];
        const b = ids[r * cols + c + 1];
        const d = ids[(r + 1) * cols + c];
        const e = ids[(r + 1) * cols + c + 1];
        if (a < 0 || b < 0 || d < 0 || e < 0) continue;
        if (flip) this.index.push(a, b, d, b, e, d);
        else this.index.push(a, d, b, b, d, e);
      }
    }
  }
  build() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(this.pos);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    // Smooth normals from the faces, except where a part supplied its own
    // (skirts that must shade exactly like the terrain they patch).
    const acc = new Float32Array(this.count * 3);
    const idx = this.index;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a];
      const uy = pos[b + 1] - pos[a + 1];
      const uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a];
      const vy = pos[c + 1] - pos[a + 1];
      const vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) {
        acc[o] += nx;
        acc[o + 1] += ny;
        acc[o + 2] += nz;
      }
    }
    const nrm = new Float32Array(this.count * 3);
    for (let v = 0; v < this.count; v++) {
      const o = v * 3;
      let x;
      let y;
      let z;
      if (this.explicitNormals[v]) {
        x = this.nrm[o];
        y = this.nrm[o + 1];
        z = this.nrm[o + 2];
      } else {
        x = acc[o];
        y = acc[o + 1];
        z = acc[o + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      nrm[o] = x / l;
      nrm[o + 1] = y / l;
      nrm[o + 2] = z / l;
    }
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    const u8 = (arr) => Uint8Array.from(arr, (v) => Math.round(clamp(v, 0, 1) * 255));
    geo.setAttribute("aMatA", new THREE.BufferAttribute(u8(this.matA), 4, true));
    geo.setAttribute("aMatB", new THREE.BufferAttribute(u8(this.matB), 4, true));
    geo.setAttribute("aCave", new THREE.BufferAttribute(u8(this.cave), 1, true));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

// Material weights (grass, dry, dirt, rock | sand, mud, AO, macro).
const ROCK_A = [0, 0, 0, 1];
const FLOOR_A = [0, 0, 0.55, 0.3];
const FLOOR_B = (ao) => [0.03, 0.12, ao, 0.45];
const ROCK_B = (ao) => [0, 0, ao, 0.5];

/**
 * Build one mesh per cave (they share `material`): floor + vault, the mouths'
 * apron / face / skirt, and skylight shafts.
 * @param {object[]} caves designs
 * @param {object} T { k, heights (physics), top, surf, sample(field, xd, zd), weights(xd, zd) → [a4, b4],
 *                     normalAt(field, xd, zd) → [nx, ny, nz], cell, seed, low }
 * @returns {THREE.Mesh[]}
 */
export function buildCaveMeshes(caves, T, material) {
  const meshes = [];
  const noise = createNoise2D(hash("underfern-caves", "rock", T.seed));
  const k = T.k;
  // Cheap 3D-ish rock noise from three 2D slices.
  const rock3 = (x, y, z) =>
    noise(x * 0.21, y * 0.23) * 0.4 + noise(z * 0.21 + 17.1, y * 0.19 - 3.3) * 0.4 + noise(x * 0.47 - 9.2, z * 0.47 + 4.4) * 0.35;
  for (const cave of caves) {
    const B = new GeoBuilder();
    buildTube(cave, B, T, rock3);
    for (const m of cave.mouths) buildMouth(cave, m, B, T, rock3);
    for (const sk of cave.skylights) buildSkylight(cave, sk, B, T, rock3);
    const geo = B.build();
    // Design → world (uniform horizontal scale; heights are already metres).
    if (k !== 1) geo.applyMatrix4(new THREE.Matrix4().makeScale(k, 1, k));
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `cave-${cave.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.cave = cave.id;
    meshes.push(mesh);
  }
  return meshes;
}

/** Ring frame at arc length s: centre (x, z), floor y, tangent, half-width, clearance. */
function frameAt(cave, s) {
  const f = clamp(s / CAVE_STEP, 0, cave.n - 1);
  const i = Math.min(cave.n - 2, f | 0);
  const u = f - i;
  const x = cave.pts[i * 2] + (cave.pts[i * 2 + 2] - cave.pts[i * 2]) * u;
  const z = cave.pts[i * 2 + 1] + (cave.pts[i * 2 + 3] - cave.pts[i * 2 + 1]) * u;
  // Tangent averaged over a few samples so rings don't pinch at bends.
  const a = Math.max(0, i - 2);
  const b = Math.min(cave.n - 1, i + 3);
  let tx = cave.pts[b * 2] - cave.pts[a * 2];
  let tz = cave.pts[b * 2 + 1] - cave.pts[a * 2 + 1];
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  return { x, z, tx, tz, nx: -tz, nz: tx, F: at(cave.F, s), W: at(cave.W, s), C: at(cave.C, s) };
}

/** Arch point (lateral d, height above floor y) at parameter u ∈ [-1, 1] (−1 left foot, 0 crown, 1 right foot). */
function archPoint(W, C, u) {
  const a = u * (Math.PI / 2);
  const sn = Math.sin(a);
  const cs = Math.cos(a);
  const p = 2 / VAULT_Q;
  return [W * Math.sign(sn) * Math.pow(Math.abs(sn), p), C * Math.pow(Math.abs(cs), p)];
}

/** Segments across the vault's arch (the mouths' faces share them). */
function vaultSegments(cave, T) {
  const big = Math.max(...cave.W) > 10;
  return T.low ? (big ? 22 : 14) : big ? 30 : 18;
}

/** Floor + vault: one tube from the first mouth face to the end (or the far face). */
function buildTube(cave, B, T, rock3) {
  const m0 = cave.mouths[0];
  const s0 = m0.s - FACE_A;
  const s1 = cave.mouths.length === 2 ? cave.mouths[1].s + FACE_A : cave.total;
  const big = Math.max(...cave.W) > 10;
  const ds = big ? 1.6 : 1.2;
  const rings = Math.max(2, Math.ceil((s1 - s0) / ds) + 1);
  const VA = vaultSegments(cave, T);
  const FL = big ? 8 : 4; // floor segments
  const vault = [];
  const floor = [];
  const cols = VA + 3; // + a tuck under the floor at each foot
  for (let r = 0; r < rings; r++) {
    const s = Math.min(s1, s0 + r * ds);
    const fr = frameAt(cave, s);
    // Displacement fades out at the open ends, where the faces join exactly.
    let ends = smoothstep(0, 2.5, s - s0);
    if (cave.mouths.length === 2) ends *= smoothstep(0, 2.5, s1 - s);
    const dark = caveDark(cave, s);
    const amp = (0.18 + 0.05 * Math.min(fr.W, fr.C)) * ends;
    for (let c = 0; c < cols; c++) {
      let d;
      let y;
      if (c === 0 || c === cols - 1) {
        // Tuck the vault's foot under the floor so the seam never opens.
        d = (c === 0 ? -1 : 1) * (fr.W + 0.45);
        y = -0.9;
      } else {
        [d, y] = archPoint(fr.W, fr.C, -1 + (2 * (c - 1)) / VA);
      }
      let px = fr.x + fr.nx * d;
      let pz = fr.z + fr.nz * d;
      let py = fr.F + y;
      if (fr.W > 0.05 && c > 0 && c < cols - 1) {
        // Push in/out along the arch normal (away from a point low in the vault).
        const cy = fr.F + fr.C * 0.3;
        let ox = px - fr.x;
        let oz = pz - fr.z;
        let oy = py - cy;
        const ol = Math.hypot(ox, oy, oz) || 1;
        const disp = rock3(px, py, pz) * amp * smoothstep(0.1, 0.8, y / Math.max(fr.C, 0.1) + 0.2);
        px += (ox / ol) * disp;
        py += (oy / ol) * disp;
        pz += (oz / ol) * disp;
      }
      // Darker in the crevice where vault meets floor and in the crown's hollows.
      const ao = 0.55 + 0.4 * smoothstep(0.05, 0.5, y / Math.max(fr.C, 0.1));
      // Skylight: drop the vault quads under the shaft.
      let shade = 1 - dark;
      for (const sk of cave.skylights) shade = Math.max(shade, 0.85 * skyPool(sk, Math.hypot(px - sk.x, pz - sk.z)));
      vault.push(B.v(px, py, pz, ROCK_A, ROCK_B(ao), Math.max(MIN_LIGHT, shade)));
    }
    // At an open end the floor's edge stays level with the apron outside.
    const openEnd = Math.min(smoothstep(0, 1.2, s - s0), cave.mouths.length === 2 ? smoothstep(0, 1.2, s1 - s) : 1);
    for (let c = 0; c <= FL; c++) {
      const u = -1 + (2 * c) / FL;
      const d = u * (fr.W + 0.7);
      const px = fr.x + fr.nx * d;
      const pz = fr.z + fr.nz * d;
      const edge = smoothstep(0.75, 1.0, Math.abs(u)) * openEnd;
      const py = fr.F - edge * 0.45 + 0.05 * rock3(px * 2, 0, pz * 2) * (1 - smoothstep(0.75, 1.0, Math.abs(u))) * openEnd;
      let shade = 1 - dark;
      for (const sk of cave.skylights) shade = Math.max(shade, 0.85 * skyPool(sk, Math.hypot(px - sk.x, pz - sk.z)));
      const ao = 0.62 + 0.35 * (1 - smoothstep(0.55, 0.95, Math.abs(u)));
      floor.push(B.v(px, py, pz, FLOOR_A, FLOOR_B(ao), Math.max(MIN_LIGHT, shade), [0, 1, 0]));
    }
  }
  // Vault faces inward (seen from inside); the floor faces up. Quads whose
  // centre lies under a skylight shaft are left out (the shaft covers the hole).
  const skip = (r, c) => {
    for (const sk of cave.skylights) {
      const ids = [vault[r * cols + c], vault[r * cols + c + 1], vault[(r + 1) * cols + c], vault[(r + 1) * cols + c + 1]];
      let cx = 0;
      let cz = 0;
      for (const id of ids) {
        cx += B.pos[id * 3] / 4;
        cz += B.pos[id * 3 + 2] / 4;
      }
      if (Math.hypot(cx - sk.x, cz - sk.z) < sk.r) return true;
    }
    return false;
  };
  for (let r = 0; r < rings - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (cave.skylights.length && skip(r, c)) continue;
      const a = vault[r * cols + c];
      const b = vault[r * cols + c + 1];
      const d = vault[(r + 1) * cols + c];
      const e = vault[(r + 1) * cols + c + 1];
      // (along the cave) × (across the arch) points into the cave.
      B.index.push(a, d, b, b, d, e);
    }
  }
  B.grid(floor, rings, FL + 1, true);
}

/**
 * A mouth: the apron (carved approach redrawn over the left-out cells), the
 * rock face with the arched opening, and the skirt (hillside behind/above).
 */
function buildMouth(cave, m, B, T, rock3) {
  const dir = m.dir;
  const hw = m.hw || at(cave.W, m.s) + 8;
  const cell = T.cell;
  const sFace = m.s - FACE_A * dir; // where the face meets the vault
  // The left-out cells straddle the roof line within ~1.5 cells; cover them with room to spare.
  const sFront = m.s - (cell * 2 + 2) * dir;
  const sBack = m.s + (cell * 2 + 2) * dir;
  const sTop = m.s + Math.max(1.2, cell * 0.45) * dir; // the face's top edge (leans back)
  const fr = frameAt(cave, sFace);
  // Lateral samples shared by the apron, the face and the skirt so their
  // edges meet exactly: plain columns out to the sides, and across the
  // opening exactly the vault's own front-ring arch, so the face's arch
  // edge and the vault are one seam.
  const VA = vaultSegments(cave, T);
  const outer = hw + cell * 1.6 + 1;
  const SIDE = Math.max(4, Math.ceil((outer - fr.W) / 1.4));
  const lats = [];
  for (let c = 0; c < SIDE; c++) lats.push(-outer + ((outer - fr.W) * c) / SIDE);
  for (let c = 0; c <= VA; c++) lats.push(archPoint(fr.W, fr.C, -1 + (2 * c) / VA)[0]);
  for (let c = 1; c <= SIDE; c++) lats.push(fr.W + ((outer - fr.W) * c) / SIDE);
  const COLS = lats.length - 1;
  const lat = (c) => lats[c];
  const pAt = (s, d) => {
    const f = frameAt(cave, s);
    return [f.x + f.nx * d, f.z + f.nz * d];
  };
  // The material's polygon offset lets the terrain win wherever the two
  // coincide, so the patches sit exactly on the surface (no slits at seams).
  const SINK = 0;

  // Apron: from sFront to the face line, on the physics surface (carved trench).
  const ROWS_A = Math.max(3, Math.ceil(Math.abs(sFace - sFront) / 1.2) + 1);
  const apron = [];
  for (let r = 0; r < ROWS_A; r++) {
    const s = sFront + (sFace - sFront) * (r / (ROWS_A - 1));
    for (let c = 0; c <= COLS; c++) {
      const [x, z] = pAt(s, lat(c));
      const y = T.sample(T.heights, x, z) - SINK;
      const [wa, wb] = T.weights(x, z);
      apron.push(B.v(x, y, z, wa, wb, 1, T.normalAt(T.heights, x, z)));
    }
  }
  // Rows run along the cave (×dir), columns across it: wind so the faces look up.
  B.grid(apron, ROWS_A, COLS + 1, dir > 0);

  // Skirt: from the face's top edge back to sBack, on the top surface.
  const ROWS_S = Math.max(3, Math.ceil(Math.abs(sBack - sTop) / 1.2) + 1);
  const skirt = [];
  for (let r = 0; r < ROWS_S; r++) {
    const s = sTop + (sBack - sTop) * (r / (ROWS_S - 1));
    for (let c = 0; c <= COLS; c++) {
      const [x, z] = pAt(s, lat(c));
      const y = T.sample(T.top, x, z) - SINK;
      const [wa, wb] = T.weights(x, z);
      skirt.push(B.v(x, y, z, wa, wb, 1, T.normalAt(T.top, x, z)));
    }
  }
  B.grid(skirt, ROWS_S, COLS + 1, dir > 0);

  // Face: per column, from the apron's back edge (or the arch, inside the
  // opening) up to the skirt's front edge, leaning back into the hill.
  const ROWS_F = 7;
  const face = [];
  for (let c = 0; c <= COLS; c++) {
    const d = lat(c);
    const [bx, bz] = pAt(sFace, d);
    let by;
    const ca = c - SIDE; // index along the arch, 0..VA, inside the opening
    const inside = ca >= 0 && ca <= VA;
    if (inside) {
      // The opening: the vault's front ring at this column.
      by = fr.F + archPoint(fr.W, fr.C, -1 + (2 * ca) / VA)[1];
    } else by = T.sample(T.heights, bx, bz) - SINK;
    const [tx, tz] = pAt(sTop, d);
    const ty = T.sample(T.top, tx, tz) - SINK;
    for (let r = 0; r < ROWS_F; r++) {
      const u = r / (ROWS_F - 1);
      let x = lerp(bx, tx, u);
      let z = lerp(bz, tz, u);
      let y = lerp(by, Math.max(ty, by), u);
      // Rugged rock, pushed along the cave axis (never at the joined edges).
      const e = Math.sin(Math.PI * u);
      const disp = rock3(x, y, z) * 0.55 * e * smoothstep(0, 1.5, Math.abs(ty - by));
      x -= fr.tx * dir * disp;
      z -= fr.tz * dir * disp;
      const ao = inside ? 0.55 + 0.35 * u : 0.75 + 0.2 * u;
      face.push(B.v(x, y, z, ROCK_A, ROCK_B(ao), 1));
    }
  }
  // Column-major: rows are columns of the face here.
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS_F - 1; r++) {
      const a = face[c * ROWS_F + r];
      const b = face[c * ROWS_F + r + 1];
      const d = face[(c + 1) * ROWS_F + r];
      const e = face[(c + 1) * ROWS_F + r + 1];
      if (dir > 0) B.index.push(a, d, b, b, d, e);
      else B.index.push(a, b, d, b, e, d);
    }
  }
}

/** A skylight: a rough shaft from the vault up to the surface, and a lip of hillside around it. */
function buildSkylight(cave, sk, B, T, rock3) {
  const SEG = 20;
  const fr = frameAt(cave, sk.s);
  const rBot = sk.r + 0.9;
  const rTop = sk.r + 1.2;
  const yBot = fr.F + fr.C - 0.6;
  const ROWS = 8;
  const shaft = [];
  for (let r = 0; r < ROWS; r++) {
    const u = r / (ROWS - 1);
    for (let c = 0; c <= SEG; c++) {
      const a = (c / SEG) * TAU;
      const rr = lerp(rBot, rTop, u);
      let x = sk.x + Math.cos(a) * rr;
      let z = sk.z + Math.sin(a) * rr;
      const yt = T.sample(T.top, x, z) - 0.05;
      const y = lerp(yBot, yt, u);
      const disp = rock3(x, y, z) * 0.5 * Math.sin(Math.PI * u);
      x += Math.cos(a) * disp;
      z += Math.sin(a) * disp;
      const shade = lerp(0.85 * skyPool(sk, 0), 1, u);
      shaft.push(B.v(x, y, z, ROCK_A, ROCK_B(0.6 + 0.3 * u), shade));
    }
  }
  // Faces point inward, toward the axis.
  B.grid(shaft, ROWS, SEG + 1, true);
  // Lip: hillside ring from the shaft's top outward, on the top surface.
  const lip = [];
  const RINGS = 4;
  for (let r = 0; r < RINGS; r++) {
    const rr = lerp(rTop, sk.r + 1.2 + T.cell * 1.6 + 1.5, r / (RINGS - 1));
    for (let c = 0; c <= SEG; c++) {
      const a = (c / SEG) * TAU;
      const x = sk.x + Math.cos(a) * rr;
      const z = sk.z + Math.sin(a) * rr;
      const y = T.sample(T.top, x, z) - 0.05;
      const [wa, wb] = T.weights(x, z);
      lip.push(B.v(x, y, z, wa, wb, 1, T.normalAt(T.top, x, z)));
    }
  }
  B.grid(lip, RINGS, SEG + 1, true);
}

/** Public summary of a cave in world metres (for the map, AI and tests). */
export function describeCave(cave, k) {
  const entrances = cave.mouths.map((m) => {
    const fr = frameAt(cave, m.s);
    // Outward = against the direction the path goes in.
    const ox = -fr.tx * m.dir;
    const oz = -fr.tz * m.dir;
    // A spot just outside, on the approach floor.
    const [px, pz] = [fr.x + ox * 3, fr.z + oz * 3];
    return {
      x: fr.x * k,
      z: fr.z * k,
      y: fr.F,
      outsideX: px * k,
      outsideZ: pz * k,
      heading: Math.atan2(ox, oz),
      width: fr.W * 2 * k,
      height: fr.C,
    };
  });
  // The deepest point: a good place to rest out of sight.
  const m0 = cave.mouths[0];
  // A dead-end cave rests at the far end of its roomy part (the cavern's back
  // passage narrows below its mouth); a through-tunnel at its middle.
  const mouthC = Math.min(...cave.mouths.map((m) => at(cave.C, m.s)));
  let sDeep = (cave.mouths[0].s + (cave.mouths[1] ? cave.mouths[1].s : 0)) / 2;
  if (cave.mouths.length === 1) {
    sDeep = m0.s + 4;
    for (let s = cave.total - KINDS[cave.kind].cap - 2; s > m0.s + 4; s -= 1) {
      if (at(cave.C, s) >= mouthC) {
        sDeep = s;
        break;
      }
    }
  }
  const fd = frameAt(cave, sDeep);
  let wMax = 0;
  let cMax = 0;
  for (let i = 0; i < cave.n; i++) {
    wMax = Math.max(wMax, cave.W[i]);
    cMax = Math.max(cMax, cave.C[i]);
  }
  const path = [];
  for (let i = 0; i < cave.n; i += 2) path.push({ x: cave.pts[i * 2] * k, z: cave.pts[i * 2 + 1] * k });
  return {
    id: cave.id,
    kind: cave.kind,
    label: KINDS[cave.kind].label,
    entrances,
    // The lowest clearance at a mouth decides who can come in.
    height: Math.min(...entrances.map((e) => e.height)),
    maxHeight: cMax,
    maxWidth: wMax * 2 * k,
    length: (cave.sEnd - cave.mouths[0].s) * k,
    deep: { x: fd.x * k, z: fd.z * k, y: fd.F },
    skylights: cave.skylights.map((s) => ({ x: s.x * k, z: s.z * k, r: s.r * k })),
    path,
  };
}

