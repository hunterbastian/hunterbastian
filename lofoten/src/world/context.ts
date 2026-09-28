import { GeoBatch } from '../render/batch';

export interface GlowSpec {
  x: number;
  y: number;
  z: number;
  /** World-space diameter of the glow halo. */
  size: number;
  color: string;
  /** 0..1 flicker amount. */
  flicker?: number;
}

export interface LightSpec {
  x: number;
  y: number;
  z: number;
  color: string;
  intensity: number;
  distance: number;
}

/** Shared sink that world builders append geometry, glows and lights to. */
export interface BuildContext {
  batch: GeoBatch;
  glows: GlowSpec[];
  lights: LightSpec[];
}
