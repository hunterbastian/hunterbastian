// Walks the player along a list of waypoints using the same input path as
// the keyboard. Used by the route tests and the in-browser ?autowalk mode.

import { MoveInput, Player } from './player';

export interface Waypoint {
  x: number;
  z: number;
}

export class Autopilot {
  index = 0;
  done = false;
  stuckTime = 0;
  private lastDist = Infinity;

  constructor(
    private waypoints: Waypoint[],
    private arriveRadius = 0.9,
  ) {}

  get target() {
    return this.waypoints[Math.min(this.index, this.waypoints.length - 1)];
  }

  /** Steers the player's yaw and returns the movement input for this frame. */
  step(player: Player, dt: number): MoveInput {
    if (this.done) return { forward: 0, strafe: 0, run: false };
    const t = this.target;
    const dx = t.x - player.x;
    const dz = t.z - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist < this.arriveRadius) {
      this.index++;
      this.lastDist = Infinity;
      this.stuckTime = 0;
      if (this.index >= this.waypoints.length) this.done = true;
      return { forward: 0, strafe: 0, run: false };
    }
    // Progress watchdog.
    if (dist > this.lastDist - 0.002) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    this.lastDist = Math.min(this.lastDist, dist);

    const desired = Math.atan2(-dx, -dz);
    let diff = desired - player.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.yaw += diff * Math.min(1, dt * 6);
    player.pitch += (-0.05 - player.pitch) * Math.min(1, dt * 2);
    const facing = Math.cos(diff);
    return { forward: facing > 0.3 ? 1 : 0.2, strafe: 0, run: false };
  }
}
