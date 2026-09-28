// Keyboard + mouse/touch state. Kept deliberately small.

export class Input {
  private keys = new Set<string>();
  /** Accumulated pointer drag since last read (pixels). */
  dragX = 0;
  dragY = 0;
  zoom = 0;
  dragging = false;
  lastDragTime = -Infinity;
  private onPress = new Map<string, () => void>();

  constructor(target: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.onPress.get(e.code)?.();
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());

    target.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.dragX += e.movementX;
      this.dragY += e.movementY;
      this.lastDragTime = performance.now();
    });
    const end = () => (this.dragging = false);
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
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  on(code: string, fn: () => void) {
    this.onPress.set(code, fn);
  }

  /** Move intent in camera space: x = strafe right, y = forward. */
  axis() {
    const x = (this.down("KeyD", "ArrowRight") ? 1 : 0) - (this.down("KeyA", "ArrowLeft") ? 1 : 0);
    const y = (this.down("KeyW", "ArrowUp") ? 1 : 0) - (this.down("KeyS", "ArrowDown") ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  consumeDrag() {
    const d = { x: this.dragX, y: this.dragY, zoom: this.zoom };
    this.dragX = this.dragY = this.zoom = 0;
    return d;
  }
}
