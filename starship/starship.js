// Starship — Star Trek–inspired bridge flight sim.
// No dependencies. Canvas + inertia physics + selectable vessels.

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (v, lo, hi) => {
  const span = hi - lo;
  return ((((v - lo) % span) + span) % span) + lo;
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ----------------------------------------------------------------------- */
/* Ship classes                                                            */
/* ----------------------------------------------------------------------- */
const SHIPS = {
  constitution: {
    id: "constitution",
    name: "Constitution",
    registry: "NCC-1701",
    className: "Heavy Cruiser",
    // Balanced explorer
    thrust: 0.52,
    turn: 0.0038,
    maxSpeed: 8.8,
    boostMul: 1.7,
    drag: 0.008,
    shieldMax: 120,
    shieldRegen: 2.8,
    powerMax: 110,
    burnIdle: 2.6,
    burnBoost: 6.5,
    fireCooldown: 0.16,
    fireCost: 0.35,
    boltSpeed: 11,
    boltDamage: 1,
    boltColor: "#f7a54a",
    trailColor: "rgba(126, 200, 227, 0.4)",
    exhaust: "#7ec8e3",
    exhaustBoost: "#f7a54a",
    hull: ["#2a3348", "#8a93a8", "#d8dde8"],
    accent: "#f7a54a",
    nacelle: "#c9d0dc",
    hitRadius: 14,
    weaponLabel: "phaser",
  },
  defiant: {
    id: "defiant",
    name: "Defiant",
    registry: "NX-74205",
    className: "Escort",
    // Fast, punchy, lighter shields
    thrust: 0.72,
    turn: 0.0062,
    maxSpeed: 11.5,
    boostMul: 2.05,
    drag: 0.01,
    shieldMax: 85,
    shieldRegen: 2.0,
    powerMax: 95,
    burnIdle: 3.8,
    burnBoost: 9.5,
    fireCooldown: 0.09,
    fireCost: 0.28,
    boltSpeed: 14,
    boltDamage: 1,
    boltColor: "#ff6b4a",
    trailColor: "rgba(255, 107, 74, 0.35)",
    exhaust: "#ff6b4a",
    exhaustBoost: "#7ec8e3",
    hull: ["#1c2436", "#4a556e", "#a8b0c4"],
    accent: "#e85d4c",
    nacelle: "#6a7388",
    hitRadius: 11,
    weaponLabel: "pulse phaser",
  },
  raptor: {
    id: "raptor",
    name: "Raptor",
    registry: "IKS-447",
    className: "Bird of Prey",
    // Slow, armored, heavy disruptors
    thrust: 0.44,
    turn: 0.0032,
    maxSpeed: 7.4,
    boostMul: 1.55,
    drag: 0.006,
    shieldMax: 150,
    shieldRegen: 3.4,
    powerMax: 125,
    burnIdle: 2.2,
    burnBoost: 5.5,
    fireCooldown: 0.22,
    fireCost: 0.55,
    boltSpeed: 9.5,
    boltDamage: 2,
    boltColor: "#5dff7a",
    trailColor: "rgba(93, 255, 122, 0.3)",
    exhaust: "#5dff7a",
    exhaustBoost: "#f7a54a",
    hull: ["#1a2218", "#3d4a32", "#8a9a72"],
    accent: "#5dff7a",
    nacelle: "#6a7a55",
    hitRadius: 16,
    weaponLabel: "disruptor",
  },
};

const SHIP_ORDER = ["constitution", "defiant", "raptor"];

/* ----------------------------------------------------------------------- */
/* DOM                                                                     */
/* ----------------------------------------------------------------------- */
const canvas = document.getElementById("space");
const ctx = canvas.getContext("2d");
const splash = document.getElementById("splash");
const engageBtn = document.getElementById("engage");
const fleetEl = document.getElementById("fleet");
const brandSub = document.getElementById("brandSub");
const panelShip = document.getElementById("panelShip");
const hudSpeed = document.getElementById("hudSpeed");
const hudHeading = document.getElementById("hudHeading");
const hudShield = document.getElementById("hudShield");
const hudFuel = document.getElementById("hudFuel");
const panel = document.getElementById("panel");
const panelToggle = document.getElementById("panelToggle");
const thrustRange = document.getElementById("thrustRange");
const dragRange = document.getElementById("dragRange");
const assistToggle = document.getElementById("assist");
const trailsToggle = document.getElementById("trails");
const refuelBtn = document.getElementById("refuel");
const resetBtn = document.getElementById("reset");
const changeShipBtn = document.getElementById("changeShip");
const touchUI = document.getElementById("touch");
const stick = document.getElementById("stick");
const knob = document.getElementById("knob");
const fireBtn = document.getElementById("fireBtn");
const boostBtn = document.getElementById("boostBtn");
const hint = document.getElementById("hint");

/* ----------------------------------------------------------------------- */
/* World state                                                             */
/* ----------------------------------------------------------------------- */
const world = {
  w: 0,
  h: 0,
  dpr: 1,
  started: false,
  selecting: true,
  t: 0,
};

let selectedId = "constitution";
let klass = SHIPS.constitution;

const ship = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: -Math.PI / 2,
  angVel: 0,
  thrusting: false,
  boosting: false,
  shield: 100,
  fuel: 100,
  invuln: 0,
  flash: 0,
};

const keys = new Set();
const bullets = [];
const particles = [];
const asteroids = [];
const trails = [];
const stars = [];
const nebulae = [];

let fireCooldown = 0;
let hudTick = 0;
let stickVec = { x: 0, y: 0 };
let touchFire = false;
let touchBoost = false;

const cfg = {
  thrustMul: 1,
  drag: 0.008,
  assist: true,
  trails: true,
};

/* ----------------------------------------------------------------------- */
/* Resize                                                                  */
/* ----------------------------------------------------------------------- */
function resize() {
  world.dpr = Math.min(window.devicePixelRatio || 1, 2);
  world.w = window.innerWidth;
  world.h = window.innerHeight;
  canvas.width = Math.floor(world.w * world.dpr);
  canvas.height = Math.floor(world.h * world.dpr);
  canvas.style.width = `${world.w}px`;
  canvas.style.height = `${world.h}px`;
  ctx.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
}

/* ----------------------------------------------------------------------- */
/* Starfield & nebulae                                                     */
/* ----------------------------------------------------------------------- */
function seedStars() {
  stars.length = 0;
  nebulae.length = 0;
  const count = Math.floor((world.w * world.h) / 2800);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      z: Math.random(),
      tw: Math.random() * TAU,
      bright: 0.35 + Math.random() * 0.65,
    });
  }
  // Warm LCARS-tinted nebulae mixed with cool space blues
  const hues = [210, 225, 35, 280];
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      r: 120 + Math.random() * 220,
      hue: hues[i % hues.length] + Math.random() * 20,
      a: 0.035 + Math.random() * 0.045,
      drift: (Math.random() - 0.5) * 0.08,
    });
  }
}

function spawnAsteroids(n = 10) {
  asteroids.length = 0;
  for (let i = 0; i < n; i++) {
    const r = 18 + Math.random() * 36;
    let x;
    let y;
    do {
      x = Math.random() * world.w;
      y = Math.random() * world.h;
    } while (Math.hypot(x - ship.x, y - ship.y) < 160);
    const verts = 7 + Math.floor(Math.random() * 5);
    const shape = [];
    for (let v = 0; v < verts; v++) {
      const a = (v / verts) * TAU;
      shape.push({ a, r: 0.65 + Math.random() * 0.45 });
    }
    asteroids.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 1.2,
      vy: (Math.random() - 0.5) * 1.2,
      r,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 0.02,
      shape,
      hp: Math.ceil(r / 14),
    });
  }
}

function applyClass(id) {
  selectedId = id;
  klass = SHIPS[id];
  cfg.drag = klass.drag;
  dragRange.value = String(Math.round(klass.drag * 1000));
  thrustRange.value = String(Math.round(klass.thrust * 100));
  cfg.thrustMul = 1;
  panelShip.textContent = `${klass.name} · ${klass.registry}`;
  brandSub.textContent = `${klass.className.toLowerCase()} · ${klass.registry}`;
  hint.textContent = `WASD / arrows · space ${klass.weaponLabel} · shift boost`;
  fireBtn.textContent = klass.id === "raptor" ? "DISRUPT" : "PHASER";
  document.documentElement.style.setProperty("--accent", klass.accent);
}

function resetShip() {
  ship.x = world.w * 0.5;
  ship.y = world.h * 0.5;
  ship.vx = 0;
  ship.vy = 0;
  ship.angle = -Math.PI / 2;
  ship.angVel = 0;
  ship.shield = klass.shieldMax;
  ship.fuel = klass.powerMax;
  ship.invuln = 1.2;
  ship.flash = 0;
  bullets.length = 0;
  particles.length = 0;
  trails.length = 0;
  fireCooldown = 0;
}

function fullReset() {
  resetShip();
  seedStars();
  spawnAsteroids(10 + Math.floor(Math.random() * 5));
}

/* ----------------------------------------------------------------------- */
/* Particles                                                               */
/* ----------------------------------------------------------------------- */
function burst(x, y, n, color, speed = 3) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const s = Math.random() * speed;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.4 + Math.random() * 0.7,
      max: 0.4 + Math.random() * 0.7,
      size: 1 + Math.random() * 2.5,
      color,
    });
  }
}

function engineExhaust() {
  if (!ship.thrusting || ship.fuel <= 0) return;
  const back = ship.angle + Math.PI;
  const spread = klass.id === "constitution" ? 0.55 : 0.35;
  const power = ship.boosting ? 1.6 : 1;
  const offsets =
    klass.id === "constitution"
      ? [
          { ox: -18, oy: -10 },
          { ox: -18, oy: 10 },
        ]
      : klass.id === "raptor"
        ? [
            { ox: -10, oy: -8 },
            { ox: -10, oy: 8 },
          ]
        : [{ ox: -12, oy: 0 }];

  for (const o of offsets) {
    const wx = ship.x + Math.cos(ship.angle) * o.ox - Math.sin(ship.angle) * o.oy;
    const wy = ship.y + Math.sin(ship.angle) * o.ox + Math.cos(ship.angle) * o.oy;
    for (let i = 0; i < (reducedMotion ? 1 : 1); i++) {
      const a = back + (Math.random() - 0.5) * spread;
      const s = (2.2 + Math.random() * 2.8) * power;
      particles.push({
        x: wx,
        y: wy,
        vx: Math.cos(a) * s + ship.vx * 0.3,
        vy: Math.sin(a) * s + ship.vy * 0.3,
        life: 0.25 + Math.random() * 0.25,
        max: 0.35,
        size: (1.4 + Math.random() * 2) * power,
        color: ship.boosting ? klass.exhaustBoost : klass.exhaust,
      });
    }
    if (cfg.trails && !reducedMotion) {
      trails.push({
        x: wx,
        y: wy,
        life: 0.55,
        max: 0.55,
        w: ship.boosting ? 5 : 3,
        color: klass.trailColor,
      });
    }
  }
}

/* ----------------------------------------------------------------------- */
/* Combat                                                                  */
/* ----------------------------------------------------------------------- */
function fire() {
  if (fireCooldown > 0 || ship.fuel < klass.fireCost) return;
  fireCooldown = klass.fireCooldown;
  ship.fuel = Math.max(0, ship.fuel - klass.fireCost);
  const speed = klass.boltSpeed;

  const shots =
    klass.id === "defiant"
      ? [
          { ox: 14, oy: -4 },
          { ox: 14, oy: 4 },
        ]
      : klass.id === "raptor"
        ? [{ ox: 18, oy: 0 }]
        : [{ ox: 20, oy: 0 }];

  for (const s of shots) {
    const bx = ship.x + Math.cos(ship.angle) * s.ox - Math.sin(ship.angle) * s.oy;
    const by = ship.y + Math.sin(ship.angle) * s.ox + Math.cos(ship.angle) * s.oy;
    bullets.push({
      x: bx,
      y: by,
      vx: Math.cos(ship.angle) * speed + ship.vx * 0.2,
      vy: Math.sin(ship.angle) * speed + ship.vy * 0.2,
      life: klass.id === "raptor" ? 1.35 : 1.05,
      damage: klass.boltDamage,
      color: klass.boltColor,
      wide: klass.id === "raptor",
    });
  }
}

function splitAsteroid(a) {
  if (a.r < 16) {
    burst(a.x, a.y, 14, "#9bb4d0", 4);
    return;
  }
  burst(a.x, a.y, 10, "#7a93b0", 3);
  for (let i = 0; i < 2; i++) {
    const nr = a.r * 0.55;
    const shape = a.shape.map((s) => ({
      a: s.a + (Math.random() - 0.5) * 0.2,
      r: 0.65 + Math.random() * 0.45,
    }));
    asteroids.push({
      x: a.x + (Math.random() - 0.5) * 10,
      y: a.y + (Math.random() - 0.5) * 10,
      vx: a.vx + (Math.random() - 0.5) * 2,
      vy: a.vy + (Math.random() - 0.5) * 2,
      r: nr,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 0.04,
      shape,
      hp: Math.ceil(nr / 14),
    });
  }
}

function damageShip(amount) {
  if (ship.invuln > 0) return;
  ship.shield = Math.max(0, ship.shield - amount);
  ship.invuln = 1.0;
  ship.flash = 0.35;
  burst(ship.x, ship.y, 18, "#e85d4c", 5);
  if (ship.shield <= 0) {
    burst(ship.x, ship.y, 40, klass.accent, 6);
    burst(ship.x, ship.y, 24, "#f7a54a", 4);
    setTimeout(() => {
      resetShip();
      if (asteroids.length < 6) spawnAsteroids(8);
    }, 600);
  }
}

/* ----------------------------------------------------------------------- */
/* Input                                                                   */
/* ----------------------------------------------------------------------- */
function readThrustInput() {
  let turn = 0;
  let thrust = 0;
  const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || touchBoost;

  if (keys.has("ArrowLeft") || keys.has("KeyA")) turn -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) turn += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) thrust += 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) thrust -= 0.35;

  if (Math.abs(stickVec.x) > 0.08 || Math.abs(stickVec.y) > 0.08) {
    turn += stickVec.x;
    thrust += -stickVec.y;
  }

  return {
    turn: clamp(turn, -1, 1),
    thrust: clamp(thrust, -0.5, 1),
    boost,
  };
}

function onKey(e, down) {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Space"].includes(e.key)) {
    e.preventDefault();
  }
  const code = e.code;
  if (down) keys.add(code);
  else keys.delete(code);

  if (!down) return;

  if (world.selecting) {
    if (code === "ArrowLeft" || code === "KeyA") cycleShip(-1);
    else if (code === "ArrowRight" || code === "KeyD") cycleShip(1);
    else if (code === "Enter" || code === "Space") startGame();
    return;
  }

  if (code === "Space" || code === "KeyZ" || code === "KeyJ") fire();
}

window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));

/* Touch stick */
function isCoarse() {
  return matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

function showTouchIfNeeded() {
  if (isCoarse()) touchUI.classList.add("is-visible");
  else touchUI.classList.remove("is-visible");
}

function bindStick() {
  let active = false;
  let pid = null;

  const setKnob = (nx, ny) => {
    knob.style.transform = `translate(${nx * 34}px, ${ny * 34}px)`;
  };

  const updateFromEvent = (e) => {
    const rect = stick.getBoundingClientRect();
    let dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.5);
    let dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.5);
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    stickVec.x = dx;
    stickVec.y = dy;
    setKnob(dx, dy);
  };

  stick.addEventListener("pointerdown", (e) => {
    active = true;
    pid = e.pointerId;
    stick.setPointerCapture(pid);
    updateFromEvent(e);
    e.preventDefault();
  });
  stick.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pid) return;
    updateFromEvent(e);
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    active = false;
    pid = null;
    stickVec.x = 0;
    stickVec.y = 0;
    setKnob(0, 0);
  };
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);
}

function bindTouchButtons() {
  const hold = (el, on, off) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      on();
    });
    el.addEventListener("pointerup", off);
    el.addEventListener("pointerleave", off);
    el.addEventListener("pointercancel", off);
  };
  hold(
    fireBtn,
    () => {
      touchFire = true;
      fire();
    },
    () => {
      touchFire = false;
    }
  );
  hold(
    boostBtn,
    () => {
      touchBoost = true;
    },
    () => {
      touchBoost = false;
    }
  );
}

/* Panel */
panelToggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("is-collapsed");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
});

thrustRange.addEventListener("input", () => {
  cfg.thrustMul = Number(thrustRange.value) / (klass.thrust * 100);
});
dragRange.addEventListener("input", () => {
  cfg.drag = Number(dragRange.value) / 1000;
});
assistToggle.addEventListener("change", () => {
  cfg.assist = assistToggle.checked;
});
trailsToggle.addEventListener("change", () => {
  cfg.trails = trailsToggle.checked;
});
refuelBtn.addEventListener("click", () => {
  ship.fuel = klass.powerMax;
  ship.shield = klass.shieldMax;
  ship.invuln = 0.5;
  burst(ship.x, ship.y, 12, klass.accent, 2);
});
resetBtn.addEventListener("click", () => fullReset());
changeShipBtn.addEventListener("click", () => openShipSelect());

engageBtn.addEventListener("click", () => startGame());

/* Ship select */
function selectShipCard(id) {
  applyClass(id);
  for (const card of fleetEl.querySelectorAll(".ship-card")) {
    const on = card.dataset.ship === id;
    card.classList.toggle("is-selected", on);
    card.setAttribute("aria-selected", String(on));
  }
  drawAllPreviews();
}

function cycleShip(dir) {
  const i = SHIP_ORDER.indexOf(selectedId);
  const next = SHIP_ORDER[(i + dir + SHIP_ORDER.length) % SHIP_ORDER.length];
  selectShipCard(next);
}

fleetEl.addEventListener("click", (e) => {
  const card = e.target.closest(".ship-card");
  if (!card) return;
  selectShipCard(card.dataset.ship);
});

function openShipSelect() {
  world.started = false;
  world.selecting = true;
  splash.classList.remove("is-gone");
  touchUI.classList.remove("is-visible");
  drawAllPreviews();
}

/* ----------------------------------------------------------------------- */
/* Update                                                                  */
/* ----------------------------------------------------------------------- */
function update(dt) {
  world.t += dt;
  if (ship.invuln > 0) ship.invuln -= dt;
  if (ship.flash > 0) ship.flash -= dt;
  if (fireCooldown > 0) fireCooldown -= dt;

  if (touchFire) fire();

  const input = readThrustInput();
  ship.thrusting = input.thrust > 0.05 && ship.fuel > 0;
  ship.boosting = ship.thrusting && input.boost && ship.fuel > 0;

  const turnForce = input.turn * klass.turn * 60;
  ship.angVel += turnForce * dt * 60;
  if (cfg.assist) ship.angVel *= Math.pow(0.86, dt * 60);
  else ship.angVel *= Math.pow(0.96, dt * 60);
  ship.angVel = clamp(ship.angVel, -0.14, 0.14);
  ship.angle += ship.angVel * dt * 60;

  if (ship.thrusting) {
    const power = klass.thrust * cfg.thrustMul * (ship.boosting ? klass.boostMul : 1);
    ship.vx += Math.cos(ship.angle) * power * dt * 60;
    ship.vy += Math.sin(ship.angle) * power * dt * 60;
    const burn = (ship.boosting ? klass.burnBoost : klass.burnIdle) * dt;
    ship.fuel = Math.max(0, ship.fuel - burn);
    engineExhaust();
  } else if (input.thrust < -0.05 && cfg.assist) {
    ship.vx *= Math.pow(0.92, dt * 60);
    ship.vy *= Math.pow(0.92, dt * 60);
  }

  const drag = cfg.assist ? Math.max(cfg.drag, 0.004) : cfg.drag;
  const damp = Math.pow(1 - drag, dt * 60);
  ship.vx *= damp;
  ship.vy *= damp;

  const spd = Math.hypot(ship.vx, ship.vy);
  const cap = klass.maxSpeed * (ship.boosting ? 1.25 : 1);
  if (spd > cap) {
    ship.vx *= cap / spd;
    ship.vy *= cap / spd;
  }

  ship.x = wrap(ship.x + ship.vx * dt * 60, 0, world.w);
  ship.y = wrap(ship.y + ship.vy * dt * 60, 0, world.h);

  if (ship.shield < klass.shieldMax && ship.invuln <= 0) {
    ship.shield = Math.min(klass.shieldMax, ship.shield + klass.shieldRegen * dt);
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x = wrap(b.x + b.vx * dt * 60, 0, world.w);
    b.y = wrap(b.y + b.vy * dt * 60, 0, world.h);
    b.life -= dt;
    if (b.life <= 0) bullets.splice(i, 1);
  }

  for (const a of asteroids) {
    a.x = wrap(a.x + a.vx * dt * 60, 0, world.w);
    a.y = wrap(a.y + a.vy * dt * 60, 0, world.h);
    a.rot += a.spin * dt * 60;
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    for (let j = asteroids.length - 1; j >= 0; j--) {
      const a = asteroids[j];
      if (Math.hypot(b.x - a.x, b.y - a.y) < a.r) {
        a.hp -= b.damage;
        burst(b.x, b.y, 6, b.color, 2);
        bullets.splice(i, 1);
        if (a.hp <= 0) {
          asteroids.splice(j, 1);
          splitAsteroid(a);
          ship.fuel = Math.min(klass.powerMax, ship.fuel + 3);
        }
        break;
      }
    }
  }

  if (ship.invuln <= 0 && ship.shield > 0) {
    for (const a of asteroids) {
      if (Math.hypot(ship.x - a.x, ship.y - a.y) < a.r + klass.hitRadius) {
        damageShip(18 + a.r * 0.35);
        const dx = ship.x - a.x;
        const dy = ship.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        ship.vx += (dx / d) * 3;
        ship.vy += (dy / d) * 3;
        a.vx -= (dx / d) * 1.2;
        a.vy -= (dy / d) * 1.2;
        break;
      }
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.vx *= 0.98;
    p.vy *= 0.98;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }

  for (let i = trails.length - 1; i >= 0; i--) {
    trails[i].life -= dt;
    if (trails[i].life <= 0) trails.splice(i, 1);
  }

  if (asteroids.length === 0) {
    spawnAsteroids(8 + Math.floor(Math.random() * 6));
    ship.shield = Math.min(klass.shieldMax, ship.shield + 15);
    burst(ship.x, ship.y, 20, klass.accent, 3);
  }

  for (const n of nebulae) {
    n.x = wrap(n.x + n.drift * dt * 60, -n.r, world.w + n.r);
  }

  hudTick += dt;
  if (hudTick > 0.08) {
    hudTick = 0;
    updateHud();
  }
}

function updateHud() {
  const spd = Math.hypot(ship.vx, ship.vy);
  hudSpeed.textContent = spd.toFixed(1);
  const hdg = Math.round((ship.angle * DEG + 90 + 360) % 360);
  hudHeading.textContent = `${String(hdg).padStart(3, "0")}°`;
  const shPct = Math.round((ship.shield / klass.shieldMax) * 100);
  const pwPct = Math.round((ship.fuel / klass.powerMax) * 100);
  hudShield.textContent = String(shPct);
  hudFuel.textContent = String(pwPct);

  hudShield.classList.toggle("is-warn", shPct < 40);
  hudShield.classList.toggle("is-crit", shPct < 20);
  hudFuel.classList.toggle("is-warn", pwPct < 30);
  hudFuel.classList.toggle("is-crit", pwPct < 12);
}

/* ----------------------------------------------------------------------- */
/* Draw — ships                                                            */
/* ----------------------------------------------------------------------- */
function drawShipSilhouette(c, k, opts = {}) {
  const {
    scale = 1,
    thrusting = false,
    boosting = false,
    flash = false,
    t = 0,
  } = opts;

  c.save();
  c.scale(scale, scale);

  if (thrusting) {
    const flicker = reducedMotion ? 1 : 0.75 + Math.random() * 0.35;
    const len = (boosting ? 20 : 12) * flicker;
    const color = boosting ? k.exhaustBoost : k.exhaust;
    if (k.id === "constitution") {
      for (const oy of [-10, 10]) {
        const g = c.createLinearGradient(-18, oy, -18 - len, oy);
        g.addColorStop(0, color);
        g.addColorStop(1, "transparent");
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(-16, oy - 3);
        c.lineTo(-16 - len, oy);
        c.lineTo(-16, oy + 3);
        c.closePath();
        c.fill();
      }
    } else if (k.id === "raptor") {
      for (const oy of [-7, 7]) {
        const g = c.createLinearGradient(-8, oy, -8 - len, oy);
        g.addColorStop(0, color);
        g.addColorStop(1, "transparent");
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(-6, oy - 3);
        c.lineTo(-6 - len, oy);
        c.lineTo(-6, oy + 3);
        c.closePath();
        c.fill();
      }
    } else {
      const g = c.createLinearGradient(-10, 0, -10 - len, 0);
      g.addColorStop(0, color);
      g.addColorStop(1, "transparent");
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-8, -5);
      c.lineTo(-8 - len, 0);
      c.lineTo(-8, 5);
      c.closePath();
      c.fill();
    }
  }

  c.lineJoin = "round";
  c.lineWidth = 1.4;
  c.strokeStyle = flash ? "#e85d4c" : "rgba(242, 240, 232, 0.85)";

  if (k.id === "constitution") {
    // Saucer
    c.beginPath();
    c.ellipse(6, 0, 14, 9, 0, 0, TAU);
    const saucer = c.createRadialGradient(4, -2, 2, 6, 0, 14);
    saucer.addColorStop(0, k.hull[2]);
    saucer.addColorStop(0.55, k.hull[1]);
    saucer.addColorStop(1, k.hull[0]);
    c.fillStyle = saucer;
    c.fill();
    c.stroke();

    // Bridge dome
    c.beginPath();
    c.ellipse(8, 0, 4, 2.6, 0, 0, TAU);
    c.fillStyle = "rgba(180, 220, 255, 0.75)";
    c.fill();

    // Neck + secondary hull
    c.beginPath();
    c.moveTo(-2, 2);
    c.lineTo(-14, 5);
    c.lineTo(-20, 3);
    c.lineTo(-20, -3);
    c.lineTo(-14, -5);
    c.lineTo(-2, -2);
    c.closePath();
    c.fillStyle = k.hull[1];
    c.fill();
    c.stroke();

    // Nacelle pylons + nacelles
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(-12, side * 4);
      c.lineTo(-18, side * 11);
      c.strokeStyle = k.hull[1];
      c.stroke();
      c.beginPath();
      c.ellipse(-16, side * 12, 9, 2.4, 0, 0, TAU);
      c.fillStyle = k.nacelle;
      c.fill();
      c.strokeStyle = flash ? "#e85d4c" : "rgba(242, 240, 232, 0.85)";
      c.stroke();
      // Bussard collector
      c.beginPath();
      c.arc(-7, side * 12, 2.2, 0, TAU);
      c.fillStyle = k.accent;
      c.fill();
    }

    // Deflector
    c.beginPath();
    c.arc(-20, 0, 2.5, 0, TAU);
    c.fillStyle = "#5#ifdef";
    c.fillStyle = "#4db8ff";
    c.fill();
  } else if (k.id === "defiant") {
    // Compact angular escort
    c.beginPath();
    c.moveTo(16, 0);
    c.lineTo(4, -7);
    c.lineTo(-6, -9);
    c.lineTo(-14, -5);
    c.lineTo(-12, 0);
    c.lineTo(-14, 5);
    c.lineTo(-6, 9);
    c.lineTo(4, 7);
    c.closePath();
    const hull = c.createLinearGradient(-14, 0, 16, 0);
    hull.addColorStop(0, k.hull[0]);
    hull.addColorStop(0.5, k.hull[1]);
    hull.addColorStop(1, k.hull[2]);
    c.fillStyle = hull;
    c.fill();
    c.stroke();

    // Twin pulse cannons
    c.fillStyle = k.accent;
    c.fillRect(8, -5.5, 6, 2);
    c.fillRect(8, 3.5, 6, 2);

    // Cockpit strip
    c.beginPath();
    c.moveTo(6, -2);
    c.lineTo(12, 0);
    c.lineTo(6, 2);
    c.closePath();
    c.fillStyle = "rgba(180, 220, 255, 0.8)";
    c.fill();

    // Rear thruster housing
    c.beginPath();
    c.rect(-14, -3, 4, 6);
    c.fillStyle = k.nacelle;
    c.fill();
  } else {
    // Bird of Prey — swept wings, head forward
    c.beginPath();
    c.moveTo(18, 0);
    c.lineTo(8, -4);
    c.lineTo(2, -3);
    c.lineTo(-4, -14);
    c.lineTo(-14, -16);
    c.lineTo(-10, -4);
    c.lineTo(-12, 0);
    c.lineTo(-10, 4);
    c.lineTo(-14, 16);
    c.lineTo(-4, 14);
    c.lineTo(2, 3);
    c.lineTo(8, 4);
    c.closePath();
    const hull = c.createLinearGradient(-14, 0, 18, 0);
    hull.addColorStop(0, k.hull[0]);
    hull.addColorStop(0.45, k.hull[1]);
    hull.addColorStop(1, k.hull[2]);
    c.fillStyle = hull;
    c.fill();
    c.stroke();

    // Wing feathers
    c.strokeStyle = "rgba(93, 255, 122, 0.35)";
    c.beginPath();
    c.moveTo(-2, -8);
    c.lineTo(-10, -12);
    c.moveTo(-2, 8);
    c.lineTo(-10, 12);
    c.stroke();

    // Head / bridge
    c.beginPath();
    c.ellipse(10, 0, 5, 3, 0, 0, TAU);
    c.fillStyle = k.hull[1];
    c.fill();
    c.strokeStyle = flash ? "#e85d4c" : "rgba(242, 240, 232, 0.85)";
    c.stroke();

    // Disruptor emitter
    c.beginPath();
    c.arc(16, 0, 2, 0, TAU);
    c.fillStyle = k.accent;
    c.fill();

    // Wingtip glow pulse
    const glow = 0.35 + 0.25 * Math.sin(t * 3);
    c.fillStyle = `rgba(93, 255, 122, ${glow})`;
    c.beginPath();
    c.arc(-14, -16, 2, 0, TAU);
    c.fill();
    c.beginPath();
    c.arc(-14, 16, 2, 0, TAU);
    c.fill();
  }

  c.restore();
}

function drawShip() {
  const blink = ship.invuln > 0 && Math.floor(world.t * 12) % 2 === 0;
  if (blink) return;

  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);
  drawShipSilhouette(ctx, klass, {
    thrusting: ship.thrusting,
    boosting: ship.boosting,
    flash: ship.flash > 0,
    t: world.t,
  });
  ctx.restore();

  if (ship.invuln > 0 || ship.shield / klass.shieldMax < 0.4) {
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, klass.hitRadius + 10, 0, TAU);
    ctx.strokeStyle = `rgba(126, 200, 227, ${ship.invuln > 0 ? 0.4 : 0.14})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawPreview(canvasEl, id) {
  const k = SHIPS[id];
  const c = canvasEl.getContext("2d");
  const w = canvasEl.width;
  const h = canvasEl.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = "rgba(4, 8, 18, 0.5)";
  c.fillRect(0, 0, w, h);
  // tiny stars
  c.fillStyle = "rgba(200, 210, 230, 0.5)";
  for (let i = 0; i < 18; i++) {
    c.fillRect((i * 37) % w, (i * 53) % h, 1, 1);
  }
  c.save();
  c.translate(w * 0.55, h * 0.5);
  c.rotate(-0.35);
  drawShipSilhouette(c, k, {
    scale: id === "constitution" ? 1.55 : id === "raptor" ? 1.45 : 1.7,
    thrusting: true,
    t: performance.now() / 1000,
  });
  c.restore();
}

function drawAllPreviews() {
  for (const el of document.querySelectorAll("[data-preview]")) {
    drawPreview(el, el.dataset.preview);
  }
}

/* ----------------------------------------------------------------------- */
/* Draw — world                                                            */
/* ----------------------------------------------------------------------- */
function drawBackground() {
  ctx.clearRect(0, 0, world.w, world.h);

  for (const n of nebulae) {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    g.addColorStop(0, `hsla(${n.hue}, 55%, 45%, ${n.a})`);
    g.addColorStop(0.55, `hsla(${n.hue + 20}, 40%, 30%, ${n.a * 0.45})`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, TAU);
    ctx.fill();
  }

  const camX = ship.vx * 2;
  const camY = ship.vy * 2;
  for (const s of stars) {
    const depth = 0.15 + s.z * 0.85;
    const sx = wrap(s.x - camX * (1 - depth), 0, world.w);
    const sy = wrap(s.y - camY * (1 - depth), 0, world.h);
    const twinkle = reducedMotion
      ? 1
      : 0.65 + 0.35 * Math.sin(world.t * (1.2 + s.z) + s.tw);
    const size = (0.6 + (1 - s.z) * 1.8) * twinkle;
    ctx.globalAlpha = s.bright * twinkle;
    ctx.fillStyle = s.z < 0.35 ? "#e8e4d4" : "#9eb0cc";
    ctx.fillRect(sx, sy, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawTrails() {
  for (const t of trails) {
    const a = t.life / t.max;
    ctx.beginPath();
    ctx.fillStyle = t.color.replace(/[\d.]+\)$/, `${a * 0.45})`);
    ctx.arc(t.x, t.y, t.w * a, 0, TAU);
    ctx.fill();
  }
}

function drawParticles() {
  for (const p of particles) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * a, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawAsteroids() {
  for (const a of asteroids) {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.rot);
    ctx.beginPath();
    for (let i = 0; i < a.shape.length; i++) {
      const s = a.shape[i];
      const px = Math.cos(s.a) * a.r * s.r;
      const py = Math.sin(s.a) * a.r * s.r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(28, 34, 48, 0.9)";
    ctx.strokeStyle = "rgba(200, 180, 140, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-a.r * 0.2, -a.r * 0.15, a.r * 0.18, 0, TAU);
    ctx.strokeStyle = "rgba(200, 180, 140, 0.2)";
    ctx.stroke();
    ctx.restore();
  }
}

function drawBullets() {
  for (const b of bullets) {
    ctx.save();
    ctx.translate(b.x, b.y);
    const ang = Math.atan2(b.vy, b.vx);
    ctx.rotate(ang);
    ctx.strokeStyle = b.color;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 10;
    ctx.lineWidth = b.wide ? 3.5 : 2;
    ctx.beginPath();
    ctx.moveTo(b.wide ? -8 : -6, 0);
    ctx.lineTo(b.wide ? 8 : 6, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

function drawMinimap() {
  const size = 88;
  const pad = 16;
  const mx = pad;
  const my = world.h - size - pad;

  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = "rgba(8, 12, 22, 0.6)";
  ctx.strokeStyle = "rgba(247, 165, 74, 0.4)";
  ctx.lineWidth = 2;
  const rr = 4;
  ctx.beginPath();
  ctx.moveTo(mx + rr, my);
  ctx.arcTo(mx + size, my, mx + size, my + size, rr);
  ctx.arcTo(mx + size, my + size, mx, my + size, rr);
  ctx.arcTo(mx, my + size, mx, my, rr);
  ctx.arcTo(mx, my, mx + size, my, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // LCARS corner pip
  ctx.fillStyle = "#f7a54a";
  ctx.fillRect(mx, my, 14, 4);

  const sx = size / world.w;
  const sy = size / world.h;

  ctx.fillStyle = "rgba(200, 180, 140, 0.7)";
  for (const a of asteroids) {
    ctx.fillRect(mx + a.x * sx, my + a.y * sy, 2, 2);
  }

  ctx.fillStyle = klass.accent;
  ctx.beginPath();
  ctx.arc(mx + ship.x * sx, my + ship.y * sy, 2.5, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = klass.accent;
  ctx.beginPath();
  ctx.moveTo(mx + ship.x * sx, my + ship.y * sy);
  ctx.lineTo(
    mx + ship.x * sx + Math.cos(ship.angle) * 8,
    my + ship.y * sy + Math.sin(ship.angle) * 8
  );
  ctx.stroke();
  ctx.restore();
}

function draw(dt) {
  void dt;
  drawBackground();
  if (!world.selecting) {
    drawTrails();
    drawAsteroids();
    drawParticles();
    drawBullets();
    if (ship.shield > 0) drawShip();
    drawMinimap();
  } else {
    // Idle preview ship in the void behind the splash
    ship.x = world.w * 0.5;
    ship.y = world.h * 0.55;
    ship.angle = -Math.PI / 2 + Math.sin(world.t * 0.35) * 0.2;
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.angle);
    ctx.globalAlpha = 0.35;
    drawShipSilhouette(ctx, klass, {
      scale: 2.2,
      thrusting: true,
      t: world.t,
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* ----------------------------------------------------------------------- */
/* Loop                                                                    */
/* ----------------------------------------------------------------------- */
let last = performance.now();

function frame(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = clamp(raw, 0, 0.05);
  world.t += world.started ? 0 : dt;

  if (world.started) update(dt);
  draw(dt);
  requestAnimationFrame(frame);
}

function startGame() {
  if (world.started) return;
  world.selecting = false;
  world.started = true;
  splash.classList.add("is-gone");
  applyClass(selectedId);
  resetShip();
  spawnAsteroids(10 + Math.floor(Math.random() * 5));
  showTouchIfNeeded();
}

/* ----------------------------------------------------------------------- */
/* Boot                                                                    */
/* ----------------------------------------------------------------------- */
resize();
applyClass("constitution");
seedStars();
ship.x = world.w * 0.5;
ship.y = world.h * 0.5;
bindStick();
bindTouchButtons();
drawAllPreviews();
requestAnimationFrame(frame);

// Keep previews alive with a soft refresh while selecting
setInterval(() => {
  if (world.selecting) drawAllPreviews();
}, 400);

window.addEventListener("resize", () => {
  const ox = ship.x / (world.w || 1);
  const oy = ship.y / (world.h || 1);
  resize();
  ship.x = ox * world.w;
  ship.y = oy * world.h;
  seedStars();
  drawAllPreviews();
});
