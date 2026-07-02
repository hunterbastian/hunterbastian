// High Seas — a little endless sailing game.
// Single canvas, no build step, no images: everything is drawn with paths and
// gradients so it stays crisp at any size (including a Retina iPhone screen).

/* Seeded RNG ------------------------------------------------------------- */
// mulberry32: tiny, fast, good enough for game feel. Lets ?seed= reproduce a
// run exactly, which is handy for the smoke test and for sharing a "seed".
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed")) || Math.floor(Math.random() * 1e9);
const rng = mulberry32(seed);
const AUTOSTART = params.has("autostart");
const DEMO = params.has("demo");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + rng() * (hi - lo);
const choose = (arr) => arr[Math.floor(rng() * arr.length)];
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/* Canvas & DOM ------------------------------------------------------------ */
const canvas = document.getElementById("sea");
const ctx = canvas.getContext("2d");
const distanceValue = document.getElementById("distanceValue");
const coinsValue = document.getElementById("coinsValue");
const bestValue = document.getElementById("bestValue");
const muteBtn = document.getElementById("muteBtn");
const menuOverlay = document.getElementById("menuOverlay");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const startBtn = document.getElementById("startBtn");
const retryBtn = document.getElementById("retryBtn");
const gameOverReason = document.getElementById("gameOverReason");
const finalDistance = document.getElementById("finalDistance");
const finalCoins = document.getElementById("finalCoins");
const finalNearMisses = document.getElementById("finalNearMisses");
const finalScore = document.getElementById("finalScore");
const finalBest = document.getElementById("finalBest");

let W = 0;
let H = 0;
let DPR = 1;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

/* Persistence -------------------------------------------------------------- */
const STORAGE_BEST = "highSeas.bestDistance";
const STORAGE_MUTE = "highSeas.muted";
let bestDistance = Number(localStorage.getItem(STORAGE_BEST)) || 0;
let muted = localStorage.getItem(STORAGE_MUTE) === "1";
bestValue.textContent = `${Math.floor(bestDistance)}m`;

/* Sound --------------------------------------------------------------------
 * Tiny procedural sound effects via WebAudio — no audio files to load. The
 * context is created lazily on the first user gesture, as iOS requires. */
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function tone({ freq = 440, duration = 0.12, type = "sine", gain = 0.18, sweep = 0 }) {
  if (muted) return;
  const ac = getAudio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  if (sweep) osc.frequency.linearRampToValueAtTime(freq + sweep, ac.currentTime + duration);
  amp.gain.setValueAtTime(gain, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + duration + 0.02);
}

function noiseBurst({ duration = 0.35, cutoff = 900, gain = 0.35 }) {
  if (muted) return;
  const ac = getAudio();
  if (!ac) return;
  const bufferSize = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(gain, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start();
}

const sfx = {
  coin: () => tone({ freq: 880, duration: 0.1, type: "triangle", gain: 0.16, sweep: 260 }),
  bottle: () => {
    tone({ freq: 520, duration: 0.16, type: "sine", gain: 0.16, sweep: 180 });
    setTimeout(() => tone({ freq: 780, duration: 0.14, type: "sine", gain: 0.12 }), 70);
  },
  fish: () => tone({ freq: 660, duration: 0.08, type: "sine", gain: 0.12, sweep: -120 }),
  nearMiss: () => tone({ freq: 340, duration: 0.09, type: "square", gain: 0.08 }),
  crash: () => {
    noiseBurst({ duration: 0.5, cutoff: 700, gain: 0.4 });
    tone({ freq: 110, duration: 0.4, type: "sawtooth", gain: 0.2, sweep: -60 });
  },
  thunder: () => noiseBurst({ duration: 0.9, cutoff: 400, gain: 0.22 }),
};

function setMuted(next) {
  muted = next;
  localStorage.setItem(STORAGE_MUTE, muted ? "1" : "0");
  muteBtn.textContent = muted ? "🔇" : "🔊";
  muteBtn.classList.toggle("is-muted", muted);
}
setMuted(muted);
muteBtn.addEventListener("click", () => setMuted(!muted));

/* Game constants ------------------------------------------------------------ */
const LANE_MARGIN = 46; // keep the boat's hitbox off the very edges
const BOAT_RADIUS = 20;
const BASE_SPEED = 150; // px/s of world scroll at the very start
const MAX_SPEED = 430;
const SPEED_RAMP = 3.1; // px/s gained per second survived
const PIXELS_PER_METER = 14;
const FOLLOW_RATE = 9; // how eagerly the boat chases the pointer
const KEY_STEER_SPEED = 640; // px/s when steering with the keyboard

/* State ---------------------------------------------------------------------- */
const STATE = { MENU: "menu", PLAYING: "playing", GAMEOVER: "gameover" };
let state = STATE.MENU;

const boat = {
  x: 0,
  targetX: 0,
  prevX: 0,
  vx: 0,
  tilt: 0,
  bobPhase: rand(0, Math.PI * 2),
};

let distance = 0; // meters travelled this run
let speed = BASE_SPEED;
let coinsCollected = 0;
let bonusScore = 0;
let nearMisses = 0;
let elapsed = 0; // seconds this run
let shake = 0;
let flash = 0; // lightning flash intensity 0..1
let storm = 0; // storm intensity 0..1, eased toward stormTarget
let stormTarget = 0;
let nextStormAt = rand(26, 38); // seconds of calm sailing before the first storm
let stormTimer = 0;

let entities = []; // rocks, mines, coins, bottles, fish currently on screen
let particles = [];
let popups = []; // floating "+10" style score text
let spawnTimer = 0;
let lastFrame = 0;

function resetRun() {
  boat.x = W / 2;
  boat.targetX = W / 2;
  boat.prevX = W / 2;
  boat.vx = 0;
  boat.tilt = 0;
  distance = 0;
  speed = BASE_SPEED;
  coinsCollected = 0;
  bonusScore = 0;
  nearMisses = 0;
  elapsed = 0;
  shake = 0;
  flash = 0;
  storm = 0;
  stormTarget = 0;
  nextStormAt = rand(26, 38);
  stormTimer = 0;
  entities = [];
  particles = [];
  popups = [];
  spawnTimer = 0.6;
}

/* Input ----------------------------------------------------------------------
 * Drag anywhere on the sea to steer — the boat follows your finger/pointer
 * horizontally, offset so it doesn't jump to your first touch point. */
let dragging = false;
let dragOffset = 0;
const keys = { left: false, right: false };

function pointerX(evt) {
  return evt.touches ? evt.touches[0].clientX : evt.clientX;
}

canvas.addEventListener("pointerdown", (evt) => {
  dragging = true;
  dragOffset = pointerX(evt) - boat.x;
  canvas.setPointerCapture?.(evt.pointerId);
});
canvas.addEventListener("pointermove", (evt) => {
  if (!dragging || state !== STATE.PLAYING) return;
  boat.targetX = clamp(pointerX(evt) - dragOffset, LANE_MARGIN, W - LANE_MARGIN);
});
canvas.addEventListener("pointerup", () => (dragging = false));
canvas.addEventListener("pointercancel", () => (dragging = false));

window.addEventListener("keydown", (evt) => {
  if (evt.key === "ArrowLeft" || evt.key === "a" || evt.key === "A") keys.left = true;
  if (evt.key === "ArrowRight" || evt.key === "d" || evt.key === "D") keys.right = true;
});
window.addEventListener("keyup", (evt) => {
  if (evt.key === "ArrowLeft" || evt.key === "a" || evt.key === "A") keys.left = false;
  if (evt.key === "ArrowRight" || evt.key === "d" || evt.key === "D") keys.right = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) lastFrame = 0;
});

/* Spawning --------------------------------------------------------------------
 * Obstacles and pickups spawn just above the top edge and drift down with the
 * world. A spawn always leaves a guaranteed gap somewhere across the width so
 * the lane is never fully blocked. */
const OBSTACLE_KINDS = ["rock", "mine"];
const PICKUP_KINDS = ["coin", "coin", "coin", "fish", "bottle"];

function spawnWave() {
  const laneWidth = W - LANE_MARGIN * 2;
  const wantsObstacle = rng() < 0.62 + Math.min(0.22, elapsed / 240);
  const count = wantsObstacle ? (rng() < 0.35 ? 2 : 1) : 0;

  const gapWidth = Math.max(110, laneWidth * rand(0.32, 0.46));
  const gapCenter = rand(LANE_MARGIN + gapWidth / 2, W - LANE_MARGIN - gapWidth / 2);

  for (let i = 0; i < count; i++) {
    let x;
    let tries = 0;
    do {
      x = rand(LANE_MARGIN + 24, W - LANE_MARGIN - 24);
      tries++;
    } while (Math.abs(x - gapCenter) < gapWidth / 2 && tries < 12);
    entities.push({
      kind: choose(OBSTACLE_KINDS),
      x,
      y: -60,
      r: rand(20, 30),
      seed: rand(0, Math.PI * 2),
      passed: false,
    });
  }

  // Sprinkle a pickup or two into (or near) the safe gap, so risk/reward stays
  // interesting without forcing the player through danger to get them.
  if (rng() < 0.85) {
    const px = clamp(gapCenter + rand(-gapWidth / 2, gapWidth / 2), LANE_MARGIN, W - LANE_MARGIN);
    entities.push({
      kind: choose(PICKUP_KINDS),
      x: px,
      y: -80,
      r: 14,
      seed: rand(0, Math.PI * 2),
      collected: false,
    });
  }
}

/* Update ------------------------------------------------------------------- */
function updateStorm(dt) {
  stormTimer -= dt;
  if (stormTimer <= 0) {
    if (stormTarget === 0 && elapsed > nextStormAt) {
      stormTarget = 1;
      stormTimer = rand(9, 15);
    } else if (stormTarget === 1) {
      stormTarget = 0;
      nextStormAt = elapsed + rand(40, 60);
      stormTimer = 4;
    }
  }
  storm = lerp(storm, stormTarget, 1 - Math.pow(0.001, dt));
  if (storm > 0.35 && rng() < dt * 0.5 * storm) {
    flash = 1;
    sfx.thunder();
  }
  flash = Math.max(0, flash - dt * 1.6);
}

function updateBoat(dt) {
  if (state === STATE.PLAYING) {
    if (DEMO) {
      // Simple autopilot for the smoke test / screenshot: steer away from the
      // nearest upcoming obstacle, otherwise drift back toward the center.
      let danger = null;
      for (const e of entities) {
        if (e.kind !== "rock" && e.kind !== "mine") continue;
        if (e.y < -40 || e.y > H * 0.75) continue;
        if (!danger || e.y > danger.y) danger = e;
      }
      if (danger && Math.abs(danger.x - boat.x) < 90) {
        boat.targetX = danger.x < boat.x ? W - LANE_MARGIN : LANE_MARGIN;
      } else {
        boat.targetX = lerp(boat.targetX, W / 2, 0.01);
      }
    } else if (keys.left || keys.right) {
      const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      boat.targetX = clamp(boat.targetX + dir * KEY_STEER_SPEED * dt, LANE_MARGIN, W - LANE_MARGIN);
    }
    // A gentle crosswind during storms nudges the boat, adding a bit of
    // steering challenge without feeling unfair.
    if (storm > 0.1) {
      boat.targetX = clamp(
        boat.targetX + Math.sin(elapsed * 0.6) * storm * 26 * dt,
        LANE_MARGIN,
        W - LANE_MARGIN
      );
    }
  }
  boat.prevX = boat.x;
  boat.x = lerp(boat.x, boat.targetX, 1 - Math.pow(0.001, dt * FOLLOW_RATE * 0.1));
  boat.vx = (boat.x - boat.prevX) / dt || 0;
  boat.tilt = lerp(boat.tilt, clamp(-boat.vx * 0.0035, -0.5, 0.5), 1 - Math.pow(0.0001, dt));

  if (state === STATE.PLAYING && Math.abs(boat.vx) > 12 && rng() < dt * 14) {
    particles.push({
      x: boat.x + rand(-6, 6),
      y: boatY() + 22 + rand(-4, 4),
      vx: -boat.vx * 0.08 + rand(-14, 14),
      vy: rand(18, 34),
      life: 0.5,
      maxLife: 0.5,
      size: rand(2, 4),
      color: "rgba(235,247,255,0.85)",
    });
  }
}

function boatY() {
  return H * 0.7;
}

function updateWorld(dt) {
  distance += speed * dt;
  speed = Math.min(MAX_SPEED, BASE_SPEED + elapsed * SPEED_RAMP) + storm * 40;
  elapsed += dt;

  spawnTimer -= dt;
  const spawnInterval = clamp(1.05 - elapsed * 0.006, 0.42, 1.05) / (1 + storm * 0.3);
  if (spawnTimer <= 0) {
    spawnWave();
    spawnTimer = spawnInterval;
  }

  const dy = speed * dt;
  for (const e of entities) e.y += dy;
  entities = entities.filter((e) => e.y < H + 80);
}

function circleHit(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy < (ar + br) * (ar + br);
}

function collectPickup(e) {
  e.collected = true;
  const burstColor = e.kind === "coin" ? "255,210,122" : e.kind === "bottle" ? "111,227,208" : "220,235,245";
  for (let i = 0; i < 10; i++) {
    const a = rand(0, Math.PI * 2);
    particles.push({
      x: e.x,
      y: e.y,
      vx: Math.cos(a) * rand(30, 90),
      vy: Math.sin(a) * rand(30, 90) - 20,
      life: 0.5,
      maxLife: 0.5,
      size: rand(2, 4),
      color: `rgba(${burstColor},0.9)`,
    });
  }

  if (e.kind === "coin") {
    coinsCollected += 1;
    bonusScore += 10;
    sfx.coin();
    popups.push({ x: e.x, y: e.y, text: "+10", life: 0.8, maxLife: 0.8, color: "#ffd27a" });
  } else if (e.kind === "bottle") {
    coinsCollected += 1;
    bonusScore += 40;
    sfx.bottle();
    popups.push({ x: e.x, y: e.y, text: "+40", life: 0.9, maxLife: 0.9, color: "#6fe3d0" });
  } else if (e.kind === "fish") {
    coinsCollected += 1;
    bonusScore += 5;
    sfx.fish();
    popups.push({ x: e.x, y: e.y, text: "+5", life: 0.7, maxLife: 0.7, color: "#dcebf5" });
  }
}

function crash(reasonText) {
  state = STATE.GAMEOVER;
  shake = 1;
  sfx.crash();
  const by = boatY();
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2);
    particles.push({
      x: boat.x,
      y: by,
      vx: Math.cos(a) * rand(60, 220),
      vy: Math.sin(a) * rand(60, 220) - 40,
      life: rand(0.5, 1),
      maxLife: 1,
      size: rand(2, 5),
      color: "rgba(235,247,255,0.95)",
    });
  }

  const meters = Math.floor(distance / PIXELS_PER_METER);
  if (meters > bestDistance) {
    bestDistance = meters;
    localStorage.setItem(STORAGE_BEST, String(bestDistance));
  }

  gameOverReason.textContent = reasonText;
  finalDistance.textContent = `${meters}m`;
  finalCoins.textContent = String(coinsCollected);
  finalNearMisses.textContent = String(nearMisses);
  finalScore.textContent = String(meters + bonusScore);
  finalBest.textContent = `${bestDistance}m`;
  gameOverOverlay.classList.remove("overlay--hidden");
}

function updateEntities() {
  const by = boatY();
  for (const e of entities) {
    if (e.kind === "rock" || e.kind === "mine") {
      const hitR = e.kind === "mine" ? e.r * 0.75 : e.r * 0.9;
      if (circleHit(boat.x, by, BOAT_RADIUS * 0.75, e.x, e.y, hitR)) {
        crash(e.kind === "mine" ? "You struck a mine!" : "You hit a rock!");
        return;
      }
      if (!e.passed && e.y > by - BOAT_RADIUS && e.y < by + BOAT_RADIUS) {
        e.passed = true;
        if (circleHit(boat.x, by, BOAT_RADIUS * 1.6, e.x, e.y, hitR)) {
          nearMisses += 1;
          bonusScore += 5;
          sfx.nearMiss();
          popups.push({ x: e.x, y: e.y, text: "close call +5", life: 0.7, maxLife: 0.7, color: "#ffe08a" });
        }
      }
    } else if (!e.collected && circleHit(boat.x, by, BOAT_RADIUS, e.x, e.y, e.r * 0.8)) {
      collectPickup(e);
    }
  }
  entities = entities.filter((e) => !e.collected);
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 40 * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);

  for (const t of popups) {
    t.y -= 26 * dt;
    t.life -= dt;
  }
  popups = popups.filter((t) => t.life > 0);
}

function update(dt) {
  updateStorm(dt);
  updateBoat(dt);
  if (state === STATE.PLAYING) {
    updateWorld(dt);
    updateEntities();
  }
  updateParticles(dt);
  shake = Math.max(0, shake - dt * 2.2);
}

/* Rendering ------------------------------------------------------------------ */
function skyColors() {
  const day = {
    top: [151, 209, 244],
    bottom: [214, 238, 250],
    sun: "rgba(255, 244, 214, 0.9)",
  };
  const stormy = {
    top: [58, 74, 92],
    bottom: [110, 130, 145],
    sun: "rgba(180, 190, 200, 0.5)",
  };
  const mix = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));
  return {
    top: mix(day.top, stormy.top, storm),
    bottom: mix(day.bottom, stormy.bottom, storm),
    sun: storm > 0.5 ? stormy.sun : day.sun,
  };
}

function drawSky() {
  const sky = skyColors();
  const horizon = H * 0.22;
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, `rgb(${sky.top.join(",")})`);
  g.addColorStop(1, `rgb(${sky.bottom.join(",")})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, horizon);

  // Sun / pale storm glow
  ctx.save();
  ctx.globalAlpha = 0.9;
  const sunR = 46;
  const sg = ctx.createRadialGradient(W * 0.78, horizon * 0.4, 2, W * 0.78, horizon * 0.4, sunR);
  sg.addColorStop(0, sky.sun);
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(W * 0.78, horizon * 0.4, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return horizon;
}

function drawOcean(horizon, t) {
  const g = ctx.createLinearGradient(0, horizon, 0, H);
  const shallow = storm > 0.3 ? [46, 74, 92] : [58, 150, 176];
  const deep = storm > 0.3 ? [16, 30, 44] : [9, 60, 92];
  const mix = (a, b, f) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], f))).join(",")})`;
  g.addColorStop(0, mix(shallow, shallow, 0));
  g.addColorStop(1, mix(deep, deep, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, W, H - horizon);

  const bands = 6;
  const chaos = 1 + storm * 1.6;
  for (let b = 0; b < bands; b++) {
    const bandY = horizon + ((b + ((t * (0.25 + storm * 0.3)) % 1)) / bands) * (H - horizon);
    const depthT = (bandY - horizon) / (H - horizon);
    const amp = (6 + depthT * 16) * chaos;
    const freq = 0.012 + depthT * 0.01;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) {
      const y = bandY + Math.sin(x * freq + t * 3.2 * chaos + b) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(255,255,255,${0.05 + depthT * 0.05})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

function drawRain(t) {
  if (storm < 0.15) return;
  ctx.save();
  ctx.strokeStyle = `rgba(210,230,240,${0.25 * storm})`;
  ctx.lineWidth = 1.2;
  const count = Math.floor(60 * storm);
  for (let i = 0; i < count; i++) {
    const seedX = (i * 137.5) % W;
    const x = (seedX + t * 260) % W;
    const y = (i * 53 + t * 900) % H;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 8, y + 22);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBoat() {
  const by = boatY();
  const bob = Math.sin(elapsed * 2.6 + boat.bobPhase) * 3 * (1 + storm * 0.8);
  const y = by + bob;

  ctx.save();
  ctx.translate(boat.x, y);
  ctx.rotate(boat.tilt);

  // wake
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath();
  ctx.moveTo(-6, 16);
  ctx.quadraticCurveTo(-26, 40, -14, 64);
  ctx.quadraticCurveTo(0, 46, 0, 30);
  ctx.quadraticCurveTo(0, 46, 14, 64);
  ctx.quadraticCurveTo(26, 40, 6, 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // hull
  ctx.fillStyle = "#8a5a34";
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(15, 6);
  ctx.quadraticCurveTo(12, 18, 0, 20);
  ctx.quadraticCurveTo(-12, 18, -15, 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#c98f52";
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(10, 4);
  ctx.quadraticCurveTo(8, 13, 0, 15);
  ctx.closePath();
  ctx.fill();

  // mast + sail
  ctx.strokeStyle = "#5b3a22";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 4);
  ctx.lineTo(0, -34);
  ctx.stroke();

  ctx.fillStyle = "#f6f8fa";
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(0, 0);
  ctx.quadraticCurveTo(16, -10, 15, -22);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#e63946";
  ctx.beginPath();
  ctx.moveTo(2, -34);
  ctx.lineTo(11, -31);
  ctx.lineTo(2, -28);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawRock(e) {
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(0, e.r * 0.55, e.r * 1.4, e.r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  const points = 8;
  ctx.fillStyle = "#6b7580";
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = e.r * (0.75 + 0.25 * Math.sin(a * 3 + e.seed));
    const px = Math.cos(a) * rr;
    const py = Math.sin(a) * rr * 0.85;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.ellipse(-e.r * 0.2, -e.r * 0.25, e.r * 0.4, e.r * 0.22, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMine(e) {
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.ellipse(0, e.r * 0.5, e.r * 1.3, e.r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  const spikes = 8;
  ctx.strokeStyle = "#2b2f36";
  ctx.lineWidth = 2.4;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + e.seed * 0.3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * e.r * 0.55, Math.sin(a) * e.r * 0.55);
    ctx.lineTo(Math.cos(a) * e.r * 0.95, Math.sin(a) * e.r * 0.95);
    ctx.stroke();
  }
  ctx.fillStyle = "#3a3f47";
  ctx.beginPath();
  ctx.arc(0, 0, e.r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.arc(-e.r * 0.15, -e.r * 0.15, e.r * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCoin(e, t) {
  const spin = Math.cos(t * 4 + e.seed);
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(Math.max(0.15, Math.abs(spin)), 1);
  ctx.fillStyle = "#ffd27a";
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8a93f";
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBottle(e, t) {
  const bob = Math.sin(t * 2 + e.seed) * 3;
  ctx.save();
  ctx.translate(e.x, e.y + bob);
  ctx.rotate(Math.sin(t + e.seed) * 0.15);
  ctx.fillStyle = "#6fe3d0";
  ctx.beginPath();
  ctx.moveTo(-3, -14);
  ctx.lineTo(3, -14);
  ctx.lineTo(3, -8);
  ctx.quadraticCurveTo(9, -4, 9, 6);
  ctx.quadraticCurveTo(9, 12, 0, 12);
  ctx.quadraticCurveTo(-9, 12, -9, 6);
  ctx.quadraticCurveTo(-9, -4, -3, -8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillRect(-1, -6, 2, 12);
  ctx.fillStyle = "#c9a876";
  ctx.fillRect(-3, -17, 6, 4);
  ctx.restore();
}

function drawFish(e, t) {
  const arc = Math.sin(t * 3 + e.seed);
  if (arc < 0) return;
  ctx.save();
  ctx.translate(e.x, e.y - arc * 18);
  ctx.rotate(-arc * 0.5);
  ctx.fillStyle = "#c9d6de";
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-10, 0);
  ctx.lineTo(-17, -6);
  ctx.lineTo(-17, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#8fa6b2";
  ctx.beginPath();
  ctx.ellipse(3, -2, 3, 1.6, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEntities(t) {
  for (const e of entities) {
    if (e.kind === "rock") drawRock(e);
    else if (e.kind === "mine") drawMine(e);
    else if (e.kind === "coin") drawCoin(e, t);
    else if (e.kind === "bottle") drawBottle(e, t);
    else if (e.kind === "fish") drawFish(e, t);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPopups() {
  ctx.textAlign = "center";
  ctx.font = "700 14px ui-sans-serif, system-ui, sans-serif";
  for (const t of popups) {
    ctx.globalAlpha = Math.max(0, t.life / t.maxLife);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (shake > 0 && !reducedMotion) {
    const m = shake * 10;
    ctx.translate(rand(-m, m), rand(-m, m));
  }

  const t = elapsed;
  const horizon = drawSky();
  drawOcean(horizon, t + distance / PIXELS_PER_METER / 40);
  drawEntities(t);
  if (state !== STATE.MENU) drawBoat();
  drawParticles();
  drawPopups();
  drawRain(t);

  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/* Main loop -------------------------------------------------------------- */
function frame(now) {
  requestAnimationFrame(frame);
  if (!lastFrame) lastFrame = now;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  update(dt);
  render();

  if (state === STATE.PLAYING) {
    const meters = Math.floor(distance / PIXELS_PER_METER);
    distanceValue.textContent = `${meters}m`;
    coinsValue.textContent = String(coinsCollected);
  }
}

/* Flow --------------------------------------------------------------------- */
function startRun() {
  getAudio()?.resume?.();
  resetRun();
  state = STATE.PLAYING;
  menuOverlay.classList.add("overlay--hidden");
  gameOverOverlay.classList.add("overlay--hidden");
  bestValue.textContent = `${Math.floor(bestDistance)}m`;
}

startBtn.addEventListener("click", startRun);
retryBtn.addEventListener("click", startRun);

boat.x = W / 2;
boat.targetX = W / 2;
boat.prevX = W / 2;

if (AUTOSTART) {
  startRun();
} else {
  render();
}

requestAnimationFrame(frame);
