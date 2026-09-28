import * as THREE from "three";
import "./style.css";
import { FollowCamera } from "./camera";
import { Creature } from "./creature/creature";
import { Input } from "./input";
import { COLORS } from "./palette";
import { DITHER_MODES, DitherPass, type DitherMode } from "./post";
import { globalUniforms } from "./ps1";
import { SUN_DIR } from "./world/sky";
import { createWorld, SPAWN } from "./world/world";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const modeLabel = document.querySelector<HTMLElement>("#mode")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COLORS.fog, 18, 88);
scene.background = new THREE.Color(COLORS.fog);

// Warm late-afternoon light: a big soft sky fill plus a low golden sun.
scene.add(new THREE.HemisphereLight(0xe8e4bc, 0x4a3f2c, 1.35));
const sun = new THREE.DirectionalLight(0xffdca0, 2.8);
sun.position.copy(SUN_DIR).multiplyScalar(50);
scene.add(sun);
// Soft cool bounce from the other side so nothing sinks into mud when backlit.
const fill = new THREE.DirectionalLight(0xbcd0c4, 0.7);
fill.position.set(-SUN_DIR.x, 0.6, -SUN_DIR.z).multiplyScalar(50);
scene.add(fill);

const world = createWorld(scene);
const creature = new Creature(scene, SPAWN.x, SPAWN.z, world.blobTex);
const input = new Input(canvas);
const follow = new FollowCamera(innerWidth / innerHeight, creature);
const dither = new DitherPass();

// ---- resolution: the canvas *is* the low-res frame ---------------------
const params = new URLSearchParams(location.search);
let pixelScale = Number(params.get("px")) || 0;
let modeIndex = Math.max(0, DITHER_MODES.indexOf((params.get("dither") ?? "palette") as DitherMode));

function resize() {
  const scale = pixelScale || Math.max(2, Math.round(innerHeight / 250));
  const w = Math.max(160, Math.ceil(innerWidth / scale));
  const h = Math.max(90, Math.ceil(innerHeight / scale));
  renderer.setSize(w, h, false);
  dither.setSize(w, h);
  globalUniforms.uSnapRes.value.set(w, h);
  follow.camera.aspect = w / h;
  follow.camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function setMode(i: number) {
  modeIndex = (i + DITHER_MODES.length) % DITHER_MODES.length;
  dither.setMode(DITHER_MODES[modeIndex]);
  modeLabel.textContent = DITHER_MODES[modeIndex];
}
setMode(modeIndex);

input.on("KeyT", () => setMode(modeIndex + 1));
input.on("BracketLeft", () => {
  pixelScale = Math.max(1, (pixelScale || Math.round(innerHeight / 250)) - 1);
  resize();
});
input.on("BracketRight", () => {
  pixelScale = Math.min(8, (pixelScale || Math.round(innerHeight / 250)) + 1);
  resize();
});
input.on("KeyH", () => hud.classList.toggle("hidden"));

// ---- loop ----------------------------------------------------------------
const clock = new THREE.Clock();
const move = new THREE.Vector3();
let walked = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;
  globalUniforms.uTime.value = t;

  const axis = input.axis();
  const { forward, right } = follow.basis();
  move.copy(forward).multiplyScalar(axis.y).addScaledVector(right, axis.x);
  creature.update(dt, t, { x: move.x, z: move.z, run: input.down("ShiftLeft", "ShiftRight") }, world.colliders);

  // Let the controls card drift away once you're off exploring.
  walked += creature.speed * dt;
  if (walked > 12 && !hud.dataset.faded) {
    hud.dataset.faded = "1";
    hud.classList.add("faded");
  }

  world.update(t, dt);
  follow.update(dt, creature, input.consumeDrag(), performance.now() - input.lastDragTime);
  dither.render(renderer, scene, follow.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
