import { describe, expect, it } from 'vitest';
import { fbm, noise2, rng } from './noise';

describe('noise', () => {
  it('is deterministic and stays in [0, 1]', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37 - 20;
      const y = i * 0.91 + 3;
      const a = noise2(x, y, 5);
      expect(a).toBe(noise2(x, y, 5));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      const f = fbm(x, y, 4);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('rng repeats for the same seed and differs across seeds', () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
  });
});
