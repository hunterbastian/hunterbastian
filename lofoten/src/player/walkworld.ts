// Walkable-world queries: ground height, decks, colliders.
// Pure TypeScript with no three.js dependency so it runs in node tests.

import { clamp, lerp } from '../core/math';
import { terrainHeight, terrainSlope } from '../world/heightfield';
import { NEAR_BOUNDS, P3, SEA_LEVEL } from '../world/layout';

/** Terrain lower than this counts as water (the shoreline boundary). */
export const SHORE_MIN = SEA_LEVEL + 0.15;
/** Steepest terrain the player can walk up (rise / run ≈ 40°). */
export const MAX_SLOPE = 0.85;

/** Polyline walkway (boardwalk, bridge, stairs). Height is interpolated. */
export interface DeckPath {
  kind: 'path';
  tag: string;
  points: P3[];
  halfWidth: number;
}

/** Flat rectangular deck (porches, viewing platforms). */
export interface DeckPad {
  kind: 'pad';
  tag: string;
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rot: number;
  y: number;
}

export type Deck = DeckPath | DeckPad;

/** Oriented box collider with vertical extent. */
export interface BoxCollider {
  kind: 'box';
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rot: number;
  yMin: number;
  yMax: number;
}

export interface CircleCollider {
  kind: 'circle';
  x: number;
  z: number;
  r: number;
  yMin: number;
  yMax: number;
}

export type Collider = BoxCollider | CircleCollider;

export interface GroundHit {
  y: number;
  /** 'terrain' or the tag of the deck. */
  surface: string;
}

function toLocal(x: number, z: number, cx: number, cz: number, rot: number) {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

function toWorld(lx: number, lz: number, cx: number, cz: number, rot: number) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
}

export class WalkWorld {
  readonly decks: Deck[] = [];
  readonly colliders: Collider[] = [];

  addDeck(d: Deck) {
    this.decks.push(d);
  }

  addCollider(c: Collider) {
    this.colliders.push(c);
  }

  /** Height of a deck at (x, z), or null if the point is not on it. */
  deckHeight(d: Deck, x: number, z: number): number | null {
    if (d.kind === 'pad') {
      const { lx, lz } = toLocal(x, z, d.cx, d.cz, d.rot);
      return Math.abs(lx) <= d.hw && Math.abs(lz) <= d.hd ? d.y : null;
    }
    let best: number | null = null;
    const pts = d.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const tRaw = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      const t = clamp(tRaw, 0, 1);
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      if (dist > d.halfWidth) continue;
      // Square ends at the first/last point; round joints in between.
      if ((i === 0 && tRaw < 0) || (i === pts.length - 2 && tRaw > 1)) continue;
      const y = lerp(a.y, b.y, t);
      if (best === null || y > best) best = y;
    }
    return best;
  }

  /** All candidate ground heights at a point (terrain if it is land, plus decks). */
  groundCandidates(x: number, z: number, out: GroundHit[] = []) {
    out.length = 0;
    const th = terrainHeight(x, z);
    if (th >= SHORE_MIN) out.push({ y: th, surface: 'terrain' });
    for (const d of this.decks) {
      const y = this.deckHeight(d, x, z);
      if (y !== null) out.push({ y, surface: d.tag });
    }
    return out;
  }

  /**
   * The surface the player would stand on at (x, z) given current feet
   * height. Returns null when the spot is not walkable: open water, outside
   * the world, or a wall/ledge higher than a step.
   */
  ground(x: number, z: number, feetY: number, maxStep: number): GroundHit | null {
    if (x < NEAR_BOUNDS.minX + 4 || x > NEAR_BOUNDS.maxX - 4 || z < NEAR_BOUNDS.minZ + 4 || z > NEAR_BOUNDS.maxZ - 4) {
      return null;
    }
    const cands = this.groundCandidates(x, z, scratch);
    let best: GroundHit | null = null;
    for (const c of cands) {
      if (c.y > feetY + maxStep) continue;
      if (!best || c.y > best.y) best = c;
    }
    return best ? { y: best.y, surface: best.surface } : null;
  }

  /** True if moving onto terrain here would mean climbing a too-steep slope. */
  tooSteep(x: number, z: number, fromY: number, toY: number) {
    if (toY <= fromY + 0.02) return false;
    return terrainSlope(x, z) > MAX_SLOPE;
  }

  /** Push a circle (player) out of all colliders overlapping its vertical span. */
  resolveColliders(pos: { x: number; z: number }, radius: number, feetY: number, height: number) {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (feetY + height < c.yMin || feetY > c.yMax) continue;
        if (c.kind === 'circle') {
          const dx = pos.x - c.x;
          const dz = pos.z - c.z;
          const d = Math.hypot(dx, dz);
          const min = c.r + radius;
          if (d < min) {
            const nx = d > 1e-6 ? dx / d : 1;
            const nz = d > 1e-6 ? dz / d : 0;
            pos.x = c.x + nx * min;
            pos.z = c.z + nz * min;
            moved = hit = true;
          }
        } else {
          const { lx, lz } = toLocal(pos.x, pos.z, c.cx, c.cz, c.rot);
          const qx = clamp(lx, -c.hw, c.hw);
          const qz = clamp(lz, -c.hd, c.hd);
          const dx = lx - qx;
          const dz = lz - qz;
          const d = Math.hypot(dx, dz);
          if (d >= radius) continue;
          let nlx: number;
          let nlz: number;
          if (d < 1e-6) {
            // Centre is inside the box: push out along the shallowest axis.
            const px = c.hw - Math.abs(lx);
            const pz = c.hd - Math.abs(lz);
            if (px < pz) {
              nlx = Math.sign(lx) * (c.hw + radius);
              nlz = lz;
            } else {
              nlx = lx;
              nlz = Math.sign(lz) * (c.hd + radius);
            }
          } else {
            nlx = qx + (dx / d) * radius;
            nlz = qz + (dz / d) * radius;
          }
          const w = toWorld(nlx, nlz, c.cx, c.cz, c.rot);
          pos.x = w.x;
          pos.z = w.z;
          moved = hit = true;
        }
      }
      if (!moved) break;
    }
    return hit;
  }
}

const scratch: GroundHit[] = [];
