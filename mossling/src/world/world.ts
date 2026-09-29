import * as THREE from "three";
import { COLORS } from "../palette";
import { lambert, ps1 } from "../ps1";
import { Batch, xf, type FaceTint } from "./batch";
import { mulberry32, valueNoise } from "./noise";
import { createSky } from "./sky";
import { createTerrain, groundAt, pathDistance, PLAY_RADIUS, POND, pondMask, WATER_LEVEL } from "./terrain";
import { createFauna, HERD_RADIUS } from "./fauna";
import { barkTexture, blobTexture, leafTexture, stoneTexture } from "./textures";

export type Collider = { x: number; z: number; r: number };

export type World = {
  colliders: Collider[];
  update: (t: number, dt: number) => void;
  blobTex: THREE.Texture;
};

export const SPAWN = { x: 0, z: 13 };
const NEST = { x: -17, z: -13 };
const FOSSIL = { x: 1, z: -29 };
const GINKGO = { x: -20, z: 14 };

// Keep props out of the landmarks' personal space.
const CLEARINGS = [
  { ...SPAWN, r: 4 },
  { ...NEST, r: 5 },
  { ...FOSSIL, r: 8.5 },
  { ...GINKGO, r: 4.5 },
];

const mossTop: FaceTint = (n, _c, _b, out) => {
  if (n.y > 0.55) out.lerp(new THREE.Color(COLORS.creatureMoss), 0.75);
};

const sunlit: FaceTint = (n, _c, _b, out) => {
  out.multiplyScalar(0.78 + Math.max(0, n.y) * 0.4);
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Matrix for a +Y unit segment stretched from a to b with radius r. */
function span(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.Matrix4 {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, d.divideScalar(len || 1));
  return new THREE.Matrix4().compose(a, q, new THREE.Vector3(r, len, r));
}

export function createWorld(scene: THREE.Scene): World {
  const rand = mulberry32(7);
  const colliders: Collider[] = [];
  const animated: ((t: number, dt: number) => void)[] = [];

  scene.add(createTerrain());
  const sky = createSky();
  scene.add(sky.group);
  animated.push(sky.update);
  animated.push(createFauna(scene));

  // ---- materials ---------------------------------------------------------
  const barkMat = lambert({ vertexColors: true, map: barkTexture() });
  // A little self-light so frond undersides read as deep green, not black.
  const leafMat = lambert({ vertexColors: true, map: leafTexture(), emissive: 0x1e2812 });
  const stoneMat = lambert({ vertexColors: true, map: stoneTexture() });
  const plainMat = lambert({ vertexColors: true });

  const bark = new Batch();
  const leaves = new Batch();
  const stones = new Batch();
  const plain = new Batch();

  const free = (x: number, z: number, r: number, allowRim = false) => {
    if (!allowRim && Math.hypot(x, z) > PLAY_RADIUS) return false;
    if (pathDistance(x, z) < 1.8 + r) return false;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5 + r) return false;
    for (const c of CLEARINGS) if (Math.hypot(x - c.x, z - c.z) < c.r + r) return false;
    for (const c of colliders) if (Math.hypot(x - c.x, z - c.z) < c.r + r + 0.6) return false;
    return true;
  };

  // ---- shared shapes -----------------------------------------------------
  const trunkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 6, 1);
  trunkGeo.translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(1, 0);
  const blobGeo1 = new THREE.IcosahedronGeometry(1, 1);
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1);
  boneGeo.translate(0, 0.5, 0);
  // A frond is two blades: a stalk that widens as it rises, then a tip that droops.
  const frondBase = new THREE.CylinderGeometry(1, 0.35, 1, 4, 1);
  frondBase.translate(0, 0.5, 0);
  const frondTip = new THREE.ConeGeometry(1, 1, 4, 1);
  frondTip.translate(0, 0.5, 0);

  const m4 = () => new THREE.Matrix4();
  function frond(batch: Batch, x: number, y: number, z: number, yaw: number, tilt: number, droop: number, len: number, width: number, color: number) {
    const rot = m4().makeRotationY(yaw).multiply(m4().makeRotationX(tilt));
    const l1 = len * 0.55;
    batch.add(frondBase, m4().makeTranslation(x, y, z).multiply(rot).multiply(m4().makeScale(width, l1, width * 0.16)), { color, vary: 0.18, rand, tint: sunlit });
    const tip = new THREE.Vector3(0, l1, 0).applyMatrix4(rot).add(new THREE.Vector3(x, y, z));
    const rot2 = m4().makeRotationY(yaw).multiply(m4().makeRotationX(droop));
    batch.add(frondTip, m4().makeTranslation(tip.x, tip.y, tip.z).multiply(rot2).multiply(m4().makeScale(width, len * 0.5, width * 0.14)), { color, vary: 0.18, rand, tint: sunlit });
  }

  const ferns = [0x62743a, 0x4a6a2e, 0x80903f, 0x55742f];
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];

  // ---- flora -------------------------------------------------------------

  /** Tree fern: a slim shaggy trunk under a parasol of arching fronds. */
  function treeFern(x: number, z: number, scale: number) {
    const y = groundAt(x, z) - 0.2;
    const h = (2.4 + rand() * 1.6) * scale;
    const r = 0.22 * scale;
    bark.add(trunkGeo, xf(x, y, z, (rand() - 0.5) * 0.12, rand() * 6, (rand() - 0.5) * 0.12, r, h, r), { color: 0x5a4031, vary: 0.3, rand });
    const n = 8 + Math.floor(rand() * 3);
    const color = pick(ferns);
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + rand() * 0.4;
      frond(leaves, x, y + h, z, yaw, 0.9 + rand() * 0.35, 2.1 + rand() * 0.3, (1.9 + rand() * 0.6) * scale, 0.32 * scale, color);
    }
    // A fresh fiddlehead or two uncurling in the middle.
    leaves.add(blobGeo, xf(x, y + h + 0.1 * scale, z, 0, 0, 0, 0.25 * scale), { color: 0x80903f, rand });
    colliders.push({ x, z, r: r + 0.35 });
  }

  /** Cycad: a stout pineapple trunk with a stiff crown and sometimes a cone. */
  function cycad(x: number, z: number, scale: number) {
    const y = groundAt(x, z) - 0.15;
    const h = (0.8 + rand() * 1.1) * scale;
    const r = 0.42 * scale;
    bark.add(trunkGeo, xf(x, y, z, 0, rand() * 6, 0, r, h, r), { color: 0x7b5a3e, vary: 0.4, lumpy: 0.06, rand });
    const n = 11 + Math.floor(rand() * 4);
    const color = rand() < 0.5 ? 0x33442a : 0x475a30;
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + rand() * 0.3;
      frond(leaves, x, y + h, z, yaw, 0.55 + rand() * 0.4, 1.35 + rand() * 0.3, (1.5 + rand() * 0.5) * scale, 0.26 * scale, color);
    }
    if (rand() < 0.4) plain.add(blobGeo1, xf(x, y + h + 0.25 * scale, z, 0, rand(), 0, 0.28 * scale, 0.42 * scale, 0.28 * scale), { color: 0xdf8f55, lumpy: 0.04, rand });
    colliders.push({ x, z, r: r + 0.3 });
  }

  /** Monkey-puzzle conifer: tall bare trunk, tiers of flat branch pads on top. */
  function araucaria(x: number, z: number, scale: number) {
    const y = groundAt(x, z) - 0.3;
    const h = (6 + rand() * 3) * scale;
    const r = 0.3 * scale;
    bark.add(trunkGeo, xf(x, y, z, 0, rand() * 6, 0, r, h, r), { color: 0x6a4a34, rand });
    const tiers = 3 + Math.floor(rand() * 2);
    const color = rand() < 0.5 ? COLORS.pine : 0x243224;
    for (let k = 0; k < tiers; k++) {
      const ty = y + h - 1.8 * scale + k * 0.75 * scale;
      const spread = (1.9 - k * 0.38) * scale;
      const pads = 5 + (k === 0 ? 1 : 0);
      for (let i = 0; i < pads; i++) {
        const a = (i / pads) * Math.PI * 2 + k * 0.6 + rand() * 0.3;
        const px = x + Math.cos(a) * spread * 0.6;
        const pz = z + Math.sin(a) * spread * 0.6;
        leaves.add(blobGeo, xf(px, ty, pz, 0, -a, 0, spread * 0.55, 0.28 * scale, 0.45 * scale), { color, vary: 0.2, lumpy: 0.1, rand, tint: sunlit });
      }
    }
    leaves.add(blobGeo, xf(x, y + h + 0.55 * scale, z, 0, rand(), 0, 0.7 * scale, 0.4 * scale, 0.7 * scale), { color, rand, tint: sunlit });
    colliders.push({ x, z, r: r + 0.35 });
  }

  /** A low clump of ground ferns. */
  function fernClump(x: number, z: number, s: number) {
    const y = groundAt(x, z) - 0.05;
    const n = 6 + Math.floor(rand() * 3);
    const color = pick(ferns);
    for (let i = 0; i < n; i++) {
      frond(leaves, x, y, z, (i / n) * Math.PI * 2 + rand() * 0.5, 0.5 + rand() * 0.35, 1.7 + rand() * 0.3, (1.0 + rand() * 0.5) * s, 0.24 * s, color);
    }
  }

  // The old ginkgo on the knoll: a golden landmark you can see from anywhere.
  {
    const { x, z } = GINKGO;
    const y = groundAt(x, z) - 0.3;
    bark.add(trunkGeo, xf(x, y, z, 0, 0.4, 0.05, 0.9, 4.6, 0.9), { color: 0x5a4031, lumpy: 0.08, rand });
    for (const [a, len, tilt] of [[0.3, 3, 0.9], [2.4, 2.6, 0.8], [4.4, 2.8, 1.0]] as const) {
      bark.add(trunkGeo, xf(x + Math.cos(a) * 0.3, y + 3.6, z + Math.sin(a) * 0.3, Math.sin(a) * tilt, 0, -Math.cos(a) * tilt, 0.35, len, 0.35), { color: 0x5a4031, rand });
    }
    const golds = [0xf0b870, 0xe3cf9c, 0xc4c173, 0xdfae5a];
    for (let i = 0; i < 11; i++) {
      const a = rand() * Math.PI * 2;
      const d = i === 0 ? 0 : 1.5 + rand() * 2.2;
      const br = i === 0 ? 2.6 : 1.3 + rand() * 0.9;
      leaves.add(blobGeo1, xf(x + Math.cos(a) * d, y + 6.2 + rand() * 1.6 - d * 0.25, z + Math.sin(a) * d, rand(), rand() * 6, rand(), br, br * 0.8, br), {
        color: golds[i % golds.length],
        lumpy: 0.3,
        vary: 0.2,
        rand,
        tint: sunlit,
      });
    }
    colliders.push({ x, z, r: 1.3 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      bark.add(trunkGeo, xf(x + Math.cos(a) * 0.8, y + 0.1, z + Math.sin(a) * 0.8, Math.sin(a) * 1.3, 0, -Math.cos(a) * 1.3, 0.25, 1.4, 0.25), { color: 0x5a4031, rand });
    }
    // Fallen fan leaves around its roots.
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const d = 1.6 + rand() * 3.2;
      const lx = x + Math.cos(a) * d;
      const lz = z + Math.sin(a) * d;
      plain.add(blobGeo, xf(lx, groundAt(lx, lz) + 0.02, lz, 0, rand() * 6, 0, 0.14, 0.02, 0.1), { color: golds[i % golds.length], vary: 0.2, rand });
    }
  }

  // Groves inside the valley, a tall conifer wood around the rim.
  for (let i = 0; i < 1500 && colliders.length < 150; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 2;
    const z = (rand() - 0.5) * PLAY_RADIUS * 2;
    if (valueNoise(x * 0.07 + 5, z * 0.07 - 2) < 0.46) continue;
    const scale = 0.8 + rand() * 0.6;
    if (!free(x, z, 1.4 * scale)) continue;
    const roll = rand();
    if (roll < 0.45) treeFern(x, z, scale);
    else if (roll < 0.8) cycad(x, z, scale);
    else araucaria(x, z, scale * 0.9);
  }
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2;
    const r = PLAY_RADIUS - 4 + rand() * 26;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const scale = 1 + rand() * 0.8;
    // Leave a grassy lane through the rim wood where the long-necks walk.
    if (Math.abs(r - HERD_RADIUS) < 6) continue;
    if (!free(x, z, 1.1 * scale, true)) continue;
    if (rand() < 0.7) araucaria(x, z, scale);
    else treeFern(x, z, scale * 1.2);
  }

  // Fern clumps soften the edges of trails and groves.
  for (let i = 0; i < 500; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 2;
    const z = (rand() - 0.5) * PLAY_RADIUS * 2;
    const s = 0.7 + rand() * 0.6;
    if (!free(x, z, s * 0.6)) continue;
    if (valueNoise(x * 0.1 - 9, z * 0.1 + 4) < 0.42) continue;
    fernClump(x, z, s);
  }

  // ---- rocks, logs, mushrooms -------------------------------------------
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

  const logGeo = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
  const capGeo = new THREE.SphereGeometry(1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  const stemGeo = new THREE.CylinderGeometry(0.5, 0.6, 1, 5, 1);
  stemGeo.translate(0, 0.5, 0);

  function mushroom(x: number, z: number, s: number, cap: number) {
    const y = groundAt(x, z) - 0.02;
    plain.add(stemGeo, xf(x, y, z, 0, 0, (rand() - 0.5) * 0.3, 0.12 * s, 0.35 * s, 0.12 * s), { color: 0xf2e6c4, rand });
    plain.add(capGeo, xf(x, y + 0.33 * s, z, (rand() - 0.5) * 0.3, rand() * 6, (rand() - 0.5) * 0.3, 0.3 * s, 0.22 * s, 0.3 * s), { color: cap, rand });
  }

  // Fallen giant logs, mossy and sprouting fungi.
  for (let i = 0; i < 16; i++) {
    const x = (rand() - 0.5) * PLAY_RADIUS * 1.9;
    const z = (rand() - 0.5) * PLAY_RADIUS * 1.9;
    if (!free(x, z, 1.2)) continue;
    const y = groundAt(x, z) - 0.1;
    const len = 2.5 + rand() * 2;
    const ry = rand() * Math.PI;
    bark.add(logGeo, xf(x, y + 0.35, z, Math.PI / 2, 0, ry, 0.4, len, 0.4), { color: 0x7b5a3e, rand, tint: mossTop });
    colliders.push({ x, z, r: 1.1 });
    for (let k = 0; k < 3; k++) mushroom(x + (rand() - 0.5) * 1.6, z + (rand() - 0.5) * 1.6, 0.8 + rand() * 0.6, rand() < 0.6 ? 0xb95c3c : 0xdf8f55);
  }
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

  // ---- the nest ----------------------------------------------------------
  // A ring of mud and twigs in the clearing, with a clutch of speckled eggs.
  // One of them is thinking about hatching.
  let wobbleEgg: THREE.Mesh | null = null;
  {
    const { x, z } = NEST;
    const y = groundAt(x, z);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      plain.add(blobGeo, xf(x + Math.cos(a) * 1.35, y + 0.15, z + Math.sin(a) * 1.35, rand(), -a, rand(), 0.55, 0.35, 0.4), { color: rand() < 0.5 ? 0x7b5a3e : 0x9e7b52, lumpy: 0.1, rand });
    }
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2;
      const tw = new THREE.Vector3(x + Math.cos(a) * 1.5, y + 0.4, z + Math.sin(a) * 1.5);
      const tw2 = tw.clone().add(new THREE.Vector3(Math.cos(a + 1.6) * 0.8, 0.1, Math.sin(a + 1.6) * 0.8));
      plain.add(boneGeo, span(tw, tw2, 0.03), { color: 0x5a4031, rand });
    }
    plain.add(new THREE.CylinderGeometry(1, 1, 0.2, 9, 1), xf(x, y + 0.05, z, 0, 0, 0, 1.15, 1, 1.15), { color: 0xc49e6c, vary: 0.2, rand });
    const eggGeo = new THREE.IcosahedronGeometry(1, 1);
    const eggs: [number, number, number][] = [[0.35, 0.1, 0xf2e6c4], [-0.4, 0.25, 0xbcc8b4], [0.05, -0.45, 0xf2e6c4], [-0.1, 0.55, 0xe3cf9c]];
    eggs.forEach(([ex, ez, color], i) => {
      const egg = new THREE.Mesh(eggGeo, lambert({ color }));
      egg.scale.set(0.3, 0.4, 0.3);
      egg.position.set(x + ex, y + 0.45, z + ez);
      egg.rotation.set((rand() - 0.5) * 0.4, rand() * 6, (rand() - 0.5) * 0.4);
      // Speckles.
      for (let k = 0; k < 6; k++) {
        const dot = new THREE.Mesh(blobGeo, lambert({ color: 0x7b5a3e }));
        const d = new THREE.Vector3(rand() - 0.5, rand() - 0.3, rand() - 0.5).normalize();
        dot.position.copy(d);
        dot.scale.setScalar(0.12);
        egg.add(dot);
      }
      scene.add(egg);
      if (i === 0) wobbleEgg = egg;
    });
    colliders.push({ x, z, r: 1.8 });
    for (let i = 0; i < 6; i++) {
      const a = rand() * Math.PI * 2;
      fernClump(x + Math.cos(a) * 3.2, z + Math.sin(a) * 3.2, 0.8 + rand() * 0.4);
    }
  }
  animated.push((t) => {
    if (!wobbleEgg) return;
    // A little wobble every few seconds.
    const k = (t % 5.5) / 5.5;
    wobbleEgg.rotation.z = k > 0.85 ? Math.sin(t * 28) * 0.18 * Math.sin(((k - 0.85) / 0.15) * Math.PI) : 0;
  });

  // ---- the old skeleton -------------------------------------------------
  // A long-necked giant, half sunk into the moss. The ribs arch high enough to
  // walk through; only their feet are solid.
  {
    const { x: fx, z: fz } = FOSSIL;
    const bone = 0xf2e6c4;
    const boneOld = 0xe3cf9c;
    const n = 7;
    const ribX = (i: number) => fx - 3.6 + i * 1.25;
    let prevTop: THREE.Vector3 | null = null;
    for (let i = 0; i < n; i++) {
      const bx = ribX(i);
      const R = 1.1 + 1.6 * Math.sin((Math.PI * (i + 0.8)) / (n + 0.6));
      const lean = (i - n / 2) * 0.04;
      const base = groundAt(bx, fz) - 0.2;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 6; k++) {
        const phi = (k / 6) * Math.PI;
        pts.push(new THREE.Vector3(bx + Math.sin(phi) * lean * R, base + Math.sin(phi) * R * 1.3, fz + Math.cos(phi) * R));
      }
      for (let k = 0; k < 6; k++) plain.add(boneGeo, span(pts[k], pts[k + 1], 0.22 - Math.abs(k - 3) * 0.02), { color: bone, vary: 0.12, rand, tint: mossTop });
      colliders.push({ x: bx, z: fz + R, r: 0.35 }, { x: bx, z: fz - R, r: 0.35 });
      // Vertebra on top, joined to the one before.
      const top = pts[3].clone().add(new THREE.Vector3(0, 0.15, 0));
      plain.add(blobGeo, xf(top.x, top.y, top.z, rand(), 0, rand(), 0.42, 0.34, 0.36), { color: bone, rand, tint: mossTop });
      if (prevTop) plain.add(boneGeo, span(prevTop, top, 0.2), { color: boneOld, rand, tint: mossTop });
      prevTop = top;
    }
    // Neck bones sweeping down to a skull resting in the moss.
    const neckPts: THREE.Vector3[] = [];
    for (let k = 0; k <= 6; k++) {
      const nx = ribX(0) - 0.9 - k * 1.0;
      const nz = fz + Math.sin(k * 0.5) * 1.4;
      neckPts.push(new THREE.Vector3(nx, groundAt(nx, nz) + Math.max(0.2, 2.9 - k * 0.55), nz));
    }
    if (prevTop) neckPts.unshift(new THREE.Vector3(ribX(0), groundAt(ribX(0), fz) + 2.9, fz));
    for (let k = 0; k < neckPts.length - 1; k++) {
      plain.add(blobGeo, xf(neckPts[k].x, neckPts[k].y, neckPts[k].z, rand(), 0, rand(), 0.34, 0.28, 0.3), { color: bone, rand, tint: mossTop });
      plain.add(boneGeo, span(neckPts[k], neckPts[k + 1], 0.16), { color: boneOld, rand, tint: mossTop });
    }
    const sk = neckPts[neckPts.length - 1];
    const skullY = groundAt(sk.x - 0.6, sk.z) + 0.35;
    plain.add(blobGeo1, xf(sk.x - 0.6, skullY + 0.1, sk.z, 0, 0.3, 0.2, 1.1, 0.7, 0.75), { color: bone, lumpy: 0.08, rand, tint: mossTop });
    plain.add(blobGeo, xf(sk.x - 1.6, skullY - 0.1, sk.z + 0.3, 0, 0.3, 0.1, 0.85, 0.25, 0.5), { color: boneOld, rand, tint: mossTop });
    plain.add(blobGeo, xf(sk.x - 0.4, skullY + 0.3, sk.z + 0.62, 0, 0, 0, 0.2, 0.17, 0.1), { color: 0x2c2830, vary: 0, rand });
    colliders.push({ x: sk.x - 0.7, z: sk.z, r: 0.8 });
    // Tail vertebrae trailing off the other end, disappearing into the ground.
    let prev = prevTop!;
    for (let k = 1; k <= 7; k++) {
      const tx = ribX(n - 1) + k * 0.95;
      const tz = fz - Math.sin(k * 0.45) * 1.2;
      const p = new THREE.Vector3(tx, groundAt(tx, tz) + Math.max(0.05, 2.6 - k * 0.42), tz);
      plain.add(boneGeo, span(prev, p, 0.18 - k * 0.015), { color: boneOld, rand, tint: mossTop });
      plain.add(blobGeo, xf(p.x, p.y, p.z, rand(), 0, rand(), 0.34 - k * 0.025, 0.28 - k * 0.02, 0.3 - k * 0.025), { color: bone, rand, tint: mossTop });
      prev = p;
    }
  }

  // ---- amber stones along the trails ------------------------------------
  // Mossy rocks with a lump of glowing amber on top: the valley's lanterns.
  const blobTex = blobTexture();
  const glowMat = new THREE.SpriteMaterial({ map: blobTex, color: 0xffb050, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.45 });
  const amberSpots: [number, number][] = [[2.2, 9], [-5.8, 1.5], [-13.5, -5], [7.8, 0], [4.2, -12], [3.4, -21.5], [-21.5, 3], [16, -17]];
  const glows: THREE.Sprite[] = [];
  const amberMat = new THREE.MeshBasicMaterial({ color: 0xf0b870 });
  for (const [lx, lz] of amberSpots) {
    const y = groundAt(lx, lz);
    const s = 0.5 + rand() * 0.15;
    stones.add(rockGeo, xf(lx, y + s * 0.3, lz, rand(), rand() * 6, rand(), s * 1.2, s * 0.8, s), { color: 0x8a8a78, lumpy: 0.2, rand, tint: mossTop });
    const amber = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), amberMat);
    amber.scale.set(0.2, 0.32, 0.2);
    amber.position.set(lx, y + s * 0.9 + 0.2, lz);
    amber.rotation.set(0.2, rand() * 6, 0.15);
    scene.add(amber);
    const sprite = new THREE.Sprite(glowMat.clone());
    sprite.position.copy(amber.position);
    sprite.scale.setScalar(1.6);
    sprite.userData.phase = rand() * 10;
    scene.add(sprite);
    glows.push(sprite);
    colliders.push({ x: lx, z: lz, r: 0.55 });
  }
  animated.push((t) => {
    for (const g of glows) (g.material as THREE.SpriteMaterial).opacity = 0.38 + Math.sin(t * 1.3 + g.userData.phase) * 0.08;
  });

  // ---- the volcano -------------------------------------------------------
  // Far off beyond the rim: a hazy cone with a glowing crater and a slow plume.
  {
    const vx = 70;
    const vz = -140;
    const cone = new THREE.CylinderGeometry(9, 62, 95, 10, 4);
    cone.translate(0, 47.5 - 10, 0);
    // Fade from fog at the foot to a dusky violet-grey at the summit.
    const fog = new THREE.Color(COLORS.fog);
    const peak = new THREE.Color(0x76637e);
    const pos = cone.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = THREE.MathUtils.clamp((pos.getY(i) + 10) / 95, 0, 1);
      const c = fog.clone().lerp(peak, Math.pow(k, 0.7) * 0.8);
      const j = 1 + (Math.sin(i * 12.9898) * 0.5) * 0.06;
      col.set([c.r * j, c.g * j, c.b * j], i * 3);
    }
    cone.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const volcano = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    volcano.position.set(vx, 0, vz);
    scene.add(volcano);
    const crater = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 9, 2, 10), new THREE.MeshBasicMaterial({ color: 0xdf8f55, fog: false }));
    crater.position.set(vx, 85.5, vz);
    scene.add(crater);
    const craterGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTex, color: 0xf0a060, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.6 }));
    craterGlow.position.set(vx, 90, vz);
    craterGlow.scale.setScalar(40);
    scene.add(craterGlow);
    const plumeMat = new THREE.MeshBasicMaterial({ color: 0xb9b4a4, transparent: true, depthWrite: false, fog: false });
    const puffs = Array.from({ length: 10 }, (_, i) => {
      const p = new THREE.Mesh(blobGeo1, plumeMat.clone());
      p.userData.offset = i / 10;
      scene.add(p);
      return p;
    });
    animated.push((t) => {
      craterGlow.material.opacity = 0.5 + Math.sin(t * 0.7) * 0.1;
      for (const p of puffs) {
        const k = (t * 0.02 + p.userData.offset) % 1;
        p.position.set(vx + k * 40 + Math.sin(t * 0.2 + k * 6) * 4, 92 + k * 70, vz + k * 10);
        p.scale.setScalar(6 + k * 22);
        p.rotation.set(k * 2, k * 3, 0);
        (p.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 8) * (1 - k) * 0.7;
      }
    });
  }

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
  const reeds = new THREE.InstancedMesh(horsetailGeometry(), lambert({ vertexColors: true }, { wind: 0.12 }), 180);

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
    const h = 1.1 + rand() * 1.1;
    m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.2, 0, (rand() - 0.5) * 0.2)), new THREE.Vector3(1, h, 1));
    reeds.setMatrixAt(ri++, m);
  }
  grass.count = gi;
  flowers.count = fi;
  reeds.count = ri;
  for (let i = 0; i < ri; i++) reeds.setColorAt(i, c.set(rand() < 0.5 ? 0xffffff : 0xd9dcc4));
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

  // ---- commit batches ----------------------------------------------------
  scene.add(bark.build(barkMat), leaves.build(leafMat), stones.build(stoneMat), plain.build(plainMat));

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

/** Horsetail: a jointed green stalk with dark rings and a little cone on top. */
function horsetailGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  const stalk = new THREE.CylinderGeometry(0.035, 0.05, 1, 5, 1);
  stalk.translate(0, 0.5, 0);
  b.add(stalk, new THREE.Matrix4(), { color: 0x80903f, vary: 0 });
  const ring = new THREE.CylinderGeometry(0.06, 0.06, 0.03, 5, 1);
  for (const y of [0.25, 0.48, 0.7]) b.add(ring, xf(0, y, 0), { color: 0x33442a, vary: 0 });
  const cone = new THREE.ConeGeometry(0.05, 0.14, 5, 1);
  b.add(cone, xf(0, 1.05, 0), { color: 0x9e7b52, vary: 0 });
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
