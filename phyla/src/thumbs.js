// Tiny offscreen renderer for portraits: part cards in the editor and the
// creature thumbnails used by the lineage gallery and HUD.

import * as THREE from './three.js';
import { Creature } from './creature.js';
import { buildPartObject } from './parts.js';
import { makeKit } from './skin.js';

let R = null;
let scene = null;
let cam = null;
let clayKit = null;
const partCache = new Map();

function init() {
  if (R) return;
  R = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  R.setPixelRatio(1);
  R.setSize(160, 160);
  R.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#fffaf0', '#8a7f6a', 1.5));
  const sun = new THREE.DirectionalLight('#fff1d8', 2.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  cam = new THREE.PerspectiveCamera(28, 1, 0.05, 60);
  clayKit = makeKit({ base: '#c9a06c', accent: '#8a4f3a', belly: '#efe0bf', pattern: 'plain' }, 3);
}

function frame(obj, dir, pad = 1.25) {
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const rad = Math.max(s.x, s.y, s.z) * 0.5 * pad + 0.01;
  const dist = rad / Math.tan((cam.fov * Math.PI) / 360);
  cam.position.copy(c).addScaledVector(dir.normalize(), dist);
  cam.near = dist * 0.05;
  cam.far = dist * 6;
  cam.updateProjectionMatrix();
  cam.lookAt(c);
}

function shoot(obj, size) {
  R.setSize(size, size);
  scene.add(obj);
  R.render(scene, cam);
  scene.remove(obj);
  return R.domElement.toDataURL('image/png');
}

const BLOB = [
  { y: 0.3, z: -0.42, r: 0.12 },
  { y: 0.32, z: -0.1, r: 0.2 },
  { y: 0.34, z: 0.2, r: 0.2 },
  { y: 0.36, z: 0.44, r: 0.15 },
];

export function partThumb(def, size = 112) {
  if (partCache.has(def.id)) return partCache.get(def.id);
  init();
  let url;
  if (def.cat === 'leg' || def.cat === 'arm') {
    const g = { name: '', spine: BLOB.map((p) => ({ ...p })), parts: [{ id: def.id, u: def.cat === 'leg' ? 1.4 : 2.2, a: def.cat === 'leg' ? 2.2 : 1.6, s: 1 }], skin: clayKit.skin };
    const c = new Creature(g, { kit: clayKit, shadow: false });
    c.heading = 0;
    for (let i = 0; i < 4; i++) c.update(0.03);
    c.mesh.geometry.computeBoundingBox();
    frame(c.root, new THREE.Vector3(1.6, 0.5, 1.5), 1.05);
    url = shoot(c.root, size);
    c.dispose();
  } else {
    const obj = buildPartObject(def, clayKit, 'make');
    // parts are modelled +Y out of the skin; show them tipped toward the camera
    const holder = new THREE.Group();
    holder.add(obj);
    if (def.cat === 'mouth') {
      // face forward (+Y) toward the camera with the top of the mouth (+Z) up
      obj.rotation.order = 'YXZ';
      obj.rotation.set(-Math.PI / 2, Math.PI, 0);
      if (obj.userData.jaw && !obj.userData.pulse) obj.userData.jaw.rotation.x = -0.35;
      frame(holder, new THREE.Vector3(1.5, 0.5, 1.4), 1.2);
    } else if (def.cat === 'eye') {
      obj.rotation.order = 'YXZ';
      obj.rotation.set(-Math.PI / 2.6, Math.PI, 0);
      obj.userData.eye.pupil.position.set(0.012, obj.userData.eye.r * 0.58, 0.012);
      frame(holder, new THREE.Vector3(0.3, 0.35, 1.5), 1.5);
    } else {
      frame(holder, new THREE.Vector3(1.6, 0.7, 0.9), 1.25);
    }
    url = shoot(holder, size);
  }
  partCache.set(def.id, url);
  return url;
}

export function creatureThumb(genome, size = 160) {
  init();
  const c = new Creature(genome, { shadow: false, seed: 5 });
  c.heading = 0;
  for (let i = 0; i < 6; i++) c.update(0.03);
  const pos = c.mesh.geometry.attributes.position;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i));
  for (const s of c.surf) box.expandByPoint(s.obj.position);
  const ctr = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const rad = Math.max(sz.x, sz.y, sz.z) * 0.62 + 0.1;
  const dist = rad / Math.tan((cam.fov * Math.PI) / 360);
  cam.position.copy(ctr).addScaledVector(v.set(1.5, 0.45, 1.6).normalize(), dist);
  cam.near = dist * 0.05;
  cam.far = dist * 6;
  cam.updateProjectionMatrix();
  cam.lookAt(ctr);
  const url = shoot(c.root, size);
  c.dispose();
  return url;
}
