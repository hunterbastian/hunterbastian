import * as THREE from "three";
import { lambert } from "../ps1";
import { mulberry32 } from "./noise";
import { groundAt, PLAY_RADIUS, POND } from "./terrain";

/** The long-necks walk a ring just beyond where the mossling can go. */
export const HERD_RADIUS = PLAY_RADIUS + 7;

// The valley's neighbours. Nothing here interacts with you; they just go
// about their day: long-necks grazing along the rim, pterosaurs riding the
// warm air, and dragonflies the size of your head buzzing over the pond.

type Update = (t: number, dt: number) => void;

/** A chain segment whose geometry runs along local +Z from 0 to 1. */
function segGeo(r0: number, r1: number, sides = 6) {
  const g = new THREE.CylinderGeometry(r1, r0, 1, sides, 1);
  g.translate(0, 0.5, 0);
  g.rotateX(Math.PI / 2);
  return g;
}

// ---- sauropods -------------------------------------------------------------

function sauropod(scene: THREE.Scene, scale: number, skin: number, belly: number) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.scale.setScalar(scale);
  scene.add(root);

  const skinMat = lambert({ color: skin });
  const bellyMat = lambert({ color: belly });

  const torso = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), skinMat);
  torso.scale.set(1.9, 1.7, 3.3);
  torso.position.y = 5.4;
  body.add(torso);
  const under = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), bellyMat);
  under.scale.set(1.6, 1.1, 2.8);
  under.position.y = 4.8;
  body.add(under);

  // Column legs on hip pivots.
  const legGeo = new THREE.CylinderGeometry(0.5, 0.62, 1, 6, 1);
  legGeo.translate(0, -0.5, 0);
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[1.2, 1.9], [-1.2, 1.9], [1.2, -1.9], [-1.2, -1.9]] as const) {
    const hip = new THREE.Group();
    hip.position.set(x, 5, z);
    const leg = new THREE.Mesh(legGeo, skinMat);
    leg.scale.set(1, 5, 1);
    hip.add(leg);
    body.add(hip);
    legs.push(hip);
  }

  // Neck: a long chain rising from the shoulders, ending in a small head.
  const neck: THREE.Group[] = [];
  let parent: THREE.Object3D = body;
  for (let i = 0; i < 7; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? 6.1 : 0, i === 0 ? 2.6 : 1.35);
    const r0 = 0.85 - i * 0.08;
    const mesh = new THREE.Mesh(segGeo(r0, r0 - 0.08), skinMat);
    mesh.scale.set(1, 1, 1.5);
    seg.add(mesh);
    parent.add(seg);
    neck.push(seg);
    parent = seg;
  }
  const head = new THREE.Group();
  head.position.z = 1.35;
  const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), skinMat);
  skull.scale.set(0.42, 0.36, 0.7);
  skull.position.z = 0.35;
  head.add(skull);
  parent.add(head);

  // Tail: a long taper sweeping back and low.
  const tail: THREE.Group[] = [];
  parent = body;
  for (let i = 0; i < 9; i++) {
    const seg = new THREE.Group();
    if (i === 0) {
      seg.position.set(0, 5.6, -2.9);
      seg.rotation.y = Math.PI;
    } else seg.position.z = 1.2;
    const r0 = 0.9 - i * 0.09;
    seg.add(new THREE.Mesh(segGeo(Math.max(r0, 0.1), Math.max(r0 - 0.09, 0.06)), skinMat));
    seg.children[0].scale.set(1, 1, 1.3);
    parent.add(seg);
    tail.push(seg);
    parent = seg;
  }

  return { root, body, legs, neck, head, tail };
}

function createHerd(scene: THREE.Scene): Update {
  const rand = mulberry32(404);
  // They wander a slow loop around the rim, outside the part of the valley
  // the mossling can reach, so they're always a gentle presence in the haze.
  const R = HERD_RADIUS;
  const members = [
    { angle: 0.4, scale: 1.3, lane: 0, speed: 0.55 },
    { angle: 0.4 - 0.12, scale: 0.55, lane: 2.5, speed: 0.55 },
    { angle: 2.1, scale: 1.2, lane: -1.5, speed: 0.5 },
    { angle: 4.4, scale: 1.4, lane: 1, speed: 0.45 },
  ].map((m) => ({ ...m, beast: sauropod(scene, m.scale, rand() < 0.5 ? 0x8a9a88 : 0x94a8a2, 0xbcc8b4), phase: rand() * 10, graze: rand() * 10 }));

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const place = (angle: number, lane: number, out: THREE.Vector3) => {
    const r = R + lane + Math.sin(angle * 3) * 2;
    return out.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
  };

  return (t, dt) => {
    for (const m of members) {
      const { root, body, legs, neck, head, tail } = m.beast;
      // The calf keeps pace with its parent, so both share the same speed.
      m.angle += (dt * m.speed) / R;
      place(m.angle, m.lane, pos);
      place(m.angle + 0.02, m.lane, ahead);
      root.position.set(pos.x, groundAt(pos.x, pos.z) - 0.3 * m.scale, pos.z);
      root.rotation.y = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);

      m.phase += dt * 1.6;
      const stride = Math.sin(m.phase);
      legs[0].rotation.x = stride * 0.28;
      legs[3].rotation.x = stride * 0.28;
      legs[1].rotation.x = -stride * 0.28;
      legs[2].rotation.x = -stride * 0.28;
      body.position.y = Math.abs(Math.cos(m.phase)) * 0.12;
      body.rotation.z = stride * 0.02;

      // Every so often the neck lowers to browse, then rises again.
      const browse = THREE.MathUtils.smoothstep(Math.sin(t * 0.13 + m.graze), 0.4, 0.9);
      neck.forEach((seg, i) => {
        const lift = i === 0 ? -0.95 + browse * 0.9 : -0.06 + browse * 0.14;
        seg.rotation.set(lift + Math.sin(t * 0.7 + i * 0.5 + m.graze) * 0.03, Math.sin(t * 0.4 + i * 0.4 + m.graze) * 0.05, 0);
      });
      head.rotation.x = 0.5 + browse * 0.4;
      tail.forEach((seg, i) => {
        const droop = i === 0 ? 0.28 : -0.035;
        seg.rotation.x = droop;
        seg.rotation.y = (i === 0 ? Math.PI : 0) + Math.sin(t * 0.9 - i * 0.55 + m.graze) * 0.07;
      });
    }
  };
}

// ---- pterosaurs ------------------------------------------------------------

function createPterosaurs(scene: THREE.Scene): Update {
  const rand = mulberry32(77);
  const wingShape = new THREE.BufferGeometry();
  // A long, swept membrane: root at the body, tip far out to the side.
  wingShape.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0.45, 0, 0, -0.35, 2.4, 0, -0.25, 0, 0, 0.45, 2.4, 0, -0.25, 1.2, 0, 0.3]), 3),
  );
  wingShape.computeVertexNormals();
  const wingMat = lambert({ color: 0x76637e, side: THREE.DoubleSide });
  const bodyMat = lambert({ color: 0x5a4031 });
  const crestMat = lambert({ color: 0xb95c3c });

  const flock = Array.from({ length: 5 }, () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), bodyMat);
    body.scale.set(0.22, 0.2, 0.75);
    g.add(body);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.9, 4), bodyMat);
    beak.rotation.x = Math.PI / 2;
    beak.position.z = 1.05;
    g.add(beak);
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.7, 4), crestMat);
    crest.rotation.x = -2.2;
    crest.position.set(0, 0.2, 0.55);
    g.add(crest);
    const l = new THREE.Mesh(wingShape, wingMat);
    const r = new THREE.Mesh(wingShape, wingMat);
    r.scale.x = -1;
    g.add(l, r);
    g.scale.setScalar(1.6);
    scene.add(g);
    return { g, l, r, cx: (rand() - 0.5) * 50, cz: (rand() - 0.5) * 50, rad: 18 + rand() * 22, h: 24 + rand() * 12, speed: 0.08 + rand() * 0.05, p: rand() * 10, dir: rand() < 0.5 ? 1 : -1 };
  });

  return (t) => {
    for (const b of flock) {
      const a = t * b.speed * b.dir + b.p;
      const x = b.cx + Math.cos(a) * b.rad;
      const z = b.cz + Math.sin(a) * b.rad;
      b.g.position.set(x, b.h + Math.sin(t * 0.3 + b.p) * 2, z);
      // Face along the circle and bank into it.
      b.g.rotation.set(0, Math.atan2(-Math.sin(a) * b.dir, Math.cos(a) * b.dir), 0.35 * b.dir);
      // Mostly gliding, with a few lazy flaps now and then.
      const flapping = Math.sin(t * 0.5 + b.p) > 0.6;
      const flap = flapping ? Math.sin(t * 5 + b.p) * 0.55 : 0.12;
      b.l.rotation.z = flap;
      b.r.rotation.z = -flap;
    }
  };
}

// ---- dragonflies -----------------------------------------------------------

function createDragonflies(scene: THREE.Scene): Update {
  const rand = mulberry32(12);
  const wingGeo = new THREE.PlaneGeometry(0.55, 0.12);
  wingGeo.translate(0.3, 0, 0);
  wingGeo.rotateX(-Math.PI / 2);
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xd9dcc4, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  const bodyColors = [0x35595a, 0x548079, 0xb95c3c, 0x4a3e56];

  const swarm = Array.from({ length: 9 }, (_, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.025, 0.9, 4), lambert({ color: bodyColors[i % bodyColors.length] }));
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const wings: THREE.Mesh[] = [];
    for (const z of [0.12, -0.02])
      for (const s of [1, -1]) {
        const w = new THREE.Mesh(wingGeo, wingMat);
        w.position.z = z;
        w.scale.x = s;
        g.add(w);
        wings.push(w);
      }
    scene.add(g);
    // Most hang around the pond; a few patrol the meadows.
    const nearPond = i < 6;
    const cx = nearPond ? POND.x + (rand() - 0.5) * 10 : (rand() - 0.5) * 40;
    const cz = nearPond ? POND.z + (rand() - 0.5) * 10 : (rand() - 0.5) * 40;
    return { g, wings, cx, cz, p: rand() * 100 };
  });

  return (t) => {
    for (const d of swarm) {
      // Hover, then dart: a stepped path that holds still and zips.
      const k = t * 0.6 + d.p;
      const step = Math.floor(k);
      const f = THREE.MathUtils.smoothstep(k - step, 0.7, 1);
      const hx = (s: number) => Math.sin(s * 12.9898 + d.p) * 3;
      const hz = (s: number) => Math.cos(s * 78.233 + d.p) * 3;
      const x = d.cx + THREE.MathUtils.lerp(hx(step), hx(step + 1), f);
      const z = d.cz + THREE.MathUtils.lerp(hz(step), hz(step + 1), f);
      const y = Math.max(groundAt(x, z), -0.3) + 0.9 + Math.sin(t * 2 + d.p) * 0.12;
      const dx = x - d.g.position.x;
      const dz = z - d.g.position.z;
      d.g.position.set(x, y, z);
      if (dx * dx + dz * dz > 1e-5) d.g.rotation.y = Math.atan2(dx, dz);
      d.wings.forEach((w, i) => (w.rotation.z = Math.sin(t * 40 + i) * 0.25 * w.scale.x));
    }
  };
}

export function createFauna(scene: THREE.Scene): Update {
  const parts = [createHerd(scene), createPterosaurs(scene), createDragonflies(scene)];
  return (t, dt) => parts.forEach((u) => u(t, dt));
}
