import { describe, expect, it } from 'vitest';
import type { Vec2 } from './pathMask';
import { heightAt } from './terrain';
import { buildWall, cutWalls, polylineLength, resample, tidyStroke, type WallData } from './wall';

const line = (n: number, step = 1): Vec2[] => Array.from({ length: n }, (_, i) => [i * step, 0] as Vec2);

describe('polylines', () => {
  it('resamples at an even spacing and keeps both ends', () => {
    const out = resample(line(11), 0.5); // 10 units long
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([10, 0]);
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
      expect(d).toBeCloseTo(0.5, 5);
    }
  });

  it('tidyStroke smooths a zig-zag without changing its rough length much', () => {
    const zig: Vec2[] = Array.from({ length: 20 }, (_, i) => [i * 0.5, i % 2 ? 0.3 : -0.3] as Vec2);
    const tidy = tidyStroke(zig);
    expect(polylineLength(tidy)).toBeLessThan(polylineLength(zig));
    expect(polylineLength(tidy)).toBeGreaterThan(8);
  });
});

describe('cutWalls', () => {
  let id = 100;
  const nextId = () => id++;
  const wall: WallData = { id: 1, pts: resample(line(11), 0.3), courses: 7, seed: 9 };

  it('returns null when the eraser misses', () => {
    expect(cutWalls([wall], 5, 20, 1, nextId)).toBeNull();
  });

  it('splits a wall in two when erased in the middle', () => {
    const out = cutWalls([wall], 5, 0, 1, nextId)!;
    expect(out).toHaveLength(2);
    expect(out.every((w) => w.courses === 7)).toBe(true);
    expect(Math.max(...out[0].pts.map((p) => p[0]))).toBeLessThan(4.1);
    expect(Math.min(...out[1].pts.map((p) => p[0]))).toBeGreaterThan(5.9);
  });

  it('drops leftover stubs that are too short to be a wall', () => {
    const out = cutWalls([wall], 0.5, 0, 1, nextId)!;
    expect(out).toHaveLength(1);
    expect(out[0].pts[0][0]).toBeGreaterThan(1.4);
  });
});

describe('buildWall', () => {
  const data: WallData = { id: 1, pts: resample(line(9), 0.3), courses: 7, seed: 1234 };

  it('lays roughly the right number of bricks', () => {
    const mesh = buildWall(data, null)!;
    // 8 units of wall, ~0.62 per brick, 7-8 courses, minus crenel gaps.
    expect(mesh.count).toBeGreaterThan(70);
    expect(mesh.count).toBeLessThan(130);
  });

  it('is deterministic for a seed', () => {
    expect(buildWall(data, null)!.count).toBe(buildWall(data, null)!.count);
  });

  it('opens an arch where a path crosses', () => {
    const path = { sample: (x: number) => (Math.abs(x - 4) < 0.7 ? 1 : 0) };
    const arched = buildWall(data, path)!;
    const m = arched.instanceMatrix.array;
    // No brick may sit low in the middle of the opening (translation is elements 12..14).
    let lowBricksInOpening = 0;
    for (let i = 0; i < arched.count; i++) {
      const x = m[i * 16 + 12];
      const y = m[i * 16 + 13];
      if (Math.abs(x - 4) < 0.35 && y - heightAt(x, 0) < 0.6) lowBricksInOpening++;
    }
    expect(lowBricksInOpening).toBe(0);
    // Sanity check: without the path, that same spot is filled.
    const plain = buildWall(data, null)!;
    const p = plain.instanceMatrix.array;
    let low = 0;
    for (let i = 0; i < plain.count; i++) {
      if (Math.abs(p[i * 16 + 12] - 4) < 0.35 && p[i * 16 + 13] - heightAt(p[i * 16 + 12], 0) < 0.6) low++;
    }
    expect(low).toBeGreaterThan(0);
  });

  it('refuses a degenerate stroke', () => {
    expect(buildWall({ ...data, pts: [[0, 0]] }, null)).toBeNull();
  });
});
