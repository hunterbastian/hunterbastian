// Small math helpers shared by every module. Angles are radians.

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a0, a1, b0, b1) => lerp(b0, b1, clamp(invLerp(a0, a1, v), 0, 1));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential smoothing toward a target.
 * `lambda` is roughly "how many times per second we close the gap".
 */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference b - a between two angles. */
export const angleDiff = (a, b) => wrapAngle(b - a);

/** Damp an angle toward a target along the shortest arc. */
export const dampAngle = (current, target, lambda, dt) =>
  current + angleDiff(current, target) * (1 - Math.exp(-lambda * dt));

/** Rotate `current` toward `target` by at most `maxStep` radians. */
export function stepAngle(current, target, maxStep) {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

/**
 * Heading convention used everywhere: yaw 0 faces +Z, positive yaw turns
 * toward +X. forward = (sin(yaw), 0, cos(yaw)); object.rotation.y = yaw.
 */
export const yawFromDir = (dx, dz) => Math.atan2(dx, dz);

export const dist2 = (ax, az, bx, bz) => {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
};
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));
