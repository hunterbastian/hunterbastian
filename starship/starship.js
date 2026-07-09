// Starship — a small controllable deep-space flight sim.
// No dependencies. Canvas + inertia physics + starfield.

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (v, lo, hi) => {
  const span = hi - lo;
  return ((((v - lo) % span) + span) % span) + lo;
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ----------------------------------------------------------------------- */
/* DOM                                                                     */
/* ----------------------------------------------------------------------- */
const canvas = document.getElementById("space");
const ctx = canvas.getContext("2d");
const splash = document.getElementById("splash");
const hudSpeed = document.getElementById("hudSpeed");
const hudHeading = document.getElementById("hudHeading");
const hudShield = document.getElementById("hudShield");
const hudFuel = document.getElementById("hudFuel");
const panel = document.getElementById("panel");
const panelToggle = document.getElementById("panelToggle");
const panelBody = document.getElementById("panelBody");
const thrustRange = document.getElementById("thrustRange");
const dragRange = document.getElementById("dragRange");
const assistToggle = document.getElementById("assist");
const trailsToggle = document.getElementById("trails");
const refuelBtn = document.getElementById("refuel");
const resetBtn = document.getElementById("reset");
const touchUI = document.getElementById("touch");
const stick = document.getElementById("stick");
const knob = document.getElementById("knob");
const fireBtn = document.getElementById("fireBtn");
const boostBtn = document.getElementById("boostBtn");

/* ----------------------------------------------------------------------- */
/* World state                                                             */
/* ----------------------------------------------------------------------- */
const world = {
  w: 0,
  h: 0,
  dpr: 1,
  started: false,
  t: 0,
};

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
  thrust: 0.55,
  drag: 0.008,
  assist: true,
  trails: true,
  turn: 0.0042,
  maxSpeed: 9.5,
  boostMul: 1.85,
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
      z: Math.random(), // 0 near, 1 far — parallax & size
      tw: Math.random() * TAU,
      bright: 0.35 + Math.random() * 0.65,
    });
  }
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      r: 120 + Math.random() * 220,
      hue: 190 + Math.random() * 40,
      a: 0.04 + Math.random() * 0.05,
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
      const jagged = 0.65 + Math.random() * 0.45;
      shape.push({ a, r: jagged });
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

function resetShip() {
  ship.x = world.w * 0.5;
  ship.y = world.h * 0.5;
  ship.vx = 0;
  ship.vy = 0;
  ship.angle = -Math.PI / 2;
  ship.angVel = 0;
  ship.shield = 100;
  ship.fuel = 100;
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

function engineExhaust(dt) {
  if (!ship.thrusting || ship.fuel <= 0) return;
  const back = ship.angle + Math.PI;
  const spread = 0.35;
  const power = ship.boosting ? 1.6 : 1;
  for (let i = 0; i < (reducedMotion ? 1 : 2); i++) {
    const a = back + (Math.random() - 0.5) * spread;
    const s = (2.5 + Math.random() * 3) * power;
    particles.push({
      x: ship.x - Math.cos(ship.angle) * 14,
      y: ship.y - Math.sin(ship.angle) * 14,
      vx: Math.cos(a) * s + ship.vx * 0.3,
      vy: Math.sin(a) * s + ship.vy * 0.3,
      life: 0.25 + Math.random() * 0.25,
      max: 0.35,
      size: (1.5 + Math.random() * 2) * power,
      color: ship.boosting ? "#5eead4" : "#f0b429",
    });
  }
  if (cfg.trails && !reducedMotion) {
    trails.push({
      x: ship.x - Math.cos(ship.angle) * 12,
      y: ship.y - Math.sin(ship.angle) * 12,
      life: 0.55,
      max: 0.55,
      w: ship.boosting ? 5 : 3,
    });
  }
  void dt;
}

/* ----------------------------------------------------------------------- */
/* Combat                                                                  */
/* ----------------------------------------------------------------------- */
function fire() {
  if (fireCooldown > 0 || ship.fuel < 0.5) return;
  fireCooldown = 0.14;
  ship.fuel = Math.max(0, ship.fuel - 0.4);
  const speed = 11;
  bullets.push({
    x: ship.x + Math.cos(ship.angle) * 16,
    y: ship.y + Math.sin(ship.angle) * 16,
    vx: Math.cos(ship.angle) * speed + ship.vx * 0.2,
    vy: Math.sin(ship.angle) * speed + ship.vy * 0.2,
    life: 1.1,
  });
}

function splitAsteroid(a) {
  if (a.r < 16) {
    burst(a.x, a.y, 14, "#9bb4d0", 4);
    return;
  }
  burst(a.x, a.y, 10, "#7a93b0", 3);
  for (let i = 0; i < 2; i++) {
    const nr = a.r * 0.55;
    const verts = a.shape.length;
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
    void verts;
  }
}

function damageShip(amount) {
  if (ship.invuln > 0) return;
  ship.shield = Math.max(0, ship.shield - amount);
  ship.invuln = 1.0;
  ship.flash = 0.35;
  burst(ship.x, ship.y, 18, "#ff6b4a", 5);
  if (ship.shield <= 0) {
    burst(ship.x, ship.y, 40, "#5eead4", 6);
    burst(ship.x, ship.y, 24, "#f0b429", 4);
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
  let boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || touchBoost;

  if (keys.has("ArrowLeft") || keys.has("KeyA")) turn -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) turn += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) thrust += 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) thrust -= 0.35;

  // Virtual stick: x = turn, y = thrust (up is negative in screen space)
  if (Math.abs(stickVec.x) > 0.08 || Math.abs(stickVec.y) > 0.08) {
    turn += stickVec.x;
    thrust += -stickVec.y;
  }

  turn = clamp(turn, -1, 1);
  thrust = clamp(thrust, -0.5, 1);
  return { turn, thrust, boost };
}

function onKey(e, down) {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Space"].includes(e.key)) {
    e.preventDefault();
  }
  const code = e.code;
  if (down) keys.add(code);
  else keys.delete(code);

  if (down && !world.started) startGame();
  if (down && (code === "Space" || code === "KeyZ" || code === "KeyJ")) fire();
}

window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));

canvas.addEventListener("pointerdown", () => {
  if (!world.started) startGame();
});

splash.addEventListener("pointerdown", () => startGame());
splash.addEventListener("keydown", () => startGame());

/* Touch stick */
function isCoarse() {
  return matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

function showTouchIfNeeded() {
  if (isCoarse()) touchUI.classList.add("is-visible");
}

function bindStick() {
  let active = false;
  let pid = null;

  const setKnob = (nx, ny) => {
    const max = 34;
    const dx = nx * max;
    const dy = ny * max;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const updateFromEvent = (e) => {
    const rect = stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (e.clientX - cx) / (rect.width * 0.5);
    let dy = (e.clientY - cy) / (rect.height * 0.5);
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
    const start = (e) => {
      e.preventDefault();
      on();
      if (!world.started) startGame();
    };
    const stop = () => off();
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointerleave", stop);
    el.addEventListener("pointercancel", stop);
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
  cfg.thrust = Number(thrustRange.value) / 100;
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
  ship.fuel = 100;
  ship.shield = 100;
  ship.invuln = 0.5;
  burst(ship.x, ship.y, 12, "#5eead4", 2);
});
resetBtn.addEventListener("click", () => fullReset());

cfg.thrust = Number(thrustRange.value) / 100;
cfg.drag = Number(dragRange.value) / 1000;

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

  // Rotation with angular velocity for a soft feel
  const turnForce = input.turn * cfg.turn * 60;
  ship.angVel += turnForce * dt * 60;
  if (cfg.assist) ship.angVel *= Math.pow(0.86, dt * 60);
  else ship.angVel *= Math.pow(0.96, dt * 60);
  ship.angVel = clamp(ship.angVel, -0.12, 0.12);
  ship.angle += ship.angVel * dt * 60;

  if (ship.thrusting) {
    const power = cfg.thrust * (ship.boosting ? cfg.boostMul : 1);
    ship.vx += Math.cos(ship.angle) * power * dt * 60;
    ship.vy += Math.sin(ship.angle) * power * dt * 60;
    const burn = (ship.boosting ? 8 : 3.2) * dt;
    ship.fuel = Math.max(0, ship.fuel - burn);
    engineExhaust(dt);
  } else if (input.thrust < -0.05 && cfg.assist) {
    // reverse thrusters / brake assist
    ship.vx *= Math.pow(0.92, dt * 60);
    ship.vy *= Math.pow(0.92, dt * 60);
  }

  // Space drag (tunable "flight assist" feel)
  const drag = cfg.assist ? Math.max(cfg.drag, 0.004) : cfg.drag;
  const damp = Math.pow(1 - drag, dt * 60);
  ship.vx *= damp;
  ship.vy *= damp;

  const spd = Math.hypot(ship.vx, ship.vy);
  if (spd > cfg.maxSpeed * (ship.boosting ? 1.25 : 1)) {
    const s = (cfg.maxSpeed * (ship.boosting ? 1.25 : 1)) / spd;
    ship.vx *= s;
    ship.vy *= s;
  }

  ship.x = wrap(ship.x + ship.vx * dt * 60, 0, world.w);
  ship.y = wrap(ship.y + ship.vy * dt * 60, 0, world.h);

  // Slow shield regen
  if (ship.shield < 100 && ship.invuln <= 0) {
    ship.shield = Math.min(100, ship.shield + 2.5 * dt);
  }

  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x = wrap(b.x + b.vx * dt * 60, 0, world.w);
    b.y = wrap(b.y + b.vy * dt * 60, 0, world.h);
    b.life -= dt;
    if (b.life <= 0) bullets.splice(i, 1);
  }

  // Asteroids
  for (const a of asteroids) {
    a.x = wrap(a.x + a.vx * dt * 60, 0, world.w);
    a.y = wrap(a.y + a.vy * dt * 60, 0, world.h);
    a.rot += a.spin * dt * 60;
  }

  // Bullet vs asteroid
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    let hit = false;
    for (let j = asteroids.length - 1; j >= 0; j--) {
      const a = asteroids[j];
      if (Math.hypot(b.x - a.x, b.y - a.y) < a.r) {
        a.hp -= 1;
        burst(b.x, b.y, 6, "#5eead4", 2);
        bullets.splice(i, 1);
        hit = true;
        if (a.hp <= 0) {
          asteroids.splice(j, 1);
          splitAsteroid(a);
          ship.fuel = Math.min(100, ship.fuel + 2);
        }
        break;
      }
    }
    if (hit) continue;
  }

  // Ship vs asteroid
  if (ship.invuln <= 0 && ship.shield > 0) {
    for (const a of asteroids) {
      if (Math.hypot(ship.x - a.x, ship.y - a.y) < a.r + 10) {
        damageShip(18 + a.r * 0.35);
        // bounce
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

  // Particles
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

  // Respawn rocks if cleared
  if (asteroids.length === 0) {
    spawnAsteroids(8 + Math.floor(Math.random() * 6));
    ship.shield = Math.min(100, ship.shield + 15);
    burst(ship.x, ship.y, 20, "#5eead4", 3);
  }

  // Nebula drift
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
  let hdg = Math.round(((ship.angle * DEG) + 90 + 360) % 360);
  hudHeading.textContent = `${String(hdg).padStart(3, "0")}°`;
  hudShield.textContent = String(Math.round(ship.shield));
  hudFuel.textContent = String(Math.round(ship.fuel));

  hudShield.classList.toggle("is-warn", ship.shield < 40);
  hudShield.classList.toggle("is-crit", ship.shield < 20);
  hudFuel.classList.toggle("is-warn", ship.fuel < 30);
  hudFuel.classList.toggle("is-crit", ship.fuel < 12);
}

/* ----------------------------------------------------------------------- */
/* Draw                                                                    */
/* ----------------------------------------------------------------------- */
function drawBackground() {
  // Deep void with subtle vignette — CSS already paints base; we add nebulae & stars
  ctx.clearRect(0, 0, world.w, world.h);

  // Soft nebula clouds
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

  // Parallax stars (camera follows ship velocity slightly)
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
    ctx.fillStyle = s.z < 0.35 ? "#dce9ff" : "#9eb0cc";
    ctx.fillRect(sx, sy, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawTrails() {
  for (const t of trails) {
    const a = t.life / t.max;
    ctx.beginPath();
    ctx.fillStyle = `rgba(94, 234, 212, ${a * 0.35})`;
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
    ctx.fillStyle = "rgba(28, 38, 58, 0.85)";
    ctx.strokeStyle = "rgba(158, 176, 204, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    // crater hint
    ctx.beginPath();
    ctx.arc(-a.r * 0.2, -a.r * 0.15, a.r * 0.18, 0, TAU);
    ctx.strokeStyle = "rgba(158, 176, 204, 0.25)";
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
    ctx.strokeStyle = "#5eead4";
    ctx.shadowColor = "#5eead4";
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

function drawShip() {
  const blink = ship.invuln > 0 && Math.floor(world.t * 12) % 2 === 0;
  if (blink) return;

  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  // Engine glow
  if (ship.thrusting) {
    const flicker = reducedMotion ? 1 : 0.75 + Math.random() * 0.35;
    const len = (ship.boosting ? 22 : 14) * flicker;
    const g = ctx.createLinearGradient(-10, 0, -10 - len, 0);
    g.addColorStop(0, ship.boosting ? "rgba(94,234,212,0.9)" : "rgba(240,180,41,0.9)");
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-10 - len, 0);
    ctx.lineTo(-10, 5);
    ctx.closePath();
    ctx.fill();
  }

  // Hull
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, 10);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-12, -10);
  ctx.closePath();

  const hull = ctx.createLinearGradient(-12, 0, 16, 0);
  hull.addColorStop(0, "#1a2740");
  hull.addColorStop(0.5, "#2a3f63");
  hull.addColorStop(1, "#5eead4");
  ctx.fillStyle = hull;
  ctx.strokeStyle = ship.flash > 0 ? "#ff6b4a" : "rgba(232, 238, 247, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  // Cockpit
  ctx.beginPath();
  ctx.ellipse(4, 0, 4, 2.5, 0, 0, TAU);
  ctx.fillStyle = "rgba(180, 230, 255, 0.85)";
  ctx.fill();

  // Wing accents
  ctx.strokeStyle = "rgba(94, 234, 212, 0.5)";
  ctx.beginPath();
  ctx.moveTo(-2, -6);
  ctx.lineTo(6, -2);
  ctx.moveTo(-2, 6);
  ctx.lineTo(6, 2);
  ctx.stroke();

  ctx.restore();

  // Soft shield ring when regenerating / hit
  if (ship.invuln > 0 || ship.shield < 40) {
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, 22, 0, TAU);
    ctx.strokeStyle = `rgba(94, 234, 212, ${ship.invuln > 0 ? 0.35 : 0.12})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawMinimap() {
  const size = 88;
  const pad = 16;
  // Bottom-left tactical overview (keeps clear of the flight-deck panel)
  const mx = pad;
  const my = world.h - size - pad;

  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = "rgba(8, 12, 22, 0.55)";
  ctx.strokeStyle = "rgba(94, 234, 212, 0.25)";
  ctx.lineWidth = 1;
  const rr = 10;
  ctx.beginPath();
  ctx.moveTo(mx + rr, my);
  ctx.arcTo(mx + size, my, mx + size, my + size, rr);
  ctx.arcTo(mx + size, my + size, mx, my + size, rr);
  ctx.arcTo(mx, my + size, mx, my, rr);
  ctx.arcTo(mx, my, mx + size, my, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const sx = size / world.w;
  const sy = size / world.h;

  ctx.fillStyle = "rgba(158, 176, 204, 0.7)";
  for (const a of asteroids) {
    ctx.fillRect(mx + a.x * sx, my + a.y * sy, 2, 2);
  }

  ctx.fillStyle = "#5eead4";
  ctx.beginPath();
  ctx.arc(mx + ship.x * sx, my + ship.y * sy, 2.5, 0, TAU);
  ctx.fill();

  // heading tick
  ctx.strokeStyle = "#5eead4";
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
  drawTrails();
  drawAsteroids();
  drawParticles();
  drawBullets();
  if (ship.shield > 0) drawShip();
  drawMinimap();
}

/* ----------------------------------------------------------------------- */
/* Loop                                                                    */
/* ----------------------------------------------------------------------- */
let last = performance.now();

function frame(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = clamp(raw, 0, 0.05);

  if (world.started) update(dt);
  else {
    // idle drift of stars on splash
    world.t += dt;
    ship.x = world.w * 0.5;
    ship.y = world.h * 0.52;
    ship.angle = -Math.PI / 2 + Math.sin(world.t * 0.4) * 0.15;
  }

  draw(dt);
  requestAnimationFrame(frame);
}

function startGame() {
  if (world.started) return;
  world.started = true;
  splash.classList.add("is-gone");
  resetShip();
  showTouchIfNeeded();
}

/* ----------------------------------------------------------------------- */
/* Boot                                                                    */
/* ----------------------------------------------------------------------- */
resize();
fullReset();
bindStick();
bindTouchButtons();
showTouchIfNeeded();
requestAnimationFrame(frame);

window.addEventListener("resize", () => {
  const ox = ship.x / (world.w || 1);
  const oy = ship.y / (world.h || 1);
  resize();
  ship.x = ox * world.w;
  ship.y = oy * world.h;
  seedStars();
});
