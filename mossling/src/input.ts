// Keyboard, mouse and touch. On touch screens the left thumb drives a
// floating joystick (push it all the way to trot), the right thumb looks
// around, and two fingers pinch to zoom.

type Role = "stick" | "look";
type Pointer = { role: Role; x: number; y: number };

const STICK_RADIUS = 56;
const DEADZONE = 0.12;
const TROT_AT = 0.9;

export class Input {
  private keys = new Set<string>();
  private pointers = new Map<number, Pointer>();
  private onPress = new Map<string, () => void>();
  private stick = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
  private pinchDist = 0;
  private dragX = 0;
  private dragY = 0;
  private zoom = 0;
  lastDragTime = -Infinity;
  /** True once any touch has happened — used to swap the HUD over. */
  usedTouch = false;

  /**
   * @param toStage maps viewport coordinates into the game stage's own
   *   coordinates (the stage may be rotated 90° to force landscape).
   */
  constructor(
    target: HTMLElement,
    private stickEl?: HTMLElement,
    private knobEl?: HTMLElement,
    private toStage: (x: number, y: number) => { x: number; y: number } = (x, y) => ({ x, y }),
    private stageWidth: () => number = () => innerWidth,
  ) {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.onPress.get(e.code)?.();
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => {
      this.keys.clear();
      this.pointers.clear();
      this.releaseStick();
    });

    target.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const touch = e.pointerType !== "mouse";
      if (touch) this.usedTouch = true;
      const at = this.toStage(e.clientX, e.clientY);
      const role: Role = touch && this.stick.id < 0 && at.x < this.stageWidth() * 0.45 ? "stick" : "look";
      this.pointers.set(e.pointerId, { role, x: at.x, y: at.y });
      target.setPointerCapture(e.pointerId);
      if (role === "stick") {
        this.stick = { id: e.pointerId, ox: at.x, oy: at.y, dx: 0, dy: 0 };
        this.drawStick(true);
      }
      this.pinchDist = this.lookPinchDistance();
    });

    target.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      // Deltas from clientX/Y: iOS Safari doesn't give reliable movementX on touch.
      const at = this.toStage(e.clientX, e.clientY);
      const mx = at.x - p.x;
      const my = at.y - p.y;
      p.x = at.x;
      p.y = at.y;
      if (p.role === "stick") {
        let dx = at.x - this.stick.ox;
        let dy = at.y - this.stick.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          // Let the stick trail the thumb so it never feels stuck at the edge.
          this.stick.ox += (dx / len) * (len - STICK_RADIUS);
          this.stick.oy += (dy / len) * (len - STICK_RADIUS);
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        this.stick.dx = dx;
        this.stick.dy = dy;
        this.drawStick(true);
        return;
      }
      const pinch = this.lookPinchDistance();
      if (pinch > 0) {
        this.zoom += (this.pinchDist - pinch) * 0.02;
        this.pinchDist = pinch;
      } else {
        this.dragX += mx;
        this.dragY += my;
      }
      this.lastDragTime = performance.now();
    });

    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p?.role === "stick") this.releaseStick();
      this.pinchDist = this.lookPinchDistance();
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
    target.addEventListener(
      "wheel",
      (e) => {
        this.zoom += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    // Stop iOS Safari from pinch-zooming the page or popping context menus.
    for (const ev of ["gesturestart", "gesturechange", "contextmenu"]) target.addEventListener(ev, (e) => e.preventDefault());
    target.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

    this.drawStick(false);
  }

  private lookPinchDistance() {
    const looks = [...this.pointers.values()].filter((p) => p.role === "look");
    return looks.length >= 2 ? Math.hypot(looks[0].x - looks[1].x, looks[0].y - looks[1].y) : 0;
  }

  private releaseStick() {
    this.stick.id = -1;
    this.stick.dx = this.stick.dy = 0;
    this.drawStick(false);
  }

  private drawStick(active: boolean) {
    if (!this.stickEl || !this.knobEl) return;
    this.stickEl.classList.toggle("active", active);
    if (active) {
      this.stickEl.style.left = `${this.stick.ox}px`;
      this.stickEl.style.top = `${this.stick.oy}px`;
    } else {
      this.stickEl.style.left = this.stickEl.style.top = "";
    }
    this.knobEl.style.transform = `translate(${this.stick.dx}px, ${this.stick.dy}px)`;
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  on(code: string, fn: () => void) {
    this.onPress.set(code, fn);
  }

  /** Move intent in camera space: x = strafe right, y = forward (length 0..1). */
  axis() {
    if (this.stick.id >= 0) {
      const x = this.stick.dx / STICK_RADIUS;
      const y = -this.stick.dy / STICK_RADIUS;
      const len = Math.hypot(x, y);
      if (len < DEADZONE) return { x: 0, y: 0, run: false };
      const k = (len - DEADZONE) / (1 - DEADZONE) / len;
      return { x: x * k, y: y * k, run: len > TROT_AT };
    }
    const x = (this.down("KeyD", "ArrowRight") ? 1 : 0) - (this.down("KeyA", "ArrowLeft") ? 1 : 0);
    const y = (this.down("KeyW", "ArrowUp") ? 1 : 0) - (this.down("KeyS", "ArrowDown") ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len, run: this.down("ShiftLeft", "ShiftRight") };
  }

  consumeDrag() {
    const d = { x: this.dragX, y: this.dragY, zoom: this.zoom };
    this.dragX = this.dragY = this.zoom = 0;
    return d;
  }
}
