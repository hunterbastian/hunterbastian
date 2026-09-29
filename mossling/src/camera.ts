import * as THREE from "three";
import type { Creature } from "./creature/creature";
import { groundAt } from "./world/terrain";
import type { Collider } from "./world/world";

// A lazy, floaty third-person camera. It trails the creature, drifts back
// behind it while it walks away from you, and can be swung around by dragging
// (or Q/E). It pulls in rather than letting a tree trunk block the view.

const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smoothstep = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// "Nothing in the way." Finite on purpose: damping Infinity toward Infinity is NaN.
const CLEAR = 100;

export type LookInput = {
  /** Drag deltas in stage pixels. */
  x: number;
  y: number;
  zoom: number;
  /** Keyboard camera turn, -1..1 (Q/E). */
  turn: number;
};

export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw: number;
  pitch = 0.36;
  distance = 4.3;
  /** How much of this frame's yaw change came from the player (drag, Q/E, recenter). */
  manualYawDelta = 0;
  private targetDistance = 4.3;
  private blockedDistance = CLEAR;
  private recentering = false;
  private focus = new THREE.Vector3();
  private smoothFocus = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(aspect: number, creature: Creature) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 700);
    // Start behind the creature.
    this.yaw = creature.heading + Math.PI;
    creature.focus(this.smoothFocus);
    this.update(1, creature, { x: 0, y: 0, zoom: 0, turn: 0 }, 1e9, []);
  }

  /** Swing smoothly back behind the creature. */
  recenter() {
    this.recentering = true;
  }

  update(dt: number, creature: Creature, look: LookInput, msSinceDrag: number, colliders: Collider[]) {
    const before = this.yaw;
    this.yaw -= look.x * 0.0065 + look.turn * 2.2 * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + look.y * 0.0045, -0.05, 1.1);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + look.zoom * 0.6, 2.8, 11);
    if (look.x || look.y || look.turn) this.recentering = false;

    const behind = creature.heading + Math.PI;
    if (this.recentering) {
      const diff = wrapAngle(behind - this.yaw);
      this.yaw += diff * (1 - Math.exp(-dt * 7));
      this.pitch = damp(this.pitch, 0.36, 5, dt);
      if (Math.abs(diff) < 0.02) this.recentering = false;
    }
    this.manualYawDelta = wrapAngle(this.yaw - before);

    // After a moment without dragging, ease back behind the creature — but only
    // while it's heading away from us. Walking toward the camera never spins it.
    if (!this.recentering && msSinceDrag > 1200 && creature.speed > 0.4) {
      const away = -Math.cos(this.yaw - creature.heading); // 1 = walking straight away
      const gain = smoothstep(-0.1, 0.7, away) * Math.min(1, creature.speed / 2);
      this.yaw += wrapAngle(behind - this.yaw) * (1 - Math.exp(-dt * 1.1 * gain));
    }

    creature.focus(this.focus);
    this.smoothFocus.x = damp(this.smoothFocus.x, this.focus.x, 7, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, this.focus.z, 7, dt);
    this.smoothFocus.y = damp(this.smoothFocus.y, this.focus.y, 3, dt);

    // Pull in when a trunk or stone sits between the camera and the creature.
    const blocked = this.obstruction(colliders);
    this.blockedDistance = blocked < this.blockedDistance ? blocked : damp(this.blockedDistance, blocked, 2.5, dt);
    this.distance = damp(this.distance, Math.min(this.targetDistance, this.blockedDistance), 8, dt);

    const d = this.distance;
    this.desired.set(
      this.smoothFocus.x + Math.sin(this.yaw) * Math.cos(this.pitch) * d,
      this.smoothFocus.y + Math.sin(this.pitch) * d + 0.4,
      this.smoothFocus.z + Math.cos(this.yaw) * Math.cos(this.pitch) * d,
    );
    // Never dip under the hills.
    const floor = groundAt(this.desired.x, this.desired.z) + 0.6;
    if (this.desired.y < floor) this.desired.y = floor;

    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.smoothFocus.x, this.smoothFocus.y + 0.2, this.smoothFocus.z);
  }

  /** Farthest camera distance (along the current yaw) that clears every collider. */
  private obstruction(colliders: Collider[]): number {
    // Work on the ground plane, then convert back to distance along the tilted ray.
    const dx = Math.sin(this.yaw);
    const dz = Math.cos(this.yaw);
    const flat = Math.max(0.3, Math.cos(this.pitch));
    const reach = this.targetDistance * flat;
    let best = CLEAR;
    for (const c of colliders) {
      const ox = c.x - this.smoothFocus.x;
      const oz = c.z - this.smoothFocus.z;
      const along = ox * dx + oz * dz;
      if (along <= 0.6 || along > reach + c.r) continue;
      const side = Math.abs(ox * dz - oz * dx);
      const r = c.r + 0.25;
      if (side < r) best = Math.min(best, Math.max(1.6, (along - Math.sqrt(r * r - side * side) - 0.3) / flat));
    }
    return best;
  }

  /** Forward/right on the ground plane for a given yaw (camera-relative movement). */
  static basis(yaw: number) {
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    return { forward: f, right: r };
  }
}
