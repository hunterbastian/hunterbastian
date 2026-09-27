import * as THREE from 'three';
import { MASK_RES, WORLD_SIZE } from './config';

export type Vec2 = [number, number];

export interface Stroke {
  mode: 'paint' | 'erase';
  radius: number;
  pts: Vec2[];
}

/**
 * The dirt-path layer: a greyscale canvas in world space (white = path).
 * Uploaded as a texture that both the terrain and grass shaders sample.
 */
export class PathMask {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private data: Uint8ClampedArray | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = MASK_RES;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.clear();
  }

  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, MASK_RES, MASK_RES);
    this.touch();
  }

  private toPx(v: number): number {
    return (v / WORLD_SIZE + 0.5) * MASK_RES;
  }

  private stamp(x: number, z: number, radius: number, mode: Stroke['mode']): void {
    const px = this.toPx(x);
    const py = this.toPx(z);
    const r = (radius / WORLD_SIZE) * MASK_RES;
    const g = this.ctx.createRadialGradient(px, py, 0, px, py, r);
    const c = mode === 'paint' ? '255,255,255' : '0,0,0';
    const a = mode === 'paint' ? 0.5 : 0.7;
    g.addColorStop(0, `rgba(${c},${a})`);
    g.addColorStop(0.55, `rgba(${c},${a * 0.6})`);
    g.addColorStop(1, `rgba(${c},0)`);
    this.ctx.fillStyle = g;
    this.ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }

  /** Paint the segment from a to b (inclusive of b). */
  segment(a: Vec2 | null, b: Vec2, radius: number, mode: Stroke['mode']): void {
    if (!a) {
      this.stamp(b[0], b[1], radius, mode);
    } else {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const spacing = radius * 0.22;
      const n = Math.max(1, Math.ceil(len / spacing));
      for (let i = 1; i <= n; i++) {
        this.stamp(a[0] + (dx * i) / n, a[1] + (dz * i) / n, radius, mode);
      }
    }
    this.touch();
  }

  drawStroke(s: Stroke): void {
    let prev: Vec2 | null = null;
    for (const p of s.pts) {
      this.segment(prev, p, s.radius, s.mode);
      prev = p;
    }
  }

  redraw(strokes: Stroke[]): void {
    this.clear();
    for (const s of strokes) this.drawStroke(s);
  }

  private touch(): void {
    this.texture.needsUpdate = true;
    this.data = null;
  }

  /** Path amount (0..1) at a world position. */
  sample(x: number, z: number): number {
    if (!this.data) this.data = this.ctx.getImageData(0, 0, MASK_RES, MASK_RES).data;
    const px = Math.floor(this.toPx(x));
    const py = Math.floor(this.toPx(z));
    if (px < 0 || py < 0 || px >= MASK_RES || py >= MASK_RES) return 0;
    return this.data[(py * MASK_RES + px) * 4] / 255;
  }
}
