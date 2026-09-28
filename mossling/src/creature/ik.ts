import * as THREE from "three";

const dir = new THREE.Vector3();
const bend = new THREE.Vector3();

/**
 * Analytic two-bone IK. Given a hip, a foot target and a pole direction
 * (which way the joint should point), writes the joint position into `knee`
 * and returns the (possibly clamped) foot position in `foot`.
 */
export function solveTwoBone(
  hip: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  knee: THREE.Vector3,
  foot: THREE.Vector3,
): void {
  dir.subVectors(target, hip);
  const reach = l1 + l2 - 1e-3;
  const d = Math.min(Math.max(dir.length(), Math.abs(l1 - l2) + 1e-3), reach);
  dir.normalize();
  foot.copy(hip).addScaledVector(dir, d);

  // Pole projected onto the plane perpendicular to the limb.
  bend.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1);
  bend.normalize();

  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  knee.copy(hip).addScaledVector(dir, a).addScaledVector(bend, h);
}

const zAxis = new THREE.Vector3();
const xAxis = new THREE.Vector3();
const yAxis = new THREE.Vector3();
const basis = new THREE.Matrix4();

/**
 * Orient a +Z-aligned segment mesh so it spans `from` → `to`, keeping its
 * roll stable by aligning local X with `side` (avoids lookAt flips when a
 * leg points straight down).
 */
export function placeSegment(mesh: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, side: THREE.Vector3): void {
  zAxis.subVectors(to, from);
  const len = zAxis.length();
  zAxis.divideScalar(len || 1);
  xAxis.copy(side).addScaledVector(zAxis, -side.dot(zAxis)).normalize();
  yAxis.crossVectors(zAxis, xAxis);
  basis.makeBasis(xAxis, yAxis, zAxis);
  mesh.position.copy(from);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.scale.set(1, 1, len);
}
