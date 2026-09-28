// The single source of truth for where things are. World builders (meshes)
// and the walk physics both read from here, so what you see is what you can
// walk on.
//
// Axes: +x east, +z south, +y up. Sea level is y = 0. The fjord and the big
// mountains lie to the north (-z); the aurora hangs over them.

export const SEA_LEVEL = 0;

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------------------ */
/* Islands                                                             */
/* ------------------------------------------------------------------ */

/** Village island (west). Rounded box in XZ. */
export const ISLAND_A = { cx: -62, cz: 20, hx: 62, hz: 32, r: 14 };
/** Skerry island (east) with the rocky knoll and overlook. */
export const ISLAND_B = { cx: 58, cz: -4, hx: 34, hz: 26, r: 16 };
/** Knoll on island B. */
export const KNOLL = { x: 70, z: -13, height: 11, sigma: 13 };

/** Region covered by the detailed, walkable terrain mesh. Everything
 * outside is coarse far terrain (mountains). The border is open water. */
export const NEAR_BOUNDS = { minX: -170, maxX: 160, minZ: -100, maxZ: 105 };

/* ------------------------------------------------------------------ */
/* Cabins (rorbuer)                                                    */
/* ------------------------------------------------------------------ */

export interface CabinSpec {
  x: number;
  z: number;
  /** Rotation around Y in radians. 0 = gable end (and porch) faces north. */
  rot: number;
  w: number; // along local x
  d: number; // along local z
  floorY: number;
  /** Porch deck on the north (water) side. */
  porch: boolean;
  stilts: boolean;
  hue: number; // small red variation
  lit: boolean; // gets a real point light at the door
}

const WATERFRONT_FLOOR = 1.9;

export const CABINS: CabinSpec[] = [
  // Waterfront row on stilts, porches facing the fjord.
  { x: -112, z: -12, rot: 0, w: 6.5, d: 9, floorY: WATERFRONT_FLOOR, porch: true, stilts: true, hue: 0, lit: true },
  { x: -98, z: -12.5, rot: 0, w: 7, d: 9.5, floorY: WATERFRONT_FLOOR, porch: true, stilts: true, hue: 0.02, lit: true },
  { x: -84, z: -12, rot: 0, w: 6.5, d: 9, floorY: WATERFRONT_FLOOR, porch: true, stilts: true, hue: -0.015, lit: true },
  { x: -70, z: -12.5, rot: 0, w: 7.5, d: 10, floorY: WATERFRONT_FLOOR, porch: true, stilts: true, hue: 0.01, lit: true },
  { x: -56, z: -12, rot: 0, w: 6.5, d: 9, floorY: WATERFRONT_FLOOR, porch: true, stilts: true, hue: -0.02, lit: false },
  // Inland cabins on the snowy slope.
  { x: -104, z: 10, rot: 0.12, w: 6, d: 8, floorY: 0, porch: false, stilts: false, hue: 0.015, lit: false },
  { x: -86, z: 16, rot: -0.08, w: 6.5, d: 8.5, floorY: 0, porch: false, stilts: false, hue: -0.01, lit: true },
  { x: -66, z: 9, rot: 0.05, w: 6, d: 8, floorY: 0, porch: false, stilts: false, hue: 0.02, lit: false },
  { x: -44, z: 14, rot: -0.15, w: 6, d: 8, floorY: 0, porch: false, stilts: false, hue: 0, lit: false },
  { x: -30, z: 0, rot: 0.3, w: 5.5, d: 7.5, floorY: 0, porch: false, stilts: false, hue: -0.02, lit: false },
  // A pair on the skerry, below the knoll.
  { x: 44, z: 12, rot: Math.PI + 0.1, w: 6, d: 8, floorY: 0, porch: false, stilts: false, hue: 0.01, lit: true },
  { x: 58, z: 16, rot: Math.PI - 0.08, w: 5.5, d: 7.5, floorY: 0, porch: false, stilts: false, hue: -0.01, lit: false },
];

/** Porch deck in world space for a waterfront cabin. */
export function porchOf(c: CabinSpec) {
  const depth = 3.4;
  return {
    cx: c.x,
    cz: c.z - c.d / 2 - depth / 2 + 0.05,
    hw: c.w / 2 - 0.4,
    hd: depth / 2,
    rot: c.rot,
    y: c.floorY - 0.1,
  };
}

/* ------------------------------------------------------------------ */
/* Walkways                                                            */
/* ------------------------------------------------------------------ */

const BOARDWALK_Y = 1.6;

/** Waterfront boardwalk: runs east along the village shore, over water. */
export const BOARDWALK: P3[] = [
  { x: -119, y: BOARDWALK_Y, z: -21 },
  { x: -48, y: BOARDWALK_Y, z: -21 },
  { x: -30, y: BOARDWALK_Y, z: -18.2 },
  { x: -10, y: BOARDWALK_Y, z: -12 },
];
export const BOARDWALK_WIDTH = 2.6;

/** Stair spurs from the boardwalk down to the village. */
export const SPURS: P3[][] = [
  [
    { x: -91, y: BOARDWALK_Y, z: -20 },
    { x: -91, y: 1.25, z: -8.5 },
  ],
  [
    { x: -40, y: BOARDWALK_Y, z: -19.6 },
    { x: -40, y: 1.15, z: -8.0 },
  ],
];
export const SPUR_WIDTH = 1.8;

/** Arched footbridge across the channel. */
export const BRIDGE = {
  start: { x: -10, z: -12 },
  end: { x: 27, z: -12 },
  baseY: BOARDWALK_Y,
  endY: 1.75,
  rise: 1.9,
  width: 2.4,
};

export function bridgeHeight(t: number) {
  return BRIDGE.baseY + (BRIDGE.endY - BRIDGE.baseY) * t + Math.sin(Math.PI * t) * BRIDGE.rise;
}

export function bridgePoints(samples = 18): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    pts.push({
      x: BRIDGE.start.x + (BRIDGE.end.x - BRIDGE.start.x) * t,
      z: BRIDGE.start.z + (BRIDGE.end.z - BRIDGE.start.z) * t,
      y: bridgeHeight(t),
    });
  }
  return pts;
}

/** Rocky trail on the skerry, from the bridge landing up to the overlook.
 * Heights are resolved from the terrain (see heightfield.ts). */
export const TRAIL_XZ = [
  { x: 27, z: -12 },
  { x: 36, z: -9 },
  { x: 44, z: -2 },
  { x: 54, z: 3 },
  { x: 66, z: 4 },
  { x: 78, z: 0 },
  { x: 84, z: -9 },
  { x: 80, z: -18 },
  { x: 72, z: -22 },
];
export const TRAIL_HALF_WIDTH = 1.9;

/** The overlook plateau (end of the trail) and its viewing deck. */
export const OVERLOOK = { x: 72, z: -22, radius: 6.5 };
export const VIEW_DECK = { cx: 71, cz: -27.6, hw: 3.2, hd: 2.4, rot: 0 };

/* ------------------------------------------------------------------ */
/* Route + zones                                                       */
/* ------------------------------------------------------------------ */

export type ZoneId = 'porch' | 'waterfront' | 'bridge' | 'overlook';

export const ZONES: { id: ZoneId; label: string }[] = [
  { id: 'porch', label: 'Cabin porch' },
  { id: 'waterfront', label: 'Waterfront' },
  { id: 'bridge', label: 'Bridge' },
  { id: 'overlook', label: 'Rocky overlook' },
];

/** Player spawn: on the porch of the westernmost cabin, looking out over
 * the fjord toward the aurora. yaw 0 = looking north (-z). */
export const SPAWN = { x: -112, z: -18.2, yaw: -0.55 };

/** Waypoints of the intended route (XZ only), used by the autopilot tests. */
export const ROUTE_WAYPOINTS: { x: number; z: number; zone?: ZoneId }[] = [
  { x: -112, z: -18.0, zone: 'porch' },
  { x: -110, z: -21, zone: 'waterfront' },
  { x: -48, z: -21 },
  { x: -30, z: -18.2 },
  { x: -10.5, z: -12.1 },
  { x: 8, z: -12, zone: 'bridge' },
  { x: 27, z: -12 },
  ...TRAIL_XZ.slice(1),
  { x: VIEW_DECK.cx, z: VIEW_DECK.cz - 0.6, zone: 'overlook' },
];
