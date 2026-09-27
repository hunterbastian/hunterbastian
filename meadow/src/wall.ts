import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BRICK } from './config';
import { noise2, rng } from './noise';
import type { Vec2 } from './pathMask';
import { heightAt } from './terrain';

export interface WallData {
  id: number;
  pts: Vec2[];
  courses: number;
  seed: number;
}

/** Anything that can tell us how much dirt path lies at a point (for arches). */
export interface PathSampler {
  sample(x: number, z: number): number;
}

// ---------------------------------------------------------------------------
// Polyline helpers

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function chaikin(pts: Vec2[], iterations: number): Vec2[] {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    if (out.length < 3) return out;
    const next: Vec2[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, az] = out[i];
      const [bx, bz] = out[i + 1];
      next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

export function resample(pts: Vec2[], spacing: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const seg = Math.hypot(bx - ax, bz - az);
    let d = spacing - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      d += spacing;
    }
    carry = seg - (d - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > spacing * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Turn a raw pointer trail into the smooth, evenly spaced spine we store. */
export function tidyStroke(raw: Vec2[]): Vec2[] {
  return resample(chaikin(raw, 3), 0.3);
}

// ---------------------------------------------------------------------------
// Arc-length parameterised curve

class Curve {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;

  constructor(pts: Vec2[]) {
    const n = pts.length;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = pts[i][0];
      this.zs[i] = pts[i][1];
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.zs[i] - this.zs[i - 1]);
    }
    this.length = this.cum[n - 1];
  }

  point(s: number, out: THREE.Vector2): THREE.Vector2 {
    s = THREE.MathUtils.clamp(s, 0, this.length);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    return out.set(this.xs[lo] + (this.xs[hi] - this.xs[lo]) * t, this.zs[lo] + (this.zs[hi] - this.zs[lo]) * t);
  }

  tangent(s: number, out: THREE.Vector2): THREE.Vector2 {
    const a = this.point(s - 0.2, new THREE.Vector2());
    const b = this.point(s + 0.2, new THREE.Vector2());
    out.subVectors(b, a);
    if (out.lengthSq() < 1e-8) out.set(1, 0);
    return out.normalize();
  }
}

// ---------------------------------------------------------------------------
// Brick building

const RING = 0.34; // thickness of the arch's voussoir ring

const brickGeometry = new RoundedBoxGeometry(BRICK.length, BRICK.height, BRICK.thickness, 2, 0.055);
export const brickMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });

const PALETTE = [0xbfa47c, 0xb39873, 0xc7ad84, 0xaa9170, 0xb89f7a, 0xc4aa82].map((h) =>
  new THREE.Color().setHex(h, THREE.SRGBColorSpace),
);

interface Arch {
  c: number;
  w: number;
  h: number;
}

function findArches(curve: Curve, paths: PathSampler | null, wallTop: number): Arch[] {
  if (!paths || curve.length < 1.5) return [];
  const step = 0.1;
  const v = new THREE.Vector2();
  const ranges: [number, number][] = [];
  let start = -1;
  for (let s = 0; s <= curve.length; s += step) {
    curve.point(s, v);
    const on = paths.sample(v.x, v.y) > 0.45;
    if (on && start < 0) start = s;
    if (!on && start >= 0) {
      ranges.push([start, s]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, curve.length]);

  // Merge near-touching ranges.
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 0.5) last[1] = r[1];
    else merged.push([...r]);
  }

  return merged
    .filter(([a, b]) => b - a > 0.15)
    .map(([a, b]) => {
      const w = THREE.MathUtils.clamp((b - a) / 2 + 0.3, 0.6, 2.4);
      const h = Math.min(w * 1.25 + 0.4, Math.max(wallTop, 2.2) - RING - 0.3);
      return { c: (a + b) / 2, w, h: Math.max(h, 0.9) };
    });
}

/** Height of the arch opening at arc length s (0 when outside every arch). */
function archProfile(arches: Arch[], s: number): number {
  let best = 0;
  for (const a of arches) {
    const d = (s - a.c) / a.w;
    if (Math.abs(d) < 1) best = Math.max(best, a.h * Math.sqrt(1 - d * d));
  }
  return best;
}

export function buildWall(data: WallData, paths: PathSampler | null): THREE.InstancedMesh | null {
  if (data.pts.length < 2) return null;
  const curve = new Curve(resample(data.pts, 0.1));
  const L = curve.length;
  if (L < 0.4) return null;

  const H = BRICK.height;
  const baseTop = data.courses * H;
  const arches = findArches(curve, paths, baseTop);

  const v = new THREE.Vector2();
  const tan = new THREE.Vector2();

  // Lower envelope of the ground along the wall, so bricks sit into slopes.
  const baseAt = (s: number): number => {
    let lo = Infinity;
    for (const ds of [-0.35, 0, 0.35]) {
      curve.point(s + ds, v);
      curve.tangent(s + ds, tan);
      for (const side of [-0.5, 0.5]) {
        lo = Math.min(lo, heightAt(v.x - tan.y * side * BRICK.thickness, v.y + tan.x * side * BRICK.thickness));
      }
    }
    return lo - 0.08;
  };
  const archBase = arches.map((a) => {
    let lo = Infinity;
    for (let s = a.c - a.w - 0.4; s <= a.c + a.w + 0.4; s += 0.25) lo = Math.min(lo, baseAt(s));
    return lo;
  });
  const groundAt = (s: number): number => {
    for (let i = 0; i < arches.length; i++) if (Math.abs(s - arches[i].c) < arches[i].w + 0.5) return archBase[i];
    return baseAt(s);
  };

  const coursesAt = (s: number): number => {
    const n = noise2(s * 0.45 + data.seed * 0.013, data.seed * 0.7, data.seed);
    let c = data.courses + (n > 0.66 ? 1 : 0) - (n < 0.2 ? 1 : 0);
    for (const a of arches) {
      if (Math.abs(s - a.c) < a.w + 0.9) c = Math.max(c, Math.ceil((a.h + RING) / H) + 2);
    }
    return Math.max(2, c);
  };

  const maxCourses = Math.max(data.courses + 1, ...arches.map((a) => Math.ceil((a.h + RING) / H) + 2));
  const matrices: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];
  const r = rng(data.seed);

  const X = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();

  const pushBrick = (s: number, yLocal: number, ground: number, lenX: number, lenY: number, angle: number, top: boolean) => {
    curve.point(s, v);
    curve.tangent(s, tan);
    const yaw = (r() - 0.5) * 0.06;
    const cx = Math.cos(yaw);
    const sx = Math.sin(yaw);
    const ax = tan.x * cx - tan.y * sx;
    const az = tan.x * sx + tan.y * cx;
    const along = new THREE.Vector3(ax, 0, az);
    const nrm = new THREE.Vector3(-az, 0, ax);
    // Rotate the brick within the wall plane (used by arch voussoirs).
    X.copy(along).multiplyScalar(Math.cos(angle)).addScaledVector(Y, Math.sin(angle));
    const localY = new THREE.Vector3().copy(along).multiplyScalar(-Math.sin(angle)).addScaledVector(Y, Math.cos(angle));
    Z.copy(nrm);
    const m = new THREE.Matrix4().makeBasis(X, localY, Z);
    const jitterN = (r() - 0.5) * 0.06;
    P.set(v.x, ground + yLocal, v.y).addScaledVector(nrm, jitterN);
    S.set(
      Math.max(0.05, lenX - BRICK.gap) / BRICK.length,
      Math.max(0.05, lenY - BRICK.gap * (0.7 + r() * 0.6)) / BRICK.height,
      (0.9 + r() * 0.14),
    );
    m.scale(S);
    m.setPosition(P);
    matrices.push(m);

    const col = PALETTE[Math.floor(r() * PALETTE.length)].clone();
    col.offsetHSL((r() - 0.5) * 0.02, (r() - 0.5) * 0.06, (r() - 0.5) * 0.05 + (top ? 0.02 : 0));
    colors.push(col);
  };

  for (let c = 0; c < maxCourses; c++) {
    let s = 0;
    let first = true;
    while (s < L - 0.05) {
      let len = BRICK.length * (0.82 + r() * 0.36);
      if (first && c % 2 === 1) len *= 0.5;
      first = false;
      if (L - s - len < BRICK.length * 0.35) len = L - s;
      const s0 = s;
      const s1 = s + len;
      s = s1;
      const mid = (s0 + s1) / 2;
      const top = coursesAt(mid);
      if (c >= top) continue;
      // Crenel-ish gaps along the top course.
      if (c === top - 1 && r() < 0.28) continue;
      const bottom = c * H;
      // Keep the arch opening clear; let bricks tuck slightly behind the voussoir ring
      // rather than leaving holes around it.
      let clear = false;
      for (const a of arches) {
        const nearest = THREE.MathUtils.clamp(a.c, s0, s1);
        const outer = { ...a, w: a.w + RING, h: a.h + RING };
        if (bottom < archProfile([a], nearest) + 0.02 || bottom < archProfile([outer], mid) - 0.12) clear = true;
      }
      if (clear) continue;
      pushBrick(mid, bottom + H / 2, groundAt(mid), len, H, 0, c === top - 1);
    }
  }

  // Voussoirs: wedge-ish bricks fanned around each arch.
  arches.forEach((a, i) => {
    const ra = a.w + RING / 2;
    const rb = a.h + RING / 2;
    const perimeter = Math.PI * (1.5 * (ra + rb) - Math.sqrt(ra * rb)) / 2;
    const n = Math.max(5, Math.round(perimeter / 0.27));
    for (let k = 0; k < n; k++) {
      const t = (Math.PI * (k + 0.5)) / n;
      const s = a.c + ra * Math.cos(t);
      const y = rb * Math.sin(t);
      // Radial direction on the ellipse, measured from the along-wall axis.
      const angle = Math.atan2(Math.sin(t) / rb, Math.cos(t) / ra);
      const slot = perimeter / n;
      pushBrick(s, y, archBase[i], RING + 0.04, slot, angle, false);
    }
  });

  if (!matrices.length) return null;
  const mesh = new THREE.InstancedMesh(brickGeometry, brickMaterial, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  colors.forEach((col, i) => mesh.setColorAt(i, col));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.userData.wallId = data.id;
  return mesh;
}

/**
 * Cut every wall where it passes within `radius` of (x, z). Returns the surviving
 * pieces, or null if nothing was touched.
 */
export function cutWalls(walls: WallData[], x: number, z: number, radius: number, nextId: () => number): WallData[] | null {
  let changed = false;
  const out: WallData[] = [];
  for (const w of walls) {
    const keep = w.pts.map(([px, pz]) => Math.hypot(px - x, pz - z) > radius);
    if (keep.every(Boolean)) {
      out.push(w);
      continue;
    }
    changed = true;
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length >= 2 && polylineLength(run) >= 0.8) {
        out.push({ id: nextId(), pts: run, courses: w.courses, seed: (w.seed * 31 + out.length * 7919) >>> 0 });
      }
      run = [];
    };
    w.pts.forEach((p, i) => {
      if (keep[i]) run.push(p);
      else flush();
    });
    flush();
  }
  return changed ? out : null;
}
