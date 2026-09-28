// Red timber rorbuer: gabled cabins, some on stilts over the water, with
// warm windows, snowy roofs and porches facing the fjord.

import * as THREE from 'three';
import { rng } from '../core/math';
import { cabinFloors, terrainHeight } from './heightfield';
import { CABINS, CabinSpec, porchOf } from './layout';
import { PALETTE } from './palette';
import { BuildContext } from './context';

const WALL_H = 2.6;

function cabinColor(hueShift: number) {
  const c = new THREE.Color(PALETTE.cabinRed);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h + hueShift * 0.3, hsl.s, hsl.l * (1 + hueShift * 4));
  return c;
}

function gablePrism(w: number, ridge: number, depth: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, ridge);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function buildCabins(ctx: BuildContext) {
  CABINS.forEach((c, i) => buildCabin(ctx, c, cabinFloors[i], i));
}

function buildCabin(ctx: BuildContext, c: CabinSpec, F: number, index: number) {
  const { batch, glows, lights } = ctx;
  const r = rng(900 + index * 71);
  const parent = new THREE.Matrix4().compose(
    new THREE.Vector3(c.x, 0, c.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot),
    new THREE.Vector3(1, 1, 1),
  );
  const toWorld = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx, ly, lz).applyMatrix4(parent);
  const P = { parent };
  const red = cabinColor(c.hue);
  const { w, d } = c;
  const ridge = w * 0.42;
  const ov = 0.35; // roof overhang

  // --- Supports ---------------------------------------------------------
  if (c.stilts) {
    for (const lx of [-w / 2 + 0.3, 0, w / 2 - 0.3]) {
      for (let lz = -d / 2 + 0.3; lz <= d / 2 - 0.2; lz += 2.1) {
        const wp = toWorld(lx, 0, lz);
        const bottom = Math.max(terrainHeight(wp.x, wp.z), -2.5) - 0.3;
        const h = F - bottom;
        if (h < 0.2) continue;
        batch.box(0.26, h, 0.26, { x: lx, y: bottom + h / 2, z: lz }, PALETTE.woodDark, P);
      }
    }
    // Stone footing where the back of the cabin meets the shore.
    const back = toWorld(0, 0, d / 2 - 0.5);
    const tb = terrainHeight(back.x, back.z);
    if (tb > -0.5) {
      const h = F - tb + 0.4;
      batch.box(w + 0.2, h, 1.4, { x: 0, y: tb - 0.4 + h / 2 - 0.1, z: d / 2 - 0.6 }, PALETTE.stone, P);
    }
  } else {
    batch.box(w + 0.3, 1.4, d + 0.3, { x: 0, y: F - 0.75, z: 0 }, PALETTE.stone, P);
  }

  // --- Body -------------------------------------------------------------
  batch.box(w + 0.1, 0.25, d + 0.1, { x: 0, y: F - 0.1, z: 0 }, PALETTE.woodDark, P);
  batch.box(w, WALL_H, d, { x: 0, y: F + WALL_H / 2, z: 0 }, red, P);
  const gable = gablePrism(w, ridge, d);
  batch.add(gable, new THREE.Matrix4().makeTranslation(0, F + WALL_H, 0).premultiply(parent), red);

  // Corner boards + gable fascia (white trim reads well at night).
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.box(0.16, WALL_H + 0.1, 0.16, { x: (sx * w) / 2, y: F + WALL_H / 2, z: (sz * d) / 2 }, PALETTE.trim, P);
    }
  }
  const pitch = Math.atan2(ridge, w / 2);
  const slopeLen = Math.hypot(w / 2 + ov, ridge + ov * Math.tan(pitch));
  for (const side of [-1, 1]) {
    const cx = (side * (w / 2 + ov)) / 2;
    const cy = F + WALL_H + (ridge - ov * Math.tan(pitch)) / 2;
    const nx = side * Math.sin(pitch);
    const ny = Math.cos(pitch);
    // Roof slab
    batch.box(slopeLen, 0.16, d + 0.7, { x: cx + nx * 0.1, y: cy + ny * 0.1, z: 0 }, PALETTE.roof, { ...P, rotZ: -side * pitch });
    // Snow blanket, a little inset so the dark eaves stay visible.
    batch.box(slopeLen - 0.25, 0.14, d + 0.45, { x: cx + nx * 0.23, y: cy + ny * 0.23, z: 0 }, PALETTE.roofSnow, {
      ...P,
      rotZ: -side * pitch,
    });
    // Fascia boards on both gable ends
    for (const sz of [-1, 1]) {
      batch.box(slopeLen, 0.2, 0.1, { x: cx + nx * 0.02, y: cy + ny * 0.02, z: sz * (d / 2 + 0.36) }, PALETTE.trim, {
        ...P,
        rotZ: -side * pitch,
      });
    }
  }
  // Chimney
  const chx = w * 0.18;
  const chz = d * 0.2;
  const roofYAt = F + WALL_H + ridge * (1 - Math.abs(chx) / (w / 2));
  batch.box(0.55, 1.5, 0.55, { x: chx, y: roofYAt + 0.45, z: chz }, PALETTE.stone, P);
  batch.box(0.62, 0.12, 0.62, { x: chx, y: roofYAt + 1.25, z: chz }, PALETTE.roofSnow, P);

  // --- Openings ---------------------------------------------------------
  const litChance = 0.78;
  const window = (lx: number, ly: number, lz: number, face: 'n' | 's' | 'e' | 'w', ww = 0.8, wh = 1.0, forceLit = false) => {
    const rotY = face === 'e' || face === 'w' ? Math.PI / 2 : 0;
    const out = face === 'n' ? -1 : face === 's' ? 1 : face === 'e' ? 1 : -1;
    const off = (k: number) =>
      face === 'n' || face === 's' ? { x: lx, y: ly, z: lz + out * k } : { x: lx + out * k, y: ly, z: lz };
    const lit = forceLit || r() < litChance;
    batch.box(ww + 0.18, wh + 0.18, 0.06, off(0.03), PALETTE.trim, { ...P, rotY });
    batch.box(ww, wh, 0.06, off(0.06), lit ? (r() < 0.3 ? PALETTE.amberHot : PALETTE.amber) : PALETTE.windowDark, {
      ...P,
      rotY,
      key: lit ? 'emissive' : 'solid',
    });
    // Mullions
    batch.box(0.05, wh, 0.05, off(0.1), PALETTE.trim, { ...P, rotY });
    batch.box(ww, 0.05, 0.05, off(0.1), PALETTE.trim, { ...P, rotY });
    if (lit) {
      const g = toWorld(off(0.25).x, ly, off(0.25).z);
      glows.push({ x: g.x, y: g.y, z: g.z, size: 2.2 + ww, color: PALETTE.amber, flicker: 0.05 });
    }
  };

  const yWin = F + 1.45;
  // North gable (water side): door + window + attic window.
  window(w * 0.24, yWin, -d / 2, 'n');
  window(0, F + WALL_H + ridge * 0.38, -d / 2, 'n', 0.55, 0.6);
  // South gable
  window(-w * 0.22, yWin, d / 2, 's');
  window(w * 0.22, yWin, d / 2, 's');
  window(0, F + WALL_H + ridge * 0.38, d / 2, 's', 0.55, 0.6);
  // Long sides
  for (const lz of [-d / 4, d / 4]) {
    window(w / 2, yWin, lz, 'e', 0.9, 1.0);
    window(-w / 2, yWin, lz, 'w', 0.9, 1.0);
  }

  // Door (north side) with a warm lamp above it.
  const doorX = -w * 0.22;
  batch.box(1.0, 2.05, 0.08, { x: doorX, y: F + 1.03, z: -d / 2 - 0.04 }, '#26312f', P);
  batch.box(1.2, 0.12, 0.1, { x: doorX, y: F + 2.12, z: -d / 2 - 0.05 }, PALETTE.trim, P);
  batch.box(0.22, 0.28, 0.22, { x: doorX + 0.75, y: F + 2.3, z: -d / 2 - 0.18 }, PALETTE.amberHot, { ...P, key: 'emissive' });
  const lamp = toWorld(doorX + 0.75, F + 2.3, -d / 2 - 0.35);
  glows.push({ x: lamp.x, y: lamp.y, z: lamp.z, size: 2.6, color: PALETTE.lampGlow, flicker: 0.08 });
  if (c.lit) {
    const out = toWorld(doorX + 0.75, F + 2.6, -d / 2 - 1.6);
    lights.push({ x: out.x, y: out.y, z: out.z, color: PALETTE.lampGlow, intensity: 6, distance: 13 });
  }

  // --- Porch ------------------------------------------------------------
  if (c.porch) {
    const p = porchOf(c);
    const lzC = p.cz - c.z; // porch center in local z (rot = 0 for porch cabins)
    const py = F - 0.1;
    const depth = p.hd * 2;
    const nPlanks = Math.floor(depth / 0.3);
    for (let k = 0; k < nPlanks; k++) {
      const z = lzC - p.hd + 0.15 + k * (depth / nPlanks);
      batch.box(p.hw * 2, 0.08, 0.26, { x: 0, y: py - 0.04, z }, k % 3 === 0 ? PALETTE.woodDark : PALETTE.wood, P);
    }
    // Posts under the porch.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * (p.hw - 0.15);
        const lz = lzC + sz * (p.hd - 0.15);
        const wp = toWorld(lx, 0, lz);
        const bottom = Math.max(terrainHeight(wp.x, wp.z), -2.5) - 0.3;
        batch.box(0.22, py - bottom, 0.22, { x: lx, y: (py + bottom) / 2, z: lz }, PALETTE.woodDark, P);
      }
    }
    // Side railings (open toward the boardwalk).
    for (const sx of [-1, 1]) {
      const x = sx * (p.hw + 0.06);
      for (const f of [0.1, 0.55, 1.0]) {
        const z = lzC + p.hd - 0.35 - f * (depth - 0.8);
        batch.box(0.1, 1.05, 0.1, { x, y: py + 0.52, z }, PALETTE.trim, P);
      }
      batch.box(0.08, 0.08, depth - 0.6, { x, y: py + 1.02, z: lzC + 0.3 - 0.1 }, PALETTE.trim, P);
      batch.box(0.06, 0.06, depth - 0.6, { x, y: py + 0.55, z: lzC + 0.3 - 0.1 }, PALETTE.wood, P);
    }
    // A couple of crates / a barrel for scale.
    batch.box(0.6, 0.5, 0.5, { x: w / 2 - 1.0, y: py + 0.25, z: -d / 2 - 0.5 }, PALETTE.wood, P);
    batch.box(0.45, 0.4, 0.45, { x: w / 2 - 1.05, y: py + 0.7, z: -d / 2 - 0.5 }, PALETTE.woodDark, { ...P, rotY: 0.4 });
  }
}
