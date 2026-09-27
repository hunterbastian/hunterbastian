import * as THREE from 'three';
import { inject as injectAnalytics } from '@vercel/analytics';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import { BRUSH, BUILD_RADIUS, LOW_QUALITY, WALL_COURSES, WORLD_SIZE } from './config';
import { Cursor } from './cursor';
import { Grass } from './grass';
import { PathMask, type Stroke, type Vec2 } from './pathMask';
import { Pixelator } from './pixelate';
import { createTerrain, heightAt, raycastTerrain } from './terrain';
import { buildWall, cutWalls, polylineLength, tidyStroke, type WallData } from './wall';
import { History, demoWorld, loadWorld, saveWorld, type WorldState } from './world';

type Tool = 'wall' | 'path' | 'erase' | 'look';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');

// ---------------------------------------------------------------------------
// Renderer, scene, camera

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, LOW_QUALITY ? 1.25 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const pixelator = new Pixelator(renderer);
pixelator.resize();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 600);
camera.position.set(3.2, heightAt(0, 0) + 4.6, 13.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, heightAt(0, 1) + 0.6, 1);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 48;
controls.maxPolarAngle = 1.38;
controls.minPolarAngle = 0.2;
controls.screenSpacePanning = false;
controls.update();

// ---------------------------------------------------------------------------
// Sky, fog, light

const skyUniforms = {
  uHorizon: { value: new THREE.Color() },
  uZenith: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Color() },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(400, 32, 16),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
        float sun = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sun, 8.0) * 0.18 + pow(sun, 400.0) * 0.8);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }),
);
sky.frustumCulled = false;
scene.add(sky);

scene.fog = new THREE.Fog(0xcfd9e0, 38, 120);

const hemi = new THREE.HemisphereLight(0xdbe6f5, 0x4d5a2c, 1.25);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(LOW_QUALITY ? 1024 : 2048);
sun.shadow.camera.left = -26;
sun.shadow.camera.right = 26;
sun.shadow.camera.top = 26;
sun.shadow.camera.bottom = -26;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

const sunDir = new THREE.Vector3();
const warm = new THREE.Color(0xffb778);
const noon = new THREE.Color(0xfff3e2);
const horizonDay = new THREE.Color(0xd3dce2);
const horizonGold = new THREE.Color(0xf0cfa8);
const zenithDay = new THREE.Color(0x9fb7cc);
const zenithGold = new THREE.Color(0x8e9fb8);

function setSun(t: number): void {
  const angle = THREE.MathUtils.lerp(0.12, Math.PI - 0.12, t);
  const el = Math.sin(angle) * 0.95 + 0.08;
  const az = -2.2 + t * 2.6;
  sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  const gold = 1 - THREE.MathUtils.smoothstep(el, 0.1, 0.6);
  sun.color.copy(noon).lerp(warm, gold);
  sun.intensity = 2.2 + (1 - gold) * 0.8;
  hemi.intensity = 0.9 + (1 - gold) * 0.45;
  skyUniforms.uHorizon.value.copy(horizonDay).lerp(horizonGold, gold * 0.85);
  skyUniforms.uZenith.value.copy(zenithDay).lerp(zenithGold, gold);
  skyUniforms.uSunDir.value.copy(sunDir);
  skyUniforms.uSunColor.value.copy(sun.color);
  (scene.fog as THREE.Fog).color.copy(skyUniforms.uHorizon.value);
  renderer.setClearColor(skyUniforms.uHorizon.value);
}

// ---------------------------------------------------------------------------
// World

const pathMask = new PathMask();
const shared = {
  uPathMask: { value: pathMask.texture as THREE.Texture },
  uWorld: { value: WORLD_SIZE },
  uTime: { value: 0 },
  uWind: { value: 0.35 },
};
scene.add(createTerrain(shared));
const grass = new Grass(shared);
scene.add(grass.group);

const cursor = new Cursor();
scene.add(cursor.mesh);

const wallsGroup = new THREE.Group();
scene.add(wallsGroup);

let world: WorldState = loadWorld() ?? demoWorld();
const history = new History();
let wallCourses: number = WALL_COURSES.default;

function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    (child as THREE.InstancedMesh).dispose?.();
  }
}

function rebuildWalls(): void {
  disposeGroup(wallsGroup);
  for (const w of world.walls) {
    const mesh = buildWall(w, pathMask);
    if (mesh) wallsGroup.add(mesh);
  }
}

function applyWorld(next: WorldState): void {
  world = next;
  pathMask.redraw(world.strokes);
  rebuildWalls();
  saveWorld(world);
  syncUI();
}

const snapshot = (): WorldState => JSON.parse(JSON.stringify(world));
const nextId = () => world.nextId++;

// ---------------------------------------------------------------------------
// Tools & input

let tool: Tool = 'wall';
let spaceHeld = false;
const activePointers = new Set<number>();

interface Drag {
  pointerId: number;
  before: WorldState;
  raw: Vec2[];
  stroke: Stroke | null;
  preview: THREE.InstancedMesh | null;
  seed: number;
  changed: boolean;
}
let drag: Drag | null = null;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pick(e: PointerEvent): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycastTerrain(raycaster.ray);
}

const inBounds = (p: THREE.Vector3) => Math.hypot(p.x, p.z) <= BUILD_RADIUS;

function brushRadius(): number {
  if (tool === 'path') return BRUSH.path;
  if (tool === 'erase') return BRUSH.erase;
  return 0.42;
}

function updateControlsMapping(): void {
  const look = tool === 'look' || spaceHeld;
  controls.mouseButtons = {
    LEFT: look ? THREE.MOUSE.ROTATE : null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: tool === 'look' ? THREE.TOUCH.ROTATE : null,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
  };
  canvas.classList.toggle('is-look', look);
}

function setTool(next: Tool): void {
  if (drag) cancelDrag();
  tool = next;
  cursor.setRadius(brushRadius());
  updateControlsMapping();
  syncUI();
}

function refreshPreview(): void {
  if (!drag) return;
  if (drag.preview) {
    wallsGroup.remove(drag.preview);
    drag.preview.dispose();
    drag.preview = null;
  }
  if (drag.raw.length < 2) return;
  const pts = tidyStroke(drag.raw);
  const mesh = buildWall({ id: -1, pts, courses: wallCourses, seed: drag.seed }, pathMask);
  if (mesh) {
    drag.preview = mesh;
    wallsGroup.add(mesh);
  }
}

function eraseAt(x: number, z: number): void {
  if (!drag) return;
  const cut = cutWalls(world.walls, x, z, BRUSH.erase * 0.8, nextId);
  if (cut) {
    world.walls = cut;
    drag.changed = true;
    rebuildWalls();
  }
}

canvas.addEventListener('pointerdown', (e) => {
  activePointers.add(e.pointerId);
  if (activePointers.size > 1) {
    // Second finger: this is a camera gesture, not a stroke.
    cancelDrag();
    return;
  }
  if (e.button !== 0 || tool === 'look' || spaceHeld) return;
  const hit = pick(e);
  if (!hit || !inBounds(hit)) {
    if (hit) toast('That’s a little too far out — build closer to the middle');
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  const p: Vec2 = [hit.x, hit.z];
  drag = {
    pointerId: e.pointerId,
    before: snapshot(),
    raw: [p],
    stroke: null,
    preview: null,
    seed: (Math.random() * 2 ** 31) >>> 0,
    changed: false,
  };
  cursor.setActive(true);
  if (tool === 'path' || tool === 'erase') {
    drag.stroke = { mode: tool === 'path' ? 'paint' : 'erase', radius: brushRadius(), pts: [p] };
    pathMask.segment(null, p, drag.stroke.radius, drag.stroke.mode);
    drag.changed = true;
    if (tool === 'erase') eraseAt(p[0], p[1]);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId !== drag.pointerId) return;
  const hit = pick(e);
  cursor.moveTo(tool === 'look' || spaceHeld ? null : hit);
  if (!drag || !hit || !inBounds(hit)) return;

  const p: Vec2 = [hit.x, hit.z];
  const last = drag.raw[drag.raw.length - 1];
  const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);

  if (tool === 'wall') {
    if (e.shiftKey) {
      drag.raw = [drag.raw[0], p];
      refreshPreview();
    } else if (dist > 0.3) {
      drag.raw.push(p);
      refreshPreview();
    }
  } else if (drag.stroke && dist > drag.stroke.radius * 0.25) {
    pathMask.segment(last, p, drag.stroke.radius, drag.stroke.mode);
    drag.raw.push(p);
    drag.stroke.pts.push(p);
    if (tool === 'erase') eraseAt(p[0], p[1]);
  }
});

function endDrag(e: PointerEvent): void {
  activePointers.delete(e.pointerId);
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  cursor.setActive(false);

  if (tool === 'wall') {
    if (d.preview) {
      wallsGroup.remove(d.preview);
      d.preview.dispose();
    }
    const pts = d.raw.length === 2 ? tidyStroke([d.raw[0], d.raw[1]]) : tidyStroke(d.raw);
    if (polylineLength(pts) < 0.8) {
      if (d.raw.length > 1) toast('Drag a little further to lay a wall');
      return;
    }
    history.push(d.before);
    const wall: WallData = { id: nextId(), pts, courses: wallCourses, seed: d.seed };
    world.walls.push(wall);
    rebuildWalls();
  } else if (d.stroke && d.changed) {
    history.push(d.before);
    world.strokes.push(d.stroke);
    // New or removed paths may open or close arches.
    rebuildWalls();
  }
  saveWorld(world);
  syncUI();
}

function cancelDrag(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  cursor.setActive(false);
  if (d.preview) {
    wallsGroup.remove(d.preview);
    d.preview.dispose();
  }
  if (tool !== 'wall') applyWorld(d.before);
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', (e) => {
  activePointers.delete(e.pointerId);
  cancelDrag();
});
canvas.addEventListener('pointerleave', () => cursor.moveTo(null));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Keyboard

const keys = new Set<string>();

function undo(): void {
  if (drag) return;
  const prev = history.undo(world);
  if (prev) applyWorld(prev);
}

function redo(): void {
  if (drag) return;
  const next = history.redo(world);
  if (next) applyWorld(next);
}

function setCourses(n: number): void {
  wallCourses = THREE.MathUtils.clamp(n, WALL_COURSES.min, WALL_COURSES.max);
  refreshPreview();
  syncUI();
}

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod) return;
  switch (e.key) {
    case '1': setTool('wall'); break;
    case '2': setTool('path'); break;
    case '3': setTool('erase'); break;
    case '4': setTool('look'); break;
    case '[': setCourses(wallCourses - 1); toast(`Wall height ${wallCourses}`); break;
    case ']': setCourses(wallCourses + 1); toast(`Wall height ${wallCourses}`); break;
    case 'h': case 'H': openHelp(); break;
    case 'f': case 'F': fpsEl.hidden = !fpsEl.hidden; break;
    case 'p': case 'P':
      setPixelSize(pixelator.settings.pixelSize > 1 ? 1 : 4);
      ditherInput.checked = pixelator.settings.dither = pixelator.settings.pixelSize > 1;
      toast(pixelator.settings.pixelSize > 1 ? 'Pixels on' : 'Pixels off');
      break;
    case 'Escape': cancelDrag(); break;
    case ' ':
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        cancelDrag();
        cursor.moveTo(null);
        updateControlsMapping();
      }
      break;
  }
  keys.add(e.key.toLowerCase());
});

addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  if (e.key === ' ') {
    spaceHeld = false;
    updateControlsMapping();
  }
});
addEventListener('blur', () => {
  keys.clear();
  spaceHeld = false;
  updateControlsMapping();
});

const panDir = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

function keyboardPan(dt: number): void {
  let f = 0;
  let r = 0;
  if (keys.has('w') || keys.has('arrowup')) f += 1;
  if (keys.has('s') || keys.has('arrowdown')) f -= 1;
  if (keys.has('d') || keys.has('arrowright')) r += 1;
  if (keys.has('a') || keys.has('arrowleft')) r -= 1;
  if (keys.has('q') || keys.has('e')) {
    const spin = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(THREE.Object3D.DEFAULT_UP, spin * dt * 1.2);
    camera.position.copy(controls.target).add(offset);
  }
  if (!f && !r) return;
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  right.crossVectors(fwd, THREE.Object3D.DEFAULT_UP);
  const speed = 6 + camera.position.distanceTo(controls.target) * 0.6;
  panDir.copy(fwd).multiplyScalar(f).addScaledVector(right, r).normalize().multiplyScalar(speed * dt);
  controls.target.add(panDir);
  camera.position.add(panDir);
}

// ---------------------------------------------------------------------------
// UI

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('.tool')];
const heightGroup = $<HTMLDivElement>('heightGroup');
const heightValue = $<HTMLOutputElement>('heightValue');
const undoBtn = $<HTMLButtonElement>('undoBtn');
const redoBtn = $<HTMLButtonElement>('redoBtn');
const fpsEl = $<HTMLOutputElement>('fps');
const toastEl = $<HTMLParagraphElement>('toast');
const help = $<HTMLDialogElement>('help');
const atmo = $<HTMLDivElement>('atmo');
const atmoToggle = $<HTMLButtonElement>('atmoToggle');

function syncUI(): void {
  for (const b of toolButtons) b.setAttribute('aria-checked', String(b.dataset.tool === tool));
  heightGroup.hidden = tool !== 'wall';
  heightValue.textContent = String(wallCourses);
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
}

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-on'), 1600);
}

function openHelp(): void {
  if (!help.open) help.showModal();
}
help.addEventListener('close', () => {
  try {
    localStorage.setItem('meadow:seen-help', '1');
  } catch {
    /* ignore */
  }
});

toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
$('heightDown').addEventListener('click', () => setCourses(wallCourses - 1));
$('heightUp').addEventListener('click', () => setCourses(wallCourses + 1));
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
$('helpBtn').addEventListener('click', openHelp);
atmoToggle.addEventListener('click', () => {
  atmo.hidden = !atmo.hidden;
  atmoToggle.setAttribute('aria-expanded', String(!atmo.hidden));
});
$<HTMLInputElement>('sun').addEventListener('input', (e) => setSun(Number((e.target as HTMLInputElement).value)));
const pixelInput = $<HTMLInputElement>('pixel');
const ditherInput = $<HTMLInputElement>('dither');
function setPixelSize(n: number): void {
  pixelator.settings.pixelSize = THREE.MathUtils.clamp(Math.round(n), 1, 8);
  pixelInput.value = String(pixelator.settings.pixelSize);
  pixelator.resize();
}
pixelInput.addEventListener('input', () => setPixelSize(Number(pixelInput.value)));
$<HTMLInputElement>('palette').addEventListener('change', (e) => {
  pixelator.settings.palette = (e.target as HTMLInputElement).checked;
});
ditherInput.addEventListener('change', () => {
  pixelator.settings.dither = ditherInput.checked;
});
$<HTMLInputElement>('wind').addEventListener('input', (e) => {
  shared.uWind.value = Number((e.target as HTMLInputElement).value);
});
$('clearBtn').addEventListener('click', () => {
  if (!world.walls.length && !world.strokes.length) return;
  history.push(snapshot());
  applyWorld({ walls: [], strokes: [], nextId: world.nextId });
  toast('A fresh meadow — undo to bring it back');
});

// ---------------------------------------------------------------------------
// Loop

const fpsSamples: number[] = [];
let fpsAccum = 0;

function updateFps(dt: number): void {
  fpsSamples.push(dt * 1000);
  fpsAccum += dt;
  if (fpsAccum < 0.5) return;
  const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  const min = Math.min(...fpsSamples);
  const max = Math.max(...fpsSamples);
  fpsEl.textContent = `${avg.toFixed(2)} ms (${min.toFixed(2)} .. ${max.toFixed(2)}) (${Math.round(1000 / avg)} FPS)`;
  fpsSamples.length = 0;
  fpsAccum = 0;
}

/** Portrait phones get a wider lens so the scene isn't cropped to a sliver. */
function fitCamera(): void {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 1 ? THREE.MathUtils.lerp(64, 42, camera.aspect) : 42;
  camera.updateProjectionMatrix();
}
fitCamera();

addEventListener('resize', () => {
  fitCamera();
  renderer.setSize(innerWidth, innerHeight);
  pixelator.resize();
});

const timer = new THREE.Timer();
timer.connect(document);
const LIMIT = BUILD_RADIUS - 4;

function frame(time: number): void {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  shared.uTime.value = t;

  keyboardPan(dt);
  // Keep the camera's focus over the meadow.
  const tx = controls.target.x;
  const tz = controls.target.z;
  const r = Math.hypot(tx, tz);
  if (r > LIMIT) {
    const k = LIMIT / r;
    const dx = tx * k - tx;
    const dz = tz * k - tz;
    controls.target.x += dx;
    controls.target.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
  }
  const groundY = heightAt(controls.target.x, controls.target.z) + 0.6;
  controls.target.y += (groundY - controls.target.y) * (1 - Math.exp(-dt * 6));
  controls.update();
  const camFloor = heightAt(camera.position.x, camera.position.z) + 1.2;
  if (camera.position.y < camFloor) camera.position.y = camFloor;

  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(sunDir, 70);

  grass.update(camera);
  cursor.update(dt, t);
  pixelator.render(scene, camera);
  updateFps(dt);
}

// ---------------------------------------------------------------------------
// Boot

setSun(0.38);
pathMask.redraw(world.strokes);
rebuildWalls();
setTool('wall');
renderer.setAnimationLoop(frame);

requestAnimationFrame(() => {
  $('loading').classList.add('is-done');
  let seen = false;
  try {
    seen = localStorage.getItem('meadow:seen-help') === '1';
  } catch {
    /* ignore */
  }
  if (!seen && !navigator.webdriver) setTimeout(openHelp, 500);
});

// Vercel Web Analytics, only on the live site so local and headless runs aren't counted.
if (location.hostname.endsWith('.vercel.app')) injectAnalytics();

// Handy for poking at things from the console (and tests/ui.mjs).
Object.assign(window, {
  __meadow: {
    scene,
    camera,
    controls,
    world: () => world,
    ui: () => ({
      tool,
      courses: wallCourses,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      pixel: { ...pixelator.settings },
    }),
    setTool,
    undo,
    redo,
  },
});
