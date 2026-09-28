import * as THREE from 'three';
import './style.css';
import { Autopilot } from './player/autopilot';
import { InputController } from './player/input';
import { Player } from './player/player';
import { TouchControls } from './player/touch';
import { batchMaterials, GeoBatch } from './render/batch';
import { buildAurora } from './render/aurora';
import { buildGlows } from './render/glow';
import { buildPost } from './render/post';
import { buildSky, MOON_DIR } from './render/sky';
import { buildWater } from './render/water';
import { Hud } from './ui/hud';
import { buildCabins } from './world/cabins';
import { BuildContext } from './world/context';
import { ROUTE_WAYPOINTS, SPAWN } from './world/layout';
import { PALETTE } from './world/palette';
import { buildProps } from './world/props';
import { buildTerrain } from './world/terrain';
import { buildWalkWorld } from './world/walkables';
import { buildWalkways } from './world/walkways';
import { zoneAt } from './world/zones';

/*
 * Build stages (append ?stage=1 or ?stage=2 to see earlier stages):
 *   1. terrain, walking route, working controls
 *   2. + cabins, bridge details, mountains, lighting
 *   3. + animated reflective water, aurora, dither post-processing
 */
const params = new URLSearchParams(location.search);
const STAGE = Math.min(3, Math.max(1, Number(params.get('stage') ?? 3) || 3));
const AUTOWALK = params.has('autowalk');

// Phones and tablets (including iPads that report a desktop user agent)
// get touch controls and a lighter rendering profile.
const TOUCH_DEVICE =
  matchMedia('(pointer: coarse)').matches ||
  (navigator.maxTouchPoints > 1 && /Macintosh|iPhone|iPad|iPod|Android/.test(navigator.userAgent));
const MOBILE = TOUCH_DEVICE || params.has('mobile');
const QUALITY = MOBILE
  ? { pixelRatio: 1.3, shadowMap: 1024, reflection: 0.42, samples: 2 }
  : { pixelRatio: 1.5, shadowMap: 2048, reflection: 0.6, samples: 4 };

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = new Hud();

const renderer = new THREE.WebGLRenderer({ canvas, antialias: STAGE < 3, powerPreference: 'high-performance' });
const pixelRatio = Math.min(window.devicePixelRatio, QUALITY.pixelRatio);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = STAGE >= 2;
renderer.info.autoReset = false; // count every pass (reflection + post) per frame
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.fog);
const fog = new THREE.FogExp2(PALETTE.fog, 0.00105);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 9000);
camera.rotation.order = 'YXZ';

/* ---------------------------------------------------------------- */
/* Stage 1 — terrain, route, controls                                */
/* ---------------------------------------------------------------- */

const terrain = buildTerrain();
if (STAGE < 2) terrain.getObjectByName('terrain-far')!.visible = false;
scene.add(terrain);

const ctx: BuildContext = { batch: new GeoBatch(), glows: [], lights: [] };
buildWalkways(ctx);

const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.15);
scene.add(hemi);
const moon = new THREE.DirectionalLight(PALETTE.moonLight, 1.35);
moon.position.copy(MOON_DIR).multiplyScalar(260).add(new THREE.Vector3(-30, 0, 0));
moon.target.position.set(-30, 0, 0);
scene.add(moon, moon.target);

const walkWorld = buildWalkWorld();
const player = new Player(walkWorld, SPAWN.x, SPAWN.z, SPAWN.yaw);
player.pitch = 0.08;
const input = new InputController(canvas, player);

/* ---------------------------------------------------------------- */
/* Stage 2 — cabins, bridge, mountains, lighting                     */
/* ---------------------------------------------------------------- */

let boats: THREE.Group | null = null;
if (STAGE >= 2) {
  buildCabins(ctx);
  boats = buildProps(ctx).boats;
  scene.add(boats);

  moon.castShadow = true;
  moon.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
  const s = moon.shadow.camera;
  s.left = -170;
  s.right = 170;
  s.top = 120;
  s.bottom = -120;
  s.near = 10;
  s.far = 700;
  moon.shadow.bias = -0.0006;
  moon.shadow.normalBias = 0.04;
  moon.shadow.radius = 2;

  for (const l of ctx.lights) {
    const light = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
    light.position.set(l.x, l.y, l.z);
    scene.add(light);
  }
}
scene.add(ctx.batch.build(batchMaterials(), 'village'));
const glows = buildGlows(ctx.glows, fog);
scene.add(glows);

/* ---------------------------------------------------------------- */
/* Stage 3 — water, aurora, dither                                   */
/* ---------------------------------------------------------------- */

const sky = buildSky();
scene.add(sky.group);

const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
let water: ReturnType<typeof buildWater> | null = null;
let aurora: ReturnType<typeof buildAurora> | null = null;
let post: ReturnType<typeof buildPost> | null = null;
if (STAGE >= 3) {
  water = buildWater(Math.round(buffer.x * QUALITY.reflection), Math.round(buffer.y * QUALITY.reflection), fog);
  scene.add(water.mesh);
  aurora = buildAurora();
  scene.add(aurora.group);
  post = buildPost(renderer, scene, camera, QUALITY.samples);
  post.dither.uniforms.cell.value = Math.max(1, Math.round(pixelRatio));
} else {
  const flat = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshLambertMaterial({ color: PALETTE.water }),
  );
  flat.rotation.x = -Math.PI / 2;
  scene.add(flat);
}

/* ---------------------------------------------------------------- */
/* Loop                                                              */
/* ---------------------------------------------------------------- */

const autopilot = AUTOWALK ? new Autopilot(ROUTE_WAYPOINTS) : null;
let timeScale = 1;

/* ---------------------------------------------------------------- */
/* Entering / pausing: pointer lock on desktop, touch on phones      */
/* ---------------------------------------------------------------- */

const touch = new TouchControls(canvas, player);
const hudEl = document.getElementById('hud')!;
const intro = document.getElementById('intro')!;
const pauseButton = document.getElementById('pause')!;
hud.setInputMode(TOUCH_DEVICE ? 'touch' : 'mouse');

const isPlaying = () => input.locked || touch.active;

function setTouchPlaying(on: boolean) {
  touch.setActive(on);
  input.keysEnabled = on;
  if (!on) input.clearKeys();
  hud.setPlaying(isPlaying());
}

function enter(pointerType: string) {
  if (hudEl.classList.contains('is-loading') || isPlaying()) return;
  if (pointerType === 'touch' || !input.canLock) {
    hud.setInputMode('touch');
    setTouchPlaying(true);
  } else {
    hud.setInputMode('mouse');
    input.requestLock();
  }
}

input.onLockChange = () => hud.setPlaying(isPlaying());
input.onLockError = () => {
  // No pointer lock (e.g. iPhone): fall back to touch-style play.
  if (!input.canLock) setTouchPlaying(true);
  else hud.lockBlocked();
};
intro.addEventListener('pointerup', (e) => enter(e.pointerType));
canvas.addEventListener('pointerup', (e) => enter(e.pointerType));
intro.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') enter('keyboard');
});
pauseButton.addEventListener('click', () => setTouchPlaying(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && touch.active) setTouchPlaying(false);
});
// iOS Safari: stop pinch-zoom and page bounce from stealing gestures.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const notice = document.getElementById('notice')!;
  notice.textContent = 'The graphics context was lost. Reload to continue the walk.';
  notice.classList.add('is-visible');
});

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  // Keep at least ~56° horizontally on tall portrait phones (capped to avoid fish-eye).
  const minHorizontal = THREE.MathUtils.degToRad(56);
  const fovForWidth = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(minHorizontal / 2) / camera.aspect));
  camera.fov = Math.min(88, Math.max(68, fovForWidth));
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  post?.composer.setSize(w, h);
  const b = renderer.getDrawingBufferSize(new THREE.Vector2());
  water?.resize(Math.round(b.x * QUALITY.reflection), Math.round(b.y * QUALITY.reflection));
  (glows.material as THREE.ShaderMaterial).uniforms.scale.value = b.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
resize();

const timer = new THREE.Timer();
timer.connect(document);
let elapsed = 0;

function syncCamera() {
  camera.position.set(player.x, player.eyeY, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
}

function frame(now: number) {
  renderer.info.reset();
  timer.update(now);
  const dt = Math.min(Math.max(timer.getDelta(), 0), 0.1) * timeScale;
  elapsed += dt;

  if (autopilot && !autopilot.done) {
    // Sub-step so fast-forwarded walks behave exactly like real-time ones.
    const steps = Math.ceil(dt / (1 / 60));
    for (let i = 0; i < steps; i++) player.update(dt / steps, autopilot.step(player, dt / steps));
  } else if (isPlaying()) {
    const k = input.move;
    const t = touch.move;
    player.update(dt, {
      forward: Math.max(-1, Math.min(1, k.forward + t.forward)),
      strafe: Math.max(-1, Math.min(1, k.strafe + t.strafe)),
      run: k.run || t.run,
    });
  }
  hud.setZone(zoneAt(player.x, player.z, player.surface));
  syncCamera();

  sky.update(elapsed, camera, pixelRatio);
  water?.update(elapsed);
  aurora?.update(elapsed);
  (glows.material as THREE.ShaderMaterial).uniforms.time.value = elapsed;
  if (boats) {
    boats.children.forEach((b) => {
      const ph = b.userData.phase as number;
      b.position.y = Math.sin(elapsed * 0.9 + ph) * 0.05;
      b.rotation.z = Math.sin(elapsed * 0.7 + ph) * 0.025;
    });
  }

  if (post) post.composer.render(dt);
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

syncCamera();
hud.ready();
if (AUTOWALK) hud.setPlaying(true); // demo mode: hide the card and let the autopilot walk
requestAnimationFrame(frame);

/* Debug / test hooks. */
declare global {
  interface Window {
    __nordlys: unknown;
  }
}
window.__nordlys = {
  player,
  stage: STAGE,
  mobile: MOBILE,
  touch,
  autopilot,
  teleport(x: number, z: number, yaw?: number, pitch?: number) {
    player.teleport(x, z, yaw);
    if (pitch !== undefined) player.pitch = pitch;
  },
  setTimeScale(s: number) {
    timeScale = s;
  },
  state() {
    return {
      x: player.x,
      z: player.z,
      y: player.feetY,
      surface: player.surface,
      zone: zoneAt(player.x, player.z, player.surface),
      waypoint: autopilot?.index ?? null,
      done: autopilot?.done ?? null,
      stuck: autopilot?.stuckTime ?? null,
      elapsed,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  },
};
