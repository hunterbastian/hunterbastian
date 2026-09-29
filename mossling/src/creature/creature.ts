import * as THREE from "three";
import { COLORS } from "../palette";
import { lambert } from "../ps1";
import { Batch, xf } from "../world/batch";
import { mulberry32 } from "../world/noise";
import { groundAt, groundNormal, PLAY_RADIUS, WATER_LEVEL } from "../world/terrain";
import type { Collider } from "../world/world";
import { placeSegment, solveTwoBone } from "./ik";

// The mossling: a round little baby dinosaur with a mossy saddle, a row of
// leafy back plates, a frill, and a sprout on its head. Nothing here is keyframed — the body is
// pushed around by input and the legs figure out where to step on their own.

export type MoveInput = {
  /** Desired move direction in world XZ (length 0..1). */
  x: number;
  z: number;
  run: boolean;
};

type Leg = {
  hip: THREE.Object3D;
  rest: THREE.Vector3; // resting foot spot, in root space
  front: boolean;
  side: 1 | -1;
  group: 0 | 1; // trot pairs: diagonal legs move together
  foot: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  stepping: boolean;
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  paw: THREE.Mesh;
};

const WALK_SPEED = 2.1;
const RUN_SPEED = 4.4;
const HIP_HEIGHT = 0.6;
const L1 = 0.3;
const L2 = 0.29;
const PAW_LIFT = 0.055;
const RADIUS = 0.55;

const up = new THREE.Vector3(0, 1, 0);
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const hipW = new THREE.Vector3();
const knee = new THREE.Vector3();
const footOut = new THREE.Vector3();
const pole = new THREE.Vector3();
const side = new THREE.Vector3();
const fwd = new THREE.Vector3();
const qYaw = new THREE.Quaternion();
const qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));

export class Creature {
  readonly root = new THREE.Group();
  readonly position = new THREE.Vector3();
  heading = Math.PI; // facing -z, into the glen
  speed = 0;
  /** 0..1 — how "into it" the current gait is (walk → run). */
  gait = 0;

  private body = new THREE.Group();
  private torso!: THREE.Mesh;
  private head = new THREE.Group();
  private ears: THREE.Object3D[] = [];
  private eyes: THREE.Object3D[] = [];
  private sprout = new THREE.Group();
  private tail: THREE.Object3D[] = [];
  private legs: Leg[] = [];
  private shadow: THREE.Mesh;

  private turnRate = 0;
  private idleTime = 0;
  private sit = 0;
  private bodyY = 0;
  private pitch = 0;
  private roll = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTarget = new THREE.Vector2();
  private nextLook = 0;
  private nextBlink = 2;
  private blinkT = 0;
  private earFlick = [0, 0];
  private nextFlick = 1.5;
  private rand = mulberry32(2024);
  private lastSpeed = 0;
  private accel = 0;

  constructor(scene: THREE.Scene, x: number, z: number, blobTex: THREE.Texture) {
    this.position.set(x, groundAt(x, z), z);
    this.root.add(this.body);
    scene.add(this.root);
    this.buildBody();
    this.buildLegs(scene);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.9),
      new THREE.MeshBasicMaterial({ map: blobTex, color: 0x1c1a20, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.shadow.renderOrder = 1;
    scene.add(this.shadow);

    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.root.updateMatrixWorld(true);
    for (const leg of this.legs) {
      this.restWorld(leg, leg.foot);
      leg.from.copy(leg.foot);
      leg.to.copy(leg.foot);
    }
    this.bodyY = this.position.y + HIP_HEIGHT;
  }

  // ---------------------------------------------------------------- build --

  private buildBody() {
    const furMat = lambert({ vertexColors: true });
    const fur = new THREE.Color(COLORS.creatureFur);
    const belly = new THREE.Color(COLORS.creatureBelly);
    const dorsal = new THREE.Color(0xc49e6c);
    const bellyTint = (n: THREE.Vector3, _c: THREE.Vector3, _b: THREE.Color, out: THREE.Color) => {
      if (n.y < -0.35) out.copy(belly);
      else if (n.y > 0.6) out.lerp(dorsal, 0.6);
      else out.multiplyScalar(0.9 + n.y * 0.15);
    };

    // Torso: a chunky bean.
    const torso = new Batch();
    torso.add(new THREE.IcosahedronGeometry(1, 1), xf(0, 0, 0, 0, 0, 0, 0.4, 0.34, 0.6), { color: fur, tint: bellyTint, vary: 0.1, lumpy: 0.05 });
    // Haunches and chest fluff hide the hip joints and round everything out.
    for (const s of [-1, 1]) torso.add(new THREE.IcosahedronGeometry(1, 0), xf(s * 0.22, -0.06, -0.32, 0, 0, 0, 0.17, 0.2, 0.22), { color: fur, tint: bellyTint });
    torso.add(new THREE.IcosahedronGeometry(1, 0), xf(0, -0.04, 0.46, 0.3, 0, 0, 0.26, 0.24, 0.18), { color: belly, vary: 0.08 });
    this.torso = torso.build(furMat);
    this.body.add(this.torso);

    // Mossy saddle with a tiny mushroom and a clover sprig growing on it.
    const moss = new Batch();
    moss.add(new THREE.IcosahedronGeometry(1, 1), xf(0, 0.25, -0.06, 0, 0, 0, 0.3, 0.12, 0.42), { color: COLORS.creatureMoss, vary: 0.3, lumpy: 0.12 });
    moss.add(new THREE.IcosahedronGeometry(1, 0), xf(0.08, 0.33, -0.2, 0, 0, 0, 0.12, 0.07, 0.12), { color: 0xa3a852, vary: 0.2 });
    const stem = new THREE.CylinderGeometry(0.5, 0.6, 1, 5, 1);
    stem.translate(0, 0.5, 0);
    moss.add(stem, xf(-0.08, 0.3, -0.12, 0.1, 0, 0.2, 0.05, 0.14, 0.05), { color: 0xf2e6c4 });
    moss.add(new THREE.SphereGeometry(1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2), xf(-0.11, 0.43, -0.11, 0.1, 0, 0.25, 0.11, 0.08, 0.11), { color: 0xb95c3c });
    moss.add(new THREE.IcosahedronGeometry(1, 0), xf(-0.1, 0.515, -0.11, 0, 0, 0, 0.025, 0.02, 0.025), { color: 0xfff8e2, vary: 0 });
    // Leafy back plates poking up through the moss, stegosaur style.
    const plateGeo = new THREE.ConeGeometry(1, 1, 4, 1);
    plateGeo.translate(0, 0.5, 0);
    const plates = 7;
    for (let i = 0; i < plates; i++) {
      const k = i / (plates - 1);
      const pz = 0.34 - k * 0.8;
      const h = 0.1 + Math.sin(k * Math.PI) * 0.12;
      const py = 0.3 + Math.sin(k * Math.PI) * 0.06 - (k > 0.8 ? (k - 0.8) * 0.5 : 0);
      moss.add(plateGeo, xf((i % 2 ? 1 : -1) * 0.03, py, pz, 0, 0, (i % 2 ? 1 : -1) * 0.12, 0.018, h, 0.09), { color: i % 2 ? 0xa3a852 : 0xc4c173, vary: 0.1 });
    }
    this.body.add(moss.build(lambert({ vertexColors: true })));

    // Head.
    this.head.position.set(0, 0.2, 0.56);
    this.body.add(this.head);
    const head = new Batch();
    head.add(new THREE.IcosahedronGeometry(1, 1), xf(0, 0.06, 0.02, 0, 0, 0, 0.29, 0.26, 0.27), { color: fur, tint: bellyTint, lumpy: 0.04 });
    head.add(new THREE.IcosahedronGeometry(1, 1), xf(0, -0.04, 0.24, 0, 0, 0, 0.15, 0.12, 0.14), { color: belly });
    // A little beak, a nose horn and two brow nubs: a baby ceratopsian.
    const cone = new THREE.ConeGeometry(1, 1, 5, 1);
    head.add(cone, xf(0, -0.06, 0.39, Math.PI / 2 + 0.25, 0, 0, 0.07, 0.09, 0.05), { color: 0x5a4031, vary: 0 });
    head.add(cone, xf(0, 0.08, 0.32, -0.35, 0, 0, 0.035, 0.1, 0.035), { color: 0xf2e6c4, vary: 0 });
    for (const s of [-1, 1]) head.add(cone, xf(s * 0.1, 0.24, 0.1, -0.5, 0, -s * 0.3, 0.025, 0.07, 0.025), { color: 0xf2e6c4, vary: 0 });
    for (const s of [-1, 1]) head.add(new THREE.IcosahedronGeometry(1, 0), xf(s * 0.18, -0.04, 0.17, 0, 0, 0, 0.06, 0.04, 0.03), { color: 0xe6a9a0, vary: 0 });
    this.head.add(head.build(lambert({ vertexColors: true })));

    // Eyes are their own meshes so they can blink.
    const eyeGeo = new THREE.BoxGeometry(0.055, 0.075, 0.03);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1c1a20 });
    const shineGeo = new THREE.BoxGeometry(0.02, 0.02, 0.01);
    const shineMat = new THREE.MeshBasicMaterial({ color: 0xfff8e2 });
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(s * 0.13, 0.08, 0.255);
      eye.rotation.y = s * 0.45;
      const shine = new THREE.Mesh(shineGeo, shineMat);
      shine.position.set(s * 0.01, 0.02, 0.016);
      eye.add(shine);
      this.head.add(eye);
      this.eyes.push(eye);
    }

    // Frill: a warm fan behind the head, with two lobes on pivots that flick
    // like ears.
    const frill = new Batch();
    frill.add(new THREE.CircleGeometry(1, 7, 0, Math.PI), xf(0, 0.12, -0.1, -0.35, 0, 0, 0.26, 0.24, 1), { color: 0xdf8f55, vary: 0.12 });
    frill.add(new THREE.CircleGeometry(1, 7, 0, Math.PI), xf(0, 0.13, -0.095, -0.35, 0, 0, 0.17, 0.15, 1), { color: 0xf2e6c4, vary: 0.05 });
    const frillMesh = frill.build(lambert({ vertexColors: true, side: THREE.DoubleSide }));
    this.head.add(frillMesh);
    const earBatch = new Batch();
    const earGeo = new THREE.ConeGeometry(1, 1, 5, 1);
    earGeo.translate(0, 0.5, 0);
    earBatch.add(earGeo, xf(0, 0, 0, 0, 0, 0, 0.1, 0.24, 0.04), { color: 0xdf8f55 });
    earBatch.add(earGeo, xf(0, 0.02, 0.02, 0, 0, 0, 0.06, 0.17, 0.02), { color: 0xf2e6c4, vary: 0 });
    const earMesh = earBatch.build(lambert({ vertexColors: true }));
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.17, 0.22, 0);
      pivot.rotation.set(-0.2, 0, -s * 0.75);
      const ear = new THREE.Mesh(earMesh.geometry, earMesh.material);
      pivot.add(ear);
      this.head.add(pivot);
      this.ears.push(pivot);
    }

    // A two-leaf sprout on the crown.
    this.sprout.position.set(0, 0.3, -0.02);
    const sproutBatch = new Batch();
    sproutBatch.add(stem, xf(0, 0, 0, 0, 0, 0, 0.02, 0.12, 0.02), { color: 0x62743a, vary: 0 });
    for (const s of [-1, 1])
      sproutBatch.add(new THREE.IcosahedronGeometry(1, 0), xf(s * 0.07, 0.13, 0, 0, 0, s * 0.5, 0.08, 0.025, 0.05), { color: 0x8f9c42, vary: 0.2 });
    this.sprout.add(sproutBatch.build(lambert({ vertexColors: true })));
    this.head.add(this.sprout);

    // Tail: a long taper that ends in a tiny spiky club.
    let parent: THREE.Object3D = this.body;
    const tailGeo = new THREE.IcosahedronGeometry(1, 0);
    const tailMat = lambert({ color: COLORS.creatureFur });
    const spikeMat = lambert({ color: 0xf2e6c4 });
    const spikeGeo = new THREE.ConeGeometry(0.03, 0.14, 4, 1);
    spikeGeo.translate(0, 0.07, 0);
    for (let i = 0; i < 7; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? 0.08 : 0, i === 0 ? -0.55 : -0.11);
      const r = 0.11 - i * 0.012;
      const puff = new THREE.Mesh(tailGeo, tailMat);
      puff.scale.set(r, r * 0.9, r * 1.5);
      puff.position.z = -0.05;
      if (i === 6)
        for (const [sx, sz] of [[1, 0], [-1, 0], [1, -0.08], [-1, -0.08]] as const) {
          const spike = new THREE.Mesh(spikeGeo, spikeMat);
          spike.position.set(sx * 0.03, 0.02, sz - 0.04);
          spike.rotation.set(-0.9, 0, -sx * 1.0);
          seg.add(spike);
        }
      seg.add(puff);
      parent.add(seg);
      this.tail.push(seg);
      parent = seg;
    }
  }

  private buildLegs(scene: THREE.Scene) {
    const segGeo = (r0: number, r1: number) => {
      const g = new THREE.CylinderGeometry(r1, r0, 1, 6, 1);
      g.translate(0, 0.5, 0);
      g.rotateX(Math.PI / 2);
      return g;
    };
    const furMat = lambert({ color: COLORS.creatureFur });
    const lowMat = lambert({ color: 0x9e7b52 }); // fawn socks
    const pawMat = lambert({ color: COLORS.creaturePaw });
    const upperGeo = segGeo(0.1, 0.075);
    const lowerGeo = segGeo(0.075, 0.06);
    const pawGeo = new THREE.IcosahedronGeometry(1, 0);
    pawGeo.scale(0.085, 0.06, 0.11);

    const defs: [boolean, 1 | -1, 0 | 1][] = [
      [true, 1, 0],
      [true, -1, 1],
      [false, 1, 1],
      [false, -1, 0],
    ];
    for (const [front, s, group] of defs) {
      const hip = new THREE.Object3D();
      hip.position.set(s * 0.2, -0.12, front ? 0.34 : -0.34);
      this.body.add(hip);
      const leg: Leg = {
        hip,
        rest: new THREE.Vector3(s * 0.24, 0, front ? 0.36 : -0.33),
        front,
        side: s,
        group,
        foot: new THREE.Vector3(),
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 1,
        stepping: false,
        upper: new THREE.Mesh(upperGeo, furMat),
        lower: new THREE.Mesh(lowerGeo, lowMat),
        paw: new THREE.Mesh(pawGeo, pawMat),
      };
      scene.add(leg.upper, leg.lower, leg.paw);
      this.legs.push(leg);
    }
  }

  // --------------------------------------------------------------- update --

  private restWorld(leg: Leg, out: THREE.Vector3) {
    out.copy(leg.rest);
    // Sitting tucks the hind paws forward under the haunches.
    if (!leg.front) out.z += this.sit * 0.14;
    out.applyAxisAngle(up, this.heading).add(this.position);
    out.y = groundAt(out.x, out.z);
    return out;
  }

  private walkable(x: number, z: number) {
    return groundAt(x, z) > WATER_LEVEL - 0.42 && Math.hypot(x, z) < PLAY_RADIUS + 3;
  }

  update(dt: number, t: number, input: MoveInput, colliders: Collider[]) {
    // ---- locomotion ----
    const inputLen = Math.min(1, Math.hypot(input.x, input.z));
    let targetSpeed = 0;
    let turnTarget = 0;
    if (inputLen > 0.05) {
      const desired = Math.atan2(input.x, input.z);
      const diff = wrapAngle(desired - this.heading);
      turnTarget = THREE.MathUtils.clamp(diff * 8, -7, 7);
      targetSpeed = (input.run ? RUN_SPEED : WALK_SPEED) * inputLen;
      // Big turn? Slow down and swing around in a little arc.
      targetSpeed *= THREE.MathUtils.lerp(1, 0.4, Math.min(1, Math.abs(diff) / 2));
    }
    this.turnRate = damp(this.turnRate, turnTarget, 16, dt);
    this.heading = wrapAngle(this.heading + this.turnRate * dt);
    this.speed = damp(this.speed, targetSpeed, targetSpeed > this.speed ? 6 : 8, dt);
    this.accel = damp(this.accel, (this.speed - this.lastSpeed) / Math.max(dt, 1e-4), 6, dt);
    this.lastSpeed = this.speed;
    this.gait = damp(this.gait, Math.min(1, this.speed / RUN_SPEED), 5, dt);

    fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const nx = this.position.x + fwd.x * this.speed * dt;
    const nz = this.position.z + fwd.z * this.speed * dt;
    // Slide along the pond edge / world bound rather than stopping dead.
    if (this.walkable(nx, nz)) this.position.set(nx, 0, nz);
    else if (this.walkable(nx, this.position.z)) this.position.x = nx;
    else if (this.walkable(this.position.x, nz)) this.position.z = nz;
    else this.speed *= 0.5;
    for (const c of colliders) {
      const dx = this.position.x - c.x;
      const dz = this.position.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + RADIUS;
      if (d < min && d > 1e-4) {
        this.position.x = c.x + (dx / d) * min;
        this.position.z = c.z + (dz / d) * min;
      }
    }
    this.position.y = groundAt(this.position.x, this.position.z);

    // ---- idle life ----
    const moving = this.speed > 0.15;
    this.idleTime = moving || inputLen > 0.05 ? 0 : this.idleTime + dt;
    this.sit = damp(this.sit, this.idleTime > 6 ? 1 : 0, this.idleTime > 6 ? 1.6 : 7, dt);

    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.root.updateMatrixWorld(true);

    // ---- legs: decide who steps ----
    const stepDur = THREE.MathUtils.lerp(0.3, 0.17, this.gait);
    const lead = stepDur * 0.9;
    const turning = Math.abs(this.turnRate) > 0.4;
    const threshold = moving ? THREE.MathUtils.lerp(0.16, 0.34, this.gait) : turning ? 0.1 : 0.05;
    const groupBusy = [false, false];
    for (const leg of this.legs) if (leg.stepping) groupBusy[leg.group] = true;

    for (const leg of this.legs) {
      if (leg.stepping) continue;
      this.restWorld(leg, v1);
      v1.addScaledVector(fwd, this.speed * lead * 0.5);
      const err = v1.distanceTo(leg.foot);
      const otherBusy = groupBusy[1 - leg.group];
      const settle = !moving && (turning || this.idleTime > 0.15);
      if (err > threshold && (moving || settle) && !otherBusy) {
        this.startStep(leg, fwd, lead);
        groupBusy[leg.group] = true;
        // Bring the diagonal partner along for a proper trot.
        for (const p of this.legs) {
          if (p !== leg && p.group === leg.group && !p.stepping) {
            this.restWorld(p, v2);
            if (v2.distanceTo(p.foot) > threshold * 0.3) this.startStep(p, fwd, lead);
          }
        }
      }
    }

    let lift = 0;
    for (const leg of this.legs) {
      if (!leg.stepping) continue;
      leg.t = Math.min(1, leg.t + dt / stepDur);
      const e = leg.t < 0.5 ? 2 * leg.t * leg.t : 1 - (-2 * leg.t + 2) ** 2 / 2;
      leg.foot.lerpVectors(leg.from, leg.to, e);
      const arc = Math.sin(Math.PI * leg.t);
      leg.foot.y += arc * THREE.MathUtils.lerp(0.13, 0.2, this.gait) * (moving ? 1 : 0.6);
      lift += arc;
      if (leg.t >= 1) leg.stepping = false;
    }

    // ---- body follows the feet ----
    let frontY = 0, backY = 0, leftY = 0, rightY = 0;
    for (const leg of this.legs) {
      const planted = leg.stepping ? THREE.MathUtils.lerp(leg.from.y, leg.to.y, leg.t) : leg.foot.y;
      if (leg.front) frontY += planted / 2;
      else backY += planted / 2;
      if (leg.side > 0) leftY += planted / 2;
      else rightY += planted / 2;
    }
    const groundY = Math.max((frontY + backY) / 2, this.position.y - 0.15);
    const bob = lift * 0.025 * (0.6 + this.gait) - this.gait * 0.05;
    this.bodyY = damp(this.bodyY, groundY + HIP_HEIGHT + bob - this.sit * 0.12, 18, dt);

    const breathe = Math.sin(t * 2.2) * (1 - this.gait);
    const targetPitch = Math.atan2(backY - frontY, 0.7) - this.accel * 0.015 - this.sit * 0.55 + lift * 0.02 * Math.sin(t * 12) * this.gait;
    const targetRoll = Math.atan2(leftY - rightY, 0.5) * 0.6 - this.turnRate * this.speed * 0.025;
    this.pitch = damp(this.pitch, targetPitch, 10, dt);
    this.roll = damp(this.roll, targetRoll, 8, dt);

    this.body.position.y = this.bodyY - this.position.y;
    this.body.rotation.set(this.pitch, 0, this.roll);
    this.torso.scale.set(1 + breathe * 0.015, 1 + breathe * 0.025, 1);
    this.root.updateMatrixWorld(true);

    // ---- solve and draw legs ----
    side.set(1, 0, 0).applyAxisAngle(up, this.heading);
    for (const leg of this.legs) {
      leg.hip.getWorldPosition(hipW);
      v1.copy(leg.foot);
      v1.y += PAW_LIFT;
      // Front "wrists" point forward, hind hocks point back.
      pole.copy(fwd).multiplyScalar(leg.front ? 1 : -1).addScaledVector(up, -0.2);
      solveTwoBone(hipW, v1, pole, L1, L2, knee, footOut);
      placeSegment(leg.upper, hipW, knee, side);
      placeSegment(leg.lower, knee, footOut, side);
      leg.paw.position.copy(footOut);
      leg.paw.position.y -= PAW_LIFT * 0.4;
      const toe = leg.stepping ? Math.sin(Math.PI * leg.t) * (leg.t < 0.5 ? 0.6 : -0.3) : 0;
      leg.paw.rotation.set(toe, this.heading, 0, "YXZ");
    }

    // ---- head, ears, tail ----
    if (!moving && this.idleTime > 1.5 && t > this.nextLook) {
      this.nextLook = t + 1.8 + this.rand() * 2.5;
      const sniff = this.rand() < 0.25;
      this.lookTarget.set((this.rand() - 0.5) * 1.6, sniff ? 0.55 : (this.rand() - 0.6) * 0.5);
    }
    if (moving) this.lookTarget.set(THREE.MathUtils.clamp(this.turnRate * 0.12, -0.6, 0.6), -0.05 + this.gait * 0.1);
    else if (this.idleTime <= 1.5) this.lookTarget.set(0, 0);
    this.lookYaw = damp(this.lookYaw, this.lookTarget.x, 4, dt);
    this.lookPitch = damp(this.lookPitch, this.lookTarget.y, 4, dt);
    const headBob = Math.sin(t * THREE.MathUtils.lerp(9, 15, this.gait)) * 0.035 * Math.min(1, this.speed);
    this.head.rotation.set(this.lookPitch - this.pitch * 0.7 + headBob, this.lookYaw, -this.roll * 0.5 + Math.sin(t * 0.7) * 0.04 * (1 - this.gait), "YXZ");
    this.head.position.y = 0.2 + breathe * 0.01 + this.sit * 0.03;

    if (t > this.nextBlink) {
      this.blinkT = 0.13;
      this.nextBlink = t + 2 + this.rand() * 3.5;
    }
    this.blinkT = Math.max(0, this.blinkT - dt);
    for (const eye of this.eyes) eye.scale.y = this.blinkT > 0 ? 0.15 : 1;

    if (t > this.nextFlick) {
      this.earFlick[this.rand() < 0.5 ? 0 : 1] = 1;
      this.nextFlick = t + 1.5 + this.rand() * 4;
    }
    this.ears.forEach((ear, i) => {
      const s = i === 0 ? -1 : 1;
      this.earFlick[i] = Math.max(0, this.earFlick[i] - dt * 5);
      const flick = Math.sin(this.earFlick[i] * Math.PI * 3) * 0.35 * this.earFlick[i];
      // Ears stream back when running.
      ear.rotation.set(-0.2 - this.gait * 0.7 + headBob * 2, 0, -s * (0.75 + this.gait * 0.2) + flick * s);
    });
    this.sprout.rotation.set(Math.sin(t * 3.1) * 0.12 - this.gait * 0.5 + headBob * 3, 0, Math.sin(t * 2.3) * 0.15 - this.turnRate * 0.05);

    const wag = moving ? THREE.MathUtils.lerp(0.25, 0.12, this.gait) : 0.35 * (1 - this.sit * 0.7);
    const wagSpeed = moving ? THREE.MathUtils.lerp(8, 14, this.gait) : 5;
    this.tail.forEach((seg, i) => {
      const k = i / this.tail.length;
      // Positive X lifts the tail: a perky upward curl that relaxes when running or sitting.
      const curl = i === 0 ? 0.22 - this.gait * 0.2 - this.sit * 0.55 : 0.03 - this.gait * 0.04 - this.sit * 0.04;
      seg.rotation.set(curl, Math.sin(t * wagSpeed - i * 0.7) * wag * (0.4 + k) - this.turnRate * 0.08, 0);
    });

    // ---- blob shadow ----
    const n = groundNormal(this.position.x, this.position.z, v2);
    this.shadow.position.set(this.position.x, this.position.y + 0.04, this.position.z);
    // Lay the blob flat, turn it with the body, then tilt it onto the slope.
    this.shadow.quaternion
      .setFromUnitVectors(up, n)
      .multiply(qYaw.setFromAxisAngle(up, this.heading))
      .multiply(qFlat);
    const shadowScale = 1 - (this.bodyY - this.position.y - HIP_HEIGHT) * 0.5;
    this.shadow.scale.setScalar(THREE.MathUtils.clamp(shadowScale, 0.7, 1.1));
  }

  private startStep(leg: Leg, forward: THREE.Vector3, lead: number) {
    leg.stepping = true;
    leg.t = 0;
    leg.from.copy(leg.foot);
    this.restWorld(leg, leg.to);
    leg.to.addScaledVector(forward, this.speed * lead);
    leg.to.y = groundAt(leg.to.x, leg.to.z);
  }

  /** A point just above the creature's back, for the camera to look at. */
  focus(out: THREE.Vector3) {
    return out.set(this.position.x, this.bodyY + 0.35, this.position.z);
  }
}
