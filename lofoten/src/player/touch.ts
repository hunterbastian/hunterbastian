// Touch controls for phones and tablets (iOS Safari has no pointer lock):
// a floating joystick under the left thumb to walk, drag anywhere on the
// right to look. Pushing the stick to its rim takes a longer stride.

import { MoveInput, Player } from './player';

const STICK_RADIUS = 56; // CSS px
const LOOK_SENSITIVITY = 0.0052; // rad per CSS px
const PITCH_LIMIT = 1.45;
const DEAD_ZONE = 0.12;

export class TouchControls {
  active = false;
  private stickId: number | null = null;
  private lookId: number | null = null;
  private origin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private lastLook = { x: 0, y: 0 };
  private base: HTMLElement;
  private knob: HTMLElement;

  constructor(
    private surface: HTMLElement,
    private player: Player,
  ) {
    this.base = document.getElementById('stick')!;
    this.knob = this.base.querySelector<HTMLElement>('.knob')!;
    surface.addEventListener('pointerdown', this.onDown);
    surface.addEventListener('pointermove', this.onMove);
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onUp);
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.release();
  }

  private release() {
    this.stickId = null;
    this.lookId = null;
    this.stick.x = this.stick.y = 0;
    this.base.classList.remove('is-visible');
  }

  private onDown = (e: PointerEvent) => {
    if (!this.active || e.pointerType !== 'touch') return;
    e.preventDefault();
    const leftSide = e.clientX < window.innerWidth * 0.45;
    if (leftSide && this.stickId === null) {
      this.stickId = e.pointerId;
      this.origin = { x: e.clientX, y: e.clientY };
      this.stick.x = this.stick.y = 0;
      this.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knob.style.transform = 'translate(0px, 0px)';
      this.base.classList.add('is-visible');
    } else if (!leftSide && this.lookId === null) {
      this.lookId = e.pointerId;
      this.lastLook = { x: e.clientX, y: e.clientY };
    } else {
      return;
    }
    this.surface.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.origin.x;
      let dy = e.clientY - this.origin.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx = (dx / len) * STICK_RADIUS;
        dy = (dy / len) * STICK_RADIUS;
      }
      this.stick.x = dx / STICK_RADIUS;
      this.stick.y = dy / STICK_RADIUS;
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lastLook.x;
      const dy = e.clientY - this.lastLook.y;
      this.lastLook = { x: e.clientX, y: e.clientY };
      this.player.yaw -= dx * LOOK_SENSITIVITY;
      this.player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.player.pitch - dy * LOOK_SENSITIVITY));
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stick.x = this.stick.y = 0;
      this.base.classList.remove('is-visible');
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  };

  get move(): MoveInput {
    const mag = Math.hypot(this.stick.x, this.stick.y);
    if (!this.active || mag < DEAD_ZONE) return { forward: 0, strafe: 0, run: false };
    // Rescale past the dead zone so small pushes still creep forward smoothly.
    const k = (mag - DEAD_ZONE) / (1 - DEAD_ZONE) / mag;
    return { forward: -this.stick.y * k, strafe: this.stick.x * k, run: mag > 0.92 };
  }
}
