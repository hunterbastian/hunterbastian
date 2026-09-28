import * as THREE from "three";
import type { Creature } from "./creature/creature";
import { groundAt } from "./world/terrain";

// A lazy, floaty third-person camera. It trails the creature, drifts back
// behind it while walking, and can be swung around by dragging.

const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw: number;
  pitch = 0.36;
  distance = 4.3;
  private targetDistance = 4.3;
  private focus = new THREE.Vector3();
  private smoothFocus = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(aspect: number, creature: Creature) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 700);
    // Start behind the creature.
    this.yaw = creature.heading + Math.PI;
    creature.focus(this.smoothFocus);
    this.update(1, creature, { x: 0, y: 0, zoom: 0 }, 1e9);
  }

  update(dt: number, creature: Creature, drag: { x: number; y: number; zoom: number }, msSinceDrag: number) {
    this.yaw -= drag.x * 0.006;
    this.pitch = THREE.MathUtils.clamp(this.pitch + drag.y * 0.004, -0.05, 1.1);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + drag.zoom * 0.6, 2.8, 11);
    this.distance = damp(this.distance, this.targetDistance, 8, dt);

    // After a moment without dragging, ease back behind the creature as it walks.
    if (msSinceDrag > 1200 && creature.speed > 0.4) {
      const behind = creature.heading + Math.PI;
      const diff = wrapAngle(behind - this.yaw);
      this.yaw += diff * (1 - Math.exp(-dt * 0.9 * Math.min(1, creature.speed / 2)));
    }

    creature.focus(this.focus);
    this.smoothFocus.x = damp(this.smoothFocus.x, this.focus.x, 6, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, this.focus.z, 6, dt);
    this.smoothFocus.y = damp(this.smoothFocus.y, this.focus.y, 3, dt);

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

  /** Forward/right on the ground plane, for camera-relative movement. */
  basis() {
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    return { forward: f, right: r };
  }
}
