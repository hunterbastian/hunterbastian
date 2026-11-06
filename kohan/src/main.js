// Kohan: boot, render loop, and the controls around it.

import { createProgram, createMesh, createHeightTexture, createFullscreen } from "./gl.js";
import { perspective, cameraBasis, viewMatrix, mul4, transform4, clamp, smoothstep } from "./math.js";
import { buildWorld, HERO, HERO_F, HERO_R, TREE } from "./world.js";
import { PostStack } from "./post.js";
import { Leaves } from "./leaves.js";
import { Player, Input } from "./player.js";
import * as S from "./shaders.js";

const NEAR = 0.12;
const FAR = 7000;
const STORE_KEY = "kohan.settings.v1";

const PRESETS = {
  painting: { label: "Painting", lowres: true, lines: 200, bloom: true, dof: false, rays: true, depth: true, depthMode: "palette", deflicker: false, crt: false },
  ps2: { label: "PS2", lowres: true, lines: 224, bloom: true, dof: true, rays: true, depth: true, depthMode: "ps2", deflicker: false, crt: true },
  gamecube: { label: "GameCube", lowres: true, lines: 240, bloom: true, dof: true, rays: true, depth: true, depthMode: "gc", deflicker: true, crt: true },
  raw: { label: "Raw", lowres: false, lines: 240, bloom: false, dof: false, rays: false, depth: false, depthMode: "ps2", deflicker: false, crt: false },
};
const PRESET_ORDER = ["painting", "ps2", "gamecube", "raw"];
const PASS_KEYS = [null, "lowres", "bloom", "dof", "rays", "depth", "deflicker", "crt"];

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $("kohan"),
  start: $("start"),
  startBtn: $("startBtn"),
  stack: $("stack"),
  stackBody: $("stackBody"),
  stackToggle: $("stackToggle"),
  lines: $("lines"),
  depthMode: $("depthMode"),
  hud: $("hudLabel"),
  prompt: $("prompt"),
  promptKey: $("promptKey"),
  promptText: $("promptText"),
  reading: $("reading"),
  readingClose: $("readingClose"),
  crosshair: $("crosshair"),
  joy: $("joy"),
  knob: $("knob"),
  hop: $("hopBtn"),
  error: $("error"),
  errorText: $("errorText"),
};

const coarse = window.matchMedia("(pointer: coarse)").matches;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fail(msg) {
  els.error.hidden = false;
  els.errorText.textContent = msg;
  els.start.hidden = true;
}

// --- settings -----------------------------------------------------------------
let presetId = "painting";
let settings = { ...PRESETS.painting };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  if (saved && saved.settings) {
    settings = { ...settings, ...saved.settings };
    presetId = saved.preset || null;
  }
} catch {
  /* storage unavailable: defaults are fine */
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings, preset: presetId }));
  } catch {
    /* ignore */
  }
}

// --- GL setup -----------------------------------------------------------------
const gl = els.canvas.getContext("webgl2", { antialias: false, alpha: false, depth: true, powerPreference: "high-performance" });
if (!gl) {
  fail("This browser can't run WebGL2, which Kohan needs to draw the lake. Try a current Chrome, Safari, Firefox or Edge.");
  throw new Error("WebGL2 unavailable");
}

let world, post, progs, meshes, leaves, heightTex, fullscreen;
try {
  world = buildWorld({ mobile: coarse });
  fullscreen = createFullscreen(gl);
  progs = {
    sky: createProgram(gl, S.SKY_VS, S.SKY_FS, "sky"),
    lit: createProgram(gl, S.LIT_VS, S.LIT_FS, "lit"),
    foliage: createProgram(gl, S.FOLIAGE_VS, S.FOLIAGE_FS, "foliage"),
    water: createProgram(gl, S.WATER_VS, S.WATER_FS, "water"),
  };
  const water = (() => {
    const s = 6500;
    return {
      pos: new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s]),
      idx: new Uint32Array([0, 2, 1, 0, 3, 2]),
    };
  })();
  leaves = new Leaves(world, coarse ? 80 : 140);
  meshes = {
    terrain: createMesh(gl, world.terrain.arrays()),
    bark: createMesh(gl, world.meshes.bark),
    stone: createMesh(gl, world.meshes.stone),
    stele: createMesh(gl, world.meshes.stele),
    far: createMesh(gl, world.meshes.far),
    falls: createMesh(gl, world.meshes.falls),
    leaves: createMesh(gl, world.meshes.leaves),
    grass: createMesh(gl, world.meshes.grass),
    water: createMesh(gl, water),
    falling: createMesh(gl, leaves.arrays(), true),
  };
  heightTex = createHeightTexture(gl, world.terrain.h, world.terrain.n, world.terrain.n);
  post = new PostStack(gl);
} catch (err) {
  console.error(err);
  fail("Kohan couldn't start its renderer on this device. " + (err && err.message ? err.message : ""));
  throw err;
}

els.canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  fail("The graphics context was lost. Reload the page to come back to the lake.");
});

const player = new Player(world, HERO);
const input = new Input(els.canvas, { joy: els.joy, knob: els.knob });

// --- sizing -------------------------------------------------------------------
const view = { outW: 1, outH: 1, dpr: 1, W: 1, H: 1, fovy: 1 };
function resize() {
  const vv = window.visualViewport;
  const cssW = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
  const cssH = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.dpr = dpr;
  view.outW = Math.round(cssW * dpr);
  view.outH = Math.round(cssH * dpr);
  els.canvas.width = view.outW;
  els.canvas.height = view.outH;
  const aspect = cssW / cssH;
  const H = settings.lowres ? settings.lines : Math.min(view.outH, 1080);
  view.H = H;
  view.W = Math.max(1, Math.round(H * aspect));
  // keep roughly a 90 degree horizontal view, within sane vertical limits
  view.fovy = clamp(2 * Math.atan(Math.tan((88 * Math.PI) / 360) / aspect), (54 * Math.PI) / 180, (84 * Math.PI) / 180);
  post.resize(view.W, view.H);
}
window.addEventListener("resize", resize);
window.visualViewport?.addEventListener("resize", resize);
resize();

// --- UI -------------------------------------------------------------------------
function syncUI() {
  for (let i = 1; i < PASS_KEYS.length; i++) {
    const box = document.querySelector(`[data-pass="${i}"]`);
    if (box) box.checked = !!settings[PASS_KEYS[i]];
    const row = box?.closest(".pass");
    if (row) row.classList.toggle("is-off", !settings[PASS_KEYS[i]]);
  }
  els.lines.value = String(settings.lines);
  els.lines.disabled = !settings.lowres;
  els.depthMode.value = settings.depthMode;
  els.depthMode.disabled = !settings.depth;
  document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === presetId)));
  const res = settings.lowres ? `${settings.lines}p` : "native";
  els.hud.textContent = `${res} · ${presetId ? PRESETS[presetId].label : "Custom stack"}`;
}

function applyPreset(id) {
  presetId = id;
  settings = { ...PRESETS[id] };
  resize();
  syncUI();
  save();
}

function setPass(i, on) {
  const key = PASS_KEYS[i];
  if (!key) return;
  settings[key] = on === undefined ? !settings[key] : on;
  presetId = null;
  if (key === "lowres") resize();
  syncUI();
  save();
}

document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
document.querySelectorAll("[data-pass]").forEach((box) =>
  box.addEventListener("change", () => setPass(Number(box.dataset.pass), box.checked))
);
els.lines.addEventListener("change", () => {
  settings.lines = Number(els.lines.value);
  presetId = null;
  resize();
  syncUI();
  save();
});
els.depthMode.addEventListener("change", () => {
  settings.depthMode = els.depthMode.value;
  presetId = null;
  syncUI();
  save();
});

function setPanel(open) {
  els.stack.classList.toggle("is-collapsed", !open);
  els.stackToggle.setAttribute("aria-expanded", String(open));
}
els.stackToggle.addEventListener("click", () => setPanel(els.stack.classList.contains("is-collapsed")));
if (coarse || window.innerWidth < 720) setPanel(false);

input.onToggle = (kind, n) => {
  if (kind === "panel") setPanel(els.stack.classList.contains("is-collapsed"));
  else if (kind === "pass") setPass(n);
  else if (kind === "preset") {
    const i = PRESET_ORDER.indexOf(presetId);
    applyPreset(PRESET_ORDER[(i + 1) % PRESET_ORDER.length]);
  }
};

let started = false;
function start() {
  started = true;
  input.enabled = true;
  els.start.hidden = true;
  els.hop.hidden = !coarse;
  if (!coarse) input.requestLock();
  els.canvas.focus?.();
}
els.startBtn.textContent = coarse ? "Tap to walk" : "Click to walk";
els.startBtn.addEventListener("click", start);
els.canvas.addEventListener("click", () => {
  if (started && !coarse && !input.locked) input.requestLock();
});
input.onLockChange = (locked) => {
  els.crosshair.hidden = !locked;
  document.body.classList.toggle("is-locked", locked);
};
els.hop.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  input.jumpQueued = true;
});

// --- points of interest -----------------------------------------------------------
let lanternLit = false;
let lanternGlow = 0;
let reading = false;
const POIS = [
  { ...world.poi.stele, r: 3.8, text: () => "Read the stone", act: () => openReading() },
  { ...world.poi.lantern, r: 3.2, text: () => (lanternLit ? "Put out the lantern" : "Light the lantern"), act: () => (lanternLit = !lanternLit) },
];
let activePoi = null;
function openReading() {
  reading = true;
  els.reading.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock?.();
  els.readingClose.focus();
}
function closeReading() {
  reading = false;
  els.reading.hidden = true;
  if (started && !coarse) input.requestLock();
}
els.readingClose.addEventListener("click", closeReading);
input.onAction = () => {
  if (reading) closeReading();
  else activePoi?.act();
};
els.prompt.addEventListener("click", () => activePoi?.act());
els.promptKey.hidden = coarse;

// --- rendering ---------------------------------------------------------------------
const proj = new Float32Array(16);
const viewM = new Float32Array(16);
const vp = new Float32Array(16);
const viewR = new Float32Array(16);
const vpR = new Float32Array(16);
const windAmt = 0.6;
const wind = world.windDir.map((v) => v * 1.0);

function setCommon(p, m, eye, clip, time) {
  p.m4("u_vp", m)
    .v3("u_camPos", eye)
    .v3("u_sunDir", world.sunDir)
    .v3("u_wind", wind)
    .f1("u_time", time)
    .f1("u_clip", clip ? 1 : 0)
    .f4("u_canopy", world.canopy[0], world.canopy[1], world.canopy[2], world.canopy[3])
    .f2("u_trunk", TREE[0], TREE[1])
    .f2("u_streak", HERO_F[0], HERO_F[1]);
}

function drawScene(m, eye, basis, refl, time) {
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  const sky = progs.sky.use();
  setCommon(sky, m, eye, refl, time);
  const ty = Math.tan(view.fovy / 2);
  sky.v3("u_camR", basis.r).v3("u_camU", basis.u).v3("u_camF", basis.f).f2("u_tan", ty * (view.W / view.H), ty);
  fullscreen.draw();

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  const lit = progs.lit.use();
  setCommon(lit, m, eye, refl, time);
  lit.f1("u_lantern", lanternGlow);
  lit.i1("u_mat", 0);
  meshes.terrain.draw();
  lit.i1("u_mat", 1);
  meshes.bark.draw();
  lit.i1("u_mat", 2);
  meshes.stone.draw();
  lit.i1("u_mat", 3);
  meshes.stele.draw();
  lit.i1("u_mat", 4);
  meshes.far.draw();
  lit.i1("u_mat", 5);
  meshes.falls.draw();

  const fol = progs.foliage.use();
  setCommon(fol, m, eye, refl, time);
  fol.f1("u_windAmt", windAmt);
  meshes.leaves.draw();
  if (refl) return;
  meshes.grass.draw();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const wat = progs.water.use();
  setCommon(wat, m, eye, false, time);
  wat
    .tex("u_refl", post.refl.tex)
    .tex("u_height", heightTex)
    .f4("u_hmap", ...world.terrain.mapInfo)
    .f2("u_res", view.W, view.H)
    .f2("u_heroR", HERO_R[0], HERO_R[1])
    .f2("u_heroF", HERO_F[0], HERO_F[1]);
  meshes.water.draw();
  gl.disable(gl.BLEND);

  const fol2 = progs.foliage.use();
  setCommon(fol2, m, eye, false, time);
  fol2.f1("u_windAmt", windAmt);
  meshes.falling.draw();
}

let last = performance.now();
let time = 0;
let grainTick = 0;
let idle = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  time += dt;
  grainTick = reduceMotion ? 0 : Math.floor(time * 12);

  const inp = input.read();
  if (reading && (inp.moveX || inp.moveY)) closeReading();
  if (started && !reading) player.update(dt, inp, reduceMotion);
  else if (!started) {
    idle += dt;
    player.yaw = HERO.yaw + (reduceMotion ? 0 : Math.sin(idle * 0.18) * 0.03);
  }

  leaves.update(dt, windAmt);
  leaves.write();
  meshes.falling.update("pos", leaves.pos);
  meshes.falling.update("nrm", leaves.nrm);

  // nearest point of interest
  let best = null;
  if (started) {
    for (const p of POIS) {
      const d = Math.hypot(player.x - p.x, player.z - p.z);
      if (d < p.r && (!best || d < best.d)) best = { p, d };
    }
  }
  activePoi = best ? best.p : null;
  els.prompt.hidden = !activePoi || reading;
  if (activePoi) els.promptText.textContent = activePoi.text();
  const flicker = reduceMotion ? 1 : 0.9 + 0.1 * Math.sin(time * 13.0) * Math.sin(time * 7.3);
  lanternGlow += ((lanternLit ? flicker : 0) - lanternGlow) * (1 - Math.exp(-dt * 4));

  // camera
  const eye = player.eye(reduceMotion);
  const basis = cameraBasis(player.yaw, player.pitch);
  perspective(proj, view.fovy, view.W / view.H, NEAR, FAR);
  viewMatrix(viewM, eye, basis);
  mul4(vp, proj, viewM);

  const eyeR = [eye[0], -eye[1], eye[2]];
  const basisR = cameraBasis(player.yaw, -player.pitch);
  viewMatrix(viewR, eyeR, basisR);
  mul4(vpR, proj, viewR);

  // reflection, then the scene, both at the internal resolution
  post.refl.bind();
  gl.clearColor(0.8, 0.84, 0.92, 1);
  gl.depthMask(true);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(vpR, eyeR, basisR, true, time);

  post.scene.bind();
  gl.depthMask(true);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(vp, eye, basis, false, time);

  // where the sun sits on screen, for the shafts
  const sp = transform4(vp, eye[0] + world.sunDir[0] * 1000, eye[1] + world.sunDir[1] * 1000, eye[2] + world.sunDir[2] * 1000, 1);
  let sunUV = [0.5, 0.5];
  let sunVisible = 0;
  if (sp[3] > 0) {
    sunUV = [(sp[0] / sp[3]) * 0.5 + 0.5, (sp[1] / sp[3]) * 0.5 + 0.5];
    const facing = smoothstep(0.1, 0.5, basis.f[0] * world.sunDir[0] + basis.f[1] * world.sunDir[1] + basis.f[2] * world.sunDir[2]);
    const off = Math.max(Math.abs(sunUV[0] - 0.5), Math.abs(sunUV[1] - 0.5));
    sunVisible = facing * smoothstep(1.1, 0.6, off);
  }

  post.run(settings, {
    sunUV,
    sunVisible,
    near: NEAR,
    far: FAR,
    grainTick,
    outW: view.outW,
    outH: view.outH,
    dpr: view.dpr,
  });

  requestAnimationFrame(frame);
}

syncUI();
document.body.classList.add("is-ready");
requestAnimationFrame(frame);

// Debug/automation hook: lets a test place the camera and pick a preset.
window.kohan = {
  settings: () => ({ ...settings }),
  preset: applyPreset,
  pass: setPass,
  look(x, z, yaw, pitch) {
    started = true;
    els.start.hidden = true;
    player.x = x;
    player.z = z;
    player.y = player.groundAt(x, z);
    player.yaw = yaw;
    player.pitch = pitch;
  },
  get player() {
    return player;
  },
};
