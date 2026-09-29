// Keyboard, mouse and touch. On touch screens the left thumb drives a
// floating joystick (push it all the way to trot), the right thumb looks
// around, and two fingers pinch to zoom.

type Role = "stick" | "look";
type Pointer = { role: Role; x: number; y: number; touch: boolean; downAt: number; travel: number };

const STICK_RADIUS = 60;
const DEADZONE = 0.12;
// Trot kicks in near the rim and holds until you ease off, so it doesn't flicker.
const TROT_ON = 0.9;
const TROT_OFF = 0.72;
// Thumbs cover less distance than a mouse, so touch look is a bit livelier.
const TOUCH_LOOK_GAIN = 1.5;
const DOUBLE_TAP_MS = 320;

export class Input {
  private keys = new Set<string>();
  private pointers = new Map<number, Pointer>();
  private onPress = new Map<string, () => void>();
  private stick = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
  private pinchDist = 0;
  private trotting = false;
  private lastTapAt = -Infinity;
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
      this.pointers.set(e.pointerId, { role, x: at.x, y: at.y, touch, downAt: performance.now(), travel: 0 });
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
      p.travel += Math.hypot(mx, my);
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
        const gain = p.touch ? TOUCH_LOOK_GAIN : 1;
        this.dragX += mx * gain;
        this.dragY += my * gain;
      }
      this.lastDragTime = performance.now();
    });

    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p?.role === "stick") this.releaseStick();
      this.pinchDist = this.lookPinchDistance();
      // Double-tap the look side of the screen to swing the camera back behind.
      if (p?.role === "look" && p.touch && p.travel < 12 && performance.now() - p.downAt < 250) {
        const now = performance.now();
        if (now - this.lastTapAt < DOUBLE_TAP_MS) {
          this.onPress.get("DoubleTap")?.();
          this.lastTapAt = -Infinity;
        } else this.lastTapAt = now;
      }
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
    this.stickEl.classList.toggle("trot", active && this.trotting);
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
      const trot = len > (this.trotting ? TROT_OFF : TROT_ON);
      if (trot !== this.trotting) {
        this.trotting = trot;
        this.drawStick(true);
      }
      if (len < DEADZONE) return { x: 0, y: 0, run: false };
      const k = (len - DEADZONE) / (1 - DEADZONE) / len;
      return { x: x * k, y: y * k, run: trot };
    }
    this.trotting = false;
    const x = (this.down("KeyD", "ArrowRight") ? 1 : 0) - (this.down("KeyA", "ArrowLeft") ? 1 : 0);
    const y = (this.down("KeyW", "ArrowUp") ? 1 : 0) - (this.down("KeyS", "ArrowDown") ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len, run: this.down("ShiftLeft", "ShiftRight") };
  }

  /** Keyboard camera turn: Q swings the view left, E right. */
  lookTurn() {
    return (this.down("KeyE") ? 1 : 0) - (this.down("KeyQ") ? 1 : 0);
  }

  consumeDrag() {
    const d = { x: this.dragX, y: this.dragY, zoom: this.zoom };
    this.dragX = this.dragY = this.zoom = 0;
    return d;
  }
}
