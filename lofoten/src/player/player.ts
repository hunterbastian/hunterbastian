// First-person walker: grounded movement with gravity, step-up, slope
// limits, collider push-out and shoreline boundaries.

import { WalkWorld } from './walkworld';

export interface MoveInput {
  /** -1..1, forward is +1 */
  forward: number;
  /** -1..1, right is +1 */
  strafe: number;
  run: boolean;
}

export const PLAYER = {
  radius: 0.35,
  height: 1.8,
  eye: 1.62,
  walkSpeed: 2.5,
  runSpeed: 4.4,
  accel: 10,
  maxStep: 0.45,
  gravity: 22,
};

export class Player {
  x: number;
  z: number;
  feetY: number;
  vy = 0;
  vx = 0;
  vz = 0;
  /** Heading: 0 looks north (-z); positive turns left (counter-clockwise). */
  yaw: number;
  pitch = 0;
  surface = 'terrain';
  grounded = true;
  /** Smoothed eye offset so step-ups don't snap the camera. */
  private eyeLag = 0;
  private bobPhase = 0;
  bob = 0;

  constructor(
    private world: WalkWorld,
    x: number,
    z: number,
    yaw: number,
  ) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    const g = world.ground(x, z, 1e3, 0);
    this.feetY = g ? g.y : 0;
    if (g) this.surface = g.surface;
  }

  teleport(x: number, z: number, yaw?: number) {
    this.x = x;
    this.z = z;
    if (yaw !== undefined) this.yaw = yaw;
    const g = this.world.ground(x, z, 1e3, 0);
    this.feetY = g ? g.y : this.feetY;
    this.vx = this.vz = this.vy = 0;
    this.eyeLag = 0;
    if (g) this.surface = g.surface;
  }

  get eyeY() {
    return this.feetY + PLAYER.eye - this.eyeLag + this.bob;
  }

  /** Try to occupy (nx, nz); returns true when the move is accepted. */
  private tryMove(nx: number, nz: number) {
    const p = { x: nx, z: nz };
    this.world.resolveColliders(p, PLAYER.radius, this.feetY + 0.05, PLAYER.height - 0.1);
    const g = this.world.ground(p.x, p.z, this.feetY, PLAYER.maxStep);
    if (!g) return false;
    if (g.surface === 'terrain' && this.world.tooSteep(p.x, p.z, this.feetY, g.y)) return false;
    // Keep the whole body on walkable ground (probe the rim toward travel direction).
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      const rx = p.x + (dx / d) * PLAYER.radius * 0.6;
      const rz = p.z + (dz / d) * PLAYER.radius * 0.6;
      if (!this.world.ground(rx, rz, Math.max(this.feetY, g.y), PLAYER.maxStep)) return false;
    }
    this.x = p.x;
    this.z = p.z;
    if (g.y > this.feetY) {
      // Step up: move feet instantly, let the eye catch up smoothly.
      this.eyeLag += g.y - this.feetY;
      this.feetY = g.y;
      this.vy = 0;
    }
    return true;
  }

  update(dt: number, input: MoveInput) {
    dt = Math.min(dt, 0.05);
    const speed = input.run ? PLAYER.runSpeed : PLAYER.walkSpeed;
    let f = input.forward;
    let s = input.strafe;
    const len = Math.hypot(f, s);
    if (len > 1) {
      f /= len;
      s /= len;
    }
    // Forward vector for yaw (0 = -z).
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const wishX = (fx * f + rx * s) * speed;
    const wishZ = (fz * f + rz * s) * speed;
    const k = 1 - Math.exp(-PLAYER.accel * dt);
    this.vx += (wishX - this.vx) * k;
    this.vz += (wishZ - this.vz) * k;

    // Sub-step so fast frames can't tunnel through thin railings.
    const moveX = this.vx * dt;
    const moveZ = this.vz * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(moveX, moveZ) / 0.1));
    for (let i = 0; i < steps; i++) {
      const sx = moveX / steps;
      const sz = moveZ / steps;
      if (Math.abs(sx) + Math.abs(sz) < 1e-7) break;
      if (this.tryMove(this.x + sx, this.z + sz)) continue;
      // Slide along whatever blocked us, axis by axis.
      const okX = Math.abs(sx) > 1e-7 && this.tryMove(this.x + sx, this.z);
      const okZ = Math.abs(sz) > 1e-7 && this.tryMove(this.x, this.z + sz);
      if (!okX) this.vx *= 0.5;
      if (!okZ) this.vz *= 0.5;
    }

    // Vertical: gravity toward the surface below.
    const g = this.world.ground(this.x, this.z, this.feetY, PLAYER.maxStep);
    const groundY = g ? g.y : this.feetY;
    if (g) this.surface = g.surface;
    if (this.feetY > groundY + 0.01) {
      this.vy -= PLAYER.gravity * dt;
      this.feetY += this.vy * dt;
      if (this.feetY <= groundY) {
        this.feetY = groundY;
        this.vy = 0;
      }
      // Snap down gentle slopes instead of "falling" down them.
      if (this.feetY - groundY < 0.25 && this.vy > -3) {
        this.feetY = groundY;
        this.vy = 0;
      }
      this.grounded = this.feetY <= groundY + 0.01;
    } else {
      this.feetY = groundY;
      this.vy = 0;
      this.grounded = true;
    }

    // Camera niceties.
    this.eyeLag *= Math.exp(-12 * dt);
    const horiz = Math.hypot(this.vx, this.vz);
    if (this.grounded && horiz > 0.3) {
      this.bobPhase += dt * horiz * 2.4;
      this.bob = Math.sin(this.bobPhase * 2) * 0.03 * Math.min(1, horiz / PLAYER.walkSpeed);
    } else {
      this.bob *= Math.exp(-8 * dt);
    }
  }
}
