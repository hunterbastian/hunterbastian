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
const modeLabels = document.querySelectorAll<HTMLElement>(".mode");
// Phones/tablets start in touch mode; anything else switches on first touch.
document.body.classList.toggle("touch", matchMedia("(pointer: coarse)").matches);

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
const input = new Input(canvas, document.querySelector<HTMLElement>("#stick")!, document.querySelector<HTMLElement>("#knob")!);
const follow = new FollowCamera(innerWidth / innerHeight, creature);
const dither = new DitherPass(renderer);

// ---- resolution: the canvas *is* the low-res frame ---------------------
const params = new URLSearchParams(location.search);
let pixelScale = Number(params.get("px")) || 0;
let pixelScaleNow = 3;
let modeIndex = Math.max(0, DITHER_MODES.indexOf((params.get("dither") ?? "palette") as DitherMode));

// Aim for ~440 pixels along the long edge, so a phone in portrait gets the
// same chunky pixels as a laptop.
const autoScale = () => Math.max(2, Math.round(Math.max(innerWidth, innerHeight) / 440));

function resize() {
  const scale = pixelScale || autoScale();
  pixelScaleNow = scale;
  const w = Math.max(90, Math.ceil(innerWidth / scale));
  const h = Math.max(90, Math.ceil(innerHeight / scale));
  renderer.setSize(w, h, false);
  dither.setSize(w, h);
  globalUniforms.uSnapRes.value.set(w, h);
  follow.camera.aspect = w / h;
  // Portrait phones: widen the view so the glen doesn't feel like a keyhole.
  const aspect = w / h;
  follow.camera.fov = aspect < 1 ? Math.min(78, (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(27.5)) / Math.sqrt(aspect)) * 180) / Math.PI) : 55;
  follow.camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
// iOS reports the new size a beat after rotating.
addEventListener("orientationchange", () => setTimeout(resize, 250));
resize();

function setMode(i: number) {
  modeIndex = (i + DITHER_MODES.length) % DITHER_MODES.length;
  dither.setMode(DITHER_MODES[modeIndex]);
  modeLabels.forEach((el) => (el.textContent = DITHER_MODES[modeIndex]));
}
setMode(modeIndex);

input.on("KeyT", () => setMode(modeIndex + 1));
input.on("BracketLeft", () => {
  pixelScale = Math.max(1, pixelScaleNow - 1);
  resize();
});
input.on("BracketRight", () => {
  pixelScale = Math.min(8, pixelScaleNow + 1);
  resize();
});
const toggleHud = () => {
  if (hud.classList.contains("hidden") || hud.classList.contains("faded")) hud.classList.remove("hidden", "faded");
  else hud.classList.add("hidden");
};
input.on("KeyH", toggleHud);

// Touch buttons mirror the keyboard shortcuts.
const tap = (sel: string, fn: () => void) =>
  document.querySelector(sel)?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    fn();
  });
tap("#btn-dither", () => setMode(modeIndex + 1));
tap("#btn-help", toggleHud);
tap("#hud", toggleHud);

// ---- loop ----------------------------------------------------------------
const clock = new THREE.Clock();
const move = new THREE.Vector3();
let walked = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;
  globalUniforms.uTime.value = t;

  if (input.usedTouch) document.body.classList.add("touch");
  const axis = input.axis();
  const { forward, right } = follow.basis();
  move.copy(forward).multiplyScalar(axis.y).addScaledVector(right, axis.x);
  creature.update(dt, t, { x: move.x, z: move.z, run: axis.run }, world.colliders);

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
