import * as THREE from "three";
import { COLORS } from "../palette";
import { lambert, ps1 } from "../ps1";
import { Batch, xf, type FaceTint } from "./batch";
import { mulberry32, valueNoise } from "./noise";
import { createSky } from "./sky";
import { createTerrain, groundAt, pathDistance, PLAY_RADIUS, POND, pondMask, WATER_LEVEL } from "./terrain";
import { barkTexture, blobTexture, leafTexture, plankTexture, stoneTexture } from "./textures";

export type Collider = { x: number; z: number; r: number };

export type World = {
  colliders: Collider[];
  update: (t: number, dt: number) => void;
  blobTex: THREE.Texture;
};

export const SPAWN = { x: 0, z: 13 };
const COTTAGE = { x: -17, z: -13 };
const STONES = { x: 1, z: -28 };
const OLD_TREE = { x: -20, z: 14 };

// Keep props out of the landmarks' personal space.
const CLEARINGS = [
  { ...SPAWN, r: 4 },
  { ...COTTAGE, r: 7 },
  { ...STONES, r: 7.5 },
  { ...OLD_TREE, r: 4.5 },
];

const mossTop: FaceTint = (n, _c, _b, out) => {
  if (n.y > 0.55) out.lerp(new THREE.Color(COLORS.creatureMoss), 0.75);
};

export function createWorld(scene: THREE.Scene): World {
  const rand = mulberry32(7);
  const colliders: Collider[] = [];
  const animated: ((t: number, dt: number) => void)[] = [];

  scene.add(createTerrain());
  const sky = createSky();
  scene.add(sky.group);
  animated.push(sky.update);

  // ---- materials ---------------------------------------------------------
  const barkMat = lambert({ vertexColors: true, map: barkTexture() });
  const leafMat = lambert({ vertexColors: true, map: leafTexture() });
  const stoneMat = lambert({ vertexColors: true, map: stoneTexture() });
  const plankMat = lambert({ vertexColors: true, map: plankTexture() });
  const plainMat = lambert({ vertexColors: true });

  const bark = new Batch();
  const leaves = new Batch();
  const stones = new Batch();
  const planks = new Batch();
  const plain = new Batch();

  const free = (x: number, z: number, r: number, allowRim = false) => {
    if (!allowRim && Math.hypot(x, z) > PLAY_RADIUS) return false;
    if (pathDistance(x, z) < 1.8 + r) return false;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5 + r) return false;
    for (const c of CLEARINGS) if (Math.hypot(x - c.x, z - c.z) < c.r + r) return false;
    for (const c of colliders) if (Math.hypot(x - c.x, z - c.z) < c.r + r + 0.6) return false;
    return true;
  };

  // ---- trees -------------------------------------------------------------
  const trunkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 6, 1);
  trunkGeo.translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(1, 0);
  const blobGeo1 = new THREE.IcosahedronGeometry(1, 1);
  const coneGeo = new THREE.ConeGeometry(1, 1, 7, 1);
  coneGeo.translate(0, 0.5, 0);

  const leafTints = [COLORS.leaf, COLORS.leafLight, 0x6b8a36, 0x4c6a2e];
  const autumnTints = [0xf0b870, 0xdf8f55, 0xc4c173];

  function roundTree(x: number, z: number, scale: number) {
    const y = groundAt(x, z) - 0.2;
    const h = (2.2 + rand() * 1.2) * scale;
    const r = (0.28 + rand() * 0.1) * scale;
    bark.add(trunkGeo, xf(x, y, z, 0, rand() * 6, (rand() - 0.5) * 0.08, r, h, r), { color: COLORS.bark, rand });
    const autumn = rand() < 0.16;
    const blobs = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < blobs; i++) {
      const a = rand() * Math.PI * 2;
      const d = i === 0 ? 0 : (0.7 + rand() * 0.5) * scale;
      const br = (i === 0 ? 1.5 : 0.9 + rand() * 0.5) * scale;
      const tint = autumn ? autumnTints[Math.floor(rand() * autumnTints.length)] : leafTints[Math.floor(rand() * leafTints.length)];
      leaves.add(
        i === 0 ? blobGeo1 : blobGeo,
        xf(x + Math.cos(a) * d, y + h + (i === 0 ? 0.4 : rand() * 0.9) * scale, z + Math.sin(a) * d, rand(), rand() * 6, rand(), br, br * 0.85, br),
        { color: tint, lumpy: 0.25, vary: 0.2, rand, tint: (n, _c, _b, out) => out.multiplyScalar(0.8 + Math.max(0, n.y) * 0.35) },
      );
    }
    colliders.push({ x, z, r: r + 0.35 });
  }

  function pineTree(x: number, z: number, scale: number) {
    const y = groundAt(x, z) - 0.2;
    const h = (1.2 + rand() * 0.5) * scale;
    const r = 0.26 * scale;
    bark.add(trunkGeo, xf(x, y, z, 0, rand() * 6, 0, r, h, r), { color: COLORS.bark, rand });
    const tiers = 3 + Math.floor(rand() * 2);
    for (let i = 0; i < tiers; i++) {
      const k = 1 - i / (tiers + 0.5);
      const w = (1.6 * k + 0.3) * scale;
      leaves.add(coneGeo, xf(x, y + h + i * 1.05 * scale, z, 0, rand() * 6, 0, w, 1.7 * scale, w), {
        color: rand() < 0.5 ? COLORS.pine : 0x2f4a2c,
        vary: 0.18,
        rand,
        tint: (n, _c, _b, out) => out.multiplyScalar(0.8 + Math.max(0, n.y) * 0.4),
      });
    }
    colliders.push({ x, z, r: r + 0.35 });
  }

  // The old blossom tree on the knoll — a landmark you can see from anywhere.
  {
    const { x, z } = OLD_TREE;
    const y = groundAt(x, z) - 0.3;
    bark.add(trunkGeo, xf(x, y, z, 0, 0.4, 0.05, 0.9, 4.6, 0.9), { color: 0x5a4031, lumpy: 0.08, rand });
    for (const [a, len, tilt] of [[0.3, 3, 0.9], [2.4, 2.6, 0.8], [4.4, 2.8, 1.0]] as const) {
      bark.add(trunkGeo, xf(x + Math.cos(a) * 0.3, y + 3.6, z + Math.sin(a) * 0.3, Math.sin(a) * tilt, 0, -Math.cos(a) * tilt, 0.35, len, 0.35), { color: 0x5a4031, rand });
    }
    const pinks = [0xe6a9a0, 0xc9747a, 0xf0c4b4, 0xdf9f98];
    for (let i = 0; i < 11; i++) {
      const a = rand() * Math.PI * 2;
      const d = i === 0 ? 0 : 1.5 + rand() * 2.2;
      const br = i === 0 ? 2.6 : 1.3 + rand() * 0.9;
      leaves.add(blobGeo1, xf(x + Math.cos(a) * d, y + 6.2 + rand() * 1.6 - d * 0.25, z + Math.sin(a) * d, rand(), rand() * 6, rand(), br, br * 0.8, br), {
        color: pinks[i % pinks.length],
        lumpy: 0.3,
        vary: 0.2,
        rand,
        tint: (n, _c, _b, out) => out.multiplyScalar(0.78 + Math.max(0, n.y) * 0.35),
      });
    }
    colliders.push({ x, z, r: 1.3 });
    // Roots
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      bark.add(trunkGeo, xf(x + Math.cos(a) * 0.8, y + 0.1, z + Math.sin(a) * 0.8, Math.sin(a) * 1.3, 0, -Math.cos(a) * 1.3, 0.25, 1.4, 0.25), { color: 0x5a4031, rand });
    }
  }

  // Scatter trees: groves inside the glen, a thick wood around the rim.
  for (let i = 0; i < 1500 && colliders.length < 140; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 2;
    const z = (rand() - 0.5) * PLAY_RADIUS * 2;
    if (valueNoise(x * 0.07 + 5, z * 0.07 - 2) < 0.48) continue;
    const scale = 0.8 + rand() * 0.6;
    if (!free(x, z, 1.4 * scale)) continue;
    if (rand() < 0.65) roundTree(x, z, scale);
    else pineTree(x, z, scale);
  }
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2;
    const r = PLAY_RADIUS - 4 + rand() * 26;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const scale = 1 + rand() * 0.9;
    if (!free(x, z, 1.1 * scale, true)) continue;
    if (rand() < 0.55) pineTree(x, z, scale * 1.15);
    else roundTree(x, z, scale);
  }

  // Bushes: low lumpy clumps that soften the edges of paths and groves.
  for (let i = 0; i < 400; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 2;
    const z = (rand() - 0.5) * PLAY_RADIUS * 2;
    const s = 0.5 + rand() * 0.5;
    if (!free(x, z, s)) continue;
    if (valueNoise(x * 0.1 - 9, z * 0.1 + 4) < 0.45) continue;
    const y = groundAt(x, z);
    const tint = rand() < 0.2 ? 0x80903f : rand() < 0.5 ? COLORS.leaf : 0x4c6a2e;
    for (let k = 0; k < 3; k++) {
      const a = rand() * Math.PI * 2;
      const r = s * (0.7 + rand() * 0.4);
      leaves.add(blobGeo, xf(x + Math.cos(a) * s * 0.6, y + r * 0.4, z + Math.sin(a) * s * 0.6, rand(), rand() * 6, rand(), r, r * 0.75, r), {
        color: tint,
        lumpy: 0.2,
        vary: 0.2,
        rand,
        tint: (n, _c, _b, out) => out.multiplyScalar(0.8 + Math.max(0, n.y) * 0.35),
      });
    }
    // A few bushes carry berries or blossoms.
    if (rand() < 0.35) {
      const berry = rand() < 0.5 ? 0xb95c3c : 0xe6a9a0;
      for (let k = 0; k < 5; k++)
        plain.add(blobGeo, xf(x + (rand() - 0.5) * s * 1.6, y + s * (0.5 + rand() * 0.5), z + (rand() - 0.5) * s * 1.6, 0, 0, 0, 0.07), { color: berry, vary: 0 });
    }
    colliders.push({ x, z, r: s * 0.8 });
  }

  // ---- rocks, stumps, logs, mushrooms -----------------------------------
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 70; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 2.1;
    const z = (rand() - 0.5) * PLAY_RADIUS * 2.1;
    const s = 0.35 + rand() * rand() * 1.4;
    if (!free(x, z, s, true)) continue;
    stones.add(rockGeo, xf(x, groundAt(x, z) + s * 0.25, z, rand(), rand() * 6, rand(), s * (1 + rand() * 0.5), s * 0.75, s), {
      color: rand() < 0.5 ? COLORS.rock : 0x7a7768,
      lumpy: 0.25,
      rand,
      tint: mossTop,
    });
    if (s > 0.6) colliders.push({ x, z, r: s * 0.9 });
  }

  const stumpGeo = new THREE.CylinderGeometry(1, 1.15, 1, 7, 1);
  stumpGeo.translate(0, 0.5, 0);
  const logGeo = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
  const capGeo = new THREE.SphereGeometry(1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  const stemGeo = new THREE.CylinderGeometry(0.5, 0.6, 1, 5, 1);
  stemGeo.translate(0, 0.5, 0);

  function mushroom(x: number, z: number, s: number, cap: number) {
    const y = groundAt(x, z) - 0.02;
    plain.add(stemGeo, xf(x, y, z, 0, 0, (rand() - 0.5) * 0.3, 0.12 * s, 0.35 * s, 0.12 * s), { color: 0xf2e6c4, rand });
    plain.add(capGeo, xf(x, y + 0.33 * s, z, (rand() - 0.5) * 0.3, rand() * 6, (rand() - 0.5) * 0.3, 0.3 * s, 0.22 * s, 0.3 * s), { color: cap, rand });
  }

  for (let i = 0; i < 26; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 1.9;
    const z = (rand() - 0.5) * PLAY_RADIUS * 1.9;
    if (!free(x, z, 0.8)) continue;
    const y = groundAt(x, z) - 0.1;
    if (rand() < 0.55) {
      const s = 0.4 + rand() * 0.3;
      bark.add(stumpGeo, xf(x, y, z, 0, rand() * 6, 0, s, 0.5 + rand() * 0.3, s), { color: COLORS.bark, rand, tint: mossTop });
      colliders.push({ x, z, r: s + 0.2 });
      for (let k = 0; k < 3; k++) mushroom(x + (rand() - 0.5) * 1.4, z + (rand() - 0.5) * 1.4, 0.8 + rand() * 0.6, rand() < 0.6 ? 0xb95c3c : 0xdf8f55);
    } else {
      const len = 2 + rand() * 1.5;
      const ry = rand() * Math.PI;
      bark.add(logGeo, xf(x, y + 0.3, z, Math.PI / 2, 0, ry, 0.32, len, 0.32), { color: 0x7b5a3e, rand, tint: mossTop });
      colliders.push({ x, z, r: 0.9 });
    }
  }
  // Mushroom rings in shady spots.
  for (let i = 0; i < 9; i++) {
    const cx = (rand() - 0.5) * PLAY_RADIUS * 1.7;
    const cz = (rand() - 0.5) * PLAY_RADIUS * 1.7;
    if (!free(cx, cz, 1.2)) continue;
    const n = 5 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      mushroom(cx + Math.cos(a) * 1.1, cz + Math.sin(a) * 1.1, 0.7 + rand() * 0.8, rand() < 0.7 ? 0xc9747a : 0xf0b870);
    }
  }

  // ---- cottage -----------------------------------------------------------
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const prism = new THREE.CylinderGeometry(1, 1, 1, 3, 1);
  prism.rotateZ(Math.PI / 2);
  prism.rotateX(Math.PI / 6);
  {
    const { x, z } = COTTAGE;
    const y = groundAt(x, z) - 0.1;
    const rot = 0.5;
    const cottage = new THREE.Group();
    cottage.position.set(x, y, z);
    cottage.rotation.y = rot;
    const local = (m: THREE.Matrix4) => m.premultiply(new THREE.Matrix4().makeRotationY(rot)).premultiply(new THREE.Matrix4().makeTranslation(x, y, z));

    stones.add(box, local(xf(0, -0.2, 0, 0, 0, 0, 5.2, 0.6, 4.2)), { color: 0x9b9785, rand });
    planks.add(box, local(xf(0, 0.3, 0, 0, 0, 0, 4.6, 2.5, 3.6)), { color: 0xe0c89a, rand });
    // Timber frame
    for (const [px, pz] of [[-2.3, -1.8], [2.3, -1.8], [-2.3, 1.8], [2.3, 1.8]] as const)
      plain.add(box, local(xf(px, 0.2, pz, 0, 0, 0, 0.3, 2.7, 0.3)), { color: 0x5a4031, rand });
    // Roof: mossy thatch prism
    plain.add(prism, local(xf(0, 3.35, 0, 0, 0, 0, 5.8, 2.1, 3.3)), {
      color: 0x7f8c3a,
      vary: 0.25,
      rand,
      tint: (n, _c, _b, out) => (n.y < -0.5 ? out.set(0x3f2d24) : out.multiplyScalar(0.85 + n.y * 0.3)),
    });
    // Chimney
    stones.add(box, local(xf(1.4, 2.4, -0.7, 0, 0, 0, 0.7, 2.6, 0.7)), { color: 0x8a8a78, rand, tint: mossTop });
    // Door + step
    planks.add(box, local(xf(0.4, 0.3, 1.82, 0, 0, 0, 0.95, 1.7, 0.1)), { color: 0x7b5a3e, rand });
    stones.add(box, local(xf(0.4, 0, 2.3, 0, 0, 0, 1.3, 0.2, 0.6)), { color: 0x9b9785, rand });
    // Fence
    for (let i = 0; i < 7; i++) {
      const fx = -3.2 + i * 0.9;
      plain.add(box, local(xf(fx, -0.1, 3.6, 0, 0, (rand() - 0.5) * 0.1, 0.16, 1.0, 0.16)), { color: 0x9e7b52, rand });
    }
    plain.add(box, local(xf(-0.5, 0.55, 3.6, 0, 0, 0, 5.6, 0.1, 0.08)), { color: 0x9e7b52, rand });

    // Warm windows glow from inside.
    const windowMat = new THREE.MeshBasicMaterial({ color: 0xffc46b, fog: false });
    for (const [wx, wz, wr] of [[-1.3, 1.83, 0], [2.33, 0, Math.PI / 2]] as const) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.7), windowMat);
      win.position.set(wx, 1.4, wz);
      win.rotation.y = wr;
      cottage.add(win);
    }
    scene.add(cottage);
    const doorLight = new THREE.PointLight(0xffb35c, 6, 9, 1.6);
    doorLight.position.set(x + Math.sin(rot) * 3 + 0.4, y + 2, z + Math.cos(rot) * 3);
    scene.add(doorLight);
    colliders.push({ x, z, r: 2.4 }, { x: x - 1.6, z: z + 0.9, r: 1.6 }, { x: x + 1.6, z: z - 0.9, r: 1.6 });

    // Chimney smoke: chunky puffs that rise, swell, and fade.
    const smokeMat = ps1(new THREE.MeshLambertMaterial({ color: 0xe8e0c8, flatShading: true, transparent: true, depthWrite: false }));
    const chimney = new THREE.Vector3(1.4, 5.2, -0.7).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(x, y, z));
    const puffs = Array.from({ length: 7 }, (_, i) => {
      const m = new THREE.Mesh(blobGeo, smokeMat.clone());
      m.userData.offset = i / 7;
      scene.add(m);
      return m;
    });
    animated.push((t) => {
      for (const p of puffs) {
        const k = (t * 0.12 + p.userData.offset) % 1;
        p.position.set(chimney.x + Math.sin(t * 0.6 + k * 5) * 0.4 + k * 1.6, chimney.y + k * 5, chimney.z + k * 0.8);
        p.scale.setScalar(0.25 + k * 0.9);
        p.rotation.set(k * 3, k * 2, 0);
        (p.material as THREE.MeshLambertMaterial).opacity = Math.min(1, k * 6) * (1 - k) * 0.85;
      }
    });
  }

  // ---- standing stones ---------------------------------------------------
  {
    const { x, z } = STONES;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (i === 2) continue; // a gap where the path comes in
      const sx = x + Math.cos(a) * 5;
      const sz = z + Math.sin(a) * 5;
      const h = 2 + rand() * 1.4;
      stones.add(box, xf(sx, groundAt(sx, sz) - 0.3, sz, (rand() - 0.5) * 0.15, -a, (rand() - 0.5) * 0.15, 0.9, h, 0.6), {
        color: 0x8f8d7c,
        lumpy: 0.1,
        rand,
        tint: mossTop,
      });
      colliders.push({ x: sx, z: sz, r: 0.7 });
    }
    // Central altar with a little glowing crystal.
    const ay = groundAt(x, z);
    stones.add(box, xf(x, ay - 0.2, z, 0, 0.3, 0, 1.6, 0.8, 1.1), { color: 0x9b9785, rand, tint: mossTop });
    colliders.push({ x, z, r: 1.1 });
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshBasicMaterial({ color: 0xc8f0d8, fog: false }));
    crystal.position.set(x, ay + 1.05, z);
    scene.add(crystal);
    const glow = new THREE.PointLight(0x9fe0c0, 5, 10, 1.5);
    glow.position.set(x, ay + 1.5, z);
    scene.add(glow);
    animated.push((t) => {
      crystal.rotation.y = t * 0.8;
      crystal.position.y = ay + 1.05 + Math.sin(t * 1.6) * 0.08;
      glow.intensity = 4.5 + Math.sin(t * 2.1) * 1;
    });
  }

  // ---- lanterns along the paths -----------------------------------------
  const blobTex = blobTexture();
  const glowMat = new THREE.SpriteMaterial({ map: blobTex, color: 0xffc46b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 });
  const lanternSpots: [number, number][] = [[2.2, 9], [-5.8, 1.5], [-13.5, -5], [7.8, 0], [4.2, -12], [3.4, -21.5], [-21.5, 3]];
  const flames: THREE.Sprite[] = [];
  for (const [lx, lz] of lanternSpots) {
    const y = groundAt(lx, lz);
    plain.add(box, xf(lx, y - 0.2, lz, 0, 0.3, 0, 0.14, 1.55, 0.14), { color: 0x5a4031, rand });
    plain.add(box, xf(lx, y + 1.35, lz, 0, 0.3, 0, 0.36, 0.08, 0.36), { color: 0x3f2d24, rand });
    plain.add(box, xf(lx, y + 1.7, lz, 0, 0.3, 0, 0.4, 0.08, 0.4), { color: 0x3f2d24, rand });
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.28, 0.24), new THREE.MeshBasicMaterial({ color: 0xffd08a }));
    core.position.set(lx, y + 1.57, lz);
    core.rotation.y = 0.3;
    scene.add(core);
    const sprite = new THREE.Sprite(glowMat.clone());
    sprite.position.set(lx, y + 1.57, lz);
    sprite.scale.setScalar(1.8);
    sprite.userData.phase = rand() * 10;
    scene.add(sprite);
    flames.push(sprite);
    colliders.push({ x: lx, z: lz, r: 0.3 });
  }
  animated.push((t) => {
    for (const f of flames) {
      const flick = 0.5 + Math.sin(t * 7 + f.userData.phase) * 0.06 + Math.sin(t * 13 + f.userData.phase) * 0.04;
      (f.material as THREE.SpriteMaterial).opacity = flick;
    }
  });

  // ---- pond --------------------------------------------------------------
  {
    const waterTex = rippleTexture();
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(POND.r + 4, 20),
      ps1(new THREE.MeshLambertMaterial({ color: COLORS.water, map: waterTex, transparent: true, opacity: 0.82, emissive: 0x1d3432 })),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(POND.x, WATER_LEVEL, POND.z);
    scene.add(water);
    animated.push((t) => {
      waterTex.offset.set(t * 0.015, Math.sin(t * 0.3) * 0.02);
    });

    const padGeo = new THREE.CylinderGeometry(1, 1, 0.05, 7, 1, false, 0.4, Math.PI * 1.8);
    for (let i = 0; i < 12; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * POND.r * 0.6;
      const px = POND.x + Math.cos(a) * d;
      const pz = POND.z + Math.sin(a) * d;
      if (pondMask(px, pz) < 0.4) continue;
      const s = 0.35 + rand() * 0.3;
      plain.add(padGeo, xf(px, WATER_LEVEL + 0.03, pz, 0, rand() * 6, 0, s, 1, s), { color: 0x62743a, rand });
      if (rand() < 0.45) plain.add(blobGeo, xf(px, WATER_LEVEL + 0.12, pz, 0, rand(), 0, 0.14, 0.1, 0.14), { color: 0xf0c4b4, rand });
    }
  }

  // ---- grass, flowers, reeds (instanced + wind) --------------------------
  const tuftGeo = mergeBlades();
  const grassMat = lambert({ vertexColors: true }, { wind: 0.22 });
  const grassCount = 3200;
  const grass = new THREE.InstancedMesh(tuftGeo, grassMat, grassCount);
  const flowerGeo = flowerGeometry();
  const flowerMat = lambert({ vertexColors: true }, { wind: 0.3 });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, 900);
  const reedGeo = new THREE.CylinderGeometry(0.03, 0.05, 1, 3, 1);
  reedGeo.translate(0, 0.5, 0);
  const reeds = new THREE.InstancedMesh(reedGeo, lambert({ color: 0x80903f }, { wind: 0.12 }), 160);

  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const grassColors = [0x80903f, 0x8f9c42, 0xa3a852, 0x6f8a3a, 0xb3b86a];
  const flowerColors = [0xf2e6c4, 0xe6a9a0, 0xf0b870, 0xc9a0d0, 0xfff8e2, 0xdf8f55];
  let gi = 0;
  let fi = 0;
  let ri = 0;
  for (let i = 0; i < 40000 && (gi < grassCount || fi < flowers.count); i++) {
    const x = (rand() - 0.5) * (PLAY_RADIUS + 10) * 2;
    const z = (rand() - 0.5) * (PLAY_RADIUS + 10) * 2;
    if (Math.hypot(x, z) > PLAY_RADIUS + 8) continue;
    const y = groundAt(x, z);
    if (y < WATER_LEVEL + 0.1) continue;
    const pd = pathDistance(x, z);
    if (pd < 1.1) continue;
    const clump = valueNoise(x * 0.18 + 3, z * 0.18 - 8);
    if (gi < grassCount && clump > 0.35) {
      const s = 0.45 + rand() * 0.45 * clump;
      m.compose(new THREE.Vector3(x, y - 0.03, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6, 0)), new THREE.Vector3(s, s * (0.6 + clump * 0.6), s));
      grass.setMatrixAt(gi, m);
      grass.setColorAt(gi, c.set(grassColors[Math.floor(rand() * grassColors.length)]));
      gi++;
    }
    const meadow = valueNoise(x * 0.06 - 20, z * 0.06 + 9);
    if (fi < flowers.count && meadow > 0.55 && rand() < 0.35) {
      const s = 0.7 + rand() * 0.6;
      m.compose(new THREE.Vector3(x, y - 0.02, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6, 0)), new THREE.Vector3(s, s, s));
      flowers.setMatrixAt(fi, m);
      // Patches of one color read better than confetti.
      const idx = Math.floor(valueNoise(x * 0.3, z * 0.3) * flowerColors.length * 0.999);
      flowers.setColorAt(fi, c.set(flowerColors[rand() < 0.8 ? idx : Math.floor(rand() * flowerColors.length)]));
      fi++;
    }
  }
  for (let i = 0; i < 2000 && ri < reeds.count; i++) {
    const a = rand() * Math.PI * 2;
    const d = POND.r * (0.55 + rand() * 0.6);
    const x = POND.x + Math.cos(a) * d;
    const z = POND.z + Math.sin(a) * d;
    const y = groundAt(x, z);
    if (y > WATER_LEVEL + 0.3 || y < WATER_LEVEL - 0.5) continue;
    if (pathDistance(x, z) < 1.5) continue;
    const h = 0.8 + rand() * 0.9;
    m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.2, 0, (rand() - 0.5) * 0.2)), new THREE.Vector3(1, h, 1));
    reeds.setMatrixAt(ri++, m);
  }
  grass.count = gi;
  flowers.count = fi;
  reeds.count = ri;
  for (const im of [grass, flowers, reeds]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false;
    scene.add(im);
  }

  // ---- floating motes: pollen by day, a few fireflies near the pond -----
  const moteCount = 220;
  const motePos = new Float32Array(moteCount * 3);
  const moteSeed = Array.from({ length: moteCount }, () => ({
    x: (rand() - 0.5) * PLAY_RADIUS * 1.8,
    z: (rand() - 0.5) * PLAY_RADIUS * 1.8,
    h: 0.4 + rand() * 3,
    p: rand() * 100,
  }));
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ color: 0xfff1c0, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false }));
  motes.frustumCulled = false;
  scene.add(motes);
  animated.push((t) => {
    for (let i = 0; i < moteCount; i++) {
      const s = moteSeed[i];
      const x = s.x + Math.sin(t * 0.2 + s.p) * 1.5;
      const z = s.z + Math.cos(t * 0.17 + s.p * 1.3) * 1.5;
      motePos[i * 3] = x;
      motePos[i * 3 + 1] = groundAt(x, z) + s.h + Math.sin(t * 0.8 + s.p) * 0.3;
      motePos[i * 3 + 2] = z;
    }
    moteGeo.attributes.position.needsUpdate = true;
  });

  // ---- butterflies -------------------------------------------------------
  const wingGeo = new THREE.PlaneGeometry(0.22, 0.16);
  wingGeo.translate(0.11, 0, 0);
  wingGeo.rotateX(-Math.PI / 2);
  const butterflyColors = [0xf2e6c4, 0xf0b870, 0xe6a9a0, 0xc9a0d0];
  const butterflies = Array.from({ length: 10 }, (_, i) => {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: butterflyColors[i % butterflyColors.length], side: THREE.DoubleSide });
    const l = new THREE.Mesh(wingGeo, mat);
    const r = new THREE.Mesh(wingGeo, mat);
    r.scale.x = -1;
    g.add(l, r);
    g.userData = { l, r, cx: (rand() - 0.5) * 50, cz: (rand() - 0.5) * 50, p: rand() * 100, rad: 2 + rand() * 4 };
    scene.add(g);
    return g;
  });
  animated.push((t) => {
    for (const b of butterflies) {
      const u = b.userData;
      const k = t * 0.35 + u.p;
      const x = u.cx + Math.sin(k) * u.rad + Math.sin(k * 2.3) * 0.8;
      const z = u.cz + Math.cos(k * 0.8) * u.rad;
      const y = groundAt(x, z) + 0.8 + Math.sin(k * 3.1) * 0.35 + Math.abs(Math.sin(t * 9 + u.p)) * 0.1;
      const dx = x - b.position.x;
      const dz = z - b.position.z;
      b.position.set(x, y, z);
      if (dx * dx + dz * dz > 1e-6) b.rotation.y = Math.atan2(dx, dz);
      const flap = Math.sin(t * 18 + u.p) * 1.1;
      u.l.rotation.z = flap;
      u.r.rotation.z = -flap;
    }
  });

  // ---- commit batches ----------------------------------------------------
  scene.add(bark.build(barkMat), leaves.build(leafMat), stones.build(stoneMat), planks.build(plankMat), plain.build(plainMat));

  return {
    colliders,
    blobTex,
    update: (t, dt) => animated.forEach((fn) => fn(t, dt)),
  };
}

/** A tuft: five tapered blades, greener at the base, sunlit at the tips. */
function mergeBlades(): THREE.BufferGeometry {
  const b = new Batch();
  const blade = new THREE.ConeGeometry(0.045, 1, 3, 1);
  blade.translate(0, 0.5, 0);
  const r = mulberry32(3);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add(blade, xf(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35, 1, 0.35 + r() * 0.25, 1), {
      color: 0xffffff,
      vary: 0.25,
      rand: r,
      tint: (_n, center, _b, out) => out.multiplyScalar(0.8 + center.y * 0.6),
    });
  }
  const mesh = b.build(new THREE.MeshBasicMaterial());
  return mesh.geometry;
}

function flowerGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  const stem = new THREE.CylinderGeometry(0.015, 0.02, 1, 3, 1);
  stem.translate(0, 0.5, 0);
  b.add(stem, xf(0, 0, 0, 0, 0, 0, 1, 0.34, 1), { color: 0x9aa068, vary: 0 });
  b.add(new THREE.IcosahedronGeometry(0.08, 0), xf(0, 0.36, 0, 0, 0, 0, 1, 0.6, 1), { color: 0xffffff, vary: 0.1 });
  b.add(new THREE.IcosahedronGeometry(0.03, 0), xf(0, 0.4, 0), { color: 0xf0b870, vary: 0 });
  return b.build(new THREE.MeshBasicMaterial()).geometry;
}

function rippleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const r = mulberry32(5);
  ctx.fillStyle = "rgb(210,210,210)";
  ctx.fillRect(0, 0, 32, 32);
  for (let i = 0; i < 22; i++) {
    const x = Math.floor(r() * 32);
    const y = Math.floor(r() * 32);
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.fillRect(x, y, 3 + Math.floor(r() * 4), 1);
    ctx.fillStyle = "rgb(170,170,170)";
    ctx.fillRect(x + 1, y + 1, 2, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  return tex;
}
