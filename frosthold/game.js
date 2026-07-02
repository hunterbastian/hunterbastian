import * as THREE from './vendor/three.module.js';

/* ============================================================================
   FROSTHOLD — a little open-world RPG for your phone.
   Single-file game engine: world gen, day/night, third-person controller,
   touch input, simple combat/AI, quests, and a mobile HUD.
   ============================================================================ */

/* ---------------------------------------------------------------- utilities */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));
const randRange = (a, b) => a + Math.random() * (b - a);
const choice = (arr) => arr[(Math.random() * arr.length) | 0];

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function noise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, octaves = 4) {
  let total = 0, amp = 0.5, freq = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise2D(x * freq, y * freq) * amp;
    sum += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (total / sum) * 2 - 1;
}

/* ------------------------------------------------------------------- config */

const WORLD_RADIUS = 130;
const BOUND_RADIUS = 118;
const DAY_LENGTH = 260; // seconds per full day/night cycle

const VILLAGE_POS = new THREE.Vector3(0, 0, 6);
const WOLF_DEN_POS = new THREE.Vector3(-58, 0, -52);
const KEEP_POS = new THREE.Vector3(72, 0, 66);
const ELDER_POS = new THREE.Vector3(6, 0, -6);

function terrainHeight(x, z) {
  const n1 = fbm(x * 0.012, z * 0.012, 5);
  const n2 = fbm(x * 0.05 + 100, z * 0.05 + 100, 3);
  let h = n1 * 13 + n2 * 2.4;

  const distVillage = Math.hypot(x - VILLAGE_POS.x, z - VILLAGE_POS.z);
  const flatten = smoothstep(46, 6, distVillage);
  h = lerp(h, h * 0.12, flatten);

  const dist = Math.hypot(x, z);
  const edgeRise = smoothstep(88, WORLD_RADIUS + 6, dist);
  h += edgeRise * 46;

  return h;
}

function terrainNormalAt(x, z, eps = 0.6) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  const n = new THREE.Vector3(hL - hR, 2 * eps, hD - hU);
  return n.normalize();
}

/* ---------------------------------------------------------------- renderer */

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 480);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

/* -------------------------------------------------------------------- sky */

const NIGHT_TOP = new THREE.Color(0x050914);
const NIGHT_BOTTOM = new THREE.Color(0x0d1730);
const DAY_TOP = new THREE.Color(0x2f6fd6);
const DAY_BOTTOM = new THREE.Color(0xcfe8ff);
const DUSK_TOP = new THREE.Color(0x3a3466);
const DUSK_BOTTOM = new THREE.Color(0xff9a5c);

const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor: { value: new THREE.Color(0x111a33) },
    bottomColor: { value: new THREE.Color(0x334466) },
    offset: { value: 12 },
    exponent: { value: 0.68 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }`,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }`,
  side: THREE.BackSide,
  depthWrite: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 16), skyMat);
scene.add(sky);

const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(7, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xfff3d6 })
);
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(4.5, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xcbd8ff })
);
scene.add(sunMesh, moonMesh);

const starCount = 900;
const starPos = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 370;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(Math.random() * 0.92);
  starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  starPos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.9 + 20;
  starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, transparent: true, opacity: 0, depthWrite: false }));
scene.add(stars);

const hemiLight = new THREE.HemisphereLight(0x8fb0ff, 0x2a2318, 0.5);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xffffff, 1);
sunLight.target.position.set(0, 0, 0);
scene.add(sunLight, sunLight.target);
const ambient = new THREE.AmbientLight(0x445577, 0.25);
scene.add(ambient);

let dayFactor = 0.7;
let sunDirVec = new THREE.Vector3(0.4, 0.8, 0.3);

function updateSky(elapsed, focusPos) {
  const t = (elapsed % DAY_LENGTH) / DAY_LENGTH;
  const angle = (t - 0.25) * Math.PI * 2;
  sunDirVec.set(Math.cos(angle), Math.sin(angle), 0.35).normalize();

  dayFactor = smoothstep(-0.2, 0.3, sunDirVec.y);
  const horizonFactor = 1 - smoothstep(0.25, 0.85, Math.abs(sunDirVec.y));

  const top = new THREE.Color().lerpColors(NIGHT_TOP, DAY_TOP, dayFactor).lerp(DUSK_TOP, horizonFactor * 0.4);
  const bottom = new THREE.Color().lerpColors(NIGHT_BOTTOM, DAY_BOTTOM, dayFactor).lerp(DUSK_BOTTOM, horizonFactor * 0.85);
  skyMat.uniforms.topColor.value.copy(top);
  skyMat.uniforms.bottomColor.value.copy(bottom);

  sky.position.copy(focusPos);

  if (!scene.fog) scene.fog = new THREE.Fog(bottom.getHex(), 40, 210);
  scene.fog.color.copy(bottom);
  scene.fog.near = lerp(30, 55, dayFactor);
  scene.fog.far = lerp(140, 230, dayFactor);

  hemiLight.intensity = lerp(0.12, 0.65, dayFactor);
  hemiLight.color.copy(top).lerp(new THREE.Color(0xffffff), 0.2);
  ambient.intensity = lerp(0.18, 0.32, dayFactor);

  sunLight.intensity = Math.max(sunDirVec.y, 0) * 1.5 * (0.4 + horizonFactor * 0.6);
  sunLight.color.copy(new THREE.Color().lerpColors(new THREE.Color(0xffcf9e), new THREE.Color(0xffffff), dayFactor));
  sunLight.position.copy(focusPos).addScaledVector(sunDirVec, 120);
  sunLight.target.position.copy(focusPos);
  sunLight.target.updateMatrixWorld();

  sunMesh.position.copy(focusPos).addScaledVector(sunDirVec, 300);
  moonMesh.position.copy(focusPos).addScaledVector(sunDirVec, -300);
  sunMesh.visible = sunDirVec.y > -0.15;
  moonMesh.visible = sunDirVec.y < 0.2;

  stars.material.opacity = (1 - dayFactor) * 0.85;
  stars.position.copy(focusPos);

  return t;
}

/* ------------------------------------------------------------------ terrain */

const colliders = []; // { x, z, radius }

function buildTerrain() {
  const size = WORLD_RADIUS * 2;
  const segments = 140;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(0x4c7a3a);
  const grassDry = new THREE.Color(0x8a9a4c);
  const rock = new THREE.Color(0x716a63);
  const snow = new THREE.Color(0xf1f5fb);
  const path = new THREE.Color(0xa98a63);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);

    const n = terrainNormalAt(x, z);
    const slope = 1 - n.y;
    const distVillage = Math.hypot(x - VILLAGE_POS.x, z - VILLAGE_POS.z);

    const c = new THREE.Color();
    if (y > 24) c.lerpColors(rock, snow, smoothstep(24, 34, y));
    else if (slope > 0.35) c.lerpColors(grass, rock, smoothstep(0.35, 0.75, slope));
    else c.lerpColors(grassDry, grass, smoothstep(-6, 10, y));

    if (distVillage < 16) {
      const pathMix = smoothstep(16, 3, distVillage) * 0.5;
      c.lerp(path, pathMix);
    }

    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  scene.add(mesh);

  // still water in low basins
  const waterGeo = new THREE.CircleGeometry(20, 32);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({
    color: 0x2f6f8f, transparent: true, opacity: 0.75, shininess: 90,
  }));
  water.position.set(-30, -6.6, 40);
  scene.add(water);

  return mesh;
}

/* ------------------------------------------------------------------- decor */

function scatterInstances({ geometries, materials, count, place, colorRange }) {
  const meshes = geometries.map((geo, gi) => {
    const m = new THREE.InstancedMesh(geo, materials[gi], count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m);
    return m;
  });
  const dummy = new THREE.Object3D();
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 8) {
    attempts++;
    const info = place();
    if (!info) continue;
    const { x, z, y, scale, rot } = info;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    meshes.forEach((m) => m.setMatrixAt(placed, dummy.matrix));
    if (colorRange && meshes[0].setColorAt) {
      const c = new THREE.Color().lerpColors(colorRange[0], colorRange[1], Math.random());
      meshes.forEach((m) => m.setColorAt && m.setColorAt(placed, c));
    }
    placed++;
  }
  meshes.forEach((m) => {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.count = placed;
  });
  return meshes;
}

const noGoZones = [
  { x: VILLAGE_POS.x, z: VILLAGE_POS.z, r: 22 },
  { x: KEEP_POS.x, z: KEEP_POS.z, r: 26 },
  { x: -30, z: 40, r: 22 }, // lake
];
function inNoGoZone(x, z) {
  return noGoZones.some((z2) => Math.hypot(x - z2.x, z - z2.z) < z2.r);
}

function buildTrees() {
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 3.2, 6);
  trunkGeo.translate(0, 1.6, 0);
  const canopyGeo = new THREE.ConeGeometry(1.9, 4.2, 7);
  canopyGeo.translate(0, 4.6, 0);

  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5b4330 });
  const canopyMatInst = new THREE.MeshLambertMaterial({ color: 0xffffff }); // per-instance color applied via setColorAt

  const meshes = scatterInstances({
    geometries: [trunkGeo, canopyGeo],
    materials: [trunkMat, canopyMatInst],
    count: 170,
    colorRange: [new THREE.Color(0x2f5a30), new THREE.Color(0x5c7a3a)],
    place: () => {
      const x = randRange(-WORLD_RADIUS + 4, WORLD_RADIUS - 4);
      const z = randRange(-WORLD_RADIUS + 4, WORLD_RADIUS - 4);
      if (inNoGoZone(x, z)) return null;
      const y = terrainHeight(x, z);
      if (y < -5.5 || y > 22) return null;
      const scale = randRange(0.7, 1.5);
      colliders.push({ x, z, radius: 0.6 * scale });
      return { x, z, y, scale, rot: Math.random() * Math.PI * 2 };
    },
  });
  return meshes;
}

function buildRocks() {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0x7d766c, flatShading: true });
  scatterInstances({
    geometries: [geo],
    materials: [mat],
    count: 70,
    place: () => {
      const x = randRange(-WORLD_RADIUS + 4, WORLD_RADIUS - 4);
      const z = randRange(-WORLD_RADIUS + 4, WORLD_RADIUS - 4);
      if (inNoGoZone(x, z)) return null;
      const y = terrainHeight(x, z);
      const scale = randRange(0.6, 2.4);
      colliders.push({ x, z, radius: 0.75 * scale });
      return { x, z, y: y + scale * 0.3, scale, rot: Math.random() * Math.PI * 2 };
    },
  });
}

function box(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}
function cone(r, h, color, x, y, z, rotY = 0) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  return m;
}

function buildHut(x, z, rotY = 0) {
  const group = new THREE.Group();
  const base = terrainHeight(x, z);
  group.position.set(x, base, z);
  group.rotation.y = rotY;
  group.add(box(4.4, 2.6, 4, 0xcac2a8, 0, 1.3, 0));
  group.add(cone(3.4, 2.4, 0x7a3a30, 0, 3.6, 0));
  group.add(box(1.2, 1.8, 0.2, 0x4a3524, 0, 0.9, 2.02));
  scene.add(group);
  colliders.push({ x, z, radius: 2.6 });
  return group;
}

function buildKeep() {
  const group = new THREE.Group();
  const base = terrainHeight(KEEP_POS.x, KEEP_POS.z);
  group.position.set(KEEP_POS.x, base, KEEP_POS.z);
  scene.add(group);

  const stone = 0x5c5a5e;
  group.add(box(10, 14, 10, stone, 0, 7, 0));
  group.add(cone(8, 5, 0x40424a, 0, 16.5, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    group.add(box(1.6, 15.5, 1.6, 0x4a484c, Math.cos(a) * 6, 7.7, Math.sin(a) * 6));
  }
  // ring wall
  const wallR = 18;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    if (i === 3 || i === 4) continue; // gate gap
    const wx = Math.cos(a) * wallR, wz = Math.sin(a) * wallR;
    const w = box(3.4, 3.4, 1, 0x565258, wx, 1.7, wz);
    w.rotation.y = a;
    group.add(w);
    colliders.push({ x: KEEP_POS.x + wx, z: KEEP_POS.z + wz, radius: 1.9 });
  }
  colliders.push({ x: KEEP_POS.x, z: KEEP_POS.z, radius: 6 });
  return group;
}

function buildChestMesh() {
  const g = new THREE.Group();
  g.add(box(1.1, 0.6, 0.7, 0x6b4a2b, 0, 0.3, 0));
  const lid = box(1.15, 0.3, 0.75, 0x7a5734, 0, 0.75, -0.02);
  lid.name = 'lid';
  g.add(lid);
  g.add(box(0.18, 0.22, 0.1, 0xd9b34a, 0, 0.62, 0.36));
  return g;
}

const WELL_POS = new THREE.Vector3(VILLAGE_POS.x + 6, 0, VILLAGE_POS.z + 5);

function buildWell() {
  const g = new THREE.Group();
  const y = terrainHeight(WELL_POS.x, WELL_POS.z);
  g.position.set(WELL_POS.x, y, WELL_POS.z);
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 1, 10), new THREE.MeshLambertMaterial({ color: 0x716a63 })));
  g.position.y += 0.5;
  scene.add(g);
  colliders.push({ x: WELL_POS.x, z: WELL_POS.z, radius: 1.6 });
}

/* ------------------------------------------------------------- characters */

function buildHumanoid({ skin = 0xd9b18a, cloth = 0x4a5a7a, cloak = null, weapon = true, scale = 1 } = {}) {
  const group = new THREE.Group();
  const clothMat = new THREE.MeshLambertMaterial({ color: cloth });
  const skinMat = new THREE.MeshLambertMaterial({ color: skin });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.8, 0.36), clothMat);
  torso.position.y = 1.05;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.4), skinMat);
  head.position.y = 1.68;
  group.add(head);

  const hip = new THREE.Group();
  hip.position.y = 0.62;
  group.add(hip);

  const legGeo = new THREE.BoxGeometry(0.24, 0.72, 0.26);
  const legL = new THREE.Mesh(legGeo, clothMat.clone());
  legL.geometry.translate(0, -0.36, 0);
  legL.position.set(0.16, 0, 0);
  const legR = legL.clone();
  legR.position.set(-0.16, 0, 0);
  hip.add(legL, legR);

  const shoulder = new THREE.Group();
  shoulder.position.y = 1.35;
  group.add(shoulder);

  const armGeo = new THREE.BoxGeometry(0.2, 0.66, 0.22);
  const armL = new THREE.Mesh(armGeo, skinMat.clone());
  armL.geometry.translate(0, -0.33, 0);
  armL.position.set(0.42, 0, 0);
  const armR = armL.clone();
  armR.position.set(-0.42, 0, 0);
  shoulder.add(armL, armR);

  let weaponMesh = null;
  if (weapon) {
    weaponMesh = new THREE.Group();
    const blade = box(0.06, 0.72, 0.14, 0xdfe6ee, 0, -0.6, 0);
    const hilt = box(0.1, 0.18, 0.1, 0x5a3d24, 0, -0.16, 0);
    weaponMesh.add(blade, hilt);
    weaponMesh.position.set(0, -0.1, 0);
    armR.add(weaponMesh);
  }

  let cloakMesh = null;
  if (cloak) {
    cloakMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.1), new THREE.MeshLambertMaterial({ color: cloak }));
    cloakMesh.position.set(0, 1.0, 0.2);
    group.add(cloakMesh);
  }

  group.scale.setScalar(scale);
  scene.add(group);
  return { group, head, hip, shoulder, legL, legR, armL, armR, weaponMesh };
}

function buildWolf(scale = 1) {
  const group = new THREE.Group();
  const furMat = new THREE.MeshLambertMaterial({ color: 0x555a5f });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 0.45), furMat);
  body.position.y = 0.55;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.36, 0.4), furMat);
  head.position.set(0.68, 0.62, 0);
  group.add(head);
  const snout = box(0.26, 0.16, 0.18, 0x3a3d40, 0.9, 0.55, 0);
  group.add(snout);
  const tail = box(0.12, 0.12, 0.5, furMat.color.getHex(), -0.64, 0.62, 0);
  group.add(tail);

  const legGeo = new THREE.BoxGeometry(0.14, 0.5, 0.16);
  legGeo.translate(0, -0.25, 0);
  const legs = [];
  const offs = [
    [0.4, 0.18], [0.4, -0.18], [-0.4, 0.18], [-0.4, -0.18],
  ];
  for (const [lx, lz] of offs) {
    const leg = new THREE.Mesh(legGeo, furMat.clone());
    leg.position.set(lx, 0.5, lz);
    group.add(leg);
    legs.push(leg);
  }
  group.scale.setScalar(scale);
  scene.add(group);
  return { group, head, tail, legs };
}

/* ------------------------------------------------------------- effects fx */

const transientFx = [];
function spawnRing(pos, color, maxScale = 3, life = 0.4) {
  const geo = new THREE.RingGeometry(0.15, 0.3, 20);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  transientFx.push({
    mesh, life, maxLife: life,
    update(dt, t) {
      const p = 1 - t / life;
      mesh.scale.setScalar(lerp(0.4, maxScale, 1 - p));
      mat.opacity = p * 0.9;
    },
  });
}
function spawnSpark(pos, color) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }));
  mesh.position.copy(pos);
  scene.add(mesh);
  transientFx.push({
    mesh, life: 0.25, maxLife: 0.25,
    update(dt, t) {
      const p = 1 - t / 0.25;
      mesh.scale.setScalar(lerp(0.4, 1.6, 1 - p));
      mesh.material.opacity = p;
    },
  });
}
function updateFx(dt) {
  for (let i = transientFx.length - 1; i >= 0; i--) {
    const fx = transientFx[i];
    fx.life -= dt;
    fx.update(dt, fx.life);
    if (fx.life <= 0) {
      scene.remove(fx.mesh);
      fx.mesh.geometry.dispose();
      fx.mesh.material.dispose();
      transientFx.splice(i, 1);
    }
  }
}

/* ------------------------------------------------------------------- hud */

const hud = {
  el: document.getElementById('hud'),
  boot: document.getElementById('boot'),
  bootFill: document.getElementById('bootFill'),
  bootHint: document.getElementById('bootHint'),
  title: document.getElementById('title'),
  healthFill: document.getElementById('healthFill'),
  staminaFill: document.getElementById('staminaFill'),
  magickaFill: document.getElementById('magickaFill'),
  levelNum: document.getElementById('levelNum'),
  xpFill: document.getElementById('xpFill'),
  questText: document.getElementById('questText'),
  toasts: document.getElementById('toasts'),
  minimap: document.getElementById('minimap'),
  interact: document.getElementById('interact'),
  compassTape: document.getElementById('compassTape'),
  pauseMenu: document.getElementById('pauseMenu'),
  statList: document.getElementById('statList'),
  endMenu: document.getElementById('endMenu'),
  endTitle: document.getElementById('endTitle'),
  endText: document.getElementById('endText'),
  btnShout: document.getElementById('btnShout'),

  setVital(which, pct) {
    this[`${which}Fill`].style.width = `${clamp(pct, 0, 1) * 100}%`;
  },
  setLevel(n) { this.levelNum.textContent = n; },
  setXp(pct) { this.xpFill.style.width = `${clamp(pct, 0, 1) * 100}%`; },
  setQuest(text) { this.questText.textContent = text; },
  showInteract(show, label) {
    this.interact.hidden = !show;
    if (show && label) this.interact.textContent = label;
  },
  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  },
};

const CARDINALS = [
  { deg: 0, label: 'N', card: true }, { deg: 45, label: 'NE' }, { deg: 90, label: 'E', card: true },
  { deg: 135, label: 'SE' }, { deg: 180, label: 'S', card: true }, { deg: 225, label: 'SW' },
  { deg: 270, label: 'W', card: true }, { deg: 315, label: 'NW' }, { deg: 360, label: 'N', card: true },
];
function buildCompassTape() {
  const frag = document.createDocumentFragment();
  for (let deg = -360; deg <= 720; deg += 15) {
    const norm = ((deg % 360) + 360) % 360;
    const found = CARDINALS.find((c) => Math.abs(c.deg - norm) < 1 || Math.abs(c.deg - norm - 360) < 1);
    const span = document.createElement('span');
    span.textContent = found ? found.label : '·';
    if (found?.card) span.classList.add('cardinal');
    span.style.position = 'absolute';
    span.style.left = `calc(50% + ${(deg / 15) * 60}px)`;
    frag.appendChild(span);
  }
  hud.compassTape.appendChild(frag);
}
buildCompassTape();
function updateCompass(yawDeg) {
  hud.compassTape.style.transform = `translateX(${-(yawDeg / 15) * 60}px)`;
}

const mmCtx = hud.minimap.getContext('2d');
function drawMinimap(player, enemies, pois) {
  const size = 140, r = size / 2;
  mmCtx.clearRect(0, 0, size, size);
  mmCtx.save();
  mmCtx.beginPath();
  mmCtx.arc(r, r, r - 2, 0, Math.PI * 2);
  mmCtx.clip();
  mmCtx.fillStyle = 'rgba(20,30,48,0.55)';
  mmCtx.fillRect(0, 0, size, size);

  const scale = 0.9;
  const cos = Math.cos(-player.yaw), sin = Math.sin(-player.yaw);
  const project = (wx, wz) => {
    const dx = wx - player.group.position.x;
    const dz = wz - player.group.position.z;
    const rx = dx * cos - dz * sin;
    const rz = dx * sin + dz * cos;
    return [r + rx * scale, r - rz * scale];
  };

  for (const poi of pois) {
    const [px, py] = project(poi.x, poi.z);
    if (Math.hypot(px - r, py - r) > r - 4) continue;
    mmCtx.fillStyle = poi.color;
    mmCtx.beginPath();
    mmCtx.arc(px, py, 3.4, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const e of enemies) {
    if (e.dead) continue;
    const [px, py] = project(e.group.position.x, e.group.position.z);
    if (Math.hypot(px - r, py - r) > r - 4) continue;
    mmCtx.fillStyle = '#d94b4b';
    mmCtx.beginPath();
    mmCtx.arc(px, py, 3, 0, Math.PI * 2);
    mmCtx.fill();
  }

  mmCtx.fillStyle = '#8fe3b0';
  mmCtx.beginPath();
  mmCtx.moveTo(r, r - 6);
  mmCtx.lineTo(r - 5, r + 5);
  mmCtx.lineTo(r + 5, r + 5);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.restore();

  mmCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  mmCtx.beginPath();
  mmCtx.arc(r, r, r - 2, 0, Math.PI * 2);
  mmCtx.stroke();
}

/* ------------------------------------------------------------------ input */

const input = {
  moveX: 0, moveY: 0,
  lookDX: 0, lookDY: 0,
  jump: false, attack: false, shout: false,
  keys: new Set(),
};

function setupJoystick() {
  const base = document.getElementById('stickMove');
  const nub = document.getElementById('stickMoveNub');
  let activeId = null;
  const radius = 44;

  function handleMove(clientX, clientY) {
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx, dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    input.moveX = dx / radius;
    input.moveY = -dy / radius;
  }
  function reset() {
    nub.style.transform = 'translate(0px, 0px)';
    input.moveX = 0; input.moveY = 0;
    activeId = null;
  }
  base.addEventListener('pointerdown', (e) => {
    activeId = e.pointerId;
    base.setPointerCapture(e.pointerId);
    handleMove(e.clientX, e.clientY);
    e.preventDefault();
  });
  base.addEventListener('pointermove', (e) => {
    if (activeId !== e.pointerId) return;
    handleMove(e.clientX, e.clientY);
    e.preventDefault();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    base.addEventListener(ev, (e) => { if (activeId === e.pointerId) reset(); })
  );
}

function setupLook() {
  let activeId = null;
  let lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    if (e.clientX < window.innerWidth * 0.32) return; // leave room for joystick
    activeId = e.pointerId;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (activeId !== e.pointerId) return;
    input.lookDX += e.clientX - lastX;
    input.lookDY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
  });
  ['pointerup', 'pointercancel'].forEach((ev) =>
    canvas.addEventListener(ev, (e) => { if (activeId === e.pointerId) activeId = null; })
  );
}

function setupButtons(game) {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  };
  bind('btnJump', () => (input.jump = true));
  bind('btnAttack', () => (input.attack = true));
  bind('btnShout', () => (input.shout = true));
  bind('btnPause', () => game.togglePause());
  bind('btnResume', () => game.togglePause());
  bind('btnRestart', () => game.restart());
  bind('btnAgain', () => game.restart());
  bind('btnPlay', () => game.start());
  document.getElementById('interact').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    game.tryInteract();
  });

  window.addEventListener('keydown', (e) => {
    input.keys.add(e.code);
    if (e.code === 'Space') input.jump = true;
    if (e.code === 'KeyF' || e.code === 'Enter') input.attack = true;
    if (e.code === 'KeyQ') input.shout = true;
    if (e.code === 'Escape') game.togglePause();
    if (e.code === 'KeyE') game.tryInteract();
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
}

function keyboardAxes() {
  let x = 0, y = 0;
  if (input.keys.has('KeyA') || input.keys.has('ArrowLeft')) x -= 1;
  if (input.keys.has('KeyD') || input.keys.has('ArrowRight')) x += 1;
  if (input.keys.has('KeyW') || input.keys.has('ArrowUp')) y += 1;
  if (input.keys.has('KeyS') || input.keys.has('ArrowDown')) y -= 1;
  return [x, y];
}

/* ------------------------------------------------------------------ player */

const STATS_BASE = { maxHealth: 100, maxStamina: 100, maxMagicka: 100, damage: 18 };

class Player {
  constructor() {
    const model = buildHumanoid({ skin: 0xe0b48f, cloth: 0x3d4f68, cloak: 0x28324a, weapon: true });
    Object.assign(this, model);
    this.group.position.copy(VILLAGE_POS).setY(terrainHeight(VILLAGE_POS.x, VILLAGE_POS.z));
    this.yaw = Math.PI;
    this.velY = 0;
    this.onGround = true;
    this.walkPhase = 0;
    this.attackTimer = 0;
    this.attackCooldown = 0;
    this.shoutTimer = 0;
    this.shoutCooldown = 0;
    this.hitFlash = 0;
    this.pendingHitCheck = false;
    this.pendingShout = false;

    this.level = 1;
    this.xp = 0;
    this.xpToNext = 40;
    this.gold = 0;
    this.stats = { ...STATS_BASE };
    this.health = this.stats.maxHealth;
    this.stamina = this.stats.maxStamina;
    this.magicka = this.stats.maxMagicka;

    this.speed = 6.2;
    this.dead = false;
  }

  addXp(amount) {
    this.xp += amount;
    hud.toast(`+${amount} XP`);
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = Math.round(this.xpToNext * 1.35);
      this.stats.maxHealth += 18;
      this.stats.maxStamina += 8;
      this.stats.maxMagicka += 8;
      this.stats.damage += 4;
      this.health = this.stats.maxHealth;
      this.stamina = this.stats.maxStamina;
      hud.toast(`Level Up! You are now level ${this.level}`);
    }
  }

  addGold(amount) {
    this.gold += amount;
    hud.toast(`+${amount} Gold`);
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health -= amount;
    this.hitFlash = 0.25;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }

  update(dt, cameraYaw) {
    if (this.dead) return;

    const [kx, ky] = keyboardAxes();
    const mx = clamp(input.moveX + kx, -1, 1);
    const my = clamp(input.moveY + ky, -1, 1);
    const moveMag = clamp(Math.hypot(mx, my), 0, 1);

    const forward = new THREE.Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
    const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
    const moveDir = new THREE.Vector3()
      .addScaledVector(forward, my)
      .addScaledVector(right, mx);

    if (moveMag > 0.02) {
      moveDir.normalize();
      const targetYaw = Math.atan2(moveDir.x, moveDir.z);
      let diff = targetYaw - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += diff * clamp(dt * 10, 0, 1);
    }

    const speed = this.speed * moveMag;
    const nextX = this.group.position.x + moveDir.x * speed * dt;
    const nextZ = this.group.position.z + moveDir.z * speed * dt;

    const curX = this.group.position.x, curZ = this.group.position.z;
    let blocked = false;
    for (const c of colliders) {
      const nextDist = Math.hypot(nextX - c.x, nextZ - c.z);
      if (nextDist < c.radius + 0.5) {
        const curDist = Math.hypot(curX - c.x, curZ - c.z);
        if (nextDist <= curDist) { blocked = true; break; } // never block a move that escapes an overlap
      }
    }
    if (!blocked) {
      this.group.position.x = nextX;
      this.group.position.z = nextZ;
    }

    const distFromCenter = Math.hypot(this.group.position.x, this.group.position.z);
    if (distFromCenter > BOUND_RADIUS) {
      const k = BOUND_RADIUS / distFromCenter;
      this.group.position.x *= k;
      this.group.position.z *= k;
    }

    const groundY = terrainHeight(this.group.position.x, this.group.position.z);
    if (input.jump && this.onGround) {
      this.velY = 5.6;
      this.onGround = false;
    }
    input.jump = false;
    this.velY -= 15 * dt;
    this.group.position.y += this.velY * dt;
    if (this.group.position.y <= groundY) {
      this.group.position.y = groundY;
      this.velY = 0;
      this.onGround = true;
    }

    this.group.rotation.y = this.yaw;

    this.stamina = clamp(this.stamina + (moveMag > 0.1 ? -3 : 10) * dt, 0, this.stats.maxStamina);
    this.magicka = clamp(this.magicka + 5 * dt, 0, this.stats.maxMagicka);
    if (!this.dead && this.health < this.stats.maxHealth && moveMag < 0.1) {
      this.health = clamp(this.health + 2 * dt, 0, this.stats.maxHealth);
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.shoutCooldown = Math.max(0, this.shoutCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    if (input.attack) {
      input.attack = false;
      if (this.attackCooldown <= 0 && this.stamina >= 12) {
        this.stamina -= 12;
        this.attackTimer = 0.38;
        this.attackCooldown = 0.5;
        this.pendingHitCheck = true;
      }
    }
    if (input.shout) {
      input.shout = false;
      if (this.shoutCooldown <= 0 && this.magicka >= 60) {
        this.magicka -= 60;
        this.shoutTimer = 0.6;
        this.shoutCooldown = 3;
        this.pendingShout = true;
      }
    }

    this.animate(dt, moveMag);
  }

  animate(dt, moveMag) {
    if (this.attackTimer > 0) {
      this.attackTimer -= dt;
      const p = 1 - clamp(this.attackTimer / 0.38, 0, 1);
      this.shoulder.rotation.x = -Math.sin(p * Math.PI) * 1.9;
      this.hip.rotation.x = 0;
    } else if (this.shoutTimer > 0) {
      this.shoutTimer -= dt;
      const p = 1 - clamp(this.shoutTimer / 0.6, 0, 1);
      this.shoulder.rotation.x = -0.6 - Math.sin(p * Math.PI) * 0.5;
    } else {
      this.walkPhase += dt * moveMag * 9 + dt * 0.6;
      const amp = moveMag > 0.05 ? 0.6 : 0.06;
      this.hip.rotation.x = Math.sin(this.walkPhase) * amp;
      this.shoulder.rotation.x = -Math.sin(this.walkPhase) * amp * 0.8;
      this.legL.rotation.x = -Math.sin(this.walkPhase) * amp;
      this.legR.rotation.x = Math.sin(this.walkPhase) * amp;
      this.armL.rotation.x = Math.sin(this.walkPhase) * amp * 0.9;
      this.armR.rotation.x = -Math.sin(this.walkPhase) * amp * 0.9;
    }
    if (!this.onGround) {
      this.hip.rotation.x = 0.3;
    }
  }
}

/* ------------------------------------------------------------------ enemy */

class Enemy {
  constructor({ pos, kind, health, damage, speed, xp, gold, aggro = 26, attackRange = 1.7 }) {
    this.kind = kind;
    this.model = kind === 'wolf' ? buildWolf(1) : buildHumanoid({ skin: 0x8a9a8a, cloth: 0x53504a, weapon: kind !== 'elder' });
    this.group = this.model.group;
    this.group.position.copy(pos).setY(terrainHeight(pos.x, pos.z));
    this.home = pos.clone();
    this.wanderTarget = pos.clone();
    this.wanderTimer = randRange(0, 3);
    this.maxHealth = health;
    this.health = health;
    this.damage = damage;
    this.speed = speed;
    this.xp = xp;
    this.gold = gold;
    this.aggro = aggro;
    this.attackRange = attackRange;
    this.attackTimer = 0;
    this.dead = false;
    this.deadTimer = 0;
    this.knockback = new THREE.Vector3();
    this.hitFlash = 0;
    this.phase = Math.random() * 10;

    for (const mesh of this.group.children) {
      mesh.traverse?.((m) => {
        if (m.isMesh) m.material = m.material.clone();
      });
    }
  }

  takeDamage(amount, sourcePos) {
    if (this.dead) return;
    this.health -= amount;
    this.hitFlash = 0.2;
    const dir = new THREE.Vector3().subVectors(this.group.position, sourcePos).setY(0).normalize();
    this.knockback.copy(dir).multiplyScalar(6);
    if (this.health <= 0) this.die();
  }

  knockOut(dir, force) {
    if (this.dead) return;
    this.knockback.copy(dir).multiplyScalar(force);
    this.knockback.y = force * 0.4;
  }

  die() {
    this.dead = true;
    this.deadTimer = 1.1;
  }

  update(dt, player, enemies) {
    if (this.dead) {
      this.deadTimer -= dt;
      this.group.position.y -= dt * 0.6;
      this.group.rotation.z = lerp(this.group.rotation.z, Math.PI / 2, dt * 3);
      this.group.scale.setScalar(Math.max(0, this.group.scale.x - dt * 0.3));
      return this.deadTimer <= 0;
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.attackTimer = Math.max(0, this.attackTimer - dt);

    if (this.knockback.lengthSq() > 0.001) {
      this.group.position.addScaledVector(this.knockback, dt);
      this.knockback.multiplyScalar(Math.max(0, 1 - dt * 4));
    }

    const distToPlayer = this.group.position.distanceTo(player.group.position);
    let targetPos = null;

    if (distToPlayer < this.aggro && !player.dead) {
      targetPos = player.group.position;
      this.state = distToPlayer < this.attackRange ? 'attack' : 'chase';
    } else {
      this.state = 'wander';
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = randRange(2.5, 5);
        const a = Math.random() * Math.PI * 2;
        const d = randRange(2, 9);
        this.wanderTarget.set(this.home.x + Math.cos(a) * d, 0, this.home.z + Math.sin(a) * d);
      }
      targetPos = this.wanderTarget;
    }

    if (this.state !== 'attack' && targetPos) {
      const dir = new THREE.Vector3().subVectors(targetPos, this.group.position).setY(0);
      const dist = dir.length();
      if (dist > 0.3) {
        dir.normalize();
        const spd = this.state === 'chase' ? this.speed : this.speed * 0.45;
        const nx = this.group.position.x + dir.x * spd * dt;
        const nz = this.group.position.z + dir.z * spd * dt;
        let blocked = false;
        for (const c of colliders) {
          if (Math.hypot(nx - c.x, nz - c.z) < c.radius + 0.6) { blocked = true; break; }
        }
        if (!blocked) {
          this.group.position.x = nx;
          this.group.position.z = nz;
        }
        const targetYaw = Math.atan2(dir.x, dir.z);
        this.group.rotation.y = damp(this.group.rotation.y, targetYaw, 6, dt);
      }
    } else if (this.state === 'attack') {
      const dir = new THREE.Vector3().subVectors(player.group.position, this.group.position).setY(0).normalize();
      const targetYaw = Math.atan2(dir.x, dir.z);
      this.group.rotation.y = damp(this.group.rotation.y, targetYaw, 6, dt);
      if (this.attackTimer <= 0) {
        this.attackTimer = 1.3;
        player.takeDamage(this.damage);
        spawnSpark(player.group.position.clone().setY(player.group.position.y + 1.2), 0xd94b4b);
      }
    }

    this.group.position.y = terrainHeight(this.group.position.x, this.group.position.z);

    this.phase += dt * (this.state === 'wander' ? 3 : 7);
    if (this.kind === 'wolf') {
      const amp = this.state === 'wander' ? 0.25 : 0.55;
      this.model.legs.forEach((leg, i) => {
        leg.rotation.x = Math.sin(this.phase + (i % 2 === 0 ? 0 : Math.PI)) * amp;
      });
      this.model.tail.rotation.y = Math.sin(this.phase * 0.5) * 0.3;
    } else {
      const amp = this.state === 'wander' ? 0.3 : 0.5;
      this.model.legL.rotation.x = -Math.sin(this.phase) * amp;
      this.model.legR.rotation.x = Math.sin(this.phase) * amp;
      if (this.state === 'attack') {
        this.model.shoulder.rotation.x = -Math.sin(this.attackTimer * 4) * 0.8;
      } else {
        this.model.armL.rotation.x = Math.sin(this.phase) * amp * 0.6;
        this.model.armR.rotation.x = -Math.sin(this.phase) * amp * 0.6;
      }
    }

    if (this.hitFlash > 0) {
      this.group.traverse((m) => {
        if (m.isMesh) m.material.emissive?.setRGB(0.6, 0.1, 0.1);
      });
    } else {
      this.group.traverse((m) => {
        if (m.isMesh) m.material.emissive?.setRGB(0, 0, 0);
      });
    }

    return false;
  }
}

/* ---------------------------------------------------------------- quests */

class QuestManager {
  constructor() {
    this.wolfKills = 0;
    this.wolfTarget = 3;
    this.stage = 0;
    this.stages = [
      { text: 'Find the Elder in Frosthold village' },
      { text: `Slay the dire wolves menacing the vale (0/${this.wolfTarget})` },
      { text: 'Defeat the guardian and open the chest at the Ruined Keep' },
      { text: 'Frosthold is safe. Explore freely, wanderer.' },
    ];
    hud.setQuest(this.stages[0].text);
  }
  advance() {
    this.stage++;
    if (this.stage < this.stages.length) hud.setQuest(this.stages[this.stage].text);
  }
  onWolfKilled() {
    if (this.stage !== 1) return;
    this.wolfKills++;
    hud.setQuest(`Slay the dire wolves menacing the vale (${Math.min(this.wolfKills, this.wolfTarget)}/${this.wolfTarget})`);
    if (this.wolfKills >= this.wolfTarget) {
      hud.toast('Quest Updated');
      this.advance();
    }
  }
  onGuardianDefeated() {
    if (this.stage === 2) hud.toast('The guardian falls! The chest awaits.');
  }
  onChestOpened() {
    if (this.stage === 2) {
      this.advance();
      hud.toast('Quest Complete — Blessing of Frosthold!');
    }
  }
}

/* -------------------------------------------------------------- the game */

class Game {
  constructor() {
    this.clock = new THREE.Clock();
    this.state = 'boot';
    this.camYaw = Math.PI;
    this.camPitch = 0.28;
    this.camDist = 6.5;
    const tParam = parseFloat(new URLSearchParams(location.search).get('t'));
    this.elapsed = (Number.isFinite(tParam) ? clamp(tParam, 0, 1) : 0.32) * DAY_LENGTH;

    this.buildWorld();
    this.player = new Player();
    this.enemies = [];
    this.interactables = [];
    this.quests = new QuestManager();
    this.spawnEnemies();
    this.spawnInteractables();

    setupJoystick();
    setupLook();
    setupButtons(this);

    this.runBoot();
  }

  buildWorld() {
    buildTerrain();
    buildTrees();
    buildRocks();
    buildWell();
    buildHut(-8, 8, 0.4);
    buildHut(10, 14, -0.6);
    buildHut(2, 20, 2.4);
    buildKeep();
  }

  spawnEnemies() {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const pos = new THREE.Vector3(WOLF_DEN_POS.x + Math.cos(a) * 8, 0, WOLF_DEN_POS.z + Math.sin(a) * 8);
      this.enemies.push(new Enemy({ pos, kind: 'wolf', health: 34, damage: 7, speed: 4.6, xp: 20, gold: 5, aggro: 22, attackRange: 1.6 }));
    }
    const guardPos = new THREE.Vector3(KEEP_POS.x, 0, KEEP_POS.z - 4);
    this.boss = new Enemy({ pos: guardPos, kind: 'draugr', health: 140, damage: 16, speed: 3.6, xp: 120, gold: 60, aggro: 24, attackRange: 2 });
    this.boss.group.scale.setScalar(1.25);
    this.enemies.push(this.boss);
  }

  spawnInteractables() {
    const elderY = terrainHeight(ELDER_POS.x, ELDER_POS.z);
    const elder = buildHumanoid({ skin: 0xc9ab86, cloth: 0x6a5a3a, cloak: 0x3a3020, weapon: false, scale: 1 });
    elder.group.position.set(ELDER_POS.x, elderY, ELDER_POS.z);
    this.interactables.push({
      position: elder.group.position, radius: 3, label: 'Talk to the Elder', used: false,
      onInteract: () => {
        if (this.quests.stage !== 0) { hud.toast('The Elder has nothing more to say... yet.'); return; }
        hud.toast('Elder: "Dire wolves plague our flocks. Slay them, wanderer."');
        this.quests.advance();
      },
    });

    const chest = buildChestMesh();
    const chestPos = new THREE.Vector3(KEEP_POS.x + 2, 0, KEEP_POS.z + 2);
    chestPos.y = terrainHeight(chestPos.x, chestPos.z);
    chest.position.copy(chestPos);
    scene.add(chest);
    this.chest = chest;
    this.interactables.push({
      position: chestPos, radius: 2.4, label: 'Open Chest', used: false,
      onInteract: (self) => {
        if (self.used) return;
        if (!this.boss.dead) { hud.toast('The guardian still stands watch...'); return; }
        self.used = true;
        chest.getObjectByName('lid').rotation.x = -1.3;
        this.player.addGold(60);
        this.player.stats.maxHealth += 20;
        this.player.health = this.player.stats.maxHealth;
        hud.toast('You found the Amulet of Frosthold!');
        this.quests.onChestOpened();
      },
    });

    this.poiMarkers = [
      { x: ELDER_POS.x, z: ELDER_POS.z, color: '#ffd27a' },
      { x: WOLF_DEN_POS.x, z: WOLF_DEN_POS.z, color: '#d94b4b' },
      { x: KEEP_POS.x, z: KEEP_POS.z, color: '#8fe3b0' },
      { x: chestPos.x, z: chestPos.z, color: '#d9b34a' },
    ];
  }

  runBoot() {
    const hints = ['stoking the hearth…', 'sharpening blades…', 'waking the wolves…', 'lighting the beacons…'];
    let p = 0;
    const iv = setInterval(() => {
      p += randRange(8, 22);
      hud.bootFill.style.width = `${Math.min(p, 100)}%`;
      hud.bootHint.textContent = choice(hints);
      if (p >= 100) {
        clearInterval(iv);
        hud.boot.hidden = true;
        hud.title.hidden = false;
        if (new URLSearchParams(location.search).has('autoplay')) this.start();
      }
    }, 160);
  }

  start() {
    hud.title.hidden = true;
    hud.el.hidden = false;
    this.state = 'playing';
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    this.clock.start();
    requestAnimationFrame(this.loop.bind(this));
  }

  restart() {
    location.reload();
  }

  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      hud.pauseMenu.hidden = false;
      hud.statList.innerHTML = `
        <li>Level <span>${this.player.level}</span></li>
        <li>Gold <span>${this.player.gold}</span></li>
        <li>Health <span>${Math.ceil(this.player.health)}/${this.player.stats.maxHealth}</span></li>
        <li>Damage <span>${this.player.stats.damage}</span></li>`;
    } else if (this.state === 'paused') {
      this.state = 'playing';
      hud.pauseMenu.hidden = true;
    }
  }

  tryInteract() {
    if (!this.nearestInteractable) return;
    this.nearestInteractable.onInteract(this.nearestInteractable);
  }

  handlePlayerAttack() {
    if (!this.player.pendingHitCheck) return;
    this.player.pendingHitCheck = false;
    const p = this.player.group.position;
    const facing = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));
    for (const e of this.enemies) {
      if (e.dead) continue;
      const toEnemy = new THREE.Vector3().subVectors(e.group.position, p).setY(0);
      const dist = toEnemy.length();
      if (dist > 2.6) continue;
      toEnemy.normalize();
      if (facing.dot(toEnemy) < 0.35) continue;
      e.takeDamage(this.player.stats.damage, p);
      spawnSpark(e.group.position.clone().setY(e.group.position.y + 1), 0xffe08a);
      if (e.dead) this.onEnemyKilled(e);
    }
  }

  handlePlayerShout() {
    if (!this.player.pendingShout) return;
    this.player.pendingShout = false;
    const p = this.player.group.position.clone();
    spawnRing(p, 0xffd27a, 9, 0.55);
    const facing = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));
    for (const e of this.enemies) {
      if (e.dead) continue;
      const toEnemy = new THREE.Vector3().subVectors(e.group.position, p).setY(0);
      const dist = toEnemy.length();
      if (dist > 9) continue;
      const dir = toEnemy.clone().normalize();
      if (dist > 1.5 && facing.dot(dir) < 0.15) continue;
      e.takeDamage(28, p);
      e.knockOut(dir, 11);
      if (e.dead) this.onEnemyKilled(e);
    }
  }

  onEnemyKilled(e) {
    this.player.addXp(e.xp);
    this.player.addGold(e.gold);
    if (e.kind === 'wolf') this.quests.onWolfKilled();
    if (e === this.boss) this.quests.onGuardianDefeated();
  }

  updateCamera(dt) {
    this.camYaw -= input.lookDX * 0.0032;
    this.camPitch = clamp(this.camPitch - input.lookDY * 0.0026, -0.35, 0.85);
    input.lookDX = 0; input.lookDY = 0;

    const target = this.player.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const offset = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch) + 0.15,
      Math.cos(this.camYaw) * Math.cos(this.camPitch)
    ).multiplyScalar(-this.camDist);

    let desired = target.clone().add(offset);
    const groundY = terrainHeight(desired.x, desired.z) + 0.8;
    if (desired.y < groundY) desired.y = groundY;

    camera.position.lerp(desired, clamp(dt * 8, 0, 1));
    camera.lookAt(target);
  }

  updateInteractables() {
    const p = this.player.group.position;
    let nearest = null, nearestDist = Infinity;
    for (const it of this.interactables) {
      if (it.used) continue;
      const d = p.distanceTo(it.position);
      if (d < it.radius && d < nearestDist) { nearest = it; nearestDist = d; }
    }
    this.nearestInteractable = nearest;
    hud.showInteract(!!nearest, nearest?.label);
  }

  loop() {
    if (this.state === 'ended') return;
    requestAnimationFrame(this.loop.bind(this));
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.state !== 'playing') return;
    this.elapsed += dt;

    this.player.update(dt, this.camYaw);
    this.handlePlayerAttack();
    this.handlePlayerShout();

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      const finished = enemy.update(dt, this.player, this.enemies);
      if (finished) {
        scene.remove(enemy.group);
        if (enemy !== this.boss) this.enemies.splice(i, 1);
      }
    }

    this.updateCamera(dt);
    updateSky(this.elapsed, this.player.group.position);
    updateFx(dt);
    this.updateInteractables();

    hud.setVital('health', this.player.health / this.player.stats.maxHealth);
    hud.setVital('stamina', this.player.stamina / this.player.stats.maxStamina);
    hud.setVital('magicka', this.player.magicka / this.player.stats.maxMagicka);
    hud.setLevel(this.player.level);
    hud.setXp(this.player.xp / this.player.xpToNext);
    hud.btnShout.disabled = this.player.magicka < 60;
    updateCompass((this.camYaw * 180) / Math.PI);
    drawMinimap(this.player, this.enemies, this.poiMarkers);

    if (this.player.dead && this.state === 'playing') {
      this.state = 'dead';
      hud.endTitle.textContent = 'You Have Fallen';
      hud.endText.textContent = 'The cold claims another wanderer. Frosthold awaits your return.';
      hud.endMenu.hidden = false;
    }

    renderer.render(scene, camera);
  }
}

window.__game = new Game();
