// Lamps, boulders, fish-drying racks, a bench and a few moored boats.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../core/math';
import { BuildContext } from './context';
import { PALETTE } from './palette';
import { BENCH, BOATS, BOULDERS, LAMPS, RACKS } from './scatter';

const snow = new THREE.Color(PALETTE.snow);
const rock = new THREE.Color(PALETTE.rock);
const rockDark = new THREE.Color(PALETTE.rockDark);

function boulderGeometry(seed: number) {
  const r = rng(seed);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, r() < 0.4 ? 1 : 0);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.75 + r() * 0.45;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  return g.toNonIndexed();
}

function buildBoulders(ctx: BuildContext) {
  const n = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const bd of BOULDERS) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(bd.x, bd.y + bd.r * bd.squash * 0.35, bd.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, bd.rotY, 0)),
      new THREE.Vector3(bd.r, bd.r * bd.squash, bd.r),
    );
    const g = ctx.batch.add(boulderGeometry(bd.seed), m, PALETTE.rock);
    // Snow caps on the upward-facing facets.
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      n.crossVectors(b.sub(a), c.sub(a)).normalize();
      const rel = (a.y + pos.getY(i + 1) + pos.getY(i + 2)) / 3 - bd.y;
      const color = n.y > 0.55 && rel > bd.r * bd.squash * 0.25 ? snow : rel < 0.1 ? rockDark : rock;
      for (let k = 0; k < 3; k++) col.setXYZ(i + k, color.r, color.g, color.b);
    }
  }
}

function buildLamps(ctx: BuildContext) {
  const { batch, glows, lights } = ctx;
  for (const l of LAMPS) {
    if (l.kind === 'stake') {
      batch.box(0.08, l.height, 0.08, { x: l.x, y: l.y + l.height / 2, z: l.z }, PALETTE.woodDark);
      batch.box(0.16, 0.16, 0.16, { x: l.x, y: l.y + l.height + 0.05, z: l.z }, PALETTE.amber, { key: 'emissive' });
      glows.push({ x: l.x, y: l.y + l.height + 0.05, z: l.z, size: 1.3, color: PALETTE.lampGlow, flicker: 0.15 });
      continue;
    }
    const post = l.kind === 'bridge' ? 0.12 : 0.16;
    batch.box(post, l.height, post, { x: l.x, y: l.y + l.height / 2, z: l.z }, l.kind === 'bridge' ? PALETTE.trim : '#1c2129');
    const top = l.y + l.height;
    // Lantern: dark cap, glowing body.
    const s = l.kind === 'bridge' ? 0.26 : 0.34;
    batch.box(s, s * 1.2, s, { x: l.x, y: top + s * 0.6, z: l.z }, PALETTE.amberHot, { key: 'emissive' });
    batch.box(s * 1.4, 0.08, s * 1.4, { x: l.x, y: top + s * 1.25, z: l.z }, '#1c2129');
    batch.box(s * 1.2, 0.06, s * 1.2, { x: l.x, y: top + s * 1.33, z: l.z }, PALETTE.roofSnow);
    glows.push({ x: l.x, y: top + s * 0.6, z: l.z, size: l.kind === 'bridge' ? 2.8 : 3.4, color: PALETTE.lampGlow, flicker: 0.06 });
    if (l.light) {
      lights.push({
        x: l.x,
        y: top + 0.2,
        z: l.z,
        color: PALETTE.lampGlow,
        intensity: l.kind === 'bridge' ? 7 : 10,
        distance: l.kind === 'bridge' ? 11 : 16,
      });
    }
  }
}

function buildRacks(ctx: BuildContext) {
  const { batch } = ctx;
  for (const r of RACKS) {
    const parent = new THREE.Matrix4().compose(
      new THREE.Vector3(r.x, r.y, r.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rot),
      new THREE.Vector3(1, 1, 1),
    );
    const H = 3.4;
    const n = Math.max(2, Math.round(r.len / 2.2));
    for (let k = 0; k <= n; k++) {
      const x = -r.len / 2 + (k * r.len) / n;
      for (const side of [-1, 1]) {
        batch.box(0.14, H + 0.3, 0.14, { x, y: H / 2 - 0.2, z: side * 0.55 }, PALETTE.woodDark, { parent, rotX: side * 0.28 });
      }
    }
    batch.box(r.len + 0.6, 0.12, 0.12, { x: 0, y: H - 0.15, z: 0 }, PALETTE.woodDark, { parent });
    for (const side of [-1, 1]) {
      batch.box(r.len + 0.3, 0.1, 0.1, { x: 0, y: H * 0.6, z: side * 0.25 }, PALETTE.wood, { parent });
    }
    batch.box(r.len + 0.5, 0.06, 0.2, { x: 0, y: H - 0.06, z: 0 }, PALETTE.roofSnow, { parent });
    // Stockfish hanging in pairs.
    const fr = rng(r.x * 13 + 7);
    for (let x = -r.len / 2 + 0.3; x < r.len / 2 - 0.2; x += 0.34) {
      if (fr() < 0.25) continue;
      for (const side of [-1, 1]) {
        batch.box(0.1, 0.75 + fr() * 0.2, 0.05, { x, y: H * 0.6 - 0.45, z: side * 0.27 }, '#6d6456', { parent, rotY: fr() });
      }
    }
  }
}

function buildBench(ctx: BuildContext) {
  const { batch } = ctx;
  const parent = new THREE.Matrix4().compose(
    new THREE.Vector3(BENCH.x, BENCH.y, BENCH.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), BENCH.rot),
    new THREE.Vector3(1, 1, 1),
  );
  batch.box(1.8, 0.08, 0.45, { x: 0, y: 0.48, z: 0 }, PALETTE.wood, { parent });
  batch.box(1.8, 0.35, 0.06, { x: 0, y: 0.8, z: 0.22 }, PALETTE.wood, { parent, rotX: -0.15 });
  batch.box(1.7, 0.05, 0.4, { x: 0, y: 0.54, z: 0 }, PALETTE.roofSnow, { parent });
  for (const sx of [-0.75, 0.75]) batch.box(0.08, 0.48, 0.4, { x: sx, y: 0.24, z: 0 }, PALETTE.woodDark, { parent });
}

/** Moored boats go in their own group so they can bob on the swell. */
function buildBoats() {
  const group = new THREE.Group();
  group.name = 'boats';
  const colors = ['#d8d2c4', '#2c5b6e', '#7c2620', '#d8d2c4'];
  BOATS.forEach((b, i) => {
    const boat = new THREE.Group();
    boat.position.set(b.x, 0, b.z);
    boat.rotation.y = b.rot;
    boat.userData.phase = i * 1.7;
    const hull = new THREE.MeshLambertMaterial({ color: colors[i % colors.length], flatShading: true });
    const inner = new THREE.MeshLambertMaterial({ color: PALETTE.woodDark, flatShading: true });
    const L = b.len;
    const body = new THREE.Mesh(new THREE.BoxGeometry(L * 0.7, 0.55, 1.5), hull);
    body.position.set(-L * 0.1, 0.12, 0);
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.75, L * 0.35, 4, 1), hull);
    bow.rotation.z = -Math.PI / 2;
    bow.rotation.x = Math.PI / 4;
    bow.scale.set(1, 1, 0.73);
    bow.position.set(L * 0.42, 0.12, 0);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(L * 0.66, 0.05, 1.3), inner);
    floor.position.set(-L * 0.1, 0.36, 0);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 1.35), inner);
    seat.position.set(0, 0.42, 0);
    const snowCover = new THREE.Mesh(new THREE.BoxGeometry(L * 0.3, 0.06, 1.2), new THREE.MeshLambertMaterial({ color: PALETTE.roofSnow }));
    snowCover.position.set(-L * 0.3, 0.42, 0);
    boat.add(body, bow, floor, seat, snowCover);
    boat.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    group.add(boat);
  });
  return group;
}

export function buildProps(ctx: BuildContext) {
  buildBoulders(ctx);
  buildLamps(ctx);
  buildRacks(ctx);
  buildBench(ctx);
  return { boats: buildBoats() };
}
