// Digital Forest — a procedurally generated, living canvas world.
// No dependencies. Everything (trees, sky, weather) is drawn frame by frame.

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

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
const SKY_KEYS = [
  { p: 0.0, top: hex("#05070f"), bot: hex("#0d1430") },
  { p: 0.22, top: hex("#1b1838"), bot: hex("#4a3358") },
  { p: 0.27, top: hex("#3a5d86"), bot: hex("#f0926b") },
  { p: 0.34, top: hex("#5fa8d6"), bot: hex("#d7eeff") },
  { p: 0.5, top: hex("#4a90d9"), bot: hex("#c4e6ff") },
  { p: 0.68, top: hex("#5b84c5"), bot: hex("#ffe6c2") },
  { p: 0.74, top: hex("#2f3f73"), bot: hex("#f2794b") },
  { p: 0.8, top: hex("#161a3c"), bot: hex("#3c2c5e") },
  { p: 1.0, top: hex("#05070f"), bot: hex("#0d1430") },
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
  const maxDepth = Math.round(rand(rng, 6, 9));
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
  pointer: { x: 0.5, y: 0.5 },
  seed: (Math.random() * 1e9) >>> 0,
};

let rng = makeRng(state.seed);

function resize() {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.w = window.innerWidth;
  state.h = window.innerHeight;
  state.horizon = state.h * 0.66;
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
  const n = Math.floor((state.w * state.h) / 6000);
  for (let i = 0; i < n; i++) {
    state.stars.push({
      x: r() * state.w,
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
    const pts = [];
    const segs = 8;
    const base = state.horizon - (layers - l) * state.h * 0.05;
    const amp = state.h * (0.04 + l * 0.02);
    for (let i = 0; i <= segs; i++) {
      pts.push({
        x: (i / segs) * state.w,
        y: base + Math.sin(i * 1.3 + l * 2 + r() * 2) * amp - r() * amp * 0.5,
      });
    }
    state.hills.push({ pts, z: l / layers });
  }
}

function buildTrees(keep) {
  const existing = keep ? state.trees : [];
  state.trees = [];
  const n = state.density;
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
  const ln = Math.floor(state.w / 26);
  for (let i = 0; i < ln; i++) state.leaves.push(spawnLeaf(rng, state.w, state.h));

  state.fireflies = [];
  const fn = Math.floor(state.w / 26);
  for (let i = 0; i < fn; i++)
    state.fireflies.push(spawnFirefly(rng, state.w, state.h, state.horizon));
}

function buildWorld(regenTrees) {
  buildStars();
  buildHills();
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
    for (const s of state.stars) {
      const tw = 0.6 + 0.4 * Math.sin(state.time * s.tws + s.tw);
      ctx.globalAlpha = cel.starAlpha * tw;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
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

function drawGround(cel) {
  const { bot } = skyAt(state.phase);
  const groundTop = mix(hex("#1d3326"), bot, 0.25);
  const groundBot = hex("#0a1410");
  const lightFar = mix(groundBot, groundTop, 0.6 + cel.dayAmount * 0.3);

  // distant hills
  for (const hill of state.hills) {
    const shade = mix(skyAt(state.phase).bot, hex("#15241b"), 0.4 + hill.z * 0.4);
    const fade = lerp(0.5, 1, hill.z);
    ctx.fillStyle = css(mix(skyAt(state.phase).bot, shade, fade));
    ctx.beginPath();
    ctx.moveTo(0, state.h);
    ctx.lineTo(0, hill.pts[0].y);
    for (const p of hill.pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(state.w, state.h);
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
  const px = tree.x * state.w;
  // parallax: nearer trees shift more with pointer
  const parX = (state.pointer.x - 0.5) * tree.z * 40;
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

  drawNode(tree.root, px + parX, baseY, -HALF_PI);
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
}

/* ----------------------------------------------------------------------- */
/* Loop.                                                                   */
/* ----------------------------------------------------------------------- */
let last = performance.now();
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

  const cel = celestial();

  ctx.clearRect(0, 0, state.w, state.h);
  drawSky(cel);
  drawGround(cel);
  drawMist(cel);
  for (const tree of state.trees) drawTree(tree, cel);
  drawLeaves(dt);
  drawFireflies(dt, cel);
  drawVignette(cel);

  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------------- */
/* Interaction + UI wiring.                                                */
/* ----------------------------------------------------------------------- */
function plantAt(clientX, clientY) {
  const x = clientX / state.w;
  // y position controls depth: higher up (near horizon) = farther away
  const groundFrac = clamp(
    (clientY - state.horizon) / (state.h - state.horizon),
    0,
    1
  );
  const z = clamp(0.1 + groundFrac, 0.1, 1);
  const tree = makeTree(rng, x, z);
  tree.grow = 0;
  state.trees.push(tree);
  state.trees.sort((a, b) => a.z - b.z);
  updateTreeCount();
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.target !== canvas) return;
  plantAt(e.clientX, e.clientY);
});

canvas.addEventListener("pointermove", (e) => {
  state.pointer.x = e.clientX / state.w;
  state.pointer.y = e.clientY / state.h;
});

const $ = (id) => document.getElementById(id);

const timeRange = $("timeRange");
const timeValue = $("timeValue");
const autoTime = $("autoTime");
const windRange = $("windRange");
const densityRange = $("densityRange");
const leavesToggle = $("leaves");
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

window.addEventListener("resize", resize);

// init
state.wind = Number(windRange.value) / 100;
state.density = Number(densityRange.value);
state.leavesOn = leavesToggle.checked;
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

resize();
syncTimeUI();
requestAnimationFrame(frame);
