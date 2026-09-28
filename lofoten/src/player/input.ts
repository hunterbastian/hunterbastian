// Keyboard + pointer-lock mouse look. Click to enter, Escape to release.

import { MoveInput, Player } from './player';

const SENSITIVITY = 0.0021;
const PITCH_LIMIT = 1.45;

export class InputController {
  private keys = new Set<string>();
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};
  onLockError: () => void = () => {};

  constructor(
    private target: HTMLElement,
    private player: Player,
  ) {
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', () => this.onLockError());
    window.addEventListener('blur', () => this.keys.clear());
  }

  requestLock() {
    const req = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
    // Newer browsers return a promise that rejects if re-locked too quickly after Esc.
    if (req && typeof req.catch === 'function') req.catch(() => this.onLockError());
  }

  private onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) this.keys.clear();
    this.onLockChange(this.locked);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    this.keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    // Ignore the occasional huge jump some browsers report right after locking.
    if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
    this.player.yaw -= e.movementX * SENSITIVITY;
    this.player.pitch -= e.movementY * SENSITIVITY;
    this.player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.player.pitch));
  };

  get move(): MoveInput {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    return { forward: f, strafe: s, run: k.has('ShiftLeft') || k.has('ShiftRight') };
  }
}
