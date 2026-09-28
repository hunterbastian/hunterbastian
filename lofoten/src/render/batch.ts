// Collects many small low-poly parts and merges them into a handful of
// meshes (one per material), keeping draw calls low.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tmpColor = new THREE.Color();

export type BatchKey = 'solid' | 'emissive';

export class GeoBatch {
  private parts: Record<BatchKey, THREE.BufferGeometry[]> = { solid: [], emissive: [] };

  /** Adds a geometry (consumed) with a flat color, transformed by `matrix`. */
  add(geom: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.ColorRepresentation, key: BatchKey = 'solid') {
    let g = geom.index ? geom.toNonIndexed() : geom;
    if (g !== geom) geom.dispose();
    g.deleteAttribute('uv');
    g.applyMatrix4(matrix);
    g.computeVertexNormals();
    tmpColor.set(color);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts[key].push(g);
    return g;
  }

  /** Axis-aligned-in-local-space box helper. */
  box(
    w: number,
    h: number,
    d: number,
    pos: THREE.Vector3Like,
    color: THREE.ColorRepresentation,
    opts: { rotX?: number; rotY?: number; rotZ?: number; parent?: THREE.Matrix4; key?: BatchKey } = {},
  ) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(pos.x, pos.y, pos.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(opts.rotX ?? 0, opts.rotY ?? 0, opts.rotZ ?? 0, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    if (opts.parent) m.premultiply(opts.parent);
    return this.add(new THREE.BoxGeometry(w, h, d), m, color, opts.key);
  }

  build(materials: Record<BatchKey, THREE.Material>, name: string) {
    const group = new THREE.Group();
    group.name = name;
    (Object.keys(this.parts) as BatchKey[]).forEach((key) => {
      const list = this.parts[key];
      if (!list.length) return;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) return;
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = `${name}-${key}`;
      mesh.castShadow = key === 'solid';
      mesh.receiveShadow = key === 'solid';
      group.add(mesh);
    });
    return group;
  }
}

/** Shared materials for batched geometry. */
export function batchMaterials(): Record<BatchKey, THREE.Material> {
  return {
    solid: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    emissive: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
}

/** Deterministic per-face color jitter so flat surfaces read as low-poly facets. */
export function jitterFaceColors(geom: THREE.BufferGeometry, amount: number, seed = 1) {
  const col = geom.getAttribute('color') as THREE.BufferAttribute;
  let s = seed;
  for (let i = 0; i < col.count; i += 3) {
    s = (s * 16807) % 2147483647;
    const j = 1 + ((s / 2147483647) * 2 - 1) * amount;
    for (let k = 0; k < 3; k++) {
      col.setXYZ(i + k, col.getX(i + k) * j, col.getY(i + k) * j, col.getZ(i + k) * j);
    }
  }
  col.needsUpdate = true;
}
