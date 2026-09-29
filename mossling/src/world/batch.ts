import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Collects lots of small props into one merged mesh per material, so a whole
// forest costs a handful of draw calls. Colors are baked per face, which is
// what gives everything its chunky faceted look.

export type FaceTint = (normal: THREE.Vector3, center: THREE.Vector3, base: THREE.Color, out: THREE.Color) => void;

type AddOptions = {
  color: THREE.ColorRepresentation;
  /** Random per-face brightness variation (0..1). */
  vary?: number;
  /** Push vertices around deterministically for lumpy, hand-made shapes. */
  lumpy?: number;
  tint?: FaceTint;
  rand?: () => number;
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpCenter = new THREE.Vector3();

function lumpHash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

export class Batch {
  private parts: THREE.BufferGeometry[] = [];

  add(source: THREE.BufferGeometry, matrix: THREE.Matrix4, opts: AddOptions): this {
    const geo = source.index ? source.toNonIndexed() : source.clone();
    const pos = geo.attributes.position as THREE.BufferAttribute;

    if (opts.lumpy) {
      // Keyed on the original position so shared corners move together (no cracks).
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const k = opts.lumpy;
        pos.setXYZ(i, x + lumpHash(x, y, z) * k, y + lumpHash(y, z, x) * k, z + lumpHash(z, x, y) * k);
      }
    }

    geo.applyMatrix4(matrix);
    geo.computeVertexNormals();

    const base = new THREE.Color(opts.color);
    const out = new THREE.Color();
    const colors = new Float32Array(pos.count * 3);
    const rand = opts.rand ?? Math.random;
    for (let i = 0; i < pos.count; i += 3) {
      tmpA.fromBufferAttribute(pos, i);
      tmpB.fromBufferAttribute(pos, i + 1);
      tmpC.fromBufferAttribute(pos, i + 2);
      tmpN.subVectors(tmpB, tmpA).cross(tmpC.clone().sub(tmpA)).normalize();
      tmpCenter.copy(tmpA).add(tmpB).add(tmpC).divideScalar(3);
      out.copy(base);
      opts.tint?.(tmpN, tmpCenter, base, out);
      const v = 1 + (rand() - 0.5) * (opts.vary ?? 0.12);
      for (let k = 0; k < 3; k++) colors.set([out.r * v, out.g * v, out.b * v], (i + k) * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) geo.deleteAttribute(name);
    this.parts.push(geo);
    return this;
  }

  build(material: THREE.Material): THREE.Mesh {
    const merged = this.parts.length ? mergeGeometries(this.parts)! : new THREE.BufferGeometry();
    this.parts.forEach((p) => p.dispose());
    this.parts = [];
    return new THREE.Mesh(merged, material);
  }
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const p = new THREE.Vector3();
const s = new THREE.Vector3();

/** Compose a transform matrix from position / euler rotation / scale. */
export function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return m4.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz)).clone();
}
