// Digital Forest — a procedurally generated, living canvas world.
// No dependencies. Everything (trees, sky, weather) is drawn frame by frame.

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Set in resize(): true on touch / small-screen devices. Drives a lighter
// rendering profile so the scene stays smooth on mobile GPUs.
let MOBILE = false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

/* ----------------------------------------------------------------------- */
/* Seeded RNG (mulberry32) so a forest can be reproduced / regenerated.    */
/* ----------------------------------------------------------------------- */
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, lo, hi) => lo + rng() * (hi - lo);

/* ----------------------------------------------------------------------- */
/* Colour helpers — work on {r,g,b} objects.                               */
/* ----------------------------------------------------------------------- */
function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mix(a, b, t) {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  };
}
function css(c, alpha = 1) {
  return `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${alpha})`;
}

/* ----------------------------------------------------------------------- */
/* Sky palette keyframes across a full day (phase 0..1, wrapping).         */
/* ----------------------------------------------------------------------- */
// Tuned toward Studio Ghibli skies: vivid cerulean days, warm peach golden hours.
const SKY_KEYS = [
  { p: 0.0, top: hex("#070a17"), bot: hex("#11193a") },
  { p: 0.22, top: hex("#1f1c40"), bot: hex("#5a3a60") },
  { p: 0.27, top: hex("#436a96"), bot: hex("#ffa873") },
  { p: 0.34, top: hex("#5fb4e4"), bot: hex("#eaf6ff") },
  { p: 0.5, top: hex("#3f9ce6"), bot: hex("#d6f1ff") },
  { p: 0.68, top: hex("#6aa3d8"), bot: hex("#ffedcb") },
  { p: 0.74, top: hex("#374a86"), bot: hex("#ff8a4e") },
  { p: 0.8, top: hex("#181c40"), bot: hex("#432f63") },
  { p: 1.0, top: hex("#070a17"), bot: hex("#11193a") },
];

function skyAt(phase) {
  let a = SKY_KEYS[0];
  let b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (phase >= SKY_KEYS[i].p && phase <= SKY_KEYS[i + 1].p) {
      a = SKY_KEYS[i];
      b = SKY_KEYS[i + 1];
      break;
    }
  }
  const span = b.p - a.p || 1;
  const t = smoothstep(clamp((phase - a.p) / span, 0, 1));
  return { top: mix(a.top, b.top, t), bot: mix(a.bot, b.bot, t) };
}

/* ----------------------------------------------------------------------- */
/* Tree generation — recursive branch tree, cached once per tree.          */
/* ----------------------------------------------------------------------- */
function buildBranch(rng, depth, maxDepth, length, width, angle) {
  const node = { angle, length, width, depth, children: [], leaf: false };
  if (depth >= maxDepth || length < 6) {
    node.leaf = true;
    node.leafSize = rand(rng, 10, 22) * (1 + (maxDepth - depth) * 0.2);
    node.hueShift = rand(rng, -18, 18);
    return node;
  }
  const count = rng() < 0.25 ? 3 : 2;
  const spread = rand(rng, 0.4, 0.8);
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1) - 0.5;
    const childAngle = f * spread * 2 + rand(rng, -0.12, 0.12);
    const childLen = length * rand(rng, 0.68, 0.82);
    const childWidth = width * rand(rng, 0.6, 0.72);
    node.children.push(
      buildBranch(rng, depth + 1, maxDepth, childLen, childWidth, childAngle)
    );
  }
  // occasional mid-branch foliage tuft for fuller canopies
  if (depth > 1 && rng() < 0.3) {
    node.children.push({
      angle: rand(rng, -0.6, 0.6),
      length: 4,
      width: 1,
      depth: depth + 1,
      children: [],
      leaf: true,
      leafSize: rand(rng, 8, 16),
      hueShift: rand(rng, -18, 18),
    });
  }
  return node;
}

function makeTree(rng, x, z) {
  // z: 0 = far (small, hazy), 1 = near (large, crisp)
  let maxDepth = Math.round(rand(rng, 6, 9));
  if (MOBILE) maxDepth = Math.min(maxDepth, 7); // fewer branch segments
  const trunkLen = rand(rng, 56, 92);
  const trunkWidth = rand(rng, 7, 13);
  const root = buildBranch(rng, 0, maxDepth, trunkLen, trunkWidth, 0);
  return {
    x, // normalized 0..1
    z,
    root,
    phase: rng() * TAU, // unique wind phase
    scale: lerp(0.4, 1.15, z) * rand(rng, 0.85, 1.15),
    hue: rand(rng, 95, 145), // base green hue
    sat: rand(rng, 38, 62),
    grow: 0, // 0..1 growth animation
  };
}

/* ----------------------------------------------------------------------- */
/* Particle systems: leaves + fireflies.                                   */
/* ----------------------------------------------------------------------- */
function spawnLeaf(rng, w, h) {
  return {
    x: rng() * w,
    y: rand(rng, -h * 0.2, h * 0.4),
    vy: rand(rng, 12, 34),
    size: rand(rng, 3, 7),
    rot: rng() * TAU,
    vr: rand(rng, -1.5, 1.5),
    sway: rand(rng, 0.6, 1.8),
    swayPhase: rng() * TAU,
    hue: rand(rng, 25, 70),
    alpha: rand(rng, 0.5, 0.9),
  };
}

function spawnFirefly(rng, w, h, horizon) {
  return {
    x: rng() * w,
    y: rand(rng, horizon * 0.5, h * 0.95),
    bx: rng() * w,
    by: rand(rng, horizon * 0.5, h * 0.95),
    t: rng(),
    speed: rand(rng, 0.05, 0.16),
    blink: rng() * TAU,
    blinkSpeed: rand(rng, 1.5, 3.2),
    size: rand(rng, 1.4, 2.8),
  };
}

/* ----------------------------------------------------------------------- */
/* Main app.                                                               */
/* ----------------------------------------------------------------------- */
const canvas = document.getElementById("forest");
const ctx = canvas.getContext("2d");

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const state = {
  w: 0,
  h: 0,
  horizon: 0,
  dpr: 1,
  phase: 0.18, // time of day 0..1
  autoTime: true,
  wind: 0.35,
  density: 16,
  leavesOn: true,
  trees: [],
  leaves: [],
  fireflies: [],
  stars: [],
  hills: [],
  clouds: [],
  grass: [],
  kodama: [],
  spiritsOn: true,
  // The little world is wider than the screen; a camera pans across it.
  worldW: 0,
  camMax: 0,
  camera: { x: 0, vx: 0 },
  cameraInit: false,
  seed: (Math.random() * 1e9) >>> 0,
};

let rng = makeRng(state.seed);

// Parallax factors per layer: 0 = infinitely far (barely moves), 1 = foreground.
const STAR_P = 0.06;
const CLOUD_P = 0.22;
const GRASS_P = 1.05;
const KODAMA_P = 0.8;
const treeParallax = (z) => lerp(0.45, 1.0, z);
const hillParallax = (z) => lerp(0.18, 0.5, z);

// How wide a given parallax layer must be so it always fills the screen as the
// camera pans the full [0, camMax] range.
function coverW(p) {
  return state.w + state.camMax * p;
}

function clampCam(x) {
  return clamp(x, 0, state.camMax);
}

function resize() {
  state.w = window.innerWidth;
  state.h = window.innerHeight;
  // Size-based so behaviour is deterministic (pointer media queries are
  // unreliable in some browsers/headless). Touch-target sizing lives in CSS.
  MOBILE = Math.min(state.w, state.h) < 680;
  // cap pixel ratio harder on mobile to keep the fill-rate manageable
  state.dpr = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2);
  state.horizon = state.h * 0.66;
  // The world extends a couple of screens wide — a little diorama to roam.
  state.worldW = state.w * (MOBILE ? 1.9 : 2.5);
  state.camMax = Math.max(0, state.worldW - state.w);
  if (!state.cameraInit) {
    state.camera.x = state.camMax / 2; // start in the middle of the world
    state.cameraInit = true;
  } else {
    state.camera.x = clampCam(state.camera.x);
  }
  canvas.width = Math.floor(state.w * state.dpr);
  canvas.height = Math.floor(state.h * state.dpr);
  canvas.style.width = state.w + "px";
  canvas.style.height = state.h + "px";
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  buildWorld(false);
}

function buildStars() {
  const r = makeRng(state.seed ^ 0x9e3779b9);
  state.stars = [];
  const cw = coverW(STAR_P);
  const n = Math.floor((cw * state.horizon) / (MOBILE ? 9000 : 6000));
  for (let i = 0; i < n; i++) {
    state.stars.push({
      x: r(), // normalized across the star layer
      y: r() * state.horizon,
      r: rand(r, 0.4, 1.5),
      tw: r() * TAU,
      tws: rand(r, 0.5, 2),
    });
  }
}

function buildHills() {
  const r = makeRng(state.seed ^ 0x12345);
  state.hills = [];
  const layers = 3;
  for (let l = 0; l < layers; l++) {
    const z = l / layers;
    const p = hillParallax(z);
    const cw = coverW(p);
    const pts = [];
    const segs = Math.max(10, Math.round(cw / 160));
    const base = state.horizon - (layers - l) * state.h * 0.05;
    const amp = state.h * (0.04 + l * 0.02);
    for (let i = 0; i <= segs; i++) {
      pts.push({
        fx: i / segs, // normalized across this hill layer
        y: base + Math.sin(i * 1.3 + l * 2 + r() * 2) * amp - r() * amp * 0.5,
      });
    }
    state.hills.push({ pts, z, p });
  }
}

function makeCloud(r, scatter) {
  const scale = rand(r, 0.7, 1.7);
  const count = Math.round(rand(r, 4, 7));
  const puffs = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1);
    puffs.push({
      dx: (f - 0.5) * rand(r, 60, 84),
      dy: -Math.sin(f * Math.PI) * rand(r, 12, 30) + rand(r, -5, 8),
      rx: rand(r, 30, 54),
      ry: rand(r, 24, 40),
    });
  }
  const span = 200 * scale;
  const cw = coverW(CLOUD_P);
  return {
    x: scatter ? rand(r, -span, cw) : -span, // world px across the cloud layer
    y: rand(r, state.h * 0.05, state.horizon * 0.5),
    scale,
    speed: rand(r, 4, 11) * (0.6 + scale * 0.4),
    depth: rand(r, 0.45, 1),
    puffs,
  };
}

function buildClouds() {
  const r = makeRng(state.seed ^ 0xc10d);
  state.clouds = [];
  const n = Math.max(3, Math.floor(coverW(CLOUD_P) / (MOBILE ? 340 : 280)));
  for (let i = 0; i < n; i++) state.clouds.push(makeCloud(r, true));
}

function buildGrass() {
  const r = makeRng(state.seed ^ 0x6213a);
  state.grass = [];
  const n = Math.floor(coverW(GRASS_P) / (MOBILE ? 9 : 6));
  for (let i = 0; i < n; i++) {
    const depth = r();
    state.grass.push({
      x: r(), // normalized across the grass layer
      baseY: state.horizon + (state.h - state.horizon) * lerp(0.45, 1.0, depth),
      h: rand(r, 16, 30) + depth * 34,
      lean: rand(r, -0.25, 0.25),
      phase: r() * TAU,
      hue: rand(r, 92, 134),
      sat: rand(r, 40, 64),
      w: rand(r, 1.4, 3),
    });
  }
  // draw nearer (lower) blades last so they sit in front
  state.grass.sort((a, b) => a.baseY - b.baseY);
}

function buildKodama() {
  const r = makeRng(state.seed ^ 0x0d0a);
  state.kodama = [];
  const n = Math.max(2, Math.floor(coverW(KODAMA_P) / (MOBILE ? 420 : 340)));
  for (let i = 0; i < n; i++) {
    state.kodama.push({
      x: r(), // normalized across the kodama layer
      y: state.horizon + (state.h - state.horizon) * rand(r, 0.12, 0.7),
      s: rand(r, 8, 15),
      bob: r() * TAU,
      bobSpeed: rand(r, 0.6, 1.3),
      turn: 0,
      turnTarget: 0,
      t: r() * 4,
      nextTurn: rand(r, 2, 6),
    });
  }
}

function buildTrees(keep) {
  const existing = keep ? state.trees : [];
  state.trees = [];
  // scale count with world width so density stays consistent per screen
  const n = Math.round(state.density * (state.worldW / state.w));
  for (let i = 0; i < n; i++) {
    const z = Math.pow(rng(), 0.7); // bias toward more far trees
    const x = rng();
    const tree = makeTree(rng, x, z);
    tree.grow = 1;
    state.trees.push(tree);
  }
  // sort far -> near for correct overlap
  state.trees.sort((a, b) => a.z - b.z);
  state.trees.push(...existing);
  state.trees.sort((a, b) => a.z - b.z);
  updateTreeCount();
}

function buildWeather() {
  state.leaves = [];
  const ln = Math.floor(state.w / (MOBILE ? 40 : 26));
  for (let i = 0; i < ln; i++) state.leaves.push(spawnLeaf(rng, state.w, state.h));

  state.fireflies = [];
  const fn = Math.floor(state.w / (MOBILE ? 40 : 26));
  for (let i = 0; i < fn; i++)
    state.fireflies.push(spawnFirefly(rng, state.w, state.h, state.horizon));
}

function buildWorld(regenTrees) {
  buildStars();
  buildHills();
  buildClouds();
  buildGrass();
  buildKodama();
  if (regenTrees || state.trees.length === 0) buildTrees(false);
  buildWeather();
}

/* ----------------------------------------------------------------------- */
/* Celestial maths.                                                        */
/* ----------------------------------------------------------------------- */
function celestial() {
  const elevation = Math.sin(state.phase * TAU - HALF_PI); // -1..1
  const dayAmount = clamp((elevation + 0.12) / 0.42, 0, 1);
  const starAlpha = clamp(1 - dayAmount * 1.7, 0, 1);

  // sun visible during day arc, moon during night arc
  const dayT = (state.phase - 0.25) / 0.5; // 0..1 across daytime
  const sun =
    dayT >= 0 && dayT <= 1
      ? {
          x: state.w * dayT,
          y: state.horizon - Math.sin(dayT * Math.PI) * state.h * 0.62,
        }
      : null;

  let nightT;
  if (state.phase >= 0.75) nightT = (state.phase - 0.75) / 0.5;
  else nightT = (state.phase + 0.25) / 0.5;
  const moon =
    nightT >= 0 && nightT <= 1
      ? {
          x: state.w * nightT,
          y: state.horizon - Math.sin(nightT * Math.PI) * state.h * 0.58,
        }
      : null;

  return { elevation, dayAmount, starAlpha, sun, moon };
}

/* ----------------------------------------------------------------------- */
/* Drawing.                                                                */
/* ----------------------------------------------------------------------- */
function drawSky(cel) {
  const { top, bot } = skyAt(state.phase);
  const g = ctx.createLinearGradient(0, 0, 0, state.horizon + state.h * 0.1);
  g.addColorStop(0, css(top));
  g.addColorStop(1, css(bot));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, state.w, state.horizon + state.h * 0.12);

  // stars
  if (cel.starAlpha > 0.01) {
    const cw = coverW(STAR_P);
    const off = state.camera.x * STAR_P;
    for (const s of state.stars) {
      const tw = 0.6 + 0.4 * Math.sin(state.time * s.tws + s.tw);
      ctx.globalAlpha = cel.starAlpha * tw;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(s.x * cw - off, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawBody(cel.sun, "#fff4d6", "#ffd27a", 26, 1);
  drawBody(cel.moon, "#eef2ff", "#c8d4ff", 20, cel.starAlpha);
}

function drawBody(pos, core, glow, radius, alpha) {
  if (!pos || alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(
    pos.x,
    pos.y,
    0,
    pos.x,
    pos.y,
    radius * 6
  );
  g.addColorStop(0, css(hex(glow), 0.45));
  g.addColorStop(1, css(hex(glow), 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius * 6, 0, TAU);
  ctx.fill();

  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function updateClouds(dt) {
  const drift = 1 + state.wind * 2.2;
  const cw = coverW(CLOUD_P);
  for (const cl of state.clouds) {
    cl.x += cl.speed * dt * drift;
    const span = 220 * cl.scale;
    if (cl.x - span > cw) cl.x = -span;
  }
}

function drawClouds(cel) {
  const light = cel.dayAmount;
  // warm rim during golden hours (sun low on the horizon)
  const warmth = clamp(1 - Math.abs(cel.elevation) / 0.4, 0, 1);
  let top = mix(hex("#2c3760"), hex("#ffffff"), 0.12 + light * 0.88);
  top = mix(top, hex("#fff0d2"), warmth * 0.5);
  let bottom = mix(hex("#1b2440"), hex("#c6d6ee"), 0.18 + light * 0.82);
  bottom = mix(bottom, hex("#f6c98c"), warmth * 0.45);
  const alpha = 0.4 + light * 0.55;
  const camOff = state.camera.x * CLOUD_P;

  for (const cl of state.clouds) {
    const baseX = cl.x - camOff;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of cl.puffs) {
      minY = Math.min(minY, cl.y + (p.dy - p.ry) * cl.scale);
      maxY = Math.max(maxY, cl.y + (p.dy + p.ry) * cl.scale);
    }
    // one gradient for the whole cloud => seamless overlaps
    const g = ctx.createLinearGradient(0, minY, 0, maxY);
    g.addColorStop(0, css(top));
    g.addColorStop(1, css(bottom));
    ctx.save();
    ctx.globalAlpha = alpha * cl.depth;
    ctx.fillStyle = g;
    for (const p of cl.puffs) {
      ctx.beginPath();
      ctx.ellipse(
        baseX + p.dx * cl.scale,
        cl.y + p.dy * cl.scale,
        p.rx * cl.scale,
        p.ry * cl.scale,
        0,
        0,
        TAU
      );
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawGround(cel) {
  const { bot } = skyAt(state.phase);
  const meadow = mix(hex("#3f7a45"), hex("#9fd06a"), cel.dayAmount * 0.8);
  const groundTop = mix(hex("#22381f"), meadow, 0.4 + cel.dayAmount * 0.4);
  const groundBot = mix(hex("#0a160d"), hex("#21401f"), cel.dayAmount * 0.5);
  const lightFar = mix(groundBot, groundTop, 0.6 + cel.dayAmount * 0.3);

  // lush rolling hills, lighter and hazier toward the back
  const skyBot = skyAt(state.phase).bot;
  for (const hill of state.hills) {
    // far hill (z~0) = soft yellow-green, near hill = deep green
    let green = mix(hex("#2f5d39"), hex("#8ec56a"), 1 - hill.z);
    green = mix(hex("#16271c"), green, 0.35 + cel.dayAmount * 0.65);
    const fade = lerp(0.55, 0.1, hill.z); // distant hills blend into sky
    ctx.fillStyle = css(mix(green, skyBot, fade));
    const cw = coverW(hill.p);
    const off = state.camera.x * hill.p;
    const pts = hill.pts;
    const x0 = pts[0].fx * cw - off;
    const xN = pts[pts.length - 1].fx * cw - off;
    ctx.beginPath();
    ctx.moveTo(x0, state.h);
    ctx.lineTo(x0, pts[0].y);
    for (const p of pts) ctx.lineTo(p.fx * cw - off, p.y);
    ctx.lineTo(xN, state.h);
    ctx.closePath();
    ctx.fill();
  }

  // ground plane
  const g = ctx.createLinearGradient(0, state.horizon, 0, state.h);
  g.addColorStop(0, css(mix(groundBot, lightFar, 0.7)));
  g.addColorStop(1, css(groundBot));
  ctx.fillStyle = g;
  ctx.fillRect(0, state.horizon - 2, state.w, state.h - state.horizon + 4);
}

function drawMist(cel) {
  const base = skyAt(state.phase).bot;
  const bands = 3;
  for (let i = 0; i < bands; i++) {
    const y = state.horizon - 10 + i * 16;
    const drift = Math.sin(state.time * 0.15 + i) * 30;
    ctx.fillStyle = css(base, 0.06 + i * 0.02);
    ctx.beginPath();
    ctx.ellipse(state.w / 2 + drift, y, state.w * 0.7, 22, 0, 0, TAU);
    ctx.fill();
  }
}

function drawTree(tree, cel) {
  // nearer trees (higher z) parallax more as the camera pans the world
  const tp = treeParallax(tree.z);
  const px = tree.x * coverW(tp) - state.camera.x * tp;
  const baseY = state.horizon + (state.h - state.horizon) * (0.05 + tree.z * 0.9);
  const scale = tree.scale;

  // atmospheric perspective: far trees fade into the sky
  const haze = (1 - tree.z) * 0.7;
  const skyBot = skyAt(state.phase).bot;

  // foliage colour reacts to time of day
  const light = 0.25 + cel.dayAmount * 0.6;
  const trunkBase = mix(hex("#241712"), hex("#5b4636"), light);

  const windNow = state.wind * (reduceMotion ? 0.15 : 1);

  const drawNode = (node, x, y, baseAngle) => {
    const grow = tree.grow;
    const swayDepth = Math.pow(node.depth + 1, 1.25);
    const sway =
      windNow *
      0.05 *
      swayDepth *
      Math.sin(state.time * 1.6 + tree.phase + node.depth * 0.5);
    const ang = baseAngle + node.angle + sway;
    const len = node.length * scale * grow;
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;

    if (node.leaf) {
      drawFoliage(tree, node, ex, ey, scale, light, haze, skyBot);
      return;
    }

    ctx.strokeStyle = css(mix(trunkBase, skyBot, haze), 1);
    ctx.lineWidth = Math.max(0.6, node.width * scale);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    for (const c of node.children) drawNode(c, ex, ey, ang);
  };

  drawNode(tree.root, px, baseY, -HALF_PI);
}

function drawFoliage(tree, node, x, y, scale, light, haze, skyBot) {
  const size = node.leafSize * scale;
  const hue = tree.hue + node.hueShift;
  const lum = clamp(22 + light * 38, 10, 70);
  const leafCol = `hsl(${hue}, ${tree.sat}%, ${lum}%)`;
  ctx.save();
  ctx.globalAlpha = 0.55 * (1 - haze * 0.6);
  // soft canopy cluster
  ctx.fillStyle = leafCol;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.4 * (1 - haze * 0.6);
  ctx.beginPath();
  ctx.arc(x - size * 0.4, y - size * 0.3, size * 0.7, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + size * 0.4, y - size * 0.2, size * 0.6, 0, TAU);
  ctx.fill();
  // sun-side highlight for a soft, painterly canopy
  ctx.globalAlpha = 0.34 * (1 - haze * 0.6);
  ctx.fillStyle = `hsl(${hue}, ${tree.sat}%, ${clamp(lum + 16, 12, 84)}%)`;
  ctx.beginPath();
  ctx.arc(x - size * 0.32, y - size * 0.42, size * 0.55, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawGrass(cel) {
  const light = 0.25 + cel.dayAmount * 0.6;
  const wind = state.wind * (reduceMotion ? 0.2 : 1);
  const cw = coverW(GRASS_P);
  const off = state.camera.x * GRASS_P;
  ctx.lineCap = "round";
  for (const b of state.grass) {
    const bx = b.x * cw - off;
    const sway = Math.sin(state.time * 1.8 + b.phase) * wind * b.h * 0.5;
    const tipX = bx + b.lean * b.h + sway;
    const tipY = b.baseY - b.h;
    const ctrlX = bx + b.lean * b.h * 0.5 + sway * 0.5;
    const ctrlY = b.baseY - b.h * 0.55;
    const lum = clamp(14 + light * 34, 8, 60);
    ctx.strokeStyle = `hsl(${b.hue}, ${b.sat}%, ${lum}%)`;
    ctx.lineWidth = b.w;
    ctx.beginPath();
    ctx.moveTo(bx, b.baseY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    ctx.stroke();
  }
}

function drawKodama(dt, cel) {
  if (!state.spiritsOn) return;
  const vis = 0.42 + (1 - cel.dayAmount) * 0.45;
  const cw = coverW(KODAMA_P);
  const off = state.camera.x * KODAMA_P;
  for (const k of state.kodama) {
    k.bob += k.bobSpeed * dt;
    k.t += dt;
    if (k.t > k.nextTurn) {
      k.t = 0;
      k.nextTurn = rand(rng, 2, 6);
      k.turnTarget = rand(rng, -0.5, 0.5);
    }
    k.turn += (k.turnTarget - k.turn) * Math.min(1, dt * 4);
    const bobY = Math.sin(k.bob) * 2.2;
    const x = k.x * cw - off;
    const y = k.y + bobY;
    const s = k.s;

    ctx.save();
    ctx.globalAlpha = vis;
    const g = ctx.createRadialGradient(x, y, 0, x, y, s * 3);
    g.addColorStop(0, "rgba(236,246,255,0.5)");
    g.addColorStop(1, "rgba(236,246,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, s * 3, 0, TAU);
    ctx.fill();

    ctx.fillStyle = "rgba(245,249,253,0.96)";
    ctx.beginPath();
    ctx.ellipse(x, y + s * 0.7, s * 0.6, s * 0.82, 0, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.translate(x, y - s * 0.15);
    ctx.rotate(k.turn);
    ctx.beginPath();
    ctx.arc(0, 0, s, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(44,58,74,0.85)";
    ctx.beginPath();
    ctx.arc(-s * 0.32, -s * 0.05, s * 0.15, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.32, -s * 0.05, s * 0.15, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, s * 0.34, s * 0.17, s * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawBloom(cel) {
  if (!cel.sun || cel.dayAmount < 0.05) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const r = state.h * 0.6;
  const g = ctx.createRadialGradient(
    cel.sun.x,
    cel.sun.y,
    0,
    cel.sun.x,
    cel.sun.y,
    r
  );
  g.addColorStop(0, `rgba(255,240,200,${0.12 * cel.dayAmount})`);
  g.addColorStop(1, "rgba(255,240,200,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, state.w, state.h);
  ctx.restore();
}

function drawLeaves(dt) {
  if (!state.leavesOn) return;
  const windPx = state.wind * 60;
  for (const lf of state.leaves) {
    lf.y += lf.vy * dt;
    lf.x += Math.sin(state.time * lf.sway + lf.swayPhase) * 14 * dt + windPx * dt * 0.4;
    lf.rot += lf.vr * dt;
    if (lf.y > state.h + 20 || lf.x > state.w + 30) {
      Object.assign(lf, spawnLeaf(rng, state.w, state.h));
      lf.y = -10;
      lf.x = rng() * state.w;
    }
    ctx.save();
    ctx.translate(lf.x, lf.y);
    ctx.rotate(lf.rot);
    ctx.globalAlpha = lf.alpha;
    ctx.fillStyle = `hsl(${lf.hue}, 60%, 52%)`;
    ctx.beginPath();
    ctx.ellipse(0, 0, lf.size, lf.size * 0.55, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawFireflies(dt, cel) {
  const nightness = clamp(1 - cel.dayAmount * 1.6, 0, 1);
  if (nightness < 0.05) return;
  for (const f of state.fireflies) {
    f.t += f.speed * dt;
    if (f.t >= 1) {
      f.t = 0;
      f.x = f.bx;
      f.y = f.by;
      f.bx = clamp(f.x + rand(rng, -120, 120), 0, state.w);
      f.by = clamp(f.y + rand(rng, -90, 90), state.horizon * 0.5, state.h * 0.97);
    }
    const t = smoothstep(f.t);
    const cx = lerp(f.x, f.bx, t);
    const cy = lerp(f.y, f.by, t);
    f.blink += f.blinkSpeed * dt;
    const glow = (0.5 + 0.5 * Math.sin(f.blink)) * nightness;
    ctx.save();
    ctx.globalAlpha = glow * 0.9;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f.size * 6);
    g.addColorStop(0, "rgba(190,255,150,0.9)");
    g.addColorStop(1, "rgba(190,255,150,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, f.size * 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#eaffce";
    ctx.beginPath();
    ctx.arc(cx, cy, f.size, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawVignette(cel) {
  const g = ctx.createRadialGradient(
    state.w / 2,
    state.h * 0.5,
    state.h * 0.3,
    state.w / 2,
    state.h * 0.55,
    state.h * 0.9
  );
  const dark = 0.28 + (1 - cel.dayAmount) * 0.22;
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${dark})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, state.w, state.h);

  // soft shadow at the world's edges, fading in as you reach them
  const ew = Math.min(140, state.w * 0.18);
  const leftNear = clamp(1 - state.camera.x / 160, 0, 1);
  const rightNear = clamp(1 - (state.camMax - state.camera.x) / 160, 0, 1);
  if (leftNear > 0.01) {
    const lg = ctx.createLinearGradient(0, 0, ew, 0);
    lg.addColorStop(0, `rgba(0,0,0,${0.35 * leftNear})`);
    lg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, ew, state.h);
  }
  if (rightNear > 0.01) {
    const rg = ctx.createLinearGradient(state.w, 0, state.w - ew, 0);
    rg.addColorStop(0, `rgba(0,0,0,${0.35 * rightNear})`);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(state.w - ew, 0, ew, state.h);
  }
}

/* ----------------------------------------------------------------------- */
/* Loop.                                                                   */
/* ----------------------------------------------------------------------- */
let last = performance.now();
let rafId = 0;
state.time = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;

  if (state.autoTime && !reduceMotion) {
    state.phase = (state.phase + dt / 120) % 1; // full cycle ~2 min
    syncTimeUI();
  }

  // grow newly planted trees
  for (const t of state.trees) {
    if (t.grow < 1) t.grow = clamp(t.grow + dt * 1.6, 0, 1);
  }

  // camera inertia after a flick
  if (!dragging && Math.abs(state.camera.vx) > 0.1) {
    state.camera.x += state.camera.vx;
    state.camera.vx *= 0.92;
    const c = clampCam(state.camera.x);
    if (c !== state.camera.x) {
      state.camera.x = c;
      state.camera.vx = 0;
    }
  }

  updateClouds(dt);
  const cel = celestial();

  ctx.clearRect(0, 0, state.w, state.h);
  drawSky(cel);
  drawClouds(cel);
  drawGround(cel);
  drawMist(cel);
  for (const tree of state.trees) drawTree(tree, cel);
  drawGrass(cel);
  drawLeaves(dt);
  drawKodama(dt, cel);
  drawFireflies(dt, cel);
  drawBloom(cel);
  drawVignette(cel);

  rafId = requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------------- */
/* Interaction + UI wiring.                                                */
/* ----------------------------------------------------------------------- */
function plantAt(clientX, clientY) {
  // y position controls depth: higher up (near horizon) = farther away
  const groundFrac = clamp(
    (clientY - state.horizon) / (state.h - state.horizon),
    0,
    1
  );
  const z = clamp(0.1 + groundFrac, 0.1, 1);
  // convert the tapped screen point into this tree's world position
  const tp = treeParallax(z);
  const x = clamp((clientX + state.camera.x * tp) / coverW(tp), 0, 1);
  const tree = makeTree(rng, x, z);
  tree.grow = 0;
  state.trees.push(tree);
  state.trees.sort((a, b) => a.z - b.z);
  updateTreeCount();
}

// Drag to pan the world; a tap (no real drag) plants a tree.
let dragging = false;
let pointerDown = false;
let prevX = 0;
let downX = 0;
let downY = 0;
let dragDist = 0;

canvas.addEventListener("pointerdown", (e) => {
  if (e.target !== canvas) return;
  pointerDown = true;
  dragging = false;
  prevX = downX = e.clientX;
  downY = e.clientY;
  dragDist = 0;
  state.camera.vx = 0;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointerDown) return;
  const dx = e.clientX - prevX;
  prevX = e.clientX;
  dragDist += Math.abs(dx);
  if (dragDist > 5) dragging = true;
  state.camera.x = clampCam(state.camera.x - dx);
  state.camera.vx = state.camera.vx * 0.4 + -dx * 0.6;
});

function endPointer(e) {
  if (!pointerDown) return;
  pointerDown = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {}
  if (!dragging) {
    plantAt(downX, downY); // it was a tap, not a pan
    state.camera.vx = 0;
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.camera.x = clampCam(state.camera.x + d);
    state.camera.vx = 0;
  },
  { passive: false }
);

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") state.camera.x = clampCam(state.camera.x - 70);
  else if (e.key === "ArrowRight") state.camera.x = clampCam(state.camera.x + 70);
});

const $ = (id) => document.getElementById(id);

const timeRange = $("timeRange");
const timeValue = $("timeValue");
const autoTime = $("autoTime");
const windRange = $("windRange");
const densityRange = $("densityRange");
const leavesToggle = $("leaves");
const spiritsToggle = $("spirits");
const treeCount = $("treeCount");

function timeLabel(p) {
  if (p < 0.05 || p >= 0.93) return "midnight";
  if (p < 0.2) return "deep night";
  if (p < 0.28) return "dawn";
  if (p < 0.42) return "morning";
  if (p < 0.58) return "midday";
  if (p < 0.7) return "afternoon";
  if (p < 0.78) return "sunset";
  if (p < 0.86) return "dusk";
  return "night";
}

function syncTimeUI() {
  timeRange.value = String(Math.round(state.phase * 1000));
  timeValue.textContent = timeLabel(state.phase);
}

function updateTreeCount() {
  const n = state.trees.length;
  treeCount.textContent = `${n} tree${n === 1 ? "" : "s"}`;
}

timeRange.addEventListener("input", () => {
  state.phase = Number(timeRange.value) / 1000;
  state.autoTime = false;
  autoTime.checked = false;
  timeValue.textContent = timeLabel(state.phase);
});

autoTime.addEventListener("change", () => {
  state.autoTime = autoTime.checked;
});

windRange.addEventListener("input", () => {
  state.wind = Number(windRange.value) / 100;
});

densityRange.addEventListener("input", () => {
  state.density = Number(densityRange.value);
});
densityRange.addEventListener("change", () => {
  buildTrees(false);
});

leavesToggle.addEventListener("change", () => {
  state.leavesOn = leavesToggle.checked;
});

spiritsToggle.addEventListener("change", () => {
  state.spiritsOn = spiritsToggle.checked;
});

$("plant").addEventListener("click", () => {
  const burst = Math.max(4, Math.floor(state.density / 3));
  for (let i = 0; i < burst; i++) {
    const x = rng();
    const z = clamp(0.15 + rng() * 0.85, 0.1, 1);
    const tree = makeTree(rng, x, z);
    tree.grow = 0;
    state.trees.push(tree);
  }
  state.trees.sort((a, b) => a.z - b.z);
  updateTreeCount();
});

$("reset").addEventListener("click", () => {
  state.seed = (Math.random() * 1e9) >>> 0;
  rng = makeRng(state.seed);
  state.trees = [];
  buildWorld(true);
});

// collapsible panel
const panel = $("panel");
$("panelToggle").addEventListener("click", () => {
  const collapsed = panel.classList.toggle("is-collapsed");
  $("panelToggle").setAttribute("aria-expanded", String(!collapsed));
});

// Debounced resize so frequent mobile viewport changes (URL bar show/hide,
// pinch) don't thrash the world rebuild.
let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 150);
}
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", onResize);
}

// Pause rendering while the tab/app is backgrounded to save battery.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (!rafId) {
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }
});

// init
const smallView = Math.min(window.innerWidth, window.innerHeight) < 680;
if (smallView) densityRange.value = "9"; // lighter default scene on phones
if (window.innerWidth < 560) {
  panel.classList.add("is-collapsed"); // start tidy; tap "controls" to open
  $("panelToggle").setAttribute("aria-expanded", "false");
}

state.wind = Number(windRange.value) / 100;
state.density = Number(densityRange.value);
state.leavesOn = leavesToggle.checked;
state.spiritsOn = spiritsToggle.checked;
state.autoTime = autoTime.checked;
state.phase = Number(timeRange.value) / 1000;

// optional deep-link: ?t=0.5 sets time of day and pauses the cycle
const params = new URLSearchParams(location.search);
if (params.has("t")) {
  const t = clamp(parseFloat(params.get("t")), 0, 0.999);
  if (!Number.isNaN(t)) {
    state.phase = t;
    state.autoTime = false;
    autoTime.checked = false;
  }
}

// optional deep-link: ?cam=0..1 sets the starting scroll position in the world
let initialCamFrac = NaN;
if (params.has("cam")) initialCamFrac = clamp(parseFloat(params.get("cam")), 0, 1);

resize();
if (!Number.isNaN(initialCamFrac)) {
  state.camera.x = clampCam(initialCamFrac * state.camMax);
}
syncTimeUI();
rafId = requestAnimationFrame(frame);
