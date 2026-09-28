// Deterministic placement of small props (boulders, lamps, racks...).
// Shared by the mesh builders and the collision world.

import { rng } from '../core/math';
import { overlookHeight, shoreDistance, terrainHeight, trailQuery, trailSamples } from './heightfield';
import { BRIDGE, CABINS, OVERLOOK, VIEW_DECK, bridgeHeight } from './layout';

export interface Boulder {
  x: number;
  z: number;
  y: number;
  r: number;
  seed: number;
  rotY: number;
  squash: number;
}

export interface Lamp {
  x: number;
  z: number;
  y: number;
  height: number;
  /** Adds a real point light (limited budget). */
  light: boolean;
  kind: 'post' | 'stake' | 'bridge';
}

export interface Rack {
  x: number;
  z: number;
  y: number;
  rot: number;
  len: number;
}

function nearCabin(x: number, z: number, margin: number) {
  return CABINS.some((c) => Math.hypot(x - c.x, z - c.z) < Math.max(c.w, c.d) / 2 + margin);
}

function nearWalkway(x: number, z: number) {
  // Boardwalk band, bridge corridor, spur landings.
  if (z > -23.5 && z < -15 && x > -122 && x < -8) return true;
  if (Math.abs(z - BRIDGE.start.z) < 4 && x > -12 && x < 30) return true;
  if (Math.abs(x + 91) < 2.5 && z > -20 && z < -5) return true;
  if (Math.abs(x + 40) < 2.5 && z > -20 && z < -5) return true;
  if (x > 15 && x < 100 && z > -40 && z < 25) {
    if (trailQuery(x, z).dist < 3.2) return true;
    if (Math.hypot(x - OVERLOOK.x, z - OVERLOOK.z) < OVERLOOK.radius + 1.5) return true;
    if (Math.abs(x - VIEW_DECK.cx) < VIEW_DECK.hw + 1.5 && Math.abs(z - VIEW_DECK.cz) < VIEW_DECK.hd + 1.5) return true;
  }
  return false;
}

export const BOULDERS: Boulder[] = (() => {
  const r = rng(1337);
  const out: Boulder[] = [];
  let tries = 0;
  while (out.length < 150 && tries < 20000) {
    tries++;
    const x = -135 + r() * 235;
    const z = -45 + r() * 110;
    const sd = shoreDistance(x, z);
    // Mostly along the shoreline, some scattered inland, a few in the shallows.
    const band = sd > -6 && sd < 2.5;
    const inland = sd < -6 && r() < 0.05;
    if (!band && !inland) continue;
    if (nearCabin(x, z, 3) || nearWalkway(x, z)) continue;
    const size = band ? 0.35 + Math.pow(r(), 2.2) * 1.8 : 0.4 + r() * 1.1;
    out.push({
      x,
      z,
      y: terrainHeight(x, z),
      r: size,
      seed: Math.floor(r() * 1e6),
      rotY: r() * Math.PI * 2,
      squash: 0.55 + r() * 0.35,
    });
  }
  return out;
})();

export const LAMPS: Lamp[] = (() => {
  const out: Lamp[] = [];
  // Village lamp posts near the stair landings and lanes.
  const village = [
    { x: -93, z: -7.5, light: true },
    { x: -38, z: -7, light: true },
    { x: -75, z: 3, light: false },
    { x: -55, z: 1, light: false },
    { x: -118, z: -6, light: false },
  ];
  for (const v of village) out.push({ ...v, y: terrainHeight(v.x, v.z), height: 3.6, kind: 'post' });

  // Bridge lanterns on both railings at the ends and the crown.
  const along = [0.02, 0.5, 0.98];
  for (const t of along) {
    for (const side of [-1, 1]) {
      const x = BRIDGE.start.x + (BRIDGE.end.x - BRIDGE.start.x) * t;
      const z = BRIDGE.start.z + side * (BRIDGE.width / 2 + 0.05);
      out.push({ x, z, y: bridgeHeight(t), height: 1.9, light: side === 1, kind: 'bridge' });
    }
  }

  // Low stake lanterns marking the skerry trail.
  const pts = trailSamples();
  let side = 1;
  for (let i = 6; i < pts.length - 4; i += 11) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const x = a.x + nx * 2.3 * side;
    const z = a.z + nz * 2.3 * side;
    out.push({ x, z, y: terrainHeight(x, z), height: 0.9, light: false, kind: 'stake' });
    side *= -1;
  }
  // Overlook lamp.
  out.push({ x: OVERLOOK.x + 4.2, z: OVERLOOK.z + 1.5, y: overlookHeight(), height: 3.2, light: true, kind: 'post' });
  return out;
})();

/** Fish drying racks (hjell) — tall A-frame timber racks. */
export const RACKS: Rack[] = [
  { x: -52, z: 30, rot: 0.2, len: 10 },
  { x: -28, z: 26, rot: -0.35, len: 8 },
  { x: -114, z: 26, rot: 0.1, len: 9 },
  { x: 72, z: 16, rot: 0.4, len: 7 },
].map((r) => ({ ...r, y: terrainHeight(r.x, r.z) }));

/** Bench on the overlook plateau, facing north. */
export const BENCH = { x: OVERLOOK.x - 3.2, z: OVERLOOK.z - 1.2, rot: 0.25, y: 0 };
BENCH.y = overlookHeight();

/** Small boats moored along the waterfront (visual only). */
export const BOATS = [
  { x: -104, z: -24.5, rot: 0.15, len: 5.2 },
  { x: -77, z: -24.2, rot: -0.1, len: 4.4 },
  { x: -41, z: -24.8, rot: 0.3, len: 6.0 },
  { x: 14, z: -3, rot: 1.35, len: 4.6 },
];
