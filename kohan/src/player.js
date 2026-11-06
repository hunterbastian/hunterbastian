// First-person walker and the input that drives it: keyboard + mouse look
// (pointer lock, with drag-to-look as a fallback) and a touch joystick.

import { clamp, lerp } from "./math.js";

const EYE = 1.62;
const WADE_LIMIT = -0.62; // deeper than this and the lake turns you back

export class Player {
  constructor(world, start) {
    this.world = world;
    this.x = start.x;
    this.z = start.z;
    this.yaw = start.yaw;
    this.pitch = start.pitch;
    this.y = this.groundAt(this.x, this.z);
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.air = false;
    this.bob = 0;
    this.speed = 0;
  }

  groundAt(x, z) {
    let g = this.world.terrain.heightAt(x, z);
    for (const s of this.world.steps) {
      if (Math.hypot(x - s.x, z - s.z) < s.r) g = Math.max(g, s.top);
    }
    return g;
  }

  walkable(x, z) {
    return this.groundAt(x, z) > WADE_LIMIT;
  }

  get wading() {
    return this.groundAt(this.x, this.z) < -0.04;
  }

  update(dt, inp, reduceMotion) {
    this.yaw += inp.lookX;
    this.pitch = clamp(this.pitch - inp.lookY, -1.35, 1.35);

    const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    let mx = inp.moveX, my = inp.moveY;
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }
    const base = inp.run ? 6.2 : 3.2;
    const speed = base * (this.wading ? 0.55 : 1);
    const tx = (fx * my + rx * mx) * speed;
    const tz = (fz * my + rz * mx) * speed;
    const k = 1 - Math.exp(-dt * (this.air ? 2 : 10));
    this.vx = lerp(this.vx, tx, k);
    this.vz = lerp(this.vz, tz, k);

    let nx = this.x + this.vx * dt;
    let nz = this.z + this.vz * dt;
    if (!this.walkable(nx, nz)) {
      if (this.walkable(nx, this.z)) nz = this.z;
      else if (this.walkable(this.x, nz)) nx = this.x;
      else {
        nx = this.x;
        nz = this.z;
        this.vx *= 0.2;
        this.vz *= 0.2;
      }
    }
    for (const c of this.world.colliders) {
      const dx = nx - c.x, dz = nz - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + 0.32;
      if (d < min && d > 1e-4) {
        nx = c.x + (dx / d) * min;
        nz = c.z + (dz / d) * min;
      }
    }
    if (this.walkable(nx, nz)) {
      this.x = nx;
      this.z = nz;
    }

    const g = this.groundAt(this.x, this.z);
    if (inp.jump && !this.air) {
      this.vy = 4.4;
      this.air = true;
    }
    if (this.air) {
      this.vy -= 13 * dt;
      this.y += this.vy * dt;
      if (this.y <= g) {
        this.y = g;
        this.air = false;
        this.vy = 0;
      }
    } else {
      this.y = lerp(this.y, g, 1 - Math.exp(-dt * 16));
    }

    this.speed = Math.hypot(this.vx, this.vz);
    if (!reduceMotion && !this.air) this.bob += dt * this.speed * 2.2;
  }

  eye(reduceMotion) {
    const amp = reduceMotion ? 0 : Math.min(this.speed / 6, 1) * 0.045;
    return [this.x, this.y + EYE + Math.sin(this.bob) * amp, this.z];
  }
}

export class Input {
  constructor(canvas, els) {
    this.canvas = canvas;
    this.els = els;
    this.keys = new Set();
    this.lookX = 0;
    this.lookY = 0;
    this.jumpQueued = false;
    this.locked = false;
    this.dragging = false;
    this.joy = null; // { id, ox, oy, x, y }
    this.lookTouch = null; // { id, x, y }
    this.enabled = false;
    this.onAction = () => {};
    this.onToggle = () => {};

    window.addEventListener("keydown", (e) => this.key(e, true));
    window.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.keys.clear());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      this.onLockChange?.(this.locked);
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.lookX += e.movementX * 0.0022;
        this.lookY += e.movementY * 0.0022;
      } else if (this.dragging) {
        this.lookX += e.movementX * 0.004;
        this.lookY += e.movementY * 0.004;
      }
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0 && this.enabled && !this.locked) this.dragging = true;
    });
    window.addEventListener("mouseup", () => (this.dragging = false));

    canvas.addEventListener("pointerdown", (e) => this.touchStart(e));
    canvas.addEventListener("pointermove", (e) => this.touchMove(e));
    canvas.addEventListener("pointerup", (e) => this.touchEnd(e));
    canvas.addEventListener("pointercancel", (e) => this.touchEnd(e));
  }

  requestLock() {
    try {
      const r = this.canvas.requestPointerLock?.();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* drag-to-look still works */
    }
  }

  key(e, down) {
    const tag = e.target?.tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "BUTTON") {
      if (e.code !== "Tab" && !this.enabled) return;
    }
    if (down) {
      if (e.code === "Tab") {
        e.preventDefault();
        this.onToggle("panel");
        return;
      }
      if (/^Digit[1-7]$/.test(e.code)) {
        this.onToggle("pass", Number(e.code.slice(5)));
        return;
      }
      if (e.code === "KeyP") {
        this.onToggle("preset");
        return;
      }
      if (!this.enabled) return;
      if (e.code === "KeyE" || e.code === "Enter") this.onAction();
      if (e.code === "Space") {
        e.preventDefault();
        this.jumpQueued = true;
      }
      if (e.code.startsWith("Arrow")) e.preventDefault();
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
  }

  touchStart(e) {
    if (e.pointerType !== "touch" || !this.enabled) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const left = e.clientX < window.innerWidth * 0.45;
    if (left && !this.joy) {
      this.joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      this.showJoy();
    } else if (!this.lookTouch) {
      this.lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }

  touchMove(e) {
    if (e.pointerType !== "touch") return;
    if (this.joy && e.pointerId === this.joy.id) {
      this.joy.x = e.clientX;
      this.joy.y = e.clientY;
      this.showJoy();
    } else if (this.lookTouch && e.pointerId === this.lookTouch.id) {
      this.lookX += (e.clientX - this.lookTouch.x) * 0.0065;
      this.lookY += (e.clientY - this.lookTouch.y) * 0.0065;
      this.lookTouch.x = e.clientX;
      this.lookTouch.y = e.clientY;
    }
  }

  touchEnd(e) {
    if (this.joy && e.pointerId === this.joy.id) {
      this.joy = null;
      this.showJoy();
    }
    if (this.lookTouch && e.pointerId === this.lookTouch.id) this.lookTouch = null;
  }

  joyVector() {
    if (!this.joy) return [0, 0];
    const R = 56;
    let dx = (this.joy.x - this.joy.ox) / R, dy = (this.joy.y - this.joy.oy) / R;
    const l = Math.hypot(dx, dy);
    if (l > 1.25) {
      dx *= 1.25 / l;
      dy *= 1.25 / l;
    }
    return [dx, dy];
  }

  showJoy() {
    const { joy: base, knob } = this.els;
    if (!base) return;
    if (!this.joy) {
      base.hidden = true;
      return;
    }
    base.hidden = false;
    base.style.transform = `translate(${this.joy.ox}px, ${this.joy.oy}px)`;
    const [dx, dy] = this.joyVector();
    knob.style.transform = `translate(${dx * 44}px, ${dy * 44}px)`;
  }

  read() {
    const k = this.keys;
    let mx = 0, my = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) my += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) my -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) mx += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) mx -= 1;
    let run = k.has("ShiftLeft") || k.has("ShiftRight");
    if (this.joy) {
      const [jx, jy] = this.joyVector();
      mx += jx;
      my -= jy;
      if (Math.hypot(jx, jy) > 1.05) run = true;
    }
    const out = { moveX: mx, moveY: my, run, jump: this.jumpQueued, lookX: this.lookX, lookY: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    this.jumpQueued = false;
    return out;
  }
}
