// Wooden boardwalk, stair spurs, the illuminated footbridge and the
// overlook viewing deck.

import * as THREE from 'three';
import { jitterFaceColors } from '../render/batch';
import { noise2 } from '../core/math';
import { terrainHeight, trailSamples } from './heightfield';
import { BOARDWALK, BOARDWALK_WIDTH, BRIDGE, P3, SPURS, SPUR_WIDTH, VIEW_DECK, bridgePoints } from './layout';
import { PALETTE } from './palette';
import { BuildContext } from './context';
import { VIEW_DECK_Y } from './walkables';

interface PathOpts {
  posts?: boolean;
  /** Short bollards on the left-hand (seaward) edge. */
  bollards?: boolean;
}

function segmentFrame(a: P3, b: P3) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return {
    len,
    yaw: -Math.atan2(dz, dx),
    pitch: Math.atan2(b.y - a.y, len),
    ux: dx / len,
    uz: dz / len,
    // Left of travel direction (north when walking east).
    lx: dz / len,
    lz: -dx / len,
  };
}

/** Planked walkway along a polyline, with stringers and stilts. */
function plankPath(ctx: BuildContext, pts: P3[], width: number, opts: PathOpts = {}) {
  const { batch } = ctx;
  let postAcc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const f = segmentFrame(a, b);
    const n = Math.max(1, Math.round(f.len / 0.3));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t - 0.04;
      const shade = (k * 7 + i * 3) % 5 === 0 ? PALETTE.woodDark : PALETTE.wood;
      batch.box((f.len / n) * 0.88, 0.08, width, { x, y, z }, shade, { rotY: f.yaw, rotZ: f.pitch });
    }
    // Stringers under both edges.
    for (const side of [-1, 1]) {
      const off = side * (width / 2 - 0.18);
      batch.box(f.len + 0.1, 0.2, 0.16, {
        x: (a.x + b.x) / 2 + f.lx * off,
        y: (a.y + b.y) / 2 - 0.18,
        z: (a.z + b.z) / 2 + f.lz * off,
      }, PALETTE.woodDark, { rotY: f.yaw, rotZ: f.pitch });
    }
    // Joint pad at interior vertices so turns have no gaps.
    if (i > 0) {
      batch.box(width * 0.72, 0.08, width * 0.72, { x: a.x, y: a.y - 0.05, z: a.z }, PALETTE.wood, { rotY: f.yaw + Math.PI / 4 });
    }
    // Stilts / bollards at a regular spacing.
    const spacing = 2.4;
    let s = postAcc;
    while (s < f.len) {
      const t = s / f.len;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      for (const side of [-1, 1]) {
        const px = x + f.lx * side * (width / 2 - 0.12);
        const pz = z + f.lz * side * (width / 2 - 0.12);
        const ground = Math.max(terrainHeight(px, pz), -2.5) - 0.3;
        const top = opts.bollards && side === 1 ? y + 0.55 : y - 0.1;
        if (opts.posts !== false && top - ground > 0.2) {
          batch.box(0.2, top - ground, 0.2, { x: px, y: (top + ground) / 2, z: pz }, PALETTE.woodDark);
        }
        if (opts.bollards && side === 1) {
          // Snow cap on the bollard reads as a little row of lights at night.
          batch.box(0.24, 0.06, 0.24, { x: px, y: top + 0.03, z: pz }, PALETTE.roofSnow);
        }
      }
      s += opts.bollards ? spacing * 2 : spacing;
    }
    postAcc = s - f.len;
  }
}

function buildBridge(ctx: BuildContext) {
  const { batch, glows, lights } = ctx;
  const pts = bridgePoints(24);
  plankPath(ctx, pts, BRIDGE.width, { posts: false });

  const hw = BRIDGE.width / 2;
  const railH = 1.05;
  // Railing posts on every other sample, rails between them, following the arch.
  for (const side of [-1, 1]) {
    const zOff = side * (hw + 0.06);
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i];
      batch.box(0.12, railH + 0.1, 0.12, { x: p.x, y: p.y + railH / 2, z: p.z + zOff }, PALETTE.trim);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const f = segmentFrame(a, b);
      const len = Math.hypot(f.len, b.y - a.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 + zOff };
      batch.box(len + 0.02, 0.09, 0.14, { ...mid, y: mid.y + railH }, PALETTE.trim, { rotY: f.yaw, rotZ: f.pitch });
      batch.box(len + 0.02, 0.06, 0.08, { ...mid, y: mid.y + railH * 0.5 }, PALETTE.wood, { rotY: f.yaw, rotZ: f.pitch });
    }
    // String lights tucked under the handrail.
    const total = pts.length - 1;
    for (let k = 1; k < total * 3; k++) {
      const t = k / (total * 3);
      const fi = t * total;
      const i = Math.floor(fi);
      const a = pts[i];
      const b = pts[Math.min(i + 1, total)];
      const u = fi - i;
      const x = a.x + (b.x - a.x) * u;
      const y = a.y + (b.y - a.y) * u + railH - 0.12;
      const z = a.z + (b.z - a.z) * u + zOff;
      batch.box(0.07, 0.09, 0.07, { x, y, z }, k % 4 === 0 ? PALETTE.amberHot : PALETTE.amber, { key: 'emissive' });
      glows.push({ x, y, z, size: 0.75, color: PALETTE.amber, flicker: 0.12 });
    }
  }

  // Piers into the channel + cross beams.
  for (const t of [0.22, 0.5, 0.78]) {
    const x = BRIDGE.start.x + (BRIDGE.end.x - BRIDGE.start.x) * t;
    const i = Math.round(t * (pts.length - 1));
    const y = pts[i].y - 0.28;
    for (const side of [-1, 1]) {
      const z = BRIDGE.start.z + side * (hw - 0.15);
      const bottom = Math.max(terrainHeight(x, z), -3) - 0.2;
      batch.box(0.32, y - bottom, 0.32, { x, y: (y + bottom) / 2, z }, PALETTE.woodDark);
    }
    batch.box(0.25, 0.25, BRIDGE.width + 0.3, { x, y: y - 0.05, z: BRIDGE.start.z }, PALETTE.woodDark);
    // X-braces below the deck
    batch.box(0.12, 0.12, Math.hypot(BRIDGE.width, 1.6), { x, y: y - 0.9, z: BRIDGE.start.z }, PALETTE.woodDark, {
      rotX: Math.atan2(1.6, BRIDGE.width),
    });
  }
  // Stone abutments at both ends.
  for (const end of [BRIDGE.start, BRIDGE.end]) {
    const bottom = Math.max(terrainHeight(end.x, end.z), -2) - 0.5;
    const top = BRIDGE.baseY - 0.3;
    batch.box(1.6, top - bottom, BRIDGE.width + 0.8, { x: end.x, y: (top + bottom) / 2, z: end.z }, PALETTE.stone);
  }

  // The crown lantern gets a real light; end lanterns come from LAMPS.
  const crown = pts[Math.floor(pts.length / 2)];
  lights.push({ x: crown.x, y: crown.y + 2.2, z: crown.z, color: PALETTE.lampGlow, intensity: 7, distance: 12 });
}

function buildViewDeck(ctx: BuildContext) {
  const { batch } = ctx;
  const y = VIEW_DECK_Y();
  const { cx, cz, hw, hd } = VIEW_DECK;
  const n = Math.round((hw * 2) / 0.3);
  for (let k = 0; k < n; k++) {
    const x = cx - hw + (k + 0.5) * ((hw * 2) / n);
    batch.box(((hw * 2) / n) * 0.88, 0.08, hd * 2, { x, y: y - 0.04, z: cz }, k % 4 === 0 ? PALETTE.woodDark : PALETTE.wood);
  }
  // Supports down to the rock.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = cx + sx * (hw - 0.2);
      const z = cz + sz * (hd - 0.2);
      const bottom = terrainHeight(x, z) - 0.5;
      batch.box(0.24, y - bottom, 0.24, { x, y: (y + bottom) / 2, z }, PALETTE.woodDark);
    }
  }
  // Railing on three sides.
  const railY = y + 1.05;
  const rails: [number, number, number, number][] = [
    [cx, cz - hd - 0.05, hw * 2 + 0.2, 0],
    [cx - hw - 0.05, cz - 0.4, (hd - 0.4) * 2, Math.PI / 2],
    [cx + hw + 0.05, cz - 0.4, (hd - 0.4) * 2, Math.PI / 2],
  ];
  for (const [x, z, len, rot] of rails) {
    batch.box(len, 0.09, 0.14, { x, y: railY, z }, PALETTE.trim, { rotY: rot });
    batch.box(len, 0.06, 0.08, { x, y: y + 0.52, z }, PALETTE.wood, { rotY: rot });
    const posts = Math.round(len / 1.2);
    for (let k = 0; k <= posts; k++) {
      const u = -len / 2 + (k * len) / posts;
      const px = rot === 0 ? x + u : x;
      const pz = rot === 0 ? z : z + u;
      batch.box(0.11, 1.08, 0.11, { x: px, y: y + 0.52, z: pz }, PALETTE.trim);
    }
  }
}

/** Trodden path on the skerry: a ragged ribbon of packed snow and grit
 * draped over the terrain, plus a few flat stones. */
function buildTrail(ctx: BuildContext) {
  const pts = trailSamples();
  const pos: number[] = [];
  const edge = (i: number, side: number) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const p = pts[i];
    const w = 1.05 + noise2(i * 0.45, side * 3.1, 61) * 0.3;
    const x = p.x + (-dz / len) * side * w;
    const z = p.z + (dx / len) * side * w;
    return new THREE.Vector3(x, terrainHeight(x, z) + 0.05, z);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = edge(i, 1);
    const r0 = edge(i, -1);
    const l1 = edge(i + 1, 1);
    const r1 = edge(i + 1, -1);
    pos.push(l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z);
    pos.push(r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const added = ctx.batch.add(g, new THREE.Matrix4(), PALETTE.trail);
  jitterFaceColors(added, 0.12, 7);

}

export function buildWalkways(ctx: BuildContext) {
  buildTrail(ctx);
  plankPath(ctx, BOARDWALK, BOARDWALK_WIDTH, { bollards: true });
  for (const s of SPURS) plankPath(ctx, s, SPUR_WIDTH);
  // Landing where the boardwalk meets the bridge.
  ctx.batch.box(2.6, 0.1, 2.6, { x: BRIDGE.start.x - 0.6, y: BRIDGE.baseY - 0.05, z: BRIDGE.start.z }, PALETTE.wood);
  buildBridge(ctx);
  buildViewDeck(ctx);
}
