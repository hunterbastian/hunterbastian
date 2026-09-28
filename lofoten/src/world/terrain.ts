// Low-poly terrain meshes: a detailed walkable area and a coarse ring of
// jagged, snow-streaked mountains around the fjord.

import * as THREE from 'three';
import { fbm, noise2, smoothstep } from '../core/math';
import { farHeight, shoreDistance, terrainHeight, trailQuery } from './heightfield';
import { NEAR_BOUNDS, OVERLOOK } from './layout';
import { PALETTE } from './palette';

type ColorFn = (cx: number, cy: number, cz: number, ny: number, out: THREE.Color) => void;

/**
 * Builds a flat-shaded (non-indexed) grid mesh. Each triangle gets one
 * color from `colorFn`, evaluated at its centroid with its face normal.
 */
function buildGrid(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  step: number,
  heightFn: (x: number, z: number) => number,
  colorFn: ColorFn,
  skipBelow = -Infinity,
) {
  const nx = Math.round((maxX - minX) / step);
  const nz = Math.round((maxZ - minZ) / step);
  const heights = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      heights[j * (nx + 1) + i] = heightFn(minX + i * step, minZ + j * step);
    }
  }
  const pos: number[] = [];
  const col: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const color = new THREE.Color();

  const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => {
    if (p.y < skipBelow && q.y < skipBelow && r.y < skipBelow) return;
    e1.subVectors(q, p);
    e2.subVectors(r, p);
    n.crossVectors(e1, e2).normalize();
    if (n.y < 0) n.negate();
    colorFn((p.x + q.x + r.x) / 3, (p.y + q.y + r.y) / 3, (p.z + q.z + r.z) / 3, n.y, color);
    pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
  };

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = minX + i * step;
      const z0 = minZ + j * step;
      const h00 = heights[j * (nx + 1) + i];
      const h10 = heights[j * (nx + 1) + i + 1];
      const h01 = heights[(j + 1) * (nx + 1) + i];
      const h11 = heights[(j + 1) * (nx + 1) + i + 1];
      // Alternate the diagonal for a less regular low-poly look.
      if ((i + j) % 2 === 0) {
        tri(a.set(x0, h00, z0), b.set(x0, h01, z0 + step), c.set(x0 + step, h10, z0));
        tri(a.set(x0 + step, h10, z0), b.set(x0, h01, z0 + step), c.set(x0 + step, h11, z0 + step));
      } else {
        tri(a.set(x0, h00, z0), b.set(x0 + step, h11, z0 + step), c.set(x0 + step, h10, z0));
        tri(a.set(x0, h00, z0), b.set(x0, h01, z0 + step), c.set(x0 + step, h11, z0 + step));
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geom.computeVertexNormals();
  return geom;
}

const C = {
  snow: new THREE.Color(PALETTE.snow),
  snowShade: new THREE.Color(PALETTE.snowShade),
  trail: new THREE.Color(PALETTE.trail),
  rock: new THREE.Color(PALETTE.rock),
  rockDark: new THREE.Color(PALETTE.rockDark),
  wet: new THREE.Color(PALETTE.wetRock),
};

const nearColor: ColorFn = (x, y, z, ny, out) => {
  const jitter = noise2(x * 0.7, z * 0.7, 91) * 0.06;
  const patch = fbm(x * 0.08, z * 0.08, 2, 17);
  if (y < 0.35) {
    // Wet, dark rock at the waterline — a crisp readable shoreline.
    out.copy(C.wet);
  } else if (ny < 0.74 + patch * 0.08) {
    out.copy(C.rock).lerp(C.rockDark, smoothstep(0.6, 0.3, ny));
  } else {
    out.copy(C.snow).lerp(C.snowShade, smoothstep(-0.2, 0.5, patch));
    // Trodden trail on the skerry and around the overlook.
    if (x > 20 && x < 95 && z > -35 && z < 15) {
      const tq = trailQuery(x, z);
      const onTrail = 1 - smoothstep(0.9, 1.7, tq.dist);
      const plateau = 1 - smoothstep(3.5, 5.5, Math.hypot(x - OVERLOOK.x, z - OVERLOOK.z));
      out.lerp(C.trail, Math.max(onTrail, plateau * 0.6) * 0.8);
    }
    // Thin rocky band just above the tideline.
    if (y < 0.9) out.lerp(C.rockDark, smoothstep(0.9, 0.4, y) * 0.8);
  }
  out.multiplyScalar(1 + jitter);
};

const farColor: ColorFn = (x, y, z, ny, out) => {
  const n = fbm(x * 0.008, z * 0.008, 3, 5);
  const streak = noise2(x * 0.035, z * 0.035, 19);
  const snowLine = 22 + n * 35;
  // Snow clings to anything that is not a sheer face; crests are wind-crusted.
  const holds = ny > 0.4 + n * 0.12 + streak * 0.14 || (y > 260 && ny > 0.25);
  if (y < 5) out.copy(C.wet);
  else if (y > snowLine && holds) out.copy(C.snow).lerp(C.snowShade, smoothstep(0.85, 0.45, ny));
  else out.copy(C.rock).lerp(C.rockDark, smoothstep(0.5, 0.15, ny) * 0.9);
  out.multiplyScalar(1 + noise2(x * 0.2, z * 0.2, 3) * 0.05);
};

export function buildTerrain() {
  const group = new THREE.Group();
  group.name = 'terrain';

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const B = NEAR_BOUNDS;
  const near = buildGrid(B.minX, B.maxX, B.minZ, B.maxZ, 2, terrainHeight, nearColor, -3.2);
  const nearMesh = new THREE.Mesh(near, mat);
  nearMesh.name = 'terrain-near';
  nearMesh.receiveShadow = true;
  nearMesh.castShadow = true;
  group.add(nearMesh);

  const far = buildGrid(-2200, 2200, -2200, 2200, 20, farHeight, farColor, -4);
  const farMesh = new THREE.Mesh(far, mat);
  farMesh.name = 'terrain-far';
  group.add(farMesh);

  return group;
}

/** Is (x, z) under the sea? Handy for props. */
export const isWater = (x: number, z: number) => shoreDistance(x, z) > 0;
