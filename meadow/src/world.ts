import type { Stroke } from './pathMask';
import type { WallData } from './wall';

export interface WorldState {
  walls: WallData[];
  strokes: Stroke[];
  nextId: number;
}

const STORAGE_KEY = 'meadow:world:v1';

export const emptyWorld = (): WorldState => ({ walls: [], strokes: [], nextId: 1 });

/** A little starter scene: a curved wall with a path running through an arch. */
export function demoWorld(): WorldState {
  const path: Stroke['pts'] = [];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    path.push([0.8 + Math.sin(t * 3.1) * 1.4 - t * 1.5, 11 - t * 17]);
  }
  const branch: Stroke['pts'] = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    branch.push([0.2 - t * 5.5, 4 - t * 1.5 - Math.sin(t * 2.5) * 0.8]);
  }
  const wall: [number, number][] = [];
  for (let a = 200; a <= 342; a += 3) {
    const r = (a * Math.PI) / 180;
    wall.push([Math.cos(r) * 6.6 + 0.2, Math.sin(r) * 5.2 + 3.6]);
  }
  return {
    walls: [{ id: 1, pts: wall, courses: 7, seed: 4242 }],
    strokes: [
      { mode: 'paint', radius: 0.85, pts: path },
      { mode: 'paint', radius: 0.7, pts: branch },
    ],
    nextId: 2,
  };
}

export function loadWorld(): WorldState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as WorldState;
    if (!Array.isArray(w.walls) || !Array.isArray(w.strokes)) return null;
    return w;
  } catch {
    return null;
  }
}

export function saveWorld(w: WorldState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  } catch {
    /* storage full or blocked — the game still works, it just won't persist */
  }
}

/** Snapshot-based undo/redo. States are small (polylines), so JSON copies are fine. */
export class History {
  private past: string[] = [];
  private future: string[] = [];

  push(state: WorldState): void {
    this.past.push(JSON.stringify(state));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }

  undo(current: WorldState): WorldState | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(prev);
  }

  redo(current: WorldState): WorldState | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
