import { describe, expect, it } from 'vitest';
import { History, demoWorld, emptyWorld } from './world';

describe('History', () => {
  it('undoes and redoes snapshots', () => {
    const h = new History();
    const a = emptyWorld();
    const b = demoWorld();
    h.push(a);
    expect(h.canUndo).toBe(true);
    const undone = h.undo(b)!;
    expect(undone.walls).toHaveLength(0);
    expect(h.canRedo).toBe(true);
    const redone = h.redo(undone)!;
    expect(redone.walls).toHaveLength(b.walls.length);
  });

  it('clears the redo stack on a new change', () => {
    const h = new History();
    h.push(emptyWorld());
    h.undo(demoWorld());
    h.push(emptyWorld());
    expect(h.canRedo).toBe(false);
  });

  it('returns null with nothing to undo', () => {
    expect(new History().undo(emptyWorld())).toBeNull();
  });
});
